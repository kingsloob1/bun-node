/**
 * `uniformAuthResponse()` (layers.md L11.5): a marker among a sign-in (or
 * reset, signup) route's callbacks that makes `installSecurity`'s response
 * stage answer every failure the same way, whatever the app said: a `401`
 * with one generic problem (OWASP's "Login failed; Invalid user ID or
 * password"), and every answer, success included, no sooner than
 * `minResponseMs` after the request arrived, so neither the status, the
 * body nor the "quick exit" timing tells an existing account from a missing
 * one. bun-security's own refusals (`429`, `403`) are kept as they are.
 */
import type { RouterMiddlewareHandler } from "@kingsleyweb/bun-common";

/** Options for {@link uniformAuthResponse}. */
export interface UniformAuthResponseOptions {
  /** The shortest time to an answer, in milliseconds. Default `300`; at most `5000`. */
  readonly minResponseMs?: number;
  /** The statuses answered as the one failure. Default `[400, 401, 403, 404, 409, 422]`. */
  readonly statuses?: readonly number[];
  /** The failure's status. Default `401`. */
  readonly status?: number;
  /** The failure's problem title. Default `"Login failed"`. */
  readonly title?: string;
  /** The failure's problem code. Default `"login_failed"`. */
  readonly code?: string;
}

/** A uniform answer's settings, as the response stage reads them. */
export interface UniformMark {
  /** The shortest time to an answer, ms. */
  readonly minResponseMs: number;
  /** The statuses replaced. */
  readonly statuses: ReadonlySet<number>;
  /** The replacement's status. */
  readonly status: number;
  /** Its title. */
  readonly title: string;
  /** Its code. */
  readonly code: string;
}

/** Where a marker carries its settings. */
const UNIFORM: unique symbol = Symbol("bun-security.uniform");

/** A marker callback. */
type Marker = RouterMiddlewareHandler & { readonly [UNIFORM]?: UniformMark };

/** The default failure statuses. */
const STATUSES = [400, 401, 403, 404, 409, 422];

/**
 * A marker that makes the route's failures uniform and its answers no
 * quicker than `minResponseMs` (see the module's description), applied by
 * `installSecurity`. Throws a `TypeError` for a bad option.
 *
 * @example
 * ```ts
 * app.post("/login", securityProfile("login"), uniformAuthResponse(), login);
 * ```
 */
export function uniformAuthResponse(
  options: UniformAuthResponseOptions = {},
): RouterMiddlewareHandler {
  const minResponseMs = options.minResponseMs ?? 300;
  if (
    !Number.isSafeInteger(minResponseMs) ||
    minResponseMs < 0 ||
    minResponseMs > 5000
  ) {
    throw new TypeError(
      "bun-security: uniformAuthResponse(): minResponseMs must be a whole number from 0 to 5000",
    );
  }
  const status = options.status ?? 401;
  const statuses = options.statuses ?? STATUSES;
  for (const value of [status, ...statuses]) {
    if (!Number.isSafeInteger(value) || value < 400 || value > 499) {
      throw new TypeError(
        "bun-security: uniformAuthResponse(): statuses must be 4xx statuses",
      );
    }
  }
  const title = options.title ?? "Login failed";
  const code = options.code ?? "login_failed";
  if (
    typeof title !== "string" ||
    title.length > 200 ||
    !/^[a-z][a-z0-9_.-]{0,63}$/.test(code)
  ) {
    throw new TypeError(
      "bun-security: uniformAuthResponse(): title must be a short string, code a problem code",
    );
  }
  const mark: UniformMark = Object.freeze({
    minResponseMs,
    statuses: new Set(statuses),
    status,
    title,
    code,
  });
  const marker: RouterMiddlewareHandler = (_req, _res, next) => next();
  Object.defineProperty(marker, UNIFORM, { value: mark });
  return marker;
}

/** The first uniform marker among a route's callbacks, if any. */
export function uniformOf(
  callbacks: readonly unknown[],
): UniformMark | undefined {
  for (const callback of callbacks) {
    if (typeof callback === "function") {
      const mark = (callback as Marker)[UNIFORM];
      if (mark !== undefined) return mark;
    }
  }
  return undefined;
}

/**
 * The answer a uniform route sends instead of `response`: the one failure
 * for a failing status, `response` itself otherwise; and when to send it,
 * no sooner than `minResponseMs` after `startedAt` (`performance.now()`).
 */
export function uniformAnswer(
  mark: UniformMark,
  response: Response,
  startedAt: number,
): { readonly response: Response | undefined; readonly waitMs: number } {
  const waitMs = Math.max(
    0,
    startedAt + mark.minResponseMs - performance.now(),
  );
  if (!mark.statuses.has(response.status))
    return { response: undefined, waitMs };
  return {
    response: new Response(
      JSON.stringify({
        type: "about:blank",
        title: mark.title,
        status: mark.status,
        code: mark.code,
      }),
      {
        status: mark.status,
        headers: {
          "content-type": "application/problem+json",
          "cache-control": "no-store",
        },
      },
    ),
    waitMs,
  };
}
