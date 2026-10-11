/**
 * End to end: edit a route's schema in a running dev server, and time until
 * the client's generated types file contains the change.
 *
 *   bun e2e.ts            # modes hot, watch, poll; 10 edits each
 *
 * Each mode runs in .run/<mode>/ (git-ignored): a copy of a small app whose
 * routes.ts is rewritten each iteration with a new field name.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const codegen = join(here, "../codegen");
const ITER = Number(process.env.ITER ?? 10);
const TOKEN = crypto.randomUUID();

const routesSrc = (i: number) => `import { BunRouter } from "@kingsleyweb/bun-common";
import { z } from "zod";
import { dv } from "${codegen}/describe";
export function buildRoutes() {
  const app = new BunRouter();
  const User = z.object({ id: z.string(), name: z.string(), extra_${i}: z.string() });
  app.get("/users/:id", dv({ params: z.object({ id: z.string() }) }, { 200: User }), (req, res) => { res.json({ id: req.params.id, name: "a", extra_${i}: "x" }); });
  app.post("/users", dv({ body: z.object({ name: z.string() }) }, { 201: User }), (_req, res) => { res.status(201).end(); });
  return app;
}
`;
const serverSrc = `import { buildRoutes } from "./routes";
import { buildModel } from "${codegen}/describe";
import { devTypes, publishModel } from "${here}/dev-types";
const g = globalThis as any;
const t0 = performance.now();
const app = buildRoutes();
const model = buildModel(app);
const modelMs = performance.now() - t0;
const dt = devTypes({ enabled: true, token: process.env.TOKEN });
const options = { port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: (req: Request, server: any) => dt.handle(req, server) ?? app.fetch(req), websocket: dt.websocket };
if (g.__srv) g.__srv.reload(options); else g.__srv = Bun.serve(options as any);
const { changed } = publishModel(model);
console.log(JSON.stringify({ event: "evaluated", hash: model.hash, changed, modelMs: +modelMs.toFixed(2), at: Date.now() }));
`;

async function freePort() {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port;
  s.stop(true);
  return p;
}
const pct = (xs: number[], p: number) => xs.toSorted((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

async function runMode(mode: "hot" | "watch" | "poll") {
  const dir = join(here, ".run", mode);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, "routes.ts"), routesSrc(0));
  await Bun.write(join(dir, "server.ts"), serverSrc);
  const out = join(dir, "routes.gen.ts");
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), TOKEN, NODE_ENV: "development" };
  const server = Bun.spawn(["bun", mode === "watch" ? "--watch" : "--hot", "server.ts"], { cwd: dir, env, stdout: "pipe", stderr: "inherit" });
  const serverLog: string[] = [];
  void (async () => { for await (const c of server.stdout) serverLog.push(...new TextDecoder().decode(c).split("\n").filter(Boolean)); })();
  await Bun.sleep(500);
  const watcher = Bun.spawn(["bun", join(here, "watch.ts"), `http://127.0.0.1:${port}`, TOKEN, out], { env: { ...env, POLL_MS: mode === "poll" ? "1000" : "0" }, stdout: "pipe", stderr: "inherit" });
  const watchLog: string[] = [];
  void (async () => { for await (const c of watcher.stdout) watchLog.push(...new TextDecoder().decode(c).split("\n").filter(Boolean)); })();
  const waitFor = async (needle: string, timeoutMs = 10_000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try { if ((await Bun.file(out).text()).includes(needle)) return Date.now(); } catch {}
      await Bun.sleep(2);
    }
    throw new Error(`${mode}: timed out waiting for ${needle}`);
  };
  await waitFor("extra_0");
  const totals: number[] = [];
  for (let i = 1; i <= ITER; i++) {
    await Bun.sleep(mode === "poll" ? 1300 + Math.random() * 1000 : 300);
    const t0 = Date.now();
    await Bun.write(join(dir, "routes.ts"), routesSrc(i));
    const t1 = await waitFor(`extra_${i}`);
    totals.push(t1 - t0);
  }
  // the unauthenticated and production refusals
  const noToken = await fetch(`http://127.0.0.1:${port}/__bun/types`);
  const withToken = await fetch(`http://127.0.0.1:${port}/__bun/types`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const etag = withToken.headers.get("etag");
  const notModified = await fetch(`http://127.0.0.1:${port}/__bun/types`, { headers: { authorization: `Bearer ${TOKEN}`, "if-none-match": etag ?? "" } });
  server.kill();
  watcher.kill();
  await Promise.all([server.exited, watcher.exited]);
  const written = watchLog.map(l => JSON.parse(l)).filter(e => e.event === "written");
  const reconnects = watchLog.filter(l => l.includes('"closed"')).length;
  const evaluated = serverLog.map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(e => e?.event === "evaluated");
  return {
    mode, iterations: ITER,
    editToFileMs: { median: pct(totals, 0.5), p90: pct(totals, 0.9), max: Math.max(...totals), min: Math.min(...totals) },
    watcherFetchMsMedian: pct(written.map(w => w.fetchMs), 0.5),
    watcherEmitWriteMsMedian: pct(written.map(w => w.emitWriteMs), 0.5),
    serverModelMsMedian: pct(evaluated.map(e => e.modelMs), 0.5),
    serverEvaluations: evaluated.length,
    watcherReconnects: reconnects,
    noTokenStatus: noToken.status, withTokenStatus: withToken.status, ifNoneMatchStatus: notModified.status,
  };
}

const results = [];
for (const mode of ["hot", "watch", "poll"] as const) {
  const r = await runMode(mode);
  console.log(JSON.stringify(r));
  results.push(r);
}
// fail closed under production
const prod = Bun.spawnSync(["bun", "-e", `import { devTypes } from "${here}/dev-types"; try { devTypes({ enabled: true }); console.log("STARTED"); } catch (e) { console.log("REFUSED:", e.message); }`], { env: { ...process.env, NODE_ENV: "production" } });
const prodLine = prod.stdout.toString().trim();
console.log(prodLine);
await Bun.write(join(here, "results.txt"), `${new Date().toISOString()} bun ${Bun.version} (${Bun.revision.slice(0, 9)}), ${process.platform}-${process.arch}\n${results.map(r => JSON.stringify(r)).join("\n")}\nproduction: ${prodLine}\n`);
