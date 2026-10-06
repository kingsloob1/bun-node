/**
 * Prototypes and second-round micro-benchmarks (ns per op, best of 5): the
 * shapes a bun-common change could take, measured beside what it has today.
 * None of this is library code; each group names the plan step it sizes.
 *
 *   NODE_ENV=production BUN_OPTIONS= PKG_ROOT=<snapshot> bun micro2.ts [group]
 */
import process from "node:process";

const PKG_ROOT = process.env.PKG_ROOT ?? "@kingsleyweb";
const { BunHttpAdapter, BunRequest, BunResponse, BunRouter } = (await import(
  `${PKG_ROOT}/bun-common`
)) as typeof import("@kingsleyweb/bun-common");
const { Elysia } = (await import("../../../../benchmarks/node_modules/elysia2/dist/index.mjs")) as typeof import("../../../../benchmarks/node_modules/elysia");

const N = Number(process.env.N ?? 200_000);
const group = process.argv[2];
const stub = { requestIP: () => null, upgrade: () => false, port: 0 } as never;
const lean = { parseBody: false, parseCookies: false, parseQuery: false } as const;
const sink: unknown[] = [];
const on = (g: string) => group === undefined || group === g;

async function time(label: string, fn: () => unknown, n = N): Promise<number> {
  for (let i = 0; i < Math.min(n, 50_000); i++) {
    const r = fn();
    sink[i & 7] = r instanceof Promise ? await r : r;
  }
  let best = Infinity;
  for (let pass = 0; pass < 5; pass++) {
    const t0 = Bun.nanoseconds();
    for (let i = 0; i < n; i++) {
      const r = fn();
      sink[i & 7] = r instanceof Promise ? await r : r;
    }
    best = Math.min(best, (Bun.nanoseconds() - t0) / n);
  }
  console.log(`  ${label.padEnd(70)} ${best.toFixed(0).padStart(7)} ns`);
  return best;
}
console.log(`Bun ${Bun.version} (${Bun.revision}), NODE_ENV=${process.env.NODE_ENV}; ns/op, best of 5 x ${N}\n`);

// --- H. Header storage for a response that sets headers -----------------
if (on("headers")) {
  console.log("H. a response with 3 headers (CORS-like): how they reach `new Response`");
  const body = '{"ok":true}';
  await time("Headers object, 3x set(), new Response   (BunResponse today)", () => {
    const h = new Headers();
    h.set("Content-Type", "application/json; charset=utf-8");
    h.set("Access-Control-Allow-Origin", "*");
    h.set("Vary", "Origin");
    return new Response(body, { status: 200, headers: h });
  });
  await time("null-proto record, 3 writes, new Response(init.headers=record) (Elysia set.headers)", () => {
    const h: Record<string, string> = Object.create(null);
    h["content-type"] = "application/json; charset=utf-8";
    h["access-control-allow-origin"] = "*";
    h.vary = "Origin";
    return new Response(body, { status: 200, headers: h });
  });
  await time("record of [name, value] (Node's kOutHeaders) -> tuple array -> new Response", () => {
    const h: Record<string, [string, string]> = Object.create(null);
    h["content-type"] = ["Content-Type", "application/json; charset=utf-8"];
    h["access-control-allow-origin"] = ["Access-Control-Allow-Origin", "*"];
    h.vary = ["Vary", "Origin"];
    const list: [string, string][] = [];
    for (const k in h) list.push(h[k]);
    return new Response(body, { status: 200, headers: list });
  });
  const r = new BunRequest(new Request("http://localhost/x"), stub, lean);
  await time("BunResponse: set x3 + send(json text)", () =>
    new BunResponse(r, { etag: false })
      .set("Content-Type", "application/json; charset=utf-8")
      .set("Access-Control-Allow-Origin", "*")
      .set("Vary", "Origin")
      .send(body));
  await time("  floor: new Response(body)", () => new Response(body));
}

// --- I. Not found and errors --------------------------------------------
if (on("errors")) {
  console.log("\nI. a 404 and a thrown error, whole request");
  const app = new Elysia().get("/boom", () => {
    throw new Error("boom");
  }) as unknown as { fetch: (r: Request) => Response | Promise<Response> };
  const ef = app.fetch;
  await time("Elysia 2: unknown path (cached 404, .clone())", () => ef(new Request("http://localhost/nope")));
  await time("Elysia 2: handler throws -> 500", () => ef(new Request("http://localhost/boom")));
  const a = new BunHttpAdapter(0, { request: lean });
  a.get("/boom", () => {
    throw new Error("boom");
  });
  const serve = (a as unknown as { serveNativeRequest: (r: Request, s: unknown) => unknown }).serveNativeRequest.bind(a);
  const quiet = console.error;
  console.error = () => {};
  await time("bun-common (lean): unknown path -> 404", () => serve(new Request("http://localhost/nope"), stub));
  await time("bun-common (lean): handler throws -> 500 (adapter error handler)", () =>
    Promise.resolve(serve(new Request("http://localhost/boom"), stub)).catch(() => undefined), 50_000);
  console.error = quiet;
  const notFound = new Response('{"code":"not-found"}', { status: 404, headers: { "content-type": "application/json" } });
  await time("new Response(undefined, {status: 404, statusText})", () => new Response(undefined, { status: 404, statusText: "Not Found" }));
  await time("cachedResponse.clone()", () => notFound.clone());
}

// --- J. A synchronous fast loop over the same layers ---------------------
if (on("loop")) {
  console.log("\nJ. the pipeline walk: #runPipeline against a sync-only fast loop (same cached layers)");
  type Layer = ReturnType<InstanceType<typeof BunRouter>["getMatchedLayers"]>[number];
  const BAIL = Symbol("bail");
  /**
   * The common case only: every layer synchronous, each calls next() with no
   * argument or completes the response. Anything else returns BAIL, where a
   * real implementation hands its index to the general loop.
   */
  function fastRun(layers: Layer[], req: InstanceType<typeof BunRequest>, res: InstanceType<typeof BunResponse>, perLayerNext: boolean): unknown {
    let called = false;
    let arg: unknown;
    const shared = (a?: unknown) => {
      called = true;
      arg = a;
    };
    let bound = -1;
    let matched: unknown;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (layer.isErrorHandler) continue;
      if (layer.isRouteHandler) {
        if (layer.routeIndex !== bound) {
          req.params = layer.matched.params as Record<string, string>;
          req.route = layer.matched as never;
          bound = layer.routeIndex;
        }
        matched = layer.matched;
      }
      let next = shared;
      if (perLayerNext) {
        let done = false;
        next = (a?: unknown) => {
          if (done) return;
          done = true;
          called = true;
          arg = a;
        };
      }
      req.baseUrl = layer.baseUrl;
      req.next = next as never;
      called = false;
      const r = (layer.callback as (q: unknown, s: unknown, n: unknown) => unknown)(req, res, next);
      if (r != null && typeof (r as { then?: unknown }).then === "function") return BAIL;
      if (called) {
        if (arg !== undefined && arg !== null) return BAIL;
        if (res.headersSent && !res.isStreamOpen) return matched ?? true;
        continue;
      }
      if (res.headersSent && !res.isStreamOpen) return matched ?? true;
      return BAIL;
    }
    return res.headersSent ? (matched ?? true) : undefined;
  }
  const req = new BunRequest(new Request("http://localhost/user/42"), stub, lean);
  for (const n of [0, 3, 10]) {
    const router = new BunRouter();
    const mw = (_q: unknown, _s: unknown, next: () => void) => next();
    for (let i = 0; i < n; i++) router.use("/user", mw as never);
    router.get("/user/:id", ((_q: unknown, s: { send: (b: string) => void }) => s.send("ok")) as never);
    const opts = { requestHost: "localhost", requestMethod: "GET", requestUrl: "/user/42" };
    const layers = router.getMatchedLayers(opts);
    await time(`${n} use() + route: router.dispatch (getMatchedLayers hit incl.)`, () =>
      router.dispatch({ ...opts, request: req, response: new BunResponse(req, { etag: false }) }));
    await time(`${n} use() + route: getMatchedLayers + fastRun, one next per layer`, () =>
      fastRun(router.getMatchedLayers(opts), req, new BunResponse(req, { etag: false }), true));
    await time(`${n} use() + route: getMatchedLayers + fastRun, one next per request`, () =>
      fastRun(router.getMatchedLayers(opts), req, new BunResponse(req, { etag: false }), false));
    sink[0] = layers;
  }
  await time("  floor: new BunResponse + send('ok')", () => new BunResponse(req, { etag: false }).send("ok"));
}

// --- K. Waiting for an async layer ---------------------------------------
if (on("wait")) {
  console.log("\nK. waiting on an async handler that responds after an await (the shape every Nest route has)");
  const req = new BunRequest(new Request("http://localhost/x"), stub, lean);
  const handler = async (_q: unknown, s: InstanceType<typeof BunResponse>) => {
    await null;
    s.send("ok");
  };
  const router = new BunRouter();
  router.get("/x", handler as never);
  const opts = { requestHost: "localhost", requestMethod: "GET", requestUrl: "/x" };
  await time("router.dispatch (#waitLayer: new Promise + onceResponded + then)", () =>
    router.dispatch({ ...opts, request: req, response: new BunResponse(req, { etag: false }) }));
  await time("prototype: pending.then(() => res.settledResponse)", () => {
    const res = new BunResponse(req, { etag: false });
    return handler(req, res).then(() => res.settledResponse);
  });
  await time("prototype: the same, plus one Promise wrapper (onceResponded race)", () => {
    const res = new BunResponse(req, { etag: false });
    return new Promise((resolve) => {
      res.onceResponded(resolve);
      handler(req, res).then(() => resolve(res.settledResponse));
    });
  });
  await time("  floor: handler(req, new BunResponse) awaited", () => handler(req, new BunResponse(req, { etag: false })));
}

// --- L. Admission to the route cache --------------------------------------
if (on("admission")) {
  console.log("\nL. a fresh path per request (param-random): cache admission policies on getMatchedLayers");
  const h = ((_q: unknown, s: { send: (b: string) => void }) => s.send("ok")) as never;
  const mk = (max?: number) => {
    const router = new BunRouter(max === undefined ? undefined : ({ routeCacheMax: max } as never));
    for (let i = 0; i < 1000; i++) router.get(`/r${i}/:id`, h);
    return router;
  };
  const opts = (url: string) => ({ requestHost: "localhost", requestMethod: "GET", requestUrl: url });
  let k = 0;
  const always = mk();
  await time("today: every miss inserted (FIFO 50,000)", () => always.getMatchedLayers(opts(`/r999/${10_000_000 + k++}`)));
  for (const cap of [256, 1000, 5000]) {
    const capped = mk(cap);
    await time(`today's FIFO with routeCacheMax: ${cap}`, () => capped.getMatchedLayers(opts(`/r999/${10_000_000 + k++}`)));
  }
  const never = mk(0);
  await time("routeCacheMax: 0 (no cache)", () => never.getMatchedLayers(opts(`/r999/${10_000_000 + k++}`)));
  // A doorkeeper: admit a key on its second sighting within a window.
  const seen = new Set<string>();
  let seenOrder: string[] = [];
  const gated = mk(0);
  const cache = new Map<string, unknown>();
  await time("prototype: doorkeeper (admit on 2nd sighting) + uncached lookup", () => {
    const key = `GET /r999/${10_000_000 + k++}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const layers = gated.getMatchedLayers(opts(key.slice(4)));
    if (seen.has(key)) cache.set(key, layers);
    else {
      seen.add(key);
      seenOrder.push(key);
      if (seenOrder.length > 4096) {
        seen.clear();
        seenOrder = [];
      }
    }
    return layers;
  });
  // Sampled admission: insert one miss in K (a counter, no per-key state).
  // A path that repeats is admitted after ~K misses; a fresh id rarely is.
  const sampled = mk(0);
  const sampledCache = new Map<string, unknown>();
  let misses = 0;
  await time("prototype: sampled admission (1 miss in 8 inserted, Map) + uncached lookup", () => {
    const path = `/r999/${10_000_000 + k++}`;
    const key = `GET ${path}`;
    const hit = sampledCache.get(key);
    if (hit !== undefined) return hit;
    const layers = sampled.getMatchedLayers(opts(path));
    if ((++misses & 7) === 0) {
      if (sampledCache.size >= 50_000) sampledCache.clear();
      sampledCache.set(key, layers);
    }
    return layers;
  });
  const repeat = mk(0);
  const repeatCache = new Map<string, unknown>();
  let rm = 0;
  await time("prototype: sampled admission, the same path every time (hit path)", () => {
    const path = "/r999/7";
    const key = `GET ${path}`;
    const hit = repeatCache.get(key);
    if (hit !== undefined) return hit;
    const layers = repeat.getMatchedLayers(opts(path));
    if ((++rm & 7) === 0) repeatCache.set(key, layers);
    return layers;
  });
}
process.exit(0);
