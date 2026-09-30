import type {
  JobsDriver,
  QueueDemand,
  QueueRef,
  WorkerInfo,
} from "../drivers/index";
import type { FacetReadiness } from "../provider/configure";
import type { ProviderErrorKind } from "../provider/errors";
import type { LocalAddedJob } from "../queue/BunQueue";
import type { Logger } from "../shared/logger";
import type { SummonClaim } from "./claim";
import type { MarkerRead } from "./marker";
import type {
  PendingSummon,
  ProviderCallContext,
  SummonCapabilities,
  SummonCheckResult,
  SummonControllerEvents,
  SummonControllerOptions,
  Summoner,
  SummonEventPayload,
  SummonFacet,
  SummonMarker,
  SummonOutcomeKind,
  SummonReason,
  SummonRequest,
  SummonResult,
  SummonSkipReason,
  SummonStatus,
  UnitStatus,
  WatchedSummon,
} from "./types";
import process from "node:process";
import {
  DEFAULT_DEMAND_CAP,
  listWorkerRecords,
  readDemand,
  supportsWorkers,
} from "../drivers/index";
import { facetReadiness, providerSecrets } from "../provider/configure";
import { providerCallContext } from "../provider/context";
import { providerErrorFacts } from "../provider/errors";
import { redactingLogger, textRedactor } from "../provider/redact";
import { registerProvider, warnUnmappedThrow } from "../provider/version";
import { LOCAL_ADD_HOOKS } from "../queue/BunQueue";
import { MAX_TIMER_MS } from "../queue/BunQueueWorker";
import { setReservedState } from "../queue/windows";
import { CHILD_ENV } from "../runner/protocol";
import { TypedEmitterBase } from "../shared/emitter";
import { ConfigError, JobsError } from "../shared/errors";
import { queueEvent } from "../shared/events";
import { newToken } from "../shared/ids";
import { assertNamespace, assertSegment } from "../shared/keys";
import { createJobsLogger } from "../shared/logger";
import { SUMMON_ARGS } from "./args";
import {
  openSummonClaim,
  readSummonClaims,
  SUMMON_CLAIM_RETENTION_MS,
  sweepSummonClaims,
  tallySummonClaim,
} from "./claim";
import { DEFAULT_BOOT_BUDGET, toSummoner } from "./define";
import {
  attemptId,
  backoffFor,
  dedupeKeyFor,
  readMarker,
  rollBudget,
  SUMMON_MARKER,
} from "./marker";
import { RUN_SUMMONED_DEFAULTS } from "./worker";

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
/**
 * The longest detail stored on the marker and sent in events: a longer one
 * (a provider passing a response body as its `platformCode`) is cut to this,
 * ending in `…`.
 */
const DETAIL_MAX = 128;
/** How many times a result is written back against a fresh read before giving up. */
const RECORD_ATTEMPTS = 3;
/** The fewest attempts the watch list holds, whatever the policy. */
const WATCH_FLOOR = 8;
/** The most attempts the watch list holds, whatever the policy. */
const WATCH_CAP = 256;
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

/**
 * Internal: the key of the lookup the management API finds a queue's summon
 * controller with. It answers a controller this context already has — from
 * the `summon` option or `summonController()` — or `undefined`, and never
 * builds one (`summonController(queue)` would, from the option). A symbol,
 * so it adds nothing to the public surface; exported from this module alone
 * (`BunJobs` answers it), never from the package root.
 */
export const FIND_SUMMON_CONTROLLER: unique symbol = Symbol(
  "bun-jobs: find summon controller",
);

/**
 * What the `onAdd` trigger hooks into: a queue's private local-add hooks
 * (`LOCAL_ADD_HOOKS` in `queue/BunQueue.ts`), called for each job this
 * process adds through it. Not the public `added` event: see there why.
 */
export interface AddedSource {
  /** The hooks, `undefined` while none is set. */
  [LOCAL_ADD_HOOKS]: ((job: AddedJob) => void)[] | undefined;
}

/** The two fields of an added job the fast path reads. */
export type AddedJob = LocalAddedJob;

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

/** How many live records carry an attempt's id: its workers still running. */
function liveWithId(workers: readonly WorkerInfo[], id: string): number {
  return workers.filter((worker) => worker.summon?.id === id).length;
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

/**
 * What a code or a name must look like to be used as a detail: an
 * identifier, not prose. A value outside it (a credential, a URL, a response
 * body) is refused, and the next choice is taken.
 */
const CODE_SHAPED = /^[\w.:-]{1,64}$/;

/** `value` if it is a code-shaped string, else `undefined`. */
function codeShaped(value: unknown): string | undefined {
  return typeof value === "string" && CODE_SHAPED.test(value)
    ? value
    : undefined;
}

/**
 * A short, secret-free name for a thrown value, never its message: a
 * `ProviderError`'s `platformCode`, else its `PROVIDER_<KIND>` code; any other
 * error's code, else its name, else `"error"`. A `platformCode`, code or name
 * is taken only if it is code-shaped (`[A-Za-z0-9_.:-]{1,64}`), so a
 * credential or a response body passed as one never becomes the detail.
 */
function errorDetail(error: unknown): string {
  if (error instanceof SummonTimeoutError) {
    return "timeout";
  }
  if (error instanceof ProviderNotReadyError) {
    return error.detail;
  }
  const provider = providerErrorFacts(error);
  if (provider !== undefined) {
    return codeShaped(provider.platformCode) ?? provider.code;
  }
  if (error instanceof Error) {
    return (
      codeShaped((error as { code?: unknown }).code) ??
      codeShaped(error.name) ??
      "error"
    );
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

/** The detail of an attempt whose provider's `ready` outlasted `summonTimeout`. */
const READY_TIMED_OUT = "ready timed out";

/**
 * The summoner's provider was not ready for this attempt: its asynchronous
 * config validation failed, or did not settle within `summonTimeout`. The
 * attempt is recorded as `failed` with `detail`; the summoner is not called.
 */
class ProviderNotReadyError extends Error {
  constructor(
    /** The attempt's detail: `"ready timed out"`, or the failure's code or name. */
    readonly detail: string,
    /** What validation threw, when it threw. */
    cause?: unknown,
  ) {
    super(
      detail === READY_TIMED_OUT
        ? "the summoner's provider did not become ready in time"
        : "the summoner's provider is not ready: its config validation failed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "ProviderNotReadyError";
  }
}

/**
 * How a failed attempt is treated (plugins §6.5): the kind of the
 * `ProviderError` the call threw — or its `ready` rejected with — with the
 * wait the platform asked for, and whether it was one at all. Anything else is
 * `transient`, as every failure was before provider errors existed.
 */
function classify(failure: unknown): {
  /** How it is treated. */
  kind: ProviderErrorKind;
  /** The platform's requested wait, for `throttled` and `quota`. */
  retryAfterMs?: number;
  /** Whether the provider said so: a `ProviderError`, not an unmapped throw. */
  mapped: boolean;
} {
  const facts = providerErrorFacts(
    failure instanceof ProviderNotReadyError ? failure.cause : failure,
  );
  if (facts === undefined) {
    return { kind: "transient", mapped: false };
  }
  return {
    kind: facts.kind,
    mapped: true,
    ...((facts.kind === "throttled" || facts.kind === "quota") &&
    facts.retryAfterMs !== undefined
      ? { retryAfterMs: facts.retryAfterMs }
      : {}),
  };
}

/** A lost attempt the summoner may explain, and its `lost` event, held back until it has. */
interface LostAttempt {
  /** The attempt. */
  attempt: PendingSummon;
  /** Its `lost` event, announced once `status()` has answered (or failed). */
  event: SummonEventPayload;
}

/**
 * What the controller assumes of a provider whose config is still validating
 * (asynchronously), until it is: `defineSummoner`'s defaults. Only the steps
 * before the call read them; the call itself waits for the real facet.
 */
const PROVISIONAL_CAPABILITIES: SummonCapabilities = Object.freeze({
  style: "launch",
  dedupe: Object.freeze({ kind: "none" as const }),
  passes: "argv",
  bootBudgetMs: DEFAULT_BOOT_BUDGET,
  shutdown: Object.freeze({ signal: "SIGTERM" as const, graceMs: 10_000 }),
  maxLifetimeMs: null,
  enforcesLifetime: false,
});

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
 * Emits `summon` locally for every attempt that changes state, and publishes
 * it through the driver (whatever `publishEvents` says), where every queue
 * that subscribes re-emits it and the management API's socket forwards it.
 * Built by `jobs.summonController(queue)` or from `BunJobsOptions.summon`, or
 * directly.
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
   * Whether it is inert: built in a summoned process or a runner child
   * without `fromSummoned` (then no trigger is ever armed), or it found the
   * queue's marker written by a newer bun-jobs, which it leaves alone rather
   * than overwrite. An inert controller summons nothing: `check()` answers
   * `skipped: "inert"` at once, reading nothing. It stays inert until it is
   * rebuilt; `status().inertReason` says why.
   */
  get inert(): boolean {
    return this.#inertReason !== undefined;
  }

  /** The backend. */
  readonly #driver: JobsDriver;
  /** The queue as the driver addresses it. */
  readonly #ref: QueueRef;
  /** Where it logs. */
  readonly #logger: Logger;
  /** The summoner, normalised. */
  readonly #summoner: Summoner;
  /** The options, kept to resolve the policy again when a provider's facet is adopted late. */
  readonly #options: SummonControllerOptions;
  /**
   * The facet the controller calls: the summoner's, or — for a provider whose
   * config is still validating — its stand-in, never called before adoption.
   */
  #facet!: SummonFacet;
  /** The facet's capabilities, or provisional ones until a late facet is adopted. */
  #capabilities!: SummonCapabilities;
  /**
   * Set while the summoner's provider validates its config asynchronously:
   * how its real facet stands, and how to wait for it. Cleared once adopted.
   */
  #pending: FacetReadiness | undefined;
  /**
   * A `ConfigError` the late-adopted facet's capabilities raised (a scale
   * style without `release`, a lifetime over the platform's cap, …): as
   * permanent as at construction, so every check throws it.
   */
  #adoptError: unknown;
  /** Whether the current run of not-ready attempts has been warned about. */
  #warnedNotReady = false;
  /** Whether `#adoptError` has been logged by a triggered check; every check still throws it. */
  #loggedAdoptError = false;
  /** Whether the one `warn` about a shutdown grace under `runSummoned`'s `shutdownBuffer` was logged. */
  #warnedGrace = false;
  /** Whether the one `warn` about a `retryAfterMs` clamped to the longest wait was logged. */
  #warnedRetryClamp = false;
  /**
   * How many of this controller's attempts in a row were `throttled`, which
   * the circuit never counts; any other outcome resets it. In memory, per
   * controller: see {@link #noteThrottled}.
   */
  #throttledRun = 0;
  /** Lost attempts being explained by the summoner's `status()`; `close()` waits for them. */
  readonly #explaining = new Set<Promise<void>>();
  /** Whether a background validation (`#kickProvider`) is running, so kicks never pile up. */
  #kicking = false;
  /** The policy with its defaults. */
  #policy!: ResolvedPolicy;
  /** Turns an attempt id into the platform's dedupe key. */
  #dedupeKey!: (id: string) => string;
  /** Why the controller is inert, or `undefined` while it is live. */
  #inertReason: "summoned-process" | "newer-marker" | undefined;
  /**
   * The `cap` each check reads demand with: `DEFAULT_DEMAND_CAP`, raised to
   * `maxWorkers × jobsPerWorker` when that is finite and larger (§6.4 D3), so
   * a capped `outstanding` can never under-state how many workers are wanted.
   */
  #demandCap!: number;
  /** Whether the last events subscription failed, so the next poll tick retries it. */
  #subscribeFailed = false;
  /** Whether the current run of subscription failures has been warned about. */
  #warnedSubscribe = false;
  /** Whether the one `warn` about approximate (`exact: false`) demand was logged. */
  #warnedInexact = false;
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
  /**
   * This controller's token on the events it publishes, so every queue
   * that subscribes — in this process or another — re-emits them, and none
   * mistakes them for its own.
   */
  readonly #origin = newToken();
  /**
   * The `summon` events being published, chained so they reach the backend
   * in the order they happened; `close()` waits for them.
   */
  #publishing: Promise<void> = Promise.resolve();

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
    this.#options = options;
    // A provider whose config validates asynchronously has no facet yet: the
    // controller runs on provisional capabilities, and adopts the real ones
    // when its first attempt finds the config ready.
    const readiness = facetReadiness(this.#summoner.summon);
    const facet = readiness.settled();
    if (facet === undefined) {
      this.#pending = readiness;
      this.#bind(this.#summoner.summon, PROVISIONAL_CAPABILITIES);
    } else {
      this.#bind(facet, facet.capabilities);
    }
    if (!driver.capabilities.multiHost) {
      this.#logger.warn(
        "this driver works on one host only: a summoned worker must run on this host to reach it",
        { driver: driver.name, kind: this.#summoner.provider.kind },
      );
    }
    registerProvider(this.#summoner.provider, this.#logger);

    if (options.fromSummoned !== true && inSummonedProcess()) {
      this.#inertReason = "summoned-process";
    }
    if (this.inert) {
      this.#logger.info(
        "summon controller inert: this process was summoned or is a runner child (set fromSummoned to override)",
      );
      return;
    }
    this.#warnShortGrace();

    if (this.#policy.poll !== false) {
      this.#pollTimer = setInterval(() => {
        if (this.#subscribeFailed && !this.#closed) {
          this.#subscribeFailed = false;
          this.#subscription = this.#subscribe();
        }
        this.#trigger("poll");
      }, this.#policy.poll);
      this.#pollTimer.unref?.();
    }
    if (this.#policy.events) {
      this.#subscription = this.#subscribe();
    }
  }

  /**
   * Reads a facet's capabilities into the controller: the checks that need
   * them, the dedupe key, the policy and the demand cap. Assigns nothing
   * until every check has passed.
   *
   * @throws {ConfigError} for a scale style without `release`, a dedupe
   *   charset that is not a character class, or a policy the capabilities
   *   rule out (see `#resolve`).
   */
  #bind(facet: SummonFacet, capabilities: SummonCapabilities): void {
    if (capabilities.style === "scale" && typeof facet.release !== "function") {
      throw new ConfigError(
        "A scale-style summoner needs release(): nothing else can set its count back to zero",
        { kind: this.#summoner.provider.kind },
      );
    }
    let dedupeKey: (id: string) => string;
    try {
      dedupeKey = dedupeKeyFor(capabilities.dedupe);
    } catch (error) {
      throw new ConfigError(
        "The summoner's dedupe charset is not a valid character class",
        { error: String(error) },
      );
    }
    const policy = this.#resolve(this.#options, capabilities);
    const product = policy.maxWorkers * policy.jobsPerWorker;
    this.#facet = facet;
    this.#capabilities = capabilities;
    this.#dedupeKey = dedupeKey;
    this.#policy = policy;
    this.#demandCap = Number.isFinite(product)
      ? Math.max(
          DEFAULT_DEMAND_CAP,
          Math.min(Math.ceil(product), Number.MAX_SAFE_INTEGER),
        )
      : DEFAULT_DEMAND_CAP;
  }

  /**
   * One `warn`, once per controller, when the platform's grace after its stop
   * signal is shorter than `runSummoned`'s `shutdownBuffer` (plugins §7.1):
   * the worker stops claiming that long before a deadline, and a platform
   * that kills sooner after a signal can cut off a job the buffer was meant
   * to protect. For every provider, `defineSummoner` included — its default
   * grace (10 s) is above the buffer, so only a grace the user set can warn —
   * and never for a signal of `"none"`, where no grace applies. Only a live
   * controller warns (an inert one summons nothing), on the real
   * capabilities: at construction, or when a late provider's are adopted.
   */
  #warnShortGrace(): void {
    if (this.#pending !== undefined) {
      return;
    }
    const { signal, graceMs, graceMaxMs } = this.#capabilities.shutdown;
    const buffer = RUN_SUMMONED_DEFAULTS.shutdownBuffer;
    if (this.#warnedGrace || signal === "none" || graceMs >= buffer) {
      return;
    }
    this.#warnedGrace = true;
    this.#logger.warn(
      `the summoner's platform allows ${graceMs}ms after its stop signal, less than runSummoned's ${buffer}ms shutdownBuffer: a job in flight at the signal may be killed before it settles; raise the platform's grace if it allows`,
      {
        provider: this.#summoner.provider.name,
        kind: this.#summoner.provider.kind,
        signal,
        graceMs,
        shutdownBuffer: buffer,
        ...(graceMaxMs === undefined ? {} : { graceMaxMs }),
      },
    );
  }

  /** Every option, checked, with its default. */
  #resolve(
    options: SummonControllerOptions,
    capabilities: SummonCapabilities,
  ): ResolvedPolicy {
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
    if (this.#closed || this.#inertReason !== undefined) {
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

  /** Hooks into a queue's local adds. Called by `BunJobs`; idempotent. */
  [ATTACH_QUEUE](source: AddedSource): void {
    if (
      this.inert ||
      this.#closed ||
      !this.#policy.onAdd ||
      this.#sources.has(source)
    ) {
      return;
    }
    source[LOCAL_ADD_HOOKS] = [
      ...(source[LOCAL_ADD_HOOKS] ?? []),
      this.#onAdded,
    ];
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
    // A timer cannot wait past MAX_TIMER_MS (about 24.8 days): a longer
    // delay overflows and fires at once. So a job due further out gets a
    // timer for the longest wait there is, re-armed until it is due.
    const timer = setTimeout(
      () => {
        this.#dueTimer = undefined;
        if (Date.now() < at) {
          this.#armDue(at);
          return;
        }
        this.#trigger("timer");
      },
      Math.min(MAX_TIMER_MS, Math.max(0, at - Date.now())),
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
      const unsubscribe = await this.#driver.subscribe(
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
      this.#warnedSubscribe = false;
      return unsubscribe;
    } catch (error) {
      // Retried from the next poll tick; one warn per run of failures.
      this.#subscribeFailed = true;
      if (!this.#warnedSubscribe) {
        this.#warnedSubscribe = true;
        this.#logger.warn(
          this.#policy.poll === false
            ? "summon events subscription failed; with the poll off it is not retried"
            : "summon events subscription failed; retrying on each poll until it succeeds",
          { error },
        );
      }
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
      // A late provider's adoption error is thrown by every check; logged once.
      if (error === this.#adoptError) {
        if (this.#loggedAdoptError) {
          return;
        }
        this.#loggedAdoptError = true;
      }
      // The error may be the provider's (a throwing release, a facet build).
      this.#providerLogger().error("summon check failed", { error, reason });
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
      readDemand(this.#driver, this.#ref, {
        now,
        cap: this.#demandCap,
        workers: records,
      }),
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

  /**
   * The body of a check. `carried` is a provider's not-ready failure from a
   * pass that waited for it: this pass, on a fresh read, records it.
   */
  async #check(
    reason: SummonReason,
    force: boolean,
    carried?: ProviderNotReadyError,
  ): Promise<SummonCheckResult> {
    if (this.#closed) {
      return { action: "skipped", reason: "closed" };
    }
    if (this.inert) {
      return { action: "skipped", reason: "inert" };
    }
    if (this.#adoptError !== undefined) {
      throw this.#adoptError;
    }
    // A late provider whose config has become ready is adopted now, before
    // anything reads capabilities — whether or not this check summons.
    if (this.#pending !== undefined) {
      this.#adoptSettled(this.#pending);
    }
    await this.#connect();
    const now = Date.now();
    const { demand, workers, read } = await this.#read(now);
    if (!demand.exact && !this.#warnedInexact) {
      this.#warnedInexact = true;
      this.#logger.warn(
        `the ${this.#driver.name} driver has no countDemand: demand is approximate (exact: false), from countJobs and nextDelayedAt`,
        { driver: this.#driver.name },
      );
    }
    if (read.newer !== undefined) {
      this.#inertReason = "newer-marker";
      this.#logger.warn(
        "the summon marker was written by a newer bun-jobs; this controller leaves it alone and stays inert",
        { markerVersion: read.newer },
      );
      return { action: "skipped", reason: "inert" };
    }

    const { marker, version } = read;
    const capabilities = this.#capabilities;
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
    // Places per attempt still pending (count > 1) that are no longer on
    // their way — registered, or started and gone — so only the rest are.
    // Worked out afresh each check, never written back.
    const partly = new Map<string, number>();
    // Until a late provider is adopted, its `passes` and boot budget are
    // unknown: step 2 decides nothing (every attempt stays as it is), so no
    // provisional decision is ever written to the marker.
    const provisional = this.#pending !== undefined;
    const claims = provisional
      ? new Map<string, SummonClaim | undefined>()
      : await this.#readClaims([...marker.pending, ...(marker.watching ?? [])]);
    const liveIds = new Set(workers.map((worker) => worker.id));
    const expiries = new Map(
      workers.map((worker) => [worker.id, worker.expiresAt]),
    );
    // Attempts released this check on a live record alone: watched below.
    const released: WatchedSummon[] = [];
    for (const attempt of marker.pending) {
      if (provisional) {
        keep.push(attempt);
        continue;
      }
      // The claim-once entry, where there is one: a worker that claimed,
      // drained and closed between two checks has no record left, but its
      // place in the claim says how it left (see `tallySummonClaim`). Every
      // live record carrying the id is one of its holders (a worker writes
      // the id only once it holds a place), so the claim decides alone —
      // including a holder still listed that has marked a failing exit.
      // Without one, live records carrying the id, as before.
      const claim = claims.get(attempt.id);
      const tally = tallySummonClaim(
        claim,
        liveIds,
        now,
        START_TIME_SLACK,
        attempt.until,
      );
      let registered =
        claim === undefined ? liveWithId(workers, attempt.id) : tally.succeeded;
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
      const failed = tally.exitedWithError + tally.died;
      const decided = registered + failed;
      // Settled once every place is decided, or at `until` — unless nothing
      // succeeded yet and a holder is still inside its grace.
      const settled =
        registered >= attempt.count ||
        decided >= attempt.count ||
        (attempt.until <= now && (registered > 0 || tally.starting === 0));
      if (!settled) {
        if (decided > 0) {
          partly.set(attempt.id, decided);
        }
        keep.push(attempt);
        continue;
      }
      changed = true;
      // A worker that ran releases the attempt: it leaves `pending`, so it is
      // never counted as capacity twice (on its way and live). Where the
      // claim cannot yet say every holder left cleanly — one is only listed,
      // still starting, or already failed — the attempt is also watched until
      // its `until`, so a worker that crashes after its first report still
      // counts (see `#watch`).
      if (registered > 0) {
        if (
          claim !== undefined &&
          tally.unmarked + tally.starting + failed > 0
        ) {
          released.push({
            id: attempt.id,
            at: now,
            until: attempt.until,
            count: attempt.count,
            kind: attempt.kind,
          });
        } else if (claim !== undefined) {
          // Every worker of it left a clean mark: proven, so the streak ends.
          delete marker.lossStreak;
        }
        // A registration resets `failures`, watched or not, as it always has:
        // failures unrelated to this worker count from zero. `lossStreak` is
        // left alone unless the attempt is proven above — a live record
        // proves nothing yet (see `#failLate`).
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
      // Started and failed, rather than never seen: say how.
      const detail =
        tally.exitedWithError > 0
          ? "exited-with-error"
          : tally.died > 0
            ? "died"
            : undefined;
      lost.push(attempt);
      this.#fail(marker, now);
      marker.last = {
        id: attempt.id,
        outcome: "lost",
        at: now,
        ...(detail === undefined ? {} : { detail }),
      };
      events.push({
        id: attempt.id,
        outcome: "lost",
        kind: attempt.kind,
        count: attempt.count,
        ...(attempt.handles === undefined ? {} : { handles: attempt.handles }),
        ...(detail === undefined ? {} : { detail }),
      });
    }
    marker.pending = keep;
    if (
      !provisional &&
      this.#watch(marker, claims, expiries, released, now, events)
    ) {
      changed = true;
    }
    rollBudget(marker, now);

    // Step 3: nothing needs a worker.
    const orphaned =
      !demand.paused && demand.active > 0 && workers.length === 0;
    // Scale style: whether the summoned count could go to zero. Nothing may be
    // running (never release mid-job, paused or not), and nothing claimable
    // may be waiting — unless the queue is paused, where nothing is claimed
    // anyway, so once its running jobs finish its workers are idle cost.
    const idle =
      demand.active === 0 &&
      (demand.paused || demand.waiting + demand.dueNow === 0);
    if (!idle) {
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
      this.#kickProvider();
      await this.#settle(marker, version, changed, events, lost);
      if (capabilities.style === "scale" && idle) {
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
      this.#kickProvider();
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

    // Step 5b: a provider whose config validates asynchronously must be ready
    // before its first call. Ready: adopt its facet and check again, on its
    // real capabilities. Not ready: check again on a fresh read (the wait may
    // have been long), where the attempt fails without a call.
    const notReady = this.#pending === undefined ? undefined : carried;
    if (this.#pending !== undefined && notReady === undefined) {
      const facet = await this.#awaitFacet(this.#pending);
      if (facet instanceof ProviderNotReadyError) {
        return await this.#check(reason, force, facet);
      }
      this.#adopt(facet);
      return await this.#check(reason, force);
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
    this.#announceSettled(events, lost);
    this.#released = false;
    this.#zeroSince = undefined;

    // Claim-once for several workers: they all start with this id, so the
    // claim is opened for `count` of them before any can start. One worker
    // needs nothing — its claim is created by the worker itself.
    if (count > 1 && notReady === undefined) {
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

    // Step 7: call — unless the provider was not ready, which fails the
    // attempt without one.
    let result: SummonResult | undefined;
    let failure: unknown = notReady;
    if (notReady === undefined) {
      [result, failure] = await this.#summon(
        id,
        count,
        counted.length + onTheirWay + count,
        kind,
        demand,
        reason,
      );
    }

    // Step 8: record.
    const outcome = await this.#record(id, count, reason, result, failure);
    return { action: "summoned", id, outcome, demand };
  }

  /** Step 7: builds the request and calls the facet. Answers its result, or what it threw. */
  async #summon(
    id: string,
    count: number,
    target: number,
    kind: string,
    demand: QueueDemand,
    reason: SummonReason,
  ): Promise<[SummonResult | undefined, unknown]> {
    const capabilities = this.#capabilities;
    const request: SummonRequest = {
      ...wireRequest(
        { id, count, target },
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

    const facet = this.#facet;
    try {
      return [
        await this.#call(
          async (context) => await facet.summon(request, context),
          id,
        ),
        undefined,
      ];
    } catch (error) {
      return [undefined, error];
    }
  }

  /**
   * Waits, at most `summonTimeout`, for the real facet of a provider whose
   * config validates asynchronously. A validation in flight is shared (the
   * provider's own); one that failed is retried. Not ready — a rejection or
   * the timeout — answers the error the attempt fails with, and logs one
   * `warn` per run of such failures.
   */
  async #awaitFacet(
    pending: FacetReadiness,
  ): Promise<SummonFacet | ProviderNotReadyError> {
    const ms = this.#policy.summonTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ProviderNotReadyError(READY_TIMED_OUT)),
        ms,
      );
    });
    const settling = pending.settle();
    try {
      const facet = await Promise.race([settling, timeout]);
      this.#warnedNotReady = false;
      return facet;
    } catch (error) {
      // A valid config whose facet could not be built: as permanent as a
      // capability error, so kept and thrown by every check.
      this.#adoptSettled(pending);
      const failure =
        error instanceof ProviderNotReadyError
          ? error
          : new ProviderNotReadyError(errorDetail(error), error);
      if (failure.detail === READY_TIMED_OUT) {
        // Not memoized: the next attempt starts a fresh validation. Only the
        // one this wait joined: another controller's newer one is left alone.
        pending.abandon(settling);
      }
      this.#noteNotReady(failure);
      return failure;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Logs one `warn` per run of not-ready failures. */
  #noteNotReady(failure: ProviderNotReadyError): void {
    if (this.#warnedNotReady) {
      return;
    }
    this.#warnedNotReady = true;
    this.#providerLogger().warn(
      "the summoner's provider is not ready: its config validation failed or has not finished; each attempt fails without a call until it is (backoff and circuit apply)",
      {
        kind: this.#summoner.provider.kind,
        provider: this.#summoner.provider.name,
        detail: failure.detail,
        error: failure.cause ?? failure,
      },
    );
  }

  /**
   * On a check that will not summon (nothing wanted), starts — or joins — a
   * late provider's validation without waiting for it, so a later check
   * finds it ready and adopts it (a scale provider can then release), and a
   * failed first validation does not pin the controller to provisional
   * capabilities.
   */
  #kickProvider(): void {
    const pending = this.#pending;
    if (
      pending === undefined ||
      this.#kicking ||
      pending.fatal() !== undefined
    ) {
      return;
    }
    // Bounded like a check's wait: a hung validation is abandoned at
    // `summonTimeout`, so the next kick starts a fresh one.
    this.#kicking = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ProviderNotReadyError(READY_TIMED_OUT)),
        this.#policy.summonTimeout,
      );
      timer.unref?.();
    });
    const settling = pending.settle();
    Promise.race([settling, timeout])
      .then(
        () => {
          this.#warnedNotReady = false;
        },
        (error: unknown) => {
          const failure =
            error instanceof ProviderNotReadyError
              ? error
              : new ProviderNotReadyError(errorDetail(error), error);
          if (failure.detail === READY_TIMED_OUT) {
            pending.abandon(settling);
          }
          if (pending.fatal() === undefined) {
            this.#noteNotReady(failure);
          }
        },
      )
      .finally(() => {
        clearTimeout(timer);
        this.#kicking = false;
      });
  }

  /**
   * Adopts a late provider's facet if its config is ready now, or keeps and
   * throws what building it threw.
   *
   * @throws the provider's build error, or a capability `ConfigError`.
   */
  #adoptSettled(pending: FacetReadiness): void {
    const fatal = pending.fatal();
    if (fatal !== undefined) {
      this.#pending = undefined;
      this.#adoptError = fatal;
      throw fatal;
    }
    const facet = pending.settled();
    if (facet !== undefined) {
      this.#adopt(facet);
    }
  }

  /**
   * Adopts a late provider's real facet: its capabilities are read as at
   * construction. A `ConfigError` then is permanent: kept, and thrown by
   * this check and every later one.
   */
  #adopt(facet: SummonFacet): void {
    this.#pending = undefined;
    try {
      this.#bind(facet, facet.capabilities);
    } catch (error) {
      this.#adoptError = error;
      throw error;
    }
    this.#warnShortGrace();
  }

  /**
   * The controller's logger, redacting the summoner's declared secrets and
   * credential shapes. Every log carrying something the provider produced — a
   * thrown error (and its cause), a result's reason, a unit's detail — goes
   * through it, never through `#logger` directly.
   */
  #providerLogger(bindings?: Record<string, unknown>): Logger {
    return redactingLogger(
      bindings === undefined ? this.#logger : this.#logger.child(bindings),
      providerSecrets(this.#summoner),
    );
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
        const exhausted: SummonEventPayload = {
          id: "",
          outcome: "budget-exhausted",
          kind: this.#summoner.provider.kind,
        };
        this.safeEmit("summon", exhausted);
        // Published like every other outcome: an operator watching another
        // process is the one who needs to know the jobs are waiting.
        this.#publish(exhausted);
      }
      return "budget";
    }
    if (marker.pending.length >= this.#policy.maxPending) {
      return "pending";
    }
    return undefined;
  }

  /**
   * Counts one failure as it happens (a failed call, an attempt lost at
   * `until` or failed before it registered): one more for `failures` and for
   * `lossStreak`, then the backoff, and the circuit once enough have run.
   */
  #fail(
    marker: SummonMarker,
    now: number,
    retryAfterMs?: number,
    countsTowardCircuit = true,
    quiet = false,
  ): boolean {
    if (countsTowardCircuit) {
      marker.failures++;
      marker.lossStreak = (marker.lossStreak ?? 0) + 1;
    }
    return this.#penalize(
      marker,
      now,
      retryAfterMs,
      countsTowardCircuit,
      quiet,
    );
  }

  /**
   * Counts a failure that opens the circuit at once: a provider's `auth` or
   * `misconfigured` error (plugins §6.5). It raises what the circuit reads —
   * `failures`, and the `lossStreak` a late loss raises it to — to at least
   * `circuit.failures`, as a run of failures would have. So the circuit
   * behaves as one opened by count: after `resetAfter` it is half-open (the
   * next failure, a late loss included, reopens it at once), and a
   * registration or a proven success closes it as usual.
   */
  #failAtOnce(marker: SummonMarker, now: number): boolean {
    const threshold = this.#policy.circuit.failures;
    marker.failures = Math.max(marker.failures + 1, threshold);
    marker.lossStreak = Math.max((marker.lossStreak ?? 0) + 1, threshold);
    return this.#penalize(marker, now, undefined, true, true);
  }

  /**
   * Counts a watched attempt's late loss. Its registration reset `failures`,
   * as every registration does, and a crash loop's registrations would keep
   * resetting it — with several attempts in flight, a loss would then only
   * ever count 1 (measured: a dense loop needed 15 losses to open a
   * 3-failure circuit). So the loss raises `failures` to `lossStreak`, the
   * failures since the last proven success, which no unproven registration
   * resets.
   *
   * The trade-off: while a healthy worker's watch is still open, a crash of
   * another attempt counts together with the failures from before that
   * registration, because nothing is proven healthy yet; the healthy watch's
   * clean end then resets the streak. And after the circuit's `resetAfter`
   * it closes with both counts kept (no decay), so the first late loss
   * reopens it at once: half-open, since no success has been proven since.
   */
  #failLate(marker: SummonMarker, now: number): void {
    // The streak first, then the max: raising `failures` to the streak as it
    // was before this loss would count this loss once for `failures + 1` and
    // not at all against the streak — one short of it, every time.
    marker.lossStreak = (marker.lossStreak ?? 0) + 1;
    marker.failures = Math.max(marker.failures + 1, marker.lossStreak);
    this.#penalize(marker, now, undefined, true);
  }

  /**
   * The backoff after a failure — at least `retryAfterMs` — and the circuit
   * once enough have run. Answers whether it opened the circuit, and logs it
   * unless `quiet`: `#record` logs once its write has landed.
   */
  #penalize(
    marker: SummonMarker,
    now: number,
    retryAfterMs: number | undefined,
    countsTowardCircuit: boolean,
    quiet = false,
  ): boolean {
    // `#record` validates and clamps a platform's wait (with its warn); the
    // clamp here only guarantees no path stores more.
    const wait = Math.max(
      backoffFor(Math.max(1, marker.failures), this.#policy.backoff),
      Math.min(retryAfterMs ?? 0, this.#longestWait()),
    );
    marker.backoffUntil = Math.max(marker.backoffUntil ?? 0, now + wait);
    if (
      countsTowardCircuit &&
      marker.failures >= this.#policy.circuit.failures
    ) {
      marker.circuitOpenUntil = now + this.#policy.circuit.resetAfter;
      if (!quiet) {
        this.#circuitOpened(marker);
      }
      return true;
    }
    return false;
  }

  /** The `error` for a circuit opened by a run of failures. */
  #circuitOpened(marker: SummonMarker): void {
    this.#logger.error("summon circuit open: too many consecutive failures", {
      failures: marker.failures,
      until: marker.circuitOpenUntil,
      kind: this.#summoner.provider.kind,
    });
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
      this.#announceSettled(events, lost);
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
          this.#providerLogger().error("summon attempt failed", fields);
          break;
        case "lost":
        case "unavailable":
        case "budget-exhausted":
          this.#providerLogger().warn(
            `summon attempt ${event.outcome}`,
            fields,
          );
          break;
        default:
          this.#logger.info(`summon attempt ${event.outcome}`, fields);
      }
      this.safeEmit("summon", event);
      this.#publish(event);
    }
  }

  /**
   * Publishes a `summon` event through the driver, so another process's
   * queue and the management API's socket hear it (§9.1). Whatever
   * `publishEvents` says: at most one per attempt state change, bounded by
   * the budget, and the only audit trail a lost attempt leaves. Never
   * rejects: a failure is logged.
   */
  #publish(event: SummonEventPayload): void {
    const envelope = queueEvent(
      {
        ns: this.namespace,
        target: this.queue,
        type: "summon",
        origin: this.#origin,
      },
      event,
    );
    this.#publishing = this.#publishing.then(async () => {
      try {
        await this.#driver.publish(envelope);
      } catch (error) {
        this.#logger.warn("could not publish a summon event", {
          error,
          id: event.id,
          outcome: event.outcome,
        });
      }
    });
  }

  /** Whether a lost attempt can be explained: the summoner has `status()`, and the attempt has handles to ask about. */
  #explainable(attempt: PendingSummon): boolean {
    return (
      this.#pending === undefined &&
      this.#facet.status !== undefined &&
      attempt.handles !== undefined &&
      attempt.handles.length > 0
    );
  }

  /**
   * Announces a settled check's events, except the `lost` event of each
   * attempt the summoner can explain: those are announced by
   * {@link #explainLost}, in the background (where `close()` can wait for
   * it), with the explanation when there is one.
   */
  #announceSettled(
    events: readonly SummonEventPayload[],
    lost: readonly PendingSummon[],
  ): void {
    const held = new Map<string, PendingSummon>(
      lost
        .filter((attempt) => this.#explainable(attempt))
        .map((attempt) => [attempt.id, attempt]),
    );
    const explain: LostAttempt[] = [];
    const now: SummonEventPayload[] = [];
    for (const event of events) {
      const attempt = event.outcome === "lost" ? held.get(event.id) : undefined;
      if (attempt === undefined) {
        now.push(event);
      } else {
        held.delete(event.id);
        explain.push({ attempt, event: { ...event } });
      }
    }
    this.#announce(now);
    if (explain.length === 0) {
      return;
    }
    const run = this.#explainLost(explain).finally(() => {
      this.#explaining.delete(run);
    });
    this.#explaining.add(run);
  }

  /**
   * For attempts just declared lost: asks the platform why, once, when the
   * summoner can say (`status`), and cancels a unit still pending so it
   * cannot start late (`cancel`). After the write that declared them lost,
   * so only one controller asks.
   *
   * The first unit's `detail` (`"CannotPullContainerError"`, `"OOMKilled"`)
   * is the explanation (plugins §7.3): it becomes the attempt's `lost`
   * event's `detail`, and `last.detail` while `last` is still this attempt.
   * The event is held back until then, and announced whatever `status()`
   * does — with the explanation, or without one when it had none, threw or
   * timed out. Best effort: never rejects.
   */
  async #explainLost(lost: readonly LostAttempt[]): Promise<void> {
    const facet = this.#facet;
    for (const { attempt, event } of lost) {
      let units: readonly UnitStatus[] = [];
      try {
        const answered = await this.#call(
          async (context) => await facet.status!(attempt.handles!, context),
          attempt.id,
        );
        units = Array.isArray(answered) ? answered : [];
        const found = units.find(
          (unit) => typeof unit.detail === "string" && unit.detail.length > 0,
        )?.detail;
        if (found !== undefined) {
          const detail = this.#redactDetail(found);
          event.detail = detail;
          await this.#writeLostDetail(attempt.id, detail);
        }
      } catch (error) {
        this.#providerLogger().warn("could not explain a lost summon attempt", {
          id: attempt.id,
          error,
        });
      }
      this.#announce([event]);
      const stillPending = units
        .filter((unit) => unit?.state === "pending")
        .map((unit) => unit.handle);
      if (stillPending.length > 0 && facet.cancel !== undefined) {
        try {
          await this.#call(
            async (context) => await facet.cancel!(stillPending, context),
            attempt.id,
          );
        } catch (error) {
          this.#providerLogger().warn(
            "could not cancel a lost summon attempt's units",
            {
              id: attempt.id,
              error,
            },
          );
        }
      }
    }
  }

  /**
   * Writes a lost attempt's explanation onto `last.detail`, while `last` is
   * still that attempt's `lost`: a later outcome is newer news, and is left
   * alone. Against a fresh read, retried like any result.
   */
  async #writeLostDetail(id: string, detail: string): Promise<void> {
    for (let attempt = 0; attempt < RECORD_ATTEMPTS; attempt++) {
      const entry = await this.#driver.getQueueState!(this.#ref, SUMMON_MARKER);
      const { marker, version, unreadable, newer } = readMarker(
        entry,
        Date.now(),
      );
      if (
        unreadable ||
        newer !== undefined ||
        marker.last?.id !== id ||
        marker.last.outcome !== "lost"
      ) {
        return;
      }
      marker.last = { ...marker.last, detail };
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
  }

  /**
   * A detail from the summoner — an `unavailable` reason, a `platformCode`, a
   * unit's `detail` — with its declared secrets and the usual credential
   * shapes redacted (plugins §13.3), since it is stored on the marker and
   * served to the UI.
   */
  #redactDetail(detail: string): string {
    const redacted = textRedactor(providerSecrets(this.#summoner))(detail);
    return redacted.length > DETAIL_MAX
      ? `${redacted.slice(0, DETAIL_MAX - 1)}…`
      : redacted;
  }

  /**
   * The longest wait a failure may impose, in ms: the larger of
   * `backoff.max` and `circuit.resetAfter`. A platform's `retryAfterMs` above
   * it is clamped, so a `throttled` answer — which never opens the circuit —
   * cannot stop summoning for years.
   */
  #longestWait(): number {
    return Math.max(this.#policy.backoff.max, this.#policy.circuit.resetAfter);
  }

  /**
   * A platform's `retryAfterMs`, from a `ProviderError` or an `unavailable`
   * result, made safe to store: dropped unless it is a finite number of 0 or
   * more (`NaN` would serialise as `null` and make the marker unreadable),
   * and clamped to {@link #longestWait}, with one `warn` per controller the
   * first time a value is clamped.
   */
  #retryAfter(value: number | undefined): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return undefined;
    }
    const cap = this.#longestWait();
    if (value <= cap) {
      return value;
    }
    if (!this.#warnedRetryClamp) {
      this.#warnedRetryClamp = true;
      this.#providerLogger().warn(
        `the summoner asked to wait ${value}ms before the next attempt; clamped to ${cap}ms, the larger of backoff.max and circuit.resetAfter`,
        {
          provider: this.#summoner.provider.name,
          kind: this.#summoner.provider.kind,
          retryAfterMs: value,
          clampedTo: cap,
        },
      );
    }
    return cap;
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
    const context: ProviderCallContext = providerCallContext(
      abort.signal,
      this.#providerLogger(id === undefined ? {} : { attempt: id }),
    );
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
   *
   * **A timeout is not a definite failure.** A call that ran past
   * `summonTimeout` may still have started the unit, so the attempt is kept
   * pending (outcome `failed`, detail `timeout`) and settled like any other:
   * released when its worker registers, or `lost` — and only then counted
   * toward backoff and the circuit — once `until` passes. A throw or an
   * `unavailable` answer removes the attempt at once.
   *
   * **A `ProviderError` says how the failure counts** (plugins §6.5), whether
   * the call threw it or the provider's `ready` rejected with it: `throttled`
   * is `unavailable`, backed off at least `retryAfterMs` and not counted
   * toward the circuit; `quota` is `unavailable` and counted; `auth` and
   * `misconfigured` are `failed` and open the circuit at once, with one
   * `error` naming the provider; `conflict` is `failed`, counted, with one
   * `error` saying the provider is not a pure function of its key. Anything
   * else — a plain `Error` included — is `transient`: `failed` and counted,
   * with one `warn` per plugin provider that it should map it. The detail is
   * the `platformCode`, else the `PROVIDER_<KIND>` code.
   */
  async #record(
    id: string,
    count: number,
    reason: SummonReason,
    result: SummonResult | undefined,
    failure: unknown,
  ): Promise<SummonOutcomeKind> {
    const timedOut = failure instanceof SummonTimeoutError;
    const notReady = failure instanceof ProviderNotReadyError;
    const mapping =
      failure === undefined || timedOut ? undefined : classify(failure);
    const refused = mapping?.kind === "throttled" || mapping?.kind === "quota";
    const outcome: SummonOutcomeKind =
      result !== undefined ? result.status : refused ? "unavailable" : "failed";
    const handles =
      result !== undefined && "handles" in result ? result.handles : undefined;
    const raw =
      result?.status === "unavailable"
        ? result.reason
        : failure === undefined
          ? undefined
          : errorDetail(failure);
    const detail = raw === undefined ? undefined : this.#redactDetail(raw);
    const retryAfterMs = this.#retryAfter(
      result?.status === "unavailable"
        ? result.retryAfterMs
        : mapping?.retryAfterMs,
    );
    const opensAtOnce =
      mapping?.kind === "auth" || mapping?.kind === "misconfigured";
    const kind = this.#summoner.provider.kind;
    // The marker as written, when the answer's write opened the circuit:
    // logged once it landed.
    let opened: SummonMarker | undefined;

    let recorded = false;
    let written = false;
    for (let attempt = 0; attempt < RECORD_ATTEMPTS; attempt++) {
      const now = Date.now();
      const entry = await this.#driver.getQueueState!(this.#ref, SUMMON_MARKER);
      const { marker, version, unreadable, newer } = readMarker(entry, now);
      const index =
        unreadable || newer !== undefined
          ? -1
          : marker.pending.findIndex((pending) => pending.id === id);
      // Gone: purged, or already released or declared lost by a check that
      // ran meanwhile. Nothing of this attempt is left to record.
      if (index === -1) {
        recorded = true;
        break;
      }
      const pending = marker.pending[index]!;
      opened = undefined;
      if (timedOut) {
        // A call that timed out may still have started the unit: the
        // attempt stays on its way until it registers, or until its `until`
        // passes and it is `lost` (counted then, like any lost attempt). A
        // new attempt now could start a second worker.
      } else if (outcome === "failed" || outcome === "unavailable") {
        marker.pending.splice(index, 1);
        const open = opensAtOnce
          ? this.#failAtOnce(marker, now)
          : this.#fail(
              marker,
              now,
              retryAfterMs,
              mapping?.kind !== "throttled",
              true,
            );
        opened = open ? marker : undefined;
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
        written = true;
        break;
      }
    }
    if (!recorded) {
      this.#logger.warn(
        "could not record the summoner's answer: the marker kept changing; the attempt stays pending until it registers or its boot budget passes",
        { id, outcome, attempts: RECORD_ATTEMPTS },
      );
    }

    // A provider that was not ready was warned about once, not per attempt.
    if (failure !== undefined && !notReady) {
      if (refused) {
        // Through the redacting logger: the error's message and `cause` are
        // the provider's, and may carry a declared secret.
        this.#providerLogger().warn(
          "summoner call refused: the platform is throttling or over quota; recorded as unavailable",
          { id, kind, error: failure },
        );
      } else {
        this.#providerLogger().error("summoner call failed", {
          id,
          kind,
          error: failure,
        });
      }
      if (mapping !== undefined && !mapping.mapped) {
        warnUnmappedThrow(this.#summoner.provider, this.#logger, failure);
      }
    }
    this.#noteThrottled(mapping?.kind === "throttled");
    this.#providerVerdict(mapping, id, detail, written ? opened : undefined);
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

  /**
   * The `error`s a failed attempt's kind calls for, once its answer is
   * written: `auth` and `misconfigured` name the provider and say the circuit
   * is open (whenever the write opened it); `conflict` names the provider's
   * bug; a circuit opened by a run of failures is logged as always.
   */
  #providerVerdict(
    /** The failure's kind, or `undefined` for a result or a timeout. */
    mapping: ReturnType<typeof classify> | undefined,
    /** The attempt. */
    id: string,
    /** Its detail. */
    detail: string | undefined,
    /** The marker as written, when the answer opened the circuit. */
    opened: SummonMarker | undefined,
  ): void {
    const provider = this.#summoner.provider;
    const fields = {
      id,
      provider: provider.name,
      kind: provider.kind,
      ...(detail === undefined ? {} : { detail }),
    };
    switch (mapping?.kind) {
      case "auth":
      case "misconfigured":
        this.#logger.error(
          `compute provider ${provider.name} reported ${
            mapping.kind === "auth"
              ? "its credentials rejected"
              : "its config invalid for the platform"
          } (PROVIDER_${mapping.kind.toUpperCase()}): ${
            opened === undefined
              ? "its answer was not recorded, so the circuit is unchanged"
              : "the summon circuit is open at once, until it resets or is reset"
          }`,
          opened === undefined
            ? fields
            : { ...fields, until: opened.circuitOpenUntil },
        );
        return;
      case "conflict":
        this.#logger.error(
          `compute provider ${provider.name} reported a conflict (PROVIDER_CONFLICT): its request was not a pure function of its key, which is a bug in the provider`,
          fields,
        );
        break;
      default:
    }
    if (opened !== undefined) {
      this.#circuitOpened(opened);
    }
  }

  /**
   * Counts consecutive `throttled` outcomes, and logs one `warn` when a run
   * reaches `circuit.failures`: throttling is not counted toward the
   * circuit, and without a `retryAfterMs` its backoff never grows, so a
   * platform that keeps throttling is retried at `backoff.initial` (bounded
   * only by the cooldown and the budget) and this is the only sign of it.
   * Any other outcome ends the run, and the next run can warn again. Per
   * controller and in memory: controllers sharing a queue count separately.
   */
  #noteThrottled(throttled: boolean): void {
    if (!throttled) {
      this.#throttledRun = 0;
      return;
    }
    this.#throttledRun++;
    if (this.#throttledRun !== this.#policy.circuit.failures) {
      return;
    }
    this.#providerLogger().warn(
      `the platform has throttled ${this.#throttledRun} summon attempts in a row; throttling is not counted toward the circuit, so attempts go on at the backoff (from ${this.#policy.backoff.initial}ms), within the cooldown and the budget`,
      {
        provider: this.#summoner.provider.name,
        kind: this.#summoner.provider.kind,
        throttled: this.#throttledRun,
      },
    );
  }

  /** Scale style: sets the platform's count to zero. */
  async #release(): Promise<void> {
    const facet = this.#facet;
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

  /**
   * Step 2's watch: settles the attempts released on a live record, and adds
   * this check's (`released`). Answers whether the marker changed — only
   * when an entry was added, dropped or evicted — so a check over a quiet
   * watch list writes nothing.
   *
   * Per watched attempt, from its claim:
   * - a holder marked code `1`: `lost`, detail `exited-with-error`;
   * - a holder gone with no mark past its grace (the later of the attempt's
   *   and its claim's `until`, plus the clock allowance): `lost`, `died`;
   * - either way one failure for the attempt, however many holders failed
   *   ({@link #failLate}: at least the loss streak), with the event and
   *   `last` saying so;
   * - every holder marked clean: it ran, proven — dropped, no event, the
   *   loss streak reset;
   * - past the grace with a holder still listed and unmarked: extended, once,
   *   to that holder's record expiry; then still listed (refreshed) or
   *   marked clean is a clean end, and gone unmarked is `died`;
   * - no claim any more (purged): dropped, nothing counted;
   * - otherwise kept.
   *
   * Bounded by {@link #watchLimit}: past it the oldest are evicted, with one
   * warn naming them — a summon is never refused for want of room.
   *
   * Limits, by design: a worker whose event loop is blocked for longer than
   * a record lifetime across the (extended) end of its watch cannot be told
   * from a dead one, and reads as `died`; a worker still alive when its
   * watch ends has run, and a crash after that is the orphan rule's. A late
   * `lost` carries no `handles`, and the summoner is not asked why.
   */
  #watch(
    /** The marker being settled. */
    marker: SummonMarker,
    /** The claims this check read, by attempt id. */
    claims: ReadonlyMap<string, SummonClaim | undefined>,
    /** The live worker records' expiries, epoch ms, by worker id. */
    live: ReadonlyMap<string, number>,
    /** Attempts released this check, to watch from now. */
    released: readonly WatchedSummon[],
    /** Now, epoch ms. */
    now: number,
    /** Where this check's events are collected. */
    events: SummonEventPayload[],
  ): boolean {
    const before = marker.watching ?? [];
    let changed = released.length > 0;
    const kept: WatchedSummon[] = [];
    for (const watched of [...before, ...released]) {
      const claim = claims.get(watched.id);
      if (claim === undefined) {
        changed = true;
        continue;
      }
      const tally = tallySummonClaim(
        claim,
        new Set(live.keys()),
        now,
        START_TIME_SLACK,
        watched.until,
      );
      const detail =
        tally.exitedWithError > 0
          ? "exited-with-error"
          : tally.died > 0
            ? "died"
            : undefined;
      if (detail !== undefined) {
        changed = true;
        this.#failLate(marker, now);
        marker.last = { id: watched.id, outcome: "lost", at: now, detail };
        events.push({
          id: watched.id,
          outcome: "lost",
          kind: watched.kind,
          count: watched.count,
          detail,
        });
        continue;
      }
      // Every worker has a clean mark: it ran, proven. The streak ends.
      if (tally.starting === 0 && tally.unmarked === 0) {
        changed = true;
        delete marker.lossStreak;
        continue;
      }
      if (tally.starting > 0 || now < watched.until + START_TIME_SLACK) {
        kept.push(watched);
        continue;
      }
      // Due to end, with a worker still listed and no mark. Its record may
      // outlive a crash by up to a record lifetime, so, once, the watch is
      // extended to that record's expiry: still listed then, it was
      // refreshed and the worker is alive; gone with no mark, it died.
      if (watched.extendedUntil === undefined) {
        const expiry = Math.max(
          ...claim.holders
            .filter((holder) => holder.exit === undefined)
            .map((holder) => live.get(holder.worker) ?? 0),
        );
        if (expiry > now) {
          changed = true;
          kept.push({ ...watched, extendedUntil: expiry });
          continue;
        }
      } else if (now < watched.extendedUntil) {
        kept.push(watched);
        continue;
      }
      // Ended clean: every worker still listed after its extension, or
      // marked clean. Proven: the streak ends.
      changed = true;
      delete marker.lossStreak;
    }
    const limit = this.#watchLimit();
    if (kept.length > limit) {
      const evicted = kept.splice(0, kept.length - limit);
      changed = true;
      this.#logger.warn(
        "summon watch list full: evicted the oldest watched attempts, whose late failures will not be counted",
        { ids: evicted.map((watched) => watched.id), limit },
      );
    }
    if (!changed) {
      return false;
    }
    if (kept.length > 0) {
      marker.watching = kept;
    } else {
      delete marker.watching;
    }
    return true;
  }

  /**
   * How many attempts may be watched at once: as many as can be released
   * within one boot budget, `maxPending × ⌈bootBudget / cooldown⌉`, at least
   * {@link WATCH_FLOOR} and at most {@link WATCH_CAP}. With no cooldown
   * nothing bounds how often attempts start, so it is the cap.
   */
  #watchLimit(): number {
    const { maxPending, bootBudget, cooldown } = this.#policy;
    if (cooldown <= 0) {
      return WATCH_CAP;
    }
    return Math.min(
      WATCH_CAP,
      Math.max(WATCH_FLOOR, maxPending * Math.ceil(bootBudget / cooldown)),
    );
  }

  /**
   * Step 2's second source: the claim of each pending attempt. One
   * queue-state read per attempt (bounded by `maxPending`), and none at all
   * when the platform passes no identity — nothing could have claimed an id
   * it never received, so those attempts release by start time alone. Read
   * even when live records already cover an attempt: a holder still listed
   * may have marked a failing exit.
   */
  async #readClaims(
    /** The marker's pending and watched attempts. */
    pending: readonly { id: string }[],
  ): Promise<Map<string, SummonClaim | undefined>> {
    if (pending.length === 0 || this.#capabilities.passes === "none") {
      return new Map();
    }
    return await readSummonClaims(
      this.#driver,
      this.#ref,
      pending.map((attempt) => attempt.id),
    );
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
        now,
      );
    } catch (error) {
      this.#logger.warn("could not sweep summon claims", { error });
    }
  }

  /* --- status, reset, close ------------------------------------------ */

  /** The marker as it stands, plus this controller's policy. Reads; writes nothing. */
  async status(): Promise<SummonStatus> {
    await this.#connect();
    // A late provider ready by now is adopted here too, so its summoner shows
    // before any check. Its errors are kept for the next check to throw.
    if (this.#pending !== undefined) {
      try {
        this.#adoptSettled(this.#pending);
      } catch {
        // Kept in `#adoptError`.
      }
    }
    const now = Date.now();
    const entry = await this.#driver.getQueueState!(this.#ref, SUMMON_MARKER);
    const { marker, newer } = readMarker(entry, now);
    if (newer !== undefined && this.#inertReason === undefined) {
      this.#inertReason = "newer-marker";
      this.#logger.warn(
        "the summon marker was written by a newer bun-jobs; this controller leaves it alone and stays inert",
        { markerVersion: newer },
      );
    }
    rollBudget(marker, now);
    const { perHour, perDay } = this.#policy.budget;
    return {
      queue: this.queue,
      local: true,
      inert: this.inert,
      ...(this.#inertReason === undefined
        ? {}
        : { inertReason: this.#inertReason }),
      // Until a late provider's facet is adopted its capabilities are
      // unknown, so the summoner is left out rather than shown provisional.
      ...(this.#pending !== undefined || this.#adoptError !== undefined
        ? {}
        : {
            summoner: {
              provider: this.#summoner.provider,
              capabilities: this.#capabilities,
              facts: this.#summoner.describe(),
            },
          }),
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

  /**
   * Clears failures, the loss streak, backoff and an open circuit. Pending
   * and watched attempts are kept, so a crash from before the reset still
   * counts one failure after it — but not the failures the reset cleared.
   *
   * @throws {JobsError} code `SUMMON_MARKER_CONTENDED` when other controllers
   *   won every write it tried; try again.
   */
  async reset(): Promise<void> {
    await this.#connect();
    for (let attempt = 0; attempt < RECORD_ATTEMPTS * 2; attempt++) {
      const entry = await this.#driver.getQueueState!(this.#ref, SUMMON_MARKER);
      if (entry === null) {
        return;
      }
      const { marker, version, unreadable, newer } = readMarker(
        entry,
        Date.now(),
      );
      // Garbage has nothing to reset, and a newer build's marker is not ours
      // to write.
      if (unreadable || newer !== undefined) {
        return;
      }
      marker.failures = 0;
      delete marker.backoffUntil;
      delete marker.circuitOpenUntil;
      // The streak too: a watched attempt lost after the reset counts one,
      // never the failures the operator just cleared.
      delete marker.lossStreak;
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
    // Contention, not configuration: other controllers kept winning the
    // write. Trying again later is the remedy.
    throw new JobsError(
      "Could not reset the summon marker: other controllers kept writing it; try again",
      "SUMMON_MARKER_CONTENDED",
      { queue: this.queue, attempts: RECORD_ATTEMPTS * 2 },
    );
  }

  /**
   * Stops the triggers and waits for a check in flight, including its
   * summoner call (bounded by `summonTimeout`), for lost attempts the
   * summoner is still explaining (each `status()` and `cancel()` bounded the
   * same way), and for the `summon` events
   * it published (for at most `summonTimeout` more; one `warn` if they are
   * still in flight). Leaves the marker as it is. Idempotent.
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
      const rest = (source[LOCAL_ADD_HOOKS] ?? []).filter(
        (hook) => hook !== this.#onAdded,
      );
      source[LOCAL_ADD_HOOKS] = rest.length > 0 ? rest : undefined;
    }
    this.#sources.clear();
    const subscription = this.#subscription;
    this.#subscription = undefined;
    const unsubscribe = await subscription;
    await unsubscribe?.().catch((error: unknown) => {
      this.#logger.warn("summon events unsubscribe failed", { error });
    });
    await this.#chain;
    // Lost attempts still being explained announce their events when the
    // summoner answers; each call is bounded by `summonTimeout`.
    await Promise.all([...this.#explaining]);
    // The last check's events, before whoever closes the driver does — but
    // bounded, like the summoner call, by `summonTimeout`: a publish that
    // never settles (a Redis client queueing commands while it reconnects)
    // must not hold `close()`.
    const waitMs = this.#policy.summonTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const published = await Promise.race([
      this.#publishing.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(resolve, waitMs, false);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (!published) {
      this.#logger.warn(
        "summon events still publishing at close; not waiting for them",
        { waitedMs: waitMs },
      );
    }
  }
}
