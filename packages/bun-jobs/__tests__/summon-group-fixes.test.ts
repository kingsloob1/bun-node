import type { JobsDriver } from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  createDriver,
  defineSummoner,
  SummonController,
} from "../lib/index";
import {
  chargeGroup,
  readGroup,
  refundGroup,
  resolveSummonGroup,
  SUMMON_GROUP_PREFIX,
} from "../lib/summon/group";
import { freshMarker, HOUR_MS, rollBudget } from "../lib/summon/marker";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * Smaller findings of the review of #314 on the group and the controller:
 * a refund never gives back to an entry its charge was not made in (A3), a
 * check whose group writes always lose is retried no faster than every
 * 50 ms (A4), a budget's windows roll only forward (A7), and a queue named
 * `__proto__` keeps its share like any other.
 */

const perTest: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of perTest.splice(0)) {
    await cleanup().catch(() => {});
  }
});

async function memory(
  type: "memory" | "file" = "memory",
): Promise<{ driver: JobsDriver; namespace: string }> {
  let driver: JobsDriver;
  let removeDir: (() => Promise<void>) | undefined;
  if (type === "file") {
    const dir = await makeTmpDir("bun-jobs-summon-group-fixes");
    removeDir = dir.cleanup;
    driver = createDriver({ type: "file", root: join(dir.path, "d") });
  } else {
    driver = createDriver({ type: "memory" });
  }
  await driver.connect();
  const namespace = testNamespace("summon-group-fixes");
  perTest.push(async () => {
    await driver.purge(namespace).catch(() => {});
    await driver.close();
    await removeDir?.();
  });
  return { driver, namespace };
}

describe("refundGroup and the entry's epoch (A3)", () => {
  it("gives nothing back to an entry created afresh since the charge", async () => {
    const { driver, namespace } = await memory();
    const group = resolveSummonGroup({ name: "g" })!;
    const before = await chargeGroup(driver, namespace, group, { queue: "q" });
    if (before.outcome !== "charged") {
      throw new Error(before.outcome);
    }
    // The namespace purged: the entry goes, and the next charge makes a new one.
    await driver.purge(namespace);
    const after = await chargeGroup(driver, namespace, group, { queue: "q" });
    expect(after.outcome).toBe("charged");
    // The old charge's refund belongs to an entry that is gone.
    expect(
      await refundGroup(driver, namespace, "g", {
        queue: "q",
        chargedAt: before.at,
        clears: before.clears,
        epoch: before.entry.epoch,
      }),
    ).toBe(true);
    const { entry } = await readGroup(driver, namespace, "g", Date.now());
    expect(entry.budget).toMatchObject({ hour: 1, day: 1 });
    expect(entry.queues).toEqual({ q: { day: 1, lastAt: expect.any(Number) } });
  });

  it("still gives back a charge made in the same entry (the control)", async () => {
    const { driver, namespace } = await memory();
    const group = resolveSummonGroup({ name: "g" })!;
    const charge = await chargeGroup(driver, namespace, group, { queue: "q" });
    if (charge.outcome !== "charged") {
      throw new Error(charge.outcome);
    }
    expect(
      await refundGroup(driver, namespace, "g", {
        queue: "q",
        chargedAt: charge.at,
        clears: charge.clears,
        epoch: charge.entry.epoch,
      }),
    ).toBe(true);
    const { entry } = await readGroup(driver, namespace, "g", Date.now());
    expect(entry.budget).toMatchObject({ hour: 0, day: 0 });
  });
});

describe("a contended group charge's retry (A4)", () => {
  it("runs no faster than every 50 ms with debounce 0, when every group write loses", async () => {
    // A controller needs a backend another process can reach.
    const { driver: inner, namespace } = await memory("file");
    let groupReads = 0;
    // Every write to a group entry loses its compare-and-set.
    const driver = new Proxy(inner, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key === "setQueueState") {
          return async (...args: unknown[]) =>
            String(args[1]).startsWith(SUMMON_GROUP_PREFIX)
              ? null
              : await (value as (...a: unknown[]) => Promise<unknown>).apply(
                  target,
                  args,
                );
        }
        if (key === "getQueueState") {
          return async (...args: unknown[]) => {
            if (String(args[1]).startsWith(SUMMON_GROUP_PREFIX)) {
              groupReads++;
            }
            return await (value as (...a: unknown[]) => Promise<unknown>).apply(
              target,
              args,
            );
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as JobsDriver;
    const queue = new BunQueue("q", { namespace, driver, logger: noopLogger });
    perTest.push(async () => await queue.close());
    await queue.add("a", {});
    const controller = new SummonController({
      driver,
      namespace,
      queue: "q",
      summoner: defineSummoner({
        kind: "k",
        invoke: async () => ({ status: "started", handles: [] }),
      }),
      group: { name: "g" },
      triggers: { onAdd: true, events: false, poll: false, debounce: 0 },
      cooldown: 0,
      logger: noopLogger,
    });
    perTest.push(async () => await controller.close());
    expect((await controller.check()).action).toBe("skipped");
    const first = groupReads;
    await Bun.sleep(500);
    await controller.close();
    // At most one check per 50 ms, each reading the entry once per round.
    const checks = (groupReads - first) / 8;
    expect(checks).toBeLessThanOrEqual(10);
    expect(groupReads - first).toBeLessThan(120);
  });
});

describe("rollBudget rolls only forward (A7)", () => {
  it("keeps a window another process rolled on, read by a clock a second behind", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS + HOUR_MS - 1_000;
    // A, a second ahead, rolled the counts into the next hour.
    const marker = freshMarker(now + 2_000);
    marker.budget.hour = 9;
    rollBudget(marker, now);
    expect(marker.budget.hour).toBe(9);
    expect(marker.budget.hourStart).toBe(
      Math.floor((now + 2_000) / HOUR_MS) * HOUR_MS,
    );
  });

  it("still rolls forward, and takes back a window wildly ahead (the controls)", () => {
    const now = Date.now();
    const old = freshMarker(now - HOUR_MS);
    old.budget.hour = 9;
    rollBudget(old, now);
    expect(old.budget.hour).toBe(0);
    const wild = freshMarker(now + 3 * HOUR_MS);
    wild.budget.hour = 9;
    rollBudget(wild, now);
    expect(wild.budget.hour).toBe(0);
    expect(wild.budget.hourStart).toBe(Math.floor(now / HOUR_MS) * HOUR_MS);
  });
});

describe("a member queue named __proto__", () => {
  it("keeps its share as an own key through a charge, a read and a refund", async () => {
    const { driver, namespace } = await memory();
    const group = resolveSummonGroup({ name: "g" })!;
    const first = await chargeGroup(driver, namespace, group, {
      queue: "__proto__",
    });
    expect(first.outcome).toBe("charged");
    // Read back (the entry's shares are rebuilt from storage on every read).
    let { entry } = await readGroup(driver, namespace, "g", Date.now());
    expect(Object.hasOwn(entry.queues ?? {}, "__proto__")).toBe(true);
    // A second charge counts on top of the first, not from a lost share.
    const second = await chargeGroup(driver, namespace, group, {
      queue: "__proto__",
    });
    if (second.outcome !== "charged") {
      throw new Error(second.outcome);
    }
    ({ entry } = await readGroup(driver, namespace, "g", Date.now()));
    expect(
      Object.getOwnPropertyDescriptor(entry.queues, "__proto__")?.value,
    ).toMatchObject({ day: 2 });
    await refundGroup(driver, namespace, "g", {
      queue: "__proto__",
      chargedAt: second.at,
      clears: second.clears,
      epoch: second.entry.epoch,
    });
    ({ entry } = await readGroup(driver, namespace, "g", Date.now()));
    expect(entry.budget).toMatchObject({ hour: 1, day: 1 });
    expect(
      Object.getOwnPropertyDescriptor(entry.queues, "__proto__")?.value,
    ).toMatchObject({ day: 1 });
  });
});
