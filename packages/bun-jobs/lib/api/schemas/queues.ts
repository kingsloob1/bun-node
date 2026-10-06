import type { Schema } from "../schema/builder";
import { DEFAULT_DEMAND_CAP } from "../../drivers/index";
import { DEFAULT_JOBS_API_LIMITS } from "../config";
import {
  JOB_DEFAULT_BACKOFF_TYPES,
  JOB_DEFAULT_KEYS,
  JOB_DEFAULTS_APPLY_STATES,
  JOB_DEFAULTS_BOUNDS,
  MAX_ADDED_BY_STATE_SPAN_MS,
  MAX_DATE_MS,
  MAX_NAME_LENGTH,
  MIN_ANALYTICS_SPAN_MS,
  SUMMON_OUTCOMES,
  SUMMON_SKIP_REASONS,
} from "../contract/constants";
import { s } from "../schema/builder";
import { OverviewAnalyticsSchema, rangeQueryProperties } from "./analytics";
import { PageInfoSchema } from "./common";
import { BackoffSchema, RetentionSchema } from "./jobs";

/**
 * Schemas for the queue routes: counts, summaries, limits and the queue-wide
 * operations.
 */

/** A count of jobs. */
const Count = s.integer({ minimum: 0 });

/** Jobs per state. Mirrors `Record<JobState, number>`. */
export const JobCountsSchema = s.named(
  "JobCounts",
  s.object({
    waiting: Count,
    delayed: Count,
    active: Count,
    completed: Count,
    failed: Count,
    dead: Count,
    "waiting-children": Count,
  }),
);

/** A queue at a glance. Mirrors `QueueSummaryDto`. */
export const QueueSummarySchema = s.named(
  "QueueSummary",
  s.object({
    name: s.string(),
    counts: JobCountsSchema,
    total: Count,
    paused: s.boolean(),
  }),
);

/** A rate as stored: the window in milliseconds. */
const StoredRateSchema = s.object({
  max: s.integer({ minimum: 1 }),
  duration: s.integer({ minimum: 1 }),
});

/** Limits as stored. Mirrors `StoredLimits`. */
export const StoredLimitsSchema = s.named(
  "QueueLimits",
  s.object({
    rate: s.optional(StoredRateSchema),
    concurrency: s.optional(s.integer({ minimum: 1 })),
    names: s.optional(
      s.record(
        s.object({
          rate: s.optional(StoredRateSchema),
          concurrency: s.optional(s.integer({ minimum: 1 })),
        }),
      ),
    ),
  }),
);

/** A rate as given: the window in milliseconds or as a duration such as `"1 minute"`. */
const RateInputSchema = s.object({
  max: s.integer({ minimum: 1 }),
  duration: s.union(
    s.integer({ minimum: 1 }),
    s.string({ minLength: 1, maxLength: 100 }),
  ),
});

/** Limits as `PUT` takes them. Mirrors `QueueLimits`. */
export const QueueLimitsInputSchema = s.object({
  rate: s.optional(RateInputSchema),
  concurrency: s.optional(s.integer({ minimum: 1 })),
  names: s.optional(
    s.record(
      s.object({
        rate: s.optional(RateInputSchema),
        concurrency: s.optional(s.integer({ minimum: 1 })),
      }),
    ),
  ),
});

/** One queue in detail: its summary, and its limits where the backend can store them. */
export const QueueDetailSchema = s.named(
  "QueueDetail",
  s.object({
    name: s.string(),
    counts: JobCountsSchema,
    total: Count,
    paused: s.boolean(),
    limits: s.optional(s.nullable(StoredLimitsSchema)),
  }),
);

/** One minute of throughput. Mirrors `ThroughputBucket`. */
export const ThroughputBucketSchema = s.named(
  "ThroughputBucket",
  s.object({ at: s.integer(), completed: Count, failed: Count }),
);

/** A queue's recent throughput. Mirrors `QueueThroughput`. */
export const ThroughputSchema = s.named(
  "QueueThroughput",
  s.object({
    interval: s.integer({ minimum: 1 }),
    from: s.integer(),
    to: s.integer(),
    buckets: s.array(ThroughputBucketSchema),
    completed: Count,
    failed: Count,
  }),
);

/** `GET /overview`. */
export const OverviewSchema = s.named(
  "Overview",
  s.object({
    queues: Count,
    pausedQueues: Count,
    counts: JobCountsSchema,
    total: Count,
    truncated: s.boolean({
      description:
        "Whether more queues exist than `limits.maxQueues` summarised.",
    }),
    workers: s.optional(
      s.integer({
        minimum: 0,
        description:
          "Live workers across every queue summarised. Absent when the backend keeps no worker records.",
      }),
    ),
    throughput: s.optional(
      s.object({
        minutes: s.integer({ minimum: 1 }),
        completed: Count,
        failed: Count,
      }),
    ),
    throughputSeries: s.optional(
      s.named(
        "OverviewThroughputSeries",
        s.object(
          {
            interval: s.integer({ minimum: 1 }),
            from: s.integer(),
            to: s.integer(),
            buckets: s.array(ThroughputBucketSchema),
            completed: Count,
            failed: Count,
          },
          {
            description:
              "Namespace-wide throughput, one bucket per minute, in the shape of a queue's: each minute summed over the queues summarised. Present exactly when `throughput` is.",
          },
        ),
      ),
    ),
    analytics: s.optional(OverviewAnalyticsSchema),
  }),
);

/**
 * `GET /overview/added` and `GET /queues/{queue}/counts/added`: of the jobs
 * added in a range, how many are in each state now. Mirrors `AddedByStateDto`.
 */
export const AddedByStateSchema = s.named(
  "AddedByState",
  s.object(
    {
      from: s.integer({
        description: "Start of the range read, **inclusive**, epoch ms.",
      }),
      to: s.integer({
        description: "End of the range read, **exclusive**, epoch ms.",
      }),
      at: s.integer({
        description:
          "When the counts were read, epoch ms: the instant every state is as of.",
      }),
      counts: JobCountsSchema,
      total: s.integer({
        minimum: 0,
        description:
          "The sum of `counts`: the jobs added in the range that are still stored.",
      }),
      queues: s.integer({
        minimum: 0,
        description:
          "Queues summed: on `GET /overview/added` every queue the caller may see; `1` on the per-queue route.",
      }),
    },
    {
      description:
        "Of the jobs **added** (by `createdAt`) during the range, how many are in each state **now**. Only jobs still stored are counted: one removed since, by retention or a remove, clean or drain, is not, so `total` can be less than what was added. Not the analytics series: that counts completions and failed attempts by **finish** time over every job; `failed` here is the state (failed, a retry pending) and `dead` the jobs that gave up.",
    },
  ),
);

/** One bound of an added-by-state range: epoch ms or an RFC 3339 date-time. */
function addedBound(description: string): Schema<number | string> {
  return s.union(
    s.integer({
      minimum: 0,
      maximum: MAX_DATE_MS,
      description: `${description} As epoch ms.`,
    }),
    s.string({
      format: "date-time",
      description: `${description} As an RFC 3339 date-time.`,
    }),
  );
}

/**
 * `GET /overview/added` and `GET /queues/{queue}/counts/added` query: the
 * range, over `createdAt`. Mirrors `AddedByStateQuery`.
 */
export function addedByStateQuerySchema() {
  return s.query(
    s.object({
      from: s.optional(
        addedBound(
          "Start of the range over `createdAt`, **inclusive**. Defaults to `to` minus one hour.",
        ),
      ),
      to: s.optional(
        addedBound(
          `End of the range over \`createdAt\`, **exclusive**: a job created exactly here is not counted. Defaults to now. Not after \`from\`, a span over ${MAX_ADDED_BY_STATE_SPAN_MS} ms (a day) or under ${MIN_ANALYTICS_SPAN_MS} ms is 400 \`INVALID_ARGUMENT\`.`,
        ),
      ),
    }),
  );
}

/**
 * The worker schemas live in `./workers`, beside the routes that answer with
 * them, and are re-exported here because `GET /queues/{queue}/workers` is a
 * queue route in every other respect.
 */
export {
  WorkerConfigListSchema,
  WorkerConfigOverrideSchema,
  WorkerConfigSchema,
  WorkerControlSchema,
  WorkerListSchema,
  WorkerSchema,
  WorkerStateSchema,
} from "./workers";

/**
 * What a throughput or overview read covers: the deprecated `minutes`, or the
 * analytics range (`from`, `to` exclusive, `resolution`), which wins when
 * `from` or `to` is given.
 */
export function minutesQuerySchema(maxMinutes: number) {
  return s.query(
    s.object({
      minutes: s.optional(
        s.documented(
          s.integer({
            minimum: 1,
            maximum: maxMinutes,
            default: 60,
            description: `Deprecated: use \`from\`/\`to\`. Minutes back from the current one; at most ${maxMinutes}. Ignored when \`from\` or \`to\` is given.`,
          }),
          { deprecated: true },
        ),
      ),
      ...rangeQueryProperties(),
    }),
  );
}

/** `GET /queues`. */
export const QueueListSchema = s.object({
  items: s.array(QueueSummarySchema),
  truncated: s.boolean({
    description: "Whether more queues follow this page: `page.hasMore`.",
  }),
  page: PageInfoSchema,
});

/** `GET /queues` query, paged up to `limits.maxQueues` at a time. */
export function queueListQuerySchema(maxQueues: number) {
  return s.query(
    s.object({
      search: s.optional(
        s.string({
          maxLength: 200,
          description: "A substring of the queue name, ignoring case.",
        }),
      ),
      offset: s.optional(
        s.integer({
          minimum: 0,
          default: 0,
          description: "Matching queues skipped, in name order.",
        }),
      ),
      limit: s.optional(
        s.integer({
          minimum: 1,
          maximum: maxQueues,
          default: maxQueues,
          description: `Queues summarised; at most ${maxQueues} (\`limits.maxQueues\`).`,
        }),
      ),
    }),
  );
}

/**
 * `GET /queues` query with the default `limits.maxQueues`. Kept for callers
 * of the earlier export; the route builds its own from the configured cap.
 */
export const QueueListQuerySchema = queueListQuerySchema(
  DEFAULT_JOBS_API_LIMITS.maxQueues,
);

/** A queue's demand at one instant. Mirrors `QueueDemandDto`. */
export const QueueDemandSchema = s.named(
  "QueueDemand",
  s.object({
    queue: s.string({ description: "The queue's name." }),
    at: s.integer({ description: "The instant it describes, epoch ms." }),
    paused: s.boolean({
      description:
        "Whether claiming is paused. A paused queue demands nothing.",
    }),
    waiting: s.integer({ minimum: 0, description: "Jobs in `waiting`." }),
    dueNow: s.integer({
      minimum: 0,
      description:
        "Jobs in `delayed` or `failed` (retry pending) whose `runAt` has passed, not yet promoted.",
    }),
    stalled: s.integer({
      minimum: 0,
      description:
        "Jobs in `active` whose worker died holding them: what the backend's stalled sweep would recover now.",
    }),
    active: s.integer({
      minimum: 0,
      description: "Jobs in `active`, stalled ones included.",
    }),
    workers: s.integer({
      minimum: 0,
      description:
        "Live workers on the queue, from their heartbeat records, parked and paused ones included. `0` on a backend that keeps no worker records.",
    }),
    nextDueAt: s.nullable(
      s.integer({
        description:
          "The earliest `runAt` still in the future among delayed and failed jobs, epoch ms, or `null` for none.",
      }),
    ),
    demand: s.integer({
      minimum: 0,
      description:
        "`paused ? 0 : waiting + dueNow + stalled`: work a worker could claim now. What a launch-style scaler (a KEDA `ScaledJob`, an ACA event job) reads.",
    }),
    outstanding: s.integer({
      minimum: 0,
      description:
        "`paused ? 0 : demand + (active − stalled)`: every unfinished job, each once. What a scale-style scaler (a KEDA `ScaledObject`, CREMA) reads, since it stays above zero while a worker is busy.",
    }),
    capped: s.boolean({
      description: `\`true\` when a figure reached the count cap (${DEFAULT_DEMAND_CAP.toLocaleString("en-US")}, \`DEFAULT_DEMAND_CAP\`, fixed), so the figures are lower bounds. \`demand\` and \`outstanding\` are sums of capped figures and can exceed it.`,
    }),
    exact: s.boolean({
      description:
        "`false` when the backend has no `countDemand` and the figures come from a fallback: `dueNow` is 1 or 0, `stalled` is `active` when no worker is live. Right as a trigger, approximate as a count. The only signal of approximate figures: `features.demand` says only that the routes are served.",
    }),
  }),
);

/** `GET /demand`. Mirrors `QueueDemandListDto`. */
export const QueueDemandListSchema = s.named(
  "QueueDemandList",
  s.object({
    queues: s.array(QueueDemandSchema),
    truncated: s.boolean({
      description:
        "Whether more queues are visible than `limits.maxQueues`, so some were not read. Only when `queues` was not sent.",
    }),
  }),
);

/** An epoch-ms instant, described. */
const Instant = (description: string) => s.integer({ description });

/** A summon outcome, described. */
const SummonOutcomeEnum = (description: string) =>
  s.enum(SUMMON_OUTCOMES, { description });

/** How a summoner's platform dedupes a retried call. Mirrors `SummonDedupeDto`. */
const SummonDedupeSchema = s.union(
  s.object({
    kind: s.literal("token", {
      description:
        "A request token the platform remembers (ECS `clientToken`).",
    }),
    maxLength: s.integer({
      minimum: 1,
      description: "The longest key it accepts.",
    }),
    charset: s.string({
      description: "The characters it accepts, as a character-class body.",
    }),
    scope: s.string({
      description: "What the token is unique within, e.g. `cluster`.",
    }),
    ttlMs: s.optional(
      s.integer({
        minimum: 0,
        description:
          "How long the platform remembers it, in ms, when documented.",
      }),
    ),
    strict: s.boolean({
      description:
        "Whether a same-token request with different parameters is an error.",
    }),
  }),
  s.object({
    kind: s.literal("name", {
      description: "A name the platform will not create twice.",
    }),
    maxLength: s.integer({
      minimum: 1,
      description: "The longest name it accepts.",
    }),
    charset: s.string({
      description: "The characters it accepts, as a character-class body.",
    }),
  }),
  s.object({
    kind: s.literal("none", {
      description:
        "No platform dedupe: the marker's compare-and-set is the whole guard.",
    }),
  }),
);

/** What a summoner declares. Mirrors `SummonCapabilitiesDto`. */
const SummonCapabilitiesSchema = s.named(
  "SummonCapabilities",
  s.object({
    style: s.enum(["launch", "scale", "wake"], {
      description:
        "How it starts compute: `launch` starts new units, `scale` sets a count, `wake` starts one of a fixed pool.",
    }),
    dedupe: SummonDedupeSchema,
    passes: s.enum(["argv", "none"], {
      description:
        "How per-attempt values reach the process: `argv`, or `none` when the command line is fixed.",
    }),
    bootBudgetMs: s.integer({
      minimum: 0,
      description:
        "The default time an attempt counts as a worker on its way, in ms.",
    }),
    shutdown: s.object({
      signal: s.enum(["SIGTERM", "SIGINT", "none"], {
        description: "The stop signal; `none` for an in-invocation platform.",
      }),
      graceMs: s.integer({
        minimum: 0,
        description: "The grace after the signal, in ms.",
      }),
      graceMaxMs: s.optional(
        s.integer({
          minimum: 0,
          description:
            "The most the platform allows the grace to be raised to, when known.",
        }),
      ),
    }),
    maxLifetimeMs: s.nullable(
      s.integer({
        minimum: 0,
        description:
          "The platform's own cap on one unit's life, in ms, or `null` for none known.",
      }),
    ),
    enforcesLifetime: s.boolean({
      description:
        "Whether the summoner maps the requested lifetime onto the platform's cap.",
    }),
    maxCountPerCall: s.optional(
      s.integer({
        minimum: 1,
        description: "The most units one call may start, when limited.",
      }),
    ),
    poolSize: s.optional(
      s.integer({
        minimum: 1,
        description: "`wake` only: how many units the pool has.",
      }),
    ),
  }),
);

/** Who the provider behind a summoner is. Mirrors `SummonProviderDto`. */
export const SummonProviderSchema = s.object({
  name: s.string({
    description:
      "The provider's unique name. `custom:<kind>` for one made by `defineSummoner`. Never parse it.",
  }),
  version: s.string({
    description: "The provider's version, semver.",
  }),
  kind: s.string({
    description: "A short label for badges, e.g. `ecs`.",
  }),
  displayName: s.optional(
    s.string({
      description: "A human name; show `kind` when absent.",
    }),
  ),
  homepage: s.optional(
    s.string({ description: "Where its documentation lives." }),
  ),
  apiVersion: s.object({
    core: s.string({
      description: "The core plugin API version, `major.minor`.",
    }),
    summon: s.optional(s.string({ description: "The summon facet version." })),
  }),
});

/** How far a provider's config has got, described. */
export const ProviderReadinessSchema = (description: string) =>
  s.enum(["ready", "pending", "failed"], { description });

/**
 * The summon status's rule for a `describe()` fact, stated once for every
 * route that serves facts.
 */
export const SERVABLE_FACTS_NOTE =
  "Dropped whatever the provider says: a fact whose key has, or ends with, a credential word (`token`, `secret`, `key`, `password`, `passwd`, `pwd`, `credential`, `auth`, `authorization`, `bearer`, `private`, `cookie`, `session`: `apiKey`, `apikey`, `sessiontoken` and `secretArn` go, `keyspace` stays), one whose value holds a URL with userinfo (`://user:pass@`) or another credential shape (`Bearer …`, a JWT, or a `word:value` / `word=value` pair whose word contains a sensitive word such as `token`, `secret`, `auth` or `session` — which also drops `session-workers:prod`, `max_tokens=4096`, an ARN with `auth-api:prod` in it), and a `host` or `hostname` fact unless `serialize.exposeHosts` is on.";

/** A queue's summon budget usage. Mirrors `SummonBudgetDto`. */
export const SummonBudgetSchema = s.named(
  "SummonBudget",
  s.object(
    {
      hour: s.integer({
        minimum: 0,
        description: "Attempts this UTC hour.",
      }),
      perHour: s.optional(
        s.integer({
          minimum: 0,
          description: "The hourly limit. Absent while the budget is off.",
        }),
      ),
      day: s.integer({ minimum: 0, description: "Attempts this UTC day." }),
      perDay: s.optional(
        s.integer({
          minimum: 0,
          description: "The daily limit. Absent while the budget is off.",
        }),
      ),
      off: s.optional(
        s.literal(true, {
          description:
            "Present, and `true`, when the policy turned the budget off (`budget: false`): no limit applies, and the counts are shown for information.",
        }),
      ),
      hourResetsAt: Instant(
        "When the hour window ends and `hour` starts again from 0, epoch ms: the next UTC hour.",
      ),
      dayResetsAt: Instant(
        "When the day window ends and `day` starts again from 0, epoch ms: the next UTC midnight.",
      ),
    },
    {
      description:
        "Attempts counted against the summon budget in the current UTC hour and day, shared by every controller on the queue, with the answering controller's limits and when each window resets.",
    },
  ),
);

/** The most recent summon outcome. Mirrors `SummonLastOutcomeDto`. */
const SummonLastSchema = s.object({
  id: s.string({
    description:
      "The attempt it concerns; empty for an outcome no attempt owns.",
  }),
  outcome: SummonOutcomeEnum(
    "What happened. Show an outcome you do not know as the raw string.",
  ),
  at: Instant("When, epoch ms."),
  detail: s.optional(
    s.string({ description: "A short, secret-free explanation." }),
  ),
});

/** A queue's summon status. Mirrors `SummonStatusDto`. */
export const SummonStatusSchema = s.named(
  "SummonStatus",
  s.object(
    {
      queue: s.string({ description: "The queue." }),
      local: s.boolean({
        description:
          "Whether the controller runs in the API's process. Always `true` today: status and reset both need a controller in the API's process, and answer 409 `SUMMON_NOT_CONFIGURED` without one. A read of a queue whose controller runs elsewhere (`false`) is a recorded follow-up.",
      }),
      inert: s.boolean({
        description:
          'Whether that controller is inert: it summons nothing, and "summon now" answers `skipped` with reason `inert`.',
      }),
      inertReason: s.optional(
        s.enum(["summoned-process", "newer-marker"], {
          description:
            "Why it is inert: `summoned-process` (the API's process was itself summoned, or is a runner child, and the policy has no `fromSummoned`) or `newer-marker` (a newer bun-jobs wrote the queue's summon state).",
        }),
      ),
      summoner: s.optional(
        s.object({
          provider: SummonProviderSchema,
          providerId: s.optional(
            s.string({
              description:
                "The configured provider's id in the API's process, `name@version~<n>`: what `POST /providers/{id}/validate` (\"Test connection\") and `GET /providers/{id}/schema` take, percent-encoded. Stable for that process's life. Absent only for a summoner nothing can trace to a configured instance.",
            }),
          ),
          readiness: ProviderReadinessSchema(
            "Whether the summoner can be called: `ready`; `pending` while its provider's asynchronous config check is still running; `failed` when that check rejected (each attempt fails without a call and validates again; the redacted detail is on `last.detail`) or this queue's controller refused the provider for good for its policy (then `GET /providers` still says `ready`: that readiness is the config's alone).",
          ),
          capabilities: s.optional(SummonCapabilitiesSchema),
          facts: s.record(s.string(), {
            description: `Secret-free facts from the summoner's \`describe()\`, \`{}\` until its config is known. ${SERVABLE_FACTS_NOTE}`,
          }),
        }),
      ),
      pending: s.array(
        s.object({
          id: s.string({
            description:
              "The attempt's id: what the summoned worker's `summon.id` will say.",
          }),
          at: Instant("When it was claimed, epoch ms."),
          until: Instant(
            "When it stops counting as a worker on its way, epoch ms: past it, with no worker registered, the attempt is `lost`.",
          ),
          count: s.integer({
            minimum: 1,
            description: "How many workers it asked for.",
          }),
          kind: s.string({ description: "The summoner's kind." }),
          handles: s.optional(
            s.array(s.string(), {
              description:
                "The platform's identifiers for what it started. Omitted unless `serialize.exposeSummonHandles` is on (default off): a task ARN carries the AWS account id.",
            }),
          ),
        }),
        { description: "Attempts in flight, oldest first." },
      ),
      failures: s.integer({
        minimum: 0,
        description:
          "Consecutive failed or lost attempts; reset by a registration or a reset.",
      }),
      backoffUntil: s.optional(
        Instant(
          "When the backoff after a failure ends, epoch ms, while one runs.",
        ),
      ),
      circuitOpenUntil: s.optional(
        Instant("When the open circuit closes, epoch ms, while it is open."),
      ),
      budget: s.optional(SummonBudgetSchema),
      last: s.optional(SummonLastSchema),
    },
    {
      description:
        "A queue's summon status: its shared summon state (read from the backend, so the same from every process) plus the local controller's policy.",
    },
  ),
);

/** `POST /queues/:queue/summon` body. Mirrors `SummonNowBody`. */
export const SummonNowBodySchema = s.object({
  force: s.optional(
    s.boolean({
      default: true,
      description:
        'Skip the cooldown. Defaults to `true`: "summon now" means now. Never skips the circuit, the budget, the attempts already on their way, or the compare-and-set that keeps two controllers from summoning twice.',
    }),
  ),
});

/** `POST /queues/:queue/summon/reset` body. Mirrors `SummonResetBody`. */
export const SummonResetBodySchema = s.object({
  budget: s.optional(
    s.boolean({
      default: false,
      description:
        "Also clear the queue's summon budget usage: the attempts counted this UTC hour and day go to 0, in the same write as the reset. Defaults to `false`. Advertised by `/meta.features.summonResetBudget`.",
    }),
  ),
});

/** One summon controller in `GET /summon`. Mirrors `SummonListItemDto`. */
export const SummonListItemSchema = s.object({
  namespace: s.string({ description: "The queue's namespace." }),
  queue: s.string({ description: "The queue." }),
  kind: s.string({
    description: "The summoner's kind, e.g. `ecs`: a label for badges.",
  }),
  readiness: ProviderReadinessSchema(
    "Whether the summoner can be called, as `GET /queues/{queue}/summon` has it: `ready`, `pending` while its provider's config is still validating, or `failed`.",
  ),
  last: s.optional(SummonLastSchema),
  budget: SummonBudgetSchema,
});

/** `GET /summon`. Mirrors `SummonListDto`. */
export const SummonListSchema = s.named(
  "SummonList",
  s.object(
    {
      controllers: s.array(SummonListItemSchema, {
        description:
          "The summon controllers running in the API's process, by queue name, less the queues the caller cannot see. Empty when none runs here.",
      }),
    },
    {
      description:
        "Every summon controller the API can read, with its budget usage: today, the ones running in the API's process.",
    },
  ),
);

/** What one summon check did. Mirrors `SummonCheckDto`. */
export const SummonCheckSchema = s.named(
  "SummonCheck",
  s.object({
    action: s.enum(["none", "skipped", "summoned", "released"], {
      description:
        "What the check did: `none` (nothing needs a worker), `skipped` (a guard held it back; see `reason`), `summoned` (an attempt was claimed and the summoner called; see `id` and `outcome`), or `released` (a scale-style summoner was set back to zero).",
    }),
    reason: s.optional(
      s.enum(SUMMON_SKIP_REASONS, {
        description: "For `skipped`: which guard held the attempt back.",
      }),
    ),
    id: s.optional(
      s.string({ description: "For `summoned`: the attempt's id." }),
    ),
    outcome: s.optional(
      SummonOutcomeEnum(
        "For `summoned`: what the summoner answered, or `failed`.",
      ),
    ),
    demand: s.optional(QueueDemandSchema),
  }),
);

/**
 * The query both demand routes share: the representation. There is no `cap`:
 * the routes count to the package default, `DEFAULT_DEMAND_CAP`, whatever the
 * caller asks.
 */
const demandQueryProperties = () => ({
  format: s.optional(
    s.enum(["json", "prometheus"], {
      description:
        "`json` for the JSON body, `prometheus` for the Prometheus text exposition (`text/plain; version=0.0.4`). Overrides `Accept`; without it, an `Accept` preferring `text/plain` over JSON selects the exposition.",
    }),
  ),
});

/** `GET /queues/:queue/demand` query. */
export const QueueDemandQuerySchema = s.query(
  s.object(demandQueryProperties()),
);

/** `GET /demand` query: the shared one, and which queues, at most `maxQueues` of them. */
export function queueDemandListQuerySchema(maxQueues: number) {
  return s.query(
    s.object({
      queues: s.optional(
        // No `maxItems`: it would count a repeated name, and the bound is on
        // distinct names, which the route checks after removing repeats.
        s.array(s.string({ minLength: 1, maxLength: MAX_NAME_LENGTH }), {
          description: `The queues to read, repeated or comma-separated, in the order given, each once; every visible queue when absent. A name the caller cannot see (unknown, outside the allowlist, or refused \`queues.read\` under \`listQueues: "authorized"\`) is left out, never an error. At most ${maxQueues} distinct names (\`limits.maxQueues\`); more is 400 \`VALIDATION\`, and a repeat does not count.`,
        }),
      ),
      ...demandQueryProperties(),
    }),
  );
}

/** Whether a queue is paused, after pausing or resuming it. */
export const PausedSchema = s.object({ paused: s.boolean() });

/** `POST /queues/:queue/drain` body. */
export const DrainBodySchema = s.object({
  delayed: s.optional(
    s.boolean({
      default: false,
      description: "Also drop delayed jobs.",
    }),
  ),
});

/** How many jobs an operation touched. */
export const CountResultSchema = s.object({ count: Count });

/** The `limit` a clean uses when none is given, unless `maxClean` is lower. */
export const CLEAN_DEFAULT_LIMIT = 1000;

/**
 * The `limit` a clean uses when none is given: {@link CLEAN_DEFAULT_LIMIT},
 * or `maxClean` when that is lower. The body schema's default and `/meta`'s
 * `limits.defaultClean` both come from here.
 */
export function defaultCleanLimit(maxClean: number): number {
  return Math.min(CLEAN_DEFAULT_LIMIT, maxClean);
}

/** `POST /queues/:queue/clean` body, capped by `limits.maxClean`. */
export function cleanBodySchema(maxClean: number) {
  return s.object({
    state: s.enum([
      "completed",
      "failed",
      "dead",
      "waiting",
      "delayed",
      "waiting-children",
    ]),
    olderThan: s.integer({
      minimum: 0,
      description: "Only jobs older than this many milliseconds.",
    }),
    limit: s.optional(
      s.integer({
        minimum: 1,
        maximum: maxClean,
        default: defaultCleanLimit(maxClean),
      }),
    ),
  });
}

/** `POST /queues/:queue/clean` response. */
export const CleanResultSchema = s.object({
  count: Count,
  ids: s.array(s.string()),
});

/* ------------------------------------------------------------------ *
 * Queue job defaults
 * ------------------------------------------------------------------ */

/** A whole number inside one of `JOB_DEFAULTS_BOUNDS`, described with it. */
function bounded(
  bound: keyof typeof JOB_DEFAULTS_BOUNDS,
  description: string,
): Schema<number> {
  const { min, max } = JOB_DEFAULTS_BOUNDS[bound];
  return s.integer({
    minimum: min,
    maximum: max,
    description: `${description} ${min} … ${max}.`,
  });
}

/** Every editable option and its value, as a job would get it. Mirrors `JobDefaultsValues`. */
export const JobDefaultsValuesSchema = s.named(
  "JobDefaultsValues",
  s.object({
    attempts: s.integer({ minimum: 0 }),
    backoff: BackoffSchema,
    timeout: s.number({ minimum: 0 }),
    priority: s.number(),
    removeOnComplete: RetentionSchema,
    removeOnFail: RetentionSchema,
    keepLogs: s.integer({
      minimum: 0,
      description:
        "Log lines a job keeps; `0` (a code value only) keeps every line.",
    }),
    keepStacktraces: s.integer({ minimum: 0 }),
  }),
);

/** The stored override: the keys it sets. Mirrors `Partial<JobDefaultsValues>`. */
const JobDefaultsOverrideSchema = s.object(
  {
    attempts: s.optional(s.integer({ minimum: 0 })),
    backoff: s.optional(BackoffSchema),
    timeout: s.optional(s.number({ minimum: 0 })),
    priority: s.optional(s.number()),
    removeOnComplete: s.optional(RetentionSchema),
    removeOnFail: s.optional(RetentionSchema),
    keepLogs: s.optional(s.integer({ minimum: 0 })),
    keepStacktraces: s.optional(s.integer({ minimum: 0 })),
  },
  { description: "The stored override itself; `{}` when there is none." },
);

/** One editable job option's name. */
const JobDefaultKeySchema = s.enum(JOB_DEFAULT_KEYS);

/** A state the apply action walks. */
const JobDefaultsApplyStateSchema = s.enum(JOB_DEFAULTS_APPLY_STATES);

/** `GET`/`PUT`/`DELETE /queues/:queue/job-defaults`. Mirrors `JobDefaultsDto`. */
export const JobDefaultsSchema = s.named(
  "JobDefaults",
  s.object(
    {
      queue: s.string(),
      effective: JobDefaultsValuesSchema,
      code: JobDefaultsValuesSchema,
      codeSource: s.literal("api", {
        description:
          "`code` is this API's own queue instance's `defaultJobOptions` over the built-ins; another producer may be configured otherwise.",
      }),
      overridden: s.array(JobDefaultKeySchema, {
        description:
          "The keys the stored override replaces, in `JOB_DEFAULT_KEYS` order.",
      }),
      override: JobDefaultsOverrideSchema,
      seq: s.integer({
        minimum: 0,
        description:
          "The override's version: send it as `expectedSeq`, and as `seq` to apply it. `0` when nothing was ever stored.",
      }),
      updatedAt: s.optional(
        s.integer({
          description:
            "When the override was last written, epoch ms; absent when it never was.",
        }),
      ),
      propagationMs: s.integer({
        minimum: 0,
        description:
          "How long a producer may keep adding jobs with the previous defaults after a change: this API's queue's `jobDefaultsRefreshInterval`.",
      }),
      pending: s.named(
        "JobDefaultsPending",
        s.object(
          {
            waiting: Count,
            delayed: Count,
            failed: Count,
            "waiting-children": Count,
            total: Count,
          },
          {
            description:
              "Jobs pending in each state the apply action walks, from the queue's counts: an upper bound on what it would change. Apply with `dryRun` for the exact figure.",
          },
        ),
      ),
    },
    {
      description:
        "A queue's job defaults. Precedence, highest first: an option passed on the job's own `add()`; the stored override; the code's defaults (a `define()` definition's, then the queue's `defaultJobOptions`); the built-ins.",
    },
  ),
);

/** A backoff a client may store: fixed ms, or `fixed`/`exponential`. Mirrors `JobDefaultBackoff`. */
const JobDefaultBackoffSchema = s.union(
  bounded("backoffDelay", "A fixed delay between attempts, ms:"),
  s.object({
    type: s.enum(JOB_DEFAULT_BACKOFF_TYPES),
    delay: bounded("backoffDelay", "Base delay, ms:"),
    max: s.optional(
      bounded(
        "backoffMax",
        "Longest delay before jitter, ms, and at least `delay`:",
      ),
    ),
    jitter: s.optional(
      s.number({
        minimum: JOB_DEFAULTS_BOUNDS.backoffJitter.min,
        maximum: JOB_DEFAULTS_BOUNDS.backoffJitter.max,
        description: "Fraction of each delay randomised.",
      }),
    ),
  }),
);

/** A retention a client may store. Mirrors `RetentionDto`, bounded. */
const JobDefaultRetentionSchema = s.union(
  s.boolean(),
  bounded("retentionCount", "Most finished jobs kept:"),
  s.object({
    count: s.optional(bounded("retentionCount", "Most finished jobs kept:")),
    ttl: s.optional(bounded("retentionTtl", "Oldest finished job kept, ms:")),
  }),
);

/** `PUT /queues/:queue/job-defaults` body. Mirrors `JobDefaultsBody`. */
export const JobDefaultsBodySchema = s.named(
  "JobDefaultsBody",
  s.object(
    {
      attempts: s.optional(
        s.nullable(
          bounded("attempts", "Attempts in total, including the first:"),
        ),
      ),
      backoff: s.optional(s.nullable(JobDefaultBackoffSchema)),
      timeout: s.optional(
        s.nullable(bounded("timeout", "Per-attempt timeout, ms, 0 for none:")),
      ),
      priority: s.optional(
        s.nullable(bounded("priority", "Lower runs first:")),
      ),
      removeOnComplete: s.optional(s.nullable(JobDefaultRetentionSchema)),
      removeOnFail: s.optional(s.nullable(JobDefaultRetentionSchema)),
      keepLogs: s.optional(
        s.nullable(
          bounded(
            "keepLogs",
            "Log lines a job keeps (`0`, keep every line, is refused):",
          ),
        ),
      ),
      keepStacktraces: s.optional(
        s.nullable(bounded("keepStacktraces", "Failure stack traces kept:")),
      ),
      expectedSeq: s.optional(
        s.integer({
          minimum: 0,
          description:
            "The `seq` last read. Answered 409 CONTROL_CONTENDED when it no longer matches. Omit it for a last-writer-wins write.",
        }),
      ),
    },
    {
      description:
        "A merge patch: a key left out is untouched, `null` clears it so the code's value applies again. A retention object needs `count`, `ttl` or both, and a backoff's `max` is at least its `delay` (400 VALIDATION otherwise).",
    },
  ),
);

/** `DELETE /queues/:queue/job-defaults` query. Mirrors `ResetJobDefaultsQuery`. */
export const ResetJobDefaultsQuerySchema = s.query(
  s.object({
    expectedSeq: s.optional(
      s.integer({
        minimum: 0,
        description:
          "The `seq` last read. Answered 409 CONTROL_CONTENDED when it no longer matches, and nothing is reset.",
      }),
    ),
  }),
);

/** How many jobs an apply call examines when none is named, unless `maxApplyDefaults` is lower. */
export const APPLY_DEFAULTS_DEFAULT_LIMIT = 1000;

/**
 * The `limit` an apply call uses when none is given:
 * {@link APPLY_DEFAULTS_DEFAULT_LIMIT}, or `maxApplyDefaults` when lower.
 */
export function defaultApplyDefaultsLimit(maxApplyDefaults: number): number {
  return Math.min(APPLY_DEFAULTS_DEFAULT_LIMIT, maxApplyDefaults);
}

/** The longest cursor an apply call accepts; the drivers' are far shorter. */
const MAX_APPLY_CURSOR_LENGTH = 2048;

/** `POST /queues/:queue/job-defaults/apply` body, capped by `limits.maxApplyDefaults`. Mirrors `ApplyJobDefaultsBody`. */
export function applyJobDefaultsBodySchema(maxApplyDefaults: number) {
  return s.object({
    seq: s.integer({
      minimum: 0,
      description:
        "The override version being applied: the `seq` the user confirmed. 409 DEFAULTS_CHANGED when the stored override has moved on.",
    }),
    keys: s.optional(
      s.array(JobDefaultKeySchema, {
        minItems: 1,
        description:
          "Which overridden keys to write. Defaults to every key the override sets; one it does not set is 400 INVALID_ARGUMENT.",
      }),
    ),
    states: s.optional(
      s.array(JobDefaultsApplyStateSchema, {
        minItems: 1,
        description:
          "Which states to walk, in this order. Defaults to waiting, delayed, failed, waiting-children; a repeat is 400 INVALID_ARGUMENT.",
      }),
    ),
    limit: s.optional(
      s.integer({
        minimum: 1,
        maximum: maxApplyDefaults,
        default: defaultApplyDefaultsLimit(maxApplyDefaults),
        description: `Most jobs to examine in this call; at most ${maxApplyDefaults} (\`limits.maxApplyDefaults\`).`,
      }),
    ),
    cursor: s.optional(
      s.string({
        minLength: 1,
        maxLength: MAX_APPLY_CURSOR_LENGTH,
        description:
          "The previous call's `next`, to continue the walk. Opaque; one this walk did not issue is 400 INVALID_ARGUMENT.",
      }),
    ),
    dryRun: s.optional(
      s.boolean({
        default: false,
        description: "Examine and count exactly as a real call, write nothing.",
      }),
    ),
    includeUnmarked: s.optional(
      s.boolean({
        default: false,
        description:
          "Also rewrite jobs added before bun-jobs recorded which options were explicit, treating every option of theirs as defaulted.",
      }),
    ),
  });
}

/** What one apply call did. Mirrors `ApplyJobDefaultsResultDto`. */
export const ApplyJobDefaultsResultSchema = s.named(
  "ApplyJobDefaultsResult",
  s.object(
    {
      seq: Count,
      keys: s.array(JobDefaultKeySchema),
      dryRun: s.boolean(),
      examined: Count,
      rewritten: Count,
      unchanged: Count,
      skippedExplicit: Count,
      skippedUnmarked: Count,
      moved: s.integer({
        minimum: 0,
        description:
          "Jobs that left the walked states between this call's read and its write, untouched. A lower bound: Redis, SQL and memory lock or run a batch atomically and report 0.",
      }),
      exhausted: s.integer({
        minimum: 0,
        description:
          "Rewritten jobs whose `attemptsMade` already reaches the new `attempts`: each runs once more and dies if that attempt fails. Counted within `rewritten`.",
      }),
      next: s.nullable(
        s.string({
          description:
            "Where the next call continues (send it as `cursor`), or null when the walk is complete.",
        }),
      ),
      done: s.boolean({ description: "`next === null`." }),
    },
    {
      description:
        "`rewritten`, `unchanged`, `skippedExplicit`, `skippedUnmarked` and `moved` add up to `examined`.",
    },
  ),
);
