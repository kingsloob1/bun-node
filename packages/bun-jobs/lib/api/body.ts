import type { RouterHandler } from "@kingsleyweb/bun-common";
import { PayloadTooLargeError } from "@kingsleyweb/bun-common";
import { mediaTypeOf } from "./auth";
import { ApiError } from "./errors";

/**
 * Tells a malformed JSON body apart from a missing one.
 *
 * bun-common's body parser swallows a JSON syntax error: the request carries
 * its raw bytes but `req.body` stays `undefined`, exactly as it does for no
 * body at all. A body schema then reports "Required", which sends a client
 * looking for a field it did send. This guard looks at the raw bytes the
 * parser kept and answers 400 `INVALID_JSON` instead — without re-parsing, and
 * without changing bun-common.
 */

/** The 413 for a body over a route's own cap. */
function tooLarge(limit: number): ApiError {
  return new ApiError(
    "PAYLOAD_TOO_LARGE",
    413,
    `The request body exceeds ${limit} bytes`,
    { context: { limit } },
  );
}

/**
 * A router handler refusing a body whose declared `Content-Length` is over
 * `limit`, with 413 `PAYLOAD_TOO_LARGE`, without reading or parsing it.
 *
 * This is the one check that answers before `authorize`, so an unauthenticated
 * client cannot make the process buffer an arbitrarily large body: the refusal
 * is the same for every route and reveals nothing but the cap. A body that
 * lies about its length is caught after authorization by
 * {@link bodySizeGuard}.
 */
export function declaredBodySizeGuard(limit: number): RouterHandler {
  return (req, _res, next) => {
    const declared = Number(req.getHeader("content-length") ?? Number.NaN);
    return Number.isFinite(declared) && declared > limit
      ? next(tooLarge(limit))
      : next();
  };
}

/**
 * A router handler refusing a body larger than `limit` bytes with 413
 * `PAYLOAD_TOO_LARGE`: by its declared `Content-Length` first, so an honest
 * oversized request is refused unread, then by the bytes actually read.
 */
export function bodySizeGuard(limit: number): RouterHandler {
  return async (req, _res, next) => {
    const declared = Number(req.getHeader("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > limit) {
      return next(tooLarge(limit));
    }
    if (!req.isBodyParsed) {
      try {
        await req.parseBody();
      } catch (error) {
        return error instanceof PayloadTooLargeError ? next(error) : next();
      }
    }
    const raw = req.buffer;
    return raw !== undefined && raw.length > limit
      ? next(tooLarge(limit))
      : next();
  };
}

/**
 * A router handler giving a request with no body an empty object, so an
 * optional body's schema applies its defaults instead of reporting it missing.
 * Runs after {@link jsonBodyGuard}: a malformed body is still refused.
 */
export function emptyBodyAsObject(): RouterHandler {
  return (req, _res, next) => {
    if (req.body === undefined) {
      req.body = {};
    }
    return next();
  };
}

/**
 * A router handler refusing a request that declares `application/json` and
 * carries a non-blank body bun-common could not parse. A blank body passes
 * (and is left for the body schema to call missing), as does any other media
 * type (the CSRF guard answers those on mutations).
 */
export function jsonBodyGuard(): RouterHandler {
  return async (req, _res, next) => {
    if (mediaTypeOf(req.getHeader("content-type")) !== "application/json") {
      return next();
    }
    if (!req.isBodyParsed) {
      try {
        await req.parseBody();
      } catch (error) {
        // A body over the cap is still that problem; anything else the parser
        // throws means there was no body to read, which is not ours to judge.
        return error instanceof PayloadTooLargeError ? next(error) : next();
      }
    }
    const raw = req.buffer;
    if (
      req.body === undefined &&
      raw !== undefined &&
      raw.length > 0 &&
      raw.toString().trim() !== ""
    ) {
      return next(
        new ApiError("INVALID_JSON", 400, "The request body is not valid JSON"),
      );
    }
    return next();
  };
}
