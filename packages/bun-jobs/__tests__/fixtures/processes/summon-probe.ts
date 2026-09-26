import process from "node:process";
import { summonedFromArgs } from "../../../lib/index";

/**
 * A descendant of a summoned process, spawned with `Bun.spawn` and **no
 * `env`**. Prints what `summonedFromArgs()` answers here, beside what the old
 * environment channel would have read, and the evidence for each layer.
 */
process.stdout.write(
  `${JSON.stringify({
    args: summonedFromArgs() ?? null,
    // What the draft's `summonedFromEnv()` read: the negative control.
    legacyEnv: process.env.BUN_JOBS_SUMMON_ID ?? null,
    argv: process.argv.slice(2),
    marker: process.env.BUN_JOBS_CHILD ?? null,
  })}\n`,
);
