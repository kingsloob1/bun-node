/**
 * The policy format as a JSON Schema (draft 2020-12, PR-AN2): what the
 * control plane's OpenAPI document publishes as the `SecurityPolicy`
 * component, so a client can type a policy and build forms from it.
 *
 * {@link securityPolicySchema}'s validator is code, so this schema is
 * written beside it rather than derived from it, and kept in step by tests
 * (`__tests__/policy/jsonSchema.test.ts`): every object closed here
 * (`additionalProperties: false`) names exactly the keys the validator
 * knows there, and a policy using every key it names passes both.
 *
 * It describes the **shape**: keys, types, enumerations and bounds. The
 * validator stays the authority on everything else (a CIDR that parses, an
 * allow entry not wide enough to allow the internet, unique ids, a window
 * of at least a second, a request rule's condition grammar, which is an
 * object here). It requires nothing: a scope's policy is a partial one,
 * layered over the scopes above it, and an item overriding an inherited
 * one by its `id` names only what it changes (`{ id, mode: "off" }`).
 */
import { CRAWLER_EXEMPTIONS } from "../crawlers/policy";
import { PRESET_IDS } from "./presets";

/** A JSON Schema node. */
export type PolicyJsonSchema = Readonly<Record<string, unknown>>;

/** A reference to one of the schema's `$defs`. */
function ref(name: string): PolicyJsonSchema {
  return { $ref: `#/$defs/${name}` };
}

/** A string. */
function str(
  description: string,
  extra: Readonly<Record<string, unknown>> = {},
): PolicyJsonSchema {
  return { type: "string", description, ...extra };
}

/** A whole number. */
function int(
  description: string,
  minimum?: number,
  maximum?: number,
): PolicyJsonSchema {
  return {
    type: "integer",
    description,
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
  };
}

/** A number. */
function num(
  description: string,
  minimum?: number,
  maximum?: number,
): PolicyJsonSchema {
  return {
    type: "number",
    description,
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
  };
}

/** A boolean. */
function bool(description: string): PolicyJsonSchema {
  return { type: "boolean", description };
}

/** One of `values`. */
function oneOf(
  values: readonly (string | number | boolean)[],
  description: string,
): PolicyJsonSchema {
  return { enum: [...values], description };
}

/** A list of `items`. */
function list(
  items: PolicyJsonSchema,
  description: string,
  maxItems?: number,
): PolicyJsonSchema {
  return {
    type: "array",
    description,
    items,
    ...(maxItems === undefined ? {} : { maxItems }),
  };
}

/**
 * An object with exactly `properties` (closed), each optional. `notes`:
 * whether the validator also takes `$`-prefixed note keys there.
 */
function closed(
  description: string,
  properties: Readonly<Record<string, PolicyJsonSchema>>,
  notes = true,
): PolicyJsonSchema {
  return {
    type: "object",
    description,
    properties,
    ...(notes ? { patternProperties: { "^\\$": {} } } : {}),
    additionalProperties: false,
  };
}

/** `schema`, or `false` to turn the section off. */
function orFalse(schema: PolicyJsonSchema): PolicyJsonSchema {
  return {
    description: schema.description,
    anyOf: [schema, { const: false }],
  };
}

/** A mode: `enforce`, `dryRun` or `off`. */
const MODE = ref("PolicyMode");

/** A duration, its unit written. */
const DURATION = ref("PolicyDuration");

/** A rule's id grammar. */
const RULE_ID = str(
  "a stable id, unique in its list: letters, digits, _, . and -, starting with a letter or digit, at most 64",
  { pattern: "^[A-Za-z0-9][\\w.-]{0,63}$" },
);

/** A route grammar: `POST /login`, `/login`, `/auth/*`. */
const ROUTES = list(
  str("a route: `POST /login`, `/login` (any method), or a prefix `/auth/*`"),
  "the routes it applies to; every request when absent",
);

/** A limit's or counted rule's key. */
const KEY = {
  description:
    'who a request counts against: one part, or several for a composite key; default "ip"',
  anyOf: [
    ref("PolicyKeyPart"),
    list(ref("PolicyKeyPart"), "a composite key", 11),
  ],
};

/** A security profile's name. */
const PROFILE = str(
  "only requests of routes with this profile count (`securityProfile()`); every route when absent",
);

/** One rate limit (layers.md L9). */
const LIMIT = closed(
  "a rate limit (layers.md L9): at most `limit` requests per `window` for one key; past it, 429",
  {
    id: RULE_ID,
    limit: int(
      "requests allowed per window (required in the effective policy)",
      1,
    ),
    window: {
      ...DURATION,
      description: "the window (required in the effective policy)",
    },
    subSecond: bool("accept a window under one second; default false"),
    key: KEY,
    routes: ROUTES,
    algorithm: oneOf(
      ["sliding-window", "fixed-window", "gcra"],
      'how it counts; default "sliding-window"',
    ),
    cost: num("what one request costs; default 1", 0),
    mode: MODE,
    locked: bool("lower scopes cannot override or disable it; default false"),
    appliesToServices: bool(
      "applies to a verified sibling service exempt from global limits; default false",
    ),
    evenWhenAllowed: bool(
      "still counts a request an allow entry let through; default false",
    ),
    code: str('the 429 body\'s problem code; default "rate_limited"'),
    state: oneOf(
      ["local", "shared", "hybrid"],
      "where it counts; default the policy's state.mode",
    ),
    onStoreError: oneOf(
      ["local", "open", "closed"],
      "what it does when the shared store fails; default the policy's state.onStoreError",
    ),
    profile: PROFILE,
    apiKeyPlan: str(
      "only requests whose API key is on this plan count; every request when absent",
    ),
  },
);

/** The policy's JSON Schema; see the module's description. */
export const SECURITY_POLICY_JSON_SCHEMA: PolicyJsonSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "SecurityPolicy",
  description:
    "A bun-security policy (control-plane.md §2): a scope's own is partial, layered over the scopes above it; nothing is required. The shape only: securityPolicySchema checks the rest.",
  type: "object",
  properties: {
    version: oneOf([1], "the policy format version; default 1"),
    service: str("the service's name, as events and bans name it"),
    environment: str("the environment (`production`), for operators"),
    public: bool(
      "a public service: the trust check warns when its clients resolve inside",
    ),
    mode: { ...MODE, description: "the whole policy's mode; default enforce" },
    keys: closed("how subjects are keyed (layers.md L2.3)", {
      ipv6Prefix: int(
        "an IPv6 client is keyed by this prefix; default 64",
        32,
        128,
      ),
    }),
    internal: {
      description:
        "the internal never-block list (layers.md L3.1): true (default), false, or narrowed to some of its ranges",
      anyOf: [
        { type: "boolean" },
        closed("the internal list narrowed", {
          ranges: list(
            str("a CIDR inside the internal ranges"),
            "the ranges kept",
          ),
        }),
      ],
    },
    lists: list(
      ref("PolicyListEntry"),
      "allow and deny entries (layers.md L3), keyed by `id` or their subject",
    ),
    serviceIdentity: closed(
      "sibling services allowed to call under their own identity (layers.md L2.4)",
      {
        header: str('the header carrying a token; default "x-service-token"'),
        clientIpHeader: str(
          'the header carrying a forwarded end-user address; default "x-service-client-ip"',
        ),
        services: list(
          closed("a calling service", {
            id: str("its name, unique in the policy"),
            verifier: {
              description:
                'the SHA-256 of its token, "sha256:<64 hex>", or several during a rotation',
              anyOf: [
                str("a verifier", { pattern: "^sha256:[0-9a-f]{64}$" }),
                list(
                  str("a verifier", { pattern: "^sha256:[0-9a-f]{64}$" }),
                  "verifiers",
                ),
              ],
            },
            forwardsClientIp: bool(
              "its forwarded end-user address is believed; default false",
            ),
            exempt: list(
              oneOf(
                ["lists", "bans", "countedRules", "globalLimits"],
                "an exemption",
              ),
              "what a verified call skips; default all four",
            ),
          }),
          "the services allowed to call",
        ),
      },
    ),
    trustCheck: orFalse(
      closed(
        "the trust-misconfiguration check (layers.md L2.5); false for none",
        {
          threshold: num(
            "the share of a minute's requests that marks it suspicious; default 0.5",
            0,
            1,
          ),
          window: {
            ...DURATION,
            description: 'how long before the warning; default "5m"',
          },
          minRequests: int(
            "a minute with fewer requests never counts; default 20",
            1,
          ),
        },
      ),
    ),
    concurrency: orFalse(
      closed("connection and in-flight limits (layers.md L1); false for none", {
        perIp: {
          description: "in-flight requests per client address; default 64",
          anyOf: [int("a count", 1), { const: false }],
        },
        total: {
          description: "in-flight requests in all; none by default",
          anyOf: [int("a count", 1), { const: false }],
        },
        releaseAfter: {
          ...DURATION,
          description: "a slot held longer is released",
        },
        mode: MODE,
      }),
    ),
    limits: list(
      ref("PolicyLimit"),
      "rate limits (layers.md L9), keyed by `id`",
    ),
    countedRules: list(
      closed(
        "a counted rule (layers.md §0.2): `threshold` occurrences of `event` in `window` → `action`",
        {
          id: RULE_ID,
          event: str(
            "the event counted: request, throttled, route.notFound, server.error, rule.hit, probe.hit, pattern.hit, or the app's signals (required in the effective policy)",
            { pattern: "^[A-Za-z][\\w.-]{0,63}$" },
          ),
          threshold: int(
            "occurrences that trip it (required in the effective policy)",
            1,
          ),
          window: {
            ...DURATION,
            description: "the window occurrences are counted in",
          },
          subSecond: bool("accept a window under one second; default false"),
          key: KEY,
          routes: ROUTES,
          action: oneOf(
            ["ban", "challenge", "ladder"],
            'what the tripped key gets; default "ban"',
          ),
          duration: {
            description:
              "how long, or null until lifted; required except with action ladder",
            anyOf: [DURATION, { type: "null" }],
          },
          mode: MODE,
          locked: bool(
            "lower scopes cannot override or disable it; default false",
          ),
          appliesToServices: bool(
            "counts a verified service's forwarded end users; default false",
          ),
          code: str("its bans' problem code; default the policy's bans.code"),
          weight: num("the offence weight a trip adds; default 1", 0),
          state: oneOf(["local", "shared"], "where its counters live"),
          onStoreError: oneOf(
            ["local", "open"],
            "what it does when the shared store fails",
          ),
          profile: PROFILE,
        },
      ),
      "counted rules (layers.md §0.2), keyed by `id`",
    ),
    bans: closed("bans (layers.md L4)", {
      code: str('the problem code of a ban\'s refusal; default "banned"'),
      retryAfter: bool("answer Retry-After with a ban's end; default true"),
      maxActive: int("the most bans held; default 100,000", 1),
      mode: MODE,
    }),
    ladder: orFalse(
      closed("the offence ladder (layers.md §0.2); false for none", {
        halfLife: { ...DURATION, description: "how fast a score decays" },
        steps: list(
          closed("a step: at `score`, a challenge or a ban", {
            score: num("the score that reaches it", 0),
            action: oneOf(["challenge", "ban"], "what it does"),
            duration: { ...DURATION, description: "a ban's length" },
          }),
          "the steps, by score",
        ),
        base: { ...DURATION, description: "the first escalating ban's length" },
        factor: num("each later ban's multiplier", 1),
        maxBan: { ...DURATION, description: "the longest ban" },
        memory: { ...DURATION, description: "how long earlier bans count" },
        weights: {
          type: "object",
          description: "offence weights by source",
          additionalProperties: { type: "number", minimum: 0 },
        },
        mode: MODE,
      }),
    ),
    shape: orFalse(
      closed("request shape (layers.md L6); false for none", {
        caseSensitive: bool("paths compare case-sensitively; default false"),
        maxPathBytes: int("the longest path, bytes", 1),
        maxQueryBytes: int("the longest query, bytes", 1),
        maxQueryParams: int("the most query parameters", 1),
        maxQueryDepth: int("the deepest query nesting", 1),
        maxHeaders: int("the most headers", 1),
        maxHeaderBytes: int("the largest header block, bytes", 1),
        methods: list(
          str("a method", { pattern: "^[A-Z][A-Z0-9-]{0,31}$" }),
          "the methods allowed",
        ),
        hosts: list(str("a host, with an optional port"), "the hosts allowed"),
        headerLimits: {
          type: "object",
          description: "the longest value per header name, bytes",
          additionalProperties: { type: "integer", minimum: 1 },
        },
        maxBodySize: {
          description: "the largest body, bytes, or false for no limit",
          anyOf: [int("bytes", 0), { const: false }],
        },
        routes: list(
          closed("a per-route shape", {
            routes: list(str("a route"), "the routes it applies to"),
            maxBodySize: int("the largest body, bytes", 0),
            contentTypes: list(
              str("a media type (`application/json`, `image/*`)"),
              "the content types allowed",
            ),
            allowEncodedSlash: bool("accept %2F in the path; default false"),
          }),
          "per-route shapes",
        ),
        mode: MODE,
      }),
    ),
    deception: closed("deception (layers.md L8)", {
      honeypots: {
        description:
          "honeypot routes: true for the defaults, false, or settings",
        anyOf: [
          { type: "boolean" },
          closed("honeypot settings", {
            paths: list(str("a path, a limit's route grammar"), "the paths"),
            answer: oneOf(["pass", "not-found"], "how a hit is answered"),
            mode: MODE,
          }),
        ],
      },
      canaries: list(
        closed(
          "a canary credential: a user or an API key no one should use (keyed by the control plane)",
          {
            id: str("its id"),
            user: str("a user id (keyed on save)"),
            apiKey: str("an API key id (keyed on save)"),
            userHash: str("a user's key, 32 hex", {
              pattern: "^[0-9a-f]{32}$",
            }),
            apiKeyHash: str("an API key's key, 32 hex", {
              pattern: "^[0-9a-f]{32}$",
            }),
          },
        ),
        "canary credentials, keyed by `id`",
      ),
    }),
    requestRules: closed("request rules (layers.md L7)", {
      rules: list(
        closed("a request rule", {
          id: RULE_ID,
          when: {
            type: "object",
            description:
              "the condition: a matcher, or all / any / not of conditions (layers.md L7; checked by the validator)",
          },
          action: str(
            "what a match does (block, challenge, tag, log, ban, drop, delay)",
          ),
          weight: num("the offence weight a match adds", 0),
          mode: MODE,
          status: int("the refusal's status", 400, 599),
          code: str("the refusal's problem code"),
          duration: {
            description: "a ban's length, or null until lifted",
            anyOf: [DURATION, { type: "null" }],
          },
          crawlers: oneOf(
            ["apply", "skip"],
            "whether a verified crawler is held to it",
          ),
          locked: bool(
            "lower scopes cannot override or disable it; default false",
          ),
        }),
        "the rules, keyed by `id`",
      ),
      managed: {
        description: "the managed probe set: true, false, or settings",
        anyOf: [
          { type: "boolean" },
          closed("managed probe settings", {
            mode: oneOf(["enforce", "dryRun"], "its mode"),
            exclude: list(str("a managed rule id"), "rules left out"),
            weight: num("the offence weight a hit adds", 0),
          }),
        ],
      },
      maxRegexInput: int("the most characters a regex reads", 1),
    }),
    state: closed("where counters live (topologies.md §3.2)", {
      mode: oneOf(["local", "shared", "hybrid"], "the default for limits"),
      onStoreError: oneOf(
        ["local", "open", "closed"],
        "the default when the shared store fails",
      ),
      nodes: int("the processes sharing the limits, for local shares", 1),
      scope: oneOf(["shared", "service"], "whose counters a store holds"),
    }),
    messages: closed("WebSocket message limits (layers.md L1)", {
      perConnection: {
        description: "messages per connection, or false for none",
        anyOf: [
          closed("a per-connection limit", {
            limit: int("messages per window", 1),
            window: DURATION,
            subSecond: bool("accept a window under one second"),
          }),
          { const: false },
        ],
      },
      burst: int("messages allowed in a burst", 1),
      breach: {
        ...DURATION,
        description: "how long over the limit before closing",
      },
      closeCode: int("the close code", 1000, 4999),
      limits: list(ref("PolicyLimit"), "message limits, as rate limits"),
      mode: MODE,
    }),
    botSignals: closed(
      "bot signals (layers.md L10)",
      {
        mode: oneOf(["enforce", "dryRun"], "its mode"),
        weights: {
          type: "object",
          description: "each signal's weight",
          additionalProperties: { type: "number" },
        },
        challengeAt: num("the score that challenges", 0),
        browserPaths: list(
          str("a path glob starting with /"),
          "paths only browsers load",
        ),
        classes: {
          type: "object",
          description: "an intel class's weight, 0 to 100",
          additionalProperties: { type: "number", minimum: 0, maximum: 100 },
        },
      },
      false,
    ),
    crawlers: closed(
      "the verified-crawler allowance (layers.md L3.2)",
      {
        mode: MODE,
        allow: list(str("a crawler id (`google`)"), "the crawlers allowed"),
        verify: oneOf(
          ["ranges", "rdns", "ranges-then-rdns"],
          "how a claimant is verified",
        ),
        methods: list(
          oneOf(["GET", "HEAD", "OPTIONS"], "a method"),
          "the methods covered",
        ),
        paths: closed(
          "the paths covered",
          {
            include: list(
              str("a path glob"),
              "paths covered; every path when absent",
            ),
            exclude: list(str("a path glob"), "paths left out"),
          },
          false,
        ),
        exempt: list(
          oneOf(CRAWLER_EXEMPTIONS, "an exemption"),
          "what a verified crawler is exempt from",
        ),
        limit: {
          description:
            'each verified crawler\'s own limit, "<count>/<window>" ("3000/1m"), or false',
          anyOf: [str("a limit", { pattern: "^\\d+/.+$" }), { const: false }],
        },
        spoofed: closed(
          "what a spoofed claimant gets",
          {
            action: oneOf(
              ["log", "block", "challenge", "drop"],
              'default "block"',
            ),
            weight: num("its offence weight; default 5", 0),
          },
          false,
        ),
        custom: list(
          closed(
            "a crawler of the policy's own",
            {
              id: str("its id"),
              tokens: list(str("a User-Agent token"), "its tokens"),
              ranges: str("its range file's URL"),
              rdns: list(str("a reverse-DNS domain"), "its domains"),
            },
            false,
          ),
          "crawlers of the policy's own, keyed by `id`",
          64,
        ),
      },
      false,
    ),
    apiKeys: closed(
      "API-key anomalies (layers.md L12)",
      {
        newAsn: {
          description: "a key used from a new autonomous system",
          anyOf: [
            { type: "boolean" },
            closed(
              "settings",
              {
                mode: MODE,
                action: str("what it does"),
                duration: DURATION,
                remember: DURATION,
              },
              false,
            ),
          ],
        },
        manyAddresses: {
          description: "a key used from many addresses",
          anyOf: [
            { type: "boolean" },
            closed(
              "settings",
              {
                mode: MODE,
                action: str("what it does"),
                duration: DURATION,
                limit: int("addresses", 1),
                window: DURATION,
              },
              false,
            ),
          ],
        },
      },
      false,
    ),
    presets: {
      type: "object",
      description:
        'presets switched: true (as it ships), "enforce", or false (off)',
      propertyNames: {
        anyOf: [{ enum: [...PRESET_IDS] }, { pattern: "^\\$" }],
      },
      patternProperties: { "^\\$": {} },
      additionalProperties: {
        anyOf: [{ type: "boolean" }, { const: "enforce" }],
      },
    },
    profiles: closed("the sensitive endpoints' profiles (layers.md L11)", {
      login: orFalse(
        closed("the login profile's account defences", {
          failures: closed("failures per attempted username", {
            window: DURATION,
            delayAfter: int("failures before the delay", 1),
            challengeAfter: int("failures before the challenge", 1),
            lockAfter: int("failures before the soft lock", 1),
            lockFor: DURATION,
            maxDelay: DURATION,
          }),
          distinctUsernames: orFalse(
            closed("distinct usernames failing from one address", {
              window: DURATION,
              challengeAt: int("default 10", 1),
              banAt: int("default 30", 1),
              banFor: DURATION,
            }),
          ),
          distinctAddresses: orFalse(
            closed("distinct addresses failing for one username", {
              window: DURATION,
              stepUpAt: int("default 10", 1),
            }),
          ),
          riskySuccessAfter: {
            description: "failures before a success is risky; false for none",
            anyOf: [int("failures", 1), { const: false }],
          },
          device: orFalse(
            closed("the device cookie", {
              cookie: str("its name"),
              maxAge: DURATION,
            }),
          ),
          inferOutcome: bool("infer the outcome from the status"),
          mode: MODE,
          failureRate: closed("the global failure-rate response", {
            window: DURATION,
            baseline: DURATION,
            factor: num("times the baseline", 1),
            minFailures: int("failures before it can trip", 1),
            hold: DURATION,
            respond: oneOf(["challenge", "tag", "limit"], "what it does"),
            to: list(
              oneOf(["hosting", "newDevice", "all"], "a target"),
              "who it applies to",
            ),
            limit: closed("its limit", {
              attempts: int("attempts", 1),
              window: DURATION,
              by: oneOf(["asn", "hosting"], "keyed by"),
            }),
          }),
        }),
      ),
    }),
    identifiers: closed("identifier checks (layers.md L11.7)", {
      patterns: list(
        closed("a pattern", {
          id: str("its id"),
          kind: oneOf(
            ["email", "phone", "username", "domain"],
            "what it checks",
          ),
          pattern: str("the glob"),
          reason: str("why"),
          mode: MODE,
        }),
        "the patterns, keyed by `id`",
      ),
      reserved: bool("refuse reserved names"),
      ownDomains: list(str("a domain"), "the service's own domains"),
      code: str("the refusal's problem code"),
    }),
  },
  patternProperties: { "^\\$": { description: "a note, ignored" } },
  additionalProperties: false,
  $defs: {
    PolicyLimit: LIMIT,
    PolicyMode: oneOf(
      ["enforce", "dryRun", "off"],
      "enforce applies it; dryRun records what it would have done; off skips it",
    ),
    PolicyDuration: {
      description:
        'a duration with its unit written: "30s", "1h 30m", or { minutes: 1, seconds: 30 }',
      anyOf: [
        { type: "string", minLength: 1 },
        {
          type: "object",
          properties: {
            ms: { type: "number", minimum: 0 },
            seconds: { type: "number", minimum: 0 },
            minutes: { type: "number", minimum: 0 },
            hours: { type: "number", minimum: 0 },
            days: { type: "number", minimum: 0 },
            weeks: { type: "number", minimum: 0 },
          },
          additionalProperties: false,
          minProperties: 1,
        },
      ],
    },
    PolicyKeyPart: oneOf(
      [
        "ip",
        "user",
        "session",
        "tenant",
        "apiKey",
        "route",
        "username",
        "destination",
        "destinationPrefix",
        "device",
        "crawler",
      ],
      "a key part",
    ),
    PolicyListEntry: closed(
      "an allow or deny entry (layers.md L3): exactly one subject and an action",
      {
        id: str("a stable id, unique in the policy; default its subject"),
        ip: str("an IPv4 or IPv6 address or CIDR range"),
        user: str("a user id (the control plane keys it on save)"),
        userHash: str("a user's key, 32 hex", { pattern: "^[0-9a-f]{32}$" }),
        apiKey: str("an API key id (the control plane keys it on save)"),
        apiKeyHash: str("an API key's key, 32 hex", {
          pattern: "^[0-9a-f]{32}$",
        }),
        country: str("a country, ISO 3166-1 alpha-2", {
          pattern: "^[A-Z]{2}$",
        }),
        asn: int("an autonomous system number", 0),
        action: oneOf(
          ["allow", "block", "challenge", "drop"],
          "what a match does (required in the effective policy)",
        ),
        override: bool(
          "an allow that wins over a block in the same scope; default false",
        ),
        locked: bool("lower scopes cannot override it; default false"),
        scope: oneOf(
          ["global", "group", "service"],
          'where it was written; default "service"',
        ),
        paths: list(str("a route prefix"), "the routes it applies to"),
        expiresAt: str("when it stops applying, ISO 8601 with a time zone", {
          format: "date-time",
        }),
        mode: MODE,
        reason: str("why it exists, for operators"),
        createdBy: str("who added it"),
        code: str("the refusal's problem code"),
      },
    ),
  },
});

/**
 * {@link SECURITY_POLICY_JSON_SCHEMA} with every `$defs` reference resolved
 * in place and no `$defs` or `$schema`: one self-contained node, for
 * embedding in another document (the control plane's OpenAPI document
 * lifts it into its `SecurityPolicy` component). A fresh copy each call.
 */
export function inlinePolicyJsonSchema(): Record<string, unknown> {
  const defs = SECURITY_POLICY_JSON_SCHEMA.$defs as Readonly<
    Record<string, unknown>
  >;
  const resolve = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(resolve);
    if (typeof node !== "object" || node === null) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        const name = value.slice("#/$defs/".length);
        Object.assign(out, resolve(defs[name]));
        continue;
      }
      out[key] = resolve(value);
    }
    // A sibling of the reference (its own description) wins over the def's.
    for (const [key, value] of Object.entries(node)) {
      if (key !== "$ref") out[key] = resolve(value);
    }
    return out;
  };
  const {
    $defs: _defs,
    $schema: _schema,
    ...root
  } = SECURITY_POLICY_JSON_SCHEMA;
  return resolve(root) as Record<string, unknown>;
}
