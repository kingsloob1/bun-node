import * as lib from "../../../../../packages/bun-common/lib/index";
const stub = { requestIP: () => null, upgrade: () => false } as never;
const PARSE = { contentTypes: { json: true, urlencoded: true, text: true, raw: true, xml: true, multipart: { opts: { detectFileType: false } } } };
const B = "BunNodeBenchBoundary";
const mp = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="field"\r\n\r\nv\r\n--${B}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n${"x".repeat(1024)}\r\n--${B}--\r\n`);
const ct = `multipart/form-data; boundary=${B}`;
const mk = (p: string) => new Request("http://localhost" + p, { method: "POST", body: mp, headers: { "content-type": ct, "content-length": String(mp.length) } });
const adapter = new lib.BunHttpAdapter(0, { request: { retainBuffer: false, parseBody: PARSE } });
const uploads = lib.transformUploadOptions({ storageType: "memory" });
adapter.post("/sync", (req, res) => { (res as any).json({ field: (req.body as any)?.field, size: 1024 }); });
adapter.post("/sync-text", (req, res) => { res.send("ok"); });
adapter.post("/async", async (req, res) => { (res as any).json({ field: (req.body as any)?.field, size: 1024 }); });
adapter.post("/upload", async (req, res) => {
  const { body, file } = await lib.handleMultipartSingleFile(req, "file", uploads);
  (res as any).json({ field: (body as any).field, size: file?.size });
});
async function time(name: string, f: () => unknown) {
  for (let i = 0; i < 20000; i++) await f();
  let best = Infinity;
  for (let r = 0; r < 7; r++) { const t = performance.now(); for (let i = 0; i < 50000; i++) await f(); best = Math.min(best, (performance.now() - t) * 20); }
  console.log(name.padEnd(48), (best / 1000).toFixed(2), "µs");
}
for (const p of ["/sync-text", "/sync", "/async", "/upload"]) {
  console.log(p, await (await (adapter as any).serveNativeRequest(mk(p), stub)).text());
  await time(`serveNativeRequest ${p}`, async () => (await (adapter as any).serveNativeRequest(mk(p), stub)).text());
}
