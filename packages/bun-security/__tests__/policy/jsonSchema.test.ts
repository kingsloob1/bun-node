/**
 * The policy's JSON Schema against its validator (PR-AN2): the schema is
 * written beside the validator, so these keep the two in step.
 *
 * - **Keys.** Every object the schema closes (`additionalProperties:
 *   false`) names exactly the keys the validator knows there: a probe key
 *   placed there is refused by the validator with its list of known keys,
 *   which must equal the schema's; and `$` notes are taken by both or
 *   neither.
 * - **Values.** A policy that sets every key the schema names passes the
 *   validator and the schema (ajv, draft 2020-12), as does each partial
 *   layer a scope may hold.
 * - **The document.** The control plane's OpenAPI document carries it once,
 *   as `components.schemas.SecurityPolicy`, referenced wherever a policy
 *   appears, with no dangling reference.
 *
 * Each with its negative control.
 */
import { describe, expect, it } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { danglingRefs } from "@kingsleyweb/bun-common/lib/docs";
import {
  inlinePolicyJsonSchema,
  SECURITY_POLICY_JSON_SCHEMA,
} from "../../lib/policy/jsonSchema";
import { PRESET_IDS } from "../../lib/policy/presets";
import { validatePolicy } from "../../lib/policy/schema";
import { testApi } from "../control/helpers";

type Node = Record<string, unknown>;
type Path = (string | number)[];

const HASH = "0123456789abcdef0123456789abcdef";
const VERIFIER = `sha256:${"a".repeat(64)}`;

/** A policy setting every key the schema names, each to a value both accept. */
const EVERYTHING = {
  $note: "notes are ignored",
  version: 1,
  service: "checkout",
  environment: "production",
  public: true,
  mode: "enforce",
  keys: { ipv6Prefix: 56 },
  internal: { ranges: ["10.0.0.0/8"] },
  lists: [
    {
      id: "office",
      ip: "198.51.100.0/24",
      action: "allow",
      override: true,
      locked: true,
      scope: "global",
      paths: ["/admin"],
      expiresAt: "2030-01-01T00:00:00Z",
      mode: "dryRun",
      reason: "the office",
      createdBy: "ops",
      code: "nope",
    },
    { user: "u-1", action: "block" },
    { userHash: HASH, action: "block" },
    { apiKey: "k-1", action: "block" },
    { apiKeyHash: HASH.replace("0", "1"), action: "block" },
    { country: "KP", action: "drop" },
    { asn: 64_501, action: "challenge" },
  ],
  serviceIdentity: {
    header: "x-service-token",
    clientIpHeader: "x-service-client-ip",
    services: [
      {
        id: "pay-api",
        verifier: [VERIFIER],
        forwardsClientIp: true,
        exempt: ["lists", "bans"],
      },
    ],
  },
  trustCheck: { threshold: 0.6, window: "5m", minRequests: 30 },
  concurrency: {
    perIp: 32,
    total: 1_000,
    releaseAfter: "30s",
    mode: "enforce",
  },
  limits: [
    {
      id: "per-route",
      limit: 100,
      window: { minutes: 1 },
      subSecond: false,
      key: ["ip", "route"],
      routes: ["POST /login"],
      algorithm: "fixed-window",
      cost: 1,
      mode: "enforce",
      locked: true,
      appliesToServices: true,
      evenWhenAllowed: true,
      code: "slow_down",
      state: "local",
      onStoreError: "open",
      profile: "login",
      apiKeyPlan: "free",
    },
  ],
  countedRules: [
    {
      id: "scan",
      event: "probe.hit",
      threshold: 3,
      window: "1m",
      subSecond: false,
      key: "ip",
      routes: ["/wp-admin/*"],
      action: "ban",
      duration: "1h",
      mode: "enforce",
      locked: false,
      appliesToServices: false,
      code: "banned",
      weight: 2,
      state: "local",
      onStoreError: "local",
      profile: "login",
    },
  ],
  bans: {
    code: "banned",
    retryAfter: true,
    maxActive: 50_000,
    mode: "enforce",
  },
  ladder: {
    halfLife: "1h",
    steps: [
      { score: 5, action: "challenge" },
      { score: 10, action: "ban", duration: "1h" },
    ],
    base: "10m",
    factor: 2,
    maxBan: "7d",
    memory: "30d",
    weights: { "probe.hit": 2 },
    mode: "enforce",
  },
  shape: {
    caseSensitive: false,
    maxPathBytes: 2_048,
    maxQueryBytes: 4_096,
    maxQueryParams: 64,
    maxQueryDepth: 4,
    maxHeaders: 64,
    maxHeaderBytes: 16_384,
    methods: ["GET", "POST"],
    hosts: ["example.com"],
    headerLimits: { cookie: 4_096 },
    maxBodySize: 1_048_576,
    routes: [
      {
        routes: ["POST /upload"],
        maxBodySize: 10_485_760,
        contentTypes: ["image/*"],
        allowEncodedSlash: false,
      },
    ],
    mode: "enforce",
  },
  deception: {
    honeypots: {
      paths: ["/wp-login.php"],
      answer: "not-found",
      mode: "enforce",
    },
    canaries: [
      { id: "c-user", user: "canary-user" },
      { id: "c-key", apiKey: "canary-key" },
      { id: "c-user-hash", userHash: HASH },
      { id: "c-key-hash", apiKeyHash: HASH },
    ],
  },
  requestRules: {
    rules: [
      {
        id: "no-admin",
        when: { path: { prefix: "/admin" } },
        action: "block",
        weight: 1,
        mode: "enforce",
        status: 403,
        code: "nope",
        crawlers: "skip",
        locked: false,
      },
      {
        id: "ban-env",
        when: { path: { equals: "/.env" } },
        action: "ban",
        duration: "1h",
      },
    ],
    managed: { mode: "enforce", exclude: ["wordpress"], weight: 1 },
    maxRegexInput: 2_048,
  },
  state: { mode: "local", onStoreError: "local", nodes: 2, scope: "service" },
  messages: {
    perConnection: { limit: 100, window: "1s", subSecond: false },
    burst: 20,
    breach: "5s",
    closeCode: 1008,
    limits: [
      {
        id: "chat",
        limit: 10,
        window: "1s",
        subSecond: false,
        key: "ip",
        routes: ["/chat"],
        algorithm: "sliding-window",
        cost: 1,
        mode: "enforce",
        locked: false,
        appliesToServices: false,
        evenWhenAllowed: false,
        code: "slow_down",
        state: "local",
        onStoreError: "local",
        profile: "login",
        apiKeyPlan: "free",
      },
    ],
    mode: "enforce",
  },
  botSignals: {
    mode: "dryRun",
    weights: { noUserAgent: 2 },
    challengeAt: 5,
    browserPaths: ["/app/*"],
    classes: { hosting: 1 },
  },
  crawlers: {
    mode: "enforce",
    allow: ["google", "bing"],
    verify: "ranges-then-rdns",
    methods: ["GET", "HEAD"],
    paths: { include: ["/*"], exclude: ["/admin/*"] },
    exempt: ["notFound", "probeRules"],
    limit: "3000/1m",
    spoofed: { action: "block", weight: 5 },
    custom: [
      {
        id: "acme-search",
        tokens: ["AcmeBot"],
        ranges: "https://acme.example/bot-ranges.json",
        rdns: ["crawl.acme.example"],
      },
    ],
  },
  apiKeys: {
    newAsn: { mode: "dryRun", action: "tag", duration: "1h", remember: "30d" },
    manyAddresses: {
      mode: "dryRun",
      action: "tag",
      duration: "1h",
      limit: 20,
      window: "1h",
    },
  },
  presets: { [PRESET_IDS[0]]: true, $why: "a note" },
  profiles: {
    login: {
      failures: {
        window: "15m",
        delayAfter: 5,
        challengeAfter: 10,
        lockAfter: 20,
        lockFor: "15m",
        maxDelay: "2s",
      },
      distinctUsernames: {
        window: "1h",
        challengeAt: 10,
        banAt: 30,
        banFor: "1h",
      },
      distinctAddresses: { window: "1h", stepUpAt: 10 },
      riskySuccessAfter: 10,
      device: { cookie: "__Host-device", maxAge: "365d" },
      inferOutcome: true,
      mode: "enforce",
      failureRate: {
        window: "5m",
        baseline: "7d",
        factor: 3,
        minFailures: 50,
        hold: "15m",
        respond: "limit",
        to: ["hosting"],
        limit: { attempts: 5, window: "1m", by: "asn" },
      },
    },
  },
  identifiers: {
    patterns: [
      {
        id: "throwaway",
        kind: "email",
        pattern: "*@mailinator.com",
        reason: "throwaway mail",
        mode: "enforce",
      },
    ],
    reserved: true,
    ownDomains: ["example.com"],
    code: "not_allowed",
  },
};

/** The schema's `$defs`. */
const DEFS = SECURITY_POLICY_JSON_SCHEMA.$defs as Record<string, Node>;

/** A node with its `$ref` resolved. */
function resolved(
  node: Node,
  schema: Node = SECURITY_POLICY_JSON_SCHEMA,
): Node {
  const defs = (schema.$defs ?? DEFS) as Record<string, Node>;
  if (typeof node.$ref !== "string") return node;
  return resolved(defs[node.$ref.slice("#/$defs/".length)], schema);
}

/** Whether `value` is a plain object. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every closed object node of `schema` the policy reaches, with the policy's
 * value there and its path; and every property path the schema names that
 * the policy never set (each array's items taken together).
 */
function walk(
  schema: Node,
  policy: unknown,
): {
  closed: { node: Node; path: Path }[];
  unset: string[];
} {
  const closed: { node: Node; path: Path }[] = [];
  const unset = new Set<string>();
  const set = new Set<string>();
  const visit = (raw: Node, value: unknown, path: Path, shape: string) => {
    // A duration is bun-common's grammar (`toDurationMs`), not the policy's.
    if (raw.$ref === "#/$defs/PolicyDuration") return;
    const node = resolved(raw, schema);
    for (const branch of (node.anyOf ?? []) as Node[]) {
      const inner = resolved(branch, schema);
      if (
        (inner.type === "object" && isObject(value)) ||
        (inner.type === "array" && Array.isArray(value))
      ) {
        visit(inner, value, path, shape);
      }
    }
    if (node.type === "array" && Array.isArray(value)) {
      value.forEach((item, i) =>
        visit(node.items as Node, item, [...path, i], `${shape}[]`),
      );
    }
    if (node.type !== "object" || !isObject(value)) return;
    const properties = node.properties as Record<string, Node> | undefined;
    if (properties === undefined) return;
    if (node.additionalProperties === false) closed.push({ node, path });
    for (const [key, child] of Object.entries(properties)) {
      const at = `${shape}.${key}`;
      if (value[key] === undefined) unset.add(at);
      else {
        set.add(at);
        visit(child, value[key], [...path, key], at);
      }
    }
  };
  visit(schema, policy, [], "");
  return { closed, unset: [...unset].filter((at) => !set.has(at)) };
}

/** `structuredClone(policy)` with `value` set at `path` under `key`. */
function withKey(policy: unknown, path: Path, key: string, value: unknown) {
  const copy = structuredClone(policy) as Record<string, unknown>;
  let at: Record<string, unknown> = copy;
  for (const part of path) at = at[part] as Record<string, unknown>;
  at[key] = value;
  return copy;
}

/** The keys the validator lists as known at `path`, from its unknown-key issue. */
function knownKeys(path: Path): string[] | undefined {
  const issues = validatePolicy(withKey(EVERYTHING, path, "zzProbe", 1));
  const issue = issues.find(
    (i) => JSON.stringify(i.path) === JSON.stringify([...path, "zzProbe"]),
  );
  const list = issue?.message.match(/\(([^()]*)\)\s*$/)?.[1];
  return list
    ?.replace(/^known: /, "")
    .split(", ")
    .sort();
}

/** The disagreements between `schema`'s closed objects and the validator. */
function keyDisagreements(schema: Node): string[] {
  const out: string[] = [];
  for (const { node, path } of walk(schema, EVERYTHING).closed) {
    const own = Object.keys(node.properties as Node).sort();
    const known = knownKeys(path);
    if (JSON.stringify(own) !== JSON.stringify(known)) {
      out.push(
        `${path.join(".") || "(root)"}: schema ${own.join(",")} / validator ${known?.join(",") ?? "(no unknown-key check)"}`,
      );
    }
    const notes =
      validatePolicy(withKey(EVERYTHING, path, "$zz", 1)).length === 0;
    if (notes !== (node.patternProperties !== undefined)) {
      out.push(
        `${path.join(".") || "(root)"}: $ notes ${notes ? "taken" : "refused"} by the validator, not by the schema`,
      );
    }
  }
  return out;
}

/** An ajv validator for `schema`. */
function ajvFor(schema: Node) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("date-time", true);
  return ajv.compile(schema);
}

describe("the policy's JSON Schema", () => {
  it("the everything-policy sets every key it names, and the validator takes it", () => {
    expect(walk(SECURITY_POLICY_JSON_SCHEMA, EVERYTHING).unset).toEqual([]);
    expect(validatePolicy(EVERYTHING)).toEqual([]);
  });

  it("closes each object with exactly the keys the validator knows there", () => {
    expect(
      walk(SECURITY_POLICY_JSON_SCHEMA, EVERYTHING).closed.length,
    ).toBeGreaterThan(30);
    expect(keyDisagreements(SECURITY_POLICY_JSON_SCHEMA)).toEqual([]);
  });

  it("negative control: a key missing from the schema, or one too many, is a disagreement", () => {
    const missing = structuredClone(SECURITY_POLICY_JSON_SCHEMA) as Node;
    delete (
      (missing.$defs as Record<string, Node>).PolicyLimit.properties as Node
    ).cost;
    expect(keyDisagreements(missing)).toEqual([
      expect.stringContaining("limits.0: schema"),
      expect.stringContaining("messages.limits.0: schema"),
    ]);
    const extra = structuredClone(SECURITY_POLICY_JSON_SCHEMA) as Node;
    ((extra.properties as Record<string, Node>).bans.properties as Node).ttl = {
      type: "string",
    };
    expect(keyDisagreements(extra)).toEqual([
      expect.stringContaining("bans: schema"),
    ]);
  });

  it("takes every policy the validator takes: the everything-policy and partial layers", () => {
    const check = ajvFor(SECURITY_POLICY_JSON_SCHEMA);
    const inline = ajvFor(inlinePolicyJsonSchema());
    const layers = [
      EVERYTHING,
      {},
      { limits: [{ id: "per-route", mode: "off" }] },
      { lists: [{ id: "office", locked: true }] },
      { trustCheck: false, concurrency: false, ladder: false, shape: false },
      { internal: false, crawlers: { mode: "off", limit: false } },
      { profiles: { login: false } },
    ];
    for (const layer of layers) {
      expect([check(layer), check.errors ?? []]).toEqual([true, []]);
      expect(inline(layer)).toBe(true);
    }
  });

  it("negative control: a typo, a wrong type and a bad enum are refused by both", () => {
    const check = ajvFor(SECURITY_POLICY_JSON_SCHEMA);
    for (const bad of [
      { limitz: [] },
      { bans: { maxActive: "lots" } },
      { mode: "always" },
      { limits: [{ id: "x", algorithm: "leaky-bucket" }] },
    ]) {
      expect(check(bad)).toBe(false);
      expect(validatePolicy(bad).length).toBeGreaterThan(0);
    }
  });

  it("negative control: without a key the schema refuses the everything-policy", () => {
    const missing = structuredClone(SECURITY_POLICY_JSON_SCHEMA) as Node;
    delete (
      (missing.properties as Record<string, Node>).crawlers.properties as Node
    ).spoofed;
    expect(ajvFor(missing)(EVERYTHING)).toBe(false);
  });

  it("the inline form has no reference left and keeps the title", () => {
    const inline = inlinePolicyJsonSchema();
    expect(JSON.stringify(inline)).not.toContain("$ref");
    expect(inline.$defs).toBeUndefined();
    expect(inline.title).toBe("SecurityPolicy");
  });
});

describe("the policy in the OpenAPI document", () => {
  it("is one component, referenced wherever a policy appears, with no dangling reference", async () => {
    const t = testApi();
    const document = (await t.call("GET", "/openapi.json")).body;
    const text = JSON.stringify(document);
    expect(document.components.schemas.SecurityPolicy.title).toBe(
      "SecurityPolicy",
    );
    expect(text.split('"title":"SecurityPolicy"')).toHaveLength(2);
    const draft =
      document.paths["/policies/{scope}/draft"].put.requestBody.content[
        "application/json"
      ].schema;
    const body =
      draft.$ref === undefined
        ? draft
        : document.components.schemas[draft.$ref.split("/").pop()];
    expect(body.properties.policy).toEqual({
      $ref: "#/components/schemas/SecurityPolicy",
    });
    expect(danglingRefs(document)).toEqual([]);
    // The component validates as a schema and takes the everything-policy.
    expect(ajvFor(document.components.schemas.SecurityPolicy)(EVERYTHING)).toBe(
      true,
    );
  });
});
