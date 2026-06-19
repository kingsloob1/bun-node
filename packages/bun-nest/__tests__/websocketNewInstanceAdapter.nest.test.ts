/**
 * Regression coverage for a custom `newInstance` WebSocket adapter that listens
 * on its OWN port, driven by NestJS via `app.useWebSocketAdapter()`.
 *
 * Unlike the shared-server adapter (which rides on the HTTP adapter's
 * `Bun.serve`), a `newInstance` adapter binds a dedicated server on the port
 * passed via `listen`. This test verifies two things:
 *  - the adapter, when given no explicit `router`, falls back to the HTTP
 *    adapter's router so its gateway upgrade routes register and NestJS can
 *    drive it (otherwise `create()` would have no router); and
 *  - a real `@WebSocketGateway` is reachable over the adapter's own port and
 *    its `@SubscribeMessage` handlers fire.
 *
 * `reflect-metadata` is imported last per the import-sort rule; it still
 * executes before the gateway class body (and its decorators) runs.
 */
import type { WebSocketClient } from "@kingsleyweb/bun-common";
import type { INestApplication } from "@nestjs/common";
import type { OnGatewayConnection } from "@nestjs/websockets";
import { getPort } from "@kingsleyweb/bun-common";
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

// The adapter's dedicated port, assigned in `beforeAll`. Resolved there rather
// than at module top-level: a top-level `await` in a test file perturbs Bun's
// cross-file decorator-metadata setup (reflect-metadata), breaking `@Subscribe
// Message` in *other* gateway test files. The gateway here is port-less
// (`@WebSocketGateway()`), so nothing needs the port at class-definition time.
let ADAPTER_PORT = 0;

/** Records that the newInstance adapter's own connect binding actually fired. */
const observed = { connections: 0 };

@WebSocketGateway()
class NewInstanceGateway implements OnGatewayConnection {
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

@Module({ providers: [NewInstanceGateway] })
class AppModule {}

let app: INestApplication;
let httpAdapter: BunHttpAdapter;
let customAdapter: BunWebSocketAdapter;

beforeAll(async () => {
  ADAPTER_PORT = await getPort({ host: "127.0.0.1", port: 0 });
  httpAdapter = new BunHttpAdapter(30000);
  httpAdapter.registerParserMiddleware(undefined, true);
  app = await NestFactory.create(AppModule, httpAdapter as never, {
    logger: false,
  });

  // A newInstance adapter on its OWN port. No `router` is supplied, so it must
  // fall back to the HTTP adapter's router (the behaviour under test).
  customAdapter = new BunWebSocketAdapter({
    newInstance: true,
    listen: { port: ADAPTER_PORT },
    httpAdapter,
  });
  app.useWebSocketAdapter(customAdapter as never);

  await app.listen(0);
});

afterAll(async () => {
  await app?.close();
  customAdapter?.close(undefined);
});

describe("NestJS gateway with a newInstance BunWebSocketAdapter on its own port", () => {
  it("defaults the router to the HTTP adapter's router when none is given", () => {
    expect(customAdapter.router).toBe(httpAdapter.instance);
  });

  it("binds a dedicated server on the adapter's own port", () => {
    expect(ADAPTER_PORT).not.toBe(httpAdapter.listeningPort);
    expect(Number(customAdapter.getServer()?.port)).toBe(ADAPTER_PORT);
  });

  it("routes connections and @SubscribeMessage traffic over the own port", async () => {
    const before = observed.connections;
    const client = await connectWs(`ws://127.0.0.1:${ADAPTER_PORT}/`);
    client.send({ type: EVENT, namespace: "/", data: ["echo", { hi: 1 }] });
    const reply = await client.waitFor((m) => m?.data?.[0] === "echoed");

    expect(observed.connections).toBe(before + 1);
    expect(reply.data[1]).toEqual({ data: { hi: 1 }, hadClient: true });
    await client.close();
  });
});
