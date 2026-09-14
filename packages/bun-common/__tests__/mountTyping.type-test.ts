/**
 * Compile-time assertions for mounted sub-routers.
 *
 * A sub-router declares the path it will be mounted at, so routes registered
 * on it can see the mount's params, and `use()` requires the declaration to
 * match the actual mount. Runtime behaviour is covered in `router.test.ts`;
 * these assertions prove the types report it faithfully.
 */
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { validate } from "../lib/BunValidate";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

declare const PageQuery: StandardSchemaV1<unknown, { page: number }>;
declare const TitleBody: StandardSchemaV1<unknown, { title: string }>;

/* --- mount params reach the sub-router ----------------------------- */

const users = new BunRouter<"/users/:id">();

users.get("/posts", (_req) => {
  // From the mount path alone.
  type _p = Expect<Equal<typeof _req.params, { id: string }>>;
});

users.get("/posts/:postId", (_req) => {
  // Mount params and route params merge, exactly as the matcher does.
  type _p = Expect<Equal<typeof _req.params, { id: string; postId: string }>>;
});

users.get("/files/*rest", (_req) => {
  type _p = Expect<
    Equal<typeof _req.params, { id: string; 0: string; rest: string }>
  >;
});

const adapter = new BunHttpAdapter(0);
adapter.use("/users/:id", users);

/* --- a validator at the mount reaches the sub-router --------------- */

const validated = new BunRouter<"/orgs/:org", { query: { page: number } }>();

validated.get("/members", (_req) => {
  // `query` comes from the mount's validator...
  type _q = Expect<Equal<typeof _req.query, { page: number }>>;
  // ...and params still come from the mount path.
  type _p = Expect<Equal<typeof _req.params, { org: string }>>;
});

validated.get("/members/:memberId", validate({ body: TitleBody }), (_req) => {
  // The route's own validator adds `body` without displacing the mount's query.
  type _b = Expect<Equal<typeof _req.body, { title: string }>>;
  type _q = Expect<Equal<typeof _req.query, { page: number }>>;
  type _p = Expect<
    Equal<typeof _req.params, { org: string; memberId: string }>
  >;
});

adapter.use("/orgs/:org", validate({ query: PageQuery }), validated);

/* --- a route's own validator overrides the mount's shape ----------- */

const overriding = new BunRouter<"/a/:x", { query: { page: number } }>();
declare const OtherQuery: StandardSchemaV1<unknown, { cursor: string }>;

overriding.get("/b", validate({ query: OtherQuery }), (_req) => {
  type _q = Expect<Equal<typeof _req.query, { cursor: string }>>;
});

/* --- an unmounted router is unaffected ----------------------------- */

const plain = new BunRouter();
plain.get("/user/:id", (_req) => {
  type _p = Expect<Equal<typeof _req.params, { id: string }>>;
  type _q = Expect<Equal<typeof _req.query, Record<string, unknown>>>;
});

/* --- existing untyped mounts still compile ------------------------- */

const legacy = new BunRouter();
legacy.get("/thing", (_req, res) => res.send("ok"));
adapter.use("/legacy", legacy);
adapter.use(legacy);

export {};

/* --- the declaration and the mount must agree ---------------------- */

// Each of these is a mismatch that must NOT compile. They are written with
// `@ts-expect-error`, which fails the build if the error ever stops appearing —
// so this doubles as a regression guard on the enforcement itself.

const wrongPath = new BunRouter<"/users/:id">();
// @ts-expect-error mounted at a different path than it declared
adapter.use("/accounts/:id", wrongPath);

const wrongShape = new BunRouter<"/orgs/:o", { query: { page: number } }>();
declare const CursorQuery: StandardSchemaV1<unknown, { cursor: string }>;
// @ts-expect-error mounted behind a validator producing a different shape
adapter.use("/orgs/:o", validate({ query: CursorQuery }), wrongShape);

const needsValidator = new BunRouter<"/z/:id", { query: { page: number } }>();
// @ts-expect-error declares a validated query but is mounted without a validator
adapter.use("/z/:id", needsValidator);
