/**
 * Deep links to the queue screens — the queue list, one queue, a filtered
 * tab or panel, one job — checked without a socket.
 *
 * ```bash
 * bun 04-screens/deep-links.ts
 * ```
 *
 * The Queues section is routed in the browser, so a link someone pastes or a
 * reload on a queue screen asks the server for a path it has no route for.
 * `jobsUi()` answers every path under its `basePath` with the same HTML shell
 * and the React app reads the screen from the URL. This example requests each
 * screen's URL through `app.fetch()`, the adapter's real pipeline with no port
 * bound, and checks that:
 *
 * - every screen URL gets the shell: `200`, `text/html` and the same config
 *   JSON, so the page boots the same way whichever screen it opens on;
 * - the screen state lives in the query string (`state`, `panel`, `window`,
 *   `offset`, `limit`, `total`, `name`, `search`, `order`), which the server
 *   ignores, so any combination can be bookmarked;
 * - a job id is **one percent-encoded path segment**: `a/b` is
 *   `/jobs/queues/mail/jobs/a%2Fb`, and the UI and the API both accept the
 *   `%2F`;
 * - a request under the API's `basePath` still reaches the API, on the same
 *   host.
 *
 * The screens need the caller's permissions too. `04-screens/permissions.ts`
 * checks those.
 */
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { fetchShell } from "../shared/shell";

title("Deep links to the queue screens, without a socket");

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
step("Every queue screen's URL answers with the shell");

// The routes the app defines under the Queues section:
//
//   /queues                     the queue list
//   /queues/:queue              one queue: header, actions, jobs, panels
//   /queues/:queue/jobs/:id     one job
//
// Each is shown with the query parameters its screen reads.
const SCREEN_URLS = [
  // The queue list. `search` (case-insensitive, by name), `offset` and
  // `limit` page it.
  "/jobs/queues",
  "/jobs/queues?search=MA&offset=20&limit=10",
  // A queue screen, as it opens: the "All" tab and the first panel.
  "/jobs/queues/mail",
  // The Failed tab, with the Workers panel open.
  "/jobs/queues/mail?state=failed&panel=workers",
  // Every filter of the jobs table at once: a state tab, a page, the total
  // counted, two exact names, a search and newest first.
  "/jobs/queues/mail?state=dead&offset=40&limit=20&total=1&name=a,b&search=smtp&order=desc",
  // The throughput panel over the last six hours.
  "/jobs/queues/mail?panel=throughput&window=360",
  // A job whose id holds a `/`: one encoded segment.
  `/jobs/queues/mail/jobs/${encodeURIComponent("a/b")}`,
  // A queue or job that does not exist is still the shell. The app decides,
  // from the API's 404, to show its "Job not found" screen
  // (`data-testid="job-not-found"`).
  "/jobs/queues/nope/jobs/missing",
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
    ],
    [200, "text/html; charset=utf-8", expectedConfig, first.shell.script.src],
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
