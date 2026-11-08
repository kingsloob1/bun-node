/**
 * `unauthorized` in a real browser: a signed-out visit lands on the host's
 * sign-in page, signing in brings the user back to the page they asked for,
 * and when the session ends mid-page the app itself sends them to sign in
 * again, from wherever they had got to. Every step is read back from the
 * host (what its `/login` was asked for), not from the page.
 *
 * ```bash
 * bun 06-browser/unauthorized-redirect.ts
 * BUN_CHROME_PATH=/opt/chrome/chrome bun 06-browser/unauthorized-redirect.ts
 * EXAMPLE_BROWSER=0 bun 06-browser/unauthorized-redirect.ts   # skip on purpose
 * ```
 *
 * It drives headless Chrome through `Bun.WebView`, like the other examples in
 * this folder, and **skips** (prints `skipped:` and exits 0) without Chrome.
 *
 * Worth knowing:
 *
 * - **Two redirects, one option.** The shell's `authorize` answers a
 *   signed-out page navigation with `303` to `redirectTo`. Once the app is loaded,
 *   the shell is not asked again, so the app watches its own API calls: the
 *   first one answered 401 (any query or mutation, from any screen) sends the
 *   browser to `redirectTo` with `location.assign`, once.
 * - **`returnTo` is the page the user was on**, in the app's own URL: the
 *   path, query and fragment. Here the user moves to the Workers screen after
 *   the session ended, so that is where signing in brings them back.
 * - **A screen loaded on demand needs its chunk first.** The shell's
 *   `authorize` guards the bundle files too, so a signed-out browser opening
 *   a screen it has not loaded yet fails on the chunk, before any API call,
 *   and a failed dynamic import never says why. So when a screen crashes,
 *   the app asks the server with one `HEAD` of the shell, and redirects if
 *   that answers a listed status. Both paths are shown below.
 * - **`docsUi()` takes the same option.** The two viewers mounted beside the
 *   jobs UI show both of its paths: a guarded viewer's signed-out page is the
 *   shell's 303, and a public viewer whose document needs a session loads,
 *   has its document read refused, and redirects from the browser.
 * - **The sign-in page checks `returnTo`.** It is only ever a relative path
 *   from the UI, but anyone can type a link to `/login?returnTo=…`: the
 *   `/login/submit` handler below follows it only when it starts with one
 *   `/`, and goes to `/` otherwise.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { docsUi } from "@kingsleyweb/bun-api-docs-ui";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-ui/jobs";
import { chromeOrSkip, openView, waitForSelector } from "../shared/browser";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

// Decide whether to skip before printing anything: run-all.ts recognises a
// skip by the output *starting* with `skipped:`.
const chromePath = chromeOrSkip();

title("Signing in, and back, in a browser");

/* --- the host: sessions in a cookie, a sign-in page, the API and the UI */

/** Live sessions. Signing in adds one; "the session ends" deletes it. */
const sessions = new Set<string>();

/** Whether the request carries a live session cookie. */
function signedIn(req: BunRequest): boolean {
  const id = /(?:^|;\s*)session=([^;]+)/.exec(req.get("cookie") ?? "")?.[1];
  return id !== undefined && sessions.has(id);
}

/** A 401 for the signed-out, for both the UI and the API. */
const authorize = (req: BunRequest) =>
  signedIn(req) ? true : ({ allow: false, status: 401 } as const);

const jobs = new BunJobs({
  namespace: "examples-ui-unauthorized-redirect-browser",
  driver: new MemoryDriver(),
  logger: noopLogger,
});
await jobs.queue("mail").add("send-email", { to: "ada@example.com" });

const api = createJobsApi({
  jobs,
  basePath: "/jobs-api",
  authorize,
  logger: noopLogger,
});
/** Every page the UI was asked to serve (not its bundle files); a `HEAD` is marked. */
const shellRequests: string[] = [];
const ui = jobsUi({
  api,
  basePath: "/jobs",
  authorize,
  unauthorized: { redirectTo: "/login" },
  middleware: [
    (req, _res, next) => {
      if (!req.path.startsWith("/jobs/assets/")) {
        shellRequests.push(
          req.method === "GET"
            ? req.originalUrl
            : `${req.method} ${req.originalUrl}`,
        );
      }
      next();
    },
  ],
  logger: noopLogger,
});

const app = new BunHttpAdapter();
/** Every URL the sign-in page was opened at, in order. */
const signInPages: string[] = [];
app.get("/login", (req, res) => {
  signInPages.push(req.originalUrl);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    `<!doctype html><title>Sign in</title><h1 id="sign-in">Sign in</h1>`,
  );
});
// "Signing in": a new session, then back to returnTo if it is a local path.
app.get("/login/submit", (req, res) => {
  const id = crypto.randomUUID();
  sessions.add(id);
  const back = new URL(req.originalUrl, "http://host").searchParams.get(
    "returnTo",
  );
  const safe =
    back !== null && back.startsWith("/") && !/^[/\\]{2}/.test(back)
      ? back
      : "/";
  res.status(303);
  res.setHeader("Set-Cookie", `session=${id}; Path=/; HttpOnly; SameSite=Lax`);
  res.setHeader("Location", safe);
  void res.end();
});
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);

/* --- two docsUi() viewers beside it, with the same option ----------- */

/** A small OpenAPI document for the viewers. */
const openApi = {
  openapi: "3.1.0",
  info: { title: "Internal API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: { operationId: "ping", responses: { 200: { description: "pong" } } },
    },
  },
};
/** Every page the guarded viewer was asked to serve. */
const viewerShellRequests: string[] = [];
// Guarded like the jobs UI: a signed-out page is the shell's 303.
const guardedDocs = docsUi({
  document: () => openApi,
  basePath: "/docs",
  authorize,
  unauthorized: { redirectTo: "/login" },
  middleware: [
    (req, _res, next) => {
      if (!req.path.startsWith("/docs/assets/")) {
        viewerShellRequests.push(req.originalUrl);
      }
      next();
    },
  ],
  logger: noopLogger,
});
// A public page whose document is not: the host serves it only to a session.
// Signed out, the page loads, the document read is refused with 401, and the
// viewer itself sends the browser to sign in.
app.get("/private/openapi.json", (req, res) => {
  if (!signedIn(req)) {
    res.status(401).json({
      type: "urn:example:error:UNAUTHORIZED",
      title: "Authentication required",
      status: 401,
      code: "UNAUTHORIZED",
    });
    return;
  }
  res.json(openApi);
});
const publicDocs = docsUi({
  document: "/private/openapi.json",
  basePath: "/public-docs",
  unauthorized: { redirectTo: "/login" },
  logger: noopLogger,
});
app.use(guardedDocs.basePath, guardedDocs.router);
app.use(publicDocs.basePath, publicDocs.router);
await app.listen(0);
const origin = app.url.replace(/\/$/, "");

/** Winds everything down; safe to call more than once. */
async function shutdown(view?: Bun.WebView): Promise<void> {
  view?.close();
  await app.close();
  await api.close();
  await jobs.close();
}

const pageConsole: string[] = [];
const view = await openView(chromePath, pageConsole, () => shutdown());

try {
  /* ---------------------------------------------------------------- */
  step("A signed-out visit: the server's 303 to the sign-in page");

  await view.navigate(`${origin}/jobs/queues?search=mail`);
  await waitFor("the sign-in page", () => signInPages.length === 1);
  show("the sign-in page was opened at", signInPages[0]);
  checkEqual(
    "/login, carrying the page asked for",
    signInPages[0],
    "/login?returnTo=%2Fjobs%2Fqueues%3Fsearch%3Dmail",
  );
  check(
    "and the browser shows it",
    await view.evaluate<boolean>(waitForSelector("#sign-in")),
  );

  /* ---------------------------------------------------------------- */
  step("Signing in brings the user back to that page");

  await view.navigate(
    `${origin}/login/submit?returnTo=${encodeURIComponent("/jobs/queues?search=mail")}`,
  );
  check(
    "the app loads (data-testid=app-ready)",
    await view.evaluate<boolean>(waitForSelector('[data-testid="app-ready"]')),
  );
  checkEqual(
    "on the page first asked for",
    await view.evaluate<string>("location.pathname + location.search"),
    "/jobs/queues?search=mail",
  );

  /* ---------------------------------------------------------------- */
  step("The session ends; the user opens a screen not loaded yet");

  let seen = shellRequests.length;
  sessions.clear();
  // A client-side navigation to Workers, whose chunk this page has not
  // fetched: the shell's authorize refuses the chunk, the screen crashes, and
  // the app asks the server (a HEAD of the shell) why.
  await view.evaluate(
    `document.querySelector('nav a[href="/jobs/workers"]').click()`,
  );
  await waitFor("the sign-in page, again", () => signInPages.length === 2, {
    timeout: 20_000,
  });
  show("the sign-in page was opened at", signInPages[1]);
  checkEqual(
    "/login, carrying where the user had got to",
    signInPages[1],
    "/login?returnTo=%2Fjobs%2Fworkers",
  );
  checkEqual(
    "sent by the app: its one HEAD of the shell answered 401, and no page was requested",
    shellRequests.slice(seen),
    ["HEAD /jobs"],
  );
  check(
    "and the browser shows the sign-in page",
    await view.evaluate<boolean>(waitForSelector("#sign-in")),
  );

  /* ---------------------------------------------------------------- */
  step("Signed in again; the session ends; an API read is refused");

  await view.navigate(
    `${origin}/login/submit?returnTo=${encodeURIComponent("/jobs/workers")}`,
  );
  check(
    "back on Workers (data-testid=workers-list)",
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="workers-list"]'),
    ),
  );
  // Queues, then back to Workers: both chunks are loaded while signed in.
  await view.evaluate(
    `document.querySelector('nav a[href="/jobs/queues"]').click()`,
  );
  check(
    "Queues loaded too (data-testid=queues-list)",
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="queues-list"]'),
    ),
  );
  seen = shellRequests.length;
  sessions.clear();
  await view.evaluate(
    `document.querySelector('nav a[href="/jobs/workers"]').click()`,
  );
  await waitFor(
    "the sign-in page, a third time",
    () => signInPages.length === 3,
    {
      timeout: 20_000,
    },
  );
  show("the sign-in page was opened at", signInPages[2]);
  checkEqual(
    "/login?returnTo=/jobs/workers again",
    signInPages[2],
    "/login?returnTo=%2Fjobs%2Fworkers",
  );
  checkEqual(
    "this time from the API's 401 alone: no probe, no page requested",
    shellRequests.slice(seen),
    [],
  );
  check(
    "and the browser shows the sign-in page",
    await view.evaluate<boolean>(waitForSelector("#sign-in")),
  );
  checkEqual("and no second redirect followed it", signInPages.length, 3);

  /* ---------------------------------------------------------------- */
  step("docsUi() beside it, same option: a signed-out page is the shell's 303");

  sessions.clear();
  await view.navigate(`${origin}/docs/http/ping`);
  await waitFor(
    "the sign-in page, from the viewer",
    () => signInPages.length === 4,
    {
      timeout: 20_000,
    },
  );
  checkEqual(
    "/login, carrying the viewer's page",
    signInPages[3],
    "/login?returnTo=%2Fdocs%2Fhttp%2Fping",
  );
  checkEqual(
    "the viewer's shell was asked once, and answered with the redirect",
    viewerShellRequests,
    ["/docs/http/ping"],
  );

  /* ---------------------------------------------------------------- */
  step("A public viewer whose document needs a session: the viewer redirects");

  await view.navigate(`${origin}/public-docs/http`);
  await waitFor(
    "the sign-in page, from the viewer's own document read",
    () => signInPages.length === 5,
    { timeout: 20_000 },
  );
  checkEqual(
    "/login, carrying the page the viewer was on",
    signInPages[4],
    "/login?returnTo=%2Fpublic-docs%2Fhttp",
  );
  check(
    "and the browser shows the sign-in page",
    await view.evaluate<boolean>(waitForSelector("#sign-in")),
  );

  // Signed in, the same viewer shows the document.
  await view.navigate(
    `${origin}/login/submit?returnTo=${encodeURIComponent("/public-docs/http")}`,
  );
  check(
    "signed in, the viewer shows the document (data-testid=http-docs)",
    await view.evaluate<boolean>(waitForSelector('[data-testid="http-docs"]')),
  );
  checkEqual("no further redirect", signInPages.length, 5);
} catch (error) {
  console.log(`page console:\n${pageConsole.join("\n")}`);
  throw error;
} finally {
  await shutdown(view);
}

summary();
