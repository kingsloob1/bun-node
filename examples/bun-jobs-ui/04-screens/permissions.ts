/**
 * What each screen needs: the permissions model behind the queue and runner
 * screens, asserted on the API.
 *
 * ```bash
 * bun 04-screens/permissions.ts
 * ```
 *
 * The UI decides nothing about access. Before it draws a button it asks the
 * API, and the API asks your `authorize`:
 *
 * - `GET /meta/permissions` is asked once, when the app boots. It answers for
 *   the API as a whole, with no queue or runner, and decides which nav
 *   entries exist.
 * - `GET /meta/permissions?queue=<q>` is asked on every screen under
 *   `/queues/:queue`, and `GET /meta/permissions?runner=<id>` on
 *   `/runners/:runner`, so a host whose `authorize` decides per queue or per
 *   runner gets buttons that match. Until that answer arrives, or if it
 *   fails, the screen uses the untargeted map, except for the reads that
 *   wait for it (below).
 * - An action is on only when the map holds it **and** it is `true`. A route
 *   that is not registered (for example because of `readOnly`, `actions` or the
 *   driver's features) is absent from the map.
 * - **The server's 403 is authoritative.** A hidden button is only a courtesy.
 *   A client that sends the request anyway gets the same answer from
 *   `authorize`, and so does a request the map allowed but `authorize` refuses
 *   for one particular job.
 *
 * So everything the UI gates on can be checked here, deterministically,
 * without a browser. This example uses a host with three queues and four
 * runners:
 *
 * | Target               | This caller may                                       |
 * |----------------------|-------------------------------------------------------|
 * | queue `mail`         | everything, except touch a job whose id starts `vip-` |
 * | queue `audit`        | read, but change nothing                              |
 * | queue `payroll`      | nothing queue-scoped at all                           |
 * | runner `nightly`     | everything (registered here, in the API's process)    |
 * | runner `ledger`      | read, but change nothing (registered here)            |
 * | runner `vault`       | nothing runner-scoped at all (registered here)        |
 * | runner `remote-sync` | everything, but it is registered by another process   |
 *
 * `screenGates()` below restates the UI's own rules as one pure function of
 * what the screens read: `/meta`, the `sections` the UI was given, the
 * untargeted map, the queue's or runner's own map, the queue's detail, the
 * job and the runner. It is written as `GATES`, one entry per element of the
 * package README's table "What each element needs"
 * (`packages/bun-jobs-ui/README.md`), and the next step **parses that table
 * and compares it with `GATES`**, row for row and action for action, so the
 * two cannot drift apart unnoticed.
 *
 * Rules in it that are easy to miss:
 *
 * - **Pause and Resume depend on state.** A queue's paused flag comes from
 *   its detail, which the screen reads only with `queues.read`, so Pause shows
 *   on a running queue and Resume on a paused one, never both. A runner's
 *   comes from the runner itself (`isPaused`).
 * - **Fail… and Disable / Enable depend on state too.** Fail… is offered for a
 *   job in any state but `completed` and `dead`, the two the API refuses with
 *   409. A repeat series offers Disable while it is enabled and Enable while
 *   it is `disabled`, never both.
 * - **Bulk Retry, Promote and Remove sit in the jobs table**, so they need
 *   `jobs.list` as well as their own action.
 * - **The job and runner screens wait for their own map.** The job is not
 *   fetched until the queue's map has answered, and never without its
 *   `jobs.read` ("Job hidden"); the runner likewise with the runner's
 *   `runners.read` ("Runner hidden"). So a host that grants the read
 *   untargeted but refuses it for one queue or runner is never asked for
 *   that one's data. Only if the targeted map fails does the untargeted one
 *   decide.
 * - **Kill and Reset stats need the runner in the API's process.** Only the
 *   process running a run can kill it, so Kill needs a run in
 *   `local.activeRuns`, and Reset stats needs `isLocal`. For a remote runner
 *   the screen shows a hint instead, and the API answers 409
 *   `RUNNER_NOT_LOCAL`. Clear history… is the exception: it works on what
 *   the backend stores, so a remote runner gets it too.
 * - **Worker controls follow the map of the screen listing the worker.** The
 *   Workers page is outside any queue, so it reads the untargeted map (for
 *   this host, a "no" to every mutation: no buttons there), while a queue's
 *   Workers panel and a worker page (`/workers/:queue/:key`) read the queue's
 *   own answer. A lifecycle action also needs the worker live (it reports
 *   `control.enabled`, is not stale and not mid-transition) in a state that
 *   takes it, and the backend's `features.workerControl`.
 * - **The housekeeping note needs a worker that said no, not a worker that
 *   said nothing.** A queue's Workers panel warns that nobody runs its
 *   housekeeping sweeps only when a live worker reports `sweeps: false` and
 *   none reports `true`; a worker too old to report the field has said
 *   nothing, so a panel whose live workers all omit it shows no note at all.
 *   It needs no permission of its own beyond the panel's.
 * - **Six actions are opt-in** (`JOBS_API_OPT_IN_ACTIONS`): `jobs.add`,
 *   `jobs.update`, `queues.defaults`, `queues.applyDefaults`,
 *   `workers.configure` and `runners.configure` are not routed, and so absent
 *   from the map, unless the host lists them in `actions`. This host lists
 *   every action; a second host built with the default shows the difference.
 * - **Where the code needs more than the README says**, the gate records it
 *   under `unlisted`, and the table check names those rows, so a README fix
 *   shows up here as a change to review.
 * - **The Events console needs a socket and `events.connect`.** `/meta`'s
 *   `websocket` is `null` when the API was built with `websocket: false`, and
 *   `events.connect` is then absent from the map, not `false`. With a socket,
 *   the map answers `events.connect` from `authorize`, untargeted, like the
 *   nav entries. The console's queue and runner pickers list names only with
 *   the untargeted `queues.list` / `runners.list`; without them they are text
 *   boxes, which is why those rows are about the list, not the picker. Each
 *   exists only in the modes that have its channels: the queue list in
 *   `jobs` and `both`, the runner list in `runner` and `both`.
 * - **The API docs are the one exception to "absent, not disabled".** The nav
 *   entry and the two references come and go like any other screen, on
 *   `sections.docs`, `meta.docs` and the untargeted `docs.read` (not
 *   `sections.manage`: a docs-only UI has them). But a reference documents
 *   every operation the API serves, so on one operation's page the elements
 *   are there whatever the caller holds, and say so: the permission marker
 *   reads "You lack", a try-it the caller may not send is **disabled, with
 *   the reason**, and a WebSocket try-it without the Events console is a
 *   **note**. A channel's link is disabled, with the reason, until each
 *   parameter is filled and passes the document's `x-bun-jobs-schema` (the
 *   client's name rule for an older API). The connection channel (the one
 *   carrying the upgrade binding, or a socket-path address) has no try-it at
 *   all: there is nothing to subscribe to. So a gate here also says what shows when it is closed
 *   (`denied`), and the table check compares that as well. Those gates are
 *   decided per documented operation, always on the untargeted map
 *   (`map: "operation"`): an operation names no one queue or runner.
 */
import type {
  JobsApiAction,
  JobsApiAuthorize,
  JobState,
  MetaDto,
} from "@kingsleyweb/bun-jobs";
import type { UiSections } from "@kingsleyweb/bun-jobs-ui";
import type {
  AnalyticsSeriesDto,
  JobDefaultsDto,
  PermissionsDto,
  QueueDetailDto,
  RunnerInfoDto,
  RunnerListDto,
  RunnersAnalyticsDto,
  RunRecordDto,
  WorkerConfigOverrideDto,
  WorkerControlResultDto,
  WorkerDto,
  WorkerListDto,
  WorkersAnalyticsDto,
  WorkerState,
} from "@kingsleyweb/bun-jobs/api/contract";
import { join } from "node:path";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOB_STATES,
  JOBS_API_ACTIONS,
  JOBS_API_MUTATIONS,
  JOBS_API_OPT_IN_ACTIONS,
  MemoryDriver,
} from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
import {
  encodeJobId,
  MAX_NAME_LENGTH,
  NAME_PARAM_PATTERN,
} from "@kingsleyweb/bun-jobs/api/contract";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("What each screen needs: permissions, per queue and per runner");

/**
 * The body of `GET /meta/permissions`, from the browser-safe contract the UI
 * itself is built on: `actions` holds every action the API routes.
 */
type PermissionsBody = PermissionsDto;

/* ------------------------------------------------------------------ */
step("A host whose authorize decides per queue and per runner");

const jobs = new BunJobs({
  namespace: "examples-ui-permissions",
  driver: new MemoryDriver(),
  logger: noopLogger,
});

/** Every `authorize` call, for counting what `/meta/permissions` costs. */
const asked: {
  action: JobsApiAction;
  queue?: string;
  jobId?: string;
  runner?: string;
}[] = [];

/**
 * The host's decision. `ctx.queue` is set for every queue-side action,
 * including when `/meta/permissions?queue=` asks, `ctx.runner` for every
 * runner action (and `?runner=`), and `ctx.jobId` for a single-job route.
 * Both are **absent** for the untargeted map, so this function gives every
 * mutation there a "no": a mutation always names its queue or runner when it
 * is really sent, so only the targeted answer can say yes.
 */
const authorize: JobsApiAuthorize = (_req, ctx) => {
  asked.push({
    action: ctx.action,
    queue: ctx.queue,
    jobId: ctx.jobId,
    runner: ctx.runner,
  });

  if (ctx.queue === "payroll") {
    return { allow: false, reason: "payroll is restricted" };
  }
  if (ctx.runner === "vault") {
    return { allow: false, reason: "vault is restricted" };
  }
  if (!ctx.mutation) {
    return true;
  }
  if (ctx.runner === "nightly" || ctx.runner === "remote-sync") {
    return true;
  }
  if (ctx.queue === "mail") {
    // Decided per job: the map cannot know about this rule, because it is
    // not asked about any particular job.
    return ctx.jobId?.startsWith("vip-")
      ? { allow: false, reason: "vip jobs are managed by the on-call team" }
      : true;
  }
  return {
    allow: false,
    reason: `read-only on ${ctx.queue ?? ctx.runner ?? "this API"}`,
  };
};

/** The runners' handler: a run stays in flight until it is killed. */
const HOLD = new URL("../shared/handlers/hold.ts", import.meta.url);

// Three runners registered here, in the API's process, so the API reports
// them with `isLocal: true` and a `local` block. None is scheduled to fire
// while this runs.
for (const id of ["nightly", "ledger", "vault"]) {
  await jobs
    .runner({
      id,
      file: HOLD,
      executionMode: "in-process",
      schedule: { cron: "0 3 * * *" },
      waitToExit: false,
    })
    .start();
}

// A fourth, registered by *another* `BunJobs` over the same driver and
// namespace: another process, as far as the API can tell. The API finds it
// through the driver, so it lists it with `isLocal: false` and no `local`.
const elsewhere = new BunJobs({
  namespace: "examples-ui-permissions",
  driver: jobs.driver,
  logger: noopLogger,
});
await elsewhere
  .runner({
    id: "remote-sync",
    file: HOLD,
    executionMode: "in-process",
    schedule: { every: 3_600_000 },
    waitToExit: false,
  })
  .start();

const api = createJobsApi({
  jobs,
  basePath: "/jobs-api",
  // Queues and runners.
  mode: "both",
  // So Trigger…'s Arguments field is offered.
  runnerTriggerArgs: true,
  // Every action, including the opt-ins `jobs.add` and `jobs.update`.
  actions: [...JOBS_API_ACTIONS],
  // `Add job` is shown only when some name may be added (`null` = any).
  addableNames: ["send-email"],
  authorize,
  // Read queue state fresh, so the paused flag flips at once below.
  limits: { queueCacheMs: 0 },
  logger: noopLogger,
});
const ui = jobsUi({ api, logger: noopLogger });

const app = new BunHttpAdapter();
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);

// Something in each queue: a dead job (for Retry), a delayed one (for
// Promote) and a waiting one. A worker makes the dead ones die for real.
for (const queue of ["mail", "audit", "payroll"]) {
  await jobs.queue(queue).add("boom", {}, { jobId: "dead-1", attempts: 1 });
  await jobs
    .queue(queue)
    .add("send-email", {}, { jobId: "later-1", delay: 3_600_000 });
}
await jobs
  .queue("mail")
  .add("send-email", {}, { jobId: "vip-1", delay: 3_600_000 });
for (const queue of ["mail", "audit", "payroll"]) {
  const worker = jobs.worker(queue, async () => {
    throw new Error("SMTP refused");
  });
  void worker.run();
  await waitFor(
    `the job in ${queue} to die`,
    async () => (await jobs.queue(queue).count()).dead === 1,
  );
  await worker.close({ timeout: 1_000 });
}
await jobs.queue("audit").add("send-email", {}, { jobId: "waiting-1" });

/** A JSON GET through the real pipeline. */
async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await app.fetch(`${api.basePath}${path}`);
  return { status: response.status, body: (await response.json()) as T };
}

/** A mutation, sent the way the app sends one: JSON, from the same origin. */
async function send<T extends object = object>(
  method: string,
  path: string,
  body: unknown = {},
): Promise<{
  status: number;
  body: Partial<T> & { code?: string; detail?: string };
}> {
  const response = await app.fetch(`${api.basePath}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "DELETE" ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text
      ? (JSON.parse(text) as Partial<T> & { code?: string; detail?: string })
      : {},
  };
}

const { body: meta } = await get<MetaDto>("/meta");
show("meta.readOnly / addableNames / features", {
  readOnly: meta.readOnly,
  addableNames: meta.addableNames,
  features: meta.features,
  maxBulkIds: meta.limits.maxBulkIds,
  maxClean: meta.limits.maxClean,
  defaultClean: meta.limits.defaultClean,
  maxRetryAllIds: meta.limits.maxRetryAllIds,
});

/* ------------------------------------------------------------------ */
step("The UI's rules, one entry per row of the package README's table");

/** Whether `permissions` holds `action` and it is `true` (absent is no). */
function can(permissions: PermissionsBody, action: JobsApiAction): boolean {
  return permissions.actions[action] === true;
}

/** The states the job screen calls finished: Retry is offered in these. */
const FINISHED: ReadonlySet<JobState> = new Set([
  "completed",
  "failed",
  "dead",
]);

/** The states a job is past failing in: the API answers 409 for these. */
const UNFAILABLE: ReadonlySet<JobState> = new Set(["completed", "dead"]);

/** A `/meta` feature flag. */
type Feature = keyof MetaDto["features"];

/**
 * A targeted map as a screen holds it: the answer, or `"pending"` while it
 * loads. A request that failed is passed as the untargeted map, which is
 * what the app falls back to then.
 */
type TargetedMap = PermissionsBody | "pending";

/** The Overview's analytics sections: the Jobs card, Runners and Workers. */
type AnalyticsSection = "jobs" | "runners" | "workers";

/** How one Overview section's analytics read answered. */
interface SectionRead {
  /** The response's `range.clamped`: not exactly the range asked for. */
  clamped?: boolean;
  /** The read answered 400 `RANGE_NOT_RETAINED`: the whole range is older than the API keeps. */
  notRetained?: boolean;
  /** The roll-up's `truncated` (Runners and Workers only): more rows exist than it returned. */
  truncated?: boolean;
}

/**
 * Every paged list table, and the rows one page of it holds — the figure its
 * README row states, which the check below compares with this.
 *
 * Six of them cut their pages **in the browser**, at a constant of the app's
 * (the size the screen hands `useClientPage`). Each reads its whole list in one
 * request and pages what came back, so turning a page fetches nothing and a
 * pager needs no permission of its own beyond its table's. A pager is on screen
 * only where the rows outnumber one page (`useClientPage`'s `paged`): a table
 * that fits on one page must not grow prev/next, a page select and a size
 * select that change nothing.
 *
 * Two of the figures are **defaults** rather than rules, because those two
 * tables take their size from the URL — `/runners`' `limit`, and the runner
 * history's `history`. {@link pageSizeOf} is the size in force;
 * {@link historyPageSize} is how the history works its out.
 */
const PAGE_SIZES = {
  /** The Overview's Queues card (`QUEUE_PAGE_SIZE`). */
  "overview queues": 20,
  /** A queue's Repeatables panel (`REPEATABLE_PAGE_SIZE`). */
  repeatables: 20,
  /** `/runners`, whose window is in the URL: `RUNNER_PAGE_SIZE`, the default. */
  runners: 25,
  /**
   * A runner's History card — the **default** page size, not a constant it
   * pages at: `defaultHistoryLimit(limits.maxHistory)`, `min(50, maxHistory)`,
   * which is 50 on any API whose cap is 50 or more (this one's is 200, checked
   * below). The size in force is the `history` URL parameter.
   */
  "runner history": 50,
  /** One server's section on the Workers page (`SERVER_PAGE_SIZE`). */
  "workers page server": 25,
  /** A queue's Workers panel (`WORKER_PAGE_SIZE`). */
  "queue workers panel": 25,
  /** A worker page's Instances card (`INSTANCE_PAGE_SIZE`). */
  "worker instances": 10,
} as const satisfies Record<string, number>;

/**
 * The one paged table that pages **on the server**: a runner's History card.
 * `GET /runners/:runner/history` takes the window (`offset`, `limit`) and
 * reports `page.total`, so the table pages the runner's **whole** stored history
 * one server read at a time, and the "Runs shown" select is that `limit` — the
 * `history` URL parameter, defaulting to `min(50, limits.maxHistory)`.
 */
const HISTORY_TABLE = "runner history";

/** One list table with a pager. */
type PagedTable = keyof typeof PAGE_SIZES;

/** Everything a screen decides from. */
interface ScreenInputs {
  /** `GET /meta`. */
  meta: MetaDto;
  /** The `sections` the UI was configured with (`ui.config.sections`). */
  sections: UiSections;
  /** The untargeted `GET /meta/permissions`: the nav, `/`, `/queues*`, `/runners*`. */
  boot: PermissionsBody;
  /**
   * `GET /meta/permissions?queue=<q>`: every element inside that queue's
   * screens. Absent off a queue screen, which closes every queue gate.
   */
  queue?: TargetedMap;
  /**
   * `GET /queues/<q>`, which the queue screen requests only with
   * `queues.read`; `undefined` without it. Pause, Resume and the limits panel
   * read it.
   */
  detail?: QueueDetailDto;
  /**
   * The job on the job screen, or one row of the jobs table: its state picks
   * Retry, Promote and Fail…, its `processedBy` the worker link.
   */
  job?: {
    /** The job's state. */
    state: JobState;
    /** `JobDto.processedBy`: the worker that ran the last attempt, `null` for none. */
    processedBy?: { key?: string } | null;
  };
  /**
   * Whether the jobs table counts its total (`?total=1`): such a page keeps
   * each tab's natural order, so no `sort` is sent.
   */
  countTotal?: boolean;
  /**
   * `GET /queues/<q>/job-defaults`, which the Job defaults panel reads:
   * whether an override is stored, and how many jobs are pending.
   */
  jobDefaults?: Pick<JobDefaultsDto, "overridden" | "pending">;
  /**
   * How each Overview section's analytics read answered: `jobs` for the Jobs
   * card, `runners` and `workers` for their sections. Absent before a read.
   */
  reads?: Partial<Record<AnalyticsSection, SectionRead>>;
  /**
   * One row of the repeatables panel (`GET /queues/<q>/repeatables`), whose
   * `disabled` picks Disable or Enable. Absent off such a row.
   */
  repeatable?: { disabled: boolean };
  /**
   * `GET /meta/permissions?runner=<id>`: every element of that runner's
   * screen. Absent off a runner screen, which closes every runner gate.
   */
  runnerMap?: TargetedMap;
  /**
   * `GET /runners/<id>`, which the screen requests only once the runner's
   * map has answered with `runners.read`; `undefined` otherwise. Its
   * `isLocal`, `local` and `isPaused` pick the actions.
   */
  runner?: RunnerInfoDto;
  /** One run of the runner's history, as `GET /runners/<id>/history` lists it. */
  run?: Pick<RunRecordDto, "status" | "logLines" | "logsDropped">;
  /**
   * The map a worker table decides its controls on: the untargeted one on
   * `/workers`, the queue's own answer on its Workers panel and on a worker
   * page. Absent off a worker table, which closes every `map: "worker"` gate.
   */
  workerMap?: PermissionsBody;
  /** One row of a worker table. */
  worker?: WorkerDto;
  /** Every worker in the table on screen: the columns depend on them all. */
  workerTable?: readonly WorkerDto[];
  /**
   * Whether the worker table on screen **asks** for the Memory column
   * (`WorkerTable`'s `showMemory`): the Workers page and a worker page's
   * Instances table do, a queue's Workers panel — a narrow control surface —
   * does not. Asking is not enough: the column still needs a worker reporting
   * `rssBytes`. Defaults to `false`, as the prop does.
   */
  workerTableMemory?: boolean;
  /**
   * Whether the worker table on screen is a **queue's** Workers panel: the one
   * table whose workers are all of one queue, and so the only one that can say
   * anything about that queue's housekeeping. The Workers page spans queues
   * and a worker page's Instances table is one key's, so neither carries the
   * note. Defaults to `false`.
   */
  workerTableQueuePanel?: boolean;
  /** The unfiltered `GET /workers`, which the Workers page's filters offer from. */
  workerList?: readonly WorkerDto[];
  /** The answer to the last worker instruction sent (`?wait=2000`). */
  controlResult?: Pick<WorkerControlResultDto, "applied">;
  /**
   * A worker page's one read, `GET /workers?queue=&key=&includeOffline=true`:
   * the key's live instances, and the override stored for it (`null` when
   * the listing's `offline` says none; `undefined` when it sent no
   * `offline`). Absent off a worker page.
   */
  workerPage?: {
    /** The stable key the page is for (`:key`). */
    key: string;
    /** The key's live instances. */
    instances: readonly WorkerDto[];
    /** The stored override, `null` for none, `undefined` when not reported. */
    stored?: WorkerConfigOverrideDto | null;
  };
  /**
   * How many rows each paged list table has to page: what decides whether it
   * shows a pager at all. A table named here with no count, or not named at
   * all, has nothing to page and so no pager. Defaults to `{}`.
   *
   * For the six of {@link PAGE_SIZES} that is the rows the table was handed
   * before it cut a page from them, counted after any browser-side filter,
   * since the filtered rows are what it pages. For {@link HISTORY_TABLE} it is
   * the runner's **whole stored history** (`page.total`), not the rows on
   * screen: that table re-reads the server for each page, so what is on screen
   * is one page of this count and can even be none of it, past the end.
   */
  tableRows?: Partial<Record<PagedTable, number>>;
  /**
   * The runner history's window, as the URL asks for it. Absent off a runner
   * screen, and `{}` for a screen opened without any of these.
   */
  historyPage?: {
    /**
     * The `history` parameter verbatim, which is the page size. Absent, or not
     * a run of digits, means `min(50, limits.maxHistory)`; a number outside
     * `1…limits.maxHistory` is clamped to it.
     */
    param?: string;
    /**
     * The `offset` parameter: runs skipped before the page. Defaults to `0`,
     * and is deliberately uncapped — `keepHistory` may hold far more runs than
     * `limits.maxHistory`, and this is what reaches them.
     */
    offset?: number;
    /** The `logs` parameter: the run whose log the URL opens. Absent for none. */
    openRun?: string;
    /**
     * Where that run sits in the stored history, counting from the newest at
     * `0`; `-1` for one the history no longer holds. What decides whether it
     * is among the rows the window reads.
     */
    openRunAt?: number;
  };
  /**
   * The operation or channel on screen in the API docs, as its document
   * describes it. Absent off a docs item page, which closes every
   * `map: "operation"` gate.
   */
  item?: DocItem;
}

/**
 * One documented operation (OpenAPI) or channel (AsyncAPI), in the terms the
 * docs screens gate on: the fields come from the document's own extensions.
 */
interface DocItem {
  /** `http` for an OpenAPI operation, `ws` for an AsyncAPI channel or operation. */
  kind: "http" | "ws";
  /** The HTTP method, upper-case. Absent for `ws`. */
  method?: string;
  /** Its `x-bun-jobs-action`, the permission it needs. Absent for a channel naming none. */
  action?: string;
  /** Its `x-bun-jobs-mutation`. Absent (read) for `ws`. */
  mutation?: boolean;
  /**
   * A WebSocket channel's address as try-it filled it, or `null` while a
   * parameter is empty or refused by its `x-bun-jobs-schema` (the client's
   * name rule for an API older than the extension). Absent for anything that
   * is not a channel: an HTTP operation, or a WebSocket operation or message.
   */
  address?: string | null;
  /**
   * The channel is the connection: it carries the WebSocket binding's upgrade
   * `method`, or its address is a socket path (`/...`). There is nothing to
   * subscribe to, so its page has no try-it at all, not even a disabled one.
   * Absent (false) for every other item.
   */
  connection?: boolean;
}

/**
 * Which permission map decides a gate. `operation` is the untargeted map
 * too, but the gate exists only on one documented operation's page.
 * `worker` is whichever map the worker table on screen decides on
 * (`ScreenInputs.workerMap`).
 */
type GateMap = "boot" | "queue" | "runner" | "operation" | "worker";

/**
 * What shows when a gate is closed but the screen it sits on is open:
 * nothing (`absent`, the rule everywhere but the docs), the element
 * `disabled` with its reason, a `note` in its place, or a permission marker
 * reading "You lack".
 */
type Denied = "absent" | "disabled" | "note" | "lack";

/** The `/meta` fields a README row may name as `` `meta.<field>` ``. */
type MetaField =
  | keyof MetaDto
  | "docs.openapi"
  | "docs.asyncapi"
  | "analytics.recording.runners"
  | "analytics.recording.workers";

/** Methods the app's client sends (the HTTP try-it's `CLIENT_METHODS`). */
const CLIENT_METHODS = ["DELETE", "GET", "PATCH", "POST", "PUT"] as const;

/**
 * Every routed action name: to pick actions out of the README's prose, and
 * to tell an action the UI knows from one it does not.
 */
const ACTION_NAMES: ReadonlySet<string> = new Set(JOBS_API_ACTIONS);

/** Action verbs whose try-it needs the operationId typed. */
const DESTRUCTIVE_VERBS = ["clean", "drain", "fail", "kill", "remove"] as const;

/**
 * One element's rule, stated the way the README's table states it, so the
 * table can be checked against it mechanically.
 */
interface Gate {
  /** The name this example prints for the element. */
  readonly name: string;
  /** The README table's "Element" cell it is (part of), verbatim. */
  readonly row: string;
  /**
   * Which map decides: `boot` (the untargeted one) outside a queue or runner,
   * `queue` or `runner` (`?queue=`/`?runner=`) inside one.
   */
  readonly map: GateMap;
  /**
   * The element is not shown, nor its data fetched, until the targeted map
   * has answered: the untargeted map does not stand in while it loads.
   */
  readonly waits?: boolean;
  /** Actions that must all be granted. */
  readonly reads?: readonly JobsApiAction[];
  /** Actions of which at least one must be granted. */
  readonly anyOf?: readonly JobsApiAction[];
  /** Mutations that must all be granted, and are off when `meta.readOnly`. */
  readonly mutations?: readonly JobsApiAction[];
  /** Mutations of which at least one must be granted; off when `meta.readOnly`. */
  readonly anyMutation?: readonly JobsApiAction[];
  /** `/meta` features that must all be on. */
  readonly features?: readonly Feature[];
  /** UI sections that must all be on. */
  readonly sections?: readonly (keyof UiSections)[];
  /** The `meta.mode` values the element exists in. */
  readonly modes?: readonly MetaDto["mode"][];
  /** The gate this one adds to ("the above" in the README). */
  readonly extends?: string;
  /**
   * The gate of the screen the element sits on: closed whenever that one is.
   * Unlike `extends`, the README row does not restate it.
   */
  readonly on?: string;
  /**
   * Gates whose needs this one has, each decided on its own map: the README
   * row says so ("the Workers nav entry's needs"), and the table check
   * compares the rows named.
   */
  readonly needsOf?: readonly string[];
  /**
   * A gate whose needs this one restates on its own map ("the Overview
   * Workers section's needs", on a worker page's queue map). Not evaluated:
   * the gate lists them itself, and a check holds the two lists equal.
   */
  readonly sameAs?: string;
  /**
   * What the app's code needs that the README row does not say. `features`
   * are evaluated like `features`; anything else lives in `when`. Left out
   * of the table comparison, and listed by the step that makes it.
   */
  readonly unlisted?: {
    /** `/meta` features the code also requires. */
    readonly features?: readonly Feature[];
    /** What the README leaves out, in a sentence, with the code it comes from. */
    readonly why: string;
  };
  /**
   * The `/meta` fields other than `mode` that the README row names as
   * `` `meta.<field>` ``. `when` decides on them; listing them here lets the
   * table check notice a row that gains or loses one.
   */
  readonly metaFields?: readonly MetaField[];
  /**
   * The gate is a list table's pager, over this table of {@link PAGE_SIZES}.
   * Its `when` is that table outgrowing one page; naming the table here also
   * lets the check below compare the rows-per-page figure the README row
   * states with the size the screen really pages at.
   */
  readonly pagedTable?: PagedTable;
  /** Whatever else it needs that no permission expresses. */
  readonly when?: (inputs: ScreenInputs) => boolean;
  /**
   * What shows when the gate is closed and its screen (`on`) is open.
   * Defaults to `absent`.
   */
  readonly denied?: Denied;
  /** UI sections the README row says are **not** needed ("`sections.x` is not needed"). */
  readonly notNeeded?: readonly (keyof UiSections)[];
  /** Which documented item it is about: an HTTP operation or a WebSocket one. */
  readonly itemKind?: DocItem["kind"];
  /** The item's `x-bun-jobs-action` must be granted, on the untargeted map. */
  readonly itemAction?: boolean;
  /** Closed for a mutation (`x-bun-jobs-mutation`) when `meta.readOnly`. */
  readonly itemMutation?: boolean;
  /** Open only for a mutation (`x-bun-jobs-mutation`): the confirmation. */
  readonly forMutation?: boolean;
  /** The item's method must be one of these. */
  readonly methods?: readonly string[];
  /**
   * Open for an item whose method is one of `methods`, or whose action's verb
   * (`queues.drain` → `drain`) is one of `verbs`: the typed confirmation.
   */
  readonly typed?: {
    /** Methods that always need it. */
    readonly methods: readonly string[];
    /** Action verbs that need it. */
    readonly verbs: readonly string[];
  };
  /** The item is a channel `meta.mode` offers (the row names `meta.mode`, not its values). */
  readonly inMode?: boolean;
  /**
   * The element exists only on a WebSocket channel's page (a channel's
   * try-it), and not on the connection channel's: on any other item it is
   * absent, whatever `denied` says.
   */
  readonly channelOnly?: boolean;
  /**
   * Every parameter of the channel filled and passing its
   * `x-bun-jobs-schema` (the client's name rule without one): the item's
   * `address` is a string, not `null`.
   */
  readonly itemSchema?: boolean;
  /**
   * With `itemAction`: an action outside the contract's list shows its own
   * marker, "Not an action this UI knows", instead of "You lack".
   */
  readonly unknownAction?: boolean;
}

/**
 * The runner history's page size: the `history` parameter, clamped to
 * `1…limits.maxHistory`, and `defaultHistoryLimit(maxHistory)` —
 * `max(1, min(50, maxHistory))` — when the URL names none. `intParam` takes a
 * run of digits and nothing else, so anything else is the default too.
 *
 * This is the one paged table with no constant to compare against: the size is
 * the reader's, and `limits.maxHistory` is the only figure the app fixes.
 */
function historyPageSize({ meta, historyPage }: ScreenInputs): number {
  const max = Math.max(1, meta.limits.maxHistory);
  const raw = historyPage?.param;
  const asked =
    raw !== undefined && /^\d+$/.test(raw)
      ? Number(raw)
      : Math.max(1, Math.min(50, max));
  return Math.min(Math.max(1, asked), max);
}

/**
 * The size `table` pages at under `inputs` — which for six of them is the
 * constant in {@link PAGE_SIZES}, and for the runner history the size the URL
 * asks for. With no `history` parameter the two agree, which the step below
 * asserts: that is what makes the README's figure for that row a true default
 * rather than a number nobody compared to anything.
 */
function pageSizeOf(table: PagedTable, inputs: ScreenInputs): number {
  return table === HISTORY_TABLE ? historyPageSize(inputs) : PAGE_SIZES[table];
}

/**
 * Whether `table` has more rows to page than one page holds, so its pager is
 * on screen. Exactly one page's worth is not enough: there would be nothing to
 * turn to.
 *
 * For the six browser-paged tables that is `useClientPage`'s `paged` — the rows
 * it was handed against its constant. For the runner history it is
 * `historyPage.ts`'s `paged`, `page.total > limit`: the runner's whole stored
 * history against the page size, not the rows on screen. The difference shows
 * past the end of the history, where the page is empty and the pager is still
 * there to go back with.
 */
function pagerShown(table: PagedTable, inputs: ScreenInputs): boolean {
  return (inputs.tableRows?.[table] ?? 0) > pageSizeOf(table, inputs);
}

/** The runner history's window, as the screen reads it from the URL. */
function historyWindow(inputs: ScreenInputs): {
  /** Runs skipped before the page. */
  offset: number;
  /** Runs per page. */
  limit: number;
  /** Every run the runner has stored, the route's `page.total`. */
  total: number;
  /** How many rows this window actually reads. */
  rows: number;
} {
  const limit = historyPageSize(inputs);
  const offset = inputs.historyPage?.offset ?? 0;
  const total = inputs.tableRows?.[HISTORY_TABLE] ?? 0;
  return {
    offset,
    limit,
    total,
    rows: Math.max(0, Math.min(total - offset, limit)),
  };
}

/**
 * Whether the History card shows `history-open-log-note`: the URL opens a run's
 * log (`logs=`) and that run is not among the rows this window read, so its
 * page cannot be worked out and the card says so instead of opening nothing.
 *
 * Silent while the page is empty or the caller cannot read run logs at all —
 * then nothing is open to be missing.
 */
function historyOpenLogNote(inputs: ScreenInputs): boolean {
  const { openRun, openRunAt } = inputs.historyPage ?? {};
  if (openRun === undefined) {
    return false;
  }
  // `openRunId` is `null` for a caller without the Log column, so no note.
  if (!screenGates(inputs)["runner: run log and Log column"]) {
    return false;
  }
  const { offset, limit, rows } = historyWindow(inputs);
  if (rows === 0) {
    return false;
  }
  const at = openRunAt ?? -1;
  return !(at >= offset && at < offset + limit);
}

/**
 * Whether Clear history… is disabled ("No runs to clear."), once the history
 * has been read — which is what a count in {@link ScreenInputs.tableRows}
 * stands for. It reads the **total**, not the rows on screen, so a window past
 * the end of the history leaves it live: there are runs to clear, behind us.
 */
function historyClearDisabled(inputs: ScreenInputs): boolean {
  return historyWindow(inputs).total === 0;
}

/** Whether the runner on screen has a run in flight in the API's process. */
function hasLocalRuns(runner: RunnerInfoDto | undefined): boolean {
  return runner?.isLocal === true && (runner.local?.activeRuns.length ?? 0) > 0;
}

/**
 * Whether a run offers its Log button: it reports lines, is still running
 * (a live run's record has no `logLines` until it settles), or reports no
 * `logLines` at all. Only a finished run that logged `0` lines offers none.
 */
function runHasLog(run: ScreenInputs["run"]): boolean {
  return (
    run !== undefined &&
    (run.logLines === undefined || run.logLines > 0 || run.status === "running")
  );
}

/** A worker's state; an older worker reports only `paused`. */
function workerStateOf(worker: WorkerDto): WorkerState {
  return worker.state ?? (worker.paused ? "paused" : "running");
}

/**
 * Whether a worker can take a lifecycle instruction at all: it listens
 * (`control.enabled`), still reports (not `stale`, not expired) and is not
 * between states (`stopping`, `restarting`).
 */
function workerLive(worker: WorkerDto): boolean {
  const state = workerStateOf(worker);
  return (
    worker.control?.enabled === true &&
    !(worker.stale ?? worker.expiresAt <= Date.now()) &&
    state !== "stopping" &&
    state !== "restarting"
  );
}

/** The worker actions a row offers, and the states each takes. */
const WORKER_LIFECYCLE = {
  "workers.pause": ["running"],
  "workers.resume": ["paused"],
  "workers.stop": ["running", "paused"],
  "workers.start": ["stopped"],
} as const satisfies Partial<Record<JobsApiAction, readonly WorkerState[]>>;

/** Whether `worker` is live and in a state `action` takes. */
function workerTakes(
  worker: WorkerDto | undefined,
  action: keyof typeof WORKER_LIFECYCLE,
): boolean {
  return (
    worker !== undefined &&
    workerLive(worker) &&
    (WORKER_LIFECYCLE[action] as readonly WorkerState[]).includes(
      workerStateOf(worker),
    )
  );
}

/**
 * Whether Settings… is offered on `worker`: it listens (`control.enabled`)
 * and reports the stable `key` an override is stored against. Stale or
 * mid-transition does not matter: the override waits for the next replica.
 */
function workerConfigurable(worker: WorkerDto | undefined): boolean {
  return worker?.control?.enabled === true && worker.key !== undefined;
}

/**
 * Whether a row offers any worker action, on `permissions`: what decides the
 * table's Actions column. The same rules as the five worker gates.
 */
function workerOffersAny(
  worker: WorkerDto,
  permissions: PermissionsBody,
  meta: MetaDto,
): boolean {
  const mutable = (action: JobsApiAction) =>
    meta.features.workerControl && !meta.readOnly && can(permissions, action);
  return (
    (Object.keys(WORKER_LIFECYCLE) as (keyof typeof WORKER_LIFECYCLE)[]).some(
      (action) => mutable(action) && workerTakes(worker, action),
    ) ||
    (mutable("workers.configure") && workerConfigurable(worker))
  );
}

/**
 * Every element of the queue, job and runner screens, in the README table's
 * order. A row that names several elements (Pause / Resume, the bulk
 * buttons) has one entry per element, sharing its `row`.
 */
const GATES = [
  {
    name: "Overview: nav and /",
    row: "Overview nav entry and `/`",
    map: "boot",
    sections: ["manage"],
    modes: ["jobs", "both"],
    anyOf: ["metrics.read", "queues.list"],
  },
  {
    name: "Overview: counts",
    row: "Overview counts",
    map: "boot",
    reads: ["metrics.read"],
  },
  {
    name: "Overview: queue table",
    row: "Overview queue table",
    map: "boot",
    reads: ["queues.list"],
  },
  {
    // The card reads every queue the API summarises in one request and cuts
    // its pages from that, so turning a page reads nothing: what the pager may
    // show is exactly what the table may, and a table fitting one page grows
    // no pager at all.
    name: "Overview: queue table pager",
    row: "Overview queue table pager",
    map: "boot",
    needsOf: ["Overview: queue table"],
    pagedTable: "overview queues",
    when: (inputs) => pagerShown("overview queues", inputs),
  },
  {
    name: "Overview: sparklines",
    row: "Overview sparklines",
    map: "boot",
    // A column of the queue table.
    on: "Overview: queue table",
    reads: ["metrics.read"],
    features: ["throughput"],
    // Every analytics route is pruned when the backend records nothing.
    metaFields: ["analytics"],
    when: ({ meta }) => meta.analytics !== null,
  },
  {
    // The Jobs card's band: the analytics series' own total.
    name: "overview: Over the range figure",
    row: 'Overview "Over the range" figure',
    map: "boot",
    reads: ["metrics.read"],
    metaFields: ["analytics"],
    when: ({ meta }) => meta.analytics !== null,
  },
  {
    name: "overview: Over the range, added by state",
    row: 'Overview "Over the range" added-by-state group ("Added in range, where they are now (still stored)")',
    map: "boot",
    reads: ["metrics.read"],
    features: ["addedByState"],
  },
  {
    // useAnalyticsGate("runners").
    name: "overview: Runners section",
    row: "Overview Runners section",
    map: "boot",
    reads: ["metrics.read"],
    features: ["runnerMetrics"],
    metaFields: ["analytics", "analytics.recording.runners"],
    when: ({ meta }) => meta.analytics?.recording.runners === true,
  },
  {
    name: "overview: Workers section",
    row: "Overview Workers section",
    map: "boot",
    reads: ["metrics.read"],
    features: ["workerMetrics"],
    metaFields: ["analytics", "analytics.recording.workers"],
    when: ({ meta }) => meta.analytics?.recording.workers === true,
  },
  {
    // useRunnerPagesRouted(): the Runners nav entry, on the untargeted map,
    // because the app registers `/runners/:runner` from the nav. A row whose
    // runner has since been unregistered still links: the runner screen's
    // own "no longer exists" state is the honest landing.
    name: "overview: Runners row runner link",
    row: "Overview Runners section row links",
    map: "boot",
    on: "overview: Runners section",
    needsOf: ["Runners: nav and /runners*"],
  },
  {
    // useWorkerPagesRouted(): the Workers nav entry, on the untargeted map,
    // for the same reason. The section spans queues, so a host granting
    // `workers.list` per queue leaves every row's key plain text — a link
    // there would point at a route the app never registered.
    name: "overview: Workers row key link",
    row: "Overview Workers section row links",
    map: "boot",
    on: "overview: Workers section",
    needsOf: ["Workers: nav and /workers"],
  },
  {
    // The queue column, gated like every other queue link: untargeted
    // `queues.list`, the action the queue screen's route is registered with.
    name: "overview: Workers row queue link",
    row: "Overview Workers section row links",
    map: "boot",
    on: "overview: Workers section",
    reads: ["queues.list"],
  },
  {
    name: "overview: Runners busiest note",
    row: 'Overview Runners / Workers note "Showing the N busiest … of M"',
    map: "boot",
    on: "overview: Runners section",
    when: ({ reads }) => reads?.runners?.truncated === true,
  },
  {
    name: "overview: Workers busiest note",
    row: 'Overview Runners / Workers note "Showing the N busiest … of M"',
    map: "boot",
    on: "overview: Workers section",
    when: ({ reads }) => reads?.workers?.truncated === true,
  },
  // The Jobs card is the "Overview counts" row's: metrics.read.
  {
    name: "overview: Jobs range caption",
    row: 'Overview range caption ("This is not exactly the range asked for: …")',
    map: "boot",
    on: "Overview: counts",
    when: ({ reads }) => reads?.jobs?.clamped === true,
  },
  {
    name: "overview: Runners range caption",
    row: 'Overview range caption ("This is not exactly the range asked for: …")',
    map: "boot",
    on: "overview: Runners section",
    when: ({ reads }) => reads?.runners?.clamped === true,
  },
  {
    name: "overview: Workers range caption",
    row: 'Overview range caption ("This is not exactly the range asked for: …")',
    map: "boot",
    on: "overview: Workers section",
    when: ({ reads }) => reads?.workers?.clamped === true,
  },
  {
    name: "overview: Jobs not kept",
    row: 'Overview "No numbers are kept for this range"',
    map: "boot",
    on: "Overview: counts",
    when: ({ reads }) => reads?.jobs?.notRetained === true,
  },
  {
    name: "overview: Runners not kept",
    row: 'Overview "No numbers are kept for this range"',
    map: "boot",
    on: "overview: Runners section",
    when: ({ reads }) => reads?.runners?.notRetained === true,
  },
  {
    name: "overview: Workers not kept",
    row: 'Overview "No numbers are kept for this range"',
    map: "boot",
    on: "overview: Workers section",
    when: ({ reads }) => reads?.workers?.notRetained === true,
  },
  {
    name: "Queues: nav and /queues*",
    row: "Queues nav entry and every `/queues*` route",
    map: "boot",
    sections: ["manage"],
    modes: ["jobs", "both"],
    reads: ["queues.list"],
  },
  {
    name: "queue: header total, paused badge",
    row: "Queue header total and paused badge",
    map: "queue",
    reads: ["queues.read"],
  },
  {
    name: "queue: jobs table",
    row: "Jobs table, and the job links in it",
    map: "queue",
    reads: ["jobs.list"],
  },
  {
    name: "queue: Processed by column",
    row: 'Jobs table "Processed by" column',
    map: "queue",
    reads: ["jobs.list"],
    features: ["jobAttribution"],
  },
  {
    // useWorkerPagesRouted(): the Workers nav entry, on the untargeted map.
    name: "queue: Processed by worker link",
    row: 'Jobs table "Processed by" worker link',
    map: "boot",
    on: "queue: Processed by column",
    needsOf: ["Workers: nav and /workers"],
    when: ({ job }) => job?.processedBy?.key !== undefined,
  },
  {
    name: "queue: jobs newest added first (sort=createdAt)",
    row: "Jobs table and worker page jobs, newest added first on every tab (`sort=createdAt`)",
    map: "queue",
    on: "queue: jobs table",
    features: ["addedByState"],
    // A page counting its total keeps the natural order.
    when: ({ countTotal }) => countTotal !== true,
  },
  {
    // The worker page's jobs never count a total.
    name: "worker page: jobs newest added first (sort=createdAt)",
    row: "Jobs table and worker page jobs, newest added first on every tab (`sort=createdAt`)",
    map: "queue",
    on: "worker page: jobs",
    features: ["addedByState"],
  },
  {
    name: "queue: Pause",
    row: "Pause / Resume",
    map: "queue",
    reads: ["queues.read"],
    mutations: ["queues.pause"],
    // The paused flag is the detail's, read only with queues.read.
    when: ({ detail }) => detail?.paused === false,
  },
  {
    name: "queue: Resume",
    row: "Pause / Resume",
    map: "queue",
    reads: ["queues.read"],
    mutations: ["queues.resume"],
    when: ({ detail }) => detail?.paused === true,
  },
  {
    name: "queue: Drain…",
    row: "Drain…, Clean…, Retry all…",
    map: "queue",
    mutations: ["queues.drain"],
  },
  {
    name: "queue: Clean…",
    row: "Drain…, Clean…, Retry all…",
    map: "queue",
    mutations: ["queues.clean"],
  },
  {
    name: "queue: Retry all…",
    row: "Drain…, Clean…, Retry all…",
    map: "queue",
    mutations: ["jobs.retryAll"],
  },
  {
    name: "queue: Add job",
    row: "Add job",
    map: "queue",
    mutations: ["jobs.add"],
    metaFields: ["addableNames"],
    when: ({ meta }) =>
      meta.addableNames === null || meta.addableNames.length > 0,
  },
  {
    name: "queue: Add job's name suggestions",
    row: "Add job's name suggestions",
    map: "queue",
    reads: ["definitions.list"],
    when: ({ meta }) => meta.addableNames === null,
  },
  // In the jobs table, so each needs jobs.list too.
  {
    name: "queue: bulk Retry selected",
    row: "Bulk Retry / Promote / Remove selected",
    map: "queue",
    reads: ["jobs.list"],
    mutations: ["jobs.retry"],
  },
  {
    name: "queue: bulk Promote selected",
    row: "Bulk Retry / Promote / Remove selected",
    map: "queue",
    reads: ["jobs.list"],
    mutations: ["jobs.promote"],
  },
  {
    name: "queue: bulk Remove selected…",
    row: "Bulk Retry / Promote / Remove selected",
    map: "queue",
    reads: ["jobs.list"],
    mutations: ["jobs.remove"],
  },
  {
    name: "panel=limits",
    row: "Limits panel",
    map: "queue",
    reads: ["queues.read"],
    features: ["limits"],
    // A spinner while the detail loads; then the panel only if the detail
    // carries the key, which is absent when the backend cannot store limits.
    // `null` (none set) still shows the panel.
    when: ({ detail }) => detail !== undefined && "limits" in detail,
  },
  {
    name: "panel=limits, editable",
    row: "Limits panel, editable",
    map: "queue",
    extends: "panel=limits",
    mutations: ["queues.limits"],
  },
  {
    // useJobDefaultsGate(): nothing is read without the feature.
    name: "panel=job-defaults",
    row: "Job defaults panel",
    map: "queue",
    reads: ["queues.read"],
    features: ["jobDefaults"],
  },
  {
    name: "panel=job-defaults, Settings…",
    row: "Job defaults Settings…",
    map: "queue",
    extends: "panel=job-defaults",
    mutations: ["queues.defaults"],
  },
  {
    // Separate from Settings…: editing does not grant rewriting the backlog.
    name: "panel=job-defaults, Apply to N pending jobs…",
    row: "Job defaults Apply to N pending jobs…",
    map: "queue",
    on: "panel=job-defaults",
    features: ["jobDefaultsApply"],
    mutations: ["queues.applyDefaults"],
    // Otherwise the panel says why, in place of the button.
    when: ({ jobDefaults }) =>
      jobDefaults !== undefined &&
      jobDefaults.overridden.length > 0 &&
      jobDefaults.pending.total > 0,
  },
  {
    name: "panel=workers",
    row: "Workers panel",
    map: "queue",
    reads: ["workers.list"],
    features: ["workers"],
  },
  {
    name: "panel=throughput",
    row: "Throughput panel",
    map: "queue",
    reads: ["metrics.read"],
    features: ["throughput"],
  },
  {
    name: "panel=repeatables",
    row: "Repeatables panel",
    map: "queue",
    reads: ["repeatables.list"],
  },
  {
    name: "panel=repeatables, Remove",
    row: "Repeatables panel, Remove",
    map: "queue",
    extends: "panel=repeatables",
    mutations: ["repeatables.remove"],
  },
  {
    // The panel's own rows, paged where the queue has more repeat series than
    // one page holds. Remove sits in a row, so it needs its own mutation; a
    // pager does not — it only rearranges rows the panel may already show.
    name: "panel=repeatables, pager",
    row: "Repeatables panel pager",
    map: "queue",
    needsOf: ["panel=repeatables"],
    pagedTable: "repeatables",
    when: (inputs) => pagerShown("repeatables", inputs),
  },
  {
    // Without it: "Job hidden", and the job is not requested. Nor is it
    // while the queue's map loads.
    name: "job: screen",
    row: "Job screen",
    map: "queue",
    waits: true,
    reads: ["jobs.read"],
  },
  {
    name: "job: logs",
    row: "Job logs",
    map: "queue",
    reads: ["jobs.logs"],
    features: ["logs"],
  },
  {
    // Shown in any state; only its clickability depends on the job (not
    // while `active`, nor while the log is empty), with the reason beside it.
    name: "job: Clear logs…",
    row: "Job Clear logs…",
    map: "queue",
    on: "job: logs",
    mutations: ["jobs.clearLogs"],
  },
  {
    name: "job: Retry",
    row: "Job Retry",
    map: "queue",
    mutations: ["jobs.retry"],
    when: ({ job }) => job !== undefined && FINISHED.has(job.state),
  },
  {
    name: "job: Promote",
    row: "Job Promote",
    map: "queue",
    mutations: ["jobs.promote"],
    when: ({ job }) => job?.state === "delayed",
  },
  {
    name: "job: Remove",
    row: "Job Remove",
    map: "queue",
    mutations: ["jobs.remove"],
  },
  {
    name: "job: Edit",
    row: "Job Edit",
    map: "queue",
    mutations: ["jobs.update"],
    features: ["update"],
  },
  {
    // A line of the job's summary, so it waits for the queue's map too.
    name: "job: Processed by",
    row: 'Job "Processed by"',
    map: "queue",
    waits: true,
    on: "job: screen",
    reads: ["jobs.read"],
    features: ["jobAttribution"],
  },
  {
    name: "job: Processed by worker link",
    row: 'Job "Processed by" worker link',
    map: "boot",
    on: "job: Processed by",
    needsOf: ["Workers: nav and /workers"],
    when: ({ job }) => job?.processedBy?.key !== undefined,
  },
  {
    name: "Runners: nav and /runners*",
    row: "Runners nav entry and every `/runners*` route",
    map: "boot",
    sections: ["manage"],
    modes: ["runner", "both"],
    reads: ["runners.list"],
  },
  {
    // The whole screen is this one list, so its window lives in the URL as
    // `/queues`' does (`offset`, `limit`) and a link reproduces the page being
    // read. Browser-side all the same: the list is read whole and filtered
    // here, so no request carries either, and changing the filter drops the
    // offset so a narrowed list starts at its first page again.
    name: "runners: list pager",
    row: "Runners list pager",
    map: "boot",
    needsOf: ["Runners: nav and /runners*"],
    pagedTable: "runners",
    when: (inputs) => pagerShown("runners", inputs),
  },
  {
    // Without it: "Runner hidden", and the runner is not requested. Nor is
    // it while the runner's map loads.
    name: "runner: screen",
    row: "Runner screen",
    map: "runner",
    waits: true,
    reads: ["runners.read"],
  },
  {
    name: "runner: stats and history",
    row: "Runner stats and history",
    map: "runner",
    waits: true,
    reads: ["runners.read"],
    // Read once the runner itself has loaded.
    when: ({ runner }) => runner !== undefined,
  },
  {
    // The one pager here that reads the server for each page, and so the one
    // whose table is not in `PAGE_SIZES`: `GET /runners/:runner/history` takes
    // the window (`offset`, `limit`) and reports `page.total`, so the "Runs
    // shown" number is the page size and turning a page re-reads with a new
    // offset. It is therefore on screen when the runner's **stored total**
    // outgrows that size — the six others compare the rows they were handed —
    // and `limits.maxHistory` caps the size, never how deep the offset reads,
    // so every run `keepHistory` holds is reachable.
    //
    // The window lives in the URL, which is what lets a Log button's link
    // carry the page its run is on; a `?logs=` naming a run this page does not
    // hold cannot be placed at all (no route says where a run sits), so the
    // card says so with a Close log rather than opening nothing.
    name: "runner: history pager",
    row: "Runner history pager",
    map: "runner",
    needsOf: ["runner: stats and history"],
    pagedTable: HISTORY_TABLE,
    when: (inputs) => pagerShown("runner history", inputs),
  },
  {
    name: "runner: active runs",
    row: "Runner active runs",
    map: "runner",
    when: ({ runner }) => runner?.local !== undefined,
  },
  {
    // useCanReadRunLogs(): the history's Log column, and every log view.
    name: "runner: run log and Log column",
    row: "Runner run log, and the history's Log column",
    map: "runner",
    waits: true,
    on: "runner: stats and history",
    reads: ["runners.logs"],
    features: ["runnerLogs"],
  },
  {
    name: "runner: a run's Log button",
    row: "A run's Log button (in the history row, and Show log in its expanded details)",
    map: "runner",
    extends: "runner: run log and Log column",
    when: ({ run }) => runHasLog(run),
  },
  {
    name: "runner: N lines dropped",
    row: 'A history row\'s "N lines dropped" badge',
    map: "runner",
    // It sits in the Log column: the run log's needs, restated by the row.
    on: "runner: run log and Log column",
    reads: ["runners.logs"],
    features: ["runnerLogs"],
    when: ({ run }) => (run?.logsDropped ?? 0) > 0,
  },
  // The actions sit in the runner's header, so each needs the runner.
  {
    name: "runner: Trigger…",
    row: "Runner Trigger…",
    map: "runner",
    mutations: ["runners.trigger"],
    when: ({ runner }) => runner !== undefined,
  },
  {
    name: "runner: Trigger…'s Arguments field",
    row: "Runner Trigger…",
    map: "runner",
    mutations: ["runners.trigger"],
    metaFields: ["runnerTriggerArgs"],
    when: ({ runner, meta }) => runner !== undefined && meta.runnerTriggerArgs,
  },
  {
    name: "runner: Pause",
    row: "Runner Pause / Resume…",
    map: "runner",
    mutations: ["runners.pause"],
    when: ({ runner }) => runner?.isPaused === false,
  },
  {
    name: "runner: Resume…",
    row: "Runner Pause / Resume…",
    map: "runner",
    mutations: ["runners.resume"],
    when: ({ runner }) => runner?.isPaused === true,
  },
  {
    name: "runner: Reschedule…",
    row: "Runner Reschedule…",
    map: "runner",
    mutations: ["runners.reschedule"],
    when: ({ runner }) => runner !== undefined,
  },
  {
    name: "runner: Kill…",
    row: "Runner Kill…",
    map: "runner",
    mutations: ["runners.kill"],
    // A run in flight in this process, not just `isRunning`.
    when: ({ runner }) => hasLocalRuns(runner),
  },
  {
    name: "runner: Reset stats…",
    row: "Runner Reset stats…",
    map: "runner",
    mutations: ["runners.resetStats"],
    when: ({ runner }) => runner?.isLocal === true,
  },
  {
    // Local or not: it works on what the backend stores. It sits in the
    // History card's header, so it needs the history; disabled ("No runs to
    // clear.") while the history is empty, which is a state, not a gate.
    name: "runner: Clear history…",
    row: "Runner Clear history…",
    map: "runner",
    on: "runner: stats and history",
    mutations: ["runners.clearHistory"],
    when: ({ runner }) => runner !== undefined,
  },
  {
    name: "runner: non-local hint",
    row: "Runner non-local hint",
    map: "runner",
    anyMutation: ["runners.kill", "runners.resetStats"],
    when: ({ runner }) => runner?.isLocal === false,
  },
  // Workers: /workers reads the untargeted map; a worker page sits in the
  // queue's PermissionScope and does not wait for it.
  {
    name: "Workers: nav and /workers",
    row: "Workers nav entry and `/workers`",
    map: "boot",
    sections: ["manage"],
    modes: ["jobs", "both"],
    features: ["workers"],
    reads: ["workers.list"],
  },
  {
    name: "workers page: queue links",
    row: "Workers page queue links",
    map: "boot",
    on: "Workers: nav and /workers",
    reads: ["queues.list"],
  },
  {
    name: "workers page: Queue, Service and State filters",
    row: "Workers page Queue, Service and State filters",
    map: "boot",
    on: "Workers: nav and /workers",
    reads: ["workers.list"],
  },
  {
    // hostsExposed(): some worker of the unfiltered list carries a host.
    name: "workers page: Host filter",
    row: "Workers page Host filter",
    map: "boot",
    on: "Workers: nav and /workers",
    reads: ["workers.list"],
    when: ({ workerList }) =>
      workerList?.some((worker) => worker.host !== undefined) === true,
  },
  {
    name: "worker table: key links",
    row: "Workers table key links (the Workers page and a queue's Workers panel)",
    map: "boot",
    needsOf: ["Workers: nav and /workers"],
    when: ({ worker }) => worker?.key !== undefined,
  },
  {
    // Routed with the Workers nav entry.
    name: "worker page: route",
    row: "Worker page (`/workers/:queue/:key`)",
    map: "boot",
    needsOf: ["Workers: nav and /workers"],
  },
  {
    // Without it: "Instances hidden", and neither the configuration nor the
    // numbers; the jobs card stays.
    name: "worker page: instances",
    row: "Worker page (`/workers/:queue/:key`)",
    map: "queue",
    on: "worker page: route",
    reads: ["workers.list"],
  },
  {
    name: "worker page: queue link",
    row: "Worker page queue link",
    map: "boot",
    on: "worker page: route",
    reads: ["queues.list"],
  },
  {
    // The configure gate of the first instance reporting a config.
    name: "worker page: Edit settings…",
    row: "Worker page Edit settings…",
    map: "queue",
    on: "worker page: instances",
    mutations: ["workers.configure"],
    features: ["workerControl"],
    when: ({ workerPage }) =>
      workerConfigurable(
        workerPage?.instances.find((worker) => worker.config !== undefined),
      ),
  },
  {
    name: "worker page: Reset to code values…",
    row: "Worker page Reset to code values… (no live instance)",
    map: "queue",
    on: "worker page: instances",
    mutations: ["workers.configure"],
    features: ["workerControl"],
    // `stored` is already `null` for an emptied entry (storedOverride()).
    when: ({ workerPage }) =>
      workerPage !== undefined &&
      workerPage.instances.length === 0 &&
      workerPage.stored !== null,
  },
  {
    name: "worker page: Change pending",
    row: 'Worker page "Change pending" badge',
    map: "queue",
    on: "worker page: instances",
    when: ({ workerPage }) =>
      workerPage?.instances.some((worker) => worker.control?.pending) === true,
  },
  {
    // useAnalyticsGate("workers"), asked on the queue's answer. Shown in the
    // "Instances hidden" branch too: it never needed workers.list.
    name: "worker page: throughput and busyness",
    row: "Worker page throughput and busyness",
    map: "queue",
    on: "worker page: route",
    sameAs: "overview: Workers section",
    reads: ["metrics.read"],
    features: ["workerMetrics"],
    metaFields: ["analytics", "analytics.recording.workers"],
    when: ({ meta }) => meta.analytics?.recording.workers === true,
  },
  {
    name: "worker page: jobs",
    row: 'Worker page jobs ("Jobs whose last attempt this key ran")',
    map: "queue",
    on: "worker page: route",
    reads: ["jobs.list"],
    features: ["jobAttribution"],
    // A key holding a comma cannot be sent as one filter value.
    when: ({ workerPage }) => workerPage?.key.includes(",") !== true,
  },
  {
    name: "worker page: jobs' job links",
    row: "Worker page jobs' job links",
    map: "boot",
    on: "worker page: jobs",
    reads: ["queues.list"],
  },
  // A worker table, on /workers, a queue's Workers panel or a worker page.
  {
    name: "worker table: Completed / Failed columns",
    row: "Workers table Completed / Failed columns (the Workers page and a queue's Workers panel)",
    map: "worker",
    when: ({ workerTable }) =>
      workerTable?.some(
        (worker) =>
          worker.completed !== undefined || worker.failed !== undefined,
      ) === true,
  },
  {
    // Two conditions, and the first is the table's own: the Workers page and a
    // worker page's Instances table pass `showMemory`, a queue's Workers panel
    // does not. The figure is the *process's* resident memory at that report,
    // so two workers sharing a pid repeat one number and the column is never
    // summed; a worker reporting none shows "—", because absent is not zero.
    name: "worker table: Memory column",
    row: "Workers table Memory column (the Workers page and a worker page's Instances table, not a queue's Workers panel)",
    map: "worker",
    when: ({ workerTableMemory, workerTable }) =>
      workerTableMemory === true &&
      workerTable?.some((worker) => worker.rssBytes !== undefined) === true,
  },
  {
    // A badge in the State cell of every worker table — the Workers page, a
    // queue's Workers panel and a worker page's Instances table — so, unlike
    // the Memory column, no table opts out, and it is the row's own worker
    // that decides, like "Change pending" beside it. **Absent is not
    // "in-process"**: a worker too old to report `target` has said nothing,
    // so it gets no badge at all, never the default's.
    name: "worker table: target badge",
    row: "Workers table target badge (the Workers page, a queue's Workers panel and a worker page's Instances table)",
    map: "worker",
    when: ({ worker }) => worker?.target !== undefined,
  },
  {
    // Rendered with the Instances card, from the same one listing, so it has
    // exactly the Instances' needs on the queue's answer — restated here and
    // held equal to them by the sameAs check. No `when`: with no live
    // instance it still shows, saying the target is known once one reports;
    // an instance too old to report shows "—", which `06-browser/workers.ts`
    // asserts on the real page.
    name: "worker page: Target card",
    row: "Worker page Target card",
    map: "queue",
    on: "worker page: route",
    sameAs: "worker page: instances",
    reads: ["workers.list"],
  },
  // The three worker tables page at their own sizes, and each pager belongs to
  // the table it pages, not to the screen around it.
  {
    // One pager per **server** section: a pager per service card, or one over
    // the whole page, would have to turn across the host headings that say
    // where a worker runs. The section's heading keeps counting the server's
    // workers, not the page's.
    name: "workers page: server table pager",
    row: "Workers page server table pager",
    map: "boot",
    needsOf: ["Workers: nav and /workers"],
    pagedTable: "workers page server",
    when: (inputs) => pagerShown("workers page server", inputs),
  },
  {
    // The same 25 as a server's section: the same kind of list, paged the same
    // way wherever it is read. One queue rarely has that many live workers.
    name: "panel=workers, pager",
    row: "Queue Workers panel pager",
    map: "queue",
    needsOf: ["panel=workers"],
    pagedTable: "queue workers panel",
    when: (inputs) => pagerShown("queue workers panel", inputs),
  },
  {
    // Ten, not a worker *list's* 25: these are the live instances of one key,
    // which is one or a few on most deployments, so the card almost never
    // shows a pager — and a key replicated across a large fleet stays a card
    // rather than taking over the page above its configuration.
    name: "worker page: instances pager",
    row: "Worker page Instances pager",
    map: "queue",
    needsOf: ["worker page: instances"],
    pagedTable: "worker instances",
    when: (inputs) => pagerShown("worker instances", inputs),
  },
  {
    // The housekeeping note, and the trap in it: **`sweeps` absent is not
    // `false`**. A worker too old to report the field has said nothing, so a
    // panel whose live workers all omit it is a fleet mid-upgrade, not a queue
    // nobody tidies — it shows no note at all. `sweeps: true` means the worker
    // *takes part* in housekeeping (it arms the timer and contends for the
    // lease; under the lease one holder does the pass and the others stand
    // down), so one such worker is enough for the note to go. Where some omit
    // the field and none reports `true`, the note is shown but hedged
    // (`data-uncertain="true"`), which `06-browser/workers.ts` asserts on the
    // real wording.
    name: "worker table: housekeeping note",
    row: "Queue Workers panel housekeeping note",
    map: "worker",
    when: ({ workerTableQueuePanel, workerTable }) => {
      const reported = (workerTable ?? []).filter(
        (worker) => worker.sweeps !== undefined,
      );
      return (
        workerTableQueuePanel === true &&
        reported.length > 0 &&
        !reported.some((worker) => worker.sweeps === true)
      );
    },
  },
  {
    name: "worker: instruction says done (applied)",
    row: 'Worker instruction wording ("Paused X" vs "Asked X to pause")',
    map: "worker",
    when: ({ controlResult }) => controlResult?.applied === true,
  },
  {
    name: "worker: Pause",
    row: "Worker Pause",
    map: "worker",
    mutations: ["workers.pause"],
    features: ["workerControl"],
    when: ({ worker }) => workerTakes(worker, "workers.pause"),
  },
  {
    name: "worker: Resume",
    row: "Worker Resume",
    map: "worker",
    mutations: ["workers.resume"],
    features: ["workerControl"],
    when: ({ worker }) => workerTakes(worker, "workers.resume"),
  },
  {
    name: "worker: Stop…",
    row: "Worker Stop…",
    map: "worker",
    mutations: ["workers.stop"],
    features: ["workerControl"],
    when: ({ worker }) => workerTakes(worker, "workers.stop"),
  },
  {
    name: "worker: Start",
    row: "Worker Start",
    map: "worker",
    mutations: ["workers.start"],
    features: ["workerControl"],
    when: ({ worker }) => workerTakes(worker, "workers.start"),
  },
  {
    name: "worker: Stop… persistence choice",
    row: "Worker Stop… persistence choice",
    map: "worker",
    on: "worker: Stop…",
    when: ({ worker }) => worker?.control?.stopPersistenceOverridable === true,
  },
  {
    name: "worker: Settings…",
    row: "Worker Settings…",
    map: "worker",
    mutations: ["workers.configure"],
    features: ["workerControl"],
    when: ({ worker }) => workerConfigurable(worker),
  },
  {
    name: "worker: Change pending",
    row: 'Worker "Change pending" badge and the Settings dialog\'s pending note',
    map: "worker",
    when: ({ worker }) => worker?.control?.pending === true,
  },
  {
    name: "worker table: Actions column",
    row: "Worker actions column",
    map: "worker",
    when: ({ workerTable, workerMap, meta }) =>
      workerMap !== undefined &&
      workerTable?.some((worker) =>
        workerOffersAny(worker, workerMap, meta),
      ) === true,
  },
  {
    // In every mode: the console offers the mode's own channels.
    name: "Events: nav and /events",
    row: "Events nav entry and `/events`",
    map: "boot",
    sections: ["manage"],
    reads: ["events.connect"],
    metaFields: ["websocket"],
    when: ({ meta }) => meta.websocket !== null,
  },
  {
    name: "events: queue list in the queue and job pickers",
    row: "Events queue and job channel pickers' queue list",
    map: "boot",
    on: "Events: nav and /events",
    // The queue and job channels exist only where queues do.
    modes: ["jobs", "both"],
    reads: ["queues.list"],
  },
  {
    name: "events: runner list in the runner picker",
    row: "Events runner channel picker's runner list",
    map: "boot",
    on: "Events: nav and /events",
    // The runner channel exists only where a runner does.
    modes: ["runner", "both"],
    reads: ["runners.list"],
  },
  // The API docs. Not under sections.manage: a docs-only UI has them.
  {
    name: "Docs: nav and /docs*",
    row: "API docs nav entry and every `/docs*` route",
    map: "boot",
    sections: ["docs"],
    notNeeded: ["manage"],
    reads: ["docs.read"],
    metaFields: ["docs"],
    when: ({ meta }) => meta.docs !== null,
  },
  {
    name: "docs: HTTP API entry, reference and card",
    row: "HTTP API nav entry (under API docs), the HTTP reference (`/docs/http*`) and its card on `/docs`",
    map: "boot",
    on: "Docs: nav and /docs*",
    // The row names `meta.docs` too: the API sends `openapi` whenever it
    // sends `docs`, so the reference exists wherever the nav entry does.
    metaFields: ["docs", "docs.openapi"],
    when: ({ meta }) => meta.docs?.openapi !== undefined,
  },
  {
    // Without it there is no WebSocket API nav entry, and /docs/ws is a
    // screen saying so: the reference is absent.
    name: "docs: WebSocket API entry, reference and card",
    row: "WebSocket API nav entry (under API docs), the WebSocket reference (`/docs/ws*`) and its card on `/docs`",
    map: "boot",
    on: "Docs: nav and /docs*",
    metaFields: ["docs.asyncapi"],
    when: ({ meta }) => meta.docs?.asyncapi !== undefined,
  },
  {
    name: "docs http: permission marker (You have)",
    row: 'HTTP operation\'s permission marker, "You have" / "You lack"',
    map: "operation",
    on: "docs: HTTP API entry, reference and card",
    itemKind: "http",
    itemAction: true,
    denied: "lack",
  },
  {
    name: "docs ws: permission marker (You have this)",
    row: 'WebSocket channel\'s and operation\'s permission markers, "You have this" / "You lack this"',
    map: "operation",
    on: "docs: WebSocket API entry, reference and card",
    itemKind: "ws",
    itemAction: true,
    unknownAction: true,
    denied: "lack",
  },
  {
    name: "docs http: try-it Send",
    row: "HTTP try-it Send",
    map: "operation",
    on: "docs: HTTP API entry, reference and card",
    itemKind: "http",
    methods: CLIENT_METHODS,
    itemMutation: true,
    metaFields: ["readOnly"],
    itemAction: true,
    denied: "disabled",
  },
  {
    // Every mutation asks first; a GET sends at once, with no dialog.
    name: "docs http: try-it asks first",
    row: "HTTP try-it confirmation",
    map: "operation",
    on: "docs: HTTP API entry, reference and card",
    itemKind: "http",
    forMutation: true,
  },
  {
    name: "docs http: try-it needs the operationId typed",
    row: "HTTP try-it confirmation",
    map: "operation",
    on: "docs http: try-it asks first",
    itemKind: "http",
    typed: { methods: ["DELETE"], verbs: DESTRUCTIVE_VERBS },
  },
  {
    name: "docs ws: try-it opens the Events console",
    row: 'WebSocket try-it, "Open in the Events console"',
    map: "operation",
    on: "docs: WebSocket API entry, reference and card",
    itemKind: "ws",
    channelOnly: true,
    // The Events nav entry's own gate, restated.
    sections: ["manage"],
    reads: ["events.connect"],
    metaFields: ["websocket"],
    when: ({ meta }) => meta.websocket !== null,
    denied: "note",
  },
  {
    name: "docs ws: a channel's link",
    row: 'WebSocket try-it, "Open in the Events console"',
    map: "operation",
    on: "docs ws: try-it opens the Events console",
    itemKind: "ws",
    channelOnly: true,
    inMode: true,
    // Filled, and every value held to its x-bun-jobs-schema; one that fails
    // disables the link, with the reason shown.
    itemSchema: true,
    denied: "disabled",
  },
  {
    // Any state the API can bury: waiting, delayed, failed (retry pending),
    // waiting-children, and active too (with a warning in the dialog).
    name: "job: Fail…",
    row: "Job Fail…",
    map: "queue",
    mutations: ["jobs.fail"],
    when: ({ job }) => job !== undefined && !UNFAILABLE.has(job.state),
  },
  {
    name: "panel=repeatables, Disable",
    row: "Repeatables panel, Disable / Enable",
    map: "queue",
    reads: ["repeatables.list"],
    mutations: ["repeatables.disable"],
    when: ({ repeatable }) => repeatable?.disabled === false,
  },
  {
    name: "panel=repeatables, Enable",
    row: "Repeatables panel, Disable / Enable",
    map: "queue",
    reads: ["repeatables.list"],
    mutations: ["repeatables.enable"],
    when: ({ repeatable }) => repeatable?.disabled === true,
  },
  {
    // Opt-in; a runner without `config` predates remote configuration.
    name: "runner: Settings…",
    row: "Runner Settings…",
    map: "runner",
    mutations: ["runners.configure"],
    when: ({ runner }) => runner?.config !== undefined,
  },
  {
    name: "runner: summary's override rows",
    row: "Runner summary's override rows",
    map: "runner",
    waits: true,
    reads: ["runners.read"],
    when: ({ runner }) => runner?.config !== undefined,
  },
] as const satisfies readonly Gate[];

/**
 * Whether the Events console can open `address` in `mode`: the UI's
 * `parseChannel` scopes, `all` only in `both`.
 */
function channelInMode(address: string, mode: MetaDto["mode"]): boolean {
  const scope = address.split("/")[0]!;
  const queues = mode !== "runner";
  const runners = mode !== "jobs";
  if (scope === "all") {
    return queues && runners;
  }
  if (scope === "queues" || scope === "queue") {
    return queues;
  }
  return (scope === "runners" || scope === "runner") && runners;
}

/** The name of every gate. */
type GateName = (typeof GATES)[number]["name"];

/** Every gate, open or not. */
type Gates = Record<GateName, boolean>;

/**
 * The map that decides `gate`, or `undefined` when nothing may be shown yet:
 * off its screen, or while a targeted map it waits for is loading.
 */
function mapFor(gate: Gate, inputs: ScreenInputs): PermissionsBody | undefined {
  if (gate.map === "boot") {
    return inputs.boot;
  }
  if (gate.map === "worker") {
    return inputs.workerMap;
  }
  if (gate.map === "operation") {
    // The untargeted map, but only on a documented item of the gate's kind.
    return inputs.item !== undefined &&
      (gate.itemKind === undefined || gate.itemKind === inputs.item.kind)
      ? inputs.boot
      : undefined;
  }
  const targeted = gate.map === "queue" ? inputs.queue : inputs.runnerMap;
  if (targeted === "pending") {
    return gate.waits ? undefined : inputs.boot;
  }
  return targeted;
}

/** Whether one gate is open. */
function isOpen(gate: Gate, inputs: ScreenInputs): boolean {
  const { meta } = inputs;
  const permissions = mapFor(gate, inputs);
  if (permissions === undefined) {
    return false;
  }
  const mutable = (action: JobsApiAction) =>
    !meta.readOnly && can(permissions, action);
  const parent = GATES.find((other) => other.name === gate.extends);
  const screen = GATES.find((other) => other.name === gate.on);
  const needed = (gate.needsOf ?? []).map(
    (name) => GATES.find((other: Gate) => other.name === name)!,
  );
  return (
    (parent === undefined || isOpen(parent, inputs)) &&
    (screen === undefined || isOpen(screen, inputs)) &&
    needed.every((other) => isOpen(other, inputs)) &&
    (gate.unlisted?.features ?? []).every(
      (feature) => meta.features[feature],
    ) &&
    (gate.sections ?? []).every((section) => inputs.sections[section]) &&
    (gate.modes === undefined ||
      (gate.modes as readonly string[]).includes(meta.mode)) &&
    (gate.reads ?? []).every((action) => can(permissions, action)) &&
    (gate.anyOf === undefined ||
      gate.anyOf.some((action) => can(permissions, action))) &&
    (gate.mutations ?? []).every(mutable) &&
    (gate.anyMutation === undefined || gate.anyMutation.some(mutable)) &&
    (gate.features ?? []).every((feature) => meta.features[feature]) &&
    itemAllows(gate, inputs.item, meta, permissions) &&
    (gate.when?.(inputs) ?? true)
  );
}

/** The verb of an action: `queues.drain` → `drain`. */
function verbOf(action: string | undefined): string {
  return action?.split(".").pop() ?? "";
}

/**
 * Whether `item` is a page a `channelOnly` gate can be on: a channel's, and
 * not the connection's (which has no try-it).
 */
function hasTryIt(item: DocItem | undefined): boolean {
  return item?.address !== undefined && item.connection !== true;
}

/** Whether a documented item passes the gate's item rules. */
function itemAllows(
  gate: Gate,
  item: DocItem | undefined,
  meta: MetaDto,
  permissions: PermissionsBody,
): boolean {
  if (gate.map !== "operation") {
    return true;
  }
  if (item === undefined) {
    return false;
  }
  const action = item.action;
  return (
    (!gate.channelOnly || hasTryIt(item)) &&
    (!gate.itemSchema || typeof item.address === "string") &&
    (!gate.forMutation || item.mutation === true) &&
    (gate.methods === undefined || gate.methods.includes(item.method ?? "")) &&
    (!gate.itemMutation || !(item.mutation === true && meta.readOnly)) &&
    // Reads included: an action the map lacks, or refuses, closes it.
    (!gate.itemAction ||
      action === undefined ||
      (ACTION_NAMES.has(action) &&
        can(permissions, action as JobsApiAction))) &&
    (gate.typed === undefined ||
      gate.typed.methods.includes(item.method ?? "") ||
      gate.typed.verbs.includes(verbOf(action))) &&
    (!gate.inMode ||
      (typeof item.address === "string" &&
        channelInMode(item.address, meta.mode)))
  );
}

/**
 * What a gate shows: `open`, or when closed, what its `denied` says, but
 * only while the screen it sits on (`on`, and its item) is itself shown;
 * otherwise `absent`. A WebSocket marker for an action outside the
 * contract's list is `unknown`.
 */
type GateState = "open" | Denied | "unknown";

/** One gate's state, for one screen. */
function gateState(gate: Gate, inputs: ScreenInputs): GateState {
  if (isOpen(gate, inputs)) {
    return "open";
  }
  const screen = GATES.find((other: Gate) => other.name === gate.on);
  const onScreen =
    (screen === undefined || isOpen(screen, inputs)) &&
    mapFor(gate, inputs) !== undefined &&
    (!gate.channelOnly || hasTryIt(inputs.item));
  if (!onScreen) {
    return "absent";
  }
  const action = inputs.item?.action;
  if (gate.unknownAction && action !== undefined && !ACTION_NAMES.has(action)) {
    return "unknown";
  }
  return gate.denied ?? "absent";
}

/** Every gate's state, by name. */
function screenStates(inputs: ScreenInputs): Record<GateName, GateState> {
  return Object.fromEntries(
    GATES.map((gate) => [gate.name, gateState(gate, inputs)]),
  ) as Record<GateName, GateState>;
}

/**
 * What the screens show, for one caller and one queue (with, for the job
 * buttons, one job) or one runner. An element that is not allowed is absent,
 * not disabled.
 */
function screenGates(inputs: ScreenInputs): Gates {
  return Object.fromEntries(
    GATES.map((gate) => [gate.name, isOpen(gate, inputs)]),
  ) as Gates;
}

/** The gates decided on `maps`, from a full set: one screen's view. */
function onMaps(gates: Gates, ...maps: GateMap[]): Partial<Gates> {
  return Object.fromEntries(
    GATES.filter((gate: Gate) => maps.includes(gate.map)).map((gate) => [
      gate.name,
      gates[gate.name],
    ]),
  ) as Partial<Gates>;
}

/** Every gate on `maps` set to `value`. */
function allGates(value: boolean, ...maps: GateMap[]): Partial<Gates> {
  return Object.fromEntries(
    GATES.filter((gate: Gate) => maps.includes(gate.map)).map((gate) => [
      gate.name,
      value,
    ]),
  ) as Partial<Gates>;
}

/* ------------------------------------------------------------------ */
step("GATES against the README's table, row for row");

/** One row of the README's "What each element needs" table. */
interface ReadmeRow {
  /** The "Element" cell. */
  element: string;
  /** The "Needs" cell. */
  needs: string;
}

/** The package README, whose tables are the contract checked here. */
const PACKAGE_README = join(
  import.meta.dir,
  "../../../packages/bun-jobs-ui/README.md",
);

/**
 * The rows of the pipe table under `heading` in the package README, each cell
 * trimmed. The docs are the contract here, not the package's code.
 */
async function readmeTable(heading: string): Promise<string[][]> {
  const lines = (await Bun.file(PACKAGE_README).text()).split("\n");
  const index = lines.findIndex((line) => line.trim() === heading);
  if (index === -1) {
    throw new Error(`${PACKAGE_README} has no "${heading}" section`);
  }
  const start = lines.findIndex(
    (line, at) => at > index && line.startsWith("|"),
  );
  const rows: string[][] = [];
  // Skip the header and the |---| separator; stop at the first non-row.
  for (let at = start + 2; lines[at]?.startsWith("|"); at++) {
    rows.push(lines[at]!.split("|").map((cell) => cell.trim()));
  }
  return rows;
}

/** The table under `### What each element needs`. */
async function readmeGatingTable(): Promise<ReadmeRow[]> {
  return (await readmeTable("### What each element needs")).map((cells) => ({
    element: cells[1]!,
    // A cell holding a `|` of its own is rejoined, as the split broke it.
    needs: cells.slice(2, -1).join("|"),
  }));
}

/** One row of the README's `### URL parameters` table. */
interface UrlParamRow {
  /** The screen it belongs to, as the table spells it (`/runners/:runner`). */
  screen: string;
  /** The parameter's name, unquoted. */
  parameter: string;
  /** What the row says it means, verbatim. */
  meaning: string;
}

/**
 * The table under `### URL parameters`. `permissions.ts` reads it for the
 * runner history alone — the size and depth of that table's pages are URL
 * parameters rather than constants, so the claims its pager row makes are
 * spelled out there. Every screen's parameters are checked against the links
 * that carry them in `deep-links.ts`.
 */
async function readmeUrlParams(): Promise<UrlParamRow[]> {
  return (await readmeTable("### URL parameters")).flatMap((cells) =>
    // A row may name several parameters ("`jobsRange`, `queuesRange`, …").
    [...cells[2]!.matchAll(/`([^`]+)`/g)].map((match) => ({
      screen: cells[1]!.replace(/`/g, ""),
      parameter: match[1]!,
      meaning: cells.slice(3, -1).join("|"),
    })),
  );
}

/** The values `meta.mode` takes. */
const MODES: ReadonlySet<string> = new Set(["jobs", "runner", "both"]);

/** HTTP methods, to pick them out of the README's prose. */
const METHOD_NAMES: ReadonlySet<string> = new Set(CLIENT_METHODS);

/** Destructive verbs, likewise. */
const VERB_NAMES: ReadonlySet<string> = new Set(DESTRUCTIVE_VERBS);

/**
 * What a row's cells ask for, as comparable lists. `element` is the
 * "Element" cell, which is where a marker row names its "You lack";
 * `elements` is every row's, to resolve "the Workers nav entry's needs" to
 * the row it names.
 */
function needsOfCell(
  needs: string,
  element: string,
  elements: readonly string[],
) {
  // "`sections.manage` is not needed" names a section in order to exclude it.
  const notNeeded = [...needs.matchAll(/`sections\.(\w+)` is not needed/g)].map(
    (match) => match[1]!,
  );
  // So do "separate from `queues.defaults`" and "even when that answer
  // refuses `workers.list`", for any code.
  const excluded = new Set([
    ...notNeeded.map((section) => `sections.${section}`),
    ...[...needs.matchAll(/(?:separate from|refuses) `([^`]+)`/g)].map(
      (match) => match[1]!,
    ),
  ]);
  const codes = [...needs.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]!)
    .filter((code) => !excluded.has(code));
  // "the Workers nav entry's needs": another row's needs, by the start of
  // its element; one naming no row stays as written, and fails.
  const refs = [...needs.matchAll(/\bthe ([A-Z][\w ]*)'s needs\b/g)].map(
    (match) =>
      elements.find((other) => other.startsWith(match[1]!)) ?? match[1]!,
  );
  const mode = codes.indexOf("meta.mode");
  return {
    // A cell may name an action twice ("`jobs.read` ... never without
    // `jobs.read`"): the set is what counts.
    actions: [
      ...new Set(codes.filter((code) => ACTION_NAMES.has(code))),
    ].sort(),
    // `features.workers`, or in full, `meta.features.workers`.
    features: codes
      .map((code) => code.replace(/^meta\.features\./, "features."))
      .filter((code) => code.startsWith("features."))
      .map((code) => code.slice("features.".length))
      .sort(),
    sections: codes
      .filter((code) => code.startsWith("sections."))
      .map((code) => code.slice("sections.".length))
      .sort(),
    // "`meta.mode` `runner` or `both`": the values that follow it.
    modes:
      mode === -1
        ? []
        : codes
            .slice(mode + 1)
            .filter((code) => MODES.has(code))
            .sort(),
    // "`meta.websocket`": the /meta fields named, other than the mode.
    metaFields: codes
      .filter(
        (code) =>
          code.startsWith("meta.") &&
          code !== "meta.mode" &&
          !code.startsWith("meta.features."),
      )
      .map((code) => code.slice("meta.".length))
      .sort(),
    refs: refs.sort(),
    mutation: /\bmutation\b/.test(needs),
    extendsAbove: needs.startsWith("the above"),
    notNeeded: notNeeded.sort(),
    // "`meta.mode` offers": the mode decides, without naming its values.
    namesMode: mode !== -1,
    methods: [
      ...new Set(codes.filter((code) => METHOD_NAMES.has(code))),
    ].sort(),
    verbs: codes.filter((code) => VERB_NAMES.has(code)).sort(),
    extensions: [
      ...new Set(codes.filter((code) => code.startsWith("x-bun-jobs-"))),
    ].sort(),
    // Whether the element stays on screen when it is not allowed: disabled
    // with a reason, a note in its place, or a "You lack" marker. Every
    // other row's element is absent. "disabled" alone is not enough: the
    // Disable / Enable row names "a disabled one", a repeat series' state;
    // nor is "a note": the Host filter is absent, "ignored with a note".
    shownWhenDenied:
      /\bdisabled, with the reason\b|\ba note says\b/.test(needs) ||
      element.includes("You lack"),
  };
}

/** The same, from the gates that make up one README row. */
function needsOfGates(gates: readonly Gate[]) {
  const unique = (values: readonly string[]) => [...new Set(values)].sort();
  return {
    actions: unique(
      gates.flatMap((gate) => [
        ...(gate.reads ?? []),
        ...(gate.anyOf ?? []),
        ...(gate.mutations ?? []),
        ...(gate.anyMutation ?? []),
      ]),
    ),
    features: unique(gates.flatMap((gate) => gate.features ?? [])),
    sections: unique(gates.flatMap((gate) => gate.sections ?? [])),
    modes: unique(gates.flatMap((gate) => gate.modes ?? [])),
    metaFields: unique(gates.flatMap((gate) => gate.metaFields ?? [])),
    refs: unique(
      gates.flatMap((gate) =>
        [...(gate.needsOf ?? []), ...(gate.sameAs ? [gate.sameAs] : [])].map(
          (name) => GATES.find((other: Gate) => other.name === name)!.row,
        ),
      ),
    ),
    mutation: gates.some(
      (gate) =>
        (gate.mutations ?? []).length > 0 ||
        (gate.anyMutation ?? []).length > 0 ||
        gate.itemMutation === true ||
        gate.forMutation === true,
    ),
    extendsAbove: gates.some((gate) => gate.extends !== undefined),
    notNeeded: unique(gates.flatMap((gate) => gate.notNeeded ?? [])),
    namesMode: gates.some(
      (gate) => gate.modes !== undefined || gate.inMode === true,
    ),
    methods: unique(
      gates.flatMap((gate) => [
        ...(gate.methods ?? []),
        ...(gate.typed?.methods ?? []),
      ]),
    ),
    verbs: unique(gates.flatMap((gate) => gate.typed?.verbs ?? [])),
    extensions: unique(
      gates.flatMap((gate) => [
        ...(gate.itemAction ? ["x-bun-jobs-action"] : []),
        ...(gate.itemMutation ? ["x-bun-jobs-mutation"] : []),
        ...(gate.itemSchema ? ["x-bun-jobs-schema"] : []),
      ]),
    ),
    shownWhenDenied: gates.some(
      (gate) => (gate.denied ?? "absent") !== "absent",
    ),
  };
}

const readme = await readmeGatingTable();
const gateRows = [...new Set(GATES.map((gate: Gate) => gate.row))];
checkEqual(
  `the README lists the same ${gateRows.length} elements, in the same order`,
  readme.map((row) => row.element),
  gateRows,
);
// And this example's own row in the examples README says how many it checks.
// That sentence is the one thing here nothing derived: it read "all 93 rows"
// while this check derived 94, because a row landed and only the code was
// looked at. So the number is asserted rather than described — a figure in
// prose that nothing compares to its source is a figure that will drift.
const examplesReadme = await Bun.file(
  join(import.meta.dir, "../README.md"),
).text();
checkEqual(
  "the examples README says how many rows this file checks, and means it",
  Number(/all (\d+) rows/.exec(examplesReadme)?.[1]),
  gateRows.length,
);
/** The row just before's parsed needs, for "under the same conditions". */
let previousNeeds: ReturnType<typeof needsOfCell> | undefined;
for (const row of readme) {
  const gates: Gate[] = GATES.filter((gate: Gate) => gate.row === row.element);
  const parsed = needsOfCell(
    row.needs,
    row.element,
    readme.map((other) => other.element),
  );
  // "Worker Resume … under the same conditions" as Worker Pause, the row
  // above: its features and /meta fields carry over (the actions do not).
  if (
    previousNeeds !== undefined &&
    /under the same conditions/.test(row.needs)
  ) {
    parsed.features = [
      ...new Set([...parsed.features, ...previousNeeds.features]),
    ].sort();
    parsed.metaFields = [
      ...new Set([...parsed.metaFields, ...previousNeeds.metaFields]),
    ].sort();
  }
  previousNeeds = parsed;
  checkEqual(
    `README "${row.element}" needs what GATES says`,
    parsed,
    needsOfGates(gates),
  );
}
checkEqual(
  'a row the README calls "untargeted" is decided on the untargeted map (or a worker table\'s, which is it on /workers)',
  readme
    .filter((row) => row.needs.includes("untargeted"))
    .filter((row) =>
      GATES.some(
        (gate: Gate) =>
          gate.row === row.element &&
          gate.map !== "boot" &&
          gate.map !== "operation" &&
          gate.map !== "worker",
      ),
    )
    .map((row) => row.element),
  [],
);
checkEqual(
  "a Runner row that is not untargeted is decided on the runner's own map",
  readme
    .filter(
      (row) =>
        row.element.startsWith("Runner ") &&
        !row.needs.includes("(untargeted)"),
    )
    .filter((row) =>
      GATES.some(
        (gate: Gate) => gate.row === row.element && gate.map !== "runner",
      ),
    )
    .map((row) => row.element),
  [],
);
checkEqual(
  'a row that waits "until they have loaded" does so in GATES',
  readme
    .filter((row) => row.needs.includes("until they have loaded"))
    .filter((row) =>
      GATES.some((gate: Gate) => gate.row === row.element && !gate.waits),
    )
    .map((row) => row.element),
  [],
);
// A mutation in the prose is a mutation to the API, and a read is not.
checkEqual(
  "every gate's mutations are mutations, and its reads are not",
  GATES.flatMap((gate: Gate) => [
    ...[...(gate.mutations ?? []), ...(gate.anyMutation ?? [])].filter(
      (action) => !JOBS_API_MUTATIONS.has(action),
    ),
    ...[...(gate.reads ?? []), ...(gate.anyOf ?? [])].filter((action) =>
      JOBS_API_MUTATIONS.has(action),
    ),
  ]),
  [],
);
checkEqual(
  'and "the above" names the row just before',
  GATES.filter((gate: Gate) => gate.extends !== undefined).map((gate: Gate) => {
    const index = readme.findIndex((row) => row.element === gate.row);
    const parent = GATES.find((other: Gate) => other.name === gate.extends);
    return readme[index - 1]?.element === parent?.row;
  }),
  [true, true, true, true],
);
checkEqual(
  "a gate that restates another's needs (sameAs) lists exactly its reads, features and /meta fields",
  GATES.filter((gate: Gate) => gate.sameAs !== undefined)
    .filter((gate: Gate) => {
      const other: Gate = GATES.find((one: Gate) => one.name === gate.sameAs)!;
      const lists = (one: Gate) =>
        JSON.stringify([one.reads, one.features, one.metaFields]);
      return lists(gate) !== lists(other);
    })
    .map((gate) => gate.name),
  [],
);

// A pager row states the rows one page holds — "(20)", "(25)", "(10)" — and
// that figure is the size the screen pages at. Same reason as the row count
// above: a number in prose that nothing compares to its source drifts.
const pagerGates = GATES.filter((gate: Gate) => gate.pagedTable !== undefined);
/**
 * The rows-per-page figure a pager row states: the number inside the
 * parentheses, however the sentence goes on.
 *
 * It used to be `/\((\d+)\)/`, which needs a `)` immediately after the digits
 * — and that made the check fail on prose that got *better*. PR #141 rewrote
 * the Runners list row's "(25)" as "(25 by default; `limit` is in the URL, so
 * the size a reader picks is what a page holds)", correcting a rule to a
 * default without touching the number, and this check went red on develop and
 * stayed red. A check that fires on a rewording is a check someone eventually
 * deletes, so the pattern reads the figure and lets the prose be prose. That
 * exact edit is the fixture below.
 */
const PAGE_FIGURE = /\((\d+)\b/;
/** A pager row's "needs" cell, as the README writes it. */
function pagerCell(gate: Gate): string {
  return readme.find((row) => row.element === gate.row)?.needs ?? "";
}
/** The figure a pager row states, or `undefined` where it states none. */
function statedPageSize(gate: Gate): string | undefined {
  return PAGE_FIGURE.exec(pagerCell(gate))?.[1];
}
show(
  "the figure each pager row states, as `PAGE_FIGURE` reads it",
  pagerGates.map((gate: Gate) => `${gate.row}: ${statedPageSize(gate)}`),
);
checkEqual(
  `all ${pagerGates.length} pager rows state the page size their table pages at`,
  pagerGates.map((gate: Gate) => `${gate.row}: ${statedPageSize(gate)}`),
  pagerGates.map(
    (gate: Gate) => `${gate.row}: ${PAGE_SIZES[gate.pagedTable!]}`,
  ),
);
// The other half of that: the figure must still be compared, so a rewording
// that changes the number has to fail. The #141 edit is the fixture — both
// spellings of that row give 25, and the old pattern gave nothing for the
// second, which is how develop came to be red.
const REWORDED = [
  "the Runners nav entry's needs, and more runners match the filter than one page holds (25). Its window lives in the URL, as the queue list's does, and changing the filter restarts it",
  "the Runners nav entry's needs, and more runners match the filter than one page holds (25 by default; `limit` is in the URL, so the size a reader picks is what a page holds). Its window lives in the URL, as the queue list's does, and changing the filter restarts it",
];
checkEqual(
  "rewording a row around an unchanged figure does not move the figure (PR #141's own edit), while the pattern it replaced read only the first spelling",
  [
    REWORDED.map((cell) => PAGE_FIGURE.exec(cell)?.[1]),
    REWORDED.map((cell) => /\((\d+)\)/.exec(cell)?.[1]),
  ],
  [
    ["25", "25"],
    ["25", undefined],
  ],
);

/** The rows gating on an opt-in action, and whether their cell says "opt-in". */
const optInRows = readme
  .map((row) => ({
    element: row.element,
    says: /\bopt-in\b/.test(row.needs),
    gates: GATES.filter((gate: Gate) => gate.row === row.element).some(
      (gate: Gate) =>
        [...(gate.mutations ?? []), ...(gate.anyMutation ?? [])].some(
          (action) => JOBS_API_OPT_IN_ACTIONS.has(action),
        ),
    ),
  }))
  .filter((row) => row.says || row.gates);
checkEqual(
  'a row that says "opt-in" gates on an opt-in action (JOBS_API_OPT_IN_ACTIONS)',
  optInRows.filter((row) => row.says && !row.gates).map((row) => row.element),
  [],
);
checkEqual(
  "and every row gating on one says so (Add job and Job Edit included)",
  optInRows.filter((row) => !row.says).map((row) => row.element),
  [],
);

// What the code needs beyond its row: each is a README row to fix upstream.
const unlistedRows = GATES.filter(
  (gate: Gate) => gate.unlisted !== undefined,
).map((gate: Gate) => ({
  row: gate.row,
  features: gate.unlisted!.features ?? [],
  why: gate.unlisted!.why,
}));
show(
  "where the app's code needs more than its README row says",
  unlistedRows.map(({ row, why }) => `${row}: ${why}`),
);
checkEqual(
  "those rows, by name: none left, every row states what its code needs",
  [...new Set(unlistedRows.map(({ row }) => row))],
  [],
);
checkEqual(
  "and no README row names an unlisted feature (else it is listed, not unlisted)",
  unlistedRows
    .filter(({ row, features }) =>
      features.some((feature) => {
        const cell = readme.find((one) => one.element === row)?.needs ?? "";
        return cell.includes(`features.${feature}`);
      }),
    )
    .map(({ row }) => row),
  [],
);

/* ------------------------------------------------------------------ */
step("GET /meta/permissions: the map the app boots with");

asked.length = 0;
const { body: boot } = await get<PermissionsBody>("/meta/permissions");
show("untargeted map", boot.actions);

// One `authorize` call per action the API routes, asked with no queue or
// runner, plus one for the request itself (`meta.read`, which guards
// /meta/permissions).
checkEqual(
  "authorize was asked once per routed action, plus once for the request",
  [
    asked.length,
    asked.every(
      (call) => call.queue === undefined && call.runner === undefined,
    ),
  ],
  [Object.keys(boot.actions).length + 1, true],
);

const routed = Object.keys(boot.actions) as JobsApiAction[];
checkEqual(
  "every read is allowed",
  routed.filter(
    (action) => !JOBS_API_MUTATIONS.has(action) && !boot.actions[action],
  ),
  [],
);
checkEqual(
  "and no mutation: none names a queue or runner here",
  routed.filter(
    (action) => JOBS_API_MUTATIONS.has(action) && boot.actions[action],
  ),
  [],
);
checkEqual(
  "mode: 'both' routes every runner action",
  routed.filter((action) => action.startsWith("runners.")).sort(),
  JOBS_API_ACTIONS.filter((action) => action.startsWith("runners.")).sort(),
);
checkEqual(
  "queues.list and runners.list are true: the Queues and Runners nav entries exist",
  [can(boot, "queues.list"), can(boot, "runners.list")],
  [true, true],
);

/** The sections this UI was given: both on by default. */
const sections = ui.config.sections;

/** The queue's detail, requested the way the screen does: only with queues.read. */
async function detailFor(
  queue: string,
  permissions: PermissionsBody,
): Promise<QueueDetailDto | undefined> {
  return can(permissions, "queues.read")
    ? (await get<QueueDetailDto>(`/queues/${queue}`)).body
    : undefined;
}

// This is also the fallback: until `?queue=` answers, or if it fails, a
// queue screen shows no mutation at all. A per-queue host that answered
// `true` here would instead show buttons that the per-queue map then hides.
const detailOnBoot = await detailFor("mail", boot);
const pending = screenGates({
  meta,
  sections,
  boot,
  queue: "pending",
  detail: detailOnBoot,
});
const failed = screenGates({
  meta,
  sections,
  boot,
  queue: boot,
  detail: detailOnBoot,
});
/** The mutating gates open in `set`. */
function openMutations(set: Gates): string[] {
  return GATES.filter(
    (gate: Gate) =>
      (gate.mutations !== undefined || gate.anyMutation !== undefined) &&
      set[gate.name as GateName],
  ).map((gate) => gate.name);
}
checkEqual(
  "before ?queue= loads, or if it fails, the fallback shows no mutation",
  [openMutations(pending), openMutations(failed)],
  [[], []],
);
// The job screen does not take the fallback while the queue's map loads: it
// waits, so on payroll, whose own map says no, no job request goes out at
// all. Only a map that failed leaves the untargeted yes in charge.
checkEqual(
  "the job screen waits for ?queue= (closed while pending), and falls back only if it fails",
  [pending["job: screen"], failed["job: screen"]],
  [false, true],
);

/* ------------------------------------------------------------------ */
step("The Events console: meta.websocket and events.connect");

/** The three Events gates: the nav entry and `/events`, and its two pickers' lists. */
const EVENT_GATES = [
  "Events: nav and /events",
  "events: queue list in the queue and job pickers",
  "events: runner list in the runner picker",
] as const satisfies readonly GateName[];

/** The Events gates' values in `set`, in {@link EVENT_GATES}' order. */
function eventGates(set: Gates): boolean[] {
  return EVENT_GATES.map((name) => set[name]);
}

// This API has a socket (`websocket` left at its default), so /meta names it
// and the map carries `events.connect`, asked of `authorize` untargeted with
// `transport: "ws"`, as the upgrade asks it.
asked.length = 0;
const { body: bootAgain } = await get<PermissionsBody>("/meta/permissions");
checkEqual(
  "meta.websocket names the socket's path",
  meta.websocket?.path,
  `${api.basePath}/ws`,
);
checkEqual(
  "events.connect is in the untargeted map, and true",
  bootAgain.actions["events.connect"],
  true,
);
checkEqual(
  "authorize was asked about events.connect with no queue or runner",
  asked
    .filter((call) => call.action === "events.connect")
    .map((call) => [call.queue, call.runner]),
  [[undefined, undefined]],
);
checkEqual(
  "so the Events nav entry and both pickers' lists are on",
  eventGates(screenGates({ meta, sections, boot })),
  [true, true, true],
);
// The pickers exist only for the scopes the mode has: queue and job
// channels without runners, a runner channel without queues.
checkEqual(
  "in mode jobs only the queue list, in mode runner only the runner list",
  [
    eventGates(
      screenGates({ meta: { ...meta, mode: "jobs" }, sections, boot }),
    ),
    eventGates(
      screenGates({ meta: { ...meta, mode: "runner" }, sections, boot }),
    ),
  ],
  [
    [true, true, false],
    [true, false, true],
  ],
);
checkEqual(
  "and sections.manage off hides the Events entry with the others",
  eventGates(
    screenGates({ meta, sections: { ...sections, manage: false }, boot }),
  ),
  [false, false, false],
);

/** What {@link otherHost} read from a second API. */
interface OtherHost {
  /** Its `GET /meta`. */
  meta: MetaDto;
  /** Its untargeted `GET /meta/permissions`. */
  boot: PermissionsBody;
  /** Its OpenAPI document, when `meta.docs` names one. */
  openapi?: SpecDocument;
  /** Its AsyncAPI document, when `meta.docs` names one. */
  asyncapi?: SpecDocument;
}

/**
 * A second API over the same jobs, answered through the real pipeline: its
 * `/meta`, untargeted `/meta/permissions` and the docs `/meta` names.
 */
async function otherHost(
  basePath: string,
  options: Partial<Parameters<typeof createJobsApi>[0]>,
): Promise<OtherHost> {
  const other = createJobsApi({
    jobs,
    basePath,
    mode: "both",
    logger: noopLogger,
    authorize: () => true,
    ...options,
  });
  const otherApp = new BunHttpAdapter();
  otherApp.use(other.basePath, other.router);
  const read = async <T>(path: string) =>
    (await (await otherApp.fetch(`${basePath}${path}`)).json()) as T;
  const answer: OtherHost = {
    meta: await read<MetaDto>("/meta"),
    boot: await read<PermissionsBody>("/meta/permissions"),
  };
  // The documents' paths are full paths, basePath included.
  const docs = answer.meta.docs;
  if (docs !== null) {
    answer.openapi = await read<SpecDocument>(
      docs.openapi.slice(basePath.length),
    );
    if (docs.asyncapi !== undefined) {
      answer.asyncapi = await read<SpecDocument>(
        docs.asyncapi.slice(basePath.length),
      );
    }
  }
  await other.close();
  return answer;
}

// A host whose authorize refuses the socket. The socket still exists, so
// /meta still names it; only the map says no, and the UI shows no Events
// entry and keeps its live badge off (the server would refuse the upgrade
// with the same answer).
const refused = await otherHost("/refused-api", {
  authorize: (_req, ctx) =>
    ctx.action === "events.connect"
      ? { allow: false, reason: "no live events for you" }
      : true,
});
checkEqual(
  "authorize refuses events.connect: meta.websocket is set, events.connect false",
  [refused.meta.websocket?.path, refused.boot.actions["events.connect"]],
  ["/refused-api/ws", false],
);
checkEqual(
  "so no Events entry, and no pickers either, though the lists are allowed",
  [
    eventGates(
      screenGates({ meta: refused.meta, sections, boot: refused.boot }),
    ),
    [can(refused.boot, "queues.list"), can(refused.boot, "runners.list")],
  ],
  [
    [false, false, false],
    [true, true],
  ],
);

// A host built with `websocket: false`: no socket at all. /meta says `null`,
// and the socket's actions are absent from the map, not false.
const socketless = await otherHost("/socketless-api", { websocket: false });
checkEqual(
  "websocket: false → meta.websocket null, events.connect and events.subscribe absent",
  [
    socketless.meta.websocket,
    "events.connect" in socketless.boot.actions,
    "events.subscribe" in socketless.boot.actions,
  ],
  [null, false, false],
);
checkEqual(
  "so no Events entry: an authorize that says yes to everything cannot add one",
  eventGates(
    screenGates({ meta: socketless.meta, sections, boot: socketless.boot }),
  ),
  [false, false, false],
);

/* ------------------------------------------------------------------ */
step("The API docs: meta.docs, docs.read, and each operation's page");

// The API serves both documents unless built with `docs: false`, and names
// them in /meta by their full paths. `docs.read` guards them, and like the
// nav entries it is asked untargeted.
checkEqual("meta.docs names both documents, under the basePath", meta.docs, {
  openapi: `${api.basePath}/openapi.json`,
  asyncapi: `${api.basePath}/asyncapi.json`,
});
checkEqual(
  "docs.read is in the untargeted map, and true; meta.readOnly is false",
  [boot.actions["docs.read"], meta.readOnly],
  [true, false],
);

/** The three docs screens' gates: the nav entry, the HTTP and the WebSocket reference. */
const DOCS_GATES = [
  "Docs: nav and /docs*",
  "docs: HTTP API entry, reference and card",
  "docs: WebSocket API entry, reference and card",
] as const satisfies readonly GateName[];

/** The docs screens' gates in `set`, in {@link DOCS_GATES}' order. */
function docsGates(set: Gates): boolean[] {
  return DOCS_GATES.map((name) => set[name]);
}

checkEqual(
  "so the API docs entry and both references are on",
  docsGates(screenGates({ meta, sections, boot })),
  [true, true, true],
);
checkEqual(
  "a docs-only UI (sections.manage off) keeps every one: manage is not needed",
  docsGates(
    screenGates({ meta, sections: { manage: false, docs: true }, boot }),
  ),
  [true, true, true],
);
checkEqual(
  "sections.docs off removes them all",
  docsGates(
    screenGates({ meta, sections: { manage: true, docs: false }, boot }),
  ),
  [false, false, false],
);
// The socketless host above: no socket, so no AsyncAPI document, and /meta
// leaves the key out rather than sending null.
checkEqual(
  "websocket: false → meta.docs has openapi only (asyncapi absent, not null)",
  [
    socketless.meta.docs?.openapi,
    socketless.meta.docs !== null && "asyncapi" in socketless.meta.docs,
  ],
  ["/socketless-api/openapi.json", false],
);
checkEqual(
  "so the HTTP reference stays, and /docs/ws has no reference, only its note",
  docsGates(
    screenGates({ meta: socketless.meta, sections, boot: socketless.boot }),
  ),
  [true, true, false],
);
const docless = await otherHost("/docless-api", { docs: false });
checkEqual(
  "docs: false → meta.docs null, and docs.read absent from the map, not false",
  [docless.meta.docs, "docs.read" in docless.boot.actions],
  [null, false],
);
checkEqual(
  "so no API docs entry at all",
  docsGates(screenGates({ meta: docless.meta, sections, boot: docless.boot })),
  [false, false, false],
);
const docsRefused = await otherHost("/no-docs-api", {
  authorize: (_req, ctx) =>
    ctx.action === "docs.read"
      ? { allow: false, reason: "no docs for you" }
      : true,
});
checkEqual(
  "authorize refuses docs.read: meta.docs is still set, docs.read false, no entry",
  [
    docsRefused.meta.docs !== null,
    docsRefused.boot.actions["docs.read"],
    docsGates(
      screenGates({
        meta: docsRefused.meta,
        sections,
        boot: docsRefused.boot,
      }),
    ),
  ],
  [true, false, [false, false, false]],
);

/** A spec document as JSON. */
type SpecDocument = Record<string, unknown>;

/** A value as a plain object, or `undefined`. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Every operation of an OpenAPI document, by operationId, as a {@link DocItem}. */
function httpItems(document: SpecDocument): Map<string, DocItem> {
  const items = new Map<string, DocItem>();
  for (const pathItem of Object.values(objectOf(document.paths) ?? {})) {
    for (const [method, value] of Object.entries(objectOf(pathItem) ?? {})) {
      const operation = objectOf(value);
      if (typeof operation?.operationId !== "string") {
        continue; // `parameters`, `summary`: not an operation.
      }
      items.set(operation.operationId, {
        kind: "http",
        method: method.toUpperCase(),
        action: operation["x-bun-jobs-action"] as string | undefined,
        mutation: operation["x-bun-jobs-mutation"] === true,
      });
    }
  }
  return items;
}

const openapi = (await (
  await app.fetch(meta.docs!.openapi)
).json()) as SpecDocument;
const operations = httpItems(openapi);
show(`GET ${meta.docs!.openapi}: operations`, operations.size);

/** The four gates of an HTTP operation's page. */
const HTTP_GATES = [
  "docs http: permission marker (You have)",
  "docs http: try-it Send",
  "docs http: try-it asks first",
  "docs http: try-it needs the operationId typed",
] as const satisfies readonly GateName[];

/** An HTTP operation's page, for one caller: marker, Send, asks first, typed. */
function operationPage(
  id: string,
  inputs: Omit<ScreenInputs, "item"> = { meta, sections, boot },
): GateState[] {
  const states = screenStates({ ...inputs, item: operations.get(id)! });
  return HTTP_GATES.map((name) => states[name]);
}

checkEqual(
  "every operation names an action the contract knows, and a method the client sends",
  [...operations]
    .filter(
      ([, item]) =>
        !ACTION_NAMES.has(item.action ?? "") ||
        !METHOD_NAMES.has(item.method ?? ""),
    )
    .map(([id]) => id),
  [],
);
checkEqual(
  "and x-bun-jobs-mutation is exactly the contract's JOBS_API_MUTATIONS",
  [...operations]
    .filter(
      ([, item]) =>
        item.mutation !== JOBS_API_MUTATIONS.has(item.action as JobsApiAction),
    )
    .map(([id]) => id),
  [],
);

// This caller's untargeted map says no to every mutation (the per-queue
// answer is what says yes), so the docs show every mutation's Send
// disabled, with the reason: the one place a denied element is not absent.
checkEqual(
  "GET getQueue: You have, Send enabled, no confirmation",
  operationPage("getQueue"),
  ["open", "open", "absent", "absent"],
);
checkEqual(
  "POST pauseQueue: You lack, Send DISABLED (not absent), asks first, nothing typed",
  operationPage("pauseQueue"),
  ["lack", "disabled", "open", "absent"],
);
checkEqual(
  "DELETE removeJob: You lack, Send disabled, asks first and needs removeJob typed",
  operationPage("removeJob"),
  ["lack", "disabled", "open", "open"],
);
// A POST, but failing a job is irreversible (it is dead for good), so its
// verb asks for the operationId as a DELETE does.
checkEqual(
  "POST failJob: You lack, Send disabled, asks first and needs failJob typed",
  operationPage("failJob"),
  ["lack", "disabled", "open", "open"],
);
checkEqual(
  "while POST disableRepeatable / enableRepeatable only ask first (idempotent)",
  [operationPage("disableRepeatable"), operationPage("enableRepeatable")],
  [
    ["lack", "disabled", "open", "absent"],
    ["lack", "disabled", "open", "absent"],
  ],
);

/** The operationIds whose gate `name` is open, for `inputs`. */
function operationsWhere(
  name: GateName,
  inputs: Omit<ScreenInputs, "item">,
): string[] {
  return [...operations.keys()]
    .filter(
      (id) =>
        screenStates({ ...inputs, item: operations.get(id)! })[name] === "open",
    )
    .sort();
}

checkEqual(
  "every mutation asks first, and only mutations",
  operationsWhere("docs http: try-it asks first", { meta, sections, boot }),
  [...operations]
    .filter(([, item]) => item.mutation)
    .map(([id]) => id)
    .sort(),
);
// Seven of them are DELETEs, and five of those only because they are: their
// action's verb (clearLogs, clearHistory, defaults, configure) is not a
// destructive one. The other five are POSTs named by their verb.
checkEqual(
  "every DELETE, and every remove / drain / clean / kill / fail, needs its operationId typed",
  operationsWhere("docs http: try-it needs the operationId typed", {
    meta,
    sections,
    boot,
  }),
  [
    "cleanQueue",
    "clearJobLogs",
    "clearRunnerHistory",
    "drainQueue",
    "failJob",
    "killRunner",
    "removeJob",
    "removeJobs",
    "removeRepeatable",
    "resetJobDefaults",
    "resetRunnerConfig",
    "resetWorkerConfig",
  ],
);
checkEqual(
  "the DELETEs among them: two clears, three resets and two removals",
  [...operations]
    .filter(([, item]) => item.method === "DELETE")
    .map(([id]) => id)
    .sort(),
  [
    "clearJobLogs",
    "clearRunnerHistory",
    "removeJob",
    "removeRepeatable",
    "resetJobDefaults",
    "resetRunnerConfig",
    "resetWorkerConfig",
  ],
);

// A caller whose untargeted map says yes to everything can send every one.
const permissive = await otherHost("/open-api", {
  actions: [...JOBS_API_ACTIONS],
});
checkEqual(
  "a caller holding every action: every Send enabled (reads and mutations)",
  [...operations.keys()].filter(
    (id) =>
      operationPage(id, {
        meta: permissive.meta,
        sections,
        boot: permissive.boot,
      })[1] !== "open",
  ),
  [],
);

// A read-only API prunes its mutation routes, and its document describes
// only the routes it registered: so no Send is ever disabled *for being
// read-only* against a real API. The rule is still the UI's; shown here on
// a mutation a document might carry (the package's own tests use a fixture).
const readOnlyHost = await otherHost("/ro-docs-api", {
  readOnly: true,
  actions: [...JOBS_API_ACTIONS],
});
checkEqual(
  "readOnly: meta.readOnly true, and its OpenAPI documents no mutation at all",
  [
    readOnlyHost.meta.readOnly,
    [...httpItems(readOnlyHost.openapi!).values()].filter(
      (item) => item.mutation,
    ).length,
  ],
  [true, 0],
);
checkEqual(
  "the rule: on a read-only API a mutation's Send is disabled, even with the action",
  operationPage("removeJob", {
    meta: readOnlyHost.meta,
    sections,
    boot: permissive.boot,
  })[1],
  "disabled",
);
checkEqual(
  "with sections.docs off there is no page: Send is absent, not disabled",
  operationPage("pauseQueue", {
    meta,
    sections: { manage: true, docs: false },
    boot,
  }),
  ["absent", "absent", "absent", "absent"],
);

/** A channel parameter's `x-bun-jobs-schema`: the keywords try-it holds a value to. */
interface ParameterSchema {
  /** A pattern the value must match. */
  pattern?: string;
  /** The fewest characters (code points, as JSON Schema counts). */
  minLength?: number;
  /** The most characters (code points). */
  maxLength?: number;
}

/** One AsyncAPI channel, as try-it reads it. */
interface WsChannelInfo {
  /** The address template, e.g. `queue/{queue}`. */
  address: string;
  /** Each parameter's `x-bun-jobs-schema`, `undefined` for one without it. */
  schemas: Record<string, ParameterSchema | undefined>;
  /**
   * Whether it is the connection: it carries the WebSocket binding's upgrade
   * `method`, or its address is a socket path. The UI gives it no try-it.
   */
  connection: boolean;
}

/** The AsyncAPI document's channels and operations, as {@link DocItem}s. */
function wsItems(document: SpecDocument) {
  const channels = new Map<string, WsChannelInfo>();
  for (const [key, value] of Object.entries(
    objectOf(document.channels) ?? {},
  )) {
    const channel = objectOf(value)!;
    const address = String(channel.address ?? "");
    const upgrade = objectOf(objectOf(channel.bindings)?.ws)?.method;
    channels.set(key, {
      address,
      schemas: Object.fromEntries(
        Object.entries(objectOf(channel.parameters) ?? {}).map(
          ([name, parameter]) => [
            name,
            objectOf(objectOf(parameter)?.["x-bun-jobs-schema"]) as
              | ParameterSchema
              | undefined,
          ],
        ),
      ),
      connection:
        key === "connection" ||
        typeof upgrade === "string" ||
        address.startsWith("/"),
    });
  }
  const actions = Object.entries(objectOf(document.operations) ?? {}).map(
    ([key, value]) => [key, objectOf(value)?.["x-bun-jobs-action"]] as const,
  );
  return { channels, actions };
}

const asyncapi = (await (
  await app.fetch(meta.docs!.asyncapi!)
).json()) as SpecDocument;
const ws = wsItems(asyncapi);
show(
  `GET ${meta.docs!.asyncapi}: channels, and each operation's x-bun-jobs-action`,
  {
    channels: [...ws.channels.keys()],
    operations: Object.fromEntries(ws.actions),
  },
);

/**
 * Whether try-it refuses `value` for parameter `name`: its
 * `x-bun-jobs-schema` when the document gives one, else (an API older than
 * the extension) the client's rule, a job id anything and any other name
 * held to the contract's `NAME_PARAM_PATTERN` and `MAX_NAME_LENGTH`.
 */
function parameterRefused(
  name: string,
  value: string,
  schema: ParameterSchema | undefined,
): boolean {
  if (value === "") {
    return true;
  }
  const length = [...value].length;
  if (schema === undefined) {
    return (
      name !== "jobId" &&
      (value.length > MAX_NAME_LENGTH ||
        !new RegExp(NAME_PARAM_PATTERN).test(value))
    );
  }
  return (
    (schema.maxLength !== undefined && length > schema.maxLength) ||
    (schema.minLength !== undefined && length < schema.minLength) ||
    (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))
  );
}

/**
 * A channel's address filled the way try-it fills it: each value held to
 * {@link parameterRefused}, the job id escaped with `encodeJobId`. `null`
 * while a value is empty or refused.
 */
function fillAddress(
  channel: WsChannelInfo,
  values: Record<string, string>,
): string | null {
  let complete = true;
  const filled = channel.address.replace(
    /\{([^}]+)\}/g,
    (_match, name: string) => {
      const value = values[name] ?? "";
      complete &&= !parameterRefused(name, value, channel.schemas[name]);
      return name === "jobId" ? encodeJobId(value) : value;
    },
  );
  return complete ? filled : null;
}

/** {@link fillAddress} for the document's channel `key`. */
function fillChannel(
  key: string,
  values: Record<string, string>,
): string | null {
  return fillAddress(ws.channels.get(key)!, values);
}

/** Channel `key`'s page, as a {@link DocItem}: its address filled from `values`. */
function channelItem(
  key: string,
  values: Record<string, string> = {},
  channel: WsChannelInfo = ws.channels.get(key)!,
): DocItem {
  return {
    kind: "ws",
    address: fillAddress(channel, values),
    connection: channel.connection,
  };
}

/** A WebSocket channel's page: its try-it's two gates. */
function channelPage(
  item: DocItem,
  inputs: Omit<ScreenInputs, "item"> = { meta, sections, boot },
): GateState[] {
  const states = screenStates({ ...inputs, item });
  return [
    states["docs ws: try-it opens the Events console"],
    states["docs ws: a channel's link"],
  ];
}

checkEqual(
  "every WebSocket operation's action is one the UI knows, and this caller has it",
  ws.actions
    .filter(
      ([, action]) =>
        screenStates({
          meta,
          sections,
          boot,
          item: { kind: "ws", action: String(action) },
        })["docs ws: permission marker (You have this)"] !== "open",
    )
    .map(([key]) => key),
  [],
);
checkEqual(
  "an action the UI does not know: its own marker, not You lack this",
  screenStates({
    meta,
    sections,
    boot,
    item: { kind: "ws", action: "events.teleport" },
  })["docs ws: permission marker (You have this)"],
  "unknown",
);
checkEqual(
  "on the host refusing events.connect: the connect marker reads You lack this",
  screenStates({
    meta: refused.meta,
    sections,
    boot: refused.boot,
    item: { kind: "ws", action: "events.connect" },
  })["docs ws: permission marker (You have this)"],
  "lack",
);
checkEqual(
  "queue/{queue} with mail → queue/mail, and the link opens",
  [
    fillChannel("queue", { queue: "mail" }),
    channelPage(channelItem("queue", { queue: "mail" })),
  ],
  ["queue/mail", ["open", "open"]],
);
checkEqual(
  "a job id is escaped with encodeJobId: a/b → a%2Fb",
  fillChannel("job", { queue: "mail", jobId: "a/b" }),
  "queue/mail/job/a%2Fb",
);
checkEqual(
  "every channel parameter carries its x-bun-jobs-schema but the job id, which is anything (escaped)",
  [...ws.channels].flatMap(([key, channel]) =>
    Object.entries(channel.schemas)
      .filter(([, schema]) => schema === undefined)
      .map(([name]) => `${key}.${name}`),
  ),
  ["job.jobId"],
);
checkEqual(
  "a name its x-bun-jobs-schema refuses (..), or none: the link is DISABLED, with the reason",
  [
    channelPage(channelItem("queue", { queue: ".." })),
    channelPage(channelItem("queue", {})),
  ],
  [
    ["open", "disabled"],
    ["open", "disabled"],
  ],
);
const olderQueue: WsChannelInfo = { ...ws.channels.get("queue")!, schemas: {} };
checkEqual(
  "an older API without x-bun-jobs-schema: the client's name rule decides (mail opens; .. and a/b are disabled)",
  ["mail", "..", "a/b"].map((queue) =>
    channelPage(channelItem("queue", { queue }, olderQueue)),
  ),
  [
    ["open", "open"],
    ["open", "disabled"],
    ["open", "disabled"],
  ],
);
checkEqual(
  "the connection is the one channel carrying the ws upgrade binding or a socket path",
  [...ws.channels]
    .filter(([, channel]) => channel.connection)
    .map(([key]) => key),
  ["connection"],
);
checkEqual(
  "the connection channel has no try-it: absent, not disabled (nothing to subscribe to)",
  [
    channelPage(channelItem("connection")),
    channelPage(channelItem("connection"), {
      meta,
      sections: { manage: false, docs: true },
      boot,
    }),
  ],
  [
    ["absent", "absent"],
    ["absent", "absent"],
  ],
);
checkEqual(
  "and neither has any channel under another key that carries the upgrade binding or a socket path",
  channelPage(
    channelItem(
      "socket",
      {},
      { address: "/socket", schemas: {}, connection: true },
    ),
  ),
  ["absent", "absent"],
);
checkEqual(
  "a runner channel where meta.mode offers none (mode jobs): disabled",
  channelPage(channelItem("runner", { runner: "nightly" }), {
    meta: { ...meta, mode: "jobs" },
    sections,
    boot,
  }),
  ["open", "disabled"],
);
checkEqual(
  "without the Events console (docs-only, or events.connect refused): a note, and no link",
  [
    channelPage(channelItem("queue", { queue: "mail" }), {
      meta,
      sections: { manage: false, docs: true },
      boot,
    }),
    channelPage(channelItem("queue", { queue: "mail" }), {
      meta: refused.meta,
      sections,
      boot: refused.boot,
    }),
  ],
  [
    ["note", "absent"],
    ["note", "absent"],
  ],
);
checkEqual(
  "a WebSocket operation's page has no try-it at all",
  channelPage({ kind: "ws", address: null }).length === 2 &&
    screenStates({
      meta,
      sections,
      boot,
      item: { kind: "ws", action: "events.subscribe" },
    })["docs ws: try-it opens the Events console"],
  "absent",
);

// Disabled against absent, both ways, over every screen this step built:
// outside the docs a closed gate is always absent; inside, a denied docs
// element on a shown page is always there, disabled, a note or a marker.
const scenarios: ScreenInputs[] = [
  { meta, sections, boot },
  { meta, sections: { manage: false, docs: true }, boot },
  { meta: refused.meta, sections, boot: refused.boot },
  { meta: socketless.meta, sections, boot: socketless.boot },
  { meta: docless.meta, sections, boot: docless.boot },
].flatMap((inputs) => [
  inputs,
  ...[...operations.values()].map((item) => ({ ...inputs, item })),
  ...["queue", "connection"].map((key) => ({
    ...inputs,
    item: channelItem(key, { queue: "mail" }),
  })),
]);
checkEqual(
  `over ${scenarios.length} screens: a gate that is absent when denied is never shown disabled`,
  scenarios.flatMap((inputs) =>
    GATES.filter((gate: Gate) => (gate.denied ?? "absent") === "absent")
      .filter((gate) => !["open", "absent"].includes(gateState(gate, inputs)))
      .map((gate) => gate.name),
  ),
  [],
);
checkEqual(
  "and a docs element denied on its shown page is never absent",
  scenarios.flatMap((inputs) =>
    GATES.filter((gate: Gate) => (gate.denied ?? "absent") !== "absent")
      .filter((gate: Gate) => {
        const screen = GATES.find((other: Gate) => other.name === gate.on);
        const shown =
          (screen === undefined || isOpen(screen, inputs)) &&
          mapFor(gate, inputs) !== undefined &&
          (!gate.channelOnly || hasTryIt(inputs.item));
        return shown && gateState(gate, inputs) === "absent";
      })
      .map((gate) => gate.name),
  ),
  [],
);

/* ------------------------------------------------------------------ */
step("GET /meta/permissions?queue=…: what each queue screen shows");

const maps: Record<string, PermissionsBody> = {};
const details: Record<string, QueueDetailDto | undefined> = {};
for (const queue of ["mail", "audit", "payroll"]) {
  asked.length = 0;
  const { status, body } = await get<PermissionsBody>(
    `/meta/permissions?queue=${queue}`,
  );
  maps[queue] = body;
  details[queue] = await detailFor(queue, body);
  checkEqual(
    `?queue=${queue} → 200, the same actions as the untargeted map`,
    [status, Object.keys(body.actions).sort()],
    [200, [...routed].sort()],
  );
  check(
    `and authorize was told queue=${queue} for every queue-side action`,
    asked
      .filter(
        (call) =>
          !call.action.startsWith("meta.") &&
          !call.action.startsWith("docs.") &&
          !call.action.startsWith("events.") &&
          !call.action.startsWith("runners."),
      )
      .every((call) => call.queue === queue && call.runner === undefined),
    asked,
  );
}

/** The gates of one queue's screens, for this caller. */
function queueGates(
  queue: string,
  job?: { state: JobState },
  repeatable?: { disabled: boolean },
): Gates {
  return screenGates({
    meta,
    sections,
    boot,
    queue: maps[queue]!,
    detail: details[queue],
    job,
    repeatable,
  });
}

const gates = {
  mail: queueGates("mail"),
  audit: queueGates("audit"),
  payroll: queueGates("payroll"),
};

/**
 * Prints the gates on `maps` side by side, one column per queue or runner.
 */
function printGates(columns: Record<string, Gates>, ...maps: GateMap[]): void {
  console.table(
    Object.fromEntries(
      GATES.filter((gate: Gate) => maps.includes(gate.map)).map(({ name }) => [
        name,
        Object.fromEntries(
          Object.entries(columns).map(([target, set]) => [target, set[name]]),
        ),
      ]),
    ),
  );
}
printGates(gates, "boot", "queue");

/**
 * The gates on the untargeted map that need something no queue or runner
 * screen here passes: an analytics read's answer, a job with a worker, a
 * worker row, the unfiltered worker list, a list longer than one page. Asked
 * with them further down.
 */
const BOOT_NEEDS_INPUT = {
  "Overview: queue table pager": false,
  "runners: list pager": false,
  "workers page: server table pager": false,
  "overview: Runners busiest note": false,
  "overview: Workers busiest note": false,
  "overview: Jobs range caption": false,
  "overview: Runners range caption": false,
  "overview: Workers range caption": false,
  "overview: Jobs not kept": false,
  "overview: Runners not kept": false,
  "overview: Workers not kept": false,
  "queue: Processed by worker link": false,
  "job: Processed by worker link": false,
  "workers page: Host filter": false,
  "worker table: key links": false,
} as const satisfies Partial<Gates>;

/**
 * The other gates decided on the untargeted map: the same on every queue and
 * runner, and all open for this caller, but one: a worker page's job links
 * sit in its jobs card, which the queue's own `jobs.list` decides.
 */
const bootGates = { ...allGates(true, "boot"), ...BOOT_NEEDS_INPUT };

// mail: everything the screens offer, for a running queue.
checkEqual(
  "mail (running): every gate is open but those needing a state or data",
  onMaps(gates.mail, "boot", "queue"),
  {
    ...allGates(true, "boot", "queue"),
    ...BOOT_NEEDS_INPUT,
    // A running queue offers Pause, not Resume; checked paused below.
    "queue: Resume": false,
    // addableNames is ["send-email"], so the dialog offers that name, not a
    // search of the registered definitions.
    "queue: Add job's name suggestions": false,
    // The job gates that depend on a job's state; asked below with one.
    "job: Retry": false,
    "job: Promote": false,
    "job: Fail…": false,
    // The series gates that depend on a series' state; likewise.
    "panel=repeatables, Disable": false,
    "panel=repeatables, Enable": false,
    // Apply needs an override and pending jobs: asked below with both.
    "panel=job-defaults, Apply to N pending jobs…": false,
    // A worker page's elements that depend on its instances; likewise.
    "worker page: Edit settings…": false,
    "worker page: Reset to code values…": false,
    "worker page: Change pending": false,
    // The browser-side pagers, which need a list longer than one page: asked
    // below with row counts either side of each table's size.
    "panel=repeatables, pager": false,
    "panel=workers, pager": false,
    "worker page: instances pager": false,
  },
);

// audit: every read, no action.
checkEqual("audit: reads only", onMaps(gates.audit, "boot", "queue"), {
  ...allGates(false, "queue"),
  ...bootGates,
  "queue: header total, paused badge": true,
  "queue: jobs table": true,
  "panel=limits": true,
  "panel=workers": true,
  "panel=throughput": true,
  "panel=repeatables": true,
  "job: screen": true,
  "job: logs": true,
  "queue: Processed by column": true,
  "queue: jobs newest added first (sort=createdAt)": true,
  "worker page: jobs newest added first (sort=createdAt)": true,
  "panel=job-defaults": true,
  "job: Processed by": true,
  "worker page: instances": true,
  "worker page: Target card": true,
  "worker page: throughput and busyness": true,
  "worker page: jobs": true,
});

// payroll: authorize refuses every queue-side action, so the screen shows
// no header counts, no jobs table and no panels, and a job link shows "Job
// hidden". `queues.list` is decided on the untargeted map (it lists every
// queue), so the Overview and the list still show payroll and link to that
// empty screen.
checkEqual(
  "payroll: only what the untargeted map decides",
  onMaps(gates.payroll, "boot", "queue"),
  {
    ...allGates(false, "queue"),
    ...bootGates,
    "worker page: jobs' job links": false,
  },
);
checkEqual(
  "and no queue screen opens a runner gate",
  Object.values(gates).flatMap((set) =>
    Object.entries(onMaps(set, "runner"))
      .filter(([, open]) => open)
      .map(([name]) => name),
  ),
  [],
);
checkEqual(
  "payroll's job screen: Job hidden (no jobs.read on its map)",
  [can(boot, "jobs.read"), can(maps.payroll!, "jobs.read")],
  [true, false],
);

// The job screen's buttons depend on the job's state too.
const dead = (await get<{ state: JobState }>("/queues/mail/jobs/dead-1")).body;
const delayed = (await get<{ state: JobState }>("/queues/mail/jobs/later-1"))
  .body;
checkEqual(
  "the seeded jobs' states",
  [dead.state, delayed.state],
  ["dead", "delayed"],
);
checkEqual(
  "mail, a dead job: Retry and Remove, not Promote",
  [
    queueGates("mail", dead)["job: Retry"],
    queueGates("mail", dead)["job: Promote"],
    queueGates("mail", dead)["job: Remove"],
  ],
  [true, false, true],
);
checkEqual(
  "mail, a delayed job: Promote, not Retry",
  [
    queueGates("mail", delayed)["job: Retry"],
    queueGates("mail", delayed)["job: Promote"],
  ],
  [false, true],
);
checkEqual(
  "audit, a dead job: no Retry",
  queueGates("audit", dead)["job: Retry"],
  false,
);

/* ------------------------------------------------------------------ */
step("Fail… and Disable / Enable: decided by the map, then by state");

// The per-queue maps answer the three new actions like any other mutation:
// yes on mail, no on audit (read-only) and payroll (nothing at all).
checkEqual(
  "?queue= maps: jobs.fail, repeatables.disable, repeatables.enable",
  Object.fromEntries(
    ["mail", "audit", "payroll"].map((queue) => [
      queue,
      [
        can(maps[queue]!, "jobs.fail"),
        can(maps[queue]!, "repeatables.disable"),
        can(maps[queue]!, "repeatables.enable"),
      ],
    ]),
  ),
  {
    mail: [true, true, true],
    audit: [false, false, false],
    payroll: [false, false, false],
  },
);
checkEqual(
  "and the untargeted map says no to all three (they always name a queue)",
  [
    can(boot, "jobs.fail"),
    can(boot, "repeatables.disable"),
    can(boot, "repeatables.enable"),
  ],
  [false, false, false],
);

/** The states in which mail's job screen offers Fail…, from the gate alone. */
const failableStates = (JOB_STATES as readonly JobState[]).filter(
  (state) => queueGates("mail", { state })["job: Fail…"],
);
checkEqual(
  "mail: Fail… in every state but completed and dead, active included",
  failableStates,
  JOB_STATES.filter((state) => state !== "completed" && state !== "dead"),
);
checkEqual(
  "audit: Fail… in no state (no jobs.fail on its map)",
  JOB_STATES.filter((state) => queueGates("audit", { state })["job: Fail…"]),
  [],
);

// The API agrees, state by state: a waiting job fails, a dead one does not.
await jobs.queue("mail").add("send-email", {}, { jobId: "doomed-1" });
const doomed = (await get<{ state: JobState }>("/queues/mail/jobs/doomed-1"))
  .body;
checkEqual(
  "doomed-1 is waiting, so Fail… is offered",
  [doomed.state, queueGates("mail", doomed)["job: Fail…"]],
  ["waiting", true],
);
// The reason is required, 1 to 4,096 characters: the dialog holds it to the
// document's own schema for the body.
const failBody = objectOf(
  objectOf(
    objectOf(
      objectOf(
        objectOf(objectOf(openapi.paths)?.["/queues/{queue}/jobs/{id}/fail"])
          ?.post,
      )?.requestBody,
    )?.content,
  )?.["application/json"],
)?.schema;
checkEqual(
  "failJob's body: reason required, 1 to 4,096 characters",
  [
    objectOf(failBody)?.required,
    objectOf(objectOf(objectOf(failBody)?.properties)?.reason)?.minLength,
    objectOf(objectOf(objectOf(failBody)?.properties)?.reason)?.maxLength,
  ],
  [["reason"], 1, 4_096],
);
const failedNow = await send("POST", "/queues/mail/jobs/doomed-1/fail", {
  reason: "the address bounced",
});
const buried = (
  await get<{ state: JobState; failedReason: { message: string } | null }>(
    "/queues/mail/jobs/doomed-1",
  )
).body;
checkEqual(
  "POST /queues/mail/jobs/doomed-1/fail → 200; the job is dead, with the reason",
  [failedNow.status, buried.state, buried.failedReason?.message],
  [200, "dead", "the address bounced"],
);
checkEqual(
  "so Fail… is gone from its screen",
  queueGates("mail", buried)["job: Fail…"],
  false,
);
const again = await send("POST", "/queues/mail/jobs/dead-1/fail", {
  reason: "again",
});
checkEqual(
  "a client that fails a dead job anyway: 409 JOB_STATE_CONFLICT",
  [again.status, again.body.code],
  [409, "JOB_STATE_CONFLICT"],
);
const ghostJob = await send("POST", "/queues/mail/jobs/no-such-job/fail", {
  reason: "gone",
});
checkEqual(
  "and a job that does not exist: 404 JOB_NOT_FOUND",
  [ghostJob.status, ghostJob.body.code],
  [404, "JOB_NOT_FOUND"],
);

// A repeat series on mail: stored as a series, its next occurrence delayed.
await jobs
  .queue("mail")
  .add("send-email", {}, { repeat: { every: 3_600_000, key: "digest" } });

/** Mail's series `digest`, as the panel lists it. */
async function digest(): Promise<{
  disabled: boolean;
  nextRunAt: number | null;
}> {
  const { body } = await get<{
    items: { key: string; disabled: boolean; nextRunAt: number | null }[];
  }>("/queues/mail/repeatables");
  return body.items.find((series) => series.key === "digest")!;
}

/** The two series gates on mail for `series`: [Disable, Enable]. */
function seriesGates(queue: string, series: { disabled: boolean }): boolean[] {
  const set = queueGates(queue, undefined, series);
  return [set["panel=repeatables, Disable"], set["panel=repeatables, Enable"]];
}

const enabledSeries = await digest();
checkEqual(
  "digest is enabled, so the panel offers Disable, not Enable",
  [enabledSeries.disabled, seriesGates("mail", enabledSeries)],
  [false, [true, false]],
);
checkEqual(
  "audit, with the same series: neither (read-only)",
  [
    seriesGates("audit", { disabled: false }),
    seriesGates("audit", { disabled: true }),
  ],
  [
    [false, false],
    [false, false],
  ],
);
const disabled = await send("POST", "/queues/mail/repeatables/digest/disable");
const disabledSeries = await digest();
checkEqual(
  "POST …/digest/disable → 200 { disabled: true }; listed disabled",
  [disabled.status, disabled.body, disabledSeries.disabled],
  [200, { disabled: true }, true],
);
checkEqual("so Enable replaces Disable", seriesGates("mail", disabledSeries), [
  false,
  true,
]);
checkEqual(
  "disabling it again changes nothing (idempotent: no confirmation asked)",
  [
    (await send("POST", "/queues/mail/repeatables/digest/disable")).status,
    (await digest()).disabled,
  ],
  [200, true],
);
const enabled = await send("POST", "/queues/mail/repeatables/digest/enable");
const enabledAgain = await digest();
checkEqual(
  "POST …/digest/enable → 200 { enabled: true }; enabled, a next run scheduled",
  [
    enabled.status,
    enabled.body,
    enabledAgain.disabled,
    typeof enabledAgain.nextRunAt,
    seriesGates("mail", enabledAgain),
  ],
  [200, { enabled: true }, false, "number", [true, false]],
);
const noSeries = await send("POST", "/queues/mail/repeatables/ghost/disable");
checkEqual(
  "a series that does not exist: 404 REPEATABLE_NOT_FOUND",
  [noSeries.status, noSeries.body.code],
  [404, "REPEATABLE_NOT_FOUND"],
);

/* ------------------------------------------------------------------ */
step("The server's 403 is authoritative: a client that tries anyway");

// mail: allowed, and it happens.
const paused = await send("POST", "/queues/mail/pause");
checkEqual("POST /queues/mail/pause → 200", paused.status, 200);
checkEqual(
  "and the queue is paused",
  (await get<{ paused: boolean }>("/queues/mail")).body.paused,
  true,
);
// The screen reads the detail again (every 15 s, and at once after its own
// click), and the paused flag swaps the button.
details.mail = await detailFor("mail", maps.mail!);
checkEqual(
  "mail (paused): Resume replaces Pause",
  [queueGates("mail")["queue: Pause"], queueGates("mail")["queue: Resume"]],
  [false, true],
);
checkEqual(
  "audit reads its detail too, but may do neither",
  [queueGates("audit")["queue: Pause"], queueGates("audit")["queue: Resume"]],
  [false, false],
);
await send("POST", "/queues/mail/resume");
details.mail = await detailFor("mail", maps.mail!);
checkEqual(
  "resumed: Pause again",
  [queueGates("mail")["queue: Pause"], queueGates("mail")["queue: Resume"]],
  [true, false],
);

// audit: the button is hidden, but a script can still send the request. The
// API asks `authorize` with the real target and refuses it.
const denied: [string, string, unknown?][] = [
  ["POST", "/queues/audit/pause"],
  ["POST", "/queues/audit/drain", { delayed: false }],
  ["POST", "/queues/audit/clean", { state: "dead", olderThan: 0, limit: 10 }],
  ["POST", "/queues/audit/jobs/retry-all", { state: "dead" }],
  ["POST", "/queues/audit/jobs/dead-1/retry"],
  ["DELETE", "/queues/audit/jobs/dead-1"],
  ["POST", "/queues/audit/jobs/retry", { ids: ["dead-1"] }],
  ["POST", "/queues/audit/jobs/remove", { ids: ["dead-1"] }],
  ["POST", "/queues/audit/jobs/promote", { ids: ["later-1"] }],
  ["POST", "/queues/audit/jobs", { name: "send-email", data: {} }],
  ["PATCH", "/queues/audit/jobs/later-1", { priority: 3 }],
  ["PUT", "/queues/audit/limits", { concurrency: 1 }],
  ["POST", "/queues/audit/jobs/waiting-1/fail", { reason: "no" }],
  ["POST", "/queues/audit/repeatables/digest/disable"],
  ["POST", "/queues/audit/repeatables/digest/enable"],
];
for (const [method, path, body] of denied) {
  const answer = await send(method, path, body);
  checkEqual(
    `${method} ${path} → 403 FORBIDDEN`,
    [answer.status, answer.body.code, answer.body.detail],
    [403, "FORBIDDEN", "read-only on audit"],
  );
}
const audit = await jobs.queue("audit").count();
checkEqual(
  "and audit is untouched",
  [
    await jobs.queue("audit").isPaused(),
    audit.dead,
    audit.delayed,
    audit.waiting,
  ],
  [false, 1, 1, 1],
);

// payroll: even reads.
for (const path of [
  "/queues/payroll",
  "/queues/payroll/jobs",
  "/queues/payroll/jobs/dead-1",
]) {
  const answer = await app.fetch(`${api.basePath}${path}`);
  const body = (await answer.json()) as { code?: string };
  checkEqual(
    `GET ${path} → 403`,
    [answer.status, body.code],
    [403, "FORBIDDEN"],
  );
}

// The map is advisory in the other direction too. It said mail may remove
// jobs, because it is never asked about a particular job. The request is.
checkEqual(
  "the mail map allows jobs.remove",
  maps.mail!.actions["jobs.remove"],
  true,
);
const vip = await send("DELETE", "/queues/mail/jobs/vip-1");
checkEqual(
  "DELETE /queues/mail/jobs/vip-1 → 403 all the same",
  [vip.status, vip.body.detail],
  [403, "vip jobs are managed by the on-call team"],
);
const vipFail = await send("POST", "/queues/mail/jobs/vip-1/fail", {
  reason: "no",
});
checkEqual(
  "POST /queues/mail/jobs/vip-1/fail → 403 too: the map's jobs.fail is advisory",
  [vipFail.status, vipFail.body.detail],
  [403, "vip jobs are managed by the on-call team"],
);
check(
  "and the job is still there, still delayed",
  (await jobs.queue("mail").getJob("vip-1"))?.state === "delayed",
);

/* ------------------------------------------------------------------ */
step("GET /runners: which runners are local");

// The list says `isLocal`, as the runner itself does, beside which the runner
// has a `local` block (its instance's status and the runs in flight in this
// process). A runner registered only by another process has no block. The
// list's own `local` is a deprecated copy of `isLocal`.
const list = (await get<RunnerListDto>("/runners")).body;
checkEqual(
  "the list: local runners first, then the ids only the driver knows",
  list.items.map((item) => [item.id, item.isLocal]),
  [
    // `runners.list` is untargeted, so vault is listed too, and its row
    // links to a screen that says "Runner hidden".
    ["nightly", true],
    ["ledger", true],
    ["vault", true],
    ["remote-sync", false],
  ],
);
/** The runner ids this example uses, in the list's order. */
const RUNNERS = ["nightly", "ledger", "vault", "remote-sync"] as const;

/** One runner, requested the way the screen does: only with runners.read. */
async function runnerFor(
  id: string,
  permissions: PermissionsBody,
): Promise<RunnerInfoDto | undefined> {
  return can(permissions, "runners.read")
    ? (await get<RunnerInfoDto>(`/runners/${id}`)).body
    : undefined;
}

const nightlyInfo = (await get<RunnerInfoDto>("/runners/nightly")).body;
const remoteInfo = (await get<RunnerInfoDto>("/runners/remote-sync")).body;
show("GET /runners/nightly: isLocal, local", {
  isLocal: nightlyInfo.isLocal,
  local: nightlyInfo.local,
});
checkEqual(
  "nightly: isLocal, local.status running (started), no run in flight",
  [
    nightlyInfo.isLocal,
    nightlyInfo.local?.status,
    nightlyInfo.local?.activeRuns.length,
  ],
  [true, "running", 0],
);
checkEqual(
  "remote-sync: not local, and no local block at all",
  [remoteInfo.isLocal, "local" in remoteInfo],
  [false, false],
);

/* ------------------------------------------------------------------ */
step("GET /meta/permissions?runner=…: what each runner screen shows");

const runnerMaps: Record<string, PermissionsBody> = {};
const runnerInfos: Record<string, RunnerInfoDto | undefined> = {};
for (const id of RUNNERS) {
  asked.length = 0;
  const { status, body } = await get<PermissionsBody>(
    `/meta/permissions?runner=${id}`,
  );
  runnerMaps[id] = body;
  checkEqual(
    `?runner=${id} → 200, the same actions as the untargeted map`,
    [status, Object.keys(body.actions).sort()],
    [200, [...routed].sort()],
  );
  check(
    `and authorize was told runner=${id} for every runner action, and no queue`,
    asked
      .filter((call) => call.action.startsWith("runners."))
      .every((call) => call.runner === id && call.queue === undefined),
    asked,
  );
}

/** Every runner action, and whether `permissions` allows it. */
function runnerActions(permissions: PermissionsBody): Record<string, boolean> {
  return Object.fromEntries(
    routed
      .filter((action) => action.startsWith("runners."))
      .sort()
      .map((action) => [action, can(permissions, action)]),
  );
}
/** Every runner action set to `value`, reads to `reads`. */
function runnerActionsAll(
  value: boolean,
  reads = value,
): Record<string, boolean> {
  return Object.fromEntries(
    routed
      .filter((action) => action.startsWith("runners."))
      .sort()
      .map((action) => [
        action,
        JOBS_API_MUTATIONS.has(action) ? value : reads,
      ]),
  );
}
show("?runner=ledger", runnerActions(runnerMaps.ledger!));
checkEqual(
  "nightly: every runner action",
  runnerActions(runnerMaps.nightly!),
  runnerActionsAll(true),
);
checkEqual(
  "ledger: runners.list and runners.read, no mutation",
  runnerActions(runnerMaps.ledger!),
  runnerActionsAll(false, true),
);
checkEqual(
  "vault: no runner action at all, not even runners.list",
  runnerActions(runnerMaps.vault!),
  runnerActionsAll(false),
);
checkEqual(
  "remote-sync: every runner action (the map is not asked where it runs)",
  runnerActions(runnerMaps["remote-sync"]!),
  runnerActionsAll(true),
);

/** The gates of one runner's screen, for this caller, read fresh. */
async function runnerGates(id: string): Promise<Gates> {
  runnerInfos[id] = await runnerFor(id, runnerMaps[id]!);
  return screenGates({
    meta,
    sections,
    boot,
    runnerMap: runnerMaps[id]!,
    runner: runnerInfos[id],
  });
}

const runnerColumns: Record<(typeof RUNNERS)[number], Gates> = {
  nightly: await runnerGates("nightly"),
  ledger: await runnerGates("ledger"),
  vault: await runnerGates("vault"),
  "remote-sync": await runnerGates("remote-sync"),
};
printGates(runnerColumns, "boot", "runner");

checkEqual(
  "vault: Runner hidden, so the runner was never requested",
  runnerInfos.vault,
  undefined,
);
checkEqual(
  "nightly (local, running, nothing in flight): all but Resume…, Kill…, the remote hint and a run's",
  onMaps(runnerColumns.nightly, "boot", "runner"),
  {
    ...allGates(true, "boot", "runner"),
    ...BOOT_NEEDS_INPUT,
    // No queue map on a runner screen, so no worker page jobs card.
    "worker page: jobs' job links": false,
    // A run's elements: asked below with the run.
    "runner: a run's Log button": false,
    "runner: N lines dropped": false,
    "runner: Resume…": false,
    "runner: Kill…": false,
    "runner: non-local hint": false,
    // Its history pager: asked below with a fetch longer than one page.
    "runner: history pager": false,
  },
);
checkEqual(
  "ledger (local): reads only",
  onMaps(runnerColumns.ledger, "boot", "runner"),
  {
    ...allGates(false, "runner"),
    ...bootGates,
    "worker page: jobs' job links": false,
    "runner: screen": true,
    "runner: stats and history": true,
    "runner: active runs": true,
    "runner: run log and Log column": true,
    "runner: summary's override rows": true,
  },
);
checkEqual(
  "vault: only what the untargeted map decides",
  onMaps(runnerColumns.vault, "boot", "runner"),
  {
    ...allGates(false, "runner"),
    ...bootGates,
    "worker page: jobs' job links": false,
  },
);
checkEqual(
  "remote-sync: no active runs, Kill… or Reset stats…, but the remote hint and Clear history…",
  onMaps(runnerColumns["remote-sync"], "boot", "runner"),
  {
    ...allGates(true, "boot", "runner"),
    ...BOOT_NEEDS_INPUT,
    "worker page: jobs' job links": false,
    "runner: a run's Log button": false,
    "runner: N lines dropped": false,
    "runner: active runs": false,
    "runner: Resume…": false,
    "runner: Kill…": false,
    "runner: Reset stats…": false,
    "runner: history pager": false,
  },
);
checkEqual(
  "and no runner screen opens a queue gate",
  Object.values(runnerColumns).flatMap((set) =>
    Object.entries(onMaps(set, "queue"))
      .filter(([, open]) => open)
      .map(([name]) => name),
  ),
  [],
);

// Like the job screen, the runner screen waits for its own map: vault is
// never requested, although the untargeted map says yes to runners.read.
const runnerPending = screenGates({
  meta,
  sections,
  boot,
  runnerMap: "pending",
});
const runnerFailed = screenGates({ meta, sections, boot, runnerMap: boot });
checkEqual(
  "the runner screen waits for ?runner= (closed while pending), and falls back only if it fails",
  [
    can(boot, "runners.read"),
    runnerPending["runner: screen"],
    runnerFailed["runner: screen"],
  ],
  [true, false, true],
);

/* ------------------------------------------------------------------ */
step("A run in flight offers Kill…, a paused runner Resume…");

const triggered = await send("POST", "/runners/nightly/trigger");
checkEqual(
  "POST /runners/nightly/trigger → 202 started",
  [triggered.status, (triggered.body as { outcome?: string }).outcome],
  [202, "started"],
);
/** How many runs `id` has in flight in the API's process. */
async function inFlight(id: string): Promise<number> {
  const { body } = await get<RunnerInfoDto>(`/runners/${id}`);
  return body.local?.activeRuns.length ?? 0;
}
await waitFor(
  "nightly's run to be in flight",
  async () => (await inFlight("nightly")) === 1,
);
checkEqual(
  "in flight here: Kill… is offered",
  (await runnerGates("nightly"))["runner: Kill…"],
  true,
);
const killed = await send("POST", "/runners/nightly/kill", { wait: true });
checkEqual(
  "POST /runners/nightly/kill { wait: true } → 200, naming the run",
  [killed.status, (killed.body as { runIds?: string[] }).runIds?.length],
  [200, 1],
);
const history = await get<{ items: unknown[] }>("/runners/nightly/history");
const stats = await get<{ killed: number }>("/runners/nightly/stats");
checkEqual(
  "settled: Kill… is gone, and the history and stats have the run",
  [
    (await runnerGates("nightly"))["runner: Kill…"],
    history.body.items.length,
    stats.body.killed,
  ],
  [false, 1, 1],
);

for (const id of ["nightly", "remote-sync"]) {
  const paused = await send("POST", `/runners/${id}/pause`);
  const view = await runnerGates(id);
  checkEqual(
    `POST /runners/${id}/pause → 200; isPaused, and Resume… replaces Pause`,
    [
      paused.status,
      runnerInfos[id]?.isPaused,
      view["runner: Pause"],
      view["runner: Resume…"],
    ],
    [200, true, false, true],
  );
  await send("POST", `/runners/${id}/resume`);
  checkEqual(
    `resumed: Pause again`,
    (await runnerGates(id))["runner: Pause"],
    true,
  );
}

/* ------------------------------------------------------------------ */
step("The server's answer is authoritative for runners too");

// ledger: every button is hidden; a script that sends them anyway is refused
// by the same authorize, with the real runner.
const runnerDenied: [string, string, unknown?][] = [
  ["POST", "/runners/ledger/trigger"],
  ["POST", "/runners/ledger/pause"],
  ["POST", "/runners/ledger/resume"],
  ["PUT", "/runners/ledger/schedule", { schedule: null }],
  ["POST", "/runners/ledger/kill"],
  ["POST", "/runners/ledger/stats/reset"],
];
for (const [method, path, body] of runnerDenied) {
  const answer = await send(method, path, body);
  checkEqual(
    `${method} ${path} → 403 FORBIDDEN`,
    [answer.status, answer.body.code, answer.body.detail],
    [403, "FORBIDDEN", "read-only on ledger"],
  );
}
const ledger = (await get<RunnerInfoDto>("/runners/ledger")).body;
checkEqual(
  "and ledger is untouched",
  [ledger.isPaused, ledger.schedule, ledger.stats.total],
  [false, nightlyInfo.schedule, 0],
);

// vault: even reads.
for (const path of [
  "/runners/vault",
  "/runners/vault/stats",
  "/runners/vault/history",
]) {
  const answer = await app.fetch(`${api.basePath}${path}`);
  const body = (await answer.json()) as { code?: string; detail?: string };
  checkEqual(
    `GET ${path} → 403`,
    [answer.status, body.code, body.detail],
    [403, "FORBIDDEN", "vault is restricted"],
  );
}

// remote-sync: the map allows kill and resetStats (it is not asked where the
// runner runs), but only the process running a run can stop it.
for (const path of [
  "/runners/remote-sync/kill",
  "/runners/remote-sync/stats/reset",
]) {
  const answer = await send("POST", path);
  checkEqual(
    `POST ${path} → 409 RUNNER_NOT_LOCAL`,
    [answer.status, answer.body.code],
    [409, "RUNNER_NOT_LOCAL"],
  );
}

// A runner nothing knows: "Runner not found".
const ghost = await app.fetch(`${api.basePath}/runners/ghost`);
checkEqual(
  "GET /runners/ghost → 404 RUNNER_NOT_FOUND",
  [ghost.status, ((await ghost.json()) as { code?: string }).code],
  [404, "RUNNER_NOT_FOUND"],
);

/* ------------------------------------------------------------------ */
step("readOnly: every mutation is absent from the map, not false");

const readOnlyApi = createJobsApi({
  jobs,
  basePath: "/ro-api",
  mode: "both",
  actions: [...JOBS_API_ACTIONS],
  readOnly: true,
  authorize: () => true,
  logger: noopLogger,
});
const readOnlyApp = new BunHttpAdapter();
readOnlyApp.use(readOnlyApi.basePath, readOnlyApi.router);
const roMeta = (await (
  await readOnlyApp.fetch("/ro-api/meta")
).json()) as MetaDto;
const roMap = (await (
  await readOnlyApp.fetch("/ro-api/meta/permissions?queue=mail")
).json()) as PermissionsBody;
checkEqual(
  "meta.readOnly, addableNames",
  [roMeta.readOnly, roMeta.addableNames],
  [true, []],
);
checkEqual(
  "no mutation is in the map at all",
  Object.keys(roMap.actions).filter((action) =>
    JOBS_API_MUTATIONS.has(action as JobsApiAction),
  ),
  [],
);
checkEqual(
  "so the queue screens offer none: the same gates as audit",
  onMaps(
    screenGates({
      meta: roMeta,
      sections,
      boot: roMap,
      queue: roMap,
      detail: (await (
        await readOnlyApp.fetch("/ro-api/queues/mail")
      ).json()) as QueueDetailDto,
    }),
    "boot",
    "queue",
  ),
  onMaps(gates.audit, "boot", "queue"),
);
const roRunnerMap = (await (
  await readOnlyApp.fetch("/ro-api/meta/permissions?runner=nightly")
).json()) as PermissionsBody;
checkEqual(
  "and the runner screen none: nightly, read-only, gates as ledger does",
  onMaps(
    screenGates({
      meta: roMeta,
      sections,
      boot: roMap,
      runnerMap: roRunnerMap,
      runner: (await (
        await readOnlyApp.fetch("/ro-api/runners/nightly")
      ).json()) as RunnerInfoDto,
    }),
    "boot",
    "runner",
  ),
  onMaps(runnerColumns.ledger, "boot", "runner"),
);
const roPause = await readOnlyApp.fetch("/ro-api/queues/mail/pause", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
const roBody = (await roPause.json()) as { code?: string };
show(`POST /ro-api/queues/mail/pause → ${roPause.status}`, roBody.code);
checkEqual("and the route itself does not exist", roPause.status, 404);
await readOnlyApi.close();

/* ------------------------------------------------------------------ */
step("Clean…'s default limit is /meta's limits.defaultClean");

// The Clean dialog pre-fills its Limit with `limits.defaultClean`, which is
// the very default the API applies to a clean sent without one: 1,000, or
// `maxClean` when that is lower.
checkEqual(
  "here: defaultClean is 1,000, below maxClean",
  [meta.limits.defaultClean, meta.limits.maxClean >= 1_000],
  [1_000, true],
);

// A second API over the same jobs with a tiny cap, so the default is
// visibly the cap and a clean without a limit can be counted.
const smallApi = createJobsApi({
  jobs,
  basePath: "/small-api",
  mode: "jobs",
  limits: { maxClean: 3 },
  authorize: () => true,
  logger: noopLogger,
});
const smallApp = new BunHttpAdapter();
smallApp.use(smallApi.basePath, smallApi.router);
const smallMeta = (await (
  await smallApp.fetch("/small-api/meta")
).json()) as MetaDto;
checkEqual(
  "limits: { maxClean: 3 } → /meta says maxClean 3, defaultClean 3",
  [smallMeta.limits.maxClean, smallMeta.limits.defaultClean],
  [3, 3],
);

// Five completed jobs in a queue of their own.
const tidy = jobs.queue("tidy");
for (let index = 0; index < 5; index++) {
  await tidy.add("report", { index });
}
const tidyWorker = jobs.worker("tidy", async () => "done");
void tidyWorker.run();
await waitFor(
  "five jobs to complete",
  async () => (await tidy.count()).completed === 5,
);
await tidyWorker.close({ timeout: 1_000 });
// `olderThan: 0` keeps jobs finished before now; let the clock move past
// the last one.
await Bun.sleep(5);

/** A clean on the small API, as the dialog would send it. */
async function smallClean(body: object) {
  const response = await smallApp.fetch("/small-api/queues/tidy/clean", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as { count?: number },
  };
}
const cleaned = await smallClean({ state: "completed", olderThan: 0 });
checkEqual(
  "POST clean with no limit removes defaultClean (3) of 5",
  [cleaned.status, cleaned.body.count, (await tidy.count()).completed],
  [200, smallMeta.limits.defaultClean, 5 - smallMeta.limits.defaultClean],
);
checkEqual(
  "and a limit above maxClean is refused, as the dialog refuses it",
  (await smallClean({ state: "completed", olderThan: 0, limit: 4 })).status,
  400,
);
await smallApi.close();

/* ------------------------------------------------------------------ */
step("The new actions, on each map: per queue and per runner");

/** The queue-side actions this round added, every one a mutation. */
const NEW_QUEUE_MUTATIONS = [
  "queues.defaults",
  "queues.applyDefaults",
  "workers.pause",
  "workers.resume",
  "workers.stop",
  "workers.start",
  "workers.configure",
  "jobs.clearLogs",
] as const satisfies readonly JobsApiAction[];

/** The runner actions it added: two mutations and a read. */
const NEW_RUNNER_ACTIONS = [
  "runners.configure",
  "runners.clearHistory",
  "runners.logs",
] as const satisfies readonly JobsApiAction[];

checkEqual(
  "they are mutations, but runners.logs, which is a read",
  [...NEW_QUEUE_MUTATIONS, ...NEW_RUNNER_ACTIONS].filter(
    (action) => !JOBS_API_MUTATIONS.has(action),
  ),
  ["runners.logs"],
);
checkEqual(
  "?queue= maps: yes on mail, no on audit (read-only) and payroll, and no untargeted",
  Object.fromEntries(
    [
      ...["mail", "audit", "payroll"].map(
        (queue) => [queue, maps[queue]!] as const,
      ),
      ["untargeted", boot] as const,
    ].map(([target, map]) => [
      target,
      NEW_QUEUE_MUTATIONS.map((action) => can(map, action)),
    ]),
  ),
  {
    mail: NEW_QUEUE_MUTATIONS.map(() => true),
    audit: NEW_QUEUE_MUTATIONS.map(() => false),
    payroll: NEW_QUEUE_MUTATIONS.map(() => false),
    untargeted: NEW_QUEUE_MUTATIONS.map(() => false),
  },
);
checkEqual(
  "?runner= maps: configure, clearHistory, logs (logs is a read: ledger has it)",
  Object.fromEntries(
    RUNNERS.map((id) => [
      id,
      NEW_RUNNER_ACTIONS.map((action) => can(runnerMaps[id]!, action)),
    ]),
  ),
  {
    nightly: [true, true, true],
    ledger: [false, false, true],
    vault: [false, false, false],
    "remote-sync": [true, true, true],
  },
);

/* ------------------------------------------------------------------ */
step("Worker controls: the queue's map decides, not the Workers page's");

// Two workers with stable keys, reporting every second. The mailer logs a
// line for each job, for the job screen's Clear logs… below.
const mailWorker = jobs.worker(
  "mail",
  async (job) => {
    await job.log("handed to the SMTP relay");
    return "sent";
  },
  {
    key: "mailer",
    reportInterval: 1_000,
    pollInterval: 10,
    waitToExit: false,
    logger: noopLogger,
  },
);
void mailWorker.run();
const auditWorker = jobs.worker("audit", async () => "filed", {
  key: "auditor",
  reportInterval: 1_000,
  pollInterval: 10,
  waitToExit: false,
  logger: noopLogger,
});
void auditWorker.run();

// One job each finished, so both report their counts.
await jobs.queue("mail").add("send-email", {}, { jobId: "logged-1" });
await waitFor(
  "logged-1 to complete, and both workers to report a completed job",
  async () => {
    const items = (await get<WorkerListDto>("/workers")).body.items;
    return (
      items.length === 2 && items.every((worker) => (worker.completed ?? 0) > 0)
    );
  },
);

/** `GET /workers`, unfiltered: what the Workers page lists and filters from. */
const workerList = (await get<WorkerListDto>("/workers")).body.items;
const mailer = workerList.find((worker) => worker.key === "mailer")!;
const auditor = workerList.find((worker) => worker.key === "auditor")!;
show(
  "GET /workers: key, queue, state, control, counts, host",
  workerList.map((worker) => ({
    key: worker.key,
    queue: worker.queue,
    state: worker.state,
    control: worker.control,
    completed: worker.completed,
    host: worker.host !== undefined,
  })),
);

/** The six gates of one worker row: its five actions and the table's column. */
const WORKER_ROW_GATES = [
  "worker: Pause",
  "worker: Resume",
  "worker: Stop…",
  "worker: Start",
  "worker: Settings…",
  "worker table: Actions column",
] as const satisfies readonly GateName[];

/** One worker row's gates, decided on `workerMap`, in a table of `table`. */
function workerRow(
  worker: WorkerDto,
  workerMap: PermissionsBody,
  table: readonly WorkerDto[] = [worker],
  extra: Partial<ScreenInputs> = {},
): Gates {
  return screenGates({
    meta,
    sections,
    boot,
    workerMap,
    worker,
    workerTable: table,
    workerList,
    ...extra,
  });
}

/** {@link WORKER_ROW_GATES} in `set`, in order. */
function rowView(set: Gates): boolean[] {
  return WORKER_ROW_GATES.map((name) => set[name]);
}

checkEqual(
  "both report a key, control.enabled, a host, and counts",
  [mailer, auditor].map((worker) => [
    worker.key,
    worker.state,
    worker.control?.enabled,
    worker.host !== undefined,
    worker.completed! > 0,
  ]),
  [
    ["mailer", "running", true, true, true],
    ["auditor", "running", true, true, true],
  ],
);
checkEqual(
  "/workers (the untargeted map, no mutation): no action on either row, and no Actions column",
  [
    rowView(workerRow(mailer, boot, workerList)),
    rowView(workerRow(auditor, boot, workerList)),
  ],
  [
    [false, false, false, false, false, false],
    [false, false, false, false, false, false],
  ],
);
const workersPage = workerRow(mailer, boot, workerList);
checkEqual(
  "but its own elements: queue links, filters, the Host filter (hosts exposed), key links, Completed / Failed",
  [
    workersPage["Workers: nav and /workers"],
    workersPage["workers page: queue links"],
    workersPage["workers page: Queue, Service and State filters"],
    workersPage["workers page: Host filter"],
    workersPage["worker table: key links"],
    workersPage["worker table: Completed / Failed columns"],
  ],
  [true, true, true, true, true, true],
);
// The Memory column: two conditions, one of them the table's own. Both real
// workers here report `rssBytes` (it rides the heartbeat), so the only thing
// left to decide is whether the table asked.
checkEqual(
  "both report their process's resident memory",
  [mailer, auditor].map((worker) => typeof worker.rssBytes),
  ["number", "number"],
);
checkEqual(
  "the Memory column: the Workers page asks and somebody reports; a queue's Workers panel never asks; a table of workers reporting none has no column even where it is asked for",
  [
    workerRow(mailer, boot, workerList, { workerTableMemory: true })[
      "worker table: Memory column"
    ],
    workerRow(mailer, maps.mail!)["worker table: Memory column"],
    workerRow(
      mailer,
      boot,
      workerList.map(({ rssBytes: _rssBytes, ...rest }) => rest),
      { workerTableMemory: true },
    )["worker table: Memory column"],
  ],
  [true, false, false],
);
// The target badge: the row's own worker decides, on every worker table.
// Both real workers run a function in their own process, so both report
// `in-process`; the worker too old to say is the mailer's own DTO with the
// field taken out, the way the Memory column's case is made above.
checkEqual(
  "both report where their attempts run: in process, a function",
  [mailer, auditor].map((worker) => worker.target),
  [
    { kind: "in-process", processor: "function" },
    { kind: "in-process", processor: "function" },
  ],
);
/** `worker` as one too old to report a target wrote it: no `target` at all. */
function withoutTarget(worker: WorkerDto): WorkerDto {
  const { target: _target, ...rest } = worker;
  return rest;
}
/**
 * The badge's gate on each worker table, for `mailer` and `auditor` as `make`
 * makes them: the Workers page (untargeted map), mail's Workers panel, audit's
 * (read-only) Workers panel, and a worker page's Instances table.
 */
function targetBadge(make: (worker: WorkerDto) => WorkerDto): boolean[] {
  const [mail, audit] = [make(mailer), make(auditor)];
  return [
    workerRow(mail, boot, [mail, audit], { workerTableMemory: true }),
    workerRow(mail, maps.mail!, [mail], { workerTableQueuePanel: true }),
    workerRow(audit, maps.audit!, [audit], { workerTableQueuePanel: true }),
    workerRow(mail, maps.mail!, [mail], { workerTableMemory: true }),
  ].map((set) => set["worker table: target badge"]);
}
checkEqual(
  "the target badge: on all three worker tables for a worker reporting target, read-only audit's panel included; on none of them for one too old to report it (absent is not in-process)",
  [targetBadge((worker) => worker), targetBadge(withoutTarget)],
  [
    [true, true, true, true],
    [false, false, false, false],
  ],
);
// The housekeeping note, on a queue's Workers panel. Both workers here take
// part in housekeeping (`maintenance` defaults to on), so the panel is quiet;
// the cases that matter are derived from their real DTOs, the way the Memory
// column's are.
checkEqual(
  "both report that they take part in the queue's housekeeping (maintenance is on by default)",
  [mailer, auditor].map((worker) => worker.sweeps),
  [true, true],
);
/** The note's gate for a queue's Workers panel listing `table`. */
function sweepNote(table: readonly WorkerDto[]): boolean {
  return workerRow(table[0]!, maps.mail!, table, {
    workerTableQueuePanel: true,
  })["worker table: housekeeping note"];
}
/** The mailer having opted out of housekeeping (`maintenance: false`). */
const optedOut: WorkerDto = { ...mailer, sweeps: false };
/** The mailer as a worker too old to report the field wrote it: no `sweeps` at all. */
const tooOldToSay: WorkerDto = (({ sweeps: _sweeps, ...rest }) => rest)(mailer);
checkEqual(
  "the note: shown where a live worker reports sweeps:false and none reports true; gone as soon as one takes part; nothing at all where every live worker is too old to say (absent is not false); shown, hedged, where some omit it; and never outside a queue's panel",
  [
    sweepNote([optedOut]),
    sweepNote([optedOut, mailer]),
    sweepNote([mailer]),
    sweepNote([tooOldToSay]),
    sweepNote([tooOldToSay, optedOut]),
    workerRow(optedOut, boot, [optedOut], { workerTableMemory: true })[
      "worker table: housekeeping note"
    ],
  ],
  [true, false, false, false, true, false],
);
checkEqual(
  "a worker list whose workers carry no host (serialize.exposeHosts off): no Host filter",
  workerRow(mailer, boot, workerList, {
    workerList: workerList.map(({ host: _host, ...rest }) => rest),
  })["workers page: Host filter"],
  false,
);
checkEqual(
  "mail's Workers panel (mail's map): Pause, Stop… and Settings… on the running worker, and the column",
  rowView(workerRow(mailer, maps.mail!)),
  [true, false, true, false, true, true],
);
checkEqual(
  "audit's Workers panel (audit's map): nothing, and no Actions column",
  rowView(workerRow(auditor, maps.audit!)),
  [false, false, false, false, false, false],
);
checkEqual(
  "Stop…'s persistence: not overridable here, so the dialog states control.stopPersistence",
  [
    mailer.control?.stopPersistenceOverridable,
    mailer.control?.stopPersistence,
    workerRow(mailer, maps.mail!)["worker: Stop… persistence choice"],
    workerRow(
      {
        ...mailer,
        control: { ...mailer.control!, stopPersistenceOverridable: true },
      },
      maps.mail!,
    )["worker: Stop… persistence choice"],
  ],
  [false, "process", false, true],
);
checkEqual(
  "the rule on a worker that stopped reporting: no lifecycle action, but Settings… stays",
  rowView(workerRow({ ...mailer, stale: true }, maps.mail!)),
  [false, false, false, false, true, true],
);
checkEqual(
  "and on one that does not listen (control.enabled false): nothing at all",
  rowView(
    workerRow(
      { ...mailer, control: { ...mailer.control!, enabled: false } },
      maps.mail!,
    ),
  ),
  [false, false, false, false, false, false],
);
checkEqual(
  "a worker reporting control.pending shows Change pending; mailer does not",
  [
    workerRow(mailer, maps.mail!)["worker: Change pending"],
    workerRow(
      { ...mailer, control: { ...mailer.control!, pending: true } },
      maps.mail!,
    )["worker: Change pending"],
  ],
  [false, true],
);

/** A worker instruction, as a row sends it: `?wait=2000` for the acknowledgement. */
async function instruct(
  queue: string,
  worker: WorkerDto,
  action: "pause" | "resume" | "stop" | "start",
  wait = true,
) {
  return send<WorkerControlResultDto>(
    "POST",
    `/queues/${queue}/workers/${encodeURIComponent(worker.id)}/${action}${wait ? "?wait=2000" : ""}`,
  );
}

const pausedWorker = await instruct("mail", mailer, "pause");
checkEqual(
  "POST …/workers/<mailer>/pause?wait=2000 → 200, applied: the toast says Paused, not Asked to pause",
  [
    pausedWorker.status,
    pausedWorker.body.applied,
    workerRow(mailer, maps.mail!, [mailer], {
      controlResult: { applied: pausedWorker.body.applied === true },
    })["worker: instruction says done (applied)"],
  ],
  [200, true, true],
);
const { body: mailWorkers } = await get<WorkerListDto>("/queues/mail/workers");
const mailerPaused = mailWorkers.items[0]!;
checkEqual(
  "the listing reads paused: Resume and Stop… replace Pause",
  [mailerPaused.state, rowView(workerRow(mailerPaused, maps.mail!))],
  ["paused", [false, true, true, false, true, true]],
);
const resumedWorker = await instruct("mail", mailerPaused, "resume");
checkEqual(
  "POST …/resume?wait=2000 → 200, applied; running again",
  [
    resumedWorker.status,
    resumedWorker.body.applied,
    (await get<WorkerListDto>("/queues/mail/workers")).body.items[0]?.state,
  ],
  [200, true, "running"],
);
const refusedWorker = await instruct("audit", auditor, "pause");
checkEqual(
  "a client pausing audit's worker anyway: 403, and it keeps running",
  [
    refusedWorker.status,
    refusedWorker.body.detail,
    (await get<WorkerListDto>("/queues/audit/workers")).body.items[0]?.state,
  ],
  [403, "read-only on audit", "running"],
);

/* ------------------------------------------------------------------ */
step("A worker page: /workers/:queue/:key, on the queue's own map");

/** The gates of a worker page, in the order the README lists them. */
const WORKER_PAGE_GATES = [
  "worker page: route",
  "worker page: instances",
  "worker page: queue link",
  "worker page: Edit settings…",
  "worker page: Reset to code values…",
  "worker page: Change pending",
  "worker page: throughput and busyness",
  "worker page: jobs",
  "worker page: jobs' job links",
] as const satisfies readonly GateName[];

/**
 * A worker page read the way the screen reads it: its one listing, only
 * with `workers.list` on the queue's map.
 */
async function workerPageOf(
  queue: string,
  key: string,
): Promise<ScreenInputs["workerPage"]> {
  if (!can(maps[queue]!, "workers.list")) {
    return undefined;
  }
  const { body } = await get<WorkerListDto>(
    `/workers?queue=${queue}&key=${key}&includeOffline=true`,
  );
  const entry = body.offline?.find(
    (override) => override.queue === queue && override.key === key,
  );
  return {
    key,
    instances: body.items,
    // The page's storedOverride(): no entry, or one a reset emptied (no
    // values), is nothing stored.
    stored:
      body.offline === undefined
        ? undefined
        : entry === undefined || Object.keys(entry.values).length === 0
          ? null
          : entry,
  };
}

/** A worker page's gates, from {@link WORKER_PAGE_GATES}. */
async function workerPage(queue: string, key: string): Promise<boolean[]> {
  const set = screenGates({
    meta,
    sections,
    boot,
    queue: maps[queue]!,
    workerPage: await workerPageOf(queue, key),
  });
  return WORKER_PAGE_GATES.map((name) => set[name]);
}

checkEqual(
  "mail/mailer: one live instance; Edit settings…, the numbers and the jobs; no Reset (it is live)",
  [
    (await workerPageOf("mail", "mailer"))?.instances.length,
    await workerPage("mail", "mailer"),
  ],
  [1, [true, true, true, true, false, false, true, true, true]],
);
checkEqual(
  "audit/auditor: the same reads, and no Edit settings… (read-only)",
  await workerPage("audit", "auditor"),
  [true, true, true, false, false, false, true, true, true],
);
checkEqual(
  "payroll: the route exists, but Instances hidden (no read sent), and Jobs hidden",
  [
    await workerPageOf("payroll", "anyone"),
    await workerPage("payroll", "anyone"),
  ],
  [undefined, [true, false, true, false, false, false, false, false, false]],
);

/** A worker page's Instances card and its Target card, in that order. */
async function instancesAndTarget(
  queue: string,
  key: string,
): Promise<boolean[]> {
  const set = screenGates({
    meta,
    sections,
    boot,
    queue: maps[queue]!,
    workerPage: await workerPageOf(queue, key),
  });
  return [set["worker page: instances"], set["worker page: Target card"]];
}
checkEqual(
  "the Target card: wherever the Instances card is, a key with no live instance included (it says the target is known once one reports), and hidden with it on payroll",
  [
    await instancesAndTarget("mail", "mailer"),
    await instancesAndTarget("audit", "auditor"),
    await instancesAndTarget("payroll", "anyone"),
    [
      (await workerPageOf("mail", "nobody-runs-this"))?.instances.length,
      ...(await instancesAndTarget("mail", "nobody-runs-this")),
    ],
  ],
  [
    [true, true],
    [true, true],
    [false, false],
    [0, true, true],
  ],
);

// An override stored for a key no worker carries now: a worker page with no
// live instance offers to drop it.
const stored = await send("PUT", "/queues/mail/worker-configs/retired", {
  concurrency: 3,
});
const retired = await workerPageOf("mail", "retired");
checkEqual(
  "PUT …/worker-configs/retired → 200; its page: no instance, the override listed, Reset… offered",
  [
    stored.status,
    retired?.instances.length,
    retired?.stored?.values,
    await workerPage("mail", "retired"),
  ],
  [
    200,
    0,
    { concurrency: 3 },
    [true, true, true, false, true, false, true, true, true],
  ],
);
const dropped = await send("DELETE", "/queues/mail/worker-configs/retired");
const { body: afterDropListing } = await get<WorkerListDto>(
  "/workers?queue=mail&key=retired&includeOffline=true",
);
const emptied = afterDropListing.offline?.find(
  (override) => override.key === "retired",
);
// The API empties the entry rather than deleting it, so its version never
// restarts: `includeOffline` still lists it, with no values.
checkEqual(
  "DELETE …/worker-configs/retired → 200; the listing keeps the key, emptied (values {}, a new seq)",
  [
    dropped.status,
    emptied?.values,
    (emptied?.seq ?? 0) > (retired?.stored?.seq ?? 0),
  ],
  [200, {}, true],
);
// The page counts an emptied entry as nothing stored: "No override is
// stored for this key", and no Reset… to offer again.
checkEqual(
  "so the page reads nothing stored, and offers no Reset…",
  [
    (await workerPageOf("mail", "retired"))?.stored,
    (await workerPage("mail", "retired"))[4],
  ],
  [null, false],
);
checkEqual(
  "audit may do neither: PUT and DELETE …/worker-configs/auditor → 403",
  [
    (
      await send("PUT", "/queues/audit/worker-configs/auditor", {
        concurrency: 2,
      })
    ).status,
    (await send("DELETE", "/queues/audit/worker-configs/auditor")).status,
  ],
  [403, 403],
);

/* ------------------------------------------------------------------ */
step("Opt-in actions: routed only when a host lists them");

// The same jobs behind a host built with the default `actions`.
const defaultApi = createJobsApi({
  jobs,
  basePath: "/default-api",
  mode: "both",
  authorize: () => true,
  logger: noopLogger,
});
const defaultApp = new BunHttpAdapter();
defaultApp.use(defaultApi.basePath, defaultApi.router);

/** A request to the default host, answered through the real pipeline. */
async function onDefault(method: string, path: string, body?: unknown) {
  const response = await defaultApp.fetch(`/default-api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as unknown) : null,
  };
}

const defaultQueueMap = (await onDefault("GET", "/meta/permissions?queue=mail"))
  .body as PermissionsBody;
const defaultRunnerMap = (
  await onDefault("GET", "/meta/permissions?runner=nightly")
).body as PermissionsBody;
checkEqual(
  "JOBS_API_OPT_IN_ACTIONS: the six",
  [...JOBS_API_OPT_IN_ACTIONS].sort(),
  [
    "jobs.add",
    "jobs.update",
    "queues.applyDefaults",
    "queues.defaults",
    "runners.configure",
    "workers.configure",
  ],
);
checkEqual(
  "a default host routes every action but those: absent from the map, not false",
  JOBS_API_ACTIONS.filter(
    (action) =>
      !(action in defaultQueueMap.actions) &&
      !(action in defaultRunnerMap.actions),
  ).sort(),
  [...JOBS_API_OPT_IN_ACTIONS].sort(),
);
checkEqual(
  "while the new default-on ones are routed, and true for an authorize saying yes",
  [...NEW_QUEUE_MUTATIONS, ...NEW_RUNNER_ACTIONS]
    .filter((action) => !JOBS_API_OPT_IN_ACTIONS.has(action))
    .map((action) => [action, defaultQueueMap.actions[action]]),
  [
    ["workers.pause", true],
    ["workers.resume", true],
    ["workers.stop", true],
    ["workers.start", true],
    ["jobs.clearLogs", true],
    ["runners.clearHistory", true],
    ["runners.logs", true],
  ],
);
/** The opt-in routes, one per operation: each is refused here. */
const OPT_IN_ROUTES = [
  ["PUT", "/queues/mail/job-defaults", { attempts: 2 }],
  ["DELETE", "/queues/mail/job-defaults"],
  ["POST", "/queues/mail/job-defaults/apply", { seq: 0, dryRun: true }],
  ["PUT", "/queues/mail/worker-configs/mailer", { concurrency: 2 }],
  ["DELETE", "/queues/mail/worker-configs/mailer"],
  ["PUT", "/runners/nightly/config", { maxConcurrency: 2 }],
  ["DELETE", "/runners/nightly/config"],
] as const;
const optInStatuses: string[] = [];
for (const [method, path, body] of OPT_IN_ROUTES) {
  const { status } = await onDefault(method, path, body);
  optInStatuses.push(`${method} ${path} → ${status}`);
}
checkEqual(
  "and its opt-in routes do not exist: 404, whatever authorize says",
  optInStatuses,
  OPT_IN_ROUTES.map(([method, path]) => `${method} ${path} → 404`),
);
const defaultRunner = (await onDefault("GET", "/runners/nightly"))
  .body as RunnerInfoDto;
const defaultMeta = (await onDefault("GET", "/meta")).body as MetaDto;
/** A screen on the default host: its untargeted map, and `queue`'s or `runner`'s. */
function onDefaultHost(inputs: Partial<ScreenInputs>): Gates {
  return screenGates({
    meta: defaultMeta,
    sections,
    boot: defaultQueueMap,
    ...inputs,
  });
}
const pendingDefaults = {
  overridden: ["attempts"],
  pending: { total: 2 },
} as unknown as Pick<JobDefaultsDto, "overridden" | "pending">;
const defaultQueue = onDefaultHost({
  queue: defaultQueueMap,
  jobDefaults: pendingDefaults,
});
const defaultRunnerScreen = onDefaultHost({
  runnerMap: defaultRunnerMap,
  runner: defaultRunner,
});
checkEqual(
  "so the elements they gate are absent, while the panels and rows they sit in stay",
  {
    "panel=job-defaults": defaultQueue["panel=job-defaults"],
    "panel=job-defaults, Settings…":
      defaultQueue["panel=job-defaults, Settings…"],
    "panel=job-defaults, Apply to N pending jobs…":
      defaultQueue["panel=job-defaults, Apply to N pending jobs…"],
    "queue: Add job": defaultQueue["queue: Add job"],
    "job: Edit": defaultQueue["job: Edit"],
    "runner: summary's override rows":
      defaultRunnerScreen["runner: summary's override rows"],
    "runner: Settings…": defaultRunnerScreen["runner: Settings…"],
    "runner: Clear history…": defaultRunnerScreen["runner: Clear history…"],
    "mailer's row": rowView(
      screenGates({
        meta: defaultMeta,
        sections,
        boot: defaultQueueMap,
        workerMap: defaultQueueMap,
        worker: mailer,
        workerTable: [mailer],
      }),
    ),
  },
  {
    "panel=job-defaults": true,
    "panel=job-defaults, Settings…": false,
    "panel=job-defaults, Apply to N pending jobs…": false,
    "queue: Add job": false,
    "job: Edit": false,
    "runner: summary's override rows": true,
    "runner: Settings…": false,
    "runner: Clear history…": true,
    // Pause and Stop…, not Settings…: the lifecycle actions are default-on.
    "mailer's row": [true, false, true, false, false, true],
  },
);
await defaultApi.close();

/* ------------------------------------------------------------------ */
step("Job defaults: the panel, Settings… and Apply to N pending jobs…");

/** The Job defaults panel's read. */
async function jobDefaultsOf(queue: string): Promise<JobDefaultsDto> {
  return (await get<JobDefaultsDto>(`/queues/${queue}/job-defaults`)).body;
}

/** The panel's three gates on `queue`: [panel, Settings…, Apply…]. */
function defaultsGates(queue: string, jobDefaults: JobDefaultsDto): boolean[] {
  const set = screenGates({
    meta,
    sections,
    boot,
    queue: maps[queue]!,
    jobDefaults,
  });
  return [
    set["panel=job-defaults"],
    set["panel=job-defaults, Settings…"],
    set["panel=job-defaults, Apply to N pending jobs…"],
  ];
}

const codeDefaults = await jobDefaultsOf("mail");
checkEqual(
  "mail: nothing overridden, jobs pending: the panel and Settings…, no Apply (the panel says why)",
  [
    codeDefaults.overridden,
    codeDefaults.pending.total > 0,
    defaultsGates("mail", codeDefaults),
  ],
  [[], true, [true, true, false]],
);
const setDefaults = await send<JobDefaultsDto>(
  "PUT",
  "/queues/mail/job-defaults",
  { attempts: 3 },
);
const overridden = await jobDefaultsOf("mail");
checkEqual(
  "PUT …/job-defaults { attempts: 3 } → 200: attempts overridden, so Apply to N pending jobs… is offered",
  [
    setDefaults.status,
    overridden.overridden,
    overridden.effective.attempts,
    defaultsGates("mail", overridden),
  ],
  [200, ["attempts"], 3, [true, true, true]],
);
const dryRun = await send<{ dryRun: boolean; done: boolean; examined: number }>(
  "POST",
  "/queues/mail/job-defaults/apply",
  { seq: overridden.seq, dryRun: true },
);
checkEqual(
  "its dry run (POST …/job-defaults/apply { dryRun: true }) → 200, done, writing nothing",
  [
    dryRun.status,
    dryRun.body.dryRun,
    dryRun.body.done,
    (await jobDefaultsOf("mail")).pending.total,
  ],
  [200, true, true, overridden.pending.total],
);
checkEqual(
  "audit sees the same panel, with neither button: its PUT and apply → 403",
  [
    defaultsGates("audit", overridden),
    (await send("PUT", "/queues/audit/job-defaults", { attempts: 3 })).status,
    (
      await send("POST", "/queues/audit/job-defaults/apply", {
        seq: 0,
        dryRun: true,
      })
    ).status,
  ],
  [[true, false, false], 403, 403],
);
const resetDefaults = await send<JobDefaultsDto>(
  "DELETE",
  "/queues/mail/job-defaults",
);
checkEqual(
  "DELETE …/job-defaults → 200, a new seq, nothing overridden: no Apply again",
  [
    resetDefaults.status,
    (resetDefaults.body.seq ?? 0) > overridden.seq,
    (await jobDefaultsOf("mail")).overridden,
    defaultsGates("mail", await jobDefaultsOf("mail")),
  ],
  [200, true, [], [true, true, false]],
);

/* ------------------------------------------------------------------ */
step("Processed by, newest first, and Clear logs…");

/** A job as its screen reads it: state, who ran it, and its logs' count. */
async function jobOf(queue: string, id: string) {
  return (
    await get<{ state: JobState; processedBy: { key?: string } | null }>(
      `/queues/${queue}/jobs/${id}`,
    )
  ).body;
}

const logged = await jobOf("mail", "logged-1");
const neverRun = await jobOf("mail", "later-1");

/** The four Processed by gates, for `job` on mail: column, its link, line, its link. */
function processedByGates(job: ScreenInputs["job"], set = sections): boolean[] {
  const gatesNow = screenGates({
    meta,
    sections: set,
    boot,
    queue: maps.mail!,
    job,
  });
  return [
    gatesNow["queue: Processed by column"],
    gatesNow["queue: Processed by worker link"],
    gatesNow["job: Processed by"],
    gatesNow["job: Processed by worker link"],
  ];
}

checkEqual(
  "logged-1: completed, processed by the mailer key; column and line, both linked to its worker page",
  [logged.state, logged.processedBy?.key, processedByGates(logged)],
  ["completed", "mailer", [true, true, true, true]],
);
checkEqual(
  'later-1 (never run): processedBy null, so "No worker recorded" and no link',
  [neverRun.processedBy, processedByGates(neverRun)],
  [null, [true, false, true, false]],
);
checkEqual(
  "the links need the Workers nav entry: with sections.manage off they are plain text",
  processedByGates(logged, { ...sections, manage: false }),
  [true, false, true, false],
);
const newest = await get<{ items: { id: string }[] }>(
  "/queues/mail/jobs?sort=createdAt&order=desc",
);
checkEqual(
  "sort=createdAt (features.addedByState): 200, newest added first; not on a page counting its total",
  [
    newest.status,
    newest.body.items[0]?.id,
    screenGates({ meta, sections, boot, queue: maps.mail! })[
      "queue: jobs newest added first (sort=createdAt)"
    ],
    screenGates({ meta, sections, boot, queue: maps.mail!, countTotal: true })[
      "queue: jobs newest added first (sort=createdAt)"
    ],
  ],
  [200, "logged-1", true, false],
);

/** A job's log, as the Logs card pages it. */
interface LogPage {
  items: string[];
  page: { total: number };
}
const logsBefore = await get<LogPage>("/queues/mail/jobs/logged-1/logs");
checkEqual(
  "logged-1 logged one line; mail's job screen offers Clear logs…, audit's does not",
  [
    logsBefore.body.page.total,
    queueGates("mail", logged)["job: Clear logs…"],
    queueGates("audit", logged)["job: Clear logs…"],
  ],
  [1, true, false],
);
const clearedLogs = await send<{ removed: number }>(
  "DELETE",
  "/queues/mail/jobs/logged-1/logs",
);
checkEqual(
  "DELETE …/logged-1/logs → 200, removed 1; the log is empty now",
  [
    clearedLogs.status,
    clearedLogs.body.removed,
    (await get<LogPage>("/queues/mail/jobs/logged-1/logs")).body.page.total,
  ],
  [200, 1, 0],
);
checkEqual(
  "a client clearing an audit job's logs anyway: 403",
  (await send("DELETE", "/queues/audit/jobs/waiting-1/logs")).status,
  403,
);

/* ------------------------------------------------------------------ */
step("Runners: run logs, Clear history… and Settings…");

const nightlyRuns = (
  await get<{ items: RunRecordDto[] }>("/runners/nightly/history")
).body.items;
const killedRun = nightlyRuns[0]!;

/** The three run gates on `id`'s screen for `run`: [Log column, Log button, dropped]. */
function runGates(id: string, run: ScreenInputs["run"]): boolean[] {
  const set = screenGates({
    meta,
    sections,
    boot,
    runnerMap: runnerMaps[id]!,
    runner: runnerInfos[id],
    run,
  });
  return [
    set["runner: run log and Log column"],
    set["runner: a run's Log button"],
    set["runner: N lines dropped"],
  ];
}

show("nightly's killed run: status, logLines, logsDropped", {
  status: killedRun.status,
  logLines: killedRun.logLines,
  logsDropped: killedRun.logsDropped,
});
checkEqual(
  "its Log button follows its logLines (a finished run that logged 0 offers none)",
  runGates("nightly", killedRun)[1],
  killedRun.logLines === undefined || killedRun.logLines > 0,
);
checkEqual(
  "the rule: a running run offers it before it reports logLines; 0 lines finished does not; dropped lines show",
  [
    runGates("nightly", { status: "running" }),
    runGates("nightly", { status: "success", logLines: 0 }),
    runGates("nightly", { status: "success", logLines: 4, logsDropped: 2 }),
  ],
  [
    [true, true, false],
    [true, false, false],
    [true, true, true],
  ],
);
const runLog = await get<{ items: unknown[] }>(
  `/runners/nightly/runs/${encodeURIComponent(killedRun.runId)}/logs`,
);
checkEqual(
  "GET …/runs/<id>/logs → 200 (runners.logs, a read); ledger has the read too, vault not",
  [
    runLog.status,
    runGates("ledger", { status: "running" })[0],
    runGates("vault", { status: "running" })[0],
  ],
  [200, true, false],
);

/** The three new runner gates on `id`'s screen: [Clear history…, Settings…, override rows]. */
function newRunnerGates(id: string): boolean[] {
  const set = screenGates({
    meta,
    sections,
    boot,
    runnerMap: runnerMaps[id]!,
    runner: runnerInfos[id],
  });
  return [
    set["runner: Clear history…"],
    set["runner: Settings…"],
    set["runner: summary's override rows"],
  ];
}

checkEqual(
  "every runner here reports a config; Clear history… and Settings… on nightly and remote-sync",
  Object.fromEntries(
    RUNNERS.map((id) => [
      id,
      [runnerInfos[id]?.config !== undefined, ...newRunnerGates(id)],
    ]),
  ),
  {
    nightly: [true, true, true, true],
    ledger: [true, false, false, true],
    // Never read: Runner hidden.
    vault: [false, false, false, false],
    "remote-sync": [true, true, true, true],
  },
);
const remoteCleared = await send("DELETE", "/runners/remote-sync/history");
checkEqual(
  "DELETE /runners/remote-sync/history → 200: a remote runner's history clears too (no RUNNER_NOT_LOCAL)",
  remoteCleared.status,
  200,
);
const nightlyCleared = await send("DELETE", "/runners/nightly/history");
checkEqual(
  "DELETE /runners/nightly/history → 200, and its history is empty",
  [
    nightlyCleared.status,
    (await get<{ items: unknown[] }>("/runners/nightly/history")).body.items,
  ],
  [200, []],
);
checkEqual(
  "ledger may do neither: DELETE …/history and PUT …/config → 403",
  [
    (await send("DELETE", "/runners/ledger/history")).status,
    (await send("PUT", "/runners/ledger/config", { maxConcurrency: 2 })).status,
  ],
  [403, 403],
);

/* ------------------------------------------------------------------ */
step("The Overview's analytics: captions, 'not kept', and the busiest note");

/** The Overview's analytics reads over `[from, to)`, as the three sections send them. */
async function overviewReads(from: number, to: number) {
  const range = `from=${from}&to=${to}`;
  const jobsRead = await get<
    AnalyticsSeriesDto<unknown, unknown> & { code?: string }
  >(`/analytics/jobs?${range}`);
  const runnersRead = await get<RunnersAnalyticsDto & { code?: string }>(
    `/analytics/runners?${range}`,
  );
  const workersRead = await get<WorkersAnalyticsDto & { code?: string }>(
    `/analytics/workers?${range}`,
  );
  const answer = (
    status: number,
    body: { code?: string },
    range: { clamped: boolean } | undefined,
    truncated?: boolean,
  ): SectionRead => ({
    clamped: status === 200 && range?.clamped === true,
    notRetained: status === 400 && body.code === "RANGE_NOT_RETAINED",
    truncated: truncated === true,
  });
  return {
    jobs: answer(jobsRead.status, jobsRead.body, jobsRead.body.range),
    runners: answer(
      runnersRead.status,
      runnersRead.body,
      runnersRead.body.series?.range,
      runnersRead.body.truncated,
    ),
    workers: answer(
      workersRead.status,
      workersRead.body,
      workersRead.body.series?.range,
      workersRead.body.truncated,
    ),
  };
}

/** The Overview gates that follow a read's answer, by section. */
function readGates(reads: ScreenInputs["reads"]) {
  const set = screenGates({ meta, sections, boot, reads });
  return {
    caption: [
      set["overview: Jobs range caption"],
      set["overview: Runners range caption"],
      set["overview: Workers range caption"],
    ],
    notKept: [
      set["overview: Jobs not kept"],
      set["overview: Runners not kept"],
      set["overview: Workers not kept"],
    ],
    busiest: [
      set["overview: Runners busiest note"],
      set["overview: Workers busiest note"],
    ],
  };
}

const now = Date.now();
checkEqual(
  "meta.analytics is set and records runners and workers: every section is on",
  [
    meta.analytics !== null,
    meta.analytics?.recording.runners,
    meta.analytics?.recording.workers,
    screenGates({ meta, sections, boot })["overview: Runners section"],
    screenGates({ meta, sections, boot })["overview: Workers section"],
  ],
  [true, true, true, true, true],
);
// The last hour, the picker's default. Per-second buckets are kept for five
// minutes only, so each read is served per minute and says why: `retention`.
const hourRead = await get<AnalyticsSeriesDto<unknown, unknown>>(
  `/analytics/jobs?from=${now - 3_600_000}&to=${now}`,
);
show("GET /analytics/jobs, the last hour: range", hourRead.body.range);
const wide = await overviewReads(now - 3_600_000, now);
checkEqual(
  "the last hour: every read is clamped (reason retention), so every section captions it",
  [
    meta.analytics!.recording.secondRetentionMs < 3_600_000,
    hourRead.body.range.reason,
    wide,
    readGates(wide).caption,
  ],
  [
    true,
    "retention",
    {
      jobs: { clamped: true, notRetained: false, truncated: false },
      runners: { clamped: true, notRetained: false, truncated: false },
      workers: { clamped: true, notRetained: false, truncated: false },
    },
    [true, true, true],
  ],
);
// A span beyond maxSpanMs is refused outright; the picker never offers one.
const tooWide = await get<{ code?: string }>(
  `/analytics/jobs?from=${now - 2 * 86_400_000}&to=${now}`,
);
checkEqual(
  'two days, beyond meta.analytics.maxSpanMs: 400 INVALID_ARGUMENT, not a clamp and not "not kept"',
  [
    tooWide.status,
    tooWide.body.code,
    readGates(await overviewReads(now - 2 * 86_400_000, now)).notKept,
  ],
  [400, "INVALID_ARGUMENT", [false, false, false]],
);
// A range wholly older than anything kept.
const stale = await overviewReads(now - 5 * 86_400_000, now - 4 * 86_400_000);
checkEqual(
  'a range wholly older than retention: 400 RANGE_NOT_RETAINED on each, so "No numbers are kept"',
  [stale, readGates(stale).notKept, readGates(stale).caption],
  [
    {
      jobs: { clamped: false, notRetained: true, truncated: false },
      runners: { clamped: false, notRetained: true, truncated: false },
      workers: { clamped: false, notRetained: true, truncated: false },
    },
    [true, true, true],
    [false, false, false],
  ],
);
checkEqual(
  'four runners and two worker keys are far under 100 rows: no "Showing the N busiest" note',
  readGates(wide).busiest,
  [false, false],
);
checkEqual(
  "the rule: a truncated roll-up shows the note; a caller without metrics.read sees no section",
  [
    readGates({ runners: { truncated: true }, workers: { truncated: true } })
      .busiest,
    screenGates({
      meta,
      sections,
      boot: { ...boot, actions: { ...boot.actions, "metrics.read": false } },
      reads: { runners: { truncated: true } },
    })["overview: Runners busiest note"],
  ],
  [[true, true], false],
);
checkEqual(
  "a backend recording no analytics (meta.analytics null): no sparklines, no figure, no sections",
  (() => {
    const set = screenGates({
      meta: { ...meta, analytics: null },
      sections,
      boot,
    });
    return [
      set["Overview: sparklines"],
      set["overview: Over the range figure"],
      set["overview: Over the range, added by state"],
      set["overview: Runners section"],
      set["overview: Workers section"],
    ];
  })(),
  // The added-by-state group reads its own route, not the series.
  [false, false, true, false, false],
);

/* ------------------------------------------------------------------ */
step("the analytics rows' links: the worker, the queue and the runner");

/**
 * The three row links of the Overview's analytics tables, for a caller whose
 * untargeted map is `bootMap`: a Workers row's key, that row's queue, and a
 * Runners row's runner. The queue passed alongside is `mail`'s own answer,
 * which none of the three may consult.
 */
function rowLinks(bootMap: PermissionsBody): boolean[] {
  const set = screenGates({
    meta,
    sections,
    boot: bootMap,
    queue: maps.mail,
    runnerMap: maps.nightly,
  });
  return [
    set["overview: Workers row key link"],
    set["overview: Workers row queue link"],
    set["overview: Runners row runner link"],
  ];
}
/** `bootMap` with each of `actions` refused untargeted. */
function refusedUntargeted(...actions: JobsApiAction[]): PermissionsBody {
  return {
    ...boot,
    actions: {
      ...boot.actions,
      ...Object.fromEntries(actions.map((action) => [action, false])),
    },
  };
}
checkEqual(
  "this caller: the key links to its worker page, the queue to the queue screen, the runner to its page",
  rowLinks(boot),
  [true, true, true],
);
// The section spans queues, and the app registers `/workers/:queue/:key` from
// the nav, which is built from the untargeted map. So a host granting
// `workers.list` only per queue offers no key link on any row — including a
// row whose own queue would have allowed it — because the route it would open
// was never registered for this caller. A plain name beats a dead link.
checkEqual(
  "`workers.list` granted per queue but not untargeted: every key is plain text, and the queue link survives",
  [
    can(refusedUntargeted("workers.list"), "workers.list"),
    can(maps.mail!, "workers.list"),
    rowLinks(refusedUntargeted("workers.list")),
  ],
  [false, true, [false, true, true]],
);
checkEqual(
  "the same for the queue column: `queues.list` per queue only leaves every row's queue plain text, and the key still links",
  [
    can(refusedUntargeted("queues.list"), "queues.list"),
    can(maps.mail!, "queues.list"),
    // `queues.list` is the Overview's own alternative to `metrics.read`, and
    // the Workers nav entry never asks for it, so the section and the key stay.
    rowLinks(refusedUntargeted("queues.list")),
  ],
  [false, true, [true, false, true]],
);
checkEqual(
  "and without untargeted `runners.list` the runner is plain text, while the Workers row keeps both links",
  rowLinks(refusedUntargeted("runners.list")),
  [true, true, false],
);
checkEqual(
  "a backend keeping no worker registry (meta.features.workers false): no key link, since /workers is not routed",
  screenGates({
    meta: { ...meta, features: { ...meta.features, workers: false } },
    sections,
    boot,
  })["overview: Workers row key link"],
  false,
);

/* ------------------------------------------------------------------ */
step("The pagers: on a list table only where its rows outnumber one page");

/**
 * A row count per paged table, from the size each one pages at — the constant
 * for six of them, and for the runner's history the size a reader who has
 * picked none gets (`min(50, limits.maxHistory)`).
 */
function rowsPerTable(
  of: (size: number) => number,
): Record<PagedTable, number> {
  return Object.fromEntries(
    pagerGates.map((gate: Gate) => [
      gate.pagedTable!,
      of(pageSizeOf(gate.pagedTable!, { meta, sections, boot })),
    ]),
  ) as Record<PagedTable, number>;
}

/** One row more than a page, in every paged table. */
const overOnePage = rowsPerTable((size) => size + 1);

/**
 * Every pager gate, in the order the README lists them, for a caller holding
 * everything.
 *
 * @param tableRows How many rows each paged table was handed.
 * @param queueMap The queue's own answer, which the two panels' and a worker
 * page's pagers are decided on. Defaults to `mail`'s, which allows everything.
 * @param bootMap The untargeted map. Defaults to this caller's.
 */
function pagers(
  tableRows: Partial<Record<PagedTable, number>>,
  queueMap: PermissionsBody = maps.mail!,
  bootMap: PermissionsBody = boot,
): boolean[] {
  const set = screenGates({
    meta,
    sections,
    boot: bootMap,
    queue: queueMap,
    runnerMap: runnerMaps.nightly,
    runner: runnerInfos.nightly,
    tableRows,
  });
  return pagerGates.map((gate: Gate) => set[gate.name as GateName]);
}

show(
  "the pager gates, in the order the README lists them",
  pagerGates.map((gate: Gate) => gate.name),
);
checkEqual(
  "no rows on screen: no pager anywhere",
  pagers({}),
  pagerGates.map(() => false),
);
// The boundary is the one worth asserting: at exactly one page's worth there is
// nowhere to turn to, so the pager is not on the table at all — not there with
// every control disabled.
checkEqual(
  "exactly one page in every table: still no pager",
  pagers(rowsPerTable((size) => size)),
  pagerGates.map(() => false),
);
checkEqual(
  "one row more than a page: every pager, each at its own size",
  pagers(overOnePage),
  pagerGates.map(() => true),
);
// A pager is its table's, so whatever closes the table closes it however many
// rows came back. payroll allows nothing queue-scoped — no Repeatables panel,
// no Workers panel, no instances — so there are no pages of them either.
checkEqual(
  "payroll: the three queue-side pagers close with their tables; the rest the untargeted map decides",
  pagers(overOnePage, maps.payroll!),
  [true, false, true, true, true, false, false],
);
checkEqual(
  "audit reads all of them, as it reads the tables they page",
  pagers(overOnePage, maps.audit!),
  pagerGates.map(() => true),
);
checkEqual(
  "and without untargeted queues.list there is no Overview queue table, so nothing to page",
  pagers(overOnePage, maps.mail!, refusedUntargeted("queues.list"))[0],
  false,
);

/* ------------------------------------------------------------------ */
step("A runner's history: paged on the server, over the whole stored history");

// The seventh pager is the odd one out, so what its README row claims is
// checked against the model rather than against a constant. Its size and its
// depth are URL parameters, so the README's `### URL parameters` table is read
// here too: `history` and `offset` are where those claims are spelled out.
const urlParams = await readmeUrlParams();
/** What the README says a `/runners/:runner` parameter means, `""` for one it does not document. */
function runnerParam(name: string): string {
  return (
    urlParams.find(
      (row) => row.screen === "/runners/:runner" && row.parameter === name,
    )?.meaning ?? ""
  );
}
const historyPagerCell = pagerCell(
  GATES.find((gate: Gate) => gate.pagedTable === HISTORY_TABLE)!,
);
const historyParamCell = runnerParam("history");
const offsetParamCell = runnerParam("offset");

/**
 * A runner screen with every permission, a stored history of `total` runs and
 * the window the URL asks for.
 *
 * @param total The runner's whole stored history (`page.total`).
 * @param page The `history`, `offset` and `logs` parameters.
 * @param runnerMap The runner's own permissions. Defaults to `nightly`'s, which
 * allows everything.
 */
function historyScreen(
  total: number,
  page: NonNullable<ScreenInputs["historyPage"]> = {},
  runnerMap: PermissionsBody = runnerMaps.nightly!,
): ScreenInputs {
  return {
    meta,
    sections,
    boot,
    runnerMap,
    runner: runnerInfos.nightly,
    tableRows: { [HISTORY_TABLE]: total },
    historyPage: page,
  };
}

/** Whether the history pager is on screen for a stored total and a window. */
function historyPager(
  total: number,
  page: NonNullable<ScreenInputs["historyPage"]> = {},
): boolean {
  return screenGates(historyScreen(total, page))["runner: history pager"];
}

/** `nightly`'s own map with `actions` refused, the rest of it untouched. */
function refusedOnRunner(...actions: JobsApiAction[]): PermissionsBody {
  const map = runnerMaps.nightly!;
  return {
    ...map,
    actions: {
      ...map.actions,
      ...Object.fromEntries(actions.map((action) => [action, false])),
    },
  };
}

show("limits.maxHistory, as this API reports it", meta.limits.maxHistory);
show("the README's row for the history pager", historyPagerCell);
checkEqual(
  "its row states that figure as a default: the size is the “Runs shown” number, capped by `limits.maxHistory`, and the paging is on the server with the window in the URL",
  [
    // The figure the check above compares is a default here, as `/runners`' is,
    // so the row has to say so — a bare "(50)" would be a rule the app does not
    // have.
    /by default/.test(historyPagerCell),
    /limits\.maxHistory/.test(historyPagerCell),
    /Runs shown/.test(historyPagerCell),
    /page size/.test(historyPagerCell),
    /on the server/.test(historyPagerCell),
    /window in the URL/.test(historyPagerCell),
    // What the row used to say, and the drift this check exists to catch: it
    // paged "within what was fetched", "never reading again".
    /within what was fetched|never reading again/.test(historyPagerCell),
  ],
  [true, true, true, true, true, true, false],
);

// The page size is `history`, and the README's row for it is where the rule
// lives. The `50` in the expectation is the README's own figure, read out of
// the row rather than written here twice.
show("the README's row for `history`", historyParamCell);
const documentedDefault = Number(
  /the smaller of `(\d+)` and `limits\.maxHistory`/.exec(historyParamCell)?.[1],
);
checkEqual(
  "`history` is the page size: the README calls it runs per page, says a change resets `offset`, and the size follows it",
  [
    /Runs \*\*per page\*\*/.test(historyParamCell),
    /resets `offset`/.test(historyParamCell),
    historyPageSize(historyScreen(0)),
    historyPageSize(historyScreen(0, { param: "10" })),
    historyPageSize(historyScreen(0, { param: "0" })),
    historyPageSize(historyScreen(0, { param: "nonsense" })),
  ],
  [
    true,
    true,
    Math.min(documentedDefault, meta.limits.maxHistory),
    10,
    // `clampLimit` holds it to 1 at the bottom, and `intParam` takes digits
    // only, so anything else is the default.
    1,
    Math.min(documentedDefault, meta.limits.maxHistory),
  ],
);
// And the figure the pager row states is that same default: what makes it a
// figure this file has compared to something, rather than a number in prose.
checkEqual(
  "the figure its pager row states is that default, and the size in force with no `history` in the URL",
  [PAGE_SIZES[HISTORY_TABLE], historyPageSize(historyScreen(0))],
  [
    Math.min(documentedDefault, meta.limits.maxHistory),
    Math.min(documentedDefault, meta.limits.maxHistory),
  ],
);
// The asymmetry is the whole point of the change: a page is capped, the window
// is not, so a `keepHistory` far above `limits.maxHistory` is still reachable.
show("the README's row for `offset`", offsetParamCell);
checkEqual(
  "`limits.maxHistory` caps a page and not the window: the README says `offset` is uncapped, and only the size clamps",
  [
    /clamped to that range/.test(historyParamCell),
    /uncapped/.test(offsetParamCell),
    historyPageSize(historyScreen(0, { param: "1000000" })),
    historyWindow(historyScreen(0, { offset: 1_000_000 })).offset,
  ],
  [true, true, meta.limits.maxHistory, 1_000_000],
);

// What decides the pager moved with the change: the runner's stored total, not
// the rows the table holds. The six others are the other way round, which is
// why this one's `PAGE_SIZES` figure is a default and not a rule.
checkEqual(
  "the pager follows the stored total against the page size, whatever is on screen",
  [
    // What the row claims, and what the six others cannot: it pages the
    // runner's whole history rather than the rows its table was handed.
    /whole history/.test(historyPagerCell),
    pagerGates.filter(
      (gate: Gate) =>
        gate.pagedTable !== HISTORY_TABLE &&
        /whole history/.test(pagerCell(gate)),
    ).length,
    historyPager(30),
    historyPager(30, { param: "10" }),
    historyPager(10, { param: "10" }),
    historyPager(30, { param: "10", offset: 100 }),
    historyPager(0, { param: "10" }),
  ],
  [
    true,
    0,
    // 30 runs under a 50-run default page: one page, so nothing to turn to.
    false,
    true,
    // Exactly one page's worth, as for every other table.
    false,
    // Past the end: the page is empty and the pager is how you get back.
    true,
    false,
  ],
);

// A window past the end is a state the old table could not reach, since it
// only ever cut pages from rows it held.
const pastTheEnd = historyScreen(30, { param: "10", offset: 100 });
checkEqual(
  '`offset` past the end reads no rows, and the README\'s row says what that page shows: "No runs on this page", the pager and Clear history… still live',
  [
    /No runs on this page/.test(offsetParamCell),
    /Clear history/.test(offsetParamCell) && /still live/.test(offsetParamCell),
    historyWindow(pastTheEnd).rows,
    historyWindow(pastTheEnd).total,
    historyClearDisabled(pastTheEnd),
    // An empty history is the other thing entirely: "No runs yet", and nothing
    // to clear.
    historyClearDisabled(historyScreen(0)),
  ],
  [true, true, 0, 30, false, true],
);

// `?logs=` no longer bends the page to the run; the link carries the window
// the Log button was pressed on, and a run this page does not hold is named in
// a note (`history-open-log-note`) instead of opening nothing.
const OPEN_RUN = "run-off-page";
checkEqual(
  "a `logs=` run off the page is called out rather than silently opened, and a link carrying its own `offset` lands on it",
  [
    /not on the page shown/.test(historyPagerCell),
    /the card says the open log is elsewhere/.test(runnerParam("logs")),
    // The run is the fourth-newest, and the page holds the newest ten.
    historyOpenLogNote(
      historyScreen(30, { param: "10", openRun: OPEN_RUN, openRunAt: 3 }),
    ),
    // The twenty-first newest: two pages on, so this page cannot place it.
    historyOpenLogNote(
      historyScreen(30, { param: "10", openRun: OPEN_RUN, openRunAt: 20 }),
    ),
    // The same link as the Log button wrote it, `offset` included.
    historyOpenLogNote(
      historyScreen(30, {
        param: "10",
        offset: 20,
        openRun: OPEN_RUN,
        openRunAt: 20,
      }),
    ),
    // A run the history no longer holds at all.
    historyOpenLogNote(
      historyScreen(30, { param: "10", openRun: OPEN_RUN, openRunAt: -1 }),
    ),
    // Nothing is open without the Log column, so there is nothing to note:
    // `openRunId` is `null` for a caller who may not read run logs.
    historyOpenLogNote(
      historyScreen(
        30,
        { param: "10", openRun: OPEN_RUN, openRunAt: 20 },
        refusedOnRunner("runners.logs"),
      ),
    ),
    // Nor on a page with no rows: there is nothing yet to be missing from.
    historyOpenLogNote(
      historyScreen(30, {
        param: "10",
        offset: 100,
        openRun: OPEN_RUN,
        openRunAt: 0,
      }),
    ),
  ],
  [true, true, false, true, false, true, false, false],
);

await mailWorker.close({ timeout: 1_000 });
await auditWorker.close({ timeout: 1_000 });

summary();

await api.close();
await elsewhere.close();
await jobs.close();
