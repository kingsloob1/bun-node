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
  WorkerInfo,
} from "../../lib/index";
import { serializeError } from "@kingsleyweb/bun-common";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  countQueues,
  emptyCounts,
  findJobPage,
  findJobsByScan,
  getJobsByIds,
  getJobsByLoop,
  jobFilter,
  listWorkerRecords,
  matchesFilter,
  newToken,
  registerWorkerRecord,
  removeWorkerRecord,
  runnerKey,
  THROUGHPUT_BUCKET_MS,
  THROUGHPUT_RETENTION_MS,
  throughputBucket,
} from "../../lib/index";
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

      it("keeps a job's data, progress and return value when they are strings", async () => {
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
        expect(await driver.promoteDelayed(bq, now + 120_000, 100)).toBe(0);
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
      const parents: QueueRef = { ns, queue: "flow-parents" };
      const children: QueueRef = { ns, queue: "flow-children" };

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
      const child = (id: string): JobRef => ({ queue: children.queue, id });

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

      it("refuses to retry a parent still waiting on its children", async () => {
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
              flow: flowOf({ parent: { queue: parents.queue, id: "p" } }),
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
              flow: flowOf({ parent: { queue: parents.queue, id: "p" } }),
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
            parent: { queue: parents.queue, id: "p" },
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
