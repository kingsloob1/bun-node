/**
 * The UI on one origin, the API on another: `apiUrl`, and the three settings
 * the API needs so a browser on the UI's origin may use it.
 *
 * ```bash
 * bun 03-deployments/cross-origin.ts
 * ```
 *
 * Two servers, each on an OS-assigned port — two ports are two origins. The
 * UI server has no `createJobsApi` at all: it is told where the API is with
 * `apiUrl`, and the page's app talks to that origin directly, with the
 * browser's cookies (`credentials: "include"`).
 *
 * The API must then allow that origin three times over, once per defence:
 *
 * 1. **`cors: { origin: [uiOrigin], credentials: true }`** — so the browser
 *    lets the page read responses (and send cookies). An explicit list is
 *    required: with credentials, `createJobsApi` refuses a wildcard, a RegExp
 *    and `"null"`.
 * 2. **`csrf.allowedOrigins: [uiOrigin]`** — mutations from any other origin
 *    are refused with 403 `CSRF_REJECTED`, whatever CORS says.
 * 3. **`websocket.allowedOrigins: [uiOrigin]`** — the live-events socket
 *    checks `Origin` on the upgrade too; CORS does not apply to WebSockets.
 *
 * And the UI must be told the API's `csrf.header`, because with `apiUrl` it
 * cannot read it: `csrfHeader: "X-Jobs-CSRF"`.
 *
 * The shell's `connect-src` then lists the API's origin in its `http(s)` and
 * `ws(s)` forms. Keep the socket on the API's own port in this setup: with
 * `apiUrl` the UI only learns a dedicated socket port from `/meta` at
 * runtime, so that port is not in `connect-src`.
 *
 * What this script can and cannot show: it sends exactly the requests a
 * browser on the UI's origin would — the preflight, the `Origin` and
 * `Sec-Fetch-Site` headers, the cookie — and checks the API's answers and the
 * UI's Content-Security-Policy. That the *browser* then enforces CORS and the
 * CSP is the browser's job; no script can assert it.
 */
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { cspDirectives, fetchShell } from "../shared/shell";

title("A cross-origin API: apiUrl, CORS, CSRF and the socket");

/* ------------------------------------------------------------------ */
step("Two servers, two origins");

// Both listen first, so each knows the other's origin before it is set up.
// Routes can be mounted on a running adapter.
const apiServer = new BunHttpAdapter();
const uiServer = new BunHttpAdapter();
await apiServer.listen(0);
await uiServer.listen(0);

const apiOrigin = apiServer.url!.replace(/\/$/, "");
const uiOrigin = uiServer.url!.replace(/\/$/, "");
/** An origin the API has never heard of. */
const evilOrigin = "https://evil.example";
show("the API's origin", apiOrigin);
show("the UI's origin", uiOrigin);

/* ------------------------------------------------------------------ */
step("The API: allow the UI's origin, three times");

const jobs = new BunJobs({
  namespace: "examples-ui-cross-origin",
  driver: new MemoryDriver(),
  publishEvents: true,
  logger: noopLogger,
});
await jobs.queue("mail").add("welcome", { to: "ada@example.com" });

const api = createJobsApi({
  jobs,
  basePath: "/jobs-api",
  // Cookie sessions: the browser sends them because the app fetches with
  // credentials. Anything else is a 401.
  authorize: (req) =>
    req.getHeader("cookie")?.includes("session=ada") === true
      ? true
      : { allow: false, status: 401 },
  cors: { origin: [uiOrigin], credentials: true },
  csrf: { header: "X-Jobs-CSRF", allowedOrigins: [uiOrigin] },
  websocket: { allowedOrigins: [uiOrigin] },
  logger: noopLogger,
});
apiServer.use(api.basePath, api.router);
api.websocket!.attach(apiServer);

// The rule `createJobsApi` enforces on the first of the three.
await checkRejects(
  "cors with credentials refuses a wildcard origin",
  () =>
    createJobsApi({
      jobs,
      basePath: "/other-api",
      authorize: () => true,
      cors: { origin: "*", credentials: true },
      logger: noopLogger,
    }),
  { code: "CONFIG" },
);

/* ------------------------------------------------------------------ */
step("The UI: apiUrl, and the CSRF header repeated by hand");

const ui = jobsUi({
  apiUrl: `${apiOrigin}/jobs-api`,
  csrfHeader: "X-Jobs-CSRF",
  logger: noopLogger,
});
uiServer.use(ui.basePath, ui.router);

show("ui.config", ui.config);
checkEqual(
  "config.apiBase is the full URL",
  ui.config.apiBase,
  `${apiOrigin}/jobs-api`,
);
checkEqual("config.csrfHeader", ui.config.csrfHeader, "X-Jobs-CSRF");
checkEqual(
  "no socket or docs in the config: the app reads them from /meta",
  [ui.config.websocket, ui.config.docs],
  [null, null],
);

const { response: page, shell } = await fetchShell(
  { fetch: (path, init) => fetch(`${uiOrigin}${path}`, init) },
  "/jobs/queues/mail",
);
checkEqual("the UI server serves the shell", page.status, 200);
checkEqual(
  "carrying the same config",
  shell.config,
  JSON.parse(JSON.stringify(ui.config)),
);
const connectSrc = cspDirectives(page.headers.get("content-security-policy"))[
  "connect-src"
];
// After 'self': the page's own origin as a socket (from the Host the browser
// sent), then the API's origin in its http(s) and ws(s) forms. Never a bare
// ws: or wss:.
checkEqual(
  "connect-src: the page's socket origin, and the API's origin as http and ws",
  connectSrc,
  [
    "'self'",
    `ws://${new URL(uiOrigin).host}`,
    apiOrigin,
    `ws://${new URL(apiOrigin).host}`,
  ],
);

/** What the page's app sends: the UI's origin, a cross-site fetch, the cookie. */
const fromUi = {
  Origin: uiOrigin,
  "Sec-Fetch-Site": "cross-site",
  Cookie: "session=ada",
};

/* ------------------------------------------------------------------ */
step("1. CORS — reading responses from the UI's origin");

// The preflight a browser sends before a mutation carrying a custom header.
const preflight = await fetch(`${apiOrigin}/jobs-api/queues/mail/pause`, {
  method: "OPTIONS",
  headers: {
    Origin: uiOrigin,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type,x-jobs-csrf",
  },
});
await preflight.arrayBuffer();
show("preflight headers", Object.fromEntries(preflight.headers));
checkEqual(
  "the preflight is allowed for the UI's origin, with credentials",
  [
    preflight.status,
    preflight.headers.get("access-control-allow-origin"),
    preflight.headers.get("access-control-allow-credentials"),
  ],
  [204, uiOrigin, "true"],
);
check(
  "and allows the CSRF header",
  (preflight.headers.get("access-control-allow-headers") ?? "")
    .toLowerCase()
    .includes("x-jobs-csrf"),
  preflight.headers.get("access-control-allow-headers"),
);

const meta = await fetch(`${apiOrigin}/jobs-api/meta`, { headers: fromUi });
const metaBody = (await meta.json()) as {
  websocket: { path: string } | null;
};
checkEqual(
  "GET /meta from the UI's origin: readable, with credentials",
  [
    meta.status,
    meta.headers.get("access-control-allow-origin"),
    meta.headers.get("access-control-allow-credentials"),
  ],
  [200, uiOrigin, "true"],
);
show("what the app learns from /meta about the socket", metaBody.websocket);

const evilRead = await fetch(`${apiOrigin}/jobs-api/meta`, {
  headers: { ...fromUi, Origin: evilOrigin },
});
await evilRead.arrayBuffer();
checkEqual(
  "from another origin: no Access-Control-Allow-Origin, so the browser hides it",
  evilRead.headers.get("access-control-allow-origin"),
  null,
);

/* ------------------------------------------------------------------ */
step("2. CSRF — mutations from the UI's origin, with the header");

/** Pauses (or resumes) the mail queue with these headers. */
async function mutate(
  action: "pause" | "resume",
  headers: Record<string, string>,
) {
  const response = await fetch(`${apiOrigin}/jobs-api/queues/mail/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: "{}",
  });
  const text = await response.text();
  return {
    status: response.status,
    code: text ? (JSON.parse(text) as { code?: string }).code : undefined,
  };
}

const accepted = await mutate("pause", {
  ...fromUi,
  [ui.config.csrfHeader!]: "1",
});
check(
  "from the UI's origin, with config.csrfHeader → accepted",
  accepted.status < 300,
  accepted,
);
await mutate("resume", { ...fromUi, "X-Jobs-CSRF": "1" });

checkEqual(
  "without the header → 403 CSRF_REJECTED",
  await mutate("pause", fromUi),
  { status: 403, code: "CSRF_REJECTED" },
);
checkEqual(
  "from another origin, header and cookie included → 403 CSRF_REJECTED",
  await mutate("pause", {
    ...fromUi,
    Origin: evilOrigin,
    "X-Jobs-CSRF": "1",
  }),
  { status: 403, code: "CSRF_REJECTED" },
);
checkEqual(
  "without the cookie → the API's own authorize: 401",
  await mutate("pause", {
    Origin: uiOrigin,
    "Sec-Fetch-Site": "cross-site",
    "X-Jobs-CSRF": "1",
  }),
  { status: 401, code: "UNAUTHORIZED" },
);

/* ------------------------------------------------------------------ */
step("3. The socket — its own Origin check");

/**
 * Opens the API's socket as a browser page on `origin` would, and answers
 * with the first frame's type or how the connection ended.
 */
async function connect(origin: string): Promise<string> {
  const url = `${apiOrigin.replace(/^http/, "ws")}${metaBody.websocket!.path}`;
  const socket = new WebSocket(url, {
    headers: { Origin: origin, Cookie: "session=ada" },
  });
  return new Promise((resolve) => {
    socket.addEventListener("message", (event) => {
      resolve(
        `frame: ${(JSON.parse(String(event.data)) as { type: string }).type}`,
      );
      socket.close();
    });
    socket.addEventListener("error", () => resolve("refused"));
    socket.addEventListener("close", (event) => {
      resolve(`closed ${event.code}`);
    });
  });
}

checkEqual(
  "from the UI's origin → connected, greeted",
  await connect(uiOrigin),
  "frame: hello",
);
checkEqual(
  "from another origin → refused",
  await connect(evilOrigin),
  "refused",
);

summary();

await uiServer.close();
await apiServer.close();
await api.close();
await jobs.close();
