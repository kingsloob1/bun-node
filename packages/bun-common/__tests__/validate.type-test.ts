/**
 * Compile-time assertions for `BunValidate`'s hook typing.
 *
 * `normalize` receives the target's raw request value, `transform` the
 * schema's parsed output, and a `transform`'s return type is what the handler
 * then reads, because that value is what gets written onto the request.
 * Runtime behaviour is covered in `bunValidate.test.ts`.
 */
import type {
  InferValidatedShape,
  ValidatedShapeFor,
} from "../lib/BunValidate";
import type { DefaultRequestBody } from "../lib/types/general";
import type { EmptyShape } from "../lib/types/routeTyping";
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import { BunRouter } from "../lib/BunRouter";
import { BunValidate, validate } from "../lib/BunValidate";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

declare const PageQuery: StandardSchemaV1<unknown, { page: number }>;
declare const TitleBody: StandardSchemaV1<unknown, { title: string }>;
declare const IdParams: StandardSchemaV1<unknown, { id: number }>;
declare const TokenHeaders: StandardSchemaV1<unknown, { "x-token": string }>;

const router = new BunRouter();

/* --- without hooks, the schema's output decides ---------------------- */

router.get("/plain", validate({ query: PageQuery }), (_req) => {
  type _q = Expect<Equal<typeof _req.query, { page: number }>>;
});

// The one-argument form of the shape type is unchanged.
type _shape = Expect<
  Equal<
    InferValidatedShape<{ query: typeof PageQuery; body: typeof TitleBody }>,
    { query: { page: number }; body: { title: string } }
  >
>;

/* --- normalize receives each target's raw request value -------------- */

validate(
  {
    params: IdParams,
    query: PageQuery,
    body: TitleBody,
    headers: TokenHeaders,
  },
  {
    hooks: {
      params: {
        normalize: (value) => {
          type _v = Expect<Equal<typeof value, Record<string, string>>>;
          return value;
        },
      },
      query: {
        normalize: (value) => {
          type _v = Expect<Equal<typeof value, Record<string, unknown>>>;
          return value;
        },
      },
      body: {
        normalize: (value) => {
          type _v = Expect<Equal<typeof value, DefaultRequestBody>>;
          return value;
        },
      },
      headers: {
        normalize: (value) => {
          type _v = Expect<
            Equal<typeof value, Record<string, string | string[]>>
          >;
          return value;
        },
      },
    },
  },
);

/* --- transform receives the output, and its result reaches the handler */

router.get(
  "/offset",
  validate(
    { query: PageQuery },
    {
      hooks: {
        query: {
          transform: (value) => {
            type _v = Expect<Equal<typeof value, { page: number }>>;
            return { ...value, offset: (value.page - 1) * 20 };
          },
        },
      },
    },
  ),
  (_req) => {
    type _q = Expect<
      Equal<typeof _req.query, { page: number; offset: number }>
    >;
  },
);

// A target without a transform keeps its schema's output alongside one with.
router.post(
  "/drafts/:id",
  validate(
    { params: IdParams, body: TitleBody },
    {
      hooks: {
        body: {
          transform: (value, req) => ({
            ...value,
            author: req.getHeader("x-user-id"),
          }),
        },
      },
    },
  ),
  (_req) => {
    type _p = Expect<Equal<typeof _req.params, { id: number }>>;
    type _b = Expect<
      Equal<typeof _req.body, { title: string; author: string | null }>
    >;
  },
);

// The class and its static shorthand infer the same way.
const _viaClass = new BunValidate({
  schemas: { query: PageQuery },
  hooks: { query: { transform: (value) => value.page } },
}).middleware();
type _c = Expect<
  Equal<NonNullable<(typeof _viaClass)["__shape"]>, { query: number }>
>;

const _viaStatic = BunValidate.middleware({
  schemas: { query: PageQuery },
  hooks: { query: { transform: (value) => String(value.page) } },
});
type _s = Expect<
  Equal<NonNullable<(typeof _viaStatic)["__shape"]>, { query: string }>
>;

// Headers are validated but never written back, so their transform does not
// change the shape.
const _headerHook = validate(
  { headers: TokenHeaders },
  { hooks: { headers: { transform: () => 42 } } },
);
type _h = Expect<
  Equal<
    NonNullable<(typeof _headerHook)["__shape"]>,
    { headers: { "x-token": string } }
  >
>;

/* --- negative controls ------------------------------------------------ */

validate(
  { query: PageQuery, params: IdParams },
  {
    hooks: {
      query: {
        // @ts-expect-error — the parsed output has no `size`.
        transform: (value) => value.size,
      },
      params: {
        // @ts-expect-error — params are strings, which have no `toFixed`.
        normalize: (value) => value.id.toFixed(),
      },
    },
  },
);

/* --- hooks only on a target that has a schema ------------------------- */

// Hooks run around validation, so a hook on a target without a schema would
// never run: it is rejected rather than silently accepted.
validate(
  { query: PageQuery },
  {
    hooks: {
      query: { transform: (value) => value.page },
      // @ts-expect-error — `body` has no schema, so its hooks would never run.
      body: { transform: (value: unknown) => value },
    },
  },
);
const _orphanOnClass = new BunValidate({
  schemas: { body: TitleBody },
  hooks: {
    // @ts-expect-error — `params` has no schema here either.
    params: { normalize: (value: unknown) => value },
  },
});

/* --- replace: false writes nothing, so claims nothing ----------------- */

router.get(
  "/raw",
  validate({ query: PageQuery }, { replace: false }),
  (_req) => {
    // The request's own query type, not the schema's output.
    type _q = Expect<Equal<typeof _req.query, Record<string, unknown>>>;
  },
);

const _noReplace = validate({ query: PageQuery }, { replace: false });
type _nr = Expect<
  Equal<NonNullable<(typeof _noReplace)["__shape"]>, EmptyShape>
>;

const _explicitReplace = validate({ query: PageQuery }, { replace: true });
type _er = Expect<
  Equal<
    NonNullable<(typeof _explicitReplace)["__shape"]>,
    { query: { page: number } }
  >
>;

// A `replace` only known to be a boolean may be `false`, so it claims nothing.
declare const maybeReplace: boolean;
const _maybeReplace = validate({ query: PageQuery }, { replace: maybeReplace });
type _mr = Expect<
  Equal<NonNullable<(typeof _maybeReplace)["__shape"]>, EmptyShape>
>;

const _classNoReplace = new BunValidate({
  schemas: { query: PageQuery },
  replace: false,
}).middleware();
type _cnr = Expect<
  Equal<NonNullable<(typeof _classNoReplace)["__shape"]>, EmptyShape>
>;

type _shapeFor = Expect<
  Equal<
    ValidatedShapeFor<{ query: typeof PageQuery }, unknown, false>,
    EmptyShape
  >
>;

type _noReplaceNumber = Expect<
  // @ts-expect-error — with `replace: false` the handler must not see a number.
  Equal<
    ValidatedShapeFor<{ query: typeof PageQuery }, unknown, false>,
    { query: { page: number } }
  >
>;

/* --- formatError answers any JSON value ------------------------------- */

validate(
  { query: PageQuery },
  {
    onFailure: "respond",
    formatError: (error) => error.issues.map((issue) => issue.message),
  },
);
validate({ query: PageQuery }, { formatError: () => "invalid" });
validate({ query: PageQuery }, { formatError: () => null });
validate(
  { query: PageQuery },
  // @ts-expect-error — `undefined` is not a JSON value.
  { formatError: () => undefined },
);
validate(
  { query: PageQuery },
  // @ts-expect-error — nor is a function.
  { formatError: () => () => 1 },
);

router.get(
  "/offset-wrong",
  validate(
    { query: PageQuery },
    { hooks: { query: { transform: (value) => ({ ...value, offset: 1 }) } } },
  ),
  (_req) => {
    // @ts-expect-error — `offset` is a number, not a string.
    type _q = Expect<Equal<typeof _req.query.offset, string>>;
  },
);
