import type { JobWorkerRef } from "../driver";
import { Buffer } from "node:buffer";

/**
 * The packed attribution stamp the Redis driver keeps on a job's hash, in the
 * one field {@link STAMP_FIELD}: who claimed the job's current or last
 * attempt, as `JobRecord.processedBy` reports it.
 *
 * **One field, not four** (decision D7 of the attribution design): a hash in
 * listpack encoding stores every field *name* beside its value, per job, so
 * `workerKey`/`workerHost`/`workerPid` as three fields would cost about 25
 * bytes a job more in names alone — and on Redis that is RAM, paid by every
 * retained job.
 *
 * **The encoding is length-prefixed**, one segment per part, in the order
 * `id`, `key`, `host`, `pid`:
 *
 * - a present part is its UTF-8 **byte** length in decimal, a `:`, then the
 *   part's bytes — `7:alpha-1`;
 * - an absent part is a single `-` (a length always starts with a digit, so
 *   the two cannot be confused);
 * - trailing absent parts are dropped, so an id-only stamp is one segment.
 *
 * So `{ id: "alpha-1", key: "svc.emails", host: "host-a", pid: 101 }` packs
 * as `7:alpha-110:svc.emails6:host-a3:101`.
 *
 * **Why lengths rather than a separator.** A separator — the design's
 * `\x1f` — has to be escaped wherever it may occur, and a key or host is
 * whatever the application passed: an unescaped separator inside a key would
 * shift every later part, and the Lua filter, which compares the key
 * segment, would then match the wrong job. A length prefix never searches for
 * a byte inside a part, so no content of any part (colons, dashes, digits,
 * control bytes, multi-byte text) can move a boundary; nothing needs escaping
 * and nothing needs unescaping. JSON would be equally safe but larger (quotes,
 * brackets and commas per part) and would need `cjson` in the filter where a
 * length prefix needs one `string.find`. Lengths count bytes, not UTF-16 code
 * units, because Lua's `string.sub` does.
 *
 * The Lua reader of this format is `segment` in `FIND_JOBS` (scripts.ts),
 * which reads the first two segments only.
 */

/** The hash field the packed stamp is stored under. Short, since every job carries its name. */
export const STAMP_FIELD = "wk";

/** Whether a string is ASCII, where its bytes and its UTF-16 units coincide. */
function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0x7f) {
      return false;
    }
  }
  return true;
}

/** One part, length-prefixed by its UTF-8 byte length. */
function segment(part: string): string {
  return `${isAscii(part) ? part.length : Buffer.byteLength(part, "utf8")}:${part}`;
}

/** The last ref {@link packStamp} packed, by value, and what it packed to. */
const packMemo: {
  /** The ref's id. */
  id: string;
  /** The ref's key. */
  key: string | undefined;
  /** The ref's host. */
  host: string | undefined;
  /** The ref's pid. */
  pid: number | undefined;
  /** The packed stamp; empty before the first call. */
  packed: string;
} = { id: "", key: undefined, host: undefined, pid: undefined, packed: "" };

/** The last stamp {@link unpackStamp} decoded, and what it decoded to. */
const unpackMemo: {
  /** The packed stamp; empty before the first call. */
  packed: string;
  /** What it decoded to, kept apart from every copy handed out. */
  ref: JobWorkerRef | null;
} = { packed: "", ref: null };

/**
 * A worker ref packed for {@link STAMP_FIELD}. Always non-empty: the id is
 * always present.
 */
export function packStamp(ref: JobWorkerRef): string {
  // A worker claims with the same ref every time, so the last one packed is
  // almost always the one asked for again.
  if (
    ref.id === packMemo.id &&
    ref.key === packMemo.key &&
    ref.host === packMemo.host &&
    ref.pid === packMemo.pid &&
    packMemo.packed !== ""
  ) {
    return packMemo.packed;
  }

  const packed = packUncached(ref);
  packMemo.id = ref.id;
  packMemo.key = ref.key;
  packMemo.host = ref.host;
  packMemo.pid = ref.pid;
  packMemo.packed = packed;
  return packed;
}

/** {@link packStamp} without the memo. */
function packUncached(ref: JobWorkerRef): string {
  const parts: (string | undefined)[] = [
    ref.id,
    ref.key,
    ref.host,
    ref.pid === undefined ? undefined : String(ref.pid),
  ];

  // Trailing absent parts are dropped; an absent part before a present one is `-`.
  while (parts.length > 1 && parts.at(-1) === undefined) {
    parts.pop();
  }

  return parts
    .map((part) => (part === undefined ? "-" : segment(part)))
    .join("");
}

/**
 * The parts of a packed stamp, or `null` when it is absent, empty or
 * malformed — a malformed value is never guessed at, since a stamp that reads
 * wrong would attribute a job to a worker that never ran it.
 */
function unpackParts(packed: string): (string | undefined)[] | null {
  return isAscii(packed) ? unpackAscii(packed) : unpackBytes(packed);
}

/**
 * {@link unpackParts} for an ASCII stamp — every stamp whose key and host are
 * ASCII, which is nearly all of them — where byte offsets and string indices
 * coincide. `indexOf`/`charCodeAt` rather than a character at a time through
 * closures: measured 213 ns against 434 ns warm, 1.1 µs against 7 µs cold.
 */
function unpackAscii(packed: string): (string | undefined)[] | null {
  const parts: (string | undefined)[] = [];
  const size = packed.length;
  let cursor = 0;

  while (cursor < size) {
    if (parts.length === 4) {
      return null;
    }

    if (packed.charCodeAt(cursor) === 0x2d /* - */) {
      parts.push(undefined);
      cursor++;
      continue;
    }

    let length = 0;
    let colon = cursor;
    for (; colon < size; colon++) {
      const code = packed.charCodeAt(colon);
      if (code < 0x30 || code > 0x39) {
        break;
      }
      length = length * 10 + (code - 0x30);
    }
    if (
      colon === cursor ||
      colon >= size ||
      packed.charCodeAt(colon) !== 0x3a
    ) {
      return null;
    }

    const end = colon + 1 + length;
    if (end > size) {
      return null;
    }

    parts.push(packed.slice(colon + 1, end));
    cursor = end;
  }

  return parts;
}

/** {@link unpackParts} for a stamp with multi-byte text, over its UTF-8 bytes. */
function unpackBytes(packed: string): (string | undefined)[] | null {
  const bytes = Buffer.from(packed, "utf8");
  const size = bytes.length;
  const at = (index: number): string => String.fromCharCode(bytes[index]!);
  const slice = (from: number, to: number): string =>
    bytes.toString("utf8", from, to);

  const parts: (string | undefined)[] = [];
  let cursor = 0;

  while (cursor < size) {
    if (parts.length === 4) {
      return null;
    }

    if (at(cursor) === "-") {
      parts.push(undefined);
      cursor++;
      continue;
    }

    let colon = cursor;
    while (colon < size && at(colon) >= "0" && at(colon) <= "9") {
      colon++;
    }
    if (colon === cursor || colon >= size || at(colon) !== ":") {
      return null;
    }

    const length = Number(slice(cursor, colon));
    const end = colon + 1 + length;
    if (end > size) {
      return null;
    }

    parts.push(slice(colon + 1, end));
    cursor = end;
  }

  return parts;
}

/**
 * A packed stamp as the worker ref it was packed from, or `null` when there is
 * none or it cannot be read. The inverse of {@link packStamp}.
 */
export function unpackStamp(
  packed: string | undefined | null,
): JobWorkerRef | null {
  if (!packed) {
    return null;
  }

  // Every job one worker claimed carries the same stamp, so a page of them —
  // or a stream of claims — decodes one string over and over. A copy is
  // handed out, since a record's `processedBy` is the caller's to change.
  if (packed === unpackMemo.packed) {
    return unpackMemo.ref && { ...unpackMemo.ref };
  }

  const ref = unpackUncached(packed);
  unpackMemo.packed = packed;
  unpackMemo.ref = ref && { ...ref };
  return ref;
}

/** {@link unpackStamp} without the memo, for a non-empty stamp. */
function unpackUncached(packed: string): JobWorkerRef | null {
  const parts = unpackParts(packed);
  const [id, key, host, pid] = parts ?? [];
  if (id === undefined) {
    return null;
  }

  const ref: JobWorkerRef = { id };
  if (key !== undefined) {
    ref.key = key;
  }
  if (host !== undefined) {
    ref.host = host;
  }
  if (pid !== undefined) {
    const value = Number(pid);
    if (pid === "" || !Number.isFinite(value)) {
      return null;
    }
    ref.pid = value;
  }

  return ref;
}
