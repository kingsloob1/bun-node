/**
 * `coalesceRequests(options?)` (plan §9.5): identical in-flight `GET`s share
 * one handler run, with no store. The first request runs the handler; those
 * arriving while it runs wait, and each gets a copy of its buffered answer —
 * status, headers and bytes — sent through its own `res.send` (so each still
 * gets its own 304, compression and the rest).
 */
import type {
  BunRequest,
  BunResponse,
  NextFunction,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import { createDeferred, parseCacheControl } from "@kingsleyweb/bun-common";
import {
  answerConditional,
  captureBody,
  maskConditional,
  snapshotHeaders,
} from "./capture";
import { headerLines } from "./policy";

/** How long a follower waits for the leader by default, in ms. */
const DEFAULT_WAIT = 10_000;

/** `coalesceRequests()`'s options (plan §9.5). */
export interface CoalesceRequestsOptions {
  /**
   * The key identical requests share; `undefined` runs the request on its
   * own. Defaults to the host and the URL, and leaves requests with
   * `Authorization` or `Cookie` on their own — a key function that is to
   * coalesce those must include the identity in the key.
   */
  key?: (req: BunRequest) => string | undefined;
  /**
   * How long followers wait for the leader's answer, in ms, counted from
   * the leader's start; after it they run the handler themselves. A leader
   * whose answer bypasses the response transforms (an unhandled error, the
   * adapter's bare 404) holds them that long. Defaults to 10 s.
   */
  wait?: number;
}

/** The leader's answer, as followers replay it. */
interface Shared {
  /** The status. */
  status: number;
  /** The status text; `""` for the default. */
  statusText: string;
  /** The header lines to replay. */
  headers: [string, string][];
  /** The body. */
  body: Uint8Array;
}

/**
 * Whether a captured answer may be handed to other requests: not one that
 * sets a new cookie, and not `private`, `no-store` or `no-cache` — what
 * Varnish's waiting list releases to the backend rather than share.
 */
function shareable(response: Response, presetCookies: Set<string>): boolean {
  if (
    response.headers.getSetCookie().some((line) => !presetCookies.has(line))
  ) {
    return false;
  }
  const cc = parseCacheControl(response.headers.get("cache-control"));
  return (
    cc.private === undefined &&
    cc.noStore === undefined &&
    cc.noCache === undefined
  );
}

/**
 * A middleware coalescing identical in-flight `GET`s (plan §9.5), without
 * storing anything:
 *
 * ```ts
 * router.get("/report", coalesceRequests(), handler);
 * router.use("/api", coalesceRequests({ key: (req) => `${req.getHeader("x-tenant")} ${req.originalUrl}` }));
 * ```
 *
 * Followers get a copy of the leader's answer only when it is shareable —
 * buffered (not streamed), setting no cookie, and not `private`,
 * `no-store` or `no-cache` — and otherwise run the handler themselves.
 * Headers set by middleware ahead of it are each request's own, never
 * copied. `cacheResponse()` coalesces its own misses already.
 */
export function coalesceRequests(
  options: CoalesceRequestsOptions = {},
): RouterHandler {
  const wait = options.wait ?? DEFAULT_WAIT;
  if (typeof wait !== "number" || !Number.isFinite(wait) || wait < 0) {
    throw new RangeError(
      "coalesceRequests(): wait must be a finite number of ms, 0 or more",
    );
  }
  /** The flights in progress, by key. */
  const flights = new Map<string, Promise<Shared | undefined>>();

  /** Leads a flight: hands on, and settles it with the answer once captured (or `undefined` after `wait`). */
  const lead = (
    key: string,
    req: BunRequest,
    res: BunResponse,
    next: NextFunction,
  ): void => {
    const deferred = createDeferred<Shared | undefined>();
    flights.set(key, deferred.promise);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (shared: Shared | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (flights.get(key) === deferred.promise) {
        flights.delete(key);
      }
      deferred.resolve(shared);
    };
    timer = setTimeout(() => settle(undefined), wait);
    timer.unref?.();

    const preset = snapshotHeaders(res);
    const presetCookies = new Set(preset.get("set-cookie") ?? []);
    const conditional = maskConditional(req);
    res.addResponseTransform(
      {
        transform: (response, context) => {
          const body = shareable(response, presetCookies)
            ? captureBody(response, context)
            : undefined;
          if (body === undefined) {
            settle(undefined);
          } else {
            const headers = headerLines(response.headers, preset, new Set());
            void Promise.resolve(body).then(
              (bytes) =>
                settle({
                  status: response.status,
                  statusText: response.statusText,
                  headers,
                  body: bytes,
                }),
              () => settle(undefined),
            );
          }
          return conditional ? answerConditional(req, response) : response;
        },
      },
      { first: true },
    );
    next();
  };

  return async function coalesceRequestsMiddleware(
    req: BunRequest,
    res: BunResponse,
    next: NextFunction,
  ): Promise<void> {
    if (res.headersSent || req.method !== "GET") {
      next();
      return;
    }
    let key: string | undefined;
    if (options.key !== undefined) {
      key = options.key(req);
    } else if (
      req.getHeader("authorization") === null &&
      req.getHeader("cookie") === null
    ) {
      key = `${req.host.toLowerCase()} ${req.originalUrl}`;
    }
    if (key === undefined) {
      next();
      return;
    }
    const flight = flights.get(key);
    if (flight === undefined) {
      lead(key, req, res, next);
      return;
    }
    const shared = await flight;
    if (shared === undefined) {
      next();
      return;
    }
    res.status(shared.status);
    if (shared.statusText !== "") {
      res.statusText(shared.statusText);
    }
    for (const [name, value] of shared.headers) {
      res.setHeader(name, value);
    }
    res.send(shared.body);
  };
}
