/**
 * Retries and backoff — built-in strategies, and your own.
 *
 * ```bash
 * bun 06-failures/retries-and-backoff.ts
 * ```
 *
 * `attempts` is the total number of tries; `backoff` is the wait between
 * them. Built in: `fixed`, `exponential`, `linear`, `fibonacci`, `full-jitter`
 * and `decorrelated-jitter`, each tuned by `delay`, `factor`, `max` and
 * `jitter`. A bare number is `{ type: "fixed", delay }`. The default is
 * exponential from 1s, capped at 5 minutes, with jitter.
 *
 * A custom strategy is registered by *name* with `jobs.defineBackoff()` (or a
 * worker's `backoffStrategies`), because a job's options are stored and a
 * function cannot be. It returns milliseconds, or `false` to stop retrying
 * now. Every process that consumes such jobs must define it too.
 */
import { BunJobs } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** What a sync job carries. */
interface Sync {
  /** Which scenario to act out. */
  scenario: string;
  /** How many attempts fail before one succeeds. */
  failures: number;
  /** The error message a failing attempt throws. */
  error: string;
}

title("Retries and backoff");

const jobs = new BunJobs({
  namespace: exampleNamespace("retries"),
  driver: exampleDriver(),
});

// Honour a "retry after" the upstream sent, never retry a bad credential,
// and otherwise back off linearly from the job's own `delay`.
jobs.defineBackoff("upstreamAware", ({ error, attempt, options }) => {
  const retryAfter = /retry after (\d+)ms/.exec(error.message);
  if (retryAfter) return Number(retryAfter[1]);
  if (/invalid api key/i.test(error.message)) return false;
  return (options.delay ?? 100) * attempt;
});

jobs.define<Sync>("syncOrders", async (job, ctx) => {
  if (ctx.attempt <= job.data.failures) {
    throw new Error(job.data.error);
  }
  return `${job.data.scenario}: ok on attempt ${ctx.attempt}`;
});

const worker = await jobs.start({ concurrency: 5, pollInterval: 10 });

/** Scenario name → the waits observed before each retry. */
const waits = new Map<string, number[]>();
/** Scenario name → how it ended. */
const outcomes = new Map<string, string>();

worker.on("retrying", (job, _error, runAt) => {
  const { scenario } = job.data as Sync;
  // Rounded to 10ms: the wait is computed a moment before this runs.
  const wait = Math.round((runAt - Date.now()) / 10) * 10;
  waits.set(scenario, [...(waits.get(scenario) ?? []), wait]);
});
worker.on("completed", (job, result) => {
  outcomes.set((job.data as Sync).scenario, String(result));
});
worker.on("dead", (job, error) => {
  outcomes.set(
    (job.data as Sync).scenario,
    `dead after ${job.attemptsMade} attempt(s): ${error.message}`,
  );
});

const scenarios: [Sync, Parameters<typeof jobs.now>[2]][] = [
  [
    { scenario: "fixed", failures: 2, error: "timeout" },
    { attempts: 3, backoff: 80 },
  ],
  [
    { scenario: "exponential", failures: 3, error: "timeout" },
    { attempts: 4, backoff: { type: "exponential", delay: 50, factor: 2 } },
  ],
  [
    { scenario: "exponential, capped", failures: 4, error: "timeout" },
    { attempts: 5, backoff: { type: "exponential", delay: 50, max: 150 } },
  ],
  [
    { scenario: "linear", failures: 3, error: "timeout" },
    { attempts: 4, backoff: { type: "linear", delay: 40 } },
  ],
  [
    { scenario: "fibonacci", failures: 4, error: "timeout" },
    { attempts: 5, backoff: { type: "fibonacci", delay: 30 } },
  ],
  [
    {
      scenario: "custom: retry-after",
      failures: 1,
      error: "429, retry after 250ms",
    },
    { attempts: 3, backoff: { type: "upstreamAware" } },
  ],
  [
    { scenario: "custom: give up", failures: 5, error: "Invalid API key" },
    { attempts: 5, backoff: { type: "upstreamAware" } },
  ],
  [
    { scenario: "attempts exhausted", failures: 9, error: "still down" },
    { attempts: 2, backoff: 20 },
  ],
];

step("Adding one job per scenario");

for (const [data, options] of scenarios) {
  await jobs.now("syncOrders", data, options);
}

await waitFor(
  "every scenario to finish",
  () => outcomes.size === scenarios.length,
);

step("Waits before each retry, and how each ended");

for (const [{ scenario }] of scenarios) {
  show(scenario.padEnd(20), {
    waits: waits.get(scenario) ?? [],
    outcome: outcomes.get(scenario),
  });
}

await jobs.purge();
await jobs.close();
