process.env.ROUTES = "1000";
const lib = await import("../../../../packages/bun-common/lib/index.ts");
const { Elysia } = await import("../../../../benchmarks/node_modules/elysia2");
const stub = { requestIP: () => null, upgrade: () => false } as never;
const app = new lib.BunHttpAdapter(0);
app.get("/static", (_q: any, s: any) => s.send("ok"));
app.post("/json", (q: any, s: any) => s.json({ ok: true, n: q.body.n }));
app.get("/async", async (_q: any, s: any) => { await null; s.send("ok"); });
for (let i = 0; i < 1000; i++) app.get(`/r${i}/:id`, (q: any, s: any) => s.send(`r${i}:${q.params.id}`));
let e: any = new Elysia().get("/static", () => "ok").post("/json", ({ body }: any) => ({ ok: true, n: body.n }))
  .get("/async", async () => { await null; return "ok"; });
for (let i = 0; i < 1000; i++) e = e.get(`/r${i}/:id`, ({ params }: any) => `r${i}:${params.id}`);
const ours = (r: Request) => (app as any).serveNativeRequest(r, stub);
const ely = (r: Request) => e.fetch(r);
let seq = 10_000_000;
const mk: Record<string, () => Request> = {
  static: () => new Request("http://localhost/static"),
  json: () => new Request("http://localhost/json", { method: "POST", headers: { "content-type": "application/json", "content-length": "7" }, body: '{"n":7}' }),
  async: () => new Request("http://localhost/async"),
  "param-random": () => new Request(`http://localhost/r999/${seq++}`),
};
const N = 100_000;
async function run(f: (r: Request) => any, m: () => Request) {
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < N; i++) { const x = f(m()); const res = x instanceof Promise ? await x : x; if (i === 0 && !(res instanceof Response)) throw new Error("no response"); }
  const t1 = Bun.nanoseconds();
  for (let i = 0; i < N; i++) m();
  return ((t1 - t0) - (Bun.nanoseconds() - t1)) / N;
}
for (const name of Object.keys(mk)) { await run(ours, mk[name]); await run(ely, mk[name]); }
const res: Record<string, [number[], number[]]> = {};
for (let r = 0; r < 7; r++) for (const name of Object.keys(mk)) { const x = (res[name] ??= [[], []]); x[0].push(await run(ours, mk[name])); x[1].push(await run(ely, mk[name])); }
const med = (a: number[]) => a.sort((p, q) => p - q)[3];
for (const name of Object.keys(mk)) {
  const [o, el] = res[name].map(med);
  console.log(`${name.padEnd(13)} bun-common ${o.toFixed(0).padStart(5)} ns  elysia2 ${el.toFixed(0).padStart(5)} ns  gap ${(o - el).toFixed(0).padStart(5)} ns`);
}
