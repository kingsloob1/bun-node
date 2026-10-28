/**
 * What `cacheResponse()` stores (plan §9.1): one `Uint8Array` per key, framed
 * here rather than handed to the cache's codec as an object, so the bytes of a
 * body cost nothing to encode and the frame reads back the same under the
 * `"structured"` codec (the default) and `"raw"`.
 *
 * ```
 * "B" "H" | version 1 | kind | u32 meta length (LE) | meta (JSON, UTF-8) | body
 * ```
 *
 * Three kinds share the key space:
 *
 * - **response**: a stored response; `meta` is {@link StoredResponseMeta}.
 * - **vary**: the response at a base key varies on request headers (its own
 *   `Vary`, Django's `learn_cache_key`). `meta` names them and carries the
 *   first variant the base key's leader produced, whose body is this frame's
 *   body: a request with the same values is answered from it, and any other
 *   reads the variant key those values give.
 * - **uncacheable**: hit-for-miss (§9.5). The key's last response could not be
 *   stored; requests for it run without coalescing until the marker expires
 *   or a storable response replaces it.
 *
 * A value that is not a frame (a codec that does not keep bytes, such as
 * `"json"`; a key written by something else) decodes as `undefined`: a miss,
 * which the next storable response overwrites.
 */

/** The frame's magic and version. */
const MAGIC_0 = 0x42; // "B"
const MAGIC_1 = 0x48; // "H"
const VERSION = 1;
/** Bytes before the meta: magic (2), version, kind, meta length (u32). */
const PREFIX = 8;

/** A frame's kind byte. */
const KIND_RESPONSE = 1;
const KIND_VARY = 2;
const KIND_UNCACHEABLE = 3;

/** What a stored response carries beside its body. */
export interface StoredResponseMeta {
  /** The status code. */
  status: number;
  /** The status text, when the handler set one; `""` otherwise. */
  statusText: string;
  /**
   * The stored header lines, `[lower-cased name, value]`, in the response's
   * order; `set-cookie` once per line (only with `allowSetCookie`).
   */
  headers: [string, string][];
  /** When the response was stored, epoch ms (the resident time of `Age` counts from here). */
  storedAt: number;
  /** The response's own `Age` when it was stored, in seconds (RFC 9111 §4.2.3's `age_value`); 0 without one. */
  age: number;
  /** When the response stops being fresh, epoch ms; `null` never (a `ttl: null` cache default). */
  freshUntil: number | null;
  /**
   * The stale-while-revalidate window after `freshUntil`, in ms, as the
   * route or the response's `stale-while-revalidate=` gave it; 0 under
   * `must-revalidate` or `proxy-revalidate`. A stale entry inside it is
   * answered `STALE` while a background replay refreshes it.
   */
  staleWhileRevalidate: number;
  /** The stale-if-error window, in ms, under the same rules as `staleWhileRevalidate`: a stale entry inside it answers a failed miss. */
  staleIfError: number;
}

/** A stored response: its meta and its body. */
export interface StoredResponse {
  /** Status, headers and timing. */
  meta: StoredResponseMeta;
  /** The body bytes; empty for a 204 or an empty body. */
  body: Uint8Array;
}

/** A base key's vary record: which request headers select the variant, and the first variant. */
export interface VaryRecord {
  /** The request header names the response varies on, lower-cased, sorted, unique. */
  vary: string[];
  /** The first variant's values of those headers, in `vary`'s order (`""` for an absent header). */
  values: string[];
  /** The first variant's response, answered to a request with the same values. */
  response: StoredResponse;
}

/** A decoded frame. */
export type Frame =
  | { kind: "response"; response: StoredResponse }
  | { kind: "vary"; record: VaryRecord }
  | { kind: "uncacheable" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Frames `meta` and `body` under `kind`. */
function frame(kind: number, meta: unknown, body: Uint8Array): Uint8Array {
  const json = encoder.encode(JSON.stringify(meta));
  const out = new Uint8Array(PREFIX + json.byteLength + body.byteLength);
  out[0] = MAGIC_0;
  out[1] = MAGIC_1;
  out[2] = VERSION;
  out[3] = kind;
  new DataView(out.buffer).setUint32(4, json.byteLength, true);
  out.set(json, PREFIX);
  out.set(body, PREFIX + json.byteLength);
  return out;
}

/** Encodes a stored response. */
export function encodeResponse(response: StoredResponse): Uint8Array {
  return frame(KIND_RESPONSE, response.meta, response.body);
}

/** Encodes a vary record, with its first variant's body as the frame's body. */
export function encodeVary(record: VaryRecord): Uint8Array {
  return frame(
    KIND_VARY,
    { vary: record.vary, values: record.values, meta: record.response.meta },
    record.response.body,
  );
}

/** Encodes the hit-for-miss marker. */
export function encodeUncacheable(): Uint8Array {
  return frame(KIND_UNCACHEABLE, null, new Uint8Array(0));
}

/** Whether `value` is a well-formed {@link StoredResponseMeta}. */
function isResponseMeta(value: unknown): value is StoredResponseMeta {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const meta = value as Partial<StoredResponseMeta>;
  return (
    typeof meta.status === "number" &&
    typeof meta.statusText === "string" &&
    Array.isArray(meta.headers) &&
    meta.headers.every(
      (line) =>
        Array.isArray(line) &&
        line.length === 2 &&
        typeof line[0] === "string" &&
        typeof line[1] === "string",
    ) &&
    typeof meta.storedAt === "number" &&
    typeof meta.age === "number" &&
    (meta.freshUntil === null || typeof meta.freshUntil === "number") &&
    typeof meta.staleWhileRevalidate === "number" &&
    typeof meta.staleIfError === "number"
  );
}

/** Decodes a stored value; `undefined` for anything that is not a well-formed frame. */
export function decodeFrame(value: unknown): Frame | undefined {
  if (!(value instanceof Uint8Array) || value.byteLength < PREFIX) {
    return undefined;
  }
  if (value[0] !== MAGIC_0 || value[1] !== MAGIC_1 || value[2] !== VERSION) {
    return undefined;
  }
  const kind = value[3];
  const length = new DataView(
    value.buffer,
    value.byteOffset,
    value.byteLength,
  ).getUint32(4, true);
  if (PREFIX + length > value.byteLength) {
    return undefined;
  }
  let meta: unknown;
  try {
    meta = JSON.parse(
      decoder.decode(value.subarray(PREFIX, PREFIX + length)),
    ) as unknown;
  } catch {
    return undefined;
  }
  const body = value.subarray(PREFIX + length);
  if (kind === KIND_UNCACHEABLE) {
    return { kind: "uncacheable" };
  }
  if (kind === KIND_RESPONSE) {
    return isResponseMeta(meta)
      ? { kind: "response", response: { meta, body } }
      : undefined;
  }
  if (kind === KIND_VARY) {
    if (typeof meta !== "object" || meta === null) {
      return undefined;
    }
    const record = meta as { vary?: unknown; values?: unknown; meta?: unknown };
    if (
      !Array.isArray(record.vary) ||
      !Array.isArray(record.values) ||
      record.vary.length !== record.values.length ||
      !record.vary.every((name) => typeof name === "string") ||
      !record.values.every((name) => typeof name === "string") ||
      !isResponseMeta(record.meta)
    ) {
      return undefined;
    }
    return {
      kind: "vary",
      record: {
        vary: record.vary,
        values: record.values,
        response: { meta: record.meta, body },
      },
    };
  }
  return undefined;
}
