import type { SpawnOptions } from "../../../lib/index";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunRunner, MemoryDriver } from "../../../lib/index";

/**
 * Runs one `child-process` run of a handler and prints how it went, as one
 * JSON line: `{ result }` or `{ error }`, plus `leftover`, the cgroups still
 * under the run's cgroup parent afterwards; or `{ thrown }` when the runner
 * refused its options at construction.
 *
 * A process of its own, for three reasons the tests need:
 *
 * - **the startup environment.** `child-env.test.ts` starts it with variables
 *   in its *startup* environment, so a child built from the live
 *   `process.env` can be told from one built from the startup one — what
 *   `Bun.spawn` passes when given no `env`. Before the run it changes its
 *   environment the way an application might: `ISO0_RUNTIME_SET` is set, and
 *   `ISO0_DELETED` (a startup variable) is deleted;
 * - **privilege.** `spawn-hardening.test.ts` starts it under `unshare
 *   --map-root-user`, where it may change a child's uid and gid;
 * - **a delegated cgroup.** Started under `systemd-run --user --scope -p
 *   Delegate=yes` with `delegate` as its fourth argument, it moves itself into
 *   a leaf cgroup, enables `memory`, `pids` and `cpu` for its scope's
 *   children, creates `<scope>/jobs` with the same, and runs with
 *   `spawn.cgroup.parent` set to it.
 *
 * Arguments: the runner's `spawn` options as JSON, the handler's name (default
 * `env-report`), the run's args as JSON, and `delegate`.
 */

process.env.ISO0_RUNTIME_SET = "set-at-runtime";
delete process.env.ISO0_DELETED;

const spawn = JSON.parse(process.argv[2] ?? "{}") as SpawnOptions;
const handler = process.argv[3] || "env-report";
const args = JSON.parse(process.argv[4] || "null") as unknown;

if (process.argv[5] === "delegate") {
  const scope = `/sys/fs/cgroup${readFileSync("/proc/self/cgroup", "utf8").trim().split("::")[1]}`;
  // cgroup v2 allows no process in a cgroup whose children have
  // controllers, so this process moves to a leaf of its own first.
  mkdirSync(join(scope, "probe"));
  writeFileSync(join(scope, "probe", "cgroup.procs"), String(process.pid));
  writeFileSync(join(scope, "cgroup.subtree_control"), "+memory +pids +cpu");
  mkdirSync(join(scope, "jobs"));
  writeFileSync(
    join(scope, "jobs", "cgroup.subtree_control"),
    "+memory +pids +cpu",
  );
  spawn.cgroup = { ...spawn.cgroup, parent: join(scope, "jobs") };
}

/** The bun-jobs cgroups left under the parent, when there is one. */
function leftover(): string[] | null {
  if (!spawn.cgroup) {
    return null;
  }
  return readdirSync(spawn.cgroup.parent).filter((name) =>
    name.startsWith("bun-jobs-"),
  );
}

let report: Record<string, unknown>;
try {
  const runner = new BunRunner({
    id: "env-probe",
    namespace: `env-probe-${process.pid}`,
    file: join(import.meta.dir, "..", "handlers", `${handler}.ts`),
    executionMode: "child-process",
    driver: new MemoryDriver(),
    waitToExit: false,
    logger: noopLogger,
    spawn,
  });

  const outcome = new Promise<Record<string, unknown>>((resolve) => {
    runner.once("finished", (_record, result) => resolve({ result }));
    runner.once("failed", (record, error) => {
      resolve({
        error: { name: error.name, message: error.message },
        signal: record.signal ?? null,
      });
    });
  });

  await runner.start();
  await runner.trigger({ args });
  report = await outcome;
  report.leftover = leftover();
  await runner.stop({ force: true });
} catch (error) {
  // A construction-time refusal, reported rather than thrown so the test can
  // read its message.
  const { name, message } = error as Error;
  report = { thrown: { name, message } };
}

// eslint-disable-next-line no-console -- the parent reads this line.
console.log(JSON.stringify(report));
process.exit(0);
