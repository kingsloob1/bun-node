/**
 * Where one GET /user/42 goes, in process, Elysia 2 beside bun-common:
 * cumulative stages, each timed on its own (ns per request, best of 5).
 * Elysia's stages replay what its source does (fetch.mjs createFetchHandler,
 * context.mjs, base.mjs ~map / memoirist, web-standard/handler.mjs) with its
 * own memoirist; its last row is its real `app.fetch`. bun-common's stages are
 * the adapter's own calls, as ../bun-native-routes/bench/breakdown.ts.
 *
 *   NODE_ENV=production BUN_OPTIONS= PKG_ROOT=<snapshot> bun breakdown.ts
 */
import process from "node:process";
import { makeTarget } from "./targets";

const PKG_ROOT = process.env.PKG_ROOT ?? "@kingsleyweb";
const { BunHttpAdapter, BunRequest, BunResponse } = (await import(`${PKG_ROOT}/bun-common`)) as typeof import("@kingsleyweb/bun-common");
const Memoirist = ((await import("../../../../benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs")) as {
  default: new (o?: object) => { add: (m: string, p: string, s: unknown) => void; find: (m: string, p: string) => { store: (c: unknown) => unknown; params: Record<string, string> } | null };
}).default;

const N = 200_000;
const sink: unknown[] = [];
const stub = { requestIP: () => null, upgrade: () => false, port: 0 } as never;
async function time(label: string, fn: () => unknown): Promise<void> {
  for (let i = 0; i < 50_000; i++) {
    const r = fn();
    sink[i & 7] = r instanceof Promise ? await r : r;
  }
  let best = Infinity;
  for (let p = 0; p < 5; p++) {
    const t0 = Bun.nanoseconds();
    for (let i = 0; i < N; i++) {
      const r = fn();
      sink[i & 7] = r instanceof Promise ? await r : r;
    }
    best = Math.min(best, (Bun.nanoseconds() - t0) / N);
  }
  console.log(`  ${label.padEnd(62)} ${best.toFixed(0).padStart(6)} ns`);
}
const url = "http://localhost/user/42";
console.log(`Bun ${Bun.version}; GET /user/42; cumulative ns per request, best of 5 x ${N}\n`);

console.log("Elysia 2 (stages replayed from its source)");
class Context {
  request: Request;
  set: { headers: Record<string, string>; status: number | undefined; cookie: unknown };
  qi = -1;
  path = "";
  server: unknown = null;
  params: Record<string, string> | undefined = undefined;
  constructor(request: Request) {
    this.request = request;
    this.set = { headers: Object.create(null), status: undefined, cookie: undefined };
  }
}
const map: Record<string, Record<string, unknown>> = Object.create(null);
map.GET = Object.create(null);
map.GET["/static"] = () => "ok";
const tree = new Memoirist({ loosePath: true });
for (let i = 0; i < 1000; i++) tree.add("GET", `/r${i}/:id`, (c: Context) => c.params!.id);
tree.add("GET", "/user/:id", (c: Context) => c.params!.id);
const extractPath = (c: Context, u: string) => {
  const s = u.indexOf("/", u.charCodeAt(4) === 58 ? 7 : 8);
  const q = (c.qi = u.indexOf("?", s));
  return (c.path = q === -1 ? u.slice(s) : u.substring(s, q));
};
await time("new Request(url)", () => new Request(url));
await time("+ new Context(request) + extractPath", () => {
  const r = new Request(url);
  const c = new Context(r);
  return extractPath(c, r.url);
});
await time("+ ~map[method][path] miss + memoirist.find", () => {
  const r = new Request(url);
  const c = new Context(r);
  const p = extractPath(c, r.url);
  return map[r.method]?.[p] ?? tree.find(r.method, p);
});
await time("+ handler + new Response(value)   (mapCompactResponse)", () => {
  const r = new Request(url);
  const c = new Context(r);
  const p = extractPath(c, r.url);
  const found = tree.find(r.method, p)!;
  c.params = found.params;
  return new Response(found.store(c) as string);
});
const elysia = await makeTarget("elysia2");
await time("real app.fetch (withOrigin)", () => elysia(new Request(url)));

console.log("\nbun-common, adapter defaults (stages as the adapter calls them)");
const a = new BunHttpAdapter(0);
a.get("/user/:id", (req, res) => res.send(req.params.id));
for (let i = 0; i < 1000; i++) a.get(`/r${i}/:id`, (req, res) => res.send(req.params.id));
const opts = a.requestOpts;
await time("new Request(url)", () => new Request(url));
await time("+ BunRequest.init (defaults; no body)", () => BunRequest.init(new Request(url), stub, opts));
await time("+ new BunResponse", () => new BunResponse(BunRequest.init(new Request(url), stub, opts) as never, { etag: false }));
await time("+ host/method/originalUrl + getMatchedLayers (hit)", () => {
  const req = BunRequest.init(new Request(url), stub, opts) as InstanceType<typeof BunRequest>;
  new BunResponse(req, { etag: false });
  return a.getMatchedLayers({ requestHost: req.host, requestMethod: req.method, requestUrl: req.originalUrl });
});
await time("+ dispatch (pipeline + handler + res.send)", () => {
  const req = BunRequest.init(new Request(url), stub, opts) as InstanceType<typeof BunRequest>;
  const res = new BunResponse(req, { etag: false });
  a.dispatch({ requestHost: req.host, requestMethod: req.method, requestUrl: req.originalUrl, request: req, response: res });
  return res.settledResponse;
});
const serve = (a as unknown as { serveNativeRequest: (r: Request, s: unknown) => unknown }).serveNativeRequest.bind(a);
await time("real serveNativeRequest", () => serve(new Request(url), stub));
process.exit(0);
