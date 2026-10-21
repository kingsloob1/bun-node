/**
 * Compile-time assertions that the Nest adapter's verb methods narrow their
 * handlers the same way bun-common's do, response variants (V3c) included.
 * Checked by `bun check`, not `bun test`.
 */
import type {
  ParamsDictionary,
  StandardSchemaV1,
} from "@kingsleyweb/bun-common";
import { validate, variants } from "@kingsleyweb/bun-common";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

declare const QuerySchema: StandardSchemaV1<unknown, { page: number }>;
declare const BodySchema: StandardSchemaV1<unknown, { title: string }>;

const adapter = new BunHttpAdapter(0);

// params from the path literal
adapter.get("/user/:id", (_req) => {
  type _ = Expect<Equal<typeof _req.params, { id: string }>>;
});

// query from the validator, params still from the path
adapter.get("/posts/:id", validate({ query: QuerySchema }), (_req) => {
  type _q = Expect<Equal<typeof _req.query, { page: number }>>;
  type _p = Expect<Equal<typeof _req.params, { id: string }>>;
});

// body from the validator, with a plain middleware ahead of it
adapter.post(
  "/posts",
  (_req, _res, next) => next(),
  validate({ body: BodySchema }),
  (_req) => {
    type _b = Expect<Equal<typeof _req.body, { title: string }>>;
  },
);

// regression: a dynamic path still registers, untyped params
declare const dynamicPath: string;
adapter.get(dynamicPath, (_req) => {
  type _ = Expect<Equal<typeof _req.params, ParamsDictionary>>;
});

export {};

/* --- responses: the Nest adapter's verbs hold res too (V3a) --------- */

declare const UserSchema: StandardSchemaV1<{ id: string }, { id: string }>;
adapter.get(
  "/typed/:id",
  validate(
    { query: QuerySchema },
    { responses: { 200: UserSchema, 204: null } },
  ),
  (req, res) => {
    type _q = Expect<Equal<typeof req.query, { page: number }>>;
    if (req.query.page === 0) return res.status(204).send(null);
    // @ts-expect-error the 200's body is a User
    if (req.query.page === 1) return res.status(200).json({ id: 1 });
    // @ts-expect-error 404 is not declared
    if (req.query.page === 2) return res.status(404).json({ id: "a" });
    return res.status(200).json({ id: req.params.id });
  },
);

/* --- response variants: the union, narrowed by res.variant() (V3c) --- */

declare const AdminSchema: StandardSchemaV1<
  { id: string; salary: number },
  { id: string; salary: number }
>;
declare const AdminHeaderSchema: StandardSchemaV1<
  { "x-admin"?: "1" },
  { "x-admin"?: "1" }
>;
adapter.get(
  "/variants",
  validate(
    { headers: AdminHeaderSchema },
    {
      responses: {
        200: variants(
          {
            admin: {
              when: (valid) => valid.headers["x-admin"] === "1",
              content: { "application/json": AdminSchema },
            },
            user: { content: { "application/json": UserSchema } },
          },
          { by: { header: "x-view" } },
        ),
      },
    },
  ),
  (_req, res) => {
    res.status(200).json({ id: "a" }); // the union
    res.status(200).variant("admin").set("x-view", "admin");
    // @ts-expect-error the user variant's body under the admin variant
    res.status(200).variant("admin").json({ id: "a" });
    // @ts-expect-error the discriminant holds the variant's own value
    res.status(200).variant("user").set("x-view", "admin");
    return res.status(200).variant("user").json({ id: "a" });
  },
);
