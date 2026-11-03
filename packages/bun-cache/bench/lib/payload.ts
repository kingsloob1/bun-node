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

/** Bodies of random bytes already built, by length. */
const randomBodies = new Map<number, string>();

/**
 * A deterministic string of `length` **random bytes**: each character a code
 * unit from 0 to 255 (xorshift32, its own fixed seed), so the engine keeps it
 * as a Latin-1 string and the structured codec stores it as exactly those
 * bytes, which no compressor shrinks. `incompressible()` draws from 64
 * symbols, about 6 bits each, which zstd's entropy stage alone takes to
 * three quarters of its size; this is the case it does not reach: what
 * bun-cache's compressibility probe exists for (data already compressed, an
 * image, ciphertext). JSON, which the rivals store, escapes the control
 * characters and writes the upper half as two UTF-8 bytes.
 */
export function randomBytesString(length: number): string {
  const cached = randomBodies.get(length);
  if (cached !== undefined) return cached;

  let state = 0x2545f491;
  const codes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    codes[index] = (state >>> 0) & 255;
  }
  let body = "";
  for (let at = 0; at < length; at += 8192) {
    body += String.fromCharCode(...codes.subarray(at, at + 8192));
  }
  randomBodies.set(length, body);
  return body;
}

/** A value of about `bytes` bytes whose body is random bytes ({@link randomBytesString}). */
export function randomValueOf(bytes: number, id = 0): BenchValue {
  return { id, body: randomBytesString(Math.max(1, bytes - 24)) };
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
