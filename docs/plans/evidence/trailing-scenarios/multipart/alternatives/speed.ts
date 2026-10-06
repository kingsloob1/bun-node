import busboy from "busboy";
import fastifyBusboy from "@fastify/busboy";
import { parseMultipart as parseMultipartMjackson } from "@mjackson/multipart-parser";
import { parseMultipart } from "@remix-run/multipart-parser";
import * as Multipasta from "multipasta";
import { parseBufferedMultipart as parseBuffered } from "../../../../../../packages/bun-common/lib/multipart/buffered";
const B = "SpeedBoundary";
const ct = `multipart/form-data; boundary=${B}`;
const headers = { "content-type": ct };
function body(fields: number, files: number, fileSize: number) {
  const parts: Buffer[] = [];
  for (let i = 0; i < fields; i++) parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="field${i}"\r\n\r\nvalue ${i}\r\n`));
  for (let i = 0; i < files; i++) {
    parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file${i}"; filename="f${i}.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(Buffer.alloc(fileSize, 120 + (i % 5)));
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${B}--\r\n`));
  return Buffer.concat(parts);
}
type R = { fields: number; bytes: number };
const streamed = (make: () => any) => (buf: Buffer) => new Promise<R>((resolve, reject) => {
  const bb = make();
  let fields = 0, bytes = 0;
  const pending: Promise<void>[] = [];
  bb.on("field", () => { fields++; });
  bb.on("file", (_n: string, s: any) => pending.push(new Promise((r) => {
    const c: Buffer[] = []; s.on("data", (d: Buffer) => c.push(d)); s.on("end", () => { bytes += Buffer.concat(c).length; r(); });
  })));
  bb.on("finish", async () => { await Promise.all(pending); resolve({ fields, bytes }); });
  bb.on("error", reject);
  bb.end(buf);
});
const candidates: [string, (buf: Buffer) => Promise<R> | R][] = [
  ["busboy 1.6 (today)", streamed(() => busboy({ headers }))],
  ["@fastify/busboy 3.2", streamed(() => new (fastifyBusboy as any)({ headers }))],
  ["bun-common (lib/multipart/buffered.ts)", (buf) => {
    let fields = 0, bytes = 0;
    for (const e of parseBuffered(buf, ct)!) { if (e.kind === "field") fields++; else bytes += e.data.length; }
    return { fields, bytes };
  }],
  ["Bun formData()", async (buf) => {
    const fd = await new Response(buf, { headers }).formData();
    let fields = 0, bytes = 0;
    for (const [, v] of fd) { if (typeof v === "string") fields++; else bytes += (await v.bytes()).length; }
    return { fields, bytes };
  }],
  ["@remix-run/multipart-parser 1.0", (buf) => {
    let fields = 0, bytes = 0;
    for (const p of parseMultipart(buf, { boundary: B, maxFileSize: Infinity, maxTotalSize: Infinity })) {
      if (p.isFile) bytes += p.bytes.length; else { p.text; fields++; }
    }
    return { fields, bytes };
  }],
  ["@mjackson/multipart-parser 0.10 (remix-the-web)", (buf) => {
    let fields = 0, bytes = 0;
    for (const p of parseMultipartMjackson(buf, { boundary: B, maxFileSize: Infinity })) {
      if (p.isFile) bytes += p.bytes.length; else { p.text; fields++; }
    }
    return { fields, bytes };
  }],
  ["multipasta 0.2", (buf) => {
    let fields = 0, bytes = 0, done = false;
    const chunks: Uint8Array[] = [];
    const p = Multipasta.make({
      headers,
      onField: (_i, v) => { Multipasta.decodeField(_i, v); fields++; },
      onFile: () => (c) => { if (c === null) { bytes += Buffer.concat(chunks).length; chunks.length = 0; } else chunks.push(c); },
      onError: (e) => { throw new Error(JSON.stringify(e)); },
      onDone: () => { done = true; },
    });
    p.write(buf); p.end();
    if (!done) throw new Error("not done");
    return { fields, bytes };
  }],
];
const shapes: [string, Buffer][] = [
  ["1 field + 1 KiB file (wrk)", body(1, 1, 1024)],
  ["10 fields", body(10, 0, 0)],
  ["50 fields", body(50, 0, 0)],
  ["1 field + 100 KiB file", body(1, 1, 100 * 1024)],
  ["1 field + 1 MiB file", body(1, 1, 1024 * 1024)],
  ["5 files × 100 KiB", body(0, 5, 100 * 1024)],
  ["1 field + 10 MiB file", body(1, 1, 10 * 1024 * 1024)],
];
async function time(f: () => unknown, size: number) {
  const n = Math.max(20, Math.min(20000, Math.floor(2e8 / Math.max(size, 2e4))));
  for (let i = 0; i < Math.ceil(n / 5); i++) await f();
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t = performance.now();
    for (let i = 0; i < n; i++) await f();
    best = Math.min(best, (performance.now() - t) * 1000 / n);
  }
  return best;
}
const fmt = (us: number) => us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : `${us.toFixed(1)} µs`;
console.log(`| Upload | ${candidates.map((c) => c[0]).join(" | ")} |`);
console.log(`|---|${candidates.map(() => "---:").join("|")}|`);
for (const [name, buf] of shapes) {
  const ref = JSON.stringify(await candidates[0][1](buf));
  const row: string[] = [];
  for (const [cname, f] of candidates) {
    const got = JSON.stringify(await f(buf));
    if (got !== ref) { row.push(`wrong (${got})`); continue; }
    row.push(fmt(await time(() => f(buf), buf.length)));
  }
  console.log(`| ${name} | ${row.join(" | ")} |`);
}
