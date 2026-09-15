/**
 * `@Ack()` against a real NestJS app: NestJS's `GatewayMetadataExplorer` sets
 * `isAckHandledManually` for a handler declaring `@Ack()`, and the adapter
 * must then treat acks as `@nestjs/platform-socket.io`'s `IoAdapter` does:
 *
 *  - with `@Ack()`, only the handler's own call sends the `ACK` — never its
 *    return value (nor any emission of a returned Promise or Observable);
 *  - without it, a non-nullish, non-`WsResponse` return is the `ACK`;
 *  - either way a `WsResponse` is emitted, and an ack sends at most once.
 *
 * `reflect-metadata` is imported last per the import-sort rule; it still
 * executes before the gateway class body (and its decorators) runs.
 */
import type { INestApplication, WsMessageHandler } from "@nestjs/common";
import type { WsAckFunction } from "../lib/BunWebSocketAdapter";
import type { WsTestClient } from "./helpers";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  Ack,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { of } from "rxjs";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { MessageEventTypes } from "../lib/BunWebSocketAdapter";
import { connectWs } from "./helpers";
import "reflect-metadata";

const { ACK, EVENT } = MessageEventTypes;

@WebSocketGateway()
class AckGateway {
  @SubscribeMessage("manual-return")
  manualReturn(@MessageBody() body: unknown, @Ack() ack: WsAckFunction) {
    ack("manual", body);
    return "returned";
  }

  @SubscribeMessage("manual-void")
  manualVoid(@Ack() ack: WsAckFunction): void {
    ack("only");
  }

  @SubscribeMessage("manual-twice")
  manualTwice(@Ack() ack: WsAckFunction) {
    ack("first");
    ack("second");
    return "returned";
  }

  @SubscribeMessage("manual-never")
  manualNever(@Ack() _ack: WsAckFunction) {
    return "returned";
  }

  @SubscribeMessage("manual-async")
  async manualAsync(@Ack() ack: WsAckFunction) {
    await Bun.sleep(5);
    ack("late");
    return "returned";
  }

  @SubscribeMessage("manual-observable")
  manualObservable(@Ack() ack: WsAckFunction) {
    ack("manual");
    return of("a", "b", { event: "obs-event", data: 1 });
  }

  @SubscribeMessage("auto-return")
  autoReturn(@MessageBody() body: unknown) {
    return { saved: body };
  }

  @SubscribeMessage("auto-promise")
  async autoPromise() {
    return 42;
  }

  @SubscribeMessage("auto-observable")
  autoObservable() {
    return of("first", "second");
  }

  @SubscribeMessage("auto-ws-response")
  autoWsResponse() {
    return { event: "reply", data: "r" };
  }

  @SubscribeMessage("sentinel")
  sentinel(@MessageBody() marker: string) {
    return { event: "sentinel", data: marker };
  }
}

@Module({ providers: [AckGateway] })
class AppModule {}

let app: INestApplication;
let base: string;

/** `isAckHandledManually` per message, as NestJS handed it to the adapter. */
const flags = new Map<string, boolean>();

beforeAll(async () => {
  const httpAdapter = new BunHttpAdapter(30000);
  app = await NestFactory.create(AppModule, httpAdapter as never, {
    logger: false,
  });
  const adapter = httpAdapter.webSocketAdapter;
  const bind = adapter.bindMessageHandlers.bind(adapter);
  adapter.bindMessageHandlers = (client, handlers, transform) => {
    handlers.forEach((handler: WsMessageHandler<string>) => {
      flags.set(handler.message, handler.isAckHandledManually);
    });
    bind(client, handlers, transform);
  };
  app.useWebSocketAdapter(adapter as never);
  await app.listen(0);
  base = `ws://127.0.0.1:${httpAdapter.listeningPort}`;
});

afterAll(async () => {
  await app?.close();
});

let markers = 0;

/**
 * Sends `packet`, then a sentinel, and resolves with every frame `packet`
 * produced (after a short settle for asynchronous acks).
 */
async function framesFrom(
  client: WsTestClient,
  packet: Record<string, unknown>,
): Promise<unknown[]> {
  const before = client.received.length;
  const marker = `marker-${++markers}`;
  client.send({ type: EVENT, namespace: "/", ...packet });
  client.send({ type: EVENT, namespace: "/", data: ["sentinel", marker] });
  await client.waitFor(
    (m) => m?.data?.[0] === "sentinel" && m.data[1] === marker,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  return client.received
    .slice(before)
    .map((raw) => JSON.parse(raw))
    .filter((m) => m?.data?.[0] !== "sentinel");
}

const ackOf = (id: number, data: unknown[]) => ({
  type: ACK,
  id,
  namespace: "/",
  data,
});

describe("NestJS gateway: isAckHandledManually", () => {
  it("is true exactly for the handlers declaring @Ack()", async () => {
    const client = await connectWs(`${base}/`);
    await framesFrom(client, { data: ["sentinel", "warm-up"] });

    expect(Object.fromEntries(flags)).toEqual({
      "manual-return": true,
      "manual-void": true,
      "manual-twice": true,
      "manual-never": true,
      "manual-async": true,
      "manual-observable": true,
      "auto-return": false,
      "auto-promise": false,
      "auto-observable": false,
      "auto-ws-response": false,
      sentinel: false,
    });
    await client.close();
  });
});

describe("NestJS gateway: @Ack()", () => {
  let client: WsTestClient;
  beforeAll(async () => {
    client = await connectWs(`${base}/`);
  });
  afterAll(async () => {
    await client?.close();
  });

  it("with a return value, sends only the manual ack", async () => {
    expect(
      await framesFrom(client, { id: 1, data: ["manual-return", "x"] }),
    ).toEqual([ackOf(1, ["manual", "x"])]);
  });

  it("with no return, sends the manual ack", async () => {
    expect(
      await framesFrom(client, { id: 2, data: ["manual-void", null] }),
    ).toEqual([ackOf(2, ["only"])]);
  });

  it("called twice, sends one ack", async () => {
    expect(
      await framesFrom(client, { id: 3, data: ["manual-twice", null] }),
    ).toEqual([ackOf(3, ["first"])]);
  });

  it("never called, sends nothing, even with a return value", async () => {
    expect(
      await framesFrom(client, { id: 4, data: ["manual-never", null] }),
    ).toEqual([]);
  });

  it("called after an await, sends the manual ack and not the resolved value", async () => {
    expect(
      await framesFrom(client, { id: 5, data: ["manual-async", null] }),
    ).toEqual([ackOf(5, ["late"])]);
  });

  it("with an Observable return, acks manually; a WsResponse emission is still emitted", async () => {
    expect(
      await framesFrom(client, { id: 6, data: ["manual-observable", null] }),
    ).toEqual([
      ackOf(6, ["manual"]),
      { type: EVENT, namespace: "/", data: ["obs-event", 1] },
    ]);
  });
});

describe("NestJS gateway: automatic ack (no @Ack())", () => {
  let client: WsTestClient;
  beforeAll(async () => {
    client = await connectWs(`${base}/`);
  });
  afterAll(async () => {
    await client?.close();
  });

  it("acks with the return value", async () => {
    expect(
      await framesFrom(client, { id: 11, data: ["auto-return", "x"] }),
    ).toEqual([ackOf(11, [{ saved: "x" }])]);
  });

  it("acks with a Promise's resolved value", async () => {
    expect(
      await framesFrom(client, { id: 12, data: ["auto-promise", null] }),
    ).toEqual([ackOf(12, [42])]);
  });

  it("acks with an Observable's first emission only", async () => {
    expect(
      await framesFrom(client, { id: 13, data: ["auto-observable", null] }),
    ).toEqual([ackOf(13, ["first"])]);
  });

  it("emits a WsResponse instead of acking it", async () => {
    expect(
      await framesFrom(client, { id: 14, data: ["auto-ws-response", null] }),
    ).toEqual([{ type: EVENT, namespace: "/", data: ["reply", "r"] }]);
  });

  it("sends nothing for a plain event without an ack id", async () => {
    expect(await framesFrom(client, { data: ["auto-return", "x"] })).toEqual(
      [],
    );
  });
});
