/**
 * Per-route parsing — `requestParsing()` middleware, the adapter's
 * `deferBody` request option, and the request methods underneath them.
 *
 * ```bash
 * bun 04-request/per-route-parsing.ts
 * ```
 *
 * - The adapter's `request` options apply to every request.
 *   `requestParsing(options)` changes them for the routes it is mounted on,
 *   and parses that request again before calling `next()`, as body-parser and
 *   cookie-parser do: `parseQuery` (`false`, `true` or picoquery options),
 *   `parseCookies` (`false`, `true` or `{ secret, decode }`) and `parseBody`
 *   (`false`, `true` or a `ParseBodyConfig`). Only that request
 *   changes; the adapter's options and other requests never do.
 * - A body over the route's cap, or with an encoding it refuses, goes to
 *   `next(err)` as a 413, 415 or 400, so error handlers see it. A wrongly
 *   typed option is a `TypeError` when the middleware is created.
 * - By default the body is read, capped and parsed while the request is
 *   built — an oversized one is refused before routing — so a route can only
 *   **lower** its cap. With `deferBody: true` a request with a body is routed
 *   unread and read on first need (`requestParsing`, a body-parser
 *   middleware, `await req.ready()`, `req.parseBody()`, or the router just
 *   before the first route handler), so a route can also **raise** it. A
 *   request without a body is never deferred.
 * - The building blocks, for one request: `req.applyParseBodyOptions()`,
 *   `req.readDeferredBody()`, `req.hasDeferredBody`, `req.setCookieOptions()`
 *   and `req.configuredCookieSecrets`.
 */
import type {
  RequestParsingOptions,
  RouterErrorMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunRequest,
  FETCH_STUB_SERVER,
  PayloadTooLargeError,
  requestParsing,
  signCookie,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";

title("Per-route parsing");

/** Answers an error as `{ status, error }` JSON, so a test can read it. */
const errorsAsJson = ((error, _req, res, _next) => {
  const status = (error as { status?: number }).status ?? 500;
  res.status(status).json({ status, error: (error as Error).name });
}) satisfies RouterErrorMiddlewareHandler;

/** A `POST` of `body` as JSON. */
function postJson(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

/* ------------------------------------------------------------------ */
step("Query and cookies, per route");

const secretA = "new-secret";
const secretB = "old-secret";
const app = new BunHttpAdapter(0);
const before = structuredClone(app.requestOpts);

app.use("/flat", requestParsing({ parseQuery: { nesting: false } }));
app.use("/no-query", requestParsing({ parseQuery: false }));
app.use("/no-cookies", requestParsing({ parseCookies: false }));
app.use(
  "/raw-cookies",
  // Keep values exactly as sent: the default decoder percent-decodes them.
  requestParsing({ parseCookies: { decode: (value) => value } }),
);
app.use(
  "/account",
  requestParsing({ parseCookies: { secret: [secretA, secretB] } }),
);
app.all("/*", (req, res) => {
  res.json({
    query: req.query,
    cookies: req.cookies,
    signedCookies: req.signedCookies,
    secret: req.secret ?? null,
  });
});

/** GETs `path` with `cookie` and answers the JSON the catch-all wrote. */
async function look(path: string, cookie = "") {
  const response = await app.fetch(path, { headers: { Cookie: cookie } });
  return (await response.json()) as {
    query: unknown;
    cookies: unknown;
    signedCookies: unknown;
    secret: string | null;
  };
}

checkEqual("default: a[b]=1 nests", (await look("/default?a[b]=1")).query, {
  a: { b: "1" },
});
checkEqual(
  "parseQuery: { nesting: false }: kept flat",
  (await look("/flat?a[b]=1")).query,
  { "a[b]": "1" },
);
checkEqual(
  "parseQuery: false: an empty query",
  (await look("/no-query?a=1")).query,
  {},
);
checkEqual(
  "parseCookies: false: no cookies",
  (await look("/no-cookies", "a=1")).cookies,
  {},
);
checkEqual(
  "default: a cookie value is percent-decoded",
  (await look("/default", "name=J%C3%B6rg")).cookies,
  { name: "Jörg" },
);
checkEqual(
  "parseCookies: { decode }: applied (it used to be ignored)",
  (await look("/raw-cookies", "name=J%C3%B6rg")).cookies,
  { name: "J%C3%B6rg" },
);

// cookie-parser's format: `s:` + the value signed with a secret.
const signedWithOld = `s:${signCookie("alice", secretB)}`;
const cookie = `user=${encodeURIComponent(signedWithOld)}`;
const account = await look("/account", cookie);
checkEqual(
  "parseCookies: { secret }: a cookie signed with any of the secrets verifies",
  account.signedCookies,
  { user: "alice" },
);
checkEqual("…and req.secret is the first", account.secret, secretA);
const elsewhere = await look("/default", cookie);
checkEqual(
  "…on that route only: elsewhere nothing verifies",
  { signed: elsewhere.signedCookies, secret: elsewhere.secret },
  { signed: {}, secret: null },
);
checkEqual("the adapter's options never changed", app.requestOpts, before);

/* ------------------------------------------------------------------ */
step("parseBody without deferBody: a route can only lower the cap");

const eager = new BunHttpAdapter(0, {
  request: { parseBody: { maxContentLength: 64 } },
});
eager.use("/tight", requestParsing({ parseBody: { maxContentLength: 16 } }));
eager.use("/loose", requestParsing({ parseBody: { maxContentLength: "1mb" } }));
eager.use("/off", requestParsing({ parseBody: false }));
eager.post("/*", (req, res) => res.json({ body: req.body ?? null }));
eager.use(errorsAsJson);

const medium = { pad: "x".repeat(30) }; // ~42 bytes: under 64, over 16
const large = { pad: "x".repeat(200) };
checkEqual(
  "under the adapter's 64 bytes: parsed",
  await (await eager.fetch("/anything", postJson(medium))).json(),
  { body: medium },
);
checkEqual(
  "/tight (16 bytes): the same body is a 413 through next(err)",
  await (await eager.fetch("/tight", postJson(medium))).json(),
  { status: 413, error: "PayloadTooLargeError" },
);
checkEqual(
  "/loose (1mb): no help — refused before routing",
  (await eager.fetch("/loose", postJson(large))).status,
  413,
);
checkEqual(
  "/off (parseBody: false): the parsed body is dropped",
  await (await eager.fetch("/off", postJson(medium))).json(),
  { body: null },
);

/* ------------------------------------------------------------------ */
step("deferBody: routed unread, so a route can raise its cap");

const deferred = new BunHttpAdapter(0, {
  request: { parseBody: { maxContentLength: 64 }, deferBody: true },
});
/** What the first middleware saw, per path. */
const sawFirst: Record<string, { body: unknown; deferred: boolean }> = {};
deferred.use((req, _res, next) => {
  sawFirst[req.path] = { body: req.body, deferred: req.hasDeferredBody };
  next();
});
deferred.use(
  "/upload",
  requestParsing({ parseBody: { maxContentLength: "1mb" } }),
);
deferred.post("/upload", (req, res) => {
  res.json({ bytes: JSON.stringify(req.body).length });
});
deferred.post("/small", (req, res) => res.json({ body: req.body ?? null }));
deferred.get("/bodiless", (req, res) => {
  res.json({ deferred: req.hasDeferredBody });
});
/** What the `/ready` middleware saw around its `await req.ready()`. */
let readySaw: { pending: boolean; now: boolean; body: unknown } | undefined;
deferred.use("/ready", async (req, _res, next) => {
  // Middleware, so ahead of the router's own read before the route handler.
  const pending = req.hasDeferredBody;
  await req.ready();
  readySaw = { pending, now: req.hasDeferredBody, body: req.body };
  next();
});
deferred.post("/ready", (_req, res) => res.json(readySaw ?? null));
deferred.use(errorsAsJson);

checkEqual(
  "/upload: 200 bytes, over the adapter's 64 but under the route's 1mb",
  await (await deferred.fetch("/upload", postJson(large))).json(),
  { bytes: JSON.stringify(large).length },
);
checkEqual(
  "…and the middleware before it saw the body unread",
  sawFirst["/upload"],
  { body: undefined, deferred: true },
);
checkEqual(
  "/small: the adapter's 64 bytes still apply — a 413",
  await (await deferred.fetch("/small", postJson(large))).json(),
  { status: 413, error: "PayloadTooLargeError" },
);
checkEqual(
  "/small within it: read just before the route handler",
  await (await deferred.fetch("/small", postJson(medium))).json(),
  { body: medium },
);
checkEqual(
  "await req.ready() reads it on demand",
  await (await deferred.fetch("/ready", postJson(medium))).json(),
  { pending: true, now: false, body: medium },
);
checkEqual(
  "a request without a body is never deferred",
  await (await deferred.fetch("/bodiless")).json(),
  { deferred: false },
);
check(
  "…and is still built synchronously",
  BunRequest.init(new Request("http://localhost/"), FETCH_STUB_SERVER, {
    parseBody: true,
    deferBody: true,
  }) instanceof BunRequest,
);

// A body-parser middleware is a first need too, and its `limit` applies.
const parsers = new BunHttpAdapter(0, {
  request: { parseBody: true, deferBody: true },
});
parsers.useBodyParser("json", true, { limit: 32 });
parsers.post("/json", (req, res) => res.json({ body: req.body ?? null }));
parsers.use(errorsAsJson);
checkEqual(
  "useBodyParser({ limit: 32 }) reads the deferred body under its limit",
  await (await parsers.fetch("/json", postJson(medium))).json(),
  { status: 413, error: "PayloadTooLargeError" },
);
checkEqual(
  "…within it, parsed",
  await (await parsers.fetch("/json", postJson({ a: 1 }))).json(),
  { body: { a: 1 } },
);

/* ------------------------------------------------------------------ */
step("The request methods underneath");

/** A JSON request with a body, built with `deferBody`. */
async function deferredRequest(body: unknown): Promise<BunRequest> {
  return await BunRequest.init(
    new Request("http://localhost/", postJson(body)),
    FETCH_STUB_SERVER,
    { parseBody: { maxContentLength: 64 }, deferBody: true },
  );
}

const unread = await deferredRequest(medium);
check("hasDeferredBody before a read", unread.hasDeferredBody);
const read = unread.readDeferredBody();
check("readDeferredBody() reads it", read instanceof Promise);
await read;
checkEqual("…parsed", unread.body, medium);
checkEqual(
  "…and then has nothing more to read",
  unread.readDeferredBody(),
  undefined,
);

const raised = await deferredRequest(large);
await raised.applyParseBodyOptions({ maxContentLength: "1mb" });
checkEqual(
  "applyParseBodyOptions(): a raised cap reads it",
  raised.body,
  large,
);

const lowered = await deferredRequest(medium);
let loweredError: unknown;
try {
  await lowered.applyParseBodyOptions({ maxContentLength: 8 });
} catch (error) {
  loweredError = error;
}
check(
  "…a lowered one rejects with PayloadTooLargeError",
  loweredError instanceof PayloadTooLargeError,
  loweredError,
);

const cookies = BunRequest.init(
  new Request("http://localhost/", {
    headers: { Cookie: `user=${encodeURIComponent(signedWithOld)}` },
  }),
  FETCH_STUB_SERVER,
  { parseBody: true },
) as BunRequest;
checkEqual("no secret configured", cookies.configuredCookieSecrets, []);
cookies.setCookieOptions({ secret: [secretA, secretB] });
checkEqual(
  "setCookieOptions({ secret }): configuredCookieSecrets",
  cookies.configuredCookieSecrets,
  [secretA, secretB],
);
cookies.parseCookies({ forceUpdateRequest: true });
checkEqual("…then parseCookies() verifies with them", cookies.signedCookies, {
  user: "alice",
});

/* ------------------------------------------------------------------ */
step("Wrongly typed options fail when the middleware is created");

const wrong: [string, unknown][] = [
  ["parseQuery: 'yes'", { parseQuery: "yes" }],
  ["parseCookies: { secret: [1] }", { parseCookies: { secret: [1] } }],
  ["parseBody: '1mb'", { parseBody: "1mb" }],
  ["parseQuery: null", { parseQuery: null }],
  // The adapter's deprecated names are not requestParsing() options at all.
  [
    "parseQueryOpts (use parseQuery: {…})",
    { parseQueryOpts: { nesting: false } },
  ],
  ["cookieSecret (use parseCookies: { secret })", { cookieSecret: "s" }],
  [
    "cookieParseOptions (use parseCookies: { decode })",
    { cookieParseOptions: {} },
  ],
];
for (const [label, options] of wrong) {
  let error: unknown;
  try {
    requestParsing(options as RequestParsingOptions);
  } catch (caught) {
    error = caught;
  }
  check(`${label}: TypeError`, error instanceof TypeError, error);
}

summary();
