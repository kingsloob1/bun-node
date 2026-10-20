import type { QueueRef, WorkerInfo } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueueWorker, MemoryDriver } from "../lib/index";
import { SUMMON_CLAIM_PREFIX } from "../lib/summon/claim";
import { testNamespace, waitFor } from "./helpers";

/**
 * A worker's heartbeat reports never pile up behind a slow driver.
 *
 * Reports are chained so two writes never overlap, and the timer asks for one
 * every interval. When a report's driver work outlasts the interval — the
 * record write itself, or a summoned worker's claim read on every report —
 * one queued per tick made the chain grow without bound: the backlog drained
 * as a burst of redundant writes once the backend recovered, and a caller
 * awaiting a report (`stop()`, a control pass) waited for all of it. At most
 * one report runs and one waits; every report asked for meanwhile joins the
 * waiting one, which reads the worker's state when it starts.
 *
 * Real timers throughout: the delay is a real `Bun.sleep` in a driver
 * wrapper, so the timer really does tick while a write is in flight.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** The report interval, in ms. */
const interval = 50;
/** How long a slowed driver call takes: four intervals. */
const slowMs = 4 * interval;
/** How long the driver stays slow before a scenario measures, in ms. */
const slowFor = 1_200;

/**
 * A memory driver whose report work is slowed by `delayMs` (changeable while
 * it runs): the record write itself (`write`), or the summon claim read a
 * summoned worker makes ahead of every write (`claim`). Records when each
 * record write started and landed, and how many ever ran at once.
 */
function slowDriver(
  /** Which call to slow. */
  which: "write" | "claim",
  /** How long each one waits, in ms; `0` slows nothing. */
  delayMs: number,
) {
  const driver = new MemoryDriver();
  const getQueueState = driver.getQueueState.bind(driver);
  const registerWorker = driver.registerWorker.bind(driver);
  const state = {
    /** The current delay, in ms. */
    delayMs,
    /** When each record write started, `performance.now()`. */
    starts: [] as number[],
    /** Each record as it landed. */
    landed: [] as WorkerInfo[],
    /** Record writes running right now. */
    running: 0,
    /** The most record writes that ever ran at once. */
    overlap: 0,
    /** How many calls were slowed. */
    delayed: 0,
  };
  const pause = async () => {
    if (state.delayMs > 0) {
      state.delayed++;
      await Bun.sleep(state.delayMs);
    }
  };
  driver.getQueueState = async (q, name) => {
    if (which === "claim" && name.startsWith(SUMMON_CLAIM_PREFIX)) {
      await pause();
    }
    return await getQueueState(q, name);
  };
  driver.registerWorker = async (q, worker) => {
    state.starts.push(performance.now());
    state.running++;
    state.overlap = Math.max(state.overlap, state.running);
    try {
      if (which === "write") {
        await pause();
      }
      await registerWorker(q, worker);
      state.landed.push(worker);
    } finally {
      state.running--;
    }
  };
  return { driver, state };
}

/** A reporting worker on `driver`, summoned (by attempt `a1`) or not. */
function reporting(
  driver: MemoryDriver,
  /** Whether the worker carries summon provenance. */
  summoned: boolean,
) {
  const ref: QueueRef = { ns: testNamespace(), queue: "report-backlog" };
  const worker = new BunQueueWorker(ref.queue, async () => null, {
    namespace: ref.ns,
    driver,
    logger: noopLogger,
    reportInterval: interval,
    pollInterval: 10,
    waitToExit: false,
    ...(summoned ? { summon: { id: "a1" } } : {}),
  });
  closers.push(async () => await worker.close({ force: true }));
  void worker.run();
  return { worker, ref };
}

/** The most entries of `times` that fall in any window `width` ms wide. */
function densest(times: number[], width: number): number {
  let most = 0;
  for (let i = 0; i < times.length; i++) {
    let n = 0;
    for (let j = i; j < times.length && times[j] - times[i] < width; j++) {
      n++;
    }
    most = Math.max(most, n);
  }
  return most;
}

/** Resolves `promise`'s duration in ms, or `undefined` past `limitMs`. */
async function timed(
  promise: Promise<unknown>,
  /** How long to wait for it, in ms. */
  limitMs: number,
): Promise<number | undefined> {
  const started = performance.now();
  const outcome = await Promise.race([
    promise.then(() => "done" as const),
    Bun.sleep(limitMs).then(() => "late" as const),
  ]);
  return outcome === "done" ? performance.now() - started : undefined;
}

describe("BunQueueWorker: heartbeat reports never pile up behind a slow driver", () => {
  for (const [label, which, summoned] of [
    ["the record write", "write", false],
    ["a summoned worker's claim read", "claim", true],
  ] as const) {
    describe(`with ${label} slower than the interval`, () => {
      it("drains no backlog once the backend recovers", async () => {
        const { driver, state } = slowDriver(which, slowMs);
        reporting(driver, summoned);

        await Bun.sleep(slowFor);
        // The slowness really ran, across many ticks.
        expect(state.delayed).toBeGreaterThan(2);
        state.delayMs = 0;
        const recovered = performance.now();
        // The write in flight finishes within one delay; anything queued
        // behind it runs then, back to back.
        await Bun.sleep(slowMs + 6 * interval);

        const after = state.starts.filter((t) => t >= recovered);
        expect(after.length).toBeGreaterThan(2);
        // One queued report, then the timer's pace: a backlog of about
        // (slowFor / interval − slowFor / slowMs) ≈ 18 here drained as a
        // burst of that many writes within milliseconds.
        expect(densest(after, interval)).toBeLessThanOrEqual(3);
        // And the chain still never overlaps two writes.
        expect(state.overlap).toBe(1);
      }, 15_000);

      it("lets stop() wait only for the write in flight and its own", async () => {
        const { driver, state } = slowDriver(which, slowMs);
        const { worker } = reporting(driver, summoned);

        await Bun.sleep(slowFor);
        expect(state.delayed).toBeGreaterThan(2);
        // The write in flight, then stop's own: two delays, with room for a
        // loaded machine. Waiting for a backlog took about 18 delays (3.6 s).
        const took = await timed(worker.stop(), 6 * slowMs);
        expect(took).toBeDefined();
        // Stop's own report carried the stop.
        expect(state.landed.at(-1)?.state).toBe("stopped");
        expect(state.overlap).toBe(1);
      }, 15_000);

      it("loses no state change made while a report is in flight and one queued", async () => {
        const { driver, state } = slowDriver(which, slowMs);
        const { worker } = reporting(driver, summoned);

        await Bun.sleep(slowFor);
        // A tick has queued a report behind the one in flight by now; the
        // pause joins it, and it must still say so.
        const landedBefore = state.landed.length;
        void worker.pause();
        await waitFor(() => state.landed.length >= landedBefore + 2, {
          timeout: 10 * slowMs,
          message: "no report landed after the pause",
        });
        expect(state.landed.slice(landedBefore + 1)[0]?.paused).toBe(true);

        // A close after it writes nothing more and removes the record.
        const startsBefore = state.starts.length;
        await worker.close();
        expect(state.starts.length).toBe(startsBefore);
        expect(await driver.listWorkers(worker.ref, Date.now())).toEqual([]);
      }, 15_000);
    });
  }

  it("negative control: with the driver instant, the same checks pass", async () => {
    const { driver, state } = slowDriver("write", 0);
    const { worker } = reporting(driver, false);

    await Bun.sleep(slowFor);
    expect(state.delayed).toBe(0);
    expect(state.starts.length).toBeGreaterThan(5);
    expect(densest(state.starts, interval)).toBeLessThanOrEqual(3);
    expect(state.overlap).toBe(1);

    const took = await timed(worker.stop(), 6 * slowMs);
    expect(took).toBeDefined();
    expect(state.landed.at(-1)?.state).toBe("stopped");
  }, 15_000);
});
