/**
 * Regression coverage for a *custom* WebSocket adapter passed to
 * `app.useWebSocketAdapter()`. The other gateway integration tests reuse the
 * HTTP adapter's built-in adapter (`httpAdapter.webSocketAdapter`), so they
 * never exercised the case where a user constructs their OWN
 * `BunWebSocketAdapter` and hands it to NestJS.
 *
 * The bug: `Bun.serve`'s `websocket` was hard-wired to the built-in adapter's
 * handler, so connections/messages were dispatched there instead of to the
 * custom adapter that actually holds the gateway's connect/message bindings —
 * the gateway never saw any traffic. The fix delegates the `Bun.serve`
 * lifecycle callbacks to whichever adapter is active on the router
 * (`instance.getBunWebsocket()`), which `useWebSocketAdapter` updates.
 *
 * `reflect-metadata` is imported last per the import-sort rule; it still
 * executes before the gateway class body (and its decorators) runs.
 */
import type { WebSocketClient } from "@kingsleyweb/bun-common";
import type { INestApplication } from "@nestjs/common";
import type { OnGatewayConnection } from "@nestjs/websockets";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  BunWebSocketAdapter,
  MessageEventTypes,
} from "../lib/BunWebSocketAdapter";
import { connectWs } from "./helpers";
import "reflect-metadata";

const EVENT = MessageEventTypes.EVENT;

/** Records that the custom adapter's own connect binding actually fired. */
const observed = { connections: 0 };

@WebSocketGateway()
class CustomAdapterGateway implements OnGatewayConnection {
  handleConnection() {
    observed.connections += 1;
  }

  @SubscribeMessage("echo")
  echo(
    @ConnectedSocket() client: WebSocketClient,
    @MessageBody() data: unknown,
  ) {
    return { event: "echoed", data: { data, hadClient: !!client } };
  }
}

@Module({ providers: [CustomAdapterGateway] })
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

  // The crux of this test: a *separately constructed* adapter, NOT
  // `httpAdapter.webSocketAdapter`. It rides on the HTTP adapter's shared
  // server/router but is its own instance with its own emitter + route table.
  const customAdapter = new BunWebSocketAdapter({ httpAdapter });
  app.useWebSocketAdapter(customAdapter as never);

  await app.listen(0);
  base = `ws://127.0.0.1:${httpAdapter.listeningPort}`;
});

afterAll(async () => {
  await app?.close();
});

describe("NestJS gateway with a custom BunWebSocketAdapter", () => {
  it("routes connections to the custom adapter, not the built-in one", async () => {
    const before = observed.connections;
    const client = await connectWs(`${base}/`);
    client.send({ type: EVENT, namespace: "/", data: ["echo", "x"] });
    await client.waitFor((m) => m?.data?.[0] === "echoed");

    expect(observed.connections).toBe(before + 1);
    await client.close();
  });

  it("delivers @SubscribeMessage traffic to the custom adapter's gateway", async () => {
    const client = await connectWs(`${base}/`);
    client.send({ type: EVENT, namespace: "/", data: ["echo", { hi: 1 }] });
    const reply = await client.waitFor((m) => m?.data?.[0] === "echoed");

    expect(reply.data[1]).toEqual({ data: { hi: 1 }, hadClient: true });
    await client.close();
  });
});
