/**
 * The typed slot of `cacheResponse()` (plan §9.6) against the real
 * middleware and bun-common's real `validate()`, and the options' types.
 * Each `@ts-expect-error` is a negative control: it must error, and it must
 * be there.
 *
 * The plan's brand, `__shape?: never`, is shown here to be unusable (cases
 * 5 and 6): bun-common's verb overloads read it in the validator slot
 * *whatever* precedes it, so it poisons the ordinary `get(path, pages,
 * handler)` as much as the misplaced `get(path, validate, pages, handler)`.
 * `cacheResponse()` therefore returns a plain `RouterHandler` (with
 * `invalidate`), and the misplacement is documented, not caught.
 *
 * Checked by `bun run check`, not by `bun test`.
 */
import type {
  BunRequest,
  RouterHandler,
  StandardSchemaV1,
} from "@kingsleyweb/bun-common";
import { BunRouter, validate } from "@kingsleyweb/bun-common";
import { createCache, memoryDriver } from "../lib/index";
import type {
  CacheResponseMiddleware,
  CacheResponseOptions,
  CacheStatus,
  CoalesceRequestsOptions,
} from "../lib/http/index";
import {
  addCacheTags,
  cacheResponse,
  coalesceRequests,
} from "../lib/http/index";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

declare const QuerySchema: StandardSchemaV1<unknown, { page: number }>;
const cache = createCache({ driver: memoryDriver() });
const pages = cacheResponse(cache, { ttl: 60_000 });
const router = new BunRouter();

// 1. Before the validator (the documented placement): the handler keeps its
// typed query, and its response is unconstrained.
router.get("/a", pages, validate({ query: QuerySchema }), (req, res) => {
  type _ = Expect<Equal<typeof req.query, { page: number }>>;
  res.send(String(req.query.page));
});

// 2. Between the validator and the handler (documented as wrong): the
// validated type is lost, as behind any plain middleware.
router.get("/b", validate({ query: QuerySchema }), pages, (req) => {
  // @ts-expect-error -- the validated query is lost behind the cache
  type _ = Expect<Equal<typeof req.query, { page: number }>>;
  void req;
});

// 3. Alone: the handler's request and response are what they are behind any
// plain middleware (whose slot, in bun-common's overloads, also widens the
// path's params to the dictionary — not this package's doing).
router.get("/c/:id", pages, (req, res) => {
  const id = String(req.params.id);
  type _queryUsable = Expect<
    Equal<[typeof req.query] extends [never] ? true : false, false>
  >;
  res.send(`${id} ${String(req.query.q)}`);
});

// 4. As subtree middleware.
router.use("/d", pages);

// 5–6. Why the plan's brand is not applied: a `__shape?: never` handler in
// the validator slot makes the shape `never` for the handler after it, so
// even the ordinary placement loses its response and query.
declare const branded: RouterHandler & { readonly __shape?: never };
router.get("/e", branded, (req, res) => {
  // @ts-expect-error -- res.send() now wants a `Response`
  res.send("x");
  // @ts-expect-error -- req.query is `never`
  void req.query.q;
});

// The returned middleware is a RouterHandler with invalidate().
export const _isHandler: RouterHandler = pages;
export type _invalidate = Expect<
  Equal<
    CacheResponseMiddleware["invalidate"],
    (target: string | Request | BunRequest) => Promise<void>
  >
>;
export type _status = Expect<
  Equal<CacheStatus, "HIT" | "MISS" | "STALE" | "BYPASS" | "UNCACHEABLE">
>;

// Options.
export const _options: CacheResponseOptions = {
  ttl: "headers",
  tags: (req) => [`p:${String(req.params.id)}`],
  varyBy: ["accept-language"],
  query: ["page"],
  host: true,
  key: (req) => req.originalUrl,
  bypass: (req) => req.getHeader("x-preview") === "1",
  statusHeader: false,
  honorRequest: true,
  allowSetCookie: false,
  statuses: [200],
  omitHeaders: ["x-debug"],
  invalidateOnUnsafe: true,
  coalesce: { wait: 5_000 },
  uncacheableTtl: 0,
  etag: true,
};
// @ts-expect-error -- ttl is ms or "headers"
cacheResponse(cache, { ttl: "60s" });
// @ts-expect-error -- query is "all", a list of names, or false
cacheResponse(cache, { query: true });

export const _coalesce: CoalesceRequestsOptions = {
  key: (req) => req.originalUrl,
  wait: 1_000,
};
export const _coalesced: RouterHandler = coalesceRequests();
declare const res: Parameters<RouterHandler>[1];
addCacheTags(res, "a", "b");
