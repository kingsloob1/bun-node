/**
 * Injection tokens for the jobs API module.
 *
 * Kept in their own module, importing nothing, so a consumer can name a token
 * in a provider or a test without pulling in the module — or, with it,
 * `@kingsleyweb/bun-jobs`.
 */

/** Provides the built `JobsApi`. Inject it with {@link InjectJobsApi}. */
export const BUN_JOBS_API = Symbol("BUN_JOBS_API");

/** Provides the options the module was configured with. */
export const BUN_JOBS_API_OPTIONS = Symbol("BUN_JOBS_API_OPTIONS");
