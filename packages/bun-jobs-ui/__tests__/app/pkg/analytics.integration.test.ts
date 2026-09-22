import type {
  BunQueueWorker,
  BunRunner,
  JobsDriver,
} from "@kingsleyweb/bun-jobs";
import type { FetchLike } from "../../../app/api/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  FileDriver,
  MAX_ANALYTICS_ROWS,
  MAX_ANALYTICS_SERIES,
  MemoryDriver,
} from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * The Overview's analytics against REAL data: a real `createJobsApi` over real
 * `BunQueueWorker`s doing real jobs and a real `BunRunner` running real runs,
 * recorded by the drivers' own metrics. The UI's analytics were built against
 * mocked HTTP; this is the proof they read the real routes right.
 *
 * Three deployments, each its own namespace, API and fetch shim:
 *
 * - **live** (memory, mode `both`): workers on four queues — one that fails
 *   a job, one stopped after its work (a key that is no longer live but still
 *   has counts), one live and idle (a zero row) — and a runner that succeeds
 *   twice and throws once.
 * - **fleet** (memory, mode `jobs`): more than `MAX_ANALYTICS_ROWS` worker
 *   keys. Starting 130 real workers is slow and proves nothing more about the
 *   UI, so their counts are written through the **real driver API**
 *   (`countWorkerJobs`, the very method a worker's own recorder calls) and
 *   read back through the real routes.
 * - **file** (the file driver, which keeps minutes only): a real worker and
 *   runner, read over a sub-minute preset, so the API answers
 *   `reason: "driver"`.
 *
 * Compiled without the DOM lib (see tsconfig.json): the DOM side is loaded by
 * dynamic imports the compiler does not follow, and the interfaces below
 * restate the little this file uses of them. Every scenario only reads, so
 * the suite passes under `bun test --randomize`.
 */

/** What this file uses of `../dom`. */
interface DomModule {
  /** Registers happy-dom and the per-test cleanup. */
  setupDom: () => void;
}

/** What this file uses of `../register-dom`. */
interface RegisterDomModule {
  /** Bun's own networking globals, captured before happy-dom replaced them. */
  native: { Request: typeof Request; Response: typeof Response };
}

/** What one Overview section shows (`../analytics/realApiOverview`'s `SectionView`). */
interface SectionView {
  /** The whole section's text. */
  text: string;
  /** The range caption, or `null` when the response was not clamped. */
  caption: { text: string; reason: string | null } | null;
  /** The table rows on screen. */
  rows: { id: string; cells: string[] }[];
  /** The "the N busiest of M" note. */
  truncated: string | null;
  /** The RANGE_NOT_RETAINED explanation. */
  notRetained: string | null;
  /** An error alert's text. */
  alert: string | null;
  /** Every sparkline's accessible label. */
  sparklines: string[];
  /** The headline figures, `label → value`. */
  figures: Record<string, string>;
}

/** A section of the Overview. */
type SectionId = "jobs" | "runners" | "workers";

/** What this file uses of `../analytics/realApiOverview`. */
interface OverviewModule {
  /** Renders the Overview at `search` over `fetch`. */
  mountOverview: (
    fetch: FetchLike,
    search?: string,
  ) => Promise<{
    section: (
      id: SectionId,
      ready: (view: SectionView) => boolean,
      timeoutMs?: number,
    ) => Promise<SectionView>;
    has: (id: SectionId) => boolean;
    unmount: () => void;
  }>;
  /** Renders the Workers screen and reads worker `id`'s row. */
  readWorkerRow: (
    fetch: FetchLike,
    id: string,
    ready: (view: { headers: string[]; cells: string[] }) => boolean,
  ) => Promise<{ headers: string[]; cells: string[] }>;
}

/** One request the UI made, with what the API answered. */
interface Exchange {
  /** The path, without the query. */
  path: string;
  /** The query. */
  query: URLSearchParams;
  /** The status the API answered with. */
  status: number;
  /** The parsed answer, for a JSON body. */
  json: unknown;
}

/** One deployment under test. */
interface Deployment {
  /** Its jobs context. */
  jobs: BunJobs;
  /** The fetch the UI is given. */
  fetch: FetchLike;
  /** Every request the UI made to it, oldest first. */
  exchanges: Exchange[];
}

/** Imports a module by a specifier the compiler does not resolve. */
function load<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>;
}

const dom = await load<DomModule>(["..", "dom"].join("/"));
const { native } = await load<RegisterDomModule>(
  ["..", "register-dom"].join("/"),
);
dom.setupDom();

const BASE = "/jobs-api";
const SERVICE = "api";
/**
 * The runner handler: returns, or throws when asked to. A path, not a `URL`:
 * in a whole-package run happy-dom's `URL` is the global, which the runner's
 * `instanceof URL` does not recognise.
 */
const RUNNER_FILE = join(
  import.meta.dir,
  "fixtures/analytics/throwing-runner.ts",
);
/** Each scenario renders the whole app over real reads; more than `bun test`'s 5 s default. */
const TEST_TIMEOUT_MS = 30_000;
/** How many worker keys the fleet has — more than a roll-up returns. */
const FLEET_KEYS = MAX_ANALYTICS_ROWS + 30;

let live: Deployment;
let fleet: Deployment;
let file: Deployment;
let fileRoot: string;
const workers: BunQueueWorker<unknown, unknown>[] = [];
const runners: BunRunner[] = [];

/**
 * Runs `fn` with Bun's `Response` as the global: the API builds its
 * responses from the global, which happy-dom has replaced.
 */
async function withBunGlobals<T>(fn: () => Promise<T>): Promise<T> {
  const saved = globalThis.Response;
  globalThis.Response = native.Response;
  try {
    return await fn();
  } finally {
    globalThis.Response = saved;
  }
}

/** Resolves once `check` holds, reporting `what` if it never does. */
async function until(
  check: () => boolean | Promise<boolean>,
  what: () => string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out: ${what()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Mounts `jobs`' API in mode `mode` and returns the recording fetch shim over it. */
function deploy(jobs: BunJobs, mode: "jobs" | "both"): Deployment {
  const api = createJobsApi({
    jobs,
    mode,
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  const exchanges: Exchange[] = [];
  // The app's AbortSignal is happy-dom's, which Bun's Request refuses.
  const fetch: FetchLike = async (input, { signal: _signal, ...init }) =>
    withBunGlobals(async () => {
      const url = new URL(input, "http://localhost");
      const response = await root.fetch(new native.Request(url.href, init));
      const text = await response.text();
      let json: unknown;
      try {
        json = text === "" ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      exchanges.push({
        path: url.pathname.slice(BASE.length),
        query: url.searchParams,
        status: response.status,
        json,
      });
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });
  return { jobs, fetch, exchanges };
}

/** A direct read of the real API, not recorded as the UI's. */
async function read<T>(deployment: Deployment, path: string): Promise<T> {
  const response = await deployment.fetch(`${BASE}${path}`, {
    method: "GET",
  });
  deployment.exchanges.pop();
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

/** Starts a real worker on `queue`, failing a job whose data says so. */
function startWorker(jobs: BunJobs, queue: string) {
  const worker = jobs.worker<{ fail?: boolean }, string>(
    queue,
    async (job) => {
      if (job.data?.fail) {
        throw new Error("asked to fail");
      }
      return "ok";
    },
    {
      concurrency: 2,
      reportInterval: 500,
      pollInterval: 10,
      waitToExit: false,
      logger: noopLogger,
    },
  );
  workers.push(worker as BunQueueWorker<unknown, unknown>);
  void worker.run();
  return worker;
}

/** Adds `count` jobs to `queue`, the first `failing` of them failing, and waits until every one settled. */
async function work(jobs: BunJobs, queue: string, count: number, failing = 0) {
  const q = jobs.queue(queue);
  for (let index = 0; index < count; index++) {
    await q.add("task", { fail: index < failing }, { attempts: 1 });
  }
  await until(
    async () => {
      const counts = await q.count();
      return counts.completed + counts.failed + counts.dead === count;
    },
    () => `${queue}: ${count} jobs never settled`,
  );
}

/** Starts a real in-process runner and runs it: `ok` successes, then `threw` runs that throw. */
async function runRunner(jobs: BunJobs, id: string, ok: number, threw: number) {
  const runner = jobs.runner({
    id,
    file: RUNNER_FILE,
    executionMode: "in-process",
    waitToExit: false,
  });
  runners.push(runner);
  await runner.start();
  const plan = [
    ...Array.from<boolean>({ length: ok }).fill(false),
    ...Array.from<boolean>({ length: threw }).fill(true),
  ];
  for (const [index, fail] of plan.entries()) {
    await runner.trigger({ args: { fail } }).catch(() => undefined);
    await until(
      async () => (await runner.history()).length === index + 1,
      () => `${id}: run ${index + 1} never recorded`,
    );
    await until(
      () => runner.activeRuns.size === 0,
      () => `${id}: run ${index + 1} never finished`,
    );
  }
}

/** The workers roll-up's totals for `key`, straight from the API. */
async function workerTotals(deployment: Deployment, key: string) {
  const now = Date.now();
  const body = await read<{
    rows: { key: string; totals: { completed: number; failed: number } }[];
  }>(
    deployment,
    `/analytics/workers?from=${now - 3_600_000}&to=${now + 1_000}&resolution=60`,
  );
  return body.rows.find((row) => row.key === key)?.totals;
}

beforeAll(async () => {
  // ---- live ----------------------------------------------------------------
  const liveJobs = new BunJobs({
    namespace: "ui-analytics-live",
    service: SERVICE,
    driver: new MemoryDriver(),
    logger: noopLogger,
  });
  live = deploy(liveJobs, "both");
  startWorker(liveJobs, "emails");
  startWorker(liveJobs, "reports");
  startWorker(liveJobs, "idle");
  const legacy = startWorker(liveJobs, "legacy");
  await work(liveJobs, "emails", 6, 1);
  await work(liveJobs, "reports", 3);
  await work(liveJobs, "legacy", 4);
  await runRunner(liveJobs, "nightly", 2, 1);
  // Counts are flushed once a second; wait until the API has all of them.
  await until(
    async () =>
      (await workerTotals(live, `${SERVICE}.emails`))?.completed === 5,
    () => "the emails worker's counts never reached the API",
  );
  await until(
    async () =>
      (await workerTotals(live, `${SERVICE}.legacy`))?.completed === 4,
    () => "the legacy worker's counts never reached the API",
  );
  // Stopped for good: its key is no longer live, but its counts are in range.
  await legacy.close({ force: true });
  await until(
    async () =>
      !(
        await read<{ items: { queue: string }[] }>(live, "/workers")
      ).items.some((worker) => worker.queue === "legacy"),
    () => "the legacy worker never left the registry",
  );

  // ---- fleet ---------------------------------------------------------------
  const fleetDriver: JobsDriver = new MemoryDriver();
  const fleetJobs = new BunJobs({
    namespace: "ui-analytics-fleet",
    service: SERVICE,
    driver: fleetDriver,
    logger: noopLogger,
  });
  fleet = deploy(fleetJobs, "jobs");
  // The rows are read over the queues the API lists, and a queue is listed
  // once it has held a job: without one, the keys' counts reach the summed
  // series but no row (reported to the bun-jobs session).
  await fleetJobs.queue("bulk").add("seed", {});
  const now = Date.now();
  for (let index = 0; index < FLEET_KEYS; index++) {
    // The real driver method a worker's recorder calls; key i did i + 1 jobs,
    // so the busiest is the last and the ranking is unambiguous.
    await fleetDriver.countWorkerJobs!(
      { ns: "ui-analytics-fleet", queue: "bulk" },
      fleetKey(index),
      now,
      { completed: index + 1, failed: index % 10 === 0 ? 1 : 0 },
    );
  }

  // ---- file ----------------------------------------------------------------
  fileRoot = mkdtempSync(join(tmpdir(), "bun-jobs-ui-analytics-"));
  const fileJobs = new BunJobs({
    namespace: "ui-analytics-file",
    service: SERVICE,
    driver: new FileDriver({ root: fileRoot }),
    logger: noopLogger,
  });
  file = deploy(fileJobs, "both");
  startWorker(fileJobs, "emails");
  await work(fileJobs, "emails", 3);
  await runRunner(fileJobs, "nightly", 1, 0);
  await until(
    async () =>
      (await workerTotals(file, `${SERVICE}.emails`))?.completed === 3,
    () => "the file worker's counts never reached the API",
  );
}, 60_000);

afterAll(async () => {
  for (const worker of workers) {
    await worker.close({ force: true }).catch(() => undefined);
  }
  for (const deployment of [live, fleet, file]) {
    await deployment?.jobs.close().catch(() => undefined);
  }
  if (fileRoot) {
    rmSync(fileRoot, { recursive: true, force: true });
  }
});

/** The fleet's `index`th worker key, zero-padded so it sorts as it counts. */
function fleetKey(index: number): string {
  return `fleet-${String(index + 1).padStart(3, "0")}`;
}

/** Loads the DOM harness. */
function harness(): Promise<OverviewModule> {
  return load<OverviewModule>(["..", "analytics", "realApiOverview"].join("/"));
}

/** The UI's requests to `path` since `from`, split by whether they named a batch. */
function reads(deployment: Deployment, path: string, from: number) {
  const all = deployment.exchanges
    .slice(from)
    .filter((exchange) => exchange.path === path);
  return {
    all,
    rollups: all.filter(
      (one) => !one.query.has("ids") && !one.query.has("keys"),
    ),
    batches: all.filter((one) => one.query.has("ids") || one.query.has("keys")),
  };
}

describe("the Overview over real recorded analytics", () => {
  it(
    "renders the Jobs, Runners and Workers sections from real rows and series",
    async () => {
      const overview = await (await harness()).mountOverview(live.fetch);
      try {
        const jobs = await overview.section(
          "jobs",
          (view) => view.sparklines.length > 0,
        );
        // 6 + 3 + 4 jobs, one of them failed: what the real workers did.
        expect(jobs.sparklines[0]).toContain("12 completed, 1 failed");
        expect(jobs.alert).toBeNull();

        const runners = await overview.section(
          "runners",
          (view) =>
            view.rows.some((row) => row.id === "nightly") &&
            view.sparklines.length >= 3,
        );
        const nightly = runners.rows.find((row) => row.id === "nightly")!;
        // Runner, Started, Succeeded, Failed (threw), Timed out / killed, Running now.
        expect(nightly.cells.slice(0, 6)).toEqual([
          "nightly",
          "3",
          "2",
          "1",
          "0 / 0",
          "0",
        ]);
        expect(runners.figures.Failed).toBe("1");
        expect(runners.figures["Timed out / killed"]).toBe("0 / 0");
        expect(runners.figures["Running now"]).toBe("0");
        expect(
          runners.sparklines.some((label) =>
            label.startsWith("nightly: 3 started, 1 failed"),
          ),
        ).toBe(true);

        const workersView = await overview.section(
          "workers",
          (view) =>
            view.rows.length >= 4 &&
            view.sparklines.length >= 1 + view.rows.length,
        );
        const row = (queue: string) =>
          workersView.rows.find((one) => one.id === `${SERVICE}.${queue}`);
        // Worker, Queue, Completed, Failed, …
        expect(row("emails")?.cells.slice(1, 4)).toEqual(["emails", "5", "1"]);
        expect(row("reports")?.cells.slice(1, 4)).toEqual([
          "reports",
          "3",
          "0",
        ]);
        // Stopped, but its counts are in range: the rows answer "who did the
        // work in this window", not "who is running".
        expect(row("legacy")?.cells.slice(1, 4)).toEqual(["legacy", "4", "0"]);
        // Live and idle: a row of zeros.
        expect(row("idle")?.cells.slice(1, 4)).toEqual(["idle", "0", "0"]);
        // Ranked by completed.
        expect(workersView.rows[0]!.id).toBe(`${SERVICE}.emails`);
        expect(workersView.figures["Worker keys"]).toBe("4");
        expect(workersView.text).toContain(
          "It is not a list of running workers",
        );
        expect(workersView.truncated).toBeNull();
      } finally {
        overview.unmount();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "costs two requests per section against the real routes",
    async () => {
      const start = live.exchanges.length;
      const overview = await (await harness()).mountOverview(live.fetch);
      try {
        await overview.section(
          "runners",
          (view) =>
            view.rows.length > 0 &&
            view.sparklines.length >= 2 + view.rows.length,
        );
        await overview.section(
          "workers",
          (view) =>
            view.rows.length > 0 &&
            view.sparklines.length >= 1 + view.rows.length,
        );
        await overview.section("jobs", (view) => view.sparklines.length > 0);

        const runnerReads = reads(live, "/analytics/runners", start);
        expect(runnerReads.rollups).toHaveLength(1);
        expect(runnerReads.batches).toHaveLength(1);
        expect(runnerReads.batches[0]!.query.getAll("ids")).toEqual([
          "nightly",
        ]);
        const workerReads = reads(live, "/analytics/workers", start);
        expect(workerReads.rollups).toHaveLength(1);
        expect(workerReads.batches).toHaveLength(1);
        expect(workerReads.batches[0]!.query.getAll("keys")).toHaveLength(4);
        expect(reads(live, "/analytics/jobs", start).all).toHaveLength(1);
        // Every one of them answered 200: nothing here was a mocked shape.
        for (const exchange of live.exchanges.slice(start)) {
          expect(`${exchange.path} ${exchange.status}`).toBe(
            `${exchange.path} 200`,
          );
        }
      } finally {
        overview.unmount();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "shows the clamped caption with the reason the API gave for a partly retained range",
    async () => {
      // Ten minutes asks for one-second buckets; the memory driver keeps five
      // minutes of those, so the API answers in minutes with reason "retention".
      const start = live.exchanges.length;
      const overview = await (
        await harness()
      ).mountOverview(live.fetch, "?range=600s");
      try {
        for (const id of ["jobs", "runners", "workers"] as const) {
          const view = await overview.section(
            id,
            (one) => one.caption !== null,
          );
          expect(view.caption!.reason).toBe("retention");
          expect(view.caption!.text).toContain("1-minute buckets");
        }
        const answered = live.exchanges
          .slice(start)
          .find((exchange) => exchange.path === "/analytics/jobs")!;
        expect(answered.query.get("resolution")).toBe("1");
        expect(
          (answered.json as { range: { clamped: boolean; reason: string } })
            .range,
        ).toMatchObject({ clamped: true, reason: "retention" });
      } finally {
        overview.unmount();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "explains RANGE_NOT_RETAINED rather than failing",
    async () => {
      // A whole day, ending two days ago: older than the minute retention.
      const to = Date.now() - 2 * 86_400_000;
      const start = live.exchanges.length;
      const overview = await (
        await harness()
      ).mountOverview(live.fetch, `?range=${to - 86_400_000}-${to}`);
      try {
        for (const id of ["jobs", "runners", "workers"] as const) {
          const view = await overview.section(
            id,
            (one) => one.notRetained !== null,
          );
          expect(view.notRetained).toContain(
            "No numbers are kept for this range",
          );
          expect(view.notRetained).toContain("its oldest figure is from");
          expect(view.alert).toBeNull();
        }
        const refused = live.exchanges
          .slice(start)
          .filter((exchange) => exchange.path.startsWith("/analytics/"));
        expect(refused.length).toBeGreaterThan(0);
        for (const exchange of refused) {
          expect(exchange.status).toBe(400);
          expect(exchange.json).toMatchObject({ code: "RANGE_NOT_RETAINED" });
        }
      } finally {
        overview.unmount();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the Workers section with more keys than a roll-up returns", () => {
  it(
    "shows the 100 busiest of every key, in two requests",
    async () => {
      const start = fleet.exchanges.length;
      const overview = await (await harness()).mountOverview(fleet.fetch);
      try {
        const view = await overview.section(
          "workers",
          (one) =>
            one.truncated !== null &&
            one.sparklines.length >= 1 + one.rows.length,
        );
        expect(view.truncated).toContain(
          `Showing the ${MAX_ANALYTICS_ROWS} busiest worker keys of ${FLEET_KEYS}`,
        );
        expect(view.figures["Worker keys"]).toBe(String(FLEET_KEYS));
        // One page on screen, the busiest first.
        expect(view.rows).toHaveLength(MAX_ANALYTICS_SERIES);
        expect(view.rows[0]!.id).toBe(fleetKey(FLEET_KEYS - 1));
        expect(view.rows[0]!.cells[2]).toBe(String(FLEET_KEYS));

        const workerReads = reads(fleet, "/analytics/workers", start);
        expect(workerReads.rollups).toHaveLength(1);
        expect(workerReads.batches).toHaveLength(1);
        expect(workerReads.batches[0]!.query.getAll("keys")).toEqual(
          view.rows.map((row) => row.id),
        );
        const rollup = workerReads.rollups[0]!.json as {
          rows: unknown[];
          truncated: boolean;
          totalRows: number;
        };
        expect(rollup.rows).toHaveLength(MAX_ANALYTICS_ROWS);
        expect(rollup.truncated).toBe(true);
        expect(rollup.totalRows).toBe(FLEET_KEYS);
        // Mode `jobs` mounts no runner analytics, whatever the driver counts.
        expect(overview.has("runners")).toBe(false);
        expect(reads(fleet, "/analytics/runners", start).all).toHaveLength(0);
      } finally {
        overview.unmount();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("a sub-minute range on the file driver", () => {
  it(
    'captions every section with reason "driver"',
    async () => {
      const start = file.exchanges.length;
      const overview = await (
        await harness()
      ).mountOverview(file.fetch, "?range=60s");
      try {
        for (const id of ["jobs", "runners", "workers"] as const) {
          const view = await overview.section(
            id,
            (one) => one.caption !== null && one.sparklines.length > 0,
          );
          expect(view.caption!.reason).toBe("driver");
          expect(view.caption!.text).toContain(
            "this backend cannot record that fineness at all",
          );
          expect(view.caption!.text).toContain("1-minute buckets");
        }
        const workersView = await overview.section(
          "workers",
          (one) => one.rows.length > 0,
        );
        expect(
          workersView.rows.find((row) => row.id === `${SERVICE}.emails`)
            ?.cells[2],
        ).toBe("3");
        const jobsRead = file.exchanges
          .slice(start)
          .find((exchange) => exchange.path === "/analytics/jobs")!;
        // The UI asked for the seconds the range wants; the driver said why not.
        expect(jobsRead.query.get("resolution")).toBe("1");
        expect(jobsRead.json).toMatchObject({
          range: { resolution: 60, clamped: true, reason: "driver" },
        });
      } finally {
        overview.unmount();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the Workers table's cumulative counts", () => {
  it(
    "shows each incarnation's Completed and Failed from the heartbeat",
    async () => {
      const { items } = await read<{
        items: {
          id: string;
          queue: string;
          completed?: number;
          failed?: number;
        }[];
      }>(live, "/workers");
      const emails = items.find((worker) => worker.queue === "emails")!;
      expect(emails.completed).toBe(5);
      expect(emails.failed).toBe(1);
      const { readWorkerRow } = await harness();
      const hasCounts = (one: { headers: string[] }) =>
        one.headers.includes("Completed");
      const view = await readWorkerRow(live.fetch, emails.id, hasCounts);
      const completed = view.headers.indexOf("Completed");
      expect(view.cells[completed]).toBe("5");
      expect(view.cells[view.headers.indexOf("Failed")]).toBe("1");
    },
    TEST_TIMEOUT_MS,
  );
});
