import * as lib from "../../../../../packages/bun-common/lib/index";
const capped = process.env.CAPPED === "1";
const adapter = new lib.BunHttpAdapter(0, { request: capped ? { retainBuffer: false, parseBody: { contentTypes: { json: true, urlencoded: true, text: true, raw: true, xml: true, multipart: true } } } : { retainBuffer: false } });
adapter.post("/form", (req, res) => { res.json(req.body as any); });
adapter.post("/json", (req, res) => { res.json({ ok: true, n: (req.body as any).n }); });
const server = await adapter.listen(0);
console.log(`READY ${server.port}`);
process.on("SIGINT", () => process.exit(0));
