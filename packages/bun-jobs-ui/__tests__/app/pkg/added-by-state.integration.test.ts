import type {
  BunQueueWorker,
  JobsApiAuthorize,
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
  MAX_ADDED_BY_STATE_SPAN_MS,
  MemoryDriver,
  MIN_ANALYTICS_SPAN_MS,
  SqlDriver,
} from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * "Added in range, by state" and the job list's `sort=createdAt`, against a
 * REAL `createJobsApi` over real `BunQueueWorker`s doing real jobs. The UI
 * for both was built against mocked HTTP; this is the proof it reads the real
 * routes right: `GET /overview/added` behind the Overview's "Over the range"
 * tile, and `sort=createdAt&order=desc` behind a queue's one-state tab.
 *
 * Every deployment holds the same jobs, so each state has a known number:
 *
 * - `orders` (a real worker): three completed, one dead (it throws, with a
 *   single attempt), one held active until the suite ends, and one retrying —
 *   it throws with attempts to spare and an hour's backoff, so it rests in
 *   the `failed` state, which the UI calls "Retrying";
 * - `backlog` (no worker): two waiting, and three delayed whose creation
 *   order differs from their `runAt` order both ways, so a page that ignored
 *   `sort` would show them in another order;
 * - `secret` (no worker): four waiting, which a restricted API hides.
 *
 * Deployments: memory and SQLite (a temp-dir file), where
 * `features.addedByState` is true, each also mounted a second time with an
 * `authorize` that hides `secret`; and the file driver, where it is false.
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

/** One labelled group of the tile (`../analytics/realApiAdded`'s `StatGroupView`). */
interface StatGroupView {
  /** The group's heading, or `null` when it has none. */
  heading: string | null;
  /** Each row's label and value, in order. */
  rows: [label: string, value: string][];
}

/** What the "Over the range" tile shows (`RangeStatView`). */
interface RangeStatView {
  /** The tile's whole text. */
  text: string;
  /** The analytics series' group, or `null` before it answered. */
  finished: StatGroupView | null;
  /** The added-by-state group, or `null` when absent. */
  added: StatGroupView | null;
  /** Whether the added group is still loading. */
  addedLoading: boolean;
}

/** What a queue's jobs table shows (`JobsTableView`). */
interface JobsTableView {
  /** The job ids of the rows on screen, in order. */
  rows: string[];
  /** The "Count total" toggle's hint, or `null`. */
  totalHint: string | null;
}

/** What this file uses of `../analytics/realApiAdded`. */
interface AddedHarnessModule {
  /** Renders the Overview at `search` over `fetch`. */
  mountOverview: (
    fetch: FetchLike,
    search?: string,
  ) => Promise<{ unmount: () => void }>;
  /** Resolves with the tile once `ready` holds for it. */
  awaitRangeStat: (
    ready: (view: RangeStatView) => boolean,
    timeoutMs?: number,
  ) => Promise<RangeStatView>;
  /** Renders a queue screen at `search`. */
  mountJobsTable: (
    fetch: FetchLike,
    queue: string,
    search: string,
  ) => Promise<{
    awaitTable: (
      ready: (view: JobsTableView) => boolean,
      timeoutMs?: number,
    ) => Promise<JobsTableView>;
    toggleTotal: () => void;
    unmount: () => void;
  }>;
  /** The added-by-state group's poll, in ms. */
  ADDED_BY_STATE_POLL_MS: number;
  /** The Overview's poll, in ms. */
  POLL_INTERVAL_MS: number;
}

/** One request made through a deployment's fetch, with what the API answered. */
interface Exchange {
  /** When it was made, epoch ms. */
  at: number;
  /** The path under the API's base, without the query. */
  path: string;
  /** The query. */
  query: URLSearchParams;
  /** The status the API answered with. */
  status: number;
  /** The parsed answer, for a JSON body. */
  json: unknown;
}

/** One mounted API over a deployment's jobs. */
interface Mount {
  /** The fetch the UI is given. */
  fetch: FetchLike;
  /** Every request made through `fetch`, oldest first. */
  exchanges: Exchange[];
}

/** One deployment under test. */
interface Deployment {
  /** How it is named in the test titles. */
  label: string;
  /** Its jobs context. */
  jobs: BunJobs;
  /** Its worker on `orders`. */
  worker: BunQueueWorker<JobData, string>;
  /** Its API with every queue visible. */
  all: Mount;
  /** Its API with `secret` hidden by `authorize`. */
  restricted: Mount;
}

/** What a job asks its worker to do. */
interface JobData {
  /** Throw. */
  fail?: boolean;
  /** Stay active until the suite releases it. */
  hold?: boolean;
}

/** `GET /overview/added` (and the per-queue route). */
interface AddedBody {
  /** Start of the range, inclusive. */
  from: number;
  /** End of the range, exclusive. */
  to: number;
  /** When it was counted. */
  at: number;
  /** Jobs per state now. */
  counts: Record<JobState, number>;
  /** Their sum. */
  total: number;
  /** Queues summed. */
  queues: number;
}

/** A job state, as the API names it. */
type JobState =
  | "waiting"
  | "delayed"
  | "active"
  | "completed"
  | "failed"
  | "dead"
  | "waiting-children";

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
/** The queue the hiding `authorize` refuses. */
const HIDDEN = "secret";
/** The ids of the jobs `backlog` holds delayed, in the order they are CREATED, with their delays. */
const DELAYED = [
  { id: "delayed-a", delay: 2 * 3_600_000 },
  { id: "delayed-b", delay: 1 * 3_600_000 },
  { id: "delayed-c", delay: 3 * 3_600_000 },
] as const;
/** Newest created first: what `sort=createdAt&order=desc` must answer. */
const CREATED_DESC = ["delayed-c", "delayed-b", "delayed-a"];
/** Latest `runAt` first: the Delayed tab's natural order, descending. */
const RUN_AT_DESC = ["delayed-c", "delayed-a", "delayed-b"];
/** Every state's seeded count, over every queue. */
const TRUTH: Record<JobState, number> = {
  waiting: 2 + 4,
  delayed: 3,
  active: 1,
  completed: 3,
  failed: 1,
  dead: 1,
  "waiting-children": 0,
};
/** The same without `secret`'s four waiting jobs. */
const VISIBLE_TRUTH: Record<JobState, number> = { ...TRUTH, waiting: 2 };
/** The tile's rows, in `JOB_STATES` order, with the label each state reads as. */
const LABELS: [JobState, string][] = [
  ["waiting", "Waiting"],
  ["delayed", "Delayed"],
  ["active", "Active"],
  ["completed", "Completed"],
  ["failed", "Retrying"],
  ["dead", "Dead"],
  ["waiting-children", "Waiting children"],
];
const HOUR = 3_600_000;
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
let sqlite: Deployment;
let file: Deployment;

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

/** Mounts `jobs`' API (hiding {@link HIDDEN} when `restricted`) and returns the recording fetch shim over it. */
function mount(jobs: BunJobs, restricted: boolean): Mount {
  const authorize: JobsApiAuthorize = (_req, context) =>
    !restricted || context.queue !== HIDDEN;
  const api = createJobsApi({
    jobs,
    mode: "jobs",
    basePath: BASE,
    authorize,
    ...(restricted ? { listQueues: "authorized" as const } : {}),
    logger: noopLogger,
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  const exchanges: Exchange[] = [];
  // The app's AbortSignal is happy-dom's, which Bun's Request refuses.
  const fetch: FetchLike = async (input, { signal: _signal, ...init }) =>
    withBunGlobals(async () => {
      const at = Date.now();
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
        at,
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
  return { fetch, exchanges };
}

/** A direct request to the real API, not recorded as the UI's. */
async function request(
  target: Mount,
  path: string,
): Promise<{ status: number; json: unknown }> {
  const response = await target.fetch(`${BASE}${path}`, { method: "GET" });
  target.exchanges.pop();
  const text = await response.text();
  return {
    status: response.status,
    json: text === "" ? undefined : JSON.parse(text),
  };
}

/** A direct read that must succeed. */
async function read<T>(target: Mount, path: string): Promise<T> {
  const { status, json } = await request(target, path);
  expect(`${path} ${status}`).toBe(`${path} 200`);
  return json as T;
}

/** Waits until job `id` of `queue` is in `state`. */
async function settle(
  jobs: BunJobs,
  queue: string,
  id: string,
  state: JobState,
) {
  await until(
    async () => (await jobs.queue(queue).getJob(id))?.state === state,
    () => `${queue}/${id} never reached ${state}`,
  );
}

/** Builds a deployment over `driver` holding the jobs the file's comment lists. */
async function populate(
  label: string,
  driver: JobsDriver,
  namespace: string,
): Promise<Deployment> {
  const jobs = new BunJobs({
    namespace,
    service: "api",
    driver,
    logger: noopLogger,
  });
  const worker = jobs.worker<JobData, string>(
    "orders",
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
      concurrency: 2,
      reportInterval: 500,
      pollInterval: 10,
      waitToExit: false,
      logger: noopLogger,
    },
  );
  const deployment: Deployment = {
    label,
    jobs,
    worker,
    all: mount(jobs, false),
    restricted: mount(jobs, true),
  };
  deployments.push(deployment);
  void worker.run();

  const orders = jobs.queue<JobData>("orders");
  for (const id of ["done-1", "done-2", "done-3"]) {
    await orders.add("order", {}, { jobId: id, attempts: 1 });
  }
  await orders.add("order", { fail: true }, { jobId: "buried", attempts: 1 });
  await orders.add(
    "order",
    { fail: true },
    {
      jobId: "retrying",
      attempts: 3,
      backoff: { type: "fixed", delay: HOUR },
    },
  );
  for (const id of ["done-1", "done-2", "done-3"]) {
    await settle(jobs, "orders", id, "completed");
  }
  await settle(jobs, "orders", "buried", "dead");
  await settle(jobs, "orders", "retrying", "failed");
  await orders.add("order", { hold: true }, { jobId: "held", attempts: 1 });
  await settle(jobs, "orders", "held", "active");

  const backlog = jobs.queue<JobData>("backlog");
  for (const id of ["waiting-1", "waiting-2"]) {
    await backlog.add("task", {}, { jobId: id });
  }
  for (const { id, delay } of DELAYED) {
    await backlog.add("task", {}, { jobId: id, delay });
    // A distinct `createdAt` each, so creation order is not left to the tie-break.
    const created = Date.now();
    await until(
      () => Date.now() > created,
      () => "the clock never moved",
    );
  }
  const secret = jobs.queue<JobData>(HIDDEN);
  for (let index = 1; index <= 4; index++) {
    await secret.add("task", {}, { jobId: `secret-${index}` });
  }
  return deployment;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bun-jobs-ui-added-"));
  memory = await populate("memory", new MemoryDriver(), "ui-added-memory");
  sqlite = await populate(
    "SQLite",
    new SqlDriver({ url: `sqlite://${join(tmp, "added.db")}` }),
    "ui-added-sqlite",
  );
  file = await populate(
    "file",
    new FileDriver({ root: join(tmp, "file") }),
    "ui-added-file",
  );
}, 90_000);

afterAll(async () => {
  releaseHeld();
  for (const deployment of deployments) {
    await deployment.worker.close({ force: true }).catch(() => undefined);
    await deployment.jobs.close().catch(() => undefined);
  }
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** Loads the DOM harness. */
function harness(): Promise<AddedHarnessModule> {
  return load<AddedHarnessModule>(
    ["..", "analytics", "realApiAdded"].join("/"),
  );
}

/** The UI's requests to `path` since `from`. */
function reads(target: Mount, path: string, from: number): Exchange[] {
  return target.exchanges
    .slice(from)
    .filter((exchange) => exchange.path === path);
}

/** `counts` as the tile's rows: every state's label and number, then the total. */
function asRows(counts: Record<JobState, number>): [string, string][] {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return [
    ...LABELS.map(
      ([state, label]) => [label, String(counts[state])] as [string, string],
    ),
    ["Total", String(total)],
  ];
}

/** The tile once both groups have their figures. */
function bothGroups(view: RangeStatView): boolean {
  return (
    view.finished !== null &&
    view.added !== null &&
    !view.addedLoading &&
    view.added.rows.length > 0
  );
}

/**
 * Opens the Overview over `target` and checks the tile's added group against
 * the real `/overview/added` answer and against `truth`.
 */
async function checkTile(
  target: Mount,
  truth: Record<JobState, number>,
  queues: number,
) {
  const start = target.exchanges.length;
  const before = Date.now();
  const h = await harness();
  const overview = await h.mountOverview(target.fetch);
  try {
    const tile = await h.awaitRangeStat(bothGroups);
    const after = Date.now();

    // The real request: the tile's range (the last hour), as from/to only.
    const [added, ...more] = reads(target, "/overview/added", start);
    expect(more).toEqual([]);
    expect([...added!.query.keys()]).toEqual(["from", "to"]);
    const from = Number(added!.query.get("from"));
    const to = Number(added!.query.get("to"));
    expect(to - from).toBe(HOUR);
    expect(to).toBeGreaterThanOrEqual(before);
    expect(to).toBeLessThanOrEqual(after);

    // The real answer: that range, the seeded truth, the visible queues.
    expect(added!.status).toBe(200);
    const body = added!.json as AddedBody;
    expect(body.from).toBe(from);
    expect(body.to).toBe(to);
    expect(body.counts).toEqual(truth);
    expect(body.queues).toBe(queues);

    // On screen: the answer's numbers, which are the truth's.
    expect(tile.added!.heading).toBe(
      "Added in range, where they are now (still stored)",
    );
    expect(tile.added!.rows).toEqual(asRows(body.counts));
    expect(tile.added!.rows).toEqual(asRows(truth));
    expect(tile.added!.rows.at(-1)).toEqual(["Total", String(body.total)]);
    // Two groups, never merged: the analytics series' by finish time.
    expect(tile.finished!.heading).toBe("Finished in range");
    expect(tile.finished!.rows.map(([label]) => label)).toEqual([
      "Completed",
      "Failed attempts",
    ]);
    expect(tile.added!.rows.map(([label]) => label)).not.toContain("Failed");
  } finally {
    overview.unmount();
  }
}

/** The flag-true deployments, built in `beforeAll`; their titles are known ahead. */
const SERVED: { title: string; pick: () => Deployment }[] = [
  { title: "memory", pick: () => memory },
  { title: "SQLite", pick: () => sqlite },
];

for (const { title, pick } of SERVED) {
  describe(`added by state against a real API: ${title}`, () => {
    it(
      "reports the flag on in /meta, and the per-queue route counts each queue's truth",
      async () => {
        const { all } = pick();
        const meta = await read<{ features: { addedByState: boolean } }>(
          all,
          "/meta",
        );
        expect(meta.features.addedByState).toBe(true);
        const orders = await read<AddedBody>(
          all,
          "/queues/orders/counts/added",
        );
        expect(orders.counts).toEqual({
          ...TRUTH,
          waiting: 0,
          delayed: 0,
        });
        expect(orders.queues).toBe(1);
        const backlog = await read<AddedBody>(
          all,
          "/queues/backlog/counts/added",
        );
        expect(backlog.counts).toMatchObject({ waiting: 2, delayed: 3 });
        expect(backlog.total).toBe(5);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "renders the added group from the real /overview/added, beside the finished one",
      async () => {
        await checkTile(pick().all, TRUTH, 3);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "accepts exactly a day and exactly a second, and refuses a day and a millisecond with context",
      async () => {
        const { all } = pick();
        const to = Date.now();
        for (const span of [
          MAX_ADDED_BY_STATE_SPAN_MS,
          MIN_ANALYTICS_SPAN_MS,
        ]) {
          const { status } = await request(
            all,
            `/overview/added?from=${to - span}&to=${to}`,
          );
          expect(`${span} ${status}`).toBe(`${span} 200`);
        }
        const over = await request(
          all,
          `/overview/added?from=${to - MAX_ADDED_BY_STATE_SPAN_MS - 1}&to=${to}`,
        );
        expect(over.status).toBe(400);
        expect(over.json).toMatchObject({
          code: "INVALID_ARGUMENT",
          context: { maxSpanMs: MAX_ADDED_BY_STATE_SPAN_MS },
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "sends the tile's range as from/to, a day at most, and never a longer span",
      async () => {
        const { all } = pick();
        const h = await harness();
        const now = Date.now();
        // The widest range the UI can hold (the analytics' own limit is the
        // same day) — as the preset, and as a custom range of exactly a day —
        // and one a URL asks over two days, which the UI refuses for its
        // default hour rather than send.
        const cases = [
          {
            search: "?range=86400s",
            span: MAX_ADDED_BY_STATE_SPAN_MS,
            to: null,
          },
          {
            search: `?range=${now - MAX_ADDED_BY_STATE_SPAN_MS}-${now}`,
            span: MAX_ADDED_BY_STATE_SPAN_MS,
            to: now,
          },
          {
            search: `?range=${now - 2 * 86_400_000}-${now}`,
            span: HOUR,
            to: null,
          },
        ];
        for (const { search, span, to } of cases) {
          const start = all.exchanges.length;
          const before = Date.now();
          const overview = await h.mountOverview(all.fetch, search);
          try {
            const tile = await h.awaitRangeStat(
              (view) =>
                view.added !== null &&
                !view.addedLoading &&
                view.added.rows.length > 0,
            );
            expect(tile.added!.heading).toBe(
              "Added in range, where they are now (still stored)",
            );
            const sent = reads(all, "/overview/added", start);
            expect(sent.length).toBeGreaterThan(0);
            for (const exchange of sent) {
              expect([...exchange.query.keys()]).toEqual(["from", "to"]);
              const from = Number(exchange.query.get("from"));
              const sentTo = Number(exchange.query.get("to"));
              expect(`${search} ${sentTo - from}`).toBe(`${search} ${span}`);
              if (to === null) {
                expect(sentTo).toBeGreaterThanOrEqual(before);
              } else {
                expect(sentTo).toBe(to);
              }
              expect(exchange.status).toBe(200);
              expect((exchange.json as AddedBody).from).toBe(from);
              expect((exchange.json as AddedBody).to).toBe(sentTo);
            }
            // Every job was added in the last hour, so each range holds all.
            expect(tile.added!.rows).toEqual(asRows(TRUTH));
          } finally {
            overview.unmount();
          }
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "sorts a Delayed tab newest-created first, not in runAt order, and keeps the natural order while counting",
      async () => {
        const { all } = pick();
        // The control that makes the order assertions mean something: the
        // tab's natural order, both ways, is not the creation order.
        const natural = await read<{ items: { id: string }[] }>(
          all,
          "/queues/backlog/jobs?state=delayed&order=desc",
        );
        expect(natural.items.map((job) => job.id)).toEqual(RUN_AT_DESC);
        const ascending = await read<{ items: { id: string }[] }>(
          all,
          "/queues/backlog/jobs?state=delayed&order=asc",
        );
        expect(ascending.items.map((job) => job.id)).toEqual(
          [...RUN_AT_DESC].reverse(),
        );

        const start = all.exchanges.length;
        const h = await harness();
        const ui = await h.mountJobsTable(
          all.fetch,
          "backlog",
          "?state=delayed",
        );
        try {
          const sorted = await ui.awaitTable((view) => view.rows.length === 3);
          const jobReads = reads(all, "/queues/backlog/jobs", start);
          expect(jobReads.length).toBeGreaterThan(0);
          for (const exchange of jobReads) {
            expect(exchange.query.getAll("state")).toEqual(["delayed"]);
            expect(exchange.query.get("sort")).toBe("createdAt");
            expect(exchange.query.get("order")).toBe("desc");
            expect(exchange.status).toBe(200);
            expect(
              (exchange.json as { items: { id: string }[] }).items.map(
                (job) => job.id,
              ),
            ).toEqual(CREATED_DESC);
          }
          expect(sorted.rows).toEqual(CREATED_DESC);
          expect(sorted.totalHint).toBeNull();

          // Counting: no sort, the natural order, and the hint says so.
          const beforeTotal = all.exchanges.length;
          ui.toggleTotal();
          const counted = await ui.awaitTable(
            (view) =>
              view.totalHint !== null &&
              view.rows.join() === RUN_AT_DESC.join(),
          );
          const countedReads = reads(all, "/queues/backlog/jobs", beforeTotal);
          expect(countedReads.length).toBeGreaterThan(0);
          for (const exchange of countedReads) {
            expect(exchange.query.get("total")).toBe("true");
            expect(exchange.query.has("sort")).toBe(false);
            expect(exchange.status).toBe(200);
          }
          expect(counted.totalHint).toContain(
            "While counting, a one-state tab keeps its own order, not creation order.",
          );
        } finally {
          ui.unmount();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "sums only the queues an authorize allows, and the UI shows that sum",
      async () => {
        const { all, restricted } = pick();
        const every = await read<AddedBody>(all, "/overview/added");
        const visible = await read<AddedBody>(restricted, "/overview/added");
        expect(every.counts).toEqual(TRUTH);
        expect(every.queues).toBe(3);
        expect(visible.counts).toEqual(VISIBLE_TRUTH);
        expect(visible.queues).toBe(2);
        expect(visible.total).toBe(every.total - 4);
        // The hidden queue's own route is refused, not answered.
        const hidden = await request(
          restricted,
          `/queues/${HIDDEN}/counts/added`,
        );
        expect(hidden.status).toBe(403);
        await checkTile(restricted, VISIBLE_TRUTH, 2);
      },
      TEST_TIMEOUT_MS,
    );
  });
}

describe("added by state polls slowly: memory", () => {
  it(
    "reads /overview/added once while the Overview polls twice",
    async () => {
      const { all } = memory;
      const h = await harness();
      // The premise: a group polled with the Overview would read twice here.
      expect(h.ADDED_BY_STATE_POLL_MS).toBeGreaterThan(2 * h.POLL_INTERVAL_MS);
      const start = all.exchanges.length;
      const overview = await h.mountOverview(all.fetch);
      try {
        await h.awaitRangeStat(bothGroups);
        const [first] = reads(all, "/overview/added", start);
        expect(first).toBeDefined();
        // Two more Overview polls after the group's first read.
        await until(
          () =>
            reads(all, "/overview", start).filter(
              (exchange) => exchange.at > first!.at,
            ).length >= 2,
          () => "the Overview never polled twice",
          2 * h.POLL_INTERVAL_MS + 10_000,
        );
        const elapsed = Date.now() - first!.at;
        const overviewPolls = reads(all, "/overview", start).filter(
          (exchange) => exchange.at > first!.at,
        );
        // Still inside the group's own interval, so it has not read again —
        // although the Overview, on its 5 s, has.
        expect(elapsed).toBeLessThan(h.ADDED_BY_STATE_POLL_MS);
        expect(overviewPolls.length).toBeGreaterThanOrEqual(2);
        expect(reads(all, "/overview/added", start)).toHaveLength(1);
      } finally {
        overview.unmount();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("added by state off: the file driver", () => {
  it(
    "reports the flag off, prunes both routes and refuses sort=createdAt with a detail",
    async () => {
      const { all } = file;
      const meta = await read<{ features: { addedByState: boolean } }>(
        all,
        "/meta",
      );
      expect(meta.features.addedByState).toBe(false);
      for (const path of ["/overview/added", "/queues/backlog/counts/added"]) {
        const { status } = await request(all, path);
        expect(`${path} ${status}`).toBe(`${path} 404`);
      }
      const sorted = await request(
        all,
        "/queues/backlog/jobs?state=delayed&sort=createdAt&order=desc",
      );
      // Never a page silently in the natural order.
      expect(sorted.status).toBe(400);
      expect(sorted.json).toMatchObject({
        code: "INVALID_ARGUMENT",
        context: { sort: "createdAt", features: { addedByState: false } },
      });
      expect((sorted.json as { detail: string }).detail).toContain(
        "cannot order jobs by creation time",
      );
      // The same tab without `sort` is served, in its natural order.
      const natural = await read<{ items: { id: string }[] }>(
        all,
        "/queues/backlog/jobs?state=delayed&order=desc",
      );
      expect(natural.items.map((job) => job.id)).toEqual(RUN_AT_DESC);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "shows the finished group alone and never reads /overview/added",
    async () => {
      const { all } = file;
      const start = all.exchanges.length;
      const h = await harness();
      const overview = await h.mountOverview(all.fetch);
      try {
        const tile = await h.awaitRangeStat((view) => view.finished !== null);
        expect(tile.added).toBeNull();
        expect(tile.text).not.toContain("Added in");
        // Alone, the finished group is unlabelled, as before the feature.
        expect(tile.finished!.heading).toBeNull();
        expect(tile.finished!.rows.map(([label]) => label)).toEqual([
          "Completed",
          "Failed attempts",
        ]);
        // Let the Overview's other reads land, then look at all of them.
        await until(
          () => reads(all, "/overview", start).length > 0,
          () => "the Overview never read /overview",
        );
        const made = all.exchanges.slice(start);
        expect(made.length).toBeGreaterThan(0);
        expect(made.filter((one) => one.path === "/overview/added")).toEqual(
          [],
        );
        expect(made.filter((one) => one.query.has("sort"))).toEqual([]);
      } finally {
        overview.unmount();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "sends no sort from a Delayed tab, counted or not",
    async () => {
      const { all } = file;
      const start = all.exchanges.length;
      const h = await harness();
      const ui = await h.mountJobsTable(all.fetch, "backlog", "?state=delayed");
      try {
        const view = await ui.awaitTable((one) => one.rows.length === 3);
        expect(view.rows).toEqual(RUN_AT_DESC);
        ui.toggleTotal();
        await until(
          () =>
            reads(all, "/queues/backlog/jobs", start).some(
              (one) => one.query.get("total") === "true",
            ),
          () => "the counted page was never read",
        );
        const jobReads = reads(all, "/queues/backlog/jobs", start);
        for (const exchange of jobReads) {
          expect(exchange.query.has("sort")).toBe(false);
          expect(exchange.status).toBe(200);
        }
        expect(
          all.exchanges.slice(start).filter((one) => one.query.has("sort")),
        ).toEqual([]);
        // Nothing about creation order where it is not offered.
        const counted = await ui.awaitTable((one) => one.rows.length === 3);
        expect(counted.totalHint).toBeNull();
      } finally {
        ui.unmount();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
