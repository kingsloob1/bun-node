/**
 * Synchronous dispatch — a request with nothing asynchronous in it goes
 * through without a promise: `BunRequest.init()` returns the request itself
 * when there is no body to read, and `BunRouter.dispatch()` returns its result
 * itself while every layer finishes synchronously.
 *
 * ```bash
 * bun 02-routing/synchronous-dispatch.ts
 * ```
 *
 * - `BunRequest.init(request, server, options)` answers a `BunRequest` for a
 *   request without a body — its query and cookies are already parsed, and
 *   `complete` is `true` — and a `Promise<BunRequest>` when a body has to be
 *   read. `await` works on both; branch on it to skip the microtask.
 * - `router.dispatch()` is `handle()` without the promise when none is
 *   needed: a value for synchronous layers, a promise from the first layer
 *   that is not (an async handler, or a `next()` called later). Errors follow
 *   the same split — thrown, or a rejection. The semantics are otherwise the
 *   same.
 * - `router.handle()` always answers a promise.
 * - Their `timeout` option bounds a parked layer: one that never responds nor
 *   calls `next()` fails with `Request Timedout`, which
 *   `isRequestTimeoutError()` recognises (the adapters pass their request
 *   timeout, and answer it as a 500 without running the error handlers).
 * - So code that drives `handle()` or `dispatch()` itself must end every
 *   layer with `next()` or a **finished** response — `send()`, `end()`, an
 *   upgrade; a streamed response only once it ends — or pass a `timeout`. A
 *   layer that only records something and returns (a guard's marker, say)
 *   parks the pipeline, and without a timeout the promise never settles.
 *   Before the Express 5 pipeline such a layer counted as finished.
 * - The adapters' served path uses both, so a bodiless synchronous request
 *   reaches `Bun.serve` as a `Response`, with no promise in between.
 */
import type { RouterErrorMiddlewareHandler } from "@kingsleyweb/bun-common";
import {
  BunRequest,
  BunResponse,
  BunRouter,
  FETCH_STUB_SERVER,
  isRequestTimeoutError,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Synchronous dispatch");

/** What `dispatch()` and `handle()` take. */
type PipelineOptions = Parameters<BunRouter["dispatch"]>[0];

/** The adapter's default request options: every parser on. */
const OPTIONS = { parseBody: true, parseCookies: true, parseQuery: true };

/* ------------------------------------------------------------------ */
step("BunRequest.init(): the request itself, unless a body must be read");

const bodiless = BunRequest.init(
  new Request("http://localhost/search?q=bun&page=2", {
    headers: { Cookie: "theme=dark" },
  }),
  FETCH_STUB_SERVER,
  OPTIONS,
);
check("a GET without a body: a BunRequest", bodiless instanceof BunRequest);
if (bodiless instanceof BunRequest) {
  checkEqual(
    "…already parsed",
    {
      query: bodiless.query,
      cookies: bodiless.cookies,
      body: bodiless.body,
      complete: bodiless.complete,
    },
    {
      query: { q: "bun", page: "2" },
      cookies: { theme: "dark" },
      body: undefined,
      complete: true,
    },
  );
}

const emptyPost = BunRequest.init(
  new Request("http://localhost/ping", { method: "POST" }),
  FETCH_STUB_SERVER,
  OPTIONS,
);
check(
  "a POST without a body: a BunRequest too",
  emptyPost instanceof BunRequest,
);

const withBody = BunRequest.init(
  new Request("http://localhost/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "pen" }),
  }),
  FETCH_STUB_SERVER,
  OPTIONS,
);
check("a POST with a body: a Promise", withBody instanceof Promise);
checkEqual("…resolving to the parsed request", (await withBody).body, {
  name: "pen",
});

/* ------------------------------------------------------------------ */
step("router.dispatch(): a value for synchronous layers, else a promise");

const order: string[] = [];
const router = new BunRouter();
router.use((_req, _res, next) => {
  order.push("sync middleware");
  next();
});
router.get("/sync", (_req, res) => res.send("answered synchronously"));
router.get("/async", async (_req, res) => {
  await Bun.sleep(1);
  order.push("async handler");
  res.send("answered after an await");
});
router.get(
  "/later",
  (_req, _res, next) => {
    setTimeout(next, 1);
  },
  (_req, res) => {
    order.push("after a later next()");
    res.send("answered after a timer");
  },
);
router.get("/throws", () => {
  throw new Error("thrown synchronously");
});
router.get("/rejects", async () => {
  await Promise.resolve();
  throw new Error("thrown after an await");
});

/** Builds the pipeline options `dispatch()`/`handle()` take, for `GET path`. */
function pipeline(path: string): PipelineOptions {
  const request = BunRequest.init(
    new Request(`http://localhost${path}`),
    FETCH_STUB_SERVER,
    OPTIONS,
  );
  if (!(request instanceof BunRequest)) {
    throw new TypeError("a bodiless request is built synchronously");
  }
  return {
    requestHost: request.host,
    requestMethod: request.method,
    requestUrl: request.originalUrl,
    request,
    response: new BunResponse(request),
  };
}

const sync = pipeline("/sync");
const syncResult = router.dispatch(sync);
check("GET /sync: not a promise", !(syncResult instanceof Promise));
check("…but the matched route", Boolean(syncResult), syncResult);
// The response settled before dispatch() returned.
checkEqual(
  "…with the response already settled",
  await sync.response.settledResponse?.text(),
  "answered synchronously",
);

const none = router.dispatch(pipeline("/nothing"));
checkEqual("nothing matched: undefined, synchronously", none, undefined);

let thrown: unknown;
try {
  const result = router.dispatch(pipeline("/throws"));
  show("unexpected result", result);
} catch (error) {
  thrown = error;
}
checkEqual(
  "an unhandled synchronous error is thrown, not a rejection",
  (thrown as Error | undefined)?.message,
  "thrown synchronously",
);

order.length = 0;
const asyncOptions = pipeline("/async");
const asyncResult = router.dispatch(asyncOptions);
check("GET /async: a promise", asyncResult instanceof Promise);
check("…resolving to the matched route", Boolean(await asyncResult));
checkEqual(
  "…once the handler answered",
  await asyncOptions.response.settledResponse?.text(),
  "answered after an await",
);

const laterOptions = pipeline("/later");
const laterResult = router.dispatch(laterOptions);
check(
  "GET /later: a promise from the parked layer",
  laterResult instanceof Promise,
);
await laterResult;
checkEqual(
  "…and the rest ran when next() came",
  await laterOptions.response.settledResponse?.text(),
  "answered after a timer",
);
checkEqual("every layer ran, in order", order, [
  "sync middleware",
  "async handler",
  "sync middleware",
  "after a later next()",
]);

const rejecting = router.dispatch(pipeline("/rejects"));
check("an error after an await: a promise", rejecting instanceof Promise);
let rejected: unknown;
try {
  await rejecting;
} catch (error) {
  rejected = error;
}
checkEqual(
  "…that rejects with it",
  (rejected as Error | undefined)?.message,
  "thrown after an await",
);

/* ------------------------------------------------------------------ */
step("timeout: a parked layer that never finishes");

const stuck = new BunRouter();
stuck.get("/stuck", () => {
  // Neither responds nor calls next().
});
let timedOut: unknown;
const parkedFrom = performance.now();
try {
  await stuck.dispatch({ ...pipeline("/stuck"), timeout: 50 });
} catch (error) {
  timedOut = error;
}
const parkedFor = performance.now() - parkedFrom;
checkEqual(
  "it fails with Request Timedout",
  (timedOut as Error | undefined)?.message,
  "Request Timedout",
);
check("…after the 50ms timeout", parkedFor >= 45, parkedFor);
check("isRequestTimeoutError() recognises it", isRequestTimeoutError(timedOut));
check(
  "…and nothing else, even with the same message",
  !isRequestTimeoutError(new Error("Request Timedout")),
);

/* ------------------------------------------------------------------ */
step("Driving handle() yourself: end every layer, or pass a timeout");

// A guard in front of something else, the way a raw upgrade check is built:
// one layer records that the request passed, an error handler refuses it.
// The marker returns without responding — so unless it calls next(), the
// pipeline parks on it, waiting for a next() that never comes.
const passed = new WeakSet<BunRequest>();
let parkedNext: (() => void) | undefined;

const markOnly = new BunRouter();
markOnly.use("/guarded", (req, _res, next) => {
  passed.add(req);
  parkedNext = () => next();
});
markOnly.use(((_err, _req, res, _next) => {
  res.status(403).send("refused");
}) satisfies RouterErrorMiddlewareHandler);

/** Whether `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number) {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    Bun.sleep(ms).then(() => false),
  ]);
}

const marked = pipeline("/guarded");
const markedRun = markOnly.handle(marked);
check("the marker ran", passed.has(marked.request));
check(
  "…but without next() and no timeout, handle() has not settled after 200ms",
  !(await settlesWithin(markedRun, 200)),
);
check("…nor has anything been sent", !marked.response.headersSent);
parkedNext?.();
check(
  "…and a later next() is what finishes it",
  await settlesWithin(markedRun, 200),
);

const markThenNext = new BunRouter();
markThenNext.use("/guarded", (req, _res, next) => {
  passed.add(req);
  next();
});
markThenNext.use(((_err, _req, res, _next) => {
  res.status(403).send("refused");
}) satisfies RouterErrorMiddlewareHandler);

const nexted = pipeline("/guarded");
const nextedRun = markThenNext.dispatch(nexted);
check(
  "the marker calling next(): the pipeline runs out synchronously",
  !(nextedRun instanceof Promise),
);
check("…with the request marked", passed.has(nexted.request));
check(
  "…and the error handler skipped, as nothing failed",
  !nexted.response.headersSent,
);

// A response finishes a layer only once it is finished: a stream that has
// started holds the pipeline until it ends.
const streaming = new BunRouter();
streaming.get("/stream", (_req, res) => {
  res.write("first chunk");
  setTimeout(() => void res.end(), 150);
});
const streamed = pipeline("/stream");
const streamedRun = streaming.handle(streamed);
check(
  "a streamed response: started, but handle() still waits for it",
  streamed.response.headersSent && !(await settlesWithin(streamedRun, 50)),
);
check(
  "…and settles once the stream ends",
  await settlesWithin(streamedRun, 500),
);

/* ------------------------------------------------------------------ */
step("router.handle(): always a promise");

const handled = router.handle(pipeline("/sync"));
check("GET /sync through handle(): a promise", handled instanceof Promise);
check("…resolving to the matched route", Boolean(await handled));

summary();
