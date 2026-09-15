/**
 * Option tour: logging — every `CreateLoggerOptions` field, every `Logger`
 * method, every sink, every adapter and `AdapterOptions` field, detection
 * order, and the router and adapter `logger` options, each asserted.
 *
 * ```bash
 * bun 12-options/logging-options.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - `level` and `enabled` are both consulted: a record is written only when
 *   the threshold *and* the predicate allow it.
 * - A child inherits the sink, `enabled` and clock, and can change its name
 *   and threshold — in either direction.
 * - An `Error` given as the message *or* as `fields.error` ends up on
 *   `LogEvent.error`, and is removed from the fields.
 * - Adapters default to threshold `trace`, and a bare sink function passed to
 *   `resolveLogger` is also given `trace`: the library stays the authority.
 */
import type {
  ConsoleLike,
  JsonValue,
  LogEvent,
  LogFields,
  LoggerLike,
  LogLevel,
} from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunRouter,
  collectSink,
  consoleSink,
  createLogger,
  createTestLogger,
  fromBunyan,
  fromConsola,
  fromConsole,
  fromLog4js,
  fromNestLogger,
  fromPino,
  fromTslog,
  fromWinston,
  isLogger,
  LOG_LEVEL_VALUES,
  LOG_LEVELS,
  mergeLogFields,
  multiSink,
  noopLogger,
  resolveLogger,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title } from "../shared/console";

/** One call a fake received. */
interface Call {
  /** The method called. */
  method: string;
  /** The arguments, exactly as received; the fakes accept anything, as the libraries do. */
  args: unknown[];
}

/** A call log, and a factory for methods that record into it. */
function recorder() {
  const calls: Call[] = [];
  const method = (name: string) => {
    return (...args: unknown[]) => {
      calls.push({ method: name, args });
    };
  };
  return { calls, method };
}

/** The six level methods of a levelled library, recording through `method`. */
function levelMethods(method: (name: string) => (...args: unknown[]) => void) {
  return {
    trace: method("trace"),
    debug: method("debug"),
    info: method("info"),
    warn: method("warn"),
    error: method("error"),
    fatal: method("fatal"),
  };
}

/** A console that records; `full` adds the optional info/debug/trace methods. */
function fakeConsole(full: boolean): { target: ConsoleLike; calls: Call[] } {
  const { calls, method } = recorder();
  const target: ConsoleLike = {
    log: method("log"),
    warn: method("warn"),
    error: method("error"),
  };
  if (full) {
    target.info = method("info");
    target.debug = method("debug");
    target.trace = method("trace");
  }
  return { target, calls };
}

title("Option tour: logging");

const failure = new Error("db down");

/* ------------------------------------------------------------------ */
step("LOG_LEVELS and LOG_LEVEL_VALUES");

checkEqual(
  "six levels, in ascending severity",
  [...LOG_LEVELS],
  ["trace", "debug", "info", "warn", "error", "fatal"],
);
checkEqual("numeric severities, 10 to 60", LOG_LEVEL_VALUES, {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
});

/* ------------------------------------------------------------------ */
step("CreateLoggerOptions — defaults");

const bare = createLogger({ sink: () => {} });
checkEqual("level defaults to info", bare.level, "info");
checkEqual("name defaults to undefined", bare.name, undefined);
checkEqual("bindings default to {}", bare.bindings, {});

{
  // `sink` defaults to consoleSink() on the global console.
  const printed: unknown[][] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    printed.push(args);
  };
  try {
    createLogger().info("to the global console");
  } finally {
    console.info = originalInfo;
  }
  check(
    "sink defaults to a pretty consoleSink on the global console",
    printed.length === 1 &&
      /INFO {2}to the global console$/.test(String(printed[0]?.[0])),
    printed,
  );
}

{
  const events: LogEvent[] = [];
  const before = Date.now();
  createLogger({ sink: collectSink(events) }).info("now");
  const time = events[0]?.time ?? 0;
  check(
    "time defaults to Date.now",
    time >= before && time <= Date.now(),
    time,
  );
}

/* ------------------------------------------------------------------ */
step("CreateLoggerOptions — each field");

{
  const { logger, events } = createTestLogger({ level: "warn" });
  for (const level of LOG_LEVELS) {
    logger[level](level);
  }
  checkEqual(
    "level: records below the threshold are dropped",
    events.map((event) => event.level),
    ["warn", "error", "fatal"],
  );
}

{
  const events: LogEvent[] = [];
  const logger = createLogger({
    level: "trace",
    name: "billing",
    bindings: { service: "billing" },
    sink: collectSink(events),
    time: () => 1234,
  });
  logger.info("hello", { id: 1 });
  checkEqual("name, bindings, sink and time all reach the event", events[0], {
    level: "info",
    message: "hello",
    fields: { id: 1 },
    bindings: { service: "billing" },
    time: 1234,
    name: "billing",
  });
}

{
  const events: LogEvent[] = [];
  const asked: LogLevel[] = [];
  const logger = createLogger({
    level: "info",
    sink: collectSink(events),
    enabled: (level) => {
      asked.push(level);
      return level !== "warn";
    },
  });
  logger.debug("below the threshold");
  logger.info("allowed by both");
  logger.warn("refused by enabled");
  checkEqual(
    "enabled: consulted alongside level — both must allow",
    events.map((event) => event.message),
    ["allowed by both"],
  );
  checkEqual(
    "enabled is not asked about levels the threshold already dropped",
    asked,
    ["info", "warn"],
  );
  checkEqual(
    "isLevelEnabled reflects the threshold and enabled",
    [
      logger.isLevelEnabled("debug"),
      logger.isLevelEnabled("info"),
      logger.isLevelEnabled("warn"),
    ],
    [false, true, false],
  );
}

{
  const events: LogEvent[] = [];
  const logger = createLogger({ level: "silent", sink: collectSink(events) });
  logger.fatal("nothing");
  checkEqual("level silent: drops every record", events.length, 0);
  checkEqual(
    "level silent: isLevelEnabled is false for fatal",
    logger.isLevelEnabled("fatal"),
    false,
  );
}

/* ------------------------------------------------------------------ */
step("Logger — methods");

{
  const { logger, events } = createTestLogger();
  for (const level of LOG_LEVELS) {
    logger[level](`at ${level}`);
  }
  logger.log("via log");
  checkEqual(
    "each level method records at its level; log records at info",
    events.map((event) => event.level),
    [...LOG_LEVELS, "info"],
  );
  check(
    "an event without a name has no name key",
    events.every((event) => !("name" in event)),
  );
}

{
  const { logger, events } = createTestLogger({
    level: "info",
    name: "root",
    bindings: { app: "api", region: "eu" },
  });
  const child = logger.child({ requestId: "r1", region: "us" });
  const grandchild = child.child({ requestId: "r2", jobId: "j1" });
  grandchild.info("deep");
  logger.info("parent");

  checkEqual(
    "child: bindings merge over the parent's, latest winning",
    events[0]?.bindings,
    { app: "api", region: "us", requestId: "r2", jobId: "j1" },
  );
  checkEqual("child: the parent is untouched", events[1]?.bindings, {
    app: "api",
    region: "eu",
  });
  checkEqual(
    "child: name and level are inherited",
    [child.name, child.level],
    ["root", "info"],
  );
  checkEqual("child: bindings property", child.bindings, {
    app: "api",
    region: "us",
    requestId: "r1",
  });

  const stricter = logger.child({}, { name: "worker", level: "error" });
  stricter.warn("dropped");
  stricter.error("kept");
  checkEqual(
    "child options: name and a stricter level",
    events.slice(2).map((event) => [event.level, event.name]),
    [["error", "worker"]],
  );

  const looser = logger.child({}, { level: "debug" });
  looser.debug("kept by the child");
  checkEqual(
    "child options: a looser level than the parent's",
    events.at(-1)?.message,
    "kept by the child",
  );
}

{
  const events: LogEvent[] = [];
  const logger = createLogger({
    level: "trace",
    sink: collectSink(events),
    enabled: (level) => level !== "debug",
    time: () => 99,
  });
  const child = logger.child({ c: 1 });
  child.debug("still refused by the inherited enabled");
  child.info("recorded with the inherited clock");
  checkEqual(
    "child: inherits the sink, enabled and time",
    events.map((event) => [event.message, event.time]),
    [["recorded with the inherited clock", 99]],
  );
}

/* ------------------------------------------------------------------ */
step("Logger — errors");

{
  const { logger, events } = createTestLogger();

  logger.error(failure);
  checkEqual(
    "an Error as the message: message is its message",
    events[0]?.message,
    "db down",
  );
  check("…and it is LogEvent.error", events[0]?.error === failure);

  const fields = { error: failure, attempt: 2 };
  logger.error("could not connect", fields);
  check(
    "an Error in fields.error is lifted onto LogEvent.error",
    events[1]?.error === failure,
  );
  checkEqual("…and removed from the fields", events[1]?.fields, { attempt: 2 });
  checkEqual("the caller's fields object is not changed", Object.keys(fields), [
    "error",
    "attempt",
  ]);

  const other = new Error("second");
  logger.error(failure, { error: other });
  check(
    "with both, the message's Error wins and fields.error is still removed",
    events[2]?.error === failure && !("error" in (events[2]?.fields ?? {})),
  );

  logger.warn("not an error", { error: "timeout" });
  checkEqual("a non-Error fields.error stays a field", events[3]?.fields, {
    error: "timeout",
  });
  checkEqual("…and LogEvent.error is absent", events[3]?.error, undefined);
}

/* ------------------------------------------------------------------ */
step("consoleSink");

{
  const { target, calls } = fakeConsole(true);
  const logger = createLogger({
    level: "trace",
    name: "api",
    sink: consoleSink({ console: target }),
    time: () => Date.parse("2026-01-01T00:00:00.000Z"),
  });
  for (const level of LOG_LEVELS) {
    logger[level]("x");
  }
  checkEqual(
    "each level goes to the matching console method",
    calls.map((call) => call.method),
    ["trace", "debug", "info", "warn", "error", "error"],
  );
  check(
    "ConsoleLike.trace writes trace records when the target has one",
    calls[0]?.method === "trace",
    calls[0],
  );

  calls.length = 0;
  logger.info("listening", { port: 3000 });
  logger.info("plain");
  logger.error("failed", { error: failure });
  checkEqual(
    "format defaults to pretty: `<ISO time> <LEVEL> [name] message`",
    calls[0]?.args[0],
    "2026-01-01T00:00:00.000Z INFO  [api] listening",
  );
  checkEqual("pretty: fields follow as one object", calls[0]?.args[1], {
    port: 3000,
  });
  checkEqual(
    "pretty: no extra argument without fields",
    calls[1]?.args.length,
    1,
  );
  check("pretty: the Error follows the fields", calls[2]?.args[1] === failure);
}

{
  const { target, calls } = fakeConsole(false);
  const logger = createLogger({
    level: "trace",
    sink: consoleSink({ console: target }),
  });
  logger.trace("t");
  logger.debug("d");
  logger.info("i");
  checkEqual(
    "without info/debug, those levels fall back to log",
    calls.map((call) => call.method),
    ["log", "log", "log"],
  );
}

{
  const { target, calls } = fakeConsole(true);
  const logger = createLogger({
    name: "api",
    bindings: { region: "eu" },
    sink: consoleSink({ console: target, format: "json" }),
    time: () => Date.parse("2026-01-01T00:00:00.000Z"),
  });
  logger.error("failed", { id: 7, error: failure });
  checkEqual("json: one string argument", calls[0]?.args.length, 1);
  checkEqual(
    "json: level, time, msg, merged fields, name and err",
    JSON.parse(String(calls[0]?.args[0])),
    {
      level: "error",
      time: "2026-01-01T00:00:00.000Z",
      msg: "failed",
      region: "eu",
      id: 7,
      name: "api",
      err: { name: "Error", message: "db down", stack: failure.stack },
    },
  );
}

/* ------------------------------------------------------------------ */
step("multiSink, collectSink, mergeLogFields");

{
  const order: string[] = [];
  const logger = createLogger({
    sink: multiSink(
      () => {
        order.push("first");
      },
      () => {
        order.push("second");
      },
    ),
  });
  logger.info("x");
  checkEqual("multiSink: every sink, in order", order, ["first", "second"]);

  const throwing = createLogger({
    sink: multiSink(() => {
      throw new Error("disk full");
    }),
  });
  await checkRejects(
    "multiSink: a sink that throws propagates",
    () => {
      throwing.info("x");
    },
    { message: /disk full/ },
  );
}

{
  const events: LogEvent[] = [];
  const sink = collectSink(events);
  const { logger } = createTestLogger();
  const sinkEvents: LogEvent[] = [];
  const logged = createLogger({
    sink: multiSink(sink, collectSink(sinkEvents)),
  });
  logged.info("same object");
  check(
    "collectSink: pushes the event object itself",
    events.length === 1 && events[0] === sinkEvents[0],
  );
  check("createTestLogger returns a Logger", isLogger(logger));
}

checkEqual(
  "mergeLogFields: bindings and fields in one object, fields winning",
  mergeLogFields({
    level: "info",
    message: "",
    fields: { zone: "b", ms: 12 },
    bindings: { service: "search", zone: "a" },
    time: 0,
  }),
  { service: "search", zone: "b", ms: 12 },
);

/* ------------------------------------------------------------------ */
step("noopLogger and createTestLogger");

checkEqual("noopLogger: level silent", noopLogger.level, "silent");
check(
  "noopLogger: no level is enabled",
  LOG_LEVELS.every((level) => !noopLogger.isLevelEnabled(level)),
);
checkEqual(
  "noopLogger: children are silent too",
  noopLogger.child({ a: 1 }).isLevelEnabled("fatal"),
  false,
);

{
  const { logger, events } = createTestLogger();
  logger.trace("seen");
  checkEqual(
    "createTestLogger: level defaults to trace",
    logger.level,
    "trace",
  );
  checkEqual(
    "createTestLogger: records every level by default",
    events.length,
    1,
  );

  const named = createTestLogger({
    level: "error",
    name: "svc",
    bindings: { suite: "x" },
  });
  named.logger.warn("dropped");
  named.logger.error("kept");
  checkEqual(
    "createTestLogger: level, name and bindings options",
    named.events.map((event) => [event.level, event.name, event.bindings]),
    [["error", "svc", { suite: "x" }]],
  );
}

/* ------------------------------------------------------------------ */
step("AdapterOptions");

{
  const { calls, method } = recorder();
  const tslog = { ...levelMethods(method), getSubLogger: () => ({}) };

  checkEqual("level defaults to trace", fromTslog(tslog).level, "trace");

  const gated = fromTslog(tslog, {
    level: "warn",
    name: "svc",
    bindings: { app: "a" },
  });
  gated.info("dropped before the library");
  gated.warn("kept");
  checkEqual("level gates before the library sees the record", calls.length, 1);
  checkEqual(
    "name and bindings are applied",
    [gated.name, gated.bindings],
    ["svc", { app: "a" }],
  );
  checkEqual("bindings travel with the record", calls[0]?.args, [
    "kept",
    { app: "a" },
  ]);
}

/* ------------------------------------------------------------------ */
step("fromPino and fromBunyan");

{
  const { calls, method } = recorder();
  const pino = {
    ...levelMethods(method),
    child: () => ({}),
    level: "info",
  };
  const logger = fromPino(pino, { bindings: { app: "api" } });
  logger.error("query failed", { error: failure, table: "users" });
  logger.fatal("gone");
  checkEqual(
    "pino: the matching method, (fields with err, message)",
    calls.map((call) => [call.method, ...call.args]),
    [
      ["error", { app: "api", table: "users", err: failure }, "query failed"],
      ["fatal", { app: "api" }, "gone"],
    ],
  );
  checkEqual(
    "pino without isLevelEnabled: every level is enabled",
    logger.isLevelEnabled("trace"),
    true,
  );

  const asked: string[] = [];
  const delegating = fromPino({
    ...pino,
    isLevelEnabled: (level: string) => {
      asked.push(level);
      return level === "error";
    },
  });
  checkEqual(
    "pino: isLevelEnabled delegates to the library",
    [delegating.isLevelEnabled("warn"), delegating.isLevelEnabled("error")],
    [false, true],
  );
  checkEqual("…with the level name unchanged", asked, ["warn", "error"]);
}

{
  const { calls, method } = recorder();
  let current: number | string = 40;
  const logger = fromBunyan({
    ...levelMethods(method),
    child: () => ({}),
    level: () => current,
  });
  logger.info("dropped");
  logger.warn("kept", { error: failure });
  checkEqual(
    "bunyan: its numeric level is honoured; (fields with err, message)",
    calls.map((call) => [call.method, ...call.args]),
    [["warn", { err: failure }, "kept"]],
  );
  current = "not a number";
  checkEqual(
    "bunyan: a non-numeric level enables everything",
    logger.isLevelEnabled("trace"),
    true,
  );
}

/* ------------------------------------------------------------------ */
step("fromWinston");

{
  const { calls, method } = recorder();
  const asked: string[] = [];
  const logger = fromWinston({
    log: method("log"),
    error: method("error"),
    warn: method("warn"),
    info: method("info"),
    isLevelEnabled: (level) => {
      asked.push(level);
      return true;
    },
  });
  for (const level of LOG_LEVELS) {
    logger[level](level);
  }
  checkEqual(
    "winston: log(level) with trace as silly and fatal as error",
    calls.map((call) => call.args[0]),
    ["silly", "debug", "info", "warn", "error", "error"],
  );
  checkEqual("winston: isLevelEnabled receives winston's level names", asked, [
    "silly",
    "debug",
    "info",
    "warn",
    "error",
    "error",
  ]);

  calls.length = 0;
  logger.fatal("the end", { code: 9 });
  logger.error("failed", { error: failure });
  checkEqual(
    "winston: (level, message, meta); fatal flagged, the Error in meta.error",
    calls.map((call) => call.args),
    [
      ["error", "the end", { code: 9, fatal: true }],
      ["error", "failed", { error: failure }],
    ],
  );
}

/* ------------------------------------------------------------------ */
step("fromConsola, fromLog4js, fromTslog");

{
  const { calls, method } = recorder();
  const consola = {
    ...levelMethods(method),
    withTag: () => ({}),
    level: 3,
  };
  const logger = fromConsola(consola);
  checkEqual(
    "consola: verbosity 3 enables info but not debug",
    [logger.isLevelEnabled("info"), logger.isLevelEnabled("debug")],
    [true, false],
  );
  logger.info("shown", { a: 1 });
  logger.fatal("gone", { error: failure });
  checkEqual(
    "consola: (message, fields, error), fatal to fatal",
    calls.map((call) => [call.method, ...call.args]),
    [
      ["info", "shown", { a: 1 }],
      ["fatal", "gone", failure],
    ],
  );

  const { fatal: _fatal, ...withoutFatal } = consola;
  calls.length = 0;
  fromConsola(withoutFatal).fatal("no fatal method");
  checkEqual("consola: fatal falls back to error", calls[0]?.method, "error");

  const { level: _level, ...noLevel } = consola;
  checkEqual(
    "consola: no numeric level enables everything",
    fromConsola(noLevel).isLevelEnabled("trace"),
    true,
  );
}

{
  const { calls, method } = recorder();
  const asked: (string | undefined)[] = [];
  const logger = fromLog4js({
    ...levelMethods(method),
    addContext: () => {},
    isLevelEnabled: (level) => {
      asked.push(level);
      return level !== "TRACE";
    },
  });
  logger.trace("dropped");
  logger.warn("careful", { id: 2 });
  checkEqual("log4js: isLevelEnabled gets upper-case names", asked, [
    "TRACE",
    "WARN",
  ]);
  checkEqual(
    "log4js: (message, fields) on the matching method",
    calls.map((call) => [call.method, ...call.args]),
    [["warn", "careful", { id: 2 }]],
  );
}

{
  const { calls, method } = recorder();
  const logger = fromTslog({
    ...levelMethods(method),
    getSubLogger: () => ({}),
  });
  for (const level of LOG_LEVELS) {
    logger[level](level);
  }
  checkEqual(
    "tslog: levels map one-to-one",
    calls.map((call) => call.method),
    [...LOG_LEVELS],
  );
}

/* ------------------------------------------------------------------ */
step("fromNestLogger");

{
  const { calls, method } = recorder();
  const logger = fromNestLogger(
    {
      log: method("log"),
      error: method("error"),
      warn: method("warn"),
      debug: method("debug"),
      verbose: method("verbose"),
      fatal: method("fatal"),
    },
    { name: "JobsService" },
  );
  for (const level of LOG_LEVELS) {
    logger[level](level);
  }
  checkEqual(
    "Nest: trace→verbose, debug→debug, info→log, warn, error, fatal",
    calls.map((call) => call.method),
    ["verbose", "debug", "log", "warn", "error", "fatal"],
  );
  checkEqual(
    "Nest: the logger's name is the trailing context",
    calls[2]?.args,
    ["info", "JobsService"],
  );

  calls.length = 0;
  logger.error("could not start", { error: failure, port: 3000 });
  logger.warn("slow", { error: failure });
  checkEqual(
    "Nest: error levels get (message, stack, fields, context); others the Error",
    calls.map((call) => call.args),
    [
      ["could not start", failure.stack, { port: 3000 }, "JobsService"],
      ["slow", failure, "JobsService"],
    ],
  );
}

{
  const { calls, method } = recorder();
  const logger = fromNestLogger({
    log: method("log"),
    error: method("error"),
    warn: method("warn"),
  });
  logger.trace("t");
  logger.debug("d");
  logger.fatal("f");
  checkEqual(
    "Nest without verbose/debug/fatal: trace and debug to log, fatal to error",
    calls.map((call) => call.method),
    ["log", "log", "error"],
  );
}

/* ------------------------------------------------------------------ */
step("fromConsole and isLogger");

{
  const { target, calls } = fakeConsole(false);
  const pretty = fromConsole(target);
  pretty.info("hi");
  check(
    "fromConsole: pretty by default",
    / INFO {2}hi$/.test(String(calls[0]?.args[0])),
    calls[0],
  );
  checkEqual(
    "fromConsole: threshold trace, like every adapter",
    pretty.level,
    "trace",
  );

  fromConsole(target, { format: "json" }).info("hi");
  checkEqual(
    "fromConsole: format json",
    (JSON.parse(String(calls[1]?.args[0])) as Record<string, JsonValue>).msg,
    "hi",
  );
}

checkEqual(
  "isLogger: true for a Logger, false for anything else",
  [
    isLogger(createLogger()),
    isLogger(noopLogger),
    isLogger(console),
    isLogger(() => {}),
    isLogger(null),
  ],
  [true, true, false, false, false],
);

/* ------------------------------------------------------------------ */
step("resolveLogger");

{
  const { logger } = createTestLogger();
  check("a Logger is returned untouched", resolveLogger(logger) === logger);
  check(
    "undefined or null returns the fallback",
    resolveLogger(undefined, logger) === logger &&
      resolveLogger(null, logger) === logger,
  );
  const fresh = resolveLogger();
  check(
    "no input and no fallback: a new console logger at info",
    isLogger(fresh) && fresh.level === "info",
    fresh.level,
  );

  const events: LogEvent[] = [];
  const fromSink = resolveLogger((event) => {
    events.push(event);
  });
  fromSink.trace("through");
  checkEqual(
    "a function is a sink, at level trace",
    [fromSink.level, events[0]?.message],
    ["trace", "through"],
  );
}

{
  const { calls, method } = recorder();
  const levels = levelMethods(method);

  /** Resolves `shape`, logs `info("probe")` and answers the call it made. */
  const probe = (shape: LoggerLike): Call | undefined => {
    calls.length = 0;
    resolveLogger(shape).info("probe");
    return calls.at(-1);
  };

  checkEqual(
    "pino: levels + child + string level (object first)",
    probe({ ...levels, child: () => ({}), level: "info" })?.args[1],
    "probe",
  );
  checkEqual(
    "pino: levels + child + isLevelEnabled",
    probe({ ...levels, child: () => ({}), isLevelEnabled: () => true })
      ?.args[1],
    "probe",
  );
  checkEqual(
    "bunyan: levels + child + level function",
    probe({ ...levels, child: () => ({}), level: () => 10 })?.args[1],
    "probe",
  );
  checkEqual(
    "winston: log + transports",
    probe({ ...levels, log: method("log"), transports: [] })?.args,
    ["info", "probe", {}],
  );
  checkEqual(
    "winston: log + silly",
    probe({
      log: method("log"),
      error: method("error"),
      warn: method("warn"),
      info: method("info"),
      silly: method("silly"),
    })?.method,
    "log",
  );
  checkEqual(
    "consola: withTag (message first)",
    probe({ ...levels, withTag: () => ({}) })?.args,
    ["probe"],
  );
  // Both adapters would call `info("probe")`; consola verbosity 0 drops info,
  // so no call at all proves consola's adapter was the one chosen.
  checkEqual(
    "consola is checked before log4js",
    probe({ ...levels, withTag: () => ({}), addContext: () => {}, level: 0 }),
    undefined,
  );
  checkEqual(
    "log4js: levels + addContext",
    probe({ ...levels, addContext: () => {} })?.args,
    ["probe"],
  );
  checkEqual(
    "tslog: levels + getSubLogger",
    probe({ ...levels, getSubLogger: () => ({}) })?.args,
    ["probe"],
  );
  checkEqual(
    "Nest: log/warn/error + verbose",
    probe({
      log: method("nest.log"),
      warn: method("nest.warn"),
      error: method("nest.error"),
      verbose: method("nest.verbose"),
    })?.method,
    "nest.log",
  );
  const consoleCall = probe({
    log: method("console.log"),
    warn: method("console.warn"),
    error: method("console.error"),
  });
  check(
    "console-like: log/warn/error, written by consoleSink",
    consoleCall?.method === "console.log" &&
      / INFO {2}probe$/.test(String(consoleCall.args[0])),
    consoleCall,
  );

  await checkRejects(
    "anything else is refused",
    () => resolveLogger({ nope: true } as never),
    { name: "TypeError", message: /Unrecognised logger/ },
  );
}

/* ------------------------------------------------------------------ */
step("BunRouter logger and BunHttpAdapter logger");

{
  const { calls, method } = recorder();
  const router = new BunRouter({
    debug: true,
    logger: { ...levelMethods(method), child: () => ({}), level: "trace" },
  });
  router.get("/ping", (_req, res) => {
    res.send("pong");
  });

  const first = router.logger;
  check("router.logger resolves the constructor's LoggerLike", isLogger(first));
  check("…once: the same instance on every access", router.logger === first);

  await router.fetch("/ping");
  const layer = calls.find(
    (call) => call.args[1] === "pipeline layer executed",
  );
  check(
    "debug: true logs each pipeline layer at debug through the logger",
    layer?.method === "debug" &&
      (layer.args[0] as LogFields).state === "route_handler",
    calls,
  );

  const { logger, events } = createTestLogger();
  check("setLogger returns the router", router.setLogger(logger) === router);
  check("setLogger keeps a Logger as it is", router.logger === logger);

  const lines: string[] = [];
  router.logger = (event) => {
    lines.push(event.message);
  };
  await router.fetch("/ping");
  check(
    "the logger setter resolves any LoggerLike (a sink here)",
    lines.includes("pipeline layer executed") && events.length === 0,
    { lines, events: events.length },
  );

  const quietLog = createTestLogger();
  const quiet = new BunRouter({ logger: quietLog.logger });
  quiet.get("/ping", (_req, res) => {
    res.send("pong");
  });
  await quiet.fetch("/ping");
  checkEqual(
    "without debug nothing is logged per layer",
    quietLog.events.length,
    0,
  );

  const unset = new BunRouter();
  check(
    "no logger option: a default console logger at info",
    isLogger(unset.logger) && unset.logger.level === "info",
  );
}

{
  const { logger } = createTestLogger();
  const adapter = new BunHttpAdapter(0, { logger });
  check(
    "BunHttpAdapter logger: the Logger given is used as-is",
    adapter.logger === logger,
  );

  const { method } = recorder();
  const nestAdapter = new BunHttpAdapter(0, {
    logger: {
      log: method("log"),
      warn: method("warn"),
      error: method("error"),
      verbose: method("verbose"),
    },
  });
  check(
    "BunHttpAdapter logger: any LoggerLike is adapted",
    isLogger(nestAdapter.logger),
  );
}

summary();
