import type {
  JobsDriver,
  QueueDemand,
  QueueRef,
  WorkerInfo,
} from "../drivers/index";
import type { Logger } from "../shared/logger";
import type { MarkerRead } from "./marker";
import type {
  PendingSummon,
  ProviderCallContext,
  SummonCheckResult,
  SummonControllerEvents,
  SummonControllerOptions,
  Summoner,
  SummonEventPayload,
  SummonMarker,
  SummonOutcomeKind,
  SummonReason,
  SummonRequest,
  SummonResult,
  SummonSkipReason,
  SummonStatus,
} from "./types";
import process from "node:process";
import {
  listWorkerRecords,
  readDemand,
  supportsWorkers,
} from "../drivers/index";
import { setReservedState } from "../queue/windows";
import { CHILD_ENV } from "../runner/protocol";
import { TypedEmitterBase } from "../shared/emitter";
import { ConfigError } from "../shared/errors";
import { assertNamespace, assertSegment } from "../shared/keys";
import { createJobsLogger } from "../shared/logger";
import { SUMMON_ARGS } from "./args";
import {
  openSummonClaim,
  SUMMON_CLAIM_RETENTION_MS,
  sweepSummonClaims,
} from "./claim";
import { toSummoner } from "./define";
import {
  attemptId,
  backoffFor,
  dedupeKeyFor,
  readMarker,
  rollBudget,
  SUMMON_MARKER,
} from "./marker";

/**
 * The summon controller: watches one queue and summons compute when it has
 * work and no worker. See `SummonController`.
 */

/** Poll interval when none is given, in ms. */
const DEFAULT_POLL = 30_000;
/** Debounce for add and event triggers when none is given, in ms. */
const DEFAULT_DEBOUNCE = 250;
/** Least time between two attempts when none is given, in ms. */
const DEFAULT_COOLDOWN = 10_000;
/** The first backoff after a failure when none is given, in ms. */
const DEFAULT_BACKOFF_INITIAL = 30_000;
/** The longest backoff when none is given, in ms. */
const DEFAULT_BACKOFF_MAX = 900_000;
/** Consecutive failures that open the circuit when none is given. */
const DEFAULT_CIRCUIT_FAILURES = 5;
/** How long the circuit stays open when none is given, in ms. */
const DEFAULT_CIRCUIT_RESET = 900_000;
/** Attempts per hour when none is given. */
const DEFAULT_PER_HOUR = 30;
/** Attempts per day when none is given. */
const DEFAULT_PER_DAY = 300;
/** A summoned worker's longest life when none is given, in ms. */
const DEFAULT_MAX_LIFETIME = 3_600_000;
/** How long nothing may be outstanding before a scale-style release, when none is given, in ms. */
const DEFAULT_SCALE_DOWN_AFTER = 300_000;
/** How long one summoner call may take when none is given, in ms. */
const DEFAULT_SUMMON_TIMEOUT = 30_000;
/**
 * With `passes: "none"` an attempt is released by a live worker that started
 * at most this long before the attempt was claimed (a clock-skew allowance).
 */
const START_TIME_SLACK = 5_000;
/** How many times a result is written back against a fresh read before giving up. */
const RECORD_ATTEMPTS = 3;
/** How often old claim-once entries are swept, at most, in ms. */
const CLAIM_SWEEP_EVERY = 3_600_000;

/**
 * The events from other processes that can create demand, so the events
 * trigger checks after them.
 */
const DEMAND_EVENTS: ReadonlySet<string> = new Set([
  "added",
  "waiting",
  "delayed",
  "promoted",
  "resumed",
  "retried",
  "repeatScheduled",
]);

/**
 * Attaches a queue's local `added` event to a controller's `onAdd` trigger.
 * A symbol, not a method: `BunJobs` calls it for every queue of the watched
 * name it creates, and nothing outside the package can.
 */
export const ATTACH_QUEUE: unique symbol = Symbol(
  "bun-jobs: attach a queue to a summon controller",
);

/** What the `onAdd` trigger listens to: the local `added` event of a queue. */
export interface AddedSource {
  /** Adds the listener. */
  on: (event: "added", listener: (job: AddedJob) => void) => unknown;
  /** Removes it again, on close. */
  off: (event: "added", listener: (job: AddedJob) => void) => unknown;
}

/** The two fields of an added job the fast path reads. */
export interface AddedJob {
  /** Where the job went: `waiting`, or `delayed` until `runAt`. */
  state: string;
  /** When it becomes due, epoch ms. */
  runAt: number;
}

/**
 * Whether this process was summoned, or is a bun-jobs runner or target child:
 * where a controller is inert unless its policy says `fromSummoned`.
 *
 * Refuse-only, like `summonedFromArgs()`'s own check: `BUN_JOBS_CHILD` is set
 * explicitly on every child bun-jobs starts, so reading it can only make a
 * controller inert, never grant anything.
 */
export function inSummonedProcess(
  /** The command line. */
  argv: readonly string[] = process.argv,
  /** `BUN_JOBS_CHILD` as this process sees it. */
  childMarker: string | undefined = process.env[CHILD_ENV.marker],
): boolean {
  if (childMarker === "1") {
    return true;
  }
  const prefix = `${SUMMON_ARGS.id}=`;
  return argv.some(
    (arg) => arg.startsWith(prefix) && arg.length > prefix.length,
  );
}

/** Whether a live record is serving: running, or too old to say and not paused. */
function isServing(worker: WorkerInfo): boolean {
  if (worker.state !== undefined) {
    return worker.state === "running" || worker.state === "restarting";
  }
  return !worker.paused;
}

/** A positive whole number, or a `ConfigError` naming the option. */
function positiveInt(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive whole number`, {
      [name]: value,
    });
  }
  return value;
}

/** A whole number ≥ 0, or a `ConfigError` naming the option. */
function nonNegativeInt(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConfigError(`${name} must be a whole number, 0 or more`, {
      [name]: value,
    });
  }
  return value;
}

/** A short, secret-free name for a thrown value: its error name or code, never its message. */
function errorDetail(error: unknown): string {
  if (error instanceof SummonTimeoutError) {
    return "timeout";
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code.length > 0 ? code : error.name;
  }
  return "error";
}

/** A summoner call that ran past `summonTimeout`. */
class SummonTimeoutError extends Error {
  constructor(ms: number) {
    super(`the summoner did not answer within ${ms}ms`);
    this.name = "SummonTimeoutError";
  }
}

/** Every option resolved, with its default. */
interface ResolvedPolicy {
  /** `triggers.onAdd`. */
  onAdd: boolean;
  /** `triggers.events`. */
  events: boolean;
  /** `triggers.poll`, `false` for off. */
  poll: number | false;
  /** `triggers.debounce`. */
  debounce: number;
  /** `bootBudget`. */
  bootBudget: number;
  /** `maxWorkers`, clamped to a wake pool. */
  maxWorkers: number;
  /** `jobsPerWorker`. */
  jobsPerWorker: number;
  /** `maxPending`. */
  maxPending: number;
  /** `cooldown`. */
  cooldown: number;
  /** `backoff`. */
  backoff: { initial: number; max: number };
  /** `circuit`. */
  circuit: { failures: number; resetAfter: number };
  /** `budget`. */
  budget: { perHour: number; perDay: number };
  /** `maxLifetime`. */
  maxLifetime: number;
  /** `servedBy`. */
  servedBy: "any-worker" | "summoned-only";
  /** `scaleDown.after`. */
  scaleDownAfter: number;
  /** `summonTimeout`. */
  summonTimeout: number;
  /** `env`, frozen. */
  env: Readonly<Record<string, string>>;
}

/**
 * The parts of a request that go over the wire, built from the claim and the
 * static policy only — never from the clock, the demand reading or the
 * trigger — so every request for one attempt id is byte-identical.
 * Internal; exported for its test.
 */
export function wireRequest(
  claim: {
    /** The attempt id. */
    id: string;
    /** Workers it asks for. */
    count: number;
    /** The absolute count, for a scale style. */
    target: number;
  },
  context: {
    /** The namespace. */
    namespace: string;
    /** The queue. */
    queue: string;
    /** The summoner's kind. */
    kind: string;
    /** The summoner's style. */
    style: "launch" | "scale" | "wake";
    /** The dedupe-key builder. */
    dedupeKey: (id: string) => string;
    /** The platform's grace, in ms. */
    graceMs: number;
    /** The worker's longest life, in ms. */
    maxLifetime: number;
    /** Static environment. */
    env: Readonly<Record<string, string>>;
  },
): Omit<SummonRequest, "demand" | "reason"> {
  // A launch or wake unit ends when its process exits, so it exits on idle; a
  // scale unit would only be restarted by its platform, so it runs until
  // stopped (and the controller scales it to zero).
  const mode = context.style === "scale" ? "until-stopped" : "exit-on-idle";
  return {
    namespace: context.namespace,
    queue: context.queue,
    id: claim.id,
    dedupeKey: context.dedupeKey(claim.id),
    count: claim.count,
    target: claim.target,
    env: context.env,
    argv: Object.freeze([
      `${SUMMON_ARGS.id}=${claim.id}`,
      `${SUMMON_ARGS.kind}=${context.kind}`,
      `${SUMMON_ARGS.mode}=${mode}`,
      `${SUMMON_ARGS.namespace}=${context.namespace}`,
      `${SUMMON_ARGS.queue}=${context.queue}`,
      `${SUMMON_ARGS.maxLifetimeMs}=${context.maxLifetime}`,
      `${SUMMON_ARGS.graceMs}=${context.graceMs}`,
    ]),
    maxLifetimeMs: context.maxLifetime,
  };
}

/**
 * Watches one queue and summons compute when it has work and no worker.
 *
 * ```ts
 * const controller = new SummonController({
 *   driver, namespace: "shop", queue: "emails",
 *   summoner: defineSummoner({ kind: "my-cloud", invoke: async (request) => { … } }),
 * });
 * ```
 *
 * **Every guard is per queue, in the driver**, not per process: one reserved
 * queue-state entry (the marker) holds the attempts in flight, the failures,
 * the backoff, the circuit and the budget, and is written only by
 * compare-and-set. Two controllers anywhere, in any number of processes,
 * therefore summon once for one backlog: the second finds the first's
 * attempt counted as a worker on its way, or loses the write and calls
 * nothing.
 *
 * Three triggers run a check: an add through an attached queue
 * (`triggers.onAdd`), an event another process published (`triggers.events`),
 * and a poll (`triggers.poll`), which is the only one that sees a delayed job
 * come due or a dead worker's lock lapse. `check()` runs one on demand.
 *
 * Emits `summon` locally for every attempt that changes state. Built by
 * `jobs.summonController(queue)` or from `BunJobsOptions.summon`, or directly.
 *
 * @throws {ConfigError} at construction on a driver that is not
 *   multi-process, has no queue state or cannot store worker records, and on
 *   a malformed option.
 */
export class SummonController extends TypedEmitterBase<SummonControllerEvents> {
  /** The queue it watches. */
  readonly queue: string;
  /** The queue's namespace. */
  readonly namespace: string;
  /**
   * Whether it is inert: in a summoned process or a runner child, without
   * `fromSummoned`. An inert controller arms no trigger, and `check()`
   * answers `skipped: "inert"`.
   */
  readonly inert: boolean;

  /** The backend. */
  readonly #driver: JobsDriver;
  /** The queue as the driver addresses it. */
  readonly #ref: QueueRef;
  /** Where it logs. */
  readonly #logger: Logger;
  /** The summoner, normalised. */
  readonly #summoner: Summoner;
  /** The policy with its defaults. */
  readonly #policy: ResolvedPolicy;
  /** Turns an attempt id into the platform's dedupe key. */
  readonly #dedupeKey: (id: string) => string;
  /**
   * While `Date.now()` is below this, a live serving worker was last seen
   * covering what the queue wants, and a local `added` does nothing at all:
   * the earliest `expiresAt` among the records that counted. `0` otherwise.
   */
  #servedUntil = 0;
  /** The debounce timer for add and event triggers, while armed. */
  #debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** The one-shot timer for a delayed job added here, and the time it fires. */
  #dueTimer: { at: number; timer: ReturnType<typeof setTimeout> } | undefined;
  /** The poll timer, while armed. */
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  /** Every check, chained, so two never interleave in one controller. */
  #chain: Promise<unknown> = Promise.resolve();
  /** Whether a triggered check is queued and not yet started, so triggers coalesce. */
  #triggerQueued = false;
  /** Whether `close()` was called. */
  #closed = false;
  /** Connecting and ensuring the queue, once. */
  #ready: Promise<void> | undefined;
  /** The event subscription being set up, and its unsubscribe. */
  #subscription: Promise<(() => Promise<void>) | undefined> | undefined;
  /** Queues whose `added` event this controller listens to. */
  readonly #sources = new Set<AddedSource>();
  /** Since when nothing has been outstanding (scale style), or `undefined`. */
  #zeroSince: number | undefined;
  /** Whether this controller has released the scale count since demand last appeared. */
  #released = false;
  /** The budget windows a `budget-exhausted` event was already emitted for, locally. */
  #budgetNoted: string | undefined;
  /** When claim-once entries were last swept, epoch ms. */
  #claimsSweptAt = 0;

  constructor(options: SummonControllerOptions) {
    super();
    const { driver } = options;
    if (typeof driver !== "object" || driver === null) {
      throw new ConfigError("SummonController needs a driver instance");
    }
    this.namespace = assertNamespace(options.namespace);
    this.queue = assertSegment(options.queue, "queue name");
    this.#driver = driver;
    this.#ref = { ns: this.namespace, queue: this.queue };
    this.#logger = createJobsLogger(
      options.logger,
      { namespace: this.namespace, queue: this.queue },
      "summon",
    );

    // §4.9: a backend another process can reach, with the marker's
    // compare-and-set, and worker records to release attempts by.
    if (!driver.capabilities.multiProcess) {
      throw new ConfigError(
        `The ${driver.name} driver cannot be shared with another process, so nothing it summons could reach this queue`,
        { driver: driver.name },
      );
    }
    if (
      typeof driver.getQueueState !== "function" ||
      typeof driver.setQueueState !== "function"
    ) {
      throw new ConfigError(
        `Summoning needs queue state for its in-flight marker, and the ${driver.name} driver has none`,
        { driver: driver.name },
      );
    }
    if (!supportsWorkers(driver)) {
      throw new ConfigError(
        `Summoning needs worker records to release an attempt, and the ${driver.name} driver cannot store them`,
        { driver: driver.name },
      );
    }

    this.#summoner = toSummoner(options.summoner);
    const capabilities = this.#summoner.summon.capabilities;
    if (
      capabilities.style === "scale" &&
      typeof this.#summoner.summon.release !== "function"
    ) {
      throw new ConfigError(
        "A scale-style summoner needs release(): nothing else can set its count back to zero",
        { kind: this.#summoner.provider.kind },
      );
    }
    try {
      this.#dedupeKey = dedupeKeyFor(capabilities.dedupe);
    } catch (error) {
      throw new ConfigError(
        "The summoner's dedupe charset is not a valid character class",
        { error: String(error) },
      );
    }

    this.#policy = this.#resolve(options);
    if (!driver.capabilities.multiHost) {
      this.#logger.warn(
        "this driver works on one host only: a summoned worker must run on this host to reach it",
        { driver: driver.name, kind: this.#summoner.provider.kind },
      );
    }

    this.inert = options.fromSummoned !== true && inSummonedProcess();
    if (this.inert) {
      this.#logger.info(
        "summon controller inert: this process was summoned or is a runner child (set fromSummoned to override)",
      );
      return;
    }

    if (this.#policy.poll !== false) {
      this.#pollTimer = setInterval(
        () => this.#trigger("poll"),
        this.#policy.poll,
      );
      this.#pollTimer.unref?.();
    }
    if (this.#policy.events) {
      this.#subscription = this.#subscribe();
    }
  }

  /** Every option, checked, with its default. */
  #resolve(options: SummonControllerOptions): ResolvedPolicy {
    const capabilities = this.#summoner.summon.capabilities;
    const triggers = options.triggers ?? {};
    const poll =
      triggers.poll === false
        ? false
        : positiveInt("triggers.poll", triggers.poll ?? DEFAULT_POLL);
    let maxWorkers = positiveInt("maxWorkers", options.maxWorkers ?? 1);
    if (
      capabilities.style === "wake" &&
      capabilities.poolSize !== undefined &&
      maxWorkers > capabilities.poolSize
    ) {
      this.#logger.warn("maxWorkers is above the wake pool's size; clamped", {
        maxWorkers,
        poolSize: capabilities.poolSize,
      });
      maxWorkers = capabilities.poolSize;
    }
    const jobsPerWorker = options.jobsPerWorker ?? Infinity;
    if (!(jobsPerWorker > 0) || Number.isNaN(jobsPerWorker)) {
      throw new ConfigError("jobsPerWorker must be a positive number", {
        jobsPerWorker,
      });
    }
    const maxLifetime = positiveInt(
      "maxLifetime",
      options.maxLifetime ?? DEFAULT_MAX_LIFETIME,
    );
    if (
      capabilities.maxLifetimeMs !== null &&
      maxLifetime > capabilities.maxLifetimeMs
    ) {
      throw new ConfigError(
        "maxLifetime is above the platform's own cap: the platform would kill the worker mid-job",
        { maxLifetime, platformCap: capabilities.maxLifetimeMs },
      );
    }
    const servedBy = options.servedBy ?? "any-worker";
    if (servedBy !== "any-worker" && servedBy !== "summoned-only") {
      throw new ConfigError(
        'servedBy must be "any-worker" or "summoned-only"',
        { servedBy },
      );
    }
    const env = options.env ?? {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== "string") {
        throw new ConfigError("env values must be strings", { key });
      }
    }
    const backoffInitial = positiveInt(
      "backoff.initial",
      options.backoff?.initial ?? DEFAULT_BACKOFF_INITIAL,
    );

    return {
      onAdd: triggers.onAdd ?? true,
      events: triggers.events ?? this.#driver.capabilities.events !== "local",
      poll,
      debounce: nonNegativeInt(
        "triggers.debounce",
        triggers.debounce ?? DEFAULT_DEBOUNCE,
      ),
      bootBudget: positiveInt(
        "bootBudget",
        options.bootBudget ?? capabilities.bootBudgetMs,
      ),
      maxWorkers,
      jobsPerWorker,
      maxPending: positiveInt("maxPending", options.maxPending ?? maxWorkers),
      cooldown: nonNegativeInt(
        "cooldown",
        options.cooldown ?? DEFAULT_COOLDOWN,
      ),
      backoff: {
        initial: backoffInitial,
        max: Math.max(
          backoffInitial,
          positiveInt(
            "backoff.max",
            options.backoff?.max ?? DEFAULT_BACKOFF_MAX,
          ),
        ),
      },
      circuit: {
        failures: positiveInt(
          "circuit.failures",
          options.circuit?.failures ?? DEFAULT_CIRCUIT_FAILURES,
        ),
        resetAfter: positiveInt(
          "circuit.resetAfter",
          options.circuit?.resetAfter ?? DEFAULT_CIRCUIT_RESET,
        ),
      },
      budget: {
        perHour: positiveInt(
          "budget.perHour",
          options.budget?.perHour ?? DEFAULT_PER_HOUR,
        ),
        perDay: positiveInt(
          "budget.perDay",
          options.budget?.perDay ?? DEFAULT_PER_DAY,
        ),
      },
      maxLifetime,
      servedBy,
      scaleDownAfter: nonNegativeInt(
        "scaleDown.after",
        options.scaleDown?.after ?? DEFAULT_SCALE_DOWN_AFTER,
      ),
      summonTimeout: positiveInt(
        "summonTimeout",
        options.summonTimeout ?? DEFAULT_SUMMON_TIMEOUT,
      ),
      env: Object.freeze({ ...env }),
    };
  }

  /* --- triggers ------------------------------------------------------ */

  /**
   * The `onAdd` trigger. Runs once per job added through an attached queue,
   * on the add path, so it does the least it can: while a serving worker is
   * known it returns at once — no timer, no driver call — and otherwise it
   * arms at most one timer per controller, however many jobs arrive.
   */
  readonly #onAdded = (job: AddedJob): void => {
    if (this.#closed) {
      return;
    }
    const now = Date.now();
    if (now < this.#servedUntil) {
      return;
    }
    if (job.state === "delayed") {
      // Not demand until it is due. A long-lived producer should not wait a
      // whole poll for its own delayed job, so a job due within one poll gets
      // a one-shot timer at its `runAt`; a later one is the poll's.
      const horizon =
        this.#policy.poll === false ? Infinity : this.#policy.poll;
      if (job.runAt - now <= horizon) {
        this.#armDue(job.runAt);
      }
      return;
    }
    this.#arm("add");
  };

  /** Attaches a queue's local `added` event. Called by `BunJobs`; idempotent. */
  [ATTACH_QUEUE](source: AddedSource): void {
    if (
      this.inert ||
      this.#closed ||
      !this.#policy.onAdd ||
      this.#sources.has(source)
    ) {
      return;
    }
    source.on("added", this.#onAdded);
    this.#sources.add(source);
  }

  /** Arms the debounce timer, unless it already is. */
  #arm(reason: SummonReason): void {
    if (this.#debounceTimer !== undefined || this.#closed) {
      return;
    }
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = undefined;
      this.#trigger(reason);
    }, this.#policy.debounce);
    this.#debounceTimer.unref?.();
  }

  /** Arms the one-shot timer for a delayed job, keeping only the earliest. */
  #armDue(at: number): void {
    if (this.#dueTimer !== undefined && this.#dueTimer.at <= at) {
      return;
    }
    if (this.#dueTimer !== undefined) {
      clearTimeout(this.#dueTimer.timer);
    }
    const timer = setTimeout(
      () => {
        this.#dueTimer = undefined;
        this.#trigger("timer");
      },
      Math.max(0, at - Date.now()),
    );
    timer.unref?.();
    this.#dueTimer = { at, timer };
  }

  /** Subscribes to other processes' events on the queue. Failures are logged, never thrown. */
  async #subscribe(): Promise<(() => Promise<void>) | undefined> {
    try {
      await this.#driver.connect();
      if (this.#closed) {
        return undefined;
      }
      return await this.#driver.subscribe(
        this.namespace,
        "queue",
        this.queue,
        (event) => {
          if (
            !this.#closed &&
            DEMAND_EVENTS.has(event.type) &&
            Date.now() >= this.#servedUntil
          ) {
            this.#arm("event");
          }
        },
      );
    } catch (error) {
      this.#logger.error("summon events subscription failed", { error });
      return undefined;
    }
  }

  /**
   * Runs a check for a trigger: chained after any check running, and
   * coalesced, so a trigger arriving while one is already queued adds
   * nothing. Never rejects: a failure is logged.
   */
  #trigger(reason: SummonReason): void {
    if (this.#closed || this.#triggerQueued) {
      return;
    }
    this.#triggerQueued = true;
    const run = this.#chain.then(async () => {
      this.#triggerQueued = false;
      const result = await this.#check(reason, false);
      // A poll's housekeeping, kept off every other check's path.
      if (reason === "poll") {
        await this.#sweepClaims(Date.now());
      }
      return result;
    });
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    run.catch((error: unknown) => {
      this.#logger.error("summon check failed", { error, reason });
    });
  }

  /* --- the check ----------------------------------------------------- */

  /**
   * Runs one check now. Every trigger ends up here. Checks in one controller
   * never interleave: this waits for one in flight.
   */
  async check(options?: {
    /** Recorded on the attempt and in events. Defaults to `"manual"`. */
    reason?: SummonReason;
    /** Skip the cooldown (never the circuit, the budget or the compare-and-set). */
    force?: boolean;
  }): Promise<SummonCheckResult> {
    const run = this.#chain.then(
      async () =>
        await this.#check(options?.reason ?? "manual", options?.force ?? false),
    );
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  /** Connects and ensures the queue, once; a failure is retried next time. */
  async #connect(): Promise<void> {
    this.#ready ??= (async () => {
      await this.#driver.connect();
      await this.#driver.ensureQueue(this.#ref);
    })().catch((error: unknown) => {
      this.#ready = undefined;
      throw error;
    });
    await this.#ready;
  }

  /** The four reads every check starts with: demand, live records and the marker. */
  async #read(now: number): Promise<{
    demand: QueueDemand;
    workers: WorkerInfo[];
    read: MarkerRead;
  }> {
    const records = listWorkerRecords(this.#driver, this.#ref, now);
    const [demand, workers, entry] = await Promise.all([
      readDemand(this.#driver, this.#ref, { now, workers: records }),
      records,
      (async () =>
        await this.#driver.getQueueState!(this.#ref, SUMMON_MARKER))(),
    ]);
    const read = readMarker(entry, now);
    if (read.unreadable) {
      this.#logger.warn(
        "the summon marker is unreadable; starting a fresh one over it",
      );
    }
    return { demand, workers, read };
  }

  /** The body of a check. */
  async #check(
    reason: SummonReason,
    force: boolean,
  ): Promise<SummonCheckResult> {
    if (this.#closed) {
      return { action: "skipped", reason: "closed" };
    }
    await this.#connect();
    const now = Date.now();
    const { demand, workers, read } = await this.#read(now);
    if (this.inert) {
      return { action: "skipped", reason: "inert", demand };
    }

    const { marker, version } = read;
    const capabilities = this.#summoner.summon.capabilities;
    const events: SummonEventPayload[] = [];
    const lost: PendingSummon[] = [];
    let changed = read.unreadable;

    // Step 2: release what registered, drop what was lost.
    const pendingIds = new Set(marker.pending.map((entry) => entry.id));
    const attributed = new Set(
      workers
        .filter((worker) => worker.summon && pendingIds.has(worker.summon.id))
        .map((worker) => worker.id),
    );
    const keep: PendingSummon[] = [];
    // Workers already registered per attempt still pending (count > 1):
    // they are live records, counted as such, so only the rest are on their
    // way. Worked out afresh each check, never written back.
    const partly = new Map<string, number>();
    for (const attempt of marker.pending) {
      let registered = workers.filter(
        (worker) => worker.summon?.id === attempt.id,
      ).length;
      if (registered === 0 && capabilities.passes === "none") {
        const match = workers.find(
          (worker) =>
            !attributed.has(worker.id) &&
            worker.startedAt >= attempt.at - START_TIME_SLACK,
        );
        if (match) {
          attributed.add(match.id);
          registered = 1;
        }
      }
      if (
        registered >= attempt.count ||
        (registered > 0 && attempt.until <= now)
      ) {
        changed = true;
        marker.failures = 0;
        marker.last = { id: attempt.id, outcome: "registered", at: now };
        events.push({
          id: attempt.id,
          outcome: "registered",
          kind: attempt.kind,
          count: attempt.count,
        });
        continue;
      }
      if (attempt.until <= now) {
        changed = true;
        lost.push(attempt);
        this.#fail(marker, now);
        marker.last = { id: attempt.id, outcome: "lost", at: now };
        events.push({
          id: attempt.id,
          outcome: "lost",
          kind: attempt.kind,
          count: attempt.count,
          ...(attempt.handles === undefined
            ? {}
            : { handles: attempt.handles }),
        });
        continue;
      }
      if (registered > 0) {
        partly.set(attempt.id, registered);
      }
      keep.push(attempt);
    }
    marker.pending = keep;
    rollBudget(marker, now);

    // Step 3: nothing needs a worker.
    const orphaned =
      !demand.paused && demand.active > 0 && workers.length === 0;
    const nothingOutstanding =
      demand.waiting + demand.dueNow + demand.active === 0;
    if (!nothingOutstanding) {
      this.#zeroSince = undefined;
      this.#released = false;
    }

    const serving = workers.filter(isServing);
    const counted =
      this.#policy.servedBy === "any-worker"
        ? serving
        : serving.filter((worker) => worker.summon !== undefined);
    const wanted = Math.min(
      this.#policy.maxWorkers,
      Math.max(1, Math.ceil(demand.outstanding / this.#policy.jobsPerWorker)),
    );
    // The fast path's window: while the live records alone cover what is
    // wanted, an add changes nothing a check would decide.
    this.#servedUntil =
      counted.length >= wanted && counted.length > 0
        ? Math.min(...counted.map((worker) => worker.expiresAt))
        : 0;

    if (demand.paused || (demand.demand === 0 && !orphaned)) {
      await this.#settle(marker, version, changed, events, lost);
      if (capabilities.style === "scale" && nothingOutstanding) {
        this.#zeroSince ??= now;
        if (
          !this.#released &&
          now - this.#zeroSince >= this.#policy.scaleDownAfter
        ) {
          await this.#release();
          return { action: "released", demand };
        }
      }
      return { action: "none", demand };
    }

    // Step 4: how many more are wanted.
    const onTheirWay = marker.pending.reduce(
      (sum, attempt) =>
        sum + Math.max(0, attempt.count - (partly.get(attempt.id) ?? 0)),
      0,
    );
    const want = wanted - counted.length - onTheirWay;
    if (want <= 0) {
      await this.#settle(marker, version, changed, events, lost);
      return {
        action: "skipped",
        reason: counted.length >= wanted ? "served" : "pending",
        demand,
      };
    }

    // Step 5: the gates, in order.
    const gate = this.#gate(marker, now, force);
    if (gate !== undefined) {
      await this.#settle(marker, version, changed, events, lost);
      return { action: "skipped", reason: gate, demand };
    }

    // Step 6: claim. Nothing has been called yet, so losing costs nothing.
    const count = Math.min(
      want,
      capabilities.maxCountPerCall ?? Number.POSITIVE_INFINITY,
    );
    const id = attemptId(
      this.namespace,
      this.queue,
      marker.epoch,
      (version ?? 0) + 1,
    );
    const kind = this.#summoner.provider.kind;
    marker.pending.push({
      id,
      at: now,
      until: now + this.#policy.bootBudget,
      count,
      kind,
    });
    marker.lastAttemptAt = now;
    marker.budget.hour++;
    marker.budget.day++;
    const written = await setReservedState(
      this.#driver,
      this.#ref,
      SUMMON_MARKER,
      marker,
      version,
    );
    if (written === null) {
      return { action: "skipped", reason: "contended", demand };
    }
    this.#announce(events);
    void this.#explainLost(lost);
    this.#released = false;
    this.#zeroSince = undefined;

    // Claim-once for several workers: they all start with this id, so the
    // claim is opened for `count` of them before any can start. One worker
    // needs nothing — its claim is created by the worker itself.
    if (count > 1) {
      try {
        await openSummonClaim(this.#driver, this.#ref, id, count, now);
      } catch (error) {
        // Then only the first to start runs summoned; the attempt is still
        // released by it (a partial registration counts once `until` passes).
        this.#logger.warn(
          "could not open the summon claim for several workers",
          {
            id,
            count,
            error,
          },
        );
      }
    }

    // Step 7: call.
    const request: SummonRequest = {
      ...wireRequest(
        { id, count, target: counted.length + onTheirWay + count },
        {
          namespace: this.namespace,
          queue: this.queue,
          kind,
          style: capabilities.style,
          dedupeKey: this.#dedupeKey,
          graceMs: capabilities.shutdown.graceMs,
          maxLifetime: this.#policy.maxLifetime,
          env: this.#policy.env,
        },
      ),
      demand,
      reason,
    };

    let result: SummonResult | undefined;
    let failure: unknown;
    try {
      result = await this.#call(
        async (context) => await this.#summoner.summon.summon(request, context),
        id,
      );
    } catch (error) {
      failure = error;
    }

    // Step 8: record.
    const outcome = await this.#record(id, count, reason, result, failure);
    return { action: "summoned", id, outcome, demand };
  }

  /**
   * The gate that holds an attempt back, if any: circuit, backoff, cooldown,
   * budget, then `maxPending`.
   */
  #gate(
    marker: SummonMarker,
    now: number,
    force: boolean,
  ): Exclude<SummonSkipReason, "closed" | "inert"> | undefined {
    if (
      marker.circuitOpenUntil !== undefined &&
      marker.circuitOpenUntil > now
    ) {
      return "circuit-open";
    }
    if (marker.backoffUntil !== undefined && marker.backoffUntil > now) {
      return "backoff";
    }
    if (
      !force &&
      marker.lastAttemptAt !== undefined &&
      now - marker.lastAttemptAt < this.#policy.cooldown
    ) {
      return "cooldown";
    }
    const { perHour, perDay } = this.#policy.budget;
    if (marker.budget.hour >= perHour || marker.budget.day >= perDay) {
      const window = `${marker.budget.hourStart}:${marker.budget.dayStart}`;
      if (this.#budgetNoted !== window) {
        this.#budgetNoted = window;
        this.#logger.warn("summon budget exhausted; jobs wait", {
          hour: marker.budget.hour,
          perHour,
          day: marker.budget.day,
          perDay,
        });
        this.safeEmit("summon", {
          id: "",
          outcome: "budget-exhausted",
          kind: this.#summoner.provider.kind,
        });
      }
      return "budget";
    }
    if (marker.pending.length >= this.#policy.maxPending) {
      return "pending";
    }
    return undefined;
  }

  /** Counts one failure: the backoff, and the circuit once enough have run. */
  #fail(
    marker: SummonMarker,
    now: number,
    retryAfterMs?: number,
    countsTowardCircuit = true,
  ): void {
    if (countsTowardCircuit) {
      marker.failures++;
    }
    const wait = Math.max(
      backoffFor(Math.max(1, marker.failures), this.#policy.backoff),
      retryAfterMs ?? 0,
    );
    marker.backoffUntil = Math.max(marker.backoffUntil ?? 0, now + wait);
    if (
      countsTowardCircuit &&
      marker.failures >= this.#policy.circuit.failures
    ) {
      marker.circuitOpenUntil = now + this.#policy.circuit.resetAfter;
      this.#logger.error("summon circuit open: too many consecutive failures", {
        failures: marker.failures,
        until: marker.circuitOpenUntil,
        kind: this.#summoner.provider.kind,
      });
    }
  }

  /**
   * Writes back a marker that changed (releases, lost attempts) and announces
   * them. A lost write is simply redone by the next check, so it announces
   * nothing: whoever wins the write announces.
   */
  async #settle(
    marker: SummonMarker,
    version: number | null,
    changed: boolean,
    events: SummonEventPayload[],
    lost: PendingSummon[],
  ): Promise<void> {
    if (!changed) {
      return;
    }
    const written = await setReservedState(
      this.#driver,
      this.#ref,
      SUMMON_MARKER,
      marker,
      version,
    );
    if (written !== null) {
      this.#announce(events);
      void this.#explainLost(lost);
    }
  }

  /** Emits and logs each event, at the level §9.1 gives its outcome. */
  #announce(events: readonly SummonEventPayload[]): void {
    for (const event of events) {
      const fields = {
        id: event.id,
        kind: event.kind,
        outcome: event.outcome,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
      };
      switch (event.outcome) {
        case "failed":
          this.#logger.error("summon attempt failed", fields);
          break;
        case "lost":
        case "unavailable":
        case "budget-exhausted":
          this.#logger.warn(`summon attempt ${event.outcome}`, fields);
          break;
        default:
          this.#logger.info(`summon attempt ${event.outcome}`, fields);
      }
      this.safeEmit("summon", event);
    }
  }

  /**
   * For attempts just declared lost: asks the platform why, once, when the
   * summoner can say (`status`), and cancels a unit still pending so it
   * cannot start late (`cancel`). Best effort, after the write that declared
   * them lost, so only one controller asks.
   */
  async #explainLost(lost: readonly PendingSummon[]): Promise<void> {
    const facet = this.#summoner.summon;
    if (facet.status === undefined) {
      return;
    }
    for (const attempt of lost) {
      if (!attempt.handles || attempt.handles.length === 0) {
        continue;
      }
      try {
        const units = await this.#call(
          async (context) => await facet.status!(attempt.handles!, context),
          attempt.id,
        );
        const detail = units.find((unit) => unit.detail)?.detail;
        if (detail !== undefined) {
          this.#logger.warn("lost summon attempt explained", {
            id: attempt.id,
            detail,
          });
        }
        const stillPending = units
          .filter((unit) => unit.state === "pending")
          .map((unit) => unit.handle);
        if (stillPending.length > 0 && facet.cancel !== undefined) {
          await this.#call(
            async (context) => await facet.cancel!(stillPending, context),
            attempt.id,
          );
        }
      } catch (error) {
        this.#logger.warn("could not explain a lost summon attempt", {
          id: attempt.id,
          error,
        });
      }
    }
  }

  /** Calls the summoner under `summonTimeout`, with a context whose signal aborts at it. */
  async #call<T>(
    fn: (context: ProviderCallContext) => Promise<T>,
    id?: string,
  ): Promise<T> {
    const abort = new AbortController();
    const ms = this.#policy.summonTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new SummonTimeoutError(ms);
        abort.abort(error);
        reject(error);
      }, ms);
    });
    const context: ProviderCallContext = {
      signal: abort.signal,
      logger: this.#logger.child(id === undefined ? {} : { attempt: id }),
      fetch: globalThis.fetch,
      now: Date.now,
    };
    try {
      return await Promise.race([fn(context), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Step 8: writes the summoner's answer onto the attempt, against a fresh
   * read, retried a few times, and announces it. Answers the outcome.
   *
   * **When every write loses** (other controllers kept changing the marker
   * for {@link RECORD_ATTEMPTS} rounds) the answer is not recorded: the
   * attempt stays in `pending` exactly as claimed — no handles, `last`
   * unchanged, the failure not counted — and is settled like any other, by a
   * registration or as `lost` once its `until` passes. The outcome is still
   * returned, emitted and logged here, with a `warn` saying it was not
   * recorded. Nothing is lost for good; a failed call is only counted late.
   */
  async #record(
    id: string,
    count: number,
    reason: SummonReason,
    result: SummonResult | undefined,
    failure: unknown,
  ): Promise<SummonOutcomeKind> {
    const outcome: SummonOutcomeKind =
      result === undefined ? "failed" : result.status;
    const handles =
      result !== undefined && "handles" in result ? result.handles : undefined;
    const detail =
      result?.status === "unavailable"
        ? result.reason
        : failure === undefined
          ? undefined
          : errorDetail(failure);
    const kind = this.#summoner.provider.kind;

    let recorded = false;
    for (let attempt = 0; attempt < RECORD_ATTEMPTS; attempt++) {
      const now = Date.now();
      const entry = await this.#driver.getQueueState!(this.#ref, SUMMON_MARKER);
      const { marker, version, unreadable } = readMarker(entry, now);
      const index = unreadable
        ? -1
        : marker.pending.findIndex((pending) => pending.id === id);
      // Gone: purged, or already released or declared lost by a check that
      // ran meanwhile. Nothing of this attempt is left to record.
      if (index === -1) {
        recorded = true;
        break;
      }
      const pending = marker.pending[index]!;
      if (outcome === "failed" || outcome === "unavailable") {
        marker.pending.splice(index, 1);
        this.#fail(
          marker,
          now,
          result?.status === "unavailable" ? result.retryAfterMs : undefined,
        );
      } else if (handles !== undefined && handles.length > 0) {
        pending.handles = [...handles];
      }
      marker.last = {
        id,
        outcome,
        at: now,
        ...(detail === undefined ? {} : { detail }),
      };
      if (
        (await setReservedState(
          this.#driver,
          this.#ref,
          SUMMON_MARKER,
          marker,
          version,
        )) !== null
      ) {
        recorded = true;
        break;
      }
    }
    if (!recorded) {
      this.#logger.warn(
        "could not record the summoner's answer: the marker kept changing; the attempt stays pending until it registers or its boot budget passes",
        { id, outcome, attempts: RECORD_ATTEMPTS },
      );
    }

    if (failure !== undefined) {
      this.#logger.error("summoner call failed", {
        id,
        kind,
        error: failure,
      });
    }
    this.#announce([
      {
        id,
        outcome,
        kind,
        count,
        reason,
        ...(handles === undefined ? {} : { handles: [...handles] }),
        ...(detail === undefined ? {} : { detail }),
      },
    ]);
    return outcome;
  }

  /** Scale style: sets the platform's count to zero. */
  async #release(): Promise<void> {
    const facet = this.#summoner.summon;
    await this.#call(
      async (context) =>
        await facet.release!(
          { namespace: this.namespace, queue: this.queue, target: 0 },
          context,
        ),
    );
    this.#released = true;
    this.#announce([
      { id: "", outcome: "released", kind: this.#summoner.provider.kind },
    ]);
  }

  /** Sweeps old claim-once entries, at most once an hour, on a poll. Best effort. */
  async #sweepClaims(now: number): Promise<void> {
    if (now - this.#claimsSweptAt < CLAIM_SWEEP_EVERY) {
      return;
    }
    this.#claimsSweptAt = now;
    try {
      await sweepSummonClaims(
        this.#driver,
        this.#ref,
        now -
          Math.max(
            SUMMON_CLAIM_RETENTION_MS,
            this.#policy.maxLifetime + this.#policy.bootBudget,
          ),
      );
    } catch (error) {
      this.#logger.warn("could not sweep summon claims", { error });
    }
  }

  /* --- status, reset, close ------------------------------------------ */

  /** The marker as it stands, plus this controller's policy. Reads; writes nothing. */
  async status(): Promise<SummonStatus> {
    await this.#connect();
    const now = Date.now();
    const entry = await this.#driver.getQueueState!(this.#ref, SUMMON_MARKER);
    const { marker } = readMarker(entry, now);
    rollBudget(marker, now);
    const { perHour, perDay } = this.#policy.budget;
    return {
      queue: this.queue,
      local: true,
      inert: this.inert,
      summoner: {
        provider: this.#summoner.provider,
        capabilities: this.#summoner.summon.capabilities,
        facts: this.#summoner.describe(),
      },
      pending: marker.pending,
      failures: marker.failures,
      ...(marker.backoffUntil !== undefined && marker.backoffUntil > now
        ? { backoffUntil: marker.backoffUntil }
        : {}),
      ...(marker.circuitOpenUntil !== undefined && marker.circuitOpenUntil > now
        ? { circuitOpenUntil: marker.circuitOpenUntil }
        : {}),
      budget: {
        hour: marker.budget.hour,
        perHour,
        day: marker.budget.day,
        perDay,
      },
      ...(marker.last === undefined ? {} : { last: marker.last }),
    };
  }

  /** Clears failures, backoff and an open circuit. Pending attempts are kept. */
  async reset(): Promise<void> {
    await this.#connect();
    for (let attempt = 0; attempt < RECORD_ATTEMPTS * 2; attempt++) {
      const entry = await this.#driver.getQueueState!(this.#ref, SUMMON_MARKER);
      if (entry === null) {
        return;
      }
      const { marker, version, unreadable } = readMarker(entry, Date.now());
      if (unreadable) {
        return;
      }
      marker.failures = 0;
      delete marker.backoffUntil;
      delete marker.circuitOpenUntil;
      if (
        (await setReservedState(
          this.#driver,
          this.#ref,
          SUMMON_MARKER,
          marker,
          version,
        )) !== null
      ) {
        return;
      }
    }
    throw new ConfigError(
      "Could not reset the summon marker: other controllers kept writing it",
      { queue: this.queue },
    );
  }

  /**
   * Stops the triggers and waits for a check in flight, including its
   * summoner call (bounded by `summonTimeout`). Leaves the marker as it is.
   * Idempotent.
   */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#pollTimer !== undefined) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }
    if (this.#debounceTimer !== undefined) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = undefined;
    }
    if (this.#dueTimer !== undefined) {
      clearTimeout(this.#dueTimer.timer);
      this.#dueTimer = undefined;
    }
    for (const source of this.#sources) {
      source.off("added", this.#onAdded);
    }
    this.#sources.clear();
    const subscription = this.#subscription;
    this.#subscription = undefined;
    const unsubscribe = await subscription;
    await unsubscribe?.().catch((error: unknown) => {
      this.#logger.warn("summon events unsubscribe failed", { error });
    });
    await this.#chain;
  }
}
