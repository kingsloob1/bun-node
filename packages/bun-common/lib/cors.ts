/**
 * Native CORS middleware — a dependency-free replacement for the `cors`
 * package, implemented directly against {@link BunRequest}/{@link BunResponse}.
 */
import type { BunRequest } from "./BunRequest";
import type { BunResponse } from "./BunResponse";
import type { NextFunction } from "./types/general";

export type CorsOrigin =
  | boolean
  | string
  | RegExp
  | (string | RegExp)[]
  | ((
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => void);

export interface CorsOptions {
  origin?: CorsOrigin;
  methods?: string | string[];
  allowedHeaders?: string | string[];
  exposedHeaders?: string | string[];
  credentials?: boolean;
  maxAge?: number;
  preflightContinue?: boolean;
  optionsSuccessStatus?: number;
}

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
  allowed: string | RegExp | (string | RegExp)[],
): boolean {
  if (Array.isArray(allowed)) {
    return allowed.some((entry) => isOriginAllowed(origin, entry));
  }
  if (allowed instanceof RegExp) {
    return origin != null && allowed.test(origin);
  }
  return allowed === "*" || allowed === origin;
}

function resolveOrigin(
  origin: CorsOrigin,
  requestOrigin: string | undefined,
): Promise<string | false> {
  return new Promise((resolve, reject) => {
    if (typeof origin === "function") {
      origin(requestOrigin, (err, allow) => {
        if (err) {
          reject(err);
        } else {
          resolve(allow ? (requestOrigin ?? "*") : false);
        }
      });
      return;
    }

    if (origin === true) {
      resolve(requestOrigin ?? "*");
    } else if (origin === false) {
      resolve(false);
    } else if (typeof origin === "string") {
      resolve(origin);
    } else if (isOriginAllowed(requestOrigin, origin)) {
      resolve(requestOrigin ?? false);
    } else {
      resolve(false);
    }
  });
}

/**
 * Builds a CORS middleware handler. Mirrors the option surface and default
 * behaviour of the `cors` package.
 */
export function cors(options?: CorsOptions) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return async (
    req: BunRequest,
    res: BunResponse,
    next: NextFunction,
  ): Promise<unknown> => {
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
  };
}
