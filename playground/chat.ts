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
 * > {"type":"say","data":{"text":"hi lobby"}}     # answered {"type":"said",…}
 * > {"type":"say","data":{"text":42}}            # a VALIDATION error frame
 * > {"type":"nope"}                              # UNKNOWN_MESSAGE
 * ```
 *
 * A room name that fails the params schema (`/playground/chat/Lobby`) is
 * answered 400, never 101. The channel is in `/playground/routes` (as
 * `GET /playground/chat/:room` with its `websocket` contract) and skipped by
 * the OpenAPI document, which documents HTTP only — one collected warning
 * per generation, in the response's `warnings` array, never logged.
 */
import type { ServerWebSocket } from "bun";
import type {
  BunHttpAdapter,
  WebSocketClientData,
} from "@kingsleyweb/bun-common";
import { defineChannel } from "@kingsleyweb/bun-common";
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
 * The session of a connection inside a channel handler. Channel handlers are
 * typed for any connection, so `ws.data` is `never` there; the `onUpgrade`
 * hook passed to `options()` is what put a `ChatSession` in it.
 */
function sessionOf(ws: ServerWebSocket<never>): ChatSession {
  return (ws.data as WebSocketClientData<ChatSession>).custom;
}

/** The room of a connection, from the route's params. */
function roomOf(ws: ServerWebSocket<never>): string {
  return String((ws.data as WebSocketClientData<ChatSession>).params?.room);
}

/** The channel, declared once. */
const chat = defineChannel({
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
    chat.handler({
      say(ws, msg) {
        // `msg` is the parsed data: `{ text: string }`, typed and checked.
        const data = { by: sessionOf(ws).name, text: msg.text };
        chat.publish(ws, roomTopic(roomOf(ws)), "said", data); // the others
        chat.send(ws, "said", data); // the speaker's own line back
      },
      typing(ws) {
        chat.publish(ws, roomTopic(roomOf(ws)), "someoneTyping", {
          by: sessionOf(ws).name,
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
}
