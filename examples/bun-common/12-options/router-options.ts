/**
 * Option tour: every `BunRouter` constructor option and every public
 * `BunRouter` method, each asserted.
 *
 * ```bash
 * bun 12-options/router-options.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - `routeSpecificity` defaults to `false`: competing route handlers run in
 *   registration order, like Express. Middleware never moves either way.
 * - `routeCacheMax: 0` disables the cache; a negative value falls back to
 *   `DEFAULT_ROUTE_CACHE_MAX`.
 * - `debug` logs one `debug` record per pipeline layer, so it needs a logger
 *   whose level admits `debug` — the default console logger's is `info`.
 * - `host` scopes every route to that host (a pattern such as
 *   `:tenant.example.test` works too); a literal one is also the origin
 *   `fetch()` resolves a bare path against.
 * - `caseSensitive` covers every route, `use()` prefixes included.
 * - `group()`/`domain()` take a router, a `(router) => …` callback, or
 *   middleware. A single function declaring at most one parameter is the
 *   callback form; anything else is middleware.
 * - Only verb methods, `all()` and `any()` register *route handlers*; `use()`,
 *   `useMethod()` and a bare `setRoute()` register middleware, which is never
 *   reordered and never binds `req.params`.
 */
import type {
  JsonValue,
  LogEvent,
  RouterErrorMiddlewareHandler,
  RouterHandler,
  RouterVerbMethod,
} from "@kingsleyweb/bun-common";
import {
  BunRequest,
  BunResponse,
  BunRouter,
  BunWebSocket,
  createTestLogger,
  DEFAULT_ROUTE_CACHE_MAX,
  FETCH_STUB_SERVER,
  isLogger,
  RouteClass,
  routeModulePath,
  toNativeRequest,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title, waitFor } from "../shared/console";

title("Option tour: BunRouter options and every BunRouter method");

/** Fetches `path` and answers `"<status> <body>"`. */
async function text(
  router: BunRouter,
  path: string,
  init?: RequestInit,
): Promise<string> {
  const response = await router.fetch(path, init);
  return `${response.status} ${await response.text()}`;
}

/** The pipeline `router` resolves for `method path` on `host`. */
function layers(
  router: BunRouter,
  path: string,
  method = "GET",
  host = "localhost",
) {
  return router.getMatchedLayers({
    requestHost: host,
    requestMethod: method,
    requestUrl: path,
  });
}

/** Waits for `predicate`, answering whether it came true in time. */
async function eventually(predicate: () => boolean): Promise<boolean> {
  try {
    await waitFor("a condition", predicate, { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** A handler that answers with `body`. */
function says(body: string): RouterHandler {
  return (_req, res) => res.send(body);
}

/* ------------------------------------------------------------------ */
step("Defaults");

const plain = new BunRouter();
check("logger defaults to a structured Logger", isLogger(plain.logger));
checkEqual("…at level info", plain.logger.level, "info");
checkEqual(
  "getBunWebsocket() is undefined without one",
  plain.getBunWebsocket(),
  undefined,
);
plain.get("/users/:id", says("param"));
plain.get("/users/me", says("static"));
checkEqual(
  "routeSpecificity defaults to registration order",
  await text(plain, "/users/me"),
  "200 param",
);
const plainFirst = layers(plain, "/users/me");
const plainSecond = layers(plain, "/users/me");
check("the route cache is on by default", plainFirst === plainSecond);
checkEqual("DEFAULT_ROUTE_CACHE_MAX", DEFAULT_ROUTE_CACHE_MAX, 50_000);

/* ------------------------------------------------------------------ */
step("logger: any LoggerLike, and setLogger() / the logger setter");

const { logger, events } = createTestLogger();
const logged = new BunRouter({ logger });
checkEqual("a Logger is used as it is", logged.logger, logger);

const lines: unknown[][] = [];
const consoleLike = {
  log: (...args: unknown[]) => lines.push(args),
  error: () => undefined,
  warn: () => undefined,
};
checkEqual(
  "setLogger() returns the router",
  logged.setLogger(consoleLike),
  logged,
);
check(
  "…and adapts a console-like logger into a Logger",
  isLogger(logged.logger),
);
logged.logger.info("hello", { requestId: "r1" });
checkEqual("…whose records reach it", lines.at(-1)?.[1], { requestId: "r1" });
logged.logger = logger;
checkEqual("the logger setter replaces it too", logged.logger, logger);

/* ------------------------------------------------------------------ */
step("debug: a debug record for every layer run");

const traced = new BunRouter({ debug: true, logger });
traced.use((_req, _res, next) => next());
traced.get("/x", says("x"));
traced.get("/boom", () => {
  throw new Error("boom");
});
traced.use(((_error, _req, res, _next) => {
  res.status(500).send("handled");
}) satisfies RouterErrorMiddlewareHandler);

/** The `state` of each pipeline record since `mark`. */
function statesSince(mark: number): unknown[] {
  return events
    .slice(mark)
    .filter((event: LogEvent) => event.message === "pipeline layer executed")
    .map((event: LogEvent) => event.fields?.state);
}

let mark = events.length;
await traced.fetch("/x");
checkEqual("one record per layer, naming its kind", statesSince(mark), [
  "middleware",
  "route_handler",
]);
checkEqual("…at level debug", events.at(-1)?.level, "debug");
mark = events.length;
await traced.fetch("/boom");
checkEqual("error handlers are recorded too", statesSince(mark), [
  "middleware",
  "route_handler",
  "error_handler",
]);

const quiet = new BunRouter({ logger });
quiet.get("/x", says("x"));
mark = events.length;
await quiet.fetch("/x");
checkEqual("without debug, nothing is logged", statesSince(mark), []);

/* ------------------------------------------------------------------ */
step("routeCacheMax");

const one = new BunRouter({ routeCacheMax: 1 });
one.get("/a", says("a"));
one.get("/b", says("b"));
const a1 = layers(one, "/a");
check("a hit is the same array", layers(one, "/a") === a1);
layers(one, "/b");
const a2 = layers(one, "/a");
check("a second signature evicts the first (FIFO)", a2 !== a1);
checkEqual("…which is rebuilt equal", a2, a1);

const off = new BunRouter({ routeCacheMax: 0 });
off.get("/a", says("a"));
const off1 = layers(off, "/a");
const off2 = layers(off, "/a");
check("0 disables the cache", off1 !== off2);
checkEqual("…and still matches", off2.length, 1);
checkEqual("…and still routes", await text(off, "/a"), "200 a");

const negative = new BunRouter({ routeCacheMax: -5 });
negative.get("/a", says("a"));
const negativeFirst = layers(negative, "/a");
const negativeSecond = layers(negative, "/a");
check(
  "a negative value falls back to the default cap",
  negativeFirst === negativeSecond,
);

/* ------------------------------------------------------------------ */
step("routeSpecificity, and setRouteSpecificity()");

/** Registers a param route before a static one that also matches /p/exact. */
function competing(router: BunRouter): BunRouter {
  router.get("/p/:id", says("param"));
  router.use((_req, _res, next) => next());
  router.get("/p/exact", says("static"));
  return router;
}

checkEqual(
  "true: static beats param",
  await text(competing(new BunRouter({ routeSpecificity: true })), "/p/exact"),
  "200 static",
);
checkEqual(
  "false: registration order",
  await text(competing(new BunRouter({ routeSpecificity: false })), "/p/exact"),
  "200 param",
);

const reversed = new BunRouter({
  routeSpecificity: (x, y) =>
    Number(String(y.route.path).includes(":")) -
    Number(String(x.route.path).includes(":")),
});
reversed.get("/p/exact", says("static"));
reversed.get("/p/:id", says("param"));
checkEqual(
  "a comparator decides the order",
  await text(reversed, "/p/exact"),
  "200 param",
);

const specificLayers = layers(
  competing(new BunRouter({ routeSpecificity: true })),
  "/p/exact",
);
checkEqual(
  "middleware keeps its slot while route handlers are reordered",
  specificLayers.map((layer) =>
    layer.isRouteHandler ? String(layer.matched.path) : "use",
  ),
  ["/p/exact", "use", "/p/:id"],
);

const toggled = competing(new BunRouter());
checkEqual(
  "before setRouteSpecificity(true)",
  await text(toggled, "/p/exact"),
  "200 param",
);
checkEqual(
  "setRouteSpecificity() returns the router",
  toggled.setRouteSpecificity(true),
  toggled,
);
checkEqual(
  "…and takes effect at once, despite the cache",
  await text(toggled, "/p/exact"),
  "200 static",
);

/* ------------------------------------------------------------------ */
step("host and caseSensitive");

const hosted = new BunRouter({ host: "api.example.test" });
hosted.get("/where", (req, res) => res.send(req.hostname));
checkEqual(
  "host is the origin fetch() resolves a bare path against",
  await text(hosted, "/where"),
  "200 api.example.test",
);
checkEqual(
  "…and scopes its routes to that host",
  (await hosted.fetch(new Request("http://other.example.test/where"))).status,
  404,
);

const sensitive = new BunRouter({ caseSensitive: true });
sensitive.get("/Users", says("matched"));
checkEqual(
  "caseSensitive: true refuses a differently-cased path",
  (await sensitive.fetch("/users")).status,
  404,
);
const insensitive = new BunRouter();
insensitive.get("/Users", says("matched"));
checkEqual(
  "by default, matching ignores case",
  await text(insensitive, "/users"),
  "200 matched",
);

// As Express 5's `Router({ caseSensitive })`: one setting for routes and
// `use()` prefixes alike, and `req.baseUrl` keeps the request's spelling.
const prefixed = new BunRouter();
prefixed.use("/Admin", (req, res) => res.send(`prefix ${req.baseUrl}`));
checkEqual(
  "…use() prefixes included",
  await text(prefixed, "/admin/settings"),
  "200 prefix /admin",
);
const mountedChild = new BunRouter();
mountedChild.use((req, res) => res.send(`child ${req.baseUrl}`));
const mounting = new BunRouter();
mounting.use("/Api", mountedChild);
checkEqual(
  "…and a mounted router's middleware",
  await text(mounting, "/api/x"),
  "200 child /api",
);
const sensitivePrefix = new BunRouter({ caseSensitive: true });
sensitivePrefix.use("/Admin", says("prefix"));
checkEqual(
  "caseSensitive: true refuses a differently-cased prefix",
  (await sensitivePrefix.fetch("/admin/settings")).status,
  404,
);
checkEqual(
  "…and still takes the declared spelling",
  await text(sensitivePrefix, "/Admin/settings"),
  "200 prefix",
);

const tenanted = new BunRouter({ host: ":tenant.example.test" });
tenanted.get("/who", (req, res) => res.json(req.params));
checkEqual(
  "a host pattern's captures land in req.params",
  await (
    await tenanted.fetch(new Request("http://acme.example.test/who"))
  ).json(),
  { tenant: "acme" },
);

/* ------------------------------------------------------------------ */
step("bunWebsocket, setBunWebSocket(), getBunWebsocket() and ws()");

const socketRoutes = new BunRouter();
const socket = new BunWebSocket({
  newInstance: false,
  router: socketRoutes,
  getServer: () => undefined,
});
const withSocket = new BunRouter({ bunWebsocket: socket });
checkEqual(
  "getBunWebsocket() answers the option",
  withSocket.getBunWebsocket(),
  socket,
);

const other = new BunWebSocket({
  newInstance: false,
  router: socketRoutes,
  getServer: () => undefined,
});
withSocket.setBunWebSocket(other);
checkEqual(
  "setBunWebSocket() takes precedence",
  withSocket.getBunWebsocket(),
  other,
);

checkEqual(
  "ws() returns the router",
  withSocket.ws("/chat", { message: () => undefined }),
  withSocket,
);
check(
  "…and registers the upgrade route on the socket's router",
  await eventually(() => socketRoutes.routes().length > 0),
);
await checkRejects(
  "ws() without a socket throws, rather than registering nothing",
  () => plain.ws("/chat", { message: () => undefined }),
  { message: /no BunWebSocket is attached/ },
);

/* ------------------------------------------------------------------ */
step("Every verb method");

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
] as const;

const verbs = new BunRouter();
for (const verb of VERBS) {
  // A verb picked at runtime: the overloaded union assigns, uncast, to the
  // untyped signature every verb shares.
  const method: RouterVerbMethod<BunRouter> = verbs[verb];
  checkEqual(
    `${verb}() returns the router`,
    method.call(verbs, "/r", says(verb)),
    verbs,
  );
}
checkEqual("one route per verb", verbs.routes().length, VERBS.length);
checkEqual(
  "each matches its own method only, as a route handler",
  VERBS.map((verb) =>
    layers(verbs, "/r", verb.toUpperCase()).map(
      (layer) => layer.isRouteHandler,
    ),
  ),
  VERBS.map(() => [true]),
);
checkEqual(
  "PROPPATCH /r",
  await text(verbs, "/r", { method: "PROPPATCH" }),
  "200 proppatch",
);

const noPath = new BunRouter();
noPath.get(says("pathless get"));
checkEqual(
  "a verb with no path matches every path",
  await text(noPath, "/anything/at/all"),
  "200 pathless get",
);

/* ------------------------------------------------------------------ */
step("all(), any(), add() and addRoute()");

const methods = new BunRouter();
checkEqual(
  "all() returns the router",
  methods.all("/all", (req, res) => res.send(req.method)),
  methods,
);
methods.any(["GET", "POST"], "/any", (req: BunRequest, res: BunResponse) => {
  res.send(req.method);
});
methods.any("DELETE", "/any-one", says("delete only"));
methods.add("patch", "/add", says("add"));
methods.addRoute("put", "/add-route", says("addRoute"));

checkEqual(
  "all() matches any method",
  await text(methods, "/all", { method: "DELETE" }),
  "200 DELETE",
);
check(
  "…as a route handler",
  layers(methods, "/all", "PUT")[0]?.isRouteHandler === true,
);
checkEqual(
  "any([...]) matches the listed methods",
  await text(methods, "/any", { method: "POST" }),
  "200 POST",
);
checkEqual(
  "…and no others",
  (await methods.fetch("/any", { method: "PUT" })).status,
  404,
);
checkEqual(
  "any(method) with one method",
  await text(methods, "/any-one", { method: "DELETE" }),
  "200 delete only",
);
checkEqual(
  "add(method, path) — method is case-insensitive",
  await text(methods, "/add", { method: "PATCH" }),
  "200 add",
);
checkEqual(
  "addRoute(method, path)",
  await text(methods, "/add-route", { method: "PUT" }),
  "200 addRoute",
);

/* ------------------------------------------------------------------ */
step("Params");

const params = new BunRouter();
params.get("/u/:id/:tab?", (req, res) => res.json({ params: req.params }));
params.get("/n/:id(\\d+)", (req, res) => res.json({ params: req.params }));
params.get("/w/*rest", (req, res) => res.json({ params: req.params }));
params.get("/b/{*rest}", (req, res) => res.json({ params: req.params }));
params.get("/s/*", (req, res) => res.json({ params: req.params }));

/** The params `path` produced. */
async function paramsOf(
  path: string,
): Promise<Record<string, string> | number> {
  const response = await params.fetch(path);
  return response.status === 200
    ? ((await response.json()) as { params: Record<string, string> }).params
    : response.status;
}

checkEqual("required", await paramsOf("/u/7"), { id: "7" });
checkEqual("optional, present", await paramsOf("/u/7/posts"), {
  id: "7",
  tab: "posts",
});
checkEqual("percent-decoded", await paramsOf("/u/ada%20lovelace"), {
  id: "ada lovelace",
});
checkEqual("a regexp constraint that matches", await paramsOf("/n/42"), {
  id: "42",
});
checkEqual("…and one that does not", await paramsOf("/n/abc"), 404);
checkEqual("*name: named and positional", await paramsOf("/w/a/b.css"), {
  0: "a/b.css",
  rest: "a/b.css",
});
checkEqual("{*name}", await paramsOf("/b/a/b.css"), {
  0: "a/b.css",
  rest: "a/b.css",
});
checkEqual("bare *: positional only", await paramsOf("/s/a/b"), { 0: "a/b" });

/* ------------------------------------------------------------------ */
step("use(): every form");

const order: string[] = [];
/** Middleware that records `label` and moves on. */
function mark_(label: string): RouterHandler {
  return (_req, _res, next) => {
    order.push(label);
    next();
  };
}

const child = new BunRouter();
child.get("/child", (_req, res) => {
  order.push("child route");
  res.send("child");
});
const prefixedChild = new BunRouter();
prefixedChild.get("/leaf", says("prefixed leaf"));

const uses = new BunRouter();
checkEqual("use(fn) returns the router", uses.use(mark_("global")), uses);
uses.use("/api", mark_("api prefix"));
uses.use(mark_("before child"), child);
uses.use("/mounted", prefixedChild);
uses.get("/api/users", (_req, res) => {
  order.push("api route");
  res.send("users");
});

await uses.fetch("/api/users");
checkEqual("use(path, fn) is a prefix match", order.splice(0), [
  "global",
  "api prefix",
  "before child",
  "api route",
]);
await uses.fetch("/apiary");
checkEqual(
  "…that respects segment boundaries",
  order.includes("api prefix"),
  false,
);
order.length = 0;
await uses.fetch("/child");
checkEqual("use(fn, router) keeps left-to-right order", order.splice(0), [
  "global",
  "before child",
  "child route",
]);
checkEqual(
  "use(path, router) mounts under the path",
  await text(uses, "/mounted/leaf"),
  "200 prefixed leaf",
);
checkEqual("…and not without it", (await uses.fetch("/leaf")).status, 404);
checkEqual(
  "mounted layers carry a routerId",
  layers(uses, "/mounted/leaf").at(-1)?.routerId !== 0,
  true,
);

/* ------------------------------------------------------------------ */
step("useMethod()");

const scoped = new BunRouter();
checkEqual(
  "useMethod() returns the router",
  scoped.useMethod("POST", "/forms", mark_("post middleware")),
  scoped,
);
scoped.useMethod("ALL", mark_("ALL middleware"));
scoped.useMethod("", mark_("empty method middleware"));
scoped.post("/forms/contact", says("sent"));
scoped.get("/forms/contact", says("form"));

order.length = 0;
await scoped.fetch("/forms/contact", { method: "POST" });
checkEqual("it runs only for its method, as a prefix", order.splice(0), [
  "post middleware",
  "ALL middleware",
  "empty method middleware",
]);
await scoped.fetch("/forms/contact");
checkEqual("ALL and a falsy method run for every method", order.splice(0), [
  "ALL middleware",
  "empty method middleware",
]);
checkEqual(
  "it is middleware, not a route handler",
  layers(scoped, "/forms", "POST")[0]?.isRouteHandler,
  false,
);

/* ------------------------------------------------------------------ */
step("group() and domain()");

const grouped = new BunRouter();
const v1 = new BunRouter();
v1.get("/status", says("v1"));
checkEqual(
  "group(path, router) returns the router",
  grouped.group("/v1", v1),
  grouped,
);
grouped.group("/v2", (router) => {
  router.get("/status", (_req, res) => res.send("v2"));
});

/** Registers through `register`, answering the error it threw, if any. */
function registrationError(register: () => void): string | undefined {
  try {
    register();
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

checkEqual(
  "group(path, ...callbacks) registers without throwing",
  registrationError(() => grouped.group("/v3", says("v3 middleware"))),
  undefined,
);

checkEqual("group(path, router)", await text(grouped, "/v1/status"), "200 v1");
checkEqual(
  "group(path, callback)",
  await text(grouped, "/v2/status"),
  "200 v2",
);

const groupedParams = new BunRouter();
groupedParams.group("/v2", (router) => {
  router.get("/items/:id", (req, res) => {
    res.send(`id=${req.params.id}`);
  });
});
checkEqual(
  "group(path, callback) routes bind their params",
  await text(groupedParams, "/v2/items/5"),
  "200 id=5",
);
checkEqual(
  "group(path, ...callbacks) is prefix middleware",
  await text(grouped, "/v3/deep/path"),
  "200 v3 middleware",
);

const domains = new BunRouter();
const admin = new BunRouter();
admin.get("/home", says("admin home"));
checkEqual(
  "domain(host, router) returns the router",
  domains.domain("admin.example.test", admin),
  domains,
);
domains.domain("cb.example.test", (router) => {
  router.get("/home", (_req, res) => {
    res.send("callback home");
  });
});
checkEqual(
  "domain(host, ...callbacks) registers without throwing",
  registrationError(() =>
    domains.domain("mw.example.test", says("host middleware")),
  ),
  undefined,
);

/** GETs `path` on `host`. */
async function onHost(host: string, path: string): Promise<string> {
  const response = await domains.fetch(new Request(`http://${host}${path}`));
  return `${response.status} ${await response.text()}`;
}

checkEqual(
  "domain(host, router) — on that host",
  await onHost("admin.example.test", "/home"),
  "200 admin home",
);
checkEqual(
  "…and not on another",
  await onHost("www.example.test", "/home"),
  "404 ",
);
checkEqual(
  "domain(host, callback)",
  await onHost("cb.example.test", "/home"),
  "200 callback home",
);
checkEqual(
  "domain(host, ...callbacks)",
  await onHost("mw.example.test", "/anything"),
  "200 host middleware",
);
domains.domain(":tenant.tenants.test", (router) => {
  router.get("/whoami/:id", (req, res) => {
    // Typed: the host's `tenant` and the path's `id`, both strings.
    const { tenant, id }: { tenant: string; id: string } = req.params;
    res.json({ tenant, id });
  });
});
checkEqual(
  "domain(pattern, callback): host captures land in req.params",
  await onHost("acme.tenants.test", "/whoami/7"),
  '200 {"tenant":"acme","id":"7"}',
);

/* ------------------------------------------------------------------ */
step("setRoute(), routes(), getRouteByName() and route()");

const named = new BunRouter();
checkEqual(
  "setRoute() returns the router",
  named.setRoute({
    name: "invoice",
    method: "GET",
    path: "/acct/:acct/inv/:no",
    callbacks: [says("invoice")],
  }),
  named,
);
checkEqual("routes() lists it", named.routes().length, 1);
checkEqual(
  "getRouteByName()",
  named.getRouteByName("invoice")?.path,
  "/acct/:acct/inv/:no",
);
checkEqual(
  "…undefined for an unknown name",
  named.getRouteByName("nope"),
  undefined,
);
checkEqual("…and for an empty one", named.getRouteByName(""), undefined);
checkEqual(
  "route(name, params) builds its URL",
  named.route("invoice", { acct: "acme", no: 7 }),
  "/acct/acme/inv/7",
);
await checkRejects(
  "a duplicate name is refused",
  () => named.setRoute({ name: "invoice", path: "/other", callbacks: [] }),
  { message: /already exists/ },
);
checkEqual(
  "setRoute() alone registers middleware, not a route handler",
  layers(named, "/acct/a/inv/1")[0]?.isRouteHandler,
  false,
);

const renamed = new BunRouter();
renamed.get("/profile", says("profile"));
checkEqual(
  "setName() names the route just registered",
  registrationError(() => renamed.setName("profile")),
  undefined,
);
checkEqual(
  "…so getRouteByName() finds it",
  renamed.getRouteByName("profile")?.path,
  "/profile",
);
await checkRejects(
  "setName() after middleware is refused",
  () => new BunRouter().use(says("middleware")).setName("middleware"),
  { message: /can not set name for middleware/ },
);

/* ------------------------------------------------------------------ */
step("getCacheKey(), getMatchedLayers() and clearRouteCache()");

const cache = new BunRouter();
cache.get("/c/:id", (_req, _res, next) => next(), says("c"));
cache.use(
  ((_e, _q, _r, _n) => undefined) satisfies RouterErrorMiddlewareHandler,
);
checkEqual(
  "getCacheKey()",
  cache.getCacheKey({
    requestHost: "localhost",
    requestMethod: "GET",
    requestUrl: "/c/1?x=1",
  }),
  "host:localhost:path:/c/1:method:GET",
);
checkEqual(
  "…with no host",
  cache.getCacheKey({
    requestHost: "",
    requestMethod: "POST",
    requestUrl: "/c",
  }),
  "host:none:path:/c:method:POST",
);
const matched = layers(cache, "/c/9");
checkEqual(
  "getMatchedLayers(): one layer per callback",
  matched.map((layer) => [
    layer.routeIndex,
    layer.callbackIndex,
    layer.isRouteHandler,
    layer.isErrorHandler,
  ]),
  [
    [0, 0, true, false],
    [0, 1, true, false],
    [1, 0, false, true],
  ],
);
checkEqual("…carrying the match", matched[0]?.matched.params, { id: "9" });
check("a repeat is the cached array", layers(cache, "/c/9?q=1") === matched);
checkEqual(
  "clearRouteCache() returns the router",
  cache.clearRouteCache(),
  cache,
);
check("…and drops the entry", layers(cache, "/c/9") !== matched);
const beforeRegister = layers(cache, "/c/9");
cache.get("/c/:id", says("second"));
check(
  "registering a route drops the cache too",
  layers(cache, "/c/9") !== beforeRegister,
);

/* ------------------------------------------------------------------ */
step("The pipeline: errors, next('route'), next('router')");

const pipeline = new BunRouter();
pipeline.get("/throw", () => {
  throw new Error("thrown");
});
pipeline.get("/reject", async () => Promise.reject(new Error("rejected")));
pipeline.get("/next", (_req, _res, next) => next(new Error("passed")));
pipeline.get("/string", (_req, _res, next) => next("a string"));
pipeline.get("/recover", () => {
  throw new Error("recoverable");
});
pipeline.get(
  "/route",
  (_req, _res, next) => next("route"),
  says("skipped callback"),
);
pipeline.get("/route", says("next route"));
pipeline.use(((error, req, res, next) => {
  if (req.path === "/recover") {
    next();
    return;
  }
  res.status(500).send(`handled ${(error as Error).message}`);
}) satisfies RouterErrorMiddlewareHandler);
pipeline.get("/recover", says("recovered"));

checkEqual(
  "a throw enters error mode",
  await text(pipeline, "/throw"),
  "500 handled thrown",
);
checkEqual(
  "a rejection too",
  await text(pipeline, "/reject"),
  "500 handled rejected",
);
checkEqual(
  "next(err) too",
  await text(pipeline, "/next"),
  "500 handled passed",
);
checkEqual(
  "next(string) is wrapped in an Error",
  await text(pipeline, "/string"),
  "500 handled a string",
);
checkEqual(
  "an error handler's next() clears the error",
  await text(pipeline, "/recover"),
  "200 recovered",
);
checkEqual(
  "next('route') skips the route's other callbacks",
  await text(pipeline, "/route"),
  "200 next route",
);

const exits = new BunRouter();
const first = new BunRouter();
first.get("/x", (_req, _res, next) => next("router"));
first.get("/x", says("first router, second route"));
const second = new BunRouter();
second.get("/x", says("second router"));
exits.use(first);
exits.use(second);
checkEqual(
  "next('router') leaves a mounted router",
  await text(exits, "/x"),
  "200 second router",
);

const abandon = new BunRouter();
abandon.get("/x", (_req, _res, next) => next("router"));
abandon.get("/x", says("unreachable"));
checkEqual(
  "…and from the router's own route abandons it",
  (await abandon.fetch("/x")).status,
  404,
);

const unhandled = new BunRouter();
unhandled.get("/x", () => {
  throw new TypeError("nobody handles this");
});
await checkRejects(
  "an unhandled error is re-thrown",
  () => unhandled.fetch("/x"),
  {
    name: "TypeError",
    message: /nobody handles this/,
  },
);

/* ------------------------------------------------------------------ */
step("handle(): the pipeline, driven by hand");

const handled = new BunRouter();
handled.get("/h/:id", (req, res) => res.json({ id: req.params.id }));

/** Runs `url` through `handle()` and answers the result and the response. */
async function drive(url: string) {
  const request = await BunRequest.init(
    new Request(`http://localhost${url}`),
    FETCH_STUB_SERVER,
    {
      parseBody: true,
    },
  );
  const response = new BunResponse(request);
  const result = await handled.handle({
    requestHost: request.host,
    requestMethod: request.method,
    requestUrl: request.originalUrl,
    request,
    response,
  });
  return { result, response };
}

const hit = await drive("/h/5");
check(
  "a handled request resolves the matched route",
  typeof hit.result === "object" && hit.result !== null,
);
checkEqual(
  "…whose response is settled",
  await hit.response.settledResponse?.json(),
  { id: "5" },
);
checkEqual(
  "an unmatched one resolves undefined",
  (await drive("/nope")).result,
  undefined,
);

/* ------------------------------------------------------------------ */
step("fetch(): every input form");

const echo = new BunRouter();
// A request without a body has none, as with Express's body parsers:
// `req.body` is `undefined` (so the JSON below has no `body` key), never `{}`.
echo.all("/e", (req, res) => {
  res.json({ method: req.method, body: req.body, q: req.query });
});

/** The JSON a fetch resolved to. */
async function jsonOf(response: Promise<Response>): Promise<JsonValue> {
  return (await (await response).json()) as JsonValue;
}

checkEqual(
  "a path is a GET, without a body",
  await jsonOf(echo.fetch("/e?a=1")),
  {
    method: "GET",
    q: { a: "1" },
  },
);
checkEqual(
  "a path and an init",
  await jsonOf(echo.fetch("/e", { method: "DELETE" })),
  { method: "DELETE", q: {} },
);
checkEqual(
  "an object with a url",
  await jsonOf(
    echo.fetch({
      url: "/e",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"n":1}',
    }),
  ),
  { method: "POST", body: { n: 1 }, q: {} },
);
checkEqual("a URL", await jsonOf(echo.fetch(new URL("http://localhost/e"))), {
  method: "GET",
  q: {},
});
checkEqual(
  "a Request, with its init ignored",
  await jsonOf(
    echo.fetch(new Request("http://localhost/e", { method: "PATCH" }), {
      method: "PUT",
    }),
  ),
  { method: "PATCH", q: {} },
);
checkEqual(
  "nothing matched is a bare 404",
  await text(echo, "/missing"),
  "404 ",
);

/* ------------------------------------------------------------------ */
step("The exports around the router");

checkEqual(
  "toNativeRequest(path)",
  toNativeRequest("/a?b=1").url,
  "http://localhost/a?b=1",
);
checkEqual(
  "toNativeRequest(path, init, origin)",
  toNativeRequest("/a", { method: "PUT" }, "http://h.test").method,
  "PUT",
);
checkEqual(
  "FETCH_STUB_SERVER reports no peer",
  FETCH_STUB_SERVER.requestIP(new Request("http://x.test")),
  null,
);
checkEqual(
  "…and refuses upgrades",
  FETCH_STUB_SERVER.upgrade(new Request("http://x.test"), { data: undefined }),
  false,
);
check(
  "routeModulePath points at @routejs/router's route module",
  await Bun.file(routeModulePath).exists(),
  routeModulePath,
);
const raw = new RouteClass({
  path: "/r/:id",
  method: "GET",
  callbacks: [says("r")],
});
checkEqual("RouteClass compiles params", raw.params, ["id"]);
check(
  "…and a path regexp",
  raw.pathRegexp.test("/r/1") && !raw.pathRegexp.test("/r"),
);

summary();
