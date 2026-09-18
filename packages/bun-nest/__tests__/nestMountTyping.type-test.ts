/**
 * Compile-time assertions that bun-nest's `BunHttpAdapter.use()` mounts
 * bun-common sub-routers under the same contract as bun-common's own `use()`
 * (see bun-common's `mountTyping.type-test.ts`): a plain router mounts as is,
 * a router that declared its mount must be mounted exactly there. Checked by
 * `tsc`, not `bun test`; runtime coverage is in `httpAdapter.test.ts`.
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import { BunRouter, validate } from "@kingsleyweb/bun-common";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

declare const PageQuery: StandardSchemaV1<unknown, { page: number }>;
declare const CursorQuery: StandardSchemaV1<unknown, { cursor: string }>;

const adapter = new BunHttpAdapter(0);

/* --- a plain router mounts with no cast ---------------------------- */

const plain = new BunRouter();
plain.get("/thing", (_req, res) => res.send("ok"));
adapter.use("/plain", plain);
adapter.use(plain);
// Middleware and routers mix in one call, as in Express.
adapter.use("/mixed", (_req, _res, next) => next(), plain);

// A router typed as a bare `BunRouter` (what `jobsUi()` and `createJobsApi()`
// return) mounts at a runtime string.
declare const ui: { basePath: string; router: BunRouter };
adapter.use(ui.basePath, ui.router);

// The call chains, and still returns the adapter.
const _chained = adapter.use("/a", plain).use("/b", plain);
type _chain = Expect<Equal<typeof _chained, typeof adapter>>;

// Inline middleware is still contextually typed (no implicit `any`).
adapter.use("/mw", (req, _res, next) => {
  type _p = Expect<Equal<typeof req.params, Record<string, string>>>;
  next();
});

/* --- a mount-declared router mounts at its path -------------------- */

const users = new BunRouter<"/users/:id">();
users.get("/posts/:postId", (_req) => {
  type _p = Expect<Equal<typeof _req.params, { id: string; postId: string }>>;
});
adapter.use("/users/:id", users);

const orgs = new BunRouter<"/orgs/:org", { query: { page: number } }>();
orgs.get("/members", (_req) => {
  type _q = Expect<Equal<typeof _req.query, { page: number }>>;
  type _p = Expect<Equal<typeof _req.params, { org: string }>>;
});
adapter.use("/orgs/:org", validate({ query: PageQuery }), orgs);

/* --- the declaration and the mount must agree ---------------------- */

// Each of these must NOT compile; `@ts-expect-error` fails the build if the
// error ever stops appearing.

const wrongPath = new BunRouter<"/users/:id">();
// @ts-expect-error mounted at a different path than it declared
adapter.use("/accounts/:id", wrongPath);

// @ts-expect-error a mount-declared router cannot be mounted without a path
adapter.use(wrongPath);

const wrongShape = new BunRouter<"/orgs/:o", { query: { page: number } }>();
// @ts-expect-error mounted behind a validator producing a different shape
adapter.use("/orgs/:o", validate({ query: CursorQuery }), wrongShape);

const needsValidator = new BunRouter<"/z/:id", { query: { page: number } }>();
// @ts-expect-error declares a validated query but is mounted without a validator
adapter.use("/z/:id", needsValidator);

// @ts-expect-error not a handler and not a router
adapter.use("/nope", { notARouter: true });

export {};
