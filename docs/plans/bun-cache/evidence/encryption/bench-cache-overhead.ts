// What sealing adds to a whole cache operation on the real bun-cache
// (develop 251a64f1): set and get on the memory driver (the worst case: no
// network to hide behind) and on the SQLite driver (a file, WAL), plain
// against a driver wrapper that seals every value with AES-256-GCM under a
// per-entry derived key (the plan's built-in envelope, minus the core
// integration). Values of ~100 B and ~4 KiB of JSON.
// Run: nice -n 10 bun bench-cache-overhead.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const LIB = process.env.BUN_CACHE_LIB || new URL("../../../../../packages/bun-cache/lib/index.ts", import.meta.url).pathname;
const { createCache, memoryDriver, sqliteDriver } = (await import(LIB)) as typeof import("../../../../../packages/bun-cache/lib/index.ts");
type Driver = ReturnType<typeof memoryDriver>;
type Stored = NonNullable<Awaited<ReturnType<Driver["get"]>>>;

const master = randomBytes(32);
const subkey = (salt: Uint8Array) => new Bun.CryptoHasher("sha256", master).update("bc-enc-k\0").update(salt).digest() as Buffer;
function seal(ns: string, e: Stored): Uint8Array {
  const prefix = crypto.getRandomValues(new Uint8Array(28)); // salt 16 + nonce 12
  const c = createCipheriv("aes-256-gcm", subkey(prefix.subarray(0, 16)), prefix.subarray(16));
  c.setAAD(Buffer.from(`${ns}\0${e.key}`));
  return Buffer.concat([prefix, c.update(e.value), c.final(), c.getAuthTag()]);
}
function open(ns: string, e: Stored): Stored | undefined {
  const v = e.value;
  try {
    const d = createDecipheriv("aes-256-gcm", subkey(v.subarray(0, 16)), v.subarray(16, 28));
    d.setAAD(Buffer.from(`${ns}\0${e.key}`));
    d.setAuthTag(v.subarray(v.length - 16));
    return { ...e, value: Buffer.concat([d.update(v.subarray(28, v.length - 16)), d.final()]) };
  } catch {
    return undefined;
  }
}
function sealed(inner: Driver): Driver {
  const own = {
    get: async (ns: string, k: string) => {
      const raw = await inner.get(ns, k);
      return raw === undefined ? undefined : open(ns, raw);
    },
    set: async (ns: string, e: Stored, fence?: Parameters<Driver["set"]>[2]) => await inner.set(ns, { ...e, value: seal(ns, e) }, fence),
  };
  return new Proxy(inner, {
    get(t, p, r) {
      if (p in own) return own[p as keyof typeof own];
      const v = Reflect.get(t, p, r) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

async function per(fn: (i: number) => Promise<unknown>, n: number): Promise<number> {
  for (let i = 0; i < n / 10; i++) await fn(i);
  const runs: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t = Bun.nanoseconds();
    for (let i = 0; i < n; i++) await fn(i);
    runs.push((Bun.nanoseconds() - t) / 1000 / n);
  }
  return runs.sort((a, b) => a - b)[2];
}
const small = { id: 42, name: "user 42", email: "u42@example.com", score: 63 };
const big = Array.from({ length: 30 }, (_, i) => ({ id: i, name: `user ${i}`, email: `u${i}@example.com`, bio: "lorem ipsum dolor sit amet ".repeat(4) }));
const dir = await mkdtemp(join(process.env.SPIKE_DIR || tmpdir(), "bc-enc-ovh-"));
console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)}); µs per awaited op, median of 5; ~${JSON.stringify(small).length} B and ~${JSON.stringify(big).length} B JSON values\n`);
console.log("| driver | value | set plain | set sealed | get plain | get sealed |\n|---|---|---|---|---|---|");
try {
  for (const [dname, make, n] of [
    ["memory", () => memoryDriver(), 20_000],
    ["sqlite (WAL, file)", () => sqliteDriver({ path: join(dir, `c-${Math.random()}.db`) }), 3_000],
  ] as const) {
    for (const [vname, value] of [["100 B", small], ["4 KiB", big]] as const) {
      const plain = createCache({ driver: make(), namespace: "app" });
      const enc = createCache({ driver: sealed(make()), namespace: "app" });
      const sp = await per(async (i) => await plain.set(`k:${i % 1000}`, value), n);
      const se = await per(async (i) => await enc.set(`k:${i % 1000}`, value), n);
      const gp = await per(async (i) => await plain.get(`k:${i % 1000}`), n);
      const ge = await per(async (i) => await enc.get(`k:${i % 1000}`), n);
      if (JSON.stringify(await enc.get("k:1")) !== JSON.stringify(value)) throw new Error("sealed round trip");
      console.log(`| ${dname} | ${vname} | ${sp.toFixed(1)} | ${se.toFixed(1)} | ${gp.toFixed(1)} | ${ge.toFixed(1)} |`);
      await plain.close();
      await enc.close();
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
