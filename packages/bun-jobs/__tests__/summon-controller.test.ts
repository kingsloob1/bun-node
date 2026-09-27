import type {
  DefineSummonerOptions,
  JobsDriver,
  SummonControllerOptions,
  SummonEventPayload,
  SummonPolicy,
  SummonRequest,
  SummonResult,
} from "../lib/index";
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
  ConfigError,
  createDriver,
  defineSummoner,
  MemoryDriver,
  newId,
  registerWorkerRecord,
  SummonController,
} from "../lib/index";
import { setReservedState } from "../lib/queue/windows";
import { SUMMON_ARGS } from "../lib/summon/args";
import { claimSummonAttempt, summonClaimName } from "../lib/summon/claim";
import { wireRequest } from "../lib/summon/controller";
import { attemptId, dedupeKeyFor, SUMMON_MARKER } from "../lib/summon/marker";
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * `SummonController` in one process, against every backend that can carry
 * work between processes (§11.1's controller cases; the fake platform's
 * end-to-end runs are `summon-platform.test.ts`, the two-process races
 * `summon-race.test.ts`).
 *
 * The summoner here only records what it was asked. A summoned worker's
 * registration is played by an in-process `BunQueueWorker` given the
 * attempt's id as its `summon`, which writes exactly the record a summoned
 * process would.
 */

// Several cases wait on a real worker's first report, on a server backend.
setDefaultTimeout(20_000);

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

/**
 * What one test opened — controllers, workers, drivers — closed after it, in
 * order, so a server backend's connections never pile up across a file.
 */
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

/** A summoner that records each request and answers with `answer` (default: started). */
function recorder(
  answer?: (
    request: SummonRequest,
    signal: AbortSignal,
  ) => Promise<SummonResult | void>,
  extra?: Partial<Omit<DefineSummonerOptions, "invoke">>,
) {
  const calls: SummonRequest[] = [];
  const releases: number[] = [];
  const summoner = defineSummoner({
    kind: "rec",
    bootBudget: 20_000,
    ...extra,
    invoke: async (request, context) => {
      calls.push(request);
      return await answer?.(request, context.signal);
    },
    ...(extra?.style === "scale"
      ? {
          release: async (request) => {
            releases.push(request.target);
          },
        }
      : {}),
  });
  return { calls, releases, summoner };
}

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `SummonController: ${backend.name}`,
    () => {
      /** A fresh namespace and queue on a fresh driver, purged afterwards. */
      async function setup(): Promise<{
        driver: JobsDriver;
        namespace: string;
        queue: BunQueue<unknown>;
        name: string;
        controller: (
          policy: Partial<SummonPolicy> & Pick<SummonPolicy, "summoner">,
        ) => SummonController;
        events: SummonEventPayload[];
      }> {
        const driver = createDriver(backend.config);
        await driver.connect();
        const namespace = testNamespace(`summon-${backend.name}`);
        const name = "work";
        const queue = new BunQueue(name, {
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
          queue,
          name,
          events,
          controller: (policy) => {
            const controller = new SummonController({
              ...QUIET,
              ...policy,
              driver,
              namespace,
              queue: name,
            });
            controller.on("summon", (event) => events.push(event));
            owned.push(controller);
            return controller;
          },
        };
      }

      /** A worker on the queue, reporting quickly, closed with the suite. */
      function worker(
        driver: JobsDriver,
        namespace: string,
        options: ConstructorParameters<typeof BunQueueWorker>[2] = {
          namespace,
          driver,
        },
        processor: ConstructorParameters<
          typeof BunQueueWorker
        >[1] = async () => {},
      ): BunQueueWorker {
        const one = new BunQueueWorker("work", processor, {
          pollInterval: 20,
          reportInterval: 200,
          logger: noopLogger,
          ...options,
          namespace,
          driver,
        });
        perTest.unshift(async () => await one.close({ force: true }));
        return one;
      }

      it("summons once for a backlog, and counts the attempt as a worker on its way", async () => {
        const { queue, controller, events } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({ summoner });

        expect((await summon.check()).action).toBe("none");
        await queue.addBulk([
          { name: "a", data: {} },
          { name: "b", data: {} },
          { name: "c", data: {} },
        ]);

        const first = await summon.check();
        expect(first).toMatchObject({ action: "summoned", outcome: "started" });
        expect(first.demand?.demand).toBe(3);
        const second = await summon.check();
        expect(second).toMatchObject({ action: "skipped", reason: "pending" });
        expect(calls).toHaveLength(1);
        expect(events.map((event) => event.outcome)).toEqual(["started"]);

        const request = calls[0]!;
        expect(request.id).toMatch(/^sm_[a-z2-7]{26}$/);
        expect(request.count).toBe(1);
        expect(request.argv).toContain(`${SUMMON_ARGS.id}=${request.id}`);
        expect(request.argv).toContain(`${SUMMON_ARGS.queue}=work`);
        const status = await summon.status();
        expect(status.pending.map((one) => one.id)).toEqual([request.id]);
        expect(status.budget).toEqual({
          hour: 1,
          perHour: 30,
          day: 1,
          perDay: 300,
        });
      });

      it("releases the attempt when a worker carrying its id reports", async () => {
        const { driver, namespace, queue, controller, events } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({ summoner });
        await queue.add("a", {});
        await summon.check();

        const summoned = worker(driver, namespace, {
          namespace,
          driver,
          summon: { id: calls[0]!.id, kind: "rec" },
        });
        void summoned.run();
        await waitFor(
          async () => {
            await summon.check();
            return events.some((event) => event.outcome === "registered");
          },
          { timeout: 5_000 },
        );
        expect((await summon.status()).pending).toHaveLength(0);
        expect(events.map((event) => event.outcome)).toContain("registered");
        expect(summoned.summon?.id).toBe(calls[0]!.id);
        expect(calls).toHaveLength(1);
      });

      it("keeps an attempt for several workers pending until all of them register", async () => {
        const { driver, namespace, queue, controller, events } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({
          summoner,
          maxWorkers: 3,
          jobsPerWorker: 1,
        });
        await queue.addBulk([
          { name: "a", data: {} },
          { name: "b", data: {} },
          { name: "c", data: {} },
        ]);
        expect(await summon.check()).toMatchObject({ action: "summoned" });
        expect(calls[0]!.count).toBe(3);

        let release!: () => void;
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started: BunQueueWorker[] = [];
        const start = async (): Promise<void> => {
          const one = worker(
            driver,
            namespace,
            { namespace, driver, concurrency: 1, summon: { id: calls[0]!.id } },
            async () => await hold,
          );
          started.push(one);
          void one.run();
          await waitFor(
            async () => (await queue.getDemand()).workers === started.length,
          );
        };
        await start();
        // One of three is up: the other two are still on their way, check after check.
        for (let round = 0; round < 3; round++) {
          expect(await summon.check()).toMatchObject({ reason: "pending" });
          expect((await summon.status()).pending[0]?.count).toBe(3);
        }
        await start();
        await start();
        // Every job is now held by one of the three: nothing is claimable.
        expect((await summon.check()).action).toBe("none");
        expect((await summon.status()).pending).toHaveLength(0);
        expect(events.map((event) => event.outcome)).toEqual([
          "started",
          "registered",
        ]);
        expect(calls).toHaveLength(1);
        release();
      });

      it("does not summon while a running worker is live, and does when it is paused", async () => {
        const { driver, namespace, queue, controller } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({ summoner });
        let release!: () => void;
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const running = worker(
          driver,
          namespace,
          { namespace, driver, concurrency: 1 },
          async () => await hold,
        );
        void running.run();
        await queue.addBulk([
          { name: "a", data: {} },
          { name: "b", data: {} },
        ]);
        await waitFor(async () => (await queue.getDemand()).workers === 1);

        expect(await summon.check()).toMatchObject({
          action: "skipped",
          reason: "served",
        });
        await running.pause();
        await waitFor(
          async () => (await summon.check()).action === "summoned",
          {
            timeout: 5_000,
          },
        );
        expect(calls).toHaveLength(1);
        release();
      });

      it("demands nothing from a paused queue", async () => {
        const { queue, controller } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({ summoner });
        await queue.add("a", {});
        await queue.pause();
        const result = await summon.check();
        expect(result.action).toBe("none");
        expect(result.demand?.paused).toBe(true);
        expect(calls).toHaveLength(0);
      });

      it("summons for a delayed job coming due, on the poll", async () => {
        const { queue, controller } = await setup();
        const { calls, summoner } = recorder();
        controller({
          summoner,
          triggers: { onAdd: false, events: false, poll: 100 },
        });
        await queue.add("later", {}, { delay: 300 });
        await Bun.sleep(150);
        expect(calls).toHaveLength(0);
        await waitFor(() => calls.length === 1, { timeout: 5_000 });
        expect(calls[0]!.reason).toBe("poll");
        expect(calls[0]!.demand.dueNow).toBeGreaterThanOrEqual(1);
      });

      it("summons for a retry coming due", async () => {
        const { driver, namespace, queue, controller } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({ summoner });
        const failing = worker(
          driver,
          namespace,
          { namespace, driver },
          async () => {
            throw new Error("not yet");
          },
        );
        void failing.run();
        const job = await queue.add("flaky", {}, { attempts: 2, backoff: 600 });
        await waitFor(
          async () => (await queue.getJob(job.id))?.state === "failed",
          {
            timeout: 5_000,
          },
        );
        await failing.close();

        expect((await summon.check()).action).toBe("none");
        await waitFor(
          async () => (await summon.check()).action === "summoned",
          {
            timeout: 5_000,
          },
        );
        expect(calls[0]!.demand.dueNow).toBe(1);
      });

      it("summons for an orphaned active job: work in hand, no worker alive", async () => {
        const { driver, namespace, queue, controller } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({ summoner });
        await queue.add("orphan", {});
        const claimed = await driver.claimJob(
          { ns: namespace, queue: "work" },
          { workerId: "gone", token: newId(), lockMs: 60_000, now: Date.now() },
        );
        expect(claimed?.state).toBe("active");

        const result = await summon.check();
        expect(result.demand).toMatchObject({
          demand: 0,
          active: 1,
          workers: 0,
        });
        expect(result).toMatchObject({ action: "summoned" });
        expect(calls).toHaveLength(1);
      });

      it("does not summon twice through a cold start, and backs off once the attempt is lost", async () => {
        const { queue, controller, events } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({
          summoner,
          bootBudget: 300,
          backoff: { initial: 5_000 },
        });
        await queue.add("a", {});
        expect((await summon.check()).action).toBe("summoned");
        expect(await summon.check()).toMatchObject({ reason: "pending" });
        await Bun.sleep(350);

        expect(await summon.check()).toMatchObject({
          action: "skipped",
          reason: "backoff",
        });
        expect(events.map((event) => event.outcome)).toEqual([
          "started",
          "lost",
        ]);
        const status = await summon.status();
        expect(status.pending).toHaveLength(0);
        expect(status.failures).toBe(1);
        expect(status.backoffUntil).toBeGreaterThan(Date.now() + 4_000);
        expect(calls).toHaveLength(1);
      });

      it("opens the circuit after repeated failures, and reset() closes it", async () => {
        const { queue, controller, events } = await setup();
        const { calls, summoner } = recorder(async () => {
          throw Object.assign(new Error("secret-bearing message"), {
            code: "E_REFUSED",
          });
        });
        const summon = controller({
          summoner,
          backoff: { initial: 1, max: 1 },
          circuit: { failures: 2, resetAfter: 60_000 },
        });
        await queue.add("a", {});

        expect(await summon.check()).toMatchObject({ outcome: "failed" });
        await Bun.sleep(5);
        expect(await summon.check()).toMatchObject({ outcome: "failed" });
        await Bun.sleep(5);
        expect(await summon.check()).toMatchObject({ reason: "circuit-open" });
        const status = await summon.status();
        expect(status.circuitOpenUntil).toBeGreaterThan(Date.now());
        // A secret-free detail: the error's code, never its message.
        expect(status.last).toMatchObject({
          outcome: "failed",
          detail: "E_REFUSED",
        });
        expect(
          events.every((event) => !JSON.stringify(event).includes("secret")),
        ).toBe(true);

        await summon.reset();
        expect(await summon.check()).toMatchObject({ action: "summoned" });
        expect(calls).toHaveLength(3);
      });

      it("stops at the budget without failing a job", async () => {
        const { queue, controller, events } = await setup();
        const { calls, summoner } = recorder(async () => ({
          status: "unavailable",
          reason: "no capacity",
        }));
        const summon = controller({
          summoner,
          backoff: { initial: 1, max: 1 },
          budget: { perHour: 2 },
        });
        const job = await queue.add("a", {});

        expect(await summon.check()).toMatchObject({ outcome: "unavailable" });
        await Bun.sleep(5);
        expect(await summon.check()).toMatchObject({ outcome: "unavailable" });
        await Bun.sleep(5);
        expect(await summon.check()).toMatchObject({ reason: "budget" });
        expect(await summon.check()).toMatchObject({ reason: "budget" });
        expect(calls).toHaveLength(2);
        // Once per window, however many checks hit it.
        expect(
          events.filter((event) => event.outcome === "budget-exhausted"),
        ).toHaveLength(1);
        expect((await queue.getJob(job.id))?.state).toBe("waiting");
      });

      it("holds the next attempt for the cooldown, which force skips", async () => {
        const { queue, controller } = await setup();
        const { calls, summoner } = recorder(async () => ({
          status: "unavailable",
          reason: "busy",
        }));
        const summon = controller({
          summoner,
          cooldown: 60_000,
          backoff: { initial: 1, max: 1 },
        });
        await queue.add("a", {});
        await summon.check();
        await Bun.sleep(5);
        expect(await summon.check()).toMatchObject({ reason: "cooldown" });
        expect(await summon.check({ force: true })).toMatchObject({
          action: "summoned",
        });
        expect(calls).toHaveLength(2);
      });

      it("records a summoner that does not answer in time as failed, and aborts its signal", async () => {
        const { queue, controller } = await setup();
        let aborted = false;
        const { summoner } = recorder(async (_request, signal) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            });
          });
          await new Promise(() => {});
        });
        const summon = controller({ summoner, summonTimeout: 100 });
        await queue.add("a", {});
        expect(await summon.check()).toMatchObject({ outcome: "failed" });
        expect(aborted).toBe(true);
        expect((await summon.status()).last).toMatchObject({
          detail: "timeout",
        });
      });

      it("honours an unavailable answer's retryAfterMs", async () => {
        const { queue, controller } = await setup();
        const { summoner } = recorder(async () => ({
          status: "unavailable",
          reason: "quota",
          retryAfterMs: 120_000,
        }));
        const summon = controller({ summoner, backoff: { initial: 10 } });
        await queue.add("a", {});
        await summon.check();
        const status = await summon.status();
        expect(status.backoffUntil).toBeGreaterThan(Date.now() + 100_000);
        expect(status.last).toMatchObject({
          outcome: "unavailable",
          detail: "quota",
        });
      });

      it("with servedBy summoned-only, an ordinary worker does not count", async () => {
        const { driver, namespace, queue, controller } = await setup();
        const { calls, summoner } = recorder();
        let release!: () => void;
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const ordinary = worker(
          driver,
          namespace,
          { namespace, driver, concurrency: 1 },
          async () => await hold,
        );
        void ordinary.run();
        await queue.addBulk([
          { name: "a", data: {} },
          { name: "b", data: {} },
        ]);
        await waitFor(async () => (await queue.getDemand()).workers === 1);

        const anyWorker = controller({ summoner });
        expect(await anyWorker.check()).toMatchObject({ reason: "served" });
        const summonedOnly = controller({
          summoner,
          servedBy: "summoned-only",
        });
        expect(await summonedOnly.check()).toMatchObject({
          action: "summoned",
        });
        expect(calls).toHaveLength(1);
        release();
      });

      it("with passes none, releases an attempt by a worker's start time", async () => {
        const { driver, namespace, queue, controller, events } = await setup();
        const { summoner } = recorder(undefined, { passes: "none" });
        const summon = controller({ summoner });
        await queue.add("a", {});
        await summon.check();

        const started = worker(driver, namespace);
        void started.run();
        await waitFor(
          async () => {
            await summon.check();
            return events.some((event) => event.outcome === "registered");
          },
          { timeout: 5_000 },
        );
        expect((await summon.status()).pending).toHaveLength(0);
      });

      it("releases a scale-style summoner only after nothing was outstanding for scaleDown.after", async () => {
        const { driver, namespace, queue, controller } = await setup();
        const { calls, releases, summoner } = recorder(undefined, {
          style: "scale",
        });
        const summon = controller({ summoner, scaleDown: { after: 300 } });
        const job = await queue.add("a", {});
        expect(await summon.check()).toMatchObject({ action: "summoned" });
        expect(calls[0]!.argv).toContain(`${SUMMON_ARGS.mode}=until-stopped`);
        expect(calls[0]!.target).toBe(1);

        const summoned = worker(driver, namespace, {
          namespace,
          driver,
          summon: { id: calls[0]!.id },
        });
        void summoned.run();
        await waitFor(
          async () => (await queue.getJob(job.id))?.state === "completed",
          {
            timeout: 5_000,
          },
        );
        expect((await summon.check()).action).toBe("none");
        expect(releases).toHaveLength(0);
        await Bun.sleep(350);
        expect((await summon.check()).action).toBe("released");
        expect(releases).toEqual([0]);
        expect((await summon.check()).action).toBe("none");
        expect(releases).toEqual([0]);
      });

      it("lets a claimant take a holder's place only when the holder is gone: no live record, and past its until", async () => {
        const { driver, namespace } = await setup();
        const ref = { ns: namespace, queue: "work" };
        const now = Date.now();
        const claimant = (worker: string, until: number) => ({
          worker,
          host: "h",
          pid: 1,
          at: Date.now(),
          until,
        });
        expect(
          await claimSummonAttempt(
            driver,
            ref,
            "sm_t",
            claimant("first", now + 400),
          ),
        ).toBe(true);
        // Claimed a moment ago, record not written yet: not gone.
        expect(
          await claimSummonAttempt(
            driver,
            ref,
            "sm_t",
            claimant("second", now),
          ),
        ).toBe(false);

        // Past its until, with a live record: alive, keeps the place.
        await Bun.sleep(450);
        await registerWorkerRecord(driver, ref, {
          id: "first",
          queue: "work",
          host: "h",
          pid: 1,
          concurrency: 1,
          active: 0,
          paused: false,
          startedAt: now,
          heartbeatAt: Date.now(),
          expiresAt: Date.now() + 400,
        });
        expect(
          await claimSummonAttempt(driver, ref, "sm_t", claimant("third", now)),
        ).toBe(false);

        // Its record lapsed: gone, and the next claimant takes the place.
        await Bun.sleep(450);
        expect(
          await claimSummonAttempt(
            driver,
            ref,
            "sm_t",
            claimant("fourth", now),
          ),
        ).toBe(true);
        const entry = await driver.getQueueState!(ref, summonClaimName("sm_t"));
        expect(
          (entry?.value as { holders: { worker: string }[] }).holders.map(
            (holder) => holder.worker,
          ),
        ).toEqual(["fourth"]);
      });

      it("drops a worker to unsummoned once another process has taken its claim over", async () => {
        const { driver, namespace } = await setup();
        const summoned = worker(driver, namespace, {
          namespace,
          driver,
          summon: { id: "sm_displaced" },
        });
        void summoned.run();
        const ref = { ns: namespace, queue: "work" };
        const mine = async () =>
          (await driver.listWorkers!(ref, Date.now())).find(
            (one) => one.id === summoned.id,
          );
        await waitFor(
          async () => (await mine())?.summon?.id === "sm_displaced",
          {
            timeout: 5_000,
          },
        );

        // A restarted process took the place over (as it may once this
        // worker's record has lapsed, say after a long pause).
        const entry = await driver.getQueueState!(
          ref,
          summonClaimName("sm_displaced"),
        );
        const taken = {
          capacity: 1,
          holders: [
            {
              worker: "restarted",
              host: "h",
              pid: 1,
              at: Date.now(),
              until: Date.now(),
            },
          ],
          at: Date.now(),
        };
        expect(
          await setReservedState(
            driver,
            ref,
            summonClaimName("sm_displaced"),
            taken,
            entry!.version,
          ),
        ).not.toBeNull();

        await waitFor(async () => (await mine())?.summon === undefined, {
          timeout: 5_000,
        });
        expect(summoned.summon).toBeUndefined();
      });

      it("asks a summoner that can say why an attempt was lost, and cancels a unit still pending", async () => {
        const { queue, controller, events } = await setup();
        const asked: string[][] = [];
        const cancelled: string[][] = [];
        const base = defineSummoner({
          kind: "rec",
          bootBudget: 200,
          invoke: async () => ({
            status: "started",
            handles: ["unit-1", "unit-2"],
          }),
        });
        const summoner = {
          ...base,
          summon: {
            ...base.summon,
            status: async (handles: readonly string[]) => {
              asked.push([...handles]);
              return [
                {
                  handle: "unit-1",
                  state: "pending" as const,
                  detail: "CannotPullContainerError",
                },
                { handle: "unit-2", state: "exited" as const, exitCode: 1 },
              ];
            },
            cancel: async (handles: readonly string[]) => {
              cancelled.push([...handles]);
            },
          },
        };
        const summon = controller({ summoner, backoff: { initial: 60_000 } });
        await queue.add("a", {});
        expect(await summon.check()).toMatchObject({ outcome: "started" });
        expect((await summon.status()).pending[0]?.handles).toEqual([
          "unit-1",
          "unit-2",
        ]);
        await Bun.sleep(250);
        expect(await summon.check()).toMatchObject({ reason: "backoff" });
        await waitFor(() => cancelled.length === 1);
        expect(asked).toEqual([["unit-1", "unit-2"]]);
        // Only the unit still pending is cancelled: it could start late.
        expect(cancelled).toEqual([["unit-1"]]);
        expect(
          events.find((event) => event.outcome === "lost")?.handles,
        ).toEqual(["unit-1", "unit-2"]);
      });

      it("leaves an answer it could not record pending, says so, and settles it at bootBudget", async () => {
        const { driver, namespace, queue } = await setup();
        let blocked = false;
        let blockedWrites = 0;
        const proxied = new Proxy(driver, {
          get(target, property) {
            if (property === "setQueueState") {
              return async (
                ...args: Parameters<NonNullable<JobsDriver["setQueueState"]>>
              ) => {
                if (blocked && args[1] === SUMMON_MARKER) {
                  blockedWrites++;
                  return null;
                }
                return await target.setQueueState!(...args);
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const { logger, events: logs } = createTestLogger();
        const summon = new SummonController({
          ...QUIET,
          driver: proxied,
          namespace,
          queue: "work",
          logger,
          bootBudget: 300,
          backoff: { initial: 60_000 },
          summoner: async () => {
            // Every write after the claim now loses, as if other controllers
            // kept changing the marker.
            blocked = true;
            throw new Error("refused");
          },
        });
        perTest.unshift(async () => await summon.close());
        await queue.add("a", {});

        expect(await summon.check()).toMatchObject({ outcome: "failed" });
        expect(blockedWrites).toBe(3);
        expect(
          logs.some(
            (event) =>
              event.level === "warn" &&
              event.message.startsWith(
                "could not record the summoner's answer",
              ),
          ),
        ).toBe(true);
        blocked = false;
        // Not recorded: still pending, the failure not yet counted.
        let status = await summon.status();
        expect(status.pending).toHaveLength(1);
        expect(status.failures).toBe(0);
        expect(status.last).toBeUndefined();

        await Bun.sleep(350);
        expect(await summon.check()).toMatchObject({ reason: "backoff" });
        status = await summon.status();
        expect(status.pending).toHaveLength(0);
        expect(status.failures).toBe(1);
        expect(status.last).toMatchObject({ outcome: "lost" });
      });

      it("never repeats an attempt id across a purge (the marker's epoch)", async () => {
        const { driver, namespace, queue, controller } = await setup();
        const { calls, summoner } = recorder();
        const summon = controller({ summoner });
        await queue.add("a", {});
        await summon.check();
        const before = await driver.getQueueState!(
          { ns: namespace, queue: "work" },
          SUMMON_MARKER,
        );

        await driver.purge(namespace);
        await driver.ensureQueue({ ns: namespace, queue: "work" });
        await queue.add("a", {});
        await summon.check();
        const after = await driver.getQueueState!(
          { ns: namespace, queue: "work" },
          SUMMON_MARKER,
        );

        // The precondition that makes this a real test: the marker's version
        // restarted, so an id hashed from the version alone would repeat.
        expect(after!.version).toBe(before!.version);
        expect(calls).toHaveLength(2);
        expect(calls[1]!.id).not.toBe(calls[0]!.id);
        expect(calls[1]!.dedupeKey).not.toBe(calls[0]!.dedupeKey);
      });

      it("two controllers on one queue summon once", async () => {
        const { queue, controller } = await setup();
        const { calls, summoner } = recorder();
        const one = controller({ summoner });
        const two = controller({ summoner });
        await queue.add("a", {});
        const results = await Promise.all([one.check(), two.check()]);
        expect(
          results.filter((result) => result.action === "summoned"),
        ).toHaveLength(1);
        expect(calls).toHaveLength(1);
      });
    },
  );
}

describe("SummonController: construction", () => {
  const sqlite = BACKENDS.find((backend) => backend.name === "sqlite")!;
  const summoner = defineSummoner({ invoke: async () => {} });

  it("refuses a driver no other process can reach", () => {
    expect(
      () =>
        new SummonController({
          driver: new MemoryDriver(),
          namespace: "n",
          queue: "q",
          summoner,
        }),
    ).toThrow(ConfigError);
  });

  it("refuses a malformed policy", () => {
    const driver = createDriver(sqlite.config);
    cleanups.push(async () => await driver.close());
    const base = {
      driver,
      namespace: "n",
      queue: "q",
      summoner,
      triggers: { poll: false as const },
    };
    expect(() => new SummonController({ ...base, queue: "a:b" })).toThrow(
      ConfigError,
    );
    expect(() => new SummonController({ ...base, maxWorkers: 0 })).toThrow(
      ConfigError,
    );
    expect(() => new SummonController({ ...base, cooldown: -1 })).toThrow(
      ConfigError,
    );
    expect(
      () =>
        new SummonController({ ...base, servedBy: "nobody" as "any-worker" }),
    ).toThrow(ConfigError);
    expect(
      () =>
        new SummonController({
          ...base,
          summoner: {
            ...summoner,
            summon: {
              ...summoner.summon,
              capabilities: {
                ...summoner.summon.capabilities,
                maxLifetimeMs: 1_000,
              },
            },
          },
        }),
    ).toThrow(ConfigError);
    expect(() =>
      defineSummoner({ style: "scale", invoke: async () => {} }),
    ).toThrow(ConfigError);
    expect(() =>
      defineSummoner({ kind: "Not OK", invoke: async () => {} }),
    ).toThrow(ConfigError);
  });
});

describe("summon requests", () => {
  const context = {
    namespace: "shop",
    queue: "emails",
    kind: "ecs",
    style: "launch" as const,
    dedupeKey: dedupeKeyFor({ kind: "none" }),
    graceMs: 30_000,
    maxLifetime: 3_600_000,
    env: Object.freeze({ REGION: "eu" }),
  };

  it("are byte-identical for one attempt id, whenever and however often they are built", async () => {
    const id = attemptId("shop", "emails", "epoch", 7);
    const first = JSON.stringify(
      wireRequest({ id, count: 1, target: 1 }, context),
    );
    await Bun.sleep(5);
    const second = JSON.stringify(
      wireRequest({ id, count: 1, target: 1 }, context),
    );
    expect(second).toBe(first);
    // Nothing clock-shaped in what goes over the wire.
    expect(first).not.toMatch(/\d{13}/);
  });

  it("clip the dedupe key to the summoner's charset and length", () => {
    const id = attemptId("shop", "emails", "epoch", 7);
    expect(dedupeKeyFor({ kind: "none" })(id)).toBe(id.replace("_", ""));
    expect(
      dedupeKeyFor({ kind: "name", maxLength: 10, charset: "a-z" })(id),
    ).toMatch(/^[a-z]{10}$/);
  });

  it("hash the epoch: under one epoch a restarted version repeats an id", () => {
    // The control for the purge test above: what hashing the version alone
    // would do, since a purge restarts the version at the same number.
    expect(attemptId("n", "q", "same", 1)).toBe(attemptId("n", "q", "same", 1));
    expect(attemptId("n", "q", "a", 1)).not.toBe(attemptId("n", "q", "b", 1));
  });
});
