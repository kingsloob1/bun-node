import type { JobsApiConfig } from "../../lib/api/config";
import type { JobsApiAuthorizeContext } from "../../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { BunJobs, createDriver, defineSummoner } from "../../lib/index";
import { setReservedState } from "../../lib/queue/windows";
import {
  chargeGroup,
  refundGroup,
  resolveSummonGroup,
} from "../../lib/summon/group";
import { freshMarker, SUMMON_MARKER } from "../../lib/summon/marker";
import { makeTmpDir, testNamespace } from "../helpers";
import { crossProcessBackends } from "../helpers/backends";
import { runBun } from "../helpers/spawnBun";
import { harness } from "./fixtures";

/**
 * Summon status without a local controller (plan summon-multi-queue §5.1,
 * PR-A3): every claim persists its controller's `kind`, budget limits (or
 * that the budget was off) and group on the queue's marker, and every group
 * charge its limits on the group's entry, so an API process with no
 * controller for a queue answers its status from storage (`local: false`),
 * lists it in `GET /summon`, and serves the summon group routes.
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

const WRITER = join(
  import.meta.dir,
  "..",
  "fixtures",
  "processes",
  "summon-remote-writer.ts",
);
const BACKENDS = await crossProcessBackends({ cleanups });

/** Triggers off and no cooldown: every check is one the test asked for. */
const QUIET = {
  triggers: { onAdd: false, events: false, poll: false as const },
  cooldown: 0,
};

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `summon status from storage: ${backend.name}`,
    () => {
      it("answers a queue, the list and the group written by another process (test 6)", async () => {
        const namespace = testNamespace(`summon-remote-${backend.name}`);
        const run = await runBun<{ done?: boolean; actions?: string[] }>(
          WRITER,
          {
            SUMMON_TEST_DRIVER: JSON.stringify(backend.config),
            SUMMON_TEST_NAMESPACE: namespace,
          },
        );
        expect(run.exitCode, run.stderr).toBe(0);
        expect(run.lines.at(-1)).toEqual({
          done: true,
          actions: ["summoned", "summoned"],
        });

        // An API whose context runs no controller at all.
        const driver = createDriver(backend.config);
        const jobs = new BunJobs({ driver, namespace, logger: noopLogger });
        perTest.push(async () => {
          await jobs.close();
          await driver.purge(namespace).catch(() => {});
          await driver.close();
        });
        const h = harness({ jobs });

        const renders = await h.call("GET", "/queues/renders/summon");
        expect(renders.status).toBe(200);
        expect(renders.body).toMatchObject({
          queue: "renders",
          local: false,
          inert: false,
          failures: 0,
          budget: {
            hour: 1,
            perHour: 4,
            day: 1,
            perDay: 300,
            hourResetsAt: expect.any(Number),
            dayResetsAt: expect.any(Number),
          },
          last: { outcome: "started" },
          group: {
            name: "media",
            budget: { hour: 2, perHour: 7, day: 2, perDay: 300 },
            queues: {
              renders: { day: 1, lastAt: expect.any(Number) },
              thumbs: { day: 1, lastAt: expect.any(Number) },
            },
            // The kind the last claim persisted has no circuit: none for
            // it; the other kind's is in `circuits`.
            circuits: {
              "broken-kind": {
                failures: 5,
                openUntil: expect.any(Number),
                openedBy: { queue: "thumbs", detail: "InvalidToken" },
              },
            },
          },
        });
        expect(renders.body.summoner).toBeUndefined();
        expect(renders.body.group.circuit).toBeUndefined();

        const thumbs = (await h.call("GET", "/queues/thumbs/summon")).body;
        expect(thumbs).toMatchObject({
          local: false,
          failures: 5,
          circuitOpenUntil: expect.any(Number),
          // Its budget was off: `off`, never the defaults.
          budget: { hour: 1, day: 1, off: true },
          last: { outcome: "failed", detail: "InvalidToken" },
          // Read from storage, its own kind's circuit is shown too.
          group: { name: "media", circuit: { failures: 5 } },
        });
        expect(thumbs.budget.perHour).toBeUndefined();

        const list = await h.call("GET", "/summon");
        expect(list.status).toBe(200);
        expect(list.body.controllers).toEqual([
          {
            namespace,
            queue: "renders",
            local: false,
            kind: "remote-kind",
            inert: false,
            last: expect.objectContaining({ outcome: "started" }),
            budget: renders.body.budget,
          },
          {
            namespace,
            queue: "thumbs",
            local: false,
            kind: "broken-kind",
            inert: false,
            circuitOpenUntil: thumbs.circuitOpenUntil,
            last: expect.objectContaining({ outcome: "failed" }),
            budget: thumbs.budget,
          },
        ]);

        const groups = await h.call("GET", "/summon/groups");
        expect(groups.status).toBe(200);
        expect(groups.body).toEqual({ groups: [renders.body.group] });
        const one = await h.call("GET", "/summon/groups/media");
        expect(one.body).toEqual(renders.body.group);
        expect((await h.call("GET", "/summon/groups/elsewhere")).status).toBe(
          409,
        );

        // Spending and resetting still need a controller here.
        expect((await h.call("POST", "/queues/renders/summon")).status).toBe(
          409,
        );
        expect(
          (await h.call("POST", "/summon/groups/media/reset", { budget: true }))
            .status,
        ).toBe(409);
        expect(h.mismatches()).toEqual([]);
      });
    },
  );
}

describe("in one process, on the file backend", () => {
  /** Two contexts on one root: one runs the controllers, the API's runs `local`. */
  async function setup(api: Partial<JobsApiConfig> = {}) {
    const dir = await makeTmpDir("bun-jobs-api-summon-remote");
    const namespace = testNamespace("api-summon-remote");
    const writerDriver = createDriver({
      type: "file",
      root: join(dir.path, "d"),
    });
    const apiDriver = createDriver({ type: "file", root: join(dir.path, "d") });
    const summoner = defineSummoner({
      kind: "rec",
      invoke: async () => ({ status: "started", handles: [] }),
    });
    const writer = new BunJobs({
      driver: writerDriver,
      namespace,
      logger: noopLogger,
      summon: {
        remote: { summoner, ...QUIET, group: { name: "g", circuit: true } },
        hidden: { summoner, ...QUIET },
      },
    });
    const jobs = new BunJobs({
      driver: apiDriver,
      namespace,
      logger: noopLogger,
      summon: {
        local: { summoner, ...QUIET, group: { name: "g", circuit: true } },
      },
    });
    perTest.push(async () => {
      await writer.close();
      await jobs.close();
      await apiDriver.purge(namespace).catch(() => {});
      await apiDriver.close();
      await writerDriver.close();
      await dir.cleanup();
    });
    for (const queue of ["remote", "hidden", "local", "plain"]) {
      await writer.queue(queue).add("a", {});
    }
    await writer.summonController("remote").check();
    await writer.summonController("hidden").check();
    return {
      writer,
      jobs,
      namespace,
      apiDriver,
      h: harness({ jobs, ...api }),
    };
  }

  const queuesOf = (response: { body: { controllers: { queue: string }[] } }) =>
    response.body.controllers.map((one) => one.queue);

  it("lists local and remote queues together, each saying which, and never a queue without summon state", async () => {
    const { h } = await setup();
    const list = (await h.call("GET", "/summon")).body.controllers;
    expect(list.map((item: { queue: string }) => item.queue)).toEqual([
      "hidden",
      "local",
      "remote",
    ]);
    expect(list[1]).toMatchObject({
      queue: "local",
      local: true,
      kind: "rec",
      readiness: "ready",
      inert: false,
    });
    for (const remote of [list[0], list[2]]) {
      expect(remote).toMatchObject({ local: false, kind: "rec" });
      expect(remote).not.toHaveProperty("readiness");
      // Inert only for state a newer bun-jobs wrote.
      expect(remote).toMatchObject({ inert: false });
    }
    expect(h.mismatches()).toEqual([]);
  });

  for (const listQueues of ["all", "authorized"] as const) {
    it(`hides a remote queue the caller may not read, under an allow-list or a deny-list (listQueues: ${listQueues})`, async () => {
      const seen: JobsApiAuthorizeContext[] = [];
      const { h } = await setup({
        listQueues,
        authorize: (_req, ctx) => {
          seen.push(ctx);
          return ctx.action !== "queues.read" || ctx.queue !== "hidden";
        },
      });
      seen.length = 0;
      const denied = await h.call("GET", "/summon");
      expect(queuesOf(denied)).toEqual(["local", "remote"]);
      expect(denied.text).not.toContain('"hidden"');
      // `queues.list` for the route, then `queues.read` once per summoning
      // queue (never the queue without summon state), as the per-queue
      // status route asks it.
      expect(seen[0]).toMatchObject({ action: "queues.list" });
      expect(
        seen
          .filter((ctx) => ctx.action === "queues.read")
          .map((ctx) => [ctx.queue, ctx.route?.path])
          .sort(),
      ).toEqual([
        ["hidden", "/queues/:queue/summon"],
        ["local", "/queues/:queue/summon"],
        ["remote", "/queues/:queue/summon"],
      ]);
      expect((await h.call("GET", "/queues/hidden/summon")).status).toBe(403);

      // An allow-list: `queues.read` on `remote` alone.
      const { h: allow } = await setup({
        listQueues,
        authorize: (_req, ctx) =>
          ctx.action !== "queues.read" || ctx.queue === "remote",
      });
      expect(queuesOf(await allow.call("GET", "/summon"))).toEqual(["remote"]);
    });
  }

  it("is refused without queues.list", async () => {
    const { h } = await setup({
      authorize: (_req, ctx) => ctx.action !== "queues.list",
    });
    expect((await h.call("GET", "/summon")).status).toBe(403);
    expect((await h.call("GET", "/summon/groups")).status).toBe(403);
  });

  it("serves a group with a local controller from its policy, and resets it through one", async () => {
    const { h, writer } = await setup();
    // `remote` charged the group; the local controller's view adds `circuit`.
    const group = (await h.call("GET", "/summon/groups/g")).body;
    expect(group).toMatchObject({
      name: "g",
      budget: { hour: 1, perHour: 30, day: 1, perDay: 300 },
      queues: { remote: { day: 1 } },
      circuit: { failures: 0 },
    });
    const reset = await h.call("POST", "/summon/groups/g/reset", {
      budget: true,
      circuit: true,
    });
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({
      budget: { hour: 0, day: 0 },
      queues: {},
    });
    // The writer's queue's own counts are untouched: only the group's.
    expect(
      (await writer.summonController("remote").status()).budget,
    ).toMatchObject({ hour: 1 });
    // A group with a local controller and no state yet: its zeros.
    expect(h.mismatches()).toEqual([]);
  });

  it("never refunds a charge made before a group reset out of the counts after it", async () => {
    const { h, apiDriver, namespace } = await setup();
    const group = resolveSummonGroup({ name: "g" })!;
    // A charge in flight when the operator resets: its claim is lost later.
    const before = await chargeGroup(apiDriver, namespace, group, {
      queue: "local",
    });
    if (before.outcome !== "charged") {
      throw new Error(`charge: ${before.outcome}`);
    }
    expect(before.entry.budget).toMatchObject({ hour: 2, day: 2 });
    const reset = await h.call("POST", "/summon/groups/g/reset", {
      budget: true,
    });
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ budget: { hour: 0, day: 0 } });
    // One attempt counted after the reset…
    const after = await chargeGroup(apiDriver, namespace, group, {
      queue: "local",
    });
    expect(after.outcome).toBe("charged");
    // …is not taken away by the pre-reset charge's refund: the reset
    // already dropped that one, so the group still counts one, not zero.
    await refundGroup(apiDriver, namespace, "g", {
      queue: "local",
      hourStart: before.hourStart,
      dayStart: before.dayStart,
      clears: before.clears,
    });
    expect((await h.call("GET", "/summon/groups/g")).body).toMatchObject({
      budget: { hour: 1, day: 1 },
      queues: { local: { day: 1 } },
    });
    expect(h.mismatches()).toEqual([]);
  });

  it("reads a marker from before limits were persisted as limits unknown, and a newer one as inert", async () => {
    const { h, jobs, namespace } = await setup();
    const driver = jobs.driver;
    await jobs.queue("old").add("a", {});
    // A marker no claim of this version wrote: no kind, no limits.
    await setReservedState(
      driver,
      { ns: namespace, queue: "old" },
      SUMMON_MARKER,
      freshMarker(Date.now()),
      null,
    );
    const old = (await h.call("GET", "/queues/old/summon")).body;
    expect(old).toMatchObject({
      local: false,
      budget: { hour: 0, day: 0, limitsUnknown: true },
    });
    expect(old.budget).not.toHaveProperty("perHour");
    expect(old.budget).not.toHaveProperty("off");
    const item = (await h.call("GET", "/summon")).body.controllers.find(
      (one: { queue: string }) => one.queue === "old",
    );
    expect(item).toMatchObject({ local: false, kind: "" });

    await jobs.queue("newer").add("a", {});
    await setReservedState(
      driver,
      { ns: namespace, queue: "newer" },
      SUMMON_MARKER,
      { v: 9 },
      null,
    );
    expect((await h.call("GET", "/queues/newer/summon")).body).toMatchObject({
      local: false,
      inert: true,
      inertReason: "newer-marker",
    });
    // A queue with no summon state at all: 409, as before.
    expect((await h.call("GET", "/queues/plain/summon")).status).toBe(409);
    expect(h.mismatches()).toEqual([]);
  });

  it("advertises status from storage in /meta.features.summonRemoteStatus", async () => {
    const { h, jobs } = await setup();
    expect(
      (await h.call("GET", "/meta")).body.features.summonRemoteStatus,
    ).toBe(true);
    const runner = harness({ jobs, mode: "runner" });
    expect(
      (await runner.call("GET", "/meta")).body.features.summonRemoteStatus,
    ).toBe(false);
  });
});
