import busboy from "busboy";
import { Readable } from "node:stream";
import { fileTypeFromBuffer } from "file-type";
import * as lib from "../../../../../packages/bun-common/lib/index";
const B = "BunNodeBenchBoundary";
const file = "x".repeat(1024);
const body = `--${B}\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue\r\n--${B}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n${file}\r\n--${B}--\r\n`;
const buf = Buffer.from(body);
const headers = { "content-type": `multipart/form-data; boundary=${B}` };
async function time(name: string, n: number, f: () => Promise<unknown>) {
  for (let i = 0; i < 500; i++) await f();
  const t = performance.now();
  for (let i = 0; i < n; i++) await f();
  console.log(name, ((performance.now() - t) * 1000 / n).toFixed(1), "µs");
}
await time("busboy only", 5000, () => new Promise<void>((res) => {
  const bb = busboy({ headers });
  bb.on("file", (_n, s) => { s.resume(); });
  bb.on("close", () => res());
  Readable.from(buf).pipe(bb);
}));
await time("busboy end(buf)", 5000, () => new Promise<void>((res) => {
  const bb = busboy({ headers });
  bb.on("file", (_n, s) => { s.resume(); });
  bb.on("close", () => res());
  bb.end(buf);
}));
await time("fileType", 5000, () => fileTypeFromBuffer(Buffer.from(file)));
await time("Request.formData", 5000, async () => {
  const fd = await new Request("http://x/", { method: "POST", body: buf, headers }).formData();
  await (fd.get("file") as File).arrayBuffer();
});
const router = new lib.BunRouter();
const uploads = lib.transformUploadOptions({ storageType: "memory" });
router.post("/upload", async (req, res) => {
  const { body, file } = await lib.handleMultipartSingleFile(req, "file", uploads);
  res.json({ field: (body as any).field, size: file?.size });
});
await time("router.fetch full", 3000, async () => {
  const r = await router.fetch("/upload", { method: "POST", body: buf, headers });
  await r.text();
});
console.log(await (await router.fetch("/upload", { method: "POST", body: buf, headers })).text());
