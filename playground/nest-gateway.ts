/**
 * The playground's validated Nest gateway (bun-validate V9), as a small entry
 * of its own: the playground itself is not a Nest app, so this boots a
 * minimal one on its own port — one gateway with `@ValidateMessage` (the
 * payload checked, the parsed value written back, the handler's ack checked)
 * and `@Emits` + `TypedSocket` (the events the server sends, declared and
 * checked), with the `ValidationExceptionFilter` emitting a refusal as an
 * `exception` frame.
 *
 * ```bash
 * bun playground/nest-gateway.ts                 # ws://localhost:4001
 * PORT_NEST=4002 bun playground/nest-gateway.ts  # another port
 * ```
 *
 * `index.ts` never imports this: the main playground stays Nest-free.
 *
 * Poke it with any WebSocket client speaking the adapter's packet format
 * (`examples/bun-nest/04-websockets/fixtures/ws-client.ts` has a small one):
 * an event is a text frame `{"type":2,"namespace":"/","data":["<event>",
 * <payload>]}`, with `"id": <n>` to ask for an ack; an ack arrives as
 * `{"type":3,"id":<n>,"data":[<ack>]}`, an event as
 * `{"type":2,"data":["<event>",<payload>]}`, and a validation refusal as an
 * `exception` event (`{"type":2,"data":["exception",{status,code,issues}]}`,
 * the issues value-free).
 *
 * ```bash
 * bun -e 'const ws = new WebSocket("ws://localhost:4001");
 *   ws.onmessage = (e) => console.log(e.data);
 *   ws.onopen = () => {
 *     ws.send(JSON.stringify({ type: 2, namespace: "/", id: 1, data: ["say", { text: "hi" }] }));
 *     ws.send(JSON.stringify({ type: 2, namespace: "/", id: 2, data: ["say", { text: 42 }] }));
 *   };'
 * # ← {"type":2,"namespace":"/","data":["said",{"from":"playground","text":"hi"}]}
 * # ← {"type":3,"namespace":"/","id":1,"data":[{"saved":true,"echoed":"hi"}]}
 * # ← {"type":2,"namespace":"/","data":["exception",{"status":400,"code":"VALIDATION","issues":[…]}]}
 * ```
 */
import type { TypedSocket } from "@kingsleyweb/bun-nest";
import process from "node:process";
import { Module, UseFilters } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { z } from "zod";
import {
  BunHttpAdapter,
  Emits,
  ValidateMessage,
  ValidationExceptionFilter,
} from "@kingsleyweb/bun-nest";
import "reflect-metadata";

/** A chat line as clients send it. */
const Say = z.object({ text: z.string().min(1).max(200) });

/** The `say` handler's acknowledgement. */
const SayAck = z.object({ saved: z.literal(true), echoed: z.string() });

/** What the server sends. One `as const` map feeds `@Emits` and `TypedSocket`. */
const chatEmits = {
  said: z.object({ from: z.string(), text: z.string() }),
  typing: null, // no payload
} as const;

@WebSocketGateway()
@UseFilters(ValidationExceptionFilter)
@Emits(chatEmits)
class ChatGateway {
  /** A valid line is echoed as `said` and acked; both are checked. */
  @SubscribeMessage("say")
  @ValidateMessage(Say, { ack: SayAck })
  say(
    @MessageBody() msg: z.infer<typeof Say>,
    @ConnectedSocket() socket: TypedSocket<typeof chatEmits>,
  ) {
    socket.emit("said", { from: "playground", text: msg.text });
    return { saved: true as const, echoed: msg.text };
  }

  /** A `null` entry takes no payload: `typing` is emitted bare. */
  @SubscribeMessage("typing")
  typing(@ConnectedSocket() socket: TypedSocket<typeof chatEmits>): void {
    socket.emit("typing");
  }
}

@Module({ providers: [ChatGateway] })
class AppModule {}

// Only when run directly: nothing imports this file, and the main playground
// (`index.ts`) stays Nest-free.
if (import.meta.main) {
  /** The port to listen on (`PORT_NEST`, default 4001 — the main playground's 4000, plus one). */
  const port = Number(process.env.PORT_NEST ?? 4001);

  const httpAdapter = new BunHttpAdapter();
  const app = await NestFactory.create(AppModule, httpAdapter, {
    logger: false,
  });
  app.useWebSocketAdapter(httpAdapter.webSocketAdapter);
  await app.listen(port, "127.0.0.1");

  console.log(`
bun-node playground: the validated gateway (bun-validate V9)

  Gateway  ws://localhost:${httpAdapter.listeningPort}  (the adapter's packet format — see this file's header)

  Ctrl+C to stop.
`);

  let stopping = false;
  async function shutdown(): Promise<void> {
    if (stopping) {
      return;
    }
    stopping = true;
    await app.close();
    process.exit(0);
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void shutdown());
  }
}
