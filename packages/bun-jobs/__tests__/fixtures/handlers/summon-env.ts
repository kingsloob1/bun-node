import process from "node:process";
import { defineHandler, summonedFromEnv } from "../../../lib/index";

/**
 * Reports what `summonedFromEnv()` answers inside a runner child, beside the
 * evidence that the parent's summon keys really reached it — so a `null`
 * `summon` is shown to come from the child guard, not from a key that never
 * arrived.
 */
export default defineHandler(async () => {
  const { BUN_JOBS_CHILD: _marker, ...unmarked } = process.env;
  return {
    marker: process.env.BUN_JOBS_CHILD ?? null,
    inherited: process.env.BUN_JOBS_SUMMON_ID ?? null,
    summon: summonedFromEnv() ?? null,
    // The negative control: the very same environment minus the marker.
    unmarked: summonedFromEnv(unmarked, []) ?? null,
  };
});
