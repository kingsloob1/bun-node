import { defineHandler } from "@kingsleyweb/bun-jobs";

/**
 * The runner behind `clear-actions.integration.test.ts`. A run finishes at
 * once, unless its `hold` argument names a gate: then it stays in progress
 * until the test resolves that gate. Runs execute in-process, so the gates
 * are shared through a global the test installs (a missing one would hang a
 * run, so it fails the run instead).
 */

/** Where the test keeps its gates: promises by name. */
export const GATES = Symbol.for("bun-jobs-ui.clear-actions.gates");

export default defineHandler<{ hold?: string }, { held: boolean }>(
  async (ctx) => {
    const name = ctx.args?.hold;
    if (name === undefined) {
      return { held: false };
    }
    const gates = (globalThis as Record<symbol, unknown>)[GATES] as
      | Map<string, Promise<void>>
      | undefined;
    const gate = gates?.get(name);
    if (!gate) {
      throw new Error(`no gate named ${name}`);
    }
    await gate;
    return { held: true };
  },
);
