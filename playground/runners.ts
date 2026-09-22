import type { BunJobs, BunRunner } from "@kingsleyweb/bun-jobs";

/**
 * Runners for the runner screens, all in-process with `handlers/work.ts`:
 *
 * | Runner     | Schedule          | What you see                                   |
 * |------------|-------------------|------------------------------------------------|
 * | `backup`   | every 30 s        | spawned: runs in a child process               |
 * | `sync-crm` | every minute      | fails about half the time (`lastError`)        |
 * | `archive`  | Sundays 04:30     | paused: Resume… instead of Pause               |
 * | `reindex`  | none              | spawned; only runs when you press Trigger…     |
 * | `ping`     | every 10 s        | times out about half the time, throws 1 in 5   |
 *
 * `backup` and `reindex` run in a child process; the others in-process. Every
 * run's log holds its `stdout` and `stderr` as well as its `ctx.log()` lines,
 * whichever way it runs: a spawned run's through its pipes, an in-process
 * run's because capture attributes each `console` call to the run that made
 * it. So an in-process run's `console.warn` lands on `stderr` in its own log.
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
    // A child process: its stdout and stderr are captured from its pipes.
    executionMode: "spawn",
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
    executionMode: "spawn",
    waitToExit: false,
  });

  // The Overview's Runners section counts a run that threw (`failed`) apart
  // from one that timed out or was killed. This one does all of it often
  // enough to see within a minute: its work takes 2–8 s against a 5 s
  // timeout, and one run in five that beats the clock throws.
  const ping = jobs.runner({
    id: "ping",
    file: WORK,
    executionMode: "in-process",
    schedule: { every: 10_000 },
    timeout: 5_000,
    args: { failRate: 0.2 },
    waitToExit: false,
  });

  const runners = [backup, syncCrm, archive, reindex, ping];
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
