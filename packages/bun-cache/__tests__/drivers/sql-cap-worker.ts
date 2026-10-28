/**
 * The child half of the SQL drivers' `maxEntries` two-process test (after
 * `sqlite-cap-worker.ts`): builds the driver from `argv[2]` (module path),
 * `argv[3]` (export) and `argv[4]` (options, JSON, the cap included), writes
 * `argv[5]` entries in namespace `argv[6]`, prints `{"ready":true}`, waits for
 * its stdin to close (the start barrier), then sweeps and prints how many it
 * evicted.
 */
import process from "node:process";
import type { CacheDriver } from "../../lib/index";

const [module, exportName, optionsJson, countArg, ns] = process.argv.slice(2);
const factory = (
  (await import(module)) as Record<string, (options: unknown) => CacheDriver>
)[exportName];
const driver = factory(JSON.parse(optionsJson));
let evicted = 0;
driver.onEviction!(() => {
  evicted++;
});
for (let index = 0; index < Number(countArg); index++) {
  await driver.set(ns, {
    key: `child-${index}`,
    value: new Uint8Array(1),
    expiresAt: null,
    tags: ["child"],
  });
}
await Bun.write(Bun.stdout, `${JSON.stringify({ ready: true })}\n`);
await Bun.stdin.text();
await driver.sweep!(Date.now(), 1_000);
await Bun.write(Bun.stdout, `${JSON.stringify({ evicted })}\n`);
await driver.close();
