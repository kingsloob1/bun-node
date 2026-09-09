import type { JobsDriver, QueueRef } from "../../lib/index";
import { serializeError } from "@kingsleyweb/bun-common";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { newToken, runnerKey } from "../../lib/index";
import { makeJob, testNamespace, waitFor } from "../helpers";

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
    const q: QueueRef = { ns, queue: "orders" };

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
    });

    /* --- jobs -------------------------------------------------------- */

    describe("jobs", () => {
      it("adds idempotently on the id", async () => {
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

      it("claims in priority then FIFO order, exactly once each", async () => {
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

      it("stamps the claim on the job", async () => {
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

      it("does not claim a job before its runAt", async () => {
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

        // Once due, promotion makes it claimable.
        expect(await driver.promoteDelayed(q, now + 60_001, 10)).toBe(1);
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

      it("keeps a retrying job separate from a dead one", async () => {
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
        await driver.drainQueue(q, true);
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

      it("records progress", async () => {
        const now = Date.now();
        await driver.addJob(q, makeJob({ id: "progressive", runAt: now }));

        expect(await driver.updateProgress(q, "progressive", 42)).toBe(true);
        expect((await driver.getJob(q, "progressive"))?.progress).toBe(42);
        expect(await driver.updateProgress(q, "missing", 1)).toBe(false);

        await driver.removeJob(q, "progressive");
      });

      it("pauses claiming across the queue", async () => {
        const now = Date.now();
        await driver.drainQueue(q, true);
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
        await driver.drainQueue(q, true);
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
        await driver.drainQueue(q, true);
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

      it("delivers published events to subscribers of that target", async () => {
        const received: string[] = [];
        const unsubscribe = await driver.subscribe(
          ns,
          "queue",
          "events-test",
          (event) => received.push(event.type),
        );

        await driver.publish({
          v: 1,
          ns,
          kind: "queue",
          target: "events-test",
          type: "completed",
          at: Date.now(),
          origin: newToken(),
        });

        // Another target's events must not arrive here.
        await driver.publish({
          v: 1,
          ns,
          kind: "queue",
          target: "somewhere-else",
          type: "failed",
          at: Date.now(),
          origin: newToken(),
        });

        await waitFor(() => received.length > 0, {
          message: "no event delivered",
        });
        expect(received).toEqual(["completed"]);

        await unsubscribe();
        await driver.publish({
          v: 1,
          ns,
          kind: "queue",
          target: "events-test",
          type: "after-unsubscribe",
          at: Date.now(),
          origin: newToken(),
        });
        await Bun.sleep(20);
        expect(received).toEqual(["completed"]);
      });
    });

    /* --- discovery and purge ------------------------------------------ */

    describe("discovery and purge", () => {
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
