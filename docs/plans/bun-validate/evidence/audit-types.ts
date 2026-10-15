/**
 * Part A, types: what BunValidate types today, on develop, unpatched.
 *
 * Pass condition: a bare `bun --check` in this directory exits 0 with the
 * AGENT, CLAUDECODE and REPL_ID variables removed (see README.md). Every
 * `@ts-expect-error` is a negative control: if the error it expects stops
 * happening, the directive itself fails (TS2578), so a clean run proves the
 * positive cases compile *and* the negative ones are refused.
 *
 * Lines marked "compiles today" are the gaps: they would be errors if the
 * response were typed.
 */
import type { BunRequest, StandardSchemaV1 } from "@kingsleyweb/bun-common";
import { BunRouter, validate } from "@kingsleyweb/bun-common";
import { BunJobs, BunQueue, type JobProcessor, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { BunHttpAdapter as NestAdapter } from "@kingsleyweb/bun-nest";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

interface User { id: string; name: string }
declare const PageQuery: StandardSchemaV1<unknown, { page: number }>;
declare const UserS: StandardSchemaV1<unknown, User>;
declare const NumHeader: StandardSchemaV1<unknown, { "x-n": number }>;
declare const SidCookie: StandardSchemaV1<unknown, { sid: string }>;

const r = new BunRouter();

/* T1 (positive control): the request side is typed from the schema. */
r.get("/t1/:id", validate({ query: PageQuery }), (req) => {
  type _q = Expect<Equal<typeof req.query, { page: number }>>;
  type _p = Expect<Equal<typeof req.params, { id: string }>>;
  // @ts-expect-error page is a number, not a string
  const _s: string = req.query.page;
});

/* T2 (gap): after a validator, res.json takes any JSON — compiles today. */
r.get("/t2", validate({ query: PageQuery }), (_req, res) => res.status(418).json({ anything: 1 }));

/* T3: there is no `responses` option to declare a response with. */
// @ts-expect-error 'responses' does not exist in BunValidateOptions
r.get("/t3", validate({ query: PageQuery }, { responses: { 200: UserS } }), (_req, res) => res.json({}));

/* T4 (gap): a handler's return value is unconstrained — compiles today. */
r.get("/t4", validate({ query: PageQuery }), () => ({ not: "a user" }));

/* T5: the only response typing is per call, restated by hand. */
r.get("/t5", (_req, res) => res.json<User>({ id: "1", name: "n" }));
// @ts-expect-error a per-call type argument does check the body
r.get("/t5b", (_req, res) => res.json<User>({ id: 1 }));

/* T6 (gap): a headers schema validates, but req.headers is not narrowed. */
r.get("/t6", validate({ headers: NumHeader }), (req) => {
  type _h = Expect<Equal<typeof req.headers, BunRequest["headers"]>>;
  // @ts-expect-error x-n stays string | string[] | undefined, not the schema's number
  const _n: number = req.headers["x-n"];
});

/* T7: cookies is not a target. Alone it is refused (no overlap with the weak
   type); beside a known target it is accepted, and ignored at runtime (R5). */
// @ts-expect-error { cookies } has nothing in common with ValidationSchemas
validate({ cookies: SidCookie });
validate({ query: PageQuery, cookies: SidCookie }); // compiles today

/* T8: an explicit `status: undefined` compiles; at runtime it answers 200 (R2h). */
validate({ query: PageQuery }, { onFailure: "respond", status: undefined });

/* T9: bun-nest's adapter carries the same request typing... */
declare const nest: NestAdapter;
nest.get("/t9", validate({ query: PageQuery }), (req, res) => {
  type _q = Expect<Equal<typeof req.query, { page: number }>>;
  return res.status(599).json({ anything: 1 }); // ...and the same response gap
});

/* T10: a WebSocket message is bytes or text; nothing types it from a schema. */
r.ws("/t10", {
  message(_ws, message) {
    type _m = Expect<Equal<typeof message, string | Buffer<ArrayBuffer>>>;
  },
});

/* T11: job data is typed by a type argument only; there is no schema option. */
const driver = new MemoryDriver();
const q = new BunQueue<{ to: string }, string>("emails", { namespace: "t", driver });
// @ts-expect-error the type argument checks the producer's payload...
void q.add("welcome", { to: 42 });
const jobs = new BunJobs({ namespace: "t", driver });
const handler: JobProcessor<{ to: string }, string> = async (job) => job.data.to;
// @ts-expect-error ...but a definition cannot carry a schema
jobs.define("welcome", handler, { schema: UserS });

export { r };
