/**
 * The bun-node playground: bun-jobs, its management API and the bun-jobs-ui
 * app on one BunHttpAdapter, with a live simulation behind them, for trying
 * things by hand and seeing how they look.
 *
 * ```bash
 * bun playground/index.ts                         # http://localhost:4000/jobs
 * PORT=3000 bun playground/index.ts               # another port
 * PLAYGROUND_DRIVER=sqlite bun playground/index.ts   # survives a restart
 * PLAYGROUND_DRIVER=memory bun playground/index.ts   # no disk, no summoning
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
  createDriver,
  createJobsApi,
  JOBS_API_ACTIONS,
} from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
import {
  isCrossProcess,
  playgroundBackend,
  playgroundDriver,
  removeTempData,
} from "./backend";
import { LocalCompute } from "./compute/platform";
import { localCompute } from "./compute/provider";
import { startMailer } from "./mailer";
import { startRunners } from "./runners";
import { startSimulation } from "./simulation";
import { mountSummoning } from "./summoning";

/** The port to listen on (`PORT`, default 4000). */
const port = Number(process.env.PORT ?? 4000);
/** How often the simulation adds a job (`PLAYGROUND_INTERVAL_MS`, default 2000; 0 = never). */
const intervalMs = Number(process.env.PLAYGROUND_INTERVAL_MS ?? 2_000);

// A `temp` database a killed playground left behind.
removeTempData("stale");

/**
 * The one driver both contexts share. It is an instance, not a config: with
 * `memory` each context would otherwise build its own `Map`s and the two
 * services would not see each other's queues.
 */
const driver = createDriver(playgroundDriver());

const jobs = new BunJobs({
  namespace: "playground",
  // Names this process in the worker inventory and in every worker's stable
  // key, so the Workers page groups by it: `api.emails`, `api.reports`, …
  service: "api",
  driver,
  // Every queue, worker and runner publishes its events, so the UI goes live.
  publishEvents: true,
  logger: noopLogger,
});

const simulation = await startSimulation(jobs, { intervalMs });
// A second service on the same backend, so the Workers page has two to group.
const mailer = await startMailer({
  namespace: "playground",
  driver,
  logger: noopLogger,
});
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
  // Failure panels show stack traces, and a worker's Target card shows the
  // processor file it runs (see targets.ts). Both are paths a real host may
  // prefer to keep to itself; the playground's are in this repo anyway.
  serialize: { exposeStacks: true, exposeProcessorFiles: true },
  // Queue state straight from the backend, so Pause shows at once.
  limits: { queueCacheMs: 0 },
  logger: noopLogger,
});
const ui = jobsUi({
  api,
  title: "bun-node playground",
  logger: noopLogger,
  // Always build the app from the source on disk. Unset, `jobsUi()` prefers a
  // prebuilt `dist/` whenever one exists — and packing the package (`prepack`,
  // which the consumer check runs) leaves one behind, so the playground then
  // served a stale snapshot and hid every UI change made after it.
  dev: true,
});

const app = new BunHttpAdapter();
// Summoning (`summoning.ts`): its platform's routes go on this adapter, and
// its providers and controller are configured once the port is known.
const summoning = mountSummoning(jobs, {
  app,
  // What a summoned worker process opens: the same backend, as a config.
  driver: isCrossProcess() ? playgroundDriver() : undefined,
});
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);
app.get("/", (_req, res) => res.redirect(ui.basePath));
// The live-events socket, on the same port: `/meta` names its path.
api.websocket?.attach(app);

const server = await app.listen(port, "127.0.0.1");
const origin = `http://localhost:${server.port}`;
// The platform's API is called from this process, so by the address it
// listens on: `localhost` may resolve to `::1`, where nothing listens.
summoning.start(`${origin}`);

const localComputeForObinnaQueueWorker = new LocalCompute({
  basePath: "/obinna-local-compute",
  tokens: ["admin"],
  entry: new URL("./compute/obinna-queue-worker.ts", import.meta.url).pathname,
  maxUnits: 4,
});

localComputeForObinnaQueueWorker.mount(app);

const obinnaQueue = jobs.queue("obinna-queue");
// Add a schedule that runs every 5 seconds
obinnaQueue.add(
  "ping-obinna",
  { dataId: `data-${Date.now()}` },
  {
    repeat: { every: "5 seconds", key: "ping-obinna", catchUp: false },
  },
);

const localComputeSummoner = localCompute({
  url: `${origin}${localComputeForObinnaQueueWorker.basePath}`,
  region: "obinna-queue-compute-summoner",
  pool: "obinna-queue",
  apiToken: "admin",
});

jobs.summonController("obinna-queue", {
  summoner: localComputeSummoner,
  // A big burst gets a second worker.
  maxWorkers: 5,
  jobsPerWorker: 8,
  // Tighter than the defaults, so a playground session sees the whole
  // cycle: a check every 5 s, a retry within seconds, and a circuit
  // that closes again after a minute.
  triggers: { poll: 5_000 },
  cooldown: 5_000,
  backoff: { initial: 5_000, max: 30_000 },
  circuit: { failures: 3, resetAfter: 60_000 },
  budget: { perHour: 20_000, perDay: 500_000 },
  // budget: { perHour: 240, perDay: 2_000 },
  maxLifetime: 3_600_000, // 1 hour
  // Static, the same for every attempt: how a unit reaches the backend.
  env: { PLAYGROUND_SUMMON_DRIVER: JSON.stringify(playgroundDriver()) },
});

// Use fluent API to add jobs to the obinnaQueue
// jobs.define("call-obinna", async (job: Job<{ dataId: string }>) => {
//   await job.log(`calling obinna with ${job.data.dataId}`);
//   await sleep(between(500, 1_000));
//   if (Math.random() < 0.2) {
//     throw new Error(`obinna refused ${job.data.dataId}`);
//   }

//   await job.log(`Called obinna with ${job.data.dataId}`);
//   return { result: `obinna processed ${job.data.dataId}` };
// });

console.log(`
bun-node playground (${playgroundBackend()} driver)

  UI            ${origin}${ui.basePath}
  Queues        ${origin}${ui.basePath}/queues
  Workers       ${origin}${ui.basePath}/workers
  Runners       ${origin}${ui.basePath}/runners
  Events        ${origin}${ui.basePath}/events
  API docs      ${origin}${ui.basePath}/docs
  Providers     ${origin}${ui.basePath}/providers
  Summoning     ${origin}${ui.basePath}/queues/renders${isCrossProcess() ? "" : "   (off: the memory driver cannot summon)"}
  Faults        ${origin}/local-compute
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

  // Every summoned worker process, before the backend they use closes.
  await Promise.allSettled([
    localComputeForObinnaQueueWorker.stop(),
    simulation.stop(),
    summoning.stop(),
    mailer.stop(),
    stopRunners(),
  ]);

  // The backend, after every summoned worker process has stopped.
  await Promise.allSettled([api.close(), app.close(), jobs.close()]);
  removeTempData("mine");
  process.exit(0);
}
// The last resort: no summoned worker outlives the playground, however it
// exits.
process.on("exit", () => summoning.killAll());
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
