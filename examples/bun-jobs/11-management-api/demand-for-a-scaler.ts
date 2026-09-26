/**
 * The depth endpoint: a queue's demand over HTTP, for a scaler — as JSON, or
 * as the Prometheus text a scraper reads.
 *
 * ```bash
 * bun 11-management-api/demand-for-a-scaler.ts
 * ```
 *
 * `GET /queues/:queue/demand` (`queues.read`) answers one queue's
 * `getDemand()` with its name added; `GET /demand` (`queues.list`) answers
 * every queue the caller may see, or those named in `?queues=`. Either serves
 * the Prometheus exposition for `?format=prometheus` or an `Accept` preferring
 * `text/plain`. The API here is what a scaler would be given and nothing
 * more: `readOnly`, the two queue reads, a token of its own.
 *
 * The points that are easy to get wrong:
 *
 * - **What a caller may not see is left out, not refused.** Under
 *   `listQueues: "authorized"`, `GET /demand` lists only the queues
 *   `authorize` allows `queues.read` on, and a name in `?queues=` the caller
 *   cannot see, or that does not exist, is dropped. Asked for directly, the
 *   same queue is a 403, and a queue that does not exist a 404.
 * - **`?queues=` keeps its order**, so a scaler can read its answer by
 *   position.
 * - **A paused queue demands nothing** but still reports what is waiting,
 *   and in Prometheus `bunjobs_queue_paused` is 1.
 * - **No cap is taken over HTTP.** Each figure is counted to 10,000;
 *   `capped` (and `bunjobs_queue_demand_capped`) says when one went past.
 */
import type { QueueDemandDto } from "@kingsleyweb/bun-jobs";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("The depth endpoint: demand for a scaler");

/* ------------------------------------------------------------------ */
step("Three queues: a backlog, a paused one, and one the scaler may not see");

const namespace = exampleNamespace("scaler");
const jobs = new BunJobs({ namespace, driver: exampleDriver() });

const emails = jobs.queue("emails");
for (const to of ["ada", "grace", "edsger"]) {
  await emails.add("send", { to });
}
const reminder = await emails.add("remind", { to: "alan" }, { delay: 150 });
// Nothing runs these queues, so the reminder is counted where it stands once
// its time has come, never promoted.
await Bun.sleep(reminder.runAt - Date.now() + 50);

const reports = jobs.queue("reports");
await reports.add("render", { id: 1 });
await reports.add("render", { id: 2 });
await reports.pause();

const payroll = jobs.queue("payroll");
await payroll.add("run", { month: "2026-09" });

/* ------------------------------------------------------------------ */
step("An API for the scaler: read-only, two actions, its own token");

/** The one token this API accepts. */
const SCALER_TOKEN = "scaler-token";

const api = createJobsApi({
  jobs,
  basePath: "/scale",
  readOnly: true,
  actions: ["queues.read", "queues.list"],
  // `GET /demand` lists only what `authorize` allows `queues.read` on.
  listQueues: "authorized",
  authorize: (req, context) => {
    if (req.getHeader("authorization") !== `Bearer ${SCALER_TOKEN}`) {
      return { allow: false, status: 401, reason: "Sign in to continue" };
    }
    // Payroll's depth is none of the scaler's business.
    return context.queue === "payroll"
      ? { allow: false, status: 403, reason: "Not this queue" }
      : true;
  },
});
const adapter = new BunHttpAdapter();
adapter.use(api.basePath, api.router);

check(
  "both demand routes are served, read-only as they are",
  ["getQueueDemand", "listQueueDemand"].every((id) =>
    api.routes.some((route) => route.operationId === id && !route.mutation),
  ),
  api.routes.map((route) => route.operationId),
);

/** A GET against the API, with the scaler's token unless told otherwise. */
async function get(
  path: string,
  headers: Record<string, string> = {
    authorization: `Bearer ${SCALER_TOKEN}`,
  },
) {
  const response = await adapter.fetch(`${api.basePath}${path}`, { headers });
  const text = await response.text();
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    text,
    json: () => JSON.parse(text) as any,
  };
}

/** A demand answer without `at`, the instant it was read, for comparing. */
function figures(demand: QueueDemandDto): Omit<QueueDemandDto, "at"> {
  const { at: _at, ...rest } = demand;
  return rest;
}

/* ------------------------------------------------------------------ */
step("One queue's demand, as JSON");

checkEqual(
  "without the token: 401, before any handler runs",
  (await get("/demand", {})).status,
  401,
);

const emailsDemand = await get("/queues/emails/demand");
show("GET /queues/emails/demand", emailsDemand.json());
checkEqual(
  "emails: 3 waiting and the reminder due, no worker, nothing active",
  figures(emailsDemand.json()),
  {
    queue: "emails",
    paused: false,
    waiting: 3,
    dueNow: 1,
    stalled: 0,
    active: 0,
    workers: 0,
    nextDueAt: null,
    demand: 4,
    outstanding: 4,
    capped: false,
    exact: true,
  },
);
checkEqual(
  "the same figures as getDemand() on the queue itself",
  figures(emailsDemand.json()),
  figures({ ...(await emails.getDemand()), queue: "emails" }),
);
checkEqual(
  "reports is paused: demand and outstanding 0, its two jobs still counted",
  (({ paused, waiting, demand, outstanding }) => ({
    paused,
    waiting,
    demand,
    outstanding,
  }))((await get("/queues/reports/demand")).json()),
  { paused: true, waiting: 2, demand: 0, outstanding: 0 },
);
checkEqual(
  "payroll, asked for by name: 403, as authorize said",
  (await get("/queues/payroll/demand")).status,
  403,
);
const unknown = await get("/queues/nowhere/demand");
checkEqual(
  "a queue that does not exist: 404 QUEUE_NOT_FOUND",
  [unknown.status, unknown.json().code],
  [404, "QUEUE_NOT_FOUND"],
);
checkEqual(
  "?cap= is not taken: three waiting under ?cap=1 still reads 3, uncapped",
  (({ waiting, capped }) => ({ waiting, capped }))(
    (await get("/queues/emails/demand?cap=1")).json(),
  ),
  { waiting: 3, capped: false },
);

/* ------------------------------------------------------------------ */
step("Every queue at once: GET /demand");

const all = (await get("/demand")).json();
checkEqual(
  "every queue the scaler may see: payroll is left out, and nothing was cut",
  [all.queues.map((one: QueueDemandDto) => one.queue).sort(), all.truncated],
  [["emails", "reports"], false],
);
checkEqual(
  "?queues= keeps its order, and drops the hidden and the unknown without an error",
  (await get("/demand?queues=reports,payroll,emails,nowhere"))
    .json()
    .queues.map((one: QueueDemandDto) => [one.queue, one.demand]),
  [
    ["reports", 0],
    ["emails", 4],
  ],
);
checkEqual(
  "a name repeated in ?queues= is answered once",
  (await get("/demand?queues=emails,emails,emails"))
    .json()
    .queues.map((one: QueueDemandDto) => one.queue),
  ["emails"],
);

/* ------------------------------------------------------------------ */
step("The same figures as Prometheus text");

const scrape = await get("/demand?format=prometheus");
show("GET /demand?format=prometheus", `\n${scrape.text}`);
checkEqual(
  "the text exposition's content type",
  [scrape.status, scrape.type],
  [200, "text/plain; version=0.0.4; charset=utf-8"],
);

/**
 * Every sample, `name{queue}` → value (`name{}` for the namespace's own
 * family, labelled with `ns` alone), the families in the order declared, and
 * their types.
 */
function parse(text: string) {
  const samples: Record<string, number> = {};
  const families: string[] = [];
  const types: Record<string, string> = {};
  const namespaces = new Set<string>();
  for (const line of text.split("\n")) {
    const type = /^# TYPE (\S+) (\S+)$/.exec(line);
    if (type) {
      families.push(type[1]!);
      types[type[1]!] = type[2]!;
      continue;
    }
    const sample = /^(\w+)\{ns="([^"]*)"(?:,queue="([^"]*)")?\} (\S+)$/.exec(
      line,
    );
    if (sample) {
      namespaces.add(sample[2]!);
      samples[`${sample[1]}{${sample[3] ?? ""}}`] = Number(sample[4]);
    }
  }
  return { samples, families, types, namespaces: [...namespaces] };
}
const scraped = parse(scrape.text);
checkEqual(
  "eleven gauge families: ten per queue, then the namespace's own truncated flag; every sample labelled with this namespace",
  [
    scraped.families,
    Object.values(scraped.types).every((type) => type === "gauge"),
    scraped.namespaces,
  ],
  [
    [
      "bunjobs_queue_demand",
      "bunjobs_queue_outstanding",
      "bunjobs_queue_waiting",
      "bunjobs_queue_due",
      "bunjobs_queue_stalled",
      "bunjobs_queue_active",
      "bunjobs_queue_workers",
      "bunjobs_queue_paused",
      "bunjobs_queue_demand_capped",
      "bunjobs_queue_demand_exact",
      "bunjobs_demand_truncated",
    ],
    true,
    [namespace],
  ],
);
checkEqual(
  "the figures, per queue: emails' backlog (exact), reports paused at 0, nothing truncated, and no payroll at all",
  [
    scraped.samples["bunjobs_queue_demand{emails}"],
    scraped.samples["bunjobs_queue_waiting{emails}"],
    scraped.samples["bunjobs_queue_due{emails}"],
    scraped.samples["bunjobs_queue_paused{emails}"],
    scraped.samples["bunjobs_queue_demand{reports}"],
    scraped.samples["bunjobs_queue_waiting{reports}"],
    scraped.samples["bunjobs_queue_paused{reports}"],
    scraped.samples["bunjobs_queue_demand_exact{emails}"],
    scraped.samples["bunjobs_demand_truncated{}"],
    Object.keys(scraped.samples).some((key) => key.endsWith("{payroll}")),
  ],
  [4, 3, 1, 0, 0, 2, 1, 1, 0, false],
);
const negotiated = await get("/queues/emails/demand", {
  authorization: `Bearer ${SCALER_TOKEN}`,
  // What a Prometheus server sends when it scrapes.
  accept: "text/plain;version=0.0.4;q=1,*/*;q=0.1",
});
checkEqual(
  "an Accept preferring text/plain gets the same text, no ?format needed",
  [
    negotiated.type,
    parse(negotiated.text).samples["bunjobs_queue_demand{emails}"],
  ],
  ["text/plain; version=0.0.4; charset=utf-8", 4],
);

/* ------------------------------------------------------------------ */
step("Clean up");

await api.close();
await jobs.purge();
await jobs.close();
summary();
