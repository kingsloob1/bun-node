import { join } from "node:path";
import process from "node:process";

/** The probe's report, as `summon-probe.ts` prints it. */
export interface ProbeReport {
  /** `summonedFromArgs()` in the probe. */
  args: unknown;
  /** `BUN_JOBS_SUMMON_ID` in the probe: what the env channel would have read. */
  legacyEnv: string | null;
  /** The probe's own arguments. */
  argv: string[];
  /** `BUN_JOBS_CHILD` in the probe. */
  marker: string | null;
}

/**
 * Spawns `summon-probe.ts` with `Bun.spawn` and **no `env` option** — the
 * way user code or a processor typically spawns — and returns its report.
 */
export async function spawnProbe(): Promise<ProbeReport> {
  const proc = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "summon-probe.ts")],
    stdout: "pipe",
    stderr: "inherit",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(text.trim()) as ProbeReport;
}
