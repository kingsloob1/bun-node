import type { DriverConfig } from "../../drivers/index";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs } from "../../BunJobs";
import { summonedFromArgs } from "../../summon/args";
import { runSummoned } from "../../summon/worker";
import { runScript } from "./spawn";

/**
 * The conformance kit's fixture worker: what a fake platform's unit runs
 * during the handoff check. The recipe every summoned platform runs, reduced
 * to what the kit observes:
 *
 * ```ts
 * const summon = summonedFromArgs();
 * const worker = jobs.worker(summon?.queue ?? queue, handler, { summon });
 * await runSummoned(worker, { idleFor });
 * ```
 *
 * Its identity arrives only as the `--bun-jobs-summon-*=` arguments the
 * provider passed. Test control, never identity, arrives in the environment
 * ({@link FIXTURE_ENV}): the driver config, and the namespace and queue for
 * a platform that passes no arguments.
 *
 * Prints one JSON line per fact: `ready`, `record` (its own heartbeat
 * record's `summon`, once listed), `processed`, `exit`.
 *
 * Runs only as a script (`import.meta.main`), so importing the module, as
 * the declaration build and a deep import do, starts nothing.
 */

/** The environment variables the kit sets for its fixture worker. */
export const FIXTURE_ENV = {
  /** The driver config, as JSON. */
  driver: "BUN_JOBS_CONFORMANCE_DRIVER",
  /** The namespace, when no argument names one. */
  namespace: "BUN_JOBS_CONFORMANCE_NAMESPACE",
  /** The queue, when no argument names one. */
  queue: "BUN_JOBS_CONFORMANCE_QUEUE",
  /** `runSummoned`'s `idleFor`, in ms. */
  idleMs: "BUN_JOBS_CONFORMANCE_IDLE_MS",
  /**
   * When set: run no worker, ignore `SIGTERM` and `SIGINT`, and exit 0 after
   * this many ms. A unit that will not end on its own before its lifetime,
   * for the self-hosted lifetime check.
   */
  holdMs: "BUN_JOBS_CONFORMANCE_HOLD_MS",
} as const;

/** This file, for the spawner. */
export const FIXTURE_WORKER = import.meta.path;

/** Prints one fact. */
function say(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/** Holds the process, deaf to stop signals, for `ms`, then exits 0. */
async function hold(ms: number): Promise<never> {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => say({ event: "ignored", signal }));
  }
  say({ event: "holding", pid: process.pid, ms });
  await Bun.sleep(ms);
  process.exit(0);
}

/** Runs the worker until `runSummoned` stops it, then exits with its code. */
async function main(): Promise<never> {
  const holdFor = process.env[FIXTURE_ENV.holdMs];
  if (holdFor !== undefined) {
    return await hold(Number(holdFor));
  }
  const summon = summonedFromArgs();
  const driver = JSON.parse(
    process.env[FIXTURE_ENV.driver] ?? "null",
  ) as DriverConfig;
  const namespace = summon?.namespace ?? process.env[FIXTURE_ENV.namespace]!;
  const queue = summon?.queue ?? process.env[FIXTURE_ENV.queue]!;
  const idleFor = Number(process.env[FIXTURE_ENV.idleMs] ?? 300);

  const jobs = new BunJobs({ namespace, driver, logger: noopLogger });
  const worker = jobs.worker(
    queue,
    async (job) => {
      say({ event: "processed", id: job.id, pid: process.pid });
    },
    {
      summon,
      concurrency: 4,
      pollInterval: 20,
      reportInterval: 200,
    },
  );
  say({ event: "ready", pid: process.pid, id: worker.id });

  // Its own record, once listed: what the controller releases the attempt
  // by. Watched beside the run, so a worker that drains at once still exits.
  const run = { done: false };
  const watching = (async () => {
    while (!run.done) {
      try {
        const mine = (await jobs.listWorkers()).find(
          (one) => one.id === worker.id,
        );
        if (mine !== undefined) {
          say({ event: "record", summon: mine.summon ?? null });
          return;
        }
      } catch {
        // Closing: the listing may fail; the run's result is what counts.
      }
      await Bun.sleep(20);
    }
  })();

  const result = await runSummoned(worker, {
    idleFor,
    idleCheckInterval: 50,
    exit: false,
  });
  run.done = true;
  await watching;
  await jobs.close();
  say({
    event: "exit",
    pid: process.pid,
    reason: result.reason,
    completed: result.completed,
  });
  process.exit(result.code);
}

if (import.meta.main) {
  runScript(main);
}
