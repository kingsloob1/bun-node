/* eslint-disable prettier/prettier -- the controls are tied to lines */
/**
 * Type probe for response variants (plan §4.4.6, V3c), against the REAL V3a
 * types: bun-common's `BunRouter` and its generated overloads,
 * `MountedHandler`, `ResolveResponses`, `BunResponse`'s `status()`
 * (`AllowedStatus`/`NarrowResponses`), `json()`/`send()`/`set()`/`cookie()`,
 * and bun-nest's `BunHttpAdapter` overloads. `.variant()` is added to the
 * real `BunResponse` by module augmentation below: no lib file changes.
 *
 * Each `@ts-expect-error` (VT1–VT21) guards the line under it; `check-types.sh`
 * strips them and requires an error on exactly those lines and nowhere else.
 * B1–B3 are boundaries that compile, by design or until V3c changes a lib type.
 */
import type { BunResponse as RealBunResponse } from "../../../../../packages/bun-common/lib/BunResponse";
import type { NarrowVariant, VariantNames } from "./variants";
import * as v from "valibot";
import { z } from "zod";
import { BunRouter } from "../../../../../packages/bun-common/lib/BunRouter";
import { validate } from "../../../../../packages/bun-common/lib/BunValidate";
import { BunHttpAdapter as NestAdapter } from "../../../../../packages/bun-nest/lib/BunHttpAdapter";
import { validateV, variants } from "./variants";

declare module "../../../../../packages/bun-common/lib/BunResponse" {
  // Declaration-merges with the class: the type parameters must be the class's own.
  interface BunResponse<customWebsocketDataType, TResponses> {
    /** Narrows `res` to one variant of the status set; recorded for the gate (V3c). */
    variant: <const N extends VariantNames<TResponses>>(
      name: N,
    ) => RealBunResponse<customWebsocketDataType, NarrowVariant<TResponses, N>>;
  }
}

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const AdminView = z.object({ id: z.string(), role: z.literal("admin"), salary: z.number() });
const UserView = z.object({ id: z.string(), role: z.literal("user") });
const Problem = z.object({ code: z.string() });
const adminBody = { id: "a", role: "admin" as const, salary: 1 };
const userBody = { id: "a", role: "user" as const };

const r = new BunRouter();

/* ---- 1. variants by request: `when` typed by the validator ---- */
const byRole = validateV(
  { headers: z.object({ "x-admin": z.literal("1").optional() }), cookies: z.object({ sid: z.string().optional() }) },
  {
    responses: {
      200: variants({
        admin: {
          when: (valid) => {
            type _ = Expect<Equal<typeof valid, { headers: { "x-admin"?: "1" }; cookies: { sid?: string } }>>;
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
  type _v = Expect<Equal<typeof req.valid, { headers: { "x-admin"?: "1" }; cookies: { sid?: string } }>>;
  const n = Number(req.query.n);
  /* POSITIVE: the union without .variant(), as V3a types any status today */
  if (n === 1) return res.status(200).json(adminBody);
  if (n === 2) return res.status(200).json(userBody);
  res.status(200).set("x-admin", "1"); // declared by one variant: allowed on the union
  /* POSITIVE: narrowed */
  if (n === 3) return res.status(200).variant("admin").set("x-admin", "1").json(adminBody);
  if (n === 4) return res.status(200).variant("user").json(userBody);
  if (n === 5) return res.status(404).json({ code: "NOPE" });
  /* NEGATIVE */
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
  /* BOUNDARY B1: a header only the admin variant declares, set under the user
     variant, compiles: undeclared names take any value (V3a's HeaderArg). The
     gate refuses it at runtime when the user variant's headers schema forbids
     it, or a discriminant maps the header's absence to the user variant. */
  res.status(200).variant("user").set("x-admin", "1");
  /* BOUNDARY B2: a structural superset passes json()'s generic constraint (no
     excess-property check on a type parameter, as in V3a): the admin body
     minus its literal role would type as a user body. */
  if (n === 11) return res.status(200).variant("user").json({ id: "a", role: "user", salary: 1 });
  return res.status(200).variant("user").json(userBody);
});

/* ---- 2. `when` sees only what the validator parsed ---- */
validateV(
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
validateV(
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
validateV(
  {},
  {
    responses: {
      200: variants({
        admin: {
          when: async () => true, // allowed (Q-H17): awaited, holding the commit; a boolean is decided in place
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
validateV(
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
const byMode = validateV(
  {},
  {
    responses: {
      200: variants(
        { full: { content: { "application/json": Full } }, summary: { content: { "application/json": Summary } } },
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

/* the discriminant's `values`: header x-admin "1" selects admin; its absence selects user */
validateV(
  {},
  {
    responses: {
      200: variants(
        { admin: { content: { "application/json": AdminView } }, user: { content: { "application/json": UserView } } },
        { by: { header: "x-admin", values: { admin: "1", user: null } } },
      ),
    },
  },
);
validateV(
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
validateV(
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

/* ---- 5. no responses, or plain ones: .variant() is not callable ---- */
r.get("/plain", (_req, res) => {
  // @ts-expect-error VT16 no responses declared: no variant names
  return res.variant("admin");
});
r.get("/v3a", validate({}, { responses: { 200: UserView } }), (_req, res) => {
  res.status(200).json(userBody); // V3a's own declarations, unchanged
  // @ts-expect-error VT17 V3a responses without variants: no variant names
  return res.status(200).variant("user");
});

/* ---- 6. bun-nest's adapter: the same real overloads, the same narrowing ---- */
const adapter = new NestAdapter(0);
adapter.get("/me", byRole, (_req, res) => {
  res.status(200).variant("admin").set("x-admin", "1");
  return res.status(200).variant("user").json(userBody);
});

/* ---- 6b. after .variant(), literal fields are optional (Q-H18: the runtime fills them) ---- */
const Kinded = z.object({ kind: z.literal("admin"), id: z.string(), meta: z.object({ v: z.literal(2), at: z.string() }) });
const ValibotKinded = v.object({ kind: v.literal("admin"), id: v.string() });
const filled = validateV(
  {},
  {
    responses: {
      200: variants({ admin: { content: { "application/json": Kinded } } }),
      201: variants({ admin: { content: { "application/json": ValibotKinded } } }),
    },
  },
);
r.get("/filled", filled, (req, res) => {
  const n = Number(req.query.n);
  if (n === 1) return res.status(200).variant("admin").json({ id: "a", meta: { at: "t" } }); // kind and meta.v filled
  // @ts-expect-error VT19 on the union (no .variant()), nothing is filled: kind is required
  if (n === 2) return res.status(200).json({ id: "a", meta: { v: 2, at: "t" } });
  // @ts-expect-error VT20 a non-literal field is never filled: id is still required
  if (n === 3) return res.status(200).variant("admin").json({ meta: { at: "t" } });
  // @ts-expect-error VT21 valibot carries no ~standard.jsonSchema, so its literal cannot be filled and stays required
  if (n === 4) return res.status(201).variant("admin").json({ id: "a" });
  return res.status(201).variant("admin").json({ kind: "admin", id: "a" });
});

/* ---- 7. what V3c changes in V3a's HeaderArg, for B1 (types only) ---- */
declare const _ABSENT: unique symbol;
/** A header a variant declares absent (a discriminant's `null`, or `z.undefined()`). */
type Absent = typeof _ABSENT;
/** V3a's rule, plus: a header declared absent takes no value. */
type HeaderArgV3c<D> = [D] extends [never] ? string | string[] : [D] extends [Absent] ? never : Extract<D, string | string[]>;
type _absent = Expect<Equal<HeaderArgV3c<Absent>, never>>;
type _undeclared = Expect<Equal<HeaderArgV3c<never>, string | string[]>>;
type _literal = Expect<Equal<HeaderArgV3c<"1">, "1">>;

/* B3: a mount's `when` is typed by its own validator alone; at runtime req.valid holds both layers' parts. */
export {};
