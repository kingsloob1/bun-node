/**
 * `liftComponents` (plan §4.4): post-processes a converted JSON Schema into
 * the shape an OpenAPI document wants — its `$defs` lifted into
 * `components.schemas`, every `#/$defs/X` rewritten to
 * `#/components/schemas/X`, `$schema` stripped (OpenAPI 3.1 forbids a
 * per-schema dialect differing from `jsonSchemaDialect`), and zod's
 * self-recursive `$ref: "#"` (measured, §4.4.2) rewritten to the root's
 * component — the root is lifted when any root-relative ref appears, since
 * inlined into a document `#` would point at the document root, which is not
 * a schema.
 *
 * Dedup is by **identity** (`Map<object, string>`): two positions holding the
 * same object share one component — bun-jobs' `s` inlines nested schemas by
 * identity, so this restores the sharing the author wrote — while two
 * structurally equal but distinct objects never merge (comparing JSON would
 * be O(n²) and would merge schemas the author meant to keep apart). A name
 * two different objects claim warns and disambiguates (the converter never
 * throws for a content problem).
 *
 * The output is deterministic: two calls on the same input deep-equal.
 */
import type { ConversionWarning, JsonSchemaLike } from "./convert";

/** What {@link liftComponents} takes. */
export interface LiftComponentsOptions {
  /**
   * The component name the root is lifted under when a root-relative `$ref`
   * (`"#"`, `"#/properties/…"`) forces it, and the base the generated names
   * (`__schemaN` renames, identity-dedup names) are built from. Default
   * `"Schema"`.
   */
  readonly name?: string;
  /** Receives every warning the lift records (a collision, an anonymous rename). */
  readonly onWarning?: (warning: ConversionWarning) => void;
}

/** What {@link liftComponents} returns. */
export interface LiftedSchema {
  /**
   * The rewritten schema: the input with `$schema`/`$defs` gone and every
   * `$ref` pointed at `components` — or, when the root itself was lifted,
   * `{ $ref: "#/components/schemas/<name>" }`.
   */
  readonly schema: JsonSchemaLike;
  /** The lifted components, keyed by name, in a deterministic order. */
  readonly components: Record<string, JsonSchemaLike>;
}

/** Whether `value` is a plain (non-array) object. */
function isPlainObject(value: unknown): value is JsonSchemaLike {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** A `$ref` that points at the schema's own root (`"#"` or a pointer under it) other than into `$defs`. */
function isRootRelative(ref: string): boolean {
  return ref === "#" || (ref.startsWith("#/") && !ref.startsWith("#/$defs/"));
}

/**
 * Post-processes a converted JSON Schema (plan §4.4): lifts `$defs` into
 * components, rewrites refs, strips `$schema`, dedups shared objects by
 * identity, and lifts the root when a self-recursive `$ref: "#"` requires it.
 * The input is not mutated; every returned node is fresh.
 *
 * @param schema The converted schema (one {@link toJsonSchema} produced, or
 *   any draft-2020-12-shaped document).
 * @param options See {@link LiftComponentsOptions}.
 */
export function liftComponents(
  schema: JsonSchemaLike,
  options: LiftComponentsOptions = {},
): LiftedSchema {
  const base = options.name ?? "Schema";
  const warn = (message: string): void => {
    options.onWarning?.({ vendor: "", stage: "lift", message });
  };

  // Pass 1: count object identities. The second encounter of an identity is
  // not walked again, which both cheapens the pass and makes a (pathological)
  // cyclic input terminate; a shared node's own children need no recount —
  // the whole node becomes one component.
  const counts = new Map<object, number>();
  const count = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const seen = (counts.get(node) ?? 0) + 1;
    counts.set(node, seen);
    if (seen > 1) return;
    if (Array.isArray(node)) {
      for (const child of node) count(child);
    } else {
      for (const child of Object.values(node)) count(child);
    }
  };
  count(schema);

  // The names taken, and each component identity's name.
  const used = new Set<string>();
  const names = new Map<object, string>();
  let anonymous = 0;
  const claim = (wanted: string, node: object): string => {
    let name = wanted;
    while (used.has(name)) {
      anonymous += 1;
      name = `${base}${anonymous}`;
    }
    used.add(name);
    names.set(node, name);
    return name;
  };
  /** The next generated name for an anonymous (`__schemaN`) or deduped node. */
  const generated = (node: object): string => {
    anonymous += 1;
    return claim(`${base}${anonymous}`, node);
  };

  // The root's `$defs`, lifted by name. An anonymous `__schemaN` (zod's
  // `reused: "ref"` names) is renamed off the implementation detail.
  const defs = isPlainObject(schema.$defs) ? schema.$defs : undefined;
  if (defs !== undefined) {
    for (const [key, body] of Object.entries(defs)) {
      if (!isPlainObject(body)) continue;
      if (/^__schema\d+$/.test(key)) {
        const name = generated(body);
        warn(`the anonymous component "${key}" was renamed "${name}"`);
      } else {
        if (used.has(key)) {
          const name = generated(body);
          warn(
            `two different components claimed the name "${key}"; the later one was renamed "${name}"`,
          );
        } else {
          claim(key, body);
        }
      }
    }
  }

  // A root-relative ref anywhere (a `$defs` member's included) forces the
  // root into a component (§4.4.2).
  let rootLifted = false;
  const scanned = new Set<object>();
  const scanRefs = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if (scanned.has(node)) return;
    scanned.add(node);
    if (Array.isArray(node)) {
      for (const child of node) scanRefs(child);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (
        key === "$ref" &&
        typeof value === "string" &&
        isRootRelative(value)
      ) {
        rootLifted = true;
      }
      scanRefs(value);
    }
  };
  scanRefs(schema);
  let rootName = "";
  if (rootLifted) {
    rootName = base;
    while (used.has(rootName)) {
      anonymous += 1;
      rootName = `${base}${anonymous}`;
    }
    if (rootName !== base) {
      warn(
        `the root component's name "${base}" was taken; it was lifted as "${rootName}"`,
      );
    }
    used.add(rootName);
    names.set(schema, rootName);
  }

  /** The component name a `#/$defs/X` ref rewrites to. */
  const defName = (key: string): string => {
    const body = defs?.[key];
    if (isPlainObject(body)) {
      const name = names.get(body);
      if (name !== undefined) return name;
    }
    return key;
  };

  const components = new Map<string, JsonSchemaLike>();
  const inProgress = new Set<object>();

  /** A fresh copy of `object`, children transformed, `$schema` stripped — and `$defs` too, at the root (they are lifted, not copied). */
  const buildObject = (
    object: JsonSchemaLike,
    isRoot: boolean,
  ): JsonSchemaLike => {
    const out: JsonSchemaLike = {};
    for (const [key, value] of Object.entries(object)) {
      // The dialect is the document's, stated once (§4.4.1). Only the root's
      // `$defs` are stripped: a nested one (nothing we convert emits one) is
      // left alone.
      if (key === "$schema") continue;
      if (isRoot && key === "$defs") continue;
      if (key === "$ref" && typeof value === "string") {
        if (value === "#") {
          out[key] = `#/components/schemas/${rootName}`;
        } else if (value.startsWith("#/$defs/")) {
          out[key] =
            `#/components/schemas/${defName(value.slice("#/$defs/".length))}`;
        } else if (value.startsWith("#/")) {
          out[key] = `#/components/schemas/${rootName}${value.slice(1)}`;
        } else {
          out[key] = value;
        }
        continue;
      }
      out[key] = transform(value);
    }
    return out;
  };

  /** Builds the component `name`d for `object`, unless built already. */
  const buildComponent = (object: JsonSchemaLike, name: string): void => {
    if (components.has(name) || inProgress.has(object)) return;
    inProgress.add(object);
    const body = buildObject(object, false);
    inProgress.delete(object);
    components.set(name, body);
  };

  function transform(node: unknown): unknown {
    if (typeof node !== "object" || node === null) return node;
    if (Array.isArray(node)) return node.map((child) => transform(child));
    const object = node as JsonSchemaLike;

    // A shared identity becomes a component: its first occurrence builds the
    // body, every later one — and any self-reference met while building — is
    // a `$ref` to it. `{}` is a schema like any other: sharing it is what
    // the author wrote, so it dedups too.
    const name = names.get(object);
    const shared = (counts.get(object) ?? 0) > 1;
    if (name !== undefined || shared) {
      const component = name ?? generated(object);
      if (components.has(component) || inProgress.has(object)) {
        return { $ref: `#/components/schemas/${component}` };
      }
      buildComponent(object, component);
      return { $ref: `#/components/schemas/${component}` };
    }
    return buildObject(object, false);
  }

  const body = buildObject(schema, true);
  // The `$defs` entries' bodies: any identity the root's transform never met
  // (a def referenced only by `$ref` strings) is built here.
  if (defs !== undefined) {
    for (const def of Object.values(defs)) {
      if (!isPlainObject(def)) continue;
      const name = names.get(def);
      if (name !== undefined) buildComponent(def, name);
    }
  }
  if (rootLifted) {
    components.set(rootName, body);
    return {
      schema: { $ref: `#/components/schemas/${rootName}` },
      components: Object.fromEntries(components),
    };
  }
  return { schema: body, components: Object.fromEntries(components) };
}
