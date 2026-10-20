import type {
  JobsDriver,
  SummonEventPayload,
  SummonFailure,
  SummonOption,
  SummonPolicy,
  SummonRequest,
} from "../lib/index";
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
import { LIST_SUMMON_CONTROLLERS } from "../lib/summon/controller";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * A shared summon unit built by `BunJobs` (plan summon-multi-queue §4,
 * PR-B3b C8): the `summon` option's array and record forms, one controller
 * registered under every queue it serves, `summonController()`'s refusals
 * (Q7), the restricted `overrides`, `queues` on status, events and failures
 * (Q10), each event's `eventId` and a partial unit's `missing`, and the
 * record-based overlap warning (§4.9, Q9). On one file backend; the
 * cross-process behaviour of the unit itself is
 * `summon-shared-unit-xproc.test.ts`'s.
 */

const dir = await makeTmpDir("bun-jobs-summon-shared-jobs");
afterAll(dir.cleanup);

const perTest: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of perTest.splice(0)) {
    await cleanup().catch(() => {});
  }
});

/** Triggers off, no cooldown, a 1 ms backoff: every check is one the test asked for. */
const QUIET: Partial<SummonPolicy> = {
  triggers: { onAdd: false, events: false, poll: false },
  cooldown: 0,
  backoff: { initial: 1, max: 1 },
};

const MEDIA = ["renders", "thumbs", "previews"] as const;
const SHARED = { name: "media", unit: "shared" } as const;

let unique = 0;

/** A fresh file driver on a fresh root, purged and closed after the test. */
async function freshDriver(): Promise<{
  driver: JobsDriver;
  namespace: string;
}> {
  const namespace = testNamespace("summon-shared-jobs");
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

/** A summoner that records every request and starts nothing. */
function recording(): {
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
        return { status: "started", handles: [] };
      },
    }),
  };
}

/** A context closed after the test (first, before its driver). */
function context(options: ConstructorParameters<typeof BunJobs>[0]): BunJobs {
  const jobs = new BunJobs({ logger: noopLogger, ...options });
  perTest.unshift(async () => await jobs.close());
  return jobs;
}

/** What `new BunJobs(options)` throws, or `undefined`. */
function refusal(options: ConstructorParameters<typeof BunJobs>[0]): unknown {
  try {
    context(options);
  } catch (error) {
    return error;
  }
  return undefined;
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

describe("BunJobs builds a shared unit from the summon option", () => {
  it("builds one controller for an array entry's queues, under every one of them", async () => {
    const { driver, namespace } = await freshDriver();
    const { summoner, calls } = recording();
    const other = recording();
    const jobs = context({
      namespace,
      driver,
      summon: [
        { queues: [...MEDIA], summoner, group: SHARED, ...QUIET },
        { queues: ["emails"], summoner: other.summoner, ...QUIET },
      ],
    });
    const unit = jobs.summonController("renders");
    expect(unit.queues).toEqual([...MEDIA]);
    for (const queue of MEDIA) {
      expect(jobs.summonController(queue)).toBe(unit);
    }
    // The per-queue entry beside it is unchanged: one queue, its own.
    const emails = jobs.summonController("emails");
    expect(emails).not.toBe(unit);
    expect(emails.queues).toEqual(["emails"]);
    // Listed once each.
    expect(jobs[LIST_SUMMON_CONTROLLERS]()).toEqual([unit, emails]);

    // One check, one call, naming every queue and the group.
    await seed(driver, namespace, "thumbs");
    expect(await unit.check()).toMatchObject({ action: "summoned" });
    expect(calls).toHaveLength(1);
    expect(calls[0].queues).toEqual([...MEDIA]);
    expect(calls[0].group).toBe("media");
    expect(other.calls).toHaveLength(0);
  });

  it("builds a shared unit of one queue from a record (Q5)", async () => {
    const { driver, namespace } = await freshDriver();
    const { summoner, calls } = recording();
    const jobs = context({
      namespace,
      driver,
      summon: { renders: { summoner, group: SHARED, ...QUIET } },
    });
    const unit = jobs.summonController("renders");
    expect(unit.queues).toEqual(["renders"]);
    const status = await unit.status();
    // A shared unit: its status names its queues, and its state is the
    // group's entry (the group status is its own).
    expect(status.queues).toEqual(["renders"]);
    expect(status.group?.name).toBe("media");
    await seed(driver, namespace, "renders");
    expect(await unit.check()).toMatchObject({ action: "summoned" });
    // A shared unit names its group even for one queue: its state is the
    // group's entry, and its release names the group too.
    expect(calls[0].argv).toContain("--bun-jobs-summon-group=media");
    expect(calls[0].group).toBe("media");
    expect((await unit.status()).group?.budget.hour).toBe(1);
  });

  it("passes an entry's per-queue jobsPerWorker and maxWorkers to the unit", async () => {
    const { driver, namespace } = await freshDriver();
    const { summoner, calls } = recording();
    const jobs = context({
      namespace,
      driver,
      summon: [
        {
          queues: ["renders", "thumbs"],
          summoner,
          group: SHARED,
          maxWorkers: 5,
          ...QUIET,
          overrides: { renders: { jobsPerWorker: 10, maxWorkers: 2 } },
        },
      ],
    });
    // 50 renders at 10 a worker would want 5; its own maxWorkers is 2.
    await seed(driver, namespace, "renders", 50);
    expect(await jobs.summonController("renders").check()).toMatchObject({
      action: "summoned",
    });
    expect(calls[0].count).toBe(2);
  });

  it("refuses a shared unit's override of anything but jobsPerWorker and maxWorkers, saying where", async () => {
    const { driver, namespace } = await freshDriver();
    const { summoner } = recording();
    const error = refusal({
      namespace,
      driver,
      summon: [
        {
          queues: ["renders", "thumbs"],
          summoner,
          group: SHARED,
          overrides: { thumbs: { budget: { perHour: 5 } } },
        },
      ],
    });
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(
      "summon[0].overrides.thumbs.budget: a shared unit",
    );
  });

  it("refuses one group's shared unit written twice, in either form", async () => {
    const { driver, namespace } = await freshDriver();
    const { summoner } = recording();
    for (const summon of [
      [
        { queues: ["renders"], summoner, group: SHARED },
        { queues: ["thumbs"], summoner, group: SHARED },
      ],
      {
        renders: { summoner, group: SHARED },
        thumbs: { summoner, group: SHARED },
      },
      [
        { queues: ["renders"], summoner, group: SHARED },
        { thumbs: { summoner, group: SHARED } },
      ],
    ] as SummonOption[]) {
      const error = refusal({ namespace, driver, summon });
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toMatch(
        /Summon group "media" is a shared unit written twice/,
      );
    }
  });

  it("refuses an override that makes one queue of a per-queue entry a shared unit", async () => {
    const { driver, namespace } = await freshDriver();
    const { summoner } = recording();
    const error = refusal({
      namespace,
      driver,
      summon: [
        {
          queues: ["renders", "thumbs"],
          summoner,
          overrides: { thumbs: { group: SHARED } },
        },
      ],
    });
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(
      'summon[0].overrides.thumbs.group makes "thumbs" a shared unit',
    );
  });

  it("still refuses a queue named twice, across a shared unit and a record", async () => {
    const { driver, namespace } = await freshDriver();
    const { summoner } = recording();
    const error = refusal({
      namespace,
      driver,
      summon: [
        { queues: ["renders", "thumbs"], summoner, group: SHARED },
        { thumbs: { summoner } },
      ],
    });
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/Queue "thumbs" is named twice/);
  });

  for (const queue of MEDIA) {
    it(`hears an add to ${queue}, through the queue of that name the context creates`, async () => {
      const { driver, namespace } = await freshDriver();
      const { summoner, calls } = recording();
      const jobs = context({
        namespace,
        driver,
        summon: [
          {
            queues: [...MEDIA],
            summoner,
            group: SHARED,
            cooldown: 0,
            triggers: {
              onAdd: true,
              events: false,
              poll: false,
              debounce: 10,
            },
          },
        ],
      });
      await jobs.queue(queue).add("a", {});
      await waitFor(() => calls.length === 1, { timeout: 5_000 });
      expect(calls[0].queues).toEqual([...MEDIA]);
    });
  }

  it("refuses a shared unit with no group name, as such rather than as written twice", async () => {
    const { driver, namespace } = await freshDriver();
    const { summoner } = recording();
    const nameless = { unit: "shared" } as unknown as typeof SHARED;
    const error = refusal({
      namespace,
      driver,
      summon: [
        { queues: ["renders"], summoner, group: nameless },
        { queues: ["thumbs"], summoner, group: nameless },
      ],
    });
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(
      'summon[0].group.name is required for a shared unit (group.unit "shared"): the group\'s name is the key its state is stored under',
    );
  });

  it("checks a record's shared unit's overrides where it was written", async () => {
    const { driver, namespace } = await freshDriver();
    const { summoner } = recording();
    const error = refusal({
      namespace,
      driver,
      summon: {
        renders: {
          summoner,
          group: SHARED,
          overrides: { renders: { budget: { perHour: 1 } } },
        } as SummonPolicy,
      },
    });
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toStartWith(
      "summon.renders.overrides.renders.budget: a shared unit",
    );
    expect((error as ConfigError).context).toMatchObject({
      at: "summon.renders",
    });
  });

  it("names the entry of a shared unit the controller refuses", async () => {
    const { driver, namespace } = await freshDriver();
    const { summoner } = recording();
    const error = refusal({
      namespace,
      driver,
      summon: [
        { queues: ["a"], summoner },
        {
          queues: ["renders", "thumbs"],
          summoner,
          group: SHARED,
          maxWorkers: 2,
          overrides: { thumbs: { maxWorkers: 10 } },
        },
      ],
    });
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(
      /^overrides\.thumbs\.maxWorkers is 10, above the unit's maxWorkers of 2.* \(at summon\[1\]\)$/,
    );
    expect((error as ConfigError).context).toMatchObject({
      queue: "thumbs",
      at: "summon[1]",
    });
  });

  it("takes an override of undefined as none, as a per-queue entry does", async () => {
    const { driver, namespace } = await freshDriver();
    const { summoner } = recording();
    const jobs = context({
      namespace,
      driver,
      summon: [
        {
          queues: ["renders", "thumbs"],
          summoner,
          group: SHARED,
          ...QUIET,
          overrides: { thumbs: undefined as never },
        },
      ],
    });
    expect(jobs.summonController("thumbs").queues).toEqual([
      "renders",
      "thumbs",
    ]);
  });

  it("closes the unit once, though it is registered under every queue", async () => {
    const { driver, namespace } = await freshDriver();
    const { summoner } = recording();
    const jobs = new BunJobs({
      namespace,
      driver,
      logger: noopLogger,
      summon: [{ queues: [...MEDIA], summoner, group: SHARED, ...QUIET }],
    });
    const unit = jobs.summonController("renders");
    let closes = 0;
    const close = unit.close.bind(unit);
    unit.close = async () => {
      closes++;
      await close();
    };
    await jobs.close();
    expect(closes).toBe(1);
    expect(jobs[LIST_SUMMON_CONTROLLERS]()).toEqual([]);
  });
});

describe("jobs.summonController() and a shared unit (Q7)", () => {
  it("refuses a policy for a queue the unit serves, naming the group and the way to change it", async () => {
    const { driver, namespace } = await freshDriver();
    const { summoner } = recording();
    const jobs = context({
      namespace,
      driver,
      summon: [{ queues: [...MEDIA], summoner, group: SHARED, ...QUIET }],
    });
    const unit = jobs.summonController("thumbs");
    let thrown: unknown;
    try {
      jobs.summonController("thumbs", { summoner, ...QUIET });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toContain(
      `Queue "thumbs" is served by summon group "media"'s shared unit`,
    );
    expect((thrown as Error).message).toContain("overrides.thumbs");
    expect((thrown as ConfigError).context).toMatchObject({
      queue: "thumbs",
      group: "media",
      queues: [...MEDIA],
    });
    // Never a second controller: the unit is still the one.
    expect(jobs.summonController("thumbs")).toBe(unit);
    expect(jobs[LIST_SUMMON_CONTROLLERS]()).toEqual([unit]);
  });

  it("refuses a shared unit's policy, which it cannot build for one queue", async () => {
    const { driver, namespace } = await freshDriver();
    const { summoner } = recording();
    const jobs = context({ namespace, driver });
    expect(() =>
      jobs.summonController("renders", { summoner, group: SHARED }),
    ).toThrow(/summonController\(\) builds a controller for one queue/);
    expect(jobs[LIST_SUMMON_CONTROLLERS]()).toEqual([]);
  });

  it("still ignores a policy passed for a queue whose per-queue controller exists", async () => {
    const { driver, namespace } = await freshDriver();
    const { summoner } = recording();
    const jobs = context({
      namespace,
      driver,
      summon: { emails: { summoner, ...QUIET } },
    });
    const emails = jobs.summonController("emails");
    expect(jobs.summonController("emails", { summoner, ...QUIET })).toBe(
      emails,
    );
  });
});

describe("a shared unit names its queues (Q10)", () => {
  it("on its status, its events and onSummonFailed, and a controller of one queue does not", async () => {
    const { driver, namespace } = await freshDriver();
    const failures: SummonFailure[] = [];
    const rejecting = defineSummoner({
      kind: "fake",
      invoke: async () => {
        throw new Error("refused");
      },
    });
    const onSummonFailed = (failure: SummonFailure): void => {
      failures.push(failure);
    };
    const jobs = context({
      namespace,
      driver,
      summon: [
        {
          queues: ["renders", "thumbs"],
          summoner: rejecting,
          group: SHARED,
          onSummonFailed,
          ...QUIET,
        },
        { emails: { summoner: rejecting, onSummonFailed, ...QUIET } },
      ],
    });
    const unit = jobs.summonController("renders");
    const emails = jobs.summonController("emails");
    const unitEvents: SummonEventPayload[] = [];
    const emailEvents: SummonEventPayload[] = [];
    unit.on("summon", (event) => unitEvents.push(event));
    emails.on("summon", (event) => emailEvents.push(event));
    await seed(driver, namespace, "thumbs");
    await seed(driver, namespace, "emails");
    await unit.check();
    await emails.check();
    await waitFor(() => failures.length === 2, { timeout: 5_000 });

    expect((await unit.status()).queues).toEqual(["renders", "thumbs"]);
    expect("queues" in (await emails.status())).toBe(false);
    expect(unitEvents.length).toBeGreaterThan(0);
    for (const event of unitEvents) {
      expect(event.queues).toEqual(["renders", "thumbs"]);
    }
    for (const event of emailEvents) {
      expect("queues" in event).toBe(false);
    }
    const unitFailure = failures.find((one) => one.group === "media")!;
    expect(unitFailure).toMatchObject({
      outcome: "failed",
      queue: "renders",
      queues: ["renders", "thumbs"],
    });
    const emailFailure = failures.find((one) => one.queue === "emails")!;
    expect("queues" in emailFailure).toBe(false);
  });

  it("gives every event its own eventId, for one queue as for a shared unit", async () => {
    const { driver, namespace } = await freshDriver();
    const { summoner } = recording();
    const jobs = context({
      namespace,
      driver,
      summon: [
        { queues: ["renders", "thumbs"], summoner, group: SHARED, ...QUIET },
        { emails: { summoner, ...QUIET } },
      ],
    });
    const events: SummonEventPayload[] = [];
    for (const queue of ["renders", "emails"]) {
      jobs.summonController(queue).on("summon", (event) => events.push(event));
    }
    await seed(driver, namespace, "renders");
    await seed(driver, namespace, "emails");
    await jobs.summonController("renders").check();
    await jobs.summonController("emails").check();
    expect(events.length).toBeGreaterThanOrEqual(2);
    const ids = events.map((event) => event.eventId);
    for (const id of ids) {
      expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-7/);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("overlaps: who else summons for these queues (§4.9, Q9)", () => {
  /** Runs a summoned worker on `queue` whose record carries `summon`, closed after the test. */
  async function summonedWorker(
    driver: JobsDriver,
    namespace: string,
    queue: string,
    summon: { id: string; group?: string },
  ): Promise<void> {
    const worker = new BunQueueWorker(queue, async () => null, {
      namespace,
      driver,
      logger: noopLogger,
      summon,
    });
    perTest.unshift(async () => await worker.close());
    void worker.run();
    await waitFor(
      async () =>
        (await driver.listWorkers!({ ns: namespace, queue }, Date.now())).some(
          (record) => record.id === worker.id && record.summon !== undefined,
        ),
      { timeout: 5_000 },
    );
  }

  /** A shared unit over `queues`, with its warnings collected. */
  function unitOver(
    driver: JobsDriver,
    namespace: string,
    queues: readonly string[],
  ): {
    controller: SummonController;
    warnings: () => { message: string; fields?: Record<string, unknown> }[];
  } {
    const { logger, events } = createTestLogger();
    const controller = new SummonController({
      ...QUIET,
      driver,
      namespace,
      summoner: recording().summoner,
      queues,
      group: SHARED,
      logger,
    });
    perTest.unshift(async () => await controller.close());
    return {
      controller,
      warnings: () =>
        events
          // The file driver's one-host warning is not about overlaps.
          .filter(
            (event) =>
              event.level === "warn" && !event.message.includes("one host"),
          )
          .map((event) => ({
            message: event.message,
            fields: event.fields,
          })),
    };
  }

  it("lists another group's shared unit on a member queue, and warns once per queue and group", async () => {
    const { driver, namespace } = await freshDriver();
    await summonedWorker(driver, namespace, "thumbs", {
      id: "sm_other",
      group: "other",
    });
    const { controller, warnings } = unitOver(driver, namespace, MEDIA);
    expect((await controller.status()).overlaps).toBeUndefined();
    await controller.check();
    await controller.check();
    expect((await controller.status()).overlaps).toEqual(["other"]);
    const overlapWarnings = warnings().filter((one) =>
      one.message.includes('summon group "other"'),
    );
    expect(overlapWarnings).toHaveLength(1);
    expect(overlapWarnings[0].fields).toMatchObject({
      queue: "thumbs",
      overlapGroup: "other",
    });
  });

  it("does not list its own group's workers", async () => {
    const { driver, namespace } = await freshDriver();
    await summonedWorker(driver, namespace, "thumbs", {
      id: "sm_mine",
      group: "media",
    });
    const { controller, warnings } = unitOver(driver, namespace, MEDIA);
    await controller.check();
    expect((await controller.status()).overlaps).toBeUndefined();
    expect(warnings()).toEqual([]);
  });

  it("warns once per queue of a summoned worker with no group, without listing it (Q9)", async () => {
    const { driver, namespace } = await freshDriver();
    await summonedWorker(driver, namespace, "thumbs", { id: "sm_perqueue" });
    const { controller, warnings } = unitOver(driver, namespace, MEDIA);
    await controller.check();
    await controller.check();
    expect((await controller.status()).overlaps).toBeUndefined();
    const groupless = warnings().filter((one) =>
      one.message.includes("summoned worker naming no summon group"),
    );
    expect(groupless).toHaveLength(1);
    expect(groupless[0].fields).toMatchObject({ queue: "thumbs" });
  });

  it("warns of a worker with no group from a shared unit of one queue too (Q9)", async () => {
    const { driver, namespace } = await freshDriver();
    // Its own unit's worker names the group (a one-queue summon passes it),
    // so only the group-less one is someone else's.
    await summonedWorker(driver, namespace, "renders", {
      id: "sm_mine",
      group: "media",
    });
    await summonedWorker(driver, namespace, "renders", { id: "sm_perqueue" });
    const { controller, warnings } = unitOver(driver, namespace, ["renders"]);
    await controller.check();
    await controller.check();
    expect((await controller.status()).overlaps).toBeUndefined();
    // Once per queue, with the exact text the examples assert.
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].message).toBe(
      `queue "renders" has a summoned worker naming no summon group while group "media"'s shared unit serves the queue: a per-queue controller's unit, a unit from a build older than the group, or one an older bun-jobs summoned while this group served a single queue. Keep one summoning controller per queue`,
    );
    expect(warnings()[0].fields).toMatchObject({
      queue: "renders",
      id: "sm_perqueue",
    });
  });

  it("lists a shared unit's group on a per-queue controller's queue", async () => {
    const { driver, namespace } = await freshDriver();
    await summonedWorker(driver, namespace, "emails", {
      id: "sm_unit",
      group: "media",
    });
    const { logger, events } = createTestLogger();
    const controller = new SummonController({
      ...QUIET,
      driver,
      namespace,
      queue: "emails",
      summoner: recording().summoner,
      logger,
    });
    perTest.unshift(async () => await controller.close());
    await controller.check();
    expect((await controller.status()).overlaps).toEqual(["media"]);
    expect(
      events.filter(
        (event) =>
          event.level === "warn" &&
          event.message.includes('summon group "media"'),
      ),
    ).toHaveLength(1);
  });

  it("is as of the last check: an overlap gone is no longer listed", async () => {
    const { driver, namespace } = await freshDriver();
    const worker = new BunQueueWorker("thumbs", async () => null, {
      namespace,
      driver,
      logger: noopLogger,
      summon: { id: "sm_other", group: "other" },
    });
    void worker.run();
    await waitFor(
      async () =>
        (
          await driver.listWorkers!(
            { ns: namespace, queue: "thumbs" },
            Date.now(),
          )
        ).some((record) => record.id === worker.id),
      { timeout: 5_000 },
    );
    const { controller } = unitOver(driver, namespace, MEDIA);
    await controller.check();
    expect((await controller.status()).overlaps).toEqual(["other"]);
    await worker.close();
    await controller.check();
    expect((await controller.status()).overlaps).toBeUndefined();
  });
});

describe("a partial unit's event lists the queues it missed", () => {
  it("as missing, beside the partial:<queues> detail; a full registration has none", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, "renders");
    await seed(driver, namespace, "thumbs");
    // The "platform" starts a unit that runs a worker for renders only.
    const summoner = defineSummoner({
      kind: "fake",
      invoke: async (request) => {
        const worker = new BunQueueWorker("renders", async () => null, {
          namespace,
          driver,
          logger: noopLogger,
          summon: { id: request.id, group: request.group! },
        });
        perTest.unshift(async () => await worker.close());
        void worker.run();
        return { status: "started", handles: [] };
      },
    });
    const controller = new SummonController({
      ...QUIET,
      driver,
      namespace,
      summoner,
      queues: ["renders", "thumbs"],
      group: SHARED,
      // The missing queue could still register until then.
      bootBudget: 400,
      logger: noopLogger,
    });
    perTest.unshift(async () => await controller.close());
    const events: SummonEventPayload[] = [];
    controller.on("summon", (event) => events.push(event));
    expect(await controller.check()).toMatchObject({ action: "summoned" });
    await waitFor(
      async () => {
        await controller.check();
        return events.some((event) => event.outcome === "registered");
      },
      { timeout: 10_000, interval: 50 },
    );
    const registered = events.find((event) => event.outcome === "registered")!;
    expect(registered.detail).toBe("partial:thumbs");
    expect(registered.missing).toEqual(["thumbs"]);
    // Every other event carries none.
    for (const event of events.filter((one) => one !== registered)) {
      expect(Object.hasOwn(event, "missing")).toBe(false);
    }
  });
});
