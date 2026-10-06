/**
 * Serving an asynchronous pipeline — what a client sees when middleware and
 * handlers await, stream, respond early or never finish, each checked over a
 * real socket and through `adapter.fetch()`, plus `router.serveRequest()`,
 * the entry point both of those serve through.
 *
 * ```bash
 * bun 02-routing/serving-async.ts
 * ```
 *
 * - A pipeline that goes asynchronous costs one promise in all, whatever
 *   number of layers await; the semantics are Express 5's.
 * - A handler that responds and keeps awaiting does not hold its response
 *   back. Its `next(err)` in the same tick still reaches the error handlers
 *   (which see `res.headersSent`), and a rejection after it moved on is
 *   logged as "Error from a handler after it had moved on".
 * - `res.write()` opens a stream, and its `Response` goes back the moment it
 *   opens, the pipeline running on behind it.
 * - The request timeout (the constructor's first argument, or
 *   `adapter.setTimeout(ms, callback)`) fails a parked pipeline as a 500.
 * - A router whose `handle()` is overridden is still served through it.
 * - `router.serveRequest(options, hooks)` runs the pipeline and finishes it
 *   through `hooks`: `respond(options, routeUsed)`, `stream(options,
 *   response)`, `error(options, error)` and `lateError(options, error)`. It
 *   answers synchronously when every layer did, and as one promise
 *   otherwise. `dispatch()` and `handle()` are unchanged.
 */
import type {
  PipelineOptions,
  RouterErrorMiddlewareHandler,
  ServeHooks,
} from "@kingsleyweb/bun-common";
import process from "node:process";
import {
  BunHttpAdapter,
  BunRequest,
  BunResponse,
  BunRouter,
  createTestLogger,
  FETCH_STUB_SERVER,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Serving an asynchronous pipeline");

const app = new BunHttpAdapter(250);
const { logger, events } = createTestLogger();
app.setLogger(logger);
// The final handler logs nothing under NODE_ENV=test; keep it on here.
const nodeEnvBefore = process.env.NODE_ENV;
process.env.NODE_ENV = "development";

/** What the error handler saw, per path. */
const errorsSeen: { path: string; message: string; headersSent: boolean }[] =
  [];

/** Each request's trail through the `/chain` layers. */
const trails = new WeakMap<object, string[]>();
app.use("/chain", async (req, _res, next) => {
  await Bun.sleep(2);
  trails.set(req, ["first"]);
  next();
});
app.use("/chain", async (req, _res, next) => {
  await Promise.resolve();
  trails.get(req)?.push("second");
  next();
});
app.get("/chain", async (req, res) => {
  await Bun.sleep(2);
  res.send([...(trails.get(req) ?? []), "handler"].join(","));
});
app.get("/early", async (_req, res) => {
  res.send("sent before the handler finished");
  await Bun.sleep(400);
});
app.get("/send-then-error", async (_req, res, next) => {
  await Promise.resolve();
  res.send("sent");
  next(new Error("after send, same tick"));
});
app.get("/late-rejection", async (_req, res) => {
  res.send("sent");
  await Bun.sleep(20);
  throw new Error("rejected after moving on");
});
app.get("/stream", async (_req, res) => {
  res.write("first;");
  await Bun.sleep(300);
  void res.end("last");
});
app.get("/parked", (_req, _res, _next) => {
  // Neither responds nor calls next(): the request timeout ends it.
});
app.use(((error, req, res, _next) => {
  errorsSeen.push({
    path: req.path,
    message: (error as Error).message,
    headersSent: res.headersSent,
  });
  if (!res.headersSent) {
    res.status(500).send("handled");
  }
}) satisfies RouterErrorMiddlewareHandler);
await app.listen(0);

/** Runs `use` once over the socket and once through `adapter.fetch()`. */
async function bothWays<T>(
  path: string,
  use: (response: Response, startedAt: number) => Promise<T>,
): Promise<[T, T]> {
  const servedAt = performance.now();
  const served = await use(await fetch(`${app.url}${path}`), servedAt);
  const offlineAt = performance.now();
  const offline = await use(await app.fetch(path), offlineAt);
  return [served, offline];
}

/** `"<status> <body>"`. */
async function text(response: Response): Promise<string> {
  return `${response.status} ${await response.text()}`;
}

/* ------------------------------------------------------------------ */
step("Async middleware and an async handler");

checkEqual(
  "GET /chain: every await in order, served and through fetch()",
  await bothWays("/chain", text),
  ["200 first,second,handler", "200 first,second,handler"],
);

/* ------------------------------------------------------------------ */
step("A response is not held back by the handler that sent it");

const early = await bothWays("/early", async (response, startedAt) => {
  const body = await response.text();
  return { body, quick: performance.now() - startedAt < 300 };
});
show("GET /early", early);
checkEqual("GET /early arrives before the handler's 400ms await", early, [
  { body: "sent before the handler finished", quick: true },
  { body: "sent before the handler finished", quick: true },
]);

checkEqual(
  "res.send(); next(err) in the same tick: the response stands",
  await bothWays("/send-then-error", text),
  ["200 sent", "200 sent"],
);
await waitFor("both errors to reach the handler", () => errorsSeen.length >= 2);
checkEqual(
  "…and the error handlers ran, with headersSent",
  errorsSeen.splice(0),
  [
    {
      path: "/send-then-error",
      message: "after send, same tick",
      headersSent: true,
    },
    {
      path: "/send-then-error",
      message: "after send, same tick",
      headersSent: true,
    },
  ],
);

checkEqual(
  "a handler that rejects after responding: the response stands",
  await bothWays("/late-rejection", text),
  ["200 sent", "200 sent"],
);
/** The late rejections logged so far. */
function lateRejections() {
  return events.filter(
    (event) => event.message === "Error from a handler after it had moved on",
  );
}
await waitFor(
  "both late rejections to be logged",
  () => lateRejections().length >= 2,
);
check(
  "…and the rejection is logged, once per request",
  lateRejections().length === 2 &&
    lateRejections().every(
      (event) => event.error?.message === "rejected after moving on",
    ),
  lateRejections().map((event) => event.error?.message),
);

/* ------------------------------------------------------------------ */
step("A stream comes back as soon as it opens");

const streamed = await bothWays("/stream", async (response, startedAt) => {
  const openedAfter = performance.now() - startedAt;
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  let rest = "";
  for (
    let chunk = await reader.read();
    !chunk.done;
    chunk = await reader.read()
  ) {
    rest += new TextDecoder().decode(chunk.value);
  }
  return { opened: openedAfter < 250, first, rest };
});
checkEqual(
  "GET /stream: the Response before the handler's 300ms await",
  streamed,
  [
    { opened: true, first: "first;", rest: "last" },
    { opened: true, first: "first;", rest: "last" },
  ],
);
check(
  "…and an open stream outlived the 250ms request timeout",
  !events.some((event) => event.error?.message === "Request Timedout"),
);

/* ------------------------------------------------------------------ */
step("The request timeout fails a parked pipeline");

const parkedAt = performance.now();
checkEqual(
  "GET /parked: 500 once the 250ms timeout ran out, both ways",
  await bothWays("/parked", async (response) => response.status),
  [500, 500],
);
check(
  "…about 250ms each",
  performance.now() - parkedAt >= 490,
  performance.now() - parkedAt,
);
await app.setTimeout(60, () => undefined);
checkEqual("adapter.setTimeout(60, callback) changes it", app.timeout, 60);
const shorterAt = performance.now();
checkEqual(
  "…so GET /parked fails sooner",
  (await app.fetch("/parked")).status,
  500,
);
check(
  "…after ~60ms",
  performance.now() - shorterAt < 240,
  performance.now() - shorterAt,
);
await app.close();
process.env.NODE_ENV = nodeEnvBefore;

/* ------------------------------------------------------------------ */
step("A router with an overridden handle() is served through it");

/** Stamps every response it handles, then runs the pipeline as usual. */
class StampingRouter extends BunRouter {
  override async handle(options: PipelineOptions) {
    options.response.setHeader("X-Handled-By", "StampingRouter");
    return await super.handle(options);
  }
}
const stamping = new StampingRouter();
stamping.get("/x", async (_req, res) => {
  await Bun.sleep(1);
  res.send("x");
});
const stamped = await stamping.fetch("/x");
checkEqual(
  "router.fetch(): the override ran, the async handler answered",
  [stamped.headers.get("X-Handled-By"), await stamped.text()],
  ["StampingRouter", "x"],
);
const hosting = new BunHttpAdapter(0);
hosting.setInstance(stamping);
await hosting.listen(0);
const hostedServed = await fetch(`${hosting.url}/x`);
const hostedOffline = await hosting.fetch("/x");
checkEqual(
  "an adapter serving it: the override runs, served and through fetch()",
  [
    hostedServed.headers.get("X-Handled-By"),
    await hostedServed.text(),
    hostedOffline.headers.get("X-Handled-By"),
    await hostedOffline.text(),
  ],
  ["StampingRouter", "x", "StampingRouter", "x"],
);
await hosting.close();

/* ------------------------------------------------------------------ */
step("router.serveRequest(options, hooks): finish the pipeline your way");

const router = new BunRouter();
router.get("/sync", (_req, res) => res.send("answered synchronously"));
router.get("/async", async (_req, res) => {
  await Bun.sleep(1);
  res.send("answered after an await");
});
router.get("/stream", (_req, res) => {
  res.write("open;");
  setTimeout(() => void res.end("closed"), 20);
});
router.get("/boom", () => {
  throw new Error("boom");
});

/** Pipeline options for `GET path`, as an adapter builds them. */
function options(path: string): PipelineOptions {
  const request = BunRequest.init(
    new Request(`http://localhost${path}`),
    FETCH_STUB_SERVER,
    { parseBody: true },
  ) as BunRequest;
  return {
    requestHost: request.host,
    requestMethod: request.method,
    requestUrl: request.originalUrl,
    request,
    response: new BunResponse(request),
  };
}

/** Hooks that map the outcome to a Response of our own. */
const hooks: ServeHooks<Response> = {
  respond: (opts, routeUsed) =>
    routeUsed
      ? (opts.response.settledResponse ?? opts.response.getNativeResponse(0))
      : Response.json(
          { error: `no route for ${opts.requestUrl}` },
          { status: 404 },
        ),
  stream: (_opts, response) => response,
  error: (_opts, error) => new Error(`wrapped: ${(error as Error).message}`),
  lateError: (_opts, error) => show("late error", error),
};

const syncResult = router.serveRequest(options("/sync"), hooks);
check(
  "a synchronous pipeline: the Response itself",
  syncResult instanceof Response,
);
checkEqual(
  "…answered",
  await (await syncResult).text(),
  "answered synchronously",
);
const asyncResult = router.serveRequest(options("/async"), hooks);
check("an asynchronous one: one promise", asyncResult instanceof Promise);
checkEqual(
  "…answered",
  await (await asyncResult).text(),
  "answered after an await",
);
checkEqual(
  "a stream: hooks.stream's Response, read to its end",
  await (await router.serveRequest(options("/stream"), hooks)).text(),
  "open;closed",
);
const missing = await router.serveRequest(options("/none"), hooks);
checkEqual(
  "nothing matched: hooks.respond's own 404",
  [missing.status, await missing.json()],
  [404, { error: "no route for /none" }],
);
let thrown: unknown;
try {
  await router.serveRequest(options("/boom"), hooks);
} catch (error) {
  thrown = error;
}
checkEqual(
  "an unhandled error: thrown as hooks.error made it",
  (thrown as Error | undefined)?.message,
  "wrapped: boom",
);

summary();
