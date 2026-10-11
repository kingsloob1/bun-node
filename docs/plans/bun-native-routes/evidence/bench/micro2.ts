import { BunHttpAdapter, BunRequest, BunResponse, BunRouter } from "@kingsleyweb/bun-common";
const N = 200_000;
const stub = { requestIP: () => null, upgrade: () => false } as never;
const native = new Request("http://localhost/user/42");
const lean = { parseBody: false, parseCookies: false, parseQuery: false } as const;
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
const r = new BunRouter(); r.get("/user/:id", (_q, _s, next) => next());
const r2 = new BunRouter(); r2.get("/user/:id", (_q, s) => { s.status(200); (s as any).__x = 1; });
const req = BunRequest.init(native, stub, lean) as BunRequest;
const opts = { requestHost: "localhost", requestMethod: "GET", requestUrl: "/user/42" };
await time("getMatchedLayers (hit)", () => r.getMatchedLayers(opts));
await time("handle, handler calls next()", () => r.handle({ ...opts, request: req, response: new BunResponse(req, { etag: false }) }));
await time("new BunResponse", () => new BunResponse(req, { etag: false }));
await time("res.send('42')", () => new BunResponse(req, { etag: false }).send("42"));
await time("res.send('42') + settledResponse", () => { const s = new BunResponse(req, { etag: false }); s.send("42"); return s.settledResponse; });
await time("new Response('42')", () => new Response("42"));
await time("new Response('42', {status, headers})", () => new Response("42", { status: 200, headers: new Headers({ "content-type": "text/html; charset=utf-8" }) }));
