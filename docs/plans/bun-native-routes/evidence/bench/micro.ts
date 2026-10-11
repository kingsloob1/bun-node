/**
 * Per-accessor costs on the request hot path, in process (ns per call,
 * best of 5). Companion to breakdown.ts: names what each stage spends.
 *
 *   bun micro.ts
 */
import { BunHttpAdapter, BunRequest, BunResponse } from "@kingsleyweb/bun-common";

const N = 200_000;
const stub = { requestIP: () => null, upgrade: () => false } as never;
const url = "http://localhost/user/42";
const lean = { parseBody: false, parseCookies: false, parseQuery: false } as const;
const a = new BunHttpAdapter(0, { request: lean });
a.get("/user/:id", (req, res) => res.send(req.params.id));
const native = new Request(url);
const sink: unknown[] = [];

async function time(label: string, fn: () => unknown) {
  for (let i = 0; i < 50_000; i++) sink[i & 7] = await fn();
  let best = Infinity;
  for (let pass = 0; pass < 5; pass++) {
    const t0 = Bun.nanoseconds();
    for (let i = 0; i < N; i++) sink[i & 7] = await fn();
    best = Math.min(best, (Bun.nanoseconds() - t0) / N);
  }
  console.log(`${label.padEnd(50)} ${best.toFixed(0).padStart(6)} ns`);
}
const mk = () => BunRequest.init(native, stub, lean) as BunRequest;
await time("BunRequest.init (lean, reused native)", mk);
await time("init + .host", () => mk().host);
await time("init + .method", () => mk().method);
await time("init + .originalUrl", () => mk().originalUrl);
await time("init + host+method+originalUrl", () => { const r = mk(); return r.host + r.method + r.originalUrl; });
await time("init + getCacheKey", () => { const r = mk(); return a.getCacheKey({ requestHost: r.host, requestMethod: r.method, requestUrl: r.originalUrl }); });
await time("init + new BunResponse", () => new BunResponse(mk(), { etag: false }));
await time("init + res.send('42')", () => new BunResponse(mk(), { etag: false }).send("42"));
await time("init + parseQuery()", () => mk().parseQuery());
await time("init + parseCookies()", () => mk().parseCookies());
await time("init defaults (query+cookies, no body)", () => BunRequest.init(native, stub, { parseBody: false, parseCookies: true, parseQuery: true }));
await time("init + handle (send)", async () => { const r = mk(); const res = new BunResponse(r, { etag: false }); await a.handle({ requestHost: r.host, requestMethod: r.method, requestUrl: r.originalUrl, request: r, response: res }); return res; });
