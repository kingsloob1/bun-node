/**
 * Serving and viewing — `docsRouter()` mounts the documents as JSON and,
 * only when `viewer` asks, pinned-CDN viewer pages.
 *
 * ```bash
 * bun 13-api-docs/serving-and-viewing.ts
 * ```
 *
 * The JSON is always served and costs nothing; the pages are off by default
 * because they load third-party script into an origin that may hold session
 * cookies, and "try it out" is a mutation console. `viewer.openapi` is a
 * viewer name (`"scalar"` — the default, `"swagger-ui"`, `"redoc"`,
 * `"rapidoc"`) or `{ name, ...options }`, the options passed through to the
 * viewer's own configuration; `viewer.asyncapi` is `"asyncapi"` (the default,
 * the official component) or `"scalar"` (upstream work-in-progress for
 * AsyncAPI). Every page carries a Content Security Policy naming only the
 * CDN's origin and one nonce'd inline initialiser.
 *
 * Every route docsRouter registers is `.describe({ hidden: true })`, so a
 * later `generateOpenApi` over the parent never documents the docs.
 */
import { BunRouter } from "@kingsleyweb/bun-common";
import type { OpenApiDocument } from "@kingsleyweb/bun-common/lib/docs";
import { docsRouter, generateOpenApi } from "@kingsleyweb/bun-common/lib/docs";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Serving and viewing (docsRouter)");

const app = new BunRouter();
app
  .get("/users", (_req, res) => res.json([{ id: "1", name: "ada" }]))
  .describe({ summary: "List users", responses: { 200: null } });

/* ------------------------------------------------------------------ */
step('app.use("/docs", docsRouter({ openapi: () => …document, viewer }))');

// The thunk is re-read per request, so the served document is always the
// router as it is now. `authorize` runs before every docs route — the
// playground's rule is shown here: allow (a real host decides from a
// session).
app.use(
  "/docs",
  docsRouter({
    openapi: (): OpenApiDocument =>
      generateOpenApi(app, { title: "Serving and viewing", version: "1.0.0" })
        .document,
    asyncapi: {
      asyncapi: "3.0.0",
      info: { title: "Serving and viewing events", version: "1.0.0" },
    },
    // The viewer pages opt in per document. Scalar is the OpenAPI default;
    // this shows the non-default form with a pass-through option.
    viewer: {
      openapi: { name: "swagger-ui", docExpansion: "list" },
      asyncapi: "asyncapi",
    },
    authorize: (_req, _res, next) => next(),
  }),
);

const document = (await (
  await app.fetch("/docs/openapi.json")
).json()) as OpenApiDocument;
checkEqual("the OpenAPI JSON is served", document.openapi, "3.1.2");
check(
  "and it is the live one (the routes document themselves)",
  "/users" in (document.paths as object),
);
const asyncapi = await app.fetch("/docs/asyncapi.json");
checkEqual("the AsyncAPI JSON is served", asyncapi.status, 200);

// The thunk is re-read per request: a route registered now appears in the
// next fetch, with no restart.
app
  .get("/later", (_req, res) => res.json({}))
  .describe({ summary: "Registered late", responses: { 200: null } });
const refetched = (await (
  await app.fetch("/docs/openapi.json")
).json()) as OpenApiDocument;
check(
  "a route registered after the first fetch is in the second",
  "/later" in (refetched.paths as object),
);

/* ------------------------------------------------------------------ */
step("the viewer pages (opt-in): 200 + CSP + the pinned assets");

const page = await app.fetch("/docs/");
checkEqual("the OpenAPI page is served", page.status, 200);
const csp = page.headers.get("content-security-policy") ?? "";
check("the CSP locks the page down", csp.includes("default-src 'none'"));
check(
  "…allows only the nonce'd initialiser and the pinned CDN for scripts",
  /script-src 'nonce-[\w+/]+={0,2}' https:\/\/cdn\.jsdelivr\.net/.test(csp),
);
check("…and keeps fetches on this origin", csp.includes("connect-src 'self'"));
const html = await page.text();
check(
  "the page loads the pinned Swagger UI bundle with its SRI hash",
  html.includes("swagger-ui-dist@5.34.0/swagger-ui-bundle.js") &&
    html.includes("integrity=") &&
    html.includes('crossorigin="anonymous"'),
);
check(
  "the pass-through option reached SwaggerUIBundle's config",
  html.includes('"docExpansion": "list",'),
);
check(
  "the page fetches the document under the mount (req.baseUrl)",
  html.includes('url: "\\/docs\\/openapi.json"'),
);

const eventsPage = await app.fetch("/docs/asyncapi");
checkEqual("the AsyncAPI page is served", eventsPage.status, 200);
check(
  "with the official AsyncAPI component",
  (await eventsPage.text()).includes("AsyncApiStandalone.render("),
);

/* ------------------------------------------------------------------ */
step("the docs routes never document themselves");

const paths = Object.keys(document.paths as object);
checkEqual("the document holds only the app's route", paths, ["/users"]);
for (const docs of [
  "/docs/openapi.json",
  "/docs/asyncapi.json",
  "/docs/",
  "/docs/asyncapi",
]) {
  check(`${docs} is absent`, !paths.includes(docs));
}

/* ------------------------------------------------------------------ */
step("the control: no `viewer`, no pages — the JSON is always there");

const quiet = new BunRouter();
quiet.use("/docs", docsRouter({ openapi: document }));
checkEqual(
  "the JSON is served without a viewer",
  (await quiet.fetch("/docs/openapi.json")).status,
  200,
);
checkEqual(
  "but the page is not (the default)",
  (await quiet.fetch("/docs/")).status,
  404,
);
checkEqual(
  "nor the AsyncAPI page",
  (await quiet.fetch("/docs/asyncapi")).status,
  404,
);

show("open a real server's /docs/ in a browser to see Swagger UI");
summary();
