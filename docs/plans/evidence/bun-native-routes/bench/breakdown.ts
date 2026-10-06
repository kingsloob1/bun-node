/**
 * Where a bun-common request's time goes, in process and without sockets:
 * each stage of `handleNativeRequest` timed on its own, for `GET /user/42`.
 *
 *   bun breakdown.ts
 *
 * Every stage runs 200k times after a 50k warm-up; figures are ns per
 * request, best of 5 passes. Absolute numbers are this machine's; the point
 * is the proportions — which stage a native-routes change could remove.
 */
import { BunHttpAdapter, BunRequest, BunResponse } from "@kingsleyweb/bun-common";

const N = 200_000;
const stub = { requestIP: () => null, upgrade: () => false } as never;

async function time(label: string, fn: () => unknown): Promise<number> {
  for (let i = 0; i < 50_000; i++) await fn();
  let best = Infinity;
  for (let pass = 0; pass < 5; pass++) {
    const t0 = Bun.nanoseconds();
    for (let i = 0; i < N; i++) await fn();
    best = Math.min(best, (Bun.nanoseconds() - t0) / N);
  }
  console.log(`${label.padEnd(58)} ${best.toFixed(0).padStart(6)} ns`);
  return best;
}

const url = "http://localhost/user/42";
const lean = { parseBody: false, parseCookies: false, parseQuery: false } as const;

function adapter(request: object) {
  const a = new BunHttpAdapter(0, { request });
  a.get("/user/:id", (req, res) => res.send(req.params.id));
  return a;
}
const full = adapter({});
const leanAdapter = adapter(lean);
const handleNative = (a: BunHttpAdapter, req: Request) =>
  (a as unknown as { handleNativeRequest: (r: Request, s: never) => Promise<Response> }).handleNativeRequest(req, stub);

console.log(`Bun ${Bun.version} (${Bun.revision}); ns per request, best of 5 x ${N}\n`);
await time("new Request(url)                     (floor, not ours)", () => new Request(url));
await time("BunRequest.init, adapter defaults", () => BunRequest.init(new Request(url), stub, full.requestOpts));
await time("BunRequest.init, body parse off (query+cookies on)", () =>
  BunRequest.init(new Request(url), stub, { ...full.requestOpts, parseBody: false, parseQuery: true }));
await time("BunRequest.init, parsing off", () => BunRequest.init(new Request(url), stub, leanAdapter.requestOpts));
await time("  + new BunResponse", () => {
  const req = BunRequest.init(new Request(url), stub, leanAdapter.requestOpts) as BunRequest;
  return new BunResponse(req, { etag: false });
});
await time("  + router.getMatchedLayers (cache hit)", () => {
  const req = BunRequest.init(new Request(url), stub, leanAdapter.requestOpts) as BunRequest;
  new BunResponse(req, { etag: false });
  return leanAdapter.getMatchedLayers({ requestHost: req.host, requestMethod: req.method, requestUrl: req.originalUrl });
});
await time("  + router.handle (send)", async () => {
  const req = BunRequest.init(new Request(url), stub, leanAdapter.requestOpts) as BunRequest;
  const res = new BunResponse(req, { etag: false });
  await leanAdapter.handle({ requestHost: req.host, requestMethod: req.method, requestUrl: req.originalUrl, request: req, response: res });
  return res;
});
await time("  + getNativeResponse", async () => {
  const req = BunRequest.init(new Request(url), stub, leanAdapter.requestOpts) as BunRequest;
  const res = new BunResponse(req, { etag: false });
  await leanAdapter.handle({ requestHost: req.host, requestMethod: req.method, requestUrl: req.originalUrl, request: req, response: res });
  return res.settledResponse ?? (await res.getNativeResponse(0));
});
await time("handleNativeRequest, parsing off (whole adapter path)", () => handleNative(leanAdapter, new Request(url)));
await time("handleNativeRequest, adapter defaults", () => handleNative(full, new Request(url)));
// The path Bun.serve takes (when present): no promise for a synchronous request.
const serveNative = (a: BunHttpAdapter, req: Request) =>
  (a as unknown as { serveNativeRequest?: (r: Request, s: never) => unknown }).serveNativeRequest?.(req, stub);
await time("serveNativeRequest, parsing off (served path)", () => serveNative(leanAdapter, new Request(url)));
await time("serveNativeRequest, adapter defaults (served path)", () => serveNative(full, new Request(url)));
await time("floor: new Request + new Response(id)", () => {
  new Request(url);
  return new Response("42");
});
