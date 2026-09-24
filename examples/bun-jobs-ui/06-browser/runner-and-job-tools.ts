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
 * Four hosts serve one `BunJobs` context, each an API and the UI:
 *
 * | host        | what differs                                                        |
 * | ----------- | ------------------------------------------------------------------- |
 * | `full`      | `actions: JOBS_API_ACTIONS` (the opt-in `runners.configure` too), a live socket |
 * | `socketless`| the same actions, `websocket: false`: live updates are off          |
 * | `unlisted`  | the default actions without `jobs.clearLogs` and `runners.clearHistory` (and `runners.configure`, which is opt-in) |
 * | `refused`   | every action listed, but `authorize` refuses those three            |
 *
 * What it shows:
 *
 * - **Runner Settings…** (`PUT /runners/:runner/config`, opt-in
 *   `runners.configure`) sets the execution mode, run mode and max
 *   concurrency; the modes outside the runner's `remoteConfig.executionModes`
 *   are not offered, and say so. A runner built from a driver instance alone
 *   is offered in-process only, and a PUT for worker is 409
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
 * - **The history pages within what was fetched, and says so.** "Runs shown"
 *   is the fetch (`GET /runners/:runner/history?limit=`); the pager under the
 *   table divides what came back, 25 rows to a page, and the note beside it
 *   says exactly that — fetch fewer than a page and the pager and the note both
 *   go, while the runner keeps every run it had. A `?logs=<runId>` link opens
 *   the page the run is on however far down the history it is, and leaves the
 *   page alone when the run is already on it.
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
import { pagerOf, pagersWhen, pagerWhen, poll } from "./helpers/page";
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
 * The runner whose settings are edited: `in-process` in its code, `worker`
 * also permitted by its `remoteConfig`, and a `childDriver` to hand a Worker,
 * so it can adopt a `worker` override.
 */
const SETTINGS = "nightly-export";
/**
 * The same `remoteConfig`, but built from the driver instance alone: with no
 * config to hand a child, `worker` is not offered at all (`allowed` is
 * `["in-process"]`) and a PUT asking for it is refused with 409.
 */
const INSTANCE_BOUND = "instance-bound";
/**
 * A runner whose owner refuses a stored override: another context, with a
 * `childDriver`, adopts `worker`; redeployed here from the driver instance
 * alone, the runner cannot, so it keeps its code's mode and reports why.
 */
const REDEPLOYED = "redeployed-export";
/** The runner whose finished run has a log in three streams, and a secret. */
const LOGGED = "report-render";
/** The runner whose log cap keeps 3 lines. */
const TRIMMED = "audit-trim";
/** The runner whose history is paged: more runs than one page of it. */
const PAGED = "ledger-sweep";
/**
 * How many runs it makes: more than `HISTORY_PAGE_SIZE` (25), and fewer than
 * the 50 runs the "Runs shown" select starts on — so every one of them is
 * fetched and the pages divide what came back, with something left over for a
 * short second page.
 */
const PAGED_RUNS = 30;
/** Runs on a page of the history table. */
const HISTORY_PAGE = 25;
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
      | "remoteConfig"
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
  remoteConfig: { executionModes: ["in-process", "worker"] },
  // What a Worker would reach the backend with. Nothing here runs in one:
  // the override is only adopted, never exercised.
  childDriver: { type: "memory" },
});
const instanceBound = await startRunner(jobs, INSTANCE_BOUND, {
  remoteConfig: { executionModes: ["in-process", "worker"] },
});
const loggedRunner = await startRunner(jobs, LOGGED);
const trimmedRunner = await startRunner(jobs, TRIMMED, {
  captureLogs: { maxLines: TRIMMED_KEEPS },
});
const tickerRunner = await startRunner(jobs, TICKER, { runMode: "parallel" });
const heldRunner = await startRunner(jobs, HELD);
const remoteRunner = await startRunner(remote, REMOTE, { runMode: "parallel" });
const freshRunner = await startRunner(jobs, FRESH);
const pagedRunner = await startRunner(jobs, PAGED);
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
// Thirty finished runs, one at a time, so the history has more than a page of
// them. Each writes one line, so each has a log for `?logs=` to open.
const pagedRuns: string[] = [];
for (let index = 0; index < PAGED_RUNS; index++) {
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

/** One log read the UI made. */
interface LogRead {
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
  logReads: LogRead[];
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
    logger: noopLogger,
  });
  const ui = jobsUi({ api, logger: noopLogger });
  const app = new BunHttpAdapter(0, { logger: noopLogger });
  const logReads: LogRead[] = [];
  app.use((req, _res, next) => {
    const url = new URL(req.originalUrl, "http://localhost");
    if (/\/runs\/[^/]+\/logs$/.test(url.pathname)) {
      logReads.push({
        path: url.pathname.slice(api.basePath.length),
        query: url.search.replace(/^\?/, ""),
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
    label,
    api: `${origin}${api.basePath}`,
    ui: `${origin}${ui.basePath}`,
    logReads,
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
const hosts = [full, socketless, unlisted, refused];

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
    "spawn is not offered, and the dialog says why",
    await view.evaluate<boolean>(
      textIncludes(
        `${DIALOG} [data-testid="config-modes-limited"]`,
        "spawn is not offered: this runner's code permits only worker, in-process",
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
    "Execution mode → worker",
    await view.evaluate<boolean>(
      chooseOption(DIALOG, "Execution mode", "worker"),
    ),
  );
  check(
    "which warns that a run in flight keeps its mode",
    await view.evaluate<boolean>(
      textIncludes(
        `${DIALOG} [data-testid="config-warning-execution-mode"]`,
        "worker applies from the next run",
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
    "GET the runner → overridden: all three, adopted, in force: worker, parallel, 3",
    [
      [...configured.config.overridden].sort(),
      configured.config.effective,
      [configured.executionMode, configured.runMode, configured.maxConcurrency],
    ],
    [
      ["executionMode", "maxConcurrency", "runMode"],
      { executionMode: "worker", runMode: "parallel", maxConcurrency: 3 },
      ["worker", "parallel", 3],
    ],
  );
  checkEqual(
    'adopted, the summary rows read "Overridden here; its code asks for …"',
    [
      await runnerRow("Execution mode", 'row.value === "worker"'),
      await runnerRow("Run mode", 'row.value === "parallel"'),
      await runnerRow("Max concurrency", 'row.value === "3"'),
    ],
    [
      {
        value: "worker",
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
  step(`${INSTANCE_BOUND}: built from a driver instance, so no worker`);

  checkEqual(
    "GET the runner → allowed: in-process only, though its remoteConfig names worker too",
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
    "its Execution mode offers in-process alone: neither worker nor spawn",
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
    body: JSON.stringify({ executionMode: "worker" }),
  });
  const forcedBody = (await forced.json()) as {
    code?: string;
    context?: { allowed?: string[] };
  };
  checkEqual(
    'a direct PUT {"executionMode":"worker"} → 409 CONFIG_NOT_ALLOWED, context.allowed ["in-process"]',
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
  // it adopts worker, parallel, 2.
  const before = await startRunner(remote, REDEPLOYED, {
    childDriver: { type: "memory" },
  });
  runners.push(before);
  const stored = await fetch(`${full.api}/runners/${REDEPLOYED}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json", [CSRF]: "1" },
    body: JSON.stringify({
      executionMode: "worker",
      concurrency: { runMode: "parallel", maxConcurrency: 2 },
    }),
  });
  checkEqual("the PUT is accepted (200)", stored.status, 200);
  await waitFor(
    "the first owner to adopt worker",
    () =>
      before.config.appliedSeq === before.config.seq &&
      before.config.effective.executionMode === "worker",
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
    "GET the runner → all three still stored, worker dropped from what runs, and why",
    [
      [...redeployed.config.overridden].sort(),
      redeployed.config.effective,
      redeployed.config.error?.message,
    ],
    [
      ["executionMode", "maxConcurrency", "runMode"],
      { executionMode: "in-process", runMode: "parallel", maxConcurrency: 2 },
      'executionMode "worker" needs a driver config for the child, and this runner was built from a driver instance',
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
  // in-process alone, so a PUT naming worker would be 409 up front, and the
  // stored worker is left as it is.
  const equal = await fetch(`${full.api}/runners/${REDEPLOYED}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json", [CSRF]: "1" },
    body: JSON.stringify({ concurrency: { runMode: "single" } }),
  });
  checkEqual(
    "PUT concurrency runMode single (the code's own), worker still stored → 200",
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
  step(`${PAGED}: ${PAGED_RUNS} runs, paged within what was fetched`);

  /** Page-side: the run ids of the history rows on screen, once `ready(ids)` holds. */
  function historyRows(ready = "true"): string {
    return poll(`(() => {
      const ids = [...document.querySelectorAll('.history-table tr[data-testid^="history-row-"]')]
        .map((row) => row.dataset.testid.slice("history-row-".length));
      return (${ready}) ? ids : null;
    })()`);
  }

  /** The note under the pager saying what the pages divide, or `null`. */
  const PAGING_NOTE = '[data-testid="history-paging-note"]';

  check(
    `${PAGED}'s history opens`,
    (await openRunner(full, PAGED)) &&
      (await view.evaluate<boolean>(waitForSelector(".history-table"))),
  );
  const fetched = await historyOf(PAGED);
  checkEqual(
    `the API has all ${PAGED_RUNS} runs, every one of them finished`,
    [fetched.length, new Set(fetched.map((one) => one.status)).size],
    [PAGED_RUNS, 1],
  );
  const firstHistory = await view.evaluate<PagerView | null>(
    pagerOf("History pages"),
  );
  show("the history pager", firstHistory);
  checkEqual(
    `the pager divides what was fetched: 1–${HISTORY_PAGE} of ${PAGED_RUNS}, two pages`,
    [
      firstHistory?.range,
      firstHistory?.size,
      firstHistory?.pageControl?.options,
      firstHistory?.prev,
      firstHistory?.next,
    ],
    [
      `1–${HISTORY_PAGE} of ${PAGED_RUNS}`,
      HISTORY_PAGE,
      ["1", "2"],
      false,
      true,
    ],
  );
  const notePaged = await view.evaluate<string | null>(textOf(PAGING_NOTE));
  show("and it says what it divides", notePaged);
  check(
    'the note names the fetch ("Runs shown"), not the runner\'s whole history',
    notePaged?.includes("the runs fetched") === true &&
      notePaged.includes("Runs shown") &&
      notePaged.includes("fetch more"),
    notePaged,
  );
  const historyPage1 = await view.evaluate<string[] | null>(
    historyRows(`ids.length === ${HISTORY_PAGE}`),
  );
  checkEqual(
    `${HISTORY_PAGE} rows on it, every one a run the API listed`,
    [
      historyPage1?.length,
      (historyPage1 ?? []).filter(
        (id) => !fetched.some((one) => one.runId === id),
      ),
    ],
    [HISTORY_PAGE, []],
  );
  check(
    "Next turns to the second page",
    await view.evaluate<boolean>(
      button('nav.pager[aria-label="History pages"]', "Next", true),
    ),
  );
  const secondHistory = await view.evaluate<PagerView | null>(
    pagerWhen("History pages", 'pager.pageControl.value === "2"'),
  );
  const historyPage2 = await view.evaluate<string[] | null>(
    historyRows(`ids.length === ${PAGED_RUNS - HISTORY_PAGE}`),
  );
  checkEqual(
    `page 2 is the remaining ${PAGED_RUNS - HISTORY_PAGE}, and Next has nowhere left to go`,
    [secondHistory?.range, secondHistory?.next, secondHistory?.prev],
    [`${HISTORY_PAGE + 1}–${PAGED_RUNS} of ${PAGED_RUNS}`, false, true],
  );
  checkEqual(
    "the two pages share no run and cover every run the API listed",
    [
      (historyPage2 ?? []).filter((id) => (historyPage1 ?? []).includes(id)),
      [...(historyPage1 ?? []), ...(historyPage2 ?? [])].slice().sort(),
    ],
    [[], fetched.map((one) => one.runId).sort()],
  );

  // What the note means, demonstrated: fetch fewer than a page and there is
  // nothing to page. The runs are still there — the *fetch* shrank, which is
  // the only thing "Runs shown" changes.
  check(
    'the "Runs shown" select takes 10',
    await view.evaluate<boolean>(
      chooseOption(HISTORY_ACTIONS, "Runs shown", "10"),
    ),
  );
  const tenRows = await view.evaluate<string[] | null>(
    historyRows("ids.length === 10"),
  );
  checkEqual(
    "ten rows fetched, so no pager and no note: there is nothing left to page",
    [
      tenRows?.length,
      await view.evaluate<string[] | null>(pagersWhen("labels.length === 0")),
      await view.evaluate<boolean>(gone(PAGING_NOTE)),
    ],
    [10, [], true],
  );
  checkEqual(
    `and the runner still has all ${PAGED_RUNS}: the fetch shrank, not the history`,
    (await historyOf(PAGED)).length,
    PAGED_RUNS,
  );

  /* ---------------------------------------------------------------- */
  step("?logs= opens the page the run is on, wherever in the history it is");

  /** A run on the second page, and one on the first, as the pages showed them. */
  const onPage2 = historyPage2?.[0];
  const onPage1 = historyPage1?.[0];
  check(
    "a run from each page to link to",
    typeof onPage1 === "string" && typeof onPage2 === "string",
    { onPage1, onPage2 },
  );
  await openRunner(full, PAGED, `?logs=${onPage2}`);
  const deepLinked = await view.evaluate<PagerView | null>(
    pagerWhen("History pages", 'pager.pageControl.value === "2"'),
  );
  checkEqual(
    "a link to a run on page 2 opens page 2, not page 1 with the row missing",
    [
      deepLinked?.range,
      deepLinked?.pageControl?.value,
      await view.evaluate<boolean>(
        waitForSelector(`[data-testid="history-row-${onPage2}"]`),
      ),
      await view.evaluate<boolean>(
        waitForSelector(`[data-testid="run-logs-${onPage2}"]`),
      ),
    ],
    [`${HISTORY_PAGE + 1}–${PAGED_RUNS} of ${PAGED_RUNS}`, "2", true, true],
  );
  await openRunner(full, PAGED, `?logs=${onPage1}`);
  const stayed = await view.evaluate<PagerView | null>(
    pagerOf("History pages"),
  );
  checkEqual(
    "and a link to a run on the page already shown leaves the page where it was",
    [
      stayed?.range,
      stayed?.pageControl?.value,
      await view.evaluate<boolean>(
        waitForSelector(`[data-testid="run-logs-${onPage1}"]`),
      ),
    ],
    [`1–${HISTORY_PAGE} of ${PAGED_RUNS}`, "1", true],
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
        waitForSelector('[data-testid="runner-remote-hint"]'),
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
