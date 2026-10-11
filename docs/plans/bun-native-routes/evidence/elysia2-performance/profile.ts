/**
 * A CPU-profile driver: one target, one scenario, in a loop for SECONDS,
 * for `bun --cpu-prof-md` to sample.
 *
 *   NODE_ENV=production BUN_OPTIONS= bun --cpu-prof-md --cpu-prof-dir=results/prof \
 *     --cpu-prof-name=<target>-<scenario>.md profile.ts <target> <scenario>
 */
import process from "node:process";
import { makeTarget, SCENARIOS } from "./targets";

const [target, scenario] = process.argv.slice(2);
const seconds = Number(process.env.SECONDS_ ?? 4);
const serve = await makeTarget(target);
const make = SCENARIOS[scenario];
const sink: unknown[] = [];
const end = performance.now() + seconds * 1000;
let n = 0;
while (performance.now() < end) {
  for (let i = 0; i < 1000; i++) {
    const r = serve(make());
    sink[i & 7] = r instanceof Promise ? await r : r;
  }
  n += 1000;
}
console.log(`${target} ${scenario}: ${n} requests, ${((seconds * 1e9) / n).toFixed(0)} ns/request`);
process.exit(0);
