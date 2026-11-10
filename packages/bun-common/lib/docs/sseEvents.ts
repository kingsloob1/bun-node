/**
 * An `sse()` body's events as documents list them (OpenAPI's
 * `x-sse-events`, AsyncAPI's messages), shared by both generators: one
 * entry per event name, in declaration order, its data's JSON Schema.
 *
 * An event declared with `sseVariants()` (bun-validate V11) has one
 * `describeContract` row per variant; it is documented as
 * `{ anyOf: [one per variant, in declaration order], "x-variants": { names,
 * conditional, descriptions? } }`. `anyOf`, not HTTP's `oneOf`: nothing on
 * the wire names the variant, the variants may overlap (a user view that is
 * a subset of an admin one), and the server takes the first that applies and
 * passes, so "exactly one" would refuse a value it sends. `names[i]` is
 * `anyOf[i]`'s variant.
 *
 * @internal
 */
import type { ContractEntry } from "../contract/describe";
import type { JsonSchemaLike } from "./convert";
import { isSseVariants } from "../sse/declaration";

/** One documented event: its name, and its data's JSON Schema (`null`: it carries none). */
export interface DocumentedSseEvent {
  /** The event's name (`message` for one with no `event:` line). */
  readonly name: string;
  /** The JSON Schema of its data; `null` for an event declared to carry none. */
  readonly schema: JsonSchemaLike | null;
}

/**
 * The events of one `sse()` row: its `nested` `data` rows grouped by event,
 * each converted with `emit` (a variant's with `variant` given).
 *
 * @param row  The `sse()` row (its `schema` is the declaration).
 * @param emit Converts one event's (or one variant's) data schema.
 * @internal
 */
export function documentSseEvents(
  row: ContractEntry,
  emit: (
    data: NonNullable<ContractEntry["schema"]>,
    event: string,
    variant: string | undefined,
  ) => JsonSchemaLike,
): DocumentedSseEvent[] {
  const groups = new Map<string, ContractEntry[]>();
  for (const nested of row.nested ?? []) {
    if (nested.part !== "data") continue;
    const name = nested.key ?? "message";
    const list = groups.get(name);
    if (list === undefined) groups.set(name, [nested]);
    else list.push(nested);
  }
  const events = (row.schema as { events?: Record<string, unknown> } | null)
    ?.events;
  const out: DocumentedSseEvent[] = [];
  for (const [name, rows] of groups) {
    const declared = events?.[name];
    if (!rows.some((r) => r.variant !== undefined)) {
      const data = rows[0].schema;
      out.push({
        name,
        schema: data === null ? null : emit(data, name, undefined),
      });
      continue;
    }
    const names = rows.map((r) => r.variant!);
    const table = isSseVariants(declared) ? declared.table : undefined;
    const descriptions: Record<string, string> = {};
    for (const variant of names) {
      const description = table?.[variant]?.description;
      if (description !== undefined) descriptions[variant] = description;
    }
    out.push({
      name,
      schema: {
        anyOf: rows.map((r) =>
          r.schema === null ? {} : emit(r.schema, name, r.variant),
        ),
        "x-variants": {
          names,
          conditional: names.filter(
            (variant) => table?.[variant]?.when !== undefined,
          ),
          ...(Object.keys(descriptions).length === 0 ? {} : { descriptions }),
        },
      },
    });
  }
  return out;
}
