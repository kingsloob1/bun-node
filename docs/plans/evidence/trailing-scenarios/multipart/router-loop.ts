import * as lib from "../../../../../packages/bun-common/lib/index";
const B = "BunNodeBenchBoundary";
const file = "x".repeat(1024);
const buf = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue\r\n--${B}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n${file}\r\n--${B}--\r\n`);
const headers = { "content-type": `multipart/form-data; boundary=${B}` };
const router = new lib.BunRouter();
const served = process.env.SERVED === "1";
const uploads = lib.transformUploadOptions({ storageType: "memory" });
router.post("/upload", async (req, res) => {
  const { body, file } = await lib.handleMultipartSingleFile(req, "file", uploads);
  res.json({ field: (body as any).field, size: file?.size });
});
const t = performance.now();
for (let i = 0; i < 30000; i++) await (await router.fetch("/upload", { method: "POST", body: buf, headers })).text();
console.log(((performance.now() - t) * 1000 / 30000).toFixed(1), "µs");
