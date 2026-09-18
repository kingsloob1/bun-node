/**
 * Option tour — every `jobsUi()` option, and every rule it enforces, asserted.
 *
 * ```bash
 * bun 10-options/jobs-ui-options.ts
 * ```
 *
 * The other examples *show* the UI; this one *checks* it. Each section sets
 * one option and asserts what changes — in `ui.config`, in the served page or
 * in the answer to a request — and every value `jobsUi()` refuses is tried and
 * must throw a `ConfigError` (code `CONFIG`) at the call, not on the first
 * request. A failed check prints what was expected and fails the script.
 *
 * Worth knowing:
 *
 * - **Exactly one of `api` and `apiUrl`.** `api` is a `createJobsApi` result
 *   in this process: the UI reads the API's basePath, socket and docs paths
 *   from it. `apiUrl` is where the browser finds an API it cannot see: the app
 *   then discovers the socket and docs from the API's `/meta` at runtime, so
 *   `config.websocket` and `config.docs` are `null`.
 * - **`authorize` guards the page and the bundle only.** The data is guarded
 *   by the API's own `authorize`, always. An unrecognised answer is a 403 and
 *   a throw is a 500: it fails closed.
 * - **`dev` and `logger` come first below**, because the in-memory build of
 *   the app happens once per process and is logged once — by the first UI
 *   that needs it.
 */
import type {
  RouterErrorMiddlewareHandler,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import type {
  JobsUiAuthorize,
  JobsUiAuthorizeContext,
  JobsUiOptions,
} from "@kingsleyweb/bun-jobs-ui";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BunHttpAdapter,
  createTestLogger,
  noopLogger,
} from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import {
  ASSET_CACHE_CONTROL,
  DEFAULT_BASE_PATH,
  DEFAULT_TITLE,
  jobsUi,
  UI_CONFIG_ELEMENT_ID,
} from "@kingsleyweb/bun-jobs-ui";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { cspDirectives, fetchShell } from "../shared/shell";

title("Option tour: jobsUi()");

/** A `ConfigError`, as every refused option throws it. */
const CONFIG = { name: "ConfigError", code: "CONFIG" } as const;

const jobs = new BunJobs({
  namespace: "examples-ui-options",
  driver: new MemoryDriver(),
  publishEvents: true,
  logger: noopLogger,
});

/** The API most sections point the UI at: basePath `/jobs-api`, a socket, docs. */
const api = createJobsApi({
  jobs,
  basePath: "/jobs-api",
  authorize: () => true,
  logger: noopLogger,
});

/** Every API this tour creates, closed at the end. */
const apis = [api];

/** Builds a UI with a silent logger unless one is given. */
function ui(options: JobsUiOptions) {
  return jobsUi({ logger: noopLogger, ...options });
}

/** An adapter with `api` and the UI mounted, each at its own basePath. */
function mount(options: JobsUiOptions) {
  const built = ui(options);
  const app = new BunHttpAdapter();
  app.use(api.basePath, api.router);
  app.use(built.basePath, built.router);
  return { ui: built, app };
}

/** Fetches a path and answers with the status, the content type and the parsed problem, if any. */
async function answer(
  app: { fetch: (path: string, init?: RequestInit) => Promise<Response> },
  path: string,
  init?: RequestInit,
) {
  const response = await app.fetch(path, init);
  const type = response.headers.get("content-type");
  const text = await response.text();
  return {
    status: response.status,
    type,
    code:
      type === "application/problem+json" && text !== ""
        ? (JSON.parse(text) as { code: string }).code
        : undefined,
    detail:
      type === "application/problem+json" && text !== ""
        ? (JSON.parse(text) as { detail: string }).detail
        : undefined,
    text,
  };
}

/* ================================================================== */
step("The exported constants");

checkEqual("DEFAULT_BASE_PATH", DEFAULT_BASE_PATH, "/jobs");
checkEqual("DEFAULT_TITLE", DEFAULT_TITLE, "Jobs");
checkEqual(
  "ASSET_CACHE_CONTROL",
  ASSET_CACHE_CONTROL,
  "public, max-age=31536000, immutable",
);
checkEqual("UI_CONFIG_ELEMENT_ID", UI_CONFIG_ELEMENT_ID, "bun-jobs-ui-config");

/* ================================================================== */
step("logger — anything resolveLogger accepts; hears the one-time build");

// Where the package lives, to tell whether a prebuilt dist/ is there.
const packageDir = join(
  dirname(fileURLToPath(import.meta.resolve("@kingsleyweb/bun-jobs-ui"))),
  "..",
);
const hasDist = existsSync(join(packageDir, "dist", "manifest.json"));
show("prebuilt dist/ present", hasDist);

const first = createTestLogger();
const logged = ui({ api, logger: first.logger });
await (await logged.router.fetch("/")).text();

const buildNotices = first.events.filter((event) =>
  event.message.includes("bundling the app in memory"),
);
if (hasDist) {
  checkEqual("with dist/, nothing is built or logged", buildNotices.length, 0);
} else {
  checkEqual(
    "without dist/, one info line says the app is being built",
    buildNotices.map((event) => event.level),
    ["info"],
  );
  checkEqual(
    "under the child binding component: jobs-ui",
    buildNotices[0]?.bindings.component,
    "jobs-ui",
  );
}

// The build is per process: a second UI reuses it and says nothing.
const second = createTestLogger();
await (await ui({ api, logger: second.logger }).router.fetch("/")).text();
checkEqual("a second UI builds nothing and logs nothing", second.events, []);

// A bare function is a LoggerLike too: a sink receiving each LogEvent.
const sunk: string[] = [];
const throwing = ui({
  api,
  logger: (event) => sunk.push(`${event.level}: ${event.message}`),
  authorize: () => {
    throw new Error("session store down");
  },
});
await (await throwing.router.fetch("/")).text();
checkEqual("a sink function receives the UI's errors", sunk, [
  "error: jobs ui authorize threw; refusing the request",
]);

/* ================================================================== */
step("dev — where the bundle comes from");

if (hasDist) {
  show("skipping the dev: false refusal: this install has a dist/");
} else {
  await checkRejects(
    "dev: false without dist/ throws at jobsUi(), not at the first request",
    () => ui({ api, dev: false }),
    { ...CONFIG, message: /no build found.*dev: false/ },
  );
}

const devUi = ui({ api, dev: true });
const devShell = await fetchShell(devUi.router, "/");
checkEqual(
  "dev: true builds in memory and serves",
  devShell.response.status,
  200,
);
const devAsset = await devUi.router.fetch(
  devShell.shell.script.src.slice(devUi.basePath.length),
);
checkEqual(
  "and its bundle",
  [devAsset.status, devAsset.headers.get("content-type")],
  [200, "text/javascript; charset=utf-8"],
);
await devAsset.arrayBuffer();

await checkRejects(
  "dev must be a boolean",
  () => ui({ api, dev: "yes" as unknown as boolean }),
  CONFIG,
);

/* ================================================================== */
step("api or apiUrl — exactly one");

await checkRejects("neither", () => jobsUi({} as JobsUiOptions), {
  ...CONFIG,
  message: /needs api .* or apiUrl/,
});
await checkRejects(
  "both",
  () => jobsUi({ api, apiUrl: "/jobs-api" } as unknown as JobsUiOptions),
  { ...CONFIG, message: /not both/ },
);
await checkRejects(
  "api that is not a createJobsApi result",
  () => jobsUi({ api: { basePath: "/x" } } as unknown as JobsUiOptions),
  { ...CONFIG, message: /createJobsApi/ },
);

/* ================================================================== */
step("api — read the API's basePath, socket and docs");

const fromApi = ui({ api });
checkEqual(
  "config.apiBase is api.basePath",
  fromApi.config.apiBase,
  "/jobs-api",
);
checkEqual("config.websocket from api.websocket", fromApi.config.websocket, {
  path: "/jobs-api/ws",
  port: null,
});
checkEqual("config.docs from the API's routes", fromApi.config.docs, {
  openapi: "/jobs-api/openapi.json",
  asyncapi: "/jobs-api/asyncapi.json",
});

// An API with a dedicated socket port: the page is told the bound port.
const dedicated = createJobsApi({
  jobs,
  basePath: "/ops-api",
  authorize: () => true,
  websocket: { port: 0, path: "/events" },
  docs: { openapiPath: "/spec.json", asyncapiPath: "/events-spec.json" },
  logger: noopLogger,
});
apis.push(dedicated);
const dedicatedUi = ui({ api: dedicated, basePath: "/ops" });
check(
  "a dedicated socket: its path and bound port",
  dedicatedUi.config.websocket?.path === "/ops-api/events" &&
    typeof dedicatedUi.config.websocket.port === "number" &&
    dedicatedUi.config.websocket.port === dedicated.websocket?.port &&
    dedicatedUi.config.websocket.port > 0,
  dedicatedUi.config.websocket,
);
checkEqual("custom docs paths", dedicatedUi.config.docs, {
  openapi: "/ops-api/spec.json",
  asyncapi: "/ops-api/events-spec.json",
});

// An API with neither socket nor docs.
const bare = createJobsApi({
  jobs,
  basePath: "/bare-api",
  authorize: () => true,
  websocket: false,
  docs: false,
  logger: noopLogger,
});
apis.push(bare);
const bareUi = ui({ api: bare, basePath: "/bare" });
checkEqual(
  "websocket: false → config.websocket null",
  bareUi.config.websocket,
  null,
);
checkEqual("docs: false → config.docs null", bareUi.config.docs, null);

/* ================================================================== */
step("apiUrl — a same-origin path or an http(s) URL");

const samePath = ui({ apiUrl: "/jobs-api/" });
checkEqual(
  "a path: trailing slash dropped",
  samePath.config.apiBase,
  "/jobs-api",
);
checkEqual("no socket known → null", samePath.config.websocket, null);
checkEqual("no docs known → null", samePath.config.docs, null);
const samePathCsp = cspDirectives(
  (await samePath.router.fetch("/")).headers.get("content-security-policy"),
);
checkEqual("a path adds nothing to connect-src", samePathCsp["connect-src"], [
  "'self'",
  "ws:",
  "wss:",
]);

const remote = ui({ apiUrl: "https://ops.example.com:8443/jobs-api/" });
checkEqual(
  "a URL: origin and path, trailing slash dropped",
  remote.config.apiBase,
  "https://ops.example.com:8443/jobs-api",
);
checkEqual(
  "a URL: no socket or docs",
  [remote.config.websocket, remote.config.docs],
  [null, null],
);
const remoteCsp = cspDirectives(
  (await remote.router.fetch("/")).headers.get("content-security-policy"),
);
checkEqual("a URL's origin joins connect-src", remoteCsp["connect-src"], [
  "'self'",
  "ws:",
  "wss:",
  "https://ops.example.com:8443",
]);
checkEqual(
  "an origin alone is fine",
  ui({ apiUrl: "http://localhost:4000" }).config.apiBase,
  "http://localhost:4000",
);

// Every form jobsUi() refuses.
for (const [why, apiUrl] of [
  ["empty", ""],
  ["relative", "jobs-api"],
  ["protocol-relative", "//ops.example.com/jobs-api"],
  ["the root path", "/"],
  ["a bad path segment", "/jobs api"],
  ["a dot segment", "/a/../jobs-api"],
  ["a ws: URL", "ws://ops.example.com/jobs-api"],
  ["an ftp: URL", "ftp://ops.example.com/jobs-api"],
  ["a javascript: URL", "javascript:alert(1)"],
  ["a file: URL", "file:///etc/passwd"],
  ["a query", "https://ops.example.com/jobs-api?token=1"],
  ["a fragment", "https://ops.example.com/jobs-api#top"],
  ["credentials", "https://admin:secret@ops.example.com/jobs-api"],
  ["a user name alone", "https://admin@ops.example.com/jobs-api"],
  ["not a URL at all", "http://"],
] as const) {
  await checkRejects(
    `apiUrl refuses ${why}: ${JSON.stringify(apiUrl)}`,
    () => ui({ apiUrl }),
    CONFIG,
  );
}

/* ================================================================== */
step("basePath — where the UI is mounted");

checkEqual("default", ui({ api }).basePath, "/jobs");
checkEqual(
  "a trailing slash is dropped",
  ui({ api, basePath: "/admin/jobs/" }).basePath,
  "/admin/jobs",
);
checkEqual(
  "every trailing slash",
  ui({ api, basePath: "/admin/jobs//" }).basePath,
  "/admin/jobs",
);
checkEqual(
  "segments may use letters, digits, _ . ~ -",
  ui({ api, basePath: "/Ops_2/jobs.ui~v1-beta" }).basePath,
  "/Ops_2/jobs.ui~v1-beta",
);
const nested = ui({ api, basePath: "/admin/jobs/" });
checkEqual(
  "config.basePath and assetsPath follow it",
  [nested.config.basePath, nested.config.assetsPath],
  ["/admin/jobs", "/admin/jobs/assets"],
);

for (const [why, basePath] of [
  ["relative", "jobs"],
  ["empty", ""],
  ["the root", "/"],
  ["only slashes", "//"],
  ["an empty segment", "/admin//jobs"],
  ["a space", "/admin jobs"],
  ["a percent-escape", "/admin%20jobs"],
  ["a non-ASCII letter", "/tâches"],
  ['a "." segment', "/admin/./jobs"],
  ['a ".." segment', "/admin/../jobs"],
  ["equal to the API's basePath", "/jobs-api"],
  ["under the API's basePath", "/jobs-api/ui"],
] as const) {
  await checkRejects(
    `basePath refuses ${why}: ${JSON.stringify(basePath)}`,
    () => ui({ api, basePath }),
    CONFIG,
  );
}
await checkRejects(
  "the same rule against an apiUrl path",
  () => ui({ apiUrl: "/jobs-api", basePath: "/jobs-api/ui" }),
  CONFIG,
);
checkEqual(
  "a name that merely starts the same is fine",
  ui({ api, basePath: "/jobs-api-ui" }).basePath,
  "/jobs-api-ui",
);

/* ================================================================== */
step("basePath — the API may sit under the UI, mounted in either order");

// UI at /admin, API at /admin/api. Requests under the API's path are the
// API's, even though the UI's catch-all mounted first would match them.
const inner = createJobsApi({
  jobs,
  basePath: "/admin/api",
  authorize: () => true,
  logger: noopLogger,
});
apis.push(inner);
let innerAuthorizeCalls = 0;
const outer = ui({
  api: inner,
  basePath: "/admin",
  authorize: () => {
    innerAuthorizeCalls++;
    return true;
  },
});
const uiFirst = new BunHttpAdapter();
uiFirst.use(outer.basePath, outer.router); // the UI first
uiFirst.use(inner.basePath, inner.router);

const innerMeta = await answer(uiFirst, "/admin/api/meta");
checkEqual(
  "GET /admin/api/meta is the API's JSON",
  [innerMeta.status, innerMeta.type?.split(";")[0]],
  [200, "application/json"],
);
const innerMissing = await answer(uiFirst, "/admin/api/nope");
checkEqual(
  "an unknown API path is the API's 404, not the shell",
  [innerMissing.status, innerMissing.type],
  [404, "application/problem+json"],
);
checkEqual("the UI's authorize never saw them", innerAuthorizeCalls, 0);
const outerShell = await answer(uiFirst, "/admin/queues");
checkEqual(
  "the UI still answers its own paths",
  [outerShell.status, outerShell.type, innerAuthorizeCalls],
  [200, "text/html; charset=utf-8", 1],
);

/* ================================================================== */
step("csrfHeader — the header the UI's mutations carry");

// The default comes from the API once it reports it (api.info.csrf.header).
// The API on this branch does not, so the default is null.
const reports = "info" in api;
show("this API reports api.info", reports);
checkEqual(
  "unset → what the API reports, else null",
  ui({ api }).config.csrfHeader,
  reports
    ? ((api as { info?: { csrf?: { header?: string } } }).info?.csrf?.header ??
        null)
    : null,
);

// So an API with a CSRF header needs it repeated by hand:
const guarded = createJobsApi({
  jobs,
  basePath: "/guarded-api",
  authorize: () => true,
  csrf: { header: "X-Jobs-CSRF" },
  logger: noopLogger,
});
apis.push(guarded);
const guardedUi = ui({
  api: guarded,
  basePath: "/guarded",
  csrfHeader: "X-Jobs-CSRF",
});
checkEqual("set by hand", guardedUi.config.csrfHeader, "X-Jobs-CSRF");

// What the app does with it: every mutation sends that header. Without it the
// API refuses the mutation, which is why it must match.
await jobs.queue("mail").add("welcome", { to: "ada@example.com" });
const guardedApp = new BunHttpAdapter();
guardedApp.use(guarded.basePath, guarded.router);
const pauseWithout = await answer(
  guardedApp,
  "/guarded-api/queues/mail/pause",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  },
);
checkEqual(
  "a mutation without the header → 403 CSRF_REJECTED",
  [pauseWithout.status, pauseWithout.code],
  [403, "CSRF_REJECTED"],
);
const pauseWith = await answer(guardedApp, "/guarded-api/queues/mail/pause", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    [guardedUi.config.csrfHeader!]: "1",
  },
  body: "{}",
});
check(
  "the same mutation with config.csrfHeader → accepted",
  pauseWith.status < 300,
  pauseWith,
);

checkEqual(
  "false → null (the API has no header)",
  ui({ api, csrfHeader: false }).config.csrfHeader,
  null,
);
await checkRejects(
  "a header name with a space",
  () => ui({ api, csrfHeader: "X Jobs" }),
  CONFIG,
);
await checkRejects(
  "an empty header name",
  () => ui({ api, csrfHeader: "" }),
  CONFIG,
);
await checkRejects(
  "true is not a header name",
  () => ui({ api, csrfHeader: true as unknown as string }),
  CONFIG,
);

/* ================================================================== */
step("title — the page title and brand text");

checkEqual("default", ui({ api }).config.title, "Jobs");
const hostile = ui({ api, title: `Ops </script><b>"jobs"</b> & co` });
const hostileShell = await fetchShell(hostile.router, "/");
checkEqual(
  "it is escaped in <title>",
  hostileShell.shell.title,
  "Ops &lt;/script&gt;&lt;b&gt;&quot;jobs&quot;&lt;/b&gt; &amp; co",
);
checkEqual(
  "and survives the config <script> intact",
  hostileShell.shell.config.title,
  `Ops </script><b>"jobs"</b> & co`,
);
check(
  "because the config JSON escapes < > &",
  !hostileShell.shell.html.includes("</script><b>"),
);
await checkRejects("empty", () => ui({ api, title: "" }), CONFIG);
await checkRejects("whitespace only", () => ui({ api, title: "   " }), CONFIG);
await checkRejects(
  "not a string",
  () => ui({ api, title: 42 as unknown as string }),
  CONFIG,
);

/* ================================================================== */
step("sections — manage and docs");

checkEqual("default: both", ui({ api }).config.sections, {
  manage: true,
  docs: true,
});
checkEqual(
  "docs only",
  ui({ api, sections: { manage: false } }).config.sections,
  { manage: false, docs: true },
);
checkEqual(
  "manage only",
  ui({ api, sections: { docs: false } }).config.sections,
  { manage: true, docs: false },
);
await checkRejects(
  "both off",
  () => ui({ api, sections: { manage: false, docs: false } }),
  { ...CONFIG, message: /at least one/ },
);
await checkRejects(
  "a non-boolean flag",
  () => ui({ api, sections: { manage: "yes" as unknown as boolean } }),
  CONFIG,
);
await checkRejects(
  "not an object",
  () => ui({ api, sections: null as unknown as { manage: boolean } }),
  CONFIG,
);

/* ================================================================== */
step("theme — the initial colour scheme");

for (const [theme, scheme] of [
  [undefined, "light dark"],
  ["system", "light dark"],
  ["light", "light"],
  ["dark", "dark"],
] as const) {
  const themed = ui({ api, theme });
  const page = await fetchShell(themed.router, "/");
  checkEqual(
    `theme ${theme ?? "(unset)"} → config.theme and <meta name="color-scheme">`,
    [
      page.shell.config.theme,
      /<meta name="color-scheme" content="([^"]*)">/.exec(page.shell.html)?.[1],
    ],
    [theme ?? "system", scheme],
  );
}
await checkRejects(
  "an unknown theme",
  () => ui({ api, theme: "sepia" as unknown as "dark" }),
  CONFIG,
);

/* ================================================================== */
step("authorize — every answer it may give");

/** Mounts a UI with this authorize and records every context it was given. */
function guardedBy(authorize: JobsUiAuthorize) {
  const contexts: JobsUiAuthorizeContext[] = [];
  const mounted = mount({
    api,
    authorize: async (req, context) => {
      contexts.push(context);
      return authorize(req, context);
    },
  });
  return { ...mounted, contexts };
}

const allowed = guardedBy(() => true);
const allowedShell = await fetchShell(allowed.app, "/jobs/queues/mail?x=1");
checkEqual("true → the shell", allowedShell.response.status, 200);
const allowedAsset = await answer(allowed.app, allowedShell.shell.script.src);
checkEqual("and the bundle", allowedAsset.status, 200);
checkEqual(
  "it is told the path (no query) and whether it is an asset",
  allowed.contexts,
  [
    { asset: false, path: "/jobs/queues/mail" },
    { asset: true, path: allowedShell.shell.script.src },
  ],
);
await answer(allowed.app, "/jobs/assets/nope.js");
checkEqual(
  "asked about unknown assets too, before the 404",
  allowed.contexts.at(-1),
  { asset: true, path: "/jobs/assets/nope.js" },
);
await answer(allowed.app, "/jobs-api/meta");
checkEqual("never asked about the API's own paths", allowed.contexts.length, 3);

checkEqual(
  "{ allow: true } → the shell",
  (await answer(guardedBy(() => ({ allow: true })).app, "/jobs")).status,
  200,
);

const denied = await answer(guardedBy(() => false).app, "/jobs");
checkEqual(
  "false → 403 FORBIDDEN problem",
  [denied.status, denied.type, denied.code, denied.detail],
  [
    403,
    "application/problem+json",
    "FORBIDDEN",
    "Not allowed to open this page",
  ],
);

const signIn = await answer(
  guardedBy(() => ({ allow: false, status: 401, reason: "Sign in first" })).app,
  "/jobs",
);
checkEqual(
  "{ allow: false, status: 401, reason } → 401 UNAUTHORIZED, with the reason",
  [signIn.status, signIn.code, signIn.detail],
  [401, "UNAUTHORIZED", "Sign in first"],
);

const noReason = await answer(
  guardedBy(() => ({ allow: false, status: 401 })).app,
  "/jobs",
);
checkEqual(
  "{ allow: false, status: 401 } → 401 with a default detail",
  [noReason.status, noReason.code, noReason.detail],
  [401, "UNAUTHORIZED", "Authentication required"],
);

const forbidden = await answer(
  guardedBy(() => ({ allow: false, status: 403, reason: "Admins only" })).app,
  "/jobs",
);
checkEqual(
  "{ allow: false, status: 403, reason } → 403 FORBIDDEN, with the reason",
  [forbidden.status, forbidden.code, forbidden.detail],
  [403, "FORBIDDEN", "Admins only"],
);

const asyncDenied = await answer(
  guardedBy(async () => {
    await Bun.sleep(5);
    return { allow: false, status: 401 };
  }).app,
  "/jobs",
);
checkEqual("async: awaited", asyncDenied.status, 401);

for (const [why, result] of [
  ["undefined (a forgotten return)", undefined],
  ['a string ("yes")', "yes"],
  ['{ allow: "true" }', { allow: "true" }],
  ["1", 1],
] as const) {
  const unrecognised = await answer(
    guardedBy(() => result as unknown as boolean).app,
    "/jobs",
  );
  checkEqual(
    `unrecognised: ${why} → 403 (fails closed)`,
    [unrecognised.status, unrecognised.code],
    [403, "FORBIDDEN"],
  );
}

const events = createTestLogger();
const crashing = mount({
  api,
  logger: events.logger,
  authorize: () => {
    throw new Error("session store down");
  },
});
const crashed = await answer(crashing.app, "/jobs");
checkEqual(
  "a throw → 500 INTERNAL, the message not leaked",
  [crashed.status, crashed.code, crashed.detail],
  [500, "INTERNAL", "Internal server error"],
);
checkEqual(
  "and logged with the error",
  events.events.map((event) => [event.level, event.error?.message]),
  [["error", "session store down"]],
);

// The asset flag lets the bundle stay public while the page needs a session.
const pageOnly = guardedBy((_req, { asset }) =>
  asset ? true : { allow: false, status: 401 },
);
const pageRefused = await answer(pageOnly.app, "/jobs");
const bundleServed = await answer(pageOnly.app, allowedShell.shell.script.src);
checkEqual(
  "asset: true lets the bundle through while the page is refused",
  [pageRefused.status, bundleServed.status],
  [401, 200],
);

const headDenied = await answer(guardedBy(() => false).app, "/jobs", {
  method: "HEAD",
});
checkEqual(
  "HEAD denied → 403 with no body",
  [headDenied.status, headDenied.text],
  [403, ""],
);

await checkRejects(
  "authorize must be a function",
  () => ui({ api, authorize: true as unknown as JobsUiAuthorize }),
  CONFIG,
);

/* ================================================================== */
step("middleware — runs before authorize");

const order: string[] = [];
const withMiddleware = mount({
  api,
  middleware: [
    (req, _res, next) => {
      order.push(`session ${req.path}`);
      next();
    },
    (_req, _res, next) => {
      order.push("rate limit");
      next();
    },
  ],
  authorize: () => {
    order.push("authorize");
    return true;
  },
});
checkEqual(
  "the shell is served",
  (await answer(withMiddleware.app, "/jobs/runners")).status,
  200,
);
checkEqual("in order, then authorize", order, [
  "session /jobs/runners",
  "rate limit",
  "authorize",
]);

order.length = 0;
await answer(withMiddleware.app, "/jobs-api/meta");
checkEqual("not run for the API's paths", order, []);

order.length = 0;
await answer(withMiddleware.app, "/jobs/queues", { method: "POST" });
checkEqual("not run for methods the UI does not answer", order, []);

// Middleware may answer by itself; authorize is then never asked.
let askedAfterLimit = false;
const limited = mount({
  api,
  middleware: [
    (_req, res) => {
      res.status(429).json({ error: "slow down" });
    },
  ],
  authorize: () => {
    askedAfterLimit = true;
    return true;
  },
});
const limitedAnswer = await answer(limited.app, "/jobs");
checkEqual("middleware can answer (429)", limitedAnswer.status, 429);
checkEqual("and authorize is not asked", askedAfterLimit, false);

// An error it raises goes to the host's error handling.
const failing = mount({
  api,
  middleware: [
    () => {
      throw new Error("no session");
    },
  ],
});
failing.app.use(((error, _req, res, _next) => {
  res.status(503).json({ host: String((error as Error).message) });
}) satisfies RouterErrorMiddlewareHandler);
const failed = await answer(failing.app, "/jobs");
checkEqual(
  "a throw in middleware reaches the host's error handler",
  [failed.status, failed.text],
  [503, JSON.stringify({ host: "no session" })],
);

await checkRejects(
  "middleware must be an array",
  () => ui({ api, middleware: (() => {}) as unknown as RouterHandler[] }),
  CONFIG,
);
await checkRejects(
  "of functions",
  () => ui({ api, middleware: ["session"] as unknown as RouterHandler[] }),
  CONFIG,
);

/* ================================================================== */
step("The result — frozen");

const result = ui({ api });
check("the result is frozen", Object.isFrozen(result));
check("config is frozen", Object.isFrozen(result.config));
check(
  "and so are its nested objects",
  Object.isFrozen(result.config.sections) &&
    Object.isFrozen(result.config.websocket) &&
    Object.isFrozen(result.config.docs),
);

await checkRejects(
  "no options at all",
  () => jobsUi(undefined as unknown as JobsUiOptions),
  CONFIG,
);

summary();

for (const each of apis) {
  await each.close();
}
await jobs.close();
