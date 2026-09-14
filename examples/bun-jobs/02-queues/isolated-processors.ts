/**
 * Isolated processors — run each job in a `Worker` or a child process.
 *
 * ```bash
 * bun 02-queues/isolated-processors.ts
 * ```
 *
 * Give a worker a processor **file** instead of a function, and `isolation`
 * decides where each attempt runs:
 *
 * | `isolation` | Where | Can be stopped by force | Cost per attempt |
 * |---|---|---|---|
 * | `"in-process"` (default) | the worker's thread, imported once | no | nothing |
 * | `"worker"` | a fresh `Worker`: own JS context, same process | yes (`terminate`) | a thread |
 * | `"spawn"` | a child process | yes (`SIGTERM` → `SIGKILL`) | a process |
 *
 * Reach for it when a processor is CPU-heavy, leaky, uses native code that can
 * crash, or must be killable even when it ignores `ctx.signal`. The worker —
 * claiming, locks, heartbeats, retries — stays in the parent; the child only
 * runs the processor. From inside, `job.updateProgress`, `job.log`,
 * `job.touch` and `ctx.heartbeat`/`ctx.log` work through the parent; methods
 * that change the stored job directly (`updateData`, `remove`, ...) are not
 * available there.
 */
import type { Thumbnail, ThumbnailResult } from "./processors/thumbnail";
import process from "node:process";
import {
  BunQueue,
  BunQueueWorker,
  ConfigError,
  createDriver,
} from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

title("Isolated processors");

const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("media");
const thumbnailFile = new URL("./processors/thumbnail.ts", import.meta.url);

show("this process", { pid: process.pid });

/* ------------------------------------------------------------------ */
step("The same processor file in each isolation mode");

for (const isolation of ["in-process", "worker", "spawn"] as const) {
  const queueName = `thumbnails-${isolation}`;
  const queue = new BunQueue<Thumbnail, ThumbnailResult>(queueName, {
    namespace,
    driver,
  });

  const worker = new BunQueueWorker<Thumbnail, ThumbnailResult>(
    queueName,
    thumbnailFile, // a path or URL, not a function
    {
      namespace,
      driver,
      isolation,
      isolationOptions: {
        spawn: { env: { THUMBNAIL_QUALITY: "80" } },
        worker: { smol: true },
      },
      pollInterval: 20,
    },
  );
  void worker.run();

  const started = performance.now();
  const job = await queue.add("shrink", { imageId: 7, size: 128 });
  await waitFor(`the ${isolation} job`, async () => {
    return (await job.refresh())?.state === "completed";
  });

  const done = await job.refresh();
  show(isolation.padEnd(10), {
    result: done?.returnValue,
    sameProcess: done?.returnValue?.pid === process.pid,
    progress: done?.progress,
    log: (await job.getLogs()).logs,
    tookMs: Math.round(performance.now() - started),
  });

  await worker.close();
  await queue.close();
}

/* ------------------------------------------------------------------ */
step("A runaway processor, stopped anyway in a child process");

const runaway = new BunQueue<{ spinMs: number }, string>("runaway", {
  namespace,
  driver,
});
const guarded = new BunQueueWorker<{ spinMs: number }, string>(
  "runaway",
  new URL("./processors/runaway.ts", import.meta.url),
  {
    namespace,
    driver,
    isolation: "spawn",
    isolationOptions: {
      closeTimeout: 200, // after the timeout aborts it: time to unwind…
      killTimeout: 200, // …then SIGTERM, and this long before SIGKILL
    },
    pollInterval: 20,
  },
);
void guarded.run();

const began = performance.now();
const spinning = await runaway.add(
  "spin",
  { spinMs: 60_000 }, // a minute of blocked CPU
  { timeout: 300 }, // …with a 300ms budget
);
await waitFor("the runaway job to die", async () => {
  return (await spinning.refresh())?.state === "dead";
});

const stopped = await spinning.refresh();
show("state", stopped?.state);
show("reason", stopped?.failedReason?.message);
show(
  "stopped after",
  `${Math.round(performance.now() - began)}ms of a 60000ms spin`,
);

await guarded.close();
await runaway.close();

/* ------------------------------------------------------------------ */
step("A function cannot be isolated");

try {
  // eslint-disable-next-line no-new
  new BunQueueWorker("nope", async () => "x", {
    namespace,
    driver,
    isolation: "spawn",
  });
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  show("ConfigError", error.message);
}

await driver.purge(namespace);
await driver.close();
