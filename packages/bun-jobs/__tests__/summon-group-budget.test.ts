import type { LogEvent } from "@kingsleyweb/bun-common";
import type {
  JobsDriver,
  QueueRef,
  SummonControllerOptions,
  SummonEventPayload,
  SummonFailure,
  SummonPolicy,
  SummonRequest,
  SummonResult,
} from "../lib/index";
import type { SummonCapabilities, SummonFacet } from "../lib/provider/index";
import { join } from "node:path";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  ConfigError,
  createDriver,
  defineSummoner,
  SummonController,
} from "../lib/index";
import { defineComputeProvider, toStandardSchema } from "../lib/provider/index";
import { setReservedState } from "../lib/queue/windows";
import { SUMMON_ARGS } from "../lib/summon/args";
import {
  chargeGroup,
  readGroup,
  readGroupEntry,
  refundGroup,
  resetGroup,
  resolveSummonGroup,
  SUMMON_GROUP_PREFIX,
  summonGroupRef,
  summonGroupStateName,
} from "../lib/summon/group";
import {
  attemptId,
  DAY_MS,
  freshMarker,
  HOUR_MS,
  SUMMON_MARKER,
} from "../lib/summon/marker";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * `SummonPolicy.group` with a budget (plan summon-multi-queue §3, PR-A1): one
 * cost ceiling for several queues, charged before each queue's claim and
 * refunded when the claim is lost or the provider never called.
 *
 * One file backend, several controllers in this process: what is shared is
 * the backend's state, which the race test (`summon-group-race.test.ts`)
 * puts under real processes on every cross-process backend.
 */

const dir = await makeTmpDir("bun-jobs-summon-group-budget");
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

/** What a test's setup gives it. */
interface Setup {
  driver: JobsDriver;
  namespace: string;
  /** Adds one waiting job to each named queue. */
  seed: (...queues: string[]) => Promise<void>;
  /** A controller on `queue`, built on `on` (default: the setup's driver). */
  controller: (
    queue: string,
    policy: Partial<SummonControllerOptions> & Pick<SummonPolicy, "summoner">,
    on?: JobsDriver,
  ) => { controller: SummonController; events: SummonEventPayload[] };
  /** The group's entry, as stored. */
  entry: (group: string) => Promise<Record<string, unknown> | undefined>;
}

/** A fresh file driver on a fresh root. */
async function setup(): Promise<Setup> {
  const root = join(dir.path, `root-${++unique}`);
  const driver = createDriver({ type: "file", root });
  await driver.connect();
  const namespace = testNamespace("summon-group-budget");
  const owned: SummonController[] = [];
  perTest.push(async () => {
    await Promise.allSettled(owned.map(async (one) => await one.close()));
    await driver.purge(namespace).catch(() => {});
    await driver.close();
  });
  return {
    driver,
    namespace,
    seed: async (...queues) => {
      for (const name of queues) {
        const queue = new BunQueue(name, {
          namespace,
          driver,
          logger: noopLogger,
        });
        await queue.add("a", {});
        await queue.close();
      }
    },
    controller: (queue, policy, on = driver) => {
      const controller = new SummonController({
        ...QUIET,
        ...policy,
        driver: on,
        namespace,
        queue,
      });
      const events: SummonEventPayload[] = [];
      controller.on("summon", (event) => events.push(event));
      owned.push(controller);
      return { controller, events };
    },
    entry: async (group) =>
      (
        await driver.getQueueState!(
          summonGroupRef(namespace),
          summonGroupStateName(group),
        )
      )?.value as Record<string, unknown> | undefined,
  };
}

/** A summoner that records each request and answers with `answer` (default: started). */
function recorder(
  answer?: (request: SummonRequest) => Promise<SummonResult | void>,
) {
  const calls: SummonRequest[] = [];
  const summoner = defineSummoner({
    kind: "rec",
    invoke: async (request) => {
      calls.push(request);
      return await answer?.(request);
    },
  });
  return { calls, summoner };
}

/** A hook that records what it is told. */
function recording() {
  const failures: SummonFailure[] = [];
  return {
    failures,
    onSummonFailed: (failure: SummonFailure): void => {
      failures.push(failure);
    },
  };
}

/**
 * `driver` with its `setQueueState` replaced: `write` decides, per call,
 * whether it goes through (`"pass"`), is lost as if another writer won
 * (`"lose"`, answering `null` and writing nothing).
 */
function intercepting(
  driver: JobsDriver,
  write: (q: QueueRef, name: string, value: unknown) => "pass" | "lose",
): JobsDriver {
  return new Proxy(driver, {
    get(target, property) {
      if (property === "setQueueState") {
        return async (
          q: QueueRef,
          name: string,
          value: unknown,
          expected: number | null,
          options?: { internal?: symbol },
        ) =>
          write(q, name, value) === "lose"
            ? null
            : await target.setQueueState!(q, name, value, expected, options);
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Whether a write is to a summon group's entry. */
function isGroupWrite(name: string): boolean {
  return name.startsWith(SUMMON_GROUP_PREFIX);
}

describe("the group option", () => {
  it("refuses a group that is not { name, budget? }, naming the field", async () => {
    const { controller } = await setup();
    const { summoner } = recorder();
    const cases: [unknown, RegExp][] = [
      ["media", /group must be \{ name, budget\? \}/],
      [{}, /group\.name is required/],
      [{ name: "a b" }, /group\.name may only contain/],
      [{ name: "__bunjobs" }, /group\.name may not be "__bunjobs"/],
      [{ name: "g", budget: "none" }, /group\.budget must be false/],
      [{ name: "g", budget: { perHour: 0 } }, /group\.budget\.perHour/],
      [{ name: "g", budget: { perDay: 1.5 } }, /group\.budget\.perDay/],
    ];
    for (const [group, message] of cases) {
      expect(() =>
        controller("work", {
          summoner,
          group: group as SummonPolicy["group"],
        }),
      ).toThrow(message);
    }
    expect(() =>
      controller("work", { summoner, group: { name: "g", budget: false } }),
    ).not.toThrow();
  });

  it("refuses the reserved pseudo-queue as a queue, everywhere one is built", async () => {
    const { driver, namespace } = await setup();
    const { summoner } = recorder();
    expect(
      () =>
        new BunQueue("__bunjobs", { namespace, driver, logger: noopLogger }),
    ).toThrow(ConfigError);
    expect(
      () =>
        new BunQueueWorker("__bunjobs", async () => {}, {
          namespace,
          driver,
          logger: noopLogger,
        }),
    ).toThrow(/reserves that name/);
    expect(
      () =>
        new SummonController({
          ...QUIET,
          driver,
          namespace,
          queue: "__bunjobs",
          summoner,
        }),
    ).toThrow(ConfigError);
  });
});

describe("one budget for several queues", () => {
  it("summons no more than the group's limit across its queues, each event naming the group", async () => {
    const { seed, controller, entry, namespace } = await setup();
    const queues = ["q1", "q2", "q3", "q4", "q5"];
    await seed(...queues);
    const { calls, summoner } = recorder();
    const hook = recording();
    const group = { name: "media", budget: { perHour: 3, perDay: 10 } };
    const built = queues.map((queue) =>
      controller(queue, { summoner, group, ...hook }),
    );

    const results = [];
    for (const { controller: one } of built) {
      results.push(await one.check());
    }
    expect(results.map((result) => result.action)).toEqual([
      "summoned",
      "summoned",
      "summoned",
      "skipped",
      "skipped",
    ]);
    expect(results.slice(3)).toMatchObject([
      { reason: "budget" },
      { reason: "budget" },
    ]);
    expect(calls).toHaveLength(3);
    // The group's counts, the limits it was charged under, each queue's share.
    expect(await entry("media")).toMatchObject({
      v: 1,
      budget: { hour: 3, day: 3 },
      limits: { perHour: 3, perDay: 10 },
      queues: {
        q1: { day: 1, lastAt: expect.any(Number) },
        q2: { day: 1 },
        q3: { day: 1 },
      },
    });

    // Every attempt's events name the group.
    for (const { events } of built.slice(0, 3)) {
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.group).toBe("media");
      }
    }
    // The group's budget-exhausted: once per controller per window, naming
    // the group, and onSummonFailed with the group's usage and limits.
    expect(built[3]!.events).toEqual([
      {
        id: "",
        outcome: "budget-exhausted",
        kind: "rec",
        group: "media",
      },
    ]);
    // `onSummonFailed` is called on a later turn (`setImmediate`): one more
    // turn queued now runs after q5's, so its call is in.
    await new Promise((resolve) => setImmediate(resolve));
    expect(hook.failures).toHaveLength(2);
    expect(hook.failures[0]).toEqual({
      outcome: "budget-exhausted",
      kind: "rec",
      namespace,
      queue: "q4",
      group: "media",
      at: expect.any(Number),
      budget: { hour: 3, perHour: 3, day: 3, perDay: 10 },
    });
    await built[3]!.controller.check();
    expect(built[3]!.events).toHaveLength(1);

    // Status shows the group, and the queues' own budgets as off (A5).
    const status = await built[0]!.controller.status();
    expect(status.group).toEqual({
      name: "media",
      budget: {
        hour: 3,
        perHour: 3,
        day: 3,
        perDay: 10,
        hourResetsAt: expect.any(Number),
        dayResetsAt: expect.any(Number),
      },
      queues: {
        q1: { day: 1, lastAt: expect.any(Number) },
        q2: { day: 1, lastAt: expect.any(Number) },
        q3: { day: 1, lastAt: expect.any(Number) },
      },
    });
    expect(status.group!.budget.hourResetsAt % HOUR_MS).toBe(0);
    expect(status.group!.budget.dayResetsAt % DAY_MS).toBe(0);
    expect(status.budget).toMatchObject({ hour: 1, day: 1, off: true });
    expect(status.budget!.perHour).toBeUndefined();
  });

  it("lets a queue in two groups be charged to each (it summons only when both allow)", async () => {
    const { seed, controller, entry } = await setup();
    await seed("a", "b");
    const { calls, summoner } = recorder();
    const team = { name: "team", budget: { perHour: 5 } };
    controller("a", { summoner, group: team });
    // `b` in the same team group, checked once: one more of the team's five.
    const b = controller("b", { summoner, group: team }).controller;
    expect(await b.check()).toMatchObject({ action: "summoned" });
    // A second controller on `b` in another group sees `b`'s attempt on its
    // way and claims nothing, so it charges nothing either.
    const org = controller("b", {
      summoner,
      group: { name: "org", budget: { perHour: 1 } },
    }).controller;
    expect(await org.check()).toMatchObject({
      action: "skipped",
      reason: "pending",
    });
    expect(calls).toHaveLength(1);
    expect(await entry("team")).toMatchObject({ budget: { hour: 1 } });
    expect(await entry("org")).toBeUndefined();
  });

  it("is shared by name across BunJobs groups and records, with nothing duplicated", async () => {
    const root = join(dir.path, `root-${++unique}`);
    const driver = createDriver({ type: "file", root });
    const namespace = testNamespace("summon-group-jobs");
    const { calls, summoner } = recorder();
    const jobs = new BunJobs({
      driver,
      namespace,
      logger: noopLogger,
      summon: [
        {
          queues: ["renders", "thumbs"],
          summoner,
          ...QUIET,
          group: { name: "media", budget: { perHour: 2 } },
        },
        // A record naming the same group shares its budget.
        {
          previews: {
            summoner,
            ...QUIET,
            group: { name: "media", budget: { perHour: 2 } },
          },
        },
      ],
    });
    perTest.push(async () => {
      await jobs.close();
      await driver.purge(namespace).catch(() => {});
      await driver.close();
    });
    for (const queue of ["renders", "thumbs", "previews"]) {
      await jobs.queue(queue).add("a", {});
    }
    const results = [];
    for (const queue of ["renders", "thumbs", "previews"]) {
      results.push(await jobs.summonController(queue).check());
    }
    expect(results.map((result) => result.action)).toEqual([
      "summoned",
      "summoned",
      "skipped",
    ]);
    expect(calls.map((call) => call.queue)).toEqual(["renders", "thumbs"]);
    expect(
      (await jobs.summonController("previews").status()).group,
    ).toMatchObject({ name: "media", budget: { hour: 2, perHour: 2 } });
  });
});

describe("the per-queue budget under a group (A5)", () => {
  it("is off unless set: a queue's own counts past the default limit still summon", async () => {
    const { seed, controller, driver, namespace } = await setup();
    await seed("work");
    const { calls, summoner } = recorder();
    const { controller: one } = controller("work", {
      summoner,
      group: { name: "g", budget: { perHour: 100 } },
    });
    // The queue's own counts at the default ceiling (30 an hour).
    const marker = freshMarker(Date.now());
    marker.budget.hour = 30;
    marker.budget.day = 30;
    await setReservedState(
      driver,
      { ns: namespace, queue: "work" },
      SUMMON_MARKER,
      marker,
      null,
    );
    expect(await one.check()).toMatchObject({ action: "summoned" });
    expect(calls).toHaveLength(1);
    expect((await one.status()).budget).toMatchObject({ hour: 31, off: true });
  });

  it("applies when set explicitly, on top of the group's, and refuses before charging the group", async () => {
    const { seed, controller, entry } = await setup();
    await seed("work");
    const { calls, summoner } = recorder(async () => ({
      status: "unavailable",
      reason: "busy",
    }));
    const { controller: one } = controller("work", {
      summoner,
      budget: { perHour: 1 },
      group: { name: "g", budget: { perHour: 100 } },
    });
    expect(await one.check()).toMatchObject({ action: "summoned" });
    // Past the 1 ms backoff the `unavailable` set, so the budget is the
    // gate that answers (backoff is checked first).
    await Bun.sleep(5);
    expect(await one.check()).toMatchObject({
      action: "skipped",
      reason: "budget",
    });
    expect(calls).toHaveLength(1);
    expect(await entry("g")).toMatchObject({ budget: { hour: 1 } });
    expect((await one.status()).budget).toMatchObject({ hour: 1, perHour: 1 });
  });

  it("stays on with group.budget false, whose counts are still kept", async () => {
    const { seed, controller, entry } = await setup();
    await seed("work");
    const { summoner } = recorder();
    const { controller: one } = controller("work", {
      summoner,
      group: { name: "g", budget: false },
    });
    expect(await one.check()).toMatchObject({ action: "summoned" });
    const status = await one.status();
    expect(status.budget).toMatchObject({ perHour: 30, perDay: 300 });
    expect(status.budget!.off).toBeUndefined();
    expect(status.group!.budget).toMatchObject({ hour: 1, day: 1, off: true });
    expect(status.group!.budget.perHour).toBeUndefined();
    const stored = await entry("g");
    expect(stored).toMatchObject({ budget: { hour: 1 } });
    expect(stored!.limits).toBeUndefined();
  });
});

describe("charge, then claim, then refund (§3.5)", () => {
  it("gives the charge back when the queue's claim is lost", async () => {
    const { seed, controller, driver, entry } = await setup();
    await seed("work");
    const { calls, summoner } = recorder();
    let loseClaim = true;
    const flaky = intercepting(driver, (_q, name) => {
      if (name === SUMMON_MARKER && loseClaim) {
        loseClaim = false;
        return "lose";
      }
      return "pass";
    });
    const { controller: one } = controller(
      "work",
      { summoner, group: { name: "g", budget: { perHour: 5 } } },
      flaky,
    );
    expect(await one.check()).toMatchObject({
      action: "skipped",
      reason: "contended",
    });
    expect(calls).toHaveLength(0);
    // Charged, then refunded: nothing counted for an attempt never made.
    expect(await entry("g")).toMatchObject({
      budget: { hour: 0, day: 0 },
      queues: { work: { day: 0 } },
    });
    expect(await one.check()).toMatchObject({ action: "summoned" });
    expect(await entry("g")).toMatchObject({ budget: { hour: 1, day: 1 } });
  });

  it("fails closed: a lost claim whose refund is lost too over-counts, and never overspends", async () => {
    const { seed, controller, driver, entry } = await setup();
    await seed("work");
    const { calls, summoner } = recorder();
    let groupWrites = 0;
    let loseClaim = true;
    const broken = intercepting(driver, (_q, name) => {
      if (name === SUMMON_MARKER && loseClaim) {
        loseClaim = false;
        return "lose";
      }
      // The charge lands; every refund after it is lost.
      if (isGroupWrite(name) && ++groupWrites > 1) {
        return "lose";
      }
      return "pass";
    });
    const { controller: one } = controller(
      "work",
      { summoner, group: { name: "g", budget: { perHour: 1 } } },
      broken,
    );
    expect(await one.check()).toMatchObject({ reason: "contended" });
    // Over-counted by the one attempt that never happened...
    expect(await entry("g")).toMatchObject({ budget: { hour: 1 } });
    // ...so the group's one attempt is spent, and nothing is called.
    expect(await one.check()).toMatchObject({
      action: "skipped",
      reason: "budget",
    });
    expect(calls).toHaveLength(0);
  });

  it("claims nothing when the charge loses every round, and runs again a debounce later", async () => {
    const { seed, controller, driver, entry, namespace } = await setup();
    await seed("work");
    const { calls, summoner } = recorder();
    let charges = 0;
    let contend = true;
    const busy = intercepting(driver, (_q, name) => {
      if (isGroupWrite(name)) {
        charges++;
        return contend ? "lose" : "pass";
      }
      return "pass";
    });
    const { controller: one } = controller(
      "work",
      {
        summoner,
        group: { name: "g" },
        // A poll far away, so only the contended retry can run a check soon.
        triggers: { onAdd: false, events: false, poll: 600_000, debounce: 20 },
      },
      busy,
    );
    expect(await one.check()).toMatchObject({
      action: "skipped",
      reason: "contended",
    });
    expect(charges).toBe(8);
    // No claim was made: the queue's marker holds no attempt.
    const marker = await driver.getQueueState!(
      { ns: namespace, queue: "work" },
      SUMMON_MARKER,
    );
    expect(
      (marker?.value as { pending?: unknown[] } | undefined)?.pending ?? [],
    ).toHaveLength(0);
    expect(await entry("g")).toBeUndefined();

    // The retry: within about two debounces, not a poll.
    contend = false;
    const deadline = Date.now() + 2_000;
    while (calls.length === 0 && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(calls).toHaveLength(1);
  });

  it("gives the charge back when the provider was never called", async () => {
    const { seed, controller, entry } = await setup();
    await seed("work");
    const capabilities: SummonCapabilities = {
      style: "launch",
      dedupe: { kind: "none" },
      passes: "argv",
      bootBudgetMs: 20_000,
      shutdown: { signal: "SIGTERM", graceMs: 10_000 },
      maxLifetimeMs: null,
      enforcesLifetime: false,
    };
    const provider = defineComputeProvider({
      name: `test-group-refund-${++unique}`,
      version: "1.0.0",
      kind: "async",
      apiVersion: { core: "0.1", summon: "0.1" },
      config: toStandardSchema<{ region: string }>(async () => {
        await Bun.sleep(5);
        return { issues: [{ message: "unreachable", path: ["region"] }] };
      }),
      summon: (): SummonFacet => ({
        capabilities,
        summon: async (): Promise<SummonResult> => ({
          status: "started",
          handles: [],
        }),
      }),
    });
    const { controller: one } = controller("work", {
      summoner: provider({ region: "eu" }),
      circuit: { failures: 100 },
      group: { name: "g" },
    });
    expect(await one.check()).toMatchObject({
      action: "summoned",
      outcome: "failed",
    });
    expect(await entry("g")).toMatchObject({
      budget: { hour: 0, day: 0 },
      queues: { work: { day: 0 } },
    });
  });
});

describe("refund after a reset", () => {
  it("never gives back a charge a reset already cleared", async () => {
    const { driver, namespace, entry } = await setup();
    const group = resolveSummonGroup({
      name: "g",
      budget: { perHour: 2, perDay: 10 },
    })!;
    const first = await chargeGroup(driver, namespace, group, { queue: "a" });
    expect(first.outcome).toBe("charged");
    // An operator clears the group's counts while that charge is in flight…
    expect(await resetGroup(driver, namespace, "g", { budget: true })).toBe(
      true,
    );
    // …and another queue is charged after the reset.
    const second = await chargeGroup(driver, namespace, group, {
      queue: "b",
    });
    expect(second.outcome).toBe("charged");
    // The first charge's claim is lost: its refund must not take the
    // second's count away, or the group could summon past its limit.
    if (first.outcome !== "charged") {
      throw new Error("unreachable");
    }
    expect(
      await refundGroup(driver, namespace, "g", {
        queue: "a",
        hourStart: first.hourStart,
        dayStart: first.dayStart,
        clears: first.clears,
      }),
    ).toBe(true);
    expect(await entry("g")).toMatchObject({
      budget: { hour: 1, day: 1, clears: 1 },
      queues: { b: { day: 1 } },
    });
    // A charge made since the reset is still given back.
    if (second.outcome !== "charged") {
      throw new Error("unreachable");
    }
    await refundGroup(driver, namespace, "g", {
      queue: "b",
      hourStart: second.hourStart,
      dayStart: second.dayStart,
      clears: second.clears,
    });
    expect(await entry("g")).toMatchObject({ budget: { hour: 0, day: 0 } });
  });
});

describe("the group's entry", () => {
  it("is replaced, with a warn, when it is garbage; left alone when a newer bun-jobs wrote it", async () => {
    const { seed, controller, driver, namespace, entry } = await setup();
    await seed("work");
    const { calls, summoner } = recorder();
    const { logger, events: logs } = createTestLogger();
    const ref = summonGroupRef(namespace);
    const name = summonGroupStateName("g");

    await setReservedState(driver, ref, name, { garbage: true }, null);
    const { controller: one } = controller("work", {
      summoner,
      logger,
      group: { name: "g" },
    });
    expect(await one.check()).toMatchObject({ action: "summoned" });
    expect(await entry("g")).toMatchObject({ v: 1, budget: { hour: 1 } });
    expect(warns(logs, "unreadable")).toHaveLength(1);

    // A newer shape: nothing summoned for the group, the entry untouched.
    const current = await driver.getQueueState!(ref, name);
    await setReservedState(driver, ref, name, { v: 2 }, current!.version);
    await seed("other");
    const { controller: two } = controller("other", {
      summoner,
      logger,
      group: { name: "g" },
    });
    expect(await two.check()).toMatchObject({
      action: "skipped",
      reason: "budget",
    });
    expect(await two.check()).toMatchObject({ reason: "budget" });
    expect(await entry("g")).toEqual({ v: 2 });
    expect(calls).toHaveLength(1);
    expect(warns(logs, "newer bun-jobs").length).toBeGreaterThanOrEqual(1);
  });

  it("rolls its windows, and empties the queues' shares with the day", () => {
    const now = Date.UTC(2026, 9, 6, 12, 30);
    const yesterday = now - DAY_MS;
    const stored = {
      v: 1,
      epoch: "e",
      budget: {
        hourStart: Math.floor(yesterday / HOUR_MS) * HOUR_MS,
        hour: 4,
        dayStart: Math.floor(yesterday / DAY_MS) * DAY_MS,
        day: 9,
      },
      limits: { perHour: 5, perDay: 50 },
      queues: { a: { day: 9, lastAt: yesterday }, bad: { day: "x" } },
    };
    const read = readGroupEntry({ value: stored, version: 3 }, now);
    expect(read.entry.budget).toEqual({
      hourStart: Math.floor(now / HOUR_MS) * HOUR_MS,
      hour: 0,
      dayStart: Math.floor(now / DAY_MS) * DAY_MS,
      day: 0,
    });
    expect(read.entry.queues).toBeUndefined();
    expect(read.entry.limits).toEqual({ perHour: 5, perDay: 50 });

    // Same day: the shares stay, minus the malformed one; a bad `limits` goes.
    const today = readGroupEntry(
      {
        value: {
          ...stored,
          budget: {
            ...stored.budget,
            dayStart: Math.floor(now / DAY_MS) * DAY_MS,
          },
          limits: { perHour: "five" },
        },
        version: 3,
      },
      now,
    );
    expect(today.entry.queues).toEqual({ a: { day: 9, lastAt: yesterday } });
    expect(today.entry.limits).toBeUndefined();
    expect(today.unreadable).toBe(false);
  });
});

describe("reset", () => {
  it("clears the group's counts only with { group: true, budget: true }", async () => {
    const { seed, controller, driver, namespace } = await setup();
    await seed("a", "b");
    const { summoner } = recorder();
    const group = { name: "g", budget: { perHour: 2 } };
    const a = controller("a", { summoner, group }).controller;
    const b = controller("b", { summoner, group }).controller;
    await a.check();
    await b.check();
    const hour = async () =>
      (await readGroup(driver, namespace, "g", Date.now())).entry.budget.hour;
    expect(await hour()).toBe(2);

    await a.reset({ budget: true });
    expect(await hour()).toBe(2);
    await a.reset({ group: true });
    expect(await hour()).toBe(2);
    await a.reset({ group: true, budget: true });
    expect(await hour()).toBe(0);
    const status = await b.status();
    expect(status.group!.queues).toEqual({});
    // The queue's own counts went with the first reset, `b`'s stay.
    expect((await a.status()).budget).toMatchObject({ hour: 0 });
    expect(status.budget).toMatchObject({ hour: 1 });
  });

  it("emits the group's budget-exhausted again in the same window once cleared", async () => {
    const { seed, controller } = await setup();
    await seed("a", "b");
    const { summoner } = recorder(async () => ({
      status: "unavailable",
      reason: "busy",
    }));
    const group = { name: "g", budget: { perHour: 1 } };
    const a = controller("a", { summoner, group });
    const b = controller("b", { summoner, group });
    await a.controller.check();
    await b.controller.check();
    await b.controller.reset({ group: true, budget: true });
    // Past `a`'s 1 ms backoff from its `unavailable`.
    await Bun.sleep(5);
    await a.controller.check();
    await b.controller.check();
    expect(
      b.events.filter((event) => event.outcome === "budget-exhausted"),
    ).toHaveLength(2);
  });
});

describe("a single queue is unchanged (back-compat)", () => {
  it("gives a grouped attempt the same id and argv as an ungrouped one", async () => {
    const { seed, controller, driver, namespace } = await setup();
    await seed("plain", "grouped");
    const { calls, summoner } = recorder();
    const plain = controller("plain", { summoner }).controller;
    const grouped = controller("grouped", {
      summoner,
      group: { name: "g" },
    }).controller;
    await plain.check();
    await grouped.check();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const marker = (await driver.getQueueState!(
        { ns: namespace, queue: call.queue },
        SUMMON_MARKER,
      ))!;
      // A first claim writes version 1, which the id hashes, as before.
      expect(call.id).toBe(
        attemptId(
          namespace,
          call.queue,
          (marker.value as { epoch: string }).epoch,
          1,
        ),
      );
    }
    const strip = (request: SummonRequest) =>
      request.argv.filter(
        (arg) =>
          !arg.startsWith(`${SUMMON_ARGS.id}=`) &&
          !arg.startsWith(`${SUMMON_ARGS.queue}=`),
      );
    expect(strip(calls[1]!)).toEqual(strip(calls[0]!));
    expect(
      calls[1]!.argv.some((arg) => arg.startsWith("--bun-jobs-summon-group")),
    ).toBe(false);
    expect(Object.keys(calls[1]!).sort()).toEqual(
      Object.keys(calls[0]!).sort(),
    );
  });
});

/** The warns whose message contains `text`. */
function warns(events: readonly LogEvent[], text: string): LogEvent[] {
  return events.filter(
    (event) => event.level === "warn" && event.message.includes(text),
  );
}
