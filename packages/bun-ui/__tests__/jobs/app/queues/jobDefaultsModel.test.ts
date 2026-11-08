import type { ApplyJobDefaultsResultDto } from "../../../app/api/types";
import { describe, expect, it } from "bun:test";
import { JOB_DEFAULT_KEYS } from "../../../app/api/contract";
import { runApplyLoop } from "../../../app/screens/queues/panels/jobDefaults/applyLoop";
import {
  canonical,
  KEY_KIND,
  parseBackoff,
  parseRetention,
} from "../../../app/screens/queues/panels/jobDefaults/draft";

/**
 * The job-defaults model without a DOM: the form's parsing and comparison,
 * and the apply walk's loop.
 */

/** One apply answer. */
function batch(
  overrides: Partial<ApplyJobDefaultsResultDto> = {},
): ApplyJobDefaultsResultDto {
  return {
    seq: 1,
    keys: ["attempts"],
    dryRun: false,
    examined: 10,
    rewritten: 6,
    unchanged: 1,
    skippedExplicit: 1,
    skippedUnmarked: 1,
    moved: 1,
    exhausted: 2,
    next: null,
    done: true,
    ...overrides,
  };
}

describe("the job-defaults form model", () => {
  it("has an editor for every contract key, and no other", () => {
    expect(Object.keys(KEY_KIND).sort()).toEqual([...JOB_DEFAULT_KEYS].sort());
  });

  it("compares a bare-number backoff or retention with its object spelling", () => {
    expect(canonical("backoff", 500)).toBe(
      canonical("backoff", { delay: 500, type: "fixed" }),
    );
    expect(canonical("removeOnFail", 20)).toBe(
      canonical("removeOnFail", { count: 20, ttl: undefined }),
    );
    expect(canonical("attempts", 3)).not.toBe(canonical("attempts", 4));
  });

  it("refuses a longest delay under the delay, and a jitter outside 0 … 1", () => {
    expect(
      parseBackoff({ type: "fixed", delay: 100, max: 50, jitter: undefined }),
    ).toEqual({ error: "The longest delay must be at least the delay." });
    expect(
      "error" in
        parseBackoff({
          type: "exponential",
          delay: 100,
          max: undefined,
          jitter: 2,
        }),
    ).toBe(true);
    expect(
      parseBackoff({
        type: "exponential",
        delay: 100,
        max: undefined,
        jitter: 0.5,
      }),
    ).toEqual({ value: { type: "exponential", delay: 100, jitter: 0.5 } });
  });

  it("needs a count or an age for a limited retention", () => {
    expect(
      "error" in
        parseRetention({ mode: "limit", count: undefined, ttl: undefined }),
    ).toBe(true);
    expect(
      parseRetention({ mode: "limit", count: undefined, ttl: 60_000 }),
    ).toEqual({ value: { ttl: 60_000 } });
    expect(
      parseRetention({ mode: "remove", count: 5, ttl: undefined }),
    ).toEqual({ value: true });
    expect(parseRetention({ mode: "keep", count: 5, ttl: undefined })).toEqual({
      value: false,
    });
  });
});

describe("the apply walk", () => {
  it("keeps the totals and the cursor to resume from when a batch fails", async () => {
    const failure = new Error("boom");
    const sent: (string | undefined)[] = [];
    const outcome = await runApplyLoop({
      request: async (cursor) => {
        sent.push(cursor);
        if (cursor === "c1") {
          throw failure;
        }
        return batch({ next: "c1", done: false });
      },
      shouldStop: () => false,
    });
    expect(sent).toEqual([undefined, "c1"]);
    expect(outcome).toEqual({
      status: "failed",
      cursor: "c1",
      error: failure,
      totals: {
        examined: 10,
        rewritten: 6,
        unchanged: 1,
        skippedExplicit: 1,
        skippedUnmarked: 1,
        moved: 1,
        exhausted: 2,
        batches: 1,
      },
    });
  });

  it("gives up on an answer repeating the cursor it was sent, rather than looping for ever", async () => {
    let calls = 0;
    const outcome = await runApplyLoop({
      request: async () => {
        calls += 1;
        return batch({ next: "same", done: false });
      },
      cursor: "same",
      shouldStop: () => false,
    });
    expect(calls).toBe(1);
    expect(outcome.status).toBe("failed");
  });

  it("stops when a batch answers done, even with a stop asked for meanwhile", async () => {
    const outcome = await runApplyLoop({
      request: async () => batch(),
      shouldStop: () => true,
    });
    expect(outcome.status).toBe("done");
    expect(outcome.totals.batches).toBe(1);
  });
});
