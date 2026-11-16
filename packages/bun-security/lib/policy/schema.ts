/**
 * The policy's validator, written once and exposed as a Standard Schema
 * (control-plane.md §2.3), so the control plane, a policy file and the
 * engine all refuse the same things: an unknown key, a bare number where a
 * unit belongs, an address that does not parse, an allow entry wide enough
 * to allow the internet, two entries with one id, a list past its bound, a
 * window under a second, a format version newer than this package.
 *
 * Every problem is reported, not only the first — except for a policy of a
 * newer format version, which is refused for that alone: its other keys
 * belong to a format this package does not know, so they are not reported
 * as typos.
 */
import { toDurationMs } from "@kingsleyweb/bun-common";
import type { Duration, StandardSchemaV1 } from "@kingsleyweb/bun-common";
import { parseCidr } from "../ip/address";
import type { ParsedCidr } from "../ip/address";
import { CidrTrie } from "../ip/trie";
import type { PolicyIssue } from "./errors";
import { INTERNAL_RANGES } from "./internal";
import { parseRoutePattern } from "./routes";
import type {
  ListEntry,
  SecurityPolicy,
  ServiceExemption,
  SubjectKeyPart,
} from "./types";

/**
 * The policy format version this package reads (`version` in a policy). A
 * policy without one is read as this version.
 */
export const SECURITY_POLICY_VERSION = 1;

/** The most list entries a policy may hold by default (control-plane.md §9). */
export const DEFAULT_MAX_LIST_ENTRIES = 1_000_000;

/** The most limits, and the most counted rules, a policy may hold (control-plane.md §9's rule bound, halved for each). */
export const MAX_RULES = 1_000;

/** The default in-flight requests per client address (layers.md L1). */
export const DEFAULT_CONCURRENCY_PER_IP = 64;

/** The default header carrying a service's token. */
export const DEFAULT_SERVICE_HEADER = "x-service-token";

/** The default header carrying the end-user address a service forwards. */
export const DEFAULT_CLIENT_IP_HEADER = "x-service-client-ip";

/** The most service identities a policy may hold. */
export const MAX_SERVICE_IDENTITIES = 1_000;

/** Bounds a policy is validated against. */
export interface PolicyBounds {
  /** The most list entries, the `internal` list not counted. Default {@link DEFAULT_MAX_LIST_ENTRIES}. */
  readonly maxListEntries?: number;
}

/** The modes. */
const MODES = new Set(["enforce", "dryRun", "off"]);
/** The list actions. */
const LIST_ACTIONS = new Set(["allow", "block", "challenge", "drop"]);
/** The scopes. */
const SCOPES = new Set(["global", "group", "service"]);
/** The exemptions. */
const EXEMPTIONS: ReadonlySet<ServiceExemption> = new Set([
  "lists",
  "bans",
  "countedRules",
  "globalLimits",
]);

/** The key parts of a limit or counted rule. */
const KEY_PARTS: ReadonlySet<SubjectKeyPart> = new Set([
  "ip",
  "user",
  "session",
  "tenant",
  "apiKey",
  "route",
]);
/** The limit algorithms. */
const ALGORITHMS = new Set(["sliding-window", "fixed-window", "gcra"]);
/** The counted-rule actions. */
const COUNTED_ACTIONS = new Set(["ban", "challenge"]);

/** An id: what an operator would type, bounded. */
const ID_RE = /^[\w.:/@+-]{1,256}$/;
/** A limit's or counted rule's id: the throttle foundation's limit-name grammar, bounded. */
const RULE_ID_RE = /^[a-z0-9][\w.-]{0,63}$/i;
/** A counted-rule event name (`request`, `route.notFound`, an app's own). */
const EVENT_RE = /^[a-z][\w.-]{0,63}$/i;
/** A problem code: short, lower case. */
const CODE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
/** A header name (RFC 9110 token), lower case. */
const HEADER_RE = /^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** A SHA-256 verifier. */
const VERIFIER_RE = /^sha256:[0-9a-f]{64}$/;
/** An ISO 8601 timestamp with its time zone written. */
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The widest allow entry accepted, by family (layers.md L3.1). */
const WIDEST_ALLOW = { 4: 8, 6: 32 } as const;

/** Collects issues while walking a value. */
class Issues {
  /** Every issue so far. */
  readonly list: PolicyIssue[] = [];

  /** Records one. */
  add(path: readonly (string | number)[], message: string): void {
    this.list.push({ message, path: [...path] });
  }
}

/** Whether `value` is a plain object (not an array, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks `value` is an object whose keys are all in `known` (or start with
 * `$`); records an issue for each other key. `false` when not an object.
 */
function checkObject(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
  known: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    issues.add(path, `must be an object; got ${describe(value)}`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!key.startsWith("$") && !known.includes(key)) {
      issues.add([...path, key], `unknown key (known: ${known.join(", ")})`);
    }
  }
  return true;
}

/** A short description of a value's type, for messages. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value.slice(0, 40));
    case "number":
    case "boolean":
    case "bigint":
      return `${typeof value} ${value}`;
    case "object":
      return "an object";
    default:
      return typeof value;
  }
}

/** Checks an optional string against `pattern`. */
function optionalString(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
  pattern: RegExp | undefined,
  what: string,
): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    issues.add(path, `must be a string; got ${describe(value)}`);
  } else if (pattern ? !pattern.test(value) : value.length > 1024) {
    issues.add(path, `is not ${what}: ${describe(value)}`);
  }
}

/** Checks an optional boolean. */
function optionalBoolean(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
): void {
  if (value !== undefined && typeof value !== "boolean") {
    issues.add(path, `must be true or false; got ${describe(value)}`);
  }
}

/** Checks an optional member of `allowed`. */
function optionalOneOf(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
  allowed: ReadonlySet<string>,
): void {
  if (
    value !== undefined &&
    !(typeof value === "string" && allowed.has(value))
  ) {
    issues.add(
      path,
      `must be one of ${[...allowed].join(", ")}; got ${describe(value)}`,
    );
  }
}

/**
 * Reads a duration with its unit written, at least `minMs`: an issue (and
 * `undefined`) for a bare number, a sub-`minMs` value or anything else.
 */
function policyDuration(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
  minMs: number,
): number | undefined {
  if (typeof value === "number") {
    issues.add(
      path,
      `a bare number is ambiguous (milliseconds or seconds?); write the unit: "${value}s", "${value}m" or { seconds: ${value} }`,
    );
    return undefined;
  }
  let ms: number;
  try {
    ms = toDurationMs(value as Duration, formatPath(path));
  } catch {
    issues.add(
      path,
      `must be a duration such as "5m", "30s" or { minutes: 5 }; got ${describe(value)}`,
    );
    return undefined;
  }
  if (ms < minMs) {
    issues.add(path, `must be at least ${minMs} ms; got ${ms} ms`);
    return undefined;
  }
  return ms;
}

/** `path` as text, for {@link toDurationMs}'s message. */
function formatPath(path: readonly (string | number)[]): string {
  return path.map(String).join(".");
}

/** Reads a timestamp with its time zone, as epoch milliseconds. */
function policyTimestamp(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
): number | undefined {
  if (typeof value === "number") {
    issues.add(
      path,
      `a bare number is ambiguous (seconds or milliseconds since the epoch?); write an ISO 8601 timestamp such as "2026-12-01T00:00:00Z"`,
    );
    return undefined;
  }
  if (typeof value !== "string" || !TIMESTAMP_RE.test(value)) {
    issues.add(
      path,
      `must be an ISO 8601 timestamp with its time zone, such as "2026-12-01T00:00:00Z"; got ${describe(value)}`,
    );
    return undefined;
  }
  const ms = Date.parse(value);
  const [year = 0, month = 0, day = 0] = value
    .slice(0, 10)
    .split("-")
    .map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(ms) ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    issues.add(path, `is not a real date: ${describe(value)}`);
    return undefined;
  }
  return ms;
}

/** The built-in internal ranges, parsed, for the narrowing check. */
let internalTrie: CidrTrie<string> | undefined;

/** Whether `cidr` lies inside one of {@link INTERNAL_RANGES}. */
function insideInternal(cidr: ParsedCidr): boolean {
  if (!internalTrie) {
    internalTrie = new CidrTrie();
    for (const range of INTERNAL_RANGES) {
      const parsed = parseCidr(range);
      if (parsed) internalTrie.insert(parsed, range);
    }
  }
  return internalTrie
    .match({ family: cidr.family, words: cidr.words, text: cidr.text })
    .some((range) => {
      const parsed = parseCidr(range);
      return parsed !== null && parsed.bits <= cidr.bits;
    });
}

/** The keys a list entry may have. */
const ENTRY_KEYS = [
  "id",
  "ip",
  "user",
  "apiKey",
  "action",
  "override",
  "locked",
  "scope",
  "paths",
  "expiresAt",
  "mode",
  "reason",
  "createdBy",
  "code",
];

/** The default id of an entry: its subject. */
export function defaultEntryId(entry: ListEntry, cidr?: ParsedCidr): string {
  if (entry.ip !== undefined) return `ip:${cidr?.text ?? entry.ip}`;
  if (entry.user !== undefined) return `user:${entry.user}`;
  return `apiKey:${entry.apiKey ?? ""}`;
}

/** Checks one list entry; records its id in `ids`. */
function checkEntry(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
  ids: Map<string, number>,
  index: number,
): void {
  if (!checkObject(issues, path, value, ENTRY_KEYS)) return;
  const subjects = (["ip", "user", "apiKey"] as const).filter(
    (key) => value[key] !== undefined,
  );
  if (subjects.length !== 1) {
    issues.add(
      path,
      `must have exactly one of ip, user, apiKey; got ${subjects.length === 0 ? "none" : subjects.join(", ")}`,
    );
  }
  let cidr: ParsedCidr | null = null;
  if (value.ip !== undefined) {
    cidr = typeof value.ip === "string" ? parseCidr(value.ip) : null;
    if (!cidr) {
      issues.add(
        [...path, "ip"],
        `is not an IP address or CIDR range: ${describe(value.ip)}`,
      );
    }
  }
  optionalString(
    issues,
    [...path, "user"],
    value.user,
    ID_RE,
    "a user id (1-256 characters, no spaces)",
  );
  optionalString(
    issues,
    [...path, "apiKey"],
    value.apiKey,
    ID_RE,
    "an API key id (1-256 characters, no spaces)",
  );
  if (!(typeof value.action === "string" && LIST_ACTIONS.has(value.action))) {
    issues.add(
      [...path, "action"],
      `must be one of ${[...LIST_ACTIONS].join(", ")}; got ${describe(value.action)}`,
    );
  }
  optionalString(
    issues,
    [...path, "id"],
    value.id,
    ID_RE,
    "an id (1-256 characters, no spaces)",
  );
  optionalBoolean(issues, [...path, "override"], value.override);
  optionalBoolean(issues, [...path, "locked"], value.locked);
  optionalOneOf(issues, [...path, "scope"], value.scope, SCOPES);
  optionalOneOf(issues, [...path, "mode"], value.mode, MODES);
  optionalString(
    issues,
    [...path, "reason"],
    value.reason,
    undefined,
    "a reason of at most 1024 characters",
  );
  optionalString(
    issues,
    [...path, "createdBy"],
    value.createdBy,
    ID_RE,
    "an operator id",
  );
  optionalString(
    issues,
    [...path, "code"],
    value.code,
    CODE_RE,
    "a code (lower case, at most 64 characters)",
  );
  if (value.paths !== undefined) {
    if (
      !Array.isArray(value.paths) ||
      value.paths.length === 0 ||
      value.paths.length > 64
    ) {
      issues.add(
        [...path, "paths"],
        "must be a list of 1 to 64 route prefixes",
      );
    } else {
      value.paths.forEach((prefix: unknown, i: number) => {
        if (
          typeof prefix !== "string" ||
          !prefix.startsWith("/") ||
          prefix.length > 1024
        ) {
          issues.add(
            [...path, "paths", i],
            `must be a path starting with "/"; got ${describe(prefix)}`,
          );
        }
      });
    }
  }
  if (value.expiresAt !== undefined) {
    policyTimestamp(issues, [...path, "expiresAt"], value.expiresAt);
  }
  if (value.override === true && value.action !== "allow") {
    issues.add([...path, "override"], "only an allow entry can override");
  }
  if (
    cidr &&
    value.action === "allow" &&
    cidr.bits < WIDEST_ALLOW[cidr.family]
  ) {
    issues.add(
      [...path, "ip"],
      `an allow entry wider than /${WIDEST_ALLOW[cidr.family]} is refused (a typo must not allow the internet); got ${cidr.text}`,
    );
  }
  if (subjects.length === 1) {
    const id =
      typeof value.id === "string"
        ? value.id
        : defaultEntryId(value as unknown as ListEntry, cidr ?? undefined);
    const first = ids.get(id);
    if (first !== undefined) {
      issues.add(
        [...path, "id"],
        `duplicates the id of lists[${first}]: ${JSON.stringify(id)}`,
      );
    } else {
      ids.set(id, index);
    }
  }
}

/** Checks an optional key: one part, or a list of 1 to 6 distinct parts. */
function checkKey(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
): void {
  if (value === undefined) return;
  const parts = Array.isArray(value) ? value : [value];
  if (parts.length === 0 || parts.length > KEY_PARTS.size) {
    issues.add(path, `must be a key part, or a list of 1 to ${KEY_PARTS.size}`);
    return;
  }
  const seen = new Set<unknown>();
  parts.forEach((part: unknown, i: number) => {
    const at = Array.isArray(value) ? [...path, i] : [...path];
    if (!(typeof part === "string" && KEY_PARTS.has(part as SubjectKeyPart))) {
      issues.add(
        at,
        `must be one of ${[...KEY_PARTS].join(", ")}; got ${describe(part)}`,
      );
    } else if (seen.has(part)) {
      issues.add(at, `repeats ${JSON.stringify(part)}`);
    }
    seen.add(part);
  });
}

/** Checks optional route patterns: 1 to 64 of them. */
function checkRoutes(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    issues.add(path, "must be a list of 1 to 64 route patterns");
    return;
  }
  value.forEach((pattern: unknown, i: number) => {
    if (parseRoutePattern(pattern) === null) {
      issues.add(
        [...path, i],
        `must be a route pattern such as "POST /login", "/login" or "/auth/*" (an upper-case method or "*", a space, then a path); got ${describe(pattern)}`,
      );
    }
  });
}

/** Checks a rule's id and records it in `ids` (`what` names the list, for duplicates). */
function checkRuleId(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
  ids: Map<string, number>,
  index: number,
  what: string,
): void {
  if (typeof value !== "string" || !RULE_ID_RE.test(value)) {
    issues.add(
      [...path, "id"],
      `must be an id of 1 to 64 letters, digits, "_", "." and "-", starting with a letter or digit; got ${describe(value)}`,
    );
    return;
  }
  const first = ids.get(value);
  if (first !== undefined) {
    issues.add(
      [...path, "id"],
      `duplicates the id of ${what}[${first}]: ${JSON.stringify(value)}`,
    );
  } else {
    ids.set(value, index);
  }
}

/** Checks a positive whole number. */
function positiveInteger(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
): void {
  if (!(
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1
  )) {
    issues.add(path, `must be a positive whole number; got ${describe(value)}`);
  }
}

/**
 * Checks a rule's window: required, unit written, at least a second unless
 * `subSecond` is `true` (T-L9-3: ConcaveHR's `THROTTLE_TTL=60` meant 60 ms).
 */
function checkWindow(
  issues: Issues,
  path: readonly (string | number)[],
  rule: Record<string, unknown>,
): void {
  optionalBoolean(issues, [...path, "subSecond"], rule.subSecond);
  if (rule.window === undefined) {
    issues.add([...path, "window"], 'is required: a duration such as "1m"');
    return;
  }
  const ms = policyDuration(issues, [...path, "window"], rule.window, 1);
  if (ms === undefined) return;
  if (ms < 1000 && rule.subSecond !== true) {
    issues.add(
      [...path, "window"],
      `is ${ms} ms, under a second; that is usually a unit mistake. Set subSecond: true if it is meant`,
    );
  } else if (ms > 366 * 24 * 60 * 60_000) {
    issues.add([...path, "window"], "must be at most 366 days");
  }
}

/** The keys a limit may have. */
const LIMIT_KEYS = [
  "id",
  "limit",
  "window",
  "subSecond",
  "key",
  "routes",
  "algorithm",
  "cost",
  "mode",
  "appliesToServices",
  "evenWhenAllowed",
  "code",
];

/** Checks one limit. */
function checkLimit(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
  ids: Map<string, number>,
  index: number,
): void {
  if (!checkObject(issues, path, value, LIMIT_KEYS)) return;
  checkRuleId(issues, path, value.id, ids, index, "limits");
  positiveInteger(issues, [...path, "limit"], value.limit);
  checkWindow(issues, path, value);
  checkKey(issues, [...path, "key"], value.key);
  checkRoutes(issues, [...path, "routes"], value.routes);
  optionalOneOf(issues, [...path, "algorithm"], value.algorithm, ALGORITHMS);
  if (
    value.cost !== undefined &&
    !(
      typeof value.cost === "number" &&
      Number.isFinite(value.cost) &&
      value.cost >= 0
    )
  ) {
    issues.add(
      [...path, "cost"],
      `must be a non-negative number; got ${describe(value.cost)}`,
    );
  }
  optionalOneOf(issues, [...path, "mode"], value.mode, MODES);
  optionalBoolean(
    issues,
    [...path, "appliesToServices"],
    value.appliesToServices,
  );
  optionalBoolean(issues, [...path, "evenWhenAllowed"], value.evenWhenAllowed);
  optionalString(
    issues,
    [...path, "code"],
    value.code,
    CODE_RE,
    "a code (lower case, at most 64 characters)",
  );
}

/** The keys a counted rule may have. */
const COUNTED_KEYS = [
  "id",
  "event",
  "threshold",
  "window",
  "subSecond",
  "key",
  "routes",
  "action",
  "duration",
  "mode",
  "appliesToServices",
  "code",
];

/** Checks one counted rule. */
function checkCountedRule(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
  ids: Map<string, number>,
  index: number,
): void {
  if (!checkObject(issues, path, value, COUNTED_KEYS)) return;
  checkRuleId(issues, path, value.id, ids, index, "countedRules");
  if (typeof value.event !== "string" || !EVENT_RE.test(value.event)) {
    issues.add(
      [...path, "event"],
      `must be an event name such as "request", "throttled", "route.notFound" or "auth.failure"; got ${describe(value.event)}`,
    );
  }
  positiveInteger(issues, [...path, "threshold"], value.threshold);
  checkWindow(issues, path, value);
  checkKey(issues, [...path, "key"], value.key);
  checkRoutes(issues, [...path, "routes"], value.routes);
  optionalOneOf(issues, [...path, "action"], value.action, COUNTED_ACTIONS);
  if (value.duration === undefined) {
    issues.add(
      [...path, "duration"],
      'is required: a duration such as "1h", or null for until the rule is removed',
    );
  } else if (value.duration !== null) {
    policyDuration(issues, [...path, "duration"], value.duration, 1000);
  }
  optionalOneOf(issues, [...path, "mode"], value.mode, MODES);
  optionalBoolean(
    issues,
    [...path, "appliesToServices"],
    value.appliesToServices,
  );
  optionalString(
    issues,
    [...path, "code"],
    value.code,
    CODE_RE,
    "a code (lower case, at most 64 characters)",
  );
}

/** Checks `perIp` or `total`: a positive whole number or `false`. */
function optionalCap(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
): void {
  if (value === undefined || value === false) return;
  positiveInteger(issues, path, value);
}

/** Checks a list of rules with `check`, within {@link MAX_RULES}. */
function checkRules(
  issues: Issues,
  name: "limits" | "countedRules",
  value: unknown,
  check: typeof checkLimit,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.add([name], "must be a list");
  } else if (value.length > MAX_RULES) {
    issues.add([name], `holds ${value.length}; the bound is ${MAX_RULES}`);
  } else {
    const ids = new Map<string, number>();
    value.forEach((rule: unknown, i: number) => {
      check(issues, [name, i], rule, ids, i);
    });
  }
}

/** Checks one service identity. */
function checkService(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
  ids: Set<string>,
): void {
  if (
    !checkObject(issues, path, value, [
      "id",
      "verifier",
      "forwardsClientIp",
      "exempt",
    ])
  ) {
    return;
  }
  if (typeof value.id !== "string" || !ID_RE.test(value.id)) {
    issues.add(
      [...path, "id"],
      `must be a service id (1-256 characters, no spaces); got ${describe(value.id)}`,
    );
  } else if (ids.has(value.id)) {
    issues.add(
      [...path, "id"],
      `duplicates another service's id: ${JSON.stringify(value.id)}`,
    );
  } else {
    ids.add(value.id);
  }
  const verifiers = Array.isArray(value.verifier)
    ? value.verifier
    : [value.verifier];
  if (verifiers.length === 0 || verifiers.length > 4) {
    issues.add(
      [...path, "verifier"],
      "must be one verifier, or a list of 1 to 4 during a rotation",
    );
  }
  verifiers.forEach((verifier: unknown, i: number) => {
    if (typeof verifier !== "string" || !VERIFIER_RE.test(verifier)) {
      issues.add(
        Array.isArray(value.verifier)
          ? [...path, "verifier", i]
          : [...path, "verifier"],
        `must be "sha256:" and the token's SHA-256 in 64 lower-case hex digits (never the token); got ${describe(verifier)}`,
      );
    }
  });
  optionalBoolean(
    issues,
    [...path, "forwardsClientIp"],
    value.forwardsClientIp,
  );
  if (value.exempt !== undefined) {
    if (!Array.isArray(value.exempt)) {
      issues.add([...path, "exempt"], "must be a list");
    } else {
      value.exempt.forEach((exemption: unknown, i: number) => {
        if (!(
          typeof exemption === "string" &&
          EXEMPTIONS.has(exemption as ServiceExemption)
        )) {
          issues.add(
            [...path, "exempt", i],
            `must be one of ${[...EXEMPTIONS].join(", ")}; got ${describe(exemption)}`,
          );
        }
      });
    }
  }
}

/** The keys a policy may have. */
const POLICY_KEYS = [
  "version",
  "service",
  "environment",
  "public",
  "mode",
  "keys",
  "internal",
  "lists",
  "serviceIdentity",
  "trustCheck",
  "concurrency",
  "limits",
  "countedRules",
];

/**
 * The issue for a policy of a newer format version than this package
 * reads, or `undefined`: refused for that alone, before its other keys are
 * read as typos.
 */
function newerVersion(input: unknown): PolicyIssue | undefined {
  if (!isRecord(input)) return undefined;
  const version = input.version;
  if (
    typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version > SECURITY_POLICY_VERSION
  ) {
    return {
      path: ["version"],
      message: `the policy is format version ${version}, newer than this package reads (version ${SECURITY_POLICY_VERSION}); upgrade @kingsleyweb/bun-security to load it`,
    };
  }
  return undefined;
}

/**
 * Validates `input` as a {@link SecurityPolicy}: every problem, or none.
 * `compilePolicy` runs this first; {@link securityPolicySchema} wraps it.
 */
export function validatePolicy(
  input: unknown,
  bounds: PolicyBounds = {},
): readonly PolicyIssue[] {
  const newer = newerVersion(input);
  if (newer) {
    return [newer];
  }
  const issues = new Issues();
  if (!checkObject(issues, [], input, POLICY_KEYS)) {
    return issues.list;
  }
  if (
    input.version !== undefined &&
    input.version !== SECURITY_POLICY_VERSION
  ) {
    issues.add(
      ["version"],
      `must be ${SECURITY_POLICY_VERSION} (or absent, which reads as ${SECURITY_POLICY_VERSION}); got ${describe(input.version)}`,
    );
  }
  optionalString(issues, ["service"], input.service, ID_RE, "a service id");
  optionalString(
    issues,
    ["environment"],
    input.environment,
    ID_RE,
    "an environment name",
  );
  optionalBoolean(issues, ["public"], input.public);
  optionalOneOf(issues, ["mode"], input.mode, MODES);

  if (
    input.keys !== undefined &&
    checkObject(issues, ["keys"], input.keys, ["ipv6Prefix"])
  ) {
    const prefix = input.keys.ipv6Prefix;
    if (
      prefix !== undefined &&
      !(
        typeof prefix === "number" &&
        Number.isInteger(prefix) &&
        prefix >= 48 &&
        prefix <= 128
      )
    ) {
      issues.add(
        ["keys", "ipv6Prefix"],
        `must be a whole number from 48 to 128; got ${describe(prefix)}`,
      );
    }
  }

  if (input.internal !== undefined && typeof input.internal !== "boolean") {
    if (checkObject(issues, ["internal"], input.internal, ["ranges"])) {
      const ranges = input.internal.ranges;
      if (!Array.isArray(ranges)) {
        issues.add(["internal", "ranges"], "must be a list of ranges");
      } else {
        ranges.forEach((range: unknown, i: number) => {
          const cidr = parseCidr(range);
          if (!cidr) {
            issues.add(
              ["internal", "ranges", i],
              `is not a CIDR range: ${describe(range)}`,
            );
          } else if (!insideInternal(cidr)) {
            issues.add(
              ["internal", "ranges", i],
              `the internal list can only be narrowed; ${cidr.text} is outside ${INTERNAL_RANGES.join(", ")}`,
            );
          }
        });
      }
    }
  }

  if (input.lists !== undefined) {
    if (!Array.isArray(input.lists)) {
      issues.add(["lists"], "must be a list of entries");
    } else {
      const max = bounds.maxListEntries ?? DEFAULT_MAX_LIST_ENTRIES;
      if (input.lists.length > max) {
        issues.add(
          ["lists"],
          `holds ${input.lists.length} entries; the bound is ${max} (larger feeds are IP-intelligence sources, not lists)`,
        );
      } else {
        const ids = new Map<string, number>();
        input.lists.forEach((entry: unknown, i: number) => {
          checkEntry(issues, ["lists", i], entry, ids, i);
        });
      }
    }
  }

  if (
    input.serviceIdentity !== undefined &&
    checkObject(issues, ["serviceIdentity"], input.serviceIdentity, [
      "header",
      "clientIpHeader",
      "services",
    ])
  ) {
    const settings = input.serviceIdentity;
    optionalString(
      issues,
      ["serviceIdentity", "header"],
      settings.header,
      HEADER_RE,
      "a lower-case header name",
    );
    optionalString(
      issues,
      ["serviceIdentity", "clientIpHeader"],
      settings.clientIpHeader,
      HEADER_RE,
      "a lower-case header name",
    );
    if (!Array.isArray(settings.services)) {
      issues.add(["serviceIdentity", "services"], "must be a list of services");
    } else if (settings.services.length > MAX_SERVICE_IDENTITIES) {
      issues.add(
        ["serviceIdentity", "services"],
        `holds ${settings.services.length}; the bound is ${MAX_SERVICE_IDENTITIES}`,
      );
    } else {
      const ids = new Set<string>();
      settings.services.forEach((service: unknown, i: number) => {
        checkService(issues, ["serviceIdentity", "services", i], service, ids);
      });
    }
    if (
      (settings.header ?? DEFAULT_SERVICE_HEADER) ===
      (settings.clientIpHeader ?? DEFAULT_CLIENT_IP_HEADER)
    ) {
      issues.add(
        ["serviceIdentity", "clientIpHeader"],
        "must differ from the token header",
      );
    }
  }

  if (
    input.trustCheck !== undefined &&
    input.trustCheck !== false &&
    checkObject(issues, ["trustCheck"], input.trustCheck, [
      "threshold",
      "window",
      "minRequests",
    ])
  ) {
    const check = input.trustCheck;
    if (
      check.threshold !== undefined &&
      !(
        typeof check.threshold === "number" &&
        check.threshold > 0 &&
        check.threshold <= 1
      )
    ) {
      issues.add(
        ["trustCheck", "threshold"],
        `must be a share above 0 and at most 1; got ${describe(check.threshold)}`,
      );
    }
    if (check.window !== undefined) {
      const ms = policyDuration(
        issues,
        ["trustCheck", "window"],
        check.window,
        60_000,
      );
      if (ms !== undefined && ms % 60_000 !== 0) {
        issues.add(
          ["trustCheck", "window"],
          `must be whole minutes; got ${ms} ms`,
        );
      } else if (ms !== undefined && ms > 60 * 60_000) {
        issues.add(["trustCheck", "window"], "must be at most an hour");
      }
    }
    if (
      check.minRequests !== undefined &&
      !(
        typeof check.minRequests === "number" &&
        Number.isInteger(check.minRequests) &&
        check.minRequests >= 1
      )
    ) {
      issues.add(
        ["trustCheck", "minRequests"],
        `must be a whole number of at least 1; got ${describe(check.minRequests)}`,
      );
    }
  }

  if (
    input.concurrency !== undefined &&
    input.concurrency !== false &&
    checkObject(issues, ["concurrency"], input.concurrency, [
      "perIp",
      "total",
      "releaseAfter",
      "mode",
    ])
  ) {
    const concurrency = input.concurrency;
    optionalCap(issues, ["concurrency", "perIp"], concurrency.perIp);
    optionalCap(issues, ["concurrency", "total"], concurrency.total);
    if (concurrency.releaseAfter !== undefined) {
      policyDuration(
        issues,
        ["concurrency", "releaseAfter"],
        concurrency.releaseAfter,
        1000,
      );
    }
    optionalOneOf(issues, ["concurrency", "mode"], concurrency.mode, MODES);
  }

  checkRules(issues, "limits", input.limits, checkLimit);
  checkRules(issues, "countedRules", input.countedRules, checkCountedRule);
  return issues.list;
}

/**
 * The policy format as a Standard Schema (https://standardschema.dev): the
 * same checks as `compilePolicy`, at the default bounds, for a control
 * plane's save, a form, or any validator that takes one. The output is the
 * input, unchanged, typed.
 */
export const securityPolicySchema: StandardSchemaV1<unknown, SecurityPolicy> = {
  "~standard": {
    version: 1,
    vendor: "bun-security",
    validate(value: unknown) {
      const issues = validatePolicy(value);
      return issues.length === 0
        ? { value: value as SecurityPolicy }
        : {
            issues: issues.map((issue) => ({
              message: issue.message,
              path: issue.path,
            })),
          };
    },
  },
};
