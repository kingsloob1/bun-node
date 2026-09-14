import type { RunContext } from "../../lib/index";

/**
 * The handler every `bun-jobs` runner contender executes.
 *
 * It does the least a real handler can: tell the parent it is running, and
 * return. Everything above that would be measuring the handler rather than the
 * runner, and the point of the comparison is the cost of getting here — module
 * resolution, process or worker start-up, and the trip back.
 */
export default function handler(ctx: RunContext): { ok: true } {
  ctx.send({ startedAt: Date.now() });
  return { ok: true };
}
