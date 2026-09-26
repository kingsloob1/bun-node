import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import {
  BunQueueWorker,
  ConfigError,
  MemoryDriver,
  runSummoned,
} from "../lib/index";
import {
  TARGET_CLOSE_GRACE,
  TARGET_CLOSE_REAP,
} from "../lib/queue/workerTarget";
import { DEFAULT_CLOSE_TIMEOUT } from "../lib/shared/constants";
import {
  isSummonIdle,
  RUN_SUMMONED_DEFAULTS,
  summonCloseRule,
  summonTargetClose,
} from "../lib/summon/worker";

/**
 * `runSummoned`'s decisions, without a process: the close rule, the idle
 * predicate, and the options it refuses. Signals and exits are in
 * `run-summoned.test.ts`, in real processes.
 */

const TAIL = RUN_SUMMONED_DEFAULTS.tailReserve;
const MARGIN = RUN_SUMMONED_DEFAULTS.backstopMargin;

describe("summonTargetClose", () => {
  it("derives each target's close from the package's close constants", () => {
    expect(summonTargetClose("child-process", false)).toBe(
      TARGET_CLOSE_GRACE + TARGET_CLOSE_REAP,
    );
    expect(summonTargetClose("child-process", false)).toBe(4_500);
    expect(summonTargetClose("child-process", true)).toBe(TARGET_CLOSE_REAP);
    expect(summonTargetClose("worker-thread", false)).toBe(4_500);
    expect(summonTargetClose("worker-thread", true)).toBe(500);
    expect(summonTargetClose("in-process", false)).toBe(0);
    expect(summonTargetClose("in-process", true)).toBe(0);
    // A custom target may ignore `force`: the worker's bound either way.
    expect(summonTargetClose("custom", false)).toBe(DEFAULT_CLOSE_TIMEOUT);
    expect(summonTargetClose("custom", true)).toBe(DEFAULT_CLOSE_TIMEOUT);
    // Not yet known: the most it could be.
    expect(summonTargetClose(undefined, false)).toBe(DEFAULT_CLOSE_TIMEOUT);
  });
});

describe("summonCloseRule, the plan's platform table", () => {
  /** The budget at the moment of a signal, for a grace. */
  const at = (grace: number): number => grace - MARGIN;

  const cases = [
    // platform, grace, child-process decision, in-process decision
    { name: "Railway (0 s)", grace: 0, child: "force", inProcess: "force" },
    { name: "Fly (5 s)", grace: 5_000, child: "force", inProcess: 3_750 },
    { name: "Cloud Run (10 s)", grace: 10_000, child: 4_250, inProcess: 8_750 },
    {
      name: "ECS/Heroku/k8s (30 s)",
      grace: 30_000,
      child: 24_250,
      inProcess: 28_750,
    },
    {
      name: "Fly, kill_timeout 300",
      grace: 300_000,
      child: 294_250,
      inProcess: 298_750,
    },
  ] as const;

  for (const platform of cases) {
    it(platform.name, () => {
      for (const [kind, expected] of [
        ["child-process", platform.child],
        ["in-process", platform.inProcess],
      ] as const) {
        const decision = summonCloseRule({
          budget: at(platform.grace),
          kind,
          tailReserve: TAIL,
        });
        if (expected === "force") {
          expect(decision.force).toBe(true);
          expect(decision.timeout).toBeUndefined();
        } else {
          expect(decision.force).toBe(false);
          expect(decision.timeout).toBe(expected);
        }
      }
    });
  }

  it("forces a custom target on Fly's default grace, which the backstop then bounds", () => {
    const decision = summonCloseRule({
      budget: at(5_000),
      kind: "custom",
      tailReserve: TAIL,
    });
    expect(decision).toMatchObject({ force: true, targetClose: 5_000 });
  });

  it("is graceful at exactly the reserve, and forced a millisecond short of it", () => {
    const need = 4_500 + TAIL;
    expect(
      summonCloseRule({
        budget: need,
        kind: "child-process",
        tailReserve: TAIL,
      }),
    ).toMatchObject({ force: false, timeout: 0 });
    expect(
      summonCloseRule({
        budget: need - 1,
        kind: "child-process",
        tailReserve: TAIL,
      }).force,
    ).toBe(true);
  });

  it("with no budget at all, closes gracefully with the worker's own timeout", () => {
    const decision = summonCloseRule({
      budget: Number.POSITIVE_INFINITY,
      kind: "child-process",
      tailReserve: TAIL,
    });
    expect(decision.force).toBe(false);
    expect(decision.timeout).toBeUndefined();
  });
});

describe("isSummonIdle", () => {
  const base = {
    ownActive: 0,
    demand: { demand: 0, active: 0, nextDueAt: null },
    otherLiveWorkers: 0,
    now: 1_000_000,
    idleFor: 30_000,
  };

  it("is idle with nothing anywhere", () => {
    expect(isSummonIdle(base)).toBe(true);
  });

  it("is busy with a job of its own in flight", () => {
    expect(isSummonIdle({ ...base, ownActive: 1 })).toBe(false);
  });

  it("is busy while there is demand", () => {
    expect(
      isSummonIdle({ ...base, demand: { ...base.demand, demand: 1 } }),
    ).toBe(false);
  });

  it("waits out an orphaned active job no live worker holds, and not one a live worker does", () => {
    const orphaned = { ...base, demand: { ...base.demand, active: 2 } };
    expect(isSummonIdle(orphaned)).toBe(false);
    expect(isSummonIdle({ ...orphaned, otherLiveWorkers: 1 })).toBe(true);
  });

  it("stays for a job coming due within idleFor, not one due after it", () => {
    const soon = base.now + 2_000;
    expect(
      isSummonIdle({ ...base, demand: { ...base.demand, nextDueAt: soon } }),
    ).toBe(false);
    const later = base.now + base.idleFor + 1;
    expect(
      isSummonIdle({ ...base, demand: { ...base.demand, nextDueAt: later } }),
    ).toBe(true);
  });
});

describe("runSummoned refuses", () => {
  const worker = (): BunQueueWorker<unknown, string> =>
    new BunQueueWorker("refuse", async () => "x", {
      namespace: "run-summoned-refuse",
      driver: new MemoryDriver(),
      logger: noopLogger,
    });

  for (const [name, options] of [
    ["a negative idleFor", { idleFor: -1 }],
    ["a zero idleCheckInterval", { idleCheckInterval: 0 }],
    ["a NaN grace", { grace: Number.NaN }],
    ["an infinite tailReserve", { tailReserve: Number.POSITIVE_INFINITY }],
    ["an unknown mode", { mode: "forever" as "until-stopped" }],
  ] as const) {
    it(name, async () => {
      await expect(runSummoned(worker(), options)).rejects.toBeInstanceOf(
        ConfigError,
      );
    });
  }

  it("a worker that is already running, and leaves it running", async () => {
    const running = worker();
    void running.run();
    try {
      await expect(
        runSummoned(running, { exit: false, signals: false }),
      ).rejects.toBeInstanceOf(ConfigError);
      expect(running.isRunning).toBe(true);
    } finally {
      await running.close();
    }
  });

  it("nothing is installed when it refuses", async () => {
    const before = process.listenerCount("SIGTERM");
    await expect(runSummoned(worker(), { idleFor: -1 })).rejects.toThrow();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("runSummoned in-process, exit: false", () => {
  it("resolves with what it did, and removes every listener", async () => {
    const driver = new MemoryDriver();
    const worker = new BunQueueWorker("inproc", async () => "done", {
      namespace: "run-summoned-inproc",
      driver,
      logger: noopLogger,
      pollInterval: 20,
    });
    const signals = ["SIGTERM", "SIGINT", "SIGTSTP", "SIGCONT"] as const;
    const before = signals.map((signal) => process.listenerCount(signal));

    const exit = await runSummoned(worker, {
      exit: false,
      idleFor: 100,
      idleCheckInterval: 20,
    });

    expect(exit).toMatchObject({
      reason: "idle",
      code: 0,
      completed: 0,
      failed: 0,
    });
    expect(exit.ranForMs).toBeGreaterThanOrEqual(100);
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(
      before,
    );
    expect(worker.listenerCount("completed")).toBe(0);
    expect(worker.listenerCount("ready")).toBe(0);
  });

  it('reports "closed" when something else closes the worker', async () => {
    const worker = new BunQueueWorker("inproc-closed", async () => "done", {
      namespace: "run-summoned-inproc-closed",
      driver: new MemoryDriver(),
      logger: noopLogger,
      pollInterval: 20,
    });
    worker.once("ready", () => {
      void worker.close();
    });
    const exit = await runSummoned(worker, {
      exit: false,
      signals: false,
      idleFor: 60_000,
    });
    expect(exit.reason).toBe("closed");
    expect(exit.code).toBe(0);
  });
});
