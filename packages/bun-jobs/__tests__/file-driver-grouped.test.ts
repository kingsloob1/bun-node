import type { MetricsQuery } from "../lib/drivers/driver";
import type { FileDriverOptions } from "../lib/drivers/file-driver";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { MINUTE_BUCKET_MS } from "../lib/api/contract/constants";
import { FileDriver } from "../lib/drivers/file-driver";
import { encodeSegment } from "../lib/drivers/file-names";
import { bucketStart, NAMESPACE_ENTITY } from "../lib/drivers/metrics";
import { runnerKey } from "../lib/shared/keys";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * The grouped analytics reads on the file driver, beyond the shared contract
 * block: what is specific to a backend that keeps minutes only, and to one
 * that finds its entities by listing directories.
 */

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** A connected driver over a fresh directory. */
async function freshDriver(
  options: Omit<FileDriverOptions, "root"> = {},
): Promise<{ root: string; driver: FileDriver }> {
  const tmp = await makeTmpDir("bun-jobs-grouped");
  cleanups.push(tmp.cleanup);
  const driver = new FileDriver({ ...options, root: tmp.path });
  await driver.connect();
  cleanups.push(async () => await driver.close());
  return { root: tmp.path, driver };
}

/** The start of the minute before last. */
function twoMinutesAgo(): number {
  return bucketStart(Date.now() - 2 * MINUTE_BUCKET_MS, MINUTE_BUCKET_MS);
}

describe("file driver: grouped analytics reads", () => {
  it("answers nothing at a width it does not keep, and the minute at once", async () => {
    // Seconds asked for, and still refused: minutes are this backend's answer.
    const { driver } = await freshDriver({ metrics: { resolution: "second" } });
    const ns = testNamespace("gr-width");
    const q = { ns, queue: "orders" };
    const first = twoMinutesAgo();
    const runner = runnerKey("a");

    await driver.countRunnerRun(ns, runner, first + 1_000, {
      succeeded: 1,
      durationMs: 12,
    });
    await driver.countWorkerJobs(q, "w-1", first + 1_000, { completed: 1 });
    await driver.sampleWorkerBusyness(q, "w-1", first + 1_000, {
      active: 1,
      concurrency: 2,
    });
    await driver.flushMetrics();

    // The backend says so, and a second-wide read agrees with it.
    expect(driver.getMetricsSupport().resolutions).toEqual([60]);

    const seconds: MetricsQuery = {
      from: first,
      to: first + MINUTE_BUCKET_MS - 1_000,
      interval: 1_000,
    };
    expect(
      await driver.getRunnerMetricsTotals(ns, { ...seconds, durations: true }),
    ).toEqual([]);
    expect(
      await driver.getRunnerMetricsMany(ns, [runner], {
        ...seconds,
        durations: true,
      }),
    ).toEqual([]);
    expect(
      await driver.getWorkerMetricsTotals(ns, { ...seconds, busyness: true }),
    ).toEqual([]);
    expect(
      await driver.getWorkerMetricsMany(ns, [{ queue: "orders", key: "w-1" }], {
        ...seconds,
        busyness: true,
      }),
    ).toEqual([]);

    // The same data at a minute: the control that makes the four above mean
    // "not kept" rather than "nothing there".
    const minute: MetricsQuery = {
      from: first,
      to: first,
      interval: MINUTE_BUCKET_MS,
    };
    expect(
      (await driver.getRunnerMetricsTotals(ns, minute)).map((row) => [
        row.runner,
        row.runs.succeeded,
      ]),
    ).toEqual([[runner, 1]]);
    expect(
      await driver.getRunnerMetricsMany(ns, [runner], minute),
    ).toHaveLength(1);
    expect(
      (await driver.getWorkerMetricsTotals(ns, minute)).map((row) => [
        row.queue,
        row.key,
        row.jobs.completed,
      ]),
    ).toEqual([["orders", "w-1", 1]]);
    expect(
      await driver.getWorkerMetricsMany(
        ns,
        [{ queue: "orders", key: "w-1" }],
        minute,
      ),
    ).toHaveLength(1);
  });

  it("sees what this instance counted and has not flushed yet", async () => {
    const { driver } = await freshDriver();
    const ns = testNamespace("gr-pending");
    const first = twoMinutesAgo();

    // No flush: the grouped read writes the batch before it lists.
    await driver.countRunnerRun(ns, runnerKey("a"), first, { started: 2 });
    await driver.countWorkerJobs({ ns, queue: "orders" }, "w-1", first, {
      failed: 1,
    });

    const minute: MetricsQuery = {
      from: first,
      to: first,
      interval: MINUTE_BUCKET_MS,
    };
    expect(
      (await driver.getRunnerMetricsTotals(ns, minute)).map(
        (row) => row.runs.started,
      ),
    ).toEqual([2]);
    expect(
      (await driver.getWorkerMetricsTotals(ns, minute)).map(
        (row) => row.jobs.failed,
      ),
    ).toEqual([1]);
  });

  it("finds entities another process wrote, and ignores what it did not write", async () => {
    const { root, driver } = await freshDriver();
    const other = new FileDriver({ root });
    cleanups.push(async () => await other.close());
    const ns = testNamespace("gr-shared");
    const first = twoMinutesAgo();
    const minute: MetricsQuery = {
      from: first,
      to: first,
      interval: MINUTE_BUCKET_MS,
    };

    await other.countRunnerRun(ns, runnerKey("theirs"), first, { failed: 1 });
    await other.countWorkerJobs({ ns, queue: "mail" }, "w-9", first, {
      completed: 3,
    });
    await other.flushMetrics();

    // Somebody else's files in the tree: a name `encodeName` could not have
    // written, at the runner level and at both worker levels.
    const metrics = join(root, encodeSegment(ns), "metrics");
    for (const dir of [
      join(metrics, "runs", "Not.Ours"),
      join(metrics, "workerJobs", "Not.Ours", "w"),
      join(metrics, "workerJobs", "mail", "Not.Ours"),
    ]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${first}.jsonl`), '{"failed":5}\n');
    }

    const runners = await driver.getRunnerMetricsTotals(ns, minute);
    expect(runners.map((row) => [row.runner, row.runs.failed])).toEqual([
      [runnerKey("theirs"), 1],
    ]);
    // The roll-up is written by the other instance too; it is still no row.
    expect(runners.some((row) => row.runner === NAMESPACE_ENTITY)).toBe(false);

    const workers = await driver.getWorkerMetricsTotals(ns, minute);
    expect(
      workers.map(({ queue, key, jobs }) => [queue, key, jobs.completed]),
    ).toEqual([["mail", "w-9", 3]]);
  });

  it("names no entity in an empty namespace, and one never written to", async () => {
    const { driver } = await freshDriver();
    const minute: MetricsQuery = {
      from: twoMinutesAgo(),
      to: twoMinutesAgo(),
      interval: MINUTE_BUCKET_MS,
    };
    const ns = testNamespace("gr-empty");

    expect(await driver.getRunnerMetricsTotals(ns, minute)).toEqual([]);
    expect(
      await driver.getWorkerMetricsTotals(ns, { ...minute, busyness: true }),
    ).toEqual([]);
    expect(
      await driver.getRunnerMetricsMany(ns, [runnerKey("x")], minute),
    ).toEqual([]);
    expect(
      await driver.getWorkerMetricsMany(ns, [{ queue: "q", key: "k" }], minute),
    ).toEqual([]);
  });
});
