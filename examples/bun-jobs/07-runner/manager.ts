/**
 * Managing many runners — `jobs.runners`, a `BunRunnerManager`.
 *
 * ```bash
 * bun 07-runner/manager.ts
 * ```
 *
 * Every runner created with `jobs.runner()` is registered with the context's
 * manager, so a service starts, inspects and stops all of them in one call —
 * and `jobs.close()` stops them with everything else.
 *
 * A runner's paused flag and schedule live in the backend, not in the
 * instance. Pausing from an admin endpoint in one process pauses the runner on
 * every host; an instance started later adopts the stored state rather than
 * its constructor's options.
 */
import { BunJobs, createDriver } from "@kingsleyweb/bun-jobs";
import { crossProcessDriver, exampleNamespace } from "../shared/backend";
import { show, step, title } from "../shared/console";

title("Runner manager");

const namespace = exampleNamespace("platform");
// An instance, so a second context below can share the same backend.
const driver = createDriver(crossProcessDriver());

const jobs = new BunJobs({
  namespace,
  driver,
  // Merged under every runner created here.
  runnerDefaults: { executionMode: "in-process", keepHistory: 10 },
});

const cleanup = new URL("./handlers/cleanup.ts", import.meta.url);

jobs.runner({ id: "purge-sessions", file: cleanup, schedule: "*/5 * * * *" });
jobs.runner({
  id: "rotate-keys",
  file: cleanup,
  schedule: { cron: "0 3 * * 0", tz: "UTC" },
});
jobs.runner({ id: "compact-audit-log", file: cleanup, schedule: 3_600_000 });

/* ------------------------------------------------------------------ */
step("startAll() and info()");

await jobs.runners.startAll();

/** One line per runner, for printing. */
async function table(context: BunJobs) {
  return (await context.runners.info()).map((info) => ({
    id: info.id,
    status: info.status,
    isPaused: info.isPaused,
    schedule: info.schedule,
    nextRunAt: info.nextRunAt?.toISOString() ?? null,
  }));
}

show(`${jobs.runners.size} runners`, await table(jobs));

/* ------------------------------------------------------------------ */
step("Pause one and reschedule another — stored in the backend");

await jobs.runners.get("rotate-keys")?.pause();
await jobs.runners.get("purge-sessions")?.updateSchedule("*/15 * * * *");

/* ------------------------------------------------------------------ */
step("Another instance of the service starts and adopts that state");

// As a second deployment would: same namespace, same backend, same code —
// constructed with the *original* schedule and not paused.
const secondInstance = new BunJobs({
  namespace,
  driver,
  runnerDefaults: { executionMode: "in-process" },
});
secondInstance.runner({
  id: "purge-sessions",
  file: cleanup,
  schedule: "*/5 * * * *",
});
secondInstance.runner({
  id: "rotate-keys",
  file: cleanup,
  schedule: { cron: "0 3 * * 0", tz: "UTC" },
});
await secondInstance.runners.startAll();

show("second instance's view", await table(secondInstance));
show("runners the backend knows about", await secondInstance.listRunners());

/* ------------------------------------------------------------------ */
step("remove() one, then close everything");

show(
  "removed compact-audit-log",
  await jobs.runners.remove("compact-audit-log"),
);
show(
  "still registered in this process",
  jobs.runners.list().map((runner) => runner.id),
);
// `remove()` unregisters the runner *here*. It does not delete the record on
// the backend, and nothing does: the record carries what the cluster decided
// about this runner — paused, its schedule, its config overrides — and that
// intent is meant to outlive a process. So the backend still lists it, another
// instance still discovers it, and `GET /runners/<id>` still answers 200.
// Register the same id again on this driver and it comes back as it was, pause
// included. Liveness is the run lock, not the record — which is the opposite of
// a worker, whose record really is a heartbeat and does expire.
show("but the backend still lists it", await jobs.listRunners());
show(
  "and the other instance still discovers it",
  await secondInstance.runners.discover(),
);

await secondInstance.close();
await jobs.purge();
await jobs.close(); // stopAll(), then everything else
await driver.close(); // passed as an instance, so ours to close
