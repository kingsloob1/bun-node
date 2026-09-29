/**
 * Differential fuzz: random route tables × random raw requests, the prototype
 * (served through Bun's native table) against the stock adapter (`fetch()`,
 * in process). Any difference in status or body is a semantic break.
 *
 *   BNR_SEEDS=200 bun test docs/plans/evidence/bun-native-routes/prototype/tests/differential.test.ts
 *
 * Tables mix what the Express semantics hinge on: `use()` prefixes (plain,
 * param, case-varied), route handlers with static, `:param`, regex, optional
 * and wildcard segments, `all()`, several methods, handlers that call
 * `next()`, `next('route')`, `next('router')` or throw, a 4-arity error
 * handler, a mounted sub-router and a not-found handler. Requests are sent raw
 * (`node:net`), so dot segments, doubled slashes, bad escapes and case
 * variants reach Bun untouched.
 */
import type { RouterErrorMiddlewareHandler } from "../../../../../../packages/bun-common/lib/types/general";
import net from "node:net";
import process from "node:process";
import { expect, it } from "bun:test";
import { BunHttpAdapter as Stock } from "../../../../../../packages/bun-common/lib/BunHttpAdapter";
import { BunRouter } from "../../../../../../packages/bun-common/lib/BunRouter";
import { withNativeRoutes } from "../adapter";
import { indexStats, installCandidateIndex, installRingCache } from "../candidate-index";
import { nativeStats } from "../native-routes";

/** `native` (default): Bun's route table. `index`: the JS candidate index, served through `fetch`. */
const MODE = process.env.BNR_MODE ?? "native";
/** `BNR_NOCACHE=1`: route cache off on the candidate, so every request takes the miss path. */
/** `BNR_CACHEMAX=n`: a tiny route cache, so eviction runs constantly. */
const CANDIDATE_OPTIONS =
  process.env.BNR_NOCACHE === "1"
    ? { routeCacheMax: 0 }
    : process.env.BNR_CACHEMAX
      ? { routeCacheMax: Number(process.env.BNR_CACHEMAX) }
      : {};

const Proto = withNativeRoutes(Stock);
const SEEDS = Number(process.env.BNR_SEEDS ?? 60);

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROUTE_SEGMENTS = ["users", "posts", "api", "v1", "Admin", "new", ":id", ":name", ":id(\\d+)", ":opt?", "*", "a.b"];
const USE_PREFIXES = ["/", "/api", "/users", "/:tenant", "/api/v1", "/Admin", "/posts/:id"];
const REQUEST_SEGMENTS = ["users", "posts", "api", "v1", "admin", "Admin", "new", "42", "7", "a.b", "x%20y", "%zz", "..", ".", "", "USERS"];
const METHODS = ["GET", "POST", "PUT", "DELETE"] as const;

type Behaviour = "send" | "next" | "route" | "router" | "throw";

interface Spec {
  kind: "use" | "verb" | "all" | "error" | "mount";
  path: string;
  method?: (typeof METHODS)[number];
  behaviour: Behaviour;
  label: string;
}

function makeSpecs(rand: () => number): Spec[] {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const specs: Spec[] = [];
  const n = 6 + Math.floor(rand() * 14);
  for (let i = 0; i < n; i++) {
    const r = rand();
    const behaviour: Behaviour = pick(["send", "send", "send", "next", "route", "router", "throw"] as const);
    if (r < 0.25) {
      specs.push({ kind: "use", path: pick(USE_PREFIXES), behaviour: behaviour === "send" ? "next" : behaviour, label: `use${i}` });
    } else if (r < 0.32) {
      specs.push({ kind: "error", path: pick(USE_PREFIXES), behaviour: "send", label: `err${i}` });
    } else if (r < 0.38) {
      specs.push({ kind: "mount", path: pick(["/api", "/users", "/v1"]), behaviour, label: `mount${i}` });
    } else {
      const depth = 1 + Math.floor(rand() * 3);
      const segments = Array.from({ length: depth }, () => pick(ROUTE_SEGMENTS));
      // A repeated param name is legal in routejs (the later capture wins) and
      // harmless here (native keys are positional), but keep names unique so a
      // mismatch report reads unambiguously.
      const seen = new Set<string>();
      const unique = segments.map((s, k) => {
        if (!s.startsWith(":")) return s;
        const name = /^:(\w+)/.exec(s)![1];
        if (seen.has(name)) return `:p${k}`;
        seen.add(name);
        return s;
      });
      specs.push({
        kind: rand() < 0.15 ? "all" : "verb",
        path: `/${unique.join("/")}`,
        method: pick(METHODS),
        behaviour,
        label: `r${i}`,
      });
    }
  }
  return specs;
}

type App = InstanceType<typeof Stock>;
function register(app: App, specs: Spec[]) {
  for (const spec of specs) {
    const handler = (req: { params: object; baseUrl: string; trail?: string[] }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: (a?: unknown) => void) => {
      (req.trail ??= []).push(spec.label);
      switch (spec.behaviour) {
        case "send":
          return res.status(200).json({ by: spec.label, params: req.params, baseUrl: req.baseUrl, trail: req.trail });
        case "next":
          return next();
        case "route":
          return next("route");
        case "router":
          return next("router");
        case "throw":
          throw Object.assign(new Error(`thrown by ${spec.label}`), { status: 409 });
      }
    };
    const h = handler as never;
    if (spec.kind === "use") app.use(spec.path, h);
    else if (spec.kind === "error") {
      app.use(spec.path, ((err, req, res, _next) => {
        res.status(422).json({ caught: (err as Error).message, by: spec.label, trail: (req as { trail?: string[] }).trail });
      }) satisfies RouterErrorMiddlewareHandler);
    } else if (spec.kind === "all") app.all(spec.path, h);
    else if (spec.kind === "mount") {
      const sub = new BunRouter();
      sub.get("/:id", h);
      sub.use(h);
      app.use(spec.path, sub);
    } else (app as unknown as Record<string, (p: string, h: never) => void>)[spec.method!.toLowerCase()](spec.path, h);
  }
  app.setNotFoundHandler((req, res) => {
    res.status(404).json({ notFound: req.path, trail: (req as { trail?: string[] }).trail ?? [] });
    return true;
  });
}

function makeRequests(rand: () => number, specs: Spec[]): [string, string][] {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const out: [string, string][] = [];
  for (let i = 0; i < 40; i++) {
    let path: string;
    if (rand() < 0.5) {
      // derived from a registered path, so most requests hit something
      const spec = pick(specs);
      path = spec.path
        .split("/")
        .map((s) => (s.startsWith(":") ? pick(["42", "7", "new", "x%20y", "%zz", ".."]) : s === "*" ? pick(["a/b", "", "z"]) : s))
        .join("/");
      if (rand() < 0.15) path += "/";
      if (rand() < 0.1) path = path.toUpperCase();
    } else {
      const depth = 1 + Math.floor(rand() * 4);
      path = `/${Array.from({ length: depth }, () => pick(REQUEST_SEGMENTS)).join("/")}`;
    }
    if (!path.startsWith("/")) path = `/${path}`;
    if (rand() < 0.1) path += "?q=1";
    out.push([pick(METHODS), path]);
  }
  return out;
}

function raw(port: number, method: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (c) => chunks.push(c));
    socket.on("error", reject);
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const [head, ...rest] = text.split("\r\n\r\n");
      let body = rest.join("\r\n\r\n");
      if (/transfer-encoding: chunked/i.test(head)) {
        let decoded = "";
        let cursor = 0;
        while (cursor < body.length) {
          const eol = body.indexOf("\r\n", cursor);
          const size = Number.parseInt(body.slice(cursor, eol), 16);
          if (!size) break;
          decoded += body.slice(eol + 2, eol + 2 + size);
          cursor = eol + 2 + size + 2;
        }
        body = decoded;
      }
      resolve({ status: Number(head.split(" ")[1]), body });
    });
    socket.write(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
}

/** Normalises the one thing that differs by transport: the absolute URL in an error page is absent either way. */
const clean = (s: string) => s;

const mismatches: string[] = [];
let compared = 0;

it(`${MODE} routing answers like the stock adapter over ${SEEDS} random tables`, async () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = prng(seed);
    const specs = makeSpecs(rand);
    // BNR_SPECIFICITY=1: both sides order competing route handlers by specificity.
    const specificity = process.env.BNR_SPECIFICITY === "1" ? { router: { routeSpecificity: true } } : {};
    const native = new Proto(0, { ...CANDIDATE_OPTIONS, ...specificity });
    native.nativeRoutesEnabled = MODE === "native";
    if (MODE === "index") installCandidateIndex(native as never);
    if (process.env.BNR_RINGCACHE === "1") installRingCache(native as never);
    const stock = new Stock(0, { ...specificity });
    try {
      register(native, specs);
      register(stock, specs);
    } catch {
      continue; // a path routejs itself rejects: nothing to compare
    }
    const server = await native.listen(0);
    try {
      for (const [method, path] of makeRequests(rand, specs)) {
        // What Bun's `req.url` will hold: the WHATWG-normalised target.
        const normalised = new URL(`http://localhost${path}`);
        const expected = await stock.fetch(normalised.href, { method });
        const got = await raw(server.port!, method, path);
        const expectedBody = clean(await expected.text());
        compared++;
        if (got.status !== expected.status || clean(got.body) !== expectedBody) {
          mismatches.push(`seed ${seed} ${method} ${path}: native ${got.status} ${got.body.slice(0, 120)} | stock ${expected.status} ${expectedBody.slice(0, 120)}\n  table: ${specs.map((s) => `${s.kind}${s.method ? `:${s.method}` : ""} ${s.path} ${s.behaviour}`).join("; ")}`);
        }
      }
    } finally {
      await native.close();
    }
  }
  console.log(`mode ${MODE}${process.env.BNR_NOCACHE === "1" ? " (cache off)" : ""}: compared ${compared} requests; native-routed ${nativeStats.native}, guard fallbacks ${nativeStats.guardFallback}; index misses ${indexStats.misses}, mean candidates ${(indexStats.candidatesTotal / Math.max(1, indexStats.misses)).toFixed(1)}; mismatches ${mismatches.length}`);
  for (const m of mismatches.slice(0, 15)) console.log(m);
  expect(mismatches).toEqual([]);
}, 600_000);
