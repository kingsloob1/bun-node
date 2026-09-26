import type { DriverConfig } from "../lib/index";
import type {
  CloseDuringStartObservation,
  StartStage,
} from "./fixtures/processes/close-during-start";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createDriver } from "../lib/index";
import {
  closeDuringStart,
  RUNNING_CALLS,
} from "./fixtures/processes/close-during-start";
import { testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";
import { spawnBun } from "./helpers/spawnBun";

/**
 * A worker closed while `run()` is still starting up — connecting, creating
 * its queue, or reading its control entries — must not go on to start once
 * the startup call returns.
 *
 * `run()` used to arm its maintenance and report timers, announce its state
 * and emit `ready` after whichever of those awaits the close landed in, since
 * nothing re-checked the close on the way. The intervals outlived `close()`
 * for good, and after a forced close the startup went on against the driver
 * the close had already shut: on MongoDB that reopened the connection and the
 * process could no longer exit.
 *
 * The interleaving is forced, not hoped for: each startup call is held on a
 * gate until `close()` has been called (and, when it resolves without the
 * start, has resolved), then let through. The control closes after `ready`,
 * and must pass on every version.
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

const BACKENDS = [
  {
    name: "memory",
    config: { type: "memory" } as DriverConfig,
    available: true,
  },
  ...(await crossProcessBackends({ cleanups })),
];

/** The startup awaits a close can land in, then the close after `ready`. */
const STAGES: StartStage[] = ["connect", "ensureQueue", "control", "ready"];

/**
 * Calls only a worker that went on to start makes. None may follow the
 * `close()` call at any stage — for the control too, which has claimed
 * nothing when the close arrives.
 */
const STARTED_CALLS = [
  "ensureQueue",
  "claimJob",
  "claimJobs",
  "waitForJob",
  "publish",
  "subscribe",
];

/** The fixture, playing the scenario in a process of its own. */
const SCRIPT = join(
  import.meta.dir,
  "fixtures",
  "processes",
  "close-during-start.ts",
);

/** How long a process is given to exit by itself before it is killed. */
const EXIT_WITHIN_MS = 10_000;

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

/** The calls in `made` that are in `forbidden`. */
function among(made: string[], forbidden: Iterable<string>): string[] {
  const set = new Set(forbidden);
  return made.filter((name) => set.has(name));
}

/** Runs the scenario in a child process and reports how it ended. */
async function inProcessOfItsOwn(
  config: DriverConfig,
  stage: StartStage,
  force: boolean,
): Promise<{ exited: boolean; code: number; run?: string; stderr: string }> {
  const namespace = testNamespace("close-start");
  purgeAfter(config, namespace);
  const spawned = spawnBun(SCRIPT, {}, [
    JSON.stringify({ config, namespace, stage, force }),
  ]);
  const exited = await Promise.race([
    spawned.exited.then(() => true),
    Bun.sleep(EXIT_WITHIN_MS).then(() => false),
  ]);
  if (!exited) {
    // By this handle's pid only: never by pattern.
    spawned.proc.kill("SIGKILL");
  }
  const [output, stderr, code] = await Promise.all([
    spawned.output,
    spawned.errors,
    spawned.exited,
  ]);
  const line = output.split("\n").find((text) => text.startsWith("{"));
  const observed = line
    ? (JSON.parse(line) as Partial<CloseDuringStartObservation>)
    : undefined;
  return { exited, code, run: observed?.run, stderr };
}

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `a close while run() starts up (${backend.name})`,
    () => {
      for (const stage of STAGES) {
        for (const force of [false, true]) {
          const how = force ? "close({ force: true })" : "close()";
          const when =
            stage === "ready" ? "after ready (control)" : `during ${stage}`;

          it(`${how} ${when}: nothing starts, nothing is left armed`, async () => {
            const namespace = testNamespace("close-start");
            purgeAfter(backend.config, namespace);

            const observed = await closeDuringStart({
              config: backend.config,
              namespace,
              stage,
              force,
              closers,
            });

            // Without the held call reached, this shows nothing.
            expect(observed.reached).toBe(true);
            // A close is a shutdown, not a failure: `run()` resolves.
            expect(observed.run).toBe("resolved");
            expect(observed.isRunning).toBe(false);
            expect(observed.readyAfterClosing).toBe(false);
            // Every interval the worker armed — maintenance, reports, the
            // hold on the process — was cleared.
            expect(observed.liveIntervals).toEqual([]);
            expect(among(observed.callsAfterClose, STARTED_CALLS)).toEqual([]);
            // Nothing at all once `close()` has resolved.
            expect(observed.callsAfterClosed).toEqual([]);

            if (stage === "connect" || stage === "ensureQueue") {
              // Nothing had started, so nothing may be under way either: no
              // report, no sweep.
              expect(among(observed.callsAfterClose, RUNNING_CALLS)).toEqual(
                [],
              );
            }
          });
        }
      }

      it("lets the process exit by itself after a close during startup", async () => {
        const runs = await Promise.all(
          (["connect", "ensureQueue"] as const).flatMap((stage) =>
            [false, true].map(async (force) => ({
              stage,
              force,
              ...(await inProcessOfItsOwn(backend.config, stage, force)),
            })),
          ),
        );

        for (const run of runs) {
          expect({
            stage: run.stage,
            force: run.force,
            exited: run.exited,
            code: run.code,
            run: run.run,
          }).toEqual({
            stage: run.stage,
            force: run.force,
            exited: true,
            code: 0,
            run: "resolved",
          });
        }
      }, 30_000);
    },
  );
}
