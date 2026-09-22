/* eslint-disable no-console -- the console is what this file exercises: capture patches it. */
import { defineHandler } from "../../../lib/index";

/**
 * Writes through `console.*` — not `ctx.log()` — with `await`s, a timer and a
 * microtask between the calls, so a test running two of these at once in one
 * realm can check each line lands in its own run's log however the two
 * interleave.
 *
 * Every line starts with `tag`, which is how a test tells the runs apart.
 * `gate`, when given, names a global promise the handler waits on before its
 * last line, so a test can hold two runs open together.
 */
export default defineHandler<
  { tag: string; count?: number; gap?: number; gate?: string },
  number
>(async (ctx) => {
  const { tag, count = 3, gap = 2, gate } = ctx.args;

  for (let index = 1; index <= count; index++) {
    console.log(`${tag} log ${index}`);
    await Bun.sleep(gap);
    console.warn(`${tag} warn ${index}`);
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        console.info(`${tag} timer ${index}`);
        resolve();
      }, gap);
    });
    await Promise.resolve().then(() => console.debug(`${tag} micro ${index}`));
  }

  if (gate) {
    const waiting = (globalThis as Record<string, unknown>)[gate];
    if (waiting instanceof Promise) {
      await waiting;
    }
  }

  console.error(`${tag} error`, { n: 1 });
  console.log(`${tag} multi\n${tag} line`);
  return count;
});
