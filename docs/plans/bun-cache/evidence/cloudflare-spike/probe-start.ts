// Start-up and footprint: time to `ready`, the workerd child's RSS, and dispose.
import { Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
const t0 = performance.now();
const mf = new Miniflare({ modules: true, scriptPath: new URL("./proxy.worker.js", import.meta.url).pathname,
  compatibilityDate: "2026-07-01", kvNamespaces: { KV: "kv-1" }, d1Databases: { DB: "db-1" }, bindings: { TOKEN: "t" }, port: 0 });
await mf.ready;
const ready = performance.now() - t0;
let rss = 0;
for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
  try { const stat = readFileSync(`/proc/${pid}/status`, "utf8");
    if (/PPid:\s+(\d+)/.exec(stat)?.[1] === String(process.pid) && /Name:\s+workerd/.test(stat)) rss += Number(/VmRSS:\s+(\d+)/.exec(stat)?.[1]); } catch {}
}
const t1 = performance.now(); await mf.dispose();
console.log(`ready ${ready.toFixed(0)} ms, workerd RSS ${(rss / 1024).toFixed(0)} MiB, dispose ${(performance.now() - t1).toFixed(0)} ms`);
