import process from "node:process";
import { describe, expect, it } from "bun:test";
import {
  EVENT_HOLE_LIMIT,
  EVENT_HOLE_TTL_MS,
  EventGaps,
} from "../lib/drivers/eventGaps";

/**
 * `EventGaps`, the cursor the SQL and MongoDB event feeds follow their log
 * with, on its own.
 */
describe("EventGaps", () => {
  it("delivers each number once, and a passed-over one when it lands late", () => {
    const gaps = new EventGaps(10);

    expect(gaps.accept(10, 0)).toBe(false); // history
    expect(gaps.accept(13, 0)).toBe(true);
    expect(gaps.cursor).toBe(13);
    expect(gaps.retry(0)).toEqual([11, 12]);

    expect(gaps.accept(13, 0)).toBe(false); // already delivered
    expect(gaps.accept(12, 1)).toBe(true); // the late commit
    expect(gaps.accept(12, 1)).toBe(false);
    expect(gaps.retry(1)).toEqual([11]);
  });

  it("stops asking for a number once it is too old to arrive", () => {
    const gaps = new EventGaps(0);
    gaps.accept(2, 0);

    expect(gaps.retry(EVENT_HOLE_TTL_MS)).toEqual([1]);
    expect(gaps.retry(EVENT_HOLE_TTL_MS + 1)).toEqual([]);
  });

  it("keeps the newest numbers passed over, up to the limit", () => {
    const gaps = new EventGaps(0);
    gaps.accept(100, 0);
    gaps.accept(EVENT_HOLE_LIMIT + 300, 0);

    const holes = gaps.retry(0);
    expect(holes.length).toBe(EVENT_HOLE_LIMIT);
    // Oldest first out: what is left is the run just below the cursor.
    expect(holes[0]).toBe(300);
    expect(holes.at(-1)).toBe(EVENT_HOLE_LIMIT + 299);
    expect(holes).not.toContain(99);
  });

  it("jumps a cursor across a whole log without walking it", () => {
    // A feed following a channel nothing has written to starts after 0, and
    // the log's numbers are shared by every namespace and channel in the
    // table, so its first event can be millions of numbers ahead. Every one
    // used to be recorded and then trimmed one `keys().next()` at a time,
    // which is quadratic: ~3 s of a stopped event loop at 84,000, ~6 s at
    // this jump, and 50,000,000 never finished. The bound is a hang guard; the
    // work is a few hundred map writes.
    const gaps = new EventGaps(0);
    const begun = process.threadCpuUsage();

    expect(gaps.accept(120_000, 0)).toBe(true);

    const { user, system } = process.threadCpuUsage(begun);
    expect((user + system) / 1_000).toBeLessThan(1_000);
    expect(gaps.cursor).toBe(120_000);

    const holes = gaps.retry(0);
    expect(holes.length).toBe(EVENT_HOLE_LIMIT);
    expect(holes[0]).toBe(120_000 - EVENT_HOLE_LIMIT);
    expect(holes.at(-1)).toBe(119_999);
  });
});
