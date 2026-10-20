/**
 * Compile-time assertions for {@link ExtractRouteParams}.
 *
 * These are checked by `bun check`, not by `bun test` — the runtime suite in
 * `router.test.ts` proves the matcher produces the same keys these types
 * promise. Verify with `bun run check` in the package, or this file alone:
 *
 *   bun check __tests__/routeParams.type-test.ts
 */
import type {
  ExtractRouteParams,
  ParamsDictionary,
} from "../lib/types/routeParams";

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
// A named wildcard publishes its name only, as a `string[]` (Express 5).
export type _namedWildcard = Expect<
  Equal<ExtractRouteParams<"/assets/*splat">, { splat: string[] }>
>;
// Braced, it may be empty, and is then absent.
export type _bracedWildcard = Expect<
  Equal<ExtractRouteParams<"/assets/{*splat}">, { splat?: string[] }>
>;
export type _optionalSlashWildcard = Expect<
  Equal<ExtractRouteParams<"/files{/*path}">, { path?: string[] }>
>;
export type _twoWildcards = Expect<
  Equal<ExtractRouteParams<"/f/*a/g/*b">, { a: string[]; b: string[] }>
>;
export type _mixed = Expect<
  Equal<ExtractRouteParams<"/n/:id/*rest">, { id: string; rest: string[] }>
>;
// routejs's `{*}` stays a bare wildcard.
export type _bracedBare = Expect<
  Equal<ExtractRouteParams<"/r{*}">, { 0: string }>
>;

/* --- path-to-regexp 8 syntax ---------------------------------------- */
export type _optionalGroup = Expect<
  Equal<ExtractRouteParams<"/opt{/:x}">, { x?: string }>
>;
export type _nestedGroups = Expect<
  Equal<
    ExtractRouteParams<"/v{/:a{/:b}}/:id">,
    { a?: string; b?: string; id: string }
  >
>;
export type _inSegment = Expect<
  Equal<ExtractRouteParams<"/u/:a-:b">, { a: string; b: string }>
>;
export type _dotted = Expect<
  Equal<ExtractRouteParams<"/f/:name.:ext">, { name: string; ext: string }>
>;
export type _extensionGroup = Expect<
  Equal<ExtractRouteParams<"/f/:name{.:ext}">, { name: string; ext?: string }>
>;
export type _quoted = Expect<
  Equal<ExtractRouteParams<'/q/:"q x"/:id'>, { "q x": string; id: string }>
>;
export type _dollar = Expect<
  Equal<ExtractRouteParams<"/d/:$x">, { $x: string }>
>;
export type _escaped = Expect<
  Equal<ExtractRouteParams<"/e/\\:x/:y">, { y: string }>
>;

// A quoted wildcard name, as path-to-regexp 8 takes it.
export type _quotedWildcard = Expect<
  Equal<ExtractRouteParams<'/f/*"x y"'>, { "x y": string[] }>
>;
declare const quotedWild: ExtractRouteParams<'/f/*"x y"'>;
// @ts-expect-error a quoted wildcard name has no positional key.
export const _quotedNoPositional = quotedWild[0];

/* --- routejs paths with named wildcards (bridged) ------------------- */
export type _bridged = Expect<
  Equal<
    ExtractRouteParams<"/files/:bucket/:version?/*key">,
    { bucket: string; version?: string; key: string[] }
  >
>;
// Bare groups are numbered among themselves; the named wildcard is not.
export type _bridgedGroup = Expect<
  Equal<ExtractRouteParams<"/n/(\\d+)/*rest">, { 0: string; rest: string[] }>
>;
export type _optionalGroupLegacy = Expect<
  Equal<ExtractRouteParams<"/reports(/archived)?">, { 0?: string }>
>;

/* --- negative controls ---------------------------------------------- */
declare const wild: ExtractRouteParams<"/files/*splat">;
// @ts-expect-error a named wildcard is a `string[]`, not a `string`.
export const _notString: string = wild.splat;
// @ts-expect-error a named wildcard has no positional key.
export const _noPositional = wild[0];
declare const optional: ExtractRouteParams<"/opt{/:x}">;
// @ts-expect-error a key inside `{…}` may be absent.
export const _notRequired: string = optional.x;

/* --- degradation ---------------------------------------------------- */
// A path that is not a literal must not resolve to `{}`: Express 5's own
// `ParamsDictionary` (`@types/express-serve-static-core` 5.1.3).
export type _dynamic = Expect<
  Equal<ExtractRouteParams<string>, ParamsDictionary>
>;
export type _dynamicShape = Expect<
  Equal<
    ParamsDictionary,
    { [key: string]: string | string[]; [key: number]: string }
  >
>;
