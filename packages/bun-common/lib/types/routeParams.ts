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

/*
 * Host patterns — what `domain(":tenant.example.com", …)` captures.
 *
 * `@routejs/router` tokenises a host exactly like a path, with `.` as the
 * delimiter instead of `/`, and `BunRouter` merges the captures into
 * `req.params`. So, mirroring its `host-regex` tokenizer:
 *
 * - `:name`            → `{ name: string }`; a name is `[A-Za-z0-9_]+`, so it
 *                        may end mid-label (`:tenant-:region.example.com`)
 * - `:name?`           → `{ name?: string }`
 * - `:name(regex)`     → `{ name: string }` (and `:name(regex)?` optional)
 * - `*`                → a positional key (`"0"`, `"1"`, …)
 * - `(regex)`          → a positional key too, from the same counter as `*`
 * - `\:`               → an escaped character, not a param
 *
 * A non-literal host (a `string` variable) degrades to
 * `Record<string, string>`; a host with no captures gives no params.
 */

/**
 * Every character in `S`, as a union. Accumulates, so the recursion is in tail
 * position and not bounded by TypeScript's shallow nesting limit.
 */
type CharsOf<
  S extends string,
  Chars extends string = never,
> = S extends `${infer C}${infer Rest}` ? CharsOf<Rest, Chars | C> : Chars;

/** The characters routejs accepts in a param name. */
type NameChar =
  CharsOf<"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_">;

/** Splits a param name off the front of `S`: `[name, rest]`. */
type TakeName<
  S extends string,
  Name extends string = "",
> = S extends `${infer C}${infer Rest}`
  ? C extends NameChar
    ? TakeName<Rest, `${Name}${C}`>
    : [Name, S]
  : [Name, S];

/**
 * What follows a `(regex)` group, given the text after its opening `(`.
 * Nested groups and escaped characters are skipped, as the tokenizer does.
 */
type SkipGroup<
  S extends string,
  Depth extends readonly unknown[] = [],
> = S extends `\\${string}${infer Rest}`
  ? SkipGroup<Rest, Depth>
  : S extends `(${infer Rest}`
    ? SkipGroup<Rest, [...Depth, unknown]>
    : S extends `)${infer Rest}`
      ? Depth extends [unknown, ...infer Outer]
        ? SkipGroup<Rest, Outer>
        : Rest
      : S extends `${string}${infer Rest}`
        ? SkipGroup<Rest, Depth>
        : "";

/** `S` with an optional `(regex)` constraint skipped. */
type AfterConstraint<S extends string> = S extends `(${infer Rest}`
  ? SkipGroup<Rest>
  : S;

/**
 * Walks a host pattern, collecting required and optional keys. Tail-recursive,
 * so a long host stays within TypeScript's recursion limit.
 */
type WalkHost<
  S extends string,
  Required extends string = never,
  Optional extends string = never,
  Seen extends readonly unknown[] = [],
> = S extends `\\${string}${infer Rest}`
  ? WalkHost<Rest, Required, Optional, Seen>
  : S extends `:${infer Rest}`
    ? TakeName<Rest> extends [
        infer Name extends string,
        infer After extends string,
      ]
      ? AfterConstraint<After> extends `?${infer Tail}`
        ? WalkHost<Tail, Required, Optional | Name, Seen>
        : WalkHost<AfterConstraint<After>, Required | Name, Optional, Seen>
      : never
    : S extends `*${infer Rest}`
      ? WalkHost<
          Rest,
          Required | (WildcardKeys[Seen["length"]] & string),
          Optional,
          [...Seen, unknown]
        >
      : S extends `(${infer Rest}`
        ? SkipGroup<Rest> extends `?${infer Tail}`
          ? WalkHost<
              Tail,
              Required,
              Optional | (WildcardKeys[Seen["length"]] & string),
              [...Seen, unknown]
            >
          : WalkHost<
              SkipGroup<Rest>,
              Required | (WildcardKeys[Seen["length"]] & string),
              Optional,
              [...Seen, unknown]
            >
        : S extends `${string}${infer Rest}`
          ? WalkHost<Rest, Required, Optional, Seen>
          : [Required, Optional];

/** Builds the params object from the keys {@link WalkHost} collected. */
type HostParamsOf<Keys> = Keys extends [
  infer Required extends string,
  infer Optional extends string,
]
  ? [Required | Optional] extends [never]
    ? NoParams
    : Prettify<
        { [K in Required]: string } & {
          [K in Exclude<Optional, Required>]?: string;
        }
      >
  : NoParams;

/**
 * The params a host pattern `H` puts on `req.params`:
 * `ExtractHostParams<":tenant.example.com">` is `{ tenant: string }`.
 */
export type ExtractHostParams<H extends string> = string extends H
  ? Record<string, string>
  : HostParamsOf<WalkHost<H>>;

/**
 * Path params merged over host params, as the matcher merges them: a path
 * param of the same name wins. With no host params, `TParams` is returned
 * unchanged.
 */
export type WithHostParams<TParams, THostParams> = [keyof THostParams] extends [
  never,
]
  ? TParams
  : Prettify<Omit<THostParams, keyof TParams> & TParams>;
