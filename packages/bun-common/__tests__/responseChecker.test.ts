/**
 * `createResponseChecker` (bun-validate V7b's bun-common export): the commit
 * gate's engine driven with a plain view, outside the router. The gate's own
 * suites (`bunValidate.responses.test.ts`, `bunValidate.variants.test.ts`)
 * cover the engine; these cover the seam: the view's fields, the modes, a
 * stream verdict, and a variant's adjust.
 *
 * Negative controls: the same views against a `validate()`-gated route prove
 * the checker refuses what the gate refuses (the mismatch cases), and a
 * planted value is in no issue.
 */
import type { StandardSchemaV1 } from "../lib/index";
import {
  createResponseChecker,
  createTestLogger,
  ResponseValidationError,
  sse,
  variants,
} from "../lib/index";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { makeRequest } from "./helpers";

/** A value no issue or log may quote. */
const SECRET = "hunter2-the-body-id";

const User = z.object({ id: z.number() });
const Problem = z.object({ error: z.string() });

/** A schema whose validate always answers with a Promise, as yup's does. */
const AsyncUser: StandardSchemaV1 = {
  "~standard": {
    version: 1,
    vendor: "test-async",
    validate: async (value) => {
      await Bun.sleep(1);
      return User["~standard"].validate(value);
    },
  },
};

/** A 200/User + 404/Problem checker in `"error"`. */
function checker(options?: { mode?: "off" | "warn" | "error" }) {
  return createResponseChecker(
    {
      200: {
        headers: z.object({ "x-n": z.coerce.number().int() }),
        content: { "application/json": User, "text/plain": z.string() },
      },
      404: Problem,
    },
    { mode: options?.mode ?? "error" },
  );
}

describe("createResponseChecker", () => {
  it("passes a declared response, and stays synchronous for a sync vendor", async () => {
    const verdict = checker().check({
      req: await makeRequest(),
      status: 200,
      headers: new Headers({ "x-n": "5" }),
      kind: "json",
      body: { id: 1 },
    });
    expect(verdict).toBeUndefined();
  });

  it("refuses a body mismatch with the issue at its path, never the value", async () => {
    const verdict = checker().check({
      req: await makeRequest(),
      status: 200,
      headers: new Headers({ "x-n": "5" }),
      kind: "json",
      body: { id: SECRET },
    });
    expect(verdict).toBeInstanceOf(ResponseValidationError);
    const error = verdict as ResponseValidationError;
    expect(error.status).toBe(500);
    expect(error.issues.map((i) => [i.target, i.path, i.key])).toEqual([
      ["body", "id", "200"],
    ]);
    expect(JSON.stringify(error.issues)).not.toContain(SECRET);
  });

  it("refuses an undeclared status, whatever the body", async () => {
    const verdict = checker().check({
      req: await makeRequest(),
      status: 418,
      headers: new Headers(),
      kind: "json",
      body: { id: 1 },
    });
    expect(verdict).toBeInstanceOf(ResponseValidationError);
    expect(
      (verdict as ResponseValidationError).issues.map((i) => i.target),
    ).toEqual(["status"]);
  });

  it("checks the headers: a missing declared header is a mismatch", async () => {
    const verdict = checker().check({
      req: await makeRequest(),
      status: 200,
      headers: new Headers(),
      kind: "json",
      body: { id: 1 },
    });
    expect(verdict).toBeInstanceOf(ResponseValidationError);
    expect(
      (verdict as ResponseValidationError).issues.map((i) => [
        i.target,
        i.path,
      ]),
    ).toEqual([["headers", "x-n"]]);
  });

  it("matches the media type, with an undeclared one a mismatch", async () => {
    const c = checker();
    expect(
      c.check({
        req: await makeRequest(),
        status: 200,
        headers: new Headers({ "x-n": "5", "content-type": "text/plain" }),
        kind: "text",
        body: "plain answer",
        contentType: "text/plain",
      }),
    ).toBeUndefined();
    // An undeclared media type is a mismatch, whatever the body.
    const wrong = c.check({
      req: await makeRequest(),
      status: 200,
      headers: new Headers({ "x-n": "5", "content-type": "application/xml" }),
      kind: "text",
      body: "<user/>",
      contentType: "application/xml",
    });
    expect(wrong).toBeInstanceOf(ResponseValidationError);
  });

  it("reads the cookies view from the response's Set-Cookie lines", async () => {
    const c = createResponseChecker(
      {
        200: {
          cookies: z.object({
            sid: z.object({ value: z.string(), httpOnly: z.literal(true) }),
          }),
          content: { "application/json": User },
        },
      },
      { mode: "error" },
    );
    const missingFlag = c.check({
      req: await makeRequest(),
      status: 200,
      headers: new Headers([["set-cookie", "sid=abc; Path=/"]]),
      kind: "json",
      body: { id: 1 },
    });
    expect(missingFlag).toBeInstanceOf(ResponseValidationError);
    const fine = c.check({
      req: await makeRequest(),
      status: 200,
      headers: new Headers([["set-cookie", "sid=abc; Path=/; HttpOnly"]]),
      kind: "json",
      body: { id: 1 },
    });
    expect(fine).toBeUndefined();
  });

  it('"warn" sends and logs once; "off" installs no check', async () => {
    const { logger, events } = createTestLogger();
    const view = {
      status: 200,
      headers: new Headers(),
      kind: "json" as const,
      body: { id: SECRET },
    };
    const warn = createResponseChecker(
      { 200: { content: { "application/json": User } } },
      { mode: "warn", logger },
    );
    expect(warn.check({ req: await makeRequest(), ...view })).toBeUndefined();
    expect(events.filter((event) => event.level === "warn")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(SECRET);

    const off = createResponseChecker(
      { 200: { content: { "application/json": User } } },
      { mode: "off", logger },
    );
    events.length = 0;
    expect(off.check({ req: await makeRequest(), ...view })).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("an error handler's response (reportOnly) is reported, never refused", async () => {
    const { logger, events } = createTestLogger();
    const c = createResponseChecker(
      { 200: { content: { "application/json": User } } },
      { mode: "error", logger },
    );
    const verdict = c.check({
      req: await makeRequest(),
      status: 200,
      headers: new Headers(),
      kind: "json",
      body: { id: SECRET },
      reportOnly: true,
    });
    expect(verdict).toBeUndefined();
    const reported = events.filter(
      (event) =>
        event.level === "warn" &&
        event.message.includes("error handler's response"),
    );
    expect(reported).toHaveLength(1);
  });

  it("a freshness 304 for a conditional request is exempt, undeclared", async () => {
    const c = checker();
    expect(
      c.check({
        req: await makeRequest({ headers: { "if-none-match": '"v1"' } }),
        status: 304,
        headers: new Headers(),
        kind: "empty",
      }),
    ).toBeUndefined();
    const verdict = c.check({
      req: await makeRequest(),
      status: 304,
      headers: new Headers(),
      kind: "empty",
    });
    expect(verdict).toBeInstanceOf(ResponseValidationError);
  });

  it("a redirect checks its status and location, the generated body exempt", async () => {
    const c = createResponseChecker(
      {
        302: { headers: z.object({ location: z.string().startsWith("/app") }) },
      },
      { mode: "error" },
    );
    expect(
      c.check({
        req: await makeRequest(),
        status: 302,
        headers: new Headers({ location: "/app/home" }),
        kind: "redirect",
        body: "Redirecting to /app/home",
      }),
    ).toBeUndefined();
    expect(
      c.check({
        req: await makeRequest(),
        status: 302,
        headers: new Headers({ location: "https://elsewhere.example" }),
        kind: "redirect",
        body: "Redirecting to https://elsewhere.example",
      }),
    ).toBeInstanceOf(ResponseValidationError);
  });

  it("holds a Promise verdict under 'error' for an async vendor", async () => {
    const c = createResponseChecker(
      { 200: { content: { "application/json": AsyncUser } } },
      { mode: "error" },
    );
    const verdict = c.check({
      req: await makeRequest(),
      status: 200,
      headers: new Headers(),
      kind: "json",
      body: { id: 1 },
    });
    expect(verdict).toBeInstanceOf(Promise);
    expect(await verdict).toBeUndefined();
    const refused = c.check({
      req: await makeRequest(),
      status: 200,
      headers: new Headers(),
      kind: "json",
      body: { id: SECRET },
    });
    expect(await refused).toBeInstanceOf(ResponseValidationError);
  });

  it("a named variant adjusts: literals filled, undeclared fields stripped", async () => {
    const c = createResponseChecker(
      {
        200: variants({
          admin: {
            when: (_valid, req) => req.getHeader("x-role") === "admin",
            headers: z.object({ "x-admin": z.literal("1") }),
            content: {
              "application/json": z.object({
                kind: z.literal("admin"),
                id: z.number(),
              }),
            },
          },
          user: {
            when: () => false,
            content: {
              "application/json": z.object({
                kind: z.literal("user"),
                id: z.number(),
              }),
            },
          },
        }),
      },
      { mode: "error" },
    );
    // `when` holds, the variant is named: kind and x-admin are filled, the
    // undeclared `salary` stripped, and the response is replaced.
    const verdict = c.check({
      req: await makeRequest({ headers: { "x-role": "admin" } }),
      status: 200,
      headers: new Headers(),
      kind: "json",
      body: { id: 1, salary: 9 },
      variant: "admin",
    });
    expect(verdict).toHaveProperty("replacement");
    const replacement = (verdict as { replacement: Response }).replacement;
    expect(replacement.headers.get("x-admin")).toBe("1");
    expect(await replacement.json()).toEqual({ kind: "admin", id: 1 });
    // `when` does not hold for the named variant: a refusal.
    const refused = c.check({
      req: await makeRequest(),
      status: 200,
      headers: new Headers(),
      kind: "json",
      body: { kind: "admin", id: 1 },
      variant: "admin",
    });
    expect(refused).toBeInstanceOf(ResponseValidationError);
  });

  it("an sse() body hands back a per-event check, fed with wire text", async () => {
    const c = createResponseChecker(
      {
        200: {
          content: {
            "text/event-stream": sse({
              tick: z.object({ n: z.number() }),
            }),
          },
        },
      },
      { mode: "error" },
    );
    const verdict = c.check({
      req: await makeRequest(),
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      kind: "native",
      body: null,
      contentType: "text/event-stream",
    });
    expect(verdict).toHaveProperty("chunk");
    const stream = verdict as {
      chunk: (chunk: string) => Error | undefined | Promise<Error | undefined>;
      end: () => Error | undefined | Promise<Error | undefined>;
    };
    expect(
      await stream.chunk('event: tick\ndata: {"n":1}\n\n'),
    ).toBeUndefined();
    const bad = await stream.chunk(`data: {"n":"${SECRET}"}\n\n`);
    expect(bad).toBeInstanceOf(Error);
    expect(JSON.stringify(bad)).not.toContain(SECRET);
    // An undeclared event name is a mismatch too.
    expect(await stream.chunk("event: nope\ndata: {}\n\n")).toBeInstanceOf(
      Error,
    );
  });
});
