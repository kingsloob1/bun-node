// Speed: busboy as bun-common now drives it (one write, files collected
// from their streams) against Bun's native multipart parser, both starting
// from the body already buffered, as BunRequest holds it.
import busboy from "busboy";
const B = "SpeedBoundary";
const headers = { "content-type": `multipart/form-data; boundary=${B}` };
function body(fields: number, files: number, fileSize: number) {
  const parts: (string | Uint8Array)[] = [];
  for (let i = 0; i < fields; i++) parts.push(`--${B}\r\nContent-Disposition: form-data; name="field${i}"\r\n\r\nvalue ${i}\r\n`);
  for (let i = 0; i < files; i++) {
    parts.push(`--${B}\r\nContent-Disposition: form-data; name="file${i}"; filename="f${i}.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    parts.push(new Uint8Array(fileSize).fill(120 + (i % 5)));
    parts.push("\r\n");
  }
  parts.push(`--${B}--\r\n`);
  return Buffer.from(Buffer.concat(parts.map((p) => typeof p === "string" ? Buffer.from(p) : p)));
}
function viaBusboy(buf: Buffer) {
  return new Promise<{ fields: number; bytes: number }>((resolve, reject) => {
    const bb = busboy({ headers });
    let fields = 0, bytes = 0;
    const pending: Promise<void>[] = [];
    bb.on("field", () => { fields++; });
    bb.on("file", (_n, stream) => {
      pending.push(new Promise((res) => {
        const chunks: Buffer[] = [];
        stream.on("data", (d: Buffer) => chunks.push(d));
        stream.on("end", () => { bytes += Buffer.concat(chunks).length; res(); });
      }));
    });
    bb.on("close", async () => { await Promise.all(pending); resolve({ fields, bytes }); });
    bb.on("error", reject);
    bb.end(buf);
  });
}
async function viaFormData(buf: Buffer) {
  const fd = await new Response(buf, { headers }).formData();
  let fields = 0, bytes = 0;
  for (const [, v] of fd) {
    if (typeof v === "string") fields++;
    else bytes += Buffer.from(await v.arrayBuffer()).length;
  }
  return { fields, bytes };
}
const shapes: [string, Buffer][] = [
  ["1 field + 1 KiB file (the wrk scenario)", body(1, 1, 1024)],
  ["10 fields, no file", body(10, 0, 0)],
  ["50 fields, no file", body(50, 0, 0)],
  ["1 field + 100 KiB file", body(1, 1, 100 * 1024)],
  ["1 field + 1 MiB file", body(1, 1, 1024 * 1024)],
  ["5 files × 100 KiB", body(0, 5, 100 * 1024)],
  ["1 field + 10 MiB file", body(1, 1, 10 * 1024 * 1024)],
];
async function time(f: () => Promise<unknown>, size: number) {
  const n = Math.max(20, Math.min(20000, Math.floor(2e8 / Math.max(size, 2e4))));
  for (let i = 0; i < Math.ceil(n / 5); i++) await f();
  const t = performance.now();
  for (let i = 0; i < n; i++) await f();
  return (performance.now() - t) * 1000 / n;
}
console.log("| Upload | busboy | Bun formData() | ratio |\n|---|---:|---:|---:|");
for (const [name, buf] of shapes) {
  const a = await viaBusboy(buf), b = await viaFormData(buf);
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${name}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  const tb = await time(() => viaBusboy(buf), buf.length);
  const tf = await time(() => viaFormData(buf), buf.length);
  const fmt = (us: number) => us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : `${us.toFixed(1)} µs`;
  console.log(`| ${name} | ${fmt(tb)} | ${fmt(tf)} | ${(tb / tf).toFixed(1)}× |`);
}
