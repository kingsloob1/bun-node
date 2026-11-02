/**
 * PR-C3's latency check: edit a route's schema in a running dev server
 * (bun-common's `devTypes()`), and time until `bun-client watch` (the real
 * bin) has rewritten the generated file with the change.
 *
 *   bun e2e.ts            # modes watch, hot; ITER=10 edits each
 *
 * - `watch`: `bun --watch server.ts`, a `BunHttpAdapter` that listens; each
 *   edit restarts the process, so the watcher reconnects and re-reads the
 *   token file (a new token per process).
 * - `hot`: `bun --hot server.ts`. A `BunHttpAdapter` cannot `listen()` again
 *   on a re-evaluation (EADDRINUSE, the open follow-up), so the server is one
 *   `Bun.serve()` kept on `globalThis` whose `fetch` and `websocket` delegate
 *   to the latest evaluation's adapter, which never listens (its
 *   `BunWebSocket` is given the kept server); `devTypes()`'s hub keeps the
 *   token and the watcher's socket across re-evaluations.
 *
 * Each mode runs in `.run/<mode>/` (git-ignored), where the server writes its
 * token file and the watcher, started there, finds it.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const root = join(here, "../../../../..");
const bin = join(root, "packages/bun-client/lib/codegen/cli.ts");
const ITER = Number(process.env.ITER ?? 10);

const routesSrc = (i: number) => `import type { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { validate } from "@kingsleyweb/bun-common";
import { z } from "zod";
export function buildRoutes(app: BunHttpAdapter) {
  const User = z.object({ id: z.string(), name: z.string(), extra_${i}: z.string() });
  app.get("/users/:id", validate({ params: z.object({ id: z.string() }) }, { responses: { 200: User } }), (req, res) => { res.json({ id: req.params.id, name: "a", extra_${i}: "x" }); });
  app.post("/users", validate({ body: z.object({ name: z.string() }) }, { responses: { 201: User } }), (_req, res) => { res.status(201).end(); });
}
`;

const serverSrc = `import { BunHttpAdapter, createTestLogger } from "@kingsleyweb/bun-common";
import { devTypes } from "@kingsleyweb/bun-common/lib/docs";
import { buildRoutes } from "./routes";
const g = globalThis as any;
const hot = process.env.MODE === "hot";
const app = new BunHttpAdapter(0, {
  logger: createTestLogger().logger,
  // Under --hot the adapter never listens: its sockets ride on the kept server.
  ...(hot ? { websocket: { getServer: () => g.__srv } } : {}),
} as any);
buildRoutes(app);
const dev = devTypes(app, { enabled: true, openapi: { title: "API", version: "1" } });
app.use(dev);
const port = Number(process.env.PORT);
if (!hot) {
  await app.listen(port, "127.0.0.1");
} else {
  g.__app = app;
  const active = () => g.__app.getBunWebsocket().wsHandler;
  g.__srv ??= Bun.serve({
    port, hostname: "127.0.0.1",
    fetch: (req: Request, server: unknown) => g.__app.handleNativeRequest(req, server),
    websocket: {
      open: (ws: unknown) => active().open?.(ws),
      message: (ws: unknown, m: unknown) => active().message?.(ws, m),
      close: (ws: unknown, c: number, r: string) => active().close?.(ws, c, r),
    },
  });
  dev.listening(g.__srv);
}
console.log(JSON.stringify({ event: "evaluated", at: Date.now() }));
`;

async function freePort() {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port;
  await s.stop(true);
  return p;
}
const pct = (xs: number[], p: number) => xs.toSorted((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

/** Collects a stream's lines. */
function lines(stream: ReadableStream<Uint8Array>, into: string[]) {
  void (async () => {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of stream) {
      rest += decoder.decode(chunk);
      const parts = rest.split("\n");
      rest = parts.pop() ?? "";
      into.push(...parts.filter(Boolean));
    }
  })();
}

async function runMode(mode: "watch" | "hot") {
  const dir = join(here, ".run", mode);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, "routes.ts"), routesSrc(0));
  await Bun.write(join(dir, "server.ts"), serverSrc);
  const out = join(dir, "api.gen.ts");
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), MODE: mode, NODE_ENV: "development" };
  const server = Bun.spawn(["bun", `--${mode}`, "server.ts"], { cwd: dir, env, stdout: "pipe", stderr: "inherit" });
  const serverLog: string[] = [];
  lines(server.stdout, serverLog);
  const tokenFile = join(dir, "node_modules/.cache/bun-types", `${port}.json`);
  for (let i = 0; i < 500 && !(await Bun.file(tokenFile).exists()); i++) await Bun.sleep(10);
  const watcher = Bun.spawn(["bun", bin, "watch", "--out", "api.gen.ts"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  const watchLog: string[] = [];
  const watchErr: string[] = [];
  lines(watcher.stdout, watchLog);
  lines(watcher.stderr, watchErr);
  const waitFor = async (needle: string, timeoutMs = 10_000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try { if ((await Bun.file(out).text()).includes(needle)) return Date.now(); } catch {}
      await Bun.sleep(2);
    }
    throw new Error(`${mode}: timed out waiting for ${needle}\n${watchLog.join("\n")}\n${watchErr.join("\n")}`);
  };
  await waitFor("extra_0");
  const totals: number[] = [];
  const fromEvaluation: number[] = [];
  try {
    for (let i = 1; i <= ITER; i++) {
      // Jittered, so the edits do not lock into phase with the server's
      // 100 ms route poll.
      await Bun.sleep(300 + Math.random() * 100);
      const t0 = Date.now();
      await Bun.write(join(dir, "routes.ts"), routesSrc(i));
      const t1 = await waitFor(`extra_${i}`);
      totals.push(t1 - t0);
      // From the server's (re-)evaluation finishing to the file: what the
      // announcement and the watcher add on top of Bun's reload.
      const evaluated = serverLog
        .map((l) => { try { return JSON.parse(l) as { event: string; at: number }; } catch { return undefined; } })
        .filter((e) => e?.event === "evaluated" && e.at >= t0)
        .at(-1);
      if (evaluated !== undefined) fromEvaluation.push(t1 - evaluated.at);
    }
  } finally {
    watcher.kill("SIGINT");
    const watcherExit = await watcher.exited;
    server.kill();
    await server.exited;
    if (watcherExit !== 0) console.error(`${mode}: the watcher exited ${watcherExit}`);
  }
  const regenerations = watchLog.filter((l) => / (wrote|unchanged) api\.gen\.ts /.test(l));
  const regenMs = regenerations.map((l) => Number(/, (\d+) ms\)/.exec(l)?.[1]));
  return {
    mode,
    iterations: ITER,
    editToFileMs: { median: pct(totals, 0.5), p90: pct(totals, 0.9), max: Math.max(...totals), min: Math.min(...totals) },
    evaluatedToFileMs: { median: pct(fromEvaluation, 0.5), p90: pct(fromEvaluation, 0.9), n: fromEvaluation.length },
    watcherRegenerateMsMedian: pct(regenMs, 0.5),
    regenerationLines: regenerations.length,
    followingLines: watchLog.filter((l) => l.includes(" following ")).length,
    serverEvaluations: serverLog.filter((l) => l.includes('"evaluated"')).length,
    watcherStderr: watchErr.filter((l) => !l.includes("warning") && !l.startsWith("  - ")),
  };
}

const results = [];
for (const mode of ["watch", "hot"] as const) {
  const r = await runMode(mode);
  console.log(JSON.stringify(r));
  results.push(r);
}
await Bun.write(
  join(here, "results.txt"),
  `${new Date().toISOString()} bun ${Bun.version} (${Bun.revision.slice(0, 9)}), ${process.platform}-${process.arch}, load ${(await Bun.file("/proc/loadavg").text()).split(" ")[0]}\n${results.map((r) => JSON.stringify(r)).join("\n")}\n`,
);
