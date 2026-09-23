/**
 * The Overview's range control and its analytics sections, in a real
 * browser, against real `createJobsApi`s over real workers and a real
 * runner. Every figure on screen is checked against what the seed did, and
 * every range against the requests the host actually received.
 *
 * ```bash
 * bun 06-browser/overview-range.ts
 * BUN_CHROME_PATH=/opt/chrome/chrome bun 06-browser/overview-range.ts
 * EXAMPLE_BROWSER=0 bun 06-browser/overview-range.ts   # skip on purpose
 * ```
 *
 * Like the other browser examples it drives headless Chrome through
 * `Bun.WebView` and **skips** (prints `skipped:` and exits 0) when there is
 * no `Bun.WebView`, no Chrome, or Chrome will not start.
 *
 * What it shows:
 *
 * - **One range control on the title row, or one per section.** "Apply date
 *   filter to page" is on by default: one control ("Range for every
 *   section") drives every section through `?range=`. Off, it writes
 *   `?rangeScope=section` and each card gets its own control, stored as
 *   `jobsRange`, `queuesRange`, `runnersRange` and `workersRange`. Each
 *   choice is in the URL (so a reload keeps it) and in the `from`/`to` of
 *   the requests that section sends. Nothing sends the deprecated `minutes`.
 * - **The "Over the range" band.** "Finished in range" is the analytics
 *   series' own total (Completed, and Failed *attempts*, which count a
 *   retrying job's failed try and a dead job's last one alike), labelled with
 *   the resolution the API served. Where `features.addedByState` is on, a
 *   second group counts the jobs *added* in the range by the state they are
 *   in now, every state and a Total.
 * - **The Runners and Workers sections cost two requests each, at any fleet
 *   size**: a roll-up, then one batch (`ids=` / `keys=`) for the sparklines
 *   of the rows on screen. With 130 worker keys and 120 runners it is still
 *   two, and the note says "Showing the 100 busiest … of M".
 * - **The clamped-range caption**, worded by the API's `reason`: `retention`
 *   (five minutes asked at one-second buckets from a host that keeps two
 *   minutes of them) and `driver` (a host recording minutes only, asked for
 *   the last 60 seconds), and `retention` again for a day that ended an hour
 *   ago. "Last 24 hours" is exactly the minute retention and is **not**
 *   clamped: the server compares retention by bucket, and the page starts a
 *   rolling preset at the first whole bucket inside it, so up to a bucket of
 *   skew between the page's clock and the server's does not count. The Overview cannot provoke `maxBuckets` or
 *   `resolution` against a real API: see the end of this comment.
 * - **"No numbers are kept for this range"**: a day that ended two days ago
 *   is wholly older than the API keeps, so every analytics read is answered
 *   400 `RANGE_NOT_RETAINED`, which the page explains, with no Retry; a
 *   queue's sparkline cell reads "not kept".
 * - **A host with no analytics** (`meta.analytics` is `null`): no Throughput
 *   column, no Runners or Workers section, and nothing read from an
 *   analytics route. The band keeps its added-by-state group alone; with
 *   that feature off too, the band is gone.
 * - **No fixed "last 60 minutes" figure** anywhere: throughput belongs to the
 *   range on screen.
 * - **A row opens what it names.** A Workers row's key links to that worker's
 *   page and its queue to the queue screen; a Runners row's runner links to
 *   its page. Each link is clicked here, not only read. Each is gated as the
 *   equivalent link elsewhere is, **on the untargeted map**: the key needs
 *   what the Workers nav entry needs, the runner what the Runners nav entry
 *   needs, the queue `queues.list`. So a host granting `workers.list` per
 *   queue leaves every row's key plain text — the section spans queues, and
 *   the app registers `/workers/:queue/:key` from the nav, which is built from
 *   the untargeted map, so a link there would open a route that does not exist
 *   for that caller. Anything not linkable is plain text, never a dead link.
 * - **A row may name something the API no longer reaches.** The rows answer
 *   "who did the work in this window", so a runner that is no longer
 *   registered and a worker key that is no longer live keep theirs. The link
 *   stays, and lands on that screen's own answer: "Runner not found", and a
 *   worker page with "No live instance".
 *
 * Why `maxBuckets` and `resolution` are not shown: the Overview asks for
 * one-second buckets only up to 15 minutes (at most 901 buckets) and minute
 * buckets up to a day (at most 1,441), both under the 1,500-bucket cap, which
 * `createJobsApi` does not let a host lower; and `resolution` is answered
 * only for a busyness series (the worker page), which no Overview read asks
 * for.
 *
 * Wait on conditions, never on time: every page read polls the DOM until
 * what it wants is there, and every seed step polls the API.
 */
import type {
  JobsApiAction,
  JobsApiAuthorize,
  JobsDriver,
} from "@kingsleyweb/bun-jobs";
import type { OverviewView, RowView } from "./helpers/overview-page";
import {
  BunHttpAdapter,
  createDeferred,
  noopLogger,
} from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  MemoryDriver,
  runnerKey,
} from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
import { chromeOrSkip, openView, textOf } from "../shared/browser";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import {
  chooseRange,
  READ_OVERVIEW,
  TOGGLE_SCOPE,
} from "./helpers/overview-page";
import { at, clickOn } from "./helpers/page";

// Decide whether to skip before printing anything: run-all.ts recognises a
// skip by the output *starting* with `skipped:`.
const chromePath = chromeOrSkip();

/** The service every context runs as: a worker's key is `<service>.<queue>`. */
const SERVICE = "api";
/** The queue a real worker drains. */
const ORDERS = "orders";
/** The worker key the Workers section shows for it. */
const ORDERS_KEY = `${SERVICE}.${ORDERS}`;
/** A queue nothing consumes: two waiting jobs and a delayed one. */
const BACKLOG = "backlog";
/** The real runner: two runs return, one throws. */
const RUNNER = "nightly";
/** How long the main host keeps one-second buckets: less than the 5-minute preset. */
const SECOND_RETENTION_MS = 2 * 60_000;
/** How many worker keys the fleet host counts for: more than a roll-up returns. */
const FLEET_KEYS = 130;
/** How many runners the fleet host counts for. */
const FLEET_RUNNERS = 120;
/** The most rows a roll-up returns (`MAX_ANALYTICS_ROWS`). */
const MAX_ROWS = 100;
/** The page size of a section, and the batch cap (`MAX_ANALYTICS_SERIES`). */
const MAX_SERIES = 20;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The driver methods every analytics route needs; hiding them is a host with no analytics. */
const ANALYTICS_METHODS: (keyof JobsDriver)[] = [
  "getMetricsSupport",
  "getNamespaceMetrics",
  "getQueueMetrics",
];

/** The seeded jobs: what "Added in range, where they are now" must show. */
const ADDED: [label: string, value: string][] = [
  ["Waiting", "2"],
  ["Delayed", "1"],
  ["Active", "1"],
  ["Completed", "4"],
  ["Retrying", "1"],
  ["Dead", "1"],
  ["Waiting children", "0"],
  ["Total", "10"],
];

/* --- hosts: each an API and the UI on an adapter of its own -------- */

/** One request the host received under the API's base path. */
interface Seen {
  /** The path under the API's base, without the query. */
  path: string;
  /** The query. */
  query: URLSearchParams;
  /** The whole URL as received, for replaying it. */
  url: string;
}

/** A host under test. */
interface Host {
  /** How it is named in the output. */
  name: string;
  /** Its jobs context. */
  jobs: BunJobs;
  /** Its origin, e.g. `http://localhost:41234`. */
  origin: string;
  /** The Overview's URL. */
  overview: string;
  /** The API's base path. */
  apiBase: string;
  /** The UI's base path, which every app link is written under. */
  uiBase: string;
  /** Every API request it received, oldest first. */
  seen: Seen[];
  /** Stops it. */
  close: () => Promise<void>;
}

/**
 * The same driver with some optional methods hidden, as a driver written
 * before them would be. Methods are bound to the real driver so its private
 * state still works.
 */
function without(real: JobsDriver, methods: (keyof JobsDriver)[]): JobsDriver {
  return new Proxy(real, {
    get(target, property) {
      if (methods.includes(property as keyof JobsDriver)) {
        return undefined;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Serves an API (mode `both`, with its socket, so the page goes live and
 * polls once a minute rather than every 5 s: a request count is then the
 * page's reads, not its polls) and the UI, recording every API request.
 *
 * `authorize` defaults to allowing everything; a host passing one of its own
 * decides per action, and per queue or runner, as a real host would.
 */
async function serveHost(
  name: string,
  driver: JobsDriver,
  authorize: JobsApiAuthorize = () => true,
): Promise<Host> {
  const jobs = new BunJobs({
    namespace: `examples-ui-overview-${name}`,
    service: SERVICE,
    driver,
    logger: noopLogger,
  });
  const api = createJobsApi({
    jobs,
    mode: "both",
    basePath: "/jobs-api",
    authorize,
    logger: noopLogger,
  });
  const ui = jobsUi({ api, logger: noopLogger });
  const app = new BunHttpAdapter(0, { logger: noopLogger });
  const seen: Seen[] = [];
  // Ahead of the API, so it sees every request whatever the API answers.
  app.use((req, _res, next) => {
    if (req.originalUrl.startsWith(`${api.basePath}/`)) {
      const url = new URL(req.originalUrl, "http://host");
      seen.push({
        path: url.pathname.slice(api.basePath.length),
        query: url.searchParams,
        url: req.originalUrl,
      });
    }
    next();
  });
  app.use(api.basePath, api.router);
  api.websocket?.attach(app);
  app.use(ui.basePath, ui.router);
  await app.listen(0);
  const origin = app.url!.replace(/\/$/, "");
  // Build the bundle before the browser asks.
  await (await fetch(`${origin}${ui.basePath}`)).arrayBuffer();
  return {
    name,
    jobs,
    origin,
    overview: `${origin}${ui.basePath}`,
    apiBase: api.basePath,
    uiBase: ui.basePath,
    seen,
    close: async () => {
      await app.close();
      await api.close();
      await jobs.close();
    },
  };
}

/** A JSON read from `host`'s API, bypassing the page (and not recorded as the page's). */
async function read<T>(
  host: Host,
  path: string,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${host.origin}${host.apiBase}${path}`);
  host.seen.pop();
  return { status: response.status, body: (await response.json()) as T };
}

/** Replays a request the page made, to see what the host answered it. */
async function replay<T>(
  host: Host,
  one: Seen,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${host.origin}${one.url}`);
  host.seen.pop();
  return { status: response.status, body: (await response.json()) as T };
}

/** The page's requests to `path` since `from`. */
function sent(host: Host, from: number, path: string): Seen[] {
  return host.seen.slice(from).filter((one) => one.path === path);
}

/** A request's span, `to − from`, in ms. */
function span(one: Seen): number {
  return Number(one.query.get("to")) - Number(one.query.get("from"));
}

/**
 * What is wrong with `reads` as a **rolling preset's** analytics reads of
 * `length` ms at `resolution` s, or `[]` when nothing is: there is at least
 * one, each asks for that resolution, its `from` sits on a bucket boundary,
 * and its span is `length − bucket ≤ to − from < length`.
 *
 * A preset starts at the first whole bucket inside its window
 * (`floor((now − length) / bucket) · bucket + bucket`), so that clock skew up
 * to a bucket cannot push its start past the server's retention line. The
 * span is exactly `length − bucket` when `now − length` falls on a boundary
 * itself, and never reaches `length`. Custom ranges and `/overview/added`
 * are sent as given, and are checked for their exact span instead.
 */
function rollingProblems(
  reads: Seen[],
  length: number,
  resolution: 1 | 60,
): string[] {
  if (reads.length === 0) {
    return ["no read"];
  }
  const bucket = resolution * 1_000;
  return reads.flatMap((one) => {
    const problems: string[] = [];
    if (one.query.get("resolution") !== String(resolution)) {
      problems.push(`resolution ${one.query.get("resolution")}`);
    }
    if (Number(one.query.get("from")) % bucket !== 0) {
      problems.push(
        `from ${one.query.get("from")} is not on a ${bucket} ms boundary`,
      );
    }
    if (!(span(one) >= length - bucket && span(one) < length)) {
      problems.push(
        `span ${span(one)} outside [${length - bucket}, ${length})`,
      );
    }
    return problems.map((problem) => `${one.path}: ${problem}`);
  });
}

/** Splits roll-up reads from batch reads (the ones naming `ids=` / `keys=`). */
function split(reads: Seen[]): { rollups: Seen[]; batches: Seen[] } {
  const named = (one: Seen) => one.query.has("ids") || one.query.has("keys");
  return {
    rollups: reads.filter((one) => !named(one)),
    batches: reads.filter(named),
  };
}

/* --- the main host: a worker, a runner, a job in every state ------- */

const main = await serveHost(
  "main",
  new MemoryDriver({ metrics: { secondRetentionMs: SECOND_RETENTION_MS } }),
);
/** Released at shutdown: until then the held job stays active. */
const release = createDeferred<void>();
const worker = main.jobs.worker<{ fail?: boolean; hold?: boolean }, string>(
  ORDERS,
  async (job) => {
    if (job.data?.hold) {
      await release.promise;
    }
    if (job.data?.fail) {
      throw new Error("asked to fail");
    }
    return "ok";
  },
  { concurrency: 2, pollInterval: 10, logger: noopLogger },
);
void worker.run();

/** Waits until job `id` of `queue` is in `state`. */
async function settle(queue: string, id: string, state: string) {
  await waitFor(
    `${queue}/${id} to be ${state}`,
    async () => (await main.jobs.queue(queue).getJob(id))?.state === state,
  );
}

const orders = main.jobs.queue<{ fail?: boolean; hold?: boolean }>(ORDERS);
for (const id of ["done-1", "done-2", "done-3", "done-4"]) {
  await orders.add("order", {}, { jobId: id, attempts: 1 });
}
// Gives up at once: dead after one failed attempt.
await orders.add("order", { fail: true }, { jobId: "buried", attempts: 1 });
// Fails its first attempt and waits an hour to retry: "Retrying".
await orders.add(
  "order",
  { fail: true },
  { jobId: "retrying", attempts: 3, backoff: { type: "fixed", delay: HOUR } },
);
for (const id of ["done-1", "done-2", "done-3", "done-4"]) {
  await settle(ORDERS, id, "completed");
}
await settle(ORDERS, "buried", "dead");
await settle(ORDERS, "retrying", "failed");
await orders.add("order", { hold: true }, { jobId: "held", attempts: 1 });
await settle(ORDERS, "held", "active");
const backlog = main.jobs.queue(BACKLOG);
await backlog.add("task", {}, { jobId: "waiting-1" });
await backlog.add("task", {}, { jobId: "waiting-2" });
await backlog.add("task", {}, { jobId: "later", delay: HOUR });

// A real in-process runner: two runs return, then one throws.
const runner = main.jobs.runner({
  id: RUNNER,
  file: new URL("./helpers/maybe-fail.ts", import.meta.url),
  executionMode: "in-process",
  waitToExit: false,
});
await runner.start();
for (const [index, fail] of [false, false, true].entries()) {
  await runner.trigger({ args: { fail } }).catch(() => undefined);
  await waitFor(
    `run ${index + 1} of ${RUNNER} to finish`,
    async () =>
      (await runner.history()).length === index + 1 &&
      runner.activeRuns.size === 0,
  );
}

/** The last hour, as the API reads it. */
function lastHour(): string {
  const now = Date.now();
  return `from=${now - HOUR}&to=${now + 1_000}&resolution=60`;
}

// Counts reach the buckets on a flush (about once a second): wait until the
// API reports every one, so the page has nothing left to catch up on.
await waitFor(
  "the jobs series to count 4 completed and 2 failed attempts",
  async () => {
    const { body } = await read<{
      totals: { completed: number; failed: number };
    }>(main, `/analytics/jobs?${lastHour()}`);
    return body.totals.completed === 4 && body.totals.failed === 2;
  },
);
await waitFor(
  `the ${ORDERS_KEY} worker's counts to reach the API`,
  async () => {
    const { body } = await read<{
      rows: { key: string; totals: { completed: number; failed: number } }[];
    }>(main, `/analytics/workers?${lastHour()}`);
    const row = body.rows.find((one) => one.key === ORDERS_KEY);
    return row?.totals.completed === 4 && row.totals.failed === 2;
  },
);
await waitFor(`${RUNNER}'s three runs to reach the API`, async () => {
  const { body } = await read<{
    rows: { runner: string; totals: { started: number } }[];
  }>(main, `/analytics/runners?${lastHour()}`);
  return body.rows.find((one) => one.runner === RUNNER)?.totals.started === 3;
});

/* --- the other hosts ------------------------------------------------ */

// Minutes only: asked for the seconds a 60-second range wants, it says why not.
const minute = await serveHost(
  "minute",
  new MemoryDriver({ metrics: { resolution: "minute" } }),
);
await minute.jobs.queue(ORDERS).add("order", {});

// More worker keys and runners than a roll-up returns. Starting 250 real
// workers and runners proves nothing more about the page, so their counts
// are written through the real driver methods a worker's and a runner's
// recorders call, and read back through the real routes.
const fleetDriver = new MemoryDriver();
const fleet = await serveHost("fleet", fleetDriver);
// A key's row is read over the queues the API lists, and a queue is listed
// once it has held a job.
await fleet.jobs.queue("bulk").add("seed", {});
const fleetNow = Date.now();
for (let index = 0; index < FLEET_KEYS; index++) {
  // Key i did i + 1 jobs, so the busiest is the last and the ranking is plain.
  await fleetDriver.countWorkerJobs(
    { ns: fleet.jobs.namespace, queue: "bulk" },
    fleetKey(index),
    fleetNow,
    { completed: index + 1 },
  );
}
for (let index = 0; index < FLEET_RUNNERS; index++) {
  await fleetDriver.countRunnerRun(
    fleet.jobs.namespace,
    runnerKey(fleetRunner(index)),
    fleetNow,
    { started: index + 1, succeeded: index + 1 },
  );
}

// No analytics at all: a driver written before them. The added-by-state
// count is still there, so the band keeps that group alone.
const bare = await serveHost(
  "bare",
  without(new MemoryDriver(), ANALYTICS_METHODS),
);
// …and without it either: no band at all.
const bareNoAdded = await serveHost(
  "bare-no-added",
  without(new MemoryDriver(), [...ANALYTICS_METHODS, "countAddedJobs"]),
);
for (const host of [bare, bareNoAdded]) {
  await host.jobs.queue(BACKLOG).add("task", {});
  await host.jobs.queue(BACKLOG).add("task", {});
}

/**
 * What the gated host refuses, untargeted. Its `authorize` reads it on every
 * request, so a reload of the page asks `/meta/permissions` afresh and the
 * links change with it — one host, one seed, every fallback.
 */
const refusedUntargeted = new Set<JobsApiAction>();
/**
 * A host that answers per queue and per runner, the way a real one with
 * per-queue grants does: an action in {@link refusedUntargeted} is refused
 * when no queue or runner is named, and allowed when one is. The Overview's
 * analytics sections span queues, so they see only the untargeted answer.
 */
const gatedDriver = new MemoryDriver();
const gatedAuthorize: JobsApiAuthorize = (_req, context) =>
  refusedUntargeted.has(context.action)
    ? context.queue !== undefined || context.runner !== undefined
    : true;
const gated = await serveHost("gated", gatedDriver, gatedAuthorize);
// Its rows the way the fleet's are made: the counts a worker's and a runner's
// recorders write, through the real driver methods, read back through the real
// routes. A key's row is read over the queues the API lists, and a queue is
// listed once it has held a job.
await gated.jobs.queue(ORDERS).add("order", {});
const gatedNow = Date.now();
await gatedDriver.countWorkerJobs(
  { ns: gated.jobs.namespace, queue: ORDERS },
  ORDERS_KEY,
  gatedNow,
  { completed: 3 },
);
await gatedDriver.countRunnerRun(
  gated.jobs.namespace,
  runnerKey(RUNNER),
  gatedNow,
  { started: 2, succeeded: 2 },
);

const hosts = [main, minute, fleet, bare, bareNoAdded, gated];

/** The fleet's `index`th worker key, zero-padded so it sorts as it counts. */
function fleetKey(index: number): string {
  return `fleet-${String(index + 1).padStart(3, "0")}`;
}

/** The fleet's `index`th runner id. */
function fleetRunner(index: number): string {
  return `job-${String(index + 1).padStart(3, "0")}`;
}

/** Winds everything down; safe to call more than once. */
async function shutdown(view?: Bun.WebView): Promise<void> {
  view?.close();
  release.resolve();
  await worker.close({ timeout: 1_000 });
  await runner.stop().catch(() => undefined);
  for (const host of hosts) {
    await host.close();
  }
}

/* --- the browser: skip, not fail, if Chrome will not start --------- */

/** What the page printed to its console, for a failure's diagnosis. */
const pageConsole: string[] = [];
const view = await openView(chromePath, pageConsole, shutdown);

title("The Overview's range control and analytics sections, in Chrome");
show("Chrome", chromePath);
for (const host of hosts) {
  show(`serving ${host.name}`, host.overview);
}

/**
 * Resolves with the Overview once `ready` holds for it, polling the page;
 * throws with the last view if it never does.
 */
async function overviewUntil(
  what: string,
  ready: (view: OverviewView) => boolean,
  timeout = 15_000,
): Promise<OverviewView> {
  let last: OverviewView | undefined;
  try {
    await waitFor(
      what,
      async () => {
        last = await view.evaluate<OverviewView>(READ_OVERVIEW);
        return last.ready && ready(last);
      },
      { timeout, interval: 50 },
    );
  } catch (error) {
    console.log(
      `last view: ${JSON.stringify(last, (key, value: unknown) => (key === "text" ? undefined : value)).slice(0, 4_000)}`,
    );
    throw error;
  }
  return last!;
}

/** Opens `host`'s Overview at `search`; answers with where its request log stood. */
async function open(host: Host, search = ""): Promise<number> {
  const from = host.seen.length;
  await view.navigate(`${host.overview}${search}`);
  return from;
}

/** Whether a section card has settled: its rows and every sparkline drawn (headline ones included). */
function settled(
  screen: OverviewView,
  card: "Runners" | "Workers",
  headline: number,
): boolean {
  const section = screen.cards[card];
  return (
    section !== undefined &&
    section.rows.length > 0 &&
    section.sparklines.length >= headline + section.rows.length
  );
}

/** Whether the Workers section has drawn its rows and every sparkline. */
function workersDrawn(screen: OverviewView): boolean {
  return settled(screen, "Workers", 1);
}

/** The same for the Runners section, whose headline carries two sparklines. */
function runnersDrawn(screen: OverviewView): boolean {
  return settled(screen, "Runners", 2);
}

/** Whether every card of the main host has drawn its data. */
function mainSettled(screen: OverviewView): boolean {
  return (
    (screen.cards.Jobs?.sparklines.length ?? 0) > 0 &&
    (screen.cards.Queues?.sparklines.length ?? 0) >= 2 &&
    settled(screen, "Runners", 2) &&
    settled(screen, "Workers", 1) &&
    screen.band !== null &&
    screen.band.groups.length === 2 &&
    screen.band.groups[1]!.cells.length === ADDED.length
  );
}

/** Every card's caption, by card, for the ones that have one. */
function captions(screen: OverviewView): Record<string, string | null> {
  const found: Record<string, string | null> = {};
  for (const [name, card] of Object.entries(screen.cards)) {
    if (card.caption) {
      found[name] = card.caption.reason;
    }
  }
  return found;
}

/** The retention caption, worded for the minute buckets it was answered with. */
const RETENTION_CAPTION =
  "This is not exactly the range asked for: this API does not keep that far back at the resolution asked for, so it answered with 1-minute buckets.";
/** The driver caption. */
const DRIVER_CAPTION =
  "This is not exactly the range asked for: this backend cannot record that fineness at all, so it answered with 1-minute buckets.";

try {
  /* ---------------------------------------------------------------- */
  step("The default: one range for the page, the last hour");

  let from = await open(main);
  let screen = await overviewUntil("every section to draw", mainSettled);
  checkEqual(
    'the title row\'s toggle reads "Apply date filter to page", on',
    screen.scope,
    { label: "Apply date filter to page", checked: true },
  );
  checkEqual(
    "one range control, on the title row, on the last hour; nothing in the URL",
    [screen.pickers, screen.pageRange, screen.search],
    [["Range for every section"], "3600", ""],
  );
  checkEqual(
    '"Over the range", labelled with the resolution served',
    screen.band?.head,
    "Over the range in 1-minute buckets",
  );
  checkEqual(
    "Finished in range: 4 completed, 2 failed attempts (the retrying job's and the dead one's)",
    screen.band?.groups[0],
    {
      title: "Finished in range",
      cells: [
        ["Completed", "4"],
        ["Failed attempts", "2"],
      ],
    },
  );
  checkEqual(
    "Added in range, where they are now: every state, then the Total",
    screen.band?.groups[1],
    {
      title: "Added in range, where they are now (still stored)",
      cells: ADDED,
    },
  );

  const jobsReads = sent(main, from, "/analytics/jobs");
  checkEqual(
    "the host saw one /analytics/jobs, as from/to/resolution only (no minutes)",
    jobsReads.map((one) => [...one.query.keys()]),
    [["from", "to", "resolution"]],
  );
  checkEqual(
    "it covers the last hour at resolution 60, from the first whole minute in",
    rollingProblems(jobsReads, HOUR, 60),
    [],
  );
  check(
    "no request carried the deprecated minutes (/overview included)",
    main.seen.slice(from).every((one) => !one.query.has("minutes")) &&
      sent(main, from, "/overview").length > 0,
    main.seen.slice(from).map((one) => one.url),
  );
  checkEqual(
    "/overview/added was read over the same hour, as from/to only",
    sent(main, from, "/overview/added").map((one) => [
      [...one.query.keys()],
      span(one),
    ]),
    [[["from", "to"], HOUR]],
  );

  const runners = screen.cards.Runners!;
  checkEqual(
    `the Runners row for ${RUNNER}: 3 started, 2 succeeded, 1 failed, 0 / 0, 0 running`,
    runners.rows.map((row) => row.cells.slice(0, 6)),
    [[RUNNER, "3", "2", "1", "0 / 0", "0"]],
  );
  const runnerReads = split(sent(main, from, "/analytics/runners"));
  checkEqual(
    "Runners: two requests, a roll-up and one batch naming the row on screen",
    [
      runnerReads.rollups.length,
      runnerReads.batches.map((one) => one.query.getAll("ids")),
    ],
    [1, [[RUNNER]]],
  );
  const workers = screen.cards.Workers!;
  checkEqual(
    `the Workers row for ${ORDERS_KEY}: queue orders, 4 completed, 2 failed`,
    workers.rows.map((row) => row.cells.slice(0, 4)),
    [[ORDERS_KEY, ORDERS, "4", "2"]],
  );
  const workerReads = split(sent(main, from, "/analytics/workers"));
  checkEqual(
    "Workers: two requests, a roll-up and one batch naming the row on screen",
    [
      workerReads.rollups.length,
      workerReads.batches.map((one) => one.query.getAll("keys")),
    ],
    [1, [[ORDERS_KEY]]],
  );
  checkEqual(
    'below the cutoff, neither section says "Showing the … busiest"',
    [runners.truncated, workers.truncated],
    [null, null],
  );
  checkEqual(
    "an unclamped answer has no caption anywhere",
    captions(screen),
    {},
  );
  check(
    "the Queues table has a Throughput column, one sparkline per queue",
    screen.cards.Queues!.headers.includes("Throughput") &&
      screen.cards.Queues!.sparklines.includes(
        "orders: 4 completed, 2 failed, in 1-minute buckets",
      ),
    screen.cards.Queues,
  );
  check(
    'no fixed "last 60 minutes" figure: not in the text, not a Totals tile',
    !/last 60 minutes/i.test(screen.text) &&
      !screen.totals.some((label) => /throughput|minutes/i.test(label)),
    screen.totals,
  );

  /* ---------------------------------------------------------------- */
  step("The page-wide control: the last 6 hours, for every section");

  from = main.seen.length;
  check(
    'the "Range for every section" control takes "Last 6 hours"',
    await view.evaluate<boolean>(
      chooseRange("Range for every section", "21600"),
    ),
  );
  screen = await overviewUntil(
    "the page to read the 6-hour range",
    (one) =>
      one.search === "?range=21600s" &&
      sent(main, from, "/overview/added").length > 0 &&
      split(sent(main, from, "/analytics/workers")).batches.length > 0 &&
      split(sent(main, from, "/analytics/runners")).batches.length > 0 &&
      sent(main, from, `/queues/${ORDERS}/analytics/jobs`).length > 0 &&
      mainSettled(one),
  );
  check(
    "the URL says ?range=21600s",
    screen.search === "?range=21600s",
    screen.search,
  );
  checkEqual(
    "every analytics read covers 6 hours at resolution 60, from the first whole minute in",
    [
      "/analytics/jobs",
      "/analytics/runners",
      "/analytics/workers",
      `/queues/${ORDERS}/analytics/jobs`,
    ].flatMap((path) => rollingProblems(sent(main, from, path), 6 * HOUR, 60)),
    [],
  );
  checkEqual(
    "and /overview/added spans exactly 6 hours",
    [...new Set(sent(main, from, "/overview/added").map(span))],
    [6 * HOUR],
  );
  checkEqual(
    "the band's figures are the same six jobs",
    screen.band?.groups[0]?.cells,
    [
      ["Completed", "4"],
      ["Failed attempts", "2"],
    ],
  );

  /* ---------------------------------------------------------------- */
  step("A clamped range: 5 minutes at 1-second buckets, 2 minutes kept");

  from = main.seen.length;
  await view.evaluate<boolean>(chooseRange("Range for every section", "300"));
  screen = await overviewUntil(
    "the retention caption on Jobs, Runners and Workers",
    (one) => Object.keys(captions(one)).length === 3 && mainSettled(one),
  );
  checkEqual(
    'the caption says reason "retention" on each analytics section',
    captions(screen),
    { Jobs: "retention", Runners: "retention", Workers: "retention" },
  );
  checkEqual(
    "and is worded for the 1-minute buckets the API served",
    [
      ...new Set(
        Object.values(screen.cards)
          .map((card) => card.caption?.text)
          .filter(Boolean),
      ),
    ],
    [RETENTION_CAPTION],
  );
  const clampedRead = sent(main, from, "/analytics/jobs")[0]!;
  const clamped = await replay<{
    range: { resolution: number; clamped: boolean; reason: string };
  }>(main, clampedRead);
  checkEqual(
    "the page asked for 5 minutes at resolution 1; the host answered 60, clamped, reason retention",
    [rollingProblems([clampedRead], 5 * 60_000, 1), clamped.body.range],
    [
      [],
      {
        ...clamped.body.range,
        resolution: 60,
        clamped: true,
        reason: "retention",
      },
    ],
  );
  checkEqual(
    "the band says what was served",
    screen.band?.head,
    "Over the range in 1-minute buckets",
  );

  await view.evaluate<boolean>(chooseRange("Range for every section", "60"));
  screen = await overviewUntil(
    "the last 60 seconds, served at 1-second buckets",
    (one) =>
      one.search === "?range=60s" &&
      one.band?.head === "Over the range in 1-second buckets" &&
      Object.keys(captions(one)).length === 0,
  );
  check("within the 2 minutes kept: no caption, 1-second buckets", true);

  /* ---------------------------------------------------------------- */
  step('"Apply date filter to page" off: a range per section');

  from = main.seen.length;
  check("the toggle is clicked", await view.evaluate<boolean>(TOGGLE_SCOPE));
  screen = await overviewUntil(
    "a range control on each card",
    (one) => one.pickers.length === 4,
  );
  checkEqual(
    "the URL gains rangeScope=section; the page-wide control is gone",
    [
      new URLSearchParams(screen.search).get("rangeScope"),
      screen.pageRange,
      screen.scope?.checked,
    ],
    ["section", null, false],
  );
  checkEqual(
    "each card has its own control, on its own default (the last hour)",
    Object.fromEntries(
      Object.entries(screen.cards).map(([name, card]) => [
        name,
        [card.picker, card.pickerValue],
      ]),
    ),
    {
      Jobs: ["Jobs range", "3600"],
      Queues: ["Queues range", "3600"],
      Runners: ["Runners range", "3600"],
      Workers: ["Workers range", "3600"],
    },
  );

  from = main.seen.length;
  await view.evaluate<boolean>(chooseRange("Workers range", "600"));
  screen = await overviewUntil(
    "the Workers section alone to read 10 minutes",
    (one) =>
      new URLSearchParams(one.search).get("workersRange") === "600s" &&
      one.cards.Workers?.caption !== null &&
      settled(one, "Workers", 1),
  );
  const workerTen = split(sent(main, from, "/analytics/workers"));
  checkEqual(
    "workersRange=600s: the Workers roll-up and batch cover 10 minutes at resolution 1",
    [
      workerTen.rollups.length > 0 && workerTen.batches.length > 0,
      rollingProblems(
        [...workerTen.rollups, ...workerTen.batches],
        10 * 60_000,
        1,
      ),
    ],
    [true, []],
  );
  checkEqual(
    "only Workers is clamped (retention); Jobs and Runners still read their hour",
    [
      captions(screen),
      sent(main, from, "/analytics/jobs").length,
      sent(main, from, "/analytics/runners").length,
    ],
    [{ Workers: "retention" }, 0, 0],
  );

  from = main.seen.length;
  await view.evaluate<boolean>(chooseRange("Jobs range", "86400"));
  screen = await overviewUntil(
    "the Jobs section to read a day",
    (one) =>
      new URLSearchParams(one.search).get("jobsRange") === "86400s" &&
      sent(main, from, "/overview/added").length > 0 &&
      sent(main, from, "/analytics/jobs").length > 0 &&
      one.band?.groups[1]?.cells.length === ADDED.length,
  );
  checkEqual(
    "jobsRange=86400s: /analytics/jobs covers the day from the first whole minute in; /overview/added spans exactly a day",
    [
      rollingProblems(sent(main, from, "/analytics/jobs"), DAY, 60),
      sent(main, from, "/overview/added").map(span),
    ],
    [[], [DAY]],
  );
  checkEqual(
    "a day, the longest range the page holds: the added count keeps the one title, never cut to a last 24 hours",
    screen.band?.groups[1]?.title,
    "Added in range, where they are now (still stored)",
  );

  from = main.seen.length;
  // Ranges no section of this page has read yet: a range read in the last
  // 25 s is served from the page's cache, and would send nothing.
  await view.evaluate<boolean>(chooseRange("Queues range", "1800"));
  await view.evaluate<boolean>(chooseRange("Runners range", "600"));
  screen = await overviewUntil(
    "the Queues and Runners sections to read their own ranges",
    (one) => {
      const params = new URLSearchParams(one.search);
      return (
        params.get("queuesRange") === "1800s" &&
        params.get("runnersRange") === "600s" &&
        sent(main, from, `/queues/${ORDERS}/analytics/jobs`).length > 0 &&
        split(sent(main, from, "/analytics/runners")).batches.length > 0 &&
        settled(one, "Runners", 2)
      );
    },
  );
  checkEqual(
    "queuesRange=1800s and runnersRange=600s reach the sparklines and the runner reads",
    [
      rollingProblems(
        sent(main, from, `/queues/${ORDERS}/analytics/jobs`),
        30 * 60_000,
        60,
      ),
      rollingProblems(sent(main, from, "/analytics/runners"), 10 * 60_000, 1),
      sent(main, from, "/analytics/workers").length,
    ],
    [[], [], 0],
  );

  const shared = screen.search;
  await view.navigate(`${main.overview}${shared}`);
  screen = await overviewUntil(
    "the same link, reloaded",
    // Not every queue's sparkline: each is read only once its row scrolls
    // into view, and the taller cards may push a row below the fold.
    (one) =>
      one.pickers.length === 4 &&
      settled(one, "Runners", 2) &&
      settled(one, "Workers", 1),
  );
  checkEqual(
    "a reload keeps every section's range (the link is shareable)",
    Object.fromEntries(
      Object.entries(screen.cards).map(([name, card]) => [
        name,
        card.pickerValue,
      ]),
    ),
    { Jobs: "86400", Queues: "1800", Runners: "600", Workers: "600" },
  );

  await view.evaluate<boolean>(TOGGLE_SCOPE);
  screen = await overviewUntil(
    "the page-wide control back",
    (one) => one.pickers.length === 1,
  );
  checkEqual(
    "toggled back on: rangeScope leaves the URL, one control on the title row",
    [
      new URLSearchParams(screen.search).has("rangeScope"),
      screen.pickers,
      screen.pageRange,
    ],
    [false, ["Range for every section"], "60"],
  );

  /* ---------------------------------------------------------------- */
  step("The last 24 hours: exactly the minute retention, so not clamped");

  // Minute buckets are kept for a day, and a day is the longest range a
  // picker offers, so the preset sits on the retention line. Two things keep
  // it off: the server compares retention by bucket, and the page starts a
  // rolling preset at the first whole minute inside it, which tolerates up to
  // a minute of clock skew and latency between the page and the server.
  from = await open(main, "?range=86400s");
  screen = await overviewUntil(
    "every analytics section to draw the day",
    (one) =>
      (one.cards.Jobs?.sparklines.length ?? 0) > 0 &&
      settled(one, "Runners", 2) &&
      settled(one, "Workers", 1),
  );
  // From the new page's first read (`/meta`, as the app boots): the page
  // left behind may still have had a poll in flight when the link opened.
  const booted = main.seen.findIndex(
    (one, index) => index >= from && one.path === "/meta",
  );
  check("the new page booted with GET /meta", booted >= from, booted);
  from = booted;
  checkEqual(
    "every analytics read asks for the day at resolution 60, from the first whole minute in",
    ["/analytics/jobs", "/analytics/runners", "/analytics/workers"].flatMap(
      (path) => rollingProblems(sent(main, from, path), DAY, 60),
    ),
    [],
  );
  checkEqual(
    "and no section shows a clamped-range caption",
    captions(screen),
    {},
  );
  // The page's own request, replayed: its `from` is a whole minute inside
  // the day, so the answer stays unclamped for up to a minute after it was
  // sent, which a replay made now is well within.
  const dayRead = sent(main, from, "/analytics/jobs")[0]!;
  const day = await replay<{ range: { clamped: boolean; reason?: string } }>(
    main,
    dayRead,
  );
  checkEqual(
    "the page's /analytics/jobs for the day, replayed → clamped: false, no reason",
    [day.status, day.body.range.clamped, day.body.range.reason],
    [200, false, undefined],
  );
  // Why the page's resolution=60 matters: named no resolution, the API tries
  // one-second buckets first, and this host keeps those for two minutes, so
  // the same from/to comes back clamped. A page sending anything but 60 for
  // "Last 24 hours" would show the retention caption every time.
  const dayBare = await read<{
    range: { clamped: boolean; reason?: string; resolution: number };
  }>(
    main,
    `/analytics/jobs?from=${dayRead.query.get("from")}&to=${dayRead.query.get("to")}`,
  );
  checkEqual(
    "the same from/to with no resolution → clamped, reason retention, served at 60",
    [
      dayBare.status,
      dayBare.body.range.clamped,
      dayBare.body.range.reason,
      dayBare.body.range.resolution,
    ],
    [200, true, "retention", 60],
  );

  /* ---------------------------------------------------------------- */
  step("A day ending an hour ago: an hour older than retention, so clamped");

  const pastTo = Math.floor((Date.now() - HOUR) / 1_000) * 1_000;
  from = await open(main, `?range=${pastTo - DAY}-${pastTo}`);
  screen = await overviewUntil(
    "the retention caption on each analytics section",
    (one) => Object.keys(captions(one)).length === 3,
  );
  checkEqual(
    'reason "retention" on Jobs, Runners and Workers',
    captions(screen),
    { Jobs: "retention", Runners: "retention", Workers: "retention" },
  );
  checkEqual(
    "worded for the 1-minute buckets served",
    [
      ...new Set(
        Object.values(screen.cards)
          .map((card) => card.caption?.text)
          .filter(Boolean),
      ),
    ],
    [RETENTION_CAPTION],
  );
  const pastRead = sent(main, from, "/analytics/jobs").find(
    (one) => one.query.get("to") === String(pastTo),
  )!;
  checkEqual(
    "a custom range is sent as given: from and to exactly, a day apart",
    [Number(pastRead.query.get("from")), span(pastRead)],
    [pastTo - DAY, DAY],
  );
  screen = await overviewUntil(
    "the added-by-state group for the past day",
    (one) =>
      sent(main, from, "/overview/added").length > 0 &&
      one.band?.groups[1]?.cells.length === ADDED.length,
  );
  checkEqual(
    "/overview/added reads that same whole day, under the same title",
    [
      sent(main, from, "/overview/added").map((one) => [
        Number(one.query.get("from")),
        Number(one.query.get("to")),
      ]),
      screen.band?.groups[1]?.title,
    ],
    [
      [[pastTo - DAY, pastTo]],
      "Added in range, where they are now (still stored)",
    ],
  );
  const past = await replay<{
    range: {
      from: number;
      clamped: boolean;
      reason?: string;
      resolution: number;
      requested: { from: number };
    };
  }>(main, pastRead);
  check(
    "the host answered it clamped (retention), starting about an hour after the from asked for",
    past.status === 200 &&
      past.body.range.clamped &&
      past.body.range.reason === "retention" &&
      past.body.range.resolution === 60 &&
      past.body.range.from - past.body.range.requested.from >= HOUR - 60_000,
    past.body.range,
  );

  /* ---------------------------------------------------------------- */
  step("A range older than the API keeps: No numbers are kept");

  const oldTo = Math.floor((Date.now() - 2 * DAY) / 1_000) * 1_000;
  from = await open(main, `?range=${oldTo - DAY}-${oldTo}`);
  screen = await overviewUntil(
    "every analytics section to explain",
    (one) =>
      ["Jobs", "Runners", "Workers"].every(
        (name) =>
          one.cards[name]?.notRetained !== null &&
          one.cards[name]?.notRetained !== undefined,
      ) &&
      (one.cards.Queues?.text.includes("not kept") ?? false),
  );
  for (const name of ["Jobs", "Runners", "Workers"]) {
    const card = screen.cards[name]!;
    check(
      `${name}: "No numbers are kept for this range", with the oldest figure kept, no Retry, no alert`,
      card.notRetained!.startsWith("No numbers are kept for this range") &&
        card.notRetained!.includes("its oldest figure is from") &&
        !card.hasRetry &&
        card.alert === null,
      card,
    );
  }
  check(
    'the queue sparkline cells read "not kept"',
    screen.cards.Queues!.text.includes("not kept") &&
      !screen.cards.Queues!.text.includes("unavailable"),
    screen.cards.Queues?.text,
  );
  // Only the reads over that day: the page left behind may still have had a
  // sparkline read in flight when the link was opened.
  const refused = main.seen
    .slice(from)
    .filter(
      (one) =>
        one.query.get("to") === String(oldTo) &&
        (one.path.startsWith("/analytics/") ||
          one.path.endsWith("/analytics/jobs")),
    );
  const answers = await Promise.all(
    refused.map(async (one) => {
      const { status, body } = await replay<{ code?: string }>(main, one);
      return `${status} ${body.code}`;
    }),
  );
  check(
    "every analytics read the host saw was answered 400 RANGE_NOT_RETAINED",
    refused.length >= 3 &&
      answers.every((one) => one === "400 RANGE_NOT_RETAINED"),
    refused.map((one, index) => `${one.path} → ${answers[index]}`),
  );
  checkEqual(
    "the band has no Finished group then, but keeps the added count (zero, that day)",
    [screen.band?.groups.length, screen.band?.groups[0]?.cells.at(-1)],
    [1, ["Total", "0"]],
  );

  /* ---------------------------------------------------------------- */
  step("A host recording minutes only: the driver caption");

  from = await open(minute, "?range=60s");
  screen = await overviewUntil(
    "the driver caption on each analytics section",
    (one) => Object.keys(captions(one)).length === 3,
  );
  checkEqual('reason "driver" on Jobs, Runners and Workers', captions(screen), {
    Jobs: "driver",
    Runners: "driver",
    Workers: "driver",
  });
  checkEqual(
    "worded for what the backend can record",
    [
      ...new Set(
        Object.values(screen.cards)
          .map((card) => card.caption?.text)
          .filter(Boolean),
      ),
    ],
    [DRIVER_CAPTION],
  );
  const minuteRead = sent(minute, from, "/analytics/jobs")[0]!;
  const minuteAnswer = await replay<{
    range: { resolution: number; reason: string };
  }>(minute, minuteRead);
  checkEqual(
    "the page asked for resolution 1; the host answered 60 with reason driver",
    [
      minuteRead.query.get("resolution"),
      minuteAnswer.body.range.resolution,
      minuteAnswer.body.range.reason,
    ],
    ["1", 60, "driver"],
  );

  /* ---------------------------------------------------------------- */
  step(`A fleet: ${FLEET_KEYS} worker keys and ${FLEET_RUNNERS} runners`);

  from = await open(fleet);
  screen = await overviewUntil(
    "both sections to draw a page and its note",
    (one) =>
      one.cards.Workers?.truncated !== null &&
      one.cards.Runners?.truncated !== null &&
      settled(one, "Workers", 1) &&
      settled(one, "Runners", 2),
  );
  checkEqual(
    "the Workers note: the 100 busiest of every key",
    screen.cards.Workers?.truncated,
    `Showing the ${MAX_ROWS} busiest worker keys of ${FLEET_KEYS}, ranked by jobs completed in this range.`,
  );
  checkEqual(
    "the Runners note: the 100 busiest of every runner",
    screen.cards.Runners?.truncated,
    `Showing the ${MAX_ROWS} busiest runners of ${FLEET_RUNNERS}, ranked by runs started in this range.`,
  );
  checkEqual(
    `one page of ${MAX_SERIES} on screen, busiest first; "Worker keys" counts all ${FLEET_KEYS}`,
    [
      screen.cards.Workers!.rows.length,
      screen.cards.Workers!.rows[0]?.cells.slice(0, 3),
      screen.cards.Workers!.figures["Worker keys"],
      screen.cards.Runners!.rows.length,
      screen.cards.Runners!.rows[0]?.cells.slice(0, 2),
    ],
    [
      MAX_SERIES,
      [fleetKey(FLEET_KEYS - 1), "bulk", String(FLEET_KEYS)],
      String(FLEET_KEYS),
      MAX_SERIES,
      [fleetRunner(FLEET_RUNNERS - 1), String(FLEET_RUNNERS)],
    ],
  );
  const fleetWorkers = split(sent(fleet, from, "/analytics/workers"));
  const fleetRunners = split(sent(fleet, from, "/analytics/runners"));
  checkEqual(
    "still two requests per section: a roll-up, and one batch naming exactly the rows on screen",
    [
      fleetWorkers.rollups.length,
      fleetWorkers.batches.map((one) => one.query.getAll("keys")),
      fleetRunners.rollups.length,
      fleetRunners.batches.map((one) => one.query.getAll("ids")),
    ],
    [
      1,
      [screen.cards.Workers!.rows.map((row) => row.id)],
      1,
      [screen.cards.Runners!.rows.map((row) => row.id)],
    ],
  );

  /* ---------------------------------------------------------------- */
  step("A row opens what it names: the worker, its queue, the runner");

  /** The row of `card` naming `id`, or a failure naming the rows there were. */
  function rowOf(
    one: OverviewView,
    card: "Runners" | "Workers",
    id: string,
  ): RowView {
    const found = one.cards[card]?.rows.find((row) => row.id === id);
    if (found === undefined) {
      throw new Error(
        `no ${card} row for ${id}; rows: ${JSON.stringify(one.cards[card]?.rows.map((row) => row.id) ?? null)}`,
      );
    }
    return found;
  }

  await open(main);
  screen = await overviewUntil("every section to draw", mainSettled);
  // Read back what the links point at, through the routes the screens they
  // open use: the key is live on its queue, the queue is listed, the runner is
  // registered. A link is only worth offering where the thing is there.
  const liveWorkers = await read<{ items: { queue: string; key: string }[] }>(
    main,
    `/workers?queue=${ORDERS}`,
  );
  const listedQueues = await read<{ items: { name: string }[] }>(
    main,
    "/queues",
  );
  const liveRunner = await read<{ id: string }>(main, `/runners/${RUNNER}`);
  checkEqual(
    "the API has the worker key on its queue, the queue in its list and the runner registered",
    [
      liveWorkers.body.items.map((one) => [one.queue, one.key]),
      listedQueues.body.items.some((one) => one.name === ORDERS),
      [liveRunner.status, liveRunner.body.id],
    ],
    [[[ORDERS, ORDERS_KEY]], true, [200, RUNNER]],
  );
  checkEqual(
    "the Workers row links its key to the worker page and its queue to the queue screen; the Runners row links its runner",
    [
      rowOf(screen, "Workers", ORDERS_KEY).cellHrefs.slice(0, 2),
      rowOf(screen, "Runners", RUNNER).cellHrefs.slice(0, 2),
    ],
    [
      [
        `${main.uiBase}/workers/${ORDERS}/${ORDERS_KEY}`,
        `${main.uiBase}/queues/${ORDERS}`,
      ],
      // Only the runner id links; the figures beside it are numbers.
      [`${main.uiBase}/runners/${RUNNER}`, null],
    ],
  );

  /**
   * Clicks `selector` on the Overview, waits for the app to land on `path`
   * and for `marker` to be on screen, and answers with `[href, landedAt,
   * heading]` — so a failure says which of the three did not happen.
   */
  async function follow(
    host: Host,
    selector: string,
    path: string,
    marker: string,
  ): Promise<[string | true | null, string | null, string | null]> {
    const href = await view.evaluate<string | true | null>(clickOn(selector));
    const landed = await view.evaluate<string | null>(
      at(`${host.uiBase}${path}`),
    );
    const heading = await view.evaluate<string | null>(
      textOf(`${marker} h1`, 10_000),
    );
    return [href, landed, heading];
  }

  checkEqual(
    "clicking the key lands on that worker's page",
    await follow(
      main,
      `[data-testid="worker-analytics-row-${ORDERS_KEY}"] th a`,
      `/workers/${ORDERS}/${ORDERS_KEY}`,
      '[data-testid="worker-screen"]',
    ),
    [
      `${main.uiBase}/workers/${ORDERS}/${ORDERS_KEY}`,
      `${main.uiBase}/workers/${ORDERS}/${ORDERS_KEY}`,
      `Worker ${ORDERS_KEY}`,
    ],
  );
  await open(main);
  await overviewUntil("the Workers section again", workersDrawn);
  checkEqual(
    "clicking the queue lands on the queue screen",
    await follow(
      main,
      `[data-testid="worker-analytics-row-${ORDERS_KEY}"] td a`,
      `/queues/${ORDERS}`,
      '[data-testid="queue-screen"]',
    ),
    [
      `${main.uiBase}/queues/${ORDERS}`,
      `${main.uiBase}/queues/${ORDERS}`,
      ORDERS,
    ],
  );
  await open(main);
  await overviewUntil("the Runners section again", runnersDrawn);
  checkEqual(
    "clicking the runner lands on its page",
    await follow(
      main,
      `[data-testid="runner-analytics-row-${RUNNER}"] th a`,
      `/runners/${RUNNER}`,
      '[data-testid="runner-screen"]',
    ),
    [
      `${main.uiBase}/runners/${RUNNER}`,
      `${main.uiBase}/runners/${RUNNER}`,
      RUNNER,
    ],
  );

  /* ---------------------------------------------------------------- */
  step("A name the app cannot route to stays plain text");

  /** The gated host's three links now: the key, its queue, the runner. */
  async function gatedLinks(): Promise<(string | null)[]> {
    await open(gated);
    const one = await overviewUntil(
      "the gated host's sections",
      (drawn) =>
        (drawn.cards.Workers?.rows.length ?? 0) > 0 &&
        (drawn.cards.Runners?.rows.length ?? 0) > 0,
    );
    return [
      rowOf(one, "Workers", ORDERS_KEY).cellHrefs[0] ?? null,
      rowOf(one, "Workers", ORDERS_KEY).cellHrefs[1] ?? null,
      rowOf(one, "Runners", RUNNER).cellHrefs[0] ?? null,
    ];
  }

  refusedUntargeted.clear();
  checkEqual(
    "granted everything, the gated host links all three",
    await gatedLinks(),
    [
      `${gated.uiBase}/workers/${ORDERS}/${ORDERS_KEY}`,
      `${gated.uiBase}/queues/${ORDERS}`,
      `${gated.uiBase}/runners/${RUNNER}`,
    ],
  );

  /**
   * Whether `action` is allowed on the gated host untargeted, and when the
   * map is asked about one target (`target` is the query `/meta/permissions`
   * takes: `queue=orders` or `runner=nightly`). Read from the API, not
   * inferred from `refusedUntargeted`, so the host's own answer is the
   * witness for what the page then draws.
   */
  async function grants(
    action: string,
    target: string,
  ): Promise<[untargeted: unknown, onTarget: unknown]> {
    /** What `GET /meta/permissions` answers: the actions, each true or false. */
    interface PermissionsBody {
      /** Every routed action, by name. */
      actions: Record<string, boolean>;
    }
    const untargeted = await read<PermissionsBody>(gated, "/meta/permissions");
    const onTarget = await read<PermissionsBody>(
      gated,
      `/meta/permissions?${target}`,
    );
    return [untargeted.body.actions[action], onTarget.body.actions[action]];
  }

  // The section spans queues, so it reads the untargeted map — the one the nav
  // is built from, and the nav is what registers `/workers/:queue/:key`. A
  // per-queue grant would make the link point at a route this caller has not
  // got, so every row's key is plain text, this one included.
  refusedUntargeted.clear();
  refusedUntargeted.add("workers.list");
  checkEqual(
    "`workers.list` per queue only: the key is plain text on every row, and the queue link survives",
    [await grants("workers.list", `queue=${ORDERS}`), await gatedLinks()],
    [
      [false, true],
      [
        null,
        `${gated.uiBase}/queues/${ORDERS}`,
        `${gated.uiBase}/runners/${RUNNER}`,
      ],
    ],
  );

  refusedUntargeted.clear();
  refusedUntargeted.add("queues.list");
  checkEqual(
    "`queues.list` per queue only: the queue is plain text, and the key still links",
    [await grants("queues.list", `queue=${ORDERS}`), await gatedLinks()],
    [
      [false, true],
      [
        `${gated.uiBase}/workers/${ORDERS}/${ORDERS_KEY}`,
        null,
        `${gated.uiBase}/runners/${RUNNER}`,
      ],
    ],
  );

  refusedUntargeted.clear();
  refusedUntargeted.add("runners.list");
  checkEqual(
    "`runners.list` per runner only: the runner is plain text, and the Workers row keeps both links",
    [await grants("runners.list", `runner=${RUNNER}`), await gatedLinks()],
    [
      [false, true],
      [
        `${gated.uiBase}/workers/${ORDERS}/${ORDERS_KEY}`,
        `${gated.uiBase}/queues/${ORDERS}`,
        null,
      ],
    ],
  );
  refusedUntargeted.clear();

  /* ---------------------------------------------------------------- */
  step("A row may name what the API no longer reaches");

  // The rows answer "who did the work in this window", so a runner that is no
  // longer registered and a key that is no longer live keep theirs — which is
  // exactly the fleet host's shape: counts in range, and nothing registered or
  // live behind them. The link is still offered, and lands on that screen's
  // own answer rather than a dead end.
  const goneRunner = fleetRunner(FLEET_RUNNERS - 1);
  const goneKey = fleetKey(FLEET_KEYS - 1);
  const missingRunner = await read<{ code?: string }>(
    fleet,
    `/runners/${goneRunner}`,
  );
  const noInstance = await read<{ items: unknown[] }>(
    fleet,
    `/workers?queue=bulk&key=${goneKey}`,
  );
  checkEqual(
    "the API does not reach the row's runner (404) and lists no worker for its key",
    [
      missingRunner.status,
      missingRunner.body.code,
      noInstance.body.items.length,
    ],
    [404, "RUNNER_NOT_FOUND", 0],
  );
  await open(fleet);
  screen = await overviewUntil(
    "the fleet's busiest rows",
    (one) => settled(one, "Runners", 2) && settled(one, "Workers", 1),
  );
  checkEqual(
    "both rows link all the same",
    [
      rowOf(screen, "Runners", goneRunner).cellHrefs[0],
      rowOf(screen, "Workers", goneKey).cellHrefs[0],
    ],
    [
      `${fleet.uiBase}/runners/${goneRunner}`,
      `${fleet.uiBase}/workers/bulk/${goneKey}`,
    ],
  );
  checkEqual(
    'clicking the runner lands on the runner screen\'s own "Runner not found"',
    await follow(
      fleet,
      `[data-testid="runner-analytics-row-${goneRunner}"] th a`,
      `/runners/${goneRunner}`,
      '[data-testid="runner-not-found"]',
    ),
    [
      `${fleet.uiBase}/runners/${goneRunner}`,
      `${fleet.uiBase}/runners/${goneRunner}`,
      "Runner not found",
    ],
  );
  checkEqual(
    "and the explanation names the runner, offering the list rather than nothing",
    await view.evaluate<string | null>(
      textOf(
        '[data-testid="runner-not-found"] .empty-state-description',
        10_000,
      ),
    ),
    `There is no runner ${goneRunner} in this namespace. It may have been unregistered, or its process has not started yet.`,
  );
  await open(fleet);
  await overviewUntil("the fleet's Workers rows again", workersDrawn);
  checkEqual(
    'clicking the key lands on its worker page, which says "No live instance"',
    await follow(
      fleet,
      `[data-testid="worker-analytics-row-${goneKey}"] th a`,
      `/workers/bulk/${goneKey}`,
      '[data-testid="worker-screen"]',
    ),
    [
      `${fleet.uiBase}/workers/bulk/${goneKey}`,
      `${fleet.uiBase}/workers/bulk/${goneKey}`,
      `Worker ${goneKey}`,
    ],
  );
  checkEqual(
    "its Instances card says so, and the numbers the row came from are still there",
    await view.evaluate<string | null>(
      textOf('[data-testid="worker-instances"] .empty-state-title', 10_000),
    ),
    "No live instance",
  );

  /* ---------------------------------------------------------------- */
  step("A host with no analytics");

  const meta = await read<{
    analytics?: unknown;
    features: { addedByState: boolean };
  }>(bare, "/meta");
  checkEqual(
    "GET /meta → analytics null, addedByState still on",
    [meta.body.analytics ?? null, meta.body.features.addedByState],
    [null, true],
  );
  from = await open(bare);
  screen = await overviewUntil(
    "the counts, the queues and the added group",
    (one) =>
      (one.cards.Queues?.headers.length ?? 0) > 0 &&
      one.band?.groups[0]?.cells.length === ADDED.length,
  );
  checkEqual(
    "the cards are Jobs and Queues: no Runners, no Workers section",
    Object.keys(screen.cards),
    ["Jobs", "Queues"],
  );
  check(
    "the Queues table has no Throughput column",
    !screen.cards.Queues!.headers.includes("Throughput"),
    screen.cards.Queues!.headers,
  );
  checkEqual(
    "the band keeps the added group alone, with no resolution to name",
    [
      screen.band?.head,
      screen.band?.groups.map((group) => group.title),
      screen.band?.groups[0]?.cells.at(-1),
    ],
    [
      "Over the range",
      ["Added in range, where they are now (still stored)"],
      ["Total", "2"],
    ],
  );
  checkEqual(
    "the host saw no analytics request at all",
    bare.seen
      .slice(from)
      .filter((one) => one.path.includes("/analytics"))
      .map((one) => one.url),
    [],
  );
  check(
    'and no "last 60 minutes" figure stands in for it',
    !/last 60 minutes/i.test(screen.text) &&
      !screen.totals.some((label) => /throughput|minutes/i.test(label)) &&
      bare.seen.slice(from).every((one) => !one.query.has("minutes")),
    screen.totals,
  );

  from = await open(bareNoAdded);
  screen = await overviewUntil(
    "the counts and the queues",
    (one) =>
      (one.cards.Queues?.headers.length ?? 0) > 0 &&
      sent(bareNoAdded, from, "/overview").length > 0,
  );
  checkEqual(
    "without addedByState too: no band, and neither /overview/added nor analytics read",
    [
      screen.band,
      bareNoAdded.seen
        .slice(from)
        .filter(
          (one) =>
            one.path.includes("/analytics") || one.path === "/overview/added",
        )
        .map((one) => one.url),
    ],
    [null, []],
  );
} catch (error) {
  console.log(`page console:\n${pageConsole.join("\n")}`);
  throw error;
} finally {
  await shutdown(view);
}

summary();
