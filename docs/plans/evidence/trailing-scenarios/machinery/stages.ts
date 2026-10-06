import * as lib from "../../../../../packages/bun-common/lib/index";
import { BunRequest } from "../../../../../packages/bun-common/lib/BunRequest";
import { BunResponse } from "../../../../../packages/bun-common/lib/BunResponse";
import { RequestPipelineOptions } from "../../../../../packages/bun-common/lib/BunRouter";
const stub = { requestIP: () => null, upgrade: () => false } as never;
const reqOpts = { retainBuffer: false, parseBody: { contentTypes: { json: true, urlencoded: true, text: true, raw: true, xml: true, multipart: { opts: { detectFileType: false } } } } };
const adapter = new lib.BunHttpAdapter(0, { request: reqOpts });
adapter.get("/user/:id", (req, res) => { res.send(req.params.id); });
const router = (adapter as any).instance;
const url = "http://localhost/user/42";
async function time(name: string, f: () => unknown) {
  for (let i = 0; i < 30000; i++) { const r = f(); if (r instanceof Promise) await r; }
  let best = Infinity;
  for (let k = 0; k < 9; k++) { const t = performance.now(); for (let i = 0; i < 100000; i++) { const r = f(); if (r instanceof Promise) await r; } best = Math.min(best, (performance.now() - t) * 10); }
  console.log(name.padEnd(48), best.toFixed(0), "ns");
}
await time("new Request", () => new Request(url));
await time("+ BunRequest.init", () => BunRequest.init(new Request(url), stub, reqOpts as any));
await time("+ new BunResponse", () => { const q = BunRequest.init(new Request(url), stub, reqOpts as any) as BunRequest; return new BunResponse(q, { etag: false }); });
await time("+ RequestPipelineOptions + getMatchedLayers", () => { const q = BunRequest.init(new Request(url), stub, reqOpts as any) as BunRequest; const s = new BunResponse(q, { etag: false }); const o = new RequestPipelineOptions(q, s, q.method, q.path, 0); return router.getMatchedLayers(o); });
await time("+ send('42') + native response", () => { const q = BunRequest.init(new Request(url), stub, reqOpts as any) as BunRequest; const s = new BunResponse(q, { etag: false }); const o = new RequestPipelineOptions(q, s, q.method, q.path, 0); router.getMatchedLayers(o); s.send("42"); return s.getNativeResponse(0); });
await time("new Request + new Response('42')", () => { new Request(url); return new Response("42"); });
await time("whole: serveNativeRequest", () => (adapter as any).serveNativeRequest(new Request(url), stub));
