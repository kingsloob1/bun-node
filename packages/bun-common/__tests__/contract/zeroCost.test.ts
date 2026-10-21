import { fullGC, heapStats } from "bun:jsc";
/**
 * Rule 2 of plan §4.1.6: no schema costs nothing (C13–C15). A side or key
 * with no schema answers synchronously with the very message it was given and
 * allocates nothing, so 100,000 retained results add no live objects; with
 * one schema they add a parsed copy each, which is the control that the
 * count can see an allocation at all.
 */
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { createReceiver, createSender } from "../../lib/contract/guard";
import { documented } from "../../lib/contract/schemas";
import { broker, http, jobs } from "./fixtures";

/** Live `Object`s added by retaining `n` results of `fn`. */
function retained(fn: () => unknown, n = 100_000): number {
  const keep: unknown[] = Array.from({ length: n });
  fullGC();
  const before = heapStats().objectTypeCounts.Object ?? 0;
  for (let i = 0; i < n; i++) keep[i] = fn();
  fullGC();
  const delta = (heapStats().objectTypeCounts.Object ?? 0) - before;
  expect(keep.length).toBe(n);
  return delta;
}

describe("no schema costs nothing", () => {
  const c = broker.contract({
    inbound: { bare: {}, typed: { payload: z.object({ n: z.number() }) } },
  });
  const keyed = createReceiver(c, "inbound");
  const none = createReceiver(jobs.contract({}), "inbound");
  const bare = { topic: "bare", payload: { n: 1 } };
  const typed = { topic: "typed", payload: { n: 1 } };
  const job = { data: { n: 1 } };

  it("C13: answers synchronously with the same object; a schema gives a parsed copy", () => {
    expect<unknown>(keyed(bare)).toBe(bare);
    expect(none(job)).toBe(job);
    expect(none.checks).toBe(false);
    expect(keyed.checks).toBe(true);
    expect<unknown>(keyed(typed)).not.toBe(typed);
  });

  it("C13: every guard with nothing to check is one shared identity function", () => {
    expect<unknown>(createReceiver(jobs.contract({}), "inbound")).toBe(none);
    expect<unknown>(
      createSender(http.contract({ inbound: {} }), "inbound"),
    ).toBe(none);
    expect<unknown>(createSender(c, "inbound", { policy: "off" })).toBe(none);
    expect<unknown>(
      createReceiver(http.contract({ outbound: { 204: {} } }), "outbound", {
        undeclaredKey: "allow",
      }),
    ).toBe(none);
    // documented() never checks, so a side holding only that is free too.
    expect<unknown>(
      createReceiver(
        jobs.contract({ inbound: { data: documented({ type: "string" }) } }),
        "inbound",
      ),
    ).toBe(none);
  });

  it("C15: 100,000 retained results add no live objects without a schema, one each with", () => {
    const withSchema = retained(() => keyed(typed));
    expect(withSchema).toBeGreaterThanOrEqual(100_000);
    expect(retained(() => keyed(bare))).toBeLessThan(100);
    expect(retained(() => none(job))).toBeLessThan(100);
    // A keyed HTTP status with no schema, looked up by its number.
    const send = createSender(
      http.contract({ outbound: { 204: {} } }),
      "outbound",
    );
    const noContent = { status: 204 as const };
    expect(retained(() => send(noContent))).toBeLessThan(100);
  });
});
