// Random 96-bit GCM nonces under one key: the collision probability after n
// seals (birthday bound n²/2^97) and how long a cache takes to reach NIST
// SP 800-38D §8.3's limit of 2^32 seals per key, at several write rates.
// With a per-entry key derived from a 128-bit salt (the "derived" envelope),
// a GCM nonce repeats only if a salt does: n²/2^129.
// Run: bun nonce-bound.ts
const rates = [100, 1_000, 10_000, 100_000];
const day = 86_400;
console.log("| writes/s | reach 2^32 seals | P(any nonce repeat) after 1 year, 96-bit random | after 1 year, 128-bit salt + derived key |");
console.log("|---|---|---|---|");
for (const r of rates) {
  const n = r * 365 * day;
  const days = 2 ** 32 / r / day;
  const p96 = Math.min(1, (n * n) / 2 ** 97);
  const p128 = (n * n) / 2 ** 129;
  console.log(`| ${r.toLocaleString("en")} | ${days < 1 ? `${(days * 24).toFixed(1)} h` : `${days.toFixed(1)} d`} | ${p96.toExponential(1)} | ${p128.toExponential(1)} |`);
}
