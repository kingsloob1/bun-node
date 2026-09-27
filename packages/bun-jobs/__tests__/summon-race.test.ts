import type { JobsDriver, QueueRef } from "../lib/index";
import type { SpawnedProcess } from "./helpers/spawnBun";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import {
  BunQueue,
  createDriver,
  defineSummoner,
  SummonController,
} from "../lib/index";
import { SUMMON_ARGS } from "../lib/summon/args";
import { SUMMON_MARKER } from "../lib/summon/marker";
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";
import { runBun, spawnBun } from "./helpers/spawnBun";
import { SUMMONED_WORKER, workerLines } from "./helpers/summon";

/**
 * Races between processes, which one process cannot stage: two controllers
 * claiming the marker at once (the compare-and-set), and two workers started
 * with the same attempt id (claim-once).
 */

setDefaultTimeout(60_000);

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

/** What one test opened, closed after it, so connections never pile up across rounds. */
const perTest: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of perTest.splice(0)) {
    await cleanup().catch(() => {});
  }
});

const RACER = join(import.meta.dir, "fixtures", "processes", "summon-racer.ts");
const BACKENDS = await crossProcessBackends({ cleanups });

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(`summon races: ${backend.name}`, () => {
    /** A fresh namespace with one waiting job, and a cleanup that purges it. */
    async function seed(): Promise<{
      driver: JobsDriver;
      namespace: string;
      ref: QueueRef;
      done: () => Promise<void>;
    }> {
      const driver = createDriver(backend.config);
      await driver.connect();
      const namespace = testNamespace(`race-${backend.name}`);
      const queue = new BunQueue("work", {
        namespace,
        driver,
        logger: noopLogger,
      });
      await queue.add("a", {});
      await queue.close();
      let closed = false;
      const done = async (): Promise<void> => {
        if (!closed) {
          closed = true;
          await driver.purge(namespace);
          await driver.close();
        }
      };
      perTest.push(done);
      return { driver, namespace, ref: { ns: namespace, queue: "work" }, done };
    }

    it("two controllers in two processes claim one attempt (the compare-and-set)", async () => {
      for (let round = 0; round < 3; round++) {
        const { driver, namespace, ref, done } = await seed();
        const env = {
          SUMMON_TEST_DRIVER: JSON.stringify(backend.config),
          SUMMON_TEST_NAMESPACE: namespace,
          SUMMON_TEST_START_AT: String(Date.now() + 1_500),
          SUMMON_TEST_CHECKS: "3",
        };
        const [one, two] = await Promise.all([
          runBun<Record<string, unknown>>(RACER, env),
          runBun<Record<string, unknown>>(RACER, env),
        ]);
        expect(one.exitCode, one.stderr).toBe(0);
        expect(two.exitCode, two.stderr).toBe(0);
        const lines = [...one.lines, ...two.lines];
        const calls = lines.filter((line) => "call" in line);
        const summoned = lines.filter((line) => line.action === "summoned");

        expect(calls).toHaveLength(1);
        expect(summoned).toHaveLength(1);
        // Every other check was held back by the attempt on its way, or lost the write.
        for (const line of lines.filter((line) => line.action === "skipped")) {
          expect(["pending", "contended"]).toContain(String(line.reason));
        }
        const marker = await driver.getQueueState!(ref, SUMMON_MARKER);
        expect((marker?.value as { pending: unknown[] }).pending).toHaveLength(
          1,
        );
        // One round's connections gone before the next round opens any.
        await done();
      }
    });

    it("two workers started with one attempt id: exactly one summoned record, the other runs unsummoned (claim-once)", async () => {
      const { driver, namespace, ref } = await seed();
      const id = `sm_claimonce${Date.now().toString(36)}`;
      const args = [
        `${SUMMON_ARGS.id}=${id}`,
        `${SUMMON_ARGS.kind}=fake`,
        `${SUMMON_ARGS.namespace}=${namespace}`,
        `${SUMMON_ARGS.queue}=work`,
      ];
      const env = {
        SUMMON_TEST_DRIVER: JSON.stringify(backend.config),
        SUMMON_TEST_IDLE_MS: "1500",
      };
      const workers = [
        spawnBun(SUMMONED_WORKER, env, args),
        spawnBun(SUMMONED_WORKER, env, args),
      ];
      const exits = await Promise.all(
        workers.map(async (one) => await one.exited),
      );
      const lines = await Promise.all(workers.map(workerLines));
      expect(
        exits,
        (await Promise.all(workers.map(async (one) => await one.errors))).join(
          "\n",
        ),
      ).toEqual([0, 0]);

      const records = lines.map(
        (own) => own.find((line) => line.event === "record")!,
      );
      const summoned = records.filter((record) => record.summon !== null);
      const plain = records.filter((record) => record.summon === null);
      expect(summoned).toHaveLength(1);
      expect(plain).toHaveLength(1);
      expect(summoned[0]!.summon).toMatchObject({ id, kind: "fake" });
      expect(summoned[0]!.held).toMatchObject({ id });
      // The loser runs as an ordinary worker, and says so everywhere.
      expect(plain[0]!.held).toBeNull();
      // The job was processed once, by one of them.
      expect(
        lines.flat().filter((line) => line.event === "processed"),
      ).toHaveLength(1);
      await driver.connect();
      expect(await driver.listWorkers!(ref, Date.now())).toHaveLength(0);
    });

    it("a restarted worker takes over the claim of one whose record lapsed, never of a live one (scale style, count 2)", async () => {
      const { driver, namespace, ref } = await seed();
      await new BunQueue("work", { namespace, driver, logger: noopLogger }).add(
        "b",
        {},
      );
      const argv: string[][] = [];
      const controller = new SummonController({
        driver,
        namespace,
        queue: "work",
        summoner: defineSummoner({
          style: "scale",
          invoke: async (request) => {
            argv.push([...request.argv]);
          },
          release: async () => {},
        }),
        maxWorkers: 2,
        jobsPerWorker: 1,
        triggers: { onAdd: false, events: false, poll: false },
        logger: noopLogger,
      });
      perTest.unshift(async () => await controller.close());
      expect(await controller.check()).toMatchObject({ action: "summoned" });
      const args = argv[0]!;
      const id = args
        .find((arg) => arg.startsWith(`${SUMMON_ARGS.id}=`))!
        .split("=")[1]!;

      const started: SpawnedProcess[] = [];
      perTest.unshift(async () => {
        for (const one of started) {
          one.proc.kill("SIGKILL");
        }
        await Promise.all(started.map(async (one) => await one.exited));
      });
      const start = (env: Record<string, string>): SpawnedProcess => {
        const one = spawnBun(
          SUMMONED_WORKER,
          {
            SUMMON_TEST_DRIVER: JSON.stringify(backend.config),
            SUMMON_TEST_STALLED_MS: "300",
            SUMMON_TEST_LOCK_MS: "1000",
            ...env,
          },
          args,
        );
        started.push(one);
        return one;
      };
      const summonedRecords = async () =>
        (await driver.listWorkers!(ref, Date.now())).filter(
          (one) => one.summon?.id === id,
        );

      // The two units the attempt asked for; the first will crash.
      const first = start({
        SUMMON_TEST_CRASH_AFTER_MS: "5000",
        SUMMON_TEST_IDLE_MS: "60000",
      });
      // The second unit runs throughout; it is killed with the rest at the
      // end, since how it ends is not what this test is about.
      start({ SUMMON_TEST_IDLE_MS: "8000" });
      await waitFor(async () => (await summonedRecords()).length === 2, {
        timeout: 10_000,
      });

      // Restarted while both holders are live: a double start, so it loses.
      // Past the holders' `until` first (one record lifetime, 600 ms here),
      // so it is their live records alone that keep their places.
      await Bun.sleep(1_000);
      expect(await summonedRecords()).toHaveLength(2);
      const early = start({ SUMMON_TEST_IDLE_MS: "300" });
      expect(await early.exited, await early.errors).toBe(0);
      const earlyRecord = (await workerLines(early)).find(
        (line) => line.event === "record",
      );
      expect(earlyRecord?.summon).toBeNull();
      expect(earlyRecord?.held).toBeNull();

      // The first unit dies without a word; once its record lapses, a
      // restart with the same arguments takes its place.
      expect(await first.exited).toBe(1);
      await waitFor(async () => (await summonedRecords()).length === 1, {
        timeout: 10_000,
      });
      const restarted = start({ SUMMON_TEST_IDLE_MS: "300" });
      expect(await restarted.exited, await restarted.errors).toBe(0);
      const restartedRecord = (await workerLines(restarted)).find(
        (line) => line.event === "record",
      );
      expect(restartedRecord?.summon).toMatchObject({ id });
      expect(restartedRecord?.held).toMatchObject({ id });
    });
  });
}
