import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueueWorker, MemoryDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * A worker's timed passes never overlap themselves.
 *
 * The promotion sweep runs at the poll interval, which can be a few
 * milliseconds, and on Postgres its statement waits on the row locks of the
 * very jobs it promotes. Each tick used to start a pass whether or not the
 * last had finished, so once one waited the ticks kept adding more: under
 * load every connection in the driver's pool held a promotion waiting on
 * another, and the worker's claims, completions and lock renewals queued
 * behind them. Measured in `sql-servers.test.ts`' contending-workers case at a
 * load of 30-47 on 16 cores: two runs in 40 settled 9 and 13 of 120 jobs in
 * ten seconds and then nothing for 48-75 seconds, with all four workers'
 * drivers unable to answer a read.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.map(async (close) => await close()));
  closers.length = 0;
});

describe("BunQueueWorker: timed passes", () => {
  it("starts no promotion while the last one is still running", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("overlap");

    /** Promotions started and not yet answered, and the most at once. */
    const promotions = { started: 0, inFlight: 0, most: 0 };
    /** Holds every promotion until opened. */
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const promote = driver.promoteDelayed.bind(driver);
    driver.promoteDelayed = async (q, now, limit) => {
      promotions.started++;
      promotions.inFlight++;
      promotions.most = Math.max(promotions.most, promotions.inFlight);
      try {
        await gate;
        return await promote(q, now, limit);
      } finally {
        promotions.inFlight--;
      }
    };

    const worker = new BunQueueWorker("overlap", async () => {}, {
      namespace,
      driver,
      logger: noopLogger,
      // The promotion sweep's cadence is the poll interval, up to a second.
      pollInterval: 5,
      metrics: { workers: false },
      waitToExit: false,
      autorun: true,
    });
    closers.push(async () => await worker.close({ force: true }));

    // Forty ticks of the sweep while every promotion hangs. The claim loop
    // waits on its own (one), and the sweep may have one out (two); before,
    // each tick added another.
    await Bun.sleep(200);
    expect(promotions.most).toBeGreaterThanOrEqual(1);
    expect(promotions.most).toBeLessThanOrEqual(2);

    // Skipped, not stopped: once the slow pass answers, the sweep runs again.
    open();
    const answered = promotions.started;
    await waitFor(() => promotions.started >= answered + 3, {
      timeout: 5_000,
      message: "the sweep did not resume after a slow pass",
    });
    expect(promotions.most).toBeLessThanOrEqual(2);
  });
});
