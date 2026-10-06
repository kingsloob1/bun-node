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
 * - A layer is done when it calls `next()` or produces a complete response.
 *   `next()` may be called later — from a timer or an I/O callback — as
 *   Express allows: the pipeline waits for it. A callback that never responds
 *   nor calls `next()`, or an async handler that never settles, hangs until
 *   the adapter's request timeout fails it with `Request Timedout` (a 500
 *   from the final handling). An open stream is never timed out.
 * - An open stream (`res.write()`) is not a complete response: `next()` still
 *   hands it to the next layer, which may write more or `end()` it, and a
 *   `next(err)` — even from a timer — reaches the error handlers.
 * - An async handler that responds and keeps awaiting does not hold its
 *   response back; a rejection after that is logged ("Error from a handler
 *   after it had moved on").
 * - An error raised after the response started (`res.write()`, then a throw or
 *   `next(err)`) still runs the error handlers, which see `res.headersSent`
 *   as `true` and may still `res.end()` the stream. If none handles it, the
 *   streamed response is cut off (`res.destroy(err)`) once what was already
 *   written has gone out, and the error logged, as Express's finalhandler
 *   destroys the socket.
 * - An error nobody handles is re-thrown to the caller. A bare router's
 *   `fetch()` rejects with it. On an adapter, served or through
 *   `adapter.fetch()`, it reaches `setErrorHandler`, and without one it is
 *   answered as Express's finalhandler does: the error's 4xx/5xx `status`, or
 *   `500`, with the status message as the body.
 */
import type { RouterErrorMiddlewareHandler } from "@kingsleyweb/bun-common";
import net from "node:net";
import {
  BunHttpAdapter,
  BunRouter,
  createTestLogger,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

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
step("next() called later, from a timer or an I/O callback");

// Callback-style middleware — a session store, a rate limiter, a file read —
// returns first and calls next() when its work is done. The pipeline waits.
const later = new BunRouter();
const laterTrail: string[] = [];
later.use((_req, _res, next) => {
  laterTrail.push("timer middleware returned");
  setTimeout(() => {
    laterTrail.push("timer fired, next()");
    next();
  }, 10);
});
later.use("/io", (_req, res, next) => {
  // An I/O callback: read this very file, then carry on.
  void Bun.file(import.meta.path)
    .text()
    .then((source) => {
      res.setHeader("X-Source-Bytes", String(source.length));
      next();
    });
});
later.get("/timer", (_req, res) => {
  laterTrail.push("route handler");
  res.send("after a late next()");
});
later.get("/io", (_req, res) => res.send("after an I/O callback"));
later.get("/late-error", (_req, _res, next) => {
  setTimeout(() => next(new Error("failed in a callback")), 5);
});
later.use(respondWithError);

checkEqual(
  "GET /timer waits for the timer's next()",
  await call(later, "/timer"),
  "200 after a late next()",
);
checkEqual("…in this order", laterTrail, [
  "timer middleware returned",
  "timer fired, next()",
  "route handler",
]);
const io = await later.fetch("/io");
checkEqual(
  "GET /io waits for the file read",
  `${io.status} ${await io.text()}`,
  "200 after an I/O callback",
);
check(
  "…which set a header first",
  Number(io.headers.get("X-Source-Bytes")) > 0,
  io.headers.get("X-Source-Bytes"),
);
checkEqual(
  "a late next(err) reaches the error handlers",
  await call(later, "/late-error"),
  "500 handled: failed in a callback",
);
checkEqual(
  "a late next() that runs out of routes is a 404",
  (await later.fetch("/nothing-here")).status,
  404,
);

// The same over a real socket: the served path waits just the same.
const lateServed = new BunHttpAdapter(0);
lateServed.use((_req, _res, next) => {
  setTimeout(next, 5);
});
lateServed.get("/served", (_req, res) => {
  res.send("served after a late next()");
});
await lateServed.listen(0);
const servedLate = await fetch(`${lateServed.url}/served`);
checkEqual(
  "served: GET /served",
  `${servedLate.status} ${await servedLate.text()}`,
  "200 served after a late next()",
);
await lateServed.close();

/* ------------------------------------------------------------------ */
step("A handler that neither responds nor calls next() hangs");

// Nothing times the request out but the adapter's `requestTimeout`, which is
// why this section uses an adapter. When it expires, the timeout error gets
// the adapter's final error handling: a 500. That handling runs without the
// request, so even a setErrorHandler does not see it.
const adapter = new BunHttpAdapter(200);
adapter.setLogger(createTestLogger().logger);
const sawTimeout: unknown[] = [];
adapter.setErrorHandler(((error, _req, res, _next) => {
  sawTimeout.push(error);
  res.status(503).send("not used for a timeout");
}) satisfies RouterErrorMiddlewareHandler);
adapter.get("/forgot", () => {
  // Returned values are ignored; this request is left hanging.
  return "not a response";
});
const started = performance.now();
const forgot = await adapter.fetch("/forgot");
const waited = performance.now() - started;
show(
  `answered after ${waited.toFixed(0)}ms`,
  `${forgot.status} ${forgot.statusText}`,
);
checkEqual("a request that never finishes is a 500", forgot.status, 500);
check("…once the 200ms timeout ran out", waited >= 190, waited);
checkEqual("…and the error handlers never saw it", sawTimeout, []);

// An async handler that never settles is timed out the same way — which is
// what a stuck Nest controller (always async) relies on.
adapter.get("/never-settles", async () => {
  await new Promise<never>(() => {});
});
const asyncStarted = performance.now();
const neverSettles = await adapter.fetch("/never-settles");
const asyncWaited = performance.now() - asyncStarted;
checkEqual(
  "an async handler that never settles is a 500 too",
  neverSettles.status,
  500,
);
check("…once the timeout ran out", asyncWaited >= 190, asyncWaited);

const unhandledOnAdapter = new BunHttpAdapter();
unhandledOnAdapter.get("/x", () => {
  throw Object.assign(new Error("secret detail"), { status: 503 });
});
const fallback = await unhandledOnAdapter.fetch("/x");
show(
  "an adapter with no error handler — finalhandler's answer",
  `${fallback.status} ${(await fallback.text()).match(/<pre>(.*)<\/pre>/)?.[1]}`,
);

/* ------------------------------------------------------------------ */
step("Errors after the response started");

/** Sends one raw HTTP/1.1 GET and answers everything the server wrote. */
function rawGet(port: number, path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    // A cut-off response closes the socket; a hang would hit this instead.
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(`TIMEOUT ${data}`);
    }, 3000);
    const done = () => {
      clearTimeout(timer);
      resolve(data);
    };
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("close", done);
    socket.on("error", done);
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
    );
  });
}

const streaming = new BunHttpAdapter(0);
const { logger: afterLogger, events: afterEvents } = createTestLogger();
streaming.setLogger(afterLogger);
const afterSeen: { path: string; message: string; headersSent: boolean }[] = [];
streaming.get("/recover", (_req, res) => {
  res.write("partial;");
  throw new Error("boom");
});
streaming.get("/unhandled", (_req, res, next) => {
  res.write("partial;");
  next(new Error("too late to send a 500"));
});
streaming.use(((error, req, res, next) => {
  afterSeen.push({
    path: req.path,
    message: (error as Error).message,
    headersSent: res.headersSent,
  });
  if (req.path === "/recover") {
    // The status line is gone, but the stream is still open: finish it.
    void res.end(`recovered:${(error as Error).message}`);
    return;
  }
  next(error as Error);
}) satisfies RouterErrorMiddlewareHandler);

checkEqual(
  "an error handler can still end() the stream",
  await (await streaming.fetch("/recover")).text(),
  "partial;recovered:boom",
);
checkEqual("…and saw headersSent: true", afterSeen.splice(0), [
  { path: "/recover", message: "boom", headersSent: true },
]);

// Nobody handles the second one, and a 500 can no longer be sent, so the
// stream is destroyed: the client gets what was written, then the response is
// cut off — never a hang, never a complete chunked body. (Bun also prints the
// stream's error.)
const listening = await streaming.listen(0);
const cut = await rawGet(listening.port!, "/unhandled");
show("what the client received", JSON.stringify(cut));
check(
  "unhandled: the response is cut off, not left hanging",
  !cut.startsWith("TIMEOUT"),
  cut,
);
check(
  "…and never ends as a complete chunked body",
  !cut.includes("\r\n0\r\n\r\n"),
  cut,
);
// Since #267. Before it, a write() and an error in the same turn made Bun
// reset the connection with nothing sent, not even the status line.
check(
  "…but only after the 200 and the chunk written before the error",
  cut.startsWith("HTTP/1.1 200") && cut.includes("\r\npartial;\r\n"),
  cut,
);
checkEqual("…after the error handlers ran", afterSeen.splice(0), [
  { path: "/unhandled", message: "too late to send a 500", headersSent: true },
]);
check(
  "…and the error is logged",
  afterEvents.some(
    (event) =>
      event.level === "error" &&
      event.message === "Unhandled error after the response was sent" &&
      event.error?.message === "too late to send a 500",
  ),
  afterEvents.map((event) => event.message),
);

// The same through `adapter.fetch()`: the written chunk is read, then the
// body errors rather than ending.
const cutBody = (await streaming.fetch("/unhandled")).body!.getReader();
const cutChunks: string[] = [];
/** How the body stopped: it `errored`, `ended` cleanly, or is `still open`. */
let cutEnding: "errored" | "ended" | "still open";
for (;;) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const chunk = await Promise.race([
    cutBody.read().catch(() => "errored" as const),
    new Promise<"still open">((resolve) => {
      timer = setTimeout(resolve, 3000, "still open");
    }),
  ]);
  clearTimeout(timer);
  if (typeof chunk === "string" || chunk.done) {
    cutEnding = typeof chunk === "string" ? chunk : "ended";
    break;
  }
  cutChunks.push(new TextDecoder().decode(chunk.value));
}
checkEqual(
  "adapter.fetch(): the written chunk arrives, then the body errors",
  [cutChunks.join(""), cutEnding],
  ["partial;", "errored"],
);
afterSeen.splice(0);
await streaming.close();

/* ------------------------------------------------------------------ */
step("After res.write(), next() and next(err) still move on");

const open = new BunHttpAdapter(0);
const { logger: openLogger, events: openEvents } = createTestLogger();
open.setLogger(openLogger);
const openSeen: { message: string; headersSent: boolean }[] = [];
open.get(
  "/sync",
  (_req, res, next) => {
    res.write("one;");
    next();
  },
  (_req, res) => {
    void res.end("two");
  },
);
open.get(
  "/timer",
  (_req, res, next) => {
    res.write("one;");
    setTimeout(next, 10);
  },
  (_req, res) => {
    void res.end("two");
  },
);
open.get("/late-error", (_req, res, next) => {
  res.write("one;");
  setTimeout(() => next(new Error("late")), 10);
});
open.get("/sent-then-rejects", async (_req, res) => {
  res.send("sent at once");
  await Bun.sleep(300);
  throw new Error("after the response");
});
open.use(((error, _req, res, _next) => {
  openSeen.push({
    message: (error as Error).message,
    headersSent: res.headersSent,
  });
  void res.end(`|handled: ${(error as Error).message}`);
}) satisfies RouterErrorMiddlewareHandler);
await open.listen(0);

for (const path of ["/sync", "/timer"]) {
  checkEqual(
    `${path}: write(); next() — the next handler ends it`,
    [
      await (await open.fetch(path)).text(),
      await (await fetch(`${open.url}${path}`)).text(),
    ],
    ["one;two", "one;two"],
  );
}
checkEqual(
  "a later next(err) on an open stream reaches the error handler",
  await (await fetch(`${open.url}/late-error`)).text(),
  "one;|handled: late",
);
checkEqual("…which saw headersSent: true", openSeen.splice(0), [
  { message: "late", headersSent: true },
]);

const sentFrom = performance.now();
const sentThen = await fetch(`${open.url}/sent-then-rejects`);
const sentBody = await sentThen.text();
const sentAfter = performance.now() - sentFrom;
checkEqual("send() then keep awaiting: the response", sentBody, "sent at once");
check("…arrives before the handler resolves", sentAfter < 250, sentAfter);
/** Whether the handler's late rejection has been logged yet. */
function lateRejectionLogged(): boolean {
  return openEvents.some(
    (event) => event.message === "Error from a handler after it had moved on",
  );
}
await waitFor("the late rejection to be logged", lateRejectionLogged);
check(
  "…and its later rejection is logged",
  openEvents.some(
    (event) =>
      event.message === "Error from a handler after it had moved on" &&
      event.error?.message === "after the response",
  ),
);
await open.close();

summary();
