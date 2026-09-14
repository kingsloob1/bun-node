/**
 * Compile-time assertions for {@link ExtractRouteParams}.
 *
 * These are checked by `tsc`, not by `bun test` — the runtime suite in
 * `router.test.ts` proves the matcher produces the same keys these types
 * promise. Run the tests typecheck from CLAUDE.md to verify:
 *
 *   bunx tsc --noEmit --skipLibCheck --target ESNext --module ESNext \
 *     --moduleResolution bundler --strict --allowImportingTsExtensions \
 *     --types bun-types __tests__/routeParams.type-test.ts
 */
import type { ExtractRouteParams } from "../lib/types/routeParams";

/** True only when `X` and `Y` are mutually assignable *and* identical. */
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

/** Fails to compile unless `T` is exactly `true`. */
type Expect<T extends true> = T;

/* --- required params ------------------------------------------------ */
// A path with no params yields an object with no keys.
export type _static = Expect<
  Equal<ExtractRouteParams<"/ping">, Record<never, never>>
>;
export type _one = Expect<
  Equal<ExtractRouteParams<"/user/:id">, { id: string }>
>;
export type _two = Expect<
  Equal<
    ExtractRouteParams<"/api/v1/users/:userId/books/:bookId">,
    { userId: string; bookId: string }
  >
>;

/* --- optional params ------------------------------------------------ */
export type _optional = Expect<
  Equal<ExtractRouteParams<"/home/:name/:id?">, { name: string; id?: string }>
>;
export type _allOptional = Expect<
  Equal<
    ExtractRouteParams<"/search/:category?/:page?">,
    { category?: string; page?: string }
  >
>;

/* --- regexp-constrained params -------------------------------------- */
export type _regex = Expect<
  Equal<ExtractRouteParams<"/n/:id(\\d+)">, { id: string }>
>;
export type _regexOptional = Expect<
  Equal<ExtractRouteParams<"/n/:id(\\d+)?">, { id?: string }>
>;

/* --- wildcards ------------------------------------------------------ */
// A bare `*` publishes only the positional key.
export type _bareWildcard = Expect<
  Equal<ExtractRouteParams<"/assets/*">, { 0: string }>
>;
// A named wildcard publishes both, exactly as the matcher does.
export type _namedWildcard = Expect<
  Equal<ExtractRouteParams<"/assets/*splat">, { 0: string; splat: string }>
>;
export type _bracedWildcard = Expect<
  Equal<ExtractRouteParams<"/assets/{*splat}">, { 0: string; splat: string }>
>;
export type _twoWildcards = Expect<
  Equal<
    ExtractRouteParams<"/f/*a/g/*b">,
    { 0: string; a: string; 1: string; b: string }
  >
>;
export type _mixed = Expect<
  Equal<
    ExtractRouteParams<"/n/:id/*rest">,
    { id: string; 0: string; rest: string }
  >
>;

/* --- degradation ---------------------------------------------------- */
// A path that is not a literal must not resolve to `{}`.
export type _dynamic = Expect<
  Equal<ExtractRouteParams<string>, Record<string, string>>
>;
