/**
 * Compile-time assertions for `RouteDef.describe()`: chaining keeps the
 * definition's types (and so its `RoutesOf` entry, with its `send` and
 * `receive` views), and the doc is a `RouteDoc` — a wrong field type or an
 * unknown field is refused. Checked by `bun run check`, not by `bun test`
 * (`--check` covers test files only). Every `@ts-expect-error` is a guard: if
 * the error stops appearing, the build fails on the unused directive.
 */
import { z } from "zod";
import type { RouteDef, RoutesOf } from "../lib/defineRoutes";
import { validate } from "../lib/BunValidate";
import { defineRoutes } from "../lib/defineRoutes";
import type { RouteDoc } from "../lib/docs/routeDoc";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;

const IdParams = z.object({ id: z.string() });
const PageQuery = z.object({ page: z.coerce.number().default(1) });
const User = z.object({ id: z.string(), born: z.date() });

/** One registry, built twice: once bare, once with every route described. */
const _bare = defineRoutes("/users", (r) => ({
  getUser: r.get(
    "/:id",
    validate({ params: IdParams }, { responses: { 200: User, 404: null } }),
    (req, res) => res.status(200).json({ id: req.params.id, born: new Date() }),
  ),
  listUsers: r.get("/", validate({ query: PageQuery }), (req, res) =>
    res.json({ page: req.query.page }),
  ),
  ping: r.get("/ping", (_req, res) => res.send("pong")),
}));

const described = defineRoutes("/users", (r) => ({
  getUser: r
    .get(
      "/:id",
      validate({ params: IdParams }, { responses: { 200: User, 404: null } }),
      (req, res) => {
        // The handler is typed exactly as without describe().
        type _p = Expect<Equal<typeof req.params, { id: string }>>;
        res.status(200).json({ id: req.params.id, born: new Date() });
      },
    )
    .describe({
      summary: "Read one user",
      description: "By id.",
      tags: ["users"],
      operationId: "readUser",
      deprecated: false,
      errors: ["NOT_FOUND"],
      cache: { tags: ["user:{id}"], invalidates: [] },
      extensions: { "x-team": "core" },
    }),
  listUsers: r
    .get("/", validate({ query: PageQuery }), (req, res) =>
      res.json({ page: req.query.page }),
    )
    // Chains, several times.
    .describe({ summary: "List users" })
    .describe({ cache: { tags: ["users"] } }),
  ping: r
    .get("/ping", (_req, res) => res.send("pong"))
    .describe({ hidden: true }),
}));

/* --- describe() returns the definition, its types unchanged --------- */

type Def = (typeof _bare)["getUser"];
type _sameDef = Expect<Equal<(typeof described)["getUser"], Def>>;
type _sameList = Expect<
  Equal<(typeof described)["listUsers"], (typeof _bare)["listUsers"]>
>;
type _samePing = Expect<
  Equal<(typeof described)["ping"], (typeof _bare)["ping"]>
>;
type _chainReturns = Expect<Equal<ReturnType<Def["describe"]>, Def>>;
type _method = Expect<Equal<(typeof described)["getUser"]["method"], "GET">>;
type _path = Expect<Equal<(typeof described)["getUser"]["path"], "/users/:id">>;
type _notAny = Expect<
  Equal<IsAny<ReturnType<(typeof described)["getUser"]["describe"]>>, false>
>;

// Called on the returned registry, too: the same definition back.
const _later = described.getUser.describe({ summary: "Later" });
type _laterDef = Expect<Equal<typeof _later, Def>>;

/* --- RoutesOf is untouched (errors narrow nothing here) ------------- */

type _routes = Expect<
  Equal<RoutesOf<typeof described>, RoutesOf<typeof _bare>>
>;
type Api = RoutesOf<typeof described>;
type _keys = Expect<
  Equal<keyof Api, "GET /users/:id" | "GET /users/" | "GET /users/ping">
>;
type _send = Expect<
  Equal<Api["GET /users/:id"]["send"]["params"], { id: string }>
>;
type _sendQuery = Expect<
  Equal<Api["GET /users/"]["send"]["query"], { page?: number | undefined }>
>;
type _receive200 = Expect<
  Equal<Api["GET /users/:id"]["receive"][200], { id: string; born: string }>
>;
type _receive404 = Expect<
  Equal<Api["GET /users/:id"]["receive"][404], undefined>
>;

/* --- the doc is a RouteDoc: wrong fields are refused ---------------- */

type _param = Expect<Equal<Parameters<Def["describe"]>[0], RouteDoc>>;

defineRoutes("/x", (r) => ({
  a: r
    .get("/a", (_req, res) => res.send(""))
    // @ts-expect-error errors is a list of codes, not one string
    .describe({ errors: "NOT_FOUND" }),
  b: r
    .get("/b", (_req, res) => res.send(""))
    // @ts-expect-error error codes are strings
    .describe({ errors: [404] }),
  c: r
    .get("/c", (_req, res) => res.send(""))
    // @ts-expect-error cache.tags is a list, not one tag
    .describe({ cache: { tags: "user:{id}" } }),
  d: r
    .get("/d", (_req, res) => res.send(""))
    // @ts-expect-error cache has no such field
    .describe({ cache: { ttl: 60 } }),
  e: r
    .get("/e", (_req, res) => res.send(""))
    // @ts-expect-error summary is a string
    .describe({ summary: 1 }),
  f: r
    .get("/f", (_req, res) => res.send(""))
    // @ts-expect-error an unknown field (a typo of summary)
    .describe({ summery: "x" }),
  g: r
    .get("/g", (_req, res) => res.send(""))
    // @ts-expect-error extension keys start with "x-"
    .describe({ extensions: { team: "core" } }),
  h: r
    .get("/h", (_req, res) => res.send(""))
    // @ts-expect-error a doc is required
    .describe(),
}));

/* --- a bare RouteDef carries describe() too -------------------------- */

type _bareDescribe = Expect<Equal<ReturnType<RouteDef["describe"]>, RouteDef>>;

export {};
