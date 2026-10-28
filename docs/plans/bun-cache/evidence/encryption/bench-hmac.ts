// Hashing names (keys, namespaces, tags) for the store: HMAC-SHA-256 through
// Bun.CryptoHasher (HMAC when given a key), node:crypto createHmac and
// crypto.subtle.sign, against the plain SHA-256 bun-cache already runs on
// long keys (keys.ts) and Bun.hash (wyhash: fast, not keyed, not
// cryptographic — listed to say why it is not a candidate). Also the
// one-time key derivations: HKDF (node hkdfSync, subtle deriveBits) and
// scrypt at three costs, for the passphrase question.
// Run: nice -n 10 bun bench-hmac.ts
import { createHmac, hkdfSync, randomBytes, scryptSync } from "node:crypto";

const key = randomBytes(32);
const names = {
  "tag (12 B)": "org:7:users",
  "key (40 B)": "user:42:profile:settings:notifications:v2",
  "HTTP key (200 B)": `bc:http:["GET","","/api/reports/2026/q3",${JSON.stringify("x".repeat(150))}]`,
};
const N = 200_000;
function time(fn: () => unknown, n = N): number {
  for (let i = 0; i < n / 10; i++) fn();
  const runs: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t = Bun.nanoseconds();
    for (let i = 0; i < n; i++) fn();
    runs.push((Bun.nanoseconds() - t) / 1000 / n);
  }
  return runs.sort((a, b) => a - b)[2];
}
async function timeAsync(fn: () => Promise<unknown>, n = N / 4): Promise<number> {
  for (let i = 0; i < n / 10; i++) await fn();
  const runs: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t = Bun.nanoseconds();
    for (let i = 0; i < n; i++) await fn();
    runs.push((Bun.nanoseconds() - t) / 1000 / n);
  }
  return runs.sort((a, b) => a - b)[2];
}
const subtleKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const enc = new TextEncoder();
// Agreement first: all three HMACs give the same bytes.
{
  const a = new Bun.CryptoHasher("sha256", key).update("x").digest("hex");
  const b = createHmac("sha256", key).update("x").digest("hex");
  const c = Buffer.from(await crypto.subtle.sign("HMAC", subtleKey, enc.encode("x"))).toString("hex");
  if (a !== b || b !== c) throw new Error("HMACs disagree");
}
console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)}); median of 5 runs, µs per op; digest as base64url (43 chars)\n`);
console.log("| name | Bun.CryptoHasher HMAC | createHmac | subtle.sign (awaited) | plain SHA-256 (CryptoHasher, today's long keys) | Bun.hash (wyhash, not keyed) |");
console.log("|---|---|---|---|---|---|");
for (const [label, name] of Object.entries(names)) {
  const a = time(() => new Bun.CryptoHasher("sha256", key).update(name).digest("base64url"));
  const b = time(() => createHmac("sha256", key).update(name).digest("base64url"));
  const c = await timeAsync(async () => Buffer.from(await crypto.subtle.sign("HMAC", subtleKey, enc.encode(name))).toString("base64url"));
  const d = time(() => new Bun.CryptoHasher("sha256").update(name).digest("base64url"));
  const e = time(() => Bun.hash(name).toString(36));
  console.log(`| ${label} | ${a.toFixed(2)} | ${b.toFixed(2)} | ${c.toFixed(2)} | ${d.toFixed(2)} | ${e.toFixed(3)} |`);
}

console.log("\n| one-time derivation | ms per call |\n|---|---|");
const hk = await crypto.subtle.importKey("raw", key, "HKDF", false, ["deriveBits"]);
console.log(`| HKDF-SHA-256 → 32 B, node hkdfSync | ${(time(() => hkdfSync("sha256", key, new Uint8Array(0), "bun-cache/enc", 32), 20_000) / 1000).toFixed(4)} |`);
console.log(`| HKDF-SHA-256 → 32 B, subtle deriveBits | ${((await timeAsync(async () => crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("bun-cache/enc") }, hk, 256), 5000)) / 1000).toFixed(4)} |`);
for (const N of [2 ** 14, 2 ** 15, 2 ** 17]) {
  const t = performance.now();
  scryptSync("correct horse battery staple", "salt-per-deployment", 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 * 2 });
  console.log(`| scrypt N=2^${Math.log2(N)}, r=8, p=1 (${(128 * N * 8) / 2 ** 20} MiB) | ${(performance.now() - t).toFixed(1)} |`);
}
