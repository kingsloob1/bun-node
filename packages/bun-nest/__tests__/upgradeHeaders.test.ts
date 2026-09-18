/**
 * `res.upgradeToWebsocket(data, { headers })` through bun-nest's adapter,
 * which performs the upgrade with its own `server.upgrade` call.
 *
 * The 101 is read off a raw TCP socket with bun-common's test helpers, since
 * a `WebSocket` client exposes only the negotiated protocol.
 */
import type { RawResponseHead } from "../../bun-common/__tests__/helpers";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  negotiatedProtocol,
  rawUpgrade,
} from "../../bun-common/__tests__/helpers";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";

/** The subprotocol the server picks from the client's offer. */
const PROTOCOL = "bun-jobs.v1";
/** An offer that puts another protocol first, which Bun echoes by default. */
const OFFER = ["other", PROTOCOL];

/** The values of every `name` header in `head`, in wire order. */
function values(head: RawResponseHead, name: string): string[] {
  return head.headers.filter(([key]) => key === name).map(([, v]) => v);
}

describe("BunHttpAdapter (nest): upgrade headers", () => {
  let adapter!: BunHttpAdapter;
  let port = 0;
  beforeAll(async () => {
    adapter = new BunHttpAdapter();
    adapter.get("/proto", (_req, res) => {
      return res.upgradeToWebsocket(undefined, {
        headers: { "Sec-WebSocket-Protocol": PROTOCOL },
      });
    });
    adapter.get("/custom", (_req, res) => {
      return res.upgradeToWebsocket(undefined, {
        headers: { "X-Test": "yes" },
      });
    });
    adapter.get("/plain", (_req, res) => {
      // Set the ordinary way, so it must stay off the 101.
      res.setHeader("X-Not-Forwarded", "1");
      return res.upgradeToWebsocket();
    });
    await adapter.listen(0);
    port = Number(adapter.listeningPort);
  });
  afterAll(async () => {
    await adapter.close();
  });

  it("a supplied Sec-WebSocket-Protocol replaces Bun's echo of the first offer", async () => {
    expect(
      await negotiatedProtocol(`ws://127.0.0.1:${port}/proto`, OFFER),
    ).toBe(PROTOCOL);
    const head = await rawUpgrade(port, "/proto", OFFER);
    expect(head.statusLine).toBe("HTTP/1.1 101 Switching Protocols");
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
    expect(head.headers.map(([name]) => name)).toEqual([
      "upgrade",
      "connection",
      "sec-websocket-accept",
      "sec-websocket-protocol",
      "date",
    ]);
    expect(values(head, "sec-websocket-protocol")).toEqual(["other"]);
  });
});
