/**
 * The route cache and the lower-level routing surface — `routeCacheMax`,
 * `getMatchedLayers`, `getCacheKey`, `clearRouteCache`, named routes, and the
 * exports underneath: `RouteClass`, `RouteConstructorOption`, `routeModulePath`,
 * `toNativeRequest`, `matchedRoute` and `CachedRouteMatch`.
 *
 * ```bash
 * bun 02-routing/route-cache.ts
 * ```
 *
 * - The router caches the matched pipeline per host + path + method (the query
 *   string is not part of the key). A hit is the *same array*, with no
 *   allocation — treat it as read-only.
 * - The key is the resolved path, so `/users/1` and `/users/2` are two
 *   entries. Size `routeCacheMax` above the distinct paths in flight, or set
 *   `0`: a cap between the two means every request misses *and* evicts.
 * - Registering a route drops the whole cache, so late routes are never
 *   hidden by a stale entry.
 * - A miss is cheap even on a large table: the router keeps a candidate
 *   index (routes bucketed by their static first segment), so a 1,000-route
 *   table with high-cardinality ids routes correctly with a tiny cache or
 *   none, in registration order. Eviction is O(1) FIFO.
 * - A layer's `routeIndex` is its route's position in `routes()`.
 * - `toNativeRequest("//x/y")` keeps `//x/y` as the path, as a served
 *   request has it (`//` used to be read as a host, and threw).
 * - Name a route with `setRoute({ name })`; `route(name, params)` builds its
 *   URL back.
 */
import type {
  CachedRouteMatch,
  matchedRoute,
  RouteConstructorOption,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import {
  BunRouter,
  DEFAULT_ROUTE_CACHE_MAX,
  RouteClass,
  routeModulePath,
  toNativeRequest,
} from "@kingsleyweb/bun-common";
import { checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("The route cache and routing internals");

/** Resolves the pipeline `router` would run for `GET <path>` on localhost. */
function layers(router: BunRouter, path: string, method = "GET") {
  return router.getMatchedLayers({
    requestHost: "localhost",
    requestMethod: method,
    requestUrl: path,
  });
}

/* ------------------------------------------------------------------ */
step("What a request resolves to");

const router = new BunRouter();
router.use((_req, _res, next) => next());
router.get(
  "/users/:id",
  (_req, _res, next) => next(),
  (_req, res) => res.send("user"),
);

for (const layer of layers(router, "/users/42?tab=posts")) {
  show(`route ${layer.routeIndex}, callback ${layer.callbackIndex}`, {
    isRouteHandler: layer.isRouteHandler,
    isErrorHandler: layer.isErrorHandler,
    routerId: layer.routerId,
    params: layer.matched.params,
  });
}

// `matchedRoute` is the match record every layer carries.
const match: matchedRoute = layers(router, "/users/42")[1]!.matched;
show("matchedRoute", {
  path: match.path,
  method: match.method,
  params: match.params,
});

/* ------------------------------------------------------------------ */
step("Cache hits, keys and invalidation");

show("DEFAULT_ROUTE_CACHE_MAX", DEFAULT_ROUTE_CACHE_MAX);
show(
  "getCacheKey — the query string is dropped",
  router.getCacheKey({
    requestHost: "localhost",
    requestMethod: "GET",
    requestUrl: "/users/42?tab=posts",
  }),
);

const first = layers(router, "/users/42");
show(
  "a repeat lookup is the same array",
  layers(router, "/users/42?other=query") === first,
);

router.get("/users/:id/avatar", (_req, res) => res.send("avatar"));
show(
  "registering any route drops the cache",
  layers(router, "/users/42") !== first,
);

const cached = layers(router, "/users/42");
router.clearRouteCache();
show(
  "clearRouteCache() drops it on demand",
  layers(router, "/users/42") !== cached,
);

/* ------------------------------------------------------------------ */
step("routeCacheMax: FIFO eviction, or off");

const tiny = new BunRouter({ routeCacheMax: 2 });
tiny.get("/items/:id", (_req, res) => res.send("item"));
const one = layers(tiny, "/items/1");
layers(tiny, "/items/2");
show("two entries: /items/1 is still cached", layers(tiny, "/items/1") === one);
layers(tiny, "/items/3");
show(
  "a third evicts the oldest: /items/1 is rebuilt",
  layers(tiny, "/items/1") !== one,
);

const uncached = new BunRouter({ routeCacheMax: 0 });
uncached.get("/items/:id", (_req, res) => res.send("item"));
const a = layers(uncached, "/items/1");
const b = layers(uncached, "/items/1");
show(
  "routeCacheMax: 0 — rebuilt every time, but equal",
  a !== b && Bun.deepEquals(a, b),
);

const fallback = new BunRouter({ routeCacheMax: -1 });
fallback.get("/items/:id", (_req, res) => res.send("item"));
const fallbackFirst = layers(fallback, "/x");
const fallbackSecond = layers(fallback, "/x");
show(
  "a negative cap falls back to the default (cached)",
  fallbackFirst === fallbackSecond,
);

/* ------------------------------------------------------------------ */
step("Named routes: setRoute(), getRouteByName() and route()");

const named = new BunRouter();
const sendInvoice: RouterHandler = (_req, res) => res.send("invoice");
const invoiceRoute: RouteConstructorOption = {
  name: "invoice",
  method: "GET",
  path: "/accounts/:account/invoices/:number",
  callbacks: [sendInvoice],
};
named.setRoute(invoiceRoute);

show("getRouteByName('invoice').path", named.getRouteByName("invoice")?.path);
show(
  "route('invoice', params) builds the URL",
  named.route("invoice", { account: "acme", number: 7 }),
);
show("an unknown name", named.getRouteByName("nope") ?? "undefined");
try {
  named.setRoute({ ...invoiceRoute, path: "/elsewhere" });
} catch (error) {
  show("names are unique", (error as Error).message);
}
// setRoute() with a method is a match-by-method route, but not a *route
// handler*: only verb methods, all() and any() mark one.
show(
  "setRoute() layers count as middleware for ordering",
  layers(named, "/accounts/acme/invoices/7")[0]?.isRouteHandler,
);

/* ------------------------------------------------------------------ */
step("RouteClass and routeModulePath: the route object underneath");

show("routeModulePath", routeModulePath.split("node_modules/").at(-1));
const route = new RouteClass({
  path: "/reports/:year(\\d{4})",
  method: ["GET", "HEAD"],
  callbacks: [() => undefined],
});
show("compiled params", route.params);
show(
  "pathRegexp matches /reports/2024",
  route.pathRegexp.test("/reports/2024"),
);
show("…but not /reports/24", route.pathRegexp.test("/reports/24"));
show(
  "match()",
  route.match({ host: "localhost", method: "HEAD", path: "/reports/2024" }),
);

// A cache of your own — say, a precomputed table for a hot path — can store
// what a match needs to run with this shape.
const entry: CachedRouteMatch = { route, callbacks: route.callbacks };
show("CachedRouteMatch callbacks", entry.callbacks.length);

/* ------------------------------------------------------------------ */
step("toNativeRequest(): what fetch() builds from its input");

show("a path", toNativeRequest("/users/1").url);
show(
  "a path, another origin",
  toNativeRequest("/users/1", undefined, "http://api.example.test").url,
);
const posted = toNativeRequest({ url: "/users", method: "POST", body: "{}" });
show("an object with a url", `${posted.method} ${posted.url}`);
checkEqual(
  "a path starting with // is a path, not a host",
  toNativeRequest("//x/y").url,
  "http://localhost//x/y",
);
checkEqual(
  "…including a bare //",
  toNativeRequest("//").url,
  "http://localhost//",
);
checkEqual(
  "…dot segments still resolve",
  toNativeRequest("//a/../b").url,
  "http://localhost//b",
);
const original = new Request("http://localhost/as-is");
show(
  "a Request is returned untouched",
  toNativeRequest(original, { method: "DELETE" }) === original,
);

/* ------------------------------------------------------------------ */
step("A large route table: 1,000 routes, high-cardinality ids");

/** Registers `/r0/:id` … `/r999/:id`, each answering its own name and id. */
function bigTable(router: BunRouter): BunRouter {
  for (let i = 0; i < 1000; i++) {
    router.get(`/r${i}/:id`, (req, res) => res.send(`r${i}:${req.params.id}`));
  }
  // Registered after /r5/:id, so — registration order — it never runs.
  router.get("/r5/special", (_req, res) => res.send("never reached"));
  // A param in the first segment: a candidate for every path.
  router.get("/:section/x/:id", (req, res) => {
    res.send(`late ${req.params.section} ${req.params.id}`);
  });
  return router;
}

for (const routeCacheMax of [16, 0]) {
  const big = bigTable(new BunRouter({ routeCacheMax }));
  let correct = 0;
  const requests = 3000;
  const from = performance.now();
  for (let k = 0; k < requests; k++) {
    // Every id is new, so nearly every lookup is a cache miss.
    const i = (k * 7919) % 1000;
    const id = crypto.randomUUID();
    const response = await big.fetch(`/r${i}/${id}`);
    if ((await response.text()) === `r${i}:${id}`) {
      correct++;
    }
  }
  show(
    `routeCacheMax: ${routeCacheMax} — ${requests} unique paths`,
    `${(performance.now() - from).toFixed(0)}ms`,
  );
  checkEqual(
    `routeCacheMax: ${routeCacheMax} — every one routed right`,
    correct,
    requests,
  );
  checkEqual(
    `routeCacheMax: ${routeCacheMax} — /r5/special: the earlier /r5/:id wins`,
    await (await big.fetch("/r5/special")).text(),
    "r5:special",
  );
  checkEqual(
    `routeCacheMax: ${routeCacheMax} — a first-segment param route still matches`,
    await (await big.fetch("/r12/x/9")).text(),
    "late r12 9",
  );
}

const indexed = bigTable(new BunRouter());
const last = layers(indexed, "/r999/abc");
checkEqual("one layer for /r999/abc", last.length, 1);
checkEqual(
  "routeIndex is the route's position in routes()",
  last[0]!.routeIndex,
  999,
);
checkEqual(
  "…so routes()[routeIndex] is the route that matched",
  indexed.routes()[last[0]!.routeIndex]!.path,
  "/r999/:id",
);

/* ------------------------------------------------------------------ */
step("One cache entry per path, one answer per method; requestPath");

const verbs = new BunRouter({ routeCacheMax: 4 });
verbs.get("/items/:id", (req, res) => res.send(`GET ${req.params.id}`));
verbs.post("/items/:id", (req, res) => res.send(`POST ${req.params.id}`));
const answers: string[] = [];
for (const method of ["GET", "POST", "GET", "POST", "DELETE"]) {
  const response = await verbs.fetch("/items/7", { method });
  answers.push(`${response.status} ${await response.text()}`);
}
checkEqual(
  "GET and POST on one path, alternating: each routed to its own handler",
  answers,
  ["200 GET 7", "200 POST 7", "200 GET 7", "200 POST 7", "404 "],
);
// The adapters pass the path they already split as `requestPath`; the
// router then matches it rather than splitting `requestUrl` again.
checkEqual(
  "getMatchedLayers({ …, requestPath }): matched on the path given",
  verbs
    .getMatchedLayers({
      requestHost: "localhost",
      requestMethod: "POST",
      requestUrl: "/items/9?expand=true",
      requestPath: "/items/9",
    })
    .map((layer) => [layer.routeIndex, layer.matched.params]),
  [[1, { id: "9" }]],
);

summary();
