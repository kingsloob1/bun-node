import { Job } from "@kingsleyweb/bun-jobs";

/**
 * Whether a value is a bun-jobs job. For a global `ContextIdStrategy`, which
 * receives the job here where it receives an HTTP request elsewhere:
 *
 * ```ts
 * attach(contextId, request) {
 *   const tenant = isBunJob(request) ? request.data.tenant : request.headers["x-tenant"];
 *   …
 * }
 * ```
 *
 * @param value What to test.
 */
export function isBunJob<TData = any, TResult = any>(
  value: unknown,
): value is Job<TData, TResult> {
  return value instanceof Job;
}
