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
import { makeTmpDir, testNamespace, waitFor } from "./helpers";
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
      // Neither may go idle and exit before both have claimed: one that
      // started much later (3.8 s apart was seen under load) otherwise
      // found the first gone, and rightly took its place as a restart.
      const gate = await makeTmpDir("bun-jobs-summon-race");
      perTest.push(gate.cleanup);
      const go = join(gate.path, "go");
      const env = {
        SUMMON_TEST_DRIVER: JSON.stringify(backend.config),
        SUMMON_TEST_IDLE_MS: "1500",
        SUMMON_TEST_GO_FILE: go,
        // A record lifetime of 3 s: at 600 ms a live holder starved under
        // load could lapse, and its place read as free.
        SUMMON_TEST_REPORT_MS: "1000",
      };
      const workers = [
        spawnBun(SUMMONED_WORKER, env, args),
        spawnBun(SUMMONED_WORKER, env, args),
      ];
      // Both have claimed once both records are listed (a worker claims
      // before its first record): only then may they go idle.
      await waitFor(
        async () => (await driver.listWorkers!(ref, Date.now())).length === 2,
        { timeout: 30_000 },
      );
      await Bun.write(go, "");
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
            // A record lifetime of 3 s (three reports): at 200 ms (600 ms),
            // a live holder starved under load missed it, and its place
            // read as free or its record as gone.
            SUMMON_TEST_REPORT_MS: "1000",
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

      // The two units the attempt asked for; the first will crash. The test
      // kills it, once the early restart below has claimed: on its own
      // timer (5 s after it started, as it was) it could die while that
      // restart was still booting, which under load took long enough
      // (3.8 s) for its record to lapse first — and the restart then
      // rightly took a dead holder's place. Neither unit holds a job, so
      // the backlog drains and the restarts below go idle and exit.
      const first = start({ SUMMON_TEST_IDLE_MS: "60000" });
      // The second unit runs throughout; it is killed with the rest at the
      // end, since how it ends is not what this test is about.
      start({ SUMMON_TEST_IDLE_MS: "60000" });
      await waitFor(async () => (await summonedRecords()).length === 2, {
        timeout: 30_000,
      });

      // Restarted while both holders are live: a double start, so it loses.
      // Past the holders' `until` first (one record lifetime, 3 s here),
      // so it is their live records alone that keep their places.
      await Bun.sleep(3_500);
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
      first.proc.kill("SIGKILL");
      await first.exited;
      expect(first.proc.signalCode).toBe("SIGKILL");
      await waitFor(async () => (await summonedRecords()).length === 1, {
        timeout: 30_000,
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
