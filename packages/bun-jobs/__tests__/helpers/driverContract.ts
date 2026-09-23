import type {
  AddedRange,
  MetricsQuery,
  NamespaceMetricsQuery,
  PendingOptionsRewrite,
  PendingOptionsRewriteResult,
  PromoteDelayedResult,
  RunnerMetricsQuery,
  StoredJobOptions,
} from "../../lib/drivers/driver";
import type {
  CounterBucket,
  MetricsSupport,
  RunnerRunCounters,
  WorkerMetricsRef,
} from "../../lib/drivers/metrics";
import type {
  ChildOutcome,
  JobFlow,
  JobPage,
  JobQuery,
  JobRecord,
  JobRef,
  JobsDriver,
  JobState,
  QueueRef,
  RunLogCaps,
  RunLogInput,
  RunLogQuery,
  RunRecord,
  WorkerInfo,
} from "../../lib/index";
import { serializeError } from "@kingsleyweb/bun-common";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  JOB_DEFAULTS_APPLY_STATES,
  MINUTE_BUCKET_MS,
  SECOND_BUCKET_MS,
} from "../../lib/api/contract/constants";
import {
  countAdded,
  countAddedByScan,
  emptyAddedCounts,
  JOB_STATES,
  supportsCreatedSort,
} from "../../lib/drivers/index";
import {
  bucketStart,
  durationBin,
  emptyBusynessStats,
  emptyDurationStats,
  emptyHistogram,
  histogramQuantile,
  NAMESPACE_ENTITY,
  readBusyness,
  readDurations,
  resolveAnalyticsRange,
  RUNNER_RUN_COUNTERS,
  runnerTotalsOf,
  totalDurationStats,
  workerTotalsOf,
  zeroCounters,
} from "../../lib/drivers/metrics";
import {
  ConfigError,
  countQueues,
  emptyCounts,
  findJobPage,
  findJobsByScan,
  getJobsByIds,
  getJobsByLoop,
  jobFilter,
  listWorkerConfigs,
  listWorkerRecords,
  matchesFilter,
  newToken,
  readWorkerConfig,
  readWorkerControl,
  registerWorkerRecord,
  removeWorkerRecord,
  runnerKey,
  supportsWorkerControl,
  sweepWorkerControls,
  THROUGHPUT_BUCKET_MS,
  THROUGHPUT_RETENTION_MS,
  throughputBucket,
  writeWorkerConfig,
  writeWorkerControl,
} from "../../lib/index";
import { JOB_OPTION_BITS } from "../../lib/queue/jobDefaults";
import { queueEvent, workerEvent } from "../../lib/shared/events";
import { compareCodePoints } from "../../lib/shared/strings";
import { jobOptions, makeJob, testNamespace, waitFor } from "../helpers";

/**
 * A `promoteDelayed` answer as the pair: every driver in this package reports
 * `nextDueAt`, and a bare count (the older contract, still accepted from
 * third-party drivers) would fail the case that asked.
 */
async function promotion(
  pending: Promise<number | PromoteDelayedResult>,
): Promise<PromoteDelayedResult> {
  const result = await pending;
  if (typeof result === "number") {
    throw new TypeError(
      "promoteDelayed answered a bare count; this package's drivers report { promoted, nextDueAt }",
    );
  }
  return result;
}

/**
 * The contract every driver must satisfy, as an executable specification.
 *
 * Each backend implements the same rules with entirely different machinery —
 * a `Map`, `rename`, `SKIP LOCKED`, a Lua script — so the guarantees are
 * asserted once here and every driver runs them. A new driver is "done" when
 * this suite passes against it.
 *
 * Nothing here reads a clock the driver could disagree with: times are passed
 * in, exactly as the contract requires.
 */
export function driverContract(
  name: string,
  factory: () => Promise<{ driver: JobsDriver; cleanup?: () => Promise<void> }>,
): void {
  describe(`driver contract: ${name}`, () => {
    let driver: JobsDriver;
    let cleanup: (() => Promise<void>) | undefined;
    const ns = testNamespace("contract");
    const other = testNamespace("contract-other");

    beforeAll(async () => {
      const created = await factory();
      driver = created.driver;
      cleanup = created.cleanup;
      await driver.connect();
    });

    afterAll(async () => {
      await driver.purge(ns);
      await driver.purge(other);
      await driver.close();
      await cleanup?.();
    });

    /* --- lifecycle -------------------------------------------------- */

    it("connects idempotently and reports reachability", async () => {
      await driver.connect();
      expect(await driver.ping()).toBe(true);
      expect(typeof driver.name).toBe("string");
      expect(typeof driver.capabilities.multiProcess).toBe("boolean");
    });

    /* --- locks ------------------------------------------------------ */

    describe("locks", () => {
      it("grants the lock to exactly one holder", async () => {
        const key = runnerKey("lock-one");
        const now = Date.now();
        const mine = newToken();
        const theirs = newToken();

        expect(await driver.acquireLock(ns, key, mine, 5000, now)).toBe(true);
        expect(await driver.acquireLock(ns, key, theirs, 5000, now)).toBe(
          false,
        );

        const info = await driver.getLock(ns, key, now);
        expect(info?.token).toBe(mine);
        expect(info?.expiresAt).toBeGreaterThan(now);
      });

      it("lets the holder renew and refuses everyone else", async () => {
        const key = runnerKey("lock-renew");
        const now = Date.now();
        const mine = newToken();

        await driver.acquireLock(ns, key, mine, 1000, now);

        expect(await driver.renewLock(ns, key, mine, 5000, now)).toBe(true);
        expect(await driver.renewLock(ns, key, newToken(), 5000, now)).toBe(
          false,
        );

        const info = await driver.getLock(ns, key, now);
        expect(info?.expiresAt).toBe(now + 5000);
      });

      // A write that leaves the row exactly as it was still lands. MySQL and
      // MariaDB count rows *changed*, not matched, so a renewal repeated within
      // the same millisecond used to report a lock its holder still had as lost.
      it("answers true for a holder re-acquiring or renewing to the same expiry", async () => {
        const key = runnerKey("lock-same-expiry");
        const now = Date.now();
        const mine = newToken();

        expect(await driver.acquireLock(ns, key, mine, 5000, now)).toBe(true);
        expect(await driver.acquireLock(ns, key, mine, 5000, now)).toBe(true);
        expect(await driver.renewLock(ns, key, mine, 5000, now)).toBe(true);
        expect(await driver.renewLock(ns, key, mine, 5000, now)).toBe(true);
        // …and still refuses everyone else, the same expiry or not.
        expect(await driver.acquireLock(ns, key, newToken(), 5000, now)).toBe(
          false,
        );
        expect(await driver.renewLock(ns, key, newToken(), 5000, now)).toBe(
          false,
        );
        expect((await driver.getLock(ns, key, now))?.token).toBe(mine);

        await driver.releaseLock(ns, key, mine);
        expect(await driver.renewLock(ns, key, mine, 5000, now)).toBe(false);
      });

      it("treats an expired lock as free", async () => {
        const key = runnerKey("lock-expiry");
        const now = Date.now();
        const stale = newToken();

        await driver.acquireLock(ns, key, stale, 100, now);
        const later = now + 1000;

        expect(await driver.getLock(ns, key, later)).toBeNull();
        expect(await driver.acquireLock(ns, key, newToken(), 5000, later)).toBe(
          true,
        );
        // The previous holder cannot renew what it no longer has.
        expect(await driver.renewLock(ns, key, stale, 5000, later)).toBe(false);
      });

      it("releases only for the holder", async () => {
        const key = runnerKey("lock-release");
        const now = Date.now();
        const mine = newToken();

        await driver.acquireLock(ns, key, mine, 5000, now);

        expect(await driver.releaseLock(ns, key, newToken())).toBe(false);
        expect(await driver.releaseLock(ns, key, mine)).toBe(true);
        expect(await driver.getLock(ns, key, now)).toBeNull();
      });

      it("keeps the same key in two namespaces independent", async () => {
        const key = runnerKey("shared-id");
        const now = Date.now();

        expect(await driver.acquireLock(ns, key, newToken(), 5000, now)).toBe(
          true,
        );
        expect(
          await driver.acquireLock(other, key, newToken(), 5000, now),
        ).toBe(true);
      });
    });

    /* --- runner state ----------------------------------------------- */

    describe("runner state", () => {
      it("round-trips fields and deletes on null", async () => {
        const key = runnerKey("state");

        expect(await driver.getState(ns, key)).toEqual({});

        await driver.setState(ns, key, { paused: "1", lastRunAt: 42 });
        expect(await driver.getState(ns, key)).toEqual({
          paused: "1",
          lastRunAt: "42",
        });

        await driver.setState(ns, key, { paused: null });
        expect(await driver.getState(ns, key)).toEqual({ lastRunAt: "42" });
      });

      it("increments counters and returns their new values", async () => {
        const key = runnerKey("counters");

        expect(
          await driver.incrementCounters(ns, key, { success: 1, failed: 2 }),
        ).toEqual({ success: 1, failed: 2 });
        expect(await driver.incrementCounters(ns, key, { success: 2 })).toEqual(
          { success: 3 },
        );
      });

      it("keeps history newest-first and trims it", async () => {
        const key = runnerKey("history");

        for (let i = 0; i < 5; i++) {
          await driver.appendHistory(
            ns,
            key,
            {
              runId: `run-${i}`,
              runnerId: "history",
              attempt: 1,
              source: "manual",
              mode: "in-process",
              host: "test",
              startedAt: i,
              status: "running",
            },
            3,
          );
        }

        const history = await driver.listHistory(ns, key);
        expect(history).toHaveLength(3);
        expect(history[0]?.runId).toBe("run-4");
        expect(history.at(-1)?.runId).toBe("run-2");

        expect(await driver.listHistory(ns, key, 2)).toHaveLength(2);
      });

      it("patches a history record and reports a miss", async () => {
        const key = runnerKey("history-update");

        await driver.appendHistory(
          ns,
          key,
          {
            runId: "run-1",
            runnerId: "history-update",
            attempt: 1,
            source: "schedule",
            mode: "spawn",
            host: "test",
            startedAt: 1,
            status: "running",
          },
          10,
        );

        expect(
          await driver.updateHistory(ns, key, "run-1", {
            status: "success",
            finishedAt: 5,
            durationMs: 4,
          }),
        ).toBe(true);
        expect(
          await driver.updateHistory(ns, key, "missing", { status: "failed" }),
        ).toBe(false);

        const [record] = await driver.listHistory(ns, key);
        expect(record).toMatchObject({ status: "success", durationMs: 4 });

        await driver.clearHistory(ns, key);
        expect(await driver.listHistory(ns, key)).toEqual([]);
      });

      it("queues triggers FIFO and enforces the bound", async () => {
        const key = runnerKey("triggers");
        const trigger = (id: string) => ({
          id,
          source: "manual" as const,
          requestedAt: Date.now(),
          requestedBy: newToken(),
        });

        expect(await driver.pushQueuedTrigger(ns, key, trigger("a"), 2)).toBe(
          true,
        );
        expect(await driver.pushQueuedTrigger(ns, key, trigger("b"), 2)).toBe(
          true,
        );
        // Full: the length check and the push have to be one operation, or two
        // processes racing here both believe there is room.
        expect(await driver.pushQueuedTrigger(ns, key, trigger("c"), 2)).toBe(
          false,
        );

        expect(await driver.countQueuedTriggers(ns, key)).toBe(2);
        expect((await driver.popQueuedTrigger(ns, key))?.id).toBe("a");
        expect((await driver.popQueuedTrigger(ns, key))?.id).toBe("b");
        expect(await driver.popQueuedTrigger(ns, key)).toBeNull();

        await driver.pushQueuedTrigger(ns, key, trigger("d"), 10);
        expect(await driver.clearQueuedTriggers(ns, key)).toBe(1);
        expect(await driver.countQueuedTriggers(ns, key)).toBe(0);
      });

      it("carries a queued trigger's force flag, and leaves it unset when absent", async () => {
        const key = runnerKey("forced");
        const base = (id: string) => ({
          id,
          source: "manual" as const,
          requestedAt: Date.now(),
          requestedBy: newToken(),
        });

        await driver.pushQueuedTrigger(ns, key, base("plain"), 10);
        await driver.pushQueuedTrigger(
          ns,
          key,
          { ...base("forced"), force: true },
          10,
        );

        // A drain decides whether to run a trigger on a paused runner, and
        // can only do that if the record remembers what was asked for. Absent
        // — as on every record an earlier version wrote — means not forced.
        expect(await driver.popQueuedTrigger(ns, key)).toMatchObject({
          id: "plain",
        });
        expect((await driver.popQueuedTrigger(ns, key))?.force).toBe(true);

        await driver.clearQueuedTriggers(ns, key);
      });

      it("peeks at the head of the queued triggers without taking it", async () => {
        const key = runnerKey("peeked");
        const trigger = (id: string, force?: boolean) => ({
          id,
          source: "manual" as const,
          requestedAt: Date.now(),
          requestedBy: newToken(),
          ...(force === undefined ? {} : { force }),
        });

        // Empty reads as `null`, the same convention as a pop.
        expect(await driver.peekQueuedTrigger(ns, key)).toBeNull();

        await driver.pushQueuedTrigger(ns, key, trigger("first", true), 10);
        await driver.pushQueuedTrigger(ns, key, trigger("second"), 10);
        await driver.pushQueuedTrigger(ns, key, trigger("third"), 10);

        // The head, and the head again: looking consumes nothing.
        const head = await driver.peekQueuedTrigger(ns, key);
        expect(head).toMatchObject({ id: "first", source: "manual" });
        expect(head?.force).toBe(true);
        expect((await driver.peekQueuedTrigger(ns, key))?.id).toBe("first");
        expect(await driver.countQueuedTriggers(ns, key)).toBe(3);

        // A peek then a pop see the same trigger, whole.
        expect(await driver.popQueuedTrigger(ns, key)).toEqual(head!);

        // The next head, unforced; absent `force` still reads as absent.
        const next = await driver.peekQueuedTrigger(ns, key);
        expect(next?.id).toBe("second");
        expect(next?.force).toBeUndefined();
        expect((await driver.popQueuedTrigger(ns, key))?.id).toBe("second");

        // A trigger pushed now lands behind the head, not in front of it.
        await driver.pushQueuedTrigger(ns, key, trigger("fourth", false), 10);
        expect((await driver.peekQueuedTrigger(ns, key))?.id).toBe("third");
        expect((await driver.popQueuedTrigger(ns, key))?.id).toBe("third");

        const last = await driver.peekQueuedTrigger(ns, key);
        expect(last?.id).toBe("fourth");
        expect(last?.force).toBe(false);
        expect((await driver.popQueuedTrigger(ns, key))?.id).toBe("fourth");

        expect(await driver.peekQueuedTrigger(ns, key)).toBeNull();
        expect(await driver.countQueuedTriggers(ns, key)).toBe(0);
      });

      it("hands out a peeked head that cannot edit the stored one", async () => {
        const key = runnerKey("peek-copy");

        await driver.pushQueuedTrigger(
          ns,
          key,
          {
            id: "kept",
            source: "manual",
            requestedAt: Date.now(),
            requestedBy: newToken(),
          },
          10,
        );

        const head = await driver.peekQueuedTrigger(ns, key);
        head!.id = "edited";
        head!.force = true;

        const again = await driver.popQueuedTrigger(ns, key);
        expect(again?.id).toBe("kept");
        expect(again?.force).toBeUndefined();
      });

      describe("popQueuedTriggerIf", () => {
        const trigger = (id: string, force?: boolean) => ({
          id,
          source: "manual" as const,
          requestedAt: Date.now(),
          requestedBy: newToken(),
          ...(force === undefined ? {} : { force }),
        });

        it("pops the head when its id matches", async () => {
          const key = runnerKey("pop-if-match");
          await driver.pushQueuedTrigger(ns, key, trigger("first"), 10);
          await driver.pushQueuedTrigger(ns, key, trigger("second"), 10);

          const head = await driver.peekQueuedTrigger(ns, key);
          expect(await driver.popQueuedTriggerIf(ns, key, "first")).toEqual(
            head!,
          );
          expect(await driver.countQueuedTriggers(ns, key)).toBe(1);
          expect((await driver.peekQueuedTrigger(ns, key))?.id).toBe("second");
          expect((await driver.popQueuedTriggerIf(ns, key, "second"))?.id).toBe(
            "second",
          );
          expect(await driver.countQueuedTriggers(ns, key)).toBe(0);
        });

        it("returns null and leaves the queue untouched when the head's id differs", async () => {
          const key = runnerKey("pop-if-mismatch");
          await driver.pushQueuedTrigger(ns, key, trigger("first"), 10);
          await driver.pushQueuedTrigger(ns, key, trigger("second"), 10);

          // Neither an id further back nor one that was never queued: the
          // check is against the head, not membership.
          expect(await driver.popQueuedTriggerIf(ns, key, "second")).toBeNull();
          expect(await driver.popQueuedTriggerIf(ns, key, "absent")).toBeNull();

          expect(await driver.countQueuedTriggers(ns, key)).toBe(2);
          expect((await driver.popQueuedTrigger(ns, key))?.id).toBe("first");
          expect((await driver.popQueuedTrigger(ns, key))?.id).toBe("second");
        });

        it("returns null on an empty queue", async () => {
          const key = runnerKey("pop-if-empty");
          await driver.pushQueuedTrigger(ns, key, trigger("only"), 10);
          await driver.popQueuedTrigger(ns, key);

          expect(await driver.popQueuedTriggerIf(ns, key, "only")).toBeNull();
          expect(await driver.countQueuedTriggers(ns, key)).toBe(0);
        });

        it("round-trips the force flag", async () => {
          const key = runnerKey("pop-if-force");
          await driver.pushQueuedTrigger(ns, key, trigger("forced", true), 10);
          await driver.pushQueuedTrigger(ns, key, trigger("plain"), 10);
          await driver.pushQueuedTrigger(
            ns,
            key,
            trigger("unforced", false),
            10,
          );

          const forced = await driver.popQueuedTriggerIf(ns, key, "forced");
          expect(forced).toMatchObject({ id: "forced", source: "manual" });
          expect(forced?.force).toBe(true);
          const plain = await driver.popQueuedTriggerIf(ns, key, "plain");
          expect(plain?.id).toBe("plain");
          expect(plain?.force).toBeUndefined();
          expect(
            (await driver.popQueuedTriggerIf(ns, key, "unforced"))?.force,
          ).toBe(false);
        });

        it("hands the peeked head to exactly one of many racing callers", async () => {
          const key = runnerKey("pop-if-race");
          await driver.pushQueuedTrigger(ns, key, trigger("contested"), 10);
          await driver.pushQueuedTrigger(ns, key, trigger("behind"), 10);
          await driver.pushQueuedTrigger(ns, key, trigger("further"), 10);

          const head = await driver.peekQueuedTrigger(ns, key);
          expect(head?.id).toBe("contested");

          // Every caller inspected the same head. One takes it; the others
          // must not take whatever the head became after it went.
          const contend = async () =>
            await driver.popQueuedTriggerIf(ns, key, head!.id);
          const results = await Promise.all(Array.from({ length: 8 }, contend));

          const winners = results.filter((result) => result !== null);
          expect(winners).toHaveLength(1);
          expect(winners[0]?.id).toBe("contested");
          expect(await driver.countQueuedTriggers(ns, key)).toBe(2);
          expect((await driver.peekQueuedTrigger(ns, key))?.id).toBe("behind");

          await driver.clearQueuedTriggers(ns, key);
        });

        it("never loses or duplicates a trigger when pops and conditional pops interleave", async () => {
          const key = runnerKey("pop-if-interleave");
          const pushed = Array.from({ length: 24 }, (_, i) => `t${i}`);
          for (const id of pushed) {
            await driver.pushQueuedTrigger(ns, key, trigger(id), 100);
          }

          const taken: string[] = [];
          const mismatched: string[] = [];

          // Half the drainers pop blindly, half peek and pop by id, all at
          // once, until the queue is empty.
          const drain = async (conditional: boolean): Promise<void> => {
            for (let spins = 0; spins < 500; spins++) {
              if (conditional) {
                const head = await driver.peekQueuedTrigger(ns, key);
                if (!head) {
                  return;
                }
                const popped = await driver.popQueuedTriggerIf(
                  ns,
                  key,
                  head.id,
                );
                if (popped) {
                  // Whatever it returns must be the record it was asked for.
                  if (popped.id !== head.id) {
                    mismatched.push(`${head.id}->${popped.id}`);
                  }
                  taken.push(popped.id);
                }
              } else {
                const popped = await driver.popQueuedTrigger(ns, key);
                if (!popped) {
                  return;
                }
                taken.push(popped.id);
              }
            }
          };

          await Promise.all([
            drain(true),
            drain(false),
            drain(true),
            drain(false),
            drain(true),
            drain(true),
          ]);

          expect(mismatched).toEqual([]);
          expect(taken).toHaveLength(pushed.length);
          expect([...taken].sort()).toEqual([...pushed].sort());
          expect(await driver.countQueuedTriggers(ns, key)).toBe(0);
        });
      });
    });

    /* --- run logs ----------------------------------------------------- */

    describe("run logs", () => {
      /** Caps that bound nothing, so a case only feels the cap it sets. */
      const OPEN: RunLogCaps = { maxLines: 0, maxBytes: 0, keepRuns: 0 };

      /** The whole log, oldest first — the default read for most cases. */
      const ALL: RunLogQuery = { offset: 0, limit: 1000, order: "asc" };

      /**
       * The driver, with the optional run-log methods asserted present.
       *
       * They are optional so the API can prune the route on a backend without
       * them, but every backend in this suite has them — a missing one is a
       * driver that is not finished, not a driver that opted out.
       *
       * Bound, because every driver reaches its own private state through
       * `this` and a case reads better calling `appendRunLog(...)`.
       */
      function logs(): Required<
        Pick<JobsDriver, "appendRunLog" | "getRunLog" | "clearRunLogs">
      > {
        expect(typeof driver.appendRunLog).toBe("function");
        expect(typeof driver.getRunLog).toBe("function");
        expect(typeof driver.clearRunLogs).toBe("function");

        return {
          appendRunLog: driver.appendRunLog!.bind(driver),
          getRunLog: driver.getRunLog!.bind(driver),
          clearRunLogs: driver.clearRunLogs!.bind(driver),
        };
      }

      /** One line, at a time the assertions can name. */
      function line(
        text: string,
        extra: Partial<RunLogInput> = {},
      ): RunLogInput {
        return { stream: "stdout", at: 1_700_000_000_000, text, ...extra };
      }

      it("appends lines and reads them back in order, numbered from one", async () => {
        const key = runnerKey("rl-order");
        const { appendRunLog, getRunLog } = logs();

        const first = await appendRunLog(
          ns,
          key,
          "run-1",
          [line("one"), line("two", { stream: "stderr" })],
          OPEN,
        );
        expect(first).toEqual({ count: 2, dropped: 0, lastSeq: 2 });

        // A second flush continues the run's numbering rather than its own.
        const second = await appendRunLog(
          ns,
          key,
          "run-1",
          [line("three")],
          OPEN,
        );
        expect(second).toEqual({ count: 3, dropped: 0, lastSeq: 3 });

        const page = await getRunLog(ns, key, "run-1", ALL);
        expect(page).toEqual({
          lines: [
            { seq: 1, stream: "stdout", at: 1_700_000_000_000, text: "one" },
            { seq: 2, stream: "stderr", at: 1_700_000_000_000, text: "two" },
            { seq: 3, stream: "stdout", at: 1_700_000_000_000, text: "three" },
          ],
          count: 3,
          dropped: 0,
          lastSeq: 3,
        });

        // `desc` is newest first, and the offset counts in that same order.
        const newest = await getRunLog(ns, key, "run-1", {
          offset: 1,
          limit: 1,
          order: "desc",
        });
        expect(newest.lines.map((entry) => entry.text)).toEqual(["two"]);
        expect(newest.count).toBe(3);
      });

      it("carries a line's level and truncation flag, and omits them when absent", async () => {
        const key = runnerKey("rl-fields");
        const { appendRunLog, getRunLog } = logs();

        await appendRunLog(
          ns,
          key,
          "run-1",
          [
            line("plain"),
            line("warned", { stream: "log", level: "warn" }),
            line("cut", { truncated: true }),
          ],
          OPEN,
        );

        const { lines } = await getRunLog(ns, key, "run-1", ALL);

        // Absent, not null and not false: a line without them reads back
        // without them on every backend, however that backend stores nothing.
        expect(lines[0]).toEqual({
          seq: 1,
          stream: "stdout",
          at: 1_700_000_000_000,
          text: "plain",
        });
        expect(lines[1]).toMatchObject({ stream: "log", level: "warn" });
        expect(lines[2]).toMatchObject({ text: "cut", truncated: true });
        expect(lines[2]).not.toHaveProperty("level");
      });

      it("filters by `since` exclusively and by stream", async () => {
        const key = runnerKey("rl-filter");
        const { appendRunLog, getRunLog } = logs();

        await appendRunLog(
          ns,
          key,
          "run-1",
          [
            line("a"),
            line("b", { stream: "stderr" }),
            line("c"),
            line("d", { stream: "stderr" }),
          ],
          OPEN,
        );

        // Exclusive, so handing back the last seq read tails without
        // repeating a line.
        const tail = await getRunLog(ns, key, "run-1", { ...ALL, since: 2 });
        expect(tail.lines.map((entry) => entry.seq)).toEqual([3, 4]);
        expect(tail.count).toBe(2);
        expect(await getRunLog(ns, key, "run-1", { ...ALL, since: 4 })).toEqual(
          { lines: [], count: 0, dropped: 0, lastSeq: 4 },
        );

        const errors = await getRunLog(ns, key, "run-1", {
          ...ALL,
          stream: "stderr",
        });
        expect(errors.lines.map((entry) => entry.text)).toEqual(["b", "d"]);
        // The count is the filtered total, because that is what pages it —
        // but `lastSeq` is the log's own, so a filtered tail cannot resume
        // from a line number that skips everything the filter excluded.
        expect(errors.count).toBe(2);
        expect(errors.lastSeq).toBe(4);

        const both = await getRunLog(ns, key, "run-1", {
          ...ALL,
          since: 2,
          stream: "stderr",
        });
        expect(both.lines.map((entry) => entry.seq)).toEqual([4]);
      });

      it("drops the oldest lines at the line cap and reports how many", async () => {
        const key = runnerKey("rl-lines");
        const { appendRunLog, getRunLog } = logs();

        const result = await appendRunLog(
          ns,
          key,
          "run-1",
          [line("a"), line("b"), line("c"), line("d"), line("e")],
          { ...OPEN, maxLines: 2 },
        );

        // The oldest go, never the newest: a run's log is the tail of its
        // output, and the end is the part that says how it finished.
        expect(result).toEqual({ count: 2, dropped: 3, lastSeq: 5 });

        const page = await getRunLog(ns, key, "run-1", ALL);
        expect(page.lines.map((entry) => entry.text)).toEqual(["d", "e"]);
        // The numbering does not restart, which is how a gap stays visible.
        expect(page.lines.map((entry) => entry.seq)).toEqual([4, 5]);
        expect(page).toMatchObject({ count: 2, dropped: 3, lastSeq: 5 });
      });

      it("drops the oldest lines at the byte cap", async () => {
        const key = runnerKey("rl-bytes");
        const { appendRunLog, getRunLog } = logs();

        // Ten bytes each, so the cap is exactly three lines' worth — and it
        // counts the text alone, not whatever framing the backend adds.
        const ten = (label: string) => line(label.repeat(10).slice(0, 10));

        const result = await appendRunLog(
          ns,
          key,
          "run-1",
          [ten("a"), ten("b"), ten("c"), ten("d"), ten("e")],
          { ...OPEN, maxBytes: 30 },
        );
        expect(result).toEqual({ count: 3, dropped: 2, lastSeq: 5 });

        const page = await getRunLog(ns, key, "run-1", ALL);
        expect(page.lines.map((entry) => entry.text)).toEqual([
          "cccccccccc",
          "dddddddddd",
          "eeeeeeeeee",
        ]);

        // Multi-byte text is counted in bytes, not characters: four of these
        // are 12 bytes and would be four characters.
        await appendRunLog(ns, key, "run-2", [line("日本語"), line("x")], {
          ...OPEN,
          maxBytes: 9,
        });
        const narrow = await getRunLog(ns, key, "run-2", ALL);
        expect(narrow.lines.map((entry) => entry.text)).toEqual(["x"]);
        expect(narrow.dropped).toBe(1);
      });

      it("evicts the oldest run's log at `keepRuns`", async () => {
        const key = runnerKey("rl-keep");
        const { appendRunLog, getRunLog } = logs();
        const caps = { ...OPEN, keepRuns: 2 };

        // Sequential, because the eviction order is the order the runs first
        // logged anything.
        await appendRunLog(ns, key, "run-1", [line("first")], caps);
        await appendRunLog(ns, key, "run-2", [line("second")], caps);
        await appendRunLog(ns, key, "run-3", [line("third")], caps);

        // Gone whole, and gone without a trace: an evicted run reads as a run
        // that never logged, not as one whose every line was dropped.
        expect(await getRunLog(ns, key, "run-1", ALL)).toEqual({
          lines: [],
          count: 0,
          dropped: 0,
          lastSeq: 0,
        });
        expect(
          (await getRunLog(ns, key, "run-2", ALL)).lines.map((l) => l.text),
        ).toEqual(["second"]);
        expect(
          (await getRunLog(ns, key, "run-3", ALL)).lines.map((l) => l.text),
        ).toEqual(["third"]);

        // Writing to a run that is still kept evicts nothing further.
        await appendRunLog(ns, key, "run-3", [line("more")], caps);
        expect((await getRunLog(ns, key, "run-2", ALL)).count).toBe(1);
      });

      it("reads a run it has never heard of as an empty log", async () => {
        const { getRunLog } = logs();

        expect(
          await getRunLog(ns, runnerKey("rl-unknown"), "nope", ALL),
        ).toEqual({ lines: [], count: 0, dropped: 0, lastSeq: 0 });
      });

      it("clears one run's log, or every log the runner holds", async () => {
        const key = runnerKey("rl-clear");
        const { appendRunLog, getRunLog, clearRunLogs } = logs();

        await appendRunLog(ns, key, "run-1", [line("a")], OPEN);
        await appendRunLog(ns, key, "run-2", [line("b")], OPEN);

        await clearRunLogs(ns, key, "run-1");
        expect((await getRunLog(ns, key, "run-1", ALL)).count).toBe(0);
        expect((await getRunLog(ns, key, "run-2", ALL)).count).toBe(1);

        // Clearing a run that has no log is not an error.
        await clearRunLogs(ns, key, "run-1");

        await clearRunLogs(ns, key);
        expect((await getRunLog(ns, key, "run-2", ALL)).count).toBe(0);
      });

      it("drops the runner's logs when the history is cleared", async () => {
        const key = runnerKey("rl-history");
        const { appendRunLog, getRunLog } = logs();

        await driver.appendHistory(
          ns,
          key,
          {
            runId: "run-1",
            runnerId: "rl-history",
            attempt: 1,
            source: "manual",
            mode: "in-process",
            host: "here",
            startedAt: 1,
            status: "success",
          },
          10,
        );
        await appendRunLog(ns, key, "run-1", [line("a")], OPEN);

        await driver.clearHistory(ns, key);

        // A run the history no longer names cannot be asked about, so a log
        // left behind for it would be bytes nothing could reach or collect.
        expect(await driver.listHistory(ns, key)).toEqual([]);
        expect(await getRunLog(ns, key, "run-1", ALL)).toEqual({
          lines: [],
          count: 0,
          dropped: 0,
          lastSeq: 0,
        });
      });

      it("does not touch the runner's state or history when a line is appended", async () => {
        const key = runnerKey("rl-apart");
        const { appendRunLog } = logs();

        const record: RunRecord = {
          runId: "run-1",
          runnerId: "rl-apart",
          attempt: 1,
          source: "schedule",
          mode: "spawn",
          host: "here",
          startedAt: 7,
          status: "running",
        };
        await driver.appendHistory(ns, key, record, 10);
        await driver.setState(ns, key, { paused: "1", lastRunAt: 7 });

        // The reason run logs are not a field on the run record: a runner's
        // history is one document on the file, SQL and MongoDB drivers, so a
        // line arriving every few milliseconds would rewrite the whole of it
        // that often — and would race every other writer of that document.
        for (let i = 0; i < 25; i++) {
          await appendRunLog(ns, key, "run-1", [line(`line ${i}`)], OPEN);
        }

        expect(await driver.listHistory(ns, key)).toEqual([record]);
        expect(await driver.getState(ns, key)).toEqual({
          paused: "1",
          lastRunAt: "7",
        });
      });

      it("keeps one runner's logs out of another's", async () => {
        const mine = runnerKey("rl-mine");
        const theirs = runnerKey("rl-theirs");
        const { appendRunLog, getRunLog, clearRunLogs } = logs();

        await appendRunLog(ns, mine, "run-1", [line("mine")], OPEN);
        await appendRunLog(ns, theirs, "run-1", [line("theirs")], OPEN);
        // Same runner, same run id, another namespace.
        await appendRunLog(other, mine, "run-1", [line("elsewhere")], OPEN);

        await clearRunLogs(ns, mine);

        expect(
          (await getRunLog(ns, theirs, "run-1", ALL)).lines.map((l) => l.text),
        ).toEqual(["theirs"]);
        expect(
          (await getRunLog(other, mine, "run-1", ALL)).lines.map((l) => l.text),
        ).toEqual(["elsewhere"]);
      });
    });

    /* --- analytics ---------------------------------------------------- */

    describe("analytics", () => {
      /**
       * The optional analytics methods a backend either has or has not.
       *
       * `flushMetrics` is not among them: a driver that writes a count where
       * it happens has nothing to flush, and the contract says so by making it
       * optional on its own.
       */
      const METRIC_METHODS = [
        "countRunnerRun",
        "countWorkerJobs",
        "getMetricsSupport",
        "getNamespaceMetrics",
        "getQueueMetrics",
        "getRunnerMetrics",
        "getWorkerMetrics",
        "sampleWorkerBusyness",
      ] as const satisfies readonly (keyof JobsDriver)[];

      /** The analytics methods, bound, plus a flush that is a no-op without one. */
      type Analytics = Required<
        Pick<JobsDriver, (typeof METRIC_METHODS)[number]>
      > & {
        /** Writes whatever the driver gathered in memory, or nothing. */
        flushMetrics: () => Promise<void>;
      };

      /** Namespaces these cases made, purged at the end and nothing else with them. */
      const scopes: string[] = [];

      afterAll(async () => {
        for (const scope of scopes) {
          await driver.purge(scope);
        }
      });

      /**
       * A namespace of this case's own.
       *
       * Every roll-up here is namespace-wide, so a case sharing one with
       * another would be asserting the other's counts too.
       */
      function scope(name: string): string {
        const created = testNamespace(name);
        scopes.push(created);
        return created;
      }

      /**
       * The analytics methods, or `undefined` for a backend that has none of
       * them yet.
       *
       * They are optional so a driver without them has its routes pruned and
       * reports `features.runnerMetrics: false` — but a driver with *some* of
       * them is unfinished rather than opted out, and that is asserted here
       * rather than left to fail somewhere obscure.
       *
       * Bound, because every driver reaches its own private state through
       * `this` and a case reads better calling `countWorkerJobs(...)`.
       */
      function analytics(): Analytics | undefined {
        const present = METRIC_METHODS.filter(
          (method) => typeof driver[method] === "function",
        );

        if (present.length === 0) {
          return undefined;
        }

        expect(present).toEqual([...METRIC_METHODS]);

        return {
          countRunnerRun: driver.countRunnerRun!.bind(driver),
          countWorkerJobs: driver.countWorkerJobs!.bind(driver),
          getMetricsSupport: driver.getMetricsSupport!.bind(driver),
          getNamespaceMetrics: driver.getNamespaceMetrics!.bind(driver),
          getQueueMetrics: driver.getQueueMetrics!.bind(driver),
          getRunnerMetrics: driver.getRunnerMetrics!.bind(driver),
          getWorkerMetrics: driver.getWorkerMetrics!.bind(driver),
          sampleWorkerBusyness: driver.sampleWorkerBusyness!.bind(driver),
          flushMetrics: async () => {
            await driver.flushMetrics?.();
          },
        };
      }

      /**
       * A whole minute that has already passed.
       *
       * Every case's times are inside it, so none of them straddles a bucket
       * boundary depending on when the suite happens to run, and none of them
       * is in the future — which matters, because the retention case is the
       * one that deliberately writes ahead to step the prune clock.
       */
      function lastMinute(): number {
        return bucketStart(Date.now() - MINUTE_BUCKET_MS, MINUTE_BUCKET_MS);
      }

      /** One minute's worth of buckets, at the width the case is asking about. */
      function oneMinute(
        at: number,
        interval = MINUTE_BUCKET_MS,
      ): MetricsQuery {
        return { from: at, to: at, interval };
      }

      /** A run-counter bucket with only the named outcomes in it. */
      function runs(
        at: number,
        counts: Partial<RunnerRunCounters>,
      ): CounterBucket<RunnerRunCounters> {
        const bucket = { at } as CounterBucket<RunnerRunCounters>;
        for (const key of RUNNER_RUN_COUNTERS) {
          bucket[key] = counts[key] ?? 0;
        }
        return bucket;
      }

      it("reports which widths it keeps, and answers nothing for one it does not", async () => {
        const a = analytics();
        if (!a) {
          return;
        }

        const support: MetricsSupport = a.getMetricsSupport();
        const now = Date.now();

        // Every backend serves minutes; per-second is what one may not.
        expect(support.resolutions).toContain(60);
        expect(support.resolutions.every((r) => r === 1 || r === 60)).toBe(
          true,
        );
        for (const resolution of support.resolutions) {
          expect(support.retentionMs[`${resolution}`]).toBeGreaterThan(0);
        }
        expect(support.recording.resolution).toBe(
          support.resolutions.includes(1) ? "second" : "minute",
        );

        // A minute-wide window, so the bucket cap cannot be what coarsens it:
        // the default range is an hour, and an hour of seconds is 3,600
        // buckets — over the cap — which would coarsen to 60 s on every
        // backend and tell us nothing about this one.
        const asked = resolveAnalyticsRange(
          { now, from: now - MINUTE_BUCKET_MS, to: now, resolution: 1 },
          support,
        );

        if (support.resolutions.includes(1)) {
          expect(asked.resolution).toBe(1);
          return;
        }

        // A backend that records only minutes says so, rather than serving
        // something it does not have: the range comes back coarsened, and
        // `driver` — not `retention` — is why.
        expect(asked.resolution).toBe(60);
        expect(asked.clamped).toBe(true);
        expect(asked.reason).toBe("driver");
        expect(support.recording.secondRetentionMs).toBe(0);

        // And the reads agree with the report.
        const ns1 = scope("an-minute-only");
        const q1: QueueRef = { ns: ns1, queue: "orders" };
        const minute = lastMinute();

        await a.countWorkerJobs(q1, "w", minute + 1_000, { completed: 1 });
        await a.countRunnerRun(ns1, runnerKey("r"), minute + 1_000, {
          started: 1,
        });
        await a.flushMetrics();

        const second = { from: minute, to: minute + 59_000, interval: 1_000 };
        expect((await a.getWorkerMetrics(q1, "w", second)).jobs).toEqual([]);
        expect(
          (await a.getRunnerMetrics(ns1, runnerKey("r"), second)).runs,
        ).toEqual([]);
        expect(await a.getQueueMetrics(q1, second)).toEqual([]);

        // The same counts are there at the width it does keep.
        expect(
          (await a.getWorkerMetrics(q1, "w", oneMinute(minute))).jobs,
        ).toEqual([{ at: minute, completed: 1, failed: 0 }]);
      });

      it("counts into the bucket its time falls in, at every width it keeps", async () => {
        const a = analytics();
        if (!a) {
          return;
        }

        const ns1 = scope("an-widths");
        const q1: QueueRef = { ns: ns1, queue: "orders" };
        const minute = lastMinute();
        const at = minute + 30_000;

        await a.countWorkerJobs(q1, "w-widths", at, { completed: 2 });
        await a.countWorkerJobs(q1, "w-widths", at, { failed: 1 });
        await a.flushMetrics();

        expect(
          (await a.getWorkerMetrics(q1, "w-widths", oneMinute(minute))).jobs,
        ).toEqual([{ at: minute, completed: 2, failed: 1 }]);

        const seconds = await a.getWorkerMetrics(q1, "w-widths", {
          from: minute,
          to: minute + 59_000,
          interval: SECOND_BUCKET_MS,
        });

        expect(seconds.jobs).toEqual(
          a.getMetricsSupport().resolutions.includes(1)
            ? [{ at, completed: 2, failed: 1 }]
            : [],
        );
      });

      it("writes the second and the minute from one count, the minute being its seconds", async () => {
        const a = analytics();
        if (!a || !a.getMetricsSupport().resolutions.includes(1)) {
          // A minute-only backend has no second bucket to agree with; that it
          // says so is the case above.
          return;
        }

        const ns1 = scope("an-dual");
        const q1: QueueRef = { ns: ns1, queue: "orders" };
        const minute = lastMinute();
        const times = [minute + 1_000, minute + 2_000, minute + 59_000];

        for (const at of times) {
          await a.countWorkerJobs(q1, "w-dual", at, { completed: 1 });
        }
        await a.flushMetrics();

        const seconds = (
          await a.getWorkerMetrics(q1, "w-dual", {
            from: minute,
            to: minute + 59_000,
            interval: SECOND_BUCKET_MS,
          })
        ).jobs;

        expect(seconds).toEqual(
          times.map((at) => ({ at, completed: 1, failed: 0 })),
        );

        // The dual write, not a roll-up job: the minute is already there, and
        // it is exactly the sum of the seconds inside it.
        const minutes = (
          await a.getWorkerMetrics(q1, "w-dual", oneMinute(minute))
        ).jobs;

        expect(minutes).toEqual([{ at: minute, completed: 3, failed: 0 }]);
        expect(minutes[0]!.completed).toBe(
          seconds.reduce((sum, bucket) => sum + bucket.completed, 0),
        );
      });

      it("answers sparsely: an interval nothing happened in is absent", async () => {
        const a = analytics();
        if (!a) {
          return;
        }

        const ns1 = scope("an-sparse");
        const q1: QueueRef = { ns: ns1, queue: "orders" };
        const minute = lastMinute();
        const earlier = minute - 2 * MINUTE_BUCKET_MS;

        await a.countWorkerJobs(q1, "w-sparse", earlier, { completed: 1 });
        await a.countWorkerJobs(q1, "w-sparse", minute, { failed: 1 });
        await a.flushMetrics();

        // The minute between them is not a zero bucket — it is not there at
        // all. Making the series contiguous is `fillBuckets`' job, after the
        // resolution has capped how many buckets there may be.
        expect(
          (
            await a.getWorkerMetrics(q1, "w-sparse", {
              from: earlier,
              to: minute,
              interval: MINUTE_BUCKET_MS,
            })
          ).jobs,
        ).toEqual([
          { at: earlier, completed: 1, failed: 0 },
          { at: minute, completed: 0, failed: 1 },
        ]);
      });

      it("fans a count out to its entity and to the namespace roll-up", async () => {
        const a = analytics();
        if (!a) {
          return;
        }

        const ns1 = scope("an-rollup");
        const orders: QueueRef = { ns: ns1, queue: "orders" };
        const mail: QueueRef = { ns: ns1, queue: "mail" };
        const runner = runnerKey("nightly");
        const minute = lastMinute();
        const range = oneMinute(minute);

        await a.countWorkerJobs(orders, "w-1", minute, { completed: 2 });
        await a.countWorkerJobs(mail, "w-2", minute, {
          completed: 3,
          failed: 1,
        });
        await a.countRunnerRun(ns1, runner, minute, {
          started: 1,
          succeeded: 1,
        });
        await a.flushMetrics();

        // Each entity keeps its own.
        expect((await a.getWorkerMetrics(orders, "w-1", range)).jobs).toEqual([
          { at: minute, completed: 2, failed: 0 },
        ]);
        expect((await a.getRunnerMetrics(ns1, runner, range)).runs).toEqual([
          runs(minute, { started: 1, succeeded: 1 }),
        ]);

        // And the namespace has the sum already written, which is what makes
        // an overview three reads whatever the fleet size.
        const roll = await a.getNamespaceMetrics(ns1, {
          ...range,
          kinds: ["jobs", "runs", "workerJobs"],
        });

        expect(roll.workerJobs).toEqual([
          { at: minute, completed: 5, failed: 1 },
        ]);
        expect(roll.runs).toEqual([runs(minute, { started: 1, succeeded: 1 })]);
        // Nothing finished a job on a queue here, so that roll-up is empty —
        // a worker's count is not a queue's.
        expect(roll.jobs).toEqual([]);
      });

      it("counts a completion into the queue's series and the namespace's", async () => {
        const a = analytics();
        if (!a) {
          return;
        }

        const ns1 = scope("an-queue");
        const q1: QueueRef = { ns: ns1, queue: "orders" };
        const minute = lastMinute();
        const at = minute + 10_000;
        const token = newToken();

        await driver.ensureQueue(q1);
        await driver.addJob(
          q1,
          makeJob({ id: "j1", createdAt: at, runAt: at }),
        );
        await driver.claimJob(q1, {
          workerId: "w",
          token,
          lockMs: 60_000,
          now: at,
        });
        expect(await driver.completeJob(q1, "j1", token, null, false, at)).toBe(
          true,
        );
        await a.flushMetrics();

        const bucket = [{ at: minute, completed: 1, failed: 0 }];
        expect(await a.getQueueMetrics(q1, oneMinute(minute))).toEqual(bucket);

        const roll = await a.getNamespaceMetrics(ns1, {
          ...oneMinute(minute),
          kinds: ["jobs"],
        });
        expect(roll.jobs).toEqual(bucket);
      });

      it("keeps one namespace's counts out of another's, and one entity's out of another's", async () => {
        const a = analytics();
        if (!a) {
          return;
        }

        const mine = scope("an-mine");
        const theirs = scope("an-theirs");
        const myQueue: QueueRef = { ns: mine, queue: "orders" };
        const theirQueue: QueueRef = { ns: theirs, queue: "orders" };
        const runner = runnerKey("shared-id");
        const minute = lastMinute();
        const range = oneMinute(minute);

        await a.countWorkerJobs(myQueue, "same-key", minute, { completed: 1 });
        await a.countWorkerJobs(myQueue, "other-key", minute, { completed: 5 });
        await a.countWorkerJobs(theirQueue, "same-key", minute, {
          completed: 9,
        });
        await a.countRunnerRun(mine, runner, minute, { started: 1 });
        await a.countRunnerRun(theirs, runner, minute, { started: 7 });
        await a.flushMetrics();

        // The same key, the same queue name, another namespace.
        expect(
          (await a.getWorkerMetrics(myQueue, "same-key", range)).jobs,
        ).toEqual([{ at: minute, completed: 1, failed: 0 }]);
        expect(
          (await a.getWorkerMetrics(theirQueue, "same-key", range)).jobs,
        ).toEqual([{ at: minute, completed: 9, failed: 0 }]);
        expect((await a.getRunnerMetrics(mine, runner, range)).runs).toEqual([
          runs(minute, { started: 1 }),
        ]);

        // A namespace's roll-up holds its own entities and nothing else.
        const roll = await a.getNamespaceMetrics(mine, {
          ...range,
          kinds: ["runs", "workerJobs"],
        });
        expect(roll.workerJobs).toEqual([
          { at: minute, completed: 6, failed: 0 },
        ]);
        expect(roll.runs).toEqual([runs(minute, { started: 1 })]);
      });

      it("keys a worker's series by its stable key, so two incarnations share one", async () => {
        const a = analytics();
        if (!a) {
          return;
        }

        const ns1 = scope("an-worker-key");
        const q1: QueueRef = { ns: ns1, queue: "orders" };
        const minute = lastMinute();
        const key = "orders-worker-1";

        // A rolling redeploy: one worker, two incarnations, two ids.
        for (const id of ["w-old", "w-new"]) {
          await registerWorkerRecord(driver, q1, {
            id,
            key,
            queue: q1.queue,
            host: "here",
            pid: 1,
            startedAt: minute,
            heartbeatAt: minute,
            expiresAt: minute + 60_000,
            concurrency: 1,
            active: 0,
            paused: false,
            state: "running",
          });
          await a.countWorkerJobs(q1, key, minute, { completed: 1 });
        }
        await a.countWorkerJobs(q1, "orders-worker-2", minute, {
          completed: 4,
        });
        await a.flushMetrics();

        // Keyed by `id` the redeploy would have shredded this into two.
        expect(
          (await a.getWorkerMetrics(q1, key, oneMinute(minute))).jobs,
        ).toEqual([{ at: minute, completed: 2, failed: 0 }]);
        expect(
          (await a.getWorkerMetrics(q1, "orders-worker-2", oneMinute(minute)))
            .jobs,
        ).toEqual([{ at: minute, completed: 4, failed: 0 }]);
      });

      it("round-trips a run's durations: exact extremes, a histogram, a median in the right bin", async () => {
        const a = analytics();
        if (!a) {
          return;
        }

        const ns1 = scope("an-durations");
        const runner = runnerKey("reports");
        const minute = lastMinute();
        const range = { ...oneMinute(minute), durations: true };
        const taken = [5, 6, 7, 900];

        for (const durationMs of taken) {
          await a.countRunnerRun(ns1, runner, minute + 1_000, {
            succeeded: 1,
            durationMs,
          });
        }
        await a.flushMetrics();

        const read = await a.getRunnerMetrics(ns1, runner, range);
        expect(read.runs).toEqual([runs(minute, { succeeded: 4 })]);

        const bucket = read.durations?.[0];
        expect(read.durations).toHaveLength(1);
        expect(bucket?.at).toBe(minute);

        // The histogram is what a writer wrote, bin for bin — that is what
        // makes it mergeable across writers without an atomic per-bin write.
        const expected = emptyHistogram();
        for (const ms of taken) {
          expected[durationBin(ms)]!++;
        }
        expect(bucket?.histogram).toEqual(expected);

        const summary = readDurations(bucket!);
        // A sum over a count, not a histogram read, so these are exact.
        expect(summary.count).toBe(4);
        expect(summary.minMs).toBe(5);
        expect(summary.maxMs).toBe(900);
        expect(summary.meanMs).toBe((5 + 6 + 7 + 900) / 4);

        // Three of the four are in the [4, 8) bin, so the median is in it too
        // — interpolated, and never further out than the bin's edges.
        expect(summary.p50Ms).toBe(histogramQuantile(expected, 0.5));
        expect(summary.p50Ms).toBeGreaterThanOrEqual(4);
        expect(summary.p50Ms).toBeLessThan(8);
        expect(summary.p95Ms).toBeGreaterThanOrEqual(512);

        // Not asked for, not answered: a histogram is 25 numbers a bucket.
        expect(
          (await a.getRunnerMetrics(ns1, runner, oneMinute(minute))).durations,
        ).toBeUndefined();
      });

      it("merges busyness samples, keeping the concurrency of the last one", async () => {
        const a = analytics();
        if (!a) {
          return;
        }

        const ns1 = scope("an-busyness");
        const q1: QueueRef = { ns: ns1, queue: "orders" };
        const minute = lastMinute();
        const key = "w-busy";

        // Out of order on purpose: an earlier heartbeat arriving late must not
        // become "the concurrency as of the last sample".
        await a.sampleWorkerBusyness(q1, key, minute + 20_000, {
          active: 6,
          concurrency: 9,
        });
        await a.sampleWorkerBusyness(q1, key, minute + 10_000, {
          active: 2,
          concurrency: 5,
        });
        await a.flushMetrics();

        const read = await a.getWorkerMetrics(q1, key, {
          ...oneMinute(minute),
          busyness: true,
        });

        expect(read.busyness).toHaveLength(1);
        const bucket = read.busyness![0]!;
        expect(bucket.at).toBe(minute);
        expect(bucket.samples).toBe(2);
        expect(bucket.activeSum).toBe(8);
        expect(bucket.activeMax).toBe(6);
        expect(bucket.lastAt).toBe(minute + 20_000);

        // The mean is derived on read, because a mean cannot be merged.
        expect(readBusyness(bucket)).toEqual({
          samples: 2,
          activeMean: 4,
          activeMax: 6,
          concurrency: 9,
        });

        // Not asked for, not answered.
        expect(
          (await a.getWorkerMetrics(q1, key, oneMinute(minute))).busyness,
        ).toBeUndefined();
      });

      it("prunes by range, so a series nothing writes to any more loses its old buckets", async () => {
        const a = analytics();
        if (!a) {
          return;
        }

        const ns1 = scope("an-retention");
        const q1: QueueRef = { ns: ns1, queue: "orders" };
        const now = Date.now();
        const minute = lastMinute();

        // The prune is due at most once a minute per process, and the first
        // time it is asked. This spends that first time, so the two ancient
        // buckets below are certain to be stored before a sweep can run.
        await a.countWorkerJobs(q1, "w-warm", minute, { completed: 1 });
        await a.flushMetrics();

        const ancient = bucketStart(now - 25 * 60 * 60_000, MINUTE_BUCKET_MS);
        const range = {
          from: ancient,
          to: ancient,
          interval: MINUTE_BUCKET_MS,
        };

        await a.countWorkerJobs(q1, "w-kept", ancient, { completed: 1 });
        await a.countWorkerJobs(q1, "w-gone", ancient, { completed: 1 });
        await a.flushMetrics();

        // Whether an out-of-retention bucket is readable *before* the sweep is
        // the backend's own business, and the two answers are both correct: a
        // driver that prunes on a clock stores it until the sweep runs, while
        // one that expires by the store's own TTL — Redis writes an absolute
        // `PEXPIREAT` — never stores it at all, because the instant it belongs
        // to is already past. What the contract holds either way is the end
        // state below, so this only records which kind of backend this is.
        const storedFirst =
          (await a.getWorkerMetrics(q1, "w-kept", range)).jobs.length > 0;
        if (storedFirst) {
          expect((await a.getWorkerMetrics(q1, "w-gone", range)).jobs).toEqual([
            { at: ancient, completed: 1, failed: 0 },
          ]);
        }

        // A count far enough ahead that the prune is due again. The only case
        // here that writes a bucket in the future, and the reason none of the
        // others may: the clock it steps is one per process.
        const ahead = bucketStart(
          now + 10 * MINUTE_BUCKET_MS,
          MINUTE_BUCKET_MS,
        );
        await a.countWorkerJobs(q1, "w-kept", ahead, { completed: 1 });
        await a.flushMetrics();

        // Past the retention, so gone — including for `w-gone`, which nothing
        // has written to since. A prune driven by a series' own writes would
        // never have reached it.
        expect((await a.getWorkerMetrics(q1, "w-kept", range)).jobs).toEqual(
          [],
        );
        expect((await a.getWorkerMetrics(q1, "w-gone", range)).jobs).toEqual(
          [],
        );
        expect(
          (await a.getWorkerMetrics(q1, "w-kept", oneMinute(ahead))).jobs,
        ).toEqual([{ at: ahead, completed: 1, failed: 0 }]);
      });

      it("answers for a series it never counted, and for kinds it was not asked for", async () => {
        const a = analytics();
        if (!a) {
          return;
        }

        const ns1 = scope("an-unknown");
        const q1: QueueRef = { ns: ns1, queue: "orders" };
        const minute = lastMinute();
        const range = oneMinute(minute);

        // A worker, runner or queue the backend never counted for is not an
        // error — it reads the same as one that did nothing.
        expect((await a.getWorkerMetrics(q1, "nobody", range)).jobs).toEqual(
          [],
        );
        expect(
          (await a.getRunnerMetrics(ns1, runnerKey("nobody"), range)).runs,
        ).toEqual([]);
        expect(await a.getQueueMetrics(q1, range)).toEqual([]);

        const asked: NamespaceMetricsQuery = { ...range, kinds: ["jobs"] };
        const roll = await a.getNamespaceMetrics(ns1, asked);
        expect(roll.jobs).toEqual([]);
        // A kind nobody asked for is absent, never an array of zeros.
        expect(roll.runs).toBeUndefined();
        expect(roll.workerJobs).toBeUndefined();
      });
    });

    /* --- analytics: grouped reads ------------------------------------ */

    describe("analytics: grouped reads", () => {
      /**
       * The reads that answer many entities at once. Optional as a set: a
       * driver with none of them yet passes (it has only the per-entity
       * reads), a driver with some of them is unfinished and fails here.
       */
      const GROUPED_METHODS = [
        "getRunnerMetricsMany",
        "getRunnerMetricsTotals",
        "getWorkerMetricsMany",
        "getWorkerMetricsTotals",
      ] as const satisfies readonly (keyof JobsDriver)[];

      /**
       * The per-entity methods every case here also needs: the writes, and the
       * one-entity reads the grouped ones are compared against.
       */
      const PER_ENTITY_METHODS = [
        "countRunnerRun",
        "countWorkerJobs",
        "getMetricsSupport",
        "getRunnerMetrics",
        "getWorkerMetrics",
        "sampleWorkerBusyness",
      ] as const satisfies readonly (keyof JobsDriver)[];

      /** Both sets, bound, plus a flush that is a no-op without one. */
      type Grouped = Required<
        Pick<
          JobsDriver,
          (typeof GROUPED_METHODS)[number] | (typeof PER_ENTITY_METHODS)[number]
        >
      > & {
        /** Writes whatever the driver gathered in memory, or nothing. */
        flushMetrics: () => Promise<void>;
      };

      /** Namespaces these cases made, purged at the end and nothing else with them. */
      const scopes: string[] = [];

      afterAll(async () => {
        for (const scope of scopes) {
          await driver.purge(scope);
        }
      });

      /**
       * A namespace of this case's own. A grouped read is namespace-wide by
       * definition, so a shared one would have every case asserting the
       * others' entities too — and under `--randomize`, in a different order
       * every run.
       */
      function scope(name: string): string {
        const created = testNamespace(name);
        scopes.push(created);
        return created;
      }

      /**
       * The grouped methods, or `undefined` for a backend with none yet. A
       * backend with any of them must have all four, and the per-entity reads
       * beside them.
       */
      function grouped(): Grouped | undefined {
        const present = GROUPED_METHODS.filter(
          (method) => typeof driver[method] === "function",
        );

        if (present.length === 0) {
          return undefined;
        }

        expect(present).toEqual([...GROUPED_METHODS]);
        expect(
          PER_ENTITY_METHODS.filter(
            (method) => typeof driver[method] === "function",
          ),
        ).toEqual([...PER_ENTITY_METHODS]);

        return {
          countRunnerRun: driver.countRunnerRun!.bind(driver),
          countWorkerJobs: driver.countWorkerJobs!.bind(driver),
          getMetricsSupport: driver.getMetricsSupport!.bind(driver),
          getRunnerMetrics: driver.getRunnerMetrics!.bind(driver),
          getRunnerMetricsMany: driver.getRunnerMetricsMany!.bind(driver),
          getRunnerMetricsTotals: driver.getRunnerMetricsTotals!.bind(driver),
          getWorkerMetrics: driver.getWorkerMetrics!.bind(driver),
          getWorkerMetricsMany: driver.getWorkerMetricsMany!.bind(driver),
          getWorkerMetricsTotals: driver.getWorkerMetricsTotals!.bind(driver),
          sampleWorkerBusyness: driver.sampleWorkerBusyness!.bind(driver),
          flushMetrics: async () => {
            await driver.flushMetrics?.();
          },
        };
      }

      /** The start of the minute before last: two whole minutes, both past. */
      function twoMinutesAgo(): number {
        return bucketStart(Date.now() - 2 * MINUTE_BUCKET_MS, MINUTE_BUCKET_MS);
      }

      /** Both of those minutes, at minute width. */
      function twoMinutes(first: number): MetricsQuery {
        return {
          from: first,
          to: first + MINUTE_BUCKET_MS,
          interval: MINUTE_BUCKET_MS,
        };
      }

      /** Runner rows in a stable order: the contract leaves order open. */
      function byRunner<T extends { runner: string }>(rows: T[]): T[] {
        return [...rows].sort((a, b) => compareCodePoints(a.runner, b.runner));
      }

      /** Worker rows in a stable order. */
      function byWorker<T extends WorkerMetricsRef>(rows: T[]): T[] {
        return [...rows].sort(
          (a, b) =>
            compareCodePoints(a.queue, b.queue) ||
            compareCodePoints(a.key, b.key),
        );
      }

      it("totals every runner over a range in one read, each exactly what its own read sums to", async () => {
        const g = grouped();
        if (!g) {
          return;
        }

        const ns1 = scope("gr-runners");
        const elsewhere = scope("gr-runners-other");
        const first = twoMinutesAgo();
        const second = first + MINUTE_BUCKET_MS;
        const range = twoMinutes(first);
        const [a, b, c] = ["a", "b", "c"].map((id) => runnerKey(id));

        await g.countRunnerRun(ns1, a!, first + 1_000, { started: 2 });
        await g.countRunnerRun(ns1, a!, second + 1_000, {
          started: 1,
          succeeded: 2,
        });
        await g.countRunnerRun(ns1, b!, second + 5_000, {
          failed: 1,
          timeout: 1,
        });
        await g.countRunnerRun(ns1, c!, first + 9_000, { skipped: 3 });
        // Outside the range on both sides: counted, never totalled.
        await g.countRunnerRun(ns1, a!, first - MINUTE_BUCKET_MS, {
          started: 50,
        });
        await g.countRunnerRun(ns1, a!, second + MINUTE_BUCKET_MS, {
          started: 70,
        });
        // The same runner in another namespace.
        await g.countRunnerRun(elsewhere, a!, first + 1_000, { started: 9 });
        await g.flushMetrics();

        const rows = byRunner(await g.getRunnerMetricsTotals(ns1, range));

        // The numbers, written out: two minutes of each, nothing either side.
        expect(rows.map((row) => [row.runner, row.runs])).toEqual([
          [a, runsTotals({ started: 3, succeeded: 2 })],
          [b, runsTotals({ failed: 1, timeout: 1 })],
          [c, runsTotals({ skipped: 3 })],
        ]);
        // Nothing asked for durations, so no row carries them.
        expect(rows.every((row) => row.durations === undefined)).toBe(true);

        // And each row is exactly its own per-entity read, reduced — what a
        // backend summing in the engine is held to.
        for (const row of rows) {
          expect(row).toEqual({
            runner: row.runner,
            ...runnerTotalsOf(
              await g.getRunnerMetrics(ns1, row.runner, range),
            )!,
          });
        }
      });

      it("never reports the namespace roll-up as a runner or a worker", async () => {
        const g = grouped();
        if (!g) {
          return;
        }

        const ns1 = scope("gr-rollup");
        const q1: QueueRef = { ns: ns1, queue: "orders" };
        const first = twoMinutesAgo();
        const range = twoMinutes(first);

        await g.countRunnerRun(ns1, runnerKey("only"), first, { started: 1 });
        await g.countWorkerJobs(q1, "w-only", first, { completed: 1 });
        await g.flushMetrics();

        // The roll-up is stored as an entity like any other; it has the same
        // counts as the one runner, so a leak would be a second, equal row.
        const runners = await g.getRunnerMetricsTotals(ns1, range);
        expect(runners.map((row) => row.runner)).toEqual([runnerKey("only")]);

        const workers = await g.getWorkerMetricsTotals(ns1, range);
        expect(workers.map((row) => [row.queue, row.key])).toEqual([
          ["orders", "w-only"],
        ]);

        // Asked for by its empty name, a batch still does not answer it.
        expect(
          await g.getRunnerMetricsMany(ns1, [NAMESPACE_ENTITY], range),
        ).toEqual([]);
        expect(
          await g.getRunnerMetricsTotals(ns1, {
            ...range,
            runners: [NAMESPACE_ENTITY],
          }),
        ).toEqual([]);
      });

      it("totals every worker key over a range, by (queue, key), each what its own read sums to", async () => {
        const g = grouped();
        if (!g) {
          return;
        }

        const ns1 = scope("gr-workers");
        const orders: QueueRef = { ns: ns1, queue: "orders" };
        const mail: QueueRef = { ns: ns1, queue: "mail" };
        const first = twoMinutesAgo();
        const second = first + MINUTE_BUCKET_MS;
        const range = twoMinutes(first);

        await g.countWorkerJobs(orders, "w-1", first, { completed: 2 });
        await g.countWorkerJobs(orders, "w-1", second, {
          completed: 3,
          failed: 1,
        });
        // A key with a colon in it: the queue's name cannot hold one, so the
        // first colon still splits the pair the same way.
        await g.countWorkerJobs(orders, "host:7", second, { failed: 2 });
        // The same key on another queue is another series.
        await g.countWorkerJobs(mail, "w-1", first, { completed: 4 });
        await g.countWorkerJobs(mail, "w-1", first - MINUTE_BUCKET_MS, {
          completed: 40,
        });
        await g.flushMetrics();

        const rows = byWorker(await g.getWorkerMetricsTotals(ns1, range));

        expect(rows.map(({ queue, key, jobs }) => [queue, key, jobs])).toEqual([
          ["mail", "w-1", { completed: 4, failed: 0 }],
          ["orders", "host:7", { completed: 0, failed: 2 }],
          ["orders", "w-1", { completed: 5, failed: 1 }],
        ]);
        expect(rows.every((row) => row.busyness === undefined)).toBe(true);

        for (const row of rows) {
          expect(row).toEqual({
            queue: row.queue,
            key: row.key,
            ...workerTotalsOf(
              await g.getWorkerMetrics(
                { ns: ns1, queue: row.queue },
                row.key,
                range,
              ),
            )!,
          });
        }
      });

      it("honours a filter: an entity outside it is absent, and an empty one answers nothing", async () => {
        const g = grouped();
        if (!g) {
          return;
        }

        const ns1 = scope("gr-filter");
        const orders: QueueRef = { ns: ns1, queue: "orders" };
        const hidden: QueueRef = { ns: ns1, queue: "hidden" };
        const first = twoMinutesAgo();
        const range = twoMinutes(first);

        await g.countRunnerRun(ns1, runnerKey("seen"), first, { started: 1 });
        await g.countRunnerRun(ns1, runnerKey("unseen"), first, {
          started: 5,
        });
        await g.countWorkerJobs(orders, "w-1", first, { completed: 1 });
        await g.countWorkerJobs(hidden, "w-1", first, { completed: 8 });
        await g.countWorkerJobs(hidden, "w-2", first, { completed: 9 });
        await g.flushMetrics();

        // A runner filtered out is not a zero row — it is not there. A name in
        // the filter with nothing counted is not there either.
        const runners = await g.getRunnerMetricsTotals(ns1, {
          ...range,
          runners: [runnerKey("seen"), runnerKey("never-counted")],
        });
        expect(runners.map((row) => [row.runner, row.runs.started])).toEqual([
          [runnerKey("seen"), 1],
        ]);

        // A hidden queue's workers are not counted, whatever their key.
        const workers = await g.getWorkerMetricsTotals(ns1, {
          ...range,
          queues: ["orders", "never-seen"],
        });
        expect(
          workers.map(({ queue, key, jobs }) => [queue, key, jobs]),
        ).toEqual([["orders", "w-1", { completed: 1, failed: 0 }]]);

        // An empty filter is "none of them", never "no filter": a caller
        // allowed no queue must not fall through to every queue.
        expect(
          await g.getRunnerMetricsTotals(ns1, { ...range, runners: [] }),
        ).toEqual([]);
        expect(
          await g.getWorkerMetricsTotals(ns1, { ...range, queues: [] }),
        ).toEqual([]);

        // And without one, everything — which is what makes the two above a
        // filter rather than an empty namespace.
        expect(await g.getRunnerMetricsTotals(ns1, range)).toHaveLength(2);
        expect(await g.getWorkerMetricsTotals(ns1, range)).toHaveLength(3);
      });

      it("merges durations across buckets into one total per runner", async () => {
        const g = grouped();
        if (!g || !g.getMetricsSupport().recording.durations) {
          return;
        }

        const ns1 = scope("gr-durations");
        const first = twoMinutesAgo();
        const second = first + MINUTE_BUCKET_MS;
        const range = { ...twoMinutes(first), durations: true };
        const timed = runnerKey("timed");
        const untimed = runnerKey("untimed");
        const taken: [number, number][] = [
          [first + 1_000, 5],
          [first + 2_000, 900],
          [second + 1_000, 3],
          [second + 2_000, 40],
        ];

        for (const [at, durationMs] of taken) {
          await g.countRunnerRun(ns1, timed, at, { succeeded: 1, durationMs });
        }
        // Started, not finished: runs to report, no duration.
        await g.countRunnerRun(ns1, untimed, first, { started: 1 });
        await g.flushMetrics();

        const rows = byRunner(await g.getRunnerMetricsTotals(ns1, range));
        expect(rows.map((row) => row.runner)).toEqual([timed, untimed]);

        const histogram = emptyHistogram();
        for (const [, ms] of taken) {
          histogram[durationBin(ms)]!++;
        }
        // Count and sum add, the extremes are the extremes of both minutes,
        // and the histogram is bin-for-bin the sum.
        expect(rows[0]!.durations).toEqual({
          count: 4,
          sumMs: 5 + 900 + 3 + 40,
          minMs: 3,
          maxMs: 900,
          histogram,
        });
        expect(rows[0]!.durations).toEqual(
          totalDurationStats(
            (await g.getRunnerMetrics(ns1, timed, range)).durations ?? [],
          ),
        );
        // Asked for and recorded, so present on every row — empty here.
        expect(rows[1]!.durations).toEqual(emptyDurationStats());

        // Not asked for, not answered.
        const plain = await g.getRunnerMetricsTotals(ns1, twoMinutes(first));
        expect(plain.every((row) => row.durations === undefined)).toBe(true);
      });

      it("counts a worker that only reported busyness when busyness is asked for, and not otherwise", async () => {
        const g = grouped();
        if (!g || !g.getMetricsSupport().recording.workers) {
          return;
        }

        const ns1 = scope("gr-busyness");
        const q1: QueueRef = { ns: ns1, queue: "orders" };
        const first = twoMinutesAgo();
        const second = first + MINUTE_BUCKET_MS;
        const range = { ...twoMinutes(first), busyness: true };

        await g.sampleWorkerBusyness(q1, "idle", first + 10_000, {
          active: 0,
          concurrency: 4,
        });
        await g.sampleWorkerBusyness(q1, "busy", first + 10_000, {
          active: 3,
          concurrency: 4,
        });
        await g.sampleWorkerBusyness(q1, "busy", second + 10_000, {
          active: 1,
          concurrency: 8,
        });
        await g.countWorkerJobs(q1, "busy", second, { completed: 2 });
        await g.countWorkerJobs(q1, "silent", second, { completed: 1 });
        await g.flushMetrics();

        const rows = byWorker(await g.getWorkerMetricsTotals(ns1, range));
        expect(rows.map((row) => row.key)).toEqual(["busy", "idle", "silent"]);

        const [busy, idle, silent] = rows;
        // Merged across both minutes: the later sample's concurrency.
        expect(busy!.busyness).toEqual({
          samples: 2,
          activeSum: 4,
          activeMax: 3,
          concurrency: 8,
          lastAt: second + 10_000,
        });
        expect(busy!.jobs).toEqual({ completed: 2, failed: 0 });
        // Reporting but idle: a row, with no jobs.
        expect(idle!.jobs).toEqual({ completed: 0, failed: 0 });
        expect(idle!.busyness?.samples).toBe(1);
        // Counting but never sampled: present, `samples: 0`.
        expect(silent!.busyness).toEqual(emptyBusynessStats());

        for (const row of rows) {
          expect(row).toEqual({
            queue: row.queue,
            key: row.key,
            ...workerTotalsOf(await g.getWorkerMetrics(q1, row.key, range))!,
          });
        }

        // Without busyness there is nothing to report for the idle one.
        const plain = await g.getWorkerMetricsTotals(ns1, twoMinutes(first));
        expect(byWorker(plain).map((row) => row.key)).toEqual([
          "busy",
          "silent",
        ]);
      });

      it("reads a batch of runners' series in one call, each exactly its own read", async () => {
        const g = grouped();
        if (!g) {
          return;
        }

        const ns1 = scope("gr-runner-batch");
        const first = twoMinutesAgo();
        const second = first + MINUTE_BUCKET_MS;
        const durations = g.getMetricsSupport().recording.durations;
        const [a, b, c, quiet] = ["a", "b", "c", "quiet"].map((id) =>
          runnerKey(id),
        );

        await g.countRunnerRun(ns1, a!, first, { started: 1 });
        await g.countRunnerRun(ns1, a!, second, {
          succeeded: 1,
          durationMs: 20,
        });
        await g.countRunnerRun(ns1, b!, second, {
          failed: 1,
          durationMs: 7,
        });
        await g.countRunnerRun(ns1, c!, first, { started: 1 });
        // Only outside the range: nothing to answer inside it.
        await g.countRunnerRun(ns1, quiet!, first - MINUTE_BUCKET_MS, {
          started: 1,
        });
        await g.flushMetrics();

        const queries: RunnerMetricsQuery[] = [
          twoMinutes(first),
          { ...twoMinutes(first), durations: true },
        ];
        for (const query of queries) {
          // `c` is not asked for; `a` is asked for twice; `never` was never
          // counted and `quiet` not in range, so both are absent.
          const batch = byRunner(
            await g.getRunnerMetricsMany(
              ns1,
              [a!, b!, a!, quiet!, runnerKey("never")],
              query,
            ),
          );

          expect(batch.map((entry) => entry.runner)).toEqual([a, b]);
          for (const entry of batch) {
            expect(entry).toEqual({
              runner: entry.runner,
              ...(await g.getRunnerMetrics(ns1, entry.runner, query)),
            });
          }

          if (query.durations && durations) {
            expect(batch[0]!.durations).toHaveLength(1);
          } else if (!query.durations) {
            expect(batch.every((entry) => entry.durations === undefined)).toBe(
              true,
            );
          }
        }

        expect(
          await g.getRunnerMetricsMany(ns1, [], twoMinutes(first)),
        ).toEqual([]);
      });

      it("reads a batch of worker keys' series in one call, each exactly its own read", async () => {
        const g = grouped();
        if (!g) {
          return;
        }

        const ns1 = scope("gr-worker-batch");
        const orders: QueueRef = { ns: ns1, queue: "orders" };
        const mail: QueueRef = { ns: ns1, queue: "mail" };
        const first = twoMinutesAgo();
        const second = first + MINUTE_BUCKET_MS;

        await g.countWorkerJobs(orders, "w-1", first, { completed: 1 });
        await g.countWorkerJobs(orders, "w-1", second, { failed: 1 });
        await g.countWorkerJobs(mail, "w-1", second, { completed: 6 });
        await g.countWorkerJobs(orders, "w-2", second, { completed: 2 });
        await g.sampleWorkerBusyness(orders, "w-1", first + 5_000, {
          active: 1,
          concurrency: 2,
        });
        await g.flushMetrics();

        for (const query of [
          twoMinutes(first),
          { ...twoMinutes(first), busyness: true },
        ]) {
          const batch = byWorker(
            await g.getWorkerMetricsMany(
              ns1,
              [
                { queue: "orders", key: "w-1" },
                { queue: "mail", key: "w-1" },
                { queue: "orders", key: "w-1" },
                { queue: "orders", key: "never" },
              ],
              query,
            ),
          );

          // `orders/w-2` was not asked for; `orders/never` has nothing.
          expect(batch.map(({ queue, key }) => [queue, key])).toEqual([
            ["mail", "w-1"],
            ["orders", "w-1"],
          ]);
          for (const entry of batch) {
            expect(entry).toEqual({
              queue: entry.queue,
              key: entry.key,
              ...(await g.getWorkerMetrics(
                { ns: ns1, queue: entry.queue },
                entry.key,
                query,
              )),
            });
          }
          expect(batch[1]!.jobs).toEqual([
            { at: first, completed: 1, failed: 0 },
            { at: second, completed: 0, failed: 1 },
          ]);
        }

        expect(
          await g.getWorkerMetricsMany(ns1, [], twoMinutes(first)),
        ).toEqual([]);
      });
    });

    /* --- jobs -------------------------------------------------------- */

    describe("jobs", () => {
      /**
       * A queue of this case's own, named after it.
       *
       * Nearly every claim here is untargeted — `claimJob` takes whatever the
       * queue offers next — and several cases leave a job behind, so two
       * sharing a queue have one claiming the other's leftovers in whatever
       * order the runner picked. They all live in `ns`, which `afterAll`
       * purges.
       */
      function scope(name: string): QueueRef {
        return { ns, queue: `jobs-${name}` };
      }

      it("adds idempotently on the id", async () => {
        const q = scope("add-idempotent");
        await driver.ensureQueue(q);
        const job = makeJob({ id: "dupe", data: { first: true } });

        const first = await driver.addJob(q, job);
        expect(first.added).toBe(true);

        const second = await driver.addJob(
          q,
          makeJob({ id: "dupe", data: { second: true } }),
        );
        expect(second.added).toBe(false);
        expect(second.job.data).toEqual({ first: true });

        await driver.removeJob(q, "dupe");
      });

      it("survives an id taken between the look and the write", async () => {
        const q = scope("add-contended");
        // The SQL driver asks which ids exist and then inserts plainly,
        // because `ON CONFLICT DO NOTHING` costs 43% of the statement. That
        // leaves a window: another producer can take one of those ids in
        // between, and the insert — one statement — then lands none of it.
        //
        // Two batches sharing an id, issued at once, is that window. Whichever
        // loses has to recover rather than fail, and between them each id must
        // be reported added exactly once.
        const shared = makeJob({ id: "contended", data: { from: "first" } });

        const [first, second] = await Promise.all([
          driver.addJobs(q, [makeJob({ id: "only-first" }), shared]),
          driver.addJobs(q, [
            makeJob({ id: "contended", data: { from: "second" } }),
            makeJob({ id: "only-second" }),
          ]),
        ]);

        // Every job is there, whichever call won the contended one.
        for (const id of ["only-first", "contended", "only-second"]) {
          expect((await driver.getJob(q, id))?.id).toBe(id);
        }

        // And exactly one caller is told it added the contended id — that is
        // what repeat scheduling reads to decide whether it won.
        const claims = [...first, ...second].filter(
          (r) => r.job.id === "contended" && r.added,
        );
        expect(claims).toHaveLength(1);

        for (const id of ["only-first", "contended", "only-second"]) {
          await driver.removeJob(q, id);
        }
      });

      it("round-trips every field of a fully populated record", async () => {
        const q = scope("populated");
        // Several drivers write only the fields a brand-new job carries and
        // let the reader treat absent as default — it is a large part of why
        // enqueue is fast. That makes the *other* shape the untested one: a
        // record restored from elsewhere, added already finished, or mid-retry
        // has to survive the trip with every field intact.
        //
        // Distinct values throughout, because two fields sharing one would let
        // a swap between them pass.
        const populated = makeJob({
          id: "populated",
          name: "populated-name",
          data: { which: "data" },
          state: "completed",
          priority: 7,
          runAt: 1_700_000_001_000,
          createdAt: 1_700_000_002_000,
          processedOn: 1_700_000_003_000,
          finishedOn: 1_700_000_004_000,
          expiresAt: 1_700_000_005_000,
          attemptsMade: 3,
          maxAttempts: 9,
          stalledCount: 2,
          progress: { which: "progress" },
          returnValue: { which: "returnValue" },
          failedReason: { name: "Error", message: "failedReason" },
          stacktrace: [{ name: "Error", message: "stacktrace" }],
          lockToken: "token-value",
          lockExpiresAt: 1_700_000_006_000,
          workerId: "worker-value",
          repeatKey: "repeat-value",
        });

        expect((await driver.addJob(q, populated)).added).toBe(true);
        expect(await driver.getJob(q, "populated")).toEqual(populated);

        // And a brand-new one, which is the shape that omits fields, has to
        // read back with the defaults rather than with holes in it.
        const bare = makeJob({ id: "bare" });
        expect((await driver.addJob(q, bare)).added).toBe(true);
        expect(await driver.getJob(q, "bare")).toEqual(bare);

        await driver.removeJob(q, "populated");
        await driver.removeJob(q, "bare");
      });

      it("reports per job which of a batch were new", async () => {
        const q = scope("batch-added");
        // `addJobs` is used throughout this suite to seed jobs, but what it
        // *returns* was never checked anywhere — and a batch has to answer the
        // same question the singular path does, per job and in order, because
        // repeat scheduling reads exactly that to decide whether it won the
        // race to schedule an occurrence.
        const existing = await driver.addJob(
          q,
          makeJob({ id: "batch-taken", data: { stored: true } }),
        );
        expect(existing.added).toBe(true);

        const results = await driver.addJobs(q, [
          makeJob({ id: "batch-new-1" }),
          makeJob({ id: "batch-taken", data: { replacement: true } }),
          makeJob({ id: "batch-new-2" }),
        ]);

        // In order, and one entry per job given — a driver that returns only
        // the rows it inserted would line the answers up against the wrong
        // jobs.
        expect(results.map((r) => r.job.id)).toEqual([
          "batch-new-1",
          "batch-taken",
          "batch-new-2",
        ]);
        expect(results.map((r) => r.added)).toEqual([true, false, true]);

        // A duplicate is ignored, not overwritten, and comes back with what is
        // actually stored rather than what was offered.
        expect(results[1]!.job.data).toEqual({ stored: true });

        // The ones it claimed to add are really there.
        expect((await driver.getJob(q, "batch-new-1"))?.id).toBe("batch-new-1");
        expect((await driver.getJob(q, "batch-new-2"))?.id).toBe("batch-new-2");

        for (const id of ["batch-taken", "batch-new-1", "batch-new-2"]) {
          await driver.removeJob(q, id);
        }
      });

      it("claims in priority then FIFO order, exactly once each", async () => {
        const q = scope("claim-order");
        const now = Date.now();
        await driver.addJobs(q, [
          makeJob({ id: "normal-1", priority: 0, createdAt: now, runAt: now }),
          makeJob({
            id: "normal-2",
            priority: 0,
            createdAt: now + 1,
            runAt: now,
          }),
          makeJob({
            id: "urgent",
            priority: -5,
            createdAt: now + 2,
            runAt: now,
          }),
        ]);

        const claimed: string[] = [];
        for (let i = 0; i < 3; i++) {
          const job = await driver.claimJob(q, {
            workerId: "w1",
            token: newToken(),
            lockMs: 5000,
            now: now + 10,
          });
          if (job) {
            claimed.push(job.id);
          }
        }

        expect(claimed).toEqual(["urgent", "normal-1", "normal-2"]);
        // Nothing is left to claim: each job went to exactly one caller.
        expect(
          await driver.claimJob(q, {
            workerId: "w2",
            token: newToken(),
            lockMs: 5000,
            now: now + 10,
          }),
        ).toBeNull();

        await driver.drainQueue(q, true);
        for (const id of claimed) {
          await driver.failJob(
            q,
            id,
            (await driver.getJob(q, id))?.lockToken ?? "",
            serializeError(new Error("cleanup")),
            { retry: false, retention: true },
            now,
            1,
          );
        }
      });

      it("keeps a job's data, progress and return value when they are strings", async () => {
        const q = scope("stringly");
        const now = Date.now();
        const token = newToken();
        // Plain strings, the empty one, and one that is itself valid JSON:
        // each must come back as the same string, not null or a number.
        await driver.addJob(
          q,
          makeJob({ id: "stringly", data: "done", runAt: now }),
        );
        expect((await driver.getJob(q, "stringly"))?.data).toBe("done");

        await driver.claimJob(q, { workerId: "w1", token, lockMs: 1000, now });
        expect(await driver.updateProgress(q, "stringly", "42")).toBe(true);
        expect((await driver.getJob(q, "stringly"))?.progress).toBe("42");

        await driver.completeJob(q, "stringly", token, "", false, now);
        const done = await driver.getJob(q, "stringly");
        expect(done?.state).toBe("completed");
        expect(done?.returnValue).toBe("");
        expect(done?.data).toBe("done");

        await driver.removeJob(q, "stringly");
      });

      it("round-trips every JSON value exactly, on every write path", async () => {
        // A string that is itself JSON text is the dangerous case: a driver
        // that decodes one time too many turns `"42"` into `42`, and one that
        // decodes a plain string like `"warm"` throws and falls back to null.
        // Which write path runs is decided by timing in production — a lone
        // completion goes out singly, a burst as one batch — and the bulk and
        // singular inserts are separate statements too, so every value goes
        // through each of them.
        const values: { label: string; value: unknown }[] = [
          { label: "plain", value: "warm" },
          { label: "spaced", value: "report x" },
          { label: "numeric", value: "42" },
          { label: "null-text", value: "null" },
          { label: "empty", value: "" },
          { label: "quoted", value: '"quoted"' },
          { label: "true-text", value: "true" },
          { label: "object-text", value: '{"a":1}' },
          {
            label: "nested",
            value: {
              a: "42",
              b: "null",
              c: ["true", '"q"', "", 7, null, false],
              d: { e: "warm", f: '{"g":1}' },
            },
          },
          { label: "number", value: 42 },
          { label: "boolean", value: false },
          { label: "null", value: null },
          { label: "absent", value: undefined },
        ];
        // `undefined` is not JSON: every driver stores it as null.
        const expected = (value: unknown) => value ?? null;
        const rq: QueueRef = { ns, queue: "json-roundtrip" };
        const now = Date.now();
        await driver.ensureQueue(rq);

        // Three copies of each value: one completed singly, one in a batch
        // that keeps the job, one in a batch with a TTL.
        const paths = ["single", "batch", "ttl"] as const;
        const cases = paths.flatMap((path) =>
          values.map(({ label, value }) => ({
            path,
            id: `${path}-${label}`,
            value,
          })),
        );
        const jobs = cases.map(({ id, value }, index) =>
          makeJob({ id, data: value, runAt: now, createdAt: now + index }),
        );

        // The bulk insert takes the "single" copies and the singular insert the
        // rest — each is its own statement on the SQL engines.
        const bulk = jobs.filter((job) => job.id.startsWith("single-"));
        const oneByOne = jobs.filter((job) => !job.id.startsWith("single-"));
        expect((await driver.addJobs(rq, bulk)).every((r) => r.added)).toBe(
          true,
        );
        for (const job of oneByOne) {
          expect((await driver.addJob(rq, job)).added).toBe(true);
        }

        // And the "ttl" copies' data is rewritten in place, which is a third
        // write path for it.
        if (driver.updateJob) {
          for (const { path, id, value } of cases) {
            if (path === "ttl") {
              expect(
                (await driver.updateJob(rq, id, { data: value }, now))?.data,
              ).toEqual(expected(value));
            }
          }
        }

        // One token for every claim, so a batch can settle them together.
        const token = newToken();
        for (let claimed = 0; claimed < jobs.length; claimed++) {
          expect(
            await driver.claimJob(rq, {
              workerId: "w1",
              token,
              lockMs: 60_000,
              now,
            }),
          ).not.toBeNull();
        }

        for (const { path, id, value } of cases) {
          if (path === "single") {
            expect(await driver.updateProgress(rq, id, value)).toBe(true);
            expect(
              await driver.completeJob(rq, id, token, value, false, now),
            ).toBe(true);
          }
        }

        for (const path of ["batch", "ttl"] as const) {
          const completions = cases
            .filter((one) => one.path === path)
            .map(({ id, value }) => ({
              id,
              result: value,
              retention: path === "ttl" ? { ttl: 60_000 } : false,
            }));

          if (driver.completeJobs) {
            expect(
              (await driver.completeJobs(rq, token, completions, now)).sort(),
            ).toEqual(completions.map((one) => one.id).sort());
            continue;
          }

          for (const one of completions) {
            expect(
              await driver.completeJob(
                rq,
                one.id,
                token,
                one.result,
                one.retention,
                now,
              ),
            ).toBe(true);
          }
        }

        // One object per job, so a failure names it. `toEqual` compares types
        // (`"42"` is not `42`), and the `typeof`s make that explicit.
        for (const { path, id, value } of cases) {
          const stored = await driver.getJob(rq, id);
          const want = expected(value);
          expect({
            id,
            state: stored?.state,
            data: stored?.data,
            dataType: typeof stored?.data,
            returnValue: stored?.returnValue,
            returnType: typeof stored?.returnValue,
            ...(path === "single"
              ? {
                  progress: stored?.progress,
                  progressType: typeof stored?.progress,
                }
              : {}),
          }).toEqual({
            id,
            state: "completed",
            data: want,
            dataType: typeof want,
            returnValue: want,
            returnType: typeof want,
            ...(path === "single"
              ? { progress: want, progressType: typeof want }
              : {}),
          });
        }

        for (const { id } of cases) {
          await driver.removeJob(rq, id);
        }
      });

      it("stamps the claim on the job", async () => {
        const q = scope("claim-stamp");
        const now = Date.now();
        const token = newToken();
        await driver.addJob(q, makeJob({ id: "stamped", runAt: now }));

        const job = await driver.claimJob(q, {
          workerId: "worker-7",
          token,
          lockMs: 1000,
          now,
        });

        expect(job).toMatchObject({
          id: "stamped",
          state: "active",
          attemptsMade: 1,
          workerId: "worker-7",
          lockToken: token,
          processedOn: now,
          lockExpiresAt: now + 1000,
        });

        await driver.completeJob(q, "stamped", token, null, true, now);
      });

      it("lists delayed jobs by when they are due, not when they were added", async () => {
        const q = scope("delayed-order");
        const now = Date.now();
        await driver.addJobs(q, [
          makeJob({
            id: "due-last",
            state: "delayed",
            createdAt: now - 3,
            runAt: now + 30_000,
          }),
          makeJob({
            id: "due-first",
            state: "delayed",
            createdAt: now - 2,
            runAt: now + 10_000,
          }),
          makeJob({
            id: "due-middle",
            state: "delayed",
            createdAt: now - 1,
            runAt: now + 20_000,
          }),
        ]);

        const ids = async (order: "asc" | "desc") =>
          (
            await driver.listJobs(q, ["delayed"], {
              offset: 0,
              limit: 10,
              order,
            })
          ).map((job) => job.id);

        expect(await ids("asc")).toEqual([
          "due-first",
          "due-middle",
          "due-last",
        ]);
        expect(await ids("desc")).toEqual([
          "due-last",
          "due-middle",
          "due-first",
        ]);
        await driver.drainQueue(q, true);
      });

      it("does not claim a job before its runAt", async () => {
        const q = scope("runat");
        const now = Date.now();
        await driver.addJob(
          q,
          makeJob({ id: "later", state: "delayed", runAt: now + 60_000 }),
        );

        expect(
          await driver.claimJob(q, {
            workerId: "w1",
            token: newToken(),
            lockMs: 1000,
            now,
          }),
        ).toBeNull();

        expect(await driver.nextDelayedAt(q)).toBe(now + 60_000);

        // Due is not enough: a claim does not promote, because promotion is
        // the worker's maintenance and `maintenance: false` turns it off.
        expect(
          await driver.claimJob(q, {
            workerId: "w1",
            token: newToken(),
            lockMs: 1000,
            now: now + 60_001,
          }),
        ).toBeNull();

        // Once due, promotion makes it claimable.
        expect(
          (await promotion(driver.promoteDelayed(q, now + 60_001, 10)))
            .promoted,
        ).toBe(1);
        const claimed = await driver.claimJob(q, {
          workerId: "w1",
          token: newToken(),
          lockMs: 1000,
          now: now + 60_001,
        });
        expect(claimed?.id).toBe("later");

        await driver.completeJob(
          q,
          "later",
          claimed?.lockToken ?? "",
          null,
          true,
          now,
        );
      });

      it("completes only for the lock holder", async () => {
        const q = scope("complete-holder");
        const now = Date.now();
        const token = newToken();
        await driver.addJob(q, makeJob({ id: "complete-me", runAt: now }));
        await driver.claimJob(q, {
          workerId: "w1",
          token,
          lockMs: 1000,
          now,
        });

        expect(
          await driver.completeJob(
            q,
            "complete-me",
            newToken(),
            { ok: true },
            false,
            now,
          ),
        ).toBe(false);
        expect(
          await driver.completeJob(
            q,
            "complete-me",
            token,
            { ok: true },
            false,
            now,
          ),
        ).toBe(true);

        const job = await driver.getJob(q, "complete-me");
        expect(job).toMatchObject({
          state: "completed",
          returnValue: { ok: true },
          finishedOn: now,
          lockToken: null,
        });

        await driver.removeJob(q, "complete-me");
      });

      describe("promoteDelayed reports the next due time", () => {
        /**
         * Promotes, and checks the answer's `nextDueAt` against what
         * `nextDelayedAt` says straight afterwards: the two must agree, since
         * the worker uses the first in place of the second.
         */
        async function promoteAt(
          q: QueueRef,
          now: number,
          limit = 100,
        ): Promise<PromoteDelayedResult> {
          const result = await promotion(driver.promoteDelayed(q, now, limit));
          expect(result.nextDueAt).toBe(await driver.nextDelayedAt(q));
          return result;
        }

        it("is null when nothing is scheduled", async () => {
          const q = scope("next-due-none");
          const now = Date.now();
          await driver.ensureQueue(q);
          expect(await promoteAt(q, now)).toEqual({
            promoted: 0,
            nextDueAt: null,
          });

          // A waiting job is not scheduled either.
          await driver.addJob(q, makeJob({ id: "ready", runAt: now }));
          expect(await promoteAt(q, now)).toEqual({
            promoted: 0,
            nextDueAt: null,
          });
          await driver.drainQueue(q, true);
        });

        it("is the earliest runAt left, delayed or retrying, and null once all are promoted", async () => {
          const q = scope("next-due-left");
          const now = Date.now();
          await driver.addJob(
            q,
            makeJob({ id: "due", state: "delayed", runAt: now - 10 }),
          );
          await driver.addJob(
            q,
            makeJob({ id: "late", state: "delayed", runAt: now + 60_000 }),
          );
          await driver.addJob(
            q,
            makeJob({ id: "mid", state: "delayed", runAt: now + 30_000 }),
          );

          // A retry is scheduled too, in the `failed` state: it counts.
          const token = newToken();
          await driver.addJob(q, makeJob({ id: "retry", runAt: now }));
          expect(
            (
              await driver.claimJob(q, {
                workerId: "w1",
                token,
                lockMs: 30_000,
                now,
              })
            )?.id,
          ).toBe("retry");
          await driver.failJob(
            q,
            "retry",
            token,
            serializeError(new Error("again")),
            { retry: true, runAt: now + 20_000 },
            now,
            3,
          );

          // Nothing due yet but the one: the retry is next.
          expect(await promoteAt(q, now)).toEqual({
            promoted: 1,
            nextDueAt: now + 20_000,
          });
          // Nothing more due: the same answer, and nothing moved.
          expect(await promoteAt(q, now + 1)).toEqual({
            promoted: 0,
            nextDueAt: now + 20_000,
          });
          expect(await promoteAt(q, now + 20_000)).toEqual({
            promoted: 1,
            nextDueAt: now + 30_000,
          });
          expect(await promoteAt(q, now + 60_000)).toEqual({
            promoted: 2,
            nextDueAt: null,
          });
          await driver.drainQueue(q, true);
        });

        it("is at or before now when the limit left due jobs behind", async () => {
          const q = scope("next-due-limit");
          const now = Date.now();
          for (const [id, at] of [
            ["first", now - 30],
            ["second", now - 20],
            ["third", now - 10],
          ] as const) {
            await driver.addJob(
              q,
              makeJob({ id, state: "delayed", runAt: at }),
            );
          }

          const first = await promoteAt(q, now, 2);
          expect(first.promoted).toBe(2);
          expect(first.nextDueAt).toBe(now - 10);

          expect(await promoteAt(q, now, 2)).toEqual({
            promoted: 1,
            nextDueAt: null,
          });
          await driver.drainQueue(q, true);
        });

        it("answers the same on a paused queue", async () => {
          const q = scope("next-due-paused");
          const now = Date.now();
          await driver.addJob(
            q,
            makeJob({ id: "due", state: "delayed", runAt: now - 10 }),
          );
          await driver.addJob(
            q,
            makeJob({ id: "later", state: "delayed", runAt: now + 60_000 }),
          );
          await driver.pauseQueue(q);

          // Pausing stops claims, not promotion: the due job moves to
          // `waiting`, where it stays until the queue resumes.
          expect(await promoteAt(q, now)).toEqual({
            promoted: 1,
            nextDueAt: now + 60_000,
          });

          await driver.resumeQueue(q);
          await driver.drainQueue(q, true);
        });
      });

      it("keeps a retrying job separate from a dead one", async () => {
        const q = scope("retry-vs-dead");
        const now = Date.now();
        const failure = serializeError(new Error("nope"));

        const retryToken = newToken();
        await driver.addJob(q, makeJob({ id: "retry-me", runAt: now }));
        await driver.claimJob(q, {
          workerId: "w1",
          token: retryToken,
          lockMs: 1000,
          now,
        });
        await driver.failJob(
          q,
          "retry-me",
          retryToken,
          failure,
          { retry: true, runAt: now + 30_000 },
          now,
          3,
        );

        const retrying = await driver.getJob(q, "retry-me");
        expect(retrying).toMatchObject({
          state: "failed",
          runAt: now + 30_000,
          finishedOn: null,
          attemptsMade: 1,
        });
        expect(retrying?.failedReason?.message).toBe("nope");
        expect(retrying?.stacktrace).toHaveLength(1);

        const deadToken = newToken();
        await driver.addJob(q, makeJob({ id: "dead-me", runAt: now }));
        await driver.claimJob(q, {
          workerId: "w1",
          token: deadToken,
          lockMs: 1000,
          now,
        });
        await driver.failJob(
          q,
          "dead-me",
          deadToken,
          failure,
          { retry: false, retention: false },
          now,
          3,
        );

        expect(await driver.getJob(q, "dead-me")).toMatchObject({
          state: "dead",
          finishedOn: now,
        });

        await driver.removeJob(q, "retry-me");
        await driver.removeJob(q, "dead-me");
      });

      it("extends a lock for its holder only", async () => {
        const q = scope("lock-extend");
        const now = Date.now();
        const token = newToken();
        await driver.addJob(q, makeJob({ id: "heartbeat", runAt: now }));
        await driver.claimJob(q, {
          workerId: "w1",
          token,
          lockMs: 500,
          now,
        });

        expect(
          await driver.extendJobLock(q, "heartbeat", newToken(), 5000, now),
        ).toBe(false);
        expect(
          await driver.extendJobLock(q, "heartbeat", token, 5000, now),
        ).toBe(true);
        expect((await driver.getJob(q, "heartbeat"))?.lockExpiresAt).toBe(
          now + 5000,
        );

        await driver.completeJob(q, "heartbeat", token, null, true, now);
      });

      it("recovers a stalled job, then buries it", async () => {
        const q = scope("stalled");
        const now = Date.now();
        await driver.addJob(q, makeJob({ id: "stalls", runAt: now }));
        await driver.claimJob(q, {
          workerId: "gone",
          token: newToken(),
          lockMs: 10,
          now,
        });

        const first = await driver.recoverStalled(q, now + 1000, 1, 10);
        expect(first.requeued).toEqual(["stalls"]);
        expect((await driver.getJob(q, "stalls"))?.stalledCount).toBe(1);

        await driver.claimJob(q, {
          workerId: "gone",
          token: newToken(),
          lockMs: 10,
          now: now + 1000,
        });
        const second = await driver.recoverStalled(q, now + 2000, 1, 10);
        expect(second.dead).toEqual(["stalls"]);
        expect((await driver.getJob(q, "stalls"))?.state).toBe("dead");

        await driver.removeJob(q, "stalls");
      });

      it("refuses to remove an active job", async () => {
        const q = scope("remove-active");
        const now = Date.now();
        const token = newToken();
        await driver.addJob(q, makeJob({ id: "busy", runAt: now }));
        await driver.claimJob(q, {
          workerId: "w1",
          token,
          lockMs: 5000,
          now,
        });

        expect(await driver.removeJob(q, "busy")).toBe(false);

        await driver.completeJob(q, "busy", token, null, true, now);
      });

      it("retries and promotes finished jobs on request", async () => {
        const q = scope("revive");
        const now = Date.now();
        const token = newToken();
        await driver.addJob(q, makeJob({ id: "revive", runAt: now }));
        await driver.claimJob(q, { workerId: "w1", token, lockMs: 100, now });
        await driver.failJob(
          q,
          "revive",
          token,
          serializeError(new Error("x")),
          { retry: false, retention: false },
          now,
          1,
        );

        expect(await driver.retryJob(q, "revive", true, now)).toBe(true);
        expect(await driver.getJob(q, "revive")).toMatchObject({
          state: "waiting",
          attemptsMade: 0,
        });

        await driver.removeJob(q, "revive");

        await driver.addJob(
          q,
          makeJob({ id: "hurry", state: "delayed", runAt: now + 60_000 }),
        );
        expect(await driver.promoteJob(q, "hurry", now)).toBe(true);
        expect((await driver.getJob(q, "hurry"))?.state).toBe("waiting");
        await driver.removeJob(q, "hurry");
      });

      it("counts and lists by state", async () => {
        const q = scope("counts");
        const now = Date.now();

        await driver.addJobs(q, [
          makeJob({ id: "c1", runAt: now }),
          makeJob({ id: "c2", runAt: now }),
          makeJob({ id: "c3", state: "delayed", runAt: now + 10_000 }),
        ]);

        const counts = await driver.countJobs(q);
        expect(counts.waiting).toBe(2);
        expect(counts.delayed).toBe(1);

        const waiting = await driver.listJobs(q, ["waiting"], {
          offset: 0,
          limit: 10,
          order: "asc",
        });
        expect(waiting.map((job) => job.id)).toEqual(["c1", "c2"]);

        const page = await driver.listJobs(q, ["waiting"], {
          offset: 1,
          limit: 1,
          order: "asc",
        });
        expect(page.map((job) => job.id)).toEqual(["c2"]);

        const descending = await driver.listJobs(q, ["waiting"], {
          offset: 0,
          limit: 10,
          order: "desc",
        });
        expect(descending.map((job) => job.id)).toEqual(["c2", "c1"]);
      });

      // `job.touch()` and `job.extendLock()` — or either and the worker's
      // heartbeat — landing in the same millisecond write the same expiry. On
      // MySQL and MariaDB that matched-but-unchanged row used to count as 0, so
      // the second answered false and a heartbeat aborted a live job.
      it("answers true for an extension or progress write that changes nothing", async () => {
        const q = scope("same-value");
        const now = Date.now();
        const token = newToken();
        await driver.addJob(q, makeJob({ id: "same", runAt: now }));
        await driver.claimJob(q, { workerId: "w1", token, lockMs: 500, now });

        expect(await driver.extendJobLock(q, "same", token, 5000, now)).toBe(
          true,
        );
        expect(await driver.extendJobLock(q, "same", token, 5000, now)).toBe(
          true,
        );
        expect(
          await driver.extendJobLock(q, "same", newToken(), 5000, now),
        ).toBe(false);
        expect((await driver.getJob(q, "same"))?.lockExpiresAt).toBe(
          now + 5000,
        );

        expect(await driver.updateProgress(q, "same", { pct: 50 })).toBe(true);
        expect(await driver.updateProgress(q, "same", { pct: 50 })).toBe(true);
        expect(await driver.updateProgress(q, "same", 7)).toBe(true);
        expect(await driver.updateProgress(q, "same", 7)).toBe(true);
        expect((await driver.getJob(q, "same"))?.progress).toBe(7);

        // Once the lock is gone, the same write is refused again.
        expect(
          await driver.completeJob(q, "same", token, null, true, now),
        ).toBe(true);
        expect(await driver.extendJobLock(q, "same", token, 5000, now)).toBe(
          false,
        );
        expect(await driver.updateProgress(q, "same-missing", 7)).toBe(false);
      });

      it("records progress", async () => {
        const q = scope("progress");
        const now = Date.now();
        await driver.addJob(q, makeJob({ id: "progressive", runAt: now }));

        expect(await driver.updateProgress(q, "progressive", 42)).toBe(true);
        expect((await driver.getJob(q, "progressive"))?.progress).toBe(42);
        expect(await driver.updateProgress(q, "missing", 1)).toBe(false);

        await driver.removeJob(q, "progressive");
      });

      it("pauses claiming across the queue", async () => {
        const q = scope("pause");
        const now = Date.now();
        await driver.addJob(q, makeJob({ id: "paused-job", runAt: now }));

        await driver.pauseQueue(q);
        expect(await driver.isQueuePaused(q)).toBe(true);
        expect(
          await driver.claimJob(q, {
            workerId: "w1",
            token: newToken(),
            lockMs: 1000,
            now,
          }),
        ).toBeNull();

        await driver.resumeQueue(q);
        expect(await driver.isQueuePaused(q)).toBe(false);
        const claimed = await driver.claimJob(q, {
          workerId: "w1",
          token: newToken(),
          lockMs: 1000,
          now,
        });
        expect(claimed?.id).toBe("paused-job");

        await driver.completeJob(
          q,
          "paused-job",
          claimed?.lockToken ?? "",
          null,
          true,
          now,
        );
      });

      it("drains, cleans and prunes", async () => {
        const q = scope("drain");
        const now = Date.now();

        await driver.addJobs(q, [
          makeJob({ id: "d1", runAt: now }),
          makeJob({ id: "d2", state: "delayed", runAt: now + 10_000 }),
        ]);

        expect(await driver.drainQueue(q, false)).toBe(1);
        expect((await driver.countJobs(q)).delayed).toBe(1);
        expect(await driver.drainQueue(q, true)).toBe(1);

        await driver.addJob(
          q,
          makeJob({
            id: "old",
            state: "completed",
            createdAt: now - 100_000,
            finishedOn: now - 100_000,
          }),
        );
        expect(await driver.cleanJobs(q, "completed", 50_000, 10, now)).toEqual(
          ["old"],
        );

        // Age, not due time: a job due in a minute but created long ago is old.
        await driver.addJobs(q, [
          makeJob({
            id: "old-delayed",
            state: "delayed",
            createdAt: now - 100_000,
            runAt: now + 60_000,
          }),
          makeJob({
            id: "new-delayed",
            state: "delayed",
            createdAt: now,
            runAt: now + 60_000,
          }),
          makeJob({
            id: "old-failed",
            state: "failed",
            createdAt: now - 200_000,
            finishedOn: now - 100_000,
            runAt: now + 60_000,
          }),
        ]);
        expect(await driver.cleanJobs(q, "delayed", 50_000, 10, now)).toEqual([
          "old-delayed",
        ]);
        expect(await driver.cleanJobs(q, "failed", 50_000, 10, now)).toEqual([
          "old-failed",
        ]);
        expect(await driver.getJob(q, "new-delayed")).not.toBeNull();
        await driver.drainQueue(q, true);

        await driver.addJob(
          q,
          makeJob({
            id: "expiring",
            state: "completed",
            finishedOn: now,
            expiresAt: now + 1000,
          }),
        );
        expect(await driver.pruneExpired(q, now, 10)).toBe(0);
        expect(await driver.pruneExpired(q, now + 2000, 10)).toBe(1);
        expect(await driver.getJob(q, "expiring")).toBeNull();
      });

      it("applies retention on completion", async () => {
        const q = scope("retention");
        const now = Date.now();

        const removeToken = newToken();
        await driver.addJob(q, makeJob({ id: "gone-now", runAt: now }));
        await driver.claimJob(q, {
          workerId: "w1",
          token: removeToken,
          lockMs: 1000,
          now,
        });
        await driver.completeJob(q, "gone-now", removeToken, null, true, now);
        expect(await driver.getJob(q, "gone-now")).toBeNull();

        const ttlToken = newToken();
        await driver.addJob(q, makeJob({ id: "ttl", runAt: now }));
        await driver.claimJob(q, {
          workerId: "w1",
          token: ttlToken,
          lockMs: 1000,
          now,
        });
        await driver.completeJob(q, "ttl", ttlToken, null, { ttl: 5000 }, now);
        expect((await driver.getJob(q, "ttl"))?.expiresAt).toBe(now + 5000);

        await driver.drainQueue(q, true);
        await driver.cleanJobs(q, "completed", 0, 100, now + 1);
      });

      it("stores repeat definitions", async () => {
        const q = scope("repeats");
        const now = Date.now();
        const definition = {
          key: "nightly",
          name: "report",
          data: {},
          opts: makeJob().opts,
          cron: "0 3 * * *",
          count: 0,
          nextRunAt: now + 1000,
          nextJobId: "repeat:nightly:1",
          createdAt: now,
          updatedAt: now,
        };

        await driver.upsertRepeat(q, definition);
        expect(await driver.getRepeat(q, "nightly")).toMatchObject({
          key: "nightly",
          cron: "0 3 * * *",
        });
        expect(await driver.listRepeats(q)).toHaveLength(1);

        await driver.upsertRepeat(q, { ...definition, count: 1 });
        expect((await driver.getRepeat(q, "nightly"))?.count).toBe(1);

        expect(await driver.removeRepeat(q, "nightly")).toBe(true);
        expect(await driver.getRepeat(q, "nightly")).toBeNull();
      });

      /* --- changing a stored job ---------------------------------------- */

      /** Claims whatever is due in `ref`, with a fresh token. */
      async function claimFrom(ref: QueueRef, now: number) {
        const token = newToken();
        const job = await driver.claimJob(ref, {
          workerId: "w1",
          token,
          lockMs: 30_000,
          now,
        });
        return { job, token };
      }

      it("updateJob replaces data, and answers with the job as it now is", async () => {
        const uq: QueueRef = { ns, queue: "update-data" };
        const now = Date.now();
        await driver.addJob(
          uq,
          makeJob({ id: "patched", runAt: now, data: { v: 1 } }),
        );

        const updated = await driver.updateJob!(
          uq,
          "patched",
          { data: { v: 2, list: [1, 2] } },
          now,
        );

        expect(updated?.data).toEqual({ v: 2, list: [1, 2] });
        expect(updated?.state).toBe("waiting");
        expect((await driver.getJob(uq, "patched"))?.data).toEqual({
          v: 2,
          list: [1, 2],
        });
        expect(
          await driver.updateJob!(uq, "missing", { data: 1 }, now),
        ).toBeNull();

        await driver.drainQueue(uq, true);
      });

      it("updateJob with a new priority reorders what is claimed next", async () => {
        const uq: QueueRef = { ns, queue: "update-priority" };
        const now = Date.now();
        await driver.addJob(
          uq,
          makeJob({ id: "first-in", runAt: now, createdAt: now, priority: 5 }),
        );
        await driver.addJob(
          uq,
          makeJob({
            id: "second-in",
            runAt: now,
            createdAt: now + 1,
            priority: 5,
          }),
        );

        const updated = await driver.updateJob!(
          uq,
          "second-in",
          { priority: 1 },
          now,
        );
        expect(updated?.priority).toBe(1);
        expect((await driver.getJob(uq, "second-in"))?.priority).toBe(1);

        expect((await claimFrom(uq, now)).job?.id).toBe("second-in");
        expect((await claimFrom(uq, now)).job?.id).toBe("first-in");

        await driver.drainQueue(uq, true);
      });

      it("updateJob moves runAt between waiting and delayed, and refuses anything else", async () => {
        const uq: QueueRef = { ns, queue: "update-runat" };
        const now = Date.now();
        await driver.addJob(uq, makeJob({ id: "moved", runAt: now }));

        // Into the future: delayed, not claimable, not promoted early.
        const later = await driver.updateJob!(
          uq,
          "moved",
          { runAt: now + 60_000 },
          now,
        );
        expect(later?.state).toBe("delayed");
        expect(later?.runAt).toBe(now + 60_000);
        expect((await claimFrom(uq, now)).job).toBeNull();
        expect(
          (await promotion(driver.promoteDelayed(uq, now, 10))).promoted,
        ).toBe(0);
        expect(await driver.nextDelayedAt(uq)).toBe(now + 60_000);

        // Back to now: waiting, claimable without a promotion pass.
        const sooner = await driver.updateJob!(
          uq,
          "moved",
          { runAt: now },
          now,
        );
        expect(sooner?.state).toBe("waiting");
        expect(await driver.nextDelayedAt(uq)).toBeNull();

        const { job } = await claimFrom(uq, now);
        expect(job?.id).toBe("moved");

        // Active: its due time is no longer the queue's to move.
        expect(
          await driver.updateJob!(uq, "moved", { runAt: now + 5_000 }, now),
        ).toBeNull();
        expect((await driver.getJob(uq, "moved"))?.state).toBe("active");

        await driver.drainQueue(uq, true);
      });

      it("updateJob checks onlyIn in the same step as the write", async () => {
        const uq: QueueRef = { ns, queue: "update-onlyin" };
        const now = Date.now();
        await driver.addJob(
          uq,
          makeJob({ id: "guarded", runAt: now, data: { v: 1 } }),
        );
        await claimFrom(uq, now);

        const pending: ("waiting" | "delayed")[] = ["waiting", "delayed"];
        expect(
          await driver.updateJob!(
            uq,
            "guarded",
            { data: { v: 2 }, onlyIn: pending },
            now,
          ),
        ).toBeNull();
        expect((await driver.getJob(uq, "guarded"))?.data).toEqual({ v: 1 });

        // Without the guard, data may change on an active job.
        const changed = await driver.updateJob!(
          uq,
          "guarded",
          { data: { v: 3 } },
          now,
        );
        expect(changed?.data).toEqual({ v: 3 });
        expect(changed?.state).toBe("active");

        await driver.drainQueue(uq, true);
      });

      /* --- burying a job from outside its processor --------------------- */

      /** What every `buryJob` below is given, unless it says otherwise. */
      const buryOpts = { retention: false, keepStacktraces: 5 } as const;

      it("buryJob buries a waiting, delayed, retry-pending or waiting-children job", async () => {
        const bq: QueueRef = { ns, queue: "bury-pending" };
        const now = Date.now();
        const error = serializeError(new Error("given up on"));
        const earlier = serializeError(new Error("an earlier attempt"));

        const children: JobFlow = {
          parent: null,
          children: [{ queue: bq.queue, id: "absent-child" }],
          pending: 1,
          values: {},
          failures: {},
          recorded: false,
        };
        await driver.addJobs(bq, [
          makeJob({ id: "b-waiting", runAt: now }),
          makeJob({ id: "b-delayed", state: "delayed", runAt: now + 60_000 }),
          makeJob({
            id: "b-failed",
            state: "failed",
            runAt: now + 60_000,
            attemptsMade: 1,
            maxAttempts: 3,
            failedReason: earlier,
            stacktrace: [earlier],
          }),
          makeJob({
            id: "b-parent",
            state: "waiting-children",
            runAt: now,
            flow: children,
          }),
        ]);

        for (const id of ["b-waiting", "b-delayed", "b-failed", "b-parent"]) {
          const buried = await driver.buryJob!(bq, id, error, buryOpts, now);
          expect(buried).toMatchObject({
            id,
            state: "dead",
            finishedOn: now,
            lockToken: null,
            lockExpiresAt: null,
            workerId: null,
          });
          expect(buried?.failedReason?.message).toBe("given up on");
          expect(buried?.stacktrace[0]?.message).toBe("given up on");
          expect(await driver.getJob(bq, id)).toMatchObject({
            state: "dead",
            finishedOn: now,
          });
        }

        // No attempt ran, so none is counted; earlier failures stay behind
        // the new one.
        const failed = await driver.getJob(bq, "b-failed");
        expect(failed?.attemptsMade).toBe(1);
        expect(failed?.stacktrace.map((entry) => entry.message)).toEqual([
          "given up on",
          "an earlier attempt",
        ]);

        const counts = await driver.countJobs(bq);
        expect(counts.dead).toBe(4);
        expect(counts.waiting + counts.delayed + counts.failed).toBe(0);
        expect(counts["waiting-children"]).toBe(0);

        // Out of every index a claim or a promotion reads.
        expect(
          (await promotion(driver.promoteDelayed(bq, now + 120_000, 100)))
            .promoted,
        ).toBe(0);
        expect((await claimFrom(bq, now + 120_000)).job).toBeNull();
        expect(
          (
            await driver.listJobs(bq, ["dead"], {
              offset: 0,
              limit: 10,
              order: "asc",
            })
          ).map((job) => job.id),
        ).toHaveLength(4);

        await driver.cleanJobs(bq, "dead", 0, 100, now + 1);
      });

      it("buryJob buries an active job only under its lock, and its holder then loses it", async () => {
        const bq: QueueRef = { ns, queue: "bury-active" };
        const now = Date.now();
        const error = serializeError(new Error("stop"));
        await driver.addJob(bq, makeJob({ id: "running", runAt: now }));
        const { job, token } = await claimFrom(bq, now);
        expect(job?.state).toBe("active");

        // Without the lock, or under another, an active job is left alone.
        expect(await driver.buryJob!(bq, "running", error, buryOpts, now)).toBe(
          null,
        );
        expect(
          await driver.buryJob!(
            bq,
            "running",
            error,
            { ...buryOpts, token: newToken() },
            now,
          ),
        ).toBeNull();
        expect((await driver.getJob(bq, "running"))?.state).toBe("active");

        const buried = await driver.buryJob!(
          bq,
          "running",
          error,
          { ...buryOpts, token },
          now,
        );
        expect(buried).toMatchObject({
          state: "dead",
          attemptsMade: 1,
          lockToken: null,
        });

        // The worker that held it can neither renew nor settle it now.
        expect(
          await driver.extendJobLock(bq, "running", token, 1_000, now),
        ).toBe(false);
        expect(
          await driver.completeJob(bq, "running", token, "late", false, now),
        ).toBe(false);
        expect(
          await driver.failJob(
            bq,
            "running",
            token,
            error,
            { retry: true, runAt: now },
            now,
            5,
          ),
        ).toBe(false);
        expect(await driver.getJob(bq, "running")).toMatchObject({
          state: "dead",
          returnValue: null,
        });

        // Nor does the stalled sweep see an active job to recover.
        const swept = await driver.recoverStalled(bq, now + 60_000, 1, 10);
        expect([...swept.requeued, ...swept.dead]).toEqual([]);

        await driver.cleanJobs(bq, "dead", 0, 100, now + 1);
      });

      it("buryJob leaves a finished or missing job alone", async () => {
        const bq: QueueRef = { ns, queue: "bury-finished" };
        const now = Date.now();
        const error = serializeError(new Error("too late"));
        await driver.addJobs(bq, [
          makeJob({ id: "done", state: "completed", finishedOn: now }),
          makeJob({ id: "gone", state: "dead", finishedOn: now }),
        ]);

        for (const id of ["done", "gone", "never-added"]) {
          expect(await driver.buryJob!(bq, id, error, buryOpts, now)).toBe(
            null,
          );
        }
        expect((await driver.getJob(bq, "done"))?.state).toBe("completed");
        expect((await driver.getJob(bq, "gone"))?.failedReason).toBeNull();

        await driver.cleanJobs(bq, "completed", 0, 100, now + 1);
        await driver.cleanJobs(bq, "dead", 0, 100, now + 1);
      });

      it("buryJob applies retention and the stacktrace cap, and leaves a child's outcome undelivered", async () => {
        const bq: QueueRef = { ns, queue: "bury-retention" };
        const now = Date.now();
        const error = serializeError(new Error("buried"));
        const earlier = serializeError(new Error("earlier"));
        await driver.addJobs(bq, [
          makeJob({ id: "removed", runAt: now }),
          makeJob({ id: "ttl", runAt: now }),
          makeJob({
            id: "capped",
            state: "failed",
            runAt: now + 60_000,
            stacktrace: [earlier, earlier],
          }),
          makeJob({
            id: "child",
            runAt: now,
            flow: {
              parent: { queue: "elsewhere", id: "parent" },
              children: [],
              pending: 0,
              values: {},
              failures: {},
              recorded: false,
            },
          }),
        ]);

        // Removed at once, and still answered with, as it was buried.
        const removed = await driver.buryJob!(
          bq,
          "removed",
          error,
          { ...buryOpts, retention: true },
          now,
        );
        expect(removed).toMatchObject({ id: "removed", state: "dead" });
        expect(await driver.getJob(bq, "removed")).toBeNull();

        const ttl = await driver.buryJob!(
          bq,
          "ttl",
          error,
          { ...buryOpts, retention: { ttl: 5_000 } },
          now,
        );
        expect(ttl?.expiresAt).toBe(now + 5_000);
        expect((await driver.getJob(bq, "ttl"))?.expiresAt).toBe(now + 5_000);

        const capped = await driver.buryJob!(
          bq,
          "capped",
          error,
          { ...buryOpts, keepStacktraces: 2 },
          now,
        );
        expect(capped?.stacktrace.map((entry) => entry.message)).toEqual([
          "buried",
          "earlier",
        ]);

        // A flow child's outcome still has to reach its parent, which is how
        // maintenance finds it.
        await driver.buryJob!(bq, "child", error, buryOpts, now);
        expect((await driver.getJob(bq, "child"))?.flow?.recorded).toBe(false);

        await driver.markChildRecorded?.(bq, "child", true, now);
        await driver.cleanJobs(bq, "dead", 0, 100, now + 1);
      });

      it("buryJob counts one failure in the minute's throughput", async () => {
        if (!driver.getThroughput) {
          return;
        }

        const bq: QueueRef = { ns, queue: "bury-throughput" };
        const minute = throughputBucket(Date.now()) - 7 * THROUGHPUT_BUCKET_MS;
        const error = serializeError(new Error("counted"));
        await driver.addJobs(bq, [
          makeJob({ id: "t1", createdAt: minute, runAt: minute }),
          makeJob({ id: "t2", createdAt: minute, runAt: minute }),
        ]);

        await driver.buryJob!(bq, "t1", error, buryOpts, minute + 10);
        // Refused — already dead — and so not counted.
        await driver.buryJob!(bq, "t1", error, buryOpts, minute + 20);
        await driver.buryJob!(bq, "t2", error, buryOpts, minute + 30);

        expect(
          await driver.getThroughput(bq, { from: minute, to: minute }),
        ).toEqual([{ at: minute, completed: 0, failed: 2 }]);
      });

      it("keeps a job's log in order, capped, and paged", async () => {
        const lq: QueueRef = { ns, queue: "logs" };
        const now = Date.now();
        await driver.addJob(lq, makeJob({ id: "logged", runAt: now }));

        for (let line = 1; line <= 5; line++) {
          expect(await driver.addJobLog!(lq, "logged", `line ${line}`, 0)).toBe(
            line,
          );
        }

        expect(
          await driver.getJobLogs!(lq, "logged", {
            offset: 0,
            limit: 10,
            order: "asc",
          }),
        ).toEqual({
          logs: ["line 1", "line 2", "line 3", "line 4", "line 5"],
          count: 5,
        });
        expect(
          await driver.getJobLogs!(lq, "logged", {
            offset: 1,
            limit: 2,
            order: "desc",
          }),
        ).toEqual({ logs: ["line 4", "line 3"], count: 5 });

        // A cap keeps the most recent lines.
        expect(await driver.addJobLog!(lq, "logged", "line 6", 3)).toBe(3);
        expect(
          await driver.getJobLogs!(lq, "logged", {
            offset: 0,
            limit: 10,
            order: "asc",
          }),
        ).toEqual({ logs: ["line 4", "line 5", "line 6"], count: 3 });

        // Lines are kept verbatim, whatever they contain.
        const awkward = 'quote " pipe | newline \n tab \t unicode ✓';
        await driver.addJobLog!(lq, "logged", awkward, 0);
        const [last] = (
          await driver.getJobLogs!(lq, "logged", {
            offset: 0,
            limit: 1,
            order: "desc",
          })
        ).logs;
        expect(last).toBe(awkward);

        // No job, no log.
        expect(await driver.addJobLog!(lq, "no-such-job", "lost", 0)).toBe(0);
        expect(
          await driver.getJobLogs!(lq, "no-such-job", {
            offset: 0,
            limit: 10,
            order: "asc",
          }),
        ).toEqual({ logs: [], count: 0 });

        await driver.drainQueue(lq, true);
      });

      it("a log goes with its job, however the job goes", async () => {
        const lq: QueueRef = { ns, queue: "log-lifetime" };
        const page = { offset: 0, limit: 10, order: "asc" as const };
        const now = Date.now();

        /** Adds a job with one log line, runs `remove`, re-adds the same id. */
        async function survivesRemoval(
          id: string,
          remove: () => Promise<unknown>,
          state: Partial<{ runAt: number }> = {},
        ) {
          // Both jobs are created in the same millisecond, deliberately. A
          // driver that tells the two apart by `createdAt` passes this only
          // when the clock happens to tick between them — and a job completed
          // and re-added under its id inside one millisecond is ordinary.
          await driver.addJob(
            lq,
            makeJob({ id, runAt: now, createdAt: now, ...state }),
          );
          await driver.addJobLog!(lq, id, `before ${id}`, 0);
          await remove();
          expect(await driver.getJob(lq, id)).toBeNull();

          // The same id, added again, is a new job with a new log.
          await driver.addJob(
            lq,
            makeJob({ id, createdAt: now, runAt: now + 3_600_000 }),
          );
          expect(await driver.getJobLogs!(lq, id, page)).toEqual({
            logs: [],
            count: 0,
          });
          await driver.removeJob(lq, id);
        }

        await survivesRemoval("log-removed", async () => {
          await driver.removeJob(lq, "log-removed");
        });

        await survivesRemoval("log-drained", () => driver.drainQueue(lq, true));

        await survivesRemoval("log-completed", async () => {
          const { job, token } = await claimFrom(lq, now);
          expect(job?.id).toBe("log-completed");
          // Retention `true` deletes on completion: the hot path.
          await driver.completeJob(lq, "log-completed", token, null, true, now);
        });

        await survivesRemoval("log-cleaned", async () => {
          const { token } = await claimFrom(lq, now);
          await driver.completeJob(lq, "log-cleaned", token, null, false, now);
          await driver.cleanJobs(lq, "completed", 0, 100, now + 1);
        });

        await survivesRemoval("log-expired", async () => {
          const { token } = await claimFrom(lq, now);
          await driver.completeJob(
            lq,
            "log-expired",
            token,
            null,
            { ttl: 1 },
            now,
          );
          await driver.pruneExpired(lq, now + 1_000, 100);
        });

        await driver.drainQueue(lq, true);
      });

      /* --- skipping names, and state for limits ------------------------- */

      it("skips excluded names on a single claim, taking what comes next", async () => {
        const xq: QueueRef = { ns, queue: "exclude-one" };
        const now = Date.now();
        await driver.drainQueue(xq, true);

        // The excluded name is at the head of the queue, twice.
        await driver.addJob(
          xq,
          makeJob({
            id: "x-capped-1",
            name: "capped",
            runAt: now,
            createdAt: now,
          }),
        );
        await driver.addJob(
          xq,
          makeJob({
            id: "x-capped-2",
            name: "capped",
            runAt: now,
            createdAt: now + 1,
          }),
        );
        await driver.addJob(
          xq,
          makeJob({
            id: "x-free",
            name: "free",
            runAt: now,
            createdAt: now + 2,
          }),
        );

        const claim = (excludeNames?: string[]) =>
          driver.claimJob(xq, {
            workerId: "w1",
            token: newToken(),
            lockMs: 30_000,
            now,
            excludeNames,
          });

        expect((await claim(["capped"]))?.id).toBe("x-free");
        // Nothing else is claimable while the only remaining name is excluded.
        expect(await claim(["capped"])).toBeNull();
        // And they are still there, in order, once it is not.
        expect((await claim([]))?.id).toBe("x-capped-1");
        expect((await claim())?.id).toBe("x-capped-2");

        await driver.drainQueue(xq, true);
      });

      it("skips excluded names on a batch claim too", async () => {
        const xq: QueueRef = { ns, queue: "exclude-many" };
        const now = Date.now();
        await driver.drainQueue(xq, true);

        const names = ["a", "b", "a", "c", "a", "b"];
        for (const [index, name] of names.entries()) {
          await driver.addJob(
            xq,
            makeJob({
              id: `xm-${index}`,
              name,
              runAt: now,
              createdAt: now + index,
            }),
          );
        }

        const options = {
          workerId: "w1",
          token: newToken(),
          lockMs: 30_000,
          now,
          excludeNames: ["a", "c"],
        };
        const claimed = driver.claimJobs
          ? await driver.claimJobs(xq, options, 10)
          : [
              await driver.claimJob(xq, options),
              await driver.claimJob(xq, options),
            ];

        expect(
          claimed.filter((job) => job !== null).map((job) => job!.id),
        ).toEqual(["xm-1", "xm-5"]);

        await driver.drainQueue(xq, true);
      });

      it("reaches jobs behind a block of excluded ones, however long", async () => {
        const xq: QueueRef = { ns, queue: "exclude-pileup" };
        const now = Date.now();
        await driver.drainQueue(xq, true);

        // Far more capped jobs at the head than any one claim should look at.
        const pile = 2_500;
        await driver.addJobs(
          xq,
          Array.from({ length: pile }, (_, index) => {
            return makeJob({
              id: `pile-${index}`,
              name: "capped",
              runAt: now,
              createdAt: now + index,
            });
          }),
        );
        await driver.addJob(
          xq,
          makeJob({
            id: "behind-the-pile",
            name: "free",
            runAt: now,
            createdAt: now + pile + 1,
          }),
        );

        const claim = async () =>
          await driver.claimJob(xq, {
            workerId: "w1",
            token: newToken(),
            lockMs: 30_000,
            now,
            excludeNames: ["capped"],
          });

        // A driver may look at a bounded window per claim, but each claim has
        // to make progress: the job behind the pile comes out within a few.
        let found: JobRecord | null = null;
        for (let attempt = 0; attempt < 8 && !found; attempt++) {
          found = await claim();
        }
        expect(found?.id).toBe("behind-the-pile");

        // A new job at the head is still seen promptly, however far into the
        // pile the last claims looked.
        await driver.addJob(
          xq,
          makeJob({
            id: "new-at-the-head",
            name: "free",
            runAt: now,
            createdAt: now - 1,
          }),
        );

        let head: JobRecord | null = null;
        for (let attempt = 0; attempt < 3 && !head; attempt++) {
          head = await claim();
        }
        expect(head?.id).toBe("new-at-the-head");

        // Nothing capped was taken along the way.
        expect((await driver.countJobs(xq)).active).toBe(2);

        await driver.drainQueue(xq, true);
      }, 120_000);

      it("compare-and-sets queue state, and refuses a stale version", async () => {
        const sq: QueueRef = { ns, queue: "queue-state" };

        expect(await driver.getQueueState!(sq, "limiter")).toBeNull();

        // Created only when absent.
        const first = await driver.setQueueState!(
          sq,
          "limiter",
          { holders: {}, list: [1, 2] },
          null,
        );
        expect(first).toBeGreaterThanOrEqual(1);
        expect(
          await driver.setQueueState!(sq, "limiter", { racing: true }, null),
        ).toBeNull();

        expect(await driver.getQueueState!(sq, "limiter")).toEqual({
          value: { holders: {}, list: [1, 2] },
          version: first!,
        });

        // Replaced only at the version read.
        const second = await driver.setQueueState!(
          sq,
          "limiter",
          { count: 1 },
          first,
        );
        expect(second).toBeGreaterThan(first!);
        expect(
          await driver.setQueueState!(sq, "limiter", { count: 99 }, first),
        ).toBeNull();
        expect((await driver.getQueueState!(sq, "limiter"))?.value).toEqual({
          count: 1,
        });

        // Names are independent, and so are queues and namespaces.
        expect(await driver.getQueueState!(sq, "other")).toBeNull();
        expect(
          await driver.getQueueState!(
            { ns, queue: "queue-state-2" },
            "limiter",
          ),
        ).toBeNull();
        expect(
          await driver.getQueueState!(
            { ns: other, queue: "queue-state" },
            "limiter",
          ),
        ).toBeNull();

        // Deleted only at the version read, and then absent.
        expect(
          await driver.setQueueState!(sq, "limiter", null, first),
        ).toBeNull();
        expect(await driver.setQueueState!(sq, "limiter", null, second)).toBe(
          0,
        );
        expect(await driver.getQueueState!(sq, "limiter")).toBeNull();
      });

      it("lists queue state names by prefix, in order, a page at a time", async () => {
        const sq: QueueRef = { ns, queue: "queue-state-list" };
        const names = [
          "debounce:b",
          "debounce:a",
          "debounce:c",
          "throttle:a",
          "limiter",
        ];

        for (const name of names) {
          await driver.setQueueState!(sq, name, { name }, null);
        }
        // Another queue and another namespace, with matching names.
        await driver.setQueueState!(
          { ns, queue: "queue-state-list-2" },
          "debounce:z",
          {},
          null,
        );
        await driver.setQueueState!(
          { ns: other, queue: "queue-state-list" },
          "debounce:y",
          {},
          null,
        );

        expect(
          await driver.listQueueState!(sq, { prefix: "debounce:", limit: 10 }),
        ).toEqual(["debounce:a", "debounce:b", "debounce:c"]);
        expect(
          await driver.listQueueState!(sq, { prefix: "debounce:", limit: 2 }),
        ).toEqual(["debounce:a", "debounce:b"]);
        expect(
          await driver.listQueueState!(sq, {
            prefix: "debounce:",
            after: "debounce:b",
            limit: 10,
          }),
        ).toEqual(["debounce:c"]);
        expect(
          await driver.listQueueState!(sq, { prefix: "", limit: 10 }),
        ).toEqual([
          "debounce:a",
          "debounce:b",
          "debounce:c",
          "limiter",
          "throttle:a",
        ]);

        // A deleted entry is not listed.
        const entry = await driver.getQueueState!(sq, "debounce:b");
        await driver.setQueueState!(sq, "debounce:b", null, entry!.version);
        expect(
          await driver.listQueueState!(sq, { prefix: "debounce:", limit: 10 }),
        ).toEqual(["debounce:a", "debounce:c"]);

        // Prefixes are literal: nothing that merely looks like a pattern.
        await driver.setQueueState!(sq, "a%b_c*d", {}, null);
        expect(
          await driver.listQueueState!(sq, { prefix: "a%b_", limit: 10 }),
        ).toEqual(["a%b_c*d"]);
        expect(
          await driver.listQueueState!(sq, { prefix: "a_", limit: 10 }),
        ).toEqual([]);
      });

      it("lists queue state in code-point order, whatever the characters", async () => {
        const sq: QueueRef = { ns, queue: "queue-state-codepoints" };
        // Accented, private-use, the last BMP character and an emoji: the
        // characters where byte order, code-unit order and collations disagree.
        const names = ["\u{1F600}", "\uFFFF", "z", "é", "\uE000", "Y", "b"];

        for (const name of names) {
          await driver.setQueueState!(sq, name, { name }, null);
        }

        const ordered = ["Y", "b", "z", "é", "\uE000", "\uFFFF", "\u{1F600}"];
        expect(
          await driver.listQueueState!(sq, { prefix: "", limit: 20 }),
        ).toEqual(ordered);

        // Paging agrees with the order across every boundary.
        const paged: string[] = [];
        let after: string | undefined;
        for (;;) {
          const page = await driver.listQueueState!(sq, {
            prefix: "",
            limit: 2,
            ...(after !== undefined ? { after } : {}),
          });
          paged.push(...page);
          if (page.length < 2) {
            break;
          }
          after = page.at(-1);
        }
        expect(paged).toEqual(ordered);

        for (const name of names) {
          const entry = await driver.getQueueState!(sq, name);
          await driver.setQueueState!(sq, name, null, entry!.version);
        }
      });

      it("keeps ids and names that differ only by case or accent apart", async () => {
        const now = Date.now();
        const variants = ["Report", "report", "REPORT", "résumé", "resume"];

        // Job ids: each is its own job, not a duplicate of another.
        const cq: QueueRef = { ns, queue: "case-sensitive" };
        for (const id of variants) {
          const { added } = await driver.addJob(
            cq,
            makeJob({ id, state: "delayed", runAt: now + 60_000 }),
          );
          expect(added).toBe(true);
        }
        for (const id of variants) {
          expect((await driver.getJob(cq, id))?.id).toBe(id);
        }
        expect((await driver.countJobs(cq)).delayed).toBe(variants.length);

        // Queue state names.
        for (const name of variants) {
          expect(await driver.setQueueState!(cq, name, { name }, null)).toBe(1);
        }
        for (const name of variants) {
          expect((await driver.getQueueState!(cq, name))?.value).toEqual({
            name,
          });
        }

        // Queue names that differ only by case are different queues.
        const upper: QueueRef = { ns, queue: "Mail" };
        const lower: QueueRef = { ns, queue: "mail" };
        await driver.addJob(
          upper,
          makeJob({ id: "shared", state: "delayed", runAt: now + 60_000 }),
        );
        expect(
          (
            await driver.addJob(
              lower,
              makeJob({ id: "shared", state: "delayed", runAt: now + 60_000 }),
            )
          ).added,
        ).toBe(true);
        expect((await driver.countJobs(upper)).delayed).toBe(1);
        expect((await driver.countJobs(lower)).delayed).toBe(1);

        for (const name of variants) {
          const entry = await driver.getQueueState!(cq, name);
          await driver.setQueueState!(cq, name, null, entry!.version);
        }
        await driver.drainQueue(cq, true);
        await driver.drainQueue(upper, true);
        await driver.drainQueue(lower, true);
      });

      it("lets exactly one of many concurrent compare-and-sets win", async () => {
        const sq: QueueRef = { ns, queue: "queue-state-race" };
        const base = await driver.setQueueState!(sq, "counter", { n: 0 }, null);

        const results = await Promise.all(
          Array.from({ length: 16 }, async (_, index) => {
            return await driver.setQueueState!(
              sq,
              "counter",
              { n: index + 1 },
              base,
            );
          }),
        );

        expect(results.filter((version) => version !== null)).toHaveLength(1);
        await driver.setQueueState!(
          sq,
          "counter",
          null,
          (await driver.getQueueState!(sq, "counter"))!.version,
        );
      });

      it("keeps the same queue name in two namespaces apart", async () => {
        const mine: QueueRef = { ns, queue: "shared-name" };
        const theirs: QueueRef = { ns: other, queue: "shared-name" };
        const now = Date.now();

        await driver.addJob(mine, makeJob({ id: "same-id", runAt: now }));
        await driver.addJob(theirs, makeJob({ id: "same-id", runAt: now }));

        await driver.pauseQueue(mine);
        expect(await driver.isQueuePaused(theirs)).toBe(false);

        const claimed = await driver.claimJob(theirs, {
          workerId: "w1",
          token: newToken(),
          lockMs: 1000,
          now,
        });
        expect(claimed?.id).toBe("same-id");
        // Ours is paused, so nothing may be claimed from it.
        expect(
          await driver.claimJob(mine, {
            workerId: "w1",
            token: newToken(),
            lockMs: 1000,
            now,
          }),
        ).toBeNull();

        await driver.resumeQueue(mine);
        await driver.drainQueue(mine, true);
      });
    });

    /* --- flows ------------------------------------------------------- */

    describe("flows", () => {
      /** The queue a case's parents live in — the same name in every case. */
      const PARENTS_QUEUE = "flow-parents";

      /** The queue a case's children live in — the same name in every case. */
      const CHILDREN_QUEUE = "flow-children";

      /** Namespaces these cases made, purged at the end and nothing else with them. */
      const scopes: string[] = [];

      afterAll(async () => {
        for (const scope of scopes) {
          await driver.purge(scope);
        }
      });

      /**
       * The parent and child queues of this case's own, in a namespace of its
       * own.
       *
       * A namespace rather than a queue name, because a parent's stored values
       * and failures are keyed `<queue>:<id>` and the assertions name those
       * keys — so the queue names stay fixed and the namespace is what keeps
       * one case's jobs out of another's. It has to be kept apart somehow:
       * several cases end with a parent left active, which no drain removes
       * and `removeJob` refuses, so a shared queue would have every later
       * count, list and drain reading those too.
       */
      function scope(name: string): { parents: QueueRef; children: QueueRef } {
        const created = testNamespace(name);
        scopes.push(created);
        return {
          parents: { ns: created, queue: PARENTS_QUEUE },
          children: { ns: created, queue: CHILDREN_QUEUE },
        };
      }

      /** A flow value, with only what a test cares about given. */
      const flowOf = (overrides: Partial<JobFlow>): JobFlow => ({
        parent: null,
        children: [],
        pending: 0,
        values: {},
        failures: {},
        recorded: false,
        ...overrides,
      });

      /** A child reference in the children queue. */
      const child = (id: string): JobRef => ({ queue: CHILDREN_QUEUE, id });

      /** A parent waiting on the named children. */
      const parent = (
        id: string,
        childIds: string[],
        extra: Partial<JobRecord> = {},
      ) =>
        makeJob({
          id,
          state: "waiting-children",
          flow: flowOf({
            children: childIds.map(child),
            pending: childIds.length,
          }),
          ...extra,
        });

      const completed = (value: unknown): ChildOutcome => ({
        completed: true,
        value,
      });

      const failed = (message: string, ignored = false): ChildOutcome => ({
        completed: false,
        error: serializeError(new Error(message)),
        ignored,
      });

      const claim = async (queue: QueueRef, now = Date.now()) =>
        await driver.claimJob(queue, {
          workerId: "w1",
          token: newToken(),
          lockMs: 1000,
          now,
        });

      it("keeps a parent waiting on children out of claims, and counts, lists and drains it", async () => {
        const { parents } = scope("flow-held");
        await driver.ensureQueue(parents);
        await driver.addJob(parents, parent("held", ["a", "b"]));

        expect(await claim(parents)).toBeNull();
        expect((await driver.countJobs(parents))["waiting-children"]).toBe(1);
        expect(
          (
            await driver.listJobs(parents, ["waiting-children"], {
              offset: 0,
              limit: 10,
              order: "asc",
            })
          ).map((job) => job.id),
        ).toEqual(["held"]);

        expect(await driver.drainQueue(parents, true)).toBe(1);
        expect((await driver.countJobs(parents))["waiting-children"]).toBe(0);
      });

      it("records completed children once each, and releases the parent after the last", async () => {
        const { parents } = scope("flow-gather");
        await driver.addJob(parents, parent("gather", ["a", "b"]));

        expect(
          await driver.recordChild!(
            parents,
            "gather",
            child("a"),
            completed(1),
            Date.now(),
          ),
        ).toBe("recorded");
        // Recording the same child again changes nothing.
        expect(
          await driver.recordChild!(
            parents,
            "gather",
            child("a"),
            completed(1),
            Date.now(),
          ),
        ).toBe("already");

        const midway = await driver.getJob(parents, "gather");
        expect(midway?.state).toBe("waiting-children");
        expect(midway?.flow?.pending).toBe(1);
        expect(midway?.flow?.values).toEqual({ "flow-children:a": 1 });
        expect(await claim(parents)).toBeNull();

        expect(
          await driver.recordChild!(
            parents,
            "gather",
            child("b"),
            completed({ total: 2 }),
            Date.now(),
          ),
        ).toBe("released");

        const released = await driver.getJob(parents, "gather");
        expect(released?.state).toBe("waiting");
        expect(released?.flow?.pending).toBe(0);
        expect(released?.flow?.values).toEqual({
          "flow-children:a": 1,
          "flow-children:b": { total: 2 },
        });
        expect((await claim(parents))?.id).toBe("gather");
        await driver.drainQueue(parents, true);
        await driver.removeJob(parents, "gather");
      });

      it("releases a parent that is due later as delayed", async () => {
        const { parents } = scope("flow-later");
        const now = Date.now();
        await driver.addJob(
          parents,
          parent("later", ["a"], { runAt: now + 60_000 }),
        );

        expect(
          await driver.recordChild!(
            parents,
            "later",
            child("a"),
            completed(null),
            now,
          ),
        ).toBe("released");

        expect((await driver.getJob(parents, "later"))?.state).toBe("delayed");
        expect(await claim(parents, now)).toBeNull();
        await driver.removeJob(parents, "later");
      });

      it("carries on past an ignored failure, and buries the parent on one that is not", async () => {
        const { parents } = scope("flow-fragile");
        await driver.addJob(parents, parent("fragile", ["a", "b"]));

        expect(
          await driver.recordChild!(
            parents,
            "fragile",
            child("a"),
            failed("tolerated", true),
            Date.now(),
          ),
        ).toBe("recorded");
        const carried = await driver.getJob(parents, "fragile");
        expect(carried?.state).toBe("waiting-children");
        expect(carried?.flow?.pending).toBe(1);
        expect(carried?.flow?.failures["flow-children:a"]?.message).toBe(
          "tolerated",
        );

        expect(
          await driver.recordChild!(
            parents,
            "fragile",
            child("b"),
            failed("fatal"),
            Date.now(),
          ),
        ).toBe("buried");
        const buried = await driver.getJob(parents, "fragile");
        expect(buried?.state).toBe("dead");
        expect(buried?.failedReason?.message).toBe("fatal");

        // An outcome a buried parent already holds is still a repeat.
        expect(
          await driver.recordChild!(
            parents,
            "fragile",
            child("a"),
            completed(1),
            Date.now(),
          ),
        ).toBe("already");
        await driver.removeJob(parents, "fragile");
      });

      it("answers missing for no parent, or one that does not list the child, and already for one that moved on", async () => {
        const { parents } = scope("flow-missing");
        expect(
          await driver.recordChild!(
            parents,
            "ghost",
            child("a"),
            completed(1),
            Date.now(),
          ),
        ).toBe("missing");

        // A job in no flow is nobody's parent.
        await driver.addJob(parents, makeJob({ id: "plain" }));
        expect(
          await driver.recordChild!(
            parents,
            "plain",
            child("a"),
            completed(1),
            Date.now(),
          ),
        ).toBe("missing");
        expect((await driver.getJob(parents, "plain"))?.state).toBe("waiting");

        // A parent waiting on other children does not count a stranger off.
        await driver.addJob(parents, parent("particular", ["a"]));
        expect(
          await driver.recordChild!(
            parents,
            "particular",
            child("stranger"),
            completed(1),
            Date.now(),
          ),
        ).toBe("missing");
        const untouched = await driver.getJob(parents, "particular");
        expect(untouched?.state).toBe("waiting-children");
        expect(untouched?.flow?.pending).toBe(1);
        expect(untouched?.flow?.values).toEqual({});

        // A parent that lists the child but no longer waits.
        await driver.addJob(
          parents,
          parent("moved-on", ["a"], { state: "waiting" }),
        );
        expect(
          await driver.recordChild!(
            parents,
            "moved-on",
            child("a"),
            completed(1),
            Date.now(),
          ),
        ).toBe("already");
        expect(
          (await driver.getJob(parents, "moved-on"))?.flow?.values,
        ).toEqual({});

        await driver.drainQueue(parents, true);
      });

      it("keeps a completed or ignored outcome on a buried parent without moving it, and refuses a failure", async () => {
        const { parents } = scope("flow-fallen");
        await driver.addJob(parents, parent("fallen", ["a", "b", "c", "d"]));
        expect(
          await driver.recordChild!(
            parents,
            "fallen",
            child("c"),
            failed("fatal"),
            Date.now(),
          ),
        ).toBe("buried");
        const before = await driver.getJob(parents, "fallen");

        expect(
          await driver.recordChild!(
            parents,
            "fallen",
            child("a"),
            completed({ late: true }),
            Date.now(),
          ),
        ).toBe("recorded");
        expect(
          await driver.recordChild!(
            parents,
            "fallen",
            child("b"),
            failed("tolerated", true),
            Date.now(),
          ),
        ).toBe("recorded");
        // A failure that is not ignored stores nothing on a buried parent.
        expect(
          await driver.recordChild!(
            parents,
            "fallen",
            child("d"),
            failed("also broke"),
            Date.now(),
          ),
        ).toBe("parent-dead");
        // And repeats are still repeats.
        expect(
          await driver.recordChild!(
            parents,
            "fallen",
            child("a"),
            completed({ late: true }),
            Date.now(),
          ),
        ).toBe("already");

        const after = await driver.getJob(parents, "fallen");
        expect(after?.state).toBe("dead");
        expect(after?.failedReason?.message).toBe("fatal");
        expect(after?.finishedOn).toBe(before!.finishedOn);
        expect(after?.flow?.pending).toBe(before!.flow!.pending);
        expect(after?.flow?.values).toEqual({
          "flow-children:a": { late: true },
        });
        expect(Object.keys(after?.flow?.failures ?? {})).toEqual([
          "flow-children:b",
        ]);

        // A retry then waits on the refused child alone.
        expect(await driver.requeueParent!(parents, "fallen", Date.now())).toBe(
          true,
        );
        const requeued = await driver.getJob(parents, "fallen");
        expect(requeued?.state).toBe("waiting-children");
        expect(requeued?.flow?.pending).toBe(2);

        await driver.drainQueue(parents, true);
      });

      it("releases a requeued parent whose children all have stored outcomes", async () => {
        const { parents } = scope("flow-requeued");
        const now = Date.now();
        const settled = (id: string, runAt: number) =>
          makeJob({
            id,
            state: "dead",
            runAt,
            finishedOn: now,
            failedReason: serializeError(new Error("broke")),
            flow: flowOf({
              children: [child("a"), child("b")],
              // Stale on purpose: the driver counts, not the record.
              pending: 2,
              values: { "flow-children:a": 1 },
              failures: {
                "flow-children:b": serializeError(new Error("ignored")),
              },
            }),
          });
        await driver.addJobs(parents, [
          settled("ready", now),
          settled("due-later", now + 60_000),
        ]);

        expect(await driver.requeueParent!(parents, "ready", now)).toBe(true);
        const ready = await driver.getJob(parents, "ready");
        expect(ready?.state).toBe("waiting");
        expect(ready?.flow?.pending).toBe(0);
        expect(ready?.failedReason).toBeNull();
        expect(ready?.flow?.values).toEqual({ "flow-children:a": 1 });

        expect(await driver.requeueParent!(parents, "due-later", now)).toBe(
          true,
        );
        expect((await driver.getJob(parents, "due-later"))?.state).toBe(
          "delayed",
        );

        expect((await claim(parents, now))?.id).toBe("ready");
        await driver.drainQueue(parents, true);
        await driver.removeJob(parents, "ready");
      });

      it("returns a buried parent to waiting on its children", async () => {
        const { parents } = scope("flow-unburied");
        await driver.addJob(parents, parent("again", ["a", "b"]));
        await driver.recordChild!(
          parents,
          "again",
          child("a"),
          completed(1),
          Date.now(),
        );
        await driver.recordChild!(
          parents,
          "again",
          child("b"),
          failed("broke"),
          Date.now(),
        );
        expect((await driver.getJob(parents, "again"))?.state).toBe("dead");

        expect(await driver.requeueParent!(parents, "again", Date.now())).toBe(
          true,
        );
        const requeued = await driver.getJob(parents, "again");
        expect(requeued?.state).toBe("waiting-children");
        expect(requeued?.flow?.pending).toBe(1);
        expect(requeued?.failedReason).toBeNull();
        // Its completed child's result is kept.
        expect(requeued?.flow?.values).toEqual({ "flow-children:a": 1 });
        expect(await claim(parents)).toBeNull();

        // Only a buried parent can be requeued.
        await driver.addJob(parents, makeJob({ id: "not-buried" }));
        expect(
          await driver.requeueParent!(parents, "not-buried", Date.now()),
        ).toBe(false);

        await driver.drainQueue(parents, true);
        await driver.removeJob(parents, "again");
      });

      it("refuses a failure already delivered, leaving a retried parent waiting on its children", async () => {
        const { parents, children } = scope("flow-stale-failure");
        const now = Date.now();
        const ofParent = flowOf({ parent: { queue: PARENTS_QUEUE, id: "p" } });
        await driver.addJobs(children, [
          makeJob({ id: "good", flow: ofParent }),
          makeJob({
            id: "bad",
            state: "dead",
            finishedOn: now,
            failedReason: serializeError(new Error("broke")),
            flow: ofParent,
          }),
        ]);
        await driver.addJob(parents, parent("p", ["good", "bad"]));

        // The delivery that buries it, and the mark that says so.
        expect(
          await driver.recordChild!(
            parents,
            "p",
            child("bad"),
            failed("broke"),
            now,
          ),
        ).toBe("buried");
        expect(
          await driver.markChildRecorded!(children, "bad", false, now),
        ).toBe(true);
        expect(await driver.requeueParent!(parents, "p", now)).toBe(true);

        /** Asserts the parent is still waiting on both, unharmed. */
        const expectStillWaiting = async () => {
          const retried = await driver.getJob(parents, "p");
          expect(retried?.state).toBe("waiting-children");
          expect(retried?.failedReason).toBeNull();
          expect(retried?.flow?.pending).toBe(2);
          expect(retried?.flow?.failures).toEqual({});
        };

        // The same failure, decided from a view older than the parent's retry,
        // landing before the child's: the child reads recorded. Stale.
        expect(
          await driver.recordChild!(
            parents,
            "p",
            child("bad"),
            failed("broke"),
            now + 1,
          ),
        ).toBe("already");
        await expectStillWaiting();

        // Landing after the child's retry too: recorded is reset by then, but
        // the child is not dead. Still stale.
        expect(await driver.retryJob(children, "bad", true, now + 2)).toBe(
          true,
        );
        const retriedChild = await driver.getJob(children, "bad");
        expect(retriedChild?.state).toBe("waiting");
        expect(retriedChild?.flow?.recorded).toBe(false);
        expect(
          await driver.recordChild!(
            parents,
            "p",
            child("bad"),
            failed("broke"),
            now + 3,
          ),
        ).toBe("already");
        await expectStillWaiting();

        // Control: the child fails again — dead and unrecorded — and that
        // failure is new, so it buries the parent. The refusal reads the
        // child's record, not the parent's history.
        expect(
          await driver.buryJob!(
            children,
            "bad",
            serializeError(new Error("broke again")),
            { retention: false, keepStacktraces: 1 },
            now + 4,
          ),
        ).not.toBeNull();
        expect(
          await driver.recordChild!(
            parents,
            "p",
            child("bad"),
            failed("broke again"),
            now + 5,
          ),
        ).toBe("buried");
        const reburied = await driver.getJob(parents, "p");
        expect(reburied?.state).toBe("dead");
        expect(reburied?.failedReason?.message).toBe("broke again");

        await driver.drainQueue(children, true);
      });

      it("resets a requeued parent's own recorded mark", async () => {
        const { parents } = scope("flow-requeue-recorded");
        const now = Date.now();
        await driver.addJob(
          parents,
          makeJob({
            id: "nested",
            state: "dead",
            finishedOn: now,
            failedReason: serializeError(new Error("child broke")),
            flow: flowOf({
              parent: { queue: PARENTS_QUEUE, id: "top" },
              children: [child("leaf")],
              pending: 1,
              // Its bury was delivered to its own parent.
              recorded: true,
            }),
          }),
        );

        expect(await driver.requeueParent!(parents, "nested", now)).toBe(true);
        const requeued = await driver.getJob(parents, "nested");
        expect(requeued?.state).toBe("waiting-children");
        expect(requeued?.flow?.recorded).toBe(false);
        expect(requeued?.flow?.parent).toEqual({
          queue: PARENTS_QUEUE,
          id: "top",
        });

        await driver.drainQueue(parents, true);
      });

      it("delivers a nested parent retried and buried again to its own parent", async () => {
        const { parents, children } = scope("flow-nested-again");
        const now = Date.now();
        // top (parents) <- mid (children) <- leaf (children)
        await driver.addJobs(children, [
          makeJob({
            id: "leaf",
            state: "dead",
            finishedOn: now,
            failedReason: serializeError(new Error("leaf broke")),
            flow: flowOf({ parent: { queue: CHILDREN_QUEUE, id: "mid" } }),
          }),
          makeJob({
            id: "mid",
            state: "waiting-children",
            flow: flowOf({
              parent: { queue: PARENTS_QUEUE, id: "top" },
              children: [child("leaf")],
              pending: 1,
            }),
          }),
        ]);
        await driver.addJob(parents, parent("top", ["mid"]));

        // First failure: leaf buries mid, mid buries top, each marked.
        expect(
          await driver.recordChild!(
            children,
            "mid",
            child("leaf"),
            failed("leaf broke"),
            now,
          ),
        ).toBe("buried");
        await driver.markChildRecorded!(children, "leaf", false, now);
        expect(
          await driver.recordChild!(
            parents,
            "top",
            child("mid"),
            failed("mid buried"),
            now,
          ),
        ).toBe("buried");
        await driver.markChildRecorded!(children, "mid", false, now);

        // The whole chain is retried, top down.
        expect(await driver.requeueParent!(parents, "top", now)).toBe(true);
        expect(await driver.requeueParent!(children, "mid", now)).toBe(true);
        expect(await driver.retryJob(children, "leaf", true, now)).toBe(true);
        expect(
          await driver.buryJob!(
            children,
            "leaf",
            serializeError(new Error("leaf broke again")),
            { retention: false, keepStacktraces: 1 },
            now + 1,
          ),
        ).not.toBeNull();

        // Leaf fails again and buries mid again...
        expect(
          await driver.recordChild!(
            children,
            "mid",
            child("leaf"),
            failed("leaf broke again"),
            now + 1,
          ),
        ).toBe("buried");
        await driver.markChildRecorded!(children, "leaf", false, now + 1);

        // ...and mid's second failure is new to top, which it buries.
        expect(
          await driver.recordChild!(
            parents,
            "top",
            child("mid"),
            failed("mid buried again"),
            now + 1,
          ),
        ).toBe("buried");
        const top = await driver.getJob(parents, "top");
        expect(top?.state).toBe("dead");
        expect(top?.failedReason?.message).toBe("mid buried again");

        await driver.drainQueue(children, true);
      });

      it("refuses to retry a parent still waiting on its children", async () => {
        const { parents } = scope("flow-unsettled");
        await driver.addJob(parents, parent("unsettled", ["a"]));

        expect(
          await driver.retryJob(parents, "unsettled", true, Date.now()),
        ).toBe(false);
        expect((await driver.getJob(parents, "unsettled"))?.state).toBe(
          "waiting-children",
        );
        expect(await claim(parents)).toBeNull();

        await driver.drainQueue(parents, true);
      });

      it("cleans parents waiting on children by age, and only them", async () => {
        const { parents } = scope("flow-clean-age");
        const now = Date.now();
        await driver.addJobs(parents, [
          parent("stale-parent", ["a"], { createdAt: now - 100_000 }),
          parent("fresh-parent", ["b"], { createdAt: now }),
          makeJob({ id: "stale-waiting", createdAt: now - 100_000 }),
        ]);

        expect(
          await driver.cleanJobs(parents, "waiting-children", 50_000, 10, now),
        ).toEqual(["stale-parent"]);
        expect(await driver.getJob(parents, "stale-parent")).toBeNull();
        expect((await driver.getJob(parents, "fresh-parent"))?.state).toBe(
          "waiting-children",
        );
        expect((await driver.getJob(parents, "stale-waiting"))?.state).toBe(
          "waiting",
        );
        expect((await driver.countJobs(parents))["waiting-children"]).toBe(1);

        await driver.drainQueue(parents, true);
      });

      it("marks a child recorded, then applies the retention it deferred", async () => {
        const { parents, children } = scope("flow-recorded");
        const now = Date.now();
        const childFlow = flowOf({ parent: { queue: parents.queue, id: "p" } });
        await driver.addJobs(children, [
          makeJob({
            id: "kept",
            state: "completed",
            finishedOn: now,
            flow: childFlow,
          }),
          makeJob({
            id: "removed",
            state: "completed",
            finishedOn: now,
            flow: childFlow,
          }),
        ]);

        expect(
          await driver.markChildRecorded!(children, "kept", false, now),
        ).toBe(true);
        expect((await driver.getJob(children, "kept"))?.flow?.recorded).toBe(
          true,
        );

        expect(
          await driver.markChildRecorded!(children, "removed", true, now),
        ).toBe(true);
        expect(await driver.getJob(children, "removed")).toBeNull();

        expect(
          await driver.markChildRecorded!(children, "absent", true, now),
        ).toBe(false);
        await driver.removeJob(children, "kept");
      });

      for (const state of ["completed", "dead"] as const) {
        it(`marking a ${state} child recorded applies a TTL retention`, async () => {
          const retained: QueueRef = { ns, queue: `flow-ttl-${state}` };
          const now = Date.now();
          await driver.addJob(
            retained,
            makeJob({
              id: "timed",
              state,
              finishedOn: now,
              flow: flowOf({ parent: { queue: PARENTS_QUEUE, id: "p" } }),
            }),
          );

          expect(
            await driver.markChildRecorded!(
              retained,
              "timed",
              { ttl: 5000 },
              now,
            ),
          ).toBe(true);
          const marked = await driver.getJob(retained, "timed");
          expect(marked?.flow?.recorded).toBe(true);
          expect(marked?.expiresAt).toBe(now + 5000);

          expect(await driver.pruneExpired(retained, now, 10)).toBe(0);
          expect(await driver.pruneExpired(retained, now + 6000, 10)).toBe(1);
          expect(await driver.getJob(retained, "timed")).toBeNull();
        });

        it(`marking a ${state} child recorded applies a count retention`, async () => {
          const retained: QueueRef = { ns, queue: `flow-count-${state}` };
          const now = Date.now();
          await driver.addJobs(retained, [
            makeJob({ id: "oldest", state, finishedOn: now - 3000 }),
            makeJob({ id: "older", state, finishedOn: now - 2000 }),
            makeJob({
              id: "newest",
              state,
              finishedOn: now - 1000,
              flow: flowOf({ parent: { queue: PARENTS_QUEUE, id: "p" } }),
            }),
          ]);

          expect(
            await driver.markChildRecorded!(
              retained,
              "newest",
              { count: 1 },
              now,
            ),
          ).toBe(true);

          expect(await driver.getJob(retained, "oldest")).toBeNull();
          expect(await driver.getJob(retained, "older")).toBeNull();
          expect(
            (await driver.getJob(retained, "newest"))?.flow?.recorded,
          ).toBe(true);
          expect((await driver.countJobs(retained))[state]).toBe(1);

          await driver.removeJob(retained, "newest");
        });

        it(`never sweeps away a ${state} child whose outcome is not recorded, by count or by TTL`, async () => {
          const guarded: QueueRef = { ns, queue: `flow-guard-${state}` };
          const now = Date.now();
          const unrecorded = flowOf({
            parent: { queue: PARENTS_QUEUE, id: "p" },
          });

          await driver.addJobs(guarded, [
            makeJob({ id: "plain-old", state, finishedOn: now - 4000 }),
            // A top-level parent is not waiting on delivery: sweepable.
            makeJob({
              id: "root-old",
              state,
              finishedOn: now - 3500,
              flow: flowOf({ children: [child("x")] }),
            }),
            makeJob({
              id: "child-old",
              state,
              finishedOn: now - 3000,
              flow: unrecorded,
            }),
            makeJob({
              id: "trigger",
              state,
              finishedOn: now - 1000,
              flow: unrecorded,
            }),
          ]);

          // Any count retention in the state sweeps it; this is one.
          await driver.markChildRecorded!(
            guarded,
            "trigger",
            { count: 1 },
            now,
          );

          expect(await driver.getJob(guarded, "plain-old")).toBeNull();
          expect(await driver.getJob(guarded, "root-old")).toBeNull();
          expect(
            (await driver.getJob(guarded, "child-old"))?.flow?.recorded,
          ).toBe(false);

          await driver.addJobs(guarded, [
            makeJob({
              id: "plain-expired",
              state,
              finishedOn: now - 5000,
              expiresAt: now - 1,
            }),
            makeJob({
              id: "child-expired",
              state,
              finishedOn: now - 5000,
              expiresAt: now - 1,
              flow: unrecorded,
            }),
          ]);

          expect(await driver.pruneExpired(guarded, now, 10)).toBe(1);
          expect(await driver.getJob(guarded, "plain-expired")).toBeNull();
          expect((await driver.getJob(guarded, "child-expired"))?.state).toBe(
            state,
          );

          await driver.removeJob(guarded, "child-old");
          await driver.removeJob(guarded, "child-expired");
          await driver.removeJob(guarded, "trigger");
        });
      }

      it("clears a retried child's recorded flag, so its next outcome is delivered afresh", async () => {
        const { parents, children } = scope("flow-retried-child");
        const now = Date.now();
        await driver.addJob(
          children,
          makeJob({
            id: "again",
            state: "dead",
            finishedOn: now,
            failedReason: serializeError(new Error("broke")),
            flow: flowOf({
              parent: { queue: parents.queue, id: "p" },
              recorded: true,
            }),
          }),
        );

        expect(await driver.retryJob(children, "again", true, now)).toBe(true);
        const retried = await driver.getJob(children, "again");
        expect(retried?.state).toBe("waiting");
        expect(retried?.flow?.recorded).toBe(false);
        expect(retried?.flow?.parent).toEqual({
          queue: parents.queue,
          id: "p",
        });

        // A job in no flow stays in none.
        await driver.addJob(
          children,
          makeJob({ id: "flowless", state: "dead", finishedOn: now }),
        );
        expect(await driver.retryJob(children, "flowless", true, now)).toBe(
          true,
        );
        expect((await driver.getJob(children, "flowless"))?.flow).toBeNull();

        await driver.drainQueue(children, true);
      });
    });

    /* --- waiting and events ------------------------------------------ */

    describe("waiting and events", () => {
      it("returns from waitForJob when work arrives", async () => {
        const wq: QueueRef = { ns, queue: "waiting-room" };
        await driver.ensureQueue(wq);
        await driver.drainQueue(wq, true);

        let resolved = false;
        const waiting = driver.waitForJob(wq, 2000).then(() => {
          resolved = true;
        });

        await Bun.sleep(20);
        await driver.addJob(wq, makeJob({ id: "arrived" }));

        await waiting;
        expect(resolved).toBe(true);

        await driver.drainQueue(wq, true);
      });

      it("returns from waitForJob at the timeout", async () => {
        const wq: QueueRef = { ns, queue: "quiet-room" };
        await driver.ensureQueue(wq);

        const started = Date.now();
        await driver.waitForJob(wq, 60);
        expect(Date.now() - started).toBeGreaterThanOrEqual(40);
      });

      it("returns from waitForJob on abort", async () => {
        const wq: QueueRef = { ns, queue: "abort-room" };
        await driver.ensureQueue(wq);

        const controller = new AbortController();
        const waiting = driver.waitForJob(wq, 5000, controller.signal);
        controller.abort();

        await waiting;
      });

      it("prunes stored events, where it stores any", async () => {
        // Optional on the contract, because only a backend that writes events
        // down has anything to remove: Redis publishes to a channel and the
        // memory driver calls its listeners. The three that do write them
        // never removed one until this existed — a log that grows for as long
        // as the queue runs, holding notifications whose value expired seconds
        // after they were published.
        if (!driver.cleanEvents) {
          return;
        }

        const target = "prunable";
        const received: string[] = [];
        const unsubscribe = await driver.subscribe(
          ns,
          "queue",
          target,
          (event) => received.push(event.type),
        );

        try {
          await driver.publish(
            queueEvent(
              { ns, target, type: "promoted", origin: newToken() },
              { id: "old-one" },
            ),
          );

          await waitFor(() => received.length > 0, {
            message: "the event never arrived, so pruning proves nothing",
          });

          // Everything published so far is older than this.
          const removed = await driver.cleanEvents(ns, Date.now() + 1_000);
          expect(removed).toBeGreaterThan(0);

          // And pruning again finds nothing left to take.
          expect(await driver.cleanEvents(ns, Date.now() + 1_000)).toBe(0);
        } finally {
          await unsubscribe();
        }
      });

      it("delivers published events to subscribers of that target", async () => {
        const received: string[] = [];
        const unsubscribe = await driver.subscribe(
          ns,
          "queue",
          "events-test",
          (event) => received.push(event.type),
        );

        await driver.publish(
          queueEvent(
            {
              ns,
              target: "events-test",
              type: "completed",
              origin: newToken(),
            },
            { id: "job-1", returnValue: null },
          ),
        );

        // Another target's events must not arrive here.
        await driver.publish(
          queueEvent(
            {
              ns,
              target: "somewhere-else",
              type: "failed",
              origin: newToken(),
            },
            { id: "job-2", error: { name: "Error", message: "elsewhere" } },
          ),
        );

        await waitFor(() => received.length > 0, {
          message: "no event delivered",
        });
        expect(received).toEqual(["completed"]);

        await unsubscribe();
        // Any event will do here; what is being checked is that nothing
        // arrives after `unsubscribe()`, not which event it was.
        await driver.publish(
          queueEvent(
            { ns, target: "events-test", type: "promoted", origin: newToken() },
            { id: "job-3" },
          ),
        );
        await Bun.sleep(20);
        expect(received).toEqual(["completed"]);
      });

      it("keeps worker events off the queue's own channel", async () => {
        // The worker kind's target is a *queue* name, so the two share a
        // target and differ only by kind. A driver that routed on the target
        // alone would hand every worker event to `BunQueue`'s subscriber,
        // which asked for jobs — and on the file driver, whose paths were
        // queue-or-runner, a worker event landed in the runners directory and
        // `listRunners` then reported the queue as a runner.
        const target = "worker-kind";
        const queueEvents: string[] = [];
        const workerEvents: string[] = [];

        const onQueueEvent = (event: { type: string }): number =>
          queueEvents.push(event.type);
        const stopQueue = await driver.subscribe(
          ns,
          "queue",
          target,
          onQueueEvent,
        );
        const stopWorkers = await driver.subscribe(
          ns,
          "worker",
          target,
          (event) => workerEvents.push(event.type),
        );

        try {
          await driver.publish(
            workerEvent(
              { ns, target, type: "control", origin: newToken() },
              { worker: "w-1", action: "pause", seq: 3 },
            ),
          );

          await waitFor(() => workerEvents.length > 0, {
            message: "the worker event never arrived",
          });
          expect(workerEvents).toEqual(["control"]);

          // A queue event on the same target still reaches the queue
          // subscriber, and neither subscriber ever sees the other's.
          await driver.publish(
            queueEvent(
              { ns, target, type: "promoted", origin: newToken() },
              { id: "job-1" },
            ),
          );
          await waitFor(() => queueEvents.length > 0, {
            message: "the queue event never arrived",
          });

          await Bun.sleep(20);
          expect(queueEvents).toEqual(["promoted"]);
          expect(workerEvents).toEqual(["control"]);

          // And the queue was not mistaken for a runner on the way.
          expect(await driver.listRunners(ns)).not.toContain(target);
        } finally {
          await stopQueue();
          await stopWorkers();
        }
      });
    });

    /* --- worker control ------------------------------------------------ */

    describe("worker control entries", () => {
      it("stores, versions and sweeps them, whatever holds the queue state", async () => {
        // The entries are ordinary reserved queue state, so what is asserted
        // here is that each backend's compare-and-set behaves as the control
        // logic above it assumes: versions only rise, a stale expectation is
        // refused, and a conditional delete at the wrong version does nothing.
        if (!supportsWorkerControl(driver)) {
          return;
        }

        const wq: QueueRef = { ns, queue: "worker-control" };
        await driver.ensureQueue(wq);

        const first = await writeWorkerConfig(driver, wq, "svc.orders", {
          concurrency: 4,
        });
        expect(first.contended).toBe(false);

        const merged = await writeWorkerConfig(driver, wq, "svc.orders", {
          pollInterval: 250,
        });
        expect(merged.override.values).toEqual({
          concurrency: 4,
          pollInterval: 250,
        });
        expect(merged.override.seq).toBeGreaterThan(first.override.seq);

        const stale = await writeWorkerConfig(
          driver,
          wq,
          "svc.orders",
          { concurrency: 1 },
          { expectedSeq: first.override.seq },
        );
        expect(stale.contended).toBe(true);
        expect(
          (await readWorkerConfig(driver, wq, "svc.orders"))?.value.values,
        ).toEqual({ concurrency: 4, pollInterval: 250 });

        expect(
          (await listWorkerConfigs(driver, wq)).map((one) => one.key),
        ).toContain("svc.orders");

        const now = Date.now();
        const { seq } = await writeWorkerControl(driver, wq, {
          id: "svc.orders.dead",
          key: "svc.orders",
          incarnation: 1,
          state: "stopped",
          at: now - 3_600_000,
        });
        expect(
          (await readWorkerControl(driver, wq, "svc.orders.dead"))?.seq,
        ).toBe(seq);

        const sweep = await sweepWorkerControls(driver, wq, {
          now,
          liveIds: new Set(),
          graceMs: 60_000,
        });
        expect(sweep.removed).toBe(1);
        expect(
          await readWorkerControl(driver, wq, "svc.orders.dead"),
        ).toBeNull();

        // The override is the operator's standing intent and is never swept.
        expect(await readWorkerConfig(driver, wq, "svc.orders")).not.toBeNull();
      });
    });

    /* --- discovery and purge ------------------------------------------ */

    /* --- read APIs ---------------------------------------------------- */

    describe("read APIs", () => {
      /**
       * The driver with some methods hidden, so the shared fallback a queue
       * uses for a driver without them runs against this backend too.
       */
      function without(methods: (keyof JobsDriver)[]): JobsDriver {
        return new Proxy(driver, {
          get(target, property) {
            if (methods.includes(property as keyof JobsDriver)) {
              return undefined;
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }

      /** A page the way a queue reads one: native first, else the scan. */
      const finders: [
        string,
        (target: QueueRef, query: JobQuery) => Promise<JobPage>,
      ][] = [
        [
          "driver",
          async (target, query) => await findJobPage(driver, target, query),
        ],
        [
          "scan fallback",
          async (target, query) => await findJobsByScan(driver, target, query),
        ],
      ];

      /**
       * What a query must answer, worked out independently: every job in the
       * states in the driver's own `listJobs` order, filtered here.
       */
      async function expected(
        target: QueueRef,
        query: Omit<JobQuery, "offset" | "limit">,
      ): Promise<string[]> {
        const all = await driver.listJobs(target, query.states, {
          offset: 0,
          limit: 10_000,
          order: query.order,
        });
        const filter = jobFilter(query);
        return all
          .filter((job) => !filter || matchesFilter(filter, job.id, job.name))
          .map((job) => job.id);
      }

      /** Ids that need care in `LIKE`, a regex, a key or a file name. */
      const tricky: { id: string; name: string }[] = [
        { id: "inv-001", name: "sendEmail" },
        { id: "inv-002", name: "SendEmail" },
        { id: "INV-003", name: "report" },
        { id: "pct%1", name: "x" },
        { id: "under_1", name: "x" },
        { id: "underX1", name: "x" },
        { id: "dot.star*", name: "x" },
        { id: "dotXstarX", name: "x" },
        { id: "quote'1", name: "x" },
        { id: 'dq"1', name: "x" },
        { id: "back\\slash", name: "x" },
        { id: "bang!1", name: "x" },
        { id: "paren(1)", name: "brack[et]" },
        { id: "caret^$", name: "x" },
        { id: "nm-1", name: 'say "hi"' },
        { id: "nm-2", name: "back\\name" },
        { id: "nm-3", name: "it's" },
        { id: "plain", name: "plain-name" },
      ];

      /** Adds the tricky jobs to a fresh queue, waiting, oldest first. */
      async function seedTricky(queue: string): Promise<QueueRef> {
        const target: QueueRef = { ns, queue };
        const base = Date.now() - 60_000;
        await driver.addJobs(
          target,
          tricky.map((seed, index) =>
            makeJob({
              ...seed,
              createdAt: base + index,
              data: { note: "needle %_ in the payload only" },
            }),
          ),
        );
        return target;
      }

      for (const [label, find] of finders) {
        it(`${label}: searches id and name ignoring case, never the payload`, async () => {
          const target = await seedTricky(
            `find-search-${label.replace(/\W/g, "")}`,
          );
          const ids = async (search: string): Promise<string[]> => {
            const page = await find(target, {
              states: ["waiting"],
              offset: 0,
              limit: 100,
              order: "asc",
              search,
            });
            return page.jobs.map((job) => job.id).sort();
          };

          expect(await ids("INV")).toEqual(["INV-003", "inv-001", "inv-002"]);
          expect(await ids("sendemail")).toEqual(["inv-001", "inv-002"]);
          expect(await ids("REPORT")).toEqual(["INV-003"]);
          expect(await ids("needle")).toEqual([]);
          expect(await ids("in the payload")).toEqual([]);
        });

        it(`${label}: takes every character of a search literally`, async () => {
          const target = await seedTricky(
            `find-literal-${label.replace(/\W/g, "")}`,
          );
          const ids = async (search: string): Promise<string[]> => {
            const page = await find(target, {
              states: ["waiting"],
              offset: 0,
              limit: 100,
              order: "asc",
              search,
            });
            return page.jobs.map((job) => job.id).sort();
          };

          expect(await ids("%")).toEqual(["pct%1"]);
          expect(await ids("_")).toEqual(["under_1"]);
          // `.` and `*` as a pattern would match `dotXstarX` too.
          expect(await ids(".star*")).toEqual(["dot.star*"]);
          expect(await ids("t.s")).toEqual(["dot.star*"]);
          expect(await ids("'")).toEqual(["nm-3", "quote'1"]);
          expect(await ids('"')).toEqual(['dq"1', "nm-1"]);
          expect(await ids("\\")).toEqual(["back\\slash", "nm-2"]);
          expect(await ids("!")).toEqual(["bang!1"]);
          expect(await ids("[et]")).toEqual(["paren(1)"]);
          expect(await ids("(1)")).toEqual(["paren(1)"]);
          expect(await ids("^$")).toEqual(["caret^$"]);
          expect(await ids("r_1")).toEqual(["under_1"]);
          // The same characters in a name, which a backend may store escaped —
          // Redis keeps names inside JSON.
          expect(await ids('"hi"')).toEqual(["nm-1"]);
          expect(await ids('SAY "H')).toEqual(["nm-1"]);
          expect(await ids("\\name")).toEqual(["nm-2"]);
          expect(await ids("t's")).toEqual(["nm-3"]);
          // Empty is no search at all.
          expect((await ids("")).length).toBe(tricky.length);
        });

        it(`${label}: filters by exact name, one or several, and composes with a search`, async () => {
          const target = await seedTricky(
            `find-names-${label.replace(/\W/g, "")}`,
          );
          const ids = async (query: Partial<JobQuery>): Promise<string[]> => {
            const page = await find(target, {
              states: ["waiting"],
              offset: 0,
              limit: 100,
              order: "asc",
              ...query,
            });
            return page.jobs.map((job) => job.id).sort();
          };

          expect(await ids({ names: ["sendEmail"] })).toEqual(["inv-001"]);
          expect(await ids({ names: ["sendEmail", "report"] })).toEqual([
            "INV-003",
            "inv-001",
          ]);
          expect(await ids({ names: [] })).toEqual([]);
          expect(await ids({ names: ["brack[et]"], search: "1" })).toEqual([
            "paren(1)",
          ]);
          expect(await ids({ names: ["x"], search: "1" })).toEqual([
            "bang!1",
            'dq"1',
            "pct%1",
            "quote'1",
            // Code-unit order: `X` sorts before `_`.
            "underX1",
            "under_1",
          ]);
        });

        it(`${label}: pages a filtered read in order, with the total of every match`, async () => {
          const target: QueueRef = {
            ns,
            queue: `find-pages-${label.replace(/\W/g, "")}`,
          };
          const base = Date.now() - 100_000;
          const seeds: JobRecord[] = [];
          for (let index = 0; index < 16; index++) {
            const job = makeJob({
              id: `page-${String(index).padStart(2, "0")}`,
              name: index % 2 === 0 ? "even" : "odd",
              createdAt: base + index,
            });
            if (index % 4 === 3) {
              job.state = "dead";
              job.finishedOn = base + 1000 + index;
            }
            seeds.push(job);
          }
          await driver.addJobs(target, seeds);

          for (const states of [
            ["waiting"],
            ["waiting", "dead"],
          ] as JobState[][]) {
            for (const order of ["asc", "desc"] as const) {
              const want = await expected(target, {
                states,
                order,
                names: ["odd"],
              });
              expect(want.length).toBeGreaterThan(3);

              const seen: string[] = [];
              for (let offset = 0; offset < want.length + 3; offset += 3) {
                const page = await find(target, {
                  states,
                  order,
                  offset,
                  limit: 3,
                  names: ["odd"],
                  total: true,
                });
                expect(page.total).toBe(want.length);
                expect(page.jobs.every((job) => job.name === "odd")).toBe(true);
                seen.push(...page.jobs.map((job) => job.id));
              }

              expect(seen).toEqual(want);
            }
          }

          // The same for a search, which every job's id matches differently.
          const searched = await expected(target, {
            states: ["waiting", "dead"],
            order: "asc",
            search: "PAGE-1",
          });
          const page = await find(target, {
            states: ["waiting", "dead"],
            order: "asc",
            offset: 1,
            limit: 2,
            search: "PAGE-1",
            total: true,
          });
          expect(page.jobs.map((job) => job.id)).toEqual(searched.slice(1, 3));
          expect(page.total).toBe(searched.length);
        });

        it(`${label}: totals an unfiltered read from the counts, and only when asked`, async () => {
          const target = await seedTricky(
            `find-total-${label.replace(/\W/g, "")}`,
          );
          await driver.addJob(
            target,
            makeJob({ id: "gone", state: "completed", finishedOn: Date.now() }),
          );

          const page = await find(target, {
            states: ["waiting", "completed"],
            offset: 0,
            limit: 2,
            order: "asc",
            total: true,
          });
          expect(page.jobs).toHaveLength(2);
          expect(page.total).toBe(tricky.length + 1);

          const untotalled = await find(target, {
            states: ["waiting"],
            offset: 0,
            limit: 2,
            order: "asc",
            search: "inv",
          });
          expect(untotalled.total).toBeUndefined();

          const empty = await find(target, {
            states: ["waiting"],
            offset: 50,
            limit: 10,
            order: "asc",
            search: "inv",
            total: true,
          });
          expect(empty).toEqual({ jobs: [], total: 3 });
        });
      }

      for (const [label, getMany] of [
        ["driver", getJobsByIds],
        ["loop fallback", getJobsByLoop],
      ] as const) {
        it(`${label}: gets several jobs in the order asked, null for a missing id`, async () => {
          const target: QueueRef = {
            ns,
            queue: `get-many-${label.replace(/\W/g, "")}`,
          };
          const elsewhere: QueueRef = { ns, queue: `${target.queue}-other` };
          await driver.addJobs(target, [
            makeJob({ id: "a", data: { n: 1 } }),
            makeJob({ id: "b%_'", data: { n: 2 } }),
          ]);
          await driver.addJob(elsewhere, makeJob({ id: "c" }));

          const found = await getMany(driver, target, [
            "b%_'",
            "missing",
            "a",
            "b%_'",
            "c",
          ]);

          expect(found.map((job) => job?.id ?? null)).toEqual([
            "b%_'",
            null,
            "a",
            "b%_'",
            null,
          ]);
          expect(found[2]?.data).toEqual({ n: 1 });
          // A repeated id is its own answer, not the same object twice.
          expect(found[0]).not.toBe(found[3]);
          expect(found[0]).toEqual(found[3]!);

          expect(await getMany(driver, target, [])).toEqual([]);
          expect(await getMany(driver, target, ["x", "y"])).toEqual([
            null,
            null,
          ]);
        });
      }

      /** A worker record, live for 30 seconds from `now`. */
      function workerRecord(
        target: QueueRef,
        id: string,
        now: number,
        overrides: Partial<WorkerInfo> = {},
      ): WorkerInfo {
        return {
          id,
          queue: target.queue,
          host: "host-a",
          pid: 4242,
          concurrency: 4,
          active: 0,
          paused: false,
          startedAt: now,
          heartbeatAt: now,
          expiresAt: now + 30_000,
          ...overrides,
        };
      }

      for (const label of ["driver", "queue-state fallback"] as const) {
        const target = (): JobsDriver =>
          label === "driver"
            ? driver
            : without(["registerWorker", "removeWorker", "listWorkers"]);

        it(`${label}: registers, updates, lists and removes workers`, async () => {
          const d = target();
          const wq: QueueRef = {
            ns,
            queue: `workers-${label.replace(/\W/g, "")}`,
          };
          const now = Date.now();

          if (label === "driver") {
            expect(typeof driver.registerWorker).toBe("function");
          }

          await registerWorkerRecord(d, wq, workerRecord(wq, "w-late", now));
          await registerWorkerRecord(
            d,
            wq,
            workerRecord(wq, "w:early/1", now, { startedAt: now - 5_000 }),
          );

          expect(await listWorkerRecords(d, wq, now)).toEqual([
            workerRecord(wq, "w:early/1", now, { startedAt: now - 5_000 }),
            workerRecord(wq, "w-late", now),
          ]);

          // A later report replaces the record rather than adding a second.
          const busy = workerRecord(wq, "w-late", now, {
            active: 3,
            paused: true,
            concurrency: 8,
            heartbeatAt: now + 10,
            expiresAt: now + 40_000,
          });
          await registerWorkerRecord(d, wq, busy);
          const listed = await listWorkerRecords(d, wq, now);
          expect(listed).toHaveLength(2);
          expect(listed[1]).toEqual(busy);

          expect(await removeWorkerRecord(d, wq, "w:early/1")).toBe(true);
          expect(await removeWorkerRecord(d, wq, "w:early/1")).toBe(false);
          expect(
            (await listWorkerRecords(d, wq, now)).map((w) => w.id),
          ).toEqual(["w-late"]);

          // Kept apart by queue and by namespace.
          expect(
            await listWorkerRecords(d, { ns, queue: `${wq.queue}-x` }, now),
          ).toEqual([]);
          expect(
            await listWorkerRecords(d, { ns: other, queue: wq.queue }, now),
          ).toEqual([]);
        });

        it(`${label}: removes lapsed records when another worker reports, not only when listed`, async () => {
          const d = target();
          const wq: QueueRef = {
            ns,
            queue: `prune-${label.replace(/\W/g, "")}`,
          };
          const now = Date.now();

          await registerWorkerRecord(
            d,
            wq,
            workerRecord(wq, "dead-one", now, { expiresAt: now + 1_000 }),
          );
          await registerWorkerRecord(
            d,
            wq,
            workerRecord(wq, "live-one", now + 5_000, { startedAt: now + 1 }),
          );

          // Listed as of a moment the dead record was still live: gone anyway,
          // because the live worker's report removed it.
          expect(
            (await listWorkerRecords(d, wq, now + 10)).map((w) => w.id),
          ).toEqual(["live-one"]);
        });

        it(`${label}: stops listing a worker once its record lapses`, async () => {
          const d = target();
          const wq: QueueRef = {
            ns,
            queue: `lapse-${label.replace(/\W/g, "")}`,
          };
          const now = Date.now();

          await registerWorkerRecord(
            d,
            wq,
            workerRecord(wq, "dying", now, { expiresAt: now + 1_000 }),
          );
          await registerWorkerRecord(
            d,
            wq,
            workerRecord(wq, "alive", now, { startedAt: now + 1 }),
          );

          expect(
            (await listWorkerRecords(d, wq, now + 999)).map((w) => w.id),
          ).toEqual(["dying", "alive"]);
          expect(
            (await listWorkerRecords(d, wq, now + 1_000)).map((w) => w.id),
          ).toEqual(["alive"]);
          expect(
            (await listWorkerRecords(d, wq, now + 5_000)).map((w) => w.id),
          ).toEqual(["alive"]);

          // A worker that reports again after lapsing is listed again.
          await registerWorkerRecord(
            d,
            wq,
            workerRecord(wq, "dying", now + 5_000, { startedAt: now }),
          );
          expect(
            (await listWorkerRecords(d, wq, now + 5_000)).map((w) => w.id),
          ).toEqual(["dying", "alive"]);
        });
      }

      it("counts throughput per minute in completions and failures that took effect", async () => {
        expect(typeof driver.getThroughput).toBe("function");

        const tq: QueueRef = { ns, queue: "throughput" };
        const minute = throughputBucket(Date.now()) - 10 * THROUGHPUT_BUCKET_MS;
        const token = newToken();

        /** Adds a job and claims it at `at`, answering its id. */
        const claimOne = async (id: string, at: number): Promise<string> => {
          await driver.addJob(
            tq,
            makeJob({ id, createdAt: at - 1, runAt: at - 1 }),
          );
          const claimed = await driver.claimJob(tq, {
            workerId: "w",
            token,
            lockMs: 60_000,
            now: at,
          });
          expect(claimed?.id).toBe(id);
          return id;
        };

        const error = serializeError(new Error("boom"));

        await claimOne("c1", minute + 1_000);
        expect(
          await driver.completeJob(tq, "c1", token, 1, false, minute + 1_000),
        ).toBe(true);
        await claimOne("c2", minute + 2_000);
        expect(
          await driver.completeJob(tq, "c2", token, 2, true, minute + 2_000),
        ).toBe(true);
        await claimOne("f1", minute + 3_000);
        expect(
          await driver.failJob(
            tq,
            "f1",
            token,
            error,
            // Far enough out that no later claim here promotes it.
            { retry: true, runAt: minute + 3_600_000 },
            minute + 3_000,
            5,
          ),
        ).toBe(true);
        await claimOne("f2", minute + 4_000);
        expect(
          await driver.failJob(
            tq,
            "f2",
            token,
            error,
            { retry: false, retention: false },
            minute + 4_000,
            5,
          ),
        ).toBe(true);

        // Writes that lost the lock are not counted.
        await claimOne("lost", minute + 5_000);
        expect(
          await driver.completeJob(
            tq,
            "lost",
            newToken(),
            1,
            false,
            minute + 5_000,
          ),
        ).toBe(false);
        expect(
          await driver.failJob(
            tq,
            "lost",
            newToken(),
            error,
            { retry: false, retention: false },
            minute + 5_000,
            5,
          ),
        ).toBe(false);
        expect(
          await driver.completeJob(tq, "c1", token, 1, false, minute + 5_000),
        ).toBe(false);

        // The next minute starts a new bucket.
        await claimOne("next", minute + THROUGHPUT_BUCKET_MS + 10);
        expect(
          await driver.completeJob(
            tq,
            "next",
            token,
            null,
            { ttl: 60_000 },
            minute + THROUGHPUT_BUCKET_MS + 10,
          ),
        ).toBe(true);

        // A batch completion counts each job it settled — two per statement
        // here, kept and removed alike, so a count of one per statement shows.
        const third = minute + 2 * THROUGHPUT_BUCKET_MS;
        const batch = [
          { id: "b1", result: 1, retention: false },
          { id: "b2", result: 2, retention: false },
          { id: "b3", result: 3, retention: true },
          { id: "b4", result: 4, retention: true },
        ] as const;
        for (const [index, one] of batch.entries()) {
          await claimOne(one.id, third + 1 + index);
        }
        const settled: string[] = [];
        if (driver.completeJobs) {
          settled.push(
            ...(await driver.completeJobs(
              tq,
              token,
              [...batch, { id: "not-mine", result: 5, retention: false }],
              third + 10,
            )),
          );
        } else {
          for (const one of batch) {
            if (
              await driver.completeJob(
                tq,
                one.id,
                token,
                one.result,
                one.retention,
                third + 10,
              )
            ) {
              settled.push(one.id);
            }
          }
        }
        expect(settled.sort()).toEqual(["b1", "b2", "b3", "b4"]);

        expect(
          await driver.getThroughput!(tq, { from: minute, to: third }),
        ).toEqual([
          { at: minute, completed: 2, failed: 2 },
          { at: minute + THROUGHPUT_BUCKET_MS, completed: 1, failed: 0 },
          { at: third, completed: 4, failed: 0 },
        ]);

        // `from` and `to` bound minutes by their start.
        expect(
          await driver.getThroughput!(tq, {
            from: minute + 1,
            to: third - 1,
          }),
        ).toEqual([
          { at: minute + THROUGHPUT_BUCKET_MS, completed: 1, failed: 0 },
        ]);
        expect(
          await driver.getThroughput!(
            { ns: other, queue: tq.queue },
            { from: minute, to: third },
          ),
        ).toEqual([]);
      });

      it("drops throughput minutes past the retention", async () => {
        const tq: QueueRef = { ns, queue: "throughput-retention" };
        const latest = throughputBucket(Date.now());
        const expired =
          latest - THROUGHPUT_RETENTION_MS - 5 * THROUGHPUT_BUCKET_MS;
        const kept =
          latest - THROUGHPUT_RETENTION_MS + 2 * THROUGHPUT_BUCKET_MS;
        const token = newToken();

        for (const [id, at] of [
          ["expired", expired],
          ["kept", kept],
          ["latest", latest],
        ] as const) {
          await driver.addJob(tq, makeJob({ id, createdAt: at, runAt: at }));
          await driver.claimJob(tq, {
            workerId: "w",
            token,
            lockMs: 60_000,
            now: at,
          });
          expect(await driver.completeJob(tq, id, token, null, false, at)).toBe(
            true,
          );
        }

        expect(
          await driver.getThroughput!(tq, { from: expired, to: latest }),
        ).toEqual([
          { at: kept, completed: 1, failed: 0 },
          { at: latest, completed: 1, failed: 0 },
        ]);
      });

      it("counts every queue in a namespace in one call, and the fallback agrees", async () => {
        const scope = testNamespace("counts");
        const now = Date.now();

        await driver.addJobs({ ns: scope, queue: "alpha" }, [
          makeJob({ id: "a1" }),
          makeJob({ id: "a2" }),
          makeJob({ id: "a3", state: "completed", finishedOn: now }),
        ]);
        await driver.addJob(
          { ns: scope, queue: "beta" },
          makeJob({ id: "b1", state: "dead", finishedOn: now }),
        );
        await driver.addJob(
          { ns: other, queue: "alpha" },
          makeJob({ id: "o1" }),
        );

        const want = new Map([
          ["alpha", { ...emptyCounts(), waiting: 2, completed: 1 }],
          ["beta", { ...emptyCounts(), dead: 1 }],
        ]);

        expect(await countQueues(driver, scope)).toEqual(want);
        expect(await countQueues(without(["countJobsByQueue"]), scope)).toEqual(
          want,
        );

        if (driver.countJobsByQueue) {
          expect(await driver.countJobsByQueue(scope)).toEqual({
            alpha: want.get("alpha")!,
            beta: want.get("beta")!,
          });
        }

        await driver.purge(scope);
      });

      it("counts jobs the stalled sweep buries, and parents a child's failure buries, as failed", async () => {
        const bq: QueueRef = { ns, queue: "throughput-burials" };
        const minute = throughputBucket(Date.now()) - 5 * THROUGHPUT_BUCKET_MS;
        const token = newToken();
        const error = serializeError(new Error("child failed"));

        // Two stalled jobs: the first sweep requeues one, which is no failure;
        // the second buries the other, which is.
        await driver.addJobs(bq, [
          makeJob({ id: "s1", createdAt: minute, runAt: minute }),
          makeJob({ id: "s2", createdAt: minute + 1, runAt: minute + 1 }),
        ]);
        for (let claimed = 0; claimed < 2; claimed++) {
          await driver.claimJob(bq, {
            workerId: "w",
            token,
            lockMs: 1_000,
            now: minute + 10,
          });
        }
        expect(
          (await driver.recoverStalled(bq, minute + 5_000, 5, 1)).requeued,
        ).toHaveLength(1);
        expect(
          (await driver.recoverStalled(bq, minute + 5_000, 0, 10)).dead,
        ).toHaveLength(1);

        // A parent buried by a failed child, the next minute. The same failure
        // recorded again changes nothing, and counts nothing.
        const next = minute + THROUGHPUT_BUCKET_MS;
        const parent = makeJob({ id: "parent", createdAt: next, runAt: next });
        parent.state = "waiting-children";
        parent.flow = {
          parent: null,
          children: [{ queue: bq.queue, id: "kid" }],
          pending: 1,
          values: {},
          failures: {},
          recorded: false,
        };
        await driver.addJob(bq, parent);
        const kid = { queue: bq.queue, id: "kid" };
        const outcome = { completed: false, error, ignored: false } as const;
        expect(
          await driver.recordChild!(bq, "parent", kid, outcome, next + 10),
        ).toBe("buried");
        expect(
          await driver.recordChild!(bq, "parent", kid, outcome, next + 20),
        ).not.toBe("buried");

        expect(
          await driver.getThroughput!(bq, { from: minute, to: next }),
        ).toEqual([
          { at: minute, completed: 0, failed: 1 },
          { at: next, completed: 0, failed: 1 },
        ]);
      });

      it("waits out a throughput write in flight before purging the namespace", async () => {
        const scope = testNamespace("purge-inflight");
        const now = Date.now();
        const token = newToken();
        const queues = Array.from(
          { length: 40 },
          (_, index): QueueRef => ({ ns: scope, queue: `q${index}` }),
        );

        for (const target of queues) {
          await driver.addJob(
            target,
            makeJob({ id: "j", createdAt: now - 1, runAt: now - 1 }),
          );
          await driver.claimJob(target, {
            workerId: "w",
            token,
            lockMs: 60_000,
            now,
          });
          expect(
            await driver.completeJob(target, "j", token, null, false, now),
          ).toBe(true);
        }

        // A write of every queue's count starts and is not awaited. The purge
        // has to wait for it, or rows it lands after the deletes bring the
        // namespace back.
        const flushing = driver.flushThroughput?.().catch(() => undefined);
        await driver.purge(scope);
        await flushing;

        const range = {
          from: throughputBucket(now),
          to: throughputBucket(now),
        };
        for (const target of queues) {
          expect(await driver.getThroughput!(target, range)).toEqual([]);
        }
        await driver.purge(scope);
      });

      it("purges worker records and throughput with the namespace", async () => {
        const scope = testNamespace("read-purge");
        const pq: QueueRef = { ns: scope, queue: "q" };
        const now = Date.now();
        const token = newToken();

        await registerWorkerRecord(driver, pq, workerRecord(pq, "w", now));
        await driver.addJob(
          pq,
          makeJob({ id: "j", createdAt: now - 1, runAt: now - 1 }),
        );
        await driver.claimJob(pq, {
          workerId: "w",
          token,
          lockMs: 60_000,
          now,
        });
        expect(await driver.completeJob(pq, "j", token, null, false, now)).toBe(
          true,
        );

        const range = {
          from: throughputBucket(now),
          to: throughputBucket(now),
        };
        expect(await driver.getThroughput!(pq, range)).toHaveLength(1);

        await driver.purge(scope);

        expect(await listWorkerRecords(driver, pq, now)).toEqual([]);
        expect(await driver.getThroughput!(pq, range)).toEqual([]);
      });

      it("forgets throughput not yet written when the namespace is purged", async () => {
        const scope = testNamespace("purge-pending");
        const pq: QueueRef = { ns: scope, queue: "q" };
        const now = Date.now();
        const token = newToken();

        await driver.addJob(
          pq,
          makeJob({ id: "j", createdAt: now - 1, runAt: now - 1 }),
        );
        await driver.claimJob(pq, {
          workerId: "w",
          token,
          lockMs: 60_000,
          now,
        });
        expect(await driver.completeJob(pq, "j", token, null, false, now)).toBe(
          true,
        );

        // No read in between, so a driver that gathers counts in memory still
        // holds this one. Purging must drop it, or the next write brings the
        // purged queue's counts back.
        await driver.purge(scope);

        const range = {
          from: throughputBucket(now),
          to: throughputBucket(now),
        };
        expect(await driver.getThroughput!(pq, range)).toEqual([]);
        await driver.purge(scope);
      });
    });

    describe("job attribution", () => {
      /**
       * A queue of this case's own, named after it: every claim here is
       * untargeted, so two cases sharing a queue would claim each other's jobs
       * in whatever order the runner picked. They live in `ns`, which the
       * contract's `afterAll` purges.
       */
      function scope(name: string): QueueRef {
        return { ns, queue: `attr-${name}` };
      }

      /** One worker's identity, as the worker passes it to the claim. */
      const ALPHA = { key: "svc.emails", host: "host-a", pid: 101 };
      /** A second worker on the same queue, under another key. */
      const BRAVO = { key: "svc.emails.b", host: "host-b", pid: 202 };

      /** A failure to settle with. */
      const failure = serializeError(new Error("attribution"));

      /**
       * Claims the only claimable job of `q`, which must be `id`, as `workerId`
       * — with `worker` stamped when given — and answers the record and token.
       */
      async function claimAs(
        q: QueueRef,
        id: string,
        workerId: string,
        worker: typeof ALPHA | undefined,
        now: number,
        lockMs = 30_000,
      ): Promise<{ record: JobRecord; token: string }> {
        const token = newToken();
        const record = await driver.claimJob(q, {
          workerId,
          token,
          lockMs,
          now,
          ...(worker ? { worker } : {}),
        });
        expect(record?.id).toBe(id);
        return { record: record!, token };
      }

      /** Whether the probe found this backend recording attribution; `undefined` before it ran. */
      let recorded: boolean | undefined;

      /**
       * Whether this backend records attribution — probed once, and
       * all-or-nothing.
       *
       * The feature is optional so a driver without it keeps working, with
       * `features.jobAttribution: false` and the filters answered by scan. A
       * driver whose claim leaves `processedBy` absent, and that does not
       * declare the capability, has opted out, and only the cases every
       * backend must pass run against it. Anything else — a stamp of any
       * shape, `null`, or the capability declared — is a driver that records
       * attribution, and every case below holds it to all of it, so one that
       * stamps but clears on settle, or stamps but ignores the filters, fails
       * here by name rather than somewhere obscure.
       *
       * The probe claims on a queue of its own, so whichever case runs first
       * (the suite must pass under `--randomize`) leaves nothing behind for
       * another to trip over.
       */
      async function attribution(): Promise<boolean> {
        if (recorded !== undefined) {
          return recorded;
        }

        const q = scope("probe");
        const now = Date.now();
        await driver.addJob(q, makeJob({ id: "probe", runAt: now }));
        const { record, token } = await claimAs(
          q,
          "probe",
          "probe-w",
          ALPHA,
          now,
        );
        await driver.completeJob(q, "probe", token, null, true, now);

        const declared = driver.capabilities.jobAttribution === true;
        recorded = declared || record.processedBy !== undefined;

        if (recorded) {
          expect(record.processedBy).toEqual({ id: "probe-w", ...ALPHA });
        }

        return recorded;
      }

      /**
       * The ways a page is read here: the queue's own entry point, the scan
       * fallback, and — on a backend that records attribution — its native
       * `findJobs` called directly, which is the method a capability declares
       * and which the capability gate would otherwise keep these cases from
       * reaching until the route serves the filters.
       */
      async function finders(): Promise<
        [string, (target: QueueRef, query: JobQuery) => Promise<JobPage>][]
      > {
        const list: [
          string,
          (target: QueueRef, query: JobQuery) => Promise<JobPage>,
        ][] = [
          [
            "findJobPage",
            async (target, query) => await findJobPage(driver, target, query),
          ],
          [
            "scan fallback",
            async (target, query) =>
              await findJobsByScan(driver, target, query),
          ],
        ];

        if ((await attribution()) && driver.findJobs) {
          const native = driver.findJobs.bind(driver);
          list.push([
            "native findJobs",
            async (target, query) => await native(target, query),
          ]);
        }

        return list;
      }

      /** The ids a query answers, as the finder orders them, with its total. */
      async function idsOf(
        find: (target: QueueRef, query: JobQuery) => Promise<JobPage>,
        target: QueueRef,
        query: Partial<JobQuery> & Pick<JobQuery, "states">,
      ): Promise<{ ids: string[]; total: number | undefined }> {
        const page = await find(target, {
          offset: 0,
          limit: 100,
          order: "asc",
          total: true,
          ...query,
        });
        return { ids: page.jobs.map((job) => job.id), total: page.total };
      }

      it("stamps who claimed it, and a driver without the feature stamps nothing", async () => {
        const q = scope("stamp");
        const now = Date.now();
        await driver.addJobs(q, [
          makeJob({ id: "with-worker", runAt: now, createdAt: now }),
          makeJob({ id: "id-only", runAt: now, createdAt: now + 1 }),
        ]);

        const first = await claimAs(q, "with-worker", "alpha-1", ALPHA, now);
        const second = await claimAs(
          q,
          "id-only",
          "old-worker",
          undefined,
          now,
        );

        if (!(await attribution())) {
          // Opted out: nothing appears anywhere, settled or not.
          expect(first.record.processedBy).toBeUndefined();
          await driver.completeJob(
            q,
            "with-worker",
            first.token,
            null,
            false,
            now,
          );
          expect(
            (await driver.getJob(q, "with-worker"))?.processedBy ?? null,
          ).toBeNull();
          return;
        }

        // The claim answers with the stamp, and a read agrees with it.
        expect(first.record.processedBy).toEqual({ id: "alpha-1", ...ALPHA });
        expect(first.record.workerId).toBe("alpha-1");
        expect((await driver.getJob(q, "with-worker"))?.processedBy).toEqual({
          id: "alpha-1",
          ...ALPHA,
        });

        // An older worker, which names no key, is still attributed by id.
        expect(second.record.processedBy).toEqual({ id: "old-worker" });
        expect((await driver.getJob(q, "id-only"))?.processedBy).toEqual({
          id: "old-worker",
        });

        // A job never claimed has no stamp.
        await driver.addJob(
          q,
          makeJob({ id: "unclaimed", runAt: now + 60_000, state: "delayed" }),
        );
        expect(
          (await driver.getJob(q, "unclaimed"))?.processedBy ?? null,
        ).toBeNull();
      });

      it("stamps on the plural claim too", async () => {
        if (!(await attribution()) || !driver.claimJobs) {
          return;
        }

        const q = scope("stamp-plural");
        const now = Date.now();
        await driver.addJobs(q, [
          makeJob({ id: "p-1", runAt: now, createdAt: now }),
          makeJob({ id: "p-2", runAt: now, createdAt: now + 1 }),
        ]);

        const claimed = await driver.claimJobs(
          q,
          {
            workerId: "bravo-1",
            worker: BRAVO,
            token: newToken(),
            lockMs: 30_000,
            now,
          },
          10,
        );

        expect(claimed.map((job) => job.id).sort()).toEqual(["p-1", "p-2"]);
        for (const job of claimed) {
          expect(job.processedBy).toEqual({ id: "bravo-1", ...BRAVO });
          expect((await driver.getJob(q, job.id))?.processedBy).toEqual({
            id: "bravo-1",
            ...BRAVO,
          });
        }
      });

      it("keeps it after completion, and clears only workerId", async () => {
        if (!(await attribution())) {
          return;
        }

        const q = scope("complete");
        const now = Date.now();
        await driver.addJob(q, makeJob({ id: "done", runAt: now }));
        const { token } = await claimAs(q, "done", "alpha-1", ALPHA, now);

        expect(
          await driver.completeJob(q, "done", token, "ok", false, now + 5),
        ).toBe(true);

        const settled = await driver.getJob(q, "done");
        expect(settled).toMatchObject({
          state: "completed",
          finishedOn: now + 5,
          workerId: null,
          lockToken: null,
        });
        expect(settled?.processedBy).toEqual({ id: "alpha-1", ...ALPHA });
      });

      it("keeps it after a batched completion", async () => {
        if (!(await attribution()) || !driver.completeJobs) {
          return;
        }

        const q = scope("complete-batch");
        const now = Date.now();
        await driver.addJobs(q, [
          makeJob({ id: "b-1", runAt: now, createdAt: now }),
          makeJob({ id: "b-2", runAt: now, createdAt: now + 1 }),
        ]);
        const token = newToken();
        const options = {
          workerId: "alpha-1",
          worker: ALPHA,
          token,
          lockMs: 30_000,
          now,
        };
        await driver.claimJob(q, options);
        await driver.claimJob(q, options);

        const settled = await driver.completeJobs(
          q,
          token,
          [
            { id: "b-1", result: 1, retention: false },
            { id: "b-2", result: 2, retention: false },
          ],
          now + 5,
        );
        expect(settled.sort()).toEqual(["b-1", "b-2"]);

        for (const id of ["b-1", "b-2"]) {
          const job = await driver.getJob(q, id);
          expect(job).toMatchObject({ state: "completed", workerId: null });
          expect(job?.processedBy).toEqual({ id: "alpha-1", ...ALPHA });
        }
      });

      it("keeps it after a failure, retrying or final", async () => {
        if (!(await attribution())) {
          return;
        }

        const q = scope("fail");
        const now = Date.now();
        await driver.addJobs(q, [
          makeJob({ id: "retries", runAt: now, createdAt: now }),
          makeJob({ id: "dies", runAt: now, createdAt: now + 1 }),
        ]);

        const retry = await claimAs(q, "retries", "alpha-1", ALPHA, now);
        const final = await claimAs(q, "dies", "bravo-1", BRAVO, now);

        await driver.failJob(
          q,
          "retries",
          retry.token,
          failure,
          { retry: true, runAt: now + 60_000 },
          now,
          3,
        );
        await driver.failJob(
          q,
          "dies",
          final.token,
          failure,
          { retry: false, retention: false },
          now + 7,
          3,
        );

        const retrying = await driver.getJob(q, "retries");
        expect(retrying).toMatchObject({
          state: "failed",
          workerId: null,
          finishedOn: null,
        });
        expect(retrying?.processedBy).toEqual({ id: "alpha-1", ...ALPHA });

        const dead = await driver.getJob(q, "dies");
        expect(dead).toMatchObject({
          state: "dead",
          workerId: null,
          finishedOn: now + 7,
        });
        expect(dead?.processedBy).toEqual({ id: "bravo-1", ...BRAVO });
      });

      it("keeps it after a bury, and hands it back with the buried record", async () => {
        const bury = driver.buryJob?.bind(driver);
        if (!(await attribution()) || !bury) {
          return;
        }

        const q = scope("bury");
        const now = Date.now();
        await driver.addJob(q, makeJob({ id: "buried", runAt: now }));
        const { token } = await claimAs(q, "buried", "alpha-1", ALPHA, now);

        const buried = await bury(
          q,
          "buried",
          failure,
          { retention: false, keepStacktraces: 3, token },
          now + 3,
        );
        expect(buried?.state).toBe("dead");
        expect(buried?.processedBy).toEqual({ id: "alpha-1", ...ALPHA });

        const read = await driver.getJob(q, "buried");
        expect(read).toMatchObject({ state: "dead", workerId: null });
        expect(read?.processedBy).toEqual({ id: "alpha-1", ...ALPHA });
      });

      it("keeps the dead worker's stamp through stall recovery, requeued or buried", async () => {
        if (!(await attribution())) {
          return;
        }

        const q = scope("stalled");
        const now = Date.now();
        await driver.addJob(q, makeJob({ id: "stalls", runAt: now }));
        await claimAs(q, "stalls", "alpha-1", ALPHA, now, 10);

        expect(
          (await driver.recoverStalled(q, now + 1000, 1, 10)).requeued,
        ).toEqual(["stalls"]);
        const requeued = await driver.getJob(q, "stalls");
        expect(requeued).toMatchObject({ state: "waiting", workerId: null });
        // "Last touched by the worker that died" — until the next claim.
        expect(requeued?.processedBy).toEqual({ id: "alpha-1", ...ALPHA });

        await claimAs(q, "stalls", "bravo-1", BRAVO, now + 1000, 10);
        expect(
          (await driver.recoverStalled(q, now + 2000, 1, 10)).dead,
        ).toEqual(["stalls"]);
        const dead = await driver.getJob(q, "stalls");
        expect(dead).toMatchObject({ state: "dead", workerId: null });
        expect(dead?.processedBy).toEqual({ id: "bravo-1", ...BRAVO });
      });

      it("names only the last attempt's worker, and filters by it alone", async () => {
        if (!(await attribution())) {
          return;
        }

        const q = scope("last-attempt");
        const now = Date.now();
        await driver.addJob(
          q,
          makeJob({ id: "moves", runAt: now, maxAttempts: 3 }),
        );

        const first = await claimAs(q, "moves", "alpha-1", ALPHA, now);
        await driver.failJob(
          q,
          "moves",
          first.token,
          failure,
          { retry: true, runAt: now + 60_000 },
          now,
          3,
        );
        expect(await driver.promoteJob(q, "moves", now + 1)).toBe(true);
        // Promoted but not yet claimed: still the worker whose attempt failed.
        expect((await driver.getJob(q, "moves"))?.processedBy).toEqual({
          id: "alpha-1",
          ...ALPHA,
        });

        const second = await claimAs(q, "moves", "bravo-1", BRAVO, now + 2);
        expect(second.record.processedBy).toEqual({ id: "bravo-1", ...BRAVO });
        await driver.completeJob(
          q,
          "moves",
          second.token,
          null,
          false,
          now + 3,
        );

        // Only the second worker, whole: no field of the first survives.
        expect((await driver.getJob(q, "moves"))?.processedBy).toEqual({
          id: "bravo-1",
          ...BRAVO,
        });

        // A manual retry keeps it too, until a claim replaces it.
        expect(await driver.retryJob(q, "moves", false, now + 4)).toBe(true);
        expect((await driver.getJob(q, "moves"))?.processedBy).toEqual({
          id: "bravo-1",
          ...BRAVO,
        });
        const third = await claimAs(q, "moves", "alpha-2", undefined, now + 5);
        // An id-only claim replaces the whole stamp; the old key does not linger.
        expect(third.record.processedBy).toEqual({ id: "alpha-2" });
        await driver.completeJob(q, "moves", third.token, null, false, now + 6);

        for (const [, find] of await finders()) {
          expect(
            (
              await idsOf(find, q, {
                states: ["completed"],
                workerKeys: [BRAVO.key],
              })
            ).ids,
          ).toEqual([]);
          expect(
            (
              await idsOf(find, q, {
                states: ["completed"],
                workerKeys: [ALPHA.key],
              })
            ).ids,
          ).toEqual([]);
          expect(
            (
              await idsOf(find, q, {
                states: ["completed"],
                workerIds: ["bravo-1"],
              })
            ).ids,
          ).toEqual([]);
          expect(
            (
              await idsOf(find, q, {
                states: ["completed"],
                workerIds: ["alpha-2"],
              })
            ).ids,
          ).toEqual(["moves"]);
        }
      });

      it("keeps a stamp a record is added with", async () => {
        if (!(await attribution())) {
          return;
        }

        const q = scope("restore");
        // A record restored from elsewhere, already finished: the drivers that
        // write only a fresh job's fields must notice this one is not fresh.
        const restored = makeJob({
          id: "restored",
          state: "completed",
          finishedOn: 1_700_000_004_000,
          processedOn: 1_700_000_003_000,
          attemptsMade: 1,
          processedBy: {
            id: "old-1",
            key: "old.key",
            host: "old-host",
            pid: 7,
          },
        });

        expect((await driver.addJob(q, restored)).added).toBe(true);
        expect(await driver.getJob(q, "restored")).toEqual(restored);
        if (driver.getJobs) {
          expect(
            (await driver.getJobs(q, ["restored"]))[0]?.processedBy,
          ).toEqual(restored.processedBy);
        }
        expect(
          (
            await driver.listJobs(q, ["completed"], {
              offset: 0,
              limit: 10,
              order: "asc",
            })
          )[0]?.processedBy,
        ).toEqual(restored.processedBy);
      });

      it("filters by worker key and id, exactly, ANDed with state, name and search", async () => {
        if (!(await attribution())) {
          return;
        }

        const q = scope("filters");
        const now = Date.now();
        // Five jobs: claimed by alpha, bravo, a keyless old worker, and a
        // key differing only in case; one never claimed. Names and states
        // vary so every filter has something to exclude.
        const seeds: [
          string,
          string,
          string | undefined,
          typeof ALPHA | undefined,
        ][] = [
          ["a-send", "send", "alpha-1", ALPHA],
          ["a-report", "report", "alpha-2", ALPHA],
          ["b-send", "send", "bravo-1", BRAVO],
          ["keyless", "send", "old-worker", undefined],
          [
            "cased",
            "send",
            "cased-1",
            { key: "SVC.EMAILS", host: "h", pid: 1 },
          ],
        ];
        for (const [index, [id, name]] of seeds.entries()) {
          await driver.addJob(
            q,
            makeJob({ id, name, runAt: now, createdAt: now + index }),
          );
        }
        await driver.addJob(
          q,
          makeJob({
            id: "never",
            name: "send",
            runAt: now + 60_000,
            state: "delayed",
            createdAt: now + 10,
          }),
        );

        for (const [id, , workerId, worker] of seeds) {
          const { token } = await claimAs(q, id, workerId!, worker, now);
          // Two settle, the rest stay active, so state has something to split.
          if (id === "a-send" || id === "b-send") {
            await driver.completeJob(q, id, token, null, false, now + 1);
          }
        }

        const ALL: JobState[] = [
          "waiting",
          "delayed",
          "active",
          "completed",
          "failed",
          "dead",
        ];

        for (const [label, find] of await finders()) {
          const ids = async (query: Partial<JobQuery>): Promise<string[]> =>
            (await idsOf(find, q, { states: ALL, ...query })).ids.sort();

          expect(await ids({ workerKeys: [ALPHA.key] }), label).toEqual([
            "a-report",
            "a-send",
          ]);
          expect(
            await ids({ workerKeys: [ALPHA.key, BRAVO.key] }),
            label,
          ).toEqual(["a-report", "a-send", "b-send"]);
          // Exact: no prefix, no case folding, and a keyless stamp never matches a key.
          expect(await ids({ workerKeys: ["svc"] }), label).toEqual([]);
          expect(await ids({ workerKeys: ["SVC.EMAILS"] }), label).toEqual([
            "cased",
          ]);
          expect(await ids({ workerKeys: [] }), label).toEqual([]);
          expect(await ids({ workerIds: ["old-worker"] }), label).toEqual([
            "keyless",
          ]);
          expect(
            await ids({ workerIds: ["alpha-1", "bravo-1"] }),
            label,
          ).toEqual(["a-send", "b-send"]);
          expect(await ids({ workerIds: [] }), label).toEqual([]);
          expect(await ids({ workerIds: ["alpha"] }), label).toEqual([]);

          // ANDed with each other and with state, name and search.
          expect(
            await ids({
              workerKeys: [ALPHA.key],
              workerIds: ["alpha-2", "bravo-1"],
            }),
            label,
          ).toEqual(["a-report"]);
          expect(
            await ids({ workerKeys: [ALPHA.key], states: ["completed"] }),
            label,
          ).toEqual(["a-send"]);
          expect(
            await ids({ workerKeys: [ALPHA.key], states: ["active"] }),
            label,
          ).toEqual(["a-report"]);
          expect(
            await ids({ workerKeys: [ALPHA.key, BRAVO.key], names: ["send"] }),
            label,
          ).toEqual(["a-send", "b-send"]);
          expect(
            await ids({ workerKeys: [ALPHA.key, BRAVO.key], search: "B-S" }),
            label,
          ).toEqual(["b-send"]);

          // The total counts matches, not the page.
          const paged = await find(q, {
            states: ALL,
            offset: 1,
            limit: 1,
            order: "asc",
            total: true,
            workerKeys: [ALPHA.key, BRAVO.key],
          });
          expect(paged.jobs, label).toHaveLength(1);
          expect(paged.total, label).toBe(3);
        }
      });

      it("ranges over finishedOn, inclusive from and exclusive to, on every backend", async () => {
        // No stamp is needed for a range, so every backend answers it — through
        // the scan when it does not declare the capability.
        const q = scope("range");
        const base = 1_700_000_000_000;
        const seeds: JobRecord[] = [
          makeJob({
            id: "c-0",
            state: "completed",
            createdAt: base,
            finishedOn: base + 1000,
          }),
          makeJob({
            id: "c-1",
            state: "completed",
            createdAt: base + 1,
            finishedOn: base + 2000,
          }),
          makeJob({
            id: "c-2",
            state: "completed",
            createdAt: base + 2,
            finishedOn: base + 3000,
          }),
          makeJob({
            id: "d-1",
            state: "dead",
            createdAt: base + 3,
            finishedOn: base + 2000,
          }),
          // Unfinished: none of these has a `finishedOn`, so no range matches them.
          makeJob({
            id: "w-0",
            state: "waiting",
            createdAt: base + 4,
            runAt: base,
          }),
          makeJob({
            id: "l-0",
            state: "delayed",
            createdAt: base + 5,
            runAt: base + 9_999_999_999,
          }),
          makeJob({
            id: "f-0",
            state: "failed",
            createdAt: base + 6,
            runAt: base + 9_999_999_999,
            attemptsMade: 1,
          }),
        ];
        await driver.addJobs(q, seeds);

        const EVERY: JobState[] = [
          "waiting",
          "delayed",
          "active",
          "completed",
          "failed",
          "dead",
        ];

        for (const [label, find] of await finders()) {
          const ids = async (query: Partial<JobQuery>): Promise<string[]> =>
            (await idsOf(find, q, { states: EVERY, ...query })).ids.sort();

          // `from` is inclusive: a job finishing exactly on it is in.
          expect(await ids({ finishedFrom: base + 2000 }), label).toEqual([
            "c-1",
            "c-2",
            "d-1",
          ]);
          // `to` is exclusive: a job finishing exactly on it is out.
          expect(await ids({ finishedTo: base + 2000 }), label).toEqual([
            "c-0",
          ]);
          expect(
            await ids({ finishedFrom: base + 1000, finishedTo: base + 3000 }),
            label,
          ).toEqual(["c-0", "c-1", "d-1"]);
          expect(
            await ids({ finishedFrom: base + 2000, finishedTo: base + 2001 }),
            label,
          ).toEqual(["c-1", "d-1"]);
          // An empty or inverted range matches nothing.
          expect(
            await ids({ finishedFrom: base + 2000, finishedTo: base + 2000 }),
            label,
          ).toEqual([]);
          expect(
            await ids({ finishedFrom: base + 3000, finishedTo: base + 1000 }),
            label,
          ).toEqual([]);
          // A range as wide as time still leaves out every unfinished job.
          expect(await ids({ finishedFrom: 0 }), label).toEqual([
            "c-0",
            "c-1",
            "c-2",
            "d-1",
          ]);
          expect(
            await ids({ finishedTo: Number.MAX_SAFE_INTEGER }),
            label,
          ).toEqual(["c-0", "c-1", "c-2", "d-1"]);
          expect(
            await ids({
              finishedFrom: 0,
              states: ["waiting", "delayed", "failed"],
            }),
            label,
          ).toEqual([]);

          // ANDed with state and name, and in the state's natural order.
          const completed = await idsOf(find, q, {
            states: ["completed"],
            finishedFrom: base + 1500,
          });
          expect(completed.ids, label).toEqual(["c-1", "c-2"]);
          expect(completed.total, label).toBe(2);
          const desc = await idsOf(find, q, {
            states: ["completed"],
            finishedFrom: 0,
            order: "desc",
          });
          expect(desc.ids, label).toEqual(["c-2", "c-1", "c-0"]);
          expect(
            await ids({ finishedFrom: 0, names: ["nope"] }),
            label,
          ).toEqual([]);
        }
      });

      it("carries finishedOn on completed and dead jobs only, which is what a range relies on", async () => {
        // Every backend, stamp or not: the range filter is defined over
        // `finishedOn` and assumes only `completed` and `dead` carry it
        // (`JobDto.finishedOn`'s contract). A failure here is a finding for
        // that backend's unit, not for the filter.
        const q = scope("finished-on");
        const now = Date.now();
        await driver.addJobs(q, [
          makeJob({
            id: "retrying",
            runAt: now,
            createdAt: now,
            maxAttempts: 3,
          }),
          makeJob({ id: "exhausted", runAt: now, createdAt: now + 1 }),
          makeJob({ id: "completes", runAt: now, createdAt: now + 2 }),
        ]);

        const retrying = await claimAs(q, "retrying", "alpha-1", ALPHA, now);
        const exhausted = await claimAs(q, "exhausted", "alpha-1", ALPHA, now);
        const completes = await claimAs(q, "completes", "alpha-1", ALPHA, now);

        await driver.failJob(
          q,
          "retrying",
          retrying.token,
          failure,
          { retry: true, runAt: now + 60_000 },
          now + 1,
          3,
        );
        await driver.failJob(
          q,
          "exhausted",
          exhausted.token,
          failure,
          { retry: false, retention: false },
          now + 2,
          3,
        );
        await driver.completeJob(
          q,
          "completes",
          completes.token,
          null,
          false,
          now + 3,
        );

        const pending = await driver.getJob(q, "retrying");
        expect(
          pending?.state,
          "a failure with a retry left must be `failed`",
        ).toBe("failed");
        expect(
          pending?.finishedOn ?? null,
          "a `failed` job (retry pending) must have finishedOn null — only completed/dead carry it",
        ).toBeNull();

        const dead = await driver.getJob(q, "exhausted");
        expect(
          dead?.state,
          "a failure of the last attempt must be `dead`",
        ).toBe("dead");
        expect(
          dead?.finishedOn,
          "a `dead` job must carry finishedOn — the time it died",
        ).toBe(now + 2);

        const done = await driver.getJob(q, "completes");
        expect(done?.state).toBe("completed");
        expect(
          done?.finishedOn,
          "a `completed` job must carry finishedOn",
        ).toBe(now + 3);

        const EVERY: JobState[] = [
          "waiting",
          "delayed",
          "active",
          "completed",
          "failed",
          "dead",
        ];
        const wide = { finishedFrom: 0, finishedTo: Number.MAX_SAFE_INTEGER };

        for (const [label, find] of await finders()) {
          expect(
            (await idsOf(find, q, { states: EVERY, ...wide })).ids.sort(),
            `${label}: a retry-pending job must never match a finishedOn range`,
          ).toEqual(["completes", "exhausted"]);
        }

        expect(await driver.retryJob(q, "exhausted", false, now + 4)).toBe(
          true,
        );
        const revived = await driver.getJob(q, "exhausted");
        expect(revived?.state).toBe("waiting");
        expect(
          revived?.finishedOn ?? null,
          "a `dead` job retried back to `waiting` must have finishedOn null again",
        ).toBeNull();

        for (const [label, find] of await finders()) {
          expect(
            (await idsOf(find, q, { states: EVERY, ...wide })).ids,
            `${label}: a job retried out of \`dead\` must no longer match a finishedOn range`,
          ).toEqual(["completes"]);
        }
      });

      it("ranges and filters by worker together", async () => {
        if (!(await attribution())) {
          return;
        }

        const q = scope("range-worker");
        const now = Date.now();
        await driver.addJobs(q, [
          makeJob({ id: "early", runAt: now, createdAt: now }),
          makeJob({ id: "late", runAt: now, createdAt: now + 1 }),
          makeJob({ id: "other", runAt: now, createdAt: now + 2 }),
        ]);
        const early = await claimAs(q, "early", "alpha-1", ALPHA, now);
        await driver.completeJob(
          q,
          "early",
          early.token,
          null,
          false,
          now + 10,
        );
        const late = await claimAs(q, "late", "alpha-1", ALPHA, now);
        await driver.completeJob(q, "late", late.token, null, false, now + 20);
        const other = await claimAs(q, "other", "bravo-1", BRAVO, now);
        await driver.completeJob(
          q,
          "other",
          other.token,
          null,
          false,
          now + 20,
        );

        for (const [label, find] of await finders()) {
          expect(
            (
              await idsOf(find, q, {
                states: ["completed"],
                workerKeys: [ALPHA.key],
                finishedFrom: now + 20,
              })
            ).ids,
            label,
          ).toEqual(["late"]);
          expect(
            (
              await idsOf(find, q, {
                states: ["completed"],
                workerKeys: [ALPHA.key],
                finishedTo: now + 20,
              })
            ).ids,
            label,
          ).toEqual(["early"]);
          expect(
            (
              await idsOf(find, q, {
                states: ["completed"],
                finishedFrom: now + 20,
              })
            ).ids.sort(),
            label,
          ).toEqual(["late", "other"]);
        }
      });

      it("never matches jobs of another queue or namespace", async () => {
        if (!(await attribution())) {
          return;
        }

        const mine = scope("isolation");
        const theirs = scope("isolation-theirs");
        const elsewhere: QueueRef = { ns: other, queue: mine.queue };
        const now = Date.now();

        for (const target of [mine, theirs, elsewhere]) {
          const id = `iso-${target === mine ? "mine" : target === theirs ? "theirs" : "elsewhere"}`;
          await driver.addJob(target, makeJob({ id, runAt: now }));
          const { token } = await claimAs(target, id, "alpha-1", ALPHA, now);
          await driver.completeJob(target, id, token, null, false, now + 1);
        }

        for (const [label, find] of await finders()) {
          const found = await idsOf(find, mine, {
            states: ["completed"],
            workerKeys: [ALPHA.key],
            workerIds: ["alpha-1"],
            finishedFrom: now,
          });
          expect(found.ids, label).toEqual(["iso-mine"]);
          expect(found.total, label).toBe(1);
        }
      });

      it("findJobPage trusts a driver's findJobs with the filters only when it declares the capability", async () => {
        // Every backend: a stand-in whose `findJobs` predates the fields and
        // ignores them, which is exactly the hole the capability closes.
        const q = scope("gate");
        const now = Date.now();
        await driver.addJobs(q, [
          makeJob({
            id: "g-done",
            state: "completed",
            createdAt: now,
            finishedOn: now + 1,
          }),
          makeJob({ id: "g-wait", createdAt: now + 1, runAt: now }),
        ]);

        const naive = (jobAttribution: boolean | undefined): JobsDriver =>
          new Proxy(driver, {
            get(target, property) {
              if (property === "capabilities") {
                return { ...target.capabilities, jobAttribution };
              }
              if (property === "findJobs") {
                // Honours states and names, knows nothing newer.
                return async (
                  ref: QueueRef,
                  query: JobQuery,
                ): Promise<JobPage> => {
                  const jobs = (
                    await target.listJobs(ref, query.states, {
                      offset: 0,
                      limit: 1000,
                      order: query.order,
                    })
                  ).filter(
                    (job) => !query.names || query.names.includes(job.name),
                  );
                  return { jobs, total: jobs.length };
                };
              }
              const value: unknown = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });

        const read = async (
          stand: JobsDriver,
          query: Partial<JobQuery>,
        ): Promise<string[]> => {
          const page = await findJobPage(stand, q, {
            states: ["waiting", "completed"],
            offset: 0,
            limit: 100,
            order: "asc",
            ...query,
          });
          return page.jobs.map((job) => job.id).sort();
        };

        for (const undeclared of [undefined, false]) {
          const stand = naive(undeclared);
          // Scanned, so answered correctly despite the stand-in.
          expect(await read(stand, { workerKeys: ["nobody"] })).toEqual([]);
          expect(await read(stand, { workerIds: [] })).toEqual([]);
          expect(await read(stand, { finishedFrom: now + 1 })).toEqual([
            "g-done",
          ]);
          // A query without them still goes to its `findJobs`.
          expect(await read(stand, { names: ["test"] })).toEqual([
            "g-done",
            "g-wait",
          ]);
        }

        // Declared: trusted, stale answer and all — the gate is the capability.
        expect(await read(naive(true), { workerKeys: ["nobody"] })).toEqual([
          "g-done",
          "g-wait",
        ]);
      });
    });

    describe("jobs by creation time", () => {
      /** Namespaces these cases made, purged at the end and nothing else with them. */
      const spaces: string[] = [];

      afterAll(async () => {
        for (const space of spaces) {
          await driver.purge(space);
        }
      });

      /**
       * A namespace of this case's own. `countAddedJobs` is namespace-wide, so
       * a case sharing `ns` with the rest of the contract would count every
       * other case's jobs too — and which of them exist depends on the order
       * `--randomize` picked.
       */
      function space(name: string): string {
        const created = testNamespace(`added-${name}`);
        spaces.push(created);
        return created;
      }

      /**
       * A fixed instant the cases build around: far in the past, so no
       * default retention or due time in any backend reacts to it, and never
       * read from a clock the driver could disagree with.
       */
      const T = 1_700_000_000_000;

      /** The failure a `failed` or `dead` record carries. */
      const failure = serializeError(new Error("added"));

      /**
       * A job in `state` created at `createdAt`, restored as such (every
       * backend's `addJob` takes a record in any state): each state's own
       * ordering key is set too, from `key`, so a case can make that key
       * disagree with creation order. `active` is not restorable everywhere,
       * so it is reached by claiming instead ({@link activate}).
       */
      function jobIn(
        state: Exclude<JobState, "active" | "waiting-children">,
        id: string,
        createdAt: number,
        key?: number,
      ): JobRecord {
        switch (state) {
          case "waiting":
            // Its key is the priority: a small integer, `0` by default.
            return makeJob({
              id,
              createdAt,
              runAt: createdAt,
              priority: key ?? 0,
            });
          case "delayed":
            return makeJob({ id, state, createdAt, runAt: key ?? createdAt });
          case "failed":
            return makeJob({
              id,
              state,
              createdAt,
              runAt: key ?? createdAt,
              attemptsMade: 1,
              maxAttempts: 3,
              failedReason: failure,
            });
          case "completed":
            return makeJob({
              id,
              state,
              createdAt,
              processedOn: key ?? createdAt,
              finishedOn: key ?? createdAt,
              attemptsMade: 1,
              returnValue: { ok: true },
            });
          case "dead":
            return makeJob({
              id,
              state,
              createdAt,
              processedOn: key ?? createdAt,
              finishedOn: key ?? createdAt,
              attemptsMade: 1,
              failedReason: failure,
            });
        }
      }

      /**
       * Adds a waiting job created at `createdAt` to a queue holding nothing
       * claimable, and claims it: the only way to an `active` job that every
       * backend shares.
       */
      async function activate(
        q: QueueRef,
        id: string,
        createdAt: number,
      ): Promise<string> {
        await driver.addJob(q, makeJob({ id, createdAt, runAt: createdAt }));
        const token = newToken();
        const claimed = await driver.claimJob(q, {
          workerId: "added-w",
          token,
          lockMs: 60_000,
          now: Date.now(),
        });
        expect(claimed?.id).toBe(id);
        return token;
      }

      /** `countAddedJobs`, bound — or `undefined` on a backend without it. */
      function counter(): JobsDriver["countAddedJobs"] {
        return driver.countAddedJobs?.bind(driver);
      }

      /**
       * What `countAddedJobs` must answer for a namespace, worked out
       * independently: every stored job of each queue, read through
       * `listJobs`, counted by the reference `countAddedByScan`. Queues with
       * none in the range are left out, which the driver may do too.
       */
      async function reference(
        target: string,
        queues: string[],
        range: AddedRange,
      ): Promise<Record<string, Record<JobState, number>>> {
        const answer: Record<string, Record<JobState, number>> = {};

        for (const queue of queues) {
          const all = await driver.listJobs(
            { ns: target, queue },
            [...JOB_STATES],
            {
              offset: 0,
              limit: 10_000,
              order: "asc",
            },
          );
          const counts = countAddedByScan(all, range);

          if (Object.values(counts).some((count) => count > 0)) {
            answer[queue] = counts;
          }
        }

        return answer;
      }

      /**
       * A driver's answer with the queues it reported that have nothing in
       * the range dropped — the contract lets it report those or not — after
       * asserting that every queue it did report carries every state.
       */
      function nonEmpty(
        answer: Record<string, Record<JobState, number>>,
      ): Record<string, Record<JobState, number>> {
        const kept: Record<string, Record<JobState, number>> = {};

        for (const [queue, counts] of Object.entries(answer)) {
          expect(Object.keys(counts).sort()).toEqual([...JOB_STATES].sort());
          for (const count of Object.values(counts)) {
            expect(Number.isInteger(count)).toBe(true);
          }
          if (Object.values(counts).some((count) => count > 0)) {
            kept[queue] = counts;
          }
        }

        return kept;
      }

      /** Counts for one queue: zeros, with `changes` on top. */
      function countsOf(
        changes: Partial<Record<JobState, number>>,
      ): Record<JobState, number> {
        return { ...emptyAddedCounts(), ...changes };
      }

      it("counts the jobs added in a range, by queue and by the state each is in now", async () => {
        const count = counter();
        if (!count) {
          // Opted out: the sort is not promised either, and the queue says so.
          expect(supportsCreatedSort(driver)).toBe(false);
          return;
        }

        const target = space("by-state");
        const alpha: QueueRef = { ns: target, queue: "alpha" };
        const beta: QueueRef = { ns: target, queue: "beta" };
        const range = { from: T, to: T + 10_000 };

        // Active first, while it is the only claimable job in its queue.
        await activate(alpha, "a-active", T + 1);
        await driver.addJobs(alpha, [
          jobIn("waiting", "a-wait-1", T + 2),
          jobIn("waiting", "a-wait-2", T + 3),
          jobIn("delayed", "a-delayed", T + 4, T + 999_999),
          jobIn("failed", "a-failed", T + 5, T + 999_999),
          jobIn("completed", "a-done-1", T + 6, T + 7_000),
          jobIn("completed", "a-done-2", T + 7, T + 8_000),
          jobIn("completed", "a-done-3", T + 8, T + 9_000),
          jobIn("dead", "a-dead", T + 9, T + 9_500),
          // Outside, both sides — including a job that finished *inside* the
          // range but was added before it: creation time is what counts.
          jobIn("completed", "a-before", T - 1, T + 5_000),
          jobIn("waiting", "a-after", T + 20_000),
        ]);
        await driver.addJobs(beta, [
          jobIn("waiting", "b-wait", T + 100),
          jobIn("dead", "b-dead", T + 200, T + 300),
          jobIn("dead", "b-old", T - 50_000, T + 400),
        ]);

        const expected = {
          alpha: countsOf({
            active: 1,
            waiting: 2,
            delayed: 1,
            failed: 1,
            completed: 3,
            dead: 1,
          }),
          beta: countsOf({ waiting: 1, dead: 1 }),
        };

        expect(nonEmpty(await count(target, range))).toEqual(expected);
        expect(await reference(target, ["alpha", "beta"], range)).toEqual(
          expected,
        );

        // One queue: that queue alone, whatever the others hold.
        const alone = await count(target, range, "beta");
        expect(Object.keys(alone)).toEqual(["beta"]);
        expect(nonEmpty(alone)).toEqual({ beta: expected.beta });

        // And through the helper a caller uses, which fills in every state.
        expect(await countAdded(driver, target, range, "alpha")).toEqual({
          alpha: expected.alpha,
        });
      });

      it("takes `from` inclusively and `to` exclusively", async () => {
        const count = counter();
        if (!count) {
          return;
        }

        const target = space("edges");
        const q: QueueRef = { ns: target, queue: "edges" };
        const from = T;
        const to = T + 1_000;
        await driver.addJobs(q, [
          jobIn("waiting", "just-before", from - 1),
          jobIn("waiting", "at-from", from),
          jobIn("completed", "last-in", to - 1, to + 5),
          jobIn("waiting", "at-to", to),
        ]);

        const total = async (range: AddedRange): Promise<number> => {
          const counts = (await count(target, range)).edges;
          return counts
            ? Object.values(counts).reduce((sum, each) => sum + each, 0)
            : 0;
        };

        expect(await total({ from, to })).toBe(2);
        expect(nonEmpty(await count(target, { from, to }))).toEqual({
          edges: countsOf({ waiting: 1, completed: 1 }),
        });
        // Each edge alone, a millisecond wide.
        expect(await total({ from, to: from + 1 })).toBe(1);
        expect(await total({ from: to - 1, to })).toBe(1);
        expect(await total({ from: to, to: to + 1 })).toBe(1);
        expect(await total({ from: from - 1, to: from })).toBe(1);
        // An empty or inverted range matches nothing, even over stored jobs.
        expect(nonEmpty(await count(target, { from, to: from }))).toEqual({});
        expect(nonEmpty(await count(target, { from: to, to: from }))).toEqual(
          {},
        );
      });

      it("never counts another namespace's jobs, nor another queue's when one is named", async () => {
        const count = counter();
        if (!count) {
          return;
        }

        const mine = space("mine");
        const theirs = space("theirs");
        const range = { from: T, to: T + 1_000 };
        await driver.addJobs({ ns: mine, queue: "shared" }, [
          jobIn("waiting", "m-1", T + 1),
        ]);
        await driver.addJobs({ ns: theirs, queue: "shared" }, [
          jobIn("waiting", "t-1", T + 1),
          jobIn("waiting", "t-2", T + 2),
        ]);
        await driver.addJobs({ ns: mine, queue: "other" }, [
          jobIn("dead", "o-1", T + 3, T + 4),
        ]);

        expect(nonEmpty(await count(mine, range))).toEqual({
          shared: countsOf({ waiting: 1 }),
          other: countsOf({ dead: 1 }),
        });
        expect(nonEmpty(await count(theirs, range))).toEqual({
          shared: countsOf({ waiting: 2 }),
        });
        expect(nonEmpty(await count(mine, range, "shared"))).toEqual({
          shared: countsOf({ waiting: 1 }),
        });

        // A queue with nothing in the range is absent or all zeros, and the
        // helper answers it with every state at zero.
        expect(nonEmpty(await count(mine, range, "empty"))).toEqual({});
        expect(await countAdded(driver, mine, range, "empty")).toEqual({
          empty: emptyAddedCounts(),
        });
        // A namespace nobody wrote to answers nothing.
        expect(nonEmpty(await count(space("unwritten"), range))).toEqual({});
      });

      it("counts only the jobs still stored", async () => {
        const count = counter();
        if (!count) {
          return;
        }

        const target = space("stored");
        const q: QueueRef = { ns: target, queue: "stored" };
        const range = { from: T, to: T + 1_000 };

        // Claimed alone, then completed with removal: retention deletes it.
        const token = await activate(q, "removed-on-complete", T + 1);
        await driver.addJobs(q, [
          jobIn("waiting", "kept", T + 2),
          jobIn("waiting", "removed", T + 3),
          jobIn("dead", "dead-kept", T + 4, T + 5),
        ]);

        expect(nonEmpty(await count(target, range))).toEqual({
          stored: countsOf({ active: 1, waiting: 2, dead: 1 }),
        });

        expect(await driver.removeJob(q, "removed")).toBe(true);
        expect(
          await driver.completeJob(
            q,
            "removed-on-complete",
            token,
            null,
            true,
            Date.now(),
          ),
        ).toBeTruthy();
        expect(await driver.getJob(q, "removed-on-complete")).toBeNull();

        expect(nonEmpty(await count(target, range))).toEqual({
          stored: countsOf({ waiting: 1, dead: 1 }),
        });
        expect(await reference(target, ["stored"], range)).toEqual({
          stored: countsOf({ waiting: 1, dead: 1 }),
        });
      });

      it("reports every state for each queue it answers", async () => {
        const count = counter();
        if (!count) {
          return;
        }

        const target = space("keys");
        await driver.addJobs({ ns: target, queue: "one" }, [
          jobIn("waiting", "k-1", T + 1),
        ]);
        await driver.addJobs({ ns: target, queue: "two" }, [
          jobIn("completed", "k-2", T + 2, T + 3),
        ]);

        const answer = await count(target, { from: T, to: T + 1_000 });
        expect(Object.keys(answer).sort()).toEqual(["one", "two"]);
        for (const counts of Object.values(answer)) {
          expect(Object.keys(counts).sort()).toEqual([...JOB_STATES].sort());
        }
        expect(answer.one).toEqual(countsOf({ waiting: 1 }));
        expect(answer.two).toEqual(countsOf({ completed: 1 }));
      });

      /* --- sort: "createdAt" ------------------------------------------ */

      /**
       * The ways a sorted page is read: the queue's own entry point, the scan
       * fallback, and — on a backend implementing `countAddedJobs`, which
       * promises the sort — its native `findJobs` called directly. On any
       * other backend `findJobPage` scans, so these cases hold everywhere.
       */
      function finders(): [
        string,
        (target: QueueRef, query: JobQuery) => Promise<JobPage>,
      ][] {
        const list: [
          string,
          (target: QueueRef, query: JobQuery) => Promise<JobPage>,
        ][] = [
          [
            "findJobPage",
            async (target, query) => await findJobPage(driver, target, query),
          ],
          [
            "scan fallback",
            async (target, query) =>
              await findJobsByScan(driver, target, query),
          ],
        ];

        if (supportsCreatedSort(driver) && driver.findJobs) {
          const native = driver.findJobs.bind(driver);
          list.push([
            "native findJobs",
            async (target, query) => await native(target, query),
          ]);
        }

        return list;
      }

      /** The ids a query answers, in the finder's order, with its total. */
      async function idsOf(
        find: (target: QueueRef, query: JobQuery) => Promise<JobPage>,
        target: QueueRef,
        query: Partial<JobQuery> & Pick<JobQuery, "states">,
      ): Promise<{ ids: string[]; total: number | undefined }> {
        const page = await find(target, {
          offset: 0,
          limit: 100,
          order: "asc",
          total: true,
          ...query,
        });
        return { ids: page.jobs.map((job) => job.id), total: page.total };
      }

      /**
       * One state's jobs whose natural key runs *against* their creation
       * order, plus two created in the same millisecond whose ids sort by
       * code point (`B` before `a`, where a case-insensitive or locale
       * collation says otherwise) and whose natural key — and insertion
       * order — put them the other way round, so neither can stand in for
       * the tie-break.
       */
      function against(
        state: "waiting" | "delayed" | "completed",
        prefix: string,
      ): { jobs: JobRecord[]; created: string[] } {
        const at = (n: number): number => T + n * 10;
        // A scramble, not a reversal: natural order a-tie, 2, 4, 1, 3, B-tie.
        const key = (rank: number): number =>
          state === "waiting" ? rank : T + 1_000_000 + rank * 10;
        const jobs = [
          jobIn(state, `${prefix}-3`, at(3), key(4)),
          jobIn(state, `${prefix}-1`, at(1), key(3)),
          jobIn(state, `${prefix}-tie-a`, at(5), key(0)),
          jobIn(state, `${prefix}-4`, at(4), key(2)),
          jobIn(state, `${prefix}-tie-B`, at(5), key(5)),
          jobIn(state, `${prefix}-2`, at(2), key(1)),
        ];
        const created = [
          `${prefix}-1`,
          `${prefix}-2`,
          `${prefix}-3`,
          `${prefix}-4`,
          `${prefix}-tie-B`,
          `${prefix}-tie-a`,
        ];
        return { jobs, created };
      }

      for (const state of ["waiting", "delayed", "completed"] as const) {
        it(`sorts one state (${state}) by creation, not its natural key, with ties by id`, async () => {
          const target = space(`sort-${state}`);
          const q: QueueRef = { ns: target, queue: "sorted" };
          const { jobs, created } = against(state, state.slice(0, 1));
          await driver.addJobs(q, jobs);

          // The premise: the natural order really is a different one, or
          // everything below could pass by listing naturally.
          const natural = (
            await driver.listJobs(q, [state], {
              offset: 0,
              limit: 100,
              order: "asc",
            })
          ).map((job) => job.id);
          expect(natural).not.toEqual(created);
          expect(natural).not.toEqual([...created].reverse());

          for (const [label, find] of finders()) {
            const asc = await idsOf(find, q, {
              states: [state],
              sort: "createdAt",
            });
            expect({ label, ...asc }).toEqual({
              label,
              ids: created,
              total: created.length,
            });

            // `desc` reverses both keys: the tie too.
            const desc = await idsOf(find, q, {
              states: [state],
              sort: "createdAt",
              order: "desc",
            });
            expect({ label, ids: desc.ids }).toEqual({
              label,
              ids: [...created].reverse(),
            });

            // A page is a slice of that order, and counts every match.
            const page = await idsOf(find, q, {
              states: [state],
              sort: "createdAt",
              order: "desc",
              offset: 1,
              limit: 3,
            });
            expect({ label, ...page }).toEqual({
              label,
              ids: [...created].reverse().slice(1, 4),
              total: created.length,
            });
          }
        });
      }

      it("sorts several states, and filtered pages, by creation with ties by id", async () => {
        const target = space("sort-mixed");
        const q: QueueRef = { ns: target, queue: "mixed" };
        await driver.addJobs(q, [
          jobIn("completed", "x-done-late", T + 50, T + 100),
          jobIn("delayed", "x-delayed", T + 10, T + 900_000),
          // Tied, and added against their id order.
          jobIn("completed", "x-done-tie", T + 30, T + 300),
          jobIn("dead", "x-dead-tie", T + 30, T + 200),
          {
            ...jobIn("completed", "x-other-name", T + 20, T + 400),
            name: "other",
          },
          jobIn("waiting", "x-wait", T + 40),
        ]);

        for (const [label, find] of finders()) {
          expect({
            label,
            ids: (
              await idsOf(find, q, {
                states: ["completed", "dead", "delayed", "waiting"],
                sort: "createdAt",
                order: "desc",
              })
            ).ids,
          }).toEqual({
            label,
            ids: [
              "x-done-late",
              "x-wait",
              "x-done-tie",
              "x-dead-tie",
              "x-other-name",
              "x-delayed",
            ],
          });

          // With a name filter, which narrows before the page is cut.
          expect({
            label,
            ...(await idsOf(find, q, {
              states: ["completed", "dead"],
              sort: "createdAt",
              names: ["test"],
            })),
          }).toEqual({
            label,
            ids: ["x-dead-tie", "x-done-tie", "x-done-late"],
            total: 3,
          });

          // With a finished range too — served by scan on a backend without
          // job attribution, which must sort just the same.
          expect({
            label,
            ...(await idsOf(find, q, {
              states: ["completed", "dead"],
              sort: "createdAt",
              order: "desc",
              finishedFrom: T + 150,
              finishedTo: T + 450,
            })),
          }).toEqual({
            label,
            ids: ["x-done-tie", "x-dead-tie", "x-other-name"],
            total: 3,
          });
        }
      });

      it('leaves the natural order exactly as it was, with sort unset or "natural"', async () => {
        const target = space("sort-natural");
        const q: QueueRef = { ns: target, queue: "natural" };
        const { jobs } = against("delayed", "n");
        await driver.addJobs(q, jobs);

        for (const order of ["asc", "desc"] as const) {
          const natural = (
            await driver.listJobs(q, ["delayed"], {
              offset: 0,
              limit: 100,
              order,
            })
          ).map((job) => job.id);

          for (const [label, find] of finders()) {
            for (const sort of [undefined, "natural"] as const) {
              expect({
                label,
                sort,
                ...(await idsOf(find, q, {
                  states: ["delayed"],
                  order,
                  ...(sort === undefined ? {} : { sort }),
                })),
              }).toEqual({
                label,
                sort,
                ids: natural,
                total: natural.length,
              });
            }
          }
        }
      });
    });

    describe("clearing a job's log", () => {
      /** Namespaces these cases made, purged at the end and nothing else with them. */
      const spaces: string[] = [];

      afterAll(async () => {
        for (const space of spaces) {
          await driver.purge(space);
        }
      });

      /**
       * A queue in a namespace of this case's own, so a case asserting that
       * other jobs' logs survive is not also asserting on whatever another
       * case — in whatever order `--randomize` picked — left behind.
       */
      function scope(name: string): QueueRef {
        const space = testNamespace(`clearlog-${name}`);
        spaces.push(space);
        return { ns: space, queue: "logs" };
      }

      /** The whole log, oldest first. */
      const ALL = { offset: 0, limit: 1000, order: "asc" } as const;

      /**
       * The job-log methods, or `undefined` for a backend without
       * `clearJobLogs` yet.
       *
       * Optional, so a driver without it has the route pruned. But one that
       * clears must also write and read — a clear nobody can observe is not a
       * feature — so all three are asserted together: all-or-nothing.
       */
      function jobLogs():
        | Required<
            Pick<JobsDriver, "addJobLog" | "getJobLogs" | "clearJobLogs">
          >
        | undefined {
        if (typeof driver.clearJobLogs !== "function") {
          return undefined;
        }

        expect(typeof driver.addJobLog).toBe("function");
        expect(typeof driver.getJobLogs).toBe("function");

        return {
          addJobLog: driver.addJobLog!.bind(driver),
          getJobLogs: driver.getJobLogs!.bind(driver),
          clearJobLogs: driver.clearJobLogs.bind(driver),
        };
      }

      /** Adds a waiting job and logs `lines` to it, uncapped. */
      async function logged(
        q: QueueRef,
        id: string,
        lines: string[],
        methods: NonNullable<ReturnType<typeof jobLogs>>,
      ): Promise<void> {
        await driver.addJob(q, makeJob({ id, runAt: Date.now() }));
        for (const text of lines) {
          await methods.addJobLog(q, id, text, 0);
        }
      }

      it("removes exactly that job's lines, says how many, and leaves every other log alone", async () => {
        const methods = jobLogs();
        if (!methods) {
          return;
        }

        const q = scope("exact");
        // The same id in another queue and in another namespace: a clear is
        // keyed by all three, never by the id alone.
        const sibling: QueueRef = { ns: q.ns, queue: "logs-other" };
        const elsewhere = scope("exact-elsewhere");

        await logged(q, "a", ["a1", "a2", "a3"], methods);
        await logged(q, "b", ["b1", "b2"], methods);
        await logged(sibling, "a", ["s1"], methods);
        await logged(elsewhere, "a", ["e1", "e2"], methods);

        expect(await methods.clearJobLogs(q, "a")).toEqual({
          status: "cleared",
          removed: 3,
        });

        expect(await methods.getJobLogs(q, "a", ALL)).toEqual({
          logs: [],
          count: 0,
        });
        expect(await methods.getJobLogs(q, "b", ALL)).toEqual({
          logs: ["b1", "b2"],
          count: 2,
        });
        expect(await methods.getJobLogs(sibling, "a", ALL)).toEqual({
          logs: ["s1"],
          count: 1,
        });
        expect(await methods.getJobLogs(elsewhere, "a", ALL)).toEqual({
          logs: ["e1", "e2"],
          count: 2,
        });

        // Clearing an empty log is a success that removed nothing.
        expect(await methods.clearJobLogs(q, "a")).toEqual({
          status: "cleared",
          removed: 0,
        });
      });

      it("starts the count again from one, and keepLogs trims from there", async () => {
        const methods = jobLogs();
        if (!methods) {
          return;
        }

        const q = scope("counter");
        await logged(q, "job", ["old 1", "old 2", "old 3", "old 4"], methods);
        expect(await methods.clearJobLogs(q, "job")).toEqual({
          status: "cleared",
          removed: 4,
        });

        // The count every append answers with is derived from what is stored,
        // so a clear that left anything behind — or a counter it forgot —
        // shows here as a number above one.
        expect(await methods.addJobLog(q, "job", "new 1", 3)).toBe(1);
        expect(await methods.addJobLog(q, "job", "new 2", 3)).toBe(2);
        expect(await methods.addJobLog(q, "job", "new 3", 3)).toBe(3);
        // The cap applies to the fresh log alone: the fourth line drops the
        // first new one, and no old line ever comes back.
        expect(await methods.addJobLog(q, "job", "new 4", 3)).toBe(3);

        expect(await methods.getJobLogs(q, "job", ALL)).toEqual({
          logs: ["new 2", "new 3", "new 4"],
          count: 3,
        });
        expect(
          await methods.getJobLogs(q, "job", {
            offset: 0,
            limit: 1,
            order: "desc",
          }),
        ).toEqual({ logs: ["new 4"], count: 3 });
      });

      it("refuses an active job and removes nothing, then clears it once it has settled", async () => {
        const methods = jobLogs();
        if (!methods) {
          return;
        }

        const q = scope("active");
        await logged(q, "busy", ["started", "working"], methods);
        const token = newToken();
        const claimed = await driver.claimJob(q, {
          workerId: "clear-w",
          token,
          lockMs: 60_000,
          now: Date.now(),
        });
        expect(claimed?.id).toBe("busy");

        // The worker is still writing: its log must stay whole.
        expect(await methods.clearJobLogs(q, "busy")).toEqual({
          status: "active",
        });
        await methods.addJobLog(q, "busy", "still going", 0);
        expect(await methods.getJobLogs(q, "busy", ALL)).toEqual({
          logs: ["started", "working", "still going"],
          count: 3,
        });

        expect(
          await driver.completeJob(q, "busy", token, null, false, Date.now()),
        ).toBe(true);
        expect(await methods.clearJobLogs(q, "busy")).toEqual({
          status: "cleared",
          removed: 3,
        });
      });

      it("answers missing for a job that does not exist, creating nothing", async () => {
        const methods = jobLogs();
        if (!methods) {
          return;
        }

        const q = scope("missing");
        await driver.ensureQueue(q);
        expect(await methods.clearJobLogs(q, "nobody")).toEqual({
          status: "missing",
        });
        expect(await driver.getJob(q, "nobody")).toBeNull();
        // And a job added under that id afterwards starts with an empty log.
        await driver.addJob(q, makeJob({ id: "nobody", runAt: Date.now() }));
        expect(await methods.addJobLog(q, "nobody", "first", 0)).toBe(1);
      });

      it("changes nothing but the log: not the job, not its queue's counts", async () => {
        const methods = jobLogs();
        if (!methods) {
          return;
        }

        const q = scope("untouched");
        await logged(q, "kept", ["one", "two"], methods);
        await driver.addJob(q, makeJob({ id: "other", runAt: Date.now() }));

        const job = await driver.getJob(q, "kept");
        const counts = await driver.countJobs(q);

        expect(await methods.clearJobLogs(q, "kept")).toMatchObject({
          status: "cleared",
        });

        expect(await driver.getJob(q, "kept")).toEqual(job);
        expect(await driver.countJobs(q)).toEqual(counts);
      });
    });

    describe("clearing run history", () => {
      /** Namespaces these cases made, purged at the end and nothing else with them. */
      const spaces: string[] = [];

      afterAll(async () => {
        for (const space of spaces) {
          await driver.purge(space);
        }
      });

      /**
       * A namespace of this case's own: `listRunners` and the "every other
       * runner is untouched" assertions are namespace-wide.
       */
      function scope(name: string): string {
        const space = testNamespace(`clearruns-${name}`);
        spaces.push(space);
        return space;
      }

      /** Caps that bound nothing, so a case only feels what it does itself. */
      const OPEN: RunLogCaps = { maxLines: 0, maxBytes: 0, keepRuns: 0 };

      /** The whole log, oldest first. */
      const ALL: RunLogQuery = { offset: 0, limit: 1000, order: "asc" };

      /**
       * `removeRuns`, or `undefined` for a backend without it yet — and, when
       * the backend stores run logs, the log methods beside it, all present:
       * a driver that removes runs must remove their logs too, and a case
       * cannot show that without reading them.
       */
      function removal():
        | {
            removeRuns: NonNullable<JobsDriver["removeRuns"]>;
            logs?: Required<Pick<JobsDriver, "appendRunLog" | "getRunLog">>;
          }
        | undefined {
        if (typeof driver.removeRuns !== "function") {
          return undefined;
        }

        const hasLogs = typeof driver.appendRunLog === "function";
        expect(typeof driver.getRunLog === "function").toBe(hasLogs);

        return {
          removeRuns: driver.removeRuns.bind(driver),
          ...(hasLogs
            ? {
                logs: {
                  appendRunLog: driver.appendRunLog!.bind(driver),
                  getRunLog: driver.getRunLog!.bind(driver),
                },
              }
            : {}),
        };
      }

      /** A run record, settled unless `status` says otherwise. */
      function run(
        runId: string,
        status: RunRecord["status"],
        startedAt: number,
      ): RunRecord {
        return {
          runId,
          runnerId: "clear-runner",
          attempt: 1,
          source: "manual",
          mode: "in-process",
          host: "h",
          startedAt,
          status,
          ...(status === "running"
            ? {}
            : { finishedAt: startedAt + 5, durationMs: 5 }),
        };
      }

      /** Records a run and, where the backend stores them, a two-line log. */
      async function seed(
        space: string,
        key: string,
        record: RunRecord,
        methods: NonNullable<ReturnType<typeof removal>>,
      ): Promise<void> {
        await driver.appendHistory(space, key, record, 0);
        await methods.logs?.appendRunLog(
          space,
          key,
          record.runId,
          [
            {
              stream: "stdout",
              at: record.startedAt,
              text: `${record.runId} a`,
            },
            {
              stream: "stdout",
              at: record.startedAt,
              text: `${record.runId} b`,
            },
          ],
          OPEN,
        );
      }

      /** One run's log texts, or `undefined` on a backend without run logs. */
      async function texts(
        space: string,
        key: string,
        runId: string,
        methods: NonNullable<ReturnType<typeof removal>>,
      ): Promise<string[] | undefined> {
        const page = await methods.logs?.getRunLog(space, key, runId, ALL);
        return page?.lines.map((entry) => entry.text);
      }

      it("removes the named runs' records and logs, and keeps the in-flight run's whole", async () => {
        const methods = removal();
        if (!methods) {
          return;
        }

        const space = scope("named");
        const key = runnerKey("history");
        await seed(space, key, run("done-1", "success", 1_000), methods);
        await seed(space, key, run("done-2", "failed", 2_000), methods);
        await seed(space, key, run("live", "running", 3_000), methods);

        expect(await methods.removeRuns(space, key, ["done-1", "done-2"])).toBe(
          2,
        );

        expect(
          (await driver.listHistory(space, key)).map((entry) => entry.runId),
        ).toEqual(["live"]);
        expect(await driver.listHistory(space, key)).toEqual([
          run("live", "running", 3_000),
        ]);

        if (methods.logs) {
          // Gone, and forgotten: an empty log, not one whose lines were lost.
          for (const runId of ["done-1", "done-2"]) {
            expect(
              await methods.logs.getRunLog(space, key, runId, ALL),
            ).toEqual({ lines: [], count: 0, dropped: 0, lastSeq: 0 });
          }
          const page = await methods.logs.getRunLog(space, key, "live", ALL);
          expect({
            texts: page.lines.map((entry) => entry.text),
            count: page.count,
            lastSeq: page.lastSeq,
          }).toEqual({ texts: ["live a", "live b"], count: 2, lastSeq: 2 });
        }
      });

      it("lets the run it kept carry on: its log continues and its record settles", async () => {
        const methods = removal();
        if (!methods) {
          return;
        }

        const space = scope("carry-on");
        const key = runnerKey("history");
        await seed(space, key, run("done", "success", 1_000), methods);
        await seed(space, key, run("live", "running", 2_000), methods);

        expect(await methods.removeRuns(space, key, ["done"])).toBe(1);

        if (methods.logs) {
          expect(
            await methods.logs.appendRunLog(
              space,
              key,
              "live",
              [{ stream: "stdout", at: 2_010, text: "live c" }],
              OPEN,
            ),
          ).toEqual({ count: 3, dropped: 0, lastSeq: 3 });
        }
        expect(
          await driver.updateHistory(space, key, "live", {
            status: "success",
            finishedAt: 2_020,
            durationMs: 20,
          }),
        ).toBe(true);
        expect(await driver.listHistory(space, key)).toEqual([
          {
            ...run("live", "running", 2_000),
            status: "success",
            finishedAt: 2_020,
            durationMs: 20,
          },
        ]);
        expect(await texts(space, key, "live", methods)).toEqual(
          methods.logs ? ["live a", "live b", "live c"] : undefined,
        );
      });

      it("leaves every other runner and namespace alone", async () => {
        const methods = removal();
        if (!methods) {
          return;
        }

        const space = scope("others");
        const elsewhere = scope("others-elsewhere");
        const key = runnerKey("history");
        const neighbour = runnerKey("neighbour");

        // The same run id under another runner and in another namespace.
        await seed(space, key, run("shared-id", "success", 1_000), methods);
        await seed(
          space,
          neighbour,
          run("shared-id", "success", 1_000),
          methods,
        );
        await seed(elsewhere, key, run("shared-id", "success", 1_000), methods);

        expect(await methods.removeRuns(space, key, ["shared-id"])).toBe(1);

        expect(await driver.listHistory(space, key)).toEqual([]);
        expect(await driver.listHistory(space, neighbour)).toEqual([
          run("shared-id", "success", 1_000),
        ]);
        expect(await driver.listHistory(elsewhere, key)).toEqual([
          run("shared-id", "success", 1_000),
        ]);

        const expected = methods.logs
          ? ["shared-id a", "shared-id b"]
          : undefined;
        expect(await texts(space, neighbour, "shared-id", methods)).toEqual(
          expected,
        );
        expect(await texts(elsewhere, key, "shared-id", methods)).toEqual(
          expected,
        );
      });

      it("touches no state: not the lifetime counters, the lock or the queued triggers", async () => {
        const methods = removal();
        if (!methods) {
          return;
        }

        const space = scope("state");
        const key = runnerKey("history");
        const now = Date.now();
        await seed(space, key, run("done", "success", 1_000), methods);
        await driver.setState(space, key, { lastRunId: "done", paused: "0" });
        await driver.incrementCounters(space, key, {
          "stat:success": 7,
          "stat:total": 9,
        });
        const token = newToken();
        expect(await driver.acquireLock(space, key, token, 60_000, now)).toBe(
          true,
        );
        await driver.pushQueuedTrigger(
          space,
          key,
          {
            id: "t1",
            source: "manual",
            requestedAt: now,
            requestedBy: token,
          },
          10,
        );

        const state = await driver.getState(space, key);

        expect(await methods.removeRuns(space, key, ["done"])).toBe(1);

        expect(await driver.getState(space, key)).toEqual(state);
        expect(state).toMatchObject({ "stat:success": "7", "stat:total": "9" });
        expect((await driver.getLock(space, key, now))?.token).toBe(token);
        expect(await driver.countQueuedTriggers(space, key)).toBe(1);
      });

      it("counts only records: a name the history lacks loses its log, and no names remove nothing", async () => {
        const methods = removal();
        if (!methods) {
          return;
        }

        const space = scope("names");
        const key = runnerKey("history");
        await seed(space, key, run("kept", "success", 1_000), methods);
        // A log whose record is gone (or was never written).
        await methods.logs?.appendRunLog(
          space,
          key,
          "ghost",
          [{ stream: "stdout", at: 500, text: "ghost a" }],
          OPEN,
        );

        expect(await methods.removeRuns(space, key, [])).toBe(0);
        expect(await methods.removeRuns(space, key, ["ghost", "never"])).toBe(
          0,
        );

        expect(await texts(space, key, "ghost", methods)).toEqual(
          methods.logs ? [] : undefined,
        );
        expect(await driver.listHistory(space, key)).toEqual([
          run("kept", "success", 1_000),
        ]);
        expect(await texts(space, key, "kept", methods)).toEqual(
          methods.logs ? ["kept a", "kept b"] : undefined,
        );
      });

      it("removing from a runner the backend does not know creates nothing", async () => {
        const methods = removal();
        if (!methods) {
          return;
        }

        const space = scope("unknown");
        const key = runnerKey("nobody");
        expect(await methods.removeRuns(space, key, ["r1"])).toBe(0);
        expect(await driver.listRunners(space)).not.toContain("nobody");
      });
    });

    describe("queue job defaults: the explicit mask and rewriting pending jobs", () => {
      /** Namespaces these cases made, purged at the end and nothing else with them. */
      const spaces: string[] = [];

      afterAll(async () => {
        for (const space of spaces) {
          await driver.purge(space);
        }
      });

      /**
       * A queue in a namespace of this case's own: a rewrite walks every
       * pending job of its queue, so two cases sharing one would each rewrite
       * and count the other's jobs, in whatever order `--randomize` picked.
       */
      function scope(name: string): QueueRef {
        const space = testNamespace(`jdef-${name}`);
        spaces.push(space);
        return { ns: space, queue: "jdef" };
      }

      const BITS = JOB_OPTION_BITS;

      /**
       * `rewritePendingOptions` and `updateJob`, or `undefined` for a backend
       * without the rewrite yet.
       *
       * Optional, so a driver without it has the apply route pruned. But one
       * that rewrites must also honour the mask where `updateJob` writes it —
       * an operator's priority would otherwise be replaced by the next apply —
       * so both are asserted together: all-or-nothing.
       */
      function rewriting():
        | Required<Pick<JobsDriver, "rewritePendingOptions" | "updateJob">>
        | undefined {
        if (typeof driver.rewritePendingOptions !== "function") {
          return undefined;
        }

        expect(typeof driver.updateJob).toBe("function");

        return {
          rewritePendingOptions: driver.rewritePendingOptions.bind(driver),
          updateJob: driver.updateJob!.bind(driver),
        };
      }

      /** One full request, every field at the value a case usually wants. */
      function request(
        values: PendingOptionsRewrite["values"],
        extra: Partial<PendingOptionsRewrite> = {},
      ): PendingOptionsRewrite {
        return {
          states: [...JOB_DEFAULTS_APPLY_STATES],
          values,
          cursor: null,
          limit: 1_000,
          includeUnmarked: false,
          dryRun: false,
          now: Date.now(),
          ...extra,
        };
      }

      /**
       * Calls the rewrite until it says the walk is over, summing the counts
       * and checking every call stayed inside its limit.
       */
      async function walk(
        methods: NonNullable<ReturnType<typeof rewriting>>,
        q: QueueRef,
        base: PendingOptionsRewrite,
      ): Promise<{ total: PendingOptionsRewriteResult; calls: number }> {
        const total: PendingOptionsRewriteResult = {
          examined: 0,
          rewritten: 0,
          unchanged: 0,
          skippedExplicit: 0,
          skippedUnmarked: 0,
          moved: 0,
          exhausted: 0,
          next: null,
        };
        let cursor: string | null = null;
        let calls = 0;

        do {
          const result = await methods.rewritePendingOptions(q, {
            ...base,
            cursor,
          });
          calls++;
          expect(result.examined).toBeLessThanOrEqual(base.limit);
          expect(
            result.rewritten +
              result.unchanged +
              result.skippedExplicit +
              result.skippedUnmarked +
              result.moved,
          ).toBe(result.examined);

          for (const key of [
            "examined",
            "rewritten",
            "unchanged",
            "skippedExplicit",
            "skippedUnmarked",
            "moved",
            "exhausted",
          ] as const) {
            total[key] += result[key];
          }

          cursor = result.next;
          // A walk that never ends is the bug a keyset cursor exists to rule out.
          expect(calls).toBeLessThan(100);
        } while (cursor !== null);

        return { total, calls };
      }

      /** The stored job, which must exist. */
      async function stored(q: QueueRef, id: string): Promise<JobRecord> {
        const job = await driver.getJob(q, id);
        expect(job).not.toBeNull();
        return job!;
      }

      /** Claims everything claimable, in claim order, and answers the ids. */
      async function drain(q: QueueRef, now: number): Promise<string[]> {
        const ids: string[] = [];

        for (;;) {
          const job = await driver.claimJob(q, {
            workerId: "w-jdef",
            token: newToken(),
            lockMs: 5_000,
            now,
          });

          if (!job) {
            return ids;
          }

          ids.push(job.id);
        }
      }

      it("stores opts.explicit with the rest of the options, and a job without one reads without one", async () => {
        const q = scope("mask");
        const now = Date.now();

        await driver.addJobs(q, [
          makeJob({
            id: "marked",
            runAt: now,
            opts: storedOptions({ explicit: BITS.attempts | BITS.priority }),
          }),
          makeJob({
            id: "zero",
            runAt: now,
            opts: storedOptions({ explicit: 0 }),
          }),
          makeJob({ id: "legacy", runAt: now }),
        ]);

        expect((await stored(q, "marked")).opts.explicit).toBe(
          BITS.attempts | BITS.priority,
        );
        // `0` is a mask ("nothing explicit"), not an absent one.
        expect((await stored(q, "zero")).opts.explicit).toBe(0);
        expect((await stored(q, "legacy")).opts.explicit).toBeUndefined();

        // And through a claim, which is how a worker reads it.
        const claimed = await drain(q, now + 10);
        expect(claimed.sort()).toEqual(["legacy", "marked", "zero"]);
      });

      it("updateJob with a priority marks it explicit on a marked job, and leaves an unmarked one unmarked", async () => {
        const methods = rewriting();
        if (!methods) {
          return;
        }

        const q = scope("update-bit");
        const now = Date.now();

        await driver.addJobs(q, [
          makeJob({
            id: "marked",
            runAt: now,
            opts: storedOptions({ explicit: BITS.attempts }),
          }),
          makeJob({
            id: "same",
            runAt: now,
            opts: storedOptions({ explicit: 0 }),
          }),
          makeJob({ id: "legacy", runAt: now }),
          makeJob({
            id: "data-only",
            runAt: now,
            opts: storedOptions({ explicit: 0 }),
          }),
        ]);

        const marked = await methods.updateJob(
          q,
          "marked",
          { priority: 7 },
          now,
        );
        expect(marked?.opts.explicit).toBe(BITS.attempts | BITS.priority);
        expect(marked?.opts.priority).toBe(7);
        expect((await stored(q, "marked")).opts.explicit).toBe(
          BITS.attempts | BITS.priority,
        );

        // Choosing the priority it already has still pins it.
        await methods.updateJob(q, "same", { priority: 0 }, now);
        expect((await stored(q, "same")).opts.explicit).toBe(BITS.priority);

        await methods.updateJob(q, "legacy", { priority: 3 }, now);
        const legacy = await stored(q, "legacy");
        expect(legacy.priority).toBe(3);
        expect(legacy.opts.explicit).toBeUndefined();

        // Only a priority marks anything.
        await methods.updateJob(q, "data-only", { data: { x: 1 } }, now);
        expect((await stored(q, "data-only")).opts.explicit).toBe(0);
      });

      it("writes only the keys that are not explicit on each job, and never changes the mask", async () => {
        const methods = rewriting();
        if (!methods) {
          return;
        }

        const q = scope("explicit");
        const now = Date.now();

        await driver.addJobs(q, [
          // attempts explicit: gets the timeout, keeps its attempts.
          makeJob({
            id: "some",
            runAt: now,
            maxAttempts: 2,
            opts: storedOptions({ attempts: 2, explicit: BITS.attempts }),
          }),
          // nothing explicit: gets both.
          makeJob({
            id: "none",
            runAt: now,
            opts: storedOptions({ explicit: 0 }),
          }),
          // every changing key explicit: left alone.
          makeJob({
            id: "all",
            runAt: now,
            maxAttempts: 9,
            opts: storedOptions({
              attempts: 9,
              timeout: 9,
              explicit: BITS.attempts | BITS.timeout,
            }),
          }),
          // explicit on a key that would not change, defaulted on the rest,
          // and already carrying the new values: nothing to write.
          makeJob({
            id: "done",
            runAt: now,
            maxAttempts: 5,
            opts: storedOptions({
              attempts: 5,
              timeout: 1_000,
              explicit: BITS.keepLogs,
            }),
          }),
        ]);

        const result = await methods.rewritePendingOptions(
          q,
          request({ attempts: 5, timeout: 1_000 }),
        );

        expect(result).toMatchObject({
          examined: 4,
          rewritten: 2,
          unchanged: 1,
          skippedExplicit: 1,
          skippedUnmarked: 0,
          next: null,
        });

        const some = await stored(q, "some");
        expect(some.opts).toMatchObject({
          attempts: 2,
          timeout: 1_000,
          explicit: BITS.attempts,
        });
        expect(some.maxAttempts).toBe(2);

        const none = await stored(q, "none");
        expect(none.opts).toMatchObject({
          attempts: 5,
          timeout: 1_000,
          explicit: 0,
        });
        // `attempts` is also the column the retry decision reads.
        expect(none.maxAttempts).toBe(5);
        // Keys not named are not touched.
        expect(none.opts.removeOnComplete).toBe(false);
        expect(none.opts.keepStacktraces).toBe(5);

        const all = await stored(q, "all");
        expect(all.opts).toMatchObject({ attempts: 9, timeout: 9 });
        expect(all.maxAttempts).toBe(9);

        expect((await stored(q, "done")).opts.explicit).toBe(BITS.keepLogs);
      });

      it("writes object values whole, and treats a key order difference as no change", async () => {
        const methods = rewriting();
        if (!methods) {
          return;
        }

        const q = scope("objects");
        const now = Date.now();
        const backoff = {
          type: "exponential" as const,
          delay: 500,
          max: 8_000,
        };
        const retention = { count: 10, ttl: 60_000 };

        await driver.addJobs(q, [
          makeJob({
            id: "old",
            runAt: now,
            opts: storedOptions({
              backoff: { type: "fixed", delay: 1, factor: 3 },
              removeOnComplete: true,
              explicit: 0,
            }),
          }),
          makeJob({
            id: "same",
            runAt: now,
            opts: storedOptions({
              backoff: { max: 8_000, delay: 500, type: "exponential" },
              removeOnComplete: { ttl: 60_000, count: 10 },
              explicit: 0,
            }),
          }),
        ]);

        const result = await methods.rewritePendingOptions(
          q,
          request({ backoff, removeOnComplete: retention, keepLogs: 50 }),
        );

        const old = await stored(q, "old");
        // Replaced whole: the old `factor` does not survive into the new backoff.
        expect(old.opts.backoff).toEqual(backoff);
        expect(old.opts.removeOnComplete).toEqual(retention);
        expect(old.opts.keepLogs).toBe(50);

        const same = await stored(q, "same");
        expect(same.opts.keepLogs).toBe(50);
        expect(result).toMatchObject({ examined: 2, rewritten: 2 });

        // Run again: both now carry every value, whatever order they were
        // stored in.
        expect(
          await methods.rewritePendingOptions(
            q,
            request({ backoff, removeOnComplete: retention, keepLogs: 50 }),
          ),
        ).toMatchObject({ examined: 2, rewritten: 0, unchanged: 2 });
      });

      it("skips a job with no mask unless told to include it", async () => {
        const methods = rewriting();
        if (!methods) {
          return;
        }

        const q = scope("unmarked");
        const now = Date.now();

        await driver.addJobs(q, [
          makeJob({
            id: "legacy",
            runAt: now,
            opts: storedOptions({ timeout: 7 }),
          }),
          makeJob({
            id: "marked",
            runAt: now,
            opts: storedOptions({ timeout: 7, explicit: 0 }),
          }),
        ]);

        const skipped = await methods.rewritePendingOptions(
          q,
          request({ timeout: 1_000 }),
        );
        expect(skipped).toMatchObject({
          examined: 2,
          rewritten: 1,
          skippedUnmarked: 1,
        });
        expect((await stored(q, "legacy")).opts.timeout).toBe(7);

        const included = await methods.rewritePendingOptions(
          q,
          request({ timeout: 1_000 }, { includeUnmarked: true }),
        );
        expect(included).toMatchObject({
          examined: 2,
          rewritten: 1,
          unchanged: 1,
          skippedUnmarked: 0,
        });

        const legacy = await stored(q, "legacy");
        expect(legacy.opts.timeout).toBe(1_000);
        // Rewriting does not invent a mask for it.
        expect(legacy.opts.explicit).toBeUndefined();
      });

      it("rewrites every pending state it is given and nothing else: never active, completed or dead", async () => {
        const methods = rewriting();
        if (!methods) {
          return;
        }

        const q = scope("states");
        const now = Date.now();
        const mark = storedOptions({ explicit: 0 });
        const parentFlow: JobFlow = {
          parent: null,
          children: [{ queue: q.queue, id: "absent-child" }],
          pending: 1,
          values: {},
          failures: {},
          recorded: false,
        };

        await driver.addJobs(q, [
          makeJob({
            id: "claimed",
            runAt: now - 1_000,
            createdAt: now - 1_000,
            opts: mark,
          }),
        ]);
        const active = await driver.claimJob(q, {
          workerId: "w-jdef",
          token: newToken(),
          lockMs: 60_000,
          now,
        });
        expect(active?.id).toBe("claimed");

        await driver.addJobs(q, [
          makeJob({ id: "waiting", runAt: now + 10, opts: mark }),
          makeJob({
            id: "delayed",
            state: "delayed",
            runAt: now + 60_000,
            opts: mark,
          }),
          makeJob({
            id: "failed",
            state: "failed",
            runAt: now + 60_000,
            attemptsMade: 1,
            opts: mark,
          }),
          makeJob({
            id: "parent",
            state: "waiting-children",
            runAt: now,
            flow: parentFlow,
            opts: mark,
          }),
          makeJob({
            id: "completed",
            state: "completed",
            finishedOn: now,
            opts: mark,
          }),
          makeJob({ id: "dead", state: "dead", finishedOn: now, opts: mark }),
        ]);

        // Only `waiting`: the other pending states are left for a later call.
        const narrow = await methods.rewritePendingOptions(
          q,
          request({ timeout: 42 }, { states: ["waiting"] }),
        );
        expect(narrow).toMatchObject({ examined: 1, rewritten: 1, next: null });
        expect((await stored(q, "delayed")).opts.timeout).toBe(0);

        const { total } = await walk(methods, q, request({ timeout: 42 }));
        // waiting (met again, already done), delayed, failed, waiting-children.
        expect(total).toMatchObject({
          examined: 4,
          rewritten: 3,
          unchanged: 1,
        });

        for (const id of ["waiting", "delayed", "failed", "parent"]) {
          expect((await stored(q, id)).opts.timeout).toBe(42);
        }

        for (const id of ["claimed", "completed", "dead"]) {
          expect((await stored(q, id)).opts.timeout).toBe(0);
        }

        // The rewrite changed options only: every job is where it was.
        expect((await stored(q, "claimed")).state).toBe("active");
        expect((await stored(q, "delayed")).state).toBe("delayed");
        expect((await stored(q, "failed")).state).toBe("failed");
        expect((await stored(q, "parent")).state).toBe("waiting-children");
      });

      it("reorders waiting jobs on a new priority, keeping FIFO among equals and explicit priorities in place", async () => {
        const methods = rewriting();
        if (!methods) {
          return;
        }

        const q = scope("priority");
        const now = Date.now();
        const job = (id: string, offset: number, explicit: number) =>
          makeJob({
            id,
            runAt: now,
            createdAt: now + offset,
            opts: storedOptions({ explicit }),
          });

        await driver.addJobs(q, [
          job("a", 0, 0),
          job("pinned", 1, BITS.priority),
          job("b", 2, 0),
          job("c", 3, 0),
        ]);

        const result = await methods.rewritePendingOptions(
          q,
          request({ priority: 5 }, { states: ["waiting"] }),
        );
        expect(result.rewritten).toBe(3);

        expect((await stored(q, "a")).priority).toBe(5);
        expect((await stored(q, "a")).opts.priority).toBe(5);
        expect((await stored(q, "pinned")).priority).toBe(0);

        // The pinned job now runs first; the rest keep their order.
        expect(await drain(q, now + 10)).toEqual(["pinned", "a", "b", "c"]);
      });

      it("walks with a cursor that meets a moved job again rather than skipping any", async () => {
        const methods = rewriting();
        if (!methods) {
          return;
        }

        const q = scope("keyset");
        const now = Date.now();
        const priorities = [-3, -2, -1, 0, 1, 2, 4, 5, 6];

        await driver.addJobs(
          q,
          priorities.map((priority, index) =>
            makeJob({
              id: `j${index}`,
              priority,
              runAt: now,
              createdAt: now + index,
              opts: storedOptions({ priority, explicit: 0 }),
            }),
          ),
        );
        // And one in each of two other states, so the walk crosses them.
        await driver.addJobs(q, [
          makeJob({
            id: "later",
            state: "delayed",
            runAt: now + 60_000,
            opts: storedOptions({ explicit: 0 }),
          }),
          makeJob({
            id: "retry",
            state: "failed",
            runAt: now + 60_000,
            attemptsMade: 1,
            opts: storedOptions({ explicit: 0 }),
          }),
        ]);

        // A small limit, and a priority that moves the first jobs examined
        // ahead of the cursor: an offset walk would skip jobs here.
        const { total, calls } = await walk(
          methods,
          q,
          request({ priority: 3 }, { limit: 2 }),
        );

        expect(calls).toBeGreaterThan(1);
        // Each job rewritten exactly once; any met again counts unchanged.
        expect(total.rewritten).toBe(priorities.length + 2);
        expect(total.examined).toBe(total.rewritten + total.unchanged);

        for (const [index] of priorities.entries()) {
          const job = await stored(q, `j${index}`);
          expect(job.priority).toBe(3);
          expect(job.opts.priority).toBe(3);
        }
        expect((await stored(q, "later")).priority).toBe(3);
        expect((await stored(q, "retry")).priority).toBe(3);

        // A walk run again from the start finds nothing to do.
        const again = await walk(
          methods,
          q,
          request({ priority: 3 }, { limit: 4 }),
        );
        expect(again.total.rewritten).toBe(0);
      });

      it("refuses a cursor it did not issue", async () => {
        const methods = rewriting();
        if (!methods) {
          return;
        }

        const q = scope("bad-cursor");
        await driver.addJob(
          q,
          makeJob({ id: "one", opts: storedOptions({ explicit: 0 }) }),
        );

        for (const cursor of ["", "garbage", "jd1.bm90LWpzb24"]) {
          await expect(
            methods.rewritePendingOptions(
              q,
              request({ timeout: 5 }, { cursor }),
            ),
          ).rejects.toBeInstanceOf(ConfigError);
        }

        expect((await stored(q, "one")).opts.timeout).toBe(0);
      });

      it("counts exactly as the real call would on a dry run, and writes nothing", async () => {
        const methods = rewriting();
        if (!methods) {
          return;
        }

        const q = scope("dry");
        const now = Date.now();

        await driver.addJobs(q, [
          makeJob({
            id: "a",
            runAt: now,
            createdAt: now,
            opts: storedOptions({ explicit: 0 }),
          }),
          makeJob({
            id: "b",
            runAt: now,
            createdAt: now + 1,
            priority: 2,
            opts: storedOptions({ priority: 2, explicit: BITS.priority }),
          }),
          makeJob({ id: "legacy", runAt: now, createdAt: now + 2 }),
          makeJob({
            id: "spent",
            state: "failed",
            runAt: now + 60_000,
            attemptsMade: 3,
            maxAttempts: 4,
            opts: storedOptions({ attempts: 4, explicit: 0 }),
          }),
        ]);

        const ids = ["a", "b", "legacy", "spent"];
        const before = await Promise.all(ids.map((id) => stored(q, id)));
        const values = { priority: 1, attempts: 2 };

        const dry = await walk(methods, q, request(values, { dryRun: true }));
        expect(await Promise.all(ids.map((id) => stored(q, id)))).toEqual(
          before,
        );

        const real = await walk(methods, q, request(values));
        expect(dry.total).toEqual(real.total);
        expect(real.total).toMatchObject({
          rewritten: 3,
          skippedUnmarked: 1,
          exhausted: 1,
        });
      });

      it("writes a lower attempts than a job has made, and counts it exhausted", async () => {
        const methods = rewriting();
        if (!methods) {
          return;
        }

        const q = scope("exhausted");
        const now = Date.now();

        await driver.addJobs(q, [
          makeJob({
            id: "spent",
            state: "failed",
            runAt: now + 60_000,
            attemptsMade: 3,
            maxAttempts: 5,
            opts: storedOptions({ attempts: 5, explicit: 0 }),
          }),
          makeJob({
            id: "fresh",
            runAt: now,
            maxAttempts: 5,
            opts: storedOptions({ attempts: 5, explicit: 0 }),
          }),
          // Explicit attempts: kept, so not exhausted by this call.
          makeJob({
            id: "kept",
            state: "failed",
            runAt: now + 60_000,
            attemptsMade: 3,
            maxAttempts: 5,
            opts: storedOptions({ attempts: 5, explicit: BITS.attempts }),
          }),
        ]);

        const { total } = await walk(methods, q, request({ attempts: 2 }));
        expect(total).toMatchObject({
          examined: 3,
          rewritten: 2,
          skippedExplicit: 1,
          exhausted: 1,
        });

        const spent = await stored(q, "spent");
        // Not clamped, not dropped: it keeps its place and its count.
        expect(spent).toMatchObject({
          state: "failed",
          attemptsMade: 3,
          maxAttempts: 2,
        });
        expect(spent.opts.attempts).toBe(2);
        expect((await stored(q, "kept")).maxAttempts).toBe(5);
      });
    });

    describe("discovery and purge", () => {
      it("answers about an unknown runner without creating one", async () => {
        const scope = testNamespace("unread");
        const key = runnerKey("never-touched");

        // Every read, each of which must answer emptily — and
        // `popQueuedTrigger`, which a runner's drain calls on every pass and
        // which finds nothing here. It used to write on the file and SQL
        // drivers even so, leaving a state record that listed the runner.
        expect(await driver.getLock(scope, key, Date.now())).toBeNull();
        expect(await driver.getState(scope, key)).toEqual({});
        expect(await driver.listHistory(scope, key)).toEqual([]);
        expect(await driver.countQueuedTriggers(scope, key)).toBe(0);
        expect(await driver.popQueuedTrigger(scope, key)).toBeNull();
        expect(await driver.peekQueuedTrigger(scope, key)).toBeNull();

        // Asking about a runner is not the same as having one. The memory
        // driver used to conjure one on any of the reads above, which put
        // every id anyone merely inspected into the listing for good.
        expect(await driver.listRunners(scope)).not.toContain("never-touched");
        await driver.purge(scope);
      });

      it("peeks at an unknown runner without creating it", async () => {
        const scope = testNamespace("peek-unknown");
        const key = runnerKey("never-peeked");

        // Nothing else touches this runner, so a record that appears can only
        // have come from the peek.
        const before = await driver.listRunners(scope);
        expect(await driver.peekQueuedTrigger(scope, key)).toBeNull();
        expect(await driver.peekQueuedTrigger(scope, key)).toBeNull();
        expect(await driver.listRunners(scope)).toEqual(before);
        expect(await driver.listRunners(scope)).not.toContain("never-peeked");
        expect(await driver.getState(scope, key)).toEqual({});
        await driver.purge(scope);
      });

      it("conditionally pops from an unknown runner without creating it", async () => {
        const scope = testNamespace("pop-if-unknown");
        const key = runnerKey("never-popped");

        const before = await driver.listRunners(scope);
        expect(await driver.popQueuedTriggerIf(scope, key, "any")).toBeNull();
        expect(await driver.popQueuedTriggerIf(scope, key, "any")).toBeNull();
        expect(await driver.listRunners(scope)).toEqual(before);
        expect(await driver.listRunners(scope)).not.toContain("never-popped");
        expect(await driver.getState(scope, key)).toEqual({});
        expect(await driver.countQueuedTriggers(scope, key)).toBe(0);
        await driver.purge(scope);
      });

      it("lists a runner that has written state but never taken a lock", async () => {
        const ns = testNamespace("unlocked");

        await driver.setState(ns, runnerKey("never-locked"), {
          paused: "0",
          updatedAt: Date.now(),
        });

        expect(await driver.listRunners(ns)).toContain("never-locked");
        await driver.purge(ns);
      });

      it("lists what the namespace holds and purges only it", async () => {
        const doomed = testNamespace("doomed");
        const kept = testNamespace("kept");
        const now = Date.now();

        await driver.acquireLock(
          doomed,
          runnerKey("r1"),
          newToken(),
          5000,
          now,
        );
        await driver.addJob(
          { ns: doomed, queue: "jobs" },
          makeJob({ id: "doomed-job" }),
        );
        await driver.acquireLock(kept, runnerKey("r1"), newToken(), 5000, now);
        await driver.addJob(
          { ns: kept, queue: "jobs" },
          makeJob({ id: "kept-job" }),
        );

        expect(await driver.listRunners(doomed)).toContain("r1");
        expect(await driver.listQueues(doomed)).toContain("jobs");

        await driver.purge(doomed);

        expect(await driver.listRunners(doomed)).toEqual([]);
        expect(
          await driver.getJob({ ns: doomed, queue: "jobs" }, "doomed-job"),
        ).toBeNull();

        // The neighbouring namespace is untouched.
        expect(await driver.listRunners(kept)).toContain("r1");
        expect(
          await driver.getJob({ ns: kept, queue: "jobs" }, "kept-job"),
        ).not.toBeNull();

        await driver.purge(kept);
      });
    });
  });
}

/** Run totals with only the named outcomes non-zero, every counter present. */
function runsTotals(counts: Partial<RunnerRunCounters>): RunnerRunCounters {
  return { ...zeroCounters(RUNNER_RUN_COUNTERS), ...counts };
}

/**
 * Job options with every default filled in, plus the explicit mask when
 * given — `jobOptions` for the stored shape, which alone carries `explicit`.
 */
function storedOptions(
  overrides: Partial<StoredJobOptions> = {},
): StoredJobOptions {
  return { ...jobOptions(), ...overrides };
}
