/**
 * JSON Schema to TypeScript (typed-client plan §3.2, §4.1): the schemas of an
 * OpenAPI 3.1 document (JSON Schema 2020-12), and OpenAPI 3.0's `nullable`,
 * as {@link TsType}s.
 *
 * The documents' schemas are already the **wire** side (bun-common converts
 * request and response schemas from the input side, plan §4.1), so a schema
 * types what crosses as it is: no input/output choice is made here.
 *
 * - A `$ref` to `#/components/schemas/<name>` is that component's named type,
 *   which is what makes recursion work: a recursive schema refers to its own
 *   name. Any other local pointer is resolved and inlined; one that leads
 *   back into itself is `unknown`, with a warning.
 * - Keywords that change what a value may be and that TypeScript cannot say
 *   (`not`, `if`/`then`/`else`, `dependentSchemas`, `unevaluatedProperties`,
 *   `unevaluatedItems`, `$dynamicRef`, `$recursiveRef`) make their schema
 *   `unknown`, with a warning: never a type that is silently wrong.
 * - Validation keywords (lengths, ranges, `pattern`, `format`, `multipleOf`,
 *   `uniqueItems`, `contains`, `minProperties`, `dependentRequired`,
 *   `propertyNames`, …) and annotations (`title`, `default`, `examples`,
 *   `readOnly`, `writeOnly`, …) do not change the type and are ignored;
 *   `description` and `deprecated` become JSDoc.
 */
import type { TsMember, TsType } from "./print";
import { intersection, keyword, union, UNKNOWN } from "./print";

/** Where component schemas live in an OpenAPI document. */
export const COMPONENT_PREFIX = "#/components/schemas/";

/** What converting a schema needs from the document around it. */
export interface SchemaContext {
  /** The whole document, for resolving `$ref` pointers. */
  readonly document: unknown;
  /** The identifier a component is emitted under, by its name in `components.schemas`; `undefined` when there is none. */
  readonly componentType: (name: string) => string | undefined;
  /** Records a warning, at a place in the document. */
  readonly warn: (at: string, message: string) => void;
}

/** Keywords that change the type in a way TypeScript cannot express. */
const INEXPRESSIBLE = [
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "unevaluatedProperties",
  "unevaluatedItems",
  "$dynamicRef",
  "$recursiveRef",
] as const;

/** Whether `value` is a plain JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decodes one JSON Pointer segment (`~1` is `/`, `~0` is `~`). */
function decodeSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/**
 * Resolves a local `$ref` (`#/a/b`) in `document`; `undefined` when it does
 * not resolve. Percent-encoding is decoded, as JSON Pointer fragments are.
 */
export function resolvePointer(document: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined;
  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) return undefined;
  let current: unknown = document;
  for (const raw of pointer.slice(1).split("/")) {
    const key = decodeSegment(raw);
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (isRecord(current) && Object.hasOwn(current, key)) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/** The component name a `$ref` names directly (`#/components/schemas/User`), else `undefined`. */
export function componentOf(ref: string): string | undefined {
  if (!ref.startsWith(COMPONENT_PREFIX)) return undefined;
  const rest = ref.slice(COMPONENT_PREFIX.length);
  if (rest === "" || rest.includes("/")) return undefined;
  try {
    return decodeSegment(decodeURIComponent(rest));
  } catch {
    return undefined;
  }
}

/** The type of a JSON value as a literal type: `"a"`, `1`, `[1, "a"]`, `{ a: 1 }`. */
export function valueType(value: unknown): TsType {
  if (value === null) return keyword("null");
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return { kind: "literal", value };
  if (Array.isArray(value))
    return { kind: "tuple", elements: value.map(valueType) };
  if (isRecord(value)) {
    return {
      kind: "object",
      members: Object.entries(value).map(([name, child]) => ({
        name,
        optional: false,
        type: valueType(child),
      })),
    };
  }
  return UNKNOWN;
}

/** A schema's `description` and `deprecated`, as JSDoc text; `undefined` when it has neither. */
export function schemaDoc(schema: unknown): string | undefined {
  if (!isRecord(schema)) return undefined;
  const parts: string[] = [];
  if (typeof schema.description === "string" && schema.description.trim())
    parts.push(schema.description.trim());
  if (schema.deprecated === true) parts.push("@deprecated");
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

/** One converter run: the context and the pointers being inlined (the recursion guard). */
interface Walk {
  /** The document and the callbacks. */
  readonly context: SchemaContext;
  /** The non-component pointers being resolved, outermost first. */
  readonly inlining: readonly string[];
}

/**
 * A schema's TypeScript type.
 *
 * @param schema The JSON Schema (an object, or `true`/`false`).
 * @param context The document and its callbacks.
 * @param at Where the schema sits, for warnings (`"GET /users/:id response 200"`).
 */
export function schemaToType(
  schema: unknown,
  context: SchemaContext,
  at: string,
): TsType {
  return convert(schema, { context, inlining: [] }, at);
}

/** {@link schemaToType}, with the recursion guard. */
function convert(schema: unknown, walk: Walk, at: string): TsType {
  if (schema === true || schema === undefined) return UNKNOWN;
  if (schema === false) return keyword("never");
  if (!isRecord(schema)) {
    walk.context.warn(at, "not a JSON Schema; typed `unknown`");
    return UNKNOWN;
  }

  // `not: {}` (or `not: true`) matches nothing: zod's `z.never()`.
  if (
    "not" in schema &&
    (schema.not === true ||
      (isRecord(schema.not) && Object.keys(schema.not).length === 0))
  ) {
    return keyword("never");
  }
  const inexpressible = INEXPRESSIBLE.filter((name) => name in schema);
  if (inexpressible.length > 0) {
    walk.context.warn(
      at,
      `${inexpressible.map((name) => `\`${name}\``).join(", ")} cannot be expressed in TypeScript; typed \`unknown\``,
    );
    return UNKNOWN;
  }

  const parts: TsType[] = [];

  if (typeof schema.$ref === "string") {
    parts.push(convertRef(schema.$ref, walk, at));
  } else if ("$ref" in schema) {
    walk.context.warn(at, "`$ref` is not a string; typed `unknown`");
    return UNKNOWN;
  }

  const base = convertBase(schema, walk, at);
  const composed =
    typeof schema.$ref === "string" ||
    Array.isArray(schema.allOf) ||
    Array.isArray(schema.oneOf) ||
    Array.isArray(schema.anyOf);
  // A bare `type: "object"` beside a `$ref` or a composition says only
  // "an object", which the composed members already say.
  if (base !== undefined && !(composed && isAnyObject(base))) parts.push(base);

  if (Array.isArray(schema.allOf)) {
    schema.allOf.forEach((member, index) => {
      parts.push(convert(member, walk, `${at} allOf[${index}]`));
    });
  }
  for (const name of ["oneOf", "anyOf"] as const) {
    const members = schema[name];
    if (Array.isArray(members)) {
      parts.push(
        union(
          members.map((member, index) =>
            convert(member, walk, `${at} ${name}[${index}]`),
          ),
        ),
      );
    }
  }

  let type = intersection(parts);
  if (schema.nullable === true) type = union([type, keyword("null")]);
  return type;
}

/** Whether `type` is `Record<string, unknown>`, what `{ type: "object" }` alone converts to. */
function isAnyObject(type: TsType): boolean {
  return (
    type.kind === "ref" &&
    type.name === "Record" &&
    type.args?.[1]?.kind === "keyword" &&
    type.args[1].name === "unknown"
  );
}

/** A `$ref`: a component's name, or the pointed-at schema inlined. */
function convertRef(ref: string, walk: Walk, at: string): TsType {
  const component = componentOf(ref);
  if (component !== undefined) {
    const name = walk.context.componentType(component);
    if (name !== undefined) return { kind: "ref", name };
    walk.context.warn(
      at,
      `\`$ref\` "${ref}" names no component; typed \`unknown\``,
    );
    return UNKNOWN;
  }
  if (!ref.startsWith("#")) {
    walk.context.warn(
      at,
      `\`$ref\` "${ref}" points outside the document; typed \`unknown\``,
    );
    return UNKNOWN;
  }
  if (walk.inlining.includes(ref)) {
    walk.context.warn(
      at,
      `\`$ref\` "${ref}" is recursive and not a component, so it has no name to recurse through; typed \`unknown\``,
    );
    return UNKNOWN;
  }
  const target = resolvePointer(walk.context.document, ref);
  if (target === undefined) {
    walk.context.warn(
      at,
      `\`$ref\` "${ref}" does not resolve; typed \`unknown\``,
    );
    return UNKNOWN;
  }
  return convert(
    target,
    { context: walk.context, inlining: [...walk.inlining, ref] },
    `${at} → ${ref}`,
  );
}

/** The type the schema's own keywords give (`type`, `enum`, `const`, properties, items); `undefined` when they say nothing. */
function convertBase(
  schema: Record<string, unknown>,
  walk: Walk,
  at: string,
): TsType | undefined {
  if ("const" in schema) return valueType(schema.const);
  if (Array.isArray(schema.enum)) return union(schema.enum.map(valueType));

  const declared = schema.type;
  const types: string[] =
    typeof declared === "string"
      ? [declared]
      : Array.isArray(declared)
        ? declared.filter((item): item is string => typeof item === "string")
        : [];

  if (types.length === 0) {
    if (
      "properties" in schema ||
      "additionalProperties" in schema ||
      "patternProperties" in schema ||
      "required" in schema
    )
      return convertObject(schema, walk, at);
    if ("items" in schema || "prefixItems" in schema)
      return convertArray(schema, walk, at);
    return undefined;
  }

  return union(
    types.map((name): TsType => {
      switch (name) {
        case "string":
          return keyword("string");
        case "number":
        case "integer":
          return keyword("number");
        case "boolean":
          return keyword("boolean");
        case "null":
          return keyword("null");
        case "object":
          return convertObject(schema, walk, at);
        case "array":
          return convertArray(schema, walk, at);
        default:
          walk.context.warn(
            at,
            `unknown \`type\` "${name}"; that member typed \`unknown\``,
          );
          return UNKNOWN;
      }
    }),
  );
}

/** An object schema: its properties, and an index signature for `additionalProperties`/`patternProperties`. */
function convertObject(
  schema: Record<string, unknown>,
  walk: Walk,
  at: string,
): TsType {
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  const members: TsMember[] = [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [name, child] of Object.entries(properties)) {
    const doc = schemaDoc(child);
    members.push({
      name,
      optional: !required.has(name),
      type: convert(child, walk, `${at}.${name}`),
      ...(doc === undefined ? {} : { doc }),
    });
  }
  // A required key with no schema may hold anything, but must be there.
  for (const name of required) {
    if (!Object.hasOwn(properties, name))
      members.push({ name, optional: false, type: UNKNOWN });
  }

  const extra: TsType[] = [];
  const additional = schema.additionalProperties;
  if (additional !== undefined && additional !== false) {
    extra.push(convert(additional, walk, `${at} additionalProperties`));
  }
  if (isRecord(schema.patternProperties)) {
    for (const [pattern, child] of Object.entries(schema.patternProperties))
      extra.push(convert(child, walk, `${at} patternProperties[${pattern}]`));
  }

  if (extra.length === 0) {
    if (members.length > 0) return { kind: "object", members };
    // `{ type: "object" }` alone: any object. Closed and empty: no keys.
    return additional === false
      ? {
          kind: "ref",
          name: "Record",
          args: [keyword("string"), keyword("never")],
        }
      : { kind: "ref", name: "Record", args: [keyword("string"), UNKNOWN] };
  }
  const values = union(extra);
  if (members.length === 0)
    return { kind: "ref", name: "Record", args: [keyword("string"), values] };
  // Every named property must fit the index signature, so the signature
  // admits their types too (and `undefined` for an optional one).
  const index = union([
    values,
    ...members.map((member) => member.type),
    ...(members.some((member) => member.optional)
      ? [keyword("undefined")]
      : []),
  ]);
  return { kind: "object", members, index };
}

/** An array schema: `T[]`, or a tuple from `prefixItems` (or 3.0's array-form `items`). */
function convertArray(
  schema: Record<string, unknown>,
  walk: Walk,
  at: string,
): TsType {
  const prefix = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items)
      ? schema.items
      : undefined;
  const items = Array.isArray(schema.items)
    ? schema.additionalItems
    : schema.items;
  if (prefix !== undefined) {
    const elements = prefix.map((item, index) =>
      convert(item, walk, `${at}[${index}]`),
    );
    if (items === false) return { kind: "tuple", elements };
    return {
      kind: "tuple",
      elements,
      rest: convert(items, walk, `${at}[]`),
    };
  }
  return { kind: "array", element: convert(items, walk, `${at}[]`) };
}
