import type {
  JobProcessor,
  JobsDriver,
  QueueRef,
  SummonControllerOptions,
  SummonEventPayload,
  SummonMarker,
  SummonPolicy,
  SummonRequest,
  WatchedSummon,
} from "../lib/index";
import type {
  SummonClaim,
  SummonClaimant,
  SummonClaimExit,
} from "../lib/summon/claim";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
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
  removeWorkerRecord,
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
import {
  freshMarker,
  isSummonMarker,
  readMarker,
  SUMMON_MARKER,
} from "../lib/summon/marker";
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
 * - gone with a code-0 mark: ran — `registered`, failures reset;
 * - live with no mark yet: `registered` too, but **watched** until its
 *   `until`, off the capacity count, so one that crashes after its first
 *   report is still counted (`lost`, `died`) and a clean one resets failures;
 * - a code-1 mark: `lost`, detail `exited-with-error`, counted;
 * - gone with no mark past its grace — the later of the attempt's and the
 *   claim's `until`, plus 5 s — `lost`, detail `died`, counted; before it, a
 *   holder whose record lapsed may only be busy, and is not dead;
 * - no claim at all: `lost` at `until`, as before.
 *
 * The grace is seconds past a boot budget, so cases that need it passed move
 * the marker's clock back ({@link ageMarker}) rather than wait it out.
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
 * A summoner whose answer the test switches: `unavailable` (a failure that
 * counts) or `started`.
 */
function switchable(): {
  calls: SummonRequest[];
  summoner: SummonPolicy["summoner"];
  answer: { mode: "unavailable" | "started" };
} {
  const calls: SummonRequest[] = [];
  const answer: { mode: "unavailable" | "started" } = { mode: "unavailable" };
  const summoner = defineSummoner({
    kind: "rec",
    bootBudget: 20_000,
    invoke: async (request) => {
      calls.push(request);
      return answer.mode === "unavailable"
        ? { status: "unavailable", reason: "no capacity" }
        : undefined;
    },
  });
  return { calls, summoner, answer };
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

/**
 * Moves every pending and watched attempt's `until` (and start, and a watch's
 * extension) a minute into the past, and its claim holders' with it, as if
 * its boot budget and grace had run out: what a check would find after
 * waiting that long. Worker records are left as they are.
 */
async function ageMarker(driver: JobsDriver, ref: QueueRef): Promise<void> {
  const entry = await driver.getQueueState!(ref, SUMMON_MARKER);
  const marker = entry!.value as SummonMarker;
  const past = Date.now() - 60_000;
  for (const { id } of [...marker.pending, ...(marker.watching ?? [])]) {
    const name = summonClaimName(id);
    const claimEntry = await driver.getQueueState!(ref, name);
    if (claimEntry === null) {
      continue;
    }
    const claim = claimEntry.value as SummonClaim;
    const holders = claim.holders.map((holder) => ({
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
        claimEntry.version,
      ),
    ).not.toBe(null);
  }
  const aged: SummonMarker = {
    ...marker,
    pending: marker.pending.map((one) => ({ ...one, at: past, until: past })),
    ...(marker.watching === undefined
      ? {}
      : {
          watching: marker.watching.map((one) => ({
            ...one,
            at: past,
            until: past,
            ...(one.extendedUntil === undefined ? {} : { extendedUntil: past }),
          })),
        }),
  };
  expect(
    await setReservedState(driver, ref, SUMMON_MARKER, aged, entry!.version),
  ).not.toBe(null);
}

/** The marker's watched attempts, read straight from the store. */
async function watchedIds(
  driver: JobsDriver,
  ref: QueueRef,
): Promise<string[]> {
  const entry = await driver.getQueueState!(ref, SUMMON_MARKER);
  return ((entry?.value as SummonMarker | undefined)?.watching ?? []).map(
    (one) => one.id,
  );
}

/** The marker's loss streak, read straight from the store (absent is 0). */
async function streakOf(driver: JobsDriver, ref: QueueRef): Promise<number> {
  const entry = await driver.getQueueState!(ref, SUMMON_MARKER);
  return (entry?.value as SummonMarker | undefined)?.lossStreak ?? 0;
}

/** A live heartbeat record for `worker`, carrying `summonId` when given. */
async function liveRecord(
  driver: JobsDriver,
  ref: QueueRef,
  worker: string,
  summonId?: string,
  lifetime = 60_000,
): Promise<void> {
  const now = Date.now();
  await registerWorkerRecord(driver, ref, {
    id: worker,
    queue: ref.queue,
    host: "h",
    pid: 1,
    concurrency: 1,
    active: 0,
    paused: false,
    startedAt: now,
    heartbeatAt: now,
    expiresAt: now + lifetime,
    ...(summonId === undefined ? {} : { summon: { id: summonId } }),
  });
}

/**
 * The same driver, counting every write to the summon marker. Everything
 * else goes to the real driver untouched.
 */
function countMarkerWrites(driver: JobsDriver): {
  driver: JobsDriver;
  writes: () => number;
} {
  let writes = 0;
  const proxy = new Proxy(driver, {
    get(target, property) {
      if (property === "setQueueState") {
        return async (
          ...args: Parameters<NonNullable<JobsDriver["setQueueState"]>>
        ) => {
          if (args[1] === SUMMON_MARKER) {
            writes++;
          }
          return await target.setQueueState!(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { driver: proxy, writes: () => writes };
}

/** The outcomes a controller announced, in order. */
function outcomes(events: readonly SummonEventPayload[]): string[] {
  return events.map((event) => event.outcome);
}

/**
 * The `lost` events of attempts announced `registered` before it, in order:
 * the late losses of workers seen running. Not an attempt lost at its
 * `until` because no worker had claimed it yet — under heavy load a spawn
 * and first report can outlast any boot budget, and such a loss is counted
 * with no detail, by design.
 */
function lateLosses(
  events: readonly SummonEventPayload[],
): SummonEventPayload[] {
  return events.filter(
    (event, index) =>
      event.outcome === "lost" &&
      events
        .slice(0, index)
        .some((one) => one.id === event.id && one.outcome === "registered"),
  );
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
          policy: Partial<SummonPolicy> &
            Pick<SummonPolicy, "summoner"> &
            Pick<Partial<SummonControllerOptions>, "logger">,
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
        await ageMarker(driver, ref);

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
          await ageMarker(driver, ref);
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

      for (const second of ["dead", "clean"] as const) {
        it(
          second === "dead"
            ? "counts an attempt for two workers, one clean and one dead, as registered and then one failure"
            : "negative control: the same attempt with both workers clean is registered and counts nothing",
          async () => {
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
            for (const worker of [
              "clean",
              second === "dead" ? "dead" : "clean2",
            ]) {
              expect(
                await claimSummonAttempt(
                  driver,
                  ref,
                  id,
                  claimant(worker, true),
                ),
              ).toBe(true);
            }
            expect(
              await markSummonClaimExit(driver, ref, id, "clean", CLEAN, true),
            ).toBe("written");
            if (second === "clean") {
              expect(
                await markSummonClaimExit(
                  driver,
                  ref,
                  id,
                  "clean2",
                  CLEAN,
                  true,
                ),
              ).toBe("written");
            }

            // Before the attempt's until, a holder gone unmarked is not dead yet.
            await summon.check();
            if (second === "dead") {
              expect(outcomes(events)).toEqual(["started"]);
              await ageMarker(driver, ref);
              await summon.check();
              // One failure for the attempt, after its registration.
              expect(outcomes(events)).toEqual([
                "started",
                "registered",
                "lost",
              ]);
              expect(events[2]).toMatchObject({ id, detail: "died" });
              expect((await summon.status()).failures).toBe(1);
            } else {
              expect(outcomes(events)).toEqual(["started", "registered"]);
              expect((await summon.status()).failures).toBe(0);
            }
            expect(await watchedIds(driver, ref)).toEqual([]);
          },
        );
      }

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

        await ageMarker(driver, ref);
        await summon.check();
        expect(outcomes(events)).toEqual(["started", "lost"]);
        expect(events[1]!.detail).toBe("died");
        expect((await summon.status()).failures).toBe(1);
      });

      /* --- watching: a crash after the first report -------------------- */

      for (const exit of ["crash", "clean"] as const) {
        it(
          exit === "crash"
            ? "A2: workers seen live that then die unmarked are each counted once, late, and the loop opens the circuit"
            : "negative control: the same loop with each worker closing cleanly counts nothing and never opens the circuit",
          async () => {
            const { driver, ref, queue, controller, events } = await setup();
            const { calls, summoner } = recorder();
            const summon = controller({
              summoner,
              backoff: { initial: 1, max: 1 },
              circuit: { failures: 2, resetAfter: 60_000 },
            });
            await queue.add("a", {});
            expect(await summon.check()).toMatchObject({ action: "summoned" });

            for (let round = 0; round < 2; round++) {
              const id = calls.at(-1)!.id;
              const worker = `w${round}`;
              // Its first report: the claim, then a record carrying the id.
              expect(
                await claimSummonAttempt(driver, ref, id, claimant(worker)),
              ).toBe(true);
              await liveRecord(driver, ref, worker, id);
              // A check sees it running: registered, off `pending`, watched.
              await summon.check();
              expect(outcomes(events).at(-1)).toBe("registered");
              expect(await watchedIds(driver, ref)).toEqual([id]);
              expect((await summon.status()).pending).toHaveLength(0);
              // A registration resets the count, as it always has; a watched
              // one keeps what it reset, to restore if the attempt is lost.
              expect((await summon.status()).failures).toBe(0);
              if (exit === "clean") {
                expect(
                  await markSummonClaimExit(
                    driver,
                    ref,
                    id,
                    worker,
                    CLEAN,
                    true,
                  ),
                ).toBe("written");
                await removeWorkerRecord(driver, ref, worker);
                await summon.check();
                expect(await watchedIds(driver, ref)).toEqual([]);
              } else {
                // exit(1) after its first report: no mark, the record gone.
                await removeWorkerRecord(driver, ref, worker);
                await ageMarker(driver, ref);
                await summon.check();
                const lost = () =>
                  events.filter(
                    (event) => event.id === id && event.outcome === "lost",
                  );
                expect(lost()).toHaveLength(1);
                expect(lost()[0]!.detail).toBe("died");
                // Visible where status is read, and emitted once only.
                expect((await summon.status()).last).toMatchObject({
                  id,
                  outcome: "lost",
                  detail: "died",
                });
                await Bun.sleep(5);
                await summon.check();
                expect(lost()).toHaveLength(1);
              }
              await Bun.sleep(5);
              // The next attempt, if the check above did not start it.
              if (round === 0 && calls.at(-1)!.id === id) {
                expect(await summon.check()).toMatchObject({
                  action: "summoned",
                });
              }
            }

            const status = await summon.status();
            if (exit === "crash") {
              expect(await summon.check()).toMatchObject({
                action: "skipped",
                reason: "circuit-open",
              });
              expect(status.failures).toBe(2);
            } else {
              expect(outcomes(events)).not.toContain("lost");
              expect(status.failures).toBe(0);
              expect(status.circuitOpenUntil).toBeUndefined();
            }
          },
        );
      }

      it("unit: counts a watched attempt whose holder gets a code-1 mark (hand-written, or a future writer's) as exited-with-error at once, once", async () => {
        const { driver, ref, queue, controller, events } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({
          summoner,
          backoff: { initial: 60_000, max: 60_000 },
        });
        await queue.add("a", {});
        await summon.check();
        const id = calls[0]!.id;
        expect(await claimSummonAttempt(driver, ref, id, claimant("w"))).toBe(
          true,
        );
        await liveRecord(driver, ref, "w", id);
        await summon.check();
        expect(outcomes(events)).toEqual(["started", "registered"]);
        expect(await watchedIds(driver, ref)).toEqual([id]);
        expect((await summon.status()).failures).toBe(0);

        // A code-1 mark written directly: runSummoned writes one only when
        // run() rejects, which is before the first report, so no claim exists
        // then. This covers the branch for a mark written by other means.
        // No grace is needed to read it.
        expect(
          await markSummonClaimExit(driver, ref, id, "w", FAILED, true),
        ).toBe("written");
        await summon.check();
        const lost = () =>
          events.filter((event) => event.id === id && event.outcome === "lost");
        expect(lost()).toHaveLength(1);
        expect(lost()[0]!.detail).toBe("exited-with-error");
        const status = await summon.status();
        expect(status.failures).toBe(1);
        expect(status.last).toMatchObject({
          id,
          outcome: "lost",
          detail: "exited-with-error",
        });
        expect(await watchedIds(driver, ref)).toEqual([]);
        await summon.check();
        expect(lost()).toHaveLength(1);
      });

      it("settles one failed watched attempt once when two controllers check it at the same moment", async () => {
        const { driver, ref, queue, controller, events } = await setup();
        const { calls, summoner } = recorder();
        // Holds every marker read until both controllers have made one, so
        // both settle the same version and one of their writes must lose.
        const barrier = {
          armed: false,
          arrived: 0,
          open: Promise.withResolvers<void>(),
        };
        const gated = new Proxy(driver, {
          get(target, property) {
            if (property === "getQueueState") {
              return async (q: QueueRef, name: string) => {
                const value = await target.getQueueState!(q, name);
                if (name === SUMMON_MARKER && barrier.armed) {
                  barrier.arrived++;
                  if (barrier.arrived >= 2) {
                    barrier.open.resolve();
                  }
                  await barrier.open.promise;
                }
                return value;
              };
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const policy = {
          summoner,
          backoff: { initial: 60_000, max: 60_000 },
        };
        const one = controller(policy, gated);
        const two = controller(policy, gated);
        await queue.add("a", {});
        await one.check();
        const id = calls[0]!.id;
        expect(await claimSummonAttempt(driver, ref, id, claimant("w"))).toBe(
          true,
        );
        await liveRecord(driver, ref, "w", id);
        await one.check();
        expect(await watchedIds(driver, ref)).toEqual([id]);
        expect(
          await markSummonClaimExit(driver, ref, id, "w", FAILED, true),
        ).toBe("written");

        barrier.armed = true;
        await Promise.all([one.check(), two.check()]);
        barrier.armed = false;
        expect(barrier.arrived).toBeGreaterThanOrEqual(2);
        // The loser's next check finds the entry already gone.
        await one.check();
        await two.check();

        expect(
          events.filter((event) => event.id === id && event.outcome === "lost"),
        ).toHaveLength(1);
        const marker = (await driver.getQueueState!(ref, SUMMON_MARKER))!
          .value as SummonMarker;
        expect(marker.failures).toBe(1);
        expect(marker.watching).toBeUndefined();
      });

      it("does not count a watched attempt as capacity: a second job is summoned for while the first worker runs past until", async () => {
        const { driver, namespace, ref, queue, controller, events } =
          await setup();
        const { calls, summoner } = recorder();
        const summon = controller({
          summoner,
          maxWorkers: 2,
          jobsPerWorker: 1,
          bootBudget: 300,
        });
        const hold = Promise.withResolvers<void>();
        perTest.push(async () => hold.resolve());
        await queue.add("a", {});
        await summon.check();
        const id = calls[0]!.id;
        const summoned = summonedWorker(
          driver,
          namespace,
          id,
          async () => await hold.promise,
        );
        void summoned.run();
        await waitFor(
          async () =>
            summoned.summon?.id === id &&
            (await queue.listWorkers()).some((one) => one.summon?.id === id) &&
            (await queue.getDemand()).active === 1,
          { timeout: 10_000 },
        );
        await summon.check();
        expect(outcomes(events)).toEqual(["started", "registered"]);
        expect(await watchedIds(driver, ref)).toEqual([id]);

        // A second job: one worker serving, nothing on its way, two wanted.
        await queue.add("b", {});
        expect(await summon.check()).toMatchObject({ action: "summoned" });
        expect(calls).toHaveLength(2);

        // It runs on past its until: no failure, still watched until the
        // grace passes, then dropped quietly.
        await Bun.sleep(350);
        await summon.check();
        expect(
          events.filter((event) => event.id === id && event.outcome === "lost"),
        ).toHaveLength(0);
        expect(await watchedIds(driver, ref)).toEqual([id]);
        // Due to end with its record listed and no mark: extended once, to
        // that record's expiry; still listed then, it ends clean.
        await ageMarker(driver, ref);
        await summon.check();
        expect(await watchedIds(driver, ref)).toEqual([id]);
        await ageMarker(driver, ref);
        await summon.check();
        expect(await watchedIds(driver, ref)).toEqual([]);
        expect(outcomes(events).filter((one) => one === "registered")).toEqual([
          "registered",
        ]);
        expect(
          events.filter((event) => event.id === id && event.outcome === "lost"),
        ).toHaveLength(0);
        // Only the other attempt, started while it ran and never claimed, is
        // counted: this one added nothing.
        expect((await summon.status()).failures).toBe(
          events.filter((event) => event.outcome === "lost").length,
        );
      });

      it("negative control: the same first attempt kept pending instead, the second job is not summoned for", async () => {
        const { driver, ref, queue, controller } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({
          summoner,
          maxWorkers: 2,
          jobsPerWorker: 1,
        });
        await queue.add("a", {});
        await summon.check();
        const id = calls[0]!.id;
        // Its worker is live, and the attempt is still pending: counted twice.
        await liveRecord(driver, ref, "elsewhere");
        await queue.add("b", {});
        expect(await summon.check()).toMatchObject({ action: "skipped" });
        expect(calls).toHaveLength(1);
        expect((await summon.status()).pending.map((one) => one.id)).toEqual([
          id,
        ]);
      });

      for (const aged of [false, true]) {
        it(
          aged
            ? "negative control: the same stalled holder past the attempt's until and grace reads as died"
            : "does not read a holder whose record lapsed as died before the attempt's until: it may be busy, not dead",
          async () => {
            const { driver, ref, queue, controller, events } = await setup();
            const { calls, summoner } = recorder();
            const summon = controller({ summoner });
            await queue.add("a", {});
            await summon.check();
            const id = calls[0]!.id;
            // Claimed long ago by its own clock; its reports stalled (a
            // CPU-bound job), so its record lapsed.
            expect(
              await claimSummonAttempt(driver, ref, id, claimant("busy", true)),
            ).toBe(true);
            if (aged) {
              await ageMarker(driver, ref);
            }
            await summon.check();
            if (aged) {
              expect(outcomes(events)).toEqual(["started", "lost"]);
              expect(events[1]!.detail).toBe("died");
            } else {
              expect(outcomes(events)).toEqual(["started"]);
              expect((await summon.status()).failures).toBe(0);
              // Its record comes back: it was alive all along.
              await liveRecord(driver, ref, "busy", id);
              await summon.check();
              expect(outcomes(events)).toEqual(["started", "registered"]);
            }
          },
        );
      }

      it("keeps a watched worker whose record lapsed watched before its grace, and lets it end clean when it reports again", async () => {
        const { driver, ref, queue, controller, events } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({ summoner });
        await queue.add("a", {});
        await summon.check();
        const id = calls[0]!.id;
        expect(await claimSummonAttempt(driver, ref, id, claimant("w"))).toBe(
          true,
        );
        await liveRecord(driver, ref, "w", id);
        await summon.check();
        expect(await watchedIds(driver, ref)).toEqual([id]);
        // A stall: the record lapses; the attempt's until is still ahead.
        await removeWorkerRecord(driver, ref, "w");
        await summon.check();
        expect(
          events.filter((event) => event.id === id && event.outcome === "lost"),
        ).toHaveLength(0);
        expect(await watchedIds(driver, ref)).toEqual([id]);
        // It reports again; past the grace and one extension it is dropped
        // as having run.
        await liveRecord(driver, ref, "w", id);
        await ageMarker(driver, ref);
        await summon.check();
        expect(await watchedIds(driver, ref)).toEqual([id]);
        await ageMarker(driver, ref);
        await summon.check();
        expect(await watchedIds(driver, ref)).toEqual([]);
        expect(
          events.filter((event) => event.id === id && event.outcome === "lost"),
        ).toHaveLength(0);
        // Only the other attempt, started while it ran and never claimed, is
        // counted: this one added nothing.
        expect((await summon.status()).failures).toBe(
          events.filter((event) => event.outcome === "lost").length,
        );
      });

      for (const healthy of [false, true]) {
        it(
          healthy
            ? "negative control: the same extended watch, its record refreshed, ends clean"
            : "A2r: a watch due while a dead worker's record is still listed is extended to that record's expiry, then counts the crash",
          async () => {
            const { driver, ref, queue, controller, events } = await setup();
            const { calls, summoner } = recorder();
            const summon = controller({ summoner });
            await queue.add("a", {});
            await summon.check();
            const id = calls[0]!.id;
            expect(
              await claimSummonAttempt(driver, ref, id, claimant("w")),
            ).toBe(true);
            // A long record lifetime: it outlives the watch.
            await liveRecord(driver, ref, "w", id, 60_000);
            await summon.check();
            expect(await watchedIds(driver, ref)).toEqual([id]);

            // Due to end, the record still listed and no mark: extended.
            await ageMarker(driver, ref);
            await summon.check();
            expect(await watchedIds(driver, ref)).toEqual([id]);
            const marker = (await driver.getQueueState!(ref, SUMMON_MARKER))!
              .value as SummonMarker;
            expect(marker.watching![0]!.extendedUntil).toBeGreaterThan(
              Date.now() + 50_000,
            );
            const lost = () =>
              events.filter(
                (event) => event.id === id && event.outcome === "lost",
              );
            expect(lost()).toHaveLength(0);

            // At the extension: refreshed (alive), or expired (it had died).
            if (healthy) {
              await liveRecord(driver, ref, "w", id, 60_000);
            } else {
              await removeWorkerRecord(driver, ref, "w");
            }
            await ageMarker(driver, ref);
            await summon.check();
            expect(await watchedIds(driver, ref)).toEqual([]);
            if (healthy) {
              expect(lost()).toHaveLength(0);
              expect((await summon.status()).failures).toBe(0);
            } else {
              expect(lost()).toHaveLength(1);
              expect(lost()[0]!.detail).toBe("died");
              expect((await summon.status()).failures).toBe(1);
            }
          },
        );
      }

      it("does not let failures pile up during a watch: a registration resets them, as before", async () => {
        const { driver, ref, queue, controller, events } = await setup();
        const { calls, summoner, answer } = switchable();
        const summon = controller({
          summoner,
          maxWorkers: 2,
          jobsPerWorker: 1,
          backoff: { initial: 1, max: 1 },
          circuit: { failures: 3, resetAfter: 600_000 },
        });
        await queue.add("a", {});
        for (let failure = 0; failure < 2; failure++) {
          expect(await summon.check()).toMatchObject({
            outcome: "unavailable",
          });
          await Bun.sleep(5);
        }
        expect((await summon.status()).failures).toBe(2);
        expect(await streakOf(driver, ref)).toBe(2);
        answer.mode = "started";
        expect(await summon.check()).toMatchObject({ action: "summoned" });
        const id = calls.at(-1)!.id;
        expect(await claimSummonAttempt(driver, ref, id, claimant("w"))).toBe(
          true,
        );
        await liveRecord(driver, ref, "w", id);
        await summon.check();
        expect(await watchedIds(driver, ref)).toEqual([id]);
        // The registration resets `failures`; seen only by a live record, it
        // proves nothing, so the streak stays.
        expect((await summon.status()).failures).toBe(0);
        expect(await streakOf(driver, ref)).toBe(2);

        // One more failure, unrelated, during the watch: a second worker is
        // wanted, and the platform has no capacity.
        await queue.add("b", {});
        answer.mode = "unavailable";
        await Bun.sleep(5);
        expect(await summon.check()).toMatchObject({ outcome: "unavailable" });
        const status = await summon.status();
        expect(status.failures).toBe(1);
        expect(status.circuitOpenUntil).toBeUndefined();
        // The streak counts it on top: 3 since the last proven success.
        expect(await streakOf(driver, ref)).toBe(3);
        expect(outcomes(events)).not.toContain("lost");
      });

      /** Two `unavailable` failures, then a registration seen live and watched. */
      async function streakThenWatched(
        policy: Partial<SummonPolicy> = {},
      ): Promise<{
        driver: JobsDriver;
        ref: QueueRef;
        queue: BunQueue<unknown>;
        summon: SummonController;
        events: SummonEventPayload[];
        id: string;
        answer: { mode: "unavailable" | "started" };
        calls: SummonRequest[];
      }> {
        const { driver, ref, queue, controller, events } = await setup();
        const { calls, summoner, answer } = switchable();
        const summon = controller({
          summoner,
          backoff: { initial: 1, max: 1 },
          ...policy,
        });
        await queue.add("a", {});
        for (let failure = 0; failure < 2; failure++) {
          await summon.check();
          await Bun.sleep(5);
        }
        answer.mode = "started";
        await summon.check();
        const id = calls.at(-1)!.id;
        expect(await claimSummonAttempt(driver, ref, id, claimant("w"))).toBe(
          true,
        );
        await liveRecord(driver, ref, "w", id);
        await summon.check();
        expect(await watchedIds(driver, ref)).toEqual([id]);
        expect((await summon.status()).failures).toBe(0);
        expect(await streakOf(driver, ref)).toBe(2);
        return { driver, ref, queue, summon, events, id, answer, calls };
      }

      for (const reset of [true, false]) {
        it(
          reset
            ? "restores no failure a reset() cleared: a watched loss after it counts one, and the streak one"
            : "negative control, and the order: without the reset, failures 0 and lossStreak 2 become 3 and 3 (the streak first, then the max)",
          async () => {
            const { driver, ref, summon } = await streakThenWatched();
            if (reset) {
              await summon.reset();
              expect(await streakOf(driver, ref)).toBe(0);
            }
            // It dies unmarked.
            await removeWorkerRecord(driver, ref, "w");
            await ageMarker(driver, ref);
            await summon.check();
            expect((await summon.status()).failures).toBe(reset ? 1 : 3);
            expect(await streakOf(driver, ref)).toBe(reset ? 1 : 3);
          },
        );
      }

      it("resets the loss streak only on proven success: a clean watch end, or a registration whose every worker left a clean mark", async () => {
        const { driver, ref, queue, summon, id, answer, calls } =
          await streakThenWatched({ maxWorkers: 2, jobsPerWorker: 1 });
        // Unproven: registered and watched, the streak stands (checked above).
        // A clean watch end proves it.
        expect(
          await markSummonClaimExit(driver, ref, id, "w", CLEAN, true),
        ).toBe("written");
        await removeWorkerRecord(driver, ref, "w");
        await summon.check();
        expect(await watchedIds(driver, ref)).toEqual([]);
        expect(await streakOf(driver, ref)).toBe(0);

        // Two more failures, then an attempt whose one worker claimed and
        // left a clean mark before any check saw it: proven at once.
        answer.mode = "unavailable";
        await queue.add("b", {});
        await queue.add("c", {});
        for (let failure = 0; failure < 2; failure++) {
          await Bun.sleep(5);
          await summon.check();
        }
        expect(await streakOf(driver, ref)).toBe(2);
        answer.mode = "started";
        await Bun.sleep(5);
        expect(await summon.check()).toMatchObject({ action: "summoned" });
        const second = calls.at(-1)!.id;
        expect(
          await claimSummonAttempt(driver, ref, second, claimant("w2")),
        ).toBe(true);
        expect(
          await markSummonClaimExit(driver, ref, second, "w2", CLEAN, true),
        ).toBe("written");
        await summon.check();
        expect(await watchedIds(driver, ref)).toEqual([]);
        expect(await streakOf(driver, ref)).toBe(0);
      });

      for (const provenBetween of [false, true]) {
        it(
          provenBetween
            ? "negative control: a clean watch end after the circuit closes, then a watched loss, leaves it closed"
            : "half-open: once the circuit's reset time passes, the first watched loss reopens it (no success proven since)",
          async () => {
            const { driver, ref, queue, controller, events } = await setup();
            const { calls, summoner, answer } = switchable();
            const summon = controller({
              summoner,
              maxWorkers: 2,
              jobsPerWorker: 1,
              backoff: { initial: 1, max: 1 },
              circuit: { failures: 3, resetAfter: 200 },
            });
            await queue.add("a", {});
            for (let failure = 0; failure < 3; failure++) {
              await summon.check();
              await Bun.sleep(5);
            }
            expect((await summon.status()).circuitOpenUntil).toBeDefined();
            await Bun.sleep(250);
            expect((await summon.status()).circuitOpenUntil).toBeUndefined();

            // It closed with failures 3 and a streak of 3 kept.
            answer.mode = "started";
            /** Summons, registers the attempt live, and answers its id. */
            const registered = async (worker: string): Promise<string> => {
              expect(await summon.check()).toMatchObject({
                action: "summoned",
              });
              const id = calls.at(-1)!.id;
              expect(
                await claimSummonAttempt(driver, ref, id, claimant(worker)),
              ).toBe(true);
              await liveRecord(driver, ref, worker, id);
              await summon.check();
              expect(await watchedIds(driver, ref)).toContain(id);
              return id;
            };
            const first = await registered("w1");
            if (provenBetween) {
              expect(
                await markSummonClaimExit(
                  driver,
                  ref,
                  first,
                  "w1",
                  CLEAN,
                  true,
                ),
              ).toBe("written");
              await removeWorkerRecord(driver, ref, "w1");
              await summon.check();
              expect(await streakOf(driver, ref)).toBe(0);
              await queue.add("b", {});
              await Bun.sleep(5);
              await registered("w2");
              await removeWorkerRecord(driver, ref, "w2");
            } else {
              await removeWorkerRecord(driver, ref, "w1");
            }
            // The watched worker dies unmarked.
            await ageMarker(driver, ref);
            await summon.check();
            const status = await summon.status();
            if (provenBetween) {
              // Only the losses since the proven end count: the watched one,
              // and an attempt started meanwhile that nothing claimed.
              expect(status.failures).toBe(
                events.filter((event) => event.outcome === "lost").length,
              );
              expect(status.failures).toBeLessThan(3);
              expect(status.circuitOpenUntil).toBeUndefined();
            } else {
              expect(status.failures).toBe(4);
              expect(status.circuitOpenUntil).toBeDefined();
            }
          },
        );
      }

      it("writes no marker while checks find a quiet watch list", async () => {
        const { driver, ref, queue, controller } = await setup();
        const { calls, summoner } = recorder();
        const counted = countMarkerWrites(driver);
        const summon = controller({ summoner }, counted.driver);
        await queue.add("a", {});
        await summon.check();
        const id = calls[0]!.id;
        expect(await claimSummonAttempt(driver, ref, id, claimant("w"))).toBe(
          true,
        );
        await liveRecord(driver, ref, "w", id);
        // The control: the check that starts the watch writes the marker.
        const beforeRelease = counted.writes();
        await summon.check();
        expect(counted.writes()).toBe(beforeRelease + 1);
        expect(await watchedIds(driver, ref)).toEqual([id]);

        const quiet = counted.writes();
        for (let check = 0; check < 5; check++) {
          await summon.check();
        }
        expect(counted.writes()).toBe(quiet);
        expect(await watchedIds(driver, ref)).toEqual([id]);
      });

      for (const extra of [0, 1]) {
        it(
          extra === 1
            ? "evicts the oldest watched attempt past the limit, with one warn naming it"
            : "negative control: a watch list at its limit evicts nothing and warns nothing",
          async () => {
            const { driver, ref, queue, controller } = await setup();
            const { calls, summoner } = recorder();
            const { logger, events: logs } = createTestLogger();
            // maxPending 1 × ⌈20 s / 60 s⌉ = 1, so the floor: 8.
            const summon = controller({ summoner, cooldown: 60_000, logger });
            await queue.add("a", {});
            await summon.check();
            expect(calls).toHaveLength(1);
            // Watched attempts whose one holder is live, so none ends.
            await liveRecord(driver, ref, "w-live");
            const now = Date.now();
            const watching: WatchedSummon[] = [];
            for (let index = 0; index < 8 + extra; index++) {
              const id = `sm_watched_${index}`;
              expect(
                await claimSummonAttempt(driver, ref, id, claimant("w-live")),
              ).toBe(true);
              watching.push({
                id,
                at: now + index,
                until: now + 60_000,
                count: 1,
                kind: "rec",
              });
            }
            const entry = await driver.getQueueState!(ref, SUMMON_MARKER);
            expect(
              await setReservedState(
                driver,
                ref,
                SUMMON_MARKER,
                { ...(entry!.value as SummonMarker), watching },
                entry!.version,
              ),
            ).not.toBe(null);

            await summon.check();
            const warns = logs.filter((log) =>
              log.message.startsWith("summon watch list full"),
            );
            if (extra === 1) {
              expect(warns).toHaveLength(1);
              expect(warns[0]!.fields).toMatchObject({
                ids: ["sm_watched_0"],
                limit: 8,
              });
              expect(await watchedIds(driver, ref)).toEqual(
                watching.slice(1).map((one) => one.id),
              );
            } else {
              expect(warns).toHaveLength(0);
              expect(await watchedIds(driver, ref)).toEqual(
                watching.map((one) => one.id),
              );
            }
          },
        );
      }

      it("reads a marker without watching, or with a malformed one, as nothing watched — never as corruption", async () => {
        const { driver, ref, queue, controller } = await setup();
        const { summoner } = recorder();
        const summon = controller({ summoner, cooldown: 60_000 });
        await queue.add("a", {});
        await summon.check();
        const entry = await driver.getQueueState!(ref, SUMMON_MARKER);
        const marker = entry!.value as SummonMarker;
        expect(marker.watching).toBeUndefined();
        expect(
          await setReservedState(
            driver,
            ref,
            SUMMON_MARKER,
            { ...marker, failures: 3, watching: "junk" },
            entry!.version,
          ),
        ).not.toBe(null);
        await summon.check();
        expect((await summon.status()).failures).toBe(3);

        // The control: a marker that really is malformed starts afresh.
        const again = await driver.getQueueState!(ref, SUMMON_MARKER);
        expect(
          await setReservedState(
            driver,
            ref,
            SUMMON_MARKER,
            { ...(again!.value as SummonMarker), epoch: "" },
            again!.version,
          ),
        ).not.toBe(null);
        await summon.check();
        expect((await summon.status()).failures).toBe(0);
      });
    },
  );
}

describe("the watch list across versions", () => {
  it("is a marker a controller that predates it accepts, and keeps unchanged when it writes it back", () => {
    const now = Date.now();
    const watched: WatchedSummon = {
      id: "sm_w",
      at: now,
      until: now + 1_000,
      count: 1,
      kind: "rec",
    };
    const marker = { ...freshMarker(now), watching: [watched] };
    // `isSummonMarker` and `readMarker`'s clone are unchanged from the
    // version before `watching`: an older controller validates the marker
    // as before and carries the field through its own writes untouched.
    expect(isSummonMarker(marker)).toBe(true);
    const read = readMarker({ value: marker, version: 4 }, now);
    expect(read.unreadable).toBe(false);
    expect(read.newer).toBeUndefined();
    expect(read.marker.watching).toEqual([watched]);
    expect(read.marker.v).toBe(1);
    // The control: a newer shape version is still refused.
    expect(
      readMarker({ value: { ...marker, v: 2 }, version: 4 }, now).newer,
    ).toBe(2);
  });
});

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
        policy: Partial<SummonPolicy> &
          Pick<SummonControllerOptions, "logger"> = {},
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
          ...policy,
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

      it("A2: workers that crash after their first report, checked densely, open the circuit", async () => {
        // The opening is read from the controller's log line, which carries
        // `failures` as it stood then, rather than from `status()` later.
        const { logger, events: logs } = createTestLogger();
        const opening = () =>
          logs.find((log) => log.message.startsWith("summon circuit open"));
        const { queue, controller, events } = await setup(
          // Every worker, not only the first: exit(1) 400 ms after start.
          { SUMMON_TEST_CRASH_AFTER_MS: "400" },
          false,
          {
            // Room for a spawn and first report under load: an attempt
            // nobody has claimed by its `until` is lost unseen, with no
            // detail — not the case this proves.
            bootBudget: 4_000,
            backoff: { initial: 1, max: 1 },
            circuit: { failures: 2, resetAfter: 60_000 },
            // Longer than a loss takes to land (bootBudget + 5 s) with 3 s
            // to spare, with one worker: each release and its loss
            // alternate, so the circuit opens only if a loss restores the
            // count its release reset.
            cooldown: 12_000,
            maxWorkers: 1,
            logger,
          },
        );
        await queue.add("a", {});
        // The events announced up to and including the check that opened it.
        let atOpen: SummonEventPayload[] | undefined;
        await waitFor(
          async () => {
            const result = await controller.check();
            if (atOpen === undefined && opening() !== undefined) {
              atOpen = events.slice();
            }
            return (
              result.action === "skipped" && result.reason === "circuit-open"
            );
          },
          { timeout: 70_000, interval: 100 },
        );
        expect(opening()?.fields.failures).toBeGreaterThanOrEqual(2);
        expect(
          atOpen!.filter((event) => event.outcome === "lost").length,
        ).toBeGreaterThanOrEqual(2);
        // Seen running first, then counted as it died — the case a live
        // record alone let through — and among what opened the circuit.
        // Normally every loss is one; under heavy load an attempt can be
        // lost unseen instead, counted as before, so only one is required.
        expect(lateLosses(atOpen!).length).toBeGreaterThanOrEqual(1);
        for (const event of lateLosses(events)) {
          expect(event.detail).toBe("died");
        }
        // Open for its `resetAfter` (60 s), from an opening a moment ago.
        expect((await controller.status()).circuitOpenUntil).toBeGreaterThan(
          Date.now() + 50_000,
        );
      }, 90_000);

      it("A2 dense: a crash loop with several attempts in flight opens the circuit within about as many losses as its threshold", async () => {
        // The opening is read from the controller's own log line, written
        // by the check that opened it with `failures` as it stood then —
        // not from the first check seen shut. Under load a worker of an
        // attempt made before the opening can still register after it,
        // resetting `failures` as every registration does, and serve while
        // it lives; the gate is seen shut only once it dies, by when
        // `failures` can read 0. The circuit stays open throughout.
        const { logger, events: logs } = createTestLogger();
        const opening = () =>
          logs.find((log) => log.message.startsWith("summon circuit open"));
        const { queue, controller, events } = await setup(
          { SUMMON_TEST_CRASH_AFTER_MS: "400" },
          false,
          {
            // No cooldown and checks every 100 ms: a new attempt goes out as
            // soon as the last worker's record lapses, so several are
            // watched at once and each registration resets `failures`.
            cooldown: 0,
            maxWorkers: 1,
            backoff: { initial: 50, max: 50 },
            circuit: { failures: 3, resetAfter: 600_000 },
            logger,
          },
        );
        for (let job = 0; job < 50; job++) {
          await queue.add("a", {});
        }
        // The losses announced up to and including the check that opened it.
        let lossesAtOpen = -1;
        await waitFor(
          async () => {
            const result = await controller.check();
            if (lossesAtOpen < 0 && opening() !== undefined) {
              lossesAtOpen = events.filter(
                (event) => event.outcome === "lost",
              ).length;
            }
            return (
              result.action === "skipped" && result.reason === "circuit-open"
            );
          },
          { timeout: 45_000, interval: 100 },
        );
        expect(opening()?.fields.failures).toBeGreaterThanOrEqual(3);
        // Several attempts' losses can land in one check, so a little over.
        expect(lossesAtOpen).toBeGreaterThanOrEqual(3);
        expect(lossesAtOpen).toBeLessThanOrEqual(5);
        // Open for its `resetAfter` (600 s), from an opening a moment ago.
        expect((await controller.status()).circuitOpenUntil).toBeGreaterThan(
          Date.now() + 500_000,
        );
      });

      it("two controllers on one dense crash loop count each loss once, and open the circuit", async () => {
        const { driver, ref, queue, controller, platform, events } =
          await setup({ SUMMON_TEST_CRASH_AFTER_MS: "400" }, false, {
            cooldown: 0,
            maxWorkers: 1,
            backoff: { initial: 50, max: 50 },
            circuit: { failures: 3, resetAfter: 600_000 },
          });
        const second = createDriver(backend.config);
        await second.connect();
        const other = new SummonController({
          ...QUIET,
          driver: second,
          namespace: ref.ns,
          queue: "work",
          summoner: platform.summoner,
          bootBudget: 1_500,
          cooldown: 0,
          maxWorkers: 1,
          backoff: { initial: 50, max: 50 },
          circuit: { failures: 3, resetAfter: 600_000 },
        });
        other.on("summon", (event) => events.push(event));
        perTest.unshift(async () => {
          await other.close();
          await second.close();
        });
        for (let job = 0; job < 50; job++) {
          await queue.add("a", {});
        }
        await waitFor(
          async () => {
            const [one, two] = await Promise.all([
              controller.check(),
              other.check(),
            ]);
            return [one, two].some(
              (result) =>
                result.action === "skipped" && result.reason === "circuit-open",
            );
          },
          { timeout: 45_000, interval: 80 },
        );
        const lost = events
          .filter((event) => event.outcome === "lost")
          .map((event) => event.id);
        // Each loss counted once, by whichever controller settled it.
        expect(lost.length).toBe(new Set(lost).size);
        const marker = (await driver.getQueueState!(ref, SUMMON_MARKER))!
          .value as SummonMarker;
        // Open, and by at least the threshold's worth of losses. Not
        // `failures`: a worker of an attempt made before the opening can
        // register after it and reset that to 0 (see A2 dense). The streak
        // is reset only by a proven clean exit, which no worker here makes.
        expect(marker.circuitOpenUntil).toBeGreaterThan(Date.now() + 500_000);
        expect(marker.lossStreak ?? 0).toBeGreaterThanOrEqual(3);
        expect(marker.lossStreak ?? 0).toBe(lost.length);
      });

      it("A2r: a worker whose record outlives the watch, crashing after its first report, is still counted", async () => {
        const { queue, controller, events } = await setup(
          {
            SUMMON_TEST_CRASH_AFTER_MS: "400",
            // A record lives 12 s: past the watch's end at bootBudget + 5 s.
            SUMMON_TEST_REPORT_MS: "4000",
          },
          false,
          // Room for a spawn and first report under load: an attempt nobody
          // has claimed by its `until` is lost unseen, with no detail.
          { bootBudget: 4_000 },
        );
        await queue.add("a", {});
        // The first loss of a worker seen running. Under heavy load an
        // earlier attempt can be lost unseen (see `lateLosses`); the next,
        // after its backoff, is the case this proves.
        await waitFor(
          async () => {
            await controller.check();
            return lateLosses(events).length > 0;
          },
          { timeout: 60_000, interval: 100 },
        );
        const lost = lateLosses(events)[0]!;
        expect(lost.detail).toBe("died");
        expect((await controller.status()).failures).toBeGreaterThanOrEqual(1);
      }, 90_000);

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
