/**
 * Compile-time assertions for `CacheControlDirectives`, `cacheControl()`,
 * `parseCacheControl()`'s `ParsedCacheControl` and
 * `addResponseTransform`'s `{ first }` (bun-cache plan §9.7, PR-H0).
 *
 * - The plan's contradictions do not compile: `public` with `private` (in
 *   either form), and `noStore` with a lifetime (`maxAge`, `sMaxAge`,
 *   `staleWhileRevalidate`, `staleIfError`, `immutable`).
 * - What RFC 9111 allows does: `noStore` with `mustUnderstand`, `private`
 *   with `noStore`, `false`/`undefined` beside its opposite.
 * - Lifetimes are numbers, field-name lists `readonly string[]`, and the
 *   middleware is a `RouterMiddlewareHandler` the router and the adapter
 *   accept.
 *
 * Checked by `bun run check`; runtime behaviour is `cacheControl.test.ts`
 * and `responseTransforms.test.ts`.
 */
import type { BunResponse, BunResponseTransform } from "../lib/BunResponse";
import type {
  CacheControlDirectives,
  CacheControlOptions,
  ParsedCacheControl,
} from "../lib/index";
import type { RouterMiddlewareHandler } from "../lib/types/general";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import {
  cacheControl,
  formatCacheControl,
  parseCacheControl,
} from "../lib/index";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/* --- accepted -------------------------------------------------------- */

const _assets: CacheControlDirectives = {
  public: true,
  maxAge: 31_536_000,
  immutable: true,
};
const _feed: CacheControlDirectives = {
  sMaxAge: 60,
  staleWhileRevalidate: 30,
  staleIfError: 600,
};
const _me: CacheControlDirectives = { private: true, noStore: true };
const _understand: CacheControlDirectives = {
  noStore: true,
  mustUnderstand: true,
};
const _qualified: CacheControlDirectives = {
  private: ["Set-Cookie"],
  noCache: ["Set-Cookie", "X-Session"],
  maxAge: 0,
  mustRevalidate: true,
  proxyRevalidate: true,
  noTransform: true,
};
const _fields: readonly string[] = ["Set-Cookie"];
const _readonlyFields: CacheControlDirectives = { noCache: _fields };
const _offBeside: CacheControlDirectives = {
  public: false,
  private: true,
  noStore: false,
  maxAge: 5,
};
const _undefinedLifetimes: CacheControlDirectives = {
  noStore: true,
  maxAge: undefined,
  immutable: false,
};
const _empty: CacheControlDirectives = {};
const _isPublic = Math.random() > 0.5;
const _spread: CacheControlDirectives = {
  maxAge: 60,
  ...(_isPublic ? { public: true } : { private: true }),
};

/* --- refused: the contradictions ------------------------------------ */

// @ts-expect-error public with private
const _bothVisibility: CacheControlDirectives = { public: true, private: true };
// @ts-expect-error public with a qualified private
const _bothQualified: CacheControlDirectives = {
  public: true,
  private: ["Set-Cookie"],
};
// @ts-expect-error noStore with maxAge
const _storeMaxAge: CacheControlDirectives = { noStore: true, maxAge: 60 };
// @ts-expect-error noStore with sMaxAge
const _storeSMaxAge: CacheControlDirectives = { noStore: true, sMaxAge: 60 };
// @ts-expect-error noStore with staleWhileRevalidate
const _storeSwr: CacheControlDirectives = {
  noStore: true,
  staleWhileRevalidate: 30,
};
// @ts-expect-error noStore with staleIfError
const _storeSie: CacheControlDirectives = {
  noStore: true,
  staleIfError: 600,
};
// @ts-expect-error noStore with immutable
const _storeImmutable: CacheControlDirectives = {
  noStore: true,
  immutable: true,
};
// A flag in a boolean variable may be set: the pair is refused.
// @ts-expect-error a boolean private beside a boolean public
const _maybeBoth: CacheControlDirectives = {
  public: _isPublic,
  private: !_isPublic,
};

/* --- refused: the wrong types ---------------------------------------- */

// @ts-expect-error a lifetime is a number of seconds, not a string
const _stringAge: CacheControlDirectives = { maxAge: "60" };
// @ts-expect-error no-store takes no field names
const _storeFields: CacheControlDirectives = { noStore: ["Set-Cookie"] };
// @ts-expect-error an unknown key (a typo)
const _typo: CacheControlDirectives = { max_age: 60 };

/* --- the functions --------------------------------------------------- */

const _header: string = formatCacheControl(_assets);
const _middleware: RouterMiddlewareHandler = cacheControl(_feed);
type _middlewareType = Expect<
  Equal<ReturnType<typeof cacheControl>, RouterMiddlewareHandler>
>;
const _options: CacheControlOptions = {
  surrogateControl: { maxAge: 3600, staleIfError: 86_400 },
};
cacheControl(_me, _options);
cacheControl(_me, {
  // @ts-expect-error the surrogate directives are checked the same way
  surrogateControl: { noStore: true, maxAge: 60 },
});
// @ts-expect-error a contradiction is refused at the call too
cacheControl({ public: true, private: true });

const _router = new BunRouter();
_router.get("/assets/*file", cacheControl(_assets), (_req, res) =>
  res.send("x"),
);
_router.use("/feed", cacheControl(_feed));
const _adapter = new BunHttpAdapter();
_adapter.get("/me", cacheControl(_me), (_req, res) => res.json({}));
_adapter.use(cacheControl({ noCache: true }));

/* --- addResponseTransform { first } ---------------------------------- */

declare const _transform: BunResponseTransform;
function _register(res: BunResponse): void {
  const _first: BunResponse = res.addResponseTransform(_transform, {
    first: true,
  });
  const _plain: BunResponse = res.addResponseTransform(_transform);
  const _off: BunResponse = res.addResponseTransform(_transform, {});
  // @ts-expect-error first is a boolean
  res.addResponseTransform(_transform, { first: "yes" });
}

/* --- parseCacheControl ----------------------------------------------- */

const _parsedNull: ParsedCacheControl = parseCacheControl(null);
const _parsedHeader: ParsedCacheControl = parseCacheControl(
  new Headers().get("cache-control"),
);
const _parsedUndefined: ParsedCacheControl = parseCacheControl(undefined);
type _maxAge = Expect<Equal<ParsedCacheControl["maxAge"], number | undefined>>;
type _maxStale = Expect<
  Equal<ParsedCacheControl["maxStale"], number | true | undefined>
>;
type _private = Expect<
  Equal<ParsedCacheControl["private"], true | string[] | undefined>
>;
type _extensions = Expect<
  Equal<
    ParsedCacheControl["extensions"],
    Record<string, string | true> | undefined
  >
>;
// @ts-expect-error a parse result is read, not a value to set
const _flagIsTrue: ParsedCacheControl = { public: false };
// @ts-expect-error only a string (or nothing) is parsed
parseCacheControl(60);
