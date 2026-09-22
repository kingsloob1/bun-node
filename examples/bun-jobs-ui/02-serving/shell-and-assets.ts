/**
 * What the UI serves, checked without a socket: the HTML shell and its
 * security headers, the configuration it carries, and the hashed bundle with
 * its caching.
 *
 * ```bash
 * bun 02-serving/shell-and-assets.ts
 * ```
 *
 * Every request here goes through `app.fetch()`, which runs the adapter's real
 * pipeline — the same method its `Bun.serve` handler calls — with no port
 * bound. That makes it the natural way to test a mounted UI.
 *
 * Worth knowing:
 *
 * - **Two kinds of route, `GET` and `HEAD` only.** `<basePath>/assets/:file`
 *   serves a bundle file; every other path under `basePath` (`/` and `/*`)
 *   serves the same HTML shell, because the React app routes on the client.
 *   Any other method falls through to the host.
 * - **The shell is never cached; the bundle is cached for a year.** Bundle
 *   file names carry a content hash, so a new build is a new URL.
 * - **The Content-Security-Policy allows no inline script.** The config
 *   travels as a `<script type="application/json">` (data, never run), and
 *   the one module script is loaded from this origin under a per-request
 *   nonce.
 * - **`connect-src` is built per request, never a bare `ws:`/`wss:`.** After
 *   `'self'` it lists the page's own origin as a socket (`ws://` on http,
 *   `wss://` on https, with the `Host`'s port), and a dedicated socket port on
 *   the same hostname. A `Host` that is not a plain `host[:port]` adds
 *   nothing, so a forged one cannot inject a directive.
 * - **The first request may bundle the app in memory** inside this repo (no
 *   `dist/`). It is a one-time cost of tens of milliseconds.
 */
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import {
  ASSET_CACHE_CONTROL,
  jobsUi,
  UI_CONFIG_ELEMENT_ID,
} from "@kingsleyweb/bun-jobs-ui";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { cspDirectives, fetchShell, parseShell } from "../shared/shell";

title("The shell and the bundle, without a socket");

const jobs = new BunJobs({
  namespace: "examples-ui-serving",
  driver: new MemoryDriver(),
  publishEvents: true,
  logger: noopLogger,
});
const api = createJobsApi({
  jobs,
  basePath: "/admin/jobs-api",
  authorize: () => true,
  logger: noopLogger,
});
const ui = jobsUi({ api, basePath: "/admin/jobs", logger: noopLogger });

const app = new BunHttpAdapter();
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);

/* ------------------------------------------------------------------ */
step("The shell: one page for every client route");

const first = await app.fetch("/admin/jobs/queues/mail");
const html = await first.text();
checkEqual("200", first.status, 200);

// The recipe, without helpers: the config is a JSON <script> with a fixed id.
const raw = new RegExp(
  `<script type="application/json" id="${UI_CONFIG_ELEMENT_ID}"[^>]*>([\\s\\S]*?)</script>`,
).exec(html)![1]!;
checkEqual(
  "the config element's id",
  UI_CONFIG_ELEMENT_ID,
  "bun-jobs-ui-config",
);
checkEqual(
  "the config in the page is exactly ui.config",
  JSON.parse(raw),
  JSON.parse(JSON.stringify(ui.config)),
);

const shell = parseShell(html);
show("config", shell.config);
checkEqual("config.version", shell.config.version, 1);
checkEqual("config.basePath", shell.config.basePath, "/admin/jobs");
checkEqual("config.assetsPath", shell.config.assetsPath, "/admin/jobs/assets");
checkEqual("config.apiBase", shell.config.apiBase, "/admin/jobs-api");
checkEqual("config.websocket, read from the API", shell.config.websocket, {
  path: "/admin/jobs-api/ws",
  port: null,
});
checkEqual("config.docs, read from the API", shell.config.docs, {
  openapi: "/admin/jobs-api/openapi.json",
  asyncapi: "/admin/jobs-api/asyncapi.json",
});
check("the React mount point", html.includes('<div id="root"></div>'));
checkEqual("<title>", shell.title, "Jobs");

/* ------------------------------------------------------------------ */
step("The shell's headers");

show("headers", Object.fromEntries(first.headers));
checkEqual(
  "Content-Type",
  first.headers.get("content-type"),
  "text/html; charset=utf-8",
);
checkEqual("Cache-Control", first.headers.get("cache-control"), "no-store");
checkEqual(
  "X-Content-Type-Options",
  first.headers.get("x-content-type-options"),
  "nosniff",
);
checkEqual(
  "Referrer-Policy",
  first.headers.get("referrer-policy"),
  "no-referrer",
);

/* ------------------------------------------------------------------ */
step("The Content-Security-Policy and its nonce");

const csp = first.headers.get("content-security-policy");
show("Content-Security-Policy", csp);
const directives = cspDirectives(csp);
const nonce = shell.configNonce;

checkEqual("default-src", directives["default-src"], ["'self'"]);
checkEqual(
  "script-src: this origin and this request's nonce",
  directives["script-src"],
  ["'self'", `'nonce-${nonce}'`],
);
checkEqual("style-src: files only", directives["style-src"], ["'self'"]);
checkEqual("img-src", directives["img-src"], ["'self'", "data:"]);
// `app.fetch("/path")` requests http://localhost, so the page's own origin
// as a socket is ws://localhost. Never a bare ws: or wss:, which would allow
// a socket to any host.
checkEqual(
  "connect-src: 'self' and this page's origin as a socket (a same-origin API adds nothing)",
  directives["connect-src"],
  ["'self'", "ws://localhost"],
);
checkEqual("base-uri", directives["base-uri"], ["'none'"]);
checkEqual("frame-ancestors: never framed", directives["frame-ancestors"], [
  "'none'",
]);
checkEqual("form-action", directives["form-action"], ["'self'"]);

check(
  "the nonce is 128 random bits, base64",
  /^[A-Z0-9+/]{22}==$/i.test(nonce),
  nonce,
);
checkEqual(
  "the module script carries the same nonce",
  shell.script.nonce,
  nonce,
);
check(
  "no inline script: every <script> is JSON data or has a src",
  [...html.matchAll(/<script\b([^>]*)>/g)].every(
    ([, attributes]) =>
      attributes!.includes('type="application/json"') ||
      attributes!.includes("src="),
  ),
);

// The nonce is fresh on every request; nothing else in the page changes.
const second = await fetchShell(app, "/admin/jobs/queues/mail");
const secondNonce = second.shell.configNonce;
check("a second request has a different nonce", secondNonce !== nonce, {
  nonce,
  secondNonce,
});
checkEqual(
  "and the page is otherwise identical",
  second.shell.html.replaceAll(secondNonce, "NONCE"),
  html.replaceAll(nonce, "NONCE"),
);

/* ------------------------------------------------------------------ */
step("connect-src: built from each request's Host");

// connect-src is computed per request from the Host header (the origin the
// browser loaded the page from) and whether the page is https. `fetch()`
// takes a full Request, so each case sets the URL or the Host explicitly.
/** The connect-src sources of the shell answered for `request`. */
async function connectSrcFor(
  target: { fetch: (request: Request) => Promise<Response> },
  request: Request,
): Promise<string[]> {
  const response = await target.fetch(request);
  await response.arrayBuffer();
  return (
    cspDirectives(response.headers.get("content-security-policy"))[
      "connect-src"
    ] ?? []
  );
}

checkEqual(
  "an https page → wss://",
  await connectSrcFor(app, new Request("https://jobs.example/admin/jobs")),
  ["'self'", "wss://jobs.example"],
);
checkEqual(
  "https behind a proxy (X-Forwarded-Proto) → wss:// too",
  await connectSrcFor(
    app,
    new Request("http://jobs.example/admin/jobs", {
      headers: { "X-Forwarded-Proto": "https" },
    }),
  ),
  ["'self'", "wss://jobs.example"],
);
checkEqual(
  "a Host with a port keeps the port",
  await connectSrcFor(
    app,
    new Request("http://localhost/admin/jobs", {
      headers: { Host: "jobs.example:8080" },
    }),
  ),
  ["'self'", "ws://jobs.example:8080"],
);

// A Host that is not a plain host[:port] (a DNS name or an IPv4 address) adds
// nothing: a forged Host cannot write a directive into the header.
const malformedHosts = [
  "evil; script-src *",
  "jobs.example, *",
  "jobs example",
  "jobs.example:99999",
];
for (const host of malformedHosts) {
  checkEqual(
    `a malformed Host ${JSON.stringify(host)} → only 'self'`,
    await connectSrcFor(
      app,
      new Request("http://jobs.example/admin/jobs", {
        headers: { Host: host },
      }),
    ),
    ["'self'"],
  );
}
checkEqual(
  "an IPv6 Host is left out too (CSP has no form for it)",
  await connectSrcFor(app, new Request("http://[::1]:3000/admin/jobs")),
  ["'self'"],
);

// A socket on its own port (`websocket: { port }`): its ws(s) origin on the
// page's hostname joins the list.
const socketApi = createJobsApi({
  jobs,
  basePath: "/socket-api",
  authorize: () => true,
  websocket: { port: 0 },
  logger: noopLogger,
});
const socketUi = jobsUi({
  api: socketApi,
  basePath: "/socket-ui",
  logger: noopLogger,
});
const socketPort = socketUi.config.websocket?.port;
show("the dedicated socket's port", socketPort);
checkEqual(
  "a dedicated socket port adds ws://<hostname>:<port>",
  await connectSrcFor(
    socketUi.router,
    new Request("http://jobs.example:8080/"),
  ),
  ["'self'", "ws://jobs.example:8080", `ws://jobs.example:${socketPort}`],
);
checkEqual(
  "and wss://<hostname>:<port> on an https page",
  await connectSrcFor(socketUi.router, new Request("https://jobs.example/")),
  ["'self'", "wss://jobs.example", `wss://jobs.example:${socketPort}`],
);

// Whatever the Host, every source is a single CSP token.
const everySource = (
  await Promise.all(
    ["jobs.example", "jobs.example:8080", ...malformedHosts, "a\tb", ""].map(
      (host) =>
        connectSrcFor(
          socketUi.router,
          new Request("http://jobs.example/", { headers: { Host: host } }),
        ),
    ),
  )
).flat();
check(
  "no source contains whitespace, ; or ,",
  everySource.every((source) => !/[\s;,]/.test(source)),
  everySource,
);
const rawCsp = (
  await socketUi.router.fetch(
    new Request("http://jobs.example/", {
      headers: { Host: "evil; script-src *" },
    }),
  )
).headers.get("content-security-policy");
checkEqual(
  "and the forged Host never reaches the header",
  [rawCsp?.includes("evil"), rawCsp?.match(/script-src/g)?.length],
  [false, 1],
);
await socketApi.close();

/* ------------------------------------------------------------------ */
step("Deep links and the bare mount");

// A browser reloading on any client route gets the shell; the React router
// then picks the screen from the URL.
for (const path of [
  "/admin/jobs",
  "/admin/jobs/",
  "/admin/jobs/overview",
  "/admin/jobs/queues/mail/jobs/42",
  // The Retrying tab: the `failed` state keeps its value in the URL.
  "/admin/jobs/queues/mail?state=failed",
  "/admin/jobs/workers",
  "/admin/jobs/workers/mail/api.mail.send",
]) {
  const { response, shell: page } = await fetchShell(app, path);
  checkEqual(
    `${path} → the shell`,
    [response.status, page.config.basePath],
    [200, "/admin/jobs"],
  );
}

/* ------------------------------------------------------------------ */
step("The bundle: hashed files, cached for a year");

show("module script", shell.script);
show("stylesheets", shell.styles);
check(
  "the module lives under assetsPath",
  shell.script.src.startsWith(`${shell.config.assetsPath}/`),
);
check(
  "with Subresource Integrity",
  shell.script.integrity.startsWith("sha384-"),
);
check(
  "every stylesheet too",
  shell.styles.length > 0 &&
    shell.styles.every(
      (style) =>
        style.href.startsWith(`${shell.config.assetsPath}/`) &&
        style.integrity.startsWith("sha384-"),
    ),
  shell.styles,
);

const js = await app.fetch(shell.script.src);
const jsBytes = new Uint8Array(await js.arrayBuffer());
checkEqual("200", js.status, 200);
checkEqual(
  "Content-Type",
  js.headers.get("content-type"),
  "text/javascript; charset=utf-8",
);
checkEqual(
  "Cache-Control",
  js.headers.get("cache-control"),
  "public, max-age=31536000, immutable",
);
checkEqual(
  "which is the exported ASSET_CACHE_CONTROL",
  ASSET_CACHE_CONTROL,
  "public, max-age=31536000, immutable",
);
checkEqual("nosniff", js.headers.get("x-content-type-options"), "nosniff");

// The SRI digest in the page is the digest of the bytes served.
const digest = `sha384-${new Bun.CryptoHasher("sha384").update(jsBytes).digest("base64")}`;
checkEqual(
  "the integrity attribute matches the bytes",
  shell.script.integrity,
  digest,
);

const css = await app.fetch(shell.styles[0]!.href);
await css.arrayBuffer();
checkEqual(
  "a stylesheet's Content-Type",
  css.headers.get("content-type"),
  "text/css; charset=utf-8",
);

/* ------------------------------------------------------------------ */
step("ETag and 304 Not Modified");

const etag = js.headers.get("etag");
show("ETag", etag);
check("a strong ETag", etag !== null && /^"[^"]+"$/.test(etag), etag);

const notModified = await app.fetch(shell.script.src, {
  headers: { "If-None-Match": etag! },
});
checkEqual("If-None-Match with it → 304", notModified.status, 304);
checkEqual("with no body", (await notModified.text()).length, 0);
checkEqual(
  "the caching headers still sent",
  notModified.headers.get("cache-control"),
  ASSET_CACHE_CONTROL,
);

const inList = await app.fetch(shell.script.src, {
  headers: { "If-None-Match": `"something-else", W/${etag!}` },
});
checkEqual("in a list, weak or not → 304", inList.status, 304);

const stale = await app.fetch(shell.script.src, {
  headers: { "If-None-Match": '"an-old-build"' },
});
checkEqual("a different ETag → 200", stale.status, 200);
await stale.arrayBuffer();

/* ------------------------------------------------------------------ */
step("HEAD: the same headers, no body");

const headAsset = await app.fetch(shell.script.src, { method: "HEAD" });
checkEqual("HEAD on a bundle file → 200", headAsset.status, 200);
checkEqual(
  "with its Content-Type",
  headAsset.headers.get("content-type"),
  "text/javascript; charset=utf-8",
);
checkEqual(
  "and its real Content-Length",
  headAsset.headers.get("content-length"),
  String(jsBytes.byteLength),
);
checkEqual("and no body", (await headAsset.text()).length, 0);

const headShell = await app.fetch("/admin/jobs/queues", { method: "HEAD" });
checkEqual("HEAD on the shell → 200", headShell.status, 200);
checkEqual(
  "with the shell's Content-Type",
  headShell.headers.get("content-type"),
  "text/html; charset=utf-8",
);
check(
  "and a CSP with a nonce",
  /'nonce-[^']+'/.test(headShell.headers.get("content-security-policy") ?? ""),
);
checkEqual("and no body", (await headShell.text()).length, 0);

/* ------------------------------------------------------------------ */
step("What is not the UI's: unknown assets, other methods, the API");

// Under assets/ nothing falls back to the shell: a typo in a script URL must
// fail loudly, not hand the browser HTML it will refuse to run.
for (const path of [
  "/admin/jobs/assets/nope.js",
  "/admin/jobs/assets/a/b.js",
  "/admin/jobs/assets",
  "/admin/jobs/assets/",
]) {
  const response = await app.fetch(path);
  const body = (await response.json()) as Record<string, unknown>;
  checkEqual(
    `${path} → 404 problem+json`,
    [response.status, response.headers.get("content-type"), body.code],
    [404, "application/problem+json", "NOT_FOUND"],
  );
}
const problem = await (await app.fetch("/admin/jobs/assets/nope.js")).json();
show("the problem body", problem);
checkEqual("shaped like the API's problems", problem, {
  type: "urn:bun-jobs:error:NOT_FOUND",
  title: "Not found",
  status: 404,
  code: "NOT_FOUND",
  detail: "No asset /admin/jobs/assets/nope.js",
  instance: "/admin/jobs/assets/nope.js",
});

const headMissing = await app.fetch("/admin/jobs/assets/nope.js", {
  method: "HEAD",
});
checkEqual("HEAD on an unknown asset → 404", headMissing.status, 404);
checkEqual("with no body", (await headMissing.text()).length, 0);

// A POST under the UI is not answered by the UI: it reaches the host's
// not-found handling instead.
const post = await app.fetch("/admin/jobs/queues", { method: "POST" });
await post.arrayBuffer();
checkEqual("POST under the UI → the host's 404", post.status, 404);
check(
  "not the shell",
  post.headers.get("content-type") !== "text/html; charset=utf-8",
  post.headers.get("content-type"),
);

// A path that merely starts with the same letters is not under the mount.
const sibling = await app.fetch("/admin/jobsx");
await sibling.arrayBuffer();
checkEqual("/admin/jobsx is not the UI", sibling.status, 404);

// The API beside it answers for itself.
const meta = await app.fetch("/admin/jobs-api/meta");
checkEqual(
  "/admin/jobs-api/meta is the API's",
  [meta.status, meta.headers.get("content-type")?.split(";")[0]],
  [200, "application/json"],
);
await meta.arrayBuffer();

/* ------------------------------------------------------------------ */
step("The router on its own, unmounted");

// `ui.router.fetch()` works too; paths are then relative to the mount.
const bare = await fetchShell(ui.router, "/");
checkEqual("ui.router.fetch('/') → the shell", bare.response.status, 200);
checkEqual(
  "whose asset URLs are still the mounted ones",
  bare.shell.script.src,
  shell.script.src,
);

summary();

await api.close();
await jobs.close();
