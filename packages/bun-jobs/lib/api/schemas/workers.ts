import type { WorkerConfigKey } from "../../shared/workers";
import type { Optional, Schema } from "../schema/builder";
import { WORKER_STOP_TIMEOUT_MAX } from "../../queue/workerControl";
import {
  WORKER_CONFIG_BOUNDS,
  WORKER_CONFIG_KEYS,
  WORKER_CONTROL_ACTIONS,
  WORKER_STATES,
  WORKER_STOP_PERSISTENCE,
} from "../../shared/workers";
import { s } from "../schema/builder";

/**
 * Schemas for the worker routes: the record a worker reports, the overrides
 * stored for its stable key, and the two request bodies.
 *
 * Every table here is built from `lib/shared/workers.ts` — the states, the
 * nine settings and their bounds — rather than restated, so a setting added
 * there appears in the API, in the documents and in the validator without a
 * line changing here. The one rule the shape cannot hold is the cross-field
 * one (`heartbeatInterval` at most half of `lockDuration`), which the route
 * checks against the *merged effective* values and answers as a 400
 * `VALIDATION` issue.
 */

/** A count of something, never negative. */
const Count = s.integer({ minimum: 0 });

/** What a worker is doing, as the contract's `WorkerState`. */
export const WorkerStateSchema = s.named(
  "WorkerState",
  s.enum(WORKER_STATES, {
    description:
      "What the worker is doing. `stopping` and `restarting` are transients it passes through.",
  }),
);

/** How far a stop survives, as the contract's `WorkerStopPersistence`. */
export const WorkerStopPersistenceSchema = s.named(
  "WorkerStopPersistence",
  s.enum(WORKER_STOP_PERSISTENCE, {
    description:
      '`"process"`: only this incarnation is stopped, so a redeploy brings the worker back running. `"key"`: the stop is stored against the stable key, so every replica — including one started later — comes up stopped.',
  }),
);

/** One editable setting's documentation line, with the range it must stay in. */
function boundNote(key: WorkerConfigKey): string {
  const { min, max } = WORKER_CONFIG_BOUNDS[key];
  const unit =
    key === "concurrency" || key === "maxStalledCount" ? "" : ", in ms";
  return `${min} … ${max}${unit}.`;
}

/**
 * The settings a worker reports, as numbers rather than bounded integers: a
 * derived value can be fractional (`heartbeatInterval` is a third of
 * `lockDuration`), and what a worker *reports* is a fact, not a request to
 * validate. The bounds belong on the patch body, which is the request.
 */
const reportedValues = () =>
  Object.fromEntries(
    WORKER_CONFIG_KEYS.map((key) => [
      key,
      s.number({ minimum: 0, description: boundNote(key) }),
    ]),
  ) as { [K in WorkerConfigKey]: Schema<number> };

/** Every editable worker setting and its value. Mirrors `WorkerConfigValues`. */
export const WorkerConfigValuesSchema = s.named(
  "WorkerConfigValues",
  s.object(reportedValues(), {
    description:
      "Every editable worker setting: milliseconds except `concurrency` and `maxStalledCount`, which are counts.",
  }),
);

/** The settings an override replaces, and no others. Mirrors `Partial<WorkerConfigValues>`. */
export const WorkerConfigPatchSchema = s.named(
  "WorkerConfigPatch",
  s.object(
    Object.fromEntries(
      Object.entries(reportedValues()).map(([key, schema]) => [
        key,
        s.optional(schema),
      ]),
    ) as { [K in WorkerConfigKey]: Optional<Schema<number>> },
    {
      description:
        "The settings an override replaces; a key absent from it is left at the worker's own value.",
    },
  ),
);

/** A list of setting names, never free strings. */
const ConfigKeys = s.array(s.enum(WORKER_CONFIG_KEYS), {
  description: "Setting names, in `WORKER_CONFIG_KEYS` order.",
});

/** A worker's settings: what it runs with, what its code asked for, and the difference. */
export const WorkerConfigSchema = s.named(
  "WorkerConfig",
  s.object({
    effective: WorkerConfigValuesSchema,
    code: WorkerConfigValuesSchema,
    overridden: ConfigKeys,
    derived: s.optional(ConfigKeys),
    seq: Count,
    updatedAt: s.optional(s.integer()),
  }),
);

/** What a worker says about being controlled from outside its process. */
export const WorkerControlSchema = s.named(
  "WorkerControl",
  s.object({
    enabled: s.boolean({
      description:
        "Whether the worker listens for control at all: its `control` option, and a backend that can store the desired state.",
    }),
    mode: s.enum(["subscribe", "poll"], {
      description:
        "How it hears about a change: a driver subscription, or only its own polling.",
    }),
    appliedSeq: Count,
    configSeq: Count,
    pending: s.boolean({
      description: 'Whether it is mid-apply — `state === "restarting"`.',
    }),
    stopPersistence: WorkerStopPersistenceSchema,
    stopPersistenceOverridable: s.boolean({
      description:
        "Whether one request may override `stopPersistence` by sending `persist` on the stop route.",
    }),
    lastError: s.optional(
      s.object({
        at: s.integer(),
        message: s.string(),
        action: s.optional(s.enum(WORKER_CONTROL_ACTIONS)),
        seq: s.optional(Count),
      }),
    ),
  }),
);

/**
 * A worker consuming a queue. Mirrors `WorkerDto`: `host` and `pid` are
 * omitted when `serialize.exposeHosts` is off, and `state`, `key`, `config`
 * and `control` are absent on a worker from before remote control.
 */
export const WorkerSchema = s.named(
  "Worker",
  s.object({
    id: s.string(),
    key: s.optional(
      s.string({
        description:
          "The stable identity a config override is keyed by; absent on a worker that predates remote control.",
      }),
    ),
    service: s.optional(s.string()),
    queue: s.string(),
    state: s.optional(WorkerStateSchema),
    concurrency: Count,
    active: Count,
    paused: s.boolean(),
    startedAt: s.integer(),
    processStartedAt: s.optional(s.integer()),
    heartbeatAt: s.integer(),
    expiresAt: s.integer(),
    stale: s.optional(
      s.boolean({
        description:
          "Whether it has missed a report (over 1.5 × its effective `reportInterval`): listed, but late. Absent when it reports no config to judge it by.",
      }),
    ),
    version: s.optional(s.string()),
    completed: s.optional(
      s.integer({
        minimum: 0,
        description:
          "Jobs this incarnation has completed since it started, as of its last report. Per incarnation; absent on an older worker.",
      }),
    ),
    failed: s.optional(
      s.integer({
        minimum: 0,
        description:
          "Attempts this incarnation has failed since it started, as of its last report. Absent on an older worker.",
      }),
    ),
    rssBytes: s.optional(
      s.integer({
        minimum: 0,
        description:
          "Resident set size in bytes at its last report (`process.memoryUsage.rss()`). The memory of the **process**, not of the worker: two workers in one process report the same number, so never sum it across rows — take one row per `pid` (with `host`). Absent on an older worker.",
      }),
    ),
    heartbeatRttMs: s.optional(
      s.number({
        minimum: 0,
        description:
          "How long this worker's own heartbeat record write took, in milliseconds: the round trip to the driver, not a network ping. The **last sample**, not an average — a write cannot time itself, so it is the previous report's. Absent on a worker's first report and on an older worker.",
      }),
    ),
    sweeps: s.optional(
      s.boolean({
        description:
          'Whether this worker **takes part in** the queue\'s housekeeping sweeps — the minute pass: pruning expired results, healing repeat series, sweeping stale queue state — which is what its `maintenance` option decides. Taking part, not performing: the minute pass is leased, so on a queue of five `true` workers exactly one holds the lease on any given pass and the rest stand down — do not show it as "sweeping now". It says nothing about liveness: promoting delayed jobs, recovering stalled ones and healing flows happen on every worker and cannot be turned off. Absent on an older worker, and absent is **not** `false`: it means too old to say — so a queue counts as having no sweeper only when at least one live worker reports `false` and none reports `true`, never merely because none reports it at all.',
      }),
    ),
    config: s.optional(WorkerConfigSchema),
    control: s.optional(WorkerControlSchema),
    host: s.optional(
      s.string({ description: "Omitted with `serialize.exposeHosts: false`." }),
    ),
    pid: s.optional(
      s.integer({
        description: "Omitted with `serialize.exposeHosts: false`.",
      }),
    ),
  }),
);

/** Which live workers an override reaches, and whether each has applied it. */
const ConfigInstances = s.array(
  s.object({
    id: s.string(),
    applied: s.boolean(),
  }),
  {
    description:
      "Live workers carrying this key, and whether each has applied this version.",
  },
);

/** One stored override, whether or not a worker carrying its key is live. */
export const WorkerConfigOverrideSchema = s.named(
  "WorkerConfigOverride",
  s.object({
    queue: s.string(),
    key: s.string(),
    values: WorkerConfigPatchSchema,
    seq: Count,
    updatedAt: s.integer(),
    instances: ConfigInstances,
  }),
);

/** `GET /workers` and `GET /queues/{queue}/workers`. */
export const WorkerListSchema = s.object({
  items: s.array(WorkerSchema),
  offline: s.optional(
    s.array(WorkerConfigOverrideSchema, {
      description:
        "Stored overrides with no live worker; present only when `includeOffline` was asked for.",
    }),
  ),
});

/** `GET /queues/{queue}/worker-configs`. */
export const WorkerConfigListSchema = s.object({
  items: s.array(WorkerConfigOverrideSchema),
});

/** A repeatable exact-match filter. */
function names(what: string) {
  return s.optional(
    s.array(s.string({ maxLength: 512 }), { maxItems: 100, description: what }),
  );
}

/**
 * The filters both worker listings take, beside the queue.
 *
 * Every one is exact and repeatable (`?state=paused&state=stopped`), and they
 * are ANDed. `host` is refused 400 `INVALID_ARGUMENT` when
 * `serialize.exposeHosts` is off: filtering on a field the caller may not see
 * would answer the very question that option hides.
 */
function workerFilters() {
  return {
    service: names("Only workers in these services."),
    host: names(
      "Only workers on these hosts. Refused 400 INVALID_ARGUMENT when `serialize.exposeHosts` is off.",
    ),
    state: s.optional(
      s.array(WorkerStateSchema, {
        maxItems: WORKER_STATES.length,
        description:
          "Only workers in these states. A worker that reports none is matched as `paused` or `running`, from its `paused` flag.",
      }),
    ),
    key: names("Only workers with these stable keys."),
    includeOffline: s.optional(
      s.boolean({
        default: false,
        description:
          "Also report stored overrides whose worker is no longer live, as `offline`.",
      }),
    ),
  };
}

/** `GET /workers` query: the filters, plus the queues to look in. */
export function workerListQuerySchema() {
  return s.query(
    s.object({
      queue: names("Only workers on these queues."),
      ...workerFilters(),
    }),
  );
}

/** `GET /queues/{queue}/workers` query: the same filters; the path fixes the queue. */
export function queueWorkerListQuerySchema() {
  return s.query(s.object(workerFilters()));
}

/** Longest a control route will wait for a worker's acknowledgement, in ms. */
export const WORKER_CONTROL_WAIT_MAX = 30_000;

/** What `wait` means, wherever it is sent. */
const WAIT_NOTE = `Wait up to this many ms for the worker to acknowledge. \`0\` (the default) stores the instruction and answers 202 at once. At most ${WORKER_CONTROL_WAIT_MAX}.`;

/**
 * `POST /queues/{queue}/workers/{worker}/{pause,resume,stop,start}` query.
 *
 * `wait` belongs here because it describes the *request* — a client asking to
 * be told the worker acknowledged — rather than the instruction stored for the
 * worker, and it is what a client sends. It is still accepted in the body,
 * which {@link WorkerControlBodySchema} has always carried; the query wins when
 * both are given. `timeout` and `persist` are stop semantics, so they stay
 * body-only.
 */
export function workerControlQuerySchema() {
  return s.query(
    s.object({
      wait: s.optional(
        s.integer({
          minimum: 0,
          maximum: WORKER_CONTROL_WAIT_MAX,
          description: WAIT_NOTE,
        }),
      ),
    }),
  );
}

/** `POST /queues/{queue}/workers/{worker}/{pause,resume,stop,start}` body. */
export const WorkerControlBodySchema = s.named(
  "WorkerControlBody",
  s.object({
    wait: s.optional(
      s.integer({
        minimum: 0,
        maximum: WORKER_CONTROL_WAIT_MAX,
        description: `${WAIT_NOTE} \`?wait=\` is the spelling a client uses, and wins over this one.`,
      }),
    ),
    timeout: s.optional(
      s.integer({
        minimum: 0,
        maximum: WORKER_STOP_TIMEOUT_MAX,
        description: `\`stop\` only: abandon the jobs still running after this many ms instead of waiting for them. Their locks then lapse and another worker recovers them as stalled — the work is delayed and run again from the start, which is why waiting is the default. At most ${WORKER_STOP_TIMEOUT_MAX}.`,
      }),
    ),
    persist: s.optional(WorkerStopPersistenceSchema),
  }),
);

/** What a worker control route answers with. */
export const WorkerControlResultSchema = s.named(
  "WorkerControlResult",
  s.object({
    desired: s.enum(["running", "paused", "stopped"], {
      description:
        "The state that was asked for. `stopping` and `restarting` are transients a caller never requests.",
    }),
    seq: Count,
    applied: s.boolean({
      description:
        "Whether the worker has been seen to apply it — always `false` without `wait`, unless it was already in that state.",
    }),
    persisted: s.optional(WorkerStopPersistenceSchema),
    worker: s.optional(WorkerSchema),
  }),
);

/**
 * `PUT /queues/{queue}/worker-configs/{key}` body: a **merge patch**. A key
 * left out is untouched; `null` clears that key's override, so the worker goes
 * back to its own value.
 */
export const WorkerConfigBodySchema = s.named(
  "WorkerConfigBody",
  s.object({
    ...(Object.fromEntries(
      WORKER_CONFIG_KEYS.map((key) => {
        const { min, max } = WORKER_CONFIG_BOUNDS[key];
        return [
          key,
          s.optional(
            s.nullable(
              s.integer({
                minimum: min,
                maximum: max,
                description: `${boundNote(key)} \`null\` clears the override.`,
              }),
            ),
          ),
        ];
      }),
    ) as {
      [K in WorkerConfigKey]: Optional<Schema<number | null>>;
    }),
    expectedSeq: s.optional(
      s.integer({
        minimum: 0,
        description:
          "The `seq` last read. Answered 409 CONTROL_CONTENDED when it no longer matches. Omit it for a last-writer-wins write.",
      }),
    ),
  }),
);

/** What the worker config routes answer with. */
export const WorkerConfigResultSchema = s.named(
  "WorkerConfigResult",
  s.object({
    queue: s.string(),
    key: s.string(),
    values: WorkerConfigPatchSchema,
    seq: Count,
    instances: s.array(
      s.object({
        id: s.string(),
        applied: s.boolean(),
        state: s.optional(WorkerStateSchema),
      }),
      {
        description:
          "The live workers it reaches, and whether each has applied it yet.",
      },
    ),
  }),
);
