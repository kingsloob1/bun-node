// Where an upload request's time goes: ours (served path, stub socket) against Elysia 2.
import * as lib from "../../../../../packages/bun-common/lib/index";
import { BunRequest } from "../../../../../packages/bun-common/lib/BunRequest";
const { Elysia } = await import("../../../../../benchmarks/node_modules/elysia2");
process.env.NODE_ENV = "production";
const B = "BunNodeBenchBoundary";
const body = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="field"\r\n\r\nv\r\n--${B}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n${"x".repeat(1024)}\r\n--${B}--\r\n`);
const headers = { "content-type": `multipart/form-data; boundary=${B}`, "content-length": String(body.length), host: "localhost" };
const mk = () => new Request("http://localhost/upload", { method: "POST", body, headers });
const stub = { requestIP: () => null, upgrade: () => false } as never;
const PARSE = { contentTypes: { json: true, urlencoded: true, text: true, raw: true, xml: true, multipart: { opts: { detectFileType: false } } } };
const reqOpts = { retainBuffer: false, parseBody: PARSE };

const adapter = new lib.BunHttpAdapter(0, { request: reqOpts });
const uploads = lib.transformUploadOptions({ storageType: "memory" });
adapter.post("/upload", async (req, res) => {
  const { body, file } = await lib.handleMultipartSingleFile(req, "file", uploads);
  (res as any).json({ field: (body as any).field, size: file?.size });
});
const el = new Elysia().post("/upload", ({ body }: any) => ({ field: body.field, size: body.file.size }));
el.compile?.();

async function time(name: string, f: () => unknown, n = 30000) {
  for (let i = 0; i < 3000; i++) await f();
  let best = Infinity;
  for (let r = 0; r < 5; r++) {
    const t = performance.now();
    for (let i = 0; i < n; i++) await f();
    best = Math.min(best, (performance.now() - t) * 1000 / n);
  }
  console.log(name.padEnd(62), best.toFixed(2), "µs");
}
const check = async (r: Response) => { const t = await r.text(); if (!t.includes('"size":1024')) throw new Error(t); };
await check(await (adapter as any).serveNativeRequest(mk(), stub));
await check(await el.handle(mk()));
await time("new Request only", () => mk());
await time("new Request + arrayBuffer()", async () => mk().arrayBuffer());
await time("new Request + formData() (Elysia's parse)", async () => mk().formData());
await time("Elysia 2: app.handle(), whole request", async () => (await el.handle(mk())).text());
await time("ours: BunRequest.init (read + multipart parse)", async () => BunRequest.init(mk(), stub, reqOpts as any));
await time("ours: init + getMultiParts(upload opts) (cached)", async () => {
  const r = await BunRequest.init(mk(), stub, reqOpts as any);
  return r.getMultiParts(lib.getBusBoyConfig(uploads));
});
await time("ours: init + handleMultipartSingleFile", async () => {
  const r = await BunRequest.init(mk(), stub, reqOpts as any);
  return lib.handleMultipartSingleFile(r, "file", uploads);
});
await time("ours: adapter serveNativeRequest, whole request", async () => (await (adapter as any).serveNativeRequest(mk(), stub)).text());
