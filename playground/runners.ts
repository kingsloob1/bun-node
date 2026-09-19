import type { BunJobs, BunRunner } from "@kingsleyweb/bun-jobs";

/**
 * Runners for the runner screens, all in-process with `handlers/work.ts`:
 *
 * | Runner     | Schedule          | What you see                                   |
 * |------------|-------------------|------------------------------------------------|
 * | `backup`   | every 30 s        | runs often, a growing history                  |
 * | `sync-crm` | every minute      | fails about half the time (`lastError`)        |
 * | `archive`  | Sundays 04:30     | paused: Resume… instead of Pause               |
 * | `reindex`  | none              | only runs when you press Trigger…              |
 */

/** The started runners, and how to stop them. */
export interface PlaygroundRunners {
  /** The runners, by id. */
  runners: BunRunner<any, any>[];
  /** Stops every runner, killing any run in flight. */
  stop: () => Promise<void>;
}

/** The runners' handler. */
const WORK = new URL("./handlers/work.ts", import.meta.url);

/** Registers and starts the playground's runners. */
export async function startRunners(jobs: BunJobs): Promise<PlaygroundRunners> {
  const backup = jobs.runner({
    id: "backup",
    file: WORK,
    executionMode: "in-process",
    schedule: { every: 30_000 },
    waitToExit: false,
  });
  const syncCrm = jobs.runner({
    id: "sync-crm",
    file: WORK,
    executionMode: "in-process",
    schedule: { cron: "* * * * *" },
    args: { failRate: 0.5 },
    waitToExit: false,
  });
  const archive = jobs.runner({
    id: "archive",
    file: WORK,
    executionMode: "in-process",
    schedule: { cron: "30 4 * * 0", tz: "Europe/London" },
    waitToExit: false,
  });
  const reindex = jobs.runner({
    id: "reindex",
    file: WORK,
    executionMode: "in-process",
    waitToExit: false,
  });

  const runners = [backup, syncCrm, archive, reindex];
  for (const runner of runners) {
    await runner.start();
  }
  await archive.pause();

  return {
    runners,
    stop: async () => {
      await Promise.all(runners.map((runner) => runner.stop()));
    },
  };
}
