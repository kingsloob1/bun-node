import type { JobRecord, JobsDriver, QueueRef } from "../../lib/index";
import { serializeError } from "@kingsleyweb/bun-common";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { newToken, runnerKey } from "../../lib/index";
import { queueEvent } from "../../lib/shared/events";
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

      it("survives an id taken between the look and the write", async () => {
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
        expect(await driver.promoteDelayed(uq, now, 10)).toBe(0);
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
