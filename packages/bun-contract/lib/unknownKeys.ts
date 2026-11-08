/**
 * Finding the keys a schema dropped: a value's own keys that its validated
 * output no longer has. zod's `z.object()` (and valibot's `object`, yup's
 * `stripUnknown`, arktype's `"+": "delete"`) strips every key it does not
 * declare and reports nothing, so a field a client sent, or a server added,
 * disappears without a trace. Comparing the input with the output finds them
 * whatever the vendor: used by bun-common's `validate({ unknownKeys })` and
 * bun-client's `validate.unknownKeys`.
 *
 * Internal: reachable by deep import only, not from the package's entry.
 */

/** How deep {@link droppedKeys} walks before it stops looking. */
const MAX_DEPTH = 32;

/** Whether `value` is a plain object: `{}` or `Object.create(null)`, not an array, a `Date` or a class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `key` appended to `path`, dot-joined as an issue's path is. */
function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/**
 * The paths (dot-joined, as an issue's `path`) of the keys `input` has and
 * `output` does not, walking both together through plain objects and
 * arrays: a key whose value is a plain object (or an array) in both is
 * looked into; a key missing from the output is reported once, without its
 * own keys. A value the schema replaced with something else (a transform to
 * a `Date`, a string, a class) is not looked into, and an output that is the
 * input itself drops nothing. At most `limit` paths are returned.
 *
 * @param input  The value as it was given to the schema.
 * @param output The schema's output for it.
 * @param limit  The most paths to return (default 20): a body with
 *   thousands of unknown keys costs that many, not more.
 */
export function droppedKeys(
  input: unknown,
  output: unknown,
  limit = 20,
): string[] {
  const found: string[] = [];
  const walk = (from: unknown, to: unknown, path: string, depth: number) => {
    if (from === to || depth > MAX_DEPTH || found.length >= limit) return;
    if (Array.isArray(from) && Array.isArray(to)) {
      const length = Math.min(from.length, to.length);
      for (let i = 0; i < length && found.length < limit; i++) {
        walk(from[i], to[i], join(path, String(i)), depth + 1);
      }
      return;
    }
    // The output must be a plain object (what a schema builds); the input
    // only an object, since a parsed query or a framework's body may carry a
    // prototype of its own.
    if (
      typeof from !== "object" ||
      from === null ||
      Array.isArray(from) ||
      !isPlainObject(to)
    ) {
      return;
    }
    const record = from as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (found.length >= limit) return;
      if (!Object.hasOwn(to, key)) {
        found.push(join(path, key));
      } else {
        walk(record[key], to[key], join(path, key), depth + 1);
      }
    }
  };
  walk(input, output, "", 0);
  return found;
}
