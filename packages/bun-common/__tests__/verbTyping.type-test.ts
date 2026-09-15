/**
 * Compile-time assertions for the generated verb overloads.
 *
 * Two jobs: prove a handler registered after a `BunValidate` middleware sees
 * the parsed shapes, and prove the registrations that worked before the
 * overloads existed still resolve the same way. Checked by `tsc`, not
 * `bun test` — see the tests typecheck command in CLAUDE.md.
 */
import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import type { ResolvedHandler } from "../lib/types/routeTyping";
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { validate } from "../lib/BunValidate";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

declare const QuerySchema: StandardSchemaV1<unknown, { page: number }>;
declare const BodySchema: StandardSchemaV1<unknown, { title: string }>;
declare const ParamsSchema: StandardSchemaV1<unknown, { id: number }>;

const router = new BunRouter();
const adapter = new BunHttpAdapter(0);

/* --- params inferred from the path --------------------------------- */

router.get("/home/:name/:id?", (_req) => {
  type _ = Expect<Equal<typeof _req.params, { name: string; id?: string }>>;
});

adapter.get("/user/:id", (_req) => {
  type _p = Expect<Equal<typeof _req.params, { id: string }>>;
  type _q = Expect<Equal<typeof _req.query, Record<string, unknown>>>;
});

adapter.get("/assets/*splat", (_req) => {
  type _ = Expect<Equal<typeof _req.params, { 0: string; splat: string }>>;
});

/* --- a validator supplies query/body ------------------------------- */

adapter.get("/posts/:id", validate({ query: QuerySchema }), (_req) => {
  // The whole point: `page` is a number here, not `unknown`.
  type _q = Expect<Equal<typeof _req.query, { page: number }>>;
  type _page = Expect<Equal<typeof _req.query.page, number>>;
  // params still come from the path.
  type _p = Expect<Equal<typeof _req.params, { id: string }>>;
});

adapter.post("/posts", validate({ body: BodySchema }), (_req) => {
  type _b = Expect<Equal<typeof _req.body, { title: string }>>;
  type _title = Expect<Equal<typeof _req.body.title, string>>;
});

/* --- a validator overrides the path's params ----------------------- */

adapter.get("/user/:id", validate({ params: ParamsSchema }), (_req) => {
  type _p = Expect<Equal<typeof _req.params, { id: number }>>;
  type _id = Expect<Equal<typeof _req.params.id, number>>;
});

/* --- one validator covering several targets ------------------------ */

// `BunValidate` takes every target in one call, so that is the supported
// form; with two validators the one nearest the handler supplies the shape.
adapter.put(
  "/posts/:id",
  validate({ query: QuerySchema, body: BodySchema }),
  (_req) => {
    type _q = Expect<Equal<typeof _req.query, { page: number }>>;
    type _b = Expect<Equal<typeof _req.body, { title: string }>>;
    type _p = Expect<Equal<typeof _req.params, { id: string }>>;
  },
);

/* --- plain middleware around the validator ------------------------- */

adapter.patch(
  "/posts/:id",
  (_req, _res, next) => next(),
  validate({ body: BodySchema }),
  (_req) => {
    type _b = Expect<Equal<typeof _req.body, { title: string }>>;
    type _p = Expect<Equal<typeof _req.params, { id: string }>>;
  },
);

// The validator in the deepest supported position (8 preceding handlers).
adapter.delete(
  "/x/:id",
  (_req, _res, next) => next(),
  (_req, _res, next) => next(),
  (_req, _res, next) => next(),
  (_req, _res, next) => next(),
  (_req, _res, next) => next(),
  (_req, _res, next) => next(),
  (_req, _res, next) => next(),
  validate({ query: QuerySchema }),
  (_req) => {
    type _q = Expect<Equal<typeof _req.query, { page: number }>>;
  },
);

/* --- regressions: registrations that predate the overloads --------- */

// A 4-arg error handler still resolves through the wider overload.
router.use(((_err, _req, res, _next) => {
  res.status(500).send("error");
}) satisfies RouterErrorMiddlewareHandler);

// A non-literal path degrades rather than failing.
declare const dynamicPath: string;
adapter.get(dynamicPath, (_req) => {
  type _ = Expect<Equal<typeof _req.params, Record<string, string>>>;
});

// More handlers than the typed overloads cover: still compiles, untyped.
adapter.get(
  "/deep/:id",
  (_req, _res, next) => next(),
  (_req, _res, next) => next(),
  (_req, _res, next) => next(),
  (_req, _res, next) => next(),
  (_req, _res, next) => next(),
  (_req, _res, next) => next(),
  (_req, _res, next) => next(),
  (_req, _res, next) => next(),
  (_req, _res, next) => next(),
  (_req, res) => res.send("ok"),
);

// Handlers of other arities still register.
adapter.get("/arity/:id", (req) => req.method);
adapter.get("/arity2/:id", (_req, res) => res.send("ok"));

// `all` and the exotic verbs are typed too.
adapter.all("/any/:id", (_req) => {
  type _ = Expect<Equal<typeof _req.params, { id: string }>>;
});
adapter.propfind("/pf/:id", (_req) => {
  type _ = Expect<Equal<typeof _req.params, { id: string }>>;
});

/* --- a handler declared ahead of the call --------------------------- */

// Typed as the route's own handler type. It cannot follow an *inline*
// `validate(...)` (a TypeScript inference limit, documented on
// `ResolvedHandler`), so these are the two supported forms.
interface PageShape {
  query: { page: number };
}
const declaredHandler: ResolvedHandler<"/declared/:id", PageShape> = (
  req,
  res,
) => {
  res.send(`${req.params.id}:${req.query.page}`);
};

// 1. The validator stored in a const first.
const pageQuery = validate({ query: QuerySchema });
router.get("/declared/:id", pageQuery, declaredHandler);
adapter.get("/declared/:id", pageQuery, declaredHandler);
router.get(
  "/declared/:id",
  (_req, _res, next) => next(),
  pageQuery,
  declaredHandler,
);

// 2. The verb's type arguments spelled out.
router.get<"/declared/:id", PageShape>(
  "/declared/:id",
  validate({ query: QuerySchema }),
  declaredHandler,
);

// The limit itself, pinned so a TypeScript that lifts it is noticed.
// @ts-expect-error an inline generic validator loses inference to TShape
router.get("/declared/:id", validate({ query: QuerySchema }), declaredHandler);

// Negative control: a declared handler expecting a shape the validator does
// not produce is refused.
const wrongHandler: ResolvedHandler<
  "/declared/:id",
  { query: { page: string } }
> = () => undefined;
// @ts-expect-error the validator parses `page` as a number, not a string
router.get("/declared/:id", pageQuery, wrongHandler);

/* --- ws(): `ws.data.custom` is the adapter's WebSocket data type ---- */

const socketAdapter = new BunHttpAdapter<{ userId: string }>(0);
socketAdapter.ws("/chat", {
  message(_ws) {
    type _ = Expect<Equal<typeof _ws.data.custom, { userId: string }>>;
  },
});

// On a bare router the type comes from `customDataToWsClientFn`…
router.ws(
  "/rooms",
  {
    open(_ws) {
      type _ = Expect<Equal<typeof _ws.data.custom, { room: string }>>;
    },
    message: () => undefined,
  },
  () => ({ room: "lobby" }),
);

// …or an explicit type argument.
router.ws<{ room: string }>("/rooms", {
  open(_ws) {
    type _ = Expect<Equal<typeof _ws.data.custom, { room: string }>>;
  },
  message: () => undefined,
});

export {};
