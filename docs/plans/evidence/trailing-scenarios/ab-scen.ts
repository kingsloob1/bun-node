// Interleaved A/B per wrk scenario (benchmark registration): a base checkout
// (BASE, e.g. a `git worktree` of the commit before a change) against this one.
process.env.ROUTES = "1000";
const stub = { requestIP: () => null, upgrade: () => false } as never;
async function make(root: string) {
  const lib = await import(`${root}/packages/bun-common/lib/index.ts`);
  const { registerExpressStyle } = await import(`${root}/docs/plans/evidence/bun-native-routes/bench/servers.ts`);
  const app = new lib.BunHttpAdapter(0);
  registerExpressStyle(app as never);
  return (r: Request) => (app as any).serveNativeRequest(r, stub);
}
const BASE = process.env.BASE;
if (!BASE) throw new Error("set BASE to a checkout of the base commit");
const A = await make(BASE), B = await make(`${import.meta.dir}/../../../..`);
let seq = 10_000_000;
const fixed = (p: string) => { const rs = Array.from({ length: 256 }, () => new Request(`http://localhost${p}`)); let i = 0; return () => rs[i++ & 255]; };
const all: [string, () => Request][] = [
  ["static", fixed("/static")], ["param", fixed("/user/42")], ["routes-1000", fixed("/r999/7")],
  ["param-random", () => new Request(`http://localhost/r999/${seq++}`)], ["async", fixed("/async")], ["headers", fixed("/headers")], ["middleware", fixed("/mw/hit")],
];
const want = process.argv.slice(2);
const scen = want.length ? all.filter(([n]) => want.includes(n)) : all;
const N = 20000;
async function round(fn: (r: Request) => unknown, mk: () => Request) {
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < N; i++) { const x = fn(mk()); if (x instanceof Promise) await x; }
  return (Bun.nanoseconds() - t0) / N;
}
for (const [, mk] of scen) for (let w = 0; w < 3; w++) { await round(A, mk); await round(B, mk); }
const res: Record<string, [number[], number[]]> = {};
for (let r = 0; r < 15; r++) for (const [n, mk] of scen) { const e = (res[n] ??= [[], []]); e[0].push(await round(A, mk)); e[1].push(await round(B, mk)); }
for (const [n] of scen) {
  const m = (x: number[]) => x.sort((p, q) => p - q)[7];
  const [a, b] = res[n].map(m);
  console.log(`${n.padEnd(13)} before ${a.toFixed(0).padStart(5)} ns  after ${b.toFixed(0).padStart(5)} ns  ${(((b - a) / a) * 100).toFixed(1).padStart(6)}%`);
}
