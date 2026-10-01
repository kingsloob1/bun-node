import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { nodeHmacSha256 } from "../../lib/remote/host/mac";
import {
  cachedKeyIds,
  KEY_CACHE_SIZE,
  subtleHmacSha256,
  toHex,
} from "../../lib/remote/mac";

/**
 * The WebCrypto MAC's key cache: imported `CryptoKey`s are cached so a key is
 * not re-imported per message, but the cache is keyed by a one-way digest of
 * the key, never the key itself, and it is bounded.
 */

const encode = (text: string) => new TextEncoder().encode(text);

describe("the WebCrypto key cache", () => {
  it("is keyed by the key's SHA-256, never by the secret or its hex", async () => {
    const secret = "cache-test-secret-0123456789";
    await subtleHmacSha256(encode(secret), encode("m"));
    const ids = cachedKeyIds();
    const digest = createHash("sha256").update(secret).digest("hex");
    expect(ids).toContain(digest);
    for (const id of ids) {
      expect(id).not.toContain(secret);
      expect(id).not.toContain(toHex(encode(secret)));
    }
  });

  it("stays bounded however many keys pass through it", async () => {
    for (let i = 0; i < KEY_CACHE_SIZE + 10; i++) {
      await subtleHmacSha256(encode(`bounded-${i}`), encode("m"));
    }
    expect(cachedKeyIds()).toHaveLength(KEY_CACHE_SIZE);
  });

  it("gives the same bytes as node:crypto, cached or not", async () => {
    const key = encode("same-bytes");
    const expected = nodeHmacSha256(key, encode("payload"));
    expect(await subtleHmacSha256(key, encode("payload"))).toEqual(
      expected as Uint8Array,
    );
    // The second call is served from the cache.
    expect(await subtleHmacSha256(key, encode("payload"))).toEqual(
      expected as Uint8Array,
    );
  });
});
