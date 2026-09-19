/**
 * Failing a job, disabling a repeat series and reading a job's progress, in
 * a real browser. Every action is read back from the API, not from the page.
 *
 * ```bash
 * bun 06-browser/job-actions.ts
 * BUN_CHROME_PATH=/opt/chrome/chrome bun 06-browser/job-actions.ts
 * EXAMPLE_BROWSER=0 bun 06-browser/job-actions.ts   # skip on purpose
 * ```
 *
 * Like the other browser examples it drives headless Chrome through
 * `Bun.WebView` and **skips** (prints `skipped:` and exits 0) when there is
 * no `Bun.WebView`, no Chrome, or Chrome will not start.
 *
 * What it shows:
 *
 * - **Fail… buries a job for good** (`POST /queues/:queue/jobs/:id/fail`),
 *   whatever attempts it has left. It sits in the job's `Job actions` group
 *   for a job in any state but `completed` and `dead`, and opens a danger
 *   dialog whose **Fail job** stays disabled until a **Reason** is given
 *   (trimmed, 1 to 4,096 characters) **and** the job's id is typed. The
 *   reason becomes the job's `failedReason`.
 * - **A long id is confirmed by its tail.** An id longer than 40 characters
 *   asks for its last 8 only ("Type the id's last 8 characters, …").
 * - **Failing an active job does not stop its code**, and the dialog says so
 *   (`fail-active-note`): the worker loses the job's lock, but the processor
 *   runs on until it returns.
 * - **A completed job offers no Fail…**: the API would refuse it with 409.
 * - **The repeatables panel** (`?panel=repeatables`) marks a disabled series
 *   with a **Disabled** badge, and its Next run reads "paused (disabled)".
 *   Disable and Enable are idempotent, so they ask for no confirmation.
 * - **A numeric progress is a bar** (`role="progressbar"`, with
 *   `aria-valuenow`) and its value as text; an object would be a JSON tree.
 * - **Wait on conditions, never on time.** Every page-side helper polls the
 *   DOM until what it wants is there, and every API check polls the API.
 */
import type { JobsApiAuthorize } from "@kingsleyweb/bun-jobs";
import {
  BunHttpAdapter,
  createDeferred,
  noopLogger,
} from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
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

// Decide whether to skip before printing anything: run-all.ts recognises a
// skip by the output *starting* with `skipped:`.
const chromePath = chromeOrSkip();

/** The queue whose jobs are failed, and whose series is disabled. */
const QUEUE = "mail";
/** A waiting job, failed from its screen. */
const WAITING_ID = "welcome-ada";
/** A waiting job whose id is longer than 40 characters. */
const LONG_ID = "export-2026-09-19-tenant-000451-batch-0007-part-0012";
/** The queue with a worker: one job completed, one held active. */
const BUSY = "reports";
/** A job the worker completes. */
const DONE_ID = "report-done";
/** A job the worker holds active, at 42% progress. */
const ACTIVE_ID = "report-running";
/** The progress the held job reports. */
const PROGRESS = 42;
/** The repeat series on mail. */
const SERIES = "weekly-digest";

/* --- the server: a real API with CSRF on, and the UI --------------- */

const jobs = new BunJobs({
  namespace: "examples-ui-job-actions",
  driver: new MemoryDriver(),
  logger: noopLogger,
});

/** Everything is allowed: this example is about the actions, not the gates. */
const authorize: JobsApiAuthorize = () => true;

const api = createJobsApi({
  jobs,
  basePath: "/jobs-api",
  authorize,
  // The UI reads the header name from `api.info` and sends it on mutations.
  csrf: { header: "x-bun-jobs-csrf" },
  logger: noopLogger,
});
const ui = jobsUi({ api, logger: noopLogger });
const app = new BunHttpAdapter();
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);
await app.listen(0);
const origin = app.url!.replace(/\/$/, "");

/** Released at shutdown: until then the held job stays active. */
const release = createDeferred<void>();

// Two waiting jobs on mail, and a repeat series (its next occurrence a
// delayed job). Nothing consumes mail.
const mail = jobs.queue(QUEUE);
await mail.add("send-email", { to: "ada@example.com" }, { jobId: WAITING_ID });
await mail.add("send-email", { to: "ops@example.com" }, { jobId: LONG_ID });
await mail.add(
  "digest",
  { list: "weekly" },
  { repeat: { every: "1 week", key: SERIES } },
);

// On reports, a worker completes one job, then holds the next one active
// after reporting its progress.
const reports = jobs.queue(BUSY);
const worker = jobs.worker(BUSY, async (job) => {
  if (job.id === DONE_ID) {
    return "sent";
  }
  await job.updateProgress(PROGRESS);
  await release.promise;
  return "held";
});
void worker.run();
await reports.add("report", {}, { jobId: DONE_ID });
await waitFor(
  "the first report to complete",
  async () => (await reports.count()).completed === 1,
);
await reports.add("report", {}, { jobId: ACTIVE_ID });

/** A JSON read from the API, bypassing the page. */
async function read<T>(path: string): Promise<T> {
  const response = await fetch(`${origin}${api.basePath}${path}`);
  return (await response.json()) as T;
}

/** The fields of a job this example reads back. */
interface JobBody {
  /** Its state. */
  state: string;
  /** Its progress, as the worker reported it. */
  progress: unknown;
  /** Its failure, or `null`. */
  failedReason: { message: string } | null;
}

/** `GET /queues/:queue/jobs/:id`. */
function readJob(queue: string, id: string): Promise<JobBody> {
  return read<JobBody>(`/queues/${queue}/jobs/${encodeURIComponent(id)}`);
}

await waitFor("the held report to be active, at its progress", async () => {
  const job = await readJob(BUSY, ACTIVE_ID);
  return job.state === "active" && job.progress === PROGRESS;
});

/** Mail's series, as `GET /queues/mail/repeatables` lists it. */
async function readSeries(): Promise<{ disabled: boolean } | undefined> {
  const { items } = await read<{ items: { key: string; disabled: boolean }[] }>(
    `/queues/${QUEUE}/repeatables`,
  );
  return items.find((series) => series.key === SERIES);
}

/** Winds everything down; safe to call more than once. */
async function shutdown(view?: Bun.WebView): Promise<void> {
  view?.close();
  release.resolve();
  await worker.close({ timeout: 1_000 });
  await app.close();
  await api.close();
  await jobs.close();
}

// Build the bundle before the browser asks, so the first page load is not
// the in-memory build.
await (await fetch(`${origin}${ui.basePath}`)).arrayBuffer();

/* --- the browser: skip, not fail, if Chrome will not start --------- */

/** What the page printed to its console, for a failure's diagnosis. */
const pageConsole: string[] = [];
const view = await openView(chromePath, pageConsole, shutdown);

title("Fail a job, disable a repeat series and read progress, in Chrome");
show("Chrome", chromePath);
show("serving", `${origin}${ui.basePath}`);

/* --- page-side helpers: each resolves once its condition holds ----- */

/** The open dialog. */
const DIALOG = "dialog[open]";
/** The job's action buttons. */
const JOB_ACTIONS = '[role="group"][aria-label="Job actions"]';

/**
 * Page-side: whether a button whose text is `text` exists inside `scope`
 * and is disabled, waiting up to `ms` for one to appear (`null` if none).
 */
function disabledButton(scope: string, text: string, ms = 10_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const attempt = () => {
      for (const candidate of document.querySelectorAll(${JSON.stringify(`${scope} button`)})) {
        if (candidate.textContent.trim() === ${JSON.stringify(text)}) return resolve(candidate.disabled);
      }
      if (Date.now() > deadline) return resolve(null);
      setTimeout(attempt, 50);
    };
    attempt();
  })`;
}

/**
 * Page-side: resolves `true` once `selector`'s text includes `text`,
 * `false` after `ms`.
 */
function textIncludes(selector: string, text: string, ms = 15_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const poll = () => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (element && element.textContent.includes(${JSON.stringify(text)})) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/**
 * Page-side: resolves `true` once no element matches `selector`, `false`
 * after `ms`.
 */
function gone(selector: string, ms = 10_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const poll = () => {
      if (!document.querySelector(${JSON.stringify(selector)})) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 50);
    };
    poll();
  })`;
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

/**
 * Types `text` into the open dialog's field whose label starts with
 * `label`, as a user would: the input is focused page-side (found through
 * its `<label for>`), then the text typed. Throws if there is no such field.
 */
async function typeIntoField(label: string, text: string): Promise<void> {
  const focused = await view.evaluate<boolean>(`new Promise((resolve) => {
    const deadline = Date.now() + 10000;
    const poll = () => {
      for (const element of document.querySelectorAll("${DIALOG} label")) {
        if (element.textContent.trim().startsWith(${JSON.stringify(label)})) {
          const input = document.getElementById(element.htmlFor);
          if (input) {
            input.focus();
            return resolve(document.activeElement === input);
          }
        }
      }
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 50);
    };
    poll();
  })`);
  if (!focused) {
    throw new Error(`the dialog has no field labelled "${label}…"`);
  }
  await view.type(text);
}

/** Opens a job's screen and waits for its id to show. */
async function openJob(queue: string, id: string): Promise<string | null> {
  await view.navigate(
    `${origin}${ui.basePath}/queues/${queue}/jobs/${encodeURIComponent(id)}`,
  );
  return view.evaluate<string | null>(textOf('[data-testid="job-id"]'));
}

try {
  /* ---------------------------------------------------------------- */
  step("Fail… a waiting job: a reason and the typed id, then it is dead");

  checkEqual(
    "the job screen shows the waiting job",
    await openJob(QUEUE, WAITING_ID),
    WAITING_ID,
  );
  check(
    "Fail… is offered in the Job actions group, and opens a dialog",
    (await view.evaluate<boolean>(button(JOB_ACTIONS, "Fail…", true))) &&
      (await view.evaluate<boolean>(waitForSelector(DIALOG))),
    pageConsole,
  );
  check(
    `it asks for the whole id typed: "Type ${WAITING_ID} to confirm"`,
    await view.evaluate<boolean>(
      textIncludes(DIALOG, `Type ${WAITING_ID} to confirm`),
    ),
  );
  checkEqual(
    "Fail job is disabled with nothing filled",
    await view.evaluate<boolean | null>(disabledButton(DIALOG, "Fail job")),
    true,
  );
  const reason = "The address bounced three times";
  await typeIntoField("Reason", reason);
  checkEqual(
    "still disabled with only the reason",
    await view.evaluate<boolean | null>(disabledButton(DIALOG, "Fail job")),
    true,
  );
  await typeIntoField("Type", WAITING_ID);
  check(
    "with the id typed too, Fail job enables, and is clicked",
    await view.evaluate<boolean>(button(DIALOG, "Fail job", true)),
  );
  await waitFor(
    "the API to report the job dead",
    async () => (await readJob(QUEUE, WAITING_ID)).state === "dead",
  );
  const buried = await readJob(QUEUE, WAITING_ID);
  checkEqual(
    "GET the job → dead, with the reason as its failure",
    [buried.state, buried.failedReason?.message],
    ["dead", reason],
  );
  // The screen refreshes: a dead job offers Retry, and Fail… is gone.
  check(
    "the screen refreshes: Retry is offered on the dead job",
    await view.evaluate<boolean>(button(JOB_ACTIONS, "Retry", false)),
  );
  check(
    "and Fail… is gone",
    !(await view.evaluate<boolean>(button(JOB_ACTIONS, "Fail…", false, 0))),
  );

  /* ---------------------------------------------------------------- */
  step("An id over 40 characters: only its last 8 are typed");

  const tail = LONG_ID.slice(-8);
  show(`${LONG_ID} (${LONG_ID.length} characters): its tail`, tail);
  checkEqual(
    "the job screen shows the long id",
    await openJob(QUEUE, LONG_ID),
    LONG_ID,
  );
  await view.evaluate<boolean>(button(JOB_ACTIONS, "Fail…", true));
  check(
    `it asks for the last 8 characters: "${tail}"`,
    await view.evaluate<boolean>(
      textIncludes(
        DIALOG,
        `Type the id's last 8 characters, ${tail}, to confirm`,
      ),
    ),
  );
  await typeIntoField("Reason", "Superseded by a newer export");
  await typeIntoField("Type", tail);
  check(
    "the tail is enough: Fail job enables, and is clicked",
    await view.evaluate<boolean>(button(DIALOG, "Fail job", true)),
  );
  await waitFor(
    "the API to report the long-id job dead",
    async () => (await readJob(QUEUE, LONG_ID)).state === "dead",
  );
  check("GET the job → dead", true);

  /* ---------------------------------------------------------------- */
  step("An active job: Fail… warns that its code keeps running");

  checkEqual(
    "the job screen shows the active job",
    await openJob(BUSY, ACTIVE_ID),
    ACTIVE_ID,
  );
  checkEqual(
    `its progress is a bar at ${PROGRESS} (role=progressbar), with its value`,
    [
      await view.evaluate<boolean>(
        waitForSelector('[data-testid="job-progress"] [role="progressbar"]'),
      ),
      await view.evaluate<string | null>(
        `document.querySelector('[data-testid="job-progress"] [role="progressbar"]')?.getAttribute("aria-valuenow") ?? null`,
      ),
      await view.evaluate<string | null>(
        textOf('[data-testid="job-progress"] .job-progress-value'),
      ),
    ],
    [true, String(PROGRESS), `${PROGRESS}%`],
  );
  await view.evaluate<boolean>(button(JOB_ACTIONS, "Fail…", true));
  check(
    "the dialog warns: failing it does not stop its code",
    await view.evaluate<boolean>(
      textIncludes(
        `${DIALOG} [data-testid="fail-active-note"]`,
        "Failing it does not stop its code",
      ),
    ),
  );
  check(
    "Cancel closes it",
    (await view.evaluate<boolean>(button(DIALOG, "Cancel", true))) &&
      (await view.evaluate<boolean>(gone(DIALOG))),
  );
  checkEqual(
    "and the job is still active",
    (await readJob(BUSY, ACTIVE_ID)).state,
    "active",
  );

  /* ---------------------------------------------------------------- */
  step("A completed job: no Fail…");

  checkEqual(
    "the job screen shows the completed job",
    await openJob(BUSY, DONE_ID),
    DONE_ID,
  );
  // Its actions are drawn together: once Retry shows, the group is complete.
  check(
    "Retry is offered on it",
    await view.evaluate<boolean>(button(JOB_ACTIONS, "Retry", false)),
  );
  check(
    "but not Fail…",
    !(await view.evaluate<boolean>(button(JOB_ACTIONS, "Fail…", false, 0))),
  );

  /* ---------------------------------------------------------------- */
  step("The repeatables panel: Disable, then Enable");

  await view.navigate(
    `${origin}${ui.basePath}/queues/${QUEUE}?panel=repeatables`,
  );
  const row = `[data-testid="repeatable-row-${SERIES}"]`;
  const next = `[data-testid="repeatable-next-${SERIES}"]`;
  check(
    `the panel lists ${SERIES}, enabled, with Disable and no badge`,
    (await view.evaluate<boolean>(waitForSelector(row))) &&
      (await view.evaluate<boolean>(button(row, "Disable", false))) &&
      !(await view.evaluate<boolean>(textIncludes(row, "Disabled", 0))),
    pageConsole,
  );
  check(
    "Disable is clicked, with no confirmation",
    (await view.evaluate<boolean>(button(row, "Disable", true))) &&
      !(await view.evaluate<boolean>(waitForSelector(DIALOG, 0))),
  );
  await waitFor(
    "the API to report the series disabled",
    async () => (await readSeries())?.disabled === true,
  );
  check("GET /queues/mail/repeatables → disabled: true", true);
  check(
    'the row shows the Disabled badge, and Next run "paused (disabled)"',
    (await view.evaluate<boolean>(textIncludes(row, "Disabled"))) &&
      (await view.evaluate<boolean>(textIncludes(next, "paused (disabled)"))),
  );
  check(
    "Enable replaces Disable, and is clicked",
    await view.evaluate<boolean>(button(row, "Enable", true)),
  );
  await waitFor(
    "the API to report the series enabled",
    async () => (await readSeries())?.disabled === false,
  );
  check("GET /queues/mail/repeatables → disabled: false", true);
  check(
    "the badge is gone, and Disable is back",
    (await view.evaluate<boolean>(button(row, "Disable", false))) &&
      !(await view.evaluate<boolean>(textIncludes(row, "Disabled", 0))) &&
      !(await view.evaluate<boolean>(
        textIncludes(next, "paused (disabled)", 0),
      )),
  );

  checkEqual(
    "no CSP violation on the way",
    await view.evaluate<string[]>(COLLECT_VIOLATIONS),
    [],
  );
} catch (error) {
  console.log(`page console:\n${pageConsole.join("\n")}`);
  throw error;
} finally {
  await shutdown(view);
}

summary();
