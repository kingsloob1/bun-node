/**
 * Whether a request is counted by two rate limiters: better-auth's own and
 * one of bun-node's, bun-security's or a bun-common `throttle()` ahead of
 * the handler (plan §8.4: one owner per concern). bun-auth only warns; it
 * never turns either off.
 *
 * bun-security is an optional peer, so it is loaded lazily, once, and only
 * when better-auth's limiter is on: an app without it loads nothing.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import { createRequire } from "node:module";
import { getThrottleResults } from "@kingsleyweb/bun-common/lib/throttle";
import type { AuthInstance } from "./types";

/** The bun-security entry whose `requestSecurity()` says it saw a request. */
export const SECURITY_ENTRY = "@kingsleyweb/bun-security/http";

/** What bun-auth uses of bun-security: whether it saw a request. */
export type RequestSecurityProbe = (request: Request) => unknown;

/** Loads bun-security's `requestSecurity`, or answers `undefined` when it is not installed. */
export type SecurityLoader = () => RequestSecurityProbe | undefined;

/** The default loader: `require` from this package, so it finds the app's copy. */
export const loadRequestSecurity: SecurityLoader = () => {
  try {
    const loaded = createRequire(import.meta.url)(SECURITY_ENTRY) as {
      requestSecurity?: unknown;
    };
    return typeof loaded.requestSecurity === "function"
      ? (loaded.requestSecurity as RequestSecurityProbe)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A per-mount check: resolves, for each request, which other limiter counted
 * it while better-auth's own is on (`undefined` when none, or when
 * better-auth's is off). Stops asking once `done()` is called.
 */
export interface LimiterCheck {
  /** The other limiter's name, or `undefined`. */
  check: (req: BunRequest | Request) => Promise<string | undefined>;
  /** Stop checking (the warning has been logged). */
  done: () => void;
}

/** Makes the per-mount {@link LimiterCheck}. */
export function createLimiterCheck(
  auth: AuthInstance,
  load: SecurityLoader = loadRequestSecurity,
): LimiterCheck {
  let finished = false;
  let enabled: Promise<boolean> | undefined;
  let probe: RequestSecurityProbe | null | undefined;
  return {
    async check(req) {
      if (finished) return undefined;
      enabled ??= auth.$context.then(
        (context) => context.rateLimit.enabled,
        () => false,
      );
      if (!(await enabled)) {
        finished = true;
        return undefined;
      }
      const request = req instanceof Request ? req : req.request;
      if (!(req instanceof Request) && getThrottleResults(req) !== undefined) {
        return "a bun-common throttle()";
      }
      if (probe === undefined) probe = load() ?? null;
      if (probe !== null && probe(request) !== undefined) {
        return "bun-security";
      }
      return undefined;
    },
    done() {
      finished = true;
    },
  };
}
