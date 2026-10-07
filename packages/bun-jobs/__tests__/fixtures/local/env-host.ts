import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { providerCallContext } from "../../../lib/provider/context";
import { localCompute } from "../../../lib/provider/index";

/**
 * A host started with `LOCAL_TEST_STARTUP` in its environment, which it
 * deletes before summoning one unit: the unit must not see it. `Bun.spawn`
 * with no `env` would pass the environment this process *started* with.
 *
 * `env-host.ts <report-file> <allowlist|inherit>`: under `allowlist` the
 * variable is named in `passEnv`, so only the live `process.env` decides.
 */

const [file, mode] = process.argv.slice(2) as [string, string];
delete process.env.LOCAL_TEST_STARTUP;
const local = localCompute({
  entry: join(import.meta.dir, "unit.ts"),
  args: ["exit", file],
  output: "ignore",
  ...(mode === "inherit"
    ? { env: "inherit" as const }
    : { passEnv: ["LOCAL_TEST_STARTUP"] }),
});
await local.summon.summon(
  {
    namespace: "env-test",
    queue: "work",
    id: "sm_env",
    dedupeKey: "sm-env",
    count: 1,
    target: 1,
    demand: {
      at: Date.now(),
      paused: false,
      waiting: 1,
      dueNow: 0,
      stalled: 0,
      active: 0,
      workers: 0,
      nextDueAt: null,
      demand: 1,
      outstanding: 1,
      capped: false,
      exact: true,
    },
    reason: "manual",
    env: {},
    argv: ["--bun-jobs-summon-id=sm_env"],
    maxLifetimeMs: 60_000,
  },
  providerCallContext(new AbortController().signal, noopLogger),
);
while (!existsSync(file)) {
  await Bun.sleep(20);
}
await Bun.sleep(100);
process.exit(0);
