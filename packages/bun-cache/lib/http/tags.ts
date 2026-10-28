/**
 * `addCacheTags(res, ...tags)` (plan §9.3): a handler tags the response it is
 * producing, so `cache.invalidateTags()` can drop it later. The tags live in
 * a `WeakMap` keyed by the response, read by `cacheResponse()` when it
 * stores; nothing is kept once the response is gone.
 */
import type { BunResponse } from "@kingsleyweb/bun-common";

/** The tags added to each response still being produced. */
const RESPONSE_TAGS = new WeakMap<BunResponse, Set<string>>();

/**
 * Tags the response `res` is producing, for the `cacheResponse()` that
 * stores it: the entry carries these beside the route's `tags` and the
 * path's own tag, and `cache.invalidateTags([tag])` drops it.
 *
 * ```ts
 * router.get("/posts/:id", pages, async (req, res) => {
 *   const post = await loadPost(req.params.id);
 *   addCacheTags(res, `post:${post.id}`, `author:${post.authorId}`);
 *   res.json(post);
 * });
 * ```
 *
 * Call it before the response is sent: the cache reads the tags when it
 * captures the response. A response no `cacheResponse()` stores ignores them.
 */
export function addCacheTags(
  res: BunResponse,
  ...tags: readonly string[]
): void {
  let set = RESPONSE_TAGS.get(res);
  if (set === undefined) {
    set = new Set();
    RESPONSE_TAGS.set(res, set);
  }
  for (const tag of tags) {
    if (typeof tag !== "string" || tag === "") {
      throw new TypeError("addCacheTags: a tag must be a non-empty string");
    }
    set.add(tag);
  }
}

/** The tags {@link addCacheTags} added to `res`; empty when none. */
export function responseTags(res: BunResponse): readonly string[] {
  const set = RESPONSE_TAGS.get(res);
  return set === undefined ? [] : [...set];
}
