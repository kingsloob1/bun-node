/**
 * Demand — how much work a queue has for a worker right now, from one read.
 *
 * ```bash
 * bun 02-queues/demand.ts
 * EXAMPLE_DRIVER=postgres EXAMPLE_POSTGRES_URL=postgres://user:pass@localhost/jobs \
 *   bun 02-queues/demand.ts
 * ```
 *
 * `queue.getDemand()` is what a health check or a scaler of your own asks:
 * is there work, and is anything alive to do it? Every figure below is
 * predicted from what the example set up, then compared.
 *
 * The points that are easy to get wrong:
 *
 * - **`demand` is what a worker could claim now**: `waiting`, plus `dueNow`
 *   (delayed or retrying jobs whose time has come), plus `stalled`.
 *   `outstanding` adds the active jobs still held, counting a stalled job
 *   once although it is in both `stalled` and `active`.
 * - **Due jobs are counted where they stand.** With no worker running,
 *   nothing promotes a delayed job, and the read does not either: it writes
 *   nothing to a job. (Counting `workers` does prune expired worker records,
 *   as `listWorkers()` does.)
 * - **An active job is not stalled while its lock holds**, even after its
 *   worker is gone. It becomes `stalled` — what the stalled sweep would
 *   recover — once the lock lapses.
 * - **A paused queue demands nothing** but still reports its backlog.
 * - **`cap` bounds each count.** `capped` says a count went past it, and then
 *   `demand` and `outstanding` are lower bounds that can exceed the cap. A
 *   count exactly at the cap is not capped.
 * - **A driver of your own without `countDemand`** gets a fallback that is
 *   right as a trigger and approximate as a count, and says so with
 *   `exact: false`.
 */
import type { JobsDriver, QueueDemand } from "@kingsleyweb/bun-jobs";
import { BunQueue, BunQueueWorker, createDriver } from "@kingsleyweb/bun-jobs";
import { readDemand } from "@kingsleyweb/bun-jobs/lib/drivers";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Demand");

const driver = createDriver(exampleDriver());
await driver.connect();
const namespace = exampleNamespace("demand");

/** A demand snapshot without `at`, the instant it was read, for comparing. */
function figures(demand: QueueDemand): Omit<QueueDemand, "at"> {
  const { at: _at, ...rest } = demand;
  return rest;
}

/* ------------------------------------------------------------------ */
step("An empty queue: nothing to do, and nothing to do it");

const backlog = new BunQueue("demand-backlog", { namespace, driver });
checkEqual("an empty queue", figures(await backlog.getDemand()), {
  paused: false,
  waiting: 0,
  dueNow: 0,
  stalled: 0,
  active: 0,
  workers: 0,
  nextDueAt: null,
  demand: 0,
  outstanding: 0,
  capped: false,
  exact: true,
});

/* ------------------------------------------------------------------ */
step("A backlog: waiting jobs, delayed jobs come due, and later ones");

for (const n of [1, 2, 3]) {
  await backlog.add("send", { n });
}
const due = [
  await backlog.add("reminder", { n: 1 }, { delay: 200 }),
  await backlog.add("reminder", { n: 2 }, { delay: 250 }),
];
const later = [
  await backlog.add("digest", { n: 1 }, { delay: 60 * 60_000 }),
  await backlog.add("digest", { n: 2 }, { delay: 2 * 60 * 60_000 }),
];
/** The earliest `runAt` still in the future: the first of the later jobs. */
const nextDueAt = Math.min(...later.map((job) => job.runAt));
// No worker runs on this queue, so nothing will promote the due jobs; wait
// until both are past their time.
await Bun.sleep(Math.max(...due.map((job) => job.runAt)) - Date.now() + 50);

const withBacklog = await backlog.getDemand();
show("getDemand()", withBacklog);
checkEqual(
  "3 waiting + 2 due, and the next job due in an hour; no worker, nothing active",
  figures(withBacklog),
  {
    paused: false,
    waiting: 3,
    dueNow: 2,
    stalled: 0,
    active: 0,
    workers: 0,
    nextDueAt,
    demand: 5,
    outstanding: 5,
    capped: false,
    exact: true,
  },
);
checkEqual(
  "the due jobs are counted where they stand: still delayed, not promoted",
  await Promise.all(
    due.map(async (job) => (await backlog.getJob(job.id))?.state),
  ),
  ["delayed", "delayed"],
);

/* ------------------------------------------------------------------ */
step("Paused: no demand, but the backlog is still reported");

await backlog.pause();
const whilePaused = await backlog.getDemand();
checkEqual(
  "paused: demand and outstanding 0; waiting and dueNow as before",
  [
    whilePaused.paused,
    whilePaused.demand,
    whilePaused.outstanding,
    whilePaused.waiting,
    whilePaused.dueNow,
  ],
  [true, 0, 0, 3, 2],
);
await backlog.resume();

/* ------------------------------------------------------------------ */
step("cap: each count bounded; capped says one went past it");

const capAt2 = await backlog.getDemand({ cap: 2 });
checkEqual(
  "cap 2: waiting reads 2 and capped is set; demand, a sum, exceeds the cap; nextDueAt is never capped",
  [
    capAt2.waiting,
    capAt2.dueNow,
    capAt2.capped,
    capAt2.demand,
    capAt2.outstanding,
    capAt2.nextDueAt,
  ],
  [2, 2, true, 4, 4, nextDueAt],
);
const capAt3 = await backlog.getDemand({ cap: 3 });
checkEqual(
  "cap 3: three waiting is exactly the cap, which is not capped",
  [capAt3.waiting, capAt3.capped, capAt3.demand],
  [3, false, 5],
);
for (const cap of [0, 1.5]) {
  await checkRejects(
    `cap ${cap} is refused: a positive integer`,
    () => backlog.getDemand({ cap }),
    { name: "ConfigError", message: /positive integer/ },
  );
}

/* ------------------------------------------------------------------ */
step("Stalled: active with no one holding it, once its lock lapses");

/** Long enough that a read made just after the worker goes is inside it. */
const LOCK = 2_000;
const held = new BunQueue("demand-held", { namespace, driver });
const job = await held.add("import", { rows: 10 });
const worker = new BunQueueWorker(
  "demand-held",
  // Never finishes: the worker is closed around it.
  () => new Promise<never>(() => {}),
  {
    namespace,
    driver,
    lockDuration: LOCK,
    heartbeatInterval: 250,
    pollInterval: 25,
  },
);
void worker.run();
await waitFor(
  "the worker to take the job",
  async () => (await held.getJob(job.id))?.state === "active",
);
checkEqual(
  "held by a live worker: active, not stalled; nothing to claim, one outstanding",
  (({ workers, active, stalled, demand, outstanding }) => ({
    workers,
    active,
    stalled,
    demand,
    outstanding,
  }))(await held.getDemand()),
  { workers: 1, active: 1, stalled: 0, demand: 0, outstanding: 1 },
);

// Forced: the job is abandoned where it is, active, still locked. The
// worker's record goes with it.
await worker.close({ force: true });
const closedAt = Date.now();
const justClosed = await held.getDemand();
checkEqual(
  "its worker gone, the lock not yet lapsed: no worker, still active, still not stalled",
  [
    justClosed.workers,
    justClosed.active,
    justClosed.stalled,
    justClosed.demand,
    Date.now() - closedAt < LOCK,
  ],
  [0, 1, 0, 0, true],
);
await Bun.sleep(LOCK + 500);
const lapsed = await held.getDemand();
show("once the lock lapsed", lapsed);
checkEqual(
  "once the lock lapses it is stalled: demand 1, and outstanding still 1 (counted once)",
  [
    lapsed.workers,
    lapsed.active,
    lapsed.stalled,
    lapsed.demand,
    lapsed.outstanding,
  ],
  [0, 1, 1, 1, 1],
);
checkEqual(
  "and the read recovered nothing: the job is still active",
  (await held.getJob(job.id))?.state,
  "active",
);

/* ------------------------------------------------------------------ */
step("A driver without countDemand: a fallback, and exact: false");

// `readDemand` is the read `getDemand` makes, done against a driver directly.
// Every driver in this package implements `countDemand`; this one hides it,
// the way a driver of your own might not have one.
const withoutCountDemand = new Proxy(driver, {
  get(target, property) {
    if (property === "countDemand") {
      return undefined;
    }
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as JobsDriver;

checkEqual(
  "the native read and getDemand() agree",
  figures(await readDemand(driver, backlog.ref)),
  figures(await backlog.getDemand()),
);
checkEqual(
  "the fallback on the backlog: dueNow is 1 (something is due), nextDueAt unknown while it is; exact false",
  (({ waiting, dueNow, nextDueAt, demand, exact }) => ({
    waiting,
    dueNow,
    nextDueAt,
    demand,
    exact,
  }))(await readDemand(withoutCountDemand, backlog.ref)),
  { waiting: 3, dueNow: 1, nextDueAt: null, demand: 4, exact: false },
);
checkEqual(
  "the fallback on the abandoned job: every active job is stalled when no worker is live",
  (({ active, stalled, demand, exact }) => ({
    active,
    stalled,
    demand,
    exact,
  }))(await readDemand(withoutCountDemand, held.ref)),
  { active: 1, stalled: 1, demand: 1, exact: false },
);

/* ------------------------------------------------------------------ */
step("Clean up");

await backlog.close();
await held.close();
await driver.purge(namespace);
await driver.close();
summary();
