// Key-locking with allow-oom probe (2026-10-28): does the server take `#!lua flags=allow-key-locking,allow-oom`, and does
// such a script still run key-locked (a key outside the locked hash tags refused)? It does not fill the database: what
// allow-oom changes when the server is out of memory is not measured here.
// Reads BUN_CACHE_TEST_UPSTASH_REDIS_URL, or REDIS_PROBE_URL for a local server (never printed).
// Writes only under bun-cache-keylock-oom-probe:<pid> and deletes exactly the keys it wrote.
import { RedisClient } from "bun";

const url = process.env.BUN_CACHE_TEST_UPSTASH_REDIS_URL ?? process.env.REDIS_PROBE_URL;
if (!url) throw new Error("no url");
const c = new RedisClient(url);
await c.connect();
const pre = `bun-cache-keylock-oom-probe:${process.pid}`;
const ka = `${pre}:{a}:k`, dynA = `${pre}:{a}:dyn`, dynB = `${pre}:{b}:dyn`;
const written = [ka, dynA, dynB];
const FL = "#!lua flags=allow-key-locking,allow-oom\n";
await c.send("MSET", [ka, "1", dynA, "2"]);
const cases: [string, string, string[], string[]][] = [
  ["combined flags: GET and DEL KEYS[1], UNLINK a key of KEYS[1]'s tag", FL + "local v = redis.call('GET', KEYS[1]) redis.call('DEL', KEYS[1]) return {v, redis.call('UNLINK', ARGV[1])}", [ka], [dynA]],
  ["combined flags: UNLINK a key of another hash tag", FL + "return redis.call('UNLINK', ARGV[1])", [ka], [dynB]],
];
for (const [name, src, keys, args] of cases) {
  try { console.log(`${name} -> ${JSON.stringify(await c.eval(src, keys.length, ...keys, ...args))}`); }
  catch (e) { console.log(`${name} -> ERROR ${(e as Error).message}`); }
}
const src = FL + "return redis.call('EXISTS', KEYS[1])";
try {
  const sha = (await c.send("SCRIPT", ["LOAD", src])) as string;
  const hasher = new Bun.CryptoHasher("sha1"); hasher.update(src);
  console.log(`SCRIPT LOAD combined -> sha matches local SHA-1: ${sha === hasher.digest("hex")}`);
  console.log(`EVALSHA combined -> ${JSON.stringify(await c.evalsha(sha, 1, ka))}`);
} catch (e) { console.log(`SCRIPT LOAD/EVALSHA combined -> ERROR ${(e as Error).message}`); }
console.log(`UNLINK exact probe keys -> ${await c.unlink(...written)}`);
console.log(`left under probe prefix (EXISTS on the 3 names) -> ${await c.send("EXISTS", written)}`);
c.close();
