import type {
  JobsDriver,
  SummonControllerOptions,
  SummonEventPayload,
  SummonRequest,
} from "../lib/index";
import type { SummonClaim } from "../lib/summon/claim";
import type { SharedSummonMarker } from "../lib/summon/group";
import type {
  StoredSharedUnit,
  StoredSummonStatus,
} from "../lib/summon/status";
import { join } from "node:path";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test";
import { listWorkerRecords } from "../lib/drivers/index";
import {
  BunQueue,
  BunQueueWorker,
  createDriver,
  defineSummoner,
  SummonController,
} from "../lib/index";
import { START_TIME_SLACK } from "../lib/summon/claim";
import {
  COVERAGE_WARN_EVERY_MS,
  coverageOf,
  coverageWarner,
} from "../lib/summon/coverage";
import {
  MAX_SHARED_MEMBERS,
  readSharedMarker,
  summonGroupRef,
  summonGroupStateName,
} from "../lib/summon/group";
import { freshMarker, readMarker } from "../lib/summon/marker";
import {
  answeredMembers,
  currentUnitMembers,
  sharedUnitAnswers,
  sharedUnitFor,
} from "../lib/summon/status";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * A shared unit's per-queue coverage, `last.missing`, persisted `members`
 * and the group status's `unit` (plan summon-multi-queue B4, C1): the rule
 * itself on `coverageOf` with chosen times, and the rest through a real
 * controller on one file backend, with summoned workers run in-process.
 */

const dir = await makeTmpDir("bun-jobs-summon-coverage");
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

const MEDIA = ["renders", "thumbs", "previews"];

let unique = 0;

/** A fresh file driver on a fresh root, purged and closed after the test. */
async function freshDriver(): Promise<{
  driver: JobsDriver;
  namespace: string;
}> {
  const namespace = testNamespace("summon-coverage");
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

/** Adds one waiting job to each of `queues`. */
async function seed(
  driver: JobsDriver,
  namespace: string,
  queues: readonly string[],
): Promise<void> {
  for (const name of queues) {
    const queue = new BunQueue(name, { namespace, driver, logger: noopLogger });
    await queue.add("a", {});
    await queue.close();
  }
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

/** A controller closed after the test (before its driver). */
function build(options: SummonControllerOptions): SummonController {
  const controller = new SummonController({ ...QUIET, ...options });
  perTest.unshift(async () => await controller.close());
  return controller;
}

/** A shared unit over `queues` in group `media`. */
function shared(
  driver: JobsDriver,
  namespace: string,
  extra: Partial<SummonControllerOptions> = {},
): SummonControllerOptions {
  return {
    driver,
    namespace,
    summoner: recording().summoner,
    queues: MEDIA,
    group: { name: "media", unit: "shared" },
    ...extra,
  };
}

/**
 * A summoned worker of attempt `id` on `queue`, holding the job it takes
 * until `release()` (or the test's end).
 */
function summoned(
  driver: JobsDriver,
  namespace: string,
  queue: string,
  id: string,
): { worker: BunQueueWorker<unknown, void>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = new BunQueueWorker(queue, async () => await held, {
    namespace,
    driver,
    logger: noopLogger,
    concurrency: 1,
    pollInterval: 20,
    reportInterval: 2_000,
    summon: { id, group: "media" },
  });
  void worker.run();
  perTest.unshift(async () => {
    release();
    await worker.close();
  });
  return { worker, release };
}

/** Waits until `worker`'s record is listed on `queue`. */
async function listed(
  driver: JobsDriver,
  namespace: string,
  queue: string,
  worker: BunQueueWorker<unknown, void>,
): Promise<void> {
  await waitFor(
    async () =>
      (
        await listWorkerRecords(driver, { ns: namespace, queue }, Date.now())
      ).some((one) => one.id === worker.id),
    { timeout: 5_000, interval: 20 },
  );
}

/** The group entry's stored value. */
async function entryOf(
  driver: JobsDriver,
  namespace: string,
  name = "media",
): Promise<Record<string, any>> {
  const stored = await driver.getQueueState!(
    summonGroupRef(namespace),
    summonGroupStateName(name),
  );
  return stored!.value as Record<string, any>;
}

/* --- the rule ------------------------------------------------------------- */

describe("coverageOf: the rule", () => {
  const until = 1_000_000;
  const attempt = { id: "sm_a", until };
  const holder = (fields: Partial<SummonClaim["holders"][number]>) => ({
    worker: "w1",
    host: "h",
    pid: 1,
    at: until - 10_000,
    until: until - 5_000,
    ...fields,
  });

  it("is pending until until + the 5 s allowance, then missing, with nothing there", () => {
    const at = (now: number) =>
      coverageOf(attempt, ["a"], new Map(), new Map(), now).a;
    expect(START_TIME_SLACK).toBe(5_000);
    expect(at(until - 1)).toBe("pending");
    expect(at(until + 1_000)).toBe("pending");
    expect(at(until + START_TIME_SLACK - 1)).toBe("pending");
    expect(at(until + START_TIME_SLACK)).toBe("missing");
    expect(at(until + 6_000)).toBe("missing");
  });

  it("keeps a holder still inside its grace pending past until, never missing", () => {
    // Claimed, no record yet, its own grace running past the attempt's.
    const claim: SummonClaim = {
      capacity: 1,
      holders: [holder({ until: until + 60_000 })],
      at: until - 10_000,
    };
    const now = until + 30_000;
    expect(
      coverageOf(attempt, ["a"], new Map([["a", claim]]), new Map(), now).a,
    ).toBe("pending");
    // Once its grace has passed too, it died: missing.
    expect(
      coverageOf(
        attempt,
        ["a"],
        new Map([["a", claim]]),
        new Map(),
        until + 66_000,
      ).a,
    ).toBe("missing");
  });

  it("registers a holder gone with a clean exit mark, and one live by its record", () => {
    const gone: SummonClaim = {
      capacity: 1,
      holders: [
        holder({ exit: { exitedAt: until - 1, reason: "idle", code: 0 } }),
      ],
      at: until - 10_000,
    };
    const live: SummonClaim = {
      capacity: 1,
      holders: [holder({ worker: "w2" })],
      at: until - 10_000,
    };
    const failed: SummonClaim = {
      capacity: 1,
      holders: [
        holder({ exit: { exitedAt: until - 1, reason: "error", code: 1 } }),
      ],
      at: until - 10_000,
    };
    const coverage = coverageOf(
      attempt,
      ["a", "b", "c", "d"],
      new Map([
        ["a", gone],
        ["b", live],
        ["c", failed],
      ]),
      new Map([
        ["b", [{ id: "w2" } as never]],
        // No claim on d: a live record carrying the id is the evidence.
        ["d", [{ id: "w9", summon: { id: "sm_a" } } as never]],
      ]),
      until + 10_000,
    );
    expect({ ...coverage }).toEqual({
      a: "registered",
      b: "registered",
      c: "missing",
      d: "registered",
    });
  });

  it("keys a queue named __proto__ as its own key, on a null prototype", () => {
    const coverage = coverageOf(
      attempt,
      ["renders", "__proto__"],
      new Map(),
      new Map(),
      until - 1,
    );
    expect(Object.getPrototypeOf(coverage)).toBeNull();
    expect(Object.hasOwn(coverage, "__proto__")).toBe(true);
    expect(Object.keys(coverage)).toEqual(["renders", "__proto__"]);
  });
});

/* --- through a controller ------------------------------------------------- */

describe("a shared unit's status carries each attempt's coverage", () => {
  it("pending everywhere before a worker, registered where one runs, and after it left cleanly", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, MEDIA);
    const controller = build(shared(driver, namespace));
    expect(await controller.check()).toMatchObject({ action: "summoned" });
    const before = await controller.status();
    expect(before.pending).toHaveLength(1);
    const id = before.pending[0].id;
    expect({ ...before.pending[0].coverage }).toEqual({
      renders: "pending",
      thumbs: "pending",
      previews: "pending",
    });
    // One of the unit's workers, on renders only.
    const { worker, release } = summoned(driver, namespace, "renders", id);
    await listed(driver, namespace, "renders", worker);
    const running = await controller.status();
    expect({ ...running.pending[0].coverage }).toEqual({
      renders: "registered",
      thumbs: "pending",
      previews: "pending",
    });
    // It closes: its record goes, its claim keeps a clean exit mark — still
    // registered (a rule reading records alone would say pending).
    release();
    await worker.close();
    expect(
      (
        await listWorkerRecords(
          driver,
          { ns: namespace, queue: "renders" },
          Date.now(),
        )
      ).some((one) => one.id === worker.id),
    ).toBe(false);
    const after = await controller.status();
    expect(after.pending[0].coverage!.renders).toBe("registered");
  });

  it("never stores coverage, and decorates copies of the marker's attempts", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, ["renders"]);
    const controller = build(
      shared(driver, namespace, {
        jobsPerWorker: 1,
        maxWorkers: 5,
        maxPending: 3,
      }),
    );
    expect(await controller.check()).toMatchObject({ action: "summoned" });
    const status = await controller.status();
    expect(status.pending[0].coverage).toBeDefined();
    // More work: the next check claims a second attempt, writing the marker
    // back with the first one in it.
    await seed(driver, namespace, ["renders", "renders"]);
    expect(await controller.check()).toMatchObject({ action: "summoned" });
    const entry = await entryOf(driver, namespace);
    expect(entry.pending).toHaveLength(2);
    for (const attempt of entry.pending as Record<string, unknown>[]) {
      expect(Object.hasOwn(attempt, "coverage")).toBe(false);
    }
  });

  it("is absent for a controller of one queue", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, ["emails"]);
    const controller = build({
      driver,
      namespace,
      queue: "emails",
      summoner: recording().summoner,
    });
    await controller.check();
    const status = await controller.status();
    expect(status.pending).toHaveLength(1);
    expect(Object.hasOwn(status.pending[0], "coverage")).toBe(false);
  });

  it("covers a member named __proto__ as an own key", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, ["renders", "__proto__"]);
    const controller = build(
      shared(driver, namespace, { queues: ["renders", "__proto__"] }),
    );
    await controller.check();
    const coverage = (await controller.status()).pending[0].coverage!;
    expect(Object.hasOwn(coverage, "__proto__")).toBe(true);
    expect(Object.keys(coverage)).toEqual(["renders", "__proto__"]);
  });
});

describe("a shared unit's members, unit and partial outcome", () => {
  it("persists members equal to its queues, in order, at every claim", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, MEDIA);
    const controller = build(
      shared(driver, namespace, { queues: ["thumbs", "renders", "previews"] }),
    );
    await controller.check();
    expect((await entryOf(driver, namespace)).members).toEqual([
      "thumbs",
      "renders",
      "previews",
    ]);
  });

  it("names its group's status unit: shared; a per-queue group has none", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, [...MEDIA, "emails"]);
    const unit = build(shared(driver, namespace));
    await unit.check();
    expect((await unit.status()).group!.unit).toBe("shared");
    const perQueue = build({
      driver,
      namespace,
      queue: "emails",
      summoner: recording().summoner,
      group: { name: "mail" },
    });
    await perQueue.check();
    const group = (await perQueue.status()).group!;
    expect(group.name).toBe("mail");
    expect(Object.hasOwn(group, "unit")).toBe(false);
  });

  it("stores last.missing with a partial registration, beside its detail", async () => {
    const { driver, namespace } = await freshDriver();
    await seed(driver, namespace, ["renders", "thumbs"]);
    // The "platform" starts a unit that runs a worker for renders only.
    const summoner = defineSummoner({
      kind: "fake",
      invoke: async (request) => {
        summoned(driver, namespace, "renders", request.id);
        return { status: "started", handles: [] };
      },
    });
    const controller = build(
      shared(driver, namespace, {
        summoner,
        queues: ["renders", "thumbs"],
        bootBudget: 400,
      }),
    );
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
    const expected = {
      outcome: "registered",
      detail: "partial:thumbs",
      missing: ["thumbs"],
    };
    expect((await controller.status()).last).toMatchObject(expected);
    expect((await entryOf(driver, namespace)).last).toMatchObject(expected);
    // The event says the same.
    const event = events.find((one) => one.outcome === "registered")!;
    expect(event.missing).toEqual(["thumbs"]);
  });
});

describe("reading what older or newer builds stored", () => {
  it("drops a last.missing that is not a list of names, and keeps the marker", () => {
    const now = Date.now();
    const value = {
      ...freshMarker(now),
      last: {
        id: "sm_x",
        outcome: "registered",
        at: now,
        detail: "partial:thumbs",
        missing: "thumbs",
      },
    };
    const read = readMarker({ value, version: 3 }, now);
    expect(read.unreadable).toBe(false);
    expect(read.marker.last).toEqual({
      id: "sm_x",
      outcome: "registered",
      at: now,
      detail: "partial:thumbs",
    });
    // A well-formed one is kept.
    const kept = readMarker(
      {
        value: { ...value, last: { ...value.last, missing: ["thumbs"] } },
        version: 3,
      },
      now,
    );
    expect(kept.marker.last!.missing).toEqual(["thumbs"]);
  });

  it("drops a malformed members, and keeps a well-formed one", () => {
    const now = Date.now();
    for (const members of ["renders", [], ["renders", 3], ["a", "a"], [""]]) {
      const read = readSharedMarker(
        { value: { ...freshMarker(now), members }, version: 2 },
        now,
      );
      expect(read.unreadable).toBe(false);
      expect(Object.hasOwn(read.marker, "members")).toBe(false);
    }
    const read = readSharedMarker(
      {
        value: { ...freshMarker(now), members: ["renders", "thumbs"] },
        version: 2,
      },
      now,
    );
    expect(read.marker.members).toEqual(["renders", "thumbs"]);
  });
});

/* --- reading a unit from storage: the rules (review round) ---------------- */

describe("reading a unit from storage: which unit, and whether it is current", () => {
  const now = Date.now();
  /** A stored unit for `group` over `members`, last claimed at `at`. */
  const unitOf = (
    group: string,
    members: string[],
    at: number | undefined,
  ): StoredSharedUnit => ({
    group,
    members,
    ...(at === undefined ? {} : { lastAttemptAt: at }),
    status: {
      queue: members[0],
      queues: members,
      local: false,
      inert: false,
      pending: [],
      failures: 0,
    },
  });
  /** A queue's own stored status. */
  const ownOf = (
    at: number | undefined,
    extra: Partial<StoredSummonStatus> = {},
  ): StoredSummonStatus => ({
    ...(at === undefined ? {} : { lastAttemptAt: at }),
    status: {
      queue: "thumbs",
      local: false,
      inert: false,
      pending: [],
      failures: 0,
    },
    ...extra,
  });

  it("lets the unit answer on equal claim times, and only then or later", () => {
    const unit = unitOf("media", MEDIA, 1_000);
    expect(sharedUnitAnswers(unit, ownOf(1_000))).toBe(true);
    expect(sharedUnitAnswers(unit, ownOf(999))).toBe(true);
    expect(sharedUnitAnswers(unit, ownOf(1_001))).toBe(false);
    expect(sharedUnitAnswers(unit, undefined)).toBe(true);
  });

  it("lets the unit answer over an unreadable own marker, and a newer build's undated one answer for itself", () => {
    const unit = unitOf("media", MEDIA, 1_000);
    expect(
      sharedUnitAnswers(unit, ownOf(undefined, { unreadable: true })),
    ).toBe(true);
    const newer = ownOf(undefined);
    newer.status = {
      ...newer.status,
      inert: true,
      inertReason: "newer-marker",
    };
    expect(sharedUnitAnswers(unit, newer)).toBe(false);
    // This build's marker before any claim: the unit, which has claimed.
    expect(sharedUnitAnswers(unit, ownOf(undefined))).toBe(true);
  });

  it("answers an overlapping queue by the unit that claimed last, by group name on a tie", () => {
    const older = unitOf("a-media", ["renders", "thumbs"], 1_000);
    const newer = unitOf("z-media", ["thumbs", "previews"], 2_000);
    expect(sharedUnitFor([older, newer], "thumbs")).toBe(newer);
    expect(sharedUnitFor([newer, older], "thumbs")).toBe(newer);
    expect(sharedUnitFor([older, newer], "renders")).toBe(older);
    const tie = unitOf("b-media", ["thumbs"], 2_000);
    expect(sharedUnitFor([newer, tie], "thumbs")).toBe(tie);
    expect(sharedUnitFor([tie, newer], "thumbs")).toBe(tie);
    expect(sharedUnitFor([older, newer], "emails")).toBeUndefined();
  });

  it("names the members a unit answers for: not one that answers for itself, nor one another unit has", () => {
    const unit = unitOf("media", MEDIA, 1_000);
    const other = unitOf("other", ["previews"], 2_000);
    expect(
      answeredMembers(unit, [unit, other], new Map([["thumbs", ownOf(1_500)]])),
    ).toEqual(["renders"]);
  });

  /** A shared unit's entry as read: last claimed at `at`. */
  const entry = (
    fields: Partial<SharedSummonMarker>,
    at: number | null = 1_000,
  ): SharedSummonMarker => ({
    ...freshMarker(now),
    ...(at === null ? {} : { lastAttemptAt: at }),
    ...fields,
  });

  it("is a current unit while no per-queue charge on a member is newer than its last claim", () => {
    const shares = {
      renders: { day: 1, lastAt: 1_000 },
      thumbs: { day: 1, lastAt: 1_000 },
    };
    expect(
      currentUnitMembers(
        entry({ members: ["renders", "thumbs"], queues: shares }),
      ),
    ).toEqual(["renders", "thumbs"]);
    // A per-queue controller charged thumbs after the unit's last claim:
    // thumbs has a controller of its own again; renders is still the unit's.
    expect(
      currentUnitMembers(
        entry({
          members: ["renders", "thumbs"],
          queues: { ...shares, thumbs: { day: 2, lastAt: 1_500 } },
        }),
      ),
    ).toEqual(["renders"]);
    // Every member charged since: the group went back to per-queue
    // controllers, and there is no unit.
    expect(
      currentUnitMembers(
        entry({
          members: ["renders", "thumbs"],
          queues: {
            renders: { day: 2, lastAt: 1_200 },
            thumbs: { day: 2, lastAt: 1_500 },
          },
        }),
      ),
    ).toBeUndefined();
    // A newer charge on a queue that is not a member changes nothing.
    expect(
      currentUnitMembers(
        entry({
          members: ["renders", "thumbs"],
          queues: { ...shares, emails: { day: 1, lastAt: 9_000 } },
        }),
      ),
    ).toEqual(["renders", "thumbs"]);
    // No claim at all: no unit.
    expect(
      currentUnitMembers(entry({ members: ["renders"] }, null)),
    ).toBeUndefined();
  });

  it("reads an entry written before members by the shares its last claim stamped", () => {
    expect(
      currentUnitMembers(
        entry({
          queues: {
            thumbs: { day: 1, lastAt: 1_000 },
            renders: { day: 1, lastAt: 1_000 },
            // A per-queue member of a mixed group, charged at its own time.
            solo: { day: 3, lastAt: 800 },
          },
        }),
      ),
    ).toEqual(["renders", "thumbs"]);
    expect(
      currentUnitMembers(entry({ queues: { solo: { day: 1, lastAt: 800 } } })),
    ).toBeUndefined();
  });

  it("drops members that are not valid queue names, or too many, and falls back on the shares", () => {
    const at = Date.now();
    const shares = {
      renders: { day: 1, lastAt: at },
      thumbs: { day: 1, lastAt: at },
    };
    for (const members of [
      ["renders", "a:b"],
      ["renders", "__bunjobs"],
      ["renders", "x".repeat(201)],
      ["renders", ".."],
      Array.from({ length: MAX_SHARED_MEMBERS + 1 }, (_, index) => `q${index}`),
    ]) {
      const read = readSharedMarker(
        {
          value: {
            ...freshMarker(at),
            lastAttemptAt: at,
            members,
            queues: shares,
          },
          version: 2,
        },
        at,
      );
      expect(read.unreadable).toBe(false);
      expect(Object.hasOwn(read.marker, "members")).toBe(false);
      expect(currentUnitMembers(read.marker)).toEqual(["renders", "thumbs"]);
    }
    const most = Array.from(
      { length: MAX_SHARED_MEMBERS },
      (_, index) => `q${index}`,
    );
    expect(
      readSharedMarker(
        { value: { ...freshMarker(at), members: most }, version: 2 },
        at,
      ).marker.members,
    ).toHaveLength(MAX_SHARED_MEMBERS);
  });
});

describe("a failed coverage read is logged at most once a minute", () => {
  it("warns once, then again only after COVERAGE_WARN_EVERY_MS", () => {
    const { logger, events } = createTestLogger();
    const start = Date.now();
    try {
      setSystemTime(start);
      const warn = coverageWarner(logger, { group: "media" });
      warn(new Error("one"));
      warn(new Error("two"));
      expect(events.filter((event) => event.level === "warn")).toHaveLength(1);
      setSystemTime(start + COVERAGE_WARN_EVERY_MS);
      warn(new Error("three"));
      const warned = events.filter((event) => event.level === "warn");
      expect(warned).toHaveLength(2);
      expect(warned[0].fields).toMatchObject({ group: "media" });
    } finally {
      setSystemTime();
    }
  });
});
