/**
 * NestJS gateway wiring that depends on the adapter binding each gateway to
 * its own route, not to whatever the previous gateway declared:
 *
 *  - a default-namespace gateway listed *after* a namespaced one still serves
 *    `/` (NestJS skips `create()` for a server it already has);
 *  - `@WebSocketGateway({ path })` serves that path only, as on
 *    `@nestjs/platform-ws`;
 *  - a thrown `WsException` reaches the client as an `exception` event
 *    (NestJS's handler needs `client.emit`, which the adapter installs);
 *  - `close(server)` on the shared HTTP server closes WebSocket connections
 *    but leaves the HTTP server running.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other gateway test files.
 */
import type { INestApplication } from "@nestjs/common";
import type { WebSocketClient } from "../lib/BunWebSocketAdapter";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from "@nestjs/websockets";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { MessageEventTypes } from "../lib/BunWebSocketAdapter";
import { connectWs } from "./helpers";
import "reflect-metadata";

const EVENT = MessageEventTypes.EVENT;

@WebSocketGateway({ namespace: "/rooms" })
class RoomsGateway {
  @SubscribeMessage("where")
  where(@ConnectedSocket() client: WebSocketClient) {
    return { event: "here", data: client.data.path };
  }
}

/** Listed after RoomsGateway: must serve "/", not "/rooms". */
@WebSocketGateway()
class LateGateway {
  @SubscribeMessage("late")
  late() {
    return { event: "late", data: "on time" };
  }

  @SubscribeMessage("fail")
  fail(@MessageBody() body: unknown) {
    throw new WsException(`refused ${String(body)}`);
  }
}

@WebSocketGateway({ path: "/ws" })
class PathGateway {
  @SubscribeMessage("which")
  which(@ConnectedSocket() client: WebSocketClient) {
    return { event: "which", data: client.data.path };
  }
}

@Module({ providers: [RoomsGateway, LateGateway, PathGateway] })
class AppModule {}

let app: INestApplication;
let httpAdapter: BunHttpAdapter;
let base: string;

beforeAll(async () => {
  httpAdapter = new BunHttpAdapter(30000);
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

describe("NestJS gateway binding: per-gateway routes", () => {
  it("binds a default gateway listed after a namespaced one to '/'", async () => {
    const client = await connectWs(`${base}/`);
    client.send({ type: EVENT, namespace: "/", data: ["late", null] });
    const reply = await client.waitFor((m) => m?.data?.[0] === "late");

    expect(reply.data[1]).toBe("on time");
    await client.close();
  });

  it("keeps the namespaced gateway on its namespace", async () => {
    const client = await connectWs(`${base}/rooms`);
    client.send({ type: EVENT, namespace: "/", data: ["late", null] });
    client.send({ type: EVENT, namespace: "/", data: ["where", null] });
    const reply = await client.waitFor((m) => m?.data?.[0] === "here");

    expect(reply.data[1]).toBe("/rooms");
    expect(client.received.some((r) => r.includes("on time"))).toBe(false);
    await client.close();
  });

  it("serves @WebSocketGateway({ path }) on that path only", async () => {
    const onPath = await connectWs(`${base}/ws`);
    onPath.send({ type: EVENT, namespace: "/", data: ["which", null] });
    const reply = await onPath.waitFor((m) => m?.data?.[0] === "which");
    expect(reply.data[1]).toBe("/ws");
    await onPath.close();

    const onRoot = await connectWs(`${base}/`);
    onRoot.send({ type: EVENT, namespace: "/", data: ["which", null] });
    onRoot.send({ type: EVENT, namespace: "/", data: ["late", null] });
    await onRoot.waitFor((m) => m?.data?.[0] === "late");
    expect(onRoot.received.some((r) => r.includes("which"))).toBe(false);
    await onRoot.close();
  });
});

describe("NestJS gateway binding: exceptions", () => {
  it("delivers a thrown WsException as an `exception` event", async () => {
    const client = await connectWs(`${base}/`);
    client.send({ type: EVENT, namespace: "/", data: ["fail", "x"] });
    const reply = await client.waitFor((m) => m?.data?.[0] === "exception");

    expect(reply).toEqual({
      type: EVENT,
      namespace: "/",
      data: [
        "exception",
        {
          status: "error",
          message: "refused x",
          cause: { pattern: "fail", data: "x" },
        },
      ],
    });
    await client.close();
  });
});

describe("NestJS gateway binding: close()", () => {
  it("closes connections on the shared server without stopping HTTP", async () => {
    const client = await connectWs(`${base}/`);
    const closed = new Promise<number>((resolve) => {
      client.socket.addEventListener("close", (event) => resolve(event.code));
    });

    httpAdapter.webSocketAdapter.close(httpAdapter.getBunServer());

    expect(await closed).toBe(1001);
    expect(httpAdapter.isListening).toBe(true);
    const response = await fetch(
      `http://127.0.0.1:${httpAdapter.listeningPort}/nothing-here`,
    );
    expect(response.status).toBe(404);
  });
});
