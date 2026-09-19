/**
 * Gateway ports as boundaries: a gateway on the HTTP server (port 0) and one
 * on a port of its own each handle only their own server's clients, even
 * when both serve the same path — as socket.io keeps a gateway to its server.
 * Namespaces still separate gateways within one port.
 *
 * The gateways are declared inside `beforeAll`, after the free port is known:
 * a top-level `await` perturbs decorator metadata in other gateway test files.
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type { INestApplication } from "@nestjs/common";
import type { WsTestClient } from "./helpers";
import { getPort } from "@kingsleyweb/bun-common";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { MessageEventTypes } from "../lib/BunWebSocketAdapter";
import { connectWs } from "./helpers";
import "reflect-metadata";

const EVENT = MessageEventTypes.EVENT;

/** Every connection each gateway handled, by gateway name. */
const connections: Record<string, number> = {};

let app: INestApplication;
let httpAdapter: BunHttpAdapter;
let gatewayPort: number;

beforeAll(async () => {
  gatewayPort = await getPort();

  /** Records a connection to `name`. */
  const count = (name: string) => {
    connections[name] = (connections[name] ?? 0) + 1;
  };

  @WebSocketGateway()
  class SharedGateway {
    handleConnection() {
      count("shared");
    }

    @SubscribeMessage("who")
    who() {
      return { event: "who", data: "shared" };
    }
  }

  @WebSocketGateway(gatewayPort)
  class PortGateway {
    handleConnection() {
      count("port");
    }

    @SubscribeMessage("who")
    who() {
      return { event: "who", data: "port" };
    }
  }

  @WebSocketGateway({ namespace: "/chat" })
  class SharedChatGateway {
    @SubscribeMessage("who")
    who() {
      return { event: "who", data: "shared-chat" };
    }
  }

  @WebSocketGateway(gatewayPort, { namespace: "/chat" })
  class PortChatGateway {
    @SubscribeMessage("who")
    who() {
      return { event: "who", data: "port-chat" };
    }
  }

  @Module({
    providers: [SharedGateway, PortGateway, SharedChatGateway, PortChatGateway],
  })
  class AppModule {}

  httpAdapter = new BunHttpAdapter(30000);
  app = await NestFactory.create(AppModule, httpAdapter, {
    logger: false,
  });
  app.useWebSocketAdapter(httpAdapter.webSocketAdapter);
  await app.listen(0);
});

afterAll(async () => {
  await app?.close();
});

/** Asks `client` who answers, and resolves every answer within a short window. */
async function whoAnswers(client: WsTestClient): Promise<string[]> {
  client.send({ type: EVENT, namespace: "/", data: ["who", null] });
  await client.waitFor((m) => m?.data?.[0] === "who");
  // Give a second gateway, if one wrongly handled the client, time to answer.
  await Bun.sleep(100);
  return client.received
    .map((raw) => JSON.parse(raw))
    .filter((m) => m?.data?.[0] === "who")
    .map((m) => String(m.data[1]))
    .sort();
}

describe("NestJS gateway ports", () => {
  it("keeps a client of the HTTP server to the port-0 gateway", async () => {
    const before = { ...connections };
    const client = await connectWs(
      `ws://127.0.0.1:${httpAdapter.listeningPort}/`,
    );

    expect(await whoAnswers(client)).toEqual(["shared"]);
    expect(connections.shared).toBe((before.shared ?? 0) + 1);
    expect(connections.port ?? 0).toBe(before.port ?? 0);
    await client.close();
  });

  it("keeps a client of the gateway's own port to that gateway", async () => {
    const before = { ...connections };
    const client = await connectWs(`ws://127.0.0.1:${gatewayPort}/`);

    expect(await whoAnswers(client)).toEqual(["port"]);
    expect(connections.port).toBe((before.port ?? 0) + 1);
    expect(connections.shared ?? 0).toBe(before.shared ?? 0);
    await client.close();
  });

  it("separates same-namespace gateways on different ports", async () => {
    const shared = await connectWs(
      `ws://127.0.0.1:${httpAdapter.listeningPort}/chat`,
    );
    const own = await connectWs(`ws://127.0.0.1:${gatewayPort}/chat`);

    expect(await whoAnswers(shared)).toEqual(["shared-chat"]);
    expect(await whoAnswers(own)).toEqual(["port-chat"]);
    await shared.close();
    await own.close();
  });
});
