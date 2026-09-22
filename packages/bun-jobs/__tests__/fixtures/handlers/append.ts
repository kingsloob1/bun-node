import { appendFileSync, readdirSync } from "node:fs";
import { defineHandler } from "../../../lib/index";

/** How long a held run waits for the others before giving up, ms. */
const HOLD_LIMIT_MS = 20_000;

/** Entries in `dir`, or none when it does not exist yet. */
function entries(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/**
 * Appends one line per run to a shared file, so a test in another process can
 * count how many runs actually happened, and holds the run open for `ms` so
 * a second process arrives while the lock is genuinely held.
 *
 * With `holdUntil`, the run is also held until `count` files exist in `dir` —
 * one per process that has made its trigger decision — so "the other process
 * arrived while the lock was held" is a fact rather than a bet on how fast a
 * loaded machine spawns a process.
 */
export default defineHandler<
  {
    /** Written at the start of the line, to tell the processes apart. */
    marker?: string;
    /** The shared file each run appends to. */
    log?: string;
    /** How long the run lasts, after any hold, ms. Defaults to `100`. */
    ms?: number;
    /** Hold the run until `count` entries exist in `dir` (capped at 20 s). */
    holdUntil?: { dir: string; count: number };
  },
  string
>(async (ctx) => {
  const line = `${ctx.args?.marker ?? "?"}:${ctx.runId}\n`;

  if (ctx.args?.log) {
    appendFileSync(ctx.args.log, line);
  }

  const hold = ctx.args?.holdUntil;
  if (hold) {
    const deadline = Date.now() + HOLD_LIMIT_MS;
    while (entries(hold.dir) < hold.count && Date.now() < deadline) {
      await Bun.sleep(5);
    }
  }

  await Bun.sleep(ctx.args?.ms ?? 100);
  return line.trim();
});
