import * as lib from "../../../../../packages/bun-common/lib/index";
const { Elysia } = await import("../../../../../benchmarks/node_modules/elysia2");
const stub = { requestIP: () => null, upgrade: () => false } as never;
const adapter = new lib.BunHttpAdapter(0, { request: { retainBuffer: false } });
let el: any = new Elysia();
for (const k of [1, 2, 4, 8]) {
  adapter.get(`/a${k}`, async (_q: any, s: any) => { for (let i = 0; i < k; i++) await null; s.send("ok"); });
  el = el.get(`/a${k}`, async () => { for (let i = 0; i < k; i++) await null; return "ok"; });
}
async function time(f: () => unknown) {
  for (let i = 0; i < 30000; i++) { const r = f(); if (r instanceof Promise) await r; }
  let best = Infinity;
  for (let k = 0; k < 9; k++) { const t = performance.now(); for (let i = 0; i < 50000; i++) { const r = f(); if (r instanceof Promise) await r; } best = Math.min(best, (performance.now() - t) * 20); }
  return best;
}
for (const k of [1, 2, 4, 8]) {
  const o = await time(() => (adapter as any).serveNativeRequest(new Request(`http://localhost/a${k}`), stub));
  const e = await time(() => el.handle(new Request(`http://localhost/a${k}`)));
  console.log(`awaits=${k}  ours ${o.toFixed(0).padStart(5)}  elysia2 ${e.toFixed(0).padStart(5)}  gap ${(o - e).toFixed(0).padStart(5)}`);
}
