import type { JobWorkerRef, QueueRef } from "../lib/index";
import process from "node:process";
import { afterEach, describe, expect, it } from "bun:test";
import { packStamp, unpackStamp } from "../lib/drivers/redis/stamp";
import { RedisDriver } from "../lib/index";
import { makeJob, testNamespace } from "./helpers";

/**
 * A2 of the 2026-09-22 fix round: a claim no longer decodes the stamp it has
 * just written, and the stamp codec is memoised with an ASCII fast path. The
 * behaviour must be exactly what it was; these pin that.
 */

const URL = process.env.BUN_JOBS_TEST_REDIS_URL;

describe("redis stamp codec (A2)", () => {
  const refs: JobWorkerRef[] = [
    { id: "alpha-1" },
    { id: "alpha-1", key: "svc.emails", host: "host-a", pid: 101 },
    { id: "w", host: "h" },
    { id: "w", pid: 0 },
    { id: "日本", key: "k:1-2", host: "café", pid: 7 },
    { id: "", key: "" },
    { id: "0012", key: "-", host: "12:ab" },
  ];

  it("round-trips every shape, memoised or not", () => {
    for (let pass = 0; pass < 2; pass++) {
      for (const ref of refs) {
        const packed = packStamp(ref);
        // Twice in a row, so the second read is the memoised one.
        expect(unpackStamp(packed)).toStrictEqual(ref);
        expect(unpackStamp(packed)).toStrictEqual(ref);
      }
    }
  });

  it("hands out copies, so a caller's change never reaches the next read", () => {
    const packed = packStamp({ id: "a", key: "k" });
    const first = unpackStamp(packed)!;
    first.key = "changed";
    expect(unpackStamp(packed)).toStrictEqual({ id: "a", key: "k" });
  });

  it("packs by value, not by the last object seen", () => {
    const ref: JobWorkerRef = { id: "a", key: "k" };
    expect(packStamp(ref)).toBe("1:a1:k");
    ref.key = "kk";
    expect(packStamp(ref)).toBe("1:a2:kk");
  });

  it("reads and rejects exactly what it always did", () => {
    expect(unpackStamp("x")).toBeNull();
    expect(unpackStamp("3:ab")).toBeNull();
    expect(unpackStamp("1:a1:b1:c1:d1:e")).toBeNull();
    expect(unpackStamp("1:a---3:abc")).toBeNull();
    expect(unpackStamp("")).toBeNull();
    expect(unpackStamp(undefined)).toBeNull();
    expect(unpackStamp("1:a-")).toStrictEqual({ id: "a" });
    expect(unpackStamp("1:a-1:x")).toStrictEqual({ id: "a", host: "x" });
    expect(unpackStamp("01:a")).toStrictEqual({ id: "a" });
  });
});

describe.skipIf(!URL)(
  "redis claim reports processedBy without decoding (A2)",
  () => {
    const cleanups: (() => Promise<unknown>)[] = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup().catch(() => undefined);
      }
    });

    it("gives the claimed record the same processedBy a later read decodes", async () => {
      const driver = new RedisDriver({ url: URL });
      const ns = testNamespace("a2");
      cleanups.push(async () => {
        await driver.purge(ns);
        await driver.close();
      });
      const q: QueueRef = { ns, queue: "stamp" };
      const now = Date.now();
      await driver.addJobs(q, [
        makeJob({ id: "one", runAt: now }),
        makeJob({ id: "two", runAt: now }),
        makeJob({ id: "three", runAt: now }),
      ]);

      const cases = [
        { workerId: "bare" },
        { workerId: "full", worker: { key: "svc", host: "h1", pid: 42 } },
        {
          workerId: "other",
          worker: { key: "svc:2", host: "caf\u00E9", pid: 0 },
        },
      ] as const;

      const claimed = [
        await driver.claimJob(q, {
          ...cases[0],
          token: "t0",
          lockMs: 60_000,
          now,
        }),
        await driver.claimJob(q, {
          ...cases[1],
          token: "t1",
          lockMs: 60_000,
          now,
        }),
        ...(await driver.claimJobs(
          q,
          { ...cases[2], token: "t2", lockMs: 60_000, now },
          5,
        )),
      ];
      expect(claimed).toHaveLength(3);

      for (const job of claimed) {
        const read = await driver.getJob(q, job!.id);
        expect(job!.processedBy).toStrictEqual(read!.processedBy);
      }
      expect(claimed[1]!.processedBy).toStrictEqual({
        id: "full",
        key: "svc",
        host: "h1",
        pid: 42,
      });
      expect(claimed[2]!.processedBy).toStrictEqual({
        id: "other",
        key: "svc:2",
        host: "caf\u00E9",
        pid: 0,
      });
    });
  },
);
