/**
 * Probe: can statement-style registration (`router.get(...);` on its own line,
 * the repo's dominant style) accumulate a route map without chaining?
 *
 * 1. A method returning a new type: the variable's type never changes.
 * 2. An assertion signature (`asserts this is …`) DOES narrow the variable,
 *    statement by statement, and a `typeof` type query at the end of the
 *    module sees the narrowed type, so it can be exported (measured below and
 *    in import-side.ts). But: the variable needs an explicit annotation
 *    (TS2775), an assertion method must return void (no chaining, no
 *    `.describe()`/`.setName()` after it, which breaks today's `this`
 *    returns), and the narrowing stops at function boundaries: routes
 *    registered inside `registerUsers(app)` never reach the caller's type.
 */
interface R<M = {}> {
  get<P extends string>(path: P): R<M & Record<`GET ${P}`, true>>;
  assertGet<P extends string>(path: P): asserts this is R<M & Record<`GET ${P}`, true>>;
  readonly __map?: M;
}
declare function make(): R;

const a = make();
a.get("/x");
type A = NonNullable<typeof a.__map>;
const a1: A extends Record<"GET /x", true> ? "accumulated" : "lost" = "lost"; // 1: lost

const b: R = make(); // TS2775: assertions need an explicit annotation
b.assertGet("/x");
const narrowed: NonNullable<typeof b.__map>["GET /x"] = true; // OK here: narrowed by control flow
b.assertGet("/y");
export type B = NonNullable<typeof b.__map>; // the type query sees the narrowed type
const b1: B extends Record<"GET /x" | "GET /y", true> ? "exported" : "not exported" = "exported"; // 2: exportable

function registerMore(r: R) { r.assertGet("/z"); }
registerMore(b);
const b2: NonNullable<typeof b.__map> extends Record<"GET /z", true> ? "seen" : "lost at the function boundary" = "lost at the function boundary";
void a1; void narrowed; void b1; void b2;
