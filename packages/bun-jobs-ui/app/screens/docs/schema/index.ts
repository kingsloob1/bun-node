/**
 * The shared JSON Schema renderer of the docs viewers (HTTP and WebSocket).
 * Its API is kept stable for both: `SchemaTree`, `resolveRef`, and the pure
 * helpers below.
 */
export { Prose } from "./Prose";
export type { ProseProps } from "./Prose";
export {
  additionalFields,
  declaredTypes,
  deref,
  isSchemaObject,
  MAX_SCHEMA_LEVEL,
  refName,
  refOf,
  resolveRef,
  schemaChildren,
  schemaFacts,
  typeLabel,
} from "./resolve";
export type {
  Dereffed,
  SchemaChild,
  SchemaFact,
  SchemaObject,
  SchemaRoot,
} from "./resolve";
export { SchemaTree } from "./SchemaTree";
export type { SchemaTreeProps } from "./SchemaTree";
export { schemaSkeleton } from "./skeleton";
