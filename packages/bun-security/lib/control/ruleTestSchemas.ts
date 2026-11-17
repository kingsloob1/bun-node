/**
 * Test a request's and the impact estimate's schemas (PR-CP7), in the
 * management API's documents.
 */
import type {
  RuleImpactDto,
  RuleTestInput,
  RuleTestResultDto,
} from "./contract/ruleTest";
import type { Schema } from "./schema";
import { RULE_TEST_LIMITS } from "./contract/ruleTest";
import { s } from "./schema";

/** An entity id. */
const Id = s.string({
  min: 1,
  max: 64,
  pattern: /^[a-z\d][\w.-]{0,63}$/i,
  description: "letters, digits, _, . and -",
});

/** A scope id. */
const Scope = s.string({
  min: 1,
  max: 80,
  pattern: /^(?:global|(?:group|service):[a-z\d][\w.-]{0,63})$/i,
  description: "global, group:<id> or service:<id>",
});

/** An action. */
const Action = s.enum([
  "allow",
  "log",
  "tag",
  "delay",
  "challenge",
  "block",
  "ban",
  "drop",
] as const);

/** An account id the app knows. */
const Ident = s.optional(s.string({ min: 1, max: 1_024 }));

/** `POST /rules/test`'s body. */
export const RuleTestBody: Schema<RuleTestInput> = s.object({
  service: Id,
  draft: s.optional(Scope),
  method: s.string({ min: 1, max: 20, pattern: /^[A-Z]+$/i }),
  path: s.string({
    min: 1,
    max: 8_192,
    description: "the path with its query, starting with one /",
  }),
  headers: s.optional(
    s.record(
      s.string({ max: RULE_TEST_LIMITS.maxHeaderBytes }),
      RULE_TEST_LIMITS.maxHeaders,
    ),
  ),
  peer: s.string({ min: 2, max: 64, description: "the socket peer's address" }),
  trustProxy: s.optional(
    s.json(
      "true, a hop count (0 to 32), or the trusted ranges (at most 100); default off",
    ),
  ),
  clientIpHeader: s.optional(s.string({ min: 1, max: 100 })),
  identity: s.optional(
    s.object({
      user: Ident,
      session: Ident,
      tenant: Ident,
      apiKey: Ident,
      apiKeyPlan: s.optional(s.string({ min: 1, max: 100 })),
      scopes: s.optional(s.array(s.string({ min: 1, max: 200 }), 50)),
      username: Ident,
      destination: Ident,
    }),
  ),
  routeKey: s.optional(s.string({ min: 1, max: 300 })),
  profile: s.optional(s.string({ min: 1, max: 64 })),
  intel: s.optional(
    s.object({
      country: s.optional(s.string({ min: 2, max: 2, pattern: /^[a-z]{2}$/i })),
      asn: s.optional(s.int({ min: 0, max: 4_294_967_295 })),
      classes: s.optional(s.array(s.string({ min: 1, max: 64 }), 20)),
    }),
  ),
  assume: s.optional(
    s.object({
      limits: s.optional(
        s.record(
          s.int({ min: 0, max: RULE_TEST_LIMITS.maxAssumed }),
          RULE_TEST_LIMITS.maxAssumedLimits,
        ),
      ),
      score: s.optional(s.number({ min: 0, max: RULE_TEST_LIMITS.maxAssumed })),
    }),
  ),
}) as Schema<unknown> as Schema<RuleTestInput>;

/** A hit. */
const Hit = s.object({
  layer: s.string(),
  rule: s.string(),
  action: Action,
  wouldHaveBeen: s.optional(Action),
  reason: s.optional(s.string()),
});

/** `POST /rules/test`'s answer. */
export const RuleTestResult: Schema<RuleTestResultDto> = s.object({
  service: s.string(),
  policy: s.object({
    draft: s.nullable(s.string()),
    versions: s.array(s.string(), 100),
  }),
  at: s.int({ min: 0 }),
  decision: s.object({
    action: Action,
    status: s.optional(s.int({ min: 0 })),
    code: s.optional(s.string()),
    delayMs: s.optional(s.number({ min: 0 })),
    retryAfter: s.optional(s.number({ min: 0 })),
    hits: s.array(Hit, 1_000),
    tags: s.array(s.string(), 1_000),
    risk: s.number(),
    subject: s.record(s.string(), 50),
    crawler: s.optional(
      s.object({
        id: s.string(),
        verified: s.boolean(),
        verifiedBy: s.optional(s.enum(["ranges", "rdns", "cache"] as const)),
        spoofed: s.boolean(),
      }),
    ),
  }),
  client: s.object({
    address: s.optional(s.string()),
    key: s.optional(s.string()),
    source: s.enum([
      "socket",
      "trusted-proxy",
      "client-ip-header",
      "service",
      "none",
    ] as const),
    chain: s.array(
      s.object({
        address: s.string(),
        source: s.enum(["socket", "x-forwarded-for", "header"] as const),
        trusted: s.boolean(),
      }),
      1_000,
    ),
    service: s.optional(s.string()),
  }),
  steps: s.array(
    s.object({
      layer: s.string(),
      check: s.string(),
      rule: s.optional(s.string()),
      outcome: s.string(),
      decided: s.optional(s.boolean()),
    }),
    10_000,
  ),
  notEvaluated: s.array(s.string(), 50),
}) as Schema<unknown> as Schema<RuleTestResultDto>;

/** `POST /policies/:scope/impact`'s body. */
export const RuleImpactBody = s.object({
  from: s.optional(
    s.int({
      min: 0,
      description: "the window's start, epoch ms (default 24 h before to)",
    }),
  ),
  to: s.optional(
    s.int({ min: 0, description: "the window's end, epoch ms (default now)" }),
  ),
});

/** A class of decision. */
const DecisionClass = s.enum(["allow", "challenge", "refuse"] as const);

/** `POST /policies/:scope/impact`'s answer. */
export const RuleImpact: Schema<RuleImpactDto> = s.object({
  scope: s.string(),
  window: s.object({ from: s.int({ min: 0 }), to: s.int({ min: 0 }) }),
  services: s.object({
    replayed: s.array(s.string(), RULE_TEST_LIMITS.maxServices),
    skipped: s.array(
      s.object({ service: s.string(), reason: s.string() }),
      100_000,
    ),
  }),
  events: s.object({
    read: s.int({ min: 0 }),
    stoppedBy: s.nullable(s.enum(["events", "time"] as const)),
  }),
  sampledAllows: s.object({
    read: s.int({ min: 0 }),
    rates: s.array(s.number(), 1_000),
  }),
  transitions: s.array(
    s.object({
      from: DecisionClass,
      to: DecisionClass,
      count: s.int({ min: 0 }),
    }),
    9,
  ),
  rules: s.array(
    s.object({
      rule: s.string(),
      newlyHit: s.int({ min: 0 }),
      noLongerHit: s.int({ min: 0 }),
      samples: s.array(s.string(), RULE_TEST_LIMITS.samplesPerRule),
    }),
    100_000,
  ),
  routes: s.array(
    s.object({ route: s.string(), changed: s.int({ min: 0 }) }),
    RULE_TEST_LIMITS.maxRoutes,
  ),
  subjects: s.record(s.int({ min: 0 }), 10),
  labels: s.array(
    s.object({
      rule: s.string(),
      label: s.enum(["exact", "partial", "not-evaluated"] as const),
      why: s.optional(s.string()),
    }),
    100_000,
  ),
}) as Schema<unknown> as Schema<RuleImpactDto>;
