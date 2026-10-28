// What an attacker with write access to the store can do to encrypted
// entries, on the real bun-cache (develop 251a64f1), and what binding the
// ciphertext to its name (AAD) and carrying the tags inside it change.
//
// A. Encryption as a custom Codec (the only hook today): the codec sees the
//    value, not its key, so it cannot bind the ciphertext to it. Swapping two
//    entries' payloads between keys, or between namespaces, serves the wrong
//    value with no error.
// B. The proposed envelope (sketched here as a driver wrapper so it runs on
//    the unmodified core): the whole entry is sealed, with the namespace and
//    stored key as AAD. Swap, cross-namespace swap, tamper and wrong key all
//    become misses; a rotated key still opens. The controls (B0a, B0b) run
//    the same envelope without AAD: a swap between keys of one namespace is
//    still caught by the full key the sealed header carries, but the same key
//    copied across namespaces is served.
// C. Tags in the clear: on a stamps-mode driver (file), stripping an entry's
//    tags in the store makes it survive invalidateTags today; with the tags
//    inside the sealed envelope it does not.
// D. What AAD cannot stop: replaying an older ciphertext of the same key.
//
// Run: bun swap-attack.ts   (BUN_CACHE_LIB overrides the package path)
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const LIB = process.env.BUN_CACHE_LIB || new URL("../../../../../packages/bun-cache/lib/index.ts", import.meta.url).pathname;
const { createCache, memoryDriver, fileDriver } = (await import(LIB)) as typeof import("../../../../../packages/bun-cache/lib/index.ts");
type Driver = ReturnType<typeof memoryDriver>;
type Stored = NonNullable<Awaited<ReturnType<Driver["get"]>>>;

const results: [string, string, string][] = [];
const record = (attack: string, expected: string, got: unknown) => {
  const shown = got === undefined ? "miss" : JSON.stringify(got);
  results.push([attack, expected, shown]);
};

/* ---------------- A: a Codec that encrypts, no AAD possible ---------------- */
const codecKey = randomBytes(32);
const encryptingCodec = {
  id: 200,
  encode(value: unknown): Uint8Array {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const c = createCipheriv("aes-256-gcm", codecKey, iv);
    const body = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
    return Buffer.concat([iv, body, c.getAuthTag()]);
  },
  decode(bytes: Uint8Array): unknown {
    const d = createDecipheriv("aes-256-gcm", codecKey, bytes.subarray(0, 12));
    d.setAuthTag(bytes.subarray(bytes.length - 16));
    return JSON.parse(Buffer.concat([d.update(bytes.subarray(12, bytes.length - 16)), d.final()]).toString());
  },
};
/** The header's length (lib/core/header.ts: 33 fixed bytes + the key). */
const headerLength = (v: Uint8Array) => 33 + new DataView(v.buffer, v.byteOffset).getUint32(29, true);
/** The attacker: keep each entry's clear header (it names its key), swap the payloads. */
async function swapPayloads(driver: Driver, nsA: string, keyA: string, nsB: string, keyB: string) {
  const a = (await driver.get(nsA, keyA))!;
  const b = (await driver.get(nsB, keyB))!;
  const graft = (head: Stored, body: Stored) =>
    Buffer.concat([head.value.subarray(0, headerLength(head.value)), body.value.subarray(headerLength(body.value))]);
  await driver.set(nsA, { ...a, value: graft(a, b) });
  await driver.set(nsB, { ...b, value: graft(b, a) });
}
{
  const driver = memoryDriver();
  const cache = createCache({ driver, namespace: "app", codec: encryptingCodec });
  await cache.set("user:1", { name: "alice", role: "admin" });
  await cache.set("user:2", { name: "bob", role: "user" });
  await swapPayloads(driver, "app", "user:1", "app", "user:2");
  record("A1 codec encryption: swap payloads of user:1 and user:2", "bob/user", await cache.get("user:2"));
  const a = cache.namespace("tenant-a");
  const b = cache.namespace("tenant-b");
  await a.set("invoice:9", { tenant: "a", total: 100 });
  await b.set("invoice:9", { tenant: "b", total: 5 });
  await swapPayloads(driver, "app:tenant-a", "invoice:9", "app:tenant-b", "invoice:9");
  record("A2 codec encryption: swap across namespaces tenant-a/tenant-b", "tenant b", await b.get("invoice:9"));
  await cache.close();
}

/* ---------------- B: the envelope, sealed with AAD ---------------- */
/** The negative control's switch: the same envelope with no AAD. */
let useAad = true;
const aadFor = (ns: string, key: string, prefix: Uint8Array) =>
  useAad ? Buffer.concat([Buffer.from(`bun-cache/enc/1\0${ns}\0${key}\0`), prefix]) : Buffer.alloc(0);
interface KeyEntry {
  id: string;
  key: Uint8Array;
}
/**
 * The envelope: "BE" | 1 | cipher 1 | key-id length | key id | nonce 12 | ct | tag 16.
 * The plaintext is the whole core entry (header, full key, payload) plus the
 * tags and the hard expiry, so the driver's clear copies are not trusted.
 * AAD = "bun-cache/enc/1" 0 ns 0 stored key, plus the envelope's own prefix.
 */
function seal(keys: KeyEntry[], ns: string, entry: Stored): Uint8Array {
  const { id, key } = keys[0];
  const idBytes = new TextEncoder().encode(id);
  const prefix = Buffer.concat([Buffer.from([0x42, 0x45, 1, 1, idBytes.length]), idBytes, crypto.getRandomValues(new Uint8Array(12))]);
  const inner = Buffer.concat([Buffer.from(JSON.stringify({ tags: entry.tags, expiresAt: entry.expiresAt }) + "\n"), entry.value]);
  const c = createCipheriv("aes-256-gcm", key, prefix.subarray(prefix.length - 12));
  c.setAAD(aadFor(ns, entry.key, prefix));
  return Buffer.concat([prefix, c.update(inner), c.final(), c.getAuthTag()]);
}
function open(keys: KeyEntry[], ns: string, stored: Stored): Stored | undefined {
  const v = stored.value;
  if (v[0] !== 0x42 || v[1] !== 0x45) return undefined;
  const idLength = v[4];
  const id = new TextDecoder().decode(v.subarray(5, 5 + idLength));
  const key = keys.find((k) => k.id === id);
  if (key === undefined) return undefined; // unknown key id: a miss (and an `error` event, phase "decrypt")
  const prefixLength = 5 + idLength + 12;
  try {
    const d = createDecipheriv("aes-256-gcm", key.key, v.subarray(prefixLength - 12, prefixLength));
    d.setAAD(aadFor(ns, stored.key, v.subarray(0, prefixLength)));
    d.setAuthTag(v.subarray(v.length - 16));
    const inner = Buffer.concat([d.update(v.subarray(prefixLength, v.length - 16)), d.final()]);
    const nl = inner.indexOf(10);
    const meta = JSON.parse(inner.subarray(0, nl).toString()) as { tags: string[]; expiresAt: number | null };
    return { key: stored.key, value: new Uint8Array(inner.subarray(nl + 1)), tags: meta.tags, expiresAt: meta.expiresAt };
  } catch {
    return undefined; // authentication failed: a miss (and an `error` event, phase "decrypt")
  }
}
/** A driver wrapper that seals on the way in and opens on the way out (the spike's stand-in for the core change). */
function sealed(inner: Driver, keys: () => KeyEntry[]): Driver {
  const own = {
    get: async (ns: string, key: string) => {
      const raw = await inner.get(ns, key);
      return raw === undefined ? undefined : open(keys(), ns, raw);
    },
    getMany: async (ns: string, ks: readonly string[]) => await Promise.all(ks.map(async (k) => await own.get(ns, k))),
    set: async (ns: string, entry: Stored, fence?: Parameters<Driver["set"]>[2]) =>
      await inner.set(ns, { ...entry, value: seal(keys(), ns, entry) }, fence),
  };
  // Everything else is the inner driver's, bound to it (its fields are private).
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop in own) return own[prop as keyof typeof own];
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
{
  const k1: KeyEntry = { id: "2026-09", key: randomBytes(32) };
  const k2: KeyEntry = { id: "2026-10", key: randomBytes(32) };
  let ring = [k1];
  const store = memoryDriver();
  const cache = createCache({ driver: sealed(store, () => ring), namespace: "app" });
  await cache.set("user:1", { name: "alice", role: "admin" });
  await cache.set("user:2", { name: "bob", role: "user" });
  // The attacker swaps whole stored values (the envelope has no clear header to keep).
  const swap = async () => {
    const a = (await store.get("app", "user:1"))!;
    const b = (await store.get("app", "user:2"))!;
    await store.set("app", { ...a, value: b.value });
    await store.set("app", { ...b, value: a.value });
  };
  useAad = false;
  await cache.set("user:1", { name: "alice", role: "admin" });
  await cache.set("user:2", { name: "bob", role: "user" });
  await swap();
  // Without AAD the core's own full-key check (inside the ciphertext) is all
  // that stands in the way; read through the envelope with the swapped key.
  record("B0a control, the envelope without AAD: swap user:1 and user:2 (caught by the full key inside)", "miss", await cache.get("user:2"));
  {
    const xa = cache.namespace("tenant-a");
    const xb = cache.namespace("tenant-b");
    await xa.set("invoice:8", { tenant: "a", total: 100 });
    await xb.set("invoice:8", { tenant: "b", total: 5 });
    const e = (await store.get("app:tenant-a", "invoice:8"))!;
    await store.set("app:tenant-b", e);
    record("B0b control, the envelope without AAD: copy tenant-a's entry over tenant-b's", "miss", await xb.get("invoice:8"));
  }
  useAad = true;
  await cache.set("user:1", { name: "alice", role: "admin" });
  await cache.set("user:2", { name: "bob", role: "user" });
  await swap();
  record("B1 envelope + AAD: swap user:1 and user:2", "miss", await cache.get("user:2"));
  const ta = cache.namespace("tenant-a");
  const tb = cache.namespace("tenant-b");
  await ta.set("invoice:9", { tenant: "a", total: 100 });
  await tb.set("invoice:9", { tenant: "b", total: 5 });
  const ea = (await store.get("app:tenant-a", "invoice:9"))!;
  await store.set("app:tenant-b", { ...ea, key: "invoice:9" });
  record("B2 envelope + AAD: copy tenant-a's entry over tenant-b's", "miss", await tb.get("invoice:9"));
  await cache.set("user:3", { name: "carol" });
  const e3 = (await store.get("app", "user:3"))!;
  const flipped = new Uint8Array(e3.value);
  flipped[flipped.length - 20] ^= 1;
  await store.set("app", { ...e3, value: flipped });
  record("B3 envelope: flip one ciphertext bit", "miss", await cache.get("user:3"));
  await cache.set("user:4", { name: "dave" });
  ring = [k2, k1];
  record("B4 rotation: written under 2026-09, read with [2026-10, 2026-09]", "dave", await cache.get("user:4"));
  await cache.set("user:5", { name: "erin" });
  ring = [{ id: "2026-10", key: randomBytes(32) }];
  record("B5 wrong key under the same id", "miss", await cache.get("user:5"));
  ring = [{ id: "2026-11", key: randomBytes(32) }];
  record("B6 key id unknown to this process", "miss", await cache.get("user:4"));
  const e5 = (await store.get("app", "user:5"))!;
  record("B7 plaintext in the stored bytes ('erin')", "absent", Buffer.from(e5.value).includes("erin") ? "present" : "absent");
  await cache.close();
}

/* ---------------- C: stripping tags on a stamps-mode driver ---------------- */
async function tagStrip(label: string, wrap: (d: Driver) => Driver, root: string) {
  const store = fileDriver({ root });
  const cache = createCache({ driver: wrap(store), namespace: "app", tagStampCacheMs: 0 });
  await cache.set("report:7", { org: 7 }, { tags: ["org:7"] });
  const raw = (await store.get("app", "report:7"))!;
  await store.set("app", { ...raw, tags: [] }); // the attacker drops the tag in the store
  await cache.invalidateTags(["org:7"]);
  record(label, "miss", await cache.get("report:7"));
  await cache.close();
}
const dir = await mkdtemp(join(process.env.SPIKE_DIR || tmpdir(), "bc-enc-"));
try {
  await tagStrip("C1 today (tags in the clear): strip org:7, then invalidateTags(org:7)", (d) => d, join(dir, "c1"));
  const ring = [{ id: "k", key: randomBytes(32) }];
  await tagStrip("C2 tags inside the envelope: the same", (d) => sealed(d, () => ring), join(dir, "c2"));
} finally {
  await rm(dir, { recursive: true, force: true });
}

/* ---------------- D: replay of an older ciphertext ---------------- */
{
  const ring = [{ id: "k", key: randomBytes(32) }];
  const store = memoryDriver();
  const cache = createCache({ driver: sealed(store, () => ring), namespace: "app" });
  await cache.set("price:1", { cents: 100 });
  const old = (await store.get("app", "price:1"))!;
  await cache.set("price:1", { cents: 250 });
  await store.set("app", old);
  record("D1 replay price:1's older ciphertext over its newer one", "250 (not preventable)", await cache.get("price:1"));
  await cache.close();
}

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)}); the real createCache, memoryDriver and fileDriver\n`);
console.log("| attack | a safe cache would answer | bun-cache answered |\n|---|---|---|");
for (const [a, e, g] of results) console.log(`| ${a} | ${e} | ${g} |`);
