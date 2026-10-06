/**
 * Where a bun-nest request goes, in process, for GET /static (no guards,
 * pipes or interceptors; `bodyParser: false` unless BP=1): the whole adapter
 * path, bun-common's router dispatch alone, and Nest's own route callback
 * (RouterProxy -> RouterExecutionContext -> reply) called directly.
 *
 *   NODE_ENV=production BUN_OPTIONS= PKG_ROOT=<snapshot> bun nest-breakdown.ts
 */
import process from "node:process";
import { initNest } from "./nest-app";

const PKG_ROOT = process.env.PKG_ROOT ?? "@kingsleyweb";
const { BunRequest, BunResponse } = (await import(`${PKG_ROOT}/bun-common`)) as typeof import("@kingsleyweb/bun-common");
const { BunHttpAdapter } = (await import(`${PKG_ROOT}/bun-nest`)) as typeof import("@kingsleyweb/bun-nest");
const stub = { requestIP: () => null, upgrade: () => false, port: 0 } as never;
const N = 100_000;
const sink: unknown[] = [];
async function time(label: string, fn: () => unknown) {
  for (let i = 0; i < 20_000; i++) {
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
  console.log(`  ${label.padEnd(64)} ${best.toFixed(0).padStart(6)} ns`);
}
const adapter = new BunHttpAdapter();
await initNest(10, adapter, process.env.BP === "1" ? {} : { bodyParser: false });
const router = (adapter as unknown as { instance: { getMatchedLayers: (o: object) => { callback: (...a: unknown[]) => unknown; isRouteHandler: boolean }[]; dispatch: (o: object) => unknown } }).instance;
const opts = { requestHost: "localhost", requestMethod: "GET", requestUrl: "/static" };
const layers = router.getMatchedLayers(opts);
const route = layers.find((l) => l.isRouteHandler)!;
const requestOpts = (adapter as unknown as { requestOpts: object }).requestOpts;
const serve = (adapter as unknown as { serveNativeRequest: (r: Request, s: unknown) => unknown }).serveNativeRequest.bind(adapter);
const mkReq = () => BunRequest.init(new Request("http://localhost/static"), stub, requestOpts as never) as InstanceType<typeof BunRequest>;
console.log(`Bun ${Bun.version}; bodyParser ${process.env.BP === "1" ? "on" : "off"}; ${layers.length} layers matched; ns/request, best of 5 x ${N}\n`);
await time("whole adapter path: serveNativeRequest(new Request)", () => serve(new Request("http://localhost/static"), stub));
await time("BunRequest.init + new BunResponse", () => new BunResponse(mkReq(), { etag: false }));
await time("+ router.dispatch (bun-common pipeline incl. #waitLayer)", () => {
  const req = mkReq();
  return router.dispatch({ ...opts, request: req, response: new BunResponse(req, { etag: false }) });
});
await time("+ Nest route callback called directly, awaited (no pipeline)", () => {
  const req = mkReq();
  const res = new BunResponse(req, { etag: false });
  (req as unknown as { params: object }).params = {};
  return route.callback(req, res, () => {});
});
process.exit(0);
