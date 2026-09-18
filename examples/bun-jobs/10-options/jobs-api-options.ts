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
 *   first — validation, CSRF, a malformed body — it is asked *without* a
 *   target, and only a caller it allows is told what was wrong. That is what
 *   keeps an unauthenticated caller from probing a route's schema.
 * - **A 5xx never carries the underlying message.** Its `detail` is the
 *   generic title, always.
 */
import type {
  JobsApiAuthorizeContext,
  JobsDriver,
} from "@kingsleyweb/bun-jobs";
import { BunRouter, createTestLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createDriver,
  createJobsApi,
  DEFAULT_JOBS_API_LIMITS,
  JOBS_API_ACTIONS,
  JOBS_API_MUTATIONS,
  JOBS_API_OPT_IN_ACTIONS,
  runnerKey,
} from "@kingsleyweb/bun-jobs";
import {
  JOBS_API_ACTIONS as CONTRACT_ACTIONS,
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

/** Operation ids of an API's routes. */
const idsOf = (api: { routes: readonly { operationId: string }[] }) =>
  api.routes.map((route) => route.operationId);

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
checkEqual("every action, every route", both.api.routes.length, 44);

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
checkEqual("mode: jobs", jobsOnly.api.routes.length, 34);
checkEqual("mode: runner", runnerOnly.api.routes.length, 14);
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
checkEqual("what is left", readOnly.api.routes.length, 23);
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
step("actions: an allow-list, with two opt-ins absent by default");

const byDefault = mount();
checkEqual(
  "the defaults are every action but the opt-ins",
  byDefault.api.routes.length,
  42,
);
check(
  "jobs.add and jobs.update are the opt-ins",
  [...JOBS_API_OPT_IN_ACTIONS].sort().join(",") === "jobs.add,jobs.update",
  [...JOBS_API_OPT_IN_ACTIONS],
);
check(
  "so neither route is registered",
  !idsOf(byDefault.api).includes("addJob") &&
    !idsOf(byDefault.api).includes("updateJob"),
  idsOf(byDefault.api),
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
  "33 actions in total",
  Object.keys(permissions).length,
  JOBS_API_ACTIONS.length,
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
  "this backend supports everything the API can use",
  Object.values(fullFeatures).every(Boolean),
  true,
);

const olderDriver = without(driver, [
  "getJobLogs",
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
  ["getJobLogs", "getQueueThroughput", "updateJob"],
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
check(
  "and it is absent from the OpenAPI document too",
  !JSON.stringify(older.api.openapi()).includes("/logs"),
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
step("A failed check asks authorize first, without a target");

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
  checkEqual(`${probe.name}: and without a target`, allowed.calls[0], {
    action: "jobs.retry",
    mutation: true,
    transport: "http",
    route: { method: "POST", path: "/queues/:queue/jobs/retry" },
  });

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

// `publishing` is `null` rather than true/false: `BunJobs` has no public
// getter for `publishEvents`, so the API cannot tell a client either way and
// says so honestly instead of guessing.
const publishing = new BunJobs({
  namespace: `${namespace}-publishing`,
  driver,
  logger: createTestLogger().logger,
  publishEvents: true,
});
contexts.push(publishing);
const published = mount({}, publishing);
checkEqual(
  "publishing is reported as unknown",
  (await published.call("GET", "/meta")).body.publishing,
  null,
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

// limits: every cap the routes enforce, read from the same values.
checkEqual(
  "limits: each configured cap, and the defaults for the rest",
  (await limited.call("GET", "/meta")).body.limits,
  {
    defaultPageSize: 2,
    maxPageSize: 5,
    maxBulkIds: 3,
    maxRetryAll: DEFAULT_JOBS_API_LIMITS.maxRetryAll,
    maxClean: 10,
    maxLogPage: 4,
    maxHistory: 6,
    maxJobDataBytes: 64,
    maxQueues: 1,
  },
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
const preview = async (channel?: string) =>
  (
    await previewing.call(
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
// A channel that does not parse, or names a queue outside `queues`, has no
// canonical key: it is refused as a subscribe ack would refuse it.
checkEqual(
  "refused before authorize, with no key",
  [await preview("nonsense"), await preview("queue/other")].map((answer) => [
    answer.allowed,
    answer.code,
    answer.status,
    "key" in answer,
  ]),
  [
    [false, "INVALID_CHANNEL", 400, false],
    [false, "QUEUE_NOT_FOUND", 404, false],
  ],
);
checkEqual("and absent unless asked for", await preview(), undefined);

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
    paging,
    uncounted,
    identified,
  ].map((mounted) => mounted.api.close()),
);
for (const jobs of contexts) {
  await jobs.purge();
  await jobs.close();
}
await driver.close();

summary();
