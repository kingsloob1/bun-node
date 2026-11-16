/**
 * The signed envelope's MAC seam, moved from bun-jobs' `lib/remote/mac.ts`
 * (bun-security plan §15.1, PR-P4) unchanged.
 *
 * Every signature and frame MAC is HMAC-SHA256, computed through one
 * function type, {@link HmacSha256}. The default, {@link subtleHmacSha256},
 * is WebCrypto: it runs in a browser and in a V8 isolate (an executor on
 * Cloudflare or Deno Deploy). A Bun-only caller may inject `node:crypto`
 * instead (bun-jobs' `remote/host/mac.ts`), which bun-jobs' Phase 2 slicing
 * spike measured at ~5 µs against ~28 µs per frame
 * (`docs/plans/worker-runtimes/evidence/phase2-slicing/`). Both produce the
 * same bytes; the tests pin that against fixed vectors.
 *
 * `HmacSha256` and `subtleHmacSha256` are public (`./envelope`); the byte
 * helpers are bun-jobs' frame codec's, reached by its deep import.
 * Browser-safe: no imports.
 */

/** HMAC-SHA256 of `message` under `key`: 32 bytes. */
export type HmacSha256 = (
  key: Uint8Array,
  message: Uint8Array,
) => Uint8Array | Promise<Uint8Array>;

/** UTF-8, shared so every call encodes the same way. */
const encoder = new TextEncoder();

/** The UTF-8 bytes of a string. */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Hex digits, by nibble. */
const HEX = "0123456789abcdef";

/** Lower-case hex of some bytes. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX[byte >> 4] + HEX[byte & 15];
  }
  return out;
}

/** The bytes of a hex string of even length, either case; `undefined` when it is not hex. */
export function fromHex(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0 || !/^[\da-f]*$/i.test(hex)) {
    return undefined;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/**
 * Compares two byte strings in time that depends only on their lengths, never
 * on where they first differ. A `===` on hex is a timing oracle.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

/** Imported keys are cached, at most this many. */
export const KEY_CACHE_SIZE = 32;

/**
 * WebCrypto keys already imported, oldest first, by the SHA-256 of the key
 * bytes in hex: a one-way id, so the module never holds a secret as a map
 * key, and a key rotated out leaves only its digest behind until it is
 * evicted. Bounded by {@link KEY_CACHE_SIZE}.
 */
const keyCache = new Map<string, Promise<CryptoKey>>();

/** The imported HMAC key for some bytes, from the cache when it is there. */
async function importKey(key: Uint8Array): Promise<CryptoKey> {
  // The casts, as on `importKey` below, are for a project whose WebCrypto
  // declarations take only an `ArrayBuffer`-backed view (`benchmarks/`'s).
  const id = toHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", key as Uint8Array<ArrayBuffer>),
    ),
  );
  let found = keyCache.get(id);
  if (found === undefined) {
    found = crypto.subtle.importKey(
      "raw",
      key as Uint8Array<ArrayBuffer>,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    // A failed import must not stay cached.
    found.catch(() => keyCache.delete(id));
    keyCache.set(id, found);
    if (keyCache.size > KEY_CACHE_SIZE) {
      keyCache.delete(keyCache.keys().next().value!);
    }
  }
  return found;
}

/** HMAC-SHA256 through WebCrypto: the browser-safe default. */
export const subtleHmacSha256: HmacSha256 = async (key, message) =>
  new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await importKey(key),
      message as Uint8Array<ArrayBuffer>,
    ),
  );

/** The cache's ids, oldest first: for tests, which check what it holds. */
export function cachedKeyIds(): string[] {
  return [...keyCache.keys()];
}
