import type { LogEvent } from "@kingsleyweb/bun-common";
import type {
  JobsDriver,
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
  ConfigError,
  createDriver,
  defineSummoner,
  SummonController,
} from "../lib/index";
import { defineComputeProvider, toStandardSchema } from "../lib/provider/index";
import { freshMarker, refundBudget, SUMMON_MARKER } from "../lib/summon/marker";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * `SummonPolicy.onSummonFailed`, `budget: false`, `reset({ budget: true })`
 * and the budget refund for an attempt whose provider was never called.
 *
 * One file backend is enough: none of it depends on the driver. The
 * two-controller cases use two driver instances on one directory, as two
 * processes would.
 */

const dir = await makeTmpDir("bun-jobs-summon-failed-budget");
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

const HOUR = 3_600_000;
const DAY = 86_400_000;

let unique = 0;

/** A fresh driver on a fresh root, and a queue `work` on it. */
async function setup(): Promise<{
  root: string;
  driver: JobsDriver;
  namespace: string;
  queue: BunQueue<unknown>;
  /** Another driver instance on the same root: a second process's view. */
  another: () => Promise<JobsDriver>;
  controller: (
    policy: Partial<SummonControllerOptions> & Pick<SummonPolicy, "summoner">,
    on?: JobsDriver,
  ) => { controller: SummonController; events: SummonEventPayload[] };
}> {
  const root = join(dir.path, `root-${++unique}`);
  const drivers: JobsDriver[] = [];
  const open = async (): Promise<JobsDriver> => {
    const one = createDriver({ type: "file", root });
    await one.connect();
    drivers.push(one);
    return one;
  };
  const driver = await open();
  const namespace = testNamespace("summon-failed-budget");
  const queue = new BunQueue("work", { namespace, driver, logger: noopLogger });
  const owned: SummonController[] = [];
  perTest.push(async () => {
    await Promise.allSettled(owned.map(async (one) => await one.close()));
    await queue.close().catch(() => {});
    await driver.purge(namespace).catch(() => {});
    await Promise.allSettled(drivers.map(async (one) => await one.close()));
  });
  return {
    root,
    driver,
    namespace,
    queue,
    another: open,
    controller: (policy, on = driver) => {
      const controller = new SummonController({
        ...QUIET,
        ...policy,
        driver: on,
        namespace,
        queue: "work",
      });
      const events: SummonEventPayload[] = [];
      controller.on("summon", (event) => events.push(event));
      owned.push(controller);
      return { controller, events };
    },
  };
}

/** A summoner that records each request and answers with `answer` (default: started). */
function recorder(
  answer?: (request: SummonRequest, n: number) => Promise<SummonResult | void>,
  bootBudget = 20_000,
) {
  const calls: SummonRequest[] = [];
  const summoner = defineSummoner({
    kind: "rec",
    bootBudget,
    invoke: async (request) => {
      calls.push(request);
      return await answer?.(request, calls.length);
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

/** The warns a test logger collected about the hook. */
function hookWarns(events: readonly LogEvent[]): LogEvent[] {
  return events.filter(
    (event) =>
      event.level === "warn" && event.message.includes("onSummonFailed"),
  );
}

describe("onSummonFailed", () => {
  it("is told of a failed call, with the event's id, reason and detail, and nothing secret", async () => {
    const { queue, namespace, controller } = await setup();
    const { summoner } = recorder(async () => {
      throw Object.assign(new Error("token=sk_live_secret refused"), {
        code: "E_REFUSED",
      });
    });
    const hook = recording();
    const { controller: summon, events } = controller({ summoner, ...hook });
    await queue.add("a", {});

    const before = Date.now();
    const result = await summon.check();
    expect(result).toMatchObject({ action: "summoned", outcome: "failed" });
    expect(hook.failures).toEqual([
      {
        outcome: "failed",
        kind: "rec",
        namespace,
        queue: "work",
        id: (result as { id: string }).id,
        reason: "manual",
        detail: "E_REFUSED",
        at: expect.any(Number),
      },
    ]);
    expect(hook.failures[0]!.at).toBeGreaterThanOrEqual(before);
    // The same detail the event and the marker carry; the message never.
    expect(events.at(-1)!.detail).toBe("E_REFUSED");
    expect((await summon.status()).last?.detail).toBe("E_REFUSED");
    expect(JSON.stringify(hook.failures)).not.toContain("sk_live");
  });

  it("is told of an unavailable platform, with its reason as the detail", async () => {
    const { queue, controller } = await setup();
    const { summoner } = recorder(async () => ({
      status: "unavailable",
      reason: "no capacity",
    }));
    const hook = recording();
    const { controller: summon } = controller({ summoner, ...hook });
    await queue.add("a", {});
    await summon.check();
    expect(hook.failures).toMatchObject([
      { outcome: "unavailable", detail: "no capacity", reason: "manual" },
    ]);
  });

  it("is told of a lost attempt once, when the check that declares it lost writes", async () => {
    const { queue, controller } = await setup();
    const { calls, summoner } = recorder(undefined, 40);
    const hook = recording();
    const { controller: summon } = controller({
      summoner,
      ...hook,
      circuit: { failures: 100 },
    });
    await queue.add("a", {});
    expect(await summon.check()).toMatchObject({ outcome: "started" });
    expect(hook.failures).toEqual([]);
    await Bun.sleep(60);
    await summon.check();
    expect(hook.failures).toMatchObject([
      { outcome: "lost", id: calls[0]!.id },
    ]);
    // A lost event carries no reason, so neither does the hook's argument.
    expect(hook.failures[0]).not.toHaveProperty("reason");
  });

  it("is told of an exhausted budget once per window, with the usage and the limits", async () => {
    const { queue, namespace, controller } = await setup();
    const { summoner } = recorder(async () => ({
      status: "unavailable",
      reason: "busy",
    }));
    const hook = recording();
    const { controller: summon } = controller({
      summoner,
      ...hook,
      budget: { perHour: 2, perDay: 50 },
      circuit: { failures: 100 },
    });
    await queue.add("a", {});
    await summon.check();
    await Bun.sleep(3);
    await summon.check();
    await Bun.sleep(3);
    expect(await summon.check()).toMatchObject({ reason: "budget" });
    expect(await summon.check()).toMatchObject({ reason: "budget" });
    const exhausted = hook.failures.filter(
      (failure) => failure.outcome === "budget-exhausted",
    );
    expect(exhausted).toEqual([
      {
        outcome: "budget-exhausted",
        kind: "rec",
        namespace,
        queue: "work",
        at: expect.any(Number),
        budget: { hour: 2, perHour: 2, day: 2, perDay: 50 },
      },
    ]);
  });

  it("is told once when the circuit opens, not on the checks it then refuses, and again after a reset", async () => {
    const { queue, controller } = await setup();
    const { calls, summoner } = recorder(async () => {
      throw new Error("down");
    });
    const hook = recording();
    const { controller: summon } = controller({
      summoner,
      ...hook,
      circuit: { failures: 2, resetAfter: 60_000 },
    });
    await queue.add("a", {});
    await summon.check();
    await Bun.sleep(3);
    await summon.check();
    for (let i = 0; i < 3; i++) {
      expect(await summon.check()).toMatchObject({ reason: "circuit-open" });
    }
    const status = await summon.status();
    expect(hook.failures.map((failure) => failure.outcome)).toEqual([
      "failed",
      "failed",
      "circuit-open",
    ]);
    expect(hook.failures[2]).toMatchObject({
      outcome: "circuit-open",
      id: calls[1]!.id,
      detail: "Error",
      until: status.circuitOpenUntil,
    });

    await summon.reset();
    await summon.check();
    await Bun.sleep(3);
    await summon.check();
    expect(
      hook.failures.filter((failure) => failure.outcome === "circuit-open"),
    ).toHaveLength(2);
  });

  it("is told when a lost attempt opens the circuit, by the check that wrote it", async () => {
    const { queue, controller } = await setup();
    const { calls, summoner } = recorder(undefined, 40);
    const hook = recording();
    const { controller: summon } = controller({
      summoner,
      ...hook,
      circuit: { failures: 1, resetAfter: 60_000 },
    });
    await queue.add("a", {});
    await summon.check();
    await Bun.sleep(60);
    expect(await summon.check()).toMatchObject({ reason: "circuit-open" });
    expect(await summon.check()).toMatchObject({ reason: "circuit-open" });
    expect(hook.failures).toMatchObject([
      { outcome: "lost", id: calls[0]!.id },
      {
        outcome: "circuit-open",
        id: calls[0]!.id,
        until: (await summon.status()).circuitOpenUntil,
      },
    ]);
    expect(hook.failures).toHaveLength(2);
  });

  it("is not told again when a failure extends a circuit already open", async () => {
    const { queue, controller } = await setup();
    // The first attempt starts and never registers; the second throws and
    // opens the circuit; the first is then lost while it is open.
    const { summoner } = recorder(async (_request, n) => {
      if (n > 1) {
        throw new Error("down");
      }
    }, 150);
    const hook = recording();
    const { controller: summon } = controller({
      summoner,
      ...hook,
      maxWorkers: 2,
      jobsPerWorker: 1,
      circuit: { failures: 1, resetAfter: 60_000 },
    });
    await queue.add("a", {});
    expect(await summon.check()).toMatchObject({ outcome: "started" });
    await queue.add("b", {});
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    const opened = (await summon.status()).circuitOpenUntil!;
    await Bun.sleep(170);
    expect(await summon.check()).toMatchObject({ reason: "circuit-open" });
    // The loss pushed the circuit's end on: an extension, not an opening.
    expect((await summon.status()).circuitOpenUntil).toBeGreaterThan(opened);
    expect(hook.failures.map((failure) => failure.outcome)).toEqual([
      "failed",
      "circuit-open",
      "lost",
    ]);
  });

  it("fires once per outcome across two controllers on one queue, where each emits it", async () => {
    const { queue, controller, another } = await setup();
    // The first call throws; every later one starts a unit that never
    // registers, so each is lost in turn, until the circuit opens.
    const { summoner } = recorder(async (_request, n) => {
      if (n === 1) {
        throw new Error("down");
      }
    }, 30);
    const told: { by: "a" | "b"; failure: SummonFailure }[] = [];
    const policy = {
      summoner,
      circuit: { failures: 3, resetAfter: 60_000 },
    };
    const a = controller({
      ...policy,
      onSummonFailed: (failure) => {
        told.push({ by: "a", failure });
      },
    });
    const b = controller(
      {
        ...policy,
        onSummonFailed: (failure) => {
          told.push({ by: "b", failure });
        },
      },
      await another(),
    );
    await queue.add("a", {});

    await waitFor(
      async () => {
        await Promise.all([a.controller.check(), b.controller.check()]);
        await Bun.sleep(35);
        return told.some((one) => one.failure.outcome === "circuit-open");
      },
      { timeout: 10_000 },
    );
    // A few more rounds against the open circuit change nothing.
    for (let i = 0; i < 3; i++) {
      await Promise.all([a.controller.check(), b.controller.check()]);
    }

    const keys = told.map(
      ({ failure }) => `${failure.outcome}:${failure.id ?? ""}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((key) => key.startsWith("circuit-open"))).toHaveLength(
      1,
    );
    expect(keys.filter((key) => key.startsWith("failed"))).toHaveLength(1);
    expect(keys.filter((key) => key.startsWith("lost"))).toHaveLength(2);
    // Each controller was told exactly what it emitted.
    for (const [name, one] of [
      ["a", a],
      ["b", b],
    ] as const) {
      expect(
        told
          .filter(
            ({ by, failure }) =>
              by === name && failure.outcome !== "circuit-open",
          )
          .map(({ failure }) => `${failure.outcome}:${failure.id}`),
      ).toEqual(
        one.events
          .filter((event) => ["failed", "lost"].includes(event.outcome))
          .map((event) => `${event.outcome}:${event.id}`),
      );
    }
  });

  it("logs a throw and a rejection once each, at warn, and the check goes on", async () => {
    const { queue, controller } = await setup();
    const { summoner } = recorder(async () => ({
      status: "unavailable",
      reason: "busy",
    }));
    const { logger, events } = createTestLogger();
    let n = 0;
    const { controller: summon } = controller({
      summoner,
      logger,
      circuit: { failures: 100 },
      onSummonFailed: async () => {
        n++;
        if (n === 1) {
          throw new Error("hook broke");
        }
        await Bun.sleep(1);
        throw new Error("hook rejected");
      },
    });
    const sync = controller({
      summoner,
      logger,
      circuit: { failures: 100 },
      onSummonFailed: () => {
        throw new Error("hook threw");
      },
    }).controller;
    await queue.add("a", {});

    expect(await summon.check()).toMatchObject({ outcome: "unavailable" });
    await Bun.sleep(3);
    expect(await summon.check()).toMatchObject({ outcome: "unavailable" });
    await Bun.sleep(3);
    expect(await sync.check()).toMatchObject({ outcome: "unavailable" });
    await waitFor(() => hookWarns(events).length >= 3, { timeout: 2_000 });
    await Bun.sleep(20);
    const warns = hookWarns(events);
    expect(warns).toHaveLength(3);
    expect(
      warns.map((warn) => (warn.error as Error | undefined)?.message).sort(),
    ).toEqual(["hook broke", "hook rejected", "hook threw"]);
    expect(warns.every((warn) => warn.fields?.outcome === "unavailable")).toBe(
      true,
    );
  });

  it("never holds a check: a hook that never settles delays nothing", async () => {
    const { queue, controller } = await setup();
    const { calls, summoner } = recorder(async () => ({
      status: "unavailable",
      reason: "busy",
    }));
    let told = 0;
    const { controller: summon } = controller({
      summoner,
      circuit: { failures: 100 },
      onSummonFailed: async () => {
        told++;
        await new Promise(() => {});
      },
      summonTimeout: 1_000,
    });
    await queue.add("a", {});
    const started = performance.now();
    await summon.check();
    await Bun.sleep(3);
    await summon.check();
    expect(performance.now() - started).toBeLessThan(900);
    expect(calls).toHaveLength(2);
    expect(told).toBe(2);
    // close() does not wait for it either.
    const closing = performance.now();
    await summon.close();
    expect(performance.now() - closing).toBeLessThan(900);
  });

  it("reaches a controller built from BunJobsOptions.summon and from summonController(queue, policy)", async () => {
    const root = join(dir.path, `jobs-${++unique}`);
    const namespace = testNamespace("summon-failed-jobs");
    const { summoner } = recorder(async () => {
      throw new Error("down");
    });
    const fromOption = recording();
    const fromCall = recording();
    const jobs = new BunJobs({
      namespace,
      driver: { type: "file", root },
      logger: noopLogger,
      summon: {
        work: {
          summoner,
          triggers: { onAdd: false, events: false, poll: false },
          ...fromOption,
        },
      },
    });
    perTest.push(async () => {
      await jobs.driver.purge(namespace).catch(() => {});
      await jobs.close();
    });
    await jobs.queue("work").add("a", {});
    await jobs.queue("other").add("a", {});
    await jobs.summonController("work").check();
    await jobs
      .summonController("other", {
        summoner,
        triggers: { onAdd: false, events: false, poll: false },
        ...fromCall,
      })
      .check();
    expect(fromOption.failures).toMatchObject([
      { outcome: "failed", queue: "work" },
    ]);
    expect(fromCall.failures).toMatchObject([
      { outcome: "failed", queue: "other" },
    ]);
  });

  it("refuses a hook that is not a function", async () => {
    const { controller } = await setup();
    const { summoner } = recorder();
    expect(() =>
      controller({
        summoner,
        onSummonFailed: "notify" as unknown as () => void,
      }),
    ).toThrow(ConfigError);
  });
});

describe("budget: false", () => {
  it("applies no limit and emits no budget-exhausted, while still counting", async () => {
    const { queue, controller } = await setup();
    const { calls, summoner } = recorder(async () => ({
      status: "unavailable",
      reason: "busy",
    }));
    const hook = recording();
    const { controller: summon, events } = controller({
      summoner,
      ...hook,
      budget: false,
      circuit: { failures: 100 },
    });
    await queue.add("a", {});
    for (let i = 0; i < 35; i++) {
      expect(await summon.check()).toMatchObject({ action: "summoned" });
      await Bun.sleep(2);
    }
    expect(calls).toHaveLength(35);
    expect(events.map((event) => event.outcome)).not.toContain(
      "budget-exhausted",
    );
    expect(
      hook.failures.filter((failure) => failure.outcome === "budget-exhausted"),
    ).toEqual([]);
    const { budget } = await summon.status();
    expect(budget).toEqual({
      hour: 35,
      day: 35,
      off: true,
      hourResetsAt: expect.any(Number),
      dayResetsAt: expect.any(Number),
    });
    expect(budget).not.toHaveProperty("perHour");
    expect(budget).not.toHaveProperty("perDay");
  });

  it("refuses a budget that is neither false nor an object", async () => {
    const { controller } = await setup();
    const { summoner } = recorder();
    expect(() =>
      controller({ summoner, budget: true as unknown as false }),
    ).toThrow(ConfigError);
    expect(() => controller({ summoner, budget: { perHour: 0 } })).toThrow(
      ConfigError,
    );
  });
});

describe("the budget's windows", () => {
  it("reports when each UTC window resets", async () => {
    const { controller } = await setup();
    const { summoner } = recorder();
    const { controller: summon } = controller({ summoner });
    const before = Date.now();
    const { budget } = await summon.status();
    const after = Date.now();
    // The window `now` falls in; a test that straddles a boundary may see
    // either side of it.
    expect(budget!.hourResetsAt % HOUR).toBe(0);
    expect(budget!.dayResetsAt % DAY).toBe(0);
    expect(budget!.hourResetsAt).toBeGreaterThan(before);
    expect(budget!.hourResetsAt).toBeLessThanOrEqual(after + HOUR);
    expect(budget!.dayResetsAt).toBeGreaterThan(before);
    expect(budget!.dayResetsAt).toBeLessThanOrEqual(after + DAY);
  });
});

describe("the budget a larger limit left behind", () => {
  it("blocks the defaults; budget: false summons, and so does reset({ budget: true })", async () => {
    const { queue, controller } = await setup();
    const { calls, summoner } = recorder(async () => ({
      status: "unavailable",
      reason: "busy",
    }));
    const quiet = { summoner, circuit: { failures: 1_000 } };
    // Under a larger limit, 31 attempts: past the default 30 an hour.
    const large = controller({
      ...quiet,
      budget: { perHour: 100, perDay: 1_000 },
    }).controller;
    await queue.add("a", {});
    for (let i = 0; i < 31; i++) {
      await large.check();
      await Bun.sleep(2);
    }
    expect(calls).toHaveLength(31);
    await large.close();

    // The option removed: the defaults meet the 31 already counted.
    const defaults = controller(quiet).controller;
    expect(await defaults.check()).toMatchObject({
      action: "skipped",
      reason: "budget",
    });
    expect(calls).toHaveLength(31);
    await defaults.close();

    // Restarted with the budget off: it summons.
    const off = controller({ ...quiet, budget: false }).controller;
    expect(await off.check()).toMatchObject({ action: "summoned" });
    expect(calls).toHaveLength(32);
    expect((await off.status()).budget).toMatchObject({ hour: 32, off: true });
    await off.close();
    await Bun.sleep(2);

    // Or with the defaults again, once the usage is cleared.
    const cleared = controller(quiet).controller;
    expect(await cleared.check()).toMatchObject({ reason: "budget" });
    await cleared.reset({ budget: true });
    expect((await cleared.status()).budget).toMatchObject({
      hour: 0,
      perHour: 30,
      day: 0,
      perDay: 300,
    });
    expect(await cleared.check()).toMatchObject({ action: "summoned" });
    expect(calls).toHaveLength(33);
  });
});

describe("reset", () => {
  it("keeps the budget's usage unless asked, and clears it with { budget: true }", async () => {
    const { queue, controller } = await setup();
    const { summoner } = recorder(async () => {
      throw new Error("down");
    });
    const { controller: summon } = controller({
      summoner,
      circuit: { failures: 1, resetAfter: 60_000 },
    });
    await queue.add("a", {});
    await summon.check();
    expect((await summon.status()).budget).toMatchObject({ hour: 1, day: 1 });

    await summon.reset();
    const plain = await summon.status();
    expect(plain.budget).toMatchObject({ hour: 1, day: 1 });
    expect(plain).not.toHaveProperty("circuitOpenUntil");

    await summon.reset({ budget: false });
    expect((await summon.status()).budget).toMatchObject({ hour: 1, day: 1 });

    await summon.check();
    await summon.reset({ budget: true });
    const cleared = await summon.status();
    expect(cleared.budget).toMatchObject({ hour: 0, day: 0 });
    expect(cleared.failures).toBe(0);
    expect(cleared).not.toHaveProperty("circuitOpenUntil");
  });

  it("emits budget-exhausted again in the same window once the usage is cleared", async () => {
    const { queue, controller } = await setup();
    const { summoner } = recorder(async () => ({
      status: "unavailable",
      reason: "busy",
    }));
    const hook = recording();
    const { controller: summon } = controller({
      summoner,
      ...hook,
      budget: { perHour: 1 },
      circuit: { failures: 100 },
    });
    await queue.add("a", {});
    await summon.check();
    await Bun.sleep(2);
    expect(await summon.check()).toMatchObject({ reason: "budget" });
    await summon.reset({ budget: true });
    await summon.check();
    await Bun.sleep(2);
    expect(await summon.check()).toMatchObject({ reason: "budget" });
    expect(
      hook.failures.filter((failure) => failure.outcome === "budget-exhausted"),
    ).toHaveLength(2);
  });

  it("writes nothing for a queue with no summon state", async () => {
    const { driver, namespace, controller } = await setup();
    const { summoner } = recorder();
    const { controller: summon } = controller({ summoner });
    await summon.reset({ budget: true });
    expect(
      await driver.getQueueState!(
        { ns: namespace, queue: "work" },
        SUMMON_MARKER,
      ),
    ).toBeNull();
  });
});

describe("counting an attempt only once the provider is called", () => {
  const CAPABILITIES: SummonCapabilities = {
    style: "launch",
    dedupe: { kind: "none" },
    passes: "argv",
    bootBudgetMs: 20_000,
    shutdown: { signal: "SIGTERM", graceMs: 10_000 },
    maxLifetimeMs: null,
    enforcesLifetime: false,
  };

  /** A provider whose asynchronous config check fails while `failing` says so. */
  function asyncProvider(state: { failing: boolean }) {
    let calls = 0;
    const provider = defineComputeProvider({
      name: `test-refund-${++unique}`,
      version: "1.0.0",
      kind: "async",
      apiVersion: { core: "0.1", summon: "0.1" },
      config: toStandardSchema<{ region: string }>(async (input) => {
        await Bun.sleep(5);
        return state.failing
          ? { issues: [{ message: "unreachable", path: ["region"] }] }
          : { value: input as { region: string } };
      }),
      summon: (): SummonFacet => ({
        capabilities: CAPABILITIES,
        summon: async () => {
          calls++;
          return { status: "unavailable", reason: "busy" };
        },
      }),
    });
    return { summoner: provider({ region: "eu" }), calls: () => calls };
  }

  it("gives back the count of an attempt whose provider was not ready, and keeps a real call's", async () => {
    const { queue, controller } = await setup();
    const state = { failing: true };
    const { summoner, calls } = asyncProvider(state);
    const { controller: summon } = controller({
      summoner,
      circuit: { failures: 100 },
    });
    await queue.add("a", {});

    expect(await summon.check()).toMatchObject({
      action: "summoned",
      outcome: "failed",
    });
    expect(calls()).toBe(0);
    const refunded = await summon.status();
    expect(refunded.budget).toMatchObject({ hour: 0, day: 0 });
    expect(refunded.last).toMatchObject({ outcome: "failed" });

    // Ready now: a real call that comes back unavailable still counts.
    state.failing = false;
    await Bun.sleep(3);
    expect(await summon.check()).toMatchObject({ outcome: "unavailable" });
    expect(calls()).toBe(1);
    expect((await summon.status()).budget).toMatchObject({ hour: 1, day: 1 });
  });

  it("keeps the count of a call that threw", async () => {
    const { queue, controller } = await setup();
    const { summoner } = recorder(async () => {
      throw new Error("down");
    });
    const { controller: summon } = controller({ summoner });
    await queue.add("a", {});
    await summon.check();
    expect((await summon.status()).budget).toMatchObject({ hour: 1, day: 1 });
  });

  it("gives back nothing in a window that has rolled on since the claim, and never goes below 0", () => {
    const now = Date.now();
    const marker = freshMarker(now);
    marker.budget.hour = 2;
    marker.budget.day = 5;
    // Claimed an hour (and a day) ago: those windows' counts are gone.
    refundBudget(marker, now - DAY);
    expect(marker.budget).toMatchObject({ hour: 2, day: 5 });
    refundBudget(marker, now);
    expect(marker.budget).toMatchObject({ hour: 1, day: 4 });
    marker.budget.hour = 0;
    refundBudget(marker, now);
    expect(marker.budget).toMatchObject({ hour: 0, day: 3 });
  });
});
