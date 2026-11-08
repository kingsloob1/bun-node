/**
 * Constants of the viewer's own HTTP layer: which methods mutate (a try-it
 * confirms them), and which must carry `Content-Type: application/json` even
 * when bodiless. Generic HTTP, shared with no one: the documented API's own
 * constants are its own.
 */

/** HTTP methods treated as mutations: every one but `GET`/`HEAD`/`OPTIONS`. */
export const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/** Methods that carry `Content-Type: application/json` even when bodiless. */
export const JSON_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
]);

/** The last instant a `Date` holds. */
export const MAX_DATE_MS = 8_640_000_000_000_000;
