/**
 * Middleware and errors — the Express 5 pipeline `BunRouter.handle()` walks.
 *
 * ```bash
 * bun 02-routing/middleware-and-errors.ts
 * ```
 *
 * - `use(path, …)` matches a path **prefix** (`/api` covers `/api/users`, not
 *   `/apiary`); a verb route's path is **exact**.
 * - Middleware and error handlers run in registration order. A callback with
 *   four parameters is an error handler — arity is the only signal, so an
 *   inline one needs `satisfies RouterErrorMiddlewareHandler` for its types.
 * - A throw, a rejected promise or `next(err)` switches to *error mode*: only
 *   error handlers run until one responds, or calls `next()` to clear it.
 * - `next("route")` skips the rest of the current route's callbacks;
 *   `next("router")` leaves a mounted sub-router, or abandons the pipeline
 *   when called from the router's own routes.
 * - An error nobody handles is re-thrown to the caller. A bare router's
 *   `fetch()` rejects with it. On an adapter, served or through
 *   `adapter.fetch()`, it reaches `setErrorHandler`, and without one it is
 *   answered as Express's finalhandler does: the error's 4xx/5xx `status`, or
 *   `500`, with the status message as the body.
 */
import type { RouterErrorMiddlewareHandler } from "@kingsleyweb/bun-common";
import { BunHttpAdapter, BunRouter } from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

title("Middleware and errors");

/** Fetches `path` and answers `"<status> <body>"`, or the rejection's message. */
async function call(
  router: BunRouter,
  path: string,
  init?: RequestInit,
): Promise<string> {
  try {
    const response = await router.fetch(path, init);
    return `${response.status} ${await response.text()}`;
  } catch (error) {
    return `rejected: ${(error as Error).message}`;
  }
}

/** An error handler that answers 500 with the error's message. */
const respondWithError = ((error, _req, res, _next) => {
  res.status(500).send(`handled: ${(error as Error).message}`);
}) satisfies RouterErrorMiddlewareHandler;

/* ------------------------------------------------------------------ */
step("use() is a prefix match; verb routes are exact");

const prefix = new BunRouter();
const seen: string[] = [];
prefix.use("/api", (req, _res, next) => {
  seen.push(req.path);
  next();
});
prefix.get("/api", (_req, res) => res.send("exact /api"));
prefix.get("/api/users", (_req, res) => res.send("exact /api/users"));
prefix.get("/apiary", (_req, res) => res.send("exact /apiary"));

for (const path of ["/api", "/api/users", "/apiary"]) {
  show(path, await call(prefix, path));
}
show("the /api middleware saw", seen);
show(
  "GET /api/users/extra (no exact route)",
  await call(prefix, "/api/users/extra"),
);

/* ------------------------------------------------------------------ */
step("Registration order, and short-circuiting");

const ordered = new BunRouter();
const order: string[] = [];
ordered.use((_req, _res, next) => {
  order.push("first middleware");
  next();
});
ordered.useMethod("POST", (_req, _res, next) => {
  // useMethod: middleware (prefix-matched, never reordered) for one method.
  order.push("POST-only middleware");
  next();
});
ordered.get("/x", (_req, res) => {
  order.push("GET handler");
  res.send("ok");
});
ordered.use("/blocked", (_req, res) => {
  // Responding ends the pipeline: nothing registered after this runs.
  order.push("blocking middleware");
  res.status(403).send("blocked by middleware");
});
ordered.get("/blocked", (_req, res) => {
  order.push("never reached");
  res.send("unreachable");
});

show("GET /x", await call(ordered, "/x"));
show("order", order.splice(0));
show("POST /x (no POST route)", await call(ordered, "/x", { method: "POST" }));
show("order", order.splice(0));
show("GET /blocked", await call(ordered, "/blocked"));
show("order", order.splice(0));

/* ------------------------------------------------------------------ */
step("Four ways into error mode");

const failing = new BunRouter();
failing.get("/throw", () => {
  throw new Error("thrown synchronously");
});
failing.get("/reject", async () => {
  await Promise.resolve();
  throw new Error("rejected promise");
});
failing.get("/next-error", (_req, _res, next) => {
  next(new Error("passed to next()"));
});
failing.get("/next-string", (_req, _res, next) => next("a plain string"));
failing.get("/fine", (_req, res) => {
  res.send("no error, so error handlers are skipped");
});
failing.use(respondWithError);

for (const path of [
  "/throw",
  "/reject",
  "/next-error",
  "/next-string",
  "/fine",
]) {
  show(path, await call(failing, path));
}

/* ------------------------------------------------------------------ */
step("While an error is active, regular middleware is skipped");

const skipping = new BunRouter();
const skipOrder: string[] = [];
skipping.use(() => {
  skipOrder.push("middleware that throws");
  throw new Error("boom");
});
skipping.use((_req, _res, next) => {
  skipOrder.push("regular middleware (skipped)");
  next();
});
skipping.use(((_error, _req, _res, next) => {
  skipOrder.push("error handler that recovers with next()");
  next();
}) satisfies RouterErrorMiddlewareHandler);
skipping.get("/x", (_req, res) => {
  skipOrder.push("route handler, back in normal mode");
  res.send("recovered");
});

show("GET /x", await call(skipping, "/x"));
show("order", skipOrder);

/* ------------------------------------------------------------------ */
step("Propagating, replacing and failing to handle an error");

const propagating = new BunRouter();
propagating.get("/x", () => {
  throw new Error("original");
});
propagating.use(((error, _req, _res, next) => {
  next(new Error(`wrapped(${(error as Error).message})`));
}) satisfies RouterErrorMiddlewareHandler);
propagating.use(((error, _req, _res, _next) => {
  // Throwing inside an error handler replaces the error, too.
  throw new Error(`rethrown(${(error as Error).message})`);
}) satisfies RouterErrorMiddlewareHandler);
propagating.use(respondWithError);
show("next(err) and a throw both hand on", await call(propagating, "/x"));

const unhandled = new BunRouter();
unhandled.get("/x", () => {
  throw new Error("nobody catches this");
});
show("no error handler at all", await call(unhandled, "/x"));

/* ------------------------------------------------------------------ */
step("next('route') and next('router')");

const routes = new BunRouter();
routes.get(
  "/x",
  (req, _res, next) => next(req.query.skip ? "route" : undefined),
  (_req, res) => res.send("first route, second callback"),
);
routes.get("/x", (_req, res) => res.send("second route"));
show("GET /x", await call(routes, "/x"));
show("GET /x?skip=1 — next('route')", await call(routes, "/x?skip=1"));

const guarded = new BunRouter();
guarded.get("/admin", (req, _res, next) => {
  next(req.query.token ? undefined : "router");
});
guarded.get("/admin", (_req, res) => res.send("admin page"));

const app = new BunRouter();
app.use(guarded);
app.get("/admin", (_req, res) => {
  res.send("fallback after leaving the mounted router");
});
show("GET /admin?token=1", await call(app, "/admin?token=1"));
show("GET /admin — next('router') inside a mount", await call(app, "/admin"));

const own = new BunRouter();
own.get("/admin", (_req, _res, next) => next("router"));
own.get("/admin", (_req, res) => res.send("never reached"));
show(
  "next('router') from the router's own route abandons it",
  await call(own, "/admin"),
);

/* ------------------------------------------------------------------ */
step("Params are bound per route, so a middleware may replace them");

const params = new BunRouter();
params.get(
  "/users/:id",
  (req, _res, next) => {
    // Replace wholesale: the bound object is shared by every request with
    // this path, so mutating it in place would leak into the next one.
    req.params = { id: req.params.id === "me" ? "42" : req.params.id };
    next();
  },
  (req, res) => res.send(`user ${req.params.id}`),
);
show("GET /users/me", await call(params, "/users/me"));
show("GET /users/7", await call(params, "/users/7"));

/* ------------------------------------------------------------------ */
step("A handler that neither responds nor calls next() hangs");

// Nothing times the request out but the adapter's `requestTimeout`, which is
// why this section uses an adapter. When it expires, the timeout error gets
// the adapter's final error handling: a 500, as no setErrorHandler is set.
const adapter = new BunHttpAdapter(200);
adapter.get("/forgot", () => {
  // Returned values are ignored; this request is left hanging.
  return "not a response";
});
const started = performance.now();
const forgot = await adapter.fetch("/forgot");
show(
  `answered after ${(performance.now() - started).toFixed(0)}ms`,
  `${forgot.status} ${forgot.statusText}`,
);

const unhandledOnAdapter = new BunHttpAdapter();
unhandledOnAdapter.get("/x", () => {
  throw Object.assign(new Error("secret detail"), { status: 503 });
});
const fallback = await unhandledOnAdapter.fetch("/x");
show(
  "an adapter with no error handler — finalhandler's answer",
  `${fallback.status} ${(await fallback.text()).match(/<pre>(.*)<\/pre>/)?.[1]}`,
);
