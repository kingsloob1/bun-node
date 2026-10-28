/**
 * Cache keys for the method decorators (plan §10.2): positional templates
 * (`"orgs:{0}:page:{1.page}"`) and the default key, `ClassName.method:` plus a
 * stable hash of the arguments.
 *
 * Imports nothing from `@kingsleyweb/bun-cache`.
 */
import { Buffer } from "node:buffer";

/** One piece of a parsed template: literal text, or an argument path. */
type TemplatePart =
  | { kind: "text"; text: string }
  | {
      kind: "arg";
      /** The argument's position. */
      index: number;
      /** Property names to follow from the argument (`{1.page}` → `["page"]`). */
      path: readonly string[];
      /** The placeholder as written, for messages. */
      source: string;
    };

/** A template compiled once, at decoration: builds the key from a call's arguments. */
export type KeyTemplate = (args: readonly unknown[], method: string) => string;

const PLACEHOLDER = /^(\d+)((?:\.[\w$]+)*)$/;

/**
 * Compiles a key template. Placeholders are positional, `{0}` or
 * `{1.page.size}` (parameter names are not reliably available at run time,
 * so `{id}` is refused); `{{` and `}}` write a literal brace. A malformed
 * template throws here, at decoration; a placeholder out of range throws on
 * the call that reaches it.
 */
export function compileKeyTemplate(
  template: string,
  method: string,
): KeyTemplate {
  const parts: TemplatePart[] = [];
  let text = "";
  for (let i = 0; i < template.length; i++) {
    const char = template[i];
    if (char === "{" && template[i + 1] === "{") {
      text += "{";
      i++;
      continue;
    }
    if (char === "}" && template[i + 1] === "}") {
      text += "}";
      i++;
      continue;
    }
    if (char === "}") {
      throw new TypeError(
        `${method}: the key template "${template}" has an unmatched "}" at ${i}; write "}}" for a literal brace`,
      );
    }
    if (char !== "{") {
      text += char;
      continue;
    }
    const end = template.indexOf("}", i + 1);
    if (end === -1) {
      throw new TypeError(
        `${method}: the key template "${template}" has an unclosed "{" at ${i}`,
      );
    }
    const inner = template.slice(i + 1, end);
    const match = PLACEHOLDER.exec(inner);
    if (!match) {
      throw new TypeError(
        `${method}: the key template "${template}" has the placeholder "{${inner}}"; placeholders are positional, as {0} or {1.page} (parameter names are not available at run time), or pass a key function`,
      );
    }
    if (text !== "") {
      parts.push({ kind: "text", text });
      text = "";
    }
    parts.push({
      kind: "arg",
      index: Number(match[1]),
      path: match[2] === "" ? [] : match[2].slice(1).split("."),
      source: `{${inner}}`,
    });
    i = end;
  }
  if (text !== "") {
    parts.push({ kind: "text", text });
  }

  return (args, at) => {
    let key = "";
    for (const part of parts) {
      if (part.kind === "text") {
        key += part.text;
        continue;
      }
      if (part.index >= args.length) {
        throw new RangeError(
          `${at}: the key template "${template}" reads ${part.source}, but the call passed ${args.length} argument${args.length === 1 ? "" : "s"}`,
        );
      }
      let value: unknown = args[part.index];
      for (const name of part.path) {
        if (value === null || value === undefined) {
          break;
        }
        value = (value as Record<string, unknown>)[name];
      }
      key += placeholderText(value, template, part.source, at);
    }
    return key;
  };
}

/**
 * How a placeholder's value is written into a key: a string as it is, a
 * number, bigint or boolean through `String`, `null` as `"null"`, a `Date`
 * as its ISO string. Anything else throws: `undefined` (a missing argument or
 * property would make every such call share one key), and objects, arrays,
 * functions and symbols (`"[object Object]"` would do the same).
 */
function placeholderText(
  value: unknown,
  template: string,
  source: string,
  at: string,
): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    case "undefined":
      throw new TypeError(
        `${at}: the key template "${template}" reads ${source}, which is undefined on this call; a missing value would give every such call the same key`,
      );
    default:
      if (value === null) {
        return "null";
      }
      if (value instanceof Date) {
        return value.toISOString();
      }
      throw new TypeError(
        `${at}: the key template "${template}" reads ${source}, which is ${Array.isArray(value) ? "an array" : typeof value === "object" ? "an object" : `a ${typeof value}`}; read one of its properties ({0.id}) or pass a key function`,
      );
  }
}

/**
 * The default key: `ClassName.method:` plus the SHA-256 (base64url) of a
 * stable serialisation of the arguments.
 *
 * Stable means plain objects' keys are sorted, so `{ a, b }` and `{ b, a }`
 * share a key. A `Map` and a `Set` are written in insertion order, which is
 * **not** stable: two equal maps built in different orders get different
 * keys (plan §10.2's documented rule — pass `key` when arguments are
 * objects). A cycle throws.
 */
export function defaultKey(prefix: string, args: readonly unknown[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(stableSerialize(args, new Set()));
  return `${prefix}:${hasher.digest("base64url")}`;
}

/**
 * A deterministic text for a value, tagging each kind so `1`, `"1"` and
 * `1n` stay distinct.
 */
export function stableSerialize(value: unknown, seen: Set<object>): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      // `JSON.stringify` writes NaN and the infinities as null; keep them apart.
      return Number.isFinite(value) ? String(value) : `#${String(value)}`;
    case "bigint":
      return `${value}n`;
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
      return "undefined";
    case "symbol":
      return `symbol(${value.description ?? ""})`;
    case "function":
      return `function(${value.name})`;
    default:
      break;
  }
  if (value === null) {
    return "null";
  }
  const object = value as object;
  if (seen.has(object)) {
    throw new TypeError(
      "the default cache key cannot serialise a cyclic argument; pass a key",
    );
  }
  seen.add(object);
  try {
    if (object instanceof Date) {
      return `Date(${Number.isNaN(object.getTime()) ? "invalid" : object.toISOString()})`;
    }
    if (object instanceof RegExp) {
      return `RegExp(${object.toString()})`;
    }
    if (Array.isArray(object)) {
      return `[${object.map((item: unknown) => stableSerialize(item, seen)).join(",")}]`;
    }
    if (object instanceof Map) {
      const entries: string[] = [];
      for (const [k, v] of object) {
        entries.push(
          `${stableSerialize(k, seen)}=>${stableSerialize(v, seen)}`,
        );
      }
      return `Map{${entries.join(",")}}`;
    }
    if (object instanceof Set) {
      const items: string[] = [];
      for (const item of object) {
        items.push(stableSerialize(item, seen));
      }
      return `Set{${items.join(",")}}`;
    }
    if (ArrayBuffer.isView(object)) {
      const bytes = new Uint8Array(
        object.buffer,
        object.byteOffset,
        object.byteLength,
      );
      return `${object.constructor.name}(${Buffer.from(bytes).toString("base64")})`;
    }
    const record = object as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableSerialize(record[k], seen)}`)
      .join(",");
    return `{${body}}`;
  } finally {
    seen.delete(object);
  }
}
