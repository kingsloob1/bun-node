import type { SpecDocument } from "../../../api/docs";
import { SchemaTree } from "../schema";

/** Props of {@link PayloadSchema}. */
export interface PayloadSchemaProps {
  /** The schema, as the document writes it (often a `$ref`). */
  schema: unknown;
  /** The whole document, for resolving `$ref`s. */
  root: SpecDocument;
  /** The tree's accessible name. */
  label: string;
  /** Levels open at first. Defaults to 2. */
  depth?: number;
}

/**
 * A message's payload schema, `$ref`s resolved, drawn by the docs' shared
 * schema tree. The one place the WebSocket reference renders a schema.
 */
export function PayloadSchema({
  schema,
  root,
  label,
  depth = 2,
}: PayloadSchemaProps) {
  return (
    <div
      className="ws-schema"
      data-testid="ws-schema"
    >
      <SchemaTree
        schema={schema}
        root={root}
        depth={depth}
        label={label}
      />
    </div>
  );
}
