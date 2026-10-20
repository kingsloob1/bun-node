/**
 * Compile-time extraction of a route's parameters from its path literal.
 *
 * Mirrors what `BunRouter` produces at runtime (path-to-regexp 8 / Express 5
 * semantics, with routejs's legacy forms still typed), so the types never
 * promise a key the matcher does not set:
 *
 * - `:name`              → `{ name: string }`; a name ends at the first ASCII
 *                          character that is not `[A-Za-z0-9_$]`, so
 *                          `:a-:b` is `{ a: string; b: string }`
 * - `:"any name"`        → `{ "any name": string }`
 * - `*name`, `*"any name"` → `{ name: string[] }`, split on `/` (no positional
 *                          key). The array is frozen at runtime (it is shared
 *                          through the route cache): copy it to change it
 * - `{…}`                → every key inside it optional: `{/:x}` is
 *                          `{ x?: string }`, `{/*name}` and `{*name}` are
 *                          `{ name?: string[] }` (absent when empty)
 * - `\x`                → an escaped character, not a param
 * - `:name?` (routejs)   → `{ name?: string }`
 * - `:name(\d+)` (routejs) → `{ name: string }` (the constraint does not change the key)
 * - `*`, `{*}`, `(…)` (routejs) → a positional key (`"0"`, `"1"`, … in order
 *                          of appearance), optional for `(…)?`
 *
 * A non-literal path (a `string` variable) degrades to {@link ParamsDictionary},
 * Express 5's own untyped shape, rather than resolving to `{}`, so dynamic
 * registration keeps working untyped instead of appearing to have no params.
 */

/**
 * `req.params` when the path is not a literal: Express 5's `ParamsDictionary`
 * (`@types/express-serve-static-core` 5.x), the same shape. A named key is a
 * `string` or, for a wildcard, a `string[]`; a positional key (a bare `*`) is
 * a `string`.
 */
export interface ParamsDictionary {
  [key: string]: string | string[];
  [key: number]: string;
}

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

/** Positional keys routejs assigns to bare wildcards and groups, in order of appearance. */
type WildcardKeys = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/** The positional key the `N`th bare capture gets. */
type Positional<N extends readonly unknown[]> = WildcardKeys[N["length"]] &
  string;

/**
 * Every character in `S`, as a union. Accumulates, so the recursion is in tail
 * position and not bounded by TypeScript's shallow nesting limit.
 */
type CharsOf<
  S extends string,
  Chars extends string = never,
> = S extends `${infer C}${infer Rest}` ? CharsOf<Rest, Chars | C> : Chars;

/**
 * The ASCII characters that end a path-to-regexp name (everything but
 * `[A-Za-z0-9_$]`). Non-ASCII characters continue one, as Unicode letters do.
 */
type NameStop = CharsOf<" !\"#%&'()*+,-./:;<=>?@[\\]^`{|}~">;

/** Splits a name off the front of `S`: `[name, rest]`. */
type TakeIdentifier<
  S extends string,
  Name extends string = "",
> = S extends `${infer C}${infer Rest}`
  ? C extends NameStop
    ? [Name, S]
    : TakeIdentifier<Rest, `${Name}${C}`>
  : [Name, S];

/** Splits a quoted name (after its opening `"`) off the front of `S`: `[name, rest]`. */
type TakeQuoted<
  S extends string,
  Name extends string = "",
> = S extends `"${infer Rest}`
  ? [Name, Rest]
  : S extends `\\${infer C}${infer Rest}`
    ? TakeQuoted<Rest, `${Name}${C}`>
    : S extends `${infer C}${infer Rest}`
      ? TakeQuoted<Rest, `${Name}${C}`>
      : [Name, ""];

/** A param's name, quoted or not: `[name, rest]`. */
type TakeName<S extends string> = S extends `"${infer Rest}`
  ? TakeQuoted<Rest>
  : TakeIdentifier<S>;

/** One `{` deeper. */
type Deeper<Depth extends readonly unknown[]> = [...Depth, unknown];
/** One `}` shallower. */
type Shallower<Depth extends readonly unknown[]> = Depth extends [
  unknown,
  ...infer Outer,
]
  ? Outer
  : [];

/**
 * Walks a path character by character, collecting its keys: required and
 * optional `string` keys, required and optional `string[]` (wildcard) keys.
 * `Depth` counts the `{` groups open, `Seen` the positional keys handed out.
 * Tail-recursive, so a long path stays within TypeScript's recursion limit.
 */
type WalkPath<
  S extends string,
  Required extends string = never,
  Optional extends string = never,
  Wildcards extends string = never,
  OptionalWildcards extends string = never,
  Depth extends readonly unknown[] = [],
  Seen extends readonly unknown[] = [],
> = S extends `\\${string}${infer Rest}`
  ? WalkPath<
      Rest,
      Required,
      Optional,
      Wildcards,
      OptionalWildcards,
      Depth,
      Seen
    >
  : S extends `{*}${infer Rest}`
    ? // routejs's `{*}`: a bare `*`, set even when empty.
      WalkPath<
        Rest,
        Required | Positional<Seen>,
        Optional,
        Wildcards,
        OptionalWildcards,
        Depth,
        [...Seen, unknown]
      >
    : S extends `{${infer Rest}`
      ? WalkPath<
          Rest,
          Required,
          Optional,
          Wildcards,
          OptionalWildcards,
          Deeper<Depth>,
          Seen
        >
      : S extends `}${infer Rest}`
        ? WalkPath<
            Rest,
            Required,
            Optional,
            Wildcards,
            OptionalWildcards,
            Shallower<Depth>,
            Seen
          >
        : S extends `:${infer Rest}`
          ? TakeName<Rest> extends [
              infer Name extends string,
              infer After extends string,
            ]
            ? Name extends ""
              ? WalkPath<
                  After,
                  Required,
                  Optional,
                  Wildcards,
                  OptionalWildcards,
                  Depth,
                  Seen
                >
              : AfterConstraint<After> extends `?${infer Tail}`
                ? WalkPath<
                    Tail,
                    Required,
                    Optional | Name,
                    Wildcards,
                    OptionalWildcards,
                    Depth,
                    Seen
                  >
                : Depth extends []
                  ? WalkPath<
                      AfterConstraint<After>,
                      Required | Name,
                      Optional,
                      Wildcards,
                      OptionalWildcards,
                      Depth,
                      Seen
                    >
                  : WalkPath<
                      AfterConstraint<After>,
                      Required,
                      Optional | Name,
                      Wildcards,
                      OptionalWildcards,
                      Depth,
                      Seen
                    >
            : never
          : S extends `*${infer Rest}`
            ? TakeName<Rest> extends [
                infer Name extends string,
                infer After extends string,
              ]
              ? Name extends ""
                ? // A bare `*`: a positional key.
                  WalkPath<
                    After,
                    Required | Positional<Seen>,
                    Optional,
                    Wildcards,
                    OptionalWildcards,
                    Depth,
                    [...Seen, unknown]
                  >
                : After extends `?${infer Tail}`
                  ? WalkPath<
                      Tail,
                      Required,
                      Optional,
                      Wildcards,
                      OptionalWildcards | Name,
                      Depth,
                      Seen
                    >
                  : Depth extends []
                    ? WalkPath<
                        After,
                        Required,
                        Optional,
                        Wildcards | Name,
                        OptionalWildcards,
                        Depth,
                        Seen
                      >
                    : WalkPath<
                        After,
                        Required,
                        Optional,
                        Wildcards,
                        OptionalWildcards | Name,
                        Depth,
                        Seen
                      >
              : never
            : S extends `(${infer Rest}`
              ? // routejs's bare `(regex)`: a positional key, `?` making it optional.
                SkipGroup<Rest> extends `?${infer Tail}`
                ? WalkPath<
                    Tail,
                    Required,
                    Optional | Positional<Seen>,
                    Wildcards,
                    OptionalWildcards,
                    Depth,
                    [...Seen, unknown]
                  >
                : WalkPath<
                    SkipGroup<Rest>,
                    Required | Positional<Seen>,
                    Optional,
                    Wildcards,
                    OptionalWildcards,
                    Depth,
                    [...Seen, unknown]
                  >
              : S extends `${string}${infer Rest}`
                ? WalkPath<
                    Rest,
                    Required,
                    Optional,
                    Wildcards,
                    OptionalWildcards,
                    Depth,
                    Seen
                  >
                : [Required, Optional, Wildcards, OptionalWildcards];

/** Builds the params object from the keys {@link WalkPath} collected. */
type PathParamsOf<Keys> = Keys extends [
  infer Required extends string,
  infer Optional extends string,
  infer Wildcards extends string,
  infer OptionalWildcards extends string,
]
  ? [Required | Optional | Wildcards | OptionalWildcards] extends [never]
    ? NoParams
    : Prettify<
        { [K in Required]: string } & {
          [K in Exclude<Optional, Required | Wildcards>]?: string;
        } & { [K in Exclude<Wildcards, Required>]: string[] } & {
          [
            K in Exclude<OptionalWildcards, Required | Optional | Wildcards>
          ]?: string[];
        }
      >
  : NoParams;

/** The `params` object a handler registered at `P` receives. */
export type ExtractRouteParams<P extends string> = string extends P
  ? ParamsDictionary
  : PathParamsOf<WalkPath<P>>;

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

/** The characters routejs accepts in a param name. */
type NameChar =
  CharsOf<"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_">;

/** Splits a routejs host param name off the front of `S`: `[name, rest]`. */
type TakeHostName<
  S extends string,
  Name extends string = "",
> = S extends `${infer C}${infer Rest}`
  ? C extends NameChar
    ? TakeHostName<Rest, `${Name}${C}`>
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
    ? TakeHostName<Rest> extends [
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
