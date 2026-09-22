/**
 * A queue's **Job defaults** panel (`?panel=job-defaults`), in a real
 * browser, against a real `createJobsApi`. Every result is read back through
 * the API, not from the page.
 *
 * ```bash
 * bun 06-browser/job-defaults-panel.ts
 * BUN_CHROME_PATH=/opt/chrome/chrome bun 06-browser/job-defaults-panel.ts
 * EXAMPLE_BROWSER=0 bun 06-browser/job-defaults-panel.ts   # skip on purpose
 * ```
 *
 * Like the other browser examples it drives headless Chrome through
 * `Bun.WebView` and **skips** (prints `skipped:` and exits 0) when there is
 * no `Bun.WebView`, no Chrome, or Chrome will not start.
 *
 * What it shows:
 *
 * - **A save reaches new jobs only.** Settings… sends a merge patch (the
 *   changed keys and `expectedSeq`) to `PUT /queues/:queue/job-defaults`. A
 *   job added afterwards gets the stored values; one whose `add()` passed an
 *   option keeps it (`opts.explicit` lists it); jobs added before the save
 *   keep what they were added with. **Reset to code values**
 *   (`DELETE …?expectedSeq=<seq>`) gives new jobs the code's values again,
 *   and changes no job already added.
 * - **Both writes refuse stale defaults.** A save or a reset made after
 *   someone else's write answers 409 `CONTROL_CONTENDED`; the dialog says
 *   nothing was saved and offers **Re-read the defaults**, and the other
 *   write survives. The reset carries its `seq` in the query string, which a
 *   middleware here records as the host received it.
 * - **Apply to N pending jobs…** is a separate action
 *   (`POST /queues/:queue/job-defaults/apply`): a dry-run **preview** writes
 *   nothing; the walk goes batch by batch (`cursor` → `next` until `done`),
 *   each batch `min(1000, meta.limits.maxApplyDefaults)` jobs — 5 here, so a
 *   walk is several calls; **Cancel** stops it between batches and
 *   **Continue from where it stopped** resumes at the cursor; **Include jobs
 *   added before this version** is off by default. In every answer the five
 *   counts (rewritten, unchanged, skippedExplicit, skippedUnmarked, moved)
 *   add up to `examined`; a job whose `add()` passed the option is
 *   `skippedExplicit`; lowering attempts below a job's `attemptsMade` warns
 *   first and counts it `exhausted` (it gets one final attempt).
 * - **An apply pinned to stale defaults stops.** Defaults changed between
 *   the preview and the apply, or in the middle of the walk, answer 409
 *   `DEFAULTS_CHANGED`; the jobs already rewritten stay rewritten.
 * - **The gates.** With the two opt-ins (`queues.defaults`,
 *   `queues.applyDefaults`) left out of `actions` — the default — the panel
 *   is a read-only summary and the write routes answer 404, not 403. In
 *   runner mode (`features.jobDefaults` false) there is no panel and no
 *   request for it; on a driver without the batched rewrite
 *   (`features.jobDefaultsApply` false) there is Settings… but no Apply.
 * - **Wait on conditions, never on time.** Every page-side helper polls the
 *   DOM until what it wants is there, and every API check polls the API.
 */
import type { StoredJobOptions } from "@kingsleyweb/bun-jobs";
import {
  BunHttpAdapter,
  createDeferred,
  noopLogger,
} from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_ACTIONS,
  MemoryDriver,
} from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
import {
  button,
  chromeOrSkip,
  openView,
  waitForSelector,
} from "../shared/browser";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { buttonsIn, gone, poll, toast, typeInto } from "./helpers/page";

// Decide whether to skip before printing anything: run-all.ts recognises a
// skip by the output *starting* with `skipped:`.
const chromePath = chromeOrSkip();

/** The CSRF header every API here asks for on a mutation; the UI reads its name from `api.info`. */
const CSRF = "x-bun-jobs-csrf";
/** Marks a request this script makes itself, so the recorder can tell it from the page's. */
const DIRECT = "x-example-direct";
/** The full API's `limits.maxApplyDefaults`: one apply call examines at most this many jobs. */
const BATCH = 5;
/** What the code configures every queue with: what the panel's "Code" column shows. */
const CODE = {
  attempts: 3,
  // Long enough that a job failed once stays Retrying for the whole run.
  backoff: { type: "fixed", delay: 3_600_000 },
  timeout: 60_000,
} as const;
/** The apply dialog's warning when attempts is lowered (`EXHAUSTED_WARNING`), verbatim. */
const EXHAUSTED_WARNING =
  "Attempts is being lowered. A job that has already made at least the new number of attempts is not dropped: it gets ONE final attempt, and dies if that fails.";
/** Beside Reset (`RESET_CANNOT_RESTORE`), verbatim. */
const RESET_CANNOT_RESTORE =
  "Resetting changes jobs added from now on. It cannot restore jobs already rewritten by Apply to pending jobs: they keep the values written to them.";
/** The states the apply action walks, in the order the UI sends them. */
const APPLY_STATES = ["waiting", "delayed", "failed", "waiting-children"];

/* --- the server: one host, four API + UI pairs ---------------------- */

/** The main context, its driver kept to plant a job from an older version. */
const driver = new MemoryDriver();
const jobs = new BunJobs({
  namespace: "examples-ui-job-defaults",
  service: "api",
  driver,
  logger: noopLogger,
  defaultJobOptions: CODE,
});

/**
 * A second context whose driver has no batched rewrite, as a custom driver
 * that does not implement the optional `rewritePendingOptions` would be:
 * `features.jobDefaultsApply` is false there, `features.jobDefaults` true.
 */
const bareDriver = new MemoryDriver();
Object.defineProperty(bareDriver, "rewritePendingOptions", {
  value: undefined,
  configurable: true,
});
const noApplyJobs = new BunJobs({
  namespace: "examples-ui-job-defaults-noapply",
  service: "api",
  driver: bareDriver,
  logger: noopLogger,
  defaultJobOptions: CODE,
});

/** Every one of them allows everything: the gates here are `actions` and the features. */
const common = {
  authorize: () => true,
  csrf: { header: CSRF },
  logger: noopLogger,
} as const;

/** Every action, both opt-ins included; small apply batches so a walk is several calls. */
const full = createJobsApi({
  ...common,
  jobs,
  basePath: "/jobs-api",
  actions: [...JOBS_API_ACTIONS],
  limits: { maxApplyDefaults: BATCH, queueCacheMs: 0 },
});
/** `actions` left out: every action but the opt-ins, so neither job-defaults write is routed. */
const readOnly = createJobsApi({
  ...common,
  jobs,
  basePath: "/ro-api",
  limits: { queueCacheMs: 0 },
});
/** Runner mode: no queues, so `features.jobDefaults` is false. */
const runner = createJobsApi({
  ...common,
  jobs,
  mode: "runner",
  basePath: "/runner-api",
});
/** Every action, over the driver without the batched rewrite. */
const noApply = createJobsApi({
  ...common,
  jobs: noApplyJobs,
  basePath: "/noapply-api",
  actions: [...JOBS_API_ACTIONS],
  limits: { queueCacheMs: 0 },
});

const uis = {
  full: jobsUi({ api: full, basePath: "/jobs", logger: noopLogger }),
  readOnly: jobsUi({ api: readOnly, basePath: "/ro", logger: noopLogger }),
  runner: jobsUi({ api: runner, basePath: "/runner", logger: noopLogger }),
  noApply: jobsUi({ api: noApply, basePath: "/noapply", logger: noopLogger }),
};
const apis = [full, readOnly, runner, noApply];

/** One request to an API, as the host saw it and as the API answered. */
interface Exchange {
  /** Which API: its base path. */
  api: string;
  /** The method. */
  method: string;
  /** The path under the API's base, without the query. */
  path: string;
  /** The query string, without the `?`, exactly as it reached the host. */
  query: string;
  /** The parsed request body, once the API has read it (`undefined` for none). */
  body: unknown;
  /** The status answered. */
  status: number;
  /** The parsed answer, for a JSON body. */
  json: unknown;
  /** Whether this script sent it, rather than the page. */
  direct: boolean;
}

/** Every answered API request, oldest first. */
const exchanges: Exchange[] = [];

/**
 * Runs before an API request is routed; resolving lets it through. Installed
 * to hold an apply call (to Cancel between batches) or to change the
 * defaults just before the API sees one.
 */
let intercept:
  | ((request: { api: string; method: string; path: string }) => Promise<void>)
  | null = null;

const app = new BunHttpAdapter(0, { logger: noopLogger });
// Ahead of every API: records the request as it arrived (the query string
// included) and, through a response transform, what the API answered.
app.use(async (req, res, next) => {
  const url = new URL(req.originalUrl, "http://host");
  const api = apis.find(
    (one) =>
      url.pathname === one.basePath ||
      url.pathname.startsWith(`${one.basePath}/`),
  );
  if (!api) {
    next();
    return;
  }
  const path = url.pathname.slice(api.basePath.length);
  const direct = req.getHeader(DIRECT) === "1";
  res.addResponseTransform({
    transform: (response, { body }) => {
      let json: unknown;
      try {
        json = typeof body === "string" ? JSON.parse(body) : undefined;
      } catch {
        json = undefined;
      }
      exchanges.push({
        api: api.basePath,
        method: req.method,
        path,
        query: url.search.replace(/^\?/, ""),
        // By the time the answer is produced the API has parsed the body.
        body: req.body,
        status: response.status,
        json,
        direct,
      });
      return response;
    },
  });
  if (!direct && intercept) {
    await intercept({ api: api.basePath, method: req.method, path });
  }
  next();
});
for (const api of apis) {
  app.use(api.basePath, api.router);
}
for (const ui of Object.values(uis)) {
  app.use(ui.basePath, ui.router);
}
await app.listen(0);
const origin = app.url!.replace(/\/$/, "");

/** A request this script makes itself, with the CSRF header. */
async function call<T = unknown>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const response = await fetch(`${origin}${base}${path}`, {
    method,
    headers: {
      [CSRF]: "1",
      [DIRECT]: "1",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: (text === "" ? null : JSON.parse(text)) as T,
  };
}

/** `GET /queues/:queue/job-defaults`, as far as this example reads it. */
interface DefaultsDto {
  /** The override's version. */
  seq: number;
  /** What a job added now gets. */
  effective: Record<string, unknown>;
  /** What the code asks for. */
  code: Record<string, unknown>;
  /** The keys the override sets. */
  overridden: string[];
  /** The stored override. */
  override: Record<string, unknown>;
  /** Jobs pending, by state, and `total`. */
  pending: Record<string, number>;
}

/** One apply call's answer. */
interface ApplyDto {
  /** Jobs looked at. */
  examined: number;
  /** Jobs changed (or that would be, in a dry run). */
  rewritten: number;
  /** Jobs that already had every value. */
  unchanged: number;
  /** Jobs whose `add()` passed every changing option. */
  skippedExplicit: number;
  /** Jobs from before the explicit record, left alone. */
  skippedUnmarked: number;
  /** Jobs that left the walked states before their write. */
  moved: number;
  /** Rewritten jobs already at the new attempts: one final attempt each. */
  exhausted: number;
  /** The cursor to continue from, `null` at the end. */
  next: string | null;
  /** `next === null`. */
  done: boolean;
  /** Whether it wrote nothing. */
  dryRun: boolean;
}

/** The apply body the UI sends. */
interface ApplyBody {
  /** The defaults' version the walk is pinned to. */
  seq: number;
  /** The batch size. */
  limit: number;
  /** Where to continue; absent on the first call. */
  cursor?: string;
  /** Write nothing. */
  dryRun: boolean;
  /** Include jobs from before the explicit record. */
  includeUnmarked: boolean;
  /** The states walked. */
  states: string[];
}

/** An error answer. */
interface ErrorDto {
  /** The error code, e.g. `CONTROL_CONTENDED`. */
  code: string;
  /** Details, when the code carries them. */
  context?: Record<string, unknown>;
}

/** The fields of a job this example reads back. */
interface JobDto {
  /** Its state. */
  state: string;
  /** Attempts made so far. */
  attemptsMade: number;
  /** Its options as stored, and which of them its `add()` passed. */
  opts: { attempts: number; timeout?: number; explicit?: string[] };
}

/** `queue`'s defaults, read through the full API. */
async function readDefaults(queue: string): Promise<DefaultsDto> {
  return (
    await call<DefaultsDto>(
      full.basePath,
      "GET",
      `/queues/${queue}/job-defaults`,
    )
  ).json;
}

/** One job, read through the full API. */
async function readJob(queue: string, id: string): Promise<JobDto> {
  return (
    await call<JobDto>(
      full.basePath,
      "GET",
      `/queues/${queue}/jobs/${encodeURIComponent(id)}`,
    )
  ).json;
}

/** A merge patch through the full API, behind the page's back: answers the new `seq`. */
async function saveBehind(
  queue: string,
  patch: Record<string, unknown>,
): Promise<number> {
  const { status, json } = await call<DefaultsDto>(
    full.basePath,
    "PUT",
    `/queues/${queue}/job-defaults`,
    patch,
  );
  if (status !== 200) {
    throw new Error(`PUT ${queue}'s job defaults answered ${status}`);
  }
  return json.seq;
}

/** The page's requests to `queue`'s job-defaults routes on the full API, from index `from` on. */
function uiCalls(
  queue: string,
  method: string,
  suffix = "",
  from = 0,
): Exchange[] {
  const path = `/queues/${queue}/job-defaults${suffix}`;
  return exchanges
    .slice(from)
    .filter(
      (one) =>
        !one.direct &&
        one.api === full.basePath &&
        one.path === path &&
        one.method === method,
    );
}

/** The sum of a walk's counts, checking that each answer adds up to its `examined`. */
function walkTotals(
  calls: Exchange[],
): Omit<ApplyDto, "next" | "done" | "dryRun"> {
  const totals = {
    examined: 0,
    rewritten: 0,
    unchanged: 0,
    skippedExplicit: 0,
    skippedUnmarked: 0,
    moved: 0,
    exhausted: 0,
  };
  const unbalanced = calls.filter((one) => {
    const answer = one.json as ApplyDto;
    return (
      answer.rewritten +
        answer.unchanged +
        answer.skippedExplicit +
        answer.skippedUnmarked +
        answer.moved !==
        answer.examined || answer.exhausted > answer.rewritten
    );
  });
  check(
    `in each of the ${calls.length} answers the five counts add up to examined, exhausted within rewritten`,
    unbalanced.length === 0,
    unbalanced.map((one) => one.json),
  );
  for (const one of calls) {
    const answer = one.json as ApplyDto;
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
      totals[key] += answer[key];
    }
  }
  return totals;
}

/**
 * Checks a walk's calls chain `cursor` → `next` until `done`, every one
 * pinned to `seq`, `limit` {@link BATCH}, and within it.
 */
function checkChained(
  label: string,
  calls: Exchange[],
  expected: { dryRun: boolean; seq: number; includeUnmarked: boolean },
): void {
  const problems: string[] = [];
  calls.forEach((one, index) => {
    const body = one.body as ApplyBody;
    const answer = one.json as ApplyDto;
    const last = index === calls.length - 1;
    const cursor =
      index === 0 ? undefined : (calls[index - 1]!.json as ApplyDto).next;
    if (one.status !== 200) {
      problems.push(`call ${index}: status ${one.status}`);
    }
    if (
      body.seq !== expected.seq ||
      body.limit !== BATCH ||
      body.dryRun !== expected.dryRun ||
      body.includeUnmarked !== expected.includeUnmarked ||
      !Bun.deepEquals(body.states, APPLY_STATES)
    ) {
      problems.push(`call ${index}: body ${JSON.stringify(body)}`);
    }
    if (body.cursor !== (cursor ?? undefined)) {
      problems.push(
        `call ${index}: cursor ${body.cursor} after next ${cursor}`,
      );
    }
    if (answer.examined > BATCH || answer.dryRun !== expected.dryRun) {
      problems.push(`call ${index}: answer ${JSON.stringify(answer)}`);
    }
    if (answer.done !== last || (answer.next === null) !== last) {
      problems.push(`call ${index}: done ${answer.done}, next ${answer.next}`);
    }
  });
  check(
    `${label}: ${calls.length} calls (more than one), each limit ${BATCH}, seq ${expected.seq}, dryRun ${expected.dryRun}, chained cursor → next until done`,
    calls.length > 1 && problems.length === 0,
    { calls: calls.length, problems },
  );
}

/** A queue with the code's defaults, whose adds see a saved change at once (no refresh window). */
function queueOf(context: BunJobs, name: string) {
  return context.queue(name, {
    defaultJobOptions: CODE,
    jobDefaultsRefreshInterval: 0,
  });
}

/**
 * Makes `id` a Retrying job on `queue`: a worker runs it once and it fails,
 * so it waits out the code's hour-long backoff with `attemptsMade` 1. The
 * worker is closed before anything else is added.
 */
async function seedRetrying(queue: string, id: string): Promise<void> {
  const worker = jobs.worker(
    queue,
    async () => {
      throw new Error("fails on purpose");
    },
    { concurrency: 1, pollInterval: 10, waitToExit: false, logger: noopLogger },
  );
  void worker.run();
  await queueOf(jobs, queue).add("retrying", {}, { jobId: id });
  await waitFor(
    `${id} to fail its first attempt`,
    async () => (await readJob(queue, id)).state === "failed",
  );
  await worker.close({ force: true });
}

/**
 * Adds `id` as a job added by a bun-jobs from before the explicit record:
 * added normally, then stored again without `opts.explicit`.
 */
async function seedUnmarked(queue: string, id: string): Promise<void> {
  const bunQueue = queueOf(jobs, queue);
  await bunQueue.add("legacy", {}, { jobId: id });
  const stored = (await driver.getJob(bunQueue.ref, id))!;
  const { explicit: _explicit, ...unmarked } = stored.opts as StoredJobOptions;
  await driver.removeJob(bunQueue.ref, id);
  await driver.addJob(bunQueue.ref, { ...stored, opts: unmarked });
}

/** Winds everything down; safe to call more than once. */
async function shutdown(view?: Bun.WebView): Promise<void> {
  view?.close();
  await app.close();
  for (const api of apis) {
    await api.close();
  }
  await jobs.close();
  await noApplyJobs.close();
}

// Build every bundle before the browser asks, so no first page load is the
// in-memory build.
for (const ui of Object.values(uis)) {
  await (await fetch(`${origin}${ui.basePath}`)).arrayBuffer();
}

/* --- the browser: skip, not fail, if Chrome will not start --------- */

/** What the page printed to its console, for a failure's diagnosis. */
const pageConsole: string[] = [];
const view = await openView(chromePath, pageConsole, shutdown);

title("A queue's Job defaults panel, in Chrome, against a real API");
show("Chrome", chromePath);
show("serving", `${origin}${uis.full.basePath}`);

/* --- page-side helpers: each resolves once its condition holds ----- */

/** The open dialog. */
const DIALOG = "dialog[open]";
/** The panel. */
const PANEL = '[data-testid="job-defaults-panel"]';
/** The panel's own buttons (the dialogs render inside the panel, so not `PANEL button`). */
const PANEL_ACTIONS = `${PANEL} > .form-actions`;

/** Page-side: the panel's table as `{ key: [gets, code, override] }`, once `ready(rows)` holds. */
function panelRows(ready = "true", ms = 15_000): string {
  return poll(
    `(() => {
      const found = document.querySelectorAll('[data-testid^="job-default-row-"]');
      if (found.length === 0) return null;
      const rows = {};
      for (const row of found) {
        rows[row.getAttribute("data-testid").slice("job-default-row-".length)] =
          [...row.querySelectorAll("td")].map((cell) => cell.textContent.trim());
      }
      return (${ready}) ? rows : null;
    })()`,
    ms,
  );
}

/**
 * Page-side: the label → value rows of the definition list `selector`
 * (the value without its hint), once it exists and `ready(rows)` holds.
 */
function kvRows(selector: string, ready = "true", ms = 15_000): string {
  return poll(
    `(() => {
      const found = document.querySelectorAll(${JSON.stringify(`${selector} .kv-row`)});
      if (found.length === 0) return null;
      const rows = {};
      for (const row of found) {
        const value = row.querySelector("dd");
        rows[row.querySelector("dt").textContent.trim()] =
          (value.firstChild ? value.firstChild.textContent : "").trim();
      }
      return (${ready}) ? rows : null;
    })()`,
    ms,
  );
}

/** Page-side: whether `selector`'s text includes `text`, within `ms`. */
function hasText(selector: string, text: string, ms = 15_000): string {
  return poll(
    `document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(text)}) ?? false`,
    ms,
  );
}

/** Page-side: the open dialog's alert text, once one shows. */
const DIALOG_ALERT = poll(
  `document.querySelector(${JSON.stringify(`${DIALOG} [role="alert"]`)})?.textContent.trim() || null`,
);

/** Page-side: the "Include jobs added before this version" checkbox, or `null`. */
const UNMARKED_BOX = `(() => {
  for (const label of document.querySelectorAll(${JSON.stringify(`${DIALOG} label`)})) {
    if (label.textContent.trim() === "Include jobs added before this version") {
      return document.getElementById(label.htmlFor);
    }
  }
  return null;
})()`;

/** Opens `queue`'s Job defaults panel under the UI mounted at `uiBase`. */
async function openPanel(uiBase: string, queue: string): Promise<boolean> {
  await view.navigate(
    `${origin}${uiBase}/queues/${encodeURIComponent(queue)}?panel=job-defaults`,
  );
  return view.evaluate<boolean>(waitForSelector(PANEL));
}

/** Clicks the button `text` inside `scope`, throwing when it never shows enabled. */
async function click(scope: string, text: string): Promise<void> {
  if (!(await view.evaluate<boolean>(button(scope, text, true)))) {
    throw new Error(`no enabled "${text}" button in ${scope}`);
  }
}

/** Types into the open dialog's input labelled `label`, throwing when there is none. */
async function fill(label: string, value: string): Promise<void> {
  if (!(await view.evaluate<boolean | null>(typeInto(DIALOG, label, value)))) {
    throw new Error(`the dialog has no input labelled "${label}"`);
  }
}

try {
  /* ---------------------------------------------------------------- */
  step("A save reaches new jobs; explicit options and older jobs keep theirs");

  const SAVED = "welcome-mail";
  const saved = queueOf(jobs, SAVED);
  await saved.add("send", {}, { jobId: "before" });
  const initial = await readDefaults(SAVED);
  show("GET the defaults before", {
    seq: initial.seq,
    code: initial.code,
    overridden: initial.overridden,
  });

  check(
    "the panel shows",
    await openPanel(uis.full.basePath, SAVED),
    pageConsole,
  );
  const firstRows = await view.evaluate<Record<string, string[]> | null>(
    panelRows(),
  );
  checkEqual(
    "Attempts and Timeout: a job gets the code's value, not overridden",
    [firstRows?.attempts, firstRows?.timeout],
    [
      ["3", "3", "code value"],
      ["1m", "1m", "code value"],
    ],
  );
  checkEqual(
    "the panel offers Settings…, and no Apply (nothing is overridden)",
    await view.evaluate<string[]>(buttonsIn(PANEL_ACTIONS)),
    ["Settings…"],
  );
  check(
    "and says why there is no Apply",
    await view.evaluate<boolean>(
      hasText(
        '[data-testid="apply-unavailable"]',
        "Nothing is overridden, so there is nothing to apply to pending jobs.",
      ),
    ),
  );

  await click(PANEL_ACTIONS, "Settings…");
  await fill("Attempts", "5");
  await fill("Timeout (ms)", "30000");
  await click(DIALOG, "Save defaults");
  check(
    'a toast: "Saved the job defaults of welcome-mail"',
    (await view.evaluate<unknown>(
      toast(`Saved the job defaults of ${SAVED}`),
    )) !== null,
  );
  const [put] = uiCalls(SAVED, "PUT");
  checkEqual(
    "the page sent PUT with only the changed keys and expectedSeq, and got 200",
    [put?.body, put?.status],
    [{ attempts: 5, timeout: 30_000, expectedSeq: initial.seq }, 200],
  );
  const afterSave = await readDefaults(SAVED);
  checkEqual(
    "GET the defaults → attempts and timeout overridden; the code unchanged",
    [
      afterSave.overridden,
      afterSave.effective.attempts,
      afterSave.effective.timeout,
      afterSave.code.attempts,
      afterSave.code.timeout,
    ],
    [["attempts", "timeout"], 5, 30_000, 3, 60_000],
  );
  checkEqual(
    "the panel re-reads: both rows Overridden",
    await view.evaluate<string[][] | null>(
      `${panelRows('rows.attempts[2] === "Overridden"')}.then((rows) => rows && [rows.attempts, rows.timeout])`,
    ),
    [
      ["5", "3", "Overridden"],
      ["30s", "1m", "Overridden"],
    ],
  );

  await saved.add("send", {}, { jobId: "after" });
  await saved.add("send", {}, { jobId: "own", attempts: 2 });
  const after = await readJob(SAVED, "after");
  const own = await readJob(SAVED, "own");
  const before = await readJob(SAVED, "before");
  checkEqual(
    "GET a job added after the save → attempts 5, timeout 30000, nothing explicit",
    [after.opts.attempts, after.opts.timeout, after.opts.explicit ?? []],
    [5, 30_000, []],
  );
  checkEqual(
    "GET a job whose add() passed attempts: 2 → keeps it (opts.explicit), gets the saved timeout",
    [own.opts.attempts, own.opts.timeout, own.opts.explicit],
    [2, 30_000, ["attempts"]],
  );
  checkEqual(
    "GET the job added before the save → still the code's 3 and 60000",
    [before.opts.attempts, before.opts.timeout],
    [3, 60_000],
  );

  step("Reset to code values: DELETE ?expectedSeq=, new jobs only");

  await click(PANEL_ACTIONS, "Settings…");
  check(
    "beside Reset: it cannot restore jobs already rewritten",
    await view.evaluate<boolean>(
      hasText(`${DIALOG} .job-defaults-reset`, RESET_CANNOT_RESTORE),
    ),
  );
  await click(DIALOG, "Reset to code values");
  check(
    'a toast: "Reset the job defaults of welcome-mail to the code values"',
    (await view.evaluate<unknown>(
      toast(`Reset the job defaults of ${SAVED} to the code values`),
    )) !== null,
  );
  const [reset] = uiCalls(SAVED, "DELETE");
  checkEqual(
    "the host received DELETE with ?expectedSeq=<the seq read>, no body, and answered 200",
    [reset?.query, reset?.body, reset?.status],
    [`expectedSeq=${afterSave.seq}`, undefined, 200],
  );
  const afterReset = await readDefaults(SAVED);
  checkEqual(
    "GET the defaults → nothing overridden, the code's values, a newer seq",
    [
      afterReset.overridden,
      afterReset.effective.attempts,
      afterReset.effective.timeout,
      afterReset.seq > afterSave.seq,
    ],
    [[], 3, 60_000, true],
  );
  await saved.add("send", {}, { jobId: "after-reset" });
  const fresh = await readJob(SAVED, "after-reset");
  const kept = await readJob(SAVED, "after");
  checkEqual(
    "GET a job added after the reset → the code's 3 and 60000",
    [fresh.opts.attempts, fresh.opts.timeout],
    [3, 60_000],
  );
  checkEqual(
    "GET the job added between → keeps 5 and 30000: reset changed new jobs only",
    [kept.opts.attempts, kept.opts.timeout],
    [5, 30_000],
  );

  /* ---------------------------------------------------------------- */
  step("A stale save: 409 CONTROL_CONTENDED, nothing saved, Re-read");

  const RACED = "invoices";
  await queueOf(jobs, RACED).add("bill", {}, { jobId: "w1" });
  const first = await saveBehind(RACED, { priority: 2 });
  await openPanel(uis.full.basePath, RACED);
  await view.evaluate(panelRows('rows.priority[0] === "2"'));
  await click(PANEL_ACTIONS, "Settings…");
  // Someone else saves after the page read the defaults.
  const other = await saveBehind(RACED, { priority: 9 });
  await fill("Attempts", "5");
  await click(DIALOG, "Save defaults");
  const saveAlert = await view.evaluate<string | null>(DIALOG_ALERT);
  check(
    'the dialog says the defaults changed and "Nothing was saved"',
    saveAlert?.includes("changed since you opened them") === true &&
      saveAlert.includes("Nothing was saved"),
    saveAlert,
  );
  check(
    "and offers Re-read the defaults",
    await view.evaluate<boolean>(button(DIALOG, "Re-read the defaults", false)),
  );
  const [stalePut] = uiCalls(RACED, "PUT");
  checkEqual(
    "the PUT carried the stale expectedSeq and answered 409 CONTROL_CONTENDED",
    [stalePut?.body, stalePut?.status, (stalePut?.json as ErrorDto)?.code],
    [{ attempts: 5, expectedSeq: first }, 409, "CONTROL_CONTENDED"],
  );
  let stored = await readDefaults(RACED);
  checkEqual(
    "GET the defaults → the other save survives, untouched",
    [stored.override, stored.seq],
    [{ priority: 9 }, other],
  );
  await click(DIALOG, "Re-read the defaults");
  check(
    'Re-read starts the form over from the other save: "Now: 9 · Code: 0"',
    await view.evaluate<boolean>(hasText(DIALOG, "Now: 9 · Code: 0")),
  );

  /* ---------------------------------------------------------------- */
  step(
    "A stale reset: DELETE ?expectedSeq= answers 409, the other save survives",
  );

  // Someone else saves again while the dialog is open.
  const third = await saveBehind(RACED, { priority: 11 });
  await click(DIALOG, "Reset to code values");
  const resetAlert = await view.evaluate<string | null>(DIALOG_ALERT);
  check(
    'the dialog says nothing was saved, and offers "Re-read the defaults"',
    resetAlert?.includes("Nothing was saved") === true &&
      (await view.evaluate<boolean>(
        button(DIALOG, "Re-read the defaults", false),
      )),
    resetAlert,
  );
  const [staleDelete] = uiCalls(RACED, "DELETE");
  checkEqual(
    `the host received DELETE ?expectedSeq=${other} (the seq re-read), and answered 409 CONTROL_CONTENDED`,
    [
      staleDelete?.query,
      staleDelete?.status,
      (staleDelete?.json as ErrorDto)?.code,
    ],
    [`expectedSeq=${other}`, 409, "CONTROL_CONTENDED"],
  );
  stored = await readDefaults(RACED);
  checkEqual(
    "GET the defaults → the other save SURVIVES the reset",
    [stored.override, stored.seq],
    [{ priority: 11 }, third],
  );
  await click(DIALOG, "Re-read the defaults");
  await view.evaluate(hasText(DIALOG, "Now: 11"));
  await click(DIALOG, "Reset to code values");
  await view.evaluate(toast(`Reset the job defaults of ${RACED}`));
  const [, goodDelete] = uiCalls(RACED, "DELETE");
  checkEqual(
    "after a re-read the reset goes through: ?expectedSeq= the current seq, 200",
    [goodDelete?.query, goodDelete?.status],
    [`expectedSeq=${third}`, 200],
  );
  checkEqual(
    "GET the defaults → nothing stored",
    (await readDefaults(RACED)).override,
    {},
  );

  /* ---------------------------------------------------------------- */
  step("Apply to pending jobs: a dry-run preview writes nothing");

  const APPLIED = "reports";
  const reports = queueOf(jobs, APPLIED);
  await seedRetrying(APPLIED, "retrying");
  const plain: string[] = [];
  for (let index = 1; index <= 12; index++) {
    plain.push(`p${index}`);
    await reports.add("render", {}, { jobId: `p${index}` });
  }
  await reports.add("render", {}, { jobId: "own", attempts: 7 });
  await reports.add("render", {}, { jobId: "later", delay: 3_600_000 });
  await seedUnmarked(APPLIED, "legacy");
  const PENDING = 16;
  const lowered = await saveBehind(APPLIED, { attempts: 1 });
  const retryingBefore = await readJob(APPLIED, "retrying");
  show("the Retrying job before", {
    state: retryingBefore.state,
    attemptsMade: retryingBefore.attemptsMade,
    attempts: retryingBefore.opts.attempts,
  });
  const meta = await call<{ limits: { maxApplyDefaults: number } }>(
    full.basePath,
    "GET",
    "/meta",
  );
  checkEqual(
    "GET /meta → limits.maxApplyDefaults 5, so a batch is min(1000, 5)",
    meta.json.limits.maxApplyDefaults,
    BATCH,
  );

  await openPanel(uis.full.basePath, APPLIED);
  checkEqual(
    "the pending counts are the seeded jobs",
    await view.evaluate<Record<string, string> | null>(
      kvRows(".job-defaults-pending", `rows.Total === "${PENDING}"`),
    ),
    {
      Waiting: "14",
      Delayed: "1",
      Retrying: "1",
      "Waiting children": "0",
      Total: String(PENDING),
    },
  );
  await click(PANEL_ACTIONS, `Apply to ${PENDING} pending jobs…`);
  check(
    "the dialog lists the value written: Attempts: 1",
    await view.evaluate<boolean>(
      hasText(`${DIALOG} [aria-label="Values written"]`, "Attempts: 1"),
    ),
  );
  checkEqual(
    '"Include jobs added before this version" is there, and off by default',
    await view.evaluate<boolean | null>(`${UNMARKED_BOX}?.checked ?? null`),
    false,
  );
  check(
    "attempts is lowered below the code's, so the exhausted warning shows before anything runs",
    await view.evaluate<boolean>(
      hasText('[data-testid="exhausted-warning"]', EXHAUSTED_WARNING),
    ),
  );

  await click(DIALOG, "Preview (dry run)");
  check(
    '"Preview: nothing was written"',
    await view.evaluate<boolean>(
      hasText(DIALOG, "Preview: nothing was written"),
    ),
  );
  const dry = uiCalls(APPLIED, "POST", "/apply");
  checkChained("the preview", dry, {
    dryRun: true,
    seq: lowered,
    includeUnmarked: false,
  });
  const expected = {
    examined: PENDING,
    rewritten: 14,
    unchanged: 0,
    skippedExplicit: 1,
    skippedUnmarked: 1,
    moved: 0,
    exhausted: 1,
  };
  checkEqual(
    "summed: 16 examined, 14 would be rewritten, 1 explicit, 1 from before this version, 1 exhausted",
    walkTotals(dry),
    expected,
  );
  checkEqual(
    "the preview on the page says the same",
    await view.evaluate<Record<string, string> | null>(
      kvRows(`${DIALOG} .job-defaults-preview`),
    ),
    {
      Examined: "16",
      "Would be rewritten": "14",
      Unchanged: "0",
      "Skipped as explicit": "1",
      "Skipped, added before this version": "1",
      Moved: "0",
      Exhausted: "1",
    },
  );
  check(
    'and the warning adds "The preview found 1 such job."',
    await view.evaluate<boolean>(
      hasText(
        '[data-testid="exhausted-warning"]',
        "The preview found 1 such job.",
      ),
    ),
  );
  const untouched = await Promise.all(
    [...plain, "later", "retrying", "legacy"].map(
      async (id) => (await readJob(APPLIED, id)).opts.attempts,
    ),
  );
  check(
    "GET every job → still attempts 3: the preview wrote nothing",
    untouched.every((attempts) => attempts === 3),
    untouched,
  );

  /* ---------------------------------------------------------------- */
  step("The walk, batch by batch: Cancel between batches, then continue");

  const releaseSecond = createDeferred<void>();
  let realCalls = 0;
  let heldSecond = false;
  intercept = async ({ api, method, path }) => {
    if (
      api === full.basePath &&
      method === "POST" &&
      path === `/queues/${APPLIED}/job-defaults/apply` &&
      ++realCalls === 2
    ) {
      heldSecond = true;
      await releaseSecond.promise;
    }
  };
  try {
    await click(DIALOG, `Apply to ${PENDING} pending jobs`);
    await waitFor("the second apply call to reach the host", () => heldSecond);
    check(
      `while the second batch is in flight the progress reads "examined ${BATCH} of about ${PENDING} … (1 batch)"`,
      (await view.evaluate<boolean>(
        hasText(
          '[data-testid="apply-progress"]',
          `Applying… examined ${BATCH} of about ${PENDING}`,
        ),
      )) &&
        (await view.evaluate<boolean>(
          hasText('[data-testid="apply-progress"]', "(1 batch)"),
        )),
      await view.evaluate<string | null>(
        `document.querySelector('[data-testid="apply-progress"]')?.textContent ?? null`,
      ),
    );
    await click(DIALOG, "Cancel");
    check(
      'Cancel waits for the batch in flight: "Stopping after this batch…"',
      await view.evaluate<boolean>(
        hasText(DIALOG, "Stopping after this batch…"),
      ),
    );
  } finally {
    releaseSecond.resolve();
    intercept = null;
  }
  check(
    '"Stopped after 2 batches."',
    await view.evaluate<boolean>(
      hasText('[data-testid="apply-result"]', "Stopped after 2 batches."),
    ),
  );
  const firstWalk = uiCalls(APPLIED, "POST", "/apply").slice(dry.length);
  checkEqual(
    "exactly two apply calls went out, both 200, the second with the first's cursor",
    [
      firstWalk.length,
      firstWalk.map((one) => one.status),
      (firstWalk[1]?.body as ApplyBody | undefined)?.cursor ===
        (firstWalk[0]?.json as ApplyDto | undefined)?.next,
    ],
    [2, [200, 200], true],
  );
  const stoppedTotals = walkTotals(firstWalk);
  const midway = await Promise.all(
    [...plain, "later", "retrying"].map(
      async (id) => (await readJob(APPLIED, id)).opts.attempts,
    ),
  );
  checkEqual(
    `GET the jobs → exactly the ${stoppedTotals.rewritten} rewritten so far have attempts 1; the rest keep 3`,
    [
      midway.filter((attempts) => attempts === 1).length,
      midway.filter((attempts) => attempts === 3).length,
    ],
    [stoppedTotals.rewritten, midway.length - stoppedTotals.rewritten],
  );

  await click(DIALOG, "Continue from where it stopped");
  check(
    '"Applied to every pending job in the chosen states."',
    await view.evaluate<boolean>(
      hasText(
        '[data-testid="apply-result"]',
        "Applied to every pending job in the chosen states.",
      ),
    ),
  );
  const realWalk = uiCalls(APPLIED, "POST", "/apply").slice(dry.length);
  checkChained("the walk, across the cancel", realWalk, {
    dryRun: false,
    seq: lowered,
    includeUnmarked: false,
  });
  checkEqual(
    "summed over both halves: exactly what the preview said",
    walkTotals(realWalk),
    expected,
  );
  checkEqual(
    "the result on the page, totals carried across the cancel",
    await view.evaluate<Record<string, string> | null>(
      kvRows('[data-testid="apply-result"]'),
    ),
    {
      Examined: "16",
      Rewritten: "14",
      Unchanged: "0",
      "Skipped as explicit": "1",
      "Skipped, added before this version": "1",
      Moved: "0",
      Exhausted: "1",
    },
  );
  check(
    '"1 job got one final attempt"',
    await view.evaluate<boolean>(
      hasText(DIALOG, "1 job got one final attempt"),
    ),
  );
  const rewritten = await Promise.all(
    [...plain, "later"].map(
      async (id) => (await readJob(APPLIED, id)).opts.attempts,
    ),
  );
  check(
    "GET the 12 waiting and the delayed job → attempts 1",
    rewritten.every((attempts) => attempts === 1),
    rewritten,
  );
  checkEqual(
    "GET the job whose add() passed attempts: 7 → keeps 7 (skippedExplicit)",
    (await readJob(APPLIED, "own")).opts.attempts,
    7,
  );
  const exhausted = await readJob(APPLIED, "retrying");
  checkEqual(
    "GET the Retrying job → attempts 1 with 1 made, still failed: one final attempt",
    [exhausted.opts.attempts, exhausted.attemptsMade, exhausted.state],
    [1, 1, "failed"],
  );
  checkEqual(
    "GET the job from before this version → left alone, still 3",
    (await readJob(APPLIED, "legacy")).opts.attempts,
    3,
  );
  await click(DIALOG, "Close");
  await view.evaluate(gone(DIALOG));

  /* ---------------------------------------------------------------- */
  step('"Include jobs added before this version", ticked');

  await click(PANEL_ACTIONS, `Apply to ${PENDING} pending jobs…`);
  await view.evaluate(`${UNMARKED_BOX}?.click()`);
  checkEqual(
    "the box is ticked",
    await view.evaluate<boolean | null>(
      poll(`${UNMARKED_BOX}?.checked === true`),
    ),
    true,
  );
  const beforeIncluded = uiCalls(APPLIED, "POST", "/apply").length;
  await click(DIALOG, `Apply to ${PENDING} pending jobs`);
  await view.evaluate(
    hasText(
      '[data-testid="apply-result"]',
      "Applied to every pending job in the chosen states.",
    ),
  );
  const included = uiCalls(APPLIED, "POST", "/apply").slice(beforeIncluded);
  checkChained("the walk with the box ticked", included, {
    dryRun: false,
    seq: lowered,
    includeUnmarked: true,
  });
  checkEqual(
    "summed: only the older job is rewritten now; the explicit one is still skipped",
    walkTotals(included),
    {
      examined: PENDING,
      rewritten: 1,
      unchanged: 14,
      skippedExplicit: 1,
      skippedUnmarked: 0,
      moved: 0,
      exhausted: 0,
    },
  );
  checkEqual(
    "GET the job from before this version → attempts 1",
    (await readJob(APPLIED, "legacy")).opts.attempts,
    1,
  );
  await click(DIALOG, "Close");

  /* ---------------------------------------------------------------- */
  step(
    "Defaults changed after the preview: 409 DEFAULTS_CHANGED, nothing applied",
  );

  const CHANGED = "exports";
  const exportsQueue = queueOf(jobs, CHANGED);
  const ids: string[] = [];
  for (let index = 1; index <= 12; index++) {
    ids.push(`e${index}`);
    await exportsQueue.add("export", {}, { jobId: `e${index}` });
  }
  const confirmed = await saveBehind(CHANGED, { attempts: 2 });
  await openPanel(uis.full.basePath, CHANGED);
  await click(PANEL_ACTIONS, "Apply to 12 pending jobs…");
  await click(DIALOG, "Preview (dry run)");
  await view.evaluate(hasText(DIALOG, "Preview: nothing was written"));
  const previews = uiCalls(CHANGED, "POST", "/apply").length;
  // Someone saves between the preview and the apply.
  const movedOn = await saveBehind(CHANGED, { attempts: 4 });
  await click(DIALOG, "Apply to 12 pending jobs");
  const changedAlert = await view.evaluate<string | null>(DIALOG_ALERT);
  check(
    'the dialog says they changed since you confirmed, and "Nothing more was applied."',
    changedAlert?.includes("changed since you confirmed") === true &&
      changedAlert.includes("Nothing more was applied.") &&
      !changedAlert.includes("had already been rewritten"),
    changedAlert,
  );
  const refused = uiCalls(CHANGED, "POST", "/apply").slice(previews);
  checkEqual(
    "one call, pinned to the confirmed seq, answered 409 DEFAULTS_CHANGED naming both seqs",
    refused.map((one) => [
      one.status,
      (one.body as ApplyBody).seq,
      (one.json as ErrorDto).code,
      (one.json as ErrorDto).context?.expectedSeq,
      (one.json as ErrorDto).context?.seq,
    ]),
    [[409, confirmed, "DEFAULTS_CHANGED", confirmed, movedOn]],
  );
  const noneApplied = await Promise.all(
    ids.map(async (id) => (await readJob(CHANGED, id)).opts.attempts),
  );
  check(
    "GET every job → still 3",
    noneApplied.every((attempts) => attempts === 3),
    noneApplied,
  );
  await click(DIALOG, "Re-read the defaults");
  check(
    "Re-read goes back to the choices, with the values now stored: Attempts: 4",
    await view.evaluate<boolean>(
      hasText(`${DIALOG} [aria-label="Values written"]`, "Attempts: 4"),
    ),
  );

  step(
    "…and in the middle of the walk: the batches already written stay written",
  );

  const beforeWalk = uiCalls(CHANGED, "POST", "/apply").length;
  let walkCalls = 0;
  intercept = async ({ api, method, path }) => {
    if (
      api === full.basePath &&
      method === "POST" &&
      path === `/queues/${CHANGED}/job-defaults/apply` &&
      ++walkCalls === 2
    ) {
      // Someone saves through the API just before the second batch lands.
      await saveBehind(CHANGED, { attempts: 6 });
    }
  };
  try {
    await click(DIALOG, "Apply to 12 pending jobs");
    const midAlert = await view.evaluate<string | null>(DIALOG_ALERT);
    check(
      `the dialog says ${BATCH} jobs had already been rewritten with the values confirmed`,
      midAlert?.includes(
        `${BATCH} jobs had already been rewritten with the values you confirmed.`,
      ) === true,
      midAlert,
    );
  } finally {
    intercept = null;
  }
  const midWalk = uiCalls(CHANGED, "POST", "/apply").slice(beforeWalk);
  checkEqual(
    "two calls: the first rewrote a batch (200), the second answered 409 DEFAULTS_CHANGED",
    midWalk.map((one) => [
      one.status,
      one.status === 200
        ? (one.json as ApplyDto).rewritten
        : (one.json as ErrorDto).code,
    ]),
    [
      [200, BATCH],
      [409, "DEFAULTS_CHANGED"],
    ],
  );
  const partly = await Promise.all(
    ids.map(async (id) => (await readJob(CHANGED, id)).opts.attempts),
  );
  checkEqual(
    `GET the jobs → ${BATCH} at attempts 4 (kept), ${12 - BATCH} still at 3`,
    [
      partly.filter((attempts) => attempts === 4).length,
      partly.filter((attempts) => attempts === 3).length,
    ],
    [BATCH, 12 - BATCH],
  );
  await click(DIALOG, "Close");

  /* ---------------------------------------------------------------- */
  step("The opt-ins left out of actions: a read-only summary");

  const LOCKED = "audit-log";
  await queueOf(jobs, LOCKED).add("record", {}, { jobId: "w1" });
  await saveBehind(LOCKED, { attempts: 2 });
  const permissions = await call<{ actions: Record<string, boolean> }>(
    readOnly.basePath,
    "GET",
    "/meta/permissions",
  );
  checkEqual(
    "GET /meta/permissions → queues.read, and neither queues.defaults nor queues.applyDefaults",
    [
      permissions.json.actions["queues.read"],
      "queues.defaults" in permissions.json.actions,
      "queues.applyDefaults" in permissions.json.actions,
    ],
    [true, false, false],
  );
  const lockedFrom = exchanges.length;
  check(
    "the panel shows",
    await openPanel(uis.readOnly.basePath, LOCKED),
    pageConsole,
  );
  checkEqual(
    "with the stored override: Attempts 2, code 3, Overridden",
    await view.evaluate<string[] | null>(
      `${panelRows()}.then((rows) => rows && rows.attempts)`,
    ),
    ["2", "3", "Overridden"],
  );
  await view.evaluate(kvRows(".job-defaults-pending", 'rows.Total === "1"'));
  checkEqual(
    "no Settings…, no Apply, and no note about Apply",
    [
      await view.evaluate<string[]>(buttonsIn(PANEL_ACTIONS)),
      await view.evaluate<boolean>(
        `!!document.querySelector('[data-testid="apply-unavailable"]')`,
      ),
    ],
    [[], false],
  );
  const lockedSent = exchanges.slice(lockedFrom).filter((one) => !one.direct);
  check(
    "the page read the defaults, and sent nothing but GETs",
    lockedSent.some(
      (one) =>
        one.api === readOnly.basePath &&
        one.path === `/queues/${LOCKED}/job-defaults`,
    ) && lockedSent.every((one) => one.method === "GET"),
    lockedSent.map((one) => `${one.method} ${one.api}${one.path}`),
  );
  // An opt-in left out of `actions` is not routed at all — the route does
  // not exist on this API, which is a 404 ROUTE_NOT_FOUND, not a 403 FORBIDDEN:
  // there is nothing for `authorize` to refuse.
  const writes = [
    await call<ErrorDto>(
      readOnly.basePath,
      "PUT",
      `/queues/${LOCKED}/job-defaults`,
      {
        attempts: 5,
      },
    ),
    await call<ErrorDto>(
      readOnly.basePath,
      "DELETE",
      `/queues/${LOCKED}/job-defaults?expectedSeq=1`,
    ),
    await call<ErrorDto>(
      readOnly.basePath,
      "POST",
      `/queues/${LOCKED}/job-defaults/apply`,
      { seq: 1 },
    ),
  ];
  checkEqual(
    "PUT, DELETE and POST …/apply straight to that API → 404 ROUTE_NOT_FOUND each (not 403)",
    writes.map((one) => [one.status, one.json?.code]),
    [
      [404, "ROUTE_NOT_FOUND"],
      [404, "ROUTE_NOT_FOUND"],
      [404, "ROUTE_NOT_FOUND"],
    ],
  );
  checkEqual(
    "GET the defaults → unchanged",
    (await readDefaults(LOCKED)).override,
    { attempts: 2 },
  );

  /* ---------------------------------------------------------------- */
  step("Runner mode (features.jobDefaults false): no panel, no request");

  const runnerMeta = await call<{ features: Record<string, boolean> }>(
    runner.basePath,
    "GET",
    "/meta",
  );
  checkEqual(
    "GET /meta → jobDefaults and jobDefaultsApply false",
    [
      runnerMeta.json.features.jobDefaults,
      runnerMeta.json.features.jobDefaultsApply,
    ],
    [false, false],
  );
  const runnerFrom = exchanges.length;
  await view.navigate(
    `${origin}${uis.runner.basePath}/queues/${LOCKED}?panel=job-defaults`,
  );
  /** Whether the runner-mode page has read its permissions yet. */
  const readPermissions = (): boolean =>
    exchanges
      .slice(runnerFrom)
      .some(
        (one) =>
          !one.direct &&
          one.api === runner.basePath &&
          one.path === "/meta/permissions",
      );
  await waitFor(
    "the runner-mode page to read its permissions",
    readPermissions,
  );
  const runnerPage = await view.evaluate<string | null>(
    poll(
      `(() => {
        const main = document.querySelector("main");
        const text = main ? main.textContent.trim() : "";
        return text !== "" && !text.includes("Loading") ? text : null;
      })()`,
    ),
  );
  show("the runner-mode page reads", runnerPage?.slice(0, 120));
  check(
    "no Job defaults panel and no Job defaults tab",
    !(await view.evaluate<boolean>(
      `!!document.querySelector(${JSON.stringify(PANEL)})`,
    )) &&
      !(
        await view.evaluate<string[]>(
          `[...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent.trim())`,
        )
      ).includes("Job defaults"),
  );
  checkEqual(
    "and the page sent no request to a job-defaults route",
    exchanges
      .slice(runnerFrom)
      .filter((one) => one.path.includes("job-defaults"))
      .map((one) => `${one.method} ${one.api}${one.path}`),
    [],
  );
  checkEqual(
    "GET …/job-defaults on that API → 404",
    (await call(runner.basePath, "GET", `/queues/${LOCKED}/job-defaults`))
      .status,
    404,
  );

  /* ---------------------------------------------------------------- */
  step(
    "No batched rewrite (features.jobDefaultsApply false): Settings…, no Apply",
  );

  const PARTIAL = "newsletters";
  await queueOf(noApplyJobs, PARTIAL).add("send", {}, { jobId: "w1" });
  const partialSave = await call(
    noApply.basePath,
    "PUT",
    `/queues/${PARTIAL}/job-defaults`,
    { attempts: 2 },
  );
  const noApplyMeta = await call<{ features: Record<string, boolean> }>(
    noApply.basePath,
    "GET",
    "/meta",
  );
  checkEqual(
    "GET /meta → jobDefaults true, jobDefaultsApply false; a save still works (200)",
    [
      noApplyMeta.json.features.jobDefaults,
      noApplyMeta.json.features.jobDefaultsApply,
      partialSave.status,
    ],
    [true, false, 200],
  );
  const partialFrom = exchanges.length;
  check(
    "the panel shows",
    await openPanel(uis.noApply.basePath, PARTIAL),
    pageConsole,
  );
  await view.evaluate(kvRows(".job-defaults-pending", 'rows.Total === "1"'));
  checkEqual(
    "an override and a pending job, yet only Settings… is offered — no Apply, no note",
    [
      await view.evaluate<string[]>(buttonsIn(PANEL_ACTIONS)),
      await view.evaluate<boolean>(
        `!!document.querySelector('[data-testid="apply-unavailable"]')`,
      ),
    ],
    [["Settings…"], false],
  );
  checkEqual(
    "and the page sent no apply request",
    exchanges
      .slice(partialFrom)
      .filter((one) => one.path.endsWith("/apply"))
      .map((one) => `${one.method} ${one.api}${one.path}`),
    [],
  );
} catch (error) {
  console.log(`page console:\n${pageConsole.join("\n")}`);
  throw error;
} finally {
  await shutdown(view);
}

summary();
