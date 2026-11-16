/**
 * The policy's `apiKeys` section (layers.md L12 v1): the two anomalies an
 * API key is watched for —
 *
 * - **`newAsn`**: a key used from an autonomous system it has never been
 *   used from (its first one is learned, not an anomaly); needs the
 *   engine's `intel` with an ASN database;
 * - **`manyAddresses`**: a key used from more than `limit` distinct
 *   addresses in `window` (20 an hour by default; `identify()`'s
 *   `apiKeyMaxAddresses` sets it per key, `false` for none: a key in a
 *   mobile app is legitimately everywhere).
 *
 * Each is an event (`apiKey.newAsn`, `apiKey.manyAddresses`) for counted
 * rules and the ladder, and does what its `action` says: `log`, `tag` (the
 * decision's tags carry `api-key:new-asn` / `api-key:many-addresses`, the
 * default), `challenge`, or `ban` (the key suspended for `duration`, and
 * `onKeyCompromised` called so the app can revoke it). Off unless the
 * section names them.
 *
 * Kept beside the compiled policy (a `WeakMap`), validated through one call
 * in `policy/schema.ts`.
 */
import { toDurationMs } from "@kingsleyweb/bun-common";
import type { Duration } from "@kingsleyweb/bun-common";
import type { CompiledPolicy } from "../policy/compile";

/** What an anomaly does. */
export type ApiKeyAnomalyAction = "log" | "tag" | "challenge" | "ban";

/** One anomaly's settings. */
export interface ApiKeyAnomalyPolicy {
  /** `enforce` (the default), `dryRun` (logged as what it would have done) or `off`. */
  readonly mode?: "enforce" | "dryRun" | "off";
  /** What it does. Default `"tag"`. */
  readonly action?: ApiKeyAnomalyAction;
  /** How long a `ban` suspends the key. Default `"1h"`; `null` until lifted. */
  readonly duration?: Duration | null;
}

/** The `apiKeys` section. */
export interface ApiKeysPolicy {
  /** A key used from an ASN it has never used: `true` for the defaults. */
  readonly newAsn?:
    | boolean
    | (ApiKeyAnomalyPolicy & {
        /** How long a key's ASNs are remembered, from their first use. Default `"30d"`. */
        readonly remember?: Duration;
      });
  /** A key used from too many distinct addresses: `true` for the defaults. */
  readonly manyAddresses?:
    | boolean
    | (ApiKeyAnomalyPolicy & {
        /** The most distinct addresses (by the policy's IPv6 prefix) in `window`. Default `20`. */
        readonly limit?: number;
        /** The window. Default `"1h"`. */
        readonly window?: Duration;
      });
}

/** One problem: where, and what. */
export interface ApiKeyIssue {
  /** The path below the policy's root. */
  readonly path: readonly (string | number)[];
  /** What is wrong. */
  readonly message: string;
}

/** Whether `value` is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every problem in a policy's `apiKeys` section (none when absent). */
export function validateApiKeys(input: unknown): ApiKeyIssue[] {
  if (input === undefined) return [];
  const issues: ApiKeyIssue[] = [];
  const at = (path: readonly (string | number)[], message: string) =>
    issues.push({ path: ["apiKeys", ...path], message });
  if (!isRecord(input)) {
    at([], "must be an object");
    return issues;
  }
  for (const key of Object.keys(input)) {
    if (key !== "newAsn" && key !== "manyAddresses") {
      at([key], "is not an apiKeys setting (newAsn, manyAddresses)");
    }
  }
  for (const name of ["newAsn", "manyAddresses"] as const) {
    const value = input[name];
    if (value === undefined || typeof value === "boolean") continue;
    if (!isRecord(value)) {
      at([name], "must be true, false or an object");
      continue;
    }
    const own = name === "newAsn" ? ["remember"] : ["limit", "window"];
    for (const key of Object.keys(value)) {
      if (!["mode", "action", "duration", ...own].includes(key)) {
        at(
          [name, key],
          `is not a ${name} setting (mode, action, duration, ${own.join(", ")})`,
        );
      }
    }
    if (
      value.mode !== undefined &&
      !["enforce", "dryRun", "off"].includes(value.mode as string)
    ) {
      at([name, "mode"], 'must be "enforce", "dryRun" or "off"');
    }
    if (
      value.action !== undefined &&
      !["log", "tag", "challenge", "ban"].includes(value.action as string)
    ) {
      at([name, "action"], 'must be "log", "tag", "challenge" or "ban"');
    }
    for (const key of ["duration", "remember", "window"] as const) {
      const duration = value[key];
      if (duration === undefined || (key === "duration" && duration === null))
        continue;
      try {
        if (
          toDurationMs(duration as Duration, `apiKeys.${name}.${key}`) < 1000
        ) {
          at([name, key], "must be at least a second");
        }
      } catch (error) {
        at([name, key], error instanceof Error ? error.message : String(error));
      }
    }
    if (
      value.limit !== undefined &&
      (typeof value.limit !== "number" ||
        !Number.isSafeInteger(value.limit) ||
        value.limit < 1 ||
        value.limit > 1_000_000)
    ) {
      at([name, "limit"], "must be a whole number from 1 to 1,000,000");
    }
  }
  return issues;
}

/** One anomaly, compiled. */
export interface CompiledAnomaly {
  /** `enforce` or `dryRun`. */
  readonly mode: "enforce" | "dryRun";
  /** What it does. */
  readonly action: ApiKeyAnomalyAction;
  /** A ban's length in ms; `null` until lifted. */
  readonly duration: number | null;
}

/** The section compiled. */
export interface CompiledApiKeys {
  /** The new-ASN anomaly, if on, with how long ASNs are remembered (ms). */
  readonly newAsn:
    (CompiledAnomaly & { readonly remember: number }) | undefined;
  /** The many-addresses anomaly, if on, with its limit and window (ms). */
  readonly manyAddresses:
    | (CompiledAnomaly & { readonly limit: number; readonly window: number })
    | undefined;
}

/** The section compiled per policy. */
const COMPILED = new WeakMap<CompiledPolicy, CompiledApiKeys>();

/** One anomaly's common settings. */
function anomaly(
  value: ApiKeyAnomalyPolicy,
  what: string,
): CompiledAnomaly | undefined {
  if (value.mode === "off") return undefined;
  return {
    mode: value.mode ?? "enforce",
    action: value.action ?? "tag",
    duration:
      value.duration === null
        ? null
        : toDurationMs(value.duration ?? "1h", `apiKeys.${what}.duration`),
  };
}

/** A policy's API key anomalies, compiled once (the policy was validated). */
export function apiKeysOf(policy: CompiledPolicy): CompiledApiKeys {
  let compiled = COMPILED.get(policy);
  if (compiled === undefined) {
    const source = (policy.source as { apiKeys?: ApiKeysPolicy }).apiKeys ?? {};
    const newAsn = source.newAsn === true ? {} : source.newAsn || undefined;
    const many =
      source.manyAddresses === true ? {} : source.manyAddresses || undefined;
    const asn = newAsn === undefined ? undefined : anomaly(newAsn, "newAsn");
    const addresses =
      many === undefined ? undefined : anomaly(many, "manyAddresses");
    compiled = Object.freeze({
      newAsn:
        asn === undefined || newAsn === undefined
          ? undefined
          : {
              ...asn,
              remember: toDurationMs(
                newAsn.remember ?? "30d",
                "apiKeys.newAsn.remember",
              ),
            },
      manyAddresses:
        addresses === undefined || many === undefined
          ? undefined
          : {
              ...addresses,
              limit: many.limit ?? 20,
              window: toDurationMs(
                many.window ?? "1h",
                "apiKeys.manyAddresses.window",
              ),
            },
    });
    COMPILED.set(policy, compiled);
  }
  return compiled;
}
