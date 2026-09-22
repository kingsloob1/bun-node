import type { QueueRef, RepeatRecord } from "../lib/drivers/driver";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  FileDriver,
  MemoryDriver,
} from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * A series' first occurrence claimed before its definition was written.
 *
 * `add()` with `repeat` stored the first occurrence and only then the series'
 * definition. A worker schedules the next occurrence the moment it claims one,
 * from the definition it reads then, and reads a missing definition as a
 * series removed while its occurrence was queued. So an `immediately()`
 * occurrence claimed in that gap ran once and the series stopped for good.
 *
 * It surfaced on the file driver after its batch claim (fix round C3) made the
 * claim fast enough to win the race most of the time: the job-registry example
 * saw one heartbeat of three in 7 runs of 10. The definition is now written
 * first. Left to timing the race is not reproducible in a test, so these
 * widen the gap on purpose — every definition write lands 150ms late — which
 * fails without the fix on every run, on either driver.
 */

const closers: (() => Promise<unknown>)[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.map((close) => close()));
  closers.length = 0;
});

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** How long the slow drivers below hold every write of a definition back. */
const DEFINITION_DELAY_MS = 150;

/** A memory driver whose definition writes land late. */
class SlowDefinitionMemoryDriver extends MemoryDriver {
  override async upsertRepeat(q: QueueRef, def: RepeatRecord): Promise<void> {
    await Bun.sleep(DEFINITION_DELAY_MS);
    await super.upsertRepeat(q, def);
  }
}

/** A file driver whose definition writes land late. */
class SlowDefinitionFileDriver extends FileDriver {
  override async upsertRepeat(q: QueueRef, def: RepeatRecord): Promise<void> {
    await Bun.sleep(DEFINITION_DELAY_MS);
    await super.upsertRepeat(q, def);
  }
}

/** A connected file driver on a fresh directory, removed after the file. */
async function fileDriver(slow: boolean): Promise<FileDriver> {
  const tmp = await makeTmpDir("bun-jobs-repeat-first-claim");
  cleanups.push(tmp.cleanup);
  const driver = slow
    ? new SlowDefinitionFileDriver({ root: tmp.path })
    : new FileDriver({ root: tmp.path });
  await driver.connect();
  closers.push(() => driver.close());
  return driver;
}

/**
 * Starts a worker, then adds a series every `every` ms, first occurrence now,
 * `limit` in all, and resolves how many occurrences ran within `timeout`.
 */
async function runSeries(
  driver: MemoryDriver | FileDriver,
  options: {
    /** The series' interval, in ms. */
    every: number;
    /** Occurrences in all. */
    limit: number;
    /** How long to wait for all of them. */
    timeout: number;
  },
): Promise<number> {
  const namespace = testNamespace("repeat-first");
  const queue = new BunQueue("beats", {
    namespace,
    driver,
    logger: noopLogger,
  });
  closers.push(() => queue.close());

  let ran = 0;
  let ready = false;
  const worker = new BunQueueWorker(
    "beats",
    () => {
      ran++;
    },
    {
      namespace,
      driver,
      logger: noopLogger,
      concurrency: 4,
      pollInterval: 20,
      maxBlock: 20,
    },
  );
  // Closed before the queue and the driver, which were pushed first.
  closers.unshift(() => worker.close({ force: true }));
  worker.once("ready", () => {
    ready = true;
  });
  void worker.run();
  // Claiming before the add, as the example's worker is.
  await waitFor(() => ready);

  await queue.add("beat", null, {
    repeat: { every: options.every, immediately: true, limit: options.limit },
  });

  await waitFor(() => ran >= options.limit, {
    timeout: options.timeout,
  }).catch(() => {});

  return ran;
}

describe("a repeat series whose first occurrence is claimed at once", () => {
  it("keeps going on the memory driver when the definition write is slow", async () => {
    const driver = new SlowDefinitionMemoryDriver();
    closers.push(() => driver.close());

    const ran = await runSeries(driver, {
      every: 100,
      limit: 3,
      timeout: 3_000,
    });

    expect(ran).toBe(3);
  });

  it("keeps going on the file driver when the definition write is slow", async () => {
    const ran = await runSeries(await fileDriver(true), {
      every: 100,
      limit: 3,
      timeout: 3_000,
    });

    expect(ran).toBe(3);
  });
});
