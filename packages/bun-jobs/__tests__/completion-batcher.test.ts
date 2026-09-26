import type { QueueDriver } from "../lib/index";
import { describe, expect, it } from "bun:test";
import { CompletionBatcher } from "../lib/drivers/completeBatch";

/**
 * The completion batcher must never strand a completion.
 *
 * It starts a write only when none is in flight. That check used to read a
 * field cleared by a `.finally()` chained onto the drain loop, which runs a
 * microtask or two *after* the loop has already found nothing pending — and a
 * completion added in that gap saw a write "in flight", queued itself behind
 * it, and was never written. Its job stayed `active` under a live lock with no
 * event, and `close()` hung on it. On SQLite, whose writes answer almost at
 * once, `examples/bun-jobs/10-options/job-options.ts` hit it on roughly one
 * run in three.
 */

/** A driver with only the call the batcher makes, answering at once. */
function recordingDriver(): { driver: QueueDriver; written: string[] } {
  const written: string[] = [];
  const stub: Pick<QueueDriver, "completeJob"> = {
    completeJob: async (_q, id) => {
      written.push(id);
      return true;
    },
  };
  return { driver: stub as QueueDriver, written };
}

/** Resolves after `depth` chained microtasks. */
async function microtasks(depth: number): Promise<void> {
  for (let at = 0; at < depth; at++) {
    await Promise.resolve();
  }
}

describe("CompletionBatcher", () => {
  it("writes a completion added while the previous drain is winding down", async () => {
    // A stranded completion stays pending, so any later add would carry it
    // out with its own write. The one added in the gap therefore has to be the
    // last, as it was in the example: one batcher per microtask depth, each
    // with exactly one late completion.
    const stranded: number[] = [];

    for (let depth = 0; depth <= 20; depth++) {
      const { driver, written } = recordingDriver();
      const batcher = new CompletionBatcher(
        driver,
        { ns: "t", queue: "q" },
        "tok",
      );
      let late: Promise<void> | undefined;
      let lateSettled = false;

      batcher.add({
        id: "first",
        result: null,
        retention: false,
        settle: () => {
          late = microtasks(depth).then(() =>
            batcher.add({
              id: "late",
              result: null,
              retention: false,
              settle: () => {
                lateSettled = true;
              },
              fail: () => {
                lateSettled = true;
              },
            }),
          );
        },
        fail: () => undefined,
      });

      await batcher.idle();
      await late;
      await batcher.idle();
      // A macrotask too, so nothing is merely a microtask from landing.
      await Bun.sleep(1);

      if (!lateSettled || !written.includes("late")) {
        stranded.push(depth);
      }
    }

    expect(stranded).toEqual([]);
  });

  it("starts a fresh write for a completion added after it went idle", async () => {
    const { driver, written } = recordingDriver();
    const batcher = new CompletionBatcher(
      driver,
      { ns: "t", queue: "q" },
      "tok",
    );

    for (const id of ["a", "b"]) {
      await new Promise<void>((resolve) =>
        batcher.add({
          id,
          result: null,
          retention: false,
          settle: () => resolve(),
          fail: () => resolve(),
        }),
      );
      await batcher.idle();
    }

    expect(written).toEqual(["a", "b"]);
  });

  it("writes each completion under its own claim's token, batching only those that share one", async () => {
    // A worker draws a token per claim (#187), so completions gathered behind
    // one write can come from different claims. The plural write takes one
    // token, and a job written under another claim's token is refused — or,
    // were it a stale claim of the same job, wrongly accepted.
    const calls: { token: string; ids: string[] }[] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub: Pick<QueueDriver, "completeJob" | "completeJobs"> = {
      completeJob: async (_q, id, token) => {
        if (id === "lead") {
          await first;
        }
        calls.push({ token, ids: [id] });
        return true;
      },
      completeJobs: async (_q, token, completions) => {
        calls.push({ token, ids: completions.map((one) => one.id) });
        return completions.map((one) => one.id);
      },
    };
    const batcher = new CompletionBatcher(stub as QueueDriver, {
      ns: "t",
      queue: "q",
    });
    const settled: string[] = [];
    const add = (id: string, token?: string) =>
      batcher.add({
        id,
        ...(token ? { token } : {}),
        result: null,
        retention: false,
        settle: (kept) => {
          settled.push(`${id} ${kept}`);
        },
        fail: (error) => {
          settled.push(`${id} failed: ${String(error)}`);
        },
      });

    // `lead` holds the write open, so the rest gather into one batch.
    add("lead", "claim-0");
    add("a1", "claim-a");
    add("b1", "claim-b");
    add("a2", "claim-a");
    add("orphan");
    release();
    await batcher.idle();

    expect(calls).toEqual([
      { token: "claim-0", ids: ["lead"] },
      { token: "claim-a", ids: ["a1", "a2"] },
      { token: "claim-b", ids: ["b1"] },
    ]);
    // No token of its own and no default: failed, never written under
    // someone else's.
    expect(settled.sort()).toEqual([
      "a1 true",
      "a2 true",
      "b1 true",
      "lead true",
      "orphan failed: Error: No lock token for the completion of job orphan",
    ]);
  });
});
