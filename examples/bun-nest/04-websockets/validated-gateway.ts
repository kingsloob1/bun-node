/**
 * A validated gateway — `@ValidateMessage` checks the incoming payload (and
 * the handler's ack), `@Emits` declares and checks the events the server
 * sends, and `TypedSocket` types the client's `emit`. Each behaviour is
 * asserted.
 *
 * ```bash
 * bun 04-websockets/validated-gateway.ts
 * ```
 *
 * - **`@ValidateMessage(Say, { ack: SayAck })`** on a `@SubscribeMessage`
 *   handler: a bad payload throws a `StandardValidationException` (400,
 *   value-free issues), which the gateway's `ValidationExceptionFilter`
 *   emits as an `exception` event (`{ status, code: "VALIDATION", issues }`)
 *   — the same frame shape bun-common's channels answer with. The parsed
 *   payload is written back, so `@MessageBody()` sees the schema's output
 *   (a coercion arrives coerced). Each value the handler returns is checked
 *   against the ack — a `{ event, data }` (`WsResponse`) is an event, not an
 *   ack, and passes through.
 * - **`@Emits({ said: Said, typing: null })`** on the gateway class: a
 *   declared event's payload is checked under `"error"` before it is
 *   written — a mismatch throws to the caller and nothing is sent — while an
 *   undeclared event passes unchecked, and a `null` entry takes no payload.
 * - **`TypedSocket<typeof chatEmits>`** types `@ConnectedSocket()` from the
 *   same `as const` map, so a wrong `emit` fails at compile time too.
 *
 * Do not combine `@ValidateMessage` with a payload pipe on one handler: the
 * interceptor checks first and writes the parsed value back, so the pipe
 * would run the schema a second time on the output.
 *
 * (`reflect-metadata` is imported last because the import sorter puts
 * side-effect imports there; it still loads before any decorator runs.)
 */
import type { OnGatewayConnection } from "@nestjs/websockets";
import type { TypedSocket } from "@kingsleyweb/bun-nest";
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
  MessageEventTypes,
  ValidateMessage,
  ValidationExceptionFilter,
} from "@kingsleyweb/bun-nest";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { connect, eventPayload } from "./fixtures/ws-client";
import type { WirePacket } from "./fixtures/ws-client";
import "reflect-metadata";

/* ------------------------------------------------------------------ *
 * The declaration, shared by the runtime and the types
 * ------------------------------------------------------------------ */

/** A chat line as clients send it: `at` arrives as a string, parses to a `Date`. */
const Say = z.object({
  text: z.string().min(1).max(200),
  at: z.coerce.date(),
});

/** The `say` handler's acknowledgement. */
const SayAck = z.object({ saved: z.literal(true), at: z.string() });

/** What the server sends. One `as const` map feeds `@Emits` and `TypedSocket`. */
const chatEmits = {
  said: z.object({ from: z.string(), text: z.string() }),
  typing: null, // no payload
} as const;

/* ------------------------------------------------------------------ *
 * The gateway
 * ------------------------------------------------------------------ */

@WebSocketGateway()
@UseFilters(ValidationExceptionFilter)
@Emits(chatEmits)
class ChatGateway implements OnGatewayConnection {
  /** What `@MessageBody()` received, so the example can show the write-back. */
  readonly seen: unknown[] = [];

  /** Whether the app's own connection hook ran (it composes with `@Emits`). */
  connections = 0;

  handleConnection(): void {
    this.connections++;
  }

  /** A valid line is echoed as `said` and acked; both are checked. */
  @SubscribeMessage("say")
  @ValidateMessage(Say, { ack: SayAck })
  say(
    @MessageBody() msg: z.infer<typeof Say>,
    @ConnectedSocket() socket: TypedSocket<typeof chatEmits>,
  ) {
    this.seen.push(msg);
    socket.emit("said", { from: "ada", text: msg.text });
    return { saved: true as const, at: msg.at.toISOString() };
  }

  /** An ack that fails its schema: refused, and nothing is acked. */
  @SubscribeMessage("broken")
  @ValidateMessage(Say, { ack: SayAck })
  broken(@MessageBody() _msg: z.infer<typeof Say>) {
    return { saved: false } as never; // the type constraint is dodged on purpose
  }

  /** An emit whose payload fails its schema: throws, nothing is written. */
  @SubscribeMessage("oops")
  oops(@ConnectedSocket() socket: TypedSocket<typeof chatEmits>): void {
    (socket.emit as (event: string, data: unknown) => void)("said", {
      wrong: true,
    });
  }

  /** An undeclared event is not the channel's business: sent as is. */
  @SubscribeMessage("announce")
  announce(@ConnectedSocket() socket: TypedSocket<typeof chatEmits>): void {
    (socket.emit as (event: string, data: unknown) => void)(
      "announcement",
      "free-form, unchecked",
    );
  }

  /** A `null` entry takes no payload: `typing` is emitted bare. */
  @SubscribeMessage("type")
  type(@ConnectedSocket() socket: TypedSocket<typeof chatEmits>): void {
    socket.emit("typing");
  }

  /** …and a payload on a `null` entry throws. */
  @SubscribeMessage("type-with-data")
  typeWithData(@ConnectedSocket() socket: TypedSocket<typeof chatEmits>): void {
    (socket.emit as (event: string, data: unknown) => void)("typing", {
      by: "ada",
    });
  }
}

@Module({ providers: [ChatGateway] })
class AppModule {}

title("A validated gateway");

/* ------------------------------------------------------------------ */
step("Boot");

const httpAdapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, httpAdapter, {
  logger: false,
});
app.useWebSocketAdapter(httpAdapter.webSocketAdapter);
await app.listen(0);

const gateway = app.get(ChatGateway);
const base = `ws://127.0.0.1:${httpAdapter.listeningPort}`;
show("listening", base);

/** The `exception` frames a client holds, in order. */
function exceptionsOf(
  client: Awaited<ReturnType<typeof connect>>,
): WirePacket[] {
  return client.packets().filter((packet) => {
    return (
      packet.type === MessageEventTypes.EVENT &&
      Array.isArray(packet.data) &&
      packet.data[0] === "exception"
    );
  });
}

/** How many exception frames have been consumed, per client. */
const exceptionsSeen = new WeakMap<object, number>();

/** The next not-yet-consumed `exception` frame a client receives. */
async function nextException(
  client: Awaited<ReturnType<typeof connect>>,
): Promise<WirePacket> {
  const seen = exceptionsSeen.get(client) ?? 0;
  await waitFor(
    "a new exception frame",
    () => exceptionsOf(client).length > seen,
  );
  exceptionsSeen.set(client, seen + 1);
  return exceptionsOf(client)[seen]!;
}

/** An exception frame's payload. */
function exceptionPayload(packet: WirePacket): {
  status: number;
  code: string;
  issues?: { target: string; path: string; message: string }[];
} {
  return (packet.data as unknown[])[1] as ReturnType<typeof exceptionPayload>;
}

/* ------------------------------------------------------------------ */
step("A valid message: checked, parsed, answered");

const ada = await connect(base);
checkEqual("the app's own handleConnection ran", gateway.connections, 1);

ada.emit("say", { text: "hi room", at: "2026-01-02T03:04:05Z" }, { id: 1 });
const ack = await ada.next("the ack", (packet) => {
  return packet.type === MessageEventTypes.ACK && packet.id === 1;
});
checkEqual("the ack, checked against SayAck", ack.data, [
  { saved: true, at: "2026-01-02T03:04:05.000Z" },
]);

const seen = gateway.seen[0] as { at: unknown };
check(
  "@MessageBody saw the parsed Date (the write-back)",
  seen.at instanceof Date,
);

/* ------------------------------------------------------------------ */
step("An invalid payload: an exception frame, the handler never ran");

ada.emit(
  "say",
  { text: "", at: "2026-01-02", leak: "Hunter2-Gateway-Secret" },
  { id: 2 },
);
const refusal = exceptionPayload(await nextException(ada));
checkEqual("the status", refusal.status, 400);
checkEqual("the code", refusal.code, "VALIDATION");
check("issues are listed", (refusal.issues?.length ?? 0) > 0);
check("the handler never ran", gateway.seen.length === 1);
check(
  "the frame is value-free",
  !JSON.stringify(ada.frames).includes("Hunter2-Gateway-Secret"),
);
check(
  "no ack for it",
  !ada
    .packets()
    .some((packet) => packet.type === MessageEventTypes.ACK && packet.id === 2),
);

/* ------------------------------------------------------------------ */
step("An ack that fails its schema is refused");

ada.emit("broken", { text: "fine", at: "2026-01-02" }, { id: 3 });
const badAck = exceptionPayload(await nextException(ada));
checkEqual("the code", badAck.code, "VALIDATION");
check(
  "no ack packet was sent",
  !ada
    .packets()
    .some((packet) => packet.type === MessageEventTypes.ACK && packet.id === 3),
);

/* ------------------------------------------------------------------ */
step("@Emits: a bad payload throws, nothing is written");

const saidBefore = ada.payloadsOf("said").length;
ada.emit("oops", {});
exceptionPayload(await nextException(ada));
check("no 'said' was written", ada.payloadsOf("said").length === saidBefore);

step("@Emits: undeclared events pass, null entries take no payload");

ada.emit("announce", {});
show(
  "the undeclared event, unchecked",
  eventPayload(await ada.nextEvent("announcement")),
);

ada.emit("type", {});
await ada.nextEvent("typing");

ada.emit("type-with-data", {});
const nullEntry = exceptionPayload(await nextException(ada));
checkEqual(
  "a payload on a null entry",
  nullEntry.issues?.[0]?.message,
  "No data is declared here",
);

/* ------------------------------------------------------------------ */
step("Shutting down");

await ada.close();
await app.close();
show("closed");

summary();
