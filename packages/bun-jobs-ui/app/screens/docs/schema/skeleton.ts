import type { SchemaRoot } from "./resolve";
import { declaredTypes, deref, isSchemaObject } from "./resolve";

/**
 * A starting value for a schema: an editor's prefill. Objects get only their
 * REQUIRED fields (an optional one would be a guess the reader has to
 * delete), each filled the same way; `default`, `const` and the first `enum`
 * value win over a type's zero; unions take their first non-null option.
 * A `$ref` cycle, or a schema that says nothing, gives `null`.
 */
export function schemaSkeleton(
  schema: unknown,
  root: SchemaRoot,
  seen: readonly string[] = [],
): unknown {
  const { schema: node, refs, cycle } = deref(schema, root);
  if (cycle || refs.some((ref) => seen.includes(ref))) {
    return null;
  }
  if (!isSchemaObject(node)) {
    return null;
  }
  const chain = [...seen, ...refs];
  if (Object.hasOwn(node, "default")) {
    return structuredClone(node.default);
  }
  if (Object.hasOwn(node, "const")) {
    return structuredClone(node.const);
  }
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return structuredClone(node.enum.find((value) => value !== null) ?? null);
  }
  if (Array.isArray(node.allOf) && node.allOf.length > 0) {
    const merged: Record<string, unknown> = {};
    for (const part of node.allOf) {
      const value = schemaSkeleton(part, root, chain);
      if (isSchemaObject(value)) {
        Object.assign(merged, value);
      }
    }
    return merged;
  }
  for (const key of ["oneOf", "anyOf"]) {
    const options = node[key];
    if (Array.isArray(options) && options.length > 0) {
      const option =
        options.find((candidate) => {
          const target = deref(candidate, root).schema;
          return !(
            isSchemaObject(target) &&
            declaredTypes(target).length === 1 &&
            declaredTypes(target)[0] === "null"
          );
        }) ?? options[0];
      return schemaSkeleton(option, root, chain);
    }
  }
  const types = declaredTypes(node).filter((type) => type !== "null");
  const type =
    types[0] ??
    (isSchemaObject(node.properties)
      ? "object"
      : node.items
        ? "array"
        : undefined);
  switch (type) {
    case "object": {
      const value: Record<string, unknown> = {};
      const properties = isSchemaObject(node.properties) ? node.properties : {};
      const required = Array.isArray(node.required) ? node.required : [];
      for (const name of required) {
        if (typeof name === "string") {
          value[name] = schemaSkeleton(properties[name], root, chain);
        }
      }
      return value;
    }
    case "array": {
      const min = typeof node.minItems === "number" ? node.minItems : 0;
      return min > 0 ? [schemaSkeleton(node.items, root, chain)] : [];
    }
    case "string":
      return "";
    case "integer":
    case "number":
      return typeof node.minimum === "number" ? node.minimum : 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}
