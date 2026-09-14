import { Buffer } from "node:buffer";
import { jsonClone } from "@kingsleyweb/bun-common";
import { SerializationError } from "./errors";

/**
 * JSON helpers for values that cross a process, worker or storage boundary.
 *
 * Everything this package persists or sends is JSON: driver columns, Redis
 * strings, IPC messages. These helpers make the boundary explicit — a value
 * is checked (and bounded) where it enters, not where it is finally read.
 */

/** Parses JSON, returning `fallback` instead of throwing on malformed input. */
export function safeJsonParse<T>(
  text: string | null | undefined,
  fallback: T,
): T {
  if (typeof text !== "string" || text.length === 0) {
    return fallback;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Round-trips `value` through JSON, raising {@link SerializationError} with
 * the offending field named rather than letting a `TypeError` about a
 * `BigInt` or a cycle surface from somewhere deep in a driver.
 */
export function assertJsonSafe<T>(value: T, what: string): T {
  try {
    return jsonClone(value);
  } catch (error) {
    throw new SerializationError(what, error);
  }
}

/**
 * Serialises `value`, replacing it with a truncation marker when the result
 * exceeds `maxBytes`. Used for anything stored unbounded-by-nature — a run
 * result, a log payload — so one enormous value cannot bloat a state record.
 *
 * `maxBytes <= 0` means no limit.
 */
export function stringifyBounded(value: unknown, maxBytes: number): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    json = JSON.stringify({
      __unserializable: true,
      preview: String(value).slice(0, 200),
    });
  }

  if (!(maxBytes > 0) || Buffer.byteLength(json, "utf8") <= maxBytes) {
    return json;
  }

  return JSON.stringify({
    __truncated: true,
    bytes: Buffer.byteLength(json, "utf8"),
    preview: json.slice(0, Math.max(0, maxBytes - 64)),
  });
}
