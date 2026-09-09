/**
 * Compile-time assertions that the Nest adapter's verb methods narrow their
 * handlers the same way bun-common's do. Checked by `tsc`, not `bun test`.
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import { validate } from "@kingsleyweb/bun-common";
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
  type _ = Expect<Equal<typeof _req.params, Record<string, string>>>;
});

export {};
