// What authenticated encryption costs on Bun, per cache entry, beside what
// bun-cache already spends on a write (bun:jsc encode + zstd above 16 KiB).
// Candidates: node:crypto AES-256-GCM (sync, BoringSSL), the same with a
// per-entry derived key (HMAC-SHA-256 of a random salt), crypto.subtle
// AES-GCM and ChaCha20-Poly1305 (async), and the cost of putting a sync
// cipher behind an `await`. node:crypto has no ChaCha20-Poly1305 on Bun
// (oven-sh/bun#8072), so ChaCha20 is subtle-only.
// Run: nice -n 10 bun bench-ciphers.ts            (about a minute)
import { serialize, deserialize } from "bun:jsc";
import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  randomBytes,
} from "node:crypto";
import process from "node:process";

const SIZES = [100, 4096, 70_000, 1 << 20];
const MIN_MS = Number(process.env.MIN_MS ?? 150);
const ROUNDS = Number(process.env.ROUNDS ?? 5);
const master = randomBytes(32);
const masterKey = createSecretKey(master);
const aad = new TextEncoder().encode("bun-cache/enc/1\0app:users\0user:42");

/** Median µs per op (wall) and CPU µs per op over ROUNDS rounds. */
function benchSync(fn: () => unknown): { us: number; cpu: number } {
  let n = 1;
  for (;;) {
    const t = performance.now();
    for (let i = 0; i < n; i++) fn();
    if (performance.now() - t > MIN_MS / 4) break;
    n *= 2;
  }
  n *= 4;
  const walls: number[] = [];
  const cpus: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const c0 = process.cpuUsage();
    const t0 = Bun.nanoseconds();
    for (let i = 0; i < n; i++) fn();
    const wall = (Bun.nanoseconds() - t0) / 1000;
    const c = process.cpuUsage(c0);
    walls.push(wall / n);
    cpus.push((c.user + c.system) / n);
  }
  return { us: median(walls), cpu: median(cpus) };
}

/** The same, for an async op awaited one at a time (`conc` = 1) or `conc` in flight. */
async function benchAsync(
  fn: () => Promise<unknown>,
  conc = 1,
): Promise<{ us: number; cpu: number }> {
  const batch = async (n: number) => {
    if (conc === 1) {
      for (let i = 0; i < n; i++) await fn();
    } else {
      for (let i = 0; i < n; i += conc) {
        await Promise.all(Array.from({ length: conc }, fn));
      }
    }
  };
  let n = conc;
  for (;;) {
    const t = performance.now();
    await batch(n);
    if (performance.now() - t > MIN_MS / 4) break;
    n *= 2;
  }
  n *= 4;
  const walls: number[] = [];
  const cpus: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const c0 = process.cpuUsage();
    const t0 = Bun.nanoseconds();
    await batch(n);
    const wall = (Bun.nanoseconds() - t0) / 1000;
    const c = process.cpuUsage(c0);
    walls.push(wall / n);
    cpus.push((c.user + c.system) / n);
  }
  return { us: median(walls), cpu: median(cpus) };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/* ---- the candidates: seal = nonce || ciphertext || tag ---- */

function gcmSeal(key: Buffer | ReturnType<typeof createSecretKey>, pt: Uint8Array): Uint8Array {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // not randomBytes: 2.8 µs against 0.04 (bench-nonce.ts)
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad);
  const a = c.update(pt);
  const b = c.final();
  const out = new Uint8Array(12 + a.length + b.length + 16);
  out.set(iv, 0);
  out.set(a, 12);
  out.set(b, 12 + a.length);
  out.set(c.getAuthTag(), 12 + a.length + b.length);
  return out;
}

function gcmOpen(key: Buffer | ReturnType<typeof createSecretKey>, sealed: Uint8Array): Uint8Array {
  const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  d.setAAD(aad);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const a = d.update(sealed.subarray(12, sealed.length - 16));
  const b = d.final();
  return b.length === 0 ? a : Buffer.concat([a, b]);
}

/** Per-entry key: HMAC-SHA-256(master, "bc-enc-k\0" || salt16); then GCM. Envelope: salt16 || nonce12 || ct || tag. */
function subkey(salt: Uint8Array): Buffer {
  // Bun.CryptoHasher with a key is HMAC: 0.44 µs against createHmac's 0.68 (bench-hmac.ts).
  return new Bun.CryptoHasher("sha256", master).update("bc-enc-k\0").update(salt).digest() as Buffer;
}
function derivedSeal(pt: Uint8Array): Uint8Array {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const inner = gcmSeal(subkey(salt), pt);
  const out = new Uint8Array(16 + inner.length);
  out.set(salt, 0);
  out.set(inner, 16);
  return out;
}
function derivedOpen(sealed: Uint8Array): Uint8Array {
  return gcmOpen(subkey(sealed.subarray(0, 16)), sealed.subarray(16));
}

const subtleGcm = await crypto.subtle.importKey("raw", master, "AES-GCM", false, ["encrypt", "decrypt"]);
// ChaCha20-Poly1305 imports only as "raw-secret" (WICG Modern Algorithms), not "raw".
const subtleCha = await crypto.subtle.importKey("raw-secret" as "raw", master, "ChaCha20-Poly1305", false, ["encrypt", "decrypt"]);

async function subtleSeal(name: "AES-GCM" | "ChaCha20-Poly1305", pt: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name, iv, additionalData: aad } as AesGcmParams,
      name === "AES-GCM" ? subtleGcm : subtleCha,
      pt,
    ),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}
async function subtleOpen(name: "AES-GCM" | "ChaCha20-Poly1305", sealed: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name, iv: sealed.subarray(0, 12), additionalData: aad } as AesGcmParams,
      name === "AES-GCM" ? subtleGcm : subtleCha,
      sealed.subarray(12),
    ),
  );
}
/** Per-entry key through subtle: derive with node's HMAC, then importKey every op. */
async function subtleDerivedSeal(pt: Uint8Array): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await crypto.subtle.importKey("raw", subkey(salt), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, k, pt));
  const out = new Uint8Array(28 + ct.length);
  out.set(salt, 0);
  out.set(iv, 16);
  out.set(ct, 28);
  return out;
}

// Sanity: every pair round-trips, and a flipped bit fails.
{
  const pt = randomBytes(1000);
  const eq = (a: Uint8Array) => Buffer.compare(Buffer.from(a), pt) === 0;
  const s1 = gcmSeal(master, pt);
  const s2 = derivedSeal(pt);
  const s3 = await subtleSeal("AES-GCM", pt);
  const s4 = await subtleSeal("ChaCha20-Poly1305", pt);
  if (!eq(gcmOpen(master, s1)) || !eq(derivedOpen(s2)) || !eq(await subtleOpen("AES-GCM", s3)) || !eq(await subtleOpen("ChaCha20-Poly1305", s4))) {
    throw new Error("round trip failed");
  }
  // node's GCM and subtle's AES-GCM produce the same layout: cross-open.
  if (!eq(await subtleOpen("AES-GCM", s1)) || !eq(gcmOpen(master, s3))) throw new Error("cross-open failed");
  s1[20] ^= 1;
  let threw = false;
  try {
    gcmOpen(master, s1);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("tamper not detected");
  console.log("sanity: round trips, node↔subtle AES-GCM cross-open, tamper detected");
}

const loadavg = (await Bun.file("/proc/loadavg").text()).split(" ").slice(0, 3).join(" ");
console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)}), ${navigator.hardwareConcurrency} threads, load ${loadavg}; ${ROUNDS} rounds of ≥${MIN_MS}/4 ms, medians`);

const fmt = (x: number) => (x < 10 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : x.toFixed(0));
const cell = (r: { us: number; cpu: number }) => `${fmt(r.us)} / ${fmt(r.cpu)}`;

console.log("\n## 1. Seal and open, random bytes: µs per op wall / CPU µs per op (CPU > wall = other threads worked)\n");
console.log("| candidate | op | " + SIZES.map((s) => `${s} B`).join(" | ") + " |");
console.log("|---|---|" + SIZES.map(() => "---|").join(""));
const rows: [string, string, (pt: Uint8Array, sealed: Record<string, Uint8Array>) => Promise<{ us: number; cpu: number }>][] = [
  ["node AES-256-GCM, Buffer key", "seal", async (pt) => benchSync(() => gcmSeal(master, pt))],
  ["node AES-256-GCM, Buffer key", "open", async (_pt, s) => benchSync(() => gcmOpen(master, s.gcm))],
  ["node AES-256-GCM, KeyObject", "seal", async (pt) => benchSync(() => gcmSeal(masterKey, pt))],
  ["node AES-256-GCM + per-entry HMAC key", "seal", async (pt) => benchSync(() => derivedSeal(pt))],
  ["node AES-256-GCM + per-entry HMAC key", "open", async (_pt, s) => benchSync(() => derivedOpen(s.derived))],
  ["node AES-256-GCM behind `await`", "seal", async (pt) => benchAsync(async () => gcmSeal(master, pt))],
  ["subtle AES-GCM, awaited one by one", "seal", async (pt) => benchAsync(() => subtleSeal("AES-GCM", pt))],
  ["subtle AES-GCM, awaited one by one", "open", async (_pt, s) => benchAsync(() => subtleOpen("AES-GCM", s.subtle))],
  ["subtle AES-GCM, 64 in flight", "seal", async (pt) => benchAsync(() => subtleSeal("AES-GCM", pt), 64)],
  ["subtle AES-GCM + per-entry importKey", "seal", async (pt) => benchAsync(() => subtleDerivedSeal(pt))],
  ["subtle ChaCha20-Poly1305, one by one", "seal", async (pt) => benchAsync(() => subtleSeal("ChaCha20-Poly1305", pt))],
  ["subtle ChaCha20-Poly1305, one by one", "open", async (_pt, s) => benchAsync(() => subtleOpen("ChaCha20-Poly1305", s.cha))],
];
const inputs = new Map<number, { pt: Uint8Array; sealed: Record<string, Uint8Array> }>();
for (const size of SIZES) {
  const pt = randomBytes(size);
  inputs.set(size, {
    pt,
    sealed: {
      gcm: gcmSeal(master, pt),
      derived: derivedSeal(pt),
      subtle: await subtleSeal("AES-GCM", pt),
      cha: await subtleSeal("ChaCha20-Poly1305", pt),
    },
  });
}
for (const [name, op, run] of rows) {
  const cells: string[] = [];
  for (const size of SIZES) {
    const { pt, sealed } = inputs.get(size)!;
    cells.push(cell(await run(pt, sealed)));
  }
  console.log(`| ${name} | ${op} | ${cells.join(" | ")} |`);
}

console.log("\n## 2. Against bun-cache's own write and read path (bun:jsc + zstd ≥ 16 KiB), µs per op wall\n");
// Cache-shaped records (codecs.ts's), as many as reach each size as JSON.
const record = (i: number) => ({ id: i, name: `user ${i}`, email: `u${i}@example.com`, tags: ["a", "b", "c"], score: i * 1.5, createdAt: new Date(1760000000000 + i).toISOString(), bio: "lorem ipsum dolor sit amet ".repeat(8) });
console.log("| JSON size | encoded+compressed bytes | encode+zstd | + seal (node GCM) | seal share | decode | open + decode | open share |");
console.log("|---|---|---|---|---|---|---|---|");
for (const size of SIZES) {
  let value: unknown;
  if (size <= 100) value = { id: 42, name: "user 42", email: "u42@example.com", score: 63 };
  else {
    const out = [];
    let json = 2;
    for (let i = 0; json < size; i++) {
      const r = record(i);
      out.push(r);
      json += JSON.stringify(r).length + 1;
    }
    value = out;
  }
  const enc = () => {
    const b = new Uint8Array(serialize(value) as unknown as ArrayBuffer);
    return b.byteLength >= 16 * 1024 ? Bun.zstdCompressSync(b) : b;
  };
  const payload = enc();
  const compressed = payload.byteLength !== (serialize(value) as unknown as ArrayBuffer).byteLength;
  const sealed = gcmSeal(master, payload);
  const dec = (b: Uint8Array) => deserialize(compressed ? Bun.zstdDecompressSync(b) : b);
  const a = benchSync(enc);
  const b = benchSync(() => gcmSeal(master, enc()));
  const c = benchSync(() => dec(payload));
  const d = benchSync(() => dec(gcmOpen(master, sealed)));
  const pct = (x: number, y: number) => `${Math.round(((y - x) / y) * 100)}%`;
  console.log(`| ${JSON.stringify(value).length} B | ${payload.byteLength} B${compressed ? " (zstd)" : ""} | ${fmt(a.us)} | ${fmt(b.us)} | ${pct(a.us, b.us)} | ${fmt(c.us)} | ${fmt(d.us)} | ${pct(c.us, d.us)} |`);
}
