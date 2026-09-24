/**
 * Deep links to the Overview, queue, worker, runner, Events and API docs
 * screens — the Overview over a range, the queue list, one queue, a filtered
 * tab or panel, one job, the worker list, one worker, the runner list, one
 * runner and one run's log, the Events console on a chosen channel, the docs
 * landing page, one HTTP operation and one WebSocket message — checked
 * without a socket.
 *
 * ```bash
 * bun 04-screens/deep-links.ts
 * ```
 *
 * The Overview, Queues, Workers, Runners, Events and API docs sections are
 * routed in the browser, so a link
 * someone pastes or a reload on one of their screens asks the server for a
 * path it has no route for.
 * `jobsUi()` answers every path under its `basePath` with the same HTML shell
 * and the React app reads the screen from the URL. This example requests each
 * screen's URL through `app.fetch()`, the adapter's real pipeline with no port
 * bound, and checks that:
 *
 * - every screen URL gets the shell: `200`, `text/html` and the same config
 *   JSON, so the page boots the same way whichever screen it opens on;
 * - the screen state lives in the query string (`state`, `panel`, `window`,
 *   `offset`, `limit`, `total`, `name`, `search`, `order`; `queue`,
 *   `service`, `host`, `state` and `search` on the worker list; `range` and
 *   the `job`-prefixed list parameters plus `finished` on a worker; `range`,
 *   `rangeScope` and the per-section ranges on the Overview; `search`,
 *   `offset` and `limit` on the runner list, `history` and `logs` on a runner;
 *   `channel` and `types` on `/events`; `q` on both docs references), which
 *   the server ignores, so any combination can be bookmarked;
 * - the shell links exactly one stylesheet and one module script. The queue,
 *   job and runner screens are split chunks the entry imports on demand,
 *   served from the same `assetsPath` with the same immutable caching, and
 *   the entry stylesheet already carries their rules;
 * - a job id is **one percent-encoded path segment**: `a/b` is
 *   `/jobs/queues/mail/jobs/a%2Fb`, and the UI and the API both accept the
 *   `%2F`;
 * - a request under the API's `basePath` still reaches the API, on the same
 *   host: the UI's `/jobs/docs` is the app's own viewer of
 *   `/jobs-api/openapi.json`, while `/jobs-api/docs`, the API's CDN-loaded
 *   viewer, is off unless the API is built with `docs: { ui: true }`.
 *
 * The screens need the caller's permissions too. `04-screens/permissions.ts`
 * checks those.
 */
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { jobsUi, UI_CONFIG_ELEMENT_ID } from "@kingsleyweb/bun-jobs-ui";
import { encodeJobId } from "@kingsleyweb/bun-jobs/api/contract";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { fetchShell } from "../shared/shell";

title(
  "Deep links to the Overview, queue, worker, runner, Events and API docs screens, without a socket",
);

const jobs = new BunJobs({
  namespace: "examples-ui-deep-links",
  driver: new MemoryDriver(),
  logger: noopLogger,
});

// The job ids a URL has to carry. A `/` would split the path in two unless it
// is encoded; so would `?` and `#`, which would start the query or fragment.
const ODD_IDS = ["a/b", "invoice 2026?#1", "café"];
for (const jobId of ODD_IDS) {
  await jobs.queue("mail").add("send-email", { jobId }, { jobId });
}
// A runner, so a runner's URL has something behind it. Registered, never
// started: nothing runs.
jobs.runner({
  id: "nightly",
  file: new URL("../shared/handlers/hold.ts", import.meta.url),
  executionMode: "in-process",
  waitToExit: false,
});

const api = createJobsApi({
  jobs,
  basePath: "/jobs-api",
  authorize: () => true,
  logger: noopLogger,
});
// `basePath` defaults to "/jobs".
const ui = jobsUi({ api, logger: noopLogger });

const app = new BunHttpAdapter();
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);

/* ------------------------------------------------------------------ */
/** The API's OpenAPI document, for an operationId that really exists. */
const openapi = (await (await app.fetch("/jobs-api/openapi.json")).json()) as {
  paths: Record<string, Record<string, { operationId?: string }>>;
};
/** Every documented operationId. */
const operationIds = Object.values(openapi.paths).flatMap((item) =>
  Object.values(item).flatMap((operation) =>
    typeof operation?.operationId === "string" ? [operation.operationId] : [],
  ),
);
check(
  "the API documents getQueue, the operation linked below",
  operationIds.includes("getQueue"),
  operationIds,
);

/* ------------------------------------------------------------------ */
step(
  "Every Overview, queue, worker, runner, Events and docs screen's URL answers with the shell",
);

// The routes the app defines under its sections:
//
//   /queues                     the queue list
//   /queues/:queue              one queue: header, actions, jobs, panels
//   /queues/:queue/jobs/:id     one job
//   /workers                    the worker list
//   /workers/:queue/:key        one worker: instances, settings, analytics, jobs
//   /runners                    the runner list
//   /runners/:runner            one runner: status, actions, stats, history
//   /events                     the Events console
//   /docs                       the API docs landing page
//   /docs/http[/:operationId]   the HTTP reference, or one operation
//   /docs/ws[/:item]            the WebSocket reference, or one item
//
// Each is shown with the query parameters its screen reads.
const SCREEN_URLS = [
  // The queue list. `search` (case-insensitive, by name), `offset` and
  // `limit` page it.
  "/jobs/queues",
  "/jobs/queues?search=MA&offset=20&limit=10",
  // A queue screen, as it opens: the "All" tab and the first panel.
  "/jobs/queues/mail",
  // The Retrying tab (the `failed` state: the label changed, the value did
  // not), with the Workers panel open.
  "/jobs/queues/mail?state=failed&panel=workers",
  // Every filter of the jobs table at once: a state tab, a page, the total
  // counted, two exact names, a search and oldest first. Newest first is the
  // default, so only `order=asc` is ever written into the URL (an
  // `order=desc` in a pasted link still reads as newest first).
  "/jobs/queues/mail?state=dead&offset=40&limit=20&total=1&name=a,b&search=smtp&order=asc",
  "/jobs/queues/mail?state=dead&order=desc",
  // The Job defaults panel: the defaults every job added to the queue
  // starts from, with Settings… and Apply to N pending jobs….
  "/jobs/queues/mail?panel=job-defaults",
  // The throughput panel over the last six hours.
  "/jobs/queues/mail?panel=throughput&window=360",
  // A job whose id holds a `/`: one encoded segment.
  `/jobs/queues/mail/jobs/${encodeURIComponent("a/b")}`,
  // A queue or job that does not exist is still the shell. The app decides,
  // from the API's 404, to show its "Job not found" screen
  // (`data-testid="job-not-found"`).
  "/jobs/queues/nope/jobs/missing",
  // The worker list: every worker, grouped by service, then host:pid.
  // `queue`, `service`, `host` and `state` are sent to the API; `search`
  // filters in the browser.
  "/jobs/workers",
  "/jobs/workers?queue=mail&service=api&state=paused&search=send",
  "/jobs/workers?host=web-1",
  // One worker, by its queue and stable key (`service.queue.name`): its
  // live instances, configuration, throughput and busyness over `range`, and
  // the jobs whose last attempt it ran — by default those finished in the
  // last 24 hours, with the job list's own parameters prefixed `job`.
  "/jobs/workers/mail/api.mail.send",
  "/jobs/workers/mail/api.mail.send?range=3600s",
  "/jobs/workers/mail/api.mail.send?jobState=completed&finished=21600s&jobName=send-email&jobSearch=ada&jobOrder=asc&jobOffset=20&jobLimit=10",
  // A custom `finished` range, as `<from>-<to>` in epoch milliseconds, and
  // an Active tab, which drops the range (an active job has no finishedOn).
  "/jobs/workers/mail/api.mail.send?finished=1758499200000-1758585600000",
  "/jobs/workers/mail/api.mail.send?jobState=active",
  // A key nothing reports: the shell, then the page says so.
  "/jobs/workers/mail/ghost.mail.send",
  // The Overview over the last hour, for the whole page; then with each
  // section on its own range (`rangeScope=section`) — the Jobs, Queues,
  // Runners and Workers sections each reading its own parameter.
  "/jobs/?range=3600s",
  "/jobs/?range=1758499200000-1758585600000",
  "/jobs/?rangeScope=section&jobsRange=300s&queuesRange=3600s&runnersRange=21600s&workersRange=86400s",
  // The runner list, and filtered by id or name. The filter runs in the
  // browser, so nothing is re-fetched as you type.
  "/jobs/runners",
  "/jobs/runners?search=night",
  // Its window. This list is read whole and paged in the browser, but the
  // window is in the URL as `/queues`' is — it is the one pager whose page size
  // comes from the link rather than from a constant in the app — so a link
  // reproduces the page being read. The "Rows per page" select offers the
  // defaults plus whatever `limit` the URL carries, so a size outside them
  // (`limit=10` here) is honoured rather than dropped.
  "/jobs/runners?offset=25&limit=10",
  // A filter and a window together: a link pasted from the second page of a
  // search. Typing in the filter drops `offset` again (the list narrows under
  // the window, so the window goes back to the start) — which is behaviour of
  // the screen, checked in `06-browser/pause-and-retry.ts`.
  "/jobs/runners?search=night&offset=25&limit=10",
  // An offset past the end. The server answers with the shell either way; the
  // screen lands on the last page that has rows rather than on an empty table.
  "/jobs/runners?offset=100000&limit=10",
  // One runner, and with the last 25 runs in its history (sent to the API
  // as `GET /runners/:runner/history?limit=25`).
  "/jobs/runners/nightly",
  "/jobs/runners/nightly?history=25",
  // One run's log open in its history row (`logs` names the run id).
  "/jobs/runners/nightly?logs=00000000-0000-0000-0000-000000000000",
  // A runner nothing knows: the shell, then "Runner not found"
  // (`data-testid="runner-not-found"`) from the API's 404.
  "/jobs/runners/ghost",
  // The Events console (`data-testid="events-screen"`), on its default
  // channel: `all` in mode `both`, else `queues` or `runners`.
  "/jobs/events",
  // One queue's channel, filtered to two types. `channel` is the socket's
  // own channel name; `types` is a comma list of bare event names.
  "/jobs/events?channel=queue/mail&types=completed,failed",
  // A type no channel carries (event names are not prefixed with their
  // kind): the app drops it and shows every type. Still the shell.
  "/jobs/events?channel=queue/mail&types=queue.completed",
  // One runner's channel, and the channel of one job (its id encoded as the
  // socket encodes it, then as a query value).
  "/jobs/events?channel=runner/nightly",
  // Every worker ("Every worker"), and one queue's workers ("One queue's
  // workers"): workers starting, pausing, stopping and changing settings.
  "/jobs/events?channel=workers",
  "/jobs/events?channel=queue/mail/workers",
  `/jobs/events?channel=${encodeURIComponent(`queue/mail/job/${encodeJobId("a/b")}`)}`,
  // The API docs (`data-testid="docs-home"`): an HTTP card, and a WebSocket
  // card because this API has a socket (`meta.docs.asyncapi`).
  "/jobs/docs",
  // The HTTP reference, and one operation by its operationId, with its
  // permission marker and try-it panel.
  "/jobs/docs/http",
  "/jobs/docs/http/getQueue",
  // `q` filters the sidebar; operation links keep it.
  "/jobs/docs/http?q=pause",
  "/jobs/docs/http/getQueue?q=queue",
  // An operationId the document lacks: the shell, then "No such operation".
  "/jobs/docs/http/noSuchOperation",
  // The WebSocket reference: with no item, the connection channel.
  "/jobs/docs/ws",
  // One item by slug: a message (its key holds a `.`), a channel, and the
  // connection's panels.
  "/jobs/docs/ws/message-queue.completed",
  "/jobs/docs/ws/channel-queue",
  "/jobs/docs/ws/operation-subscribe",
  "/jobs/docs/ws/limits",
  "/jobs/docs/ws/close-codes",
  "/jobs/docs/ws/upgrade-refusals",
  "/jobs/docs/ws?q=close",
];

const first = await fetchShell(app, SCREEN_URLS[0]!);
const expectedConfig = JSON.parse(JSON.stringify(ui.config)) as unknown;
show("the config every screen boots with", first.shell.config);

for (const url of SCREEN_URLS) {
  const { response, shell } = await fetchShell(app, url);
  checkEqual(
    `${url} → 200 text/html, the same config and bundle`,
    [
      response.status,
      response.headers.get("content-type"),
      shell.config,
      shell.script.src,
      shell.styles.map((style) => style.href),
    ],
    [
      200,
      "text/html; charset=utf-8",
      expectedConfig,
      first.shell.script.src,
      first.shell.styles.map((style) => style.href),
    ],
  );
}

// Apart from its per-request nonce, the page is byte-for-byte the same for
// every screen: the server knows nothing about which screen was asked for.
const mail = await fetchShell(app, "/jobs/queues/mail?state=failed");
const job = await fetchShell(app, "/jobs/queues/mail/jobs/a%2Fb");
checkEqual(
  "the queue screen's and the job screen's pages differ only in the nonce",
  job.shell.html.replaceAll(job.shell.configNonce, "NONCE"),
  mail.shell.html.replaceAll(mail.shell.configNonce, "NONCE"),
);

/* ------------------------------------------------------------------ */
step("One stylesheet, one entry script; the screens load as chunks");

const { html } = first.shell;
checkEqual(
  "the shell links exactly one stylesheet and one module script",
  [
    [...html.matchAll(/<link rel="stylesheet"/g)].length,
    [...html.matchAll(/<script type="module"/g)].length,
  ],
  [1, 1],
);
const assetsPath = first.shell.config.assetsPath;
check(
  "both live under assetsPath",
  [first.shell.script.src, first.shell.styles[0]!.href].every((href) =>
    href.startsWith(`${assetsPath}/`),
  ),
);

// The entry imports each lazily loaded screen by a relative specifier, which
// the browser resolves against the entry's own URL: under assetsPath.
const entry = await (await app.fetch(first.shell.script.src)).text();
const chunks = [
  ...new Set(
    [...entry.matchAll(/import\(\s*["']\.\/([\w.-]+\.js)["']\s*\)/g)].map(
      (match) => match[1]!,
    ),
  ),
];
show("chunks the entry imports on demand", chunks);
check("the entry imports at least one chunk on demand", chunks.length > 0);
for (const chunk of chunks) {
  const response = await app.fetch(`${assetsPath}/${chunk}`);
  const body = await response.text();
  checkEqual(
    `${assetsPath}/${chunk} → 200 JavaScript, cached for good`,
    [
      response.status,
      response.headers.get("content-type"),
      response.headers.get("cache-control"),
      body.length > 0,
    ],
    [
      200,
      "text/javascript; charset=utf-8",
      "public, max-age=31536000, immutable",
      true,
    ],
  );
}

/* ------------------------------------------------------------------ */
step("A job id is one encoded path segment");

// This is what the app puts in a link to a job, and what it sends the API.
for (const id of ODD_IDS) {
  const segment = encodeURIComponent(id);
  const screen = await app.fetch(`/jobs/queues/mail/jobs/${segment}`);
  await screen.arrayBuffer();
  const read = await app.fetch(`/jobs-api/queues/mail/jobs/${segment}`);
  const body = (await read.json()) as { id?: string };
  checkEqual(
    `${JSON.stringify(id)} → …/jobs/${segment}: the shell, and the API finds the job`,
    [screen.status, read.status, body.id],
    [200, 200, id],
  );
}

// Unencoded, `a/b` is two segments. The UI still answers (every path under
// its basePath is the shell), but the app reads the route as a different
// one, and the API has no such route.
const unencoded = await app.fetch("/jobs-api/queues/mail/jobs/a/b");
await unencoded.arrayBuffer();
checkEqual(
  "unencoded, /jobs-api/queues/mail/jobs/a/b is not the job",
  unencoded.status,
  404,
);

/* ------------------------------------------------------------------ */
step("The API still answers for itself on the same host");

// Two docs, two paths: the UI's viewer under the UI's basePath, and the
// documents under the API's. The API's own HTML viewers load Swagger UI and
// the AsyncAPI viewer from a CDN, so they are opt-in (`docs: { ui: true }`)
// and absent here; the UI's viewer needs no CDN at all.
const docsScreen = await app.fetch("/jobs/docs");
const apiDocsPage = await app.fetch("/jobs-api/docs");
const apiDocsHtml = await apiDocsPage.text();
const document = await app.fetch("/jobs-api/openapi.json");
checkEqual(
  "/jobs/docs is the shell; /jobs-api/docs 404 (docs.ui is off); /jobs-api/openapi.json JSON",
  [
    docsScreen.status,
    (await docsScreen.text()).includes(`id="${UI_CONFIG_ELEMENT_ID}"`),
    apiDocsPage.status,
    apiDocsHtml.includes(`id="${UI_CONFIG_ELEMENT_ID}"`),
    document.status,
    document.headers.get("content-type")?.split(";")[0],
  ],
  [200, true, 404, false, 200, "application/json"],
);
await document.arrayBuffer();

const runnerScreen = await app.fetch("/jobs/runners/nightly");
const runner = await app.fetch("/jobs-api/runners/nightly");
const runnerBody = (await runner.json()) as { id?: string; isLocal?: boolean };
checkEqual(
  "/jobs/runners/nightly is the shell, /jobs-api/runners/nightly the runner",
  [
    runnerScreen.status,
    runnerScreen.headers.get("content-type"),
    runner.status,
    runnerBody.id,
    runnerBody.isLocal,
  ],
  [200, "text/html; charset=utf-8", 200, "nightly", true],
);
await runnerScreen.arrayBuffer();

const queues = await app.fetch("/jobs-api/queues");
const list = (await queues.json()) as { items: { name: string }[] };
checkEqual(
  "/jobs-api/queues → the API's JSON",
  [
    queues.status,
    queues.headers.get("content-type")?.split(";")[0],
    list.items.map((queue) => queue.name),
  ],
  [200, "application/json", ["mail"]],
);

const missing = await app.fetch("/jobs-api/queues/nope");
const problem = (await missing.json()) as { code?: string };
checkEqual(
  "/jobs-api/queues/nope → the API's 404 problem, not the shell",
  [
    missing.status,
    missing.headers.get("content-type")?.split(";")[0],
    problem.code,
  ],
  [404, "application/problem+json", "QUEUE_NOT_FOUND"],
);

// The client's own screen path is not an API path: /jobs/queues is the shell
// and /jobs-api/queues is JSON, from one host and one adapter.
check(
  "and the shell never answers under the API's basePath",
  !(await (await app.fetch("/jobs-api/queues/mail/jobs/missing")).text())
    .toLowerCase()
    .includes("<!doctype html>"),
);

summary();

await api.close();
await jobs.close();
