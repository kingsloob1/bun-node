/**
 * Compile-time checks of the public types, run by `bun run check` (never by
 * `bun test`). Each `@ts-expect-error` is a negative control: if the line it
 * guards ever compiles, the check fails with TS2578.
 */
import type {
  Decision,
  ListEntry,
  SecurityAction,
  SecurityPolicy,
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
