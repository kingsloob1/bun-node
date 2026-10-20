import type {
  JobsDriver,
  SummonControllerOptions,
  SummonOption,
  SummonPolicy,
} from "../lib/index";
import type { SummonCapabilities, SummonFacet } from "../lib/provider/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunJobs,
  createDriver,
  defineSummoner,
  SUMMON_POLICY_KEYS,
  SummonController,
} from "../lib/index";
import { defineComputeProvider, toStandardSchema } from "../lib/provider/index";
import { SUMMON_STATUS_WITHOUT_COVERAGE } from "../lib/summon/controller";
import { DEFAULT_BOOT_BUDGET } from "../lib/summon/define";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * `status().policy` ("policy visible", the user's decisions of 2026-10-12):
 * the policy a controller runs with, as it resolved it — every value in
 * effect, defaults filled in — with `explicit` naming the keys the policy
 * set, in `SUMMON_POLICY_KEYS` order. Local only, never persisted; `env` by
 * name only; a defaulted `bootBudget` absent until the summoner is ready.
 *
 * In-process, on one file backend: none of this depends on the driver (the
 * `events` default reads only its declared capabilities).
 */

const dir = await makeTmpDir("bun-jobs-summon-policy-status");
afterAll(dir.cleanup);

const perTest: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of perTest.splice(0)) {
    await cleanup().catch(() => {});
  }
});

let unique = 0;

/** A fresh file driver on a fresh root, purged and closed after the test. */
async function freshDriver(): Promise<{
  driver: JobsDriver;
  namespace: string;
}> {
  const namespace = testNamespace("summon-policy");
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

/** A summoner that starts nothing, declaring a 20 s boot budget. */
const summoner = defineSummoner({
  kind: "fake",
  bootBudget: 20_000,
  invoke: async () => ({ status: "started", handles: [] }),
});

/** A controller on a fresh backend with `policy`, closed after the test. */
async function controller(
  policy: Partial<SummonControllerOptions>,
  driverOverride?: (driver: JobsDriver) => JobsDriver,
): Promise<SummonController> {
  const { driver, namespace } = await freshDriver();
  const built = new SummonController({
    summoner,
    queue: "work",
    logger: noopLogger,
    ...policy,
    driver: driverOverride === undefined ? driver : driverOverride(driver),
    namespace,
  });
  perTest.unshift(async () => await built.close());
  return built;
}

/** The capabilities a provider below declares, unless a test says otherwise. */
const CAPABILITIES: SummonCapabilities = {
  style: "launch",
  dedupe: { kind: "none" },
  passes: "argv",
  bootBudgetMs: 45_000,
  shutdown: { signal: "SIGTERM", graceMs: 10_000 },
  maxLifetimeMs: null,
  enforcesLifetime: false,
};

/**
 * A provider with these capabilities whose config validates synchronously,
 * or — with `latch` — only once the latch resolves.
 */
function provider(
  capabilities: Partial<SummonCapabilities> = {},
  latch?: Promise<void>,
) {
  return defineComputeProvider({
    name: `test-policy-${++unique}`,
    version: "1.0.0",
    kind: "policy",
    apiVersion: { core: "0.1", summon: "0.1" },
    config: toStandardSchema<{ region: string }>((input) =>
      latch === undefined
        ? { value: input as { region: string } }
        : (async () => {
            await latch;
            return { value: input as { region: string } };
          })(),
    ),
    describe: (config) => ({ region: config.region }),
    summon: (): SummonFacet => ({
      capabilities: { ...CAPABILITIES, ...capabilities },
      summon: async () => ({ status: "started", handles: [] }),
    }),
  });
}

describe("status().policy", () => {
  it("gives every default and explicit: [] for a bare { summoner }", async () => {
    const summon = await controller({});
    const policy = (await summon.status()).policy;
    expect(policy).toEqual({
      triggers: [
        { kind: "onAdd", on: true, debounce: 250 },
        // A file driver's events cross processes (`poll`): on by default.
        { kind: "events", on: true, debounce: 250 },
        { kind: "poll", on: true, every: 30_000 },
      ],
      // The summoner's declared boot budget: it is ready.
      bootBudget: 20_000,
      maxWorkers: 1,
      jobsPerWorker: Infinity,
      maxPending: 1,
      cooldown: 10_000,
      backoff: { initial: 30_000, max: 900_000 },
      circuit: { failures: 5, resetAfter: 900_000 },
      maxLifetime: 3_600_000,
      servedBy: "any-worker",
      scaleDown: { after: 300_000 },
      summonTimeout: 30_000,
      env: [],
      fromSummoned: false,
      onSummonFailed: false,
      explicit: [],
    });
    // Not a shared unit: no per-queue capacities, no group circuit.
    expect(policy).not.toHaveProperty("perQueue");
    expect(policy?.circuit).not.toHaveProperty("group");
  });

  it("names exactly the keys a policy set, in SUMMON_POLICY_KEYS order", async () => {
    const summon = await controller({
      // Given out of order on purpose: the list is the constant's order.
      onSummonFailed: () => {},
      env: { B: "2", A: "1" },
      summonTimeout: 5_000,
      scaleDown: { after: 1_000 },
      servedBy: "summoned-only",
      maxLifetime: 600_000,
      budget: { perDay: 50 },
      circuit: { resetAfter: 60_000 },
      backoff: { initial: 2_000 },
      cooldown: 500,
      maxPending: 2,
      jobsPerWorker: 10,
      maxWorkers: 3,
      bootBudget: 9_000,
      triggers: { poll: false, debounce: 0 },
      fromSummoned: true,
    });
    const policy = (await summon.status()).policy!;
    expect(policy.explicit).toEqual([
      "triggers.poll",
      "triggers.debounce",
      "bootBudget",
      "maxWorkers",
      "jobsPerWorker",
      "maxPending",
      "cooldown",
      "backoff.initial",
      "circuit.resetAfter",
      "budget",
      "budget.perDay",
      "maxLifetime",
      "servedBy",
      "scaleDown.after",
      "summonTimeout",
      "env",
      "fromSummoned",
      "onSummonFailed",
    ]);
    // The order is the constant's, whatever order the options were written in.
    expect(policy.explicit).toEqual(
      SUMMON_POLICY_KEYS.filter((key) => policy.explicit.includes(key)),
    );
    expect(policy).toMatchObject({
      triggers: [
        { kind: "onAdd", on: true, debounce: 0 },
        { kind: "events", on: true, debounce: 0 },
        { kind: "poll", on: false },
      ],
      bootBudget: 9_000,
      maxWorkers: 3,
      jobsPerWorker: 10,
      maxPending: 2,
      cooldown: 500,
      // The unset `max` is still the default.
      backoff: { initial: 2_000, max: 900_000 },
      circuit: { failures: 5, resetAfter: 60_000 },
      maxLifetime: 600_000,
      servedBy: "summoned-only",
      scaleDown: { after: 1_000 },
      summonTimeout: 5_000,
      env: ["A", "B"],
      fromSummoned: true,
      onSummonFailed: true,
    });
    // A poll that is off has no `every`.
    expect(policy.triggers[2]).not.toHaveProperty("every");
  });

  it("does not count a key given as undefined as set", async () => {
    const summon = await controller({
      cooldown: undefined,
      triggers: { onAdd: undefined, poll: 5_000 },
      backoff: { initial: undefined, max: 60_000 },
      budget: undefined,
    });
    const policy = (await summon.status()).policy!;
    expect(policy.explicit).toEqual(["triggers.poll", "backoff.max"]);
    expect(policy.cooldown).toBe(10_000);
  });

  it("reads a maxPending derived from maxWorkers as the derived value, not as set", async () => {
    const summon = await controller({ maxWorkers: 3 });
    const policy = (await summon.status()).policy!;
    expect(policy.maxPending).toBe(3);
    expect(policy.explicit).toEqual(["maxWorkers"]);
    expect(policy.explicit).not.toContain("maxPending");
  });

  it("counts budget: false as set, with no perHour or perDay", async () => {
    const summon = await controller({ budget: false });
    const status = await summon.status();
    expect(status.policy!.explicit).toEqual(["budget"]);
    // The values stay where they always were.
    expect(status.budget).toMatchObject({ off: true });
    expect(status.policy).not.toHaveProperty("budget");
  });

  it("defaults events off where the driver's events are local, and counts an explicit events: true as set", async () => {
    /** The driver, declaring events that do not cross processes (an own property shadows its own). */
    const localEvents = (driver: JobsDriver): JobsDriver =>
      Object.defineProperty(driver, "capabilities", {
        value: { ...driver.capabilities, events: "local" },
      });
    const off = await controller({}, localEvents);
    const offPolicy = (await off.status()).policy!;
    expect(offPolicy.triggers[1]).toEqual({
      kind: "events",
      on: false,
      debounce: 250,
    });
    expect(offPolicy.explicit).toEqual([]);

    const on = await controller(
      { triggers: { events: true, poll: false } },
      localEvents,
    );
    const onPolicy = (await on.status()).policy!;
    expect(onPolicy.triggers[1]).toMatchObject({ kind: "events", on: true });
    expect(onPolicy.explicit).toEqual(["triggers.events", "triggers.poll"]);
  });

  it("shows env by name only: never a value", async () => {
    const summon = await controller({ env: { A: "s3cr3t" } });
    const status = await summon.status();
    expect(status.policy!.env).toEqual(["A"]);
    expect(JSON.stringify(status)).not.toContain("s3cr3t");
  });

  it("leaves a defaulted bootBudget out until a pending provider is ready, then shows its own", async () => {
    let open!: () => void;
    const latch = new Promise<void>((resolve) => {
      open = resolve;
    });
    const configured = provider({}, latch)({ region: "eu" });
    const summon = await controller({ summoner: configured });
    const pending = await summon.status();
    expect(pending.summoner?.readiness).toBe("pending");
    expect(pending.policy).not.toHaveProperty("bootBudget");
    // The placeholder the controller runs on meanwhile never shows.
    expect(JSON.stringify(pending.policy)).not.toContain(
      String(DEFAULT_BOOT_BUDGET),
    );
    expect(pending.policy!.explicit).not.toContain("bootBudget");
    open();
    await configured.ready;
    const ready = await summon.status();
    expect(ready.summoner?.readiness).toBe("ready");
    expect(ready.policy!.bootBudget).toBe(45_000);
    expect(ready.policy!.bootBudget).toBe(
      ready.summoner!.capabilities!.bootBudgetMs,
    );
  });

  it("shows a bootBudget the policy set even while the provider is pending", async () => {
    const configured = provider(
      {},
      new Promise<void>(() => {}),
    )({
      region: "eu",
    });
    const summon = await controller({
      summoner: configured,
      bootBudget: 7_000,
    });
    const status = await summon.status();
    expect(status.summoner?.readiness).toBe("pending");
    expect(status.policy).toMatchObject({
      bootBudget: 7_000,
      explicit: ["bootBudget"],
    });
  });

  it("shows maxWorkers clamped to a wake pool, and still set", async () => {
    const summon = await controller({
      summoner: provider({ style: "wake", poolSize: 2 })({ region: "eu" }),
      maxWorkers: 5,
    });
    const policy = (await summon.status()).policy!;
    expect(policy.maxWorkers).toBe(2);
    expect(policy.maxPending).toBe(2);
    expect(policy.explicit).toEqual(["maxWorkers"]);
  });

  it("shows the configured maxWorkers while a wake pool's provider is pending, and the clamped one once it is ready", async () => {
    let open!: () => void;
    const latch = new Promise<void>((resolve) => {
      open = resolve;
    });
    const configured = provider(
      { style: "wake", poolSize: 2 },
      latch,
    )({
      region: "eu",
    });
    const summon = await controller({ summoner: configured, maxWorkers: 5 });
    const pending = await summon.status();
    expect(pending.summoner?.readiness).toBe("pending");
    // The pool's size is not known yet: the configured value, unclamped,
    // and the defaulted maxPending with it.
    expect(pending.policy).toMatchObject({ maxWorkers: 5, maxPending: 5 });
    open();
    await configured.ready;
    const ready = await summon.status();
    expect(ready.summoner?.readiness).toBe("ready");
    expect(ready.policy).toMatchObject({ maxWorkers: 2, maxPending: 2 });
    // Set either way; only the value in effect changed.
    expect(ready.policy!.explicit).toEqual(["maxWorkers"]);
  });

  it("is not built for the list's reads (GET /summon), which never carry it", async () => {
    const summon = await controller({ maxWorkers: 2 });
    const listed = await summon[SUMMON_STATUS_WITHOUT_COVERAGE]();
    expect(Object.hasOwn(listed, "policy")).toBe(false);
    // The rest of the status is the same read.
    expect(listed.budget).toEqual((await summon.status()).budget);
    expect((await summon.status()).policy?.maxWorkers).toBe(2);
  });

  it("counts fromSummoned: false as set, and shows it false", async () => {
    const summon = await controller({ fromSummoned: false });
    const policy = (await summon.status()).policy!;
    expect(policy.fromSummoned).toBe(false);
    expect(policy.explicit).toEqual(["fromSummoned"]);
  });

  it("never lists group.circuit.* on a shared unit, whose circuit is its group entry's own", async () => {
    const { driver, namespace } = await freshDriver();
    const unit = new SummonController({
      driver,
      namespace,
      queues: ["a", "b"],
      group: {
        name: "thresholds",
        unit: "shared",
        circuit: { failures: 2, resetAfter: 5_000 },
      },
      summoner,
      triggers: { poll: false },
      logger: noopLogger,
    });
    perTest.unshift(async () => await unit.close());
    const policy = (await unit.status()).policy!;
    expect(policy.explicit).toEqual(["triggers.poll"]);
    expect(
      policy.explicit.some((key) => key.startsWith("group.circuit.")),
    ).toBe(false);
    expect(policy.circuit).not.toHaveProperty("group");
    // Negative: the same thresholds on a per-queue controller are set, and shown.
    const apart = await controller({
      group: { name: "apart", circuit: { failures: 2, resetAfter: 5_000 } },
    });
    const own = (await apart.status()).policy!;
    expect(own.explicit).toEqual([
      "group.circuit.failures",
      "group.circuit.resetAfter",
    ]);
    expect(own.circuit.group).toEqual({ failures: 2, resetAfter: 5_000 });
  });

  it("orders perQueue as JavaScript orders keys: integer-like queue names first", async () => {
    const { driver, namespace } = await freshDriver();
    const unit = new SummonController({
      driver,
      namespace,
      queues: ["renders", "2024", "1"],
      group: { name: "numbers", unit: "shared" },
      summoner,
      logger: noopLogger,
    });
    perTest.unshift(async () => await unit.close());
    expect(Object.keys((await unit.status()).policy!.perQueue!)).toEqual([
      "1",
      "2024",
      "renders",
    ]);
  });

  it("gives a shared unit's per-queue capacities, with only its overrides' keys set", async () => {
    const { driver, namespace } = await freshDriver();
    const unit = new SummonController({
      driver,
      namespace,
      queues: ["renders", "thumbs", "previews"],
      // `circuit` is accepted on a shared unit and changes nothing.
      group: { name: "media", unit: "shared", circuit: true },
      summoner,
      maxWorkers: 4,
      jobsPerWorker: 20,
      overrides: {
        thumbs: { jobsPerWorker: 5 },
        previews: { maxWorkers: 2, jobsPerWorker: undefined },
      },
      logger: noopLogger,
    });
    perTest.unshift(async () => await unit.close());
    const policy = (await unit.status()).policy!;
    expect(policy.perQueue).toEqual({
      renders: { jobsPerWorker: 20, maxWorkers: 4, explicit: [] },
      thumbs: { jobsPerWorker: 5, maxWorkers: 4, explicit: ["jobsPerWorker"] },
      previews: { jobsPerWorker: 20, maxWorkers: 2, explicit: ["maxWorkers"] },
    });
    // In the unit's order.
    expect(Object.keys(policy.perQueue!)).toEqual([
      "renders",
      "thumbs",
      "previews",
    ]);
    // The unit's own keys are the policy's, never an override's.
    expect(policy.explicit).toEqual(["maxWorkers", "jobsPerWorker"]);
    // A shared unit's circuit is its entry's own: no group thresholds, even
    // with `group.circuit` on.
    expect(policy.circuit).not.toHaveProperty("group");
  });

  it("shows Infinity per queue where neither the unit nor its override limits jobsPerWorker", async () => {
    const { driver, namespace } = await freshDriver();
    const unit = new SummonController({
      driver,
      namespace,
      queues: ["a", "b"],
      group: { name: "pair", unit: "shared" },
      summoner,
      overrides: { b: { jobsPerWorker: 3 } },
      logger: noopLogger,
    });
    perTest.unshift(async () => await unit.close());
    const policy = (await unit.status()).policy!;
    expect(policy.jobsPerWorker).toBe(Infinity);
    expect(policy.perQueue).toEqual({
      a: { jobsPerWorker: Infinity, maxWorkers: 1, explicit: [] },
      b: { jobsPerWorker: 3, maxWorkers: 1, explicit: ["jobsPerWorker"] },
    });
  });

  it("fills circuit.group from group.circuit: true and from its thresholds", async () => {
    const shared = await controller({
      group: { name: "g1", circuit: true },
      circuit: { failures: 3, resetAfter: 60_000 },
    });
    const sharedPolicy = (await shared.status()).policy!;
    expect(sharedPolicy.circuit).toEqual({
      failures: 3,
      resetAfter: 60_000,
      // Each defaults to the policy's own.
      group: { failures: 3, resetAfter: 60_000 },
    });
    expect(sharedPolicy.explicit).toEqual([
      "circuit.failures",
      "circuit.resetAfter",
    ]);

    const own = await controller({
      group: { name: "g2", circuit: { failures: 2 } },
    });
    const ownPolicy = (await own.status()).policy!;
    expect(ownPolicy.circuit.group).toEqual({
      failures: 2,
      resetAfter: 900_000,
    });
    expect(ownPolicy.explicit).toEqual(["group.circuit.failures"]);

    // Negative: a group that does not share its circuit shows none.
    const apart = await controller({ group: { name: "g3" } });
    expect((await apart.status()).policy!.circuit).not.toHaveProperty("group");
  });

  it("is a fresh copy: mutating the returned status changes nothing in the controller", async () => {
    const summon = await controller({ env: { A: "1" }, maxWorkers: 2 });
    const first = (await summon.status()).policy!;
    const mutable = first as unknown as {
      maxWorkers: number;
      env: string[];
      explicit: string[];
      triggers: { on: boolean }[];
      backoff: { initial: number };
    };
    mutable.maxWorkers = 99;
    mutable.env.push("LEAKED");
    mutable.explicit.length = 0;
    mutable.triggers[0].on = false;
    mutable.backoff.initial = 1;
    const again = (await summon.status()).policy!;
    expect(again.maxWorkers).toBe(2);
    expect(again.env).toEqual(["A"]);
    expect(again.explicit).toEqual(["maxWorkers", "env"]);
    expect(again.triggers[0].on).toBe(true);
    expect(again.backoff.initial).toBe(30_000);
  });
});

describe("status().policy through BunJobs", () => {
  /** A context with `summon` on a fresh file backend, closed after the test. */
  async function context(summon: SummonOption): Promise<BunJobs> {
    const { driver, namespace } = await freshDriver();
    const jobs = new BunJobs({ namespace, driver, logger: noopLogger, summon });
    perTest.unshift(async () => await jobs.close());
    return jobs;
  }

  it("counts a per-queue group member's merged override as set", async () => {
    const quiet: Partial<SummonPolicy> = {
      triggers: { onAdd: false, events: false, poll: false },
    };
    const jobs = await context([
      {
        queues: ["emails", "images"],
        summoner,
        ...quiet,
        overrides: { images: { cooldown: 1_000, backoff: { max: 60_000 } } },
      },
    ]);
    const emails = (await jobs.summonController("emails").status()).policy!;
    const images = (await jobs.summonController("images").status()).policy!;
    expect(emails.explicit).toEqual([
      "triggers.onAdd",
      "triggers.events",
      "triggers.poll",
    ]);
    expect(emails.cooldown).toBe(10_000);
    // Merged one level deep: the group's triggers kept, the override's on top.
    expect(images.explicit).toEqual([
      "triggers.onAdd",
      "triggers.events",
      "triggers.poll",
      "cooldown",
      "backoff.max",
    ]);
    expect(images).toMatchObject({
      cooldown: 1_000,
      backoff: { initial: 30_000, max: 60_000 },
    });
  });
});
