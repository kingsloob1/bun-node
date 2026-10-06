// Served layers for a static GET and a JSON POST (LAYER=...), for wrk.
import * as lib from "../../../../../packages/bun-common/lib/index";
import { BunRequest } from "../../../../../packages/bun-common/lib/BunRequest";
import { BunResponse } from "../../../../../packages/bun-common/lib/BunResponse";
const layer = process.env.LAYER!;
const reqOpts = { retainBuffer: false, parseBody: { contentTypes: { json: true, urlencoded: true, text: true, raw: true, xml: true, multipart: { opts: { detectFileType: false } } } } };
let port: number;
if (layer === "adapter") {
  const adapter = new lib.BunHttpAdapter(0, { request: reqOpts });
  adapter.get("/static", (_req, res) => { res.send("ok"); });
  adapter.post("/json", (req, res) => { (res as any).json({ ok: true, n: (req.body as any).n }); });
  port = (await adapter.listen(0)).port!;
} else {
  port = Bun.serve({
    port: 0,
    fetch(req, server) {
      const get = req.method === "GET";
      switch (layer) {
        case "raw+1h": { req.headers.get("content-type"); return req.json().then((b: any) => Response.json({ ok: true, n: b.n })); }
        case "raw+6h": { const h = req.headers; h.get("content-type"); h.get("content-length"); h.get("transfer-encoding"); h.get("content-encoding"); h.get("content-length"); h.get("transfer-encoding"); return req.json().then((b: any) => Response.json({ ok: true, n: b.n })); }
        case "raw+url": { if (req.url.length < 3) throw 1; return new Response("ok"); }
        case "raw+split": { const u = req.url; const s = u.indexOf("/", u.indexOf("//") + 2); const q = u.indexOf("?", s); const path = q === -1 ? u.slice(s) : u.slice(s, q); if (path.length < 1) throw 1; return new Response("ok"); }
        case "raw+ctor": { const r = BunRequest.init(req, server, reqOpts as any) as BunRequest; return new Response("ok"); }
        case "raw+ctor+path": { const r = BunRequest.init(req, server, reqOpts as any) as BunRequest; if (r.path.length < 1) throw 1; return new Response("ok"); }
        case "raw": return get ? new Response("ok") : req.json().then((b: any) => Response.json({ ok: true, n: b.n }));
        case "init": {
          const r = BunRequest.init(req, server, reqOpts as any);
          if (r instanceof BunRequest) return new Response("ok");
          return r.then((q) => Response.json({ ok: true, n: (q.body as any).n }));
        }
        case "init+res": {
          const fin = (q: BunRequest) => { const s = new BunResponse(q, {}); if (get) s.send("ok"); else (s as any).json({ ok: true, n: (q.body as any).n }); return s.getNativeResponse(0); };
          const r = BunRequest.init(req, server, reqOpts as any);
          return r instanceof BunRequest ? fin(r) : r.then(fin);
        }
      }
      return new Response("?");
    },
  }).port!;
}
console.log(`READY ${port}`);
process.on("SIGINT", () => process.exit(0));
