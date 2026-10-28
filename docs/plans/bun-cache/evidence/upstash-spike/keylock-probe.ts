// Key-locking probe (2026-10-28): does the server take `#!lua flags=allow-key-locking`, and which keys outside KEYS may a
// flagged script touch? Reads BUN_CACHE_TEST_UPSTASH_REDIS_URL, or REDIS_PROBE_URL for a local server (never printed).
// Writes only under bun-cache-keylock-probe:<pid> and deletes exactly the keys it wrote.
import { RedisClient } from "bun";
const url = process.env.BUN_CACHE_TEST_UPSTASH_REDIS_URL ?? process.env.REDIS_PROBE_URL;
if (!url) throw new Error("no url");
const c = new RedisClient(url);
await c.connect();
const info = (await c.send("INFO", ["server"])) as string;
console.log(info.match(/upstash_version:\S+/)?.[0], info.match(/redis_version:\S+/)?.[0]);
const pre = `bun-cache-keylock-probe:${process.pid}`;
const ka = `${pre}:{a}:k`, dynA = `${pre}:{a}:dyn`, dynB = `${pre}:{b}:dyn`, setA = `${pre}:{a}:set`;
const written = [ka, dynA, dynB, setA];
const FL = "#!lua flags=allow-key-locking\n";
const cases: [string, string, string[], string[]][] = [
  ["flagged, KEYS[1] only", FL + "return redis.call('SET', KEYS[1], 'x')", [ka], []],
  ["flagged, dynamic key with KEYS[1]'s hash tag", FL + "redis.call('SET', KEYS[1], 'x') return redis.call('SET', ARGV[1], 'y')", [ka], [dynA]],
  ["flagged, dynamic key of another hash tag", FL + "redis.call('SET', KEYS[1], 'x') return redis.call('SET', ARGV[1], 'y')", [ka], [dynB]],
  ["flagged, no KEYS, dynamic key", FL + "return redis.call('SET', ARGV[1], 'y')", [], [dynB]],
  ["flagged, SMEMBERS-derived keys with KEYS[1]'s tag", FL + "redis.call('SADD', KEYS[1], ARGV[1]) local n = 0 for _, m in ipairs(redis.call('SMEMBERS', KEYS[1])) do n = n + redis.call('EXISTS', m) end return n", [setA], [dynA]],
  ["unflagged, dynamic key of another hash tag (control)", "redis.call('SET', KEYS[1], 'x') return redis.call('SET', ARGV[1], 'y')", [ka], [dynB]],
];
for (const [name, src, keys, args] of cases) {
  try { console.log(`${name} -> ${JSON.stringify(await c.eval(src, keys.length, ...keys, ...args))}`); }
  catch (e) { console.log(`${name} -> ERROR ${(e as Error).message}`); }
}
// EVALSHA path: SCRIPT LOAD a flagged script, then EVALSHA it (the driver tries EVALSHA first).
const src = FL + "return redis.call('GET', KEYS[1])";
try {
  const sha = (await c.send("SCRIPT", ["LOAD", src])) as string;
  const hasher = new Bun.CryptoHasher("sha1"); hasher.update(src);
  console.log(`SCRIPT LOAD flagged -> sha matches local SHA-1: ${sha === hasher.digest("hex")}`);
  console.log(`EVALSHA flagged -> ${JSON.stringify(await c.evalsha(sha, 1, ka))}`);
} catch (e) { console.log(`SCRIPT LOAD/EVALSHA flagged -> ERROR ${(e as Error).message}`); }
console.log(`UNLINK exact probe keys -> ${await c.unlink(...written)}`);
console.log(`left under probe prefix (EXISTS on the 4 names) -> ${await c.send("EXISTS", written)}`);
c.close();
