/**
 * The queue, job and runner screens in a real browser: pause a queue by
 * clicking, check the Clean dialog's default, open a dead job and retry it,
 * open a job of a queue whose jobs this caller may not read, then pause a
 * runner, read the runner list's badges (a remote runner's Paused or Active,
 * and Run in flight) and open a runner this caller may not read. Every step is read back from
 * the API or the host, not from the page.
 *
 * ```bash
 * bun 06-browser/pause-and-retry.ts
 * BUN_CHROME_PATH=/opt/chrome/chrome bun 06-browser/pause-and-retry.ts
 * EXAMPLE_BROWSER=0 bun 06-browser/pause-and-retry.ts   # skip on purpose
 * ```
 *
 * It drives headless Chrome through `Bun.WebView` (the DevTools protocol, with
 * `backend: { type: "chrome", url: false }` so it always starts its own Chrome
 * rather than attaching to one you have open). This is the pattern of the
 * package's own `__tests__/e2e/m2-flow.e2e.test.ts`. **It skips** (prints
 * `skipped:` and exits 0, which `bun run-all.ts` reports as `skip`) when this
 * Bun has no `Bun.WebView`, when no Chrome is found, or when Chrome will not
 * start.
 *
 * Worth knowing:
 *
 * - **Hooks to drive the screens by.** They are stable on purpose:
 *   `data-testid` `queues-list`, `queue-screen`, `queue-total`,
 *   `job-row-<id>`, `job-screen`, `job-id`, `job-not-found`, `job-hidden`,
 *   `runner-row-<id>`, `runner-screen` and `runner-hidden`. The queue's buttons are in
 *   `[role="group"][aria-label="Queue actions"]`, a runner's in
 *   `[role="group"][aria-label="Runner actions"]`, and a confirmation is the
 *   open `<dialog>` (`dialog[open]`).
 * - **Wait on conditions, never on time.** Every page-side helper below polls
 *   the DOM until what it wants is there (or a deadline passes), and every
 *   API check polls the API. Nothing sleeps for a guessed duration, so the run
 *   is as fast as the app and fails with the name of what never happened.
 * - **The page's own state is not the proof.** The API is: a click counts
 *   when `GET /queues/mail` says `paused: true`.
 * - **The runner list's window is in the URL, and a filter resets it.** Four
 *   runners against a page of 25 grow no pager; `?limit=2` makes them two
 *   pages, Next writes `offset` into the URL, and an `offset` past the end
 *   lands on the last page with rows rather than on an empty table. Typing in
 *   the filter drops `offset` and keeps `limit`, so a narrower list starts at
 *   its beginning. The size the URL asked for is always among the sizes the
 *   "Rows per page" select offers.
 * - **A hidden job or runner is never fetched.** The job screen asks for
 *   `jobs.read` on the queue's own map (`/meta/permissions?queue=`), and
 *   the runner screen for `runners.read` on the runner's
 *   (`?runner=`). Each waits for that answer before its first read (a
 *   spinner shows meanwhile), so this host can say `true` untargeted and
 *   `false` for one queue or runner, and not one request for that queue's
 *   job or that runner reaches it.
 * - **The CSP holds.** The page raises no Content-Security-Policy violation
 *   along the way, checked with a `ReportingObserver`.
 */
import type {
  BunRunner,
  JobsApiAuthorize,
  MetaDto,
} from "@kingsleyweb/bun-jobs";
import type { PagerView } from "./helpers/page";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
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
import { pagerOf, pagersWhen, pagerWhen, poll, typeInto } from "./helpers/page";

// Decide whether to skip before printing anything: run-all.ts recognises a
// skip by the output *starting* with `skipped:`.
const chromePath = chromeOrSkip();

/** The queue the page manages. */
const QUEUE = "mail";
/** A dead job, with a `/` in its id so its URL carries `%2F`. */
const DEAD_ID = "bounce/ada";
/** A queue whose jobs this caller may list but not read. */
const VAULT = "vault";
/** The job in it. */
const VAULT_JOB = "payslip-1";
/** A runner the page pauses. */
const RUNNER = "nightly";
/** A runner this caller may list but not read. */
const SECRET_RUNNER = "payroll-export";
/** A runner only another process registered, paused there. */
const REMOTE_PAUSED = "partner-feed";
/** A runner only another process registered, with a run in flight there. */
const REMOTE_BUSY = "partner-sync";

/* --- the server: a real API with CSRF on, and the UI --------------- */

const jobs = new BunJobs({
  namespace: "examples-ui-browser",
  driver: new MemoryDriver(),
  logger: noopLogger,
});

/** Every `jobs.read` that `authorize` was asked about one of vault's jobs. */
const vaultJobReads: string[] = [];

/**
 * Everything is allowed, untargeted too, except reading vault's jobs and
 * anything about the secret runner. The screens wait for the targeted map,
 * so the untargeted yes never lets a read of either out.
 */
const authorize: JobsApiAuthorize = (_req, ctx) => {
  if (ctx.runner === SECRET_RUNNER) {
    return { allow: false, reason: `runner ${SECRET_RUNNER}` };
  }
  if (ctx.action !== "jobs.read") {
    return true;
  }
  if (ctx.queue === VAULT && ctx.jobId !== undefined) {
    vaultJobReads.push(ctx.jobId);
  }
  if (ctx.queue === VAULT) {
    return { allow: false, reason: `jobs of ${ctx.queue}` };
  }
  return true;
};

const api = createJobsApi({
  jobs,
  basePath: "/jobs-api",
  authorize,
  // The UI reads the header name from `api.info` and sends it on mutations.
  csrf: { header: "x-bun-jobs-csrf" },
  // Read queue state fresh, so `paused` is true the moment the click lands.
  limits: { queueCacheMs: 0 },
  logger: noopLogger,
});
const ui = jobsUi({ api, logger: noopLogger });
const app = new BunHttpAdapter();

/** Every request the host received for one of vault's jobs (not its list). */
const vaultJobRequests: string[] = [];
/** How often the page asked for vault's own permissions map. */
let vaultMaps = 0;
/** Every request the host received for the secret runner. */
const secretRunnerRequests: string[] = [];
/** How often the page asked for the secret runner's own permissions map. */
let secretRunnerMaps = 0;
// Ahead of the API, so it sees every request whatever the API answers.
app.use((req, _res, next) => {
  if (req.originalUrl.startsWith(`${api.basePath}/queues/${VAULT}/jobs/`)) {
    vaultJobRequests.push(`${req.method} ${req.originalUrl}`);
  }
  if (req.originalUrl === `${api.basePath}/meta/permissions?queue=${VAULT}`) {
    vaultMaps++;
  }
  if (req.originalUrl.startsWith(`${api.basePath}/runners/${SECRET_RUNNER}`)) {
    secretRunnerRequests.push(`${req.method} ${req.originalUrl}`);
  }
  if (
    req.originalUrl ===
    `${api.basePath}/meta/permissions?runner=${SECRET_RUNNER}`
  ) {
    secretRunnerMaps++;
  }
  next();
});
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);
await app.listen(0);
const origin = app.url!.replace(/\/$/, "");

/**
 * "Another process", as far as the API can tell: a second context on the
 * same driver and namespace, whose runners this one never registers.
 */
const elsewhere = new BunJobs({
  namespace: jobs.namespace,
  driver: jobs.driver,
  logger: noopLogger,
});

/** Winds everything down; safe to call more than once. */
async function shutdown(view?: Bun.WebView): Promise<void> {
  view?.close();
  await app.close();
  await api.close();
  await elsewhere.close();
  await jobs.close();
}

// One dead job (through a real worker), then two waiting ones.
const queue = jobs.queue(QUEUE);
await queue.add(
  "bounce",
  { to: "ada@old.example" },
  { jobId: DEAD_ID, attempts: 1 },
);
const worker = jobs.worker(QUEUE, async () => {
  throw new Error("SMTP refused");
});
void worker.run();
await waitFor("the job to die", async () => (await queue.count()).dead === 1);
await worker.close({ timeout: 1_000 });
await queue.add("send-email", { to: "alan@example.com" });
await queue.add("send-email", { to: "grace@example.com" });
await jobs.queue(VAULT).add("payslip", { to: "ada" }, { jobId: VAULT_JOB });
// Two runners in this process, started; nothing is scheduled to run.
for (const id of [RUNNER, SECRET_RUNNER]) {
  await jobs
    .runner({
      id,
      file: new URL("../shared/handlers/hold.ts", import.meta.url),
      executionMode: "in-process",
      waitToExit: false,
    })
    .start();
}

// Two runners registered only elsewhere: one paused, one with a run holding
// its lock. The list shows each with the badges `isPaused` and `isRunning`
// give it, though this process has no status for either.
const [remotePaused, remoteBusy] = [REMOTE_PAUSED, REMOTE_BUSY].map((id) =>
  elsewhere.runner({
    id,
    file: new URL("../shared/handlers/hold.ts", import.meta.url),
    executionMode: "in-process",
    waitToExit: false,
  }),
) as [BunRunner<any, any>, BunRunner<any, any>];
await remotePaused.start();
await remotePaused.pause();
await remoteBusy.start();
// Held until the context closes: `close()` stops the runner, which aborts it.
await remoteBusy.trigger({ args: { ms: 3_600_000 } });

// Build the bundle before the browser asks, so the first page load is not
// the in-memory build.
await (await fetch(`${origin}${ui.basePath}`)).arrayBuffer();

/* --- the browser: skip, not fail, if Chrome will not start --------- */

/** What the page printed to its console, for a failure's diagnosis. */
const pageConsole: string[] = [];
const view = await openView(chromePath, pageConsole, shutdown);

title("Pause a queue, retry a dead job and pause a runner, in Chrome");
show("Chrome", chromePath);
show("serving", `${origin}${ui.basePath}`);

/* --- page-side helpers: each resolves once its condition holds ----- */

/**
 * Page-side: the value of the input labelled `label` inside the open
 * dialog, once it exists (or `null` after `ms`).
 */
function dialogInput(label: string, ms = 10_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const poll = () => {
      for (const element of document.querySelectorAll("dialog[open] label")) {
        if (element.textContent.trim() === ${JSON.stringify(label)}) {
          const input = document.getElementById(element.htmlFor);
          if (input) return resolve(input.value);
        }
      }
      if (Date.now() > deadline) return resolve(null);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/**
 * Page-side: clicks the first link inside `selector`, once it exists.
 * Resolves with its `href`, or `null` after `ms`.
 */
function clickLinkIn(selector: string, ms = 15_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const poll = () => {
      const link = document.querySelector(${JSON.stringify(`${selector} a[href]`)});
      if (link) {
        const href = link.getAttribute("href");
        link.click();
        return resolve(href);
      }
      if (Date.now() > deadline) return resolve(null);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/** Page-side: every link inside `selector`, as `[text, href]` pairs. */
function linksIn(selector: string): string {
  return `[...document.querySelectorAll(${JSON.stringify(`${selector} a[href]`)})]
    .map((link) => [link.textContent.trim(), link.getAttribute("href")])`;
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

/** The queue's action buttons. */
const QUEUE_ACTIONS = '[role="group"][aria-label="Queue actions"]';
/** A runner's action buttons. */
const RUNNER_ACTIONS = '[role="group"][aria-label="Runner actions"]';

/**
 * Page-side: the badge texts in each runner row's Status column (the third
 * cell of `runner-row-<id>`), as `[id, texts]` pairs.
 */
function statusBadges(ids: string[]): string {
  return `${JSON.stringify(ids)}.map((id) => [
    id,
    [...document.querySelectorAll(\`[data-testid="runner-row-\${id}"] td:nth-child(3) .badge\`)]
      .map((badge) => badge.textContent.trim()),
  ])`;
}

/**
 * Page-side: the query the URL carries now, as sorted `[name, value]` pairs —
 * what a screen's state *is*, without depending on the order the app happens
 * to write the parameters in.
 */
const QUERY = `[...new URLSearchParams(location.search).entries()].sort()`;

/**
 * Page-side: the runner ids of the rows on screen, in order, once `ready(ids)`
 * holds (a page-side expression over `ids`); `null` when it never does.
 */
function runnerRows(ready = "true"): string {
  return poll(`(() => {
    const ids = [...document.querySelectorAll('[data-testid="runners-list"] tr[data-testid^="runner-row-"]')]
      .map((row) => row.dataset.testid.slice("runner-row-".length));
    return (${ready}) ? ids : null;
  })()`);
}

/** A JSON read from the API, bypassing the page. */
async function read<T>(path: string): Promise<T> {
  const response = await fetch(`${origin}${api.basePath}${path}`);
  return (await response.json()) as T;
}

try {
  /* ---------------------------------------------------------------- */
  step("The queue list links to mail");

  await view.navigate(`${origin}${ui.basePath}/queues`);
  check(
    "the queue list renders (data-testid=queues-list)",
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="queues-list"]'),
    ),
    pageConsole,
  );
  check(
    "with a link to /jobs/queues/mail",
    await view.evaluate<boolean>(
      waitForSelector(`a[href="${ui.basePath}/queues/${QUEUE}"]`),
    ),
  );

  /* ---------------------------------------------------------------- */
  step("Pause mail from its screen");

  await view.navigate(`${origin}${ui.basePath}/queues/${QUEUE}`);
  checkEqual(
    "the queue screen shows the total (data-testid=queue-total)",
    await view.evaluate<string | null>(textOf('[data-testid="queue-total"]')),
    "3 jobs",
  );
  check(
    "Pause is offered in the Queue actions group",
    await view.evaluate<boolean>(button(QUEUE_ACTIONS, "Pause", true)),
  );
  await waitFor(
    "the API to report mail paused",
    async () => (await read<{ paused: boolean }>(`/queues/${QUEUE}`)).paused,
  );
  check("GET /queues/mail → paused: true", true);
  check(
    "and the screen now offers Resume",
    await view.evaluate<boolean>(button(QUEUE_ACTIONS, "Resume", false)),
  );

  /* ---------------------------------------------------------------- */
  step("Clean… starts from /meta's limits.defaultClean");

  const { limits } = await read<MetaDto>("/meta");
  show("GET /meta → limits.defaultClean", limits.defaultClean);
  check(
    "Clean… is offered",
    await view.evaluate<boolean>(button(QUEUE_ACTIONS, "Clean…", true)),
  );
  checkEqual(
    "its Limit field starts at limits.defaultClean",
    await view.evaluate<string | null>(dialogInput("Limit")),
    String(limits.defaultClean),
  );
  check(
    "Cancel is offered in it",
    await view.evaluate<boolean>(button("dialog[open]", "Cancel", true)),
  );
  checkEqual(
    "and closes it, with all 3 jobs still in mail",
    [
      await view.evaluate<boolean>(`new Promise((resolve) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          if (!document.querySelector("dialog[open]")) return resolve(true);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(poll, 50);
        };
        poll();
      })`),
      (await read<{ total: number }>(`/queues/${QUEUE}`)).total,
    ],
    [true, 3],
  );

  /* ---------------------------------------------------------------- */
  step("Open the dead job and retry it");

  const jobUrl = `${origin}${ui.basePath}/queues/${QUEUE}/jobs/${encodeURIComponent(DEAD_ID)}`;
  show("job URL", jobUrl);
  await view.navigate(jobUrl);
  checkEqual(
    "the job screen shows its id, decoded (data-testid=job-id)",
    await view.evaluate<string | null>(textOf('[data-testid="job-id"]')),
    DEAD_ID,
  );
  check(
    "Retry is offered for a dead job",
    await view.evaluate<boolean>(
      button('[data-testid="job-screen"]', "Retry", true),
    ),
  );
  check(
    "and confirmed in the open dialog",
    await view.evaluate<boolean>(button("dialog[open]", "Retry", true)),
  );
  await waitFor("the API to report the job retried", async () => {
    const job = await read<{ state: string }>(
      `/queues/${QUEUE}/jobs/${encodeURIComponent(DEAD_ID)}`,
    );
    return job.state !== "dead";
  });
  // The queue is paused and nothing consumes it, so the retried job holds
  // still in `waiting`.
  checkEqual(
    "GET the job → waiting, its attempts reset",
    await read<{ state: string; attemptsMade: number }>(
      `/queues/${QUEUE}/jobs/${encodeURIComponent(DEAD_ID)}`,
    ).then((job) => [job.state, job.attemptsMade]),
    ["waiting", 0],
  );

  /* ---------------------------------------------------------------- */
  step("A job that does not exist");

  await view.navigate(`${origin}${ui.basePath}/queues/${QUEUE}/jobs/missing`);
  check(
    "shows data-testid=job-not-found",
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="job-not-found"]'),
    ),
  );

  /* ---------------------------------------------------------------- */
  step("A job this caller may not read: vault");

  await view.navigate(`${origin}${ui.basePath}/queues/${VAULT}`);
  // jobs.list is allowed, so the table lists the job and links to it.
  checkEqual(
    "vault's jobs table links to its job",
    await view.evaluate<string | null>(
      clickLinkIn(`[data-testid="job-row-${VAULT_JOB}"]`),
    ),
    `${ui.basePath}/queues/${VAULT}/jobs/${VAULT_JOB}`,
  );
  checkEqual(
    "clicking it shows data-testid=job-hidden, not the job",
    await view.evaluate<string | null>(textOf('[data-testid="job-hidden"]')),
    `Job hiddenYou may not read the jobs of queue ${VAULT}.Back to ${VAULT}`,
  );
  checkEqual(
    "with a link back to the queue",
    await view.evaluate<[string, string][]>(
      linksIn('[data-testid="job-hidden"]'),
    ),
    [[`Back to ${VAULT}`, `${ui.basePath}/queues/${VAULT}`]],
  );
  await waitFor("the page to ask vault's own map", () => vaultMaps > 0);
  check(
    "no job-screen markup at all",
    !(await view.evaluate<boolean>(
      waitForSelector('[data-testid="job-screen"]', 0),
    )),
  );
  checkEqual(
    "and the job was never requested: none reached the host, none authorize",
    [vaultJobRequests, vaultJobReads],
    [[], []],
  );
  // The API is the authority either way: the same read, sent anyway.
  const refused = await fetch(
    `${origin}${api.basePath}/queues/${VAULT}/jobs/${VAULT_JOB}`,
  );
  checkEqual(
    "GET the vault job directly → 403",
    [refused.status, vaultJobRequests.length, vaultJobReads.length],
    [403, 1, 1],
  );

  /* ---------------------------------------------------------------- */
  step("Pause a runner from its screen");

  await view.navigate(`${origin}${ui.basePath}/runners/${RUNNER}`);
  check(
    "the runner screen renders (data-testid=runner-screen)",
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="runner-screen"]'),
    ),
    pageConsole,
  );
  check(
    "Pause is offered in the Runner actions group",
    await view.evaluate<boolean>(button(RUNNER_ACTIONS, "Pause", true)),
  );
  await waitFor(
    "the API to report the runner paused",
    async () =>
      (await read<{ isPaused: boolean }>(`/runners/${RUNNER}`)).isPaused,
  );
  check(`GET /runners/${RUNNER} → isPaused: true`, true);
  check(
    "and the screen now offers Resume…",
    await view.evaluate<boolean>(button(RUNNER_ACTIONS, "Resume…", false)),
  );

  /* ---------------------------------------------------------------- */
  step("The runner list: Paused, Active and Run in flight");

  await waitFor(
    `the API to report ${REMOTE_BUSY}'s run in flight`,
    async () =>
      (
        await read<{ items: { id: string; isRunning: boolean }[] }>("/runners")
      ).items.find((item) => item.id === REMOTE_BUSY)?.isRunning === true,
  );
  await view.navigate(`${origin}${ui.basePath}/runners`);
  check(
    `the list renders its rows (data-testid=runner-row-${REMOTE_BUSY})`,
    await view.evaluate<boolean>(
      waitForSelector(`[data-testid="runner-row-${REMOTE_BUSY}"]`),
    ),
    pageConsole,
  );
  checkEqual(
    "each row's Status badges: a local lifecycle, or a remote Paused/Active, plus Run in flight",
    await view.evaluate<[string, string[]][]>(
      statusBadges([RUNNER, REMOTE_PAUSED, REMOTE_BUSY]),
    ),
    [
      // Local: its lifecycle status, paused by the step above.
      [RUNNER, ["Paused"]],
      // Remote: no status here, so Paused from isPaused...
      [REMOTE_PAUSED, ["Paused"]],
      // ...or Active, and Run in flight from isRunning.
      [REMOTE_BUSY, ["Active", "Run in flight"]],
    ],
  );

  /* ---------------------------------------------------------------- */
  step("The runner list's window is in the URL, and a filter resets it");

  /** The runner list, and its filter's accessible name. */
  const RUNNERS = '[data-testid="runners-list"]';
  /** What the filter box is labelled. */
  const FILTER_LABEL = "Filter runners by id or name";

  const registered = (
    await read<{ items: { id: string }[] }>("/runners")
  ).items.map((item) => item.id);
  show("the runners the API lists", registered);
  checkEqual(
    "four runners against a page of 25, so the list shows no pager at all",
    [
      registered.length,
      await view.evaluate<string[] | null>(
        runnerRows(`ids.length === ${registered.length}`),
      ),
      await view.evaluate<string[] | null>(pagersWhen("labels.length === 0")),
    ],
    [4, registered, []],
  );

  // `/runners` is the one pager whose size comes from the URL rather than a
  // constant in the app, so `?limit=` is what makes four runners two pages.
  await view.navigate(`${origin}${ui.basePath}/runners?limit=2`);
  const firstTwo = await view.evaluate<string[] | null>(
    runnerRows("ids.length === 2"),
  );
  const listPage1 = await view.evaluate<PagerView | null>(
    pagerOf("Runner pages"),
  );
  show("the runner list's pager at ?limit=2", listPage1);
  checkEqual(
    "?limit=2 → two pages of the four, the first of them",
    [
      listPage1?.range,
      listPage1?.size,
      listPage1?.pageControl?.options,
      listPage1?.prev,
      listPage1?.next,
    ],
    ["1–2 of 4", 2, ["1", "2"], false, true],
  );
  // The size in force is always offered, so a `limit` a link carries is never
  // silently dropped from the select it belongs to. At the default 25 the
  // select reads 10, 20, 25, 50, 100 for exactly this reason.
  checkEqual(
    "and the size the URL asked for is among the sizes offered, beside the defaults",
    listPage1?.sizes,
    [2, 10, 20, 50, 100],
  );

  check(
    "Next turns the page",
    await view.evaluate<boolean>(
      button('nav.pager[aria-label="Runner pages"]', "Next", true),
    ),
  );
  const lastTwo = await view.evaluate<string[] | null>(
    runnerRows(
      `ids.length === 2 && ids.join(",") !== ${JSON.stringify((firstTwo ?? []).join(","))}`,
    ),
  );
  const listPage2 = await view.evaluate<PagerView | null>(
    pagerWhen("Runner pages", 'pager.pageControl.value === "2"'),
  );
  checkEqual(
    "the window is written to the URL, so the page a link opens is the page being read",
    [
      await view.evaluate<[string, string][]>(QUERY),
      listPage2?.range,
      listPage2?.next,
    ],
    [
      [
        ["limit", "2"],
        ["offset", "2"],
      ],
      "3–4 of 4",
      false,
    ],
  );
  checkEqual(
    "and the two pages share no runner and cover every one the API listed",
    [
      (lastTwo ?? []).filter((id) => (firstTwo ?? []).includes(id)),
      [...(firstTwo ?? []), ...(lastTwo ?? [])].slice().sort(),
    ],
    [[], registered.slice().sort()],
  );

  // An offset past the end lands on the last page with rows, not on an empty
  // table: these lists poll, so rows go while somebody is reading the last
  // page of them.
  await view.navigate(`${origin}${ui.basePath}/runners?offset=1000&limit=2`);
  const clamped = await view.evaluate<PagerView | null>(
    pagerOf("Runner pages"),
  );
  checkEqual(
    "?offset=1000 shows the last page with rows on it, never an empty table",
    [
      clamped?.range,
      clamped?.next,
      await view.evaluate<string[] | null>(runnerRows("ids.length === 2")),
    ],
    ["3–4 of 4", false, lastTwo],
  );

  // The reset: a filter narrows the list under the window, so the window goes
  // back to the start. Without it, typing on page 2 would answer with the
  // second page of the matches — or with the end of a list the reader had not
  // seen the start of.
  await view.navigate(`${origin}${ui.basePath}/runners?offset=2&limit=2`);
  await view.evaluate(runnerRows("ids.length === 2"));
  check(
    "the filter box takes a letter three of the four runners share",
    await view.evaluate<boolean>(typeInto(RUNNERS, FILTER_LABEL, "p")),
  );
  const matching = registered.filter((id) => id.includes("p"));
  const filtered = await view.evaluate<PagerView | null>(
    pagerWhen("Runner pages", `pager.range === "1–2 of ${matching.length}"`),
  );
  checkEqual(
    "the offset is dropped from the URL and the filter kept: the window is back at the start",
    [
      await view.evaluate<[string, string][]>(QUERY),
      filtered?.range,
      filtered?.pageControl?.value,
      filtered?.prev,
    ],
    [
      [
        ["limit", "2"],
        ["search", "p"],
      ],
      `1–2 of ${matching.length}`,
      "1",
      false,
    ],
  );
  checkEqual(
    `the first two of the ${matching.length} matches, in the list's own order`,
    await view.evaluate<string[] | null>(runnerRows("ids.length === 2")),
    [...(firstTwo ?? []), ...(lastTwo ?? [])]
      .filter((id) => matching.includes(id))
      .slice(0, 2),
  );

  /* ---------------------------------------------------------------- */
  step("A runner this caller may not read");

  await view.navigate(`${origin}${ui.basePath}/runners/${SECRET_RUNNER}`);
  check(
    "shows data-testid=runner-hidden",
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="runner-hidden"]'),
    ),
  );
  await waitFor(
    "the page to ask the runner's own map",
    () => secretRunnerMaps > 0,
  );
  checkEqual(
    "and the runner was never requested, though runners.read is true untargeted",
    secretRunnerRequests,
    [],
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
