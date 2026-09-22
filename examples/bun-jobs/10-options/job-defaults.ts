/**
 * Option tour: queue job defaults — a stored override every producer adds
 * under, the bounded rewrite of jobs already pending, and the four API routes
 * that drive both. Every member called, every refusal provoked.
 *
 * ```bash
 * bun 10-options/job-defaults.ts
 * EXAMPLE_DRIVER=sqlite bun 10-options/job-defaults.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 bun 10-options/job-defaults.ts
 * ```
 *
 * What is worth knowing before reading the checks:
 *
 * - **Precedence, highest first, key by key:** an option passed on the job's
 *   own `add()`; the stored override; a `define()` definition's options; the
 *   queue's `defaultJobOptions`; the built-ins. The override beats `define()`
 *   — only `add()` wins over it — and each key is replaced whole, so an
 *   override's `backoff` replaces the code's whole object.
 * - **Writes are a merge patch.** `null` clears one key; `resetJobDefaults()`
 *   stores an *empty* override rather than deleting it, so `seq` keeps rising.
 *   A write with a stale `expectedSeq` changes nothing and answers
 *   `contended: true` — it does not throw (the API turns it into 409
 *   `CONTROL_CONTENDED`).
 * - **Propagation** is `jobDefaultsRefreshInterval` (1 000 ms by default):
 *   the writer sees its change at once, another producer within that plus one
 *   read, and one built with `0` on its very next add.
 * - **Every new job records which options its `add()` passed** —
 *   `opts.explicit`, key names in the API. A job added before this version
 *   has no record at all, which is not the same as `[]`.
 * - **`applyJobDefaults()` rewrites the backlog** one bounded call at a time
 *   (loop on `next`). It walks `waiting`, `delayed`, `failed` and
 *   `waiting-children`, never `active`, `completed` or `dead`; it never writes
 *   a key the job's `add()` passed; it skips a job with no record unless
 *   `includeUnmarked`; `dryRun` counts exactly and writes nothing. Lowering
 *   `attempts` below `attemptsMade` is written and counted `exhausted`: the
 *   job runs once more. Each call is pinned to `seq` —
 *   `JobDefaultsChangedError` when the override moved on — and the rewrite is
 *   irreversible: a later reset changes new jobs only.
 * - **The API's writes are opt-in.** `queues.defaults` (save and reset) and
 *   `queues.applyDefaults` (the rewrite, dry runs included) are off by
 *   default; only the GET is routed without them. `/meta.features` says
 *   whether the backend can hold an override (`jobDefaults`) and rewrite with
 *   it (`jobDefaultsApply`); both are false in `runner` mode.
 */
import type {
  ApplyJobDefaultsOptions,
  ApplyJobDefaultsResult,
  Job,
  JobsDriver,
  StoredJobOptions,
} from "@kingsleyweb/bun-jobs";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  createDriver,
  createJobsApi,
  DEFAULT_JOB_DEFAULTS_REFRESH_MS,
  DEFAULT_JOBS_API_LIMITS,
  explicitKeys,
  JOB_DEFAULT_BACKOFF_TYPES,
  JOB_DEFAULT_KEYS,
  JOB_DEFAULTS_APPLY_STATES,
  JOB_DEFAULTS_BOUNDS,
  JobDefaultsChangedError,
  JOBS_API_ACTIONS,
  JOBS_API_OPT_IN_ACTIONS,
  readJobDefaults,
  supportsJobDefaults,
} from "@kingsleyweb/bun-jobs";
import {
  exampleBackend,
  exampleDriver,
  exampleNamespace,
} from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Option tour: queue job defaults");

/** Generous ceiling for anything a busy machine might slow down. */
const WAIT = { timeout: 30_000, interval: 10 };

/** One driver for the whole tour, shared by every queue, worker and API. */
const driver = createDriver(exampleDriver());
await driver.connect();

/** This run's namespace; each section takes its own under it. */
const base = exampleNamespace("tour-jdef");

/** Every namespace the tour wrote to, purged — exactly these — at the end. */
const namespaces = new Set<string>();

/** Everything to close at the end, in reverse order of opening. */
const closers: (() => Promise<unknown>)[] = [];

/** The namespace of one section, recorded for cleanup. */
function ns(section: string): string {
  const name = `${base}-${section}`;
  namespaces.add(name);
  return name;
}

/** A `BunQueue` on the tour's driver (or `on`), closed at the end. */
function queueIn(
  namespace: string,
  name: string,
  options: {
    /** `BunQueueOptions.defaultJobOptions`. */
    defaults?: ConstructorParameters<typeof BunQueue>[1]["defaultJobOptions"];
    /** `BunQueueOptions.jobDefaultsRefreshInterval`. */
    refresh?: number;
    /** A driver to use instead of the tour's (a proxy hiding methods). */
    on?: JobsDriver;
  } = {},
): BunQueue {
  const queue = new BunQueue(name, {
    namespace,
    driver: options.on ?? driver,
    logger: noopLogger,
    ...(options.defaults === undefined
      ? {}
      : { defaultJobOptions: options.defaults }),
    ...(options.refresh === undefined
      ? {}
      : { jobDefaultsRefreshInterval: options.refresh }),
  });
  closers.push(async () => await queue.close());
  return queue;
}

/** A worker on the tour's driver, started, force-closed at the end. */
function workerIn(
  namespace: string,
  name: string,
  processor: (job: Job) => Promise<unknown>,
): BunQueueWorker {
  const worker = new BunQueueWorker(name, processor, {
    namespace,
    driver,
    logger: noopLogger,
    pollInterval: 10,
    concurrency: 1,
    jobDefaultsRefreshInterval: 0,
  });
  closers.push(async () => await worker.close({ force: true }));
  void worker.run();
  return worker;
}

/** A job's stored options, with the explicit mask its public type leaves out. */
function optsOf(job: { opts: unknown }): StoredJobOptions {
  return job.opts as StoredJobOptions;
}

/** Which options a job's `add()` passed, as the API names them; `undefined` without a record. */
function explicitOf(job: { opts: unknown }): string[] | undefined {
  return explicitKeys(optsOf(job).explicit);
}

/** A job read back from the backend, which must exist. */
async function reread(queue: BunQueue, id: string): Promise<Job> {
  const job = await queue.getJob(id);
  if (!job) {
    throw new Error(`job ${id} vanished`);
  }
  return job;
}

/**
 * A job as an older bun-jobs would have stored it: the same record without
 * `opts.explicit`. Written through the driver because no current producer
 * can make one — that is the point of the record.
 */
async function addUnmarked(queue: BunQueue, name: string): Promise<string> {
  const job = await queue.add(name, {});
  const record = (await driver.getJob(queue.ref, job.id))!;
  const { explicit: _explicit, ...unmarked } = record.opts as StoredJobOptions;
  await driver.removeJob(queue.ref, job.id);
  await driver.addJob(queue.ref, { ...record, opts: unmarked });
  return job.id;
}

/** The six counts of a rewrite, summed over the calls of one walk. */
type Totals = Pick<
  ApplyJobDefaultsResult,
  | "examined"
  | "rewritten"
  | "unchanged"
  | "skippedExplicit"
  | "skippedUnmarked"
  | "exhausted"
>;

/**
 * A whole walk: one bounded `applyJobDefaults()` call after another, each
 * resuming at the previous `next`, until it is `null`. Answers the summed
 * counts and how many calls it took.
 */
async function walk(
  queue: BunQueue,
  options: Omit<ApplyJobDefaultsOptions, "cursor">,
): Promise<{ totals: Totals; calls: number; moved: number }> {
  return await walkFrom(queue, options, null);
}

/** {@link walk}, resuming at `start` — a cursor an earlier call answered. */
async function walkFrom(
  queue: BunQueue,
  options: Omit<ApplyJobDefaultsOptions, "cursor">,
  start: string | null,
): Promise<{ totals: Totals; calls: number; moved: number }> {
  const totals: Totals = {
    examined: 0,
    rewritten: 0,
    unchanged: 0,
    skippedExplicit: 0,
    skippedUnmarked: 0,
    exhausted: 0,
  };
  let cursor: string | null = start;
  let calls = 0;
  let moved = 0;
  do {
    const page: ApplyJobDefaultsResult = await queue.applyJobDefaults({
      ...options,
      cursor,
    });
    calls++;
    moved += page.moved;
    for (const key of Object.keys(totals) as (keyof Totals)[]) {
      totals[key] += page[key];
    }
    cursor = page.next;
  } while (cursor !== null);
  return { totals, calls, moved };
}

/**
 * A driver with some optional methods hidden, so a capability check sees what
 * a simpler backend looks like. Methods are bound to the real driver, so its
 * own state still works.
 */
function without(real: JobsDriver, methods: string[]): JobsDriver {
  return new Proxy(real, {
    get(target, property) {
      if (methods.includes(property as string)) {
        return undefined;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** What one request through a mounted API answered. */
interface Answer {
  /** The HTTP status. */
  status: number;
  /** The parsed JSON body, or `undefined` for an empty one. */
  body: any;
}

/** A management API over `jobs`, mounted at `/admin/jobs`, with a request helper. */
function mount(
  jobs: BunJobs,
  overrides: Partial<Parameters<typeof createJobsApi>[0]> = {},
) {
  const api = createJobsApi({
    jobs,
    basePath: "/admin/jobs",
    logger: noopLogger,
    limits: { queueCacheMs: 0 },
    authorize: () => true,
    ...overrides,
  });
  closers.push(async () => await api.close());
  const root = new BunRouter();
  root.use(api.basePath, api.router);

  /** Sends one request under the base path; anything but GET is JSON. */
  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Answer> => {
    const init: RequestInit = {
      method,
      headers: method === "GET" ? {} : { "content-type": "application/json" },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const response = await root.fetch(`/admin/jobs${path}`, init);
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : undefined,
    };
  };

  /** The operation ids among the four job-defaults routes this API registered. */
  const defaultsRoutes = () =>
    api.routes
      .map((route) => route.operationId)
      .filter((id) => id.endsWith("JobDefaults"))
      .sort();

  return { api, call, defaultsRoutes };
}

/** A `BunJobs` on the tour's driver (or `on`), in its own namespace. */
function context(
  section: string,
  options: {
    /** `BunJobsConfig.defaultJobOptions`. */
    defaults?: ConstructorParameters<typeof BunJobs>[0]["defaultJobOptions"];
    /** A driver to use instead of the tour's. */
    on?: JobsDriver;
  } = {},
): BunJobs {
  const jobs = new BunJobs({
    namespace: ns(section),
    driver: options.on ?? driver,
    logger: noopLogger,
    ...(options.defaults === undefined
      ? {}
      : { defaultJobOptions: options.defaults }),
  });
  closers.push(async () => await jobs.close());
  return jobs;
}

show(`backend: ${exampleBackend()}`);

/* ------------------------------------------------------------------ */
step("The contract: editable keys, bounds, apply states");

checkEqual(
  "JOB_DEFAULT_KEYS: the eight editable options",
  [...JOB_DEFAULT_KEYS],
  [
    "attempts",
    "backoff",
    "timeout",
    "priority",
    "removeOnComplete",
    "removeOnFail",
    "keepLogs",
    "keepStacktraces",
  ],
);
checkEqual(
  "JOB_DEFAULT_BACKOFF_TYPES: only the two strategies every worker has",
  [...JOB_DEFAULT_BACKOFF_TYPES],
  ["fixed", "exponential"],
);
checkEqual(
  "JOB_DEFAULTS_APPLY_STATES: what apply walks",
  [...JOB_DEFAULTS_APPLY_STATES],
  ["waiting", "delayed", "failed", "waiting-children"],
);
checkEqual(
  "bounds: attempts 1–1000, keepLogs at least 1",
  [
    JOB_DEFAULTS_BOUNDS.attempts.min,
    JOB_DEFAULTS_BOUNDS.attempts.max,
    JOB_DEFAULTS_BOUNDS.keepLogs.min,
  ],
  [1, 1000, 1],
);
checkEqual(
  "DEFAULT_JOB_DEFAULTS_REFRESH_MS",
  DEFAULT_JOB_DEFAULTS_REFRESH_MS,
  1000,
);
check(
  `this backend (${driver.name}) can hold an override`,
  supportsJobDefaults(driver),
);

/* ------------------------------------------------------------------ */
step("Precedence: add() > override > define() > defaultJobOptions > built-ins");

{
  const jobs = context("precedence", { defaults: { attempts: 2 } });
  jobs.define("x", async () => null, { attempts: 3 });
  jobs.define("y", async () => null);
  const registry = jobs.queue("jobs");

  checkEqual(
    "before any override: x takes define()'s 3, y the queue's 2",
    [
      (await jobs.now("x", {})).opts.attempts,
      (await jobs.now("y", {})).opts.attempts,
    ],
    [3, 2],
  );

  await registry.setJobDefaults({ attempts: 5 });
  const defaulted = await jobs.now("x", {});
  checkEqual(
    "the override beats define(): add(x) gets 5",
    defaulted.opts.attempts,
    5,
  );
  checkEqual("and maxAttempts follows it", defaulted.maxAttempts, 5);
  checkEqual(
    "a definition's option is a default, not explicit",
    explicitOf(defaulted),
    [],
  );

  const passed = await jobs.now("x", {}, { attempts: 1 });
  checkEqual("only an explicit add() option wins: 1", passed.opts.attempts, 1);
  checkEqual("and it is recorded as explicit", explicitOf(passed), [
    "attempts",
  ]);
  checkEqual(
    "y, with no definition option, gets the override too",
    (await jobs.now("y", {})).opts.attempts,
    5,
  );

  await registry.setJobDefaults({ attempts: null });
  checkEqual(
    "clearing it with null: x back to 3, y back to 2",
    [
      (await jobs.now("x", {})).opts.attempts,
      (await jobs.now("y", {})).opts.attempts,
    ],
    [3, 2],
  );

  // Each key is replaced whole, never merged field by field.
  const whole = queueIn(ns("whole"), "q", {
    defaults: { backoff: { type: "exponential", delay: 100, max: 5_000 } },
  });
  await whole.setJobDefaults({ backoff: 250 });
  checkEqual(
    "an override's backoff replaces the code's whole object",
    (await whole.add("x", {})).opts.backoff,
    250,
  );
}

/* ------------------------------------------------------------------ */
step("get / set / reset: a merge patch, a rising seq");

{
  const queue = queueIn(ns("crud"), "q", {
    defaults: { attempts: 2, timeout: 1_000 },
  });

  const fresh = await queue.getJobDefaults();
  checkEqual(
    "nothing stored: seq 0, override {}, overridden []",
    [fresh.seq, fresh.override, fresh.overridden, fresh.updatedAt],
    [0, {}, [], undefined],
  );
  checkEqual(
    "code: defaultJobOptions over the built-ins",
    fresh.code.attempts,
    2,
  );
  checkEqual(
    "effective equals code while nothing is stored",
    fresh.effective,
    fresh.code,
  );
  checkEqual(
    "propagationMs is this queue's refresh interval",
    fresh.propagationMs,
    1000,
  );
  checkEqual(
    "queue.jobDefaultsRefreshInterval",
    queue.jobDefaultsRefreshInterval,
    1000,
  );

  const first = await queue.setJobDefaults(
    { attempts: 4, backoff: { type: "exponential", delay: 200, max: 10_000 } },
    { by: "ops@example" },
  );
  check("a first write stores a seq above 0", first.seq > 0, first.seq);
  checkEqual("contended: false", first.contended, false);
  checkEqual("overridden, in JOB_DEFAULT_KEYS order", first.overridden, [
    "attempts",
    "backoff",
  ]);
  check(
    "updatedAt is set",
    typeof first.updatedAt === "number",
    first.updatedAt,
  );
  checkEqual(
    "effective: the override over the code",
    [first.effective.attempts, first.effective.timeout],
    [4, 1000],
  );

  const merged = await queue.setJobDefaults({ timeout: 500 });
  checkEqual("a key left out is untouched: set merges", merged.override, {
    attempts: 4,
    backoff: { type: "exponential", delay: 200, max: 10_000 },
    timeout: 500,
  });
  check("each write raises seq", merged.seq > first.seq, [
    first.seq,
    merged.seq,
  ]);

  const cleared = await queue.setJobDefaults({ attempts: null });
  checkEqual("null clears one key", cleared.overridden, ["backoff", "timeout"]);
  checkEqual(
    "and the code's value applies again",
    cleared.effective.attempts,
    2,
  );

  const reset = await queue.resetJobDefaults();
  checkEqual(
    "reset: an empty override",
    [reset.override, reset.overridden],
    [{}, []],
  );
  check(
    "stored rather than deleted, so seq still rises",
    reset.seq > cleared.seq,
    [cleared.seq, reset.seq],
  );
  checkEqual(
    "getJobDefaults() re-reads what is stored",
    (await queue.getJobDefaults()).seq,
    reset.seq,
  );

  // `by` is stored beside the override. getJobDefaults() does not report it;
  // the exported readJobDefaults() does.
  await queue.setJobDefaults({ priority: 3 }, { by: "release-bot" });
  const raw = await readJobDefaults(driver, queue.ref);
  checkEqual(
    "readJobDefaults(): values, seq and by",
    [raw.values, raw.by],
    [{ priority: 3 }, "release-bot"],
  );
  check(
    "getJobDefaults() has no `by` field",
    !("by" in (await queue.getJobDefaults())),
  );
}

/* ------------------------------------------------------------------ */
step("Refusals: ConfigError before anything is written");

{
  const queue = queueIn(ns("refuse"), "q");
  const before = (await queue.setJobDefaults({ attempts: 3 })).seq;

  await checkRejects(
    "attempts: 0",
    () => queue.setJobDefaults({ attempts: 0 }),
    {
      name: "ConfigError",
      message: /attempts must be a whole number from 1 to 1000/,
    },
  );
  await checkRejects(
    "attempts: 1001",
    () => queue.setJobDefaults({ attempts: 1001 }),
    { name: "ConfigError" },
  );
  await checkRejects(
    'keepLogs: 0 ("keep every line" cannot be stored)',
    () => queue.setJobDefaults({ keepLogs: 0 }),
    { name: "ConfigError", message: /keepLogs/ },
  );
  await checkRejects(
    "backoff type other than fixed or exponential",
    () =>
      queue.setJobDefaults({
        backoff: { type: "custom" as "fixed", delay: 10 },
      }),
    {
      name: "ConfigError",
      message: /backoff.type must be one of fixed, exponential/,
    },
  );
  await checkRejects(
    "backoff.max below backoff.delay",
    () =>
      queue.setJobDefaults({
        backoff: { type: "fixed", delay: 500, max: 100 },
      }),
    {
      name: "ConfigError",
      message: /backoff.max must be at least backoff.delay/,
    },
  );
  await checkRejects(
    "a retention object with neither count nor ttl",
    () => queue.setJobDefaults({ removeOnComplete: {} }),
    { name: "ConfigError", message: /needs a count, a ttl, or both/ },
  );
  await checkRejects(
    "priority outside ±1048576",
    () => queue.setJobDefaults({ priority: 2_000_000 }),
    { name: "ConfigError" },
  );
  await checkRejects(
    "a key that is not editable",
    () => queue.setJobDefaults({ delay: 5 } as never),
    { name: "ConfigError", message: /"delay" is not an editable job option/ },
  );
  await checkRejects(
    "one bad key refuses the whole update",
    () => queue.setJobDefaults({ timeout: 100, attempts: 0 }),
    { name: "ConfigError" },
  );
  const after = await queue.getJobDefaults();
  checkEqual(
    "nothing was written by any of them",
    [after.seq, after.override],
    [before, { attempts: 3 }],
  );

  await checkRejects(
    "BunQueue jobDefaultsRefreshInterval: -1",
    () =>
      new BunQueue("q", {
        namespace: ns("refuse"),
        driver,
        jobDefaultsRefreshInterval: -1,
      }),
    { name: "ConfigError", message: /jobDefaultsRefreshInterval/ },
  );
  await checkRejects(
    "BunQueueWorker jobDefaultsRefreshInterval: 1.5",
    () =>
      new BunQueueWorker("q", async () => null, {
        namespace: ns("refuse"),
        driver,
        jobDefaultsRefreshInterval: 1.5,
      }),
    { name: "ConfigError", message: /jobDefaultsRefreshInterval/ },
  );
}

/* ------------------------------------------------------------------ */
step("expectedSeq: a stale write answers contended, it does not throw");

{
  const namespace = ns("cas");
  const alice = queueIn(namespace, "q");
  const bob = queueIn(namespace, "q");

  const empty = await alice.setJobDefaults({ attempts: 2 }, { expectedSeq: 0 });
  checkEqual(
    'expectedSeq: 0 means "nothing stored yet"',
    empty.contended,
    false,
  );

  const { seq } = await alice.getJobDefaults();
  await bob.setJobDefaults({ attempts: 9 });

  const stale = await alice.setJobDefaults(
    { attempts: 4 },
    { expectedSeq: seq },
  );
  checkEqual("the stale write: contended, not thrown", stale.contended, true);
  checkEqual("answering what the other writer stored", stale.override, {
    attempts: 9,
  });
  check("and seq is the other writer's", stale.seq > seq, [seq, stale.seq]);

  const staleReset = await alice.resetJobDefaults({ expectedSeq: seq });
  checkEqual("a stale reset is contended too", staleReset.contended, true);
  checkEqual("and changed nothing", (await bob.getJobDefaults()).override, {
    attempts: 9,
  });

  const current = await alice.setJobDefaults(
    { attempts: 4 },
    { expectedSeq: stale.seq },
  );
  checkEqual(
    "with the current seq it goes through",
    [current.contended, current.override],
    [false, { attempts: 4 }],
  );
}

/* ------------------------------------------------------------------ */
step("Propagation: the writer at once, a producer within its interval");

{
  const namespace = ns("propagate");
  const operator = queueIn(namespace, "q");
  const eager = queueIn(namespace, "q", { refresh: 0 });
  const cached = queueIn(namespace, "q");

  // Both producers read once, so the cached one holds a fresh read.
  await eager.add("x", {});
  await cached.add("x", {});

  const changedAt = Date.now();
  await operator.setJobDefaults({ attempts: 6 });
  checkEqual(
    "the writing instance uses it at once",
    (await operator.add("x", {})).opts.attempts,
    6,
  );
  checkEqual(
    "jobDefaultsRefreshInterval: 0 sees it on its next add",
    (await eager.add("x", {})).opts.attempts,
    6,
  );
  checkEqual(
    "the default producer, inside its interval, still adds the old value",
    (await cached.add("x", {})).opts.attempts,
    1,
  );
  await waitFor(
    "the default producer to pick the change up",
    async () => (await cached.add("x", {})).opts.attempts === 6,
    { timeout: 5_000, interval: 50 },
  );
  const took = Date.now() - changedAt;
  check("within about a second (the interval plus one read)", took < 1_800, {
    took,
  });

  // addBulk reads at most once for the whole call.
  const bulk = await cached.addBulk(
    Array.from({ length: 5 }, (_, i) => ({ name: "x", data: { i } })),
  );
  check(
    "addBulk: every entry under the same override",
    bulk.every((job) => job.opts.attempts === 6),
    bulk.map((job) => job.opts.attempts),
  );
}

/* ------------------------------------------------------------------ */
step("A driver without queue state, or without rewritePendingOptions");

{
  const stateless = without(driver, ["getQueueState", "setQueueState"]);
  check("supportsJobDefaults() is false", !supportsJobDefaults(stateless));
  const queue = queueIn(ns("nostate"), "q", { on: stateless });

  const info = await queue.getJobDefaults();
  checkEqual(
    "get still answers: seq 0, override {}",
    [info.seq, info.override],
    [0, {}],
  );
  await checkRejects("set", () => queue.setJobDefaults({ attempts: 2 }), {
    name: "NotSupportedError",
  });
  await checkRejects("reset", () => queue.resetJobDefaults(), {
    name: "NotSupportedError",
  });
  await checkRejects("apply", () => queue.applyJobDefaults({ seq: 0 }), {
    name: "NotSupportedError",
  });
  checkEqual(
    "and adding works as before",
    (await queue.add("x", {})).opts.attempts,
    1,
  );

  const noRewrite = without(driver, ["rewritePendingOptions"]);
  const saving = queueIn(ns("norewrite"), "q", { on: noRewrite });
  const { seq } = await saving.setJobDefaults({ attempts: 3 });
  checkEqual(
    "without the rewrite, saving works",
    (await saving.add("x", {})).opts.attempts,
    3,
  );
  const refused = await checkRejects(
    "and only apply is refused",
    () => saving.applyJobDefaults({ seq }),
    { name: "NotSupportedError" },
  );
  checkEqual(
    "naming the missing method",
    (refused as { context?: { method?: string } } | undefined)?.context?.method,
    "rewritePendingOptions",
  );
}

/* ------------------------------------------------------------------ */
step("The apply walk: states, keys, the explicit record, dry run first");

/** The main walk's queue, reused by the irreversibility step. */
const backlog = queueIn(ns("walk"), "q");
/** Ids of the main walk's jobs, by role. */
const ids: Record<string, string> = {};

{
  // Added before the override exists, so everything they did not pass is a
  // default the walk may replace.
  ids.plain = (await backlog.add("plain", {})).id;
  ids.priority = (await backlog.add("prio", {}, { priority: 9 })).id;
  ids.delayed = (await backlog.add("later", {}, { delay: 60_000 })).id;
  const flow = await backlog.addFlow({
    name: "parent",
    data: {},
    children: [{ name: "child", data: {} }],
  });
  ids.parent = flow.job.id;
  ids.child = flow.children![0]!.job.id;
  ids.legacy = await addUnmarked(backlog, "legacy");

  const saved = await backlog.setJobDefaults({ attempts: 5, timeout: 3_000 });
  // Added after the save: they already carry the override.
  ids.after = (await backlog.add("after", {})).id;
  ids.onlyExplicit = (await backlog.add("pinned", {}, { attempts: 2 })).id;

  checkEqual(
    "the flow's parent waits for its child",
    (await reread(backlog, ids.parent)).state,
    "waiting-children",
  );
  checkEqual(
    "opts.explicit: a plain add passed nothing",
    explicitOf(await reread(backlog, ids.plain)),
    [],
  );
  checkEqual(
    "opts.explicit: the keys add() passed",
    explicitOf(await reread(backlog, ids.priority)),
    ["priority"],
  );
  checkEqual(
    "opts.explicit: absent on a job from before the record",
    explicitOf(await reread(backlog, ids.legacy)),
    undefined,
  );
  checkEqual(
    "pending jobs keep what they were given until apply",
    (await reread(backlog, ids.plain)).opts.attempts,
    1,
  );

  const narrowed = await backlog.applyJobDefaults({
    seq: saved.seq,
    states: ["delayed"],
    dryRun: true,
  });
  checkEqual(
    "states narrows the walk: only the delayed job",
    [narrowed.examined, narrowed.rewritten, narrowed.next],
    [1, 1, null],
  );
  const onlyTimeout = await backlog.applyJobDefaults({
    seq: saved.seq,
    keys: ["timeout"],
    dryRun: true,
  });
  checkEqual("keys narrows what is written", onlyTimeout.keys, ["timeout"]);

  const dry = await walk(backlog, { seq: saved.seq, limit: 2, dryRun: true });
  const expected: Totals = {
    examined: 8,
    rewritten: 5,
    unchanged: 1,
    skippedExplicit: 1,
    skippedUnmarked: 1,
    exhausted: 0,
  };
  checkEqual(
    "the dry run's counts, summed over its calls",
    dry.totals,
    expected,
  );
  check("limit 2 over 8 jobs took several calls", dry.calls >= 4, dry.calls);
  checkEqual(
    "and it wrote nothing",
    (await reread(backlog, ids.plain)).opts.attempts,
    1,
  );

  const real = await walk(backlog, { seq: saved.seq, limit: 2 });
  checkEqual(
    "the real walk counts exactly what the dry run did",
    real.totals,
    dry.totals,
  );
  show(`moved (a lower bound; 0 on memory and SQL): ${real.moved}`);

  const plain = await reread(backlog, ids.plain);
  checkEqual(
    "a defaulted waiting job: rewritten, maxAttempts too",
    [plain.opts.attempts, plain.opts.timeout, plain.maxAttempts],
    [5, 3000, 5],
  );
  const kept = await reread(backlog, ids.priority);
  checkEqual(
    "an explicit priority is kept; the new attempts is written",
    [kept.opts.priority, kept.opts.attempts],
    [9, 5],
  );
  checkEqual(
    "the delayed job, the waiting-children parent and its child",
    [
      (await reread(backlog, ids.delayed)).opts.attempts,
      (await reread(backlog, ids.parent)).opts.attempts,
      (await reread(backlog, ids.child)).opts.attempts,
    ],
    [5, 5, 5],
  );
  checkEqual(
    "the job whose only changing key is explicit keeps it (skippedExplicit)",
    (await reread(backlog, ids.onlyExplicit)).opts.attempts,
    2,
  );
  checkEqual(
    "the unmarked job is left alone (skippedUnmarked)",
    (await reread(backlog, ids.legacy)).opts.attempts,
    1,
  );
  checkEqual(
    "rewriting leaves the explicit record as it was",
    explicitOf(await reread(backlog, ids.plain)),
    [],
  );

  const again = await backlog.applyJobDefaults({ seq: saved.seq });
  checkEqual(
    "a second walk finds nothing left to write",
    [again.rewritten, again.unchanged, again.next],
    [0, 6, null],
  );

  const included = await backlog.applyJobDefaults({
    seq: saved.seq,
    includeUnmarked: true,
  });
  checkEqual(
    "includeUnmarked: the older job is rewritten too",
    [included.rewritten, included.skippedUnmarked],
    [1, 0],
  );
  const legacy = await reread(backlog, ids.legacy);
  checkEqual(
    "treating all of it as defaulted, without inventing a record",
    [legacy.opts.attempts, explicitOf(legacy)],
    [5, undefined],
  );
}

/* ------------------------------------------------------------------ */
step("Apply refusals");

{
  const queue = queueIn(ns("apply-refuse"), "q");
  await queue.add("x", {});
  const { seq } = await queue.setJobDefaults({ attempts: 2 });

  await checkRejects("seq: -1", () => queue.applyJobDefaults({ seq: -1 }), {
    name: "ConfigError",
    message: /seq must be a whole number/,
  });
  await checkRejects("seq: 1.5", () => queue.applyJobDefaults({ seq: 1.5 }), {
    name: "ConfigError",
  });
  await checkRejects(
    "keys naming a key the override does not set",
    () => queue.applyJobDefaults({ seq, keys: ["timeout"] }),
    { name: "ConfigError", message: /do not override "timeout"/ },
  );
  await checkRejects(
    "keys naming a key that is not editable",
    () => queue.applyJobDefaults({ seq, keys: ["delay" as never] }),
    { name: "ConfigError", message: /not an editable job option/ },
  );
  await checkRejects(
    "a repeated state",
    () => queue.applyJobDefaults({ seq, states: ["waiting", "waiting"] }),
    { name: "ConfigError", message: /without repeats/ },
  );
  await checkRejects(
    "a cursor this walk did not issue",
    () => queue.applyJobDefaults({ seq, cursor: "not-a-cursor" }),
    { name: "ConfigError", message: /cursor is not one this walk issued/ },
  );
  checkEqual(
    "none of them wrote anything",
    (await queue.list("waiting"))[0]!.opts.attempts,
    1,
  );
}

/* ------------------------------------------------------------------ */
step("A cursor belongs to one walk: queue, seq, states and keys");

{
  const namespace = ns("cursor");
  const a = queueIn(namespace, "a");
  const b = queueIn(namespace, "b");
  await a.addBulk(Array.from({ length: 4 }, () => ({ name: "x", data: {} })));
  await b.addBulk(Array.from({ length: 4 }, () => ({ name: "x", data: {} })));
  const seqA = (await a.setJobDefaults({ attempts: 3, timeout: 500 })).seq;
  const seqB = (await b.setJobDefaults({ attempts: 3 })).seq;

  const firstPage = await a.applyJobDefaults({ seq: seqA, limit: 2 });
  const cursor = firstPage.next!;
  checkEqual(
    "a's first page: two rewritten, a cursor for the rest",
    [firstPage.rewritten, typeof cursor],
    [2, "string"],
  );

  const foreign = await checkRejects(
    "b resuming at a's cursor",
    () => b.applyJobDefaults({ seq: seqB, cursor }),
    { name: "ConfigError", message: /^this cursor belongs to another walk$/ },
  );
  checkEqual(
    "context: this walk's queue and seq, and the cursor's",
    (foreign as { context?: unknown } | undefined)?.context,
    { queue: "b", seq: seqB, cursorQueue: "a", cursorSeq: seqA },
  );
  checkEqual(
    "and b was not touched",
    (await b.list("waiting")).map((job) => job.opts.attempts),
    [1, 1, 1, 1],
  );
  await checkRejects(
    "a's cursor with other states",
    () => a.applyJobDefaults({ seq: seqA, cursor, states: ["waiting"] }),
    { name: "ConfigError", message: /belongs to another walk/ },
  );
  await checkRejects(
    "a's cursor with other keys",
    () => a.applyJobDefaults({ seq: seqA, cursor, keys: ["attempts"] }),
    { name: "ConfigError", message: /belongs to another walk/ },
  );

  const rest = await walkFrom(a, { seq: seqA, limit: 2 }, cursor);
  checkEqual(
    "resuming its own walk with its own cursor finishes it",
    [firstPage.rewritten + rest.totals.rewritten, rest.totals.examined],
    [4, 2],
  );
  checkEqual(
    "every job of a rewritten exactly once",
    (await a.list("waiting")).map((job) => job.opts.attempts),
    [3, 3, 3, 3],
  );

  // The same queue and override keys, but a newer version: the old cursor
  // was issued for seqA, and the walk now applies seqA2.
  const seqA2 = (await a.setJobDefaults({ attempts: 4 })).seq;
  const stale = await checkRejects(
    "a cursor issued for another seq",
    () => a.applyJobDefaults({ seq: seqA2, cursor }),
    { name: "ConfigError", message: /belongs to another walk/ },
  );
  const staleContext = (
    stale as { context?: { seq?: number; cursorSeq?: number } } | undefined
  )?.context;
  checkEqual(
    "naming both versions",
    [staleContext?.seq, staleContext?.cursorSeq],
    [seqA2, seqA],
  );
}

/* ------------------------------------------------------------------ */
step("A priority change reorders the backlog, FIFO among equals");

{
  const namespace = ns("reorder");
  const queue = queueIn(namespace, "q");
  const a = await queue.add("a", {});
  const b = await queue.add("b", {}, { priority: 3 });
  const c = await queue.add("c", {});
  const { seq } = await queue.setJobDefaults({ priority: 5 });
  await walk(queue, { seq });
  checkEqual(
    "the defaulted jobs take priority 5; the explicit 3 stays",
    [
      (await reread(queue, a.id)).priority,
      (await reread(queue, b.id)).priority,
      (await reread(queue, c.id)).priority,
    ],
    [5, 3, 5],
  );

  const order: string[] = [];
  workerIn(namespace, "q", async (job) => {
    order.push(job.name);
    return null;
  });
  await waitFor("all three to run", () => order.length === 3, WAIT);
  checkEqual("claimed b (3) first, then a and c in the order added", order, [
    "b",
    "a",
    "c",
  ]);
}

/* ------------------------------------------------------------------ */
step("exhausted: attempts lowered below attemptsMade — it runs once more");

{
  const namespace = ns("exhausted");
  // A second between attempts, so the job sits in `failed` (retry pending)
  // long enough to be rewritten there.
  const queue = queueIn(namespace, "q", {
    defaults: { attempts: 5, backoff: 1_000 },
  });
  const job = await queue.add("flaky", {});

  let ran = 0;
  const first = workerIn(namespace, "q", async () => {
    ran++;
    throw new Error("still failing");
  });
  let retries = 0;
  let closed = false;
  first.on("closed", () => {
    closed = true;
  });
  first.on("retrying", () => {
    retries++;
    if (retries === 2) {
      void first.close({ force: true });
    }
  });
  await waitFor("two failed attempts", () => retries === 2, WAIT);
  await waitFor("the worker to close", () => closed, WAIT);
  await waitFor(
    "the retry to be recorded",
    async () => (await reread(queue, job.id)).attemptsMade === 2,
    WAIT,
  );
  const failed = await reread(queue, job.id);
  checkEqual(
    "failed, retry pending, after 2 of 5 attempts",
    [failed.state, failed.attemptsMade, failed.maxAttempts],
    ["failed", 2, 5],
  );

  const { seq } = await queue.setJobDefaults({ attempts: 1 });
  const applied = await queue.applyJobDefaults({ seq });
  checkEqual(
    "written, not clamped: counted exhausted, inside rewritten",
    [applied.rewritten, applied.exhausted],
    [1, 1],
  );
  checkEqual(
    "maxAttempts is now 1",
    (await reread(queue, job.id)).maxAttempts,
    1,
  );

  let died = false;
  const second = workerIn(namespace, "q", async () => {
    ran++;
    throw new Error("failing once more");
  });
  second.on("dead", () => {
    died = true;
  });
  await waitFor("the job to die", () => died, WAIT);
  const dead = await reread(queue, job.id);
  checkEqual(
    "it ran once more, then died",
    [ran, dead.state, dead.attemptsMade],
    [3, "dead", 3],
  );
}

/* ------------------------------------------------------------------ */
step("active, completed and dead are never touched");

{
  const namespace = ns("untouched");
  const queue = queueIn(namespace, "q");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const done = await queue.add("done", {});
  const doomed = await queue.add("doomed", {});
  const held = await queue.add("held", {});
  workerIn(namespace, "q", async (job) => {
    if (job.name === "doomed") throw new Error("no retries by default");
    if (job.name === "held") await gate;
    return null;
  });
  await waitFor(
    "one completed, one dead, one active",
    async () => {
      const counts = await queue.count();
      return counts.completed === 1 && counts.dead === 1 && counts.active === 1;
    },
    WAIT,
  );

  const { seq } = await queue.setJobDefaults({ attempts: 4, timeout: 900 });
  const applied = await queue.applyJobDefaults({ seq });
  checkEqual(
    "nothing examined: the only jobs are active, completed and dead",
    [applied.examined, applied.rewritten, applied.next],
    [0, 0, null],
  );
  release();
  await waitFor(
    "the held job to finish",
    async () => (await reread(queue, held.id)).state === "completed",
    WAIT,
  );
  checkEqual(
    "each kept its options (attempts 1, no timeout)",
    await Promise.all(
      [done, doomed, held].map(async (job) => {
        const stored = await reread(queue, job.id);
        return [stored.opts.attempts, stored.opts.timeout];
      }),
    ),
    [
      [1, 0],
      [1, 0],
      [1, 0],
    ],
  );
}

/* ------------------------------------------------------------------ */
step("DEFAULTS_CHANGED: a walk is pinned to one seq");

{
  const namespace = ns("pinned");
  const queue = queueIn(namespace, "q");
  const other = queueIn(namespace, "q");
  await queue.addBulk(
    Array.from({ length: 5 }, () => ({ name: "x", data: {} })),
  );
  const { seq } = await queue.setJobDefaults({ attempts: 3 });

  const page = await queue.applyJobDefaults({ seq, limit: 2 });
  checkEqual(
    "the first call rewrote two, and has more",
    [page.rewritten, page.next !== null],
    [2, true],
  );

  const moved = await other.setJobDefaults({ attempts: 8 });
  const error = await checkRejects(
    "continuing with the old seq",
    () => queue.applyJobDefaults({ seq, cursor: page.next, limit: 2 }),
    { name: "JobDefaultsChangedError", code: "DEFAULTS_CHANGED" },
  );
  check(
    "it is a JobDefaultsChangedError",
    error instanceof JobDefaultsChangedError,
  );
  checkEqual(
    "context: the queue, the seq asked for, the seq stored",
    (error as JobDefaultsChangedError | undefined)?.context,
    { queue: "q", expectedSeq: seq, seq: moved.seq },
  );
  const attempts = (await queue.list("waiting")).map(
    (job) => job.opts.attempts,
  );
  checkEqual(
    "nothing was written by the refused call",
    attempts.sort(),
    [1, 1, 1, 3, 3],
  );

  const restarted = await walk(queue, { seq: moved.seq, limit: 2 });
  checkEqual(
    "started over with the new seq, every job gets 8",
    restarted.totals.rewritten,
    5,
  );
}

/* ------------------------------------------------------------------ */
step("Irreversible: a reset changes new jobs only");

{
  const reset = await backlog.resetJobDefaults();
  checkEqual(
    "the rewritten jobs keep the override's values",
    (await reread(backlog, ids.plain)).opts.attempts,
    5,
  );
  checkEqual(
    "a job added now gets the code's value again",
    (await backlog.add("new", {})).opts.attempts,
    1,
  );
  await checkRejects(
    "applying after the reset: the override sets nothing",
    () => backlog.applyJobDefaults({ seq: reset.seq }),
    { name: "ConfigError", message: /override nothing/ },
  );
  await checkRejects(
    "and the pre-reset seq is no longer current",
    () => backlog.applyJobDefaults({ seq: reset.seq - 1 }),
    { name: "JobDefaultsChangedError" },
  );
}

/* ------------------------------------------------------------------ */
step("Repeat series: re-enable, and the worker's next occurrence");

{
  const namespace = ns("repeat");
  const queue = queueIn(namespace, "q");

  await queue.add("report", {}, { repeat: { every: 60_000 } });
  const [series] = await queue.listRepeatables();
  await queue.disableRepeatable(series!.key);
  await queue.setJobDefaults({ attempts: 7 });
  await queue.enableRepeatable(series!.key);
  const [enabled] = await queue.listRepeatables();
  checkEqual(
    "re-enabled: its new occurrence takes the override",
    (await reread(queue, enabled!.nextJobId!)).opts.attempts,
    7,
  );

  const ticking = queueIn(namespace, "tick");
  const first = await ticking.add(
    "tick",
    {},
    { repeat: { every: 60_000, immediately: true }, priority: 2 },
  );
  await ticking.setJobDefaults({ attempts: 9, priority: 7 });
  workerIn(namespace, "tick", async () => null);
  let next: Job | null = null;
  await waitFor(
    "the next occurrence",
    async () => {
      const [after] = await ticking.listRepeatables();
      next = after?.nextJobId ? await ticking.getJob(after.nextJobId) : null;
      return next !== null && next.id !== first.id;
    },
    WAIT,
  );
  checkEqual(
    "built by the worker: the override's attempts, the series' explicit priority",
    [next!.opts.attempts, next!.opts.priority, explicitOf(next!)],
    [9, 2, ["priority"]],
  );
}

/* ------------------------------------------------------------------ */
step("API: the writes are opt-in — only the GET is routed by default");

{
  const jobs = context("api-perm");
  // A queue the backend knows, so the GET is not a 404 QUEUE_NOT_FOUND.
  await jobs.queue("q").add("x", {});
  const byDefault = mount(jobs);
  checkEqual(
    "default actions: only getJobDefaults",
    byDefault.defaultsRoutes(),
    ["getJobDefaults"],
  );
  checkEqual(
    "GET answers",
    (await byDefault.call("GET", "/queues/q/job-defaults")).status,
    200,
  );
  for (const [method, path] of [
    ["PUT", "/queues/q/job-defaults"],
    ["DELETE", "/queues/q/job-defaults"],
    ["POST", "/queues/q/job-defaults/apply"],
  ] as const) {
    const answer = await byDefault.call(
      method,
      path,
      method === "DELETE" ? undefined : { seq: 0 },
    );
    checkEqual(
      `${method} ${path}: JSON 404 ROUTE_NOT_FOUND`,
      [answer.status, answer.body?.code],
      [404, "ROUTE_NOT_FOUND"],
    );
  }
  check(
    "both actions are opt-in",
    JOBS_API_OPT_IN_ACTIONS.has("queues.defaults") &&
      JOBS_API_OPT_IN_ACTIONS.has("queues.applyDefaults"),
  );

  checkEqual(
    "actions: [queues.defaults] routes exactly save and reset",
    mount(jobs, { actions: ["queues.defaults"] }).defaultsRoutes(),
    ["resetJobDefaults", "setJobDefaults"],
  );
  checkEqual(
    "actions: [queues.applyDefaults] routes exactly apply",
    mount(jobs, { actions: ["queues.applyDefaults"] }).defaultsRoutes(),
    ["applyJobDefaults"],
  );
  checkEqual(
    "readOnly keeps only the GET, whatever actions says",
    mount(jobs, {
      actions: [...JOBS_API_ACTIONS],
      readOnly: true,
    }).defaultsRoutes(),
    ["getJobDefaults"],
  );
}

/* ------------------------------------------------------------------ */
step("API: /meta features — jobDefaults and jobDefaultsApply");

{
  const all = { actions: [...JOBS_API_ACTIONS] };
  const full = mount(context("api-meta"), all);
  const features = (await full.call("GET", "/meta")).body.features;
  checkEqual(
    "a built-in driver: both true",
    [features.jobDefaults, features.jobDefaultsApply],
    [true, true],
  );

  const runnerOnly = mount(context("api-meta-runner"), {
    ...all,
    mode: "runner",
  });
  const runnerFeatures = (await runnerOnly.call("GET", "/meta")).body.features;
  checkEqual(
    "mode: runner — both false, the routes are not there",
    [
      runnerFeatures.jobDefaults,
      runnerFeatures.jobDefaultsApply,
      runnerOnly.defaultsRoutes(),
    ],
    [false, false, []],
  );

  const noRewrite = mount(
    context("api-meta-norewrite", {
      on: without(driver, ["rewritePendingOptions"]),
    }),
    all,
  );
  const noRewriteMeta = await noRewrite.call("GET", "/meta");
  const noRewriteFeatures = noRewriteMeta.body.features;
  checkEqual(
    "no rewritePendingOptions: jobDefaultsApply false, apply pruned",
    [
      noRewriteFeatures.jobDefaults,
      noRewriteFeatures.jobDefaultsApply,
      noRewrite.defaultsRoutes(),
    ],
    [true, false, ["getJobDefaults", "resetJobDefaults", "setJobDefaults"]],
  );
  checkEqual(
    "and apply is a JSON 404, never a 501",
    (await noRewrite.call("POST", "/queues/q/job-defaults/apply", { seq: 0 }))
      .status,
    404,
  );

  const noState = mount(
    context("api-meta-nostate", {
      on: without(driver, ["setQueueState", "rewritePendingOptions"]),
    }),
    all,
  );
  const noStateFeatures = (await noState.call("GET", "/meta")).body.features;
  checkEqual(
    "no setQueueState: both false, all four pruned",
    [
      noStateFeatures.jobDefaults,
      noStateFeatures.jobDefaultsApply,
      noState.defaultsRoutes(),
    ],
    [false, false, []],
  );
  checkEqual(
    "the GET too",
    (await noState.call("GET", "/queues/q/job-defaults")).body?.code,
    "ROUTE_NOT_FOUND",
  );
}

/* ------------------------------------------------------------------ */
step("API: the four routes");

{
  const jobs = context("api-routes", { defaults: { attempts: 2 } });
  const { call } = mount(jobs, { actions: [...JOBS_API_ACTIONS] });
  const producer = jobs.queue("mail");
  const path = "/queues/mail/job-defaults";

  const plain = await producer.add("send", {});
  const pinned = await producer.add("send", {}, { priority: 4, attempts: 3 });
  const legacyId = await addUnmarked(producer, "send");

  const got = await call("GET", path);
  checkEqual("GET: 200", got.status, 200);
  checkEqual(
    "JobDefaultsDto: queue, codeSource, seq, override, overridden",
    [
      got.body.queue,
      got.body.codeSource,
      got.body.seq,
      got.body.override,
      got.body.overridden,
    ],
    ["mail", "api", 0, {}, []],
  );
  checkEqual("code: the BunJobs' defaultJobOptions", got.body.code.attempts, 2);
  checkEqual(
    "pending: the four states apply walks, and their total",
    [got.body.pending.waiting, got.body.pending.total],
    [3, 3],
  );
  checkEqual("propagationMs", got.body.propagationMs, 1000);

  checkEqual(
    "GET /jobs/:id — opts.explicit: [] for a plain add",
    (await call("GET", `/queues/mail/jobs/${plain.id}`)).body.opts.explicit,
    [],
  );
  checkEqual(
    "the keys passed, in JOB_DEFAULT_KEYS order",
    (await call("GET", `/queues/mail/jobs/${pinned.id}`)).body.opts.explicit,
    ["attempts", "priority"],
  );
  check(
    "absent on a job with no record",
    !(
      "explicit" in
      (await call("GET", `/queues/mail/jobs/${legacyId}`)).body.opts
    ),
  );

  const put = await call("PUT", path, {
    attempts: 6,
    timeout: 2_000,
    expectedSeq: 0,
  });
  checkEqual(
    "PUT: 200 with the new defaults",
    [put.status, put.body.override],
    [200, { attempts: 6, timeout: 2000 }],
  );
  checkEqual(
    "the API's own queue adds under it at once",
    (await producer.add("send", {})).opts.attempts,
    6,
  );
  const nulled = await call("PUT", path, { timeout: null });
  checkEqual("PUT null clears one key", nulled.body.override, { attempts: 6 });

  // Somebody else writes between our read and our write.
  const { seq: readSeq } = (await call("GET", path)).body;
  await queueIn(ns("api-routes"), "mail").setJobDefaults({ attempts: 7 });
  const stale = await call("PUT", path, { attempts: 4, expectedSeq: readSeq });
  checkEqual(
    "PUT with a stale expectedSeq: 409 CONTROL_CONTENDED",
    [stale.status, stale.body.code],
    [409, "CONTROL_CONTENDED"],
  );
  const staleDelete = await call("DELETE", `${path}?expectedSeq=${readSeq}`);
  checkEqual(
    "DELETE with a stale ?expectedSeq: 409 too",
    staleDelete.status,
    409,
  );
  checkEqual(
    "and neither changed anything",
    (await call("GET", path)).body.override,
    {
      attempts: 7,
    },
  );

  for (const [label, body] of [
    ["attempts: 0", { attempts: 0 }],
    ["keepLogs: 0", { keepLogs: 0 }],
    ["backoff type custom", { backoff: { type: "custom", delay: 10 } }],
    ["a retention object with neither count nor ttl", { removeOnFail: {} }],
  ] as const) {
    const answer = await call("PUT", path, body);
    checkEqual(
      `PUT ${label}: 400 VALIDATION`,
      [answer.status, answer.body.code],
      [400, "VALIDATION"],
    );
  }

  // Apply: loop on `next` until `done`.
  const { seq } = (await call("GET", path)).body;
  const dry = await call("POST", `${path}/apply`, { seq, dryRun: true });
  checkEqual(
    "apply dryRun: counts, and done",
    [dry.status, dry.body.dryRun, dry.body.rewritten, dry.body.done],
    [200, true, 2, true],
  );
  let cursor: string | null = null;
  let rewritten = 0;
  let calls = 0;
  let done = false;
  while (!done) {
    const page = await call("POST", `${path}/apply`, {
      seq,
      limit: 1,
      ...(cursor === null ? {} : { cursor }),
    });
    rewritten += page.body.rewritten;
    cursor = page.body.next;
    done = page.body.done;
    calls++;
  }
  checkEqual(
    "limit 1: a call per job, done when next is null",
    [rewritten, cursor, calls >= 4],
    [2, null, true],
  );
  checkEqual(
    "the plain job now has 7 attempts; the explicit one kept 3",
    [
      (await producer.getJob(plain.id))!.opts.attempts,
      (await producer.getJob(pinned.id))!.opts.attempts,
    ],
    [7, 3],
  );

  const refusals: [string, unknown, number, string][] = [
    ["a stale seq", { seq: seq - 1 }, 409, "DEFAULTS_CHANGED"],
    [
      "keys naming one it does not set",
      { seq, keys: ["timeout"] },
      400,
      "INVALID_ARGUMENT",
    ],
    [
      "a repeated state",
      { seq, states: ["waiting", "waiting"] },
      400,
      "INVALID_ARGUMENT",
    ],
    [
      "a foreign cursor",
      { seq, cursor: "not-a-cursor" },
      400,
      "INVALID_ARGUMENT",
    ],
  ];
  for (const [label, body, status, code] of refusals) {
    const answer = await call("POST", `${path}/apply`, body);
    checkEqual(
      `apply with ${label}: ${status} ${code}`,
      [answer.status, answer.body.code],
      [status, code],
    );
  }

  // Another queue's walk, through the same API: its cursor is refused here.
  await jobs
    .queue("other")
    .addBulk(Array.from({ length: 3 }, () => ({ name: "x", data: {} })));
  const otherPath = "/queues/other/job-defaults";
  const otherSeq = (await call("PUT", otherPath, { attempts: 5 })).body.seq;
  const otherPage = await call("POST", `${otherPath}/apply`, {
    seq: otherSeq,
    limit: 1,
  });
  const crossed = await call("POST", `${path}/apply`, {
    seq,
    cursor: otherPage.body.next,
  });
  checkEqual(
    "apply with another queue's cursor: 400 INVALID_ARGUMENT, the library's message",
    [crossed.status, crossed.body.code, crossed.body.detail],
    [400, "INVALID_ARGUMENT", "this cursor belongs to another walk"],
  );
  const resumed = await call("POST", `${otherPath}/apply`, {
    seq: otherSeq,
    cursor: otherPage.body.next,
  });
  checkEqual(
    "while that queue resumes its own walk with it, to done",
    [otherPage.body.rewritten + resumed.body.rewritten, resumed.body.done],
    [3, true],
  );

  const deleted = await call("DELETE", path);
  checkEqual(
    "DELETE: 200 (not 204) with the new seq",
    [deleted.status, deleted.body.override],
    [200, {}],
  );
  check("and seq rose", deleted.body.seq > seq, [seq, deleted.body.seq]);
  const nothing = await call("POST", `${path}/apply`, {
    seq: deleted.body.seq,
  });
  checkEqual(
    "apply after the reset: 400 INVALID_ARGUMENT, the library's message passed through",
    [
      nothing.status,
      nothing.body.code,
      /override nothing/.test(String(nothing.body.detail)),
    ],
    [400, "INVALID_ARGUMENT", true],
  );
}

/* ------------------------------------------------------------------ */
step("API: limits.maxApplyDefaults");

{
  checkEqual(
    "DEFAULT_JOBS_API_LIMITS.maxApplyDefaults",
    DEFAULT_JOBS_API_LIMITS.maxApplyDefaults,
    1000,
  );
  const jobs = context("api-limit");
  for (const value of [0, 10_001]) {
    await checkRejects(
      `maxApplyDefaults: ${value}`,
      () =>
        createJobsApi({
          jobs,
          basePath: "/admin/jobs",
          authorize: () => true,
          limits: { maxApplyDefaults: value },
        }),
      { name: "ConfigError", message: /maxApplyDefaults/ },
    );
  }

  const { call } = mount(jobs, {
    actions: [...JOBS_API_ACTIONS],
    limits: { queueCacheMs: 0, maxApplyDefaults: 5 },
  });
  await jobs
    .queue("bulk")
    .addBulk(Array.from({ length: 8 }, () => ({ name: "x", data: {} })));
  const { seq } = (
    await call("PUT", "/queues/bulk/job-defaults", { attempts: 2 })
  ).body;

  const over = await call("POST", "/queues/bulk/job-defaults/apply", {
    seq,
    limit: 6,
  });
  checkEqual(
    "a limit over it: 400 VALIDATION, on the field",
    [over.status, over.body.code],
    [400, "VALIDATION"],
  );
  const capped = await call("POST", "/queues/bulk/job-defaults/apply", { seq });
  checkEqual(
    "no limit: min(1000, maxApplyDefaults) — five examined, not done",
    [capped.body.examined, capped.body.done],
    [5, false],
  );
}

/* ------------------------------------------------------------------ */
step("API: one apply per queue at a time (shown, not asserted: timing)");

{
  const jobs = context("api-busy");
  const { call } = mount(jobs, { actions: [...JOBS_API_ACTIONS] });
  await jobs
    .queue("big")
    .addBulk(
      Array.from({ length: 400 }, (_, i) => ({ name: "x", data: { i } })),
    );
  const { seq } = (
    await call("PUT", "/queues/big/job-defaults", { timeout: 5_000 })
  ).body;

  const answers = await Promise.all(
    [0, 1].map(
      async () => await call("POST", "/queues/big/job-defaults/apply", { seq }),
    ),
  );
  const outcomes = answers.map((answer) =>
    answer.status === 200 ? "200" : `${answer.status} ${answer.body.code}`,
  );
  show("two concurrent applies answered", outcomes);
  check(
    "each is a 200 or 409 OPERATION_IN_PROGRESS, and at least one ran",
    outcomes.every(
      (outcome) => outcome === "200" || outcome === "409 OPERATION_IN_PROGRESS",
    ) && outcomes.includes("200"),
    outcomes,
  );
}

/* ------------------------------------------------------------------ */
step("Clean up");

for (const close of closers.reverse()) {
  await close().catch(() => {});
}
for (const namespace of namespaces) {
  await driver.purge(namespace);
}
await driver.close();

summary();
