/**
 * The query serialiser: the inverse of bun-common's parser, picoquery with
 * `nesting: true`, `nestingSyntax: "js"`, `arrayRepeat: true` and
 * `arrayRepeatSyntax: "repeat"` (`DEFAULT_PARSE_QUERY_OPTS`,
 * `bun-common/lib/BunRequest.ts`; typed-client plan §6.1).
 *
 * - An object nests with dots: `{ a: { b: 1 } }` → `a.b=1`.
 * - An array of two or more scalars repeats its key: `{ t: ["x", "y"] }` →
 *   `t=x&t=y`, which the parser collapses back into an array.
 * - Any other array is indexed, `t[0]=x`, so that it still arrives as an
 *   array: a repeated key written once parses as a scalar, and an object
 *   can only sit in an array by index.
 * - `null` and `undefined` are skipped (a key, an element, a property), so an
 *   array's later elements move down. An empty array or object writes nothing.
 * - A scalar is written as `String(value)`; a `Date` as its ISO string, as
 *   JSON would. The server receives strings; its schema coerces them.
 * - Keys are percent-encoded, `.` included, so a key holding `.`, `[` or `]`
 *   arrives as one key. `__proto__`, `constructor` and `prototype`, which the
 *   parser refuses to nest, are skipped.
 *
 * `__tests__/querystring.test.ts` runs every shape through a real `router.fetch()`
 * and compares `req.query`, so a drift from the parser fails there.
 */

/** Keys the parser will not nest into (prototype pollution guard); never written. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** `encodeURIComponent`, plus `.` (picoquery's nesting separator in a raw key). */
function encodeKey(key: string): string {
  return encodeURIComponent(key).replace(/\./g, "%2E");
}

/** A leaf as the wire writes it; `undefined` when it is not a leaf. */
function leaf(value: unknown): string | undefined {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

/** Writes `value` under the already-encoded `path` into `out`. */
function append(out: string[], path: string, value: unknown): void {
  if (value === undefined || value === null) return;
  const scalar = leaf(value);
  if (scalar !== undefined) {
    out.push(`${path}=${encodeURIComponent(scalar)}`);
    return;
  }
  if (Array.isArray(value)) {
    const items = value.filter((item) => item !== undefined && item !== null);
    const allScalars = items.every((item) => leaf(item) !== undefined);
    if (allScalars && items.length > 1) {
      for (const item of items) append(out, path, item);
    } else {
      items.forEach((item, index) => append(out, `${path}[${index}]`, item));
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key) || key === "") continue;
      append(out, `${path}.${encodeKey(key)}`, child);
    }
  }
}

/**
 * A query object as a query string, without the leading `?`; `""` when it
 * writes nothing.
 */
export function serializeQuery(query: unknown): string {
  if (query === null || typeof query !== "object") return "";
  const out: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (UNSAFE_KEYS.has(key) || key === "") continue;
    append(out, encodeKey(key), value);
  }
  return out.join("&");
}
