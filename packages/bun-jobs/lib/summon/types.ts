import type { JobsDriver, QueueDemand } from "../drivers/index";
import type { ProviderCallContext } from "../provider/context";
import type {
  ConfiguredProvider,
  ProviderIdentity,
  SummonCapabilities,
  SummonFacet,
} from "../provider/define";
import type { LoggerLike } from "../shared/logger";

/**
 * The public vocabulary of summoning: what a summoner is told and answers,
 * how a queue is summoned for, and what a check reports.
 *
 * The provider types (`ProviderIdentity`, `ProviderApiVersions`,
 * `SummonCapabilities`, `SummonDedupe`, `SummonFacet`, `UnitStatus`,
 * `ProviderCallContext`) are the plugin API's, defined in `lib/provider/`
 * (the `./provider` entry) and re-exported here unchanged, so an import
 * written against this module keeps working.
 */
export type { ProviderCallContext } from "../provider/context";
export type {
  ProviderApiVersions,
  ProviderIdentity,
  SummonCapabilities,
  SummonDedupe,
  SummonFacet,
  UnitStatus,
} from "../provider/define";

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
  /**
   * The call threw or timed out. A throw removes the attempt; a timeout
   * (detail `timeout`) keeps it pending until it registers or is `lost`,
   * since the platform may still have started the unit.
   */
  | "failed"
  /** Accepted, but no worker registered within `bootBudget`. */
  | "lost"
  /** A ceiling stopped it. */
  | "budget-exhausted"
  /** A scale-style summoner was set back to zero. */
  | "released";

/**
 * Something that can start compute for a queue: a configured provider with a
 * `summon` facet. Made by `defineSummoner`, or by calling a provider from
 * `defineComputeProvider` with its config. It carries the provider brand, so
 * a hand-built object literal is refused; a spread of a real one (to wrap
 * its facet) keeps the brand and is accepted.
 */
export interface Summoner extends ConfiguredProvider {
  /** The summon facet the controller calls. */
  readonly summon: SummonFacet;
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
      /**
       * Try no sooner than this many ms from now. Overrides the backoff when
       * larger. Ignored unless a finite number of 0 or more, and clamped to
       * the larger of `backoff.max` and `circuit.resetAfter`.
       */
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
    /**
     * Consecutive failed or lost attempts that open it. Defaults to `5`. A
     * provider's `auth` or `misconfigured` `ProviderError` opens it at once,
     * and a `throttled` one is not counted.
     */
    failures?: number;
    /** How long it stays open, in ms, before one trial attempt. Defaults to `900_000`. */
    resetAfter?: number;
  };
  /**
   * Cost ceilings, per queue, shared by every controller on it. Left out, the
   * defaults apply (`30` an hour, `300` a day); `false` turns the budget off:
   * no limit applies and `budget-exhausted` is never emitted. Attempts are
   * counted either way, so `status().budget` still shows them, and a limit
   * set later is checked against counts made while it was off.
   *
   * The counts live in the queue's shared marker, not in the policy: a
   * smaller limit (the defaults included) meets the counts a larger one left.
   * `reset({ budget: true })` clears them.
   */
  budget?:
    | false
    | {
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
     * How long the queue must have been idle first, in ms: no active job,
     * and either no waiting or due job or the queue paused (a paused queue
     * claims nothing, so once its running jobs finish its workers are idle
     * cost; it is never released mid-job). Defaults to `300_000`.
     */
    after?: number;
  };
  /**
   * How long one `summon()` or `release()` call may take, in ms, and how long
   * `close()` waits for `summon` events still being published. Defaults to
   * `30_000`.
   */
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
  /**
   * Called when summoning goes wrong for this queue: an attempt `failed`,
   * was `lost` or found the platform `unavailable`, the budget was
   * exhausted (`budget-exhausted`), or the circuit opened (`circuit-open`,
   * once per opening, not on every check it then refuses). Fired by the
   * controller that decided it — the one whose call failed, or whose write
   * declared the attempt lost or opened the circuit — so several controllers
   * on one queue, in any number of processes, call it once per outcome
   * between them (`budget-exhausted` is the exception: each controller that
   * hits the limit calls it once per budget window, as it emits the event).
   *
   * Never awaited: a slow hook does not delay the next check. A throw or a
   * rejection is logged at `warn` with the error, once per call, and changes
   * nothing else. The argument is secret-free: the same `detail` the
   * `summon` event and `status().last` carry, never a credential.
   */
  onSummonFailed?: (failure: SummonFailure) => void | Promise<void>;
}

/**
 * What `onSummonFailed` is told about: the `summon` outcomes that mean
 * summoning went wrong, plus `circuit-open`, which no `summon` event carries.
 */
export type SummonFailureOutcome =
  | Extract<
      SummonOutcomeKind,
      "failed" | "lost" | "unavailable" | "budget-exhausted"
    >
  /** The circuit opened: nothing is summoned for the queue until `until`. */
  | "circuit-open";

/** The argument of `SummonPolicy.onSummonFailed`: one failure, secret-free. */
export interface SummonFailure {
  /** What went wrong. */
  outcome: SummonFailureOutcome;
  /** The summoner's `kind`, e.g. `"ecs"`. */
  kind: string;
  /** The queue's namespace. */
  namespace: string;
  /** The queue. */
  queue: string;
  /**
   * The attempt it concerns. For `circuit-open`, the attempt whose failure
   * opened it. Absent for `budget-exhausted`, which no attempt owns.
   */
  id?: string;
  /**
   * Why the check that made the call ran, for `failed` and `unavailable`
   * (as on their `summon` event). Absent otherwise.
   */
  reason?: SummonReason;
  /**
   * A short, secret-free explanation: the `summon` event's and
   * `status().last`'s `detail` (`timeout`, `ThrottlingException`, `died`, an
   * `unavailable` reason). For `circuit-open`, the detail of the failure that
   * opened it, when it had one.
   */
  detail?: string;
  /** When the controller decided it, epoch ms. */
  at: number;
  /** For `circuit-open`: when the circuit closes again, epoch ms. */
  until?: number;
  /** For `budget-exhausted`: the attempts counted and the limits they reached. */
  budget?: {
    /** Attempts this UTC hour. */
    hour: number;
    /** The hourly limit. */
    perHour: number;
    /** Attempts this UTC day. */
    day: number;
    /** The daily limit. */
    perDay: number;
  };
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
  /** Too many consecutive failures, or a provider's `auth` or `misconfigured` error: the circuit is open. */
  | "circuit-open"
  /** A cost ceiling was reached. */
  | "budget"
  /** Another controller changed the marker first. */
  | "contended"
  /** The controller is closed. */
  | "closed"
  /**
   * The controller is inert: it runs in a summoned process or runner child
   * without `fromSummoned`, or the queue's marker is a newer version than
   * this build knows (`status().inertReason` says which).
   */
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
      reason: Exclude<SummonSkipReason, "closed" | "inert">;
      /** The reading it decided on. */
      demand: QueueDemand;
    }
  | {
      /**
       * The controller is closed or inert, so the check read nothing: it
       * answers before touching the driver.
       */
      action: "skipped";
      /** `"closed"` or `"inert"`. */
      reason: "closed" | "inert";
      /** Never read. */
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

/**
 * An attempt released on a live record whose worker has not said how it left
 * yet: watched, off the capacity count, until its `until` passes, so a
 * worker that crashes after its first report is still counted as a failure.
 */
export interface WatchedSummon {
  /** The attempt id. */
  id: string;
  /** When it was released, epoch ms: eviction takes the oldest first. */
  at: number;
  /**
   * The attempt's own `until`, epoch ms. A holder gone with no mark is
   * declared dead only past the later of this and its claim's `until`, plus
   * the clock allowance; a watch still open then ends.
   */
  until: number;
  /** How many workers the attempt asked for. */
  count: number;
  /** The summoner's `kind`. */
  kind: string;
  /**
   * When the watch was extended to, epoch ms: set once, when the watch would
   * have ended while a worker was still listed with no mark, to that
   * worker's record expiry. A record still listed then was refreshed (the
   * worker is alive: a clean end); one gone with no mark is a death. Absent
   * until then.
   */
  extendedUntil?: number;
}

/** The most recent outcome on a marker. */
export interface SummonLastOutcome {
  /** The attempt it concerns. */
  id: string;
  /** What happened. */
  outcome: SummonOutcomeKind;
  /** When, epoch ms. */
  at: number;
  /**
   * A short, secret-free explanation: a `ProviderError`'s `platformCode`,
   * else its `PROVIDER_<KIND>` code; another error's code or name; an
   * `unavailable` reason; for `lost`, the platform's reason from the
   * summoner's `status()` when it gave one. Served to API clients: a
   * provider must never put a credential in it, since only its declared
   * secrets and the usual credential shapes are redacted.
   */
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
  /**
   * Attempts released on a live record and watched until their `until` plus
   * the clock allowance (longer while a worker is gone but inside its grace,
   * and once extended to a still-listed record's expiry), so a worker that
   * dies after its first report still counts as a failure.
   * Never capacity. Optional, with `v` unchanged: a marker written before it
   * existed reads as none watched, and a controller that predates it keeps
   * the field as it found it.
   */
  watching?: WatchedSummon[];
  /** When the last attempt was started, epoch ms; the cooldown counts from here. */
  lastAttemptAt?: number;
  /**
   * Consecutive failed attempts — failed calls, attempts never registered,
   * and watched attempts whose worker then died or exited with an error, one
   * per attempt however many of its workers failed — which backoff and the
   * circuit read. Reset by any registration, watched or not, as it always
   * has been; a watched attempt lost later sets it to at least
   * {@link SummonMarker.lossStreak}.
   */
  failures: number;
  /**
   * Counted failures since the last **proven** success: every failure that
   * counts adds one, and only an attempt known to have run cleanly resets it
   * — one settled with every worker's clean exit mark, or a watch that ends
   * clean. A registration seen only by a live record proves nothing yet and
   * leaves it alone. A watched attempt's late loss raises `failures` to it,
   * so a crash loop whose registrations keep resetting `failures` still
   * opens the circuit. Absent means `0`; optional, with `v` unchanged, like
   * `watching`.
   */
  lossStreak?: number;
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
  /** Whether that controller is inert here (see `SummonController.inert`). */
  inert: boolean;
  /**
   * Why it is inert, when it is: `"summoned-process"` (a summoned process or
   * a runner child, without `fromSummoned`), or `"newer-marker"` (the queue's
   * marker was written by a newer bun-jobs, which this build leaves alone).
   */
  inertReason?: "summoned-process" | "newer-marker";
  /**
   * The summoner: its identity, how far its config has got, its declared
   * capabilities once known, and its `describe()` facts. Always present from
   * `controller.status()`.
   */
  summoner?: {
    /** Who the provider is. */
    provider: ProviderIdentity;
    /**
     * The configured instance's id in this process, `name@version~<n>`: what
     * the management API's `/providers/:id/…` routes take. Absent for a copy
     * of a configured provider that replaced both its facet and `validate`,
     * which nothing can trace back to an instance.
     */
    providerId?: string;
    /**
     * Whether the summoner can be called: `"ready"`; `"pending"` while its
     * provider's asynchronous config validation (`ready`) is still running;
     * `"failed"` when that validation rejected (the next attempt validates
     * again, and fails without a call until it passes: its detail is on
     * `last.detail`), or when the facet it produced was refused for good (a
     * scale style without `release`, a lifetime over the platform's cap:
     * every check throws it).
     */
    readiness: "ready" | "pending" | "failed";
    /** What it declared. Only when `readiness` is `"ready"`: unknown before. */
    capabilities?: SummonCapabilities;
    /** Secret-free facts from `describe()`. `{}` until the config is known. */
    facts: Readonly<Record<string, string>>;
  };
  /** Attempts in flight. */
  pending: readonly PendingSummon[];
  /**
   * Consecutive failed attempts, as the marker counts them: reset by any
   * registration, and raised to the failures since the last proven success
   * when a watched registration turns out lost.
   */
  failures: number;
  /** When the backoff ends, epoch ms, if one is running. */
  backoffUntil?: number;
  /** When the circuit closes, epoch ms, if it is open. */
  circuitOpenUntil?: number;
  /**
   * Attempts used against the budget, this hour and today, with the limits
   * and when each window resets. With the budget off (`budget: false`) the
   * counts are still shown, the limits are absent and `off` is `true`.
   */
  budget?: {
    /** Attempts this UTC hour. */
    hour: number;
    /** The hourly limit. Absent while the budget is off. */
    perHour?: number;
    /** Attempts this UTC day. */
    day: number;
    /** The daily limit. Absent while the budget is off. */
    perDay?: number;
    /** `true` when the policy turned the budget off (`budget: false`); absent otherwise. */
    off?: true;
    /** When the hour window ends and `hour` starts again from `0`, epoch ms: the next UTC hour. */
    hourResetsAt: number;
    /** When the day window ends and `day` starts again from `0`, epoch ms: the next UTC midnight. */
    dayResetsAt: number;
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
