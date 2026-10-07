/**
 * The worker script `localCompute` starts in `02-queues/local-compute.ts`:
 * the `entry` of every unit there. Not meant to be run alone.
 *
 * `bun local-unit.ts <mode> <report-dir> [--bun-jobs-summon-*=…]`
 *
 * Its mode and report directory are the provider's `args`, which come
 * before the summon arguments. It first writes
 * `<report-dir>/<pid>.json`: its pid, its whole environment and, for a
 * spawner, its child's pid. Then, by mode:
 *
 * - `work`: the recipe a real entry follows. It builds the worker from its
 *   summon arguments, on the backend in `LOCAL_DRIVER` (a driver config as
 *   JSON, the summon policy's `env`), and hands it to `runSummoned`, which
 *   exits 0 once the queue has been idle for `LOCAL_IDLE_MS`. Each job
 *   answers the pid that ran it, and prints `processed <id> <pid>`.
 * - `hold`: does nothing until a stop signal, then appends `signal <name>`
 *   to `<report-dir>/<pid>.log` and exits 0.
 * - `hold-spawner`: starts `sleep 987` first (a tool a job started, in the
 *   unit's process group), then waits as `hold` does, and exits 0 on the
 *   stop signal **without stopping its child**: the provider must.
 */
import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const [mode, dir] = process.argv.slice(2);
if (dir === undefined) {
  throw new Error("usage: local-unit.ts <mode> <report-dir>");
}
if (!["work", "hold", "hold-spawner"].includes(mode!)) {
  throw new Error(`unknown mode ${mode}`);
}
if (mode !== "work") {
  // Before the report: once it exists, the tour may send the stop signal.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      appendFileSync(join(dir, `${process.pid}.log`), `signal ${signal}\n`);
      process.exit(0);
    });
  }
}
let child: number | undefined;
if (mode === "hold-spawner") {
  // Only `PATH`: `sleep` needs nothing else.
  child = Bun.spawn({
    cmd: ["sleep", "987"],
    env: { PATH: process.env.PATH ?? "" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).pid;
}
writeFileSync(
  join(dir, `${process.pid}.json`),
  JSON.stringify({
    pid: process.pid,
    env: process.env,
    ...(child === undefined ? {} : { child }),
  }),
);

if (mode === "work") {
  // Loaded here, not at the top: a unit that only waits for a signal starts
  // faster without it.
  const { BunJobs, runSummoned, summonedFromArgs } =
    await import("@kingsleyweb/bun-jobs");
  const summon = summonedFromArgs();
  if (summon?.namespace === undefined || summon.queue === undefined) {
    throw new Error("run me with --bun-jobs-summon-namespace= and -queue=");
  }
  const jobs = new BunJobs({
    namespace: summon.namespace,
    driver: JSON.parse(process.env.LOCAL_DRIVER!) as DriverConfig,
  });
  const worker = jobs.worker(
    summon.queue,
    async (job) => {
      console.log(`processed ${job.id} ${process.pid}`);
      return { pid: process.pid };
    },
    { summon, pollInterval: 20, reportInterval: 200 },
  );
  await runSummoned(worker, {
    idleFor: Number(process.env.LOCAL_IDLE_MS ?? 500),
    idleCheckInterval: 50,
    // Its decisions are not what the tour reads: kept out of the output.
    logger: () => {},
  });
} else {
  setInterval(() => {}, 1 << 30);
}
