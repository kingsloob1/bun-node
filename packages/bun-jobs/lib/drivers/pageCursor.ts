/**
 * The shared encoding behind every **keyset** page cursor the API hands out.
 *
 * A cursor says *where a walk stopped*, as a value rather than a position, so
 * the next page can be read by seeking past that value instead of counting
 * rows. That is what makes it survive rows arriving, leaving or being trimmed
 * between two requests, which an `offset` cannot.
 *
 * Three rules, and they are the convention — not this route's taste:
 *
 * 1. **Opaque, and minted by the server.** A client never builds one. The
 *    ordering key a listing rests on is the backend's, and the backends do not
 *    agree on it: the memory and Redis drivers break ties on an internal
 *    counter where the SQL, MongoDB and file drivers break them on the id, so
 *    a `(sortKey, id)` tuple a client assembled would mean different things on
 *    different backends. Encoding it keeps the key the server's business, and
 *    lets it change without a breaking API change.
 * 2. **Bound to its walk.** The envelope carries a `kind` and a `walk` — every
 *    parameter that decides what the walk visits and in what order — and
 *    {@link decodePageCursor} refuses a cursor whose walk is not the one being
 *    asked for. A cursor from another runner, another order or another route
 *    would otherwise resume from a position that means nothing here and
 *    silently skip rows, which is the bug `sealWalkCursor` was written for.
 * 3. **A bad one is a 400, never a quiet restart.** Both failures raise a
 *    `ConfigError`, which the API answers `400 INVALID_ARGUMENT`. Serving page
 *    one instead would look like the end of a list.
 *
 * Mismatch detection, not security: nothing here is signed, and the key is
 * base64url of JSON that anyone may read. It holds only what the response
 * already showed.
 *
 * The wire shape is `"<prefix><base64url(JSON)>"`, matching
 * `encodeRewriteCursor` (`"jd1."`) and `sealWalkCursor` (`"ja1."`), which came
 * first. Each cursor-bearing route picks its own versioned prefix, so a cursor
 * names its format and its route in its first four characters.
 *
 * The encoding is bun-sql's (`@kingsleyweb/bun-sql/cursor`, PR-D0b): this
 * module re-exports it, and decodes through bun-jobs' error seam so a bad
 * cursor is still bun-jobs' `ConfigError`.
 */

import type { CursorPart, CursorPartType } from "@kingsleyweb/bun-sql/cursor";
import {
  decodePageCursor as decodeSharedPageCursor,
  encodePageCursor,
} from "@kingsleyweb/bun-sql/cursor";
import { JOBS_SQL } from "./sql/seam";

export type { CursorPart, CursorPartType };
export { encodePageCursor };

/**
 * Reads a cursor {@link encodePageCursor} minted, refusing one not minted
 * for this walk. Two failures, both bun-jobs' `ConfigError` (a `400`): a
 * cursor that is not one this walk issued (wrong prefix, not JSON, the wrong
 * shape or version, a key part of the wrong type) and one that belongs to
 * another walk.
 */
export function decodePageCursor(
  /** The cursor as the client sent it. */
  cursor: string,
  /** The route's versioned prefix, ending in a dot, e.g. `"rh1."`. */
  prefix: string,
  /** Which listing is asking; a cursor naming another is refused. */
  kind: string,
  /** The walk being asked for, part for part. */
  walk: readonly CursorPart[],
  /** What each ordering-key part must be; a `"number"` must be finite. */
  keyTypes: readonly CursorPartType[],
): CursorPart[] {
  return decodeSharedPageCursor(cursor, prefix, kind, walk, keyTypes, JOBS_SQL);
}
