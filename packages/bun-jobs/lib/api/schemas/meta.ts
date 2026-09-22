import type { JobsApiAction } from "../contract/constants";
import type { Optional, Schema } from "../schema/builder";
import {
  JOBS_API_ACTIONS,
  MAX_NAME_LENGTH,
  NAME_SEGMENT_PATTERN,
} from "../contract/constants";
import { s } from "../schema/builder";

/**
 * Schemas for the meta and docs routes: what the API can do, what the caller
 * may do, and the OpenAPI document itself.
 */

/** What a backend supports. Mirrors `DriverCapabilities`. */
export const DriverCapabilitiesSchema = s.object({
  blockingWait: s.boolean(),
  events: s.enum(["push", "poll", "local"]),
  multiProcess: s.boolean(),
  multiHost: s.boolean(),
  jobAttribution: s.boolean({
    description:
      "Whether the backend records the worker that ran each job's last attempt and filters on it. `false` when the driver does not declare it.",
  }),
});

/** The CSRF rules mutations are held to. Mirrors `MetaCsrfDto`. */
export const MetaCsrfSchema = s.named(
  "MetaCsrf",
  s.object(
    {
      header: s.nullable(
        s.string({
          description:
            "A header every mutation must carry with a non-empty value, lower case; `null` for none.",
        }),
      ),
      requireJson: s.boolean({
        description:
          "Whether every POST, and any mutation with a body, must be sent as `Content-Type: application/json` — a bodiless POST included (415 otherwise).",
      }),
    },
    {
      description:
        "The CSRF rules. `{ header: null, requireJson: false }` when CSRF is off.",
    },
  ),
);

/** The caps the routes enforce. Mirrors `MetaLimitsDto`. */
export const MetaLimitsSchema = s.named(
  "MetaLimits",
  s.object(
    {
      defaultPageSize: s.integer({
        minimum: 1,
        description: "`limit` of a job list when none is given.",
      }),
      maxPageSize: s.integer({
        minimum: 1,
        description: "Largest `limit` a job list accepts.",
      }),
      maxBulkIds: s.integer({
        minimum: 1,
        description:
          "Most ids in a bulk body; more is 400 BULK_LIMIT. Also the most children listed.",
      }),
      maxRetryAll: s.integer({
        minimum: 1,
        description: "Largest `limit` of a retry-all.",
      }),
      maxRetryAllIds: s.integer({
        minimum: 1,
        description:
          "Most ids a retry-all answers with; when it moved more, `ids` holds the first this many and `truncated` is `true`.",
      }),
      maxClean: s.integer({
        minimum: 1,
        description: "Largest `limit` of a clean.",
      }),
      defaultClean: s.integer({
        minimum: 1,
        description:
          "The `limit` a clean uses when none is given: `min(1000, maxClean)`.",
      }),
      maxLogPage: s.integer({
        minimum: 1,
        description: "Largest `limit` of a log page.",
      }),
      maxHistory: s.integer({
        minimum: 1,
        description: "Largest `limit` of a runner history page.",
      }),
      maxJobDataBytes: s.integer({
        minimum: 1,
        description:
          "Largest request body a mutation accepts, in bytes; more is 413 PAYLOAD_TOO_LARGE.",
      }),
      maxQueues: s.integer({
        minimum: 1,
        description:
          "Most queues /overview summarises, and the largest `limit` of GET /queues.",
      }),
      maxApplyDefaults: s.integer({
        minimum: 1,
        description:
          "Most jobs one POST /queues/{queue}/job-defaults/apply call examines: its largest `limit`.",
      }),
    },
    {
      description:
        "The caps the routes enforce, as configured: each is the value the route itself reads.",
    },
  ),
);

/** The analytics block of `/meta`. Mirrors `MetaAnalyticsDto`. */
const MetaAnalyticsSchema = s.object(
  {
    // A union of literals, not an integer: the resolutions are a closed set,
    // and a client's picker is built from exactly these.
    resolutions: s.array(s.union(s.literal(1), s.literal(60)), {
      description:
        "Bucket widths this deployment can serve, in seconds, finest first.",
    }),
    // Named properties rather than a free record, so the document says which
    // two keys exist. JSON object keys are strings, hence "1" and "60".
    retentionMs: s.object(
      {
        "1": s.optional(s.integer({ minimum: 0 })),
        "60": s.optional(s.integer({ minimum: 0 })),
      },
      {
        description:
          "How long each resolution is kept, in ms, keyed by the resolution in seconds. A resolution this deployment does not keep is absent.",
      },
    ),
    maxSpanMs: s.integer({
      minimum: 1,
      description: "Longest span one request may ask for, in ms.",
    }),
    maxBuckets: s.integer({
      minimum: 1,
      description:
        "Most buckets one series may hold; a longer span is served at a coarser resolution.",
    }),
    maxSeries: s.integer({
      minimum: 1,
      description:
        "Most series one batch read returns; an explicit over-ask is 400 BULK_LIMIT.",
    }),
    recording: s.object(
      {
        resolution: s.enum(["minute", "second"]),
        secondRetentionMs: s.integer({ minimum: 0 }),
        workers: s.boolean(),
        runners: s.boolean(),
        durations: s.boolean(),
      },
      { description: "Which kinds are being recorded right now." },
    ),
    busynessIntervalMs: s.integer({
      minimum: 1,
      description:
        "The busyness sample interval, in ms — the workers' report interval, not a bucket width.",
    }),
  },
  {
    description:
      "What the analytics routes can serve here. `null` when the driver records none of it.",
  },
);

/** `GET /meta`. Mirrors `MetaDto`. */
export const MetaSchema = s.named(
  "Meta",
  s.object(
    {
      namespace: s.string(),
      mode: s.enum(["jobs", "runner", "both"]),
      readOnly: s.boolean(),
      protocol: s.literal(1),
      driver: s.object({
        name: s.string(),
        capabilities: DriverCapabilitiesSchema,
      }),
      features: s.object({
        logs: s.boolean(),
        update: s.boolean(),
        limits: s.boolean(),
        flows: s.boolean(),
        search: s.boolean(),
        workers: s.boolean(),
        workerControl: s.boolean(),
        throughput: s.boolean(),
        runnerLogs: s.boolean(),
        runnerMetrics: s.boolean(),
        workerMetrics: s.boolean(),
        jobAttribution: s.boolean({
          description:
            "The backend records the worker that ran each job's last attempt (`processedBy`), and the job list serves `workerKey`, `workerId`, `finishedFrom` and `finishedTo`. `false` in `runner` mode, and wherever `processedBy` is always `null`.",
        }),
        addedByState: s.boolean({
          description:
            "The backend serves reads by creation time from an index or memory: `GET /overview/added` and `GET /queues/{queue}/counts/added` exist, and the job list accepts `sort=createdAt` (400 `INVALID_ARGUMENT`, with a detail, where this is `false`). `false` on the Redis and file drivers, and in `runner` mode.",
        }),
        jobDefaults: s.boolean({
          description:
            "The backend can store a queue's job defaults (it has queue state), so `GET`/`PUT`/`DELETE /queues/{queue}/job-defaults` exist and producers on this version add under them. `true` on every built-in driver; `false` in `runner` mode.",
        }),
        jobDefaultsApply: s.boolean({
          description:
            "The backend can rewrite pending jobs with them, so `POST /queues/{queue}/job-defaults/apply` exists. `true` on every built-in driver; `false` in `runner` mode and on a custom driver without `rewritePendingOptions`.",
        }),
      }),
      events: s.enum(["push", "poll", "local"]),
      publishing: s.nullable(s.boolean()),
      websocket: s.nullable(
        s.object({
          path: s.string(),
          heartbeatMs: s.integer({ minimum: 0 }),
          maxSubscriptions: s.integer({ minimum: 1 }),
          port: s.optional(
            s.integer({
              minimum: 1,
              maximum: 65_535,
              description:
                "The socket's dedicated port (the bound one, when configured as `0`). Absent when the socket shares the host's port.",
            }),
          ),
        }),
      ),
      docs: s.nullable(
        s.object({
          openapi: s.string(),
          asyncapi: s.optional(s.string()),
          ui: s.optional(s.string()),
          asyncapiUi: s.optional(s.string()),
        }),
      ),
      csrf: MetaCsrfSchema,
      limits: MetaLimitsSchema,
      analytics: s.nullable(MetaAnalyticsSchema),
      addableNames: s.nullable(
        s.array(s.string(), {
          description:
            "The job names `POST /queues/{queue}/jobs` accepts right now; `null` when it accepts any name. Empty when nothing can be added: the route is not registered, or no name is allowed.",
        }),
      ),
      runnerTriggerArgs: s.boolean({
        description:
          "Whether `POST /runners/{runner}/trigger` is registered and accepts `args`.",
      }),
    },
    {
      description:
        "What this API exposes and what its backend supports, so a client can explain an absent feature.",
    },
  ),
);

/** A queue name or runner id, as a query value: the key-segment rule. */
const SegmentQuery = s.string({
  pattern: NAME_SEGMENT_PATTERN,
  minLength: 1,
  maxLength: MAX_NAME_LENGTH,
});

/** `GET /meta/permissions` query. */
export const PermissionsQuerySchema = s.query(
  s.object({
    queue: s.optional(SegmentQuery),
    runner: s.optional(SegmentQuery),
    channel: s.optional(
      s.string({
        minLength: 1,
        maxLength: 1024,
        description:
          "A WebSocket channel name (`queue/mail`, `queue/mail/job/<encodeURIComponent(id)>`, `runner/nightly`, …): the answer's `channel` then says whether subscribing to it would be authorized.",
      }),
    ),
  }),
);

/** Whether a channel subscription would be authorized. Mirrors `ChannelPermissionDto`. */
export const ChannelPermissionSchema = s.named(
  "ChannelPermission",
  s.object(
    {
      channel: s.string({ description: "The channel as asked." }),
      key: s.optional(
        s.string({
          description:
            "The canonical channel name (the job id re-encoded), whenever the name parsed — refused afterwards or not. Absent only for INVALID_CHANNEL.",
        }),
      ),
      allowed: s.boolean({
        description: "Whether a `subscribe` to it would be accepted.",
      }),
      code: s.optional(
        s.string({
          description:
            "The code a `subscribe` ack would reject it with: INVALID_CHANNEL, CHANNEL_NOT_AVAILABLE, QUEUE_NOT_FOUND, RUNNER_NOT_FOUND, UNAUTHORIZED or FORBIDDEN.",
        }),
      ),
      status: s.optional(
        s.integer({
          minimum: 400,
          maximum: 599,
          description: "The HTTP-equivalent status of the refusal.",
        }),
      ),
      detail: s.optional(s.string({ description: "A safe, human reason." })),
    },
    {
      description:
        "Asks `authorize` about `events.subscribe` on the channel exactly as a `subscribe` frame would, after the same parsing and availability checks. It does not check `events.connect`: that is in `actions`.",
    },
  ),
);

/**
 * `PermissionsDto.actions`: one optional boolean per action, and no other
 * key. Built from `JOBS_API_ACTIONS`, so a new action is documented here
 * without an edit, and it infers `Partial<Record<JobsApiAction, boolean>>`
 * exactly — the contract's type.
 */
const ActionPermissionsSchema = s.object(
  Object.fromEntries(
    JOBS_API_ACTIONS.map((action) => [action, s.optional(s.boolean())]),
  ) as { [A in JobsApiAction]: Optional<Schema<boolean>> },
  {
    description:
      "Keyed by action. An action whose routes are pruned (by `mode`, `readOnly`, `actions` or the driver) is absent, not `false`.",
  },
);

/** `GET /meta/permissions` response. */
export const PermissionsSchema = s.named(
  "Permissions",
  s.object(
    {
      actions: ActionPermissionsSchema,
      channel: s.optional(ChannelPermissionSchema),
    },
    {
      description:
        "For every action the API routes (plus `events.connect` and `events.subscribe` when it has a socket), whether the caller may perform it; a pruned action is absent. `channel` is present when the query asked about one.",
    },
  ),
);

/** The AsyncAPI document, described loosely: it is validated against its own JSON Schema. */
export const AsyncApiDocumentSchema = s.object(
  { asyncapi: s.string() },
  {
    additionalProperties: true,
    description: "An AsyncAPI 3.0 document.",
  },
);

/** The OpenAPI document, described loosely: it is validated against its own meta-schema. */
export const OpenApiDocumentSchema = s.object(
  { openapi: s.string() },
  {
    additionalProperties: true,
    description: "An OpenAPI 3.1 document.",
  },
);
