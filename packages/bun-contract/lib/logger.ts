/**
 * Where the contract core's few log lines go, with no logging library behind
 * it: a guard under `"warn"` writes one warning per failing message, a guard
 * whose `onIssues` hook throws writes one error, and `mergeContracts` warns
 * about a refinement. Those are the only records, so the core asks for the
 * smallest logger that can take them ({@link ContractLogger}) or a function
 * taking each record ({@link ContractLogSink}).
 *
 * On its own the package resolves a `logger` option itself: nothing means
 * the console, a function is called with each record, and an object's
 * `warn`/`error` are called with `(message, fields)`. bun-common installs
 * its own resolver ({@link setLoggerResolver}) when its contract entry
 * loads, so there the option keeps accepting every logger bun-common's
 * `resolveLogger` adapts (pino and bunyan take their fields first, and are
 * called that way), and an absent one is bun-common's console logger.
 *
 * Browser-safe: no import at all.
 */

/**
 * One record handed to a {@link ContractLogSink}. Its fields are those of
 * bun-common's `LogEvent` that a record must have, so a bun-common `LogSink`
 * is a {@link ContractLogSink}.
 */
export interface ContractLogEvent {
  /** The level: the core writes only warnings and errors. */
  level: "warn" | "error";
  /** The message, e.g. `"contract mismatch"`. */
  message: string;
  /**
   * The `Error` behind the record, lifted from `fields.error` when that is
   * one; absent otherwise.
   */
  error?: Error;
  /** The record's structured fields (transport, side, issues). */
  fields: Record<string, unknown>;
  /** Fields bound to the logger; always empty here, kept for `LogEvent`'s shape. */
  bindings: Record<string, unknown>;
  /** When the record was made (`Date.now()`). */
  time: number;
}

/** A function taking each record; bun-common's `LogSink` is one. */
export type ContractLogSink = (event: ContractLogEvent) => void;

/**
 * The two methods the contract core calls, each with a message and
 * structured fields. bun-common's `Logger` and the console are this shape.
 */
export interface ContractLogger {
  /** Writes a warning: the message and its fields. */
  warn: (message: string, fields?: Record<string, unknown>) => void;
  /** Writes an error: the message and its fields. */
  error: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * What a `logger` option accepts: a {@link ContractLogger} or a
 * {@link ContractLogSink}. Every logger bun-common's `LoggerLike` names
 * (its `Logger`, a `LogSink`, pino, bunyan, winston, consola, log4js, tslog,
 * a NestJS or console-like logger) is one of the two, structurally; how it
 * is called depends on the resolver (see the module's comment).
 */
export type ContractLoggerLike = ContractLogger | ContractLogSink;

/**
 * Turns a `logger` option, or its absence, into the logger the core writes
 * to. Called once per guard or merge, on its first record.
 */
export type ContractLoggerResolver = (
  input: ContractLoggerLike | undefined,
) => ContractLogger;

/**
 * The host's console, as far as the default logger uses it. Browsers, Bun
 * and Node all have one; declared here so the package type-checks, and builds
 * its declarations, with no environment's types (it imports none).
 */
declare const console: {
  /** Writes a warning. */
  warn: (...data: unknown[]) => void;
  /** Writes an error. */
  error: (...data: unknown[]) => void;
};

/** The console, as a {@link ContractLogger}; the default when no logger is given. */
const consoleLogger: ContractLogger = {
  warn: (message, fields) => {
    if (fields === undefined) console.warn(message);
    else console.warn(message, fields);
  },
  error: (message, fields) => {
    if (fields === undefined) console.error(message);
    else console.error(message, fields);
  },
};

/** A logger writing each record to `sink`. */
function sinkLogger(sink: ContractLogSink): ContractLogger {
  const write =
    (level: ContractLogEvent["level"]) =>
    (message: string, fields: Record<string, unknown> = {}): void => {
      const error = fields.error;
      sink({
        level,
        message,
        ...(error instanceof Error ? { error } : {}),
        fields,
        bindings: {},
        time: Date.now(),
      });
    };
  return { warn: write("warn"), error: write("error") };
}

/**
 * The package's own resolution, used until a resolver is installed: the
 * console for nothing, a sink for a function, the object itself when it has
 * `warn` and `error` methods.
 *
 * @throws {TypeError} For anything else, naming what is accepted.
 */
export function defaultLoggerResolver(
  input: ContractLoggerLike | undefined,
): ContractLogger {
  if (input === undefined || input === null) return consoleLogger;
  if (typeof input === "function") return sinkLogger(input);
  if (
    typeof input === "object" &&
    typeof input.warn === "function" &&
    typeof input.error === "function"
  ) {
    return input;
  }
  throw new TypeError(
    "Unrecognised logger. Pass an object with warn(message, fields) and error(message, fields), or a function taking each log record.",
  );
}

/** The installed resolver; `undefined` means {@link defaultLoggerResolver}. */
let installed: ContractLoggerResolver | undefined;

/**
 * Installs how a `logger` option is resolved, for every guard and merge
 * made afterwards in this copy of the package; `undefined` restores
 * {@link defaultLoggerResolver}. bun-common calls it when its contract entry
 * loads. Internal: not exported from the package's root.
 *
 * @param resolver The resolver, or `undefined` for the default.
 * @returns The resolver it replaced (`undefined` when it was the default), so a caller can put it back.
 */
export function setLoggerResolver(
  resolver: ContractLoggerResolver | undefined,
): ContractLoggerResolver | undefined {
  const previous = installed;
  installed = resolver;
  return previous;
}

/**
 * Resolves a `logger` option with the installed resolver, or the default.
 *
 * @param input The option's value; `undefined` when none was given.
 */
export function resolveContractLogger(
  input: ContractLoggerLike | undefined,
): ContractLogger {
  return (installed ?? defaultLoggerResolver)(input);
}
