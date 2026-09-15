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
 * - Param values are percent-decoded; `*name` publishes both `params.name`
 *   and the positional key `params[0]`.
 */
import type {
  BunRequest,
  BunResponse,
  RouterVerb,
  RouterVerbMethod,
} from "@kingsleyweb/bun-common";
import { BunRouter } from "@kingsleyweb/bun-common";
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
const matched = VERBS.filter((verb) => {
  return (
    webdav.getMatchedLayers({
      requestHost: "localhost",
      requestMethod: verb.toUpperCase(),
      requestUrl: "/doc",
    }).length === 1
  );
});
show(
  `routes registered: ${webdav.routes().length}, each matching only its own method`,
  matched.length,
);
show("PROPFIND /doc", await call(webdav, "/doc", { method: "PROPFIND" }));

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
