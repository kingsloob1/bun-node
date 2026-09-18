/**
 * `onUpgrade` and the upgrade layers under a real NestJS gateway: the
 * `BunWebSocketAdapter` handed to `app.useWebSocketAdapter()` carries an
 * instance-wide `onUpgrade`, and the HTTP adapter carries router-wide
 * `webSocketUpgradeHeaders`/`webSocketUpgradeData`. A gateway registers its
 * upgrade route through the app's router, so both must reach its 101 and its
 * connections' `ws.data`. `wsOnUpgrade.test.ts` checks the same through
 * `router.ws()` directly; this is the path NestJS actually drives.
 *
 * `reflect-metadata` is imported last per the import-sort rule; it still
 * executes before any decorator does.
 */
import type { WebSocketClient } from "@kingsleyweb/bun-common";
import type { INestApplication } from "@nestjs/common";
import type { OnGatewayConnection } from "@nestjs/websockets";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WebSocketGateway } from "@nestjs/websockets";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  negotiatedProtocol,
  rawUpgrade,
} from "../../bun-common/__tests__/helpers";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunWebSocketAdapter } from "../lib/BunWebSocketAdapter";
import "reflect-metadata";

/** The subprotocol the hook picks from the client's offer. */
const PROTOCOL = "bun-jobs.v1";
/** An offer that puts another protocol first, which Bun echoes by default. */
const OFFER = ["other", PROTOCOL];

/** `ws.data` of every connection the gateway saw, in order. */
const seen: WebSocketClient["data"][] = [];

@WebSocketGateway({ namespace: "/live" })
class LiveGateway implements OnGatewayConnection {
  handleConnection(client: WebSocketClient) {
    seen.push(client.data);
  }
}

@Module({ providers: [LiveGateway] })
class AppModule {}

let app: INestApplication;
let port = 0;

beforeAll(async () => {
  const httpAdapter = new BunHttpAdapter(0);
  httpAdapter
    .setWebSocketUpgradeHeaders({
      "Sec-WebSocket-Protocol": "other",
      "X-Trace": "trace-1",
    })
    .setWebSocketUpgradeData({ hash: "#router", custom: "router" });
  app = await NestFactory.create(AppModule, httpAdapter as never, {
    logger: false,
  });
  app.useWebSocketAdapter(
    new BunWebSocketAdapter({
      httpAdapter,
      localOptions: {
        newInstance: false,
        getServer: () => httpAdapter.getBunServer(),
        onUpgrade: (req) => ({
          custom: { tenant: req.query.tenant },
          headers: { "Sec-WebSocket-Protocol": PROTOCOL },
        }),
      },
    }) as never,
  );
  await app.listen(0);
  port = Number(httpAdapter.listeningPort);
});

afterAll(async () => {
  await app?.close();
});

describe("a NestJS gateway: onUpgrade and the router-wide layers", () => {
  it("the 101 carries the router's headers, with the hook's subprotocol winning per name", async () => {
    const head = await rawUpgrade(port, "/live", OFFER);
    expect(head.statusLine).toBe("HTTP/1.1 101 Switching Protocols");
    const protocols = head.headers.filter(
      ([name]) => name === "sec-websocket-protocol",
    );
    expect(protocols).toEqual([["sec-websocket-protocol", PROTOCOL]]);
    expect(
      head.headers.filter(([name]) => name === "x-trace").map(([, v]) => v),
    ).toEqual(["trace-1"]);
    expect(await negotiatedProtocol(`ws://127.0.0.1:${port}/live`, OFFER)).toBe(
      PROTOCOL,
    );
  });

  it("the gateway's client carries the hook's custom over the router's data", async () => {
    const before = seen.length;
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/live?tenant=acme`,
      OFFER,
    );
    await new Promise<void>((resolve, reject) => {
      client.addEventListener("open", () => resolve(), { once: true });
      client.addEventListener("error", () => reject(new Error("no upgrade")), {
        once: true,
      });
    });
    try {
      const deadline = Date.now() + 2000;
      while (seen.length === before) {
        if (Date.now() > deadline) {
          throw new Error("the gateway saw no connection");
        }
        await Bun.sleep(5);
      }
      const data = seen[seen.length - 1];
      expect(data?.custom).toEqual({ tenant: "acme" });
      expect(data?.hash).toBe("#router");
      expect(data?.route).toBe("/live");
    } finally {
      client.close();
    }
  });
});
