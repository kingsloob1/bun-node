/**
 * Native CORS middleware — a dependency-free replacement for the `cors`
 * package, implemented directly against {@link BunRequest}/{@link BunResponse}.
 */
import type { BunRequest } from "./BunRequest";
import type { BunResponse } from "./BunResponse";
import type { NextFunction } from "./types/general";

/**
 * A fixed `origin` value — and what a function `origin` may answer with:
 *
 * - `true` reflects the request's origin; `false` sends no `Allow-Origin`;
 * - a string is sent as it is;
 * - a RegExp, or an array of strings, RegExps and booleans, reflects the
 *   request's origin when any entry matches it.
 */
export type CorsStaticOrigin =
  | boolean
  | string
  | RegExp
  | (boolean | string | RegExp)[];

/**
 * Decides the origin per request, as the `cors` package's `CustomOrigin`:
 * called with the request's `Origin` header (`undefined` when absent), it
 * answers through `callback` with an error — forwarded to `next(err)` — or with
 * a {@link CorsStaticOrigin}, which is then applied like a fixed `origin`.
 */
export type CorsCustomOrigin = (
  requestOrigin: string | undefined,
  callback: (err: Error | null, origin?: CorsStaticOrigin) => void,
) => void;

/** Every accepted form of `CorsOptions.origin`. */
export type CorsOrigin = CorsStaticOrigin | CorsCustomOrigin;

export interface CorsOptions {
  /**
   * Which origins get `Access-Control-Allow-Origin`: a {@link CorsStaticOrigin}
   * or a {@link CorsCustomOrigin} function. Defaults to `"*"`.
   */
  origin?: CorsOrigin;
  /**
   * `Access-Control-Allow-Methods` on a preflight: a comma-separated string or
   * an array. Defaults to `"GET,HEAD,PUT,PATCH,POST,DELETE"`.
   */
  methods?: string | string[];
  /**
   * `Access-Control-Allow-Headers` on a preflight. When unset, the request's
   * `Access-Control-Request-Headers` is reflected (and added to `Vary`).
   */
  allowedHeaders?: string | string[];
  /** `Access-Control-Expose-Headers` on every response. Unset by default. */
  exposedHeaders?: string | string[];
  /** Sends `Access-Control-Allow-Credentials: true` when `true`. Defaults to `false`. */
  credentials?: boolean;
  /** `Access-Control-Max-Age`, in seconds, on a preflight. Unset by default. */
  maxAge?: number;
  /**
   * Passes a preflight on to the next handler instead of ending it. Defaults
   * to `false`.
   */
  preflightContinue?: boolean;
  /** Status that ends a preflight when not continued. Defaults to `204`. */
  optionsSuccessStatus?: number;
}

/**
 * Chooses the options per request, as the `cors` package's delegate: answer
 * through `callback` with an error — forwarded to `next(err)` — or with the
 * options to apply, merged over the defaults.
 */
export type CorsOptionsDelegate<T = BunRequest> = (
  req: T,
  callback: (err: Error | null, options?: CorsOptions) => void,
) => void;

const DEFAULT_OPTIONS: Required<
  Omit<CorsOptions, "allowedHeaders" | "exposedHeaders" | "maxAge">
> = {
  origin: "*",
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  credentials: false,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

function isOriginAllowed(
  origin: string | undefined,
  allowed: CorsStaticOrigin,
): boolean {
  if (Array.isArray(allowed)) {
    return allowed.some((entry) => isOriginAllowed(origin, entry));
  }
  if (allowed instanceof RegExp) {
    return origin != null && allowed.test(origin);
  }
  if (typeof allowed === "boolean") {
    return allowed;
  }
  return allowed === "*" || allowed === origin;
}

/** Applies a fixed origin to the request's own, giving the header value. */
function resolveStaticOrigin(
  origin: CorsStaticOrigin | undefined,
  requestOrigin: string | undefined,
): string | false {
  if (origin === true) {
    return requestOrigin ?? "*";
  }
  if (origin === false || origin === undefined || origin === "") {
    return false;
  }
  if (typeof origin === "string") {
    return origin;
  }
  return isOriginAllowed(requestOrigin, origin)
    ? (requestOrigin ?? false)
    : false;
}

function resolveOrigin(
  origin: CorsOrigin,
  requestOrigin: string | undefined,
): Promise<string | false> {
  if (typeof origin !== "function") {
    return Promise.resolve(resolveStaticOrigin(origin, requestOrigin));
  }
  return new Promise((resolve, reject) => {
    origin(requestOrigin, (err, answer) => {
      if (err) {
        reject(err);
      } else {
        resolve(resolveStaticOrigin(answer, requestOrigin));
      }
    });
  });
}

/** Calls a delegate, turning its callback (or a throw) into a promise. */
function runDelegate(
  delegate: CorsOptionsDelegate<BunRequest>,
  req: BunRequest,
): Promise<CorsOptions | undefined> {
  return new Promise((resolve, reject) => {
    delegate(req, (err, options) => {
      if (err) {
        reject(err);
      } else {
        resolve(options);
      }
    });
  });
}

/**
 * The middleware {@link cors} builds — a router handler that always settles
 * asynchronously.
 *
 * It resolves to whatever `next()` returned, or the ended response for a
 * preflight. `unknown`, because `NextFunction`'s result is opaque to a
 * middleware: the router decides what it is.
 */
export type CorsMiddleware = (
  req: BunRequest,
  res: BunResponse,
  next: NextFunction,
) => Promise<unknown>;

/**
 * Sets the CORS headers for `opts`, then ends a preflight or calls `next`.
 * Resolves as {@link CorsMiddleware} does.
 */
async function applyCors(
  opts: typeof DEFAULT_OPTIONS & CorsOptions,
  req: BunRequest,
  res: BunResponse,
  next: NextFunction,
): Promise<unknown> {
  const requestOrigin = req.getHeader("Origin") ?? undefined;
  const isPreflight = req.method === "OPTIONS";

  res.vary("Origin");

  // Access-Control-Allow-Origin
  let allowedOrigin: string | false;
  try {
    allowedOrigin = await resolveOrigin(opts.origin, requestOrigin);
  } catch (err) {
    return next(err as Error);
  }

  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  }

  if (opts.credentials) {
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  if (opts.exposedHeaders) {
    const exposed = Array.isArray(opts.exposedHeaders)
      ? opts.exposedHeaders.join(",")
      : opts.exposedHeaders;
    if (exposed) {
      res.setHeader("Access-Control-Expose-Headers", exposed);
    }
  }

  if (!isPreflight) {
    return next();
  }

  // Preflight-only headers
  const methods = Array.isArray(opts.methods)
    ? opts.methods.join(",")
    : opts.methods;
  res.setHeader("Access-Control-Allow-Methods", methods);

  let allowedHeaders = opts.allowedHeaders
    ? Array.isArray(opts.allowedHeaders)
      ? opts.allowedHeaders.join(",")
      : opts.allowedHeaders
    : undefined;

  if (!allowedHeaders) {
    const requested = req.getHeader("Access-Control-Request-Headers");
    allowedHeaders = requested ?? undefined;
    res.vary("Access-Control-Request-Headers");
  }

  if (allowedHeaders) {
    res.setHeader("Access-Control-Allow-Headers", allowedHeaders);
  }

  if (opts.maxAge != null) {
    res.setHeader("Access-Control-Max-Age", String(opts.maxAge));
  }

  if (opts.preflightContinue) {
    return next();
  }

  res.setHeader("Content-Length", "0");
  return res.status(opts.optionsSuccessStatus).end("");
}

/**
 * Builds a CORS middleware handler. Mirrors the option surface and default
 * behaviour of the `cors` package, including its two call forms:
 *
 * - `cors(options)` — fixed options, merged over the defaults;
 * - `cors(delegate)` — options chosen per request by a
 *   {@link CorsOptionsDelegate}. An error it reports (or throws) is passed to
 *   `next(err)`, so it reaches the router's error handlers.
 */
export function cors(options?: CorsOptions): CorsMiddleware;
/**
 * Builds a CORS middleware whose options a {@link CorsOptionsDelegate} chooses
 * per request. An error it reports (or throws) is passed to `next(err)`.
 */
export function cors(delegate: CorsOptionsDelegate<BunRequest>): CorsMiddleware;
/** Either call form, for a value not known statically to be one or the other. */
export function cors(
  optionsOrDelegate?: CorsOptions | CorsOptionsDelegate<BunRequest>,
): CorsMiddleware;
export function cors(
  options?: CorsOptions | CorsOptionsDelegate<BunRequest>,
): CorsMiddleware {
  if (typeof options === "function") {
    const delegate = options;
    return async (
      req: BunRequest,
      res: BunResponse,
      next: NextFunction,
    ): Promise<unknown> => {
      let chosen: CorsOptions | undefined;
      try {
        chosen = await runDelegate(delegate, req);
      } catch (err) {
        return next(err as Error);
      }
      return applyCors({ ...DEFAULT_OPTIONS, ...chosen }, req, res, next);
    };
  }

  const opts = { ...DEFAULT_OPTIONS, ...options };
  return (
    req: BunRequest,
    res: BunResponse,
    next: NextFunction,
  ): Promise<unknown> => applyCors(opts, req, res, next);
}
