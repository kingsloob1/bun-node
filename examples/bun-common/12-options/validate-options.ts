/**
 * Option tour: every `BunValidateOptions` field, `validate()`, the
 * `BunValidate` class, `ValidationError`, `ValidationIssue` paths and
 * `toStandardSchema` — each asserted.
 *
 * ```bash
 * bun 12-options/validate-options.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - Targets run in a fixed order — headers, params, query, body — whatever
 *   order the schemas object lists them in. `abortEarly` stops at the first
 *   failing one in *that* order.
 * - `onFailure: "next"` and `"throw"` both reach a router's error handlers;
 *   the difference is only visible to whoever calls the middleware, so those
 *   checks call it directly with a request built by `BunRequest.init`.
 * - `hooks.<target>.transform` runs only on success, and its result is written
 *   back only when `replace` is on. Headers are never written back.
 * - The handler's types follow that: with `replace: false` it keeps the
 *   request's own types, and a hook on a target without a schema (which could
 *   never run) is a compile error. `formatError` answers any JSON value.
 * - The schemas here are built with `toStandardSchema`, so every message is
 *   known exactly.
 */
import type {
  JsonValue,
  NextFunction,
  ResolveBody,
  ResolveParams,
  ResolveQuery,
  RouterErrorMiddlewareHandler,
  RouterHandler,
  StandardSchemaV1,
  ValidatorMiddleware,
} from "@kingsleyweb/bun-common";
import {
  BunRequest,
  BunResponse,
  BunRouter,
  BunValidate,
  FETCH_STUB_SERVER,
  toStandardSchema,
  validate,
  ValidationError,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title } from "../shared/console";

/** A request to build for a direct middleware call. */
interface RequestSpec {
  /** Path and query string, e.g. `/check?page=2`. */
  url: string;
  /** A JSON body; its presence makes the request a POST. */
  body?: JsonValue;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Route params, as the router would have bound them. */
  params?: Record<string, string>;
}

/**
 * A request typed by what a validator advertises writing back — the same
 * narrowing a route handler after it gets. Nothing is narrowed for a
 * validator with `replace: false`.
 */
type ValidatedRequest<TShape> = BunRequest<
  ResolveParams<string, TShape>,
  ResolveQuery<TShape>,
  ResolveBody<TShape>
>;

/** What a direct middleware call left behind. */
interface Run<TShape> {
  /** The request, after the middleware had its way with it. */
  req: ValidatedRequest<TShape>;
  /** The response the middleware was handed. */
  res: BunResponse;
  /** The arguments of every `next(...)` call, in order. */
  nextCalls: Parameters<NextFunction>[];
}

/** What a request through a router came back with. */
interface Answer {
  /** The HTTP status. */
  status: number;
  /** The JSON body. */
  body: JsonValue;
}

title("Option tour: BunValidate");

/* ---- schemas with exact messages ---------------------------------- */

// Each schema's input is `unknown`: it is untrusted until the schema accepts it.

/** `{ page }` as a whole number ≥ 1. */
const Page = toStandardSchema<{ page: number }>((input) => {
  const raw = (input as { page?: unknown } | null)?.page;
  const page = Number(raw);
  return raw !== undefined && Number.isInteger(page) && page >= 1
    ? { value: { page } }
    : { issues: [{ message: "page must be a whole number", path: ["page"] }] };
});

/** `{ title }`, reported with a `{ key }` path segment. */
const Title = toStandardSchema<{ title: string }>((input) => {
  const title = (input as { title?: unknown } | null)?.title;
  return typeof title === "string" && title.length > 0
    ? { value: { title } }
    : { issues: [{ message: "title is required", path: [{ key: "title" }] }] };
});

/** `{ id }` as a number. */
const Id = toStandardSchema<{ id: number }>((input) => {
  const id = Number((input as { id?: unknown } | null)?.id);
  return Number.isNaN(id)
    ? { issues: [{ message: "id must be numeric", path: ["id"] }] }
    : { value: { id } };
});

/** An `x-token` header equal to `secret`. */
const Token = toStandardSchema<{ "x-token": string }>((input) => {
  const token = (input as Record<string, unknown>)["x-token"];
  return token === "secret"
    ? { value: { "x-token": token } }
    : { issues: [{ message: "bad token", path: ["x-token"] }] };
});

/** Rejects everything at the root: an issue with no path. */
const Nothing = toStandardSchema<never>(() => {
  return { issues: [{ message: "nothing is acceptable" }] };
});

/** Rejects with a deep path mixing keys, indexes and `{ key }` segments. */
const Deep = toStandardSchema<never>(() => {
  return {
    issues: [
      { message: "sku is required", path: ["items", 0, { key: "sku" }] },
    ],
  };
});

/* ---- helpers ------------------------------------------------------ */

/** Builds and initialises a request, parsing query and (JSON) body. */
async function buildRequest(spec: RequestSpec): Promise<BunRequest> {
  const hasBody = spec.body !== undefined;
  const req = await BunRequest.init(
    new Request(`http://localhost${spec.url}`, {
      method: hasBody ? "POST" : "GET",
      headers: {
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...spec.headers,
      },
      body: hasBody ? JSON.stringify(spec.body) : undefined,
    }),
    FETCH_STUB_SERVER,
    { parseBody: hasBody, parseQuery: true, parseCookies: false },
  );
  if (spec.params) {
    req.params = spec.params;
  }
  return req;
}

/**
 * Calls `middleware` directly, recording what it passed to `next`. The request
 * comes back typed by the shape the validator advertises, so a check on a
 * written-back value compares against the type the handler would see.
 */
async function run<TShape>(
  middleware: ValidatorMiddleware<TShape>,
  spec: RequestSpec,
): Promise<Run<TShape>> {
  const req = await buildRequest(spec);
  const res = new BunResponse(req);
  const nextCalls: Parameters<NextFunction>[] = [];
  await middleware(req, res, (...args) => {
    nextCalls.push(args);
  });
  // The middleware rewrote `req` in place; this is the type it says it wrote.
  return { req: req as ValidatedRequest<TShape>, res, nextCalls };
}

/** Sends a request through a router: `middleware`, then a handler echoing the request. */
async function through(
  middleware: RouterHandler,
  url: string,
  body?: JsonValue,
): Promise<Answer> {
  const router = new BunRouter();
  router.useMethod(
    body === undefined ? "GET" : "POST",
    "/check",
    middleware,
    (req, res) => {
      res.json({ reached: true, query: req.query, body: req.body });
    },
  );
  router.use(((error, _req, res, _next) => {
    res.status(599).json({ caught: (error as Error).name });
  }) satisfies RouterErrorMiddlewareHandler);

  const response = await router.fetch(url, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return {
    status: response.status,
    body: (await response.json()) as JsonValue,
  };
}

/** The first argument of the only `next` call, as a ValidationError. */
function passedError<TShape>(result: Run<TShape>): ValidationError | undefined {
  const [first] = result.nextCalls;
  const error = first?.[0];
  return error instanceof ValidationError ? error : undefined;
}

/* ------------------------------------------------------------------ */
step("schemas: each target is validated and written back");

const everyTarget = validate({
  headers: Token,
  params: Id,
  query: Page,
  body: Title,
});
const valid = await run(everyTarget, {
  url: "/check?page=3&extra=dropped",
  body: { title: "Hello", extra: "dropped" },
  headers: { "X-Token": "secret", "X-Other": "kept" },
  params: { id: "42" },
});
checkEqual("success calls next() with no argument", valid.nextCalls, [[]]);
checkEqual("params written back (coerced)", valid.req.params, {
  id: 42,
});
checkEqual("query written back (coerced, extras dropped)", valid.req.query, {
  page: 3,
});
checkEqual("body written back", valid.req.body, { title: "Hello" });
checkEqual(
  "headers are never written back",
  [valid.req.headers["x-token"], valid.req.headers["x-other"]],
  ["secret", "kept"],
);
check("…and the response was left alone", !valid.res.headersSent);

const noSchemas = await run(validate({}), { url: "/check?page=x" });
checkEqual("no schemas: next() and nothing touched", noSchemas.nextCalls, [[]]);
checkEqual("…query as parsed", noSchemas.req.query, { page: "x" });

/* ------------------------------------------------------------------ */
step("Targets run in a fixed order: headers, params, query, body");

const orderSeen: string[] = [];

/** A schema that records the order it ran in, then passes. */
function recording(name: string): StandardSchemaV1 {
  return toStandardSchema((input) => {
    orderSeen.push(name);
    return { value: input };
  });
}

await run(
  validate({
    body: recording("body"),
    query: recording("query"),
    params: recording("params"),
    headers: recording("headers"),
  }),
  { url: "/check", body: {}, params: {} },
);
checkEqual("order, whatever the object lists", orderSeen, [
  "headers",
  "params",
  "query",
  "body",
]);

/* ------------------------------------------------------------------ */
step("onFailure: 'next' (default)");

const nextMode = await run(validate({ query: Page }), { url: "/check?page=0" });
const nextError = passedError(nextMode);
check(
  "next() receives a ValidationError",
  nextError !== undefined,
  nextMode.nextCalls,
);
checkEqual("…exactly once", nextMode.nextCalls.length, 1);
check("…and nothing is sent", !nextMode.res.headersSent);
checkEqual(
  "through a router, the error handler catches it",
  await through(validate({ query: Page }), "/check?page=0"),
  { status: 599, body: { caught: "ValidationError" } },
);

/* ------------------------------------------------------------------ */
step("onFailure: 'throw'");

const throwing = validate({ query: Page }, { onFailure: "throw" });
const thrown = await checkRejects(
  "the middleware rejects with the ValidationError",
  () => run(throwing, { url: "/check?page=0" }),
  {
    name: "ValidationError",
    message: /query\.page: page must be a whole number/,
  },
);
check("…an instance of ValidationError", thrown instanceof ValidationError);
checkEqual(
  "through a router, an error handler catches it too",
  await through(throwing, "/check?page=0"),
  { status: 599, body: { caught: "ValidationError" } },
);
checkEqual(
  "a valid request still calls next()",
  (await run(throwing, { url: "/check?page=2" })).nextCalls,
  [[]],
);

/* ------------------------------------------------------------------ */
step("onFailure: 'respond', status and formatError");

checkEqual(
  "respond: 400 with the default body",
  await through(
    validate({ query: Page }, { onFailure: "respond" }),
    "/check?page=0",
  ),
  {
    status: 400,
    body: {
      error: "Validation failed",
      issues: [
        {
          target: "query",
          message: "page must be a whole number",
          path: "page",
        },
      ],
    },
  },
);
checkEqual(
  "respond: the handler is not reached",
  (
    await through(
      validate({ query: Page }, { onFailure: "respond" }),
      "/check?page=0",
    )
  ).status,
  400,
);
checkEqual(
  "status: 422 is the response status",
  (
    await through(
      validate({ query: Page }, { onFailure: "respond", status: 422 }),
      "/check?page=0",
    )
  ).status,
  422,
);
checkEqual("status defaults to 400 on the error", nextError?.status, 400);
checkEqual(
  "status is reported on the error in every mode",
  passedError(
    await run(validate({ query: Page }, { status: 409 }), { url: "/check" }),
  )?.status,
  409,
);

let formatArgs: { error: ValidationError; path: string } | undefined;
checkEqual(
  "formatError builds the respond body",
  await through(
    validate(
      { query: Page },
      {
        onFailure: "respond",
        status: 422,
        formatError: (error, req) => {
          formatArgs = { error, path: req.path };
          return { problems: error.issues.length, status: error.status };
        },
      },
    ),
    "/check?page=0",
  ),
  { status: 422, body: { problems: 1, status: 422 } },
);
check(
  "…and is handed the ValidationError and the request",
  formatArgs?.error instanceof ValidationError && formatArgs.path === "/check",
  formatArgs,
);
checkEqual(
  "formatError is ignored outside respond",
  (
    await through(
      validate({ query: Page }, { formatError: () => ({ never: true }) }),
      "/check?page=0",
    )
  ).body,
  { caught: "ValidationError" },
);

/* ------------------------------------------------------------------ */
step("abortEarly");

const allWrong = { url: "/check?page=0", body: {}, headers: {} };
checkEqual(
  "false (default): issues from every failing target",
  passedError(
    await run(validate({ headers: Token, query: Page, body: Title }), allWrong),
  )?.targets,
  ["headers", "query", "body"],
);
checkEqual(
  "true: only the first failing target, in the fixed order",
  passedError(
    await run(
      validate(
        { body: Title, query: Page, headers: Token },
        { abortEarly: true },
      ),
      allWrong,
    ),
  )?.targets,
  ["headers"],
);
const laterOnly = await run(
  validate({ query: Page, body: Title }, { abortEarly: true }),
  { url: "/check?page=2", body: {} },
);
checkEqual(
  "true: targets before the failure still pass and are written back",
  [passedError(laterOnly)?.targets, laterOnly.req.query],
  [["body"], { page: 2 }],
);

/* ------------------------------------------------------------------ */
step("replace");

const kept = await run(
  validate({ query: Page, params: Id }, { replace: false }),
  {
    url: "/check?page=5",
    params: { id: "9" },
  },
);
checkEqual("replace: false leaves the query raw", kept.req.query, {
  page: "5",
});
checkEqual("…and the params", kept.req.params, { id: "9" });
checkEqual("…but still validates (next with no error)", kept.nextCalls, [[]]);
checkEqual(
  "replace: false still fails invalid input",
  passedError(
    await run(validate({ query: Page }, { replace: false }), { url: "/check" }),
  )?.targets,
  ["query"],
);

/* ------------------------------------------------------------------ */
step("hooks: normalize and transform, per target");

const hookCalls: {
  /** The target the hook ran for. */
  target: string;
  /** `normalize` or `transform`. */
  hook: string;
  /** What the hook was handed; `unknown`, as each target hands a different shape. */
  value: unknown;
  /** The request's path. */
  path: string;
}[] = [];

const hooked = validate(
  { headers: Token, params: Id, query: Page, body: Title },
  {
    hooks: {
      headers: {
        normalize: (value, req) => {
          hookCalls.push({
            target: "headers",
            hook: "normalize",
            value: value["x-token"],
            path: req.path,
          });
          return { "x-token": String(value["x-token"]).trim() };
        },
      },
      params: {
        transform: (value, req) => {
          hookCalls.push({
            target: "params",
            hook: "transform",
            value,
            path: req.path,
          });
          return { ...value, idHex: value.id.toString(16) };
        },
      },
      query: {
        normalize: (value, req) => {
          hookCalls.push({
            target: "query",
            hook: "normalize",
            value,
            path: req.path,
          });
          return { page: String(value.page ?? "1") };
        },
        transform: (value, req) => {
          hookCalls.push({
            target: "query",
            hook: "transform",
            value,
            path: req.path,
          });
          return { ...value, offset: (value.page - 1) * 20 };
        },
      },
      body: {
        normalize: (value) => {
          return {
            title: String((value as { title?: unknown }).title ?? "").trim(),
          };
        },
      },
    },
  },
);

const hookedRun = await run(hooked, {
  url: "/check",
  body: { title: "  Padded  " },
  headers: { "X-Token": "secret" },
  params: { id: "255" },
});
checkEqual(
  "normalize runs before the schema (a missing page defaulted)",
  hookedRun.req.query,
  {
    page: 1,
    offset: 0,
  },
);
checkEqual(
  "normalize sees the raw value",
  hookCalls.find((call) => call.target === "query" && call.hook === "normalize")
    ?.value,
  {},
);
checkEqual(
  "transform sees the parsed value",
  hookCalls.find((call) => call.target === "query" && call.hook === "transform")
    ?.value,
  { page: 1 },
);
checkEqual("transform's result is written back", hookedRun.req.params, {
  id: 255,
  idHex: "ff",
});
checkEqual("body normalize trims before validating", hookedRun.req.body, {
  title: "Padded",
});
check(
  "hooks receive the request",
  hookCalls.every((call) => call.path === "/check"),
  hookCalls,
);
checkEqual(
  "headers normalize runs (the schema saw its output), headers unchanged",
  [hookedRun.nextCalls, hookedRun.req.headers["x-token"]],
  [[[]], "secret"],
);

hookCalls.length = 0;
const failedHooks = await run(hooked, {
  url: "/check?page=0",
  body: { title: "x" },
  headers: { "X-Token": "secret" },
  params: { id: "nope" },
});
checkEqual(
  "transform does not run for a target that failed",
  hookCalls
    .filter((call) => call.hook === "transform")
    .map((call) => call.target),
  [],
);
checkEqual(
  "…while normalize did",
  hookCalls.filter((call) => call.hook === "normalize").length,
  2,
);
checkEqual("failed targets", passedError(failedHooks)?.targets, [
  "params",
  "query",
]);

let transformRan = false;
const transformNoReplace = await run(
  validate(
    { query: Page },
    {
      replace: false,
      hooks: {
        query: {
          transform: (value) => {
            transformRan = true;
            return value;
          },
        },
      },
    },
  ),
  { url: "/check?page=4" },
);
checkEqual(
  "replace: false — transform runs, but nothing is written",
  [transformRan, transformNoReplace.req.query],
  [true, { page: "4" }],
);

let orphanRan = false;
const orphan = await run(
  validate(
    { query: Page },
    {
      hooks: {
        // @ts-expect-error — `body` has no schema, so this hook could never run.
        body: {
          normalize: (value: unknown) => {
            orphanRan = true;
            return value;
          },
        },
      },
    },
  ),
  { url: "/check?page=1", body: { title: "x" } },
);
checkEqual(
  "a hook on a target without a schema: a compile error, and it never runs",
  [orphanRan, orphan.nextCalls],
  [false, [[]]],
);

/* ------------------------------------------------------------------ */
step("Types follow what runs: replace and formatError");

/** Compile-time equality, checked by the examples typecheck. */
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
/** Fails to compile unless `T` is `true`. */
type Expect<T extends true> = T;

const typed = new BunRouter();
typed.get("/raw", validate({ query: Page }, { replace: false }), (req, res) => {
  // Nothing was written, so the handler keeps the request's own type.
  type _raw = Expect<Equal<typeof req.query, Record<string, unknown>>>;
  res.json({ page: req.query.page, type: typeof req.query.page });
});
typed.get("/parsed", validate({ query: Page }), (req, res) => {
  type _parsed = Expect<Equal<typeof req.query, { page: number }>>;
  res.json({ page: req.query.page, type: typeof req.query.page });
});
checkEqual(
  "replace: false — typed as the request's query, and the value is the raw string",
  await (await typed.fetch("/raw?page=5")).json(),
  { page: "5", type: "string" },
);
checkEqual(
  "replace: true — typed as the schema output, and the value is the number",
  await (await typed.fetch("/parsed?page=5")).json(),
  { page: 5, type: "number" },
);

checkEqual(
  "formatError may answer any JSON value — an array is sent as it is",
  await through(
    validate(
      { query: Page },
      {
        onFailure: "respond",
        formatError: (error) => error.issues.map((issue) => issue.message),
      },
    ),
    "/check?page=0",
  ),
  { status: 400, body: ["page must be a whole number"] },
);
checkEqual(
  "…a string too",
  await through(
    validate(
      { query: Page },
      { onFailure: "respond", formatError: () => "invalid" },
    ),
    "/check?page=0",
  ),
  { status: 400, body: "invalid" },
);

/* ------------------------------------------------------------------ */
step("ValidationError and ValidationIssue");

const multi = passedError(
  await run(validate({ query: Page, body: Title }), {
    url: "/check",
    body: {},
  }),
);
checkEqual("name", multi?.name, "ValidationError");
check("an Error", multi instanceof Error);
checkEqual(
  "message summarises every issue as target.path: message",
  multi?.message,
  "Request validation failed — query.page: page must be a whole number; body.title: title is required",
);
checkEqual("issues, flattened with their target", multi?.issues, [
  { target: "query", message: "page must be a whole number", path: "page" },
  { target: "body", message: "title is required", path: "title" },
]);

checkEqual(
  "a root issue has path ''",
  passedError(
    await run(validate({ body: Nothing }), { url: "/check", body: {} }),
  )?.issues,
  [{ target: "body", message: "nothing is acceptable", path: "" }],
);
checkEqual(
  "…and its message has no dot",
  passedError(
    await run(validate({ body: Nothing }), { url: "/check", body: {} }),
  )?.message,
  "Request validation failed — body: nothing is acceptable",
);
const deep = passedError(
  await run(validate({ body: Deep }), { url: "/check", body: {} }),
);
checkEqual(
  "keys, indexes and { key } segments join with dots",
  deep?.issues[0]?.path,
  "items.0.sku",
);

const handMade = new ValidationError(
  [
    { target: "body", message: "a", path: "x" },
    { target: "query", message: "b", path: "" },
    { target: "body", message: "c", path: "y" },
  ],
  418,
);
checkEqual("targets are de-duplicated, first-seen order", handMade.targets, [
  "body",
  "query",
]);
checkEqual("status is what the constructor was given", handMade.status, 418);

/* ------------------------------------------------------------------ */
step("BunValidate, BunValidate.middleware and validate()");

const schemas = { query: Page };
const instance = new BunValidate({ schemas, onFailure: "respond" });
check("schemas returns the object it was given", instance.schemas === schemas);
checkEqual(
  "instance.middleware() applies the instance's options",
  (await through(instance.middleware(), "/check?page=0")).status,
  400,
);
checkEqual(
  "BunValidate.middleware(options) is the same",
  (
    await through(
      BunValidate.middleware({ schemas, onFailure: "respond" }),
      "/check?page=0",
    )
  ).status,
  400,
);
checkEqual(
  "validate(schemas, options) is the same",
  (await through(validate(schemas, { onFailure: "respond" }), "/check?page=0"))
    .status,
  400,
);
const firstBuild = instance.middleware();
const secondBuild = instance.middleware();
check(
  "each middleware() call builds a new function",
  firstBuild !== secondBuild,
);

/* ------------------------------------------------------------------ */
step("toStandardSchema");

checkEqual("version is 1", Page["~standard"].version, 1);
checkEqual("vendor defaults to 'custom'", Page["~standard"].vendor, "custom");
checkEqual(
  "vendor can be named",
  toStandardSchema((value) => ({ value }), { vendor: "joi" })["~standard"]
    .vendor,
  "joi",
);
checkEqual("types is only a phantom", Page["~standard"].types, undefined);
checkEqual(
  "validate is the function given",
  await Page["~standard"].validate({ page: "7" }),
  { value: { page: 7 } },
);

const Slow = toStandardSchema<{ page: number }>(async (input) => {
  await Bun.sleep(5);
  return Page["~standard"].validate(input);
});
const slow = await run(validate({ query: Slow }), { url: "/check?page=6" });
checkEqual(
  "an async validate is awaited",
  [slow.nextCalls, slow.req.query],
  [[[]], { page: 6 }],
);

summary();
