/**
 * One summoned unit for several queues: the summon arguments that name them,
 * and `runSummoned(workers)` running one worker per queue as one unit — run
 * for real, in a child process started with a summoner's arguments.
 *
 * ```bash
 * bun 02-queues/summoned-unit.ts
 * ```
 *
 * ```ts
 * // argv: … --bun-jobs-summon-group=media
 * //         --bun-jobs-summon-queue=renders --bun-jobs-summon-queue=thumbs
 * const summon = summonedFromArgs(); // queues: ["renders", "thumbs"], group: "media"
 * const workers = summon!.queues!.map((queue) =>
 *   jobs.worker(queue, processors[queue], { summon }));
 * await runSummoned(workers, { idleFor: 30_000 }); // exits the process
 * ```
 *
 * Each child is `02-queues/helpers/summoned-unit-entry.ts`, started with
 * arguments built here by hand, the way a summoner would pass them. **No
 * summoner in this package passes several queues yet**: a controller summons
 * for its one queue, and this tour asserts exactly what it sends today. The
 * child logs each decision as a JSON line, the last one carrying the
 * `SummonedExit`, and this tour reads that, the exit code and the backend.
 * The memory driver lives inside one process, so on memory the two share a
 * temporary SQLite file instead.
 *
 * The points that are easy to get wrong:
 *
 * - **One `--bun-jobs-summon-queue=` per queue**, in order, repeats dropped:
 *   `queues` lists them and `queue` is the first. With one queue the
 *   arguments are what they always were, and a controller's request carries
 *   `queues: [queue]`, with no `group` and no `demands`.
 * - **Every queue the arguments name needs a worker.** One without is a
 *   `ConfigError` before anything runs, and there is no way to allow it. So
 *   are an empty set, two workers on one queue, workers from different
 *   attempts and a worker already running.
 * - **Idle and parked are joint.** The unit runs on while any queue has work,
 *   and while any worker is not parked; it exits once all are.
 * - **A stop while a worker is still connecting** forces that one, which has
 *   claimed nothing, and closes the ready ones by the usual rule, so a job
 *   they hold still finishes.
 * - **`SummonedExit.queues`** holds each queue's totals, for a set of
 *   workers only: `runSummoned(worker)` answers as it always has.
 * - **Each worker marks its own claim**, under its own queue, with the
 *   unit's reason.
 */
import type {
  DriverConfig,
  SummonedArgs,
  SummonRequest,
} from "@kingsleyweb/bun-jobs";
import type { Subprocess } from "bun";
import { join } from "node:path";
import process from "node:process";
import {
  BunJobs,
  defineSummoner,
  RESERVED_STATE_PREFIX,
  runSummoned,
  SUMMON_ARGS,
  summonedFromArgs,
} from "@kingsleyweb/bun-jobs";
import {
  crossProcessDriver,
  exampleNamespace,
  tempDir,
} from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("A summoned unit for several queues");

/** A generous ceiling for a child's start-up and anything a slow server stretches. */
const WAIT = { timeout: 30_000, interval: 20 };
/** How long a child may take to exit once it should, before the tour gives up on it. */
const EXIT_TIMEOUT = 60_000;
/** The children's `idleFor`, short so the tour does not wait on the default 30 s. */
const IDLE_FOR = 300;

const config: DriverConfig = crossProcessDriver();
const ENTRY = new URL("./helpers/summoned-unit-entry.ts", import.meta.url)
  .pathname;

/**
 * Every child this tour started. One still alive when it exits — a check
 * failed mid-step, say — is killed, so it cannot outlive the tour.
 */
const children = new Set<Subprocess>();
process.on("exit", () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

/** One line the child printed. */
interface Decision {
  /** The log line's message, or one of the entry's own: `workers`, `ready`, `refused`. */
  message: string;
  /** Its fields. */
  fields: Record<string, unknown>;
}

/** The summon arguments for attempt `id` on `queues`, as a summoner writes them. */
function summonArgs(
  id: string,
  namespace: string,
  queues: readonly string[],
  extra: string[] = [],
): string[] {
  return [
    `${SUMMON_ARGS.id}=${id}`,
    `${SUMMON_ARGS.kind}=example`,
    `${SUMMON_ARGS.namespace}=${namespace}`,
    `${SUMMON_ARGS.group}=media`,
    ...queues.map((queue) => `${SUMMON_ARGS.queue}=${queue}`),
    ...extra,
  ];
}

/**
 * Starts the entry file with `args`, as a platform would, and collects what
 * it prints. `env` adds the entry's own settings (`SUMMONED_WORKERS`,
 * `SUMMONED_HELD`).
 */
function startUnit(
  args: string[],
  env: Record<string, string> = {},
  idleFor = IDLE_FOR,
) {
  const child = Bun.spawn({
    cmd: [process.execPath, ENTRY, ...args],
    env: {
      ...process.env,
      SUMMONED_DRIVER: JSON.stringify(config),
      SUMMONED_IDLE_FOR: String(idleFor),
      ...env,
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  children.add(child);
  const decisions: Decision[] = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line.startsWith("{")) {
          decisions.push(JSON.parse(line) as Decision);
        }
        end = buffer.indexOf("\n");
      }
    }
  })();
  /** The first line with `message`, and where it came. */
  const find = (message: string) => {
    const index = decisions.findIndex((one) => one.message === message);
    return index < 0 ? undefined : { index, ...decisions[index]! };
  };
  return {
    child,
    decisions,
    find,
    /** The exit code, once the child has exited and its output is read. */
    exited: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const code = await Promise.race([
        child.exited,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(resolve, EXIT_TIMEOUT, undefined);
        }),
      ]);
      clearTimeout(timer);
      if (code === undefined) {
        child.kill("SIGKILL");
        throw new Error(
          `the unit did not exit within ${EXIT_TIMEOUT} ms; it printed:\n${decisions.map((one) => JSON.stringify(one)).join("\n")}`,
        );
      }
      await reading;
      return code;
    },
    /** Each queue's worker id, as the child printed them before running. */
    ids: () => find("workers")?.fields.ids as Record<string, string>,
    /** The closing decision: how it chose to close, and when. */
    closing: () =>
      decisions
        .map((one, index) => ({ index, ...one }))
        .find((one) => one.message.startsWith("Summoned worker closing")),
    /** The `SummonedExit` it logged on the way out, if it got that far. */
    stopped: () => find("Summoned worker stopped")?.fields,
  };
}

/** What a claim entry says about one worker that held it. */
interface Holder {
  /** The worker's id. */
  worker: string;
  /** How it left, once it has. */
  exit?: { reason: string; code: number; forced?: boolean };
}

/**
 * The summon claims under `queue`, read raw from the backend: the reserved
 * queue-state entries a summoned worker claims its attempt in, and marks its
 * exit on. Their shape is internal — read here only to show the marks. Each
 * step has a namespace of its own, so every entry found is this step's.
 */
async function claimsOf(jobs: BunJobs, queue: string) {
  const { driver, ref } = jobs.queue(queue);
  const names = await driver.listQueueState!(ref, {
    prefix: `${RESERVED_STATE_PREFIX}summon-claim:`,
    limit: 10,
  });
  return await Promise.all(
    names.map(async (name) => {
      const entry = await driver.getQueueState!(ref, name);
      return (entry?.value as { holders: Holder[] }).holders.map((holder) => ({
        worker: holder.worker,
        reason: holder.exit?.reason,
        code: holder.exit?.code,
      }));
    }),
  );
}

/** Waits until a job's attempt is running on the unit: its processor reports progress `1`. */
async function running(jobs: BunJobs, queue: string, id: string) {
  await waitFor(
    `${queue}'s job to start`,
    async () => (await jobs.queue(queue).getJob(id))?.progress === 1,
    WAIT,
  );
}

/** Waits until `queue` has one worker record up, and answers it. */
async function recordOf(jobs: BunJobs, queue: string) {
  await waitFor(
    `${queue}'s worker to report`,
    async () => (await jobs.queue(queue).listWorkers()).length === 1,
    WAIT,
  );
  return (await jobs.queue(queue).listWorkers())[0]!;
}

/* ------------------------------------------------------------------ */
step("The arguments: one --bun-jobs-summon-queue= per queue, in order");

const several = summonedFromArgs([
  `${SUMMON_ARGS.id}=attempt-1`,
  `${SUMMON_ARGS.namespace}=studio`,
  `${SUMMON_ARGS.group}=media`,
  `${SUMMON_ARGS.queue}=renders`,
  `${SUMMON_ARGS.queue}=thumbs`,
  `${SUMMON_ARGS.queue}=renders`,
  `${SUMMON_ARGS.queue}=previews`,
]);
show("summonedFromArgs() read", several);
checkEqual(
  "queues in the order given, the repeat dropped, queue the first, and the group",
  [several?.queues, several?.queue, several?.group],
  [["renders", "thumbs", "previews"], "renders", "media"],
);
await checkRejects(
  "a group is a key segment, like a queue name: anything else is refused",
  () =>
    summonedFromArgs([
      `${SUMMON_ARGS.id}=attempt-1`,
      `${SUMMON_ARGS.group}=media team`,
    ]),
  {
    name: "ConfigError",
    code: "CONFIG",
    message: /^--bun-jobs-summon-group may only contain letters, digits/,
  },
);

// One queue: the arguments a controller writes, which carry no group.
const one = summonedFromArgs([
  `${SUMMON_ARGS.id}=attempt-2`,
  `${SUMMON_ARGS.kind}=example`,
  `${SUMMON_ARGS.mode}=exit-on-idle`,
  `${SUMMON_ARGS.namespace}=studio`,
  `${SUMMON_ARGS.queue}=renders`,
  `${SUMMON_ARGS.maxLifetimeMs}=900000`,
  `${SUMMON_ARGS.graceMs}=10000`,
]);
const { deadlineAt, ...rest } = one ?? ({} as SummonedArgs);
checkEqual(
  "one queue reads as it always did — queue, no group — with queues: [queue] beside it",
  rest,
  {
    id: "attempt-2",
    kind: "example",
    mode: "exit-on-idle",
    maxLifetimeMs: 900_000,
    namespace: "studio",
    queue: "renders",
    queues: ["renders"],
    graceMs: 10_000,
  },
);
check(
  "and the deadline is computed here, from the lifetime",
  typeof deadlineAt === "number",
  deadlineAt,
);

/* ------------------------------------------------------------------ */
step("What a controller sends today: one queue, queues: [queue]");

/** Requests the recording summoner was handed, in order. */
const recorded: SummonRequest[] = [];
const recordingJobs = new BunJobs({
  namespace: exampleNamespace("summoned-unit-requests"),
  driver: config,
  summon: [
    {
      queues: ["renders", "thumbs"],
      summoner: defineSummoner({
        kind: "recorder",
        invoke: async (request: SummonRequest) => {
          recorded.push(request);
          return { status: "started", handles: [] };
        },
      }),
      triggers: { onAdd: false, events: false, poll: false },
    },
  ],
});
for (const queue of ["renders", "thumbs"]) {
  await recordingJobs.queue(queue).add("render", {});
  await recordingJobs.summonController(queue).check();
}
show(
  "the requests' queues and arguments",
  recorded.map((request) => ({ queues: request.queues, argv: request.argv })),
);
checkEqual(
  "a summon group still summons per queue: each request names its own queue in queues, with no group and no demands",
  recorded.map((request) => ({
    queue: request.queue,
    queues: request.queues,
    group: "group" in request,
    demands: "demands" in request,
    demand: typeof request.demand?.demand as string,
  })),
  ["renders", "thumbs"].map((queue) => ({
    queue,
    queues: [queue],
    group: false,
    demands: false,
    demand: "number",
  })),
);
checkEqual(
  "its arguments are the one-queue form: one queue argument, no group argument",
  recorded.map((request) => request.argv.map((arg) => arg.split("=")[0])),
  recorded.map(() => [
    SUMMON_ARGS.id,
    SUMMON_ARGS.kind,
    SUMMON_ARGS.mode,
    SUMMON_ARGS.namespace,
    SUMMON_ARGS.queue,
    SUMMON_ARGS.maxLifetimeMs,
    SUMMON_ARGS.graceMs,
  ]),
);
checkEqual(
  "and a process started with them reads its one queue back",
  recorded.map((request) => {
    const read = summonedFromArgs(request.argv);
    return [read?.id, read?.queues, read?.group];
  }),
  recorded.map((request) => [request.id, [request.queue], undefined]),
);
// The 8 KiB limit on a summon's arguments is not shown: with one queue the
// names allowed (a namespace and a queue name of at most 200 characters, a
// kind of at most 24) come nowhere near it, so nothing reaches it today.
await recordingJobs.purge();
await recordingJobs.close();

/* ------------------------------------------------------------------ */
step("Refused before anything runs: the set of workers itself");

const refusalJobs = new BunJobs({
  namespace: exampleNamespace("summoned-unit-refusals"),
  driver: config,
});
const waiting = await refusalJobs.queue("renders").add("render", {});
/** A worker on `queue`, not yet running. */
const workerOn = (queue: string, summonId?: string) =>
  refusalJobs.worker(queue, async () => "done", {
    pollInterval: 20,
    ...(summonId === undefined ? {} : { summon: { id: summonId } }),
  });
/**
 * Options under which a refusal that regressed would show as a failed check
 * rather than end the tour: no process exit, no signal handlers.
 */
const SAFE = {
  exit: false,
  signals: false,
  idleFor: 100,
  idleCheckInterval: 20,
} as const;

await checkRejects("an empty set", () => runSummoned([], SAFE), {
  name: "ConfigError",
  code: "CONFIG",
  message: /^runSummoned needs a worker: it was given an empty set$/,
});
const twins = [workerOn("renders"), workerOn("renders")];
await checkRejects("two workers on one queue", () => runSummoned(twins, SAFE), {
  name: "ConfigError",
  code: "CONFIG",
  message:
    /^runSummoned runs one worker per queue, and was given two for queue renders$/,
});
const strangers = [
  workerOn("renders", "attempt-a"),
  workerOn("thumbs", "attempt-b"),
];
await checkRejects(
  "workers given summon options from different attempts",
  () => runSummoned(strangers, SAFE),
  {
    name: "ConfigError",
    code: "CONFIG",
    message:
      /^runSummoned runs one summoned unit: its workers were given summon options from different attempts$/,
  },
);
const started = workerOn("thumbs");
void started.run();
const notYet = workerOn("renders");
await checkRejects(
  "a worker that is already running",
  () => runSummoned([notYet, started], SAFE),
  {
    name: "ConfigError",
    code: "CONFIG",
    message: /^runSummoned starts the worker itself: do not call run\(\) first/,
  },
);
checkEqual(
  "none of the refused workers was started, and the job waits",
  [
    [...twins, ...strangers, notYet].some((worker) => worker.isRunning),
    (await refusalJobs.queue("renders").getJob(waiting.id))?.state,
  ],
  [false, "waiting"],
);
await refusalJobs.purge();
await refusalJobs.close();

/* ------------------------------------------------------------------ */
step("Refused before anything runs: a queue the arguments name with no worker");

const missingNs = exampleNamespace("summoned-unit-missing");
const missingJobs = new BunJobs({ namespace: missingNs, driver: config });
const stranded = await missingJobs.queue("renders").add("render", {});
// The arguments name renders and thumbs; the entry builds renders' only.
const missing = startUnit(
  summonArgs("attempt-missing", missingNs, ["renders", "thumbs"]),
  { SUMMONED_WORKERS: "renders" },
);
const missingCode = await missing.exited();
show("it was refused with", missing.find("refused")?.fields);
checkEqual(
  "a ConfigError naming the queue with no worker; the entry exits 1 on it",
  [
    missingCode,
    missing.find("refused")?.fields.name,
    missing.find("refused")?.fields.code,
  ],
  [1, "ConfigError", "CONFIG"],
);
check(
  "…saying what to do about it",
  /^runSummoned: the summon arguments name a queue with no worker \(thumbs\): build one worker for each queue in summonedFromArgs\(\)\.queues/.test(
    String(missing.find("refused")?.fields.message),
  ),
  missing.find("refused")?.fields.message,
);
checkEqual(
  "nothing ran: no worker ready, no claim, no worker record, the job still waiting",
  [
    missing.find("ready"),
    await claimsOf(missingJobs, "renders"),
    (await missingJobs.queue("renders").listWorkers()).length,
    (await missingJobs.queue("renders").getJob(stranded.id))?.state,
  ],
  [undefined, [], 0, "waiting"],
);
await missingJobs.purge();
await missingJobs.close();

/* ------------------------------------------------------------------ */
step("Joint idle: the unit runs on while one queue still has work");

const idleNs = exampleNamespace("summoned-unit-idle");
const idleJobs = new BunJobs({ namespace: idleNs, driver: config });
/** The quick jobs added to each queue. */
const QUICK_JOBS = { renders: 3, thumbs: 2 } as const;
const quickIds: Record<string, string[]> = {};
for (const [queue, count] of Object.entries(QUICK_JOBS)) {
  quickIds[queue] = [];
  for (let index = 0; index < count; index++) {
    quickIds[queue].push((await idleJobs.queue(queue).add("quick", {})).id);
  }
}
// previews' one job waits for a gate this tour opens.
const gate = join(tempDir("summoned-unit"), "open");
const gated = await idleJobs.queue("previews").add("gated", { gate });
const unit = startUnit(
  summonArgs("attempt-unit", idleNs, ["renders", "thumbs", "previews"]),
);
/** Whether every job in `ids` on `queue` has completed. */
const allDone = async (queue: string, ids: string[]) =>
  (
    await Promise.all(
      ids.map(async (id) => await idleJobs.queue(queue).getJob(id)),
    )
  ).every((job) => job?.state === "completed");
await waitFor(
  "renders' and thumbs' jobs to complete",
  async () =>
    (await allDone("renders", quickIds.renders!)) &&
    (await allDone("thumbs", quickIds.thumbs!)),
  WAIT,
);
await running(idleJobs, "previews", gated.id);
const records = await Promise.all(
  ["renders", "thumbs", "previews"].map(
    async (queue) => (await recordOf(idleJobs, queue)).summon,
  ),
);
checkEqual(
  "each queue's worker record names the one attempt and its group",
  records.map((summon) => [summon?.id, summon?.group]),
  [
    ["attempt-unit", "media"],
    ["attempt-unit", "media"],
    ["attempt-unit", "media"],
  ],
);
// renders and thumbs are idle; previews is not. Five idle periods later the
// unit is still up — had idleness been per queue, two of its workers would
// have stopped by now.
await Bun.sleep(5 * IDLE_FOR);
checkEqual(
  "still running, with no close decided, while previews' job is held",
  [unit.child.exitCode, unit.closing()],
  [null, undefined],
);
const openedAt = unit.decisions.length;
await Bun.write(gate, "open");
const unitCode = await unit.exited();
show("it exited with", unit.stopped());
checkEqual(
  "once every queue is idle: exit 0, reason idle",
  [unitCode, unit.stopped()?.reason, unit.stopped()?.code],
  [0, "idle", 0],
);
check(
  "…decided only after the gate opened",
  (unit.closing()?.index ?? -1) >= openedAt,
  { closing: unit.closing(), openedAt },
);
checkEqual(
  "queues holds each queue's totals, and completed their sum",
  [unit.stopped()?.queues, unit.stopped()?.completed],
  [
    {
      renders: { completed: QUICK_JOBS.renders, failed: 0 },
      thumbs: { completed: QUICK_JOBS.thumbs, failed: 0 },
      previews: { completed: 1, failed: 0 },
    },
    QUICK_JOBS.renders + QUICK_JOBS.thumbs + 1,
  ],
);
const ids = unit.ids();
const attribution = [];
for (const [queue, jobIds] of Object.entries({
  ...quickIds,
  previews: [gated.id],
})) {
  for (const id of jobIds) {
    const job = await idleJobs.queue(queue).getJob(id);
    attribution.push({
      queue,
      worker: job?.processedBy?.id === ids[queue],
      pid: job?.processedBy?.pid,
      processor: (job?.returnValue as { processor?: string })?.processor,
    });
  }
}
checkEqual(
  "every job was claimed by its own queue's worker, in the unit's process, and ran its queue's processor",
  attribution,
  attribution.map(({ queue }) => ({
    queue,
    worker: true,
    pid: unit.child.pid,
    processor: queue,
  })),
);
checkEqual(
  "each worker marked its own claim, under its own queue, with the unit's reason",
  await Promise.all(
    ["renders", "thumbs", "previews"].map(
      async (queue) => await claimsOf(idleJobs, queue),
    ),
  ),
  ["renders", "thumbs", "previews"].map((queue) => [
    [{ worker: ids[queue], reason: "idle", code: 0 }],
  ]),
);
await idleJobs.purge();
await idleJobs.close();

/* ------------------------------------------------------------------ */
step("One worker, or a set of one: only the set answers with queues");

const soloJobs = new BunJobs({
  namespace: exampleNamespace("summoned-unit-solo"),
  driver: config,
});
/** Runs one quick job through a fresh worker, alone or as a set of one. */
async function runSolo(asSet: boolean) {
  await soloJobs.queue("solo").add("quick", {});
  const worker = soloJobs.worker("solo", async () => "done", {
    pollInterval: 20,
  });
  // "in-invocation" resolves with the result instead of exiting.
  const options = {
    mode: "in-invocation",
    idleFor: IDLE_FOR,
    idleCheckInterval: 50,
  } as const;
  return asSet
    ? await runSummoned([worker], options)
    : await runSummoned(worker, options);
}
const alone = await runSolo(false);
const asSet = await runSolo(true);
show("runSummoned(worker), then runSummoned([worker])", [alone, asSet]);
checkEqual(
  "runSummoned(worker) has no queues; the set form adds them",
  [alone.completed, "queues" in alone, asSet.completed, asSet.queues],
  [1, false, 1, { solo: { completed: 1, failed: 0 } }],
);
await soloJobs.purge();
await soloJobs.close();

/* ------------------------------------------------------------------ */
step("Joint park: one parked worker among running ones runs on");

const parkNs = exampleNamespace("summoned-unit-park");
const parkJobs = new BunJobs({ namespace: parkNs, driver: config });
const parkGate = join(tempDir("summoned-unit-park"), "open");
const busy = await parkJobs.queue("thumbs").add("gated", { gate: parkGate });
const parkIdleFor = 800;
const parkUnit = startUnit(
  summonArgs("attempt-park", parkNs, ["renders", "thumbs"]),
  {},
  parkIdleFor,
);
await running(parkJobs, "thumbs", busy.id);
const rendersRecord = await recordOf(parkJobs, "renders");
await parkJobs.workers.controller("renders").stop({ id: rendersRecord.id });
await waitFor(
  "renders' worker to report itself stopped",
  async () =>
    (await parkJobs.queue("renders").listWorkers())[0]?.state === "stopped",
  WAIT,
);
// Work for renders arrives after it was parked: it waits, and keeps the
// unit from reading idle.
const parkedJob = await parkJobs.queue("renders").add("quick", {});
await Bun.sleep(2 * parkIdleFor);
checkEqual(
  "renders parked, thumbs working: still running, with no close decided, and renders' job left waiting",
  [
    parkUnit.child.exitCode,
    parkUnit.closing(),
    (await parkJobs.queue("renders").getJob(parkedJob.id))?.state,
  ],
  [null, undefined, "waiting"],
);
await Bun.write(parkGate, "open");
await waitFor(
  "thumbs' job to complete",
  async () =>
    (await parkJobs.queue("thumbs").getJob(busy.id))?.state === "completed",
  WAIT,
);
const parkedAt = parkUnit.decisions.length;
const thumbsRecord = await recordOf(parkJobs, "thumbs");
await parkJobs.workers.controller("thumbs").stop({ id: thumbsRecord.id });
const parkCode = await parkUnit.exited();
show("it exited with", parkUnit.stopped());
checkEqual(
  'once every worker is parked: exit 0, reason "parked", renders\' job still waiting',
  [
    parkCode,
    parkUnit.stopped()?.reason,
    parkUnit.stopped()?.queues,
    (await parkJobs.queue("renders").getJob(parkedJob.id))?.state,
  ],
  [
    0,
    "parked",
    {
      renders: { completed: 0, failed: 0 },
      thumbs: { completed: 1, failed: 0 },
    },
    "waiting",
  ],
);
check(
  "…decided only after the second park",
  (parkUnit.closing()?.index ?? -1) >= parkedAt,
  { closing: parkUnit.closing(), parkedAt },
);
const parkIds = parkUnit.ids();
checkEqual(
  "both claims are marked parked",
  [await claimsOf(parkJobs, "renders"), await claimsOf(parkJobs, "thumbs")],
  ["renders", "thumbs"].map((queue) => [
    [{ worker: parkIds[queue], reason: "parked", code: 0 }],
  ]),
);
await parkJobs.purge();
await parkJobs.close();

/* ------------------------------------------------------------------ */
step("SIGTERM while one worker is still connecting: that one is forced");

const stopNs = exampleNamespace("summoned-unit-stop");
const stopJobs = new BunJobs({ namespace: stopNs, driver: config });
const inFlight = await stopJobs.queue("thumbs").add("slow", { ms: 1_500 });
// renders' driver never finishes connecting; a grace of 30 s leaves the
// ready worker plenty to finish its job in.
const stopUnit = startUnit(
  summonArgs(
    "attempt-stop",
    stopNs,
    ["renders", "thumbs"],
    [`${SUMMON_ARGS.graceMs}=30000`],
  ),
  { SUMMONED_HELD: "renders" },
  60_000,
);
await running(stopJobs, "thumbs", inFlight.id);
check(
  "thumbs is up and working; renders is still starting",
  stopUnit.decisions.some(
    (one) => one.message === "ready" && one.fields.queue === "thumbs",
  ) &&
    !stopUnit.decisions.some(
      (one) => one.message === "ready" && one.fields.queue === "renders",
    ),
  stopUnit.decisions,
);
stopUnit.child.kill("SIGTERM");
const stopCode = await stopUnit.exited();
const closing = stopUnit.closing();
show("how it closed", closing);
checkEqual(
  "one decision: graceful, with the worker still starting named, and forced",
  [
    closing?.message,
    closing?.fields.reason,
    closing?.fields.signal,
    closing?.fields.force,
    closing?.fields.queues,
    closing?.fields.starting,
  ],
  [
    "Summoned worker closing gracefully",
    "signal",
    "SIGTERM",
    false,
    ["renders", "thumbs"],
    ["renders"],
  ],
);
checkEqual(
  "exit 0 on the signal; thumbs' job finished rather than being abandoned",
  [
    stopCode,
    stopUnit.stopped()?.reason,
    stopUnit.stopped()?.signal,
    stopUnit.stopped()?.queues,
    (await stopJobs.queue("thumbs").getJob(inFlight.id))?.state,
  ],
  [
    0,
    "signal",
    "SIGTERM",
    {
      renders: { completed: 0, failed: 0 },
      thumbs: { completed: 1, failed: 0 },
    },
    "completed",
  ],
);
checkEqual(
  "renders never got ready and claimed nothing; thumbs' claim is marked with the signal",
  [
    stopUnit.decisions.some(
      (one) => one.message === "ready" && one.fields.queue === "renders",
    ),
    await claimsOf(stopJobs, "renders"),
    await claimsOf(stopJobs, "thumbs"),
  ],
  [false, [], [[{ worker: stopUnit.ids().thumbs, reason: "signal", code: 0 }]]],
);
await stopJobs.purge();
await stopJobs.close();

summary();
