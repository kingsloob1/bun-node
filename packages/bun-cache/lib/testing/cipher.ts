/**
 * `runCacheCipherConformance` (the encryption plan's §6.3): what every user
 * cipher must do, as a `bun:test` suite. A cipher's own test file runs it:
 *
 * ```ts
 * import { runCacheCipherConformance } from "@kingsleyweb/bun-cache/testing";
 *
 * runCacheCipherConformance("kms-cipher", kmsCipher);
 * ```
 *
 * The contexts it seals under are built the way the core builds them
 * (`cipherContext`), so a cipher that passes here sees the same AAD in a
 * cache. A cipher that ignores the AAD fails the suite.
 */
import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createCache } from "../core/cache";
import { cipherContext, CUSTOM_CIPHER_RANGE } from "../core/encrypt";
import type { CacheCipher, CacheCipherContext } from "../core/types";
import { memoryDriver } from "../drivers/memory";

/** The plaintext sizes a round trip covers: empty, small, a typical compressed page, and the 1 MiB the drivers' kit writes. */
const SIZES = [0, 100, 70_000, 1024 * 1024] as const;

/** A recognisable run of bytes the plaintexts are built from, searched for in the sealed output. */
const SENTINEL = new TextEncoder().encode(
  "bun-cache cipher conformance :: plaintext sentinel",
);

/** A plaintext of `size` bytes: the sentinel, repeated. */
function plaintext(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let at = 0; at < size; at += SENTINEL.length) {
    out.set(SENTINEL.subarray(0, Math.min(SENTINEL.length, size - at)), at);
  }
  return out;
}

/** The context of `namespace` and `key`, with `aad` as the cache's `encrypt.aad`, for `cipher`. */
function contextOf(
  cipher: CacheCipher,
  namespace = "conformance@v1:users",
  key = "user:42",
  aad = "conformance",
): CacheCipherContext {
  return cipherContext(
    namespace,
    key,
    new TextEncoder().encode(aad),
    cipher.id,
  );
}

/** Seals, awaiting a promise, and checks the answer is bytes. */
async function seal(
  cipher: CacheCipher,
  bytes: Uint8Array,
  context: CacheCipherContext,
): Promise<Uint8Array> {
  const sealed = await cipher.seal(bytes.slice(), context);
  expect(sealed).toBeInstanceOf(Uint8Array);
  return sealed;
}

/** Asserts that opening `sealed` under `context` throws or rejects. */
async function expectRefused(
  cipher: CacheCipher,
  sealed: Uint8Array,
  context: CacheCipherContext,
): Promise<void> {
  let opened: Uint8Array | undefined;
  let threw = false;
  try {
    opened = await cipher.open(sealed.slice(), context);
  } catch {
    threw = true;
  }
  expect({ threw, opened: opened === undefined ? undefined : "bytes" }).toEqual(
    {
      threw: true,
      opened: undefined,
    },
  );
}

/**
 * Registers the cipher contract for `cipher` as a `bun:test` suite: its id in
 * 128–255; a round trip at 0 B, 100 B, 70 KB and 1 MiB; no plaintext in the
 * sealed bytes; two seals of one input differing (a random nonce); a flipped
 * bit, a truncation, and a changed `aad`, namespace or key each refused; and
 * a round trip through a real `createCache`. Sync and async ciphers alike —
 * every answer is awaited.
 *
 * @param name The suite's name, after `"cache cipher conformance: "`.
 * @param cipher The cipher under test.
 */
export function runCacheCipherConformance(
  name: string,
  cipher: CacheCipher,
): void {
  describe(`cache cipher conformance: ${name}`, () => {
    test("its id is an integer in 128–255", () => {
      expect(Number.isInteger(cipher.id)).toBe(true);
      expect(cipher.id).toBeGreaterThanOrEqual(CUSTOM_CIPHER_RANGE.min);
      expect(cipher.id).toBeLessThanOrEqual(CUSTOM_CIPHER_RANGE.max);
    });

    for (const size of SIZES) {
      test(`a ${size}-byte plaintext round-trips`, async () => {
        const input = plaintext(size);
        const context = contextOf(cipher);
        const sealed = await seal(cipher, input, context);
        const opened = await cipher.open(sealed.slice(), context);
        expect(opened).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(opened).equals(Buffer.from(input))).toBe(true);
      });
    }

    test("the sealed bytes do not contain the plaintext", async () => {
      const sealed = await seal(cipher, plaintext(4096), contextOf(cipher));
      expect(Buffer.from(sealed).indexOf(Buffer.from(SENTINEL))).toBe(-1);
    });

    test("two seals of one input differ (a random nonce)", async () => {
      const input = plaintext(100);
      const context = contextOf(cipher);
      const first = await seal(cipher, input, context);
      const second = await seal(cipher, input, context);
      expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
    });

    test("a flipped bit is refused, wherever it is", async () => {
      const context = contextOf(cipher);
      const sealed = await seal(cipher, plaintext(100), context);
      for (const at of [0, sealed.length >> 1, sealed.length - 1]) {
        const flipped = sealed.slice();
        flipped[at] ^= 0x01;
        await expectRefused(cipher, flipped, context);
      }
    });

    test("a truncated entry is refused", async () => {
      const context = contextOf(cipher);
      const sealed = await seal(cipher, plaintext(100), context);
      await expectRefused(
        cipher,
        sealed.subarray(0, sealed.length - 1),
        context,
      );
      await expectRefused(
        cipher,
        sealed.subarray(0, sealed.length >> 1),
        context,
      );
      await expectRefused(cipher, new Uint8Array(0), context);
    });

    test("a changed aad is refused (encrypt.aad differs)", async () => {
      const sealed = await seal(cipher, plaintext(100), contextOf(cipher));
      await expectRefused(
        cipher,
        sealed,
        contextOf(cipher, undefined, undefined, "conformance-other"),
      );
    });

    test("a changed namespace is refused (an entry copied to another namespace)", async () => {
      const sealed = await seal(cipher, plaintext(100), contextOf(cipher));
      await expectRefused(
        cipher,
        sealed,
        contextOf(cipher, "conformance@v1:tenants"),
      );
    });

    test("a changed key is refused (an entry swapped with another key's)", async () => {
      const sealed = await seal(cipher, plaintext(100), contextOf(cipher));
      await expectRefused(
        cipher,
        sealed,
        contextOf(cipher, undefined, "user:43"),
      );
    });

    test("it round-trips through createCache", async () => {
      const driver = memoryDriver();
      const cache = createCache({
        driver,
        namespace: "conformance",
        sweepInterval: 0,
        encrypt: { cipher },
      });
      const errors: unknown[] = [];
      cache.on("error", (event) => {
        errors.push(event.error);
      });
      try {
        const value = { name: "Ada", bytes: plaintext(100) };
        expect(await cache.set("user:42", value, { tags: ["users"] })).toBe(
          true,
        );
        expect(await cache.get("user:42")).toEqual(value);
        const stored = await driver.get("conformance", "user:42");
        expect(stored).toBeDefined();
        // The value's bytes carry the sentinel; the stored entry must not.
        expect(Buffer.from(stored!.value).indexOf(Buffer.from(SENTINEL))).toBe(
          -1,
        );
        expect(errors).toEqual([]);
      } finally {
        await cache.close();
      }
    });
  });
}
