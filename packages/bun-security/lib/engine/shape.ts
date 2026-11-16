/**
 * Layer L6, request shape (layers.md L6): what a request must look like
 * before it is routed, checked on its facts before the body is read.
 *
 * - **Method**: `TRACE` and `CONNECT` always refused; others outside the
 *   policy's `methods` (plus `HEAD` and `OPTIONS`) refused, `405`.
 * - **Path**: an encoded slash or backslash (unless the route opts out), a
 *   NUL, escapes that are not UTF-8 (overlong forms included), `400`; a path
 *   over `maxPathBytes`, `414`.
 * - **Query**: over `maxQueryBytes` (`414`), more than `maxQueryParams`, or
 *   nested deeper than `maxQueryDepth` (`400`).
 * - **Host**: a duplicate `Host` (Bun accepts two lines and joins them with
 *   `, `: `docs/bun-bugs/duplicate-host-accepted.md`), or one outside the
 *   policy's `hosts`, `400`.
 * - **Headers**: more than `maxHeaders`, or a value over its limit, `431`.
 * - **Body**: a `Content-Length` over the route's (or the policy's) limit,
 *   `413`; a media type the route does not accept, `415`.
 */
import { Buffer } from "node:buffer";
import type { CompiledShape, CompiledShapeRoute } from "../policy/compile";
import type { RequestFacts } from "./facts";
import { appliesTo } from "./keys";
import type { RequestRoute } from "./keys";
import { pathProblem, queryShape } from "./path";

/** Why L6 refuses a request. */
export interface ShapeRefusal {
  /** The rule: `shape.method`, `shape.path`, `shape.query`, `shape.host`, `shape.headers`, `shape.body`, `shape.content-type`. */
  readonly rule: string;
  /** The status it answers with. */
  readonly status: number;
  /** Why, for operators; never sent to the client. */
  readonly reason: string;
}

/** Methods refused whatever the policy says. */
const ALWAYS_REFUSED = new Set(["TRACE", "CONNECT"]);

/** Methods every service accepts beside its own. */
const ALWAYS_ACCEPTED = new Set(["HEAD", "OPTIONS"]);

/** The first per-route entry matching the request. */
function routeEntry(
  shape: CompiledShape,
  route: RequestRoute,
): CompiledShapeRoute | undefined {
  for (const entry of shape.routes) {
    if (appliesTo(entry.routes, route)) return entry;
  }
  return undefined;
}

/** Whether a media type is in `accepted` (exact, or `type/*`). */
function accepts(
  accepted: readonly string[],
  header: string | undefined,
): boolean {
  if (header === undefined) return false;
  const media = (header.split(";")[0] ?? "").trim().toLowerCase();
  const slash = media.indexOf("/");
  for (const type of accepted) {
    if (type === media) return true;
    if (
      type.endsWith("/*") &&
      slash !== -1 &&
      type.slice(0, -1) === media.slice(0, slash + 1)
    ) {
      return true;
    }
  }
  return false;
}

/** The method check. */
function checkMethod(
  shape: CompiledShape,
  method: string,
): ShapeRefusal | undefined {
  if (ALWAYS_REFUSED.has(method)) {
    return {
      rule: "shape.method",
      status: 405,
      reason: `method ${method} is always refused`,
    };
  }
  if (
    shape.methods &&
    !shape.methods.has(method) &&
    !ALWAYS_ACCEPTED.has(method)
  ) {
    return {
      rule: "shape.method",
      status: 405,
      reason: `method ${method} is not accepted`,
    };
  }
  return undefined;
}

/** The path and query checks. */
function checkTarget(
  shape: CompiledShape,
  facts: RequestFacts,
  entry: CompiledShapeRoute | undefined,
): ShapeRefusal | undefined {
  const problem = pathProblem(facts.rawPath, entry?.allowEncodedSlash === true);
  if (problem !== undefined) {
    return {
      rule: "shape.path",
      status: 400,
      reason: `the path holds ${problem === "NUL" ? "a NUL" : problem === "invalid UTF-8" ? "escapes that are not UTF-8" : `an ${problem}`}`,
    };
  }
  const pathBytes = Buffer.byteLength(facts.rawPath);
  if (pathBytes > shape.maxPathBytes) {
    return {
      rule: "shape.path",
      status: 414,
      reason: `the path is ${pathBytes} bytes; the limit is ${shape.maxPathBytes}`,
    };
  }
  const query = facts.query;
  if (query === undefined || query === "") return undefined;
  const { bytes, params, depth } = queryShape(query);
  if (bytes > shape.maxQueryBytes) {
    return {
      rule: "shape.query",
      status: 414,
      reason: `the query is ${bytes} bytes; the limit is ${shape.maxQueryBytes}`,
    };
  }
  if (params > shape.maxQueryParams) {
    return {
      rule: "shape.query",
      status: 400,
      reason: `the query has ${params} parameters; the limit is ${shape.maxQueryParams}`,
    };
  }
  if (depth > shape.maxQueryDepth) {
    return {
      rule: "shape.query",
      status: 400,
      reason: `the query nests ${depth} deep; the limit is ${shape.maxQueryDepth}`,
    };
  }
  return undefined;
}

/** The Host and header checks. */
function checkHeaders(
  shape: CompiledShape,
  facts: RequestFacts,
): ShapeRefusal | undefined {
  const host = facts.headers.host;
  if (host !== undefined) {
    if (host.includes(",")) {
      return {
        rule: "shape.host",
        status: 400,
        reason: "duplicate Host header",
      };
    }
    if (shape.hosts && !shape.hosts.has(host.trim().toLowerCase())) {
      return {
        rule: "shape.host",
        status: 400,
        reason: `Host ${JSON.stringify(host.slice(0, 64))} is not one of the service's hosts`,
      };
    }
  }
  const count = facts.headerCount ?? Object.keys(facts.headers).length;
  if (count > shape.maxHeaders) {
    return {
      rule: "shape.headers",
      status: 431,
      reason: `${count} headers; the limit is ${shape.maxHeaders}`,
    };
  }
  const lengths = facts.headerLengths;
  for (const name of Object.keys(facts.headers)) {
    const length = lengths?.[name] ?? facts.headers[name]?.length ?? 0;
    const limit = shape.headerLimits.get(name) ?? shape.maxHeaderBytes;
    if (length > limit) {
      return {
        rule: "shape.headers",
        status: 431,
        reason: `header ${name} is ${length} bytes; the limit is ${limit}`,
      };
    }
  }
  return undefined;
}

/** The body checks, from `Content-Length` and `Content-Type`, before the body is read. */
function checkBody(
  shape: CompiledShape,
  facts: RequestFacts,
  entry: CompiledShapeRoute | undefined,
): ShapeRefusal | undefined {
  const limit = entry?.maxBodySize ?? shape.maxBodySize;
  const length = facts.contentLength;
  if (limit !== undefined && length !== undefined && length > limit) {
    return {
      rule: "shape.body",
      status: 413,
      reason: `Content-Length ${length}; the limit is ${limit}`,
    };
  }
  const hasBody =
    (length !== undefined && length > 0) ||
    facts.headers["transfer-encoding"] !== undefined;
  if (
    entry?.contentTypes &&
    hasBody &&
    !accepts(entry.contentTypes, facts.headers["content-type"])
  ) {
    return {
      rule: "shape.content-type",
      status: 415,
      reason: `Content-Type ${JSON.stringify((facts.headers["content-type"] ?? "(none)").slice(0, 64))} is not accepted here`,
    };
  }
  return undefined;
}

/** Why L6 refuses the request, or `undefined` when its shape is acceptable. */
export function checkShape(
  shape: CompiledShape,
  facts: RequestFacts,
  route: RequestRoute,
): ShapeRefusal | undefined {
  const entry =
    shape.routes.length === 0 ? undefined : routeEntry(shape, route);
  return (
    checkMethod(shape, facts.method) ??
    checkTarget(shape, facts, entry) ??
    checkHeaders(shape, facts) ??
    checkBody(shape, facts, entry)
  );
}
