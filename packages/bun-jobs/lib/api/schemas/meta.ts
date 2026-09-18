import { MAX_NAME_LENGTH, NAME_SEGMENT_PATTERN } from "../contract/constants";
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
      maxClean: s.integer({
        minimum: 1,
        description: "Largest `limit` of a clean.",
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
    },
    {
      description:
        "The caps the routes enforce, as configured: each is the value the route itself reads.",
    },
  ),
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
        throughput: s.boolean(),
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
            "The canonical channel name (the job id re-encoded), when it parsed.",
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

/** `GET /meta/permissions` response. */
export const PermissionsSchema = s.named(
  "Permissions",
  s.object(
    {
      actions: s.record(s.boolean()),
      channel: s.optional(ChannelPermissionSchema),
    },
    {
      description:
        "For every action relevant to this API's mode, whether the caller may perform it. Actions disabled by configuration are false. `channel` is present when the query asked about one.",
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
