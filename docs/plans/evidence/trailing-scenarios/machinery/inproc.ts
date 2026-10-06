import * as lib from "../../../../../packages/bun-common/lib/index";
const { Elysia } = await import("../../../../../benchmarks/node_modules/elysia2");
const stub = { requestIP: () => null, upgrade: () => false } as never;
const reqOpts = { retainBuffer: false, parseBody: { contentTypes: { json: true, urlencoded: true, text: true, raw: true, xml: true, multipart: { opts: { detectFileType: false } } } } };
const ROOT = process.env.ROOT ?? "/home/user/bun-node";
const L = await import(`${ROOT}/packages/bun-common/lib/index.ts`);
const adapter = new L.BunHttpAdapter(0, { request: reqOpts });
const H = { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*", vary: "Origin" };
adapter.get("/user/:id", (req: any, res: any) => { res.send(req.params.id); });
adapter.get("/async", async (_req: any, res: any) => { await null; res.send("ok"); });
adapter.get("/headers", (_req: any, res: any) => { res.set("content-type", H["content-type"]); res.set("access-control-allow-origin", H["access-control-allow-origin"]); res.set("vary", H.vary); res.send("ok"); });
const mw = (req: any, _res: any, next: any) => { req.hits = (req.hits ?? 0) + 1; next(); };
adapter.use("/mw", mw, mw, mw);
adapter.get("/mw/hit", (req: any, res: any) => { res.send(`mw:${req.hits}`); });
adapter.post("/json", (req: any, res: any) => { res.json({ ok: true, n: req.body.n }); });
const el = new Elysia()
  .get("/user/:id", ({ params }: any) => params.id)
  .get("/async", async () => { await null; return "ok"; })
  .get("/headers", ({ set }: any) => { set.headers = { ...H }; return "ok"; })
  .post("/json", ({ body }: any) => ({ ok: true, n: body.n }));
const cases: [string, () => Request][] = [
  ["param", () => new Request("http://localhost/user/42")],
  ["async", () => new Request("http://localhost/async")],
  ["headers", () => new Request("http://localhost/headers")],
  ["middleware", () => new Request("http://localhost/mw/hit")],
  ["json", () => new Request("http://localhost/json", { method: "POST", body: '{"n":7}', headers: { "content-type": "application/json", "content-length": "7" } })],
];
async function time(f: () => unknown) {
  for (let i = 0; i < 30000; i++) { const r = f(); if (r instanceof Promise) await r; }
  let best = Infinity;
  for (let k = 0; k < 9; k++) { const t = performance.now(); for (let i = 0; i < 50000; i++) { const r = f(); if (r instanceof Promise) await r; } best = Math.min(best, (performance.now() - t) * 20); }
  return best;
}
for (const [name, mk] of cases) {
  const ours = await time(() => (adapter as any).serveNativeRequest(mk(), stub));
  const ely = name === "middleware" ? NaN : await time(() => el.handle(mk()));
  console.log(`${name.padEnd(11)} ours ${ours.toFixed(0).padStart(5)} ns   elysia2 ${ely.toFixed(0).padStart(5)} ns   gap ${(ours - ely).toFixed(0).padStart(5)} ns`);
}
