/**
 * Replay protection: remembering which signed requests were already seen
 * within the replay window (`worker-runtimes.md` §5.6, "Nonce cache").
 *
 * Browser-safe: imports only the package's error types, which import nothing.
 */

import { ConfigError } from "../shared/errors";

/**
 * Where a verifier remembers what it has seen. The built-in one is a bounded
 * in-memory map ({@link createRemoteNonceCache}), which protects a warm
 * instance and degrades to no protection on a cold one; an isolate that
 * wants more plugs in a KV or a Durable Object behind this interface.
 */
export interface RemoteNonceStore {
  /**
   * Records `nonce` as seen until `expiresAt` (epoch ms), and answers whether
   * it was new: `false` means it was already recorded and has not expired —
   * a replay. `now` is the verifier's clock, so a mocked clock reaches the
   * store too. Must be atomic per nonce: two concurrent calls with one nonce
   * may not both answer `true`.
   */
  remember: (
    nonce: string,
    expiresAt: number,
    now: number,
  ) => boolean | Promise<boolean>;
}

/** Options for {@link createRemoteNonceCache}. */
export interface RemoteNonceCacheOptions {
  /**
   * The most nonces held at once. Default `10_000`. Past it the oldest is
   * forgotten, which reopens that one request to a replay: size it above the
   * requests one instance verifies in a replay window.
   */
  max?: number;
}

/** The built-in cache's default size. */
const DEFAULT_MAX = 10_000;

/**
 * A bounded in-memory {@link RemoteNonceStore}. Nonces are held in insertion
 * order, which is near enough expiry order (every expiry is the signature's
 * timestamp plus one window), so expired ones are dropped from the front as
 * new ones arrive: constant work per call, never a sweep.
 */
export function createRemoteNonceCache(
  options?: RemoteNonceCacheOptions,
): RemoteNonceStore {
  const max = options?.max ?? DEFAULT_MAX;
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new ConfigError("A nonce cache's max must be a positive integer", {
      max,
    });
  }
  /** Each nonce held, with when it may be forgotten. */
  const seen = new Map<string, number>();

  return {
    remember(nonce, expiresAt, now) {
      const until = seen.get(nonce);
      if (until !== undefined) {
        if (until > now) {
          return false;
        }
        seen.delete(nonce);
      }
      seen.set(nonce, expiresAt);
      for (const [oldest, oldestUntil] of seen) {
        if (oldestUntil > now && seen.size <= max) {
          break;
        }
        seen.delete(oldest);
      }
      return true;
    },
  };
}
