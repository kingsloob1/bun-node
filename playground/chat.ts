/**
 * The playground's validated WebSocket channel (bun-validate V8): one
 * `defineChannel` declaration gives the upgrade's request check (the room
 * name, from the path), every incoming frame's validation, typed and checked
 * `send`/`publish`, and the error frames a bad message is answered with.
 * Mounted on the main adapter with a single `ws()` call:
 * `app.ws(chat.path, chat.checks(), chat.handler(…), chat.options(…))`.
 *
 * Poke it while the playground runs:
 *
 * ```bash
 * bunx wscat -c 'ws://localhost:4000/playground/chat/lobby?name=ada'
 * > {"type":"say","id":"m-1","data":{"text":"hi lobby"}}   # the reply: {"type":"said","id":"m-1",…}
 * > {"type":"say","data":{"text":42}}            # a VALIDATION error frame
 * > {"type":"nope"}                              # UNKNOWN_MESSAGE
 * # and from a route, with no socket (server-level publish, typed-client PR-W1):
 * curl -X POST 'http://localhost:4000/playground/chat/lobby/announce?text=hello'
 * ```
 *
 * A room name that fails the params schema (`/playground/chat/Lobby`) is
 * answered 400, never 101. The channel is in `/playground/routes` (as
 * `GET /playground/chat/:room` with its `websocket` contract), in the
 * playground's **AsyncAPI** document (`/playground/docs/asyncapi.json` — AD
 * (e)'s `generateAsyncApi` reads it from the contract: the upgrade's params,
 * the envelope payloads, the `say`→`said` reply, the implicit error frame),
 * and skipped by the OpenAPI document, which documents HTTP only — one
 * collected warning per OpenAPI generation, in the response's `warnings`
 * array, never logged.
 */
import type { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { defineChannel } from "@kingsleyweb/bun-common";
import { channelContract } from "@kingsleyweb/bun-common/contract";
import { z } from "zod";

/** What each connection carries in `ws.data.custom` (the `onUpgrade` hook sets it). */
interface ChatSession {
  /** Who connected, from the `?name=` query parameter. */
  name: string;
}

/** The room topic a connection subscribes to. */
function roomTopic(room: string): string {
  return `playground-chat:${room}`;
}

/**
 * The channel's contract, declared once: the browser-safe half a client
 * imports too (the typed-client section's `channel` scenario opens it with
 * bun-client's `channel()`, typed by this declaration).
 */
export const chatContract = channelContract({
  path: "/playground/chat/:room",
  request: {
    // The upgrade's request side: the room name, from the path.
    params: z.object({ room: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
  },
  receives: {
    say: z.object({ text: z.string().min(1).max(200) }),
    typing: null, // no data
  },
  sends: {
    said: z.object({ by: z.string(), text: z.string() }),
    someoneTyping: z.object({ by: z.string() }),
    // No `error` declared: the implicit error frame joins by itself.
  },
  replies: { say: "said" },
  meta: { name: "playground-chat", description: "A validated chat room" },
});

/** The server binding over the shared contract (`defineChannel(contract)`). */
const chat = defineChannel(chatContract);

/** Mounts the channel on the playground's adapter, the one-call way. */
export function mountChatChannel(app: BunHttpAdapter): void {
  // Subscribe each connection to its room's topic, so `publish` reaches the
  // room. This listener hears every path; `ws.data.route` is the matched
  // pattern.
  app.webSocketAdapter.on("open", (ws) => {
    if (ws.data.route === chat.path) {
      ws.subscribe(roomTopic(String(ws.data.params?.room)));
    }
  });

  // The chain runs before the upgrade answers; `checks()` is the upgrade's
  // request side (a 400, never a 101, on a bad room).
  app.ws(
    chat.path,
    chat.checks(),
    // `ws` is typed by the channel: `ws.data.params.room` from the path,
    // `ws.data.custom` as the `onUpgrade` hook below sets it.
    chat.handler<ChatSession>({
      say(ws, msg) {
        // `msg` is the parsed data: `{ text: string }`, typed and checked.
        const data = { by: ws.data.custom.name, text: msg.text };
        void chat.publish(ws, roomTopic(ws.data.params.room), "said", data); // the others
        // The speaker's own line back, as the reply (`replies: { say: "said" }`):
        // it carries the request's id, when the frame had one.
        return data;
      },
      typing(ws) {
        void chat.publish(ws, roomTopic(ws.data.params.room), "someoneTyping", {
          by: ws.data.custom.name,
        });
      },
    }),
    chat.options((req) => {
      // `?name=` arrives as a string (or not at all); anything else is
      // "anonymous".
      const name = req.query.name;
      return {
        custom: {
          name: typeof name === "string" && name !== "" ? name : "anonymous",
        },
      };
    }),
  );

  // A route pushes into a room with no socket of its own: the channel's
  // publish on the server (`req.server`), checked like any send, answering
  // with Bun's send status (`0`: nobody is in the room). A demo, not
  // plumbing: documented, with its response declared.
  app
    .post("/playground/chat/:room/announce", async (req, res) => {
      const text = req.query.text;
      const status =
        req.server === undefined
          ? 0
          : await chat.publish(req.server, roomTopic(req.params.room), "said", {
              by: "the playground",
              text:
                typeof text === "string" && text !== ""
                  ? text
                  : "an announcement",
            });
      res.json({ status });
    })
    .describe({
      summary: "Announce into a chat room, with no socket",
      tags: ["Chat channel"],
      description:
        'Publishes a `said` frame (`?text=`, default "an announcement") to every connection in the room through the chat channel\'s server-level `publish`, checked like any send.',
      responses: {
        200: {
          description:
            "Bun's send status: the bytes sent, `-1` under backpressure, `0` when nobody is in the room",
          schema: {
            type: "object",
            properties: { status: { type: "integer" } },
            required: ["status"],
          },
        },
      },
    });
}
