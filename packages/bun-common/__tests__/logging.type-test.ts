/**
 * Compile-time assertions for the logging contract.
 *
 * The point of replacing the old console-shaped logger was type safety, so
 * the guarantees are asserted by `tsc` rather than at runtime: fixed
 * signatures, a closed set of levels, and adapter inputs wide enough to
 * accept what the real libraries hand you. Checked by the tests typecheck
 * command in CLAUDE.md, not by `bun test`.
 *
 * Every `@ts-expect-error` below doubles as a regression guard: if the error
 * ever stops appearing, the build fails on the unused directive.
 */
import type {
  createTestLogger,
  LogEvent,
  LogFields,
  Logger,
  LoggerLike,
  LogLevel,
  LogSink,
  resolveLogger,
} from "../lib/logging";
import {
  createLogger,
  fromBunyan,
  fromConsola,
  fromConsole,
  fromLog4js,
  fromNestLogger,
  fromPino,
  fromTslog,
  fromWinston,
} from "../lib/logging";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

declare const logger: Logger;

/* --- the signature is fixed, not variadic ------------------------- */

type _message = Expect<Equal<Parameters<Logger["info"]>[0], string | Error>>;
type _fields = Expect<
  Equal<Parameters<Logger["info"]>[1], LogFields | undefined>
>;
type _arity = Expect<Equal<Parameters<Logger["info"]>["length"], 1 | 2>>;
type _levels = Expect<
  Equal<LogLevel, "trace" | "debug" | "info" | "warn" | "error" | "fatal">
>;

logger.info("plain");
logger.info("with fields", { requestId: "r1", attempt: 2 });
logger.error(new Error("an error is a valid message"));
logger.child({ jobId: "j1" }).warn("bound");
logger.child({ jobId: "j1" }, { name: "worker", level: "debug" });

// @ts-expect-error the second argument is structured fields, not a message part
logger.info("connected to", "postgres");

// @ts-expect-error extra arguments are exactly what this contract removes
logger.trace("too", { many: true }, "arguments");

// @ts-expect-error `verbose` is not one of the six levels
logger.isLevelEnabled("verbose");

// @ts-expect-error bindings are required
logger.child();

// @ts-expect-error the threshold is read-only
logger.level = "debug";

// @ts-expect-error "verbose" is not a threshold
createLogger({ level: "verbose" });

/* --- implementing the contract by hand ---------------------------- */

const noop = () => {};
// Stands in for the child a real implementation would build, so the literals
// below are not self-referential (which would make them implicitly `any`).
declare const childLogger: Logger;

const _handWritten = {
  level: "info",
  bindings: {},
  isLevelEnabled: () => true,
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  log: noop,
  child: () => childLogger,
} satisfies Logger;

const _missingFatal = {
  level: "info",
  bindings: {},
  isLevelEnabled: () => true,
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  log: noop,
  child: () => childLogger,
  // @ts-expect-error `fatal` is missing
} satisfies Logger;

/* --- sinks --------------------------------------------------------- */

const sink: LogSink = (_event: LogEvent) => {
  type _level = Expect<Equal<typeof _event.level, LogLevel>>;
  type _msg = Expect<Equal<typeof _event.message, string>>;
  type _err = Expect<Equal<typeof _event.error, Error | undefined>>;
};

/* --- adapters accept the real libraries' shapes -------------------- */

// pino: object-first log methods, a string level, a child factory.
declare const pinoLogger: {
  trace: (obj: unknown, msg?: string, ...args: unknown[]) => void;
  debug: (obj: unknown, msg?: string, ...args: unknown[]) => void;
  info: (obj: unknown, msg?: string, ...args: unknown[]) => void;
  warn: (obj: unknown, msg?: string, ...args: unknown[]) => void;
  error: (obj: unknown, msg?: string, ...args: unknown[]) => void;
  fatal: (obj: unknown, msg?: string, ...args: unknown[]) => void;
  child: (bindings: Record<string, unknown>) => typeof pinoLogger;
  level: string;
  isLevelEnabled: (level: string) => boolean;
};
fromPino(pinoLogger);

// bunyan: same call shape, but `level` is a function.
declare const bunyanLogger: {
  trace: (...args: any[]) => void;
  debug: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  fatal: (...args: any[]) => void;
  child: (
    fields: Record<string, unknown>,
    simple?: boolean,
  ) => typeof bunyanLogger;
  level: {
    (): number;
    (value: number | string): void;
  };
};
fromBunyan(bunyanLogger);

// winston: level-first `log`, npm levels, transports.
declare const winstonLogger: {
  log: (level: string, message: string, ...meta: any[]) => typeof winstonLogger;
  error: (message: string, ...meta: any[]) => typeof winstonLogger;
  warn: (message: string, ...meta: any[]) => typeof winstonLogger;
  info: (message: string, ...meta: any[]) => typeof winstonLogger;
  verbose: (message: string, ...meta: any[]) => typeof winstonLogger;
  debug: (message: string, ...meta: any[]) => typeof winstonLogger;
  silly: (message: string, ...meta: any[]) => typeof winstonLogger;
  transports: unknown[];
  level: string;
  isLevelEnabled: (level: string) => boolean;
  child: (meta: Record<string, unknown>) => typeof winstonLogger;
};
fromWinston(winstonLogger);

// consola: message-first, numeric level, withTag.
declare const consolaLogger: {
  trace: (message: any, ...args: any[]) => void;
  debug: (message: any, ...args: any[]) => void;
  info: (message: any, ...args: any[]) => void;
  warn: (message: any, ...args: any[]) => void;
  error: (message: any, ...args: any[]) => void;
  fatal: (message: any, ...args: any[]) => void;
  withTag: (tag: string) => typeof consolaLogger;
  level: number;
};
fromConsola(consolaLogger);

// log4js: message-first, sticky context, uppercase level checks.
declare const log4jsLogger: {
  trace: (message: any, ...args: any[]) => void;
  debug: (message: any, ...args: any[]) => void;
  info: (message: any, ...args: any[]) => void;
  warn: (message: any, ...args: any[]) => void;
  error: (message: any, ...args: any[]) => void;
  fatal: (message: any, ...args: any[]) => void;
  addContext: (key: string, value: any) => void;
  isLevelEnabled: (otherLevel?: string) => boolean;
};
fromLog4js(log4jsLogger);

// tslog: log methods return the log object, sub-loggers via getSubLogger.
declare const tslogLogger: {
  trace: (...args: unknown[]) => unknown;
  debug: (...args: unknown[]) => unknown;
  info: (...args: unknown[]) => unknown;
  warn: (...args: unknown[]) => unknown;
  error: (...args: unknown[]) => unknown;
  fatal: (...args: unknown[]) => unknown;
  getSubLogger: (settings?: Record<string, unknown>) => typeof tslogLogger;
};
fromTslog(tslogLogger);

// NestJS LoggerService, including the optional methods.
declare const nestLogger: {
  log: (message: any, ...optionalParams: any[]) => void;
  error: (message: any, ...optionalParams: any[]) => void;
  warn: (message: any, ...optionalParams: any[]) => void;
  debug?: (message: any, ...optionalParams: any[]) => void;
  verbose?: (message: any, ...optionalParams: any[]) => void;
  fatal?: (message: any, ...optionalParams: any[]) => void;
};
fromNestLogger(nestLogger);

// The console, and anything shaped like the repo's previous Logger.
fromConsole(console);
fromConsole({ log: noop, warn: noop, error: noop });

/* --- LoggerLike is what every option accepts ----------------------- */

const _accepted: LoggerLike[] = [
  logger,
  sink,
  console,
  { log: noop, warn: noop, error: noop },
  pinoLogger,
  winstonLogger,
  consolaLogger,
  nestLogger,
];

// @ts-expect-error an arbitrary object is not a logger
const _rejected: LoggerLike = { nope: true };

/* --- resolveLogger always yields the contract ---------------------- */

type _resolved = Expect<Equal<ReturnType<typeof resolveLogger>, Logger>>;
type _test = Expect<
  Equal<
    ReturnType<typeof createTestLogger>,
    { logger: Logger; events: LogEvent[] }
  >
>;

export {};
