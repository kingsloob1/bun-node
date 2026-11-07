/**
 * `trustProxy` and `clientIpHeader`: the platform helpers, the Cloudflare →
 * Railway → app chain worked through, spoofing attempts, IPv6, the adapter
 * and router options, socket-free `fetch()` and WebSocket upgrades. The
 * value-for-value comparison with Express 5 is bun-nest's
 * `trustProxy.express.test.ts`.
 */
import type { BunServer } from "../lib/types/general";
import { afterEach, describe, expect, it } from "bun:test";
import {
  behindCloudflare,
  behindRailway,
  CLOUDFLARE_IP_RANGES,
  CLOUDFLARE_IP_RANGES_DATE,
  compileIpMatcher,
  compileTrustProxy,
  fetchCloudflareIpRanges,
  isTrustProxyOff,
  parseForwardedFor,
  proxyAddressChain,
  resolveClientAddress,
  trustChain,
} from "../lib";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import type { MakeRequestInit } from "./helpers";
import { makeRequest, peerServer } from "./helpers";

/**
 * The Cloudflare → Railway → app chain, as each hop sees it.
 *
 * - The client, 198.51.100.23, connects to a Cloudflare edge.
 * - Cloudflare connects to Railway from 172.68.10.20 (in 172.64.0.0/13, one
 *   of its published ranges), with `CF-Connecting-IP: 198.51.100.23` and
 *   `X-Forwarded-For: 198.51.100.23` (Cloudflare appends the address that
 *   connected to it to whatever the client sent).
 * - Railway's edge (34.120.0.8 here; it rotates, with no published range)
 *   replaces `X-Forwarded-For` with `<its client>, <itself>`, as measured in
 *   November 2026, so Cloudflare's value is gone; it sets
 *   `X-Real-IP: 172.68.10.20` and `X-Forwarded-Proto: https`.
 * - Railway's proxy connects to the app from 100.64.0.7.
 */
const CHAIN = {
  client: "198.51.100.23",
  cloudflareEdge: "172.68.10.20",
  railwayEdge: "34.120.0.8",
  railwayProxy: "100.64.0.7",
};

/** The headers the app receives through the whole chain. */
const throughCloudflareAndRailway = {
  "X-Forwarded-For": `${CHAIN.cloudflareEdge}, ${CHAIN.railwayEdge}`,
  "CF-Connecting-IP": CHAIN.client,
  "X-Real-IP": CHAIN.cloudflareEdge,
  "X-Forwarded-Proto": "https",
  "X-Forwarded-Host": "app.example.com",
};

describe("compileTrustProxy", () => {
  it("compiles each Express value", () => {
    expect(compileTrustProxy(false)("127.0.0.1", 0)).toBe(false);
    expect(compileTrustProxy(true)("anything", 9)).toBe(true);
    const two = compileTrustProxy(2);
    expect([two("x", 0), two("x", 1), two("x", 2)]).toEqual([
      true,
      true,
      false,
    ]);
    const list = compileTrustProxy("loopback, 10.0.0.0/8");
    expect(list("127.0.0.5", 3)).toBe(true);
    expect(list("10.9.9.9", 0)).toBe(true);
    expect(list("11.0.0.1", 0)).toBe(false);
    expect(list("", 0)).toBe(false);
    const fn = (addr: string) => addr === "x";
    expect(compileTrustProxy(fn)).toBe(fn);
  });

  it("compiles a string, number or array once", () => {
    const list = ["10.0.0.0/8"];
    expect(compileTrustProxy(list)).toBe(compileTrustProxy(list));
    expect(compileTrustProxy("loopback")).toBe(compileTrustProxy("loopback"));
    expect(compileTrustProxy(3)).toBe(compileTrustProxy(3));
  });

  it("throws a TypeError for what proxy-addr refuses", () => {
    expect(() => compileTrustProxy("10.0.0.0/0")).toThrow(TypeError);
    expect(() => compileTrustProxy("example.com")).toThrow(
      "invalid IP address: example.com",
    );
    expect(() => compileTrustProxy({} as unknown as string)).toThrow(
      "unsupported trust argument",
    );
  });

  it("knows which values trust nothing", () => {
    for (const off of [undefined, null, false, 0, []]) {
      expect(isTrustProxyOff(off as never)).toBe(true);
    }
    for (const on of [true, 1, "loopback", ["::1"], () => false]) {
      expect(isTrustProxyOff(on)).toBe(false);
    }
  });
});

describe("parseForwardedFor and proxyAddressChain", () => {
  it("reads X-Forwarded-For right to left, as the forwarded package", () => {
    expect(parseForwardedFor(" a , ,b,c ")).toEqual(["c", "b", "a"]);
    expect(parseForwardedFor("")).toEqual([]);
    expect(parseForwardedFor(null)).toEqual([]);
  });

  it("stops after the first untrusted address", () => {
    const trust = compileTrustProxy("10.0.0.0/8");
    expect(
      proxyAddressChain("10.0.0.1", "1.1.1.1, 2.2.2.2, 10.0.0.2", trust),
    ).toEqual(["10.0.0.1", "10.0.0.2", "2.2.2.2"]);
    expect(proxyAddressChain("9.9.9.9", "1.1.1.1", trust)).toEqual(["9.9.9.9"]);
  });
});

describe("the Cloudflare → Railway → app chain", () => {
  async function at(
    options: MakeRequestInit["options"],
    headers: Record<string, string> = throughCloudflareAndRailway,
  ) {
    return makeRequest({ headers, peer: CHAIN.railwayProxy, options });
  }

  it("with trust off, req.ip is Railway's proxy and nothing forwarded is read", async () => {
    const req = await at({});
    expect(req.ip).toBe(CHAIN.railwayProxy);
    expect(req.ips).toEqual([]);
    expect(req.protocol).toBe("http");
    expect(req.hostname).not.toBe("app.example.com");
  });

  it("behindRailway({ cloudflare: true }) finds the client", async () => {
    const req = await at(behindRailway({ cloudflare: true }));
    expect(req.ip).toBe(CHAIN.client);
    expect(req.ips).toEqual([
      CHAIN.client,
      CHAIN.cloudflareEdge,
      CHAIN.railwayEdge,
    ]);
    expect(req.protocol).toBe("https");
    expect(req.hostname).toBe("app.example.com");
  });

  it("behindRailway() alone stops at Cloudflare's edge, which is Railway's client", async () => {
    const req = await at(behindRailway());
    expect(req.ip).toBe(CHAIN.cloudflareEdge);
  });

  it("a hop count alone with CF-Connecting-IP stops at Cloudflare's edge too", async () => {
    // Three hops trust every address, but the farthest is Cloudflare's edge
    // only by luck: nothing checks it, so the header could come from anyone.
    const req = await at({ trustProxy: 3, clientIpHeader: "cf-connecting-ip" });
    expect(req.ip).toBe(CHAIN.client);
    const direct = await at(
      { trustProxy: 3, clientIpHeader: "cf-connecting-ip" },
      {
        "X-Forwarded-For": `203.0.113.66, ${CHAIN.railwayEdge}`,
        "CF-Connecting-IP": "1.1.1.1",
      },
    );
    // The spoof works: a hop count cannot tell Cloudflare from anyone.
    expect(direct.ip).toBe("1.1.1.1");
  });

  it("a request sent to Railway directly cannot claim a client with CF-Connecting-IP", async () => {
    // Railway discards the attacker's X-Forwarded-For; the CF-Connecting-IP
    // it sent passes through untouched.
    const req = await at(behindRailway({ cloudflare: true }), {
      "X-Forwarded-For": `203.0.113.66, ${CHAIN.railwayEdge}`,
      "CF-Connecting-IP": "1.1.1.1",
      "X-Real-IP": "203.0.113.66",
    });
    expect(req.ip).toBe("203.0.113.66");
    expect(req.ips).toEqual(["203.0.113.66", CHAIN.railwayEdge]);
  });

  it("still finds the client if Railway kept Cloudflare's X-Forwarded-For", async () => {
    // Railway's staff described an appending edge in 2024: the client's own
    // entries survive. The walk stops at the first untrusted address.
    const req = await at(behindRailway({ cloudflare: true }), {
      "X-Forwarded-For": `6.6.6.6, ${CHAIN.client}, ${CHAIN.cloudflareEdge}, ${CHAIN.railwayEdge}`,
      "CF-Connecting-IP": CHAIN.client,
    });
    expect(req.ip).toBe(CHAIN.client);
  });

  it("ConcaveHR's setting, trustProxy: 2, reads the client second from the right", async () => {
    const headers = {
      "X-Forwarded-For": `${CHAIN.client}, ${CHAIN.railwayEdge}`,
    };
    const req = await at({ trustProxy: 2 }, headers);
    expect(req.ip).toBe(CHAIN.client);
    // The right-most entry rotates per request: keying on it is the bug.
    expect(req.ip).not.toBe(CHAIN.railwayEdge);
    // 100.64.0.0/10 is not in any proxy-addr preset.
    const presets = await at(
      { trustProxy: "loopback, linklocal, uniquelocal" },
      headers,
    );
    expect(presets.ip).toBe(CHAIN.railwayProxy);
  });
});

describe("behindCloudflare", () => {
  it("Cloudflare → app: the edge is the peer", async () => {
    const req = await makeRequest({
      peer: "162.158.1.2",
      headers: {
        "X-Forwarded-For": `6.6.6.6, ${CHAIN.client}`,
        "CF-Connecting-IP": CHAIN.client,
      },
      options: behindCloudflare(),
    });
    expect(req.ip).toBe(CHAIN.client);
  });

  it("over IPv6, and an IPv4-mapped peer, as written", async () => {
    const v6 = await makeRequest({
      peer: "2606:4700:10::6816:1",
      headers: { "CF-Connecting-IP": "2001:db8::77" },
      options: behindCloudflare(),
    });
    expect(v6.ip).toBe("2001:db8::77");
    const mapped = await makeRequest({
      peer: "::ffff:162.158.1.2",
      headers: { "CF-Connecting-IP": CHAIN.client },
      options: behindCloudflare(),
    });
    expect(mapped.ip).toBe(CHAIN.client);
  });

  it("a peer outside Cloudflare's ranges cannot set its own address", async () => {
    const req = await makeRequest({
      peer: "203.0.113.66",
      headers: { "CF-Connecting-IP": "1.1.1.1", "X-Forwarded-For": "1.1.1.1" },
      options: behindCloudflare(),
    });
    expect(req.ip).toBe("203.0.113.66");
    expect(req.ips).toEqual([]);
  });

  it("Cloudflare → nginx on the same host → app", async () => {
    const req = await makeRequest({
      peer: "127.0.0.1",
      headers: {
        "X-Forwarded-For": `${CHAIN.client}, 162.158.1.2`,
        "CF-Connecting-IP": CHAIN.client,
      },
      options: behindCloudflare({ via: ["loopback"] }),
    });
    expect(req.ip).toBe(CHAIN.client);
    // Through nginx without Cloudflare: the header is not believed.
    const bypass = await makeRequest({
      peer: "127.0.0.1",
      headers: {
        "X-Forwarded-For": "203.0.113.66",
        "CF-Connecting-IP": "1.1.1.1",
      },
      options: behindCloudflare({ via: ["loopback"] }),
    });
    expect(bypass.ip).toBe("203.0.113.66");
  });

  it("takes fresh ranges and the Enterprise header", async () => {
    const req = await makeRequest({
      peer: "192.0.2.10",
      headers: {
        "True-Client-IP": CHAIN.client,
        "CF-Connecting-IP": "1.1.1.1",
      },
      options: behindCloudflare({
        ranges: ["192.0.2.0/24"],
        header: "true-client-ip",
      }),
    });
    expect(req.ip).toBe(CHAIN.client);
  });

  it("ignores a header value that is not an address", async () => {
    const req = await makeRequest({
      peer: "162.158.1.2",
      headers: {
        "CF-Connecting-IP": "<script>",
        "X-Forwarded-For": CHAIN.client,
      },
      options: behindCloudflare(),
    });
    expect(req.ip).toBe(CHAIN.client);
  });

  it("ships a dated snapshot that compiles", () => {
    expect(CLOUDFLARE_IP_RANGES.length).toBe(22);
    expect(CLOUDFLARE_IP_RANGES_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const inRanges = compileIpMatcher(CLOUDFLARE_IP_RANGES);
    expect(inRanges(CHAIN.cloudflareEdge)).toBe(true);
    expect(inRanges(CHAIN.railwayEdge)).toBe(false);
  });
});

describe("spoofing traps", () => {
  it("trustProxy: true believes whatever the client sends", async () => {
    const req = await makeRequest({
      peer: "203.0.113.66",
      headers: { "X-Forwarded-For": "1.1.1.1", "X-Real-IP": "8.8.8.8" },
      options: { trustProxy: true, clientIpHeader: "x-real-ip" },
    });
    expect(req.ip).toBe("8.8.8.8");
    const xff = await makeRequest({
      peer: "203.0.113.66",
      headers: { "X-Forwarded-For": "1.1.1.1" },
      options: { trustProxy: true },
    });
    expect(xff.ip).toBe("1.1.1.1");
  });

  it("a clientIpHeader without trustProxy is never read", async () => {
    const req = await makeRequest({
      peer: "203.0.113.66",
      headers: { "X-Real-IP": "8.8.8.8" },
      options: { clientIpHeader: "x-real-ip" },
    });
    expect(req.ip).toBe("203.0.113.66");
  });

  it("an untrusted peer's X-Forwarded-Proto and X-Forwarded-Host are ignored", async () => {
    const req = await makeRequest({
      url: "http://origin.test/",
      peer: "203.0.113.66",
      headers: {
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "evil.test",
      },
      options: { trustProxy: "loopback" },
    });
    expect(req.protocol).toBe("http");
    expect(req.secure).toBe(false);
    expect(req.host).toBe("origin.test");
    expect(req.hostname).toBe("origin.test");
    expect(req.forwardedHost).toBeUndefined();
  });

  it("a trusted peer's forwarded host and proto are read, Express-style", async () => {
    const req = await makeRequest({
      url: "http://origin.test/",
      peer: "127.0.0.1",
      headers: {
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "App.test:8443 , b",
      },
      options: { trustProxy: "loopback" },
    });
    expect(req.protocol).toBe("https");
    expect(req.host).toBe("App.test:8443");
    expect(req.hostname).toBe("App.test");
  });
});

describe("the bun-security requirements (plan §20)", () => {
  it("walks from the socket leftwards: never the left-most entry", async () => {
    const req = await makeRequest({
      peer: "10.0.0.1",
      headers: { "X-Forwarded-For": "spoof, 203.0.113.5" },
      options: { trustProxy: "10.0.0.0/8" },
    });
    expect(req.ip).toBe("203.0.113.5");
    expect(req.ips).toEqual(["203.0.113.5"]);
  });

  it("matches an IPv4-mapped peer (a dual-stack listener's) against IPv4 ranges", async () => {
    const req = await makeRequest({
      peer: "::ffff:10.0.0.1",
      headers: { "X-Forwarded-For": "203.0.113.5" },
      options: { trustProxy: "10.0.0.0/8" },
    });
    expect(req.ip).toBe("203.0.113.5");
    // Untrusted, the peer is returned as written, as Express returns it.
    const off = await makeRequest({ peer: "::ffff:10.0.0.1" });
    expect(off.ip).toBe("::ffff:10.0.0.1");
  });

  it("exposes the resolution chain, read-only", async () => {
    const req = await makeRequest({
      peer: CHAIN.railwayProxy,
      headers: throughCloudflareAndRailway,
      options: behindRailway({ cloudflare: true }),
    });
    expect(req.proxyChain).toEqual([
      { address: CHAIN.railwayProxy, source: "socket", trusted: true },
      { address: CHAIN.railwayEdge, source: "x-forwarded-for", trusted: true },
      {
        address: CHAIN.cloudflareEdge,
        source: "x-forwarded-for",
        trusted: true,
      },
      { address: CHAIN.client, source: "header", trusted: false },
    ]);
    expect(Object.isFrozen(req.proxyChain)).toBe(true);
    expect(Object.isFrozen(req.proxyChain[0])).toBe(true);
    const off = await makeRequest({ peer: "10.0.0.1" });
    expect(off.proxyChain).toEqual([
      { address: "10.0.0.1", source: "socket", trusted: false },
    ]);
    const stopped = await makeRequest({
      peer: "10.0.0.1",
      headers: { "X-Forwarded-For": "spoof, 203.0.113.5" },
      options: { trustProxy: "10.0.0.0/8" },
    });
    expect(stopped.proxyChain.map((entry) => entry.trusted)).toEqual([
      true,
      false,
    ]);
  });
});

describe("resolveClientAddress", () => {
  it("believes the header only when the farthest address is trusted", () => {
    const trust = trustChain([true, ["10.0.0.0/8"]]);
    expect(
      resolveClientAddress({
        peer: "1.1.1.1",
        forwardedFor: "10.0.0.5",
        trust,
        clientIpHeaderValue: "9.9.9.9",
      }),
    ).toMatchObject({
      ip: "9.9.9.9",
      ips: ["9.9.9.9", "10.0.0.5"],
      fromHeader: true,
    });
    expect(
      resolveClientAddress({
        peer: "1.1.1.1",
        forwardedFor: "11.0.0.5",
        trust,
        clientIpHeaderValue: "9.9.9.9",
      }),
    ).toMatchObject({ ip: "11.0.0.5", ips: ["11.0.0.5"], fromHeader: false });
  });

  it("trustChain trusts nothing past its last hop", () => {
    const trust = trustChain([true, true]);
    expect([trust("a", 0), trust("a", 1), trust("a", 2)]).toEqual([
      true,
      true,
      false,
    ]);
    expect(() => trustChain(["nope"])).toThrow(TypeError);
  });
});

describe("socket-free fetch()", () => {
  it("has no peer: req.ip is '' unless a trusted forwarded address says otherwise", async () => {
    const router = new BunRouter();
    router.get("/ip", (req, res) => res.json({ ip: req.ip, ips: req.ips }));
    const headers = { "X-Forwarded-For": "203.0.113.9" };
    expect(await (await router.fetch("/ip", { headers })).json()).toEqual({
      ip: "",
      ips: [],
    });

    // A range cannot match a missing peer: still nothing.
    router.trustProxy = "loopback";
    expect(await (await router.fetch("/ip", { headers })).json()).toEqual({
      ip: "",
      ips: [],
    });

    // A hop count or `true` trusts the missing peer by position, so a test
    // can set the client through the header.
    const counted = new BunRouter({ trustProxy: 1 });
    counted.get("/ip", (req, res) => res.json({ ip: req.ip, ips: req.ips }));
    expect(await (await counted.fetch("/ip", { headers })).json()).toEqual({
      ip: "203.0.113.9",
      ips: ["203.0.113.9"],
    });
  });

  it("the adapter's fetch() applies its trustProxy", async () => {
    const app = new BunHttpAdapter(0, { trustProxy: true, logger: () => {} });
    app.get("/ip", (req, res) => res.json({ ip: req.ip, proto: req.protocol }));
    const res = await app.fetch("/ip", {
      headers: {
        "X-Forwarded-For": "203.0.113.9",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(await res.json()).toEqual({ ip: "203.0.113.9", proto: "https" });
  });
});

/** An adapter that can serve a request as if from any socket peer. */
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

describe("the adapters' options", () => {
  const route = (app: BunHttpAdapter) =>
    app.get("/who", (req, res) =>
      res.json({ ip: req.ip, ips: req.ips, proto: req.protocol }),
    );
  const fromProxy = () =>
    new Request("http://origin.test/who", {
      headers: {
        "X-Forwarded-For": "203.0.113.9, 10.0.0.4",
        "X-Forwarded-Proto": "https",
      },
    });

  it("trustProxy decides every request, and set('trust proxy') changes it", async () => {
    const app = new PeerAdapter(0, {
      trustProxy: "10.0.0.0/8",
      logger: () => {},
    });
    route(app);
    expect(await (await app.serveFrom(fromProxy(), "10.0.0.1")).json()).toEqual(
      {
        ip: "203.0.113.9",
        ips: ["203.0.113.9", "10.0.0.4"],
        proto: "https",
      },
    );

    app.set("trust proxy", false);
    expect(await (await app.serveFrom(fromProxy(), "10.0.0.1")).json()).toEqual(
      {
        ip: "10.0.0.1",
        ips: [],
        proto: "http",
      },
    );

    app.enable("trust proxy");
    expect(app.trustProxy).toBe(true);
    expect(app.requestOpts.trustProxy).toBe(true);
    expect(() => app.set("trust proxy", "10.0.0.0/0")).toThrow(TypeError);
    expect(app.trustProxy).toBe(true);
  });

  it("the setting survives replacing the request options, unless they set it", () => {
    const app = new BunHttpAdapter(0, {
      trustProxy: 1,
      clientIpHeader: "x-real-ip",
      logger: () => {},
    });
    app.setRequestOpts({ parseBody: false });
    expect(app.requestOpts.trustProxy).toBe(1);
    expect(app.requestOpts.clientIpHeader).toBe("x-real-ip");
    app.setRequestOpts({ trustProxy: "loopback" });
    expect(app.trustProxy).toBe("loopback");
    expect(app.requestOpts.trustProxy).toBe("loopback");
  });

  it("the top-level option wins over request.trustProxy; a bad value throws", () => {
    const app = new BunHttpAdapter(0, {
      trustProxy: 2,
      request: { trustProxy: true },
      logger: () => {},
    });
    expect(app.trustProxy).toBe(2);
    expect(app.requestOpts.trustProxy).toBe(2);
    const fromRequest = new BunHttpAdapter(0, {
      request: { trustProxy: "loopback" },
      logger: () => {},
    });
    expect(fromRequest.trustProxy).toBe("loopback");
    expect(
      () => new BunHttpAdapter(0, { trustProxy: "nope", logger: () => {} }),
    ).toThrow("invalid IP address: nope");
  });

  it("the default leaves trust off", () => {
    const app = new BunHttpAdapter(0, { logger: () => {} });
    expect(app.trustProxy).toBeUndefined();
    expect(app.requestOpts.trustProxy).toBeUndefined();
  });
});

describe("WebSocket upgrades", () => {
  let app: BunHttpAdapter | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("ws.data.ip is the upgrade's req.ip, through trustProxy", async () => {
    app = new BunHttpAdapter(0, { trustProxy: "loopback", logger: () => {} });
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
      headers: { "X-Forwarded-For": "203.0.113.9" },
    });
    expect(await seen.promise).toBe("203.0.113.9");
    client.close();
  });
});

describe("fetchCloudflareIpRanges", () => {
  const answer =
    (body: unknown, status = 200) =>
    () =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));

  it("reads the API's ranges, IPv4 then IPv6", async () => {
    const ranges = await fetchCloudflareIpRanges({
      fetch: answer({
        success: true,
        result: { ipv4_cidrs: ["192.0.2.0/24"], ipv6_cidrs: ["2001:db8::/32"] },
      }),
    });
    expect(ranges).toEqual(["192.0.2.0/24", "2001:db8::/32"]);
  });

  it("rejects an error, an unexpected shape, an empty list or a bad range", async () => {
    await expect(
      fetchCloudflareIpRanges({ fetch: answer({}, 500) }),
    ).rejects.toThrow("500");
    await expect(
      fetchCloudflareIpRanges({ fetch: answer({ success: true, result: {} }) }),
    ).rejects.toThrow("unexpected answer");
    await expect(
      fetchCloudflareIpRanges({
        fetch: answer({
          success: true,
          result: { ipv4_cidrs: [], ipv6_cidrs: [] },
        }),
      }),
    ).rejects.toThrow("unexpected answer");
    await expect(
      fetchCloudflareIpRanges({
        fetch: answer({
          success: true,
          result: { ipv4_cidrs: ["x/8"], ipv6_cidrs: [] },
        }),
      }),
    ).rejects.toThrow(TypeError);
  });
});
