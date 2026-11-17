/**
 * The checks of the sensitive endpoints' sections (layers.md L11): the
 * `presets` switches, `profiles.login`, and `identifiers`. Kept apart from
 * `schema.ts`, which adds what they find to its own.
 */
import { toDurationMs } from "@kingsleyweb/bun-common";
import type { Duration } from "@kingsleyweb/bun-common";
import type { PolicyIssue } from "./errors";
import { globRefusal } from "../rules/glob";
import { PRESET_IDS } from "./presets";

/** Issues as they are found. */
type Issues = PolicyIssue[];

/** Whether `value` is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A short description of a value, for messages. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return JSON.stringify(value.slice(0, 40));
  if (typeof value === "number" || typeof value === "boolean") {
    return `${typeof value} ${String(value)}`;
  }
  return typeof value === "object" ? "an object" : typeof value;
}

/** Records an issue. */
function add(
  issues: Issues,
  path: readonly (string | number)[],
  message: string,
): void {
  issues.push({ message, path: [...path] });
}

/** Checks an object with only `known` keys (and `$…`). */
function object(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
  known: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    add(issues, path, `must be an object; got ${describe(value)}`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!key.startsWith("$") && !known.includes(key)) {
      add(issues, [...path, key], `unknown key (known: ${known.join(", ")})`);
    }
  }
  return true;
}

/** Checks an optional positive whole number. */
function count(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
): void {
  if (
    value !== undefined &&
    !(typeof value === "number" && Number.isSafeInteger(value) && value >= 1)
  ) {
    add(
      issues,
      path,
      `must be a positive whole number; got ${describe(value)}`,
    );
  }
}

/** Checks an optional duration with its unit, within `min` and `max` ms. */
function duration(
  issues: Issues,
  path: readonly (string | number)[],
  value: unknown,
  min: number,
  max: number,
): void {
  if (value === undefined) return;
  if (typeof value === "number") {
    add(
      issues,
      path,
      `a bare number is ambiguous (milliseconds or seconds?); write the unit: "${value}s"`,
    );
    return;
  }
  let ms: number;
  try {
    ms = toDurationMs(value as Duration, path.join("."));
  } catch {
    add(
      issues,
      path,
      `must be a duration such as "15m"; got ${describe(value)}`,
    );
    return;
  }
  if (ms < min || ms > max) {
    add(issues, path, `must be from ${min} ms to ${max} ms; got ${ms} ms`);
  }
}

/** The identifier kinds. */
const KINDS = new Set(["email", "phone", "username", "domain"]);

/** The most patterns a policy holds. */
export const MAX_IDENTIFIER_PATTERNS = 10_000;

/** A pattern id: letters, digits and `_.:@*?+-`, at most 300 characters. */
const PATTERN_ID_RE = /^[\w.:@*?+/-]{1,300}$/;

/** A domain name, lower case. */
const DOMAIN_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Problem codes. */
const CODE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * Why `pattern` cannot be an identifier pattern, or `undefined`: at most 256
 * characters, `*` and `?` its only wildcards, at least 4 literal characters.
 */
export function patternProblem(pattern: unknown): string | undefined {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return "must be a non-empty string";
  }
  if (pattern.length > 256) return "must be at most 256 characters";
  if (
    [...pattern].some(
      (char) => (char.codePointAt(0) ?? 0) < 0x20 || char === "\x7F",
    )
  ) {
    return "must hold no control characters";
  }
  const glob = globRefusal(pattern);
  if (glob !== undefined) return glob;
  const literals = pattern.replace(/[*?]/g, "").length;
  if (literals < 4) {
    return `has ${literals} literal characters; at least 4 are needed, so a pattern such as "*@*" cannot match everyone`;
  }
  return undefined;
}

/** Checks `profiles.login.failureRate`. */
function validateFailureRate(
  issues: Issues,
  at: readonly (string | number)[],
  rate: unknown,
): void {
  if (
    rate === undefined ||
    !object(issues, at, rate, [
      "window",
      "baseline",
      "factor",
      "minFailures",
      "hold",
      "respond",
      "to",
      "limit",
    ])
  ) {
    return;
  }
  duration(issues, [...at, "window"], rate.window, 60_000, 3_600_000);
  duration(
    issues,
    [...at, "baseline"],
    rate.baseline,
    3_600_000,
    7 * 86_400_000,
  );
  duration(issues, [...at, "hold"], rate.hold, 0, 86_400_000);
  if (
    rate.factor !== undefined &&
    !(
      typeof rate.factor === "number" &&
      Number.isFinite(rate.factor) &&
      rate.factor > 1 &&
      rate.factor <= 100
    )
  ) {
    add(
      issues,
      [...at, "factor"],
      `must be a number above 1 and at most 100; got ${describe(rate.factor)}`,
    );
  }
  count(issues, [...at, "minFailures"], rate.minFailures);
  if (
    rate.respond !== undefined &&
    !["challenge", "tag", "limit"].includes(rate.respond as string)
  ) {
    add(
      issues,
      [...at, "respond"],
      `must be one of challenge, tag, limit; got ${describe(rate.respond)}`,
    );
  }
  if (rate.to !== undefined) {
    if (
      !Array.isArray(rate.to) ||
      rate.to.length === 0 ||
      rate.to.some(
        (target: unknown) =>
          !["hosting", "newDevice", "all"].includes(target as string),
      )
    ) {
      add(
        issues,
        [...at, "to"],
        "must be a non-empty list of hosting, newDevice, all",
      );
    }
  }
  const limit = rate.limit;
  if (
    limit !== undefined &&
    object(issues, [...at, "limit"], limit, ["attempts", "window", "by"])
  ) {
    count(issues, [...at, "limit", "attempts"], limit.attempts);
    duration(issues, [...at, "limit", "window"], limit.window, 1000, 3_600_000);
    if (
      limit.by !== undefined &&
      !["asn", "hosting"].includes(limit.by as string)
    ) {
      add(
        issues,
        [...at, "limit", "by"],
        `must be asn or hosting; got ${describe(limit.by)}`,
      );
    }
  }
  const baseline =
    rate.baseline === undefined ? 86_400_000 : safeMs(rate.baseline);
  const window = rate.window === undefined ? 300_000 : safeMs(rate.window);
  if (baseline !== undefined && window !== undefined && baseline < 4 * window) {
    add(
      issues,
      [...at, "baseline"],
      "must be at least four windows long, so the baseline is the route's history and not its present",
    );
  }
}

/** A duration's milliseconds, or `undefined` when it is not one. */
function safeMs(value: unknown): number | undefined {
  try {
    return typeof value === "number"
      ? undefined
      : toDurationMs(value as Duration, "duration");
  } catch {
    return undefined;
  }
}

/** The checks of `presets`, `profiles` and `identifiers`. */
export function validateSensitive(
  input: Record<string, unknown>,
): PolicyIssue[] {
  const issues: Issues = [];
  const presets = input.presets;
  if (
    presets !== undefined &&
    object(issues, ["presets"], presets, PRESET_IDS)
  ) {
    for (const [id, on] of Object.entries(presets)) {
      if (id.startsWith("$")) continue;
      if (typeof on !== "boolean" && on !== "enforce") {
        add(
          issues,
          ["presets", id],
          `must be true (on, as it ships), "enforce" (on, enforced) or false (off); got ${describe(on)}`,
        );
      }
    }
  }
  const profiles = input.profiles;
  if (
    profiles !== undefined &&
    object(issues, ["profiles"], profiles, ["login"])
  ) {
    const login = profiles.login;
    const at = ["profiles", "login"];
    if (
      login !== undefined &&
      login !== false &&
      object(issues, at, login, [
        "failures",
        "distinctUsernames",
        "distinctAddresses",
        "riskySuccessAfter",
        "device",
        "inferOutcome",
        "mode",
        "failureRate",
      ])
    ) {
      validateFailureRate(issues, [...at, "failureRate"], login.failureRate);
      const failures = login.failures;
      if (
        failures !== undefined &&
        object(issues, [...at, "failures"], failures, [
          "window",
          "delayAfter",
          "challengeAfter",
          "lockAfter",
          "lockFor",
          "maxDelay",
        ])
      ) {
        duration(
          issues,
          [...at, "failures", "window"],
          failures.window,
          1000,
          86_400_000,
        );
        for (const key of ["delayAfter", "challengeAfter", "lockAfter"]) {
          count(issues, [...at, "failures", key], failures[key]);
        }
        duration(
          issues,
          [...at, "failures", "lockFor"],
          failures.lockFor,
          1000,
          86_400_000,
        );
        duration(
          issues,
          [...at, "failures", "maxDelay"],
          failures.maxDelay,
          1,
          60_000,
        );
        const order = [
          failures.delayAfter ?? 5,
          failures.challengeAfter ?? 10,
          failures.lockAfter ?? 20,
        ];
        if (
          order.every((n) => typeof n === "number") &&
          !(
            Number(order[0]) <= Number(order[1]) &&
            Number(order[1]) <= Number(order[2])
          )
        ) {
          add(
            issues,
            [...at, "failures"],
            "needs delayAfter ≤ challengeAfter ≤ lockAfter",
          );
        }
      }
      const users = login.distinctUsernames;
      if (
        users !== undefined &&
        users !== false &&
        object(issues, [...at, "distinctUsernames"], users, [
          "window",
          "challengeAt",
          "banAt",
          "banFor",
        ])
      ) {
        duration(
          issues,
          [...at, "distinctUsernames", "window"],
          users.window,
          1000,
          86_400_000,
        );
        count(
          issues,
          [...at, "distinctUsernames", "challengeAt"],
          users.challengeAt,
        );
        count(issues, [...at, "distinctUsernames", "banAt"], users.banAt);
        duration(
          issues,
          [...at, "distinctUsernames", "banFor"],
          users.banFor,
          1000,
          366 * 86_400_000,
        );
      }
      const addresses = login.distinctAddresses;
      if (
        addresses !== undefined &&
        addresses !== false &&
        object(issues, [...at, "distinctAddresses"], addresses, [
          "window",
          "stepUpAt",
        ])
      ) {
        duration(
          issues,
          [...at, "distinctAddresses", "window"],
          addresses.window,
          1000,
          86_400_000,
        );
        count(
          issues,
          [...at, "distinctAddresses", "stepUpAt"],
          addresses.stepUpAt,
        );
      }
      if (login.riskySuccessAfter !== false) {
        count(issues, [...at, "riskySuccessAfter"], login.riskySuccessAfter);
      }
      const device = login.device;
      if (
        device !== undefined &&
        device !== false &&
        object(issues, [...at, "device"], device, ["cookie", "maxAge"])
      ) {
        if (
          device.cookie !== undefined &&
          (typeof device.cookie !== "string" ||
            !/^[\w.-]{1,64}$/.test(device.cookie))
        ) {
          add(
            issues,
            [...at, "device", "cookie"],
            `must be a cookie name; got ${describe(device.cookie)}`,
          );
        }
        duration(
          issues,
          [...at, "device", "maxAge"],
          device.maxAge,
          60_000,
          400 * 86_400_000,
        );
      }
      if (
        login.inferOutcome !== undefined &&
        typeof login.inferOutcome !== "boolean"
      ) {
        add(issues, [...at, "inferOutcome"], "must be true or false");
      }
      if (
        login.mode !== undefined &&
        !["enforce", "dryRun", "off"].includes(login.mode as string)
      ) {
        add(
          issues,
          [...at, "mode"],
          `must be one of enforce, dryRun, off; got ${describe(login.mode)}`,
        );
      }
    }
  }
  const identifiers = input.identifiers;
  if (
    identifiers !== undefined &&
    object(issues, ["identifiers"], identifiers, [
      "patterns",
      "reserved",
      "ownDomains",
      "code",
    ])
  ) {
    const patterns = identifiers.patterns;
    if (patterns !== undefined) {
      if (!Array.isArray(patterns)) {
        add(issues, ["identifiers", "patterns"], "must be a list");
      } else if (patterns.length > MAX_IDENTIFIER_PATTERNS) {
        add(
          issues,
          ["identifiers", "patterns"],
          `holds ${patterns.length}; the bound is ${MAX_IDENTIFIER_PATTERNS}`,
        );
      } else {
        const ids = new Map<string, number>();
        patterns.forEach((entry: unknown, i: number) => {
          const path = ["identifiers", "patterns", i];
          if (
            !object(issues, path, entry, [
              "id",
              "kind",
              "pattern",
              "reason",
              "mode",
            ])
          )
            return;
          if (typeof entry.kind !== "string" || !KINDS.has(entry.kind)) {
            add(
              issues,
              [...path, "kind"],
              `must be one of email, phone, username, domain; got ${describe(entry.kind)}`,
            );
          }
          const problem = patternProblem(entry.pattern);
          if (problem !== undefined) add(issues, [...path, "pattern"], problem);
          const id =
            entry.id ?? `${String(entry.kind)}:${String(entry.pattern)}`;
          if (typeof id !== "string" || !PATTERN_ID_RE.test(id)) {
            add(issues, [...path, "id"], `is not an id: ${describe(id)}`);
          } else if (ids.has(id)) {
            add(
              issues,
              [...path, "id"],
              `repeats the id of identifiers.patterns[${ids.get(id)}]`,
            );
          } else {
            ids.set(id, i);
          }
          if (
            entry.reason !== undefined &&
            (typeof entry.reason !== "string" || entry.reason.length > 1024)
          ) {
            add(
              issues,
              [...path, "reason"],
              "must be a string of at most 1024 characters",
            );
          }
          if (
            entry.mode !== undefined &&
            !["enforce", "dryRun", "off"].includes(entry.mode as string)
          ) {
            add(
              issues,
              [...path, "mode"],
              `must be one of enforce, dryRun, off; got ${describe(entry.mode)}`,
            );
          }
        });
      }
    }
    if (
      identifiers.reserved !== undefined &&
      typeof identifiers.reserved !== "boolean"
    ) {
      add(issues, ["identifiers", "reserved"], "must be true or false");
    }
    const own = identifiers.ownDomains;
    if (own !== undefined) {
      if (!Array.isArray(own) || own.length > 1000) {
        add(
          issues,
          ["identifiers", "ownDomains"],
          "must be a list of at most 1000 domains",
        );
      } else {
        own.forEach((domain: unknown, i: number) => {
          if (typeof domain !== "string" || !DOMAIN_RE.test(domain)) {
            add(
              issues,
              ["identifiers", "ownDomains", i],
              `is not a lower-case domain name: ${describe(domain)}`,
            );
          }
        });
      }
    }
    if (
      identifiers.code !== undefined &&
      (typeof identifiers.code !== "string" || !CODE_RE.test(identifiers.code))
    ) {
      add(
        issues,
        ["identifiers", "code"],
        "is not a code (lower case, at most 64 characters)",
      );
    }
  }
  return issues;
}
