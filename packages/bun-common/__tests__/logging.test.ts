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

  it("rejects something that is not a logger at all", () => {
    expect(() => resolveLogger({ nope: true } as never)).toThrow(
      /Unrecognised logger/,
    );
  });
});
