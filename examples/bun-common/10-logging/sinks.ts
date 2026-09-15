/**
 * Sinks — where log events go — plus the loggers made for tests and for
 * silence, and the level tables.
 *
 * ```bash
 * bun 10-logging/sinks.ts
 * ```
 *
 * A sink is a function `(event: LogEvent) => void`. The logger decides
 * whether* to record (threshold, `enabled`) and builds the event; the sink
 * only decides *where it goes*. So a sink never filters by level, and writing
 * one is a few lines.
 */
import type {
  ConsoleLike,
  JsonValue,
  LogEvent,
  LogSink,
} from "@kingsleyweb/bun-common";
import {
  collectSink,
  consoleSink,
  createLogger,
  createTestLogger,
  LOG_LEVEL_VALUES,
  LOG_LEVELS,
  mergeLogFields,
  multiSink,
  noopLogger,
} from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

/** One call a fake console received. */
interface ConsoleCall {
  /** The console method that was called. */
  method: string;
  /** The arguments it was called with; a console accepts anything. */
  args: unknown[];
}

/**
 * A console that records instead of printing. `full` adds the optional
 * `info`/`debug`/`trace` methods; without them, a sink falls back to `log`.
 */
function fakeConsole(full: boolean): {
  target: ConsoleLike;
  calls: ConsoleCall[];
} {
  const calls: ConsoleCall[] = [];
  const record = (method: string) => {
    return (...args: unknown[]) => {
      calls.push({ method, args });
    };
  };

  const target: ConsoleLike = {
    log: record("log"),
    warn: record("warn"),
    error: record("error"),
  };
  if (full) {
    target.info = record("info");
    target.debug = record("debug");
    target.trace = record("trace");
  }

  return { target, calls };
}

/** A call, with an `Error` argument shown by name and message only. */
function readable(call: ConsoleCall): unknown[] {
  return [
    call.method,
    ...call.args.map((arg) => {
      return arg instanceof Error ? `[${arg.name}: ${arg.message}]` : arg;
    }),
  ];
}

title("Logging: sinks");

/* ------------------------------------------------------------------ */
step("The level tables");

show("LOG_LEVELS, ascending", LOG_LEVELS);
show("LOG_LEVEL_VALUES", LOG_LEVEL_VALUES);

/* ------------------------------------------------------------------ */
step("consoleSink, pretty: a human line, then fields and error as objects");

const full = fakeConsole(true);
const pretty = createLogger({
  level: "trace",
  name: "api",
  bindings: { region: "eu" },
  sink: consoleSink({ console: full.target, format: "pretty" }),
  time: () => Date.parse("2026-01-01T12:00:00.000Z"),
});

for (const level of LOG_LEVELS) {
  pretty[level](`${level} line`);
}
pretty.error("request failed", {
  status: 502,
  error: new Error("upstream timeout"),
});
// Each level goes to the closest console method: trace to `trace` (else
// `debug`, else `log`), debug to `debug`, info to `info`, warn to `warn`,
// error and fatal to `error`.
show("calls", full.calls.map(readable));

/* ------------------------------------------------------------------ */
step("…and without info/debug, those fall back to `log`");

const minimal = fakeConsole(false);
const fallback = createLogger({
  level: "trace",
  sink: consoleSink({ console: minimal.target }),
});
fallback.trace("t");
fallback.debug("d");
fallback.info("i");
show(
  "methods used",
  minimal.calls.map((call) => call.method),
);

/* ------------------------------------------------------------------ */
step("consoleSink, json: one JSON string per record");

const jsonConsole = fakeConsole(true);
const json = createLogger({
  name: "api",
  bindings: { region: "eu" },
  sink: consoleSink({ console: jsonConsole.target, format: "json" }),
});
json.info("listening", { port: 3000 });
json.error(new Error("boom"));

show(
  "records",
  jsonConsole.calls.map((call) => {
    const record = JSON.parse(String(call.args[0])) as Record<
      string,
      JsonValue
    >;
    // Keep the output short: the stack is there, just not printed.
    if (typeof record.err === "object" && record.err !== null) {
      record.err = { ...record.err, stack: "…" };
    }
    return record;
  }),
);

/* ------------------------------------------------------------------ */
step("consoleSink with no options: the global console, pretty");

createLogger({ sink: consoleSink() }).warn("this one really prints", {
  reason: "demo",
});

/* ------------------------------------------------------------------ */
step("multiSink: every sink, in order");

const order: string[] = [];
const fanOut = createLogger({
  sink: multiSink(
    (event) => {
      order.push(`first: ${event.message}`);
    },
    (event) => {
      order.push(`second: ${event.message}`);
    },
  ),
});
fanOut.info("hello");
show("heard", order);

// A sink is expected not to throw; if one does, the log call throws.
const fragile = createLogger({
  sink: multiSink(
    () => {
      throw new Error("disk full");
    },
    (event) => {
      order.push(`never reached: ${event.message}`);
    },
  ),
});
try {
  fragile.info("lost");
} catch (error) {
  show("a throwing sink propagates", (error as Error).message);
}

/* ------------------------------------------------------------------ */
step("collectSink, and writing a sink of your own");

const kept: LogEvent[] = [];
const lines: string[] = [];

/** A logfmt sink: `level=info msg="..." key=value`, into `lines`. */
const logfmt: LogSink = (event) => {
  // `mergeLogFields` flattens bindings and fields into one object; a call's
  // fields win over the logger's bindings.
  const pairs = Object.entries(mergeLogFields(event)).map(([key, value]) => {
    return `${key}=${JSON.stringify(value)}`;
  });
  lines.push(
    [
      `level=${event.level}`,
      `msg=${JSON.stringify(event.message)}`,
      ...pairs,
    ].join(" "),
  );
};

const custom = createLogger({
  bindings: { service: "search", zone: "a" },
  sink: multiSink(collectSink(kept), logfmt),
});
custom.info("query served", { zone: "b", ms: 12 });

show("logfmt", lines);
show("collectSink kept the event itself", kept[0]);

/* ------------------------------------------------------------------ */
step("noopLogger: drops everything, cheaply");

noopLogger.fatal("nobody hears this");
show("level", noopLogger.level);
show(
  "any level enabled?",
  LOG_LEVELS.some((level) => noopLogger.isLevelEnabled(level)),
);
show(
  "a child is silent too",
  noopLogger.child({ requestId: "r1" }).isLevelEnabled("fatal"),
);

/* ------------------------------------------------------------------ */
step("createTestLogger: a logger and the array it records into");

const { logger: testLogger, events } = createTestLogger({
  name: "under-test",
  bindings: { suite: "sinks" },
});
testLogger.trace("recorded: tests see every level by default");
testLogger.error("assert on me", { code: "E42" });

show("level", testLogger.level);
show(
  "events",
  events.map((event) => {
    return [event.level, event.name, event.message, mergeLogFields(event)];
  }),
);
show("what a test would check", events.at(-1)?.fields.code === "E42");
