/* eslint-disable no-console, antfu/no-top-level-await, n/prefer-global/process -- a CLI entry point, as scripts/ */
/**
 * Runtime cases RV1–RV28 for the response-variants matcher (plan §4.4.6).
 * `bun run.ts` prints one line per case, `PASS` or `FAIL` against what the
 * plan says it shows, and the issues as the gate would report them.
 */
import type {
  RequestView,
  ResponseView,
  UntypedValid,
  Verdict,
} from "./variants";
import * as v from "valibot";
import * as yup from "yup";
import { z } from "zod";
import { compile, counters, errorsLogged, match, variants } from "./variants";

const SECRET = "s3cr3t-salary-77"; // planted in bodies and headers: must appear in no issue
const AdminView = z.object({
  id: z.string(),
  role: z.literal("admin"),
  salary: z.number(),
  note: z.string(),
});
const UserView = z.object({ id: z.string(), role: z.literal("user") });
const adminBody = { id: "a", role: "admin", salary: 1, note: SECRET };
const userBody = { id: "a", role: "user" };

// Outside a validator `when` sees UntypedValid (every part optional, unknown), so it narrows for itself.
const isAdmin = (valid: UntypedValid) =>
  (valid.headers as { "x-admin"?: string } | undefined)?.["x-admin"] === "1";
const adminReq: RequestView = { valid: { headers: { "x-admin": "1" } } };
const userReq: RequestView = { valid: { headers: {} } };

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  extra: Partial<ResponseView> = {},
): ResponseView => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  cookies: {},
  mediaType: "application/json",
  body,
  ...extra,
});

/** The user's own example: an admin, recognised by a request header, gets a different body and a response header. */
const byRequest = compile({
  200: variants({
    admin: {
      when: isAdmin,
      headers: z.object({ "x-admin": z.literal("1") }),
      content: { "application/json": AdminView },
    },
    // `x-admin` must be absent here: a headers schema sees every header, so it cannot be strict; it names what must not be
    // there. (zod 4's z.undefined() alone makes the key required: "expected nonoptional", so absence is z.never().optional().)
    user: {
      headers: z.object({ "x-admin": z.never().optional() }),
      content: { "application/json": UserView },
    },
  }),
  404: z.object({ code: z.string() }),
});

/** The same, the response header as the discriminant: "1" selects admin, its absence user. */
const byHeader = compile({
  200: variants(
    {
      admin: { when: isAdmin, content: { "application/json": AdminView } },
      user: { content: { "application/json": UserView } },
    },
    { by: { header: "x-admin", values: { admin: "1", user: null } } },
  ),
});

const results: string[] = [];
let failures = 0;
async function show(
  id: string,
  what: string,
  verdict: Verdict | Promise<Verdict>,
  expect: (v: Verdict) => boolean,
) {
  const v = await verdict;
  const ok = expect(v);
  if (!ok) failures++;
  const text = JSON.stringify(v);
  const leaked =
    text.includes(SECRET) ||
    text.includes("weird-mode") ||
    text.includes("Alice-Secret");
  if (leaked) failures++;
  results.push(
    `${ok && !leaked ? "PASS" : "FAIL"} ${id} ${what}${leaked ? " [LEAKED A VALUE]" : ""}`,
  );
  results.push(`     ${text}`);
}
const refusedWith =
  (...fragments: string[]) =>
  (v: Verdict) =>
    !v.ok && fragments.every((f) => JSON.stringify(v.issues).includes(f));
const sentAs = (variant: string | undefined) => (v: Verdict) =>
  v.ok && v.variant === variant;

// RV1–RV4: whole-response match, and `when`.
await show(
  "RV1",
  "admin request, admin header + admin body: sent as admin",
  match(byRequest, json(200, adminBody, { "x-admin": "1" }), adminReq),
  sentAs("admin"),
);
await show(
  "RV2",
  "admin request, x-admin: 1 + a user body (parts from two variants): refused; each variant's own issues",
  match(byRequest, json(200, userBody, { "x-admin": "1" }), adminReq),
  refusedWith(
    "matches no acceptable variant",
    '"variant":"admin"',
    '"variant":"user"',
    '"target":"headers"',
  ),
);
await show(
  "RV3",
  "non-admin request, a valid admin response (the leak): refused, the diagnostic names the variant",
  match(byRequest, json(200, adminBody, { "x-admin": "1" }), userReq),
  refusedWith('matches variant \\"admin\\", which does not apply'),
);
await show(
  "RV4",
  "non-admin request, user body: sent as user",
  match(byRequest, json(200, userBody), userReq),
  sentAs("user"),
);

// RV5: no variant's `when` holds.
const allConditional = compile({
  200: variants({
    admin: { when: isAdmin, content: { "application/json": AdminView } },
    member: {
      when: (v) =>
        (v.cookies as { sid?: string } | undefined)?.sid !== undefined,
      content: { "application/json": UserView },
    },
  }),
});
await show(
  "RV5",
  "a request no variant applies to: refused, 'no variant applies'",
  match(allConditional, json(200, userBody), userReq),
  refusedWith(
    "No variant of this status applies to this request (2 excluded by when)",
  ),
);

// RV6–RV7: the discriminant.
await show(
  "RV6a",
  'discriminant: header x-admin "1" from an admin request selects admin',
  match(byHeader, json(200, adminBody, { "x-admin": "1" }), adminReq),
  sentAs("admin"),
);
await show(
  "RV6b",
  "discriminant: absent header selects user",
  match(byHeader, json(200, userBody), userReq),
  sentAs("user"),
);
await show(
  "RV6c",
  'discriminant: x-admin "1" + a user body: only admin is checked (one variant\'s issues)',
  match(byHeader, json(200, userBody, { "x-admin": "1" }), adminReq),
  (v) =>
    refusedWith('"variant":"admin"')(v) &&
    !JSON.stringify(v).includes('"variant":"user"'),
);
await show(
  "RV6d",
  "discriminant selects admin for a non-admin request: refused, 'does not apply'",
  match(byHeader, json(200, adminBody, { "x-admin": "1" }), userReq),
  refusedWith(
    'Variant \\"admin\\" (selected by header x-admin) does not apply',
  ),
);
const byMode = compile({
  200: variants(
    {
      full: {
        content: {
          "application/json": z.object({ items: z.array(z.string()) }),
        },
      },
      summary: {
        content: { "application/json": z.object({ count: z.number() }) },
      },
    },
    { by: { header: "x-mode" } },
  ),
});
await show(
  "RV6e",
  "x-mode: summary + summary body: sent as summary",
  match(byMode, json(200, { count: 2 }, { "x-mode": "summary" }), userReq),
  sentAs("summary"),
);
await show(
  "RV6f",
  "x-mode: weird-mode: refused; the issue lists the declared values, never the received one",
  match(byMode, json(200, { count: 2 }, { "x-mode": "weird-mode" }), userReq),
  refusedWith("expected full, summary"),
);
await show(
  "RV6g",
  "x-mode missing: refused on headers.x-mode",
  match(byMode, json(200, { count: 2 }), userReq),
  refusedWith('"path":"x-mode"'),
);
const byCookie = compile({
  200: variants(
    {
      fresh: { content: { "application/json": UserView } },
      anon: {
        content: { "application/json": z.object({ guest: z.literal(true) }) },
      },
    },
    { by: { cookie: "sid", values: { fresh: true, anon: null } } },
  ),
});
const sid = { value: "x", httpOnly: true, secure: true, partitioned: false };
await show(
  "RV7a",
  "discriminant: a Set-Cookie sid (any value) selects fresh",
  match(byCookie, json(200, userBody, {}, { cookies: { sid } }), userReq),
  sentAs("fresh"),
);
await show(
  "RV7b",
  "discriminant: no sid cookie selects anon; a fresh body under it is refused",
  match(byCookie, json(200, userBody), userReq),
  refusedWith('"variant":"anon"'),
);

// RV8: `res.variant()` named by the handler.
await show(
  "RV8a",
  "variant(\"admin\") named for a non-admin request: refused, 'does not apply'",
  match(
    byRequest,
    json(200, adminBody, { "x-admin": "1" }, { variant: "admin" }),
    userReq,
  ),
  refusedWith("(named by variant()) does not apply"),
);
await show(
  "RV8b",
  'variant("user") named, admin body sent: only user is checked',
  match(byRequest, json(200, adminBody, {}, { variant: "user" }), adminReq),
  (v) =>
    refusedWith('"variant":"user"')(v) &&
    !JSON.stringify(v).includes('"variant":"admin"'),
);
await show(
  "RV8c",
  "variant() named on a status without variants: refused",
  match(
    byRequest,
    json(404, { code: "x" }, {}, { variant: "admin" }),
    adminReq,
  ),
  refusedWith("declares no variants"),
);

// RV9: refine, a whole-response check across parts; its quoted value is withheld.
const counted = compile({
  200: variants(
    {
      list: {
        headers: z.object({ "x-total": z.string() }),
        content: {
          "application/json": z.object({ items: z.array(z.string()) }),
        },
      },
    },
    {
      refine: (res) => {
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
      },
    },
  ),
});
await show(
  "RV9a",
  "refine passes: x-total 2, two items",
  match(counted, json(200, { items: ["a", "b"] }, { "x-total": "2" }), userReq),
  sentAs("list"),
);
await show(
  "RV9b",
  "refine fails: x-total 5, items quote 'Alice-Secret': refused, the quoted value withheld",
  match(
    counted,
    json(200, { items: ["Alice-Secret", "b"] }, { "x-total": "5" }),
    userReq,
  ),
  refusedWith('"path":"x-total"', '"target":"headers"'),
);

// RV10: a `when` that throws, or answers a non-boolean, is a failed check: one issue, no value, the error logged.
const throwing = compile({
  200: variants({
    admin: {
      when: () => {
        throw new Error(SECRET);
      },
      content: { "application/json": AdminView },
    },
    user: { content: { "application/json": UserView } },
  }),
});
await show(
  "RV10a",
  "when throws: refused as 'could not be checked'; the error goes to the log, not the issue",
  match(throwing, json(200, userBody), userReq),
  (v) => !v.ok && v.failed === true && errorsLogged.length === 1,
);
const asyncWhen = compile({
  200: variants({
    admin: {
      when: (async () => true) as never,
      content: { "application/json": AdminView },
    },
  }),
});
// Q-H17 (the user's answer): an async `when` is allowed and awaited; a sync one is decided in place.
const asyncVerdict = match(asyncWhen, json(200, adminBody), adminReq);
await show(
  "RV10b",
  "an async when resolving true: awaited (the verdict is a Promise), sent as admin",
  asyncVerdict,
  (v) => asyncVerdict instanceof Promise && sentAs("admin")(v),
);
const syncVerdict = match(
  byRequest,
  json(200, adminBody, { "x-admin": "1" }),
  adminReq,
);
await show(
  "RV10c",
  "the fast path: a sync when gives a sync verdict, no Promise made",
  syncVerdict,
  (v) => !(syncVerdict instanceof Promise) && sentAs("admin")(v),
);
const badAsync = compile({
  200: variants({
    admin: {
      when: (async () => "yes") as never,
      content: { "application/json": AdminView },
    },
  }),
});
await show(
  "RV10d",
  "an async when resolving to a non-boolean: a failed check",
  match(badAsync, json(200, adminBody), adminReq),
  (v) => !v.ok && v.failed === true,
);
const rejecting = compile({
  200: variants({
    admin: {
      when: async () => {
        throw new Error(SECRET);
      },
      content: { "application/json": AdminView },
    },
  }),
});
await show(
  "RV10e",
  "an async when that rejects: a failed check, the error logged, not in the issue",
  match(rejecting, json(200, adminBody), adminReq),
  (v) => !v.ok && v.failed === true,
);

// RV11: `req.valid` lacking a part (no validator, e.g. under commonResponses): `when` reads undefined, does not throw.
await show(
  "RV11",
  "no validator ran (valid is {}): admin's when is false, the user variant applies",
  match(byRequest, json(200, userBody), { valid: {} }),
  sentAs("user"),
);

// RV12: cost in calls: one `when` call per variant that has one, none with no variants.
counters.when = 0;
const eight = compile({
  200: variants(
    Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `v${i}`,
        { when: () => i === 7, content: { "application/json": UserView } },
      ]),
    ),
  ),
});
await match(eight, json(200, userBody), userReq);
const eightCalls = counters.when;
counters.when = 0;
const plain = compile({ 200: UserView });
await match(plain, json(200, userBody), userReq);
await show(
  "RV12",
  `when calls: 8 variants → ${eightCalls}; a plain status → ${counters.when}`,
  { ok: true, variant: undefined },
  () => eightCalls === 8 && counters.when === 0,
);

// RV13: an async vendor (yup): the same verdicts, through a Promise.
const yupTable = compile({
  200: variants({
    admin: {
      when: isAdmin,
      content: {
        "application/json": yup.object({ salary: yup.number().required() }),
      },
    },
    user: {
      content: {
        "application/json": yup.object({
          role: yup.string().oneOf(["user"]).required(),
        }),
      },
    },
  }),
});
const yupGood = match(yupTable, json(200, { role: "user" }), userReq);
await show(
  "RV13a",
  "yup: a Promise verdict, user body sent as user",
  yupGood,
  (v) => yupGood instanceof Promise && sentAs("user")(v),
);
await show(
  "RV13b",
  "yup: non-admin, an admin body: refused, the leak named",
  match(yupTable, json(200, { salary: 5 }), userReq),
  refusedWith('matches variant \\"admin\\"'),
);

// RV14: declaration mistakes are TypeErrors.
const throwsType = (f: () => unknown): string => {
  try {
    f();
    return "no error";
  } catch (error) {
    return error instanceof TypeError
      ? `TypeError: ${error.message}`
      : String(error);
  }
};
const declErrors = [
  throwsType(() =>
    compile({
      200: { when: () => true, content: { "application/json": UserView } },
    }),
  ),
  throwsType(() =>
    compile({
      200: variants(
        { a: { content: null }, b: { content: null } },
        { by: { header: "x-m", values: { a: "1", b: "1" } } },
      ),
    }),
  ),
  throwsType(() =>
    compile({
      200: variants(
        { a: { content: null } },
        { by: { header: "x-m", values: { zz: "1" } as never } },
      ),
    }),
  ),
  throwsType(() => compile({ 200: variants({}) })),
];
await show(
  "RV14",
  `declaration errors: ${declErrors.join(" | ")}`,
  { ok: true, variant: undefined },
  () => declErrors.every((e) => e.startsWith("TypeError")),
);

// RV15: a status with no variants behaves as V3a's (one spec, every part checked).
await show(
  "RV15",
  "plain status: a bad body refused with V3a's issue shape (no variant field)",
  match(plain, json(200, { id: 1 }), userReq),
  (v) => !v.ok && !JSON.stringify(v).includes('"variant"'),
);

// RV17: the limit of a check that never strips. A user view that is a structural subset of the admin
// view (no discriminating literal, not strict) accepts the admin body, so the leak is NOT caught; the
// same table with z.strictObject for the user view refuses it and names the admin variant.
const loose = compile({
  200: variants({
    admin: {
      when: isAdmin,
      content: {
        "application/json": z.object({ id: z.string(), salary: z.number() }),
      },
    },
    user: { content: { "application/json": z.object({ id: z.string() }) } },
  }),
});
const strict = compile({
  200: variants({
    admin: {
      when: isAdmin,
      content: {
        "application/json": z.object({ id: z.string(), salary: z.number() }),
      },
    },
    user: {
      content: { "application/json": z.strictObject({ id: z.string() }) },
    },
  }),
});
const leakBody = { id: "a", salary: 77 };
await show(
  "RV17a",
  "LIMIT: non-admin, admin body, user view a loose subset: SENT as user (the leak passes a check-only gate)",
  match(loose, json(200, leakBody), userReq),
  sentAs("user"),
);
await show(
  "RV17b",
  "the same with z.strictObject for the user view: refused, the admin variant named",
  match(strict, json(200, leakBody), userReq),
  refusedWith('matches variant \\"admin\\"'),
);

// RV18–RV27: `.variant()` adjusts the response (Q-H18) before the check, once its `when` holds.
const AdminK = z.object({
  kind: z.literal("admin"),
  id: z.string(),
  salary: z.number(),
  meta: z.object({ v: z.literal(2), at: z.string() }),
  items: z.array(z.object({ k: z.literal("a"), y: z.string() })),
});
const adj = compile({
  200: variants(
    {
      admin: {
        when: isAdmin,
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
});
/** A handler's draft: `.variant()` named, status and Content-Type left implicit (json()'s). */
const draft = (
  body: unknown,
  variant: string,
  headers: Record<string, string> = {},
  status = 200,
): ResponseView => ({
  ...json(status, body, headers),
  variant,
  statusExplicit: false,
  contentTypeExplicit: false,
});
const handlerBody = {
  id: "a",
  salary: 9,
  meta: { at: "t", secret: SECRET },
  items: [{ y: "1" }, { y: "2", note: SECRET }],
  internal: SECRET,
};
const snapshot = JSON.stringify(handlerBody);
const rv18 = await match(
  adj,
  draft(handlerBody, "admin", { "x-request-id": "r1" }),
  adminReq,
);
await show(
  "RV18",
  'variant("admin"): fills the discriminant x-view, the literal x-tier, Content-Type, kind, meta.v, items[].k; strips 3 undeclared fields; sent',
  rv18,
  (v) => {
    if (!v.ok || v.adjusted === undefined) return false;
    const out = v.adjusted.view;
    const body = out.body as {
      kind: string;
      meta: { v: number };
      items: { k: string }[];
    };
    return (
      out.headers["x-view"] === "admin-view" &&
      out.headers["x-tier"] === "gold" &&
      out.mediaType === "application/vnd.admin+json" &&
      body.kind === "admin" &&
      body.meta.v === 2 &&
      body.items.every((i) => i.k === "a") &&
      !JSON.stringify(out.body).includes(SECRET)
    );
  },
);
await show(
  "RV19",
  "the handler's own object is never mutated (copy-on-write)",
  { ok: true, variant: undefined },
  () => JSON.stringify(handlerBody) === snapshot,
);
await show(
  "RV20",
  'variant("created") with no status set: the one status declaring it (201) is filled, and kind',
  match(adj, draft({ id: "a" }, "created", { location: "/a" }), userReq),
  (v) =>
    v.ok &&
    v.adjusted?.view.status === 201 &&
    v.adjusted.changes.includes("status: filled (201)"),
);
await show(
  "RV21",
  "a required field with no single value (salary) missing: not fillable, left to the check, refused on body.salary",
  match(
    adj,
    draft({ id: "a", meta: { at: "t" }, items: [] }, "admin", {
      "x-request-id": "r1",
    }),
    adminReq,
  ),
  refusedWith('"path":"salary"', '"variant":"admin"'),
);
await show(
  "RV22",
  "a literal the handler set wrongly (x-tier: silver) is never overwritten: refused on headers.x-tier",
  match(
    adj,
    draft({ ...handlerBody }, "admin", {
      "x-request-id": "r1",
      "x-tier": "silver",
    }),
    adminReq,
  ),
  refusedWith('"path":"x-tier"'),
);
await show(
  "RV23",
  'variant("admin") for a non-admin request: when is decided first, nothing adjusted, refused',
  match(
    adj,
    draft({ ...handlerBody }, "admin", { "x-request-id": "r1" }),
    userReq,
  ),
  refusedWith("does not apply"),
);
await show(
  "RV24",
  "the handler set the discriminant to another variant's value: not overwritten, refused (disagreement)",
  match(
    adj,
    draft({ ...handlerBody }, "admin", {
      "x-request-id": "r1",
      "x-view": "user-view",
    }),
    adminReq,
  ),
  refusedWith('Selects variant \\"user\\", but variant(\\"admin\\") was named'),
);
await show(
  "RV25",
  'THE LEAK FIX: RV17a\'s loose table, variant("user") on the admin body: salary stripped, sent as user',
  match(loose, { ...json(200, leakBody), variant: "user" }, userReq),
  (v) =>
    v.ok &&
    v.variant === "user" &&
    JSON.stringify(v.adjusted?.view.body) === JSON.stringify({ id: "a" }) &&
    (v.adjusted?.changes ?? []).includes("body: stripped 1 undeclared field"),
);
const valibotTable = compile({
  200: variants({
    admin: {
      content: {
        "application/json": v.object({
          kind: v.literal("admin"),
          id: v.string(),
        }),
      },
    },
  }),
});
await show(
  "RV26",
  "valibot (no ~standard.jsonSchema): the body is not adjustable; kind left to the check, refused",
  match(
    valibotTable,
    { ...json(200, { id: "a", extra: 1 }), variant: "admin" },
    adminReq,
  ),
  refusedWith('"path":"kind"'),
);
const unions = compile({
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
});
await show(
  "RV27",
  "limits: a union member and a record are neither filled nor stripped (their keys stay); the top level is stripped",
  match(
    unions,
    {
      ...json(200, { id: "a", u: { a: 1, x: 9 }, rec: { k: 1 }, top: 1 }),
      variant: "shape",
    },
    adminReq,
  ),
  (v) =>
    v.ok &&
    JSON.stringify(v.adjusted?.view.body) ===
      JSON.stringify({ id: "a", u: { a: 1, x: 9 }, rec: { k: 1 } }),
);

const cookieTable = compile({
  200: variants({
    full: {
      cookies: z.object({
        mode: z.object({ value: z.literal("full"), httpOnly: z.literal(true) }),
        sid: z.object({ value: z.string(), httpOnly: z.literal(true) }),
      }),
      content: { "application/json": z.object({ id: z.string() }) },
    },
  }),
});
const sidCookie = {
  value: "x",
  httpOnly: true,
  secure: false,
  partitioned: false,
};
await show(
  "RV28",
  "cookies: mode (value and httpOnly each one value) filled with its attributes; sid (any value) is not fillable, and the handler's own is kept",
  match(
    cookieTable,
    {
      ...json(200, { id: "a" }, {}, { cookies: { sid: sidCookie } }),
      variant: "full",
    },
    adminReq,
  ),
  (v) =>
    v.ok &&
    v.adjusted?.view.cookies.mode?.value === "full" &&
    v.adjusted.view.cookies.mode.httpOnly &&
    v.adjusted.view.cookies.sid === sidCookie,
);
await show(
  "RV28b",
  "cookies: with no sid at all, mode is filled but sid cannot be: refused on cookies.sid",
  match(cookieTable, { ...json(200, { id: "a" }), variant: "full" }, adminReq),
  refusedWith('"target":"cookies"', '"path":"sid"'),
);

// RV16: privacy across every case above is checked by `show` (no planted value in any verdict).
results.push(
  `${failures === 0 ? "PASS" : "FAIL"} RV16 no planted value (${SECRET}, weird-mode, Alice-Secret) in any verdict; failures: ${failures}`,
);

console.log(
  `# response-variants run.ts — Bun ${Bun.version} (${Bun.revision.slice(0, 9)}), zod ${(await import("zod/package.json")).version}, yup ${(await import("yup/package.json")).version}`,
);
console.log(results.join("\n"));
process.exitCode = failures === 0 ? 0 : 1;
