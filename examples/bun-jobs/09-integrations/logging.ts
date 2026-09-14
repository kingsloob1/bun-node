/**
 * Logging — structured logs from every queue, worker, job and runner, into
 * whatever logger you already use.
 *
 * ```bash
 * bun 09-integrations/logging.ts
 * ```
 *
 * Every option named `logger` accepts a `LoggerLike`: bun-common's structured
 * `Logger`, a bare sink function `(event) => void`, or an existing pino,
 * bunyan, winston, consola, log4js, tslog, NestJS or console-shaped logger —
 * detected by shape and adapted, with nothing imported.
 *
 * Each object binds the fields that identify it (`namespace`, `queue`,
 * `workerId`, `jobId`, `runnerId`, `runId`, ...), so a line from inside a job
 * already says which job without every call site repeating it.
 */
import type { LogEvent } from "@kingsleyweb/bun-common";
import {
  collectSink,
  consoleSink,
  createLogger,
  multiSink,
} from "@kingsleyweb/bun-common";
import { BunJobs } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

title("Logging");

/* ------------------------------------------------------------------ */
step("A structured logger: JSON lines to stdout, and kept for inspection");

const events: LogEvent[] = [];

const logger = createLogger({
  name: "billing-service",
  level: "debug",
  bindings: { service: "billing", version: "1.4.0" }, // on every line
  sink: multiSink(consoleSink({ format: "json" }), collectSink(events)),
});

const jobs = new BunJobs({
  namespace: exampleNamespace("billing"),
  driver: exampleDriver(),
  logger, // reaches every queue, worker and runner created from `jobs`
});

jobs.define<{ invoiceId: string; cents: number }>(
  "chargeInvoice",
  async (job, ctx) => {
    // `ctx.logger` is bound to this job: its id, name, queue, worker, attempt.
    ctx.logger.info("charging", { cents: job.data.cents });

    if (job.data.cents > 100_000) {
      const error = new Error("amount needs manual approval");
      // Errors go in `fields.error` — sinks find them in one place.
      ctx.logger.error("charge refused", { error });
      throw error;
    }

    ctx.logger.debug("charged");
    return "ok";
  },
);

await jobs.start({ pollInterval: 25 });
await jobs.now("chargeInvoice", { invoiceId: "inv_1", cents: 4_999 });
await jobs.now("chargeInvoice", { invoiceId: "inv_2", cents: 250_000 });

await waitFor("both jobs' final lines", () => {
  return (
    events.some((event) => event.message === "charged") &&
    events.some((event) => event.message === "charge refused")
  );
});

/* ------------------------------------------------------------------ */
step("What one line carries");

const refused = events.find((event) => event.message === "charge refused");
show("level / name / message", [
  refused?.level,
  refused?.name,
  refused?.message,
]);
show(
  "bindings (from the logger and the worker's child loggers)",
  refused?.bindings,
);
show("fields (from this call — the error is lifted out)", refused?.fields);
show(
  "error",
  refused?.error && `${refused.error.name}: ${refused.error.message}`,
);

await jobs.purge();
await jobs.close();

/* ------------------------------------------------------------------ */
step("Or hand it a function, or the logger you already have");

const lines: string[] = [];
const withSink = new BunJobs({
  namespace: exampleNamespace("sink"),
  // A bare sink: every event, as one object.
  logger: (event) => {
    lines.push(`${event.level.toUpperCase()} ${event.message}`);
  },
});
withSink.logger.warn("this went through a plain function");
show("captured by the function", lines);
await withSink.close();

// pino / winston / consola / console-like loggers are passed the same way:
//   new BunJobs({ namespace, driver, logger: pino() })
//   new BunJobs({ namespace, driver, logger: winston.createLogger(...) })
//   new BunJobs({ namespace, driver, logger: console })
// and silenced with `noopLogger` from @kingsleyweb/bun-common.
