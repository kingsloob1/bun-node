/**
 * Pure reading of JSON Schema (the 2020-12 dialect OpenAPI 3.1 and AsyncAPI
 * 3.0 use) for the docs viewers: `$ref` resolution against the document
 * root, a one-line type label, the constraint facts, and the children a tree
 * expands into. Nothing here renders; `SchemaTree.tsx` does.
 */

/**
 * Levels below which a tree never expands, whatever the schema: a guard for
 * a pathological (non-cyclic but huge) document. Cycles stop far earlier, at
 * the first `$ref` already open above.
 */
export const MAX_SCHEMA_LEVEL = 24;

/** A schema object; `true`/`false` are schemas too (anything / nothing). */
export type SchemaObject = Readonly<Record<string, unknown>>;

/** A spec document, the root `$ref`s resolve against. */
export type SchemaRoot = Readonly<Record<string, unknown>>;

/** Whether a value is a (non-array) object. */
export function isSchemaObject(value: unknown): value is SchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decodes one JSON Pointer token (`~1` → `/`, `~0` → `~`), after URI-decoding. */
function decodeToken(token: string): string {
  let text = token;
  try {
    text = decodeURIComponent(token);
  } catch {
    // Not URI-encoded; use it as it is.
  }
  return text.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * The value a local `$ref` (`#/components/schemas/Job`) points at inside
 * `root`, or `undefined` when it points nowhere or is not local (a remote
 * document is never fetched).
 */
export function resolveRef(root: SchemaRoot, ref: string): unknown {
  if (ref === "#") {
    return root;
  }
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  let node: unknown = root;
  for (const token of ref.slice(2).split("/")) {
    const key = decodeToken(token);
    if (Array.isArray(node)) {
      const index = Number(key);
      node = Number.isInteger(index) ? node[index] : undefined;
    } else if (isSchemaObject(node) && Object.hasOwn(node, key)) {
      node = node[key];
    } else {
      return undefined;
    }
  }
  return node;
}

/** The name a `$ref` is shown by: its last pointer segment (`#/components/schemas/Job` → `Job`). */
export function refName(ref: string): string {
  const tokens = ref.split("/");
  return decodeToken(tokens[tokens.length - 1] ?? ref) || ref;
}

/** A schema's `$ref`, when it has a string one. */
export function refOf(schema: unknown): string | undefined {
  return isSchemaObject(schema) && typeof schema.$ref === "string"
    ? schema.$ref
    : undefined;
}

/** What {@link deref} found. */
export interface Dereffed {
  /** The schema behind the refs, or `undefined` when a ref points nowhere. */
  schema: SchemaObject | boolean | undefined;
  /** The refs followed, first to last; empty when `schema` had none. */
  refs: string[];
  /** Whether a ref in the chain points back at one already followed. */
  cycle: boolean;
}

/**
 * Follows `$ref` → `$ref` → … to a schema that is not only a reference. The
 * siblings of a `$ref` (a `description`, say) are not merged: a caller shows
 * them beside the target.
 */
export function deref(schema: unknown, root: SchemaRoot): Dereffed {
  const refs: string[] = [];
  let node: unknown = schema;
  for (;;) {
    const ref = refOf(node);
    if (ref === undefined) {
      break;
    }
    if (refs.includes(ref)) {
      return { schema: undefined, refs, cycle: true };
    }
    refs.push(ref);
    node = resolveRef(root, ref);
  }
  if (typeof node === "boolean" || isSchemaObject(node)) {
    return { schema: node, refs, cycle: false };
  }
  return { schema: undefined, refs, cycle: false };
}

/** The types a schema declares (`type` as a string or an array), or `[]`. */
export function declaredTypes(schema: SchemaObject): string[] {
  const { type } = schema;
  if (typeof type === "string") {
    return [type];
  }
  return Array.isArray(type)
    ? type.filter((item): item is string => typeof item === "string")
    : [];
}

/** Whether `null` is allowed: `type` includes it, OpenAPI 3.0's `nullable`, or a `const`/`enum` of null. */
export function allowsNull(schema: SchemaObject): boolean {
  return (
    declaredTypes(schema).includes("null") ||
    schema.nullable === true ||
    (Array.isArray(schema.enum) && schema.enum.includes(null))
  );
}

/** Formats a JSON value for a label (`"a"`, `3`, `null`, `{…}`). */
export function formatValue(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/** The alternatives of a composition keyword, when it has any. */
function alternatives(schema: SchemaObject, key: string): unknown[] {
  const value = schema[key];
  return Array.isArray(value) ? value : [];
}

/**
 * A one-line type: `string`, `integer | null`, `array<JobState>`,
 * `object`, `anyOf(2)`, `any`, `never`; an untyped `enum`/`const` shows its
 * values (`"asc" | "desc"`), a typed one leaves them to {@link schemaFacts}.
 * A `$ref` shows its name.
 */
export function typeLabel(
  schema: unknown,
  root: SchemaRoot,
  level = 0,
): string {
  if (schema === true) {
    return "any";
  }
  if (schema === false) {
    return "never";
  }
  if (!isSchemaObject(schema)) {
    return "any";
  }
  const ref = refOf(schema);
  if (ref !== undefined) {
    return refName(ref);
  }
  const types = declaredTypes(schema);
  if (types.length > 0) {
    const labels = types.map((type) => {
      if (type === "array" && level < 2) {
        const { items } = schema;
        return items === undefined
          ? "array"
          : `array<${typeLabel(items, root, level + 1)}>`;
      }
      return type;
    });
    if (schema.nullable === true && !labels.includes("null")) {
      labels.push("null");
    }
    return labels.join(" | ");
  }
  // Untyped: the values themselves say it (`"asc" | "desc"`).
  if (Object.hasOwn(schema, "const")) {
    return formatValue(schema.const);
  }
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.slice(0, 6).map(formatValue);
    return schema.enum.length > 6
      ? `${values.join(" | ")} | …`
      : values.join(" | ");
  }
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    const options = alternatives(schema, key);
    if (options.length > 0) {
      if (key !== "allOf" && options.length <= 3 && level < 2) {
        return options
          .map((option) => typeLabel(option, root, level + 1))
          .join(" | ");
      }
      return `${key}(${options.length})`;
    }
  }
  if (
    isSchemaObject(schema.properties) ||
    schema.additionalProperties !== undefined
  ) {
    return "object";
  }
  if (schema.items !== undefined) {
    return "array";
  }
  if (schema.not !== undefined) {
    return "not";
  }
  return "any";
}

/** One constraint or annotation of a schema, as a label/value pair. */
export interface SchemaFact {
  /** A stable key (the keyword). */
  key: string;
  /** What it is, e.g. `"min"`. */
  label: string;
  /** Its value, as text. */
  value: string;
}

/** Keywords shown as facts, in display order, with their labels. */
const FACT_KEYWORDS: readonly (readonly [string, string])[] = [
  ["format", "format"],
  ["const", "const"],
  ["enum", "one of"],
  ["default", "default"],
  ["minimum", "min"],
  ["exclusiveMinimum", "above"],
  ["maximum", "max"],
  ["exclusiveMaximum", "below"],
  ["multipleOf", "multiple of"],
  ["minLength", "min length"],
  ["maxLength", "max length"],
  ["pattern", "pattern"],
  ["minItems", "min items"],
  ["maxItems", "max items"],
  ["uniqueItems", "unique items"],
  ["minProperties", "min fields"],
  ["maxProperties", "max fields"],
  ["contentMediaType", "media type"],
  ["contentEncoding", "encoding"],
];

/**
 * The facts worth showing beside a schema's type: format, bounds, lengths,
 * pattern, enum/const, default, examples, nullable, deprecated, read/write
 * only. An untyped `enum`/`const` is left out: {@link typeLabel} shows its
 * values as the type.
 */
export function schemaFacts(schema: unknown): SchemaFact[] {
  if (!isSchemaObject(schema)) {
    return [];
  }
  const facts: SchemaFact[] = [];
  // An untyped enum/const is the type label itself; say it once.
  const typed = declaredTypes(schema).length > 0;
  for (const [key, label] of FACT_KEYWORDS) {
    if (!Object.hasOwn(schema, key)) {
      continue;
    }
    if ((key === "enum" || key === "const") && !typed) {
      continue;
    }
    const value = schema[key];
    if (key === "uniqueItems" && value !== true) {
      continue;
    }
    if (key === "enum" && Array.isArray(value)) {
      facts.push({ key, label, value: value.map(formatValue).join(", ") });
      continue;
    }
    facts.push({
      key,
      label,
      value:
        typeof value === "string" && key !== "default" && key !== "const"
          ? value
          : formatValue(value),
    });
  }
  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    facts.push({
      key: "examples",
      label: "examples",
      value: schema.examples.map(formatValue).join(", "),
    });
  } else if (Object.hasOwn(schema, "example")) {
    facts.push({
      key: "example",
      label: "example",
      value: formatValue(schema.example),
    });
  }
  if (schema.nullable === true) {
    facts.push({ key: "nullable", label: "nullable", value: "yes" });
  }
  if (schema.deprecated === true) {
    facts.push({ key: "deprecated", label: "deprecated", value: "yes" });
  }
  if (schema.readOnly === true) {
    facts.push({ key: "readOnly", label: "read only", value: "yes" });
  }
  if (schema.writeOnly === true) {
    facts.push({ key: "writeOnly", label: "write only", value: "yes" });
  }
  return facts;
}

/**
 * What an object says about fields it does not list: `"closed"` for
 * `additionalProperties: false` (the API answers 400 to any other field),
 * `"any"` for `true`/`{}`, `"typed"` for a schema, `null` when it says
 * nothing (or is not an object).
 */
export function additionalFields(
  schema: unknown,
): "closed" | "any" | "typed" | null {
  if (
    !isSchemaObject(schema) ||
    !Object.hasOwn(schema, "additionalProperties")
  ) {
    return null;
  }
  const extra = schema.additionalProperties;
  if (extra === false) {
    return "closed";
  }
  if (
    extra === true ||
    (isSchemaObject(extra) && Object.keys(extra).length === 0)
  ) {
    return "any";
  }
  return "typed";
}

/** One child of a schema node, as a tree expands it. */
export interface SchemaChild {
  /** A key unique among its siblings. */
  key: string;
  /** What it is. */
  kind:
    | "property"
    | "items"
    | "prefixItems"
    | "additional"
    | "patternProperty"
    | "oneOf"
    | "anyOf"
    | "allOf"
    | "not";
  /** The name shown: a property name, `[]`, `[0]`, `Option 1`, `*`, a pattern. */
  label: string;
  /** Its schema. */
  schema: unknown;
  /** For a property: whether the object lists it in `required`. */
  required: boolean;
}

/** The children a tree expands a (dereferenced) schema into, in reading order. */
export function schemaChildren(schema: unknown): SchemaChild[] {
  if (!isSchemaObject(schema)) {
    return [];
  }
  const children: SchemaChild[] = [];
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (name): name is string => typeof name === "string",
        )
      : [],
  );
  if (isSchemaObject(schema.properties)) {
    for (const [name, child] of Object.entries(schema.properties)) {
      children.push({
        key: `p:${name}`,
        kind: "property",
        label: name,
        schema: child,
        required: required.has(name),
      });
    }
  }
  if (isSchemaObject(schema.patternProperties)) {
    for (const [pattern, child] of Object.entries(schema.patternProperties)) {
      children.push({
        key: `pp:${pattern}`,
        kind: "patternProperty",
        label: `/${pattern}/`,
        schema: child,
        required: false,
      });
    }
  }
  if (additionalFields(schema) === "typed") {
    children.push({
      key: "additional",
      kind: "additional",
      label: "any other field",
      schema: schema.additionalProperties,
      required: false,
    });
  }
  if (Array.isArray(schema.prefixItems)) {
    schema.prefixItems.forEach((child, index) => {
      children.push({
        key: `pi:${index}`,
        kind: "prefixItems",
        label: `[${index}]`,
        schema: child,
        required: false,
      });
    });
  }
  if (schema.items !== undefined && typeof schema.items !== "boolean") {
    children.push({
      key: "items",
      kind: "items",
      label: "[]",
      schema: schema.items,
      required: false,
    });
  }
  for (const kind of ["oneOf", "anyOf", "allOf"] as const) {
    alternatives(schema, kind).forEach((child, index) => {
      children.push({
        key: `${kind}:${index}`,
        kind,
        label: kind === "allOf" ? `Part ${index + 1}` : `Option ${index + 1}`,
        schema: child,
        required: false,
      });
    });
  }
  if (schema.not !== undefined) {
    children.push({
      key: "not",
      kind: "not",
      label: "not",
      schema: schema.not,
      required: false,
    });
  }
  return children;
}

/** How a composition is introduced above its alternatives. */
export const COMPOSITION_LABELS: Readonly<
  Record<"oneOf" | "anyOf" | "allOf", string>
> = {
  oneOf: "Exactly one of",
  anyOf: "Any of",
  allOf: "All of",
};
