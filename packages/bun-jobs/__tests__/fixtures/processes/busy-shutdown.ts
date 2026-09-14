import process from "node:process";
import { noopLogger, sleep } from "@kingsleyweb/bun-common";
import { BunJobs } from "../../../lib/index";

/**
 * A consumer shutting down on SIGTERM while jobs are still running — the shape
 * that used to be cut off halfway through `jobs.close()`.
 *
 * The worker does not hold the process (`waitToExit: false`), and the only
 * thing that does, a keep-alive interval, is cleared first thing in the signal
 * handler. So from the moment the signal arrives, `close()` is all that keeps
 * the process up until the handler's last line has run.
 *
 * Each job waits on an unref'd timer, and the signal arrives while several are
 * in flight. That is what cut shutdown short: `close()` waiting on work whose
 * only pending wait is one the event loop does not count — as a SQLite lock
 * retry under contention is. Without a hold, Bun sees nothing left to do and
 * exits before `close()` resolves.
 */

const jobs = new BunJobs({
  namespace: "busy-shutdown",
  driver: { type: "sql", url: `sqlite://${process.env.DB}` },
  logger: noopLogger,
});

let processed = 0;
const worker = jobs.worker(
  "orders",
  async () => {
    await sleep(30, { unref: true });
    processed++;
    return null;
  },
  { pollInterval: 25, concurrency: 8, waitToExit: false },
);

const keepAlive = setInterval(() => {
  if (processed >= 50) {
    process.kill(process.pid, "SIGTERM");
  }
}, 5);

process.once("SIGTERM", () => {
  clearInterval(keepAlive);
  void (async () => {
    await jobs.close({ timeout: 5_000 });
    console.log(JSON.stringify({ event: "closed", processed }));
  })();
});

await jobs.queue("orders").addBulk(
  Array.from({ length: 200 }, (_, index) => ({
    name: "order",
    data: { index },
  })),
);
void worker.run();
