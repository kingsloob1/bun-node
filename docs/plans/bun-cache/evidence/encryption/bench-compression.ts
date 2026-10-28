// The compressors Bun offers for cache entries, at 100 B / 4 KiB / 70 KB /
// 1 MiB of JSON, HTML and incompressible (already-compressed) bytes: ratio,
// compress and decompress µs (sync), at the default and a few levels, and
// the async forms at the larger sizes. Bun has native sync zstd, gzip and
// raw deflate (`Bun.zstdCompressSync`, `Bun.gzipSync`, `Bun.deflateSync`)
// and async zstd (`Bun.zstdCompress`); Brotli and zlib-wrapped deflate are
// `node:zlib` only. Run: nice -n 10 bun bench-compression.ts  (a few minutes)
import process from "node:process";
import zlib from "node:zlib";

const SIZES = [100, 4096, 70_000, 1 << 20];
const MIN_MS = Number(process.env.MIN_MS ?? 120);
const ROUNDS = 5;

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)}); Bun.* compressors: ${Object.keys(Bun).filter((k) => /zstd|gzip|deflate|inflate|gunzip|brotli/i.test(k)).join(", ")}`);
console.log(`node:zlib brotli: ${typeof zlib.brotliCompressSync}; load ${(await Bun.file("/proc/loadavg").text()).split(" ").slice(0, 3).join(" ")}\n`);

/* ---- payloads, deterministic ---- */
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim minim veniam quis nostrud exercitation ullamco laboris nisi aliquip commodo consequat".split(" ");
const words = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" ");
function json(size: number): Uint8Array {
  const out: unknown[] = [];
  let s = "[]";
  for (let i = 0; s.length < size; i++) {
    out.push({ id: i, name: `user ${i}`, email: `u${i}@example.com`, score: Math.round(rand() * 1e4) / 100, active: rand() > 0.5, createdAt: new Date(1760000000000 + Math.floor(rand() * 1e9)).toISOString(), bio: words(6 + Math.floor(rand() * 10)) });
    s = JSON.stringify(out);
  }
  return new TextEncoder().encode(s.slice(0, Math.max(size, 2)));
}
function html(size: number): Uint8Array {
  let s = `<!doctype html><html><head><meta charset="utf-8"><title>Report</title><link rel="stylesheet" href="/s.css"></head><body><main><table class="report">`;
  for (let i = 0; s.length < size; i++) {
    s += `<tr class="row ${i % 2 ? "odd" : "even"}"><td class="id">${i}</td><td class="name"><a href="/users/${i}">${words(2)}</a></td><td class="amount">${(rand() * 1e4).toFixed(2)}</td><td>${words(5)}</td></tr>\n`;
  }
  return new TextEncoder().encode(s.slice(0, size));
}
const random = (size: number) => fill(size);
function fill(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let o = 0; o < size; o += 65536) crypto.getRandomValues(out.subarray(o, Math.min(size, o + 65536)));
  return out;
}

/* ---- compressors ---- */
type Pair = { c: (b: Uint8Array) => Uint8Array; d: (b: Uint8Array) => Uint8Array };
const Q = zlib.constants.BROTLI_PARAM_QUALITY;
const br = (q: number): Pair => ({ c: (b) => zlib.brotliCompressSync(b, { params: { [Q]: q } }), d: (b) => zlib.brotliDecompressSync(b) });
const algos: Record<string, Pair> = {
  "zstd 1": { c: (b) => Bun.zstdCompressSync(b, { level: 1 }), d: (b) => Bun.zstdDecompressSync(b) },
  "zstd 3 (default)": { c: (b) => Bun.zstdCompressSync(b), d: (b) => Bun.zstdDecompressSync(b) },
  "zstd 9": { c: (b) => Bun.zstdCompressSync(b, { level: 9 }), d: (b) => Bun.zstdDecompressSync(b) },
  "gzip 1 (Bun)": { c: (b) => Bun.gzipSync(b as Uint8Array<ArrayBuffer>, { level: 1 }), d: (b) => Bun.gunzipSync(b as Uint8Array<ArrayBuffer>) },
  "gzip 6 (Bun, default)": { c: (b) => Bun.gzipSync(b as Uint8Array<ArrayBuffer>), d: (b) => Bun.gunzipSync(b as Uint8Array<ArrayBuffer>) },
  "deflate 6 raw (Bun)": { c: (b) => Bun.deflateSync(b as Uint8Array<ArrayBuffer>), d: (b) => Bun.inflateSync(b as Uint8Array<ArrayBuffer>) },
  "deflate 6 zlib-wrapped (node:zlib)": { c: (b) => zlib.deflateSync(b), d: (b) => zlib.inflateSync(b) },
  "br 1": br(1),
  "br 4 (bun-common)": br(4),
  "br 5": br(5),
  "br 11 (brotli default)": br(11),
};

function per(fn: () => unknown): number {
  let n = 1;
  let first = 0;
  for (;;) {
    const t = performance.now();
    for (let i = 0; i < n; i++) fn();
    first = performance.now() - t;
    if (first > MIN_MS / 4) break;
    n *= 2;
  }
  if (first > MIN_MS) return (first * 1000) / n; // one slow sample is enough
  const runs: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t = Bun.nanoseconds();
    for (let i = 0; i < n; i++) fn();
    runs.push((Bun.nanoseconds() - t) / 1000 / n);
  }
  return runs.sort((a, b) => a - b)[2];
}
const f = (x: number) => (x < 10 ? x.toFixed(1) : x.toFixed(0));

const payloads: Record<string, (n: number) => Uint8Array> = { JSON: json, HTML: html, "incompressible (random)": random };
for (const [pname, make] of Object.entries(payloads)) {
  console.log(`\n## ${pname}: ratio, compress µs / decompress µs\n`);
  console.log("| algorithm | " + SIZES.map((s) => `${s} B`).join(" | ") + " |");
  console.log("|---|" + SIZES.map(() => "---|").join(""));
  const inputs = SIZES.map(make);
  for (const [name, a] of Object.entries(algos)) {
    const cells = inputs.map((input) => {
      const out = a.c(input);
      if (Buffer.compare(Buffer.from(a.d(out)), Buffer.from(input)) !== 0) throw new Error(`${name} round trip`);
      return `${(input.length / out.length).toFixed(1)}× ${f(per(() => a.c(input)))} / ${f(per(() => a.d(out)))}`;
    });
    console.log(`| ${name} | ${cells.join(" | ")} |`);
  }
}

console.log("\n## Async forms, JSON: µs per op awaited one at a time, wall / CPU (sync for reference)\n");
const cpuOf = async (fn: () => Promise<unknown> | unknown, n: number) => {
  const c0 = process.cpuUsage();
  const t = Bun.nanoseconds();
  for (let i = 0; i < n; i++) await fn();
  const c = process.cpuUsage(c0);
  return `${f((Bun.nanoseconds() - t) / 1000 / n)} / ${f((c.user + c.system) / n)}`;
};
const promisify = <T>(fn: (b: Uint8Array, cb: (e: Error | null, r: T) => void) => void) => (b: Uint8Array) =>
  new Promise<T>((resolve, reject) => fn(b, (e, r) => (e ? reject(e) : resolve(r))));
const brAsync = promisify<Buffer>((b, cb) => zlib.brotliCompress(b, { params: { [Q]: 4 } }, cb));
const gzAsync = promisify<Buffer>((b, cb) => zlib.gzip(b, cb));
console.log("| op | 4096 B | 70000 B | 1048576 B |\n|---|---|---|---|");
const asyncRows: [string, (b: Uint8Array) => unknown][] = [
  ["zstd 3, Bun.zstdCompressSync", (b) => Bun.zstdCompressSync(b)],
  ["zstd 3, await Bun.zstdCompress", async (b) => await Bun.zstdCompress(b)],
  ["gzip 6, Bun.gzipSync", (b) => Bun.gzipSync(b as Uint8Array<ArrayBuffer>)],
  ["gzip 6, await zlib.gzip", gzAsync],
  ["br 4, zlib.brotliCompressSync", (b) => zlib.brotliCompressSync(b, { params: { [Q]: 4 } })],
  ["br 4, await zlib.brotliCompress", brAsync],
];
for (const [name, fn] of asyncRows) {
  const cells = [];
  for (const size of [4096, 70_000, 1 << 20]) {
    const input = json(size);
    cells.push(await cpuOf(() => fn(input), size > 100_000 ? 40 : 400));
  }
  console.log(`| ${name} | ${cells.join(" | ")} |`);
}
