import type { DriverConfig } from "./shared";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { BunRunner, createDriver, noopLogger } from "./shared";

/**
 * One runner instance, as a separate process.
 *
 * Everything it needs arrives through the environment, and everything it
 * reports goes to stdout as JSON lines, so the test sees this process's own
 * view of what happened rather than inferring it.
 */

const runner = new BunRunner({
  id: process.env.RUNNER_ID ?? "shared",
  namespace: process.env.NAMESPACE ?? "test",
  file: process.env.HANDLER_FILE ?? "",
  executionMode: "in-process",
  runMode: "single",
  queueRuns: process.env.QUEUE_RUNS === "1",
  // Any backend: the test decides, and the runner cannot tell the difference.
  driver: createDriver(
    process.env.DRIVER_CONFIG
      ? (JSON.parse(process.env.DRIVER_CONFIG) as DriverConfig)
      : { type: "file", root: process.env.DRIVER_ROOT ?? "" },
  ),
  waitToExit: false,
  logger: noopLogger,
  args: {
    marker: process.env.MARKER ?? "",
    log: process.env.RUN_LOG ?? "",
    ms: Number(process.env.RUN_MS ?? 100),
    // With DECIDED_DIR, a run is held until every participant has decided.
    ...(process.env.DECIDED_DIR
      ? {
          holdUntil: {
            dir: process.env.DECIDED_DIR,
            count: Number(process.env.PARTICIPANTS ?? 2),
          },
        }
      : {}),
  },
});

const finished = new Promise<void>((resolve) => {
  runner.once("finished", () => resolve());
  runner.once("failed", () => resolve());
});

/**
 * Runs that finished in *this* process. `stats()` cannot say that: its
 * counters live in the driver, shared by every process on the runner.
 */
let localRuns = 0;
runner.on("finished", () => {
  localRuns += 1;
});

/** How long a handshake below waits before giving up, ms. */
const WAIT_LIMIT_MS = 20_000;

/** Polls `ready` until it holds or the limit passes. */
async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!ready() && Date.now() < deadline) {
    await Bun.sleep(5);
  }
}

/** Entries in DECIDED_DIR: how many processes have decided so far. */
function decidedCount(): number {
  try {
    return readdirSync(process.env.DECIDED_DIR ?? "").length;
  } catch {
    return 0;
  }
}

await runner.start();

// AWAIT_DECIDED: trigger only once that many other processes have decided —
// "arrive while the lock is held" as a handshake, not a head start in time.
if (process.env.AWAIT_DECIDED) {
  const count = Number(process.env.AWAIT_DECIDED);
  await waitFor(() => decidedCount() >= count);
}

const outcome = await runner.trigger();
console.log(JSON.stringify({ event: "trigger", outcome }));

// Tell a held run (see the `append` handler) that this process has decided.
if (process.env.DECIDED_DIR) {
  writeFileSync(join(process.env.DECIDED_DIR, process.env.MARKER ?? ""), "");
}

if (outcome.outcome === "started") {
  await finished;
}

// AWAIT_RUNS: stay until this process has finished that many runs — the
// lock holder draining what another process queued — rather than for a time.
if (process.env.AWAIT_RUNS) {
  const count = Number(process.env.AWAIT_RUNS);
  await waitFor(() => localRuns >= count);
}

console.log(
  JSON.stringify({
    event: "done",
    stats: await runner.stats(),
    queued: (await runner.info()).queuedTriggers,
    localRuns,
  }),
);

await runner.stop();
process.exit(0);
