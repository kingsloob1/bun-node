import type { DriverConfig } from "./shared";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { BunJobs, noopLogger } from "./shared";

/**
 * A consumer, as its own process.
 *
 * Every job it takes is appended to a shared log with this process's id, so
 * the test can prove that each job was processed exactly once and see which
 * consumer took it.
 */

const jobs = new BunJobs({
  namespace: process.env.NAMESPACE ?? "test",
  driver: JSON.parse(process.env.DRIVER_CONFIG ?? "{}") as DriverConfig,
  logger: noopLogger,
});

const consumerId = process.env.CONSUMER_ID ?? String(process.pid);
const log = process.env.RUN_LOG ?? "";
/** Where to append this consumer's id once its worker is claiming, if anywhere. */
const readyLog = process.env.READY_LOG ?? "";
const failFirst = process.env.FAIL_FIRST === "1";
/**
 * How many consumers must have taken a job before this one finishes any, if
 * set (`SHARE_WITH`). Each job waits, after it is logged, until `RUN_LOG`
 * names that many consumers, so a consumer cannot run the whole queue alone
 * however the scheduler orders the processes: its jobs in hand hold its
 * `concurrency` slots, and the next job can go only to another consumer.
 */
const shareWith = Number(process.env.SHARE_WITH ?? 0);
/** How long a job waits for the others before going on anyway, in ms. */
const SHARE_WAIT_MS = 30_000;
const seen = new Set<string>();

/**
 * Waits until `RUN_LOG` names `shareWith` consumers, or `SHARE_WAIT_MS` has
 * passed: a consumer that never arrives then shows as a test failure (one
 * consumer did everything) rather than a hang.
 */
async function sharedWithOthers(): Promise<void> {
  const until = Date.now() + SHARE_WAIT_MS;
  while (Date.now() < until) {
    const lines = (await Bun.file(log).text()).split("\n").filter(Boolean);
    if (new Set(lines.map((line) => line.split(":")[0])).size >= shareWith) {
      return;
    }
    await Bun.sleep(10);
  }
}

const worker = jobs.worker(
  process.env.QUEUE ?? "work",
  async (job) => {
    // A job that fails its first attempt proves a retry is picked up by
    // whichever consumer is free, not necessarily the one that failed it.
    if (failFirst && !seen.has(job.id)) {
      seen.add(job.id);
      throw new Error(`first attempt at ${job.id} failed`);
    }

    if (log) {
      appendFileSync(log, `${consumerId}:${job.id}\n`);
      if (shareWith > 1) {
        await sharedWithOthers();
      }
    }

    await Bun.sleep(Number(process.env.JOB_MS ?? 5));
    return { by: consumerId };
  },
  {
    id: consumerId,
    concurrency: Number(process.env.CONCURRENCY ?? 2),
    pollInterval: 20,
    maxBlock: 50,
    lockDuration: 2000,
    stalledInterval: 200,
  },
);

// Surfaced rather than swallowed: a worker that stops consuming should say
// why in the test's output, not leave a stalled queue to be puzzled over.
worker.on("error", (error, context) => {
  console.error(`worker error (${context}): ${error.message}`);
});

// Ready means claiming: the worker's own `ready` comes once it has connected,
// made the queue and adopted its control entries, just before the claim loop
// starts. Announced straight after `run()` instead, it came first and the loop
// up to hundreds of milliseconds later under load. The line goes to
// `READY_LOG` too, when set, because a test waits on that file.
worker.on("ready", () => {
  if (readyLog) {
    appendFileSync(readyLog, `${consumerId}\n`);
  }
  console.log(JSON.stringify({ event: "ready", consumerId }));
});

void worker.run();

/** How many processed lines the test is waiting for, if it said. */
const stopAfter = Number(process.env.STOP_AFTER ?? 0);

/** How long to keep consuming regardless, as a backstop. */
const deadline = Date.now() + Number(process.env.RUN_FOR_MS ?? 2000);

/** Lines every consumer has appended so far. */
const processedCount = async (): Promise<number> => {
  if (!log) {
    return 0;
  }
  const contents = await Bun.file(log)
    .text()
    .catch(() => "");
  return contents.split("\n").filter(Boolean).length;
};

// Stop on the signal rather than on a stopwatch. A fixed lifetime makes a
// test's outcome depend on how loaded the machine is, which is how a suite
// acquires flakes; the deadline stays only as a backstop.
while (Date.now() < deadline) {
  if (stopAfter > 0 && (await processedCount()) >= stopAfter) {
    break;
  }
  await Bun.sleep(25);
}

await worker.close({ timeout: 2000 });

console.log(JSON.stringify({ event: "closed", consumerId }));
await jobs.close();
process.exit(0);
