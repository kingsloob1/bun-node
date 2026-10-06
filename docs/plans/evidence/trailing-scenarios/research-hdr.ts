const { BunRequest, BunResponse } = await import("../../../../packages/bun-common/lib/index.ts");
const stub = { requestIP: () => null, upgrade: () => false } as never;
const H = { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*", vary: "Origin" };
const N = 300_000;
function bench(name: string, f: () => unknown) {
  for (let i = 0; i < 30000; i++) f();
  const r: number[] = [];
  for (let k = 0; k < 5; k++) { const t = Bun.nanoseconds(); for (let i = 0; i < N; i++) f(); r.push((Bun.nanoseconds() - t) / N); }
  r.sort((a, b) => a - b); console.log(name.padEnd(56), r[2].toFixed(0), "ns");
}
const reqs = Array.from({ length: 256 }, () => new Request("http://localhost/headers"));
let i = 0;
bench("new Response('ok') (no headers)", () => new Response("ok"));
bench("new Response('ok', { headers: plain object })", () => new Response("ok", { headers: H }));
bench("new Response('ok', { headers: { ...object } }) (fresh obj)", () => new Response("ok", { headers: { "content-type": H["content-type"], "access-control-allow-origin": "*", vary: "Origin" } }));
bench("new Headers() + 3 set + new Response", () => { const h = new Headers(); h.set("content-type", H["content-type"]); h.set("access-control-allow-origin", "*"); h.set("vary", "Origin"); return new Response("ok", { headers: h }); });
bench("request.headers (materialise) + 2 get", () => { const h = new Request("http://localhost/x").headers; return h.get("if-modified-since") ?? h.get("if-none-match"); });
bench("new Request only", () => new Request("http://localhost/x"));
bench("BunRequest+BunResponse, res.set x3 + send", () => { const req = new BunRequest(reqs[i++ & 255], stub, { parseBody: false, parseCookies: false, parseQuery: false }); const res = new BunResponse(req); res.set("content-type", H["content-type"]); res.set("access-control-allow-origin", "*"); res.set("vary", "Origin"); res.send("ok"); return res; });
bench("BunRequest+BunResponse, send only", () => { const req = new BunRequest(reqs[i++ & 255], stub, { parseBody: false, parseCookies: false, parseQuery: false }); const res = new BunResponse(req); res.send("ok"); return res; });
console.log("--- split");
bench("BunRequest+BunResponse, res.set x3 (no send)", () => { const req = new BunRequest(reqs[i++ & 255], stub, { parseBody: false, parseCookies: false, parseQuery: false }); const res = new BunResponse(req); res.set("content-type", H["content-type"]); res.set("access-control-allow-origin", "*"); res.set("vary", "Origin"); return res; });
bench("new Headers() + 3 set (no Response)", () => { const h = new Headers(); h.set("content-type", H["content-type"]); h.set("access-control-allow-origin", "*"); h.set("vary", "Origin"); return h; });
bench("Headers.has on 3-entry Headers", (() => { const h = new Headers(H); return () => h.has("content-type"); })());
bench("new Response('ok', { headers: existing Headers })", (() => { const h = new Headers(H); return () => new Response("ok", { headers: h }); })());
bench("new Response('ok', { status: 200, headers: existing Headers })", (() => { const h = new Headers(H); return () => new Response("ok", { status: 200, headers: h }); })());
