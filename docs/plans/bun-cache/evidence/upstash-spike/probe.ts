// Upstash probe: latency, command availability, expiry exactness, reply types.
// Reads the URL from UPSTASH_TEST_REDIS_URL (never printed). Keys under a run prefix, deleted at the end.
import { RedisClient } from "bun";

const url = process.env.BUN_CACHE_TEST_UPSTASH_REDIS_URL ?? process.env.REDIS_PROBE_URL;
if (!url) throw new Error("no url");
const label = process.env.BUN_CACHE_TEST_UPSTASH_REDIS_URL ? "upstash" : "local";
const run = `bun-cache-probe:${process.pid}-${Date.now().toString(36)}`;
const created = new Set<string>();
const k = (s: string) => {
  const key = `${run}:{p}:${s}`;
  created.add(key);
  return key;
};
const redact = (s: string) => s.replace(/rediss?:\/\/[^ "]*/g, "<redacted>");

const t0 = performance.now();
const c = new RedisClient(url);
await c.connect();
console.log(label, "connect ms", (performance.now() - t0).toFixed(1));

async function timeit(name: string, n: number, f: () => Promise<unknown>) {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    await f();
    ms.push(performance.now() - s);
  }
  ms.sort((a, b) => a - b);
  console.log(
    `latency ${name}: p50 ${ms[Math.floor(n / 2)].toFixed(1)} ms, min ${ms[0].toFixed(1)}, max ${ms[n - 1].toFixed(1)} (n=${n})`,
  );
}

async function tryCmd(name: string, f: () => Promise<unknown>) {
  try {
    const r = await f();
    const shown = (typeof r === "string" ? JSON.stringify(r.slice(0, 120)) : Bun.inspect(r).slice(0, 160)).replace(
      /addr=[0-9.:]+/g,
      "addr=<redacted>",
    );
    console.log(`ok   ${name}: ${typeof r} ${shown}`);
    return r;
  } catch (e) {
    console.log(`FAIL ${name}: ${redact(e instanceof Error ? e.message : String(e))}`);
    return undefined;
  }
}

await timeit("PING", 20, () => c.send("PING", []));
await c.set(k("a"), "x");
await timeit("GET", 20, () => c.get(k("a")));
await timeit("SET", 20, () => c.set(k("a"), "x"));
const sha = (await tryCmd("SCRIPT LOAD", () => c.send("SCRIPT", ["LOAD", "return 1"]))) as string;
await timeit("EVALSHA", 20, () => c.evalsha(sha, 0));
// Pipelined: 50 concurrent GETs on one connection.
{
  const s = performance.now();
  await Promise.all(Array.from({ length: 50 }, () => c.get(k("a"))));
  console.log(`latency 50 pipelined GETs: ${(performance.now() - s).toFixed(1)} ms total`);
}

console.log("--- availability");
await tryCmd("TIME", () => c.send("TIME", []));
await tryCmd("INFO cluster", () => c.send("INFO", ["cluster"]));
await tryCmd("INFO server (version line)", async () => {
  const s = (await c.send("INFO", ["server"])) as string;
  return s.split(/\r?\n/).filter((l) => /redis_version|upstash|mode/.test(l)).join(" | ");
});
await tryCmd("CLIENT SETNAME", () => c.send("CLIENT", ["SETNAME", "probe-name"]));
await tryCmd("CLIENT GETNAME", () => c.send("CLIENT", ["GETNAME"]));
await tryCmd("CLIENT ID", () => c.send("CLIENT", ["ID"]));
await tryCmd("CLIENT LIST", () => c.send("CLIENT", ["LIST"]));
await tryCmd("CLIENT LIST TYPE pubsub", () => c.send("CLIENT", ["LIST", "TYPE", "pubsub"]));
await tryCmd("CLIENT KILL ID 999999", () => c.send("CLIENT", ["KILL", "ID", "999999"]));
await tryCmd("SCRIPT FLUSH", () => c.send("SCRIPT", ["EXISTS", sha]));
await tryCmd("UNLINK", () => c.unlink(k("nothing")));
await tryCmd("SCAN MATCH", () => c.scan("0", "MATCH", `${run}:*`, "COUNT", 1000));
await tryCmd("MSET", () => c.mset(k("m1"), "1", k("m2"), "2"));
await tryCmd("MGET", () => c.mget(k("m1"), k("m2"), k("none")));
await tryCmd("HSET", () => c.send("HSET", [k("h"), "n", "1", "x", "-", "c", "5"]));
await tryCmd("HMGET", () => c.hmget(k("h"), "n", "x", "c"));
await tryCmd("HINCRBY", () => c.send("HINCRBY", [k("h"), "n", "4"]));
await tryCmd("PERSIST", () => c.send("PERSIST", [k("h")]));
await tryCmd("EXISTS", () => c.exists(k("h")));
await tryCmd("PTTL", () => c.pttl(k("h")));
await tryCmd("getBuffer", () => c.getBuffer(k("m1")));
await tryCmd("set bytes + getBuffer exact", async () => {
  const bytes = new Uint8Array(256).map((_, i) => i);
  await c.set(k("bytes"), bytes as unknown as string);
  const back = await c.getBuffer(k("bytes"));
  return back !== null && back.length === 256 && back.every((b, i) => b === i);
});
await tryCmd("Lua cjson", () => c.eval("return cjson.encode({1,2})", 0));
await tryCmd("Lua redis.pcall err table", () =>
  c.eval("local r = redis.pcall('HGET', KEYS[1], 'x') return type(r)", 1, k("m1")),
);
await tryCmd("Lua UNLINK", () => c.eval("return redis.call('UNLINK', KEYS[1])", 1, k("m2")));
await tryCmd("Lua tonumber return", () => c.eval("return tonumber(ARGV[1])", 0, "7"));
await tryCmd("Lua HINCRBY return", () => c.eval("return redis.call('HINCRBY', KEYS[1], 'n', 2)", 1, k("h")));
await tryCmd("Lua string.match/find", () =>
  c.eval("return string.match('1 5 [\"a\"]', '^1 %S+ (.*)$')", 0),
);
await tryCmd("Lua bytes arg", async () => {
  const bytes = new Uint8Array(256).map((_, i) => i);
  await c.eval("redis.call('SET', KEYS[1], ARGV[1]) return 1", 1, k("lb"), bytes as unknown as string);
  const back = await c.getBuffer(k("lb"));
  return back !== null && back.length === 256 && back.every((b, i) => b === i);
});
await tryCmd("Lua keys not declared (base .. 'e:' .. key)", () =>
  c.eval("redis.call('SET', ARGV[1], 'v') return redis.call('GET', ARGV[1])", 0, k("undeclared")),
);

console.log("--- expiry exactness (PEXPIRETIME - requested, ms)");
async function expiryDiffs(name: string, f: (key: string, at: number) => Promise<unknown>) {
  const diffs: number[] = [];
  for (let i = 0; i < 8; i++) {
    const key = k(`exp-${name}-${i}`);
    const at = Date.now() + 60_000;
    await f(key, at);
    const got = Number(await c.send("PEXPIRETIME", [key]));
    diffs.push(got - at);
  }
  console.log(`${name}: ${diffs.join(", ")}`);
}
await expiryDiffs("SET+PEXPIREAT", async (key, at) => {
  await c.set(key, "v");
  await c.send("PEXPIREAT", [key, String(at)]);
});
await expiryDiffs("SET PXAT", async (key, at) => {
  await c.send("SET", [key, "v", "PXAT", String(at)]);
});
await expiryDiffs("Lua SET + PEXPIREAT", async (key, at) => {
  await c.eval("redis.call('SET', KEYS[1], 'v') redis.call('PEXPIREAT', KEYS[1], ARGV[1]) return 1", 1, key, String(at));
});
await expiryDiffs("Lua SET PXAT", async (key, at) => {
  await c.eval("redis.call('SET', KEYS[1], 'v', 'PXAT', ARGV[1]) return 1", 1, key, String(at));
});
await expiryDiffs("Lua SET + PEXPIREAT, PEXPIRETIME in Lua", async (key, at) => {
  const r = await c.eval(
    "redis.call('SET', KEYS[1], 'v') redis.call('PEXPIREAT', KEYS[1], ARGV[1]) return redis.call('PEXPIRETIME', KEYS[1])",
    1,
    key,
    String(at),
  );
  console.log(`   in-script PEXPIRETIME - at = ${Number(r) - at}`);
});
// Server clock vs ours.
{
  const before = Date.now();
  const [s, us] = (await c.send("TIME", [])) as [string, string];
  const after = Date.now();
  const server = Number(s) * 1000 + Number(us) / 1000;
  console.log(`server TIME - local midpoint: ${(server - (before + after) / 2).toFixed(1)} ms (rtt ${after - before} ms)`);
}
// Short expiry: does a 100 ms entry survive set + one read?
{
  const key = k("short");
  const at = Date.now() + 100;
  await c.send("SET", [key, "v", "PXAT", String(at)]);
  const r = await c.get(key);
  console.log(`100 ms entry readable after set: ${r !== null} (now - at = ${Date.now() - at} ms)`);
}

console.log("--- pub/sub");
{
  const sub = await c.duplicate();
  await sub.connect();
  await tryCmd("sub CLIENT SETNAME", () => sub.send("CLIENT", ["SETNAME", "probe-sub"]));
  const got: string[] = [];
  await sub.subscribe(`${run}:bus`, (m) => got.push(m));
  const s = performance.now();
  await c.publish(`${run}:bus`, "hello");
  while (got.length === 0 && performance.now() - s < 5000) await Bun.sleep(5);
  console.log(`publish → message: ${got.length === 1 ? (performance.now() - s).toFixed(1) + " ms" : "NOT RECEIVED"}`);
  await tryCmd("CLIENT LIST TYPE pubsub (with a subscriber)", () => c.send("CLIENT", ["LIST", "TYPE", "pubsub"]));
  await sub.unsubscribe(`${run}:bus`);
  sub.close();
}

// cleanup
let n = 0;
for (const key of created) n += Number(await c.unlink(key));
console.log("deleted", n, "keys");
c.close();
