import type { JobsDriver } from "../lib/index";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { createDriver } from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";
import { runBun, spawnBun } from "./helpers/spawnBun";

/**
 * Producers and consumers in **separate processes**, against every driver
 * that claims to support them.
 *
 * This is the guarantee the whole package rests on: several processes may add
 * to a queue and several others may consume it, and each job is processed
 * exactly once. It cannot be tested from a single process — two driver
 * instances in one runtime still share a heap and an event loop — so these
 * spawn real `bun` processes whose only common ground is the backend.
 *
 * Every driver with `capabilities.multiProcess` runs the same suite. The
 * memory driver is excluded on purpose: it says it cannot do this, and the
 * exclusion is asserted rather than assumed. Redis, Postgres and MySQL join
 * in when their URLs are set.
 */

const PRODUCER = join(
  import.meta.dir,
  "fixtures",
  "processes",
  "queue-producer.ts",
);
const CONSUMER = join(
  import.meta.dir,
  "fixtures",
  "processes",
  "queue-consumer.ts",
);

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** Lines the consumers appended, as `<consumerId>:<jobId>`. */
async function processed(log: string): Promise<string[]> {
  return (await readFile(log, "utf8")).split("\n").filter(Boolean);
}

/**
 * Every backend that claims it can carry work between processes. The list is
 * shared with the runner suite, so a backend cannot be covered by one and
 * quietly missed by the other.
 */
const READY = await crossProcessBackends({ cleanups });

for (const { name: backendName, config, available } of READY) {
  describe.skipIf(!available)(`queue across processes: ${backendName}`, () => {
    /**
     * Sets up a namespace, a run log and the config every child receives.
     * Skips the whole suite when the backend has not landed yet.
     */
    async function setup(): Promise<{
      env: Record<string, string>;
      log: string;
      driver: JobsDriver;
      namespace: string;
    }> {
      const driver = createDriver(config);
      await driver.connect();

      const namespace = testNamespace(backendName);
      const tmp = await makeTmpDir("bun-jobs-log");
      cleanups.push(tmp.cleanup);
      const log = join(tmp.path, "processed.log");
      await writeFile(log, "");

      cleanups.push(async () => {
        await driver.purge(namespace);
        await driver.close();
      });

      return {
        namespace,
        log,
        driver,
        env: {
          NAMESPACE: namespace,
          QUEUE: "work",
          DRIVER_CONFIG: JSON.stringify(config),
          RUN_LOG: log,
        },
      };
    }

    it("delivers each job to exactly one of several consumer processes", async () => {
      const { env, log, driver, namespace } = await setup();
      const total = 40;

      // Two consumers, started first so they are already claiming.
      const consumers = ["c1", "c2"].map((id) =>
        spawnBun(CONSUMER, {
          ...env,
          CONSUMER_ID: id,
          STOP_AFTER: String(total),
          RUN_FOR_MS: "30000",
          JOB_MS: "2",
        }),
      );

      // Two producers, each adding its own half.
      await Promise.all(
        ["p1", "p2"].map((prefix) =>
          runBun(PRODUCER, {
            ...env,
            JOB_PREFIX: prefix,
            JOB_COUNT: String(total / 2),
          }),
        ),
      );

      await waitFor(async () => (await processed(log)).length >= total, {
        timeout: 45_000,
        interval: 50,
        message: "consumers did not finish the jobs",
      });

      await Promise.all(consumers.map((consumer) => consumer.exited));

      const lines = await processed(log);
      const jobIds = lines.map((line) => line.split(":")[1]);

      // Exactly once each: no job processed twice, none missed.
      expect(new Set(jobIds).size).toBe(total);
      expect(jobIds).toHaveLength(total);

      // Both consumers did some of it, so the work really was shared.
      const byConsumer = new Set(lines.map((line) => line.split(":")[0]));
      expect(byConsumer.size).toBe(2);

      // And the queue agrees: everything completed.
      const counts = await driver.countJobs({ ns: namespace, queue: "work" });
      expect(counts.completed).toBe(total);
      expect(counts.waiting + counts.active + counts.dead).toBe(0);
    }, 90_000);

    it("lets a producer add while consumers are already running", async () => {
      const { env, log } = await setup();

      const consumer = spawnBun(CONSUMER, {
        ...env,
        CONSUMER_ID: "live",
        STOP_AFTER: "5",
        RUN_FOR_MS: "30000",
      });

      // Nothing to do yet; the consumer is idling.
      await Bun.sleep(200);
      expect(await processed(log)).toHaveLength(0);

      await runBun(PRODUCER, { ...env, JOB_PREFIX: "late", JOB_COUNT: "5" });

      await waitFor(async () => (await processed(log)).length === 5, {
        timeout: 45_000,
        interval: 50,
        message: "a job added after the consumer started was not picked up",
      });

      await consumer.exited;
    }, 90_000);

    it("retries a failed job on whichever consumer is free", async () => {
      const { env, log, driver, namespace } = await setup();

      // Every consumer fails the first time *it* sees a job, so a job whose
      // retry lands on the other consumer needs a third attempt.
      const consumers = ["r1", "r2"].map((id) =>
        spawnBun(CONSUMER, {
          ...env,
          CONSUMER_ID: id,
          FAIL_FIRST: "1",
          STOP_AFTER: "6",
          RUN_FOR_MS: "30000",
        }),
      );

      // A short fixed backoff, so the test measures retry delivery rather
      // than the default exponential schedule.
      const produced = await runBun<{ event: string; ids?: string[] }>(
        PRODUCER,
        {
          ...env,
          JOB_PREFIX: "retry",
          JOB_COUNT: "6",
          JOB_ATTEMPTS: "4",
          JOB_BACKOFF: "50",
        },
      );

      expect([
        produced.exitCode,
        produced.lines.find((line) => line.event === "produced")?.ids?.length,
        produced.stderr,
      ]).toEqual([0, 6, ""]);

      await waitFor(async () => (await processed(log)).length >= 6, {
        timeout: 45_000,
        interval: 50,
        message: async () => {
          const ref = { ns: namespace, queue: "work" };
          const counts = await driver.countJobs(ref);
          const jobs = await driver.listJobs(
            ref,
            ["waiting", "delayed", "active", "completed", "failed", "dead"],
            { offset: 0, limit: 50, order: "asc" },
          );
          const stderr = await Promise.all(
            consumers.map((consumer) => consumer.errors),
          );

          return [
            "retried jobs never completed",
            `counts=${JSON.stringify(counts)}`,
            `jobs=${JSON.stringify(jobs.map((job) => [job.id, job.state, job.attemptsMade]))}`,
            `log=${JSON.stringify(await processed(log))}`,
            `stderr=${stderr.join(" | ")}`,
          ].join("; ");
        },
      });

      await Promise.all(consumers.map((consumer) => consumer.exited));

      const counts = await driver.countJobs({ ns: namespace, queue: "work" });
      expect(counts.completed).toBe(6);
      expect(counts.dead).toBe(0);
    }, 90_000);

    it("keeps two namespaces on one backend apart", async () => {
      const first = await setup();
      const second = await setup();

      // Same queue name, same backend, different namespaces.
      const consumer = spawnBun(CONSUMER, {
        ...first.env,
        CONSUMER_ID: "ns-a",
        STOP_AFTER: "3",
        RUN_FOR_MS: "30000",
      });

      await runBun(PRODUCER, {
        ...first.env,
        JOB_PREFIX: "mine",
        JOB_COUNT: "3",
      });
      await runBun(PRODUCER, {
        ...second.env,
        JOB_PREFIX: "theirs",
        JOB_COUNT: "3",
      });

      await waitFor(async () => (await processed(first.log)).length === 3, {
        timeout: 45_000,
        interval: 50,
        message: "the consumer did not finish its own namespace's jobs",
      });

      await consumer.exited;

      // It took only its own namespace's jobs, and never saw the others.
      const mine = await processed(first.log);
      expect(mine.every((line) => line.includes("mine-"))).toBe(true);

      const theirs = await second.driver.countJobs({
        ns: second.namespace,
        queue: "work",
      });
      expect(theirs.waiting).toBe(3);
      expect(theirs.completed).toBe(0);
    }, 90_000);
  });
}

describe("queue across processes: capabilities", () => {
  it("says which drivers can be shared, rather than leaving it to be found out", () => {
    const memory = createDriver({ type: "memory" });
    expect(memory.capabilities.multiProcess).toBe(false);

    // Every backend the suite actually ran against claims it can be shared.
    for (const { name, config, available } of READY) {
      if (!available) {
        continue;
      }
      const driver = createDriver(config);
      expect([name, driver.capabilities.multiProcess]).toEqual([name, true]);
    }
  });
});
