/**
 * Summoning over HTTP: a queue's summon status, "summon now" and reset, from
 * the management API, and the `queue.summon` event on its socket.
 *
 * ```bash
 * bun 11-management-api/summon-routes.ts
 * ```
 *
 * `GET /summon` (`queues.list`) lists every summon controller in the API's
 * process with its budget usage; `GET /queues/:queue/summon` (`queues.read`)
 * answers one queue's summon status; `POST /queues/:queue/summon` runs one
 * check at once, as `check({ reason: "manual", force })`;
 * `POST /queues/:queue/summon/reset` clears failures, backoff and an open
 * circuit — and, with `{ "budget": true }`, the budget's usage — and answers
 * the status after it. The summoners here start nothing — one records what
 * it was asked and hands back a platform identifier, one fails every call —
 * so no worker is ever started. The one child process,
 * [`helpers/summoned-api.ts`](./helpers/summoned-api.ts), stands in for a
 * summoned worker that shares the API's config, to show its controller
 * listed as inert. Summoning needs a backend another process can reach, so
 * on the memory driver this runs on a temporary SQLite file.
 *
 * The points that are easy to get wrong:
 *
 * - **The two writes are opt-in.** `queues.summon` is off unless `actions`
 *   names it, and `readOnly` removes it even then: it can spend money. The
 *   status and the list are plain reads, served by default.
 * - **`force` skips the cooldown and nothing else.** An attempt already on
 *   its way, an open circuit, the budget and live workers still hold "summon
 *   now" back, answered `skipped` with the guard's `reason`.
 * - **Reset clears guards, not the record.** Failures go to 0, the backoff
 *   and the circuit are cleared; attempts in flight and the last outcome stay.
 *   The budget's usage stays too, unless the body says `{ "budget": true }`.
 * - **The API never builds a controller.** It finds the one the `jobs` it was
 *   given runs; a queue without one is 409 `SUMMON_NOT_CONFIGURED` on each of
 *   the queue's three routes, while `GET /summon` with none at all is an
 *   empty list.
 * - **The list is never looser than the status route.** `GET /summon` asks
 *   `queues.list`, then `queues.read` for each controller's queue exactly as
 *   `GET /queues/:queue/summon` asks it, and leaves out what that refuses.
 *   An inert controller is listed, with `inert: true` and its `inertReason`.
 * - **Platform handles stay home by default.** A pending attempt's `handles`
 *   in the status, and the `queue.summon` event's, go out only with
 *   `serialize.exposeSummonHandles` (a task ARN carries an AWS account id).
 *   The event is about compute, not a job: it reaches `queue/{q}`, never a
 *   job channel.
 */
import type {
  JobsApiAction,
  JobsApiAuthorizeContext,
  JobsApiConfig,
  MetaDto,
  SummonCheckDto,
  SummonListDto,
  SummonRequest,
  SummonResetBody,
  SummonStatusDto,
} from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { BunHttpAdapter, createTestLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  defineSummoner,
  JOBS_API_ACTIONS,
  JOBS_API_OPT_IN_ACTIONS,
} from "@kingsleyweb/bun-jobs";
import { crossProcessDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { connectJobsSocket } from "./helpers/jobs-socket";

title("The management API: summoning over HTTP");

/** Every trigger off: only the API's "summon now" runs a check. */
const ONE_SHOT = { onAdd: false, events: false, poll: false } as const;

/* ------------------------------------------------------------------ */
step("Four summoned queues, and one without a controller");

/** Every request the recording summoner was handed, in order. */
const recorded: SummonRequest[] = [];

/**
 * A summoner that starts nothing: it records the request and answers
 * `started` with a platform identifier, as a real one answers with a task ARN.
 */
const recording = defineSummoner({
  kind: "example-record",
  invoke: async (request: SummonRequest) => {
    recorded.push(request);
    return { status: "started", handles: [`task/${request.id}`] };
  },
  // Facts are for the status route. The token is there to be dropped: a key
  // that looks like a credential never leaves the server.
  describe: () => ({ cluster: "local", apiToken: "tok-never-served" }),
});

/** How many times the failing summoner was called. */
let failingCalls = 0;
/** A summoner whose platform is down: every call throws. */
const failing = defineSummoner({
  kind: "example-down",
  invoke: async () => {
    failingCalls++;
    throw new Error("the platform is down");
  },
});

// The controllers log each failed call as an error; collected, not printed.
const { logger } = createTestLogger();

/** The backend, kept: the summoned process in step 7 opens the same one. */
const config = crossProcessDriver();
const jobs = new BunJobs({
  namespace: exampleNamespace("summon-api"),
  driver: config,
  logger,
  summon: {
    reports: { summoner: recording, triggers: ONE_SHOT },
    // Two queues for the socket step, one per serializer setting.
    alerts: { summoner: recording, triggers: ONE_SHOT },
    exports: { summoner: recording, triggers: ONE_SHOT },
    flaky: {
      summoner: failing,
      triggers: ONE_SHOT,
      // A 1 ms backoff, so the tour does not wait out a real one; two
      // failures open the circuit for a minute.
      backoff: { initial: 1, max: 1 },
      circuit: { failures: 2, resetAfter: 60_000 },
    },
  },
});

await jobs.queue("reports").add("render", { id: 1 });
await jobs.queue("flaky").add("run", {});
await jobs.queue("alerts").add("page", { to: "on-call" });
await jobs.queue("exports").add("csv", { table: "orders" });
// `plain` has work but no summon policy, so nothing here can summon for it.
await jobs.queue("plain").add("run", {});

/** The default actions plus `queues.summon`: "summon now" and reset. */
const SUMMON_ACTIONS: JobsApiAction[] = JOBS_API_ACTIONS.filter(
  (action) =>
    !JOBS_API_OPT_IN_ACTIONS.has(action) || action === "queues.summon",
);

/** An API over `jobs` at `/admin/jobs`, mounted on an adapter of its own. */
function mount(config: Partial<JobsApiConfig> = {}) {
  const api = createJobsApi({
    jobs,
    basePath: "/admin/jobs",
    // A real deployment decides from a session or a token; this tour is
    // about which routes exist, so every call that has a route is allowed.
    authorize: () => true,
    ...config,
  });
  const adapter = new BunHttpAdapter(0);
  adapter.use(api.basePath, api.router);

  /**
   * One request against this API, answered as status and parsed body. A
   * write is sent as JSON, body or not: the API refuses a state change of
   * any other type (415), which keeps a plain HTML form from posting one.
   */
  async function call(method: "GET" | "POST", path: string, body?: object) {
    const response = await adapter.fetch(`${api.basePath}${path}`, {
      method,
      ...(method === "GET"
        ? {}
        : { headers: { "content-type": "application/json" } }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  }

  /**
   * The summon routes this API registered, by operation id: a queue's three
   * and `GET /summon`, the list of every controller.
   */
  const summonRoutes = () =>
    api.routes
      .filter((route) => route.path.includes("/summon"))
      .map(
        (route) => `${route.operationId}${route.mutation ? " (mutation)" : ""}`,
      )
      .sort();

  return { api, adapter, call, summonRoutes };
}

/* ------------------------------------------------------------------ */
step(
  "1. queues.summon is opt-in: the default API reads the status, and that is all",
);

const plainApi = mount();
checkEqual(
  "the default API registers the two reads alone: a queue's status and the list",
  plainApi.summonRoutes(),
  ["getQueueSummon", "listSummonControllers"],
);
checkEqual(
  "GET …/summon 200; both POSTs 404 ROUTE_NOT_FOUND; the summoner was never called",
  [
    (await plainApi.call("GET", "/queues/reports/summon")).status,
    ...(await Promise.all(
      ["/queues/reports/summon", "/queues/reports/summon/reset"].map(
        async (path) => {
          const { status, body } = await plainApi.call("POST", path);
          return `${status} ${body.code}`;
        },
      ),
    )),
    recorded.length,
  ],
  [200, "404 ROUTE_NOT_FOUND", "404 ROUTE_NOT_FOUND", 0],
);

const readOnlyApi = mount({ actions: SUMMON_ACTIONS, readOnly: true });
checkEqual(
  "readOnly removes the two writes even when actions names queues.summon, and keeps the reads",
  [
    readOnlyApi.summonRoutes(),
    (await readOnlyApi.call("GET", "/queues/reports/summon")).status,
    (await readOnlyApi.call("POST", "/queues/reports/summon")).status,
    recorded.length,
  ],
  [["getQueueSummon", "listSummonControllers"], 200, 404, 0],
);

const panel = mount({ actions: SUMMON_ACTIONS });
checkEqual(
  "opted in: the two reads, summon now and reset, the two writes marked as mutations",
  panel.summonRoutes(),
  [
    "getQueueSummon",
    "listSummonControllers",
    "resetQueueSummon (mutation)",
    "summonQueue (mutation)",
  ],
);

/* ------------------------------------------------------------------ */
step("2. GET /queues/:queue/summon: the shared state and the summoner");

const readFrom = Date.now();
const before = await panel.call("GET", "/queues/reports/summon");
const readTo = Date.now();
const status: SummonStatusDto = before.body;
show("GET /queues/reports/summon", status);
checkEqual(
  "local, not inert; nothing pending, no failures, no circuit; the full budget left",
  [
    before.status,
    status.queue,
    status.local,
    status.inert,
    status.pending,
    status.failures,
    status.circuitOpenUntil ?? null,
    status.budget,
  ],
  [
    200,
    "reports",
    true,
    false,
    [],
    0,
    null,
    {
      hour: 0,
      perHour: 30,
      day: 0,
      perDay: 300,
      hourResetsAt: status.budget?.hourResetsAt,
      dayResetsAt: status.budget?.dayResetsAt,
    },
  ],
);
// The budget counts attempts per UTC hour and UTC day; each window's end
// comes with it, epoch ms, so a panel can say when the count starts over.
/** The end of the UTC window of `size` ms holding `at`. */
const windowEnd = (at: number, size: number) =>
  Math.floor(at / size) * size + size;
check(
  "hourResetsAt is the next UTC hour, and dayResetsAt the next UTC midnight",
  [readFrom, readTo].some(
    (at) =>
      status.budget?.hourResetsAt === windowEnd(at, 3_600_000) &&
      status.budget?.dayResetsAt === windowEnd(at, 86_400_000),
  ),
  status.budget,
);
// `readiness` says whether the summoner can be called: a `defineSummoner`
// has no config to wait for, so it is "ready" at once, and that is why
// `capabilities` is there (a provider still validating its config has none
// yet). `providerId` is its instance in this process, `name@version~<n>`:
// defineSummoner's anonymous provider is `custom:<kind>@0.0.0`, and this is
// the first of that kind. The provider routes take it
// ([`provider-routes.ts`](./provider-routes.ts)).
checkEqual(
  "the summoner: defineSummoner's provider and kind, ready, and its facts less the token",
  [
    status.summoner?.provider.name,
    status.summoner?.provider.kind,
    status.summoner?.providerId,
    status.summoner?.readiness,
    status.summoner?.capabilities?.style,
    status.summoner?.facts,
  ],
  [
    "custom:example-record",
    "example-record",
    "custom:example-record@0.0.0~1",
    "ready",
    "launch",
    { kind: "example-record", cluster: "local" },
  ],
);

/* ------------------------------------------------------------------ */
step("3. POST /queues/:queue/summon: summon now, once");

const summoned = await panel.call("POST", "/queues/reports/summon");
const now: SummonCheckDto = summoned.body;
show("POST /queues/reports/summon", now);
checkEqual(
  "a queue with demand: summoned, started, with the demand it decided on",
  [
    summoned.status,
    now.action,
    now.outcome,
    now.demand?.queue,
    now.demand?.demand,
  ],
  [200, "summoned", "started", "reports", 1],
);
checkEqual(
  "the summoner was handed one request: a manual check, one worker, the attempt's id",
  recorded.map((request) => [
    request.queue,
    request.reason,
    request.count,
    request.id,
  ]),
  [["reports", "manual", 1, now.id]],
);

const again: SummonCheckDto = (
  await panel.call("POST", "/queues/reports/summon")
).body;
checkEqual(
  "pressed again while that worker is on its way: skipped, pending — force does not skip it",
  [again.action, again.reason, recorded.length],
  ["skipped", "pending", 1],
);

const pending: SummonStatusDto = (
  await panel.call("GET", "/queues/reports/summon")
).body;
show("pending", pending.pending);
checkEqual(
  "the status lists the attempt in flight, its handles kept back",
  pending.pending.map((attempt) => ({
    id: attempt.id,
    count: attempt.count,
    kind: attempt.kind,
    handles: attempt.handles ?? "(not served)",
    until: attempt.until > attempt.at,
  })),
  [
    {
      id: now.id!,
      count: 1,
      kind: "example-record",
      handles: "(not served)",
      until: true,
    },
  ],
);

/* ------------------------------------------------------------------ */
step(
  "4. A failing summoner: the circuit opens, the status shows it, reset clears it",
);

/** POSTs "summon now" to `flaky` once the 1 ms backoff has certainly passed. */
async function pressFlaky(body?: object): Promise<SummonCheckDto> {
  await Bun.sleep(10);
  return (await panel.call("POST", "/queues/flaky/summon", body)).body;
}
const presses = [await pressFlaky(), await pressFlaky(), await pressFlaky()];
checkEqual(
  "two presses fail; the third, forced as ever, is held back by the open circuit",
  presses.map((press) => press.outcome ?? `${press.action} ${press.reason}`),
  ["failed", "failed", "skipped circuit-open"],
);

const open: SummonStatusDto = (await panel.call("GET", "/queues/flaky/summon"))
  .body;
show("GET /queues/flaky/summon", {
  failures: open.failures,
  circuitOpenUntil: open.circuitOpenUntil,
  last: open.last,
});
check(
  "the status shows two failures, the circuit open for the next minute, and the last outcome",
  open.failures === 2 &&
    open.circuitOpenUntil !== undefined &&
    open.circuitOpenUntil > Date.now() + 30_000 &&
    open.last?.outcome === "failed",
  open,
);

const reset = await panel.call("POST", "/queues/flaky/summon/reset");
const cleared: SummonStatusDto = reset.body;
show("POST /queues/flaky/summon/reset", cleared);
checkEqual(
  "reset answers the status after it: failures 0, no backoff, no circuit, the last outcome kept",
  [
    reset.status,
    cleared.failures,
    cleared.backoffUntil ?? null,
    cleared.circuitOpenUntil ?? null,
    cleared.last?.outcome,
  ],
  [200, 0, null, null, "failed"],
);
checkEqual(
  "only the cooldown is left: force: false keeps it, the default skips it and tries again",
  [
    (({ action, reason }) => `${action} ${reason}`)(
      await pressFlaky({ force: false }),
    ),
    (await pressFlaky()).outcome,
  ],
  ["skipped cooldown", "failed"],
);

const kept: SummonStatusDto = (
  await panel.call("POST", "/queues/reports/summon/reset")
).body;
checkEqual(
  "reset keeps attempts in flight: reports' attempt is still pending",
  kept.pending.map((attempt) => attempt.id),
  [now.id!],
);

/* ------------------------------------------------------------------ */
step("5. A queue with no controller here: 409 SUMMON_NOT_CONFIGURED");

checkEqual(
  "every summon route, for a queue with jobs but no summon policy",
  await Promise.all(
    (
      [
        ["GET", "/queues/plain/summon"],
        ["POST", "/queues/plain/summon"],
        ["POST", "/queues/plain/summon/reset"],
      ] as const
    ).map(async ([method, path]) => {
      const { status, body } = await panel.call(method, path);
      return `${method} ${path}: ${status} ${body.code}`;
    }),
  ),
  [
    "GET /queues/plain/summon: 409 SUMMON_NOT_CONFIGURED",
    "POST /queues/plain/summon: 409 SUMMON_NOT_CONFIGURED",
    "POST /queues/plain/summon/reset: 409 SUMMON_NOT_CONFIGURED",
  ],
);

/* ------------------------------------------------------------------ */
step("6. The queue.summon event on the socket, and the handles switch");

/**
 * Serves an API with a socket, subscribes to `queue` and to one of its job
 * channels, presses "summon now", and answers the `summon` event the socket
 * delivered and the pending attempt the status then lists.
 */
async function summonOverSocket(queue: string, exposeSummonHandles: boolean) {
  const served = mount({
    actions: SUMMON_ACTIONS,
    serialize: { exposeSummonHandles },
  });
  served.api.websocket!.attach(served.adapter);
  const server = await served.adapter.listen(0);
  const client = await connectJobsSocket(
    `ws://127.0.0.1:${server.port}${served.api.websocket!.path}`,
  );
  try {
    await client.next("hello");
    client.send({
      op: "subscribe",
      id: "s1",
      channels: [`queue/${queue}`, `queue/${queue}/job/anything`],
    });
    const ack = await client.next("ack", (frame) => frame.id === "s1");

    const pressed: SummonCheckDto = (
      await served.call("POST", `/queues/${queue}/summon`)
    ).body;
    const frame = await client.next(
      "event",
      (candidate) =>
        candidate.event.type === "summon" && candidate.event.target === queue,
    );
    const status: SummonStatusDto = (
      await served.call("GET", `/queues/${queue}/summon`)
    ).body;
    // Counted after the status round trip, so a second copy had time to come.
    const copies = client
      .all("event")
      .filter((candidate) => candidate.event.type === "summon");
    return {
      ack,
      pressed,
      frame,
      copies: copies.length,
      pending: status.pending,
    };
  } finally {
    client.close();
    await served.api.close();
    await served.adapter.close();
  }
}

const hidden = await summonOverSocket("alerts", false);
show("the event, by default", hidden.frame.event);
checkEqual("both channels accepted", hidden.ack.channels, [
  "queue/alerts",
  "queue/alerts/job/anything",
]);
checkEqual(
  "by default: the attempt's id, outcome, kind, count and reason — no handles",
  hidden.frame.event.payload,
  {
    id: hidden.pressed.id,
    outcome: "started",
    kind: "example-record",
    count: 1,
    reason: "manual",
  },
);
checkEqual(
  "delivered once, on the queue channel alone: never on a job channel",
  [
    hidden.copies,
    hidden.frame.subscriptions,
    hidden.frame.event.kind,
    "id" in hidden.frame.event,
  ],
  [1, ["queue/alerts"], "queue", false],
);
checkEqual(
  "and the status's pending attempt has no handles either",
  hidden.pending.map((attempt) => attempt.handles ?? "(not served)"),
  ["(not served)"],
);

const shown = await summonOverSocket("exports", true);
show("the event, with exposeSummonHandles", shown.frame.event);
checkEqual(
  "with serialize.exposeSummonHandles: the event carries the summoner's handles",
  (shown.frame.event.payload as { handles?: string[] }).handles,
  [`task/${shown.pressed.id}`],
);
checkEqual(
  "and so does the status's pending attempt",
  shown.pending.map((attempt) => attempt.handles),
  [[`task/${shown.pressed.id}`]],
);

/* ------------------------------------------------------------------ */
step("7. GET /summon: every controller in this process, one queues.read each");

const listed = await panel.call("GET", "/summon");
const list: SummonListDto = listed.body;
show("GET /summon", list);
checkEqual(
  "200, one item per controller this process runs, by queue name",
  [listed.status, list.controllers.map((item) => item.queue)],
  [200, ["alerts", "exports", "flaky", "reports"]],
);
checkEqual(
  "each item: the namespace, the summoner's kind, ready, not inert, and the last outcome",
  list.controllers.map((item) => [
    item.namespace,
    item.kind,
    item.readiness,
    item.inert,
    item.last?.outcome,
  ]),
  [
    [jobs.namespace, "example-record", "ready", false, "started"],
    [jobs.namespace, "example-record", "ready", false, "started"],
    [jobs.namespace, "example-down", "ready", false, "failed"],
    [jobs.namespace, "example-record", "ready", false, "started"],
  ],
);
/** How many times each queue's summoner was called so far. */
const callsTo = (queue: string): number =>
  queue === "flaky"
    ? failingCalls
    : recorded.filter((request) => request.queue === queue).length;
checkEqual(
  "and the budget usage: each call counted this hour and today, against the default limits",
  list.controllers.map((item) => [
    item.budget.hour,
    item.budget.day,
    item.budget.perHour,
    item.budget.perDay,
  ]),
  list.controllers.map((item) => [
    callsTo(item.queue),
    callsTo(item.queue),
    30,
    300,
  ]),
);
/** What `GET /queues/:queue/summon` says about the fields a list item carries. */
async function asTheStatusRouteHasIt(queue: string) {
  const one: SummonStatusDto = (
    await panel.call("GET", `/queues/${queue}/summon`)
  ).body;
  return {
    namespace: jobs.namespace,
    queue: one.queue,
    kind: one.summoner?.provider.kind,
    readiness: one.summoner?.readiness,
    inert: one.inert,
    ...(one.last === undefined ? {} : { last: one.last }),
    budget: one.budget,
  };
}
checkEqual(
  "every field as GET /queues/:queue/summon has it",
  list.controllers,
  await Promise.all(
    list.controllers.map(
      async (item) => await asTheStatusRouteHasIt(item.queue),
    ),
  ),
);

// `queues.list` gates the route; each controller is then shown only where
// `authorize` allows `queues.read` on its queue — asked exactly as
// `GET /queues/:queue/summon` asks it, so the list is never looser.
/** Every `authorize` call the guarded API made, in order. */
const asked: JobsApiAuthorizeContext[] = [];
const guarded = mount({
  authorize: (_req, context) => {
    asked.push(context);
    return !(context.action === "queues.read" && context.queue === "flaky");
  },
});
const guardedList: SummonListDto = (await guarded.call("GET", "/summon")).body;
show(
  "what authorize was asked",
  asked.map((context) => ({
    action: context.action,
    queue: context.queue,
    route: context.route,
  })),
);
checkEqual(
  "an authorize refusing queues.read on flaky: flaky is left out of the list",
  guardedList.controllers.map((item) => item.queue),
  ["alerts", "exports", "reports"],
);
checkEqual(
  "asked once for queues.list, then once per controller for queues.read, with the queue and the status route",
  asked.map((context) => ({
    action: context.action,
    transport: context.transport,
    ...(context.queue === undefined ? {} : { queue: context.queue }),
    route: context.route,
  })),
  [
    {
      action: "queues.list",
      transport: "http",
      route: { method: "GET", path: "/summon" },
    },
    ...["alerts", "exports", "flaky", "reports"].map((queue) => ({
      action: "queues.read" as const,
      transport: "http" as const,
      queue,
      route: { method: "GET", path: "/queues/:queue/summon" },
    })),
  ],
);
checkEqual(
  "the same refusal on the status route itself: 403 FORBIDDEN",
  (({ status, body }) => `${status} ${body.code}`)(
    await guarded.call("GET", "/queues/flaky/summon"),
  ),
  "403 FORBIDDEN",
);

asked.length = 0;
const noList = mount({
  authorize: (_req, context) => {
    asked.push(context);
    return context.action !== "queues.list";
  },
});
const refusedList = await noList.call("GET", "/summon");
checkEqual(
  "an authorize refusing queues.list: 403, and no queue is asked about",
  [`${refusedList.status} ${refusedList.body.code}`, asked.length],
  ["403 FORBIDDEN", 1],
);

// A context with no summon policy at all: the list is simply empty, where a
// queue's own route answers 409.
const unsummoned = new BunJobs({
  namespace: exampleNamespace("summon-api-none"),
  driver: crossProcessDriver(),
  logger,
});
await unsummoned.queue("reports").add("render", { id: 2 });
const bare = mount({ jobs: unsummoned });
const emptyList = await bare.call("GET", "/summon");
checkEqual(
  "no controller in the process: GET /summon is 200 with an empty list, never 409 — while the queue's own route is",
  [
    emptyList.status,
    emptyList.body,
    (({ status, body }) => `${status} ${body.code}`)(
      await bare.call("GET", "/queues/reports/summon"),
    ),
  ],
  [200, { controllers: [] }, "409 SUMMON_NOT_CONFIGURED"],
);

// A summoned worker that shares the API's config builds the same controller,
// inert there; its own GET /summon still lists it, saying so.
const SUMMONED_API = new URL("./helpers/summoned-api.ts", import.meta.url)
  .pathname;
const child = Bun.spawn({
  cmd: [process.execPath, SUMMONED_API, "--bun-jobs-summon-id=sm_example"],
  env: {
    ...process.env,
    NAMESPACE: jobs.namespace,
    DRIVER_CONFIG: JSON.stringify(config),
  },
  stdout: "pipe",
  stderr: "inherit",
});
const [childOut, childCode] = await Promise.all([
  new Response(child.stdout).text(),
  child.exited,
]);
const inWorker = JSON.parse(childOut.trim().split("\n").at(-1) ?? "{}") as {
  status: number;
  controllers: SummonListDto["controllers"];
  inert: boolean;
  check: { action: string; reason?: string };
  called: boolean;
};
show("GET /summon in the summoned process", inWorker.controllers);
checkEqual(
  "in a summoned process the controller is inert and summons nothing",
  [childCode, inWorker.inert, inWorker.check, inWorker.called],
  [0, true, { action: "skipped", reason: "inert" }, false],
);
const reportsHere = list.controllers.find((item) => item.queue === "reports");
checkEqual(
  "and GET /summon there still lists it: inert: true, inertReason summoned-process, the queue's shared budget usage",
  [
    inWorker.status,
    inWorker.controllers.map((item) => ({
      queue: item.queue,
      inert: item.inert,
      inertReason: item.inertReason,
      hour: item.budget.hour,
    })),
  ],
  [
    200,
    [
      {
        queue: "reports",
        inert: true,
        inertReason: "summoned-process",
        hour: reportsHere?.budget.hour,
      },
    ],
  ],
);

/* ------------------------------------------------------------------ */
step("8. POST …/summon/reset with { budget: true } clears the budget's usage");

const metas = await Promise.all(
  [plainApi, panel].map(
    async (one) => ((await one.call("GET", "/meta")).body as MetaDto).features,
  ),
);
checkEqual(
  "/meta.features.summonResetBudget and summonList are true, with or without queues.summon: flags ignore permissions",
  metas.map((features) => [features.summonResetBudget, features.summonList]),
  [
    [true, true],
    [true, true],
  ],
);

/** POSTs a reset to `reports` and answers its budget's counts and attempts in flight. */
async function resetReports(body?: SummonResetBody) {
  const answer = await panel.call("POST", "/queues/reports/summon/reset", body);
  const after: SummonStatusDto = answer.body;
  return {
    status: answer.status,
    hour: after.budget?.hour,
    day: after.budget?.day,
    pending: after.pending.length,
  };
}
const used = callsTo("reports");
checkEqual(
  `no body, and { budget: false }: the usage is kept (${used} attempt this hour and today)`,
  [await resetReports(), await resetReports({ budget: false })],
  [
    { status: 200, hour: used, day: used, pending: 1 },
    { status: 200, hour: used, day: used, pending: 1 },
  ],
);
checkEqual(
  "{ budget: true }: the hour's and the day's counts go to 0, in the same write; the attempt in flight is kept",
  await resetReports({ budget: true }),
  { status: 200, hour: 0, day: 0, pending: 1 },
);
const afterReset: SummonListDto = (await panel.call("GET", "/summon")).body;
checkEqual(
  "and GET /summon shows it: reports' usage is 0, the others' untouched",
  afterReset.controllers.map((item) => [item.queue, item.budget.hour]),
  list.controllers.map((item) => [
    item.queue,
    item.queue === "reports" ? 0 : item.budget.hour,
  ]),
);

/* ------------------------------------------------------------------ */
step("Clean up");

for (const { api } of [plainApi, readOnlyApi, panel, guarded, noList, bare]) {
  await api.close();
}
await unsummoned.purge();
await unsummoned.close();
await jobs.purge();
await jobs.close();
summary();
