import type { LogEvent } from "../lib/logging";
import { describe, expect, it } from "bun:test";
import {
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
  multiSink,
  noopLogger,
  resolveLogger,
} from "../lib/logging";

/**
 * The adapters are written against each library's *structural* shape, so the
 * fakes below are typed after the real public APIs (argument order included)
 * and assert the mapping without pulling eight dependencies into the repo.
 */

/** Records every `(method, args)` pair a fake logger receives. */
function recorder() {
  const calls: { method: string; args: unknown[] }[] = [];
  const method =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ method: name, args });
    };
  return { calls, method };
}

describe("logging: createLogger", () => {
  it("emits an event carrying level, message, fields and time", () => {
    const events: LogEvent[] = [];
    const logger = createLogger({
      level: "trace",
      sink: collectSink(events),
      time: () => 1234,
    });

    logger.info("started", { port: 3000 });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "info",
      message: "started",
      fields: { port: 3000 },
      bindings: {},
      time: 1234,
    });
  });

  it("drops records below the threshold", () => {
    const { logger, events } = createTestLogger({ level: "warn" });

    logger.trace("no");
    logger.debug("no");
    logger.info("no");
    logger.warn("yes");
    logger.error("yes");
    logger.fatal("yes");

    expect(events.map((event) => event.level)).toEqual([
      "warn",
      "error",
      "fatal",
    ]);
  });

  it("reports whether a level is enabled", () => {
    const { logger } = createTestLogger({ level: "info" });

    expect(logger.isLevelEnabled("debug")).toBe(false);
    expect(logger.isLevelEnabled("info")).toBe(true);
    expect(logger.isLevelEnabled("fatal")).toBe(true);
  });

  it("drops everything at the silent threshold", () => {
    const events: LogEvent[] = [];
    const logger = createLogger({ level: "silent", sink: collectSink(events) });

    logger.fatal("the sky is falling");

    expect(events).toEqual([]);
    expect(logger.isLevelEnabled("fatal")).toBe(false);
    expect(noopLogger.isLevelEnabled("fatal")).toBe(false);
  });

  it("treats log() as info", () => {
    const { logger, events } = createTestLogger();
    logger.log("legacy call site");
    expect(events[0]?.level).toBe("info");
  });

  it("merges child bindings, latest winning", () => {
    const { logger, events } = createTestLogger({ bindings: { app: "api" } });

    const child = logger.child({ requestId: "r1" });
    const grandchild = child.child({ requestId: "r2", jobId: "j1" });
    grandchild.info("handled");

    expect(events[0]?.bindings).toEqual({
      app: "api",
      requestId: "r2",
      jobId: "j1",
    });
    // The parent is untouched.
    logger.info("parent");
    expect(events[1]?.bindings).toEqual({ app: "api" });
  });

  it("lets a child override the name and threshold", () => {
    const { logger, events } = createTestLogger({
      level: "info",
      name: "root",
    });

    const child = logger.child({}, { name: "worker", level: "error" });
    child.warn("dropped");
    child.error("kept");

    expect(child.name).toBe("worker");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: "error", name: "worker" });
  });

  it("splits an Error logged as the message", () => {
    const { logger, events } = createTestLogger();
    const failure = new Error("boom");

    logger.error(failure);

    expect(events[0]?.message).toBe("boom");
    expect(events[0]?.error).toBe(failure);
  });

  it("lifts an Error out of the fields", () => {
    const { logger, events } = createTestLogger();
    const failure = new Error("nope");

    logger.error("could not connect", { error: failure, attempt: 2 });

    expect(events[0]?.error).toBe(failure);
    expect(events[0]?.fields).toEqual({ attempt: 2 });
  });

  it("does not mutate the caller's fields object", () => {
    const { logger } = createTestLogger();
    const fields = { error: new Error("x"), keep: true };

    logger.error("failed", fields);

    expect(Object.keys(fields)).toEqual(["error", "keep"]);
  });
});

describe("logging: sinks", () => {
  it("writes a human line with fields and error to the console", () => {
    const { calls, method } = recorder();
    const logger = createLogger({
      level: "trace",
      name: "api",
      sink: consoleSink({
        console: {
          log: method("log"),
          warn: method("warn"),
          error: method("error"),
        },
      }),
    });

    logger.info("listening", { port: 3000 });

    expect(calls[0]?.method).toBe("log");
    expect(String(calls[0]?.args[0])).toContain("INFO");
    expect(String(calls[0]?.args[0])).toContain("[api] listening");
    expect(calls[0]?.args[1]).toEqual({ port: 3000 });
  });

  it("omits the fields argument when there are none", () => {
    const { calls, method } = recorder();
    const logger = createLogger({
      sink: consoleSink({
        console: {
          log: method("log"),
          warn: method("warn"),
          error: method("error"),
        },
      }),
    });

    logger.info("plain");

    expect(calls[0]?.args).toHaveLength(1);
  });

  it("routes each level to the matching console method", () => {
    const { calls, method } = recorder();
    const logger = createLogger({
      level: "trace",
      sink: consoleSink({
        console: {
          log: method("log"),
          warn: method("warn"),
          error: method("error"),
          info: method("info"),
          debug: method("debug"),
        },
      }),
    });

    logger.trace("a");
    logger.debug("b");
    logger.info("c");
    logger.warn("d");
    logger.error("e");
    logger.fatal("f");

    expect(calls.map((call) => call.method)).toEqual([
      "debug",
      "debug",
      "info",
      "warn",
      "error",
      "error",
    ]);
  });

  it("writes one JSON record per event in json format", () => {
    const { calls, method } = recorder();
    const logger = createLogger({
      name: "api",
      bindings: { region: "eu" },
      sink: consoleSink({
        console: {
          log: method("log"),
          warn: method("warn"),
          error: method("error"),
        },
        format: "json",
      }),
    });

    logger.info("hello", { id: 7 });

    const record = JSON.parse(String(calls[0]?.args[0])) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({
      level: "info",
      msg: "hello",
      name: "api",
      region: "eu",
      id: 7,
    });
  });

  it("routes trace to the console's trace method when it has one", () => {
    const { calls, method } = recorder();
    const logger = createLogger({
      level: "trace",
      sink: consoleSink({
        console: {
          log: method("log"),
          warn: method("warn"),
          error: method("error"),
          debug: method("debug"),
          trace: method("trace"),
        },
      }),
    });

    logger.trace("a");
    logger.debug("b");

    expect(calls.map((call) => call.method)).toEqual(["trace", "debug"]);
  });

  it("falls back from trace to debug, then log", () => {
    const withDebug = recorder();
    createLogger({
      level: "trace",
      sink: consoleSink({
        console: {
          log: withDebug.method("log"),
          warn: withDebug.method("warn"),
          error: withDebug.method("error"),
          debug: withDebug.method("debug"),
        },
      }),
    }).trace("a");
    expect(withDebug.calls[0]?.method).toBe("debug");

    const bare = recorder();
    createLogger({
      level: "trace",
      sink: consoleSink({
        console: {
          log: bare.method("log"),
          warn: bare.method("warn"),
          error: bare.method("error"),
        },
      }),
    }).trace("a");
    expect(bare.calls[0]?.method).toBe("log");
  });

  it("keeps the JSON record's own keys when fields collide with them", () => {
    const { calls, method } = recorder();
    const failure = new Error("real");
    const logger = createLogger({
      name: "api",
      bindings: { level: "from-binding" },
      time: () => 0,
      sink: consoleSink({
        console: {
          log: method("log"),
          warn: method("warn"),
          error: method("error"),
        },
        format: "json",
      }),
    });

    logger.error("the message", {
      error: failure,
      msg: "fake",
      time: "never",
      name: "impostor",
      err: "fake err",
      kept: true,
    });

    const record = JSON.parse(String(calls[0]?.args[0])) as Record<
      string,
      unknown
    >;
    expect(record.level).toBe("error");
    expect(record.msg).toBe("the message");
    expect(record.time).toBe(new Date(0).toISOString());
    expect(record.name).toBe("api");
    expect(record.err).toMatchObject({ message: "real" });
    expect(record.kept).toBe(true);
  });

  it("fans out to several sinks", () => {
    const a: LogEvent[] = [];
    const b: LogEvent[] = [];
    const logger = createLogger({
      sink: multiSink(collectSink(a), collectSink(b)),
    });

    logger.info("both");

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

describe("logging: adapters", () => {
  it("maps pino's object-first signature", () => {
    const { calls, method } = recorder();
    const pino = {
      trace: method("trace"),
      debug: method("debug"),
      info: method("info"),
      warn: method("warn"),
      error: method("error"),
      fatal: method("fatal"),
      child: () => pino,
      level: "info",
    };

    const logger = fromPino(pino, { bindings: { app: "api" } });
    const failure = new Error("db down");
    logger.error("query failed", { error: failure, table: "users" });

    expect(calls[0]?.method).toBe("error");
    expect(calls[0]?.args[0]).toEqual({
      app: "api",
      table: "users",
      err: failure,
    });
    expect(calls[0]?.args[1]).toBe("query failed");
  });

  it("delegates level checks to pino", () => {
    const { method } = recorder();
    const pino = {
      trace: method("trace"),
      debug: method("debug"),
      info: method("info"),
      warn: method("warn"),
      error: method("error"),
      fatal: method("fatal"),
      child: () => pino,
      level: "warn",
      isLevelEnabled: (level: string) => level === "warn" || level === "error",
    };

    const logger = fromPino(pino);

    expect(logger.isLevelEnabled("info")).toBe(false);
    expect(logger.isLevelEnabled("warn")).toBe(true);
  });

  it("honours bunyan's numeric level", () => {
    const { calls, method } = recorder();
    const bunyan = {
      trace: method("trace"),
      debug: method("debug"),
      info: method("info"),
      warn: method("warn"),
      error: method("error"),
      fatal: method("fatal"),
      child: () => bunyan,
      level: () => 40,
    };

    const logger = fromBunyan(bunyan);
    logger.info("dropped by bunyan's threshold");
    logger.warn("kept", { id: 1 });

    expect(logger.isLevelEnabled("info")).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "warn" });
    expect(calls[0]?.args[0]).toEqual({ id: 1 });
  });

  it("maps winston's level-first signature", () => {
    const calls: unknown[][] = [];
    const winston = {
      log: (...args: unknown[]) => calls.push(args),
      error: () => {},
      warn: () => {},
      info: () => {},
      silly: () => {},
      transports: [],
    };

    const logger = fromWinston(winston);
    logger.trace("verbose thing");
    logger.fatal("the end", { code: 9 });

    expect(calls[0]?.[0]).toBe("silly");
    expect(calls[0]?.[1]).toBe("verbose thing");
    expect(calls[1]?.[0]).toBe("error");
    expect(calls[1]?.[2]).toEqual({ code: 9, fatal: true });
  });

  it("maps consola and respects its numeric verbosity", () => {
    const { calls, method } = recorder();
    const consola = {
      trace: method("trace"),
      debug: method("debug"),
      info: method("info"),
      warn: method("warn"),
      error: method("error"),
      fatal: method("fatal"),
      withTag: () => consola,
      level: 3,
    };

    const logger = fromConsola(consola);
    logger.debug("too verbose for level 3");
    logger.info("shown", { a: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("info");
    expect(calls[0]?.args).toEqual(["shown", { a: 1 }]);
  });

  it("maps log4js with message-first arguments", () => {
    const { calls, method } = recorder();
    const log4js = {
      trace: method("trace"),
      debug: method("debug"),
      info: method("info"),
      warn: method("warn"),
      error: method("error"),
      fatal: method("fatal"),
      addContext: () => {},
      isLevelEnabled: (level?: string) => level !== "TRACE",
    };

    const logger = fromLog4js(log4js);
    logger.trace("dropped");
    logger.warn("careful", { id: 2 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("warn");
    expect(calls[0]?.args).toEqual(["careful", { id: 2 }]);
  });

  it("maps tslog", () => {
    const { calls, method } = recorder();
    const tslog = {
      trace: method("trace"),
      debug: method("debug"),
      info: method("info"),
      warn: method("warn"),
      error: method("error"),
      fatal: method("fatal"),
      getSubLogger: () => tslog,
    };

    fromTslog(tslog).fatal("gone");

    expect(calls[0]?.method).toBe("fatal");
    expect(calls[0]?.args).toEqual(["gone"]);
  });

  it("maps a NestJS logger, passing the stack and context Nest expects", () => {
    const { calls, method } = recorder();
    const nest = {
      log: method("log"),
      error: method("error"),
      warn: method("warn"),
      debug: method("debug"),
      verbose: method("verbose"),
    };

    const logger = fromNestLogger(nest, { name: "JobsService" });
    logger.trace("deep detail");
    logger.info("started");
    const failure = new Error("bad");
    logger.error("could not start", { error: failure });

    expect(calls[0]?.method).toBe("verbose");
    expect(calls[1]).toMatchObject({ method: "log" });
    expect(calls[1]?.args).toEqual(["started", "JobsService"]);
    expect(calls[2]?.method).toBe("error");
    expect(calls[2]?.args[0]).toBe("could not start");
    expect(calls[2]?.args[1]).toBe(failure.stack);
    expect(calls[2]?.args.at(-1)).toBe("JobsService");
  });

  it("adapts a console-like object", () => {
    const { calls, method } = recorder();
    const logger = fromConsole({
      log: method("log"),
      warn: method("warn"),
      error: method("error"),
    });

    logger.info("hi");

    expect(calls[0]?.method).toBe("log");
    expect(String(calls[0]?.args[0])).toContain("hi");
  });
});

describe("logging: resolveLogger", () => {
  it("returns a Logger untouched", () => {
    const { logger } = createTestLogger();
    expect(resolveLogger(logger)).toBe(logger);
  });

  it("builds a default console logger with no input", () => {
    const resolved = resolveLogger();
    expect(isLogger(resolved)).toBe(true);
    expect(resolved.level).toBe("info");
  });

  it("prefers the fallback when there is no input", () => {
    const { logger } = createTestLogger();
    expect(resolveLogger(undefined, logger)).toBe(logger);
    expect(resolveLogger(null, logger)).toBe(logger);
  });

  it("wraps a bare sink function", () => {
    const events: LogEvent[] = [];
    const logger = resolveLogger((event) => events.push(event));

    logger.trace("through the sink");

    expect(events[0]?.message).toBe("through the sink");
  });

  it("detects each supported shape", () => {
    const { calls, method } = recorder();
    const levels = {
      trace: method("trace"),
      debug: method("debug"),
      info: method("info"),
      warn: method("warn"),
      error: method("error"),
      fatal: method("fatal"),
    };

    // pino: child + a string level.
    resolveLogger({ ...levels, child: () => ({}), level: "info" }).info("pino");
    expect(calls.at(-1)?.args[1]).toBe("pino");

    // bunyan: child + a level *function*.
    resolveLogger({ ...levels, child: () => ({}), level: () => 10 }).info(
      "bunyan",
    );
    expect(calls.at(-1)?.args[1]).toBe("bunyan");

    // winston: log() plus transports.
    const winstonCalls: unknown[][] = [];
    resolveLogger({
      ...levels,
      log: (...args: unknown[]) => winstonCalls.push(args),
      transports: [],
    }).info("winston");
    expect(winstonCalls[0]?.[0]).toBe("info");

    // consola: withTag.
    resolveLogger({ ...levels, withTag: () => ({}) }).info("consola");
    expect(calls.at(-1)?.args[0]).toBe("consola");

    // log4js: addContext.
    resolveLogger({ ...levels, addContext: () => {} }).info("log4js");
    expect(calls.at(-1)?.args[0]).toBe("log4js");

    // tslog: getSubLogger.
    resolveLogger({ ...levels, getSubLogger: () => ({}) }).info("tslog");
    expect(calls.at(-1)?.args[0]).toBe("tslog");

    // Nest: log/warn/error plus verbose.
    resolveLogger({
      log: method("nest-log"),
      warn: method("nest-warn"),
      error: method("nest-error"),
      verbose: method("nest-verbose"),
    }).info("nest");
    expect(calls.at(-1)?.method).toBe("nest-log");

    // console-like: the repo's previous Logger shape.
    resolveLogger({
      log: method("console-log"),
      warn: method("console-warn"),
      error: method("console-error"),
    }).info("console");
    expect(calls.at(-1)?.method).toBe("console-log");
  });

  it("adapts a real pino instance instead of treating it as a Logger", () => {
    const { calls, method } = recorder();
    // A pino instance: six level methods taking `(obj, msg)`, `child`, a
    // string `level`, `isLevelEnabled`, `levels`, and `bindings()` as a method.
    const pino = {
      trace: method("trace"),
      debug: method("debug"),
      info: method("info"),
      warn: method("warn"),
      error: method("error"),
      fatal: method("fatal"),
      silent: () => {},
      child: () => pino,
      bindings: () => ({}),
      setBindings: () => {},
      level: "info",
      levelVal: 30,
      levels: {
        values: {
          trace: 10,
          debug: 20,
          info: 30,
          warn: 40,
          error: 50,
          fatal: 60,
        },
        labels: {
          10: "trace",
          20: "debug",
          30: "info",
          40: "warn",
          50: "error",
          60: "fatal",
        },
      },
      isLevelEnabled: () => true,
      version: "9.0.0",
    };

    expect(isLogger(pino)).toBe(false);
    const failure = new Error("db down");
    const logger = resolveLogger(pino);
    expect(logger).not.toBe(pino as unknown);
    logger.error("query failed", { error: failure, table: "users" });

    expect(calls).toEqual([
      {
        method: "error",
        args: [{ table: "users", err: failure }, "query failed"],
      },
    ]);
  });

  it("still recognises this module's own loggers", () => {
    const { logger } = createTestLogger();
    expect(isLogger(logger)).toBe(true);
    expect(isLogger(noopLogger)).toBe(true);
    expect(isLogger(logger.child({ a: 1 }))).toBe(true);
    expect(isLogger(console)).toBe(false);
  });

  it("detects a tslog v4 logger (which also has log and silly) as tslog", () => {
    const { calls, method } = recorder();
    // tslog v4's public surface: seven level methods including `silly`, a
    // `log(logLevelId, logLevelName, ...args)` method, sub-loggers, transports.
    const tslog = {
      silly: method("silly"),
      trace: method("trace"),
      debug: method("debug"),
      info: method("info"),
      warn: method("warn"),
      error: method("error"),
      fatal: method("fatal"),
      log: method("log"),
      getSubLogger: () => tslog,
      attachTransport: () => {},
      settings: { name: undefined, minLevel: 0 },
    };

    resolveLogger(tslog).info("hello", { id: 1 });

    expect(calls).toEqual([{ method: "info", args: ["hello", { id: 1 }] }]);
  });

  it("detects winston with custom trace/fatal levels as winston, not pino", () => {
    const calls: unknown[][] = [];
    const noop = () => {};
    // `winston.createLogger({ levels: { fatal: 0, …, trace: 5 } })` exposes a
    // method per custom level alongside `log`, `child`, a string `level`,
    // `isLevelEnabled`, the `levels` map and the `transports` array.
    const winston = {
      fatal: noop,
      error: noop,
      warn: noop,
      info: noop,
      debug: noop,
      trace: noop,
      log: (...args: unknown[]) => calls.push(args),
      child: () => winston,
      level: "trace",
      levels: { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 },
      isLevelEnabled: () => true,
      transports: [],
      add: noop,
      remove: noop,
    };

    const logger = resolveLogger(winston);
    logger.info("winston info");
    logger.trace("winston trace");
    logger.fatal("winston fatal");

    expect(calls[0]?.slice(0, 2)).toEqual(["info", "winston info"]);
    // The custom set defines `trace` and `fatal`, so they are used directly.
    expect(calls[1]?.[0]).toBe("trace");
    expect(calls[2]?.[0]).toBe("fatal");
    expect(calls[2]?.[2]).toEqual({});
  });

  it("still detects winston by log + silly when transports are absent", () => {
    const calls: unknown[][] = [];
    const noop = () => {};
    resolveLogger({
      log: (...args: unknown[]) => calls.push(args),
      error: noop,
      warn: noop,
      info: noop,
      silly: noop,
    }).trace("deep");

    expect(calls[0]?.slice(0, 2)).toEqual(["silly", "deep"]);
  });

  it("rejects something that is not a logger at all", () => {
    expect(() => resolveLogger({ nope: true } as never)).toThrow(
      /Unrecognised logger/,
    );
  });
});
