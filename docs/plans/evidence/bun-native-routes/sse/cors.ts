/**
 * CORS on an event stream: cors() headers set before the first chunk go out
 * with it, for res.write and for the prototype's sse() helper.
 *
 *   bun docs/plans/evidence/bun-native-routes/sse/cors.ts
 */
import { BunHttpAdapter, cors, noopLogger } from "@kingsleyweb/bun-common";
import { log, readEvents, show } from "./lib";
import { sse } from "./prototype-sse";

const a = new BunHttpAdapter(0, { logger: noopLogger });
a.use(cors({ origin: "https://app.example", credentials: true }));
a.get("/write", (_q, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.write("data: w\n\n");
  void res.end();
});
a.get("/helper", (req, res) => {
  const s = sse(req, res, { heartbeatMs: 0, open: false });
  void s.send({ data: "h" }).then(() => s.close());
});
const server = await a.listen(0);
for (const path of ["/write", "/helper"]) {
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { origin: "https://app.example" } });
  log(`cors() + ${path}`, `acao=${res.headers.get("access-control-allow-origin")} acac=${res.headers.get("access-control-allow-credentials")} vary=${res.headers.get("vary")} ${show(await readEvents(res.body, t0))}`);
}
await a.close();
process.exit(0);
