import type { DriverConfig } from "../lib/index";
import type {
  CloseEscalationObservation,
  CloseEscalationScenario,
} from "./fixtures/processes/close-escalation";
import { join } from "node:path";
import process from "node:process";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createDriver } from "../lib/index";
import { TARGET_CLOSE_GRACE } from "../lib/queue/workerTarget";
import { SpawnExecutor } from "../lib/runner/executors/spawn";
import { makeTmpDir, testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";
import { spawnBun } from "./helpers/spawnBun";

/**
 * A graceful `worker.close()` escalated by `close({ force: true })` must end a
 * child-process or worker-thread attempt at once — not at the end of the
 * target's 4000 ms grace — so a process that exits the moment both calls
 * resolve leaves nothing running behind it.
 *
 * Before the escalation existed, the force only waited: a summoned process
 * whose backstop fired mid target close exited with its children alive.
 *
 * Each case runs in a process of its own (`fixtures/processes/close-
 * escalation.ts`) that exits with `process.exit` straight after the closes,
 * because an orphan only exists once its parent is gone. As in
 * `worker-close-orphans.test.ts`, the child is identified by the pid it wrote
 * itself, never by searching command lines, and is confirmed to be this
 * worktree's `spawn-entry.ts` before anything is killed; a thread, which
 * shares its pid, is seen by the beacon it writes while it spins.
 */

const cleanups: (() => Promise<void>)[] = [];
const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** Memory, and the servers among the cross-process backends worth a spawn. */
const BACKENDS = [
  {
    name: "memory",
    config: { type: "memory" } as DriverConfig,
    available: true,
  },
  ...(await crossProcessBackends({ cleanups })).filter((backend) =>
    ["postgres", "redis"].includes(backend.name),
  ),
];

const SCRIPT = join(
  import.meta.dir,
  "fixtures",
  "processes",
  "close-escalation.ts",
);

/**
 * How long, from the force, the closes may take to resolve: the kill and its
 * reaping (`TARGET_CLOSE_REAP`, 500 ms) plus slack for a loaded machine, and
 * still well inside the grace the force cuts short.
 */
const PROMPT_MS = 1_500;

/** A process as `ps` sees it: gone, a zombie, or alive with its command. */
function inspect(pid: number): { alive: boolean; args: string } {
  const { stdout } = Bun.spawnSync([
    "ps",
    "-o",
    "stat=,args=",
    "-p",
    String(pid),
  ]);
  const line = stdout.toString().trim();
  if (line.length === 0) {
    return { alive: false, args: "" };
  }
  const [stat = "", ...args] = line.split(/\s+/);
  return { alive: !stat.startsWith("Z"), args: args.join(" ") };
}

/** Removes exactly the namespace a test created, on a driver of its own. */
function purgeAfter(config: DriverConfig, namespace: string): void {
  if (config.type === "memory") {
    return;
  }
  closers.push(async () => {
    const driver = createDriver(config);
    try {
      await driver.connect();
      await driver.purge(namespace);
    } finally {
      await driver.close();
    }
  });
}

/** Orphans this file had to kill, by pid, for the report. */
const killed: number[] = [];

/**
 * Plays the scenario and reports what it saw, and whether the child — for a
 * child-process target — was still alive once the scenario had exited. An
 * orphan of ours is killed by its pid, whatever the assertions say.
 */
async function play(
  config: DriverConfig,
  kind: CloseEscalationScenario["kind"],
  when: CloseEscalationScenario["when"],
): Promise<{
  observed: CloseEscalationObservation;
  childAfterExit: boolean | null;
}> {
  const tmp = await makeTmpDir("close-esc");
  closers.push(tmp.cleanup);
  const namespace = testNamespace("close-esc");
  purgeAfter(config, namespace);
  const pidFile = join(tmp.path, "child.json");
  const input: CloseEscalationScenario = {
    config,
    namespace,
    kind,
    when,
    pidFile,
    beaconFile: join(tmp.path, "beacon"),
  };

  const run = spawnBun(SCRIPT, {}, [JSON.stringify(input)]);
  const exitCode = await Promise.race([
    run.exited,
    Bun.sleep(40_000).then(() => {
      // By this handle's pid only: never by pattern.
      run.proc.kill("SIGKILL");
      return -1;
    }),
  ]);

  // The child inherits the scenario's stdout, so its pipe ends only once the
  // child has exited too: look at the child before reading any output.
  const report = await Bun.file(pidFile)
    .text()
    .catch(() => "");
  let childAfterExit: boolean | null = null;
  if (kind === "child-process" && report.length > 0) {
    const { pid } = JSON.parse(report) as { pid: number };
    // Past the reaping a kill needs, and no further: the claim is "promptly".
    let after = inspect(pid);
    const deadline = Date.now() + 1_000;
    while (after.alive && Date.now() < deadline) {
      await Bun.sleep(25);
      after = inspect(pid);
    }
    childAfterExit = after.alive;
    if (after.alive && after.args.includes(SpawnExecutor.entry)) {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    }
  }

  const [stdout, stderr] = await Promise.all([run.output, run.errors]);
  const line = stdout.split("\n").find((text) => text.startsWith("{"));
  if (report.length === 0 || !line) {
    throw new Error(
      `The scenario never ${report.length === 0 ? "saw its attempt start" : "reported"}.\nexit ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  expect(exitCode).toBe(0);
  return {
    observed: JSON.parse(line) as CloseEscalationObservation,
    childAfterExit,
  };
}

afterAll(() => {
  if (killed.length > 0) {
    // eslint-disable-next-line no-console -- an orphan killed is worth seeing in the run's output.
    console.warn(`worker-close-escalation-orphans killed orphans: ${killed}`);
  }
});

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `an escalated close and an off-thread attempt (${backend.name})`,
    () => {
      for (const kind of ["child-process", "worker-thread"] as const) {
        for (const when of ["drain", "target-close"] as const) {
          const where =
            when === "drain"
              ? "while the graceful close waits on the attempt"
              : "during the target's graceful close";

          it(`${kind}: a force ${where} ends the run at once, leaving nothing behind`, async () => {
            const { observed, childAfterExit } = await play(
              backend.config,
              kind,
              when,
            );

            expect(observed.resolved).toEqual({
              graceful: true,
              forced: true,
            });
            expect(observed.closeMs).not.toBeNull();
            expect(observed.closeMs!).toBeLessThan(PROMPT_MS);
            expect(observed.closeMs!).toBeLessThan(TARGET_CLOSE_GRACE / 2);
            // The target was closed with force — over the graceful close
            // already under way, when there was one — and killed nothing twice.
            expect(observed.targetCloses).toEqual(
              when === "drain" ? ["force"] : ["graceful", "force"],
            );
            // The run had stopped: a child by the time the closes resolved,
            // a thread — whose termination is asynchronous — moments later.
            expect(observed.beacon.later).toBe(observed.beacon.settled);
            if (kind === "child-process") {
              expect(observed.aliveAtClose).toBe(false);
              expect(childAfterExit).toBe(false);
            }
          }, 60_000);
        }
      }
    },
  );
}
