/**
 * Response variants (plan §4.4.6, V3c): a prototype, not product code.
 *
 * Within one status, a response may take one of several **variants**, each a
 * whole response spec (headers, cookies, content). A response must match one
 * variant as a whole, never a part from one and a part from another. A
 * variant may carry `when`, a predicate on the request's validated parts
 * (`req.valid`), so only the variants whose `when` holds are acceptable for
 * this request; and a status may name a **discriminant**, a response header
 * or cookie whose value selects the variant.
 *
 * Two halves:
 *
 * - **Types** that compose with the real V3a types (`InferResponses`,
 *   `ResponseSpecObject`, `InferValidatedShape`, `ValidatorMiddleware`),
 *   imported from `packages/bun-common/lib`, so the generated verb overloads
 *   and the real `BunResponse` are what `types.probe.ts` checks against.
 *   `.variant()` is added to `BunResponse` there by module augmentation, so no
 *   lib file is changed.
 * - **A runtime matcher** over a response view (`{ status, headers, cookies,
 *   mediaType, body, variant }`) and a request view (`{ valid, raw }`), the
 *   decision V3c's commit gate would make. It uses the core's real runner
 *   (`runSchema`, which scrubs received values out of issues).
 */
import type { BunRequest } from "../../../../../packages/bun-common/lib/BunRequest";
import type {
  InferValidatedShape,
  ValidationSchemas,
  ValidatorMiddleware,
} from "../../../../../packages/bun-common/lib/BunValidate";
import type {
  MaybePromise,
  Policy,
  Schema,
  ValidationIssue,
} from "../../../../../packages/bun-common/lib/contract/model";
import type {
  ResponseSpec,
  ResponseSpecObject,
  SetCookieView,
} from "../../../../../packages/bun-common/lib/responseValidation";
import type { InferResponses } from "../../../../../packages/bun-common/lib/types/responseTyping";
import type { StandardSchemaV1 } from "../../../../../packages/bun-common/lib/types/standardSchema";
import {
  andThen,
  runSchema,
  toIssues,
} from "../../../../../packages/bun-common/lib/contract/issues";
import { jsonSchemaOf } from "../../../../../packages/bun-common/lib/contract/schemas";

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * A variant's `when`: a predicate on the request's validated parts
 * (`req.valid`, typed by the validator), with the raw request second for
 * what no schema parsed (an auth middleware's `req.user`). A boolean is
 * decided in place (no Promise is made); a Promise of one is awaited, holding
 * the commit (the user's answer to Q-H17, 2026-10-21).
 */
export type When<V> = (valid: V, req: BunRequest) => boolean | Promise<boolean>;

/** What a discriminant value maps a variant to: an exact value, `true` (present, any value) or `null` (absent). */
export type DiscriminantValue = string | true | null;

/** A response header or `Set-Cookie` whose value selects the variant. `values` defaults to each variant's name. */
export type Discriminant<N extends string = string> =
  | {
      /** The response header (lower-case) whose value selects the variant. */
      readonly header: string;
      /** Variant name to the value that selects it; default: the name itself. */
      readonly values?: { readonly [K in N]?: DiscriminantValue };
    }
  | {
      /** The `Set-Cookie` name whose value selects the variant. */
      readonly cookie: string;
      /** Variant name to the value that selects it; default: the name itself. */
      readonly values?: { readonly [K in N]?: DiscriminantValue };
    };

/** The response a `refine` sees: every part as the gate saw it. */
export interface RefineResponse {
  /** The status. */
  readonly status: number;
  /** Lower-case header names to values (`set-cookie` is `cookies`). */
  readonly headers: Readonly<Record<string, string>>;
  /** The `Set-Cookie`s, by name. */
  readonly cookies: Readonly<Record<string, SetCookieView>>;
  /** The bare media type, when there is a body. */
  readonly mediaType: string | undefined;
  /** The body as the schema saw it (`undefined` for a stream or no body). */
  readonly body: unknown;
  /** The variant the parts matched; `undefined` on a status with no variants. */
  readonly variant: string | undefined;
}

/** One issue a `refine` reports. Its message is scrubbed like a schema's. */
export interface RefineIssue {
  /** The part the issue is about. */
  readonly part: "status" | "headers" | "cookies" | "body";
  /** Dotted path within the part; `""` or absent for the part itself. */
  readonly path?: string;
  /** What is wrong. A received value quoted here is withheld, as for a schema. */
  readonly message: string;
}

/** A whole-response check, run after the parts match. Synchronous. */
export type Refine = (
  response: RefineResponse,
  req: BunRequest,
) => readonly RefineIssue[] | undefined;

/** One variant: a whole response spec, plus `when`, `refine` and a description for documents. */
export interface VariantSpec<V> extends ResponseSpecObject {
  /** Acceptable only for requests where this holds; absent: for every request. */
  readonly when?: When<V>;
  /** A whole-response check after this variant's parts match. */
  readonly refine?: Refine;
  /** Says, for documents, when this variant is sent (a `when` cannot be documented). */
  readonly description?: string;
}

/** What `variants()` returns: a status's variants, its discriminant and its refine. */
export interface ResponseVariants<T, B, V> {
  /** Marks a variants declaration. */
  readonly kind: "variants";
  /** Variant name to its spec. */
  readonly table: T;
  /** The discriminant, if any. */
  readonly by: B;
  /** A whole-response check for every variant of the status. */
  readonly refine: Refine | undefined;
  /** Phantom: the request view `when` takes; never present at runtime. */
  readonly __request?: (valid: V) => void;
}

/** The options of `variants()`. */
export interface VariantsOptions<B> {
  /** A response header or cookie selecting the variant. */
  readonly by?: B;
  /** A whole-response check for every variant. */
  readonly refine?: Refine;
}

/**
 * Declares a status's variants. `V`, the request view each `when` takes, is
 * inferred from where the call sits (`validate()`'s schemas), so `when` is
 * typed with nothing restated; outside a validator (`commonResponses`) it is
 * {@link UntypedValid}, every part optional and `unknown`.
 */
export function variants<
  const T extends Readonly<Record<string, VariantSpec<V>>>,
  const B extends Discriminant<keyof T & string> | undefined = undefined,
  V = UntypedValid,
>(
  table: T & StrictTable<T>,
  options?: VariantsOptions<B> & StrictBy<B, keyof T & string>,
): ResponseVariants<T, NoInfer<B>, V> {
  return {
    kind: "variants",
    table,
    by: options?.by as B,
    refine: options?.refine,
  };
}

/** Refuses an unknown key in a variant (a `const` generic skips excess-property checks). */
type StrictTable<T> = {
  readonly [N in keyof T]: {
    readonly [K in keyof T[N]]: K extends keyof VariantSpec<unknown>
      ? T[N][K]
      : never;
  };
};

/** Refuses a `values` key that names no variant. */
type StrictBy<B, N extends string> = B extends { values: infer M }
  ? {
      readonly by?: {
        readonly values?: {
          readonly [K in keyof M]: K extends N ? M[K] : never;
        };
      };
    }
  : unknown;

/** A status in a `responses` table, variants allowed, `when` typed by `V`. */
export type VariantResponseSpec<V> =
  | ResponseSpec
  | ResponseVariants<
      Readonly<Record<string, VariantSpec<V>>>,
      Discriminant | undefined,
      V
    >;

/** A `responses` table, variants allowed. */
export type VariantResponseSchemas<V> = Readonly<
  Record<number, VariantResponseSpec<V>>
>;

// ===========================================================================
// Static types: from a declaration to the real V3a `ResponseTypeMap`
// ===========================================================================

/** One status's real V3a spec (`json`, `send`, `headers`, `cookies`). */
type SpecOf<Sp> = InferResponses<{ 0: Sp }>[0];

/** The discriminant's value for variant `N`, as a header value type. */
type DiscValue<B, N extends string> = B extends { values: infer M }
  ? N extends keyof M
    ? M[N] extends string
      ? M[N]
      : M[N] extends true
        ? string
        : never // `null`: absent. The real HeaderArg reads never as "any value" (see the probe's B1)
    : N
  : N;

/** Variant `N`'s headers with the discriminant header pinned to its value. */
type WithDisc<H, B, N extends string> = B extends {
  header: infer Name extends string;
}
  ? Omit<H, Name> & { [P in Name]: DiscValue<B, N> }
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

/** Keys of `T` whose (required) value is a single literal: `.variant()` fills them. */
type LiteralKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K>
    ? never
    : IsSingleLiteral<T[K]> extends true
      ? K
      : never;
}[keyof T];

/**
 * What a handler passes after `.variant()`: every required single-literal
 * field optional, through nested objects and array elements (the runtime
 * fills them, Q-H18).
 */
export type LiteralOptional<T> = T extends readonly (infer E)[]
  ? LiteralOptional<E>[]
  : T extends Date | Uint8Array | ArrayBuffer | Blob
    ? T
    : T extends object
      ? Flat<
          { [K in LiteralKeys<T>]?: T[K] } & {
            [K in keyof T as K extends LiteralKeys<T>
              ? never
              : K]: LiteralOptional<T[K]>;
          }
        >
      : T;
type Flat<T> = { [K in keyof T]: T[K] };

/**
 * Whether every JSON body schema of a variant carries `~standard.jsonSchema`
 * in its type (zod 4, arktype 2 do; valibot, yup do not): only then can the
 * runtime find the literals, so only then are they optional in the types.
 */
type Fillable<Sp> = Sp extends { content: infer C }
  ? [
      {
        [K in keyof C]: C[K] extends {
          "~standard": { jsonSchema: { input: (...args: never[]) => unknown } };
        }
          ? never
          : K;
      }[keyof C],
    ] extends [never]
    ? true
    : false
  : false;

/** One variant as a real V3a spec, tagged with its name. */
type VariantTypeSpec<Sp, B, N extends string> =
  SpecOf<Sp> extends infer S extends {
    json: unknown;
    send: unknown;
    headers: object;
    cookies: object;
  }
    ? {
        json: S["json"];
        send: S["send"];
        headers: WithDisc<S["headers"], B, N>;
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
    : never;

/**
 * A `responses` table's real V3a map: a plain status as V3a infers it; a
 * variants status as the **union** of its variants' specs, each tagged with
 * `variant`. The real `SpecField` distributes over that union, so without
 * `.variant()` every method takes the union, as today.
 */
export type InferVariantResponses<RS> = {
  [K in keyof RS]: RS[K] extends ResponseVariants<infer T, infer B, infer _V>
    ? { [N in keyof T & string]: VariantTypeSpec<T[N], B, N> }[keyof T & string]
    : SpecOf<RS[K]>;
};

/** The variant names a map declares, across its statuses. `never` with none, or with no map. */
export type VariantNames<M> = [M] extends [undefined]
  ? never
  : M[keyof M] extends infer S
    ? S extends { variant: infer N extends string }
      ? N
      : never
    : never;

/** The map after `.variant(N)`: each status's variant `N` alone; a status without one is dropped. */
export type NarrowVariant<M, N extends string> = {
  [K in keyof M as [Extract<M[K], { variant: N }>] extends [never]
    ? never
    : K]: Filled<Extract<M[K], { variant: N }>>;
};

/** A variant's spec with `json`/`send` swapped for their filled forms. */
type Filled<S> = S extends { filledJson: infer J; filledSend: infer D }
  ? Omit<S, "json" | "send"> & { json: J; send: D }
  : S;

/**
 * A prototype `validate()`: the real `InferValidatedShape` for the request,
 * plus this file's responses map, carried on the real `ValidatorMiddleware`
 * phantom, so the real overloads type the handler. Types only: at runtime it
 * is a pass-through (the gate is V3c's).
 */
export function validateV<
  S extends ValidationSchemas,
  const RS extends VariantResponseSchemas<InferValidatedShape<S>>,
>(
  schemas: S,
  options: { readonly responses: RS; readonly responseValidation?: Policy },
): ValidatorMiddleware<
  InferValidatedShape<S> & { responses: InferVariantResponses<RS> }
> {
  void schemas;
  void options;
  return ((_req: unknown, _res: unknown, next: () => void) => next()) as never;
}

/** The view `when` takes under `commonResponses` (a router has no validator): every part optional and `unknown`. */
export type UntypedValid = Partial<
  Record<
    "headers" | "cookies" | "signedCookies" | "params" | "query" | "body",
    unknown
  >
>;

// ===========================================================================
// Runtime: compiling a table, and matching one response
// ===========================================================================

/** What a failing check threw, as the gate would log it (never in an issue). */
export const errorsLogged: unknown[] = [];

/** The parts a variant issue is about. */
type Part = "status" | "headers" | "cookies" | "body";

/** A response issue, with the variant it was checked against. */
export interface VariantIssue extends ValidationIssue<Part> {
  /** The variant the issue belongs to (absent for one about the status as a whole). */
  variant?: string;
}

/** The response, as the commit gate would see it. */
export interface ResponseView {
  /** The status. */
  readonly status: number;
  /** Lower-case header names to values, without `set-cookie`. */
  readonly headers: Readonly<Record<string, string>>;
  /** The `Set-Cookie`s, by name. */
  readonly cookies: Readonly<Record<string, SetCookieView>>;
  /** The bare media type; absent with no body. */
  readonly mediaType?: string;
  /** The parsed body; absent with none. */
  readonly body?: unknown;
  /** The variant the handler named with `res.variant()`, if it did. */
  readonly variant?: string;
  /** `false` when the handler never set the status (the default 200 stands), so `.variant()` may. */
  readonly statusExplicit?: boolean;
  /** `false` when `Content-Type` is only `json()`'s implicit one, so `.variant()` may set the declared one. */
  readonly contentTypeExplicit?: boolean;
}

/** The request, as `when` sees it: `req.valid`, and the raw request. */
export interface RequestView {
  /** `req.valid`: only the parts a validator parsed. */
  readonly valid: Readonly<Record<string, unknown>>;
  /** The raw request (the spike passes a plain object). */
  readonly raw?: unknown;
}

/** One compiled variant (a plain status compiles to one, unnamed). */
interface Compiled {
  readonly name: string | undefined;
  readonly when: ((valid: never, req: never) => unknown) | undefined;
  readonly headers: Schema | undefined;
  readonly cookies: Schema | undefined;
  /** `undefined` unchecked; `null` no body; else bare media type to schema (`null`: empty). */
  readonly content: ReadonlyMap<string, Schema | null> | null | undefined;
  readonly refine: Refine | undefined;
  /** What `.variant()` may fill or strip; only on a named variant. */
  readonly adjust?: AdjustPlan;
}

/** A compiled status. */
type CompiledStatus =
  | { readonly kind: "plain"; readonly spec: Compiled }
  | {
      readonly kind: "variants";
      readonly list: readonly Compiled[];
      readonly byName: ReadonlyMap<string, Compiled>;
      readonly by:
        | {
            readonly part: "headers" | "cookies";
            readonly name: string;
            readonly select: (value: string | undefined) => string | undefined;
            readonly allowed: string;
            /** The exact value selecting a variant (to fill), if one is declared. */
            readonly valueOf: (variant: string) => string | undefined;
          }
        | undefined;
      readonly refine: Refine | undefined;
    };

/** A compiled table. */
export type CompiledTable = ReadonlyMap<number, CompiledStatus>;

const SPEC_KEYS = new Set(["headers", "cookies", "content"]);
const VARIANT_KEYS = new Set([...SPEC_KEYS, "when", "refine", "description"]);

const isSchema = (x: unknown): x is Schema =>
  typeof x === "object" && x !== null && "~standard" in x;

function compileSpec(
  spec: unknown,
  name: string | undefined,
  where: string,
): Compiled {
  if (spec === null) {
    return {
      name,
      when: undefined,
      headers: undefined,
      cookies: undefined,
      content: null,
      refine: undefined,
    };
  }
  if (isSchema(spec)) {
    return {
      name,
      when: undefined,
      headers: undefined,
      cookies: undefined,
      content: new Map([["application/json", spec]]),
      refine: undefined,
    };
  }
  if (typeof spec !== "object")
    throw new TypeError(`${where}: not a response spec`);
  const keys = name === undefined ? SPEC_KEYS : VARIANT_KEYS;
  for (const key of Object.keys(spec)) {
    if (!keys.has(key)) {
      throw new TypeError(
        key === "when" && name === undefined
          ? `${where}: \`when\` belongs on a variant; declare variants({ … })`
          : `${where}: unknown key ${JSON.stringify(key)}`,
      );
    }
  }
  const s = spec as Record<string, unknown>;
  if (s.when !== undefined && typeof s.when !== "function") {
    throw new TypeError(`${where}.when: expected a function`);
  }
  const content =
    s.content === undefined
      ? undefined
      : s.content === null
        ? null
        : new Map(
            Object.entries(s.content as Record<string, Schema | null>).map(
              ([k, v]) => [k.split(";")[0].trim().toLowerCase(), v],
            ),
          );
  return {
    name,
    when: s.when as Compiled["when"],
    headers: s.headers as Schema | undefined,
    cookies: s.cookies as Schema | undefined,
    content,
    refine: s.refine as Refine | undefined,
    ...(name === undefined
      ? {}
      : {
          adjust: planAdjust(
            s.headers as Schema | undefined,
            s.cookies as Schema | undefined,
            content,
          ),
        }),
  };
}

/** Compiles a `responses` table, variants included. Declaration mistakes are `TypeError`s. */
export function compile(
  responses: Readonly<Record<number, unknown>>,
): CompiledTable {
  const out = new Map<number, CompiledStatus>();
  for (const [key, spec] of Object.entries(responses)) {
    const status = Number(key);
    const where = `responses[${key}]`;
    if (
      typeof spec === "object" &&
      spec !== null &&
      (spec as { kind?: unknown }).kind === "variants"
    ) {
      const v = spec as ResponseVariants<
        Record<string, unknown>,
        Discriminant | undefined,
        unknown
      >;
      const names = Object.keys(v.table);
      if (names.length === 0)
        throw new TypeError(`${where}: variants() declares none`);
      const list = names.map((n) =>
        compileSpec(v.table[n], n, `${where}.${n}`),
      );
      out.set(status, {
        kind: "variants",
        list,
        byName: new Map(list.map((c) => [c.name as string, c])),
        by: v.by === undefined ? undefined : compileBy(v.by, names, where),
        refine: v.refine,
      });
    } else {
      out.set(status, {
        kind: "plain",
        spec: compileSpec(spec, undefined, where),
      });
    }
  }
  return out;
}

/** Compiles a discriminant: exact values first, then `true` (present), then `null` (absent). */
function compileBy(by: Discriminant, names: readonly string[], where: string) {
  const hasHeader = "header" in by;
  const hasCookie = "cookie" in by;
  if (hasHeader === hasCookie)
    throw new TypeError(`${where}.by: name exactly one of header, cookie`);
  const values = (by.values ?? {}) as Record<
    string,
    DiscriminantValue | undefined
  >;
  for (const n of Object.keys(values)) {
    if (!names.includes(n))
      throw new TypeError(
        `${where}.by.values: ${JSON.stringify(n)} is not a variant`,
      );
  }
  const exact = new Map<string, string>();
  let present: string | undefined;
  let absent: string | undefined;
  for (const n of names) {
    const value = n in values ? values[n] : n;
    if (value === undefined) continue; // not selectable by the discriminant
    const clash = (other: string | undefined) => {
      if (other !== undefined)
        throw new TypeError(
          `${where}.by: ${other} and ${n} are selected by the same value`,
        );
    };
    if (value === null) {
      clash(absent);
      absent = n;
    } else if (value === true) {
      clash(present);
      present = n;
    } else {
      clash(exact.get(value));
      exact.set(value, n);
    }
  }
  const allowed = [
    ...exact.keys(),
    ...(present ? ["(any value)"] : []),
    ...(absent ? ["(absent)"] : []),
  ].join(", ");
  return {
    part: hasHeader ? ("headers" as const) : ("cookies" as const),
    name: hasHeader
      ? (by as { header: string }).header.toLowerCase()
      : (by as { cookie: string }).cookie,
    select: (value: string | undefined) =>
      value === undefined ? absent : (exact.get(value) ?? present),
    allowed,
    valueOf: (variant: string) => {
      for (const [value, n] of exact) if (n === variant) return value;
      return undefined; // `true` or `null`: not one value, nothing to fill
    },
  };
}

// ===========================================================================
// `.variant()` adjusts the response (Q-H18): fill single literals, strip
// undeclared body fields. Planned once per variant from the schemas'
// `~standard.jsonSchema` (input side: what goes on the wire).
// ===========================================================================

/** A JSON Schema node, as far as the plan reads one. */
type Js = Readonly<Record<string, unknown>>;

/** What `.variant()` does to one JSON value. */
type NodePlan =
  | {
      readonly kind: "object";
      /** Required properties that admit one value: filled when absent. */
      readonly fill: readonly (readonly [string, unknown])[];
      /** Declared properties' own plans. */
      readonly props: ReadonlyMap<string, NodePlan>;
      /** Whether undeclared keys are removed (no `additionalProperties: true`/schema, no `patternProperties`). */
      readonly strip: boolean;
    }
  | { readonly kind: "array"; readonly items: NodePlan }
  | { readonly kind: "leaf" };

/** A variant's adjust plan. */
export interface AdjustPlan {
  /** Required headers that admit one value. */
  readonly headers: readonly (readonly [string, string])[];
  /** Required cookies whose value and every required attribute admit one value. */
  readonly cookies: readonly (readonly [string, SetCookieView])[];
  /** The one media type the variant declares, if it declares one. */
  readonly mediaType: string | undefined;
  /** Body plans by bare media type; `undefined` where the schema has no JSON Schema (not adjustable). */
  readonly bodies: ReadonlyMap<string, NodePlan | undefined>;
}

const LEAF: NodePlan = { kind: "leaf" };

/** The single value a node admits (`const`, or an `enum` of one), else `NOT_ONE`. */
const NOT_ONE = Symbol("not one value");
function oneValue(js: Js): unknown {
  if ("const" in js) return js.const;
  if (Array.isArray(js.enum) && js.enum.length === 1) return js.enum[0];
  return NOT_ONE;
}

/** The input JSON Schema a schema carries, or `undefined` (none, or the vendor could not express it). */
function inputJsonSchema(schema: Schema | null | undefined): Js | undefined {
  if (schema === null || schema === undefined) return undefined;
  const converter = jsonSchemaOf(schema);
  if (converter === undefined) return undefined;
  try {
    // `libraryOptions` is per vendor; zod reads `unrepresentable: "any"` (a z.date() is `{}`, not a throw).
    return converter.input({
      target: "draft-2020-12",
      libraryOptions: { unrepresentable: "any" },
    } as never) as Js;
  } catch {
    return undefined;
  }
}

/** Plans one node; `$ref`s into `$defs` resolved, unions and intersections left alone. */
function planNode(js: Js, root: Js, depth: number): NodePlan {
  if (depth > 16) return LEAF;
  const ref = js.$ref;
  if (typeof ref === "string") {
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
    const target = m
      ? (root[m[1]] as Record<string, Js> | undefined)?.[m[2]]
      : undefined;
    return target ? planNode(target, root, depth + 1) : LEAF;
  }
  if ("anyOf" in js || "oneOf" in js || "allOf" in js) return LEAF; // union limit: neither filled nor stripped
  if (
    js.type === "array" &&
    typeof js.items === "object" &&
    js.items !== null
  ) {
    return { kind: "array", items: planNode(js.items as Js, root, depth + 1) };
  }
  if (js.type === "object" || typeof js.properties === "object") {
    const properties = (js.properties ?? {}) as Record<string, Js>;
    const required = new Set(
      Array.isArray(js.required) ? (js.required as string[]) : [],
    );
    const fill: (readonly [string, unknown])[] = [];
    const props = new Map<string, NodePlan>();
    for (const [key, prop] of Object.entries(properties)) {
      const value = oneValue(prop);
      if (value !== NOT_ONE && required.has(key)) fill.push([key, value]);
      props.set(key, planNode(prop, root, depth + 1));
    }
    const extra = js.additionalProperties;
    const strip = !(
      extra === true ||
      (typeof extra === "object" && extra !== null) ||
      "patternProperties" in js
    );
    return { kind: "object", fill, props, strip };
  }
  return LEAF;
}

/** Plans a variant: its literal headers and cookies, its one media type, and each body. */
function planAdjust(
  headers: Schema | undefined,
  cookies: Schema | undefined,
  content: ReadonlyMap<string, Schema | null> | null | undefined,
): AdjustPlan {
  const literalProps = (js: Js | undefined) => {
    const out: [string, Js][] = [];
    const required = new Set(
      Array.isArray(js?.required) ? (js.required as string[]) : [],
    );
    for (const [k, v] of Object.entries(
      (js?.properties ?? {}) as Record<string, Js>,
    )) {
      if (required.has(k)) out.push([k, v]);
    }
    return out;
  };
  const headerFill: [string, string][] = [];
  for (const [name, prop] of literalProps(inputJsonSchema(headers))) {
    const value = oneValue(prop);
    if (typeof value === "string") headerFill.push([name.toLowerCase(), value]);
  }
  const cookieFill: [string, SetCookieView][] = [];
  for (const [name, prop] of literalProps(inputJsonSchema(cookies))) {
    // A cookie is filled only when its value and every attribute it requires admit one value.
    const attrs = literalProps(prop);
    const view: Record<string, unknown> = {
      httpOnly: false,
      secure: false,
      partitioned: false,
      path: "/",
    };
    let ok = attrs.some(([k]) => k === "value");
    for (const [k, v] of attrs) {
      const one = oneValue(v);
      if (one === NOT_ONE) ok = false;
      else view[k] = one;
    }
    if (ok && typeof view.value === "string")
      cookieFill.push([name, view as unknown as SetCookieView]);
  }
  const bodies = new Map<string, NodePlan | undefined>();
  for (const [media, schema] of content ?? []) {
    const js = inputJsonSchema(schema);
    bodies.set(media, js === undefined ? undefined : planNode(js, js, 0));
  }
  const keys = [...(content?.keys() ?? [])];
  return {
    headers: headerFill,
    cookies: cookieFill,
    mediaType: keys.length === 1 ? keys[0] : undefined,
    bodies,
  };
}

/** Whether a value is a plain JSON object (the only kind `.variant()` fills or strips). */
const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" &&
  x !== null &&
  !Array.isArray(x) &&
  Object.getPrototypeOf(x) === Object.prototype;

/**
 * Applies a body plan, copy-on-write (the handler's object is never mutated).
 * Records each change as a path and a count, never a key name it removed or
 * a value (a key of a user-keyed record can be user data).
 */
function applyNode(
  plan: NodePlan,
  value: unknown,
  path: string,
  changes: string[],
): unknown {
  if (plan.kind === "array") {
    if (!Array.isArray(value)) return value;
    let out: unknown[] | undefined;
    value.forEach((item, i) => {
      const next = applyNode(plan.items, item, `${path}[]`, changes);
      if (next !== item) (out ??= [...value])[i] = next;
    });
    return out ?? value;
  }
  if (plan.kind !== "object" || !isPlainObject(value)) return value;
  let out: Record<string, unknown> | undefined;
  const copy = () => (out ??= { ...value });
  if (plan.strip) {
    let removed = 0;
    for (const key of Object.keys(value)) {
      if (!plan.props.has(key)) {
        delete copy()[key];
        removed++;
      }
    }
    if (removed > 0)
      changes.push(
        `body${path}: stripped ${removed} undeclared field${removed === 1 ? "" : "s"}`,
      );
  }
  for (const [key, literal] of plan.fill) {
    if (value[key] === undefined) {
      copy()[key] = literal;
      changes.push(`body${path}.${key}: filled`);
    }
  }
  for (const [key, child] of plan.props) {
    const current = (out ?? value)[key];
    if (current === undefined || child.kind === "leaf") continue;
    const next = applyNode(child, current, `${path}.${key}`, changes);
    if (next !== current) copy()[key] = next;
  }
  return out ?? value;
}

/** Whether a bare media type carries a JSON body (what `json()` and `send(object)` write). */
const isJsonMedia = (bare: string) =>
  bare === "application/json" || bare.endsWith("+json");

/**
 * What `.variant(name)` does at the commit, before the check, once the
 * variant's `when` holds: fills what admits exactly one value and the handler
 * did not set (the discriminant, literal headers and cookies, the media type
 * for a JSON body, required literal body fields) and strips body fields the
 * variant's schema does not declare. Anything else (a field missing with no
 * single value, a wrong value the handler set) is left to the check. Never
 * throws: a failure leaves the response as it was.
 */
export function adjust(
  entry: Extract<CompiledStatus, { kind: "variants" }>,
  c: Compiled,
  view: ResponseView,
): { readonly view: ResponseView; readonly changes: readonly string[] } {
  const plan = c.adjust;
  const changes: string[] = [];
  if (plan === undefined) return { view, changes };
  try {
    let headers: Record<string, string> | undefined;
    let cookies: Record<string, SetCookieView> | undefined;
    const setHeader = (name: string, value: string) => {
      if (view.headers[name] !== undefined || headers?.[name] !== undefined)
        return;
      (headers ??= { ...view.headers })[name] = value;
      changes.push(`headers.${name}: filled`);
    };
    const setCookie = (name: string, cookie: SetCookieView) => {
      if (view.cookies[name] !== undefined || cookies?.[name] !== undefined)
        return;
      (cookies ??= { ...view.cookies })[name] = cookie;
      changes.push(`cookies.${name}: filled`);
    };
    // 1. The discriminant, from `by.values` (only an exact value fills; `true`/`null` do not).
    const by = entry.by;
    const value = by?.valueOf(c.name as string);
    if (by !== undefined && value !== undefined) {
      if (by.part === "headers") setHeader(by.name, value);
      else
        setCookie(by.name, {
          value,
          httpOnly: false,
          secure: false,
          partitioned: false,
          path: "/",
        });
    }
    // 2. Declared headers and cookies that admit one value.
    for (const [name, v] of plan.headers) setHeader(name, v);
    for (const [name, cookie] of plan.cookies) setCookie(name, cookie);
    // 3. The media type: the variant's one declared type, for a JSON body whose type is only json()'s implicit one.
    let mediaType = view.mediaType;
    const jsonBody =
      view.body !== undefined &&
      typeof view.body === "object" &&
      !(view.body instanceof Uint8Array);
    if (
      view.contentTypeExplicit === false &&
      jsonBody &&
      plan.mediaType !== undefined &&
      isJsonMedia(plan.mediaType) &&
      plan.mediaType !== mediaType
    ) {
      mediaType = plan.mediaType;
      (headers ??= { ...view.headers })["content-type"] = plan.mediaType;
      changes.push("headers.content-type: filled");
    }
    // 4. The body, for a JSON value only (json(), send(object)): never a stream, text, bytes or opaque().
    let body = view.body;
    if (jsonBody && mediaType !== undefined && isJsonMedia(mediaType)) {
      const nodePlan = plan.bodies.get(mediaType);
      if (nodePlan !== undefined)
        body = applyNode(nodePlan, view.body, "", changes);
      else if (plan.bodies.has(mediaType))
        changes.push("body: not adjustable (the schema has no JSON Schema)");
    }
    if (changes.length === 0) return { view, changes };
    return {
      view: {
        ...view,
        headers: headers ?? view.headers,
        cookies: cookies ?? view.cookies,
        mediaType,
        body,
      },
      changes,
    };
  } catch (error) {
    errorsLogged.push(error);
    return { view, changes: ["not adjusted (the adjustment failed; logged)"] };
  }
}

/** A verdict: sent as matched (naming the variant), or refused with issues; `failed` when a `when`, a `refine` or a schema threw. */
export type Verdict =
  | {
      readonly ok: true;
      readonly variant: string | undefined;
      /** What `.variant()` changed (paths and counts, never values), and the response as sent. */
      readonly adjusted?: {
        readonly changes: readonly string[];
        readonly view: ResponseView;
      };
    }
  | {
      readonly ok: false;
      readonly issues: readonly VariantIssue[];
      readonly failed?: true;
    };

type Found = MaybePromise<VariantIssue[]>;

const statusIssue = (
  status: number,
  message: string,
  variant?: string,
): VariantIssue => ({
  target: "status",
  message,
  path: "",
  key: String(status),
  ...(variant === undefined ? {} : { variant }),
});

const tag = (
  issues: readonly ValidationIssue<Part>[],
  variant: string | undefined,
): VariantIssue[] =>
  variant === undefined ? [...issues] : issues.map((i) => ({ ...i, variant }));

/** A placeholder "it failed" while matching; never reported (a refusal re-runs the variant in full). */
const MISMATCH: VariantIssue = { target: "body", message: "", path: "" };

/** `flatten: true` builds (and scrubs) issues while matching too: the first prototype's behaviour, for the bench's comparison. */
export const matching = { flatten: false };

/** Runs one schema through the core's runner (received values scrubbed). */
function run(
  schema: Schema,
  value: unknown,
  part: Part,
  status: number,
  variant: string | undefined,
  mediaType?: string,
  short = false,
): Found {
  if (short && !matching.flatten) {
    // While matching, only "does it pass" matters: the vendor's own answer, no
    // flattening or scrub. Issues are built on the refusal path alone.
    const result = schema["~standard"].validate(value);
    const verdict = (r: StandardSchemaV1.Result<unknown>): VariantIssue[] =>
      r.issues ? [MISMATCH] : [];
    return result instanceof Promise ? result.then(verdict) : verdict(result);
  }
  return andThen(
    runSchema<unknown, Part>(schema, value, part, status, mediaType, undefined),
    (outcome) => (outcome.ok ? [] : tag(outcome.issues, variant)),
  );
}

/** Runs `steps` in order; with `short`, stops at the first that reports. Sync unless a step is not. */
function sequence(steps: readonly (() => Found)[], short: boolean): Found {
  const all: VariantIssue[] = [];
  const next = (i: number): Found => {
    for (; i < steps.length; i++) {
      const found = steps[i]();
      if (found instanceof Promise) {
        const at = i;
        return found.then((issues) => {
          all.push(...issues);
          return short && issues.length > 0 ? all : next(at + 1);
        });
      }
      all.push(...found);
      if (short && found.length > 0) return all;
    }
    return all;
  };
  return next(0);
}

/** A `refine`'s issues, scrubbed by the core's own flattening (a quoted part value is withheld). */
function refined(
  refine: Refine,
  view: ResponseView,
  req: RequestView,
  status: number,
  variant: string | undefined,
): VariantIssue[] {
  const response: RefineResponse = {
    status,
    headers: view.headers,
    cookies: view.cookies,
    mediaType: view.mediaType,
    body: view.body,
    variant,
  };
  const found = refine(response, req.raw as BunRequest) ?? [];
  return found.flatMap((r) => {
    // A refine sees every part, so its message is scrubbed against all of them.
    const received = {
      status,
      headers: view.headers,
      cookies: view.cookies,
      body: view.body,
    };
    const issue: StandardSchemaV1.Issue = {
      message: r.message,
      path: r.path ? r.path.split(".") : undefined,
    };
    return tag(
      toIssues([issue], received, r.part, String(status), undefined, undefined),
      variant,
    );
  });
}

/** Every part of one variant (or plain spec) against the response, cheap parts first. */
function check(
  c: Compiled,
  view: ResponseView,
  req: RequestView,
  extra: Refine | undefined,
  short: boolean,
): Found {
  const { status } = view;
  const steps: (() => Found)[] = [];
  if (c.headers) {
    const schema = c.headers;
    steps.push(() =>
      run(schema, view.headers, "headers", status, c.name, undefined, short),
    );
  }
  if (c.cookies) {
    const schema = c.cookies;
    steps.push(() =>
      run(schema, view.cookies, "cookies", status, c.name, undefined, short),
    );
  }
  if (c.content === null) {
    steps.push(() =>
      view.body === undefined
        ? []
        : [
            {
              target: "body",
              message: "This response has no body",
              path: "",
              key: String(status),
              ...(c.name ? { variant: c.name } : {}),
            },
          ],
    );
  } else if (c.content !== undefined) {
    const content = c.content;
    steps.push(() => {
      const mt = view.mediaType;
      const schema = mt === undefined ? undefined : content.get(mt);
      if (mt === undefined || schema === undefined) {
        return [
          {
            target: "body",
            message: `This media type is not declared (${[...content.keys()].join(", ")})`,
            path: "",
            key: String(status),
            ...(c.name ? { variant: c.name } : {}),
          },
        ];
      }
      if (schema === null)
        return view.body === undefined
          ? []
          : [
              {
                target: "body",
                message: "Expected an empty body",
                path: "",
                key: String(status),
                mediaType: mt,
              },
            ];
      return run(schema, view.body, "body", status, c.name, mt, short);
    });
  }
  // A refine runs only once the parts pass: it may assume their shapes.
  const refines = [c.refine, extra].filter((r): r is Refine => r !== undefined);
  return andThen(sequence(steps, short), (issues) => {
    if (issues.length > 0 || refines.length === 0) return issues;
    return refines.flatMap((r) => refined(r, view, req, status, c.name));
  });
}

/** Counts `when` calls, for the cost cases. */
export const counters = { when: 0, asyncWhen: 0 };

/** Whether variant `c`'s `when` holds for `req`. Throws a TypeError for a non-boolean answer. */
function applies(c: Compiled, req: RequestView): MaybePromise<boolean> {
  if (c.when === undefined) return true;
  counters.when++;
  const answer = (c.when as (valid: unknown, req: unknown) => unknown)(
    req.valid,
    req.raw,
  );
  if (typeof answer === "boolean") return answer; // the fast path: decided in place, no Promise
  if (answer instanceof Promise) {
    counters.asyncWhen++;
    return answer.then((resolved: unknown) => {
      if (typeof resolved !== "boolean")
        throw new TypeError(
          `variant ${c.name}: when must resolve to a boolean`,
        );
      return resolved;
    });
  }
  throw new TypeError(`variant ${c.name}: when must return a boolean`);
}

/** Refused because a check threw: the issue names no value, the error goes to the log. */
function failedVerdict(status: number, error: unknown): Verdict {
  errorsLogged.push(error);
  return {
    ok: false,
    failed: true,
    issues: [statusIssue(status, "The response could not be checked")],
  };
}

/** Set while one `match` runs when `.variant()` chose the status, so the adjust record says so. */
let adjustedStatus = false;

/**
 * The decision V3c's commit gate makes for one response:
 *
 * 1. **Selected**: the variant `res.variant()` named, else the one the
 *    discriminant selects, else every variant.
 * 2. **Acceptable**: the selected ones whose `when` holds (one call per
 *    variant with a `when`).
 * 3. **Matched**: the first acceptable variant whose every part (and refine)
 *    passes, checked whole; parts are never taken from two variants.
 *
 * On a refusal the issues name the status, the variants and paths, never a
 * received value; a fully matching variant whose `when` does not hold is
 * named (the leak this exists to catch), found only on the failure path.
 */
export function match(
  table: CompiledTable,
  view: ResponseView,
  req: RequestView,
): MaybePromise<Verdict> {
  // `.variant(name)` with no status set: the one status declaring that variant, if exactly one does (Q-H18).
  if (view.variant !== undefined && view.statusExplicit === false) {
    const declaring = [...table].filter(
      ([, e]) => e.kind === "variants" && e.byName.has(view.variant as string),
    );
    if (declaring.length === 1 && declaring[0][0] !== view.status) {
      view = { ...view, status: declaring[0][0] };
      adjustedStatus = true;
    }
  }
  const { status } = view;
  const entry = table.get(status);
  if (entry === undefined)
    return {
      ok: false,
      issues: [statusIssue(status, "This status is not declared")],
    };
  try {
    if (entry.kind === "plain") {
      if (view.variant !== undefined) {
        return {
          ok: false,
          issues: [
            statusIssue(
              status,
              `variant("${view.variant}") was named, but this status declares no variants`,
            ),
          ],
        };
      }
      return andThen(
        check(entry.spec, view, req, undefined, false),
        (issues) =>
          issues.length === 0
            ? { ok: true, variant: undefined }
            : { ok: false, issues },
      );
    }
    const verdict = matchVariants(entry, view, req);
    // A rejected `when` (or schema) is a failed check, as a sync throw is.
    return verdict instanceof Promise
      ? verdict.catch((error: unknown) => failedVerdict(status, error))
      : verdict;
  } catch (error) {
    return failedVerdict(status, error);
  } finally {
    adjustedStatus = false;
  }
}

function matchVariants(
  entry: Extract<CompiledStatus, { kind: "variants" }>,
  view: ResponseView,
  req: RequestView,
): MaybePromise<Verdict> {
  const { status } = view;
  const issues: VariantIssue[] = [];
  const statusChange = adjustedStatus ? [`status: filled (${status})`] : [];
  // 1. Selected.
  let selected: readonly Compiled[] = entry.list;
  let how = "";
  const named =
    view.variant === undefined ? undefined : entry.byName.get(view.variant);
  if (view.variant !== undefined) {
    if (named === undefined) {
      return {
        ok: false,
        issues: [
          statusIssue(
            status,
            `variant("${view.variant}") is not declared (${[...entry.byName.keys()].join(", ")})`,
          ),
        ],
      };
    }
    selected = [named];
    how = "named by variant()";
  } else if (entry.by !== undefined) {
    // With no name, the discriminant selects; with one, it is filled by the adjust and must agree (below).
    const picked = discriminate(entry, view, status);
    if (typeof picked !== "string") return picked;
    selected = [entry.byName.get(picked) as Compiled];
    how = `selected by ${entry.by.part === "headers" ? "header" : "cookie"} ${entry.by.name}`;
  }
  // 2. Applicable for this request: each `when` decided in place, or awaited when it answers a Promise.
  const answers = selected.map((c) => applies(c, req));
  const decide = (holds: readonly boolean[]): MaybePromise<Verdict> => {
    const acceptable = selected.filter((_, i) => holds[i]);
    const excluded = selected.filter((_, i) => !holds[i]);
    const names = (list: readonly Compiled[]) =>
      list.map((c) => c.name).join(", ");
    if (acceptable.length === 0) {
      issues.push(
        selected.length === 1
          ? statusIssue(
              status,
              `Variant "${selected[0].name}" (${how}) does not apply to this request`,
              selected[0].name,
            )
          : statusIssue(
              status,
              `No variant of this status applies to this request (${excluded.length} excluded by when)`,
            ),
      );
      return selected.length === 1
        ? { ok: false, issues }
        : diagnose(excluded, view, req, entry.refine, issues);
    }
    // 2b. `.variant()` adjusts the response once its `when` holds, then the discriminant must agree.
    let checked = view;
    let changes: readonly string[] = statusChange;
    if (named !== undefined) {
      const done = adjust(entry, named, view);
      checked = done.view;
      changes = [...statusChange, ...done.changes];
      if (entry.by !== undefined) {
        const picked = discriminate(entry, checked, status);
        if (typeof picked !== "string") return picked;
        if (picked !== named.name) {
          return {
            ok: false,
            issues: [
              {
                target: entry.by.part,
                path: entry.by.name,
                key: String(status),
                variant: named.name,
                message: `Selects variant "${picked}", but variant("${named.name}") was named`,
              },
            ],
          };
        }
      }
    }
    const sent = (variant: string | undefined): Verdict =>
      changes.length === 0
        ? { ok: true, variant }
        : { ok: true, variant, adjusted: { changes, view: checked } };
    // 3. One acceptable variant must match whole. Cheap parts first, each variant stopping at its first failing part.
    const tryFrom = (i: number): MaybePromise<Verdict> => {
      for (; i < acceptable.length; i++) {
        const c = acceptable[i];
        const found = check(c, checked, req, entry.refine, true);
        if (found instanceof Promise) {
          const at = i;
          return found.then((f) =>
            f.length === 0 ? sent(c.name) : tryFrom(at + 1),
          );
        }
        if (found.length === 0) return sent(c.name);
      }
      // Every acceptable variant failed: report each in full (the failure path only).
      issues.push(
        statusIssue(
          status,
          `The response matches no acceptable variant (${names(acceptable)})`,
        ),
      );
      const full = acceptable.map((c) =>
        check(c, checked, req, entry.refine, false),
      );
      return andThen(gather(full), (lists) => {
        issues.push(...lists.flat());
        return diagnose(excluded, checked, req, entry.refine, issues);
      });
    };
    return tryFrom(0);
  };
  return answers.some((a) => a instanceof Promise)
    ? Promise.all(answers).then(decide)
    : decide(answers as boolean[]);
}

/** The variant the discriminant's value selects, or the refusal when it selects none. */
function discriminate(
  entry: Extract<CompiledStatus, { kind: "variants" }>,
  view: ResponseView,
  status: number,
): string | Verdict {
  const by = entry.by!;
  const raw =
    by.part === "headers"
      ? view.headers[by.name]
      : view.cookies[by.name]?.value;
  const picked = by.select(raw);
  if (picked !== undefined) return picked;
  return {
    ok: false,
    issues: [
      {
        target: by.part,
        path: by.name,
        key: String(status),
        message: `Does not select a variant (expected ${by.allowed})`,
      },
    ],
  };
}

/** Resolves a list of `Found`, staying sync when it can. */
function gather(list: readonly Found[]): MaybePromise<VariantIssue[][]> {
  return list.some((f) => f instanceof Promise)
    ? Promise.all(list)
    : (list as VariantIssue[][]);
}

/** On the failure path only: names an excluded variant the response matches in full (the leak). */
function diagnose(
  excluded: readonly Compiled[],
  view: ResponseView,
  req: RequestView,
  refine: Refine | undefined,
  issues: VariantIssue[],
): MaybePromise<Verdict> {
  if (excluded.length === 0) return { ok: false, issues };
  const found = excluded.map((c) => check(c, view, req, refine, true));
  return andThen(gather(found), (lists) => {
    lists.forEach((list, i) => {
      if (list.length === 0) {
        const name = excluded[i].name as string;
        issues.push(
          statusIssue(
            view.status,
            `The response matches variant "${name}", which does not apply to this request`,
            name,
          ),
        );
      }
    });
    return { ok: false, issues };
  });
}
