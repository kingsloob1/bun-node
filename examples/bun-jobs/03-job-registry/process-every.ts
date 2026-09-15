/**
 * Registry polling — `processEvery`, as an option and as a method.
 *
 * ```bash
 * bun 03-job-registry/process-every.ts
 * EXAMPLE_DRIVER=postgres EXAMPLE_POSTGRES_URL=postgres://user:pass@localhost/jobs bun 03-job-registry/process-every.ts
 * ```
 *
 * `processEvery` says how often the registry worker looks for due work:
 * milliseconds, or a duration such as `"30 seconds"` (a leading "every" is
 * allowed). It sets the worker's `pollInterval` and, on a driver that waits by
 * blocking (Redis, memory), its `maxBlock` as well.
 *
 * What it does **not** do is delay a new job: an idle worker is woken by a
 * new job on every driver. It bounds work nothing announces — a delayed job
 * coming due — so it trades idle load, not latency.
 *
 * Precedence: the `processEvery` option is the same as calling the method
 * before `start()`; explicit `pollInterval` / `maxBlock` given to `start()`
 * win over it; a later `processEvery()` call wins over both, on the running
 * worker at once and on every later `start()`.
 */
import { BunJobs, ConfigError } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

title("Job registry: processEvery");

const jobs = new BunJobs({
  namespace: exampleNamespace("polling"),
  driver: exampleDriver(),
  // The same as calling `jobs.processEvery("2 seconds")` before `start()`.
  processEvery: "2 seconds",
});

/** When each ping was handled, by its label. */
const handled = new Map<string, number>();

jobs.define<{ label: string }>("ping", async (job) => {
  handled.set(job.data.label, Date.now());
});

const blocking = jobs.driver.capabilities.blockingWait;
show("driver", { name: jobs.driver.name, blockingWait: blocking });

/* ------------------------------------------------------------------ */
step("The option, applied by start()");

let worker = await jobs.start();
show("worker", {
  pollInterval: worker.pollInterval,
  // Follows only on a blocking driver; elsewhere it keeps its 5s default.
  maxBlock: worker.maxBlock,
});

/* ------------------------------------------------------------------ */
step("A new job is not held back by the interval");

const addedAt = Date.now();
await jobs.now("ping", { label: "new" });
await waitFor("the new ping", () => handled.has("new"));
show("picked up after", `${handled.get("new")! - addedAt}ms`);

/* ------------------------------------------------------------------ */
step("processEvery() on a running worker");

jobs.processEvery("every 250ms");
show("worker, changed in place", {
  pollInterval: worker.pollInterval,
  maxBlock: worker.maxBlock,
});

const dueAt = Date.now() + 500;
await jobs.run("ping", { label: "delayed" }).on(dueAt).start();
await waitFor("the delayed ping", () => handled.has("delayed"));
show(
  "delayed ping ran after it came due by",
  `${handled.get("delayed")! - dueAt}ms`,
);

/* ------------------------------------------------------------------ */
step("start()'s own options win; a later processEvery() wins over them");

await jobs.stop();
worker = await jobs.start({ pollInterval: 40, maxBlock: 60 });
show("explicit start() options", {
  pollInterval: worker.pollInterval,
  maxBlock: worker.maxBlock,
});

jobs.processEvery(90);
show("after processEvery(90)", {
  pollInterval: worker.pollInterval,
  maxBlock: worker.maxBlock, // 90 only where the driver blocks
});

/* ------------------------------------------------------------------ */
step("Pausing keeps the interval; resuming picks up where it left off");

await worker.pause();
jobs.processEvery("100ms");
await jobs.now("ping", { label: "while-paused" });
await Bun.sleep(300);
show("ran while paused", handled.has("while-paused"));

worker.resume();
await waitFor("the paused ping", () => handled.has("while-paused"));
show("ran after resume", { pollInterval: worker.pollInterval });

/* ------------------------------------------------------------------ */
step("Any worker's intervals can be changed at runtime");

const reports = jobs.worker("reports", async () => null);
reports.pollInterval = 5_000;
reports.maxBlock = 10_000;
show("reports worker (not started: nothing is armed yet)", {
  pollInterval: reports.pollInterval,
  maxBlock: reports.maxBlock,
});

/* ------------------------------------------------------------------ */
step("What is refused");

for (const bad of [0, "whenever", "30 days"]) {
  try {
    jobs.processEvery(bad);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    show(`processEvery(${JSON.stringify(bad)})`, error.message);
  }
}

try {
  reports.pollInterval = -1;
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  show("worker.pollInterval = -1", error.message);
}

await jobs.stop();
await jobs.purge();
await jobs.close();
