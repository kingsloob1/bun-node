/**
 * Compile-time assertions for the `defineRoutes` registry (AD (a2); the
 * typed-client plan's §8.5). Checked by the tests typecheck (`bun check`),
 * not by `bun test` — the repo's convention (`logging.type-test.ts`). Every
 * `@ts-expect-error` doubles as a regression guard: if the error ever stops
 * appearing, the build fails on the unused directive.
 */
import { z } from "zod";
import type { RouteDef, RoutesOf } from "../lib/defineRoutes";
import { BunRouter } from "../lib/BunRouter";
import { validate } from "../lib/BunValidate";
import { defineRoutes } from "../lib/defineRoutes";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;

const IdParams = z.object({ id: z.string() });
const NewUser = z.object({ name: z.string(), age: z.number().optional() });
const PageQuery = z.object({ page: z.coerce.number().default(1) });
const User = z.object({ id: z.string(), name: z.string() });

/* --- handlers are narrowed through the builder --------------------- */

const users = defineRoutes("/users", (r) => ({
  getUser: r.get(
    "/:id",
    validate({ params: IdParams }, { responses: { 200: User } }),
    (req, res) => {
      // params from the validator, query the untyped parser output.
      type _p = Expect<Equal<typeof req.params, { id: string }>>;
      type _q = Expect<Equal<typeof req.query, Record<string, unknown>>>;
      res.status(200).json({ id: req.params.id, name: "a" });
      // @ts-expect-error an undeclared status, when responses are declared
      res.status(404).json({ id: "x", name: "b" });
    },
  ),
  createUser: r.post("/", validate({ body: NewUser }), (req, res) => {
    const _name: string = req.body.name;
    const _age: number | undefined = req.body.age;
    // @ts-expect-error the body has no such key
    const _nope: unknown = req.body.nope;
    // @ts-expect-error name is a string, not a number
    const _n: number = req.body.name;
    res.status(201).json(req.body);
  }),
  listUsers: r.get("/", validate({ query: PageQuery }), (req, res) => {
    const _page: number = req.query.page;
    res.json({ page: req.query.page });
  }),
  ping: r.get("/ping", (_req, res) => {
    // No validator: params come from the path (none here).
    type _p = Expect<Equal<typeof _req.params, Record<never, never>>>;
    res.send("pong");
  }),
}));

/* --- the mount's params reach the handlers ------------------------- */

const orgs = defineRoutes("/orgs/:org", (r) => ({
  member: r.get("/members/:memberId", (req, res) => {
    type _p = Expect<
      Equal<typeof req.params, { org: string; memberId: string }>
    >;
    res.json(req.params);
  }),
}));

/* --- the returned registry ------------------------------------------ */

type _mount = Expect<Equal<typeof users.mount, "/users">>;
type _router = Expect<Equal<typeof users.router, BunRouter<"/users">>>;
type _defMethod = Expect<Equal<typeof users.getUser.method, "GET">>;
type _defPath = Expect<Equal<typeof users.getUser.path, "/users/:id">>;

const app = new BunRouter();
app.use(users.mount, users.router);
app.use(orgs.mount, orgs.router);
// @ts-expect-error mounted at a different path than the registry declared
app.use("/accounts", users.router);

/* --- RoutesOf: the flat map ----------------------------------------- */

type Api = RoutesOf<typeof users>;

// One entry per definition, keyed "VERB /full/path"; the reserved `mount`
// and `router` properties contribute none.
type _keys = Expect<
  Equal<
    keyof Api,
    "GET /users/:id" | "POST /users/" | "GET /users/" | "GET /users/ping"
  >
>;

// params: the validator's parsed params when declared, else the path's.
type _getParams = Expect<
  Equal<Api["GET /users/:id"]["params"], { id: string }>
>;
type _orgParams = Expect<
  Equal<
    RoutesOf<typeof orgs>["GET /orgs/:org/members/:memberId"]["params"],
    { org: string; memberId: string }
  >
>;
type _pingParams = Expect<
  Equal<Api["GET /users/ping"]["params"], Record<never, never>>
>;

// query: the validator's parsed query, else the untyped parser output.
type _listQuery = Expect<Equal<Api["GET /users/"]["query"], { page: number }>>;
type _getQuery = Expect<
  Equal<Api["GET /users/:id"]["query"], Record<string, unknown>>
>;

// body: the parsed body, else undefined.
type _postBodyName = Expect<Equal<Api["POST /users/"]["body"]["name"], string>>;
type _getBody = Expect<Equal<Api["GET /users/:id"]["body"], undefined>>;

// responses: the declared map, else `{ 200: unknown }`.
type _pingResponses = Expect<
  Equal<Api["GET /users/ping"]["responses"], { 200: unknown }>
>;
type _getResponseStatuses = Expect<
  Equal<keyof Api["GET /users/:id"]["responses"], 200>
>;
type _getResponseBody = Expect<
  Equal<Api["GET /users/:id"]["responses"][200]["json"]["id"], string>
>;

// @ts-expect-error an unknown route reads nothing off the map
type _nope = Api["GET /nope"];

/* --- the exported types referenced bare ----------------------------- */

// Defaults for every type parameter, so a bare reference compiles (the
// consumer check's probe does exactly this).
type _bareDef = Expect<Equal<RouteDef["method"], string>>;
type _bareDefNotAny = Expect<Equal<IsAny<RouteDef["callbacks"]>, false>>;
type _bareRoutes = RoutesOf;

export {};
