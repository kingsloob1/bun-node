/**
 * Synchronous validation: when every schema answers synchronously, the
 * `validate()` middleware does too — `next` has already been called when it
 * returns — and a schema that answers with a Promise makes it wait. Each
 * asserted.
 *
 * ```bash
 * bun 06-validation/synchronous-validation.ts
 * ```
 *
 * zod, valibot and arktype validate synchronously. yup's Standard Schema
 * `validate` always returns a Promise, as does any async schema (a database
 * lookup inside a refinement). The middleware stays synchronous until the
 * first schema that answers with a Promise, so a request through sync
 * schemas costs no `await` and no extra turn of the event loop.
 *
 * The checks call the middleware directly, with a request built by
 * `BunRequest.init`, so they can see what it returns before anything is
 * awaited. The guards `createReceiver` and `createSender`, and
 * `validateStandard` follow the same rule.
 */
import type { NextFunction, RouterHandler } from "@kingsleyweb/bun-common";
import {
  BunRequest,
  BunResponse,
  BunRouter,
  createReceiver,
  defineTransport,
  FETCH_STUB_SERVER,
  validate,
  validateStandard,
  ValidationError,
} from "@kingsleyweb/bun-common";
import { type } from "arktype";
import * as v from "valibot";
import * as yup from "yup";
import { z } from "zod";
import { check, checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";

/** What one direct call of a middleware did before anything was awaited. */
interface Call {
  /** What the middleware returned. */
  returned: unknown;
  /** The arguments of every `next(...)` call made before it returned. */
  nextBeforeReturn: Parameters<NextFunction>[];
  /** Every `next(...)` call, read once the returned value (if any) settled. */
  nextCalls: Parameters<NextFunction>[];
  /** The request, after the middleware wrote back what it parsed. */
  req: BunRequest;
}

/** Builds a request for `url`, with a JSON body when one is given, and extra `headers`. */
async function buildRequest(
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<BunRequest> {
  const hasBody = body !== undefined;
  return BunRequest.init(
    new Request(`http://localhost${url}`, {
      method: hasBody ? "POST" : "GET",
      headers: {
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: hasBody ? JSON.stringify(body) : undefined,
    }),
    FETCH_STUB_SERVER,
    { parseBody: hasBody, parseQuery: true, parseCookies: false },
  );
}

/** Calls `middleware` once and records what had happened by the time it returned. */
async function call(
  middleware: RouterHandler,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Call> {
  const req = await buildRequest(url, body, headers);
  const nextCalls: Parameters<NextFunction>[] = [];
  const returned = middleware(req, new BunResponse(req), (...args) => {
    nextCalls.push(args);
  });
  const nextBeforeReturn = [...nextCalls];
  await returned;
  return { returned, nextBeforeReturn, nextCalls, req };
}

title("Synchronous validation");

/* ------------------------------------------------------------------ */
step("Synchronous schemas: next() has run when the middleware returns");

const zodQuery = validate({
  query: z.object({ page: z.coerce.number().int().min(1) }),
});
const passed = await call(zodQuery, "/posts?page=2");
check(
  "zod: the middleware returned no Promise",
  !(passed.returned instanceof Promise),
  passed.returned,
);
checkEqual(
  "…next() had already been called, with nothing",
  passed.nextBeforeReturn,
  [[]],
);
checkEqual("…and req.query was already parsed", passed.req.query, { page: 2 });

const failed = await call(zodQuery, "/posts?page=0");
check(
  "a failure is synchronous too: no Promise",
  !(failed.returned instanceof Promise),
  failed.returned,
);
check(
  "…next(err) had already been called with a ValidationError",
  failed.nextBeforeReturn.length === 1 &&
    failed.nextBeforeReturn[0]?.[0] instanceof ValidationError,
  failed.nextBeforeReturn,
);

const everySync = validate({
  headers: type({ "x-client": "string" }),
  query: v.object({ q: v.string() }),
  body: z.object({ title: z.string() }),
});
const allPassed = await call(
  everySync,
  "/search?q=bun",
  { title: "Hello" },
  { "x-client": "web" },
);
check(
  "arktype headers, valibot query and zod body: still no Promise",
  !(allPassed.returned instanceof Promise),
  allPassed.returned,
);
checkEqual(
  "…and next() already called, with nothing",
  allPassed.nextBeforeReturn,
  [[]],
);

const noHeader = await call(everySync, "/search?q=bun", { title: "Hello" });
check(
  "without the header, the same middleware fails synchronously",
  !(noHeader.returned instanceof Promise) &&
    noHeader.nextBeforeReturn[0]?.[0] instanceof ValidationError,
  noHeader,
);

/* ------------------------------------------------------------------ */
step("A schema that answers with a Promise makes the middleware wait");

const yupBody = validate({
  body: yup.object({ title: yup.string().required() }),
});
const waited = await call(yupBody, "/posts", { title: "Hello" });
check(
  "yup: the middleware returned a Promise",
  waited.returned instanceof Promise,
  waited.returned,
);
checkEqual(
  "…next() had not been called when it returned",
  waited.nextBeforeReturn,
  [],
);
checkEqual("…and had been once it settled", waited.nextCalls, [[]]);

const syncFirst = validate({
  query: z.object({ q: z.string() }),
  body: yup.object({ title: yup.string().required() }),
});
const half = await call(syncFirst, "/posts?q=bun", { title: "Hello" });
check(
  "zod query then yup body: one async schema is enough to make it a Promise",
  half.returned instanceof Promise && half.nextBeforeReturn.length === 0,
  half,
);
checkEqual("…which settles with next() called", half.nextCalls, [[]]);

/* ------------------------------------------------------------------ */
step("The guards and validateStandard follow the same rule");

const Title = z.object({ title: z.string() });
check(
  "validateStandard with zod returns the outcome itself",
  !(validateStandard(Title, { title: "x" }, "body") instanceof Promise),
);
check(
  "validateStandard with yup returns a Promise",
  validateStandard(
    yup.object({ title: yup.string() }),
    { title: "x" },
    "body",
  ) instanceof Promise,
);

const jobs = defineTransport({ name: "jobs", inbound: { parts: ["data"] } });
const syncReceiver = createReceiver(
  jobs.contract({ inbound: { data: Title } }),
  "inbound",
);
const asyncReceiver = createReceiver(
  jobs.contract({ inbound: { data: yup.object({ title: yup.string() }) } }),
  "inbound",
);
const parsedNow = syncReceiver({ data: { title: "x" } });
check(
  "a receiver over zod answers synchronously",
  !(parsedNow instanceof Promise),
  parsedNow,
);
check(
  "a receiver over yup answers with a Promise",
  asyncReceiver({ data: { title: "x" } }) instanceof Promise,
);

/* ------------------------------------------------------------------ */
step("Through a router, both behave the same to the client");

const router = new BunRouter();
router.get("/sync", zodQuery, (req, res) => {
  res.json({ page: req.query.page });
});
router.post("/async", yupBody, (req, res) => {
  res.json({ title: req.body.title });
});
const viaSync = await router.fetch("/sync?page=3");
const viaAsync = await router.fetch("/async", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Hello" }),
});
checkEqual(
  "the sync route and the async route both answer",
  [await viaSync.json(), await viaAsync.json()],
  [{ page: 3 }, { title: "Hello" }],
);

summary();
