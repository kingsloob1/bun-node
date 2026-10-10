import type {
  JobsDriver,
  SummonControllerOptions,
  SummonEventPayload,
  SummonFailure,
  SummonReleaseRequest,
  SummonRequest,
} from "../lib/index";
import type { SummonCapabilities, SummonFacet } from "../lib/provider/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { listWorkerRecords } from "../lib/drivers/index";
import {
  BunQueue,
  BunQueueWorker,
  ConfigError,
  createDriver,
  defineSummoner,
  SummonController,
} from "../lib/index";
import { defineComputeProvider, toStandardSchema } from "../lib/provider/index";
import { LOCAL_ADD_HOOKS } from "../lib/queue/BunQueue";
import { setReservedState } from "../lib/queue/windows";
import { ATTACH_QUEUE } from "../lib/summon/controller";
import {
  chargeGroup,
  noteGroupCircuit,
  resolveSummonGroup,
  summonGroupRef,
  summonGroupStateName,
} from "../lib/summon/group";
import { attemptId, freshMarker, SUMMON_MARKER } from "../lib/summon/marker";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * The shared-unit summon controller (plan summon-multi-queue §4, PR-B3a):
 * one controller for a group whose every unit serves all of its queues,
 * built by hand (`new SummonController({ queues, group: { name, unit:
 * "shared" } })`). In-process, on one file backend; what needs real
 * processes is in `summon-shared-unit-xproc.test.ts`, on every
 * cross-process backend.
 */

const dir = await makeTmpDir("bun-jobs-summon-shared-unit");
afterAll(dir.cleanup);

const perTest: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of perTest.splice(0)) {
    await cleanup().catch(() => {});
  }
});

/** Triggers off, no cooldown, a 1 ms backoff: every check is one the test asked for. */
const QUIET: Partial<SummonControllerOptions> = {
  triggers: { onAdd: false, events: false, poll: false },
  cooldown: 0,
  backoff: { initial: 1, max: 1 },
  logger: noopLogger,
};

let unique = 0;

/** A fresh file driver on a fresh root, purged and closed after the test. */
async function freshDriver(
  namespace = testNamespace("summon-shared"),
): Promise<{ driver: JobsDriver; namespace: string }> {
  const driver = createDriver({
    type: "file",
    root: join(dir.path, `root-${++unique}`),
  });
  await driver.connect();
  perTest.push(async () => {
    await driver.purge(namespace).catch(() => {});
    await driver.close();
  });
  return { driver, namespace };
}

/** Adds `count` waiting jobs to `queue`. */
async function seed(
  driver: JobsDriver,
  namespace: string,
  queue: string,
  count = 1,
): Promise<void> {
  const q = new BunQueue(queue, { namespace, driver, logger: noopLogger });
  for (let index = 0; index < count; index++) {
    await q.add("a", {});
  }
  await q.close();
}

/** Waits until `done()` holds, checking every 20 ms, for at most `ms`. */
async function waitUntil(
  done: () => boolean | Promise<boolean>,
  ms: number,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await Bun.sleep(20);
  }
}

/** A summoner that records every request and starts nothing. */
function recordingSummoner(): {
  summoner: ReturnType<typeof defineSummoner>;
  calls: SummonRequest[];
} {
  const calls: SummonRequest[] = [];
  return {
    calls,
    summoner: defineSummoner({
      kind: "fake",
      invoke: async (request) => {
        calls.push(request);
        return { status: "started", handles: [`h-${calls.length}`] };
      },
    }),
  };
}

/** Builds a controller that is closed after the test, and collects its events. */
function build(options: SummonControllerOptions): {
  controller: SummonController;
  events: SummonEventPayload[];
} {
  const controller = new SummonController({ ...QUIET, ...options });
  perTest.push(async () => await controller.close());
  const events: SummonEventPayload[] = [];
  controller.on("summon", (event) => events.push(event));
  return { controller, events };
}

/* --- C1: one queue is unchanged ------------------------------------------- */

/** The epoch the snapshot pre-writes, so the attempt id is a constant. */
const SNAP_EPOCH = "0123456789abcdef".repeat(2);

describe("one queue after the #home/#queues split (A7 back-compat)", () => {
  it("claims attempt ids and writes argv exactly as before", async () => {
    // A fixed namespace on a fresh root: with the marker's epoch fixed too,
    // the id is a function of constants, pinned below.
    const { driver, namespace } = await freshDriver("b3a-snap");
    await seed(driver, namespace, "emails");
    const marker = { ...freshMarker(Date.now()), epoch: SNAP_EPOCH };
    expect(
      await setReservedState(
        driver,
        { ns: namespace, queue: "emails" },
        SUMMON_MARKER,
        marker,
        null,
      ),
    ).toBe(1);
    const { summoner, calls } = recordingSummoner();
    const { controller } = build({
      driver,
      namespace,
      queue: "emails",
      summoner,
    });
    const result = await controller.check();
    expect(result.action).toBe("summoned");
    expect(calls).toHaveLength(1);
    const [request] = calls;
    // attemptId(namespace, "emails", SNAP_EPOCH, 2): the queue, never a
    // group key, and the marker's own queue-state entry.
    expect(request!.id).toBe("sm_irzjyqfpbqk7cg5wcvap7o47bj");
    expect([...request!.argv]).toEqual([
      "--bun-jobs-summon-id=sm_irzjyqfpbqk7cg5wcvap7o47bj",
      "--bun-jobs-summon-kind=fake",
      "--bun-jobs-summon-mode=exit-on-idle",
      "--bun-jobs-summon-namespace=b3a-snap",
      "--bun-jobs-summon-queue=emails",
      "--bun-jobs-summon-max-lifetime-ms=3600000",
      "--bun-jobs-summon-grace-ms=10000",
    ]);
    expect(request!.queue).toBe("emails");
    expect(request!.queues).toEqual(["emails"]);
    expect("group" in request!).toBe(false);
    expect("demands" in request!).toBe(false);
    const stored = await driver.getQueueState!(
      { ns: namespace, queue: "emails" },
      SUMMON_MARKER,
    );
    // The claim wrote version 2, the summoner's answer version 3.
    expect(stored?.version).toBe(3);
    expect(
      (stored?.value as { pending: { id: string }[] }).pending.map(
        (one) => one.id,
      ),
    ).toEqual(["sm_irzjyqfpbqk7cg5wcvap7o47bj"]);
  });
});

/* --- C2: options and refusals --------------------------------------------- */

/** A launch provider's capabilities, as `defineSummoner` declares them. */
const CAPABILITIES: SummonCapabilities = {
  style: "launch",
  dedupe: { kind: "none" },
  passes: "argv",
  bootBudgetMs: 20_000,
  shutdown: { signal: "SIGTERM", graceMs: 10_000 },
  maxLifetimeMs: null,
  enforcesLifetime: false,
};

/** A plugin provider declaring `summon` at `version`, validating its config after `delay` ms (`0`: at once). */
function plugin(
  summon: string,
  options: { delay?: number; capabilities?: Partial<SummonCapabilities> } = {},
): SummonControllerOptions["summoner"] {
  const provider = defineComputeProvider({
    name: `test-shared-${++unique}`,
    version: "1.0.0",
    kind: "plugin",
    apiVersion: { core: "0.1", summon },
    config: toStandardSchema<{ region: string }>((input) =>
      options.delay === undefined
        ? { value: input as { region: string } }
        : (async () => {
            await Bun.sleep(options.delay!);
            return { value: input as { region: string } };
          })(),
    ),
    summon: (): SummonFacet => ({
      capabilities: { ...CAPABILITIES, ...options.capabilities },
      summon: async () => ({ status: "started", handles: [] }),
    }),
  });
  return provider({ region: "eu" });
}

/** A shared unit's options over `media`'s three queues, with `extra` over them. */
function sharedOptions(
  driver: JobsDriver,
  namespace: string,
  extra: Partial<SummonControllerOptions> = {},
): SummonControllerOptions {
  return {
    ...QUIET,
    driver,
    namespace,
    summoner: recordingSummoner().summoner,
    queues: ["renders", "thumbs", "previews"],
    group: { name: "media", unit: "shared" },
    ...extra,
  };
}

describe("shared unit: options", () => {
  it("takes queues, in order, with queue as the first", async () => {
    const { driver, namespace } = await freshDriver();
    const { controller } = build(sharedOptions(driver, namespace));
    expect(controller.queue).toBe("renders");
    expect(controller.queues).toEqual(["renders", "thumbs", "previews"]);
    expect(Object.isFrozen(controller.queues)).toBe(true);
  });

  it("gives one queue its own queues: [queue]", async () => {
    const { driver, namespace } = await freshDriver();
    const { controller } = build({
      driver,
      namespace,
      queue: "emails",
      summoner: recordingSummoner().summoner,
    });
    expect(controller.queues).toEqual(["emails"]);
    expect(Object.isFrozen(controller.queues)).toBe(true);
  });

  it("accepts both budgets (Q2) and group.circuit (Q3) without complaint", async () => {
    const { driver, namespace } = await freshDriver();
    expect(() =>
      build(
        sharedOptions(driver, namespace, {
          budget: { perHour: 10 },
          group: {
            name: "media",
            unit: "shared",
            budget: { perHour: 20, perDay: 50 },
            circuit: true,
          },
          overrides: { renders: { jobsPerWorker: 10, maxWorkers: 1 } },
        }),
      ),
    ).not.toThrow();
  });

  /** Each case: what to change, and what the `ConfigError` must say. */
  const REFUSALS: [
    string,
    (base: SummonControllerOptions) => unknown,
    RegExp,
  ][] = [
    [
      "queue and queues",
      (base) => ({ ...base, queue: "renders" }),
      /queue or queues, not both/,
    ],
    [
      "neither queue nor queues",
      ({ queues: _queues, ...base }) => base,
      /needs queue \(one queue\) or queues/,
    ],
    [
      "queues without a group",
      ({ group: _group, ...base }) => base,
      /queues is for a shared unit/,
    ],
    [
      // The plan's negative control: per-queue units take no queues.
      "queues with unit per-queue",
      (base) => ({ ...base, group: { name: "media", unit: "per-queue" } }),
      /queues is for a shared unit/,
    ],
    [
      "queues with a group that leaves unit out",
      (base) => ({ ...base, group: { name: "media" } }),
      /queues is for a shared unit/,
    ],
    [
      "a shared unit given queue",
      ({ queues: _queues, ...base }) => ({ ...base, queue: "renders" }),
      /names the queues it serves in queues, not queue/,
    ],
    ["an empty queues", (base) => ({ ...base, queues: [] }), /at least one/],
    [
      "a queue named twice",
      (base) => ({ ...base, queues: ["renders", "thumbs", "renders"] }),
      /names "renders" twice/,
    ],
    [
      "the reserved pseudo-queue",
      (base) => ({ ...base, queues: ["renders", "__bunjobs"] }),
      /queues\[1\] may not be "__bunjobs"/,
    ],
    [
      "a queue that is not a segment",
      (base) => ({ ...base, queues: ["renders", "a b"] }),
      /queues\[1\]/,
    ],
    [
      "an unknown unit",
      (base) => ({ ...base, group: { name: "media", unit: "pooled" } }),
      /group.unit must be "per-queue" or "shared"/,
    ],
    [
      "overrides on one queue",
      ({ queues: _queues, group: _group, ...base }) => ({
        ...base,
        queue: "renders",
        overrides: { renders: { maxWorkers: 1 } },
      }),
      /controller for one queue has none/,
    ],
    [
      "overrides for a queue not in queues",
      (base) => ({ ...base, overrides: { videos: { maxWorkers: 1 } } }),
      /overrides names queue "videos"/,
    ],
    [
      "an override of anything but the two per-queue values",
      (base) => ({
        ...base,
        overrides: { thumbs: { budget: { perHour: 1 } } },
      }),
      /overrides.thumbs.budget: a shared unit takes only jobsPerWorker and maxWorkers/,
    ],
    [
      "a per-queue maxWorkers above the unit's",
      (base) => ({
        ...base,
        maxWorkers: 2,
        overrides: { thumbs: { maxWorkers: 3 } },
      }),
      /overrides.thumbs.maxWorkers is 3, above the unit's maxWorkers of 2/,
    ],
    [
      "a per-queue maxWorkers of 0",
      (base) => ({ ...base, overrides: { thumbs: { maxWorkers: 0 } } }),
      /overrides.thumbs.maxWorkers must be a positive whole number/,
    ],
    [
      "a per-queue jobsPerWorker of 0",
      (base) => ({ ...base, overrides: { thumbs: { jobsPerWorker: 0 } } }),
      /overrides.thumbs.jobsPerWorker must be a positive number/,
    ],
    [
      "a provider written for summon 0.1",
      (base) => ({ ...base, summoner: plugin("0.1") }),
      /needs a provider written for summon 0.2 or later.*negotiated summon 0.1/,
    ],
    [
      'a provider that passes "none"',
      (base) => ({
        ...base,
        summoner: plugin("0.2", { capabilities: { passes: "none" } }),
      }),
      /passes: "none"/,
    ],
    [
      "arguments over 8 KiB",
      (base) => ({
        ...base,
        queues: Array.from(
          { length: 100 },
          (_, index) => `${"q".repeat(60)}${index}`,
        ),
      }),
      /over the 8 KiB a summon may pass/,
    ],
  ];

  for (const [name, change, message] of REFUSALS) {
    it(`refuses ${name}`, async () => {
      const { driver, namespace } = await freshDriver();
      const options = change(
        sharedOptions(driver, namespace),
      ) as SummonControllerOptions;
      let thrown: unknown;
      try {
        build(options);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConfigError);
      expect((thrown as Error).message).toMatch(message);
    });
  }

  it("accepts a provider written for summon 0.2, and defineSummoner (the host's version)", async () => {
    const { driver, namespace } = await freshDriver();
    expect(() =>
      build(sharedOptions(driver, namespace, { summoner: plugin("0.2") })),
    ).not.toThrow();
    expect(() =>
      build(
        sharedOptions(driver, namespace, {
          summoner: defineSummoner({ kind: "x", invoke: async () => {} }),
        }),
      ),
    ).not.toThrow();
  });

  it('refuses passes: "none" when a late provider\'s facet is adopted', async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, "renders");
    // Validated asynchronously: built on provisional capabilities, which
    // pass argv, so construction cannot see it.
    const { controller } = build(
      sharedOptions(driver, namespace, {
        summoner: plugin("0.2", {
          delay: 5,
          capabilities: { passes: "none" },
        }),
      }),
    );
    let thrown: unknown;
    try {
      await controller.check();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toMatch(/passes: "none"/);
  });
});

/* --- C3: the group's entry is the shared unit's marker -------------------- */

/** The group's entry as stored, and its version. */
async function groupEntry(
  driver: JobsDriver,
  namespace: string,
  name = "media",
): Promise<{ value: Record<string, any>; version: number } | undefined> {
  const stored = await driver.getQueueState!(
    summonGroupRef(namespace),
    summonGroupStateName(name),
  );
  return stored === null
    ? undefined
    : {
        value: stored.value as Record<string, any>,
        version: stored.version,
      };
}

describe("shared unit: the group's entry is its marker", () => {
  it("lifts an entry per-queue charges wrote, keeping its counts (§4.3)", async () => {
    const { driver, namespace } = await freshDriver();
    const group = resolveSummonGroup({ name: "media" })!;
    for (const queue of ["renders", "thumbs", "renders"]) {
      expect(
        (await chargeGroup(driver, namespace, group, { queue })).outcome,
      ).toBe("charged");
    }
    const before = (await groupEntry(driver, namespace))!;
    expect(before.value.budget.hour).toBe(3);
    await seed(driver, namespace, "renders");
    const { summoner, calls } = recordingSummoner();
    const { controller } = build(
      sharedOptions(driver, namespace, { summoner }),
    );
    expect((await controller.check()).action).toBe("summoned");
    expect(calls).toHaveLength(1);
    const after = (await groupEntry(driver, namespace))!;
    // One more, on the counts per-queue controllers left: not a fresh marker.
    expect(after.value.budget).toMatchObject({ hour: 4, day: 4 });
    expect(after.value.epoch).toBe(before.value.epoch);
    // Each member's share counts the unit once (Q8); Part A's shares stay.
    expect(after.value.queues).toMatchObject({
      renders: { day: 3 },
      thumbs: { day: 2 },
      previews: { day: 1 },
    });
    expect(after.value.pending).toHaveLength(1);
    expect(after.value).toMatchObject({ kind: "fake", group: "media" });
    // The group-entry convention: the limits, here the group's defaults.
    expect(after.value.limits).toEqual({ perHour: 30, perDay: 300 });
    // The attempt id is the group's: attemptId(ns, "group:media", epoch, v).
    expect(calls[0]!.id).toBe(
      attemptId(
        namespace,
        "group:media",
        before.value.epoch,
        before.version + 1,
      ),
    );
    expect(after.value.pending[0].id).toBe(calls[0]!.id);
    // No marker on a member queue, and no pseudo-queue made a queue.
    expect(
      await driver.getQueueState!(
        { ns: namespace, queue: "renders" },
        SUMMON_MARKER,
      ),
    ).toBeNull();
    expect(await driver.listQueues(namespace)).not.toContain("__bunjobs");
  });

  it("leaves no per-queue claim in flight on a share it counts", async () => {
    const { driver, namespace } = await freshDriver();
    // A per-queue replica's charge, its claim conditional on version 0.
    expect(
      (
        await chargeGroup(
          driver,
          namespace,
          resolveSummonGroup({ name: "media" })!,
          { queue: "renders", against: 0 },
        )
      ).outcome,
    ).toBe("charged");
    await seed(driver, namespace, "renders");
    const { controller } = build(sharedOptions(driver, namespace));
    expect((await controller.check()).action).toBe("summoned");
    // The shared claim landed in the same write that counted it: nothing of
    // it is in flight, so no per-queue replica may read its share as such.
    const shares = (await groupEntry(driver, namespace))!.value.queues;
    expect(shares.renders.day).toBe(2);
    expect(Object.hasOwn(shares.renders, "against")).toBe(false);
  });

  it("keeps its attempts when a per-queue controller of the group charges the entry", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, "renders");
    const { controller } = build(sharedOptions(driver, namespace));
    expect((await controller.check()).action).toBe("summoned");
    const claimed = (await groupEntry(driver, namespace))!.value;
    expect(
      (
        await chargeGroup(
          driver,
          namespace,
          resolveSummonGroup({ name: "media" })!,
          { queue: "emails" },
        )
      ).outcome,
    ).toBe("charged");
    const after = (await groupEntry(driver, namespace))!.value;
    expect(after.pending).toEqual(claimed.pending);
    expect(after.failures).toBe(claimed.failures);
    expect(after.budget.hour).toBe(2);
    expect((await controller.status()).pending).toHaveLength(1);
  });

  it("leaves an entry a newer bun-jobs wrote alone, and goes inert", async () => {
    const { driver, namespace } = await freshDriver();
    const newer = { v: 2, epoch: "x", future: true };
    await setReservedState(
      driver,
      summonGroupRef(namespace),
      summonGroupStateName("media"),
      newer,
      null,
    );
    await seed(driver, namespace, "renders");
    const { summoner, calls } = recordingSummoner();
    const { controller } = build(
      sharedOptions(driver, namespace, { summoner }),
    );
    expect(await controller.check()).toEqual({
      action: "skipped",
      reason: "inert",
    });
    expect(controller.inert).toBe(true);
    expect(calls).toHaveLength(0);
    expect((await groupEntry(driver, namespace))!.value).toEqual(newer);
  });

  it("holds the counts to the stricter of the two budgets, per period (Q2)", async () => {
    const { driver, namespace } = await freshDriver();
    const { controller } = build(
      sharedOptions(driver, namespace, {
        budget: { perHour: 10 },
        group: {
          name: "media",
          unit: "shared",
          budget: { perHour: 20, perDay: 50 },
        },
      }),
    );
    const status = await controller.status();
    // The effective limits: the policy's perHour, the group's perDay.
    expect(status.budget).toMatchObject({ perHour: 10, perDay: 50 });
    expect(status.budget?.off).toBeUndefined();
    // The group's own limits, against the same counts.
    expect(status.group?.budget).toMatchObject({ perHour: 20, perDay: 50 });
  });

  for (const [side, own, groupBudget] of [
    ["the policy's", { perHour: 2 }, { perHour: 30 }],
    ["the group's", { perHour: 30 }, { perHour: 2 }],
  ] as const) {
    it(`refuses an attempt once ${side} limit is reached (Q2)`, async () => {
      const { driver, namespace } = await freshDriver();
      await seed(driver, namespace, "renders");
      const { summoner, calls } = recordingSummoner();
      const { controller, events } = build(
        sharedOptions(driver, namespace, {
          summoner,
          budget: own,
          group: { name: "media", unit: "shared", budget: groupBudget },
          maxWorkers: 5,
        }),
      );
      const reasons: unknown[] = [];
      for (let round = 0; round < 3; round++) {
        const result = await controller.check();
        reasons.push(result.action === "skipped" ? result.reason : "summoned");
        // Release the attempt so maxPending is not what stops the next one.
        const entry = (await groupEntry(driver, namespace))!;
        await setReservedState(
          driver,
          summonGroupRef(namespace),
          summonGroupStateName("media"),
          { ...entry.value, pending: [] },
          entry.version,
        );
      }
      expect(reasons).toEqual(["summoned", "summoned", "budget"]);
      expect(calls).toHaveLength(2);
      expect(
        events.find((event) => event.outcome === "budget-exhausted"),
      ).toMatchObject({ group: "media" });
    });
  }

  it("is held back by a circuit per-queue controllers of its group opened for its kind (Q3)", async () => {
    const { driver, namespace } = await freshDriver();
    const noted = await noteGroupCircuit(driver, namespace, "media", {
      kind: "fake",
      queue: "emails",
      notes: [{ type: "failure", id: "sm_x", atOnce: true }],
      failures: 1,
      resetAfter: 60_000,
    });
    expect(noted.opened).toBeDefined();
    await seed(driver, namespace, "renders");
    const { summoner, calls } = recordingSummoner();
    const { controller } = build(
      sharedOptions(driver, namespace, {
        summoner,
        // Accepted, and changes nothing (Q3).
        group: { name: "media", unit: "shared", circuit: false },
      }),
    );
    expect(await controller.check()).toMatchObject({
      action: "skipped",
      reason: "circuit-open",
    });
    expect(calls).toHaveLength(0);
  });

  it("gives back the count and every member's share when the provider was never called", async () => {
    const { driver, namespace } = await freshDriver();
    // Part A's counts first: one charge for renders, kept through the refund.
    expect(
      (
        await chargeGroup(
          driver,
          namespace,
          resolveSummonGroup({ name: "media" })!,
          { queue: "renders" },
        )
      ).outcome,
    ).toBe("charged");
    await seed(driver, namespace, "renders");
    const capabilities: SummonCapabilities = {
      style: "launch",
      dedupe: { kind: "none" },
      passes: "argv",
      bootBudgetMs: 20_000,
      shutdown: { signal: "SIGTERM", graceMs: 10_000 },
      maxLifetimeMs: null,
      enforcesLifetime: false,
    };
    // Its config fails validation when the call is prepared: the attempt is
    // claimed, and no provider is called.
    const provider = defineComputeProvider({
      name: `test-shared-refund-${++unique}`,
      version: "1.0.0",
      kind: "async",
      apiVersion: { core: "0.1", summon: "0.2" },
      config: toStandardSchema<{ region: string }>(async () => {
        await Bun.sleep(5);
        return { issues: [{ message: "unreachable", path: ["region"] }] };
      }),
      summon: (): SummonFacet => ({
        capabilities,
        summon: async () => ({ status: "started", handles: [] }),
      }),
    });
    const { controller } = build(
      sharedOptions(driver, namespace, {
        summoner: provider({ region: "eu" }),
        circuit: { failures: 100 },
      }),
    );
    expect(await controller.check()).toMatchObject({
      action: "summoned",
      outcome: "failed",
    });
    const after = (await groupEntry(driver, namespace))!.value;
    expect(after.budget).toMatchObject({ hour: 1, day: 1 });
    // Each member's +1 is given back with the count; Part A's share stays.
    expect(after.queues).toMatchObject({
      renders: { day: 1 },
      thumbs: { day: 0 },
      previews: { day: 0 },
    });
  });
});

/* --- C4: combined demand, per-queue capacity, the request ----------------- */

describe("shared unit: combined demand (§4.4)", () => {
  /** renders wants 3 (30 jobs, 10 a worker), thumbs 1: one call for 3 units, not 4. */
  it("summons for the most-starved queue: the maximum, never the sum (B3)", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, "renders", 30);
    await seed(driver, namespace, "thumbs", 1);
    const { summoner, calls } = recordingSummoner();
    const { controller } = build(
      sharedOptions(driver, namespace, {
        summoner,
        maxWorkers: 5,
        overrides: { renders: { jobsPerWorker: 10 } },
      }),
    );
    expect(await controller.check()).toMatchObject({ action: "summoned" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.count).toBe(3);
    expect(calls[0]!.target).toBe(3);
    // The rest are on their way: nothing more for either queue.
    expect(await controller.check()).toMatchObject({
      action: "skipped",
      reason: "pending",
    });
    expect(calls).toHaveLength(1);
  });

  it("caps a queue's ask at its own maxWorkers (B3)", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, "renders", 30);
    await seed(driver, namespace, "thumbs", 1);
    const { summoner, calls } = recordingSummoner();
    const { controller } = build(
      sharedOptions(driver, namespace, {
        summoner,
        maxWorkers: 5,
        overrides: { renders: { jobsPerWorker: 10, maxWorkers: 1 } },
      }),
    );
    expect(await controller.check()).toMatchObject({ action: "summoned" });
    expect(calls.map((call) => call.count)).toEqual([1]);
  });

  it("the expansion form, for contrast, starts one unit set per queue: 3 + 1", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, "renders", 30);
    await seed(driver, namespace, "thumbs", 1);
    const { summoner, calls } = recordingSummoner();
    for (const [queue, jobsPerWorker] of [
      ["renders", 10],
      ["thumbs", Infinity],
    ] as const) {
      const { controller } = build({
        driver,
        namespace,
        queue,
        summoner,
        maxWorkers: 5,
        jobsPerWorker,
      });
      await controller.check();
    }
    expect(calls.map((call) => call.count)).toEqual([3, 1]);
  });

  it("names every queue and the group, with each queue's demand, the most starved as demand", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, "thumbs", 2);
    await seed(driver, namespace, "__proto__", 1);
    const { summoner, calls } = recordingSummoner();
    const { controller } = build(
      sharedOptions(driver, namespace, {
        summoner,
        queues: ["renders", "thumbs", "__proto__"],
      }),
    );
    expect(await controller.check()).toMatchObject({ action: "summoned" });
    const [request] = calls;
    expect(request!.queue).toBe("renders");
    expect(request!.queues).toEqual(["renders", "thumbs", "__proto__"]);
    expect(request!.group).toBe("media");
    expect(request!.argv).toContain("--bun-jobs-summon-group=media");
    expect(request!.argv).toContain("--bun-jobs-summon-queue=__proto__");
    // renders has nothing; thumbs is the first of the starved.
    expect(request!.demand.waiting).toBe(2);
    const demands = request!.demands!;
    expect(Object.getPrototypeOf(demands)).toBeNull();
    expect(Object.isFrozen(demands)).toBe(true);
    expect(Object.keys(demands)).toEqual(["renders", "thumbs", "__proto__"]);
    expect(Object.hasOwn(demands, "__proto__")).toBe(true);
    // A queue named like the prototype key, read as the own key it is.
    const proto = "__proto__";
    expect(demands[proto]!.waiting).toBe(1);
    expect(demands.renders!.waiting).toBe(0);
    expect(demands.thumbs!.waiting).toBe(2);
    // Its share is an own key of the stored entry, not a prototype.
    const shares = (await groupEntry(driver, namespace))!.value.queues;
    expect(Object.hasOwn(shares, proto)).toBe(true);
    expect(shares[proto]).toMatchObject({ day: 1 });
    expect(Object.keys(shares)).toEqual(["renders", "thumbs", "__proto__"]);
  });

  it("counts a queue's own always-on worker for that queue alone", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, "renders", 3);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = new BunQueueWorker("renders", async () => await held, {
      namespace,
      driver,
      logger: noopLogger,
      concurrency: 1,
      pollInterval: 20,
      reportInterval: 100,
    });
    void worker.run();
    perTest.unshift(async () => {
      release();
      await worker.close();
    });
    const deadline = Date.now() + 5_000;
    while (
      (
        await listWorkerRecords(
          driver,
          { ns: namespace, queue: "renders" },
          Date.now(),
        )
      ).every((one) => one.id !== worker.id) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(20);
    }
    const { summoner, calls } = recordingSummoner();
    const { controller } = build(
      sharedOptions(driver, namespace, { summoner }),
    );
    // renders is served by its own worker; nothing else wants one.
    expect(await controller.check()).toMatchObject({
      action: "skipped",
      reason: "served",
    });
    // thumbs gets work: the renders worker does not serve it.
    await seed(driver, namespace, "thumbs", 1);
    expect(await controller.check()).toMatchObject({ action: "summoned" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.count).toBe(1);
    expect(calls[0]!.demand.waiting).toBe(1);
  });
});

/* --- C6: triggers and events on every member ------------------------------ */

/** `driver` with `replace`'s members over it, every other bound to it. */
function wrap(
  driver: JobsDriver,
  replace: Partial<Record<keyof JobsDriver, unknown>>,
): JobsDriver {
  return new Proxy(driver, {
    get(target, property) {
      if (property in replace) {
        return replace[property as keyof JobsDriver];
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("shared unit: triggers and events (§4.6)", () => {
  it("makes one check and one call for a burst of adds across its queues", async () => {
    const { driver, namespace } = await freshDriver();
    const { summoner, calls } = recordingSummoner();
    const { controller } = build(
      sharedOptions(driver, namespace, {
        summoner,
        triggers: { onAdd: true, events: false, poll: false, debounce: 50 },
      }),
    );
    const queues = ["renders", "thumbs", "previews", "videos"].map(
      (name) => new BunQueue(name, { namespace, driver, logger: noopLogger }),
    );
    perTest.unshift(async () => {
      await Promise.all(queues.map(async (queue) => await queue.close()));
    });
    for (const queue of queues) {
      controller[ATTACH_QUEUE](queue);
    }
    // Hooked by name: one hook on each of its queues, none on another.
    const hooks = queues.map((queue) => queue[LOCAL_ADD_HOOKS]?.length ?? 0);
    expect(hooks).toEqual([1, 1, 1, 0]);
    for (const queue of queues.slice(0, 3)) {
      await queue.add("a", {});
      await queue.add("b", {});
    }
    await waitUntil(() => calls.length > 0, 5_000);
    await Bun.sleep(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.reason).toBe("add");
    // An add on a queue the unit does not serve triggers nothing.
    await queues[3]!.add("c", {});
    await Bun.sleep(200);
    expect(calls).toHaveLength(1);
    await controller.close();
    expect(queues.map((queue) => queue[LOCAL_ADD_HOOKS])).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  for (const events of [true, false]) {
    it(
      events
        ? "subscribes on every queue: another process's add on thumbs triggers a check"
        : "with triggers.events off, hears no other process (control)",
      async () => {
        const { driver, namespace } = await freshDriver();
        const heard = new Map<string, (event: { type: string }) => void>();
        const unsubscribed: string[] = [];
        const wrapped = wrap(driver, {
          subscribe: async (
            _ns: string,
            _scope: string,
            queue: string,
            listener: (event: { type: string }) => void,
          ) => {
            heard.set(queue, listener);
            return async () => {
              unsubscribed.push(queue);
            };
          },
        });
        const { summoner, calls } = recordingSummoner();
        const { controller } = build(
          sharedOptions(wrapped, namespace, {
            summoner,
            triggers: { onAdd: false, events, poll: false, debounce: 20 },
          }),
        );
        await Bun.sleep(50);
        expect([...heard.keys()].sort()).toEqual(
          events ? ["previews", "renders", "thumbs"] : [],
        );
        await seed(driver, namespace, "thumbs");
        heard.get("thumbs")?.({ type: "added" });
        await Bun.sleep(300);
        expect(calls).toHaveLength(events ? 1 : 0);
        if (events) {
          expect(calls[0]!.reason).toBe("event");
        }
        await controller.close();
        expect(unsubscribed.sort()).toEqual(
          events ? ["previews", "renders", "thumbs"] : [],
        );
      },
    );
  }

  it("publishes each event once on every queue, naming the group", async () => {
    const { driver, namespace } = await freshDriver();
    const published: { target: string; payload: SummonEventPayload }[] = [];
    const wrapped = wrap(driver, {
      publish: async (envelope: {
        target: string;
        type: string;
        payload: SummonEventPayload;
      }) => {
        if (envelope.type === "summon") {
          published.push({
            target: envelope.target,
            payload: envelope.payload,
          });
        }
        await driver.publish(envelope as never);
      },
    });
    await seed(driver, namespace, "renders");
    const failures: SummonFailure[] = [];
    const { controller, events } = build(
      sharedOptions(wrapped, namespace, {
        summoner: defineSummoner({
          kind: "fake",
          invoke: async () => {
            throw new Error("down");
          },
        }),
        onSummonFailed: (failure) => {
          failures.push(failure);
        },
      }),
    );
    expect(await controller.check()).toMatchObject({ outcome: "failed" });
    await controller.close();
    // The local event names the group.
    expect(events).toEqual([
      expect.objectContaining({ outcome: "failed", group: "media" }),
    ]);
    // Published once on each queue's channel.
    expect(published.map((one) => one.target).sort()).toEqual([
      "previews",
      "renders",
      "thumbs",
    ]);
    for (const one of published) {
      expect(one.payload).toMatchObject({
        id: events[0]!.id,
        outcome: "failed",
        group: "media",
      });
    }
    // onSummonFailed: the first queue, and the group (Q10).
    await Bun.sleep(20);
    expect(failures).toEqual([
      expect.objectContaining({
        outcome: "failed",
        queue: "renders",
        group: "media",
      }),
    ]);
  });
});

/* --- C7: scale-down only when every queue is idle ------------------------- */

describe("shared unit: scale-down (B8)", () => {
  /** A scale-style summoner recording calls and releases. */
  function scaler(): {
    summoner: ReturnType<typeof defineSummoner>;
    calls: SummonRequest[];
    releases: SummonReleaseRequest[];
  } {
    const calls: SummonRequest[] = [];
    const releases: SummonReleaseRequest[] = [];
    return {
      calls,
      releases,
      summoner: defineSummoner({
        kind: "fake",
        style: "scale",
        invoke: async (request) => {
          calls.push(request);
          return { status: "started", handles: ["svc"] };
        },
        release: async (request) => {
          releases.push(request);
        },
      }),
    };
  }

  it("releases only once every queue has been idle for scaleDown.after, naming every queue", async () => {
    const { driver, namespace } = await freshDriver();
    const renders = new BunQueue("renders", {
      namespace,
      driver,
      logger: noopLogger,
    });
    perTest.unshift(async () => await renders.close());
    const job = await renders.add("a", {});
    const { summoner, releases } = scaler();
    const { controller } = build(
      sharedOptions(driver, namespace, {
        summoner,
        scaleDown: { after: 100 },
      }),
    );
    expect((await controller.check()).action).toBe("summoned");
    await Bun.sleep(150);
    // renders still has its job: no release, however long thumbs is idle.
    expect((await controller.check()).action).not.toBe("released");
    await renders.remove(job.id);
    expect((await controller.check()).action).toBe("none");
    await Bun.sleep(150);
    expect((await controller.check()).action).toBe("released");
    expect(releases).toEqual([
      {
        namespace,
        queue: "renders",
        queues: ["renders", "thumbs", "previews"],
        group: "media",
        target: 0,
      },
    ]);
    // Once per idle stretch.
    expect((await controller.check()).action).toBe("none");
    expect(releases).toHaveLength(1);
  });

  it("never releases mid-job: a paused queue with a job in progress holds it", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, "thumbs");
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const worker = new BunQueueWorker(
      "thumbs",
      async () => {
        started();
        await held;
      },
      { namespace, driver, logger: noopLogger, pollInterval: 20 },
    );
    void worker.run();
    perTest.unshift(async () => {
      finish();
      await worker.close();
    });
    await running;
    const thumbs = new BunQueue("thumbs", {
      namespace,
      driver,
      logger: noopLogger,
    });
    perTest.unshift(async () => await thumbs.close());
    await thumbs.pause();
    const { summoner, releases } = scaler();
    const { controller } = build(
      sharedOptions(driver, namespace, {
        summoner,
        scaleDown: { after: 0 },
      }),
    );
    for (let round = 0; round < 3; round++) {
      expect((await controller.check()).action).not.toBe("released");
      await Bun.sleep(20);
    }
    expect(releases).toHaveLength(0);
    // The job ends: every queue is idle now, paused or not.
    finish();
    await waitUntil(async () => (await thumbs.getDemand()).active === 0, 5_000);
    expect((await controller.check()).action).toBe("released");
    expect(releases).toHaveLength(1);
  });
});
