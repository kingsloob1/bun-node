/**
 * The security-oriented client address beside the Express-exact `req.ip`
 * (bun-node#787): `normalizeIpAddress` and `formatIpAddress`,
 * `req.clientAddress` and `resolveClientAddress`'s `clientAddress`,
 * `clientEntry` and `truncated`, and the `maxForwardedHops` bound on the
 * request, the router, the adapter and a dedicated WebSocket server.
 *
 * Every case that changes what the security view says also asserts that
 * `req.ip` and `req.ips` still say what Express says: the addition must not
 * move them.
 */
import type { BunServer } from "../lib/types/general";
import { afterEach, describe, expect, it } from "bun:test";
import {
  compileTrustProxy,
  formatIpAddress,
  normalizeIpAddress,
  parseForwardedFor,
  parseIpAddress,
  proxyAddressChain,
  resolveClientAddress,
} from "../lib";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest } from "../lib/BunRequest";
import { BunRouter } from "../lib/BunRouter";
import { makeRequest, peerServer } from "./helpers";

/** An adapter that serves a request with a socket peer of the test's choosing. */
class PeerAdapter extends BunHttpAdapter {
  /** Serves `request` with `peer` as the socket address. */
  async serveFrom(request: Request, peer: string): Promise<Response> {
    const response = await this.serveNativeRequest(
      request,
      peerServer(peer) as unknown as BunServer<never>,
    );
    if (!response) {
      throw new Error("no response");
    }
    return response;
  }
}

/** `count` X-Forwarded-For entries, `198.51.100.0` farthest. */
function hops(count: number): string {
  return Array.from({ length: count }, (_, i) => `198.51.100.${i}`).join(", ");
}

describe("normalizeIpAddress and formatIpAddress", () => {
  it("writes each address one way: IPv4-mapped as IPv4, legacy IPv4 dotted, IPv6 per RFC 5952 without a zone", () => {
    const cases: [string, string][] = [
      ["203.0.113.9", "203.0.113.9"],
      ["::ffff:203.0.113.9", "203.0.113.9"],
      ["::FFFF:cb00:7109", "203.0.113.9"],
      ["0xcb.0.113.9", "203.0.113.9"],
      ["3405803785", "203.0.113.9"],
      ["2001:DB8:0:0:0:0:0:1", "2001:db8::1"],
      ["2001:0db8::0001", "2001:db8::1"],
      ["fe80::1%eth0", "fe80::1"],
      // The longest run of zero groups is the one written `::`...
      ["2001:db8:0:0:1:0:0:0", "2001:db8:0:0:1::"],
      // ...the first on a tie...
      ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
      // ...and a lone zero group is never shortened.
      ["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
      ["::", "::"],
      ["::1", "::1"],
    ];
    expect(cases.map(([input]) => [input, normalizeIpAddress(input)])).toEqual(
      cases,
    );
  });

  it("is null for anything that is not an address", () => {
    for (const value of [
      "",
      "not-an-ip",
      "example.com",
      "1.2.3.4.5",
      "256.0.0.1",
      "2001:db8::1::2",
      undefined,
      null,
      42,
    ]) {
      expect({ value, normalized: normalizeIpAddress(value) }).toEqual({
        value,
        normalized: null,
      });
    }
  });

  it("formatIpAddress keeps a mapped address IPv6: the conversion is normalizeIpAddress's", () => {
    const mapped = parseIpAddress("::ffff:203.0.113.9");
    expect(mapped).not.toBeNull();
    expect(formatIpAddress(mapped!)).toBe("::ffff:cb00:7109");
  });
});

describe("the issue's reproduction (bun-node#787)", () => {
  /** A router answering `ip`, `ips` and `clientAddress`. */
  function router(options?: ConstructorParameters<typeof BunRouter>[0]) {
    const app = new BunRouter(options);
    app.get("/ip", (req, res) =>
      res.json({
        ip: req.ip,
        ips: req.ips,
        clientAddress: req.clientAddress,
      }),
    );
    return app;
  }
  /** What `/ip` answers for this init. */
  async function read(
    app: BunRouter,
    init: Parameters<BunRouter["fetch"]>[1],
  ): Promise<{ ip: string; ips: string[]; clientAddress: string }> {
    return (await (await app.fetch("/ip", init)).json()) as {
      ip: string;
      ips: string[];
      clientAddress: string;
    };
  }

  it("a malformed X-Forwarded-For entry is still req.ip, and never the client address", async () => {
    expect(
      await read(router({ trustProxy: true }), {
        headers: { "x-forwarded-for": "not-an-ip, 203.0.113.5" },
        remoteAddress: "10.0.0.1",
      }),
    ).toEqual({
      ip: "not-an-ip",
      ips: ["not-an-ip", "203.0.113.5"],
      clientAddress: "203.0.113.5",
    });
  });

  it("a 40-hop header is walked in full by default, as Express; maxForwardedHops bounds it", async () => {
    const init = {
      headers: { "x-forwarded-for": hops(40) },
      remoteAddress: "10.0.0.1",
    };
    const unbounded = await read(router({ trustProxy: true }), init);
    expect(unbounded.ips).toHaveLength(40);
    expect(unbounded.ip).toBe("198.51.100.0");
    expect(unbounded.clientAddress).toBe("198.51.100.0");
    const bounded = await read(
      router({ trustProxy: true, maxForwardedHops: 32 }),
      init,
    );
    expect(bounded.ips).toHaveLength(32);
    // The 32 closest: the farthest read is entry 8 of 0–39.
    expect(bounded.ip).toBe("198.51.100.8");
    expect(bounded.clientAddress).toBe("198.51.100.8");
  });

  it("an IPv4-mapped peer stays mapped in req.ip, and is IPv4 in req.clientAddress", async () => {
    expect(
      await read(router(), { remoteAddress: "::ffff:203.0.113.9" }),
    ).toEqual({
      ip: "::ffff:203.0.113.9",
      ips: [],
      clientAddress: "203.0.113.9",
    });
  });
});

describe("req.clientAddress", () => {
  it("with trust off, is the peer normalised; '' with no peer", async () => {
    expect((await makeRequest({ peer: "::ffff:10.0.0.1" })).clientAddress).toBe(
      "10.0.0.1",
    );
    expect((await makeRequest({ peer: "2001:DB8::0:1" })).clientAddress).toBe(
      "2001:db8::1",
    );
    const none = await makeRequest({ peer: null });
    expect(none.ip).toBe("");
    expect(none.clientAddress).toBe("");
  });

  it("is the same client as req.ip when that is an address, through a trusted chain", async () => {
    const req = await makeRequest({
      peer: "::ffff:10.0.0.1",
      headers: { "X-Forwarded-For": "spoof, ::FFFF:203.0.113.5" },
      options: { trustProxy: "10.0.0.0/8" },
    });
    expect(req.ip).toBe("::FFFF:203.0.113.5");
    expect(req.clientAddress).toBe("203.0.113.5");
  });

  it("falls back to the last trusted hop when the walk ends on garbage, and to the peer when that is all there is", async () => {
    const throughTwo = await makeRequest({
      peer: "10.0.0.1",
      headers: { "X-Forwarded-For": "garbage, 10.0.0.7" },
      options: { trustProxy: 2 },
    });
    expect(throughTwo.ip).toBe("garbage");
    expect(throughTwo.clientAddress).toBe("10.0.0.7");
    const direct = await makeRequest({
      peer: "198.51.100.4",
      headers: { "X-Forwarded-For": "<script>" },
      options: { trustProxy: true },
    });
    expect(direct.ip).toBe("<script>");
    expect(direct.clientAddress).toBe("198.51.100.4");
  });

  it("is '' when no entry of the chain is an address", async () => {
    const req = await makeRequest({
      peer: null,
      headers: { "X-Forwarded-For": "unknown" },
      options: { trustProxy: true },
    });
    expect(req.ip).toBe("unknown");
    expect(req.clientAddress).toBe("");
  });

  it("is the clientIpHeader value, normalised, when that was believed", async () => {
    const req = await makeRequest({
      peer: "10.0.0.1",
      headers: { "cf-connecting-ip": "::ffff:198.51.100.23" },
      options: { trustProxy: true, clientIpHeader: "cf-connecting-ip" },
    });
    expect(req.ip).toBe("::ffff:198.51.100.23");
    expect(req.clientAddress).toBe("198.51.100.23");
  });

  it("shares the one walk with ip, ips and proxyChain", async () => {
    let calls = 0;
    const inner = compileTrustProxy("10.0.0.0/8");
    const trust = (addr: string, i: number) => {
      calls++;
      return inner(addr, i);
    };
    const req = await BunRequest.init(
      new Request("http://origin.test/", {
        headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.7" },
      }),
      peerServer("10.0.0.4"),
      { parseBody: false, trustProxy: trust },
    );
    expect(req.ip).toBe("203.0.113.9");
    const oneWalk = calls;
    for (let read = 0; read < 3; read++) {
      expect(req.clientAddress).toBe("203.0.113.9");
      expect(req.ips).toEqual(["203.0.113.9", "10.0.0.7"]);
    }
    expect(calls).toBe(oneWalk);
  });
});

describe("resolveClientAddress: clientAddress, clientEntry and truncated", () => {
  const trustAll = compileTrustProxy(true);

  it("names the chain entry the client address came from", () => {
    const fine = resolveClientAddress({
      peer: "10.0.0.1",
      forwardedFor: "203.0.113.5",
      trust: compileTrustProxy("10.0.0.0/8"),
    });
    expect(fine.clientAddress).toBe("203.0.113.5");
    expect(fine.clientEntry).toBe(fine.chain[1]);
    expect(fine.clientEntry?.source).toBe("x-forwarded-for");

    const fallback = resolveClientAddress({
      peer: "10.0.0.1",
      forwardedFor: "bogus",
      trust: trustAll,
    });
    expect(fallback.ip).toBe("bogus");
    expect(fallback.clientAddress).toBe("10.0.0.1");
    expect(fallback.clientEntry).toBe(fallback.chain[0]);
    expect(fallback.clientEntry?.source).toBe("socket");

    const header = resolveClientAddress({
      peer: "10.0.0.1",
      forwardedFor: null,
      trust: trustAll,
      clientIpHeaderValue: "198.51.100.23",
    });
    expect(header.clientEntry?.source).toBe("header");
    expect(header.clientAddress).toBe("198.51.100.23");

    const nothing = resolveClientAddress({
      peer: "",
      forwardedFor: "x",
      trust: trustAll,
    });
    expect(nothing.clientAddress).toBe("");
    expect(nothing.clientEntry).toBeUndefined();
  });

  it("says when the bound left entries unread, and not when the walk stopped first", () => {
    const bounded = resolveClientAddress({
      peer: "10.0.0.1",
      forwardedFor: hops(5),
      trust: trustAll,
      maxForwardedHops: 3,
    });
    expect(bounded.ips).toEqual([
      "198.51.100.2",
      "198.51.100.3",
      "198.51.100.4",
    ]);
    expect(bounded.truncated).toBe(true);
    // Exactly as many entries as the bound: nothing left unread.
    expect(
      resolveClientAddress({
        peer: "10.0.0.1",
        forwardedFor: hops(3),
        trust: trustAll,
        maxForwardedHops: 3,
      }).truncated,
    ).toBe(false);
    // A walk that stops at an untrusted hop never reaches the bound.
    expect(
      resolveClientAddress({
        peer: "10.0.0.1",
        forwardedFor: hops(5),
        trust: compileTrustProxy(1),
        maxForwardedHops: 3,
      }),
    ).toMatchObject({ ip: "198.51.100.4", truncated: false });
    // Without a bound, never truncated.
    expect(
      resolveClientAddress({
        peer: "10.0.0.1",
        forwardedFor: hops(40),
        trust: trustAll,
      }).truncated,
    ).toBe(false);
  });

  it("0 reads no entry; Infinity reads them all", () => {
    expect(
      resolveClientAddress({
        peer: "10.0.0.1",
        forwardedFor: "203.0.113.5",
        trust: trustAll,
        maxForwardedHops: 0,
      }),
    ).toMatchObject({
      ip: "10.0.0.1",
      ips: [],
      clientAddress: "10.0.0.1",
      truncated: true,
    });
    expect(
      resolveClientAddress({
        peer: "10.0.0.1",
        forwardedFor: hops(40),
        trust: trustAll,
        maxForwardedHops: Number.POSITIVE_INFINITY,
      }).ips,
    ).toHaveLength(40);
  });

  it("refuses a bound that is not a whole number from 0 up", () => {
    for (const bad of [-1, 1.5, Number.NaN, "3" as unknown as number]) {
      expect(() =>
        resolveClientAddress({
          peer: "10.0.0.1",
          forwardedFor: "203.0.113.5",
          trust: trustAll,
          maxForwardedHops: bad,
        }),
      ).toThrow(TypeError);
    }
  });

  it("parseForwardedFor and proxyAddressChain take the same bound, closest entries kept", () => {
    expect(parseForwardedFor("a, b, c, d", 2)).toEqual(["d", "c"]);
    expect(parseForwardedFor(" , a ,, b ", 5)).toEqual(["b", "a"]);
    expect(parseForwardedFor("a, b", 0)).toEqual([]);
    expect(
      proxyAddressChain("p", "a, b, c", compileTrustProxy(true), 2),
    ).toEqual(["p", "c", "b"]);
    // Unbounded, unchanged.
    expect(parseForwardedFor("a, b, c")).toEqual(["c", "b", "a"]);
  });
});

describe("maxForwardedHops on the router and the adapters", () => {
  let app: BunHttpAdapter | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("the router takes it, checks it at construction and applies it to its fetch()", async () => {
    expect(new BunRouter().maxForwardedHops).toBeUndefined();
    expect(() => new BunRouter({ maxForwardedHops: -1 })).toThrow(TypeError);
    const router = new BunRouter({ trustProxy: true, maxForwardedHops: 2 });
    expect(router.maxForwardedHops).toBe(2);
    router.get("/ip", (req, res) => res.json({ ips: req.ips }));
    const answer = await router.fetch("/ip", {
      headers: { "x-forwarded-for": hops(10) },
      remoteAddress: "10.0.0.1",
    });
    expect(await answer.json()).toEqual({
      ips: ["198.51.100.8", "198.51.100.9"],
    });
  });

  it("an adapter's top-level option wins over router and request; a bad one throws", () => {
    const top = new BunHttpAdapter(0, {
      trustProxy: true,
      maxForwardedHops: 2,
      router: { maxForwardedHops: 5 },
      request: { maxForwardedHops: 7 },
      logger: () => {},
    });
    expect(top.maxForwardedHops).toBe(2);
    expect(top.requestOpts.maxForwardedHops).toBe(2);
    // Replacing the request options keeps the adapter's bound.
    top.setRequestOpts({ parseBody: false, maxForwardedHops: 9 });
    expect(top.requestOpts.maxForwardedHops).toBe(2);
    expect(
      () => new BunHttpAdapter(0, { maxForwardedHops: 0.5, logger: () => {} }),
    ).toThrow(TypeError);
    expect(
      new BunHttpAdapter(0, { logger: () => {} }).requestOpts.maxForwardedHops,
    ).toBeUndefined();
  });

  it("an adapter takes request.maxForwardedHops, and its router's option wins over it", async () => {
    const fromRequest = new BunHttpAdapter(0, {
      trustProxy: true,
      request: { maxForwardedHops: 3 },
      logger: () => {},
    });
    expect(fromRequest.requestOpts.maxForwardedHops).toBe(3);
    const fromRouter = new PeerAdapter(0, {
      trustProxy: true,
      router: { maxForwardedHops: 1 },
      request: { maxForwardedHops: 3 },
      logger: () => {},
    });
    expect(fromRouter.requestOpts.maxForwardedHops).toBe(1);
    fromRouter.get("/ip", (req, res) =>
      res.json({ ips: req.ips, clientAddress: req.clientAddress }),
    );
    const response = await fromRouter.serveFrom(
      new Request("http://origin.test/ip", {
        headers: { "x-forwarded-for": hops(10) },
      }),
      "10.0.0.1",
    );
    expect(await response.json()).toEqual({
      ips: ["198.51.100.9"],
      clientAddress: "198.51.100.9",
    });
  });

  it("a WebSocket upgrade resolves its address under the bound too", async () => {
    app = new BunHttpAdapter(0, {
      trustProxy: "loopback",
      router: { maxForwardedHops: 1 },
      logger: () => {},
    });
    const seen = Promise.withResolvers<string | undefined>();
    app.ws("/live", {
      message() {},
      open(ws) {
        seen.resolve(ws.data.ip);
        ws.close();
      },
    });
    await app.listen(0, "127.0.0.1");
    const client = new WebSocket(`ws://127.0.0.1:${app.listeningPort}/live`, {
      headers: { "X-Forwarded-For": "203.0.113.9, 127.0.0.2" },
    });
    // Two entries, one read: the walk ends on 127.0.0.2, a trusted hop.
    expect(await seen.promise).toBe("127.0.0.2");
    client.close();
  });
});
