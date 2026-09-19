/**
 * The bun-node playground: bun-jobs, its management API and the bun-jobs-ui
 * app on one BunHttpAdapter, with a live simulation behind them, for trying
 * things by hand and seeing how they look.
 *
 * ```bash
 * bun playground/index.ts                         # http://localhost:4000/jobs
 * PORT=3000 bun playground/index.ts               # another port
 * PLAYGROUND_DRIVER=sqlite bun playground/index.ts   # survives a restart
 * PLAYGROUND_INTERVAL_MS=0 bun playground/index.ts   # seed only, then quiet
 * cd playground && bun run dev                    # restart on file changes
 * ```
 *
 * See README.md for what is where. Everything is allowed: this API's
 * `authorize` says yes to every action, the opt-ins (`Add job`, `Edit`)
 * included, so it must never be exposed beyond your machine. It listens on
 * 127.0.0.1 only.
 */
import process from "node:process";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_ACTIONS,
} from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
import { playgroundBackend, playgroundDriver } from "./backend";
import { startRunners } from "./runners";
import { startSimulation } from "./simulation";

/** The port to listen on (`PORT`, default 4000). */
const port = Number(process.env.PORT ?? 4000);
/** How often the simulation adds a job (`PLAYGROUND_INTERVAL_MS`, default 2000; 0 = never). */
const intervalMs = Number(process.env.PLAYGROUND_INTERVAL_MS ?? 2_000);

const jobs = new BunJobs({
  namespace: "playground",
  driver: playgroundDriver(),
  // Every queue, worker and runner publishes its events, so the UI goes live.
  publishEvents: true,
  logger: noopLogger,
});

const simulation = await startSimulation(jobs, { intervalMs });
const { stop: stopRunners } = await startRunners(jobs);

const api = createJobsApi({
  jobs,
  basePath: "/jobs-api",
  // A real host decides from a session; the playground allows everything.
  authorize: () => true,
  // Every action, the opt-in `jobs.add` and `jobs.update` included.
  actions: [...JOBS_API_ACTIONS],
  // `Add job` accepts any name.
  addableNames: "any",
  // The runner Trigger… dialog may pass arguments (see handlers/work.ts).
  runnerTriggerArgs: true,
  // The UI reads this from `api.info` and sends it on every mutation.
  csrf: { header: "x-bun-jobs-csrf" },
  // Failure panels show stack traces.
  serialize: { exposeStacks: true },
  // Queue state straight from the backend, so Pause shows at once.
  limits: { queueCacheMs: 0 },
  logger: noopLogger,
});
const ui = jobsUi({ api, title: "bun-node playground", logger: noopLogger });

const app = new BunHttpAdapter();
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);
app.get("/", (_req, res) => res.redirect(ui.basePath));
// The live-events socket, on the same port: `/meta` names its path.
api.websocket?.attach(app);

const server = await app.listen(port, "127.0.0.1");
const origin = `http://localhost:${server.port}`;

console.log(`
bun-node playground (${playgroundBackend()} driver)

  UI            ${origin}${ui.basePath}
  Queues        ${origin}${ui.basePath}/queues
  Runners       ${origin}${ui.basePath}/runners
  Events        ${origin}${ui.basePath}/events
  API docs      ${origin}${ui.basePath}/docs
  API           ${origin}${api.basePath}/meta

  A job is added every ${intervalMs > 0 ? `${intervalMs} ms` : "— never (PLAYGROUND_INTERVAL_MS=0)"}. Ctrl+C to stop.
`);

let stopping = false;
/** Stops everything cleanly, once. */
async function shutdown(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log("\nstopping…");
  await simulation.stop();
  await stopRunners();
  await api.close();
  await app.close();
  await jobs.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
