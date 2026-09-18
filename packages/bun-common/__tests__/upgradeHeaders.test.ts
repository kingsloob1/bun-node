/**
 * `res.upgradeToWebsocket(data, { headers })`: headers for the `101`.
 *
 * Every server that performs an upgrade — the adapter's, a standalone
 * `BunWebSocket` server's, and an instance swapped in after `listen()` — must
 * pass them to `server.upgrade`, and must send nothing extra without them.
 * The 101 is read off a raw TCP socket, since a `WebSocket` client exposes
 * only the negotiated protocol.
 */
import type { RawResponseHead } from "./helpers";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { BunWebSocket } from "../lib/BunWebSocket";
import { createTestLogger } from "../lib/logging";
import { makeResponse, negotiatedProtocol, rawUpgrade } from "./helpers";

/** The subprotocol a server picks from the client's offer. */
const PROTOCOL = "bun-jobs.v1";
/** An offer that puts another protocol first, which Bun echoes by default. */
const OFFER = ["other", PROTOCOL];

/** The values of every `name` header in `head`, in wire order. */
function values(head: RawResponseHead, name: string): string[] {
  return head.headers.filter(([key]) => key === name).map(([, v]) => v);
}

/**
 * Registers the three routes every suite below serves on `router`:
 * `/proto` picks {@link PROTOCOL}, `/custom` adds `X-Test`, and `/plain`
 * upgrades with no options after setting a header on `res` the ordinary way,
 * which must not reach the 101.
 */
function registerRoutes(router: Pick<BunRouter, "get">) {
  router.get("/proto", (_req, res) => {
    return res.upgradeToWebsocket(undefined, {
      headers: { "Sec-WebSocket-Protocol": PROTOCOL },
    });
  });
  router.get("/custom", (_req, res) => {
    return res.upgradeToWebsocket(undefined, {
      headers: new Headers([["X-Test", "yes"]]),
    });
  });
  router.get("/plain", (_req, res) => {
    res.setHeader("X-Not-Forwarded", "1");
    return res.upgradeToWebsocket();
  });
}

/** The header names a plain Bun upgrade writes, in wire order. */
const BUN_DEFAULT_101 = [
  "upgrade",
  "connection",
  "sec-websocket-accept",
  "sec-websocket-protocol",
  "date",
];

/**
 * The three tests every server below must pass, as one suite: `start` brings
 * the server up with {@link registerRoutes} applied and returns its port and a
 * function that stops it.
 */
function describeUpgradeHeaders(
  name: string,
  start: () => Promise<{ port: number; stop: () => Promise<void> | void }>,
) {
  describe(`upgrade headers: ${name}`, () => {
    let port = 0;
    let stop: () => Promise<void> | void = () => {};
    beforeAll(async () => {
      ({ port, stop } = await start());
    });
    afterAll(async () => {
      await stop();
    });

    it("a supplied Sec-WebSocket-Protocol replaces Bun's echo of the first offer", async () => {
      expect(
        await negotiatedProtocol(`ws://127.0.0.1:${port}/proto`, OFFER),
      ).toBe(PROTOCOL);
      const head = await rawUpgrade(port, "/proto", OFFER);
      expect(head.statusLine).toBe("HTTP/1.1 101 Switching Protocols");
      // Exactly one, not the echo beside the supplied value.
      expect(values(head, "sec-websocket-protocol")).toEqual([PROTOCOL]);
    });

    it("a custom header reaches the 101", async () => {
      const head = await rawUpgrade(port, "/custom");
      expect(head.statusLine).toBe("HTTP/1.1 101 Switching Protocols");
      expect(values(head, "x-test")).toEqual(["yes"]);
    });

    it("without options the 101 is Bun's own, and a header set on res stays off it", async () => {
      expect(
        await negotiatedProtocol(`ws://127.0.0.1:${port}/plain`, OFFER),
      ).toBe("other");
      const head = await rawUpgrade(port, "/plain", OFFER);
      expect(head.statusLine).toBe("HTTP/1.1 101 Switching Protocols");
      expect(head.headers.map(([header]) => header)).toEqual(BUN_DEFAULT_101);
      expect(values(head, "sec-websocket-protocol")).toEqual(["other"]);
    });
  });
}

describe("BunResponse.upgradeToWebsocket options", () => {
  it("records the headers it is given", async () => {
    const res = await makeResponse();
    res.upgradeToWebsocket(undefined, { headers: { "X-Test": "yes" } });
    expect(res.upgradeToWsHeaders).toBeInstanceOf(Headers);
    expect(res.upgradeToWsHeaders?.get("x-test")).toBe("yes");
    // The data is still built from the request.
    expect(res.upgradeToWsData?.path).toBe("/");
  });

  it("has no headers without options, or with an empty set", async () => {
    const res = await makeResponse();
    expect(res.upgradeToWsHeaders).toBeUndefined();
    res.upgradeToWebsocket();
    expect(res.upgradeToWsHeaders).toBeUndefined();
    res.upgradeToWebsocket(undefined, {});
    expect(res.upgradeToWsHeaders).toBeUndefined();
    res.upgradeToWebsocket(undefined, { headers: {} });
    expect(res.upgradeToWsHeaders).toBeUndefined();
    res.upgradeToWebsocket(undefined, { headers: [] });
    expect(res.upgradeToWsHeaders).toBeUndefined();
  });

  it("replaces the headers of an earlier call", async () => {
    const res = await makeResponse();
    res.upgradeToWebsocket(undefined, { headers: { "X-Test": "yes" } });
    res.upgradeToWebsocket();
    expect(res.upgradeToWsHeaders).toBeUndefined();
  });

  it("does not take headers set on the response the ordinary way", async () => {
    const res = await makeResponse();
    res.setHeader("X-Elsewhere", "1");
    res.upgradeToWebsocket(undefined, { headers: { "X-Test": "yes" } });
    expect([...(res.upgradeToWsHeaders?.keys() ?? [])]).toEqual(["x-test"]);
  });
});

describeUpgradeHeaders("bun-common BunHttpAdapter", async () => {
  const adapter = new BunHttpAdapter(0, {
    logger: createTestLogger().logger,
  });
  registerRoutes(adapter);
  const server = await adapter.listen(0);
  return { port: Number(server.port), stop: () => adapter.close() };
});

describeUpgradeHeaders("a standalone BunWebSocket server", async () => {
  const router = new BunRouter();
  registerRoutes(router);
  const ws = new BunWebSocket({
    newInstance: true,
    router,
    listen: { port: 0 },
  });
  return {
    port: Number(ws.port),
    stop: () => {
      ws.killServer(ws.getServer());
    },
  };
});

describeUpgradeHeaders("a BunWebSocket attached after listen()", async () => {
  const adapter = new BunHttpAdapter(0, {
    logger: createTestLogger().logger,
  });
  const server = await adapter.listen(0);
  // Swapped in after the server is up, the way NestJS's
  // `useWebSocketAdapter()` takes over; its routes register on the adapter.
  const swapped = new BunWebSocket({
    newInstance: false,
    router: adapter,
    getServer: () => adapter.getBunServer(),
  });
  if (adapter.getBunWebsocket() !== swapped) {
    throw new Error("the BunWebSocket was not swapped in");
  }
  registerRoutes(adapter);
  return { port: Number(server.port), stop: () => adapter.close() };
});
