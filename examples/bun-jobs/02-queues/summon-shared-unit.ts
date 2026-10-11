/**
 * One summoned unit for several queues: a `SummonController` built with
 * `queues` and `group: { name, unit: "shared" }` summons one process that
 * runs a worker for every queue of the group.
 *
 * ```bash
 * bun 02-queues/summon-shared-unit.ts
 * ```
 *
 * ```ts
 * const controller = new SummonController({
 *   driver,
 *   namespace: "studio",
 *   queues: ["renders", "thumbs", "previews"],
 *   group: { name: "media", unit: "shared" },
 *   summoner,
 *   overrides: { renders: { jobsPerWorker: 10 } },
 * });
 * ```
 *
 * The unit it summons in the first step is a real child process, started
 * with the request's `argv`: `02-queues/helpers/summoned-unit-entry.ts`,
 * the entry file `summoned-unit.ts` runs, which builds one worker per queue
 * in `summonedFromArgs().queues` and runs them together with
 * `runSummoned(workers)`. Step 4 starts a real child too, from
 * `02-queues/helpers/partial-unit-entry.ts`, an entry that forgot a queue;
 * the other steps use summoners that start nothing. Every trigger is off,
 * so a check runs only when the tour calls `check()`. Summoning needs a backend another process can reach, so
 * on the memory driver this runs on a temporary SQLite file.
 *
 * **Today this is built by hand.** `BunJobs`' `summon` option and
 * `jobs.summonController()` refuse a shared unit with a `ConfigError`, and
 * the last-but-one step asserts that refusal as the current state.
 *
 * The points that are easy to get wrong:
 *
 * - **Demand is the most-starved queue's, never the sum.** Every unit adds a
 *   worker to every queue, so the count asked for is the largest of the
 *   queues' own wants. Each queue's `jobsPerWorker` and `maxWorkers` may
 *   differ, through `overrides`, which takes those two keys only.
 * - **The request names the whole unit**: `queues`, `group` and `demands`
 *   (each queue's reading), with `demand` the most-starved queue's. Its
 *   `argv` repeats `--bun-jobs-summon-queue=` once per queue and adds
 *   `--bun-jobs-summon-group=`. A one-queue request is unchanged
 *   (`summoned-unit.ts` shows it).
 * - **A unit missing a queue's worker is `registered` with detail
 *   `partial:<queues>`**: one failure, one `error` log naming the queues,
 *   and no `onSummonFailed`. The queue with no worker settles only once the
 *   attempt's `bootBudget` has passed, so that is when the failure counts.
 * - **Each `summon` event is published once on every member's channel.**
 * - **Both budgets apply**: the policy's `budget` and `group.budget`, the
 *   stricter per period. `status().budget` shows the limits the unit is held
 *   to; `status().group.budget` shows the group's own.
 * - **A scale-style unit is released only once every queue is idle**, and
 *   the release names every queue and the group.
 * - **`reset()` also closes a circuit that per-queue controllers of the
 *   group opened for the unit's provider kind**, and `reset({ budget: true })`
 *   clears the counts and every queue's share.
 */
import type {
  JobsDriver,
  SummonCheckResult,
  SummonControllerOptions,
  SummonEventPayload,
  SummonFailure,
  SummonGroupStatusDto,
  SummonReleaseRequest,
  SummonRequest,
} from "@kingsleyweb/bun-jobs";
import type { SummonCapabilities } from "@kingsleyweb/bun-jobs/provider";
import type { Subprocess } from "bun";
import process from "node:process";
import { BunHttpAdapter, createTestLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  BunQueue,
  createDriver,
  createJobsApi,
  defineSummoner,
  ProviderError,
  RESERVED_STATE_PREFIX,
  SUMMON_ARGS,
  SummonController,
} from "@kingsleyweb/bun-jobs";
import {
  COMPUTE_PROVIDER_API,
  defineComputeProvider,
  toStandardSchema,
} from "@kingsleyweb/bun-jobs/provider";
import { crossProcessDriver, exampleNamespace } from "../shared/backend";
import { withinOneHour } from "../shared/budget-window";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("One summoned unit for several queues");

/** A generous ceiling for a child's start-up and anything a slow server stretches. */
const WAIT = { timeout: 30_000, interval: 20 };
/** The unit's `idleFor`, short so the tour does not wait on the default 30 s. */
const IDLE_FOR = 300;
/** Every trigger off, no cooldown, a 1 ms backoff: every check is one the tour asked for. */
const ONE_SHOT = {
  triggers: { onAdd: false, events: false, poll: false },
  cooldown: 0,
  backoff: { initial: 1, max: 1 },
} as const;
/**
 * How much of the current UTC hour steps 5 to 8 need left: steps 5 and 8
 * spend a budget and read the hour's counts back. From the wait to the end
 * took under half a second on every backend; a minute leaves room for a
 * loaded machine.
 */
const HOUR_NEEDED = 60_000;

/** The group's queues, in the order its unit serves them. */
const MEDIA = ["renders", "thumbs", "previews"] as const;
/** The group, sharing one unit. */
const SHARED = { name: "media", unit: "shared" } as const;

const config = crossProcessDriver();
const driver: JobsDriver = createDriver(config);
await driver.connect();
const UNIT_ENTRY = new URL("./helpers/summoned-unit-entry.ts", import.meta.url)
  .pathname;
const PARTIAL_ENTRY = new URL(
  "./helpers/partial-unit-entry.ts",
  import.meta.url,
).pathname;

/** What the controllers log, collected rather than printed. */
const { logger, events: logged } = createTestLogger();

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

/** Every context and controller the tour built, closed (and purged) at the end. */
const contexts: BunJobs[] = [];
const controllers: SummonController[] = [];

/** A `BunJobs` on the tour's driver, in a namespace of its own. */
function context(base: string): BunJobs {
  const jobs = new BunJobs({
    namespace: exampleNamespace(base),
    driver,
    logger,
  });
  contexts.push(jobs);
  return jobs;
}

/** A controller the tour closes at the end. */
function controller(
  options: Omit<SummonControllerOptions, "driver" | "logger">,
): SummonController {
  const built = new SummonController({ driver, logger, ...options });
  controllers.push(built);
  return built;
}

/** A check's outcome, or `skipped <reason>`. */
const said = (result: SummonCheckResult): string =>
  result.action === "summoned"
    ? result.outcome
    : result.action === "skipped"
      ? `skipped ${result.reason}`
      : result.action;

/** One line a child printed. */
interface Decision {
  /** The log line's message, or the entry's own `workers`. */
  message: string;
  /** Its fields. */
  fields: Record<string, unknown>;
}

/** Starts `entry` with `argv`, as a platform would, and collects the JSON lines it prints. */
function spawnUnit(entry: string, argv: readonly string[], env = {}) {
  const child = Bun.spawn({
    cmd: [process.execPath, entry, ...argv],
    env: {
      ...process.env,
      SUMMONED_DRIVER: JSON.stringify(config),
      SUMMONED_IDLE_FOR: String(IDLE_FOR),
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
  /** The first line whose message starts with `prefix`. */
  const find = (prefix: string) =>
    decisions.find((one) => one.message.startsWith(prefix));
  return {
    child,
    find,
    /** Each queue's worker id, as the child printed them. */
    ids: () => (find("workers")?.fields.ids ?? {}) as Record<string, string>,
    /**
     * The exit code once the child has exited and its output is read. A
     * child still running after `WAIT.timeout` is killed and answers
     * `undefined`, failing the checks that read it rather than the tour.
     */
    exited: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const code = await Promise.race([
        child.exited,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(resolve, WAIT.timeout, undefined);
        }),
      ]);
      clearTimeout(timer);
      if (code === undefined) {
        child.kill("SIGKILL");
      }
      await reading;
      return code;
    },
  };
}

/** What a claim entry says about one worker that held it. */
interface Holder {
  /** The worker's id. */
  worker: string;
  /** How it left, once it has. */
  exit?: { reason: string; code: number };
}

/**
 * The summon claims under `queue`, read raw from the backend: the reserved
 * queue-state entries a summoned worker claims its attempt in, and marks its
 * exit on. Their shape is internal — read here only to show that each queue
 * has its own. Each step has a namespace of its own, so every entry found
 * is this step's.
 */
async function claimsOf(namespace: string, queue: string) {
  const ref = { ns: namespace, queue };
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

/** A summoner that records each request and says `started` for a unit that never comes. */
function recording(kind: string) {
  const calls: SummonRequest[] = [];
  return {
    calls,
    summoner: defineSummoner({
      kind,
      invoke: async (request: SummonRequest) => {
        calls.push(request);
        return { status: "started", handles: [] };
      },
    }),
  };
}

/* ------------------------------------------------------------------ */
step("1. One unit for three queues, run for real");

const unitJobs = context("summon-shared-unit");
const unitNs = unitJobs.namespace;
/** Each queue's backlog before the check. */
const BACKLOG = { renders: 3, thumbs: 2, previews: 1 } as const;

// Listeners in this process, as another process's would be: one per member
// queue and one for a queue outside the group, each subscribed to the
// queue's channel on the backend.
/** The `summon` events each queue's channel carried, by queue. */
const heard: Record<string, SummonEventPayload[]> = {};
const listeners = [...MEDIA, "emails"].map((queue) => {
  heard[queue] = [];
  const listener = new BunQueue(queue, {
    namespace: unitNs,
    driver,
    logger,
    subscribe: true,
  });
  listener.on("summon", (event) => heard[queue]!.push(event));
  return listener;
});
await Promise.all(listeners.map(async (listener) => await listener.connect()));

const added: Record<string, string[]> = {};
for (const queue of MEDIA) {
  added[queue] = [];
  for (let index = 0; index < BACKLOG[queue]; index++) {
    added[queue].push((await unitJobs.queue(queue).add("quick", {})).id);
  }
}

/** The requests the spawning summoner was handed, and the unit it started for each. */
const unitCalls: SummonRequest[] = [];
const units: ReturnType<typeof spawnUnit>[] = [];
const unitController = controller({
  namespace: unitNs,
  queues: [...MEDIA],
  group: SHARED,
  ...ONE_SHOT,
  // A summoner that starts the unit on this machine: the request's `argv`
  // carries the attempt, the namespace, the group and every queue; the
  // backend travels in the environment, as a platform's task definition
  // would carry it.
  summoner: defineSummoner({
    kind: "example-spawn",
    invoke: async (request: SummonRequest) => {
      unitCalls.push(request);
      const unit = spawnUnit(UNIT_ENTRY, request.argv);
      units.push(unit);
      return { status: "started", handles: [`pid:${unit.child.pid}`] };
    },
  }),
});
/** What the controller emitted, in order. */
const unitEvents: SummonEventPayload[] = [];
unitController.on("summon", (event) => unitEvents.push(event));

const first = await unitController.check();
show("the first check", said(first));
const request = unitCalls[0];
show("the request", {
  queue: request?.queue,
  queues: request?.queues,
  group: request?.group,
  count: request?.count,
  argv: request?.argv,
});
checkEqual(
  "one attempt for the three queues: the request names them in order, the group, and one unit",
  [
    said(first),
    unitCalls.length,
    request?.queue,
    request?.queues,
    request?.group,
    request?.count,
  ],
  ["started", 1, "renders", [...MEDIA], SHARED.name, 1],
);
checkEqual(
  "its argv repeats the queue argument once per queue, in order, and names the group",
  request?.argv.filter(
    (arg) =>
      arg.startsWith(`${SUMMON_ARGS.queue}=`) ||
      arg.startsWith(`${SUMMON_ARGS.group}=`),
  ),
  [
    `${SUMMON_ARGS.group}=${SHARED.name}`,
    ...MEDIA.map((queue) => `${SUMMON_ARGS.queue}=${queue}`),
  ],
);
checkEqual(
  "demands holds each queue's reading; demand is the most-starved queue's — each wants one unit here, so the first, renders",
  [
    Object.keys(request?.demands ?? {}),
    MEDIA.map((queue) => request?.demands?.[queue]?.waiting),
    request?.demand.waiting,
  ],
  [[...MEDIA], MEDIA.map((queue) => BACKLOG[queue]), BACKLOG.renders],
);

const unit = units[0]!;
/** Whether every job added to `queue` has completed. */
const allDone = async (queue: string) =>
  (
    await Promise.all(
      added[queue]!.map(async (id) => await unitJobs.queue(queue).getJob(id)),
    )
  ).every((job) => job?.state === "completed");
await waitFor(
  "every queue's jobs to complete",
  async () =>
    (await allDone("renders")) &&
    (await allDone("thumbs")) &&
    (await allDone("previews")),
  WAIT,
);
const unitCode = await unit.exited();
const stopped = unit.find("Summoned worker stopped")?.fields;
const closing = unit.find("Summoned worker closing")?.fields;
show("the unit exited with", stopped);
checkEqual(
  "the unit exits idle once every queue is idle, naming every queue, with each queue's totals",
  [unitCode, stopped?.reason, closing?.queues, stopped?.queues],
  [
    0,
    "idle",
    [...MEDIA],
    Object.fromEntries(
      MEDIA.map((queue) => [queue, { completed: BACKLOG[queue], failed: 0 }]),
    ),
  ],
);
const unitIds = unit.ids();
const attribution = [];
for (const queue of MEDIA) {
  for (const id of added[queue]!) {
    const job = await unitJobs.queue(queue).getJob(id);
    attribution.push({
      queue,
      worker: job?.processedBy?.id === unitIds[queue],
      pid: job?.processedBy?.pid,
      processor: (job?.returnValue as { processor?: string })?.processor,
    });
  }
}
checkEqual(
  "every job on every queue ran in that one process, through its own queue's worker",
  attribution,
  attribution.map(({ queue }) => ({
    queue,
    worker: true,
    pid: unit.child.pid,
    processor: queue,
  })),
);
checkEqual(
  "one claim per member queue, each held by that queue's worker and marked with the unit's reason",
  await Promise.all(MEDIA.map(async (queue) => await claimsOf(unitNs, queue))),
  MEDIA.map((queue) => [[{ worker: unitIds[queue], reason: "idle", code: 0 }]]),
);

// The attempt settles at the next check, from those claims.
await waitFor(
  "the attempt to be released as registered",
  async () => {
    await unitController.check();
    const status = await unitController.status();
    return status.last?.id === request?.id && status.pending.length === 0;
  },
  WAIT,
);
const unitStatus = await unitController.status();
checkEqual(
  "the controller saw it register: nothing pending, no failure, and no second attempt",
  [
    unitStatus.last?.outcome,
    unitStatus.pending.length,
    unitStatus.failures,
    unitCalls.length,
  ],
  ["registered", 0, 0, 1],
);
checkEqual(
  "its events, started then registered, each name the group",
  unitEvents.map((event) => [event.id, event.outcome, event.group]),
  [
    [request?.id, "started", SHARED.name],
    [request?.id, "registered", SHARED.name],
  ],
);

/* ------------------------------------------------------------------ */
step("2. Each event once, on every member's channel");

// Every event is published by the time close() returns. A job added
// afterwards on each channel then reaches its listener after any copy of
// them would have: each channel delivers in order.
await unitController.close();
/** The channels on which the later job's `added` event has arrived. */
const caughtUp = new Set<string>();
for (const listener of listeners) {
  listener.on("added", () => caughtUp.add(listener.name));
}
for (const queue of [...MEDIA, "emails"]) {
  const publisher = new BunQueue(queue, {
    namespace: unitNs,
    driver,
    logger,
    publish: true,
  });
  await publisher.add("later", {});
  await publisher.close();
}
await waitFor(
  "the later job's event on every channel",
  () => caughtUp.size === MEDIA.length + 1,
  WAIT,
);
show(
  "each channel's summon events",
  Object.fromEntries(
    Object.entries(heard).map(([queue, events]) => [
      queue,
      events.map((event) => event.outcome),
    ]),
  ),
);
checkEqual(
  "each member queue's channel carried each event once, with the attempt's id and the group; emails, outside the group, none",
  Object.fromEntries(
    Object.entries(heard).map(([queue, events]) => [
      queue,
      events.map((event) => [event.id, event.outcome, event.group]),
    ]),
  ),
  {
    ...Object.fromEntries(
      MEDIA.map((queue) => [
        queue,
        [
          [request?.id, "started", SHARED.name],
          [request?.id, "registered", SHARED.name],
        ],
      ]),
    ),
    emails: [],
  },
);
await Promise.all(listeners.map(async (listener) => await listener.close()));

/* ------------------------------------------------------------------ */
step("3. Demand is the most-starved queue's, never the sum");

/** Each queue's backlog. */
const STARVED = { renders: 30, thumbs: 10, previews: 4 } as const;
/**
 * Each queue's capacity: renders 10 jobs a worker; thumbs 2, at most 2
 * units for its demand alone; previews the policy's (`Infinity` jobs a
 * worker: one unit while it has any).
 */
const OVERRIDES = {
  renders: { jobsPerWorker: 10 },
  thumbs: { jobsPerWorker: 2, maxWorkers: 2 },
} as const;
/** The unit's own cap. */
const MAX_WORKERS = 5;
/** What each queue alone wants: ⌈backlog / jobsPerWorker⌉, at most its maxWorkers. */
const WANTS = { renders: 3, thumbs: 2, previews: 1 } as const;

/** Adds `STARVED`'s backlog to every queue of `jobs`. */
async function starve(jobs: BunJobs): Promise<void> {
  for (const queue of MEDIA) {
    await jobs.queue(queue).addBulk(
      Array.from({ length: STARVED[queue] }, () => ({
        name: "work",
        data: {},
      })),
    );
  }
}

const demandJobs = context("summon-shared-demand");
await starve(demandJobs);
const demandSummoner = recording("example-record");
const demandController = controller({
  namespace: demandJobs.namespace,
  queues: [...MEDIA],
  group: SHARED,
  ...ONE_SHOT,
  summoner: demandSummoner.summoner,
  maxWorkers: MAX_WORKERS,
  overrides: OVERRIDES,
});
const demanded = await demandController.check();
const asked = demandSummoner.calls[0];
show("the request", {
  count: asked?.count,
  demand: asked?.demand.waiting,
  demands: Object.fromEntries(
    Object.entries(asked?.demands ?? {}).map(([queue, demand]) => [
      queue,
      demand.waiting,
    ]),
  ),
});
checkEqual(
  `one call for ${Math.max(...Object.values(WANTS))} units — renders' want, the largest — not their sum, ${Object.values(WANTS).reduce((sum, want) => sum + want, 0)}`,
  [said(demanded), demandSummoner.calls.length, asked?.count],
  ["started", 1, Math.max(...Object.values(WANTS))],
);
checkEqual(
  "demand is renders' reading, the most-starved queue's; demands has every queue's",
  [
    asked?.demand.waiting,
    MEDIA.map((queue) => asked?.demands?.[queue]?.waiting),
  ],
  [STARVED.renders, MEDIA.map((queue) => STARVED[queue])],
);
checkEqual(
  "those units are on their way to every queue: the next check calls nothing",
  [said(await demandController.check()), demandSummoner.calls.length],
  ["skipped pending", 1],
);

// The expansion form, for contrast: one controller per queue, each with
// the same capacity, summons for each queue apart.
const perQueueJobs = context("summon-shared-per-queue");
await starve(perQueueJobs);
const perQueueSummoner = recording("example-record");
for (const queue of MEDIA) {
  const own =
    queue in OVERRIDES ? OVERRIDES[queue as keyof typeof OVERRIDES] : {};
  await controller({
    namespace: perQueueJobs.namespace,
    queue,
    ...ONE_SHOT,
    summoner: perQueueSummoner.summoner,
    maxWorkers: MAX_WORKERS,
    ...own,
  }).check();
}
checkEqual(
  "the expansion form, for contrast: one call per queue, the sum in all",
  perQueueSummoner.calls.map((call) => [call.queue, call.count]),
  MEDIA.map((queue) => [queue, WANTS[queue]]),
);

/* ------------------------------------------------------------------ */
step("4. A unit missing a queue's worker: partial, one failure, no hook");

const partialJobs = context("summon-shared-partial");
const partialNs = partialJobs.namespace;
/** The queues the partial unit's entry builds workers for: thumbs is missing. */
const PARTIAL = ["renders", "previews"];
const MISSING = MEDIA.filter((queue) => !PARTIAL.includes(queue));
const waitingJob = await partialJobs.queue("thumbs").add("work", {});
const partialCalls: SummonRequest[] = [];
const partialUnits: ReturnType<typeof spawnUnit>[] = [];
/** What `onSummonFailed` was told. */
const told: SummonFailure[] = [];
const partialController = controller({
  namespace: partialNs,
  queues: [...MEDIA],
  group: SHARED,
  triggers: ONE_SHOT.triggers,
  // The missing queue's place settles only once the attempt's boot budget
  // has passed: kept short, so the tour waits a second, not three minutes.
  bootBudget: 1_000,
  summoner: defineSummoner({
    kind: "example-spawn",
    invoke: async (request: SummonRequest) => {
      partialCalls.push(request);
      partialUnits.push(
        spawnUnit(PARTIAL_ENTRY, request.argv, {
          PARTIAL_QUEUES: PARTIAL.join(","),
        }),
      );
      return { status: "started", handles: [] };
    },
  }),
  onSummonFailed: (failure) => {
    told.push(failure);
  },
});
const partialEvents: SummonEventPayload[] = [];
partialController.on("summon", (event) => partialEvents.push(event));

const partialCheck = await partialController.check();
const partialId = partialCalls[0]?.id;
check(
  "thumbs has work and no worker: one unit is summoned for the three queues",
  said(partialCheck) === "started" && partialCalls.length === 1,
  { check: said(partialCheck), calls: partialCalls.length },
);
// Its workers register on renders and previews; thumbs has none.
await waitFor(
  "the unit's workers to report on renders and previews",
  async () =>
    (
      await Promise.all(
        PARTIAL.map(async (queue) =>
          (await partialJobs.queue(queue).listWorkers()).some(
            (worker) => worker.summon?.id === partialId,
          ),
        ),
      )
    ).every(Boolean),
  WAIT,
);
await waitFor(
  "the attempt to settle",
  async () => {
    await partialController.check();
    const { last } = await partialController.status();
    return last?.id === partialId && last.outcome !== "started";
  },
  WAIT,
);
const partialStatus = await partialController.status();
show("status().last", partialStatus.last);
checkEqual(
  `registered, with detail partial:${MISSING.join(",")}, and counted as one failure`,
  [
    partialStatus.last?.outcome,
    partialStatus.last?.detail,
    partialStatus.failures,
    partialStatus.pending.length,
  ],
  ["registered", `partial:${MISSING.join(",")}`, 1, 0],
);
checkEqual(
  "the summon event says the same, naming the group",
  partialEvents
    .filter((event) => event.id === partialId)
    .map((event) => [event.outcome, event.detail, event.group]),
  [
    ["started", undefined, SHARED.name],
    ["registered", `partial:${MISSING.join(",")}`, SHARED.name],
  ],
);
const partialLog = logged.filter(
  (event) => event.fields.id === partialId && event.level === "error",
);
checkEqual(
  "one error log naming the missing queue, and onSummonFailed not called",
  [
    partialLog.map((event) => event.fields.missing),
    partialLog[0]?.message,
    told,
  ],
  [
    [MISSING],
    `summon unit registered without a worker for ${MISSING.join(", ")}: its entry script runs no worker for those queues; counted as a failure`,
    [],
  ],
);
checkEqual(
  "thumbs' job still waits: nothing in the unit takes it",
  (await partialJobs.queue("thumbs").getJob(waitingJob.id))?.state,
  "waiting",
);
const partialUnit = partialUnits[0]!;
partialUnit.child.kill("SIGTERM");
check("the partial unit closes on SIGTERM", (await partialUnit.exited()) === 0);

/* ------------------------------------------------------------------ */
step("5. Both budgets apply: the stricter, per period");

/** The policy's own budget: 2 an hour (and the default 300 a day). */
const OWN_BUDGET = { perHour: 2 } as const;
/** The group's budget: 5 an hour, 3 a day. */
const GROUP_BUDGET = { perHour: 5, perDay: 3 } as const;
/** The limits the unit is held to: per period, the smaller. */
const EFFECTIVE = { perHour: 2, perDay: 3 } as const;

const budgetJobs = context("summon-shared-budget");
await budgetJobs.queue("thumbs").add("work", {});
/** Every request the failing summoner was handed. */
const budgetCalls: SummonRequest[] = [];
const budgetController = controller({
  namespace: budgetJobs.namespace,
  queues: [...MEDIA],
  group: { ...SHARED, budget: GROUP_BUDGET },
  budget: OWN_BUDGET,
  ...ONE_SHOT,
  // Its failures are what spend the budget here: no circuit in the way.
  circuit: { failures: 1_000 },
  // A platform that is down: every call fails, and still counts.
  summoner: defineSummoner({
    kind: "example-down",
    invoke: async (request: SummonRequest) => {
      budgetCalls.push(request);
      throw new Error("the platform is down");
    },
  }),
});
const budgetEvents: SummonEventPayload[] = [];
budgetController.on("summon", (event) => budgetEvents.push(event));

const before = await budgetController.status();
checkEqual(
  "status().budget shows the limits the unit is held to; status().group.budget the group's own",
  [
    { perHour: before.budget?.perHour, perDay: before.budget?.perDay },
    {
      perHour: before.group?.budget.perHour,
      perDay: before.group?.budget.perDay,
    },
  ],
  [EFFECTIVE, GROUP_BUDGET],
);

await withinOneHour(HOUR_NEEDED);
const spent: string[] = [];
for (let round = 0; round < 10; round++) {
  const outcome = said(await budgetController.check());
  // The 1 ms backoff after a failure can still be running: not a decision.
  if (outcome !== "skipped backoff") {
    spent.push(outcome);
  }
  if (outcome === "skipped budget") {
    break;
  }
  await Bun.sleep(5);
}
show("checks until the budget held", spent);
checkEqual(
  `the policy's ${OWN_BUDGET.perHour} an hour holds, under the group's ${GROUP_BUDGET.perHour}: two calls, then budget`,
  [spent, budgetCalls.length],
  [["failed", "failed", "skipped budget"], EFFECTIVE.perHour],
);
const after = await budgetController.status();
checkEqual(
  "both views count the same attempts, each against its own limits; every member's share counts each",
  [
    after.budget?.hour,
    after.budget?.perHour,
    after.budget?.perDay,
    after.group?.budget.hour,
    after.group?.budget.perHour,
    after.group?.budget.perDay,
    Object.fromEntries(
      Object.entries(after.group?.queues ?? {}).map(([queue, share]) => [
        queue,
        share.day,
      ]),
    ),
  ],
  [
    EFFECTIVE.perHour,
    EFFECTIVE.perHour,
    EFFECTIVE.perDay,
    EFFECTIVE.perHour,
    GROUP_BUDGET.perHour,
    GROUP_BUDGET.perDay,
    Object.fromEntries(MEDIA.map((queue) => [queue, EFFECTIVE.perHour])),
  ],
);
check(
  "the budget-exhausted event names the group",
  budgetEvents.some(
    (event) =>
      event.outcome === "budget-exhausted" && event.group === SHARED.name,
  ),
  budgetEvents.map((event) => [event.outcome, event.group]),
);

// A process with no controller reads the group from storage: the entry
// keeps the group's own limits, never the stricter ones the unit applied.
const bare = new BunJobs({
  namespace: budgetJobs.namespace,
  driver,
  logger,
});
contexts.push(bare);
const api = createJobsApi({
  jobs: bare,
  basePath: "/jobs-api",
  authorize: () => true,
});
const adapter = new BunHttpAdapter(0);
adapter.use(api.basePath, api.router);
const stored = (await (
  await adapter.fetch(`${api.basePath}/summon/groups/${SHARED.name}`)
).json()) as SummonGroupStatusDto;
show(
  `GET /summon/groups/${SHARED.name} with no controller here`,
  stored.budget,
);
checkEqual(
  "read from storage, the group shows its own limits and the unit's attempts",
  [stored.budget.perHour, stored.budget.perDay, stored.budget.hour],
  [GROUP_BUDGET.perHour, GROUP_BUDGET.perDay, EFFECTIVE.perHour],
);

/* ------------------------------------------------------------------ */
step("6. Scale style: released only once every queue is idle");

const scaleJobs = context("summon-shared-scale");
const releases: SummonReleaseRequest[] = [];
const scaleController = controller({
  namespace: scaleJobs.namespace,
  queues: [...MEDIA],
  group: SHARED,
  ...ONE_SHOT,
  // No idle time required: only the queues' work holds the release back.
  scaleDown: { after: 0 },
  summoner: defineSummoner({
    kind: "example-scale",
    style: "scale",
    invoke: async () => ({ status: "started", handles: ["service"] }),
    release: async (release) => {
      releases.push(release);
    },
  }),
});
const rendersJob = await scaleJobs.queue("renders").add("work", {});
const previewsJob = await scaleJobs.queue("previews").add("work", {});
const scaled = [said(await scaleController.check())];
await scaleJobs.queue("renders").remove(rendersJob.id);
// renders is idle now; previews still has its job.
scaled.push(said(await scaleController.check()));
scaled.push(said(await scaleController.check()));
checkEqual(
  "set to one; then, with renders idle but previews' job waiting, never released",
  [scaled, releases.length],
  [["started", "skipped pending", "skipped pending"], 0],
);
await scaleJobs.queue("previews").remove(previewsJob.id);
await waitFor(
  "the release once every queue is idle",
  async () => said(await scaleController.check()) === "released",
  WAIT,
);
checkEqual(
  "the release names every queue and the group, with a target of 0",
  releases,
  [
    {
      namespace: scaleJobs.namespace,
      queue: "renders",
      queues: [...MEDIA],
      group: SHARED.name,
      target: 0,
    },
  ],
);

/* ------------------------------------------------------------------ */
step("7. Refused at construction, and by BunJobs today");

const refusalNs = exampleNamespace("summon-shared-refusals");
const anySummoner = recording("example-record").summoner;
/** A shared unit's options, with `change` over them. */
const shared = (
  change: Partial<SummonControllerOptions> = {},
): SummonControllerOptions => ({
  driver,
  logger,
  namespace: refusalNs,
  queues: [...MEDIA],
  group: SHARED,
  ...ONE_SHOT,
  summoner: anySummoner,
  ...change,
});
/** Builds a controller from `options`, closing it if it was not refused. */
const build = (options: SummonControllerOptions) => () => {
  void new SummonController(options).close();
};
/** A summon-facet capability set, as a launch platform declares it. */
const CAPABILITIES: SummonCapabilities = {
  style: "launch",
  dedupe: { kind: "none" },
  passes: "argv",
  bootBudgetMs: 20_000,
  shutdown: { signal: "SIGTERM", graceMs: 10_000 },
  maxLifetimeMs: null,
  enforcesLifetime: false,
};
/** A provider declaring summon API `summon`. */
function providerAt(summon: string) {
  return defineComputeProvider({
    name: `bun-jobs-provider-example-${summon.replace(".", "-")}`,
    version: "1.0.0",
    kind: "example-cloud",
    apiVersion: { core: COMPUTE_PROVIDER_API.core, summon },
    config: toStandardSchema<{ region: string }>((input) => ({
      value: input as { region: string },
    })),
    summon: () => ({
      capabilities: CAPABILITIES,
      summon: async () => ({ status: "started", handles: [] }),
    }),
  })({ region: "eu" });
}

const CONFIG = { name: "ConfigError", code: "CONFIG" };
const { queues: _queues, ...withoutQueues } = shared();
await checkRejects(
  "queue together with queues",
  build(shared({ queue: "renders" })),
  { ...CONFIG, message: /^SummonController takes queue or queues, not both/ },
);
await checkRejects(
  'queues without unit: "shared"',
  build(shared({ group: { name: SHARED.name } })),
  {
    ...CONFIG,
    message:
      /^queues is for a shared unit: set group: \{ name, unit: "shared" \}/,
  },
);
await checkRejects(
  'queue with unit: "shared"',
  build({ ...withoutQueues, queue: "renders" }),
  {
    ...CONFIG,
    message:
      /^A shared unit \(group\.unit: "shared"\) names the queues it serves in queues, not queue$/,
  },
);
await checkRejects("an empty queues", build(shared({ queues: [] })), {
  ...CONFIG,
  message: /^queues must name at least one queue$/,
});
await checkRejects(
  "a queue named twice",
  build(shared({ queues: ["renders", "thumbs", "renders"] })),
  { ...CONFIG, message: /^queues names "renders" twice/ },
);
await checkRejects(
  "an override of anything but jobsPerWorker and maxWorkers",
  build(
    shared({
      overrides: {
        thumbs: { budget: { perHour: 1 } },
      } as unknown as SummonControllerOptions["overrides"],
    }),
  ),
  {
    ...CONFIG,
    message:
      /^overrides\.thumbs\.budget: a shared unit takes only jobsPerWorker and maxWorkers per queue/,
  },
);
await checkRejects(
  "a provider written for summon 0.1",
  build(shared({ summoner: providerAt("0.1") })),
  {
    ...CONFIG,
    message:
      /^A shared unit needs a provider written for summon 0\.2 or later.*negotiated summon 0\.1/,
  },
);
await checkRejects(
  'a platform that passes "none"',
  build(
    shared({
      summoner: defineSummoner({
        kind: "example-fixed",
        passes: "none",
        invoke: async () => ({ status: "started", handles: [] }),
      }),
    }),
  ),
  {
    ...CONFIG,
    message: /^A shared unit needs a platform that passes identity/,
  },
);
const accepted = new SummonController(
  shared({ summoner: providerAt(COMPUTE_PROVIDER_API.summon) }),
);
checkEqual(
  `the same provider at summon ${COMPUTE_PROVIDER_API.summon} is accepted: controller.queue is the first of controller.queues`,
  [accepted.queue, accepted.queues],
  ["renders", [...MEDIA]],
);
await accepted.close();

/** BunJobs' refusal, word for word. */
const BUNJOBS_REFUSAL =
  /^A shared summon unit \(group\.unit "shared"\) is not supported through BunJobs' summon option or summonController\(\) yet; build a SummonController with queues directly$/;
await checkRejects(
  "today, BunJobs' summon option refuses a shared unit (array form)",
  () => {
    void new BunJobs({
      namespace: refusalNs,
      driver,
      logger,
      summon: [{ queues: [...MEDIA], summoner: anySummoner, group: SHARED }],
    }).close();
  },
  { ...CONFIG, message: BUNJOBS_REFUSAL },
);
await checkRejects(
  "…and as a record",
  () => {
    void new BunJobs({
      namespace: refusalNs,
      driver,
      logger,
      summon: { renders: { summoner: anySummoner, group: SHARED } },
    }).close();
  },
  { ...CONFIG, message: BUNJOBS_REFUSAL },
);
const refusing = new BunJobs({ namespace: refusalNs, driver, logger });
contexts.push(refusing);
await checkRejects(
  "…and so does jobs.summonController()",
  () =>
    refusing.summonController("renders", {
      summoner: anySummoner,
      group: SHARED,
    }),
  { ...CONFIG, message: BUNJOBS_REFUSAL },
);

/* ------------------------------------------------------------------ */
step("8. reset(): the kind's circuit, and the budget's counts");

const resetJobs = context("summon-shared-reset");
const resetNs = resetJobs.namespace;
/** The provider kind both controllers below summon with. */
const KIND = "example-cloud";
// A per-queue controller of the same group, for a queue outside the unit,
// sharing the group's circuit. Its credentials are rejected: an `auth`
// error opens the group's circuit for its kind at once.
const emails = controller({
  namespace: resetNs,
  queue: "emails",
  group: { name: SHARED.name, circuit: true },
  ...ONE_SHOT,
  summoner: defineSummoner({
    kind: KIND,
    invoke: async () => {
      throw new ProviderError("credentials rejected", "auth");
    },
  }),
});
await resetJobs.queue("emails").add("work", {});
checkEqual("emails' call is rejected", said(await emails.check()), "failed");

const resetSummoner = recording(KIND);
const resetController = controller({
  namespace: resetNs,
  queues: [...MEDIA],
  group: SHARED,
  ...ONE_SHOT,
  summoner: resetSummoner.summoner,
});
await resetJobs.queue("renders").add("work", {});
const held = await resetController.check();
const heldStatus = await resetController.status();
show("the unit's circuitOpenUntil, and the group's circuits", {
  circuitOpenUntil: heldStatus.circuitOpenUntil,
  circuits: heldStatus.group?.circuits,
});
checkEqual(
  `the unit summons with the same kind: held back by that circuit, which its status shows as its own`,
  [
    said(held),
    resetSummoner.calls.length,
    heldStatus.circuitOpenUntil !== undefined &&
      heldStatus.circuitOpenUntil ===
        heldStatus.group?.circuits?.[KIND]?.openUntil,
  ],
  ["skipped circuit-open", 0, true],
);

await resetController.reset();
const closed = await resetController.status();
checkEqual(
  "reset() closes it: no circuit in the status or in the group, and the unit is summoned",
  [
    closed.circuitOpenUntil,
    closed.group?.circuits?.[KIND],
    said(await resetController.check()),
    resetSummoner.calls.length,
  ],
  [undefined, undefined, "started", 1],
);

const spentStatus = await resetController.status();
show("the group's budget and shares before reset({ budget: true })", {
  budget: spentStatus.group?.budget.hour,
  queues: spentStatus.group?.queues,
});
await resetController.reset({ budget: true });
const cleared = await resetController.status();
checkEqual(
  "reset({ budget: true }) zeroes the counts, the unit's and the group's, and drops every queue's share",
  [
    [spentStatus.budget?.hour, spentStatus.group?.budget.hour],
    Object.keys(spentStatus.group?.queues ?? {}).sort(),
    [cleared.budget?.hour, cleared.budget?.day],
    [cleared.group?.budget.hour, cleared.group?.budget.day],
    cleared.group?.queues,
  ],
  [[2, 2], ["emails", ...MEDIA].sort(), [0, 0], [0, 0], {}],
);

/* ------------------------------------------------------------------ */
// Cleanup: every namespace this run wrote to, and nothing else.
for (const built of controllers) {
  await built.close();
}
for (const jobs of contexts) {
  await jobs.purge();
  await jobs.close();
}
await driver.close();

summary();
