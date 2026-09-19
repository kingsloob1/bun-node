import { defineHandler } from "../../../lib/index";

/**
 * Returns its `marker`, so a test can read the order runs happened in from
 * the history. With `hold` it first waits for a `"release"` message (or an
 * abort), so a test decides exactly when the run ends — no timing involved.
 */
export default defineHandler<{ marker?: string; hold?: boolean }, string>(
  async (ctx) => {
    if (ctx.args?.hold) {
      await new Promise<void>((resolve) => {
        ctx.onMessage((message) => {
          if (message === "release") {
            resolve();
          }
        });
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }

    return ctx.args?.marker ?? "?";
  },
);
