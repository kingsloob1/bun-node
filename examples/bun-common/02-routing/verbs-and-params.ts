/**
 * Verbs and params — every verb method, `all`, `any`, `add`/`addRoute`, path
 * params in every form, regexp constraints, and the order competing routes run
 * in.
 *
 * ```bash
 * bun 02-routing/verbs-and-params.ts
 * ```
 *
 * - Everything here runs through `router.fetch()`: the real pipeline, no port.
 * - When several route handlers match, they run in **registration order** by
 *   default, exactly like Express. `routeSpecificity: true` (or a comparator)
 *   opts in to "most specific first"; middleware never moves either way.
 * - A route handler must respond or call `next()`. Only `next()` moves on — a
 *   handler's return value is ignored.
 * - `HEAD` runs a route's GET handler when the route has no HEAD handler of
 *   its own, as in Express: the served response carries the GET's status and
 *   headers (`Content-Length` included) and no body, and so does `fetch()`.
 *   Matching keeps registration order, so a HEAD handler registered first
 *   wins. `toFetchResponse()` is what `fetch()` applies to match the wire;
 *   the Bun behaviours behind it are in
 *   [docs/bun-bugs](../../../docs/bun-bugs/README.md).
 * - Param values are percent-decoded; `*name` publishes both `params.name`
 *   and the positional key `params[0]`.
 * - `query()` registers the HTTP `QUERY` method (Express 5's `app.query`): a
 *   safe request that carries a body. The body is parsed as for `POST`,
 *   `req.query` is still the URL's query string, and a `QUERY` route answers
 *   `QUERY` only — no `GET` or `HEAD` fallback either way.
 */
import type { RouterVerb, RouterVerbMethod } from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunRequest,
  BunResponse,
  BunRouter,
  FETCH_STUB_SERVER,
  markSocketFree,
  toFetchResponse,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Verbs and params");

/** Fetches `path` from `router` and answers `"<status> <body>"`. */
async function call(
  router: BunRouter,
  path: string,
  init?: RequestInit,
): Promise<string> {
  const response = await router.fetch(path, init);
  return `${response.status} ${await response.text()}`;
}

/* ------------------------------------------------------------------ */
step("The everyday verbs, over router.fetch()");

const api = new BunRouter();
api.get("/resource", (_req, res) => res.send("read it"));
api.post("/resource", (_req, res) => res.status(201).send("created it"));
api.put("/resource", (_req, res) => res.send("replaced it"));
api.patch("/resource", (_req, res) => res.send("patched it"));
api.delete("/resource", (_req, res) => res.send("deleted it"));
api.head("/resource", (_req, res) => {
  // A HEAD handler must still send() — setting a header alone never responds.
  res.setHeader("X-Exists", "yes");
  res.send("");
});
api.options("/resource", (_req, res) => {
  res.setHeader("Allow", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS");
  res.status(204).send("");
});

for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
  show(method, await call(api, "/resource", { method }));
}
const head = await api.fetch("/resource", { method: "HEAD" });
show("HEAD", `${head.status}, X-Exists: ${head.headers.get("X-Exists")}`);
show("a path nothing matches", await call(api, "/nowhere"));
show(
  "a method nothing matches",
  await call(api, "/resource", { method: "PURGE" }),
);

/* ------------------------------------------------------------------ */
step("Every verb method BunRouter has — including WebDAV's");

/** Each verb method's name, as registered on the router. */
const VERBS = [
  "checkout",
  "copy",
  "delete",
  "get",
  "head",
  "lock",
  "merge",
  "mkactivity",
  "mkcol",
  "move",
  "notify",
  "options",
  "patch",
  "post",
  "propfind",
  "proppatch",
  "purge",
  "put",
  "query",
  "report",
  "search",
  "subscribe",
  "trace",
  "unlock",
  "unsubscribe",
  "view",
] as const satisfies readonly RouterVerb[];

const webdav = new BunRouter();
for (const verb of VERBS) {
  // `webdav[verb]` is a union of overloaded methods, which cannot be called
  // directly — but it assigns, uncast, to the signature every verb shares.
  const register: RouterVerbMethod<BunRouter> = webdav[verb];
  register.call(webdav, "/doc", (_req, res) => {
    res.send(verb);
  });
}

// Matching needs no Request at all — and some of these methods (TRACE) are
// ones `new Request()` refuses to build.
/** How many of the routes on /doc each method matches. */
const matched = Object.fromEntries(
  VERBS.map((verb) => [
    verb,
    webdav.getMatchedLayers({
      requestHost: "localhost",
      requestMethod: verb.toUpperCase(),
      requestUrl: "/doc",
    }).length,
  ]),
);
show("routes registered", webdav.routes().length);
checkEqual(
  "each method matches only its own route — HEAD also matches GET's",
  matched,
  Object.fromEntries(VERBS.map((verb) => [verb, verb === "head" ? 2 : 1])),
);
show("PROPFIND /doc", await call(webdav, "/doc", { method: "PROPFIND" }));
checkEqual(
  "QUERY /doc reaches the query() route",
  await call(webdav, "/doc", { method: "QUERY" }),
  "200 query",
);

/* ------------------------------------------------------------------ */
step("QUERY — a safe request with a body");

// QUERY is a GET whose query does not fit in a URL: it is safe and
// idempotent, and its query travels in the body.
const search = new BunRouter();
search.query("/search/:index", (req, res) => {
  // `params` is typed from the path literal, as for every verb.
  const index: string = req.params.index;
  // @ts-expect-error — the path declares no `:page`.
  void req.params.page;
  res.json({
    method: req.method,
    index,
    body: req.body as unknown,
    query: req.query,
  });
});
search.get("/catalogue", (_req, res) => res.send("the GET route"));

const searched = await search.fetch("/search/books?limit=2", {
  method: "QUERY",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "dune", year: { gte: 1960 } }),
});
checkEqual(
  "QUERY /search/books?limit=2 with a JSON body",
  { status: searched.status, json: await searched.json() },
  {
    status: 200,
    json: {
      method: "QUERY",
      index: "books",
      body: { title: "dune", year: { gte: 1960 } },
      query: { limit: "2" },
    },
  },
);

// As for POST, a body with no Content-Type is read as a form, so say text.
const textual = await search.fetch("/search/notes", {
  method: "QUERY",
  headers: { "Content-Type": "text/plain" },
  body: "words near 'dune'",
});
checkEqual(
  "…a text body arrives as a string",
  ((await textual.json()) as { body: unknown }).body,
  "words near 'dune'",
);

// The router matches the method case-insensitively. fetch() cannot show that
// on Bun 1.4: its `Request` upper-cases a lowercase method it knows ("query"
// arrives as "QUERY", where the Fetch spec and Node keep "query"), and turns a
// mixed-case one into GET (oven-sh/bun#42497). So ask the matcher directly.
/** How many layers match `method` on /search/books. */
function layersFor(method: string): number {
  return search.getMatchedLayers({
    requestHost: "localhost",
    requestMethod: method,
    requestUrl: "/search/books",
  }).length;
}
checkEqual(
  "the matcher takes QUERY, query and Query alike",
  [layersFor("QUERY"), layersFor("query"), layersFor("Query")],
  [1, 1, 1],
);
checkEqual(
  'fetch() with method: "query" reaches the route',
  (
    await search.fetch("/search/books", {
      method: "query",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    })
  ).status,
  200,
);
show(
  'new Request() with method: "Query" — the method Bun keeps (#42497)',
  new Request("http://localhost/", { method: "Query" }).method,
);

/** The status `method` on `path` answers with. */
async function statusOf(path: string, method: string): Promise<number> {
  return (await search.fetch(path, { method })).status;
}
checkEqual(
  "GET, HEAD and POST on the QUERY route are 404",
  {
    GET: await statusOf("/search/books", "GET"),
    HEAD: await statusOf("/search/books", "HEAD"),
    POST: await statusOf("/search/books", "POST"),
  },
  { GET: 404, HEAD: 404, POST: 404 },
);
checkEqual(
  "QUERY on a GET-only route is 404 — no fallback that way either",
  await statusOf("/catalogue", "QUERY"),
  404,
);
check(
  "…while HEAD on the GET route is still answered",
  (await statusOf("/catalogue", "HEAD")) === 200,
);

/* ------------------------------------------------------------------ */
step("all(), any(), add() and addRoute()");

const flexible = new BunRouter();
flexible.all("/ping", (req, res) => res.send(`all() answered ${req.method}`));
flexible.any(
  ["GET", "POST"],
  "/either",
  (req: BunRequest, res: BunResponse) => {
    res.send(`any() answered ${req.method}`);
  },
);
flexible.add("patch", "/added", (_req, res) => {
  res.send("add() — method given as a string");
});
flexible.addRoute("put", "/added", (_req, res) => {
  res.send("addRoute() — the same, lower level");
});

show("DELETE /ping", await call(flexible, "/ping", { method: "DELETE" }));
show("POST /either", await call(flexible, "/either", { method: "POST" }));
show("PUT /either", await call(flexible, "/either", { method: "PUT" }));
show("PATCH /added", await call(flexible, "/added", { method: "PATCH" }));
show("PUT /added", await call(flexible, "/added", { method: "PUT" }));

/* ------------------------------------------------------------------ */
step("Params: required, optional, constrained, wildcards");

const paths = new BunRouter();
paths.get("/users/:id", (req, res) => {
  res.json({ route: "/users/:id", params: req.params });
});
paths.get("/search/:category/:page?", (req, res) => {
  // `page` is typed `string | undefined` — the `?` reaches the type.
  res.json({ route: "/search/:category/:page?", params: req.params });
});
paths.get("/orders/:id(\\d+)", (req, res) => {
  res.json({ route: "/orders/:id(\\d+)", params: req.params });
});
paths.get("/orders/:slug", (req, res) => {
  res.json({ route: "/orders/:slug", params: req.params });
});
paths.get("/assets/*file", (req, res) => {
  res.json({ route: "/assets/*file", params: req.params });
});
paths.get("/docs/{*page}", (req, res) => {
  res.json({ route: "/docs/{*page}", params: req.params });
});
paths.get("/raw/*", (req, res) => {
  res.json({ route: "/raw/*", params: req.params });
});
paths.get("/reports(/archived)?", (req, res) => {
  res.json({ route: "/reports(/archived)?", path: req.path });
});

for (const path of [
  "/users/42",
  "/users/ada%20lovelace",
  "/search/books",
  "/search/books/2",
  "/orders/1001",
  "/orders/latest",
  "/assets/css/site/app.css",
  "/docs/guide/routing",
  "/raw/a/b",
  "/reports",
  "/reports/archived",
  "/USERS/7",
]) {
  const response = await paths.fetch(path);
  show(path, await response.json());
}
show("note", "paths match case-insensitively: /USERS/7 reached /users/:id");

/* ------------------------------------------------------------------ */
step("Which route runs when several match");

/** Registers a param route first, then a static one that also matches /users/me. */
function competing(router: BunRouter): BunRouter {
  router.get("/users/:id", (_req, res) => res.send("the param route"));
  router.get("/users/me", (_req, res) => res.send("the static route"));
  return router;
}

show(
  "default — registration order",
  await call(competing(new BunRouter()), "/users/me"),
);
show(
  "routeSpecificity: true — static beats param",
  await call(competing(new BunRouter({ routeSpecificity: true })), "/users/me"),
);

// A comparator decides for itself; it is applied with a stable sort, so routes
// it rates equal keep their registration order. This one prefers longer paths.
const byLength = competing(
  new BunRouter({
    routeSpecificity: (a, b) =>
      String(b.route.path).length - String(a.route.path).length,
  }),
);
show("a comparator — longest path first", await call(byLength, "/users/me"));

const switched = competing(new BunRouter());
show("before setRouteSpecificity(true)", await call(switched, "/users/me"));
switched.setRouteSpecificity(true);
show(
  "after — it also drops the route cache",
  await call(switched, "/users/me"),
);

// Several handlers on one route run left to right, each passing on with next().
const chained = new BunRouter();
chained.get(
  "/steps",
  (_req, res, next) => {
    res.setHeader("X-Step-1", "done");
    next();
  },
  (_req, res) => res.send("second callback responded"),
);
const steps = await chained.fetch("/steps");
show(
  "GET /steps",
  `${await steps.text()}, X-Step-1: ${steps.headers.get("X-Step-1")}`,
);

/* ------------------------------------------------------------------ */
step("HEAD runs the GET handler, without the body");

const pages = new BunHttpAdapter(0);
let getRuns = 0;
pages.get("/page", (_req, res) => {
  getRuns++;
  res.set("X-Page", "1").send("the page body");
});
// A HEAD handler registered ahead of the GET route takes HEAD itself.
pages.head("/report", (_req, res) => {
  res.set("X-Which", "head").end();
});
pages.get("/report", (_req, res) => {
  res.set("X-Which", "get").send("the report");
});
pages.post("/form", (_req, res) => res.send("posted"));

await pages.listen(0);
const servedHead = await fetch(`${pages.url}/page`, { method: "HEAD" });
const servedHeadSummary = {
  status: servedHead.status,
  page: servedHead.headers.get("X-Page"),
  length: servedHead.headers.get("Content-Length"),
  body: await servedHead.text(),
};
show("served HEAD /page", servedHeadSummary);
checkEqual(
  "served HEAD /page: the GET's headers, the length, no body",
  servedHeadSummary,
  {
    status: 200,
    page: "1",
    length: String("the page body".length),
    body: "",
  },
);
await pages.close();

const fetchedHead = await pages.fetch("/page", { method: "HEAD" });
checkEqual(
  "adapter.fetch() HEAD /page: no body either",
  {
    status: fetchedHead.status,
    page: fetchedHead.headers.get("X-Page"),
    body: await fetchedHead.text(),
  },
  { status: 200, page: "1", body: "" },
);
checkEqual("…the GET handler ran for each", getRuns, 2);
checkEqual(
  "HEAD /report: the HEAD handler registered first wins",
  (await pages.fetch("/report", { method: "HEAD" })).headers.get("X-Which"),
  "head",
);
checkEqual(
  "…GET /report still gets the GET handler",
  await (await pages.fetch("/report")).text(),
  "the report",
);
checkEqual(
  "HEAD on a POST-only route is still a 404",
  (await pages.fetch("/form", { method: "HEAD" })).status,
  404,
);

// What fetch() does to a handler's Response, exported for a fetch() of your
// own: `toFetchResponse(response, method)` answers as a served request's
// client sees it — no body for HEAD, and the Content-Type Bun writes on the
// wire for a text body sent without headers (see docs/bun-bugs/README.md:
// `new Response(string).headers` has none until Bun serves it).
const full = new Response("a body", { headers: { "X-Kept": "yes" } });
const headless = toFetchResponse(full, "HEAD");
checkEqual(
  "toFetchResponse(response, 'HEAD') keeps the headers, drops the body",
  { kept: headless.headers.get("X-Kept"), body: await headless.text() },
  { kept: "yes", body: "" },
);
checkEqual(
  "…and returns a GET response as it is",
  toFetchResponse(full, "GET") === full,
  true,
);
// markSocketFree() tells the response it is answered without a socket, so
// it records what toFetchResponse() needs — what fetch() does for you.
const textRequest = BunRequest.init(
  markSocketFree(new Request("http://localhost/")),
  FETCH_STUB_SERVER,
  { parseBody: true },
) as BunRequest;
const textResponse = new BunResponse(textRequest);
textResponse.send("plain text, no headers set");
const bare = await textResponse.getNativeResponse(0);
checkEqual(
  "send(text) with no header set: the Response has no Content-Type yet",
  bare.headers.has("Content-Type"),
  false,
);
checkEqual(
  "…toFetchResponse() adds the one Bun writes on the wire",
  toFetchResponse(bare, "GET").headers.get("Content-Type"),
  "text/plain;charset=utf-8",
);

summary();
