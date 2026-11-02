/**
 * Hand-rolled Standard Schemas for the package's own tests, so they need no
 * validation library: the package has no dependency, and its tests show it
 * works with the spec alone. bun-common's suite runs the same core against
 * zod, valibot, arktype and yup.
 */
import type { StandardSchemaV1 } from "../lib/index";

/** A schema accepting what `check` accepts, as `parse` of it; sync. */
export function schema<I, O>(
  check: (value: unknown) => value is I,
  parse: (value: I) => O,
  message = "Rejected",
): StandardSchemaV1<I, O> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) =>
        check(value)
          ? { value: parse(value) }
          : { issues: [{ message, path: [] }] },
    },
  };
}

/** A number, or a string of digits parsed to one: the wire input is `string | number`. */
export const numeric = schema(
  (value): value is string | number =>
    typeof value === "number" ||
    (typeof value === "string" && /^\d+$/.test(value)),
  (value) => Number(value),
  "Expected a number",
);

/** A string of at most ten characters. */
export const shortString = schema(
  (value): value is string => typeof value === "string" && value.length <= 10,
  (value) => value,
  "Expected a short string",
);
