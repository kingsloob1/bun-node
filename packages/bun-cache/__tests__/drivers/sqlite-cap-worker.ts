/**
 * The child half of the SQLite `maxEntries` two-process test: on the file in
 * `argv[2]`, writes `argv[3]` entries in namespace `argv[4]`, prints
 * `{"ready":true}`, waits for its stdin to close (the start barrier), then
 * sweeps with the cap in `argv[5]` and prints how many it evicted.
 */
import process from "node:process";
import { sqliteDriver } from "../../lib/index";

const [path, countArg, ns, capArg] = process.argv.slice(2);
const driver = sqliteDriver({ path, maxEntries: Number(capArg) });
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
