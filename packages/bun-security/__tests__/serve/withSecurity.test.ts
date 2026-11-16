/**
 * `./serve`'s `withSecurity` on a real `Bun.serve` (port 0): refusals
 * answered before the handler, `drop` with no bytes, trust resolution from
 * the socket, the dual-stack listener's mapped addresses (T-L2-2), and the
 * engine failing open or closed.
 */
import { connect } from "node:net";
import { afterAll, describe, expect, it } from "bun:test";
import { createSecurity } from "../../lib/index";
import type { Decision, Security, SecurityPolicy } from "../../lib/index";
import { withSecurity } from "../../lib/serve/index";
import type { WithSecurityOptions } from "../../lib/serve/index";

/** Servers to stop after the file. */
const servers: Bun.Server<undefined>[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop(true)));
});

/** What the handler saw. */
interface Seen {
  /** Paths the handler served. */
  paths: string[];
}

/** Serves a protected handler on port 0 (dual-stack by default); returns its base URL and what it saw. */
function serve(
  policy: SecurityPolicy,
  options: WithSecurityOptions = {},
  hostname?: string,
  identify?: (
    request: Request,
  ) => { user: string } | undefined | Promise<{ user: string } | undefined>,
): { url: string; seen: Seen; decisions: Decision[]; port: number } {
  const seen: Seen = { paths: [] };
  const decisions: Decision[] = [];
  const security = createSecurity<Request>({
    policy,
    logger: () => {},
    onDecision: (decision) => decisions.push(decision),
    ...(identify ? { identify } : {}),
  });
  const server = Bun.serve({
    port: 0,
    ...(hostname ? { hostname } : {}),
    fetch: withSecurity(
      security,
      (request) => {
        seen.paths.push(new URL(request.url).pathname);
        return new Response("handled");
      },
      { logger: () => {}, ...options },
    ),
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    decisions,
    port: server.port ?? 0,
  };
}

/** Sends a raw request and returns every byte the server wrote before closing. */
function rawRequest(port: number, path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n`,
      );
    });
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString();
    });
    socket.on("error", () => {});
    socket.on("close", () => resolve(received));
  });
}

/** Blocks loopback clients (the internal list is off so loopback can be refused). */
const blockLoopback = (
  action: "block" | "drop" | "challenge" = "block",
): SecurityPolicy => ({
  internal: false,
  lists: [{ ip: "127.0.0.0/8", action, code: "go-away" }],
});

describe("withSecurity", () => {
  it("lets an allowed request reach the handler", async () => {
    const { url, seen } = serve({});
    const response = await fetch(`${url}/hello`);
    expect(await response.text()).toBe("handled");
    expect(seen.paths).toEqual(["/hello"]);
  });

  it("answers a refusal itself with problem+json, naming no rule", async () => {
    const { url, seen } = serve(blockLoopback());
    const response = await fetch(`${url}/admin`);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      code: "go-away",
    });
    expect(seen.paths).toEqual([]);
  });

  it("answers a browser with a minimal HTML page", async () => {
    const { url } = serve(blockLoopback());
    const response = await fetch(url, {
      headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    const body = await response.text();
    expect(body).toContain("<h1>Forbidden</h1>");
    expect(body).not.toContain("127.0.0.0");
  });

  it("answers a challenge with the block fallback while no provider exists", async () => {
    const { url } = serve(blockLoopback("challenge"));
    expect((await fetch(url)).status).toBe(403);
  });

  it("drops: the connection closes with no bytes written", async () => {
    const { port, seen } = serve(blockLoopback("drop"));
    expect(await rawRequest(port, "/")).toBe("");
    expect(seen.paths).toEqual([]);
  });

  it("negative control: an allowed raw request gets an answer", async () => {
    const { port } = serve({});
    expect(await rawRequest(port, "/")).toStartWith("HTTP/1.1 200");
  });

  it("uses renderBlock for refusals, and the default when it throws", async () => {
    const { url } = serve(blockLoopback(), {
      renderBlock: (decision) =>
        new Response(`no (${decision.code})`, { status: 451 }),
    });
    const response = await fetch(url);
    expect(response.status).toBe(451);
    expect(await response.text()).toBe("no (go-away)");
    const broken = serve(blockLoopback(), {
      renderBlock: () => {
        throw new Error("template bug");
      },
    });
    expect((await fetch(broken.url)).status).toBe(403);
  });

  it("T-L2-2: on a default dual-stack listener an IPv4 client matches an IPv4 range", async () => {
    // A bare Bun.serve reports IPv4 peers as ::ffff:127.0.0.1 here.
    const peers: string[] = [];
    const security = createSecurity<Request>({
      policy: blockLoopback(),
      logger: () => {},
    });
    const server = Bun.serve({
      port: 0,
      fetch(request, srv) {
        peers.push(srv.requestIP(request)?.address ?? "");
        return withSecurity(security, () => new Response("handled"))(
          request,
          srv,
        );
      },
    });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(peers[0]).toBe("::ffff:127.0.0.1");
    expect(response.status).toBe(403);
  });

  it("T-L2-1 on a socket: a spoofed X-Forwarded-For from an untrusted peer is not believed", async () => {
    const policy: SecurityPolicy = {
      internal: false,
      lists: [{ ip: "203.0.113.5", action: "block" }],
    };
    const off = serve(policy);
    expect(
      (await fetch(off.url, { headers: { "x-forwarded-for": "203.0.113.5" } }))
        .status,
    ).toBe(200);
    const trustingOthers = serve(policy, { trustProxy: ["10.0.0.0/8"] });
    expect(
      (
        await fetch(trustingOthers.url, {
          headers: { "x-forwarded-for": "203.0.113.5" },
        })
      ).status,
    ).toBe(200);
    // Negative control: trusting loopback (the real peer) believes it.
    const trustingLoopback = serve(policy, { trustProxy: "loopback" });
    expect(
      (
        await fetch(trustingLoopback.url, {
          headers: { "x-forwarded-for": "203.0.113.5" },
        })
      ).status,
    ).toBe(403);
    expect(trustingLoopback.decisions[0]?.subject.address).toBe("203.0.113.5");
  });

  it("reads a clientIpHeader only through a trusted chain", async () => {
    const policy: SecurityPolicy = {
      internal: false,
      lists: [{ ip: "198.51.100.9", action: "block" }],
    };
    const trusted = serve(policy, {
      trustProxy: "loopback",
      clientIpHeader: "cf-connecting-ip",
    });
    expect(
      (
        await fetch(trusted.url, {
          headers: { "cf-connecting-ip": "198.51.100.9" },
        })
      ).status,
    ).toBe(403);
    const untrusted = serve(policy, { clientIpHeader: "cf-connecting-ip" });
    expect(
      (
        await fetch(untrusted.url, {
          headers: { "cf-connecting-ip": "198.51.100.9" },
        })
      ).status,
    ).toBe(200);
  });

  it("calls identify(), sync or async, and keys on its answer", async () => {
    const policy: SecurityPolicy = {
      lists: [{ user: "mallory", action: "block" }],
    };
    const sync = serve(policy, {}, undefined, (request) => {
      const user = request.headers.get("x-user");
      return user ? { user } : undefined;
    });
    expect(
      (await fetch(sync.url, { headers: { "x-user": "mallory" } })).status,
    ).toBe(403);
    expect(
      (await fetch(sync.url, { headers: { "x-user": "alice" } })).status,
    ).toBe(200);
    const async = serve(policy, {}, undefined, async (request) => {
      await Bun.sleep(1);
      return { user: request.headers.get("x-user") ?? "" };
    });
    expect(
      (await fetch(async.url, { headers: { "x-user": "mallory" } })).status,
    ).toBe(403);
    expect(async.decisions[0]?.subject.user).toBe("mallory");
  });

  it("lets the request through when the engine throws, and logs it", async () => {
    const errors: string[] = [];
    const security = createSecurity<Request>({
      policy: {},
      identify: () => {
        throw new Error("identify bug");
      },
    });
    const server = Bun.serve({
      port: 0,
      fetch: withSecurity(security, () => new Response("handled"), {
        logger: (event) => errors.push(event.message),
      }),
    });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(await response.text()).toBe("handled");
    expect(errors).toEqual([
      "bun-security: the engine threw; the request was not checked",
    ]);
  });

  it("answers 503 when the engine throws under failClosedOnEngineError, also for an async failure", async () => {
    for (const identify of [
      () => {
        throw new Error("sync bug");
      },
      async () => {
        throw new Error("async bug");
      },
    ]) {
      const security = createSecurity<Request>({ policy: {}, identify });
      const server = Bun.serve({
        port: 0,
        fetch: withSecurity(security, () => new Response("handled"), {
          failClosedOnEngineError: true,
          logger: () => {},
        }),
      });
      servers.push(server);
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await response.json()).toMatchObject({
        status: 503,
        code: "unavailable",
      });
    }
  });

  it("does not catch the handler's own errors as engine errors", async () => {
    const errors: string[] = [];
    const security = createSecurity<Request>({ policy: {} });
    const server = Bun.serve({
      port: 0,
      fetch: withSecurity(
        security,
        () => {
          throw new Error("handler bug");
        },
        {
          failClosedOnEngineError: true,
          logger: (event) => errors.push(event.message),
        },
      ),
      error: () => new Response("app error page", { status: 500 }),
    });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("app error page");
    expect(errors).toEqual([]);
  });

  it("returns the handler's answer synchronously when the engine is synchronous", () => {
    const security = createSecurity<Request>({ policy: {} });
    const handler = withSecurity(security, () => new Response("sync"));
    const result = handler(new Request("http://x.test/"), {
      requestIP: () => ({ address: "203.0.113.1" }),
    });
    expect(result).toBeInstanceOf(Response);
  });

  it("keeps an upgrade's undefined answer", () => {
    const security = createSecurity<Request>({ policy: {} });
    const handler = withSecurity(security, (): undefined => undefined);
    expect(
      handler(new Request("http://x.test/"), { requestIP: () => null }),
    ).toBeUndefined();
  });
});

/** An engine whose every decision is `decision`, answered asynchronously: the store-backed path to come. */
function fixedEngine(decision: Decision): Security<Request> {
  const real = createSecurity<Request>({ policy: {} });
  return {
    policy: real.policy,
    closed: false,
    evaluate: async () => {
      await Bun.sleep(1);
      return decision;
    },
    explain: (facts, options) => real.explain(facts, options),
    complete: (facts, decided, outcome) =>
      real.complete(facts, decided, outcome),
    signal: (facts, event) => real.signal(facts, event),
    ban: (input) => real.ban(input),
    unban: (id, options) => real.unban(id, options),
    bans: () => real.bans(),
    identify: () => undefined,
    load: (policy) => real.load(policy),
    status: () => real.status(),
    close: () => real.close(),
  };
}

/** A decision with `action`. */
const decisionOf = (
  action: Decision["action"],
  extra: Partial<Decision> = {},
): Decision => ({
  action,
  hits: [],
  tags: [],
  risk: 0,
  subject: {},
  ...extra,
});

describe("withSecurity on an asynchronous engine", () => {
  const server = { requestIP: () => ({ address: "203.0.113.1" }) };

  it("holds a delay decision, at most two seconds, then serves", async () => {
    const handler = withSecurity(
      fixedEngine(decisionOf("delay", { delayMs: 60 })),
      () => new Response("late"),
    );
    const started = performance.now();
    const response = await handler(new Request("http://x.test/"), server);
    expect(await response.text()).toBe("late");
    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
  });

  it("refuses a ban with its status and code", async () => {
    const handler = withSecurity(
      fixedEngine(
        decisionOf("ban", { status: 403, code: "banned", retryAfter: 3600 }),
      ),
      () => new Response("never"),
    );
    const response = await handler(new Request("http://x.test/"), server);
    expect(response.status).toBe(403);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(await response.json()).toMatchObject({ code: "banned" });
  });

  it("serves a log or tag decision", async () => {
    for (const action of ["log", "tag"] as const) {
      const handler = withSecurity(
        fixedEngine(decisionOf(action)),
        () => new Response("served"),
      );
      expect(
        await (await handler(new Request("http://x.test/"), server)).text(),
      ).toBe("served");
    }
  });
});
