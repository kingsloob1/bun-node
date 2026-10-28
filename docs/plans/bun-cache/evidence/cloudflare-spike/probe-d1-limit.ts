// D1 probe: the local workerd's string/blob length limit, by bisection.
import { Miniflare } from "miniflare";
const mf = new Miniflare({ modules: true, scriptPath: new URL("./proxy.worker.js", import.meta.url).pathname,
  compatibilityDate: "2026-07-01", d1Databases: { DB: "db-1" }, kvNamespaces: { KV: "kv-1" }, bindings: { TOKEN: "t" }, port: 0 });
const endpoint = new URL("/client/v4/accounts/acct/d1/database/db-1/query", await mf.ready);
async function ok(sql: string, ...params: string[]) {
  const res = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify({ sql, params }) });
  return ((await res.json()) as any).success as boolean;
}
async function bisect(f: (n: number) => Promise<boolean>, lo: number, hi: number) {
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (await f(mid)) lo = mid; else hi = mid; } return lo;
}
console.log("max text param length:", await bisect((n) => ok("SELECT length(?1) AS l", "a".repeat(n)), 1, 8_000_000));
console.log("max zeroblob length:", await bisect((n) => ok("SELECT length(zeroblob(?1)) AS l", String(n)), 1, 8_000_000));
console.log("max hex(blob) result blob length:", await bisect((n) => ok("SELECT length(hex(zeroblob(?1))) AS l", String(n)), 1, 8_000_000));
await mf.dispose();
