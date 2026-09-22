/**
 * The analytics read routes, `/overview`'s `analytics` block and
 * `/meta.analytics`, against a real memory driver with buckets written through
 * the driver itself — completions through `claimJob`/`completeJob`, runner and
 * worker counts through `countRunnerRun`/`countWorkerJobs`/
 * `sampleWorkerBusyness` — never invented response bodies. Every harness
 * validates its responses against their schemas (`afterEach`).
 *
 * The equalities that carry the design are asserted with a negative control
 * beside them: the exclusive `to`, contiguous buckets, and — the one a UI test
 * depends on — what a batch of 20 costs: exactly one driver read of its kind
 * on a driver with the grouped reads, none of its own on one without.
 *
 * The runner and worker roll-ups run twice, once per path: the memory driver
 * as it is (grouped reads) and with the four grouped methods hidden
 * (`without`), which is every driver that has not implemented them yet.
 */
import type { JobsApiConfig } from "../../lib/api/config";
import type { BunJobs, JobsDriver, WorkerInfo } from "../../lib/index";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { JOBS_API_ACTIONS } from "../../lib/api/config";
import {
  MAX_ANALYTICS_ROWS,
  MAX_ANALYTICS_SERIES,
} from "../../lib/api/contract/constants";
import { createJobsApi } from "../../lib/api/createJobsApi";
import {
  ANALYTICS_METHODS,
  DEFAULT_BUSYNESS_INTERVAL_MS,
  GROUPED_METRICS_METHODS,
  usesGroupedReads,
} from "../../lib/api/routes/analytics";
import * as drivers from "../../lib/drivers/index";
import * as barrel from "../../lib/index";
import {
  bucketStart,
  DURATION_HISTOGRAM_SIZE,
  MemoryDriver,
  runnerKey,
} from "../../lib/index";
import { DEFAULT_REPORT_INTERVAL } from "../../lib/queue/BunQueueWorker";
import { makeJob } from "../helpers";
import {
  apiConfig,
  ECHO_HANDLER,
  harness,
  jobsContext,
  openContexts,
  openHarnesses,
  registerRunnerElsewhere,
} from "./fixtures";

const MINUTE = 60_000;
const SECOND = 1_000;

/** A namespace per test, so no two tests share buckets. */
let namespaces = 0;

/** A fresh context over `driver` (a new memory driver by default). */
function context(driver: JobsDriver = new MemoryDriver()): BunJobs {
  return jobsContext(`api-analytics-${++namespaces}`, driver);
}

/** A driver with some optional methods hidden, as an older one would be. */
function without(driver: JobsDriver, methods: readonly string[]): JobsDriver {
  const hidden = new Set(methods);
  return new Proxy(driver, {
    get(target, key, receiver) {
      if (typeof key === "string" && hidden.has(key)) {
        return undefined;
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, key) {
      return typeof key === "string" && hidden.has(key)
        ? false
        : Reflect.has(target, key);
    },
  }) as JobsDriver;
}

/** The analytics reads a driver was asked for, by method. */
type ReadCounts = Record<string, number>;

/**
 * The driver reads the counter watches: every metrics read, per-entity and
 * grouped, and the lock read `runningNow` costs.
 */
const COUNTED = [
  "getNamespaceMetrics",
  "getQueueMetrics",
  "getRunnerMetrics",
  "getWorkerMetrics",
  "getRunnerMetricsTotals",
  "getRunnerMetricsMany",
  "getWorkerMetricsTotals",
  "getWorkerMetricsMany",
  "getLock",
] as const;

/** Every counted read at zero, overridden by `reads`: what a whole-record assertion compares against. */
function onlyReads(reads: ReadCounts): ReadCounts {
  return {
    ...Object.fromEntries(COUNTED.map((method) => [method, 0])),
    ...reads,
  };
}

/** The two ways the routes read runners and workers. */
const PATHS = [
  {
    name: "grouped reads",
    grouped: true,
    driver: (): JobsDriver => new MemoryDriver(),
  },
  {
    name: "per-entity fallback",
    grouped: false,
    driver: (): JobsDriver =>
      without(new MemoryDriver(), GROUPED_METRICS_METHODS),
  },
] as const;

/**
 * A driver that counts its analytics reads, and optionally answers
 * `getMetricsSupport()` with something else — the only way to reach the
 * `maxBuckets` and `driver` clamps against the real limits.
 */
function counting(
  driver: JobsDriver,
  support?: ReturnType<NonNullable<JobsDriver["getMetricsSupport"]>>,
): { driver: JobsDriver; reads: ReadCounts; reset: () => void } {
  const reads: ReadCounts = {};
  const reset = () => {
    for (const method of COUNTED) {
      reads[method] = 0;
    }
  };
  reset();
  const proxy = new Proxy(driver, {
    get(target, key, receiver) {
      if (key === "getMetricsSupport" && support) {
        return () => support;
      }
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") {
        return value;
      }
      if ((COUNTED as readonly unknown[]).includes(key)) {
        return (...args: unknown[]) => {
          reads[key as string]! += 1;
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  }) as JobsDriver;
  return { driver: proxy, reads, reset };
}

/** Completes one job on `queue` at exactly `at`, through the driver. */
async function completeAt(
  jobs: BunJobs,
  queue: string,
  at: number,
  outcome: "completed" | "failed" = "completed",
): Promise<void> {
  const driver = jobs.driver;
  const q = { ns: jobs.namespace, queue };
  await driver.connect();
  await driver.ensureQueue(q);
  const id = crypto.randomUUID();
  await driver.addJob(q, makeJob({ id, createdAt: at, runAt: at }));
  const token = crypto.randomUUID();
  await driver.claimJob(q, { workerId: "w", token, lockMs: MINUTE, now: at });
  if (outcome === "completed") {
    expect(await driver.completeJob(q, id, token, null, false, at)).toBe(true);
  } else {
    expect(
      await driver.failJob(
        q,
        id,
        token,
        { name: "Error", message: "boom" },
        { kind: "failed", retention: false } as never,
        at,
        0,
      ),
    ).toBe(true);
  }
}

/** A live worker record on `queue` with stable `key`. */
async function putWorker(
  jobs: BunJobs,
  queue: string,
  key: string,
  id = `${key}.1`,
): Promise<void> {
  const now = Date.now();
  const worker: WorkerInfo = {
    id,
    key,
    queue,
    host: "test-host",
    pid: 4_242,
    concurrency: 4,
    active: 0,
    paused: false,
    startedAt: now - 1_000,
    heartbeatAt: now,
    expiresAt: now + MINUTE,
  };
  await jobs.driver.connect();
  await jobs.driver.ensureQueue({ ns: jobs.namespace, queue });
  await jobs.driver.registerWorker!({ ns: jobs.namespace, queue }, worker);
}

/** A query string from a record, repeating array values. */
function qs(params: Record<string, string | number | string[]>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      search.append(key, String(one));
    }
  }
  return `?${search}`;
}

/** The start of the minute `n` minutes before the current one. */
function minutesAgo(n: number): number {
  return bucketStart(Date.now(), MINUTE) - n * MINUTE;
}

/** The start of the second `n` seconds before the current one. */
function secondsAgo(n: number): number {
  return bucketStart(Date.now(), SECOND) - n * SECOND;
}

afterEach(() => {
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
});

afterAll(async () => {
  await Promise.all(openContexts.map((jobs) => jobs.close()));
});

describe("the range", () => {
  it("maps an exclusive request `to` onto the last bucket's start, with `end` the exclusive end", async () => {
    const jobs = context();
    const h = harness({ jobs });
    const m = minutesAgo(30);
    await completeAt(jobs, "orders", m + 1_000);
    await completeAt(jobs, "orders", m + 2 * MINUTE + 5_000);

    const res = await h.call(
      "GET",
      `/analytics/jobs${qs({ from: m, to: m + 3 * MINUTE, resolution: 60 })}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.range).toEqual({
      resolution: 60,
      interval: MINUTE,
      from: m,
      // The request's `to` (m + 3 min) is exclusive, so the bucket starting
      // there is not served: the last bucket starts a minute earlier…
      to: m + 2 * MINUTE,
      // …and the exclusive end is where the request's `to` was.
      end: m + 3 * MINUTE,
      requested: { from: m, to: m + 3 * MINUTE, resolution: 60 },
      clamped: false,
    });
    expect(res.body.buckets).toEqual([
      { at: m, completed: 1, failed: 0 },
      { at: m + MINUTE, completed: 0, failed: 0 },
      { at: m + 2 * MINUTE, completed: 1, failed: 0 },
    ]);
    expect(res.body.totals).toEqual({ completed: 2, failed: 0 });

    // Negative control: one millisecond later and the bucket at `to` is in.
    const later = await h.call(
      "GET",
      `/analytics/jobs${qs({ from: m, to: m + 3 * MINUTE + 1, resolution: 60 })}`,
    );
    expect(later.body.range.to).toBe(m + 3 * MINUTE);
    expect(later.body.range.end).toBe(m + 4 * MINUTE);
    expect(later.body.buckets).toHaveLength(4);
  });

  it("serves contiguous buckets: an empty interval is present with zeros", async () => {
    const jobs = context();
    const h = harness({ jobs });
    const s = secondsAgo(60);
    await completeAt(jobs, "orders", s);
    await completeAt(jobs, "orders", s + 4 * SECOND, "failed");

    const res = await h.call(
      "GET",
      `/queues/orders/analytics/jobs${qs({ from: s, to: s + 5 * SECOND, resolution: 1 })}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.range.resolution).toBe(1);
    expect(res.body.buckets.map((b: { at: number }) => b.at)).toEqual([
      s,
      s + SECOND,
      s + 2 * SECOND,
      s + 3 * SECOND,
      s + 4 * SECOND,
    ]);
    expect(res.body.buckets[2]).toEqual({
      at: s + 2 * SECOND,
      completed: 0,
      failed: 0,
    });
    expect(res.body.totals).toEqual({ completed: 1, failed: 1 });
  });

  it("clamps a range straddling the per-second window to one resolution, and says why", async () => {
    const h = harness({ jobs: context() });
    const now = Date.now();
    // 10 minutes asked at 1 s; seconds are kept for 5 minutes.
    const res = await h.call(
      "GET",
      `/analytics/jobs${qs({ from: now - 10 * MINUTE, to: now, resolution: 1 })}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.range.resolution).toBe(60);
    expect(res.body.range.clamped).toBe(true);
    expect(res.body.range.reason).toBe("retention");
    // One width for the whole series, never a mix.
    const steps = new Set(
      res.body.buckets
        .slice(1)
        .map((b: { at: number }, i: number) => b.at - res.body.buckets[i].at),
    );
    expect([...steps]).toEqual([MINUTE]);

    // Negative control: inside the window, 1 s is served unclamped.
    const inside = await h.call(
      "GET",
      `/analytics/jobs${qs({ from: now - 2 * MINUTE, to: now, resolution: 1 })}`,
    );
    expect(inside.body.range.resolution).toBe(1);
    expect(inside.body.range.clamped).toBe(false);
    expect(inside.body.range).not.toHaveProperty("reason");
  });

  it("clamps a partly retained range forward, and refuses a wholly unretained one", async () => {
    const h = harness({ jobs: context() });
    const now = Date.now();
    const day = 24 * 60 * MINUTE;

    const partly = await h.call(
      "GET",
      `/analytics/jobs${qs({ from: now - day - 30 * MINUTE, to: now - 60 * MINUTE })}`,
    );
    expect(partly.status).toBe(200);
    expect(partly.body.range.clamped).toBe(true);
    expect(partly.body.range.reason).toBe("retention");
    expect(partly.body.range.from).toBeGreaterThanOrEqual(
      bucketStart(now - day, MINUTE),
    );
    expect(partly.body.range.requested.from).toBe(now - day - 30 * MINUTE);

    const wholly = await h.call(
      "GET",
      `/analytics/jobs${qs({ from: now - day - 90 * MINUTE, to: now - day - 30 * MINUTE })}`,
    );
    expect(wholly.status).toBe(400);
    expect(wholly.body.code).toBe("RANGE_NOT_RETAINED");
    expect(wholly.body.title).toBe("Range is older than the backend keeps");
    expect(wholly.body.context.resolution).toBe(60);
    expect(wholly.body.context.retainedFrom).toBeGreaterThan(
      now - day - 30 * MINUTE,
    );
  });

  it("coarsens a span with too many buckets at the width asked (maxBuckets)", async () => {
    const memory = new MemoryDriver();
    // A backend keeping seconds for a day: an hour at 1 s is 3,600 buckets.
    const { driver } = counting(memory, {
      resolutions: [1, 60],
      retentionMs: { 1: 24 * 60 * MINUTE, 60: 24 * 60 * MINUTE },
      recording: {
        resolution: "second",
        secondRetentionMs: 24 * 60 * MINUTE,
        workers: true,
        runners: true,
        durations: true,
      },
    });
    const h = harness({ jobs: context(driver) });
    const now = Date.now();
    const res = await h.call(
      "GET",
      `/analytics/jobs${qs({ from: now - 60 * MINUTE, to: now, resolution: 1 })}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.range.resolution).toBe(60);
    expect(res.body.range.reason).toBe("maxBuckets");
    expect(res.body.buckets.length).toBeLessThanOrEqual(1500);
  });

  it("says `driver` when the backend does not record the width asked", async () => {
    const { driver } = counting(new MemoryDriver(), {
      resolutions: [60],
      retentionMs: { 60: 24 * 60 * MINUTE },
      recording: {
        resolution: "minute",
        secondRetentionMs: 0,
        workers: true,
        runners: true,
        durations: true,
      },
    });
    const h = harness({ jobs: context(driver) });
    const now = Date.now();
    const res = await h.call(
      "GET",
      `/analytics/jobs${qs({ from: now - 2 * MINUTE, to: now, resolution: 1 })}`,
    );
    expect(res.body.range.resolution).toBe(60);
    expect(res.body.range.reason).toBe("driver");
  });

  it("refuses a range that cannot be asked for", async () => {
    const h = harness({ jobs: context() });
    const now = Date.now();
    const backwards = await h.call(
      "GET",
      `/analytics/jobs${qs({ from: now, to: now - MINUTE })}`,
    );
    expect(backwards.status).toBe(400);
    expect(backwards.body.code).toBe("INVALID_ARGUMENT");
    const empty = await h.call(
      "GET",
      `/analytics/jobs${qs({ from: now, to: now })}`,
    );
    expect(empty.body.code).toBe("INVALID_ARGUMENT");
    const tooLong = await h.call(
      "GET",
      `/analytics/jobs${qs({ from: now - 25 * 60 * MINUTE, to: now })}`,
    );
    expect(tooLong.body.code).toBe("INVALID_ARGUMENT");
    const tooShort = await h.call(
      "GET",
      `/analytics/jobs${qs({ from: now - 500, to: now })}`,
    );
    expect(tooShort.body.code).toBe("INVALID_ARGUMENT");
    const odd = await h.call("GET", `/analytics/jobs${qs({ resolution: 30 })}`);
    expect(odd.status).toBe(400);
    expect(odd.body.code).toBe("VALIDATION");
  });

  it("accepts RFC 3339 date-times and defaults to the last hour", async () => {
    const jobs = context();
    const h = harness({ jobs });
    const m = minutesAgo(5);
    await completeAt(jobs, "orders", m + 1_000);
    const res = await h.call(
      "GET",
      `/analytics/jobs${qs({ from: new Date(m).toISOString(), to: new Date(m + MINUTE).toISOString() })}`,
    );
    expect(res.body.range.requested).toMatchObject({ from: m, to: m + MINUTE });
    expect(res.body.totals.completed).toBe(1);

    const defaulted = await h.call("GET", "/analytics/jobs");
    expect(
      defaulted.body.range.requested.to - defaulted.body.range.requested.from,
    ).toBe(60 * MINUTE);
    expect(defaulted.body.range.requested).not.toHaveProperty("resolution");
    expect(defaulted.body.totals.completed).toBe(1);
  });
});

describe("the jobs series", () => {
  it("reads the namespace roll-up once, whatever the queue count", async () => {
    const counted = counting(new MemoryDriver());
    const jobs = context(counted.driver);
    const h = harness({ jobs });
    const m = minutesAgo(10);
    for (const queue of ["a", "b", "c", "d"]) {
      await completeAt(jobs, queue, m + 1_000);
    }
    counted.reset();
    const res = await h.call(
      "GET",
      `/analytics/jobs${qs({ from: m, to: m + MINUTE })}`,
    );
    expect(res.body.totals.completed).toBe(4);
    expect(counted.reads).toEqual(onlyReads({ getNamespaceMetrics: 1 }));
  });

  it("sums the visible queues instead when the API is restricted, so a hidden queue is not counted", async () => {
    const counted = counting(new MemoryDriver());
    const jobs = context(counted.driver);
    const h = harness({ jobs, queues: ["orders"] });
    const m = minutesAgo(10);
    await completeAt(jobs, "orders", m + 1_000);
    await completeAt(jobs, "secret", m + 1_000);
    counted.reset();
    const res = await h.call(
      "GET",
      `/analytics/jobs${qs({ from: m, to: m + MINUTE })}`,
    );
    expect(res.body.totals.completed).toBe(1);
    expect(counted.reads.getNamespaceMetrics).toBe(0);
    expect(counted.reads.getQueueMetrics).toBe(1);
  });

  it("reads one queue, and 404s one that does not exist", async () => {
    const jobs = context();
    const h = harness({ jobs });
    const m = minutesAgo(10);
    await completeAt(jobs, "orders", m + 1_000);
    await completeAt(jobs, "mail", m + 1_000);
    const res = await h.call(
      "GET",
      `/queues/orders/analytics/jobs${qs({ from: m, to: m + MINUTE })}`,
    );
    expect(res.body.totals).toEqual({ completed: 1, failed: 0 });
    const missing = await h.call("GET", "/queues/nowhere/analytics/jobs");
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("QUEUE_NOT_FOUND");
  });
});

/** Holds runner `id`'s lock, as a run in another process would. */
async function holdLock(jobs: BunJobs, id: string): Promise<void> {
  expect(
    await jobs.driver.acquireLock(
      jobs.namespace,
      runnerKey(id),
      "other-host:1:token",
      MINUTE,
      Date.now(),
    ),
  ).toBe(true);
}

/** A harness with `ids.length` runners registered, `started[i]` runs each. */
async function runners(
  path: (typeof PATHS)[number],
  ids: readonly string[],
  started: (i: number) => number,
) {
  const counted = counting(path.driver());
  const jobs = context(counted.driver);
  const h = harness({ jobs });
  const m = minutesAgo(10);
  for (const [i, id] of ids.entries()) {
    await registerRunnerElsewhere(jobs, id);
    const n = started(i);
    if (n > 0) {
      await jobs.driver.countRunnerRun!(
        jobs.namespace,
        runnerKey(id),
        m + 1_000,
        {
          started: n,
          succeeded: n,
          durationMs: 100 * (i + 1),
        },
      );
    }
  }
  return { h, jobs, counted, m, range: { from: m, to: m + MINUTE } };
}

/** `n` runner ids, zero-padded so they sort as numbered. */
function runnerIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `r${String(i).padStart(3, "0")}`);
}

describe("the path the routes take", () => {
  it("uses the grouped reads only when a driver has all four", () => {
    expect(usesGroupedReads(new MemoryDriver())).toBe(true);
    expect(
      usesGroupedReads(without(new MemoryDriver(), GROUPED_METRICS_METHODS)),
    ).toBe(false);
    // One missing is as good as none: the contract treats them as a set.
    for (const method of GROUPED_METRICS_METHODS) {
      expect({
        method,
        grouped: usesGroupedReads(without(new MemoryDriver(), [method])),
      }).toEqual({ method, grouped: false });
    }
  });
});

for (const path of PATHS) {
  describe(`the runners roll-up (${path.name})`, () => {
    it("sums every runner from the roll-up, with a row per runner sorted by started runs then id", async () => {
      const { h, m, range } = await runners(
        path,
        ["b", "a", "c", "idle"],
        (i) => [2, 2, 5, 0][i]!,
      );
      const res = await h.call("GET", `/analytics/runners${qs(range)}`);
      expect(res.status).toBe(200);
      expect(res.body.series.totals.started).toBe(9);
      expect(res.body.series.buckets[0].at).toBe(m);
      expect(
        res.body.rows.map((row: { runner: string }) => row.runner),
      ).toEqual(["c", "a", "b", "idle"]);
      expect(res.body.rows[0]).toMatchObject({
        runner: "c",
        totals: { started: 5, succeeded: 5, failed: 0 },
        runningNow: 0,
        // One delta carries one duration, however many runs it counts.
        durations: { count: 1, minMs: 300, maxMs: 300, meanMs: 300 },
      });
      // A listed runner with nothing in range still has a row: zeros, and no
      // durations, as on either path.
      expect(res.body.rows[3]).toEqual({
        runner: "idle",
        totals: {
          started: 0,
          succeeded: 0,
          failed: 0,
          timeout: 0,
          killed: 0,
          skipped: 0,
        },
        runningNow: 0,
      });
      expect(res.body).toMatchObject({
        truncated: false,
        totalRows: 4,
        runningNow: 0,
      });
      expect(res.body).not.toHaveProperty("seriesByRunner");
    });

    it("caps rows at MAX_ANALYTICS_ROWS, says truncated, and counts them all in totalRows", async () => {
      const ids = runnerIds(MAX_ANALYTICS_ROWS + 5);
      const { h, range } = await runners(path, ids, (i) => i % 7);
      const res = await h.call("GET", `/analytics/runners${qs(range)}`);
      expect(res.body.rows).toHaveLength(MAX_ANALYTICS_ROWS);
      expect(res.body.truncated).toBe(true);
      expect(res.body.totalRows).toBe(MAX_ANALYTICS_ROWS + 5);
      // The busiest are the ones kept.
      expect(res.body.rows[0].totals.started).toBe(6);
    });

    it("answers `ids` in the order asked, zeroes a reachable idle one, and leaves out one it cannot reach", async () => {
      const { h, range } = await runners(
        path,
        ["a", "b", "c", "idle"],
        (i) => [1, 2, 3, 0][i]!,
      );
      const res = await h.call(
        "GET",
        `/analytics/runners${qs({ ...range, ids: ["c", "ghost", "idle", "a"] })}`,
      );
      expect(res.status).toBe(200);
      expect(
        res.body.seriesByRunner.map(
          (entry: { runner: string }) => entry.runner,
        ),
      ).toEqual(["c", "idle", "a"]);
      expect(res.body.seriesByRunner[0].runs.totals.started).toBe(3);
      expect(res.body.seriesByRunner[0].runs.range).toEqual(
        res.body.series.range,
      );
      expect(res.body.seriesByRunner[1].runs.totals.started).toBe(0);
      expect(res.body.seriesByRunner[1].runs.buckets).toHaveLength(
        res.body.series.buckets.length,
      );
      expect(res.body.seriesByRunner[2].runs.totals.started).toBe(1);
    });

    it("refuses an explicit batch over MAX_ANALYTICS_SERIES with BULK_LIMIT", async () => {
      const { h } = await runners(path, ["a"], () => 1);
      const ids = Array.from(
        { length: MAX_ANALYTICS_SERIES + 1 },
        (_, i) => `r${i}`,
      );
      const res = await h.call("GET", `/analytics/runners${qs({ ids })}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("BULK_LIMIT");
      // Negative control: exactly MAX_ANALYTICS_SERIES is fine.
      const ok = await h.call(
        "GET",
        `/analytics/runners${qs({ ids: ids.slice(0, MAX_ANALYTICS_SERIES) })}`,
      );
      expect(ok.status).toBe(200);
    });

    it("reads runningNow from the lock", async () => {
      const { h, jobs, range } = await runners(path, ["a", "b"], () => 1);
      await holdLock(jobs, "b");
      const res = await h.call("GET", `/analytics/runners${qs(range)}`);
      const running = Object.fromEntries(
        res.body.rows.map((row: { runner: string; runningNow: number }) => [
          row.runner,
          row.runningNow,
        ]),
      );
      expect(running).toEqual({ a: 0, b: 1 });
      expect(res.body.runningNow).toBe(1);
    });

    if (path.grouped) {
      it("reads every runner's rows in one read, and a batch of 20 in exactly one more", async () => {
        const ids = runnerIds(30);
        const { h, counted, range } = await runners(path, ids, (i) => i);

        counted.reset();
        await h.call("GET", `/analytics/runners${qs(range)}`);
        const rollup = { ...counted.reads };
        expect(rollup).toEqual(
          onlyReads({
            getRunnerMetricsTotals: 1,
            getNamespaceMetrics: 1,
            getLock: ids.length,
          }),
        );

        counted.reset();
        const batch = await h.call(
          "GET",
          `/analytics/runners${qs({ ...range, ids: ids.slice(0, MAX_ANALYTICS_SERIES) })}`,
        );
        expect(batch.body.seriesByRunner).toHaveLength(MAX_ANALYTICS_SERIES);
        // The batch is exactly one read of its kind, whatever it names.
        expect(counted.reads).toEqual({
          ...rollup,
          getRunnerMetricsMany: 1,
        });
      });

      it("costs the same metrics reads with 5 runners as with 200, and a lock read per row returned only", async () => {
        const reads: ReadCounts[] = [];
        for (const n of [5, 200]) {
          const { h, counted, range } = await runners(
            path,
            runnerIds(n),
            (i) => i % 3,
          );
          counted.reset();
          const res = await h.call("GET", `/analytics/runners${qs(range)}`);
          expect(res.body.totalRows).toBe(n);
          reads.push({ ...counted.reads });
        }
        const { getLock: few, ...fewMetrics } = reads[0]!;
        const { getLock: many, ...manyMetrics } = reads[1]!;
        expect(manyMetrics).toEqual(fewMetrics);
        expect(few).toBe(5);
        expect(many).toBe(MAX_ANALYTICS_ROWS);
      });

      it("gives a runner no longer registered a row through a manager, so the rows add up to the series", async () => {
        const { h, jobs, m, range } = await runners(path, ["a", "b"], () => 2);
        // Ran in the window, then went away: counted, never registered here.
        await jobs.driver.countRunnerRun!(
          jobs.namespace,
          runnerKey("gone"),
          m + 5_000,
          { started: 5, succeeded: 5 },
        );
        const res = await h.call(
          "GET",
          `/analytics/runners${qs({ ...range, ids: ["gone"] })}`,
        );
        expect(res.status).toBe(200);
        const rows = res.body.rows as {
          runner: string;
          totals: { started: number };
        }[];
        expect(rows.map((row) => row.runner)).toEqual(["gone", "a", "b"]);
        expect(rows[0]).toMatchObject({
          runner: "gone",
          totals: { started: 5, succeeded: 5 },
          runningNow: 0,
        });
        expect(res.body.totalRows).toBe(3);
        // The claim the rows make: they are who did the work in the window.
        expect(rows.reduce((sum, row) => sum + row.totals.started, 0)).toBe(
          res.body.series.totals.started,
        );
        expect(res.body.series.totals.started).toBe(9);
        // Its row is reachable, so its sparkline is too.
        expect(res.body.seriesByRunner).toHaveLength(1);
        expect(res.body.seriesByRunner[0].runs.totals.started).toBe(5);
      });

      it("sums a fixed list's series from one batch read of the runners with counts", async () => {
        const counted = counting(path.driver());
        const jobs = context(counted.driver);
        const listed = ["a", "b"].map((id) =>
          jobs.runner({ id, file: ECHO_HANDLER, executionMode: "in-process" }),
        );
        const h = harness({ jobs, runners: listed });
        const m = minutesAgo(10);
        for (const id of ["a", "b", "outside"]) {
          await jobs.driver.countRunnerRun!(jobs.namespace, runnerKey(id), m, {
            started: 2,
          });
        }
        counted.reset();
        const res = await h.call(
          "GET",
          `/analytics/runners${qs({ from: m, to: m + MINUTE })}`,
        );
        expect(res.status).toBe(200);
        // The runner outside the list is neither summed nor a row.
        expect(res.body.series.totals.started).toBe(4);
        expect(
          res.body.rows.map((row: { runner: string }) => row.runner),
        ).toEqual(["a", "b"]);
        expect(counted.reads).toEqual(
          onlyReads({
            getRunnerMetricsTotals: 1,
            getRunnerMetricsMany: 1,
            getLock: 2,
          }),
        );
      });
    } else {
      it("serves a batch of 20 from the reads the rows already made: no driver reads of its own", async () => {
        const ids = runnerIds(30);
        const { h, counted, range } = await runners(path, ids, (i) => i);

        counted.reset();
        await h.call("GET", `/analytics/runners${qs(range)}`);
        const rollup = { ...counted.reads };

        counted.reset();
        const batch = await h.call(
          "GET",
          `/analytics/runners${qs({ ...range, ids: ids.slice(0, MAX_ANALYTICS_SERIES) })}`,
        );
        expect(batch.body.seriesByRunner).toHaveLength(MAX_ANALYTICS_SERIES);
        expect(counted.reads).toEqual(rollup);
        // One roll-up read for the series; the rows a read per runner and a
        // lock read per runner — the cost the grouped reads remove.
        expect(counted.reads).toEqual(
          onlyReads({
            getNamespaceMetrics: 1,
            getRunnerMetrics: ids.length,
            getLock: ids.length,
          }),
        );
      });
    }
  });
}

describe("one runner", () => {
  it("serves runs by outcome, durations with a histogram, and runningNow", async () => {
    const jobs = context();
    const h = harness({ jobs });
    await registerRunnerElsewhere(jobs, "nightly");
    const m = minutesAgo(10);
    const key = runnerKey("nightly");
    await jobs.driver.countRunnerRun!(jobs.namespace, key, m + 1_000, {
      started: 3,
    });
    await jobs.driver.countRunnerRun!(jobs.namespace, key, m + 2_000, {
      succeeded: 1,
      durationMs: 40,
    });
    await jobs.driver.countRunnerRun!(jobs.namespace, key, m + MINUTE + 2_000, {
      failed: 1,
      durationMs: 400,
    });
    const res = await h.call(
      "GET",
      `/runners/nightly/analytics${qs({ from: m, to: m + 2 * MINUTE })}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.runner).toBe("nightly");
    expect(res.body.runningNow).toBe(0);
    expect(res.body.runs.totals).toEqual({
      started: 3,
      succeeded: 1,
      failed: 1,
      timeout: 0,
      killed: 0,
      skipped: 0,
    });
    expect(res.body.durations.range).toEqual(res.body.runs.range);
    expect(res.body.durations.buckets[0]).toMatchObject({
      at: m,
      count: 1,
      minMs: 40,
      maxMs: 40,
      meanMs: 40,
    });
    expect(res.body.durations.buckets[0].histogram).toHaveLength(
      DURATION_HISTOGRAM_SIZE,
    );
    expect(res.body.durations.totals).toMatchObject({
      count: 2,
      minMs: 40,
      maxMs: 400,
      meanMs: 220,
    });
    expect(res.body.durations.totals).not.toHaveProperty("histogram");
    expect(res.body.durations.totals.p50Ms).toBeGreaterThan(0);

    const missing = await h.call("GET", "/runners/nobody/analytics");
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("RUNNER_NOT_FOUND");
  });

  it("reads runningNow with one lock read, for a remote runner and a local one alike", async () => {
    const counted = counting(new MemoryDriver());
    const jobs = context(counted.driver);
    jobs.runner({
      id: "here",
      file: ECHO_HANDLER,
      executionMode: "in-process",
    });
    const h = harness({ jobs });
    await registerRunnerElsewhere(jobs, "there");
    await holdLock(jobs, "there");
    for (const [runner, running] of [
      ["there", 1],
      ["here", 0],
    ] as const) {
      counted.reset();
      const res = await h.call("GET", `/runners/${runner}/analytics`);
      expect({ runner, runningNow: res.body.runningNow }).toEqual({
        runner,
        runningNow: running,
      });
      expect({ runner, reads: counted.reads }).toEqual({
        runner,
        reads: onlyReads({ getRunnerMetrics: 1, getLock: 1 }),
      });
    }
  });
});

/** A harness with worker keys on queues, `completed[i]` jobs each. */
async function workers(
  path: (typeof PATHS)[number],
  keys: readonly [queue: string, key: string][],
  completed: (i: number) => number,
  overrides: Partial<JobsApiConfig> = {},
) {
  const counted = counting(path.driver());
  const jobs = context(counted.driver);
  const h = harness({ jobs, ...overrides });
  const m = minutesAgo(10);
  for (const [i, [queue, key]] of keys.entries()) {
    await putWorker(jobs, queue, key);
    const n = completed(i);
    const q = { ns: jobs.namespace, queue };
    if (n > 0) {
      await jobs.driver.countWorkerJobs!(q, key, m + 1_000, { completed: n });
    }
    await jobs.driver.sampleWorkerBusyness!(q, key, m + 2_000, {
      active: i % 4,
      concurrency: 4,
    });
  }
  return { h, jobs, counted, m, range: { from: m, to: m + MINUTE } };
}

/** Counts `n` completions for a key no live worker carries: a worker that has since stopped. */
async function stoppedWorker(
  jobs: BunJobs,
  queue: string,
  key: string,
  at: number,
  n: number,
): Promise<void> {
  const q = { ns: jobs.namespace, queue };
  await jobs.driver.ensureQueue(q);
  await jobs.driver.countWorkerJobs!(q, key, at, { completed: n });
}

/** `n` worker keys on `mail`, zero-padded so they sort as numbered. */
function mailWorkers(n: number): [string, string][] {
  return Array.from(
    { length: n },
    (_, i) =>
      ["mail", `mail.w${String(i).padStart(3, "0")}`] as [string, string],
  );
}

for (const path of PATHS) {
  describe(`the workers roll-up (${path.name})`, () => {
    it("rows by stable key, sorted by completed then key, with busyness totals", async () => {
      const { h, range } = await workers(
        path,
        [
          ["mail", "mail.b"],
          ["mail", "mail.a"],
          ["orders", "orders.x"],
        ],
        (i) => [2, 2, 9][i]!,
      );
      const res = await h.call("GET", `/analytics/workers${qs(range)}`);
      expect(res.status).toBe(200);
      expect(res.body.series.totals).toEqual({ completed: 13, failed: 0 });
      expect(res.body.rows.map((row: { key: string }) => row.key)).toEqual([
        "orders.x",
        "mail.a",
        "mail.b",
      ]);
      expect(res.body.rows[0]).toEqual({
        key: "orders.x",
        queue: "orders",
        totals: { completed: 9, failed: 0 },
        busyness: { samples: 1, activeMean: 2, activeMax: 2, concurrency: 4 },
      });
      expect(res.body).toMatchObject({ truncated: false, totalRows: 3 });
    });

    it("gives a live worker with nothing in range a zero row", async () => {
      const { h, jobs, range } = await workers(
        path,
        [["mail", "mail.a"]],
        () => 3,
      );
      await putWorker(jobs, "mail", "mail.new");
      const res = await h.call("GET", `/analytics/workers${qs(range)}`);
      expect(res.body.rows).toHaveLength(2);
      expect(res.body.rows[1]).toEqual({
        key: "mail.new",
        queue: "mail",
        totals: { completed: 0, failed: 0 },
        busyness: { samples: 0, activeMean: 0, activeMax: 0, concurrency: 0 },
      });
    });

    it("keys one row per key across incarnations: a redeploy keeps one row", async () => {
      const { h, jobs, range } = await workers(
        path,
        [["mail", "mail.w"]],
        () => 1,
      );
      await putWorker(jobs, "mail", "mail.w", "mail.w.2");
      const res = await h.call("GET", `/analytics/workers${qs(range)}`);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.totalRows).toBe(1);
    });

    it("answers `keys` in the order asked, a key on two queues twice, and leaves out an unknown one", async () => {
      const { h, jobs, range } = await workers(
        path,
        [
          ["mail", "shared"],
          ["orders", "shared"],
          ["mail", "solo"],
        ],
        (i) => i + 1,
      );
      await putWorker(jobs, "mail", "idle");
      const res = await h.call(
        "GET",
        `/analytics/workers${qs({ ...range, keys: ["solo", "ghost", "idle", "shared"] })}`,
      );
      expect(
        res.body.seriesByKey.map(
          (entry: { key: string; queue: string }) =>
            `${entry.queue}/${entry.key}`,
        ),
      ).toEqual(["mail/solo", "mail/idle", "mail/shared", "orders/shared"]);
      expect(res.body.seriesByKey[0].jobs.totals.completed).toBe(3);
      // A listed key with nothing in range: zeroed buckets, not left out.
      expect(res.body.seriesByKey[1].jobs.totals.completed).toBe(0);
      expect(res.body.seriesByKey[1].jobs.buckets).toHaveLength(
        res.body.series.buckets.length,
      );
      expect(res.body.seriesByKey[3].jobs.totals.completed).toBe(2);
    });

    it("refuses more than MAX_ANALYTICS_SERIES keys with BULK_LIMIT", async () => {
      const { h } = await workers(path, [["mail", "mail.a"]], () => 1);
      const keys = Array.from(
        { length: MAX_ANALYTICS_SERIES + 1 },
        (_, i) => `k${i}`,
      );
      const res = await h.call("GET", `/analytics/workers${qs({ keys })}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("BULK_LIMIT");
    });

    it("caps rows at MAX_ANALYTICS_ROWS with truncated and totalRows", async () => {
      const keys = mailWorkers(MAX_ANALYTICS_ROWS + 3);
      const { h, range } = await workers(path, keys, (i) => i);
      const res = await h.call("GET", `/analytics/workers${qs(range)}`);
      expect(res.body.rows).toHaveLength(MAX_ANALYTICS_ROWS);
      expect(res.body).toMatchObject({
        truncated: true,
        totalRows: MAX_ANALYTICS_ROWS + 3,
      });
      expect(res.body.rows[0].totals.completed).toBe(MAX_ANALYTICS_ROWS + 2);
    });

    it("hides a worker on a queue outside `queues`, and sums the visible ones for the series", async () => {
      const { h, counted, range } = await workers(
        path,
        [
          ["mail", "mail.a"],
          ["secret", "secret.a"],
        ],
        () => 5,
        { queues: ["mail"] },
      );
      counted.reset();
      const res = await h.call("GET", `/analytics/workers${qs(range)}`);
      expect(res.body.rows.map((row: { key: string }) => row.key)).toEqual([
        "mail.a",
      ]);
      expect(res.body.series.totals.completed).toBe(5);
      expect(counted.reads.getNamespaceMetrics).toBe(0);
    });

    if (path.grouped) {
      it("keeps a stopped key that still has counts in range — and its sparkline — but never a hidden queue's", async () => {
        const { h, jobs, m, range } = await workers(
          path,
          [["mail", "mail.live"]],
          () => 2,
          { queues: ["mail"] },
        );
        await stoppedWorker(jobs, "mail", "mail.gone", m + 5_000, 7);
        await stoppedWorker(jobs, "secret", "secret.gone", m + 5_000, 9);
        const res = await h.call(
          "GET",
          `/analytics/workers${qs({ ...range, keys: ["mail.gone", "secret.gone"] })}`,
        );
        expect(res.body.rows).toEqual([
          {
            key: "mail.gone",
            queue: "mail",
            totals: { completed: 7, failed: 0 },
            // It never sampled busyness in range.
            busyness: {
              samples: 0,
              activeMean: 0,
              activeMax: 0,
              concurrency: 0,
            },
          },
          expect.objectContaining({ key: "mail.live" }),
        ]);
        // The restricted series is the rows summed, the stopped key included.
        expect(res.body.series.totals.completed).toBe(9);
        expect(res.body.seriesByKey).toEqual([
          expect.objectContaining({ key: "mail.gone", queue: "mail" }),
        ]);
        expect(res.body.seriesByKey[0].jobs.totals.completed).toBe(7);
      });

      it("gives an unrestricted caller rows on a queue that no longer exists, so the rows add up to the series", async () => {
        const { h, jobs, m, range } = await workers(
          path,
          [["mail", "mail.live"]],
          () => 2,
        );
        // Counted onto a queue the namespace does not list — obliterated
        // since, or one that never held a job. No `ensureQueue`.
        for (const key of ["k0", "k1", "k2"]) {
          await jobs.driver.countWorkerJobs!(
            { ns: jobs.namespace, queue: "bulk" },
            key,
            m + 5_000,
            { completed: 2 },
          );
        }
        expect(await jobs.driver.listQueues(jobs.namespace)).not.toContain(
          "bulk",
        );
        const res = await h.call("GET", `/analytics/workers${qs(range)}`);
        expect(res.status).toBe(200);
        const rows = res.body.rows as {
          key: string;
          queue: string;
          totals: { completed: number };
        }[];
        expect(rows.map((row) => `${row.queue}/${row.key}`)).toEqual([
          "bulk/k0",
          "bulk/k1",
          "bulk/k2",
          "mail/mail.live",
        ]);
        expect(rows.reduce((sum, row) => sum + row.totals.completed, 0)).toBe(
          res.body.series.totals.completed,
        );
        expect(res.body.series.totals.completed).toBe(8);

        // A restricted caller — here by `listQueues: "authorized"`, allowing
        // every queue it is asked about — reads only the listed queues: a
        // queue it could not be asked about is never counted.
        const restricted = harness({ jobs, listQueues: "authorized" });
        const narrowed = await restricted.call(
          "GET",
          `/analytics/workers${qs(range)}`,
        );
        expect(
          narrowed.body.rows.map(
            (row: { queue: string; key: string }) => `${row.queue}/${row.key}`,
          ),
        ).toEqual(["mail/mail.live"]);
        expect(narrowed.body.series.totals.completed).toBe(2);
      });

      it("reads every worker's rows in one read, and a batch of 20 in exactly one more", async () => {
        const keys = mailWorkers(30);
        const { h, counted, range } = await workers(path, keys, (i) => i);

        counted.reset();
        await h.call("GET", `/analytics/workers${qs(range)}`);
        const rollup = { ...counted.reads };
        expect(rollup).toEqual(
          onlyReads({ getWorkerMetricsTotals: 1, getNamespaceMetrics: 1 }),
        );

        counted.reset();
        const batch = await h.call(
          "GET",
          `/analytics/workers${qs({ ...range, keys: keys.slice(0, MAX_ANALYTICS_SERIES).map(([, key]) => key) })}`,
        );
        expect(batch.status).toBe(200);
        expect(batch.body.seriesByKey).toHaveLength(MAX_ANALYTICS_SERIES);
        expect(counted.reads).toEqual({ ...rollup, getWorkerMetricsMany: 1 });
      });

      it("costs the same reads with 5 workers as with 200", async () => {
        const reads: ReadCounts[] = [];
        for (const n of [5, 200]) {
          const { h, counted, range } = await workers(
            path,
            mailWorkers(n),
            (i) => i % 3,
          );
          counted.reset();
          const res = await h.call("GET", `/analytics/workers${qs(range)}`);
          expect(res.body.totalRows).toBe(n);
          reads.push({ ...counted.reads });
        }
        expect(reads[1]).toEqual(reads[0]!);
        expect(reads[0]).toEqual(
          onlyReads({ getWorkerMetricsTotals: 1, getNamespaceMetrics: 1 }),
        );
      });
    } else {
      it("lists live workers only: a stopped key has no read that would find it", async () => {
        const { h, jobs, m, range } = await workers(
          path,
          [["mail", "mail.live"]],
          () => 2,
        );
        await stoppedWorker(jobs, "mail", "mail.gone", m + 5_000, 7);
        const res = await h.call("GET", `/analytics/workers${qs(range)}`);
        expect(res.body.rows.map((row: { key: string }) => row.key)).toEqual([
          "mail.live",
        ]);
      });

      it("serves a batch of 20 keys with no driver reads of its own", async () => {
        const keys = mailWorkers(30);
        const { h, counted, range } = await workers(path, keys, (i) => i);

        counted.reset();
        await h.call("GET", `/analytics/workers${qs(range)}`);
        const rollup = { ...counted.reads };

        counted.reset();
        const batch = await h.call(
          "GET",
          `/analytics/workers${qs({ ...range, keys: keys.slice(0, MAX_ANALYTICS_SERIES).map(([, key]) => key) })}`,
        );
        expect(batch.status).toBe(200);
        expect(batch.body.seriesByKey).toHaveLength(MAX_ANALYTICS_SERIES);
        expect(counted.reads).toEqual(rollup);
        expect(counted.reads).toEqual(
          onlyReads({ getNamespaceMetrics: 1, getWorkerMetrics: keys.length }),
        );
      });
    }
  });
}

describe("one worker", () => {
  it("carries two ranges: throughput at the width asked, busyness at its own coarser one", async () => {
    const jobs = context();
    const h = harness({ jobs });
    await putWorker(jobs, "mail", "mail.w");
    const q = { ns: jobs.namespace, queue: "mail" };
    const s = secondsAgo(90);
    await jobs.driver.countWorkerJobs!(q, "mail.w", s + 500, { completed: 2 });
    await jobs.driver.countWorkerJobs!(q, "mail.w", s + 3 * SECOND, {
      failed: 1,
    });
    await jobs.driver.sampleWorkerBusyness!(q, "mail.w", s + 1_000, {
      active: 3,
      concurrency: 4,
    });

    const res = await h.call(
      "GET",
      `/queues/mail/analytics/workers/mail.w${qs({ from: s, to: s + 60 * SECOND, resolution: 1 })}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.key).toBe("mail.w");
    expect(res.body.queue).toBe("mail");
    expect(res.body.jobs.range.resolution).toBe(1);
    expect(res.body.jobs.range.clamped).toBe(false);
    expect(res.body.jobs.buckets).toHaveLength(60);
    expect(res.body.jobs.totals).toEqual({ completed: 2, failed: 1 });
    // Busyness is sampled every DEFAULT_BUSYNESS_INTERVAL_MS, so it is never
    // served at 1 s: its own range, coarser, saying why.
    expect(DEFAULT_BUSYNESS_INTERVAL_MS).toBe(10_000);
    expect(res.body.busyness.range.resolution).toBe(60);
    expect(res.body.busyness.range.reason).toBe("resolution");
    expect(res.body.busyness.totals).toEqual({
      samples: 1,
      activeMean: 3,
      activeMax: 3,
      concurrency: 4,
    });
    // A bucket nothing was sampled in says `samples: 0`, not idle.
    expect(
      res.body.busyness.buckets.some(
        (b: { samples: number }) => b.samples === 0,
      ) || res.body.busyness.buckets.length === 1,
    ).toBe(true);
    expect(res.body).not.toHaveProperty("range");
  });

  it("reads a key nothing was counted for as zeros, not 404", async () => {
    const jobs = context();
    const h = harness({ jobs });
    await putWorker(jobs, "mail", "mail.w");
    const res = await h.call("GET", "/queues/mail/analytics/workers/gone.w");
    expect(res.status).toBe(200);
    expect(res.body.jobs.totals).toEqual({ completed: 0, failed: 0 });
  });
});

describe("/overview", () => {
  /** A namespace with two queues' completions, `n` workers and `n` runners with counts. */
  async function fleet(path: (typeof PATHS)[number], n: number) {
    const counted = counting(path.driver());
    const jobs = context(counted.driver);
    const h = harness({ jobs });
    const m = minutesAgo(10);
    await completeAt(jobs, "orders", m + 1_000);
    await completeAt(jobs, "mail", m + 1_000);
    const q = { ns: jobs.namespace, queue: "mail" };
    for (let i = 0; i < n; i++) {
      await putWorker(jobs, "mail", `mail.w${i}`);
      await jobs.driver.countWorkerJobs!(q, `mail.w${i}`, m + 1_000, {
        completed: 1,
      });
      await registerRunnerElsewhere(jobs, `r${i}`);
      await jobs.driver.countRunnerRun!(
        jobs.namespace,
        runnerKey(`r${i}`),
        m + 1_000,
        { started: 1 },
      );
    }
    return { h, counted, m, range: { from: m, to: m + MINUTE } };
  }

  it("carries the jobs series, and the runners and workers roll-ups, on the grouped path", async () => {
    const { h, counted, m, range } = await fleet(PATHS[0], 25);
    counted.reset();
    const res = await h.call("GET", `/overview${qs(range)}`);
    expect(res.status).toBe(200);
    const { analytics } = res.body;
    expect(analytics.range).toMatchObject({
      from: m,
      to: m,
      end: m + MINUTE,
      resolution: 60,
    });
    expect(analytics.jobs.totals).toEqual({ completed: 2, failed: 0 });
    expect(analytics.jobs.range).toEqual(analytics.range);
    expect(analytics.runners).toMatchObject({
      runningNow: 0,
      truncated: false,
      totalRows: 25,
    });
    expect(analytics.runners.series.totals.started).toBe(25);
    expect(analytics.workers).toMatchObject({
      truncated: false,
      totalRows: 25,
    });
    expect(analytics.workers.series.totals.completed).toBe(25);
    expect(analytics.workers.series.range).toEqual(analytics.range);
    expect(counted.reads).toEqual(
      onlyReads({
        // The jobs, runs and worker-jobs roll-ups.
        getNamespaceMetrics: 3,
        getRunnerMetricsTotals: 1,
        getWorkerMetricsTotals: 1,
        getLock: 25,
      }),
    );

    // The same roll-ups the two routes answer.
    const runners = await h.call("GET", `/analytics/runners${qs(range)}`);
    const workers = await h.call("GET", `/analytics/workers${qs(range)}`);
    expect(analytics.runners).toEqual(runners.body);
    expect(analytics.workers).toEqual(workers.body);
  });

  it("costs the same metrics reads with 5 workers and runners as with 200, and at most MAX_ANALYTICS_ROWS lock reads", async () => {
    const reads: ReadCounts[] = [];
    for (const n of [5, 200]) {
      const { h, counted, range } = await fleet(PATHS[0], n);
      counted.reset();
      const res = await h.call("GET", `/overview${qs(range)}`);
      expect(res.body.analytics.workers.totalRows).toBe(n);
      expect(res.body.analytics.runners.totalRows).toBe(n);
      reads.push({ ...counted.reads });
    }
    const { getLock: few, ...fewMetrics } = reads[0]!;
    const { getLock: many, ...manyMetrics } = reads[1]!;
    expect(manyMetrics).toEqual(fewMetrics);
    const fewWithoutLocks: ReadCounts = { ...fewMetrics, getLock: 0 };
    expect(fewWithoutLocks).toEqual(
      onlyReads({
        getNamespaceMetrics: 3,
        getRunnerMetricsTotals: 1,
        getWorkerMetricsTotals: 1,
      }),
    );
    expect(few).toBe(5);
    expect(many).toBe(MAX_ANALYTICS_ROWS);
  });

  it("carries only the jobs series on the per-entity path: no per-entity rows on every poll", async () => {
    const { h, counted, m, range } = await fleet(PATHS[1], 25);
    counted.reset();
    const res = await h.call("GET", `/overview${qs(range)}`);
    expect(res.status).toBe(200);
    expect(res.body.analytics.jobs.totals).toEqual({ completed: 2, failed: 0 });
    expect(res.body.analytics).not.toHaveProperty("runners");
    expect(res.body.analytics).not.toHaveProperty("workers");
    // One read whatever the fleet: 25 workers and 25 runners cost nothing.
    expect(counted.reads).toEqual(onlyReads({ getNamespaceMetrics: 1 }));
    // `from`/`to` decide the shipped throughput fields too, a minute each.
    expect(res.body.throughputSeries).toMatchObject({
      interval: MINUTE,
      from: m,
      to: m,
      completed: 2,
    });
    expect(res.body.throughput).toEqual({
      minutes: 1,
      completed: 2,
      failed: 0,
    });
  });

  it("leaves a section out where the API has no runners, or the driver counts no workers", async () => {
    const jobsOnly = harness({ jobs: context(), runners: false });
    const res = await jobsOnly.call("GET", "/overview");
    expect(res.body.analytics).not.toHaveProperty("runners");
    expect(res.body.analytics).toHaveProperty("workers");

    const noWorkers = harness({
      jobs: context(without(new MemoryDriver(), ["getWorkerMetrics"])),
    });
    const bare = await noWorkers.call("GET", "/overview");
    expect(bare.body.analytics).toHaveProperty("runners");
    expect(bare.body.analytics).not.toHaveProperty("workers");
  });

  it("leaves `analytics` out where the backend records none", async () => {
    const h = harness({
      jobs: context(without(new MemoryDriver(), ANALYTICS_METHODS)),
    });
    const res = await h.call("GET", "/overview");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("analytics");
  });
});

describe("the shipped minutes routes", () => {
  it("takes `from`/`to` on /queues/:queue/throughput, exclusive `to`, a minute per bucket", async () => {
    const jobs = context();
    const h = harness({ jobs });
    const m = minutesAgo(20);
    await completeAt(jobs, "orders", m + 1_000);
    await completeAt(jobs, "orders", m + 2 * MINUTE + 1_000);
    const res = await h.call(
      "GET",
      `/queues/orders/throughput${qs({ from: m, to: m + 2 * MINUTE, resolution: 1 })}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      interval: MINUTE,
      from: m,
      to: m + MINUTE,
      buckets: [
        { at: m, completed: 1, failed: 0 },
        { at: m + MINUTE, completed: 0, failed: 0 },
      ],
      completed: 1,
      failed: 0,
    });
    // `minutes` alone still works as it always has.
    const legacy = await h.call("GET", "/queues/orders/throughput?minutes=30");
    expect(legacy.body.buckets).toHaveLength(30);
    expect(legacy.body.completed).toBe(2);
  });
});

describe("meta, pruning and authorization", () => {
  it("reports /meta.analytics from the driver, and null with every analytics route pruned when it serves none", async () => {
    const served = harness({ jobs: context() });
    const meta = await served.call("GET", "/meta");
    expect(meta.body.analytics).toMatchObject({
      resolutions: [1, 60],
      maxSeries: MAX_ANALYTICS_SERIES,
      busynessIntervalMs: DEFAULT_BUSYNESS_INTERVAL_MS,
    });

    const bare = harness({
      jobs: context(without(new MemoryDriver(), ANALYTICS_METHODS)),
    });
    expect((await bare.call("GET", "/meta")).body.analytics).toBeNull();
    for (const path of [
      "/analytics/jobs",
      "/queues/mail/analytics/jobs",
      "/analytics/runners",
      "/runners/r/analytics",
      "/analytics/workers",
      "/queues/mail/analytics/workers/k",
    ]) {
      const res = await bare.call("GET", path);
      expect({ path, status: res.status, code: res.body.code }).toEqual({
        path,
        status: 404,
        code: "ROUTE_NOT_FOUND",
      });
    }
  });

  it("prunes the runner and worker routes on a driver without their metrics, keeping the jobs series", async () => {
    const h = harness({
      jobs: context(
        without(new MemoryDriver(), ["countRunnerRun", "getWorkerMetrics"]),
      ),
    });
    expect((await h.call("GET", "/analytics/runners")).status).toBe(404);
    expect((await h.call("GET", "/runners/r/analytics")).status).toBe(404);
    expect((await h.call("GET", "/analytics/workers")).status).toBe(404);
    expect((await h.call("GET", "/analytics/jobs")).status).toBe(200);
    const meta = (await h.call("GET", "/meta")).body;
    expect(meta.features.runnerMetrics).toBe(false);
    expect(meta.features.workerMetrics).toBe(false);
    expect(meta.analytics).not.toBeNull();
  });

  it("asks metrics.read with the runner, queue or worker key the path names — and no new action", async () => {
    const jobs = context();
    const h = harness({ jobs });
    await registerRunnerElsewhere(jobs, "nightly");
    await putWorker(jobs, "mail", "mail.w");
    const cases: [string, Record<string, string>][] = [
      ["/analytics/jobs", {}],
      ["/queues/mail/analytics/jobs", { queue: "mail" }],
      ["/analytics/runners", {}],
      ["/runners/nightly/analytics", { runner: "nightly" }],
      ["/analytics/workers", {}],
      [
        "/queues/mail/analytics/workers/mail.w",
        { queue: "mail", workerKey: "mail.w" },
      ],
    ];
    for (const [path, target] of cases) {
      h.calls.length = 0;
      const res = await h.call("GET", path);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      expect(h.calls).toHaveLength(1);
      const { route: _route, ...call } = h.calls[0]!;
      expect(call).toEqual({
        action: "metrics.read",
        mutation: false,
        transport: "http",
        ...target,
      });
    }
    expect(JOBS_API_ACTIONS.filter((a) => a.includes("analytics"))).toEqual([]);
  });

  it("answers a denied caller 403 before reading anything", async () => {
    const counted = counting(new MemoryDriver());
    const h = harness({
      jobs: context(counted.driver),
      authorize: () => ({ allow: false, status: 403 }),
    });
    const res = await h.call("GET", "/analytics/runners?ids=a");
    expect(res.status).toBe(403);
    expect(counted.reads.getNamespaceMetrics).toBe(0);
  });
});

describe("pins and the public barrel", () => {
  it("pins the busyness interval to the worker's default report interval", () => {
    expect(DEFAULT_BUSYNESS_INTERVAL_MS).toBe(DEFAULT_REPORT_INTERVAL);
  });

  it("exports the grouped-read helpers from the package root, the same values the drivers use", () => {
    const names = [
      "hasMetricBuckets",
      "runnerTotalsOf",
      "splitWorkerMetricsEntity",
      "totalBusynessStats",
      "totalDurationStats",
      "uniqueWorkerRefs",
      "workerMetricsEntity",
      "workerTotalsOf",
    ] as const;
    for (const name of names) {
      expect({ name, type: typeof barrel[name] }).toEqual({
        name,
        type: "function",
      });
      expect(barrel[name]).toBe(drivers[name] as never);
    }
    // The types, as a driver written elsewhere would name them.
    const row: barrel.RunnerMetricsTotals = {
      runner: runnerKey("a"),
      runs: barrel.zeroCounters(barrel.RUNNER_RUN_COUNTERS),
    };
    const ref: barrel.WorkerMetricsRef = { queue: "mail", key: "k" };
    const query: barrel.WorkerMetricsTotalsQuery = {
      from: 0,
      to: 0,
      interval: MINUTE,
      queues: [ref.queue],
    };
    const totals: barrel.WorkerMetricsTotals[] = [];
    const series: (barrel.RunnerMetricsSeries | barrel.WorkerMetricsSeries)[] =
      [];
    const runnerQuery: barrel.RunnerMetricsTotalsQuery = {
      ...query,
      runners: [row.runner],
    };
    const shape: (barrel.RunnerRunTotals | barrel.WorkerJobTotals)[] = [row];
    expect([totals, series, runnerQuery.runners, shape.length]).toEqual([
      [],
      [],
      ["r:a"],
      1,
    ]);
  });
});

describe("the document", () => {
  it("says, on every range read, that `to` is exclusive and the response's `to` is the last bucket", () => {
    const api = createJobsApi(
      apiConfig({ jobs: context(), actions: [...JOBS_API_ACTIONS] }),
    );
    const doc = api.openapi() as unknown as {
      paths: Record<string, Record<string, any>>;
    };
    for (const path of [
      "/analytics/jobs",
      "/queues/{queue}/analytics/jobs",
      "/analytics/runners",
      "/runners/{runner}/analytics",
      "/analytics/workers",
      "/queues/{queue}/analytics/workers/{key}",
    ]) {
      const operation = doc.paths[path]!.get;
      expect({
        path,
        says: operation.description.includes("`to` is exclusive"),
      }).toEqual({
        path,
        says: true,
      });
      const to = operation.parameters.find(
        (parameter: { name: string }) => parameter.name === "to",
      );
      expect(JSON.stringify(to.schema)).toContain(
        "start of the **last** bucket",
      );
      expect(Object.keys(operation.responses)).toContain("400");
    }
  });
});
