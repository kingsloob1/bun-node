/**
 * `compilePolicy`: a validated policy turned into the structures the engine
 * reads per request (control-plane.md §2.3) — the address ranges in a CIDR
 * trie, users and API keys in maps, the internal list as locked allow
 * entries, service verifiers as bytes. Pure: the same policy compiles to the
 * same thing, and nothing about a request is decided here.
 */
import { toDurationMs } from "@kingsleyweb/bun-common";
import { parseCidr } from "../ip/address";
import { CidrTrie } from "../ip/trie";
import { SecurityPolicyError } from "./errors";
import { INTERNAL_RANGES } from "./internal";
import {
  DEFAULT_CLIENT_IP_HEADER,
  DEFAULT_SERVICE_HEADER,
  defaultEntryId,
  validatePolicy,
} from "./schema";
import type { PolicyBounds } from "./schema";
import type {
  ListAction,
  ListEntry,
  SecurityMode,
  SecurityPolicy,
  ServiceExemption,
} from "./types";

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
}

/**
 * A policy compiled by {@link compilePolicy}: what `createSecurity()` and
 * `load()` run. Only `compilePolicy` makes one; an object of the same shape
 * made by hand is not accepted.
 */
export interface CompiledPolicy {
  /** The policy as given, frozen. */
  readonly source: SecurityPolicy;
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

  const compiled: CompiledPolicy = Object.freeze({
    source,
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
    }),
  );
  return compiled;
}
