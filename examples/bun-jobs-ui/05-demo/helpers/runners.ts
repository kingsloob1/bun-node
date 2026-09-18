import type { BunRunner } from "@kingsleyweb/bun-jobs";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs } from "@kingsleyweb/bun-jobs";
import { waitFor } from "../../shared/console";

/**
 * Seeds runners for the runner screens: four registered in the demo's own
 * process, and one registered by another `BunJobs` over the same driver and
 * namespace, which the API can only reach through the driver.
 *
 * | Runner         | Where        | What it shows                                        |
 * |----------------|--------------|------------------------------------------------------|
 * | `backup`       | local        | started on a cron schedule, nothing in flight         |
 * | `archive`      | local        | paused (Resume… instead of Pause)                    |
 * | `digest`       | local        | a finished run in its history, and a run in flight (Kill…) |
 * | `sync-crm`     | local        | a failed run, and the runner's `lastError`           |
 * | `partner-feed` | another one  | remote: no active runs, no Kill… or Reset stats…     |
 *
 * Every runner runs in-process, and no schedule fires while the demo runs:
 * the history is exactly what is triggered here.
 */

/** Runner ids the demo links to. */
export const DEMO_RUNNERS = {
  /** Started, on a nightly cron, idle. */
  scheduled: "backup",
  /** Paused. */
  paused: "archive",
  /** One run finished, one in flight. */
  busy: "digest",
  /** Its only run failed. */
  failing: "sync-crm",
  /** Registered only by another process. */
  remote: "partner-feed",
} as const;

/** The seeded runners, and how to wind them down. */
export interface SeededRunners {
  /** The local runners, by id. */
  local: Record<string, BunRunner<any, any>>;
  /** Kills the run in flight and closes the other process's context. */
  stop: () => Promise<void>;
}

/** The handler that holds a run until it is killed. */
const HOLD = new URL("../../shared/handlers/hold.ts", import.meta.url);
/** The handler that always fails. */
const FAIL = new URL("../../shared/handlers/fail.ts", import.meta.url);

/** Seeds the runners into `jobs`, and a remote one beside it. */
export async function seedRunners(jobs: BunJobs): Promise<SeededRunners> {
  /** Registers and starts one in-process runner. */
  const start = async (
    id: string,
    file: URL,
    schedule?: { cron: string; tz?: string },
  ) => {
    const runner = jobs.runner({
      id,
      file,
      executionMode: "in-process",
      ...(schedule ? { schedule } : {}),
      waitToExit: false,
    });
    await runner.start();
    return runner;
  };

  const backup = await start(DEMO_RUNNERS.scheduled, HOLD, {
    cron: "0 3 * * *",
    tz: "Europe/London",
  });

  const archive = await start(DEMO_RUNNERS.paused, HOLD, {
    cron: "30 4 * * 0",
  });
  await archive.pause();

  // A run that finishes at once, then one that holds until it is killed.
  const digest = await start(DEMO_RUNNERS.busy, HOLD);
  await digest.trigger({ args: { ms: 0 } });
  await waitFor(
    "digest's first run to finish",
    async () =>
      (await digest.history()).length === 1 && digest.activeRuns.size === 0,
  );
  await digest.trigger({ args: { ms: 3_600_000 } });
  await waitFor("digest's second run to start", async () => {
    return digest.activeRuns.size === 1;
  });

  const syncCrm = await start(DEMO_RUNNERS.failing, FAIL);
  await syncCrm.trigger();
  await waitFor(
    "sync-crm's run to fail",
    async () => (await syncCrm.history())[0]?.status === "failed",
  );

  // Another process, as far as the API can tell: the same driver and
  // namespace, a runner this context never registers.
  const elsewhere = new BunJobs({
    namespace: jobs.namespace,
    driver: jobs.driver,
    logger: noopLogger,
  });
  await elsewhere
    .runner({
      id: DEMO_RUNNERS.remote,
      file: HOLD,
      executionMode: "in-process",
      schedule: { every: 3_600_000 },
      waitToExit: false,
    })
    .start();

  return {
    local: {
      [backup.id]: backup,
      [archive.id]: archive,
      [digest.id]: digest,
      [syncCrm.id]: syncCrm,
    },
    stop: async () => {
      await digest.kill();
      await elsewhere.close();
    },
  };
}
