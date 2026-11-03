/**
 * Headers as the generator reads them (typed-client plan §5.6): the headers a
 * response declares (`responses.<status>.headers`), and which header schemas
 * a header's value can satisfy as it is, a string.
 *
 * A header crosses as a string whatever its schema says: a server that
 * declares `z.coerce.number()` documents `{ type: "number" }`, and the value
 * that arrives (or that a client sends) is `"42"`. So a header whose schema
 * describes strings (`type: "string"`, a string `enum` or `const`) is typed
 * and checked by its schema, and any other is typed and checked as a
 * string: looser than the document, never stricter.
 */
import { isRecord, resolvePointer } from "./schema";

/** One header a response declares. */
export interface DeclaredHeader {
  /** Its name, lower-cased (as `Headers` reads it). */
  readonly name: string;
  /** Whether the response always carries it (OpenAPI's `required`; default `false`). */
  readonly required: boolean;
  /** Its schema (`schema`, or the first `content` entry's), `$ref`s not yet followed. */
  readonly schema: unknown;
  /** Its description, for the JSDoc. */
  readonly description?: string;
}

/**
 * Response headers the client never checks: `content-type` (OpenAPI says a
 * response's `Content-Type` header is ignored; the media type says it) and
 * `set-cookie` (a browser never exposes it to a page).
 */
const UNCHECKED = new Set(["content-type", "set-cookie"]);

/** `value`, or what its `$ref`s lead to; `undefined` for a chain too long or broken. */
function deref(document: unknown, value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 32; depth++) {
    if (!isRecord(current) || typeof current.$ref !== "string") return current;
    current = resolvePointer(document, current.$ref);
  }
  return undefined;
}

/**
 * The headers one response object declares, in the document's order, the
 * first spelling of a name winning; `content-type` and `set-cookie` left
 * out (see {@link UNCHECKED}).
 *
 * @param document The OpenAPI document, for `$ref`s.
 * @param response The response object (or its `$ref`).
 */
export function declaredHeaders(
  document: unknown,
  response: unknown,
): DeclaredHeader[] {
  const resolved = deref(document, response);
  if (!isRecord(resolved) || !isRecord(resolved.headers)) return [];
  const out: DeclaredHeader[] = [];
  const seen = new Set<string>();
  for (const [raw, value] of Object.entries(resolved.headers)) {
    const name = raw.toLowerCase();
    if (UNCHECKED.has(name) || seen.has(name)) continue;
    const header = deref(document, value);
    if (!isRecord(header)) continue;
    seen.add(name);
    let schema: unknown = header.schema;
    if (schema === undefined && isRecord(header.content)) {
      const first = Object.values(header.content)[0];
      if (isRecord(first)) schema = first.schema;
    }
    out.push({
      name,
      required: header.required === true,
      schema,
      ...(typeof header.description === "string" && header.description.trim()
        ? { description: header.description.trim() }
        : {}),
    });
  }
  return out;
}

/**
 * Whether a header's schema describes strings, so the header's value, a
 * string, can be typed and checked by it: `type: "string"`, a string
 * `enum` or `const`, or a `$ref`, `allOf` member, `oneOf` or `anyOf` of
 * those. A schema that says nothing of the type (`{}`) does not.
 *
 * @param document The OpenAPI document, for `$ref`s.
 * @param schema The header's schema.
 */
export function isStringSchema(document: unknown, schema: unknown): boolean {
  const seen = new Set<unknown>();
  const check = (value: unknown): boolean => {
    const resolved = deref(document, value);
    if (!isRecord(resolved) || seen.has(resolved)) return false;
    seen.add(resolved);
    if ("const" in resolved) return typeof resolved.const === "string";
    if (Array.isArray(resolved.enum))
      return (
        resolved.enum.length > 0 &&
        resolved.enum.every((item) => typeof item === "string")
      );
    if (resolved.type === "string") return true;
    if (resolved.type !== undefined) return false;
    for (const name of ["oneOf", "anyOf"] as const) {
      const members = resolved[name];
      if (Array.isArray(members))
        return members.length > 0 && members.every(check);
    }
    if (Array.isArray(resolved.allOf)) return resolved.allOf.some(check);
    return false;
  };
  return check(schema);
}
