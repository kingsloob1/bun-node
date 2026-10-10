// Can a cache middleware's TYPE stop it being placed between validate() and
// the handler, where it would silently drop the validated shape? Compares a
// plain RouterHandler with one branded `readonly __shape?: never`.
// Run: bunx tsc -p .     (from this directory; expected errors are listed in results.txt)
import type { RouterHandler } from "../../../../../packages/bun-common/lib/types/general";
import type { StandardSchemaV1 } from "../../../../../packages/bun-common/lib/types/standardSchema";
import { BunRouter } from "../../../../../packages/bun-common/lib/BunRouter";
import { validate } from "../../../../../packages/bun-common/lib/BunValidate";

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
declare const QuerySchema: StandardSchemaV1<unknown, { page: number }>;
const router = new BunRouter();

declare const plain: RouterHandler;
declare const branded: RouterHandler & { readonly __shape?: never };

// 1. Before the validator: both must keep the typed query.
router.get("/a", plain, validate({ query: QuerySchema }), (req) => { type _ = Expect<Equal<typeof req.query, { page: number }>>; });
router.get("/b", branded, validate({ query: QuerySchema }), (req) => { type _ = Expect<Equal<typeof req.query, { page: number }>>; });

// 2. Between validator and handler, PLAIN: compiles, but query is no longer typed (the silent loss).
router.get("/c", validate({ query: QuerySchema }), plain, (req) => { type _ = Expect<Equal<typeof req.query, { page: number }>>; /* expected to FAIL: shows the loss */ });

// 3. Between validator and handler, BRANDED: does the brand turn the loss into an error, or into `never`?
router.get("/d", validate({ query: QuerySchema }), branded, (req) => { const page: number = req.query.page; void page; });

// 4. Alone (no validator): the branded handler must still be accepted.
router.get("/e", branded, (req) => { void req.params; });
