import * as lib from "../../../../../packages/bun-common/lib/index";
const { Elysia } = await import("../../../../../benchmarks/node_modules/elysia2");
const stub = { requestIP: () => null, upgrade: () => false } as never;
const adapter = new lib.BunHttpAdapter(0, { request: { retainBuffer: false } });
adapter.get("/sync", (_q: any, s: any) => { s.send("ok"); });
adapter.get("/async-done", async (_q: any, s: any) => { s.send("ok"); });
adapter.get("/async-await", async (_q: any, s: any) => { await null; s.send("ok"); });
adapter.get("/async-await2", async (_q: any, s: any) => { await null; await null; s.send("ok"); });
const el = new Elysia().get("/sync", () => "ok").get("/async-done", async () => "ok").get("/async-await", async () => { await null; return "ok"; }).get("/async-await2", async () => { await null; await null; return "ok"; });
async function time(f: () => unknown) {
  for (let i = 0; i < 30000; i++) { const r = f(); if (r instanceof Promise) await r; }
  let best = Infinity;
  for (let k = 0; k < 9; k++) { const t = performance.now(); for (let i = 0; i < 50000; i++) { const r = f(); if (r instanceof Promise) await r; } best = Math.min(best, (performance.now() - t) * 20); }
  return best;
}
for (const p of ["/sync", "/async-done", "/async-await", "/async-await2"]) {
  const o = await time(() => (adapter as any).serveNativeRequest(new Request("http://localhost" + p), stub));
  const e = await time(() => el.handle(new Request("http://localhost" + p)));
  console.log(`${p.padEnd(14)} ours ${o.toFixed(0).padStart(5)}  elysia2 ${e.toFixed(0).padStart(5)}  gap ${(o - e).toFixed(0).padStart(5)}`);
}
