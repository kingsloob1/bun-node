/**
 * Request completeness (plan `docs/plans/bun-validate/` §4.3, V2): the
 * `cookies` and `signedCookies` targets, headers parsed onto `req.valid` and
 * never written back, `req.valid` itself, the target order, and the implicit
 * status a `"respond"` validator adds to its contract (§4.12 m5). H46–H51
 * name the cases of `evidence/http-complete/`.
 */
import type { BunRequest } from "../lib/BunRequest";
import type { BunResponse } from "../lib/BunResponse";
import type {
  RouterErrorMiddlewareHandler,
  RouterHandler,
} from "../lib/types/general";
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunRouter } from "../lib/BunRouter";
import type { ValidationError } from "../lib/BunValidate";
import { validate } from "../lib/BunValidate";
import { describeContract, mergeContracts } from "../lib/contract/describe";
import { httpTransport } from "../lib/contract/http";
import { getContract } from "../lib/contract/transport";
import { createTestLogger } from "../lib/logging";
import { requestParsing } from "../lib/requestParsing";
import { signCookie } from "../lib/utils/native";

const SECRET = "k1";
/** A cookie value signed the way `res.cookie(name, value, { signed: true })` signs it. */
const signed = (value: string): string =>
  encodeURIComponent(`s:${signCookie(value, SECRET)}`);
/** A signed-looking cookie whose signature no secret verifies. */
const tampered = encodeURIComponent(`s:alice.${"A".repeat(43)}`);

/** Cookie parsing with the test's secret, as the `parseCookies` request option sets it. */
const withSecret = requestParsing({ parseCookies: { secret: SECRET } });

/** An error handler answering a `ValidationError`'s issues as JSON. */
const issuesHandler = ((error, _req, res, _next) => {
  const failure = error as ValidationError;
  res.status(failure.status).json({ issues: failure.issues });
}) satisfies RouterErrorMiddlewareHandler;

/** The issues a failed request was answered with. */
async function issuesOf(
  response: Response,
): Promise<{ target: string; path: string }[]> {
  const body = (await response.json()) as {
    issues: { target: string; path: string; message: string }[];
  };
  return body.issues.map(({ target, path }) => ({ target, path }));
}

describe("validate(): the cookies target", () => {
  const Cookies = z.object({
    n: z.coerce.number(),
    theme: z.enum(["dark", "light"]).optional(),
  });

  it("writes the parsed cookies back and puts them on req.valid (H46)", async () => {
    const router = new BunRouter();
    router.get("/c", validate({ cookies: Cookies }), (req, res) => {
      res.json({
        cookies: req.cookies,
        valid: req.valid.cookies,
        type: typeof req.cookies.n,
      });
    });
    const response = await router.fetch("/c", {
      headers: { cookie: "n=7; theme=dark; other=x" },
    });
    expect(response.status).toBe(200);
    // `other` is stripped by the schema, as an unknown query key would be.
    expect(await response.json()).toEqual({
      cookies: { n: 7, theme: "dark" },
      valid: { n: 7, theme: "dark" },
      type: "number",
    });
  });

  it("answers a bad cookie with an issue whose target is cookies (H47)", async () => {
    const router = new BunRouter();
    router.get(
      "/c",
      validate({ cookies: Cookies }, { onFailure: "respond" }),
      (_req, res) => res.send("unreachable"),
    );
    const response = await router.fetch("/c", {
      headers: { cookie: "n=abc" },
    });
    expect(response.status).toBe(400);
    expect(await issuesOf(response)).toEqual([
      { target: "cookies", path: "n" },
    ]);
  });

  it("a forged unsigned cookie passes a cookies schema: it cannot require a signature", async () => {
    const router = new BunRouter();
    router.get(
      "/c",
      withSecret,
      validate({ cookies: z.object({ sid: z.string() }) }),
      (req, res) => res.json(req.cookies),
    );
    const response = await router.fetch("/c", {
      headers: { cookie: "sid=alice" },
    });
    expect(await response.json()).toEqual({ sid: "alice" });
  });
});

describe("validate(): the signedCookies target", () => {
  const Session = z.object({ sid: z.string() });

  /** A route requiring a signed `sid`, answering failures itself. */
  function sessionRouter(): BunRouter {
    const router = new BunRouter();
    router.get(
      "/s",
      withSecret,
      validate({ signedCookies: Session }, { onFailure: "respond" }),
      (req, res) =>
        res.json({
          sid: req.signedCookies.sid,
          valid: req.valid.signedCookies,
        }),
    );
    return router;
  }

  it("passes a genuinely signed cookie, unsigned (H49)", async () => {
    const response = await sessionRouter().fetch("/s", {
      headers: { cookie: `sid=${signed("alice")}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sid: "alice",
      valid: { sid: "alice" },
    });
  });

  it("refuses a forged unsigned cookie: it is not a signed cookie at all (H50)", async () => {
    const response = await sessionRouter().fetch("/s", {
      headers: { cookie: "sid=alice" },
    });
    expect(response.status).toBe(400);
    expect(await issuesOf(response)).toEqual([
      { target: "signedCookies", path: "sid" },
    ]);
  });

  it("refuses a tampered signature: the cookie is false (H51)", async () => {
    const response = await sessionRouter().fetch("/s", {
      headers: { cookie: `sid=${tampered}` },
    });
    expect(response.status).toBe(400);
    expect(await issuesOf(response)).toEqual([
      { target: "signedCookies", path: "sid" },
    ]);
  });
});

describe("validate(): cookies with cookie parsing off", () => {
  const off = requestParsing({ parseCookies: false });

  it("gives the schema {} for an undefined req.cookies, and writes the result back", async () => {
    const router = new BunRouter();
    router.get(
      "/off",
      off,
      (req, _res, next) => {
        // The precondition: parsing is off, so nothing is there.
        expect(req.cookies).toBeUndefined();
        expect(req.signedCookies).toBeUndefined();
        next();
      },
      validate({
        cookies: z.object({ theme: z.string().default("light") }),
        signedCookies: z.object({ sid: z.string().optional() }),
      }),
      (req, res) =>
        res.json({ cookies: req.cookies, signedCookies: req.signedCookies }),
    );
    const response = await router.fetch("/off", {
      headers: { cookie: "theme=dark" },
    });
    expect(response.status).toBe(200);
    // The header is not read: parsing is off, so the default applies.
    expect(await response.json()).toEqual({
      cookies: { theme: "light" },
      signedCookies: {},
    });
  });

  it("fails a required cookie as absent, not as a missing object", async () => {
    const router = new BunRouter();
    router.get(
      "/off",
      off,
      validate({ cookies: z.object({ sid: z.string() }) }),
      (_req, res) => res.send("unreachable"),
    );
    router.use(issuesHandler);
    const response = await router.fetch("/off", {
      headers: { cookie: "sid=alice" },
    });
    expect(response.status).toBe(400);
    expect(await issuesOf(response)).toEqual([
      { target: "cookies", path: "sid" },
    ]);
  });
});

describe("validate(): headers are parsed onto req.valid, never written back", () => {
  const Headers = z.object({ "x-n": z.coerce.number() });

  it("types a coerced header on req.valid while req.headers, accepts and busboy keep working (H46)", async () => {
    const router = new BunRouter();
    router.post("/h", validate({ headers: Headers }), async (req, res) => {
      const parts = await req.getMultiParts({});
      res.json({
        valid: req.valid.headers["x-n"],
        validType: typeof req.valid.headers["x-n"],
        raw: req.headers["x-n"],
        accepts: req.accepts("json"),
        multipart: String(req.headers["content-type"]).startsWith(
          "multipart/form-data; boundary=",
        ),
        fields: parts.fields,
      });
    });
    const form = new FormData();
    form.set("title", "hello");
    const response = await router.fetch("/h", {
      method: "POST",
      headers: { "x-n": "5", accept: "text/html" },
      body: form,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      valid: 5,
      validType: "number",
      raw: "5",
      accepts: false,
      multipart: true,
      fields: { title: "hello" },
    });
  });

  it("answers a bad header with an issue whose target is headers (H48)", async () => {
    const router = new BunRouter();
    router.get(
      "/h",
      validate({ headers: Headers }, { onFailure: "respond" }),
      (_req, res) => res.send("unreachable"),
    );
    const response = await router.fetch("/h", { headers: { "x-n": "many" } });
    expect(response.status).toBe(400);
    expect(await issuesOf(response)).toEqual([
      { target: "headers", path: "x-n" },
    ]);
  });

  it("a header schema keyed by a capitalised name never matches", async () => {
    const router = new BunRouter();
    router.get(
      "/h",
      validate(
        { headers: z.object({ "X-N": z.string() }) },
        { onFailure: "respond" },
      ),
      (_req, res) => res.send("unreachable"),
    );
    const response = await router.fetch("/h", { headers: { "X-N": "5" } });
    expect(response.status).toBe(400);
  });
});

describe("validate(): req.valid", () => {
  it("holds every part a validator parsed", async () => {
    const router = new BunRouter();
    router.post(
      "/all/:id",
      withSecret,
      validate({
        headers: z.object({ "x-n": z.coerce.number() }),
        cookies: z.object({ theme: z.string() }),
        signedCookies: z.object({ sid: z.string() }),
        params: z.object({ id: z.coerce.number() }),
        query: z.object({ page: z.coerce.number() }),
        body: z.object({ title: z.string() }),
      }),
      (req, res) => res.json(req.valid),
    );
    const response = await router.fetch("/all/42?page=2", {
      method: "POST",
      headers: {
        "x-n": "5",
        "content-type": "application/json",
        cookie: `theme=dark; sid=${signed("alice")}`,
      },
      body: JSON.stringify({ title: "t", extra: true }),
    });
    expect(response.status).toBe(200);
    const valid = (await response.json()) as Record<string, unknown>;
    expect(valid).toEqual({
      headers: { "x-n": 5 },
      cookies: { theme: "dark" },
      signedCookies: { sid: "alice" },
      params: { id: 42 },
      query: { page: 2 },
      body: { title: "t" },
    });
    // In the order the targets are validated.
    expect(Object.keys(valid)).toEqual([
      "headers",
      "cookies",
      "signedCookies",
      "params",
      "query",
      "body",
    ]);
  });

  it("is {} before any validator, and on a route without one", async () => {
    const router = new BunRouter();
    router.get("/none", (req, res) => res.json({ valid: req.valid }));
    expect(await (await router.fetch("/none")).json()).toEqual({ valid: {} });
  });

  it("holds a transform's result, except for headers, whose transform is never written", async () => {
    const router = new BunRouter();
    router.get(
      "/t",
      validate(
        {
          query: z.object({ page: z.coerce.number() }),
          headers: z.object({ "x-n": z.coerce.number() }),
        },
        {
          hooks: {
            query: { transform: (value) => ({ ...value, offset: 20 }) },
            headers: { transform: () => 42 },
          },
        },
      ),
      (req, res) => res.json(req.valid),
    );
    const response = await router.fetch("/t?page=2", {
      headers: { "x-n": "5" },
    });
    expect(await response.json()).toEqual({
      headers: { "x-n": 5 },
      query: { page: 2, offset: 20 },
    });
  });

  it("is filled under replace: false, while the request keeps its raw values", async () => {
    const router = new BunRouter();
    router.get(
      "/raw",
      validate(
        { query: z.object({ page: z.coerce.number() }) },
        { replace: false },
      ),
      (req, res) =>
        res.json({
          raw: req.query.page,
          valid: req.valid as Record<string, unknown>,
        }),
    );
    expect(await (await router.fetch("/raw?page=3")).json()).toEqual({
      raw: "3",
      valid: { query: { page: 3 } },
    });
  });

  it("merges a mount's validator and a route's, the later replacing a part both parse", async () => {
    const sub = new BunRouter();
    sub.get(
      "/x",
      validate({
        headers: z.object({ "x-n": z.coerce.number() }),
        query: z.object({ page: z.coerce.number(), size: z.coerce.number() }),
      }),
      (req, res) => res.json(req.valid),
    );
    const router = new BunRouter();
    router.use(
      "/m",
      validate({
        cookies: z.object({ theme: z.string() }),
        query: z.object({ page: z.string(), size: z.string() }),
      }),
      sub,
    );
    const response = await router.fetch("/m/x?page=2&size=10", {
      headers: { "x-n": "5", cookie: "theme=dark" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      cookies: { theme: "dark" },
      query: { page: 2, size: 10 },
      headers: { "x-n": 5 },
    });
  });

  it("is allocated on a stub request that has none", () => {
    const req = { query: { page: "3" } } as Partial<BunRequest>;
    let called = false;
    validate({ query: z.object({ page: z.coerce.number() }) })(
      req as BunRequest,
      {} as BunResponse,
      () => {
        called = true;
      },
    );
    expect(called).toBe(true);
    expect((req as { valid?: unknown }).valid).toEqual({ query: { page: 3 } });
  });
});

describe("validate(): the target order", () => {
  /** A schema that records when it ran, then fails. */
  function failing(name: string, seen: string[]): StandardSchemaV1 {
    return {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => {
          seen.push(name);
          return { issues: [{ message: `${name} is bad` }] };
        },
      },
    };
  }
  const targets = [
    "headers",
    "cookies",
    "signedCookies",
    "params",
    "query",
    "body",
  ] as const;

  /** Every target's failing schema, declared in reverse so the order cannot come from the object. */
  function allFailing(seen: string[]) {
    return Object.fromEntries(
      [...targets].reverse().map((t) => [t, failing(t, seen)]),
    ) as Record<(typeof targets)[number], StandardSchemaV1>;
  }

  it("validates and reports headers → cookies → signedCookies → params → query → body", async () => {
    const seen: string[] = [];
    const router = new BunRouter();
    router.post("/o/:id", validate(allFailing(seen)), (_req, res) =>
      res.send("unreachable"),
    );
    router.use(issuesHandler);
    const response = await router.fetch("/o/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(seen).toEqual([...targets]);
    expect((await issuesOf(response)).map((issue) => issue.target)).toEqual([
      ...targets,
    ]);
  });

  it("abortEarly stops at the first: a header check fails before cookies or the body are read", async () => {
    const seen: string[] = [];
    let failure: ValidationError | undefined;
    validate(allFailing(seen), { abortEarly: true })(
      { headers: {}, params: {}, query: {} } as unknown as BunRequest,
      {} as BunResponse,
      (error?: unknown) => {
        failure = error as ValidationError;
      },
    );
    expect(seen).toEqual(["headers"]);
    expect(failure?.targets).toEqual(["headers"]);
  });

  it("the unknown-target TypeError lists the targets in that order", () => {
    expect(() =>
      validate({ cookie: z.object({}) } as unknown as Parameters<
        typeof validate
      >[0]),
    ).toThrow(
      new TypeError(
        'validate(): unknown target "cookie"; the targets are headers, cookies, signedCookies, params, query, body',
      ),
    );
  });

  it("the contract's inbound rows follow the transport's order, with each part's encoding", () => {
    const contract = getContract(
      validate(
        Object.fromEntries(
          [...targets].reverse().map((t) => [t, z.object({})]),
        ) as unknown as Record<(typeof targets)[number], StandardSchemaV1>,
      ),
    )!;
    expect(
      describeContract(contract).entries.map((e) => [e.part, e.encoding]),
    ).toEqual([
      ["headers", "header-string"],
      ["cookies", "cookie-string"],
      ["signedCookies", "signed-cookie"],
      ["params", "path-string"],
      ["query", "querystring"],
      ["body", "body"],
    ]);
  });
});

describe('validate(): onFailure "respond" declares its own status, marked implicit (m5)', () => {
  const Page = z.object({ page: z.coerce.number() });

  /** The outbound rows of a validator's contract. */
  function outboundRows(mw: RouterHandler) {
    return describeContract(getContract(mw)!).entries.filter(
      (entry) => entry.side === "outbound",
    );
  }

  it("adds its 400 with the default body's JSON Schema, implicit", () => {
    const mw = validate({ query: Page }, { onFailure: "respond" });
    const description = describeContract(getContract(mw)!);
    expect(description.sides.outbound).toEqual({
      declared: true,
      keys: ["400"],
    });
    const rows = outboundRows(mw);
    expect(rows.map(({ schema: _schema, ...row }) => row)).toEqual([
      {
        side: "outbound",
        keyName: "status",
        key: "400",
        part: "body",
        mediaType: "application/json",
        kind: "value",
        encoding: "body",
        vendor: "bun-common/documented",
        implicit: true,
      },
    ]);
    const json = (
      rows[0].schema!["~standard"] as unknown as {
        jsonSchema: { output: (o: { target: string }) => unknown };
      }
    ).jsonSchema.output({ target: "draft-2020-12" });
    expect(json).toMatchObject({
      type: "object",
      required: ["error", "issues"],
      properties: {
        error: { const: "Validation failed" },
        issues: {
          type: "array",
          items: {
            properties: {
              target: {
                enum: [
                  "headers",
                  "cookies",
                  "signedCookies",
                  "params",
                  "query",
                  "body",
                ],
              },
            },
          },
        },
      },
    });
  });

  it("uses the configured status, and documents a formatError body as any JSON", () => {
    const rows = outboundRows(
      validate(
        { query: Page },
        { onFailure: "respond", status: 422, formatError: () => "invalid" },
      ),
    );
    expect(rows.map((row) => [row.key, row.implicit])).toEqual([["422", true]]);
    const json = (
      rows[0].schema!["~standard"] as unknown as {
        jsonSchema: { input: (o: { target: string }) => unknown };
      }
    ).jsonSchema.input({ target: "draft-2020-12" });
    expect(json).toEqual({});
  });

  it("declares nothing outbound under next or throw: that status is the app's error handler's", () => {
    for (const onFailure of ["next", "throw", undefined] as const) {
      const description = describeContract(
        getContract(validate({ query: Page }, { onFailure }))!,
      );
      expect(description.sides.outbound).toBeUndefined();
      expect(description.entries.every((e) => e.side === "inbound")).toBe(true);
    }
  });

  it("the implicit body documents and never checks: the guard skips it", async () => {
    // The 400 the validator itself sends would never be refused.
    const router = new BunRouter();
    router.get(
      "/r",
      validate({ query: Page }, { onFailure: "respond" }),
      (_req, res) => res.send("unreachable"),
    );
    const response = await router.fetch("/r?page=x");
    expect(response.status).toBe(400);
    const row = outboundRows(
      validate({ query: Page }, { onFailure: "respond" }),
    )[0];
    expect(row.schema!["~standard"].validate({ anything: 1 })).toEqual({
      value: { anything: 1 },
    });
  });

  it("mergeContracts: a 400 the app declares wins over the implicit one wherever it sits, with no warning", () => {
    const { logger, events } = createTestLogger();
    const Problem = z.object({ code: z.string() });
    const appLayer = httpTransport.contract({
      outbound: { 400: { body: { "application/json": Problem } } },
    });
    const route = getContract(
      validate({ query: Page }, { onFailure: "respond" }),
    )!;
    const merged = mergeContracts(
      [
        { contract: appLayer, origin: "router" },
        { contract: route as typeof appLayer, origin: "GET /r" },
      ],
      { logger },
    );
    const outbound = describeContract(merged).entries.filter(
      (e) => e.side === "outbound",
    );
    expect(
      outbound.map((e) => [e.key, e.origin, e.schema, e.implicit]),
    ).toEqual([["400", "router", Problem, undefined]]);
    expect(events).toEqual([]);
  });

  it("mergeContracts: alone, the implicit 400 survives the merge, still marked", () => {
    const route = getContract(
      validate({ query: Page }, { onFailure: "respond" }),
    )!;
    const merged = mergeContracts([{ contract: route, origin: "GET /r" }]);
    const outbound = describeContract(merged).entries.filter(
      (e) => e.side === "outbound",
    );
    expect(outbound.map((e) => [e.key, e.origin, e.implicit])).toEqual([
      ["400", "GET /r", true],
    ]);
  });

  it("the failure answered still matches what the contract documents", async () => {
    const router = new BunRouter();
    router.get(
      "/r",
      validate({ query: Page }, { onFailure: "respond" }),
      (_req, res) => res.send("unreachable"),
    );
    const response = await router.fetch("/r?page=x");
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as {
      error: string;
      issues: unknown[];
    };
    expect(body.error).toBe("Validation failed");
    expect(body.issues).toEqual([
      expect.objectContaining({ target: "query", path: "page" }),
    ]);
  });
});
