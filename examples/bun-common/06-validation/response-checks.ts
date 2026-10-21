/**
 * Checking what a route answers: `validate()`'s `responses`, keyed by
 * status, and `responseValidation` deciding what a mismatch does — each
 * asserted.
 *
 * ```bash
 * bun 06-validation/response-checks.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - Each status takes a schema (a JSON body), `null` (no body), or
 *   `{ headers?, cookies?, content? }` with `content` keyed by media type.
 *   A status the table does not list is a mismatch, whatever the body.
 * - `responseValidation` is `"off"` (the default: nothing is installed),
 *   `"warn"` (the response is sent and one line is logged, with no value
 *   from it) or `"error"` (the response is refused before anything goes out,
 *   and a `ResponseValidationError`, status 500, goes to the error
 *   handlers). It is set on the validator, else the router, else the
 *   adapter: the most specific wins.
 * - Header schemas see lower-case names, `Content-Type` included. Cookie
 *   schemas see each `Set-Cookie` line by name as a `SetCookieView`:
 *   `{ value, httpOnly, secure, partitioned, sameSite?, path?, domain?,
 *   maxAge?, expires?, priority? }`, `maxAge` in seconds as the header has it.
 * - Media keys may name a family (`text/*`) or anything (the `*`/`*` key).
 *   The most specific wins (exact, then the family, then anything), and
 *   parameters are ignored on both sides.
 * - `commonResponses` on a router or adapter declares the statuses every
 *   route may answer (an auth 401, the error handler's 500), merged with a
 *   route's per status and per part, the route winning.
 * - Exempt or softened: a freshness 304 needs no declaration, HEAD is
 *   checked as its GET, and an error handler's own response is only
 *   reported, never replaced.
 * - Only buffered bodies are read here (JSON, text, bytes, a Blob, a
 *   passed-through `Response`). Streams, `sendFile()`'s bytes, `chunks()`,
 *   `sse()` and `opaque()` are in `streaming-responses.ts`.
 */
import type {
  BunResponse,
  JsonValue,
  LogEvent,
  RouterErrorMiddlewareHandler,
  SetCookieView,
  StandardSchemaV1,
} from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunRouter,
  cors,
  createTestLogger,
  ResponseValidationError,
  validate,
} from "@kingsleyweb/bun-common";
import { z } from "zod";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Checking responses against their contract");

/** A user, as the routes below promise to answer it. */
const User = z.object({ id: z.string(), name: z.string() });

/** A problem body, for the 4xx statuses. */
const Problem = z.object({ code: z.string() });

/**
 * A lookup whose declared type is wider than the truth, as a database row's
 * or an upstream API's can be: it says `User`, and here returns an `id`
 * that is a number, beside a `name` the logs must never show.
 */
function legacyLookup(): z.input<typeof User> {
  return JSON.parse('{"id":42,"name":"LEAK-ada"}') as z.input<typeof User>;
}

/**
 * Sends `418` from a helper that takes a bare `BunResponse`: helpers like
 * this escape the handler's typed `res`, so only the runtime check sees the
 * status.
 */
function teapot(res: BunResponse): void {
  res.status(418).json({ id: "u1", name: "Ada" });
}

/**
 * Sends `body` as JSON from a helper that takes a bare `BunResponse`, so the
 * handler's typed `res` does not hold it to a declared body.
 */
function untypedJson(res: BunResponse, body: JsonValue): void {
  res.json(body);
}

/**
 * Renders any error as a JSON 500, a `ResponseValidationError` with its
 * refused status and each issue as `part.path` (never the refused value).
 */
const renderRefusal = ((error, _req, res, _next) => {
  if (error instanceof ResponseValidationError) {
    res.status(500).json({
      error: error.name,
      responseStatus: error.responseStatus,
      issues: error.issues.map((issue) =>
        issue.path === "" ? issue.target : `${issue.target}.${issue.path}`,
      ),
    });
    return;
  }
  res.status(500).json({ error: String(error) });
}) satisfies RouterErrorMiddlewareHandler;

/** What a request came back with. */
interface Answer {
  /** The HTTP status. */
  status: number;
  /** The body: parsed JSON when it parses, else the text. */
  body: unknown;
  /** The response headers. */
  headers: Headers;
}

/**
 * Sends a request through `target` and reads the answer. An error no
 * handler caught comes back as status 0 with its name, so it fails one check
 * rather than ending the run.
 */
async function call(
  target: { fetch: (path: string, init?: RequestInit) => Promise<Response> },
  path: string,
  init?: RequestInit,
): Promise<Answer> {
  let response: Response;
  try {
    response = await target.fetch(path, init);
  } catch (error) {
    return {
      status: 0,
      body: error instanceof Error ? error.name : "a non-Error was thrown",
      headers: new Headers(),
    };
  }
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status, body, headers: response.headers };
}

/** The warnings a response mismatch logged. */
function mismatches(events: LogEvent[]): LogEvent[] {
  return events.filter(
    (event) =>
      event.level === "warn" && event.message.includes("does not match"),
  );
}

/** The `[status, body]` of an answer, for one comparison. */
function statusAndBody(answer: Answer): [number, unknown] {
  return [answer.status, answer.body];
}

/* ------------------------------------------------------------------ */
step('The three modes: "off" sends anything, "warn" logs, "error" refuses');

/**
 * A router in `mode`, logging into a test sink, with one route promising a
 * `User` and answering whatever `legacyLookup()` returns.
 */
function userRouter(mode: "off" | "warn" | "error") {
  const { logger, events } = createTestLogger();
  const router = new BunRouter({ logger, responseValidation: mode });
  router.get(
    "/users/me",
    validate({}, { responses: { 200: User } }),
    (_req, res) => {
      res.json(legacyLookup());
    },
  );
  router.use(renderRefusal);
  return { router, events };
}

const off = userRouter("off");
checkEqual(
  '"off": the bad body is sent as it is',
  statusAndBody(await call(off.router, "/users/me")),
  [200, { id: 42, name: "LEAK-ada" }],
);
checkEqual('"off": nothing is logged', off.events, []);

const warn = userRouter("warn");
checkEqual(
  '"warn": the bad body is sent too',
  statusAndBody(await call(warn.router, "/users/me")),
  [200, { id: 42, name: "LEAK-ada" }],
);
const warned = mismatches(warn.events);
checkEqual(
  '"warn": one line, naming the method, route, status and issue',
  warned.map((event) => ({
    message: event.message,
    method: event.fields.method,
    route: event.fields.route,
    status: event.fields.status,
    paths: (event.fields.issues as { target: string; path: string }[]).map(
      (issue) => `${issue.target}.${issue.path}`,
    ),
  })),
  [
    {
      message: "response does not match its contract",
      method: "GET",
      route: "/users/me",
      status: 200,
      paths: ["body.id"],
    },
  ],
);
show("the warning's fields", warned[0]?.fields);
check(
  '"warn": the line carries no value from the response',
  !JSON.stringify(warn.events).includes("LEAK"),
  warn.events,
);

const strict = userRouter("error");
const refused = await call(strict.router, "/users/me");
checkEqual(
  '"error": refused; the error handler gets a ResponseValidationError',
  statusAndBody(refused),
  [
    500,
    {
      error: "ResponseValidationError",
      responseStatus: 200,
      issues: ["body.id"],
    },
  ],
);
check(
  '"error": nothing of the refused body went out',
  !JSON.stringify(refused.body).includes("LEAK"),
  refused.body,
);
checkEqual(
  '"error": nothing logged, and the 500 rendering the refusal is not checked again',
  mismatches(strict.events),
  [],
);

const unhandled = new BunRouter({ responseValidation: "error" });
unhandled.get(
  "/users/me",
  validate({}, { responses: { 200: User } }),
  (_req, res) => {
    res.json(legacyLookup());
  },
);
const thrown = await checkRejects(
  '"error" with no error handler: router.fetch() rejects with it',
  () => unhandled.fetch("/users/me"),
  { name: "ResponseValidationError", message: /status 200.*body\.id/ },
);
check(
  "…its status is 500 and its message carries no value",
  thrown instanceof ResponseValidationError &&
    thrown.status === 500 &&
    !thrown.message.includes("LEAK"),
  thrown,
);

const bareLog = createTestLogger();
const bareAdapter = new BunHttpAdapter(0, {
  logger: bareLog.logger,
  responseValidation: "error",
});
bareAdapter.get(
  "/users/me",
  validate({}, { responses: { 200: User } }),
  (_req, res) => {
    res.json(legacyLookup());
  },
);
const adapterAnswer = await call(bareAdapter, "/users/me");
check(
  "…and an adapter with no error handler answers 500, without the value",
  adapterAnswer.status === 500 &&
    !JSON.stringify(adapterAnswer.body).includes("LEAK"),
  adapterAnswer,
);
checkEqual(
  "…logging the unhandled ResponseValidationError at error",
  bareLog.events
    .filter((event) => event.level === "error")
    .map((event) => event.error?.name),
  ["ResponseValidationError"],
);

/* ------------------------------------------------------------------ */
step("An undeclared status is a mismatch, whatever the body");

const statusRouter = new BunRouter({ responseValidation: "error" });
let statusMessage = "";
statusRouter.get(
  "/brew",
  validate({}, { responses: { 200: User, 404: Problem } }),
  (_req, res) => {
    teapot(res);
  },
);
statusRouter.use(((error, req, res, next) => {
  if (error instanceof ResponseValidationError) {
    statusMessage = error.issues[0]?.message ?? "";
  }
  renderRefusal(error, req, res, next);
}) satisfies RouterErrorMiddlewareHandler);

checkEqual(
  "418 with a perfectly good User body: refused on the status",
  statusAndBody(await call(statusRouter, "/brew")),
  [
    500,
    {
      error: "ResponseValidationError",
      responseStatus: 418,
      issues: ["status"],
    },
  ],
);
checkEqual(
  "…the issue names the declared statuses, not the one sent",
  statusMessage,
  "This status is not declared (200, 404)",
);

/* ------------------------------------------------------------------ */
step("A wrong JSON body: every issue names its part and path");

const bodyRouter = new BunRouter({ responseValidation: "error" });
bodyRouter.get(
  "/users/:id",
  validate({}, { responses: { 200: User } }),
  (req, res) => {
    if (req.params.id === "good") {
      res.json({ id: "u1", name: "Ada" });
      return;
    }
    // Both fields wrong: the id a number, the name missing.
    res.json(JSON.parse('{"id":7}') as z.input<typeof User>);
  },
);
bodyRouter.use(renderRefusal);

checkEqual(
  'a body matching the schema is sent unchanged under "error"',
  statusAndBody(await call(bodyRouter, "/users/good")),
  [200, { id: "u1", name: "Ada" }],
);
checkEqual(
  "two wrong fields: both reported, as body.id and body.name",
  statusAndBody(await call(bodyRouter, "/users/bad")),
  [
    500,
    {
      error: "ResponseValidationError",
      responseStatus: 200,
      issues: ["body.id", "body.name"],
    },
  ],
);

/* ------------------------------------------------------------------ */
step("Headers and cookies are parts of the contract too");

const seenCookies: Record<string, SetCookieView>[] = [];

/** Records each cookie view it is given, then checks the session cookie. */
const SessionCookie = z.object({
  sid: z.object({
    value: z.string().min(1),
    httpOnly: z.literal(true),
    secure: z.literal(true),
    sameSite: z.literal("Strict"),
    maxAge: z.number().max(3600),
  }),
});
const RecordingCookies: StandardSchemaV1<
  Record<string, SetCookieView>,
  z.output<typeof SessionCookie>
> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (value) => {
      seenCookies.push(value as Record<string, SetCookieView>);
      return SessionCookie["~standard"].validate(value);
    },
  },
};

const sessionRouter = new BunRouter({ responseValidation: "error" });
sessionRouter.post(
  "/login",
  validate(
    {},
    {
      responses: {
        200: {
          headers: z.object({
            "x-ratelimit-remaining": z.string().regex(/^\d+$/),
          }),
          cookies: RecordingCookies,
          content: { "application/json": z.object({ ok: z.literal(true) }) },
        },
      },
    },
  ),
  (req, res) => {
    const variant = req.query.variant;
    res.set("X-RateLimit-Remaining", variant === "bad-header" ? "plenty" : "9");
    res.cookie("sid", "abc123", {
      httpOnly: variant !== "no-httponly",
      secure: true,
      sameSite: "strict",
      // `res.cookie()` takes milliseconds; the view, like the header, seconds.
      maxAge: variant === "too-long" ? 2 * 3_600_000 : 1_800_000,
    });
    res.json({ ok: true });
  },
);
sessionRouter.use(renderRefusal);

const loggedIn = await call(sessionRouter, "/login", { method: "POST" });
checkEqual(
  "the declared header and cookie: sent",
  [loggedIn.status, loggedIn.headers.getSetCookie().length],
  [200, 1],
);
const view = seenCookies[0]?.sid;
checkEqual(
  "the cookie schema saw a SetCookieView: maxAge in seconds, SameSite capitalised",
  view === undefined ? undefined : { ...view, expires: typeof view.expires },
  {
    value: "abc123",
    httpOnly: true,
    secure: true,
    partitioned: false,
    sameSite: "Strict",
    path: "/",
    maxAge: 1800,
    expires: "object",
  },
);
check("…expires parsed into a Date", view?.expires instanceof Date, view);

/** POSTs `/login` with one thing wrong; answers status and issues. */
async function loginWith(variant: string): Promise<[number, unknown]> {
  const answer = await call(sessionRouter, `/login?variant=${variant}`, {
    method: "POST",
  });
  return [answer.status, (answer.body as { issues?: unknown }).issues];
}

checkEqual(
  "a header outside its schema: refused at headers.x-ratelimit-remaining",
  await loginWith("bad-header"),
  [500, ["headers.x-ratelimit-remaining"]],
);
checkEqual(
  "a session cookie without HttpOnly: refused at cookies.sid.httpOnly",
  await loginWith("no-httponly"),
  [500, ["cookies.sid.httpOnly"]],
);
checkEqual(
  "a cookie living two hours (7200 s): refused at cookies.sid.maxAge",
  await loginWith("too-long"),
  [500, ["cookies.sid.maxAge"]],
);

/* ------------------------------------------------------------------ */
step("Wildcard media keys: the most specific wins, parameters ignored");

const mediaRouter = new BunRouter({ responseValidation: "error" });
mediaRouter.get(
  "/media/:kind",
  validate(
    {},
    {
      responses: {
        200: {
          content: {
            // Any text at all: at most 5 characters…
            "text/*": z.string().max(5),
            // …but plain text, the exact key, may be any length.
            "text/plain": z.string(),
            // A declared parameter does not have to be sent.
            "text/csv; header=present": z.string().startsWith("id,"),
            // Anything else: bytes.
            "*/*": z.instanceof(Uint8Array),
          },
        },
      },
    },
  ),
  (req, res) => {
    switch (req.params.kind) {
      case "plain":
        res.send("a line far longer than five characters");
        return;
      case "short-html":
        res.type("html").send("<b>");
        return;
      case "long-html":
        res.type("html").send("<p>longer than five</p>");
        return;
      case "csv":
        res.type("TEXT/CSV; charset=utf-8").send("id,name\n1,Ada");
        return;
      case "bad-csv":
        res.type("text/csv").send("name\nAda");
        return;
      case "png":
        res.type("png").send(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
        return;
      default:
        // JSON falls under */*, which expects bytes: the schema sees the
        // value, not its text, and refuses it.
        untypedJson(res, { id: "u1" });
    }
  },
);
mediaRouter.use(renderRefusal);

/** The status of `/media/<kind>`. */
async function mediaStatus(kind: string): Promise<number> {
  return (await call(mediaRouter, `/media/${kind}`)).status;
}

checkEqual(
  "text/plain;charset=utf-8, long: the exact text/plain key wins over text/*",
  await mediaStatus("plain"),
  200,
);
checkEqual(
  "text/html, 3 characters: falls to text/*, which allows it",
  await mediaStatus("short-html"),
  200,
);
checkEqual(
  "text/html, long: falls to text/*, which refuses it",
  await mediaStatus("long-html"),
  500,
);
checkEqual(
  "TEXT/CSV; charset=utf-8 matches the key text/csv; header=present",
  [await mediaStatus("csv"), await mediaStatus("bad-csv")],
  [200, 500],
);
checkEqual(
  "image/png: only */* matches, and sees the bytes",
  await mediaStatus("png"),
  200,
);
checkEqual(
  "application/json under */*: refused (the value is not bytes)",
  await mediaStatus("json"),
  500,
);
await checkRejects(
  "two keys equal once bare and lower-cased: a TypeError when declared",
  () =>
    validate(
      {},
      {
        responses: {
          200: {
            content: {
              "text/plain": z.string(),
              "Text/Plain; charset=utf-8": z.string(),
            },
          },
        },
      },
    ),
  { name: "TypeError", message: /are the same media type/ },
);

/* ------------------------------------------------------------------ */
step("commonResponses: statuses every route may answer, merged per part");

/** Answers 401 the way an auth helper shared by many routes would. */
function unauthorized(res: BunResponse, body: JsonValue): void {
  res.status(401).json(body);
}

const api = new BunRouter({
  responseValidation: "error",
  commonResponses: {
    401: Problem,
    404: {
      headers: z.object({ "x-reason": z.string() }),
      content: { "application/json": Problem },
    },
  },
});
api.get(
  "/orders/:id",
  validate(
    {},
    {
      responses: {
        200: z.object({ id: z.string() }),
        // The route's own 404 body is text; the router's 404 header still applies.
        404: { content: { "text/plain": z.string() } },
      },
    },
  ),
  (req, res) => {
    switch (req.params.id) {
      case "anon":
        unauthorized(res, { code: "AUTH" });
        return;
      case "anon-bad":
        unauthorized(res, { message: "no code" });
        return;
      case "gone":
        res.status(404).set("X-Reason", "deleted").send("gone");
        return;
      case "gone-no-reason":
        res.status(404).send("gone");
        return;
      default:
        res.json({ id: req.params.id });
    }
  },
);
api.get("/unchecked", validate({ query: z.object({}) }), (_req, res) => {
  teapot(res);
});
api.use(renderRefusal);

/** The `[status, issues]` of `path` on the API router. */
async function apiAnswer(path: string): Promise<[number, unknown]> {
  const answer = await call(api, path);
  return [
    answer.status,
    (answer.body as { issues?: unknown } | null)?.issues ?? null,
  ];
}

checkEqual("the route's own 200: sent", await apiAnswer("/orders/o1"), [
  200,
  null,
]);
checkEqual(
  "a 401 the route never declared, from commonResponses: sent",
  await apiAnswer("/orders/anon"),
  [401, null],
);
checkEqual(
  "…held to the common Problem body",
  await apiAnswer("/orders/anon-bad"),
  [500, ["body.code"]],
);
checkEqual(
  "404: the route's text body replaces the common JSON one…",
  await apiAnswer("/orders/gone"),
  [404, null],
);
checkEqual(
  "…while the common X-Reason header still applies (merged per part)",
  await apiAnswer("/orders/gone-no-reason"),
  [500, ["headers.x-reason"]],
);
checkEqual(
  "a route whose validator declares no responses is not checked",
  (await call(api, "/unchecked")).status,
  418,
);

/* ------------------------------------------------------------------ */
step("Precedence: the validator, then the router, then the adapter");

const adapterLog = createTestLogger();
const routerLog = createTestLogger();
const app = new BunHttpAdapter(0, {
  logger: adapterLog.logger,
  responseValidation: "error",
});

/** A route promising a User and sending the bad one, with an optional own mode. */
function badUserRoute(
  router: BunRouter,
  path: string,
  own?: "off" | "warn" | "error",
): void {
  router.get(
    path,
    validate(
      {},
      own === undefined
        ? { responses: { 200: User } }
        : { responses: { 200: User }, responseValidation: own },
    ),
    (_req, res) => {
      res.json(legacyLookup());
    },
  );
}

/** No setting of its own: the adapter's "error" applies. */
const plain = new BunRouter();
badUserRoute(plain, "/inherits");
/** "warn" here beats the adapter's "error"; one route says "off" itself. */
const lenient = new BunRouter({
  logger: routerLog.logger,
  responseValidation: "warn",
});
badUserRoute(lenient, "/router-warns");
badUserRoute(lenient, "/validator-off", "off");
/** "off" here, but one validator insists on "error". */
const quiet = new BunRouter({ responseValidation: "off" });
badUserRoute(quiet, "/validator-errors", "error");

app.use("/plain", plain);
app.use("/lenient", lenient);
app.use("/quiet", quiet);
app.use(renderRefusal);

/** The status of `path` on the adapter and how many mismatches were logged. */
async function precedence(path: string): Promise<[number, number]> {
  adapterLog.events.length = 0;
  routerLog.events.length = 0;
  const status = (await call(app, path)).status;
  return [
    status,
    mismatches(adapterLog.events).length + mismatches(routerLog.events).length,
  ];
}

checkEqual(
  'a router without a setting: the adapter\'s "error" refuses (500)',
  await precedence("/plain/inherits"),
  [500, 0],
);
checkEqual(
  "the router's \"warn\" beats the adapter's: sent, one warning",
  await precedence("/lenient/router-warns"),
  [200, 1],
);
checkEqual(
  'the validator\'s "off" beats its router\'s "warn": sent, nothing logged',
  await precedence("/lenient/validator-off"),
  [200, 0],
);
checkEqual(
  'the validator\'s "error" beats its router\'s "off": refused',
  await precedence("/quiet/validator-errors"),
  [500, 0],
);

/* ------------------------------------------------------------------ */
step('Under "error": the refused response\'s own headers are dropped');

const crossOrigin = new BunRouter({ responseValidation: "error" });
crossOrigin.use(cors({ origin: "https://app.example" }));
crossOrigin.get(
  "/go",
  validate(
    {},
    {
      responses: {
        302: { headers: z.object({ location: z.string().startsWith("/app") }) },
      },
    },
  ),
  (_req, res) => {
    res.vary("Accept-Language");
    res.cookie("sid", "abc");
    res.set("ETag", '"v1"');
    res.set("Content-Disposition", "attachment");
    // Not under /app: the Location breaks the contract.
    res.redirect(302, "/elsewhere");
  },
);
crossOrigin.use(renderRefusal);

const dropped = await call(crossOrigin, "/go", {
  headers: { Origin: "https://app.example" },
});
checkEqual(
  "refused at headers.location, answered 500 by the error handler",
  [dropped.status, (dropped.body as { issues?: unknown }).issues],
  [500, ["headers.location"]],
);
checkEqual(
  "its Location, Set-Cookie, ETag and Content-Disposition are gone",
  {
    location: dropped.headers.get("location"),
    setCookie: dropped.headers.getSetCookie(),
    etag: dropped.headers.get("etag"),
    disposition: dropped.headers.get("content-disposition"),
  },
  { location: null, setCookie: [], etag: null, disposition: null },
);
checkEqual(
  "the request-wide CORS and Vary headers are kept",
  {
    allowOrigin: dropped.headers.get("access-control-allow-origin"),
    // Origin from cors(), Accept-Language from the handler, and Accept from
    // redirect(), whose body is chosen by Accept: Vary is kept whole.
    vary: dropped.headers.get("vary"),
  },
  {
    allowOrigin: "https://app.example",
    vary: "Origin, Accept-Language, Accept",
  },
);

/* ------------------------------------------------------------------ */
step("A freshness 304 needs no declaration; HEAD is checked as GET");

/** Sends 304 with no conditional request behind it: not a freshness answer. */
function bare304(res: BunResponse): void {
  void res.status(304).end();
}

const cachedLog = createTestLogger();
const cached = new BunRouter({
  logger: cachedLog.logger,
  responseValidation: "error",
});
cached.get(
  "/profile/:who",
  validate({}, { responses: { 200: User } }),
  (req, res) => {
    if (req.params.who === "broken") {
      res.json(legacyLookup());
      return;
    }
    res.setEtag(true).json({ id: "u1", name: "Ada" });
  },
);
cached.get(
  "/stale",
  validate({}, { responses: { 200: User } }),
  (_req, res) => {
    bare304(res);
  },
);
cached.use(renderRefusal);

const first = await call(cached, "/profile/ada");
const etag = first.headers.get("etag") ?? "";
check(
  "the first GET is a 200 with an ETag",
  first.status === 200 && etag !== "",
  first,
);
checkEqual(
  "If-None-Match with that ETag: 304, though only 200 is declared",
  (await call(cached, "/profile/ada", { headers: { "If-None-Match": etag } }))
    .status,
  304,
);
checkEqual("…and nothing was logged", mismatches(cachedLog.events), []);
checkEqual(
  "a 304 with no conditional request is undeclared: refused",
  (await call(cached, "/stale")).status,
  500,
);
checkEqual(
  "HEAD runs the GET handler and is checked as it: good 200, bad 500",
  [
    (await call(cached, "/profile/ada", { method: "HEAD" })).status,
    (await call(cached, "/profile/broken", { method: "HEAD" })).status,
  ],
  [200, 500],
);

/* ------------------------------------------------------------------ */
step("An error handler's own response is only reported, never replaced");

const failingLog = createTestLogger();
const failing = new BunRouter({
  logger: failingLog.logger,
  responseValidation: "error",
});
failing.get("/report", validate({}, { responses: { 200: User } }), () => {
  throw new Error("database down");
});
failing.use(((_error, _req, res, _next) => {
  // 503 is declared nowhere: refusing it would mask the real error.
  res.status(503).json({ error: "unavailable" });
}) satisfies RouterErrorMiddlewareHandler);

checkEqual(
  "the error handler's undeclared 503 is sent",
  statusAndBody(await call(failing, "/report")),
  [503, { error: "unavailable" }],
);
checkEqual(
  "…and reported once, as the error handler's",
  mismatches(failingLog.events).map((event) => [
    event.message,
    event.fields.status,
  ]),
  [
    [
      "error handler's response does not match its contract (reported, not replaced)",
      503,
    ],
  ],
);

/** The same route, with the error handler's 503 declared for every route. */
const declaredLog = createTestLogger();
const declared503 = new BunRouter({
  logger: declaredLog.logger,
  responseValidation: "error",
  commonResponses: { 503: z.object({ error: z.string() }) },
});
declared503.get("/report", validate({}, { responses: { 200: User } }), () => {
  throw new Error("database down");
});
declared503.use(((_error, _req, res, _next) => {
  res.status(503).json({ error: "unavailable" });
}) satisfies RouterErrorMiddlewareHandler);
checkEqual(
  "declared in commonResponses, the same 503 is sent and nothing is reported",
  [(await call(declared503, "/report")).status, mismatches(declaredLog.events)],
  [503, []],
);

summary();
