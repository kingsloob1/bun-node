/**
 * The contract model: what a transport declares, what a contract holds, and
 * the static types derived from it.
 *
 * Types only, apart from the {@link CONTRACT} and {@link VARIANTS} symbols
 * and {@link variantsOf}. Nothing here imports a
 * Bun or Node API, so the module is safe in a browser bundle (the
 * `@kingsleyweb/bun-common/contract` subpath).
 *
 * See `docs/plans/bun-validate/README.md` §4.1 for the design.
 */
import type { LoggerLike } from "../logging";
import type { StandardSchemaV1 } from "../types/standardSchema";

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/** A value, or a promise of one: what the runner and the guards return. */
export type MaybePromise<T> = T | Promise<T>;

/** Any Standard Schema: the only schema type the core knows. */
export type Schema = StandardSchemaV1;

/**
 * One schema per media type, as OpenAPI's `content` keys a body
 * (`"application/json"`, `"text/plain"`). At runtime a message's media type
 * matches a key case-insensitively with parameters stripped on both sides (a
 * key's own parameters are kept for documents), and `type/*` and `*\/*` keys
 * match too, the most specific key winning: an exact `type/subtype`, then
 * `type/*`, then `*\/*`. A key that is not a media type, or two keys that are
 * the same once bare and lower-cased, are refused when declared. A `null`
 * value declares the media type with no body: a message sent as it must
 * carry none.
 */
export interface MediaMap {
  /** The schema for a body sent as this media type; `null`: this media type, with no body. */
  readonly [mediaType: string]: Schema | null;
}

/**
 * One part's declaration: a schema, media-type variants (only for a part the
 * transport lists in {@link SideSpec.media}), or `null` for "must be absent"
 * (a 204's body).
 */
export type PartDecl = Schema | MediaMap | null;

/**
 * How a part travels on the wire, recorded as data on each described row so a
 * client or document generator can apply it (plan §4.12 m3). The core never
 * applies it: what a receiver gets is each schema's output.
 *
 * - `path-string`: a path parameter, always a string.
 * - `querystring`: parsed from the query string.
 * - `header-string`: a header value, a string (or a list of them).
 * - `cookie-string`: a request cookie's value.
 * - `signed-cookie`: a request cookie whose signature was verified.
 * - `set-cookie`: a cookie set by a response.
 * - `body`: the part's value as the transport serialises it (a JSON body, a
 *   frame's or a record's payload). The default.
 */
export type ContractEncoding =
  | "path-string"
  | "querystring"
  | "header-string"
  | "cookie-string"
  | "signed-cookie"
  | "set-cookie"
  | "body";

/**
 * What kind of value a described row is (plan §4.12 M4): a whole value, a
 * stream of chunks, server-sent events, or an opaque body declared without
 * being read. A row is `"value"` unless one of bun-common's response body
 * helpers declared it: `chunks()`, `sse()` (whose events are expanded into
 * the row's `nested` rows) or `opaque()`.
 */
export type ContractKind = "value" | "chunks" | "sse" | "opaque";

/**
 * What the wire does to a transport's values (plan Q-C5), recorded as data
 * for client types to apply: `"json"` when values cross as JSON (a `Date`
 * arrives as a string), `"identity"` when they arrive as sent (an in-process
 * broker).
 */
export type ContractWire = "json" | "identity";

/** What a transport declares about one side of its messages. */
export interface SideSpec {
  /** The part names a message on this side may carry, e.g. `["params", "query", "body"]`. */
  readonly parts: readonly string[];
  /**
   * The name of the field that selects a variant (`"status"`, `"type"`,
   * `"topic"`); absent when the side has one shape. It cannot also be a part.
   */
  readonly key?: string;
  /** The parts whose declaration may be a {@link MediaMap} (HTTP's `body`). Default: none. */
  readonly media?: readonly string[];
  /** Each part's wire {@link ContractEncoding}; a part not listed is `"body"`. */
  readonly encodings?: { readonly [part: string]: ContractEncoding };
}

/** What `defineTransport` takes: a name and the shape of each side it has. */
export interface TransportSpec {
  /** The transport's name, for logs, issues' context and generated documents. */
  readonly name: string;
  /** What the wire does to values ({@link ContractWire}). Default `"json"`. */
  readonly wire?: ContractWire;
  /** Messages the contract's owner receives (an HTTP request, a consumed record). */
  readonly inbound?: SideSpec;
  /** Messages the contract's owner sends (an HTTP response, a produced record, an SSE event). */
  readonly outbound?: SideSpec;
}

/** A side of a contract: what its owner receives, or what it sends. */
export type Side = "inbound" | "outbound";

/** The failure policy, the same three words on every transport: skip the check, log and pass, or fail. */
export type Policy = "off" | "warn" | "error";

/** The part names a side declares. */
type PartNames<S extends SideSpec> = S["parts"][number];

/** The part names a side lets take a {@link MediaMap}. */
type MediaNames<S extends SideSpec> = S["media"] extends readonly string[]
  ? S["media"][number]
  : never;

/** The parts of one message shape, as a contract declares them. */
export type PartsDef<S extends SideSpec> = {
  readonly [P in PartNames<S>]?: P extends MediaNames<S>
    ? PartDecl
    : Schema | null;
};

/** A side as a contract declares it: one {@link PartsDef}, or one per key when the side is keyed. */
export type SideDef<S extends SideSpec> = S["key"] extends string
  ? { readonly [key: string]: PartsDef<S> }
  : PartsDef<S>;

/** A contract's declaration for transport `T`. */
export interface ContractDef<T extends TransportSpec> {
  /** The inbound side's schemas. */
  readonly inbound?: T["inbound"] extends SideSpec
    ? SideDef<T["inbound"]>
    : never;
  /** The outbound side's schemas. */
  readonly outbound?: T["outbound"] extends SideSpec
    ? SideDef<T["outbound"]>
    : never;
}

/** Documentation a generator reads alongside the schemas. */
export interface ContractMeta {
  /**
   * A stable name (an operation id, a channel name). For an HTTP route, an
   * `operationId` given by the route's own documentation (`.describe()`, plan
   * §4.12 m7) wins over this.
   */
  readonly name?: string;
  /** Prose for the generated document. */
  readonly description?: string;
}

/**
 * Where a contract is found at runtime: a non-enumerable property under
 * `Symbol.for("bun-validate.contract")`, so copies of bun-common in one
 * process agree on it.
 */
export const CONTRACT: unique symbol = Symbol.for("bun-validate.contract");

/**
 * Where a keyed side's key declared as several whole **variants** keeps
 * them (HTTP's `variants()`, plan §4.4.6): a property of the key's parts
 * object under `Symbol.for("bun-validate.variants")`, holding a
 * {@link VariantsDecl}. Such a key declares no part of its own; each variant
 * declares its parts in full, and `describeContract` gives each a row with
 * its `variant`. Internal.
 *
 * @internal
 */
export const VARIANTS: unique symbol = Symbol.for("bun-validate.variants");

/**
 * One variant of a key, as a contract records it: its name, its parts in
 * full, and what documents say about when it is sent.
 *
 * @internal
 */
export interface VariantDecl {
  /** The variant's name, the author's (`"admin"`). */
  readonly name: string;
  /** The variant's parts, keyed by the transport's part names, each declared as a key's are (a schema, a media map or `null`). */
  readonly parts: object;
  /** Whether the variant applies only to some requests (it has a `when`); a `when` itself is never described. */
  readonly conditional: boolean;
  /** What documents say instead of the `when`; absent when none was given. */
  readonly description?: string;
}

/**
 * A key's variants, and the discriminant that selects one, as a contract
 * records them under {@link VARIANTS}.
 *
 * @internal
 */
export interface VariantsDecl {
  /** The variants, in declaration order. */
  readonly variants: readonly VariantDecl[];
  /**
   * The discriminant: the part (`"headers"`, `"cookies"`) and the name in it
   * whose value selects the variant, and each selectable variant's value (an
   * exact string, `true` for any value, `null` for absence). Absent when the
   * key has none.
   */
  readonly by?: {
    /** The part the discriminant is in. */
    readonly part: string;
    /** The header (lower-case) or cookie name. */
    readonly name: string;
    /** Variant name to the value that selects it; a variant not listed is not selected by it. */
    readonly values: Readonly<Record<string, string | true | null>>;
  };
}

/** The {@link VariantsDecl} a key's parts object carries, if it declares variants. */
export function variantsOf(parts: unknown): VariantsDecl | undefined {
  return typeof parts === "object" && parts !== null
    ? (parts as { [VARIANTS]?: VariantsDecl })[VARIANTS]
    : undefined;
}

/** Something carrying contract `C` (a handler, a router layer, a queue definition). */
export interface Carries<C> {
  /** The contract, reachable through `getContract`. */
  readonly [CONTRACT]: C;
}

/** A contract: the transport it is for, its schemas, and its documentation. */
export interface Contract<
  T extends TransportSpec = TransportSpec,
  D = ContractDef<T>,
> extends Carries<Contract<T, D>> {
  /** The transport's declaration, so generators know part and key names. */
  readonly transport: T;
  /** The schemas, exactly as declared. */
  readonly def: D;
  /** Documentation metadata. */
  readonly meta: ContractMeta;
}

/** Any contract, for functions that walk one without its types. */
export type AnyContract = Contract<TransportSpec, unknown>;

// ---------------------------------------------------------------------------
// Issues and guard options
// ---------------------------------------------------------------------------

/**
 * One validation issue, flattened. Never carries the received value: the
 * message is scrubbed of it (or replaced, with `messages: "generic"`), and
 * only the path's keys are kept.
 *
 * @typeParam TTarget The part names; BunValidate's request side narrows it
 *   to its targets.
 */
export interface ValidationIssue<TTarget extends string = string> {
  /** The part that failed (`"body"`, `"payload"`), or the key field (`"status"`, `"type"`) for an undeclared key. */
  target: TTarget;
  /** What is wrong, from the schema, with any quoted received value withheld. */
  message: string;
  /** Dotted path within the part, `""` for the part itself (or always, with `redactPaths`). */
  path: string;
  /** The declared key (the status, message type, event, topic or method), on a keyed side. */
  key?: string;
  /** The declared media type, on a media-typed part. */
  mediaType?: string;
  /**
   * The variant of the key the issue was checked against (HTTP's
   * `variants()`, plan §4.4.6, Q-H19): a name the contract's author chose.
   * Absent on a key with no variants, and on an issue about the key as a
   * whole (`The response matches no acceptable variant (…)`).
   */
  variant?: string;
}

/** A flattened outcome: the parsed value, or every issue. */
export type StandardOutcome<T, TTarget extends string = string> =
  { ok: true; value: T } | { ok: false; issues: ValidationIssue<TTarget>[] };

/** Where a guard found its issues, for logs and telemetry. Never carries a received value. */
export interface IssueContext {
  /** The transport's name. */
  transport: string;
  /** The side checked. */
  side: Side;
  /** The declared key, on a keyed side; absent when the key was not declared. */
  key?: string;
  /** The policy in force: `"warn"` or `"error"` (`"off"` never reports). */
  policy: Policy;
}

/** How a guard enforces a side, and how issues are worded. */
export interface GuardOptions {
  /**
   * What a mismatch does. Default `"error"`. A receiver given `"warn"` or
   * `"off"` is typed to hand on `unknown`, because it may pass a message
   * its schemas did not parse (plan Q-C1).
   */
  policy?: Policy;
  /**
   * Receives `"warn"`'s one log line per failing message (no values), and a
   * failure of `onIssues`. Any {@link LoggerLike}; default bun-common's
   * console logger.
   */
  logger?: LoggerLike;
  /**
   * Telemetry hook (an OpenTelemetry `validation.failed` span event), called
   * once per failing message under `"warn"` and `"error"`, never on a passing
   * one. Unset, it costs nothing. If it throws, the error is logged and the
   * guard answers as if it had not.
   */
  onIssues?: (
    issues: readonly ValidationIssue[],
    context: IssueContext,
  ) => void;
  /**
   * An undeclared key on a keyed side: an issue (`"report"`, the default) or
   * passed through unchecked (`"allow"`).
   */
  undeclaredKey?: "report" | "allow";
  /**
   * Replace every issue's `path` with `""`, for schemas keyed by user data
   * (an e-mail-keyed record, an unknown key's name), since a path names keys
   * the sender chose. Default `false` (plan Q-C2).
   */
  redactPaths?: boolean;
  /**
   * `"generic"` replaces every issue message with `Invalid value` (plus the
   * vendor's issue code when it has one), for deployments that need a
   * guarantee rather than the default scrub, which withholds only messages
   * found to quote a received value (plan Q-C3).
   */
  messages?: "generic";
  /**
   * Which prototype-pollution keys a receiver deletes from what arrived,
   * in place, before its schemas run. `"nest"` (the default) is Nest
   * 12.2.0's rule: every own `__proto__` and `prototype` key and every own
   * `constructor` key, recursively, so a legitimate `prototype` or
   * `constructor` field is deleted too. `"minimal"` deletes only own
   * `__proto__` keys and own `constructor` keys whose value is an object
   * with an own `prototype`. A sender never strips (it hands back its
   * owner's message as given), so it ignores this. Anything else throws a
   * `TypeError` when the guard is built.
   */
  stripProtoKeys?: "nest" | "minimal";
}

// ---------------------------------------------------------------------------
// Static types derived from a contract
// ---------------------------------------------------------------------------

/** What a receiver gets from a schema: its output. */
export type ReceiveOf<S extends Schema> = StandardSchemaV1.InferOutput<S>;

/** Values `WireInput` takes as they are, without mapping their members. */
type WireLeaf =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Date
  | RegExp
  | ((...args: never[]) => unknown)
  | ArrayBuffer
  | ArrayBufferView
  | ReadonlyMap<unknown, unknown>
  | ReadonlySet<unknown>
  | PromiseLike<unknown>;

/** `X`, or `unknown` when `X` is `never`. */
type OrUnknown<X> = [X] extends [never] ? unknown : X;

/** The output type at key `K`, across every member of an output union that has it. */
type OutputAt<O, K> = OrUnknown<
  NonNullable<O> extends infer N
    ? N extends unknown
      ? K extends keyof N
        ? N[K]
        : never
      : never
    : never
>;

/** Maps an object, array or tuple input member by member (homomorphic, so optionality and arrays survive). */
type WireMembers<I, O> = { [K in keyof I]: DeepWire<I[K], OutputAt<O, K>> };

/** The wire view of input `I` whose output is `O`: see {@link WireInput}. */
type DeepWire<I, O> = unknown extends I
  ? O
  : I extends WireLeaf
    ? I
    : I extends object
      ? WireMembers<I, O>
      : I;

/**
 * What a sender is held to, **field by field** (plan §4.1.4, §4.12 M1): each
 * field's input type, or its output where the input is `unknown` (a
 * coercion), with the input's optionality; deep through objects, arrays and
 * tuples. So `z.object({ page: z.coerce.number(), q: z.string().default("") })`
 * sends as `{ page: number; q?: string }`.
 */
export type WireInput<S extends Schema> = DeepWire<
  StandardSchemaV1.InferInput<S>,
  StandardSchemaV1.InferOutput<S>
>;

/** Whose view of a message: the sender's or the receiver's. */
export type Role = "send" | "receive";

/** One schema's type in a role's view. */
type Of<S extends Schema, R extends Role> = R extends "send"
  ? WireInput<S>
  : ReceiveOf<S>;

/** Flattens an intersection for readable hovers. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** A media-typed part's value: the media type it was sent as, and the value. */
export type MediaValue<M extends MediaMap, R extends Role> = {
  [K in keyof M & string]: M[K] extends Schema
    ? { mediaType: K; value: Of<M[K], R> }
    : { mediaType: K; value?: undefined };
}[keyof M & string];

/** One part's value in a role's view. */
export type PartValue<P, R extends Role> = P extends null
  ? undefined
  : P extends Schema
    ? Of<P, R>
    : P extends MediaMap
      ? MediaValue<P, R>
      : never;

/** A message's parts in a role's view; a part that may be `undefined` is optional. */
export type PartsView<P, R extends Role> = Simplify<
  {
    [
      K in keyof P as undefined extends PartValue<P[K], R> ? never : K
    ]: PartValue<P[K], R>;
  } & {
    [
      K in keyof P as undefined extends PartValue<P[K], R> ? K : never
    ]?: PartValue<P[K], R>;
  }
>;

/** The transport's declaration of side `Sd`. */
type SpecOf<C, Sd extends Side> =
  C extends Contract<infer T, unknown>
    ? T[Sd] extends SideSpec
      ? T[Sd]
      : never
    : never;

/** The contract's declaration of side `Sd`. */
type DefOf<C, Sd extends Side> =
  C extends Contract<TransportSpec, infer D>
    ? D extends { readonly [K in Sd]?: infer X }
      ? X
      : never
    : never;

/** The keys a keyed side declares (`200 | 404`, `"chat.post"`). */
export type KeysOf<C, Sd extends Side> = keyof DefOf<C, Sd> & (string | number);

/** One key's parts in a role's view. */
export type PartsOf<
  C,
  Sd extends Side,
  K extends KeysOf<C, Sd>,
  R extends Role,
> = PartsView<DefOf<C, Sd>[K], R>;

/** A whole message in a role's view: flat, with the transport's key field when the side is keyed. */
export type MessageOf<C, Sd extends Side, R extends Role> = SpecOf<
  C,
  Sd
>["key"] extends infer N extends string
  ? {
      [K in KeysOf<C, Sd>]: Simplify<
        { [F in N]: K } & PartsView<DefOf<C, Sd>[K], R>
      >;
    }[KeysOf<C, Sd>]
  : PartsView<DefOf<C, Sd>, R>;

/** What a receiver of side `Sd` gets: each part's output. */
export type Received<C, Sd extends Side> = MessageOf<C, Sd, "receive">;

/** What a sender of side `Sd` is held to: each part's {@link WireInput}. */
export type Sent<C, Sd extends Side> = MessageOf<C, Sd, "send">;

// ---------------------------------------------------------------------------
// Declaring a transport and a contract
// ---------------------------------------------------------------------------

/** Every key of `D` outside `Allowed`, mapped to `never`. */
type NoExtra<D, Allowed extends PropertyKey> = {
  [K in Exclude<keyof D, Allowed>]: never;
};

/** Rejects parts a side does not declare, per key when the side is keyed. */
type StrictSide<S, D> = S extends SideSpec
  ? S["key"] extends string
    ? { [K in keyof D]: NoExtra<D[K], PartNames<S>> }
    : NoExtra<D, PartNames<S>>
  : never;

/**
 * Rejects a part or side the transport does not declare. A `const` generic's
 * inference skips excess-property checks, so without this
 * `http.contract({ inbound: { bdy } })` compiled.
 */
export type StrictDef<T extends TransportSpec, D> = {
  [K in keyof D & Side]: StrictSide<T[K], D[K]>;
} & NoExtra<D, Side>;

/** A declared transport: its spec, and the factory for contracts typed against it. */
export interface Transport<T extends TransportSpec> {
  /** The declaration passed to `defineTransport`. */
  readonly spec: T;
  /**
   * Creates a contract; an undeclared side or part, or a media map on a part
   * that takes none, is a type error and a `TypeError`.
   */
  readonly contract: <const D extends ContractDef<T>>(
    def: D & StrictDef<T, D>,
    meta?: ContractMeta,
  ) => Contract<T, D>;
}
