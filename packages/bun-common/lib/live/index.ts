/**
 * `@kingsleyweb/bun-common/live` (typed-client plan `websocket.md` §9, PR-W4):
 * live invalidation over one typed channel. {@link liveContract} is the
 * browser-safe half (also reachable alone, for a browser bundle, as
 * `@kingsleyweb/bun-common/lib/live/contract`); {@link liveInvalidation} and
 * {@link publishTags} are the server's. Not part of the package root, so an
 * app that does not use it loads none of it.
 */
export { liveContract } from "./contract";
export {
  type LiveInvalidationOptions,
  liveInvalidation,
  publishTags,
} from "./server";
