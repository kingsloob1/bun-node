/**
 * Option tour: `createJobsApi` — every configuration option, what it refuses
 * at construction, how the four pruning rules interact, and what a caller is
 * told (and never told) when something goes wrong.
 *
 * ```bash
 * bun 10-options/jobs-api-options.ts
 * EXAMPLE_DRIVER=sqlite bun 10-options/jobs-api-options.ts
 * ```
 *
 * The socket's own options are the next tour,
 * [`jobs-api-socket-options.ts`](./jobs-api-socket-options.ts).
 *
 * What is worth knowing before reading the checks:
 *
 * - **Everything unusable is refused at construction**, with a `ConfigError`.
 *   An API that starts and then answers every request with a 500 — or, worse,
 *   answers them all without asking `authorize` — is a failure discovered in
 *   production.
 * - **Four rules prune routes**, and they prune the router, both documents and
 *   `/meta/permissions` together: `mode`, `readOnly`, the `actions` allow-list
 *   and what the driver supports. A route that cannot work is not registered,
 *   so it answers the API's JSON 404 rather than a 403 or a 501.
 * - **`authorize` is asked exactly once per request.** When a check fails
 *   first — validation, CSRF, a malformed body — it is still asked with the
 *   target the path names (the queue, job or runner, and `ctx.route`), and
 *   only a caller it allows is told what was wrong. That is what keeps a
 *   caller from probing a route's schema, and why a host that refuses one
 *   queue answers 403 there even to a bad body. Only an invalid *path* is
 *   asked about with no target.
 * - **A 5xx never carries the underlying message.** Its `detail` is the
 *   generic title, always.
 * - **Adding a queue's first job creates it**, as `BunQueue.add` does: a
 *   `POST /queues/:queue/jobs` with an addable name is 201 for a queue the
 *   backend has never seen. Only a configured `queues` list still makes an
 *   unknown queue a 404.
 * - **`/meta/permissions` previews each action as its real request asks
 *   it**: `ctx.route` is a route the action really has, so an `authorize`
 *   that decides by route answers the map as it answers the request. It
 *   costs N + 1 calls: the request's own `meta.read`, then one per action.
 * - **`listQueues: "authorized"`** hides the queues `authorize` denies
 *   `queues.read` on from `GET /queues` (paging counts only what is shown)
 *   and `/overview`, at one call per queue.
 * - **A runner's `status` is its lifecycle**, not a run in flight: `idle`
 *   is not started, `running` is started with its schedule armed. Whether a
 *   run is in flight is `isRunning`, on every list item, remote ones too.
 * - **A worker record's `rssBytes` and `heartbeatRttMs` are optional
 *   everywhere**, including on the contract: absent, never `0`, on a record
 *   that lacks them. `rssBytes` is the *process's* memory, so a column of it
 *   must never be summed — [`read-apis.ts`](./read-apis.ts) covers the record
 *   itself and how to total a fleet.
 * - **`sweeps` is optional in the same way, and absent is not `false`**: it
 *   says whether a worker does the queue's housekeeping, and a worker too old
 *   to have the field has said nothing. It says nothing about liveness either
 *   way. [`read-apis.ts`](./read-apis.ts) has the rule a reader applies to it.
 */
import type {
  DriverEvent,
  JobsApiAction,
  JobsApiAuthorizeContext,
  JobsDriver,
} from "@kingsleyweb/bun-jobs";
import type {
  DisableRepeatableResultDto,
  EnableRepeatableResultDto,
  FailJobBody,
  FailJobResultDto,
  PermissionsDto,
  RepeatableDto,
  RunnerInfoDto,
  RunnerListItemDto,
  WorkerDto,
} from "@kingsleyweb/bun-jobs/api/contract";
import { BunRouter, createTestLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  BunQueueWorker,
  createDriver,
  createJobsApi,
  DEFAULT_JOBS_API_LIMITS,
  JOBS_API_ACTIONS,
  JOBS_API_MUTATIONS,
  JOBS_API_OPT_IN_ACTIONS,
  JobsNotifier,
  registerWorkerRecord,
  runnerKey,
} from "@kingsleyweb/bun-jobs";
import {
  JOBS_API_ACTIONS as CONTRACT_ACTIONS,
  MAX_DATE_MS,
  MAX_JOB_ID_LENGTH,
  MAX_JOB_REF_LENGTH,
  MAX_NAME_LENGTH,
  NAME_PARAM_PATTERN,
} from "@kingsleyweb/bun-jobs/api/contract";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title, waitFor } from "../shared/console";

title("Option tour: the management API");

const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("tour-api");

/** A message that must never reach a client. */
const SECRET = "SECRET-connection-string-7f3a";

/** Contexts opened by the tour, closed at the end. */
const contexts: BunJobs[] = [];

/** A fresh context on the shared backend, in its own namespace. */
function context(suffix: string): BunJobs {
  const jobs = new BunJobs({
    namespace: `${namespace}-${suffix}`,
    driver,
    logger: createTestLogger().logger,
  });
  contexts.push(jobs);
  return jobs;
}

/**
 * A driver with some optional methods hidden, so a capability check sees what
 * an older or simpler backend looks like. Methods are bound to the real
 * driver, so its own state still works.
 */
function without(real: JobsDriver, methods: string[]): JobsDriver {
  return new Proxy(real, {
    get(target, property) {
      if (methods.includes(property as string)) {
        return undefined;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** What one request through a mounted API answered. */
interface Answer {
  /** The HTTP status. */
  status: number;
  /** The parsed JSON body, or `undefined` for an empty one. */
  body: any;
  /** The raw body text, for asserting what it does *not* contain. */
  text: string;
  /** The response headers. */
  headers: Headers;
}

/** A mounted API, with every `authorize` call recorded. */
function mount(
  overrides: Partial<Parameters<typeof createJobsApi>[0]> = {},
  jobs: BunJobs = context("mount"),
) {
  const { logger, events } = createTestLogger();
  const calls: JobsApiAuthorizeContext[] = [];
  const api = createJobsApi({
    jobs,
    basePath: "/admin/jobs",
    logger,
    limits: { queueCacheMs: 0 },
    authorize: (_req, authorizeContext) => {
      calls.push(authorizeContext);
      return true;
    },
    ...overrides,
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);

  /** Sends one request under the base path; anything but GET is JSON. */
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Answer> => {
    const init: RequestInit = {
      method,
      headers:
        method === "GET"
          ? headers
          : { "content-type": "application/json", ...headers },
    };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const response = await root.fetch(`/admin/jobs${path}`, init);
    const text = await response.text();
    // Every error and every data route answers JSON; the docs pages answer
    // HTML, so the body is parsed only when it says it is JSON.
    const isJson = (response.headers.get("content-type") ?? "").includes(
      "json",
    );
    return {
      status: response.status,
      body: text && isJson ? JSON.parse(text) : undefined,
      text,
      headers: response.headers,
    };
  };

  return { api, jobs, root, call, calls, events };
}

/** `true` only when `A` and `B` are exactly the same type. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Compiles only when given `true`: a positive compile-time assertion. */
type Expect<T extends true> = T;

/**
 * Holds code that exists for the typecheck alone, without running it: the
 * `@ts-expect-error` lines inside are what prove a type refuses something.
 */
function compileOnly(_controls: () => unknown): void {}

/** Operation ids of an API's routes. */
const idsOf = (api: { routes: readonly { operationId: string }[] }) =>
  api.routes.map((route) => route.operationId);

/**
 * The three routes the per-job methods added, as `api.routes` lists them:
 * failing a job for good, and disabling or enabling a repeat series. All
 * three are mutations in the jobs half, and all three are on by default.
 */
const JOB_METHOD_ROUTES = [
  "POST /admin/jobs/queues/:queue/jobs/:id/fail failJob jobs.fail",
  "POST /admin/jobs/queues/:queue/repeatables/:key/disable disableRepeatable repeatables.disable",
  "POST /admin/jobs/queues/:queue/repeatables/:key/enable enableRepeatable repeatables.enable",
];

/**
 * Which of {@link JOB_METHOD_ROUTES} an API registered, in the same one-line
 * shape, with each marked `mutation` or not so a check names what is wrong.
 */
function jobMethodRoutes(api: {
  routes: readonly {
    method: string;
    path: string;
    operationId: string;
    action: string;
    mutation: boolean;
  }[];
}): string[] {
  const ids = new Set(["failJob", "disableRepeatable", "enableRepeatable"]);
  return api.routes
    .filter((route) => ids.has(route.operationId))
    .map((route) =>
      [
        route.method,
        route.path,
        route.operationId,
        route.action,
        ...(route.mutation ? [] : ["(not a mutation)"]),
      ].join(" "),
    )
    .sort();
}

/* ------------------------------------------------------------------ */
step("Construction: everything unusable is refused, with a ConfigError");

await checkRejects(
  "no authorize and no allowUnauthenticated",
  () => createJobsApi({ jobs: context("c1"), basePath: "/admin/jobs" }),
  { name: "ConfigError", code: "CONFIG", message: /needs `authorize`/ },
);

await checkRejects(
  "a relative basePath",
  () =>
    createJobsApi({
      jobs: context("c2"),
      basePath: "admin/jobs",
      allowUnauthenticated: true,
      logger: createTestLogger().logger,
    }),
  { code: "CONFIG", message: /absolute path/ },
);

await checkRejects(
  'basePath "/"',
  () =>
    createJobsApi({
      jobs: context("c3"),
      basePath: "/",
      allowUnauthenticated: true,
      logger: createTestLogger().logger,
    }),
  { code: "CONFIG", message: /may not be "\/"/ },
);

await checkRejects(
  "an unknown action",
  () =>
    createJobsApi({
      jobs: context("c4"),
      basePath: "/admin/jobs",
      authorize: () => true,
      actions: ["jobs.nuke" as never],
    }),
  { code: "CONFIG", message: /Unknown action\(s\): jobs\.nuke/ },
);

await checkRejects(
  "no jobs, queues or runners to manage",
  () => createJobsApi({ basePath: "/admin/jobs", authorize: () => true }),
  { code: "CONFIG", message: /needs `jobs`/ },
);

// A sixth, and the reason it exists: `credentials: true` with an origin that
// reflects the caller's own hands every website an authenticated session.
for (const origin of [undefined, true, "*", ["https://a.example", "*"]]) {
  await checkRejects(
    `cors credentials with origin ${JSON.stringify(origin) ?? "undefined"}`,
    () =>
      createJobsApi({
        jobs: context("c5"),
        basePath: "/admin/jobs",
        authorize: () => true,
        cors: { credentials: true, origin: origin as never },
      }),
    { code: "CONFIG", message: /credentials: true/ },
  );
}

// A path that is a route pattern would make the mount a pattern too, while
// the socket's path is matched exactly — the two would silently disagree.
await checkRejects(
  "a basePath with route syntax",
  () =>
    createJobsApi({
      jobs: context("c6"),
      basePath: "/admin/:tenant",
      authorize: () => true,
    }),
  { code: "CONFIG", message: /segments/ },
);

/* ------------------------------------------------------------------ */
step("allowUnauthenticated: allowed, but it says so every time");

const open = createTestLogger();
const openApi = createJobsApi({
  jobs: context("open"),
  basePath: "/admin/jobs",
  allowUnauthenticated: true,
  logger: open.logger,
});
check(
  "it warns on construction",
  open.events.some(
    (event) => event.level === "warn" && /unauthenticated/.test(event.message),
  ),
  open.events.map((event) => event.message),
);
checkEqual(
  "and every route is open",
  (await openApi.router.fetch("/meta")).status,
  200,
);
await openApi.close();

// `authorize` wins when both are given, and nothing is logged about being open.
const guarded = createTestLogger();
const guardedApi = createJobsApi({
  jobs: context("guarded"),
  basePath: "/admin/jobs",
  authorize: () => false,
  allowUnauthenticated: true,
  logger: guarded.logger,
});
checkEqual(
  "authorize wins over allowUnauthenticated",
  (await guardedApi.router.fetch("/meta")).status,
  403,
);
check(
  "and nothing is logged about being open",
  !guarded.events.some((event) => /unauthenticated/.test(event.message)),
  guarded.events.map((event) => event.message),
);
await guardedApi.close();

/* ------------------------------------------------------------------ */
step("basePath, sources and mode");

const trailing = mount({ basePath: "/admin/jobs/" });
checkEqual("a trailing slash is trimmed", trailing.api.basePath, "/admin/jobs");
await trailing.api.close();

const both = mount({ actions: [...JOBS_API_ACTIONS] });
checkEqual(
  "mode defaults to both when both sources exist",
  both.api.mode,
  "both",
);
// Two routes read how many jobs were added per state — `getAddedByState` and
// `getQueueAddedByState` — and a backend that keeps no such counts (the file
// and Redis drivers) prunes both. Every count below is two lower there.
const bothFeatures = (await both.call("GET", "/meta")).body.features;
const addedByState = bothFeatures.addedByState ? 2 : 0;
checkEqual(
  "every action, every route",
  both.api.routes.length,
  70 + addedByState,
);
checkEqual(
  "fail, disable and enable are among them, each a mutation",
  jobMethodRoutes(both.api),
  [...JOB_METHOD_ROUTES].sort(),
);
/** The actions those three routes authorize; a rename fails to compile. */
const jobMethodActions: JobsApiAction[] = [
  "jobs.fail",
  "repeatables.disable",
  "repeatables.enable",
];
check(
  "and each has its own action, listed and a mutation",
  jobMethodActions.every(
    (action) =>
      JOBS_API_ACTIONS.includes(action) && JOBS_API_MUTATIONS.has(action),
  ),
);

const noRunners = mount({ runners: false, actions: [...JOBS_API_ACTIONS] });
checkEqual('runners: false leaves mode "jobs"', noRunners.api.mode, "jobs");
check(
  "and no runner route is registered",
  !idsOf(noRunners.api).some((id) => id.toLowerCase().includes("runner")),
);
await checkRejects(
  "a mode whose half has no source",
  () =>
    createJobsApi({
      jobs: context("c7"),
      basePath: "/admin/jobs",
      authorize: () => true,
      runners: false,
      mode: "runner",
    }),
  { code: "CONFIG", message: /no source/ },
);

// A `queues` list restricts what the API can reach at all.
const listed = mount({ queues: ["mail"], actions: [...JOBS_API_ACTIONS] });
await listed.jobs.queue("mail").add("send", {});
await listed.jobs.queue("secret").add("send", {});
checkEqual(
  "a queues list is the only thing /queues reports",
  (await listed.call("GET", "/queues")).body.items.map(
    (queue: any) => queue.name,
  ),
  ["mail"],
);
checkEqual(
  "and a queue outside it is not found",
  (await listed.call("GET", "/queues/secret/counts")).status,
  404,
);

/* ------------------------------------------------------------------ */
step("mode prunes both halves, and /meta reports which");

const jobsOnly = mount({ mode: "jobs", actions: [...JOBS_API_ACTIONS] });
const runnerOnly = mount({ mode: "runner", actions: [...JOBS_API_ACTIONS] });
checkEqual("mode: jobs", jobsOnly.api.routes.length, 54 + addedByState);
checkEqual(
  "fail, disable and enable belong to the jobs half",
  [jobMethodRoutes(jobsOnly.api), jobMethodRoutes(runnerOnly.api)],
  [[...JOB_METHOD_ROUTES].sort(), []],
);
checkEqual("mode: runner", runnerOnly.api.routes.length, 20);
checkEqual(
  "the two halves plus the shared routes are the whole API",
  jobsOnly.api.routes.length + runnerOnly.api.routes.length - 4,
  both.api.routes.length,
);
checkEqual(
  "/meta reports the effective mode",
  (await jobsOnly.call("GET", "/meta")).body.mode,
  "jobs",
);
checkEqual(
  "a runner route in mode jobs answers the API's JSON 404",
  (await jobsOnly.call("GET", "/runners")).body.code,
  "ROUTE_NOT_FOUND",
);

/* ------------------------------------------------------------------ */
step("readOnly removes every mutation, before authorize is asked");

const readOnly = mount({ readOnly: true, actions: [...JOBS_API_ACTIONS] });
checkEqual(
  "no mutating route is registered",
  readOnly.api.routes.filter((route) => route.mutation).length,
  0,
);
checkEqual("what is left", readOnly.api.routes.length, 33 + addedByState);
const paused = await readOnly.call("POST", "/queues/mail/pause");
checkEqual("a mutation answers 404, not 403", paused.status, 404);
checkEqual("with the API's own code", paused.body.code, "ROUTE_NOT_FOUND");
checkEqual(
  "and authorize was never asked",
  readOnly.calls.filter((call) => call.action === "queues.pause").length,
  0,
);
checkEqual(
  "/meta says so",
  (await readOnly.call("GET", "/meta")).body.readOnly,
  true,
);

/* ------------------------------------------------------------------ */
step("actions: an allow-list, with six opt-ins absent by default");

const byDefault = mount();
checkEqual(
  "the defaults are every action but the opt-ins",
  byDefault.api.routes.length,
  61 + addedByState,
);
checkEqual(
  "fail, disable and enable are on by default",
  jobMethodRoutes(byDefault.api),
  [...JOB_METHOD_ROUTES].sort(),
);
// The six write something a host may well want only some callers to: a new
// or changed job, a queue's job defaults (saving them, and separately
// rewriting the backlog with them — tuning without a rewrite is a real
// policy), and a worker's or a runner's remote configuration.
checkEqual(
  "the opt-ins: adding and updating jobs, job defaults, and remote config",
  [...JOBS_API_OPT_IN_ACTIONS],
  [
    "jobs.add",
    "jobs.update",
    "queues.defaults",
    "queues.applyDefaults",
    "workers.configure",
    "runners.configure",
  ],
);
/** The nine routes those six actions authorize. */
const OPT_IN_ROUTES = [
  "addJob",
  "updateJob",
  "setJobDefaults",
  "resetJobDefaults",
  "applyJobDefaults",
  "configureWorker",
  "resetWorkerConfig",
  "configureRunner",
  "resetRunnerConfig",
];
check(
  "so none of their nine routes is registered",
  OPT_IN_ROUTES.every((id) => !idsOf(byDefault.api).includes(id)),
  idsOf(byDefault.api),
);
check(
  "while reading job defaults and worker configs is a plain read, on by default",
  ["getJobDefaults", "listWorkerConfigs"].every((id) =>
    idsOf(byDefault.api).includes(id),
  ),
);

const narrow = mount({ actions: ["meta.read", "jobs.add"] });
checkEqual(
  "an allow-list registers exactly its actions",
  idsOf(narrow.api).sort(),
  ["addJob", "getMeta", "getPermissions"],
);
checkEqual(
  "a route outside the list is a 404",
  (await narrow.call("GET", "/queues")).status,
  404,
);
// Not a list of extras on top of the default: naming only two opt-ins
// turns every other action off, `meta.read` included. `[...JOBS_API_ACTIONS]`
// is the default plus them.
const onlyOptIns = mount({ actions: ["jobs.add", "jobs.update"] });
checkEqual(
  "actions: [jobs.add, jobs.update] alone is those two routes and nothing else",
  [
    idsOf(onlyOptIns.api).sort(),
    (await onlyOptIns.call("GET", "/meta")).status,
  ],
  [["addJob", "updateJob"], 404],
);
const everything = mount({ actions: [...JOBS_API_ACTIONS] });
checkEqual(
  "while [...JOBS_API_ACTIONS] is the default and all nine opt-in routes",
  idsOf(everything.api)
    .filter((id) => !idsOf(byDefault.api).includes(id))
    .sort(),
  [...OPT_IN_ROUTES].sort(),
);
checkEqual(
  "…which is every route",
  everything.api.routes.length,
  byDefault.api.routes.length + OPT_IN_ROUTES.length,
);

/* ------------------------------------------------------------------ */
step("/meta/permissions reports exactly the registered actions");

const permissions = (await both.call("GET", "/meta/permissions")).body.actions;
checkEqual(
  "one answer per distinct action among the routes, plus the two socket ones",
  Object.keys(permissions).sort(),
  [
    ...new Set([
      ...both.api.routes.map((route) => route.action),
      "events.connect",
      "events.subscribe",
    ]),
  ].sort(),
);
checkEqual(
  "48 actions in total",
  [Object.keys(permissions).length, JOBS_API_ACTIONS.length],
  [48, 48],
);
/** Actions for job defaults, the worker controls, and the clear routes. */
const controlActions: JobsApiAction[] = [
  "queues.defaults",
  "queues.applyDefaults",
  "workers.read",
  "workers.pause",
  "workers.resume",
  "workers.stop",
  "workers.start",
  "workers.configure",
  "jobs.clearLogs",
  "runners.logs",
  "runners.clearHistory",
  "runners.configure",
];
check(
  "job defaults, worker control, clearing and run logs are all actions",
  controlActions.every((action) => action in permissions),
  controlActions.filter((action) => !(action in permissions)),
);

// What configuration removed is absent, not merely false.
const restricted = mount({
  mode: "jobs",
  readOnly: true,
  docs: false,
  websocket: false,
});
const restrictedPermissions = (
  await restricted.call("GET", "/meta/permissions")
).body.actions;
check(
  "no runner, mutation, docs or socket action is reported",
  !Object.keys(restrictedPermissions).some(
    (action) =>
      action.startsWith("runners.") ||
      action.startsWith("docs.") ||
      action.startsWith("events.") ||
      JOBS_API_MUTATIONS.has(action as never),
  ),
  Object.keys(restrictedPermissions),
);

// A hook that denies one action reports it as false rather than hiding it.
const partial = mount({
  authorize: (_req, authorizeContext) =>
    authorizeContext.action !== "jobs.remove",
});
const partialAnswer = await partial.call("GET", "/meta/permissions");
const partialPermissions = partialAnswer.body.actions;
checkEqual(
  "a denied action is false",
  partialPermissions["jobs.remove"],
  false,
);
checkEqual("an allowed one is true", partialPermissions["jobs.list"], true);

/* ------------------------------------------------------------------ */
step("Driver capability prunes routes, and /meta.features says why");

const fullFeatures = (await both.call("GET", "/meta")).body.features;
checkEqual(
  "this backend supports everything the API can use (bar added-by-state counts on file and Redis)",
  Object.keys(fullFeatures).filter((feature) => !fullFeatures[feature]),
  addedByState ? [] : ["addedByState"],
);
checkEqual(
  "job defaults, and applying them to the backlog, among them",
  [fullFeatures.jobDefaults, fullFeatures.jobDefaultsApply],
  [true, true],
);

const olderDriver = without(driver, [
  "getJobLogs",
  "clearJobLogs",
  "updateJob",
  "getThroughput",
]);
const olderJobs = new BunJobs({
  namespace: `${namespace}-older`,
  driver: olderDriver,
  logger: createTestLogger().logger,
});
contexts.push(olderJobs);
const older = mount({ actions: [...JOBS_API_ACTIONS] }, olderJobs);
checkEqual(
  "the routes those methods back are gone",
  idsOf(both.api)
    .filter((id) => !idsOf(older.api).includes(id))
    .sort(),
  ["clearJobLogs", "getJobLogs", "getQueueThroughput", "updateJob"],
);
const olderFeatures = (await older.call("GET", "/meta")).body.features;
checkEqual("features.logs is false", olderFeatures.logs, false);
checkEqual("features.update is false", olderFeatures.update, false);
checkEqual("features.throughput is false", olderFeatures.throughput, false);
checkEqual("what the backend still does is true", olderFeatures.limits, true);
checkEqual(
  "a pruned route is a 404, never a 501",
  (await older.call("GET", "/queues/mail/jobs/1/logs")).body.code,
  "ROUTE_NOT_FOUND",
);
// Reading and clearing a job's log share one path, so the path goes only
// when both methods do. A run's log is a separate feature (`runnerLogs`,
// backed by `getRunLog`), which this driver still has.
const olderPaths = Object.keys(
  older.api.openapi().paths as Record<string, unknown>,
).filter((path) => path.endsWith("/logs"));
checkEqual(
  "and the job-log path is absent from the OpenAPI document too",
  olderPaths,
  ["/runners/{runner}/runs/{runId}/logs"],
);

/* ------------------------------------------------------------------ */
step("Errors are RFC 9457 problems, with a stable code");

const errors = mount({
  actions: [...JOBS_API_ACTIONS],
  limits: { queueCacheMs: 0, maxBulkIds: 2, maxJobDataBytes: 64 },
  runnerTriggerArgs: false,
});
await errors.jobs.queue("mail").add("send", { to: "a" }, { jobId: "7" });
errors.jobs.define("send", async () => {});

const notFound = await errors.call("GET", "/queues/mail/jobs/absent");
checkEqual("status", notFound.status, 404);
checkEqual(
  "the body carries every RFC 9457 member",
  Object.keys(notFound.body).sort(),
  ["code", "context", "detail", "instance", "status", "title", "type"],
);
checkEqual(
  "type is a stable URN",
  notFound.body.type,
  "urn:bun-jobs:error:JOB_NOT_FOUND",
);
checkEqual(
  "served as application/problem+json",
  notFound.headers.get("content-type"),
  "application/problem+json",
);
checkEqual(
  "and never cached",
  notFound.headers.get("cache-control"),
  "no-store",
);

/** A representative code from each family, and how to provoke it. */
const codes: [string, number, () => Promise<Answer>][] = [
  ["ROUTE_NOT_FOUND", 404, () => errors.call("GET", "/nowhere")],
  ["QUEUE_NOT_FOUND", 404, () => errors.call("GET", "/queues/absent/counts")],
  ["JOB_NOT_FOUND", 404, () => errors.call("GET", "/queues/mail/jobs/absent")],
  ["RUNNER_NOT_FOUND", 404, () => errors.call("GET", "/runners/ghost")],
  ["INVALID_NAME", 400, () => errors.call("GET", "/queues/a%20b/counts")],
  ["VALIDATION", 400, () => errors.call("GET", "/queues/mail/jobs?limit=lots")],
  [
    "INVALID_JSON",
    400,
    () => errors.call("POST", "/queues/mail/pause", '{"broken":'),
  ],
  [
    "UNSUPPORTED_MEDIA_TYPE",
    415,
    () =>
      errors.call("POST", "/queues/mail/pause", "x", {
        "content-type": "text/plain",
      }),
  ],
  [
    "BULK_LIMIT",
    400,
    () =>
      errors.call("POST", "/queues/mail/jobs/lookup", {
        ids: ["1", "2", "3"],
      }),
  ],
  [
    "NAME_NOT_ADDABLE",
    403,
    () =>
      errors.call("POST", "/queues/mail/jobs", { name: "undefined", data: {} }),
  ],
  [
    "ARGS_NOT_ALLOWED",
    400,
    () => errors.call("POST", "/runners/nightly/trigger", { args: { a: 1 } }),
  ],
  [
    "CSRF_REJECTED",
    403,
    () =>
      errors.call(
        "POST",
        "/queues/mail/pause",
        {},
        {
          origin: "https://evil.example",
        },
      ),
  ],
  [
    "JOB_STATE_CONFLICT",
    409,
    () => errors.call("POST", "/queues/mail/jobs/7/promote"),
  ],
  [
    "PAYLOAD_TOO_LARGE",
    413,
    () =>
      errors.call("PATCH", "/queues/mail/jobs/7", {
        data: { blob: "x".repeat(500) },
      }),
  ],
];

// A runner registered by another process: readable and controllable, but only
// its own process may kill its runs or reset its stats.
errors.jobs.runner({
  id: "nightly",
  file: new URL("../07-runner/handlers/whoami.ts", import.meta.url).pathname,
  executionMode: "in-process",
});
await driver.connect();
await driver.setState(errors.jobs.namespace, runnerKey("elsewhere"), {
  name: "elsewhere",
  paused: "0",
  updatedAt: Date.now(),
});
codes.push([
  "RUNNER_NOT_LOCAL",
  409,
  () => errors.call("POST", "/runners/elsewhere/kill"),
]);

for (const [code, status, run] of codes) {
  const answer = await run();
  checkEqual(
    `${code} → ${status}`,
    [answer.status, answer.body.code],
    [status, code],
  );
}

// A validation failure explains itself, in the spec's terms.
const invalid = await errors.call("GET", "/queues/mail/jobs?limit=lots");
checkEqual(
  "VALIDATION carries issues",
  invalid.body.issues.map((issue: any) => issue.target),
  ["query"],
);
check(
  "each naming its path and reason",
  invalid.body.issues[0].path === "limit" &&
    typeof invalid.body.issues[0].message === "string",
  invalid.body.issues,
);

/* ------------------------------------------------------------------ */
step("A 5xx never carries the underlying message");

const crashing = mount({
  middleware: [
    () => {
      throw new Error(SECRET);
    },
  ],
});
const crashed = await crashing.call("GET", "/meta");
checkEqual("status", crashed.status, 500);
checkEqual("code", crashed.body.code, "INTERNAL");
checkEqual(
  "detail is the generic title, not the message",
  crashed.body.detail,
  crashed.body.title,
);
check(
  "and the secret is nowhere in the response",
  !crashed.text.includes(SECRET),
  crashed.text,
);

// The control: a middleware that names its own 4xx status *is* shown, as
// http-errors does — that is a deliberate message, not an internal one.
const refusing = mount({
  middleware: [
    () => {
      throw Object.assign(new Error("No session"), { status: 401 });
    },
  ],
});
const refused = await refusing.call("GET", "/meta");
checkEqual(
  "a foreign 401 keeps its message",
  [refused.status, refused.body.code, refused.body.detail],
  [401, "UNAUTHORIZED", "No session"],
);

/* ------------------------------------------------------------------ */
step("authorize is asked exactly once per request, with what it targets");

const once = mount({ actions: [...JOBS_API_ACTIONS] });
await once.jobs.queue("mail").add("send", {}, { jobId: "7" });
once.calls.length = 0;
const read = await once.call("GET", "/queues/mail/jobs/7");
checkEqual("the request succeeded", read.status, 200);
checkEqual("asked once", once.calls.length, 1);
checkEqual("with the action, the route pattern and the target", once.calls[0], {
  action: "jobs.read",
  mutation: false,
  transport: "http",
  queue: "mail",
  jobId: "7",
  route: { method: "GET", path: "/queues/:queue/jobs/:id" },
});

// `mutation` is derived from the action, so a hook can trust it.
once.calls.length = 0;
await once.call("POST", "/queues/mail/jobs/7/retry");
checkEqual("a mutation says so", once.calls[0]!.mutation, true);

/* ------------------------------------------------------------------ */
step("A failed check asks authorize first, against the target the path names");

/** The ways a caller can get a request wrong before authorization. */
const probes = [
  {
    name: "a non-JSON mutation",
    body: "ids=7",
    headers: { "content-type": "text/plain" },
    code: "UNSUPPORTED_MEDIA_TYPE",
  },
  { name: "a malformed JSON body", body: '{"ids": [', code: "INVALID_JSON" },
  {
    name: "a body of the wrong shape",
    body: { ids: "not-an-array" },
    code: "VALIDATION",
  },
] as const;

for (const probe of probes) {
  const allowed = mount({ actions: [...JOBS_API_ACTIONS] });
  const answer = await allowed.call(
    "POST",
    "/queues/mail/jobs/retry",
    probe.body,
    "headers" in probe ? probe.headers : {},
  );
  checkEqual(
    `${probe.name}: the caller is told what was wrong`,
    answer.body.code,
    probe.code,
  );
  checkEqual(
    `${probe.name}: authorize was asked once`,
    allowed.calls.length,
    1,
  );
  // The body failed, so its ids are unknown; the queue comes from the path.
  checkEqual(
    `${probe.name}: and against the path's queue, without the body's ids`,
    allowed.calls[0],
    {
      action: "jobs.retry",
      mutation: true,
      transport: "http",
      queue: "mail",
      route: { method: "POST", path: "/queues/:queue/jobs/retry" },
    },
  );

  // The same request from a caller it denies learns nothing about the schema.
  const denied = mount({
    actions: [...JOBS_API_ACTIONS],
    authorize: () => ({ allow: false, status: 403 }),
  });
  const refusal = await denied.call(
    "POST",
    "/queues/mail/jobs/retry",
    probe.body,
    "headers" in probe ? probe.headers : {},
  );
  checkEqual(`${probe.name}: a denied caller gets 403`, refusal.status, 403);
  check(
    `${probe.name}: and is not told the code`,
    !refusal.text.includes(probe.code),
    refusal.text,
  );
}

// The same rule covers a bulk list: the cap is applied before `authorize` is
// handed the ids, and a denied caller is not told the cap exists.
const capped = mount({
  actions: [...JOBS_API_ACTIONS],
  limits: { queueCacheMs: 0, maxBulkIds: 1 },
});
const over = await capped.call("POST", "/queues/mail/jobs/lookup", {
  ids: ["a", "b"],
});
checkEqual("BULK_LIMIT names the cap", over.body.context, { max: 1 });
check(
  "and authorize saw no ids",
  capped.calls[0]!.jobIds === undefined,
  capped.calls[0],
);

/* ------------------------------------------------------------------ */
step("A bad request is 400 or 403 by what authorize says about its target");

// Three hosts, each asked about the same four bad requests. Only a caller
// `authorize` allows *for that target* learns what was wrong with it.
type Policy = (ctx: JobsApiAuthorizeContext) => boolean;
/** Each host's rule, by name. */
const policies: Record<string, Policy> = {
  // Everything is allowed.
  "allow-all": () => true,
  // A request naming no queue or runner is refused.
  "refusing untargeted": (ctx) =>
    ctx.queue !== undefined || ctx.runner !== undefined,
  // The queue "mail" and the runner "nightly" are refused; nothing else is.
  "refusing that target": (ctx) =>
    ctx.queue !== "mail" && ctx.runner !== "nightly",
};

/** One bad request per kind of route, and the target its path names. */
const badRequests = [
  {
    kind: "a queue-body route (failJob, a reason of spaces)",
    method: "POST",
    path: "/queues/mail/jobs/doomed/fail",
    body: { reason: "   " },
    headers: {},
    code: "VALIDATION",
    context: {
      action: "jobs.fail",
      mutation: true,
      transport: "http",
      queue: "mail",
      jobId: "doomed",
      route: { method: "POST", path: "/queues/:queue/jobs/:id/fail" },
    },
  },
  {
    kind: "a query route (listJobs, limit=lots)",
    method: "GET",
    path: "/queues/mail/jobs?limit=lots",
    body: undefined,
    headers: {},
    code: "VALIDATION",
    context: {
      action: "jobs.list",
      mutation: false,
      transport: "http",
      queue: "mail",
      route: { method: "GET", path: "/queues/:queue/jobs" },
    },
  },
  {
    kind: "a runner route (rescheduleRunner, an interval of 0)",
    method: "PUT",
    path: "/runners/nightly/schedule",
    body: { schedule: { every: 0 } },
    headers: {},
    code: "VALIDATION",
    context: {
      action: "runners.reschedule",
      mutation: true,
      transport: "http",
      runner: "nightly",
      route: { method: "PUT", path: "/runners/:runner/schedule" },
    },
  },
  {
    // CSRF_REJECTED is itself a 403, so here the code tells the cases apart.
    kind: "a CSRF failure (pauseQueue, cross-site)",
    method: "POST",
    path: "/queues/mail/pause",
    body: {},
    headers: { "sec-fetch-site": "cross-site" },
    code: "CSRF_REJECTED",
    context: {
      action: "queues.pause",
      mutation: true,
      transport: "http",
      queue: "mail",
      route: { method: "POST", path: "/queues/:queue/pause" },
    },
  },
] as const;

/** Every host mounted for the matrix, closed at the end. */
const matrixHosts: ReturnType<typeof mount>[] = [];
for (const [name, policy] of Object.entries(policies)) {
  /** What this host's `authorize` was asked. */
  const asked: JobsApiAuthorizeContext[] = [];
  const host = mount({
    actions: [...JOBS_API_ACTIONS],
    authorize: (_req, ctx) => {
      asked.push(ctx);
      return policy(ctx);
    },
  });
  // `mount` records only its own `authorize`; this one replaces it.
  host.calls = asked;
  matrixHosts.push(host);
  for (const bad of badRequests) {
    const before = host.calls.length;
    const answer = await host.call(bad.method, bad.path, bad.body, bad.headers);
    // A caller refused for the target is told FORBIDDEN, never the check's code.
    const expected =
      name === "refusing that target"
        ? [403, "FORBIDDEN"]
        : [bad.code === "CSRF_REJECTED" ? 403 : 400, bad.code];
    checkEqual(
      `${name}, ${bad.kind}: ${expected.join(" ")}`,
      [answer.status, answer.body?.code],
      expected,
    );
    // The check failed, yet authorize was asked once, about the path's target.
    checkEqual(
      `${name}, ${bad.kind}: authorize asked once, with the target and ctx.route`,
      host.calls.slice(before),
      [bad.context],
    );
  }
}

// Only an invalid *path* leaves authorize nothing to target: a runner name
// over MAX_NAME_LENGTH is refused by the path's own schema.
const badPath = matrixHosts[1]!;
const beforeBadPath = badPath.calls.length;
const badPathAnswer = await badPath.call(
  "PUT",
  `/runners/${"n".repeat(MAX_NAME_LENGTH + 1)}/schedule`,
  { schedule: { every: 0 } },
);
checkEqual(
  "an invalid path is asked about untargeted, so refusing untargeted is 403",
  [
    badPathAnswer.status,
    badPath.calls.slice(beforeBadPath).map((ctx) => ctx.runner),
  ],
  [403, [undefined]],
);

/* ------------------------------------------------------------------ */
step("limits: every cost is bounded");

const limited = mount({
  actions: [...JOBS_API_ACTIONS],
  limits: {
    queueCacheMs: 0,
    maxPageSize: 5,
    defaultPageSize: 2,
    maxBulkIds: 3,
    maxClean: 10,
    maxLogPage: 4,
    maxHistory: 6,
    maxQueues: 1,
    maxJobDataBytes: 64,
  },
});
for (let index = 0; index < 6; index++) {
  await limited.jobs.queue("mail").add("send", { index });
}
await limited.jobs.queue("other").add("send", {});

checkEqual(
  "defaultPageSize applies when no limit is given",
  (await limited.call("GET", "/queues/mail/jobs")).body.page.limit,
  2,
);
checkEqual(
  "maxPageSize is the ceiling",
  (await limited.call("GET", "/queues/mail/jobs?limit=99")).body.code,
  "VALIDATION",
);
checkEqual(
  "maxQueues truncates the queue list",
  (await limited.call("GET", "/queues")).body.truncated,
  true,
);
checkEqual(
  "a declared body over maxJobDataBytes is refused unread",
  (
    await limited.call("PATCH", "/queues/mail/jobs/none", {
      data: { blob: "x".repeat(500) },
    })
  ).status,
  413,
);
await checkRejects(
  "a default page larger than the maximum is refused",
  () =>
    createJobsApi({
      jobs: context("c8"),
      basePath: "/admin/jobs",
      authorize: () => true,
      limits: { maxPageSize: 10, defaultPageSize: 20 },
    }),
  { code: "CONFIG", message: /may not exceed/ },
);
await checkRejects(
  "a limit that would be meaningless is refused",
  () =>
    createJobsApi({
      jobs: context("c9"),
      basePath: "/admin/jobs",
      authorize: () => true,
      limits: { maxBulkIds: 0 },
    }),
  { code: "CONFIG", message: /at least 1/ },
);
await checkRejects(
  "maxApplyDefaults above 10000 is refused",
  () =>
    createJobsApi({
      jobs: context("c9a"),
      basePath: "/admin/jobs",
      authorize: () => true,
      limits: { maxApplyDefaults: 10_001 },
    }),
  { code: "CONFIG", message: /at most 10000/ },
);

/* ------------------------------------------------------------------ */
step("csrf, cors and trustProxy");

// The default: mutations must be JSON, and a cross-site origin is refused.
const defended = mount({ actions: [...JOBS_API_ACTIONS] });
await defended.jobs.queue("mail").add("send", {});
checkEqual(
  "a same-origin JSON mutation passes",
  (await defended.call("POST", "/queues/mail/pause")).status,
  200,
);
checkEqual(
  "a cross-site one does not",
  (
    await defended.call(
      "POST",
      "/queues/mail/resume",
      {},
      {
        "sec-fetch-site": "cross-site",
      },
    )
  ).body.code,
  "CSRF_REJECTED",
);

const headerGuarded = mount({
  actions: [...JOBS_API_ACTIONS],
  csrf: { header: "X-Bun-Jobs-CSRF" },
});
await headerGuarded.jobs.queue("mail").add("send", {});
checkEqual(
  "a required header is required",
  (await headerGuarded.call("POST", "/queues/mail/pause")).body.context,
  { header: "x-bun-jobs-csrf" },
);
checkEqual(
  "and accepted when sent",
  (
    await headerGuarded.call(
      "POST",
      "/queues/mail/resume",
      {},
      {
        "x-bun-jobs-csrf": "1",
      },
    )
  ).status,
  200,
);

const undefended = mount({ actions: [...JOBS_API_ACTIONS], csrf: false });
await undefended.jobs.queue("mail").add("send", {});
checkEqual(
  "csrf: false turns all of it off",
  (
    await undefended.call("POST", "/queues/mail/pause", "x", {
      "content-type": "text/plain",
      "sec-fetch-site": "cross-site",
    })
  ).status,
  200,
);

// Behind a TLS-terminating proxy the forwarded headers are the truth — but
// only when you say they can be trusted.
const forwarded = {
  origin: "https://admin.example",
  "x-forwarded-proto": "https",
  "x-forwarded-host": "admin.example",
};
const direct = mount({ actions: [...JOBS_API_ACTIONS] });
await direct.jobs.queue("mail").add("send", {});
checkEqual(
  "without trustProxy a forwarded origin is cross-origin",
  (await direct.call("POST", "/queues/mail/pause", {}, forwarded)).status,
  403,
);
const trusting = mount({ actions: [...JOBS_API_ACTIONS], trustProxy: true });
await trusting.jobs.queue("mail").add("send", {});
checkEqual(
  "with it, the same request is same-origin",
  (await trusting.call("POST", "/queues/mail/pause", {}, forwarded)).status,
  200,
);

// CORS is off by default; an explicit list is accepted with credentials.
checkEqual(
  "no CORS headers by default",
  (
    await defended.call("GET", "/meta", undefined, {
      origin: "https://ui.example",
    })
  ).headers.get("access-control-allow-origin"),
  null,
);
const cors = mount({
  cors: { origin: ["https://ui.example"], credentials: true },
});
checkEqual(
  "an explicit origin list is reflected",
  (
    await cors.call("GET", "/meta", undefined, { origin: "https://ui.example" })
  ).headers.get("access-control-allow-origin"),
  "https://ui.example",
);

/* ------------------------------------------------------------------ */
step("serialize: what leaves the process");

const failing = context("serialize");
failing.define("boom", () => {
  throw new Error("kaput");
});
const plain = mount({ actions: [...JOBS_API_ACTIONS] }, failing);
const worker = failing.worker("mail", async () => {
  throw new Error("kaput");
});
const running = worker.run();
await failing.queue("mail").add(
  "boom",
  { card: "4111111111111111" },
  {
    jobId: "f1",
    attempts: 1,
  },
);
await waitFor("the job to fail", async () => {
  const counts = await failing.queue("mail").count();
  return counts.dead + counts.failed >= 1;
});

const failed = await plain.call(
  "GET",
  "/queues/mail/jobs/f1?include=stacktrace",
);
check(
  "a stack is not exposed by default",
  failed.body.failedReason.stack === undefined,
  failed.body.failedReason,
);
checkEqual(
  "but the failure itself is",
  failed.body.failedReason.message,
  "kaput",
);

const exposing = mount(
  { actions: [...JOBS_API_ACTIONS], serialize: { exposeStacks: true } },
  failing,
);
const exposed = await exposing.call("GET", "/queues/mail/jobs/f1");
check(
  "exposeStacks turns it on",
  typeof exposed.body.failedReason.stack === "string",
);

// A hook is the place to redact before anything leaves.
const redacting = mount(
  {
    actions: [...JOBS_API_ACTIONS],
    serialize: {
      job: (dto) => ({ ...dto, data: "[redacted]" }),
    },
  },
  failing,
);
const redacted = await redacting.call(
  "GET",
  "/queues/mail/jobs/f1?include=data",
);
checkEqual(
  "serialize.job rewrites the payload",
  redacted.body.data,
  "[redacted]",
);
check(
  "so the card number never leaves",
  !redacted.text.includes("4111111111111111"),
);

const hosts = mount(
  { actions: [...JOBS_API_ACTIONS], serialize: { exposeHosts: false } },
  failing,
);
const workers = await hosts.call("GET", "/workers");
check(
  "exposeHosts: false omits host and pid",
  workers.body.items.every(
    (one: any) => one.host === undefined && one.pid === undefined,
  ),
  workers.body.items,
);
const withHosts = await plain.call("GET", "/workers");
check(
  "the control: they are there by default",
  withHosts.body.items.every((one: any) => typeof one.host === "string"),
  withHosts.body.items,
);

await worker.close();
await running;

/* ------------------------------------------------------------------ */
step(
  "The worker reads carry rssBytes, heartbeatRttMs and sweeps, or leave them out",
);

// Two optional samples that ride the heartbeat write: `rssBytes`, the
// **process's** resident memory (`process.memoryUsage.rss()` — two workers in
// one process report the same number, so a table must never sum the column;
// `read-apis.ts` shows how to total a fleet instead), and `heartbeatRttMs`,
// how long the worker's own heartbeat *write* took at the driver — a round
// trip, not a network ping, and the previous write's, since a write cannot
// time itself. All three read routes carry them, and every one leaves them out
// of a record that has neither: absent, never `0`.
//
// `sweeps` rides the same write and is optional in the same way, but its
// absence means something else again: not "nothing to report yet" but "a worker
// too old to say". So the routes are checked for all three of its states —
// `true` from a default worker, `false` from one that opted out of the queue's
// housekeeping, and nothing at all from an older record.
const samplesContext = context("worker-samples");
const sampling = mount({ actions: [...JOBS_API_ACTIONS] }, samplesContext);
const sampleQueue = samplesContext.queue("mail");
const sampleWorker = samplesContext.worker("mail", async () => "ok", {
  id: "mail.sampled",
  reportInterval: 150,
  pollInterval: 25,
});
const samplingRun = sampleWorker.run();

// A second live worker on the same queue, opted out of housekeeping: the one
// that reports `sweeps: false` rather than leaving it out.
const optedOutWorker = samplesContext.worker("mail", async () => "ok", {
  id: "mail.no-sweeps",
  maintenance: false,
  reportInterval: 150,
  pollInterval: 25,
});
const optedOutRun = optedOutWorker.run();

// Beside it, a record from a worker that reports neither field — what an older
// worker in the same fleet writes — put straight into the registry.
const olderAt = Date.now();
await registerWorkerRecord(sampleQueue.driver, sampleQueue.ref, {
  id: "mail.older",
  queue: "mail",
  host: "another-host",
  pid: 4242,
  concurrency: 1,
  active: 0,
  paused: false,
  startedAt: olderAt - 5_000,
  heartbeatAt: olderAt,
  expiresAt: olderAt + 60_000,
});

// The round trip appears on the *second* report, so wait for it rather than for
// the record: the first one has nothing to report yet.
await waitFor("the live worker's record to carry a round trip", async () => {
  const live = await sampleQueue.listWorkers();
  return live.some(
    (info) => info.id === "mail.sampled" && info.heartbeatRttMs !== undefined,
  );
});
await waitFor("the opted-out worker to report", async () => {
  const live = await sampleQueue.listWorkers();
  return live.some((info) => info.id === "mail.no-sweeps");
});

/**
 * The three routes that answer a worker record. A path ending in `/` is the
 * single read, which takes the worker's id; the other two are listings.
 */
const WORKER_READS = [
  ["GET /workers", "/workers"],
  ["GET /queues/mail/workers", "/queues/mail/workers"],
  ["GET /queues/mail/workers/:worker", "/queues/mail/workers/"],
] as const;

/** The named worker as one of {@link WORKER_READS} answered it. */
async function workerFrom(
  path: string,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const answer = await sampling.call(
    "GET",
    path.endsWith("/") ? `${path}${id}` : path,
  );
  const items = answer.body?.items as Record<string, unknown>[] | undefined;
  return items
    ? items.find((item) => item.id === id)
    : (answer.body as Record<string, unknown>);
}

for (const [route, path] of WORKER_READS) {
  const live = await workerFrom(path, "mail.sampled");
  check(
    `${route} carries both samples on a worker that reports them`,
    Number.isInteger(live?.rssBytes) &&
      (live!.rssBytes as number) > 1_000_000 &&
      Number.isFinite(live?.heartbeatRttMs) &&
      (live!.heartbeatRttMs as number) >= 0,
    { rssBytes: live?.rssBytes, heartbeatRttMs: live?.heartbeatRttMs },
  );

  checkEqual(
    `${route} carries sweeps: true on a worker that does the housekeeping`,
    [Object.hasOwn(live ?? {}, "sweeps"), live?.sweeps],
    [true, true],
  );

  const optedOut = await workerFrom(path, "mail.no-sweeps");
  checkEqual(
    `${route} carries sweeps: false — present, on a worker that opted out`,
    [Object.hasOwn(optedOut ?? {}, "sweeps"), optedOut?.sweeps],
    [true, false],
  );

  const older = await workerFrom(path, "mail.older");
  checkEqual(
    `${route} omits them on a record that has neither`,
    [
      Object.hasOwn(older ?? {}, "rssBytes"),
      Object.hasOwn(older ?? {}, "heartbeatRttMs"),
    ],
    [false, false],
  );
  // The state a reader must not read as `false`: the route leaves the key out
  // rather than serialising a default, so "too old to say" survives the wire.
  checkEqual(
    `${route} omits sweeps on an older record, rather than sending false`,
    [Object.hasOwn(older ?? {}, "sweeps"), older?.sweeps],
    [false, undefined],
  );
}

// Both are optional on the browser-safe contract as well, so a client cannot
// read either as a plain `number` — which is exactly what would let a `0` stand
// in for a worker that never reported one.
type _RssOptional = Expect<Equal<WorkerDto["rssBytes"], number | undefined>>;
type _RttOptional = Expect<
  Equal<WorkerDto["heartbeatRttMs"], number | undefined>
>;
// `sweeps` the same, and for it the `undefined` is load-bearing: a client typed
// `boolean` would have no way to say "too old to say" other than `false`.
type _SweepsOptional = Expect<Equal<WorkerDto["sweeps"], boolean | undefined>>;
compileOnly(() => {
  const dto: WorkerDto = {
    id: "mail.older",
    queue: "mail",
    concurrency: 1,
    active: 0,
    paused: false,
    startedAt: olderAt,
    heartbeatAt: olderAt,
    expiresAt: olderAt + 60_000,
  };
  // @ts-expect-error absent is part of the type: a reader must handle it
  const bytes: number = dto.rssBytes;
  // @ts-expect-error the same for the round trip
  const rtt: number = dto.heartbeatRttMs;
  // @ts-expect-error and for sweeps, where absent is a third answer
  const sweeps: boolean = dto.sweeps;
  return [bytes, rtt, sweeps];
});

await sampleWorker.close();
await samplingRun;
await optedOutWorker.close();
await optedOutRun;

/* ------------------------------------------------------------------ */
step("addableNames, runnerTriggerArgs and validateResponses");

const adding = mount({ actions: [...JOBS_API_ACTIONS] });
adding.jobs.define("send", async () => {});
await adding.jobs.queue("mail").add("send", {});
checkEqual(
  "by default only the defined names may be added",
  (await adding.call("POST", "/queues/mail/jobs", { name: "send", data: {} }))
    .status,
  201,
);
checkEqual(
  "and nothing else",
  (
    await adding.call("POST", "/queues/mail/jobs", {
      name: "anything",
      data: {},
    })
  ).body.code,
  "NAME_NOT_ADDABLE",
);

const anyName = mount({
  actions: [...JOBS_API_ACTIONS],
  addableNames: "any",
});
await anyName.jobs.queue("mail").add("send", {});
checkEqual(
  '"any" accepts a name nothing defines',
  (
    await anyName.call("POST", "/queues/mail/jobs", {
      name: "whatever",
      data: {},
    })
  ).status,
  201,
);

const listedNames = mount({
  actions: [...JOBS_API_ACTIONS],
  addableNames: ["allowed"],
});
await listedNames.jobs.queue("mail").add("send", {});
checkEqual(
  "a list accepts only what it names",
  [
    (
      await listedNames.call("POST", "/queues/mail/jobs", {
        name: "allowed",
        data: {},
      })
    ).status,
    (
      await listedNames.call("POST", "/queues/mail/jobs", {
        name: "other",
        data: {},
      })
    ).status,
  ],
  [201, 403],
);

const withArgs = mount({
  actions: [...JOBS_API_ACTIONS],
  runnerTriggerArgs: true,
});
withArgs.jobs.runner({
  id: "nightly",
  file: new URL("../07-runner/handlers/whoami.ts", import.meta.url).pathname,
  executionMode: "in-process",
});
const triggered = await withArgs.call("POST", "/runners/nightly/trigger", {
  args: { greeting: "hello" },
});
check(
  "runnerTriggerArgs: true accepts args",
  triggered.status === 202 || triggered.status === 200,
  triggered,
);

// `validateResponses` checks every body against its own schema and logs a
// mismatch. It costs a validation per response, so it is off by default.
checkEqual(
  "validateResponses is off by default",
  (await mount().call("GET", "/meta")).status,
  200,
);
const validating = mount({ validateResponses: true });
await validating.call("GET", "/meta");
check(
  "with it on, a correct response logs nothing",
  !validating.events.some(
    (event) => event.message === "jobs api response did not match its schema",
  ),
  validating.events.map((event) => event.message),
);

/* ------------------------------------------------------------------ */
step("docs: the JSON is always there, the pages are not");

const docsDefault = mount();
checkEqual(
  "docs.ui defaults to false",
  (await docsDefault.call("GET", "/docs")).status,
  404,
);
checkEqual(
  "but the document is served",
  (await docsDefault.call("GET", "/openapi.json")).status,
  200,
);
checkEqual(
  "and /meta does not advertise a page",
  (await docsDefault.call("GET", "/meta")).body.docs.ui,
  undefined,
);

const docsOn = mount({ docs: { ui: true } });
const page = await docsOn.call("GET", "/docs");
checkEqual("docs.ui: true serves Swagger UI", page.status, 200);
check(
  "under a strict Content Security Policy",
  (page.headers.get("content-security-policy") ?? "").startsWith(
    "default-src 'none'",
  ),
  page.headers.get("content-security-policy"),
);
check(
  "loading a pinned bundle with an integrity hash",
  /integrity="sha384-[\w+/]+={0,2}"/.test(page.text),
);
checkEqual(
  "and /meta advertises it",
  (await docsOn.call("GET", "/meta")).body.docs.ui,
  "/admin/jobs/docs",
);

const docsOff = mount({ docs: false });
checkEqual(
  "docs: false removes the JSON endpoints too",
  (await docsOff.call("GET", "/openapi.json")).status,
  404,
);
check(
  "though the function still works",
  docsOff.api.openapi().openapi === "3.1.0",
);
checkEqual(
  "and /meta reports none",
  (await docsOff.call("GET", "/meta")).body.docs,
  null,
);

/* ------------------------------------------------------------------ */
step("middleware runs inside the API, before every route");

const order: string[] = [];
const wrapped = mount({
  middleware: [
    (_req, _res, next) => {
      order.push("middleware");
      next();
    },
  ],
  authorize: () => {
    order.push("authorize");
    return true;
  },
});
await wrapped.call("GET", "/meta");
checkEqual("middleware first, then authorize", order, [
  "middleware",
  "authorize",
]);

/* ------------------------------------------------------------------ */
step("What /meta reports about publishing");

// `publishing` is the context's resolved `publishEvents` (its
// `publishesEvents` getter): `true` when set, `false` when it was not given.
// The same answer decides whether the API warns that its live events will be
// empty — that warning is logged only when publishing is off.
const socketWarning = "jobs api live events only carry what producers publish";
const warned = (logged: readonly { level: string; message: string }[]) =>
  logged.some(
    (event) =>
      event.level === "warn" && event.message.startsWith(socketWarning),
  );

const publishing = new BunJobs({
  namespace: `${namespace}-publishing`,
  driver,
  logger: createTestLogger().logger,
  publishEvents: true,
});
contexts.push(publishing);
check("the context says it publishes", publishing.publishesEvents);
const published = mount({}, publishing);
checkEqual(
  "publishing is reported as true",
  (await published.call("GET", "/meta")).body.publishing,
  true,
);
check("…and the API does not warn", !warned(published.events));

const silent = context("silent");
check("a context without publishEvents does not", !silent.publishesEvents);
const unpublished = mount({}, silent);
checkEqual(
  "publishing is reported as false",
  (await unpublished.call("GET", "/meta")).body.publishing,
  false,
);
check(
  "…and the API warns that its live events carry only what producers publish",
  warned(unpublished.events),
  unpublished.events.map((event) => event.message),
);
const noSocketNoWarning = mount({ websocket: false }, context("silent-nows"));
check(
  "…but not when it has no socket to carry them",
  !warned(noSocketNoWarning.events),
);

/* ------------------------------------------------------------------ */
step("close() releases what the API opened, and nothing else");

const closing = mount();
await closing.api.close();
check("closing twice is safe", (await closing.api.close()) === undefined);
await closing.jobs.queue("still-here").add("send", {});
check(
  "the context is untouched",
  (await closing.jobs.listQueues()).includes("still-here"),
);

/* ------------------------------------------------------------------ */
step("/meta tells a client what it needs before its first write");

// csrf: the header every mutation must carry (lower case, or null) and
// whether every POST must be JSON even with no body.
checkEqual(
  "csrf by default: no header, JSON required",
  (await defended.call("GET", "/meta")).body.csrf,
  { header: null, requireJson: true },
);
checkEqual(
  "a configured header is reported in lower case",
  (await headerGuarded.call("GET", "/meta")).body.csrf,
  { header: "x-bun-jobs-csrf", requireJson: true },
);
checkEqual(
  "csrf: false reports neither",
  (await undefended.call("GET", "/meta")).body.csrf,
  { header: null, requireJson: false },
);

// limits: every cap the routes enforce, read from the same values. Two are
// derived rather than configured: `defaultClean` is the `limit` a clean uses
// when none is given, min(1000, maxClean); `maxRetryAllIds` is how many ids a
// `retry-all` answers with before it reports `truncated`, fixed at 1000.
checkEqual(
  "limits: each configured cap, the defaults for the rest, and the two derived",
  (await limited.call("GET", "/meta")).body.limits,
  {
    defaultPageSize: 2,
    maxPageSize: 5,
    maxBulkIds: 3,
    maxRetryAll: DEFAULT_JOBS_API_LIMITS.maxRetryAll,
    maxRetryAllIds: 1000,
    maxClean: 10,
    defaultClean: 10,
    maxLogPage: 4,
    maxHistory: 6,
    maxJobDataBytes: 64,
    maxQueues: 1,
    maxApplyDefaults: DEFAULT_JOBS_API_LIMITS.maxApplyDefaults,
  },
);
checkEqual(
  "maxApplyDefaults: 1000 by default, the largest apply limit",
  DEFAULT_JOBS_API_LIMITS.maxApplyDefaults,
  1000,
);

// addableNames: null for any name, [] when nothing can be added, else the
// list — by default the definitions, read at request time.
checkEqual(
  "addableNames: the defined names by default",
  (await adding.call("GET", "/meta")).body.addableNames,
  ["send"],
);
adding.jobs.define("receipt", async () => {});
checkEqual(
  "read when asked: a name defined since is there",
  (await adding.call("GET", "/meta")).body.addableNames,
  ["send", "receipt"],
);
checkEqual(
  '"any" is null',
  (await anyName.call("GET", "/meta")).body.addableNames,
  null,
);
checkEqual(
  "a list is itself",
  (await listedNames.call("GET", "/meta")).body.addableNames,
  ["allowed"],
);
checkEqual(
  "and with jobs.add not routed (it is opt-in), nothing",
  (await docsDefault.call("GET", "/meta")).body.addableNames,
  [],
);

// runnerTriggerArgs: whether a trigger is routed and accepts args.
checkEqual(
  "runnerTriggerArgs: true when configured and routed",
  (await withArgs.call("GET", "/meta")).body.runnerTriggerArgs,
  true,
);
checkEqual(
  "false by default",
  (await defended.call("GET", "/meta")).body.runnerTriggerArgs,
  false,
);
const argsReadOnly = mount({ runnerTriggerArgs: true, readOnly: true });
checkEqual(
  "and false when the trigger route is not registered",
  (await argsReadOnly.call("GET", "/meta")).body.runnerTriggerArgs,
  false,
);

// websocket.port: only for a socket on a port of its own.
check(
  "a shared socket reports no port",
  !("port" in (await defended.call("GET", "/meta")).body.websocket),
);
const ownPort = mount({ websocket: { port: 0 } });
const ownPortMeta = (await ownPort.call("GET", "/meta")).body;
check(
  "a dedicated one reports the port it bound, not the 0 it was given",
  ownPortMeta.websocket.port > 0 &&
    ownPortMeta.websocket.port === ownPort.api.websocket!.port,
  ownPortMeta.websocket,
);

/* ------------------------------------------------------------------ */
step("api.info: the same answers on the server, without a request");

const info = ownPort.api.info;
checkEqual("what the API resolved to", info, {
  basePath: "/admin/jobs",
  namespace: ownPort.jobs.namespace,
  mode: "both",
  readOnly: false,
  csrf: { header: null, requireJson: true },
  docs: {
    openapi: "/admin/jobs/openapi.json",
    asyncapi: "/admin/jobs/asyncapi.json",
  },
  websocket: { path: "/admin/jobs/ws", port: ownPort.api.websocket!.port },
});
check(
  "frozen all the way down",
  Object.isFrozen(info) &&
    Object.isFrozen(info.csrf) &&
    Object.isFrozen(info.docs) &&
    Object.isFrozen(info.websocket),
);
checkEqual("the header as /meta reports it", headerGuarded.api.info.csrf, {
  header: "x-bun-jobs-csrf",
  requireJson: true,
});
checkEqual(
  "docs reflects the routes registered: none with docs: false",
  docsOff.api.info.docs,
  null,
);
const noDocsAction = mount({
  actions: [...JOBS_API_ACTIONS].filter((action) => action !== "docs.read"),
});
checkEqual(
  "and none when docs.read is not an allowed action",
  noDocsAction.api.info.docs,
  null,
);
const noSocket = mount({ websocket: false });
checkEqual(
  "no socket: no asyncapi, and websocket is null",
  [noSocket.api.info.docs, noSocket.api.info.websocket],
  [{ openapi: "/admin/jobs/openapi.json" }, null],
);
checkEqual(
  "a shared socket has a path and no port",
  defended.api.info.websocket,
  { path: "/admin/jobs/ws" },
);

/* ------------------------------------------------------------------ */
step("/meta/permissions?channel= previews a socket subscription");

const previewing = mount({
  queues: ["mail", "secret"],
  authorize: (_req, authorizeContext) =>
    authorizeContext.queue !== "secret" || {
      allow: false,
      reason: "secret is private",
    },
});
/** The `channel` part of a permissions answer. */
const preview = async (channel?: string, api = previewing) =>
  (
    await api.call(
      "GET",
      channel === undefined
        ? "/meta/permissions"
        : `/meta/permissions?channel=${encodeURIComponent(channel)}`,
    )
  ).body.channel;
checkEqual("allowed, with the canonical key", await preview("queue/mail"), {
  channel: "queue/mail",
  key: "queue/mail",
  allowed: true,
});
checkEqual(
  "the key re-encodes a job id; the channel is as asked",
  await preview("queue/mail/job/a%2fb"),
  {
    channel: "queue/mail/job/a%2fb",
    key: "queue/mail/job/a%2Fb",
    allowed: true,
  },
);
checkEqual(
  "denied by authorize, with its reason",
  await preview("queue/secret"),
  {
    channel: "queue/secret",
    key: "queue/secret",
    allowed: false,
    code: "FORBIDDEN",
    status: 403,
    detail: "secret is private",
  },
);
// Refused before authorize, as a subscribe ack would refuse it. A channel
// that parsed has its canonical key even when refused: a queue outside
// `queues` (QUEUE_NOT_FOUND), a job in one (its id re-encoded, as above), or
// a runner channel on a `mode: "jobs"` API (CHANNEL_NOT_AVAILABLE). Only a
// channel that does not parse (INVALID_CHANNEL) has none.
checkEqual(
  "refused before authorize: a key whenever the channel parsed",
  await Promise.all(
    [
      preview("nonsense"),
      preview("queue/other"),
      preview("queue/other/job/a%2fb"),
      preview("runner/nightly", jobsOnly),
    ].map(async (pending) => {
      const answer = await pending;
      return [answer.allowed, answer.code, answer.status, answer.key];
    }),
  ),
  [
    [false, "INVALID_CHANNEL", 400, undefined],
    [false, "QUEUE_NOT_FOUND", 404, "queue/other"],
    [false, "QUEUE_NOT_FOUND", 404, "queue/other/job/a%2Fb"],
    [false, "CHANNEL_NOT_AVAILABLE", 404, "runner/nightly"],
  ],
);
checkEqual("and absent unless asked for", await preview(), undefined);

/* ------------------------------------------------------------------ */
step("/meta/permissions: N + 1 calls, each shaped like the real request");

/** The routes the spy below denies, as `<METHOD> <pattern>`. */
const DENIED_ROUTES = ["GET /overview", "GET /meta"];
/** `<METHOD> <pattern>` of a call, or `undefined` when it carries no route. */
const routeOf = (context: JobsApiAuthorizeContext) =>
  context.route && `${context.route.method} ${context.route.path}`;
/** Every context the spy was asked about. */
const spied: JobsApiAuthorizeContext[] = [];
// A spy that decides by `ctx.route` alone, the way a host with a route table
// would: everything is allowed but two routes.
const byRoute = mount({
  authorize: (_req, authorizeContext) => {
    spied.push(authorizeContext);
    const route = routeOf(authorizeContext);
    return route === undefined || !DENIED_ROUTES.includes(route);
  },
});
await byRoute.jobs.queue("mail").add("send", {});

spied.length = 0;
const untargetedMap: PermissionsDto["actions"] = (
  await byRoute.call("GET", "/meta/permissions")
).body.actions;
checkEqual(
  "N + 1 authorize calls: the request's own, then one per action",
  spied.length,
  Object.keys(untargetedMap).length + 1,
);
checkEqual(
  "the first is the request itself: meta.read on GET /meta/permissions",
  [spied[0]!.action, routeOf(spied[0]!)],
  ["meta.read", "GET /meta/permissions"],
);
checkEqual(
  "then one per action, in the answer's order",
  spied.slice(1).map((authorizeContext) => authorizeContext.action),
  Object.keys(untargetedMap),
);
/** The preview call `authorize` received for `action`. */
const previewed = (action: JobsApiAction) =>
  spied
    .slice(1)
    .find((authorizeContext) => authorizeContext.action === action)!;
checkEqual(
  "untargeted, each previews a route naming neither queue nor runner",
  [
    routeOf(previewed("metrics.read")),
    routeOf(previewed("meta.read")),
    routeOf(previewed("queues.list")),
  ],
  ["GET /overview", "GET /meta", "GET /queues"],
);
checkEqual(
  "an action with no such route previews its first one",
  routeOf(previewed("jobs.read")),
  "POST /queues/:queue/jobs/lookup",
);
checkEqual(
  "the socket's two carry transport ws and no route, as the upgrade and a subscribe do",
  [previewed("events.connect"), previewed("events.subscribe")].map(
    (authorizeContext) => [authorizeContext.transport, authorizeContext.route],
  ),
  [
    ["ws", undefined],
    ["ws", undefined],
  ],
);
check(
  "every HTTP preview carries transport http and a route",
  spied
    .slice(1)
    .filter(
      (authorizeContext) => !authorizeContext.action.startsWith("events."),
    )
    .every(
      (authorizeContext) =>
        authorizeContext.transport === "http" &&
        authorizeContext.route !== undefined,
    ),
);
check(
  "and none names a job: a rule on jobId cannot be previewed",
  spied.every((authorizeContext) => authorizeContext.jobId === undefined),
);

spied.length = 0;
const mailMap: PermissionsDto["actions"] = (
  await byRoute.call("GET", "/meta/permissions?queue=mail")
).body.actions;
checkEqual(
  "?queue= previews a route naming :queue, with the queue",
  [routeOf(previewed("metrics.read")), previewed("metrics.read").queue],
  ["GET /queues/:queue/throughput", "mail"],
);
checkEqual("still N + 1", spied.length, Object.keys(mailMap).length + 1);

spied.length = 0;
const channelMap: PermissionsDto["actions"] = (
  await byRoute.call("GET", "/meta/permissions?channel=queue/mail")
).body.actions;
checkEqual(
  "a channel that parses adds one more: N + 2",
  spied.length,
  Object.keys(channelMap).length + 2,
);

// Because each preview carries the real request's route, the map agrees with
// what the request then gets, even where one action has several routes.
/** The status one GET through the spied API answers. */
const statusOf = async (path: string) =>
  (await byRoute.call("GET", path)).status;
checkEqual(
  "metrics.read: false untargeted (GET /overview), and GET /overview is 403",
  [untargetedMap["metrics.read"], await statusOf("/overview")],
  [false, 403],
);
checkEqual(
  "true for a queue (its throughput), and that answers 200",
  [mailMap["metrics.read"], await statusOf("/queues/mail/throughput")],
  [true, 200],
);
checkEqual(
  "meta.read previews GET /meta, denied, though /meta/permissions itself was allowed",
  [untargetedMap["meta.read"], await statusOf("/meta")],
  [false, 403],
);

// `actions` is keyed by action, and every key is optional: a pruned action is
// absent, not false. A misspelt action does not compile.
type _PermissionsKeyedByAction = Expect<
  Equal<PermissionsDto["actions"], Partial<Record<JobsApiAction, boolean>>>
>;
compileOnly(() => {
  const canRetry: boolean | undefined = untargetedMap["jobs.retry"];
  // @ts-expect-error "jobs.frobnicate" is not an action
  const misspelt = untargetedMap["jobs.frobnicate"];
  return [canRetry, misspelt];
});

/* ------------------------------------------------------------------ */
step("POST /queues/:queue/jobs: the first job creates its queue");

// Adding a queue's first job is what creates it, through the API as through
// `BunQueue.add`. The job name is checked first, so only a request about to
// write builds a queue: an unknown queue is not a 404 here. A known-queue
// cache does not hide the new one: the API forgets it once the job is written.
const creating = mount(
  { actions: [...JOBS_API_ACTIONS], limits: { queueCacheMs: 60_000 } },
  context("creating"),
);
creating.jobs.define("send", async () => {});
checkEqual(
  "an empty namespace lists no queue (and fills the cache)",
  (await creating.call("GET", "/queues")).body.items,
  [],
);
const firstJob = await creating.call("POST", "/queues/welcome/jobs", {
  name: "send",
  data: {},
});
checkEqual(
  "a queue that does not exist yet: 201, the job added",
  [firstJob.status, firstJob.body.added],
  [201, true],
);
checkEqual(
  "and the queue is listed at once, inside the cache window",
  (await creating.call("GET", "/queues")).body.items.map(
    (queue: { name: string }) => queue.name,
  ),
  ["welcome"],
);
const notAddable = await creating.call("POST", "/queues/other/jobs", {
  name: "undefined-name",
  data: {},
});
checkEqual(
  "a name that is not addable is still 403, whether or not the queue exists",
  [notAddable.status, notAddable.body.code],
  [403, "NAME_NOT_ADDABLE"],
);
checkEqual("and created nothing", await creating.jobs.listQueues(), [
  "welcome",
]);
const configured = mount(
  { actions: [...JOBS_API_ACTIONS], queues: ["mail"] },
  context("configured"),
);
configured.jobs.define("send", async () => {});
const outside = await configured.call("POST", "/queues/welcome/jobs", {
  name: "send",
  data: {},
});
checkEqual(
  "with a configured `queues` list, a queue outside it is still 404",
  [outside.status, outside.body.code],
  [404, "QUEUE_NOT_FOUND"],
);
checkEqual(
  "while one inside it is created by its first job",
  (
    await configured.call("POST", "/queues/mail/jobs", {
      name: "send",
      data: {},
    })
  ).status,
  201,
);

/* ------------------------------------------------------------------ */
step("A stale known-queue cache is re-checked before a 404");

// `limits.queueCacheMs` caches the known-queue list for 404 checks. A queue
// another process created since would be missing from it, so a miss is
// re-read from the backend before it is believed — at most once per window,
// shared by concurrent misses, so unknown names cannot each cost a read. The
// driver here counts `listQueues`, which is what the known-queue list reads.
/** How many times the backend's queue list has been read. */
let queueReads = 0;
const countingDriver = new Proxy(driver, {
  get(target, property) {
    const value: unknown = Reflect.get(target, property, target);
    if (property === "listQueues" && typeof value === "function") {
      return (...args: unknown[]) => {
        queueReads++;
        return value.apply(target, args);
      };
    }
    return typeof value === "function" ? value.bind(target) : value;
  },
});
/** A context on the counting driver, in its own namespace. */
const countedContext = (suffix: string) => {
  const jobs = new BunJobs({
    namespace: `${namespace}-${suffix}`,
    driver: countingDriver,
    logger: createTestLogger().logger,
  });
  contexts.push(jobs);
  return jobs;
};
/** The backend reads `run` made. */
const readsDuring = async (run: () => Promise<unknown>) => {
  const before = queueReads;
  await run();
  return queueReads - before;
};
/** The statuses of a GET of each queue's counts, sent concurrently. */
const countsOf = async (api: ReturnType<typeof mount>, ...names: string[]) =>
  await Promise.all(
    names.map(
      async (name) => (await api.call("GET", `/queues/${name}/counts`)).status,
    ),
  );

const cached = mount(
  { limits: { queueCacheMs: 60_000 } },
  countedContext("cached"),
);
await cached.jobs.queue("mail").add("send", {});
checkEqual(
  "the first check reads the backend and fills the cache",
  await readsDuring(async () => countsOf(cached, "mail")),
  1,
);
checkEqual(
  "a hit is answered from the cache",
  await readsDuring(async () => countsOf(cached, "mail")),
  0,
);
// Created behind the API's back: the cache has not heard of it.
await cached.jobs.queue("late").add("send", {});
/** The statuses the concurrent misses answered. */
let lateStatuses: number[] = [];
checkEqual(
  "three concurrent misses share one re-read",
  await readsDuring(async () => {
    lateStatuses = await countsOf(cached, "late", "late", "late");
  }),
  1,
);
checkEqual(
  "which finds the queue: 200, not 404",
  lateStatuses,
  [200, 200, 200],
);
await cached.jobs.queue("later").add("send", {});
/** The status of a miss after the window's re-read was spent. */
let laterStatuses: number[] = [];
checkEqual(
  "another miss in the same window reads nothing",
  await readsDuring(async () => {
    laterStatuses = await countsOf(cached, "later");
  }),
  0,
);
checkEqual("so it is believed until the window ends", laterStatuses, [404]);

const uncached = mount(
  { limits: { queueCacheMs: 0 } },
  countedContext("uncached"),
);
await uncached.jobs.queue("mail").add("send", {});
checkEqual(
  "queueCacheMs: 0 reads on every check, and a miss once: no re-read",
  [
    await readsDuring(async () => countsOf(uncached, "mail")),
    await readsDuring(async () => countsOf(uncached, "absent")),
  ],
  [1, 1],
);
checkEqual(
  "so a queue created behind its back is found at once",
  await (async () => {
    await uncached.jobs.queue("late").add("send", {});
    return await countsOf(uncached, "late");
  })(),
  [200],
);

/* ------------------------------------------------------------------ */
step("GET /queues pages, and searches ignoring case");

const paging = mount(
  { limits: { queueCacheMs: 0, maxQueues: 2 } },
  context("paging"),
);
for (const name of ["mail-eu", "Mail-us", "reports"]) {
  await paging.jobs.queue(name).add("send", {});
}
const firstPage = (await paging.call("GET", "/queues")).body;
checkEqual("limit defaults to limits.maxQueues", firstPage.page, {
  offset: 0,
  limit: 2,
  total: 3,
  hasMore: true,
});
checkEqual("truncated is page.hasMore", firstPage.truncated, true);
const lastPage = (await paging.call("GET", "/queues?offset=2")).body;
checkEqual(
  "offset skips, in name order",
  [lastPage.page, lastPage.truncated],
  [{ offset: 2, limit: 2, total: 3, hasMore: false }, false],
);
const names = [...firstPage.items, ...lastPage.items].map(
  (item: { name: string }) => item.name,
);
checkEqual("every queue once, sorted by name", names, names.toSorted());
checkEqual(
  "a limit over maxQueues is a VALIDATION error",
  (await paging.call("GET", "/queues?limit=3")).body.code,
  "VALIDATION",
);
checkEqual(
  "search ignores case",
  (await paging.call("GET", "/queues?search=MAIL")).body.items
    .map((item: { name: string }) => item.name)
    .toSorted(),
  ["Mail-us", "mail-eu"],
);

/* ------------------------------------------------------------------ */
step('listQueues: "authorized" lists only the queues a caller may read');

// By default (`"all"`) `GET /queues` shows every reachable queue to anyone
// allowed `queues.list`, and asks `authorize` once per request. With
// `"authorized"` it also asks `queues.read` per queue — with the context
// `GET /queues/:queue` carries — and leaves out the ones denied.
const visibleContext = context("visible");
for (const name of ["billing", "mail", "payroll", "reports"]) {
  await visibleContext.queue(name).add("send", {});
}
/** Every `queues.read` the filtering APIs asked about. */
const perQueueAsks: JobsApiAuthorizeContext[] = [];
/** Denies reading `payroll`; records each per-queue ask. */
const payrollHidden: Parameters<typeof createJobsApi>[0]["authorize"] = (
  _req,
  authorizeContext,
) => {
  if (authorizeContext.action === "queues.read") {
    perQueueAsks.push(authorizeContext);
  }
  return !(
    authorizeContext.action === "queues.read" &&
    authorizeContext.queue === "payroll"
  );
};
const listingAll = mount(
  { authorize: payrollHidden, limits: { queueCacheMs: 0, maxQueues: 2 } },
  visibleContext,
);
const listingAuthorized = mount(
  {
    listQueues: "authorized",
    authorize: payrollHidden,
    limits: { queueCacheMs: 0, maxQueues: 2 },
  },
  visibleContext,
);
/** The names on a page of `GET /queues`. */
const namesOf = (body: { items: { name: string }[] }) =>
  body.items.map((item) => item.name);

perQueueAsks.length = 0;
const allPage = (await listingAll.call("GET", "/queues?offset=2")).body;
checkEqual(
  'the default, "all": payroll is listed, and no queue is asked about',
  [namesOf(allPage), allPage.page.total, perQueueAsks.length],
  [["payroll", "reports"], 4, 0],
);

perQueueAsks.length = 0;
const authorizedFirst = (await listingAuthorized.call("GET", "/queues")).body;
checkEqual(
  '"authorized": payroll is gone, and the page counts only what is shown',
  [namesOf(authorizedFirst), authorizedFirst.page, authorizedFirst.truncated],
  [["billing", "mail"], { offset: 0, limit: 2, total: 3, hasMore: true }, true],
);
checkEqual(
  "one queues.read per queue, every one (the total needs them all), not only the page's",
  perQueueAsks.map((authorizeContext) => authorizeContext.queue).toSorted(),
  ["billing", "mail", "payroll", "reports"],
);
checkEqual(
  "each asked as GET /queues/:queue asks it",
  perQueueAsks.find((authorizeContext) => authorizeContext.queue === "mail"),
  {
    action: "queues.read",
    mutation: false,
    transport: "http",
    queue: "mail",
    route: { method: "GET", path: "/queues/:queue" },
  },
);
const authorizedLast = (await listingAuthorized.call("GET", "/queues?offset=2"))
  .body;
checkEqual(
  "the last page: offset skips shown queues only",
  [namesOf(authorizedLast), authorizedLast.page, authorizedLast.truncated],
  [["reports"], { offset: 2, limit: 2, total: 3, hasMore: false }, false],
);

// /overview sums only the queues shown, too.
const overviewAll = mount(
  { authorize: payrollHidden, limits: { queueCacheMs: 0 } },
  visibleContext,
);
const overviewAuthorized = mount(
  {
    listQueues: "authorized",
    authorize: payrollHidden,
    limits: { queueCacheMs: 0 },
  },
  visibleContext,
);
checkEqual(
  "/overview: four queues by default, three when authorized",
  [
    (await overviewAll.call("GET", "/overview")).body.queues,
    (await overviewAuthorized.call("GET", "/overview")).body.queues,
  ],
  [4, 3],
);

// An authorize that throws fails the request, as it does on any route.
const throwingPerQueue = mount(
  {
    listQueues: "authorized",
    limits: { queueCacheMs: 0 },
    authorize: (_req, authorizeContext) => {
      if (authorizeContext.action === "queues.read") {
        throw new Error(SECRET);
      }
      return true;
    },
  },
  visibleContext,
);
const thrownList = await throwingPerQueue.call("GET", "/queues");
checkEqual(
  "a throwing authorize is a 500, with the generic detail",
  [thrownList.status, thrownList.body.code, thrownList.text.includes(SECRET)],
  [500, "INTERNAL", false],
);

// Without `queues.read` every queue would be hidden, so it never starts.
await checkRejects(
  '"authorized" without the queues.read action is a ConfigError',
  () =>
    createJobsApi({
      jobs: visibleContext,
      basePath: "/admin/jobs",
      listQueues: "authorized",
      actions: ["queues.list", "meta.read"],
      allowUnauthenticated: true,
      logger: createTestLogger().logger,
    }),
  { name: "ConfigError", message: /every queue would be hidden/ },
);
await checkRejects(
  "and so is a value that is neither",
  () =>
    createJobsApi({
      jobs: visibleContext,
      basePath: "/admin/jobs",
      listQueues: "some" as "all",
      allowUnauthenticated: true,
      logger: createTestLogger().logger,
    }),
  { name: "ConfigError", message: /must be "all" or "authorized"/ },
);

/* ------------------------------------------------------------------ */
step("GET /overview: a per-minute series beside the totals");

const overview = (await paging.call("GET", "/overview?minutes=5")).body;
checkEqual(
  "throughputSeries is present exactly when throughput is",
  "throughputSeries" in overview,
  "throughput" in overview,
);
if (overview.throughputSeries) {
  const series = overview.throughputSeries;
  checkEqual(
    "one bucket a minute, across the window asked for",
    [series.interval, series.buckets.length, series.to - series.from],
    [60_000, 5, 4 * 60_000],
  );
  checkEqual(
    "its totals are its buckets' sums",
    [series.completed, series.failed],
    [
      series.buckets.reduce(
        (sum: number, bucket: { completed: number }) => sum + bucket.completed,
        0,
      ),
      series.buckets.reduce(
        (sum: number, bucket: { failed: number }) => sum + bucket.failed,
        0,
      ),
    ],
  );
}
const uncounted = mount(
  {},
  new BunJobs({
    namespace: `${namespace}-uncounted`,
    driver: without(driver, ["getThroughput"]),
    logger: createTestLogger().logger,
  }),
);
contexts.push(uncounted.jobs);
const uncountedOverview = (await uncounted.call("GET", "/overview")).body;
checkEqual(
  "a driver that does not count throughput reports neither",
  ["throughput" in uncountedOverview, "throughputSeries" in uncountedOverview],
  [false, false],
);

/* ------------------------------------------------------------------ */
step("Job ids: 191 characters for a new one, 1024 to address one");

const identified = mount({
  actions: [...JOBS_API_ACTIONS],
  addableNames: "any",
});
/** Adds a job with `jobId` through the API. */
const addWithId = async (jobId: string) =>
  await identified.call("POST", "/queues/mail/jobs", {
    name: "send",
    data: {},
    opts: { jobId },
  });
checkEqual(
  "MAX_JOB_ID_LENGTH characters is a new id",
  (await addWithId("n".repeat(MAX_JOB_ID_LENGTH))).status,
  201,
);
const tooLong = await addWithId("n".repeat(MAX_JOB_ID_LENGTH + 1));
checkEqual(
  "one more is 400 VALIDATION, on opts.jobId",
  [tooLong.status, tooLong.body.code, tooLong.body.issues?.[0]?.path],
  [400, "VALIDATION", "opts.jobId"],
);
// Past the schema, `assertJobId` has the last word, and what it refuses is
// the caller's to fix: 400 INVALID_ARGUMENT, not a 500. JSON carries a lone
// surrogate as a `\ud800` escape, so a client can send one.
for (const [label, jobId] of [
  ["a control character", "inv\u0000-1"],
  ["C1 controls too", "inv\u0085-1"],
  ["a leading .", ".hidden"],
  ["a lone surrogate", "inv-\uD800-1"],
] as const) {
  const refused = await addWithId(jobId);
  checkEqual(
    `an id with ${label} is 400 INVALID_ARGUMENT`,
    [refused.status, refused.body.code],
    [400, "INVALID_ARGUMENT"],
  );
}
checkEqual(
  "while a slash is an ordinary character",
  (await addWithId("tenant/7")).status,
  201,
);
const longRef = "r".repeat(MAX_JOB_REF_LENGTH);
checkEqual(
  "a path may address an id of MAX_JOB_REF_LENGTH: not found, not invalid",
  (await identified.call("GET", `/queues/mail/jobs/${longRef}`)).body.code,
  "JOB_NOT_FOUND",
);
checkEqual(
  "and so may a bulk body",
  (
    await identified.call("POST", "/queues/mail/jobs/lookup", {
      ids: [longRef],
    })
  ).body.items,
  [null],
);
checkEqual(
  "one more is VALIDATION",
  [
    (await identified.call("GET", `/queues/mail/jobs/${longRef}r`)).body.code,
    (
      await identified.call("POST", "/queues/mail/jobs/lookup", {
        ids: [`${longRef}r`],
      })
    ).body.code,
  ],
  ["VALIDATION", "VALIDATION"],
);

/* ------------------------------------------------------------------ */
step("POST /jobs/:id/fail, and disabling or enabling a repeat series");

// A publishing context, so what the API does is heard as another process
// would hear it.
const failNamespace = `${namespace}-fail`;
const failJobs = new BunJobs({
  namespace: failNamespace,
  driver,
  publishEvents: true,
  logger: createTestLogger().logger,
});
contexts.push(failJobs);
const failApi = mount({}, failJobs);
const failQueue = failJobs.queue("mail");
const failNotifier = new JobsNotifier(driver, failNamespace, {
  queues: ["mail"],
  runners: [],
});
await failNotifier.start();
/** Every event the notifier heard. */
const failHeard: DriverEvent[] = [];
failNotifier.on("event", (event) => {
  failHeard.push(event);
});
/** The published event types about job `id`, in order. */
const heardAbout = (id: string) =>
  failHeard
    .filter((event) => event.kind === "queue" && event.id === id)
    .map((event) => event.type);

await failQueue.add("send", {}, { jobId: "doomed", attempts: 5 });
const failBody: FailJobBody = { reason: "bad address" };
const failAnswer = await failApi.call(
  "POST",
  "/queues/mail/jobs/doomed/fail",
  failBody,
);
const failResult: FailJobResultDto = failAnswer.body;
checkEqual(
  "POST …/fail answers 200 { failed: true }",
  [failAnswer.status, failResult],
  [200, { failed: true }],
);
const doomed = await failQueue.getJob("doomed");
checkEqual(
  "the job is dead at once, with the reason, and no attempt made",
  [
    doomed?.state,
    doomed?.failedReason?.name,
    doomed?.failedReason?.message,
    doomed?.attemptsMade,
  ],
  ["dead", "UnrecoverableJobError", "bad address", 0],
);
checkEqual(
  "authorize was asked for jobs.fail, targeting the job",
  failApi.calls
    .filter((call) => call.action === "jobs.fail")
    .map((call) => [call.queue, call.jobId, call.mutation]),
  [["mail", "doomed", true]],
);
const failedTwice = await failApi.call(
  "POST",
  "/queues/mail/jobs/doomed/fail",
  { reason: "twice" },
);
checkEqual(
  "a job already finished is 409 JOB_STATE_CONFLICT",
  [failedTwice.status, failedTwice.body.code],
  [409, "JOB_STATE_CONFLICT"],
);
checkEqual(
  "an unknown job is 404, and a missing reason 400",
  [
    (
      await failApi.call("POST", "/queues/mail/jobs/ghost/fail", {
        reason: "x",
      })
    ).status,
    (await failApi.call("POST", "/queues/mail/jobs/doomed/fail", {})).status,
  ],
  [404, 400],
);

// A reason must say something: one of only whitespace is refused (the
// schema's pattern is `\S`), but one that says something is kept verbatim.
await failQueue.add("send", {}, { jobId: "padded" });
const blankReasons = await Promise.all(
  ["", "   ", "\n\t"].map(async (reason) => {
    const answer = await failApi.call("POST", "/queues/mail/jobs/padded/fail", {
      reason,
    });
    return [answer.status, answer.body.code, answer.body.issues?.[0]?.path];
  }),
);
checkEqual(
  "an empty or whitespace-only reason is 400 VALIDATION at reason",
  blankReasons,
  [
    [400, "VALIDATION", "reason"],
    [400, "VALIDATION", "reason"],
    [400, "VALIDATION", "reason"],
  ],
);
const paddedReason = "  bad address\n";
checkEqual(
  "a reason with leading and trailing spaces is stored exactly as sent",
  [
    (
      await failApi.call("POST", "/queues/mail/jobs/padded/fail", {
        reason: paddedReason,
      })
    ).status,
    (await failQueue.getJob("padded"))?.failedReason?.message,
  ],
  [200, paddedReason],
);

// An active job: buried under the worker, whose processor then throws once
// its heartbeat finds the lock gone. `failed` and `dead` exactly once.
let apiStarted = false;
let apiRelease!: () => void;
const apiGate = new Promise<void>((resolve) => {
  apiRelease = resolve;
});
const apiWorker = new BunQueueWorker(
  "mail",
  async (job, ctx) => {
    if (job.name !== "long") {
      return null;
    }
    apiStarted = true;
    await apiGate;
    await ctx.heartbeat();
    throw new Error(`stopped, aborted: ${ctx.signal.aborted}`);
  },
  {
    namespace: failNamespace,
    driver,
    logger: createTestLogger().logger,
    publish: true,
    concurrency: 1,
    lockDuration: 120_000,
    heartbeatInterval: 60_000,
    pollInterval: 10,
    maxBlock: 50,
  },
);
void apiWorker.run();
await failQueue.add("long", {}, { jobId: "running", attempts: 3, backoff: 0 });
await waitFor("the long job to start", () => apiStarted, { timeout: 30_000 });
checkEqual(
  "an active job fails through the API too",
  (
    await failApi.call("POST", "/queues/mail/jobs/running/fail", {
      reason: "pulled by an operator",
    })
  ).status,
  200,
);
apiRelease();
await failQueue.add("marker", {}, { jobId: "after-running" });
await waitFor(
  "the worker to settle both",
  () => heardAbout("after-running").includes("completed"),
  { timeout: 30_000 },
);
checkEqual(
  "failed and dead published exactly once, and never retrying",
  heardAbout("running").filter((type) =>
    ["failed", "dead", "retrying", "completed"].includes(type),
  ),
  ["failed", "dead"],
);
checkEqual(
  "and the job is dead with the operator's reason",
  [
    (await failQueue.getJob("running"))?.state,
    (await failQueue.getJob("running"))?.failedReason?.message,
  ],
  ["dead", "pulled by an operator"],
);
await apiWorker.close();
await failNotifier.close();

// A repeat series: RepeatableDto.disabled, and the two idempotent routes.
await failQueue.add("digest", {}, { repeat: { every: 60_000, key: "daily" } });
/** The listed `daily` series, as a client reads it. */
const daily = async (): Promise<RepeatableDto | undefined> =>
  (await failApi.call("GET", "/queues/mail/repeatables")).body.items.find(
    (item: RepeatableDto) => item.key === "daily",
  );
const pendingDaily = (await daily())!.nextJobId!;
checkEqual(
  "RepeatableDto.disabled is always present: false to begin with",
  (await daily())?.disabled,
  false,
);

const disabledAnswer = await failApi.call(
  "POST",
  "/queues/mail/repeatables/daily/disable",
);
const disabledResult: DisableRepeatableResultDto = disabledAnswer.body;
checkEqual(
  "POST …/disable answers 200 { disabled: true }",
  [disabledAnswer.status, disabledResult],
  [200, { disabled: true }],
);
checkEqual(
  "the series is listed disabled, and its pending occurrence is gone",
  [(await daily())?.disabled, await failQueue.getJob(pendingDaily)],
  [true, null],
);
checkEqual(
  "a disabled series has no next run: nextJobId and nextRunAt are null",
  [(await daily())?.nextJobId, (await daily())?.nextRunAt],
  [null, null],
);
checkEqual(
  "disabling again is idempotent: the same 200",
  [
    (await failApi.call("POST", "/queues/mail/repeatables/daily/disable"))
      .status,
    (await daily())?.disabled,
  ],
  [200, true],
);

const enabledAnswer = await failApi.call(
  "POST",
  "/queues/mail/repeatables/daily/enable",
);
const enabledResult: EnableRepeatableResultDto = enabledAnswer.body;
checkEqual(
  "POST …/enable answers 200 { enabled: true }",
  [enabledAnswer.status, enabledResult],
  [200, { enabled: true }],
);
const enabledDaily = await daily();
checkEqual(
  "enabled, with a new occurrence scheduled",
  [
    enabledDaily?.disabled,
    (await failQueue.getJob(enabledDaily!.nextJobId!))?.state,
  ],
  [false, "delayed"],
);
const nextDaily = await failQueue.getJob(enabledDaily!.nextJobId!);
checkEqual(
  "…and its next pointers are set again: nextRunAt is that occurrence's runAt",
  enabledDaily?.nextRunAt,
  nextDaily ? new Date(nextDaily.runAt).getTime() : null,
);
checkEqual(
  "enabling again is idempotent too",
  (await failApi.call("POST", "/queues/mail/repeatables/daily/enable")).status,
  200,
);
for (const verb of ["disable", "enable"]) {
  const missing = await failApi.call(
    "POST",
    `/queues/mail/repeatables/no-such-series/${verb}`,
  );
  checkEqual(
    `${verb}: an unknown key is 404 REPEATABLE_NOT_FOUND`,
    [missing.status, missing.body.code],
    [404, "REPEATABLE_NOT_FOUND"],
  );
}
checkEqual(
  "authorize was asked for each action by name",
  [
    ...new Set(
      failApi.calls
        .map((call) => call.action)
        .filter((action) => action.startsWith("repeatables.")),
    ),
  ].sort(),
  ["repeatables.disable", "repeatables.enable", "repeatables.list"],
);
/** The OpenAPI document's `Repeatable` component, loosely typed. */
const repeatableSchema = (
  failApi.api.openapi() as unknown as {
    components: {
      schemas: Record<
        string,
        {
          required?: string[];
          properties: Record<string, { type?: string }>;
        }
      >;
    };
  }
).components.schemas.Repeatable;
const disabledProperty = repeatableSchema?.properties.disabled;
check(
  "the OpenAPI Repeatable schema requires disabled, a boolean",
  (repeatableSchema?.required ?? []).includes("disabled") &&
    disabledProperty?.type === "boolean",
  repeatableSchema,
);

/* ------------------------------------------------------------------ */
step("The OpenAPI document states what a client must send");

/** Every operation in a document, with its path and method. */
function operationsOf(api: { openapi: () => unknown }) {
  const paths = (api.openapi() as { paths: Record<string, any> }).paths;
  return Object.entries(paths).flatMap(([path, methods]) =>
    Object.entries(methods as Record<string, any>).map(([method, op]) => ({
      path,
      method,
      op,
    })),
  );
}
/** The operation for one action. */
const operationFor = (api: { openapi: () => unknown }, action: string) =>
  operationsOf(api).find(({ op }) => op["x-bun-jobs-action"] === action)!.op;

const pauseOp = operationFor(headerGuarded.api, "queues.pause");
checkEqual(
  "a mutation requires the CSRF header",
  pauseOp.parameters
    .filter((parameter: { in: string }) => parameter.in === "header")
    .map((parameter: { name: string; required: boolean }) => [
      parameter.name,
      parameter.required,
    ]),
  [["x-bun-jobs-csrf", true]],
);
checkEqual("and says so in x-bun-jobs-csrf", pauseOp["x-bun-jobs-csrf"], {
  header: "x-bun-jobs-csrf",
  requireJson: true,
});
checkEqual(
  "a bodiless POST still declares application/json",
  [
    pauseOp.requestBody?.required,
    Object.keys(pauseOp.requestBody?.content ?? {}),
  ],
  [false, ["application/json"]],
);
check(
  "a read carries neither",
  operationsOf(headerGuarded.api)
    .filter(({ method }) => method === "get")
    .every(
      ({ op }) =>
        op["x-bun-jobs-csrf"] === undefined &&
        !(op.parameters ?? []).some(
          (parameter: { in: string }) => parameter.in === "header",
        ),
    ),
);
const unguardedPause = operationFor(undefended.api, "queues.pause");
checkEqual(
  "with csrf: false, a bodiless POST declares no body at all",
  [unguardedPause["x-bun-jobs-csrf"], unguardedPause.requestBody],
  [undefined, undefined],
);
/** The schema of one path parameter of an action's operation. */
const paramSchema = (action: string, name: string) =>
  operationFor(withArgs.api, action).parameters.find(
    (parameter: { name: string }) => parameter.name === name,
  ).schema;
checkEqual(
  ":queue and :runner carry the name rule the routes enforce",
  [
    paramSchema("queues.pause", "queue"),
    paramSchema("runners.trigger", "runner"),
  ].map((schema: { pattern: string; maxLength: number }) => [
    schema.pattern,
    schema.maxLength,
  ]),
  [
    [NAME_PARAM_PATTERN, MAX_NAME_LENGTH],
    [NAME_PARAM_PATTERN, MAX_NAME_LENGTH],
  ],
);

/* ------------------------------------------------------------------ */
step("GET /runners: lifecycle status, isPaused, isRunning and isLocal");

// Five runners: three registered here — one never started, one started on a
// schedule with nothing in flight, one with a run holding its lock — and two
// registered by "another process" (a second context on the same backend and
// namespace): one paused, one with a run in flight.
const runnerContext = context("runner-list");
const listing = mount({}, runnerContext);
/** A handler that works until it is killed. */
const WORK = new URL("./handlers/runner-work.ts", import.meta.url).pathname;
/** Registers one in-process runner in `jobs`. */
const workRunner = (jobs: BunJobs, id: string) =>
  jobs.runner({
    id,
    file: WORK,
    executionMode: "in-process",
    schedule: { every: 3_600_000 },
  });
workRunner(runnerContext, "unstarted");
await workRunner(runnerContext, "armed").start();
const busyHere = workRunner(runnerContext, "busy-here");
await busyHere.start();
await busyHere.trigger({ args: { ms: 60_000 } });

const elsewhere = new BunJobs({
  namespace: runnerContext.namespace,
  driver,
  logger: createTestLogger().logger,
});
const pausedThere = workRunner(elsewhere, "paused-there");
await pausedThere.start();
await pausedThere.pause();
const busyThere = workRunner(elsewhere, "busy-there");
await busyThere.start();
await busyThere.trigger({ args: { ms: 60_000 } });

/** The list, by id. */
const listedRunners = async () =>
  new Map(
    (
      (await listing.call("GET", "/runners")).body.items as RunnerListItemDto[]
    ).map((item) => [item.id, item] as const),
  );
await waitFor("both runs to hold their locks", async () => {
  const items = await listedRunners();
  return (
    items.get("busy-here")?.isRunning === true &&
    items.get("busy-there")?.isRunning === true
  );
});
const listedById = await listedRunners();
/** One item as `[isLocal, status, isPaused, isRunning]`. */
const flagsOf = (id: string) => {
  const item = listedById.get(id)!;
  return [item.isLocal, item.status ?? null, item.isPaused, item.isRunning];
};
checkEqual(
  "status is lifecycle, not a run in flight: idle = not started, running = started and armed",
  [flagsOf("unstarted"), flagsOf("armed"), flagsOf("busy-here")],
  [
    [true, "idle", false, false],
    [true, "running", false, false],
    [true, "running", false, true],
  ],
);
checkEqual(
  "a remote runner has no status, but isPaused and isRunning from the backend",
  [flagsOf("paused-there"), flagsOf("busy-there")],
  [
    [false, null, true, false],
    [false, null, false, true],
  ],
);
check(
  "local, deprecated, is a copy of isLocal on every item",
  [...listedById.values()].every((item) => item.local === item.isLocal),
);
/** What `GET /runners/:runner` says, for the same fields. */
const details = await Promise.all(
  [...listedById.keys()].map(async (id) => {
    const info: RunnerInfoDto = (await listing.call("GET", `/runners/${id}`))
      .body;
    return [id, info.isLocal, info.isPaused, info.isRunning];
  }),
);
checkEqual(
  "isLocal, isPaused and isRunning match each runner's own GET /runners/:runner",
  details,
  [...listedById.values()].map((item) => [
    item.id,
    item.isLocal,
    item.isPaused,
    item.isRunning,
  ]),
);

// `local` is still sent, and flagged deprecated: in the OpenAPI document...
const listItemSchema = operationFor(listing.api, "runners.list").responses[
  "200"
].content["application/json"].schema.properties.items.items;
checkEqual(
  "OpenAPI: local is deprecated: true, isLocal is not",
  [
    listItemSchema.properties.local.deprecated,
    listItemSchema.properties.isLocal.deprecated,
  ],
  [true, undefined],
);
// ...and in the contract, where `@deprecated` makes an editor strike it
// through. A doc tag has no type, so the check reads the contract's source.
const contractSource = await Bun.file(
  new URL("types.ts", import.meta.resolve("@kingsleyweb/bun-jobs/api/contract"))
    .pathname,
).text();
const listItemDeclaration =
  /export interface RunnerListItemDto \{[\s\S]*?\n\}/.exec(
    contractSource,
  )?.[0] ?? "";
check(
  "contract: RunnerListItemDto.local carries @deprecated, isLocal does not",
  /@deprecated[^/]*\*\/\s*local: boolean;/.test(listItemDeclaration) &&
    /\*\/\s*isLocal: boolean;/.test(listItemDeclaration) &&
    !/@deprecated[^/]*\*\/\s*isLocal: boolean;/.test(listItemDeclaration),
  listItemDeclaration,
);

await busyHere.kill();
await busyThere.kill();
await elsewhere.close();

/* ------------------------------------------------------------------ */
step(
  "PUT /runners/:runner/schedule: INVALID_SCHEDULE says which part is wrong",
);

/** The refusal of one schedule, as `[status, code, issues]`. */
const refusedSchedule = async (schedule: unknown) => {
  const answer = await listing.call("PUT", "/runners/armed/schedule", {
    schedule,
  });
  return [
    answer.status,
    answer.body.code,
    answer.body.issues,
    answer.body.detail,
  ] as const;
};
/** The issue path a refused schedule is blamed on, checking the rest of its shape. */
const blamed = async (schedule: unknown) => {
  const [status, code, issues, detail] = await refusedSchedule(schedule);
  check(
    `${JSON.stringify(schedule)}: 400 INVALID_SCHEDULE, one body issue carrying the detail`,
    status === 400 &&
      code === "INVALID_SCHEDULE" &&
      issues?.length === 1 &&
      issues[0].target === "body" &&
      issues[0].message === detail,
    { status, code, issues },
  );
  return issues?.[0]?.path;
};
checkEqual(
  "a bare cron string is blamed on schedule",
  await blamed("not a cron expression"),
  "schedule",
);
checkEqual(
  "{ cron } on schedule.cron",
  await blamed({ cron: "99 * * * *" }),
  "schedule.cron",
);
checkEqual(
  "{ cron, tz } with a good expression on schedule.tz",
  await blamed({ cron: "0 9 * * *", tz: "Nowhere/Land" }),
  "schedule.tz",
);
checkEqual(
  "a bad expression is blamed before a bad zone",
  await blamed({ cron: "99 * * * *", tz: "Nowhere/Land" }),
  "schedule.cron",
);
// A time a `Date` cannot hold never reaches the scheduler: the body's schema
// caps epoch ms at MAX_DATE_MS (8.64e15), so it is VALIDATION at the field.
checkEqual(
  "{ at } beyond what a Date can hold: 400 VALIDATION at schedule.at",
  await refusedSchedule({ at: Number.MAX_SAFE_INTEGER }),
  [
    400,
    "VALIDATION",
    [
      {
        target: "body",
        path: "schedule.at",
        message: "Expected a value of at most 8640000000000000",
      },
    ],
    "The request did not match the schema",
  ],
);

// So over HTTP INVALID_SCHEDULE is only ever about a cron expression or a
// zone: an interval, anchor or time the schema refuses is VALIDATION at the
// field, before the scheduler sees it.
/** A refused schedule as `[status, code, the issue paths]`. */
const validatedAt = async (schedule: unknown) => {
  const [status, code, issues] = await refusedSchedule(schedule);
  return [
    status,
    code,
    (issues as { path: string }[] | undefined)?.map((issue) => issue.path),
  ];
};
check(
  "MAX_DATE_MS is the latest instant a Date holds, from the contract",
  MAX_DATE_MS === 8_640_000_000_000_000 &&
    new Date(MAX_DATE_MS).getTime() === MAX_DATE_MS &&
    Number.isNaN(new Date(MAX_DATE_MS + 1).getTime()),
  MAX_DATE_MS,
);
checkEqual(
  "{ at: MAX_DATE_MS + 1 }: 400 VALIDATION at schedule.at",
  await validatedAt({ at: MAX_DATE_MS + 1 }),
  [400, "VALIDATION", ["schedule.at"]],
);
checkEqual(
  "{ every, anchor: MAX_DATE_MS + 1 }: 400 VALIDATION at schedule.anchor",
  await validatedAt({ every: 60_000, anchor: MAX_DATE_MS + 1 }),
  [400, "VALIDATION", ["schedule.anchor"]],
);
checkEqual(
  "{ every, anchor } that is no date-time: 400 VALIDATION at schedule.anchor",
  await validatedAt({ every: 60_000, anchor: "next tuesday" }),
  [400, "VALIDATION", ["schedule.anchor"]],
);
checkEqual(
  "{ every: 0 }: 400 VALIDATION at schedule.every",
  await validatedAt({ every: 0 }),
  [400, "VALIDATION", ["schedule.every"]],
);
checkEqual(
  "a bare interval of 0: 400 VALIDATION at schedule",
  await validatedAt(0),
  [400, "VALIDATION", ["schedule"]],
);

// A job's runAt has the same cap, on both routes that take one (both opt-in
// actions, so this API enables every action).
const timed = mount({ actions: [...JOBS_API_ACTIONS] });
await timed.jobs.queue("mail").add("send", {}, { jobId: "later" });
/** A refused request as `[status, code, the issue paths]`. */
const refusedAt = async (method: string, path: string, body: unknown) => {
  const answer = await timed.call(method, path, body);
  return [
    answer.status,
    answer.body.code,
    (answer.body.issues as { path: string }[] | undefined)?.map(
      (issue) => issue.path,
    ),
  ];
};
checkEqual(
  "PATCH a job with runAt: MAX_DATE_MS + 1: 400 VALIDATION at runAt",
  await refusedAt("PATCH", "/queues/mail/jobs/later", {
    runAt: MAX_DATE_MS + 1,
  }),
  [400, "VALIDATION", ["runAt"]],
);
checkEqual(
  "POST a job with opts.runAt: MAX_DATE_MS + 1: 400 VALIDATION at opts.runAt",
  await refusedAt("POST", "/queues/mail/jobs", {
    name: "send",
    data: {},
    opts: { runAt: MAX_DATE_MS + 1 },
  }),
  [400, "VALIDATION", ["opts.runAt"]],
);
checkEqual(
  "and nothing was written",
  (await listing.call("GET", "/runners/armed")).body.schedule,
  { every: 3_600_000 },
);

/* ------------------------------------------------------------------ */
step("The contract entry point is where the server's constants come from");

check(
  "the root's action list is the contract's own",
  JOBS_API_ACTIONS === CONTRACT_ACTIONS,
);
checkEqual(
  "the name rule, and the id caps",
  [MAX_NAME_LENGTH, MAX_JOB_ID_LENGTH, MAX_JOB_REF_LENGTH],
  [200, 191, 1024],
);
check(
  "the pattern refuses . and .. and accepts an ordinary name",
  !new RegExp(NAME_PARAM_PATTERN).test(".") &&
    !new RegExp(NAME_PARAM_PATTERN).test("..") &&
    new RegExp(NAME_PARAM_PATTERN).test("mail.eu-1"),
);

/* ------------------------------------------------------------------ */
step("Cleaning up");

await Promise.all(
  [
    both,
    noRunners,
    listed,
    jobsOnly,
    runnerOnly,
    readOnly,
    byDefault,
    narrow,
    onlyOptIns,
    everything,
    restricted,
    partial,
    older,
    errors,
    crashing,
    refusing,
    once,
    capped,
    limited,
    defended,
    headerGuarded,
    undefended,
    direct,
    trusting,
    cors,
    plain,
    exposing,
    redacting,
    hosts,
    adding,
    anyName,
    listedNames,
    withArgs,
    validating,
    docsDefault,
    docsOn,
    docsOff,
    wrapped,
    published,
    argsReadOnly,
    ownPort,
    noDocsAction,
    noSocket,
    previewing,
    creating,
    configured,
    cached,
    uncached,
    paging,
    uncounted,
    identified,
    failApi,
    byRoute,
    listingAll,
    listingAuthorized,
    overviewAll,
    overviewAuthorized,
    throwingPerQueue,
    listing,
    timed,
    sampling,
    ...matrixHosts,
  ].map((mounted) => mounted.api.close()),
);
for (const jobs of contexts) {
  await jobs.purge();
  await jobs.close();
}
await driver.close();

summary();
