/**
 * The contract core's logger, as bun-common resolves it.
 *
 * `@kingsleyweb/bun-contract` asks only for a minimal logger (`warn` and
 * `error`, message first) or a sink. Loading this module installs
 * bun-common's {@link resolveLogger} as its resolution, so a `logger` option
 * given to a guard or `mergeContracts` keeps meaning what it did before the
 * core moved out: a bun-common `Logger` as it is, a `LogSink`, or a pino,
 * bunyan, winston, consola, log4js, tslog, NestJS or console-like logger
 * through its adapter, and nothing at all bun-common's console logger. An
 * object `resolveLogger` does not recognise but which has `warn` and `error`
 * (a bare `ContractLogger`) is used as it is.
 *
 * Imported for its effect by `./index`, `./guard` and `./describe`, the
 * modules whose functions log; it also re-exports the package's
 * `lib/logger.ts`, like the other modules here.
 */
import type {
  ContractLogger,
  ContractLoggerLike,
} from "@kingsleyweb/bun-contract/lib/logger";
import type { LoggerLike } from "../logging";
import { setLoggerResolver } from "@kingsleyweb/bun-contract/lib/logger";
import { resolveLogger } from "../logging";

export * from "@kingsleyweb/bun-contract/lib/logger";

/**
 * bun-common's resolution of a contract `logger` option: `resolveLogger`,
 * falling back to the object itself when it is a bare {@link ContractLogger}.
 *
 * @param input The option's value; `undefined` when none was given.
 */
function resolveCommonContractLogger(
  input: ContractLoggerLike | undefined,
): ContractLogger {
  try {
    // Every `LoggerLike` is a `ContractLoggerLike` (`contractLogger.type-test.ts`);
    // the reverse holds except for a bare `{ warn, error }`, which
    // `resolveLogger` refuses and the fallback below takes.
    return resolveLogger(input as LoggerLike | undefined);
  } catch (error) {
    if (
      typeof input === "object" &&
      typeof input.warn === "function" &&
      typeof input.error === "function"
    ) {
      return input;
    }
    throw error;
  }
}

setLoggerResolver(resolveCommonContractLogger);
