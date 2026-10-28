// What PR-E1's built-in encryption adds to whole cache operations, on the real
// core: `set` and `get` through `createCache`, plain against
// `encrypt: { keys }` (AES-256-GCM, a key per entry), on the memory driver (no
// network to hide behind) and on the Redis driver (BUN_CACHE_TEST_REDIS_URL,
// a run-specific prefix, deleted key by key at the end). Values are
// cache-shaped JSON records of ~100 B, ~4 KiB, ~70 KB and ~1 MiB through the
// default codec and zstd (from 16 KiB), as in bench-ciphers.ts section 2.
// Rounds alternate plain and encrypted; each cell is the median of 5 rounds,
// µs per op of wall time.
// Run: nice -n 10 bun bench-e1-overhead.ts
import process from "node:process";

const LIB =
  process.env.BUN_CACHE_LIB ||
  new URL("../../../../../packages/bun-cache/lib/index.ts", import.meta.url)
    .pathname;
const { createCache, memoryDriver, redisDriver } = (await import(
  LIB
)) as typeof import("../../../../../packages/bun-cache/lib/index.ts");

const KEYS = [{ id: "2026-10", key: crypto.getRandomValues(new Uint8Array(32)) }];
const ROUNDS = 5;
const SIZES = [
  { label: "100 B", bytes: 100, memory: 20_000, redis: 2_000 },
  { label: "4 KiB", bytes: 4096, memory: 10_000, redis: 2_000 },
  { label: "70 KB", bytes: 70_000, memory: 1_000, redis: 400 },
  { label: "1 MiB", bytes: 1024 * 1024, memory: 60, redis: 40 },
];

/** Deterministic JSON-ish records, about `bytes` long as JSON. */
function records(bytes: number): unknown {
  const out: { id: number; name: string; email: string; tags: string[]; score: number }[] = [];
  let length = 2;
  for (let i = 0; length < bytes; i++) {
    const row = {
      id: i,
      name: `user ${i} ${"abcdefghij".slice(i % 7)}`,
      email: `user${i}@example.com`,
      tags: ["alpha", "beta", "gamma"].slice(0, (i % 3) + 1),
      score: (i * 7919) % 1000,
    };
    out.push(row);
    length += JSON.stringify(row).length + 1;
  }
  return bytes <= 120 ? { id: 1, name: "Ada Lovelace", email: "ada@example.com", admin: false } : out;
}

type Cache = ReturnType<typeof createCache>;

async function time(n: number, run: (i: number) => Promise<unknown>): Promise<number> {
  const started = Bun.nanoseconds();
  for (let i = 0; i < n; i++) {
    await run(i);
  }
  return (Bun.nanoseconds() - started) / 1000 / n;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

async function measure(
  name: string,
  make: (encrypted: boolean) => Cache,
  count: (size: (typeof SIZES)[number]) => number,
): Promise<void> {
  console.log(`\n## ${name}\n`);
  console.log("| Value | Stored plain / sealed | set plain | set sealed | + | get plain | get sealed | + |");
  console.log("|---|---|---|---|---|---|---|---|");
  const plain = make(false);
  const sealed = make(true);
  for (const size of SIZES) {
    const value = records(size.bytes);
    const n = count(size);
    const keyOf = (i: number) => `bench:${size.bytes}:${i % 50}`;
    // Warm both, and fill the keys the gets read.
    for (const cache of [plain, sealed]) {
      await time(Math.min(n, 200), async (i) => await cache.set(keyOf(i), value));
    }
    const results = { setPlain: [] as number[], setSealed: [] as number[], getPlain: [] as number[], getSealed: [] as number[] };
    for (let round = 0; round < ROUNDS; round++) {
      results.setPlain.push(await time(n, async (i) => await plain.set(keyOf(i), value)));
      results.setSealed.push(await time(n, async (i) => await sealed.set(keyOf(i), value)));
      results.getPlain.push(await time(n, async (i) => await plain.get(keyOf(i))));
      results.getSealed.push(await time(n, async (i) => await sealed.get(keyOf(i))));
    }
    let plainBytes = 0;
    let sealedBytes = 0;
    plain.on("set", (event) => (plainBytes = event.bytes));
    sealed.on("set", (event) => (sealedBytes = event.bytes));
    await plain.set(keyOf(0), value);
    await sealed.set(keyOf(0), value);
    if ((await sealed.get(keyOf(0))) === undefined) {
      throw new Error("the sealed cache did not read back");
    }
    const [sp, ss, gp, gs] = [results.setPlain, results.setSealed, results.getPlain, results.getSealed].map(median);
    const f = (v: number) => (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0));
    console.log(
      `| ${size.label} | ${plainBytes} / ${sealedBytes} B | ${f(sp)} | ${f(ss)} | ${f(ss - sp)} (${(((ss - sp) / sp) * 100).toFixed(0)}%) | ${f(gp)} | ${f(gs)} | ${f(gs - gp)} (${(((gs - gp) / gp) * 100).toFixed(0)}%) |`,
    );
  }
  await plain.close();
  await sealed.close();
}

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)}), ${process.platform} ${process.arch}`);

await measure(
  "memory driver",
  (encrypted) =>
    createCache({
      driver: memoryDriver(),
      namespace: encrypted ? "sealed" : "plain",
      sweepInterval: 0,
      ...(encrypted ? { encrypt: { keys: KEYS } } : {}),
    }),
  (size) => size.memory,
);

const url = process.env.BUN_CACHE_TEST_REDIS_URL;
if (url === undefined) {
  console.log("\n(redis skipped: BUN_CACHE_TEST_REDIS_URL unset)");
} else {
  const prefix = `bun_cache_bench_e1_${process.pid}_${Date.now()}`;
  try {
    await measure(
      "redis driver (local, loopback)",
      (encrypted) =>
        createCache({
          driver: redisDriver({ url, prefix }),
          namespace: encrypted ? "sealed" : "plain",
          sweepInterval: 0,
          ...(encrypted ? { encrypt: { keys: KEYS } } : {}),
        }),
      (size) => size.redis,
    );
  } finally {
    const client = new Bun.RedisClient(url);
    let cursor = "0";
    let deleted = 0;
    do {
      const [next, found] = (await client.send("SCAN", [cursor, "MATCH", `${prefix}:*`, "COUNT", "1000"])) as [string, string[]];
      cursor = String(next);
      if (found.length > 0) {
        deleted += Number(await client.send("UNLINK", found));
      }
    } while (cursor !== "0");
    client.close();
    console.log(`\n(redis: deleted the run's ${deleted} keys under ${prefix})`);
  }
}
