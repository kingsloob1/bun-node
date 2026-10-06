// One served layer at a time, for wrk: LAYER selects what the server does with an upload.
import * as lib from "../../../../../packages/bun-common/lib/index";
import { BunRequest } from "../../../../../packages/bun-common/lib/BunRequest";
import { parseBufferedMultipart } from "../../../../../packages/bun-common/lib/multipart/buffered";
const layer = process.env.LAYER!;
const reqOpts = { retainBuffer: false, parseBody: { contentTypes: { json: true, urlencoded: true, text: true, raw: true, xml: true, multipart: { opts: { detectFileType: false } } } } };
const uploads = lib.transformUploadOptions({ storageType: "memory" });
const RAW_OPTS = { parseBody: { contentTypes: { json: true } }, retainBuffer: false };
const NO_PARSE = { parseBody: false };
let port: number;
if (layer === "adapter") {
  const adapter = new lib.BunHttpAdapter(0, { request: reqOpts });
  adapter.post("/upload", async (req, res) => {
    const { body, file } = await lib.handleMultipartSingleFile(req, "file", uploads);
    (res as any).json({ field: (body as any).field, size: file?.size });
  });
  port = (await adapter.listen(0)).port!;
} else {
  port = Bun.serve({
    port: 0,
    async fetch(req, server) {
      switch (layer) {
        case "formData": { const fd = await req.formData(); return Response.json({ field: fd.get("field"), size: (fd.get("file") as File).size }); }
        case "arrayBuffer": { const b = Buffer.from(await req.arrayBuffer()); return Response.json({ field: "v", size: b.length }); }
        case "parse": { const b = Buffer.from(await req.arrayBuffer()); const parts = parseBufferedMultipart(b, req.headers.get("content-type")!)!; return Response.json({ field: (parts[0] as any).value, size: (parts[1] as any).data.length }); }
        case "parse-copy": { const b = Buffer.from(Buffer.from(await req.arrayBuffer())); const parts = parseBufferedMultipart(b, req.headers.get("content-type")!)!; return Response.json({ field: (parts[0] as any).value, size: (parts[1] as any).data.length }); }
        case "parse-twice": { const b = Buffer.from(await req.arrayBuffer()); const ct = req.headers.get("content-type")!; parseBufferedMultipart(b, ct); const parts = parseBufferedMultipart(b, ct)!; return Response.json({ field: (parts[0] as any).value, size: (parts[1] as any).data.length }); }
        case "indexOf": { const b = Buffer.from(await req.arrayBuffer()); const n = Buffer.from("\r\n--BunNodeBenchBoundary"); let c = 0, i = 0; while ((i = b.indexOf(n, i)) !== -1) { c++; i += n.length; } return Response.json({ field: "v", size: c }); }
        case "latin1": { const b = Buffer.from(await req.arrayBuffer()); const s = b.toString("latin1", 0, 120) + b.toString("latin1", 130, 260); return Response.json({ field: "v", size: s.length }); }
        case "ctor+parse": { const r = await BunRequest.init(req, server, NO_PARSE as any); const b = Buffer.from(await req.arrayBuffer()); const parts = parseBufferedMultipart(b, r.get("content-type") as string)!; return Response.json({ field: (parts[0] as any).value, size: (parts[1] as any).data.length }); }
        case "rawinit+parse": { const r = await BunRequest.init(req, server, RAW_OPTS as any); const b = r.body as Buffer; const parts = parseBufferedMultipart(b, r.get("content-type") as string)!; return Response.json({ field: (parts[0] as any).value, size: (parts[1] as any).data.length }); }
        case "ab+bodyUsed": { if (req.bodyUsed) throw 1; const b = Buffer.from(await req.arrayBuffer()); return Response.json({ field: "v", size: b.length }); }
        case "ab+body": { if (!req.body) throw 1; const b = Buffer.from(await req.arrayBuffer()); return Response.json({ field: "v", size: b.length }); }
        case "ab+headers": { req.headers.get("content-length"); req.headers.get("transfer-encoding"); req.headers.get("content-encoding"); const b = Buffer.from(await req.arrayBuffer()); return Response.json({ field: "v", size: b.length }); }
        case "bytes": { const b = await req.bytes(); return Response.json({ field: "v", size: b.length }); }
        case "text": { const t = await req.text(); return Response.json({ field: "v", size: t.length }); }
        case "blob": { const b = await req.blob(); return Response.json({ field: "v", size: b.size }); }
        case "blob-bytes": { const b = await (await req.blob()).bytes(); return Response.json({ field: "v", size: b.length }); }
        case "stream": { let n = 0; for await (const c of req.body!) n += c.length; return Response.json({ field: "v", size: n }); }
        case "blob-ab": { const b = Buffer.from(await (await req.blob()).arrayBuffer()); return Response.json({ field: "v", size: b.length }); }
        case "blob-bytes-buf": { const u = await (await req.blob()).bytes(); const b = Buffer.from(u.buffer, u.byteOffset, u.byteLength); return Response.json({ field: "v", size: b.length }); }
        case "bb-proto": { const u = await (await req.blob()).bytes(); Object.setPrototypeOf(u, Buffer.prototype); const b = u as Buffer; const s = b.toString("latin1", 0, 120); const i = b.indexOf("--BunNode", 10); return Response.json({ field: s.length, size: i }); }
        case "bb-proto-sub": { const u = await (await req.blob()).bytes(); Object.setPrototypeOf(u, Buffer.prototype); const b = u as Buffer; const v = b.subarray(200, 1200); return Response.json({ field: "v", size: v.length }); }
        case "bb-proto-slice": { const u = await (await req.blob()).bytes(); const v = Uint8Array.prototype.slice.call(u, 200, 1200); return Response.json({ field: "v", size: v.length }); }
        case "bb-parse": { const u = await (await req.blob()).bytes(); Object.setPrototypeOf(u, Buffer.prototype); const parts = parseBufferedMultipart(u as Buffer, req.headers.get("content-type")!)!; return Response.json({ field: (parts[0] as any).value, size: (parts[1] as any).data.length }); }
        case "bb-copy": { const u = await (await req.blob()).bytes(); const b = Buffer.from(u); const s = b.toString("latin1", 0, 120); const i = b.indexOf("--BunNode", 10); const f = Buffer.copyBytesFrom(b, 200, 1000); return Response.json({ field: s.length + i, size: f.length }); }
        case "bb-copy-slice": { const u = await (await req.blob()).bytes(); const b = Buffer.from(u); const f = Uint8Array.prototype.slice.call(b, 200, 1200); return Response.json({ field: Buffer.isBuffer(f), size: f.length }); }
        case "init": { const r = await BunRequest.init(req, server, reqOpts as any); const m = await r.getMultiParts({}); return Response.json({ field: m.fields.field, size: [...m.files.keys()][0].file.length }); }
        case "init+handler": { const r = await BunRequest.init(req, server, reqOpts as any); const { body, file } = await lib.handleMultipartSingleFile(r, "file", uploads); return Response.json({ field: (body as any).field, size: file?.size }); }
      }
      return new Response("?");
    },
  }).port!;
}
console.log(`READY ${port}`);
process.on("SIGINT", () => process.exit(0));
