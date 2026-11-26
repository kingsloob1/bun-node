/**
 * Table and index definitions, rendered to DDL: `@kingsleyweb/bun-sql/schema`.
 *
 * ```ts
 * const definition: SchemaDefinition = {
 *   tables: [{ name: "audit", primaryKey: ["seq"], columns: [
 *     { name: "seq", type: dialect.serialType, retype: false },
 *     { name: "body", type: dialect.documentType, suffix: "NOT NULL" },
 *   ] }],
 *   indexes: [],
 * };
 * for (const statement of createSchema(definition, dialect)) await sql.unsafe(statement);
 * ```
 */
export {
  createSchema,
  renderColumn,
  renderIndex,
  renderIndexColumn,
} from "./schema";
export type {
  CollatedIndexColumn,
  ColumnDefinition,
  CreateSchemaOptions,
  IndexDefinition,
  RenderNameOptions,
  SchemaDefinition,
  TableDefinition,
} from "./schema";
