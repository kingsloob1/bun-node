/**
 * SSE fan-out: events/s delivered and memory per connection, for each target
 * in perf-server.ts, at several client counts. Interleaved rounds, one fresh
 * server process per cell, median reported, every run kept.
 *
 *   bun docs/plans/evidence/bun-native-routes/sse/perf.ts [rounds=3] [--out results/perf.json]
 *   SSE_SHAPES=10x100 bun …/perf.ts 1 --out /tmp/x.json   (a smoke run)
 */
import { join, resolve } from "node:path";

const dir = import.meta.dir;
const rounds = Number(process.argv[2] ?? 3);
const outIdx = process.argv.indexOf("--out");
const out = outIdx > 0 ? resolve(dir, process.argv[outIdx + 1]) : join(dir, "results/perf.json");
// SSE_TARGETS=raw,raw-hwm overrides.
const targets = process.env.SSE_TARGETS?.split(",") ?? ["raw", "raw-hwm", "raw-direct", "common-write", "common-proto", "nest-sse"];
// SSE_SHAPES=10x100,100x2000 overrides (clients x events each).
const shapes: [number, number][] = process.env.SSE_SHAPES
  ? process.env.SSE_SHAPES.split(",").map((s) => s.split("x").map(Number) as [number, number])
  : [[100, 1000], [1000, 100]];

interface Run { target: string; n: number; m: number; round: number; load: number; baseRss: number; connectMs: number; deliverMs: number; eventsPerSec: number; memIdle: number; memAfter: number }
const runs: Run[] = [];

async function cell(target: string, n: number, m: number, round: number): Promise<void> {
  const server = Bun.spawn(["bun", join(dir, "perf-server.ts"), target], { stdout: "pipe", stderr: "inherit", env: { ...process.env, NODE_ENV: "production" } });
  const reader = server.stdout.getReader();
  let text = "";
  while (!/PORT (\d+)/.test(text)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`${target} exited: ${text}`);
    text += new TextDecoder().decode(value);
  }
  const port = Number(/PORT (\d+)/.exec(text)![1]);
  const baseRss = Number(await (await fetch(`http://127.0.0.1:${port}/mem`)).text());
  const load = (await Bun.file("/proc/loadavg").text()).split(" ")[0];
  const client = Bun.spawn(["bun", join(dir, "perf-clients.ts"), String(port), String(n), String(m)], { stdout: "pipe", stderr: "inherit" });
  const result = await Promise.race([new Response(client.stdout).text(), Bun.sleep(120_000).then(() => "")]);
  client.kill();
  server.kill();
  await server.exited;
  if (!result.trim()) {
    console.log(`${target} n=${n}: timed out`);
    return;
  }
  const r = { target, round, load: Number(load), baseRss, ...JSON.parse(result) } as Run;
  runs.push(r);
  console.log(`r${round} ${target.padEnd(13)} n=${String(n).padEnd(5)} m=${m} ${String(r.eventsPerSec).padStart(9)} ev/s  ${((r.memIdle - baseRss) / n / 1024).toFixed(1).padStart(6)} KiB/conn idle  ${((r.memAfter - baseRss) / n / 1024).toFixed(1).padStart(6)} KiB/conn after  load ${load}`);
}

for (let round = 1; round <= rounds; round++) {
  for (const [n, m] of shapes) {
    for (const t of targets) await cell(t, n, m, round);
  }
}
await Bun.write(out, JSON.stringify({ bun: Bun.revision, date: new Date().toISOString(), runs }, null, 2));

const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log("\nmedian of rounds");
for (const [n, m] of shapes) {
  for (const t of targets) {
    const rs = runs.filter((r) => r.target === t && r.n === n);
    if (!rs.length) continue;
    console.log(`${t.padEnd(13)} n=${String(n).padEnd(5)} m=${m} ${String(median(rs.map((r) => r.eventsPerSec))).padStart(9)} ev/s  idle ${(median(rs.map((r) => (r.memIdle - r.baseRss) / n)) / 1024).toFixed(1)} KiB/conn  after ${(median(rs.map((r) => (r.memAfter - r.baseRss) / n)) / 1024).toFixed(1)} KiB/conn`);
  }
}
process.exit(0);
