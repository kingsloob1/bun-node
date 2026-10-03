/**
 * Isolated costs of each Elysia 2 technique against bun-common's equivalent
 * step, in process (ns per op, best of 5 after a warm-up). Each group names
 * the Elysia source it mirrors; the plan's §3 cites the rows.
 *
 *   NODE_ENV=production BUN_OPTIONS= PKG_ROOT=<snapshot> bun micro.ts [group]
 */
import process from "node:process";

const PKG_ROOT = process.env.PKG_ROOT ?? "@kingsleyweb";
const { BunHttpAdapter, BunRequest, BunResponse, BunRouter } = (await import(
  `${PKG_ROOT}/bun-common`
)) as typeof import("@kingsleyweb/bun-common");
const Memoirist = ((await import("../../../../benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs")) as {
  default: new (o?: object) => { add: (m: string, p: string, s: unknown) => void; find: (m: string, p: string) => { store: unknown; params: Record<string, string> } | null };
}).default;
const { Elysia } = (await import("../../../../benchmarks/node_modules/elysia2/dist/index.mjs")) as typeof import("../../../../benchmarks/node_modules/elysia");

const N = Number(process.env.N ?? 200_000);
const group = process.argv[2];
const stub = { requestIP: () => null, upgrade: () => false, port: 0 } as never;
const lean = { parseBody: false, parseCookies: false, parseQuery: false } as const;
const sink: unknown[] = [];

async function time(label: string, fn: () => unknown, n = N): Promise<void> {
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
  console.log(`  ${label.padEnd(66)} ${best.toFixed(0).padStart(7)} ns`);
}
const on = (g: string) => group === undefined || group === g;
const native = new Request("http://localhost/user/42");
/** The adapter's default request options (built once: an adapter per call would dominate). */
const defaults = new BunHttpAdapter(0).requestOpts;

console.log(`Bun ${Bun.version} (${Bun.revision}), NODE_ENV=${process.env.NODE_ENV}; ns/op, best of 5 x ${N}\n`);

// --- A. The per-request object(s) ---------------------------------------
if (on("context")) {
  console.log("A. per-request objects (context.mjs vs BunRequest/BunResponse)");
  // Elysia 2's Context: a class whose constructor writes `request` and a
  // `set` record; the fetch handler then adds qi, path, server (fetch.mjs).
  class Base {}
  class Context extends Base {
    request: Request;
    set: { headers: Record<string, string>; status: number | undefined; cookie: unknown };
    qi = -1;
    path = "";
    server: unknown = null;
    constructor(request: Request) {
      super();
      this.request = request;
      this.set = { headers: Object.create(null), status: undefined, cookie: undefined };
    }
  }
  await time("Elysia-style Context (request, set{headers,status,cookie}, path)", () => new Context(native));
  await time("new BunRequest(native, lean)", () => new BunRequest(native, stub, lean));
  await time("BunRequest.init(native, adapter defaults; no body)", () => BunRequest.init(native, stub, defaults));
  const r = new BunRequest(native, stub, lean);
  await time("new BunResponse(req)", () => new BunResponse(r, { etag: false }));
  await time("request.signal (first read on a fresh Request)", () => new Request("http://localhost/x").signal);
  await time("  floor: new Request(url)", () => new Request("http://localhost/x"));
}

// --- B. The URL ---------------------------------------------------------
if (on("url")) {
  console.log("\nB. path from the URL (fetch.mjs extractPath vs BunRequest getters)");
  const authorityEnd = (url: string) => (url.charCodeAt(4) === 58 ? 7 : url.charCodeAt(5) === 58 ? 8 : url.indexOf("://") + 3);
  await time("Elysia extractPath: indexOf x2 + slice", () => {
    const url = native.url;
    const s = url.indexOf("/", authorityEnd(url));
    const q = url.indexOf("?", s);
    return q === -1 ? url.slice(s) : url.substring(s, q);
  });
  await time("native.url alone", () => native.url);
  await time("new BunRequest(lean) + host + method + originalUrl", () => {
    const q = new BunRequest(native, stub, lean);
    return q.host + q.method + q.originalUrl;
  });
  await time("new BunRequest(lean) alone", () => new BunRequest(native, stub, lean));
  await time("native.method.toUpperCase()", () => native.method.toUpperCase());
}

// --- C. Route lookup ----------------------------------------------------
if (on("lookup")) {
  console.log("\nC. route lookup, 1,000 /r<i>/:id routes + /static (base.mjs ~map + memoirist vs getMatchedLayers)");
  const map: Record<string, Record<string, unknown>> = Object.create(null);
  map.GET = Object.create(null);
  map.GET["/static"] = () => 1;
  const tree = new Memoirist({ loosePath: true });
  for (let i = 0; i < 1000; i++) tree.add("GET", `/r${i}/:id`, i);
  tree.add("GET", "/user/:id", -1);
  await time("Elysia static: map[method][path]", () => map.GET["/static"]);
  await time("Elysia dynamic: memoirist.find('/r999/7')", () => tree.find("GET", "/r999/7"));
  let k = 0;
  await time("Elysia dynamic: memoirist.find(fresh id)", () => tree.find("GET", `/r999/${10_000_000 + k++}`));

  const router = new BunRouter();
  const h = (_q: unknown, s: { send: (b: string) => void }) => s.send("ok");
  router.get("/static", h as never);
  for (let i = 0; i < 1000; i++) router.get(`/r${i}/:id`, h as never);
  const opts = (url: string) => ({ requestHost: "localhost", requestMethod: "GET", requestUrl: url });
  const o1 = opts("/static");
  const o2 = opts("/r999/7");
  await time("bun-common getMatchedLayers('/static') (cache hit)", () => router.getMatchedLayers(o1));
  await time("bun-common getMatchedLayers('/r999/7') (cache hit)", () => router.getMatchedLayers(o2));
  await time("bun-common getMatchedLayers(fresh id) (miss, cache filling)", () => router.getMatchedLayers(opts(`/r999/${10_000_000 + k++}`)));
  const nocache = new BunRouter({ routeCacheMax: 0 } as never);
  nocache.get("/static", h as never);
  for (let i = 0; i < 1000; i++) nocache.get(`/r${i}/:id`, h as never);
  await time("bun-common getMatchedLayers(fresh id), routeCacheMax: 0", () => nocache.getMatchedLayers(opts(`/r999/${10_000_000 + k++}`)));
  await time("bun-common getMatchedLayers('/r999/7'), routeCacheMax: 0", () => nocache.getMatchedLayers(o2));
  await time("template key `${method} ${path}` + Map.get (cache hit shape)", () => sink.length && (sink as never as Map<string, unknown>));
}

// --- D. Producing the Response ------------------------------------------
if (on("response")) {
  console.log("\nD. producing the Response (web-standard/handler.mjs mapCompactResponse vs BunResponse)");
  const r = new BunRequest(native, stub, lean);
  await time("new Response('ok')                        (Elysia compact string)", () => new Response("ok"));
  await time("new BunResponse + send('ok') + settledResponse", () => {
    const s = new BunResponse(r, { etag: false });
    s.send("ok");
    return s.settledResponse;
  });
  await time("new BunResponse + status(200).send('ok')", () => new BunResponse(r, { etag: false }).status(200).send("ok"));
  await time("new BunResponse + set('x-a','1').send('ok')   (any header)", () => new BunResponse(r, { etag: false }).set("x-a", "1").send("ok"));
  await time("new Response('ok', {headers: {x-a: '1'}})  (Elysia set.headers)", () => new Response("ok", { headers: { "x-a": "1" } }));
  const body = { ok: true, n: 7 };
  await time("Response.json(obj)                         (Elysia compact object)", () => Response.json(body));
  await time("new BunResponse + json(obj)", () => new BunResponse(r, { etag: false }).json(body));
  await time("new Response(JSON.stringify(obj), {headers: Headers})", () =>
    new Response(JSON.stringify(body), { headers: new Headers({ "content-type": "application/json; charset=utf-8" }) }));
}

// --- E. The pipeline ----------------------------------------------------
if (on("pipeline")) {
  console.log("\nE. pipeline: per-layer cost (compiled beforeHandle chain vs #runPipeline)");
  const r = new BunRequest(native, stub, lean);
  const mk = (layers: number) => {
    const router = new BunRouter();
    const mw = (_q: unknown, _s: unknown, next: () => void) => next();
    for (let i = 0; i < layers; i++) router.use("/user", mw as never);
    router.get("/user/:id", ((_q: unknown, s: { send: (b: string) => void }) => s.send("ok")) as never);
    return router;
  };
  const opts = { requestHost: "localhost", requestMethod: "GET", requestUrl: "/user/42" };
  for (const n of [0, 1, 3, 10]) {
    const router = mk(n);
    await time(`bun-common dispatch: ${n} use() + route (new BunResponse incl.)`, () =>
      router.dispatch({ ...opts, request: r, response: new BunResponse(r, { etag: false }) }));
  }
  // The same chain as Elysia 2 compiles it: hook functions called inline.
  const bf = [(c: { hits?: number }) => void (c.hits = 1), (c: { hits?: number }) => void (c.hits = 2), (c: { hits?: number }) => void (c.hits = 3)];
  await time("Elysia-style inline chain: 3 hooks + handler + new Response", () => {
    const c: { hits?: number } = {};
    let t = bf[0](c);
    if (t === undefined) t = bf[1](c);
    if (t === undefined) t = bf[2](c);
    return new Response(`mw:${c.hits}`);
  });
}

// --- F. Async handlers --------------------------------------------------
if (on("async")) {
  console.log("\nF. an async handler, whole request (compiled async tail vs #waitLayer + awaitPipelineOrStream)");
  const app = new Elysia()
    .get("/sync", () => "ok")
    .get("/async", async () => {
      await null;
      return "ok";
    }) as unknown as { fetch: (r: Request) => Response | Promise<Response> };
  const ef = app.fetch;
  await time("Elysia 2 fetch: () => 'ok'", () => ef(new Request("http://localhost/sync")));
  await time("Elysia 2 fetch: async () => { await null; return 'ok' }", () => ef(new Request("http://localhost/async")));
  const a = new BunHttpAdapter(0, { request: lean });
  a.get("/sync", (_q, s) => s.send("ok"));
  a.get("/async-early", async (_q, s) => {
    s.send("ok");
  });
  a.get("/async", async (_q, s) => {
    await null;
    s.send("ok");
  });
  a.get("/async-next", async (_q, _s, next) => {
    await null;
    next();
  }, (_q, s) => s.send("ok"));
  const serve = (a as unknown as { serveNativeRequest: (r: Request, s: unknown) => unknown }).serveNativeRequest.bind(a);
  await time("bun-common (lean): (q,s) => s.send('ok')", () => serve(new Request("http://localhost/sync"), stub));
  await time("bun-common (lean): async (q,s) => { s.send('ok') }", () => serve(new Request("http://localhost/async-early"), stub));
  await time("bun-common (lean): async (q,s) => { await null; s.send('ok') }", () => serve(new Request("http://localhost/async"), stub));
  await time("bun-common (lean): async mw { await null; next() } + send", () => serve(new Request("http://localhost/async-next"), stub));
}

// --- G. The JSON body ---------------------------------------------------
if (on("body")) {
  console.log("\nG. reading a small JSON body (web-standard parse.json vs alternatives)");
  const mk = () => new Request("http://localhost/json", { method: "POST", body: '{"n":7}', headers: { "content-type": "application/json" } });
  await time("  floor: new Request(POST, body)", mk);
  await time("await request.json()                     (Elysia)", () => mk().json());
  await time("await request.text() + JSON.parse", () => mk().text().then((t) => JSON.parse(t)));
  await time("await request.arrayBuffer() + TextDecoder + JSON.parse", () => mk().arrayBuffer().then((b) => JSON.parse(new TextDecoder().decode(b))));
  await time("await request.bytes() + Buffer.from + toString + JSON.parse", () => mk().bytes().then((b) => JSON.parse(Buffer.from(b).toString("utf8"))));
  const lengthOf = (r: Request) => r.headers.get("content-length");
  await time("headers.get('content-type') + get('content-length')  (hb())", () => {
    const r = mk();
    return r.headers.get("content-type")! + lengthOf(r);
  });
  await time("BunRequest.init(POST json, adapter defaults)", () => BunRequest.init(mk(), stub, defaults));
}
process.exit(0);
