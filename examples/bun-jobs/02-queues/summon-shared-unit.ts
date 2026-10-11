/**
 * One summoned unit for several queues: a summon policy with `queues` and
 * `group: { name, unit: "shared" }` is one controller, which summons one
 * process that runs a worker for every queue of the group. `BunJobs` builds
 * it from one entry of its `summon` option; `new SummonController({ queues,
 * … })` builds the same by hand.
 *
 * ```bash
 * bun 02-queues/summon-shared-unit.ts
 * ```
 *
 * ```ts
 * const jobs = new BunJobs({
 *   namespace: "studio",
 *   driver,
 *   summon: [{
 *     queues: ["renders", "thumbs", "previews"],
 *     group: { name: "media", unit: "shared" },
 *     summoner,
 *     overrides: { renders: { jobsPerWorker: 10 } },
 *   }],
 * });
 * jobs.summonController("thumbs") === jobs.summonController("renders"); // true
 * ```
 *
 * Steps 1 to 8 build the controller by hand, to show what a unit does; steps
 * 9 to 14 build it through `BunJobs`, and show what it adds and refuses, and
 * what the management API shows a caller who may see only some of its
 * queues. The
 * unit summoned in steps 1 and 9 is a real child process, started with the
 * request's `argv`: `02-queues/helpers/summoned-unit-entry.ts`, the entry
 * file `summoned-unit.ts` runs, which builds one worker per queue in
 * `summonedFromArgs().queues` and runs them together with
 * `runSummoned(workers)`; step 12 starts two more from it, for other
 * controllers on the same queues. Step 4 starts a real child too, from
 * `02-queues/helpers/partial-unit-entry.ts`, an entry that forgot a queue,
 * and step 14 starts one more from it; the other steps use summoners that
 * start nothing. Every trigger is off,
 * so a check runs only when the tour calls `check()`. Summoning needs a
 * backend another process can reach, so on the memory driver this runs on a
 * temporary SQLite file.
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
 *   `partial:<queues>`** and those queues in the event's `missing`: one
 *   failure, one `error` log naming the queues, and no `onSummonFailed`. The
 *   queue with no worker settles only once the attempt's `bootBudget` has
 *   passed, so that is when the failure counts.
 * - **Each `summon` event is published once on every member's channel**, and
 *   every copy carries the same `eventId`, a UUIDv7 of the event's own:
 *   dedupe by it. Its events, its `status()` and what `onSummonFailed` is
 *   told name every queue in `queues`, `queue` being the first.
 * - **Both budgets apply**: the policy's `budget` and `group.budget`, the
 *   stricter per period. `status().budget` shows the limits the unit is held
 *   to; `status().group.budget` shows the group's own.
 * - **A scale-style unit is released only once every queue is idle**, and
 *   the release names every queue and the group.
 * - **`reset()` also closes a circuit that per-queue controllers of the
 *   group opened for the unit's provider kind**, and `reset({ budget: true })`
 *   clears the counts and every queue's share. Over HTTP,
 *   `POST /summon/groups/:group/reset` with `{ "circuit": true }` closes the
 *   unit's own circuit as well.
 * - **In `BunJobs` it is one controller under every member's name**:
 *   `jobs.summonController(member)` answers it, and `GET /summon` lists it
 *   once, under its first queue, with `queues` and `group`. Passing a policy
 *   for a member is a `ConfigError` naming the group, and so is a shared
 *   unit's policy passed to `summonController()`, an override of anything
 *   but `jobsPerWorker` and `maxWorkers`, one group's unit written twice,
 *   and an override that makes one queue of a per-queue entry shared. A
 *   record (`{ renders: { group: { name, unit: "shared" }, … } }`) is a
 *   unit of one queue.
 * - **A caller who may see only some of a unit's queues sees only those.**
 *   Wherever the API answers the unit's status — `GET /summon`, a member's
 *   `GET /queues/:queue/summon`, a reset — `queues` keeps the members the
 *   caller may read (`queues.read`), `queue` is the first of them, whichever
 *   member was asked about, and a `partial:` detail names only those (bare
 *   `partial` when none is left). On the socket, the members a subscriber
 *   may follow (`events.subscribe`, asked with the channel and the member).
 * - **"Summon now" and a reset need `queues.summon` on every member.** The
 *   route's queue is asked first, then each other member in code-point
 *   order, every one even after a refusal; the first refusal in that order
 *   is the answer — 403 `FORBIDDEN` or 401 `UNAUTHORIZED`, naming no queue —
 *   and nothing runs.
 * - **One queue, one summoning controller.** A unit that finds another
 *   group's unit's workers on its queues lists that group in
 *   `status().overlaps` and warns once per queue and group; a summoned
 *   worker with no group (a per-queue controller's) is warned about once
 *   per queue, and not listed.
 */
import type {
  ConfigError,
  JobsApiAction,
  JobsApiAuthorizeContext,
  JobsDriver,
  SummonCheckResult,
  SummonControllerOptions,
  SummonEventPayload,
  SummonFailure,
  SummonGroupStatusDto,
  SummonListDto,
  SummonOption,
  SummonPolicy,
  SummonReleaseRequest,
  SummonRequest,
  SummonStatusDto,
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
  JOBS_API_ACTIONS,
  JOBS_API_OPT_IN_ACTIONS,
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
import { connectJobsSocket } from "../11-management-api/helpers/jobs-socket";
import { crossProcessDriver, exampleNamespace } from "../shared/backend";
import { withinOneHour } from "../shared/budget-window";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { A_UUID_V7, markEventId, UUID_V7 } from "../shared/summon-events";

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

/**
 * A summoner that starts each unit on this machine from `entry`, as step 1's
 * does, recording each request and the unit it started for it.
 */
function spawning(entry: string, env: Record<string, string> = {}) {
  const calls: SummonRequest[] = [];
  const started: ReturnType<typeof spawnUnit>[] = [];
  return {
    calls,
    started,
    summoner: defineSummoner({
      kind: "example-spawn",
      invoke: async (request: SummonRequest) => {
        calls.push(request);
        const unit = spawnUnit(entry, request.argv, env);
        started.push(unit);
        return { status: "started", handles: [`pid:${unit.child.pid}`] };
      },
    }),
  };
}

/** `text`, and nothing else, as a pattern: an error's whole message. */
const exactly = (text: string): RegExp =>
  new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

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
  "status() is the unit's: queue is the first member, queues all three, in order",
  [unitStatus.queue, unitStatus.queues],
  ["renders", [...MEDIA]],
);
checkEqual(
  "its events, started then registered, each name the group and every queue, with an eventId of its own (a UUIDv7)",
  unitEvents.map((event) =>
    markEventId({
      id: event.id,
      outcome: event.outcome,
      group: event.group,
      queues: event.queues,
      eventId: event.eventId,
    }),
  ),
  (["started", "registered"] as const).map((outcome) => ({
    id: request?.id,
    outcome,
    group: SHARED.name,
    queues: [...MEDIA],
    eventId: A_UUID_V7,
  })),
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
  "each member queue's channel carried each event once, with the attempt's id, the group and every queue; emails, outside the group, none",
  Object.fromEntries(
    Object.entries(heard).map(([queue, events]) => [
      queue,
      events.map((event) => [
        event.id,
        event.outcome,
        event.group,
        event.queues,
      ]),
    ]),
  ),
  {
    ...Object.fromEntries(
      MEDIA.map((queue) => [
        queue,
        [
          [request?.id, "started", SHARED.name, [...MEDIA]],
          [request?.id, "registered", SHARED.name, [...MEDIA]],
        ],
      ]),
    ),
    emails: [],
  },
);
/** Each event's `eventId`, as this process heard it, in order. */
const localIds = unitEvents.map((event) => event.eventId);
checkEqual(
  "every copy carries the eventId the event had here: one UUIDv7 per event, the same on each member's channel, so a listener on several dedupes by it",
  [
    localIds.map((id) => UUID_V7.test(id ?? "")),
    new Set(localIds).size,
    Object.fromEntries(
      MEDIA.map((queue) => [
        queue,
        heard[queue]!.map((event) => event.eventId),
      ]),
    ),
  ],
  [
    [true, true],
    2,
    Object.fromEntries(MEDIA.map((queue) => [queue, localIds])),
  ],
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
  "the summon event says the same, naming the group, and lists the queue with no worker in missing",
  partialEvents
    .filter((event) => event.id === partialId)
    .map((event) => [event.outcome, event.detail, event.group, event.missing]),
  [
    ["started", undefined, SHARED.name, undefined],
    ["registered", `partial:${MISSING.join(",")}`, SHARED.name, MISSING],
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
/** What `onSummonFailed` was told. */
const budgetTold: SummonFailure[] = [];
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
  onSummonFailed: (failure) => {
    budgetTold.push(failure);
  },
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
// The hook is never awaited: it runs a turn after the check that told it.
await waitFor(
  "onSummonFailed to hear the budget-exhausted",
  () => budgetTold.some((failure) => failure.outcome === "budget-exhausted"),
  WAIT,
);
checkEqual(
  "onSummonFailed names the unit: queue the first member, queues every one, on both failures and the budget-exhausted",
  budgetTold.map((failure) => [failure.outcome, failure.queue, failure.queues]),
  [
    ["failed", "renders", [...MEDIA]],
    ["failed", "renders", [...MEDIA]],
    ["budget-exhausted", "renders", [...MEDIA]],
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
step("7. Refused at construction");

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
step("9. BunJobs builds the unit: one entry of the summon option");

const optionSpawn = spawning(UNIT_ENTRY);
const optionJobs = new BunJobs({
  namespace: exampleNamespace("summon-shared-option"),
  driver,
  logger,
  summon: [
    {
      queues: [...MEDIA],
      group: SHARED,
      ...ONE_SHOT,
      summoner: optionSpawn.summoner,
      maxWorkers: 2,
      // Only these two may differ per queue, maxWorkers at most the unit's:
      // everything else is the unit's.
      overrides: { renders: { jobsPerWorker: 10, maxWorkers: 1 } },
    },
  ],
});
contexts.push(optionJobs);
const optionUnit = optionJobs.summonController("renders");
checkEqual(
  "one controller for the entry: summonController() answers it for every member, queues in the order written, queue the first",
  [
    MEDIA.map((queue) => optionJobs.summonController(queue) === optionUnit),
    optionUnit.queue,
    optionUnit.queues,
  ],
  [[true, true, true], "renders", [...MEDIA]],
);
/** What the unit emitted, in order. */
const optionEvents: SummonEventPayload[] = [];
optionUnit.on("summon", (event) => optionEvents.push(event));

/** The one job added to each member queue, by queue. */
const optionAdded: Record<string, string> = {};
for (const queue of MEDIA) {
  optionAdded[queue] = (await optionJobs.queue(queue).add("quick", {})).id;
}
const optionFirst = await optionUnit.check();
const optionRequest = optionSpawn.calls[0];
checkEqual(
  "one attempt for the three queues, as step 1's hand-built unit made: the request names them in order, the group, and one unit",
  [
    said(optionFirst),
    optionSpawn.calls.length,
    optionRequest?.queue,
    optionRequest?.queues,
    optionRequest?.group,
    optionRequest?.count,
  ],
  ["started", 1, "renders", [...MEDIA], SHARED.name, 1],
);
await waitFor(
  "every member's job to complete",
  async () =>
    (
      await Promise.all(
        MEDIA.map(
          async (queue) =>
            (await optionJobs.queue(queue).getJob(optionAdded[queue]!))?.state,
        ),
      )
    ).every((state) => state === "completed"),
  WAIT,
);
const optionChild = optionSpawn.started[0]!;
const optionCode = await optionChild.exited();
const optionStopped = optionChild.find("Summoned worker stopped")?.fields;
checkEqual(
  "the unit completed each queue's job and exited idle once every queue was",
  [optionCode, optionStopped?.reason, optionStopped?.queues],
  [
    0,
    "idle",
    Object.fromEntries(
      MEDIA.map((queue) => [queue, { completed: 1, failed: 0 }]),
    ),
  ],
);
await waitFor(
  "the attempt to be released as registered",
  async () => {
    await optionUnit.check();
    const status = await optionUnit.status();
    return status.last?.id === optionRequest?.id && status.pending.length === 0;
  },
  WAIT,
);
const optionStatus = await optionJobs.summonController("previews").status();
checkEqual(
  "read through any member, the status is the unit's: registered, nothing pending, no failure, queue the first, queues all three",
  [
    optionStatus.last?.outcome,
    optionStatus.pending.length,
    optionStatus.failures,
    optionStatus.queue,
    optionStatus.queues,
    optionSpawn.calls.length,
  ],
  ["registered", 0, 0, "renders", [...MEDIA], 1],
);
checkEqual(
  "its events, started then registered, each name the group and every queue, with an eventId of its own (a UUIDv7)",
  optionEvents.map((event) =>
    markEventId({
      id: event.id,
      outcome: event.outcome,
      group: event.group,
      queues: event.queues,
      eventId: event.eventId,
    }),
  ),
  (["started", "registered"] as const).map((outcome) => ({
    id: optionRequest?.id,
    outcome,
    group: SHARED.name,
    queues: [...MEDIA],
    eventId: A_UUID_V7,
  })),
);

// The management API over this context: the unit is one row, under its
// first queue, and every member's status route answers the unit's status.
const optionApi = createJobsApi({
  jobs: optionJobs,
  basePath: "/jobs-api",
  authorize: () => true,
});
const optionAdapter = new BunHttpAdapter(0);
optionAdapter.use(optionApi.basePath, optionApi.router);
/** `GET <path>` on the API over `optionJobs`, its body as JSON. */
const optionGet = async <T>(path: string): Promise<T> =>
  (await (
    await optionAdapter.fetch(`${optionApi.basePath}${path}`)
  ).json()) as T;
const listing = await optionGet<SummonListDto>("/summon");
show(
  "GET /summon",
  listing.controllers.map((item) => ({
    queue: item.queue,
    queues: item.queues,
    group: item.group,
    local: item.local,
    kind: item.kind,
  })),
);
checkEqual(
  "GET /summon lists the unit once: under its first queue, with every queue, the group, local, its kind and the last outcome",
  listing.controllers.map((item) => [
    item.queue,
    item.queues,
    item.group,
    item.local,
    item.kind,
    item.last?.outcome,
  ]),
  [["renders", [...MEDIA], SHARED.name, true, "example-spawn", "registered"]],
);
checkEqual(
  "GET /queues/<member>/summon answers the unit's status for each member: queue renders, queues all three",
  await Promise.all(
    MEDIA.map(async (queue) => {
      const status = await optionGet<SummonStatusDto>(
        `/queues/${queue}/summon`,
      );
      return [status.queue, status.queues];
    }),
  ),
  MEDIA.map(() => ["renders", [...MEDIA]]),
);

/* ------------------------------------------------------------------ */
step("10. As a record: a shared unit of one queue");

const recordSummoner = recording("example-record");
const recordJobs = new BunJobs({
  namespace: exampleNamespace("summon-shared-record"),
  driver,
  logger,
  summon: {
    renders: { group: SHARED, ...ONE_SHOT, summoner: recordSummoner.summoner },
  },
});
contexts.push(recordJobs);
const soloUnit = recordJobs.summonController("renders");
await recordJobs.queue("renders").add("work", {});
const soloCheck = await soloUnit.check();
const soloStatus = await soloUnit.status();
const soloRequest = recordSummoner.calls[0];
show("the request", {
  queue: soloRequest?.queue,
  queues: soloRequest?.queues,
  group: soloRequest?.group,
  count: soloRequest?.count,
});
checkEqual(
  "the controller, its status and the request each name the one queue in queues; the status names the group, and the request, like any one-queue request, none",
  [
    soloUnit.queue,
    soloUnit.queues,
    soloStatus.queues,
    soloStatus.group?.name,
    said(soloCheck),
    soloRequest?.queues,
    soloRequest?.group,
  ],
  [
    "renders",
    ["renders"],
    ["renders"],
    SHARED.name,
    "started",
    ["renders"],
    undefined,
  ],
);

/* ------------------------------------------------------------------ */
step("11. What BunJobs refuses");

/** A per-queue policy, for the refusals below. */
const plain: SummonPolicy = { ...ONE_SHOT, summoner: anySummoner };
const memberRefusal = await checkRejects(
  'a policy for a member of a shared unit: summonController("thumbs", policy)',
  () => optionJobs.summonController("thumbs", plain),
  {
    ...CONFIG,
    message: exactly(
      `Queue "thumbs" is served by summon group "media"'s shared unit (group.unit "shared", for renders, thumbs, previews), so summonController() takes no policy for it: change the unit's entry in the summon option — its overrides.thumbs for jobsPerWorker and maxWorkers — or take "thumbs" out of its queues to give it a controller of its own`,
    ),
  },
);
checkEqual(
  "its context names the queue, the group and the unit's queues; the member's controller is still the unit",
  [
    (memberRefusal as ConfigError | undefined)?.context,
    optionJobs.summonController("thumbs") === optionUnit,
  ],
  [{ queue: "thumbs", group: SHARED.name, queues: [...MEDIA] }, true],
);

const refusing = new BunJobs({ namespace: refusalNs, driver, logger });
contexts.push(refusing);
const policyRefusal = await checkRejects(
  "a shared unit's policy passed to summonController()",
  () => refusing.summonController("renders", { ...plain, group: SHARED }),
  {
    ...CONFIG,
    message: exactly(
      `summonController() builds a controller for one queue, and this policy is a shared unit's (group.unit "shared"): write the unit in the summon option, { queues: [...], group: { name: "media", unit: "shared" }, … }, or build it with new SummonController({ queues, … })`,
    ),
  },
);
checkEqual(
  "its context names the queue and the group",
  (policyRefusal as ConfigError | undefined)?.context,
  { queue: "renders", group: SHARED.name },
);

/** Builds a context with `summon`, closing it if it was not refused. */
const withSummon = (summon: SummonOption) => () => {
  void new BunJobs({ namespace: refusalNs, driver, logger, summon }).close();
};
await checkRejects(
  "an override of anything but jobsPerWorker and maxWorkers, named by its path",
  withSummon([
    {
      queues: [...MEDIA],
      group: SHARED,
      ...plain,
      overrides: { thumbs: { budget: { perHour: 1 } } },
    },
  ]),
  {
    ...CONFIG,
    message: exactly(
      `summon[0].overrides.thumbs.budget: a shared unit (group.unit "shared") takes only jobsPerWorker and maxWorkers per queue; budget is the unit's, so set it on the entry`,
    ),
  },
);
await checkRejects(
  "one group's shared unit written twice",
  withSummon([
    { queues: ["renders", "thumbs"], group: SHARED, ...plain },
    { queues: ["previews"], group: SHARED, ...plain },
  ]),
  {
    ...CONFIG,
    message: exactly(
      `Summon group "media" is a shared unit written twice in the summon option (at summon[0] and summon[1]): a shared unit is one controller, so list all of its queues in one entry, { queues: [...], group: { name: "media", unit: "shared" }, … }`,
    ),
  },
);
await checkRejects(
  "…and as a record of two queues, each a unit of the same group",
  withSummon({
    renders: { ...plain, group: SHARED },
    thumbs: { ...plain, group: SHARED },
  }),
  {
    ...CONFIG,
    message: exactly(
      `Summon group "media" is a shared unit written twice in the summon option (at summon.renders and summon.thumbs): a shared unit is one controller, so list all of its queues in one entry, { queues: [...], group: { name: "media", unit: "shared" }, … }`,
    ),
  },
);
await checkRejects(
  "an override that makes one queue of a per-queue entry shared",
  withSummon([
    {
      queues: ["renders", "thumbs"],
      ...plain,
      overrides: { thumbs: { group: SHARED } },
    },
  ]),
  {
    ...CONFIG,
    message: exactly(
      `summon[0].overrides.thumbs.group makes "thumbs" a shared unit (group.unit "shared") inside an entry of per-queue controllers: write the shared unit as an entry of its own`,
    ),
  },
);

/* ------------------------------------------------------------------ */
step("12. One queue, one summoning controller: status().overlaps");

// The misconfiguration the warnings are for, in step 9's namespace: another
// group's shared unit over thumbs and emails, and a per-queue controller for
// previews. Each summons a real unit, which stays up (idle for a minute)
// until this step stops it.
/** Keeps a unit up through this step's checks: it is stopped at the end. */
const LINGER = { SUMMONED_IDLE_FOR: "60000" };
const archiveSpawn = spawning(UNIT_ENTRY, LINGER);
const archive = controller({
  namespace: optionJobs.namespace,
  queues: ["thumbs", "emails"],
  group: { name: "archive", unit: "shared" },
  ...ONE_SHOT,
  summoner: archiveSpawn.summoner,
});
const loneSpawn = spawning(UNIT_ENTRY, LINGER);
const lone = controller({
  namespace: optionJobs.namespace,
  queue: "previews",
  ...ONE_SHOT,
  summoner: loneSpawn.summoner,
});
const emailsJob = await optionJobs.queue("emails").add("quick", {});
const loneJob = await optionJobs.queue("previews").add("quick", {});
checkEqual(
  "the archive unit and the per-queue controller each summon a unit of their own",
  [said(await archive.check()), said(await lone.check())],
  ["started", "started"],
);
// Their workers are up, and the jobs done: the unit has nothing to summon for.
await waitFor(
  "archive's worker on thumbs, the per-queue worker on previews, and both jobs done",
  async () => {
    const thumbsWorkers = await optionJobs.queue("thumbs").listWorkers();
    const previewsWorkers = await optionJobs.queue("previews").listWorkers();
    return (
      thumbsWorkers.some((worker) => worker.summon?.group === "archive") &&
      previewsWorkers.some(
        (worker) =>
          worker.summon !== undefined && worker.summon.group === undefined,
      ) &&
      (await optionJobs.queue("emails").getJob(emailsJob.id))?.state ===
        "completed" &&
      (await optionJobs.queue("previews").getJob(loneJob.id))?.state ===
        "completed"
    );
  },
  WAIT,
);
/** The warnings the unit gives about other controllers on its queues. */
const overlapWarnings = () =>
  logged.filter(
    (event) =>
      event.level === "warn" &&
      (event.message.includes(`summoned by summon group "archive"`) ||
        event.message.includes(
          `naming no summon group while group "${SHARED.name}"'s`,
        )),
  );
const quiet = overlapWarnings().length;
const overlapChecks = [
  said(await optionUnit.check()),
  said(await optionUnit.check()),
];
const overlapStatus = await optionUnit.status();
show("two checks, and status().overlaps", {
  checks: overlapChecks,
  overlaps: overlapStatus.overlaps,
});
checkEqual(
  "two checks summon nothing (no work waits); status().overlaps lists archive, and GET /queues/thumbs/summon says the same",
  [
    overlapChecks,
    optionSpawn.calls.length,
    overlapStatus.overlaps,
    (await optionGet<SummonStatusDto>("/queues/thumbs/summon")).overlaps,
  ],
  [["none", "none"], 1, ["archive"], ["archive"]],
);
checkEqual(
  "one warning each, over two checks: archive's workers on thumbs, and a worker with no group on previews — which overlaps does not list",
  [
    quiet,
    overlapWarnings().map((event) => [event.message, event.fields.queue]),
  ],
  [
    0,
    [
      [
        `queue "thumbs" also has workers summoned by summon group "archive"'s shared unit: two controllers summoning for one queue can each start a unit for one backlog. Keep one summoning controller per queue`,
        "thumbs",
      ],
      [
        `queue "previews" has a summoned worker naming no summon group while group "media"'s shared unit serves the queue: a per-queue controller's unit, a unit from a build older than the group, or one this group summoned while it served a single queue (a one-queue summon names no group). Keep one summoning controller per queue`,
        "previews",
      ],
    ],
  ],
);
const lingering = [...archiveSpawn.started, ...loneSpawn.started];
for (const unit of lingering) {
  unit.child.kill("SIGTERM");
}
checkEqual(
  "both other units close on SIGTERM",
  await Promise.all(lingering.map(async (unit) => await unit.exited())),
  [0, 0],
);
await optionApi.close();

/* ------------------------------------------------------------------ */
step("13. POST /summon/groups/:group/reset closes the unit's own circuit");

/** Whether the summoner below rejects its credentials. */
let rejecting = true;
/** Every request it was handed. */
const circuitCalls: SummonRequest[] = [];
const circuitJobs = new BunJobs({
  namespace: exampleNamespace("summon-shared-group-reset"),
  driver,
  logger,
  summon: [
    {
      queues: [...MEDIA],
      group: SHARED,
      ...ONE_SHOT,
      summoner: defineSummoner({
        kind: KIND,
        invoke: async (request: SummonRequest) => {
          circuitCalls.push(request);
          if (rejecting) {
            throw new ProviderError("credentials rejected", "auth");
          }
          return { status: "started", handles: [] };
        },
      }),
    },
  ],
});
contexts.push(circuitJobs);
const circuitUnit = circuitJobs.summonController("thumbs");
await circuitJobs.queue("thumbs").add("work", {});
// An `auth` error opens the unit's circuit at once.
const rejected = [
  said(await circuitUnit.check()),
  said(await circuitUnit.check()),
];
/** The default actions plus `queues.summon`, which the group's reset needs. */
const SUMMON_ACTIONS: JobsApiAction[] = JOBS_API_ACTIONS.filter(
  (action) =>
    !JOBS_API_OPT_IN_ACTIONS.has(action) || action === "queues.summon",
);
const circuitApi = createJobsApi({
  jobs: circuitJobs,
  basePath: "/jobs-api",
  authorize: () => true,
  actions: SUMMON_ACTIONS,
});
const circuitAdapter = new BunHttpAdapter(0);
circuitAdapter.use(circuitApi.basePath, circuitApi.router);
/** The unit's status, as `GET /queues/previews/summon` answers it. */
const previewsStatus = async () =>
  (await (
    await circuitAdapter.fetch(`${circuitApi.basePath}/queues/previews/summon`)
  ).json()) as SummonStatusDto;
const opened = await previewsStatus();
show("the unit's failures and circuitOpenUntil, read through previews", {
  failures: opened.failures,
  circuitOpenUntil: opened.circuitOpenUntil,
});
checkEqual(
  "rejected credentials open the unit's circuit at once — counted as the default threshold, 5 failures — and any member's status shows it: one call, the next check held back",
  [
    rejected,
    circuitCalls.length,
    opened.failures,
    (opened.circuitOpenUntil ?? 0) > Date.now(),
  ],
  [["failed", "skipped circuit-open"], 1, 5, true],
);
const groupReset = await circuitAdapter.fetch(
  `${circuitApi.basePath}/summon/groups/${SHARED.name}/reset`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ circuit: true }),
  },
);
const reclosed = await previewsStatus();
rejecting = false;
checkEqual(
  `the group's reset with { "circuit": true } closes it: failures 0, no circuitOpenUntil, and the next check summons`,
  [
    groupReset.status,
    reclosed.failures,
    reclosed.circuitOpenUntil,
    said(await circuitUnit.check()),
    circuitCalls.length,
  ],
  [200, 0, undefined, "started", 2],
);
await circuitApi.close();

/* ------------------------------------------------------------------ */
step("14. A caller who may see only some of the unit's queues");

// A unit over the three queues whose first attempt is step 4's partial
// unit: workers on renders and previews, none on thumbs, which has the
// work. That leaves a failure on the unit (which a reset would clear and a
// "summon now" would add to) and a last outcome whose detail names thumbs.
// Later attempts start nothing.
/** Every request the unit's summoner was handed. */
const narrowCalls: SummonRequest[] = [];
/** The partial unit the first attempt started. */
const narrowUnits: ReturnType<typeof spawnUnit>[] = [];
const narrowJobs = new BunJobs({
  namespace: exampleNamespace("summon-shared-narrow"),
  driver,
  logger,
  summon: [
    {
      queues: [...MEDIA],
      group: SHARED,
      ...ONE_SHOT,
      bootBudget: 1_000,
      summoner: defineSummoner({
        kind: "example-spawn",
        invoke: async (request: SummonRequest) => {
          narrowCalls.push(request);
          if (narrowCalls.length === 1) {
            narrowUnits.push(
              spawnUnit(PARTIAL_ENTRY, request.argv, {
                PARTIAL_QUEUES: PARTIAL.join(","),
              }),
            );
          }
          return { status: "started", handles: [] };
        },
      }),
    },
  ],
});
contexts.push(narrowJobs);
const narrowUnit = narrowJobs.summonController("renders");
await narrowJobs.queue("thumbs").add("work", {});
await narrowUnit.check();
const narrowFirst = narrowCalls[0]?.id;
await waitFor(
  "the partial attempt to settle",
  async () => {
    await narrowUnit.check();
    const { last } = await narrowUnit.status();
    return last?.id === narrowFirst && last.outcome !== "started";
  },
  WAIT,
);
narrowUnits[0]!.child.kill("SIGTERM");
await narrowUnits[0]!.exited();

/** One `authorize` call, as the host saw it. */
interface Asked {
  /** The action asked about. */
  action: string;
  /** The queue it targets, if any. */
  queue?: string;
  /** The socket channel it is for, if any. */
  channel?: string;
  /** The route's path, for an HTTP decision. */
  route?: string;
}
/** Every `authorize` call the API below made, in order. */
const hostAsked: Asked[] = [];
/** What a host answers about `queue` for `action`: thumbs is hidden from this caller. */
type Answer = (
  action: string,
  queue: string | undefined,
) => boolean | { allow: false; status: 401 | 403 };
/** This caller may read, summon and follow renders and previews, never thumbs; anything else is allowed. */
const narrowed: Answer = (action, queue) =>
  queue !== "thumbs" ||
  !["queues.read", "queues.summon", "events.subscribe"].includes(action);

/** An API over the unit's context, deciding by `answer` and recording every call. */
function narrowApi(answer: Answer) {
  const api = createJobsApi({
    jobs: narrowJobs,
    basePath: "/jobs-api",
    actions: SUMMON_ACTIONS,
    authorize: (_req, ctx: JobsApiAuthorizeContext) => {
      hostAsked.push({
        action: ctx.action,
        ...(ctx.queue === undefined ? {} : { queue: ctx.queue }),
        ...(ctx.channel === undefined ? {} : { channel: ctx.channel }),
        ...(ctx.route === undefined ? {} : { route: ctx.route.path }),
      });
      return answer(ctx.action, ctx.queue);
    },
  });
  const adapter = new BunHttpAdapter(0);
  adapter.use(api.basePath, api.router);
  /** One request, answered as status and parsed body. */
  const call = async (method: "GET" | "POST", path: string) => {
    const response = await adapter.fetch(`${api.basePath}${path}`, {
      method,
      ...(method === "POST"
        ? { headers: { "content-type": "application/json" }, body: "{}" }
        : {}),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, any>,
    };
  };
  return { api, adapter, call };
}
/** The `queues.summon` questions asked from call `from` up to `to`, as [route, queue]. */
const summonAsks = (from: number, to?: number) =>
  hostAsked
    .slice(from, to)
    .filter((one) => one.action === "queues.summon")
    .map((one) => [one.route, one.queue]);

const narrow = narrowApi(narrowed);
const narrowList = (await narrow.call("GET", "/summon")).body as SummonListDto;
// The first readable member: thumbs is left out of queues, and queue is the
// first of those left. Asked about previews, the caller may also read
// renders, which comes before previews in the unit's order — so the queue
// it is told is renders, not the previews it asked about.
const viaPreviews = (await narrow.call("GET", "/queues/previews/summon"))
  .body as SummonStatusDto;
checkEqual(
  "GET /summon and GET /queues/previews/summon name only the queues the caller may read, queue the first of them: renders",
  [
    narrowList.controllers.map((item) => [item.queue, item.queues]),
    [viaPreviews.queue, viaPreviews.queues],
  ],
  [
    [["renders", ["renders", "previews"]]],
    ["renders", ["renders", "previews"]],
  ],
);
// The partial: detail names the queues with no worker that the caller may
// read: thumbs was the only one, so the caller reads a bare "partial".
checkEqual(
  "the last outcome's partial:thumbs reaches this caller as a bare partial, in the list and the status",
  [
    (await narrowUnit.status()).last?.detail,
    narrowList.controllers[0]?.last?.detail,
    viaPreviews.last?.detail,
  ],
  [`partial:${MISSING.join(",")}`, "partial", "partial"],
);
const viaThumbs = await narrow.call("GET", "/queues/thumbs/summon");
checkEqual(
  "GET /queues/thumbs/summon is refused like any queue the caller may not read",
  [viaThumbs.status, viaThumbs.body.code],
  [403, "FORBIDDEN"],
);

// A shared unit's "summon now" and reset act for every queue it serves, so
// the caller needs queues.summon on each. The route's own queue is asked
// first; then every other member, in code-point order, each one even after
// a refusal; the first refusal in that order is the answer, and nothing
// runs.
/** The unit's state, as far as a check or a reset would change it. */
const unitState = async () => {
  const { failures, last, pending, budget } = await narrowUnit.status();
  return { failures, last, pending, hour: budget?.hour, day: budget?.day };
};
const beforeRefusal = await unitState();
const summonFrom = hostAsked.length;
const refusedSummon = await narrow.call("POST", "/queues/renders/summon");
const resetFrom = hostAsked.length;
const refusedReset = await narrow.call("POST", "/queues/renders/summon/reset");
show("POST /queues/renders/summon, refused", refusedSummon);
checkEqual(
  "POST /queues/renders/summon and its reset are 403 FORBIDDEN with the default message, naming no queue",
  [refusedSummon, refusedReset].map((answer) => [
    answer.status,
    answer.body.code,
    answer.body.detail,
    JSON.stringify(answer.body).includes("thumbs"),
  ]),
  [403, 403].map(() => [
    403,
    "FORBIDDEN",
    "Not allowed to perform this action",
    false,
  ]),
);
checkEqual(
  "nothing ran: no second call to the platform, and the unit's one failure, its last outcome and budget as they were",
  [narrowCalls.length, beforeRefusal.failures, await unitState()],
  [1, 1, beforeRefusal],
);
checkEqual(
  "queues.summon was asked of renders, the route's queue, then of previews and thumbs in code-point order: every member",
  [summonAsks(summonFrom, resetFrom), summonAsks(resetFrom)],
  [
    [
      ["/queues/:queue/summon", "renders"],
      ["/queues/:queue/summon", "previews"],
      ["/queues/:queue/summon", "thumbs"],
    ],
    [
      ["/queues/:queue/summon/reset", "renders"],
      ["/queues/:queue/summon/reset", "previews"],
      ["/queues/:queue/summon/reset", "thumbs"],
    ],
  ],
);

// Two refusals: 401 on renders, 403 on previews. On thumbs' route, thumbs
// is asked first and allowed; previews sorts before renders, so its 403 is
// the first refusal and the answer, though renders comes first in the
// unit's order and its 401 is asked too.
const twoRefusals = narrowApi((action, queue) =>
  action !== "queues.summon"
    ? true
    : queue === "renders"
      ? { allow: false, status: 401 }
      : queue === "previews"
        ? { allow: false, status: 403 }
        : true,
);
const orderFrom = hostAsked.length;
const ordered = await twoRefusals.call("POST", "/queues/thumbs/summon");
checkEqual(
  "with 401 on renders and 403 on previews, POST /queues/thumbs/summon asks thumbs, previews, renders, and answers previews' 403",
  [
    summonAsks(orderFrom).map(([, queue]) => queue),
    ordered.status,
    ordered.body.code,
    narrowCalls.length,
  ],
  [["thumbs", "previews", "renders"], 403, "FORBIDDEN", 1],
);
await twoRefusals.api.close();
await twoRefusals.adapter.close();

// The socket: a subscriber on renders' channel who may not follow thumbs.
// Before the unit's event goes out on queue/renders, authorize is asked
// events.subscribe about each other member with that channel; the event
// names only the members allowed.
narrow.api.websocket!.attach(narrow.adapter);
const narrowServer = await narrow.adapter.listen(0);
const client = await connectJobsSocket(
  `ws://127.0.0.1:${narrowServer.port}${narrow.api.websocket!.path}`,
);
try {
  await client.next("hello");
  client.send({ op: "subscribe", id: "s1", channels: ["queue/renders"] });
  await client.next("ack", (ack) => ack.id === "s1");
  const socketFrom = hostAsked.length;
  const started = await narrowUnit.check();
  const frame = await client.next(
    "event",
    (candidate) =>
      candidate.event.type === "summon" &&
      (candidate.event.payload as SummonEventPayload).id ===
        (started.action === "summoned" ? started.id : undefined),
  );
  show("the summon event on queue/renders", frame.event.payload);
  checkEqual(
    "the event names renders and previews, and thumbs nowhere",
    [
      (frame.event.payload as SummonEventPayload).queues,
      JSON.stringify(frame).includes("thumbs"),
    ],
    [["renders", "previews"], false],
  );
  checkEqual(
    "authorize was asked events.subscribe about each other member, with the channel and that queue",
    hostAsked
      .slice(socketFrom)
      .filter((one) => one.action === "events.subscribe")
      .map((one) => [one.channel, one.queue])
      .sort(),
    [
      ["queue/renders", "previews"],
      ["queue/renders", "thumbs"],
    ],
  );
} finally {
  client.close();
}
await narrow.api.close();
await narrow.adapter.close();

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
