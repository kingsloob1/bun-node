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
  SecurityPolicy,
  ServiceExemption,
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
  /** How long, in milliseconds; `Infinity` until the rule goes. */
  readonly duration: number;
  /** `enforce` or `dryRun` (rules that are `off` are not compiled). */
  readonly mode: "enforce" | "dryRun";
  /** Counts and refuses a verified service's forwarded end user despite its exemptions. */
  readonly appliesToServices: boolean;
  /** The refusal's problem code. */
  readonly code: string;
}

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
  readonly kind: "ip" | "user" | "apiKey" | "internal";
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
function addTo(
  map: Map<string, CompiledEntry[]>,
  key: string,
  entry: CompiledEntry,
): void {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
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

  const ips = new CidrTrie<CompiledEntry>();
  const users = new Map<string, CompiledEntry[]>();
  const apiKeys = new Map<string, CompiledEntry[]>();

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
            : "apiKey",
      value: cidr?.text ?? entry.user ?? entry.apiKey ?? "",
      action: entry.action,
      override: entry.override === true,
      locked: entry.locked === true,
      level: entry.paths ? 3 : LEVEL[entry.scope ?? "service"],
      paths: entry.paths
        ? Object.freeze(entry.paths.map(trimPrefix))
        : undefined,
      expiresAt:
        entry.expiresAt === undefined ? undefined : Date.parse(entry.expiresAt),
      mode: entryMode,
      code: entry.code ?? "blocked",
    });
    if (cidr) ips.insert(cidr, compiled);
    else if (entry.user !== undefined) addTo(users, entry.user, compiled);
    else if (entry.apiKey !== undefined) addTo(apiKeys, entry.apiKey, compiled);
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

  const limits: CompiledLimit[] = [];
  for (const limit of source.limits ?? []) {
    const limitMode = limit.mode ?? "enforce";
    if (limitMode === "off") continue;
    limits.push(
      Object.freeze({
        id: limit.id,
        limit: limit.limit,
        window: ms(limit.window, `limits.${limit.id}.window`),
        key: compileKey(limit.key),
        routes: compileRoutes(limit.routes),
        algorithm: limit.algorithm ?? "sliding-window",
        cost: limit.cost ?? 1,
        mode: limitMode,
        appliesToServices: limit.appliesToServices === true,
        evenWhenAllowed: limit.evenWhenAllowed === true,
        code: limit.code ?? "rate_limited",
      } satisfies CompiledLimit),
    );
  }

  const countedRules: CompiledCountedRule[] = [];
  const countedByEvent = new Map<string, CompiledCountedRule[]>();
  for (const rule of source.countedRules ?? []) {
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
        rule.duration === null
          ? Number.POSITIVE_INFINITY
          : ms(rule.duration, `countedRules.${rule.id}.duration`),
      mode: ruleMode,
      appliesToServices: rule.appliesToServices === true,
      code: rule.code ?? "blocked",
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
      serviceHeader: source.serviceIdentity?.header ?? DEFAULT_SERVICE_HEADER,
      clientIpHeader:
        source.serviceIdentity?.clientIpHeader ?? DEFAULT_CLIENT_IP_HEADER,
      services: Object.freeze(services),
      trustCheck,
      concurrency,
      limits: Object.freeze(limits),
      countedRules: Object.freeze(countedRules),
      countedByEvent,
    }),
  );
  return compiled;
}
