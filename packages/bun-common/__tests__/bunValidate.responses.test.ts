/**
 * Response contracts with buffered bodies (plan `docs/plans/bun-validate/`
 * §4.4, V3a): `validate(schemas, { responses, responseValidation })` checks
 * the status, headers, `Set-Cookie`s, media type and a buffered body at
 * `BunResponse`'s one commit point. H-numbers name the cases of
 * `evidence/http-complete/`.
 *
 * Every body kind runs under `off` (the bad body is sent), `warn` (sent, one
 * warning with no value from it) and `error` (refused: the error handler gets
 * a `ResponseValidationError`), with zod (synchronous) and yup (a Promise),
 * and every good body answers normally under `error`.
 */
import type { LogEvent } from "../lib/logging";
import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "bun:test";
import * as yup from "yup";
import { z } from "zod";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunResponse } from "../lib/BunResponse";
import { BunRouter } from "../lib/BunRouter";
import { BunValidate, validate } from "../lib/BunValidate";
import { describeContract } from "../lib/contract/describe";
import { documented } from "../lib/contract/schemas";
import { getContract } from "../lib/contract/transport";
import { createTestLogger } from "../lib/logging";
import {
  RESPONSE_BINDING,
  ResponseValidationError,
  setCookieView,
} from "../lib/responseValidation";
import { makeRequest } from "./helpers";

type Mode = "off" | "warn" | "error";
const MODES: readonly Mode[] = ["off", "warn", "error"];

/** Renders a `ResponseValidationError` as a 500 listing `part.path` per issue. */
const renderRefusal = ((error, _req, res, _next) => {
  if (error instanceof ResponseValidationError) {
    res.status(500).json({
      error: error.name,
      responseStatus: error.responseStatus,
      issues: error.issues.map(
        (i) => `${i.target}${i.path === "" ? "" : `.${i.path}`}`,
      ),
    });
    return;
  }
  res.status(500).json({ error: String(error) });
}) satisfies RouterErrorMiddlewareHandler;

/** A router logging into a test sink, with `responseValidation` set to `mode`. */
function routerFor(mode: Mode | undefined) {
  const { logger, events } = createTestLogger();
  const router = new BunRouter(
    mode === undefined ? { logger } : { logger, responseValidation: mode },
  );
  return { router, events };
}

/** The warnings a response mismatch logged. */
const mismatches = (events: LogEvent[]): LogEvent[] =>
  events.filter(
    (e) => e.level === "warn" && e.message.includes("does not match"),
  );

/** Waits for a condition a background check settles (a read Blob, a yup Promise). */
async function until(check: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(1);
  }
}

/** A typed `res` as the unconstrained `BunResponse`, to send what its contract does not declare. */
const untyped = (res: unknown): BunResponse => res as BunResponse;

/** The response's body as text, and its status. */
async function read(response: Response) {
  return { status: response.status, text: await response.text() };
}

// ---------------------------------------------------------------------------
// Every buffered kind × mode × vendor
// ---------------------------------------------------------------------------

/** 8 PNG signature bytes, then data. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const isPng = (b: unknown): boolean =>
  b instanceof Uint8Array &&
  b.length >= 8 &&
  PNG.slice(0, 8).every((x, i) => b[i] === x);
const fourBytes = (b: unknown): boolean =>
  b instanceof Uint8Array && b.length === 4;

/** One body kind: its contract per vendor, and a bad and a good handler. */
interface KindCase {
  /** The H-numbers of the case. */
  h: string;
  /** The kind. */
  name: string;
  /** The responses, per vendor. */
  responses: Record<"zod" | "yup", Record<number, unknown>>;
  /** Sends a body that breaks the contract (carrying the token `LEAK`). */
  bad: (res: BunResponse) => unknown;
  /** Sends a body that keeps it. */
  good: (res: BunResponse) => unknown;
  /** What `error` reports, as `part.path`. */
  issue: string;
}

const N_ZOD = z.object({ n: z.number() });
const N_YUP = yup.object({ n: yup.number().strict().required() });

const KINDS: KindCase[] = [
  {
    h: "H1–H2",
    name: "json()",
    responses: { zod: { 200: N_ZOD }, yup: { 200: N_YUP } },
    bad: (res) => res.json({ n: "LEAK-json" }),
    good: (res) => res.json({ n: 1 }),
    issue: "body.n",
  },
  {
    h: "H1–H2",
    name: "send(object)",
    responses: { zod: { 200: N_ZOD }, yup: { 200: N_YUP } },
    bad: (res) => res.send({ n: "LEAK-object" }),
    good: (res) => res.send({ n: 2 }),
    issue: "body.n",
  },
  {
    h: "H3–H4",
    name: "send(text)",
    responses: {
      zod: { 200: { content: { "text/plain": z.string().startsWith("ok") } } },
      yup: {
        200: { content: { "text/plain": yup.string().matches(/^ok/) } },
      },
    },
    bad: (res) => res.send("LEAK-text"),
    good: (res) => res.send("ok fine"),
    issue: "body",
  },
  {
    h: "H5–H6",
    name: "send(html)",
    responses: {
      zod: { 200: { content: { "text/html": z.string().startsWith("<") } } },
      yup: { 200: { content: { "text/html": yup.string().matches(/^</) } } },
    },
    bad: (res) => res.type("html").send("LEAK-html"),
    good: (res) => res.type("html").send("<p>hi</p>"),
    issue: "body",
  },
  {
    h: "—",
    name: "send(JSON text)",
    responses: { zod: { 200: N_ZOD }, yup: { 200: N_YUP } },
    bad: (res) => res.type("json").send('{"n":"LEAK-jsontext"}'),
    good: (res) => res.type("json").send('{"n":3}'),
    issue: "body.n",
  },
  {
    h: "H7–H8",
    name: "send(Buffer)",
    responses: {
      zod: {
        200: {
          content: {
            "application/octet-stream": z
              .instanceof(Uint8Array)
              .refine(fourBytes, "expected 4 bytes"),
          },
        },
      },
      yup: {
        200: {
          content: {
            "application/octet-stream": yup
              .mixed()
              .test("four", "expected 4 bytes", fourBytes),
          },
        },
      },
    },
    bad: (res) => res.send(Buffer.from("LEAK-bytes")),
    good: (res) => res.send(Buffer.from([1, 2, 3, 4])),
    issue: "body",
  },
  {
    h: "H9–H10",
    name: "send(Uint8Array)",
    responses: {
      zod: {
        200: {
          content: {
            "application/octet-stream": z
              .instanceof(Uint8Array)
              .refine(fourBytes, "expected 4 bytes"),
          },
        },
      },
      yup: {
        200: {
          content: {
            "application/octet-stream": yup
              .mixed()
              .test("four", "expected 4 bytes", fourBytes),
          },
        },
      },
    },
    bad: (res) => res.send(new Uint8Array([1, 2, 3])),
    good: (res) => res.send(new Uint8Array([1, 2, 3, 4])),
    issue: "body",
  },
  {
    h: "—",
    name: "send(ArrayBuffer)",
    responses: {
      zod: {
        200: {
          content: {
            "application/octet-stream": z
              .instanceof(Uint8Array)
              .refine(fourBytes, "expected 4 bytes"),
          },
        },
      },
      yup: {
        200: {
          content: {
            "application/octet-stream": yup
              .mixed()
              .test("four", "expected 4 bytes", fourBytes),
          },
        },
      },
    },
    bad: (res) => res.send(new ArrayBuffer(5)),
    good: (res) => res.send(new ArrayBuffer(4)),
    issue: "body",
  },
  {
    h: "H11–H12",
    name: "send(Blob)",
    responses: {
      zod: {
        200: {
          content: {
            "image/png": z.instanceof(Uint8Array).refine(isPng, "not a PNG"),
          },
        },
      },
      yup: {
        200: {
          content: {
            "image/png": yup.mixed().test("png", "not a PNG", isPng),
          },
        },
      },
    },
    bad: (res) => res.send(new Blob(["LEAK-blob"], { type: "image/png" })),
    good: (res) => res.send(new Blob([PNG], { type: "image/png" })),
    issue: "body",
  },
  {
    h: "H13–H14",
    name: "send(native Response)",
    responses: { zod: { 200: N_ZOD }, yup: { 200: N_YUP } },
    bad: (res) => res.send(Response.json({ n: "LEAK-native" })),
    good: (res) => res.send(Response.json({ n: 4 })),
    issue: "body.n",
  },
  {
    h: "H15–H16",
    name: "redirect()",
    responses: {
      zod: {
        302: { headers: z.object({ location: z.string().startsWith("/app") }) },
      },
      yup: {
        302: {
          headers: yup.object({
            location: yup
              .string()
              .matches(/^\/app/)
              .required(),
          }),
        },
      },
    },
    bad: (res) => res.redirect("/LEAK-elsewhere"),
    good: (res) => res.redirect("/app/home"),
    issue: "headers.location",
  },
];

describe("validate() responses: every buffered body kind", () => {
  for (const kind of KINDS) {
    for (const vendor of ["zod", "yup"] as const) {
      const responses = kind.responses[vendor] as Record<number, never>;
      describe(`${kind.name} / ${vendor} (${kind.h})`, () => {
        for (const mode of MODES) {
          it(`${mode}: the bad body ${mode === "error" ? "is refused" : "is sent"}`, async () => {
            const { router, events } = routerFor(mode);
            router.get("/k", validate({}, { responses }), (_req, res) =>
              kind.bad(res),
            );
            router.use(renderRefusal);
            const response = await router.fetch("/k");
            if (mode === "error") {
              expect(response.status).toBe(500);
              const body = (await response.json()) as {
                error: string;
                issues: string[];
              };
              expect(body.error).toBe("ResponseValidationError");
              expect(body.issues).toEqual([kind.issue]);
            } else {
              expect(response.status).not.toBe(500);
              await response.arrayBuffer();
            }
            if (mode === "warn") {
              await until(() => mismatches(events).length > 0);
              await Bun.sleep(5);
              expect(mismatches(events)).toHaveLength(1);
              // No value from the response reaches the log.
              expect(JSON.stringify(events)).not.toContain("LEAK");
            } else {
              await Bun.sleep(5);
              expect(mismatches(events)).toHaveLength(0);
            }
          });
        }
        it("error: the good body answers normally", async () => {
          const { router, events } = routerFor("error");
          router.get("/k", validate({}, { responses }), (_req, res) =>
            kind.good(res),
          );
          router.use(renderRefusal);
          const response = await router.fetch("/k");
          expect(response.status).toBe(kind.name === "redirect()" ? 302 : 200);
          await response.arrayBuffer();
          expect(events.filter((e) => e.level !== "debug")).toEqual([]);
        });
      });
    }
  }

  it("a refusal's issues and message carry no value from the response", async () => {
    const { router } = routerFor("error");
    let caught: unknown;
    router.get("/k", validate({}, { responses: { 200: N_YUP } }), (_req, res) =>
      untyped(res).json({ n: "LEAK-secret" }),
    );
    router.use(((error, _req, res, _next) => {
      caught = error;
      void res.status(500).end();
    }) satisfies RouterErrorMiddlewareHandler);
    await router.fetch("/k");
    expect(caught).toBeInstanceOf(ResponseValidationError);
    const error = caught as ResponseValidationError;
    expect(error.status).toBe(500);
    expect(error.responseStatus).toBe(200);
    expect(error.context).toEqual({
      transport: "http",
      side: "outbound",
      key: "200",
      policy: "error",
    });
    // yup quotes the value ("…the final value was: `\"LEAK-secret\"`"): withheld.
    expect(error.message).not.toContain("LEAK");
    expect(JSON.stringify(error.issues)).not.toContain("LEAK");
    expect(error.issues[0]).toMatchObject({
      target: "body",
      path: "n",
      key: "200",
      mediaType: "application/json",
    });
  });

  it("a held check (yup, a Blob) leaves the response uncommitted until it settles", async () => {
    const router = new BunRouter({ responseValidation: "error" });
    router.get("/k", validate({}, { responses: { 200: N_YUP } }), (_req, res) =>
      res.json({ n: 1 }),
    );
    const request = await makeRequest({ url: "http://localhost/k" });
    const response = new BunResponse(request);
    const result = router.dispatch({
      requestHost: "localhost",
      requestMethod: "GET",
      requestUrl: "/k",
      request,
      response,
    });
    expect(result).toBeInstanceOf(Promise);
    expect(response.headersSent).toBe(false);
    await result;
    expect(response.headersSent).toBe(true);
    expect(await response.settledResponse?.json()).toEqual({ n: 1 });
  });

  it("json() of a string is checked as the value, not as JSON text to parse", async () => {
    const router = new BunRouter({ responseValidation: "error" });
    router.get(
      "/k",
      validate({}, { responses: { 200: z.string().startsWith("he") } }),
      (_req, res) => res.json("hello"),
    );
    router.use(renderRefusal);
    const response = await router.fetch("/k");
    expect(response.status).toBe(200);
    expect(await response.json()).toBe("hello");
  });

  it("a passed-through Response is read through a clone: what is sent is untouched", async () => {
    const router = new BunRouter({ responseValidation: "error" });
    const sent = Response.json({ n: 5 });
    router.get("/k", validate({}, { responses: { 200: N_ZOD } }), (_req, res) =>
      res.send(sent),
    );
    const response = await router.fetch("/k");
    // The check read a clone; the body sent is whole.
    expect(await response.json()).toEqual({ n: 5 });
  });
});

// ---------------------------------------------------------------------------
// Status, headers, cookies, media type
// ---------------------------------------------------------------------------

/** Runs one handler under each of `warn` and `error`, with a refusal renderer. */
async function underModes(
  responses: Record<number, unknown>,
  handler: (res: BunResponse) => unknown,
): Promise<{
  warn: { status: number; warned: number };
  error: { status: number; issues: string[] };
}> {
  const warnRun = routerFor("warn");
  warnRun.router.get(
    "/x",
    validate({}, { responses: responses as Record<number, never> }),
    (_req, res) => handler(res),
  );
  const warned = await warnRun.router.fetch("/x");
  await warned.arrayBuffer();
  await Bun.sleep(2);
  const errorRun = routerFor("error");
  errorRun.router.get(
    "/x",
    validate({}, { responses: responses as Record<number, never> }),
    (_req, res) => handler(res),
  );
  errorRun.router.use(renderRefusal);
  const refused = await errorRun.router.fetch("/x");
  const body =
    refused.status === 500
      ? ((await refused.json()) as { issues: string[] })
      : { issues: [] };
  if (refused.status !== 500) await refused.arrayBuffer();
  return {
    warn: {
      status: warned.status,
      warned: mismatches(warnRun.events).length,
    },
    error: { status: refused.status, issues: body.issues },
  };
}

const USER = z.object({ id: z.string() });

describe("validate() responses: status", () => {
  it("an undeclared status fails (H25)", async () => {
    const out = await underModes({ 200: USER }, (res) =>
      res.status(418).json({ id: "a" }),
    );
    expect(out.warn).toEqual({ status: 418, warned: 1 });
    expect(out.error).toEqual({ status: 500, issues: ["status"] });
  });

  it("the implicit 200 is a status like any other (H26)", async () => {
    const out = await underModes({ 201: USER }, (res) => res.json({ id: "a" }));
    expect(out.warn).toEqual({ status: 200, warned: 1 });
    expect(out.error).toEqual({ status: 500, issues: ["status"] });
  });

  it("names the declared statuses, never what was sent", async () => {
    const { router } = routerFor("error");
    let message = "";
    router.get(
      "/x",
      validate({}, { responses: { 200: USER, 404: null } }),
      (_req, res) => untyped(res).status(418).end(),
    );
    router.use(((error, _req, res, _next) => {
      message = (error as ResponseValidationError).issues[0].message;
      void res.status(500).end();
    }) satisfies RouterErrorMiddlewareHandler);
    await router.fetch("/x");
    expect(message).toBe("This status is not declared (200, 404)");
  });

  it("redirect() to an undeclared 3xx fails (H35)", async () => {
    const out = await underModes({ 302: {} }, (res) =>
      res.redirect(301, "/app"),
    );
    expect(out.warn).toEqual({ status: 301, warned: 1 });
    expect(out.error).toEqual({ status: 500, issues: ["status"] });
  });

  it("sendStatus() of an undeclared status fails, its generated body exempt (H36)", async () => {
    const out = await underModes({ 200: USER }, (res) => res.sendStatus(404));
    expect(out.error).toEqual({ status: 500, issues: ["status"] });
    // Declared with a JSON body, the generated text is not held to it.
    const declared = await underModes({ 404: USER }, (res) =>
      res.sendStatus(404),
    );
    expect(declared.error.status).toBe(404);
    expect(declared.warn.warned).toBe(0);
  });

  it("a redirect's generated body is exempt from a declared body", async () => {
    const out = await underModes({ 302: USER }, (res) => res.redirect("/app"));
    expect(out.error.status).toBe(302);
    expect(out.warn.warned).toBe(0);
  });

  it("a 204 declared null passes with no body (H33); a body on a null status fails (H34)", async () => {
    const empty = await underModes({ 204: null }, (res) =>
      res.status(204).end(),
    );
    expect(empty.error.status).toBe(204);
    const withBody = await underModes({ 404: null }, (res) =>
      res.status(404).json({ code: "x" }),
    );
    expect(withBody.warn).toEqual({ status: 404, warned: 1 });
    expect(withBody.error).toEqual({ status: 500, issues: ["body"] });
  });
});

describe("validate() responses: headers", () => {
  const RateLimited = {
    200: {
      headers: z.object({ "x-ratelimit-remaining": z.string().regex(/^\d+$/) }),
      content: { "application/json": USER },
    },
  };

  it("a mismatched header fails (H28)", async () => {
    const out = await underModes(RateLimited, (res) =>
      res.set("X-RateLimit-Remaining", "many").json({ id: "a" }),
    );
    expect(out.warn).toEqual({ status: 200, warned: 1 });
    expect(out.error).toEqual({
      status: 500,
      issues: ["headers.x-ratelimit-remaining"],
    });
  });

  it("a missing header fails (H29); a right one passes (H30)", async () => {
    const missing = await underModes(RateLimited, (res) =>
      res.json({ id: "a" }),
    );
    expect(missing.error).toEqual({
      status: 500,
      issues: ["headers.x-ratelimit-remaining"],
    });
    const right = await underModes(RateLimited, (res) =>
      res.set("X-RateLimit-Remaining", "9").json({ id: "a" }),
    );
    expect(right.error.status).toBe(200);
    expect(right.warn.warned).toBe(0);
  });

  it("sees the implicit Content-Type, lower-case names and no set-cookie", async () => {
    let seen: Record<string, unknown> | undefined;
    const spy: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "spy",
        validate: (value) => {
          seen = value as Record<string, unknown>;
          return { value };
        },
      },
    };
    const { router } = routerFor("error");
    router.get(
      "/x",
      validate({}, { responses: { 200: { headers: spy } } }),
      (_req, res) => res.cookie("sid", "v").set("X-Trace", "t").send("plain"),
    );
    const response = await router.fetch("/x");
    expect(response.status).toBe(200);
    expect(seen?.["content-type"]).toBe("text/plain;charset=utf-8");
    expect(seen?.["x-trace"]).toBe("t");
    expect(seen?.["set-cookie"]).toBeUndefined();
  });
});

describe("validate() responses: cookies (H31–H32)", () => {
  const Session = {
    200: {
      cookies: z.object({
        sid: z.object({
          value: z.string(),
          httpOnly: z.literal(true),
          secure: z.literal(true),
          sameSite: z.literal("Lax"),
          path: z.literal("/"),
        }),
      }),
    },
  };

  it("a Set-Cookie without HttpOnly fails (H31)", async () => {
    const out = await underModes(Session, (res) =>
      res.cookie("sid", "abc", { secure: true, sameSite: "lax" }).json({}),
    );
    expect(out.warn).toEqual({ status: 200, warned: 1 });
    expect(out.error).toEqual({
      status: 500,
      issues: ["cookies.sid.httpOnly"],
    });
  });

  it("the declared Set-Cookie passes (H32); a missing one fails", async () => {
    const right = await underModes(Session, (res) =>
      res
        .cookie("sid", "abc", { httpOnly: true, secure: true, sameSite: "lax" })
        .json({}),
    );
    expect(right.error.status).toBe(200);
    const missing = await underModes(Session, (res) => res.json({}));
    expect(missing.error).toEqual({ status: 500, issues: ["cookies.sid"] });
  });

  it("views each line as its value and every attribute res.cookie() writes (Q-H11)", async () => {
    const res = new BunResponse(await makeRequest());
    res.cookie("sid", "a b;c", {
      httpOnly: true,
      secure: true,
      path: "/app",
      domain: "example.com",
      maxAge: 60_000,
      partitioned: true,
      priority: "high",
      sameSite: "none",
    });
    res.cookie("prefs", { theme: "dark" });
    res.cookie("plain", "x", { sameSite: false });
    const view = setCookieView(res.getHeader("set-cookie") ?? []);
    expect(view.sid).toEqual({
      value: "a b;c",
      httpOnly: true,
      secure: true,
      partitioned: true,
      sameSite: "None",
      priority: "High",
      path: "/app",
      domain: "example.com",
      maxAge: 60,
      expires: expect.any(Date),
    });
    // An object is written `j:`-prefixed, and seen as written.
    expect(view.prefs).toEqual({
      value: 'j:{"theme":"dark"}',
      httpOnly: false,
      secure: false,
      partitioned: false,
      sameSite: "Lax",
      path: "/",
    });
    expect(view.plain).toEqual({
      value: "x",
      httpOnly: false,
      secure: false,
      partitioned: false,
      path: "/",
    });
  });
});

describe("validate() responses: media types (Q-C4, Q-C14)", () => {
  it("an undeclared media type fails (H27, H37)", async () => {
    const text = await underModes({ 200: USER }, (res) => res.send("hi"));
    expect(text.warn).toEqual({ status: 200, warned: 1 });
    expect(text.error).toEqual({ status: 500, issues: ["body"] });
    const csv = await underModes({ 200: USER }, (res) =>
      res.type("text/csv").send("a,b"),
    );
    expect(csv.error).toEqual({ status: 500, issues: ["body"] });
  });

  it("matches case-insensitively, with parameters stripped on both sides", async () => {
    const declared = {
      200: {
        content: { "Text/Plain; version=0.0.4": z.string().startsWith("#") },
      },
    };
    const ok = await underModes(declared, (res) =>
      res.type("TEXT/PLAIN; charset=utf-8").send("# metrics"),
    );
    expect(ok.error.status).toBe(200);
    expect(ok.warn.warned).toBe(0);
    const bad = await underModes(declared, (res) =>
      res.type("text/plain").send("no hash"),
    );
    expect(bad.error).toEqual({ status: 500, issues: ["body"] });
  });

  it("the most specific key wins: exact, then type/*, then */*", async () => {
    const declared = {
      200: {
        content: {
          "*/*": z.instanceof(Uint8Array),
          "text/*": z.string().max(3),
          "text/plain": z.string(),
        },
      },
    };
    // text/plain: the exact key, so a long string passes.
    const exact = await underModes(declared, (res) => res.send("a long line"));
    expect(exact.error.status).toBe(200);
    // text/html: the family key, which allows 3 characters.
    const family = await underModes(declared, (res) =>
      res.type("html").send("<p>too long</p>"),
    );
    expect(family.error).toEqual({ status: 500, issues: ["body"] });
    const shortHtml = await underModes(declared, (res) =>
      res.type("html").send("<p>"),
    );
    expect(shortHtml.error.status).toBe(200);
    // image/png: only */* matches, and sees the bytes.
    const any = await underModes(declared, (res) =>
      res.type("png").send(new Uint8Array([1, 2])),
    );
    expect(any.error.status).toBe(200);
    // JSON under */*: the schema sees the value, not bytes, and fails.
    const json = await underModes(declared, (res) => res.json({ id: "a" }));
    expect(json.error).toEqual({ status: 500, issues: ["body"] });
  });

  it("names the declared media keys as written, never the type sent", async () => {
    const { router } = routerFor("error");
    let found: { message: string; mediaType?: string } | undefined;
    router.get(
      "/x",
      validate(
        {},
        { responses: { 200: { content: { "text/plain; v=1": z.string() } } } },
      ),
      (_req, res) => res.type("application/x-secret").send("x"),
    );
    router.use(((error, _req, res, _next) => {
      found = (error as ResponseValidationError).issues[0];
      void res.status(500).end();
    }) satisfies RouterErrorMiddlewareHandler);
    await router.fetch("/x");
    expect(found?.message).toBe(
      "This media type is not declared (text/plain; v=1)",
    );
    expect(found?.mediaType).toBeUndefined();
  });

  it("refuses keys that tie once bare and lower-cased, and keys that are not media types", () => {
    expect(() =>
      validate(
        {},
        {
          responses: {
            200: {
              content: {
                "text/plain": z.string(),
                "TEXT/PLAIN; charset=utf-8": z.string(),
              },
            },
          },
        },
      ),
    ).toThrow("are the same media type");
    for (const key of ["json", "*/json", "text/x*", "a/b/c", "*"]) {
      expect(() =>
        validate(
          {},
          { responses: { 200: { content: { [key]: z.string() } } } },
        ),
      ).toThrow("is not a media type");
    }
  });

  it("a documented() body declares its media type without checking it", async () => {
    const out = await underModes(
      {
        200: {
          content: { "application/json": documented({ type: "object" }) },
        },
      },
      (res) => res.json({ anything: true }),
    );
    expect(out.error.status).toBe(200);
    const other = await underModes(
      {
        200: {
          content: { "application/json": documented({ type: "object" }) },
        },
      },
      (res) => res.send("text"),
    );
    expect(other.error).toEqual({ status: 500, issues: ["body"] });
  });
});

// ---------------------------------------------------------------------------
// Exemptions and the error pipeline
// ---------------------------------------------------------------------------

describe("validate() responses: exemptions", () => {
  it("HEAD is checked as the GET it reuses (H41)", async () => {
    const { router } = routerFor("error");
    router.get("/x", validate({}, { responses: { 200: N_ZOD } }), (_req, res) =>
      res.json({ n: "bad" } as never),
    );
    router.use(renderRefusal);
    expect((await router.fetch("/x", { method: "HEAD" })).status).toBe(500);
    const good = new BunRouter({ responseValidation: "error" });
    good.get("/x", validate({}, { responses: { 200: N_ZOD } }), (_req, res) =>
      res.json({ n: 1 }),
    );
    expect((await good.fetch("/x", { method: "HEAD" })).status).toBe(200);
  });

  it("a freshness 304 for a conditional request is allowed undeclared (H42, Q-H1)", async () => {
    const { router, events } = routerFor("error");
    router.get("/x", validate({}, { responses: { 200: N_ZOD } }), (_req, res) =>
      res.setEtag(true).json({ n: 1 }),
    );
    router.use(renderRefusal);
    const first = await router.fetch("/x");
    const tag = first.headers.get("etag")!;
    await first.arrayBuffer();
    const again = await router.fetch("/x", {
      headers: { "if-none-match": tag },
    });
    expect(again.status).toBe(304);
    expect(mismatches(events)).toEqual([]);
  });

  it("negative control: a 304 without a conditional request is undeclared", async () => {
    const { router } = routerFor("error");
    router.get("/x", validate({}, { responses: { 200: N_ZOD } }), (_req, res) =>
      res.status(304 as never).end(),
    );
    router.use(renderRefusal);
    expect((await router.fetch("/x")).status).toBe(500);
  });

  it("with no error handler, router.fetch() rejects with the ResponseValidationError (H43)", async () => {
    const router = new BunRouter({ responseValidation: "error" });
    router.get("/x", validate({}, { responses: { 200: N_ZOD } }), (_req, res) =>
      res.json({ n: "x" } as never),
    );
    const failed = await router.fetch("/x").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(ResponseValidationError);
  });

  it("the adapter answers 500 when no error handler takes it", async () => {
    const adapter = new BunHttpAdapter(0, { responseValidation: "error" });
    adapter.get(
      "/x",
      validate({}, { responses: { 200: N_ZOD } }),
      (_req, res) => res.json({ n: "x" } as never),
    );
    const response = await adapter.fetch("/x");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("x");
  });

  it("an error handler's response is checked but only reported (H44, Q-H2)", async () => {
    const { router, events } = routerFor("error");
    router.get("/x", validate({}, { responses: { 200: N_ZOD } }), () => {
      throw new Error("boom");
    });
    router.use(((_error, _req, res, _next) => {
      res.status(503).json({ error: "unavailable" });
    }) satisfies RouterErrorMiddlewareHandler);
    const response = await router.fetch("/x");
    expect(response.status).toBe(503);
    const reported = mismatches(events);
    expect(reported).toHaveLength(1);
    expect(reported[0].message).toContain("error handler");
  });

  it("negative control: the same response from a route handler is refused", async () => {
    const { router } = routerFor("error");
    router.get("/x", validate({}, { responses: { 200: N_ZOD } }), (_req, res) =>
      res.status(503 as never).json({ error: "unavailable" } as never),
    );
    router.use(renderRefusal);
    expect((await router.fetch("/x")).status).toBe(500);
  });

  it("an error handler handing the pipeline back ends its report-only spell", async () => {
    const { router } = routerFor("error");
    router.get(
      "/x",
      validate({}, { responses: { 200: N_ZOD } }),
      (_req, _res, next) => next(new Error("first")),
    );
    router.use(((_error, _req, _res, next) => {
      next();
    }) satisfies RouterErrorMiddlewareHandler);
    router.use((_req, res) => res.status(418).send("teapot"));
    router.use(renderRefusal);
    const response = await router.fetch("/x");
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toBe(
      "ResponseValidationError",
    );
  });

  it("a refusal drops the refused response's own headers and keeps request-wide ones (H45, Q-H3)", async () => {
    const { router } = routerFor("error");
    router.use((_req, res, next) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.vary("Origin");
      next();
    });
    router.get(
      "/x",
      validate(
        {},
        {
          responses: {
            302: {
              headers: z.object({ location: z.string().startsWith("/app") }),
            },
          },
        },
      ),
      (_req, res) => {
        res.cookie("sid", "x");
        res.set("ETag", '"abc"');
        res.set("Last-Modified", new Date(0).toUTCString());
        res.set("Content-Disposition", "attachment");
        res.redirect("/elsewhere");
      },
    );
    router.use(renderRefusal);
    const response = await router.fetch("/x");
    expect(response.status).toBe(500);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("last-modified")).toBeNull();
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("negative control: the refused response's own status does not leak into the error handler's", async () => {
    const { router } = routerFor("error");
    router.get("/x", validate({}, { responses: { 200: N_ZOD } }), (_req, res) =>
      untyped(res).status(201).json({ n: 1 }),
    );
    router.use(((_error, _req, res, _next) => {
      res.json({ handled: true });
    }) satisfies RouterErrorMiddlewareHandler);
    expect((await router.fetch("/x")).status).toBe(200);
  });

  it("a refusal made after the pipeline ended answers 500 and logs it", async () => {
    const { logger, events } = createTestLogger();
    const adapter = new BunHttpAdapter(0, {
      logger,
      responseValidation: "error",
    });
    adapter.use(validate({}, { responses: { 200: N_ZOD } }));
    adapter.setNotFoundHandler((_req, res) => {
      res.status(404).json({ code: "none" });
    });
    const response = await adapter.fetch("/nothing-here");
    expect(response.status).toBe(500);
    expect(
      events.some(
        (e) => e.level === "error" && e.message.includes("after the pipeline"),
      ),
    ).toBe(true);
  });

  it("a validator's own onFailure: 'respond' answer is exempt from a mount's gate", async () => {
    const router = new BunRouter({ responseValidation: "error" });
    router.use(validate({}, { responses: { 200: N_ZOD } }));
    router.get(
      "/x",
      validate(
        { query: z.object({ n: z.coerce.number() }) },
        { onFailure: "respond" },
      ),
      (_req, res) => res.json({ n: 1 }),
    );
    expect((await router.fetch("/x?n=abc")).status).toBe(400);
    expect((await router.fetch("/x?n=1")).status).toBe(200);
  });

  it("a piped stream's status and media type are checked; its body is not (V3b), with one warning", async () => {
    const { router, events } = routerFor("error");
    router.get(
      "/x",
      validate(
        {},
        {
          responses: { 200: { content: { "text/plain": z.string().max(1) } } },
        },
      ),
      (_req, res) =>
        res.type("text/plain").send(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("long body"));
              c.close();
            },
          }),
        ),
    );
    router.use(renderRefusal);
    const response = await router.fetch("/x");
    expect(await read(response)).toEqual({ status: 200, text: "long body" });
    await router.fetch("/x").then((r) => r.text());
    expect(
      events.filter((e) =>
        e.message.includes("is not checked against a whole-body"),
      ),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Router and adapter settings, commonResponses
// ---------------------------------------------------------------------------

describe("responseValidation: route over router over adapter", () => {
  /** A bad body, from a validator with `own` mode, on a router with `routerMode`. */
  async function status(own: Mode | undefined, routerMode: Mode | undefined) {
    const router = new BunRouter(
      routerMode === undefined ? {} : { responseValidation: routerMode },
    );
    router.get(
      "/x",
      validate(
        {},
        own === undefined
          ? { responses: { 200: N_ZOD } }
          : { responses: { 200: N_ZOD }, responseValidation: own },
      ),
      (_req, res) => res.json({ n: "x" } as never),
    );
    router.use(renderRefusal);
    return (await router.fetch("/x")).status;
  }

  it("defaults to off", async () => {
    expect(await status(undefined, undefined)).toBe(200);
  });

  it("the router's setting applies to a validator without its own", async () => {
    expect(await status(undefined, "error")).toBe(500);
  });

  it("the validator's own wins over the router's", async () => {
    expect(await status("off", "error")).toBe(200);
    expect(await status("error", "off")).toBe(500);
  });

  it("a mounted router's setting wins over the adapter's", async () => {
    for (const [inner, expected] of [
      [undefined, 500],
      ["off", 200],
    ] as const) {
      const adapter = new BunHttpAdapter(0, { responseValidation: "error" });
      const sub = new BunRouter(
        inner === undefined ? {} : { responseValidation: inner },
      );
      sub.get("/x", validate({}, { responses: { 200: N_ZOD } }), (_req, res) =>
        res.json({ n: "x" } as never),
      );
      adapter.use("/s", sub);
      expect((await adapter.fetch("/s/x")).status).toBe(expected);
    }
  });

  it("a mounted router that set its own logger gets its routes' warnings", async () => {
    for (const subHasLogger of [true, false]) {
      const adapterLog = createTestLogger();
      const subLog = createTestLogger();
      const adapter = new BunHttpAdapter(0, {
        responseValidation: "warn",
        logger: adapterLog.logger,
      });
      const sub = new BunRouter();
      if (subHasLogger) {
        sub.setLogger(subLog.logger);
      }
      sub.get("/x", validate({}, { responses: { 200: N_ZOD } }), (_req, res) =>
        res.json({ n: "x" } as never),
      );
      adapter.use("/s", sub);
      expect((await adapter.fetch("/s/x")).status).toBe(200);
      const warned = (events: { level: string }[]): number =>
        events.filter((event) => event.level === "warn").length;
      // Before: mounting rebound every warning to the adapter's logger.
      expect(warned(subLog.events)).toBe(subHasLogger ? 1 : 0);
      expect(warned(adapterLog.events)).toBe(subHasLogger ? 0 : 1);
    }
  });

  it("refuses an unknown mode when declared", () => {
    expect(
      () => new BunRouter({ responseValidation: "strict" as never }),
    ).toThrow(TypeError);
    expect(() =>
      validate({}, { responses: {}, responseValidation: "strict" as never }),
    ).toThrow(TypeError);
  });
});

describe("commonResponses", () => {
  const Problem = z.object({ code: z.string() });

  it("declares statuses every route on the router may answer", async () => {
    const router = new BunRouter({
      responseValidation: "error",
      commonResponses: { 401: Problem },
    });
    router.get("/x", validate({}, { responses: { 200: N_ZOD } }), (req, res) =>
      req.query.auth === undefined
        ? res.status(401 as never).json({ code: "AUTH" } as never)
        : res.json({ n: 1 }),
    );
    router.use(renderRefusal);
    expect((await router.fetch("/x")).status).toBe(401);
    expect((await router.fetch("/x?auth=1")).status).toBe(200);
  });

  it("negative control: without it, the same 401 is refused", async () => {
    const router = new BunRouter({ responseValidation: "error" });
    router.get("/x", validate({}, { responses: { 200: N_ZOD } }), (_req, res) =>
      res.status(401 as never).json({ code: "AUTH" } as never),
    );
    router.use(renderRefusal);
    expect((await router.fetch("/x")).status).toBe(500);
  });

  it("merges per status and part, the route winning, and an inner router over the adapter", async () => {
    const adapter = new BunHttpAdapter(0, {
      responseValidation: "error",
      commonResponses: {
        404: {
          headers: z.object({ "x-reason": z.string() }),
          content: { "application/json": Problem },
        },
        409: Problem,
      },
    });
    const sub = new BunRouter({
      commonResponses: { 409: { content: { "text/plain": z.string() } } },
    });
    sub.get(
      "/x",
      validate(
        {},
        { responses: { 404: { content: { "text/plain": z.string() } } } },
      ),
      (req, res) => {
        const r = res as unknown as BunResponse;
        if (req.query.k === "404")
          return r.status(404).set("X-Reason", "gone").send("gone");
        if (req.query.k === "404-noheader") return r.status(404).send("gone");
        if (req.query.k === "409-json")
          return r.status(409).json({ code: "x" });
        return r.status(409).send("conflict");
      },
    );
    sub.use(renderRefusal);
    adapter.use("/s", sub);
    // The route's 404 body (text) replaces the adapter's (JSON); its headers still apply.
    expect((await adapter.fetch("/s/x?k=404")).status).toBe(404);
    expect((await adapter.fetch("/s/x?k=404-noheader")).status).toBe(500);
    // The sub-router's 409 (text) replaces the adapter's (JSON).
    expect((await adapter.fetch("/s/x?k=409")).status).toBe(409);
    expect((await adapter.fetch("/s/x?k=409-json")).status).toBe(500);
  });

  it("does not check a route whose validators declare no responses", async () => {
    const router = new BunRouter({
      responseValidation: "error",
      commonResponses: { 401: Problem },
    });
    router.get("/x", validate({ query: z.object({}) }), (_req, res) =>
      res.status(418).send("anything"),
    );
    expect((await router.fetch("/x")).status).toBe(418);
  });

  it("refuses a declaration that is not a response table", () => {
    expect(
      () => new BunRouter({ commonResponses: { abc: Problem } as never }),
    ).toThrow("is not a status code");
  });
});

describe("a mount's validator and a route's", () => {
  it("combine their tables, the route winning per status and part", async () => {
    const router = new BunRouter({ responseValidation: "error" });
    router.use(
      "/m",
      validate({}, { responses: { 401: z.object({ code: z.string() }) } }),
    );
    router.get(
      "/m/x",
      validate({}, { responses: { 200: N_ZOD } }),
      (req, res) => {
        const r = res as unknown as BunResponse;
        if (req.query.k === "401") return r.status(401).json({ code: "x" });
        if (req.query.k === "418") return r.status(418).end();
        return r.json({ n: 1 });
      },
    );
    router.use(renderRefusal);
    expect((await router.fetch("/m/x?k=401")).status).toBe(401);
    expect((await router.fetch("/m/x")).status).toBe(200);
    expect((await router.fetch("/m/x?k=418")).status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Declarations, the contract, zero cost
// ---------------------------------------------------------------------------

describe("validate() responses: declarations", () => {
  it("refuses what is not a response table", () => {
    const bad: [unknown, string][] = [
      [{ abc: USER }, "is not a status code"],
      [{ 99: USER }, "is not a status code"],
      [{ 600: USER }, "is not a status code"],
      [{ 200: "json" }, "expected a Standard Schema, null"],
      [{ 200: { body: USER } }, '"body" is not a response part'],
      [{ 200: { headers: {} } }, "expected a Standard Schema"],
      [
        { 200: { content: { "application/json": {} } } },
        "expected a Standard Schema",
      ],
      [{ 200: { content: "json" } }, "expected an object keyed by media type"],
      ["nope", "expected an object keyed by status code"],
    ];
    for (const [responses, message] of bad) {
      expect(() => validate({}, { responses: responses as never })).toThrow(
        message,
      );
    }
  });

  it("puts the responses on the validator's contract, media keys as written", () => {
    const middleware = validate(
      { query: z.object({ q: z.string() }) },
      {
        responses: {
          200: {
            headers: USER,
            content: { "text/plain; version=0.0.4": z.string() },
          },
          204: null,
          404: USER,
        },
      },
    );
    const described = describeContract(getContract(middleware)!);
    expect(described.sides.outbound).toEqual({
      declared: true,
      keys: ["200", "204", "404"],
    });
    expect(
      described.entries
        .filter((e) => e.side === "outbound")
        .map((e) => [e.key, e.part, e.mediaType ?? null, e.encoding]),
    ).toEqual([
      ["200", "headers", null, "header-string"],
      ["200", "body", "text/plain; version=0.0.4", "body"],
      ["204", "body", null, "body"],
      ["404", "body", "application/json", "body"],
    ]);
  });

  it("a declared status beats onFailure: 'respond''s implicit one on the contract", () => {
    const own = validate(
      { query: USER },
      {
        onFailure: "respond",
        responses: { 400: { content: { "text/plain": z.string() } } },
      },
    );
    const rows = describeContract(getContract(own)!).entries.filter(
      (e) => e.side === "outbound",
    );
    expect(rows.map((e) => [e.key, e.mediaType, e.implicit ?? false])).toEqual([
      ["400", "text/plain", false],
    ]);
  });
});

describe("zero cost without responses", () => {
  /** Dispatches `/x` through `router`, returning the outcome and the response. */
  async function dispatch(router: BunRouter) {
    const request = await makeRequest({ url: "http://localhost/x" });
    const response = new BunResponse(request);
    const result = router.dispatch({
      requestHost: "localhost",
      requestMethod: "GET",
      requestUrl: "/x",
      request,
      response,
    });
    return { result, response };
  }

  it("a validator without responses carries no binding and is registered as it is", () => {
    const middleware = validate({ query: z.object({}) });
    expect(RESPONSE_BINDING in middleware).toBe(false);
    const router = new BunRouter({ responseValidation: "error" });
    router.get("/x", middleware, (_req, res) => res.end());
    expect(router.routes()[0].callbacks[0]).toBe(middleware);
  });

  it("responses under 'off' register the validator as it is: nothing is installed", () => {
    const middleware = validate({}, { responses: { 200: N_ZOD } });
    const router = new BunRouter();
    router.get("/x", middleware, (_req, res) => res.json({ n: 1 }));
    expect(router.routes()[0].callbacks[0]).toBe(middleware);
    // Under a checking router it is bound to its settings.
    const checking = new BunRouter({ responseValidation: "error" });
    checking.get("/x", middleware, (_req, res) => res.json({ n: 1 }));
    expect(checking.routes()[0].callbacks[0]).not.toBe(middleware);
  });

  it("the committed Response is the very one produced, and a sync request stays sync", async () => {
    for (const router of [
      new BunRouter(),
      new BunRouter({ responseValidation: "off" }),
    ]) {
      const produced = Response.json({ n: 1 });
      router.get(
        "/x",
        validate({}, { responses: { 200: N_ZOD } }),
        (_req, res) => res.send(produced),
      );
      const { result, response } = await dispatch(router);
      expect(result).not.toBeInstanceOf(Promise);
      expect(response.settledResponse).toBe(produced);
    }
  });

  it("a synchronous vendor under 'error' keeps a sync request sync", async () => {
    const router = new BunRouter({ responseValidation: "error" });
    router.get("/x", validate({}, { responses: { 200: N_ZOD } }), (_req, res) =>
      res.json({ n: 1 }),
    );
    const { result, response } = await dispatch(router);
    expect(result).not.toBeInstanceOf(Promise);
    expect(response.headersSent).toBe(true);
  });

  it("BunValidate.middleware() takes responses too", async () => {
    const router = new BunRouter();
    router.get(
      "/x",
      BunValidate.middleware({
        schemas: {},
        responses: { 200: N_ZOD },
        responseValidation: "error",
      }),
      (_req, res) => res.json({ n: "x" } as never),
    );
    router.use(renderRefusal);
    expect((await router.fetch("/x")).status).toBe(500);
  });
});
