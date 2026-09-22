/**
 * The Workers screens in a real browser, against a real `createJobsApi` over
 * real `BunQueueWorker`s in two services and two processes: the `/workers`
 * page grouped by service then host and pid, its server-side filters and its
 * search, every row control (Pause, Resume, Stop… with and without the
 * persistence choice, Start, Settings…), a refusal the worker's own state
 * caused (`WORKER_STATE_CONFLICT`), the worker page `/workers/:queue/:key`
 * (instances, configuration, Edit settings…, Reset for a key with no live
 * instance, throughput and busyness over `?range=`, and the jobs whose last
 * attempt the key ran with every one of their URL filters), the links into
 * it from each worker row, the queue's Workers panel and "Processed by", and
 * two hosts that refuse worker actions: one that lets a caller list workers
 * but change nothing (and hides hosts), and one that refuses `workers.*`
 * altogether. Every action is read back from the API or the worker object,
 * not from the page.
 *
 * ```bash
 * bun 06-browser/workers.ts
 * BUN_CHROME_PATH=/opt/chrome/chrome bun 06-browser/workers.ts
 * EXAMPLE_BROWSER=0 bun 06-browser/workers.ts   # skip on purpose
 * ```
 *
 * It drives headless Chrome through `Bun.WebView`, like the other examples in
 * this folder, and **skips** (prints `skipped:` and exits 0) when this Bun has
 * no `Bun.WebView`, when no Chrome is found, or when Chrome will not start.
 *
 * Worth knowing:
 *
 * - **Two processes, so two servers.** The Workers page groups by `service`,
 *   then by host and pid. This process runs services `api` and `mailer`; a
 *   child process (`helpers/mailer-replica.ts`) runs a second `mailer`, on
 *   the same file-driver directory, with the same stable key
 *   `mailer.emails.send`. So the mailer card has two server sections, and the
 *   key's worker page two live instances — and a Settings… saved once
 *   reaches both.
 * - **A key, not an id.** Lifecycle actions target one incarnation (its `id`,
 *   new on every restart); settings target the stable `key`, which every
 *   replica shares. A worker page is addressed by queue and key.
 * - **Hooks to drive the screens by:** `data-testid` `workers-list`,
 *   `worker-filters`, `workers-count`, `worker-service-<service>`,
 *   `worker-server-<host:pid>`, `worker-row-<id>`, `worker-key-link-<id>`,
 *   `worker-blocked-<id>`, `worker-screen`, `worker-instances`,
 *   `worker-config`, `worker-setting-<setting>`, `worker-config-offline`,
 *   `worker-config-stored`, `worker-config-none-stored`, `worker-analytics`,
 *   `worker-jobs`, `worker-jobs-range`, `worker-jobs-no-range`,
 *   `jobs-processed-by-key` and `job-processed-by-key`. A worker's buttons are
 *   in `[role="group"][aria-label="Actions for worker <id>"]`.
 * - **The refusal needs a view older than the worker.** The row offers only
 *   what the worker's state takes, so a 409 happens to a real user only when
 *   somebody else changed the worker after the page last read it. This host
 *   reproduces that honestly: it holds the page's worker reads (as a slow
 *   network would) while another caller stops the worker, so the row still
 *   offers Resume when it is clicked.
 * - **Wait on conditions, never on time.** Every page-side helper polls the
 *   DOM with a deadline, and every API check polls the API.
 */
import type { JobsApiAuthorize, WorkerDto } from "@kingsleyweb/bun-jobs";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_ACTIONS,
} from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
import {
  button,
  chromeOrSkip,
  openView,
  textOf,
  waitForSelector,
} from "../shared/browser";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import {
  at,
  buttonsIn,
  choose,
  clickOn,
  optionsOf,
  poll,
  textsWhen,
  toast,
  typeInto,
} from "./helpers/page";

// Decide whether to skip before printing anything: run-all.ts recognises a
// skip by the output *starting* with `skipped:`.
const chromePath = chromeOrSkip();

/** The namespace every context, process and API here shares. */
const NAMESPACE = "examples-ui-workers";
/** Where the file driver keeps it: shared with the child process, removed on exit. */
const ROOT = mkdtempSync(join(tmpdir(), "bun-jobs-ui-example-workers-"));
process.once("exit", () => rmSync(ROOT, { recursive: true, force: true }));

/** The stable keys, as `[service.]queue[.name]` derives them. */
const KEY = {
  /** `api`'s worker on `emails`, named `send`: it lets a stop's persistence be chosen. */
  apiEmails: "api.emails.send",
  /** `api`'s worker on `reports`: its stops are the deployment's `process` kind. */
  reports: "api.reports",
  /** `api`'s worker on `exports`, which holds one job until released. */
  exports: "api.exports",
  /** A key no live worker carries, with an override stored for it. */
  digests: "api.digests",
  /** `mailer`'s worker on `emails`, run by this process and by the replica. */
  mailer: "mailer.emails.send",
} as const;

/** What a job asks its worker to do. */
interface JobData {
  /** Throw: with one attempt, the job is buried. */
  fail?: boolean;
  /** Stay active until {@link releaseHeld} is called. */
  hold?: boolean;
}

/** Releases the held export job. */
let releaseHeld: () => void = () => undefined;
/** Settles once {@link releaseHeld} is called. */
const held = new Promise<void>((resolve) => {
  releaseHeld = resolve;
});

/** The work every worker here does: fail, hold, or succeed. */
async function handle(job: { data: JobData | undefined }): Promise<string> {
  if (job.data?.hold) {
    await held;
  }
  if (job.data?.fail) {
    throw new Error("asked to fail");
  }
  return "ok";
}

/** Options every worker here shares: quick to report, quick to claim. */
const WORKER_OPTIONS = {
  reportInterval: 500,
  pollInterval: 20,
  waitToExit: false,
  logger: noopLogger,
} as const;

/* --- the contexts and their workers -------------------------------- */

const apiJobs = new BunJobs({
  namespace: NAMESPACE,
  service: "api",
  driver: { type: "file", root: ROOT },
  logger: noopLogger,
});
const mailerJobs = new BunJobs({
  namespace: NAMESPACE,
  service: "mailer",
  driver: { type: "file", root: ROOT },
  logger: noopLogger,
});

const apiEmails = apiJobs.worker<JobData, string>("emails", handle, {
  ...WORKER_OPTIONS,
  name: "send",
  concurrency: 2,
  // Offers the Stop… dialog's "How long it stays stopped" choice.
  stopPersistenceOverridable: true,
});
const reports = apiJobs.worker<JobData, string>("reports", handle, {
  ...WORKER_OPTIONS,
});
const exportsWorker = apiJobs.worker<JobData, string>("exports", handle, {
  ...WORKER_OPTIONS,
});

/* --- the hosts: one that allows everything, two that refuse -------- */

/** A host: an API and the UI on an adapter of their own. */
interface Host {
  /** Its origin, e.g. `http://localhost:41234`. */
  origin: string;
  /** The UI's base path. */
  ui: string;
  /** The API's base path. */
  api: string;
  /** Stops it. */
  close: () => Promise<void>;
}

/** Every request the main host's API received, as `METHOD /path?query`. */
const requests: string[] = [];

/**
 * While set, the main host holds every worker read the page sends until it
 * settles — a slow network, as far as the page can tell. Only
 * {@link step} "A refusal the worker's state caused" sets it.
 */
let workerReadGate: PromiseWithResolvers<void> | null = null;

/** Whether `url` is a worker listing: `GET /workers` or a queue's workers. */
function isWorkerRead(url: string): boolean {
  const path = url.split("?")[0]!;
  return /^\/jobs-api\/(?:workers|queues\/[^/]+\/workers)$/.test(path);
}

/** Serves an API over the `api` context and the UI on port 0. */
async function serveHost(options: {
  /** Who may do what. */
  authorize: JobsApiAuthorize;
  /** Whether worker hosts and pids are shown. Defaults to `true`. */
  exposeHosts?: boolean;
  /** Offer the opt-in `workers.configure`. */
  configure?: boolean;
  /** Record requests and honour {@link workerReadGate} (the main host). */
  observe?: boolean;
}): Promise<Host> {
  const api = createJobsApi({
    jobs: apiJobs,
    basePath: "/jobs-api",
    mode: "jobs",
    authorize: options.authorize,
    // `workers.configure` is opt-in: the default list leaves it out.
    ...(options.configure ? { actions: [...JOBS_API_ACTIONS] } : {}),
    ...(options.exposeHosts === false
      ? { serialize: { exposeHosts: false } }
      : {}),
    csrf: { header: "x-bun-jobs-csrf" },
    logger: noopLogger,
  });
  const ui = jobsUi({ api, logger: noopLogger });
  const app = new BunHttpAdapter(0, { logger: noopLogger });
  if (options.observe) {
    // Ahead of the API, so it sees every request whatever the API answers.
    app.use(async (req, _res, next) => {
      if (req.originalUrl.startsWith(api.basePath)) {
        requests.push(`${req.method} ${req.originalUrl}`);
        if (
          workerReadGate !== null &&
          req.method === "GET" &&
          isWorkerRead(req.originalUrl)
        ) {
          await workerReadGate.promise;
        }
      }
      next();
    });
  }
  app.use(api.basePath, api.router);
  api.websocket?.attach(app);
  app.use(ui.basePath, ui.router);
  await app.listen(0);
  const origin = app.url!.replace(/\/$/, "");
  // Build the bundle before the browser asks.
  await (await fetch(`${origin}${ui.basePath}`)).arrayBuffer();
  return {
    origin,
    ui: ui.basePath,
    api: api.basePath,
    close: async () => {
      await app.close();
      await api.close();
    },
  };
}

/** Everything allowed, the opt-in `workers.configure` included. */
const main = await serveHost({
  authorize: () => true,
  configure: true,
  observe: true,
});
/**
 * Workers may be listed, never changed; hosts are hidden. On one queue,
 * `exports`, its workers may not be listed at all: asked with that queue
 * (`/meta/permissions?queue=exports`), `workers.list` is refused.
 */
const viewOnly = await serveHost({
  authorize: (_req, ctx) =>
    ctx.mutation && ctx.action.startsWith("workers.")
      ? { allow: false, reason: "workers are the on-call team's" }
      : ctx.action === "workers.list" && ctx.queue === "exports"
        ? { allow: false, reason: "exports' workers are private" }
        : true,
  exposeHosts: false,
});
/** Nothing about workers at all, `workers.list` included. */
const noWorkers = await serveHost({
  authorize: (_req, ctx) =>
    ctx.action.startsWith("workers.")
      ? { allow: false, reason: "no worker access" }
      : true,
});
const hosts = [main, viewOnly, noWorkers];

/** The child process running the second mailer. */
let replica: Subprocess<"pipe", "pipe", "inherit"> | undefined;

/** Winds everything down; safe to call more than once. */
async function shutdown(view?: Bun.WebView): Promise<void> {
  releaseHeld();
  workerReadGate?.resolve();
  view?.close();
  for (const host of hosts) {
    await host.close();
  }
  if (replica !== undefined) {
    replica.stdin.end();
    await replica.exited;
  }
  await mailerJobs.close();
  await apiJobs.close();
}

/* --- API reads and writes, bypassing the page ---------------------- */

/** A JSON read from `host`'s API. */
async function read<T>(path: string, host: Host = main): Promise<T> {
  const response = await fetch(`${host.origin}${host.api}${path}`);
  return (await response.json()) as T;
}

/** A mutation on the main API, with its CSRF header; answers status and body. */
async function send(
  method: string,
  path: string,
  body: unknown = {},
): Promise<{ status: number; json: { code?: string } }> {
  const response = await fetch(`${main.origin}${main.api}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-bun-jobs-csrf": "1",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as { code?: string },
  };
}

/** Every live worker `GET /workers` reports. */
async function listed(query = ""): Promise<WorkerDto[]> {
  return (await read<{ items: WorkerDto[] }>(`/workers${query}`)).items;
}

/** One worker's record, by incarnation id. */
async function record(id: string): Promise<WorkerDto | undefined> {
  return (await listed()).find((worker) => worker.id === id);
}

/** Resolves once worker `id` reports `state` through the API. */
async function awaitState(id: string, state: string): Promise<void> {
  await waitFor(`the API to report ${id} ${state}`, async () => {
    return (await record(id))?.state === state;
  });
}

/** How many requests had arrived, to look only at what comes after. */
function mark(): number {
  return requests.length;
}

/** Resolves with the first request since `from` matching `pattern`. */
async function requestSince(from: number, pattern: RegExp): Promise<string> {
  let found: string | undefined;
  await waitFor(`the page to send a request matching ${pattern}`, () => {
    found = requests.slice(from).find((line) => pattern.test(line));
    return found !== undefined;
  });
  return found!;
}

/** The ids of the jobs listed for `path` on the main API. */
async function jobIds(path: string): Promise<string[]> {
  return (await read<{ items: { id: string }[] }>(path)).items.map(
    (job) => job.id,
  );
}

/* --- the work: jobs attributed to two keys -------------------------- */

/** Adds `id` to `queue` and waits until it has finished (or is active, with `hold`). */
async function run(
  jobs: BunJobs,
  queue: string,
  name: string,
  id: string,
  data: JobData = {},
): Promise<void> {
  await jobs.queue<JobData>(queue).add(name, data, { jobId: id, attempts: 1 });
  const done = data.hold ? ["active"] : ["completed", "dead"];
  await waitFor(`${id} to be ${done.join(" or ")}`, async () => {
    const state = (await jobs.queue(queue).getJob(id))?.state;
    return state !== undefined && done.includes(state);
  });
}

void apiEmails.run();
void reports.run();
void exportsWorker.run();

// Only api.emails.send consumes emails yet, so these four are its own.
await run(apiJobs, "emails", "welcome", "done-1");
await run(apiJobs, "emails", "welcome", "done-2");
await run(apiJobs, "emails", "digest", "done-3");
await run(apiJobs, "emails", "welcome", "dead-1", { fail: true });
// Paused in code: it claims nothing more, and the page offers Resume.
await apiEmails.pause();

// Now the mailer's two instances take over the queue.
const mailerEmails = mailerJobs.worker<JobData, string>("emails", handle, {
  ...WORKER_OPTIONS,
  name: "send",
  concurrency: 1,
});
void mailerEmails.run();
replica = Bun.spawn({
  cmd: [
    process.execPath,
    new URL("./helpers/mailer-replica.ts", import.meta.url).pathname,
    ROOT,
    NAMESPACE,
  ],
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
});
/** The replica's worker id, from its `ready <id>` line. */
const replicaId = await (async () => {
  const reader = replica.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error(`the mailer replica ended before it was ready: ${text}`);
    }
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return /ready (\S+)/.exec(text)![1]!;
})();
await waitFor(
  "the replica to register",
  async () => (await record(replicaId)) !== undefined,
);
for (const id of ["m-1", "m-2", "m-3"]) {
  await run(mailerJobs, "emails", "notify", id);
}

// One export held active, so its worker can be caught between states.
await run(apiJobs, "exports", "export", "export-held", { hold: true });

// A key with an override stored and no live worker: a worker on digests
// registers the queue, the override is written, the worker goes.
const digests = apiJobs.worker<JobData, string>("digests", handle, {
  ...WORKER_OPTIONS,
});
void digests.run();
await waitFor(
  "digests' worker to register",
  async () => (await record(digests.id)) !== undefined,
);
await apiJobs.workers.remote("digests").setConfig(KEY.digests, {
  concurrency: 4,
});
await digests.close();

/** Every live worker, by what this example calls it. */
const ids = {
  apiEmails: apiEmails.id,
  reports: reports.id,
  exports: exportsWorker.id,
  mailer: mailerEmails.id,
  replica: replicaId,
};

/* --- the browser: skip, not fail, if Chrome will not start --------- */

/** What the page printed to its console, for a failure's diagnosis. */
const pageConsole: string[] = [];
const view = await openView(chromePath, pageConsole, shutdown);

title("The Workers screens, in Chrome");
show("Chrome", chromePath);
show("serving", `${main.origin}${main.ui}`);
show("workers", ids);

/** Opens `path` under `host`'s UI. */
async function open(path: string, host: Host = main): Promise<void> {
  await view.navigate(`${host.origin}${host.ui}${path}`);
}

/** A worker's action group. */
function actions(id: string): string {
  return `[role="group"][aria-label="Actions for worker ${id}"]`;
}

/** Page-side: every worker row on the page, as `[id, { header: cell text }]`. */
const WORKER_ROWS = `[...document.querySelectorAll('tr[data-testid^="worker-row-"]')].map((row) => {
  const headers = [...row.closest("table").querySelectorAll("thead th")].map((th) => th.textContent.trim());
  const cells = [...row.children].map((cell) => cell.textContent.trim());
  return [row.dataset.testid.slice("worker-row-".length), Object.fromEntries(headers.map((header, index) => [header, cells[index]]))];
})`;

/** Page-side: the worker row ids, sorted, once exactly `expected` are shown. */
function rowsAre(expected: string[]): string {
  return poll(`(() => {
    const shown = [...document.querySelectorAll('tr[data-testid^="worker-row-"]')]
      .map((row) => row.dataset.testid.slice("worker-row-".length)).sort();
    return JSON.stringify(shown) === ${JSON.stringify(JSON.stringify([...expected].sort()))} ? shown : null;
  })()`);
}

/** Page-side: the rows shown now, sorted (for a failure's detail). */
const ROW_IDS = `[...document.querySelectorAll('tr[data-testid^="worker-row-"]')].map((row) => row.dataset.testid.slice("worker-row-".length)).sort()`;

/**
 * Page-side: the grouping — `[service, [[server title, row ids]]]` — with
 * services and servers sorted, so it compares with the API's own listing.
 */
const GROUPING = `[...document.querySelectorAll('[data-testid^="worker-service-"]')].map((service) => [
  service.dataset.testid.slice("worker-service-".length),
  [...service.querySelectorAll('[data-testid^="worker-server-"]')].map((server) => {
    const heading = server.querySelector("h3");
    return [
      heading.textContent.replace(heading.querySelector("span").textContent, "").trim(),
      [...server.querySelectorAll('tr[data-testid^="worker-row-"]')].map((row) => row.dataset.testid.slice("worker-row-".length)).sort(),
    ];
  }).sort(),
]).sort()`;

/** The grouping the page should show for `workers`: by service, then host and pid. */
function groupingOf(workers: WorkerDto[]): [string, [string, string[]][]][] {
  const services = new Map<string, Map<string, string[]>>();
  for (const worker of workers) {
    const service = worker.service ?? "none";
    const server =
      worker.host === undefined && worker.pid === undefined
        ? "Hosts hidden by the API"
        : `${worker.host} · pid ${worker.pid}`;
    const servers = services.get(service) ?? new Map<string, string[]>();
    servers.set(server, [...(servers.get(server) ?? []), worker.id]);
    services.set(service, servers);
  }
  return [...services]
    .map(([service, servers]): [string, [string, string[]][]] => [
      service,
      [...servers]
        .map(([server, list]): [string, string[]] => [server, list.sort()])
        .sort(),
    ])
    .sort();
}

/** Page-side: the job row ids in `scope`, in order, once `ready(ids)` holds. */
function jobRows(scope: string, ready = "true"): string {
  return poll(`(() => {
    const root = document.querySelector(${JSON.stringify(scope)});
    if (!root || root.querySelector('[aria-busy="true"], .spinner')) return null;
    const ids = [...root.querySelectorAll('tr[data-testid^="job-row-"]')].map((row) => row.dataset.testid.slice("job-row-".length));
    const empty = !!root.querySelector('[data-testid="worker-jobs-empty"]');
    if (ids.length === 0 && !empty) return null;
    return (${ready}) ? ids : null;
  })()`);
}

/** Page-side: every CSP violation so far, buffered ones included. */
const COLLECT_VIOLATIONS = `new Promise((resolve) => {
  const observer = new ReportingObserver(() => {}, { types: ["csp-violation"], buffered: true });
  observer.observe();
  setTimeout(() => {
    const seen = observer.takeRecords().map((report) => String(report.body.effectiveDirective));
    observer.disconnect();
    resolve(seen);
  }, 50);
})`;

/** The server heading for this process. */
const HERE = `${hostname()} · pid ${process.pid}`;

try {
  /* ---------------------------------------------------------------- */
  step("/workers: grouped by service, then host and pid");

  await open("/workers");
  check(
    "the page renders (data-testid=workers-list)",
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="workers-list"]'),
    ),
    pageConsole,
  );
  const every = await listed();
  checkEqual(
    "GET /workers lists the five live workers (digests' went; its override stays)",
    every.map((worker) => worker.id).sort(),
    Object.values(ids).sort(),
  );
  checkEqual(
    "the stable keys are the derived ones",
    Object.fromEntries(every.map((worker) => [worker.id, worker.key])),
    {
      [ids.apiEmails]: KEY.apiEmails,
      [ids.reports]: KEY.reports,
      [ids.exports]: KEY.exports,
      [ids.mailer]: KEY.mailer,
      [ids.replica]: KEY.mailer,
    },
  );
  await view.evaluate(rowsAre(Object.values(ids)));
  const grouping = groupingOf(every);
  show("grouping", grouping);
  checkEqual(
    "one card per service, one section per host:pid — mailer's two processes are two servers",
    await view.evaluate<unknown>(GROUPING),
    grouping,
  );
  check(
    "api on this process alone; mailer on this one and the replica's",
    grouping.length === 2 &&
      grouping[0]![1].length === 1 &&
      grouping[0]![1][0]![0] === HERE &&
      grouping[1]![1].length === 2,
    grouping,
  );
  checkEqual(
    "the count names workers and servers",
    await view.evaluate<string | null>(textOf('[data-testid="workers-count"]')),
    "5 workers on 3 servers",
  );
  const rows = Object.fromEntries(
    await view.evaluate<[string, Record<string, string>][]>(WORKER_ROWS),
  );
  const apiRecord = every.find((worker) => worker.id === ids.apiEmails)!;
  checkEqual(
    "api.emails.send's row: Paused, its Completed and Failed as the API counts them",
    [
      rows[ids.apiEmails]?.State,
      rows[ids.apiEmails]?.Completed,
      rows[ids.apiEmails]?.Failed,
    ],
    ["Paused", String(apiRecord.completed), String(apiRecord.failed)],
  );
  checkEqual(
    "which are its own work: 3 completed, 1 failed attempt",
    [apiRecord.completed, apiRecord.failed],
    [3, 1],
  );
  checkEqual(
    "each row links its key to the worker page; both mailer instances to the same one",
    await view.evaluate<(string | null)[]>(
      `${JSON.stringify(Object.values(ids))}.map((id) => document.querySelector(\`[data-testid="worker-key-link-\${id}"]\`)?.getAttribute("href") ?? null)`,
    ),
    [
      `${main.ui}/workers/emails/${KEY.apiEmails}`,
      `${main.ui}/workers/reports/${KEY.reports}`,
      `${main.ui}/workers/exports/${KEY.exports}`,
      `${main.ui}/workers/emails/${KEY.mailer}`,
      `${main.ui}/workers/emails/${KEY.mailer}`,
    ],
  );
  checkEqual(
    "and each queue to its queue screen",
    await view.evaluate<string[]>(
      `[...document.querySelectorAll('[data-testid="workers-list"] td a[href*="/queues/"]')].map((link) => link.getAttribute("href")).sort()`,
    ),
    [
      `${main.ui}/queues/emails`,
      `${main.ui}/queues/emails`,
      `${main.ui}/queues/emails`,
      `${main.ui}/queues/exports`,
      `${main.ui}/queues/reports`,
    ],
  );

  /* ---------------------------------------------------------------- */
  step("Server-side filters: ?queue= ?service= ?host= ?state=");

  const FILTERS = '[data-testid="worker-filters"]';
  checkEqual(
    "the Queue filter offers the queues the unfiltered list has",
    await view.evaluate<[string, string][]>(optionsOf(FILTERS, "Queue")),
    [
      ["", "Any queue"],
      ["emails", "emails"],
      ["exports", "exports"],
      ["reports", "reports"],
    ],
  );
  let since = mark();
  check(
    "choosing emails in it",
    (await view.evaluate<boolean | null>(
      choose(FILTERS, "Queue", "emails"),
    )) === true,
  );
  checkEqual(
    "puts ?queue=emails in the URL",
    await view
      .evaluate<string | null>(at(`${main.ui}/workers`))
      .then(() => view.evaluate<string>("location.search")),
    "?queue=emails",
  );
  show(
    "sent",
    await requestSince(since, /^GET \/jobs-api\/workers\?queue=emails$/),
  );
  const emailsIds = (await listed("?queue=emails")).map((worker) => worker.id);
  checkEqual(
    "and lists exactly what GET /workers?queue=emails answers",
    await view.evaluate<string[] | null>(rowsAre(emailsIds)),
    [ids.apiEmails, ids.mailer, ids.replica].sort(),
  );

  since = mark();
  await open("/workers?service=mailer");
  show(
    "sent",
    await requestSince(since, /^GET \/jobs-api\/workers\?service=mailer$/),
  );
  await view.evaluate(rowsAre([ids.mailer, ids.replica]));
  checkEqual(
    "?service=mailer: one card, two servers",
    await view.evaluate<unknown>(GROUPING),
    groupingOf(await listed("?service=mailer")),
  );

  checkEqual(
    "the Host filter is offered, since this API exposes hosts",
    await view.evaluate<[string, string][]>(optionsOf(FILTERS, "Host")),
    [
      ["", "Any host"],
      [hostname(), hostname()],
    ],
  );
  since = mark();
  await open(`/workers?host=${encodeURIComponent(hostname())}`);
  show("sent", await requestSince(since, /^GET \/jobs-api\/workers\?host=/));
  checkEqual(
    "?host=<this host>: every worker",
    await view.evaluate<string[] | null>(rowsAre(Object.values(ids))),
    Object.values(ids).sort(),
  );
  since = mark();
  await open("/workers?host=elsewhere.example");
  await requestSince(
    since,
    /^GET \/jobs-api\/workers\?host=elsewhere\.example$/,
  );
  checkEqual(
    "?host=elsewhere.example: the API answers none, and the page says the filters match nothing",
    [
      (await listed("?host=elsewhere.example")).length,
      await view.evaluate<string | null>(
        poll(
          `[...document.querySelectorAll(".empty-state, [class*=empty]")].map((element) => element.textContent).find((text) => text.includes("No workers match these filters")) ? "shown" : null`,
        ),
      ),
    ],
    [0, "shown"],
  );

  since = mark();
  await open("/workers?state=paused");
  await requestSince(since, /^GET \/jobs-api\/workers\?state=paused$/);
  checkEqual(
    "?state=paused: only api.emails.send, paused in code",
    await view.evaluate<string[] | null>(rowsAre([ids.apiEmails])),
    [ids.apiEmails],
  );

  since = mark();
  await open("/workers?search=reports");
  await view.evaluate(rowsAre([ids.reports]));
  checkEqual(
    "?search=reports narrows in the browser: no request carries it, and the count says of how many",
    [
      requests.slice(since).filter((line) => line.includes("search=")),
      await view.evaluate<string | null>(
        textOf('[data-testid="workers-count"]'),
      ),
    ],
    [[], "1 worker on 1 server (of 5)"],
  );
  check(
    "Clear filters is not offered for a search alone",
    !(await view.evaluate<boolean>(button(FILTERS, "Clear filters", false, 0))),
  );
  await open("/workers?queue=reports&state=running");
  check(
    "Clear filters, with filters set, clears them",
    await view.evaluate<boolean>(button(FILTERS, "Clear filters", true)),
  );
  checkEqual(
    "back to every worker, with nothing in the URL",
    [
      await view.evaluate<string[] | null>(rowsAre(Object.values(ids))),
      await view.evaluate<string>("location.search"),
    ],
    [Object.values(ids).sort(), ""],
  );

  /* ---------------------------------------------------------------- */
  step("Row controls: Resume, Pause, Stop… (choosing persistence), Start");

  await open("/workers");
  checkEqual(
    "api.emails.send, paused, offers Resume, Stop… and Settings…",
    await view.evaluate<unknown>(
      poll(
        `(${buttonsIn(actions(ids.apiEmails))}).length ? ${buttonsIn(actions(ids.apiEmails))} : null`,
      ),
    ),
    ["Resume", "Stop…", "Settings…"],
  );
  since = mark();
  check(
    "Resume",
    await view.evaluate<boolean>(
      button(actions(ids.apiEmails), "Resume", true),
    ),
  );
  show("sent", await requestSince(since, /^POST .*\/resume\?wait=2000$/));
  await awaitState(ids.apiEmails, "running");
  checkEqual(
    "resumed: the API and the worker object both say running",
    [(await record(ids.apiEmails))?.state, apiEmails.state],
    ["running", "running"],
  );
  show("toast", await view.evaluate(toast(`Resumed ${ids.apiEmails}`)));
  check(
    "Pause, now offered",
    await view.evaluate<boolean>(button(actions(ids.apiEmails), "Pause", true)),
  );
  await awaitState(ids.apiEmails, "paused");
  checkEqual("paused, as the worker says too", apiEmails.state, "paused");
  checkEqual(
    "a pause is immediate, so the toast says it is done",
    (
      await view.evaluate<[string, string] | null>(
        toast(`Paused ${ids.apiEmails}`),
      )
    )?.[0],
    `Paused ${ids.apiEmails}`,
  );
  check(
    "Resume again",
    await view.evaluate<boolean>(
      button(actions(ids.apiEmails), "Resume", true),
    ),
  );
  await awaitState(ids.apiEmails, "running");

  check(
    "Stop… opens the dialog",
    await view.evaluate<boolean>(button(actions(ids.apiEmails), "Stop…", true)),
  );
  checkEqual(
    "which offers how long it stays stopped (control.stopPersistenceOverridable)",
    await view.evaluate<[string, string][]>(
      optionsOf("dialog[open]", "How long it stays stopped"),
    ),
    [
      ["process", "Until this process restarts"],
      ["key", "Until somebody starts it again"],
    ],
  );
  await view.evaluate(
    choose("dialog[open]", "How long it stays stopped", "key"),
  );
  since = mark();
  check(
    "Stop worker",
    await view.evaluate<boolean>(button("dialog[open]", "Stop worker", true)),
  );
  show("sent", await requestSince(since, /^POST .*\/stop\?wait=2000$/));
  await awaitState(ids.apiEmails, "stopped");
  checkEqual(
    "stopped, and still listed — the worker object says stopped",
    apiEmails.state,
    "stopped",
  );
  checkEqual(
    "the toast says every replica stays stopped (the stop was kept against the key)",
    (
      await view.evaluate<[string, string] | null>(
        toast(`Stopped ${ids.apiEmails}`),
      )
    )?.[0],
    `Stopped ${ids.apiEmails}; every replica of it stays stopped until started`,
  );
  check(
    "Start, now offered",
    await view.evaluate<boolean>(button(actions(ids.apiEmails), "Start", true)),
  );
  await awaitState(ids.apiEmails, "running");
  checkEqual("started again", apiEmails.state, "running");

  step("Stop… where the deployment decides the persistence (api.reports)");
  check(
    "Stop… on api.reports",
    await view.evaluate<boolean>(button(actions(ids.reports), "Stop…", true)),
  );
  checkEqual(
    "states the deployment's choice instead of offering one",
    await view.evaluate<unknown>(
      poll(`document.querySelector("dialog[open]") ? [
        !!document.querySelector("dialog[open] select"),
        document.querySelector("dialog[open] p.muted")?.textContent.trim() ?? null,
      ] : null`),
    ),
    [
      false,
      "A redeploy or a restart brings this worker back running, because the stop is recorded against this incarnation only.",
    ],
  );
  check(
    "Stop worker",
    await view.evaluate<boolean>(button("dialog[open]", "Stop worker", true)),
  );
  await awaitState(ids.reports, "stopped");
  checkEqual(
    "stopped for this process only",
    (
      await view.evaluate<[string, string] | null>(
        toast(`Stopped ${ids.reports}`),
      )
    )?.[0],
    `Stopped ${ids.reports}`,
  );
  check(
    "Start",
    await view.evaluate<boolean>(button(actions(ids.reports), "Start", true)),
  );
  await awaitState(ids.reports, "running");

  /* ---------------------------------------------------------------- */
  step("Settings… on a row: one save reaches both mailer instances");

  check(
    "Settings… on the mailer row",
    await view.evaluate<boolean>(
      button(actions(ids.mailer), "Settings…", true),
    ),
  );
  checkEqual(
    "the dialog is the key's, not the incarnation's",
    await view.evaluate<string | null>(textOf("dialog[open] h2")),
    `Settings of ${KEY.mailer}`,
  );
  await view.evaluate(typeInto("dialog[open]", "concurrency", "3"));
  since = mark();
  check(
    "Save settings",
    await view.evaluate<boolean>(button("dialog[open]", "Save settings", true)),
  );
  show(
    "sent",
    await requestSince(
      since,
      /^PUT \/jobs-api\/queues\/emails\/worker-configs\/mailer\.emails\.send$/,
    ),
  );
  checkEqual(
    "the toast counts the instances carrying the key",
    (
      await view.evaluate<[string, string] | null>(
        toast(`Saved the settings of ${KEY.mailer}`),
      )
    )?.[0],
    `Saved the settings of ${KEY.mailer}; 2 workers carry it`,
  );
  await waitFor("both mailer instances to run with concurrency 3", async () => {
    const both = (await listed("?queue=emails")).filter(
      (worker) => worker.key === KEY.mailer,
    );
    return (
      both.length === 2 &&
      both.every(
        (worker) =>
          worker.config?.effective.concurrency === 3 &&
          worker.config.overridden.includes("concurrency"),
      )
    );
  });
  checkEqual(
    "both report it overridden, and this process's worker object adopted it",
    mailerEmails.concurrency,
    3,
  );

  /* ---------------------------------------------------------------- */
  step("A refusal the worker's state caused: Resume on a stopped worker");

  check(
    "Pause api.reports",
    await view.evaluate<boolean>(button(actions(ids.reports), "Pause", true)),
  );
  await awaitState(ids.reports, "paused");
  check(
    "the row offers Resume",
    await view.evaluate<boolean>(button(actions(ids.reports), "Resume", false)),
  );
  // From here the page's worker reads wait, as over a slow network…
  workerReadGate = Promise.withResolvers<void>();
  // …while somebody else stops the worker.
  await apiJobs.workers.remote("reports").stop({ id: ids.reports });
  await waitFor("api.reports to stop", () => reports.state === "stopped");
  since = mark();
  check(
    "the row, not yet told, still offers Resume: click it",
    await view.evaluate<boolean>(button(actions(ids.reports), "Resume", true)),
  );
  await requestSince(since, /^POST .*api\.reports.*\/resume\?wait=2000$/);
  const refused = await view.evaluate<[string, string] | null>(
    toast(`Could not resume ${ids.reports}`),
  );
  show("toast", refused);
  check(
    "the toast explains WORKER_STATE_CONFLICT and what to do instead",
    refused !== null &&
      refused[1].includes("no longer in the state that action needs") &&
      refused[1].includes("a stopped worker is started, not resumed"),
    refused,
  );
  const direct = await send(
    "POST",
    `/queues/reports/workers/${encodeURIComponent(ids.reports)}/resume`,
  );
  checkEqual(
    "the same Resume sent directly → 409 WORKER_STATE_CONFLICT",
    [direct.status, direct.json.code],
    [409, "WORKER_STATE_CONFLICT"],
  );
  workerReadGate.resolve();
  workerReadGate = null;
  check(
    "once the reads land, the row offers Start",
    await view.evaluate<boolean>(button(actions(ids.reports), "Start", true)),
  );
  await awaitState(ids.reports, "running");

  /* ---------------------------------------------------------------- */
  step("The worker page, from a row's key link");

  await open("/workers");
  checkEqual(
    "the mailer row's key link leads to /workers/emails/mailer.emails.send",
    await view.evaluate<string | null>(
      clickOn(`[data-testid="worker-key-link-${ids.mailer}"]`),
    ),
    `${main.ui}/workers/emails/${KEY.mailer}`,
  );
  check(
    "the worker page renders (data-testid=worker-screen)",
    (await view.evaluate<string | null>(
      at(`${main.ui}/workers/emails/${KEY.mailer}`),
    )) !== null &&
      (await view.evaluate<boolean>(
        waitForSelector('[data-testid="worker-screen"]'),
      )),
    pageConsole,
  );
  checkEqual(
    "its heading is the key, its queue linked",
    [
      await view.evaluate<string | null>(
        textOf('[data-testid="worker-screen"] h1'),
      ),
      await view.evaluate<string | null>(
        `document.querySelector('.worker-header a')?.getAttribute("href") ?? null`,
      ),
    ],
    [`Worker ${KEY.mailer}`, `${main.ui}/queues/emails`],
  );
  await view.evaluate(rowsAre([ids.mailer, ids.replica]));
  const instances = Object.fromEntries(
    await view.evaluate<[string, Record<string, string>][]>(WORKER_ROWS),
  );
  checkEqual(
    "both live instances, each with its host and pid and its controls",
    [ids.mailer, ids.replica].map((id) => [
      instances[id]?.Host,
      instances[id]?.Pid,
      instances[id]?.Actions,
    ]),
    [
      [hostname(), String(process.pid), "PauseStop…Settings…"],
      [hostname(), String(replica.pid), "PauseStop…Settings…"],
    ],
  );

  /** Page-side: a setting's row as `[running with, code asks for, source]`. */
  const setting = (name: string) =>
    `[...document.querySelectorAll('[data-testid="worker-setting-${name}"] td')].map((cell) => cell.textContent.trim())`;
  checkEqual(
    "concurrency: running with 3, the code asks for 1, overridden",
    await view.evaluate<unknown>(
      poll(
        `(() => { const cells = ${setting("concurrency")}; return cells[0] === "3" ? cells : null; })()`,
      ),
    ),
    ["3", "1", "Overridden"],
  );
  checkEqual(
    "heartbeatInterval is derived, from the code",
    await view.evaluate<unknown>(setting("heartbeatInterval")),
    ["10,000 ms", "10,000 ms (derived)", "Code"],
  );
  check(
    "the summary counts the override",
    (
      await view.evaluate<string | null>(
        textOf('[data-testid="worker-config-summary"]'),
      )
    )?.includes(
      "replaces 1 of the 9 settings, for every instance of this key",
    ) === true,
  );

  step("Edit settings…, then Reset to code values");
  check(
    "Edit settings…",
    await view.evaluate<boolean>(
      button('[data-testid="worker-screen"]', "Edit settings…", true),
    ),
  );
  await view.evaluate(typeInto("dialog[open]", "maxStalledCount", "2"));
  check(
    "Save settings",
    await view.evaluate<boolean>(button("dialog[open]", "Save settings", true)),
  );
  await waitFor("both instances to report two overrides", async () => {
    const both = (await listed("?queue=emails")).filter(
      (worker) => worker.key === KEY.mailer,
    );
    return both.every(
      (worker) =>
        worker.config?.overridden.slice().sort().join() ===
        "concurrency,maxStalledCount",
    );
  });
  checkEqual(
    "maxStalledCount now reads overridden on the page",
    await view.evaluate<unknown>(
      poll(
        `(() => { const cells = ${setting("maxStalledCount")}; return cells[2] === "Overridden" ? cells : null; })()`,
      ),
    ),
    ["2", "1", "Overridden"],
  );
  check(
    "Edit settings… again",
    await view.evaluate<boolean>(
      button('[data-testid="worker-screen"]', "Edit settings…", true),
    ),
  );
  since = mark();
  check(
    "Reset to code values",
    await view.evaluate<boolean>(
      button("dialog[open]", "Reset to code values", true),
    ),
  );
  show(
    "sent",
    await requestSince(
      since,
      /^DELETE \/jobs-api\/queues\/emails\/worker-configs\/mailer\.emails\.send$/,
    ),
  );
  await waitFor("both instances back on their code's values", async () => {
    const both = (await listed("?queue=emails")).filter(
      (worker) => worker.key === KEY.mailer,
    );
    return both.every(
      (worker) =>
        worker.config?.overridden.length === 0 &&
        worker.config.effective.concurrency === 1,
    );
  });
  checkEqual(
    "and the page says no override is stored",
    await view.evaluate<string | null>(
      poll(
        `document.querySelector('[data-testid="worker-config-summary"]')?.textContent.startsWith("No override") ? document.querySelector('[data-testid="worker-config-summary"]').textContent.trim() : null`,
      ),
    ),
    "No override is stored: every value is what the code asks for.",
  );
  checkEqual("this process's worker is back to 1", mailerEmails.concurrency, 1);

  /* ---------------------------------------------------------------- */
  step("The queue's Workers panel links to the same pages");

  await open("/queues/emails?panel=workers");
  await view.evaluate(rowsAre([ids.apiEmails, ids.mailer, ids.replica]));
  checkEqual(
    "every row of the panel links its key, with its controls beside it",
    await view.evaluate<unknown>(
      `${JSON.stringify([ids.apiEmails, ids.mailer, ids.replica])}.map((id) => [
        document.querySelector(\`[data-testid="worker-key-link-\${id}"]\`)?.getAttribute("href") ?? null,
        [...document.querySelectorAll(\`[role="group"][aria-label="Actions for worker \${id}"] button\`)].map((button) => button.textContent.trim()),
      ])`,
    ),
    [
      [
        `${main.ui}/workers/emails/${KEY.apiEmails}`,
        ["Pause", "Stop…", "Settings…"],
      ],
      [
        `${main.ui}/workers/emails/${KEY.mailer}`,
        ["Pause", "Stop…", "Settings…"],
      ],
      [
        `${main.ui}/workers/emails/${KEY.mailer}`,
        ["Pause", "Stop…", "Settings…"],
      ],
    ],
  );
  check(
    "clicking api.emails.send's link opens its worker page",
    (await view.evaluate<string | null>(
      clickOn(`[data-testid="worker-key-link-${ids.apiEmails}"]`),
    )) !== null &&
      (await view.evaluate<string | null>(
        at(`${main.ui}/workers/emails/${KEY.apiEmails}`),
      )) !== null,
  );

  /* ---------------------------------------------------------------- */
  step('"Processed by" links to the worker page');

  await open("/queues/emails");
  check(
    "the jobs table has a Processed by column",
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="jobs-processed-by-header"]'),
    ),
  );
  const processedBy = (id: string) =>
    `document.querySelector('[data-testid="job-row-${id}"] [data-testid="jobs-processed-by-key"]')`;
  checkEqual(
    "done-1 by api.emails.send and m-1 by mailer.emails.send, each linked",
    await view.evaluate<unknown>(
      poll(`${processedBy("m-1")} ? ["done-1", "m-1"].map((id) => {
        const cell = document.querySelector(\`[data-testid="job-row-\${id}"] [data-testid="jobs-processed-by-key"]\`);
        return [cell.textContent.trim(), cell.getAttribute("href")];
      }) : null`),
    ),
    [
      [KEY.apiEmails, `${main.ui}/workers/emails/${KEY.apiEmails}`],
      [KEY.mailer, `${main.ui}/workers/emails/${KEY.mailer}`],
    ],
  );
  checkEqual(
    "as the API recorded them",
    await Promise.all(
      ["done-1", "m-1"].map(
        async (id) =>
          (
            await read<{ processedBy: { key?: string } | null }>(
              `/queues/emails/jobs/${id}`,
            )
          ).processedBy?.key,
      ),
    ),
    [KEY.apiEmails, KEY.mailer],
  );
  await open("/queues/emails/jobs/done-2");
  checkEqual(
    "the job screen's Processed by line links the key",
    await view.evaluate<string | null>(
      clickOn('[data-testid="job-processed-by-key"]'),
    ),
    `${main.ui}/workers/emails/${KEY.apiEmails}`,
  );
  check(
    "and leads to the worker page",
    (await view.evaluate<string | null>(
      at(`${main.ui}/workers/emails/${KEY.apiEmails}`),
    )) !== null &&
      (await view.evaluate<boolean>(
        waitForSelector('[data-testid="worker-jobs"]'),
      )),
  );

  /* ---------------------------------------------------------------- */
  step("Jobs whose last attempt api.emails.send ran");

  const JOBS = '[data-testid="worker-jobs"]';
  since = mark();
  await open(`/workers/emails/${KEY.apiEmails}`);
  const defaultRead = await requestSince(
    since,
    /^GET \/jobs-api\/queues\/emails\/jobs\?.*workerKey=api\.emails\.send/,
  );
  show("sent", defaultRead);
  const defaultQuery = new URL(defaultRead.split(" ")[1]!, "http://x")
    .searchParams;
  const from = Number(defaultQuery.get("finishedFrom"));
  check(
    "by default over the last 24 hours of finishedOn: finishedFrom ≈ now − 24 h, no finishedTo",
    Math.abs(from - (Date.now() - 86_400_000)) < 60_000 &&
      !defaultQuery.has("finishedTo"),
    Object.fromEntries(defaultQuery),
  );
  const newestFirst = await jobIds(
    defaultRead.split(" ")[1]!.slice(main.api.length),
  );
  checkEqual(
    "the API answers api.emails.send's four jobs, none of the mailer's",
    newestFirst.slice().sort(),
    ["dead-1", "done-1", "done-2", "done-3"],
  );
  checkEqual(
    "and the page lists them in the API's order (newest first)",
    await view.evaluate<string[] | null>(jobRows(JOBS, "ids.length === 4")),
    newestFirst,
  );
  check(
    "with the range picker (data-testid=worker-jobs-range)",
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="worker-jobs-range"]'),
    ),
  );
  checkEqual(
    "each id links to its job",
    await view.evaluate<string | null>(
      `document.querySelector('[data-testid="job-row-done-1"] a[href]')?.getAttribute("href") ?? null`,
    ),
    `${main.ui}/queues/emails/jobs/done-1`,
  );

  /** Opens the api.emails.send page with `query`, and answers its jobs read and rows. */
  async function jobsWith(
    query: string,
    ready: string,
  ): Promise<[string, string[] | null]> {
    const before = mark();
    await open(`/workers/emails/${KEY.apiEmails}?${query}`);
    const sent = await requestSince(
      before,
      /^GET \/jobs-api\/queues\/emails\/jobs\?.*workerKey=/,
    );
    return [sent, await view.evaluate<string[] | null>(jobRows(JOBS, ready))];
  }

  let [sent, shown] = await jobsWith("jobState=dead", "ids.length === 1");
  checkEqual("?jobState=dead → dead-1", shown, ["dead-1"]);
  check(
    "sent as state=dead, still ranged",
    /state=dead/.test(sent) && /finishedFrom=/.test(sent),
    sent,
  );

  [sent, shown] = await jobsWith(
    "jobState=completed&jobName=welcome",
    "ids.length === 2",
  );
  checkEqual(
    "?jobState=completed&jobName=welcome → done-2, done-1",
    shown,
    newestFirst.filter((id) => id === "done-1" || id === "done-2"),
  );
  check("sent as name=welcome", /name=welcome/.test(sent), sent);

  [sent, shown] = await jobsWith("jobSearch=done-3", "ids.length === 1");
  checkEqual("?jobSearch=done-3 → done-3", shown, ["done-3"]);
  check("sent as search=done-3", /search=done-3/.test(sent), sent);

  [sent, shown] = await jobsWith("jobOrder=asc", "ids.length === 4");
  checkEqual(
    "?jobOrder=asc → oldest first",
    shown,
    newestFirst.slice().reverse(),
  );
  check("sent without order=desc", !/order=desc/.test(sent), sent);

  [sent, shown] = await jobsWith("jobLimit=1&jobOffset=1", "ids.length === 1");
  checkEqual("?jobLimit=1&jobOffset=1 → the second, alone", shown, [
    newestFirst[1],
  ]);
  check(
    "sent as limit=1&offset=1",
    /limit=1(?:&|$)/.test(sent) && /offset=1(?:&|$)/.test(sent),
    sent,
  );

  // The window is taken from what the API recorded, not from this process's
  // clock: from done-1's finishedOn (inclusive) to done-2's (exclusive).
  const finishedOn = Object.fromEntries(
    await Promise.all(
      ["done-1", "done-2"].map(async (id) => [
        id,
        (await read<{ finishedOn: number }>(`/queues/emails/jobs/${id}`))
          .finishedOn,
      ]),
    ),
  ) as Record<"done-1" | "done-2", number>;
  const firstWindow = {
    from: finishedOn["done-1"],
    to: Math.max(finishedOn["done-2"], finishedOn["done-1"] + 1),
  };
  [sent, shown] = await jobsWith(
    `finished=${firstWindow.from}-${firstWindow.to}`,
    "ids.length === 1",
  );
  check(
    "?finished=<done-1's finishedOn>-<done-2's> → done-1",
    Bun.deepEquals(shown, ["done-1"]),
    { shown, sent, finishedOn },
  );
  check(
    "sent as finishedFrom and finishedTo",
    sent.includes(`finishedFrom=${firstWindow.from}`) &&
      sent.includes(`finishedTo=${firstWindow.to}`),
    sent,
  );

  [sent, shown] = await jobsWith("jobState=active", "true");
  checkEqual("?jobState=active → none: the key runs nothing now", shown, []);
  check(
    "Active drops the range: no finishedFrom sent, and the page says why",
    !/finishedFrom/.test(sent) &&
      (await view.evaluate<boolean>(
        waitForSelector('[data-testid="worker-jobs-no-range"]'),
      )),
    sent,
  );

  /* ---------------------------------------------------------------- */
  step("Throughput and busyness over ?range=");

  since = mark();
  await open(`/workers/emails/${KEY.apiEmails}?range=300s`);
  const analyticsRead = await requestSince(
    since,
    /^GET \/jobs-api\/queues\/emails\/analytics\/workers\/api\.emails\.send\?/,
  );
  show("sent", analyticsRead);
  const analyticsQuery = new URL(analyticsRead.split(" ")[1]!, "http://x")
    .searchParams;
  // A rolling preset starts at the first whole bucket inside its window, so
  // the span falls short of five minutes by more than nothing and at most one
  // bucket (1 s here): exactly one bucket when `now - 5 min` is itself on a
  // boundary, which at millisecond precision is one read in a thousand.
  const askedFrom = Number(analyticsQuery.get("from"));
  const askedSpan = Number(analyticsQuery.get("to")) - askedFrom;
  const bucket = Number(analyticsQuery.get("resolution")) * 1_000;
  check(
    "?range=300s asks for five minutes, from the first whole bucket inside them",
    askedSpan >= 300_000 - bucket &&
      askedSpan < 300_000 &&
      askedFrom % bucket === 0,
    { askedFrom, askedSpan, bucket },
  );
  checkEqual(
    "the range picker shows it",
    await view.evaluate<string | null>(
      poll(
        `document.querySelector('[data-testid="worker-analytics"]') && document.querySelector('.analytics-section .range-picker select')?.value`,
      ),
    ),
    "300",
  );
  /** What the analytics route answers: the fields this step reads. */
  interface WorkerAnalytics {
    /** Throughput. */
    jobs: { totals: { completed: number; failed: number } };
    /** Busyness, where the backend records it. */
    busyness?: { totals: { samples: number } };
  }
  const series = await read<WorkerAnalytics>(
    analyticsRead.split(" ")[1]!.slice(main.api.length),
  );
  checkEqual(
    "the API counts api.emails.send's 3 completed and 1 failed attempt in the range",
    [series.jobs.totals.completed, series.jobs.totals.failed],
    [3, 1],
  );
  checkEqual(
    "and the page shows the same totals",
    await view.evaluate<string[] | null>(
      textsWhen(
        '[aria-label="Throughput totals"] .stat-value',
        "texts.length === 2",
      ),
    ),
    ["3", "1"],
  );
  check(
    "busyness: sampled heartbeats, or the note that none landed — as the API says",
    series.busyness === undefined
      ? await view.evaluate<boolean>(
          waitForSelector('[data-testid="worker-busyness-absent"]'),
        )
      : series.busyness.totals.samples === 0
        ? await view.evaluate<boolean>(
            waitForSelector('[data-testid="worker-busyness-no-samples"]'),
          )
        : await view.evaluate<boolean>(
            waitForSelector('[aria-label="Busyness totals"]'),
          ),
    series.busyness,
  );

  /* ---------------------------------------------------------------- */
  step('Caught between states: "Change pending" while a stop drains');

  since = mark();
  await open(`/workers/exports/${KEY.exports}?jobState=active`);
  checkEqual(
    "?jobState=active lists the export api.exports is running",
    await view.evaluate<string[] | null>(jobRows(JOBS, "ids.length === 1")),
    ["export-held"],
  );
  check(
    "with no finishedFrom sent",
    !/finishedFrom/.test(
      await requestSince(
        since,
        /^GET \/jobs-api\/queues\/exports\/jobs\?.*workerKey=/,
      ),
    ),
  );
  check(
    "Stop… on the instance",
    await view.evaluate<boolean>(button(actions(ids.exports), "Stop…", true)),
  );
  checkEqual(
    "the dialog says it finishes the job it holds",
    await view.evaluate<string | null>(
      poll(
        `document.querySelector("dialog[open]")?.textContent.includes("finishes the job it is running") ? "yes" : null`,
      ),
    ),
    "yes",
  );
  check(
    "Stop worker",
    await view.evaluate<boolean>(button("dialog[open]", "Stop worker", true)),
  );
  const stopToast = await view.evaluate<[string, string] | null>(
    toast(ids.exports),
  );
  await awaitState(ids.exports, "stopping");
  // The worker accepts the stop at once (`applied: true`) but drains the job
  // it holds first, so the toast must not say it has stopped.
  checkEqual(
    "the toast says it was asked to stop, since it finishes its job first",
    stopToast?.[0],
    `Asked ${ids.exports} to stop; it finishes its jobs first`,
  );
  checkEqual(
    "the API reports it stopping, with control.pending",
    (await record(ids.exports))?.control?.pending,
    true,
  );
  checkEqual(
    "the instance row: Stopping, and Change pending",
    await view.evaluate<unknown>(
      poll(`(() => {
        const row = document.querySelector('[data-testid="worker-row-${ids.exports}"]');
        const badges = row ? [...row.querySelectorAll(".badge")].map((badge) => badge.textContent.trim()) : [];
        return badges.includes("Stopping") ? badges : null;
      })()`),
    ),
    ["Stopping", "Change pending"],
  );
  checkEqual(
    "the Configuration card: Change pending",
    await view.evaluate<unknown>(
      poll(
        `[...document.querySelectorAll('[data-testid="worker-screen"] .badge')].filter((badge) => !badge.closest("tr")).map((badge) => badge.textContent.trim()).includes("Change pending") || null`,
      ),
    ),
    true,
  );
  // Between states, no lifecycle action is offered; Settings… stays, since
  // an override is stored for the key whatever this incarnation is doing.
  checkEqual(
    "no lifecycle action while it drains: Settings… alone",
    await view.evaluate<unknown>(buttonsIn(actions(ids.exports))),
    ["Settings…"],
  );
  checkEqual(
    "and beside it, the row says why Pause and Stop are gone",
    await view.evaluate<string | null>(
      textOf(`[data-testid="worker-blocked-${ids.exports}"]`),
    ),
    "This worker is between states. Its actions come back once it settles.",
  );
  releaseHeld();
  await awaitState(ids.exports, "stopped");
  check(
    "the job done, it settles stopped: Change pending goes, and Start is offered",
    (await view.evaluate<boolean | null>(
      poll(
        `![...document.querySelectorAll('[data-testid="worker-screen"] .badge')].some((badge) => badge.textContent.trim() === "Change pending")`,
      ),
    )) === true &&
      (await view.evaluate<boolean>(
        button(actions(ids.exports), "Start", true),
      )),
  );
  await awaitState(ids.exports, "running");

  /* ---------------------------------------------------------------- */
  step(
    "A host that lets a caller list workers, not change them (hosts hidden)",
  );

  await open("/workers", viewOnly);
  await view.evaluate(rowsAre(Object.values(ids)));
  checkEqual(
    "no Actions column, no button in any row",
    await view.evaluate<unknown>(
      `[[...document.querySelectorAll("thead th")].some((th) => th.textContent.trim() === "Actions"),
        document.querySelectorAll('tr[data-testid^="worker-row-"] button').length]`,
    ),
    [false, 0],
  );
  checkEqual(
    "one server per service, titled for hidden hosts",
    await view.evaluate<unknown>(GROUPING),
    groupingOf(
      await read<{ items: WorkerDto[] }>("/workers", viewOnly).then(
        (list) => list.items,
      ),
    ),
  );
  check(
    "and no Host filter",
    (
      await view.evaluate<string[] | null>(
        poll(
          `document.querySelector('[data-testid="worker-filters"] label') ? [...document.querySelectorAll('[data-testid="worker-filters"] label')].map((label) => label.textContent.trim()) : null`,
        ),
      )
    )?.includes("Host") === false,
  );
  await open("/workers?host=anything", viewOnly);
  check(
    "a ?host= in a link is ignored, with a note",
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="workers-host-ignored"]'),
    ),
  );
  await open(`/workers/emails/${KEY.mailer}`, viewOnly);
  await view.evaluate(rowsAre([ids.mailer, ids.replica]));
  check(
    "the worker page: instances without controls, no Edit settings…",
    (await view.evaluate<boolean>(
      waitForSelector('[data-testid="worker-setting-concurrency"]'),
    )) &&
      !(await view.evaluate<boolean>(
        button('[data-testid="worker-screen"]', "Edit settings…", false, 0),
      )) &&
      (await view.evaluate<number>(
        `document.querySelectorAll('[data-testid="worker-instances"] button').length`,
      )) === 0,
  );
  await open(`/workers/exports/${KEY.exports}`, viewOnly);
  check(
    "a queue whose workers may not be listed: Instances hidden",
    (await view.evaluate<string | null>(
      poll(
        `[...document.querySelectorAll("h2, h3, .empty-state-title, [class*=empty]")].map((element) => element.textContent.trim()).find((text) => text.startsWith("Instances hidden")) ?? null`,
      ),
    )) !== null &&
      (await view.evaluate<number>(
        `document.querySelectorAll('tr[data-testid^="worker-row-"]').length`,
      )) === 0,
  );
  /** What the analytics route answers: the totals this step compares. */
  interface Totals {
    /** Throughput over the range. */
    jobs: { totals: { completed: number; failed: number } };
  }
  const hiddenSeries = await read<Totals>(
    `/queues/exports/analytics/workers/${KEY.exports}?from=${Date.now() - 3_600_000}&to=${Date.now()}&resolution=60`,
    viewOnly,
  );
  checkEqual(
    "the API counts api.exports' one completed export over the last hour",
    [hiddenSeries.jobs.totals.completed, hiddenSeries.jobs.totals.failed],
    [1, 0],
  );
  checkEqual(
    "yet its throughput and busyness still show (analytics, not workers.list), with the API's totals",
    await view.evaluate<string[] | null>(
      textsWhen(
        '[data-testid="worker-analytics"] [aria-label="Throughput totals"] .stat-value',
        "texts.length === 2",
      ),
    ),
    [
      String(hiddenSeries.jobs.totals.completed),
      String(hiddenSeries.jobs.totals.failed),
    ],
  );
  await open(`/workers/digests/${KEY.digests}`, viewOnly);
  check(
    "a key with no live instance: the stored override, and no Reset",
    (await view.evaluate<boolean>(
      waitForSelector('[data-testid="worker-config-stored"]'),
    )) &&
      !(await view.evaluate<boolean>(
        button(
          '[data-testid="worker-screen"]',
          "Reset to code values…",
          false,
          0,
        ),
      )),
  );

  /* ---------------------------------------------------------------- */
  step("A host that refuses workers.* altogether");

  await open("/queues/emails", noWorkers);
  check(
    "the jobs table still says who processed a job",
    await view.evaluate<boolean>(
      waitForSelector(
        '[data-testid="job-row-done-1"] [data-testid="jobs-processed-by-key"]',
      ),
    ),
  );
  checkEqual(
    "but as plain text: there is no worker page to link to",
    await view.evaluate<unknown>(
      `(() => { const cell = document.querySelector('[data-testid="job-row-done-1"] [data-testid="jobs-processed-by-key"]'); return [cell.tagName, cell.textContent.trim()]; })()`,
    ),
    ["SPAN", KEY.apiEmails],
  );
  checkEqual(
    "no Workers entry in the nav, and no Workers panel on the queue",
    await view.evaluate<unknown>(
      `[[...document.querySelectorAll('nav[aria-label="Sections"] a')].some((link) => link.textContent.trim() === "Workers"),
        [...document.querySelectorAll('[role="tablist"][aria-label="Queue details"] [role="tab"]')].map((tab) => tab.textContent.trim()).includes("Workers")]`,
    ),
    [false, false],
  );
  await open("/queues/emails/jobs/done-1", noWorkers);
  checkEqual(
    "the job screen's Processed by: the key, unlinked",
    await view.evaluate<unknown>(
      poll(
        `(() => { const key = document.querySelector('[data-testid="job-processed-by-key"]'); return key ? [key.tagName, key.textContent.trim()] : null; })()`,
      ),
    ),
    ["SPAN", KEY.apiEmails],
  );
  await open("/workers", noWorkers);
  checkEqual(
    "/workers is not routed",
    await view.evaluate<string | null>(textOf("main h1")),
    "Page not found",
  );
  checkEqual(
    "and the API refuses the list itself",
    (await fetch(`${noWorkers.origin}${noWorkers.api}/workers`)).status,
    403,
  );

  /* ---------------------------------------------------------------- */
  step("A key with no live instance: Reset to code values…");

  await open(`/workers/digests/${KEY.digests}`);
  check(
    "No live instance",
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="worker-config-offline"]'),
    ),
  );
  checkEqual(
    "the stored override, as the listing's offline reports it",
    await view.evaluate<string | null>(
      textOf('[data-testid="worker-config-offline"] dl'),
    ),
    "concurrency4",
  );
  check(
    "Reset to code values…",
    await view.evaluate<boolean>(
      button('[data-testid="worker-screen"]', "Reset to code values…", true),
    ),
  );
  check(
    "confirmed with Reset",
    await view.evaluate<boolean>(button("dialog[open]", "Reset", true)),
  );
  /** What `GET /workers?includeOffline` adds. */
  interface Offline {
    /** The overrides stored for keys no live worker carries. */
    offline?: { key: string; values: Record<string, number> }[];
  }
  await waitFor("the override to be gone from the API", async () => {
    const answer = await read<Offline>(
      `/workers?queue=digests&key=${KEY.digests}&includeOffline=true`,
    );
    return (answer.offline ?? []).every(
      (entry) => Object.keys(entry.values).length === 0,
    );
  });
  show(
    "GET /workers?queue=digests&key=api.digests&includeOffline=true → offline",
    (
      await read<Offline>(
        `/workers?queue=digests&key=${KEY.digests}&includeOffline=true`,
      )
    ).offline,
  );
  // The API keeps the reset entry, emptied (`values: {}`, its `seq` kept so
  // no worker mistakes a restarted version for news); the page counts an
  // empty entry as nothing stored.
  check(
    "the page says no override is stored",
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="worker-config-none-stored"]'),
    ),
    await view.evaluate<string | null>(
      textOf('[data-testid="worker-config-offline"]', 0),
    ),
  );
  checkEqual(
    'no "An override is stored", and no Reset to code values…',
    [
      await view.evaluate<boolean>(
        `!!document.querySelector('[data-testid="worker-config-stored"]')`,
      ),
      await view.evaluate<boolean>(
        button(
          '[data-testid="worker-screen"]',
          "Reset to code values…",
          false,
          0,
        ),
      ),
    ],
    [false, false],
  );

  checkEqual(
    "no CSP violation on the way",
    await view.evaluate<string[]>(COLLECT_VIOLATIONS),
    [],
  );
} catch (error) {
  console.log(`page console:\n${pageConsole.join("\n")}`);
  console.log(
    `rows on screen: ${JSON.stringify(await view.evaluate(ROW_IDS).catch(() => null))}`,
  );
  throw error;
} finally {
  await shutdown(view);
}

summary();
