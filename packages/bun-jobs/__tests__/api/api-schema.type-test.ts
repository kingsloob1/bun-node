import type { Infer } from "../../lib/api/schema/builder";
import type {
  ErrorDtoSchema,
  JobRefSchema,
  JobStateSchema,
  ProblemSchema,
} from "../../lib/api/schemas/common";
/**
 * Compile-time assertions for the API schema builder.
 *
 * The builder's promise is that one definition is both the validator and the
 * type. These assertions hold that promise against the real bun-jobs types —
 * a schema that drifts from `JobState`, `TriggerOutcome` or `RunnerStats`
 * fails to compile here. Checked by `bun check` (the package `tsconfig.json`
 * includes `__tests__/**`), not by `bun test`.
 *
 * Every negative control is an `@ts-expect-error` over a short
 * `Expect<...>` line: if the assertion under it stopped failing, the directive
 * itself would become the error. The comparison is computed in a separate
 * alias so formatting can never move the failure off the directive's line.
 */
import type { ErrorDto, ProblemDto } from "../../lib/api/serialize";
import type {
  JobRef,
  JobState,
  RunnerStats,
  TriggerOutcome,
} from "../../lib/index";
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import { BunRouter, validate, variants } from "@kingsleyweb/bun-common";
import { s } from "../../lib/api/schema/builder";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/* --- real bun-jobs types ------------------------------------------- */

type JobStateEqual = Equal<Infer<typeof JobStateSchema>, JobState>;
export type JobStateMatches = Expect<JobStateEqual>;

type JobRefEqual = Equal<Infer<typeof JobRefSchema>, JobRef>;
export type JobRefMatches = Expect<JobRefEqual>;

type ProblemEqual = Equal<Infer<typeof ProblemSchema>, ProblemDto>;
export type ProblemMatches = Expect<ProblemEqual>;

// `cause` is loose in the schema (it cannot recurse), so a DTO fits the schema
// type but not the other way round.
type ErrorDtoFit = ErrorDto extends Infer<typeof ErrorDtoSchema> ? true : false;
export type ErrorDtoFits = Expect<ErrorDtoFit>;

const _TriggerOutcomeSchema = s.union(
  s.object({ outcome: s.literal("started"), runId: s.string() }),
  s.object({ outcome: s.literal("queued"), position: s.integer() }),
  s.object({
    outcome: s.literal("skipped"),
    reason: s.enum([
      "paused",
      "busy",
      "lock-held",
      "max-concurrency",
      "queue-full",
      "stopped",
    ]),
  }),
);
type TriggerOutcomeEqual = Equal<
  Infer<typeof _TriggerOutcomeSchema>,
  TriggerOutcome
>;
export type TriggerOutcomeMatches = Expect<TriggerOutcomeEqual>;

const _RunnerStatsSchema = s.object({
  success: s.integer(),
  failed: s.integer(),
  timeout: s.integer(),
  killed: s.integer(),
  skipped: s.integer(),
  queued: s.integer(),
  total: s.integer(),
});
type RunnerStatsEqual = Equal<Infer<typeof _RunnerStatsSchema>, RunnerStats>;
export type RunnerStatsMatches = Expect<RunnerStatsEqual>;

/* --- negative controls: drift is a compile error -------------------- */

const _MissingDead = s.enum([
  "waiting",
  "delayed",
  "active",
  "completed",
  "failed",
  "waiting-children",
]);
type MissingDeadEqual = Equal<Infer<typeof _MissingDead>, JobState>;
// @ts-expect-error — a state list without "dead" is not JobState.
export type MissingDeadMatches = Expect<MissingDeadEqual>;

const _WrongReasons = s.union(
  s.object({ outcome: s.literal("started"), runId: s.string() }),
  s.object({ outcome: s.literal("queued"), position: s.integer() }),
  s.object({ outcome: s.literal("skipped"), reason: s.enum(["paused"]) }),
);
type WrongReasonsEqual = Equal<Infer<typeof _WrongReasons>, TriggerOutcome>;
// @ts-expect-error — a narrower skip reason is not TriggerOutcome.
export type WrongReasonsMatch = Expect<WrongReasonsEqual>;

const _StatsWithoutTotal = s.object({
  success: s.integer(),
  failed: s.integer(),
  timeout: s.integer(),
  killed: s.integer(),
  skipped: s.integer(),
  queued: s.integer(),
});
type NoTotalEqual = Equal<Infer<typeof _StatsWithoutTotal>, RunnerStats>;
// @ts-expect-error — a missing counter is not RunnerStats.
export type NoTotalMatches = Expect<NoTotalEqual>;

const _StatsAsStrings = s.object({
  success: s.string(),
  failed: s.integer(),
  timeout: s.integer(),
  killed: s.integer(),
  skipped: s.integer(),
  queued: s.integer(),
  total: s.integer(),
});
type AsStringsEqual = Equal<Infer<typeof _StatsAsStrings>, RunnerStats>;
// @ts-expect-error — a counter typed as a string is not RunnerStats.
export type AsStringsMatches = Expect<AsStringsEqual>;

/* --- builder semantics ---------------------------------------------- */

const _Shapes = s.object({
  required: s.string(),
  optional: s.optional(s.integer()),
  defaulted: s.optional(s.integer({ default: 20 })),
  nullable: s.nullable(s.boolean()),
  list: s.array(s.enum(["a", "b"])),
  map: s.record(s.number()),
  literal: s.literal(1),
  anything: s.unknown(),
});
type ShapesEqual = Equal<
  Infer<typeof _Shapes>,
  {
    required: string;
    optional?: number;
    // An optional property with a default is always present in the output.
    defaulted: number;
    nullable: boolean | null;
    list: ("a" | "b")[];
    map: Record<string, number>;
    literal: 1;
    anything: unknown;
  }
>;
export type ShapesOut = Expect<ShapesEqual>;

type Defaulted = Infer<typeof _Shapes>["defaulted"];
type DefaultedOptionalEqual = Equal<Defaulted, number | undefined>;
// @ts-expect-error — a defaulted property is not optional in the output.
export type DefaultedIsOptional = Expect<DefaultedOptionalEqual>;

const _Coerced = s.query(s.object({ limit: s.integer() }));
type QueryEqual = Equal<Infer<typeof _Coerced>, { limit: number }>;
export type QueryKeepsType = Expect<QueryEqual>;

type QueryStringEqual = Equal<Infer<typeof _Coerced>, { limit: string }>;
// @ts-expect-error — coercion changes the input, never the output type.
export type QueryIsString = Expect<QueryStringEqual>;

/* --- m11: a defaulted key is optional on input, required in output --- */

const _M11 = s.object({
  a: s.string(),
  d: s.integer({ default: 1 }),
  od: s.optional(s.boolean({ default: true })),
  o: s.optional(s.string()),
  list: s.array(s.object({ n: s.number({ default: 0 }) })),
  map: s.record(s.object({ m: s.enum(["x", "y"], { default: "x" }) })),
  maybe: s.nullable(s.object({ z: s.string({ default: "z" }) })),
  either: s.union(s.object({ u: s.integer({ default: 2 }) }), s.literal(0)),
});
type M11In = StandardSchemaV1.InferInput<typeof _M11>;
type M11InEqual = Equal<
  M11In,
  {
    a: string;
    d?: number;
    od?: boolean;
    o?: string;
    list: { n?: number }[];
    map: Record<string, { m?: "x" | "y" }>;
    maybe: { z?: string } | null;
    either: { u?: number } | 0;
  }
>;
export type M11InMatches = Expect<M11InEqual>;

type M11OutEqual = Equal<
  Infer<typeof _M11>,
  {
    a: string;
    d: number;
    od: boolean;
    o?: string;
    list: { n: number }[];
    map: Record<string, { m: "x" | "y" }>;
    maybe: { z: string } | null;
    either: { u: number } | 0;
  }
>;
export type M11OutMatches = Expect<M11OutEqual>;

type M11InIsOutEqual = Equal<M11In, Infer<typeof _M11>>;
// @ts-expect-error — the input is not the output: a defaulted key is optional in it.
export type M11InIsOut = Expect<M11InIsOutEqual>;

type M11InRequiresDefaulted = Equal<M11In["d"], number>;
// @ts-expect-error — `d` has a default, so the input may leave it out.
export type M11DefaultedRequiredOnInput = Expect<M11InRequiresDefaulted>;

// The converter is declared, so bun-common's readers see it in the type.
type Converter = (typeof _M11)["~standard"]["jsonSchema"];
type ConverterReturns = Equal<
  ReturnType<Converter["input"] | Converter["output"]>,
  Record<string, unknown>
>;
export type ConverterTyped = Expect<ConverterReturns>;

/* --- s through bun-common's res.variant(): literal fields fillable --- */

const _Kinded = s.object({ kind: s.literal("a"), n: s.integer() });
const variantRouter = new BunRouter();
variantRouter.get(
  "/v",
  validate(
    {},
    {
      responses: {
        200: variants({ a: { content: { "application/json": _Kinded } } }),
      },
    },
  ),
  (req, res) => {
    if (req.query.n === "1") {
      // `s` carries ~standard.jsonSchema, so `kind` is filled at runtime and
      // optional here, as for zod.
      return res.status(200).variant("a").json({ n: 1 });
    }
    // @ts-expect-error — without .variant() nothing is filled: kind is required.
    return res.status(200).json({ n: 1 });
  },
);

/* --- through bun-common's typed routes ------------------------------- */

const PageQuery = s.query(
  s.object({ limit: s.optional(s.integer({ default: 20 })) }),
);
const router = new BunRouter();
router.get("/jobs", validate({ query: PageQuery }), (req) => {
  const limit: number = req.query.limit;
  // @ts-expect-error — the validated limit is a number, not a string.
  const asString: string = req.query.limit;
  return { limit, asString };
});
