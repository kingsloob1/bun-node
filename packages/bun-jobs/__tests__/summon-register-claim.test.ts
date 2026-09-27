import type {
  JobProcessor,
  JobsDriver,
  QueueRef,
  SummonControllerOptions,
  SummonEventPayload,
  SummonPolicy,
  SummonRequest,
} from "../lib/index";
import type {
  SummonClaim,
  SummonClaimant,
  SummonClaimExit,
} from "../lib/summon/claim";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  createDriver,
  defineSummoner,
  registerWorkerRecord,
  runSummoned,
  SummonController,
} from "../lib/index";
import { setReservedState } from "../lib/queue/windows";
import {
  claimSummonAttempt,
  markSummonClaimExit,
  SUMMON_CLAIM_PREFIX,
  summonClaimName,
} from "../lib/summon/claim";
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";
import { fakePlatform, workerLines } from "./helpers/summon";

/**
 * Step 2 registers an attempt by its claim-once entry, and counts only a
 * clean exit as success.
 *
 * A summoned worker claims its attempt id in its first report and removes
 * its heartbeat record when it closes. One that starts, drains the backlog
 * and exits between two controller checks leaves no live record — only its
 * place in the claim. Before, such an attempt stayed pending until `until`
 * and was declared `lost`: a short-lived worker looked like a failed summon.
 *
 * But a claim alone would hide a crash loop — a worker that claims and then
 * dies counts as started, `#fail` never runs, and the controller summons it
 * again after every cooldown. So each holder marks its exit on the claim as
 * it closes (`runSummoned` with the real reason and code, `close()` with
 * `"closed"` where no mark is there yet), and the controller reads:
 *
 * - live, or gone with a code-0 mark: ran — `registered`, failures reset;
 * - a code-1 mark: `lost`, detail `exited-with-error`, counted;
 * - gone with no mark past its grace: `lost`, detail `died`, counted;
 * - no claim at all: `lost` at `until`, as before.
 *
 * Each case has a negative control run the same way with one ingredient
 * taken out.
 */

setDefaultTimeout(60_000);

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

/** What one test opened, closed after it in order. */
const perTest: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of perTest.splice(0)) {
    await cleanup().catch(() => {});
  }
});

const BACKENDS = await crossProcessBackends({ cleanups });

/** Triggers off and no cooldown: every check is one the test asked for. */
const QUIET: Partial<SummonControllerOptions> = {
  triggers: { onAdd: false, events: false, poll: false },
  cooldown: 0,
  logger: noopLogger,
};

/**
 * The same driver, except that every claim-once entry reads as absent: the
 * controller as it was before it read claims. Everything else goes to the
 * real driver, bound to it so its private fields still resolve.
 */
function hideClaims(driver: JobsDriver): JobsDriver {
  return new Proxy(driver, {
    get(target, property) {
      if (property === "getQueueState") {
        return async (q: QueueRef, name: string) =>
          name.startsWith(SUMMON_CLAIM_PREFIX)
            ? null
            : await target.getQueueState!(q, name);
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Queue-state calls on claim entries, as {@link countClaimCalls} saw them. */
interface ClaimCalls {
  /** Every read of a claim entry. */
  reads: number;
  /** Every write to a claim entry, with the value written. */
  writes: unknown[];
}

/**
 * The same driver, counting every queue-state read and write that touches a
 * claim entry. Everything else goes to the real driver untouched.
 */
function countClaimCalls(driver: JobsDriver): {
  driver: JobsDriver;
  calls: ClaimCalls;
} {
  const calls: ClaimCalls = { reads: 0, writes: [] };
  const proxy = new Proxy(driver, {
    get(target, property) {
      if (property === "getQueueState") {
        return async (q: QueueRef, name: string) => {
          if (name.startsWith(SUMMON_CLAIM_PREFIX)) {
            calls.reads++;
          }
          return await target.getQueueState!(q, name);
        };
      }
      if (property === "setQueueState") {
        return async (
          ...args: Parameters<NonNullable<JobsDriver["setQueueState"]>>
        ) => {
          if (args[1].startsWith(SUMMON_CLAIM_PREFIX)) {
            calls.writes.push(args[2]);
          }
          return await target.setQueueState!(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { driver: proxy, calls };
}

/** A summoner that records each request and starts nothing. */
function recorder(): {
  calls: SummonRequest[];
  summoner: SummonPolicy["summoner"];
} {
  const calls: SummonRequest[] = [];
  const summoner = defineSummoner({
    kind: "rec",
    bootBudget: 20_000,
    invoke: async (request) => {
      calls.push(request);
    },
  });
  return { calls, summoner };
}

/**
 * A claimant as a summoned worker's first report writes it. `gone` puts its
 * grace a minute in the past: a holder that claimed long enough ago that a
 * missing record means it is gone, without the test waiting that long.
 */
function claimant(worker: string, gone = false): SummonClaimant {
  const now = gone ? Date.now() - 60_000 : Date.now();
  return { worker, host: "h", pid: 1, at: now, until: now + 600 };
}

/** A clean exit mark, as `runSummoned` writes one for an idle stop. */
const CLEAN: SummonClaimExit = { exitedAt: 0, reason: "idle", code: 0 };
/** A failing exit mark: `run()` failed. */
const FAILED: SummonClaimExit = { exitedAt: 0, reason: "error", code: 1 };

/** The claim entry of an attempt, read straight from the store. */
async function readClaim(
  driver: JobsDriver,
  ref: QueueRef,
  id: string,
): Promise<SummonClaim | undefined> {
  const entry = await driver.getQueueState!(ref, summonClaimName(id));
  return (entry?.value as SummonClaim | undefined) ?? undefined;
}

/**
 * Rewrites a claim as if its holders had died instead: every exit mark
 * removed and every grace put in the past. The negative control for a
 * worker's own mark.
 */
async function unmark(
  driver: JobsDriver,
  ref: QueueRef,
  id: string,
): Promise<void> {
  const name = summonClaimName(id);
  const entry = await driver.getQueueState!(ref, name);
  const claim = entry!.value as SummonClaim;
  const past = Date.now() - 60_000;
  const holders = claim.holders.map(({ exit: _exit, ...holder }) => ({
    ...holder,
    at: past,
    until: past + 600,
  }));
  expect(
    await setReservedState(
      driver,
      ref,
      name,
      { ...claim, holders },
      entry!.version,
    ),
  ).not.toBe(null);
}

/** The outcomes a controller announced, in order. */
function outcomes(events: readonly SummonEventPayload[]): string[] {
  return events.map((event) => event.outcome);
}

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `summon registration by claim: ${backend.name}`,
    () => {
      /** A fresh namespace and queue on a fresh driver, purged afterwards. */
      async function setup(): Promise<{
        driver: JobsDriver;
        namespace: string;
        ref: QueueRef;
        queue: BunQueue<unknown>;
        controller: (
          policy: Partial<SummonPolicy> & Pick<SummonPolicy, "summoner">,
          over?: JobsDriver,
        ) => SummonController;
        events: SummonEventPayload[];
      }> {
        const driver = createDriver(backend.config);
        await driver.connect();
        const namespace = testNamespace(`regclaim-${backend.name}`);
        const queue = new BunQueue("work", {
          namespace,
          driver,
          logger: noopLogger,
        });
        const events: SummonEventPayload[] = [];
        const owned: SummonController[] = [];
        perTest.push(async () => {
          await Promise.allSettled(owned.map(async (one) => await one.close()));
          await queue.close().catch(() => {});
          await driver.purge(namespace);
          await driver.close();
        });
        return {
          driver,
          namespace,
          ref: { ns: namespace, queue: "work" },
          queue,
          events,
          controller: (policy, over = driver) => {
            const controller = new SummonController({
              ...QUIET,
              ...policy,
              driver: over,
              namespace,
              queue: "work",
            });
            controller.on("summon", (event) => events.push(event));
            owned.push(controller);
            return controller;
          },
        };
      }

      /** A summoned worker on the queue, reporting quickly, closed with the test. */
      function summonedWorker(
        driver: JobsDriver,
        namespace: string,
        id: string,
        processor: JobProcessor = async () => {},
      ): BunQueueWorker {
        const one = new BunQueueWorker("work", processor, {
          namespace,
          driver,
          summon: { id, kind: "rec" },
          pollInterval: 20,
          reportInterval: 100,
          logger: noopLogger,
        });
        perTest.unshift(async () => await one.close({ force: true }));
        return one;
      }

      /** Runs `summoned` until it won its claim and completed `jobId`. */
      async function runUntilDone(
        summoned: BunQueueWorker,
        queue: BunQueue<unknown>,
        jobId: string,
        id: string,
      ): Promise<void> {
        void summoned.run();
        await waitFor(
          async () =>
            (await queue.getJob(jobId))?.state === "completed" &&
            summoned.summon?.id === id,
          { timeout: 10_000 },
        );
      }

      /* --- a clean exit registers ------------------------------------- */

      it("registers an attempt whose worker marked a clean exit and was gone before the check", async () => {
        const { driver, ref, queue, controller, events } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({ summoner, bootBudget: 300 });
        await queue.add("a", {});
        expect(await summon.check()).toMatchObject({ action: "summoned" });
        const id = calls[0]!.id;

        // It claimed, drained the backlog, marked its exit and closed: no
        // live record carries the id.
        expect(await claimSummonAttempt(driver, ref, id, claimant("w1"))).toBe(
          true,
        );
        await queue.drain();
        expect(
          await markSummonClaimExit(driver, ref, id, "w1", CLEAN, true),
        ).toBe("written");
        expect(
          (await queue.listWorkers()).some((one) => one.summon?.id === id),
        ).toBe(false);

        await summon.check();
        expect(outcomes(events)).toEqual(["started", "registered"]);
        let status = await summon.status();
        expect(status.pending).toHaveLength(0);
        expect(status.failures).toBe(0);
        expect(status.last).toMatchObject({ id, outcome: "registered" });

        // Past `until` nothing is declared lost, and nothing was counted.
        await Bun.sleep(350);
        await summon.check();
        expect(outcomes(events)).not.toContain("lost");
        status = await summon.status();
        expect(status.failures).toBe(0);
        expect(status.backoffUntil ?? 0).toBeLessThanOrEqual(Date.now());
      });

      it("negative control: the same marked claim, hidden from the controller, is lost at until and counted", async () => {
        const { driver, ref, queue, controller, events } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller(
          { summoner, bootBudget: 300, backoff: { initial: 5_000 } },
          hideClaims(driver),
        );
        await queue.add("a", {});
        expect(await summon.check()).toMatchObject({ action: "summoned" });
        const id = calls[0]!.id;
        expect(await claimSummonAttempt(driver, ref, id, claimant("w1"))).toBe(
          true,
        );
        expect(
          await markSummonClaimExit(driver, ref, id, "w1", CLEAN, true),
        ).toBe("written");
        // The entry is really there: only the controller cannot see it.
        expect(await readClaim(driver, ref, id)).toBeDefined();

        expect(await summon.check()).toMatchObject({ reason: "pending" });
        await Bun.sleep(350);
        await summon.check();
        expect(outcomes(events)).toEqual(["started", "lost"]);
        const status = await summon.status();
        expect(status.failures).toBe(1);
        expect(status.backoffUntil).toBeGreaterThan(Date.now() + 4_000);
      });

      it("with no claim entry at all, behaves as before: lost at until, no detail, counted", async () => {
        const { driver, ref, queue, controller, events } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({
          summoner,
          bootBudget: 300,
          backoff: { initial: 5_000 },
        });
        await queue.add("a", {});
        await summon.check();
        const id = calls[0]!.id;
        expect(await readClaim(driver, ref, id)).toBeUndefined();

        expect(await summon.check()).toMatchObject({ reason: "pending" });
        await Bun.sleep(350);
        await summon.check();
        expect(outcomes(events)).toEqual(["started", "lost"]);
        expect(events[1]!.detail).toBeUndefined();
        expect((await summon.status()).failures).toBe(1);
      });

      /* --- a worker's own close marks it ------------------------------- */

      for (const force of [false, true]) {
        it(`registers a summoned BunQueueWorker, without runSummoned, closed ${force ? "with force" : "gracefully"} between two checks`, async () => {
          const { driver, namespace, ref, queue, controller, events } =
            await setup();
          const { calls, summoner } = recorder();
          const summon = controller({ summoner });
          const job = await queue.add("a", {});
          await summon.check();
          const id = calls[0]!.id;

          const summoned = summonedWorker(driver, namespace, id);
          await runUntilDone(summoned, queue, job.id, id);
          await summoned.close(force ? { force: true } : undefined);
          expect(
            (await queue.listWorkers()).some((one) => one.summon?.id === id),
          ).toBe(false);
          const holder = (await readClaim(driver, ref, id))!.holders[0]!;
          expect(holder.worker).toBe(summoned.id);
          expect(holder.exit).toMatchObject({ reason: "closed", code: 0 });
          expect(holder.exit!.forced).toBe(force ? true : undefined);

          await summon.check();
          expect(outcomes(events)).toEqual(["started", "registered"]);
          expect((await summon.status()).failures).toBe(0);
        });
      }

      it("negative control: the same close with its mark taken away reads as died, and is counted", async () => {
        const { driver, namespace, ref, queue, controller, events } =
          await setup();
        const { calls, summoner } = recorder();
        const summon = controller({ summoner });
        const job = await queue.add("a", {});
        await summon.check();
        const id = calls[0]!.id;

        const summoned = summonedWorker(driver, namespace, id);
        await runUntilDone(summoned, queue, job.id, id);
        await summoned.close();
        await unmark(driver, ref, id);

        await summon.check();
        expect(outcomes(events)).toEqual(["started", "lost"]);
        expect(events[1]!.detail).toBe("died");
        expect((await summon.status()).failures).toBe(1);
      });

      it("writes nothing to any claim when an unsummoned worker closes, and one mark when a summoned one does", async () => {
        const { driver, namespace, queue } = await setup();
        const plain = countClaimCalls(driver);
        const ordinary = new BunQueueWorker("work", async () => {}, {
          namespace,
          driver: plain.driver,
          pollInterval: 20,
          reportInterval: 100,
          logger: noopLogger,
        });
        perTest.unshift(async () => await ordinary.close({ force: true }));
        const first = await queue.add("a", {});
        void ordinary.run();
        await waitFor(
          async () => (await queue.getJob(first.id))?.state === "completed",
          { timeout: 10_000 },
        );
        await Bun.sleep(150); // a report or two
        await ordinary.close();
        expect(plain.calls).toEqual({ reads: 0, writes: [] });

        // The control: the same counter sees a summoned worker's claim and mark.
        const counted = countClaimCalls(driver);
        const summoned = summonedWorker(
          counted.driver,
          namespace,
          "sm_counted",
        );
        const second = await queue.add("b", {});
        await runUntilDone(summoned, queue, second.id, "sm_counted");
        const before = counted.calls.writes.length;
        await summoned.close();
        const marks = counted.calls.writes
          .slice(before)
          .filter((value) =>
            (value as SummonClaim | null)?.holders?.some(
              (holder) => holder.exit !== undefined,
            ),
          );
        expect(marks).toHaveLength(1);
      });

      it("writes exactly one mark when a force escalates a graceful close mid-way (#207)", async () => {
        const { driver, namespace, ref, queue } = await setup();
        const counted = countClaimCalls(driver);
        let started = false;
        // Ignores its signal: the graceful close waits on it until forced.
        const hold = Promise.withResolvers<void>();
        perTest.push(async () => hold.resolve());
        const summoned = summonedWorker(
          counted.driver,
          namespace,
          "sm_escalated",
          async (job) => {
            if (job.name === "hold") {
              started = true;
              await hold.promise;
            }
          },
        );
        const warm = await queue.add("warm", {});
        await runUntilDone(summoned, queue, warm.id, "sm_escalated");
        await queue.add("hold", {});
        await waitFor(() => started, { timeout: 10_000 });

        const before = counted.calls.writes.length;
        const graceful = summoned.close({ timeout: 30_000 });
        await Bun.sleep(50);
        const forced = summoned.close({ force: true });
        await Promise.all([graceful, forced]);

        const marks = counted.calls.writes
          .slice(before)
          .filter((value) =>
            (value as SummonClaim | null)?.holders?.some(
              (holder) => holder.exit !== undefined,
            ),
          );
        expect(marks).toHaveLength(1);
        const holder = (await readClaim(driver, ref, "sm_escalated"))!
          .holders[0]!;
        expect(holder.exit).toMatchObject({
          reason: "closed",
          code: 0,
          forced: true,
        });
        // The control: a second fill-only mark finds the first and keeps it.
        expect(
          await markSummonClaimExit(
            driver,
            ref,
            "sm_escalated",
            summoned.id,
            CLEAN,
            false,
          ),
        ).toBe("kept");
      });

      /* --- runSummoned's mark wins ------------------------------------- */

      it("keeps runSummoned's reason and code: the worker's own close does not overwrite them", async () => {
        const { driver, namespace, ref, queue, controller, events } =
          await setup();
        const { calls, summoner } = recorder();
        const summon = controller({ summoner });
        await queue.add("a", {});
        await summon.check();
        const id = calls[0]!.id;

        const summoned = new BunQueueWorker("work", async () => {}, {
          namespace,
          driver,
          summon: { id, kind: "rec" },
          pollInterval: 20,
          reportInterval: 100,
          logger: noopLogger,
        });
        perTest.unshift(async () => await summoned.close({ force: true }));
        const result = await runSummoned(summoned, {
          idleFor: 100,
          idleCheckInterval: 20,
          signals: false,
          exit: false,
          logger: noopLogger,
        });
        expect(result).toMatchObject({ reason: "idle", code: 0, completed: 1 });
        const holder = (await readClaim(driver, ref, id))!.holders[0]!;
        expect(holder.exit).toMatchObject({ reason: "idle", code: 0 });

        await summon.check();
        expect(outcomes(events)).toEqual(["started", "registered"]);
      });

      it("keeps a code-1 mark a failure after the worker's own close has run", async () => {
        const { driver, namespace, ref, queue, controller, events } =
          await setup();
        const { calls, summoner } = recorder();
        const summon = controller({ summoner, backoff: { initial: 5_000 } });
        const job = await queue.add("a", {});
        await summon.check();
        const id = calls[0]!.id;

        const summoned = summonedWorker(driver, namespace, id);
        await runUntilDone(summoned, queue, job.id, id);
        // What runSummoned writes when run() failed, before it closes.
        expect(
          await markSummonClaimExit(driver, ref, id, summoned.id, FAILED, true),
        ).toBe("written");
        await summoned.close();
        expect(
          (await readClaim(driver, ref, id))!.holders[0]!.exit,
        ).toMatchObject({ reason: "error", code: 1 });
        // Not even a replacing write turns a failure into a success.
        expect(
          await markSummonClaimExit(driver, ref, id, summoned.id, CLEAN, true),
        ).toBe("kept");

        await summon.check();
        expect(outcomes(events)).toEqual(["started", "lost"]);
        expect(events[1]!.detail).toBe("exited-with-error");
        const status = await summon.status();
        expect(status.failures).toBe(1);
        expect(status.last).toMatchObject({ detail: "exited-with-error" });
      });

      for (const marked of [true, false]) {
        it(
          marked
            ? "counts a holder still listed but marked code 1 as exited-with-error, not as running"
            : "negative control: the same listed holder with no mark is running, and registers",
          async () => {
            const { driver, ref, queue, controller, events } = await setup();
            const { calls, summoner } = recorder();
            const summon = controller({ summoner });
            await queue.add("a", {});
            await summon.check();
            const id = calls[0]!.id;
            expect(
              await claimSummonAttempt(driver, ref, id, claimant("w1")),
            ).toBe(true);
            // Its record still carries the id: the close has not removed it yet.
            await registerWorkerRecord(driver, ref, {
              id: "w1",
              queue: "work",
              host: "h",
              pid: 1,
              concurrency: 1,
              active: 0,
              paused: false,
              startedAt: Date.now(),
              heartbeatAt: Date.now(),
              expiresAt: Date.now() + 10_000,
              summon: { id },
            });
            if (marked) {
              expect(
                await markSummonClaimExit(driver, ref, id, "w1", FAILED, true),
              ).toBe("written");
            }

            await summon.check();
            expect(outcomes(events)).toEqual([
              "started",
              marked ? "lost" : "registered",
            ]);
            expect(events[1]!.detail).toBe(
              marked ? "exited-with-error" : undefined,
            );
            expect((await summon.status()).failures).toBe(marked ? 1 : 0);
          },
        );
      }

      /* --- a crash is a failure ---------------------------------------- */

      it("counts a claim with no exit mark and no live record, past its grace, as died — and a loop of them opens the circuit", async () => {
        const { driver, ref, queue, controller, events } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({
          summoner,
          backoff: { initial: 1, max: 1 },
          circuit: { failures: 2, resetAfter: 60_000 },
        });
        await queue.add("a", {});

        for (let round = 0; round < 2; round++) {
          expect(await summon.check()).toMatchObject({ action: "summoned" });
          // It claimed, then crashed: no mark, no record, grace long gone.
          expect(
            await claimSummonAttempt(
              driver,
              ref,
              calls[round]!.id,
              claimant(`w${round}`, true),
            ),
          ).toBe(true);
          await summon.check();
          await Bun.sleep(5);
        }
        expect(outcomes(events)).toEqual([
          "started",
          "lost",
          "started",
          "lost",
        ]);
        expect(events[1]!.detail).toBe("died");
        expect(events[3]!.detail).toBe("died");
        expect(await summon.check()).toMatchObject({
          action: "skipped",
          reason: "circuit-open",
        });
        expect((await summon.status()).failures).toBe(2);
        expect(calls).toHaveLength(2);
      });

      it("negative control: the same loop with each exit marked clean counts nothing and never opens the circuit", async () => {
        const { driver, ref, queue, controller, events } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({
          summoner,
          backoff: { initial: 1, max: 1 },
          circuit: { failures: 2, resetAfter: 60_000 },
        });
        await queue.add("a", {});

        expect(await summon.check()).toMatchObject({ action: "summoned" });
        for (let round = 0; round < 3; round++) {
          const id = calls[round]!.id;
          const holder = claimant(`w${round}`, true);
          expect(await claimSummonAttempt(driver, ref, id, holder)).toBe(true);
          expect(
            await markSummonClaimExit(
              driver,
              ref,
              id,
              holder.worker,
              CLEAN,
              true,
            ),
          ).toBe("written");
          // Registers this attempt and, the job still waiting, summons again.
          expect(await summon.check()).toMatchObject({ action: "summoned" });
        }
        expect(outcomes(events)).not.toContain("lost");
        expect(outcomes(events)).toEqual([
          "started",
          "registered",
          "started",
          "registered",
          "started",
          "registered",
          "started",
        ]);
        expect((await summon.status()).failures).toBe(0);
        expect(calls).toHaveLength(4);
      });

      it("keeps a holder with no mark and no record pending inside its grace", async () => {
        const { driver, ref, queue, controller, events } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({ summoner });
        await queue.add("a", {});
        await summon.check();
        // Claimed a moment ago; its first record may still be on its way.
        expect(
          await claimSummonAttempt(driver, ref, calls[0]!.id, claimant("w1")),
        ).toBe(true);
        expect(await summon.check()).toMatchObject({ reason: "pending" });
        expect(outcomes(events)).toEqual(["started"]);
      });

      /* --- several workers --------------------------------------------- */

      it("counts every holder of an attempt for several workers", async () => {
        const { driver, ref, queue, controller, events } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({
          summoner,
          maxWorkers: 3,
          jobsPerWorker: 1,
          // No second attempt while this one is watched.
          cooldown: 60_000,
        });
        await queue.addBulk([
          { name: "a", data: {} },
          { name: "b", data: {} },
          { name: "c", data: {} },
        ]);
        expect(await summon.check()).toMatchObject({ action: "summoned" });
        expect(calls[0]!.count).toBe(3);
        const id = calls[0]!.id;

        // Two of three ran and left cleanly: still pending, one on its way.
        for (const worker of ["w1", "w2"]) {
          expect(
            await claimSummonAttempt(driver, ref, id, claimant(worker)),
          ).toBe(true);
          expect(
            await markSummonClaimExit(driver, ref, id, worker, CLEAN, true),
          ).toBe("written");
        }
        await summon.check();
        expect(outcomes(events)).toEqual(["started"]);
        expect((await summon.status()).pending.map((one) => one.id)).toEqual([
          id,
        ]);

        // The third claims and is running: its record is live.
        expect(await claimSummonAttempt(driver, ref, id, claimant("w3"))).toBe(
          true,
        );
        await registerWorkerRecord(driver, ref, {
          id: "w3",
          queue: "work",
          host: "h",
          pid: 1,
          concurrency: 1,
          active: 0,
          paused: false,
          startedAt: Date.now(),
          heartbeatAt: Date.now(),
          expiresAt: Date.now() + 10_000,
        });
        await summon.check();
        expect(outcomes(events)).toEqual(["started", "registered"]);
        expect((await summon.status()).pending).toHaveLength(0);
        expect((await summon.status()).failures).toBe(0);
      });

      it("counts an attempt for two workers, one clean and one dead, as a success", async () => {
        const { driver, ref, queue, controller, events } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({
          summoner,
          maxWorkers: 2,
          jobsPerWorker: 1,
          cooldown: 60_000,
        });
        await queue.addBulk([
          { name: "a", data: {} },
          { name: "b", data: {} },
        ]);
        await summon.check();
        expect(calls[0]!.count).toBe(2);
        const id = calls[0]!.id;
        expect(
          await claimSummonAttempt(driver, ref, id, claimant("clean", true)),
        ).toBe(true);
        expect(
          await markSummonClaimExit(driver, ref, id, "clean", CLEAN, true),
        ).toBe("written");
        expect(
          await claimSummonAttempt(driver, ref, id, claimant("dead", true)),
        ).toBe(true);

        await summon.check();
        expect(outcomes(events)).toEqual(["started", "registered"]);
        expect((await summon.status()).failures).toBe(0);
      });

      it("negative control: an attempt for two workers, both dead, is lost and counted", async () => {
        const { driver, ref, queue, controller, events } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({
          summoner,
          maxWorkers: 2,
          jobsPerWorker: 1,
          cooldown: 60_000,
        });
        await queue.addBulk([
          { name: "a", data: {} },
          { name: "b", data: {} },
        ]);
        await summon.check();
        const id = calls[0]!.id;
        for (const worker of ["dead1", "dead2"]) {
          expect(
            await claimSummonAttempt(driver, ref, id, claimant(worker, true)),
          ).toBe(true);
        }

        await summon.check();
        expect(outcomes(events)).toEqual(["started", "lost"]);
        expect(events[1]!.detail).toBe("died");
        expect((await summon.status()).failures).toBe(1);
      });
    },
  );
}

/**
 * End to end with the fake platform: real processes. Spawning is the slow
 * part, so on the two serverless backends, and on Redis and Postgres when
 * their URLs are set.
 */
for (const backend of BACKENDS.filter((one) =>
  ["file", "sqlite", "redis", "postgres"].includes(one.name),
)) {
  describe.skipIf(!backend.available)(
    `summon registration by claim, fake platform: ${backend.name}`,
    () => {
      /** A controller over a fake platform, on a fresh namespace; all cleaned up. */
      async function setup(
        env: Record<string, string>,
        hide = false,
      ): Promise<{
        driver: JobsDriver;
        ref: QueueRef;
        queue: BunQueue<unknown>;
        controller: SummonController;
        platform: ReturnType<typeof fakePlatform>;
        events: SummonEventPayload[];
      }> {
        const driver = createDriver(backend.config);
        await driver.connect();
        const namespace = testNamespace(`regclaim-e2e-${backend.name}`);
        const queue = new BunQueue("work", {
          namespace,
          driver,
          logger: noopLogger,
        });
        const platform = fakePlatform({ driver: backend.config, env });
        const controller = new SummonController({
          ...QUIET,
          driver: hide ? hideClaims(driver) : driver,
          namespace,
          queue: "work",
          summoner: platform.summoner,
          bootBudget: 1_500,
          backoff: { initial: 5_000 },
        });
        const events: SummonEventPayload[] = [];
        controller.on("summon", (event) => events.push(event));
        perTest.push(async () => {
          await controller.close();
          await platform.kill();
          await queue.close();
          await driver.purge(namespace);
          await driver.close();
        });
        return {
          driver,
          ref: { ns: namespace, queue: "work" },
          queue,
          controller,
          platform,
          events,
        };
      }

      /** Summons for one job, waits for the worker to exit, and runs the next check past `until`. */
      async function run(hide: boolean): Promise<{
        events: SummonEventPayload[];
        failures: number;
        lines: Record<string, unknown>[];
        recordLeft: boolean;
      }> {
        const { queue, controller, platform, events } = await setup(
          { SUMMON_TEST_RUN_SUMMONED_IDLE_MS: "100" },
          hide,
        );
        await queue.add("a", {});
        expect(await controller.check()).toMatchObject({
          action: "summoned",
        });
        // The slow poll: no check until the worker has come and gone.
        await platform.settled();
        const lines = await workerLines(platform.spawned[0]!);
        const id = platform.calls[0]!.id;
        const recordLeft = (await queue.listWorkers()).some(
          (one) => one.summon?.id === id,
        );
        const until = (await controller.status()).pending[0]?.until ?? 0;
        await Bun.sleep(Math.max(0, until - Date.now() + 50));
        await controller.check();
        return {
          events,
          failures: (await controller.status()).failures,
          lines,
          recordLeft,
        };
      }

      it("registers the attempt of a runSummoned worker that drained and exited inside one poll gap", async () => {
        const { events, failures, lines, recordLeft } = await run(false);
        expect(lines.find((line) => line.event === "exit")).toMatchObject({
          reason: "idle",
          completed: 1,
        });
        expect(recordLeft).toBe(false);
        expect(outcomes(events)).toEqual(["started", "registered"]);
        expect(failures).toBe(0);
      });

      it("negative control: with its claim hidden from the controller, the same run is lost and counted", async () => {
        const { events, failures, lines, recordLeft } = await run(true);
        expect(lines.find((line) => line.event === "exit")).toMatchObject({
          reason: "idle",
          completed: 1,
        });
        expect(recordLeft).toBe(false);
        expect(outcomes(events)).toEqual(["started", "lost"]);
        expect(failures).toBe(1);
      });

      it("reads a worker killed with SIGKILL, never closed, as died", async () => {
        const { driver, ref, queue, controller, platform, events } =
          await setup({ SUMMON_TEST_IDLE_MS: "30000" });
        await queue.add("a", {});
        expect(await controller.check()).toMatchObject({
          action: "summoned",
        });
        const id = platform.calls[0]!.id;
        await waitFor(
          async () =>
            ((await readClaim(driver, ref, id))?.holders.length ?? 0) > 0,
          { timeout: 20_000, interval: 20 },
        );
        await waitFor(() => platform.spawned.length > 0);
        platform.spawned[0]!.proc.kill("SIGKILL");
        await platform.settled();
        expect(
          (await readClaim(driver, ref, id))!.holders[0]!.exit,
        ).toBeUndefined();
        // Its record outlives it by up to a record lifetime; a check before
        // that lapses sees it running, which is a registration.
        await waitFor(
          async () =>
            !(await queue.listWorkers()).some((one) => one.summon?.id === id),
          { timeout: 20_000, interval: 50 },
        );

        // Its record lapses and its grace (claim + record lifetime + skew
        // allowance) passes: then it is gone, with no mark.
        await waitFor(
          async () => {
            await controller.check();
            return events.length > 1;
          },
          { timeout: 20_000, interval: 250 },
        );
        expect(outcomes(events)).toEqual(["started", "lost"]);
        expect(events[1]!.detail).toBe("died");
        expect((await controller.status()).failures).toBe(1);
      });
    },
  );
}
