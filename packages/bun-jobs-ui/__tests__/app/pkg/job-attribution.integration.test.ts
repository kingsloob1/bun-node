import type { BunQueueWorker, JobsDriver } from "@kingsleyweb/bun-jobs";
import type { FetchLike } from "../../../app/api/client";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  MemoryDriver,
  SqlDriver,
} from "@kingsleyweb/bun-jobs";
// The schema's own list of the attribution stamp's columns, so the "table an
// older version made" below drops exactly what the schema adds and cannot
// drift from it. bun-jobs' `sql-attribution.test.ts` builds its unsynced
// table the same way: the current schema, minus these columns.
import { STAMP_COLUMNS } from "@kingsleyweb/bun-jobs/lib/drivers/sql/schema.ts";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * Job attribution end to end, against a REAL `createJobsApi` over real
 * `BunQueueWorker`s doing real jobs: the worker page's "Jobs whose last
 * attempt this key ran" section and the job screen's "Processed by" line.
 * Both were built against mocked HTTP; this is the proof they read the real
 * routes right — above all that a worker page lists only its own key's jobs,
 * which is the exact failure a user hit (the filter was ignored and every
 * job of the queue was listed).
 *
 * Every attributed deployment has two contexts sharing ONE driver instance —
 * services `api` and `mailer`, each with a worker named `send` on `emails`,
 * so two different stable keys on the same queue — and the same jobs:
 *
 * - `api.emails.send` completes two and buries one (it fails, with a single
 *   attempt), then is paused;
 * - `mailer.emails.send` then completes two, buries one, and holds one
 *   active until the suite ends;
 * - one job is delayed an hour, so no worker ever claims it.
 *
 * It runs on the memory driver, on SQLite with a fresh table, and on SQLite
 * with a table an older version made (no stamp columns) that `syncSchema`
 * brings up to date on connect. A fourth deployment keeps such a table
 * UNSYNCED, where attribution is off: the UI must read nothing it cannot
 * answer, and the API must refuse a worker filter rather than ignore it.
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

/** What the worker page's jobs section shows (`../workers/realApiJobs`' `WorkerJobsView`). */
interface WorkerJobsView {
  /** The ids of the job rows on screen, in order. */
  rows: string[];
  /** Whether the "No jobs" empty state is shown. */
  empty: boolean;
  /** Whether the section says this backend records no attribution. */
  unrecorded: boolean;
  /** Whether it is still loading. */
  loading: boolean;
  /** The range note, or `null` when no range applies. */
  range: string | null;
  /** The "no date range applies" note, or `null` when a range does. */
  noRange: string | null;
  /** An error alert's text, or `null`. */
  alert: string | null;
  /** The whole section's text. */
  text: string;
}

/** What the job screen's "Processed by" row shows (`../workers/realApiJobs`' `ProcessedByView`). */
interface ProcessedByView {
  /** Whether the summary has a "Processed by" row at all. */
  present: boolean;
  /** The row's whole text. */
  text: string;
  /** The key's text, or `null`. */
  key: string | null;
  /** The key link's `href`, or `null`. */
  href: string | null;
  /** The "No worker recorded" text, or `null`. */
  none: string | null;
}

/** What this file uses of `../workers/realApiJobs`. */
interface JobsHarnessModule {
  /** Renders the worker page of `key` on `queue`. */
  mountWorkerPage: (
    fetch: FetchLike,
    queue: string,
    key: string,
  ) => Promise<{
    view: () => WorkerJobsView | null;
    awaitView: (
      ready: (view: WorkerJobsView) => boolean,
      timeoutMs?: number,
    ) => Promise<WorkerJobsView>;
    settled: () => Promise<void>;
    tab: (name: string) => void;
    rowHref: (id: string) => string | null;
    unmount: () => void;
  }>;
  /** Renders job `id` of `queue` and reads its "Processed by" row. */
  readProcessedBy: (
    fetch: FetchLike,
    queue: string,
    id: string,
  ) => Promise<ProcessedByView>;
}

/** One request made through a deployment's fetch, with what the API answered. */
interface Exchange {
  /** The path under the API's base, without the query. */
  path: string;
  /** The query. */
  query: URLSearchParams;
  /** The status the API answered with. */
  status: number;
  /** The parsed answer, for a JSON body. */
  json: unknown;
}

/** A job as `GET /queues/:queue/jobs` returns it: the fields this file reads. */
interface JobItem {
  /** Its id. */
  id: string;
  /** Its state. */
  state: string;
  /** Who ran its last attempt. */
  processedBy: {
    id: string;
    key?: string;
    host?: string;
    pid?: number;
  } | null;
}

/** One deployment under test. */
interface Deployment {
  /** How it is named in the test titles. */
  label: string;
  /** The contexts sharing its one driver. */
  contexts: BunJobs[];
  /** The fetch the UI is given. */
  fetch: FetchLike;
  /** Every request made through `fetch`, oldest first. */
  exchanges: Exchange[];
  /** The workers, by service. */
  workers: Record<string, BunQueueWorker<JobData, string>>;
}

/** What a job asks its worker to do. */
interface JobData {
  /** Throw, so that with one attempt the job is buried. */
  fail?: boolean;
  /** Stay active until the suite releases it. */
  hold?: boolean;
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
const QUEUE = "emails";
/** The name both services give their worker on {@link QUEUE}. */
const WORKER_NAME = "send";
/** The two stable keys: one per service, on the same queue. */
const KEY = {
  api: `api.${QUEUE}.${WORKER_NAME}`,
  mailer: `mailer.${QUEUE}.${WORKER_NAME}`,
} as const;
/** The jobs each deployment holds, by who runs them. */
const IDS = {
  /** Finished by `api.emails.send`. */
  api: ["api-done-1", "api-done-2", "api-dead"],
  /** Finished by `mailer.emails.send`. */
  mailer: ["mailer-done-1", "mailer-done-2", "mailer-dead"],
  /** Held active by `mailer.emails.send`. */
  held: "mailer-held",
  /** Delayed an hour: never claimed. */
  delayed: "never-claimed",
} as const;
/** The query parameters only an attribution-aware API accepts. */
const ATTRIBUTION_PARAMS = [
  "workerKey",
  "workerId",
  "finishedFrom",
  "finishedTo",
] as const;
/** A day, in ms: the jobs section's default range. */
const DAY = 86_400_000;
/** Each scenario renders the whole app over real reads; more than `bun test`'s 5 s default. */
const TEST_TIMEOUT_MS = 30_000;

let tmp: string;
/** Releases every held job, so the workers can close. */
let releaseHeld: () => void = () => undefined;
const held = new Promise<void>((resolve) => {
  releaseHeld = resolve;
});
const deployments: Deployment[] = [];
let memory: Deployment;
let sqliteFresh: Deployment;
let sqliteSynced: Deployment;
let sqliteUnsynced: Deployment;
/** `capabilities.jobAttribution` of a driver over the old table before any sync, seen while building {@link sqliteSynced}. */
let attributionBeforeSync: boolean | undefined;

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

/** Mounts `jobs`' API and returns the recording fetch shim over it. */
function deploy(
  label: string,
  contexts: BunJobs[],
): Pick<Deployment, "label" | "contexts" | "fetch" | "exchanges"> {
  const api = createJobsApi({
    jobs: contexts[0]!,
    mode: "jobs",
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
  return { label, contexts, fetch, exchanges };
}

/** A direct request to the real API, not recorded as the UI's. */
async function request(
  deployment: Deployment,
  path: string,
): Promise<{ status: number; json: unknown }> {
  const response = await deployment.fetch(`${BASE}${path}`, { method: "GET" });
  deployment.exchanges.pop();
  return { status: response.status, json: await response.json() };
}

/** A direct read that must succeed. */
async function read<T>(deployment: Deployment, path: string): Promise<T> {
  const { status, json } = await request(deployment, path);
  expect(`${path} ${status}`).toBe(`${path} 200`);
  return json as T;
}

/** Starts `jobs`' worker named {@link WORKER_NAME} on {@link QUEUE}. */
function startWorker(jobs: BunJobs): BunQueueWorker<JobData, string> {
  const worker = jobs.worker<JobData, string>(
    QUEUE,
    async (job) => {
      if (job.data?.hold) {
        await held;
      }
      if (job.data?.fail) {
        throw new Error("asked to fail");
      }
      return "ok";
    },
    {
      name: WORKER_NAME,
      concurrency: 1,
      reportInterval: 500,
      pollInterval: 10,
      waitToExit: false,
      logger: noopLogger,
    },
  );
  void worker.run();
  return worker;
}

/** Adds jobs `ids` to {@link QUEUE}, the last failing when `bury`, and waits until each is settled. */
async function work(jobs: BunJobs, ids: readonly string[], bury: boolean) {
  const queue = jobs.queue<JobData>(QUEUE);
  for (const [index, id] of ids.entries()) {
    await queue.add(
      "notify",
      { fail: bury && index === ids.length - 1 },
      { jobId: id, attempts: 1 },
    );
  }
  for (const id of ids) {
    await until(
      async () => {
        const state = (await queue.getJob(id))?.state;
        return state === "completed" || state === "dead";
      },
      () => `${id} never settled`,
    );
  }
}

/**
 * Builds a deployment over `driver`: the two services' workers, their jobs,
 * the held one and the delayed one (see the file's comment).
 */
async function populate(
  label: string,
  driver: JobsDriver,
  namespace: string,
): Promise<Deployment> {
  const api = new BunJobs({
    namespace,
    service: "api",
    driver,
    logger: noopLogger,
  });
  const mailer = new BunJobs({
    namespace,
    service: "mailer",
    driver,
    logger: noopLogger,
  });
  const deployment: Deployment = {
    ...deploy(label, [api, mailer]),
    workers: {},
  };
  deployments.push(deployment);

  const apiWorker = startWorker(api);
  deployment.workers.api = apiWorker;
  expect(apiWorker.key).toBe(KEY.api);
  await work(api, IDS.api, true);
  // Paused, not closed: its key stays live, and it claims nothing more.
  await apiWorker.pause();

  const mailerWorker = startWorker(mailer);
  deployment.workers.mailer = mailerWorker;
  expect(mailerWorker.key).toBe(KEY.mailer);
  await work(mailer, IDS.mailer, true);
  await mailer.queue<JobData>(QUEUE).add(
    "notify",
    { hold: true },
    {
      jobId: IDS.held,
      attempts: 1,
    },
  );
  await until(
    async () =>
      (await mailer.queue(QUEUE).getJob(IDS.held))?.state === "active",
    () => `${IDS.held} never went active`,
  );
  await api
    .queue<JobData>(QUEUE)
    .add("notify", {}, { jobId: IDS.delayed, delay: 3_600_000 });
  return deployment;
}

/** Creates the current schema at `file`, then drops the stamp's columns: the table an older version made. */
async function oldTable(file: string): Promise<void> {
  const creator = new SqlDriver({ url: `sqlite://${file}` });
  await creator.connect();
  await creator.close();
  const db = new Database(file);
  try {
    for (const column of STAMP_COLUMNS) {
      db.run(`ALTER TABLE bun_jobs_jobs DROP COLUMN ${column}`);
    }
    const left = (
      db.query("PRAGMA table_info(bun_jobs_jobs)").all() as { name: string }[]
    ).map((column) => column.name);
    expect(left.filter((name) => name.startsWith("processed_by"))).toEqual([]);
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bun-jobs-ui-attribution-"));

  memory = await populate(
    "memory",
    new MemoryDriver(),
    "ui-attribution-memory",
  );
  sqliteFresh = await populate(
    "SQLite",
    new SqlDriver({ url: `sqlite://${join(tmp, "fresh.db")}` }),
    "ui-attribution-sqlite",
  );

  // The same old table, first as a deployment that never syncs would see it,
  // then synced on connect.
  const synced = join(tmp, "synced.db");
  await oldTable(synced);
  const before = new SqlDriver({ url: `sqlite://${synced}` });
  await before.connect();
  attributionBeforeSync = before.capabilities.jobAttribution;
  await before.close();
  sqliteSynced = await populate(
    "SQLite, an old table synced on connect",
    new SqlDriver({ url: `sqlite://${synced}`, syncSchema: true }),
    "ui-attribution-synced",
  );

  // Never synced: attribution is off. One worker still does real work.
  const unsyncedFile = join(tmp, "unsynced.db");
  await oldTable(unsyncedFile);
  const unsyncedJobs = new BunJobs({
    namespace: "ui-attribution-unsynced",
    service: "api",
    driver: new SqlDriver({ url: `sqlite://${unsyncedFile}` }),
    logger: noopLogger,
  });
  sqliteUnsynced = {
    ...deploy("SQLite, an old table never synced", [unsyncedJobs]),
    workers: {},
  };
  deployments.push(sqliteUnsynced);
  sqliteUnsynced.workers.api = startWorker(unsyncedJobs);
  await work(unsyncedJobs, IDS.api, true);
}, 90_000);

afterAll(async () => {
  releaseHeld();
  for (const deployment of deployments) {
    for (const worker of Object.values(deployment.workers)) {
      await worker.close({ force: true }).catch(() => undefined);
    }
    // The contexts share one driver, which the first to close closes.
    for (const jobs of deployment.contexts) {
      await jobs.close().catch(() => undefined);
    }
  }
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** Loads the DOM harness. */
function harness(): Promise<JobsHarnessModule> {
  return load<JobsHarnessModule>(["..", "workers", "realApiJobs"].join("/"));
}

/** The UI's reads of the queue's job list since `from`. */
function jobReads(deployment: Deployment, from: number): Exchange[] {
  return deployment.exchanges
    .slice(from)
    .filter((exchange) => exchange.path === `/queues/${QUEUE}/jobs`);
}

/** Whether a request carried any attribution parameter. */
function carriesAttribution(exchange: Exchange): boolean {
  return ATTRIBUTION_PARAMS.some((param) => exchange.query.has(param));
}

/** Sorted, for comparing sets of ids. */
function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

/**
 * Opens the page of `key` and checks the default view: the last 24 hours of
 * that key's finished jobs, and nothing else — against the real request, the
 * real response and the rows on screen.
 */
async function checkDefaultView(
  deployment: Deployment,
  key: string,
  own: readonly string[],
) {
  const start = deployment.exchanges.length;
  const before = Date.now();
  const ui = await (
    await harness()
  ).mountWorkerPage(deployment.fetch, QUEUE, key);
  try {
    const view = await ui.awaitView(
      (one) => one.rows.length > 0 || one.empty || one.alert !== null,
    );
    const after = Date.now();
    expect(view.alert).toBeNull();
    expect(view.range).toContain("Last 24 hours");

    const reads = jobReads(deployment, start);
    expect(reads.length).toBeGreaterThan(0);
    const first = reads[0]!;
    // The real request: this key, the last day of finishedOn, every state.
    expect(first.query.getAll("workerKey")).toEqual([key]);
    expect(first.query.has("state")).toBe(false);
    expect(first.query.has("finishedTo")).toBe(false);
    expect(first.query.has("workerId")).toBe(false);
    const from = Number(first.query.get("finishedFrom"));
    expect(from).toBeGreaterThanOrEqual(before - DAY);
    expect(from).toBeLessThanOrEqual(after - DAY);

    // The real response: the key's own finished jobs, every one of them run
    // by it — not the other key's, not the held one, not the delayed one.
    expect(first.status).toBe(200);
    const items = (first.json as { items: JobItem[] }).items;
    expect(sorted(items.map((job) => job.id))).toEqual(sorted(own));
    for (const job of items) {
      expect(job.processedBy?.key).toBe(key);
      expect(["completed", "dead"]).toContain(job.state);
    }
    // The rows on screen are exactly those, and lead to the job screen.
    expect(sorted(view.rows)).toEqual(sorted(own));
    for (const id of own) {
      expect(ui.rowHref(id)).toBe(`/jobs/queues/${QUEUE}/jobs/${id}`);
    }

    // (3) Never a count.
    await ui.settled();
    for (const exchange of jobReads(deployment, start)) {
      expect(exchange.query.has("total")).toBe(false);
    }
    for (const exchange of deployment.exchanges.slice(start)) {
      expect(exchange.query.get("total")).not.toBe("true");
    }
  } finally {
    ui.unmount();
  }
}

/**
 * Opens the page of `key`, switches to Active and checks that the range is
 * dropped and the active jobs the key holds are listed.
 */
async function checkActiveTab(
  deployment: Deployment,
  key: string,
  active: readonly string[],
) {
  const start = deployment.exchanges.length;
  const ui = await (
    await harness()
  ).mountWorkerPage(deployment.fetch, QUEUE, key);
  try {
    await ui.awaitView((one) => one.rows.length > 0 || one.empty);
    const beforeTab = deployment.exchanges.length;
    ui.tab("Active");
    const view = await ui.awaitView(
      (one) =>
        one.noRange !== null &&
        jobReads(deployment, beforeTab).some(
          (read) => read.query.get("state") === "active",
        ) &&
        (active.length === 0
          ? one.empty
          : sorted(one.rows).join() === sorted(active).join()),
    );
    const read = jobReads(deployment, beforeTab).find(
      (one) => one.query.get("state") === "active",
    )!;
    // The real request: this key, the Active state, and no range at all.
    expect(read.query.getAll("state")).toEqual(["active"]);
    expect(read.query.getAll("workerKey")).toEqual([key]);
    expect(read.query.has("finishedFrom")).toBe(false);
    expect(read.query.has("finishedTo")).toBe(false);
    expect(read.query.has("total")).toBe(false);
    expect(read.status).toBe(200);
    const items = (read.json as { items: JobItem[] }).items;
    expect(items.map((job) => job.id)).toEqual([...active]);
    for (const job of items) {
      expect(job.state).toBe("active");
      expect(job.processedBy?.key).toBe(key);
    }
    expect(sorted(view.rows)).toEqual(sorted(active));
    expect(view.range).toBeNull();
    expect(view.noRange).toContain("Active jobs have not finished");
    for (const exchange of deployment.exchanges.slice(start)) {
      expect(exchange.query.get("total")).not.toBe("true");
    }
  } finally {
    ui.unmount();
  }
}

/** The attributed deployments, built in `beforeAll`; their titles are known ahead. */
const ATTRIBUTED: { title: string; pick: () => Deployment }[] = [
  { title: "memory", pick: () => memory },
  { title: "SQLite", pick: () => sqliteFresh },
  {
    title: "SQLite, an old table synced on connect",
    pick: () => sqliteSynced,
  },
];

for (const { title, pick } of ATTRIBUTED) {
  describe(`job attribution against a real API: ${title}`, () => {
    it(
      "reports attribution on in /meta, and the queue really holds both keys' jobs",
      async () => {
        const deployment = pick();
        const meta = await read<{ features: { jobAttribution: boolean } }>(
          deployment,
          "/meta",
        );
        expect(meta.features.jobAttribution).toBe(true);

        // The control that makes the filter assertions below mean something:
        // unfiltered, the same range lists BOTH keys' finished jobs.
        const all = await read<{ items: JobItem[] }>(
          deployment,
          `/queues/${QUEUE}/jobs?finishedFrom=${Date.now() - DAY}&limit=100`,
        );
        expect(sorted(all.items.map((job) => job.id))).toEqual(
          sorted([...IDS.api, ...IDS.mailer]),
        );
        // And every state holds the held job and the delayed one too.
        const everything = await read<{ items: JobItem[] }>(
          deployment,
          `/queues/${QUEUE}/jobs?limit=100`,
        );
        const states = Object.fromEntries(
          everything.items.map((job) => [job.id, job.state]),
        );
        expect(states).toMatchObject({
          "api-dead": "dead",
          "mailer-dead": "dead",
          [IDS.held]: "active",
          [IDS.delayed]: "delayed",
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "lists only api.emails.send's finished jobs on its page",
      async () => {
        await checkDefaultView(pick(), KEY.api, IDS.api);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "lists only mailer.emails.send's finished jobs on its page",
      async () => {
        await checkDefaultView(pick(), KEY.mailer, IDS.mailer);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "drops the range on the Active tab, and lists the job the key holds",
      async () => {
        await checkActiveTab(pick(), KEY.mailer, [IDS.held]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "lists no active job for a key that holds none",
      async () => {
        await checkActiveTab(pick(), KEY.api, []);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "names the real worker in the job screen's Processed by line",
      async () => {
        const deployment = pick();
        const id = IDS.api[0];
        const job = await read<JobItem>(
          deployment,
          `/queues/${QUEUE}/jobs/${id}`,
        );
        const worker = deployment.workers.api!;
        // The real stamp: this incarnation, its key, and where it ran.
        expect(job.processedBy).toEqual({
          id: worker.id,
          key: KEY.api,
          host: hostname(),
          pid: process.pid,
        });

        const view = await (
          await harness()
        ).readProcessedBy(deployment.fetch, QUEUE, id);
        expect(view.present).toBe(true);
        expect(view.none).toBeNull();
        expect(view.key).toBe(KEY.api);
        expect(view.href).toBe(`/jobs/workers/${QUEUE}/${KEY.api}`);
        expect(view.text).toContain(`incarnation ${worker.id}`);
        expect(view.text).toContain(`${hostname()}, pid ${process.pid}`);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "says no worker is recorded for a job never claimed",
      async () => {
        const deployment = pick();
        const job = await read<JobItem>(
          deployment,
          `/queues/${QUEUE}/jobs/${IDS.delayed}`,
        );
        expect(job.state).toBe("delayed");
        expect(job.processedBy).toBeNull();

        const view = await (
          await harness()
        ).readProcessedBy(deployment.fetch, QUEUE, IDS.delayed);
        expect(view.present).toBe(true);
        expect(view.key).toBeNull();
        expect(view.none).toBe("No worker recorded");
        expect(view.text).toContain("never claimed");
      },
      TEST_TIMEOUT_MS,
    );
  });
}

describe("an old SQLite table, synced on connect", () => {
  it("had attribution off before the sync", () => {
    // The same file the synced deployment then opened with `syncSchema: true`,
    // whose scenarios above prove the sync turned attribution on.
    expect(attributionBeforeSync).toBe(false);
  });
});

describe("attribution off: an old SQLite table never synced", () => {
  it(
    "reports attribution off in /meta",
    async () => {
      const meta = await read<{
        features: { jobAttribution: boolean };
        driver: { capabilities: { jobAttribution: boolean } };
      }>(sqliteUnsynced, "/meta");
      expect(meta.features.jobAttribution).toBe(false);
      expect(meta.driver.capabilities.jobAttribution).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reads nothing on the worker page and sends no attribution filter",
    async () => {
      const deployment = sqliteUnsynced;
      const start = deployment.exchanges.length;
      const ui = await (
        await harness()
      ).mountWorkerPage(deployment.fetch, QUEUE, KEY.api);
      try {
        const view = await ui.awaitView((one) => one.unrecorded);
        expect(view.text).toContain("Not recorded by this backend");
        expect(view.rows).toEqual([]);
        // Let the rest of the page settle, then look at every request it made.
        await ui.settled();
        const made = deployment.exchanges.slice(start);
        expect(made.length).toBeGreaterThan(0);
        expect(made.filter(carriesAttribution)).toEqual([]);
        expect(jobReads(deployment, start)).toEqual([]);
      } finally {
        ui.unmount();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "shows no Processed by line on the job screen",
    async () => {
      const deployment = sqliteUnsynced;
      const start = deployment.exchanges.length;
      const id = IDS.api[0];
      const job = await read<JobItem>(
        deployment,
        `/queues/${QUEUE}/jobs/${id}`,
      );
      expect(job.state).toBe("completed");
      const view = await (
        await harness()
      ).readProcessedBy(deployment.fetch, QUEUE, id);
      expect(view.present).toBe(false);
      expect(
        deployment.exchanges.slice(start).filter(carriesAttribution),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a worker filter with a pointer to syncSchema(), rather than ignoring it",
    async () => {
      for (const filter of [`workerKey=${KEY.api}`, "workerId=anything"]) {
        const answer = await request(
          sqliteUnsynced,
          `/queues/${QUEUE}/jobs?${filter}`,
        );
        // A 200 here would be a page that ignores the filter (every job,
        // whatever key it names — the bug a user hit) or one that reads as
        // "this worker ran nothing". Refused instead, as a 400 whose detail
        // tells the operator what to run (a 5xx never carries a detail).
        expect(`${filter} ${answer.status}`).toBe(`${filter} 400`);
        expect(answer.json).toMatchObject({
          code: "INVALID_ARGUMENT",
          context: { features: { jobAttribution: false } },
        });
        expect((answer.json as { detail: string }).detail).toContain(
          "run `syncSchema()`",
        );
      }
      // A range needs no stamp, so it is still answered.
      const ranged = await request(
        sqliteUnsynced,
        `/queues/${QUEUE}/jobs?finishedFrom=${Date.now() - DAY}`,
      );
      expect(ranged.status).toBe(200);
      expect(
        sorted(
          (ranged.json as { items: JobItem[] }).items.map((job) => job.id),
        ),
      ).toEqual(sorted(IDS.api));
    },
    TEST_TIMEOUT_MS,
  );
});
