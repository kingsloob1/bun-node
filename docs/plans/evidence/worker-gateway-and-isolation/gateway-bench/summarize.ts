// Summarises results.ndjson: median throughput of the runs, and latency.
//   bun summarize.ts [results.ndjson]
const file = process.argv[2] ?? `${import.meta.dir}/results.ndjson`;
const rows = (await Bun.file(file).text()).trim().split("\n").map((l) => JSON.parse(l));
const key = (r: any) => `${r.backend}|${r.batch}|${r.mode}`;
const groups = new Map<string, any[]>();
for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
console.log("| backend | batch | mode | jobs/s (median of runs) | runs | p50 ms | p90 ms | p99 ms | load (1m) |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const [k, rs] of groups) {
  const tp = rs.filter((r) => r.jobsPerSec).map((r) => r.jobsPerSec).sort((a, b) => a - b);
  const lat = rs.find((r) => r.p50ms);
  const [b, batch, mode] = k.split("|");
  const loads = rs.map((r) => r.loadavg.split(" ")[0]);
  console.log(`| ${b} | ${batch} | ${mode} | ${tp.length ? tp[Math.floor(tp.length / 2)].toLocaleString("en-US") : "—"} | ${tp.join(", ")} | ${lat?.p50ms ?? "—"} | ${lat?.p90ms ?? "—"} | ${lat?.p99ms ?? "—"} | ${loads.join("/")} |`);
}
