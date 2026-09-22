import type { RunRecord } from "../lib/drivers/driver";
import type { JobsDriver, QueueRef } from "../lib/index";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { spawnSync } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import { encodeName, encodeSegment } from "../lib/drivers/file-names";
import { FileDriver, RedisDriver, runnerKey } from "../lib/index";
import { newToken } from "../lib/shared/ids";
import { makeJob, makeTmpDir, testNamespace } from "./helpers";

/**
 * The two clear actions on the file and Redis drivers, where the shared
 * contract cannot reach: what happens when they race the operations that
 * could make them lose a line they must keep.
 *
 * - `clearJobLogs` racing a claim. The state check has to be one step with
 *   the delete; checked apart, a worker that claims in between writes a line
 *   the clear then deletes, or the clear answers `cleared` for a log it only
 *   half emptied.
 * - `removeRuns` beside a run that was not named. Its record and every line
 *   of its log must come through whole, whatever is appended or settled
 *   meanwhile, and whatever its id has in common with a named one.
 *
 * The Redis half needs `BUN_JOBS_TEST_REDIS_URL`, and skips visibly without.
 */

/** The Redis server, when one is configured. */
const URL = process.env.BUN_JOBS_TEST_REDIS_URL;

/** Work to undo when the file ends: temp directories, namespaces, drivers. */
const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const cleanup of cleanups.toReversed()) {
    await cleanup().catch(() => undefined);
  }
});

/** A connected file driver over a directory of its own. */
async function fileDriver(): Promise<JobsDriver> {
  const tmp = await makeTmpDir("bun-jobs-clear");
  const driver = new FileDriver({ root: tmp.path });
  await driver.connect();
  cleanups.push(tmp.cleanup, () => driver.close());
  return driver;
}

/** A connected Redis driver on the configured server. */
async function redisDriver(): Promise<JobsDriver> {
  const driver = new RedisDriver({ url: URL });
  await driver.connect();
  cleanups.push(() => driver.close());
  return driver;
}

/** A namespace this file made, purged (exactly it) when the file ends. */
function space(driver: JobsDriver, name: string): string {
  const ns = testNamespace(`clearrace-${name}`);
  cleanups.push(() => driver.purge(ns));
  return ns;
}

/** The whole job log, oldest first. */
const ALL = { offset: 0, limit: 1000, order: "asc" } as const;

/** Waits `count` turns of the event loop. */
async function turns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** A settled run record. */
function run(runId: string, startedAt: number): RunRecord {
  return {
    runId,
    runnerId: "clear-race",
    attempt: 1,
    source: "manual",
    mode: "in-process",
    host: "h",
    startedAt,
    status: "success",
    finishedAt: startedAt + 5,
    durationMs: 5,
  };
}

const BACKENDS: {
  name: string;
  skip: boolean;
  make: () => Promise<JobsDriver>;
}[] = [
  { name: "file", skip: false, make: fileDriver },
  { name: "redis", skip: !URL, make: redisDriver },
];

for (const backend of BACKENDS) {
  describe.skipIf(backend.skip)(
    `clear actions under contention: ${backend.name}${backend.skip ? " (set BUN_JOBS_TEST_REDIS_URL)" : ""}`,
    () => {
      it("a clear racing a claim never removes a line the worker could see", async () => {
        const driver = await backend.make();
        const ns = space(driver, "claim");
        const outcomes = { active: 0, cleared: 0 };
        /** What the worker writes, one line at a time, once it has the job. */
        const WORKER_LINES = ["w1", "w2"];
        /** How many clears race each claim, each with its own head start. */
        const CLEARS = 6;

        /** Waits `turns` turns of the event loop. */
        const pause = async (turns: number): Promise<void> => {
          for (let turn = 0; turn < turns; turn++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        };

        /**
         * One race, on a queue of its own so the claim can only take this
         * job. The worker reads the log the moment it has the job, then
         * writes; several clears run alongside, staggered in event-loop turns
         * — a timer's millisecond is coarser than the window, and would only
         * ever order the two sides, never interleave them.
         *
         * What makes a violation visible is the worker's read. A line it saw
         * after claiming was in an active job's log, so a clear that removed
         * it cleared an active job: every clear must then have answered
         * `active`. And nothing the worker saw or wrote may be missing at the
         * end.
         */
        async function race(index: number): Promise<void> {
          const q: QueueRef = { ns, queue: `race-${index}` };
          const id = `job-${index}`;
          await driver.addJob(q, makeJob({ id, runAt: Date.now() }));
          expect(await driver.addJobLog!(q, id, "old", 0)).toBe(1);

          const worker = (async (): Promise<string[]> => {
            await pause(index % 3);
            // A clear holding the job can make a claim come back empty on the
            // file driver; the job is still there, so ask again.
            for (let attempt = 0; attempt < 500; attempt++) {
              const claimed = await driver.claimJob(q, {
                workerId: `w${index}`,
                token: newToken(),
                lockMs: 60_000,
                now: Date.now(),
              });
              if (claimed) {
                expect(claimed.id).toBe(id);
                const seen = (await driver.getJobLogs!(q, id, ALL)).logs;
                for (const line of WORKER_LINES) {
                  await driver.addJobLog!(q, id, line, 0);
                }
                return seen;
              }
              await pause(1);
            }
            throw new Error(`job ${id} was never claimed`);
          })();

          const clears = Array.from({ length: CLEARS }, async (_u, i) => {
            await pause(i * (1 + (index % 6)) + (index % 5));
            return await driver.clearJobLogs!(q, id);
          });

          const [seen, ...results] = await Promise.all([worker, ...clears]);
          const log = await driver.getJobLogs!(q, id, ALL);

          if (seen.includes("old")) {
            outcomes.active++;
            expect(results).toEqual(
              Array.from({ length: CLEARS }, () => ({ status: "active" })),
            );
          } else {
            outcomes.cleared++;
            // Exactly one clear took the old line; any other that got in
            // before the claim found nothing, and the rest were refused.
            const removed = results.map((result) =>
              result.status === "cleared" ? result.removed : 0,
            );
            expect(removed.reduce((sum, n) => sum + n, 0)).toBe(1);
          }

          expect(log).toEqual({
            logs: [...seen, ...WORKER_LINES],
            count: seen.length + WORKER_LINES.length,
          });
        }

        // In waves, so the races genuinely overlap each other too.
        for (let wave = 0; wave < 16; wave++) {
          await Promise.all(
            Array.from({ length: 10 }, (_u, i) => race(wave * 10 + i)),
          );
        }

        expect(outcomes.active + outcomes.cleared).toBe(160);
      });

      it("a clear arriving once the job is claimed refuses however the claim got there", async () => {
        const driver = await backend.make();
        const ns = space(driver, "claimed");
        const q: QueueRef = { ns, queue: "busy" };
        await driver.addJob(q, makeJob({ id: "busy", runAt: Date.now() }));
        await driver.addJobLog!(q, "busy", "a", 0);

        const claimed = await driver.claimJob(q, {
          workerId: "w",
          token: newToken(),
          lockMs: 60_000,
          now: Date.now(),
        });
        expect(claimed?.id).toBe("busy");

        // Many at once, each against the same active job: none may win.
        const results = await Promise.all(
          Array.from({ length: 20 }, () => driver.clearJobLogs!(q, "busy")),
        );
        expect(results.every((result) => result.status === "active")).toBe(
          true,
        );
        expect(await driver.getJobLogs!(q, "busy", ALL)).toEqual({
          logs: ["a"],
          count: 1,
        });
      });

      it("names runs exactly: an id that contains or extends a named one keeps its record and its log", async () => {
        const driver = await backend.make();
        const ns = space(driver, "exact");
        const key = runnerKey("exact");
        const ids = ["run-1", "run-10", "xrun-1", "run-1:lines", "run"];

        for (const [index, runId] of ids.entries()) {
          await driver.appendHistory(ns, key, run(runId, 1_000 + index), 0);
          await driver.appendRunLog!(
            ns,
            key,
            runId,
            [{ stream: "stdout", at: 1_000 + index, text: `${runId} line` }],
            { maxLines: 0, maxBytes: 0, keepRuns: 0 },
          );
        }

        expect(await driver.removeRuns!(ns, key, ["run-1"])).toBe(1);

        const left = (await driver.listHistory(ns, key))
          .map((entry) => entry.runId)
          .sort();
        expect(left).toEqual(["run", "run-10", "run-1:lines", "xrun-1"]);

        expect(
          (await driver.getRunLog!(ns, key, "run-1", { ...ALL })).count,
        ).toBe(0);
        for (const runId of left) {
          const page = await driver.getRunLog!(ns, key, runId, { ...ALL });
          expect(page.lines.map((line) => line.text)).toEqual([
            `${runId} line`,
          ]);
        }
      });

      it("an unnamed run keeps every line and every record written while named runs are removed", async () => {
        const driver = await backend.make();
        const ns = space(driver, "inflight");
        const key = runnerKey("inflight");
        const caps = { maxLines: 0, maxBytes: 0, keepRuns: 0 };

        await driver.appendHistory(
          ns,
          key,
          { ...run("live", 500), status: "running" },
          0,
        );
        await driver.appendRunLog!(
          ns,
          key,
          "live",
          [{ stream: "stdout", at: 500, text: "live 0" }],
          caps,
        );

        /** Finished runs, each with a record and a log, to be removed. */
        async function finished(round: number): Promise<string[]> {
          const names = [`done-${round}-a`, `done-${round}-b`];
          for (const runId of names) {
            await driver.appendHistory(ns, key, run(runId, 1_000 + round), 0);
            await driver.appendRunLog!(
              ns,
              key,
              runId,
              [{ stream: "stdout", at: 1_000 + round, text: runId }],
              caps,
            );
          }
          return names;
        }

        const ROUNDS = 24;
        let appended = 1;
        const newcomers: string[] = [];

        for (let round = 0; round < ROUNDS; round++) {
          const names = await finished(round);
          const newcomer = `new-${round}`;
          newcomers.push(newcomer);

          // The live run logs, and a run that started after the caller
          // looked is recorded, while the finished ones are removed.
          const [removed] = await Promise.all([
            driver.removeRuns!(ns, key, names),
            driver.appendRunLog!(
              ns,
              key,
              "live",
              [
                { stream: "stdout", at: 2_000 + round, text: `live ${round}a` },
                { stream: "stdout", at: 2_000 + round, text: `live ${round}b` },
              ],
              caps,
            ),
            // Staggered in event-loop turns, so over the rounds the record
            // lands at every point of the removal's read and write.
            turns(round % 8).then(
              async () =>
                await driver.appendHistory(
                  ns,
                  key,
                  run(newcomer, 3_000 + round),
                  0,
                ),
            ),
          ]);
          appended += 2;

          expect(removed).toBe(2);
        }

        const page = await driver.getRunLog!(ns, key, "live", { ...ALL });
        expect(page.count).toBe(appended);
        expect(page.lastSeq).toBe(appended);
        expect(page.dropped).toBe(0);
        expect(page.lines.map((line) => line.seq)).toEqual(
          Array.from({ length: appended }, (_u, i) => i + 1),
        );

        const left = (await driver.listHistory(ns, key))
          .map((entry) => entry.runId)
          .sort();
        expect(left).toEqual(["live", ...newcomers].sort());

        // And it settles as if nothing had happened around it.
        expect(
          await driver.updateHistory(ns, key, "live", {
            status: "success",
            finishedAt: 4_000,
            durationMs: 3_500,
          }),
        ).toBe(true);
      });
    },
  );
}

/** Whether this system can make a named pipe, which the next case needs. */
const HAS_MKFIFO =
  process.platform !== "win32" &&
  spawnSync(["sh", "-c", "command -v mkfifo"]).exitCode === 0;

describe.skipIf(!HAS_MKFIFO)(
  "clearJobLogs on the file driver: the claim lands mid-clear",
  () => {
    it("a claim arriving while a clear is part-way through cannot take the job", async () => {
      const tmp = await makeTmpDir("bun-jobs-clear-fifo");
      cleanups.push(tmp.cleanup);
      const driver = new FileDriver({ root: tmp.path });
      await driver.connect();
      cleanups.push(() => driver.close());

      const q: QueueRef = { ns: testNamespace("clearfifo"), queue: "q" };
      const job = makeJob({ id: "job", runAt: Date.now() });
      await driver.addJob(q, job);

      // The job's log, as a named pipe: reading it blocks until something is
      // written, which parks the clear exactly between deciding it may clear
      // and deleting — the window a claim must not be able to use. Where the
      // log lives is the driver's layout, the same one its other tests read.
      const logs = join(
        tmp.path,
        encodeSegment(q.ns),
        "queues",
        encodeSegment(q.queue),
        "logs",
      );
      const log = join(logs, `${encodeName(job.id)}.${job.createdAt}.jsonl`);
      expect(spawnSync(["mkdir", "-p", logs]).exitCode).toBe(0);
      expect(spawnSync(["mkfifo", log]).exitCode).toBe(0);

      const clearing = driver.clearJobLogs(q, "job");
      // Long enough for the clear to reach the pipe and block on it.
      await Bun.sleep(50);

      const claim = () =>
        driver.claimJob(q, {
          workerId: "w",
          token: newToken(),
          lockMs: 60_000,
          now: Date.now(),
        });

      // Mid-clear: the job is held, so no claim can take it.
      const early = await claim();

      // Let the clear finish: one line arrives through the pipe.
      await writeFile(log, `${JSON.stringify("old")}\n`);
      const result = await clearing;

      expect(early).toBeNull();
      expect(result).toEqual({ status: "cleared", removed: 1 });

      // Once it is done the job is claimable, and its log starts empty.
      expect((await claim())?.id).toBe("job");
      expect(await driver.getJobLogs(q, "job", ALL)).toEqual({
        logs: [],
        count: 0,
      });
    });
  },
);
