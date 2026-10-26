/**
 * AsyncAPI channels — `defineChannel()` + `generateAsyncApi()` end to end: a
 * validated channel documents itself (the upgrade's params, the messages in
 * their `{ type, id?, data }` envelope, the reply link, the implicit error
 * frame), its SSE fallback is a channel of its own, and the document is
 * served through `docsRouter`'s `asyncapi` with its viewer page.
 *
 * ```bash
 * bun 13-api-docs/asyncapi-channels.ts
 * ```
 *
 * A channel's meta rides its contract (`describeContract`'s meta carries the
 * `ChannelMeta`, upgrade request included — AD (e)'s widening), so a document
 * needs nothing beside the router: every message payload is the frame
 * envelope with the declared schema at `data`, an inbound message's declared
 * reply is the operation's `reply`, and the meta lands as the
 * `x-bun-common-*` extensions (`-subprotocol`, `-binary`, `-topics`,
 * `-sse-fallback`; a parameter's schema as `-schema`, AsyncAPI 3.0 carrying
 * none).
 */
import {
  BunRouter,
  BunWebSocket,
  defineChannel,
  sse,
  validate,
} from "@kingsleyweb/bun-common";
import type { AsyncApiDocument } from "@kingsleyweb/bun-common/lib/docs";
import { docsRouter, generateAsyncApi } from "@kingsleyweb/bun-common/lib/docs";
import { z } from "zod";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("AsyncAPI channels (generateAsyncApi)");

const app = new BunRouter();
// ws() routes need a BunWebSocket attached (no server is bound here:
// generating a document never opens a port).
const appSocket = new BunWebSocket({
  newInstance: false,
  getServer: () => undefined,
  router: app,
});

/* ------------------------------------------------------------------ */
step("a defineChannel channel documents itself — plus its SSE fallback");

const chat = defineChannel({
  path: "/rooms/:room",
  request: {
    params: z.object({ room: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
  },
  receives: {
    say: z.object({ text: z.string().min(1).max(200) }),
    typing: null, // no data
  },
  sends: {
    said: z.object({ by: z.string(), text: z.string() }),
  },
  replies: { say: "said" }, // a request/response pair, documented as operation.reply
  subprotocol: "chat.v1",
  topics: ["rooms"],
  // The same messages, as a plain GET stream for clients that cannot hold a
  // socket open — cross-referenced from the channel (x-bun-common-sse-fallback).
  fallback: "/rooms/:room/events",
  meta: { name: "chat", description: "A validated chat room" },
});
app.ws(chat.path, chat.checks(), chat.handler({}), chat.options());
checkEqual(
  "the socket's wsRoutes() lists the channel (the read-only listing)",
  appSocket.wsRoutes().map((route) => route.path),
  ["/rooms/:room"],
);

// The SSE fallback endpoint: one channel in the document, its events as
// messages (no frame envelope — each data: line is one event's data).
app.get(
  "/rooms/:room/events",
  validate(
    { params: z.object({ room: z.string().regex(/^[a-z][a-z0-9-]*$/) }) },
    {
      responses: {
        200: {
          content: {
            "text/event-stream": sse({ said: z.object({ by: z.string() }) }),
          },
        },
      },
    },
  ),
  (_req, res) => res.send(new ReadableStream()),
);

const { document, warnings } = generateAsyncApi(app, {
  title: "AsyncAPI channels",
  version: "1.0.0",
});
checkEqual("nothing degraded to a warning", warnings, []);

const channels = document.channels as Record<string, any>;
checkEqual(
  "the channel and its SSE fallback are the document's two channels",
  Object.keys(channels).sort(),
  ["chat", "roomsByRoomEvents"],
);
checkEqual("the channel's address", channels.chat.address, "/rooms/{room}");
check(
  "the room parameter carries its checked schema (x-bun-common-schema)",
  channels.chat.parameters.room["x-bun-common-schema"].pattern ===
    "^[a-z][a-z0-9-]*$",
);
checkEqual(
  "the meta landed as the approved extensions",
  [
    channels.chat["x-bun-common-subprotocol"],
    channels.chat["x-bun-common-sse-fallback"],
    JSON.stringify(channels.chat["x-bun-common-topics"]),
  ],
  ["chat.v1", "/rooms/:room/events", '["rooms"]'],
);

const operations = document.operations as Record<string, any>;
checkEqual(
  "a receive operation per inbound type",
  operations.receiveChatSay.action,
  "receive",
);
checkEqual(
  "…with the declared reply",
  operations.receiveChatSay.reply.messages[0].$ref,
  "#/channels/chat/messages/said",
);
check(
  "the send operation includes the implicit error frame",
  operations.sendChat.messages.some(
    (m: { $ref: string }) => m.$ref === "#/channels/chat/messages/error",
  ),
);

const messages = (document.components as { messages: Record<string, any> })
  .messages;
checkEqual(
  "every payload is the frame envelope, the schema at data",
  [
    messages["chat.say"].payload.properties.type.const,
    messages["chat.say"].payload.required,
  ],
  ["say", ["type", "data"]],
);
check(
  "a `null` message (typing) carries no data",
  !("data" in messages["chat.typing"].payload.properties),
);
checkEqual(
  "the SSE channel is marked",
  channels.roomsByRoomEvents["x-bun-common-sse"],
  true,
);
check(
  "…and its event's data is the payload directly (no envelope)",
  "by" in messages["roomsByRoomEvents.said"].payload.properties,
);

/* ------------------------------------------------------------------ */
step("served through docsRouter's asyncapi, with its viewer page");

app.use(
  "/docs",
  docsRouter({
    asyncapi: (): AsyncApiDocument =>
      generateAsyncApi(app, {
        title: "AsyncAPI channels",
        version: "1.0.0",
      }).document,
    viewer: { asyncapi: "asyncapi" }, // the official component (the default)
    authorize: (_req, _res, next) => next(),
  }),
);

const served = (await (
  await app.fetch("/docs/asyncapi.json")
).json()) as AsyncApiDocument;
checkEqual("the AsyncAPI JSON is served", served.asyncapi, "3.0.0");
check(
  "and it is the live one (the channel is in it)",
  "chat" in ((served.channels as object) ?? {}),
);
const page = await app.fetch("/docs/asyncapi");
checkEqual("the viewer page is served", page.status, 200);
check(
  "…rendering with the official AsyncAPI component",
  (await page.text()).includes("AsyncApiStandalone.render("),
);

/* ------------------------------------------------------------------ */
step("a bare ws() route: the honest stub, then describeChannel()");

const bare = new BunRouter();
// The socket the bare ws() route registers on; a plain adapter.ws() route
// reaches a document only through this listing (wsRoutes()).
const bareSocket = new BunWebSocket({
  newInstance: false,
  getServer: () => undefined,
  router: bare,
});
bare.ws("/raw/:id", { message: () => {} });
check(
  "a bare ws() route reaches a document only through wsRoutes()",
  bareSocket.wsRoutes().some((route) => route.path === "/raw/:id"),
);
const stubbed = generateAsyncApi(bare, { title: "Bare", version: "1.0.0" });
check(
  "an undeclared route documents as a stub, with a warning",
  stubbed.warnings.some((w) => w.message.includes("documents as a stub")),
);
bareSocket.describeChannel("/raw/:id", {
  receives: { ping: { payload: z.object({ t: z.number() }), reply: "pong" } },
  sends: { pong: { payload: z.object({ t: z.number() }) } },
});
const documented = generateAsyncApi(bare, { title: "Bare", version: "1.0.0" });
checkEqual("described, the warning is gone", documented.warnings, []);
checkEqual(
  "…and the reply link is the declared one",
  (documented.document.operations as Record<string, any>).receiveRawByIdPing
    .reply.messages[0].$ref,
  "#/channels/rawById/messages/pong",
);

show(
  "open a real server's /docs/asyncapi to browse the document; the playground serves its chat channel's",
);
summary();
