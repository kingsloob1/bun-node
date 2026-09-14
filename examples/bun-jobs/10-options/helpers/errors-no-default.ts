/**
 * A runner file with no default export — the mistake `InvalidHandlerError`
 * exists to name. Used by `10-options/errors.ts`; not meant to be run alone.
 */

/** Exported by name only, which is exactly what a runner cannot use. */
export function handler(): string {
  return "never called";
}
