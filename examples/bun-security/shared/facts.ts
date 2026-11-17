/**
 * A request's facts for the engine, in one line: what `withSecurity` and
 * `installSecurity` build for each request, for the examples that ask the
 * engine directly (`security.evaluate`, `explain`, `signal`).
 */
import { requestFacts } from "@kingsleyweb/bun-security";
import type { RequestFacts, SecurityIdentity } from "@kingsleyweb/bun-security";

/** What {@link facts} takes besides the client. */
export interface FactsOptions {
  /** The path, with any query. Default `/`. */
  path?: string;
  /** The method. Default `GET`. */
  method?: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** Who the app says is calling (`identify()`'s answer). */
  identity?: SecurityIdentity;
  /** The matched route (`"POST /login"`), when the example plays the route stage. */
  routeKey?: string;
  /** The matched route's profile (`"login"`). */
  profile?: string;
}

/** The facts of a request from `client` (the socket peer). */
export function facts(
  client: string,
  options: FactsOptions = {},
): RequestFacts {
  return requestFacts(
    new Request(`http://app.test${options.path ?? "/"}`, {
      method: options.method ?? "GET",
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    }),
    {
      peer: client,
      ...(options.identity === undefined ? {} : { identity: options.identity }),
      ...(options.routeKey === undefined ? {} : { routeKey: options.routeKey }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
    },
  );
}

/** A clock the example moves by hand, so a day passes in a line. */
export interface FakeClock {
  /** The time now, ms since the epoch. */
  now: () => number;
  /** Moves it forward by `ms`. */
  advance: (ms: number) => void;
}

/** A {@link FakeClock} starting at a fixed date. */
export function fakeClock(start = Date.UTC(2026, 10, 16, 9, 0, 0)): FakeClock {
  let time = start;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}
