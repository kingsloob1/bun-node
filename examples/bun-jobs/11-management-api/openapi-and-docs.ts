/**
 * The documents: `openapi()`, `asyncapi()`, the endpoints that serve them, and
 * the HTML viewers that are off by default.
 *
 * ```bash
 * bun 11-management-api/openapi-and-docs.ts
 * ```
 *
 * Both documents describe **exactly what this API routes**. They are generated
 * from the same route definitions the router is built from and pruned by the
 * same predicate, so a route that mode, `readOnly`, `actions` or the driver
 * removed is absent from the document too — a client generated from it can
 * never call something that is not there.
 *
 * The JSON endpoints cost nothing and are always served (behind `docs.read`).
 * The HTML viewers are **off by default**: they load third-party script into
 * an origin that holds admin cookies, and "try it out" is a mutation console.
 * With `docs.ui: true` they are served with pinned CDN versions, `sha384`
 * Subresource Integrity and a strict Content Security Policy.
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title } from "../shared/console";

title("The management API: OpenAPI, AsyncAPI and the docs pages");

const jobs = new BunJobs({
  namespace: exampleNamespace("docs"),
  driver: exampleDriver(),
});
jobs.define("send-email", async () => {});
await jobs.queue("mail").add("send-email", { to: "ada@example.com" });

/* ------------------------------------------------------------------ */
step("The documents, in process");

const api = createJobsApi({
  jobs,
  basePath: "/admin/jobs",
  authorize: () => true,
});

const openapi = api.openapi();
show("openapi version", openapi.openapi);
show("info", openapi.info);
// Relative by default, so the document works behind any host or proxy.
show("servers", openapi.servers);
show("paths documented", Object.keys(openapi.paths as object).length);
show("routes registered", api.routes.length);

const paths = openapi.paths as Record<string, Record<string, any>>;
const getJob = paths["/queues/{queue}/jobs/{id}"]!.get;
show("one operation", {
  operationId: getJob.operationId,
  summary: getJob.summary,
  // The extensions say what the route needs, so a generated client or a UI
  // can reason about permissions without a second source of truth.
  action: getJob["x-bun-jobs-action"],
  mutation: getJob["x-bun-jobs-mutation"],
});
show(
  "the problems it documents",
  Object.entries(getJob.responses)
    .filter(([, response]: [string, any]) => response["x-bun-jobs-codes"])
    .map(([status, response]: [string, any]) => ({
      status,
      codes: response["x-bun-jobs-codes"],
    })),
);

const asyncapi = api.asyncapi()!;
show("asyncapi version", asyncapi.asyncapi);
show("channels", Object.keys(asyncapi.channels as object));
show("messages", Object.keys((asyncapi.components as any).messages).length);
show("operations", Object.keys(asyncapi.operations as object));

/* ------------------------------------------------------------------ */
step("The same documents over HTTP");

const adapter = new BunHttpAdapter();
adapter.use(api.basePath, api.router);

/** Fetches a path under the API, with its status and content type. */
async function get(path: string) {
  const response = await adapter.fetch(`${api.basePath}${path}`);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    response,
  };
}

const served = await get("/openapi.json");
show("GET /openapi.json", {
  status: served.status,
  contentType: served.contentType,
});
show("GET /asyncapi.json", (await get("/asyncapi.json")).status);
// `/meta` points a client at whichever documents this API actually serves.
const meta = await (await adapter.fetch(`${api.basePath}/meta`)).json();
show("/meta.docs", (meta as any).docs);

/* ------------------------------------------------------------------ */
step("The HTML viewers are off by default");

show("GET /docs", (await get("/docs")).status);
show("GET /docs/asyncapi", (await get("/docs/asyncapi")).status);
show(
  "why",
  "a viewer loads third-party script into an origin holding admin cookies, and 'try it out' is a mutation console",
);

/* ------------------------------------------------------------------ */
step("With docs.ui: true, pinned and locked down");

const documented = createJobsApi({
  jobs,
  basePath: "/ops/jobs",
  authorize: () => true,
  docs: {
    ui: true,
    title: "Shop jobs",
    description: "Queues and runners for the shop service.",
  },
});
const uiAdapter = new BunHttpAdapter();
uiAdapter.use(documented.basePath, documented.router);

const page = await uiAdapter.fetch("/ops/jobs/docs");
const html = await page.text();
show("GET /ops/jobs/docs", {
  status: page.status,
  contentType: page.headers.get("content-type"),
});

/** The Content Security Policy directives of the page, by name. */
const csp = Object.fromEntries(
  (page.headers.get("content-security-policy") ?? "")
    .split("; ")
    .map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name!, values.join(" ")];
    }),
);
show("default-src", csp["default-src"]);
// One per-request nonce plus the CDN's origin: neither an injected script tag
// nor a substituted bundle can run.
show("script-src", csp["script-src"]);
show("connect-src", csp["connect-src"]);
show("other hardening headers", {
  nosniff: page.headers.get("x-content-type-options"),
  referrer: page.headers.get("referrer-policy"),
  cache: page.headers.get("cache-control"),
});

// Exact versions with integrity hashes: a changed byte fails to load.
const script = /<script src="([^"]+)" integrity="([^"]+)"/.exec(html);
show("pinned bundle", script?.[1]);
show("subresource integrity", script?.[2]);
show("the page points at this API's document", html.includes("openapi.json"));

show("its title carries through", documented.openapi().info);
show(
  "AsyncAPI viewer",
  (await uiAdapter.fetch("/ops/jobs/docs/asyncapi")).status,
);

/* ------------------------------------------------------------------ */
step("A pruned API documents less");

const readOnly = createJobsApi({
  jobs,
  basePath: "/read/jobs",
  authorize: () => true,
  readOnly: true,
  websocket: false,
});
show("readOnly routes", readOnly.routes.length);
show(
  "readOnly paths documented",
  Object.keys(readOnly.openapi().paths as object).length,
);
show(
  "mutating operations",
  readOnly.routes.filter((route) => route.mutation).length,
);
// No socket, so there is no AsyncAPI document to serve at all.
show("asyncapi() with no socket", String(readOnly.asyncapi()));

await Promise.all([api.close(), documented.close(), readOnly.close()]);
await jobs.purge();
await jobs.close();
show("closed");
