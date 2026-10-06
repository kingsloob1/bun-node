import * as lib from "../../../../../packages/bun-common/lib/index";
const B = "BunNodeBenchBoundary";
const file = "x".repeat(1024);
const buf = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue\r\n--${B}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n${file}\r\n--${B}--\r\n`);
const headers = { "content-type": `multipart/form-data; boundary=${B}`, "content-length": String(buf.length) };
const adapter = new lib.BunHttpAdapter(0, { request: { retainBuffer: false, parseBody: { contentTypes: { json: true, urlencoded: true, text: true, raw: true, xml: true, multipart: { opts: { detectFileType: false } } } } } });
const uploads = lib.transformUploadOptions({ storageType: "memory" });
adapter.post("/upload", async (req, res) => {
  const { body, file } = await lib.handleMultipartSingleFile(req, "file", uploads);
  res.json({ field: (body as any).field, size: file?.size });
});
const N = 20000;
const t = performance.now();
for (let i = 0; i < N; i++) await (await adapter.fetch(new Request("http://localhost/upload", { method: "POST", body: buf, headers }))).text();
console.log(((performance.now() - t) * 1000 / N).toFixed(1), "µs");
console.log(await (await adapter.fetch(new Request("http://localhost/upload", { method: "POST", body: buf, headers }))).text());
