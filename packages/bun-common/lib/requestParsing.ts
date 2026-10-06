import type {
  BunRequest,
  ParseBodyOption,
  QueryParserOpts,
} from "./BunRequest";
import type { RouterHandler } from "./types/general";
import type { CookieParseOptions } from "./utils/native";

/**
 * What {@link requestParsing} sets for the requests it sees. Every field is
 * optional; one left out keeps what the adapter (or an earlier
 * `requestParsing`) set. The names are the adapter's `request` options.
 */
export interface RequestParsingOptions {
  /**
   * Parse the query string into `req.query`. `false` leaves `req.query`
   * empty; `true` re-parses it (with {@link parseQueryOpts} when given).
   */
  parseQuery?: boolean;
  /**
   * Query parser options, merged over the defaults as the adapter's are.
   * Giving them re-parses the query.
   */
  parseQueryOpts?: QueryParserOpts;
  /**
   * Parse the `Cookie` header into `req.cookies`/`req.signedCookies`.
   * `false` leaves both empty; `true` re-parses them.
   */
  parseCookies?: boolean;
  /** Cookie parser options. Giving them re-parses the cookies. */
  cookieParseOptions?: CookieParseOptions;
  /**
   * Secret(s) signed cookies verify with (the first is `req.secret`). Giving
   * them re-parses the cookies.
   */
  cookieSecret?: string | string[];
  /**
   * Body parsing for the route: `false` parses nothing more, `true` parses
   * with no cap, a config object sets caps and an allowlist as the adapter's
   * `parseBody` does. With the adapter's `deferBody`, the body is first read
   * here, under these options — so a route can raise its cap above the
   * adapter's. Without it the body was already read under the adapter's cap;
   * it is checked against this one (413 when over) and parsed again.
   */
  parseBody?: ParseBodyOption;
}

/**
 * Middleware that sets how the request is parsed for the routes it is mounted
 * on — query, cookies and body — and parses it that way before calling
 * `next()`, as body-parser and cookie-parser do. Each request gets its own
 * options; the adapter's, and other requests', are never changed.
 *
 * ```ts
 * const app = new BunHttpAdapter(0, {
 *   request: { parseBody: { maxContentLength: "100kb" }, deferBody: true },
 * });
 * app.use("/upload", requestParsing({ parseBody: { maxContentLength: "20mb" } }));
 * app.use("/webhooks", requestParsing({ parseCookies: false, parseQuery: false }));
 * ```
 *
 * A body over the route's cap, or with an encoding it refuses, is passed to
 * `next(err)` (a 413, 415 or 400 error), so error handlers see it.
 *
 * In NestJS it is ordinary functional middleware:
 * `consumer.apply(requestParsing({ ... })).forRoutes("upload")`.
 *
 * @throws TypeError at creation, for an option of the wrong type.
 */
export function requestParsing(options: RequestParsingOptions): RouterHandler {
  validateOptions(options);
  const {
    parseQuery,
    parseQueryOpts,
    parseCookies,
    cookieParseOptions,
    cookieSecret,
    parseBody,
  } = options;
  const touchesQuery = parseQuery !== undefined || parseQueryOpts !== undefined;
  const touchesCookies =
    parseCookies !== undefined ||
    cookieParseOptions !== undefined ||
    cookieSecret !== undefined;

  return (req, _res, next) => {
    const request = req as BunRequest;
    try {
      if (touchesQuery) {
        applyQuery(request, parseQuery, parseQueryOpts);
      }
      if (touchesCookies) {
        applyCookies(request, parseCookies, cookieParseOptions, cookieSecret);
      }
    } catch (error) {
      next(error as Error);
      return;
    }

    if (parseBody === undefined) {
      next();
      return;
    }
    request.applyParseBodyOptions(parseBody).then(
      () => next(),
      (error: unknown) => next(error as Error),
    );
  };
}

/** Sets and re-runs (or empties) the query parse for one request. */
function applyQuery(
  req: BunRequest,
  parseQuery: boolean | undefined,
  parseQueryOpts: QueryParserOpts | undefined,
): void {
  if (parseQuery === false) {
    req.query = {};
    return;
  }
  if (parseQueryOpts !== undefined) {
    req.setQueryParserOptions(parseQueryOpts);
  }
  req.parseQuery();
}

/** Sets and re-runs (or empties) the cookie parse for one request. */
function applyCookies(
  req: BunRequest,
  parseCookies: boolean | undefined,
  parseOptions: CookieParseOptions | undefined,
  secret: string | string[] | undefined,
): void {
  if (parseOptions !== undefined || secret !== undefined) {
    req.setCookieOptions({ parseOptions, secret });
  }
  if (parseCookies === false) {
    req.cookies = {};
    req.signedCookies = {};
    return;
  }
  const secrets = req.configuredCookieSecrets;
  req.parseCookies({
    forceUpdateRequest: true,
    secret: secrets.length ? [...secrets] : undefined,
  });
}

/** Rejects an option of the wrong type when the middleware is created. */
function validateOptions(options: RequestParsingOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("requestParsing() takes an options object");
  }
  for (const key of ["parseQuery", "parseCookies"] as const) {
    const value = options[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw new TypeError(`requestParsing(): ${key} must be a boolean`);
    }
  }
  for (const key of ["parseQueryOpts", "cookieParseOptions"] as const) {
    const value = options[key];
    if (value !== undefined && (typeof value !== "object" || value === null)) {
      throw new TypeError(`requestParsing(): ${key} must be an object`);
    }
  }
  const { cookieSecret, parseBody } = options;
  if (
    cookieSecret !== undefined &&
    typeof cookieSecret !== "string" &&
    !(
      Array.isArray(cookieSecret) &&
      cookieSecret.every((secret) => typeof secret === "string")
    )
  ) {
    throw new TypeError(
      "requestParsing(): cookieSecret must be a string or an array of strings",
    );
  }
  if (
    parseBody !== undefined &&
    typeof parseBody !== "boolean" &&
    (typeof parseBody !== "object" || parseBody === null)
  ) {
    throw new TypeError(
      "requestParsing(): parseBody must be a boolean or a config object",
    );
  }
}
