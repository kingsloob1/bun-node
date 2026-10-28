// First-connect time to the server, and how often the driver's default firstConnectTimeout (1 s) refuses it.
import { RedisClient } from "bun";
import { RedisCacheDriver } from "../../../../../packages/bun-cache/lib/drivers/redis";

const url = process.env.BUN_CACHE_TEST_UPSTASH_REDIS_URL ?? process.env.REDIS_PROBE_URL!;
const n = Number(process.argv[2] ?? 10);
const times: number[] = [];
for (let i = 0; i < n; i++) {
  const c = new RedisClient(url);
  const s = performance.now();
  await c.connect();
  times.push(performance.now() - s);
  c.close();
}
times.sort((a, b) => a - b);
console.log(`RedisClient.connect(): min ${times[0].toFixed(0)} p50 ${times[Math.floor(n / 2)].toFixed(0)} max ${times[n - 1].toFixed(0)} ms (n=${n})`);
let refused = 0;
const dtimes: number[] = [];
for (let i = 0; i < n; i++) {
  const d = new RedisCacheDriver({ url, prefix: `bun-cache-probe:${process.pid}` });
  const s = performance.now();
  try {
    await d.connect();
    dtimes.push(performance.now() - s);
  } catch (e) {
    refused++;
    console.log("driver connect failed:", (e instanceof Error ? e.message : String(e)).replace(/rediss?:\/\/[^ "]*/g, "<redacted>"));
  }
  await d.close();
}
dtimes.sort((a, b) => a - b);
console.log(`driver.connect() (default firstConnectTimeout): ${refused}/${n} failed; ok: ${dtimes.map((t) => t.toFixed(0)).join(", ")} ms`);
