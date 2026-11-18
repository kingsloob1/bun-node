/**
 * The policy's JSON Schema (the management API's `SecurityPolicy`
 * component, PR-AN2; read by `useSchema.ts`), and what kind of control each
 * node of it gets on a generated form: a closed object becomes a group of
 * fields; a scalar, an enumeration, a duration or a list of strings a
 * control; a section that can be turned off (`false`) a switch beside its
 * fields; anything else (a list of objects, a map, a choice of shapes) the
 * JSON editor.
 */
import { isObject } from "./paths";

/** A JSON Schema node. */
export type SchemaNode = Readonly<Record<string, unknown>>;

/** The OpenAPI component the policy's JSON Schema is published under. */
export const POLICY_COMPONENT = "SecurityPolicy";

/** A node's properties, when it is an object with named ones. */
export function propertiesOf(
  node: SchemaNode | undefined,
): Readonly<Record<string, SchemaNode>> | undefined {
  const properties = node?.properties;
  return isObject(properties)
    ? (properties as Record<string, SchemaNode>)
    : undefined;
}

/** What control a node gets. */
export type Control =
  | { readonly kind: "enum"; readonly values: readonly (string | number)[] }
  | { readonly kind: "boolean" }
  | {
      readonly kind: "number";
      readonly integer: boolean;
      readonly min?: number;
      readonly max?: number;
      /** An example from the schema (`examples`, else `default`), for the placeholder. */
      readonly example?: number;
    }
  | {
      readonly kind: "string";
      /** An example from the schema (`examples`, else `default`), for the placeholder. */
      readonly example?: string;
    }
  | { readonly kind: "duration" }
  | { readonly kind: "lines" }
  | { readonly kind: "choices"; readonly values: readonly string[] }
  | { readonly kind: "object"; readonly node: SchemaNode }
  | { readonly kind: "orFalse"; readonly inner: Control }
  | { readonly kind: "json" };

/** The node's `anyOf` branches, when it has them. */
function branches(node: SchemaNode): SchemaNode[] | undefined {
  return Array.isArray(node.anyOf) ? (node.anyOf as SchemaNode[]) : undefined;
}

/** Whether a node is a duration: a string, or an object of units. */
function isDuration(node: SchemaNode): boolean {
  const options = branches(node);
  return (
    options !== undefined &&
    options.some((option) => option.type === "string") &&
    options.some((option) => propertiesOf(option)?.minutes !== undefined)
  );
}

/** A node's first example (`examples`, else `default`) that is a string. */
function stringExample(node: SchemaNode): string | undefined {
  const candidates = [
    ...(Array.isArray(node.examples) ? node.examples : []),
    node.default,
  ];
  return candidates.find((value): value is string => typeof value === "string");
}

/** A node's first example (`examples`, else `default`) that is a number. */
function numberExample(node: SchemaNode): number | undefined {
  const candidates = [
    ...(Array.isArray(node.examples) ? node.examples : []),
    node.default,
  ];
  return candidates.find((value): value is number => typeof value === "number");
}

/** The control a node gets; see the module's description. */
export function controlOf(node: SchemaNode): Control {
  if (Array.isArray(node.enum)) {
    const values = node.enum as (string | number)[];
    return { kind: "enum", values };
  }
  if (isDuration(node)) return { kind: "duration" };
  const options = branches(node);
  if (options !== undefined) {
    const off = options.findIndex((option) => option.const === false);
    if (off !== -1 && options.length === 2) {
      const inner = controlOf(options[1 - off]);
      return inner.kind === "json" ? inner : { kind: "orFalse", inner };
    }
    return { kind: "json" };
  }
  switch (node.type) {
    case "boolean":
      return { kind: "boolean" };
    case "integer":
    case "number":
      return {
        kind: "number",
        integer: node.type === "integer",
        ...(typeof node.minimum === "number" ? { min: node.minimum } : {}),
        ...(typeof node.maximum === "number" ? { max: node.maximum } : {}),
        ...(numberExample(node) === undefined
          ? {}
          : { example: numberExample(node)! }),
      };
    case "string": {
      const example = stringExample(node);
      return { kind: "string", ...(example === undefined ? {} : { example }) };
    }
    case "array": {
      const items = isObject(node.items) ? (node.items as SchemaNode) : {};
      if (Array.isArray(items.enum))
        return { kind: "choices", values: items.enum as string[] };
      return items.type === "string" ? { kind: "lines" } : { kind: "json" };
    }
    case "object":
      return node.additionalProperties === false &&
        propertiesOf(node) !== undefined
        ? { kind: "object", node }
        : { kind: "json" };
    default:
      return { kind: "json" };
  }
}

/** A field's label from its key: `maxQueryBytes` → `Max query bytes`. */
export function labelOf(key: string): string {
  const words = key
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A node's description, for a field's hint. */
export function hintOf(node: SchemaNode): string | undefined {
  return typeof node.description === "string" ? node.description : undefined;
}
