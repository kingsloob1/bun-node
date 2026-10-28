// Upstash probe 2: expiry offset vs horizon, cross-connection read-your-writes, command counters.
import { RedisClient } from "bun";

const url = process.env.BUN_CACHE_TEST_UPSTASH_REDIS_URL ?? process.env.REDIS_PROBE_URL!;
const run = `bun-cache-probe:${process.pid}-${Date.now().toString(36)}`;
const created = new Set<string>();
const k = (s: string) => {
  const key = `${run}:{p}:${s}`;
  created.add(key);
  return key;
};
const a = new RedisClient(url);
const b = new RedisClient(url);
await a.connect();
await b.connect();

const stats = async () => {
  const info = (await a.send("INFO", ["stats"])) as string;
  return info.split(/\r?\n/).filter((l) => /commands|ops|calls/i.test(l)).join(" | ");
};
console.log("INFO stats:", await stats());
try {
  const cs = (await a.send("INFO", ["commandstats"])) as string;
  console.log("INFO commandstats (first 300):", JSON.stringify(cs.slice(0, 300)));
} catch (e) {
  console.log("commandstats FAIL", String(e));
}

console.log("--- expiry offset by horizon (PEXPIRETIME - requested)");
for (const horizon of [1_000, 60_000, 3_600_000, 86_400_000, 30 * 86_400_000]) {
  const diffs: number[] = [];
  for (let i = 0; i < 4; i++) {
    const key = k(`h${horizon}-${i}`);
    const at = Date.now() + horizon;
    await a.send("SET", [key, "v", "PXAT", String(at)]);
    diffs.push(Number(await a.send("PEXPIRETIME", [key])) - at);
  }
  console.log(`+${horizon} ms: ${diffs.join(", ")}`);
}
console.log("--- PX relative: PTTL right after SET PX 60000");
{
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const key = k(`px-${i}`);
    await a.send("SET", [key, "v", "PX", "60000"]);
    out.push(Number(await a.send("PTTL", [key])));
  }
  console.log(out.join(", "));
}

console.log("--- cross-connection read-your-writes (write on a, read on b at once)");
{
  let stale = 0;
  for (let i = 0; i < 30; i++) {
    const key = k(`ryw-${i}`);
    await a.set(key, String(i));
    const got = await b.get(key);
    if (got !== String(i)) stale++;
  }
  console.log(`stale reads on b: ${stale}/30`);
  let staleEval = 0;
  for (let i = 0; i < 30; i++) {
    const key = k(`ryw-e-${i}`);
    await a.eval("redis.call('SET', KEYS[1], ARGV[1]) return 1", 1, key, String(i));
    const got = await b.get(key);
    if (got !== String(i)) staleEval++;
  }
  console.log(`stale reads on b after a Lua write on a: ${staleEval}/30`);
}
console.log("INFO stats after:", await stats());

let n = 0;
for (const key of created) n += Number(await a.unlink(key));
console.log("deleted", n, "keys");
a.close();
b.close();
