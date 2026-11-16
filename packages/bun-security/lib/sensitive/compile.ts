/**
 * The sensitive endpoints' sections compiled (layers.md L11): the login
 * profile's account defences with their defaults, and the identifier
 * patterns as glob matchers (never regular expressions, so a pattern's cost
 * is bounded whatever it is). Compiled once per compiled policy, as the
 * request rules are.
 */
import { toDurationMs } from "@kingsleyweb/bun-common";
import type { CompiledPolicy } from "../policy/compile";
import type {
  IdentifierKind,
  IdentifierPolicy,
  LoginProfilePolicy,
  ProfilesPolicy,
} from "../policy/types";
import { compileGlob } from "../rules/glob";
import type { GlobMatcher } from "../rules/glob";
import { DEFAULT_DEVICE_COOKIE } from "./keys";

/** The login profile's account defences, compiled. */
export interface CompiledLogin {
  /** The failures window, ms. */
  readonly window: number;
  /** Failures before the delay. */
  readonly delayAfter: number;
  /** Failures before the challenge. */
  readonly challengeAfter: number;
  /** Failures before the soft lock. */
  readonly lockAfter: number;
  /** A soft lock's length, ms. */
  readonly lockFor: number;
  /** The longest delay, ms. */
  readonly maxDelay: number;
  /** Distinct usernames per address, or undefined when off. */
  readonly distinctUsernames:
    | {
        readonly window: number;
        readonly challengeAt: number;
        readonly banAt: number;
        readonly banFor: number;
      }
    | undefined;
  /** Distinct addresses per username, or undefined when off. */
  readonly distinctAddresses:
    { readonly window: number; readonly stepUpAt: number } | undefined;
  /** Failures from an address that make its success risky, or undefined when off. */
  readonly riskySuccessAfter: number | undefined;
  /** The device cookie, or undefined when off. */
  readonly device:
    { readonly cookie: string; readonly maxAge: number } | undefined;
  /** Whether outcomes are inferred from the answer. */
  readonly inferOutcome: boolean;
  /** `enforce` or `dryRun`. */
  readonly mode: "enforce" | "dryRun";
}

/** One identifier pattern, compiled. */
export interface CompiledPattern {
  /** Its id. */
  readonly id: string;
  /** What it matches. */
  readonly kind: IdentifierKind;
  /** The matcher (case folded). */
  readonly test: GlobMatcher;
  /** Why. */
  readonly reason: string | undefined;
  /** `enforce` or `dryRun`. */
  readonly mode: "enforce" | "dryRun";
}

/** The identifier checks, compiled. */
export interface CompiledIdentifiers {
  /** The patterns by kind. */
  readonly patterns: ReadonlyMap<IdentifierKind, readonly CompiledPattern[]>;
  /** Whether reserved domains are refused. */
  readonly reserved: boolean;
  /** The operator's own domains. */
  readonly ownDomains: readonly string[];
  /** The refusal's code. */
  readonly code: string;
}

/** The sensitive endpoints' settings of one policy. */
export interface CompiledSensitive {
  /** The login defences, or undefined when off. */
  readonly login: CompiledLogin | undefined;
  /** The identifier checks. */
  readonly identifiers: CompiledIdentifiers;
}

/** Milliseconds of a validated duration, or `fallback`. */
function msOr(
  value: Parameters<typeof toDurationMs>[0] | undefined,
  fallback: number,
  where: string,
): number {
  return value === undefined ? fallback : toDurationMs(value, where);
}

/** The login defences with their defaults. */
function compileLogin(
  source: LoginProfilePolicy | false | undefined,
): CompiledLogin | undefined {
  if (source === false) return undefined;
  const login = source ?? {};
  if (login.mode === "off") return undefined;
  const failures = login.failures ?? {};
  const users = login.distinctUsernames;
  const addresses = login.distinctAddresses;
  const device = login.device;
  return Object.freeze({
    window: msOr(
      failures.window,
      15 * 60_000,
      "profiles.login.failures.window",
    ),
    delayAfter: failures.delayAfter ?? 5,
    challengeAfter: failures.challengeAfter ?? 10,
    lockAfter: failures.lockAfter ?? 20,
    lockFor: msOr(
      failures.lockFor,
      15 * 60_000,
      "profiles.login.failures.lockFor",
    ),
    maxDelay: msOr(
      failures.maxDelay,
      2_000,
      "profiles.login.failures.maxDelay",
    ),
    distinctUsernames:
      users === false
        ? undefined
        : Object.freeze({
            window: msOr(
              users?.window,
              3_600_000,
              "profiles.login.distinctUsernames.window",
            ),
            challengeAt: users?.challengeAt ?? 10,
            banAt: users?.banAt ?? 30,
            banFor: msOr(
              users?.banFor,
              3_600_000,
              "profiles.login.distinctUsernames.banFor",
            ),
          }),
    distinctAddresses:
      addresses === false
        ? undefined
        : Object.freeze({
            window: msOr(
              addresses?.window,
              3_600_000,
              "profiles.login.distinctAddresses.window",
            ),
            stepUpAt: addresses?.stepUpAt ?? 10,
          }),
    riskySuccessAfter:
      login.riskySuccessAfter === false
        ? undefined
        : (login.riskySuccessAfter ?? 10),
    device:
      device === false
        ? undefined
        : Object.freeze({
            cookie: device?.cookie ?? DEFAULT_DEVICE_COOKIE,
            maxAge: msOr(
              device?.maxAge,
              365 * 86_400_000,
              "profiles.login.device.maxAge",
            ),
          }),
    inferOutcome: login.inferOutcome !== false,
    mode: login.mode ?? "enforce",
  });
}

/** The identifier checks. */
function compileIdentifiers(
  source: IdentifierPolicy | undefined,
): CompiledIdentifiers {
  const patterns = new Map<IdentifierKind, CompiledPattern[]>();
  for (const pattern of source?.patterns ?? []) {
    const mode = pattern.mode ?? "enforce";
    if (mode === "off") continue;
    const compiled: CompiledPattern = Object.freeze({
      id: pattern.id ?? `${pattern.kind}:${pattern.pattern}`,
      kind: pattern.kind,
      test: compileGlob(pattern.pattern.toLowerCase(), true),
      reason: pattern.reason,
      mode,
    });
    const list = patterns.get(pattern.kind);
    if (list) list.push(compiled);
    else patterns.set(pattern.kind, [compiled]);
  }
  return Object.freeze({
    patterns,
    reserved: source?.reserved !== false,
    ownDomains: Object.freeze([...(source?.ownDomains ?? [])]),
    code: source?.code ?? "invalid_identifier",
  });
}

/** Each compiled policy's settings. */
const COMPILED = new WeakMap<CompiledPolicy, CompiledSensitive>();

/** The sensitive endpoints' settings of a compiled policy, compiled once. */
export function sensitiveOf(policy: CompiledPolicy): CompiledSensitive {
  let compiled = COMPILED.get(policy);
  if (compiled === undefined) {
    const source = policy.source as {
      profiles?: ProfilesPolicy;
      identifiers?: IdentifierPolicy;
    };
    const login = compileLogin(source.profiles?.login);
    compiled = Object.freeze({
      login: policy.mode === "off" ? undefined : login,
      identifiers: compileIdentifiers(source.identifiers),
    });
    COMPILED.set(policy, compiled);
  }
  return compiled;
}
