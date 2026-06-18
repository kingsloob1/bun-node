/**
 * True NestJS integration: a real `@Module` app bootstrapped with bun-nest's
 * `BunHttpAdapter`, using `app.useWebSocketAdapter(httpAdapter.webSocketAdapter)`
 * and real `@WebSocketGateway` / `@SubscribeMessage` gateways driven over a
 * real `WebSocket` connection. Exercises the WsParamsFactory convention
 * (`@ConnectedSocket`, `@MessageBody`) and the gateway lifecycle hooks.
 *
 * `reflect-metadata` is imported last per the import-sort rule; it still
 * executes before the gateway class body (and its decorators) runs.
 */
import type { WebSocketClient } from "@kingsleyweb/bun-common";
import type { INestApplication } from "@nestjs/common";
import type {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from "@nestjs/websockets";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { of } from "rxjs";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { MessageEventTypes } from "../lib/BunWebSocketAdapter";
import { connectWs } from "./helpers";
import "reflect-metadata";

const EVENT = MessageEventTypes.EVENT;

/** Mutable lifecycle state the gateway records into, asserted by the tests. */
const lifecycle = {
  initCalls: 0,
  connections: 0,
  disconnections: 0,
  lastConnectedHasSend: false,
};

@WebSocketGateway()
class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: unknown;

  afterInit() {
    lifecycle.initCalls += 1;
  }

  handleConnection(client: WebSocketClient) {
    lifecycle.connections += 1;
    lifecycle.lastConnectedHasSend = typeof client?.send === "function";
  }

  handleDisconnect() {
    lifecycle.disconnections += 1;
  }

  @SubscribeMessage("echo")
  echo(
    @ConnectedSocket() client: WebSocketClient,
    @MessageBody() data: unknown,
  ) {
    return { event: "echoed", data: { data, hadClient: !!client } };
  }

  @SubscribeMessage("sum")
  sum(@MessageBody() nums: number[]) {
    return { event: "sum", data: nums.reduce((a, b) => a + b, 0) };
  }

  @SubscribeMessage("stream")
  stream() {
    return of(
      { event: "stream", data: 1 },
      { event: "stream", data: 2 },
      { event: "stream", data: 3 },
    );
  }

  @SubscribeMessage("noreply")
  noreply() {
    // A non-WsResponse return value must not produce a frame.
    return "ignored";
  }
}

@Module({ providers: [ChatGateway] })
class AppModule {}

let app: INestApplication;
let httpAdapter: BunHttpAdapter;
let base: string;

beforeAll(async () => {
  httpAdapter = new BunHttpAdapter(30000);
  httpAdapter.registerParserMiddleware(undefined, true);
  app = await NestFactory.create(AppModule, httpAdapter as never, {
    logger: false,
  });
  app.useWebSocketAdapter(httpAdapter.webSocketAdapter as never);
  await app.listen(0);
  base = `ws://127.0.0.1:${httpAdapter.listeningPort}`;
});

afterAll(async () => {
  await app?.close();
});

describe("NestJS gateway integration: lifecycle", () => {
  it("calls afterInit exactly once during bootstrap", () => {
    expect(lifecycle.initCalls).toBe(1);
  });

  it("calls handleConnection with a usable client, then handleDisconnect", async () => {
    const before = lifecycle.connections;
    const client = await connectWs(`${base}/`);
    // Round-trip a message to be sure the connection is fully established.
    client.send({ type: EVENT, namespace: "/", data: ["echo", "x"] });
    await client.waitFor((m) => m?.data?.[0] === "echoed");

    expect(lifecycle.connections).toBe(before + 1);
    expect(lifecycle.lastConnectedHasSend).toBe(true);

    const beforeDisc = lifecycle.disconnections;
    await client.close();
    // Give the close event a tick to propagate.
    await new Promise((r) => setTimeout(r, 50));
    expect(lifecycle.disconnections).toBe(beforeDisc + 1);
  });
});

describe("NestJS gateway integration: @SubscribeMessage", () => {
  it("injects @MessageBody and @ConnectedSocket and returns a WsResponse", async () => {
    const client = await connectWs(`${base}/`);
    client.send({ type: EVENT, namespace: "/", data: ["echo", { hi: 1 }] });
    const reply = await client.waitFor((m) => m?.data?.[0] === "echoed");

    expect(reply.data[1]).toEqual({ data: { hi: 1 }, hadClient: true });
    await client.close();
  });

  it("supports multiple message handlers on one gateway", async () => {
    const client = await connectWs(`${base}/`);
    client.send({ type: EVENT, namespace: "/", data: ["sum", [1, 2, 3, 4]] });
    const reply = await client.waitFor((m) => m?.data?.[0] === "sum");

    expect(reply.data[1]).toBe(10);
    await client.close();
  });

  it("streams every emission of an Observable handler", async () => {
    const client = await connectWs(`${base}/`);
    client.send({ type: EVENT, namespace: "/", data: ["stream", null] });
    await client.waitFor(
      (m) => m?.data?.[0] === "stream" && m?.data?.[1] === 3,
    );

    const values = client.received
      .map((r) => JSON.parse(r))
      .filter((m) => m.data?.[0] === "stream")
      .map((m) => m.data[1]);
    expect(values).toEqual([1, 2, 3]);
    await client.close();
  });

  it("does not emit a frame when the handler returns a non-WsResponse", async () => {
    const client = await connectWs(`${base}/`);
    client.send({ type: EVENT, namespace: "/", data: ["noreply", null] });
    client.send({ type: EVENT, namespace: "/", data: ["sum", [5, 5]] });
    await client.waitFor((m) => m?.data?.[0] === "sum");

    expect(client.received.some((r) => r.includes("ignored"))).toBe(false);
    await client.close();
  });
});
