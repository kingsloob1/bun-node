/**
 * `compilePolicy`: a validated policy turned into the structures the engine
 * reads per request (control-plane.md §2.3) — the address ranges in a CIDR
 * trie, users and API keys in maps, the internal list as locked allow
 * entries, service verifiers as bytes, limits and counted rules with their
 * windows in milliseconds and their routes parsed. Pure: the same policy
 * compiles to the same thing, and nothing about a request is decided here.
 */
import { toDurationMs } from "@kingsleyweb/bun-common";
import type { Duration } from "@kingsleyweb/bun-common";
import { parseCidr } from "../ip/address";
import { CidrTrie } from "../ip/trie";
import { SecurityPolicyError } from "./errors";
import { INTERNAL_RANGES } from "./internal";
import { crawlerLimitRule } from "../crawlers/policy";
import { withPresets } from "./presets";
import { parseRoutePattern } from "./routes";
import type { RoutePattern } from "./routes";
import {
  DEFAULT_CLIENT_IP_HEADER,
  DEFAULT_CONCURRENCY_PER_IP,
  DEFAULT_SERVICE_HEADER,
  defaultEntryId,
  SECURITY_POLICY_VERSION,
  validatePolicy,
} from "./schema";
import type { PolicyBounds } from "./schema";
import type {
  CountedRuleAction,
  LimitAlgorithm,
  ListAction,
  ListEntry,
  SecurityMode,
  LimitRule,
  SecurityPolicy,
  ServiceExemption,
  StateMode,
  StoreErrorMode,
  SubjectKeyPart,
} from "./types";

/** A key as the engine reads it. */
export interface CompiledKey {
  /** Its parts, in order. */
  readonly parts: readonly SubjectKeyPart[];
  /**
   * Whether it names only the address (and route): such a key never counts
   * or refuses an internal client (the `internal` list protects addresses).
   */
  readonly addressOnly: boolean;
}

/** A limit as the engine reads it. */
export interface CompiledLimit {
  /** Its id: the throttle foundation's limit name. */
  readonly id: string;
  /** Requests per window. */
  readonly limit: number;
  /** The window, in milliseconds. */
  readonly window: number;
  /** The key. */
  readonly key: CompiledKey;
  /** The routes it applies to; every route when undefined. */
  readonly routes: readonly RoutePattern[] | undefined;
  /** How it counts. */
  readonly algorithm: LimitAlgorithm;
  /** What a request costs. */
  readonly cost: number;
  /** `enforce` or `dryRun` (limits that are `off` are not compiled). */
  readonly mode: "enforce" | "dryRun";
  /** Applies to a verified service exempt from global limits. */
  readonly appliesToServices: boolean;
  /** Counts a request an allow entry let through. */
  readonly evenWhenAllowed: boolean;
  /** The `429`'s problem code. */
  readonly code: string;
  /** Where it counts; `undefined`: `shared` with a shared store, `local` without. */
  readonly state: StateMode | undefined;
  /** What it does when the shared store fails. */
  readonly onStoreError: StoreErrorMode;
  /** Only requests of routes with this profile count; every route when undefined. */
  readonly profile: string | undefined;
  /** Only requests whose API key is on this plan count; every request when undefined. */
  readonly apiKeyPlan: string | undefined;
}

/** A counted rule as the engine reads it. */
export interface CompiledCountedRule {
  /** Its id. */
  readonly id: string;
  /** The event it counts. */
  readonly event: string;
  /** Occurrences that trip it. */
  readonly threshold: number;
  /** The window, in milliseconds. */
  readonly window: number;
  /** The key. */
  readonly key: CompiledKey;
  /** The routes whose occurrences count; every route when undefined. */
  readonly routes: readonly RoutePattern[] | undefined;
  /** What a trip does. */
  readonly action: CountedRuleAction;
  /** How long its ban lasts, in milliseconds; `Infinity` until lifted; `0` with `action: "ladder"` (the ladder decides). */
  readonly duration: number;
  /** `enforce` or `dryRun` (rules that are `off` are not compiled). */
  readonly mode: "enforce" | "dryRun";
  /** Counts and refuses a verified service's forwarded end user despite its exemptions. */
  readonly appliesToServices: boolean;
  /** The offence weight of a trip. */
  readonly weight: number;
  /** Its bans' problem code; the policy's `bans.code` when undefined. */
  readonly code: string | undefined;
  /** Where its counters live; `undefined`: `shared` with a shared store, `local` without. */
  readonly state: "local" | "shared" | undefined;
  /** What it does when the shared store fails. */
  readonly onStoreError: "local" | "open";
  /** Only occurrences on routes with this profile count; every route when undefined. */
  readonly profile: string | undefined;
}

/** WebSocket message limits (layers.md L9.5), compiled. */
export interface CompiledMessages {
  /** The per-connection bucket: its refill (`limit` per `window` ms) and its size; `undefined` when off. */
  readonly perConnection:
    | {
        /** Messages per window. */
        readonly limit: number;
        /** The window, in milliseconds. */
        readonly window: number;
        /** The bucket's size, in messages. */
        readonly capacity: number;
      }
    | undefined;
  /** A second breach within this many milliseconds closes. */
  readonly breach: number;
  /** The close code. */
  readonly closeCode: number;
  /** The limits across connections. */
  readonly limits: readonly CompiledLimit[];
  /** `enforce` or `dryRun`. */
  readonly mode: "enforce" | "dryRun";
}

/** The bans' settings, compiled. */
export interface CompiledBans {
  /** A ban's problem code. */
  readonly code: string;
  /** Whether a ban's answer carries `Retry-After`. */
  readonly retryAfter: boolean;
  /** The most bans held. */
  readonly maxActive: number;
  /** The bans' mode. */
  readonly mode: SecurityMode;
}

/** One ladder step, compiled. */
export interface CompiledStep {
  /** The score that reaches it. */
  readonly score: number;
  /** What it does. */
  readonly action: "challenge" | "ban";
  /** Its length in ms; `undefined` for the escalating ban length. */
  readonly duration: number | undefined;
}

/** The ladder, compiled. */
export interface CompiledLadder {
  /** The score's half-life, ms. */
  readonly halfLife: number;
  /** The steps, highest score first. */
  readonly steps: readonly CompiledStep[];
  /** The first escalating ban's length, ms. */
  readonly base: number;
  /** The escalation factor. */
  readonly factor: number;
  /** The longest escalating ban, ms. */
  readonly maxBan: number;
  /** How long a ban counts toward the next, ms. */
  readonly memory: number;
  /** Each event's offence weight. */
  readonly weights: ReadonlyMap<string, number>;
  /** `enforce` or `dryRun`. */
  readonly mode: "enforce" | "dryRun";
}

/** One per-route shape entry, compiled. */
export interface CompiledShapeRoute {
  /** The routes it applies to. */
  readonly routes: readonly RoutePattern[];
  /** The largest body, bytes. */
  readonly maxBodySize: number | undefined;
  /** The accepted media types (`type/subtype` or `type/*`). */
  readonly contentTypes: readonly string[] | undefined;
  /** Whether an encoded slash or backslash is accepted. */
  readonly allowEncodedSlash: boolean;
}

/** Request shape, compiled. */
export interface CompiledShape {
  /** Whether paths match case-sensitively. */
  readonly caseSensitive: boolean;
  /** The longest path, bytes. */
  readonly maxPathBytes: number;
  /** The longest query, bytes. */
  readonly maxQueryBytes: number;
  /** The most query parameters. */
  readonly maxQueryParams: number;
  /** The deepest query nesting. */
  readonly maxQueryDepth: number;
  /** The accepted methods; any (but TRACE and CONNECT) when undefined. */
  readonly methods: ReadonlySet<string> | undefined;
  /** The accepted Host values; any when undefined. */
  readonly hosts: ReadonlySet<string> | undefined;
  /** The most header lines. */
  readonly maxHeaders: number;
  /** The longest header value, bytes. */
  readonly maxHeaderBytes: number;
  /** Per-header limits. */
  readonly headerLimits: ReadonlyMap<string, number>;
  /** The largest body on any route, bytes. */
  readonly maxBodySize: number | undefined;
  /** Per-route entries, first match wins. */
  readonly routes: readonly CompiledShapeRoute[];
  /** `enforce` or `dryRun`. */
  readonly mode: "enforce" | "dryRun";
}

/** Deception, compiled. */
export interface CompiledDeception {
  /** Honeypot paths, or undefined when off. */
  readonly honeypots:
    | {
        readonly patterns: readonly RoutePattern[];
        readonly answer: "pass" | "not-found";
        readonly mode: "enforce" | "dryRun";
      }
    | undefined;
  /** Canary user ids, to the canary's id. */
  readonly canaryUsers: ReadonlyMap<string, string>;
  /** Canary API key ids, to the canary's id. */
  readonly canaryKeys: ReadonlyMap<string, string>;
}

/** The default honeypot paths (layers.md L8). */
export const DEFAULT_HONEYPOTS: readonly string[] = Object.freeze([
  "/wp-login.php",
  "/.env",
  "/admin.php",
]);

/** The default event weights (layers.md §0.2, L8, L6). */
export const DEFAULT_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  "honeypot.hit": 10,
  "canary.used": 100,
  "trap.filled": 10,
  "shape.refused": 1,
});

/** The connection limits, compiled. */
export interface CompiledConcurrency {
  /** In-flight requests per client address; `undefined` for no limit. */
  readonly perIp: number | undefined;
  /** In-flight requests in all; `undefined` for no limit. */
  readonly total: number | undefined;
  /** A slot older than this (ms) is no longer counted. */
  readonly releaseAfter: number;
  /** `enforce` or `dryRun`. */
  readonly mode: "enforce" | "dryRun";
}

/** A list entry as the engine reads it. */
export interface CompiledEntry {
  /** The entry's id. */
  readonly id: string;
  /** What kind of subject it matches; `internal` for the built-in list. */
  readonly kind: "ip" | "user" | "apiKey" | "country" | "asn" | "internal";
  /** The subject, canonical (a range as `base/bits`). */
  readonly value: string;
  /** Its action. */
  readonly action: ListAction;
  /** An allow that wins over a block in its scope. */
  readonly override: boolean;
  /** Weighed before every unlocked entry. */
  readonly locked: boolean;
  /** Specificity: 0 global, 1 group, 2 service, 3 route-scoped. */
  readonly level: number;
  /** Route prefixes, without a trailing slash; every path when undefined. */
  readonly paths: readonly string[] | undefined;
  /** When it stops applying (epoch ms); never when undefined. */
  readonly expiresAt: number | undefined;
  /** `enforce` or `dryRun` (entries that are `off` are not compiled). */
  readonly mode: "enforce" | "dryRun";
  /** The refusal's problem code. */
  readonly code: string;
}

/** A service identity as the engine reads it. */
export interface CompiledService {
  /** The calling service's id. */
  readonly id: string;
  /** Each accepted token's SHA-256, 32 bytes. */
  readonly verifiers: readonly Uint8Array[];
  /** Whether its forwarded end-user address is believed. */
  readonly forwardsClientIp: boolean;
  /** What a verified call skips. */
  readonly exempt: ReadonlySet<ServiceExemption>;
}

/** The trust check's settings, compiled. */
export interface CompiledTrustCheck {
  /** The suspicious share of a minute's requests. */
  readonly threshold: number;
  /** Minutes in a row before the warning. */
  readonly minutes: number;
  /** A quieter minute never counts. */
  readonly minRequests: number;
}

/** What the engine reads of a compiled policy. */
export interface PolicyInternals {
  /** The policy's mode. */
  readonly mode: SecurityMode;
  /** The IPv6 key prefix. */
  readonly ipv6Prefix: number;
  /** Address entries and the internal list, by range. */
  readonly ips: CidrTrie<CompiledEntry>;
  /** User entries, by user id. */
  readonly users: ReadonlyMap<string, readonly CompiledEntry[]>;
  /** API key entries, by key id. */
  readonly apiKeys: ReadonlyMap<string, readonly CompiledEntry[]>;
  /** Country entries, by ISO code (layers.md L5; need the engine's `intel`). */
  readonly countries: ReadonlyMap<string, readonly CompiledEntry[]>;
  /** ASN entries, by number (layers.md L5; need the engine's `intel`). */
  readonly asns: ReadonlyMap<number, readonly CompiledEntry[]>;
  /** The service-token header. */
  readonly serviceHeader: string;
  /** The forwarded end-user address header. */
  readonly clientIpHeader: string;
  /** The services allowed to call. */
  readonly services: readonly CompiledService[];
  /** The trust check, or undefined when off. */
  readonly trustCheck: CompiledTrustCheck | undefined;
  /** The connection limits, or undefined when off. */
  readonly concurrency: CompiledConcurrency | undefined;
  /** The limits, in policy order (`off` ones skipped). */
  readonly limits: readonly CompiledLimit[];
  /** The counted rules, in policy order (`off` ones skipped). */
  readonly countedRules: readonly CompiledCountedRule[];
  /** The counted rules by the event they count. */
  readonly countedByEvent: ReadonlyMap<string, readonly CompiledCountedRule[]>;
  /** The bans' settings. */
  readonly bans: CompiledBans;
  /** The ladder, or undefined when off. */
  readonly ladder: CompiledLadder | undefined;
  /** Request shape, or undefined when off. */
  readonly shape: CompiledShape | undefined;
  /** Whether list `paths` match case-sensitively (`shape.caseSensitive`; folded otherwise). */
  readonly caseSensitive: boolean;
  /** Deception. */
  readonly deception: CompiledDeception;
  /** Processes sharing the store: a rule's local share is its limit ÷ this. */
  readonly nodes: number;
  /** Who shares bans and scores: every `shared` service, or this service alone. */
  readonly scope: "shared" | "service";
  /** WebSocket message limits, or undefined when the section is absent or off. */
  readonly messages: CompiledMessages | undefined;
}

/**
 * A policy compiled by {@link compilePolicy}: what `createSecurity()` and
 * `load()` run. Only `compilePolicy` makes one; an object of the same shape
 * made by hand is not accepted.
 */
export interface CompiledPolicy {
  /** The policy as given, frozen. */
  readonly source: SecurityPolicy;
  /** The policy's format version (`1`; a policy without one reads as 1). */
  readonly version: number;
  /** The service's id, if the policy names one. */
  readonly service: string | undefined;
  /** The environment, if the policy names one. */
  readonly environment: string | undefined;
  /** The whole policy's mode. */
  readonly mode: SecurityMode;
  /** Whether the service takes traffic from the internet. */
  readonly public: boolean;
  /** The list entries compiled, the internal list not counted (`off` entries skipped). */
  readonly listEntries: number;
  /** The internal list's ranges in force, canonical. */
  readonly internalRanges: readonly string[];
}

/** Options for {@link compilePolicy}. */
export interface CompilePolicyOptions extends PolicyBounds {
  /**
   * The most list entries, the `internal` list not counted. Default
   * `DEFAULT_MAX_LIST_ENTRIES` (1,000,000, control-plane.md §9).
   */
  readonly maxListEntries?: number;
}

/** The engine's view of each compiled policy. */
const internals = new WeakMap<CompiledPolicy, PolicyInternals>();

/** Whether `value` was made by {@link compilePolicy}. */
export function isCompiledPolicy(value: unknown): value is CompiledPolicy {
  return (
    typeof value === "object" &&
    value !== null &&
    internals.has(value as CompiledPolicy)
  );
}

/** The engine's view of a compiled policy. */
export function policyInternals(policy: CompiledPolicy): PolicyInternals {
  const found = internals.get(policy);
  if (!found) {
    throw new TypeError(
      "not a compiled policy: pass it through compilePolicy()",
    );
  }
  return found;
}

/** A frozen deep copy of plain JSON-like data. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  const copy = (
    Array.isArray(value)
      ? value.map(deepFreeze)
      : Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, deepFreeze(item)]),
        )
  ) as T;
  return Object.freeze(copy);
}

/** `prefix` without a trailing slash (`/` stays). */
function trimPrefix(prefix: string): string {
  return prefix.length > 1 && prefix.endsWith("/")
    ? prefix.replace(/\/+$/, "") || "/"
    : prefix;
}

/** Specificity of an entry's scope. */
const LEVEL = { global: 0, group: 1, service: 2 } as const;

/** Hex to bytes (a verifier's 64 digits). */
function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** A validated key, compiled (`"ip"` when absent). */
function compileKey(
  key: SubjectKeyPart | readonly SubjectKeyPart[] | undefined,
): CompiledKey {
  const parts: readonly SubjectKeyPart[] =
    key === undefined ? ["ip"] : typeof key === "string" ? [key] : key;
  return Object.freeze({
    parts: Object.freeze([...parts]),
    addressOnly: parts.every((part) => part === "ip" || part === "route"),
  });
}

/** Validated route patterns, compiled; `undefined` for every route. */
function compileRoutes(
  routes: readonly string[] | undefined,
): readonly RoutePattern[] | undefined {
  if (routes === undefined) return undefined;
  const parsed: RoutePattern[] = [];
  for (const route of routes) {
    const pattern = parseRoutePattern(route);
    if (pattern) parsed.push(Object.freeze(pattern));
  }
  return Object.freeze(parsed);
}

/** A validated duration in milliseconds. */
function ms(value: Duration, where: string): number {
  return toDurationMs(value, where);
}

/** Adds `entry` under `key` in `map`. */
function addTo<K>(
  map: Map<K, CompiledEntry[]>,
  key: K,
  entry: CompiledEntry,
): void {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}

/** The ladder of a validated policy; `undefined` when off. */
function compileLadder(source: SecurityPolicy): CompiledLadder | undefined {
  const given = source.ladder;
  if (given === false || given?.mode === "off") return undefined;
  const steps = (
    given?.steps ?? [
      { score: 3, action: "challenge" as const },
      { score: 10, action: "ban" as const },
    ]
  )
    .map((step): CompiledStep =>
      Object.freeze({
        score: step.score,
        action: step.action,
        duration:
          step.duration === undefined
            ? step.action === "challenge"
              ? 15 * 60_000
              : undefined
            : ms(step.duration, "ladder.steps.duration"),
      }),
    )
    .sort((a, b) => b.score - a.score);
  return Object.freeze({
    halfLife: ms(given?.halfLife ?? "1h", "ladder.halfLife"),
    steps: Object.freeze(steps),
    base: ms(given?.base ?? "1h", "ladder.base"),
    factor: given?.factor ?? 6,
    maxBan: ms(given?.maxBan ?? "30d", "ladder.maxBan"),
    memory: ms(given?.memory ?? "7d", "ladder.memory"),
    weights: new Map(Object.entries({ ...DEFAULT_WEIGHTS, ...given?.weights })),
    mode: given?.mode ?? "enforce",
  });
}

/** Request shape of a validated policy; `undefined` when off. */
function compileShape(
  source: SecurityPolicy,
  caseSensitive: boolean,
): CompiledShape | undefined {
  const given = source.shape;
  if (given === false || given?.mode === "off") return undefined;
  return Object.freeze({
    caseSensitive,
    maxPathBytes: given?.maxPathBytes ?? 2048,
    maxQueryBytes: given?.maxQueryBytes ?? 8192,
    maxQueryParams: given?.maxQueryParams ?? 256,
    maxQueryDepth: given?.maxQueryDepth ?? 5,
    methods: given?.methods ? new Set(given.methods) : undefined,
    hosts: given?.hosts ? new Set(given.hosts) : undefined,
    maxHeaders: given?.maxHeaders ?? 100,
    maxHeaderBytes: given?.maxHeaderBytes ?? 8192,
    headerLimits: new Map(
      Object.entries({ cookie: 16_384, ...given?.headerLimits }),
    ),
    maxBodySize:
      given?.maxBodySize === undefined || given.maxBodySize === false
        ? undefined
        : given.maxBodySize,
    routes: Object.freeze(
      (given?.routes ?? []).map((route): CompiledShapeRoute =>
        Object.freeze({
          routes: compileRoutes(route.routes) ?? [],
          maxBodySize: route.maxBodySize,
          contentTypes: route.contentTypes
            ? Object.freeze([...route.contentTypes])
            : undefined,
          allowEncodedSlash: route.allowEncodedSlash === true,
        }),
      ),
    ),
    mode: given?.mode ?? "enforce",
  });
}

/** Deception of a validated policy. */
function compileDeception(source: SecurityPolicy): CompiledDeception {
  const given = source.deception;
  const honeypots =
    given?.honeypots === undefined || given.honeypots === false
      ? undefined
      : given.honeypots === true
        ? {}
        : given.honeypots;
  const canaryUsers = new Map<string, string>();
  const canaryKeys = new Map<string, string>();
  for (const canary of given?.canaries ?? []) {
    if (canary.user !== undefined) canaryUsers.set(canary.user, canary.id);
    if (canary.apiKey !== undefined) canaryKeys.set(canary.apiKey, canary.id);
  }
  return Object.freeze({
    honeypots:
      honeypots === undefined || honeypots.mode === "off"
        ? undefined
        : Object.freeze({
            // Route patterns fold case: a honeypot hit in any case is a probe.
            patterns: compileRoutes(honeypots.paths ?? DEFAULT_HONEYPOTS) ?? [],
            answer: honeypots.answer ?? "pass",
            mode: honeypots.mode ?? "enforce",
          }),
    canaryUsers,
    canaryKeys,
  });
}

/**
 * Validates and compiles a policy. Throws a {@link SecurityPolicyError}
 * listing every problem when it is refused (see `securityPolicySchema` for
 * what is checked). A compiled policy is accepted as it is.
 *
 * @example
 * ```ts
 * const policy = compilePolicy({
 *   service: "checkout",
 *   public: true,
 *   lists: [{ ip: "203.0.113.0/24", action: "block", reason: "scanner" }],
 * });
 * ```
 */
export function compilePolicy(
  input: SecurityPolicy | CompiledPolicy,
  options: CompilePolicyOptions = {},
): CompiledPolicy {
  if (isCompiledPolicy(input)) {
    return input;
  }
  const issues = validatePolicy(input, options);
  if (issues.length > 0) {
    throw new SecurityPolicyError(issues);
  }
  const source = deepFreeze(input);
  const mode = source.mode ?? "enforce";
  const caseSensitive =
    source.shape !== undefined &&
    source.shape !== false &&
    source.shape.caseSensitive === true;

  const ips = new CidrTrie<CompiledEntry>();
  const users = new Map<string, CompiledEntry[]>();
  const apiKeys = new Map<string, CompiledEntry[]>();
  const countries = new Map<string, CompiledEntry[]>();
  const asns = new Map<number, CompiledEntry[]>();

  const internalRanges =
    source.internal === false
      ? []
      : source.internal === undefined || source.internal === true
        ? INTERNAL_RANGES
        : source.internal.ranges;
  const internalTexts: string[] = [];
  for (const range of internalRanges) {
    const cidr = parseCidr(range);
    if (!cidr) continue;
    internalTexts.push(cidr.text);
    ips.insert(
      cidr,
      Object.freeze({
        id: `internal:${cidr.text}`,
        kind: "internal",
        value: cidr.text,
        action: "allow",
        override: true,
        locked: true,
        level: LEVEL.global,
        paths: undefined,
        expiresAt: undefined,
        mode: "enforce",
        code: "allowed",
      } satisfies CompiledEntry),
    );
  }

  let listEntries = 0;
  for (const entry of source.lists ?? ([] as readonly ListEntry[])) {
    const entryMode = entry.mode ?? "enforce";
    if (entryMode === "off") continue;
    const cidr = entry.ip === undefined ? null : parseCidr(entry.ip);
    const compiled: CompiledEntry = Object.freeze({
      id: entry.id ?? defaultEntryId(entry, cidr ?? undefined),
      kind:
        entry.ip !== undefined
          ? "ip"
          : entry.user !== undefined
            ? "user"
            : entry.country !== undefined
              ? "country"
              : entry.asn !== undefined
                ? "asn"
                : "apiKey",
      value:
        cidr?.text ??
        entry.user ??
        entry.country ??
        (entry.asn === undefined ? undefined : String(entry.asn)) ??
        entry.apiKey ??
        "",
      action: entry.action,
      override: entry.override === true,
      locked: entry.locked === true,
      level: entry.paths ? 3 : LEVEL[entry.scope ?? "service"],
      paths: entry.paths
        ? Object.freeze(
            entry.paths.map((prefix) =>
              caseSensitive
                ? trimPrefix(prefix)
                : trimPrefix(prefix).toLowerCase(),
            ),
          )
        : undefined,
      expiresAt:
        entry.expiresAt === undefined ? undefined : Date.parse(entry.expiresAt),
      mode: entryMode,
      code: entry.code ?? "blocked",
    });
    if (cidr) ips.insert(cidr, compiled);
    else if (entry.user !== undefined) addTo(users, entry.user, compiled);
    else if (entry.apiKey !== undefined) addTo(apiKeys, entry.apiKey, compiled);
    else if (entry.country !== undefined)
      addTo(countries, entry.country, compiled);
    else if (entry.asn !== undefined) addTo(asns, entry.asn, compiled);
    listEntries++;
  }

  const services = (source.serviceIdentity?.services ?? []).map((service) =>
    Object.freeze({
      id: service.id,
      verifiers: (typeof service.verifier === "string"
        ? [service.verifier]
        : service.verifier
      ).map((verifier) => hexBytes(verifier.slice("sha256:".length))),
      forwardsClientIp: service.forwardsClientIp === true,
      exempt: new Set<ServiceExemption>(
        service.exempt ?? ["lists", "bans", "countedRules", "globalLimits"],
      ),
    } satisfies CompiledService),
  );

  const check = source.trustCheck;
  const trustCheck: CompiledTrustCheck | undefined =
    check === false
      ? undefined
      : {
          threshold: check?.threshold ?? 0.5,
          minutes:
            check?.window === undefined
              ? 5
              : toDurationMs(check.window, "trustCheck.window") / 60_000,
          minRequests: check?.minRequests ?? 20,
        };

  // The presets in force ahead of the policy's own rules (presets.ts).
  const effective = withPresets(
    source.presets,
    source.limits,
    source.countedRules,
  );
  // The verified crawlers' own limit (layers.md L3.2), beside the presets.
  const crawlerLimit = crawlerLimitRule(source.crawlers);
  const limits = compileLimits(
    source,
    crawlerLimit === undefined ||
      effective.limits.some((rule) => rule.id === crawlerLimit.id)
      ? effective.limits
      : [crawlerLimit, ...effective.limits],
    "limits",
  );

  const countedRules: CompiledCountedRule[] = [];
  const countedByEvent = new Map<string, CompiledCountedRule[]>();
  for (const rule of effective.countedRules) {
    const ruleMode = rule.mode ?? "enforce";
    if (ruleMode === "off") continue;
    const compiledRule: CompiledCountedRule = Object.freeze({
      id: rule.id,
      event: rule.event,
      threshold: rule.threshold,
      window: ms(rule.window, `countedRules.${rule.id}.window`),
      key: compileKey(rule.key),
      routes: compileRoutes(rule.routes),
      action: rule.action ?? "ban",
      duration:
        rule.duration === undefined
          ? 0
          : rule.duration === null
            ? Number.POSITIVE_INFINITY
            : ms(rule.duration, `countedRules.${rule.id}.duration`),
      mode: ruleMode,
      appliesToServices: rule.appliesToServices === true,
      weight: rule.weight ?? 1,
      code: rule.code,
      state:
        rule.state ??
        (source.state?.mode === "local" || source.state?.mode === "shared"
          ? source.state.mode
          : undefined),
      onStoreError:
        rule.onStoreError ??
        (source.state?.onStoreError === "open" ? "open" : "local"),
      profile: rule.profile,
    });
    countedRules.push(compiledRule);
    const byEvent = countedByEvent.get(rule.event);
    if (byEvent) byEvent.push(compiledRule);
    else countedByEvent.set(rule.event, [compiledRule]);
  }

  const concurrencySource = source.concurrency;
  const concurrencyMode =
    concurrencySource === false
      ? "off"
      : (concurrencySource?.mode ?? "enforce");
  const perIp =
    concurrencySource === false
      ? false
      : (concurrencySource?.perIp ?? DEFAULT_CONCURRENCY_PER_IP);
  const total =
    concurrencySource === false ? false : (concurrencySource?.total ?? false);
  const concurrency: CompiledConcurrency | undefined =
    concurrencyMode === "off" || (perIp === false && total === false)
      ? undefined
      : Object.freeze({
          perIp: perIp === false ? undefined : perIp,
          total: total === false ? undefined : total,
          releaseAfter:
            concurrencySource === false ||
            concurrencySource?.releaseAfter === undefined
              ? 5 * 60_000
              : ms(concurrencySource.releaseAfter, "concurrency.releaseAfter"),
          mode: concurrencyMode,
        });

  const bans: CompiledBans = Object.freeze({
    code: source.bans?.code ?? "banned",
    retryAfter: source.bans?.retryAfter === true,
    maxActive: source.bans?.maxActive ?? 100_000,
    mode: source.bans?.mode ?? "enforce",
  });
  const ladder = compileLadder(source);
  const shape = compileShape(source, caseSensitive);
  const deception = compileDeception(source);

  const compiled: CompiledPolicy = Object.freeze({
    source,
    version: source.version ?? SECURITY_POLICY_VERSION,
    service: source.service,
    environment: source.environment,
    mode,
    public: source.public === true,
    listEntries,
    internalRanges: Object.freeze(internalTexts),
  });
  internals.set(
    compiled,
    Object.freeze({
      mode,
      ipv6Prefix: source.keys?.ipv6Prefix ?? 64,
      ips,
      users,
      apiKeys,
      countries,
      asns,
      serviceHeader: source.serviceIdentity?.header ?? DEFAULT_SERVICE_HEADER,
      clientIpHeader:
        source.serviceIdentity?.clientIpHeader ?? DEFAULT_CLIENT_IP_HEADER,
      services: Object.freeze(services),
      trustCheck,
      concurrency,
      limits,
      countedRules: Object.freeze(countedRules),
      countedByEvent,
      bans,
      ladder,
      shape,
      caseSensitive,
      deception,
      nodes: source.state?.nodes ?? 1,
      scope: source.state?.scope ?? "shared",
      messages: compileMessages(source),
    }),
  );
  return compiled;
}

/** The limits of `rules`, `off` ones skipped, with the policy's `state` defaults applied. */
function compileLimits(
  source: SecurityPolicy,
  rules: readonly LimitRule[] | undefined,
  where: string,
): readonly CompiledLimit[] {
  const limits: CompiledLimit[] = [];
  for (const limit of rules ?? []) {
    const limitMode = limit.mode ?? "enforce";
    if (limitMode === "off") continue;
    limits.push(
      Object.freeze({
        id: limit.id,
        limit: limit.limit,
        window: ms(limit.window, `${where}.${limit.id}.window`),
        key: compileKey(limit.key),
        routes: compileRoutes(limit.routes),
        algorithm: limit.algorithm ?? "sliding-window",
        cost: limit.cost ?? 1,
        mode: limitMode,
        appliesToServices: limit.appliesToServices === true,
        evenWhenAllowed: limit.evenWhenAllowed === true,
        code: limit.code ?? "rate_limited",
        state: limit.state ?? source.state?.mode,
        onStoreError:
          limit.onStoreError ?? source.state?.onStoreError ?? "local",
        profile: limit.profile,
        apiKeyPlan: limit.apiKeyPlan,
      } satisfies CompiledLimit),
    );
  }
  return Object.freeze(limits);
}

/** The `messages` section, or undefined when absent or off. */
function compileMessages(source: SecurityPolicy): CompiledMessages | undefined {
  const messages = source.messages;
  if (messages === undefined) return undefined;
  const mode = messages.mode ?? "enforce";
  if (mode === "off") return undefined;
  const per = messages.perConnection;
  const limits = compileLimits(source, messages.limits, "messages.limits");
  if ((per === undefined || per === false) && limits.length === 0) {
    return undefined;
  }
  return Object.freeze({
    perConnection:
      per === undefined || per === false
        ? undefined
        : Object.freeze({
            limit: per.limit,
            window: ms(per.window, "messages.perConnection.window"),
            capacity: per.limit * (messages.burst ?? 2),
          }),
    breach:
      messages.breach === undefined
        ? 10_000
        : ms(messages.breach, "messages.breach"),
    closeCode: messages.closeCode ?? 1008,
    limits,
    mode,
  });
}
