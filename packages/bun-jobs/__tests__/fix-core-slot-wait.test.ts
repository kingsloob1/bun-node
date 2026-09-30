import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "bun:test";
import { Pulse, waitForAny } from "../lib/shared/wait";

/**
 * B1: a full worker waits for a slot on one pulse, not on every running
 * job's promise. The old wait left a reaction on each still-running job per
 * pass, so a long job beside a stream of short ones collected one per
 * completion for as long as it ran.
 */

/** Measures B1's retention in a fresh process; prints `{ before, after, active }`. */
const RETENTION_FIXTURE = join(
  import.meta.dir,
  "fixtures/processes/slot-wait-retention.ts",
);

describe("Pulse", () => {
  it("ends every subscribed wait on notify, and a timed-out wait unsubscribes", async () => {
    const pulse = new Pulse();

    const timedOut = waitForAny(5, { pulse });
    expect(pulse.size).toBe(1);
    await timedOut;
    expect(pulse.size).toBe(0);

    let ended = 0;
    const waits = [1, 2, 3].map(async () => {
      await waitForAny(60_000, { pulse });
      ended += 1;
    });
    expect(pulse.size).toBe(3);
    pulse.notify();
    await Promise.all(waits);
    expect(ended).toBe(3);
    expect(pulse.size).toBe(0);
  });

  it("leaves nothing behind across many waits that time out", async () => {
    const pulse = new Pulse();
    for (let index = 0; index < 200; index++) {
      await waitForAny(0, { pulse });
    }

    expect(pulse.size).toBe(0);
  });
});

describe("BunQueueWorker: full-slot wait (B1)", () => {
  // In a process of its own: a live-Promise count is process-wide, and in the
  // suite it also counted what earlier files left running (see the fixture).
  it("keeps no per-completion reaction on a long job still running", async () => {
    const proc = Bun.spawn([process.execPath, RETENTION_FIXTURE], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const { before, after, active } = JSON.parse(
      stdout.trim().split("\n").at(-1)!,
    ) as {
      before: number;
      after: number;
      active: number;
    };

    // The old wait (every running job's promise raced on each pass) retained
    // four promises per completion here: measured 40,001 over this burst.
    expect(after - before).toBeLessThan(2_000);
    expect(active).toBe(1);
  }, 60_000);
});
