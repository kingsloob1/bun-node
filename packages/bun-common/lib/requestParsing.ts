import type {
  BunRequest,
  ParseBodyOption,
  ParseCookiesConfig,
  ParseCookiesOption,
  ParseQueryOption,
} from "./BunRequest";
import type { RouterHandler } from "./types/general";
import { validateParseBodyOption } from "./BunRequest";

/**
 * What {@link requestParsing} sets for the requests it sees. Every field is
 * optional; one left out keeps what the adapter (or an earlier
 * `requestParsing`) set. The names are the adapter's `request` options.
 */
export interface RequestParsingOptions {
  /**
   * Query parsing for the route: `false` leaves `req.query` empty, `true`
   * parses it again with the defaults, a `QueryParserOpts` object parses
   * it again with those options (merged over the defaults).
   */
  parseQuery?: ParseQueryOption;
  /**
   * Cookie parsing for the route: `false` leaves `req.cookies` and
   * `req.signedCookies` empty, `true` parses them again with no secret and the
   * standard decoding, a {@link ParseCookiesConfig} object parses them again
   * with its `secret` (`req.secret` becomes the first) and `decode`.
   */
  parseCookies?: ParseCookiesOption;
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
 * app.use("/account", requestParsing({ parseCookies: { secret: ["new", "old"] } }));
 * app.use("/search", requestParsing({ parseQuery: { nesting: false } }));
 * app.use("/webhooks", requestParsing({ parseCookies: false, parseQuery: false }));
 * ```
 *
 * A body over the route's cap, or with an encoding it refuses, is passed to
 * `next(err)` (a 413, 415 or 400 error), so error handlers see it.
 *
 * In NestJS it is ordinary functional middleware:
 * `consumer.apply(requestParsing({ ... })).forRoutes("upload")`.
 *
 * @throws TypeError at creation, for an option of the wrong type, and
 * RangeError or TypeError for an invalid `parseBody` size or decoding option.
 */
export function requestParsing(options: RequestParsingOptions): RouterHandler {
  validateOptions(options);
  const { parseQuery, parseCookies, parseBody } = options;
  // Sizes and decoding options fail here, at creation, not per request.
  validateParseBodyOption(parseBody);

  return (req, _res, next) => {
    const request = req as BunRequest;
    try {
      if (parseQuery !== undefined) {
        applyQuery(request, parseQuery);
      }
      if (parseCookies !== undefined) {
        applyCookies(request, parseCookies);
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
function applyQuery(req: BunRequest, parseQuery: ParseQueryOption): void {
  if (parseQuery === false) {
    req.query = {};
    return;
  }
  // `true` re-parses with the defaults, an object with its options.
  req.setQueryParserOptions(parseQuery === true ? {} : parseQuery);
  req.parseQuery();
}

/** Sets and re-runs (or empties) the cookie parse for one request. */
function applyCookies(req: BunRequest, parseCookies: ParseCookiesOption): void {
  if (parseCookies === false) {
    req.cookies = {};
    req.signedCookies = {};
    return;
  }
  // `true` means no secret and the standard decoding, for this route.
  const config: ParseCookiesConfig = parseCookies === true ? {} : parseCookies;
  req.setCookieOptions({
    parseOptions: { decode: config.decode },
    secret: config.secret ?? [],
  });
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
  for (const key of ["parseQuery", "parseCookies", "parseBody"] as const) {
    const value: unknown = options[key];
    if (
      value !== undefined &&
      typeof value !== "boolean" &&
      (typeof value !== "object" || value === null || Array.isArray(value))
    ) {
      throw new TypeError(
        `requestParsing(): ${key} must be a boolean or an options object`,
      );
    }
  }
  for (const key of ["parseQueryOpts", "cookieParseOptions", "cookieSecret"]) {
    if (key in options) {
      throw new TypeError(
        `requestParsing(): ${key} is not an option here; use ${
          key === "parseQueryOpts" ? "parseQuery: { … }" : "parseCookies: { … }"
        }`,
      );
    }
  }
  const cookies = options.parseCookies;
  if (typeof cookies === "object" && cookies !== null) {
    const { secret, decode } = cookies;
    if (
      secret !== undefined &&
      typeof secret !== "string" &&
      !(
        Array.isArray(secret) &&
        secret.every((entry) => typeof entry === "string")
      )
    ) {
      throw new TypeError(
        "requestParsing(): parseCookies.secret must be a string or an array of strings",
      );
    }
    if (decode !== undefined && typeof decode !== "function") {
      throw new TypeError(
        "requestParsing(): parseCookies.decode must be a function",
      );
    }
  }
}
