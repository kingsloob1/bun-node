/**
 * `gatewayAsyncApi(app)` — the AsyncAPI 3.0 document of a Nest app's
 * gateways, discovered from their metadata (`DiscoveryService` +
 * `MetadataScanner`, no route table), asserted end to end.
 *
 * ```bash
 * bun 09-asyncapi/gateway-docs.ts
 * ```
 *
 * The wire format is fixed by `BunWebSocketAdapter`'s `MessageEventTypes`, so
 * every documented payload is the socket.io-shaped **envelope**: an inbound
 * event is `{ type: 2, namespace, id?, data: [event, <payload>] }` with the
 * handler's `@ValidateMessage` schema at `data[1]` (an undecorated handler
 * documents `{}` there), its declared `ack` is the operation's `reply` (an
 * ACK packet, `type: 3`), and the gateway's `@Emits` map is the send
 * operation's events. The `CONNECT`/`DISCONNECT`/`ERROR` frames and the
 * `["exception", …]` event a thrown `WsException` becomes are fixed on every
 * channel. A wildcard gateway route (`/*`) is unmappable and warns.
 *
 * Where `@nestjs/websockets` or zod is absent (both resolve from the repo's
 * root `node_modules` here) this example prints a line starting `skipped:`
 * and exits 0. Decorator metadata comes from the working directory's
 * `tsconfig.json` (oven-sh/bun#28605): run this from `examples/bun-nest`.
 */
import process from "node:process";
import { check, checkEqual, summary } from "../shared/check";
import "reflect-metadata";

/** Where the peers are absent, skip visibly rather than fail. */
const INSTALLED = (() => {
  try {
    Bun.resolveSync("@nestjs/websockets", import.meta.dir);
    Bun.resolveSync("zod", import.meta.dir);
    return true;
  } catch {
    return false;
  }
})();

if (!INSTALLED) {
  console.log(
    "skipped: @nestjs/websockets or zod is not installed (both resolve from the repo's root node_modules)",
  );
  process.exit(0);
}

const { BunHttpAdapter, Emits, ValidateMessage, gatewayAsyncApi } =
  await import("@kingsleyweb/bun-nest");
const { Module } = await import("@nestjs/common");
const { NestFactory } = await import("@nestjs/core");
const { MessageBody, SubscribeMessage, WebSocketGateway } =
  await import("@nestjs/websockets");
const { z } = await import("zod");
const { docsRouter } = await import("@kingsleyweb/bun-common/lib/docs");

const Say = z.object({ text: z.string().min(1) });
const Said = z.object({ by: z.string(), text: z.string() });
const SayAck = z.object({ ok: z.boolean() });

@WebSocketGateway({ path: "/ws", namespace: "/chat" })
@Emits({ said: Said, typing: null })
class ChatGateway {
  @SubscribeMessage("say")
  @ValidateMessage(Say, { ack: SayAck })
  say(@MessageBody() msg: { text: string }) {
    return { ok: msg.text.length > 0 };
  }

  /** Undecorated: its payload documents `{}` (there is nothing to say). */
  @SubscribeMessage("ping")
  ping() {
    return null;
  }
}

@Module({ providers: [ChatGateway] })
class AppModule {}

const adapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, adapter, { logger: false });
app.useWebSocketAdapter(adapter.webSocketAdapter);

const { document, warnings } = gatewayAsyncApi(app, {
  title: "Gateway docs",
  version: "1.0.0",
});

/* eslint-disable @typescript-eslint/no-explicit-any */
type Doc = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

const channels = document.channels as Doc;
checkEqual(
  "the gateway is one channel, addressed by path + namespace",
  channels.wsChat.address,
  "/ws/chat",
);
const messages = (document.components as Doc).messages as Doc;
checkEqual(
  "the payload is the EVENT envelope, the @ValidateMessage schema at data[1]",
  [
    messages["wsChat.in.say"].payload.properties.type.const,
    messages["wsChat.in.say"].payload.properties.data.items[1].properties.text
      .minLength,
  ],
  [2, 1],
);
checkEqual(
  "an undecorated handler documents {} (the control)",
  messages["wsChat.in.ping"].payload.properties.data.items[1],
  {},
);
checkEqual(
  "the declared ack is the reply's ACK packet (type 3)",
  messages["wsChat.in.say.ack"].payload.properties.type.const,
  3,
);
check(
  "the @Emits map and the fixed frames are the send operation",
  (document.operations as Doc).sendWsChat.messages
    .map((m: Doc) => m.$ref)
    .includes("#/channels/wsChat/messages/exception"),
);
checkEqual("nothing degraded to a warning", warnings, []);

/* The document served through bun-common's docsRouter, on the same adapter. */
adapter.use(
  "/docs",
  docsRouter({
    asyncapi: () =>
      gatewayAsyncApi(app, { title: "Gateway docs", version: "1.0.0" })
        .document,
    viewer: { asyncapi: "asyncapi" },
    authorize: (_req, _res, next) => next(),
  }),
);
const served = await adapter.fetch("/docs/asyncapi.json");
checkEqual("the AsyncAPI JSON is served", served.status, 200);
checkEqual(
  "…as AsyncAPI 3.0.0",
  ((await served.json()) as { asyncapi: string }).asyncapi,
  "3.0.0",
);
checkEqual(
  "the viewer page is served",
  (await adapter.fetch("/docs/asyncapi")).status,
  200,
);

await app.close();
summary();
