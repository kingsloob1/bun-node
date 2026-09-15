/**
 * A NestJS WebSocket gateway on Bun — `@WebSocketGateway`, `@SubscribeMessage`,
 * `@MessageBody`, `@ConnectedSocket`, `@Ack` and the three lifecycle hooks,
 * served by bun-nest's `BunHttpAdapter` and its built-in WebSocket adapter.
 *
 * ```bash
 * bun 04-websockets/gateway-basics.ts
 * ```
 *
 * What a gateway handler can do with its return value:
 *
 * - **return a `WsResponse`** (`{ event, data }`) — sent back to the caller as
 *   an `EVENT` packet `{ type: 2, namespace, data: [event, data] }`.
 * - **return a `Promise` or an `Observable` of them** — every emission is sent,
 *   in order.
 * - **return anything else** — it is not a reply; wrap it in `{ event, data }`.
 *   But when the client's packet carried an ack `id` and the handler does not
 *   take `@Ack()`, it is the acknowledgement: an `ACK` packet of that id whose
 *   `data` is `[value]` (for an `Observable`, its first emission). Nothing,
 *   `null` or a packet without an `id` sends nothing.
 * - **take `@Ack()`** — when the client's packet carried an `id`, calling the
 *   callback answers with an `ACK` packet of that id. The handler then owns
 *   the ack, as with `@nestjs/platform-socket.io`: its return value is never
 *   sent as one, only the first call sends, and never calling it sends none.
 *
 * Two wiring rules: install the adapter with
 * `app.useWebSocketAdapter(httpAdapter.webSocketAdapter)` — the instance the
 * HTTP adapter's `Bun.serve` server is bound to — and do it before
 * `app.listen()`, which is when NestJS connects gateways.
 *
 * (`reflect-metadata` is imported last because the import sorter puts
 * side-effect imports there; it still loads before any decorator runs.)
 */
import type {
  BunWebSocketServerType,
  WebSocketClient,
  WsAckFunction,
} from "@kingsleyweb/bun-nest";
import type {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WsResponse,
} from "@nestjs/websockets";
import type { Observable } from "rxjs";
import { BunHttpAdapter, MessageEventTypes } from "@kingsleyweb/bun-nest";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  Ack,
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { from, map } from "rxjs";
import { checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { connect } from "./fixtures/ws-client";
import "reflect-metadata";

/** A chat line as clients send it. */
interface ChatLine {
  /** Who is speaking. */
  from: string;
  /** What they said. */
  text: string;
}

/** What the `save` handler acknowledges with. */
interface SaveReceipt {
  /** Always `true`: the line was kept. */
  saved: boolean;
  /** How many lines are kept now. */
  count: number;
}

/** A user record the `lookup` handler answers with. */
interface UserRecord {
  /** The id that was asked for. */
  id: number;
  /** The user's name. */
  name: string;
}

/** The chat room every connection joins, as a Bun pub/sub topic. */
const LOBBY = "lobby";

@WebSocketGateway()
class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  /** Every open connection, so the example can wait on connects and disconnects. */
  readonly clients = new Set<WebSocketClient>();

  /** How many times NestJS called `afterInit`. */
  initialised = 0;

  /** Notes received by the `note` handler. */
  readonly notes: string[] = [];

  /** Lines received by the `save` handler. */
  readonly saved: ChatLine[] = [];

  afterInit(): void {
    this.initialised++;
    show("afterInit — the gateway is bound to the adapter");
  }

  /** The adapter passes the client and the Bun server it connected through. */
  handleConnection(client: WebSocketClient, server: BunWebSocketServerType) {
    this.clients.add(client);
    client.subscribe(LOBBY);
    show(
      `handleConnection — ${client.data.originalUrl} via the server on port ${server.port}`,
    );
  }

  handleDisconnect(client: WebSocketClient): void {
    this.clients.delete(client);
    show(`handleDisconnect — ${client.data.originalUrl}`);
  }

  /** A `WsResponse` return is sent back as an `EVENT` packet. */
  @SubscribeMessage("hello")
  hello(@MessageBody() name: string): WsResponse<string> {
    return { event: "welcome", data: `hello, ${name}` };
  }

  /** `@ConnectedSocket()` is the Bun `ServerWebSocket`; `data` describes its upgrade. */
  @SubscribeMessage("whoami")
  whoami(
    @ConnectedSocket() client: WebSocketClient,
  ): WsResponse<{ path: string; search: string }> {
    return {
      event: "you",
      data: { path: client.data.path, search: client.data.search },
    };
  }

  /** `@MessageBody("text")` picks one property; a plain string return sends nothing. */
  @SubscribeMessage("note")
  note(@MessageBody("text") text: string): string {
    this.notes.push(text);
    return `noted: ${text}`;
  }

  /** A `Promise` is awaited and its `WsResponse` sent. */
  @SubscribeMessage("lookup")
  async lookup(@MessageBody("id") id: number): Promise<WsResponse<UserRecord>> {
    await Bun.sleep(5);
    return { event: "found", data: { id, name: `user-${id}` } };
  }

  /** Every emission of an `Observable` is sent. */
  @SubscribeMessage("countdown")
  countdown(@MessageBody() start: number): Observable<WsResponse<number>> {
    const steps = Array.from({ length: start }, (_, index) => start - index);
    return from(steps).pipe(map((n) => ({ event: "tick", data: n })));
  }

  /** `@Ack()` answers the packet's `id` with an `ACK` packet. */
  @SubscribeMessage("save")
  save(
    @MessageBody() line: ChatLine,
    @Ack() ack: WsAckFunction<[receipt: SaveReceipt]>,
  ): void {
    this.saved.push(line);
    ack({ saved: true, count: this.saved.length });
  }

  /**
   * `@Ack()` owns the ack: the call sends it, a second call is ignored, and
   * the return value is never sent as an ack.
   */
  @SubscribeMessage("archive")
  archive(
    @MessageBody() line: ChatLine,
    @Ack() ack: WsAckFunction<[archived: string]>,
  ): string {
    ack(`archived: ${line.text}`);
    ack("a second call is ignored");
    return "not sent: @Ack() handles the ack";
  }

  /** No `@Ack()`: for a packet with an `id`, the return value is the ack. */
  @SubscribeMessage("count")
  count(): number {
    return this.saved.length;
  }

  /** Publishes to every *other* lobby member, and tells the sender how many. */
  @SubscribeMessage("say")
  say(
    @ConnectedSocket() client: WebSocketClient,
    @MessageBody() line: ChatLine,
  ): WsResponse<number> {
    client.publish(
      LOBBY,
      JSON.stringify({
        type: MessageEventTypes.EVENT,
        namespace: "/",
        data: ["said", line],
      }),
    );
    return { event: "delivered", data: this.clients.size - 1 };
  }
}

@Module({ providers: [ChatGateway] })
class AppModule {}

title("Gateway basics");

/* ------------------------------------------------------------------ */
step("Boot: the built-in WebSocket adapter rides on the HTTP server");

const httpAdapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, httpAdapter, {
  logger: false,
});
// The instance `Bun.serve` is bound to. Installed before `listen()`.
app.useWebSocketAdapter(httpAdapter.webSocketAdapter);
await app.listen(0);

const gateway = app.get(ChatGateway);
const base = `ws://127.0.0.1:${httpAdapter.listeningPort}`;
show("listening", base);
show("afterInit calls", gateway.initialised);

/* ------------------------------------------------------------------ */
step("Connect two clients: handleConnection runs for each");

const alice = await connect(`${base}/?nick=alice`);
const bob = await connect(`${base}/?nick=bob`);
await waitFor("both connections", () => gateway.clients.size === 2);

/* ------------------------------------------------------------------ */
step("Return a WsResponse");

alice.emit("hello", "alice");
show("reply", await alice.nextEvent("welcome"));

/* ------------------------------------------------------------------ */
step("@ConnectedSocket: the client and what its upgrade request looked like");

alice.emit("whoami");
show("reply", await alice.nextEvent("you"));

/* ------------------------------------------------------------------ */
step("@MessageBody('text') and a return value that is not a WsResponse");

const framesBefore = alice.frames.length;
alice.emit("note", { text: "buy milk", priority: 2 });
alice.emit("hello", "again"); // answered, so it proves the note was handled first
await waitFor(
  "the second welcome",
  () => alice.payloadsOf("welcome").length === 2,
);
show("notes the gateway received", gateway.notes);
show("frames the note produced", alice.frames.length - framesBefore - 1);

/* ------------------------------------------------------------------ */
step("Return a Promise");

alice.emit("lookup", { id: 42 });
show("reply", await alice.nextEvent("found"));

/* ------------------------------------------------------------------ */
step("Return an Observable: one EVENT per emission");

alice.emit("countdown", 3);
await waitFor("three ticks", () => alice.payloadsOf("tick").length === 3);
show("ticks", alice.payloadsOf("tick"));

/* ------------------------------------------------------------------ */
step("@Ack: a packet with an id gets an ACK of the same id");

alice.emit("save", { from: "alice", text: "remember this" }, { id: 1 });
const ack = await alice.next("the ACK for id 1", (packet) => {
  return packet.type === MessageEventTypes.ACK && packet.id === 1;
});
show("ack", ack);

/* ------------------------------------------------------------------ */
step("@Ack plus a return value: only the handler's own ack is sent, once");

alice.emit("archive", { from: "alice", text: "old news" }, { id: 2 });
show(
  "ack",
  await alice.next("the ACK for id 2", (packet) => {
    return packet.type === MessageEventTypes.ACK && packet.id === 2;
  }),
);
alice.emit("hello", "after archive"); // answered after anything id 2 produced
await waitFor(
  "the third welcome",
  () => alice.payloadsOf("welcome").length === 3,
);
checkEqual(
  "one ACK for id 2, carrying the ack call's argument",
  alice.packets().filter((packet) => packet.id === 2),
  [
    {
      type: MessageEventTypes.ACK,
      namespace: "/",
      id: 2,
      data: ["archived: old news"],
    },
  ],
);
checkEqual(
  "the return value was not sent",
  JSON.stringify(alice.frames).includes("not sent"),
  false,
);

/* ------------------------------------------------------------------ */
step("No @Ack: a return value that is not a WsResponse is the ack");

alice.emit("count", null, { id: 3 });
const autoAck = await alice.next("the ACK for id 3", (packet) => {
  return packet.type === MessageEventTypes.ACK && packet.id === 3;
});
show("ack", autoAck);
checkEqual("the ACK carries the return value", autoAck, {
  type: MessageEventTypes.ACK,
  namespace: "/",
  id: 3,
  data: [gateway.saved.length],
});

/* ------------------------------------------------------------------ */
step("Broadcast: client.publish reaches every other subscriber");

alice.emit("say", { from: "alice", text: "hi all" });
show("alice is told", await alice.nextEvent("delivered"));
show("bob hears", await bob.nextEvent("said"));

/* ------------------------------------------------------------------ */
step("Disconnect: handleDisconnect runs for each");

await alice.close();
await bob.close();
await waitFor("both disconnects", () => gateway.clients.size === 0);

await app.close();
show("closed");
summary();
