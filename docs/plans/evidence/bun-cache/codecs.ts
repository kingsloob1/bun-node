// Native serialisation and compression options for cache values on Bun:
// which value types each codec round-trips, and its speed and size on a
// cache-shaped payload. All built in: JSON, bun:jsc serialize (structured
// clone), node:v8 serialize; Bun.gzipSync/deflateSync/zstdCompressSync.
// Run: bun codecs.ts
import { serialize as jscSer, deserialize as jscDe } from "bun:jsc";
import v8 from "node:v8";

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)})`);
const codecs = {
  "JSON": { enc: (v: unknown) => new TextEncoder().encode(JSON.stringify(v)), dec: (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) },
  "bun:jsc serialize": { enc: (v: unknown) => new Uint8Array(jscSer(v) as unknown as ArrayBuffer), dec: (b: Uint8Array) => jscDe(b) },
  "node:v8 serialize": { enc: (v: unknown) => new Uint8Array(v8.serialize(v)), dec: (b: Uint8Array) => v8.deserialize(b) },
};
const samples: Record<string, unknown> = {
  "Date": new Date(1760000000000),
  "Map": new Map([["a", 1]]),
  "Set": new Set([1, 2]),
  "Uint8Array": new Uint8Array([1, 2, 3]),
  "BigInt": 10n ** 20n,
  "undefined field": { a: undefined },
  "NaN": Number.NaN,
  "RegExp": /x/gi,
  "Error": new Error("boom"),
  "nested Map in object": { m: new Map([["k", new Date(0)]]) },
  "cycle": (() => { const o: Record<string, unknown> = {}; o.self = o; return o; })(),
  "Blob": new Blob(["hi"], { type: "text/plain" }),
  "class instance": new (class Point { x = 1; })(),
  "function": () => 1,
};
const describe = (v: unknown): string => {
  if (v instanceof Map) return `Map(${v.size})`;
  if (v instanceof Set) return `Set(${v.size})`;
  if (v instanceof Date) return `Date`;
  if (v instanceof Uint8Array) return `Uint8Array`;
  if (v instanceof Blob) return `Blob`;
  if (v instanceof RegExp) return "RegExp";
  if (v instanceof Error) return "Error";
  if (typeof v === "bigint") return "bigint";
  if (typeof v === "number") return Number.isNaN(v) ? "NaN" : "number";
  if (v && typeof v === "object") return `${v.constructor?.name ?? "null-proto"}{${Object.keys(v).map(k => `${k}:${describe((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return typeof v;
};
console.log("\n| value | " + Object.keys(codecs).join(" | ") + " |\n|---|" + Object.keys(codecs).map(() => "---|").join(""));
for (const [name, v] of Object.entries(samples)) {
  const cells = Object.values(codecs).map(c => {
    try { const back = c.dec(c.enc(v)); const d = describe(back); return d === describe(v) ? `ok (${d})` : `→ ${d}`; }
    catch (e) { return `throws: ${(e as Error).message.slice(0, 50)}`; }
  });
  console.log(`| ${name} | ${cells.join(" | ")} |`);
}

// Speed and size on a cache-shaped payload: 200 records with dates, ~60 KB JSON
const payload = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `user ${i}`, email: `u${i}@example.com`, tags: ["a", "b", "c"], score: i * 1.5, createdAt: new Date(1760000000000 + i).toISOString(), bio: "lorem ipsum dolor sit amet ".repeat(8) }));
const N = 2000;
console.log(`\nPayload: 200 records, ${JSON.stringify(payload).length} bytes as JSON. N=${N}`);
console.log("| codec | bytes | encode µs | decode µs |\n|---|---|---|---|");
for (const [name, c] of Object.entries(codecs)) {
  const bytes = c.enc(payload);
  let t = performance.now(); for (let i = 0; i < N; i++) c.enc(payload); const e = (performance.now() - t) * 1000 / N;
  t = performance.now(); for (let i = 0; i < N; i++) c.dec(bytes); const d = (performance.now() - t) * 1000 / N;
  console.log(`| ${name} | ${bytes.length} | ${e.toFixed(1)} | ${d.toFixed(1)} |`);
}
const raw = codecs.JSON.enc(payload);
console.log("\n| compression of the JSON bytes | bytes | ratio | compress µs | decompress µs |\n|---|---|---|---|---|");
const comps: Record<string, [(b: Uint8Array) => Uint8Array, (b: Uint8Array) => Uint8Array]> = {
  "gzip (level 6)": [b => Bun.gzipSync(b), b => Bun.gunzipSync(b)],
  "gzip (level 1)": [b => Bun.gzipSync(b, { level: 1 }), b => Bun.gunzipSync(b)],
  "deflate raw": [b => Bun.deflateSync(b), b => Bun.inflateSync(b)],
};
if (typeof Bun.zstdCompressSync === "function") comps["zstd (level 3)"] = [b => Bun.zstdCompressSync(b, { level: 3 }), b => Bun.zstdDecompressSync(b)];
for (const [name, [c, d]] of Object.entries(comps)) {
  const z = c(raw);
  let t = performance.now(); for (let i = 0; i < 500; i++) c(raw); const ce = (performance.now() - t) * 1000 / 500;
  t = performance.now(); for (let i = 0; i < 500; i++) d(z); const de = (performance.now() - t) * 1000 / 500;
  console.log(`| ${name} | ${z.length} | ${(raw.length / z.length).toFixed(1)}x | ${ce.toFixed(1)} | ${de.toFixed(1)} |`);
}
console.log(`\nload average at end: ${(await Bun.file("/proc/loadavg").text()).trim()}`);
