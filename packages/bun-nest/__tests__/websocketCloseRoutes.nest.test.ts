/**
 * After `app.close()`, a gateway's upgrade route is gone: an upgrade request
 * to its path on a server that outlives the application is not upgraded, as
 * `@nestjs/platform-ws` removes its `upgrade` listener on dispose (Nest
 * 12.0.2, 9847b5443). Measured before the fix by
 * `docs/plans/nestjs-12-parity/evidence/lifecycle-spike/probe-9847b5443.ts`:
 * the upgrade still got `101` and opened a socket no gateway was bound to.
 *
 * - a server the application does not own (the probe's case);
 * - the HTTP adapter's own server, listening again after `app.close()`;
 * - another handler on the same path is left registered;
 * - a new application on the same server and adapter serves the gateway
 *   again.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other gateway test files.
 */
import type { INestApplication } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  BunWebSocketAdapter,
  MessageEventTypes,
} from "../lib/BunWebSocketAdapter";
import { connectWs } from "./helpers";
import "reflect-metadata";

const EVENT = MessageEventTypes.EVENT;

@WebSocketGateway({ path: "/live" })
class LiveGateway {
  @SubscribeMessage("ping")
  ping() {
    return { event: "pong", data: "live" };
  }
}

@Module({ providers: [LiveGateway] })
class LiveModule {}

/** Applications and adapters to close after each test, last first. */
const toClose: { close: () => Promise<unknown> }[] = [];

afterEach(async () => {
  while (toClose.length) {
    await toClose.pop()?.close();
  }
});

/** The status of a WebSocket upgrade request to `url` (`101` when upgraded). */
async function upgradeStatus(url: string): Promise<number> {
  const response = await fetch(url, {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
    },
  });
  return response.status;
}

/** Connects to `url`, pings the gateway and resolves its reply. */
async function ping(url: string): Promise<unknown> {
  const client = await connectWs(url);
  try {
    client.send({ type: EVENT, namespace: "/", data: ["ping", null] });
    const reply = await client.waitFor((m) => m?.data?.[0] === "pong");
    return reply.data[1];
  } finally {
    await client.close();
  }
}

/** A listening adapter the applications under test ride on but do not own. */
async function startOwner() {
  const owner = new BunHttpAdapter();
  await owner.listen(0);
  toClose.push(owner);
  return owner;
}

/** A gateway adapter on `owner`'s server, as the probe builds it. */
function adapterOn(owner: BunHttpAdapter) {
  return new BunWebSocketAdapter({
    httpAdapter: owner,
    localOptions: { newInstance: false, getServer: () => owner.getBunServer() },
  });
}

/** An initialised application whose gateways ride on `adapter`. */
async function startApp(
  adapter: BunWebSocketAdapter,
): Promise<INestApplication> {
  const app = await NestFactory.create(LiveModule, new BunHttpAdapter(), {
    logger: false,
  });
  app.useWebSocketAdapter(adapter);
  await app.init();
  return app;
}

describe("app.close(): gateway routes on a server the app does not own", () => {
  it("no longer upgrades to the closed gateway's path", async () => {
    const owner = await startOwner();
    const app = await startApp(adapterOn(owner));
    const base = `127.0.0.1:${owner.getBunServer()?.port}`;

    expect(await ping(`ws://${base}/live`)).toBe("live");
    expect(await upgradeStatus(`http://${base}/live`)).toBe(101);

    await app.close();

    expect(await upgradeStatus(`http://${base}/live`)).toBe(404);
    await expect(connectWs(`ws://${base}/live`)).rejects.toThrow();
  });

  it("leaves another handler on the same path registered", async () => {
    const owner = await startOwner();
    const adapter = adapterOn(owner);
    const seen: string[] = [];
    // Registered on the adapter (the owner's router now names it), beside
    // the gateway's own handler for the same pattern.
    owner.instance.ws("/live", {
      open: (ws) => {
        seen.push("own");
        ws.send("own");
      },
      message: () => {},
    });
    const app = await startApp(adapter);
    const base = `127.0.0.1:${owner.getBunServer()?.port}`;

    await app.close();

    const client = await connectWs(`ws://${base}/live`);
    await client.waitFor((m) => m === "own");
    await client.close();
    expect(seen).toEqual(["own"]);
  });

  it("serves the gateway again for a new app on the same server and adapter", async () => {
    const owner = await startOwner();
    const adapter = adapterOn(owner);
    const base = `127.0.0.1:${owner.getBunServer()?.port}`;

    const first = await startApp(adapter);
    await first.close();
    expect(await upgradeStatus(`http://${base}/live`)).toBe(404);

    const second = await startApp(adapter);
    toClose.push(second);
    expect(await ping(`ws://${base}/live`)).toBe("live");
  });
});

describe("app.close(): gateway routes on the app's own server", () => {
  it("no longer upgrades once the HTTP adapter listens again", async () => {
    const httpAdapter = new BunHttpAdapter();
    const app = await NestFactory.create(LiveModule, httpAdapter, {
      logger: false,
    });
    app.useWebSocketAdapter(httpAdapter.webSocketAdapter);
    // The gateway is created during init, before the server listens, so
    // NestJS never calls `close(server)` for it: `dispose()` unregisters it.
    await app.listen(0);
    const before = `127.0.0.1:${httpAdapter.listeningPort}`;
    expect(await ping(`ws://${before}/live`)).toBe("live");

    await app.close();
    await httpAdapter.listen(0);
    toClose.push(httpAdapter);
    const after = `127.0.0.1:${httpAdapter.listeningPort}`;

    expect(await upgradeStatus(`http://${after}/live`)).toBe(404);
  });
});
