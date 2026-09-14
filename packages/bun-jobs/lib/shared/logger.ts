import type { LogFields, Logger, LoggerLike } from "@kingsleyweb/bun-common";
import { resolveLogger } from "@kingsleyweb/bun-common";

/**
 * Logging for the jobs package.
 *
 * Every class takes a `LoggerLike` (a structured `Logger`, a sink function,
 * or a pino/winston/consola/... instance) and binds the fields identifying
 * itself, so a record from a runner or a worker says which one it came from
 * without every call site repeating it.
 */

/**
 * Resolves an option into a `Logger` and binds `bindings` to it. `namespace`
 * is always among the bindings, since two identically-named runners in
 * different namespaces are otherwise indistinguishable in a log.
 */
export function createJobsLogger(
  input: LoggerLike | undefined,
  bindings: LogFields,
  name?: string,
): Logger {
  return resolveLogger(input).child(bindings, name ? { name } : undefined);
}

export type { LogFields, Logger, LoggerLike };
export { resolveLogger };
