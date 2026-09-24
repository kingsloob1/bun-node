import { Buffer } from "node:buffer";
import { ConfigError } from "../shared/errors";

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
 */

/** A part of a cursor's walk binding or ordering key: both JSON scalars. */
export type CursorPart = string | number;

/** What a {@link decodePageCursor} caller says each key part must be. */
export type CursorPartType = "string" | "number";

/** The envelope a page cursor holds, before it is encoded. */
interface CursorEnvelope {
  /** Format version of the envelope itself. */
  v: 1;
  /** Which listing minted it, so one route's cursor is not another's. */
  k: string;
  /** Everything that decides what the walk visits, and in what order. */
  w: CursorPart[];
  /** The ordering key of the last item the previous page returned. */
  p: CursorPart[];
}

/**
 * Mints an opaque cursor continuing `walk` after the item whose ordering key
 * is `key`.
 *
 * The caller owns both halves: `walk` must name every parameter that changes
 * what the walk visits (the namespace, the thing being listed, the order), and
 * `key` must be a **total** ordering key for that walk — one whose last part
 * is unique — or the seek can repeat or skip an item where two keys tie.
 */
export function encodePageCursor(
  /** The route's versioned prefix, ending in a dot, e.g. `"rh1."`. */
  prefix: string,
  /** Which listing this is, so another route's cursor is refused. */
  kind: string,
  /** Everything that decides what the walk visits, and in what order. */
  walk: readonly CursorPart[],
  /** The ordering key of the last item the page returned. */
  key: readonly CursorPart[],
): string {
  const envelope: CursorEnvelope = {
    v: 1,
    k: kind,
    w: [...walk],
    p: [...key],
  };
  return `${prefix}${Buffer.from(JSON.stringify(envelope)).toString("base64url")}`;
}

/**
 * The ordering key inside a cursor from {@link encodePageCursor} — or a
 * `ConfigError` (the API answers `400 INVALID_ARGUMENT`) when it is not one of
 * this route's cursors, or belongs to another walk.
 *
 * Two distinct refusals, with different messages, because they are different
 * client mistakes: a cursor that is malformed, truncated, from another route
 * or of another version was never usable, while one that is well formed but
 * names another walk is usually a real cursor sent to the wrong place — a
 * runner's cursor replayed against a different runner, or the same page
 * re-requested after the order was flipped.
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
  const malformed = () =>
    new ConfigError("cursor is not one this walk issued", { cursor });

  if (typeof cursor !== "string" || !cursor.startsWith(prefix)) {
    throw malformed();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(
      Buffer.from(cursor.slice(prefix.length), "base64url").toString("utf8"),
    );
  } catch {
    throw malformed();
  }

  const envelope = parsed as Partial<CursorEnvelope> | null;

  if (
    typeof envelope !== "object" ||
    envelope === null ||
    envelope.v !== 1 ||
    envelope.k !== kind ||
    !Array.isArray(envelope.w) ||
    !Array.isArray(envelope.p)
  ) {
    throw malformed();
  }

  // The walk is compared **before** the key's shape, because a walk can decide
  // that shape: the jobs list keys `waiting` on two numbers and `completed` on
  // one, so a real `waiting` cursor replayed against `completed` fails both
  // checks, and "this belongs to another walk" is the one that tells the
  // client what it actually did. Where the shape is fixed — the runner
  // history — the order cannot matter, since only one of the two can fail.
  if (
    envelope.w.length !== walk.length ||
    envelope.w.some((part, index) => part !== walk[index])
  ) {
    throw new ConfigError("this cursor belongs to another walk", {
      cursor,
      walk: [...walk],
      cursorWalk: envelope.w,
    });
  }

  if (
    envelope.p.length !== keyTypes.length ||
    keyTypes.some((type, index) => {
      const part: unknown = envelope.p?.[index];
      return type === "number"
        ? typeof part !== "number" || !Number.isFinite(part)
        : typeof part !== "string";
    })
  ) {
    throw malformed();
  }

  return envelope.p;
}
