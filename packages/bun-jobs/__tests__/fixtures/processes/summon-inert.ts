import type { DriverConfig } from "../../../lib/index";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs } from "../../../lib/index";

/**
 * Builds a `BunJobs` with a summon policy, the way a config module shared
 * with a summoned worker would, and prints whether its controller is inert
 * and what a check answers. With `SUMMON_TEST_SPAWN_CHILD=1` it also spawns
 * itself once with `Bun.spawn` and no `env` — a summoned process's
 * descendant — and prints that child's answer as `child` (Q42).
 */

const driver = JSON.parse(process.env.SUMMON_TEST_DRIVER!) as DriverConfig;
let calls = 0;
const jobs = new BunJobs({
  namespace: process.env.SUMMON_TEST_NAMESPACE!,
  driver,
  logger: noopLogger,
  summon: {
    work: {
      summoner: async () => {
        calls++;
      },
      triggers: { poll: false, events: false },
      fromSummoned: process.env.SUMMON_TEST_FROM_SUMMONED === "1",
    },
  },
});
const controller = jobs.summonController("work");
await jobs.queue("work").add("a", {});
const result = await controller.check();

let child: unknown = null;
if (process.env.SUMMON_TEST_SPAWN_CHILD === "1") {
  // Without the arguments, as every descendant is. The environment is passed
  // explicitly only to stop this fixture spawning itself forever: a `Bun.spawn`
  // with no `env` would hand the child the startup environment, flag and all.
  const { SUMMON_TEST_SPAWN_CHILD: _flag, ...env } = process.env;
  const proc = Bun.spawn([process.execPath, import.meta.path], {
    env,
    stdout: "pipe",
    stderr: "inherit",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  child = JSON.parse(out.trim().split("\n").at(-1)!);
}

await jobs.close();
process.stdout.write(
  `${JSON.stringify({ inert: controller.inert, action: result.action, reason: "reason" in result ? result.reason : null, calls, child })}\n`,
);
process.exit(0);
