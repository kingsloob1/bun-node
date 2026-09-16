/**
 * `$ref` utilities for the generated documents: finding every reference,
 * resolving one, and dropping components nothing reaches.
 */

/** Where schema components live in an OpenAPI document. */
export const SCHEMA_REF_PREFIX = "#/components/schemas/";

/** Every `$ref` string anywhere inside a value. */
export function collectRefs(
  value: unknown,
  into: Set<string> = new Set(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, into);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") {
        into.add(child);
      } else {
        collectRefs(child, into);
      }
    }
  }
  return into;
}

/**
 * Resolves a local reference (`#/a/b`, JSON Pointer escapes `~0`/`~1`
 * honoured) inside a document. `undefined` when it does not resolve.
 */
export function resolveRef(document: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) {
    return undefined;
  }
  let current: unknown = document;
  for (const raw of ref.slice(1).split("/").slice(1)) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.hasOwn(current, key)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Every reference in a document that does not resolve. */
export function danglingRefs(document: unknown): string[] {
  return [...collectRefs(document)].filter(
    (ref) => resolveRef(document, ref) === undefined,
  );
}

/**
 * Removes every `components.schemas` entry nothing reaches: references are
 * followed from everything outside `components.schemas`, then transitively
 * through the schemas reached. Pruning a route therefore also prunes the
 * schemas only it used.
 */
export function pruneSchemaComponents(document: {
  /** The document's components. */
  components?: { schemas?: Record<string, unknown> } & Record<string, unknown>;
}): void {
  const schemas = document.components?.schemas;
  if (!schemas) {
    return;
  }

  const { schemas: _schemas, ...otherComponents } = document.components!;
  const roots = collectRefs({ ...document, components: otherComponents });
  const reached = new Set<string>();
  const pending = [...roots];

  while (pending.length > 0) {
    const ref = pending.pop()!;
    if (!ref.startsWith(SCHEMA_REF_PREFIX)) {
      continue;
    }
    const name = ref.slice(SCHEMA_REF_PREFIX.length);
    if (reached.has(name) || !Object.hasOwn(schemas, name)) {
      continue;
    }
    reached.add(name);
    pending.push(...collectRefs(schemas[name]));
  }

  for (const name of Object.keys(schemas)) {
    if (!reached.has(name)) {
      delete schemas[name];
    }
  }
  if (Object.keys(schemas).length === 0) {
    delete document.components!.schemas;
  }
}
