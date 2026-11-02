/**
 * The backoff vector shared with bun-common (plan §6.1): the client's
 * `backoffDelay` is a copy of bun-common's `computeBackoff` (exponential,
 * factor 2, capped, jittered), kept a copy so bun-common never reaches a
 * frontend (D17). Both run over `fixtures/backoff-vector.json` with the same
 * random draw, and must reproduce every expected value, so neither can change
 * without this failing.
 *
 * Also `Retry-After`'s two forms.
 */
import { computeBackoff } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { backoffDelay, retryAfterMs } from "../lib/retry";
import vector from "./fixtures/backoff-vector.json";

interface VectorCase {
  attempt: number;
  baseMs: number;
  maxMs: number;
  jitter: number;
  random: number;
  expected: number;
}

const cases = vector.cases as VectorCase[];

afterEach(() => {
  // Each bun-common run below stubs Math.random; restore it.
  (Math.random as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("the shared backoff vector", () => {
  it("has cases for every jitter, the cap, attempt 0 and a fractional attempt", () => {
    expect(cases.length).toBeGreaterThan(50);
    expect(new Set(cases.map((each) => each.jitter))).toEqual(
      new Set([0, 0.25, 0.5, 1]),
    );
    expect(cases.some((each) => each.expected >= each.maxMs)).toBe(true);
    expect(cases.some((each) => each.attempt === 0)).toBe(true);
    expect(cases.some((each) => !Number.isInteger(each.attempt))).toBe(true);
  });

  it("bun-client's backoffDelay reproduces every case", () => {
    for (const each of cases) {
      const delay = backoffDelay(each.attempt, each, () => each.random);
      expect({ ...each, delay }).toEqual({ ...each, delay: each.expected });
    }
  });

  it("bun-common's computeBackoff reproduces every case", () => {
    for (const each of cases) {
      spyOn(Math, "random").mockReturnValue(each.random);
      const delay = computeBackoff(each.attempt, {
        type: "exponential",
        delay: each.baseMs,
        factor: 2,
        max: each.maxMs,
        jitter: each.jitter,
      });
      (Math.random as unknown as { mockRestore: () => void }).mockRestore();
      expect({ ...each, delay }).toEqual({ ...each, delay: each.expected });
    }
  });

  it("uses Math.random when no draw is given, within ± jitter", () => {
    for (let index = 0; index < 50; index++) {
      const delay = backoffDelay(2, { baseMs: 100, maxMs: 1_000, jitter: 0.5 });
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(300);
    }
  });
});

describe("Retry-After", () => {
  const now = Date.UTC(2026, 10, 2, 12, 0, 0);

  it("reads delay-seconds", () => {
    expect(retryAfterMs("0", now)).toBe(0);
    expect(retryAfterMs("120", now)).toBe(120_000);
    expect(retryAfterMs(" 3 ", now)).toBe(3_000);
  });

  it("reads an HTTP date, a past one as 0", () => {
    expect(retryAfterMs("Mon, 02 Nov 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(retryAfterMs("Mon, 02 Nov 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("is undefined when absent or unreadable", () => {
    expect(retryAfterMs(null, now)).toBeUndefined();
    expect(retryAfterMs("soon", now)).toBeUndefined();
    expect(retryAfterMs("-5", now)).toBeUndefined();
    expect(retryAfterMs("1.5", now)).toBeUndefined();
  });
});
