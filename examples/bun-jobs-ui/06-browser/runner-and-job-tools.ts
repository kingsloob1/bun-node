/**
 * The runner screen's and the job screen's tools, in a real browser against
 * a real `createJobsApi`: a runner's Settings…, its run logs, Clear
 * history…, a job's Clear logs…, and who processed and who holds a job.
 * Every write is read back from the API, not from the page.
 *
 * ```bash
 * bun 06-browser/runner-and-job-tools.ts
 * BUN_CHROME_PATH=/opt/chrome/chrome bun 06-browser/runner-and-job-tools.ts
 * EXAMPLE_BROWSER=0 bun 06-browser/runner-and-job-tools.ts   # skip on purpose
 * ```
 *
 * Like the other browser examples it drives headless Chrome through
 * `Bun.WebView` and **skips** (prints `skipped:` and exits 0) when there is
 * no `Bun.WebView`, no Chrome, or Chrome will not start.
 *
 * Five hosts serve one `BunJobs` context, each an API and the UI:
 *
 * | host        | what differs                                                        |
 * | ----------- | ------------------------------------------------------------------- |
 * | `full`      | `actions: JOBS_API_ACTIONS` (the opt-in `runners.configure` too), a live socket |
 * | `socketless`| the same actions, `websocket: false`: live updates are off          |
 * | `unlisted`  | the default actions without `jobs.clearLogs` and `runners.clearHistory` (and `runners.configure`, which is opt-in) |
 * | `refused`   | every action listed, but `authorize` refuses those three            |
 * | `capped`    | `full`'s actions, with `limits: { maxHistory: 20 }` — a largest page smaller than one runner's stored runs |
 *
 * What it shows:
 *
 * - **Runner Settings…** (`PUT /runners/:runner/config`, opt-in
 *   `runners.configure`) sets the execution mode, run mode and max
 *   concurrency; the modes outside the runner's `allowedOverrides.executionModes`
 *   are not offered, and say so. A runner built from a driver instance alone
 *   is offered in-process only, and a PUT for worker-thread is 409
 *   `CONFIG_NOT_ALLOWED`. Saved, the runner adopts it, and the summary
 *   marks each overridden row with what the code asks for instead. "Reset to
 *   code defaults" (`DELETE …/config`) drops every override. An override the
 *   owner refuses reads "Override refused by the owner; it runs what its code
 *   asks for, …" instead, on exactly the rows `config.error.keys` names; the
 *   adopted ones still read "Overridden here…", even one equal to the code's
 *   value. The Settings override row and the Settings… dialog name the
 *   refused settings too ("The owner refused Execution mode: …").
 * - **A run's log** sits in its history row's details (and behind the row's
 *   Log button), in the URL as `?logs=<runId>`. The Stream filter
 *   (`?logStream=`) narrows it to `logger`, `stdout` or `stderr`. A live run
 *   is followed: with a socket, by the runner's `logs` hint (the fallback
 *   poll relaxes to a minute, so the lines arriving within seconds are the
 *   hint's doing); without one, by a poll every 2 s — and the note says which.
 *   A cap that bit says "N earlier lines dropped" (and the row carries an "N
 *   lines dropped" badge); while the run is still going, "A cap is trimming
 *   this log now". Every log carries the redaction note, and a
 *   `password=…` really is stored as `[REDACTED]`.
 * - **The history pages on the server.** "Runs shown" is the page *size*
 *   (`?history=`, sent as `GET /runners/:runner/history?limit=`), the pager
 *   re-reads with a new `offset`, and both live in the URL; `page.total` is
 *   every run the runner has stored, so a pager appears when the history
 *   outgrows a page and not when a fetch came back long. `limits.maxHistory`
 *   caps a page and not how deep an offset may start, so a run stored past
 *   the cap is reached by paging to it — measured here against an API whose
 *   largest page cannot hold it. A window past the end says "No runs on this
 *   page" and keeps its pager and Clear history…; a new page size restarts at
 *   the first page. Every `?logs=` link the UI writes carries the window it
 *   was pressed on, so a copied link lands on its row and Next still moves
 *   with a log open; a `logs=` the page does not hold gets
 *   `history-open-log-note` and a Close log, in a sentence that claims
 *   neither that the run exists nor that it does not. A run *finishing*
 *   leaves the reader's rows exactly where they were; a run *starting*
 *   prepends, so the rows shift by one while the window stays theirs.
 * - **Clear history…** (`DELETE /runners/:runner/history`), in the History
 *   card's header (disabled, titled "No runs to clear.", with no runs), removes the
 *   finished runs and keeps a run in progress, record and log whole — on a
 *   local runner and on one registered in another context alike.
 * - **Clear logs…** (`DELETE /queues/:queue/jobs/:id/logs`) sits in the
 *   job's Logs card: disabled, with its reason beside it, while the job is
 *   active or the log is empty. When the job turns active while the dialog is
 *   open, the API's 409 `JOB_ACTIVE` is explained in the dialog.
 * - **"Processed by"** names the worker that ran the job's last attempt, its
 *   stable key linked to the worker page; **"Held by"** shows only while the
 *   job is active.
 * - **Refused and unlisted actions are not offered**: no Settings…, Clear
 *   history… or Clear logs…, while the rest of each screen stays writable.
 * - **Wait on conditions, never on time.**
 */
import type {
  BunRunner,
  BunRunnerOptions,
  JobsApiAuthorize,
} from "@kingsleyweb/bun-jobs";
import type { LogRunnerArgs } from "./helpers/log-runner";
import type { PagerView } from "./helpers/page";
import type { RunLogLine, SummaryRow } from "./helpers/runner-job-page";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_ACTIONS,
  JOBS_API_OPT_IN_ACTIONS,
  MemoryDriver,
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
import { LOG_RUNNER_GATES } from "./helpers/log-runner";
import {
  pagerOf,
  pagersWhen,
  pagerWhen,
  poll,
  textsWhen,
} from "./helpers/page";
import {
  chooseOption,
  disabledButton,
  focusField,
  gone,
  hasButton,
  noSummaryRow,
  runLogLines,
  summaryRow,
  textIncludes,
} from "./helpers/runner-job-page";

// Decide whether to skip before printing anything: run-all.ts recognises a
// skip by the output *starting* with `skipped:`.
const chromePath = chromeOrSkip();

/** The actions `refused` lists but `authorize` refuses, and `unlisted` leaves out. */
const GATED_ACTIONS = [
  "runners.configure",
  "runners.clearHistory",
  "jobs.clearLogs",
] as const;
/** The CSRF header every host asks for on a write. */
const CSRF = "x-bun-jobs-csrf";
/** The handler every runner here runs. */
const HANDLER = new URL("./helpers/log-runner.ts", import.meta.url);

/**
 * The runner whose settings are edited: `in-process` in its code,
 * `worker-thread` also permitted by its `allowedOverrides`, and a
 * `childDriver` to hand a Worker, so it can adopt a `worker-thread` override.
 */
const SETTINGS = "nightly-export";
/**
 * The same `allowedOverrides`, but built from the driver instance alone: with no
 * config to hand a child, `worker-thread` is not offered at all (`allowed` is
 * `["in-process"]`) and a PUT asking for it is refused with 409.
 */
const INSTANCE_BOUND = "instance-bound";
/**
 * A runner whose owner refuses a stored override: another context, with a
 * `childDriver`, adopts `worker-thread`; redeployed here from the driver instance
 * alone, the runner cannot, so it keeps its code's mode and reports why.
 */
const REDEPLOYED = "redeployed-export";
/** The runner whose finished run has a log in three streams, and a secret. */
const LOGGED = "report-render";
/** The runner whose log cap keeps 3 lines. */
const TRIMMED = "audit-trim";
/** The runner whose history is paged: more stored runs than a page can hold. */
const PAGED = "ledger-sweep";
/**
 * Its finished runs. More than {@link HISTORY_CAP}, so the `capped` host
 * stores runs no single page of its API can return; fewer than the runner's
 * `keepHistory` (50, the default), so nothing is trimmed and every one of them
 * stays stored for the whole example.
 */
const PAGED_FINISHED = 30;
/**
 * Every record its history holds when the paging steps begin: the finished
 * runs, plus the one held in flight. The last step starts one more on purpose,
 * to watch what a start does under a reader.
 */
const PAGED_RECORDS = PAGED_FINISHED + 1;
/**
 * The page size the paging steps ask for, as `?history=`. At most
 * {@link HISTORY_CAP}: a `limit` above the API's cap is 400 `VALIDATION`,
 * never a quietly shortened page.
 */
const PAGED_PAGE = 10;
/**
 * Where the run left in flight sits in the history, newest first. Equal to
 * {@link PAGED_PAGE}, so it is the first row of page 2 — the row watched while
 * it finishes, which the route patches in place rather than moving.
 */
const PAGED_HELD_AT = PAGED_PAGE;
/**
 * The `capped` host's `limits.maxHistory`: the largest history page its API
 * will serve. Below {@link PAGED_RECORDS}, which is the whole point — the runs
 * past it are stored and reachable only by offset.
 */
const HISTORY_CAP = 20;
/** How many lines the trimmed runner's log keeps. */
const TRIMMED_KEEPS = 3;
/** How many lines its runs write. */
const TRIMMED_LINES = 7;
/** The runner whose live run is followed. */
const TICKER = "ticker";
/** The local runner whose history is cleared around a run in progress. */
const HELD = "invoice-batch";
/** A runner that has never run when the example begins. */
const FRESH = "fresh-start";
/** The runner registered only in the `remote` context. */
const REMOTE = "remote-sync";
/** The secret the logged run prints, which must never reach the page. */
const SECRET = "hunter2-do-not-show";

/** The queue with a worker. */
const QUEUE = "reports";
/** Its worker's stable key. */
const WORKER_KEY = "reports-main";
/** The queue whose worker starts only mid-example. */
const LATER = "exports";
/** That worker's stable key. */
const LATER_KEY = "exports-main";
/** A job that logged 5 lines and completed. */
const LOGGED_JOB = "weekly-summary";
/** How many lines it logged. */
const LOGGED_JOB_LINES = 5;
/** A job that completed without logging. */
const SILENT_JOB = "silent-ping";
/** A job the worker holds active, after logging 2 lines. */
const HELD_JOB = "long-report";
/** A waiting job with 3 lines, claimed while its Clear logs dialog is open. */
const RACING_JOB = "export-racing";

/* --- the gates: held runs and jobs wait on these ------------------- */

const gates = new Map<string, Promise<void>>();
(globalThis as Record<symbol, unknown>)[LOG_RUNNER_GATES] = gates;
const releases = new Map<string, () => void>();

/** Creates the gate `name`, and answers its name. */
function gate(name: string): string {
  gates.set(
    name,
    new Promise<void>((resolve) => {
      releases.set(name, resolve);
    }),
  );
  return name;
}

/** Opens the gate `name`. */
function release(name: string): void {
  releases.get(name)?.();
}

/* --- the jobs: one driver, two contexts ---------------------------- */

const driver = new MemoryDriver();
const jobs = new BunJobs({
  namespace: "examples-ui-runner-job-tools",
  service: "api",
  driver,
  logger: noopLogger,
  // The socket carries only what producers publish, `logs` hints included.
  publishEvents: true,
});
// Another process, as far as the API is concerned: its runners are remote.
const remote = new BunJobs({
  namespace: "examples-ui-runner-job-tools",
  service: "remote",
  driver,
  logger: noopLogger,
  publishEvents: true,
});

/** Registers and starts a runner over the log handler. */
async function startRunner(
  context: BunJobs,
  id: string,
  extra: Partial<
    Pick<
      BunRunnerOptions<LogRunnerArgs>,
      | "executionMode"
      | "runMode"
      | "allowedOverrides"
      | "captureLogs"
      | "childDriver"
    >
  > = {},
): Promise<BunRunner<LogRunnerArgs>> {
  const runner = context.runner<LogRunnerArgs>({
    id,
    name: id,
    file: HANDLER,
    executionMode: "in-process",
    waitToExit: false,
    logger: noopLogger,
    ...extra,
  });
  await runner.start();
  return runner;
}

const settingsRunner = await startRunner(jobs, SETTINGS, {
  allowedOverrides: { executionModes: ["in-process", "worker-thread"] },
  // What a Worker would reach the backend with. Nothing here runs in one:
  // the override is only adopted, never exercised.
  childDriver: { type: "memory" },
});
const instanceBound = await startRunner(jobs, INSTANCE_BOUND, {
  allowedOverrides: { executionModes: ["in-process", "worker-thread"] },
});
const loggedRunner = await startRunner(jobs, LOGGED);
const trimmedRunner = await startRunner(jobs, TRIMMED, {
  captureLogs: { maxLines: TRIMMED_KEEPS },
});
const tickerRunner = await startRunner(jobs, TICKER, { runMode: "parallel" });
const heldRunner = await startRunner(jobs, HELD);
const remoteRunner = await startRunner(remote, REMOTE, { runMode: "parallel" });
const freshRunner = await startRunner(jobs, FRESH);
// `parallel` so one run can be held in flight while the runs above it in the
// history are made: under the default `single`, a trigger arriving during a run
// is skipped, and there would be no way to put a running record mid-history.
const pagedRunner = await startRunner(jobs, PAGED, { runMode: "parallel" });
const runners = [
  settingsRunner,
  instanceBound,
  loggedRunner,
  trimmedRunner,
  tickerRunner,
  heldRunner,
  remoteRunner,
  freshRunner,
  pagedRunner,
];

/**
 * Triggers a run and answers its id once it is recorded: settled, or (with
 * `hold`) in progress.
 */
async function run(
  runner: BunRunner<LogRunnerArgs>,
  args: LogRunnerArgs = {},
): Promise<string> {
  const before = new Set((await runner.history()).map((one) => one.runId));
  await runner.trigger({ args });
  let runId = "";
  await waitFor(`a run of ${runner.id} to be recorded`, async () => {
    const fresh = (await runner.history()).find(
      (one) => !before.has(one.runId),
    );
    if (!fresh) {
      return false;
    }
    runId = fresh.runId;
    return args.hold !== undefined || fresh.status !== "running";
  });
  return runId;
}

const loggedRun = await run(loggedRunner, {
  lines: 4,
  consoleLines: true,
  secret: SECRET,
});
const trimmedRun = await run(trimmedRunner, { lines: TRIMMED_LINES });
const heldFinished = [await run(heldRunner), await run(heldRunner)];
const heldRun = await run(heldRunner, { lines: 1, hold: gate("held-run") });
const remoteFinished = [await run(remoteRunner), await run(remoteRunner)];
const remoteRun = await run(remoteRunner, {
  lines: 1,
  hold: gate("remote-run"),
});
// The paged runner's history, oldest first: finished runs with one run left in
// flight `PAGED_HELD_AT` records from the top, so page 2 of `PAGED_PAGE` opens
// on it. Each writes one line, so each has a log for `?logs=` to open.
const pagedRuns: string[] = [];
for (let index = 0; index < PAGED_FINISHED - PAGED_HELD_AT; index++) {
  pagedRuns.push(await run(pagedRunner, { lines: 1 }));
}
const pagedHeld = await run(pagedRunner, {
  lines: 1,
  hold: gate("paged-held"),
});
for (let index = 0; index < PAGED_HELD_AT; index++) {
  pagedRuns.push(await run(pagedRunner, { lines: 1 }));
}

/** What a job asks the worker to do. */
interface JobData {
  /** How many lines to log first. */
  lines?: number;
  /** The gate to wait on after logging, keeping the job active. */
  hold?: string;
}

/** A worker that logs, then waits on the job's gate if it names one. */
async function processJob(job: {
  data: JobData;
  log: (line: string) => Promise<unknown>;
}): Promise<string> {
  for (let line = 1; line <= (job.data.lines ?? 0); line++) {
    await job.log(`line ${line}`);
  }
  if (job.data.hold !== undefined) {
    await gates.get(job.data.hold);
  }
  return "ok";
}

const reports = jobs.queue<JobData>(QUEUE);
const worker = jobs.worker<JobData, string>(QUEUE, processJob, {
  key: WORKER_KEY,
  concurrency: 2,
  waitToExit: false,
  logger: noopLogger,
});
void worker.run();

/** A job's state, straight from the store. */
async function stateOf(queue: string, id: string): Promise<string | undefined> {
  return (await jobs.queue(queue).getJob(id))?.state;
}

await reports.add("report", { lines: LOGGED_JOB_LINES }, { jobId: LOGGED_JOB });
await reports.add("report", {}, { jobId: SILENT_JOB });
await reports.add(
  "report",
  { lines: 2, hold: gate("held-job") },
  { jobId: HELD_JOB },
);
await waitFor(
  "the logged and silent jobs to complete, and the held one to be active",
  async () =>
    (await stateOf(QUEUE, LOGGED_JOB)) === "completed" &&
    (await stateOf(QUEUE, SILENT_JOB)) === "completed" &&
    (await stateOf(QUEUE, HELD_JOB)) === "active",
);

// Nothing consumes `exports` yet: the racing job waits, with a log of its own.
const exportsQueue = jobs.queue<JobData>(LATER);
await exportsQueue.add(
  "export",
  { hold: gate("racing-job") },
  { jobId: RACING_JOB },
);
const racing = (await exportsQueue.getJob(RACING_JOB))!;
for (let line = 1; line <= 3; line++) {
  await racing.log(`queued note ${line}`);
}
/** Started mid-example, to claim the racing job. */
let laterWorker: ReturnType<typeof jobs.worker<JobData, string>> | undefined;

/* --- the hosts ------------------------------------------------------- */

/** One read a host answered, as the recording middleware saw it. */
interface ApiRead {
  /** The path, under the API's base. */
  path: string;
  /** The query, without the `?`. */
  query: string;
}

/** A host: an API and the UI on an adapter of their own, listening. */
interface Host {
  /** How it is named in the output. */
  label: string;
  /** Its origin plus the API's base path. */
  api: string;
  /** Its origin plus the UI's base path. */
  ui: string;
  /** Every run-log read it answered, oldest first. */
  logReads: ApiRead[];
  /**
   * Every `GET /runners/:runner/history` it answered, oldest first — the
   * windows the pager asked for, as they went over the wire.
   */
  historyReads: ApiRead[];
  /** Stops it. */
  close: () => Promise<void>;
}

/** Serves an API over `jobs` and the UI on a fresh adapter on port 0. */
async function serveHost(
  label: string,
  options: {
    /** The actions the API allows at all. */
    actions: readonly (typeof JOBS_API_ACTIONS)[number][];
    /** `false` builds the API with no socket. */
    websocket?: false;
    /** Actions `authorize` refuses. */
    refuse?: readonly string[];
    /** Limits to narrow, where this host narrows one. */
    limits?: {
      /** The largest runner-history page it will serve (`limits.maxHistory`). */
      maxHistory: number;
    };
  },
): Promise<Host> {
  const authorize: JobsApiAuthorize = (_req, ctx) =>
    options.refuse?.includes(ctx.action)
      ? { allow: false, reason: "not on this host" }
      : true;
  const api = createJobsApi({
    jobs,
    basePath: "/jobs-api",
    authorize,
    actions: [...options.actions],
    csrf: { header: CSRF },
    ...(options.websocket === false ? { websocket: false as const } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    logger: noopLogger,
  });
  const ui = jobsUi({ api, logger: noopLogger });
  const app = new BunHttpAdapter(0, { logger: noopLogger });
  const logReads: ApiRead[] = [];
  const historyReads: ApiRead[] = [];
  app.use((req, _res, next) => {
    const url = new URL(req.originalUrl, "http://localhost");
    const read: ApiRead = {
      path: url.pathname.slice(api.basePath.length),
      query: url.search.replace(/^\?/, ""),
    };
    if (/\/runs\/[^/]+\/logs$/.test(url.pathname)) {
      logReads.push(read);
    } else if (req.method === "GET" && url.pathname.endsWith("/history")) {
      // A GET only: `DELETE …/history` is Clear history…, not a page of one.
      historyReads.push(read);
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
    label,
    api: `${origin}${api.basePath}`,
    ui: `${origin}${ui.basePath}`,
    logReads,
    historyReads,
    close: async () => {
      await app.close();
      await api.close();
    },
  };
}

const defaults = JOBS_API_ACTIONS.filter(
  (action) => !JOBS_API_OPT_IN_ACTIONS.has(action),
);
const full = await serveHost("full", { actions: JOBS_API_ACTIONS });
const socketless = await serveHost("socketless", {
  actions: JOBS_API_ACTIONS,
  websocket: false,
});
const unlisted = await serveHost("unlisted", {
  actions: defaults.filter(
    (action) => !(GATED_ACTIONS as readonly string[]).includes(action),
  ),
});
const refused = await serveHost("refused", {
  actions: JOBS_API_ACTIONS,
  refuse: GATED_ACTIONS,
});
// `full`'s actions over an API whose largest history page is `HISTORY_CAP`,
// smaller than `PAGED`'s stored runs. The cap bounds a page, so the runs below
// it are in no page at all and only an offset reaches them.
const capped = await serveHost("capped", {
  actions: JOBS_API_ACTIONS,
  limits: { maxHistory: HISTORY_CAP },
});
const hosts = [full, socketless, unlisted, refused, capped];

/** Winds everything down; safe to call more than once. */
async function shutdown(view?: Bun.WebView): Promise<void> {
  view?.close();
  for (const open of releases.values()) {
    open();
  }
  for (const host of hosts) {
    await host.close();
  }
  await worker.close({ timeout: 1_000 });
  await laterWorker?.close({ timeout: 1_000 });
  for (const runner of runners) {
    await runner.stop({ force: true }).catch(() => undefined);
  }
  // The contexts share one driver, which the first to close closes.
  await remote.close().catch(() => undefined);
  await jobs.close();
}

/** A JSON read from a host's API, bypassing the page. */
async function read<T>(host: Host, path: string): Promise<T> {
  const response = await fetch(`${host.api}${path}`);
  return (await response.json()) as T;
}

/** The part of `GET /runners/:runner` this example reads. */
interface RunnerBody {
  /** The settings in force. */
  executionMode: string;
  /** Whether runs may overlap. */
  runMode: string;
  /** The cap, when there is one. */
  maxConcurrency?: number;
  /** The configuration, with what is overridden. */
  config: {
    /** What is in force. */
    effective: {
      /** Where runs execute. */
      executionMode: string;
      /** Whether runs may overlap. */
      runMode: string;
      /** The cap, `null` for unlimited. */
      maxConcurrency: number | null;
    };
    /** The overridden keys. */
    overridden: string[];
    /** The stored override's version. */
    seq: number;
    /** The version the owner runs. */
    appliedSeq?: number;
    /** The execution modes an override may choose. */
    allowed?: string[];
    /** Why the owner refused part of the override, when it did. */
    error?: {
      /** When it refused, epoch ms. */
      at: number;
      /** Its reason. */
      message: string;
      /** The refused settings, in executionMode, runMode, maxConcurrency order. */
      keys: string[];
    };
  };
}

/** A run record as the history lists it. */
interface RunItem {
  /** Its id. */
  runId: string;
  /** Its status. */
  status: string;
}

/** The ids and statuses of a runner's history, as the API lists them. */
async function historyOf(runner: string): Promise<RunItem[]> {
  const { items } = await read<{ items: RunItem[] }>(
    full,
    `/runners/${runner}/history`,
  );
  return items.map(({ runId, status }) => ({ runId, status }));
}

/** What one `GET /runners/:runner/history` answered, straight from the API. */
interface HistoryProbe {
  /** The response's status. */
  status: number;
  /** The run ids it answered, newest first; empty when it refused. */
  ids: string[];
  /** The whole history's size it reported, or `null` when it refused. */
  total: number | null;
  /** The problem's `code` when it refused, else `null`. */
  code: string | null;
}

/**
 * `GET /runners/:runner/history?<query>` on `host`, bypassing the page. Used
 * to measure what one page of a host can and cannot return, which is the
 * premise the reachability checks rest on rather than an assumption.
 */
async function historyProbe(
  host: Host,
  runner: string,
  query: string,
): Promise<HistoryProbe> {
  const response = await fetch(
    `${host.api}/runners/${runner}/history?${query}`,
  );
  const body = (await response.json()) as {
    /** The page's records, when it answered one. */
    items?: RunItem[];
    /** The page's report of the whole history. */
    page?: { total: number };
    /** The problem's code, when it refused. */
    code?: string;
  };
  return {
    status: response.status,
    ids: (body.items ?? []).map((one) => one.runId),
    total: body.page?.total ?? null,
    code: body.code ?? null,
  };
}

/**
 * The history windows the UI asked `host` for after its `from`th history read,
 * each as `offset/limit/order`, de-duplicated in the order they were first
 * seen. The card polls, so one window is read many times over; what a page
 * turn changes is *which* window, and that is what this shows.
 */
function historyWindowsSince(host: Host, from: number): string[] {
  const windows: string[] = [];
  for (const { query } of host.historyReads.slice(from)) {
    const asked = new URLSearchParams(query);
    const window = `${asked.get("offset")}/${asked.get("limit")}/${asked.get("order")}`;
    if (!windows.includes(window)) {
      windows.push(window);
    }
  }
  return windows;
}

/** `GET /queues/:queue/jobs/:id/logs`' count. */
async function jobLogTotal(queue: string, id: string): Promise<number> {
  const { page } = await read<{ page: { total: number } }>(
    full,
    `/queues/${queue}/jobs/${id}/logs?limit=100`,
  );
  return page.total;
}

/* --- the browser: skip, not fail, if Chrome will not start --------- */

/** What the page printed to its console, for a failure's diagnosis. */
const pageConsole: string[] = [];
const view = await openView(chromePath, pageConsole, shutdown);

title("The runner and job tools, in Chrome");
show("Chrome", chromePath);
for (const host of hosts) {
  show(`serving ${host.label}`, host.ui);
}

/* --- selectors ----------------------------------------------------- */

/** The open dialog. */
const DIALOG = "dialog[open]";
/** The toasts. */
const TOASTS = 'ol[aria-label="Notifications"]';
/** The runner's action buttons. */
const RUNNER_ACTIONS = '[role="group"][aria-label="Runner actions"]';
/** The History card's header, where Clear history… sits beside "Runs shown". */
const HISTORY_ACTIONS = ".history-actions";
/** The History card's pager, under the table. */
const HISTORY_PAGER = 'nav.pager[aria-label="History pages"]';
/** The note saying the run whose log `?logs=` opens is not on this page. */
const OFF_PAGE_NOTE = '[data-testid="history-open-log-note"]';
/** An empty state's headline. */
const EMPTY_TITLE = ".empty-state-title";
/** The runner summary. */
const RUNNER_SUMMARY = ".runner-summary";
/** The job's action buttons. */
const JOB_ACTIONS = '[role="group"][aria-label="Job actions"]';
/** The job summary. */
const JOB_SUMMARY = ".job-summary";
/** The Logs card's controls, where Clear logs… sits. */
const LOG_CONTROLS = ".job-logs-controls";
/** The Logs card's lines. */
const JOB_LOG_LINES = 'ol[aria-label="Log lines"] > li';
/** The live badge, once the socket is up. */
const LIVE = '[data-testid="live-status"][data-state="live"]';

/** Opens a runner's screen (with `query`) and waits for its summary. */
async function openRunner(
  host: Host,
  runner: string,
  query = "",
): Promise<boolean> {
  await view.navigate(`${host.ui}/runners/${runner}${query}`);
  return view.evaluate<boolean>(waitForSelector(RUNNER_SUMMARY));
}

/** Opens a job's screen and waits for its id to show. */
async function openJob(
  host: Host,
  queue: string,
  id: string,
): Promise<string | null> {
  await view.navigate(`${host.ui}/queues/${queue}/jobs/${id}`);
  return view.evaluate<string | null>(textOf('[data-testid="job-id"]'));
}

/** The job summary's row labelled `label`, once `ready` holds for it. */
function jobRow(label: string, ready?: string): Promise<SummaryRow | null> {
  return view.evaluate<SummaryRow | null>(
    summaryRow(JOB_SUMMARY, label, ready),
  );
}

/** The runner summary's row labelled `label`, once `ready` holds for it. */
function runnerRow(label: string, ready?: string): Promise<SummaryRow | null> {
  return view.evaluate<SummaryRow | null>(
    summaryRow(RUNNER_SUMMARY, label, ready),
  );
}

/**
 * Opens Settings… and reads the dialog's refusal note, split around its
 * relative time: the text before it, the `<time>`'s instant, and the text
 * after it. `null` when the note never shows. Closes the dialog again.
 */
async function refusedNote(): Promise<{
  prefix: string;
  when: string | null;
  suffix: string;
} | null> {
  if (
    !(await view.evaluate<boolean>(button(RUNNER_ACTIONS, "Settings…", true)))
  ) {
    return null;
  }
  const selector = `${DIALOG} [data-testid="config-refused"]`;
  const note = (await view.evaluate<boolean>(waitForSelector(selector)))
    ? await view.evaluate<{
        prefix: string;
        when: string | null;
        suffix: string;
      } | null>(`(() => {
        const note = document.querySelector(${JSON.stringify(selector)});
        const time = note?.querySelector("time");
        if (!note || !time) return null;
        const text = note.textContent;
        const at = text.indexOf(time.textContent);
        return {
          prefix: text.slice(0, at),
          when: time.getAttribute("datetime"),
          suffix: text.slice(at + time.textContent.length),
        };
      })()`)
    : null;
  await view.evaluate<boolean>(button(DIALOG, "Cancel", true));
  await view.evaluate<boolean>(gone(DIALOG));
  return note;
}

/** The run log's notes' text, once it includes `text` (else `false`). */
function notesSay(runId: string, text: string): Promise<boolean> {
  return view.evaluate<boolean>(
    textIncludes(`[data-testid="run-logs-${runId}"] .run-log-notes`, text),
  );
}

/** The lines of run `runId`'s open log, once `ready` holds for them. */
function logLines(runId: string, ready: string): Promise<RunLogLine[]> {
  return view.evaluate<RunLogLine[]>(runLogLines(runId, ready));
}

try {
  /* ---------------------------------------------------------------- */
  step(`Settings… on ${SETTINGS}: execution mode, run mode, max concurrency`);

  check(
    "the runner screen shows its summary",
    await openRunner(full, SETTINGS),
    pageConsole,
  );
  checkEqual(
    "before: no override, and the rows carry no override note",
    [
      (await runnerRow("Settings override"))?.value,
      (await runnerRow("Execution mode"))?.hint,
    ],
    ["None: as the runner's code asks", null],
  );
  check(
    "Settings… is offered (runners.configure is listed on this host), and opens",
    (await view.evaluate<boolean>(button(RUNNER_ACTIONS, "Settings…", true))) &&
      (await view.evaluate<boolean>(waitForSelector(DIALOG))),
  );
  check(
    "child-process is not offered, and the dialog says why",
    await view.evaluate<boolean>(
      textIncludes(
        `${DIALOG} [data-testid="config-modes-limited"]`,
        "child-process is not offered: this runner's code permits only worker-thread, in-process",
      ),
    ),
  );
  check(
    'the hint names what the code asks for: "This runner\'s code asks for in-process."',
    await view.evaluate<boolean>(
      textIncludes(DIALOG, "This runner's code asks for in-process."),
    ),
  );
  check(
    "Execution mode → worker-thread",
    await view.evaluate<boolean>(
      chooseOption(DIALOG, "Execution mode", "worker-thread"),
    ),
  );
  check(
    "which warns that a run in flight keeps its mode",
    await view.evaluate<boolean>(
      textIncludes(
        `${DIALOG} [data-testid="config-warning-execution-mode"]`,
        "worker-thread applies from the next run",
      ),
    ),
  );
  check(
    "Run mode → parallel",
    await view.evaluate<boolean>(chooseOption(DIALOG, "Run mode", "parallel")),
  );
  check(
    "Max concurrency (enabled once parallel) → 3",
    await view.evaluate<boolean>(focusField(DIALOG, "Max concurrency")),
  );
  await view.type("3");
  check(
    "Save settings, which closes the dialog",
    (await view.evaluate<boolean>(button(DIALOG, "Save settings", true))) &&
      (await view.evaluate<boolean>(gone(DIALOG))),
  );
  await waitFor("the runner to adopt the override", async () => {
    const { config } = await read<RunnerBody>(full, `/runners/${SETTINGS}`);
    return config.seq > 0 && config.appliedSeq === config.seq;
  });
  const configured = await read<RunnerBody>(full, `/runners/${SETTINGS}`);
  checkEqual(
    "GET the runner → overridden: all three, adopted, in force: worker-thread, parallel, 3",
    [
      [...configured.config.overridden].sort(),
      configured.config.effective,
      [configured.executionMode, configured.runMode, configured.maxConcurrency],
    ],
    [
      ["executionMode", "maxConcurrency", "runMode"],
      {
        executionMode: "worker-thread",
        runMode: "parallel",
        maxConcurrency: 3,
      },
      ["worker-thread", "parallel", 3],
    ],
  );
  checkEqual(
    'adopted, the summary rows read "Overridden here; its code asks for …"',
    [
      await runnerRow("Execution mode", 'row.value === "worker-thread"'),
      await runnerRow("Run mode", 'row.value === "parallel"'),
      await runnerRow("Max concurrency", 'row.value === "3"'),
    ],
    [
      {
        value: "worker-thread",
        hint: "Overridden here; its code asks for in-process",
      },
      { value: "parallel", hint: "Overridden here; its code asks for single" },
      { value: "3", hint: "Overridden here; its code asks for unlimited" },
    ],
  );
  const override = await runnerRow(
    "Settings override",
    'row.value !== "None: as the runner\'s code asks" && row.hint === null',
  );
  checkEqual(
    "the override row lists all three, with nothing waiting to be adopted",
    [override?.value.split(", ").sort(), override?.hint],
    [["Execution mode", "Max concurrency", "Run mode"], null],
  );

  check(
    "Settings… again: Reset to code defaults",
    (await view.evaluate<boolean>(button(RUNNER_ACTIONS, "Settings…", true))) &&
      (await view.evaluate<boolean>(
        button(DIALOG, "Reset to code defaults", true),
      )) &&
      (await view.evaluate<boolean>(gone(DIALOG))),
  );
  await waitFor("the API to report no override", async () => {
    const { config } = await read<RunnerBody>(full, `/runners/${SETTINGS}`);
    return config.overridden.length === 0;
  });
  const reset = await read<RunnerBody>(full, `/runners/${SETTINGS}`);
  checkEqual(
    "GET the runner → no override, back to in-process, single, unlimited",
    reset.config.effective,
    { executionMode: "in-process", runMode: "single", maxConcurrency: null },
  );
  checkEqual(
    "the summary says so, and the override notes are gone",
    [
      (
        await runnerRow(
          "Settings override",
          'row.value === "None: as the runner\'s code asks"',
        )
      )?.value,
      (await runnerRow("Execution mode", 'row.value === "in-process"'))?.hint,
    ],
    ["None: as the runner's code asks", null],
  );

  /* ---------------------------------------------------------------- */
  step(`${INSTANCE_BOUND}: built from a driver instance, so no worker-thread`);

  checkEqual(
    "GET the runner → allowed: in-process only, though its allowedOverrides names worker-thread too",
    (await read<RunnerBody>(full, `/runners/${INSTANCE_BOUND}`)).config.allowed,
    ["in-process"],
  );
  check(
    "Settings… opens",
    (await openRunner(full, INSTANCE_BOUND)) &&
      (await view.evaluate<boolean>(
        button(RUNNER_ACTIONS, "Settings…", true),
      )) &&
      (await view.evaluate<boolean>(waitForSelector(DIALOG))),
  );
  checkEqual(
    "its Execution mode offers in-process alone: neither worker-thread nor child-process",
    await view.evaluate<string[] | null>(
      `new Promise((resolve) => {
        const deadline = Date.now() + 10000;
        const poll = () => {
          for (const label of document.querySelectorAll("${DIALOG} label")) {
            if (!label.textContent.trim().startsWith("Execution mode")) continue;
            const select = document.getElementById(label.htmlFor);
            if (select) return resolve(Array.from(select.options, (option) => option.value));
          }
          if (Date.now() > deadline) return resolve(null);
          setTimeout(poll, 50);
        };
        poll();
      })`,
    ),
    ["in-process"],
  );
  check(
    "and the dialog says why the others are missing",
    await view.evaluate<boolean>(
      textIncludes(
        `${DIALOG} [data-testid="config-modes-limited"]`,
        "this runner's code permits only in-process",
      ),
    ),
  );
  check(
    "Cancel closes it",
    (await view.evaluate<boolean>(button(DIALOG, "Cancel", true))) &&
      (await view.evaluate<boolean>(gone(DIALOG))),
  );
  const forced = await fetch(`${full.api}/runners/${INSTANCE_BOUND}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json", [CSRF]: "1" },
    body: JSON.stringify({ executionMode: "worker-thread" }),
  });
  const forcedBody = (await forced.json()) as {
    code?: string;
    context?: { allowed?: string[] };
  };
  checkEqual(
    'a direct PUT {"executionMode":"worker-thread"} → 409 CONFIG_NOT_ALLOWED, context.allowed ["in-process"]',
    [forced.status, forcedBody.code, forcedBody.context?.allowed],
    [409, "CONFIG_NOT_ALLOWED", ["in-process"]],
  );
  checkEqual(
    "and nothing was stored",
    (await read<RunnerBody>(full, `/runners/${INSTANCE_BOUND}`)).config
      .overridden,
    [],
  );

  /* ---------------------------------------------------------------- */
  step(`${REDEPLOYED}: an override its owner refuses`);

  // Before: registered in another context that can hand a Worker a backend,
  // it adopts worker-thread, parallel, 2.
  const before = await startRunner(remote, REDEPLOYED, {
    childDriver: { type: "memory" },
  });
  runners.push(before);
  const stored = await fetch(`${full.api}/runners/${REDEPLOYED}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json", [CSRF]: "1" },
    body: JSON.stringify({
      executionMode: "worker-thread",
      concurrency: { runMode: "parallel", maxConcurrency: 2 },
    }),
  });
  checkEqual("the PUT is accepted (200)", stored.status, 200);
  await waitFor(
    "the first owner to adopt worker-thread",
    () =>
      before.config.appliedSeq === before.config.seq &&
      before.config.effective.executionMode === "worker-thread",
  );
  // After a redeploy, built here from the driver instance alone.
  await before.stop({ force: true });
  runners.push(await startRunner(jobs, REDEPLOYED));
  await waitFor("the new owner to report its refusal", async () => {
    const { config } = await read<RunnerBody>(full, `/runners/${REDEPLOYED}`);
    return config.error !== undefined && config.appliedSeq === config.seq;
  });
  const redeployed = await read<RunnerBody>(full, `/runners/${REDEPLOYED}`);
  checkEqual(
    "GET the runner → all three still stored, worker-thread dropped from what runs, and why",
    [
      [...redeployed.config.overridden].sort(),
      redeployed.config.effective,
      redeployed.config.error?.message,
    ],
    [
      ["executionMode", "maxConcurrency", "runMode"],
      { executionMode: "in-process", runMode: "parallel", maxConcurrency: 2 },
      'executionMode "worker-thread" needs a driver config for the child, and this runner was built from a driver instance',
    ],
  );
  checkEqual(
    "and config.error.keys names executionMode alone: runMode and maxConcurrency were adopted",
    redeployed.config.error?.keys,
    ["executionMode"],
  );
  check(
    "the runner screen shows its summary",
    await openRunner(full, REDEPLOYED),
  );
  checkEqual(
    "the refused row says so; the adopted ones still read as overridden",
    [
      await runnerRow("Execution mode", "row.hint !== null"),
      await runnerRow("Run mode", 'row.value === "parallel"'),
      await runnerRow("Max concurrency", 'row.value === "2"'),
    ],
    [
      {
        value: "in-process",
        hint: "Override refused by the owner; it runs what its code asks for, in-process",
      },
      { value: "parallel", hint: "Overridden here; its code asks for single" },
      { value: "2", hint: "Overridden here; its code asks for unlimited" },
    ],
  );
  checkEqual(
    "and the Settings override row names the refused setting, with the owner's reason",
    (await runnerRow("Settings override", "row.hint !== null"))?.hint,
    `The owner refused Execution mode: ${redeployed.config.error?.message}`,
  );
  checkEqual(
    "the Settings… dialog names it too, and when: The owner refused Execution mode <when>: <reason>",
    await refusedNote(),
    {
      prefix: "The owner refused Execution mode ",
      when: new Date(redeployed.config.error!.at).toISOString(),
      suffix: `: ${redeployed.config.error?.message}`,
    },
  );

  // An adopted override equal to the code's value: `single` is what this
  // runner's code asks for. Before the refusal named its keys, a row whose
  // value matched the code's read as refused; `keys` says it was adopted.
  // Only `concurrency` is sent: the API now knows this owner allows
  // in-process alone, so a PUT naming worker-thread would be 409 up front, and
  // the stored worker-thread is left as it is.
  const equal = await fetch(`${full.api}/runners/${REDEPLOYED}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json", [CSRF]: "1" },
    body: JSON.stringify({ concurrency: { runMode: "single" } }),
  });
  checkEqual(
    "PUT concurrency runMode single (the code's own), worker-thread still stored → 200",
    equal.status,
    200,
  );
  await waitFor("the owner to refuse the new override too", async () => {
    const { config } = await read<RunnerBody>(full, `/runners/${REDEPLOYED}`);
    return (
      config.error !== undefined &&
      config.appliedSeq === config.seq &&
      config.seq > redeployed.config.seq
    );
  });
  const same = await read<RunnerBody>(full, `/runners/${REDEPLOYED}`);
  checkEqual(
    "GET the runner → executionMode and runMode stored, runMode single in force (as the code asks), keys still [executionMode]",
    [
      [...same.config.overridden].sort(),
      same.config.effective,
      same.config.error?.keys,
    ],
    [
      ["executionMode", "runMode"],
      {
        executionMode: "in-process",
        runMode: "single",
        maxConcurrency: null,
      },
      ["executionMode"],
    ],
  );
  check(
    "the runner screen shows its summary",
    await openRunner(full, REDEPLOYED),
  );
  checkEqual(
    'the Run mode row reads "Overridden here", though its value is the code\'s; Execution mode still refused',
    [
      await runnerRow("Execution mode", "row.hint !== null"),
      await runnerRow("Run mode", 'row.value === "single"'),
      await runnerRow("Settings override", "row.hint !== null"),
    ],
    [
      {
        value: "in-process",
        hint: "Override refused by the owner; it runs what its code asks for, in-process",
      },
      { value: "single", hint: "Overridden here; its code asks for single" },
      {
        value: "Execution mode, Run mode",
        hint: `The owner refused Execution mode: ${same.config.error?.message}`,
      },
    ],
  );

  /* ---------------------------------------------------------------- */
  step("A finished run's log, in its history row's details");

  check(
    `${LOGGED}'s history lists the run`,
    (await openRunner(full, LOGGED)) &&
      (await view.evaluate<boolean>(
        waitForSelector(`[data-testid="history-row-${loggedRun}"]`),
      )),
  );
  check(
    "the row's disclosure opens its details, which offer Show log",
    (await view.evaluate<boolean>(
      `(() => { const toggle = document.querySelector('button[aria-label="Show run ${loggedRun}"]'); toggle?.click(); return toggle !== null; })()`,
    )) &&
      (await view.evaluate<boolean>(
        button(".run-details-row", "Show log", true),
      )),
  );
  const everyStream = await logLines(loggedRun, "lines.length >= 7");
  checkEqual(
    "Show log: 7 lines, in order — 4 of ctx.log, stdout, stderr, the secret",
    everyStream.map((line) => [line.seq, line.stream]),
    [
      [1, "logger"],
      [2, "logger"],
      [3, "logger"],
      [4, "logger"],
      [5, "stdout"],
      [6, "stderr"],
      [7, "logger"],
    ],
  );
  checkEqual(
    "the URL names the open log",
    await view.evaluate<string | null>(
      `new URL(location.href).searchParams.get("logs")`,
    ),
    loggedRun,
  );
  check(
    "the secret is stored redacted: the page shows password=[REDACTED], never the value",
    everyStream.at(-1)?.text === "connecting with password=[REDACTED]" &&
      !(await view.evaluate<boolean>(
        `document.body.textContent.includes(${JSON.stringify(SECRET)})`,
      )),
    everyStream.at(-1),
  );
  check(
    "and the redaction note says values that look like secrets are replaced",
    await view.evaluate<boolean>(
      textIncludes(
        `[data-testid="run-logs-${loggedRun}"] .run-log-redaction`,
        "Values that look like secrets are replaced with [REDACTED]",
      ),
    ),
  );
  check(
    "Stream → stderr",
    await view.evaluate<boolean>(
      chooseOption(`[data-testid="run-logs-${loggedRun}"]`, "Stream", "stderr"),
    ),
  );
  const stderrOnly = await logLines(
    loggedRun,
    'lines.length === 1 && lines[0].stream === "stderr"',
  );
  checkEqual(
    "the log narrows to the one stderr line, its seq kept",
    stderrOnly,
    [
      {
        seq: 6,
        stream: "stderr",
        text: "[run output] page 2 had a broken image",
      },
    ],
  );
  const fromBefore = full.logReads.length;
  checkEqual(
    "the filter is in the URL",
    await view.evaluate<string | null>(
      `new URL(location.href).searchParams.get("logStream")`,
    ),
    "stderr",
  );
  check(
    "Stream → logger: the handler's own 5 lines",
    (await view.evaluate<boolean>(
      chooseOption(`[data-testid="run-logs-${loggedRun}"]`, "Stream", "log"),
    )) &&
      (
        await logLines(
          loggedRun,
          'lines.length === 5 && lines.every((line) => line.stream === "logger")',
        )
      ).length === 5,
  );
  await waitFor(
    "the UI to read the log with stream=log",
    () =>
      full.logReads
        .slice(fromBefore)
        .some((one) => one.query.includes("stream=log")),
    { timeout: 5_000 },
  );
  check("the read it sent carried stream=log", true);

  /* ---------------------------------------------------------------- */
  step(`${TRIMMED}: a cap that bit, finished and still going`);

  check(
    "the history row carries a badge: 4 lines dropped",
    (await openRunner(full, TRIMMED)) &&
      (await view.evaluate<boolean>(
        textIncludes(
          `[data-testid="history-row-${trimmedRun}"]`,
          `${TRIMMED_LINES - TRIMMED_KEEPS} lines dropped`,
        ),
      )),
  );
  check(
    "the row's Log button opens the log",
    await view.evaluate<boolean>(
      button(`[data-testid="history-row-${trimmedRun}"]`, "Log", true),
    ),
  );
  const trimmedLines = await logLines(trimmedRun, "lines.length >= 3");
  checkEqual(
    "3 lines kept, numbered from 5: the gap is where the lines went",
    trimmedLines.map((line) => line.seq),
    [5, 6, 7],
  );
  check(
    'the notes say "4 earlier lines dropped"',
    await notesSay(
      trimmedRun,
      `${TRIMMED_LINES - TRIMMED_KEEPS} earlier lines dropped`,
    ),
  );
  check(
    'but not "A cap is trimming this log now": the run has finished',
    !(await notesSay(trimmedRun, "A cap is trimming this log now")),
  );

  const cappedRun = await run(trimmedRunner, {
    lines: TRIMMED_LINES,
    hold: gate("capped-run"),
  });
  await waitFor(
    "the held run's log to reach its cap",
    async () =>
      (
        await read<{ dropped: number }>(
          full,
          `/runners/${TRIMMED}/runs/${cappedRun}/logs`,
        )
      ).dropped ===
      TRIMMED_LINES - TRIMMED_KEEPS,
  );
  await openRunner(full, TRIMMED, `?logs=${cappedRun}`);
  check(
    `a run still going past its cap (?logs=${cappedRun.slice(0, 8)}…): "A cap is trimming this log now"`,
    (await notesSay(cappedRun, "A cap is trimming this log now")) &&
      (await notesSay(cappedRun, "4 earlier lines dropped")),
  );
  release("capped-run");
  await waitFor("the capped run to finish", async () => {
    const record = (await historyOf(TRIMMED)).find(
      (one) => one.runId === cappedRun,
    );
    return record?.status === "success";
  });
  check(
    "once it finishes, the present-tense note goes",
    await view.evaluate<boolean>(
      `new Promise((resolve) => {
        const deadline = Date.now() + 15000;
        const poll = () => {
          const notes = document.querySelector('[data-testid="run-logs-${cappedRun}"] .run-log-notes')?.textContent ?? "";
          if (notes.includes("earlier lines dropped") && !notes.includes("A cap is trimming")) return resolve(true);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(poll, 50);
        };
        poll();
      })`,
    ),
  );

  /* ---------------------------------------------------------------- */
  step(
    `${PAGED}: ${PAGED_RECORDS} stored runs, paged on the server in ${PAGED_PAGE}s`,
  );

  /** Page-side: the run ids of the history rows on screen, once `ready(ids)` holds. */
  function historyRows(ready = "true", ms = 15_000): string {
    return poll(
      `(() => {
        const ids = [...document.querySelectorAll('.history-table tr[data-testid^="history-row-"]')]
          .map((row) => row.dataset.testid.slice("history-row-".length));
        return (${ready}) ? ids : null;
      })()`,
      ms,
    );
  }

  /**
   * Page-side: the URL's query parameters as sorted `key=value` strings, once
   * `ready(params)` holds for them. Sorted because `update()` merges a patch
   * into whatever was there, so the order a link ends up in is not the point.
   */
  function urlParams(ready = "true"): string {
    return poll(`(() => {
      const params = [...new URLSearchParams(location.search).entries()]
        .map(([key, value]) => key + "=" + value).sort();
      return (${ready}) ? params : null;
    })()`);
  }

  /** Page-side: the History card's "Runs shown" select, once `ready(shown)` holds. */
  function runsShown(ready = "true"): string {
    return poll(`(() => {
      const select = document.querySelector(".history-limit select");
      if (!select) return null;
      const shown = {
        value: select.value,
        options: [...select.options].map((option) => option.value),
      };
      return (${ready}) ? shown : null;
    })()`);
  }

  /** Page-side: the status cell of history row `runId`, once it reads `want`. */
  function rowStatus(runId: string, want: string, ms = 15_000): string {
    return poll(
      `(() => {
        const row = document.querySelector('.history-table tr[data-testid="history-row-${runId}"]');
        const status = row?.querySelectorAll("td")[2]?.textContent.trim() ?? null;
        return status === ${JSON.stringify(want)} ? status : null;
      })()`,
      ms,
    );
  }

  /** The window `offset` names, spelled as `historyWindowsSince` prints one. */
  const wire = (offset: number): string => `${offset}/${PAGED_PAGE}/desc`;

  const storedRuns = await historyOf(PAGED);
  /** Every stored run id, newest first, as the API lists them. */
  const storedIds = storedRuns.map((one) => one.runId);
  /** The oldest run of all: the last record, `PAGED_RECORDS` deep. */
  const oldestRun = pagedRuns[0]!;
  checkEqual(
    `the API lists ${PAGED_RECORDS} records — ${PAGED_FINISHED} finished, one still in flight ${PAGED_HELD_AT} down`,
    [
      storedRuns.length,
      storedRuns
        .filter((one) => one.status === "running")
        .map((one) => one.runId),
      storedRuns[PAGED_HELD_AT]?.runId,
      storedIds.at(-1),
    ],
    [PAGED_RECORDS, [pagedHeld], pagedHeld, oldestRun],
  );

  // On an API with the default limits a page is 50 runs (`min(50,
  // limits.maxHistory)`), so this whole history is one page and grows no pager
  // at all. The pager follows the history's size against the page size — not
  // the length of what a fetch happened to return.
  check(
    `${PAGED}'s history opens on ${full.label}`,
    (await openRunner(full, PAGED)) &&
      (await view.evaluate<boolean>(waitForSelector(".history-table"))),
  );
  checkEqual(
    `all ${PAGED_RECORDS} of them on one page of 50 there, so no pager`,
    [
      await view.evaluate<string[] | null>(
        historyRows(`ids.length === ${PAGED_RECORDS}`),
      ),
      await view.evaluate<string[] | null>(pagersWhen("labels.length === 0")),
      (
        await view.evaluate<{ value: string; options: string[] } | null>(
          runsShown(),
        )
      )?.value,
    ],
    [storedIds, [], "50"],
  );

  /* ---------------------------------------------------------------- */
  step(`${capped.label}: a largest page of ${HISTORY_CAP}, measured`);

  // The premise everything below rests on, measured on the API rather than
  // assumed. `limits.maxHistory` is the largest page this host serves, and a
  // `limit` above it is refused outright rather than quietly shortened — so the
  // runs deeper than the cap are in no page of this API, and only an offset
  // reaches them.
  const tooLarge = await historyProbe(
    capped,
    PAGED,
    `limit=${HISTORY_CAP + 1}`,
  );
  const largestPage = await historyProbe(capped, PAGED, `limit=${HISTORY_CAP}`);
  show(`${capped.label}'s largest page`, {
    limit: HISTORY_CAP,
    runs: largestPage.ids.length,
    total: largestPage.total,
    reachesTheOldest: largestPage.ids.includes(oldestRun),
  });
  checkEqual(
    `a page above the cap is 400 VALIDATION, and the largest one it will serve leaves ${PAGED_RECORDS - HISTORY_CAP} runs out`,
    [
      [tooLarge.status, tooLarge.code],
      [largestPage.ids.length, largestPage.total],
      largestPage.ids.includes(oldestRun),
    ],
    [[400, "VALIDATION"], [HISTORY_CAP, PAGED_RECORDS], false],
  );

  /* ---------------------------------------------------------------- */
  step("Every page is a read of its own window");

  /** The rows of each page walked, page 1 first. */
  const pages: string[][] = [];
  /** Each of those pages' pager, in the same order. */
  const pagers: (PagerView | null)[] = [];
  /** How many pages `PAGED_PAGE` cuts the history into. */
  const lastPage = Math.ceil(PAGED_RECORDS / PAGED_PAGE);
  const walkFrom = capped.historyReads.length;
  check(
    `page 1 of ${lastPage} on ${capped.label}`,
    (await openRunner(capped, PAGED, `?history=${PAGED_PAGE}`)) &&
      (await view.evaluate<boolean>(waitForSelector(".history-table"))),
  );
  for (let number = 1; number <= lastPage; number++) {
    if (number > 1) {
      check(
        `Next turns to page ${number}`,
        await view.evaluate<boolean>(button(HISTORY_PAGER, "Next", true)),
      );
    }
    const rows = Math.min(
      PAGED_PAGE,
      PAGED_RECORDS - (number - 1) * PAGED_PAGE,
    );
    // The previous page's rows stay on screen while the next one is read
    // (`keepPreviousData`), so waiting on the row *count* alone would read them
    // again on a page of the same size. The first id is what changes.
    const settled =
      number === 1
        ? `ids.length === ${rows}`
        : `ids.length === ${rows} && ids[0] !== ${JSON.stringify(pages[number - 2]![0])}`;
    pages.push(
      (await view.evaluate<string[] | null>(historyRows(settled))) ?? [],
    );
    pagers.push(
      await view.evaluate<PagerView | null>(
        pagerWhen("History pages", `pager.pageControl.value === "${number}"`),
      ),
    );
  }
  const walked = historyWindowsSince(capped, walkFrom);
  show(`the windows those ${lastPage} pages asked for`, walked);
  /** The window each of those pages had to ask for, in the order walked. */
  const expected: string[] = [];
  for (let number = 0; number < lastPage; number++) {
    expected.push(wire(number * PAGED_PAGE));
  }
  checkEqual(
    "the landing and each turn are reads of their own window: the offset moves, nothing else does",
    walked,
    expected,
  );
  checkEqual(
    `the ${lastPage} pages are disjoint and cover every stored run, in the API's order`,
    pages.flat(),
    storedIds,
  );
  checkEqual(
    "and every range counts the whole history, never the page",
    pagers.map((pager) => pager?.range),
    Array.from({ length: lastPage }, (_unused, index) => {
      const from = index * PAGED_PAGE + 1;
      return `${from}–${Math.min(PAGED_RECORDS, from + PAGED_PAGE - 1)} of ${PAGED_RECORDS}`;
    }),
  );
  checkEqual(
    `with one entry per page, and only the sizes the ${HISTORY_CAP}-run cap allows`,
    [
      pagers[0]?.pageControl?.options,
      pagers[0]?.sizes,
      [pagers[0]?.prev, pagers[0]?.next],
      [pagers[lastPage - 1]?.prev, pagers[lastPage - 1]?.next],
    ],
    [
      Array.from({ length: lastPage }, (_unused, index) => String(index + 1)),
      [PAGED_PAGE, HISTORY_CAP],
      [false, true],
      [true, false],
    ],
  );

  /* ---------------------------------------------------------------- */
  step(`A run stored past ${capped.label}'s page cap, reached by offset`);

  // `limits.maxHistory` caps a page; `keepHistory` is how many runs are stored.
  // The offset is bounded by neither, and that is what makes the whole history
  // reachable: the oldest run here is record `PAGED_RECORDS` of
  // `PAGED_RECORDS`, and the deepest row any page of this API can hold is
  // `HISTORY_CAP`.
  const deepFrom = capped.historyReads.length;
  await openRunner(
    capped,
    PAGED,
    `?history=${PAGED_PAGE}&offset=${PAGED_RECORDS - 1}`,
  );
  const deepRows = await view.evaluate<string[] | null>(
    historyRows("ids.length === 1"),
  );
  const deepPager = await view.evaluate<PagerView | null>(
    pagerOf("History pages"),
  );
  checkEqual(
    `offset ${PAGED_RECORDS - 1} reaches the oldest run, ${PAGED_RECORDS - HISTORY_CAP} rows past the deepest a page reaches`,
    [
      deepRows,
      deepPager?.range,
      deepPager?.pageControl?.value,
      deepPager?.next,
      historyWindowsSince(capped, deepFrom),
    ],
    [
      [oldestRun],
      `${PAGED_RECORDS}–${PAGED_RECORDS} of ${PAGED_RECORDS}`,
      String(lastPage),
      false,
      [wire(PAGED_RECORDS - 1)],
    ],
  );

  /* ---------------------------------------------------------------- */
  step("An offset past the end: a page with no runs, not a runner with none");

  await openRunner(
    capped,
    PAGED,
    `?history=${PAGED_PAGE}&offset=${PAGED_RECORDS * 10}`,
  );
  const pastEnd = await view.evaluate<PagerView | null>(
    pagerWhen("History pages", `pager.range === "0 of ${PAGED_RECORDS}"`),
  );
  /** Every empty state's headline on the screen, once the history has one. */
  const empties = await view.evaluate<string[] | null>(
    textsWhen(EMPTY_TITLE, 'texts.includes("No runs on this page")'),
  );
  checkEqual(
    'it says "No runs on this page" and not "No runs yet", keeps its pager, and leaves Clear history… live',
    [
      empties?.includes("No runs on this page"),
      empties?.includes("No runs yet"),
      await view.evaluate<boolean>(gone(".history-table")),
      pastEnd?.range,
      [pastEnd?.prev, pastEnd?.next],
      await view.evaluate<boolean | null>(
        disabledButton(HISTORY_ACTIONS, "Clear history…"),
      ),
    ],
    [true, false, true, `0 of ${PAGED_RECORDS}`, [true, false], false],
  );

  /* ---------------------------------------------------------------- */
  step("A Log button writes ?logs= into the page it was pressed on");

  /** A finished run on page 2 — row 1 there is the run still in flight. */
  const onPage2 = pages[1]![1]!;
  await openRunner(
    capped,
    PAGED,
    `?history=${PAGED_PAGE}&offset=${PAGED_PAGE}`,
  );
  check(
    `page 2 is on screen, holding run ${onPage2}`,
    (await view.evaluate<string[] | null>(
      historyRows(`ids[0] === ${JSON.stringify(pages[1]![0])}`),
    )) !== null,
  );
  check(
    "its Log button opens that run's log",
    (await view.evaluate<boolean>(
      button(
        `.history-table tr[data-testid="history-row-${onPage2}"]`,
        "Log",
        true,
      ),
    )) &&
      (await view.evaluate<boolean>(
        waitForSelector(`[data-testid="run-logs-${onPage2}"]`),
      )),
  );
  const copied = await view.evaluate<string[] | null>(
    urlParams(`params.includes("logs=${onPage2}")`),
  );
  checkEqual(
    "and the URL it wrote carries the window it was pressed on, so the link can be copied",
    copied,
    [`history=${PAGED_PAGE}`, `logs=${onPage2}`, `offset=${PAGED_PAGE}`].sort(),
  );
  await openRunner(capped, PAGED, `?${(copied ?? []).join("&")}`);
  checkEqual(
    "pasted fresh, it lands on that run's page with its log open and no note",
    [
      (
        await view.evaluate<PagerView | null>(
          pagerWhen("History pages", 'pager.pageControl.value === "2"'),
        )
      )?.range,
      await view.evaluate<boolean>(
        waitForSelector(`[data-testid="run-logs-${onPage2}"]`),
      ),
      await view.evaluate<boolean>(gone(OFF_PAGE_NOTE)),
    ],
    [`${PAGED_PAGE + 1}–${2 * PAGED_PAGE} of ${PAGED_RECORDS}`, true, true],
  );

  /* ---------------------------------------------------------------- */
  step("A ?logs= the page does not hold: a note that claims nothing");

  /** Masks a run id, so two notes about different runs can be compared. */
  const masked = (text: string | null, runId: string): string | null =>
    text === null ? null : text.replace(runId, "<runId>");
  /** A run on the last page, which page 1 does not hold. */
  const furtherBack = pages[lastPage - 1]![0]!;
  /** A run id no run ever had. */
  const neverRan = "no-such-run-42";
  await openRunner(capped, PAGED, `?history=${PAGED_PAGE}&logs=${furtherBack}`);
  const elsewhereNote = await view.evaluate<string | null>(
    textOf(OFF_PAGE_NOTE),
  );
  const nothingOpened = await view.evaluate<boolean>(
    gone(`[data-testid="run-logs-${furtherBack}"]`),
  );
  show("the note on a hand-edited link", elsewhereNote);
  await openRunner(capped, PAGED, `?history=${PAGED_PAGE}&logs=${neverRan}`);
  const inventedNote = await view.evaluate<string | null>(
    textOf(OFF_PAGE_NOTE),
  );
  checkEqual(
    "a run further back and a run that never existed get the very same sentence: the card cannot tell them apart, and claims neither",
    [
      elsewhereNote?.includes(furtherBack),
      inventedNote?.includes(neverRan),
      masked(inventedNote, neverRan) === masked(elsewhereNote, furtherBack),
      elsewhereNote?.includes("is not on this page"),
      elsewhereNote?.includes("further back in the history, or gone"),
      nothingOpened,
    ],
    [true, true, true, true, true, true],
  );
  check(
    "Close log beside it clears the link: the note goes and `logs` leaves the URL",
    (await view.evaluate<boolean>(button(OFF_PAGE_NOTE, "Close log", true))) &&
      (await view.evaluate<boolean>(gone(OFF_PAGE_NOTE))) &&
      Bun.deepEquals(
        await view.evaluate<string[] | null>(
          urlParams('!params.some((one) => one.startsWith("logs="))'),
        ),
        [`history=${PAGED_PAGE}`],
      ),
  );

  /* ---------------------------------------------------------------- */
  step("Next moves with a log open, instead of snapping back to its page");

  /** The newest run, on page 1. */
  const onPage1 = pages[0]![0]!;
  await openRunner(capped, PAGED, `?history=${PAGED_PAGE}&logs=${onPage1}`);
  check(
    `page 1, with run ${onPage1}'s log open and nothing reported missing`,
    (await view.evaluate<boolean>(
      waitForSelector(`[data-testid="run-logs-${onPage1}"]`),
    )) && (await view.evaluate<boolean>(gone(OFF_PAGE_NOTE))),
  );
  check(
    "Next, with that log still open",
    await view.evaluate<boolean>(button(HISTORY_PAGER, "Next", true)),
  );
  const turnedRows = await view.evaluate<string[] | null>(
    historyRows(
      `ids.length === ${PAGED_PAGE} && ids[0] !== ${JSON.stringify(onPage1)}`,
    ),
  );
  const turned = await view.evaluate<PagerView | null>(
    pagerWhen("History pages", 'pager.pageControl.value === "2"'),
  );
  checkEqual(
    "the page really moved: page 2's rows, page 2's offset in the URL, and the open log now reported as elsewhere",
    [
      turnedRows,
      turned?.range,
      await view.evaluate<string[] | null>(
        urlParams(`params.includes("offset=${PAGED_PAGE}")`),
      ),
      await view.evaluate<boolean>(waitForSelector(OFF_PAGE_NOTE)),
      await view.evaluate<boolean>(gone(`[data-testid="run-logs-${onPage1}"]`)),
    ],
    [
      pages[1],
      `${PAGED_PAGE + 1}–${2 * PAGED_PAGE} of ${PAGED_RECORDS}`,
      [
        `history=${PAGED_PAGE}`,
        `logs=${onPage1}`,
        `offset=${PAGED_PAGE}`,
      ].sort(),
      true,
      true,
    ],
  );

  /* ---------------------------------------------------------------- */
  step("A new page size restarts paging, in either of its two controls");

  await openRunner(
    capped,
    PAGED,
    `?history=${PAGED_PAGE}&offset=${2 * PAGED_PAGE}`,
  );
  check(
    `page 3 of ${PAGED_PAGE}`,
    (await view.evaluate<PagerView | null>(
      pagerWhen("History pages", 'pager.pageControl.value === "3"'),
    )) !== null,
  );
  check(
    `the pager's own "Rows per page" takes ${HISTORY_CAP}`,
    await view.evaluate<boolean>(
      chooseOption(HISTORY_PAGER, "Rows per page", String(HISTORY_CAP)),
    ),
  );
  // The new page is read before its range can be right: the size select takes
  // the new value at once while the old page's rows are still on screen, so the
  // range would be read mid-turn. Wait for the rows, then ask the pager.
  const resizedRows = await view.evaluate<string[] | null>(
    historyRows(`ids.length === ${HISTORY_CAP}`),
  );
  const resized = await view.evaluate<PagerView | null>(
    pagerOf("History pages"),
  );
  // The pager asked to keep the first visible row (offset 20 at a size of 20),
  // and the history overruled it: offsets of the old size name different runs,
  // so a new size starts again at the first page. `history` leaves the URL too,
  // because `HISTORY_CAP` is this API's default size — the default is spelled
  // by leaving the parameter out.
  checkEqual(
    `back to the first page, with both size controls reading ${HISTORY_CAP} and neither parameter in the URL`,
    [
      resizedRows,
      resized?.range,
      resized?.size,
      resized?.pageControl?.value,
      (
        await view.evaluate<{ value: string; options: string[] } | null>(
          runsShown(`shown.value === "${HISTORY_CAP}"`),
        )
      )?.options,
      await view.evaluate<string[] | null>(urlParams("params.length === 0")),
    ],
    [
      [...pages[0]!, ...pages[1]!],
      `1–${HISTORY_CAP} of ${PAGED_RECORDS}`,
      HISTORY_CAP,
      "1",
      [String(PAGED_PAGE), String(HISTORY_CAP)],
      [],
    ],
  );

  /* ---------------------------------------------------------------- */
  step("A run finishing under the reader: its own row changes, nothing moves");

  const holdFrom = capped.historyReads.length;
  await openRunner(
    capped,
    PAGED,
    `?history=${PAGED_PAGE}&offset=${PAGED_PAGE}`,
  );
  check(
    "the socket is live, so a run's end reaches the card by its event",
    await view.evaluate<boolean>(waitForSelector(LIVE)),
  );
  const beforeRows = await view.evaluate<string[] | null>(
    historyRows(`ids.length === ${PAGED_PAGE}`),
  );
  const beforePager = await view.evaluate<PagerView | null>(
    pagerOf("History pages"),
  );
  check(
    `page 2 opens on ${pagedHeld}, still in flight`,
    beforeRows?.[0] === pagedHeld &&
      (await view.evaluate<string | null>(rowStatus(pagedHeld, "Running"))) ===
        "Running",
    { beforeRows },
  );
  release("paged-held");
  await waitFor("the held run to finish", async () => {
    const record = (await historyOf(PAGED)).find(
      (one) => one.runId === pagedHeld,
    );
    return record?.status === "success";
  });
  // A finish patches the record in place rather than adding one, so this window
  // still names the same runs. Waiting for the row itself to read Success is
  // what makes the rows below the ones the API answered *after* it settled,
  // rather than a render from before.
  const settledStatus = await view.evaluate<string | null>(
    rowStatus(pagedHeld, "Success", 30_000),
  );
  checkEqual(
    "the same runs in the same order, the same range, and that row now reading Success in place",
    [
      await view.evaluate<string[] | null>(
        historyRows(`ids.length === ${PAGED_PAGE}`),
      ),
      (await view.evaluate<PagerView | null>(pagerOf("History pages")))?.range,
      settledStatus,
      historyWindowsSince(capped, holdFrom),
    ],
    [beforeRows, beforePager?.range, "Success", [wire(PAGED_PAGE)]],
  );

  /* ---------------------------------------------------------------- */
  step("A run starting under the reader: the window holds, the rows shift");

  const startFrom = capped.historyReads.length;
  const startedRun = await run(pagedRunner, {
    lines: 1,
    hold: gate("paged-starting"),
  });
  await waitFor(
    "the new run to reach the API's history",
    async () => (await historyOf(PAGED)).length === PAGED_RECORDS + 1,
  );
  // A start *prepends* a record, so every later row shifts down one and this
  // offset now repeats the row that was last on page 1. That is offset paging,
  // not a fault, so the claim here is deliberately narrow: the window the
  // reader put in the URL is still theirs. Asserting the rows unchanged would
  // be asserting something false.
  //
  // The total moving from `PAGED_RECORDS` to one more is how this step knows
  // the start landed, and it moves only because this history is still filling
  // (`keepHistory` is 50 here, well above what it holds). Once a history is
  // full a start prepends and trims in the same breath: every row shifts, the
  // total does not move, and no field of the response differs between the two
  // reads.
  const shifted = await view.evaluate<string[] | null>(
    historyRows(
      `ids.length === ${PAGED_PAGE} && ids[0] === ${JSON.stringify(pages[0]!.at(-1))}`,
      30_000,
    ),
  );
  const grown = await view.evaluate<PagerView | null>(
    pagerWhen(
      "History pages",
      `pager.range === "${PAGED_PAGE + 1}–${2 * PAGED_PAGE} of ${PAGED_RECORDS + 1}"`,
      30_000,
    ),
  );
  checkEqual(
    "the offset is where the reader left it, the pager is still on page 2, and the rows have moved down by exactly one",
    [
      await view.evaluate<string[] | null>(
        urlParams(`params.includes("offset=${PAGED_PAGE}")`),
      ),
      grown?.pageControl?.value,
      grown?.range,
      shifted,
      historyWindowsSince(capped, startFrom),
    ],
    [
      [`history=${PAGED_PAGE}`, `offset=${PAGED_PAGE}`].sort(),
      "2",
      `${PAGED_PAGE + 1}–${2 * PAGED_PAGE} of ${PAGED_RECORDS + 1}`,
      [pages[0]!.at(-1)!, ...pages[1]!.slice(0, -1)],
      [wire(PAGED_PAGE)],
    ],
  );
  release("paged-starting");
  await waitFor(
    "the started run to finish, leaving the runner quiet",
    async () => {
      const record = (await historyOf(PAGED)).find(
        (one) => one.runId === startedRun,
      );
      return record?.status === "success";
    },
  );

  /* ---------------------------------------------------------------- */
  step("A live run, followed by the socket's logs hint");

  // Open the runner first, so the socket is up before the run begins.
  await openRunner(full, TICKER);
  check(
    "the socket is live",
    await view.evaluate<boolean>(waitForSelector(LIVE)),
  );
  const liveRun = await run(tickerRunner, {
    lines: 12,
    everyMs: 400,
    hold: gate("ticker-live"),
  });
  const liveFrom = full.logReads.length;
  await view.navigate(`${full.ui}/runners/${TICKER}?logs=${liveRun}`);
  check(
    "the log follows by the socket's notice, the poll only a fallback",
    await notesSay(
      liveRun,
      "each time its log grows the live socket says so (at most every 0.5 s)",
    ),
  );
  check(
    "and it names that fallback: a re-read every 60 s",
    await notesSay(liveRun, "A re-read every 60 s is the fallback"),
  );
  const followed = await logLines(liveRun, "lines.length >= 12");
  checkEqual(
    "all 12 lines arrive while the run goes, each once, in order",
    followed.map((line) => line.text),
    Array.from({ length: 12 }, (_, index) => `step ${index + 1}`),
  );
  const liveReads = full.logReads
    .slice(liveFrom)
    .filter((one) => one.path.endsWith(`/runs/${liveRun}/logs`));
  check(
    "they came by several reads, each after the first asking since= the last seq it held",
    liveReads.length >= 3 &&
      !liveReads[0]!.query.includes("since=") &&
      liveReads.slice(1).every((one) => one.query.includes("since=")),
    liveReads,
  );
  release("ticker-live");

  /* ---------------------------------------------------------------- */
  step("The same, without a socket: the poll every 2 s");

  const polledRun = await run(tickerRunner, {
    lines: 6,
    everyMs: 400,
    hold: gate("ticker-polled"),
  });
  const polledFrom = socketless.logReads.length;
  await openRunner(socketless, TICKER, `?logs=${polledRun}`);
  check(
    'the note says it is a poll: "re-read every 2 s. Live updates are not reaching this view"',
    await notesSay(
      polledRun,
      "Following this run: re-read every 2 s. Live updates are not reaching this view, so this is a poll.",
    ),
  );
  checkEqual(
    "the 6 lines still arrive",
    (await logLines(polledRun, "lines.length >= 6")).map((line) => line.text),
    Array.from({ length: 6 }, (_, index) => `step ${index + 1}`),
  );
  check(
    "by polled reads asking since= the cursor",
    socketless.logReads
      .slice(polledFrom)
      .some(
        (one) =>
          one.path.endsWith(`/runs/${polledRun}/logs`) &&
          one.query.includes("since="),
      ),
  );
  release("ticker-polled");
  await waitFor("the polled run to finish", async () => {
    const records = await historyOf(TICKER);
    return records.every((one) => one.status !== "running");
  });
  check(
    'once the run has finished, "Following this run" goes',
    await view.evaluate<boolean>(
      `new Promise((resolve) => {
        const deadline = Date.now() + 15000;
        const poll = () => {
          const notes = document.querySelector('[data-testid="run-logs-${polledRun}"] .run-log-notes')?.textContent ?? "";
          if (!notes.includes("Following this run")) return resolve(true);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(poll, 50);
        };
        poll();
      })`,
    ),
  );

  /* ---------------------------------------------------------------- */
  step(
    "Clear history… sits in the History card, disabled until there are runs",
  );

  check(
    `${FRESH} has never run: the History card offers Clear history…, disabled`,
    (await openRunner(full, FRESH)) &&
      (await view.evaluate<boolean>(textIncludes(".card", "No runs yet"))) &&
      (await view.evaluate<boolean | null>(
        disabledButton(HISTORY_ACTIONS, "Clear history…"),
      )) === true,
  );
  checkEqual(
    'its title says why: "No runs to clear."',
    await view.evaluate<string | null>(
      `Array.from(document.querySelectorAll('${HISTORY_ACTIONS} button')).find((b) => b.textContent.trim() === "Clear history…")?.getAttribute("title") ?? null`,
    ),
    "No runs to clear.",
  );
  check(
    'and it is not in the header\'s "Runner actions" group',
    (await view.evaluate<boolean>(button(RUNNER_ACTIONS, "Trigger…", false))) &&
      !(await view.evaluate<boolean>(
        hasButton(RUNNER_ACTIONS, "Clear history…"),
      )),
  );
  const freshRun = await run(freshRunner, { lines: 1 });
  check(
    "once a run exists (the socket refreshes the history), it enables",
    (await view.evaluate<boolean>(
      waitForSelector(`[data-testid="history-row-${freshRun}"]`),
    )) &&
      (await view.evaluate<boolean>(
        button(HISTORY_ACTIONS, "Clear history…", false),
      )) &&
      (await view.evaluate<string | null>(
        `Array.from(document.querySelectorAll('${HISTORY_ACTIONS} button')).find((b) => b.textContent.trim() === "Clear history…")?.getAttribute("title") ?? null`,
      )) === null,
  );

  /* ---------------------------------------------------------------- */
  step(`Clear history… on ${HELD} (local), with a run in progress`);

  checkEqual(
    "the API lists 2 finished runs and the one in progress",
    (await historyOf(HELD)).map((one) => one.status).sort(),
    ["running", "success", "success"],
  );
  check(
    "the screen lists all three",
    (await openRunner(full, HELD)) &&
      (await view.evaluate<boolean>(
        `new Promise((resolve) => {
          const ids = ${JSON.stringify([heldRun, ...heldFinished])};
          const deadline = Date.now() + 15000;
          const poll = () => {
            if (ids.every((id) => document.querySelector('[data-testid="history-row-' + id + '"]'))) return resolve(true);
            if (Date.now() > deadline) return resolve(false);
            setTimeout(poll, 50);
          };
          poll();
        })`,
      )),
  );
  check(
    "Clear history… opens a dialog that promises to keep runs in progress",
    (await view.evaluate<boolean>(
      button(HISTORY_ACTIONS, "Clear history…", true),
    )) &&
      (await view.evaluate<boolean>(
        textIncludes(
          DIALOG,
          "Runs still in progress are kept, record and log whole.",
        ),
      )),
  );
  check(
    "no parallel-run small print for a local runner",
    !(await view.evaluate<boolean>(
      `document.querySelector('${DIALOG} [data-testid="clear-history-parallel-note"]') !== null`,
    )),
  );
  check(
    "Clear history: the toast says 2 went and 1 was kept",
    (await view.evaluate<boolean>(button(DIALOG, "Clear history", true))) &&
      (await view.evaluate<boolean>(
        textIncludes(TOASTS, "Cleared 2 runs, kept 1 in progress"),
      )) &&
      (await view.evaluate<boolean>(textIncludes(TOASTS, `Kept: ${heldRun}`))),
  );
  checkEqual(
    "GET the history → only the run in progress, still running",
    await historyOf(HELD),
    [{ runId: heldRun, status: "running" }],
  );
  check("which this process still runs", heldRunner.activeRuns.has(heldRun));
  check(
    "the screen drops the finished rows",
    await view.evaluate<boolean>(
      gone(`[data-testid="history-row-${heldFinished[0]}"]`),
    ),
  );

  /* ---------------------------------------------------------------- */
  step(`Clear history… on ${REMOTE}, registered in another context`);

  check(
    "the screen says it is remote, and still offers Clear history…",
    (await openRunner(full, REMOTE)) &&
      (await view.evaluate<boolean>(
        waitForSelector('[data-testid="runner-non-local-hint"]'),
      )) &&
      (await view.evaluate<boolean>(
        button(HISTORY_ACTIONS, "Clear history…", true),
      )),
  );
  check(
    "the dialog adds the small print about parallel runs over a day old",
    await view.evaluate<boolean>(
      textIncludes(
        `${DIALOG} [data-testid="clear-history-parallel-note"]`,
        "a parallel run still going after a day is taken for crashed",
      ),
    ),
  );
  check(
    "Clear history: 2 went, 1 kept",
    (await view.evaluate<boolean>(button(DIALOG, "Clear history", true))) &&
      (await view.evaluate<boolean>(
        textIncludes(TOASTS, "Cleared 2 runs, kept 1 in progress"),
      )),
  );
  checkEqual(
    "GET the history → only the run in progress",
    await historyOf(REMOTE),
    [{ runId: remoteRun, status: "running" }],
  );
  checkEqual(
    "and its log is whole",
    (
      await read<{ items: { message: string }[] }>(
        full,
        `/runners/${REMOTE}/runs/${remoteRun}/logs`,
      )
    ).items.map((line) => line.message),
    ["step 1"],
  );
  check(
    "the finished runs were the ones removed",
    !(await historyOf(REMOTE)).some((one) =>
      remoteFinished.includes(one.runId),
    ),
  );

  /* ---------------------------------------------------------------- */
  step("An active job: Clear logs… disabled, Held by, Processed by");

  const held = await read<{ workerId: string }>(
    full,
    `/queues/${QUEUE}/jobs/${HELD_JOB}`,
  );
  checkEqual(
    "the job screen shows the active job",
    await openJob(full, QUEUE, HELD_JOB),
    HELD_JOB,
  );
  check(
    "its 2 log lines are drawn",
    await view.evaluate<boolean>(
      waitForSelector(`${JOB_LOG_LINES}:nth-child(2)`),
    ),
  );
  checkEqual(
    "Clear logs… is there, disabled, with the reason beside it",
    [
      await view.evaluate<boolean | null>(
        disabledButton(LOG_CONTROLS, "Clear logs…"),
      ),
      await view.evaluate<string | null>(
        textOf('[data-testid="clear-logs-reason"]'),
      ),
    ],
    [
      true,
      "Clear logs once the job finishes — a running job is still writing to them.",
    ],
  );
  checkEqual(
    "Held by names the incarnation holding it, as the API does",
    (await jobRow("Held by"))?.value,
    held.workerId,
  );
  const processedBy = await view.evaluate<{
    text: string;
    href: string | null;
  } | null>(`new Promise((resolve) => {
    const deadline = Date.now() + 10000;
    const poll = () => {
      const key = document.querySelector('[data-testid="job-processed-by-key"]');
      if (key) return resolve({ text: key.textContent.trim(), href: key.getAttribute("href") });
      if (Date.now() > deadline) return resolve(null);
      setTimeout(poll, 50);
    };
    poll();
  })`);
  check(
    `Processed by shows the key ${WORKER_KEY}, linked to its worker page`,
    processedBy?.text === WORKER_KEY &&
      (processedBy.href ?? "").endsWith(`/workers/${QUEUE}/${WORKER_KEY}`),
    processedBy,
  );
  check(
    "the link opens the worker page",
    (await view.evaluate<boolean>(
      `(() => { const link = document.querySelector('a[data-testid="job-processed-by-key"]'); link?.click(); return link !== null; })()`,
    )) &&
      (await view.evaluate<boolean>(
        textIncludes('[data-testid="worker-screen"] h1', WORKER_KEY),
      )),
    pageConsole,
  );

  /* ---------------------------------------------------------------- */
  step("A job that never logged, and one that logged 5 lines");

  checkEqual(
    "the silent job's screen",
    await openJob(full, QUEUE, SILENT_JOB),
    SILENT_JOB,
  );
  checkEqual(
    'Clear logs… is disabled: "No lines to clear."',
    [
      await view.evaluate<boolean>(textIncludes(".card", "No log lines yet.")),
      await view.evaluate<boolean | null>(
        disabledButton(LOG_CONTROLS, "Clear logs…"),
      ),
      await view.evaluate<string | null>(
        textOf('[data-testid="clear-logs-reason"]'),
      ),
    ],
    [true, true, "No lines to clear."],
  );
  check(
    "a completed job has no Held by row, but a Processed by",
    (await view.evaluate<boolean>(noSummaryRow(JOB_SUMMARY, "Held by"))) &&
      (await jobRow("Processed by"))?.value.includes(WORKER_KEY) === true,
  );

  checkEqual(
    "the logged job's screen",
    await openJob(full, QUEUE, LOGGED_JOB),
    LOGGED_JOB,
  );
  check(
    "its 5 lines are drawn, and Clear logs… is enabled with no reason",
    (await view.evaluate<boolean>(
      waitForSelector(`${JOB_LOG_LINES}:nth-child(${LOGGED_JOB_LINES})`),
    )) &&
      (await view.evaluate<boolean | null>(
        disabledButton(LOG_CONTROLS, "Clear logs…"),
      )) === false &&
      !(await view.evaluate<boolean>(
        `document.querySelector('[data-testid="clear-logs-reason"]') !== null`,
      )),
  );
  check(
    `Clear logs… asks "Clear the ${LOGGED_JOB_LINES} log lines of this job?"`,
    (await view.evaluate<boolean>(button(LOG_CONTROLS, "Clear logs…", true))) &&
      (await view.evaluate<boolean>(
        textIncludes(
          DIALOG,
          `Clear the ${LOGGED_JOB_LINES} log lines of this job?`,
        ),
      )),
  );
  check(
    `Clear logs: the toast says "Cleared ${LOGGED_JOB_LINES} lines"`,
    (await view.evaluate<boolean>(button(DIALOG, "Clear logs", true))) &&
      (await view.evaluate<boolean>(
        textIncludes(TOASTS, `Cleared ${LOGGED_JOB_LINES} lines`),
      )),
  );
  checkEqual(
    "GET the job's logs → 0 lines; the job is still completed",
    [await jobLogTotal(QUEUE, LOGGED_JOB), await stateOf(QUEUE, LOGGED_JOB)],
    [0, "completed"],
  );
  check(
    'the card re-reads: "No log lines yet.", and the button disabled for that reason',
    (await view.evaluate<boolean>(
      textIncludes(".card", "No log lines yet."),
    )) &&
      (await view.evaluate<boolean>(
        textIncludes('[data-testid="clear-logs-reason"]', "No lines to clear."),
      )),
  );

  /* ---------------------------------------------------------------- */
  step("Claimed while the dialog is open: the API's 409 JOB_ACTIVE, explained");

  checkEqual(
    "the waiting job's screen",
    await openJob(full, LATER, RACING_JOB),
    RACING_JOB,
  );
  check(
    'a waiting job: no Held by, and Processed by "No worker recorded"',
    (await view.evaluate<boolean>(noSummaryRow(JOB_SUMMARY, "Held by"))) &&
      (await view.evaluate<boolean>(
        textIncludes(
          '[data-testid="job-processed-by-none"]',
          "No worker recorded",
        ),
      )),
  );
  check(
    "Clear logs… is enabled on its 3 lines, and opens",
    (await view.evaluate<boolean>(
      waitForSelector(`${JOB_LOG_LINES}:nth-child(3)`),
    )) &&
      (await view.evaluate<boolean>(
        button(LOG_CONTROLS, "Clear logs…", true),
      )) &&
      (await view.evaluate<boolean>(
        textIncludes(DIALOG, "Clear the 3 log lines of this job?"),
      )),
  );
  laterWorker = jobs.worker<JobData, string>(LATER, processJob, {
    key: LATER_KEY,
    waitToExit: false,
    logger: noopLogger,
  });
  void laterWorker.run();
  await waitFor(
    "a worker to claim the job",
    async () => (await stateOf(LATER, RACING_JOB)) === "active",
  );
  check(
    "Clear logs, now: the dialog explains the refusal",
    (await view.evaluate<boolean>(button(DIALOG, "Clear logs", true))) &&
      (await view.evaluate<boolean>(
        textIncludes(
          DIALOG,
          "It's running: a worker picked this job up and is still writing its log, so the log cannot be cleared now.",
        ),
      )),
    pageConsole,
  );
  checkEqual(
    "GET the job's logs → still 3 lines",
    await jobLogTotal(LATER, RACING_JOB),
    3,
  );
  check(
    "Cancel; the button is now disabled, the active reason beside it",
    (await view.evaluate<boolean>(button(DIALOG, "Cancel", true))) &&
      (await view.evaluate<boolean>(gone(DIALOG))) &&
      (await view.evaluate<boolean>(
        textIncludes(
          '[data-testid="clear-logs-reason"]',
          "Clear logs once the job finishes",
        ),
      )),
  );
  check(
    `and Held by appears, with Processed by ${LATER_KEY}`,
    (await jobRow("Held by", "row.value !== ''"))?.value.startsWith(
      LATER_KEY,
    ) === true &&
      (
        await jobRow("Processed by", `row.value.includes("${LATER_KEY}")`)
      )?.value.includes(LATER_KEY) === true,
  );

  /* ---------------------------------------------------------------- */
  step("The held job finishes: Held by goes, Clear logs… enables");

  checkEqual(
    "the held job's screen, while active",
    await openJob(full, QUEUE, HELD_JOB),
    HELD_JOB,
  );
  check("Held by is shown", (await jobRow("Held by")) !== null);
  release("held-job");
  await waitFor(
    "the held job to complete",
    async () => (await stateOf(QUEUE, HELD_JOB)) === "completed",
  );
  check(
    "the screen (polling an active job) drops Held by, and keeps Processed by",
    (await view.evaluate<boolean>(noSummaryRow(JOB_SUMMARY, "Held by"))) &&
      (await jobRow("Processed by"))?.value.includes(WORKER_KEY) === true,
  );
  check(
    "Clear logs… enables, with no reason",
    await view.evaluate<boolean>(button(LOG_CONTROLS, "Clear logs…", false)),
  );

  /* ---------------------------------------------------------------- */
  step("Hosts that do not grant runners.configure or the clear actions");

  const listed = await read<{ actions: Record<string, boolean> }>(
    unlisted,
    "/meta/permissions",
  );
  const denied = await read<{ actions: Record<string, boolean> }>(
    refused,
    "/meta/permissions",
  );
  checkEqual(
    "unlisted: /meta/permissions leaves all three out; refused: all three false",
    [
      GATED_ACTIONS.map((action) => action in listed.actions),
      GATED_ACTIONS.map((action) => denied.actions[action]),
    ],
    [
      [false, false, false],
      [false, false, false],
    ],
  );
  for (const host of [unlisted, refused]) {
    check(
      `${host.label}: the runner screen offers Trigger… but no Settings… or Clear history…`,
      (await openRunner(host, HELD)) &&
        (await view.evaluate<boolean>(
          button(RUNNER_ACTIONS, "Trigger…", false),
        )) &&
        !(await view.evaluate<boolean>(
          hasButton(RUNNER_ACTIONS, "Settings…"),
        )) &&
        (await view.evaluate<boolean>(waitForSelector(HISTORY_ACTIONS))) &&
        !(await view.evaluate<boolean>(
          hasButton(HISTORY_ACTIONS, "Clear history…"),
        )) &&
        !(await view.evaluate<boolean>(
          hasButton(RUNNER_ACTIONS, "Clear history…"),
        )),
    );
    check(
      `${host.label}: the job screen offers Retry, and its Logs card no Clear logs…`,
      (await openJob(host, QUEUE, HELD_JOB)) === HELD_JOB &&
        (await view.evaluate<boolean>(
          waitForSelector(`${JOB_LOG_LINES}:nth-child(2)`),
        )) &&
        (await view.evaluate<boolean>(button(JOB_ACTIONS, "Retry", false))) &&
        !(await view.evaluate<boolean>(hasButton(LOG_CONTROLS, "Clear logs…"))),
    );
  }
} catch (error) {
  console.log(`page console:\n${pageConsole.join("\n")}`);
  throw error;
} finally {
  await shutdown(view);
}

summary();
