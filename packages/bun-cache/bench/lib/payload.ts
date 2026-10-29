/**
 * The values the scenarios store.
 *
 * A value is `{ id, body }`, its `body` a string of the requested length.
 * The string is **incompressible** — drawn from a seeded generator, so it is
 * the same bytes in every process — because bun-cache compresses entries
 * above 16 KiB by default and the rivals do not: filler like `"x".repeat(n)`
 * would shrink to nothing and flatter whoever compresses.
 */

/** The alphabet a body is drawn from: 64 symbols, about 6 bits of entropy each. */
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Bodies already built, by length: building a 1 MB one costs milliseconds. */
const bodies = new Map<number, string>();

/** A deterministic, incompressible string of `length` characters (xorshift32, fixed seed). */
export function incompressible(length: number): string {
  const cached = bodies.get(length);
  if (cached !== undefined) return cached;

  let state = 0x9e3779b9;
  const chars: string[] = Array.from({ length });
  for (let index = 0; index < length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    chars[index] = ALPHABET[(state >>> 0) & 63];
  }
  const body = chars.join("");
  bodies.set(length, body);
  return body;
}

/** One stored value: about `bytes` bytes once serialised. */
export interface BenchValue {
  /** Which value this is, so a read can be checked against what was written. */
  id: number;
  /** The payload. */
  body: string;
}

/** A value of about `bytes` bytes. */
export function valueOf(bytes: number, id = 0): BenchValue {
  return { id, body: incompressible(Math.max(1, bytes - 24)) };
}

/** Whether a read returned the value written under `id` (a miss or another value is not). */
export function isValue(read: unknown, id: number): boolean {
  return (
    typeof read === "object" &&
    read !== null &&
    (read as BenchValue).id === id &&
    typeof (read as BenchValue).body === "string"
  );
}

/**
 * The HTTP scenarios' route body: a page of 100 rows, about 10 KB of JSON,
 * computed on every call — a modest handler, the kind a cache is put in
 * front of.
 */
export function routeBody(): {
  rows: { id: number; name: string; score: number }[];
} {
  const rows: { id: number; name: string; score: number }[] = [];
  for (let id = 0; id < 100; id++) {
    rows.push({
      id,
      name: incompressible(64 + (id % 7)).slice(id % 13),
      score: Math.round(Math.sin(id) * 1_000_000) / 1000,
    });
  }
  return { rows };
}
