import { defineHandler } from "../../../lib/index";

/**
 * Writes `count` lines through `ctx.log()`, `gap` ms apart — a run whose log
 * grows steadily for a while, which is what a throttle has to be watched on.
 * `text` is each line's prefix, so a test can look for it where it must not be.
 */
export default defineHandler<
  { count?: number; gap?: number; text?: string },
  number
>(async (ctx) => {
  const count = ctx.args?.count ?? 10;
  const gap = ctx.args?.gap ?? 10;
  const text = ctx.args?.text ?? "drip";

  for (let index = 1; index <= count; index++) {
    ctx.log(`${text} ${index}`);
    await Bun.sleep(gap);
  }

  return count;
});
