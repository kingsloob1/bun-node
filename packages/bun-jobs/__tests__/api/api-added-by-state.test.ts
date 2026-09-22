import type { JobRecord, JobsDriver } from "../../lib/index";
import type { HarnessResponse } from "./fixtures";
import process from "node:process";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test";
import {
  BunJobs,
  FileDriver,
  MAX_ADDED_BY_STATE_SPAN_MS,
  MemoryDriver,
  MongoDriver,
  RedisDriver,
  SqlDriver,
} from "../../lib/index";
import { makeJob, makeTmpDir, testNamespace } from "../helpers";
import { harness, openHarnesses } from "./fixtures";

/**
 * The jobs added in a range, by the state each is in now — `GET
 * /overview/added` and `GET /queues/{queue}/counts/added` — and `sort=createdAt`
 * on the job list, end to end through the management API over a real
 * `BunJobs`.
 *
 * Every case asserts what a parameter *excludes* as well as what it keeps: a
 * route that accepted `from`/`to` or `sort` and dropped it would answer 200
 * with a plausible body, which is exactly the bug a UI must never be shown.
 */

/** Undo steps, run as each case ends — exact names only. */
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  setSystemTime();
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
  for (const cleanup of cleanups.splice(0, cleanups.length).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

afterAll(async () => {
  for (const cleanup of cleanups.splice(0, cleanups.length).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

/** A fixed instant to build ranges around: 2023-11-14T22:13:20Z. */
const T = 1_700_000_000_000;

/** One hour, in ms. */
const HOUR = 3_600_000;

/** A context over `driver` in a namespace of the case's own, purged after. */
function context(driver: JobsDriver, label: string): BunJobs {
  const namespace = testNamespace(label);
  const jobs = new BunJobs({ namespace, driver });
  cleanups.push(async () => {
    await jobs.close();
    await driver.purge(namespace);
    await driver.close();
  });
  return jobs;
}

/** Stores records in a queue as they are, whatever state they claim. */
async function seed(
  jobs: BunJobs,
  queue: string,
  records: Partial<JobRecord>[],
): Promise<void> {
  const q = jobs.queue(queue);
  await q.connect();
  await jobs.driver.addJobs(
    q.ref,
    records.map((record) => makeJob(record)),
  );
}

/** A counts body with every state zero but those given. */
function counts(
  some: Partial<Record<JobRecord["state"], number>> = {},
): Record<JobRecord["state"], number> {
  return {
    waiting: 0,
    delayed: 0,
    active: 0,
    completed: 0,
    failed: 0,
    dead: 0,
    "waiting-children": 0,
    ...some,
  };
}

/** The ids of a page, in the order served. */
function order(response: HarnessResponse): string[] {
  expect(response.status).toBe(200);
  return (response.body.items as { id: string }[]).map((job) => job.id);
}

/**
 * Queue `a`'s jobs, one per state inside `[T, T + 1h)`, plus the edges: one
 * at exactly `T` (inclusive, counted), one at exactly `T + 1h` (exclusive,
 * not) and one a millisecond before `T` (not).
 */
async function seedQueueA(jobs: BunJobs): Promise<void> {
  await seed(jobs, "a", [
    { id: "a-edge-from", state: "waiting", createdAt: T },
    { id: "a-waiting", state: "waiting", createdAt: T + 10 },
    {
      id: "a-delayed",
      state: "delayed",
      createdAt: T + 20,
      runAt: T + 5 * HOUR,
    },
    {
      id: "a-active",
      state: "active",
      createdAt: T + 30,
      lockToken: "tok",
      lockExpiresAt: T + 10 * HOUR,
      processedOn: T + 31,
      workerId: "w",
    },
    {
      id: "a-completed-1",
      state: "completed",
      createdAt: T + 40,
      finishedOn: T + 41,
      processedOn: T + 40,
    },
    {
      id: "a-completed-2",
      state: "completed",
      createdAt: T + 50,
      finishedOn: T + 51,
      processedOn: T + 50,
    },
    {
      id: "a-failed",
      state: "failed",
      createdAt: T + 60,
      runAt: T + 2 * HOUR,
      attemptsMade: 1,
      maxAttempts: 3,
    },
    {
      id: "a-dead",
      state: "dead",
      createdAt: T + 70,
      finishedOn: T + 71,
      attemptsMade: 1,
    },
    { id: "a-children", state: "waiting-children", createdAt: T + 80 },
    { id: "a-edge-to", state: "waiting", createdAt: T + HOUR },
    { id: "a-before", state: "completed", createdAt: T - 1, finishedOn: T + 5 },
  ]);
}

/** What `seedQueueA` puts in `[T, T + 1h)`. */
const A_COUNTS = counts({
  waiting: 2,
  delayed: 1,
  active: 1,
  completed: 2,
  failed: 1,
  dead: 1,
  "waiting-children": 1,
});

/** The range every counting case reads: `[T, T + 1h)`. */
const RANGE = `from=${T}&to=${T + HOUR}`;

describe("added by state: the counts", () => {
  it("counts each state of one queue's jobs added in the range, edges inclusive and exclusive", async () => {
    const jobs = context(new MemoryDriver(), "added-queue");
    await seedQueueA(jobs);
    const h = harness({ jobs });

    const read = await h.call("GET", `/queues/a/counts/added?${RANGE}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      from: T,
      to: T + HOUR,
      counts: A_COUNTS,
      total: 9,
      queues: 1,
    });
    expect(typeof read.body.at).toBe("number");

    // The edges, one at a time: `from` inclusive (the job at exactly `T`),
    // `to` exclusive (the job at exactly `T + 1h`).
    const after = await h.call(
      "GET",
      `/queues/a/counts/added?from=${T + 1}&to=${T + HOUR + 1}`,
    );
    expect(after.body.counts.waiting).toBe(2); // lost a-edge-from, gained a-edge-to
    expect(after.body.total).toBe(9);
    const narrow = await h.call(
      "GET",
      `/queues/a/counts/added?from=${T}&to=${T + 1_000}`,
    );
    expect(narrow.body.counts).toEqual(A_COUNTS);
    const early = await h.call(
      "GET",
      `/queues/a/counts/added?from=${T - 1_000}&to=${T}`,
    );
    // Only a-before, created at T − 1: `to` = T excludes a-edge-from.
    expect(early.body.counts).toEqual(counts({ completed: 1 }));
    expect(early.body.total).toBe(1);

    // Date-times are accepted as well as epoch ms, meaning the same range.
    const iso = await h.call(
      "GET",
      `/queues/a/counts/added?from=${new Date(T).toISOString()}&to=${new Date(T + HOUR).toISOString()}`,
    );
    expect(iso.body.counts).toEqual(A_COUNTS);
  });

  it("does not count a job removed since it was added", async () => {
    const jobs = context(new MemoryDriver(), "added-removed");
    await seedQueueA(jobs);
    const h = harness({ jobs });
    expect(await jobs.queue("a").remove("a-completed-1")).toBe(true);

    const read = await h.call("GET", `/queues/a/counts/added?${RANGE}`);
    expect(read.body.counts).toEqual({ ...A_COUNTS, completed: 1 });
    expect(read.body.total).toBe(8);
    const all = await h.call("GET", `/overview/added?${RANGE}`);
    expect(all.body.counts).toEqual({ ...A_COUNTS, completed: 1 });
  });

  it("counts jobs added through the queue by their own creation time, scheduled runs as delayed", async () => {
    const jobs = context(new MemoryDriver(), "added-real");
    const queue = jobs.queue("real");
    setSystemTime(new Date(T + 1_000));
    await queue.add("now", {}, { jobId: "r-now" });
    await queue.add("later", {}, { jobId: "r-later", delay: 2 * HOUR });
    setSystemTime(new Date(T + 2 * HOUR));
    await queue.add("outside", {}, { jobId: "r-outside" });
    setSystemTime();
    const h = harness({ jobs });

    const read = await h.call("GET", `/queues/real/counts/added?${RANGE}`);
    // The delayed job runs two hours on, but was added in the range.
    expect(read.body.counts).toEqual(counts({ waiting: 1, delayed: 1 }));
    expect(read.body.total).toBe(2);
  });

  it("sums the namespace over every visible queue", async () => {
    const jobs = context(new MemoryDriver(), "added-ns");
    await seedQueueA(jobs);
    await seed(jobs, "b", [
      { id: "b-1", state: "waiting", createdAt: T + 1 },
      { id: "b-2", state: "dead", createdAt: T + 2, finishedOn: T + 3 },
      { id: "b-out", state: "dead", createdAt: T + 2 * HOUR, finishedOn: T },
    ]);
    const h = harness({ jobs });

    const read = await h.call("GET", `/overview/added?${RANGE}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      from: T,
      to: T + HOUR,
      counts: { ...A_COUNTS, waiting: 3, dead: 2 },
      total: 11,
      queues: 2,
    });
  });

  it("never counts a queue the caller may not see: the allowlist and listQueues: authorized", async () => {
    const jobs = context(new MemoryDriver(), "added-hidden");
    await seedQueueA(jobs);
    await seed(jobs, "b", [{ id: "b-1", state: "waiting", createdAt: T + 1 }]);
    await seed(jobs, "secret", [
      { id: "s-1", state: "waiting", createdAt: T + 1 },
      { id: "s-2", state: "dead", createdAt: T + 2, finishedOn: T + 3 },
    ]);

    // The `queues` allowlist: `secret` is not reachable at all.
    const listed = harness({ jobs, queues: ["a", "b"] });
    const allowlisted = await listed.call("GET", `/overview/added?${RANGE}`);
    expect(allowlisted.body.counts).toEqual({ ...A_COUNTS, waiting: 3 });
    expect(allowlisted.body.queues).toBe(2);
    expect(
      (await listed.call("GET", `/queues/secret/counts/added?${RANGE}`)).status,
    ).toBe(404);

    // `listQueues: "authorized"`: `secret` is reachable but `authorize`
    // refuses `queues.read` on it, so it is neither counted nor summed.
    const authorized = harness({
      jobs,
      listQueues: "authorized",
      authorize: (_req, ctx) =>
        !(ctx.action === "queues.read" && ctx.queue === "secret"),
    });
    const filtered = await authorized.call("GET", `/overview/added?${RANGE}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.counts).toEqual({ ...A_COUNTS, waiting: 3 });
    expect(filtered.body.total).toBe(10);
    expect(filtered.body.queues).toBe(2);
    expect(
      (await authorized.call("GET", `/queues/secret/counts/added?${RANGE}`))
        .status,
    ).toBe(403);

    // Control: with every queue visible, `secret` is counted.
    const open = harness({ jobs });
    const everything = await open.call("GET", `/overview/added?${RANGE}`);
    expect(everything.body.counts).toEqual({
      ...A_COUNTS,
      waiting: 4,
      dead: 2,
    });
    expect(everything.body.queues).toBe(3);
  });

  it("answers zeros for a queue with nothing in the range, and for a namespace with no queues", async () => {
    const jobs = context(new MemoryDriver(), "added-empty");
    await seed(jobs, "quiet", [
      { id: "q-1", state: "waiting", createdAt: T - HOUR },
    ]);
    const h = harness({ jobs });
    const one = await h.call("GET", `/queues/quiet/counts/added?${RANGE}`);
    expect(one.body).toMatchObject({ counts: counts(), total: 0, queues: 1 });

    const empty = harness({ jobs: context(new MemoryDriver(), "added-none") });
    const none = await empty.call("GET", `/overview/added?${RANGE}`);
    expect(none.body).toMatchObject({ counts: counts(), total: 0, queues: 0 });
  });
});

describe("added by state: the range", () => {
  it("defaults to the hour before now", async () => {
    const jobs = context(new MemoryDriver(), "added-default");
    const now = Date.now();
    await seed(jobs, "a", [
      { id: "in", state: "waiting", createdAt: now - 30 * 60_000 },
      { id: "out", state: "waiting", createdAt: now - 2 * HOUR },
    ]);
    const h = harness({ jobs });
    for (const path of ["/overview/added", "/queues/a/counts/added"]) {
      const read = await h.call("GET", path);
      expect(read.status).toBe(200);
      expect(read.body.to - read.body.from).toBe(HOUR);
      expect(Math.abs(read.body.to - Date.now())).toBeLessThan(5_000);
      expect(read.body.counts).toEqual(counts({ waiting: 1 }));
    }
    // `to` alone: `from` an hour before it.
    const read = await h.call("GET", `/overview/added?to=${T}`);
    expect(read.body).toMatchObject({ from: T - HOUR, to: T });
  });

  it("refuses an empty or inverted range, one wider than a day, and one under a second", async () => {
    const jobs = context(new MemoryDriver(), "added-refused");
    await seed(jobs, "a", [{ id: "a-1", state: "waiting", createdAt: T }]);
    const h = harness({ jobs });
    for (const base of ["/overview/added", "/queues/a/counts/added"]) {
      for (const [label, query, context] of [
        ["equal", `from=${T}&to=${T}`, { from: T, to: T }],
        ["inverted", `from=${T + 1}&to=${T}`, { from: T + 1, to: T }],
        [
          "too wide",
          `from=${T}&to=${T + MAX_ADDED_BY_STATE_SPAN_MS + 1}`,
          { maxSpanMs: MAX_ADDED_BY_STATE_SPAN_MS },
        ],
        ["too narrow", `from=${T}&to=${T + 999}`, { minSpanMs: 1_000 }],
      ] as const) {
        const response = await h.call("GET", `${base}?${query}`);
        expect({ base, label, status: response.status }).toEqual({
          base,
          label,
          status: 400,
        });
        expect(response.body.code).toBe("INVALID_ARGUMENT");
        expect(response.body.context).toMatchObject(context);
      }
      // Exactly a day, and exactly a second, are allowed.
      for (const span of [MAX_ADDED_BY_STATE_SPAN_MS, 1_000]) {
        const response = await h.call(
          "GET",
          `${base}?from=${T}&to=${T + span}`,
        );
        expect({ base, span, status: response.status }).toEqual({
          base,
          span,
          status: 200,
        });
      }
    }
    // Not a time at all is the schema's 400.
    expect((await h.call("GET", "/overview/added?from=yesterday")).status).toBe(
      400,
    );
  });
});

describe("sort=createdAt on the job list", () => {
  /**
   * Delayed jobs whose due times run against their creation — natural order
   * (by `runAt`) `d-3, d-1, d-2`, creation order `d-1, d-2, d-3` — with a tie
   * in one millisecond (`d-2a`, `d-2b`) broken by id.
   */
  async function seedDelayed(jobs: BunJobs): Promise<void> {
    await seed(jobs, "a", [
      { id: "d-2b", state: "delayed", createdAt: T + 2, runAt: T + 950 },
      { id: "d-2a", state: "delayed", createdAt: T + 2, runAt: T + 900 },
      { id: "d-3", state: "delayed", createdAt: T + 3, runAt: T + 100 },
      { id: "d-1", state: "delayed", createdAt: T + 1, runAt: T + 500 },
    ]);
  }

  it("orders a single-state tab by creation time, where the natural order differs", async () => {
    const jobs = context(new MemoryDriver(), "added-sort");
    await seedDelayed(jobs);
    const h = harness({ jobs });
    const base = "/queues/a/jobs?state=delayed";

    const natural = order(await h.call("GET", base));
    expect(natural).toEqual(["d-3", "d-1", "d-2a", "d-2b"]);
    expect(order(await h.call("GET", `${base}&sort=natural`))).toEqual(natural);

    const created = order(await h.call("GET", `${base}&sort=createdAt`));
    expect(created).toEqual(["d-1", "d-2a", "d-2b", "d-3"]);
    // Newest first reverses both keys, the tie included.
    expect(
      order(await h.call("GET", `${base}&sort=createdAt&order=desc`)),
    ).toEqual(["d-3", "d-2b", "d-2a", "d-1"]);
    // Paged, with and without a total: the sort survives both paths.
    const page = await h.call(
      "GET",
      `${base}&sort=createdAt&order=desc&offset=1&limit=2&total=true`,
    );
    expect(order(page)).toEqual(["d-2b", "d-2a"]);
    expect(page.body.page).toMatchObject({ total: 4, hasMore: true });
    const listed = await h.call(
      "GET",
      `${base}&sort=createdAt&order=desc&offset=1&limit=2`,
    );
    expect(order(listed)).toEqual(["d-2b", "d-2a"]);
    expect(listed.body.page.hasMore).toBe(true);
    // With a filter too: the filter narrows, the sort still orders.
    expect(
      order(await h.call("GET", `${base}&sort=createdAt&search=d-2`)),
    ).toEqual(["d-2a", "d-2b"]);
  });

  it("refuses an unknown sort", async () => {
    const h = harness({ jobs: context(new MemoryDriver(), "added-sort-bad") });
    const response = await h.call("GET", "/queues/a/jobs?sort=priority");
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION");
  });

  it("refuses sort=createdAt with a detail where the backend cannot serve it, and still serves natural", async () => {
    const tmp = await makeTmpDir("bun-jobs-api-added-file");
    cleanups.push(tmp.cleanup);
    const jobs = context(
      new FileDriver({ root: tmp.path, pollInterval: 10 }),
      "added-file",
    );
    await seedDelayed(jobs);
    const h = harness({ jobs });

    const refused = await h.call(
      "GET",
      "/queues/a/jobs?state=delayed&sort=createdAt",
    );
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("INVALID_ARGUMENT");
    expect(refused.body.detail).toContain("features.addedByState");
    expect(refused.body.context).toEqual({
      sort: "createdAt",
      features: { addedByState: false },
    });
    // With a total too: both paths refuse.
    expect(
      (
        await h.call(
          "GET",
          "/queues/a/jobs?state=delayed&sort=createdAt&total=true",
        )
      ).status,
    ).toBe(400);
    expect(
      order(await h.call("GET", "/queues/a/jobs?state=delayed&sort=natural")),
    ).toEqual(["d-3", "d-1", "d-2a", "d-2b"]);
  });
});

/** A backend the flag is checked on: how to build its driver, or why it is skipped. */
interface Backend {
  /** Shown in the test titles. */
  name: string;
  /** Whether the backend serves reads by creation time. */
  serves: boolean;
  /** Builds a driver; `undefined` when unavailable. */
  make: (() => Promise<JobsDriver>) | undefined;
}

/** A server-backed backend, skipped when its variable is unset. */
function server(
  name: string,
  variable: string,
  serves: boolean,
  build: (url: string) => JobsDriver,
): Backend {
  const url = process.env[variable];
  return { name, serves, make: url ? async () => build(url) : undefined };
}

const BACKENDS: Backend[] = [
  { name: "memory", serves: true, make: async () => new MemoryDriver() },
  {
    name: "file",
    serves: false,
    make: async () => {
      const tmp = await makeTmpDir("bun-jobs-api-added-flag");
      cleanups.push(tmp.cleanup);
      return new FileDriver({ root: tmp.path, pollInterval: 10 });
    },
  },
  {
    name: "sqlite",
    serves: true,
    make: async () => {
      const tmp = await makeTmpDir("bun-jobs-api-added-sqlite");
      cleanups.push(tmp.cleanup);
      return new SqlDriver({ url: `sqlite://${tmp.path}/jobs.db` });
    },
  },
  ...(["postgres", "mysql", "mariadb"] as const).map((adapter) =>
    server(
      adapter,
      `BUN_JOBS_TEST_${adapter.toUpperCase()}_URL`,
      true,
      (url) =>
        new SqlDriver({
          url,
          adapter,
          tablePrefix: "bun_jobs_test_",
          pollInterval: 10,
        }),
    ),
  ),
  server(
    "mongodb",
    "BUN_JOBS_TEST_MONGODB_URL",
    true,
    (url) => new MongoDriver({ url, pollInterval: 10 }),
  ),
  server(
    "redis",
    "BUN_JOBS_TEST_REDIS_URL",
    false,
    (url) => new RedisDriver({ url }),
  ),
];

describe("features.addedByState, per driver", () => {
  for (const backend of BACKENDS) {
    it.skipIf(!backend.make)(
      `${backend.name}: ${backend.serves ? "served" : "not served"} — the flag, the routes and the sort agree`,
      async () => {
        const driver = await backend.make!();
        const jobs = context(driver, `added-flag-${backend.name}`);
        await seed(jobs, "a", [
          { id: "f-2", state: "delayed", createdAt: T + 2, runAt: T + 100 },
          { id: "f-1", state: "delayed", createdAt: T + 1, runAt: T + 500 },
        ]);
        const h = harness({ jobs });
        const meta = await h.call("GET", "/meta");
        expect(meta.body.features.addedByState).toBe(backend.serves);

        const routed = h.api.routes.map((route) => route.operationId);
        const counted = await h.call("GET", `/queues/a/counts/added?${RANGE}`);
        const overview = await h.call("GET", `/overview/added?${RANGE}`);
        const sorted = await h.call(
          "GET",
          "/queues/a/jobs?state=delayed&sort=createdAt",
        );
        if (backend.serves) {
          expect(routed).toContain("getAddedByState");
          expect(routed).toContain("getQueueAddedByState");
          expect(counted.body.counts).toEqual(counts({ delayed: 2 }));
          expect(overview.body.counts).toEqual(counts({ delayed: 2 }));
          expect(order(sorted)).toEqual(["f-1", "f-2"]);
        } else {
          // Pruned, never a 501; and the sort refused, never ignored.
          expect(routed).not.toContain("getAddedByState");
          expect(routed).not.toContain("getQueueAddedByState");
          expect([counted.status, overview.status]).toEqual([404, 404]);
          expect(sorted.status).toBe(400);
        }
      },
    );
  }

  it("is false in runner mode, and on a driver without countAddedJobs", async () => {
    const runnerOnly = harness({
      jobs: context(new MemoryDriver(), "added-flag-runner"),
      mode: "runner",
    });
    expect(
      (await runnerOnly.call("GET", "/meta")).body.features.addedByState,
    ).toBe(false);

    const hidden = new Proxy(new MemoryDriver(), {
      get(target, key, receiver) {
        if (key === "countAddedJobs") {
          return undefined;
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as JobsDriver;
    const hiddenJobs = context(hidden, "added-flag-hidden");
    await seed(hiddenJobs, "a", [
      { id: "a-1", state: "waiting", createdAt: T },
    ]);
    const h = harness({ jobs: hiddenJobs });
    expect((await h.call("GET", "/meta")).body.features.addedByState).toBe(
      false,
    );
    expect((await h.call("GET", `/overview/added?${RANGE}`)).status).toBe(404);
    const refused = await h.call("GET", "/queues/a/jobs?sort=createdAt");
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("INVALID_ARGUMENT");
  });
});
