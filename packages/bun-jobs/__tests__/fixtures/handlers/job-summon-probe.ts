import process from "node:process";
import { defineProcessor, summonedFromArgs } from "../../../lib/index";
import { spawnProbe } from "../processes/spawnProbe";

/**
 * A processor for a summoned worker's target. Reports what
 * `summonedFromArgs()` answers where the processor runs (for a worker-thread
 * target: the thread itself, in the summoned process), and what a process
 * the processor spawns with `Bun.spawn` and no `env` sees.
 */
export default defineProcessor<unknown, Record<string, unknown>>(async () => ({
  here: summonedFromArgs() ?? null,
  hereArgv: process.argv.slice(2),
  hereMarker: process.env.BUN_JOBS_CHILD ?? null,
  spawned: await spawnProbe(),
}));
