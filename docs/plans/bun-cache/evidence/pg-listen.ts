// Postgres LISTEN/NOTIFY latency through Bun's sql.listen / sql.notify: the
// time from notify() being called on one SQL instance to the payload arriving
// on another's listener. Sequential (one in flight) and burst (500 at once).
// Run: BUN_JOBS_TEST_POSTGRES_URL=postgres://bunjobs:bunjobs@127.0.0.1:5432/bun_jobs_test bun pg-listen.ts
import { SQL } from "bun";

const url = process.env.BUN_JOBS_TEST_POSTGRES_URL;
if (!url) { console.log("BUN_JOBS_TEST_POSTGRES_URL unset: skipped"); process.exit(0); }
const channel = `cacheplan_${process.pid}`;
const a = new SQL(url, { max: 2 });
const b = new SQL(url, { max: 2 });
const pct = (xs: number[], p: number) => xs.slice().sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!.toFixed(3);

const waiting = new Map<string, (t: number) => void>();
const sub = await b.listen(channel, (payload) => { waiting.get(payload)?.(performance.now()); });

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)}), channel ${channel}`);
for (const [label, n] of [["warm-up", 50], ["sequential", 1000]] as const) {
  const lat: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${label}:${i}`;
    const got = new Promise<number>(r => waiting.set(id, r));
    const t0 = performance.now();
    await a.notify(channel, id);
    lat.push((await got) - t0);
    waiting.delete(id);
  }
  if (label !== "warm-up") console.log(`${label} n=${n}: p50 ${pct(lat, 0.5)} ms, p95 ${pct(lat, 0.95)} ms, p99 ${pct(lat, 0.99)} ms, max ${pct(lat, 1)} ms`);
}
{
  const n = 500;
  const t0 = performance.now();
  const arrivals = Array.from({ length: n }, (_, i) => new Promise<number>(r => waiting.set(`burst:${i}`, r)));
  await Promise.all(Array.from({ length: n }, (_, i) => a.notify(channel, `burst:${i}`)));
  const times = (await Promise.all(arrivals)).map(t => t - t0);
  console.log(`burst n=${n} notifies issued together: last arrives at ${pct(times, 1)} ms, p50 ${pct(times, 0.5)} ms (${Math.round(n / (Math.max(...times) / 1000))} notifications/s)`);
}
{ // payload limit: pg rejects payloads >= 8000 bytes
  try { await a.notify(channel, "x".repeat(8000)); console.log("8000-byte payload: accepted"); }
  catch (e) { console.log(`8000-byte payload: rejected (${(e as Error).message.split("\n")[0]})`); }
}
await sub.unlisten();
await a.close(); await b.close();
console.log(`load average at end: ${(await Bun.file("/proc/loadavg").text()).trim()}`);
