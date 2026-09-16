import type { Infer } from "../../lib/api/schema/builder";
import type { MetaSchema } from "../../lib/api/schemas/meta";
/**
 * Compile-time assertions for `defineRoute`: a handler's `params`, `query`
 * and `body` are what its schemas produce, and it may only answer with the
 * bodies its responses declare. Checked by `tsc`, not `bun test`.
 *
 * Each negative control is an `@ts-expect-error` over one short line, so
 * formatting cannot move the failure off the directive.
 */
import type { MetaDto } from "../../lib/api/serialize";
import { defineRoute } from "../../lib/api/routes/define";
import { s } from "../../lib/api/schema/builder";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const Params = s.query(s.object({ queue: s.string(), id: s.integer() }));
const Query = s.query(
  s.object({ force: s.optional(s.boolean({ default: false })) }),
);
const Body = s.object({ ids: s.array(s.string()) });
const Count = s.object({ count: s.integer() });

interface ParamsOut {
  queue: string;
  id: number;
}
interface QueryOut {
  force: boolean;
}
interface BodyOut {
  ids: string[];
}

export const typed = defineRoute({
  method: "POST",
  path: "/queues/:queue/jobs/:id/retry",
  operationId: "typed",
  action: "jobs.retry",
  mode: "jobs",
  summary: "typed",
  tags: [],
  params: Params,
  query: Query,
  body: Body,
  responses: { 200: Count, 204: null },
  target: ({ params, body }) => ({ queue: params.queue, jobIds: body.ids }),
  handler: (ctx) => {
    const _params: Expect<Equal<typeof ctx.params, ParamsOut>> = true;
    const _query: Expect<Equal<typeof ctx.query, QueryOut>> = true;
    const _body: Expect<Equal<typeof ctx.body, BodyOut>> = true;
    // @ts-expect-error — a validated integer is not a string.
    const _idAsString: string = ctx.params.id;
    // @ts-expect-error — the query schema declares no "nope".
    const _nope = ctx.query.nope;
    if (ctx.body.ids.length === 0) {
      return { status: 204 };
    }
    return { body: { count: ctx.body.ids.length } };
  },
});

export const wrongBody = defineRoute({
  method: "GET",
  path: "/wrong",
  operationId: "wrong",
  action: "jobs.read",
  mode: "jobs",
  summary: "wrong",
  tags: [],
  responses: { 200: Count },
  // @ts-expect-error — the declared body has an integer count.
  handler: () => ({ body: { count: "3" } }),
});

export const untyped = defineRoute({
  method: "GET",
  path: "/plain/:name",
  operationId: "plain",
  action: "jobs.read",
  mode: "any",
  summary: "plain",
  tags: [],
  responses: { 200: s.object({ name: s.string() }) },
  handler: (ctx) => {
    // Without schemas the inputs are the router's raw shapes.
    const _raw: Expect<Equal<typeof ctx.params, Record<string, string>>> = true;
    // @ts-expect-error — with no body schema the body is unknown: a JSON
    // mutation still carries one, and nothing has validated it.
    const _body: string = ctx.body;
    return { body: { name: ctx.params.name ?? "" } };
  },
});

/* The Meta schema cannot drift from the DTO /meta returns. */
type MetaEqual = Equal<Infer<typeof MetaSchema>, MetaDto>;
export type MetaMatches = Expect<MetaEqual>;

const _MetaWithoutDocs = s.object({ namespace: s.string() });
type MetaDriftEqual = Equal<Infer<typeof _MetaWithoutDocs>, MetaDto>;
// @ts-expect-error — a partial schema is not the DTO.
export type MetaDrift = Expect<MetaDriftEqual>;
