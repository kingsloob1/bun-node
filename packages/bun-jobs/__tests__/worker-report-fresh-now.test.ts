import type { QueueRef, WorkerInfo } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { isWorkerStale } from "../lib/api/index";
import { BunQueueWorker, MemoryDriver } from "../lib/index";
import { SUMMON_CLAIM_PREFIX } from "../lib/summon/claim";
import { testNamespace, waitFor } from "./helpers";

/**
 * A worker's heartbeat record is stamped when it is written, not when the
 * report began: the reads a report makes first — the duplicate-id listing on
 * the first report, the claim-once read on every report of a summoned
 * worker — can take a while on a slow or loaded backend, and a record whose
 * `heartbeatAt`/`expiresAt` were taken before them lands already part
 * expired. Readers judge it by its `expiresAt` against their own clock (every
 * listing) and by its `heartbeatAt` (the API's `stale`), so such a record
 * reads as stale on arrival, and a summoned worker whose claim read is slow
 * drops out of every listing between its reports while it is alive.
 *
 * Real timers throughout: the delay is a real `Bun.sleep` in a driver
 * wrapper, so what a reader sees is what it would see over a slow backend.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** A record as it landed, and what a reader saw at that moment. */
interface Landing {
  /** The record as written. */
  record: WorkerInfo;
  /** When the write returned, epoch ms. */
  at: number;
  /** Whether a listing taken as the write returned had the worker in it. */
  listed: boolean;
}

/**
 * A memory driver whose reads ahead of a report's write are slowed by
 * `delayMs`: the summon claim entries (`claim`) or worker listings
 * (`listing`). Every landed record is kept with what a reader saw then; the
 * reader lists through the driver's own, undelayed, method.
 */
function slowDriver(
  /** Which reads to slow. */
  which: "claim" | "listing",
  /** How long each one waits, in ms; `0` slows nothing. */
  delayMs: number,
) {
  const driver = new MemoryDriver();
  const getQueueState = driver.getQueueState.bind(driver);
  const listWorkers = driver.listWorkers.bind(driver);
  const registerWorker = driver.registerWorker.bind(driver);
  const landings: Landing[] = [];
  let delayed = 0;
  const pause = async () => {
    if (delayMs > 0) {
      delayed++;
      await Bun.sleep(delayMs);
    }
  };
  driver.getQueueState = async (q, name) => {
    if (which === "claim" && name.startsWith(SUMMON_CLAIM_PREFIX)) {
      await pause();
    }
    return await getQueueState(q, name);
  };
  driver.listWorkers = async (q, now) => {
    if (which === "listing") {
      await pause();
    }
    return await listWorkers(q, now);
  };
  driver.registerWorker = async (q, worker) => {
    await registerWorker(q, worker);
    const at = Date.now();
    const live = await listWorkers(q, at);
    landings.push({
      record: worker,
      at,
      listed: live.some((one) => one.id === worker.id),
    });
  };
  return {
    driver,
    landings,
    /** Whether `id` is listed right now, by a reader with no delay. */
    listed: async (q: QueueRef, id: string) =>
      (await listWorkers(q, Date.now())).some((one) => one.id === id),
    /** How many reads were slowed. */
    delayed: () => delayed,
  };
}

/** A reporting worker on `driver`, summoned (by attempt `a1`) or not. */
function reporting(
  driver: MemoryDriver,
  /** The report interval, in ms. */
  reportInterval: number,
  /** Whether the worker carries summon provenance. */
  summoned: boolean,
) {
  const ref: QueueRef = { ns: testNamespace(), queue: "fresh-now" };
  const worker = new BunQueueWorker(ref.queue, async () => null, {
    namespace: ref.ns,
    driver,
    logger: noopLogger,
    reportInterval,
    pollInterval: 10,
    waitToExit: false,
    ...(summoned ? { summon: { id: "a1" } } : {}),
  });
  closers.push(async () => await worker.close({ force: true }));
  void worker.run();
  return { worker, ref };
}

describe("BunQueueWorker: a heartbeat record is stamped when it is written", () => {
  const interval = 100;
  /** Longer than a whole record lifetime (3 intervals). */
  const slow = 3 * interval + 100;

  for (const [label, which, summoned] of [
    ["a summoned worker's claim read", "claim", true],
    ["an ordinary worker's duplicate-id listing", "listing", false],
  ] as const) {
    it(`lands with its full lifetime after ${label} took longer than one`, async () => {
      const slowed = slowDriver(which, slow);
      reporting(slowed.driver, interval, summoned);

      await waitFor(() => slowed.landings.length > 0, {
        timeout: 10_000,
        message: "the worker never reported",
      });
      const [first] = slowed.landings;
      // The delay really ran ahead of this write.
      expect(slowed.delayed()).toBeGreaterThan(0);
      // Its own lifetime from the moment it landed, not what was left of it.
      expect(first!.record.expiresAt - first!.at).toBeGreaterThan(2 * interval);
      expect(first!.listed).toBe(true);
      expect(isWorkerStale(first!.record, first!.at)).toBe(false);
    }, 15_000);

    it(`negative control: with ${label} instant, the same checks pass`, async () => {
      const slowed = slowDriver(which, 0);
      reporting(slowed.driver, interval, summoned);

      await waitFor(() => slowed.landings.length > 0, {
        timeout: 10_000,
        message: "the worker never reported",
      });
      const [first] = slowed.landings;
      expect(slowed.delayed()).toBe(0);
      expect(first!.record.expiresAt - first!.at).toBeGreaterThan(2 * interval);
      expect(first!.listed).toBe(true);
      expect(isWorkerStale(first!.record, first!.at)).toBe(false);
    }, 15_000);
  }

  /**
   * Samples whether the worker is listed, every few ms for `forMs` after its
   * first record landed, and answers how many samples missed it.
   */
  async function absences(
    delayMs: number,
    reportInterval: number,
    forMs: number,
  ): Promise<{ samples: number; missed: number; delayed: number }> {
    const slowed = slowDriver("claim", delayMs);
    const { worker, ref } = reporting(slowed.driver, reportInterval, true);
    await waitFor(() => slowed.landings.length > 0, {
      timeout: 10_000,
      message: "the worker never reported",
    });
    let samples = 0;
    let missed = 0;
    const until = Date.now() + forMs;
    while (Date.now() < until) {
      samples++;
      if (!(await slowed.listed(ref, worker.id))) {
        missed++;
      }
      await Bun.sleep(5);
    }
    return { samples, missed, delayed: slowed.delayed() };
  }

  // Each report of a summoned worker reads its claim before it writes. With
  // that read at 2.25 intervals, a record stamped before it is gone for most
  // of each cycle; stamped after it, the next record lands 0.75 of an
  // interval before this one lapses.
  const steadyInterval = 300;

  it("keeps a live summoned worker listed between reports while every claim read is slow", async () => {
    const { samples, missed, delayed } = await absences(
      steadyInterval * 2.25,
      steadyInterval,
      2_500,
    );
    expect(delayed).toBeGreaterThan(2);
    expect(samples).toBeGreaterThan(50);
    // Both, so a failure says what share of the samples missed it.
    expect({ samples, missed }).toEqual({ samples, missed: 0 });
  }, 20_000);

  it("negative control: with the claim read instant, the sampler misses nothing either", async () => {
    const { samples, missed, delayed } = await absences(
      0,
      steadyInterval,
      2_500,
    );
    expect(delayed).toBe(0);
    expect(samples).toBeGreaterThan(50);
    expect(missed).toBe(0);
  }, 20_000);
});
