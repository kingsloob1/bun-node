/**
 * Contract core: a design probe for a transport-agnostic BunValidate.
 *
 * One contract model, one runner, one issue shape and one failure policy that
 * every transport (HTTP, WebSocket, SSE, jobs, a broker, UDP, gRPC) plugs into
 * by naming its parts. Not a library: small enough to read in one sitting, so
 * the plan can quote its signatures. See README.md in this folder.
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** A value, or a promise of one: what the runner returns. */
export type MaybePromise<T> = T | Promise<T>;

/** Any Standard Schema; the only schema type the core knows. */
export type Schema = StandardSchemaV1;

/** OpenAPI's `content`: one schema per media type (`"application/json"`, `"text/plain"`). */
export interface MediaMap {
  readonly [mediaType: string]: Schema;
}

/** One part's declaration: a schema, media-type variants, or `null` for "must be absent" (a 204 body). */
export type PartDecl = Schema | MediaMap | null;

/** What a transport declares about one side of its messages. */
export interface SideSpec {
  /** The part names a message on this side may carry, e.g. `["params", "query", "body"]`. */
  readonly parts: readonly string[];
  /** The name of the field that selects a variant (`"status"`, `"type"`, `"topic"`); absent when the side has one shape. */
  readonly key?: string;
  /** The parts whose declaration may be a {@link MediaMap} (HTTP's `body`). Default: none. */
  readonly media?: readonly string[];
}

/** What `defineTransport` takes: a name and the shape of each side it has. */
export interface TransportSpec {
  /** The transport's name, for logs, issues' context and generated documents. */
  readonly name: string;
  /** Messages the contract's owner receives (an HTTP request, a consumed record). */
  readonly inbound?: SideSpec;
  /** Messages the contract's owner sends (an HTTP response, a produced record, an SSE event). */
  readonly outbound?: SideSpec;
}

/** A side of a contract. */
export type Side = "inbound" | "outbound";

/** The failure policy: skip the check, log and pass through, or fail. */
export type Policy = "off" | "warn" | "error";

type PartNames<S extends SideSpec> = S["parts"][number];
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
  /** A stable name (an operation id, a channel name). */
  readonly name?: string;
  /** Prose for the generated document. */
  readonly description?: string;
}

/** Where a contract is found at runtime: a non-enumerable property under this symbol. */
export const CONTRACT: unique symbol = Symbol.for("bun-validate.contract");

/** Something carrying contract `C` (a handler, a router layer, a queue definition). */
export interface Carries<C> {
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
// Static types derived from a contract
// ---------------------------------------------------------------------------

/** What a receiver gets from a schema: its output. */
export type ReceiveOf<S extends Schema> = StandardSchemaV1.InferOutput<S>;

/** What a sender is held to: the schema's input, or its output when the input is `unknown` (plan §4.3). */
export type SendOf<S extends Schema> =
  unknown extends StandardSchemaV1.InferInput<S>
    ? StandardSchemaV1.InferOutput<S>
    : StandardSchemaV1.InferInput<S>;

/** Whose view of a message: the sender's or the receiver's. */
export type Role = "send" | "receive";

type Of<S extends Schema, R extends Role> = R extends "send"
  ? SendOf<S>
  : ReceiveOf<S>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** A media-typed part's value: the media type it was sent as, and the value. */
export type MediaValue<M extends MediaMap, R extends Role> = {
  [K in keyof M & string]: { mediaType: K; value: Of<M[K], R> };
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
    [K in keyof P as undefined extends PartValue<P[K], R>
      ? never
      : K]: PartValue<P[K], R>;
  } & {
    [K in keyof P as undefined extends PartValue<P[K], R>
      ? K
      : never]?: PartValue<P[K], R>;
  }
>;

type SpecOf<C, Sd extends Side> =
  C extends Contract<infer T, unknown>
    ? T[Sd] extends SideSpec
      ? T[Sd]
      : never
    : never;
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

/** What a sender of side `Sd` is held to: each part's input, or output when the input is `unknown`. */
export type Sent<C, Sd extends Side> = MessageOf<C, Sd, "send">;

// ---------------------------------------------------------------------------
// Declaring a transport and a contract
// ---------------------------------------------------------------------------

type NoExtra<D, Allowed extends PropertyKey> = {
  [K in Exclude<keyof D, Allowed>]: never;
};
type StrictSide<S, D> = S extends SideSpec
  ? S["key"] extends string
    ? { [K in keyof D]: NoExtra<D[K], PartNames<S>> }
    : NoExtra<D, PartNames<S>>
  : never;
/** Rejects a part or side the transport does not declare (a generic's inference skips excess-property checks). */
export type StrictDef<T extends TransportSpec, D> = {
  [K in keyof D & Side]: StrictSide<T[K], D[K]>;
} & NoExtra<D, Side>;

/** A declared transport: its spec, and the factory for contracts typed against it. */
export interface Transport<T extends TransportSpec> {
  /** The declaration passed to {@link defineTransport}. */
  readonly spec: T;
  /** Creates a contract; undeclared sides and parts are type errors and `TypeError`s. */
  contract: <const D extends ContractDef<T>>(
    def: D & StrictDef<T, D>,
    meta?: ContractMeta,
  ) => Contract<T, D>;
}

/** Declares a transport by its part and key names; typing, validation and docs metadata follow from it. */
export function defineTransport<const T extends TransportSpec>(
  spec: T,
): Transport<T> {
  for (const side of ["inbound", "outbound"] as const) {
    const s = spec[side];
    if (s?.key !== undefined && s.parts.includes(s.key))
      throw new TypeError(
        `${spec.name}.${side}: the key "${s.key}" cannot also be a part`,
      );
    for (const m of s?.media ?? []) {
      if (!s?.parts.includes(m))
        throw new TypeError(
          `${spec.name}.${side}: media part "${m}" is not a part`,
        );
    }
  }
  const contract = <const D extends ContractDef<T>>(
    def: D & StrictDef<T, D>,
    meta: ContractMeta = {},
  ): Contract<T, D> => {
    for (const side of Object.keys(def)) {
      const s = spec[side as Side];
      if (s === undefined) throw new TypeError(`${spec.name}: no ${side} side`);
      const raw = (def as Record<string, Record<string, unknown>>)[side]!;
      for (const parts of s.key === undefined
        ? [raw]
        : (Object.values(raw) as Record<string, unknown>[])) {
        for (const part of Object.keys(parts)) {
          if (!s.parts.includes(part))
            throw new TypeError(
              `${spec.name}.${side}: "${part}" is not a part (${s.parts.join(", ")})`,
            );
        }
      }
    }
    const c = { transport: spec, def: def as D, meta } as Contract<T, D>;
    return attachContract(c, c) as Contract<T, D>;
  };
  return { spec, contract };
}

/** Makes `contract` reachable from `target` through {@link getContract}, non-enumerably. */
export function attachContract<X extends object, C>(
  target: X,
  contract: C,
): X & Carries<C> {
  Object.defineProperty(target, CONTRACT, {
    value: contract,
    enumerable: false,
  });
  return target as X & Carries<C>;
}

/** The contract `x` carries, typed when `x`'s type says which. */
export function getContract<C>(x: Carries<C>): C;
export function getContract(x: unknown): AnyContract | undefined;
export function getContract(x: unknown): unknown {
  return (typeof x === "object" || typeof x === "function") && x !== null
    ? (x as Partial<Carries<unknown>>)[CONTRACT]
    : undefined;
}

// ---------------------------------------------------------------------------
// The issue and the runner
// ---------------------------------------------------------------------------

/** One validation issue, flattened. Never carries the received value, in any field. */
export interface ContractIssue {
  /** The part that failed (`"body"`, `"payload"`), or the key field (`"status"`) for an undeclared key. */
  target: string;
  /** Vendor message, withheld (replaced by a generic one) when it quotes the received value. */
  message: string;
  /** Dotted path within the part, `""` for the part itself. */
  path: string;
  /** The variant's key (the status, message type or topic), on a keyed side. */
  key?: string;
  /** The media type, on a media-typed part. */
  mediaType?: string;
}

/** A flattened outcome: the parsed value, or every issue. */
export type StandardOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ContractIssue[] };

const MAX_LEAVES = 256;
const MAX_DEPTH = 8;

/** The received leaf values (and quoted keys) a message must not quote; bounded, run only on failure. */
function forbidden(value: unknown, out: string[], depth = 0): string[] {
  if (out.length >= MAX_LEAVES) return out;
  if (typeof value === "string")
    out.push(value.length >= 3 ? value : JSON.stringify(value));
  else if (typeof value === "number" || typeof value === "bigint")
    out.push(String(value).length >= 3 ? String(value) : `(was ${value})`);
  else if (
    typeof value === "object" &&
    value !== null &&
    depth < MAX_DEPTH &&
    !ArrayBuffer.isView(value) &&
    !(value instanceof Blob)
  ) {
    for (const [k, v] of Object.entries(value)) {
      if (!Array.isArray(value)) out.push(JSON.stringify(k));
      forbidden(v, out, depth + 1);
    }
  }
  return out;
}

function scrub(issue: StandardSchemaV1.Issue, received: unknown): string {
  const message = issue.message;
  for (const f of forbidden(received, [])) {
    if (message.includes(f)) {
      const code = (issue as { code?: unknown }).code;
      return typeof code === "string"
        ? `Invalid value (${code})`
        : "Invalid value";
    }
  }
  return message;
}

function formatPath(issue: StandardSchemaV1.Issue): string {
  if (!issue.path?.length) return "";
  return issue.path
    .map((s) =>
      typeof s === "object" && s !== null ? String(s.key) : String(s),
    )
    .join(".");
}

function flatten(
  result: StandardSchemaV1.Result<unknown>,
  target: string,
  received: unknown,
  key?: string,
  mediaType?: string,
): StandardOutcome<unknown> {
  if (!result.issues) return { ok: true, value: result.value };
  return {
    ok: false,
    issues: result.issues.map((i) => {
      const out: ContractIssue = {
        target,
        message: scrub(i, received),
        path: formatPath(i),
      };
      if (key !== undefined) out.key = key;
      if (mediaType !== undefined) out.mediaType = mediaType;
      return out;
    }),
  };
}

/**
 * Applies `f` to a value or a promise of one, staying synchronous when the
 * input is. Not named `then`: a module exporting `then` is a thenable, and
 * `await import()` of it calls that function (measured while building this).
 */
export function andThen<A, B>(
  x: MaybePromise<A>,
  f: (a: A) => MaybePromise<B>,
): MaybePromise<B> {
  return x instanceof Promise ? x.then(f) : f(x);
}

/**
 * The one runner (plan V-D2): validates `value` with `schema` and flattens the
 * issues under `target`. Synchronous when the vendor is; a Promise only when
 * the vendor returns one.
 */
export function validateStandard<S extends Schema>(
  schema: S,
  value: unknown,
  target: string,
  key?: string,
  mediaType?: string,
): MaybePromise<StandardOutcome<ReceiveOf<S>>> {
  const r = schema["~standard"].validate(value);
  return (
    r instanceof Promise
      ? r.then((x) => flatten(x, target, value, key, mediaType))
      : flatten(r, target, value, key, mediaType)
  ) as MaybePromise<StandardOutcome<ReceiveOf<S>>>;
}

/** Media types match without parameters and case (`text/plain; charset=utf-8` → `text/plain`). */
function mediaEntry(map: MediaMap, mediaType: string): Schema | undefined {
  const bare = mediaType.split(";")[0]!.trim().toLowerCase();
  for (const [k, s] of Object.entries(map)) {
    if (k.toLowerCase() === bare) return s;
  }
  return undefined;
}

function isSchema(d: PartDecl): d is Schema {
  return d !== null && "~standard" in d;
}

function checkPart(
  part: string,
  decl: PartDecl,
  value: unknown,
  key: string | undefined,
): MaybePromise<StandardOutcome<unknown>> {
  if (decl === null) {
    return value === undefined
      ? { ok: true, value }
      : {
          ok: false,
          issues: [
            {
              target: part,
              message: `No ${part} is declared here`,
              path: "",
              ...(key === undefined ? {} : { key }),
            },
          ],
        };
  }
  if (isSchema(decl)) return validateStandard(decl, value, part, key);
  const mv = value as { mediaType?: unknown; value?: unknown } | undefined;
  const mediaType = typeof mv?.mediaType === "string" ? mv.mediaType : "";
  const schema = mediaEntry(decl, mediaType);
  if (schema === undefined) {
    const issue: ContractIssue = {
      target: part,
      message: `Media type "${mediaType}" is not declared (${Object.keys(decl).join(", ")})`,
      path: "",
      mediaType,
    };
    if (key !== undefined) issue.key = key;
    return { ok: false, issues: [issue] };
  }
  return andThen(
    validateStandard(schema, mv?.value, part, key, mediaType),
    (o) => (o.ok ? { ok: true, value: { mediaType, value: o.value } } : o),
  );
}

/**
 * A Standard Schema over a record of schemas (a flow's children results, a
 * gRPC metadata map). Sync when every member is.
 */
export function recordOf<const M extends Readonly<Record<string, Schema>>>(
  schemas: M,
  options: { vendor?: string } = {},
): StandardSchemaV1<
  { [K in keyof M]: SendOf<M[K]> },
  { [K in keyof M]: ReceiveOf<M[K]> }
> {
  type Out = { [K in keyof M]: ReceiveOf<M[K]> };
  const validate = (
    value: unknown,
  ): MaybePromise<StandardSchemaV1.Result<Out>> => {
    if (typeof value !== "object" || value === null)
      return { issues: [{ message: "Expected an object", path: [] }] };
    const entries = Object.entries(schemas);
    const results = entries.map(([k, s]) =>
      s["~standard"].validate((value as Record<string, unknown>)[k]),
    );
    const finish = (
      settled: StandardSchemaV1.Result<unknown>[],
    ): StandardSchemaV1.Result<Out> => {
      const out: Record<string, unknown> = {};
      const issues: StandardSchemaV1.Issue[] = [];
      settled.forEach((r, i) => {
        const k = entries[i]![0];
        if (r.issues)
          issues.push(
            ...r.issues.map((x) => ({
              message: x.message,
              path: [k, ...(x.path ?? [])],
            })),
          );
        else out[k] = r.value;
      });
      return issues.length ? { issues } : { value: out as Out };
    };
    return results.some((r) => r instanceof Promise)
      ? Promise.all(results).then(finish)
      : finish(results as StandardSchemaV1.Result<unknown>[]);
  };
  return {
    "~standard": {
      version: 1,
      vendor: options.vendor ?? "contract-core",
      validate,
    },
  } as StandardSchemaV1<{ [K in keyof M]: SendOf<M[K]> }, Out>;
}

// ---------------------------------------------------------------------------
// The policy: a compiled guard per contract side
// ---------------------------------------------------------------------------

/** A structured `warn`, the shape bun-common's `Logger` has. */
export interface WarnLogger {
  /** Logs one structured warning. */
  warn: (message: string, fields: Record<string, unknown>) => void;
}

/** Where the issues came from, for telemetry. */
export interface IssueContext {
  /** The transport's name. */
  transport: string;
  /** The side checked. */
  side: Side;
  /** The variant's key, on a keyed side. */
  key?: string;
  /** The policy in force (`"warn"` or `"error"`; `"off"` never reports). */
  policy: Policy;
}

/** How a guard enforces a side. */
export interface GuardOptions {
  /** What a mismatch does. Default `"error"`. */
  policy?: Policy;
  /** Receives `"warn"`'s log line. Default: `console.warn` with the same fields. */
  logger?: WarnLogger;
  /** Telemetry hook (an OTel `validation.failed` span event), called once per failing message; nothing when unset. */
  onIssues?: (issues: readonly ContractIssue[], ctx: IssueContext) => void;
  /** An undeclared key on a keyed side: an issue (`"report"`, default) or passed through unchecked (`"allow"`). */
  undeclaredKey?: "report" | "allow";
}

/** Raised (or returned by a guard) when a message fails its contract under `"error"`. */
export class ContractError extends Error {
  /** Every issue, value-free. */
  readonly issues: readonly ContractIssue[];
  /** The context the issues were found in. */
  readonly context: IssueContext;
  constructor(issues: readonly ContractIssue[], context: IssueContext) {
    super(
      `${context.transport} ${context.side}${context.key === undefined ? "" : ` ${context.key}`} failed its contract: ${issues.map((i) => `${i.target}${i.path ? `.${i.path}` : ""}: ${i.message}`).join("; ")}`,
    );
    this.name = "ContractError";
    this.issues = issues;
    this.context = context;
  }
}

/**
 * A compiled check of one side. A receiver's resolves to the parsed message
 * (each part's output); a sender's to the very message it was given, since
 * the sender's value is what goes on the wire. Either resolves to a
 * {@link ContractError} on failure under `"error"`.
 */
export interface Guard<In, Out> {
  (message: In): MaybePromise<Out | ContractError>;
  /** `false` when the side has nothing to check (no schema, or `"off"`): the guard is the identity, and an adapter may skip the call. */
  readonly checks: boolean;
}

type Plan = readonly (readonly [part: string, decl: PartDecl])[];

const toPlan = (parts: object): Plan =>
  Object.entries(parts).filter(([, d]) => d !== undefined) as [
    string,
    PartDecl,
  ][];

/** The guard of a side with nothing to check: returns its argument, allocates nothing. */
const identity = Object.assign((message: unknown): unknown => message, {
  checks: false as const,
});

function compile(
  contract: AnyContract,
  side: Side,
  options: GuardOptions,
  parse: boolean,
): Guard<unknown, unknown> {
  const {
    policy = "error",
    logger,
    onIssues,
    undeclaredKey = "report",
  } = options;
  const spec = contract.transport[side];
  const def = (contract.def as Partial<Record<Side, Record<string, object>>>)[
    side
  ];
  const keyName = spec?.key;
  const single: Plan =
    def === undefined || keyName !== undefined ? [] : toPlan(def);
  // "off", no side declared, or an unkeyed side without schemas: nothing to do per message.
  if (
    policy === "off" ||
    def === undefined ||
    (keyName === undefined && single.length === 0)
  )
    return identity;
  const plans = new Map<string, Plan>();
  if (keyName !== undefined) {
    for (const [k, parts] of Object.entries(def)) plans.set(k, toPlan(parts));
  }
  const transport = contract.transport.name;

  const fail = (
    message: unknown,
    issues: ContractIssue[],
    key: string | undefined,
  ): unknown => {
    const ctx: IssueContext =
      key === undefined
        ? { transport, side, policy }
        : { transport, side, key, policy };
    if (onIssues !== undefined) onIssues(issues, ctx);
    if (policy === "error") return new ContractError(issues, ctx);
    const fields = {
      transport,
      side,
      key,
      issues: issues.map((i) => ({
        target: i.target,
        path: i.path,
        message: i.message,
        key: i.key,
      })),
    };
    if (logger) logger.warn("contract mismatch", fields);
    else console.warn("contract mismatch", fields);
    return message;
  };

  const finish = (
    message: unknown,
    plan: Plan,
    settled: readonly StandardOutcome<unknown>[],
    key: string | undefined,
  ): unknown => {
    let issues: ContractIssue[] | undefined;
    for (const o of settled) {
      if (!o.ok) (issues ??= []).push(...o.issues);
    }
    if (issues) return fail(message, issues, key);
    if (!parse) return message;
    const out: Record<string, unknown> = { ...(message as object) };
    for (let i = 0; i < plan.length; i++)
      out[plan[i]![0]] = (settled[i] as { value: unknown }).value;
    return out;
  };

  const guard = (message: unknown): MaybePromise<unknown> => {
    const msg = message as Record<string, unknown>;
    let plan = single;
    let key: string | undefined;
    if (keyName !== undefined) {
      const k = msg[keyName];
      key = typeof k === "string" ? k : String(k);
      const found = plans.get(key);
      if (found === undefined) {
        return undeclaredKey === "allow"
          ? message
          : fail(
              message,
              [
                {
                  target: keyName,
                  message: `${keyName} ${key} is not declared`,
                  path: "",
                  key,
                },
              ],
              key,
            );
      }
      if (found.length === 0) return message; // a key with no schema: no allocation either
      plan = found;
    }
    const results: MaybePromise<StandardOutcome<unknown>>[] = Array.from({
      length: plan.length,
    });
    let pending = false;
    for (let i = 0; i < plan.length; i++) {
      const [part, decl] = plan[i]!;
      const r = checkPart(part, decl, msg[part], key);
      results[i] = r;
      pending ||= r instanceof Promise;
    }
    return pending
      ? Promise.all(results).then((settled) =>
          finish(message, plan, settled, key),
        )
      : finish(message, plan, results as StandardOutcome<unknown>[], key);
  };
  return Object.assign(guard, { checks: true });
}

/**
 * Compiles a receiver for one side: it parses, so the handler gets each part's
 * output. `"warn"` passes the raw message through on a mismatch; `"off"`
 * passes it unchecked (so its static type is a promise the runtime did not
 * keep: see README, open questions).
 */
export function createReceiver<C extends AnyContract, Sd extends Side>(
  contract: C,
  side: Sd,
  options: GuardOptions = {},
): Guard<unknown, Received<C, Sd>> {
  return compile(contract, side, options, true) as Guard<
    unknown,
    Received<C, Sd>
  >;
}

/**
 * Compiles a sender for one side: it checks, and resolves to the same message
 * it was given, which is what goes on the wire. Typed by the input rule.
 */
export function createSender<C extends AnyContract, Sd extends Side>(
  contract: C,
  side: Sd,
  options: GuardOptions = {},
): Guard<Sent<C, Sd>, Sent<C, Sd>> {
  return compile(contract, side, options, false) as Guard<
    Sent<C, Sd>,
    Sent<C, Sd>
  >;
}

// ---------------------------------------------------------------------------
// Reading a contract back: what an OpenAPI/AsyncAPI generator or a typed client walks
// ---------------------------------------------------------------------------

/** One schema in a contract, located. */
export interface ContractEntry {
  /** The side it belongs to. */
  side: Side;
  /** The transport's key field (`"status"`), on a keyed side. */
  keyName?: string;
  /** The variant's key (`"200"`), on a keyed side. */
  key?: string;
  /** The part. */
  part: string;
  /** The media type, on a media-typed part. */
  mediaType?: string;
  /** The schema, or `null` for a part declared absent. */
  schema: Schema | null;
  /** The schema's vendor (`"zod"`). */
  vendor?: string;
}

/** Flattens a contract into its schemas, in declaration order. */
export function describeContract(contract: AnyContract): ContractEntry[] {
  const out: ContractEntry[] = [];
  for (const side of ["inbound", "outbound"] as const) {
    const spec = contract.transport[side];
    const def = (contract.def as Partial<Record<Side, Record<string, object>>>)[
      side
    ];
    if (spec === undefined || def === undefined) continue;
    const variants: [string | undefined, object][] =
      spec.key === undefined ? [[undefined, def]] : Object.entries(def);
    for (const [key, parts] of variants) {
      for (const [part, decl] of toPlan(parts)) {
        const base = {
          side,
          part,
          ...(spec.key === undefined ? {} : { keyName: spec.key, key }),
        };
        if (decl === null || isSchema(decl))
          out.push({
            ...base,
            schema: decl,
            ...(decl ? { vendor: decl["~standard"].vendor } : {}),
          });
        else
          for (const [mediaType, s] of Object.entries(decl))
            out.push({
              ...base,
              mediaType,
              schema: s,
              vendor: s["~standard"].vendor,
            });
      }
    }
  }
  return out;
}
