import process from "node:process";
import { defineProcessor, summonedFromEnv } from "../../../lib/index";

/**
 * A processor that reports what `summonedFromEnv()` answers inside a worker
 * target's thread or child, beside the evidence that the parent's summon keys
 * reached it and the negative control without the child marker.
 */
export default defineProcessor<
  unknown,
  {
    marker: string | null;
    inherited: string | null;
    summon: unknown;
    unmarked: unknown;
  }
>(async () => {
  const { BUN_JOBS_CHILD: _marker, ...unmarked } = process.env;
  return {
    marker: process.env.BUN_JOBS_CHILD ?? null,
    inherited: process.env.BUN_JOBS_SUMMON_ID ?? null,
    summon: summonedFromEnv() ?? null,
    unmarked: summonedFromEnv(unmarked, []) ?? null,
  };
});
