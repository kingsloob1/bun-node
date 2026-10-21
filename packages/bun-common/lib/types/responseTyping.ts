/**
 * The static side of response contracts (plan §4.4.4): what a declared
 * `responses` table lets a handler's `res` send, per status. `BunResponse`'s
 * trailing `TResponses` type parameter holds one of these maps
 * ({@link ResponseTypeMap}), or `undefined` for none, which leaves every
 * method as it was.
 *
 * The server is held to each schema's **wire input**, field by field
 * (`WireInput`, plan §4.12 M1): a `z.date()` field must be a `Date`, a
 * `z.coerce.number()` one a `number`.
 *
 * Types only. Internal: the names are not approved (plan §9); they reach a
 * consumer through `BunResponse`'s signatures.
 */
import type { BunResponseBody, CookieValue } from "../BunResponse";
import type { WireInput } from "../contract/model";
import type { EmptyShape } from "./routeTyping";
import type { StandardSchemaV1 } from "./standardSchema";

/**
 * What one declared status lets a handler send.
 *
 * @internal
 */
export interface ResponseTypeSpec {
  /** The body `json()` takes; `never` when no JSON media type is declared. */
  json: unknown;
  /** The body `send()` takes (every declared media type's); `never` when none. */
  send: unknown;
  /** Declared header names (lower-case) to the value `set()`/`header()` take. */
  headers: object;
  /** Declared `Set-Cookie` names to the value `cookie()` takes. */
  cookies: object;
}

/**
 * A declared response map: status code to {@link ResponseTypeSpec}.
 *
 * @internal
 */
export type ResponseTypeMap = Record<number, ResponseTypeSpec>;

/** Whether `M` is a declared map (not `undefined`). */
type Declared<M> = [M] extends [ResponseTypeMap] ? true : false;

/**
 * The statuses `status()` takes: the declared ones, or any number until
 * responses are declared.
 *
 * @internal
 */
export type AllowedStatus<M> =
  Declared<M> extends true ? keyof M & number : number;

/**
 * The map left after `status(C)`: the declared spec of `C` alone.
 *
 * @internal
 */
export type NarrowResponses<M, C extends number> =
  Declared<M> extends true ? Pick<M, C & keyof M> : undefined;

/** One field of every declared status's spec, as a union. */
type SpecField<M, F extends keyof ResponseTypeSpec> = M[keyof M] extends infer S
  ? S extends ResponseTypeSpec
    ? S[F]
    : never
  : never;

/**
 * What `json()` takes: the declared JSON bodies, or any body until declared.
 *
 * @internal
 */
export type JsonBodyFor<M> =
  Declared<M> extends true ? SpecField<M, "json"> : BunResponseBody;

/**
 * What `send()` takes: every declared body (and a native `Response`, checked
 * at runtime), or any body until declared.
 *
 * @internal
 */
export type SendBodyFor<M> =
  Declared<M> extends true ? SpecField<M, "send"> | Response : BunResponseBody;

/** The value type a declared name `N` has in part `P`, across the statuses declaring it. */
type DeclaredValue<M, P extends "headers" | "cookies", N> =
  SpecField<M, P> extends infer O
    ? O extends object
      ? N extends keyof O
        ? O[N]
        : never
      : never
    : never;

/**
 * A declared header's value narrowed to what a header can be (a string or a
 * list of them), or any header value when it does not say (undeclared, or a
 * coercing schema whose input is a number).
 */
type HeaderArg<D> = [D] extends [never]
  ? string | string[]
  : [Extract<D, string | readonly string[]>] extends [never]
    ? string | string[]
    : Extract<D, string | string[]>;

/**
 * The value `set(name, …)`/`header(name, …)` take: the declared type for a
 * declared name (in any letter case), else any header value.
 *
 * @internal
 */
export type HeaderValueFor<M, N extends string> =
  Declared<M> extends true
    ? HeaderArg<DeclaredValue<M, "headers", Lowercase<N>>>
    : string | string[];

/**
 * The value `cookie(name, …)` takes: the declared cookie's `value` type,
 * else any cookie value.
 *
 * @internal
 */
export type CookieValueFor<M, N extends string> =
  Declared<M> extends true
    ? [DeclaredValue<M, "cookies", N>] extends [never]
      ? CookieValue
      : DeclaredValue<M, "cookies", N> & CookieValue
    : CookieValue;

/** The redirect statuses. */
type RedirectCode = 300 | 301 | 302 | 303 | 305 | 307 | 308;

/**
 * The statuses `redirect(status, url)` takes: the declared 3xx, or any number.
 *
 * @internal
 */
export type RedirectStatus<M> =
  Declared<M> extends true ? Extract<keyof M & number, RedirectCode> : number;

/**
 * `redirect(url)` sends `302`, so it takes a URL only where 302 is declared.
 *
 * @internal
 */
export type RedirectUrl<M> =
  Declared<M> extends true ? (302 extends keyof M ? string : never) : string;

// ---------------------------------------------------------------------------
// From a `responses` declaration to the map
// ---------------------------------------------------------------------------

/** A key's bare type: parameters dropped (`text/plain; version=0.0.4` → `text/plain`), lower-cased. */
type BareKey<K> = K extends `${infer B};${string}`
  ? Lowercase<B>
  : K extends string
    ? Lowercase<K>
    : never;

/**
 * How a media key's body is sent: `json` (`application/json`, `*+json`),
 * `text` (`text/*`), `any` (`*\/*`, `application/*`, which `json()` may also
 * fall under) or `bytes` (anything else).
 */
type MediaClass<K> =
  BareKey<K> extends "application/json" | `${string}+json`
    ? "json"
    : BareKey<K> extends `text/${string}`
      ? "text"
      : BareKey<K> extends "*/*" | "application/*"
        ? "any"
        : "bytes";

/** A status's content map: a bare schema is a JSON body; `undefined`: unchecked. */
type ContentOf<Sp> = Sp extends null
  ? null
  : Sp extends StandardSchemaV1
    ? { "application/json": Sp }
    : Sp extends { content: infer C }
      ? C
      : undefined;

/** What `json()` takes for a content map: the bodies of its JSON (or wildcard) keys. */
type JsonOf<C> = C extends null
  ? never
  : C extends undefined
    ? BunResponseBody
    : {
        [K in keyof C]: MediaClass<K> extends "json" | "any"
          ? C[K] extends StandardSchemaV1
            ? WireInput<C[K]>
            : never
          : never;
      }[keyof C];

/** What `send()` takes for one media key. */
type SendOne<K, V> = V extends StandardSchemaV1
  ? MediaClass<K> extends "json" | "text"
    ? WireInput<V>
    : WireInput<V> | Blob | ArrayBufferView | ArrayBufferLike
  : never;

/** What `send()` takes for a content map: every media key's body. */
type SendOf<C> = C extends null
  ? null | undefined
  : C extends undefined
    ? BunResponseBody
    : { [K in keyof C]: SendOne<K, C[K]> }[keyof C];

/** Declared response headers: lower-case name to the value. */
type HeadersOf<Sp> = Sp extends { headers: infer H extends StandardSchemaV1 }
  ? WireInput<H>
  : EmptyShape;

/** Declared `Set-Cookie`s: name to the value `res.cookie()` takes. */
type CookiesOf<Sp> = Sp extends { cookies: infer C extends StandardSchemaV1 }
  ? {
      [N in keyof WireInput<C>]: WireInput<C>[N] extends { value: infer V }
        ? V
        : never;
    }
  : EmptyShape;

/**
 * A `responses` declaration's map: status to what a handler may send for it.
 *
 * @internal
 */
export type InferResponses<RS> = {
  [K in keyof RS]: {
    json: JsonOf<ContentOf<RS[K]>>;
    send: SendOf<ContentOf<RS[K]>>;
    headers: HeadersOf<RS[K]>;
    cookies: CookiesOf<RS[K]>;
  };
};
