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
 * `screenGates()` below restates the UI's own rules (`app/screens/queues/
 * gating.ts`, `QueueScreen.tsx`, `QueueActions.tsx`, `JobsTable.tsx`,
 * `app/screens/job/jobGates.ts`, `JobScreen.tsx`) as one pure function of
 * `/meta` and a permissions map. That is the whole projection: those are the
 * only inputs the screens use to decide what to show.
 */
import type {
  JobsApiAction,
  JobsApiAuthorize,
  JobState,
  MetaDto,
} from "@kingsleyweb/bun-jobs";
import type { PermissionsDto } from "@kingsleyweb/bun-jobs/api/contract";
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
});

/* ------------------------------------------------------------------ */
step("The UI's rules, as one function of /meta and a permissions map");

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

/**
 * What the queue and job screens show, for one caller and one queue.
 *
 * Mutations are also off whenever `meta.readOnly` is set, whatever the map
 * says (`useCanMutate`). A panel that is not allowed is absent, not disabled.
 */
function screenGates(
  meta: MetaDto,
  permissions: PermissionsBody,
  job?: { state: JobState },
) {
  const mutate = (action: JobsApiAction) =>
    !meta.readOnly && can(permissions, action);
  return {
    // The nav entry and the /queues routes: from the UNTARGETED map only.
    // (Evaluated by the caller, below, on the boot map.)
    "list: queues.list": can(permissions, "queues.list"),
    // /queues/:queue
    "queue: header and counts (queues.read)": can(permissions, "queues.read"),
    "queue: jobs table (jobs.list)": can(permissions, "jobs.list"),
    "queue: Pause/Resume": mutate("queues.pause") || mutate("queues.resume"),
    "queue: Drain…": mutate("queues.drain"),
    "queue: Clean…": mutate("queues.clean"),
    "queue: Retry all…": mutate("jobs.retryAll"),
    "queue: Add job":
      mutate("jobs.add") &&
      (meta.addableNames === null || meta.addableNames.length > 0),
    "queue: bulk Retry selected": mutate("jobs.retry"),
    "queue: bulk Promote selected": mutate("jobs.promote"),
    "queue: bulk Remove selected…": mutate("jobs.remove"),
    // It shows the queue detail's `limits`, so it needs the detail's read.
    "panel=limits": meta.features.limits && can(permissions, "queues.read"),
    "panel=limits, editable":
      meta.features.limits &&
      can(permissions, "queues.read") &&
      mutate("queues.limits"),
    "panel=workers": meta.features.workers && can(permissions, "workers.list"),
    "panel=throughput":
      meta.features.throughput && can(permissions, "metrics.read"),
    "panel=repeatables": can(permissions, "repeatables.list"),
    "panel=repeatables, Remove":
      can(permissions, "repeatables.list") && mutate("repeatables.remove"),
    // /queues/:queue/jobs/:id
    "job: logs": meta.features.logs && can(permissions, "jobs.logs"),
    "job: Retry":
      mutate("jobs.retry") && job !== undefined && FINISHED.has(job.state),
    "job: Promote": mutate("jobs.promote") && job?.state === "delayed",
    "job: Remove": mutate("jobs.remove"),
    "job: Update": mutate("jobs.update") && meta.features.update,
  };
}

/** Every gate `screenGates` reports. */
type Gates = ReturnType<typeof screenGates>;

/** Every gate set to `value`. */
function allGates(value: boolean): Gates {
  const gates = screenGates(meta, { actions: {} });
  for (const key of Object.keys(gates) as (keyof Gates)[]) {
    gates[key] = value;
  }
  return gates;
}

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

// This is also the fallback: until `?queue=` answers, or if it fails, a
// queue screen shows no mutation at all. A per-queue host that answered
// `true` here would instead show buttons that the per-queue map then hides.
checkEqual(
  "before ?queue= loads, the fallback shows no action button",
  Object.entries(screenGates(meta, boot))
    .filter(
      ([name, on]) =>
        on &&
        /Pause|Drain|Clean|Retry|Add|Promote|Remove|Update|editable/.test(name),
    )
    .map(([name]) => name),
  [],
);

/* ------------------------------------------------------------------ */
step("GET /meta/permissions?queue=…: what each queue screen shows");

const maps: Record<string, PermissionsBody> = {};
for (const queue of ["mail", "audit", "payroll"]) {
  asked.length = 0;
  const { status, body } = await get<PermissionsBody>(
    `/meta/permissions?queue=${queue}`,
  );
  maps[queue] = body;
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

const gates = {
  mail: screenGates(meta, maps.mail!),
  audit: screenGates(meta, maps.audit!),
  payroll: screenGates(meta, maps.payroll!),
};
console.table(
  Object.fromEntries(
    Object.keys(gates.mail).map((gate) => [
      gate,
      {
        mail: gates.mail[gate as keyof Gates],
        audit: gates.audit[gate as keyof Gates],
        payroll: gates.payroll[gate as keyof Gates],
      },
    ]),
  ),
);

// mail: everything the screens offer.
checkEqual("mail: every gate is open", gates.mail, {
  ...allGates(true),
  // The job gates need a job; asked below with one.
  "job: Retry": false,
  "job: Promote": false,
});

// audit: every read, no action.
checkEqual("audit: reads only", gates.audit, {
  ...allGates(false),
  "list: queues.list": true,
  "queue: header and counts (queues.read)": true,
  "queue: jobs table (jobs.list)": true,
  "panel=limits": true,
  "panel=workers": true,
  "panel=throughput": true,
  "panel=repeatables": true,
  "job: logs": true,
});

// payroll: authorize refuses every queue-side action, so the screen shows
// no header counts, no jobs table and no panels. `queues.list` is decided on
// the untargeted map (it lists every queue), so the list still shows payroll
// and links to that empty screen.
checkEqual("payroll: nothing", gates.payroll, allGates(false));
check(
  "while the untargeted map, which gates the list, still says queues.list",
  can(boot, "queues.list") && !can(maps.payroll!, "queues.list"),
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
    screenGates(meta, maps.mail!, dead)["job: Retry"],
    screenGates(meta, maps.mail!, dead)["job: Promote"],
  ],
  [true, false],
);
checkEqual(
  "mail, a delayed job: Promote, not Retry",
  [
    screenGates(meta, maps.mail!, delayed)["job: Retry"],
    screenGates(meta, maps.mail!, delayed)["job: Promote"],
  ],
  [false, true],
);
checkEqual(
  "audit, a dead job: no Retry",
  screenGates(meta, maps.audit!, dead)["job: Retry"],
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
await send("POST", "/queues/mail/resume");

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
  screenGates(roMeta, roMap),
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

summary();

await api.close();
await jobs.close();
