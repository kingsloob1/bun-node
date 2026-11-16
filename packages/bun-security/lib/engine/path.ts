/**
 * Layer L6's canonical path (layers.md L6): the one form every path rule
 * matches, so `//admin`, `/a/%2e%2e/admin`, `/a\..\admin` and `/%61dmin`
 * all read as `/admin`.
 *
 * Bun already applies the WHATWG URL parser's normalisation to `req.url`
 * (dot segments, encoded dots, backslashes), measured on raw sockets
 * (`docs/plans/bun-security/evidence/request-shape/`). Two forms reach the
 * app un-normalised: an encoded slash inside a segment, and empty segments.
 * The canonical path is the WHATWG normalisation, then:
 *
 * - percent-escapes of unreserved characters decoded (`%61` is `a`), every
 *   other escape's hex upper-cased (`%2f` is `%2F`);
 * - repeated slashes collapsed (`//admin//x` is `/admin/x`).
 *
 * It keeps case (the policy's `shape.caseSensitive` decides how rules
 * compare) and keeps `%2F`, which L6 refuses rather than decodes. It is
 * idempotent, and agrees with Bun's own normalisation: the canonical path
 * of a raw path equals that of the pathname Bun hands the app.
 */
import { Buffer } from "node:buffer";

/** Whether a byte, as an ASCII code, is unreserved (RFC 3986 §2.3). */
function unreserved(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x2d ||
    code === 0x2e ||
    code === 0x5f ||
    code === 0x7e
  );
}

/** The value of one hex digit, or -1. */
function hex(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}

/**
 * `path` with unreserved escapes decoded, the others' hex upper-cased, and a
 * `%` that starts no escape written `%25`, so that decoding never forms a
 * new escape (`%%61a` is `%25aa`, never `%aa`).
 */
function normaliseEscapes(path: string): string {
  let out = "";
  let from = 0;
  for (let i = path.indexOf("%"); i !== -1; i = path.indexOf("%", i + 1)) {
    out += path.slice(from, i);
    const high = hex(path.charCodeAt(i + 1));
    const low = hex(path.charCodeAt(i + 2));
    if (high === -1 || low === -1) {
      out += "%25";
      from = i + 1;
      continue;
    }
    const code = high * 16 + low;
    out += unreserved(code)
      ? String.fromCharCode(code)
      : path.slice(i, i + 3).toUpperCase();
    from = i + 3;
    i += 2;
  }
  return out + path.slice(from);
}

/** Dot segments resolved as the WHATWG URL parser does (a final one leaves a trailing slash). */
function resolveDots(path: string): string {
  const segments = path.split("/");
  const out: string[] = [];
  // segments[0] is the empty string before the leading slash.
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i] ?? "";
    const last = i === segments.length - 1;
    if (segment === "..") {
      out.pop();
      if (last) out.push("");
    } else if (segment === ".") {
      if (last) out.push("");
    } else {
      out.push(segment);
    }
  }
  return `/${out.join("/")}`;
}

/** The canonical form of a request path (see the module's description). */
export function canonicalPath(raw: string): string {
  let path = raw.includes("\\") ? raw.replaceAll("\\", "/") : raw;
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.includes("%")) path = normaliseEscapes(path);
  if (path.includes("/.")) path = resolveDots(path);
  if (path.includes("//")) path = path.replace(/\/{2,}/g, "/");
  return path;
}

/** Why a raw path is refused (layers.md L6), or `undefined`. */
export type PathProblem =
  "encoded slash" | "encoded backslash" | "NUL" | "invalid UTF-8";

/**
 * What is wrong with a raw path, if anything: an encoded slash (`%2F`) or
 * backslash (`%5C`), which a router may decode after the rules have
 * matched; a NUL; or escapes that are not UTF-8, overlong forms (`%C0%AE`,
 * a `.` in disguise) included.
 */
export function pathProblem(
  raw: string,
  allowEncodedSlash: boolean,
): PathProblem | undefined {
  if (raw.includes("\0")) return "NUL";
  if (!raw.includes("%")) return undefined;
  const upper = raw.toUpperCase();
  if (upper.includes("%00")) return "NUL";
  if (!allowEncodedSlash) {
    if (upper.includes("%2F")) return "encoded slash";
    if (upper.includes("%5C")) return "encoded backslash";
  }
  try {
    // A `%` that starts no escape is kept as text; every escape must be UTF-8.
    decodeURIComponent(raw.replace(/%(?![\da-f]{2})/gi, "%25"));
  } catch {
    return "invalid UTF-8";
  }
  return undefined;
}

/** A query string's size, parameter count and deepest nesting. */
export interface QueryShape {
  /** Its length in bytes. */
  readonly bytes: number;
  /** Its parameters (non-empty `&`-separated parts). */
  readonly params: number;
  /** The deepest key nesting: `a[b][c]` and `a.b.c` are 2. */
  readonly depth: number;
}

/** The shape of a raw query string (without its `?`). */
export function queryShape(query: string): QueryShape {
  let params = 0;
  let depth = 0;
  for (const part of query.split("&")) {
    if (part === "") continue;
    params++;
    const equals = part.indexOf("=");
    let key = equals === -1 ? part : part.slice(0, equals);
    if (key.includes("%")) {
      try {
        key = decodeURIComponent(key.replaceAll("+", " "));
      } catch {
        // An undecodable key counts as written.
      }
    }
    let nesting = 0;
    for (let i = 0; i < key.length; i++) {
      const code = key.charCodeAt(i);
      if (code === 0x5b /* [ */ || code === 0x2e /* . */) nesting++;
    }
    if (nesting > depth) depth = nesting;
  }
  return { bytes: Buffer.byteLength(query), params, depth };
}
