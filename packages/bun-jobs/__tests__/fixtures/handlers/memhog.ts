import { defineHandler } from "../../../lib/index";

/**
 * Allocates memory until something stops it: a cgroup's `memory.max`, in the
 * cgroup tests, kills it. Gives up after `maxMb` so a host without the limit
 * is not taken down with it.
 */
export default defineHandler<{ maxMb?: number }>(async (ctx) => {
  const hold: Uint8Array[] = [];
  const max = ctx.args?.maxMb ?? 512;
  for (let mb = 0; mb < max; mb += 8) {
    // Filled, so the pages are really committed rather than just reserved.
    hold.push(new Uint8Array(8 * 1024 * 1024).fill(1));
    await Bun.sleep(1);
  }
  return { survivedMb: hold.length * 8 };
});
