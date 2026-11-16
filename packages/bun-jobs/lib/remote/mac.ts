/**
 * The protocol core's MAC seam.
 *
 * Every signature and frame MAC in the protocol is HMAC-SHA256, computed
 * through {@link HmacSha256}: WebCrypto by default ({@link subtleHmacSha256}),
 * `node:crypto` injected by the Bun-only host side (`host/mac.ts`). The
 * seam and its byte helpers moved to bun-common with the envelope
 * (`lib/envelope/mac.ts`, PR-P4), so the envelope and the frame codec share
 * one copy, and one cache of imported keys; this module re-exports them.
 *
 * Internal: not exported from `./remote`. Browser-safe.
 */
export {
  cachedKeyIds,
  constantTimeEqual,
  fromHex,
  type HmacSha256,
  KEY_CACHE_SIZE,
  subtleHmacSha256,
  toHex,
  utf8,
} from "@kingsleyweb/bun-common/lib/envelope/mac";
