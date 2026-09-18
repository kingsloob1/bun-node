/**
 * Clipboard and JSON-serialisation helpers shared by {@link CopyButton} and
 * {@link JsonView}.
 */

/** How long a {@link CopyButton}'s "Copied" / "Copy failed" feedback shows, in ms. */
export const COPY_FEEDBACK_MS = 1_500;

/**
 * Writes `text` to the clipboard. Resolves `false` instead of throwing when
 * the Clipboard API is missing (an insecure origin, an old browser) or the
 * write is refused (no permission, the document not focused).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return false;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** What {@link toJsonSafe} puts where a reference points back at an ancestor. */
export const CIRCULAR_MARKER = "[Circular]";

/**
 * A JSON-safe copy of any value: circular references become
 * {@link CIRCULAR_MARKER} (a shared, non-circular reference is kept), a
 * `bigint` becomes its decimal string, `undefined` inside an array becomes
 * `null` (as `JSON.stringify` would), functions and symbols are dropped from
 * objects, and anything with `toJSON` (a `Date`) is serialised through it.
 *
 * The guard is a `WeakSet` of the objects on the current path: added on the
 * way down, deleted on the way back up, so it flags cycles and nothing else.
 */
export function toJsonSafe(value: unknown): unknown {
  const path = new WeakSet<object>();
  const walk = (current: unknown): unknown => {
    if (typeof current === "bigint") {
      return current.toString();
    }
    if (typeof current === "function" || typeof current === "symbol") {
      return undefined;
    }
    if (typeof current !== "object" || current === null) {
      return current;
    }
    if (path.has(current)) {
      return CIRCULAR_MARKER;
    }
    const withJson = current as { toJSON?: unknown };
    if (typeof withJson.toJSON === "function") {
      return walk((withJson.toJSON as () => unknown).call(current));
    }
    path.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map((item) => {
          const safe = walk(item);
          return safe === undefined ? null : safe;
        });
      }
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current)) {
        const safe = walk(item);
        if (safe !== undefined) {
          out[key] = safe;
        }
      }
      return out;
    } finally {
      path.delete(current);
    }
  };
  return walk(value);
}

/**
 * `JSON.stringify` that never throws: circular input and bigints are handled
 * by {@link toJsonSafe}, and a bare `undefined` becomes the text `undefined`.
 */
export function safeStringify(value: unknown, indent = 2): string {
  const text = JSON.stringify(toJsonSafe(value), null, indent) as
    | string
    | undefined;
  return text ?? "undefined";
}
