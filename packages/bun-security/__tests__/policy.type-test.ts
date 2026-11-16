/**
 * Compile-time checks of the public types, run by `bun run check` (never by
 * `bun test`). Each `@ts-expect-error` is a negative control: if the line it
 * guards ever compiles, the check fails with TS2578.
 */
import type {
  ConcurrencyPolicy,
  CountedRule,
  Decision,
  LimitRule,
  ListEntry,
  RuleHit,
  SecurityAction,
  SecurityPolicy,
  SecurityWarningKind,
  SubjectKeyPart,
  TrustCheckPolicy,
} from "../lib/index";
import { createSecurity } from "../lib/index";
import { hardenServe, withSecurity } from "../lib/serve/index";

/** `true` when `A` and `B` are the same type. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Compiles only for `true`. */
function assertType<T extends true>(): T | undefined {
  return undefined;
}

// Durations take their unit: a bare number is refused (T-L9-3's rule).
export const window: TrustCheckPolicy = { window: "5m" };
export const windowObject: TrustCheckPolicy = { window: { minutes: 5 } };
// @ts-expect-error a bare number is ambiguous
export const windowNumber: TrustCheckPolicy = { window: 300 };

// A timestamp is a string, never an epoch number.
export const expiresNumber: ListEntry = {
  ip: "192.0.2.1",
  action: "block",
  // @ts-expect-error expiresAt is an ISO 8601 string
  expiresAt: 1_800_000_000,
};

// List actions are the four of layers.md L3.
// @ts-expect-error ban is not a list action
export const banEntry: ListEntry = { ip: "192.0.2.1", action: "ban" };

// Unknown policy keys are refused; $-notes are allowed.
export const noted: SecurityPolicy = { $comment: "allowed", lists: [] };
// @ts-expect-error a typo is not a policy key
export const typo: SecurityPolicy = { list: [] };

assertType<
  Equal<
    Decision["action"],
    "allow" | "log" | "tag" | "delay" | "challenge" | "block" | "ban" | "drop"
  >
>();
assertType<Equal<SecurityAction, Decision["action"]>>();

// The engine's request type follows identify().
const typed = createSecurity<{ user: string }>({
  policy: {},
  identify: (request) => ({ user: request.user }),
});
assertType<Equal<Parameters<typeof typed.identify>[0], { user: string }>>();

// withSecurity needs an engine over web-standard requests.
// @ts-expect-error an engine over another request type does not fit
withSecurity(typed, () => new Response("ok"));

// hardenServe keeps the caller's own type, so Bun.serve still infers from it.
export const options = hardenServe({
  port: 0,
  fetch: () => new Response("ok"),
});
assertType<Equal<typeof options.port, number>>();
assertType<Equal<typeof options.idleTimeout, number>>();

// The policy format's version is 1; a newer one is not a v1 policy.
export const versioned: SecurityPolicy = { version: 1 };
// @ts-expect-error version 2 is not this package's format
export const newer: SecurityPolicy = { version: 2 };

// T-L9-3 at compile time: a limit's window and a counted rule's take a unit.
export const limit: LimitRule = { id: "l", limit: 10, window: "1m" };
// @ts-expect-error a bare number is ambiguous
export const limitNumber: LimitRule = { id: "l", limit: 10, window: 60 };
export const composite: LimitRule = {
  id: "c",
  limit: 10,
  window: { minutes: 1 },
  key: ["ip", "user"],
};
// @ts-expect-error `address` is not a key part
export const badPart: SubjectKeyPart = "address";
export const rule: CountedRule = {
  id: "r",
  event: "auth.failure",
  threshold: 10,
  window: "15m",
  duration: null,
};
// @ts-expect-error a duration takes a unit too
export const ruleNumber: CountedRule = { ...rule, duration: 3600 };
// @ts-expect-error a counted rule bans or challenges; blocking one request is a limit's job
export const ruleBlock: CountedRule = { ...rule, action: "block" };
export const concurrency: ConcurrencyPolicy = { perIp: 64, total: false };
// @ts-expect-error a cap is a number or false
export const concurrencyTrue: ConcurrencyPolicy = { total: true };

// complete() and signal() answer the hits they caused.
export const engine = createSecurity({
  policy: { limits: [limit], countedRules: [rule] },
});
assertType<
  Equal<
    ReturnType<typeof engine.signal>,
    readonly RuleHit[] | Promise<readonly RuleHit[]>
  >
>();
assertType<
  Equal<ReturnType<typeof engine.complete>, ReturnType<typeof engine.signal>>
>();
assertType<
  Equal<
    Parameters<typeof engine.evaluate>[1],
    { readonly track?: boolean } | undefined
  >
>();
assertType<
  Equal<
    SecurityWarningKind,
    "trust.internal" | "trust.unread-forwarding" | "state.evictions"
  >
>();
