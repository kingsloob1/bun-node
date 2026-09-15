/**
 * A structured logger — six levels, fields on every call, child loggers with
 * bound context, and errors that sinks find in one place.
 *
 * ```bash
 * bun 10-logging/structured-logger.ts
 * ```
 *
 * `createLogger` is the only `Logger` implementation in bun-common. Every
 * adapter and `createTestLogger` is built on it, so what this file shows holds
 * for all of them. Each level method takes `(message, fields?)` — a string or
 * an `Error`, then an object — never a variadic argument list, so a call site
 * cannot pass something a backend will silently drop.
 */
import type { LogEvent, LogFields } from "@kingsleyweb/bun-common";
import {
  collectSink,
  createLogger,
  LOG_LEVEL_VALUES,
  LOG_LEVELS,
} from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

/** One readable line per event: level, name, message, context, error. */
function summarise(event: LogEvent): string {
  const parts = [event.level.padEnd(5), event.message];
  if (event.name !== undefined) {
    parts.splice(1, 0, `[${event.name}]`);
  }

  const context = { ...event.bindings, ...event.fields };
  if (Object.keys(context).length > 0) {
    parts.push(JSON.stringify(context));
  }
  if (event.error) {
    parts.push(`error=${event.error.name}: ${event.error.message}`);
  }

  return parts.join(" ");
}

title("Logging: a structured logger");

/* ------------------------------------------------------------------ */
step("The default: threshold `info`, pretty lines on the console");

const plain = createLogger();
show("level / name / bindings", {
  level: plain.level,
  name: plain.name,
  bindings: plain.bindings,
});
plain.info("service started", { port: 8080 });
plain.debug("never printed: below the info threshold");

/* ------------------------------------------------------------------ */
step("Every CreateLoggerOptions field");

const events: LogEvent[] = [];
let clock = Date.parse("2026-01-01T09:00:00.000Z");
let verbose = false;

const logger = createLogger({
  level: "trace", // the threshold; `"silent"` drops everything
  name: "billing", // shown by sinks, inherited by children
  bindings: { service: "billing", region: "eu-west-1" }, // on every event
  sink: collectSink(events), // where events go; the console by default
  // Consulted alongside `level` — both must allow a record. Adapters use it
  // to let the wrapped library decide; here it is a runtime switch.
  enabled: (level) => {
    return level !== "trace" || verbose;
  },
  // The clock for `LogEvent.time`; `Date.now` by default.
  time: () => {
    clock += 1000;
    return clock;
  },
});

/* ------------------------------------------------------------------ */
step("Six levels, one signature");

for (const level of LOG_LEVELS) {
  logger[level](`a ${level} record`, { severity: LOG_LEVEL_VALUES[level] });
}
show("recorded (trace is off until `verbose`)", events.map(summarise));

verbose = true;
logger.trace("now trace gets through");
logger.log("`log` is `info`, for console-style call sites");
show("recorded", events.slice(-2).map(summarise));
show(
  "timestamps come from the `time` option",
  events.slice(-2).map((event) => new Date(event.time).toISOString()),
);
events.length = 0;

/* ------------------------------------------------------------------ */
step("isLevelEnabled: skip work nobody will read");

const quiet = createLogger({ level: "warn", sink: collectSink(events) });
let reportsBuilt = 0;

/** Something costly to put in a log record. */
function buildReport(): LogFields {
  reportsBuilt++;
  return { rows: 10_000 };
}

if (quiet.isLevelEnabled("debug")) {
  quiet.debug("report", buildReport());
}
show("debug enabled at a warn threshold?", quiet.isLevelEnabled("debug"));
show("reports built", reportsBuilt);
show("error enabled?", quiet.isLevelEnabled("error"));

/* ------------------------------------------------------------------ */
step("child(): bound context, and optionally its own name or threshold");

// Bindings merge over the parent's; the latest value of a key wins.
const request = logger.child({ requestId: "req-42", region: "us-east-1" });
request.info("charging card", { cents: 1999 });

// A grandchild keeps everything above it.
request.child({ step: "capture" }).info("captured");

// A new name and a stricter threshold.
const worker = logger.child(
  { workerId: 3 },
  { name: "billing.worker", level: "warn" },
);
worker.info("dropped: the child's threshold is warn");
worker.warn("retrying", { attempt: 2 });

logger.info("the parent is untouched");

show("recorded", events.map(summarise));
show("the worker child", {
  name: worker.name,
  level: worker.level,
  bindings: worker.bindings,
});
events.length = 0;

/* ------------------------------------------------------------------ */
step("Errors are lifted onto LogEvent.error");

const declined = new Error("card declined");
declined.name = "PaymentError";

// An Error as the message: its message becomes the record's.
logger.error(declined);

// An Error under `fields.error`: moved out of the fields.
const fields = { error: declined, orderId: "o-1" };
logger.error("charge failed", fields);

// Anything else under `error` is just a field.
logger.warn("odd response", { error: "timeout" });

show(
  "records",
  events.map((event) => {
    return {
      message: event.message,
      error: event.error === declined ? "the PaymentError" : event.error,
      fields: event.fields,
    };
  }),
);
show("the caller's fields object is not changed", Object.keys(fields));
events.length = 0;

/* ------------------------------------------------------------------ */
step("`silent`: a threshold above every level");

const silent = createLogger({ level: "silent", sink: collectSink(events) });
silent.fatal("never recorded");
show("records", events.length);
show("fatal enabled?", silent.isLevelEnabled("fatal"));
