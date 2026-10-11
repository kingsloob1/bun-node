import type {
  JobsDriver,
  SummonControllerOptions,
  SummonRequest,
} from "../lib/index";
import type { SummonCapabilities, SummonFacet } from "../lib/provider/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  createDriver,
  defineSummoner,
  ProviderError,
  SummonController,
} from "../lib/index";
import { defineComputeProvider, toStandardSchema } from "../lib/provider/index";
import { setReservedState } from "../lib/queue/windows";
import {
  chargeGroup,
  resetGroup,
  resolveSummonGroup,
  summonGroupRef,
  summonGroupStateName,
} from "../lib/summon/group";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * A shared unit's reset (plan summon-multi-queue §4.3, PR-B3b C9), and the
 * group reset (`resetGroup`, behind `POST /summon/groups/:group/reset`) on a
 * group entry that is a shared unit's marker: it must clear what the
 * marker's own reset clears — the refund marks with the counts, and the
 * unit's own circuit with the group's — or a refund of an attempt claimed
 * before the reset gives back a count taken after it, and the unit stays
 * held back by a circuit the operator closed.
 */

const dir = await makeTmpDir("bun-jobs-summon-shared-reset");
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
async function freshDriver(): Promise<{
  driver: JobsDriver;
  namespace: string;
}> {
  const namespace = testNamespace("summon-shared-reset");
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

/** Adds one waiting job to `queue`. */
async function seed(
  driver: JobsDriver,
  namespace: string,
  queue: string,
): Promise<void> {
  const q = new BunQueue(queue, { namespace, driver, logger: noopLogger });
  await q.add("a", {});
  await q.close();
}

/** The group's stored entry: the shared unit's marker. */
async function groupEntry(
  driver: JobsDriver,
  namespace: string,
): Promise<Record<string, any>> {
  const stored = await driver.getQueueState!(
    summonGroupRef(namespace),
    summonGroupStateName("media"),
  );
  return stored!.value as Record<string, any>;
}

/** A shared unit over renders and thumbs, closed after the test. */
function sharedUnit(
  driver: JobsDriver,
  namespace: string,
  summoner: SummonControllerOptions["summoner"],
  extra: Partial<SummonControllerOptions> = {},
): SummonController {
  const controller = new SummonController({
    ...QUIET,
    driver,
    namespace,
    summoner,
    queues: ["renders", "thumbs"],
    group: { name: "media", unit: "shared" },
    ...extra,
  });
  perTest.push(async () => await controller.close());
  return controller;
}

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

describe("the group reset on a shared unit's entry (resetGroup)", () => {
  it("clears the refund marks with the counts: an attempt claimed before it gives back nothing counted after it", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, "renders");
    // The driver the unit uses, paused once between the claim's write
    // (which counts the attempt and marks it refundable) and the record's
    // read of the entry: the window an operator's reset can land in.
    const home = summonGroupStateName("media");
    let armed = false;
    let paused!: () => void;
    const reached = new Promise<void>((resolve) => {
      paused = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = new Proxy(driver, {
      get(target, key) {
        if (key === "setQueueState") {
          return async (
            ...args: Parameters<NonNullable<JobsDriver["setQueueState"]>>
          ) => {
            const written = await target.setQueueState!(...args);
            const value = args[2] as { budget?: { counted?: string[] } };
            if (
              written !== null &&
              args[1] === home &&
              (value.budget?.counted?.length ?? 0) > 0
            ) {
              armed = true;
            }
            return written;
          };
        }
        if (key === "getQueueState") {
          return async (
            ...args: Parameters<NonNullable<JobsDriver["getQueueState"]>>
          ) => {
            if (armed && args[1] === home) {
              armed = false;
              paused();
              await released;
            }
            return await target.getQueueState!(...args);
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    // Its config fails validation: the attempt is claimed and no provider
    // is ever called, so its count is given back when it is recorded.
    const provider = defineComputeProvider({
      name: `test-shared-reset-${++unique}`,
      version: "1.0.0",
      kind: "async",
      apiVersion: { core: "0.1", summon: "0.2" },
      config: toStandardSchema<{ region: string }>(async () => {
        await Bun.sleep(1);
        return { issues: [{ message: "unreachable", path: ["region"] }] };
      }),
      summon: (): SummonFacet => ({
        capabilities: CAPABILITIES,
        summon: async () => ({ status: "started", handles: [] }),
      }),
    });
    const controller = sharedUnit(
      gated,
      namespace,
      provider({ region: "eu" }),
      {
        circuit: { failures: 100 },
      },
    );
    const checking = controller.check();
    perTest.unshift(async () => {
      release();
      await checking.catch(() => {});
    });
    await reached;
    const claimed = await groupEntry(driver, namespace);
    expect(claimed.budget).toMatchObject({ hour: 1, day: 1 });
    expect(claimed.budget.counted).toHaveLength(1);

    // The operator's group reset clears the counts…
    expect(await resetGroup(driver, namespace, "media", { budget: true })).toBe(
      true,
    );
    const cleared = await groupEntry(driver, namespace);
    expect(cleared.budget).toMatchObject({ hour: 0, day: 0, clears: 1 });
    // …and the marks with them, as the marker's own reset does.
    expect(cleared.budget.counted).toBeUndefined();
    // A per-queue controller of the group counts one attempt after it.
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

    // The claimed attempt is recorded now: its refund must not give back
    // the count taken after the reset.
    release();
    expect(await checking).toMatchObject({
      action: "summoned",
      outcome: "failed",
    });
    const after = await groupEntry(driver, namespace);
    expect(after.budget).toMatchObject({ hour: 1, day: 1 });
  });

  it("closes the unit's own circuit with the group's: failures, the open circuit, the loss streak and the backoff", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, "renders");
    let rejecting = true;
    const calls: SummonRequest[] = [];
    const controller = sharedUnit(
      driver,
      namespace,
      defineSummoner({
        kind: "fake",
        invoke: async (request) => {
          calls.push(request);
          if (rejecting) {
            throw new ProviderError("credentials rejected", "auth");
          }
          return { status: "started", handles: [] };
        },
      }),
      { backoff: { initial: 600_000, max: 600_000 } },
    );
    // An `auth` error opens the unit's circuit at once.
    expect(await controller.check()).toMatchObject({ outcome: "failed" });
    const open = await groupEntry(driver, namespace);
    expect(open.circuitOpenUntil).toBeGreaterThan(Date.now());
    expect(open.failures).toBeGreaterThan(0);
    // A loss streak too, as a crash loop leaves one.
    await setReservedState(
      driver,
      summonGroupRef(namespace),
      summonGroupStateName("media"),
      { ...open, lossStreak: 4 },
      (await driver.getQueueState!(
        summonGroupRef(namespace),
        summonGroupStateName("media"),
      ))!.version,
    );
    expect(await controller.check()).toMatchObject({
      action: "skipped",
      reason: "circuit-open",
    });

    // What `POST /summon/groups/:group/reset { circuit: true }` does.
    expect(
      await resetGroup(driver, namespace, "media", { circuit: true }),
    ).toBe(true);
    const closed = await groupEntry(driver, namespace);
    expect(closed.failures).toBe(0);
    expect(closed.circuitOpenUntil).toBeUndefined();
    expect(closed.lossStreak).toBeUndefined();
    expect(closed.backoffUntil).toBeUndefined();
    const status = await controller.status();
    expect(status.circuitOpenUntil).toBeUndefined();
    expect(status.failures).toBe(0);
    rejecting = false;
    expect(await controller.check()).toMatchObject({
      action: "summoned",
      outcome: "started",
    });
    expect(calls).toHaveLength(2);
  });

  it("leaves a shared unit's circuit alone when only another kind's is reset", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, "renders");
    const controller = sharedUnit(
      driver,
      namespace,
      defineSummoner({
        kind: "fake",
        invoke: async () => {
          throw new ProviderError("credentials rejected", "auth");
        },
      }),
    );
    expect(await controller.check()).toMatchObject({ outcome: "failed" });
    // A per-queue controller of another kind resets its group circuit.
    expect(
      await resetGroup(driver, namespace, "media", { circuit: "other" }),
    ).toBe(true);
    const entry = await groupEntry(driver, namespace);
    expect(entry.circuitOpenUntil).toBeGreaterThan(Date.now());
    expect(entry.failures).toBeGreaterThan(0);
  });

  it("changes nothing of a Part A entry beyond what it did before (no marker fields)", async () => {
    const { driver, namespace } = await freshDriver();
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
    expect(
      await resetGroup(driver, namespace, "media", {
        budget: true,
        circuit: true,
      }),
    ).toBe(true);
    const entry = await groupEntry(driver, namespace);
    expect(entry.budget).toMatchObject({ hour: 0, day: 0, clears: 1 });
    for (const field of [
      "pending",
      "failures",
      "lossStreak",
      "circuitOpenUntil",
      "backoffUntil",
    ]) {
      expect(Object.hasOwn(entry, field)).toBe(false);
    }
  });
});
