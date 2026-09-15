/**
 * Structured, type-safe logging.
 *
 * The repo's original `Logger` was console-shaped — three variadic
 * `(...unknown[])` methods — which types nothing, cannot carry structured
 * context, and offers no way to ask whether a level is even enabled before
 * paying to build a message. This module replaces it with a fixed contract:
 * six levels, `(message, fields?)` on every one of them, `child()` bindings,
 * and `isLevelEnabled()`.
 *
 * Nothing here depends on a logging library. Applications already run pino,
 * winston, consola, log4js, tslog, bunyan or NestJS's logger, so each has an
 * adapter built from its *structural* type — pass the instance, get a
 * {@link Logger}. {@link resolveLogger} detects the shape when you would
 * rather not name the adapter.
 *
 * Adapters wrap the library in a {@link LogSink} and reuse this module's
 * {@link Logger} implementation, so `child()`, level filtering and `Error`
 * handling behave identically no matter what is underneath. Bindings are
 * passed to the library in its structured slot (pino/bunyan's object
 * argument, winston's meta), which is where its own `child()` would put
 * them. Level filtering delegates to the library when it exposes
 * `isLevelEnabled`, and adapters default to passing everything through so
 * the library — not the wrapper — remains the authority on its own level.
 */

/** The levels, in ascending severity. */
export const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;

/** A single log level. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** A logger's threshold: a level, or `"silent"` to drop everything. */
export type LogLevelThreshold = LogLevel | "silent";

/** Structured context attached to a record or bound to a logger. */
export type LogFields = Record<string, unknown>;

/** Numeric severity per level, used for threshold comparisons. */
export const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** Severity of the `"silent"` threshold — above every real level. */
const SILENT_VALUE = Number.POSITIVE_INFINITY;

/** One record, as handed to a {@link LogSink}. */
export interface LogEvent {
  /** The level the record was logged at. */
  level: LogLevel;
  /** The message. When an `Error` was logged, its `message`. */
  message: string;
  /**
   * The `Error` behind the record: the logged value itself, or the `error`
   * property of the record's fields. Lifted out of {@link fields} so a sink
   * never has to hunt for it.
   */
  error?: Error;
  /** Fields passed at the call site. */
  fields: LogFields;
  /** Fields bound to the logger via {@link Logger.child}. */
  bindings: LogFields;
  /** When the record was created (`Date.now()`). */
  time: number;
  /** The logger's name, when it has one. */
  name?: string;
}

/** Where records go. Anything that writes a {@link LogEvent} somewhere. */
export type LogSink = (event: LogEvent) => void;

/**
 * The logging contract every package in this repo accepts.
 *
 * Each level takes a message (or an `Error`) plus optional structured
 * fields — never a variadic argument list, so a call site cannot silently
 * pass something a backend will drop.
 */
export interface Logger {
  /** The threshold below which records are dropped. */
  readonly level: LogLevelThreshold;
  /** Optional name, shown by sinks and carried into children. */
  readonly name?: string;
  /** Fields bound to this logger, included on every record. */
  readonly bindings: LogFields;
  /**
   * Whether a record at `level` would be emitted. Guard expensive message
   * building with it.
   */
  isLevelEnabled: (level: LogLevel) => boolean;
  /** Logs at `trace` — the most verbose level. */
  trace: (message: string | Error, fields?: LogFields) => void;
  /** Logs at `debug`. */
  debug: (message: string | Error, fields?: LogFields) => void;
  /** Logs at `info`. */
  info: (message: string | Error, fields?: LogFields) => void;
  /** Logs at `warn`. */
  warn: (message: string | Error, fields?: LogFields) => void;
  /** Logs at `error`. */
  error: (message: string | Error, fields?: LogFields) => void;
  /** Logs at `fatal` — the process is going down. */
  fatal: (message: string | Error, fields?: LogFields) => void;
  /**
   * Alias of {@link info}, kept so console-style `logger.log(...)` call sites
   * keep working against the structured signature.
   */
  log: (message: string | Error, fields?: LogFields) => void;
  /**
   * Derives a logger with extra bound fields (a request id, a job id), and
   * optionally its own name or threshold.
   */
  child: (
    bindings: LogFields,
    options?: { name?: string; level?: LogLevelThreshold },
  ) => Logger;
}

/** Options for {@link createLogger}. */
export interface CreateLoggerOptions {
  /** Threshold below which records are dropped. Defaults to `"info"`. */
  level?: LogLevelThreshold;
  /** Name shown by sinks and inherited by children. */
  name?: string;
  /** Fields included on every record. */
  bindings?: LogFields;
  /** Where records go. Defaults to {@link consoleSink}. */
  sink?: LogSink;
  /**
   * Extra predicate consulted alongside {@link level}, so an adapter can
   * delegate the decision to the library it wraps.
   */
  enabled?: (level: LogLevel) => boolean;
  /** Clock for {@link LogEvent.time}. Defaults to `Date.now`. */
  time?: () => number;
}

/** Threshold as a number, with `"silent"` mapped above every level. */
function thresholdValue(level: LogLevelThreshold): number {
  return level === "silent" ? SILENT_VALUE : LOG_LEVEL_VALUES[level];
}

/**
 * The single {@link Logger} implementation. Adapters differ only in their
 * sink, so level handling, `child()` and `Error` extraction stay identical
 * across every backend.
 */
class StructuredLogger implements Logger {
  /** Threshold below which records are dropped. */
  readonly level: LogLevelThreshold;
  /** Name shown by sinks and inherited by children. */
  readonly name?: string;
  /** Fields included on every record from this logger. */
  readonly bindings: LogFields;

  /** Where records go. */
  readonly #sink: LogSink;
  /** Clock for record timestamps. */
  readonly #time: () => number;
  /** Extra level predicate, used by adapters to delegate to their library. */
  readonly #enabled?: (level: LogLevel) => boolean;
  /** {@link level} as a number, compared against each record's severity. */
  readonly #threshold: number;

  constructor(options?: CreateLoggerOptions) {
    this.level = options?.level ?? "info";
    this.name = options?.name;
    this.bindings = options?.bindings ?? {};
    this.#sink = options?.sink ?? consoleSink();
    this.#time = options?.time ?? Date.now;
    this.#enabled = options?.enabled;
    this.#threshold = thresholdValue(this.level);
  }

  isLevelEnabled(level: LogLevel): boolean {
    if (LOG_LEVEL_VALUES[level] < this.#threshold) {
      return false;
    }
    return this.#enabled ? this.#enabled(level) : true;
  }

  trace(message: string | Error, fields?: LogFields): void {
    this.#write("trace", message, fields);
  }

  debug(message: string | Error, fields?: LogFields): void {
    this.#write("debug", message, fields);
  }

  info(message: string | Error, fields?: LogFields): void {
    this.#write("info", message, fields);
  }

  warn(message: string | Error, fields?: LogFields): void {
    this.#write("warn", message, fields);
  }

  error(message: string | Error, fields?: LogFields): void {
    this.#write("error", message, fields);
  }

  fatal(message: string | Error, fields?: LogFields): void {
    this.#write("fatal", message, fields);
  }

  log(message: string | Error, fields?: LogFields): void {
    this.#write("info", message, fields);
  }

  child(
    bindings: LogFields,
    options?: { name?: string; level?: LogLevelThreshold },
  ): Logger {
    return new StructuredLogger({
      level: options?.level ?? this.level,
      name: options?.name ?? this.name,
      bindings: { ...this.bindings, ...bindings },
      sink: this.#sink,
      enabled: this.#enabled,
      time: this.#time,
    });
  }

  /** Builds the event and hands it to the sink, if the level passes. */
  #write(level: LogLevel, message: string | Error, fields?: LogFields): void {
    if (!this.isLevelEnabled(level)) {
      return;
    }

    this.#sink(
      buildEvent(
        level,
        message,
        fields,
        this.bindings,
        this.name,
        this.#time(),
      ),
    );
  }
}

/**
 * Normalises a call into a {@link LogEvent}.
 *
 * An `Error` logged as the message becomes `message` + `error`; an `Error`
 * passed as `fields.error` is lifted out of the fields the same way, so a
 * sink has exactly one place to look.
 */
function buildEvent(
  level: LogLevel,
  message: string | Error,
  fields: LogFields | undefined,
  bindings: LogFields,
  name: string | undefined,
  time: number,
): LogEvent {
  const event: LogEvent = {
    level,
    message: "",
    fields: fields ? { ...fields } : {},
    bindings,
    time,
  };

  if (name !== undefined) {
    event.name = name;
  }

  if (message instanceof Error) {
    event.message = message.message;
    event.error = message;
  } else {
    event.message = message;
  }

  const candidate = event.fields.error;
  if (candidate instanceof Error) {
    event.error ??= candidate;
    delete event.fields.error;
  }

  return event;
}

/** Creates a logger writing to `sink` (the console by default). */
export function createLogger(options?: CreateLoggerOptions): Logger {
  return new StructuredLogger(options);
}

/** A logger that drops everything. Cheaper than a sink that ignores records. */
export const noopLogger: Logger = createLogger({
  level: "silent",
  sink: () => {},
});

/**
 * A logger that records into an array — the shape tests want.
 *
 * ```ts
 * const { logger, events } = createTestLogger();
 * subject.run(logger);
 * expect(events.at(-1)?.level).toBe("error");
 * ```
 */
export function createTestLogger(options?: {
  /** Threshold; defaults to `"trace"` so assertions see everything. */
  level?: LogLevelThreshold;
  /** Name for the logger. */
  name?: string;
  /** Fields bound to the logger. */
  bindings?: LogFields;
}): { logger: Logger; events: LogEvent[] } {
  const events: LogEvent[] = [];
  const logger = createLogger({
    level: options?.level ?? "trace",
    name: options?.name,
    bindings: options?.bindings,
    sink: collectSink(events),
  });
  return { logger, events };
}

/* ------------------------------------------------------------------ *
 * Sinks
 * ------------------------------------------------------------------ */

/** The console methods a sink may use. Also the shape of the old `Logger`. */
export interface ConsoleLike {
  /** Writes an informational record. */
  log: (...args: any[]) => void;
  /** Writes a warning record. */
  warn: (...args: any[]) => void;
  /** Writes an error record. */
  error: (...args: any[]) => void;
  /** Writes an informational record, when the target has one. */
  info?: (...args: any[]) => void;
  /** Writes a debug record, when the target has one. */
  debug?: (...args: any[]) => void;
  /**
   * Writes a trace record, when the target has one; otherwise trace records
   * fall back to {@link debug}, then {@link log}. Note the global
   * `console.trace` also prints a stack trace.
   */
  trace?: (...args: any[]) => void;
}

/** Merges a record's bindings and fields into one object for a backend. */
export function mergeLogFields(event: LogEvent): LogFields {
  return { ...event.bindings, ...event.fields };
}

/** Options for {@link consoleSink}. */
export interface ConsoleSinkOptions {
  /** Target to write to. Defaults to the global `console`. */
  console?: ConsoleLike;
  /**
   * `"pretty"` writes a human line plus the fields/error as objects;
   * `"json"` writes one JSON string per record. Defaults to `"pretty"`.
   *
   * In JSON the record's own keys win: a binding or field named `level`,
   * `time` or `msg` — or `name`/`err` when the record has a name/error — is
   * dropped rather than allowed to overwrite them.
   */
  format?: "pretty" | "json";
}

/** Keys a JSON record always owns; same-named fields never replace them. */
const JSON_RECORD_KEYS = new Set(["level", "time", "msg"]);

/** One record as {@link consoleSink} writes it in `"json"` format. */
interface JsonLogRecord {
  /** The record's level. */
  level: LogLevel;
  /** When the record was created, as an ISO-8601 string. */
  time: string;
  /** The message. */
  msg: string;
  /** The logger's name, when it has one. */
  name?: string;
  /** The record's error, reduced to what `JSON.stringify` can carry. */
  err?: {
    /** The error's `name`. */
    name: string;
    /** The error's `message`. */
    message: string;
    /** The error's `stack`, when it has one. */
    stack?: string;
  };
  /** Bindings and fields, minus the keys above. Values are arbitrary. */
  [field: string]: unknown;
}

/** Picks the console method that best matches a level. */
function consoleMethodFor(
  target: ConsoleLike,
  level: LogLevel,
): (...args: any[]) => void {
  switch (level) {
    case "trace":
      return (target.trace ?? target.debug ?? target.log).bind(target);
    case "debug":
      return (target.debug ?? target.log).bind(target);
    case "info":
      return (target.info ?? target.log).bind(target);
    case "warn":
      return target.warn.bind(target);
    default:
      return target.error.bind(target);
  }
}

/** Writes records to a console, human-readably or as JSON. */
export function consoleSink(options?: ConsoleSinkOptions): LogSink {
  const target = options?.console ?? console;
  const format = options?.format ?? "pretty";

  return (event) => {
    const write = consoleMethodFor(target, event.level);

    if (format === "json") {
      const record: JsonLogRecord = {
        level: event.level,
        time: new Date(event.time).toISOString(),
        msg: event.message,
      };
      for (const [key, value] of Object.entries(mergeLogFields(event))) {
        if (!JSON_RECORD_KEYS.has(key)) {
          record[key] = value;
        }
      }
      if (event.name !== undefined) {
        record.name = event.name;
      }
      if (event.error) {
        record.err = {
          name: event.error.name,
          message: event.error.message,
          stack: event.error.stack,
        };
      }
      write(JSON.stringify(record));
      return;
    }

    const label = event.level.toUpperCase().padEnd(5, " ");
    const prefix = event.name ? `[${event.name}] ` : "";
    const line = `${new Date(event.time).toISOString()} ${label} ${prefix}${event.message}`;

    write(line, ...extraArgs(event));
  };
}

/**
 * Fans every record out to several sinks, in order. A sink that throws
 * propagates — sinks are expected not to.
 */
export function multiSink(...sinks: LogSink[]): LogSink {
  return (event) => {
    for (const sink of sinks) {
      sink(event);
    }
  };
}

/** Pushes every record into `events` — the sink behind {@link createTestLogger}. */
export function collectSink(events: LogEvent[]): LogSink {
  return (event) => {
    events.push(event);
  };
}

/* ------------------------------------------------------------------ *
 * Adapters for existing loggers
 *
 * Each input type is *structural* — the shape the library's instance
 * already has — so nothing here imports (or depends on) pino, winston,
 * consola, log4js, tslog, bunyan or NestJS.
 * ------------------------------------------------------------------ */

/** A library's own log method. They are variadic; ours are not. */
type AnyLogFn = (...args: any[]) => void;

/** A library method whose signature is not worth pinning down. */
type AnyFn = (...args: any[]) => any;

/** Options shared by every adapter. */
export interface AdapterOptions {
  /**
   * Threshold applied *before* the library's own. Defaults to `"trace"`, so
   * the wrapped logger stays the authority on what it drops; set it to gate
   * records earlier.
   */
  level?: LogLevelThreshold;
  /** Name for the adapted logger. */
  name?: string;
  /** Fields bound to the adapted logger. */
  bindings?: LogFields;
}

/** Turns {@link AdapterOptions} into {@link CreateLoggerOptions} defaults. */
function adapterBase(options?: AdapterOptions): CreateLoggerOptions {
  return {
    level: options?.level ?? "trace",
    name: options?.name,
    bindings: options?.bindings,
  };
}

/**
 * A record's fields as one object, with any `Error` under `err` — the key
 * pino and bunyan serialise specially.
 */
function fieldsWithErr(event: LogEvent): LogFields {
  const fields = mergeLogFields(event);
  if (event.error) {
    fields.err = event.error;
  }
  return fields;
}

/** A record's fields and error as trailing arguments, omitting empty ones. */
function extraArgs(event: LogEvent): (LogFields | Error)[] {
  const fields = mergeLogFields(event);
  const extras: (LogFields | Error)[] = [];
  if (Object.keys(fields).length > 0) {
    extras.push(fields);
  }
  if (event.error) {
    extras.push(event.error);
  }
  return extras;
}

/** A pino logger, structurally. */
export interface PinoLike {
  /** Logs at pino's `trace`. */
  trace: AnyLogFn;
  /** Logs at pino's `debug`. */
  debug: AnyLogFn;
  /** Logs at pino's `info`. */
  info: AnyLogFn;
  /** Logs at pino's `warn`. */
  warn: AnyLogFn;
  /** Logs at pino's `error`. */
  error: AnyLogFn;
  /** Logs at pino's `fatal`. */
  fatal: AnyLogFn;
  /**
   * Derives a child logger. Present on pino, used here to recognise it. Never
   * called, so its result is `unknown`: any return type is accepted.
   */
  child: (bindings: LogFields, options?: any) => unknown;
  /** pino's current level, as a string. */
  level?: string;
  /** pino's own level check, delegated to when present. */
  isLevelEnabled?: (level: string) => boolean;
}

/**
 * Adapts a pino logger. Levels map one-to-one; fields go in pino's object
 * argument and an `Error` under `err`, so pino's serialisers apply as usual.
 */
export function fromPino(logger: PinoLike, options?: AdapterOptions): Logger {
  const isLevelEnabled = logger.isLevelEnabled;

  return createLogger({
    ...adapterBase(options),
    enabled:
      typeof isLevelEnabled === "function"
        ? (level) => isLevelEnabled.call(logger, level)
        : undefined,
    sink: (event) => {
      const write = logger[event.level] ?? logger.info;
      write.call(logger, fieldsWithErr(event), event.message);
    },
  });
}

/** A bunyan logger, structurally. */
export interface BunyanLike {
  /** Logs at bunyan's `trace`. */
  trace: AnyLogFn;
  /** Logs at bunyan's `debug`. */
  debug: AnyLogFn;
  /** Logs at bunyan's `info`. */
  info: AnyLogFn;
  /** Logs at bunyan's `warn`. */
  warn: AnyLogFn;
  /** Logs at bunyan's `error`. */
  error: AnyLogFn;
  /** Logs at bunyan's `fatal`. */
  fatal: AnyLogFn;
  /** Derives a child logger. Only probed for, so its result is `unknown`. */
  child: (fields: LogFields, simple?: boolean) => unknown;
  /** bunyan exposes its level as a *function* — how it is told from pino. */
  level: AnyFn;
}

/**
 * Adapts a bunyan logger. bunyan's numeric levels match this module's
 * (`trace` 10 … `fatal` 60), so its threshold is honoured directly.
 */
export function fromBunyan(
  logger: BunyanLike,
  options?: AdapterOptions,
): Logger {
  return createLogger({
    ...adapterBase(options),
    enabled: (level) => {
      const current = Number(logger.level());
      return Number.isFinite(current)
        ? LOG_LEVEL_VALUES[level] >= current
        : true;
    },
    sink: (event) => {
      const write = logger[event.level] ?? logger.info;
      write.call(logger, fieldsWithErr(event), event.message);
    },
  });
}

/** A winston logger, structurally. */
export interface WinstonLike {
  /** winston's level-first entry point: `log(level, message, meta)`. */
  log: AnyLogFn;
  /** Logs at winston's `error`. */
  error: AnyLogFn;
  /** Logs at winston's `warn`. */
  warn: AnyLogFn;
  /** Logs at winston's `info`. */
  info: AnyLogFn;
  /** Logs at winston's `debug`, when the level set includes it. */
  debug?: AnyLogFn;
  /** Logs at winston's `verbose`, when the level set includes it. */
  verbose?: AnyLogFn;
  /** Logs at winston's `silly`, when the level set includes it. */
  silly?: AnyLogFn;
  /**
   * The configured transports. A real winston logger always has this array,
   * which is what tells it apart from pino (when custom levels add `trace`
   * and `fatal`) and from tslog (which also has `log` and `silly`).
   */
  transports?: unknown[];
  /** winston's current level. */
  level?: string;
  /**
   * The level set (`{ name: priority }`). When it contains `trace` or
   * `fatal`, those are used directly instead of the npm-set fallbacks.
   */
  levels?: Record<string, number>;
  /** winston's own level check, delegated to when present. */
  isLevelEnabled?: (level: string) => boolean;
}

/**
 * winston level for each of ours. It has no `trace` or `fatal` in its default
 * (npm) set, so `trace` becomes `silly` and `fatal` becomes `error`.
 */
const WINSTON_LEVELS: Record<LogLevel, string> = {
  trace: "silly",
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
  fatal: "error",
};

/**
 * The winston level a record goes out at: our own name when the logger's
 * level set defines it, else the npm-set mapping in {@link WINSTON_LEVELS}.
 */
function winstonLevelFor(logger: WinstonLike, level: LogLevel): string {
  const levels = logger.levels;
  if (
    (level === "trace" || level === "fatal") &&
    typeof levels === "object" &&
    levels !== null &&
    Object.hasOwn(levels, level)
  ) {
    return level;
  }
  return WINSTON_LEVELS[level];
}

/**
 * Adapts a winston logger through its `log(level, message, meta)` entry
 * point. With the default npm levels `trace` goes out as `silly` and `fatal`
 * as `error` (flagged `fatal: true` in the meta); a custom level set that
 * defines `trace`/`fatal` receives them under their own names.
 */
export function fromWinston(
  logger: WinstonLike,
  options?: AdapterOptions,
): Logger {
  const isLevelEnabled = logger.isLevelEnabled;

  return createLogger({
    ...adapterBase(options),
    enabled:
      typeof isLevelEnabled === "function"
        ? (level) => isLevelEnabled.call(logger, winstonLevelFor(logger, level))
        : undefined,
    sink: (event) => {
      const meta = mergeLogFields(event);
      if (event.error) {
        meta.error = event.error;
      }
      const level = winstonLevelFor(logger, event.level);
      if (event.level === "fatal" && level !== "fatal") {
        // This level set cannot represent `fatal`; keep the distinction.
        meta.fatal = true;
      }
      logger.log(level, event.message, meta);
    },
  });
}

/** A consola instance, structurally. */
export interface ConsolaLike {
  /** Logs at consola's `trace`. */
  trace: AnyLogFn;
  /** Logs at consola's `debug`. */
  debug: AnyLogFn;
  /** Logs at consola's `info`. */
  info: AnyLogFn;
  /** Logs at consola's `warn`. */
  warn: AnyLogFn;
  /** Logs at consola's `error`. */
  error: AnyLogFn;
  /** Logs at consola's `fatal`, when present. */
  fatal?: AnyLogFn;
  /** Derives a tagged instance — how consola is recognised. */
  withTag: (tag: string) => unknown;
  /** consola's numeric verbosity. */
  level?: number;
}

/** The consola verbosity each of our levels needs to be visible at. */
const CONSOLA_LEVELS: Record<LogLevel, number> = {
  fatal: 0,
  error: 0,
  warn: 1,
  info: 3,
  debug: 4,
  trace: 5,
};

/** Adapts a consola instance, honouring its numeric verbosity. */
export function fromConsola(
  logger: ConsolaLike,
  options?: AdapterOptions,
): Logger {
  return createLogger({
    ...adapterBase(options),
    enabled: (level) =>
      typeof logger.level === "number"
        ? logger.level >= CONSOLA_LEVELS[level]
        : true,
    sink: (event) => {
      const write =
        event.level === "fatal"
          ? (logger.fatal ?? logger.error)
          : logger[event.level];
      write.call(logger, event.message, ...extraArgs(event));
    },
  });
}

/** A log4js logger, structurally. */
export interface Log4jsLike {
  /** Logs at log4js's `TRACE`. */
  trace: AnyLogFn;
  /** Logs at log4js's `DEBUG`. */
  debug: AnyLogFn;
  /** Logs at log4js's `INFO`. */
  info: AnyLogFn;
  /** Logs at log4js's `WARN`. */
  warn: AnyLogFn;
  /** Logs at log4js's `ERROR`. */
  error: AnyLogFn;
  /** Logs at log4js's `FATAL`. */
  fatal: AnyLogFn;
  /** Adds sticky context — how log4js is recognised. */
  addContext: (key: string, value: any) => void;
  /** log4js's own level check, delegated to when present. */
  isLevelEnabled?: (level?: string) => boolean;
}

/**
 * Adapts a log4js logger. Its `addContext` is sticky per logger rather than
 * per child, so bindings ride along as a trailing object instead.
 */
export function fromLog4js(
  logger: Log4jsLike,
  options?: AdapterOptions,
): Logger {
  const isLevelEnabled = logger.isLevelEnabled;

  return createLogger({
    ...adapterBase(options),
    enabled:
      typeof isLevelEnabled === "function"
        ? (level) => isLevelEnabled.call(logger, level.toUpperCase())
        : undefined,
    sink: (event) => {
      const write = logger[event.level] ?? logger.info;
      write.call(logger, event.message, ...extraArgs(event));
    },
  });
}

/**
 * A tslog logger, structurally. tslog v4 also has `silly` and a
 * `log(levelId, levelName, ...args)` method; neither is used here, and
 * `getSubLogger` is what distinguishes it from winston.
 */
export interface TslogLike {
  /** Logs at tslog's `trace`. */
  trace: AnyLogFn;
  /** Logs at tslog's `debug`. */
  debug: AnyLogFn;
  /** Logs at tslog's `info`. */
  info: AnyLogFn;
  /** Logs at tslog's `warn`. */
  warn: AnyLogFn;
  /** Logs at tslog's `error`. */
  error: AnyLogFn;
  /** Logs at tslog's `fatal`. */
  fatal: AnyLogFn;
  /** Derives a sub-logger — how tslog is recognised. */
  getSubLogger: (settings?: Record<string, unknown>) => unknown;
}

/** Adapts a tslog logger; levels map one-to-one. */
export function fromTslog(logger: TslogLike, options?: AdapterOptions): Logger {
  return createLogger({
    ...adapterBase(options),
    sink: (event) => {
      const write = logger[event.level] ?? logger.info;
      write.call(logger, event.message, ...extraArgs(event));
    },
  });
}

/** A NestJS `LoggerService`, structurally. */
export interface NestLoggerLike {
  /** Nest's informational level. */
  log: AnyLogFn;
  /** Nest's error level: `error(message, stack?, context?)`. */
  error: AnyLogFn;
  /** Nest's warning level. */
  warn: AnyLogFn;
  /** Nest's debug level, when enabled. */
  debug?: AnyLogFn;
  /** Nest's most verbose level — how a Nest logger is recognised. */
  verbose?: AnyLogFn;
  /** Nest 10+'s fatal level, when present. */
  fatal?: AnyLogFn;
}

/** Picks the Nest method for a level, falling back through what exists. */
function nestMethodFor(logger: NestLoggerLike, level: LogLevel): AnyLogFn {
  switch (level) {
    case "trace":
      return logger.verbose ?? logger.debug ?? logger.log;
    case "debug":
      return logger.debug ?? logger.log;
    case "warn":
      return logger.warn;
    case "error":
      return logger.error;
    case "fatal":
      return logger.fatal ?? logger.error;
    default:
      return logger.log;
  }
}

/**
 * Adapts a NestJS logger. `info` maps to Nest's `log` and `trace` to its
 * `verbose`; the logger's name is passed as Nest's trailing context string,
 * and an `Error`'s stack goes in the `stack` position of `error`.
 */
export function fromNestLogger(
  logger: NestLoggerLike,
  options?: AdapterOptions,
): Logger {
  return createLogger({
    ...adapterBase(options),
    sink: (event) => {
      const fields = mergeLogFields(event);
      // Nest's optional params: a stack or error, the fields, the context name.
      const params: (string | Error | LogFields)[] = [];

      if (event.level === "error" || event.level === "fatal") {
        if (event.error?.stack) {
          params.push(event.error.stack);
        }
      } else if (event.error) {
        params.push(event.error);
      }

      if (Object.keys(fields).length > 0) {
        params.push(fields);
      }
      if (event.name !== undefined) {
        params.push(event.name);
      }

      nestMethodFor(logger, event.level).call(logger, event.message, ...params);
    },
  });
}

/**
 * Adapts a console-like object — including anything that satisfied this
 * repo's previous `{ log, error, warn }` logger type.
 */
export function fromConsole(
  target: ConsoleLike,
  options?: AdapterOptions & {
    /** Record format, as in {@link consoleSink}. Defaults to `"pretty"`. */
    format?: "pretty" | "json";
  },
): Logger {
  return createLogger({
    ...adapterBase(options),
    sink: consoleSink({ console: target, format: options?.format }),
  });
}

/* ------------------------------------------------------------------ *
 * Detection
 * ------------------------------------------------------------------ */

/**
 * Anything accepted where a logger is asked for: a {@link Logger}, a bare
 * {@link LogSink}, or an instance of a supported logging library.
 */
export type LoggerLike =
  | Logger
  | LogSink
  | PinoLike
  | BunyanLike
  | WinstonLike
  | ConsolaLike
  | Log4jsLike
  | TslogLike
  | NestLoggerLike
  | ConsoleLike;

/**
 * True when `value` already implements {@link Logger}.
 *
 * Checks the members that set the contract apart from the libraries it
 * adapts, not just the level methods: a pino instance also has `child`,
 * `isLevelEnabled` and all six levels, but its `bindings` is a *method*, it
 * has no `log`, and its methods take `(fields, message)` — so accepting it
 * here would call it with the arguments reversed.
 */
export function isLogger(value: unknown): value is Logger {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.bindings === "object" &&
    candidate.bindings !== null &&
    typeof candidate.level === "string" &&
    hasMethods(candidate, [
      "child",
      "isLevelEnabled",
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
      "log",
    ])
  );
}

/** True when every named property of `value` is a function. */
function hasMethods(value: Record<string, unknown>, names: string[]): boolean {
  return names.every((name) => typeof value[name] === "function");
}

/**
 * Normalises any supported logger into a {@link Logger}.
 *
 * A {@link Logger} is returned untouched. Otherwise the shape is detected in
 * a fixed order — pino, bunyan, winston, consola, log4js, tslog, NestJS,
 * console-like — and wrapped with the matching adapter. The markers:
 *
 * - winston: `log` plus a `transports` array (or `log` + `silly` with no
 *   `getSubLogger`). Checked ahead of pino's test, so a winston logger whose
 *   custom levels include `trace`/`fatal` is not mistaken for pino.
 * - pino: the six levels, `child`, and a string `level` or `isLevelEnabled`.
 * - bunyan: the six levels, `child`, and a `level` *function*.
 * - consola: `withTag`. log4js: `addContext`. tslog: `getSubLogger` (tslog v4
 *   also has `log` and `silly`, which is why winston's marker excludes it).
 * - NestJS: `log`/`warn`/`error` plus `verbose`. Console: `log`/`warn`/`error`.
 *
 * Call the adapter directly when you would rather not rely on detection.
 *
 * With no input, `fallback` is returned when given, else a default console
 * logger.
 *
 * The overloads keep what is known: a {@link Logger} (or a subtype of one)
 * comes back as its own type, and so does the `fallback` when the input is
 * absent.
 */
export function resolveLogger<L extends Logger>(input: L, fallback?: Logger): L;
export function resolveLogger<F extends Logger>(
  input: undefined | null,
  fallback: F,
): F;
export function resolveLogger(
  input?: LoggerLike | null,
  fallback?: Logger,
): Logger;
export function resolveLogger(
  input?: LoggerLike | null,
  fallback?: Logger,
): Logger {
  if (input === undefined || input === null) {
    return fallback ?? createLogger();
  }

  if (isLogger(input)) {
    return input;
  }

  if (typeof input === "function") {
    return createLogger({ level: "trace", sink: input });
  }

  const candidate = input as unknown as Record<string, unknown>;
  const levelled = hasMethods(candidate, [
    "trace",
    "debug",
    "info",
    "warn",
    "error",
    "fatal",
  ]);

  // Computed first because both pino's and tslog's shapes overlap it: a
  // winston logger with custom `trace`/`fatal` levels has everything pino's
  // test looks for, and tslog v4 has `log` and `silly`.
  const winstonShaped =
    typeof candidate.log === "function" &&
    (Array.isArray(candidate.transports) ||
      (typeof candidate.silly === "function" &&
        typeof candidate.getSubLogger !== "function"));

  if (
    levelled &&
    !winstonShaped &&
    typeof candidate.child === "function" &&
    (typeof candidate.level === "string" ||
      typeof candidate.isLevelEnabled === "function")
  ) {
    return fromPino(input as PinoLike);
  }

  if (
    levelled &&
    typeof candidate.child === "function" &&
    typeof candidate.level === "function"
  ) {
    return fromBunyan(input as BunyanLike);
  }

  if (winstonShaped) {
    return fromWinston(input as WinstonLike);
  }

  if (typeof candidate.withTag === "function") {
    return fromConsola(input as ConsolaLike);
  }

  if (levelled && typeof candidate.addContext === "function") {
    return fromLog4js(input as Log4jsLike);
  }

  if (levelled && typeof candidate.getSubLogger === "function") {
    return fromTslog(input as TslogLike);
  }

  if (
    hasMethods(candidate, ["log", "warn", "error"]) &&
    typeof candidate.verbose === "function"
  ) {
    return fromNestLogger(input as NestLoggerLike);
  }

  if (hasMethods(candidate, ["log", "warn", "error"])) {
    return fromConsole(input as ConsoleLike);
  }

  throw new TypeError(
    "Unrecognised logger. Pass a Logger, a LogSink function, a console-like object, or a pino/bunyan/winston/consola/log4js/tslog/NestJS logger — or wrap yours with createLogger({ sink }).",
  );
}
