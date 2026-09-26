import process from "node:process";
import { defineHandler, summonedFromArgs } from "../../../lib/index";

/**
 * Reports what `summonedFromArgs()` answers inside a runner child whose own
 * arguments carry a summon id, beside the evidence that they do — so a
 * `null` is shown to come from the child marker, not from missing arguments.
 */
export default defineHandler(async () => ({
  summon: summonedFromArgs() ?? null,
  argv: process.argv.slice(2),
  marker: process.env.BUN_JOBS_CHILD ?? null,
}));
