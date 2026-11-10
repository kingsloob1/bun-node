/**
 * `sse()`, an event stream's declaration (bun-validate V3b, plan
 * `docs/plans/bun-validate/` §4.4.1, §4.7): a `text/event-stream` body
 * checked event by event by the response gate, the events an `SseWriter`'s
 * `contract` types and checks (bun-native-routes PR-sse2), and what OpenAPI
 * lists as `x-sse-events`. It lives here rather than in `responseBodies.ts`,
 * which re-exports it, so the browser-safe `@kingsleyweb/bun-common/sse`
 * carries it: a module shared by a server and its typed client declares the
 * events once. `sseVariants()` declares an event as several whole variants
 * (bun-validate V11).
 *
 * Browser-safe: it imports only the contract core.
 */
import type {
  AnyContract,
  Schema,
  VariantDecl,
  VariantsDecl,
} from "../contract/model";
import type { StandardSchemaV1 } from "../types/standardSchema";
import { isPromiseLike, VARIANTS } from "../contract/model";
import { markKind, markNested } from "../contract/schemas";
import { sseTransport } from "../contract/sse";
import { isSchema } from "../contract/transport";

/**
 * The request view a `when` takes when nothing types it: every part a
 * validator may have parsed, optional and `unknown`. An HTTP variant's
 * `when` under `commonResponses` takes it (inside `validate()` it takes the
 * validator's parsed parts instead), and so does an SSE event variant's
 * (`sseVariants()`), whose declaration sits apart from any validator.
 */
export type UntypedValid = Partial<
  Record<
    "headers" | "cookies" | "signedCookies" | "params" | "query" | "body",
    unknown
  >
>;

/**
 * How an `sse()` event's `data` reaches its schema: `"json"` parses the
 * event's data (its `data:` lines joined with `\n`) as JSON, and a data that
 * does not parse is a mismatch; `"text"` hands the schema the string as it is.
 */
export type SseDataFormat = "json" | "text";

/** Options of {@link sse}. */
export interface SseOptions<D extends SseDataFormat = SseDataFormat> {
  /** How each event's `data` is decoded for its schema ({@link SseDataFormat}). Default `"json"`. */
  readonly data?: D;
}

/**
 * An `sse()` declaration's events: name to the schema of its `data`, an
 * {@link sseVariants} set (several whole variants of the event), or `null`
 * for an event that carries none.
 */
export type SseEventMap = Readonly<Record<string, StandardSchemaV1 | null>>;

// ---------------------------------------------------------------------------
// Event variants (bun-validate V11, plan §4.4.6 "What V3c gives later PRs")
// ---------------------------------------------------------------------------

/**
 * One variant of an SSE event (see {@link sseVariants}): the schema of its
 * `data`, when it applies, and what documents say about it.
 *
 * @typeParam S The schema of the variant's `data`.
 */
export interface SseVariantSpec<S extends StandardSchemaV1 = StandardSchemaV1> {
  /** The schema of the event's `data` when it is this variant. */
  readonly data: S;
  /**
   * Makes the variant acceptable only on the streams it holds for, asked
   * with the request that opened the stream: its parsed parts (`req.valid`;
   * `{}` where nothing parsed them) and the request itself (`res.sse()`'s
   * `BunRequest`, `sseResponse()`'s `Request`, a writer's `request`). It is
   * asked **once per stream** and the answer kept, since the request does
   * not change. A boolean is decided in place; a Promise of one is awaited,
   * holding that event (and the ones behind it). A non-boolean, a throw or
   * a rejection is a failed check. Absent: the variant applies on every
   * stream.
   *
   * Declared as a method so a `when` that annotates its parameters
   * (`(valid: { headers: { "x-admin"?: string } }, req: BunRequest) =>
   * …`) is accepted: the declaration is browser-safe, so it names no
   * server type itself.
   */
  readonly when?: {
    // A method signature on purpose: only methods compare bivariantly.
    // eslint-disable-next-line @typescript-eslint/method-signature-style
    bivarianceHack(
      valid: UntypedValid,
      req: unknown,
    ): boolean | Promise<boolean>;
  }["bivarianceHack"];
  /** What documents say about when this variant is sent (a `when` cannot be described). */
  readonly description?: string;
}

/** A variant table's `data` inputs (or outputs), as one union. */
type VariantData<T, Dir extends "input" | "output"> = {
  [N in keyof T]: T[N] extends {
    readonly data: infer S extends StandardSchemaV1;
  }
    ? Dir extends "input"
      ? StandardSchemaV1.InferInput<S>
      : StandardSchemaV1.InferOutput<S>
    : never;
}[keyof T];

/**
 * An SSE event's variants, as {@link sseVariants} returns them. It is also
 * a Standard Schema of their union (a value any variant's schema accepts
 * passes, `when` aside), so a reader that knows nothing of variants (a
 * client checking the events it receives) checks the event's data against
 * every variant.
 *
 * @typeParam T The variant table.
 */
export interface SseVariants<
  T extends Readonly<Record<string, SseVariantSpec>> = Readonly<
    Record<string, SseVariantSpec>
  >,
> extends StandardSchemaV1<VariantData<T, "input">, VariantData<T, "output">> {
  /** Always `"variants"`. */
  readonly kind: "variants";
  /** Variant name to its spec, in declaration order. */
  readonly table: T;
}

/** Refuses an unknown key in a variant (a `const` generic skips excess-property checks). */
type StrictSseTable<T> = {
  readonly [N in keyof T]: {
    readonly [K in keyof T[N]]: K extends keyof SseVariantSpec
      ? T[N][K]
      : never;
  };
};

/** Marks what {@link sseVariants} returns. */
const SSE_VARIANTS: unique symbol = Symbol.for("bun-validate.sseVariants");

/** The keys a variant spec may use. */
const VARIANT_KEYS: ReadonlySet<string> = new Set([
  "data",
  "when",
  "description",
]);

/**
 * Declares an SSE event as several whole **variants**, chosen per event:
 * `sse({ tick: sseVariants({ admin: { when, data: AdminTick }, user: {
 * data: UserTick } }) })`. An event is acceptable when a variant is
 * **selected** (the one `send({ variant })` named, else every variant),
 * **applies** (its `when` holds for the request that opened the stream) and
 * its `data` **matches** that variant's schema. No acceptable variant is a
 * mismatch; there is no fallback, and a variant with no `when` (a default)
 * is only declared when wanted. A refusal names each acceptable variant's
 * issues and, when the data matches a variant whose `when` excluded it,
 * that variant (the leak this exists to catch).
 *
 * ```ts
 * const Ticks = sse({
 *   tick: sseVariants({
 *     admin: { when: (valid) => valid.headers?.["x-admin"] === "1", data: AdminTick },
 *     user: { data: UserTick },
 *   }),
 * });
 * const stream = res.sse({ contract: Ticks });
 * await stream.send({ event: "tick", variant: "admin", data: adminTick }); // typed as AdminTick
 * await stream.send({ event: "tick", data: tick });                        // the union
 * ```
 *
 * The SSE writer checks each event before it is encoded; a `validate()`
 * response (and NestJS's `@Sse()` under `@Validate`) checks the stream's
 * events as they are sent, by the same rules (it cannot know a `variant`
 * the writer named, so every variant is selected there). Nothing on the
 * wire names the variant: a client reads the event's data as the union.
 *
 * Declaration mistakes (an empty table, a variant without a `data` schema,
 * a `when` that is not a function, an unknown key) throw a `TypeError`.
 *
 * @param table Variant name to its {@link SseVariantSpec}.
 */
export function sseVariants<
  const T extends Readonly<Record<string, SseVariantSpec>>,
>(table: T & StrictSseTable<T>): SseVariants<T> {
  if (!isPlainObject(table)) {
    throw new TypeError("sseVariants(): expected an object of variant names");
  }
  const names = Object.keys(table);
  if (names.length === 0) {
    throw new TypeError("sseVariants(): declares no variant");
  }
  for (const name of names) {
    const spec = (table as Record<string, unknown>)[name];
    const at = `sseVariants(): variant ${JSON.stringify(name)}`;
    if (!isPlainObject(spec)) {
      throw new TypeError(
        `${at} must be an object ({ data, when?, description? })`,
      );
    }
    for (const key of Object.keys(spec)) {
      if (!VARIANT_KEYS.has(key)) {
        throw new TypeError(
          `${at}: unknown key ${JSON.stringify(key)} (expected data, when, description)`,
        );
      }
    }
    if (!isSchema(spec.data)) {
      throw new TypeError(`${at}: data must be a Standard Schema`);
    }
    if (spec.when !== undefined && typeof spec.when !== "function") {
      throw new TypeError(`${at}: when must be a function`);
    }
    if (
      spec.description !== undefined &&
      typeof spec.description !== "string"
    ) {
      throw new TypeError(`${at}: description must be a string`);
    }
  }
  const specs = names.map(
    (name) => [name, (table as Record<string, SseVariantSpec>)[name]] as const,
  );
  const out = {
    kind: "variants" as const,
    table,
    "~standard": {
      version: 1 as const,
      vendor: "bun-common/sse",
      validate: (value: unknown) => validateUnion(specs, value),
    },
  } as unknown as SseVariants<T>;
  Object.defineProperty(out, SSE_VARIANTS, { value: true, enumerable: false });
  return out;
}

/**
 * Whether `value` came from {@link sseVariants}. Internal.
 *
 * @param value An event's declaration.
 * @internal
 */
export function isSseVariants(value: unknown): value is SseVariants {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [SSE_VARIANTS]?: unknown })[SSE_VARIANTS] === true
  );
}

/** One variant's verdict, as a Standard Schema result. */
type UnionResult = StandardSchemaV1.Result<unknown>;

/**
 * The union's `validate`: the first variant (in declaration order) whose
 * schema passes gives the result; when none does, every variant's issues,
 * each message prefixed with its variant's name.
 */
function validateUnion(
  specs: readonly (readonly [string, SseVariantSpec])[],
  value: unknown,
): UnionResult | Promise<UnionResult> {
  const failed: StandardSchemaV1.Issue[] = [];
  const settle = (
    name: string,
    result: UnionResult,
  ): UnionResult | undefined => {
    if (result.issues === undefined) return result;
    for (const issue of result.issues) {
      failed.push({ ...issue, message: `Variant "${name}": ${issue.message}` });
    }
    return undefined;
  };
  const from = (i: number): UnionResult | Promise<UnionResult> => {
    for (; i < specs.length; i++) {
      const [name, spec] = specs[i];
      const result = spec.data["~standard"].validate(value);
      if (isPromiseLike(result)) {
        const next = i + 1;
        return Promise.resolve(result).then(
          (settled) => settle(name, settled) ?? from(next),
        );
      }
      const done = settle(name, result);
      if (done !== undefined) return done;
    }
    return {
      issues: [
        {
          message: `Matches no variant (${specs.map(([n]) => n).join(", ")})`,
        },
        ...failed,
      ],
    };
  };
  return from(0);
}

/** The contract core's record of an event's variants. */
function toVariantsDecl(variants: SseVariants): VariantsDecl {
  const list: VariantDecl[] = [];
  for (const [name, spec] of Object.entries(variants.table)) {
    list.push({
      name,
      parts: { data: spec.data },
      conditional: spec.when !== undefined,
      ...(spec.description === undefined
        ? {}
        : { description: spec.description }),
    });
  }
  return { variants: list };
}

/** A `text/event-stream` body checked event by event: what {@link sse} returns. */
export interface SseEvents<
  E extends SseEventMap = SseEventMap,
  D extends SseDataFormat = SseDataFormat,
> extends StandardSchemaV1<unknown, unknown> {
  /** Always `"sse"`. */
  readonly kind: "sse";
  /** The declared events (`message` is the name of an event with no `event:` line). */
  readonly events: E;
  /** How each event's `data` is decoded. */
  readonly data: D;
}

/** Whether `value` is a plain object (a literal, or one with a null prototype). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** The `~standard` of a helper that describes a stream: run directly, it refuses every value. */
/**
 * @param vendor The helper's vendor name.
 * @internal
 */
export function streamProps(
  vendor: string,
): StandardSchemaV1.Props<unknown, unknown> {
  return {
    version: 1,
    vendor,
    validate: () => ({
      issues: [
        {
          message:
            "A streamed body is checked chunk by chunk by the response gate, not as one value",
        },
      ],
    }),
  };
}

/**
 * Declares a `text/event-stream` body checked **event by event**: the bytes
 * are framed into events across chunk boundaries (lines ending in CRLF, LF
 * or CR; a blank line ends an event; comments, and blocks with only `id:` or
 * `retry:`, are not events), the schema is chosen by the event's name
 * (`message` when it has no `event:` line), and its `data` is decoded as
 * `options.data` says. An undeclared name is a mismatch; a `null` event must
 * carry no data; an event declared with {@link sseVariants} takes any of its
 * variants (the one `send({ variant })` names, on a writer), each applying
 * only where its `when` holds. An event the stream ends in the middle of is not checked
 * (a client never dispatches it).
 *
 * Under `"error"` the stream stops at the bad event: the write (or piped
 * chunk) completing it is not sent, and the stream is cut off and logged at
 * `error`. Its events are listed by `describeContract` as the row's `nested`
 * rows, keyed by `event` with the parts `data` and `id` (an event's
 * variants as one row each, with its `variant`, and their table under
 * `sides.outbound.variants`).
 *
 * @param events  Event name to the schema of its `data`, an
 *   {@link sseVariants} set, or `null`.
 * @param options `data` ({@link SseDataFormat}); default `"json"`.
 */
export function sse<
  const E extends SseEventMap,
  const D extends SseDataFormat = "json",
>(events: E, options?: SseOptions<D>): SseEvents<E, D> {
  if (!isPlainObject(events)) {
    throw new TypeError("sse(): expected an object of event names");
  }
  const outbound: Record<
    string,
    { data: Schema | null } | { [VARIANTS]: VariantsDecl }
  > = {};
  for (const [name, schema] of Object.entries(events)) {
    if (/[\r\n]/.test(name)) {
      throw new TypeError(
        `sse(): ${JSON.stringify(name)} is not an event name (it holds a line break)`,
      );
    }
    if (isSseVariants(schema)) {
      // Each variant declares its `data` whole; `describeContract` gives
      // each its rows, tagged with its `variant`.
      outbound[name] = { [VARIANTS]: toVariantsDecl(schema) };
      continue;
    }
    if (schema !== null && !isSchema(schema)) {
      throw new TypeError(
        `sse(): event ${JSON.stringify(name)} must be a Standard Schema or null`,
      );
    }
    outbound[name] = { data: schema };
  }
  const data = (options?.data ?? "json") as D;
  if (data !== "json" && data !== "text") {
    throw new TypeError('sse(): data must be "json" or "text"');
  }
  const out: SseEvents<E, D> = {
    kind: "sse",
    events,
    data,
    "~standard": streamProps("bun-common/sse"),
  };
  const contract: AnyContract = sseTransport.contract({ outbound } as never);
  return markNested(markKind(out, "sse"), contract);
}
