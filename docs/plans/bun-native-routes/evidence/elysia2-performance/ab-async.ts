// Interleaved A/B of the served path: comparison worktree vs working tree.
const stub = { requestIP: () => null, upgrade: () => false } as never;
async function make(root: string) {
  const { BunHttpAdapter } = await import(`${root}/packages/bun-common/lib/index.ts`);
  class Probe extends BunHttpAdapter { serve(r: Request) { return (this as any).serveNativeRequest(r, stub); } }
  const app = new Probe(0, { request: { parseBody: false, parseCookies: false, parseQuery: false } });
  app.get("/sync", (_q: any, s: any) => s.send("ok"));
  app.get("/done", async (_q: any, s: any) => { s.send("ok"); });
  app.get("/async", async (_q: any, s: any) => { await null; s.send("ok"); });
  app.use("/amw", async (_q: any, _s: any, n: any) => { await null; n(); });
  app.get("/amw/x", (_q: any, s: any) => s.send("ok"));
  app.get("/late", (_q: any, s: any) => { setImmediate(() => s.send("ok")); });
  return app;
}
const A = await make("/tmp/claude-0/prev"), B = await make("/home/user/bun-node");
const paths = ["/sync", "/done", "/async", "/amw/x"];
const reqs = Object.fromEntries(paths.map((p) => [p, Array.from({ length: 256 }, () => new Request(`http://localhost${p}`))]));
const N = 20000;
async function round(app: any, p: string) {
  const rs = reqs[p];
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < N; i++) { const r = await app.serve(rs[i & 255]); }
  return (Bun.nanoseconds() - t0) / N;
}
for (const p of paths) { for (let w = 0; w < 3; w++) { await round(A, p); await round(B, p); } }
const res: Record<string, number[]> = {};
for (let r = 0; r < 21; r++) for (const p of paths) for (const [n, app] of [["before", A], ["after", B]] as const) (res[`${p} ${n}`] ??= []).push(await round(app, p));
for (const p of paths) {
  const m = (k: string) => { const xs = res[k].sort((a, b) => a - b); return xs[10]; };
  const b = m(`${p} before`), a = m(`${p} after`);
  console.log(`${p.padEnd(8)} before ${b.toFixed(0).padStart(5)} ns  after ${a.toFixed(0).padStart(5)} ns  ${(((a - b) / b) * 100).toFixed(1).padStart(6)}%`);
}
