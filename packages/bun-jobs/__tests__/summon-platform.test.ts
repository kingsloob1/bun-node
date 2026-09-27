import type {
  JobsDriver,
  SummonControllerOptions,
  SummonEventPayload,
} from "../lib/index";
import type { FakePlatformOptions } from "./helpers/summon";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { BunQueue, createDriver, SummonController } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";
import { fakePlatform, workerLines } from "./helpers/summon";

/**
 * Summoning end to end with no cloud: a controller calls a fake platform,
 * which starts `fixtures/summoned-worker.ts` as a real process with the
 * request's arguments; the worker registers, the attempt is released, the
 * backlog drains and the worker exits 0.
 *
 * On SQLite and the file driver always, and on Redis and Postgres when their
 * URLs are set (the other server backends are covered in-process by
 * `summon-controller.test.ts`; spawning is the slow part).
 */

setDefaultTimeout(60_000);

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

const perTest: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of perTest.splice(0)) {
    await cleanup().catch(() => {});
  }
});

const BACKENDS = (await crossProcessBackends({ cleanups })).filter((backend) =>
  ["file", "sqlite", "redis", "postgres"].includes(backend.name),
);

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `summon with a fake platform: ${backend.name}`,
    () => {
      /** A namespace, a queue, a controller over a fake platform; all cleaned up. */
      async function setup(
        platformOptions: Omit<FakePlatformOptions, "driver">,
        policy: Partial<SummonControllerOptions> = {},
      ): Promise<{
        driver: JobsDriver;
        queue: BunQueue<unknown>;
        controller: SummonController;
        platform: ReturnType<typeof fakePlatform>;
        events: SummonEventPayload[];
        /** Runs a check every 100 ms until `predicate` holds. */
        checkUntil: (
          predicate: () => boolean | Promise<boolean>,
          timeout?: number,
        ) => Promise<void>;
      }> {
        const driver = createDriver(backend.config);
        await driver.connect();
        const namespace = testNamespace(`platform-${backend.name}`);
        const queue = new BunQueue("work", {
          namespace,
          driver,
          logger: noopLogger,
        });
        const platform = fakePlatform({
          driver: backend.config,
          ...platformOptions,
        });
        const controller = new SummonController({
          driver,
          namespace,
          queue: "work",
          summoner: platform.summoner,
          triggers: { onAdd: false, events: false, poll: false },
          cooldown: 0,
          logger: noopLogger,
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
          queue,
          controller,
          platform,
          events,
          checkUntil: async (predicate, timeout = 20_000) => {
            await waitFor(
              async () => {
                await controller.check();
                return await predicate();
              },
              { timeout, interval: 100 },
            );
          },
        };
      }

      it("summons a worker that registers, releases the attempt, drains the backlog and exits 0", async () => {
        const { queue, controller, platform, events, checkUntil } = await setup(
          {},
        );
        const added = await queue.addBulk(
          Array.from({ length: 20 }, (_, index) => ({
            name: "job",
            data: { index },
          })),
        );

        expect(await controller.check()).toMatchObject({
          action: "summoned",
          outcome: "started",
        });
        await checkUntil(() =>
          events.some((event) => event.outcome === "registered"),
        );
        await platform.settled();

        expect(platform.calls).toHaveLength(1);
        expect(platform.spawned).toHaveLength(1);
        expect(await platform.spawned[0]!.exited).toBe(0);
        const lines = await workerLines(platform.spawned[0]!);
        expect(
          lines.find((line) => line.event === "record")?.summon,
        ).toMatchObject({
          id: platform.calls[0]!.id,
          kind: "fake",
          mode: "exit-on-idle",
        });
        expect(lines.filter((line) => line.event === "processed")).toHaveLength(
          20,
        );
        for (const job of added) {
          expect((await queue.getJob(job.id))?.state ?? "removed").not.toBe(
            "waiting",
          );
        }
        expect((await controller.check()).action).toBe("none");
        expect((await controller.status()).pending).toHaveLength(0);
      });

      it("does not summon twice through a slow cold start inside bootBudget", async () => {
        const { queue, platform, events, checkUntil } = await setup(
          { coldStartMs: 1_000 },
          { bootBudget: 20_000 },
        );
        await queue.add("job", {});
        await checkUntil(() =>
          events.some((event) => event.outcome === "registered"),
        );
        await platform.settled();
        expect(platform.calls).toHaveLength(1);
        expect(platform.spawned).toHaveLength(1);
      });

      it("declares a start that never registers lost, backs off, and summons again", async () => {
        const { queue, controller, platform, events } = await setup(
          { neverRegister: true },
          { bootBudget: 300, backoff: { initial: 200, max: 200 } },
        );
        await queue.add("job", {});
        expect((await controller.check()).action).toBe("summoned");
        await Bun.sleep(350);
        expect(await controller.check()).toMatchObject({ reason: "backoff" });
        expect(events.map((event) => event.outcome)).toEqual([
          "started",
          "lost",
        ]);
        await Bun.sleep(250);
        expect((await controller.check()).action).toBe("summoned");
        expect(platform.calls).toHaveLength(2);
        expect(platform.calls[1]!.id).not.toBe(platform.calls[0]!.id);
      });

      it("records a throwing platform as failed and a declining one as unavailable", async () => {
        const throwing = await setup({ fail: "throw" });
        await throwing.queue.add("job", {});
        expect(await throwing.controller.check()).toMatchObject({
          outcome: "failed",
        });
        const declining = await setup({ fail: "unavailable" });
        await declining.queue.add("job", {});
        expect(await declining.controller.check()).toMatchObject({
          outcome: "unavailable",
        });
        expect((await declining.controller.status()).last?.detail).toBe(
          "no capacity",
        );
      });

      it("summons a replacement for a worker that crashed holding a job, which recovers it", async () => {
        const { queue, platform, checkUntil } = await setup(
          {
            crashAfterMs: 1_200,
            env: { SUMMON_TEST_LOCK_MS: "1500", SUMMON_TEST_STALLED_MS: "300" },
          },
          { bootBudget: 20_000 },
        );
        const job = await queue.add("job", {}, { removeOnComplete: false });
        await checkUntil(() => platform.calls.length === 2, 30_000);
        expect(await platform.spawned[0]!.exited).toBe(1);
        expect(
          platform.calls[1]!.demand.active + platform.calls[1]!.demand.waiting,
        ).toBe(1);
        await waitFor(
          async () => (await queue.getJob(job.id))?.state === "completed",
          {
            timeout: 30_000,
          },
        );
      });

      it("with passes none, releases the attempt by the worker's start time", async () => {
        const { queue, platform, events, checkUntil } = await setup({
          passes: "none",
        });
        await queue.add("job", {});
        await checkUntil(() =>
          events.some((event) => event.outcome === "registered"),
        );
        await platform.settled();
        const lines = await workerLines(platform.spawned[0]!);
        expect(
          lines.find((line) => line.event === "record")?.summon,
        ).toBeNull();
      });
    },
  );
}
