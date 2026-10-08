import type {
  JobsDriver,
  SummonOption,
  SummonPolicy,
  SummonRequest,
} from "../lib/index";
import type { SpawnedUnit } from "../lib/provider/testing/spawn";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
  spyOn,
} from "bun:test";
import {
  BunJobs,
  ConfigError,
  createDriver,
  defineSummoner,
  SummonController,
} from "../lib/index";
import { unitLines, unitSpawner } from "../lib/provider/testing/spawn";
import { expandSummonOption } from "../lib/summon/groups";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * Summon groups: one policy written once for several queues in the `summon`
 * option, `[{ queues: ["emails", "images"], summoner, … }]`. A group is
 * shorthand — it expands into one ordinary `SummonController` per queue,
 * each with its own marker, budget and backoff — so these tests check the
 * expansion and its refusals, then run a group end to end across processes,
 * with one entry file serving both queues.
 */

setDefaultTimeout(60_000);

const tmp = await makeTmpDir("bun-jobs-summon-groups");
const DRIVER = {
  type: "sql",
  url: `sqlite://${join(tmp.path, "jobs.db")}`,
} as const;
const cleanups: (() => Promise<void>)[] = [tmp.cleanup];
afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup().catch(() => {});
  }
});

const perTest: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of perTest.splice(0)) {
    await cleanup().catch(() => {});
  }
});

/** Triggers off and no cooldown: every check is one the test asked for. */
const QUIET = {
  triggers: { onAdd: false, events: false, poll: false },
  cooldown: 0,
} as const satisfies Partial<SummonPolicy>;

/** A summoner recording each request, starting nothing. */
function recorder(): {
  summoner: SummonPolicy["summoner"];
  calls: SummonRequest[];
} {
  const calls: SummonRequest[] = [];
  return {
    calls,
    summoner: async (request) => {
      calls.push(request);
    },
  };
}

/** A fresh SQLite driver, closed after the test. */
function sqliteDriver(): JobsDriver {
  const driver = createDriver(DRIVER);
  perTest.push(async () => await driver.close());
  return driver;
}

/** A context with this `summon` option on a fresh namespace, closed and purged after the test. */
function context(driver: JobsDriver, summon: SummonOption): BunJobs {
  const namespace = testNamespace("summon-groups");
  const jobs = new BunJobs({ namespace, driver, logger: noopLogger, summon });
  perTest.unshift(async () => {
    await jobs.close();
    await driver.purge(namespace);
  });
  return jobs;
}

/** What `new BunJobs` throws for this `summon` option, or `undefined`. */
function refusal(summon: SummonOption): unknown {
  try {
    const jobs = new BunJobs({
      namespace: testNamespace("summon-groups-refused"),
      driver: sqliteDriver(),
      logger: noopLogger,
      summon,
    });
    perTest.unshift(async () => await jobs.close());
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("summon groups: the expansion", () => {
  it("builds one controller per queue of a group, each its own, and summonController() returns each", () => {
    const { summoner } = recorder();
    const jobs = context(sqliteDriver(), [
      { queues: ["emails", "images"], summoner, ...QUIET },
    ]);
    const emails = jobs.summonController("emails");
    const images = jobs.summonController("images");
    expect(emails).toBeInstanceOf(SummonController);
    expect(images).toBeInstanceOf(SummonController);
    expect(emails).not.toBe(images);
    expect(emails.queue).toBe("emails");
    expect(images.queue).toBe("images");
    // Nothing for the array's indexes: a group is not a record.
    expect(() => jobs.summonController("0")).toThrow(ConfigError);
    expect(() => jobs.summonController("queues")).toThrow(ConfigError);
  });

  it("gives each queue its own marker: a summon for one leaves the other's untouched", async () => {
    const { summoner, calls } = recorder();
    const jobs = context(sqliteDriver(), [
      { queues: ["emails", "images"], summoner, ...QUIET },
    ]);
    await jobs.queue("emails").add("welcome", {});

    expect(await jobs.summonController("emails").check()).toMatchObject({
      action: "summoned",
    });
    expect(await jobs.summonController("images").check()).toMatchObject({
      action: "none",
    });
    expect(calls.map((call) => call.queue)).toEqual(["emails"]);

    const emails = await jobs.summonController("emails").status();
    const images = await jobs.summonController("images").status();
    expect(emails.pending.map((one) => one.id)).toEqual([calls[0]!.id]);
    expect(emails.budget?.hour).toBe(1);
    expect(images.pending).toEqual([]);
    expect(images.budget?.hour).toBe(0);
  });

  it("budgets per queue: the group's perHour applies to each queue, not to the group", async () => {
    const { summoner, calls } = recorder();
    const jobs = context(sqliteDriver(), [
      {
        queues: ["emails", "images"],
        summoner,
        ...QUIET,
        bootBudget: 1,
        budget: { perHour: 1 },
      },
    ]);
    await jobs.queue("emails").add("a", {});
    await jobs.queue("images").add("b", {});
    expect(await jobs.summonController("emails").check()).toMatchObject({
      action: "summoned",
    });
    // Its own budget, untouched by the emails summon.
    expect(await jobs.summonController("images").check()).toMatchObject({
      action: "summoned",
    });
    expect(calls.map((call) => call.queue).sort()).toEqual([
      "emails",
      "images",
    ]);
  });

  it("applies an override to its queue alone", async () => {
    const { summoner, calls } = recorder();
    const jobs = context(sqliteDriver(), [
      {
        queues: ["emails", "images"],
        summoner,
        ...QUIET,
        maxWorkers: 1,
        jobsPerWorker: 1,
        overrides: { images: { maxWorkers: 3 } },
      },
    ]);
    for (const name of ["emails", "images"]) {
      await jobs
        .queue(name)
        .addBulk([1, 2, 3].map((index) => ({ name: "job", data: { index } })));
    }
    await jobs.summonController("emails").check();
    await jobs.summonController("images").check();

    const count = (queue: string): number =>
      calls
        .filter((call) => call.queue === queue)
        .reduce((sum, call) => sum + call.count, 0);
    expect(count("emails")).toBe(1);
    expect(count("images")).toBe(3);
  });

  it("accepts groups and records together, in one array", () => {
    const { summoner } = recorder();
    const other = recorder().summoner;
    const jobs = context(sqliteDriver(), [
      { queues: ["emails", "images"], summoner, ...QUIET },
      { reports: { summoner: other, ...QUIET } },
      { queues: ["exports"], summoner: other, ...QUIET },
    ]);
    for (const queue of ["emails", "images", "reports", "exports"]) {
      expect(jobs.summonController(queue).queue).toBe(queue);
    }
  });

  it("keeps the record form working unchanged", () => {
    const { summoner } = recorder();
    const record: Record<string, SummonPolicy> = {
      emails: { summoner, ...QUIET },
      images: { summoner, ...QUIET },
    };
    const jobs = context(sqliteDriver(), record);
    expect(jobs.summonController("emails").queue).toBe("emails");
    expect(jobs.summonController("images").queue).toBe("images");
  });

  it("finds no inherited property as a queue's policy", () => {
    const { summoner } = recorder();
    const jobs = context(sqliteDriver(), {
      emails: { summoner, ...QUIET },
    });
    // Before the option was a Map, `toString` found Object.prototype's and
    // failed later, as a summoner that is not a function.
    expect(() => jobs.summonController("toString")).toThrow(
      /No summon policy for queue "toString"/,
    );
  });
});

describe("summon groups: refusals", () => {
  /** Asserts `error` is a `ConfigError` whose message names `queue`. */
  function expectNamed(error: unknown, queue: string): void {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain(`"${queue}"`);
    expect((error as ConfigError).context).toMatchObject({ queue });
  }

  const { summoner } = recorder();

  it("refuses a queue named twice across groups", () => {
    expectNamed(
      refusal([
        { queues: ["emails", "images"], summoner, ...QUIET },
        { queues: ["reports", "images"], summoner, ...QUIET },
      ]),
      "images",
    );
  });

  it("refuses a queue named twice in one group", () => {
    expectNamed(
      refusal([{ queues: ["emails", "emails"], summoner, ...QUIET }]),
      "emails",
    );
  });

  it("refuses a queue named in a group and in a record", () => {
    expectNamed(
      refusal([
        { emails: { summoner, ...QUIET } },
        { queues: ["images", "emails"], summoner, ...QUIET },
      ]),
      "emails",
    );
    expectNamed(
      refusal([
        { queues: ["images", "emails"], summoner, ...QUIET },
        { emails: { summoner, ...QUIET } },
      ]),
      "emails",
    );
  });

  it("refuses a group with no queues", () => {
    const error = refusal([{ queues: [], summoner, ...QUIET }]);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain(
      "summon[0].queues is empty",
    );
  });

  it("refuses a queues that is not an array of names", () => {
    const error = refusal([
      { queues: "emails", summoner },
    ] as unknown as SummonOption);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain("summon[0].queues");
  });

  it("refuses an override for a queue its group does not name", () => {
    expectNamed(
      refusal([
        {
          queues: ["emails"],
          summoner,
          ...QUIET,
          overrides: { images: { maxWorkers: 2 } },
        },
      ]),
      "images",
    );
  });

  it("starts nothing when the option is refused", () => {
    const close = spyOn(SummonController.prototype, "close");
    try {
      expect(
        refusal([
          { queues: ["emails"], summoner, ...QUIET },
          { queues: ["images", "emails"], summoner, ...QUIET },
        ]),
      ).toBeInstanceOf(ConfigError);
      // Refused while expanding, before any controller was built.
      expect(close).toHaveBeenCalledTimes(0);
    } finally {
      close.mockRestore();
    }
  });

  it("closes the controllers a group started when a later queue is refused", () => {
    const close = spyOn(SummonController.prototype, "close");
    try {
      // A hand-built summoner passes the expansion and fails the
      // controller's own check, after `emails` and `images` were built.
      const error = refusal([
        {
          queues: ["emails", "images", "reports"],
          summoner,
          ...QUIET,
          overrides: {
            reports: { summoner: {} as unknown as SummonPolicy["summoner"] },
          },
        },
      ]);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain("summoner");
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      close.mockRestore();
    }
  });
});

describe("summon groups: more refusals, and null", () => {
  const { summoner } = recorder();

  it("refuses an invalid queue name in a group, saying where, before any controller is built", () => {
    const close = spyOn(SummonController.prototype, "close");
    try {
      const error = refusal([
        { queues: ["emails", "images", "bad name"], summoner, ...QUIET },
      ]);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('"bad name"');
      expect((error as ConfigError).message).toContain("summon[0].queues[2]");
      // Refused while expanding: nothing was built, so nothing was closed.
      expect(close).toHaveBeenCalledTimes(0);
    } finally {
      close.mockRestore();
    }
  });

  it("refuses an invalid queue name in a record, saying where", () => {
    const error = refusal([{ "bad/name": { summoner, ...QUIET } }]);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain("summon[0].bad/name");
  });

  it("accepts summon: null like undefined, building nothing", () => {
    const jobs = context(sqliteDriver(), null as unknown as SummonOption);
    expect(() => jobs.summonController("emails")).toThrow(
      /No summon policy for queue "emails"/,
    );
    expect(expandSummonOption(null).size).toBe(0);
  });

  it("refuses a record entry that is not a policy, naming the queue", () => {
    for (const option of [
      [{ emails: undefined }],
      { emails: undefined },
    ] as unknown as SummonOption[]) {
      const error = refusal(option);
      expect(error).toBeInstanceOf(ConfigError);
      // At expansion, not later as "No summon policy for queue".
      expect((error as ConfigError).message).toContain(
        'must be a summon policy ({ summoner, … }) for queue "emails"',
      );
      expect((error as ConfigError).context).toMatchObject({
        queue: "emails",
      });
    }
  });

  it("refuses a hole in the array, naming its index", () => {
    // Index 1 is never assigned: a hole, not an `undefined`.
    const sparse: unknown[] = [{ queues: ["emails"], summoner }];
    sparse[2] = { reports: { summoner } };
    const error = refusal(sparse as unknown as SummonOption);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain("summon[1] is a hole");
  });
});

describe("summon groups: how an override merges", () => {
  const { summoner } = recorder();

  /** The policy `queue` expands to under `option`. */
  function expanded(option: SummonOption, queue: string): SummonPolicy {
    return expandSummonOption(option).get(queue)!;
  }

  it("merges plain-object fields one level deep, the override's over the group's", () => {
    const option: SummonOption = [
      {
        queues: ["emails", "images"],
        summoner,
        budget: { perHour: 20, perDay: 100 },
        triggers: { onAdd: false, poll: 500 },
        overrides: {
          images: { budget: { perHour: 5 }, triggers: { poll: false } },
        },
      },
    ];
    expect(expanded(option, "images")).toMatchObject({
      budget: { perHour: 5, perDay: 100 },
      triggers: { onAdd: false, poll: false },
    });
    expect(expanded(option, "images").budget).toEqual({
      perHour: 5,
      perDay: 100,
    });
    expect(expanded(option, "images").triggers).toEqual({
      onAdd: false,
      poll: false,
    });
    // The other queue keeps the group's, untouched.
    expect(expanded(option, "emails").budget).toEqual({
      perHour: 20,
      perDay: 100,
    });
    expect(expanded(option, "emails").triggers).toEqual({
      onAdd: false,
      poll: 500,
    });
  });

  it("merges backoff, circuit, scaleDown and env the same way", () => {
    const policy = expanded(
      [
        {
          queues: ["a"],
          summoner,
          backoff: { initial: 1_000, max: 9_000 },
          circuit: { failures: 3, resetAfter: 60_000 },
          scaleDown: { after: 5_000 },
          env: { REGION: "eu", TIER: "small" },
          overrides: {
            a: {
              backoff: { max: 2_000 },
              circuit: { failures: 1 },
              scaleDown: {},
              env: { TIER: "large" },
            },
          },
        },
      ],
      "a",
    );
    expect(policy.backoff).toEqual({ initial: 1_000, max: 2_000 });
    expect(policy.circuit).toEqual({ failures: 1, resetAfter: 60_000 });
    expect(policy.scaleDown).toEqual({ after: 5_000 });
    expect(policy.env).toEqual({ REGION: "eu", TIER: "large" });
  });

  it("replaces anything that is not a plain object on both sides: the summoner, numbers, false", () => {
    const other = defineSummoner({ kind: "other", invoke: async () => {} });
    const group = defineSummoner({ kind: "group", invoke: async () => {} });
    const policy = expanded(
      [
        {
          queues: ["a"],
          summoner: group,
          maxWorkers: 4,
          triggers: { poll: 500, debounce: 10 },
          overrides: {
            a: { summoner: other, maxWorkers: 1, triggers: { poll: false } },
          },
        },
      ],
      "a",
    );
    expect(policy.summoner).toBe(other);
    expect(policy.maxWorkers).toBe(1);
    expect(policy.triggers).toEqual({ poll: false, debounce: 10 });
  });

  it("lets a budget: false override turn the budget off, and an override's budget over a group's false turn it on", () => {
    // The general rule — `false` is not a plain object, so it replaces.
    const off = expanded(
      [
        {
          queues: ["a"],
          summoner,
          budget: { perHour: 20, perDay: 100 },
          overrides: { a: { budget: false } },
        },
      ],
      "a",
    );
    expect(off.budget).toBe(false);

    const on = expanded(
      [
        {
          queues: ["a"],
          summoner,
          budget: false,
          overrides: { a: { budget: { perHour: 5 } } },
        },
      ],
      "a",
    );
    expect(on.budget).toEqual({ perHour: 5 });
  });

  it("gives the controller what the override says: off for an overridden budget: false, the group's limits for the rest", async () => {
    const jobs = context(sqliteDriver(), [
      {
        queues: ["a", "b"],
        summoner,
        ...QUIET,
        budget: { perHour: 20, perDay: 100 },
        overrides: { a: { budget: false } },
      },
    ]);
    const a = (await jobs.summonController("a").status()).budget;
    expect(a).toMatchObject({ hour: 0, day: 0, off: true });
    expect(a).not.toHaveProperty("perHour");
    expect(a).not.toHaveProperty("perDay");
    const b = (await jobs.summonController("b").status()).budget;
    expect(b).toMatchObject({ perHour: 20, perDay: 100 });
    expect(b).not.toHaveProperty("off");
  });

  it("turns the budget on for an override's budget over a group's false, with the defaults for what it leaves out", async () => {
    const jobs = context(sqliteDriver(), [
      {
        queues: ["a", "b"],
        summoner,
        ...QUIET,
        budget: false,
        overrides: { a: { budget: { perHour: 5 } } },
      },
    ]);
    const a = (await jobs.summonController("a").status()).budget;
    expect(a).toMatchObject({ perHour: 5, perDay: 300 });
    expect(a).not.toHaveProperty("off");
    const b = (await jobs.summonController("b").status()).budget;
    expect(b).toMatchObject({ off: true });
    expect(b).not.toHaveProperty("perHour");
  });

  it("finds an override only by own key", () => {
    const overrides = Object.create({
      a: { maxWorkers: 9 },
    }) as Record<string, Partial<SummonPolicy>>;
    const policy = expanded(
      [{ queues: ["a"], summoner, maxWorkers: 2, overrides }],
      "a",
    );
    expect(policy.maxWorkers).toBe(2);
  });
});

/* --- end to end: a group across processes, one entry file ------------- */

/** The one entry file every summoned unit of the group runs. */
const GROUP_WORKER = join(
  import.meta.dir,
  "fixtures",
  "summoned-group-worker.ts",
);

const BACKENDS = await crossProcessBackends({ cleanups });

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `summon groups end to end: ${backend.name}`,
    () => {
      it("summons for each queue of a group independently, and one entry file serves both", async () => {
        const driver = createDriver(backend.config);
        await driver.connect();
        const namespace = testNamespace(`summon-group-${backend.name}`);
        const spawner = unitSpawner(GROUP_WORKER, {
          SUMMON_TEST_DRIVER: JSON.stringify(backend.config),
        });
        const calls: SummonRequest[] = [];
        let handles = 0;
        // A platform that starts the same file whatever the queue: the
        // request's argv is what tells the unit which queue it serves.
        const summoner = defineSummoner({
          kind: "fake",
          passes: "argv",
          bootBudget: 30_000,
          invoke: async (request) => {
            calls.push(request);
            void spawner.start({ argv: request.argv });
            return { status: "started", handles: [`unit-${++handles}`] };
          },
        });
        const jobs = new BunJobs({
          namespace,
          driver,
          logger: noopLogger,
          summon: [{ queues: ["emails", "images"], summoner, ...QUIET }],
        });
        perTest.unshift(async () => {
          await spawner.kill();
          await jobs.close();
          await driver.purge(namespace);
          await driver.close();
        });
        const emails = jobs.summonController("emails");
        const images = jobs.summonController("images");

        // Work on emails alone: only emails summons.
        const welcome = await jobs.queue("emails").add("welcome", {});
        expect(await emails.check()).toMatchObject({ action: "summoned" });
        expect(await images.check()).toMatchObject({ action: "none" });
        expect(calls.map((call) => call.queue)).toEqual(["emails"]);

        // Then images: its own attempt, under its own id.
        const thumb = await jobs.queue("images").add("thumbnail", {});
        expect(await images.check()).toMatchObject({ action: "summoned" });
        expect(calls.map((call) => call.queue)).toEqual(["emails", "images"]);
        expect(calls[0]!.id).not.toBe(calls[1]!.id);

        const completed = async (queue: string, id: string): Promise<boolean> =>
          (await jobs.queue(queue).getJob(id))?.state === "completed";
        await waitFor(
          async () =>
            (await completed("emails", welcome.id)) &&
            (await completed("images", thumb.id)),
          { timeout: 30_000 },
        );
        expect(
          (await jobs.queue("emails").getJob(welcome.id))?.returnValue,
        ).toMatchObject({ processor: "emails", job: "welcome" });
        expect(
          (await jobs.queue("images").getJob(thumb.id))?.returnValue,
        ).toMatchObject({ processor: "images", job: "thumbnail" });

        // Two units of one file, one per queue, each gone once idle.
        await spawner.settled();
        expect(spawner.spawned).toHaveLength(2);
        const lines = await Promise.all(
          spawner.spawned.map(
            async (unit: SpawnedUnit) => await unitLines(unit),
          ),
        );
        const served = lines.map(
          (unitOut) => unitOut.find((line) => line.event === "ready")?.queue,
        );
        expect(served.sort()).toEqual(["emails", "images"]);
        for (const unitOut of lines) {
          expect(unitOut.find((line) => line.event === "exit")).toMatchObject({
            reason: "idle",
          });
        }
        for (const unit of spawner.spawned) {
          expect(await unit.exited).toBe(0);
        }

        // Each marker settled its own attempt.
        await emails.check();
        await images.check();
        const emailsStatus = await emails.status();
        const imagesStatus = await images.status();
        expect(emailsStatus.last).toMatchObject({
          id: calls[0]!.id,
          outcome: "registered",
        });
        expect(imagesStatus.last).toMatchObject({
          id: calls[1]!.id,
          outcome: "registered",
        });
        expect(emailsStatus.pending).toEqual([]);
        expect(imagesStatus.pending).toEqual([]);
      });
    },
  );
}
