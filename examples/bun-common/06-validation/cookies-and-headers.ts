/**
 * Validating cookies, signed cookies and headers, and reading every parsed
 * part from `req.valid` — each asserted.
 *
 * ```bash
 * bun 06-validation/cookies-and-headers.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - `cookies` and `signedCookies` are targets like `query`: the parsed value
 *   is written back to `req.cookies` / `req.signedCookies`, and typed there.
 * - A `cookies` schema cannot require a signature: a forged, unsigned cookie
 *   lands in `req.cookies` and passes. `req.signedCookies` holds only the
 *   cookies a secret verified (a tampered one as `false`, an unsigned one not
 *   at all), so a signed session is required with `signedCookies`.
 * - With `parseCookies: false` nothing is parsed, and a cookie schema is
 *   given `{}`, as for a request with no `Cookie` header.
 * - Headers are never written back: `req.headers` stays the raw strings that
 *   `accepts`, `type-is` and the multipart parser read. The parsed, typed
 *   headers are on `req.valid.headers`. Header schemas are keyed by the
 *   lower-case name.
 * - `req.valid` holds every part a validator parsed, by target.
 * - Targets run headers → cookies → signedCookies → params → query → body,
 *   so a cheap header or session check fails before a body is read.
 */
import type {
  JsonValue,
  RouterErrorMiddlewareHandler,
  StandardSchemaV1,
} from "@kingsleyweb/bun-common";
import {
  BunRouter,
  requestParsing,
  signCookie,
  toStandardSchema,
  validate,
  ValidationError,
} from "@kingsleyweb/bun-common";
import { z } from "zod";
import { check, checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";

/** What a request through a router came back with. */
interface Answer {
  /** The HTTP status. */
  status: number;
  /** The body, parsed as JSON. */
  body: JsonValue;
}

/** Compile-time equality, checked by the examples typecheck. */
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
/** Fails to compile unless `T` is `true`. */
type Expect<T extends true> = T;

title("Validating cookies, signed cookies and headers");

/** The secret signed cookies are signed and verified with. */
const SECRET = "keyboard cat";

/**
 * Sends a request through `router` and reads the JSON answer. An error no
 * handler caught comes back as status 0 with its message, so it fails one
 * check rather than ending the run.
 */
async function call(
  router: BunRouter,
  path: string,
  init?: RequestInit,
): Promise<Answer> {
  let response: Response;
  try {
    response = await router.fetch(path, init);
  } catch (error) {
    return {
      status: 0,
      body: error instanceof Error ? error.message : "a non-Error was thrown",
    };
  }
  return {
    status: response.status,
    body: (await response.json()) as JsonValue,
  };
}

/** The `{ target, path }` of each issue in a `"respond"` answer. */
function issuesOf(answer: Answer): { target: string; path: string }[] {
  const issues = (
    answer.body as { issues?: { target: string; path: string }[] }
  ).issues;
  return (issues ?? []).map(({ target, path }) => ({ target, path }));
}

/** Turns a response's `Set-Cookie` headers into a request `Cookie` header. */
function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
}

/* ------------------------------------------------------------------ */
step("cookies: written back to req.cookies, coerced");

const Prefs = z.object({
  visits: z.coerce.number().int().nonnegative(),
  theme: z.enum(["dark", "light"]).default("light"),
});

const cookieRouter = new BunRouter();
cookieRouter.get(
  "/prefs",
  validate({ cookies: Prefs }, { onFailure: "respond" }),
  (req, res) => {
    // Typed as the schema's output, like a validated query.
    type _cookies = Expect<
      Equal<typeof req.cookies, { visits: number; theme: "dark" | "light" }>
    >;
    res.json({
      cookies: req.cookies,
      type: typeof req.cookies.visits,
    });
  },
);

checkEqual(
  "a valid cookie: written back coerced, unknown cookies stripped",
  await call(cookieRouter, "/prefs", {
    headers: { Cookie: "visits=3; tracker=abc" },
  }),
  {
    status: 200,
    body: { cookies: { visits: 3, theme: "light" }, type: "number" },
  },
);
const badCookie = await call(cookieRouter, "/prefs", {
  headers: { Cookie: "visits=lots" },
});
checkEqual(
  "an invalid cookie: 400, its issue's target is cookies",
  [badCookie.status, issuesOf(badCookie)],
  [400, [{ target: "cookies", path: "visits" }]],
);

/* ------------------------------------------------------------------ */
step("signedCookies: only a cookie the secret verified gets through");

const Session = z.object({ sid: z.string().min(1) });

const sessions = new BunRouter();
// Cookie parsing with a secret: `req.secret` signs, `req.signedCookies`
// holds what it verifies.
sessions.use(requestParsing({ parseCookies: { secret: SECRET } }));
sessions.get("/login", (_req, res) => {
  res.cookie("sid", "user-42", { signed: true, httpOnly: true });
  res.json({ ok: true });
});
sessions.get(
  "/me",
  validate({ signedCookies: Session }, { onFailure: "respond" }),
  (req, res) => {
    type _signed = Expect<Equal<typeof req.signedCookies, { sid: string }>>;
    res.json({ sid: req.signedCookies.sid });
  },
);
// What the parser verified, before any schema.
sessions.get("/raw", (req, res) => {
  res.json({ signedCookies: req.signedCookies ?? null });
});
// What a `cookies` schema sees of the same requests.
sessions.get(
  "/unsigned",
  validate(
    { cookies: z.object({ sid: z.string() }) },
    { onFailure: "respond" },
  ),
  (req, res) => {
    res.json({ sid: req.cookies.sid });
  },
);

const jar = cookieHeaderFrom(await sessions.fetch("/login"));
check("the login set a signed cookie (s:…)", jar.startsWith("sid=s%3A"), jar);
checkEqual(
  "a correctly signed cookie passes, unsigned, into req.signedCookies",
  await call(sessions, "/me", { headers: { Cookie: jar } }),
  { status: 200, body: { sid: "user-42" } },
);

const forgedUnsigned = await call(sessions, "/me", {
  headers: { Cookie: "sid=user-1" },
});
checkEqual(
  "a forged unsigned cookie is absent from req.signedCookies: 400 on signedCookies",
  [forgedUnsigned.status, issuesOf(forgedUnsigned)],
  [400, [{ target: "signedCookies", path: "sid" }]],
);
checkEqual(
  "…not there at all: req.signedCookies is {}",
  (await call(sessions, "/raw", { headers: { Cookie: "sid=user-1" } })).body,
  { signedCookies: {} },
);
checkEqual(
  "…while a cookies schema lets the same forgery through",
  await call(sessions, "/unsigned", { headers: { Cookie: "sid=user-1" } }),
  { status: 200, body: { sid: "user-1" } },
);

const wrongSecret = `sid=${encodeURIComponent(`s:${signCookie("user-1", "not the secret")}`)}`;
const forgedSigned = await call(sessions, "/me", {
  headers: { Cookie: wrongSecret },
});
checkEqual(
  "a cookie signed with the wrong secret is false: 400 on signedCookies",
  [forgedSigned.status, issuesOf(forgedSigned)],
  [400, [{ target: "signedCookies", path: "sid" }]],
);

checkEqual(
  "…the parser made it false",
  (await call(sessions, "/raw", { headers: { Cookie: wrongSecret } })).body,
  { signedCookies: { sid: false } },
);

const tampered = jar.replace("user-42", "user-1");
check(
  "the tampered jar differs from the signed one",
  tampered !== jar,
  tampered,
);
const tamperedAnswer = await call(sessions, "/me", {
  headers: { Cookie: tampered },
});
checkEqual(
  "a tampered signed cookie is false: 400 on signedCookies",
  [tamperedAnswer.status, issuesOf(tamperedAnswer)],
  [400, [{ target: "signedCookies", path: "sid" }]],
);
checkEqual(
  "…the parser made it false",
  (await call(sessions, "/raw", { headers: { Cookie: tampered } })).body,
  { signedCookies: { sid: false } },
);

/* ------------------------------------------------------------------ */
step("parseCookies: false — a cookie schema is given {}");

const handedToSchema: unknown[] = [];

/** Accepts anything, recording what it was given. */
const Recorder = toStandardSchema<Record<string, unknown>>((input) => {
  handedToSchema.push(input);
  return { value: input as Record<string, unknown> };
});

const unparsed = new BunRouter();
unparsed.get(
  "/off",
  requestParsing({ parseCookies: false }),
  validate({ cookies: Recorder, signedCookies: Recorder }),
  (req, res) => {
    res.json({ cookies: req.cookies, signedCookies: req.signedCookies });
  },
);
checkEqual(
  "both schemas are given {}, though a Cookie header was sent",
  [
    (await call(unparsed, "/off", { headers: { Cookie: "visits=3" } })).body,
    handedToSchema,
  ],
  [{ cookies: {}, signedCookies: {} }, [{}, {}]],
);

const required = new BunRouter();
required.get(
  "/off",
  requestParsing({ parseCookies: false }),
  validate({ cookies: Prefs }, { onFailure: "respond" }),
  (_req, res) => {
    res.json({ reached: true });
  },
);
const requiredOff = await call(required, "/off", {
  headers: { Cookie: "visits=3" },
});
checkEqual(
  "…so a required cookie fails as absent, at its own path",
  [requiredOff.status, issuesOf(requiredOff)],
  [400, [{ target: "cookies", path: "visits" }]],
);

/* ------------------------------------------------------------------ */
step("headers: typed on req.valid.headers, req.headers stays raw");

const Retry = z.object({ "x-retry": z.coerce.number().int().min(0) });

const headerRouter = new BunRouter();
headerRouter.get(
  "/retry",
  validate({ headers: Retry }, { onFailure: "respond" }),
  (req, res) => {
    type _valid = Expect<
      Equal<typeof req.valid.headers, { "x-retry": number }>
    >;
    type _raw = Expect<
      Equal<typeof req.headers, Record<string, string | string[]>>
    >;
    res.json({
      valid: req.valid.headers["x-retry"],
      validType: typeof req.valid.headers["x-retry"],
      raw: req.headers["x-retry"],
      rawType: typeof req.headers["x-retry"],
    });
  },
);
checkEqual(
  "the coerced header is a number on req.valid, the raw string on req.headers",
  await call(headerRouter, "/retry", { headers: { "X-Retry": "3" } }),
  {
    status: 200,
    body: { valid: 3, validType: "number", raw: "3", rawType: "string" },
  },
);
const badHeader = await call(headerRouter, "/retry", {
  headers: { "X-Retry": "soon" },
});
checkEqual(
  "an invalid header: 400, its issue's target is headers",
  [badHeader.status, issuesOf(badHeader)],
  [400, [{ target: "headers", path: "x-retry" }]],
);

const capitalised = new BunRouter();
capitalised.get(
  "/retry",
  validate(
    { headers: z.object({ "X-Retry": z.string() }) },
    { onFailure: "respond" },
  ),
  (_req, res) => {
    res.json({ reached: true });
  },
);
checkEqual(
  "a header schema keyed by a capitalised name never matches",
  (await call(capitalised, "/retry", { headers: { "X-Retry": "3" } })).status,
  400,
);

/* ------------------------------------------------------------------ */
step("req.valid holds every part a validator parsed");

const everything = new BunRouter();
everything.use(requestParsing({ parseCookies: { secret: SECRET } }));
everything.post(
  "/posts/:id",
  validate({
    headers: Retry,
    cookies: z.object({ theme: z.enum(["dark", "light"]) }),
    signedCookies: Session,
    params: z.object({ id: z.coerce.number().int() }),
    query: z.object({ page: z.coerce.number().int() }),
    body: z.object({ title: z.string() }),
  }),
  (req, res) => {
    type _query = Expect<Equal<typeof req.valid.query, { page: number }>>;
    res.json({ valid: req.valid, keys: Object.keys(req.valid) });
  },
);
everything.get("/plain", (req, res) => {
  res.json({ valid: req.valid });
});
checkEqual(
  "every target, parsed, in the order they ran",
  await call(everything, "/posts/7?page=2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Retry": "1",
      Cookie: `theme=dark; ${jar}`,
    },
    body: JSON.stringify({ title: "Hello", extra: "dropped" }),
  }),
  {
    status: 200,
    body: {
      valid: {
        headers: { "x-retry": 1 },
        cookies: { theme: "dark" },
        signedCookies: { sid: "user-42" },
        params: { id: 7 },
        query: { page: 2 },
        body: { title: "Hello" },
      },
      keys: ["headers", "cookies", "signedCookies", "params", "query", "body"],
    },
  },
);
checkEqual(
  "a route without a validator: req.valid is {}",
  await call(everything, "/plain"),
  { status: 200, body: { valid: {} } },
);

/* ------------------------------------------------------------------ */
step("The order: headers, cookies, signedCookies, params, query, body");

const ran: string[] = [];

/** A schema that records that it ran, then fails. */
function failing(name: string): StandardSchemaV1 {
  return toStandardSchema(() => {
    ran.push(name);
    return { issues: [{ message: `${name} is wrong` }] };
  });
}

/** Every target failing, listed in reverse so the order cannot come from the object. */
const allFailing = {
  body: failing("body"),
  query: failing("query"),
  params: failing("params"),
  signedCookies: failing("signedCookies"),
  cookies: failing("cookies"),
  headers: failing("headers"),
};

const reported: string[][] = [];
const ordered = new BunRouter();
ordered.post("/order/:id", validate(allFailing), (_req, res) => {
  res.json({ reached: true });
});
ordered.post(
  "/early/:id",
  validate(allFailing, { abortEarly: true }),
  (_req, res) => {
    res.json({ reached: true });
  },
);
ordered.use(((error, _req, res, _next) => {
  reported.push(error instanceof ValidationError ? error.targets : []);
  res.status(400).json({ caught: true });
}) satisfies RouterErrorMiddlewareHandler);

/** A POST with a JSON body and a cookie, so every target has something. */
const everyPart: RequestInit = {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: "theme=dark" },
  body: "{}",
};

await ordered.fetch("/order/1?page=1", everyPart);
const sixTargets = [
  "headers",
  "cookies",
  "signedCookies",
  "params",
  "query",
  "body",
];
checkEqual(
  "the schemas ran in the fixed order, not the object's",
  ran,
  sixTargets,
);
checkEqual("…and the error reports them in it", reported[0], sixTargets);

ran.length = 0;
await ordered.fetch("/early/1?page=1", everyPart);
checkEqual(
  "abortEarly: a failing header stops it before cookies or the body",
  [ran, reported[1]],
  [["headers"], ["headers"]],
);

summary();
