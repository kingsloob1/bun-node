import type { JobCounters, PendingMetric } from "../lib/drivers/metrics";
import { describe, expect, it } from "bun:test";
import {
  MINUTE_BUCKET_MS,
  SECOND_BUCKET_MS,
} from "../lib/api/contract/constants";
import {
  JOB_COUNTERS,
  MetricsBuffer,
  NAMESPACE_ENTITY,
  PendingBuffer,
} from "../lib/drivers/metrics";

/**
 * `MetricsBuffer.count` adds a count in the same second straight into the rows
 * it already holds, instead of building four keyed rows per job. The written
 * rows must be exactly what the slow path wrote; these pin the cases where
 * holding on to a row could go wrong — a flush or a `forget` taking it away
 * mid-second, a failed write putting it back, and a new second.
 */

/** A buffer whose writes are recorded, and fail while `failing` is set. */
function recorder() {
  const batches: PendingMetric<JobCounters>[][] = [];
  const state = { failing: false };
  const buffer = new MetricsBuffer<JobCounters>({
    keys: JOB_COUNTERS,
    flushMs: 3_600_000,
    write: async (batch) => {
      if (state.failing) {
        return { unwritten: batch, error: new Error("down") };
      }
      // A copy, so a later in-place add could not rewrite what was written.
      batches.push(batch.map((row) => ({ ...row, counts: { ...row.counts } })));
      return { unwritten: [] };
    },
  });
  return { buffer, batches, state };
}

/** Rows sorted to one comparable order. */
function sorted(rows: PendingMetric<JobCounters>[]) {
  return [...rows].sort(
    (a, b) =>
      a.ns.localeCompare(b.ns) ||
      a.entity.localeCompare(b.entity) ||
      a.interval - b.interval ||
      a.at - b.at,
  );
}

const T = 1_700_000_040_000; // a minute start
const minute = Math.floor(T / MINUTE_BUCKET_MS) * MINUTE_BUCKET_MS;

/** One row as the buffer writes it. */
function row(
  entity: string,
  interval: number,
  at: number,
  completed: number,
  failed: number,
): PendingMetric<JobCounters> {
  return { ns: "n", entity, at, interval, counts: { completed, failed } };
}

describe("MetricsBuffer.count fast path (memory unit)", () => {
  it("sums repeated counts in one second into the same four rows", async () => {
    const { buffer, batches } = recorder();

    buffer.count("n", "q", T + 1, { completed: 1 });
    buffer.count("n", "q", T + 500, { completed: 1 });
    buffer.count("n", "q", T + 999, { failed: 2 });
    buffer.count("n", "q", T + 999, { completed: 0 }); // counts nothing
    buffer.count("n", "other", T + 3, { completed: 1 }); // shares the roll-up
    expect(buffer.size).toBe(6);
    await buffer.flush();

    expect(batches).toHaveLength(1);
    expect(sorted(batches[0]!)).toEqual(
      sorted([
        row("q", SECOND_BUCKET_MS, T, 2, 2),
        row("q", MINUTE_BUCKET_MS, minute, 2, 2),
        row("other", SECOND_BUCKET_MS, T, 1, 0),
        row("other", MINUTE_BUCKET_MS, minute, 1, 0),
        row(NAMESPACE_ENTITY, SECOND_BUCKET_MS, T, 3, 2),
        row(NAMESPACE_ENTITY, MINUTE_BUCKET_MS, minute, 3, 2),
      ]),
    );
  });

  it("starts new rows after a flush takes the held ones mid-second", async () => {
    const { buffer, batches } = recorder();

    buffer.count("n", "q", T, { completed: 1 });
    await buffer.flush();
    buffer.count("n", "q", T + 10, { completed: 1 });
    expect(buffer.size).toBe(4);
    await buffer.flush();

    expect(batches).toHaveLength(2);
    for (const batch of batches) {
      expect(sorted(batch)).toEqual(
        sorted([
          row("q", SECOND_BUCKET_MS, T, 1, 0),
          row("q", MINUTE_BUCKET_MS, minute, 1, 0),
          row(NAMESPACE_ENTITY, SECOND_BUCKET_MS, T, 1, 0),
          row(NAMESPACE_ENTITY, MINUTE_BUCKET_MS, minute, 1, 0),
        ]),
      );
    }
  });

  it("does not revive rows a forget dropped", async () => {
    const { buffer, batches } = recorder();

    buffer.count("n", "q", T, { completed: 5 });
    buffer.forget("n");
    expect(buffer.size).toBe(0);
    buffer.count("n", "q", T + 1, { completed: 1 });
    await buffer.flush();

    expect(sorted(batches[0]!)).toEqual(
      sorted([
        row("q", SECOND_BUCKET_MS, T, 1, 0),
        row("q", MINUTE_BUCKET_MS, minute, 1, 0),
        row(NAMESPACE_ENTITY, SECOND_BUCKET_MS, T, 1, 0),
        row(NAMESPACE_ENTITY, MINUTE_BUCKET_MS, minute, 1, 0),
      ]),
    );
  });

  it("keeps a failed write's counts and adds the next ones to them", async () => {
    const { buffer, batches, state } = recorder();

    buffer.count("n", "q", T, { completed: 1 });
    state.failing = true;
    await expect(buffer.flush()).rejects.toThrow("down");
    state.failing = false;
    buffer.count("n", "q", T + 2, { completed: 1 });
    await buffer.flush();

    expect(batches).toHaveLength(1);
    expect(sorted(batches[0]!)).toEqual(
      sorted([
        row("q", SECOND_BUCKET_MS, T, 2, 0),
        row("q", MINUTE_BUCKET_MS, minute, 2, 0),
        row(NAMESPACE_ENTITY, SECOND_BUCKET_MS, T, 2, 0),
        row(NAMESPACE_ENTITY, MINUTE_BUCKET_MS, minute, 2, 0),
      ]),
    );
  });

  it("moves to the next second's rows, and back", async () => {
    const { buffer, batches } = recorder();

    buffer.count("n", NAMESPACE_ENTITY, T, { completed: 1 });
    buffer.count("n", NAMESPACE_ENTITY, T + SECOND_BUCKET_MS, { completed: 1 });
    buffer.count("n", NAMESPACE_ENTITY, T + 5, { failed: 1 });
    await buffer.flush();

    expect(sorted(batches[0]!)).toEqual(
      sorted([
        row(NAMESPACE_ENTITY, SECOND_BUCKET_MS, T, 1, 1),
        row(NAMESPACE_ENTITY, SECOND_BUCKET_MS, T + SECOND_BUCKET_MS, 1, 0),
        row(NAMESPACE_ENTITY, MINUTE_BUCKET_MS, minute, 2, 1),
      ]),
    );
  });

  it("PendingBuffer.add answers with the entry held for the key", () => {
    const pending = new PendingBuffer<{ ns: string; k: string; n: number }>({
      write: async () => ({ unwritten: [] }),
      key: (entry) => entry.k,
      merge: (into, from) => {
        into.n += from.n;
      },
      flushMs: 3_600_000,
    });

    const first = pending.add({ ns: "n", k: "a", n: 1 });
    const generation = pending.generation;
    expect(pending.add({ ns: "n", k: "a", n: 2 })).toBe(first);
    expect(first.n).toBe(3);
    expect(pending.generation).toBe(generation);
    pending.forget("x");
    expect(pending.generation).not.toBe(generation);
  });
});
