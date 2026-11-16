/**
 * Keyset page cursors: `@kingsleyweb/bun-sql/cursor`. Opaque, minted by the
 * server, bound to their walk; a bad one is a `ConfigError`, never page one.
 *
 * ```ts
 * const next = encodePageCursor("au1.", "audit", [tenant], [last.at, last.id]);
 * const [at, id] = decodePageCursor(next, "au1.", "audit", [tenant], ["number", "string"]);
 * ```
 */
export { decodePageCursor, encodePageCursor, keysetAfter } from "./cursor";
export type { CursorPart, CursorPartType } from "./cursor";
export type { KeysetCursor } from "../dialect/types";
