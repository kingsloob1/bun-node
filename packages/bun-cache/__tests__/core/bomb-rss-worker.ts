/**
 * Spawned by `decompress.test.ts`: reads one planted bomb in a fresh process
 * and prints how far the read raised the peak RSS, so nothing else the test
 * runner did can hide the growth under an earlier high-water mark.
 *
 * Usage: `bun bomb-rss-worker.ts <zstd|gzip|br|deflate> <MiB> <maxEntryBytes>`. Prints
 * one JSON line: `{ value, phase, cause, growthMiB }`.
 */
import process from "node:process";
import { createCache, memoryDriver } from "../../lib/index";
import { BOMBS, plantEntry } from "./bombs";

const [algorithm, mib, cap] = process.argv.slice(2);
const bomb = BOMBS.find((each) => each.algorithm === algorithm);
if (bomb === undefined) {
  throw new Error(`unknown algorithm ${algorithm}`);
}
const driver = memoryDriver();
const cache = createCache({
  driver,
  codec: "raw",
  maxEntryBytes: Number(cap),
  sweepInterval: 0,
});
let phase: string | undefined;
let cause: unknown;
cache.on("error", (event) => {
  phase = event.phase;
  cause = ((event.error as Error).cause as { code?: unknown } | undefined)
    ?.code;
});
await plantEntry(
  driver,
  "bomb",
  bomb.compressor,
  await bomb.build(Number(mib)),
);
Bun.gc(true);
// `maxRSS` is the process's high-water mark, in KiB on Linux.
const before = process.resourceUsage().maxRSS;
const value = await cache.get("bomb");
const after = process.resourceUsage().maxRSS;
await cache.close();
process.stdout.write(
  `${JSON.stringify({
    value: value === undefined ? "miss" : "hit",
    phase,
    cause,
    growthMiB: (after - before) / 1024,
  })}\n`,
);
