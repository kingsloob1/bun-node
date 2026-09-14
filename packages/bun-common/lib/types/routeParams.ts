/**
 * Compile-time extraction of a route's parameters from its path literal.
 *
 * Mirrors what `BunRouter` produces at runtime, so the types never promise a
 * key the matcher does not set:
 *
 * - `:name`            → `{ name: string }`
 * - `:name?`           → `{ name?: string }`
 * - `:name(\d+)`       → `{ name: string }` (the constraint does not change the key)
 * - `*name` / `{*name}`→ `{ name: string }` **and** the positional key it also
 *                        publishes (`"0"`, `"1"`, … in order of appearance)
 * - `*`                → the positional key only
 *
 * A non-literal path (a `string` variable) degrades to
 * `Record<string, string>` rather than resolving to `{}`, so dynamic
 * registration keeps working untyped instead of appearing to have no params.
 */

/**
 * Contributes nothing to the params object. `Record<never, never>` rather than
 * `{}`, which would widen to "any non-nullish value" in an intersection.
 */
type NoParams = Record<never, never>;

/**
 * Flattens an intersection into a single object literal for readable hovers.
 * Homomorphic, so `?` modifiers on optional params survive.
 */
type Prettify<T> = { [K in keyof T]: T[K] };

/** Positional keys routejs assigns to wildcards, in order of appearance. */
type WildcardKeys = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/** Drops a `(regex)` constraint from a `:param` token. */
type StripRegex<S extends string> = S extends `${infer Name}(${string}`
  ? Name
  : S;

/** Splits a `:param` token into its key and whether it is optional. */
type ParseParam<Raw extends string> = Raw extends `${infer Head}?`
  ? { key: StripRegex<Head>; optional: true }
  : { key: StripRegex<Raw>; optional: false };

/** The wildcard's declared name, or `never` for a bare `*`. */
type WildcardName<Seg extends string> = Seg extends `{*${infer Name}}`
  ? Name extends ""
    ? never
    : Name
  : Seg extends `*${infer Name}`
    ? Name extends ""
      ? never
      : Name
    : never;

/** True when a segment is any wildcard form. */
type IsWildcard<Seg extends string> = Seg extends
  | `{*${string}}`
  | `*${string}`
  | "*"
  ? true
  : false;

/** Params contributed by one path segment, given the wildcards seen so far. */
type SegmentParams<
  Seg extends string,
  Seen extends readonly unknown[],
> = Seg extends `:${infer Raw}`
  ? ParseParam<Raw> extends { key: infer K extends string; optional: true }
    ? { [P in K]?: string }
    : ParseParam<Raw> extends { key: infer K extends string }
      ? { [P in K]: string }
      : NoParams
  : IsWildcard<Seg> extends true
    ? { [P in WildcardKeys[Seen["length"]] & string]: string } & ([
        WildcardName<Seg>,
      ] extends [never]
        ? NoParams
        : { [P in WildcardName<Seg>]: string })
    : NoParams;

/** Advances the wildcard counter past a wildcard segment. */
type CountWildcard<Seg extends string, Seen extends readonly unknown[]> =
  IsWildcard<Seg> extends true ? [...Seen, unknown] : Seen;

/** Walks the `/`-separated segments, threading the wildcard counter. */
type WalkPath<
  P extends string,
  Seen extends readonly unknown[] = [],
> = P extends `${infer Seg}/${infer Rest}`
  ? SegmentParams<Seg, Seen> & WalkPath<Rest, CountWildcard<Seg, Seen>>
  : SegmentParams<P, Seen>;

/** The `params` object a handler registered at `P` receives. */
export type ExtractRouteParams<P extends string> = string extends P
  ? Record<string, string>
  : Prettify<WalkPath<P>>;
