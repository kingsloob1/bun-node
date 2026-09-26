import type { JobsDriver, QueueDemand } from "../drivers/index";
import type { Logger, LoggerLike } from "../shared/logger";

/**
 * The public vocabulary of summoning: what a summoner is told and answers,
 * how a queue is summoned for, and what a check reports.
 *
 * **The provider types here are a stand-in.** `ProviderIdentity`,
 * `SummonCapabilities`, `SummonDedupe`, `SummonFacet`, `UnitStatus` and
 * `ProviderCallContext` are the plugin API's (`compute-provider-plugins.md`
 * §6–§7), which has not landed yet. They are declared here with the plan's
 * shapes so `defineSummoner` and `SummonController` can be used today; the
 * plugin API replaces them with its own, unchanged in shape, and this module
 * re-exports those.
 */

/** Why a check ran. */
export type SummonReason =
  | "add"
  | "event"
  | "poll"
  | "schedule"
  | "manual"
  | "timer";

/** What one attempt ended as, as recorded on the marker and in `summon` events. */
export type SummonOutcomeKind =
  /** The platform accepted it. */
  | "started"
  /** The platform reports this attempt already ran (same token). */
  | "deduped"
  /** The unit or Machine was already up; counts as served. */
  | "already-running"
  /** The summoned worker's record appeared. */
  | "registered"
  /** The platform declined: capacity, quota, an inactive function. */
  | "unavailable"
  /** The call threw or timed out. */
  | "failed"
  /** Accepted, but no worker registered within `bootBudget`. */
  | "lost"
  /** A ceiling stopped it. */
  | "budget-exhausted"
  /** A scale-style summoner was set back to zero. */
  | "released";

/**
 * The plugin API versions a provider was written against. Stand-in for the
 * plugin API's type of the same name.
 */
export interface ProviderApiVersions {
  /** The core version, `"major.minor"`. Required. */
  core: string;
  /** The summon facet version, when the provider has a `summon` facet. */
  summon?: string;
}

/**
 * Who a provider is. Shown in logs, events, the status route and the UI.
 * Stand-in for the plugin API's type of the same name.
 */
export interface ProviderIdentity {
  /**
   * The provider's unique name: its npm package name, optionally with a
   * `:variant`, e.g. `"@kingsleyweb/bun-jobs:ecs"`. `defineSummoner` names
   * its anonymous provider `"custom:" + kind`. Never parsed.
   */
  readonly name: string;
  /** The provider's own version, semver. `"0.0.0"` for a `defineSummoner` one. */
  readonly version: string;
  /** A short label for badges and event payloads, e.g. `"ecs"`, `"fly"`. */
  readonly kind: string;
  /** A human name for the UI. Defaults to `kind`. */
  readonly displayName?: string;
  /** Where its documentation lives. */
  readonly homepage?: string;
  /** The plugin API versions it was written against. */
  readonly apiVersion: ProviderApiVersions;
}

/** How a platform dedupes a retried call, and the key it accepts. */
export type SummonDedupe =
  | {
      /** A request token the platform remembers: ECS `clientToken`, EC2 `ClientToken`. */
      kind: "token";
      /** The longest key it accepts. `request.dedupeKey` is clipped to fit. */
      maxLength: number;
      /** The characters it accepts, as a character-class body, e.g. `"A-Za-z0-9-"`. */
      charset: string;
      /** What the token is unique within, for the docs and the UI, e.g. `"cluster"`. */
      scope: string;
      /** How long the platform remembers it, in ms, when documented (ECS: up to 24 h). */
      ttlMs?: number;
      /**
       * Whether a same-token request with different parameters is an error
       * (ECS `ConflictException`). When `true`, requests must be pure
       * functions of the key — which the controller guarantees for everything
       * it builds (`SummonRequest.demand` and `reason` excepted: never send
       * those to such a platform).
       */
      strict: boolean;
    }
  | {
      /** A name the platform will not create twice: a systemd unit, a Kubernetes Job. */
      kind: "name";
      /** The longest name it accepts. */
      maxLength: number;
      /** The characters it accepts, as a character-class body. */
      charset: string;
    }
  | {
      /** No platform dedupe. The marker's compare-and-set is the whole guard. */
      kind: "none";
    };

/** What a summon facet declares. The controller reads these instead of knowing platforms by name. */
export interface SummonCapabilities {
  /**
   * How it starts compute: `"launch"` starts N new units (a race can double
   * up, so the marker is claimed first); `"scale"` sets a count, idempotent,
   * and needs `release()` to go back to zero; `"wake"` starts one of a fixed
   * pool of pre-created units, behaving as launch with `maxWorkers` clamped
   * to `poolSize`.
   */
  style: "launch" | "scale" | "wake";
  /** How the platform deduplicates a retried call. */
  dedupe: SummonDedupe;
  /**
   * How per-attempt values reach the process: `"argv"`, or `"none"` when the
   * unit's command line is fixed. With `"none"`, attempts are released by
   * start time (a live worker started at most 5 s before the attempt), not
   * by id.
   */
  passes: "argv" | "none";
  /** The default in-flight TTL, in ms. `SummonPolicy.bootBudget` overrides it. */
  bootBudgetMs: number;
  /** What the platform sends to stop a unit, and how long it waits before killing it. */
  shutdown: {
    /** The stop signal: `"SIGTERM"` on most platforms, `"SIGINT"` on Fly, `"none"` for in-invocation. */
    signal: "SIGTERM" | "SIGINT" | "none";
    /** The grace after the signal, in ms. Passed to the worker as `--bun-jobs-summon-grace-ms`. */
    graceMs: number;
    /** The most the platform allows the grace to be raised to, when known. */
    graceMaxMs?: number;
  };
  /**
   * The platform's own cap on one unit's life, in ms, or `null` for none
   * known. A `maxLifetime` above it is a `ConfigError`.
   */
  maxLifetimeMs: number | null;
  /** Whether the facet maps `request.maxLifetimeMs` onto the platform's cap. */
  enforcesLifetime: boolean;
  /** The most units one `summon()` may start, when the platform limits it. `count` is clamped to it. */
  maxCountPerCall?: number;
  /** `"wake"` only: how many units the pool has. `maxWorkers` above it is clamped, with a `warn`. */
  poolSize?: number;
}

/** What every facet call receives. Stand-in for the plugin API's type of the same name. */
export interface ProviderCallContext {
  /** Aborted when the call's timeout (`summonTimeout`) passes. Honour it. */
  readonly signal: AbortSignal;
  /** A logger bound to the controller's queue and the attempt. */
  readonly logger: Logger;
  /** The `fetch` to use for every platform call. The global one. */
  readonly fetch: typeof fetch;
  /** The host's clock, epoch ms. */
  readonly now: () => number;
}

/** One unit, as the platform reports it. */
export interface UnitStatus {
  /** The handle `summon` returned for it. */
  handle: string;
  /** Where it is. `"unknown"` when the platform no longer knows the handle. */
  state: "pending" | "running" | "exited" | "failed" | "unknown";
  /** The exit code, when it exited and the platform says. */
  exitCode?: number;
  /** A short, secret-free platform reason: `"CannotPullContainerError"`, `"OOMKilled"`. */
  detail?: string;
}

/** The summon facet: what the controller calls. */
export interface SummonFacet {
  /** What it can do. Read once, when the controller is built. */
  readonly capabilities: SummonCapabilities;
  /**
   * Starts compute for one attempt. A result when the platform answered
   * normally; a throw when it did not, which the controller records as
   * `failed`.
   */
  summon: (
    request: SummonRequest,
    context: ProviderCallContext,
  ) => Promise<SummonResult>;
  /** Scale style only, and then required: set the platform's count, usually to `0`. */
  release?: (
    request: SummonReleaseRequest,
    context: ProviderCallContext,
  ) => Promise<void>;
  /**
   * What the platform says about units it started, by handle. Optional: asked
   * once when an attempt is declared lost, to explain it.
   */
  status?: (
    handles: readonly string[],
    context: ProviderCallContext,
  ) => Promise<readonly UnitStatus[]>;
  /** Stops units by handle, best effort. Optional: used on a lost attempt whose unit is still pending. */
  cancel?: (
    handles: readonly string[],
    context: ProviderCallContext,
  ) => Promise<void>;
}

/**
 * Something that can start compute for a queue: a configured provider with a
 * `summon` facet. Made by `defineSummoner`, or by a provider plugin once the
 * plugin API lands.
 */
export interface Summoner {
  /** Who the provider is. */
  readonly provider: ProviderIdentity;
  /** The summon facet the controller calls. */
  readonly summon: SummonFacet;
  /** Secret-free facts for the status route and the UI. */
  describe: () => Readonly<Record<string, string>>;
}

/** Everything a summoner is told about one attempt. */
export interface SummonRequest {
  /** The namespace of the queue that needs a worker. */
  namespace: string;
  /** The queue that needs a worker. */
  queue: string;
  /**
   * This attempt's id, deterministic for one marker claim, so a retried call
   * is identical, and never repeated, even after the marker is deleted or
   * the namespace purged. Reaches the worker as `--bun-jobs-summon-id=` in
   * `argv`, and comes back on its heartbeat record as `summon.id`, which is
   * how the attempt is released.
   */
  id: string;
  /**
   * `id` clipped to the summoner's declared `dedupe.maxLength` and
   * `dedupe.charset` (64 characters of `[A-Za-z0-9-]` when it declares none).
   * Computed by the controller. Pass it wherever the platform offers
   * idempotency.
   */
  dedupeKey: string;
  /** How many workers a launch-style summoner should start. At least `1`. */
  count: number;
  /**
   * For a scale-style summoner: the absolute count the platform should run
   * after this call. Setting it twice is harmless.
   */
  target: number;
  /**
   * The demand reading that prompted the attempt. **Varies between two
   * readings**: never put it on the wire of a platform whose dedupe is strict.
   */
  demand: QueueDemand;
  /** Why the check ran. Like `demand`, not a function of the attempt id. */
  reason: SummonReason;
  /**
   * Environment for the summoned worker: the policy's static `env` only.
   * **Never summon identity**: an environment leaks to every descendant.
   */
  env: Readonly<Record<string, string>>;
  /**
   * The summon's identity as `--bun-jobs-summon-*=` arguments (`SUMMON_ARGS`):
   * the only channel for it. A platform that cannot pass arguments passes no
   * identity (`passes: "none"`).
   */
  argv: readonly string[];
  /** How long the summoned worker may live, in ms: the policy's `maxLifetime`. */
  maxLifetimeMs: number;
}

/** What a scale-style summoner is asked to do when demand has gone. */
export interface SummonReleaseRequest {
  /** The namespace of the queue. */
  namespace: string;
  /** The queue. */
  queue: string;
  /** The count to set. `0` scales to zero. */
  target: number;
}

/** What a summoner reports back. A throw means `failed`. */
export type SummonResult =
  | {
      /** The platform accepted the request and is starting compute. */
      status: "started";
      /** Platform identifiers of what it started: task ARNs, execution names, a Machine id. */
      handles: string[];
    }
  | {
      /** The platform's idempotency token says this attempt already ran. */
      status: "deduped";
      /** What the platform says that earlier call started, when it says. */
      handles?: string[];
    }
  | {
      /** The unit was already up. Counts as served. */
      status: "already-running";
      /** Identifiers of what is running, when known. */
      handles?: string[];
    }
  | {
      /** The platform declined without an error: no capacity, a quota, an inactive function. */
      status: "unavailable";
      /** A short, secret-free reason, shown on the status route. */
      reason: string;
      /** Try no sooner than this many ms from now. Overrides the backoff when larger. */
      retryAfterMs?: number;
    };

/** A summoner written as a plain function: shorthand for `defineSummoner({ invoke })`. */
export type SummonerFunction = (
  request: SummonRequest,
  context: ProviderCallContext,
) => Promise<SummonResult | void>;

/** How a queue is summoned for. */
export interface SummonPolicy {
  /**
   * What starts compute: a `Summoner` (from `defineSummoner` or a provider
   * plugin), or a bare function, shorthand for `defineSummoner({ invoke })`.
   */
  summoner: Summoner | SummonerFunction;
  /** What makes the controller check. */
  triggers?: {
    /**
     * Check after a job is added through a queue the controller is attached
     * to (every queue of that name a `BunJobs` with this policy creates).
     * Defaults to `true`. Costs one callback per add and nothing more while a
     * live worker is known.
     */
    onAdd?: boolean;
    /**
     * Check after an `added`, `waiting`, `delayed`, `promoted`, `resumed`,
     * `retried` or `repeatScheduled` event another process published through
     * the driver. Defaults to `true` where the driver's events cross processes
     * (`capabilities.events !== "local"`). Hears only producers that publish
     * (`publishEvents` defaults to `false`), and never a bulk add, which
     * publishes nothing; the poll covers both.
     */
    events?: boolean;
    /**
     * Check every this many ms: the only trigger that sees a delayed job come
     * due or a dead worker's lock lapse. Defaults to `30_000`; `false` turns
     * it off (the one-shot form).
     */
    poll?: number | false;
    /** Coalesce add and event triggers for this many ms. Defaults to `250`. */
    debounce?: number;
  };
  /**
   * How long an attempt counts as a worker on its way, in ms. Defaults to the
   * summoner's `capabilities.bootBudgetMs`. Too short summons twice; too long
   * delays the retry of a start that silently failed.
   */
  bootBudget?: number;
  /** The most summoned workers the queue may have at once. Defaults to `1`. */
  maxWorkers?: number;
  /**
   * Outstanding jobs one worker should take before another is summoned.
   * Defaults to `Infinity`: one worker regardless of depth.
   */
  jobsPerWorker?: number;
  /** The most unregistered attempts at once. Defaults to `maxWorkers`. */
  maxPending?: number;
  /** The least time between two attempts, in ms. Defaults to `10_000`. */
  cooldown?: number;
  /** The wait after a failed or lost attempt, doubling per consecutive failure. */
  backoff?: {
    /** The first wait, in ms. Defaults to `30_000`. */
    initial?: number;
    /** The longest wait, in ms. Defaults to `900_000`. */
    max?: number;
  };
  /** When to stop summoning altogether after repeated failures. */
  circuit?: {
    /** Consecutive failed or lost attempts that open it. Defaults to `5`. */
    failures?: number;
    /** How long it stays open, in ms, before one trial attempt. Defaults to `900_000`. */
    resetAfter?: number;
  };
  /** Cost ceilings, per queue, shared by every controller on it. */
  budget?: {
    /** Attempts per clock hour (UTC). Defaults to `30`. */
    perHour?: number;
    /** Attempts per UTC day. Defaults to `300`. */
    perDay?: number;
  };
  /**
   * The longest a summoned worker may live, in ms: passed to the worker as
   * `--bun-jobs-summon-max-lifetime-ms`, and to the platform's own cap where
   * the summoner can set one. Defaults to `3_600_000`.
   */
  maxLifetime?: number;
  /**
   * Which live workers count as serving the queue: any running worker
   * (`"any-worker"`, default) or only summoned ones (`"summoned-only"`).
   * Paused and parked workers never serve.
   */
  servedBy?: "any-worker" | "summoned-only";
  /** Scale-style only: when to set the count back to zero. */
  scaleDown?: {
    /**
     * How long the queue must have had nothing outstanding — no waiting, due
     * or active job, paused or not — first, in ms. Defaults to `300_000`.
     */
    after?: number;
  };
  /** How long one `summon()` or `release()` call may take, in ms. Defaults to `30_000`. */
  summonTimeout?: number;
  /**
   * Static environment added to every request's `env`. It must not vary per
   * attempt, and never carries summon identity.
   */
  env?: Record<string, string>;
  /**
   * Whether the controller may run in a process that was itself summoned (a
   * `--bun-jobs-summon-id=` argument) or that is a bun-jobs runner or target
   * child (`BUN_JOBS_CHILD=1`). Defaults to `false`: there the controller is
   * **inert** — no trigger is armed and `check()` answers
   * `skipped: "inert"` — so a shared config module cannot make a worker
   * summon more workers.
   */
  fromSummoned?: boolean;
}

/** What a `SummonController` is built with: a policy plus where the queue lives. */
export interface SummonControllerOptions extends SummonPolicy {
  /**
   * The driver the queue lives on. Must be multi-process, with queue state
   * and worker records; anything else is a `ConfigError`.
   */
  driver: JobsDriver;
  /** The queue's namespace. */
  namespace: string;
  /** The queue to watch. */
  queue: string;
  /** Where it logs. Any `LoggerLike`; defaults to the package's logger, named `"summon"`. */
  logger?: LoggerLike;
}

/** Why a check did not summon. */
export type SummonSkipReason =
  /** Enough live workers serve the queue. */
  | "served"
  /** Attempts already on their way cover what is wanted, or `maxPending` is reached. */
  | "pending"
  /** Too soon after the last attempt. */
  | "cooldown"
  /** Waiting out the backoff after a failure. */
  | "backoff"
  /** Too many consecutive failures: the circuit is open. */
  | "circuit-open"
  /** A cost ceiling was reached. */
  | "budget"
  /** Another controller changed the marker first. */
  | "contended"
  /** The controller is closed. */
  | "closed"
  /** The controller runs in a summoned process or runner child, without `fromSummoned`. */
  | "inert";

/** What one check did. */
export type SummonCheckResult =
  | {
      /** Nothing needs a worker: no demand, or the queue is paused. */
      action: "none";
      /** The reading it decided on. */
      demand: QueueDemand;
    }
  | {
      /** A worker is needed, or may be, but a guard held the attempt back. */
      action: "skipped";
      /** Which guard. */
      reason: Exclude<SummonSkipReason, "closed">;
      /** The reading it decided on. */
      demand: QueueDemand;
    }
  | {
      /** The controller was closed before the check could read anything. */
      action: "skipped";
      /** Always `"closed"`. */
      reason: "closed";
      /** Never read: a closed controller touches no driver. */
      demand?: undefined;
    }
  | {
      /** An attempt was claimed and the summoner called. */
      action: "summoned";
      /** The attempt's id. */
      id: string;
      /** What the summoner answered, or `failed` when it threw or timed out. */
      outcome: SummonOutcomeKind;
      /** The reading it decided on. */
      demand: QueueDemand;
    }
  | {
      /** A scale-style summoner was set back to zero. */
      action: "released";
      /** The reading it decided on. */
      demand: QueueDemand;
    };

/** One summon attempt in flight, as the marker holds it. */
export interface PendingSummon {
  /** The attempt id, `SummonRequest.id`. */
  id: string;
  /** When the attempt was claimed, epoch ms. */
  at: number;
  /** When it stops counting as a worker on its way: `at + bootBudget`. */
  until: number;
  /** How many workers it asked for. */
  count: number;
  /** The summoner's `kind`, e.g. `"ecs"`. */
  kind: string;
  /** Platform identifiers the summoner returned, once known. */
  handles?: string[];
}

/** The most recent outcome on a marker. */
export interface SummonLastOutcome {
  /** The attempt it concerns. */
  id: string;
  /** What happened. */
  outcome: SummonOutcomeKind;
  /** When, epoch ms. */
  at: number;
  /** A short, secret-free explanation: an error name, a platform reason. */
  detail?: string;
}

/** What `__win:summon` holds: the summon state of one queue, shared by every controller. */
export interface SummonMarker {
  /** Shape version, so a later release can migrate it. Always `1` here. */
  v: 1;
  /**
   * A random string written when the entry is created and never changed
   * after. Hashed into every attempt id, because the entry's version restarts
   * at `1` whenever the entry is deleted or the namespace purged, and an id
   * built from the version alone would then repeat.
   */
  epoch: string;
  /** Attempts started and not yet matched to a live worker record, oldest first. */
  pending: PendingSummon[];
  /** When the last attempt was started, epoch ms; the cooldown counts from here. */
  lastAttemptAt?: number;
  /** Consecutive failed or never-registered attempts; reset by a registration. */
  failures: number;
  /** No attempt before this epoch ms: the backoff after a failure. */
  backoffUntil?: number;
  /** While set and in the future, the circuit is open and nothing is summoned. */
  circuitOpenUntil?: number;
  /** Attempts started in the current hour and day, for the budget. */
  budget: {
    /** Start of the current hour window, epoch ms. */
    hourStart: number;
    /** Attempts started in it. */
    hour: number;
    /** Start of the current day window, epoch ms. */
    dayStart: number;
    /** Attempts started in it. */
    day: number;
  };
  /** The most recent outcome, for the status route and the UI. */
  last?: SummonLastOutcome;
}

/** What the status route and the UI read: the marker plus the local policy. */
export interface SummonStatus {
  /** The queue. */
  queue: string;
  /** Whether a controller runs in *this* process (always `true` from `controller.status()`). */
  local: boolean;
  /** Whether that controller is inert here (see `SummonPolicy.fromSummoned`). */
  inert: boolean;
  /** The summoner: its identity, its declared capabilities, and its `describe()` facts. */
  summoner?: {
    /** Who the provider is. */
    provider: ProviderIdentity;
    /** What it declared. */
    capabilities: SummonCapabilities;
    /** Secret-free facts from `describe()`. */
    facts: Readonly<Record<string, string>>;
  };
  /** Attempts in flight. */
  pending: readonly PendingSummon[];
  /** Consecutive failures. */
  failures: number;
  /** When the backoff ends, epoch ms, if one is running. */
  backoffUntil?: number;
  /** When the circuit closes, epoch ms, if it is open. */
  circuitOpenUntil?: number;
  /** Attempts used against the budget, this hour and today, with the limits. */
  budget?: {
    /** Attempts this hour. */
    hour: number;
    /** The hourly limit. */
    perHour: number;
    /** Attempts today. */
    day: number;
    /** The daily limit. */
    perDay: number;
  };
  /** The most recent outcome. */
  last?: SummonLastOutcome;
}

/** The payload of a controller's `summon` event: one attempt changed state. */
export interface SummonEventPayload {
  /**
   * The attempt's id; `""` for an outcome no single attempt owns
   * (`budget-exhausted`, `released`).
   */
  id: string;
  /** What happened to it. */
  outcome: SummonOutcomeKind;
  /** The summoner's kind. */
  kind: string;
  /** How many workers it asked for, when known. */
  count?: number;
  /** Platform identifiers, when the summoner returned some. */
  handles?: string[];
  /** Why the check that started it ran, for `started`, `failed` and the like. */
  reason?: SummonReason;
  /** A short, secret-free explanation. */
  detail?: string;
}

/**
 * The events a `SummonController` emits, locally. A type alias, not an
 * interface: an event map must be assignable to a string-keyed record.
 */
// eslint-disable-next-line ts/consistent-type-definitions -- see above
export type SummonControllerEvents = {
  /** An attempt changed state: started, registered, lost, failed, … */
  summon: (event: SummonEventPayload) => void;
};
