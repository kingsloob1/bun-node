/**
 * A host whose shutdown `02-queues/local-compute.ts` watches from outside:
 * it summons two `localCompute` units, says so, and then ends the way its
 * mode says. Run in a child process, so the tour can signal it without
 * signalling itself. Not meant to be run alone.
 *
 * `bun local-host.ts <report-dir> <mode>`
 *
 * Each unit runs `helpers/local-unit.ts` in `hold-spawner` mode: it starts a
 * `sleep` of its own, writes `<report-dir>/<pid>.json` (its pid and its
 * child's) and waits for a stop signal, on which it exits 0 and leaves the
 * `sleep` behind. Once both units have reported, the host prints `ready`.
 * Then, by mode:
 *
 * - `wait`: nothing listens for a signal here, so `localCompute`'s guard
 *   owns its default: the host waits for its units, then ends by the signal.
 * - `listen`: the host has a `SIGINT` listener of its own, the shape of an
 *   app's graceful shutdown. It prints `host-signal`, asks for one more unit
 *   and prints the answer as `{"answer":…}`, waits until both units have
 *   stopped, prints their statuses as `{"units":…}` and exits 0.
 * - `exit`: calls `process.exit(0)` at once.
 */
import type { SummonResult } from "@kingsleyweb/bun-jobs/provider";
import { readdirSync } from "node:fs";
import process from "node:process";
import { localCompute } from "@kingsleyweb/bun-jobs/provider";
import { callContext, summonRequest } from "./local-calls";

const [dir, mode] = process.argv.slice(2) as [string, string];

const local = localCompute({
  entry: new URL("./local-unit.ts", import.meta.url),
  args: ["hold-spawner", dir],
  output: "ignore",
  // Room for a third: a summon refused after the signal is refused for the
  // signal, not for capacity.
  maxUnits: 3,
  shutdown: { graceMs: 2_000 },
});
const facet = local.summon;
const started = await facet.summon(summonRequest(2), callContext());
const handles = started.status === "started" ? started.handles : [];
while (readdirSync(dir).filter((name) => name.endsWith(".json")).length < 2) {
  await Bun.sleep(20);
}

if (mode === "listen") {
  // Registered after the guard, which the first unit installed: by the time
  // this runs, the guard has already marked the host as stopping.
  process.on("SIGINT", () => {
    console.log("host-signal");
    void (async () => {
      const answer: SummonResult = await facet.summon(
        summonRequest(1),
        callContext(),
      );
      console.log(JSON.stringify({ answer }));
      for (;;) {
        const units = await facet.status!(handles, callContext());
        if (units.every((unit) => unit.state !== "running")) {
          console.log(JSON.stringify({ units }));
          process.exit(0);
        }
        await Bun.sleep(20);
      }
    })();
  });
}
console.log("ready");
if (mode === "exit") {
  process.exit(0);
}
setInterval(() => {}, 1 << 30);
