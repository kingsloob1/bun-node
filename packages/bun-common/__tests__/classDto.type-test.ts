/**
 * Compile-time assertions for class DTOs (AD phase (b2), plan
 * `docs/plans/api-docs-generation/` §3.6): a DTO class in a schema slot
 * types the handler's `req` (and `req.valid`) as the class instance, a
 * declared response status takes the instance, and the inference types learn
 * `DtoClass<T>` → output `T`, input `unknown`.
 *
 * Runtime behaviour is covered in `classDto.test.ts`. Nothing here runs —
 * the classes need no decorators for the types to bite.
 */
import { IsInt, IsString, Min } from "class-validator";
import { BunRouter } from "../lib/BunRouter";
import type {
  InferValidatedShape,
  ValidatedShapeFor,
} from "../lib/BunValidate";
import { validate } from "../lib/BunValidate";
import type { DtoClass } from "../lib/classDto";
import type { RouteDoc } from "../lib/docs/routeDoc";
import type { StandardSchemaV1 } from "../lib/types/standardSchema";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

class PageQuery {
  @IsInt()
  @Min(1)
  page!: number;

  @IsString()
  name!: string;
}

class UserResult {
  @IsInt()
  id!: number;

  @IsString()
  name!: string;

  /** A method, so a structurally-identical plain object is not one. */
  label(): string {
    return `${this.id}:${this.name}`;
  }
}

const router = new BunRouter();

/* --- a DTO in a schema slot types the handler's request ------------- */

router.get("/search", validate({ query: PageQuery }), (_req) => {
  type _query = Expect<Equal<typeof _req.query, PageQuery>>;
  type _valid = Expect<Equal<typeof _req.valid.query, PageQuery>>;
});

router.post(
  "/users/:page",
  validate({ params: PageQuery, body: UserResult }),
  (_req) => {
    type _params = Expect<Equal<typeof _req.params, PageQuery>>;
    type _body = Expect<Equal<typeof _req.body, UserResult>>;
  },
);

/* --- the inference types learn DtoClass<T> --------------------------- */

type _shape = Expect<
  Equal<
    InferValidatedShape<{
      query: DtoClass<PageQuery>;
      body: StandardSchemaV1<unknown, { title: string }>;
    }>,
    { query: PageQuery; body: { title: string } }
  >
>;

type _validated = Expect<
  Equal<ValidatedShapeFor<{ query: DtoClass<PageQuery> }>, { query: PageQuery }>
>;

/* --- a DTO on a response status types `res` -------------------------- */

router.get(
  "/users",
  validate({}, { responses: { 200: UserResult } }),
  (_req, res) => {
    res.status(200).json(new UserResult());
    // @ts-expect-error a wrong instance (no label()) for the DTO-declared status
    res.status(200).json({ id: 1, name: "ada" });
  },
);

router.get(
  "/users-mapped",
  validate(
    {},
    { responses: { 200: { content: { "application/json": UserResult } } } },
  ),
  (_req, res) => {
    res.status(200).json(new UserResult());
    // @ts-expect-error a wrong instance in the content-map position too
    res.status(200).json({ id: 1, name: "ada" });
  },
);

/* --- the documentation types accept a DTO class ---------------------- */

const _doc: RouteDoc = {
  request: {
    query: PageQuery,
    params: PageQuery,
    body: UserResult,
    headers: PageQuery,
    cookies: PageQuery,
  },
  responses: { 200: UserResult, 201: { schema: UserResult }, 204: null },
};
