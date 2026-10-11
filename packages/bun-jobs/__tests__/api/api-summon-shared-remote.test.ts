import type { JobsApiAuthorizeContext } from "../../lib/index";
import type { Backend } from "../helpers/backends";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { listWorkerRecords } from "../../lib/drivers/index";
import {
  BunJobs,
  BunQueueWorker,
  createDriver,
  defineSummoner,
} from "../../lib/index";
import { setReservedState } from "../../lib/queue/windows";
import {
  chargeGroup,
  resolveSummonGroup,
  summonGroupRef,
  summonGroupStateName,
} from "../../lib/summon/group";
import { freshMarker, SUMMON_MARKER } from "../../lib/summon/marker";
import { testNamespace, waitFor } from "../helpers";
import { crossProcessBackends } from "../helpers/backends";
import { harness } from "./fixtures";

/**
 * A shared summon unit read from storage (plan summon-multi-queue B4, C3):
 * an API whose context runs no controller answers `GET /queues/{member}/
 * summon` for any of the unit's queues with the unit's status
 * (`local: false`, its persisted `queues`, each attempt's coverage worked
 * out from the claims and records, `last.missing`, `group.unit`), lists the
 * unit once in `GET /summon`, and decides between a queue's own marker and
 * the unit's by their last claims. On every cross-process backend: one
 * context runs the unit and its summoned workers, the API's context sits on
 * its own driver over the same storage.
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

const BACKENDS = await crossProcessBackends({ cleanups });

const MEDIA = ["renders", "thumbs", "previews"];

/** Triggers off and no cooldown: every check is one the test asked for. */
const QUIET = {
  triggers: { onAdd: false, events: false, poll: false as const },
  cooldown: 0,
  backoff: { initial: 1, max: 1 },
};

/**
 * The unit's context (its "platform" starts a worker of the unit on each of
 * `serve`, in-process, holding its job), and an API context with no
 * controller on its own driver over the same storage.
 */
async function setup(
  config: Backend["config"],
  name: string,
  options: { serve?: readonly string[]; bootBudget?: number } = {},
) {
  const namespace = testNamespace(`summon-shared-remote-${name}`);
  const unitDriver = createDriver(config);
  const apiDriver = createDriver(config);
  const workers: BunQueueWorker<unknown, void>[] = [];
  const queues = new Map<BunQueueWorker<unknown, void>, string>();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const summoner = defineSummoner({
    kind: "fake",
    invoke: async (request) => {
      for (const queue of options.serve ?? []) {
        const worker = new BunQueueWorker(queue, async () => await held, {
          namespace,
          driver: unitDriver,
          logger: noopLogger,
          concurrency: 1,
          pollInterval: 20,
          reportInterval: 2_000,
          summon: { id: request.id, group: request.group! },
        });
        workers.push(worker);
        queues.set(worker, queue);
        void worker.run();
      }
      return { status: "started", handles: [] };
    },
  });
  const unit = new BunJobs({
    driver: unitDriver,
    namespace,
    logger: noopLogger,
    summon: [
      {
        queues: MEDIA,
        summoner,
        group: { name: "media", unit: "shared" },
        ...QUIET,
        ...(options.bootBudget === undefined
          ? {}
          : { bootBudget: options.bootBudget }),
      },
    ],
  });
  const jobs = new BunJobs({
    driver: apiDriver,
    namespace,
    logger: noopLogger,
  });
  perTest.push(async () => {
    release();
    await Promise.all(workers.map(async (worker) => await worker.close()));
    await unit.close();
    await jobs.close();
    await apiDriver.purge(namespace).catch(() => {});
    await apiDriver.close();
    await unitDriver.close();
  });
  for (const queue of MEDIA) {
    await unit.queue(queue).add("a", {});
  }
  return { unit, jobs, namespace, apiDriver, workers, queues };
}

/** Waits until every worker's record is listed on its queue. */
async function allListed(
  jobs: BunJobs,
  workers: readonly BunQueueWorker<unknown, void>[],
  queues: ReadonlyMap<BunQueueWorker<unknown, void>, string>,
): Promise<void> {
  await waitFor(
    async () => {
      for (const worker of workers) {
        const records = await listWorkerRecords(
          jobs.driver,
          { ns: jobs.namespace, queue: queues.get(worker)! },
          Date.now(),
        );
        if (!records.some((record) => record.id === worker.id)) {
          return false;
        }
      }
      return true;
    },
    { timeout: 10_000, interval: 20 },
  );
}

/** Rewrites the group's entry with `change` applied to its value. */
async function editEntry(
  jobs: BunJobs,
  change: (value: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const ref = summonGroupRef(jobs.namespace);
  const name = summonGroupStateName("media");
  const stored = await jobs.driver.getQueueState!(ref, name);
  expect(stored).not.toBeNull();
  expect(
    await setReservedState(
      jobs.driver,
      ref,
      name,
      change({ ...(stored!.value as Record<string, unknown>) }),
      stored!.version,
    ),
  ).not.toBeNull();
}

/** Writes a per-queue marker of its own on `queue`, claimed at `lastAttemptAt`. */
async function ownMarker(
  jobs: BunJobs,
  queue: string,
  lastAttemptAt: number,
): Promise<void> {
  const ref = { ns: jobs.namespace, queue };
  const current = await jobs.driver.getQueueState!(ref, SUMMON_MARKER);
  expect(
    await setReservedState(
      jobs.driver,
      ref,
      SUMMON_MARKER,
      { ...freshMarker(Date.now()), lastAttemptAt, kind: "solo" },
      current?.version ?? null,
    ),
  ).not.toBeNull();
}

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `a shared unit read from storage: ${backend.name}`,
    () => {
      it("answers every member with the unit's status, coverage, group unit and, once partial, last.missing", async () => {
        const { unit, jobs, workers, queues } = await setup(
          backend.config,
          backend.name,
          // A unit whose entry script forgot thumbs and previews.
          { serve: ["renders"], bootBudget: 400 },
        );
        const controller = unit.summonController("renders");
        expect(await controller.check()).toMatchObject({ action: "summoned" });
        await allListed(jobs, workers, queues);
        const h = harness({ jobs });
        for (const queue of MEDIA) {
          const response = await h.call("GET", `/queues/${queue}/summon`);
          expect(response.status).toBe(200);
          expect(response.body).toMatchObject({
            queue: "renders",
            queues: MEDIA,
            local: false,
            inert: false,
            group: { name: "media", unit: "shared" },
          });
          expect(response.body.summoner).toBeUndefined();
          expect(response.body.pending).toHaveLength(1);
          expect(response.body.pending[0].coverage).toEqual({
            renders: "registered",
            thumbs: "pending",
            previews: "pending",
          });
        }
        // Once its boot budget is spent the unit settles as partial.
        await waitFor(
          async () => {
            await controller.check();
            return (await controller.status()).last?.outcome === "registered";
          },
          { timeout: 15_000, interval: 50 },
        );
        const settled = await h.call("GET", "/queues/thumbs/summon");
        expect(settled.body.pending).toEqual([]);
        expect(settled.body.last).toMatchObject({
          outcome: "registered",
          detail: "partial:thumbs,previews",
          missing: ["thumbs", "previews"],
        });
        expect(settled.body.failures).toBe(1);
        // The list: the unit once, read from storage.
        const list = await h.call("GET", "/summon");
        expect(list.body.controllers).toEqual([
          expect.objectContaining({
            queue: "renders",
            queues: MEDIA,
            group: "media",
            local: false,
            kind: "fake",
            last: expect.objectContaining({ missing: ["thumbs", "previews"] }),
          }),
        ]);
        const group = await h.call("GET", "/summon/groups/media");
        expect(group.body.unit).toBe("shared");
        expect(h.mismatches()).toEqual([]);
      });

      it("decides between a member's own marker and the unit's by their last claims", async () => {
        const { unit, jobs } = await setup(backend.config, backend.name);
        await unit.summonController("thumbs").check();
        const h = harness({ jobs });
        // An older marker of thumbs' own, from before the switch to a
        // shared unit: the unit answers, and thumbs is not listed apart.
        await ownMarker(jobs, "thumbs", Date.now() - 3_600_000);
        const older = await h.call("GET", "/queues/thumbs/summon");
        expect(older.body).toMatchObject({ queue: "renders", queues: MEDIA });
        const listed = await h.call("GET", "/summon");
        expect(
          (listed.body.controllers as Record<string, unknown>[]).map((item) => [
            item.queue,
            item.queues ?? null,
          ]),
        ).toEqual([["renders", MEDIA]]);
        // A newer one (thumbs switched back to a controller of its own):
        // thumbs answers for itself, and the unit is listed without it.
        await ownMarker(jobs, "thumbs", Date.now() + 60_000);
        const newer = await h.call("GET", "/queues/thumbs/summon");
        expect(newer.body.queue).toBe("thumbs");
        expect(Object.hasOwn(newer.body, "queues")).toBe(false);
        expect(newer.body.local).toBe(false);
        // Asked through another member, the unit names the queues the list
        // names: not thumbs, which answers for itself now.
        const viaRenders = await h.call("GET", "/queues/renders/summon");
        expect(viaRenders.body).toMatchObject({
          queue: "renders",
          queues: ["renders", "previews"],
        });
        const both = await h.call("GET", "/summon");
        expect(
          (both.body.controllers as Record<string, unknown>[]).map((item) => [
            item.queue,
            item.queues ?? null,
          ]),
        ).toEqual([
          ["renders", ["renders", "previews"]],
          ["thumbs", null],
        ]);
        expect(h.mismatches()).toEqual([]);
      });

      it("resolves an entry written before members from its shares, and ignores a newer entry", async () => {
        const { unit, jobs } = await setup(backend.config, backend.name);
        await unit.summonController("thumbs").check();
        const h = harness({ jobs });
        // As PR-B3b wrote it: no members — its shares name them, sorted.
        await editEntry(jobs, ({ members: _gone, ...rest }) => rest);
        const fallback = await h.call("GET", "/queues/thumbs/summon");
        expect(fallback.status).toBe(200);
        expect(fallback.body).toMatchObject({
          queue: "previews",
          queues: ["previews", "renders", "thumbs"],
          group: { unit: "shared" },
        });
        // A per-queue member of a mixed group, charged at its own time, is
        // not taken for one of the unit's queues.
        await unit.queue("solo").add("a", {});
        await editEntry(jobs, (value) => ({
          ...value,
          queues: {
            ...(value.queues as Record<string, unknown>),
            solo: { day: 1, lastAt: (value.lastAttemptAt as number) - 100 },
          },
        }));
        expect((await h.call("GET", "/queues/solo/summon")).status).toBe(409);
        expect(
          (await h.call("GET", "/queues/thumbs/summon")).body.queues,
        ).toEqual(["previews", "renders", "thumbs"]);
        // A newer bun-jobs' entry is never read as a unit.
        await editEntry(jobs, (value) => ({ ...value, v: 2 }));
        expect((await h.call("GET", "/queues/thumbs/summon")).status).toBe(409);
        expect(h.mismatches()).toEqual([]);
      });

      it("lists the unit as thumbs through an API configured with thumbs alone", async () => {
        const { unit, jobs } = await setup(backend.config, backend.name);
        await unit.summonController("thumbs").check();
        const h = harness({ jobs, queues: ["thumbs"] });
        const list = await h.call("GET", "/summon");
        expect(list.body.controllers).toEqual([
          expect.objectContaining({
            queue: "thumbs",
            queues: ["thumbs"],
            group: "media",
            local: false,
          }),
        ]);
        const one = await h.call("GET", "/queues/thumbs/summon");
        expect(one.body).toMatchObject({ queue: "thumbs", queues: ["thumbs"] });
        expect(Object.keys(one.body.pending[0].coverage)).toEqual(["thumbs"]);
        expect(h.mismatches()).toEqual([]);
      });

      it("authorizes the group by its persisted members once its shares are gone", async () => {
        const { unit, jobs } = await setup(backend.config, backend.name);
        await unit.summonController("thumbs").check();
        // UTC midnight empties the shares; the members stay.
        await editEntry(jobs, ({ queues: _shares, ...rest }) => rest);
        const calls: JobsApiAuthorizeContext[] = [];
        const h = harness({
          jobs,
          authorize: (_req, context) => {
            calls.push(context);
            // thumbs alone, and nothing asked without a queue.
            return context.queue === "thumbs";
          },
        });
        const group = await h.call("GET", "/summon/groups/media");
        expect(group.status).toBe(200);
        expect(group.body).toMatchObject({ name: "media", unit: "shared" });
        expect(
          calls
            .filter((one) => one.action === "queues.read")
            .map((one) => one.queue)
            .sort(),
        ).toEqual(["previews", "renders", "thumbs"]);
        expect(h.mismatches()).toEqual([]);
      });

      it("drops a member a per-queue replica charged after the unit's last claim, keeps the live unit for the others, and none once every member has gone back", async () => {
        const { unit, jobs } = await setup(backend.config, backend.name);
        await unit.summonController("thumbs").check();
        const h = harness({ jobs });
        expect((await h.call("GET", "/summon/groups/media")).body.unit).toBe(
          "shared",
        );
        const group = resolveSummonGroup({ name: "media" })!;
        /** A per-queue controller of `queue` claiming: its own marker, and a charge. */
        const replica = async (queue: string): Promise<void> => {
          await Bun.sleep(5);
          await ownMarker(jobs, queue, Date.now());
          expect(
            (await chargeGroup(jobs.driver, jobs.namespace, group, { queue }))
              .outcome,
          ).toBe("charged");
        };
        // A rolling deploy: one replica of renders, still per-queue, claims
        // once while the unit is live with an attempt in flight.
        await replica("renders");
        for (const queue of ["thumbs", "previews"]) {
          const one = await h.call("GET", `/queues/${queue}/summon`);
          expect(one.status).toBe(200);
          expect(one.body).toMatchObject({
            queue: "thumbs",
            queues: ["thumbs", "previews"],
            group: { unit: "shared" },
          });
          expect(one.body.pending).toHaveLength(1);
          expect(Object.keys(one.body.pending[0].coverage)).toEqual([
            "thumbs",
            "previews",
          ]);
        }
        // renders answers for itself.
        const renders = await h.call("GET", "/queues/renders/summon");
        expect(renders.body.queue).toBe("renders");
        expect(Object.hasOwn(renders.body, "queues")).toBe(false);
        expect(
          (
            (await h.call("GET", "/summon")).body.controllers as Record<
              string,
              unknown
            >[]
          ).map((item) => [item.queue, item.queues ?? null]),
        ).toEqual([
          ["renders", null],
          ["thumbs", ["thumbs", "previews"]],
        ]);
        expect((await h.call("GET", "/summon/groups/media")).body.unit).toBe(
          "shared",
        );
        // Every member back on a controller of its own: no unit at all.
        await replica("thumbs");
        await replica("previews");
        const after = await h.call("GET", "/summon/groups/media");
        expect(after.status).toBe(200);
        expect(Object.hasOwn(after.body, "unit")).toBe(false);
        expect(
          (
            (await h.call("GET", "/summon")).body.controllers as Record<
              string,
              unknown
            >[]
          ).every((item) => item.queues === undefined),
        ).toBe(true);
        // The unit claims again: current once more.
        // (Its first attempt dropped, so the next check claims again.)
        await Bun.sleep(5);
        await editEntry(jobs, (value) => ({ ...value, pending: [] }));
        expect(await unit.summonController("thumbs").check()).toMatchObject({
          action: "summoned",
        });
        expect((await h.call("GET", "/summon/groups/media")).body.unit).toBe(
          "shared",
        );
        expect(
          (await h.call("GET", "/queues/previews/summon")).body.queues,
        ).toEqual(MEDIA);
        expect(h.mismatches()).toEqual([]);
      });

      it("answers without coverage, never an error, when a claim read fails", async () => {
        const { unit, jobs } = await setup(backend.config, backend.name);
        await unit.summonController("thumbs").check();
        const h = harness({ jobs });
        const driver = jobs.driver as unknown as {
          getQueueState: (ref: unknown, name: string) => Promise<unknown>;
        };
        const original = driver.getQueueState.bind(driver);
        let claimReads = 0;
        driver.getQueueState = async (ref, name) => {
          if (name.includes("summon-claim")) {
            claimReads++;
            throw new Error("claim read failed");
          }
          return await original(ref, name);
        };
        try {
          const one = await h.call("GET", "/queues/thumbs/summon");
          expect(one.status).toBe(200);
          expect(one.body.pending).toHaveLength(1);
          expect(Object.hasOwn(one.body.pending[0], "coverage")).toBe(false);
          expect(claimReads).toBeGreaterThan(0);
          const list = await h.call("GET", "/summon");
          expect(list.status).toBe(200);
        } finally {
          driver.getQueueState = original;
        }
        expect(h.mismatches()).toEqual([]);
      });
    },
  );
}
