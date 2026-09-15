/**
 * The wire format: every `MessageEventTypes` packet a client can send, what
 * the adapter does with it, and what comes back — shown with a real
 * `WebSocket` client against a NestJS gateway.
 *
 * ```bash
 * bun 04-websockets/message-formats.ts
 * ```
 *
 * Every frame is JSON text (a binary frame holding the same JSON works too):
 *
 * | type | name           | client sends                                   | adapter does                                                  |
 * |------|----------------|------------------------------------------------|---------------------------------------------------------------|
 * | 0    | `CONNECT`      | `{ type, namespace }`                          | calls `@SubscribeMessage("connect")`                          |
 * | 1    | `DISCONNECT`   | `{ type, namespace }`                          | calls `@SubscribeMessage("disconnect")` — the socket stays open |
 * | 2    | `EVENT`        | `{ type, namespace, data: [event, payload], id? }` | calls `@SubscribeMessage(event)`; `id` enables `@Ack()`   |
 * | 3    | `ACK`          | `{ type, namespace, id, data }`                | echoes the packet back unchanged                              |
 * | 4    | `ERROR`        | `{ type, namespace, data: message }`           | calls `@SubscribeMessage("error")` with the message           |
 * | 5    | `BINARY_EVENT` | `{ type, namespace, data: [event, ...args], binary?, id? }` | decodes each base64 argument `binary` lists (every string, without it) into a `Buffer` |
 * | 6    | `BINARY_ACK`   | `{ type, namespace, id, data }`                | echoes the packet back unchanged                              |
 *
 * Replies are `EVENT` packets, or `BINARY_EVENT` (bytes as base64) when a
 * `WsResponse`'s `data` is a `Buffer`, typed array or `ArrayBuffer` — that is
 * how a handler replies with bytes. `@Ack()` answers with `ACK`, or
 * `BINARY_ACK` when any argument is bytes, whatever type the event had. The
 * adapter answers a frame it cannot parse with an `ERROR` packet. A frame it cannot route — unparseable, an unknown `type`, an `EVENT`
 * whose `data` is not an array — goes to `@SubscribeMessage("events")` as the
 * raw text.
 *
 * The `namespace` field is echoed back but does not route: a connection's
 * namespace is its URL path.
 *
 * Exceptions: the adapter gives every client an `emit(event, ...args)`, which
 * NestJS's default WebSocket exception handler calls, so a thrown
 * `WsException` reaches the client as an `exception` event — shown at the end.
 */
import type { JsonValue } from "@kingsleyweb/bun-common";
import type {
  MessageAckType,
  MessageBinaryAckType,
  MessageBinaryEventType,
  MessageConnectType,
  MessageDisConnectType,
  MessageErrorType,
  MessageEventType,
  WsAckFunction,
} from "@kingsleyweb/bun-nest";
import type { WsResponse } from "@nestjs/websockets";
import type { WirePacket } from "./fixtures/ws-client";
import { Buffer } from "node:buffer";
import { BunHttpAdapter, MessageEventTypes } from "@kingsleyweb/bun-nest";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  Ack,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from "@nestjs/websockets";
import { show, step, title, waitFor } from "../shared/console";
import { connect, eventName } from "./fixtures/ws-client";
import "reflect-metadata";

/** What the `upload` handler reports about the bytes it received. */
interface UploadReport {
  /** Whether the payload arrived as a `Buffer`. */
  isBuffer: boolean;
  /** Its length in bytes. */
  bytes: number;
  /** The bytes decoded as UTF-8. */
  text: string;
}

@WebSocketGateway()
class ProtocolGateway {
  /** How many `CONNECT` packets reached the `connect` handler. */
  connectPackets = 0;

  /** How many `DISCONNECT` packets reached the `disconnect` handler. */
  disconnectPackets = 0;

  @SubscribeMessage("connect")
  onConnectPacket(): WsResponse<string> {
    this.connectPackets++;
    return { event: "connected", data: "welcome" };
  }

  @SubscribeMessage("disconnect")
  onDisconnectPacket(): WsResponse<string> {
    this.disconnectPackets++;
    return { event: "bye", data: "the socket is still open" };
  }

  /** Receives an `ERROR` packet's text, or the parse error of a malformed frame. */
  @SubscribeMessage("error")
  onError(@MessageBody() error: string | Error): WsResponse<string> {
    return {
      event: "error-seen",
      data: error instanceof Error ? error.message : String(error),
    };
  }

  /** The catch-all: frames that could not be routed, as raw text. */
  @SubscribeMessage("events")
  unrouted(@MessageBody() raw: string | Buffer): WsResponse<string> {
    return { event: "unrouted", data: String(raw) };
  }

  @SubscribeMessage("echo")
  echo(@MessageBody() body: JsonValue): WsResponse<JsonValue> {
    return { event: "echo", data: body };
  }

  @SubscribeMessage("remember")
  remember(
    @MessageBody() item: string,
    @Ack() ack: WsAckFunction<[status: string, item: string]>,
  ): void {
    ack("remembered", item);
  }

  /** A `BINARY_EVENT` payload arrives decoded from base64 into a `Buffer`. */
  @SubscribeMessage("upload")
  upload(@MessageBody() bytes: Buffer): WsResponse<UploadReport> {
    return {
      event: "uploaded",
      data: {
        isBuffer: Buffer.isBuffer(bytes),
        bytes: bytes.length,
        text: bytes.toString("utf8"),
      },
    };
  }

  /** Acks with a number: an `ACK`, even though the event was binary. */
  @SubscribeMessage("store")
  store(
    @MessageBody() bytes: Buffer,
    @Ack() ack: WsAckFunction<[length: number]>,
  ): void {
    ack(bytes.length);
  }

  /** Acks with bytes: a `BINARY_ACK`, each binary argument as base64. */
  @SubscribeMessage("reverse")
  reverse(
    @MessageBody() bytes: Buffer,
    @Ack() ack: WsAckFunction<[reversed: Buffer]>,
  ): void {
    ack(Buffer.from(bytes).reverse());
  }

  /** Replies with bytes: returning a `Buffer` as `data` sends a `BINARY_EVENT`. */
  @SubscribeMessage("download")
  download(): WsResponse<Buffer> {
    return { event: "file", data: Buffer.from([0xff, 0x00, 0xe9]) };
  }

  /** NestJS's exception handler calls `client.emit("exception", …)`. */
  @SubscribeMessage("fizzle")
  fizzle(): never {
    throw new WsException("nothing to fizzle");
  }
}

@Module({ providers: [ProtocolGateway] })
class AppModule {}

title("Message formats");

const httpAdapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, httpAdapter, {
  logger: false,
});
app.useWebSocketAdapter(httpAdapter.webSocketAdapter);
await app.listen(0);

const gateway = app.get(ProtocolGateway);
const client = await connect(`ws://127.0.0.1:${httpAdapter.listeningPort}/`);

/** Sends one packet and prints it as it goes on the wire. */
function send(packet: WirePacket | string): void {
  show("→", typeof packet === "string" ? packet : JSON.stringify(packet));
  client.send(packet);
}

/** Waits for a packet a type guard accepts and prints it, narrowed. */
async function receive<TPacket extends WirePacket>(
  what: string,
  predicate: (packet: WirePacket) => packet is TPacket,
): Promise<TPacket>;
/** Waits for a packet and prints it as it came off the wire. */
async function receive(
  what: string,
  predicate: (packet: WirePacket) => boolean,
): Promise<WirePacket>;
async function receive(
  what: string,
  predicate: (packet: WirePacket) => boolean,
): Promise<WirePacket> {
  const packet = await client.next(what, predicate);
  show("←", JSON.stringify(packet));
  return packet;
}

/** Waits for the `EVENT` named `event` and prints it. */
async function receiveEvent(event: string): Promise<WirePacket> {
  return receive(`an "${event}" event`, (packet) => {
    return (
      packet.type === MessageEventTypes.EVENT && eventName(packet) === event
    );
  });
}

/* ------------------------------------------------------------------ */
step("EVENT (2): call a handler, get its WsResponse back");

const event: MessageEventType = {
  type: MessageEventTypes.EVENT,
  namespace: "/",
  data: ["echo", "hello"],
};
send(event);
await receiveEvent("echo");

/* ------------------------------------------------------------------ */
step("EVENT with an id: @Ack() answers with ACK (3) of that id");

send({ ...event, id: 7, data: ["remember", "milk"] });
await receive("ACK 7", (packet) => {
  return packet.type === MessageEventTypes.ACK && packet.id === 7;
});

/* ------------------------------------------------------------------ */
step("The namespace field is echoed, not routed");

send({ ...event, namespace: "/elsewhere", data: ["echo", "still here"] });
await receive("the echo naming /elsewhere", (packet) => {
  return packet.namespace === "/elsewhere";
});

/* ------------------------------------------------------------------ */
step("ACK (3) and BINARY_ACK (6) from a client are echoed back unchanged");

const clientAck: MessageAckType = {
  type: MessageEventTypes.ACK,
  namespace: "/",
  id: 9,
  data: ["got it"],
};
send(clientAck);
await receive("ACK 9 echoed", (packet) => {
  return packet.type === MessageEventTypes.ACK && packet.id === 9;
});

const clientBinaryAck: MessageBinaryAckType = {
  type: MessageEventTypes.BINARY_ACK,
  namespace: "/",
  id: 10,
  data: ["got the bytes"],
};
send(clientBinaryAck);
await receive("BINARY_ACK 10 echoed", (packet) => {
  return packet.type === MessageEventTypes.BINARY_ACK && packet.id === 10;
});

/* ------------------------------------------------------------------ */
step("CONNECT (0) and DISCONNECT (1): reserved handler names");

const connectPacket: MessageConnectType = {
  type: MessageEventTypes.CONNECT,
  namespace: "/",
};
send(connectPacket);
await receiveEvent("connected");

const disconnectPacket: MessageDisConnectType = {
  type: MessageEventTypes.DISCONNECT,
  namespace: "/",
};
send(disconnectPacket);
await receiveEvent("bye");
show("socket still open", client.closed() === undefined);
show("handler calls", {
  connect: gateway.connectPackets,
  disconnect: gateway.disconnectPackets,
});

/* ------------------------------------------------------------------ */
step("ERROR (4) from a client: the error handler gets its text");

const errorPacket: MessageErrorType = {
  type: MessageEventTypes.ERROR,
  namespace: "/",
  data: "the client broke",
};
send(errorPacket);
await receiveEvent("error-seen");

/* ------------------------------------------------------------------ */
step("BINARY_EVENT (5): the payload travels as base64, arrives as a Buffer");

const binaryEvent: MessageBinaryEventType = {
  type: MessageEventTypes.BINARY_EVENT,
  namespace: "/",
  data: ["upload", Buffer.from("raw bytes").toString("base64")],
};
send(binaryEvent);
await receiveEvent("uploaded");

// With an id, the ack type follows what the handler acks with: a number is
// an ACK (3) ...
send({ ...binaryEvent, id: 11, data: ["store", btoa("12345")] });
await receive("ACK 11", (packet) => {
  return packet.type === MessageEventTypes.ACK && packet.id === 11;
});

// ... and bytes are a BINARY_ACK (6).
send({ ...binaryEvent, id: 12, data: ["reverse", btoa("abc")] });
const reversed = await receive(
  "BINARY_ACK 12",
  (packet): packet is MessageBinaryAckType<[reversed: Buffer]> => {
    return packet.type === MessageEventTypes.BINARY_ACK && packet.id === 12;
  },
);
show(
  "acked bytes, decoded",
  Buffer.from(reversed.data[0], "base64").toString(),
);

/* ------------------------------------------------------------------ */
step("Replying with bytes: a Buffer as `data` is a BINARY_EVENT (5)");

send({ ...event, data: ["download", null] });
const file = await receive(
  "the binary reply",
  (packet): packet is MessageBinaryEventType<"file", [bytes: Buffer]> => {
    return (
      packet.type === MessageEventTypes.BINARY_EVENT &&
      eventName(packet) === "file"
    );
  },
);
show("bytes, decoded", [...Buffer.from(file.data[1], "base64")]);

/* ------------------------------------------------------------------ */
step("A binary frame holding a JSON packet is read the same way");

show("→ (binary frame)", JSON.stringify(event));
client.send(new TextEncoder().encode(JSON.stringify(event)));
await waitFor("the second echo", () => client.payloadsOf("echo").length === 3);
show("echo payloads so far", client.payloadsOf("echo"));

/* ------------------------------------------------------------------ */
step("A frame that is not JSON: ERROR packet, error handler, catch-all");

send("this is not json");
await receive("the adapter's ERROR packet", (packet) => {
  return packet.type === MessageEventTypes.ERROR;
});
await waitFor("the error handler's second reply", () => {
  return client.payloadsOf("error-seen").length === 2;
});
show("error handler got", client.payloadsOf("error-seen")[1]);
await receiveEvent("unrouted");

/* ------------------------------------------------------------------ */
step("Frames that parse but cannot be routed go to the catch-all");

send(JSON.stringify({ type: 42, namespace: "/" }));
send(
  JSON.stringify({
    type: MessageEventTypes.EVENT,
    namespace: "/",
    data: "no array",
  }),
);
await waitFor(
  "two more unrouted",
  () => client.payloadsOf("unrouted").length === 3,
);
show("unrouted payloads", client.payloadsOf("unrouted"));

/* ------------------------------------------------------------------ */
step("Exceptions: a thrown WsException arrives as an `exception` event");

send({ ...event, data: ["fizzle", null] });
await receiveEvent("exception");

await client.close();
await app.close();
show("closed");
