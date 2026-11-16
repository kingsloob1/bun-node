/**
 * `installSecurity` on a bun-common adapter (plan §3.3, PR-S5): the early
 * stage before the body is read, the route stage with the matched route and
 * the caller, the response stage (headers, scrubbing, outcomes), and the
 * boot self-test.
 */
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter, ConfigError } from "@kingsleyweb/bun-common";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { createSecurity } from "../../lib/index";
import type { Decision, SecurityPolicy } from "../../lib/index";
import type { Security } from "../../lib/engine/security";
import {
  installSecurity,
  requestSecurity,
  securityProfile,
} from "../../lib/http/index";
import type { InstallSecurityOptions } from "../../lib/http/index";

/** Adapters a test started listening, closed after it. */
const listening: BunHttpAdapter[] = [];

afterEach(async () => {
  for (const adapter of listening.splice(0)) await adapter.close();
});

/** An engine reading the caller from `x-user`, quiet. */
function engine(policy: SecurityPolicy = {}): Security<BunRequest> {
  return createSecurity<BunRequest>({
    policy,
    logger: () => {},
    identify: (req) => {
      const user = req.request.headers.get("x-user");
      return user === null ? undefined : { user };
    },
  });
}

/** `base` with `evaluate` replaced: a test double for the engine's decisions. */
function withEvaluate(
  base: Security<BunRequest>,
  evaluate: Security<BunRequest>["evaluate"],
): Security<BunRequest> {
  return new Proxy(base, {
    get(target, key) {
      if (key === "evaluate") return evaluate;
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** A fresh adapter with the engine installed (quiet logger). */
async function secured(
  policy: SecurityPolicy = {},
  options: InstallSecurityOptions = {},
  security: Security<BunRequest> = engine(policy),
) {
  const app = new BunHttpAdapter(0, { logger: () => {} });
  const installation = await installSecurity(app, security, {
    logger: () => {},
    ...options,
  });
  return { app, installation, security };
}

/** A request from `client` (the socket peer). */
const from = (client: string, init: Record<string, unknown> = {}) => ({
  remoteAddress: client,
  ...init,
});

/** Starts `app` on an OS-assigned loopback port. */
async function serve(app: BunHttpAdapter): Promise<number> {
  listening.push(app);
  return Number((await app.listen(0, "127.0.0.1")).port);
}

/** Writes `payload` on a raw connection and collects the answer until close or `waitMs`. */
function raw(port: number, payload: string, waitMs = 400) {
  return new Promise<{ text: string; closed: boolean }>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let text = "";
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (closed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ text, closed });
    };
    timer = setTimeout(() => finish(false), waitMs);
    socket.on("data", (chunk) => (text += chunk.toString()));
    socket.on("close", () => finish(true));
    socket.on("error", () => finish(true));
    socket.write(payload);
  });
}

describe("installSecurity: the early stage", () => {
  it("refuses a listed address before its body is read, and nothing after the install runs", async () => {
    const { app } = await secured({
      lists: [{ ip: "203.0.113.66", action: "block" }],
    });
    const ran: string[] = [];
    app.use((_req, _res, next) => {
      ran.push("middleware");
      next();
    });
    app.post("/upload", (req, res) => res.json(req.body));
    let pulls = 0;
    const body = () =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(new TextEncoder().encode('{"a":1}'));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
    };
    const refused = await app.fetch(
      "/upload",
      from("203.0.113.66", { ...init, body: body() }),
    );
    expect(refused.status).toBe(403);
    expect(refused.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await refused.json()).toEqual({
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      code: "blocked",
    });
    // The security headers reach the refusal too.
    expect(refused.headers.get("x-content-type-options")).toBe("nosniff");
    expect(pulls).toBe(0);
    expect(ran).toEqual([]);
    // Negative control: another client is read and routed.
    const passed = await app.fetch(
      "/upload",
      from("198.51.100.7", { ...init, body: body() }),
    );
    expect(await passed.json()).toEqual({ a: 1 });
    expect([pulls, ran]).toEqual([1, ["middleware"]]);
  });

  it("answers a drop entry with no answer at all over a real socket", async () => {
    const { app } = await secured({
      // Loopback is internal, which no address entry refuses: off here.
      internal: false,
      lists: [{ ip: "127.0.0.1", action: "drop", paths: ["/trap"] }],
    });
    app.get("/ok", (_req, res) => res.send("ok"));
    const port = await serve(app);
    expect(await raw(port, "GET /trap HTTP/1.1\r\nHost: a\r\n\r\n")).toEqual({
      text: "",
      closed: true,
    });
    expect(
      (await raw(port, "GET /ok HTTP/1.1\r\nHost: a\r\n\r\n")).text,
    ).toStartWith("HTTP/1.1 200");
  });

  it("counts an address limit once although the request passes both stages", async () => {
    const { app } = await secured({
      limits: [{ id: "ip", limit: 2, window: "1m" }],
    });
    app.get("/x", (_req, res) => res.send("x"));
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++)
      statuses.push((await app.fetch("/x", from("198.51.100.1"))).status);
    expect(statuses).toEqual([200, 200, 429]);
  });

  it("holds an in-flight slot until the answer is final: a stream holds it until it ends", async () => {
    const { app, security } = await secured({ concurrency: { perIp: 1 } });
    app.get("/x", (_req, res) => res.send("x"));
    let end: (() => void) | undefined;
    app.get("/stream", (_req, res) => {
      void res.write("a");
      end = () => void res.end();
    });
    // Sequential requests each give their slot back.
    for (let i = 0; i < 3; i++)
      expect((await app.fetch("/x", from("198.51.100.2"))).status).toBe(200);
    expect(security.status().state.inFlight).toBe(0);
    const streaming = await app.fetch("/stream", from("198.51.100.2"));
    expect(streaming.status).toBe(200);
    expect(security.status().state.inFlight).toBe(1);
    expect((await app.fetch("/x", from("198.51.100.2"))).status).toBe(429);
    end?.();
    expect(await streaming.text()).toBe("a");
    await Bun.sleep(5);
    expect(security.status().state.inFlight).toBe(0);
    expect((await app.fetch("/x", from("198.51.100.2"))).status).toBe(200);
  });

  it("gives a refused request no slot, and an engine failure lets it through unless failing closed", async () => {
    const base = engine({ concurrency: { perIp: 1 } });
    const broken = withEvaluate(base, () => {
      throw new Error("engine bug");
    });
    const open = await secured({}, {}, broken);
    open.app.get("/x", (_req, res) => res.send("x"));
    expect((await open.app.fetch("/x")).status).toBe(200);
    const closed = await secured({}, { failClosedOnEngineError: true }, broken);
    closed.app.get("/x", (_req, res) => res.send("x"));
    const refused = await closed.app.fetch("/x");
    expect([refused.status, refused.headers.get("retry-after")]).toEqual([
      503,
      "1",
    ]);
  });

  it("holds a delay decision, then reads on", async () => {
    const base = engine();
    const delaying = withEvaluate(base, (facts, options) => {
      const decided = base.evaluate(facts, options) as Decision;
      return options?.stage === "early"
        ? { ...decided, action: "delay", delayMs: 40 }
        : decided;
    });
    const { app } = await secured({}, {}, delaying);
    app.get("/x", (_req, res) => res.send("x"));
    const started = performance.now();
    expect((await app.fetch("/x")).status).toBe(200);
    expect(performance.now() - started).toBeGreaterThanOrEqual(35);
  });

  it("answers with renderBlock's response, and the default when it throws", async () => {
    let mode: "page" | "throw" = "page";
    const { app } = await secured(
      { lists: [{ ip: "203.0.113.66", action: "block" }] },
      {
        renderBlock: (decision) => {
          if (mode === "throw") throw new Error("template broke");
          return new Response(`blocked: ${decision.code ?? ""}`, {
            status: 451,
          });
        },
      },
    );
    const page = await app.fetch("/x", from("203.0.113.66"));
    expect([page.status, await page.text()]).toEqual([451, "blocked: blocked"]);
    mode = "throw";
    expect((await app.fetch("/x", from("203.0.113.66"))).status).toBe(403);
  });

  it("takes no slot for a WebSocket upgrade, whose socket outlives any answer", async () => {
    const { app, security } = await secured({ concurrency: { perIp: 1 } });
    app.ws("/socket", {
      open(ws) {
        ws.send("hi");
      },
      message() {},
    });
    app.get("/x", (_req, res) => res.send("x"));
    const port = await serve(app);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`);
    await new Promise<void>((resolve, reject) => {
      socket.onmessage = () => resolve();
      socket.onerror = () => reject(new Error("upgrade refused"));
    });
    expect(security.status().state.inFlight).toBe(0);
    expect((await fetch(`http://127.0.0.1:${port}/x`)).status).toBe(200);
    socket.close();
  });
});

describe("installSecurity: the route stage", () => {
  it("counts a caller-keyed limit with the caller from identify()", async () => {
    const { app } = await secured({
      limits: [{ id: "per-user", limit: 1, window: "1m", key: "user" }],
    });
    app.get("/x", (_req, res) => res.send("x"));
    const as = (user: string) =>
      from("198.51.100.3", { headers: { "x-user": user } });
    expect((await app.fetch("/x", as("alice"))).status).toBe(200);
    const second = await app.fetch("/x", as("alice"));
    expect([
      second.status,
      ((await second.json()) as { code: string }).code,
    ]).toEqual([429, "rate_limited"]);
    expect((await app.fetch("/x", as("bob"))).status).toBe(200);
  });

  it("refuses a listed user in the route stage", async () => {
    const { app } = await secured({
      lists: [{ user: "mallory", action: "block" }],
    });
    let reached = false;
    app.get("/x", (_req, res) => {
      reached = true;
      res.send("x");
    });
    const refused = await app.fetch("/x", { headers: { "x-user": "mallory" } });
    expect([refused.status, reached]).toEqual([403, false]);
  });

  it("knows the matched route: a parameter pattern and a route key apply", async () => {
    const { app } = await secured({
      limits: [
        { id: "user-page", limit: 1, window: "1m", routes: ["GET /users/:id"] },
        {
          id: "per-route",
          limit: 2,
          window: "1m",
          key: ["ip", "route"],
          routes: ["/orders/*"],
        },
      ],
    });
    app.get("/users/:id", (req, res) => res.send(req.params.id));
    app.get("/orders/:id", (req, res) => res.send(req.params.id));
    expect((await app.fetch("/users/1", from("198.51.100.9"))).status).toBe(
      200,
    );
    // Another id is the same route.
    expect((await app.fetch("/users/2", from("198.51.100.9"))).status).toBe(
      429,
    );
    const orders = [];
    for (const id of ["1", "2", "3"])
      orders.push(
        (await app.fetch(`/orders/${id}`, from("198.51.100.9"))).status,
      );
    expect(orders).toEqual([200, 200, 429]);
    // The facts carry the route's pattern.
    let routeKey: string | undefined;
    app.get("/probe/:a", (req, res) => {
      routeKey = requestSecurity(req)?.facts?.routeKey;
      res.send("p");
    });
    await app.fetch("/probe/7");
    expect(routeKey).toBe("GET /probe/:a");
  });

  it("reads a route's profile from its callbacks", async () => {
    const { app } = await secured();
    let profile: string | undefined;
    app.post("/login", securityProfile("login"), (req, res) => {
      profile = requestSecurity(req)?.profile;
      res.send("ok");
    });
    expect((await app.fetch("/login", { method: "POST" })).status).toBe(200);
    expect(profile).toBe("login");
    expect(() => securityProfile("not a name")).toThrow(TypeError);
  });

  it("counts route-not-found answers, never an app's own 404", async () => {
    const { app } = await secured({
      countedRules: [
        {
          id: "not_found",
          event: "route.notFound",
          threshold: 3,
          window: "1m",
          duration: "1d",
        },
      ],
    });
    app.get("/records/:id", (_req, res) =>
      res.status(404).send("no such record"),
    );
    app.get("/ok", (_req, res) => res.send("ok"));
    // An app's own 404s, from a route, never count.
    for (let i = 0; i < 5; i++) {
      expect(
        (await app.fetch(`/records/${i}`, from("198.51.100.4"))).status,
      ).toBe(404);
    }
    expect((await app.fetch("/ok", from("198.51.100.4"))).status).toBe(200);
    // Paths no route matches do: the third trips the rule.
    for (const path of ["/wp-admin", "/.env", "/phpmyadmin"]) {
      expect((await app.fetch(path, from("198.51.100.5"))).status).toBe(404);
    }
    const banned = await app.fetch("/ok", from("198.51.100.5"));
    // A counted rule's ban answers `banned`, with no `Retry-After` (PR-S3).
    expect([
      banned.status,
      ((await banned.json()) as { code: string }).code,
    ]).toEqual([403, "banned"]);
    expect((await app.fetch("/ok", from("198.51.100.4"))).status).toBe(200);
  });

  it("counts a catch-all not-found middleware's 404 as route-not-found", async () => {
    const { app } = await secured({
      countedRules: [
        {
          id: "not_found",
          event: "route.notFound",
          threshold: 2,
          window: "1m",
          duration: "1h",
        },
      ],
    });
    app.get("/ok", (_req, res) => res.send("ok"));
    app.use((_req, res) => res.status(404).json({ error: "not found" }));
    expect((await app.fetch("/a", from("198.51.100.6"))).status).toBe(404);
    expect((await app.fetch("/b", from("198.51.100.6"))).status).toBe(404);
    expect((await app.fetch("/ok", from("198.51.100.6"))).status).toBe(403);
  });
});

describe("installSecurity: PR-S3's layers in their stages", () => {
  it("refuses a honeypot hit before the body is read", async () => {
    const { app } = await secured({
      deception: { honeypots: { paths: ["/.env"], answer: "not-found" } },
    });
    let reached = false;
    app.post("/.env", (_req, res) => {
      reached = true;
      res.send("never");
    });
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new TextEncoder().encode("x=1"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const trapped = await app.fetch(
      "/.env",
      from("198.51.100.40", { method: "POST", body }),
    );
    expect([trapped.status, pulls, reached]).toEqual([404, 0, false]);
  });

  it("enforces a user ban in the route stage, with the caller from identify()", async () => {
    const { app, security } = await secured();
    security.ban({ user: "mallory", duration: "1h", reason: "fraud" });
    let reached = 0;
    app.get("/x", (_req, res) => {
      reached++;
      res.send("x");
    });
    const banned = await app.fetch("/x", { headers: { "x-user": "mallory" } });
    expect([
      banned.status,
      ((await banned.json()) as { code: string }).code,
    ]).toEqual([403, "banned"]);
    expect(
      (await app.fetch("/x", { headers: { "x-user": "alice" } })).status,
    ).toBe(200);
    expect(reached).toBe(1);
  });

  it("feeds route-not-found to the ladder once per request", async () => {
    // A still clock: the score's half-life decay would otherwise leave three
    // weights a hair under 3, by however long the requests took.
    const now = Date.now();
    const policy: SecurityPolicy = {
      ladder: {
        steps: [{ score: 3, action: "ban", duration: "1h" }],
        weights: { "route.notFound": 1 },
      },
    };
    const { app } = await secured(
      policy,
      {},
      createSecurity<BunRequest>({ policy, logger: () => {}, now: () => now }),
    );
    app.get("/ok", (_req, res) => res.send("ok"));
    const statuses: number[] = [];
    for (const path of ["/a", "/b", "/ok", "/c", "/ok"]) {
      statuses.push((await app.fetch(path, from("198.51.100.41"))).status);
    }
    // Weighed once each: the third not-found reaches 3, the next request is banned.
    expect(statuses).toEqual([404, 404, 200, 404, 403]);
  });
});

describe("installSecurity: the response stage", () => {
  it("sets the security headers on every answer, keeping the app's own", async () => {
    const { app } = await secured({
      lists: [{ ip: "203.0.113.66", action: "block" }],
    });
    app.get("/ok", (_req, res) => res.send("ok"));
    app.get("/own", (_req, res) =>
      res.setHeader("x-frame-options", "SAMEORIGIN").send("own"),
    );
    app.get("/boom", () => {
      throw new Error("boom");
    });
    for (const [path, client] of [
      ["/ok", "198.51.100.8"],
      ["/missing", "198.51.100.8"],
      ["/boom", "198.51.100.8"],
      ["/ok", "203.0.113.66"],
    ] as const) {
      const res = await app.fetch(path, from(client));
      expect([
        path,
        res.headers.get("x-frame-options"),
        res.headers.get("referrer-policy"),
      ]).toEqual([path, "DENY", "strict-origin-when-cross-origin"]);
    }
    expect((await app.fetch("/own")).headers.get("x-frame-options")).toBe(
      "SAMEORIGIN",
    );
    // Off: none.
    const bare = await secured({}, { headers: false });
    bare.app.get("/ok", (_req, res) => res.send("ok"));
    expect(
      (await bare.app.fetch("/ok")).headers.get("x-frame-options"),
    ).toBeNull();
  });

  it("scrubs a stack trace from a 5xx answer, and only when asked", async () => {
    const leak = (app: BunHttpAdapter) => {
      app.get("/leak", (_req, res) => {
        const error = new Error("db down");
        res.status(500).json({ message: error.message, stack: error.stack });
      });
      app.get("/text", (_req, res) => {
        res
          .status(502)
          .type("text/plain")
          .send(`Error: x\n    at handler (/srv/app.ts:12:5)\n`);
      });
      app.get("/fine", (_req, res) =>
        res.status(500).json({ message: "try later" }),
      );
    };
    const scrubbing = await secured({}, { scrub: "always" });
    leak(scrubbing.app);
    const json = await scrubbing.app.fetch("/leak");
    expect(json.status).toBe(500);
    expect(await json.json()).toEqual({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      code: "internal_error",
    });
    const text = await scrubbing.app.fetch("/text");
    expect([text.status, (await text.text()).includes("app.ts")]).toEqual([
      502,
      false,
    ]);
    expect(await (await scrubbing.app.fetch("/fine")).json()).toEqual({
      message: "try later",
    });
    // Negative controls: off, and "production" outside production.
    for (const scrub of [false, "production"] as const) {
      const leaking = await secured({}, { scrub });
      leak(leaking.app);
      expect(
        JSON.stringify(await (await leaking.app.fetch("/leak")).json()),
      ).toContain("stack");
    }
  });
});

describe("installSecurity: CSRF", () => {
  const post = (headers: Record<string, string>) => ({
    method: "POST",
    headers,
  });

  it("refuses a cross-site state-changing request that carries cookies", async () => {
    const { app } = await secured(
      {},
      { csrf: { origins: ["https://partner.example"] } },
    );
    app.post("/transfer", (_req, res) => res.send("done"));
    app.post(
      "/hooks/stripe",
      securityProfile("webhook", { crossSite: true }),
      (_req, res) => res.send("hook"),
    );
    const cases: [string, Record<string, string>, number][] = [
      [
        "cross-site with cookies",
        { cookie: "sid=1", "sec-fetch-site": "cross-site" },
        403,
      ],
      [
        "same-origin",
        { cookie: "sid=1", "sec-fetch-site": "same-origin" },
        200,
      ],
      ["same-site", { cookie: "sid=1", "sec-fetch-site": "same-site" }, 200],
      ["no cookies", { "sec-fetch-site": "cross-site" }, 200],
      [
        "a trusted origin",
        {
          cookie: "sid=1",
          "sec-fetch-site": "cross-site",
          origin: "https://partner.example",
        },
        200,
      ],
      [
        "old browser, foreign Origin",
        { cookie: "sid=1", origin: "https://evil.example" },
        403,
      ],
      [
        "old browser, own Origin",
        { cookie: "sid=1", origin: "http://localhost" },
        200,
      ],
      ["opaque Origin", { cookie: "sid=1", origin: "null" }, 403],
      ["not a browser", { cookie: "sid=1" }, 200],
    ];
    for (const [name, headers, status] of cases) {
      const res = await app.fetch("/transfer", post(headers));
      expect([name, res.status]).toEqual([name, status]);
      if (status === 403)
        expect(((await res.json()) as { code: string }).code).toBe("csrf");
    }
    // A route that takes cross-site requests on purpose.
    const hook = await app.fetch(
      "/hooks/stripe",
      post({ cookie: "sid=1", "sec-fetch-site": "cross-site" }),
    );
    expect(hook.status).toBe(200);
    // A safe method is never refused.
    app.get("/transfer", (_req, res) => res.send("form"));
    expect(
      (
        await app.fetch("/transfer", {
          headers: { cookie: "sid=1", "sec-fetch-site": "cross-site" },
        })
      ).status,
    ).toBe(200);
    // Negative control: off.
    const off = await secured({}, { csrf: false });
    off.app.post("/transfer", (_req, res) => res.send("done"));
    expect(
      (
        await off.app.fetch(
          "/transfer",
          post({ cookie: "sid=1", "sec-fetch-site": "cross-site" }),
        )
      ).status,
    ).toBe(200);
  });
});

describe("installSecurity: the boot self-test", () => {
  it("passes on an adapter where the install comes first, and reports a throttle", async () => {
    const { installation } = await secured();
    expect(installation.selfTest).toEqual({ ran: true, throttle: false });
    const throttled = new BunHttpAdapter(0, {
      logger: () => {},
      throttle: { limits: { default: { limit: 100, window: "1m" } } },
    });
    const result = await installSecurity(throttled, engine(), {
      logger: () => {},
      expectThrottle: true,
    });
    expect(result.selfTest).toEqual({ ran: true, throttle: true });
  });

  it("fails when a middleware ahead of the install answers everything, and takes its hooks back off", async () => {
    const app = new BunHttpAdapter(0, { logger: () => {} });
    app.use((_req, res) => res.send("catch-all"));
    const security = engine({
      lists: [{ ip: "203.0.113.66", action: "block" }],
    });
    const failure = await installSecurity(app, security, {
      logger: () => {},
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConfigError);
    expect(String((failure as Error).message)).toContain(
      "route stage did not see it",
    );
    // The hooks went with it: nothing refuses the listed address now.
    expect((await app.fetch("/x", from("203.0.113.66"))).status).toBe(200);
  });

  it("fails expectThrottle without a throttle", async () => {
    const app = new BunHttpAdapter(0, { logger: () => {} });
    const failure = await installSecurity(app, engine(), {
      logger: () => {},
      expectThrottle: true,
    }).catch((error: unknown) => error);
    expect(String((failure as Error).message)).toContain(
      "no bun-common throttle ran",
    );
  });

  it("never counts the self-test's request", async () => {
    const security = engine({
      limits: [{ id: "all", limit: 1, window: "1m", key: "route" }],
    });
    const app = new BunHttpAdapter(0, { logger: () => {} });
    await installSecurity(app, security, { logger: () => {} });
    app.get("/x", (_req, res) => res.send("x"));
    expect((await app.fetch("/x")).status).toBe(200);
    expect(security.status().state.inFlight).toBe(0);
  });
});

describe("installSecurity: remove()", () => {
  it("takes the engine off the adapter", async () => {
    const { app, installation } = await secured({
      lists: [
        { ip: "203.0.113.66", action: "block" },
        { user: "mallory", action: "block" },
      ],
    });
    app.get("/x", (_req, res) => res.send("x"));
    expect((await app.fetch("/x", from("203.0.113.66"))).status).toBe(403);
    installation.remove();
    expect((await app.fetch("/x", from("203.0.113.66"))).status).toBe(200);
    expect(
      (await app.fetch("/x", { headers: { "x-user": "mallory" } })).status,
    ).toBe(200);
    expect((await app.fetch("/x")).headers.get("x-frame-options")).toBeNull();
    expect(requestSecurity(new Request("http://localhost/"))).toBeUndefined();
  });
});
