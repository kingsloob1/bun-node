/**
 * Response variants (plan `docs/plans/bun-validate/` §4.4.6, V3c): within
 * one status, several whole responses (`variants()`), of which a response
 * must match one, selected by `res.variant()` or a discriminant, applicable
 * by `when`, never mixed. RV-numbers name the cases of
 * `evidence/response-variants/run.ts`, here through `router.fetch()` and,
 * where a stream or a cut-off matters, over a socket on port 0.
 *
 * Every refused body and every log line of the file is searched for the
 * planted values (RV16) after the last test.
 */
import type { LogEvent } from "../lib/logging";
import type { Refine } from "../lib/responseBodies";
import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as v from "valibot";
import * as yup from "yup";
import { z } from "zod";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunResponse } from "../lib/BunResponse";
import { BunRouter } from "../lib/BunRouter";
import { validate } from "../lib/BunValidate";
import { describeContract, mergeContracts } from "../lib/contract/describe";
import { createReceiver, createSender } from "../lib/contract/guard";
import { getContract } from "../lib/contract/transport";
import { createTestLogger } from "../lib/logging";
import { chunks, variants } from "../lib/responseBodies";
import {
  RESPONSE_BINDING,
  ResponseValidationError,
} from "../lib/responseValidation";
import { makeRequest } from "./helpers";

type Mode = "off" | "warn" | "error";

/** Planted in bodies, headers and a refine's message: must reach no issue and no log line (RV16). */
const SECRET = "s3cr3t-salary-77";
/** Planted as a discriminant's received value. */
const WEIRD = "weird-mode-value";
/** Planted where a refine quotes it. */
const QUOTED = "Alice-Secret";

/** Every test logger's lines and every refused issue list of the file, for RV16. */
const logs: LogEvent[][] = [];
const seenIssues: unknown[] = [];

/** Adapters to close after each test. */
const open: BunHttpAdapter[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

/** One issue as a refused body carries it. */
interface Issue {
  /** The part. */
  target: string;
  /** The message. */
  message: string;
  /** The path. */
  path: string;
  /** The status. */
  key?: string;
  /** The variant. */
  variant?: string;
  /** The media type. */
  mediaType?: string;
}

/** Renders a `ResponseValidationError` as a 500 carrying its issues. */
const renderRefusal = ((error, _req, res, _next) => {
  if (error instanceof ResponseValidationError) {
    seenIssues.push(error.issues);
    res.status(500).json({
      error: error.name,
      responseStatus: error.responseStatus,
      issues: error.issues,
    });
    return;
  }
  res.status(500).json({ error: String(error) });
}) satisfies RouterErrorMiddlewareHandler;

/** How a test reaches its routes. */
type Via = "socket" | "router.fetch()";

/** A router (or a listening adapter) logging into a test sink, under `mode`; the refusal renderer registered last. */
async function serve(
  mode: Mode | undefined,
  build: (router: BunRouter) => void,
  via: Via = "router.fetch()",
): Promise<{
  get: (path: string, headers?: Record<string, string>) => Promise<Response>;
  router: BunRouter;
  events: LogEvent[];
}> {
  const { logger, events } = createTestLogger();
  logs.push(events);
  const options =
    mode === undefined ? { logger } : { logger, responseValidation: mode };
  if (via === "router.fetch()") {
    const router = new BunRouter(options);
    build(router);
    router.use(renderRefusal);
    return {
      router,
      events,
      get: async (path, headers = {}) =>
        router.fetch(new Request(`http://localhost${path}`, { headers })),
    };
  }
  const adapter = new BunHttpAdapter(0, options);
  build(adapter);
  adapter.use(renderRefusal);
  await adapter.listen(0);
  open.push(adapter);
  return {
    router: adapter as unknown as BunRouter,
    events,
    get: async (path, headers = {}) =>
      fetch(`http://127.0.0.1:${adapter.listeningPort}${path}`, { headers }),
  };
}

afterAll(() => {
  // RV16: no planted value in any issue or log line of the file.
  const text = JSON.stringify([seenIssues, logs], (_k, v: unknown) =>
    v instanceof Error ? { name: v.name, message: v.message } : v,
  );
  for (const planted of [SECRET, WEIRD, QUOTED]) {
    expect(text.includes(planted)).toBe(false);
  }
});

/** A test's log lines (every test logger's are also searched for RV16). */
function seen(events: LogEvent[]): LogEvent[] {
  return events;
}

/** A typed `res` as the unconstrained `BunResponse`, to send what its contract does not declare. */
const untyped = (res: unknown): BunResponse => res as BunResponse;

/** `res.variant(name)` on an unconstrained response (the types are checked in `variants.type-test.ts`). */
const named = (res: unknown, name: string): BunResponse =>
  (res as { variant: (n: string) => BunResponse }).variant(name);

/** A refused response's issues. */
async function issuesOf(response: Response): Promise<Issue[]> {
  expect(response.status).toBe(500);
  const body = (await response.json()) as { issues?: Issue[] };
  expect(body.issues).toBeDefined();
  return body.issues!;
}

/** The warnings a response mismatch logged. */
const mismatches = (events: LogEvent[]): LogEvent[] =>
  seen(events).filter(
    (e) => e.level === "warn" && e.message.includes("does not match"),
  );

/** Waits for a condition a background check settles (a yup Promise). */
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(1);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AdminHeader = z.object({ "x-admin": z.literal("1").optional() });
const ZAdminView = z.object({
  id: z.string(),
  role: z.literal("admin"),
  salary: z.number(),
  note: z.string(),
});
const ZUserView = z.object({ id: z.string(), role: z.literal("user") });
const YAdminView = yup.object({
  id: yup.string().required(),
  role: yup.string().oneOf(["admin"]).required(),
  salary: yup.number().required(),
});
const YUserView = yup.object({
  id: yup.string().required(),
  role: yup.string().oneOf(["user"]).required(),
});
const adminBody = { id: "a", role: "admin", salary: 1, note: SECRET };
const userBody = { id: "a", role: "user" };
const ADMIN = { "x-admin": "1" };

/** The user's example (RV1–RV4): an admin, recognised by a request header, gets another body and a response header. */
function byRequest(vendor: "zod" | "yup") {
  const zod = vendor === "zod";
  return validate(
    { headers: AdminHeader },
    {
      responses: {
        200: variants({
          admin: {
            when: (valid) => valid.headers["x-admin"] === "1",
            headers: zod
              ? z.object({ "x-admin": z.literal("1") })
              : yup.object({ "x-admin": yup.string().oneOf(["1"]).required() }),
            content: { "application/json": zod ? ZAdminView : YAdminView },
          },
          // A headers schema sees every header, so "x-admin must be absent"
          // is said: zod 4's `z.undefined()` would make the key required.
          user: {
            headers: zod
              ? z.object({ "x-admin": z.never().optional() })
              : yup.object({
                  "x-admin": yup
                    .string()
                    .test("absent", "must be absent", (x) => x === undefined),
                }),
            content: { "application/json": zod ? ZUserView : YUserView },
          },
        }),
        404: z.object({ code: z.string() }),
      },
    },
  );
}

/** Sends what `?send=` names, through the unconstrained response. */
function sender(req: { query: Record<string, unknown> }, res: unknown): void {
  const r = untyped(res);
  switch (req.query.send) {
    case "admin":
      r.status(200).set("x-admin", "1").json(adminBody);
      return;
    case "mixed":
      r.status(200).set("x-admin", "1").json(userBody);
      return;
    case "admin-bare":
      r.status(200).json(adminBody);
      return;
    default:
      r.status(200).json(userBody);
  }
}

// ---------------------------------------------------------------------------
// RV1–RV5: a whole match per variant, and `when`
// ---------------------------------------------------------------------------

describe.each(["zod", "yup"] as const)(
  "variants by request, %s (RV1–RV5)",
  (vendor) => {
    it("RV1: an admin request, x-admin: 1 and the admin body: sent", async () => {
      const { get } = await serve("error", (r) => {
        r.get("/me", byRequest(vendor), sender);
      });
      const res = await get("/me?send=admin", ADMIN);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-admin")).toBe("1");
      expect(await res.json()).toEqual(adminBody);
    });

    it("RV2: x-admin: 1 with a user body (parts from two variants): refused, each variant's own issues", async () => {
      const { get } = await serve("error", (r) => {
        r.get("/me", byRequest(vendor), sender);
      });
      const issues = await issuesOf(await get("/me?send=mixed", ADMIN));
      expect(issues[0]).toEqual({
        target: "status",
        message: "The response matches no acceptable variant (admin, user)",
        path: "",
        key: "200",
      });
      expect(
        issues.some((i) => i.variant === "admin" && i.target === "body"),
      ).toBe(true);
      expect(
        issues.some(
          (i) =>
            i.variant === "user" &&
            i.target === "headers" &&
            i.path === "x-admin",
        ),
      ).toBe(true);
    });

    it("RV3: a non-admin answered with a valid admin response (the leak): refused, the excluded variant named", async () => {
      const { get } = await serve("error", (r) => {
        r.get("/me", byRequest(vendor), sender);
      });
      const issues = await issuesOf(await get("/me?send=admin"));
      expect(issues.map((i) => i.message)).toContain(
        'The response matches variant "admin", which does not apply to this request',
      );
      expect(
        issues.find((i) => i.message.startsWith("The response matches variant"))
          ?.variant,
      ).toBe("admin");
    });

    it("RV4: a non-admin, the user body: sent", async () => {
      const { get } = await serve("error", (r) => {
        r.get("/me", byRequest(vendor), sender);
      });
      const res = await get("/me");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(userBody);
    });

    it("under warn: the leak is sent and logged once, with the same issues and no value", async () => {
      const { get, events } = await serve("warn", (r) => {
        r.get("/me", byRequest(vendor), sender);
      });
      const res = await get("/me?send=admin");
      expect(res.status).toBe(200);
      await until(() => mismatches(events).length === 1);
      const fields = mismatches(events)[0].fields as { issues: Issue[] };
      expect(fields.issues.map((i) => i.message)).toContain(
        'The response matches variant "admin", which does not apply to this request',
      );
    });
  },
);

it("RV3's negative control: the same leak on V3a's per-part union is answered 200", async () => {
  const { get } = await serve("error", (r) => {
    r.get(
      "/me",
      validate(
        { headers: AdminHeader },
        {
          responses: {
            200: {
              headers: z.object({ "x-admin": z.literal("1").optional() }),
              content: {
                "application/json": z.union([ZAdminView, ZUserView]),
              },
            },
          },
        },
      ),
      sender,
    );
  });
  const res = await get("/me?send=admin");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(adminBody);
});

it("RV5: no variant applies to the request: refused, with no fallback", async () => {
  const { get } = await serve("error", (r) => {
    r.get(
      "/me",
      validate(
        { headers: AdminHeader },
        {
          responses: {
            200: variants({
              admin: {
                when: (valid) => valid.headers["x-admin"] === "1",
                content: { "application/json": ZAdminView },
              },
              member: {
                when: () => false,
                content: { "application/json": ZUserView },
              },
            }),
          },
        },
      ),
      sender,
    );
  });
  const issues = await issuesOf(await get("/me"));
  expect(issues[0].message).toBe(
    "No variant of this status applies to this request (2 excluded by when)",
  );
});

// ---------------------------------------------------------------------------
// RV6–RV7: the discriminant
// ---------------------------------------------------------------------------

describe("a header discriminant with values (RV6a–d): string and null", () => {
  /** x-admin "1" selects admin, its absence user. */
  const byHeader = () =>
    validate(
      { headers: AdminHeader },
      {
        responses: {
          200: variants(
            {
              admin: {
                when: (valid) => valid.headers["x-admin"] === "1",
                content: { "application/json": ZAdminView },
              },
              user: { content: { "application/json": ZUserView } },
            },
            { by: { header: "X-Admin", values: { admin: "1", user: null } } },
          ),
        },
      },
    );

  it('RV6a: "1" selects admin for an admin request', async () => {
    const { get } = await serve("error", (r) =>
      r.get("/m", byHeader(), sender),
    );
    expect((await get("/m?send=admin", ADMIN)).status).toBe(200);
  });

  it("RV6b: absence selects user", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/m", byHeader(), sender),
    );
    expect((await get("/m")).status).toBe(200);
  });

  it('RV6c: "1" with a user body: only admin is checked', async () => {
    const { get } = await serve("error", (r) =>
      r.get("/m", byHeader(), sender),
    );
    const issues = await issuesOf(await get("/m?send=mixed", ADMIN));
    expect(issues.some((i) => i.variant === "admin")).toBe(true);
    expect(issues.some((i) => i.variant === "user")).toBe(false);
  });

  it("RV6d: the discriminant selects admin for a non-admin request: refused before any body check", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/m", byHeader(), sender),
    );
    const issues = await issuesOf(await get("/m?send=admin"));
    expect(issues).toEqual([
      {
        target: "status",
        message:
          'Variant "admin" (selected by header x-admin) does not apply to this request',
        path: "",
        key: "200",
        variant: "admin",
      },
    ]);
  });
});

describe("a header discriminant with default values (RV6e–g)", () => {
  const byMode = () =>
    validate(
      {},
      {
        responses: {
          200: variants(
            {
              full: {
                content: {
                  "application/json": z.object({ items: z.array(z.string()) }),
                },
              },
              summary: {
                content: {
                  "application/json": z.object({ count: z.number() }),
                },
              },
            },
            { by: { header: "x-mode" } },
          ),
        },
      },
    );
  const send =
    (mode: string | undefined) =>
    (_req: unknown, res: unknown): void => {
      const r = untyped(res).status(200);
      if (mode !== undefined) r.set("x-mode", mode);
      r.json({ count: 2 });
    };

  it("RV6e: x-mode: summary and a summary body: sent", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/d", byMode(), send("summary")),
    );
    expect((await get("/d")).status).toBe(200);
  });

  it("RV6f: an unknown value: refused, the issue lists the declared values, never the received one", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/d", byMode(), send(WEIRD)),
    );
    expect(await issuesOf(await get("/d"))).toEqual([
      {
        target: "headers",
        message: "Does not select a variant (expected full, summary)",
        path: "x-mode",
        key: "200",
      },
    ]);
  });

  it("RV6g: x-mode missing: refused on headers.x-mode", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/d", byMode(), send(undefined)),
    );
    const [only] = await issuesOf(await get("/d"));
    expect(only.path).toBe("x-mode");
  });
});

describe("a cookie discriminant: true and null (RV7)", () => {
  const byCookie = () =>
    validate(
      {},
      {
        responses: {
          200: variants(
            {
              fresh: { content: { "application/json": ZUserView } },
              anon: {
                content: {
                  "application/json": z.object({ guest: z.literal(true) }),
                },
              },
            },
            { by: { cookie: "sid", values: { fresh: true, anon: null } } },
          ),
        },
      },
    );

  it("RV7a: a Set-Cookie sid (any value) selects fresh", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/c", byCookie(), (_req, res) => {
        untyped(res).cookie("sid", SECRET, { httpOnly: true });
        untyped(res).status(200).json(userBody);
      }),
    );
    expect((await get("/c")).status).toBe(200);
  });

  it("RV7b: no sid selects anon; a fresh body under it is refused", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/c", byCookie(), (_req, res) =>
        untyped(res).status(200).json(userBody),
      ),
    );
    const issues = await issuesOf(await get("/c"));
    expect(
      issues.every((i) => i.variant === "anon" || i.variant === undefined),
    ).toBe(true);
    expect(issues.some((i) => i.variant === "anon")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RV8: res.variant() selects
// ---------------------------------------------------------------------------

describe("res.variant() selects (RV8)", () => {
  it("RV8a: named for a request its when refuses: refused, nothing adjusted", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/me", byRequest("zod"), (_req, res) =>
        named(res, "admin").status(200).set("x-admin", "1").json(adminBody),
      ),
    );
    const issues = await issuesOf(await get("/me"));
    expect(issues[0].message).toBe(
      'Variant "admin" (named by variant()) does not apply to this request',
    );
  });

  it("RV8b: named user, the admin body sent: only user is checked", async () => {
    const { get } = await serve("error", (r) =>
      r.get(
        "/me",
        validate(
          { headers: AdminHeader },
          {
            responses: {
              200: variants({
                admin: {
                  when: () => true,
                  content: { "application/json": ZAdminView },
                },
                user: {
                  content: {
                    "application/json": z.strictObject({
                      id: z.string(),
                      role: z.literal("user"),
                    }),
                  },
                },
              }),
            },
            // Off for the strip: this checks selection, not the adjust.
          },
        ),
        (_req, res) => {
          untyped(res).status(200);
          // An unconstrained body under the user variant, sent with an
          // explicit type so nothing is adjusted that would hide it.
          named(res, "user")
            .type("application/json")
            .send(JSON.stringify(adminBody));
        },
      ),
    );
    const issues = await issuesOf(await get("/me", ADMIN));
    expect(issues.some((i) => i.variant === "user")).toBe(true);
    expect(issues.some((i) => i.variant === "admin")).toBe(false);
  });

  it("RV8c: named on a status with no variants: refused", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/me", byRequest("zod"), (_req, res) =>
        named(res, "admin").status(404).json({ code: "x" }),
      ),
    );
    expect((await issuesOf(await get("/me", ADMIN)))[0].message).toBe(
      'variant("admin") was named, but this status declares no variants',
    );
  });

  it("a name the status does not declare: refused, the declared names listed", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/me", byRequest("zod"), (_req, res) =>
        named(res, "root").status(200).json(userBody),
      ),
    );
    expect((await issuesOf(await get("/me")))[0].message).toBe(
      'variant("root") is not declared (admin, user)',
    );
  });
});

// ---------------------------------------------------------------------------
// RV9: refine
// ---------------------------------------------------------------------------

describe("refine (RV9): a whole-response check, scrubbed against every part", () => {
  const counted = (refine: Refine) =>
    validate(
      {},
      {
        responses: {
          200: variants(
            {
              list: {
                headers: z.object({ "x-total": z.string() }),
                content: {
                  "application/json": z.object({ items: z.array(z.string()) }),
                },
              },
            },
            { refine },
          ),
        },
      },
    );
  const totalMatches: Refine = (res) => {
    const body = res.body as { items: string[] };
    return Number(res.headers["x-total"]) === body.items.length
      ? undefined
      : [
          {
            part: "headers",
            path: "x-total",
            message: `x-total does not equal the item count (${body.items[0]})`,
          },
        ];
  };
  const list =
    (total: string, items: string[]) =>
    (_req: unknown, res: unknown): void => {
      untyped(res).status(200).set("x-total", total).json({ items });
    };

  it("RV9a: passes when x-total equals the count", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/l", counted(totalMatches), list("2", ["a", "b"])),
    );
    expect((await get("/l")).status).toBe(200);
  });

  it("RV9b: fails, and the message quoting a body value is withheld", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/l", counted(totalMatches), list("5", [QUOTED, "b"])),
    );
    expect(await issuesOf(await get("/l"))).toContainEqual({
      target: "headers",
      message: "Invalid value",
      path: "x-total",
      key: "200",
      variant: "list",
    });
  });

  it("a refine sees every part, the matched variant and the request", async () => {
    const seenBy: unknown[] = [];
    const { get } = await serve("error", (r) =>
      r.get(
        "/l",
        counted((res, req) => {
          seenBy.push({ ...res, method: req.method });
          return undefined;
        }),
        list("1", ["a"]),
      ),
    );
    expect((await get("/l")).status).toBe(200);
    expect(seenBy).toEqual([
      expect.objectContaining({
        status: 200,
        mediaType: "application/json",
        body: { items: ["a"] },
        variant: "list",
        method: "GET",
        headers: expect.objectContaining({ "x-total": "1" }),
        cookies: {},
      }),
    ]);
  });

  it("a variant's refine runs before the status's, and only once the parts pass", async () => {
    const order: string[] = [];
    const { get } = await serve("error", (r) =>
      r.get(
        "/l",
        validate(
          {},
          {
            responses: {
              200: variants(
                {
                  list: {
                    content: {
                      "application/json": z.object({
                        items: z.array(z.string()),
                      }),
                    },
                    refine: () => {
                      order.push("variant");
                      return undefined;
                    },
                  },
                },
                {
                  refine: () => {
                    order.push("status");
                    return undefined;
                  },
                },
              ),
            },
          },
        ),
        (req, res) =>
          untyped(res)
            .status(200)
            .json(req.query.bad === "1" ? { items: 1 } : { items: [] }),
      ),
    );
    expect((await get("/l")).status).toBe(200);
    expect(order).toEqual(["variant", "status"]);
    order.length = 0;
    expect((await get("/l?bad=1")).status).toBe(500);
    expect(order).toEqual([]);
  });

  it("a plain status takes refine too, with no variant field on its issues", async () => {
    const { get } = await serve("error", (r) =>
      r.get(
        "/p",
        validate(
          {},
          {
            responses: {
              200: {
                content: { "application/json": z.object({ n: z.number() }) },
                refine: ((res) =>
                  (res.body as { n: number }).n > 2
                    ? [{ part: "body", path: "n", message: "too big" }]
                    : undefined) satisfies Refine,
              },
            },
          },
        ),
        (req, res) =>
          untyped(res)
            .status(200)
            .json({ n: Number(req.query.n) }),
      ),
    );
    expect((await get("/p?n=1")).status).toBe(200);
    expect(await issuesOf(await get("/p?n=7"))).toEqual([
      { target: "body", message: "too big", path: "n", key: "200" },
    ]);
  });

  it("a refine that throws is a failed check: could not be checked, the error logged", async () => {
    const { get, events } = await serve("error", (r) =>
      r.get(
        "/l",
        counted(() => {
          throw new Error("refine broke");
        }),
        list("1", ["a"]),
      ),
    );
    expect(await issuesOf(await get("/l"))).toEqual([
      {
        target: "status",
        message: "The response could not be checked",
        path: "",
        key: "200",
      },
    ]);
    const failed = seen(events).filter((e) => e.level === "error");
    expect(failed[0]?.message).toBe("response contract check failed");
  });
});

// ---------------------------------------------------------------------------
// RV10: when, sync and async
// ---------------------------------------------------------------------------

describe("when (RV10): a failed check, and the sync fast path", () => {
  const withWhen = (when: () => unknown) =>
    validate(
      {},
      {
        responses: {
          200: variants({
            admin: {
              when: when as () => boolean,
              content: { "application/json": ZAdminView },
            },
            user: { content: { "application/json": ZUserView } },
          }),
        },
      },
    );

  it("RV10a: a when that throws: refused as could not be checked; the error logged, not in the issue", async () => {
    const { get, events } = await serve("error", (r) =>
      r.get(
        "/w",
        withWhen(() => {
          throw new Error("when broke");
        }),
        sender,
      ),
    );
    expect(await issuesOf(await get("/w"))).toEqual([
      {
        target: "status",
        message: "The response could not be checked",
        path: "",
        key: "200",
      },
    ]);
    const failed = seen(events).find((e) => e.level === "error");
    expect(failed?.error?.message ?? String(failed?.fields?.error)).toContain(
      "when broke",
    );
  });

  it("under warn, a when that throws: sent, the error logged", async () => {
    const { get, events } = await serve("warn", (r) =>
      r.get(
        "/w",
        withWhen(() => {
          throw new Error("when broke");
        }),
        sender,
      ),
    );
    expect((await get("/w")).status).toBe(200);
    expect(seen(events).some((e) => e.level === "error")).toBe(true);
  });

  it("RV10b: an async when resolving true is awaited, and the admin body sent", async () => {
    const { get } = await serve("error", (r) =>
      r.get(
        "/w",
        withWhen(async () => true),
        sender,
      ),
    );
    const res = await get("/w?send=admin-bare");
    expect(res.status).toBe(200);
  });

  it("RV10b: under error, an async when holds the commit: the leak is refused", async () => {
    const { get } = await serve("error", (r) =>
      r.get(
        "/w",
        withWhen(async () => false),
        sender,
      ),
    );
    const issues = await issuesOf(await get("/w?send=admin-bare"));
    expect(issues.map((i) => i.message)).toContain(
      'The response matches variant "admin", which does not apply to this request',
    );
  });

  it("RV10c: a sync when leaves dispatch() synchronous; an async one makes it a Promise", async () => {
    const run = async (when: () => unknown) => {
      const router = new BunRouter({ responseValidation: "error" });
      router.get("/w", withWhen(when), (_req, res) =>
        untyped(res).status(200).json(userBody),
      );
      const request = await makeRequest({ url: "http://localhost/w" });
      const response = new BunResponse(request);
      const result = router.dispatch({
        requestHost: "localhost",
        requestMethod: "GET",
        requestUrl: "/w",
        request,
        response,
      });
      await result;
      return { result, text: await response.settledResponse?.text() };
    };
    const sync = await run(() => false);
    expect(sync.result).not.toBeInstanceOf(Promise);
    expect(sync.text).toBe(JSON.stringify(userBody));
    const pending = await run(async () => false);
    expect(pending.result).toBeInstanceOf(Promise);
    expect(pending.text).toBe(JSON.stringify(userBody));
  });

  it("RV10d: a when answering a non-boolean (sync or async): a failed check", async () => {
    for (const when of [() => "yes", async () => "yes", () => 1]) {
      const { get } = await serve("error", (r) =>
        r.get("/w", withWhen(when), sender),
      );
      const [only] = await issuesOf(await get("/w"));
      expect(only.message).toBe("The response could not be checked");
    }
  });

  it("RV10e: an async when that rejects: a failed check, the error logged", async () => {
    const { get, events } = await serve("error", (r) =>
      r.get(
        "/w",
        withWhen(async () => {
          throw new Error("rejected");
        }),
        sender,
      ),
    );
    const [only] = await issuesOf(await get("/w"));
    expect(only.message).toBe("The response could not be checked");
    expect(seen(events).some((e) => e.level === "error")).toBe(true);
  });

  it("when gets req.valid and the request", async () => {
    const calls: unknown[] = [];
    const { get } = await serve("error", (r) =>
      r.get(
        "/w",
        validate(
          { headers: AdminHeader, query: z.object({ q: z.coerce.number() }) },
          {
            responses: {
              200: variants({
                any: {
                  when: (valid, req) => {
                    calls.push({ valid, method: req.method });
                    return true;
                  },
                  content: { "application/json": ZUserView },
                },
              }),
            },
          },
        ),
        sender,
      ),
    );
    expect((await get("/w?q=4", ADMIN)).status).toBe(200);
    expect(calls).toEqual([
      {
        valid: { headers: { "x-admin": "1" }, query: { q: 4 } },
        method: "GET",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// RV11, RV12: no validator; when calls
// ---------------------------------------------------------------------------

describe("no validator's parts, and commonResponses (RV11)", () => {
  it("RV11: a when reading a part no validator parsed sees undefined, and the default variant applies", async () => {
    const { get } = await serve("error", (r) =>
      r.get(
        "/x",
        validate(
          {},
          {
            responses: {
              200: variants({
                admin: {
                  when: (valid) =>
                    (valid as { headers?: Record<string, string> }).headers?.[
                      "x-admin"
                    ] === "1",
                  content: { "application/json": ZAdminView },
                },
                user: { content: { "application/json": ZUserView } },
              }),
            },
          },
        ),
        sender,
      ),
    );
    expect((await get("/x", ADMIN)).status).toBe(200);
  });

  it("commonResponses declares variants, with UntypedValid's when", async () => {
    const { logger } = createTestLogger();
    const router = new BunRouter({
      logger,
      responseValidation: "error",
      commonResponses: {
        503: variants({
          busy: {
            when: (valid) => valid.query !== undefined,
            content: { "application/json": z.object({ retry: z.number() }) },
          },
        }),
      },
    });
    router.get(
      "/b",
      validate(
        { query: z.object({ down: z.string().optional() }) },
        { responses: { 200: ZUserView } },
      ),
      (req, res) =>
        req.query.down === undefined
          ? untyped(res).status(200).json(userBody)
          : untyped(res).status(503).json({ retry: 1 }),
    );
    router.use(renderRefusal);
    expect((await router.fetch("/b?down=1")).status).toBe(503);
  });
});

it("RV12: one when call per variant that has one; none for a status with no variants", async () => {
  let calls = 0;
  const eight = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [
      `v${i}`,
      {
        when: () => {
          calls++;
          return i === 7;
        },
        content: { "application/json": ZUserView },
      },
    ]),
  );
  const { get } = await serve("error", (r) =>
    r.get(
      "/e",
      validate(
        {},
        {
          responses: {
            200: variants(eight),
            201: ZUserView,
          },
        },
      ),
      (req, res) =>
        untyped(res)
          .status(req.query.plain === "1" ? 201 : 200)
          .json(userBody),
    ),
  );
  expect((await get("/e")).status).toBe(200);
  expect(calls).toBe(8);
  calls = 0;
  expect((await get("/e?plain=1")).status).toBe(201);
  expect(calls).toBe(0);
});

// ---------------------------------------------------------------------------
// RV14, RV15: declaration mistakes; a plain status
// ---------------------------------------------------------------------------

describe("declaration mistakes are TypeErrors (RV14)", () => {
  const declare = (responses: unknown) => () =>
    validate({}, { responses: responses as Record<number, never> });

  it.each([
    [
      "when on a plain status",
      { 200: { when: () => true, content: { "application/json": ZUserView } } },
      'validate(): responses[200]: "when" belongs to a variant; declare the status with variants({ name: { when, … } })',
    ],
    [
      "two variants on one value",
      {
        200: variants(
          { a: { content: null }, b: { content: null } },
          { by: { header: "x-m", values: { a: "1", b: "1" } } },
        ),
      },
      "validate(): responses[200].by: variants a and b are selected by the same value",
    ],
    [
      "values naming no variant",
      {
        200: variants(
          { a: { content: null } },
          { by: { header: "x-m", values: { zz: "1" } as never } },
        ),
      },
      'validate(): responses[200].by.values: "zz" is not a variant (a)',
    ],
    [
      "an empty variants({})",
      { 200: variants({}) },
      "validate(): responses[200]: variants() declares no variant",
    ],
    [
      "both header and cookie",
      {
        200: variants({ a: { content: null } }, {
          by: { header: "x", cookie: "y" },
        } as never),
      },
      "validate(): responses[200].by: name exactly one of header, cookie",
    ],
    [
      "a when that is not a function",
      { 200: variants({ a: { when: true as never, content: null } }) },
      "validate(): responses[200].a.when: expected a function",
    ],
    [
      "an unknown key in a variant",
      { 200: variants({ a: { whenever: 1 } as never }) },
      'validate(): responses[200].a: "whenever" is not a response part',
    ],
    [
      "a refine that is not a function",
      { 200: { refine: 1, content: null } },
      "validate(): responses[200].refine: expected a function",
    ],
  ])("%s", (_name, responses, message) => {
    expect(declare(responses)).toThrow(TypeError);
    expect(declare(responses)).toThrow(message);
  });

  it("two variants of one status selected by the same `true` or `null`", () => {
    expect(
      declare({
        200: variants(
          { a: { content: null }, b: { content: null } },
          { by: { cookie: "s", values: { a: null, b: null } } },
        ),
      }),
    ).toThrow("selected by the same value");
  });
});

it("RV15: a plain status keeps V3a's issue shape, with no variant field", async () => {
  const { get } = await serve("error", (r) =>
    r.get("/p", validate({}, { responses: { 200: ZUserView } }), (_req, res) =>
      untyped(res).status(200).json({ id: 1 }),
    ),
  );
  const issues = await issuesOf(await get("/p"));
  expect(issues.length).toBeGreaterThan(0);
  expect(issues.every((i) => !("variant" in i))).toBe(true);
});

// ---------------------------------------------------------------------------
// RV17: the leak limit
// ---------------------------------------------------------------------------

describe("the leak limit (RV17) and its fixes", () => {
  const table = (strict: boolean) =>
    validate(
      { headers: AdminHeader },
      {
        responses: {
          200: variants({
            admin: {
              when: (valid) => valid.headers["x-admin"] === "1",
              content: {
                "application/json": z.object({
                  id: z.string(),
                  salary: z.number(),
                }),
              },
            },
            user: {
              content: {
                "application/json": strict
                  ? z.strictObject({ id: z.string() })
                  : z.object({ id: z.string() }),
              },
            },
          }),
        },
      },
    );
  const leak = (_req: unknown, res: unknown): void => {
    untyped(res).status(200).json({ id: "a", salary: 77 });
  };

  it("RV17a: a loose subset accepts the admin body for a non-admin: SENT (a check never strips)", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/l", table(false), leak),
    );
    const res = await get("/l");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "a", salary: 77 });
  });

  it("RV17b: the same with z.strictObject: refused, the admin variant named", async () => {
    const { get } = await serve("error", (r) => r.get("/l", table(true), leak));
    expect((await issuesOf(await get("/l"))).map((i) => i.message)).toContain(
      'The response matches variant "admin", which does not apply to this request',
    );
  });

  it('RV25: .variant("user") on the loose table strips salary: sent as user', async () => {
    const { get, events } = await serve("error", (r) =>
      r.get("/l", table(false), (_req, res) =>
        named(res, "user").status(200).json({ id: "a", salary: 77 }),
      ),
    );
    const res = await get("/l");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "a" });
    const adjusted = seen(events).find(
      (e) => e.message === "response adjusted by res.variant()",
    );
    expect(adjusted?.level).toBe("debug");
    expect(adjusted?.fields?.changes).toEqual([
      "body: stripped 1 undeclared field",
    ]);
  });
});

// ---------------------------------------------------------------------------
// RV18–RV28: what .variant() adjusts
// ---------------------------------------------------------------------------

const AdminK = z.object({
  kind: z.literal("admin"),
  id: z.string(),
  salary: z.number(),
  meta: z.object({ v: z.literal(2), at: z.string() }),
  items: z.array(z.object({ k: z.literal("a"), y: z.string() })),
});

/** RV18's table: a discriminant, a literal header, a vendor media type, literal body fields at depth. */
const adjustTable = () =>
  validate(
    { headers: AdminHeader },
    {
      responses: {
        200: variants(
          {
            admin: {
              when: (valid) => valid.headers["x-admin"] === "1",
              headers: z.object({
                "x-tier": z.literal("gold"),
                "x-request-id": z.string(),
              }),
              content: { "application/vnd.admin+json": AdminK },
            },
            user: {
              content: {
                "application/json": z.object({
                  kind: z.literal("user"),
                  id: z.string(),
                }),
              },
            },
          },
          {
            by: {
              header: "x-view",
              values: { admin: "admin-view", user: "user-view" },
            },
          },
        ),
        201: variants({
          created: {
            headers: z.object({ location: z.string() }),
            content: {
              "application/json": z.object({
                kind: z.literal("created"),
                id: z.string(),
              }),
            },
          },
        }),
      },
    },
  );

/** A handler's draft: only what varies, three undeclared fields at three depths. */
const draft = () => ({
  id: "a",
  salary: 9,
  meta: { at: "t", secret: SECRET },
  items: [{ y: "1" }, { y: "2", note: SECRET }],
  internal: SECRET,
});

describe(".variant() adjusts the response (RV18–RV24)", () => {
  it("RV18: fills the discriminant, a literal header, Content-Type and literal body fields; strips 3 undeclared fields; sent", async () => {
    const { get, events } = await serve("error", (r) =>
      r.get("/a", adjustTable(), (_req, res) =>
        named(res, "admin").set("x-request-id", "r1").json(draft()),
      ),
    );
    const res = await get("/a", ADMIN);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-view")).toBe("admin-view");
    expect(res.headers.get("x-tier")).toBe("gold");
    expect(res.headers.get("content-type")).toBe("application/vnd.admin+json");
    expect(await res.json()).toEqual({
      id: "a",
      salary: 9,
      meta: { at: "t", v: 2 },
      items: [
        { y: "1", k: "a" },
        { y: "2", k: "a" },
      ],
      kind: "admin",
    });
    const adjusted = seen(events).find(
      (e) => e.message === "response adjusted by res.variant()",
    );
    expect(adjusted?.level).toBe("debug");
    // Paths and counts: never a removed key's name, never a value.
    expect(adjusted?.fields?.changes).toEqual([
      "headers.x-view: filled",
      "headers.x-tier: filled",
      "headers.content-type: filled",
      "body: stripped 1 undeclared field",
      "body.kind: filled",
      "body.meta: stripped 1 undeclared field",
      "body.meta.v: filled",
      "body.items[].k: filled",
      "body.items[]: stripped 1 undeclared field",
      "body.items[].k: filled",
    ]);
    const text = JSON.stringify(adjusted);
    for (const name of ["internal", "secret", "note"]) {
      expect(text.includes(name)).toBe(false);
    }
  });

  it("RV19: the handler's own object is never mutated (copy-on-write)", async () => {
    const body = draft();
    const before = JSON.stringify(body);
    const { get } = await serve("error", (r) =>
      r.get("/a", adjustTable(), (_req, res) =>
        named(res, "admin").set("x-request-id", "r1").json(body),
      ),
    );
    expect((await get("/a", ADMIN)).status).toBe(200);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("RV20: with status() never called, the one status declaring the variant (201) is filled", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/a", adjustTable(), (_req, res) =>
        named(res, "created").set("location", "/a").json({ id: "a" }),
      ),
    );
    const res = await get("/a");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "a", kind: "created" });
  });

  it("RV20: a status the handler set is never changed", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/a", adjustTable(), (_req, res) =>
        named(res, "created")
          .status(200)
          .set("location", "/a")
          .json({ id: "a" }),
      ),
    );
    expect((await issuesOf(await get("/a")))[0].message).toBe(
      'variant("created") is not declared (admin, user)',
    );
  });

  it("RV21: a required field with no single value missing is left to the check: refused on body.salary", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/a", adjustTable(), (_req, res) =>
        named(res, "admin")
          .set("x-request-id", "r1")
          .json({ id: "a", meta: { at: "t" }, items: [] }),
      ),
    );
    const issues = await issuesOf(await get("/a", ADMIN));
    expect(
      issues.some(
        (i) =>
          i.target === "body" && i.path === "salary" && i.variant === "admin",
      ),
    ).toBe(true);
  });

  it("RV22: a literal the handler set wrongly is never overwritten: refused on headers.x-tier", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/a", adjustTable(), (_req, res) =>
        named(res, "admin")
          .set("x-request-id", "r1")
          .set("x-tier", "silver")
          .json(draft()),
      ),
    );
    const issues = await issuesOf(await get("/a", ADMIN));
    expect(
      issues.some((i) => i.target === "headers" && i.path === "x-tier"),
    ).toBe(true);
  });

  it("RV23: named for a request its when refuses: decided first, nothing adjusted (warn sends it as the handler made it)", async () => {
    const { get } = await serve("warn", (r) =>
      r.get("/a", adjustTable(), (_req, res) =>
        named(res, "admin")
          .set("x-request-id", "r1")
          .json({ id: "a", internal: 1 }),
      ),
    );
    const res = await get("/a");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-view")).toBeNull();
    expect(res.headers.get("content-type")).toBe(
      "application/json;charset=utf-8",
    );
    expect(await res.json()).toEqual({ id: "a", internal: 1 });
  });

  it("RV24: a discriminant the handler set to another variant's value is kept, and refused as a disagreement", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/a", adjustTable(), (_req, res) =>
        named(res, "admin")
          .set("x-request-id", "r1")
          .set("x-view", "user-view")
          .json(draft()),
      ),
    );
    expect(await issuesOf(await get("/a", ADMIN))).toEqual([
      {
        target: "headers",
        message: 'Selects variant "user", but variant("admin") was named',
        path: "x-view",
        key: "200",
        variant: "admin",
      },
    ]);
  });

  it("Content-Type the handler set is never replaced: the vendor type is not filled, and the media type refused", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/a", adjustTable(), (_req, res) =>
        named(res, "admin")
          .set("x-request-id", "r1")
          .type("application/json")
          .json(draft()),
      ),
    );
    const issues = await issuesOf(await get("/a", ADMIN));
    expect(
      issues.some((i) =>
        i.message.startsWith("This media type is not declared"),
      ),
    ).toBe(true);
  });

  it("send(object) is adjusted as json() is", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/a", adjustTable(), (_req, res) =>
        named(res, "user").send({ id: "a", extra: SECRET } as never),
      ),
    );
    const res = await get("/a");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-view")).toBe("user-view");
    expect(await res.json()).toEqual({ id: "a", kind: "user" });
  });

  it("a body that is not a JSON value (text) is never adjusted; its headers still are", async () => {
    const { get } = await serve("error", (r) =>
      r.get(
        "/t",
        validate(
          {},
          {
            responses: {
              200: variants(
                {
                  plain: {
                    headers: z.object({ "x-kind": z.literal("plain") }),
                    content: { "text/plain": z.string() },
                  },
                },
                { by: { header: "x-view" } },
              ),
            },
          },
        ),
        (_req, res) => named(res, "plain").status(200).send("hello"),
      ),
    );
    const res = await get("/t");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kind")).toBe("plain");
    expect(res.headers.get("x-view")).toBe("plain");
    expect(await res.text()).toBe("hello");
  });

  it("a .variant() with nothing to change sends the response untouched and logs no adjust", async () => {
    const { get, events } = await serve("error", (r) =>
      r.get("/me", byRequest("zod"), (_req, res) =>
        named(res, "user").status(200).json(userBody),
      ),
    );
    const res = await get("/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(userBody);
    expect(seen(events).some((e) => e.message.includes("adjusted"))).toBe(
      false,
    );
  });
});

describe(".variant()'s limits (RV26–RV28)", () => {
  it("RV26: valibot (no ~standard.jsonSchema): not adjustable, said once at declaration; kind left to the check", async () => {
    const Kinded = v.object({ kind: v.literal("admin"), id: v.string() });
    const make = () =>
      validate(
        {},
        {
          responses: {
            200: variants({
              admin: { content: { "application/json": Kinded } },
            }),
          },
        },
      );
    const shared = make();
    const { get, events } = await serve("error", (r) => {
      r.get("/v", shared, (_req, res) =>
        named(res, "admin").status(200).json({ id: "a", extra: 1 }),
      );
      r.get("/w", shared, (_req, res) =>
        named(res, "admin").status(200).json({ id: "a" }),
      );
    });
    const issues = await issuesOf(await get("/v"));
    expect(issues.some((i) => i.path === "kind")).toBe(true);
    const warned = seen(events).filter((e) =>
      e.message.startsWith("res.variant() cannot adjust this variant"),
    );
    expect(warned).toHaveLength(1);
    expect(warned[0].fields).toMatchObject({
      status: 200,
      variant: "admin",
      parts: ["body application/json"],
    });
  });

  it("RV27: a union member's extra key and a record's keys stay; the top level is stripped", async () => {
    const { get } = await serve("error", (r) =>
      r.get(
        "/u",
        validate(
          {},
          {
            responses: {
              200: variants({
                shape: {
                  content: {
                    "application/json": z.object({
                      id: z.string(),
                      u: z.union([
                        z.object({ a: z.literal(1) }),
                        z.object({ b: z.literal(2) }),
                      ]),
                      rec: z.record(z.string(), z.number()),
                    }),
                  },
                },
              }),
            },
          },
        ),
        (_req, res) =>
          named(res, "shape")
            .status(200)
            .json({ id: "a", u: { a: 1, x: 9 }, rec: { k: 1 }, top: 1 }),
      ),
    );
    const res = await get("/u");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "a",
      u: { a: 1, x: 9 },
      rec: { k: 1 },
    });
  });

  it("deeper than 16 levels, a node is neither filled nor stripped", async () => {
    let schema: z.ZodType = z.object({ k: z.literal("leaf") });
    for (let i = 0; i < 20; i++) schema = z.object({ n: schema });
    let body: Record<string, unknown> = { extra: 1 };
    for (let i = 0; i < 20; i++) body = { n: body };
    const { get } = await serve("warn", (r) =>
      r.get(
        "/deep",
        validate(
          {},
          {
            responses: {
              200: variants({ d: { content: { "application/json": schema } } }),
            },
          },
        ),
        (_req, res) => named(res, "d").status(200).json(body),
      ),
    );
    const res = await get("/deep");
    let deep = (await res.json()) as Record<string, unknown>;
    for (let i = 0; i < 20; i++) deep = deep.n as Record<string, unknown>;
    expect(deep).toEqual({ extra: 1 });
  });

  const cookieTable = () =>
    validate(
      {},
      {
        responses: {
          200: variants({
            full: {
              cookies: z.object({
                mode: z.object({
                  value: z.literal("full"),
                  httpOnly: z.literal(true),
                }),
                sid: z.object({ value: z.string(), httpOnly: z.literal(true) }),
              }),
              content: { "application/json": z.object({ id: z.string() }) },
            },
          }),
        },
      },
    );

  it("RV28: a cookie whose value and required attributes each admit one value is filled; one with any value is not, the handler's kept", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/c", cookieTable(), (_req, res) => {
        untyped(res).cookie("sid", "x", { httpOnly: true });
        named(res, "full").status(200).json({ id: "a" });
      }),
    );
    const res = await get("/c");
    expect(res.status).toBe(200);
    const lines = res.headers.getSetCookie();
    expect(lines.some((l) => l.startsWith("sid=x"))).toBe(true);
    const mode = lines.find((l) => l.startsWith("mode="));
    expect(mode).toContain("mode=full");
    expect(mode).toContain("Path=/");
    expect(mode).toContain("HttpOnly");
  });

  it("RV28b: with no sid at all, mode is filled but sid cannot be: refused on cookies.sid", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/c", cookieTable(), (_req, res) =>
        named(res, "full").status(200).json({ id: "a" }),
      ),
    );
    const issues = await issuesOf(await get("/c"));
    expect(issues.some((i) => i.target === "cookies" && i.path === "sid")).toBe(
      true,
    );
  });

  it("a cookie discriminant's exact value is filled", async () => {
    const { get } = await serve("error", (r) =>
      r.get(
        "/c",
        validate(
          {},
          {
            responses: {
              200: variants(
                {
                  a: { content: { "application/json": ZUserView } },
                  b: { content: { "application/json": ZUserView } },
                },
                { by: { cookie: "view", values: { a: "a-view", b: true } } },
              ),
            },
          },
        ),
        (_req, res) => named(res, "a").status(200).json(userBody),
      ),
    );
    const res = await get("/c");
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([
      "view=a-view; Path=/; SameSite=Lax",
    ]);
  });

  it("a discriminant's true or null is never filled: one value is not declared", async () => {
    const { get } = await serve("error", (r) =>
      r.get(
        "/c",
        validate(
          {},
          {
            responses: {
              200: variants(
                {
                  a: { content: { "application/json": ZUserView } },
                  b: { content: { "application/json": ZUserView } },
                },
                { by: { header: "x-v", values: { a: true, b: null } } },
              ),
            },
          },
        ),
        (_req, res) => named(res, "a").status(200).json(userBody),
      ),
    );
    // Nothing set the header, so absence selects b, against the name.
    expect((await issuesOf(await get("/c")))[0].message).toBe(
      'Selects variant "b", but variant("a") was named',
    );
  });
});

describe(".variant() on the wire, after the commit, and under off", () => {
  it("the re-serialised body reaches a socket whole, with its own Content-Length", async () => {
    const { get } = await serve(
      "error",
      (r) =>
        r.get("/a", adjustTable(), (_req, res) =>
          named(res, "admin").set("x-request-id", "r1").json(draft()),
        ),
      "socket",
    );
    const res = await get("/a", ADMIN);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(text).byteLength),
    );
    expect(text.includes(SECRET)).toBe(false);
    expect(JSON.parse(text)).toMatchObject({ kind: "admin" });
  });

  it("after the commit, .variant() is ignored with one warning per route", async () => {
    const { get, events } = await serve("error", (r) =>
      r.get("/late", byRequest("zod"), (_req, res) => {
        untyped(res).status(200).json(userBody);
        named(res, "admin");
      }),
    );
    expect((await get("/late")).status).toBe(200);
    expect((await get("/late")).status).toBe(200);
    expect(
      seen(events).filter((e) =>
        e.message.startsWith(
          "res.variant() was called after the response was committed",
        ),
      ),
    ).toHaveLength(1);
  });

  it('under "off": adjusted (no when, no check); the response is otherwise sent as made', async () => {
    const { get, events } = await serve("off", (r) =>
      r.get("/a", adjustTable(), (_req, res) =>
        named(res, "admin")
          .set("x-request-id", "r1")
          .json({ ...draft(), salary: "not a number" }),
      ),
    );
    // No x-admin: the admin variant's when would refuse; under off it is not consulted.
    const res = await get("/a");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-view")).toBe("admin-view");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.internal).toBeUndefined();
    expect(body.kind).toBe("admin");
    expect(body.salary).toBe("not a number");
    expect(mismatches(events)).toHaveLength(0);
  });

  it('a validator\'s own "off" installs the adjust-only step only when it declares variants', () => {
    const settings = {
      mode: undefined,
      common: [],
      logger: () => createTestLogger().logger,
    };
    const plain = validate(
      {},
      { responses: { 200: ZUserView }, responseValidation: "off" },
    );
    const bindPlain = (
      plain as unknown as Record<symbol, { bind: (s: unknown) => unknown }>
    )[RESPONSE_BINDING];
    expect(bindPlain.bind(settings)).toBe(plain);
    const withVariants = validate(
      {},
      {
        responses: {
          200: variants({ a: { content: { "application/json": ZUserView } } }),
        },
        responseValidation: "off",
      },
    );
    const bindVariants = (
      withVariants as unknown as Record<
        symbol,
        { bind: (s: unknown) => unknown }
      >
    )[RESPONSE_BINDING];
    expect(bindVariants.bind(settings)).not.toBe(withVariants);
  });

  it("under warn, an async when on a named variant holds the commit to adjust", async () => {
    const { get } = await serve("warn", (r) =>
      r.get(
        "/a",
        validate(
          {},
          {
            responses: {
              200: variants({
                user: {
                  when: async () => true,
                  content: { "application/json": z.object({ id: z.string() }) },
                },
              }),
            },
          },
        ),
        (_req, res) =>
          named(res, "user").status(200).json({ id: "a", salary: 77 }),
      ),
    );
    expect(await (await get("/a")).json()).toEqual({ id: "a" });
  });
});

// ---------------------------------------------------------------------------
// Streamed variants: survivors per chunk (Q-H24)
// ---------------------------------------------------------------------------

/** Everything a client read of a body, and how it ended. */
async function drain(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { status: response.status, text, end: "done" as const };
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return { status: response.status, text, end: "error" as const };
  }
}

describe("streamed variants: the survivors at the commit, then per chunk", () => {
  /** Two variants whose first chunk may be the same (`x…`), then diverge (`a…`, `b…`). */
  const streamed = (by?: { header: string }) =>
    validate(
      {},
      {
        responses: {
          200: variants(
            {
              a: {
                content: { "text/plain": chunks(z.string().regex(/^(x|a)/)) },
              },
              b: {
                content: { "text/plain": chunks(z.string().regex(/^(x|b)/)) },
              },
            },
            by === undefined ? {} : { by },
          ),
        },
      },
    );
  /** Writes `?seq=` (comma-separated) with write(), then ends. */
  const writer = async (
    req: { query: Record<string, unknown> },
    res: unknown,
  ): Promise<void> => {
    const r = untyped(res);
    r.status(200).type("text/plain");
    if (typeof req.query.v === "string") r.set("x-v", req.query.v);
    for (const part of String(req.query.seq).split(",")) {
      r.write(part);
      await Bun.sleep(2);
    }
    await r.end();
  };

  it.each(["router.fetch()", "socket"] as const)(
    "%s: x0,a1,a2: b drops at a1, a survives, the stream completes",
    async (via) => {
      const { get } = await serve(
        "error",
        (r) => r.get("/s", streamed(), writer),
        via,
      );
      const out = await drain(await get("/s?seq=x0,a1,a2"));
      expect(out).toEqual({ status: 200, text: "x0a1a2", end: "done" });
    },
  );

  it.each(["router.fetch()", "socket"] as const)(
    "%s: x0,a1,b2: none survives b2, the stream is cut off and logged",
    async (via) => {
      const { get, events } = await serve(
        "error",
        (r) => r.get("/s", streamed(), writer),
        via,
      );
      const out = await drain(await get("/s?seq=x0,a1,b2"));
      expect(out.end).toBe("error");
      expect(out.text.includes("b2")).toBe(false);
      await until(() =>
        seen(events).some((e) => e.message.includes("stream was cut off")),
      );
      const cut = events.find((e) => e.message.includes("stream was cut off"));
      const issues = (cut?.fields as { issues: Issue[] }).issues;
      expect(issues[0].message).toBe(
        "The stream matches no acceptable variant (a)",
      );
      expect(issues.slice(1).every((i) => i.variant === "a")).toBe(true);
    },
  );

  it("a first chunk only one variant takes: that one survives the commit alone", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/s", streamed(), writer),
    );
    expect(await drain(await get("/s?seq=b0,b1"))).toEqual({
      status: 200,
      text: "b0b1",
      end: "done",
    });
  });

  it("a first chunk no variant takes: a clean 500 at the commit, each variant's issues", async () => {
    const { get } = await serve("error", (r) =>
      r.get("/s", streamed(), writer),
    );
    const issues = await issuesOf(await get("/s?seq=c0,a1"));
    expect(issues[0].message).toBe(
      "The response matches no acceptable variant (a, b)",
    );
    expect(issues.some((i) => i.variant === "a")).toBe(true);
    expect(issues.some((i) => i.variant === "b")).toBe(true);
  });

  it("under warn, a stream no variant survives is sent whole and reported once", async () => {
    const { get, events } = await serve("warn", (r) =>
      r.get("/s", streamed(), writer),
    );
    expect(await drain(await get("/s?seq=x0,a1,b2,b3"))).toEqual({
      status: 200,
      text: "x0a1b2b3",
      end: "done",
    });
    await until(() =>
      seen(events).some((e) => e.message.startsWith("streamed response")),
    );
    await Bun.sleep(10);
    expect(
      events.filter((e) => e.message.startsWith("streamed response")),
    ).toHaveLength(1);
  });

  it("a piped ReadableStream is checked per chunk against the survivors, and cut off over a socket", async () => {
    const encoder = new TextEncoder();
    const { get } = await serve(
      "error",
      (r) =>
        r.get("/p", streamed(), (req, res) => {
          const parts = String(req.query.seq).split(",");
          untyped(res)
            .status(200)
            .type("text/plain")
            .send(
              new ReadableStream({
                async start(c) {
                  for (const part of parts) {
                    c.enqueue(encoder.encode(part));
                    await Bun.sleep(2);
                  }
                  c.close();
                },
              }),
            );
        }),
      "socket",
    );
    expect(await drain(await get("/p?seq=x0,b1,b2"))).toEqual({
      status: 200,
      text: "x0b1b2",
      end: "done",
    });
    const cut = await drain(await get("/p?seq=x0,a1,b2"));
    expect(cut.end).toBe("error");
    expect(cut.text.includes("b2")).toBe(false);
  });

  it("a discriminant decides at the commit: one variant's checks, its issues tagged", async () => {
    const { get, events } = await serve("error", (r) =>
      r.get("/s", streamed({ header: "x-v" }), writer),
    );
    expect(await drain(await get("/s?v=b&seq=x0,b1"))).toEqual({
      status: 200,
      text: "x0b1",
      end: "done",
    });
    const cut = await drain(await get("/s?v=b&seq=x0,a1"));
    expect(cut.end).toBe("error");
    await until(() =>
      seen(events).some((e) => e.message.includes("stream was cut off")),
    );
    const issues = (
      events.find((e) => e.message.includes("stream was cut off"))?.fields as {
        issues: Issue[];
      }
    ).issues;
    expect(issues.every((i) => i.variant === "b")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Merging: a variants status is replaced whole (Q-H22)
// ---------------------------------------------------------------------------

describe("a variants status is replaced whole across layers", () => {
  const common200 = variants({
    a: { content: { "application/json": z.object({ a: z.literal(1) }) } },
  });

  it("commonResponses' variants status, replaced by a route's plain one", async () => {
    const { logger } = createTestLogger();
    const router = new BunRouter({
      logger,
      responseValidation: "error",
      commonResponses: { 200: common200 },
    });
    router.get(
      "/r",
      validate({}, { responses: { 200: z.object({ b: z.literal(2) }) } }),
      (req, res) =>
        req.query.named === "1"
          ? named(res, "a").status(200).json({ b: 2 })
          : untyped(res).status(200).json({ b: 2 }),
    );
    router.use(renderRefusal);
    expect((await router.fetch("/r")).status).toBe(200);
    expect((await issuesOf(await router.fetch("/r?named=1")))[0].message).toBe(
      'variant("a") was named, but this status declares no variants',
    );
  });

  it("a common plain status's headers do not reach a route's variants status", async () => {
    const { logger } = createTestLogger();
    const router = new BunRouter({
      logger,
      responseValidation: "error",
      commonResponses: {
        200: { headers: z.object({ "x-common": z.literal("1") }) },
      },
    });
    router.get(
      "/r",
      validate({}, { responses: { 200: common200 } }),
      (_req, res) => untyped(res).status(200).json({ a: 1 }),
    );
    router.use(renderRefusal);
    expect((await router.fetch("/r")).status).toBe(200);
  });

  it("the negative control: per part, a common header would apply to a route's plain status", async () => {
    const { logger } = createTestLogger();
    const router = new BunRouter({
      logger,
      responseValidation: "error",
      commonResponses: {
        200: { headers: z.object({ "x-common": z.literal("1") }) },
      },
    });
    router.get(
      "/r",
      validate({}, { responses: { 200: z.object({ a: z.literal(1) }) } }),
      (_req, res) => untyped(res).status(200).json({ a: 1 }),
    );
    router.use(renderRefusal);
    const issues = await issuesOf(await router.fetch("/r"));
    expect(issues.some((i) => i.target === "headers")).toBe(true);
  });

  it("a mount's variants status, replaced by a route's plain one", async () => {
    const { logger } = createTestLogger();
    const router = new BunRouter({ logger, responseValidation: "error" });
    const sub = new BunRouter();
    sub.get(
      "/r",
      validate({}, { responses: { 200: z.object({ b: z.literal(2) }) } }),
      (_req, res) => untyped(res).status(200).json({ b: 2 }),
    );
    router.use("/m", validate({}, { responses: { 200: common200 } }), sub);
    router.use(renderRefusal);
    expect((await router.fetch("/m/r")).status).toBe(200);
  });

  it("in contract form, mergeContracts replaces a variants key whole", () => {
    const outer = getContract(
      validate(
        {},
        { responses: { 200: common200, 404: z.object({ c: z.string() }) } },
      ),
    )!;
    const inner = getContract(
      validate(
        {},
        { responses: { 200: { headers: z.object({ "x-i": z.string() }) } } },
      ),
    )!;
    const merged = describeContract(
      mergeContracts([
        { contract: outer, origin: "router" },
        { contract: inner, origin: "route" },
      ]),
    );
    const rows200 = merged.entries.filter((e) => e.key === "200");
    expect(rows200.map((e) => [e.part, e.variant, e.origin])).toEqual([
      ["headers", undefined, "route"],
    ]);
    expect(merged.sides.outbound?.variants).toBeUndefined();
    const reversed = describeContract(
      mergeContracts([
        { contract: inner, origin: "route" },
        { contract: outer, origin: "router" },
      ]),
    );
    expect(
      reversed.entries
        .filter((e) => e.key === "200")
        .map((e) => [e.part, e.variant, e.origin]),
    ).toEqual([["body", "a", "router"]]);
    expect(reversed.sides.outbound?.variants?.["200"]?.names).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// describeContract
// ---------------------------------------------------------------------------

describe("describeContract: flat variant rows, and sides.outbound.variants", () => {
  it("one row per (key, variant, part, mediaType), and the variants table", () => {
    const mw = validate(
      { headers: AdminHeader },
      {
        responses: {
          200: variants(
            {
              admin: {
                when: (valid) => valid.headers["x-admin"] === "1",
                description: "to admins (x-admin: 1)",
                headers: z.object({ "x-admin": z.literal("1") }),
                content: { "application/json": ZAdminView },
              },
              user: { content: { "application/json": ZUserView } },
            },
            { by: { header: "X-Admin", values: { admin: "1", user: null } } },
          ),
          206: variants(
            {
              full: { content: { "application/json": ZUserView } },
              summary: { content: null },
            },
            { by: { header: "x-mode" } },
          ),
          404: z.object({ code: z.string() }),
        },
      },
    );
    const d = describeContract(getContract(mw)!);
    expect(d.sides.outbound?.keys).toEqual(["200", "206", "404"]);
    expect(d.sides.outbound?.variants).toEqual({
      200: {
        names: ["admin", "user"],
        conditional: ["admin"],
        by: {
          part: "headers",
          name: "x-admin",
          values: { admin: "1", user: null },
        },
        descriptions: { admin: "to admins (x-admin: 1)" },
      },
      206: {
        names: ["full", "summary"],
        conditional: [],
        by: {
          part: "headers",
          name: "x-mode",
          values: { full: "full", summary: "summary" },
        },
        descriptions: {},
      },
    });
    const out = d.entries
      .filter((e) => e.side === "outbound")
      .map((e) => [e.key, e.variant, e.part, e.mediaType ?? null]);
    expect(out).toEqual([
      ["200", "admin", "headers", null],
      ["200", "admin", "body", "application/json"],
      ["200", "user", "body", "application/json"],
      ["206", "full", "body", "application/json"],
      ["206", "summary", "body", null],
      ["404", undefined, "body", "application/json"],
    ]);
    // A row of a plain status has no variant field at all.
    expect(
      "variant" in
        d.entries.find((e) => e.key === "404" && e.side === "outbound")!,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// messages and redactPaths (#486) on variant issues
// ---------------------------------------------------------------------------

describe("messages and redactPaths apply to variant issues", () => {
  const table = (options: { messages?: "generic"; redactPaths?: boolean }) =>
    validate(
      {},
      {
        ...options,
        responses: {
          200: variants(
            {
              full: {
                content: {
                  "application/json": z.object({ items: z.array(z.string()) }),
                },
                refine: () => [
                  { part: "body", path: "items", message: "refine says no" },
                ],
              },
              summary: {
                content: {
                  "application/json": z.object({ count: z.number() }),
                },
              },
            },
            { by: { header: "x-mode" } },
          ),
        },
      },
    );
  const send =
    (mode: string, body: Record<string, unknown>) =>
    (_req: unknown, res: unknown): void => {
      untyped(res).status(200).set("x-mode", mode).json(body);
    };

  it("messages: \"generic\": a vendor's and a refine's messages replaced; the framework's kept", async () => {
    const { get } = await serve("error", (r) => {
      r.get(
        "/s",
        table({ messages: "generic" }),
        send("summary", { count: "x" }),
      );
      r.get("/f", table({ messages: "generic" }), send("full", { items: [] }));
    });
    const issues = await issuesOf(await get("/s"));
    expect(issues[0].message).toBe(
      "The response matches no acceptable variant (summary)",
    );
    expect(issues[1]).toMatchObject({
      target: "body",
      path: "count",
      variant: "summary",
    });
    expect(issues[1].message.startsWith("Invalid value")).toBe(true);
    const refined = await issuesOf(await get("/f"));
    expect(refined[1]).toMatchObject({ path: "items", variant: "full" });
    expect(refined[1].message.startsWith("Invalid value")).toBe(true);
  });

  it("redactPaths: every path empty, the discriminant's and a refine's included", async () => {
    const { get } = await serve("error", (r) => {
      r.get(
        "/s",
        table({ redactPaths: true }),
        send("summary", { count: "x" }),
      );
      r.get("/w", table({ redactPaths: true }), send(WEIRD, { count: 1 }));
      r.get("/f", table({ redactPaths: true }), send("full", { items: [] }));
    });
    for (const path of ["/s", "/w", "/f"]) {
      const issues = await issuesOf(await get(path));
      expect(issues.every((i) => i.path === "")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The adapter, and an async vendor under warn
// ---------------------------------------------------------------------------

it("through BunHttpAdapter.fetch(): the same gate", async () => {
  const { logger } = createTestLogger();
  const adapter = new BunHttpAdapter(0, {
    logger,
    responseValidation: "error",
  });
  adapter.get("/me", byRequest("zod"), sender);
  adapter.use(renderRefusal);
  expect((await adapter.fetch("/me")).status).toBe(200);
  const leak = await adapter.fetch("/me?send=admin");
  expect((await issuesOf(leak)).map((i) => i.message)).toContain(
    'The response matches variant "admin", which does not apply to this request',
  );
});

it("under warn, an async vendor with no named variant: sent at once, reported when settled", async () => {
  const { get, events } = await serve("warn", (r) =>
    r.get("/me", byRequest("yup"), sender),
  );
  const res = await get("/me?send=mixed", ADMIN);
  expect(res.status).toBe(200);
  await until(() => mismatches(events).length === 1);
});

it("a write() stream's opening is adjusted too: the discriminant and a literal header filled before the status line", async () => {
  const { get } = await serve(
    "error",
    (r) =>
      r.get(
        "/s",
        validate(
          {},
          {
            responses: {
              200: variants(
                {
                  live: {
                    headers: z.object({ "x-live": z.literal("yes") }),
                    content: { "text/plain": chunks(z.string()) },
                  },
                  done: { content: { "application/json": ZUserView } },
                },
                { by: { header: "x-view" } },
              ),
            },
          },
        ),
        async (_req, res) => {
          const r = named(res, "live").status(200).type("text/plain");
          r.write("a");
          await Bun.sleep(2);
          await r.end("b");
        },
      ),
    "socket",
  );
  const res = await get("/s");
  expect(res.headers.get("x-view")).toBe("live");
  expect(res.headers.get("x-live")).toBe("yes");
  expect(await drain(res)).toEqual({ status: 200, text: "ab", end: "done" });
});

describe("the contract core's guards refuse a variants key (not yet supported there)", () => {
  const contract = () =>
    getContract(
      validate(
        {},
        {
          responses: {
            200: variants({
              a: { content: { "application/json": ZUserView } },
            }),
            404: z.object({ code: z.string() }),
          },
        },
      ),
    )!;

  it("createSender and createReceiver throw a TypeError at creation, under every policy", () => {
    const message =
      "http outbound status \"200\" is declared with variants(), which the contract core's guards (createSender, createReceiver) do not check yet; HTTP's validate() checks them";
    for (const policy of ["error", "warn", "off"] as const) {
      expect(() => createSender(contract(), "outbound", { policy })).toThrow(
        TypeError,
      );
      expect(() => createSender(contract(), "outbound", { policy })).toThrow(
        message,
      );
      expect(() => createReceiver(contract(), "outbound", { policy })).toThrow(
        message,
      );
    }
  });

  it("a side with no variants still builds, and describeContract and mergeContracts read the variants key", () => {
    expect(() => createReceiver(contract(), "inbound")).not.toThrow();
    const plain = getContract(validate({}, { responses: { 200: ZUserView } }))!;
    expect(createSender(plain, "outbound").checks).toBe(true);
    const described = describeContract(contract());
    expect(
      described.entries
        .filter((e) => e.side === "outbound")
        .map((e) => [e.key, e.variant]),
    ).toEqual([
      ["200", "a"],
      ["404", undefined],
    ]);
    const merged = mergeContracts([
      { contract: plain, origin: "router" },
      { contract: contract(), origin: "route" },
    ]);
    expect(
      describeContract(merged).sides.outbound?.variants?.["200"]?.names,
    ).toEqual(["a"]);
    expect(() => createSender(merged, "outbound")).toThrow(TypeError);
  });
});
