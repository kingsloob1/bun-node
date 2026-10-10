import type {
  JobsDriver,
  SummonControllerOptions,
  SummonEventPayload,
  SummonFailure,
} from "../lib/index";
import type { SpawnedUnit } from "../lib/provider/testing/spawn";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { listWorkerRecords } from "../lib/drivers/index";
import { BunQueue, createDriver, SummonController } from "../lib/index";
import { spawnUnit, unitLines } from "../lib/provider/testing/spawn";
import { readSummonClaims } from "../lib/summon/claim";
import { summonGroupRef, summonGroupStateName } from "../lib/summon/group";
import { testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";
import { runBun } from "./helpers/spawnBun";
import { spawningSummoner } from "./helpers/summon";

/**
 * The shared unit across real processes (plan summon-multi-queue §7 (B) 1,
 * 2, 4, 5 and 7), on every cross-process backend: one controller for a
 * group of three queues, and a unit (`fixtures/summoned-unit.ts`) that runs
 * a worker for each. The unit stands in for `runSummoned(workers[])`, which
 * is PR-B2's.
 */

setDefaultTimeout(240_000);

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

const BACKENDS = await crossProcessBackends({ cleanups });
const QUEUES = ["renders", "thumbs", "previews"];
const UNIT = join(import.meta.dir, "fixtures", "summoned-unit.ts");
const RACER = join(
  import.meta.dir,
  "fixtures",
  "processes",
  "summon-shared-racer.ts",
);
/** Rounds of the race per backend. */
const ROUNDS = 3;
/** Time between two rounds' starts. */
const SLOT_MS = 900;

/** One line a racer printed. */
interface RacerLine {
  round: number;
  call?: string;
  argv?: string[];
  action?: string;
  reason?: string | null;
}

/** Waits until `done()` holds, checking every 50 ms, for at most `ms`. */
async function waitUntil(
  done: () => boolean | Promise<boolean>,
  ms: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(50);
  }
}

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `shared unit across processes: ${backend.name}`,
    () => {
      let driver: JobsDriver;
      const namespaces: string[] = [];
      const controllers: SummonController[] = [];
      const units: SpawnedUnit[] = [];
      const kills: (() => Promise<void>)[] = [];

      beforeAll(async () => {
        driver = createDriver(backend.config);
        await driver.connect();
      });
      afterAll(async () => {
        await Promise.allSettled(
          controllers.map(async (one) => await one.close()),
        );
        await Promise.allSettled(kills.map(async (kill) => await kill()));
        for (const unit of units) {
          // By PID, our own: never a pattern.
          unit.proc.kill("SIGKILL");
        }
        await Promise.allSettled(units.map(async (unit) => await unit.exited));
        for (const namespace of namespaces) {
          await driver.purge(namespace).catch(() => {});
        }
        await driver.close();
      });

      /** A namespace of this test's own, purged at the end. */
      const fresh = (tag: string): string => {
        const namespace = testNamespace(`shared-${tag}-${backend.name}`);
        namespaces.push(namespace);
        return namespace;
      };

      /** Adds `count` waiting jobs to each queue. */
      const seed = async (
        namespace: string,
        counts: Record<string, number>,
      ): Promise<void> => {
        for (const [name, count] of Object.entries(counts)) {
          const queue = new BunQueue(name, {
            namespace,
            driver,
            logger: noopLogger,
          });
          for (let index = 0; index < count; index++) {
            await queue.add("a", {});
          }
          await queue.close();
        }
      };

      /** A shared-unit controller over the three queues, every check asked for. */
      const shared = (
        namespace: string,
        extra: Partial<SummonControllerOptions> &
          Pick<SummonControllerOptions, "summoner">,
      ): { controller: SummonController; events: SummonEventPayload[] } => {
        const controller = new SummonController({
          driver,
          namespace,
          queues: QUEUES,
          group: { name: "media", unit: "shared" },
          triggers: { onAdd: false, events: false, poll: false },
          cooldown: 0,
          backoff: { initial: 1, max: 1 },
          logger: noopLogger,
          ...extra,
        });
        controllers.push(controller);
        const events: SummonEventPayload[] = [];
        controller.on("summon", (event) => events.push(event));
        return { controller, events };
      };

      /** Checks every 100 ms until `done()` holds, for at most `ms`. */
      const checkUntil = async (
        controller: SummonController,
        done: () => boolean,
        ms: number,
        what: string,
      ): Promise<void> => {
        // What each check answered, in runs: a timeout names them, and the
        // controller's state, so a failure says why it never got there.
        const answers: { answer: string; times: number; at: number }[] = [];
        const started = Date.now();
        try {
          await waitUntil(
            async () => {
              const result = await controller.check();
              const answer =
                result.action === "skipped"
                  ? `skipped:${result.reason}`
                  : result.action === "summoned"
                    ? `summoned:${result.outcome}`
                    : result.action;
              const last = answers.at(-1);
              if (last?.answer === answer) {
                last.times++;
              } else {
                answers.push({ answer, times: 1, at: Date.now() - started });
              }
              if (done()) {
                return true;
              }
              await Bun.sleep(50);
              return false;
            },
            ms,
            what,
          );
        } catch (error) {
          const status = await controller.status().catch(() => undefined);
          throw new Error(
            `${(error as Error).message}; checks: ${answers
              .map((one) => `${one.answer}×${one.times}@${one.at}ms`)
              .join(", ")}; status: ${JSON.stringify({
              failures: status?.failures,
              last: status?.last,
              pending: status?.pending,
              circuitOpenUntil: status?.circuitOpenUntil,
              backoffUntil: status?.backoffUntil,
            })}`,
          );
        }
      };

      /** Each queue's live records carrying `id`. */
      const holders = async (
        namespace: string,
        id: string,
      ): Promise<Record<string, number>> => {
        const now = Date.now();
        const counts: Record<string, number> = {};
        for (const queue of QUEUES) {
          counts[queue] = (
            await listWorkerRecords(driver, { ns: namespace, queue }, now)
          ).filter((worker) => worker.summon?.id === id).length;
        }
        return counts;
      };

      it("two processes summon one unit for three queues, and it registers on all three (B1, B2)", async () => {
        const rounds: string[] = [];
        for (let round = 0; round < ROUNDS; round++) {
          rounds.push(fresh(`race-r${round}`));
        }
        for (const namespace of rounds) {
          await seed(namespace, { renders: 1, thumbs: 1, previews: 1 });
        }
        const env = {
          SUMMON_TEST_DRIVER: JSON.stringify(backend.config),
          SUMMON_TEST_NAMESPACES: rounds.join(","),
          SUMMON_TEST_QUEUES: QUEUES.join(","),
          SUMMON_TEST_START_AT: String(Date.now() + 3_000),
          SUMMON_TEST_SLOT_MS: String(SLOT_MS),
          SUMMON_TEST_CHECKS: "4",
        };
        const runs = await Promise.all(
          [0, 1].map(async () => await runBun<RacerLine>(RACER, env)),
        );
        for (const run of runs) {
          expect(run.exitCode, run.stderr).toBe(0);
        }
        const lines = runs.flatMap((run) => run.lines);
        for (const [round, namespace] of rounds.entries()) {
          const calls = lines.filter(
            (line) => line.round === round && line.call !== undefined,
          );
          // One call for the three queues and the two processes.
          expect({ round, calls: calls.length }).toEqual({ round, calls: 1 });
          for (const line of lines.filter(
            (one) => one.round === round && one.action === "skipped",
          )) {
            expect(["pending", "contended"]).toContain(String(line.reason));
          }
          const entry = (await driver.getQueueState!(
            summonGroupRef(namespace),
            summonGroupStateName("media"),
          ))!.value as {
            pending: { id: string }[];
            budget: { day: number };
            queues: Record<string, { day: number }>;
          };
          expect(entry.pending.map((one) => one.id)).toEqual([calls[0]!.call!]);
          expect(entry.budget.day).toBe(1);
          for (const queue of QUEUES) {
            expect(entry.queues[queue]?.day).toBe(1);
          }
        }

        // Round 0's unit, started with the winning call's argv, as the
        // platform would: one process, three workers, one attempt.
        const [namespace] = rounds;
        const call = lines.find(
          (line) => line.round === 0 && line.call !== undefined,
        )!;
        const unit = spawnUnit(
          UNIT,
          { SUMMON_TEST_DRIVER: JSON.stringify(backend.config) },
          call.argv!,
        );
        units.push(unit);
        const { controller, events } = shared(namespace!, {
          summoner: async () => {
            throw new Error("summoned again");
          },
        });
        await checkUntil(
          controller,
          () => events.some((event) => event.outcome === "registered"),
          30_000,
          "the unit's registration",
        );
        const registered = events.find(
          (event) => event.outcome === "registered",
        )!;
        expect(registered.id).toBe(call.call!);
        expect(registered.detail).toBeUndefined();
        expect(registered.group).toBe("media");
        // B2: each queue counts the unit once, and its record says so.
        expect(await holders(namespace!, call.call!)).toEqual({
          renders: 1,
          thumbs: 1,
          previews: 1,
        });
        for (const queue of QUEUES) {
          const records = await listWorkerRecords(
            driver,
            { ns: namespace!, queue },
            Date.now(),
          );
          expect(records.map((one) => one.summon?.group)).toEqual(["media"]);
          const claims = await readSummonClaims(
            driver,
            { ns: namespace!, queue },
            [call.call!],
          );
          expect(claims.get(call.call!)?.holders).toHaveLength(1);
        }
        const status = await controller.status();
        expect(status.failures).toBe(0);
        expect(status.pending).toEqual([]);
        expect(status.last).toMatchObject({
          id: call.call,
          outcome: "registered",
        });
        // It drains all three queues and exits on idle.
        expect(await unit.exited).toBe(0);
        const said = await unitLines(unit);
        expect(
          said
            .filter((line) => line.event === "processed")
            .map((line) => line.queue)
            .sort(),
        ).toEqual(["previews", "renders", "thumbs"]);
      });

      it("the expansion form, for contrast, summons once per queue", async () => {
        const namespace = fresh("race-per-queue");
        await seed(namespace, { renders: 1, thumbs: 1, previews: 1 });
        const runs = await Promise.all(
          [0, 1].map(
            async () =>
              await runBun<RacerLine>(RACER, {
                SUMMON_TEST_DRIVER: JSON.stringify(backend.config),
                SUMMON_TEST_NAMESPACES: namespace,
                SUMMON_TEST_QUEUES: QUEUES.join(","),
                SUMMON_TEST_START_AT: String(Date.now() + 3_000),
                SUMMON_TEST_SLOT_MS: String(SLOT_MS),
                SUMMON_TEST_CHECKS: "4",
                SUMMON_TEST_PER_QUEUE: "1",
              }),
          ),
        );
        const calls = runs
          .flatMap((run) => run.lines)
          .filter((line) => line.call !== undefined);
        expect(calls).toHaveLength(3);
      });

      for (const skip of ["thumbs", ""]) {
        it(
          skip === ""
            ? "a unit covering every queue registers clean, failures 0 (B4's control)"
            : "a unit missing a queue registers partial:<queue>, counts one failure each time, and opens the circuit (B4)",
          async () => {
            const namespace = fresh(`partial-${skip || "none"}`);
            await seed(namespace, { renders: 1, thumbs: 1, previews: 1 });
            const platform = spawningSummoner({
              driver: backend.config,
              worker: UNIT,
              // The unit exits once its own queues are idle, as a real one
              // would: while it lives, it counts against maxWorkers.
              env: { SUMMON_TEST_SKIP_QUEUES: skip },
            });
            kills.push(platform.kill);
            const failures: SummonFailure[] = [];
            const { controller, events } = shared(namespace, {
              summoner: platform.summoner,
              // A partial attempt settles only once its `until` passes (the
              // missing queue could still register), so this is how long each
              // partial takes. Kept far above a unit's boot (about 260 ms
              // idle): a boot slower than the budget is a `lost`, which would
              // spend the circuit's two failures on something else entirely.
              bootBudget: 8_000,
              circuit: { failures: 2, resetAfter: 60_000 },
              onSummonFailed: (failure) => {
                failures.push(failure);
              },
            });
            await checkUntil(
              controller,
              () => events.some((event) => event.outcome === "registered"),
              30_000,
              "the first registration",
            );
            const first = events.find(
              (event) => event.outcome === "registered",
            )!;
            if (skip === "") {
              expect(first.detail).toBeUndefined();
              expect((await controller.status()).failures).toBe(0);
              await controller.close();
              return;
            }
            expect(first.detail).toBe("partial:thumbs");
            const after = await controller.status();
            expect(after.failures).toBe(1);
            expect(after.last).toMatchObject({
              id: first.id,
              outcome: "registered",
              detail: "partial:thumbs",
            });
            // thumbs still starves, so it summons again — and the second
            // partial opens the circuit (2 failures): then nothing more.
            await checkUntil(
              controller,
              () =>
                events.filter((event) => event.detail === "partial:thumbs")
                  .length >= 2,
              30_000,
              "the second partial registration",
            );
            expect(await controller.check()).toMatchObject({
              action: "skipped",
              reason: "circuit-open",
            });
            expect(platform.calls).toHaveLength(2);
            expect((await controller.status()).failures).toBe(2);
            await Bun.sleep(50);
            // Q4: no hook for a partial unit; the circuit's opening is the alert.
            expect(failures.map((failure) => failure.outcome)).toEqual([
              "circuit-open",
            ]);
            await controller.close();
          },
        );
      }

      for (const count of [1, 2]) {
        it(`a double start of ${count} unit${count === 1 ? "" : "s"} splits no queue's places, and releases once (B5)`, async () => {
          const namespace = fresh(`double-${count}`);
          await seed(namespace, { renders: 4, thumbs: 4, previews: 4 });
          const platform = spawningSummoner({
            driver: backend.config,
            worker: UNIT,
            startTwice: true,
            env: { SUMMON_TEST_JOB_MS: "300", SUMMON_TEST_IDLE_MS: "300" },
          });
          kills.push(platform.kill);
          const { controller, events } = shared(namespace, {
            summoner: platform.summoner,
            maxWorkers: count,
            jobsPerWorker: 1,
          });
          let most: Record<string, number> = {};
          await checkUntil(
            controller,
            () => events.some((event) => event.outcome === "registered"),
            30_000,
            "the registration",
          );
          const id = events.find((event) => event.outcome === "started")!.id;
          expect(platform.calls[0]!.count).toBe(count);
          // Per queue, never more summoned records than places asked for.
          await waitUntil(
            async () => {
              const now = await holders(namespace, id);
              for (const queue of QUEUES) {
                most[queue] = Math.max(most[queue] ?? 0, now[queue]!);
                expect(now[queue]!).toBeLessThanOrEqual(count);
              }
              return platform.spawned.length === count * 2;
            },
            10_000,
            "every process started",
          );
          // Every process drains and exits on idle.
          await platform.settled();
          for (const unit of platform.spawned) {
            expect(await unit.exited).toBe(0);
          }
          most = await holders(namespace, id);
          expect(
            events.filter(
              (event) => event.outcome === "registered" && event.id === id,
            ),
          ).toHaveLength(1);
          for (const queue of QUEUES) {
            const claims = await readSummonClaims(
              driver,
              { ns: namespace, queue },
              [id],
            );
            // Opened for `count` on every queue before the call, so every
            // queue's places were all taken, and no more.
            expect({
              queue,
              capacity: claims.get(id)!.capacity,
              holders: claims.get(id)!.holders.length,
            }).toEqual({ queue, capacity: count, holders: count });
          }
          await controller.close();
        });
      }

      it("a unit SIGKILLed after its first job is one late lost (died) for the attempt, not three (B7)", async () => {
        const namespace = fresh("kill");
        await seed(namespace, { renders: 1, thumbs: 1, previews: 1 });
        const platform = spawningSummoner({
          driver: backend.config,
          worker: UNIT,
          env: { SUMMON_TEST_KILL_AFTER_FIRST: "1500" },
        });
        kills.push(platform.kill);
        const { controller, events } = shared(namespace, {
          summoner: platform.summoner,
          // Far above a unit's boot, so a slow boot is never the loss; the
          // kill (1.5 s after the first job) lands inside the watch.
          bootBudget: 10_000,
          // One attempt only: the death must not be followed by another.
          cooldown: 600_000,
          circuit: { failures: 10 },
        });
        await checkUntil(
          controller,
          () => events.some((event) => event.outcome === "registered"),
          30_000,
          "the registration",
        );
        const id = events.find((event) => event.outcome === "registered")!.id;
        expect((await controller.status()).failures).toBe(0);
        await checkUntil(
          controller,
          () => events.some((event) => event.outcome === "lost"),
          60_000,
          "the late loss",
        );
        // A few more checks: no second loss for the same attempt.
        for (let index = 0; index < 5; index++) {
          await controller.check();
          await Bun.sleep(50);
        }
        const lost = events.filter((event) => event.outcome === "lost");
        expect(lost).toEqual([
          expect.objectContaining({ id, outcome: "lost", detail: "died" }),
        ]);
        const status = await controller.status();
        expect(status.failures).toBe(1);
        expect(status.last).toMatchObject({
          id,
          outcome: "lost",
          detail: "died",
        });
        expect(platform.calls).toHaveLength(1);
        await controller.close();
      });
    },
  );
}
