import type {
  JobsDriver,
  QueueRef,
  SummonControllerOptions,
  SummonFailure,
  SummonPolicy,
  SummonRequest,
  SummonResult,
} from "../lib/index";
import type { SummonGroupEntry } from "../lib/summon/group";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  createDriver,
  defineSummoner,
  registerWorkerRecord,
  SummonController,
} from "../lib/index";
import { ProviderError } from "../lib/provider/index";
import {
  noteGroupCircuit,
  SUMMON_GROUP_PREFIX,
  summonGroupRef,
  summonGroupStateName,
} from "../lib/summon/group";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * The shared circuit of a summon group (plan summon-multi-queue §3.6, PR-A2):
 * `group.circuit`, opt-in, kept per provider `kind` in the group's entry, fed
 * by every failure and registration a member queue counts, and checked at the
 * group charge.
 */

const dir = await makeTmpDir("bun-jobs-summon-group-circuit");
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

/** A fresh file driver on a fresh root, with helpers. */
async function setup() {
  const root = join(dir.path, `root-${++unique}`);
  const driver = createDriver({ type: "file", root });
  await driver.connect();
  const namespace = testNamespace("summon-group-circuit");
  const owned: SummonController[] = [];
  perTest.push(async () => {
    await Promise.allSettled(owned.map(async (one) => await one.close()));
    await driver.purge(namespace).catch(() => {});
    await driver.close();
  });
  return {
    driver,
    namespace,
    /** Adds one waiting job to each named queue. */
    seed: async (...queues: string[]) => {
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
    /** A controller on `queue`, on `on` (default: the setup's driver). */
    controller: (
      queue: string,
      policy: Partial<SummonControllerOptions> & Pick<SummonPolicy, "summoner">,
      on: JobsDriver = driver,
    ) => {
      const controller = new SummonController({
        ...QUIET,
        ...policy,
        driver: on,
        namespace,
        queue,
      });
      owned.push(controller);
      return controller;
    },
    /** The group's entry, as stored. */
    entry: async (group: string) =>
      (
        await driver.getQueueState!(
          summonGroupRef(namespace),
          summonGroupStateName(group),
        )
      )?.value as SummonGroupEntry | undefined,
  };
}

/** A summoner of `kind` that records each call and answers with `answer`. */
function recorder(
  kind: string,
  answer?: (request: SummonRequest) => Promise<SummonResult | void>,
) {
  const calls: SummonRequest[] = [];
  const summoner = defineSummoner({
    kind,
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

/** A summoner whose credentials are rejected: `auth`, which opens a circuit at once. */
function rejected(kind: string) {
  return recorder(kind, async () => {
    throw new ProviderError("credentials rejected", "auth", {
      platformCode: "InvalidToken",
    });
  });
}

const QUEUES = ["q1", "q2", "q3", "q4"];

describe("group.circuit", () => {
  it("opens for every queue of the kind on one auth failure: one failed call in the group, not one per queue", async () => {
    const { seed, controller, entry, namespace } = await setup();
    await seed(...QUEUES, "other");
    const ecs = rejected("ecs");
    const hook = recording();
    const group = { name: "media", circuit: true };
    const built = QUEUES.map((queue) =>
      controller(queue, { summoner: ecs.summoner, group, ...hook }),
    );
    // A different provider kind in the same group: its circuit is its own.
    const fly = recorder("fly");
    const other = controller("other", { summoner: fly.summoner, group });

    expect(await built[0]!.check()).toMatchObject({
      action: "summoned",
      outcome: "failed",
    });
    for (const one of built.slice(1)) {
      expect(await one.check()).toMatchObject({
        action: "skipped",
        reason: "circuit-open",
      });
    }
    expect(ecs.calls).toHaveLength(1);
    expect(await other.check()).toMatchObject({ action: "summoned" });
    expect(fly.calls).toHaveLength(1);

    const stored = await entry("media");
    expect(stored?.circuits?.ecs).toMatchObject({
      failures: 5,
      openUntil: expect.any(Number),
      openedBy: { queue: "q1", id: ecs.calls[0]!.id, detail: "InvalidToken" },
    });
    expect(stored?.circuits?.fly).toBeUndefined();

    // The queue's own opening, as before, without a group; then the group's,
    // told once, by the controller whose write opened it, naming the group.
    const openings = hook.failures.filter(
      (failure) => failure.outcome === "circuit-open",
    );
    expect(openings).toEqual([
      {
        outcome: "circuit-open",
        kind: "ecs",
        namespace,
        queue: "q1",
        id: ecs.calls[0]!.id,
        detail: "InvalidToken",
        at: expect.any(Number),
        until: expect.any(Number),
      },
      {
        outcome: "circuit-open",
        kind: "ecs",
        namespace,
        queue: "q1",
        group: "media",
        id: ecs.calls[0]!.id,
        detail: "InvalidToken",
        at: expect.any(Number),
        until: stored!.circuits!.ecs!.openUntil,
      },
    ]);

    const status = await built[3]!.status();
    expect(status.group!.circuit).toEqual({
      failures: 5,
      openUntil: stored!.circuits!.ecs!.openUntil,
      openedBy: { queue: "q1", id: ecs.calls[0]!.id, detail: "InvalidToken" },
    });
    // q4's own circuit never saw a failure.
    expect(status.failures).toBe(0);
    expect(status.circuitOpenUntil).toBeUndefined();
    expect((await other.status()).group!.circuit).toEqual({ failures: 0 });
  });

  it("is opt-in: without it each queue fails on its own, one call per queue", async () => {
    const { seed, controller, entry } = await setup();
    await seed(...QUEUES);
    const ecs = rejected("ecs");
    const built = QUEUES.map((queue) =>
      controller(queue, { summoner: ecs.summoner, group: { name: "media" } }),
    );
    for (const one of built) {
      expect(await one.check()).toMatchObject({ outcome: "failed" });
    }
    expect(ecs.calls).toHaveLength(4);
    expect((await entry("media"))?.circuits).toBeUndefined();
    expect((await built[0]!.status()).group!.circuit).toBeUndefined();
  });

  it("opens by count at the group's threshold, the queues' own circuits still closed", async () => {
    const { seed, controller, entry } = await setup();
    await seed(...QUEUES);
    const down = recorder("ecs", async () => {
      throw new Error("down");
    });
    const built = QUEUES.map((queue) =>
      controller(queue, {
        summoner: down.summoner,
        circuit: { failures: 100 },
        group: { name: "media", circuit: { failures: 3, resetAfter: 60_000 } },
      }),
    );
    for (const one of built.slice(0, 3)) {
      expect(await one.check()).toMatchObject({ outcome: "failed" });
    }
    expect(await built[3]!.check()).toMatchObject({
      reason: "circuit-open",
    });
    expect(down.calls).toHaveLength(3);
    const circuit = (await entry("media"))!.circuits!.ecs!;
    expect(circuit.failures).toBe(3);
    expect(circuit.openUntil! - Date.now()).toBeGreaterThan(50_000);
    expect(circuit.openUntil! - Date.now()).toBeLessThanOrEqual(60_000);
    expect((await built[0]!.status()).circuitOpenUntil).toBeUndefined();
  });

  it("restarts its count on a registration on any queue of the group", async () => {
    const { seed, controller, entry, driver, namespace } = await setup();
    await seed("q1", "q2", "q3");
    let fail = false;
    const flaky = recorder("ecs", async () => {
      if (fail) {
        throw new Error("down");
      }
    });
    const group = { name: "media", circuit: { failures: 3 } };
    const [one, two, three] = ["q1", "q2", "q3"].map((queue) =>
      controller(queue, { summoner: flaky.summoner, group }),
    );
    // q1 summons; q2 and q3 fail: the group counts two.
    expect(await one!.check()).toMatchObject({ outcome: "started" });
    fail = true;
    await two!.check();
    await three!.check();
    expect((await entry("media"))!.circuits!.ecs!.failures).toBe(2);

    // q1's worker registers: its next check says so, and the group's count
    // starts again — so the next failure does not open the circuit.
    const now = Date.now();
    await registerWorkerRecord(
      driver,
      { ns: namespace, queue: "q1" },
      {
        id: "summoned-1",
        queue: "q1",
        host: "h",
        pid: 1,
        concurrency: 1,
        active: 0,
        paused: false,
        startedAt: now,
        heartbeatAt: now,
        expiresAt: now + 60_000,
        summon: { id: flaky.calls[0]!.id, kind: "ecs" },
      },
    );
    await one!.check();
    expect((await entry("media"))!.circuits!.ecs!.failures).toBe(0);
    // Past q2's 1 ms backoff from its failure.
    await Bun.sleep(5);
    await two!.check();
    expect((await entry("media"))!.circuits!.ecs).toEqual({ failures: 1 });
  });

  it("does not count a throttled answer, as a queue's circuit does not", async () => {
    const { seed, controller, entry } = await setup();
    await seed("q1");
    const throttled = recorder("ecs", async () => {
      throw new ProviderError("slow down", "throttled");
    });
    const one = controller("q1", {
      summoner: throttled.summoner,
      group: { name: "media", circuit: true },
    });
    expect(await one.check()).toMatchObject({ outcome: "unavailable" });
    expect((await entry("media"))?.circuits).toBeUndefined();
  });

  it("is closed, with its count, by reset({ group: true }), and summoning resumes", async () => {
    const { seed, controller, entry } = await setup();
    await seed("q1", "q2");
    let fail = true;
    const flaky = recorder("ecs", async () => {
      if (fail) {
        throw new ProviderError("credentials rejected", "auth");
      }
    });
    const group = { name: "media", circuit: true };
    const one = controller("q1", { summoner: flaky.summoner, group });
    const two = controller("q2", { summoner: flaky.summoner, group });
    await one.check();
    expect(await two.check()).toMatchObject({ reason: "circuit-open" });

    // The queue's own reset alone leaves the group's circuit open.
    await two.reset();
    expect(await two.check()).toMatchObject({ reason: "circuit-open" });

    fail = false;
    await two.reset({ group: true });
    expect((await entry("media"))!.circuits?.ecs).toBeUndefined();
    expect(await two.check()).toMatchObject({
      action: "summoned",
      outcome: "started",
    });
  });

  it("under-counts, never blocks, when its write is lost: the queue's circuit is the backstop", async () => {
    const { seed, controller, driver, entry } = await setup();
    await seed("q1");
    const lossy = new Proxy(driver, {
      get(target, property) {
        if (property === "setQueueState") {
          return async (
            q: QueueRef,
            name: string,
            value: unknown,
            expected: number | null,
            options?: { internal?: symbol },
          ) => {
            // The charge lands; every circuit write after it is lost.
            const circuits = (value as { circuits?: unknown } | null)?.circuits;
            return name.startsWith(SUMMON_GROUP_PREFIX) &&
              circuits !== undefined
              ? null
              : await target.setQueueState!(q, name, value, expected, options);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ecs = rejected("ecs");
    const one = controller(
      "q1",
      { summoner: ecs.summoner, group: { name: "media", circuit: true } },
      lossy,
    );
    expect(await one.check()).toMatchObject({ outcome: "failed" });
    expect((await entry("media"))?.circuits).toBeUndefined();
    // The queue's own circuit opened at once, as without a group.
    expect((await one.status()).circuitOpenUntil).toBeGreaterThan(Date.now());
  });

  it("refuses a circuit that is neither a boolean nor { failures?, resetAfter? }", async () => {
    const { controller } = await setup();
    const { summoner } = recorder("ecs");
    for (const [circuit, message] of [
      ["yes", /group\.circuit must be a boolean/],
      [{ failures: 0 }, /group\.circuit\.failures/],
      [{ resetAfter: -1 }, /group\.circuit\.resetAfter/],
    ] as const) {
      expect(() =>
        controller("q1", {
          summoner,
          group: {
            name: "g",
            circuit: circuit as unknown as boolean,
          },
        }),
      ).toThrow(message);
    }
  });
});

describe("noteGroupCircuit", () => {
  /** Notes `notes` on a fresh group, `ecs`, threshold 3, open 60 s. */
  async function note(
    driver: JobsDriver,
    namespace: string,
    notes: Parameters<typeof noteGroupCircuit>[3]["notes"],
  ) {
    return await noteGroupCircuit(driver, namespace, "g", {
      kind: "ecs",
      queue: "q",
      notes,
      failures: 3,
      resetAfter: 60_000,
    });
  }

  it("replays in order: a success resets the count, an at-once failure opens", async () => {
    const { driver, namespace, entry } = await setup();
    expect(
      await note(driver, namespace, [
        { type: "failure", id: "a" },
        { type: "failure", id: "b" },
        { type: "success" },
        { type: "failure", id: "c" },
      ]),
    ).toEqual({ landed: true });
    expect((await entry("g"))!.circuits!.ecs).toEqual({ failures: 1 });

    const opened = await note(driver, namespace, [
      { type: "failure", id: "d", detail: "InvalidToken", atOnce: true },
    ]);
    expect(opened).toEqual({
      landed: true,
      opened: { until: expect.any(Number), id: "d", detail: "InvalidToken" },
    });
    expect((await entry("g"))!.circuits!.ecs).toMatchObject({
      failures: 3,
      openedBy: { queue: "q", id: "d", detail: "InvalidToken" },
    });

    // Already open: a further failure extends it, and is no new opening.
    const extended = await note(driver, namespace, [
      { type: "failure", id: "e" },
    ]);
    expect(extended).toEqual({ landed: true });
    // A success resets the count but leaves it open until it closes by time.
    await note(driver, namespace, [{ type: "success" }]);
    expect((await entry("g"))!.circuits!.ecs).toMatchObject({
      failures: 0,
      openUntil: expect.any(Number),
    });
  });

  it("writes nothing for a success with nothing counted", async () => {
    const { driver, namespace, entry } = await setup();
    expect(await note(driver, namespace, [{ type: "success" }])).toEqual({
      landed: true,
    });
    expect(await entry("g")).toBeUndefined();
  });
});
