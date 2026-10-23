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
 * Types only. `ResponseTypeMap`, `AllowedStatus`, `JsonBodyFor`,
 * `SendBodyFor`, `DeclaredAbsent`, `InferResponses`, `VariantNames` and
 * `NarrowVariant` are exported from the package root (approved for
 * bun-validate V7b, 2026-10-22: bun-nest's `@Validate` response typing is
 * written in them); the rest reach a consumer through `BunResponse`'s
 * signatures.
 */
import type { Readable } from "node:stream";
import type {
  BunResponseBody,
  BunResponseChunk,
  CookieValue,
} from "../BunResponse";
import type { WireInput } from "../contract/model";
import type { ResponseVariants } from "../responseBodies";
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

/** Marks a header a variant declares absent (a discriminant's `null`, plan §4.4.6). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- a type-only brand: only its `typeof` is read
declare const ABSENT: unique symbol;

/**
 * A header a variant declares absent: a discriminant mapping the variant to
 * `null`. `set()` takes no value for it.
 *
 * @internal
 */
export type DeclaredAbsent = typeof ABSENT;

/**
 * A declared header's value narrowed to what a header can be (a string or a
 * list of them), or any header value when it does not say (undeclared, or a
 * coercing schema whose input is a number); no value at all for a header
 * declared absent ({@link DeclaredAbsent}).
 */
type HeaderArg<D> = [D] extends [never]
  ? string | string[]
  : [D] extends [DeclaredAbsent]
    ? never
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

/**
 * A status's content map: `opaque(mediaType)` is that media type, never
 * read; any other bare schema is a JSON body; `undefined`: unchecked.
 */
type ContentOf<Sp> = Sp extends null
  ? null
  : Sp extends OpaqueDecl & { readonly mediaType: infer M extends string }
    ? { [K in M]: OpaqueDecl }
    : Sp extends StandardSchemaV1
      ? { "application/json": Sp }
      : Sp extends { content: infer C }
        ? C
        : undefined;

/** A `chunks()` or `sse()` declaration (a stream checked chunk by chunk, or event by event). */
interface StreamDecl {
  /** Its kind. */
  readonly kind: "chunks" | "sse";
}

/** An `opaque()` declaration (a media type whose body is never read). */
interface OpaqueDecl {
  /** Its kind. */
  readonly kind: "opaque";
}

/** A body that streams: what `send()` pipes (plan §4.4.3). */
type StreamBody =
  | ReadableStream
  | Readable
  | AsyncIterable<BunResponseChunk>
  | (() => AsyncGenerator<BunResponseChunk>);

/**
 * What a `chunks()`/`sse()` media type takes: a stream, or a body held in
 * memory (checked as a stream of one chunk), a `Blob` or a passed-through
 * `Response` (piped through the check).
 */
type StreamSend =
  StreamBody | string | ArrayBufferView | ArrayBufferLike | Blob;

/** What `json()` takes for a content map: the bodies of its JSON (or wildcard) keys. */
type JsonOf<C> = C extends null
  ? never
  : C extends undefined
    ? BunResponseBody
    : {
        [K in keyof C]: MediaClass<K> extends "json" | "any"
          ? C[K] extends StreamDecl
            ? never
            : C[K] extends StandardSchemaV1
              ? WireInput<C[K]>
              : never
          : never;
      }[keyof C];

/**
 * What `send()` takes for one media key: an empty body for `null`, any body
 * for `opaque()`, a stream (or a buffered body) for `chunks()`/`sse()`, and
 * a schema's wire input otherwise.
 */
type SendOne<K, V> = V extends null
  ? null | undefined
  : V extends OpaqueDecl
    ? BunResponseBody
    : V extends StreamDecl
      ? StreamSend
      : V extends StandardSchemaV1
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

/** One plain status's (or one variant's) spec. */
interface PlainSpec<Sp> {
  /** What `json()` takes. */
  json: JsonOf<ContentOf<Sp>>;
  /** What `send()` takes. */
  send: SendOf<ContentOf<Sp>>;
  /** The declared headers. */
  headers: HeadersOf<Sp>;
  /** The declared cookies. */
  cookies: CookiesOf<Sp>;
}

/**
 * A `responses` declaration's map: status to what a handler may send for it.
 * A status declared with `variants()` is the **union** of its variants'
 * specs, each tagged with its `variant` name (plan §4.4.6): `json()`,
 * `send()`, `set()` and `cookie()` take the union until `res.variant()`
 * narrows it.
 *
 * @internal
 */
export type InferResponses<RS> = {
  [K in keyof RS]: RS[K] extends ResponseVariants<infer T, infer B, infer _V>
    ? VariantsSpec<T, B>
    : PlainSpec<RS[K]>;
};

// ---------------------------------------------------------------------------
// Variants (plan §4.4.6, V3c)
// ---------------------------------------------------------------------------

/** A status's variants as the union of their tagged specs. */
type VariantsSpec<T, B> = {
  [N in keyof T & string]: VariantTypeSpec<T[N], B, N>;
}[keyof T & string];

/** The discriminant's value for variant `N`, as a header (or cookie) value type. */
type DiscValue<B, N extends string> = B extends { values: infer M }
  ? N extends keyof M
    ? M[N] extends string
      ? M[N]
      : M[N] extends true
        ? string
        : DeclaredAbsent
    : N
  : N;

/** Variant `N`'s headers with the discriminant header pinned to its value. */
type WithDiscHeader<H, B, N extends string> = B extends {
  header: infer Name extends string;
}
  ? Omit<H, Lowercase<Name>> & { [P in Lowercase<Name>]: DiscValue<B, N> }
  : H;

/** Variant `N`'s cookies with the discriminant cookie pinned to its value. */
type WithDiscCookie<C, B, N extends string> = B extends {
  cookie: infer Name extends string;
}
  ? Omit<C, Name> & { [P in Name]: DiscValue<B, N> }
  : C;

/** Whether `T` is a union (`boolean` is one). */
type IsUnion<T, U = T> = T extends unknown
  ? [U] extends [T]
    ? false
    : true
  : never;

/** Whether `T` admits exactly one value: one string, number or boolean literal. */
type IsSingleLiteral<T> = [T] extends [string | number | boolean]
  ? string extends T
    ? false
    : number extends T
      ? false
      : true extends IsUnion<T>
        ? false
        : true
  : false;

/** Keys of `T` whose required value is a single literal: what `.variant()` fills. */
type LiteralKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K>
    ? never
    : IsSingleLiteral<T[K]> extends true
      ? K
      : never;
}[keyof T];

/** Flattens an intersection for readable hovers. */
type Flat<T> = { [K in keyof T]: T[K] };

/**
 * What a handler passes after `.variant()`: every required single-literal
 * field optional, through nested objects and array elements, since the
 * runtime fills them (plan Q-H30).
 *
 * @internal
 */
export type LiteralOptional<T> = T extends readonly (infer E)[]
  ? LiteralOptional<E>[]
  : T extends Date | Uint8Array | ArrayBuffer | Blob
    ? T
    : T extends object
      ? Flat<
          { [K in LiteralKeys<T>]?: T[K] } & {
            [
              K in keyof T as K extends LiteralKeys<T> ? never : K
            ]: LiteralOptional<T[K]>;
          }
        >
      : T;

/**
 * Whether every JSON body schema of a variant carries `~standard.jsonSchema`
 * in its type (zod 4 and arktype 2 do; valibot and yup do not): only then
 * can the runtime find its literals, so only then are they optional.
 */
type Fillable<Sp> =
  ContentOf<Sp> extends infer C
    ? C extends object
      ? [
          {
            [K in keyof C]: MediaClass<K> extends "json" | "any"
              ? C[K] extends null
                ? never
                : C[K] extends {
                      "~standard": {
                        jsonSchema: { input: (...args: never[]) => unknown };
                      };
                    }
                  ? never
                  : K
              : never;
          }[keyof C],
        ] extends [never]
        ? true
        : false
      : false
    : false;

/** One variant as a spec, tagged with its name, and its filled bodies for `.variant()`. */
type VariantTypeSpec<Sp, B, N extends string> =
  PlainSpec<Sp> extends infer S
    ? S extends PlainSpec<Sp>
      ? {
          /** What `json()` takes on the union. */
          json: S["json"];
          /** What `send()` takes on the union. */
          send: S["send"];
          /** The variant's headers, the discriminant pinned to its value. */
          headers: WithDiscHeader<S["headers"], B, N>;
          /** The variant's cookies, the discriminant pinned to its value. */
          cookies: WithDiscCookie<S["cookies"], B, N>;
          /** The variant's name: what `.variant()` narrows by. */
          variant: N;
          /** `json()`'s body after `.variant()`: literal fields optional where the runtime can fill them. */
          filledJson: Fillable<Sp> extends true
            ? LiteralOptional<S["json"]>
            : S["json"];
          /** `send()`'s body after `.variant()`, likewise. */
          filledSend: Fillable<Sp> extends true
            ? LiteralOptional<S["send"]>
            : S["send"];
        }
      : never
    : never;

/**
 * The variant names a map declares, across its statuses: what
 * `res.variant()` takes. `never` with none, or with no map.
 *
 * @internal
 */
export type VariantNames<M> = [M] extends [undefined]
  ? never
  : M[keyof M] extends infer S
    ? S extends { variant: infer N extends string }
      ? N
      : never
    : never;

/**
 * The map after `.variant(N)`: each status's variant `N` alone, its
 * `json`/`send` the filled forms; a status without that variant is dropped.
 *
 * @internal
 */
export type NarrowVariant<M, N extends string> = {
  [
    K in keyof M as [Extract<M[K], { variant: N }>] extends [never] ? never : K
  ]: Filled<Extract<M[K], { variant: N }>>;
};

/** A variant's spec with `json`/`send` swapped for their filled forms. */
type Filled<S> = S extends { filledJson: infer J; filledSend: infer D }
  ? Omit<S, "json" | "send" | "filledJson" | "filledSend"> & {
      /** What `json()` takes after `.variant()`. */
      json: J;
      /** What `send()` takes after `.variant()`. */
      send: D;
    }
  : S;
