/**
 * `unauthorized`: send a signed-out browser to a sign-in page instead of
 * serving it a 401. Checked without a socket; `06-browser/unauthorized-redirect.ts`
 * does the same in Chrome, including the app's own redirect when a session
 * expires mid-page.
 *
 * ```bash
 * bun 02-serving/unauthorized-redirect.ts
 * ```
 *
 * Worth knowing:
 *
 * - **Off by default.** Without `unauthorized`, a denied page is the 401 (or
 *   403) problem it always was, and the app's screens show "Sign in
 *   required". Nothing here changes that unless you set the option.
 * - **Only page navigations are redirected.** A `GET`/`HEAD` with
 *   `Sec-Fetch-Mode: navigate` (or, from a client that sends no
 *   `Sec-Fetch-Mode`, an `Accept` naming `text/html`) gets `303 See Other`.
 *   A bundle file, a script's `fetch` and `curl` keep the problem: a redirect
 *   to an HTML sign-in page would only confuse them.
 * - **401 only, by default.** A 403 means signed in but not allowed, which the
 *   screens explain themselves. Add it with `statuses: [401, 403]`.
 * - **`returnTo` carries the page back.** Its value is the request's path and
 *   query, always a relative URL starting with one `/`. The sign-in page
 *   must still check it before redirecting to it, as the `/login/submit`
 *   handler in `06-browser/unauthorized-redirect.ts` does.
 * - **The target is checked when `jobsUi()` is called.** A path inside the
 *   UI's own `basePath` would loop (the UI would deny it again and redirect
 *   to itself), and `javascript:`, `data:` and `//host` are refused, each with
 *   a `ConfigError`.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import type { JobsUiAuthorize } from "@kingsleyweb/bun-ui/jobs";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  ConfigError,
  createJobsApi,
  MemoryDriver,
} from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-ui/jobs";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { parseShell } from "../shared/shell";

title("Sending a signed-out browser to sign in");

/** The sessions this host has issued. */
const sessions = new Set(["s-ada"]);

/** The session cookie's value, if the request carries a live one. */
function session(req: BunRequest): string | undefined {
  const id = /(?:^|;\s*)session=([^;]+)/.exec(req.get("cookie") ?? "")?.[1];
  return id !== undefined && sessions.has(id) ? id : undefined;
}

/** Signed in or not: 401 when not, so `unauthorized` applies. */
const authorize: JobsUiAuthorize = (req) =>
  session(req) ? true : { allow: false, status: 401 };

const jobs = new BunJobs({
  namespace: "examples-ui-unauthorized-redirect",
  driver: new MemoryDriver(),
  logger: noopLogger,
});
const api = createJobsApi({
  jobs,
  basePath: "/admin/jobs-api",
  authorize: (req) => authorize(req, { asset: false, path: req.path }),
  logger: noopLogger,
});
const ui = jobsUi({
  api,
  basePath: "/admin/jobs",
  authorize,
  unauthorized: { redirectTo: "/login" },
  logger: noopLogger,
});

const app = new BunHttpAdapter();
// The host's own sign-in page, outside the UI's basePath.
app.get("/login", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    `<!doctype html><title>Sign in</title><p>Sign in to ${req.originalUrl}</p>`,
  );
});
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);

/** What a browser sends when the user opens a page. */
const NAVIGATE = {
  "sec-fetch-mode": "navigate",
  accept: "text/html,application/xhtml+xml,*/*;q=0.8",
};

/* ------------------------------------------------------------------ */
step("The resolved option travels to the browser in the page's config");

show("ui.config.unauthorized", ui.config.unauthorized);
checkEqual("the defaults filled in", ui.config.unauthorized, {
  redirectTo: "/login",
  returnParam: "returnTo",
  statuses: [401],
});
const signedIn = await app.fetch("/admin/jobs", {
  headers: { ...NAVIGATE, cookie: "session=s-ada" },
});
checkEqual("a signed-in page loads: 200", signedIn.status, 200);
checkEqual(
  "and its config carries unauthorized, for the app's own redirect",
  parseShell(await signedIn.text()).config.unauthorized,
  ui.config.unauthorized,
);

/* ------------------------------------------------------------------ */
step("A signed-out page navigation: 303 to the sign-in page");

const denied = await app.fetch("/admin/jobs/queues/mail?state=failed", {
  headers: NAVIGATE,
});
show("Location", denied.headers.get("location"));
checkEqual("303 See Other", denied.status, 303);
checkEqual(
  "to /login, with the page in returnTo",
  denied.headers.get("location"),
  "/login?returnTo=%2Fadmin%2Fjobs%2Fqueues%2Fmail%3Fstate%3Dfailed",
);
checkEqual("never cached", denied.headers.get("cache-control"), "no-store");
const loginPage = await app.fetch(denied.headers.get("location")!);
checkEqual("and the host serves its sign-in page there", loginPage.status, 200);
await loginPage.text();

/* ------------------------------------------------------------------ */
step("What keeps its 401: anything that is not a page navigation");

for (const [label, path, headers] of [
  [
    "a script's fetch (Sec-Fetch-Mode: cors)",
    "/admin/jobs",
    { "sec-fetch-mode": "cors" },
  ],
  ["curl (Accept: */*)", "/admin/jobs", { accept: "*/*" }],
  [
    "a bundle file, even on a navigation",
    "/admin/jobs/assets/main.js",
    NAVIGATE,
  ],
] as const) {
  const response = await app.fetch(path, { headers });
  checkEqual(`${label}: 401`, response.status, 401);
  checkEqual(
    `${label}: the problem, not a redirect`,
    [response.headers.get("content-type"), response.headers.get("location")],
    ["application/problem+json", null],
  );
  await response.text();
}
const apiCall = await app.fetch("/admin/jobs-api/queues", {
  headers: NAVIGATE,
});
checkEqual(
  "the API is never redirected: its 401 is the app's to handle",
  apiCall.status,
  401,
);
await apiCall.text();

/* ------------------------------------------------------------------ */
step("A 403 is left to the screens unless statuses lists it");

/** A UI whose authorize says "signed in, but not an operator". */
function forbiddingUi(statuses?: readonly (401 | 403)[]) {
  const forbidding = jobsUi({
    api,
    basePath: "/ops",
    authorize: () => ({ allow: false, status: 403, reason: "Operators only" }),
    unauthorized: { redirectTo: "/login", ...(statuses ? { statuses } : {}) },
    logger: noopLogger,
  });
  return forbidding.router;
}
const by403Default = await forbiddingUi().fetch("/", { headers: NAVIGATE });
checkEqual("default statuses [401]: 403 stays a 403", by403Default.status, 403);
await by403Default.text();
const by403Listed = await forbiddingUi([401, 403]).fetch("/", {
  headers: NAVIGATE,
});
checkEqual("statuses [401, 403]: 303", by403Listed.status, 303);

/* ------------------------------------------------------------------ */
step("returnParam: renamed, or off");

const renamed = jobsUi({
  apiUrl: "/admin/jobs-api",
  basePath: "/reports",
  authorize: () => ({ allow: false, status: 401 }),
  unauthorized: {
    redirectTo: "https://id.example/sign-in?app=jobs",
    returnParam: "next",
  },
  logger: noopLogger,
});
checkEqual(
  "an identity provider's URL, with next=",
  (await renamed.router.fetch("/queues", { headers: NAVIGATE })).headers.get(
    "location",
  ),
  "https://id.example/sign-in?app=jobs&next=%2Fqueues",
);
const plain = jobsUi({
  apiUrl: "/admin/jobs-api",
  basePath: "/reports",
  authorize: () => ({ allow: false, status: 401 }),
  unauthorized: { redirectTo: "/login", returnParam: false },
  logger: noopLogger,
});
checkEqual(
  "returnParam: false: the target as written",
  (await plain.router.fetch("/queues", { headers: NAVIGATE })).headers.get(
    "location",
  ),
  "/login",
);

/* ------------------------------------------------------------------ */
step("Targets jobsUi() refuses");

for (const [label, to, words] of [
  [
    "inside its own basePath: a redirect loop",
    "/admin/jobs/login",
    "redirect loop",
  ],
  ["the same, in another case", "/ADMIN/JOBS", "redirect loop"],
  ["javascript:", "javascript:alert(1)", "must be a path"],
  ["data:", "data:text/html,<p>hi</p>", "must be a path"],
  [
    "//host (another host to a browser)",
    "//id.example/login",
    `may not start with "//"`,
  ],
  ["a relative path", "login", "must be a path"],
] as const) {
  let thrown: unknown;
  try {
    jobsUi({
      api,
      basePath: "/admin/jobs",
      unauthorized: { redirectTo: to },
      logger: noopLogger,
    });
  } catch (error) {
    thrown = error;
  }
  check(
    `${label}: ConfigError naming the problem`,
    thrown instanceof ConfigError && thrown.message.includes(words),
  );
  if (label.endsWith("loop")) {
    show("message", (thrown as Error).message);
  }
}

/* ------------------------------------------------------------------ */
step("Without unauthorized: the 401 problem, as before");

const off = jobsUi({
  api,
  basePath: "/legacy",
  authorize,
  logger: noopLogger,
});
checkEqual("config.unauthorized is null", off.config.unauthorized, null);
const offResponse = await off.router.fetch("/", { headers: NAVIGATE });
checkEqual("a denied navigation is 401", offResponse.status, 401);
checkEqual(
  "with the problem body",
  ((await offResponse.json()) as { code: string }).code,
  "UNAUTHORIZED",
);

await api.close();
await jobs.close();
summary();
