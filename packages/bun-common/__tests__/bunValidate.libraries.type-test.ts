/**
 * Type-level assertions for `BunValidate` against real schema libraries.
 *
 * The runtime half is `bunValidate.libraries.test.ts`. This half asserts the
 * thing a user actually feels: after `validate({ query: schema })`, the
 * handler's `req.query` is the *library's* inferred output type — a number is
 * a number — rather than `unknown` or `string`. Four independent
 * implementations of Standard Schema's `types` carry that inference, and
 * nothing but a compiler can check it.
 *
 * Checked by the tests typecheck in CLAUDE.md, not by `bun test`.
 */
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import { type } from "arktype";
import * as v from "valibot";
import * as yup from "yup";
import { z } from "zod";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { toStandardSchema, validate } from "../lib/BunValidate";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const adapter = new BunHttpAdapter(0);

/* --- zod ----------------------------------------------------------- */

const zodQuery = z.object({ page: z.coerce.number(), tag: z.string() });
const zodBody = z.object({ title: z.string(), draft: z.boolean().optional() });

adapter.post(
  "/zod/:id",
  validate({ query: zodQuery, body: zodBody }),
  (_req) => {
    // Coerced: a string in the URL, a number in the handler.
    type _q = Expect<Equal<typeof _req.query, { page: number; tag: string }>>;
    type _page = Expect<Equal<typeof _req.query.page, number>>;
    type _b = Expect<
      Equal<typeof _req.body, { title: string; draft?: boolean | undefined }>
    >;
    // Params still come from the path, untouched by the validator.
    type _p = Expect<Equal<typeof _req.params, { id: string }>>;
  },
);

/* --- yup ------------------------------------------------------------ */

const yupQuery = yup.object({
  page: yup.number().required(),
  tag: yup.string().required(),
});

adapter.get("/yup/:id", validate({ query: yupQuery }), (_req) => {
  type _page = Expect<Equal<typeof _req.query.page, number>>;
  type _tag = Expect<Equal<typeof _req.query.tag, string>>;
  type _p = Expect<Equal<typeof _req.params, { id: string }>>;
});

/* --- valibot --------------------------------------------------------- */

const valibotQuery = v.object({
  page: v.pipe(v.unknown(), v.transform(Number), v.number()),
  tag: v.string(),
});

adapter.get("/valibot", validate({ query: valibotQuery }), (_req) => {
  type _q = Expect<Equal<typeof _req.query, { page: number; tag: string }>>;
});

/* --- arktype ---------------------------------------------------------- */

const arkQuery = type({ page: "string.integer.parse", tag: "string" });

adapter.get("/arktype", validate({ query: arkQuery }), (_req) => {
  type _page = Expect<Equal<typeof _req.query.page, number>>;
  type _tag = Expect<Equal<typeof _req.query.tag, string>>;
});

/* --- a wrapped library ------------------------------------------------ */

const wrapped = toStandardSchema<{ page: number }>((input) => {
  const page = Number((input as { page?: unknown } | null)?.page);
  return Number.isInteger(page)
    ? { value: { page } }
    : { issues: [{ message: "page must be a whole number", path: ["page"] }] };
});

adapter.get("/wrapped", validate({ query: wrapped }), (_req) => {
  // The helper's output type reaches the handler exactly like a native one.
  type _q = Expect<Equal<typeof _req.query, { page: number }>>;
});

// One type argument names the output; the input is `unknown`.
type _wrappedInput = Expect<
  Equal<StandardSchemaV1.InferInput<typeof wrapped>, unknown>
>;
type _wrappedOutput = Expect<
  Equal<StandardSchemaV1.InferOutput<typeof wrapped>, { page: number }>
>;

// Two still name both, as they always did.
const _bothNamed = toStandardSchema<string, { page: number }>(() => ({
  value: { page: 1 },
}));
type _bothInput = Expect<
  Equal<StandardSchemaV1.InferInput<typeof _bothNamed>, string>
>;
type _bothOutput = Expect<
  Equal<StandardSchemaV1.InferOutput<typeof _bothNamed>, { page: number }>
>;

// None infers the output from what the function returns, async included.
const _inferred = toStandardSchema(async (input) => ({
  value: { token: String(input) },
}));
type _inferredOutput = Expect<
  Equal<StandardSchemaV1.InferOutput<typeof _inferred>, { token: string }>
>;
type _inferredInput = Expect<
  Equal<StandardSchemaV1.InferInput<typeof _inferred>, unknown>
>;

// @ts-expect-error — a named output is checked against what is returned.
toStandardSchema<{ page: number }>(() => ({ value: { page: "one" } }));

/* --- validating params overrides what the path inferred --------------- */

const zodParams = z.object({ id: z.coerce.number() });

adapter.get("/typed/:id", validate({ params: zodParams }), (_req) => {
  type _p = Expect<Equal<typeof _req.params, { id: number }>>;
});

/* --- several libraries in one call ------------------------------------ */

adapter.put(
  "/mixed/:id",
  validate({
    query: z.object({ page: z.coerce.number() }),
    body: yup.object({ title: yup.string().required() }),
    params: v.object({ id: v.pipe(v.string(), v.transform(Number)) }),
  }),
  (_req) => {
    type _q = Expect<Equal<typeof _req.query, { page: number }>>;
    type _title = Expect<Equal<typeof _req.body.title, string>>;
    type _id = Expect<Equal<typeof _req.params.id, number>>;
  },
);

/* --- without a validator, nothing is invented -------------------------- */

adapter.get("/plain/:id", (_req) => {
  type _p = Expect<Equal<typeof _req.params, { id: string }>>;
  type _q = Expect<Equal<typeof _req.query, Record<string, unknown>>>;
});

export {};
