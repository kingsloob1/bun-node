/**
 * The first read of each native `Request` property on a fresh request (Bun
 * materialises some lazily), minus the `new Request` floor. Elysia 2 reads
 * only `url` and `method` on its fast lane (fetch.mjs extractPath/findRoute)
 * and defers `signal` (adapter/origin.mjs); bun-common's constructor reads
 * `headers` eagerly. In-process requests only: a served request's lazy
 * fields come from uWS and may cost differently [U].
 *
 *   BUN_OPTIONS= bun first-access.ts
 */
const N = 300_000;
const sink: unknown[] = [];
function time(label: string, fn: () => unknown): number {
  for (let i = 0; i < 50_000; i++) sink[i & 7] = fn();
  let best = Infinity;
  for (let p = 0; p < 5; p++) {
    const t0 = Bun.nanoseconds();
    for (let i = 0; i < N; i++) sink[i & 7] = fn();
    best = Math.min(best, (Bun.nanoseconds() - t0) / N);
  }
  return best;
}
const url = "http://localhost/user/42";
const init = { headers: { host: "localhost", "user-agent": "wrk", accept: "*/*" } };
for (const [name, mk] of [
  ["no headers", () => new Request(url)],
  ["3 headers", () => new Request(url, init)],
] as const) {
  const floor = time("floor", mk);
  console.log(`\nfresh Request (${name}); floor ${floor.toFixed(0)} ns; first read costs:`);
  for (const [label, read] of [
    ["url", (r: Request) => r.url],
    ["method", (r: Request) => r.method],
    ["headers", (r: Request) => r.headers],
    ["headers.get('host')", (r: Request) => r.headers.get("host")],
    ["body", (r: Request) => r.body],
    ["signal", (r: Request) => r.signal],
    ["url + method + headers + body", (r: Request) => [r.url, r.method, r.headers, r.body]],
  ] as const) {
    const t = time(label, () => read(mk()));
    console.log(`  ${label.padEnd(34)} ${(t - floor).toFixed(0).padStart(6)} ns`);
  }
}
