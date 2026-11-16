/**
 * Replay protection: remembering which signed requests were already seen
 * within the replay window (`worker-runtimes/README.md` §5.6, "Nonce cache").
 *
 * The store's interface and the bounded cache moved to bun-common
 * (`@kingsleyweb/bun-common/envelope`, PR-P4); this module re-exports the
 * interface and binds the cache to bun-jobs' `ConfigError`, unchanged.
 *
 * Browser-safe: bun-common's envelope entry imports no Bun or Node API.
 */

import type {
  RemoteNonceCacheOptions,
  RemoteNonceStore,
} from "@kingsleyweb/bun-common/envelope";
import { remoteCodec } from "./signing";

export type {
  RemoteNonceCacheOptions,
  RemoteNonceStore,
} from "@kingsleyweb/bun-common/envelope";

/**
 * A bounded in-memory {@link RemoteNonceStore}. Nonces are held in insertion
 * order, which is near enough expiry order (every expiry is the signature's
 * timestamp plus one window), so expired ones are dropped from the front as
 * new ones arrive: constant work per call, never a sweep. Throws bun-jobs'
 * `ConfigError` for a `max` that is not a positive integer.
 */
export function createRemoteNonceCache(
  options?: RemoteNonceCacheOptions,
): RemoteNonceStore {
  return remoteCodec.createRemoteNonceCache(options);
}
