/**
 * The key a builder is routed by, and a queue carries its router under.
 *
 * Internal, a symbol so neither class grows a public name for it: `BunJobs`
 * sets `queue[JOB_ROUTER]` on every queue it creates, and calls
 * `builder[JOB_ROUTER](router)` on every builder it makes.
 *
 * A module of its own, importing nothing: `BunQueue` uses it as a computed
 * class field, and `JobBuilder` and `BunQueue` import each other, so defined
 * in either of them it was still uninitialised when the other was loaded
 * first (`ReferenceError`), through the published `./lib/*.ts` export.
 */
export const JOB_ROUTER: unique symbol = Symbol("bun-jobs: job router");
