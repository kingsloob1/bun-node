/**
 * Controlling a runner another process owns — `BunRunnerManager.remote()`.
 *
 * ```bash
 * bun 07-runner/remote-control.ts                        # a shared SQLite file
 * EXAMPLE_DRIVER=file bun 07-runner/remote-control.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 \
 *   bun 07-runner/remote-control.ts
 * ```
 *
 * `helpers/runner-owner.ts` runs as its own process and owns the runner. This
 * process registers no runner at all: an admin service would look like this.
 * It only knows the id, the namespace and the backend, and through
 * `remote(id)` it reads the runner's state, pauses and resumes it,
 * reschedules it and asks for a run, which the owner executes.
 *
 * Worth knowing:
 *
 * - **Every call goes through the backend**, never to the owner directly, so
 *   none of them needs the owner to be reachable. The owner started with
 *   `remoteControl: true` hears each change within the driver's event latency;
 *   without it, it adopts them at its next `syncInterval`.
 * - **A remote trigger is queued**, and the owner drains it. The outcome is
 *   `queued`, not `started`.
 * - **There is no remote kill.** Only the process executing a run can stop it.
 */
import type { CleanupArgs, CleanupResult } from "./handlers/cleanup";
import process from "node:process";
import { BunRunnerManager, createDriver } from "@kingsleyweb/bun-jobs";
import { crossProcessDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

title("Remote runner control");

const config = crossProcessDriver();
const namespace = exampleNamespace("remote-control");

/* ------------------------------------------------------------------ */
step("Start the owner in its own process");

const owner = Bun.spawn(
  [
    process.execPath,
    new URL("./helpers/runner-owner.ts", import.meta.url).pathname,
  ],
  {
    env: {
      ...process.env,
      NAMESPACE: namespace,
      DRIVER_CONFIG: JSON.stringify(config),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  },
);

// However this example ends, the owner does not outlive it.
process.once("exit", () => owner.kill("SIGKILL"));

/** What the owner has printed so far, one parsed JSON line each. */
const seen: { event: string; pid: number; [field: string]: unknown }[] = [];
void (async () => {
  let buffered = "";
  for await (const chunk of owner.stdout.pipeThrough(new TextDecoderStream())) {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    // The handler's own log lines share stdout; only the reports are JSON.
    for (const line of lines.filter((text) => text.startsWith("{"))) {
      seen.push(JSON.parse(line) as (typeof seen)[number]);
    }
  }
})();

/** Waits for the owner to print `event`, and returns that line. */
async function ownerSays(event: string) {
  const from = seen.length;
  await waitFor(
    `the owner to report "${event}"`,
    () => seen.slice(from).some((line) => line.event === event),
    { timeout: 30_000, interval: 10 },
  );
  return seen.slice(from).find((line) => line.event === event)!;
}

await waitFor(
  "the owner to start",
  () => seen.some((line) => line.event === "ready"),
  { timeout: 30_000, interval: 10 },
);
show("owner pid", owner.pid);
show("this pid", process.pid);

/* ------------------------------------------------------------------ */
step("remote(id) from a process that registered nothing");

const driver = createDriver(config);
// `jobs.runners.remote(id)` on a `BunJobs` is the same call.
const manager = new BunRunnerManager({ namespace, driver });
show("registered here", manager.size);
show("known to the backend", await manager.discover());

const cleanup = await manager.remote<CleanupArgs, CleanupResult>(
  "nightly-cleanup",
);
const info = await cleanup.info();
show("isLocal", cleanup.isLocal);
show("info()", {
  name: info.name,
  schedule: info.schedule,
  nextRunAt: info.nextRunAt?.toISOString(),
  executionMode: info.executionMode,
  runMode: info.runMode,
  isPaused: info.isPaused,
  isRunning: info.isRunning,
});

await manager.remote("no-such-runner").catch((error: Error) => {
  show("remote('no-such-runner')", `${error.name}: ${error.message}`);
});

/* ------------------------------------------------------------------ */
step("pause(): the owner adopts it");

let started = performance.now();
await cleanup.pause();
await ownerSays("paused");
show("owner paused after", `${Math.round(performance.now() - started)}ms`);
show("a trigger while paused", await cleanup.trigger());

/* ------------------------------------------------------------------ */
step("updateSchedule() and resume()");

await cleanup.updateSchedule({ cron: "30 4 * * *", tz: "UTC" });
show("owner re-armed its ticker", (await ownerSays("scheduled")).schedule);

await cleanup.resume();
await ownerSays("resumed");
show("isPaused", (await cleanup.info()).isPaused);

/* ------------------------------------------------------------------ */
step("trigger(): queued here, run by the owner");

started = performance.now();
show(
  "outcome",
  await cleanup.trigger({ args: { olderThanDays: 7, batchSize: 50 } }),
);
const finished = await ownerSays("finished");
show("ran in pid", finished.pid);
show("owner finished it after", `${Math.round(performance.now() - started)}ms`);
show("result, as the owner saw it", finished.result);

// History is written just after the owner's `finished` event.
await waitFor(
  "the run to be recorded",
  async () => (await cleanup.stats()).success === 1,
  { timeout: 10_000, interval: 10 },
);
const [lastRun] = await cleanup.history(1);
show("history(1)[0]", {
  source: lastRun?.source,
  status: lastRun?.status,
  result: lastRun?.result,
});
show("stats()", await cleanup.stats());

/* ------------------------------------------------------------------ */
step("Stop the owner; there is no remote kill");

show("'kill' in the controller", "kill" in cleanup);
owner.kill("SIGTERM");
show("owner exit code", await owner.exited);

await driver.purge(namespace);
await driver.close();
