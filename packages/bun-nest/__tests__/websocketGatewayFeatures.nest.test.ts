/**
 * NestJS gateway *feature* coverage for the bun-nest WebSocket adapter: a
 * custom-port gateway, a namespaced gateway, `@MessageBody("key")` property
 * extraction, and multiple gateways coexisting on one app. All run against a
 * real `NestFactory` app + real `WebSocket` connections.
 *
 * Notes on this adapter's behaviour (verified by these tests):
 *  - `@WebSocketGateway(port)` binds a dedicated bun server that LISTENS on that
 *    port; clients can connect on it directly (`ws://host:<port>/`). Because the
 *    gateway also registers its upgrade route on the shared router, it remains
 *    reachable on the HTTP adapter's port too.
 *  - `@WebSocketGateway({ namespace })` registers an upgrade route at that path;
 *    clients connect to it directly (`ws://host:port/chat`).
 *  - Namespaces are ISOLATED, matching socket.io / NestJS: a gateway's handlers
 *    fire only for clients connected to its namespace (the connection path). A
 *    gateway with no namespace uses the default "/". An event registered on one
 *    namespace is NOT reachable from a connection to another namespace.
 *
 * `reflect-metadata` is imported last per the import-sort rule; it still
 * executes before the gateway class bodies (and their decorators) run.
 */
import type { WebSocketClient } from "@kingsleyweb/bun-common";
import type { INestApplication } from "@nestjs/common";
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
import { MessageEventTypes } from "../lib/BunWebSocketAdapter";
import { connectWs } from "./helpers";
import "reflect-metadata";

const EVENT = MessageEventTypes.EVENT;

// An OS-assigned free port chosen before the gateway is declared, so the
// dedicated-port test doesn't collide with anything (the decorator needs a
// concrete port at class-definition time).
const GATEWAY_PORT = await getPort({ host: "127.0.0.1", port: 0 });

/** Declared with an explicit port — must listen on exactly that port. */
@WebSocketGateway(GATEWAY_PORT)
class PortGateway {
  @SubscribeMessage("ping")
  ping(@MessageBody() data: unknown) {
    return { event: "pong", data };
  }
}

/** Declared with a namespace — reachable at `ws://host:port/chat`. */
@WebSocketGateway({ namespace: "/chat" })
class ChatNamespaceGateway {
  @SubscribeMessage("msg")
  msg(
    @ConnectedSocket() client: WebSocketClient,
    @MessageBody("text") text: unknown,
  ) {
    return { event: "reply", data: { text, path: client?.data?.path } };
  }

  @SubscribeMessage("whole")
  whole(@MessageBody() body: unknown) {
    return { event: "whole", data: body };
  }
}

@Module({ providers: [PortGateway, ChatNamespaceGateway] })
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

describe("NestJS gateway features: custom port", () => {
  it("listens on the port declared via @WebSocketGateway(port)", async () => {
    // The HTTP server is on a different port; this connects to the gateway's
    // own declared port, which must be accepting connections.
    expect(GATEWAY_PORT).not.toBe(httpAdapter.listeningPort);

    const client = await connectWs(`ws://127.0.0.1:${GATEWAY_PORT}/`);
    client.send({ type: EVENT, namespace: "/", data: ["ping", "hi"] });
    const reply = await client.waitFor((m) => m?.data?.[0] === "pong");

    expect(reply.data[1]).toBe("hi");
    await client.close();
  });

  it("is also reachable on the shared HTTP server port (default namespace)", async () => {
    // PortGateway declares no namespace → default "/", so it answers clients
    // connected to "/" on the shared HTTP server too.
    const client = await connectWs(`${base}/`);
    client.send({ type: EVENT, namespace: "/", data: ["ping", "shared"] });
    const reply = await client.waitFor((m) => m?.data?.[0] === "pong");

    expect(reply.data[1]).toBe("shared");
    await client.close();
  });
});

describe("NestJS gateway features: namespace", () => {
  it("handles a namespaced gateway when connecting to its path", async () => {
    const client = await connectWs(`${base}/chat`);
    client.send({
      type: EVENT,
      namespace: "/",
      data: ["msg", { text: "yo" }],
    });
    const reply = await client.waitFor((m) => m?.data?.[0] === "reply");

    expect(reply.data[1]).toEqual({ text: "yo", path: "/chat" });
    await client.close();
  });

  it("does not hang on a namespace whose path matches the connection (recursion guard)", async () => {
    // Regression: registering the adapter's own wsHandler as a per-route
    // handler under a path equal to the connection path used to recurse
    // infinitely. This must simply round-trip.
    const client = await connectWs(`${base}/chat`);
    client.send({ type: EVENT, namespace: "/", data: ["whole", { a: 1 }] });
    const reply = await client.waitFor((m) => m?.data?.[0] === "whole");

    expect(reply.data[1]).toEqual({ a: 1 });
    await client.close();
  });
});

describe("NestJS gateway features: namespace isolation (socket.io semantics)", () => {
  it("does NOT reach another namespace's handlers from a /chat connection", async () => {
    // PortGateway listens on the default namespace "/"; its "ping" handler must
    // NOT fire for a client connected to the "/chat" namespace. Only the
    // "/chat" gateway's "msg" handler should respond.
    const client = await connectWs(`${base}/chat`);

    client.send({ type: EVENT, namespace: "/", data: ["ping", 1] });
    client.send({ type: EVENT, namespace: "/", data: ["msg", { text: "t" }] });

    // The reply to "msg" proves the round-trip completed; "ping" had the same
    // window to respond and must not have.
    const reply = await client.waitFor((m) => m?.data?.[0] === "reply");
    expect(reply.data[1].text).toBe("t");
    expect(client.received.some((r) => r.includes("pong"))).toBe(false);

    await client.close();
  });

  it("isolates the default namespace from /chat (no /chat handlers on '/')", async () => {
    const client = await connectWs(`${base}/`);

    client.send({ type: EVENT, namespace: "/", data: ["msg", { text: "x" }] });
    client.send({ type: EVENT, namespace: "/", data: ["ping", 9] });

    const pong = await client.waitFor((m) => m?.data?.[0] === "pong");
    expect(pong.data[1]).toBe(9);
    expect(client.received.some((r) => r.includes("reply"))).toBe(false);

    await client.close();
  });

  it("refuses a connection to an unknown namespace (socket.io invalid namespace)", async () => {
    // No gateway serves "/nope", so no ws route matches and the upgrade is
    // refused at the HTTP layer — the WebSocket never opens (socket.io rejects
    // connections to unknown namespaces).
    let opened = false;
    try {
      const client = await connectWs(`${base}/nope`);
      opened = true;
      await client.close();
    } catch {
      // expected: the upgrade was refused, so the socket never opened.
    }
    expect(opened).toBe(false);
  });
});

describe("NestJS gateway features: @MessageBody extraction", () => {
  it("extracts a sub-property with @MessageBody('key')", async () => {
    const client = await connectWs(`${base}/chat`);
    client.send({
      type: EVENT,
      namespace: "/",
      data: ["msg", { text: "deep", ignored: true }],
    });
    const reply = await client.waitFor((m) => m?.data?.[0] === "reply");

    expect(reply.data[1].text).toBe("deep");
    await client.close();
  });

  it("injects the whole payload with bare @MessageBody()", async () => {
    const client = await connectWs(`${base}/chat`);
    const payload = { a: 1, b: [2, 3] };
    client.send({ type: EVENT, namespace: "/", data: ["whole", payload] });
    const reply = await client.waitFor((m) => m?.data?.[0] === "whole");

    expect(reply.data[1]).toEqual(payload);
    await client.close();
  });
});
