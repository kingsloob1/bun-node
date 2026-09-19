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
 *   `RUNNER_NOT_LOCAL`.
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
  PermissionsDto,
  QueueDetailDto,
  RunnerInfoDto,
  RunnerListDto,
} from "@kingsleyweb/bun-jobs/api/contract";
import { join } from "node:path";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_ACTIONS,
  JOBS_API_MUTATIONS,
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
async function send(
  method: string,
  path: string,
  body: unknown = {},
): Promise<{ status: number; body: { code?: string; detail?: string } }> {
  const response = await app.fetch(`${api.basePath}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "DELETE" ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as { code?: string; detail?: string }) : {},
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

/** A `/meta` feature flag. */
type Feature = keyof MetaDto["features"];

/**
 * A targeted map as a screen holds it: the answer, or `"pending"` while it
 * loads. A request that failed is passed as the untargeted map, which is
 * what the app falls back to then.
 */
type TargetedMap = PermissionsBody | "pending";

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
  /** The job on the job screen, whose state picks Retry or Promote. */
  job?: { state: JobState };
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
 */
type GateMap = "boot" | "queue" | "runner" | "operation";

/**
 * What shows when a gate is closed but the screen it sits on is open:
 * nothing (`absent`, the rule everywhere but the docs), the element
 * `disabled` with its reason, a `note` in its place, or a permission marker
 * reading "You lack".
 */
type Denied = "absent" | "disabled" | "note" | "lack";

/** The `/meta` fields a README row may name as `` `meta.<field>` ``. */
type MetaField = keyof MetaDto | "docs.openapi" | "docs.asyncapi";

/** Methods the app's client sends (the HTTP try-it's `CLIENT_METHODS`). */
const CLIENT_METHODS = ["DELETE", "GET", "PATCH", "POST", "PUT"] as const;

/**
 * Every routed action name: to pick actions out of the README's prose, and
 * to tell an action the UI knows from one it does not.
 */
const ACTION_NAMES: ReadonlySet<string> = new Set(JOBS_API_ACTIONS);

/** Action verbs whose try-it needs the operationId typed. */
const DESTRUCTIVE_VERBS = ["clean", "drain", "kill", "remove"] as const;

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
   * The `/meta` fields other than `mode` that the README row names as
   * `` `meta.<field>` ``. `when` decides on them; listing them here lets the
   * table check notice a row that gains or loses one.
   */
  readonly metaFields?: readonly MetaField[];
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

/** Whether the runner on screen has a run in flight in the API's process. */
function hasLocalRuns(runner: RunnerInfoDto | undefined): boolean {
  return runner?.isLocal === true && (runner.local?.activeRuns.length ?? 0) > 0;
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
    name: "Overview: sparklines",
    row: "Overview sparklines",
    map: "boot",
    reads: ["metrics.read"],
    features: ["throughput"],
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
    name: "Runners: nav and /runners*",
    row: "Runners nav entry and every `/runners*` route",
    map: "boot",
    sections: ["manage"],
    modes: ["runner", "both"],
    reads: ["runners.list"],
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
    name: "runner: active runs",
    row: "Runner active runs",
    map: "runner",
    when: ({ runner }) => runner?.local !== undefined,
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
    name: "runner: remote hint",
    row: "Runner remote hint",
    map: "runner",
    anyMutation: ["runners.kill", "runners.resetStats"],
    when: ({ runner }) => runner?.isLocal === false,
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
    name: "docs: HTTP reference and its card",
    row: "HTTP reference (`/docs/http*`) and its card on `/docs`",
    map: "boot",
    on: "Docs: nav and /docs*",
    // The row names `meta.docs` too: the API sends `openapi` whenever it
    // sends `docs`, so the reference exists wherever the nav entry does.
    metaFields: ["docs", "docs.openapi"],
    when: ({ meta }) => meta.docs?.openapi !== undefined,
  },
  {
    // Without it, /docs/ws is a screen saying so: the reference is absent.
    name: "docs: WebSocket reference and its card",
    row: "WebSocket reference (`/docs/ws*`) and its card on `/docs`",
    map: "boot",
    on: "Docs: nav and /docs*",
    metaFields: ["docs.asyncapi"],
    when: ({ meta }) => meta.docs?.asyncapi !== undefined,
  },
  {
    name: "docs http: permission marker (You have)",
    row: 'HTTP operation\'s permission marker, "You have" / "You lack"',
    map: "operation",
    on: "docs: HTTP reference and its card",
    itemKind: "http",
    itemAction: true,
    denied: "lack",
  },
  {
    name: "docs ws: permission marker (You have this)",
    row: 'WebSocket channel\'s and operation\'s permission markers, "You have this" / "You lack this"',
    map: "operation",
    on: "docs: WebSocket reference and its card",
    itemKind: "ws",
    itemAction: true,
    unknownAction: true,
    denied: "lack",
  },
  {
    name: "docs http: try-it Send",
    row: "HTTP try-it Send",
    map: "operation",
    on: "docs: HTTP reference and its card",
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
    on: "docs: HTTP reference and its card",
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
    on: "docs: WebSocket reference and its card",
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
  return (
    (parent === undefined || isOpen(parent, inputs)) &&
    (screen === undefined || isOpen(screen, inputs)) &&
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

/**
 * The table under `### What each element needs` in the package README,
 * read as a file: the docs are the contract here, not the package's code.
 */
async function readmeGatingTable(): Promise<ReadmeRow[]> {
  const path = join(import.meta.dir, "../../../packages/bun-jobs-ui/README.md");
  const lines = (await Bun.file(path).text()).split("\n");
  const heading = lines.findIndex(
    (line) => line.trim() === "### What each element needs",
  );
  if (heading === -1) {
    throw new Error(`${path} has no "### What each element needs" section`);
  }
  const start = lines.findIndex(
    (line, index) => index > heading && line.startsWith("|"),
  );
  const rows: ReadmeRow[] = [];
  // Skip the header and the |---| separator; stop at the first non-row.
  for (let index = start + 2; lines[index]?.startsWith("|"); index++) {
    const cells = lines[index]!.split("|").map((cell) => cell.trim());
    rows.push({ element: cells[1]!, needs: cells.slice(2, -1).join("|") });
  }
  return rows;
}

/** The values `meta.mode` takes. */
const MODES: ReadonlySet<string> = new Set(["jobs", "runner", "both"]);

/** HTTP methods, to pick them out of the README's prose. */
const METHOD_NAMES: ReadonlySet<string> = new Set(CLIENT_METHODS);

/** Destructive verbs, likewise. */
const VERB_NAMES: ReadonlySet<string> = new Set(DESTRUCTIVE_VERBS);

/**
 * What a row's cells ask for, as comparable lists. `element` is the
 * "Element" cell, which is where a marker row names its "You lack".
 */
function needsOfCell(needs: string, element: string) {
  // "`sections.manage` is not needed" names a section in order to exclude it.
  const notNeeded = [...needs.matchAll(/`sections\.(\w+)` is not needed/g)].map(
    (match) => match[1]!,
  );
  const codes = [...needs.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]!)
    .filter(
      (code) => !notNeeded.some((section) => code === `sections.${section}`),
    );
  const mode = codes.indexOf("meta.mode");
  return {
    // A cell may name an action twice ("`jobs.read` ... never without
    // `jobs.read`"): the set is what counts.
    actions: [
      ...new Set(codes.filter((code) => ACTION_NAMES.has(code))),
    ].sort(),
    features: codes
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
      .filter((code) => code.startsWith("meta.") && code !== "meta.mode")
      .map((code) => code.slice("meta.".length))
      .sort(),
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
    // other row's element is absent.
    shownWhenDenied:
      /\bdisabled\b|\ba note\b/.test(needs) || element.includes("You lack"),
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
for (const row of readme) {
  const gates: Gate[] = GATES.filter((gate: Gate) => gate.row === row.element);
  checkEqual(
    `README "${row.element}" needs what GATES says`,
    needsOfCell(row.needs, row.element),
    needsOfGates(gates),
  );
}
checkEqual(
  'a row the README calls "untargeted" is decided on the untargeted map',
  readme
    .filter((row) => row.needs.includes("untargeted"))
    .filter((row) =>
      GATES.some(
        (gate: Gate) =>
          gate.row === row.element &&
          gate.map !== "boot" &&
          gate.map !== "operation",
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
  [true, true],
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
  "docs: HTTP reference and its card",
  "docs: WebSocket reference and its card",
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
checkEqual(
  "a DELETE, or a remove / drain / clean / kill, needs its operationId typed",
  operationsWhere("docs http: try-it needs the operationId typed", {
    meta,
    sections,
    boot,
  }),
  [
    "cleanQueue",
    "drainQueue",
    "killRunner",
    "removeJob",
    "removeJobs",
    "removeRepeatable",
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
function queueGates(queue: string, job?: { state: JobState }): Gates {
  return screenGates({
    meta,
    sections,
    boot,
    queue: maps[queue]!,
    detail: details[queue],
    job,
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
 * The gates decided on the untargeted map: the same on every queue and
 * runner, and all open for this caller.
 */
const bootGates = allGates(true, "boot");

// mail: everything the screens offer, for a running queue.
checkEqual(
  "mail (running): every gate is open but four",
  onMaps(gates.mail, "boot", "queue"),
  {
    ...allGates(true, "boot", "queue"),
    // A running queue offers Pause, not Resume; checked paused below.
    "queue: Resume": false,
    // addableNames is ["send-email"], so the dialog offers that name, not a
    // search of the registered definitions.
    "queue: Add job's name suggestions": false,
    // The job gates that depend on a job's state; asked below with one.
    "job: Retry": false,
    "job: Promote": false,
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
check(
  "and the job is still there",
  (await jobs.queue("mail").getJob("vip-1")) !== null,
);

/* ------------------------------------------------------------------ */
step("GET /runners: which runners are local");

// The list says `local`, the runner itself `isLocal` plus a `local` block
// (its instance's status and the runs in flight in this process). A runner
// registered only by another process has neither.
const list = (await get<RunnerListDto>("/runners")).body;
checkEqual(
  "the list: local runners first, then the ids only the driver knows",
  list.items.map((item) => [item.id, item.local]),
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
  "nightly (local, running, nothing in flight): all but Resume…, Kill… and the remote hint",
  onMaps(runnerColumns.nightly, "boot", "runner"),
  {
    ...allGates(true, "boot", "runner"),
    "runner: Resume…": false,
    "runner: Kill…": false,
    "runner: remote hint": false,
  },
);
checkEqual(
  "ledger (local): reads only",
  onMaps(runnerColumns.ledger, "boot", "runner"),
  {
    ...allGates(false, "runner"),
    ...bootGates,
    "runner: screen": true,
    "runner: stats and history": true,
    "runner: active runs": true,
  },
);
checkEqual(
  "vault: only what the untargeted map decides",
  onMaps(runnerColumns.vault, "boot", "runner"),
  { ...allGates(false, "runner"), ...bootGates },
);
checkEqual(
  "remote-sync: no active runs, Kill… or Reset stats…, but the remote hint",
  onMaps(runnerColumns["remote-sync"], "boot", "runner"),
  {
    ...allGates(true, "boot", "runner"),
    "runner: active runs": false,
    "runner: Resume…": false,
    "runner: Kill…": false,
    "runner: Reset stats…": false,
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

summary();

await api.close();
await elsewhere.close();
await jobs.close();
