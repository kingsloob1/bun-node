/**
 * Quick start — the management UI beside the management API, on a real port.
 *
 * ```bash
 * bun 01-quick-start/index.ts            # serve, check, close
 * bun 01-quick-start/index.ts --serve    # and keep serving, to open it in a browser
 * PORT=3000 bun 01-quick-start/index.ts --serve
 * ```
 *
 * `jobsUi()` from `@kingsleyweb/bun-jobs-ui` is a router that serves a React
 * app: one HTML shell for every client route under its `basePath`, and the
 * hashed bundle under `<basePath>/assets/`. It holds no data. Everything the
 * page shows comes from the API that `createJobsApi` builds, through that
 * API's own `authorize`.
 *
 * Worth knowing:
 *
 * - **Mount each router at its own `basePath`**: `app.use(api.basePath,
 *   api.router)` and `app.use(ui.basePath, ui.router)`. The UI's config and
 *   every asset URL are built from `ui.basePath`, so the two must agree.
 * - **Only the Overview screen is real in 0.1.0.** Queues, Runners, Events and
 *   API docs are placeholders.
 * - **Inside this repo there is no `dist/`**, so the first request bundles the
 *   app in memory (a one-time cost, logged once). A published package ships a
 *   prebuilt `dist/` and never builds.
 * - **Pass `--serve` and open the printed URL in a browser.** The Overview
 *   polls the API every 5 s, so the counts move as the workers below finish
 *   jobs. Stop it with Ctrl+C.
 */
import process from "node:process";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { parseShell } from "../shared/shell";

/** Keep serving after the checks, for a browser. */
const serve = process.argv.includes("--serve");

title("Quick start: the jobs UI beside the jobs API");

/* ------------------------------------------------------------------ */
step("A jobs context with some work in it");

const jobs = new BunJobs({
  namespace: "examples-ui-quick-start",
  driver: new MemoryDriver(),
  // Live events for the API's socket.
  publishEvents: true,
});

// One handler per job name. A job takes a second, so the Overview has
// something to show changing while it polls.
jobs.define<{ to: string }, { sent: string }>("send-email", async (job) => {
  await Bun.sleep(1000);
  return { sent: job.data.to };
});
await jobs.start({ concurrency: 1 });

for (const to of ["ada@example.com", "grace@example.com", "alan@example.com"]) {
  await jobs.now("send-email", { to });
}
// A queue nobody consumes, so something stays waiting.
await jobs.queue("reports").add("nightly", { day: "monday" });

/* ------------------------------------------------------------------ */
step("The API, then the UI pointed at it");

const api = createJobsApi({
  jobs,
  basePath: "/jobs-api",
  // A real deployment decides from a session or a token. The UI's own
  // `authorize` (not used here) only guards the page and the bundle — the
  // data is always this function's decision.
  authorize: () => true,
});

// `api` is the whole connection: the UI reads the API's basePath, its socket
// path and its docs paths from it. `basePath` defaults to "/jobs".
const ui = jobsUi({ api });

const app = new BunHttpAdapter();
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);
// The live-events socket needs registering on the adapter's BunWebSocket.
api.websocket?.attach(app);

show("ui.basePath", ui.basePath);
show("ui.config", ui.config);

/* ------------------------------------------------------------------ */
step("Serving on a port");

await app.listen(Number(process.env.PORT ?? 0));
show("open the UI at", `${app.url}${ui.basePath}`);

// The first page request may bundle the app in memory; later ones are cheap.
let started = performance.now();
const page = await fetch(`${app.url}${ui.basePath}`);
const html = await page.text();
show(
  `GET ${ui.basePath} → ${page.status} in ${(performance.now() - started).toFixed(0)}ms`,
);
checkEqual(
  "the shell is HTML",
  page.headers.get("content-type"),
  "text/html; charset=utf-8",
);

const shell = parseShell(html);
checkEqual(
  "the page is told where the API is",
  shell.config.apiBase,
  api.basePath,
);
checkEqual(
  "and where the socket is",
  shell.config.websocket?.path,
  api.websocket?.path,
);
check("the page has a mount point", html.includes('<div id="root"></div>'));

started = performance.now();
const bundle = await fetch(`${app.url}${shell.script.src}`);
await bundle.arrayBuffer();
show(
  `GET ${shell.script.src} → ${bundle.status} in ${(performance.now() - started).toFixed(0)}ms`,
);
checkEqual("the bundle is served", bundle.status, 200);

// A deep link — what a browser sends after a reload on a client route — is
// the same shell: the React router picks the screen from the URL.
const deep = await fetch(`${app.url}${ui.basePath}/queues/mail`);
checkEqual(
  "a deep link is the shell too",
  (await deep.text()).includes(shell.script.src),
  true,
);

// The data comes from the API, beside it.
const queues = await fetch(`${app.url}${api.basePath}/queues`);
show(`GET ${api.basePath}/queues → ${queues.status}`, await queues.json());

summary();

if (serve) {
  show("serving until Ctrl+C", `${app.url}${ui.basePath}`);
  process.once("SIGINT", async () => {
    await app.close();
    await api.close();
    await jobs.close();
    process.exit();
  });
} else {
  await app.close();
  await api.close();
  await jobs.close();
}
