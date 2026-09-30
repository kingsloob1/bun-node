/**
 * Summoning over HTTP: a queue's summon status, "summon now" and reset, from
 * the management API, and the `queue.summon` event on its socket.
 *
 * ```bash
 * bun 11-management-api/summon-routes.ts
 * ```
 *
 * `GET /queues/:queue/summon` (`queues.read`) answers the queue's summon
 * status; `POST /queues/:queue/summon` runs one check at once, as
 * `check({ reason: "manual", force })`; `POST /queues/:queue/summon/reset`
 * clears failures, backoff and an open circuit, and answers the status after
 * it. The summoners here start nothing — one records what it was asked and
 * hands back a platform identifier, one fails every call — so the tour needs
 * no child process. Summoning needs a backend another process can reach, so
 * on the memory driver this runs on a temporary SQLite file.
 *
 * The points that are easy to get wrong:
 *
 * - **The two writes are opt-in.** `queues.summon` is off unless `actions`
 *   names it, and `readOnly` removes it even then: it can spend money. The
 *   status is a plain read, served by default.
 * - **`force` skips the cooldown and nothing else.** An attempt already on
 *   its way, an open circuit, the budget and live workers still hold "summon
 *   now" back, answered `skipped` with the guard's `reason`.
 * - **Reset clears guards, not the record.** Failures go to 0, the backoff
 *   and the circuit are cleared; attempts in flight and the last outcome stay.
 * - **The API never builds a controller.** It finds the one the `jobs` it was
 *   given runs; a queue without one is 409 `SUMMON_NOT_CONFIGURED`, on every
 *   route.
 * - **Platform handles stay home by default.** A pending attempt's `handles`
 *   in the status, and the `queue.summon` event's, go out only with
 *   `serialize.exposeSummonHandles` (a task ARN carries an AWS account id).
 *   The event is about compute, not a job: it reaches `queue/{q}`, never a
 *   job channel.
 */
import type {
  JobsApiAction,
  JobsApiConfig,
  SummonCheckDto,
  SummonRequest,
  SummonStatusDto,
} from "@kingsleyweb/bun-jobs";
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

/** A summoner whose platform is down: every call throws. */
const failing = defineSummoner({
  kind: "example-down",
  invoke: async () => {
    throw new Error("the platform is down");
  },
});

// The controllers log each failed call as an error; collected, not printed.
const { logger } = createTestLogger();

const jobs = new BunJobs({
  namespace: exampleNamespace("summon-api"),
  driver: crossProcessDriver(),
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

  /** The summon routes this API registered, by operation id. */
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
  "the default API registers the status route alone",
  plainApi.summonRoutes(),
  ["getQueueSummon"],
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
  "readOnly removes the two writes even when actions names queues.summon, and keeps the read",
  [
    readOnlyApi.summonRoutes(),
    (await readOnlyApi.call("GET", "/queues/reports/summon")).status,
    (await readOnlyApi.call("POST", "/queues/reports/summon")).status,
    recorded.length,
  ],
  [["getQueueSummon"], 200, 404, 0],
);

const panel = mount({ actions: SUMMON_ACTIONS });
checkEqual(
  "opted in: status, summon now and reset, the two writes marked as mutations",
  panel.summonRoutes(),
  ["getQueueSummon", "resetQueueSummon (mutation)", "summonQueue (mutation)"],
);

/* ------------------------------------------------------------------ */
step("2. GET /queues/:queue/summon: the shared state and the summoner");

const before = await panel.call("GET", "/queues/reports/summon");
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
    { hour: 0, perHour: 30, day: 0, perDay: 300 },
  ],
);
checkEqual(
  "the summoner: defineSummoner's provider and kind, and its facts less the token",
  [
    status.summoner?.provider.name,
    status.summoner?.provider.kind,
    status.summoner?.capabilities?.style,
    status.summoner?.facts,
  ],
  [
    "custom:example-record",
    "example-record",
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
step("Clean up");

for (const { api } of [plainApi, readOnlyApi, panel]) {
  await api.close();
}
await jobs.purge();
await jobs.close();
summary();
