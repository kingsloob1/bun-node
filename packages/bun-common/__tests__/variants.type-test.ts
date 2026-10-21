/**
 * Compile-time checks for response variants (plan §4.4.6, V3c), ported from
 * `evidence/response-variants/types.probe.ts` (VT1–VT21) onto the real API:
 * `variants()` inside `validate()`, the real verb overloads and
 * `res.variant()`. Plus B1 made a control (a discriminant's `null` refuses
 * `set()`), and `when`'s parameter asserted equal to the parsed parts.
 *
 * Checked by `bun run check` (a `*.type-test.ts` is never run by
 * `bun test`). Each directive must fire on the line under it, and only
 * there: `check-type-controls.sh` (the V3c build's scratch) strips them and
 * requires exactly one error per directive, each on its own line.
 */
import * as v from "valibot";
import { z } from "zod";
import type { BunResponse } from "../lib/BunResponse";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { validate } from "../lib/BunValidate";
import type { Refine } from "../lib/responseBodies";
import { variants } from "../lib/responseBodies";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const AdminView = z.object({
  id: z.string(),
  role: z.literal("admin"),
  salary: z.number(),
});
const UserView = z.object({ id: z.string(), role: z.literal("user") });
const Problem = z.object({ code: z.string() });
const adminBody = { id: "a", role: "admin" as const, salary: 1 };
const userBody = { id: "a", role: "user" as const };

const r = new BunRouter();

/* ---- 1. variants by request: `when` typed by the validator ---- */
const byRole = validate(
  {
    headers: z.object({ "x-admin": z.literal("1").optional() }),
    cookies: z.object({ sid: z.string().optional() }),
  },
  {
    responses: {
      200: variants({
        admin: {
          when: (valid) => {
            type _ = Expect<
              Equal<
                typeof valid,
                { headers: { "x-admin"?: "1" }; cookies: { sid?: string } }
              >
            >;
            return valid.headers["x-admin"] === "1";
          },
          headers: z.object({ "x-admin": z.literal("1") }),
          content: { "application/json": AdminView },
        },
        user: { content: { "application/json": UserView } },
      }),
      404: Problem,
    },
  },
);

r.get("/me", byRole, (req, res) => {
  type _v = Expect<
    Equal<
      typeof req.valid,
      { headers: { "x-admin"?: "1" }; cookies: { sid?: string } }
    >
  >;
  const n = Number(req.query.n);
  // The union without .variant(), as V3a types any status.
  if (n === 1) return res.status(200).json(adminBody);
  if (n === 2) return res.status(200).json(userBody);
  res.status(200).set("x-admin", "1");
  // Narrowed.
  if (n === 3) {
    return res.status(200).variant("admin").set("x-admin", "1").json(adminBody);
  }
  if (n === 4) return res.status(200).variant("user").json(userBody);
  if (n === 5) return res.status(404).json({ code: "NOPE" });
  // @ts-expect-error VT1 an undeclared variant name
  if (n === 6) return res.status(200).variant("root");
  // @ts-expect-error VT2 the admin body under the user variant
  if (n === 7) return res.status(200).variant("user").json(adminBody);
  // @ts-expect-error VT3 the user body under the admin variant
  if (n === 8) return res.status(200).variant("admin").json(userBody);
  // @ts-expect-error VT4 a variant's header outside its declared literal
  res.status(200).variant("admin").set("x-admin", "0");
  // @ts-expect-error VT5 .variant() on a status that declares none (404)
  if (n === 9) return res.status(404).variant("admin");
  // @ts-expect-error VT6 neither variant's body on the union
  if (n === 10) return res.status(200).json({ id: "a", role: "root" });
  // B2, a boundary: a structural superset passes json()'s generic constraint.
  if (n === 11) {
    return res
      .status(200)
      .variant("user")
      .json({ id: "a", role: "user", salary: 1 });
  }
  return res.status(200).variant("user").json(userBody);
});

/* ---- 2. `when` sees only what the validator parsed, and answers a boolean ---- */
validate(
  { headers: z.object({ "x-admin": z.literal("1").optional() }) },
  {
    responses: {
      200: variants({
        admin: {
          // @ts-expect-error VT7 cookies were not validated, so req.valid has none
          when: (valid) => valid.cookies.sid !== undefined,
          content: { "application/json": AdminView },
        },
        user: { content: { "application/json": UserView } },
      }),
    },
  },
);
validate(
  { headers: z.object({ "x-admin": z.literal("1").optional() }) },
  {
    responses: {
      200: variants({
        admin: {
          // @ts-expect-error VT8 the parsed header is the literal "1" | undefined, never a number
          when: (valid) => valid.headers["x-admin"] === 1,
          content: { "application/json": AdminView },
        },
      }),
    },
  },
);
validate(
  {},
  {
    responses: {
      200: variants({
        admin: {
          when: async () => true, // allowed (Q-H17): awaited, holding the commit
          content: { "application/json": AdminView },
        },
        member: {
          // @ts-expect-error VT9 `when` answers a boolean (or a Promise of one), never another value
          when: () => "yes",
          content: { "application/json": UserView },
        },
        guest: {
          // @ts-expect-error VT18 an async `when` must resolve to a boolean
          when: async () => "yes",
          content: { "application/json": UserView },
        },
      }),
    },
  },
);
validate(
  {},
  {
    responses: {
      200: variants({
        admin: {
          content: { "application/json": AdminView },
          // @ts-expect-error VT10 an unknown key in a variant
          whenever: () => true,
        },
      }),
    },
  },
);

/* ---- 3. a response discriminant: a header selects the variant ---- */
const Full = z.object({ id: z.string(), items: z.array(z.string()) });
const Summary = z.object({ id: z.string(), count: z.number() });
const byMode = validate(
  {},
  {
    responses: {
      200: variants(
        {
          full: { content: { "application/json": Full } },
          summary: { content: { "application/json": Summary } },
        },
        { by: { header: "x-mode" } },
      ),
    },
  },
);
r.get("/doc", byMode, (_req, res) => {
  res.status(200).set("x-mode", "full"); // the union: either value
  res.status(200).variant("summary").set("x-mode", "summary");
  // @ts-expect-error VT11 the discriminant header holds the variant's own value
  res.status(200).variant("summary").set("x-mode", "full");
  // @ts-expect-error VT12 the discriminant header is one of the variant names
  res.status(200).set("x-mode", "partial");
  // @ts-expect-error VT13 the full body under the summary variant
  return res.status(200).variant("summary").json({ id: "a", items: [] });
});

/* the discriminant's `values`: "1" selects admin, absence selects user */
const byAdminHeader = validate(
  {},
  {
    responses: {
      200: variants(
        {
          admin: { content: { "application/json": AdminView } },
          user: { content: { "application/json": UserView } },
        },
        { by: { header: "x-admin", values: { admin: "1", user: null } } },
      ),
    },
  },
);
r.get("/absent", byAdminHeader, (_req, res) => {
  res.status(200).set("x-admin", "1"); // the union: the admin variant's value
  res.status(200).variant("admin").set("x-admin", "1");
  // @ts-expect-error B1 made a control: the user variant declares x-admin absent (`null`), so set() takes no value
  res.status(200).variant("user").set("x-admin", "1");
  return res.status(200).variant("user").json(userBody);
});
validate(
  {},
  {
    responses: {
      200: variants(
        { admin: { content: { "application/json": AdminView } } },
        // @ts-expect-error VT14 `values` names a variant that is not declared
        { by: { header: "x-admin", values: { root: "1" } } },
      ),
    },
  },
);

/* ---- 4. refine: a whole-response check ---- */
validate(
  {},
  {
    responses: {
      200: variants(
        { full: { content: { "application/json": Full } } },
        // @ts-expect-error VT15 a refine issue names a part responses do not have
        { refine: () => [{ part: "bdy", message: "x" }] },
      ),
    },
  },
);
validate(
  {},
  {
    responses: {
      201: {
        content: { "application/json": Full },
        // Directly in `responses`, an inferred parameter needs `satisfies
        // Refine` (as an inline error handler does): a context-sensitive
        // function there would fix `validate()`'s `RS` to its default.
        refine: ((response) =>
          response.headers["x-total"] === undefined
            ? [{ part: "headers", path: "x-total", message: "missing" }]
            : undefined) satisfies Refine,
      },
    },
  },
);

/* ---- 5. no responses: any name, the type kept; plain ones: not callable ---- */
r.get("/plain", (_req, res) => {
  // VT16 no responses declared (a plain @Res() handler, an untyped res):
  // any name is accepted and the response keeps its plain type, since only
  // the runtime knows the route's variants.
  const same = res.variant("admin");
  type _VT16 = Expect<Equal<typeof same, BunResponse>>;
  return same;
});
r.get("/v3a", validate({}, { responses: { 200: UserView } }), (_req, res) => {
  res.status(200).json(userBody); // V3a's own declarations, unchanged
  // @ts-expect-error VT17 V3a responses without variants: no variant names
  return res.status(200).variant("user");
});

/* ---- 6. the adapter: the same real overloads, the same narrowing ---- */
const adapter = new BunHttpAdapter();
adapter.get("/me", byRole, (_req, res) => {
  res.status(200).variant("admin").set("x-admin", "1");
  return res.status(200).variant("user").json(userBody);
});

/* ---- 7. after .variant(), literal fields are optional (Q-H30) ---- */
const Kinded = z.object({
  kind: z.literal("admin"),
  id: z.string(),
  meta: z.object({ v: z.literal(2), at: z.string() }),
});
const ValibotKinded = v.object({ kind: v.literal("admin"), id: v.string() });
const filled = validate(
  {},
  {
    responses: {
      200: variants({ admin: { content: { "application/json": Kinded } } }),
      201: variants({
        admin: { content: { "application/json": ValibotKinded } },
      }),
    },
  },
);
r.get("/filled", filled, (req, res) => {
  const n = Number(req.query.n);
  if (n === 1) {
    // kind and meta.v filled at runtime
    return res
      .status(200)
      .variant("admin")
      .json({ id: "a", meta: { at: "t" } });
  }
  const noKind = { id: "a", meta: { v: 2 as const, at: "t" } };
  const noId = { meta: { at: "t" } };
  const admin = res.status(200).variant("admin");
  // @ts-expect-error VT19 on the union (no .variant()), nothing is filled: kind is required
  if (n === 2) return res.status(200).json(noKind);
  // @ts-expect-error VT20 a non-literal field is never filled: id is still required
  if (n === 3) return admin.json(noId);
  // @ts-expect-error VT21 valibot carries no ~standard.jsonSchema, so its literal stays required
  if (n === 4) return res.status(201).variant("admin").json({ id: "a" });
  return res.status(201).variant("admin").json({ kind: "admin", id: "a" });
});

/* ---- 8. under commonResponses `when` takes UntypedValid ---- */
export const common = new BunRouter({
  commonResponses: {
    503: variants({
      busy: {
        when: (valid) => {
          type _ = Expect<
            Equal<
              typeof valid,
              Partial<
                Record<
                  | "headers"
                  | "cookies"
                  | "signedCookies"
                  | "params"
                  | "query"
                  | "body",
                  unknown
                >
              >
            >
          >;
          return valid.headers !== undefined;
        },
        content: { "application/json": Problem },
      },
    }),
  },
});
