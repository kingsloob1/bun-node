/**
 * Capturing a response as the handler produced it, shared by
 * `cacheResponse()` and `coalesceRequests()`: the headers set before the
 * middleware ran, the body's bytes from a response transform registered
 * first (bun-common's `addResponseTransform(t, { first: true })`, plan
 * §9.7), and the 304 a conditional request is owed once the full response
 * has been captured.
 */
import type {
  BunRequest,
  BunResponse,
  BunResponseTransformContext,
} from "@kingsleyweb/bun-common";
import { fresh } from "@kingsleyweb/bun-common";
import type { PresetHeaders } from "./policy";

/** The statuses whose body bun-common drops (and so never hands a transform). */
const BODILESS = new Set([204, 205, 304]);

/** The fields a 304 drops, as bun-common's own 304 does (RFC 9110 §15.4.5 keeps the rest). */
const NOT_MODIFIED_DROPS = [
  "content-type",
  "content-length",
  "transfer-encoding",
  "content-encoding",
];

/** The headers `res` holds before the middleware hands on: those set by middleware ahead of it. */
export function snapshotHeaders(res: BunResponse): PresetHeaders {
  const preset = new Map<string, string | readonly string[]>();
  for (const [name, value] of Object.entries(res.getHeaders())) {
    if (value !== undefined) {
      preset.set(name, value);
    }
  }
  return preset;
}

/**
 * For a conditional request (`If-None-Match`, `If-Modified-Since`), makes
 * `req.fresh` read `false` for the rest of the request, so the handler
 * produces the full response the cache needs instead of bun-common's 304;
 * {@link answerConditional} then answers the 304 from what was captured.
 * Varnish strips a client's conditional headers on a miss the same way.
 * Answers whether the request was conditional.
 */
export function maskConditional(req: BunRequest): boolean {
  if (
    req.getHeader("if-none-match") === null &&
    req.getHeader("if-modified-since") === null
  ) {
    return false;
  }
  Object.defineProperty(req, "fresh", {
    configurable: true,
    enumerable: false,
    get: () => false,
  });
  return true;
}

/**
 * The 304 a conditional request is owed for `response` (RFC 9110 §13.1.1,
 * §13.1.3, through bun-common's `fresh()`), or `response` itself when the
 * request's validators do not match or the status is not 2xx.
 */
export function answerConditional(
  req: BunRequest,
  response: Response,
): Response {
  if (response.status < 200 || response.status > 299) {
    return response;
  }
  const isFresh = fresh(
    {
      "if-none-match": req.getHeader("if-none-match") ?? undefined,
      "if-modified-since": req.getHeader("if-modified-since") ?? undefined,
      "cache-control": req.getHeader("cache-control") ?? undefined,
    },
    {
      etag: response.headers.get("etag") ?? undefined,
      "last-modified": response.headers.get("last-modified") ?? undefined,
    },
  );
  if (!isFresh) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const name of NOT_MODIFIED_DROPS) {
    headers.delete(name);
  }
  return new Response(null, { status: 304, headers });
}

/**
 * The body's bytes, from what the transform was told: a copy of buffered
 * text or bytes now, a `Blob`'s bytes later, empty for a body-less status or
 * no body. `undefined` for a stream (or a body a transform ahead of this one
 * replaced): there is nothing buffered to keep.
 */
export function captureBody(
  response: Response,
  context: BunResponseTransformContext,
): Uint8Array | Promise<Uint8Array> | undefined {
  if (BODILESS.has(response.status)) {
    return new Uint8Array(0);
  }
  const body = context.body;
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(
      body.buffer,
      body.byteOffset,
      body.byteLength,
    ).slice();
  }
  if (body instanceof Blob) {
    return body.bytes();
  }
  if (body !== undefined) {
    // An ArrayBuffer or SharedArrayBuffer.
    return new Uint8Array(body).slice();
  }
  // Read `body` only now: on a buffered response it would make Bun wrap the
  // bytes in a stream, and every buffered case returned above.
  return response.body === null ? new Uint8Array(0) : undefined;
}

/**
 * `response` with `name` set to `value`. A `Response`'s headers can be
 * immutable (`Response.redirect`); then it is rebuilt around the same body.
 */
export function withHeader(
  response: Response,
  name: string,
  value: string,
): Response {
  try {
    response.headers.set(name, value);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set(name, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
