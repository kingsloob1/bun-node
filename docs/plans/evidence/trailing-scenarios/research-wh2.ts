const lib = await import("../../../../packages/bun-common/lib/index.ts");
const { Elysia } = await import("../../../../benchmarks/node_modules/elysia2");
const stub = { requestIP: () => null, upgrade: () => false } as never;
const H = { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*", vary: "Origin" };
const app = new lib.BunHttpAdapter(0);
app.get("/static", (_q: any, s: any) => s.send("ok"));
app.get("/user/:id", (q: any, s: any) => s.send(q.params.id));
app.get("/assets/*", (_q: any, s: any) => s.send("ok"));
app.get("/headers", (_q: any, s: any) => { s.set("content-type", H["content-type"]); s.set("access-control-allow-origin", "*"); s.set("vary", "Origin"); s.send("ok"); });
for (let i = 0; i < 1000; i++) app.get(`/r${i}/:id`, (q: any, s: any) => s.send(`r${i}:${q.params.id}`));
let e: any = new Elysia().get("/static", () => "ok").get("/user/:id", ({ params }: any) => params.id).get("/assets/*", () => "ok")
  .get("/headers", ({ set }: any) => { Object.assign(set.headers, H); return "ok"; });
for (let i = 0; i < 1000; i++) e = e.get(`/r${i}/:id`, ({ params }: any) => `r${i}:${params.id}`);
const ours = (r: Request) => (app as any).serveNativeRequest(r, stub);
const ely = (r: Request) => e.fetch(r);
let seq = 10_000_000;
const mk: Record<string, () => Request> = {
  static: () => new Request("http://localhost/static"),
  param: () => new Request("http://localhost/user/42"),
  wildcard: () => new Request("http://localhost/assets/css/site/app.css"),
  headers: () => new Request("http://localhost/headers"),
  "wildcard-random": () => new Request(`http://localhost/assets/${seq++}/site/app.css`),
};
const N = 100_000;
async function run(f: (r: Request) => any, m: () => Request) {
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < N; i++) { const x = f(m()); if (x instanceof Promise) await x; }
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
  console.log(`${name.padEnd(9)} bun-common ${o.toFixed(0).padStart(5)} ns  elysia2 ${el.toFixed(0).padStart(5)} ns  gap ${(o - el).toFixed(0).padStart(5)} ns`);
}
// response header check
const r1 = await ours(mk.headers()); const r2 = await ely(mk.headers());
console.log("ours", [...r1.headers]); console.log("ely ", [...r2.headers]);
