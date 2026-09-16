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
    },
    {
      description:
        "What this API exposes and what its backend supports, so a client can explain an absent feature.",
    },
  ),
);

/** A queue name or runner id, as a query value: the key-segment rule. */
const SegmentQuery = s.string({
  pattern: "^[\\w.-]+$",
  minLength: 1,
  maxLength: 200,
});

/** `GET /meta/permissions` query. */
export const PermissionsQuerySchema = s.query(
  s.object({
    queue: s.optional(SegmentQuery),
    runner: s.optional(SegmentQuery),
  }),
);

/** `GET /meta/permissions` response. */
export const PermissionsSchema = s.named(
  "Permissions",
  s.object(
    { actions: s.record(s.boolean()) },
    {
      description:
        "For every action relevant to this API's mode, whether the caller may perform it. Actions disabled by configuration are false.",
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
