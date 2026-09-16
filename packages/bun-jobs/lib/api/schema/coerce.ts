import type { JsonSchemaType } from "./validate";

/**
 * Coercion for values that arrive as strings: the query string and path
 * parameters.
 *
 * bun-common parses queries with picoquery (`arrayRepeat: true`), so a key
 * given once is a string and a key repeated is an array of strings; nothing is
 * ever a number or a boolean. A schema that says `integer` therefore needs the
 * string turned into one first — and doing it here, inside validation, rather
 * than in a BunValidate hook, is what makes the inferred type (`number`) the
 * truth about what a handler receives.
 */

/** A plain decimal number: no hex, no `Infinity`, no whitespace-only input. */
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

/** A string as a number, or `undefined` when it is not a plain decimal. */
export function coerceNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!DECIMAL.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `"true"`/`"1"` and `"false"`/`"0"` as booleans, anything else `undefined`. */
export function coerceBoolean(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case "true":
    case "1":
      return true;
    case "false":
    case "0":
      return false;
    default:
      return undefined;
  }
}

/**
 * A query value as an array.
 *
 * - A repeated key is already an array, and is kept as it is — its items are
 *   **not** split on commas, so a client whose values contain commas repeats
 *   the key instead.
 * - A single value is split on commas: `state=waiting,failed`.
 * - An empty value is an empty list.
 * - Anything else (a number, an object) is left for validation to reject.
 */
export function coerceArray(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  return value === "" ? [] : value.split(",");
}

/**
 * Coerces a value towards the first of `types` it can become. A value that
 * cannot be coerced is returned unchanged, so validation reports the original.
 */
export function coerceForTypes(
  value: unknown,
  types: readonly JsonSchemaType[],
): unknown {
  if (types.includes("array")) {
    return coerceArray(value);
  }
  if (typeof value !== "string") {
    return value;
  }
  if (types.includes("string")) {
    return value;
  }
  for (const type of types) {
    if (type === "integer" || type === "number") {
      const parsed = coerceNumber(value);
      if (parsed !== undefined) {
        return parsed;
      }
    } else if (type === "boolean") {
      const parsed = coerceBoolean(value);
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }
  return value;
}
