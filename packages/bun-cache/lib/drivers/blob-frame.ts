/**
 * The object format the object-store drivers share — S3 (`s3.ts`) and Azure
 * Blob Storage (`azure.ts`): the frame an entry or a counter is stored in,
 * the `Content-Type` that carries an object's kind, expiry and write time,
 * the stamp and lock bodies, the namespace segment, and two small helpers.
 * One definition, so an object one driver wrote reads the same in the other's
 * format and a fix lands in both.
 */
import { encodeSegment } from "./file-names";
import type { StoredEntry } from "../core/types";

/** The frame's magic, "BS". */
export const FRAME_MAGIC = [0x42, 0x53];

/** The frame format's version byte. */
export const FRAME_FORMAT = 1;

/** The fixed part of the frame: magic, format, kind, expiresAt f64. */
export const FRAME_HEAD = 2 + 1 + 1 + 8;

/** The frame's kind byte for an entry. */
export const KIND_ENTRY = 0;

/** The frame's kind byte for a counter. */
export const KIND_COUNTER = 1;

/** The sentinel for "no expiry" in the frame's `expiresAt` slot. */
export const NO_EXPIRY = -1;

/** The `Content-Type` of each kind of object (§7.8). */
export const TYPES = {
  entry: "application/x-bun-cache",
  counter: "application/x-bun-cache-counter",
  stamp: "application/x-bun-cache-stamp",
  lock: "application/x-bun-cache-lock",
} as const;

/** One of the driver's object kinds. */
export type ObjectKind = keyof typeof TYPES;

/** How many requests one operation keeps in flight at once (deletes, `HEAD`s, batch writes). */
export const CONCURRENCY = 16;

/** The most compare-and-swap attempts one counter batch makes before it fails. */
export const MAX_CAS_ATTEMPTS = 100;

/** What one object's `Content-Type` (or, failing it, its frame) says. */
export interface ObjectInfo {
  /** Its kind; `undefined` when the type is not one of the driver's. */
  kind: ObjectKind | undefined;
  /** Its expiry, epoch ms; `null` for none. */
  expiresAt: number | null;
  /** When it was written, epoch ms, when the type says. */
  at: number | undefined;
}

/** A stamp object's body. */
export interface StampBody {
  /** When the tag was invalidated, epoch ms. */
  at: number;
  /** When the stamp itself lapses, epoch ms. */
  until: number;
}

/** A lock object's body. */
export interface LockBody {
  /** Who holds it. */
  owner: string;
  /** When it lapses, epoch ms. */
  expiresAt: number;
}

/** A decoded frame: an entry or a counter. */
export type Frame =
  | {
      /** An entry. */
      kind: "entry";
      /** Its expiry; `null` for none. */
      expiresAt: number | null;
      /** Its tags. */
      tags: string[];
      /** The core's bytes. */
      value: Uint8Array;
    }
  | {
      /** A counter. */
      kind: "counter";
      /** Its expiry; `null` for none. */
      expiresAt: number | null;
      /** Its value. */
      value: number;
      /** When it was created, epoch ms. */
      createdAt: number;
    };

/** One queued `increment` call, waiting for its key's batch. */
export interface PendingIncrement {
  /** What to add. */
  by: number;
  /** The expiry the counter gets if this call creates it. */
  expiresAt: number | null;
  /** Answers the call with its own value. */
  resolve: (value: number) => void;
  /** Fails the call. */
  reject: (error: unknown) => void;
}

export const ENCODER = new TextEncoder();
export const DECODER = new TextDecoder();

/** Hashes a name (a key or a tag) for its object name. */
export function hash(name: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(name);
  return hasher.digest("hex");
}

/**
 * A namespace as one key segment: `encodeSegment`, plus an escape for a
 * segment of dots only, which a URL would resolve as `.`/`..` (encodeSegment
 * never writes a bare `~`, so the escape is unambiguous).
 */
export function segment(ns: string): string {
  const encoded = encodeSegment(ns);
  if (/^\.*$/.test(encoded)) {
    return encoded === "" ? "~" : "~2e".repeat(encoded.length);
  }
  return encoded;
}

/** An object's `Content-Type`: its kind, its expiry and its write time. */
export function contentType(
  kind: ObjectKind,
  expiresAt: number | null,
  at: number,
): string {
  const exp = expiresAt === null ? "" : `; exp=${Math.ceil(expiresAt)}`;
  return `${TYPES[kind]}${exp}; at=${Math.floor(at)}`;
}

/** Reads a `Content-Type` the driver wrote; `kind: undefined` for any other. */
export function parseContentType(type: string | undefined | null): ObjectInfo {
  const [media = "", ...params] = (type ?? "").split(";");
  const name = media.trim().toLowerCase();
  const kind = (Object.keys(TYPES) as ObjectKind[]).find(
    (each) => TYPES[each] === name,
  );
  let expiresAt: number | null = null;
  let at: number | undefined;
  for (const param of params) {
    const [key, value] = param.split("=").map((part) => part.trim());
    const number = Number(value);
    if (value === undefined || value === "" || !Number.isFinite(number)) {
      continue;
    }
    if (key === "exp") {
      expiresAt = number;
    } else if (key === "at") {
      at = number;
    }
  }
  return { kind, expiresAt, at };
}

/** Encodes an entry's frame. */
export function encodeEntry(entry: StoredEntry): Uint8Array {
  const tags = entry.tags.map((tag) => ENCODER.encode(tag));
  const tagsLength = tags.reduce((total, tag) => total + 2 + tag.length, 0);
  const out = new Uint8Array(FRAME_HEAD + 2 + tagsLength + entry.value.length);
  const view = new DataView(out.buffer);
  writeHead(out, view, KIND_ENTRY, entry.expiresAt);
  view.setUint16(FRAME_HEAD, tags.length, true);
  let offset = FRAME_HEAD + 2;
  for (const tag of tags) {
    view.setUint16(offset, tag.length, true);
    out.set(tag, offset + 2);
    offset += 2 + tag.length;
  }
  out.set(entry.value, offset);
  return out;
}

/** Encodes a counter's frame. */
export function encodeCounter(
  value: number,
  expiresAt: number | null,
  createdAt: number,
): Uint8Array {
  const out = new Uint8Array(FRAME_HEAD + 16);
  const view = new DataView(out.buffer);
  writeHead(out, view, KIND_COUNTER, expiresAt);
  view.setFloat64(FRAME_HEAD, value, true);
  view.setFloat64(FRAME_HEAD + 8, createdAt, true);
  return out;
}

/** Writes the frame's fixed head. */
function writeHead(
  out: Uint8Array,
  view: DataView,
  kind: number,
  expiresAt: number | null,
): void {
  out[0] = FRAME_MAGIC[0];
  out[1] = FRAME_MAGIC[1];
  out[2] = FRAME_FORMAT;
  out[3] = kind;
  view.setFloat64(4, expiresAt ?? NO_EXPIRY, true);
}

/** Decodes a frame's fixed head; `undefined` when the bytes are not a frame. */
export function decodeHead(
  bytes: Uint8Array,
): { kind: number; expiresAt: number | null } | undefined {
  if (
    bytes.length < FRAME_HEAD ||
    bytes[0] !== FRAME_MAGIC[0] ||
    bytes[1] !== FRAME_MAGIC[1] ||
    bytes[2] !== FRAME_FORMAT
  ) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const expiresAt = view.getFloat64(4, true);
  return {
    kind: bytes[3],
    expiresAt: expiresAt === NO_EXPIRY ? null : expiresAt,
  };
}

/** Decodes a whole frame; `undefined` when the bytes are not one. */
export function decodeFrame(bytes: Uint8Array): Frame | undefined {
  const head = decodeHead(bytes);
  if (head === undefined) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (head.kind === KIND_COUNTER) {
    if (bytes.length < FRAME_HEAD + 16) {
      return undefined;
    }
    return {
      kind: "counter",
      expiresAt: head.expiresAt,
      value: view.getFloat64(FRAME_HEAD, true),
      createdAt: view.getFloat64(FRAME_HEAD + 8, true),
    };
  }
  if (head.kind !== KIND_ENTRY || bytes.length < FRAME_HEAD + 2) {
    return undefined;
  }
  const count = view.getUint16(FRAME_HEAD, true);
  let offset = FRAME_HEAD + 2;
  const tags: string[] = [];
  for (let index = 0; index < count; index++) {
    if (offset + 2 > bytes.length) {
      return undefined;
    }
    const length = view.getUint16(offset, true);
    if (offset + 2 + length > bytes.length) {
      return undefined;
    }
    tags.push(DECODER.decode(bytes.subarray(offset + 2, offset + 2 + length)));
    offset += 2 + length;
  }
  return {
    kind: "entry",
    expiresAt: head.expiresAt,
    tags,
    value: bytes.slice(offset),
  };
}

/** Runs `run` over `items`, at most `limit` at a time; answers the results in order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = Array.from<R>({ length: items.length });
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await run(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/** Waits a jittered, growing backoff after a lost compare-and-swap. */
export async function backoff(attempt: number): Promise<void> {
  await Bun.sleep(Math.min(2 * 1.5 ** attempt, 100) * (0.5 + Math.random()));
}
