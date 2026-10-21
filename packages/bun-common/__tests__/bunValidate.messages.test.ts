/**
 * `validate()`'s `messages: "generic"` and `redactPaths` (plan
 * `docs/plans/bun-validate/` Q-C2, Q-C3; extended from the contract guards to
 * `validate()` by the user's decision of 2026-10-21): the guards' options,
 * with their names and semantics, on every issue a validator's schemas
 * report. Request side: the `ValidationError` under `"respond"` (its body),
 * `"next"` and `"throw"`. Response side: `ResponseValidationError` and the
 * `"warn"` log, buffered and streamed bodies, and a mount's validator
 * combined with a route's.
 *
 * Each case first asserts the default (the vendor's message, the path with
 * its user-chosen key), so a case whose vendor stops producing them fails
 * rather than passing vacuously.
 */
import type { BunResponse } from "../lib/BunResponse";
import type { ValidationIssue } from "../lib/BunValidate";
import type { LogEvent } from "../lib/logging";
import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import { describe, expect, it } from "bun:test";
import * as yup from "yup";
import { z } from "zod";
import { BunRouter } from "../lib/BunRouter";
import { BunValidate, validate, ValidationError } from "../lib/BunValidate";
import { createTestLogger } from "../lib/logging";
import { sse } from "../lib/responseBodies";
import { ResponseValidationError } from "../lib/responseValidation";
import { makeRequest, makeResponse } from "./helpers";

/** A key the sender chose, which a path names. */
const EMAIL = "alice@example.com";

/** The wording options under test, each case's expected issue beside it. */
interface Wording {
  /** The case's name. */
  name: string;
  /** The options passed to `validate()`. */
  options: { messages?: "generic"; redactPaths?: boolean };
}

const DEFAULT: Wording = { name: "unset", options: {} };
const GENERIC: Wording = {
  name: 'messages: "generic"',
  options: { messages: "generic" },
};
const REDACT: Wording = { name: "redactPaths", options: { redactPaths: true } };
const BOTH: Wording = {
  name: "both",
  options: { messages: "generic", redactPaths: true },
};

/** One vendor's failing body: the schema, what is sent, and the issue under each wording. */
interface VendorCase {
  /** The vendor. */
  vendor: string;
  /** The body schema. */
  schema: StandardSchemaV1;
  /** A body it rejects. */
  bad: unknown;
  /** The vendor's own message for it (the default, unscrubbed). */
  message: string;
  /** The message under `messages: "generic"`. */
  generic: string;
  /** The issue's default path. */
  path: string;
}

const VENDORS: VendorCase[] = [
  {
    // A record keyed by user data: the path is the sender's e-mail (Q-C2).
    vendor: "zod",
    schema: z.record(z.string(), z.number()),
    bad: { [EMAIL]: "x" },
    message: "Invalid input: expected number, received string",
    generic: "Invalid value (invalid_type)",
    path: EMAIL,
  },
  {
    // yup quotes values in some messages; this one quotes none, so only
    // "generic" replaces it, and yup has no issue code to name.
    vendor: "yup",
    schema: yup.object({ contact: yup.string().email().required() }),
    bad: { contact: "no" },
    message: "contact must be a valid email",
    generic: "Invalid value",
    path: "contact",
  },
];

/** The issue `c` reports under `wording`. */
function expected(c: VendorCase, wording: Wording): ValidationIssue<"body"> {
  return {
    target: "body",
    message: wording.options.messages === "generic" ? c.generic : c.message,
    path: wording.options.redactPaths === true ? "" : c.path,
  };
}

/** A JSON POST of `body`. */
const post = (body: unknown) =>
  ({
    url: "http://localhost/x",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as const;

// ---------------------------------------------------------------------------
// Request side
// ---------------------------------------------------------------------------

describe("request side: every issue a validator reports", () => {
  for (const c of VENDORS) {
    for (const wording of [DEFAULT, GENERIC, REDACT, BOTH]) {
      describe(`${c.vendor}, ${wording.name}`, () => {
        it('"respond": the 400 body carries the worded issues', async () => {
          const router = new BunRouter();
          router.post(
            "/x",
            validate(
              { body: c.schema },
              { onFailure: "respond", ...wording.options },
            ),
            (_req, res) => res.send("unreachable"),
          );
          const response = await router.fetch("/x", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(c.bad),
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({
            error: "Validation failed",
            issues: [expected(c, wording)],
          });
        });

        it('"respond" with formatError: the error it is given is worded too', async () => {
          const router = new BunRouter();
          router.post(
            "/x",
            validate(
              { body: c.schema },
              {
                onFailure: "respond",
                formatError: (error) => ({
                  issues: error.issues.map((i) => ({ ...i })),
                  message: error.message,
                }),
                ...wording.options,
              },
            ),
            (_req, res) => res.send("unreachable"),
          );
          const response = await router.fetch("/x", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(c.bad),
          });
          const issue = expected(c, wording);
          expect(await response.json()).toEqual({
            issues: [issue],
            message: `Request validation failed — body${issue.path ? `.${issue.path}` : ""}: ${issue.message}`,
          });
        });

        it('"next": the ValidationError handed on is worded', async () => {
          const middleware = validate({ body: c.schema }, wording.options);
          const req = await makeRequest(post(c.bad));
          const res = await makeResponse(post(c.bad));
          let handed: unknown;
          await middleware(req, res, (error?: unknown) => {
            handed = error;
          });
          expect(handed).toBeInstanceOf(ValidationError);
          const error = handed as ValidationError;
          const issue = expected(c, wording);
          expect(error.issues).toEqual([issue]);
          expect(error.message).toBe(
            `Request validation failed — body${issue.path ? `.${issue.path}` : ""}: ${issue.message}`,
          );
        });

        it('"throw": the ValidationError thrown is worded', async () => {
          const middleware = new BunValidate({
            schemas: { body: c.schema },
            onFailure: "throw",
            ...wording.options,
          }).middleware();
          const req = await makeRequest(post(c.bad));
          const res = await makeResponse(post(c.bad));
          // zod throws synchronously; yup's Promise rejects.
          const caught = await Promise.resolve()
            .then(() => middleware(req, res, () => {}))
            .then(
              () => undefined,
              (error: unknown) => error,
            );
          expect(caught).toBeInstanceOf(ValidationError);
          expect((caught as ValidationError).issues).toEqual([
            expected(c, wording),
          ]);
        });
      });
    }
  }

  it("applies to every target and every issue, and keeps target and order", async () => {
    const middleware = validate(
      {
        headers: z.object({ "x-n": z.coerce.number() }),
        query: z.object({ page: z.coerce.number().int() }),
        body: z.object({ a: z.string(), b: z.string() }),
      },
      { messages: "generic", redactPaths: true },
    );
    const init = {
      ...post({ a: 1, b: 2 }),
      url: "http://localhost/x?page=1.5",
      headers: { "content-type": "application/json", "x-n": "nan" },
    };
    const req = await makeRequest(init);
    const res = await makeResponse(init);
    let handed: unknown;
    await middleware(req, res, (error?: unknown) => {
      handed = error;
    });
    const { issues } = handed as ValidationError;
    expect(issues.map((i) => i.target)).toEqual([
      "headers",
      "query",
      "body",
      "body",
    ]);
    expect(issues.every((i) => i.path === "")).toBe(true);
    expect(issues.every((i) => i.message.startsWith("Invalid value"))).toBe(
      true,
    );
  });

  it("leaves a passing request exactly as it was", async () => {
    const router = new BunRouter();
    router.post(
      "/x",
      validate(
        { body: z.object({ n: z.number() }) },
        { onFailure: "respond", messages: "generic", redactPaths: true },
      ),
      (req, res) => res.json(req.body),
    );
    const response = await router.fetch("/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: 1 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ n: 1 });
  });

  it("an explicit undefined, or redactPaths: false, is the default", async () => {
    for (const options of [
      { messages: undefined, redactPaths: undefined },
      { redactPaths: false },
    ]) {
      const middleware = validate({ body: VENDORS[0].schema }, options);
      const req = await makeRequest(post(VENDORS[0].bad));
      const res = await makeResponse(post(VENDORS[0].bad));
      let handed: unknown;
      await middleware(req, res, (error?: unknown) => {
        handed = error;
      });
      expect((handed as ValidationError).issues).toEqual([
        expected(VENDORS[0], DEFAULT),
      ]);
    }
  });

  it("refuses a value neither option takes, when the middleware is built", () => {
    expect(() => validate({}, { messages: "Generic" as never })).toThrow(
      'validate(): messages must be "generic" or unset',
    );
    expect(() => validate({}, { redactPaths: "yes" as never })).toThrow(
      "validate(): redactPaths must be a boolean",
    );
  });
});

// ---------------------------------------------------------------------------
// Response side
// ---------------------------------------------------------------------------

/** Records the `ResponseValidationError` an error handler is given, answering 500. */
function refusals() {
  const seen: ResponseValidationError[] = [];
  const handler = ((error, _req, res, _next) => {
    if (error instanceof ResponseValidationError) seen.push(error);
    res.status(500).send("refused");
  }) satisfies RouterErrorMiddlewareHandler;
  return { seen, handler };
}

/** The issues of every response-mismatch warning logged. */
const warned = (events: LogEvent[]): unknown[] =>
  events
    .filter((e) => e.level === "warn" && e.message.includes("does not match"))
    .map((e) => e.fields?.issues);

/** Waits for a background check (a yup Promise under "warn") to settle. */
async function until(check: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(1);
  }
}

/** A typed `res` as the unconstrained `BunResponse`, to send what its contract does not declare. */
const untyped = (res: unknown): BunResponse => res as BunResponse;

describe("response side: the responses checks' issues", () => {
  for (const c of VENDORS) {
    for (const wording of [DEFAULT, GENERIC, REDACT, BOTH]) {
      describe(`${c.vendor}, ${wording.name}`, () => {
        const issue = { ...expected(c, wording), key: "200" };

        it('"error": the ResponseValidationError is worded', async () => {
          const router = new BunRouter();
          const { seen, handler } = refusals();
          router.get(
            "/x",
            validate(
              {},
              {
                responses: { 200: c.schema },
                responseValidation: "error",
                ...wording.options,
              },
            ),
            (_req, res) => untyped(res).json(c.bad as object),
          );
          router.use(handler);
          expect((await router.fetch("/x")).status).toBe(500);
          expect(seen).toHaveLength(1);
          expect(seen[0].issues).toEqual([
            { ...issue, mediaType: "application/json" },
          ]);
          expect(seen[0].message).toBe(
            `Response validation failed (status 200) — body${issue.path ? `.${issue.path}` : ""}: ${issue.message}`,
          );
        });

        it('"warn" (the router\'s): the log line is worded', async () => {
          const { logger, events } = createTestLogger();
          const router = new BunRouter({ logger, responseValidation: "warn" });
          router.get(
            "/x",
            validate({}, { responses: { 200: c.schema }, ...wording.options }),
            (_req, res) => untyped(res).json(c.bad as object),
          );
          expect((await router.fetch("/x")).status).toBe(200);
          await until(() => warned(events).length > 0);
          expect(warned(events)).toEqual([
            [{ ...issue, mediaType: "application/json" }],
          ]);
        });
      });
    }
  }

  it("headers and cookies schemas' issues are worded too", async () => {
    const router = new BunRouter();
    const { seen, handler } = refusals();
    router.get(
      "/x",
      validate(
        {},
        {
          responses: {
            200: {
              headers: z.object({ "x-n": z.coerce.number() }),
              cookies: z.object({
                sid: z.object({ httpOnly: z.literal(true) }),
              }),
              content: { "text/plain": z.string() },
            },
          },
          responseValidation: "error",
          messages: "generic",
          redactPaths: true,
        },
      ),
      (_req, res) =>
        untyped(res)
          .set("x-n", "nan")
          .cookie("sid", "1")
          .type("text")
          .send("ok"),
    );
    router.use(handler);
    expect((await router.fetch("/x")).status).toBe(500);
    expect(seen[0].issues.map((i) => [i.target, i.path, i.message])).toEqual([
      ["headers", "", "Invalid value (invalid_type)"],
      ["cookies", "", "Invalid value (invalid_value)"],
    ]);
  });

  it("an sse() event's issues: the schema's path goes, the declared <event>.data stays", async () => {
    const run = async (options: Wording["options"]) => {
      const router = new BunRouter();
      const { seen, handler } = refusals();
      router.get(
        "/x",
        validate(
          {},
          {
            responses: {
              200: {
                content: {
                  "text/event-stream": sse({
                    tick: z.object({ n: z.number() }),
                  }),
                },
              },
            },
            responseValidation: "error",
            ...options,
          },
        ),
        (_req, res) =>
          untyped(res)
            .type("text/event-stream")
            .send('event: tick\ndata: {"n":"x"}\n\n'),
      );
      router.use(handler);
      expect((await router.fetch("/x")).status).toBe(500);
      return seen[0].issues.map((i) => [i.path, i.message]);
    };
    expect(await run({})).toEqual([
      ["tick.data.n", "Invalid input: expected number, received string"],
    ]);
    expect(await run({ messages: "generic", redactPaths: true })).toEqual([
      ["tick.data", "Invalid value (invalid_type)"],
    ]);
  });

  it("an issue the framework writes (an undeclared status) is kept: it names only what is declared", async () => {
    const router = new BunRouter();
    const { seen, handler } = refusals();
    router.get(
      "/x",
      validate(
        {},
        {
          responses: { 200: z.object({ n: z.number() }) },
          responseValidation: "error",
          messages: "generic",
          redactPaths: true,
        },
      ),
      (_req, res) => untyped(res).status(418).end(),
    );
    router.use(handler);
    await router.fetch("/x");
    expect(seen[0].issues).toEqual([
      {
        target: "status",
        message: "This status is not declared (200)",
        path: "",
        key: "418",
      },
    ]);
  });

  it("a mount's validator and a route's: the stricter wording holds, either way round", async () => {
    const run = async (
      mount: Wording["options"],
      route: Wording["options"],
    ) => {
      const router = new BunRouter({ responseValidation: "error" });
      const { seen, handler } = refusals();
      router.use(
        "/m",
        validate(
          {},
          { responses: { 401: z.object({ code: z.string() }) }, ...mount },
        ),
      );
      router.get(
        "/m/x",
        validate({}, { responses: { 200: VENDORS[0].schema }, ...route }),
        (req, res) =>
          req.query.k === "401"
            ? untyped(res).status(401).json({ code: 1 })
            : untyped(res).json(VENDORS[0].bad as object),
      );
      router.use(handler);
      await router.fetch("/m/x");
      await router.fetch("/m/x?k=401");
      return seen.map((e) => e.issues.map((i) => [i.path, i.message]));
    };
    const zod = "Invalid input: expected number, received string";
    const zodCode = "Invalid input: expected string, received number";
    expect(await run({}, {})).toEqual([[[EMAIL, zod]], [["code", zodCode]]]);
    const strict = [
      [["", "Invalid value (invalid_type)"]],
      [["", "Invalid value (invalid_type)"]],
    ];
    expect(await run(BOTH.options, {})).toEqual(strict);
    expect(await run({}, BOTH.options)).toEqual(strict);
    expect(await run(GENERIC.options, REDACT.options)).toEqual(strict);
    expect(await run({ redactPaths: true }, { redactPaths: false })).toEqual([
      [["", zod]],
      [["", zodCode]],
    ]);
  });
});
