/**
 * Adapters — hand bun-common the logger you already run.
 *
 * ```bash
 * bun 10-logging/adapters.ts
 * ```
 *
 * Everywhere bun-common (and bun-nest, bun-jobs) asks for a logger it takes a
 * `LoggerLike`: a `Logger`, a bare sink function, or a pino, bunyan, winston,
 * consola, log4js, tslog, NestJS or console-shaped logger. `resolveLogger`
 * detects which by shape; `fromPino` and friends skip the detection.
 *
 * Each adapter wraps the library in a sink and reuses `createLogger`, so
 * `child()`, level filtering and error handling behave the same whatever is
 * underneath. Bindings go in the library's structured slot, and an adapter's
 * own threshold defaults to `trace` so the library stays the authority on
 * what it drops.
 *
 * The loggers below are *structural fakes*: objects with the methods each
 * library's logger has, recording what they receive. That is all the adapters
 * rely on — nothing in bun-common imports those libraries — so a real
 * instance is called the same way.
 */
import type {
  ConsoleLike,
  LogEvent,
  NestLoggerLike,
  PinoLike,
} from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunRouter,
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
  resolveLogger,
} from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

/** One call a fake logger received. */
interface Call {
  /** The method called. */
  method: string;
  /** The arguments, with an `Error` or a stack trace shortened for printing. */
  args: unknown[];
}

/** Shortens what would print badly: errors, stacks, objects holding them. */
function readable(value: unknown): unknown {
  if (value instanceof Error) {
    return `[${value.name}: ${value.message}]`;
  }
  if (typeof value === "string" && value.includes("\n    at ")) {
    return `${value.split("\n")[0]} …stack`;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, readable(entry)]),
    );
  }
  return value;
}

/** A call log, and a factory for methods that record into it. */
function recorder() {
  const calls: Call[] = [];
  const method = (name: string) => {
    return (...args: unknown[]) => {
      calls.push({ method: name, args: args.map(readable) });
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

/** Prints and clears a recorder's calls. */
function flush(label: string, calls: Call[]): void {
  show(
    label,
    calls.splice(0).map((call) => [call.method, ...call.args]),
  );
}

title("Logging: adapters for existing loggers");

const failure = new Error("db down");

/* ------------------------------------------------------------------ */
step("fromPino — fields object first, message second, the Error under `err`");

const pinoCalls = recorder();
const pino: PinoLike = {
  ...levelMethods(pinoCalls.method),
  child: () => pino,
  level: "info",
  // Delegated to when present.
  isLevelEnabled: (level) => {
    return ["info", "warn", "error", "fatal"].includes(level);
  },
};

const viaPino = fromPino(pino, { name: "api", bindings: { app: "shop" } });
viaPino.info("listening", { port: 3000 });
viaPino.debug("dropped: pino says debug is off");
viaPino.error("query failed", { error: failure, table: "orders" });
flush("pino received", pinoCalls.calls);
show("isLevelEnabled('debug') asks pino", viaPino.isLevelEnabled("debug"));

// AdapterOptions.level gates *before* the library sees anything.
const gated = fromPino(pino, { level: "error" });
gated.warn("dropped by the adapter's own threshold");
show("pino calls after a gated warn", pinoCalls.calls.length);
show("the adapter's default threshold", viaPino.level);

/* ------------------------------------------------------------------ */
step("fromBunyan — the same shape, with bunyan's numeric level");

const bunyanCalls = recorder();
const viaBunyan = fromBunyan({
  ...levelMethods(bunyanCalls.method),
  child: () => ({}),
  // bunyan's `level()` is a function; its numbers match LOG_LEVEL_VALUES.
  level: () => 40,
});
viaBunyan.info("dropped: below bunyan's 40 (warn)");
viaBunyan.warn("disk at 91%", { error: failure });
flush("bunyan received", bunyanCalls.calls);

/* ------------------------------------------------------------------ */
step("fromWinston — log(level, message, meta)");

const winstonCalls = recorder();
const viaWinston = fromWinston({
  log: winstonCalls.method("log"),
  error: winstonCalls.method("error"),
  warn: winstonCalls.method("warn"),
  info: winstonCalls.method("info"),
  silly: winstonCalls.method("silly"),
  transports: [],
  level: "silly",
  // Receives winston's names: trace becomes `silly`, fatal becomes `error`.
  isLevelEnabled: (level) => {
    winstonCalls.method("isLevelEnabled")(level);
    return true;
  },
});
viaWinston.trace("a trace is winston's silly");
viaWinston.error("an error in meta.error", { error: failure });
viaWinston.fatal("fatal is error, flagged in meta", { code: 9 });
flush("winston received", winstonCalls.calls);

/* ------------------------------------------------------------------ */
step("fromConsola — message first, and consola's numeric verbosity");

const consolaCalls = recorder();
const { fatal: _noFatal, ...consolaMethods } = levelMethods(
  consolaCalls.method,
);
const viaConsola = fromConsola({
  ...consolaMethods, // no `fatal`: fatal records fall back to `error`
  withTag: () => ({}),
  level: 3, // info; debug needs 4, trace 5
});
viaConsola.debug("dropped at verbosity 3");
viaConsola.info("shown", { user: "ada" });
viaConsola.fatal("the end", { error: failure });
flush("consola received", consolaCalls.calls);

/* ------------------------------------------------------------------ */
step("fromLog4js — message first; isLevelEnabled gets upper-case names");

const log4jsCalls = recorder();
const viaLog4js = fromLog4js({
  ...levelMethods(log4jsCalls.method),
  addContext: () => {},
  isLevelEnabled: (level) => {
    log4jsCalls.method("isLevelEnabled")(level);
    return level !== "TRACE";
  },
});
viaLog4js.trace("dropped");
viaLog4js.warn("careful", { id: 2 });
flush("log4js received", log4jsCalls.calls);

/* ------------------------------------------------------------------ */
step("fromTslog — levels one-to-one");

const tslogCalls = recorder();
const viaTslog = fromTslog({
  ...levelMethods(tslogCalls.method),
  getSubLogger: () => ({}),
});
viaTslog.fatal("gone", { error: failure });
flush("tslog received", tslogCalls.calls);

/* ------------------------------------------------------------------ */
step(
  "fromNestLogger — info is `log`, trace is `verbose`, the name is the context",
);

const nestCalls = recorder();
const nest: NestLoggerLike = {
  log: nestCalls.method("log"),
  error: nestCalls.method("error"),
  warn: nestCalls.method("warn"),
  debug: nestCalls.method("debug"),
  verbose: nestCalls.method("verbose"),
};
const viaNest = fromNestLogger(nest, { name: "PaymentsService" });
viaNest.trace("deep detail");
viaNest.info("started", { port: 3000 });
viaNest.warn("slow query", { error: failure }); // not error level: the Error itself
viaNest.error("could not start", { error: failure }); // error level: the stack
viaNest.fatal("giving up"); // no `fatal` method: `error`
flush("Nest received", nestCalls.calls);

/* ------------------------------------------------------------------ */
step("fromConsole — anything with log/warn/error");

const consoleCalls = recorder();
const target: ConsoleLike = {
  log: consoleCalls.method("log"),
  warn: consoleCalls.method("warn"),
  error: consoleCalls.method("error"),
};
fromConsole(target, { format: "json", bindings: { app: "cli" } }).info("hi");
flush("the console received", consoleCalls.calls);

/* ------------------------------------------------------------------ */
step("isLogger — already a Logger?");

show("createLogger()", isLogger(createLogger()));
// `false`: a Logger also has `log` and a `bindings` object, which pino lacks,
// so `resolveLogger(pino)` wraps it with `fromPino` rather than passing it on.
show("a pino-shaped object", isLogger(pino));
show("console", isLogger(console));

/* ------------------------------------------------------------------ */
step("resolveLogger — detection, in a fixed order");

const { logger: mine } = createTestLogger();
show("a Logger comes back untouched", resolveLogger(mine) === mine);
show(
  "nothing, with a fallback: the fallback",
  resolveLogger(null, mine) === mine,
);
show("nothing at all: a console logger at info", resolveLogger().level);

const sinkEvents: LogEvent[] = [];
resolveLogger((event) => {
  sinkEvents.push(event);
}).trace("a bare function is a sink, at level trace");
show("the function received", sinkEvents[0]?.message);

// Each shape is checked in this order; the first match wins.
const detect = recorder();
const levels = levelMethods(detect.method);
const shapes: [string, Parameters<typeof resolveLogger>[0]][] = [
  [
    "pino: six levels + child + a string level",
    { ...levels, child: () => ({}), level: "info" },
  ],
  [
    "bunyan: six levels + child + a level function",
    { ...levels, child: () => ({}), level: () => 30 },
  ],
  [
    "winston: log + transports (or silly)",
    { ...levels, log: detect.method("log"), transports: [] },
  ],
  ["consola: withTag", { ...levels, withTag: () => ({}) }],
  ["log4js: six levels + addContext", { ...levels, addContext: () => {} }],
  ["tslog: six levels + getSubLogger", { ...levels, getSubLogger: () => ({}) }],
  [
    "Nest: log/warn/error + verbose",
    {
      log: detect.method("nest.log"),
      warn: detect.method("nest.warn"),
      error: detect.method("nest.error"),
      verbose: detect.method("nest.verbose"),
    },
  ],
  [
    "console: log/warn/error",
    {
      log: detect.method("console.log"),
      warn: detect.method("console.warn"),
      error: detect.method("console.error"),
    },
  ],
];
for (const [label, shape] of shapes) {
  resolveLogger(shape).info("detected");
  const call = detect.calls.splice(0).at(-1);
  show(label, [call?.method, ...(call?.args ?? [])]);
}

// Order matters when an object fits two shapes: withTag is checked before
// addContext, so this is treated as consola — whose verbosity 0 drops the
// info record, where log4js would have written it. When in doubt, name the
// adapter.
resolveLogger({
  ...levels,
  withTag: () => ({}),
  addContext: () => {},
  level: 0,
}).info("both");
show(
  "withTag + addContext + level 0: calls made (consola dropped it)",
  detect.calls.splice(0).length,
);

try {
  resolveLogger({ nope: true } as never);
} catch (error) {
  show("not a logger at all", `${(error as Error).name}`);
}

/* ------------------------------------------------------------------ */
step("BunRouter.logger and setLogger");

const routerCalls = recorder();
const router = new BunRouter({
  debug: true, // log every pipeline layer at debug
  logger: {
    ...levelMethods(routerCalls.method),
    child: () => ({}),
    level: "debug",
  },
});
router.get("/ping", (_req, res) => {
  res.send("pong");
});

const resolved = router.logger;
show("router.logger is a Logger", isLogger(resolved));
show("resolved once: the same instance next time", router.logger === resolved);

await router.fetch("/ping");
flush("the pino-shaped logger received", routerCalls.calls);

// `setLogger` takes any LoggerLike and returns the router, for chaining.
const { logger: testLogger, events } = createTestLogger();
show("setLogger returns the router", router.setLogger(testLogger) === router);
await router.fetch("/ping");
show(
  "the test logger recorded",
  events.map((event) => [event.level, event.message, event.fields.state]),
);

// The `logger` setter takes any LoggerLike too — a sink function here.
const lines: string[] = [];
router.logger = (event) => {
  lines.push(`${event.level}: ${event.message}`);
};
await router.fetch("/ping");
show("the sink function received", lines);

/* ------------------------------------------------------------------ */
step("BunHttpAdapter's `logger` option");

// Resolved once in the constructor and shared with the adapter's router.
const adapter = new BunHttpAdapter(0, { logger: testLogger });
show("adapter.logger is the Logger given", adapter.logger === testLogger);

const adaptedAdapter = new BunHttpAdapter(0, { logger: nest });
show("a Nest logger is adapted", isLogger(adaptedAdapter.logger));
