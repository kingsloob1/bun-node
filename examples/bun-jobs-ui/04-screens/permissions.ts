/**
 * What each screen needs: the permissions model behind the queue screens,
 * asserted on the API.
 *
 * ```bash
 * bun 04-screens/permissions.ts
 * ```
 *
 * The UI decides nothing about access. Before it draws a button it asks the
 * API, and the API asks your `authorize`:
 *
 * - `GET /meta/permissions` is asked once, when the app boots. It answers for
 *   the API as a whole, with no queue, and decides which nav entries exist.
 * - `GET /meta/permissions?queue=<q>` is asked on every screen under
 *   `/queues/:queue`, so a host whose `authorize` decides per queue gets
 *   buttons that match. Until that answer arrives, or if it fails, the screen
 *   uses the untargeted map.
 * - An action is on only when the map holds it **and** it is `true`. A route
 *   that is not registered (for example because of `readOnly`, `actions` or the
 *   driver's features) is absent from the map.
 * - **The server's 403 is authoritative.** A hidden button is only a courtesy.
 *   A client that sends the request anyway gets the same answer from
 *   `authorize`, and so does a request the map allowed but `authorize` refuses
 *   for one particular job.
 *
 * So everything the UI gates on can be checked here, deterministically,
 * without a browser. This example uses a host with three queues:
 *
 * | Queue     | This caller may                                   |
 * |-----------|---------------------------------------------------|
 * | `mail`    | everything, except touch a job whose id starts `vip-` |
 * | `audit`   | read, but change nothing                          |
 * | `payroll` | nothing queue-scoped at all                       |
 *
 * `screenGates()` below restates the UI's own rules as one pure function of
 * what the screens read: `/meta`, the `sections` the UI was given, the
 * untargeted map, the queue's map, the queue's detail and the job. It is
 * written as `GATES`, one entry per element of the package README's table
 * "What each element needs" (`packages/bun-jobs-ui/README.md`), and the
 * next step **parses that table and compares it with `GATES`**, row for row
 * and action for action, so the two cannot drift apart unnoticed.
 *
 * Three rules in it are easy to miss:
 *
 * - **Pause and Resume depend on the queue's state.** The paused flag comes
 *   from the queue's detail, which the screen reads only with `queues.read`,
 *   so Pause shows on a running queue and Resume on a paused one, never both.
 * - **Bulk Retry, Promote and Remove sit in the jobs table**, so they need
 *   `jobs.list` as well as their own action.
 * - **The job screen needs `jobs.read` on the queue's map.** Without it the
 *   screen shows "Job hidden" instead of fetching the job. While the queue's
 *   map is still loading the untargeted one stands in, so a host that grants
 *   `jobs.read` there lets one job request out before the queue's "no" lands.
 *   The browser example (`06-browser/`) shows a host that answers `false`
 *   untargeted, so nothing is fetched at all.
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
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("What each screen needs: permissions, per queue");

/**
 * The body of `GET /meta/permissions`, from the browser-safe contract the UI
 * itself is built on: `actions` holds every action the API routes.
 */
type PermissionsBody = PermissionsDto;

/* ------------------------------------------------------------------ */
step("A host whose authorize decides per queue");

const jobs = new BunJobs({
  namespace: "examples-ui-permissions",
  driver: new MemoryDriver(),
  logger: noopLogger,
});

/** Every `authorize` call, for counting what `/meta/permissions` costs. */
const asked: { action: JobsApiAction; queue?: string; jobId?: string }[] = [];

/**
 * The host's decision. `ctx.queue` is set for every queue-side action,
 * including when `/meta/permissions?queue=` asks, and `ctx.jobId` for a
 * single-job route. It is **absent** for the untargeted map, so this function
 * gives every mutation there a "no": a mutation always names a queue when it
 * is really sent, so only the per-queue answer can say yes.
 */
const authorize: JobsApiAuthorize = (_req, ctx) => {
  asked.push({ action: ctx.action, queue: ctx.queue, jobId: ctx.jobId });

  if (ctx.queue === "payroll") {
    return { allow: false, reason: "payroll is restricted" };
  }
  if (!ctx.mutation) {
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
    reason: `read-only on ${ctx.queue ?? "this API"}`,
  };
};

const api = createJobsApi({
  jobs,
  basePath: "/jobs-api",
  // Queues only: no runner routes, so the maps below are shorter.
  mode: "jobs",
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

/** Everything a screen decides from. */
interface ScreenInputs {
  /** `GET /meta`. */
  meta: MetaDto;
  /** The `sections` the UI was configured with (`ui.config.sections`). */
  sections: UiSections;
  /** The untargeted `GET /meta/permissions`: the nav, `/` and `/queues*`. */
  boot: PermissionsBody;
  /**
   * `GET /meta/permissions?queue=<q>`: every element inside that queue's
   * screens. While it loads, or if it fails, the app uses `boot` here.
   */
  scoped: PermissionsBody;
  /**
   * `GET /queues/<q>`, which the queue screen requests only with
   * `queues.read`; `undefined` without it. Pause, Resume and the limits panel
   * read it.
   */
  detail?: QueueDetailDto;
  /** The job on the job screen, whose state picks Retry or Promote. */
  job?: { state: JobState };
}

/**
 * One element's rule, stated the way the README's table states it, so the
 * table can be checked against it mechanically.
 */
interface Gate {
  /** The name this example prints for the element. */
  readonly name: string;
  /** The README table's "Element" cell it is (part of), verbatim. */
  readonly row: string;
  /** Which map decides: `boot` outside a queue, `scoped` inside one. */
  readonly map: "boot" | "scoped";
  /** Actions that must all be granted. */
  readonly reads?: readonly JobsApiAction[];
  /** Actions of which at least one must be granted. */
  readonly anyOf?: readonly JobsApiAction[];
  /** Mutations that must all be granted, and are off when `meta.readOnly`. */
  readonly mutations?: readonly JobsApiAction[];
  /** `/meta` features that must all be on. */
  readonly features?: readonly Feature[];
  /** UI sections that must all be on. */
  readonly sections?: readonly (keyof UiSections)[];
  /** `meta.mode` must be `jobs` or `both`. */
  readonly jobsMode?: boolean;
  /** The gate this one adds to ("the above" in the README). */
  readonly extends?: string;
  /** Whatever else it needs that no permission expresses. */
  readonly when?: (inputs: ScreenInputs) => boolean;
}

/**
 * Every element of the queue and job screens, in the README table's order.
 * A row that names several elements (Pause / Resume, the bulk buttons) has
 * one entry per element, sharing its `row`.
 */
const GATES = [
  {
    name: "Overview: nav and /",
    row: "Overview nav entry and `/`",
    map: "boot",
    sections: ["manage"],
    jobsMode: true,
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
    jobsMode: true,
    reads: ["queues.list"],
  },
  {
    name: "queue: header total, paused badge",
    row: "Queue header total and paused badge",
    map: "scoped",
    reads: ["queues.read"],
  },
  {
    name: "queue: jobs table",
    row: "Jobs table, and the job links in it",
    map: "scoped",
    reads: ["jobs.list"],
  },
  {
    name: "queue: Pause",
    row: "Pause / Resume",
    map: "scoped",
    reads: ["queues.read"],
    mutations: ["queues.pause"],
    // The paused flag is the detail's, read only with queues.read.
    when: ({ detail }) => detail?.paused === false,
  },
  {
    name: "queue: Resume",
    row: "Pause / Resume",
    map: "scoped",
    reads: ["queues.read"],
    mutations: ["queues.resume"],
    when: ({ detail }) => detail?.paused === true,
  },
  {
    name: "queue: Drain…",
    row: "Drain…, Clean…, Retry all…",
    map: "scoped",
    mutations: ["queues.drain"],
  },
  {
    name: "queue: Clean…",
    row: "Drain…, Clean…, Retry all…",
    map: "scoped",
    mutations: ["queues.clean"],
  },
  {
    name: "queue: Retry all…",
    row: "Drain…, Clean…, Retry all…",
    map: "scoped",
    mutations: ["jobs.retryAll"],
  },
  {
    name: "queue: Add job",
    row: "Add job",
    map: "scoped",
    mutations: ["jobs.add"],
    when: ({ meta }) =>
      meta.addableNames === null || meta.addableNames.length > 0,
  },
  {
    name: "queue: Add job's name suggestions",
    row: "Add job's name suggestions",
    map: "scoped",
    reads: ["definitions.list"],
    when: ({ meta }) => meta.addableNames === null,
  },
  // In the jobs table, so each needs jobs.list too.
  {
    name: "queue: bulk Retry selected",
    row: "Bulk Retry / Promote / Remove selected",
    map: "scoped",
    reads: ["jobs.list"],
    mutations: ["jobs.retry"],
  },
  {
    name: "queue: bulk Promote selected",
    row: "Bulk Retry / Promote / Remove selected",
    map: "scoped",
    reads: ["jobs.list"],
    mutations: ["jobs.promote"],
  },
  {
    name: "queue: bulk Remove selected…",
    row: "Bulk Retry / Promote / Remove selected",
    map: "scoped",
    reads: ["jobs.list"],
    mutations: ["jobs.remove"],
  },
  {
    name: "panel=limits",
    row: "Limits panel",
    map: "scoped",
    reads: ["queues.read"],
    features: ["limits"],
    // The key is absent when the backend cannot store limits; `null` (none
    // set) still shows the panel.
    when: ({ detail }) => detail !== undefined && "limits" in detail,
  },
  {
    name: "panel=limits, editable",
    row: "Limits panel, editable",
    map: "scoped",
    extends: "panel=limits",
    mutations: ["queues.limits"],
  },
  {
    name: "panel=workers",
    row: "Workers panel",
    map: "scoped",
    reads: ["workers.list"],
    features: ["workers"],
  },
  {
    name: "panel=throughput",
    row: "Throughput panel",
    map: "scoped",
    reads: ["metrics.read"],
    features: ["throughput"],
  },
  {
    name: "panel=repeatables",
    row: "Repeatables panel",
    map: "scoped",
    reads: ["repeatables.list"],
  },
  {
    name: "panel=repeatables, Remove",
    row: "Repeatables panel, Remove",
    map: "scoped",
    extends: "panel=repeatables",
    mutations: ["repeatables.remove"],
  },
  {
    // Without it: "Job hidden", and the job is not requested.
    name: "job: screen",
    row: "Job screen",
    map: "scoped",
    reads: ["jobs.read"],
  },
  {
    name: "job: logs",
    row: "Job logs",
    map: "scoped",
    reads: ["jobs.logs"],
    features: ["logs"],
  },
  {
    name: "job: Retry",
    row: "Job Retry",
    map: "scoped",
    mutations: ["jobs.retry"],
    when: ({ job }) => job !== undefined && FINISHED.has(job.state),
  },
  {
    name: "job: Promote",
    row: "Job Promote",
    map: "scoped",
    mutations: ["jobs.promote"],
    when: ({ job }) => job?.state === "delayed",
  },
  {
    name: "job: Remove",
    row: "Job Remove",
    map: "scoped",
    mutations: ["jobs.remove"],
  },
  {
    name: "job: Edit",
    row: "Job Edit",
    map: "scoped",
    mutations: ["jobs.update"],
    features: ["update"],
  },
] as const satisfies readonly Gate[];

/** The name of every gate. */
type GateName = (typeof GATES)[number]["name"];

/** Every gate, open or not. */
type Gates = Record<GateName, boolean>;

/** Whether one gate is open. */
function isOpen(gate: Gate, inputs: ScreenInputs): boolean {
  const { meta } = inputs;
  const permissions = gate.map === "boot" ? inputs.boot : inputs.scoped;
  const parent = GATES.find((other) => other.name === gate.extends);
  return (
    (parent === undefined || isOpen(parent, inputs)) &&
    (gate.sections ?? []).every((section) => inputs.sections[section]) &&
    (!gate.jobsMode || meta.mode === "jobs" || meta.mode === "both") &&
    (gate.reads ?? []).every((action) => can(permissions, action)) &&
    (gate.anyOf === undefined ||
      gate.anyOf.some((action) => can(permissions, action))) &&
    (gate.mutations ?? []).every(
      (action) => !meta.readOnly && can(permissions, action),
    ) &&
    (gate.features ?? []).every((feature) => meta.features[feature]) &&
    (gate.when?.(inputs) ?? true)
  );
}

/**
 * What the screens show, for one caller, one queue and (for the job
 * buttons) one job. An element that is not allowed is absent, not disabled.
 */
function screenGates(inputs: ScreenInputs): Gates {
  return Object.fromEntries(
    GATES.map((gate) => [gate.name, isOpen(gate, inputs)]),
  ) as Gates;
}

/** Every gate set to `value`. */
function allGates(value: boolean): Gates {
  return Object.fromEntries(GATES.map((gate) => [gate.name, value])) as Gates;
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

/** Every routed action name, to pick actions out of the README's prose. */
const ACTION_NAMES: ReadonlySet<string> = new Set(JOBS_API_ACTIONS);

/** What a "Needs" cell (or a row's gates) asks for, as comparable lists. */
function needsOfCell(needs: string) {
  const codes = [...needs.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
  return {
    actions: codes.filter((code) => ACTION_NAMES.has(code)).sort(),
    features: codes
      .filter((code) => code.startsWith("features."))
      .map((code) => code.slice("features.".length))
      .sort(),
    sections: codes
      .filter((code) => code.startsWith("sections."))
      .map((code) => code.slice("sections.".length))
      .sort(),
    mode: codes.includes("meta.mode"),
    mutation: /\bmutation\b/.test(needs),
    extendsAbove: needs.startsWith("the above"),
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
      ]),
    ),
    features: unique(gates.flatMap((gate) => gate.features ?? [])),
    sections: unique(gates.flatMap((gate) => gate.sections ?? [])),
    mode: gates.some((gate) => gate.jobsMode === true),
    mutation: gates.some((gate) => (gate.mutations ?? []).length > 0),
    extendsAbove: gates.some((gate) => gate.extends !== undefined),
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
    needsOfCell(row.needs),
    needsOfGates(gates),
  );
}
checkEqual(
  'a row the README calls "(untargeted)" is decided on the boot map',
  readme
    .filter((row) => row.needs.includes("(untargeted)"))
    .filter((row) =>
      GATES.some(
        (gate: Gate) => gate.row === row.element && gate.map !== "boot",
      ),
    )
    .map((row) => row.element),
  [],
);
// A mutation in the prose is a mutation to the API, and a read is not.
checkEqual(
  "every gate's mutations are mutations, and its reads are not",
  GATES.flatMap((gate: Gate) => [
    ...(gate.mutations ?? []).filter(
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

// One `authorize` call per action the API routes, asked with no queue, plus
// one for the request itself (`meta.read`, which guards /meta/permissions).
checkEqual(
  "authorize was asked once per routed action, plus once for the request",
  [asked.length, asked.every((call) => call.queue === undefined)],
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
  "and no mutation: none names a queue here",
  routed.filter(
    (action) => JOBS_API_MUTATIONS.has(action) && boot.actions[action],
  ),
  [],
);
checkEqual(
  "mode: 'jobs' routes no runner action",
  routed.filter((action) => action.startsWith("runners.")),
  [],
);
check(
  "queues.list is true, so the Queues nav entry and its routes exist",
  can(boot, "queues.list"),
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
const fallback = screenGates({
  meta,
  sections,
  boot,
  scoped: boot,
  detail: await detailFor("mail", boot),
});
checkEqual(
  "before ?queue= loads, the fallback shows no mutation",
  GATES.filter(
    (gate: Gate) =>
      gate.mutations !== undefined && fallback[gate.name as GateName],
  ).map((gate) => gate.name),
  [],
);
// The fallback decides the job screen too, and this host says yes to every
// read there. So on payroll, whose own map says no, one job request goes out
// before that "no" arrives, and the API answers it 403 (see below).
check(
  "while the job screen's jobs.read is the untargeted yes",
  fallback["job: screen"],
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
          !call.action.startsWith("events."),
      )
      .every((call) => call.queue === queue),
    asked,
  );
}

/** The gates of one queue's screens, for this caller. */
function queueGates(queue: string, job?: { state: JobState }): Gates {
  return screenGates({
    meta,
    sections,
    boot,
    scoped: maps[queue]!,
    detail: details[queue],
    job,
  });
}

const gates = {
  mail: queueGates("mail"),
  audit: queueGates("audit"),
  payroll: queueGates("payroll"),
};

/** Prints gates side by side, one column per queue. */
function printGates(columns: Record<string, Gates>): void {
  console.table(
    Object.fromEntries(
      GATES.map(({ name }) => [
        name,
        Object.fromEntries(
          Object.entries(columns).map(([queue, set]) => [queue, set[name]]),
        ),
      ]),
    ),
  );
}
printGates(gates);

/** The gates decided on the untargeted map: the same on every queue. */
const bootGates = {
  "Overview: nav and /": true,
  "Overview: counts": true,
  "Overview: queue table": true,
  "Overview: sparklines": true,
  "Queues: nav and /queues*": true,
} as const;

// mail: everything the screens offer, for a running queue.
checkEqual("mail (running): every gate is open but three", gates.mail, {
  ...allGates(true),
  // A running queue offers Pause, not Resume; checked paused below.
  "queue: Resume": false,
  // addableNames is ["send-email"], so the dialog offers that name, not a
  // search of the registered definitions.
  "queue: Add job's name suggestions": false,
  // The job gates that depend on a job's state; asked below with one.
  "job: Retry": false,
  "job: Promote": false,
});

// audit: every read, no action.
checkEqual("audit: reads only", gates.audit, {
  ...allGates(false),
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
checkEqual("payroll: only what the untargeted map decides", gates.payroll, {
  ...allGates(false),
  ...bootGates,
});
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
step("readOnly: every mutation is absent from the map, not false");

const readOnlyApi = createJobsApi({
  jobs,
  basePath: "/ro-api",
  mode: "jobs",
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
  "so the screens offer none: the same gates as audit",
  screenGates({
    meta: roMeta,
    sections,
    boot: roMap,
    scoped: roMap,
    detail: (await (
      await readOnlyApp.fetch("/ro-api/queues/mail")
    ).json()) as QueueDetailDto,
  }),
  gates.audit,
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
await jobs.close();
