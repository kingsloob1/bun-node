/**
 * Validation of the policy's `requestRules` section (layers.md L7): every
 * problem, with its path, so a pattern the regex validator refuses is
 * refused when the policy is saved, with the reason (plan D12).
 */
import { toDurationMs } from "@kingsleyweb/bun-common";
import type { Duration } from "@kingsleyweb/bun-common";
import {
  isWholeFamilyRange,
  parseCidr,
  WHOLE_FAMILY_RANGE,
} from "../ip/address";
import { globRefusal } from "./glob";
import { MANAGED_RULE_IDS } from "./managed";
import { regexRefusal } from "./regex";

/** One problem: where, and what. */
export interface RuleIssue {
  /** The path below the policy's root. */
  readonly path: readonly (string | number)[];
  /** What is wrong. */
  readonly message: string;
}

/** The most rules a policy holds. */
export const MAX_REQUEST_RULES = 500;

/** The most tests one rule's condition holds, and how deep `all`/`any`/`not` nest. */
const MAX_MATCHES = 64;
const MAX_DEPTH = 8;

/** The most values an `in` matcher holds. */
const MAX_IN = 1000;

/** The longest literal a string matcher compares. */
const MAX_LITERAL = 1024;

/** A rule id. */
const RULE_ID_RE = /^[a-z0-9][\w.-]{0,63}$/i;
/** A problem code. */
const CODE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
/** A header name. */
const HEADER_RE = /^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/** The targets each test may name, and what their matcher is. */
const STRING_TARGETS = new Set([
  "method",
  "path",
  "rawPath",
  "query",
  "anyHeader",
  "routeKey",
  "user",
  "session",
  "tenant",
  "apiKey",
  "country",
  "class",
]);
/** Targets named beside their matcher (`{ header: "user-agent", contains: … }`). */
const NAMED_TARGETS = new Set(["header", "queryParam", "cookie"]);
/** Numeric targets. */
const NUMBER_TARGETS = new Set(["contentLength", "headerCount"]);
/** A string matcher's operations. */
const STRING_OPS = [
  "equals",
  "in",
  "prefix",
  "suffix",
  "contains",
  "glob",
  "regex",
  "exists",
  "length",
] as const;
/** A number matcher's operations. */
const NUMBER_OPS = ["equals", "gt", "gte", "lt", "lte"] as const;

/** Collects issues. */
class Issues {
  /** Every issue. */
  readonly list: RuleIssue[] = [];
  /** Tests counted in the current rule. */
  matches = 0;

  /** Records one. */
  add(path: readonly (string | number)[], message: string): void {
    this.list.push({ path: [...path], message });
  }
}

/** Whether `value` is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A short description of a value, for messages. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return JSON.stringify(value.slice(0, 40));
  return typeof value === "object"
    ? "an object"
    : `${typeof value} ${String(value)}`;
}

/** Checks a number matcher. */
function checkNumberMatcher(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
): void {
  if (!isRecord(value)) {
    issues.add(
      path,
      `must be an object with one of ${NUMBER_OPS.join(", ")}; got ${describe(value)}`,
    );
    return;
  }
  const ops = Object.keys(value).filter((key) => !key.startsWith("$"));
  if (
    ops.length !== 1 ||
    !(NUMBER_OPS as readonly string[]).includes(ops[0] ?? "")
  ) {
    issues.add(
      path,
      `must hold exactly one of ${NUMBER_OPS.join(", ")}; got ${ops.join(", ") || "none"}`,
    );
    return;
  }
  const operand = value[ops[0] ?? ""];
  if (typeof operand !== "number" || !Number.isFinite(operand)) {
    issues.add(
      [...path, ops[0] ?? ""],
      `must be a finite number; got ${describe(operand)}`,
    );
  }
}

/** Checks a string matcher's keys (everything but the target, for a named one). */
function checkStringMatcher(
  issues: Issues,
  path: readonly (string | number)[],
  value: Record<string, unknown>,
  skip: string | undefined,
): void {
  const known = new Set<string>([...STRING_OPS, "ignoreCase"]);
  const ops: string[] = [];
  for (const key of Object.keys(value)) {
    if (key.startsWith("$") || key === skip) continue;
    if (!known.has(key)) {
      issues.add(
        [...path, key],
        `unknown key (known: ${[...known].join(", ")})`,
      );
    } else if (key !== "ignoreCase") {
      ops.push(key);
    }
  }
  if (ops.length !== 1) {
    issues.add(
      path,
      `must hold exactly one of ${STRING_OPS.join(", ")}; got ${ops.join(", ") || "none"}`,
    );
    return;
  }
  const ignoreCase = value.ignoreCase;
  if (ignoreCase !== undefined && typeof ignoreCase !== "boolean") {
    issues.add(
      [...path, "ignoreCase"],
      `must be a boolean; got ${describe(ignoreCase)}`,
    );
  }
  const op = ops[0] ?? "";
  const operand = value[op];
  const at = [...path, op];
  switch (op) {
    case "equals":
    case "prefix":
    case "suffix":
    case "contains":
      if (
        typeof operand !== "string" ||
        operand.length === 0 ||
        operand.length > MAX_LITERAL
      ) {
        issues.add(
          at,
          `must be a string of 1 to ${MAX_LITERAL} characters; got ${describe(operand)}`,
        );
      }
      break;
    case "in":
      if (
        !Array.isArray(operand) ||
        operand.length === 0 ||
        operand.length > MAX_IN ||
        operand.some(
          (item) => typeof item !== "string" || item.length > MAX_LITERAL,
        )
      ) {
        issues.add(
          at,
          `must be a list of 1 to ${MAX_IN} strings; got ${describe(operand)}`,
        );
      }
      break;
    case "glob": {
      const refusal =
        typeof operand === "string" ? globRefusal(operand) : "must be a string";
      if (refusal !== undefined) issues.add(at, `refused glob: ${refusal}`);
      break;
    }
    case "regex": {
      const refusal =
        typeof operand === "string"
          ? regexRefusal(operand, ignoreCase === true)
          : `must be a string; got ${describe(operand)}`;
      if (refusal !== undefined) issues.add(at, `refused pattern: ${refusal}`);
      break;
    }
    case "exists":
      if (typeof operand !== "boolean")
        issues.add(at, `must be a boolean; got ${describe(operand)}`);
      break;
    case "length":
      checkNumberMatcher(issues, at, operand);
      break;
  }
}

/** Whether `value` is an autonomous system number. */
function isAsn(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 4294967295
  );
}

/** Checks an `asn` matcher: `equals`, `in` or `exists`. */
function checkAsnMatcher(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
): void {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    issues.add(
      path,
      "must be { equals: n }, { in: [n, …] } or { exists: true | false }",
    );
    return;
  }
  if ("equals" in value) {
    if (!isAsn(value.equals)) {
      issues.add(
        [...path, "equals"],
        `must be an autonomous system number; got ${describe(value.equals)}`,
      );
    }
  } else if ("in" in value) {
    const list = value.in;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_IN) {
      issues.add(
        [...path, "in"],
        `must hold 1 to ${MAX_IN} autonomous system numbers`,
      );
    } else {
      list.forEach((item: unknown, i: number) => {
        if (!isAsn(item)) {
          issues.add(
            [...path, "in", i],
            `must be an autonomous system number; got ${describe(item)}`,
          );
        }
      });
    }
  } else if ("exists" in value) {
    if (typeof value.exists !== "boolean") {
      issues.add([...path, "exists"], "must be true or false");
    }
  } else {
    issues.add(
      path,
      "must be { equals: n }, { in: [n, …] } or { exists: true | false }",
    );
  }
}

/** Checks one test. */
function checkMatch(
  issues: Issues,
  path: readonly (string | number)[],
  value: Record<string, unknown>,
): void {
  issues.matches++;
  const keys = Object.keys(value).filter((key) => !key.startsWith("$"));
  const targets = keys.filter(
    (key) =>
      STRING_TARGETS.has(key) ||
      NAMED_TARGETS.has(key) ||
      NUMBER_TARGETS.has(key) ||
      key === "client" ||
      key === "asn",
  );
  if (targets.length !== 1) {
    issues.add(
      path,
      `must name exactly one target (method, path, rawPath, query, queryParam, header, anyHeader, cookie, client, contentLength, headerCount, country, asn, class, routeKey, user, session, tenant, apiKey) or be all/any/not; got ${keys.join(", ") || "nothing"}`,
    );
    return;
  }
  const target = targets[0] ?? "";
  const at = [...path, target];
  if (NAMED_TARGETS.has(target)) {
    const name = value[target];
    if (target === "header") {
      if (typeof name !== "string" || !HEADER_RE.test(name.toLowerCase())) {
        issues.add(at, `must be a header name; got ${describe(name)}`);
      }
    } else if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 128
    ) {
      issues.add(
        at,
        `must be a name of 1 to 128 characters; got ${describe(name)}`,
      );
    }
    if (target === "cookie") {
      const rest = keys.filter((key) => key !== "cookie");
      if (
        rest.length !== 1 ||
        rest[0] !== "exists" ||
        typeof value.exists !== "boolean"
      ) {
        issues.add(
          path,
          "a cookie test takes `exists: true | false` only (cookie values are not read)",
        );
      }
      return;
    }
    checkStringMatcher(issues, path, value, target);
    return;
  }
  if (keys.length !== 1) {
    issues.add(
      path,
      `holds its matcher inside ${JSON.stringify(target)}; unexpected ${keys.filter((k) => k !== target).join(", ")}`,
    );
    return;
  }
  const matcher = value[target];
  if (NUMBER_TARGETS.has(target)) {
    checkNumberMatcher(issues, at, matcher);
    return;
  }
  if (target === "asn") {
    checkAsnMatcher(issues, at, matcher);
    return;
  }
  if (target === "client") {
    if (
      !isRecord(matcher) ||
      Object.keys(matcher).length !== 1 ||
      !("cidr" in matcher)
    ) {
      issues.add(at, "must be { cidr: a range or a list of ranges }");
      return;
    }
    const ranges = Array.isArray(matcher.cidr) ? matcher.cidr : [matcher.cidr];
    if (ranges.length === 0 || ranges.length > MAX_IN) {
      issues.add([...at, "cidr"], `must hold 1 to ${MAX_IN} ranges`);
    }
    ranges.forEach((range: unknown, i: number) => {
      if (parseCidr(range) === null) {
        issues.add(
          [...at, "cidr", ...(Array.isArray(matcher.cidr) ? [i] : [])],
          isWholeFamilyRange(range)
            ? `${WHOLE_FAMILY_RANGE}; leave the cidr matcher out to match every client`
            : `must be an address or a range ("203.0.113.0/24"); got ${describe(range)}`,
        );
      }
    });
    return;
  }
  if (!isRecord(matcher)) {
    issues.add(at, `must be a matcher object; got ${describe(matcher)}`);
    return;
  }
  checkStringMatcher(issues, at, matcher, undefined);
}

/** Checks a condition, recursively. */
function checkCondition(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    issues.add(path, `nests deeper than ${MAX_DEPTH} levels`);
    return;
  }
  if (!isRecord(value)) {
    issues.add(path, `must be a condition object; got ${describe(value)}`);
    return;
  }
  for (const combinator of ["all", "any"] as const) {
    if (combinator in value) {
      if (
        Object.keys(value).filter((key) => !key.startsWith("$")).length !== 1
      ) {
        issues.add(path, `${combinator} stands alone in its object`);
        return;
      }
      const list = value[combinator];
      if (!Array.isArray(list) || list.length === 0) {
        issues.add(
          [...path, combinator],
          "must be a non-empty list of conditions",
        );
        return;
      }
      list.forEach((item: unknown, i: number) =>
        checkCondition(issues, [...path, combinator, i], item, depth + 1),
      );
      return;
    }
  }
  if ("not" in value) {
    if (Object.keys(value).filter((key) => !key.startsWith("$")).length !== 1) {
      issues.add(path, "not stands alone in its object");
      return;
    }
    checkCondition(issues, [...path, "not"], value.not, depth + 1);
    return;
  }
  checkMatch(issues, path, value);
}

/** The keys of a rule. */
const RULE_KEYS = [
  "id",
  "when",
  "action",
  "weight",
  "mode",
  "status",
  "code",
  "duration",
  "crawlers",
];

/** Checks one rule. */
function checkRule(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
  ids: Map<string, number>,
  index: number,
): void {
  if (!isRecord(value)) {
    issues.add(path, `must be a rule object; got ${describe(value)}`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!key.startsWith("$") && !RULE_KEYS.includes(key)) {
      issues.add(
        [...path, key],
        `unknown key (known: ${RULE_KEYS.join(", ")})`,
      );
    }
  }
  const id = value.id;
  if (typeof id !== "string" || !RULE_ID_RE.test(id)) {
    issues.add(
      [...path, "id"],
      `must be an id of 1 to 64 letters, digits, "_", "." and "-", starting with a letter or digit; got ${describe(id)}`,
    );
  } else if (ids.has(id)) {
    issues.add(
      [...path, "id"],
      `duplicates the id of requestRules.rules[${ids.get(id)}]: ${JSON.stringify(id)}`,
    );
  } else {
    ids.set(id, index);
  }
  issues.matches = 0;
  checkCondition(issues, [...path, "when"], value.when, 1);
  if (issues.matches > MAX_MATCHES) {
    issues.add(
      [...path, "when"],
      `holds ${issues.matches} tests; at most ${MAX_MATCHES}`,
    );
  }
  const action = value.action;
  if (
    action !== undefined &&
    !["log", "block", "challenge", "ban", "drop"].includes(action as string)
  ) {
    issues.add(
      [...path, "action"],
      `must be log, block, challenge, ban or drop; got ${describe(action)}`,
    );
  }
  const weight = value.weight;
  if (
    weight !== undefined &&
    (typeof weight !== "number" ||
      !Number.isFinite(weight) ||
      weight < 0 ||
      weight > 100)
  ) {
    issues.add(
      [...path, "weight"],
      `must be a number from 0 to 100; got ${describe(weight)}`,
    );
  }
  if (
    value.mode !== undefined &&
    !["enforce", "dryRun", "off"].includes(value.mode as string)
  ) {
    issues.add(
      [...path, "mode"],
      `must be enforce, dryRun or off; got ${describe(value.mode)}`,
    );
  }
  const status = value.status;
  if (
    status !== undefined &&
    (typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 400 ||
      status > 599)
  ) {
    issues.add(
      [...path, "status"],
      `must be a whole number from 400 to 599; got ${describe(status)}`,
    );
  }
  if (
    value.code !== undefined &&
    (typeof value.code !== "string" || !CODE_RE.test(value.code))
  ) {
    issues.add(
      [...path, "code"],
      `must be a problem code (lower case letters, digits, "_", "." and "-"); got ${describe(value.code)}`,
    );
  }
  if (value.duration !== undefined && value.duration !== null) {
    if (action !== "ban") {
      issues.add([...path, "duration"], 'applies to action "ban" only');
    } else if (typeof value.duration === "number") {
      issues.add(
        [...path, "duration"],
        `a bare number is ambiguous (milliseconds or seconds?); write the unit: "${value.duration}s"`,
      );
    } else {
      try {
        if (toDurationMs(value.duration as Duration, "duration") < 1000) {
          issues.add([...path, "duration"], "must be at least a second");
        }
      } catch {
        issues.add(
          [...path, "duration"],
          `must be a duration such as "1h" or { hours: 1 }; got ${describe(value.duration)}`,
        );
      }
    }
  }
  if (
    value.crawlers !== undefined &&
    value.crawlers !== "apply" &&
    value.crawlers !== "skip"
  ) {
    issues.add(
      [...path, "crawlers"],
      `must be apply or skip; got ${describe(value.crawlers)}`,
    );
  }
}

/** Validates the policy's `requestRules` section; `[]` when it is absent or sound. */
export function validateRequestRules(value: unknown): readonly RuleIssue[] {
  if (value === undefined) return [];
  const issues = new Issues();
  const root = ["requestRules"];
  if (!isRecord(value)) {
    issues.add(root, `must be an object; got ${describe(value)}`);
    return issues.list;
  }
  for (const key of Object.keys(value)) {
    if (
      !key.startsWith("$") &&
      !["rules", "managed", "maxRegexInput"].includes(key)
    ) {
      issues.add(
        [...root, key],
        "unknown key (known: rules, managed, maxRegexInput)",
      );
    }
  }
  if (value.rules !== undefined) {
    if (!Array.isArray(value.rules)) {
      issues.add(
        [...root, "rules"],
        `must be a list of rules; got ${describe(value.rules)}`,
      );
    } else {
      if (value.rules.length > MAX_REQUEST_RULES) {
        issues.add(
          [...root, "rules"],
          `holds ${value.rules.length} rules; at most ${MAX_REQUEST_RULES}`,
        );
      }
      const ids = new Map<string, number>();
      value.rules.forEach((rule: unknown, i: number) =>
        checkRule(issues, [...root, "rules", i], rule, ids, i),
      );
    }
  }
  const managed = value.managed;
  if (managed !== undefined && typeof managed !== "boolean") {
    if (!isRecord(managed)) {
      issues.add(
        [...root, "managed"],
        `must be true, false or { mode, exclude, weight }; got ${describe(managed)}`,
      );
    } else {
      for (const key of Object.keys(managed)) {
        if (
          !key.startsWith("$") &&
          !["mode", "exclude", "weight"].includes(key)
        ) {
          issues.add(
            [...root, "managed", key],
            "unknown key (known: mode, exclude, weight)",
          );
        }
      }
      if (
        managed.mode !== undefined &&
        managed.mode !== "enforce" &&
        managed.mode !== "dryRun"
      ) {
        issues.add(
          [...root, "managed", "mode"],
          `must be enforce or dryRun; got ${describe(managed.mode)}`,
        );
      }
      if (managed.exclude !== undefined) {
        if (!Array.isArray(managed.exclude)) {
          issues.add(
            [...root, "managed", "exclude"],
            "must be a list of managed rule ids",
          );
        } else {
          managed.exclude.forEach((id: unknown, i: number) => {
            if (!(MANAGED_RULE_IDS as readonly unknown[]).includes(id)) {
              issues.add(
                [...root, "managed", "exclude", i],
                `must be one of ${MANAGED_RULE_IDS.join(", ")}; got ${describe(id)}`,
              );
            }
          });
        }
      }
      const weight = managed.weight;
      if (
        weight !== undefined &&
        (typeof weight !== "number" ||
          !Number.isFinite(weight) ||
          weight < 0 ||
          weight > 100)
      ) {
        issues.add(
          [...root, "managed", "weight"],
          `must be a number from 0 to 100; got ${describe(weight)}`,
        );
      }
    }
  }
  const max = value.maxRegexInput;
  if (
    max !== undefined &&
    (typeof max !== "number" ||
      !Number.isInteger(max) ||
      max < 16 ||
      max > 8192)
  ) {
    issues.add(
      [...root, "maxRegexInput"],
      `must be a whole number from 16 to 8192; got ${describe(max)}`,
    );
  }
  return issues.list;
}
