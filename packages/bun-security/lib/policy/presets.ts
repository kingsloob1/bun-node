/**
 * The built-in rules, named presets (plan §17.4, "presets, staged"; layers.md
 * L9.3, L11): limits and counted rules a policy gets without writing them,
 * each with an id it can turn on or off (`presets: { "per-ip": false }`) or
 * replace (a limit or counted rule of the policy with the preset's id).
 *
 * - **On**: L9.3's per-address and per-user limits (`per-ip`, `per-user`),
 *   and the sensitive endpoints' rules, which apply only to requests of
 *   routes the app marked with their profile (`login.*`, `mfa.*`, `otp.*`,
 *   `reset.*`, `signup.*`).
 * - **On, in dry run**: `not_found_per_minute` (the user's decision with
 *   PR-S12, now that a verified crawler's route-not-found answers are not
 *   counted): it records the bans it would make.
 *
 * Each preset's switch in `presets` is `true` (on, as it ships), `"enforce"`
 * (on, enforced) or `false` (off). So `true` changes nothing for a preset
 * that ships enforced, and `{ not_found_per_minute: "enforce" }` enforces
 * the one that ships in dry run.
 */
import type { CountedRule, LimitRule, PresetSetting } from "./types";

/** A preset: a limit or a counted rule, on or off by default. */
export type Preset =
  | {
      /** A limit. */
      readonly kind: "limit";
      /** Whether it is on unless the policy says otherwise. */
      readonly on: boolean;
      /** The rule. */
      readonly rule: LimitRule;
    }
  | {
      /** A counted rule. */
      readonly kind: "counted";
      /** Whether it is on unless the policy says otherwise. */
      readonly on: boolean;
      /** The rule. */
      readonly rule: CountedRule;
    };

/** A limit preset. */
function limit(on: boolean, rule: LimitRule): Preset {
  return Object.freeze({ kind: "limit", on, rule: Object.freeze(rule) });
}

/** A counted-rule preset. */
function counted(on: boolean, rule: CountedRule): Preset {
  return Object.freeze({ kind: "counted", on, rule: Object.freeze(rule) });
}

/**
 * Every preset, by id, in the order they are added ahead of the policy's own
 * rules. Their figures are layers.md L9.3's and L11.2/L11.6's (ConcaveHR's
 * where it had one).
 */
export const PRESETS: Readonly<Record<string, Preset>> = Object.freeze({
  // L9.3: generous, because offices share one address.
  "per-ip": limit(true, {
    id: "per-ip",
    limit: 600,
    window: "1m",
    key: ["ip", "route"],
  }),
  "per-user": limit(true, {
    id: "per-user",
    limit: 1000,
    window: "1m",
    key: "user",
  }),
  // Sign-in (ConcaveHR's: per address and account, and per address).
  "login.account": limit(true, {
    id: "login.account",
    limit: 10,
    window: "1m",
    key: ["ip", "username"],
    profile: "login",
  }),
  "login.ip": limit(true, {
    id: "login.ip",
    limit: 30,
    window: "1m",
    profile: "login",
  }),
  "login.ip-failures": counted(true, {
    id: "login.ip-failures",
    event: "auth.failure",
    threshold: 20,
    window: "15m",
    action: "challenge",
    duration: "15m",
    profile: "login",
  }),
  "login.ip-failures-ban": counted(true, {
    id: "login.ip-failures-ban",
    event: "auth.failure",
    threshold: 50,
    window: "15m",
    duration: "1h",
    profile: "login",
  }),
  // A second factor's step.
  "mfa.account": limit(true, {
    id: "mfa.account",
    limit: 5,
    window: "1m",
    key: ["ip", "user"],
    profile: "mfa",
  }),
  "mfa.ip": limit(true, {
    id: "mfa.ip",
    limit: 30,
    window: "1m",
    profile: "mfa",
  }),
  "mfa.failures": counted(true, {
    id: "mfa.failures",
    event: "mfa.failure",
    threshold: 10,
    window: "15m",
    duration: "1h",
    profile: "mfa",
  }),
  // Sending a code (SMS pumping: per destination and its prefix).
  "otp.ip": limit(true, {
    id: "otp.ip",
    limit: 5,
    window: "1m",
    profile: "otp",
  }),
  "otp.ip-hour": limit(true, {
    id: "otp.ip-hour",
    limit: 10,
    window: "1h",
    profile: "otp",
  }),
  "otp.destination": limit(true, {
    id: "otp.destination",
    limit: 3,
    window: "10m",
    key: "destination",
    profile: "otp",
  }),
  "otp.destination-day": limit(true, {
    id: "otp.destination-day",
    limit: 10,
    window: "24h",
    key: "destination",
    profile: "otp",
  }),
  "otp.prefix": limit(true, {
    id: "otp.prefix",
    limit: 100,
    window: "1h",
    key: "destinationPrefix",
    profile: "otp",
  }),
  // Password reset.
  "reset.ip": limit(true, {
    id: "reset.ip",
    limit: 5,
    window: "1m",
    profile: "reset",
  }),
  "reset.ip-hour": limit(true, {
    id: "reset.ip-hour",
    limit: 10,
    window: "1h",
    profile: "reset",
  }),
  "reset.destination": limit(true, {
    id: "reset.destination",
    limit: 3,
    window: "1h",
    key: "destination",
    profile: "reset",
  }),
  // Sign-up.
  "signup.ip": limit(true, {
    id: "signup.ip",
    limit: 5,
    window: "1h",
    profile: "signup",
  }),
  // Fuzzing's signature (ConcaveHR's): on in dry run since PR-S12's crawler
  // exemption.
  not_found_per_minute: counted(true, {
    id: "not_found_per_minute",
    event: "route.notFound",
    threshold: 120,
    window: "1m",
    duration: "24h",
    mode: "dryRun",
  }),
});

/** The built-in profile names: the ones the presets and the login defences know. */
export const PROFILE_NAMES: readonly string[] = Object.freeze([
  "login",
  "mfa",
  "otp",
  "reset",
  "signup",
]);

/**
 * The policy's limits and counted rules with the presets in force added
 * ahead of them: those `presets` leaves on (or turns on), and not replaced
 * by a rule of the policy with the same id.
 */
export function withPresets(
  presets: Readonly<Record<string, PresetSetting>> | undefined,
  limits: readonly LimitRule[] | undefined,
  countedRules: readonly CountedRule[] | undefined,
): { limits: LimitRule[]; countedRules: CountedRule[] } {
  const ownLimits = new Set((limits ?? []).map((rule) => rule.id));
  const ownCounted = new Set((countedRules ?? []).map((rule) => rule.id));
  const outLimits: LimitRule[] = [];
  const outCounted: CountedRule[] = [];
  for (const [id, preset] of Object.entries(PRESETS)) {
    const setting = presets?.[id] ?? preset.on;
    if (setting === false) continue;
    // `"enforce"` overrides the mode a preset ships with (dry run for
    // `not_found_per_minute`); `true` keeps it.
    const enforced = setting === "enforce";
    if (preset.kind === "limit") {
      if (!ownLimits.has(id)) {
        outLimits.push(
          enforced ? { ...preset.rule, mode: "enforce" } : preset.rule,
        );
      }
    } else if (!ownCounted.has(id)) {
      outCounted.push(
        enforced ? { ...preset.rule, mode: "enforce" } : preset.rule,
      );
    }
  }
  return {
    limits: [...outLimits, ...(limits ?? [])],
    countedRules: [...outCounted, ...(countedRules ?? [])],
  };
}
