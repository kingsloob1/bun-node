/**
 * Paging the queue's **jobs table** in a real browser, against a real
 * `createJobsApi`: the table jumps by offset and walks by cursor, and the two
 * mix. Every claim here is asserted twice over — once on the screen, and once
 * on the request that produced it, read off the host ahead of the API — so a
 * page that happens to look right for the wrong reason fails.
 *
 * ```bash
 * bun 06-browser/jobs-paging.ts
 * BUN_CHROME_PATH=/opt/chrome/chrome bun 06-browser/jobs-paging.ts
 * EXAMPLE_DRIVER=sqlite bun 06-browser/jobs-paging.ts
 * EXAMPLE_BROWSER=0 bun 06-browser/jobs-paging.ts   # skip on purpose
 * ```
 *
 * It drives headless Chrome through `Bun.WebView`, like the rest of
 * `06-browser/`, and **skips** (prints `skipped:` and exits 0) when this Bun
 * has no `Bun.WebView`, when no Chrome is found, or when Chrome will not
 * start.
 *
 * Worth knowing:
 *
 * - **The headline: a walk sees rows an offset turn does not.** Two queues
 *   seeded identically, each read to its first page and then drained by
 *   exactly the five jobs that page showed. The one turned with the **Page**
 *   control skips the next five jobs — named here by id, so the check cannot
 *   pass for the wrong reason — and says nothing: no repeated row, no error,
 *   no field of the answer that differs from a page that lost nothing. The
 *   one turned with **Next** sends the page's cursor and shows exactly those
 *   five.
 * - **Every page mints a cursor, a jumped-to page included.** `?offset=10`
 *   is an offset read, and the Next after it carries a `cursor` and **no
 *   `offset` at all** — asserted on the wire, since an offset sent beside a
 *   cursor is silently ignored (that too is checked, by hand, naming the
 *   dropped number).
 * - **Whether a walked page has row numbers is a property of the answer, not
 *   of the backend.** The UI reads `page.offset` off each page. The sharp case
 *   is one driver answering both ways in one run: on the **file** driver an
 *   unfiltered walked page carries an offset (the range reads "5–8", with a
 *   "Page 2") and a `name=alpha` walked page carries none (the range counts —
 *   "4 rows" — and there is no page number, because nothing here knows which
 *   page it is). Each rendering is asserted against
 *   `Object.hasOwn(page, "offset")` on the very request the page sent,
 *   replayed from here — never against the driver's name, and never as
 *   `page.offset === null`: an unnumbered page **omits** the key.
 * - **The Active tab follows the same one rule as every other tab**, and no
 *   tab is special-cased: the table walks whenever the page it holds carries a
 *   cursor. A cursor is refused for `state=active` only while the sort is the
 *   lock expiry; the UI asks for
 *   `sort=createdAt` wherever `features.addedByState` is true, and that order
 *   can be walked. So the tab walks on memory, SQL and MongoDB, and keeps its
 *   offset pager on a backend that cannot sort by creation time (the file
 *   driver). This example asserts whichever of the two its host reports, and
 *   the refusal itself by hand: `state=active` with a `cursor` and no `sort`
 *   is a 400 explaining that a worker rewrites `lockExpiresAt` on every lock
 *   renewal. See the note at the end of this file.
 * - **A walk cannot outlive its walk.** Changing the names filter, the order,
 *   the state tab or "Count total" restarts paging in the same render, so no
 *   request ever carries a cursor from before the change — asserted on the
 *   wire, with the walked request it replaced, so the check fails on a table
 *   that never walked at all. A cursor sent into another walk by hand is a
 *   real 400 ("this cursor belongs to another walk"), and the same cursor in
 *   its own walk is a 200, so the refusal cannot come from a broken cursor.
 * - **The cursor is not in the URL, and a reload re-samples.** It is opaque
 *   and up to 2 kB — a trail of them certainly does not belong in a link, and
 *   the run prints what one of them really measures rather than claiming a
 *   size, since it holds the backend's own ordering key. So the URL keeps saying where the
 *   walk *started*, as an offset; a reload lands back on that offset page.
 * - **A resize keeps the walk's place.** The cursor that produced the page is
 *   re-sent with the new size, so the page keeps its first row rather than
 *   snapping to a multiple of the new size.
 * - **A full page can be the last page.** `page.next` is the only end signal:
 *   a walk over eight jobs in pages of four ends on a page holding four rows
 *   — exactly the limit — with `next: null`, `hasMore: false`, and Next
 *   disabled. A reader who judges the end by a short page never recognises
 *   this one, and has nothing to ask again with: a short page is not coming,
 *   and could not have been the signal anyway, since a filter shortens a page
 *   anywhere in a list.
 * - **The page's own poll is held while the drain happens.** The jobs read
 *   refetches every few seconds and nothing outside the app can turn that
 *   off; a refresh landing between the drain and the page turn would *show*
 *   the rows the offset turn is about to skip, and the headline would be
 *   false for that run. So, for that one step, the host holds the reads that
 *   name neither an `offset` nor a `cursor` — the poll, and only the poll, as
 *   a slow network would. The turn's own request always names one of the two,
 *   so it is never held. No socket is attached either, so nothing invalidates
 *   on an event.
 * - **Wait on conditions, never on time.** Every page-side helper polls the
 *   DOM to a deadline. After a turn the old rows stay on screen while the
 *   next read is in flight (`keepPreviousData`), so nothing here reads a
 *   pager until the row ids it belongs to are the ones on screen.
 * - **Hooks to drive it by:** `data-testid` `job-row-<id>`, the section
 *   `[aria-label="Jobs"]`, the pager `nav.pager[aria-label="Job pages"]`, the
 *   filters `form.jobs-filters` and the tabs
 *   `[role="tablist"][aria-label="Job states"]`.
 *
 * **Two hosts, on purpose.** The main one runs on `EXAMPLE_DRIVER` (memory by
 * default), so a sweep exercises the whole file on every backend. The second
 * always runs on the **file** driver, whatever `EXAMPLE_DRIVER` says, because
 * that is the driver that answers a walked page both ways — numbered
 * unfiltered, unnumbered filtered — and a pair in one run is what makes
 * "per answer, not per backend" an assertion rather than a sentence.
 */
import type {
  DriverConfig,
  JobsApi,
  JobsApiAuthorize,
  MetaDto,
} from "@kingsleyweb/bun-jobs";
import type { PagerView } from "./helpers/page";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi } from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
import { exampleBackend, exampleDriver } from "../shared/backend";
import { button, chromeOrSkip, openView } from "../shared/browser";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { choose, pagerOf, poll, typeInto } from "./helpers/page";

// Decide whether to skip before printing anything: run-all.ts recognises a
// skip by the output *starting* with `skipped:`.
const chromePath = chromeOrSkip();

/** The namespace both hosts' contexts use; each has a driver of its own. */
const NAMESPACE = "examples-ui-jobs-paging";

/** The base path both APIs are mounted at, so one pattern matches both. */
const API_BASE = "/jobs-api";

/** What a cursor is replaced by before a request is compared: it is opaque. */
const OPAQUE = "<opaque>";

/** The queue the offset arm of the headline pages, and its job ids. */
const OFFSET_QUEUE = "letters";
/** The queue the walking arm pages. */
const WALK_QUEUE = "parcels";
/** How many jobs each headline queue holds. */
const HEADLINE_JOBS = 20;
/** Rows per page in the headline, so the drain is exactly one page. */
const HEADLINE_PAGE = 5;

/** The queue the jump, the restarts, the reload and the resize are shown on. */
const LEDGER = "ledger";
/** How many jobs it holds. */
const LEDGER_JOBS = 24;

/** The queue whose walk ends exactly on a full page. */
const OCTET = "octet";
/** How many jobs it holds: two full pages of {@link OCTET_PAGE} and nothing after. */
const OCTET_JOBS = 8;
/** Rows per page over it. */
const OCTET_PAGE = 4;

/** The queue whose jobs a worker holds active, for the Active tab. */
const ACTIVE_QUEUE = "holding";
/** How many jobs it holds active. */
const ACTIVE_JOBS = 4;

/** The queue the file host's numbering pair is read over. */
const NUMBERS = "numbers";
/** How many jobs it holds. */
const NUMBERS_JOBS = 24;
/** Rows per page over it. */
const NUMBERS_PAGE = 4;
/** The name half its jobs carry, and the only name the filtered walk asks for. */
const FILTERED_NAME = "alpha";

/** The id of the `index`th job of a queue, zero-padded so ids sort as numbers. */
function jobId(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(2, "0")}`;
}

/** The ids `prefix-from` … `prefix-(from + count - 1)`, in order. */
function jobIds(prefix: string, from: number, count: number): string[] {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    ids.push(jobId(prefix, from + index));
  }
  return ids;
}

/**
 * Which of two names the `index`th job of a mixed queue carries: half are
 * {@link FILTERED_NAME}, so a name filter halves the list rather than emptying
 * it.
 */
function alternating(index: number): string {
  return index % 2 === 0 ? FILTERED_NAME : "beta";
}

/**
 * While set, a host holds every jobs read that names neither an `offset` nor
 * a `cursor` — the page's own poll — until it settles. Only the headline step
 * sets it, and only so that a refresh cannot land between the drain and the
 * page turn; see the note at the top of this file.
 */
let pollGate: PromiseWithResolvers<void> | null = null;

/** Everything is allowed: this example is about paging, not permissions. */
const authorize: JobsApiAuthorize = () => true;

/** One jobs-list request a page sent, as the host saw it. */
interface Read {
  /** The queue whose jobs were asked for. */
  queue: string;
  /**
   * The query, as a name→value map with the `cursor` replaced by
   * {@link OPAQUE}. Compared whole, so a parameter that should **not** be
   * there fails the comparison as loudly as a wrong one.
   */
  wire: Record<string, string>;
  /** The whole `originalUrl`, so the very same request can be made again. */
  url: string;
}

/** A host: one `BunJobs`, its API and the UI, on an adapter of their own. */
interface Host {
  /** A short name for the printed lines. */
  label: string;
  /** Its origin, e.g. `http://localhost:41234`. */
  origin: string;
  /** Where the UI is mounted. */
  uiBase: string;
  /** The jobs context it serves. */
  jobs: BunJobs;
  /** Its `GET /meta`, read once at startup. */
  meta: MetaDto;
  /** Every jobs-list request its page sent, oldest first. */
  reads: Read[];
  /** Winds it down. */
  close: () => Promise<void>;
}

/** A jobs page exactly as it arrived, with nothing normalised away. */
interface Answer {
  /** Its HTTP status. */
  status: number;
  /** A problem's `detail`, or `""` when it is not one. */
  detail: string;
  /**
   * The `page` object's own fields, untouched — so `Object.hasOwn(page,
   * "offset")` says what the client really got. An unnumbered walked page
   * **omits** the key; it is never `null` on the wire.
   */
  page: Record<string, unknown>;
  /** The job ids on it, in order. */
  ids: string[];
}

/** Which jobs-list request a URL is, or `null`. */
const JOBS_PATH = new RegExp(`^${API_BASE}/queues/([^/]+)/jobs$`);

/** A request's query as a {@link Read.wire} map. */
function wireOf(query: URLSearchParams): Record<string, string> {
  const wire: Record<string, string> = {};
  for (const [name, value] of [...query.entries()].sort()) {
    wire[name] = name === "cursor" ? OPAQUE : value;
  }
  return wire;
}

/** Serves an API and the UI over `driver`, recording what the page asks for. */
async function serveHost(label: string, driver: DriverConfig): Promise<Host> {
  const jobs = new BunJobs({
    namespace: NAMESPACE,
    driver,
    logger: noopLogger,
  });
  const api: JobsApi = createJobsApi({
    jobs,
    basePath: API_BASE,
    authorize,
    // Read queue state fresh: a queue seeded a moment ago must be listable.
    limits: { queueCacheMs: 0 },
    logger: noopLogger,
  });
  const ui = jobsUi({ api, logger: noopLogger });
  const app = new BunHttpAdapter(0, { logger: noopLogger });
  const reads: Read[] = [];
  // Ahead of the API, so it sees every request whatever the API answers.
  app.use(async (req, _res, next) => {
    const [path = "", search = ""] = req.originalUrl.split("?");
    const match = JOBS_PATH.exec(path);
    if (req.method === "GET" && match) {
      const query = new URLSearchParams(search);
      reads.push({
        queue: decodeURIComponent(match[1] ?? ""),
        wire: wireOf(query),
        url: req.originalUrl,
      });
      if (pollGate !== null && !query.has("offset") && !query.has("cursor")) {
        await pollGate.promise;
      }
    }
    next();
  });
  app.use(API_BASE, api.router);
  app.use(ui.basePath, ui.router);
  await app.listen(0);
  const origin = app.url!.replace(/\/$/, "");
  const meta = (await (
    await fetch(`${origin}${API_BASE}/meta`)
  ).json()) as MetaDto;
  return {
    label,
    origin,
    uiBase: ui.basePath,
    jobs,
    meta,
    reads,
    close: async () => {
      await app.close();
      await api.close();
      await jobs.close();
    },
  };
}

/** Where the file host keeps its jobs; removed when the process exits. */
const FILE_ROOT = mkdtempSync(join(tmpdir(), "bun-jobs-ui-example-paging-"));
process.once("exit", () => rmSync(FILE_ROOT, { recursive: true, force: true }));

const main = await serveHost(exampleBackend(), exampleDriver());
const filed = await serveHost("file", { type: "file", root: FILE_ROOT });

/** Releases every held job. */
let releaseHeld: () => void = () => undefined;
/** Settles once {@link releaseHeld} is called. */
const held = new Promise<void>((resolve) => {
  releaseHeld = resolve;
});

/** Winds both hosts down; safe to call more than once. */
async function shutdown(view?: Bun.WebView): Promise<void> {
  view?.close();
  pollGate?.resolve();
  releaseHeld();
  await filed.close();
  await main.close();
}

/** Adds `count` jobs to `host`'s `queue`, ids `<prefix>-00` upwards, in order. */
async function seed(
  host: Host,
  queue: string,
  prefix: string,
  count: number,
  name: (index: number) => string = () => "dispatch",
): Promise<void> {
  const ref = host.jobs.queue(queue);
  for (let index = 0; index < count; index++) {
    await ref.add(name(index), { index }, { jobId: jobId(prefix, index) });
  }
}

/**
 * Takes `ids` out of `queue`, and answers which of them really left.
 *
 * A job leaving the head of the list is what draining does to an offset
 * window, and removing them says exactly when it happened — where waiting for
 * a worker to have eaten five would be a count that varies between runs, and a
 * headline resting on it would be flaky rather than wrong.
 */
async function drain(
  host: Host,
  queue: string,
  ids: readonly string[],
): Promise<string[]> {
  const gone: string[] = [];
  for (const id of ids) {
    if (await host.jobs.queue(queue).remove(id)) {
      gone.push(id);
    }
  }
  return gone;
}

/** Holds `ACTIVE_JOBS` of `host`'s {@link ACTIVE_QUEUE} active until shutdown. */
async function holdActive(host: Host): Promise<void> {
  await seed(host, ACTIVE_QUEUE, "h", ACTIVE_JOBS);
  const worker = host.jobs.worker(
    ACTIVE_QUEUE,
    async () => {
      await held;
      return "ok";
    },
    {
      concurrency: ACTIVE_JOBS,
      pollInterval: 20,
      waitToExit: false,
      logger: noopLogger,
    },
  );
  void worker.run();
  await waitFor(
    `${host.label}: ${ACTIVE_JOBS} jobs active`,
    async () =>
      (await host.jobs.queue(ACTIVE_QUEUE).count()).active === ACTIVE_JOBS,
  );
}

await seed(main, OFFSET_QUEUE, "L", HEADLINE_JOBS);
await seed(main, WALK_QUEUE, "P", HEADLINE_JOBS);
await seed(main, LEDGER, "G", LEDGER_JOBS, alternating);
await seed(main, OCTET, "O", OCTET_JOBS);
await holdActive(main);
await seed(filed, NUMBERS, "N", NUMBERS_JOBS, alternating);
await holdActive(filed);

// Build the bundle before the browser asks, so the first page load is not the
// in-memory build (and the second host reuses it: it is built once per
// process).
await (await fetch(`${main.origin}${main.uiBase}`)).arrayBuffer();

/* --- reading the host's side of it -------------------------------- */

/**
 * The jobs reads of one queue, with a read repeating its predecessor's whole
 * URL dropped — the page polls, and a poll of the page on screen is the same
 * request again. Two different cursors are two different URLs, so nothing a
 * move caused is ever collapsed away.
 */
function reads(host: Host, queue: string): Read[] {
  const distinct: Read[] = [];
  for (const read of host.reads) {
    if (read.queue === queue && distinct.at(-1)?.url !== read.url) {
      distinct.push(read);
    }
  }
  return distinct;
}

/** The newest jobs read of `queue`, which after a settled move is that move's. */
function lastRead(host: Host, queue: string): Read {
  const all = reads(host, queue);
  const read = all.at(-1);
  if (read === undefined) {
    throw new Error(`no jobs read of ${queue} reached ${host.label}`);
  }
  return read;
}

/** Makes the very request `read` was, from here, and answers what came back. */
async function replay(host: Host, read: Read): Promise<Answer> {
  return answerOf(await fetch(`${host.origin}${read.url}`));
}

/** `GET`s `path` under the host's API, bypassing the page. */
async function ask(host: Host, path: string): Promise<Answer> {
  return answerOf(await fetch(`${host.origin}${API_BASE}${path}`));
}

/** One answer, read without normalising the `page` object. */
async function answerOf(response: Response): Promise<Answer> {
  const body = (await response.json()) as {
    items?: { id: string }[];
    page?: Record<string, unknown>;
    detail?: unknown;
  };
  return {
    status: response.status,
    detail: typeof body.detail === "string" ? body.detail : "",
    page: body.page ?? {},
    ids: (body.items ?? []).map((job) => job.id),
  };
}

/** Whether a page carried its position — the one rule the row numbers follow. */
function numbered(answer: Answer): boolean {
  return Object.hasOwn(answer.page, "offset");
}

/**
 * The query the UI sends for a jobs page, as a {@link Read.wire} map: what
 * `jobListQuery` builds, which is worth stating once rather than in seven
 * expected values.
 *
 * `order=asc` is **not** sent — it is the API's own default, so only the
 * override `desc` travels — and `sort=createdAt` is sent only where the
 * backend serves it (`features.addedByState`) and nothing asked for a total.
 */
function expectedWire(
  host: Host,
  options: {
    /** The state tab. */
    state: string;
    /** Rows per page. */
    limit: number;
    /** `desc` sends `order=desc`; `asc` sends nothing. Defaults to `desc`. */
    order?: "asc" | "desc";
    /** The offset, when the page is counted to rather than walked to. */
    offset?: number;
    /** Whether a cursor travels instead. */
    cursor?: boolean;
    /** Whether a total was asked for. */
    total?: boolean;
    /** The exact name filter, when there is one. */
    name?: string;
  },
): Record<string, string> {
  const sorts = host.meta.features.addedByState && options.total !== true;
  return {
    state: options.state,
    limit: String(options.limit),
    ...(options.order === "asc" ? {} : { order: "desc" }),
    ...(options.offset === undefined ? {} : { offset: String(options.offset) }),
    ...(options.cursor === true ? { cursor: OPAQUE } : {}),
    ...(options.total === true ? { total: "true" } : {}),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(sorts ? { sort: "createdAt" } : {}),
  };
}

/* --- page-side helpers: each waits for its condition -------------- */

/** The jobs section, which holds the table, the filters and the pager. */
const JOBS = 'section[aria-label="Jobs"]';
/** The jobs table's pager. */
const PAGER = 'nav.pager[aria-label="Job pages"]';
/** The filters form. */
const FILTERS = "form.jobs-filters";

/**
 * Page-side: the job-row ids on screen, in order, once `ready(ids)` holds (a
 * page-side expression over `ids`); `null` after `ms`, so a failure prints
 * what was on screen instead.
 */
function jobRows(ready = "true", ms = 15_000): string {
  return poll(
    `(() => {
      const root = document.querySelector(${JSON.stringify(JOBS)});
      if (!root || root.querySelector(".spinner")) return null;
      const ids = [...root.querySelectorAll('tr[data-testid^="job-row-"]')]
        .map((row) => row.dataset.testid.slice("job-row-".length));
      return (${ready}) ? ids : null;
    })()`,
    ms,
  );
}

/**
 * Page-side: the rows, once they are exactly `ids`.
 *
 * Waiting for the row *identity* rather than for a pager value is the rule
 * here: after a turn the previous page's rows stay on screen while the next
 * read is in flight (`keepPreviousData`), so a pager read on a value alone
 * reads the old rows under the new range.
 */
function rowsAre(ids: readonly string[], ms = 15_000): string {
  return jobRows(
    `JSON.stringify(ids) === ${JSON.stringify(JSON.stringify([...ids]))}`,
    ms,
  );
}

/** Page-side: whether nothing on screen is an error view. */
const NO_ERROR = `!document.querySelector(".error-view")`;

/** Page-side: the URL's query now, as sorted `[name, value]` pairs. */
const QUERY = `[...new URLSearchParams(location.search).entries()].sort()`;

/** Page-side: clicks the state tab whose label is `label`. */
function clickTab(label: string): string {
  return poll(`(() => {
    const tab = [...document.querySelectorAll('[role="tablist"][aria-label="Job states"] [role="tab"]')]
      .find((candidate) => candidate.querySelector(".tab-label")?.textContent.trim() === ${JSON.stringify(label)});
    if (!tab || tab.disabled) return null;
    tab.click();
    return true;
  })()`);
}

/** Page-side: clicks the "Count total" checkbox and resolves its new state. */
const TOGGLE_TOTAL = poll(`(() => {
  const box = document.querySelector('.jobs-total input[type="checkbox"]');
  if (!box) return null;
  box.click();
  return box.checked ? "on" : "off";
})()`);

/** Clicks Next in the jobs pager, and fails the step if it was not offered. */
async function clickNext(view: Bun.WebView): Promise<boolean> {
  return view.evaluate<boolean>(button(PAGER, "Next", true));
}

/** The UI path of one queue's screen. */
function queuePath(host: Host, queue: string): string {
  return `${host.uiBase}/queues/${queue}`;
}

/* --- the browser: skip, not fail, if Chrome will not start -------- */

/** What the page printed to its console, for a failure's diagnosis. */
const pageConsole: string[] = [];
const view = await openView(chromePath, pageConsole, shutdown);

title("Paging the jobs table: jump by offset, walk by cursor");
show("Chrome", chromePath);
show(`host ${main.label}`, `${main.origin}${main.uiBase}`);
show("host file", `${filed.origin}${filed.uiBase}`);
show(
  "features.addedByState",
  `${main.label}: ${main.meta.features.addedByState}, file: ${filed.meta.features.addedByState}`,
);

try {
  /* ---------------------------------------------------------------- */
  step("A walk sees the rows an offset turn steps over");

  // Both queues hold the same 20 jobs in the same order, and both are read
  // oldest first with a total, so both grow the same four-page pager. The
  // only difference is which control turns the page.
  const shown = HEADLINE_PAGE;
  const query = `?state=waiting&order=asc&limit=${shown}&total=1`;

  await view.navigate(`${main.origin}${queuePath(main, OFFSET_QUEUE)}${query}`);
  const offsetFirst = jobIds("L", 0, shown);
  check(
    `the offset arm's first page is ${offsetFirst.join(", ")}`,
    (await view.evaluate<string[] | null>(rowsAre(offsetFirst))) !== null,
    pageConsole,
  );
  const offsetPager = await view.evaluate<PagerView | null>(
    pagerOf("Job pages"),
  );
  checkEqual(
    "with four pages to pick from and a range that counts",
    {
      range: offsetPager?.range,
      pages: offsetPager?.pageControl?.options,
      pageText: offsetPager?.pageText,
    },
    {
      range: "1–5 of 20",
      pages: ["1", "2", "3", "4"],
      pageText: null,
    },
  );
  checkEqual(
    "and the request counted rather than walked",
    lastRead(main, OFFSET_QUEUE).wire,
    expectedWire(main, {
      state: "waiting",
      limit: shown,
      order: "asc",
      total: true,
    }),
  );

  // From here until the turn has landed, the host holds the page's poll: a
  // refresh of page one would show the very rows the offset turn is about to
  // skip, and the point of the step would be gone.
  pollGate = Promise.withResolvers<void>();
  checkEqual(
    `drained: ${offsetFirst.join(", ")} left the queue`,
    await drain(main, OFFSET_QUEUE, offsetFirst),
    offsetFirst,
  );
  // The five that are now at the head of the list — the ones an offset page
  // two can no longer see, because the window has slid over them.
  const stepped = jobIds("L", shown, shown);
  const offsetSecond = jobIds("L", shown * 2, shown);
  check(
    "the Page control offers page 2",
    await view.evaluate<boolean>(choose(PAGER, "Page", "2")),
  );
  const offsetRows = await view.evaluate<string[] | null>(
    rowsAre(offsetSecond),
  );
  pollGate.resolve();
  pollGate = null;
  checkEqual(
    `the offset arm's page 2 is ${offsetSecond.join(", ")} — it stepped over ${stepped.join(", ")}`,
    offsetRows,
    offsetSecond,
  );
  check(
    "and said nothing about it: no repeated row",
    offsetRows !== null && offsetRows.every((id) => !offsetFirst.includes(id)),
    { offsetFirst, offsetRows },
  );
  check("no error either", await view.evaluate<boolean>(NO_ERROR));
  const offsetTurn = lastRead(main, OFFSET_QUEUE);
  checkEqual(
    "the turn counted to its page",
    offsetTurn.wire,
    expectedWire(main, {
      state: "waiting",
      limit: shown,
      order: "asc",
      offset: shown,
      total: true,
    }),
  );
  const offsetAnswer = await replay(main, offsetTurn);
  checkEqual(
    "and the answer holds no sign of the five it skipped",
    {
      status: offsetAnswer.status,
      hasMore: offsetAnswer.page.hasMore,
      ids: offsetAnswer.ids,
    },
    { status: 200, hasMore: true, ids: offsetSecond },
  );

  // The same queue, the same drain, the same moment — turned with Next.
  await view.navigate(`${main.origin}${queuePath(main, WALK_QUEUE)}${query}`);
  const walkFirst = jobIds("P", 0, shown);
  check(
    `the walking arm's first page is ${walkFirst.join(", ")}`,
    (await view.evaluate<string[] | null>(rowsAre(walkFirst))) !== null,
    pageConsole,
  );
  pollGate = Promise.withResolvers<void>();
  checkEqual(
    `drained: ${walkFirst.join(", ")} left the queue`,
    await drain(main, WALK_QUEUE, walkFirst),
    walkFirst,
  );
  const walked = jobIds("P", shown, shown);
  check("Next is offered", await clickNext(view));
  const walkRows = await view.evaluate<string[] | null>(rowsAre(walked));
  pollGate.resolve();
  pollGate = null;
  checkEqual(
    `the walking arm's next page is ${walked.join(", ")} — the five the offset arm lost`,
    walkRows,
    walked,
  );
  const walkTurn = lastRead(main, WALK_QUEUE);
  checkEqual(
    "because the turn sent the page's cursor, and no offset",
    walkTurn.wire,
    expectedWire(main, {
      state: "waiting",
      limit: shown,
      order: "asc",
      cursor: true,
      total: true,
    }),
  );

  /* ---------------------------------------------------------------- */
  step("Jump to a page, walk on from it, and a reload re-samples");

  // 24 jobs, newest first, five to a page, landing on the third page.
  const jumped = 10;
  const ledgerQuery = `?state=waiting&limit=${shown}&offset=${jumped}`;
  await view.navigate(`${main.origin}${queuePath(main, LEDGER)}${ledgerQuery}`);
  /** The ledger's ids in the order the screen lists them: newest first. */
  const ledger = jobIds("G", 0, LEDGER_JOBS).reverse();
  const jumpedTo = ledger.slice(jumped, jumped + shown);
  check(
    `the jumped-to page is ${jumpedTo.join(", ")}`,
    (await view.evaluate<string[] | null>(rowsAre(jumpedTo))) !== null,
    pageConsole,
  );
  const jumpRead = lastRead(main, LEDGER);
  checkEqual(
    "read by offset, as a jump must be",
    jumpRead.wire,
    expectedWire(main, { state: "waiting", limit: shown, offset: jumped }),
  );
  const jumpAnswer = await replay(main, jumpRead);
  check(
    "and it minted a cursor all the same, so the walk can start here",
    typeof jumpAnswer.page.next === "string",
    jumpAnswer.page,
  );
  show(
    "the cursor an offset page hands back, in bytes",
    String(jumpAnswer.page.next).length,
  );

  const walkedOn = ledger.slice(jumped + shown, jumped + shown * 2);
  check("Next is offered", await clickNext(view));
  checkEqual(
    `Next walks on to ${walkedOn.join(", ")}`,
    await view.evaluate<string[] | null>(rowsAre(walkedOn)),
    walkedOn,
  );
  checkEqual(
    "carrying a cursor and no offset at all",
    lastRead(main, LEDGER).wire,
    expectedWire(main, { state: "waiting", limit: shown, cursor: true }),
  );

  // An offset sent beside a cursor is not an error and not an override: it is
  // dropped, with nothing in the answer to say so. Named here so a later
  // "simplification" that starts honouring it fails.
  const cursorOnly = `/queues/${LEDGER}/jobs?state=waiting&limit=${shown}&order=desc&cursor=${encodeURIComponent(String(jumpAnswer.page.next))}`;
  const withCursor = await ask(main, cursorOnly);
  const withBoth = await ask(main, `${cursorOnly}&offset=17`);
  checkEqual(
    "a cursor sent with offset=17 answers exactly what the cursor alone does",
    { status: withBoth.status, ids: withBoth.ids },
    { status: withCursor.status, ids: withCursor.ids },
  );
  check(
    "and the 17 is nowhere in the answer",
    withBoth.page.offset !== 17,
    withBoth.page,
  );

  const walkedTwice = ledger.slice(jumped + shown * 2, jumped + shown * 3);
  check("Next again", await clickNext(view));
  checkEqual(
    `two pages walked: ${walkedTwice.join(", ")}`,
    await view.evaluate<string[] | null>(rowsAre(walkedTwice)),
    walkedTwice,
  );
  checkEqual(
    "and the URL still says where the walk started, never a cursor",
    await view.evaluate<[string, string][]>(QUERY),
    [
      ["limit", String(shown)],
      ["offset", String(jumped)],
      ["state", "waiting"],
    ],
  );

  // A reload cannot resume a walk it never carried, so it re-samples from the
  // offset — which loses nothing, since that is where every walk begins.
  await view.navigate(`${main.origin}${queuePath(main, LEDGER)}${ledgerQuery}`);
  checkEqual(
    "a reload lands back on the offset page it started from",
    await view.evaluate<string[] | null>(rowsAre(jumpedTo)),
    jumpedTo,
  );
  checkEqual(
    "read by offset again",
    lastRead(main, LEDGER).wire,
    expectedWire(main, { state: "waiting", limit: shown, offset: jumped }),
  );

  /* ---------------------------------------------------------------- */
  step("A resize keeps the walk's place");

  await view.navigate(
    `${main.origin}${queuePath(main, LEDGER)}?state=waiting&limit=${shown}`,
  );
  const firstPage = ledger.slice(0, shown);
  check(
    `the first page is ${firstPage.join(", ")}`,
    (await view.evaluate<string[] | null>(rowsAre(firstPage))) !== null,
    pageConsole,
  );
  const second = ledger.slice(shown, shown * 2);
  check("Next is offered", await clickNext(view));
  checkEqual(
    `walked to ${second.join(", ")}`,
    await view.evaluate<string[] | null>(rowsAre(second)),
    second,
  );
  // Twice the rows, from the same first row: the cursor that produced this
  // page is re-sent with the new size, rather than the offset snapping to a
  // multiple of it.
  const resized = ledger.slice(shown, shown + shown * 2);
  check(
    "Rows per page offers 10",
    await view.evaluate<boolean>(choose(PAGER, "Rows per page", "10")),
  );
  checkEqual(
    `the resized page still starts at ${second[0]}: ${resized.join(", ")}`,
    await view.evaluate<string[] | null>(rowsAre(resized)),
    resized,
  );
  checkEqual(
    "read with the same cursor and the new limit",
    lastRead(main, LEDGER).wire,
    expectedWire(main, { state: "waiting", limit: shown * 2, cursor: true }),
  );

  /* ---------------------------------------------------------------- */
  step("A filter, the order, the tab or Count total restarts the walk");

  /**
   * Walks one page of the ledger and answers the cursor-carrying read that
   * did it, so the restart can be compared against a walk that really
   * happened rather than against nothing at all.
   */
  const walkOnePage = async (): Promise<Read> => {
    await view.navigate(
      `${main.origin}${queuePath(main, LEDGER)}?state=waiting&limit=${shown}`,
    );
    await view.evaluate<string[] | null>(rowsAre(firstPage));
    await clickNext(view);
    await view.evaluate<string[] | null>(rowsAre(second));
    return lastRead(main, LEDGER);
  };

  /** The name filter's own page one, newest first: every `alpha` job. */
  const alphaFirst = ledger
    .filter((id) => Number(id.slice(2)) % 2 === 0)
    .slice(0, shown);
  const walkedBefore = await walkOnePage();
  check(
    "the names filter takes alpha",
    await view.evaluate<boolean>(typeInto(FILTERS, "Names", FILTERED_NAME)),
  );
  check("Apply", await view.evaluate<boolean>(button(FILTERS, "Apply", true)));
  checkEqual(
    `the filtered list starts again at ${alphaFirst.join(", ")}`,
    await view.evaluate<string[] | null>(rowsAre(alphaFirst)),
    alphaFirst,
  );
  checkEqual(
    "walked, then restarted: the cursor is gone from the wire, not re-sent",
    {
      before: walkedBefore.wire.cursor,
      after: lastRead(main, LEDGER).wire,
    },
    {
      before: OPAQUE,
      after: expectedWire(main, {
        state: "waiting",
        limit: shown,
        name: FILTERED_NAME,
      }),
    },
  );

  const oldestFirst = ledger.slice(-shown).reverse();
  const orderWalked = await walkOnePage();
  check(
    "the order can be turned round",
    await view.evaluate<boolean>(choose(FILTERS, "Order", "asc")),
  );
  checkEqual(
    `oldest first starts again at ${oldestFirst.join(", ")}`,
    await view.evaluate<string[] | null>(rowsAre(oldestFirst)),
    oldestFirst,
  );
  checkEqual(
    "and the order's own walk began with no cursor",
    { before: orderWalked.wire.cursor, after: lastRead(main, LEDGER).wire },
    {
      before: OPAQUE,
      after: expectedWire(main, {
        state: "waiting",
        limit: shown,
        order: "asc",
      }),
    },
  );

  const tabWalked = await walkOnePage();
  check("the All tab", await view.evaluate<boolean>(clickTab("All")));
  await view.evaluate<string[] | null>(jobRows("ids.length > 0"));
  const tabRead = lastRead(main, LEDGER);
  checkEqual(
    "a tab change starts again, with no state and no cursor",
    { before: tabWalked.wire.cursor, after: tabRead.wire },
    {
      before: OPAQUE,
      after: {
        limit: String(shown),
        order: "desc",
        ...(main.meta.features.addedByState ? { sort: "createdAt" } : {}),
      },
    },
  );

  const totalWalked = await walkOnePage();
  checkEqual(
    "Count total ticks on",
    await view.evaluate<string | null>(TOGGLE_TOTAL),
    "on",
  );
  checkEqual(
    `counting starts again at ${firstPage.join(", ")}`,
    await view.evaluate<string[] | null>(rowsAre(firstPage)),
    firstPage,
  );
  checkEqual(
    "with a total asked for and no cursor — counting changes the sort",
    { before: totalWalked.wire.cursor, after: lastRead(main, LEDGER).wire },
    {
      before: OPAQUE,
      after: expectedWire(main, {
        state: "waiting",
        limit: shown,
        total: true,
      }),
    },
  );
  check(
    "and none of that drew an error",
    await view.evaluate<boolean>(NO_ERROR),
  );

  // What the restart is protecting the reader from, sent by hand: the same
  // cursor answers its own walk and is refused by another, so the 400 cannot
  // be blamed on a cursor that was never any good.
  const ownWalk = await ask(
    main,
    `/queues/${LEDGER}/jobs?state=waiting&limit=${shown}&order=desc`,
  );
  const carried = encodeURIComponent(String(ownWalk.page.next));
  const sameWalk = await ask(
    main,
    `/queues/${LEDGER}/jobs?state=waiting&limit=${shown}&order=desc&cursor=${carried}`,
  );
  const otherWalk = await ask(
    main,
    `/queues/${LEDGER}/jobs?state=waiting&limit=${shown}&order=asc&cursor=${carried}`,
  );
  checkEqual("that cursor in its own walk is a page", sameWalk.status, 200);
  checkEqual(
    "the same cursor with the order turned round is a 400",
    { status: otherWalk.status, detail: otherWalk.detail },
    { status: 400, detail: "this cursor belongs to another walk" },
  );

  /* ---------------------------------------------------------------- */
  step("A full page can be the last page");

  await view.navigate(
    `${main.origin}${queuePath(main, OCTET)}?state=waiting&limit=${OCTET_PAGE}`,
  );
  const octet = jobIds("O", 0, OCTET_JOBS).reverse();
  check(
    `the first page is ${octet.slice(0, OCTET_PAGE).join(", ")}`,
    (await view.evaluate<string[] | null>(
      rowsAre(octet.slice(0, OCTET_PAGE)),
    )) !== null,
    pageConsole,
  );
  check("Next is offered", await clickNext(view));
  const lastFull = octet.slice(OCTET_PAGE);
  checkEqual(
    `the last page is full: ${lastFull.join(", ")}`,
    await view.evaluate<string[] | null>(rowsAre(lastFull)),
    lastFull,
  );
  const lastTurn = lastRead(main, OCTET);
  checkEqual(
    "walked to, not counted to",
    lastTurn.wire,
    expectedWire(main, { state: "waiting", limit: OCTET_PAGE, cursor: true }),
  );
  const lastAnswer = await replay(main, lastTurn);
  checkEqual(
    "and it holds a full page with no cursor after it: next is the only end signal",
    {
      rows: lastAnswer.ids.length,
      limit: lastAnswer.page.limit,
      hasMore: lastAnswer.page.hasMore,
      next: lastAnswer.page.next,
    },
    { rows: OCTET_PAGE, limit: OCTET_PAGE, hasMore: false, next: null },
  );
  const lastPager = await view.evaluate<PagerView | null>(pagerOf("Job pages"));
  checkEqual(
    "so Next is spent though the page came back full",
    { next: lastPager?.next, prev: lastPager?.prev },
    { next: false, prev: true },
  );

  /* ---------------------------------------------------------------- */
  step("Whether a walked page is numbered is a property of the answer");

  // The file driver reports the position of a walked page when its seek knew
  // it — one state, no filter — and none when it did not. Same driver, same
  // run, both answers, and the rendering asserted against the answer the page
  // actually got rather than against the driver's name.
  await view.navigate(
    `${filed.origin}${queuePath(filed, NUMBERS)}?state=waiting&limit=${NUMBERS_PAGE}`,
  );
  const numbers = jobIds("N", 0, NUMBERS_JOBS).reverse();
  check(
    `the file host's first page is ${numbers.slice(0, NUMBERS_PAGE).join(", ")}`,
    (await view.evaluate<string[] | null>(
      rowsAre(numbers.slice(0, NUMBERS_PAGE)),
    )) !== null,
    pageConsole,
  );
  const plainSecond = numbers.slice(NUMBERS_PAGE, NUMBERS_PAGE * 2);
  check("Next is offered", await clickNext(view));
  checkEqual(
    `walked to ${plainSecond.join(", ")}`,
    await view.evaluate<string[] | null>(rowsAre(plainSecond)),
    plainSecond,
  );
  const plainWalk = lastRead(filed, NUMBERS);
  const plainAnswer = await replay(filed, plainWalk);
  check(
    "the unfiltered walked page carries its position",
    numbered(plainAnswer),
    plainAnswer.page,
  );
  const plainPager = await view.evaluate<PagerView | null>(
    pagerOf("Job pages"),
  );
  checkEqual(
    "so the range numbers the rows, and the page is named",
    {
      range: plainPager?.range,
      pageText: plainPager?.pageText,
      pageControl: plainPager?.pageControl,
    },
    { range: "5–8", pageText: "Page 2", pageControl: null },
  );

  const alphaNumbers = numbers.filter((id) => Number(id.slice(2)) % 2 === 0);
  check(
    "the names filter takes alpha",
    await view.evaluate<boolean>(typeInto(FILTERS, "Names", FILTERED_NAME)),
  );
  check("Apply", await view.evaluate<boolean>(button(FILTERS, "Apply", true)));
  checkEqual(
    `the filtered list restarts at ${alphaNumbers.slice(0, NUMBERS_PAGE).join(", ")}`,
    await view.evaluate<string[] | null>(
      rowsAre(alphaNumbers.slice(0, NUMBERS_PAGE)),
    ),
    alphaNumbers.slice(0, NUMBERS_PAGE),
  );
  const filteredSecond = alphaNumbers.slice(NUMBERS_PAGE, NUMBERS_PAGE * 2);
  check("Next is offered", await clickNext(view));
  checkEqual(
    `walked to ${filteredSecond.join(", ")}`,
    await view.evaluate<string[] | null>(rowsAre(filteredSecond)),
    filteredSecond,
  );
  const filteredWalk = lastRead(filed, NUMBERS);
  const filteredAnswer = await replay(filed, filteredWalk);
  checkEqual(
    "the filtered walked page omits the key — it is absent, not null",
    {
      hasOffset: Object.hasOwn(filteredAnswer.page, "offset"),
      offset: filteredAnswer.page.offset,
      rows: filteredAnswer.ids.length,
    },
    { hasOffset: false, offset: undefined, rows: NUMBERS_PAGE },
  );
  const filteredPager = await view.evaluate<PagerView | null>(
    pagerOf("Job pages"),
  );
  checkEqual(
    "so the range counts the rows, and no page is named",
    {
      range: filteredPager?.range,
      pageText: filteredPager?.pageText,
      pageControl: filteredPager?.pageControl,
      prev: filteredPager?.prev,
      next: filteredPager?.next,
    },
    {
      range: "4 rows",
      pageText: null,
      pageControl: null,
      // Previous walks back through the trail; nothing here could move an
      // offset it does not know.
      prev: true,
      next: true,
    },
  );
  checkEqual(
    "one driver, one run, both answers — so the rule cannot be the driver's name",
    [numbered(plainAnswer), numbered(filteredAnswer)],
    [true, false],
  );

  // And the same assertion on the configured backend, whatever it answers:
  // the rendering follows the answer, never a table of drivers.
  const mainWalk = await replay(main, await walkOnePage());
  const mainPager = await view.evaluate<PagerView | null>(pagerOf("Job pages"));
  checkEqual(
    `on ${main.label} the walked page is ${numbered(mainWalk) ? "numbered" : "counted"}, and the pager says so`,
    {
      counts: mainPager?.range === `${shown} rows`,
      names: mainPager?.pageText !== null,
    },
    { counts: !numbered(mainWalk), names: numbered(mainWalk) },
  );

  /* ---------------------------------------------------------------- */
  step("The Active tab, and the one cursor the API refuses");

  for (const host of [main, filed]) {
    const walks = host.meta.features.addedByState;
    await view.navigate(
      `${host.origin}${queuePath(host, ACTIVE_QUEUE)}?state=active&limit=2`,
    );
    const first = await view.evaluate<string[] | null>(
      jobRows("ids.length === 2"),
    );
    check(
      `${host.label}: the Active tab lists 2 of the ${ACTIVE_JOBS} held jobs`,
      first?.length === 2,
      { first, pageConsole },
    );
    const landing = lastRead(host, ACTIVE_QUEUE);
    const landed = await replay(host, landing);
    checkEqual(
      `${host.label}: its answer ${walks ? "mints a cursor" : "mints none"}, because sort=createdAt is ${walks ? "served" : "refused"} here`,
      typeof landed.page.next === "string",
      walks,
    );
    // Waited for on the host's side, not by row identity: `active` is ordered
    // by the lock expiry, which the worker holding these jobs rewrites as it
    // renews, so which two rows a page shows is not a fact to assert.
    const before = reads(host, ACTIVE_QUEUE).length;
    check(`${host.label}: Next is offered either way`, await clickNext(view));
    await waitFor(
      `${host.label}: the Active tab's turn to reach the host`,
      () => reads(host, ACTIVE_QUEUE).length > before,
    );
    checkEqual(
      `${host.label}: and it still shows a page of 2`,
      (await view.evaluate<string[] | null>(jobRows("ids.length === 2")))
        ?.length,
      2,
    );
    checkEqual(
      `${host.label}: the turn ${walks ? "walked" : "counted"}, matching its own answer`,
      lastRead(host, ACTIVE_QUEUE).wire,
      walks
        ? expectedWire(host, { state: "active", limit: 2, cursor: true })
        : expectedWire(host, { state: "active", limit: 2, offset: 2 }),
    );
  }

  // The refusal itself: a cursor against the lock-expiry order. The UI never
  // sends this, because it never has a cursor to send there — but the message
  // is the one thing that says why the tab is different, so it is asserted.
  const activeBase = `/queues/${ACTIVE_QUEUE}/jobs?state=active&limit=2`;
  const activePlain = await ask(main, activeBase);
  const activeCursor = await ask(main, `${activeBase}&cursor=jl1.anything`);
  checkEqual(
    "state=active with no sort is a page, and mints nothing to walk with",
    { status: activePlain.status, next: activePlain.page.next },
    { status: 200, next: null },
  );
  checkEqual(
    "and a cursor there is a 400 that says whose fault the order is",
    {
      status: activeCursor.status,
      lock: activeCursor.detail.includes("lockExpiresAt"),
      renew: activeCursor.detail.includes("renews a lock"),
      advice: activeCursor.detail.includes(
        "Page `active` with `offset`, or walk it with `sort=createdAt`",
      ),
    },
    { status: 400, lock: true, renew: true, advice: true },
  );

  show("the page logged", pageConsole.length === 0 ? "nothing" : pageConsole);
} finally {
  await shutdown(view);
}

summary();

/*
 * A note for whoever reads this next, about the Active tab — the one part of
 * this file whose answer depends on the backend, and the easiest to state
 * wrongly in either direction.
 *
 * `jobWalkIsSeekable` refuses a cursor for `state=active` only while the sort
 * is that tab's natural order, the lock expiry, which every worker rewrites as
 * it renews a lock. `sort=createdAt` is immutable, so a walk in *that* order is
 * seekable — and the UI asks for it wherever `features.addedByState` is true
 * and Count total is off. So the tab walks on memory, SQL and MongoDB, and
 * keeps its offset pager where creation order is not served.
 *
 * Measured with 6 jobs held active and `limit=2`: on memory,
 * `state=active&limit=2&sort=createdAt` answers 200 with a string `page.next`
 * and the walked page returns the next two jobs; the same request without the
 * sort answers `next: null`, and with a cursor it is the 400 above. On the
 * file driver (`addedByState` false) every one of those answers `next: null`.
 *
 * So neither "Active always walks" nor "Active never walks" is true. The step
 * above does not simply follow whatever its host does, which would pass under
 * either behaviour and so assert nothing: it **predicts** from
 * `features.addedByState` and compares — `typeof page.next === "string"` must
 * equal the flag — so a host that stopped walking a creation-ordered Active
 * tab, or started walking a lock-expiry-ordered one, fails here. Nothing in
 * the app special-cases a tab: the table walks whenever its page carries a
 * cursor, and the flag is what decides whether one is minted.
 */
