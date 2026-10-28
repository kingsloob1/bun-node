// Where node AES-256-GCM's seal spends its time at 100 B: the nonce source
// and the cipher object, against open (which takes its nonce from the input).
// Run: nice -n 10 bun bench-nonce.ts
import { createCipheriv, randomBytes, randomFillSync } from "node:crypto";

const key = randomBytes(32);
const pt = randomBytes(100);
const N = 200_000;
function time(name: string, fn: () => unknown): void {
  for (let i = 0; i < 20_000; i++) fn();
  const runs: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t = Bun.nanoseconds();
    for (let i = 0; i < N; i++) fn();
    runs.push((Bun.nanoseconds() - t) / 1000 / N);
  }
  runs.sort((a, b) => a - b);
  console.log(`| ${name} | ${runs[2].toFixed(2)} |`);
}
const fixed = randomBytes(12);
const pool = new Uint8Array(12 * 4096);
let off = pool.length;
const fromPool = () => {
  if (off === pool.length) {
    crypto.getRandomValues(pool);
    off = 0;
  }
  off += 12;
  return pool.subarray(off - 12, off);
};
console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)}); median of 5 × ${N}, µs per op\n`);
console.log("| step | µs |\n|---|---|");
time("randomBytes(12)", () => randomBytes(12));
time("crypto.getRandomValues(new Uint8Array(12))", () => crypto.getRandomValues(new Uint8Array(12)));
time("randomFillSync(new Uint8Array(12))", () => randomFillSync(new Uint8Array(12)));
time("12 bytes from a 48 KiB pool refilled by getRandomValues", fromPool);
const seal = (iv: Uint8Array) => {
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.update(pt);
  c.final();
  return c.getAuthTag();
};
time("GCM seal 100 B, fixed nonce (cipher alone)", () => seal(fixed));
time("GCM seal 100 B, randomBytes nonce", () => seal(randomBytes(12)));
time("GCM seal 100 B, getRandomValues nonce", () => seal(crypto.getRandomValues(new Uint8Array(12))));
time("GCM seal 100 B, pooled nonce", () => seal(fromPool()));
