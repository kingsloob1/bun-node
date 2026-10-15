/**
 * Response typing through the generated overloads, against a patched COPY of
 * bun-common (see apply-patch.py and run.sh). Adapted from
 * ../../../api-docs-generation/evidence/responses.ts and boundaries.ts, and
 * extended. Pass condition: `bun --check` exits 0 on the patched copy — every
 * `@ts-expect-error` below must fire, or TS2578 fails the run.
 */
import type { BunResponse } from "../lib/BunResponse";
import type { TypedRouteHandler } from "../lib/types/general";
import { BunRouter } from "../lib/BunRouter";
import { toStandardSchema, validate } from "../lib/BunValidate";
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import { z } from "zod";

interface User { id: string; name: string }
interface Problem { code: string }

const UserS = toStandardSchema<User>((v) => ({ value: v as User }));
const ProblemS = toStandardSchema<Problem>((v) => ({ value: v as Problem }));
const IdParams = toStandardSchema<{ id: string }>((v) => ({ value: v as { id: string } }));
declare const PageQuery: StandardSchemaV1<unknown, { page: number }>;
// A schema whose input differs from its output (z.date() -> string on the wire).
declare const Stamped: StandardSchemaV1<{ at: Date }, { at: Date }>;

const r = new BunRouter();

// ---- 1. POSITIVE: declared responses reach `res`; the request stays narrowed
const v = validate({ params: IdParams }, { responses: { 200: UserS, 404: ProblemS } });
r.get("/u/:id", v, (req, res) => {
  const id: string = req.params.id;
  return res.status(200).json({ id, name: "a" });
});
r.get("/u2/:id", v, (_req, res) => res.status(404).json({ code: "NOPE" }));

// ---- 2. NEGATIVE: wrong body for the chosen status
r.get("/bad1/:id", v, (_req, res) =>
  // @ts-expect-error 200 declares User, not Problem
  res.status(200).json({ code: "NOPE" }),
);
// ---- 3. NEGATIVE: undeclared status
r.get("/bad2/:id", v, (_req, res) =>
  // @ts-expect-error 418 is not a declared status
  res.status(418).json({ id: "x", name: "y" }),
);
// ---- 4. NEGATIVE: json() without status is held to the union
r.get("/bad3/:id", v, (_req, res) =>
  // @ts-expect-error neither declared body
  res.json({ nope: true }),
);

// ---- 5. CONTROLS: nothing declared => unconstrained, as today
const plain = validate({ params: IdParams });
r.get("/free/:id", plain, (_req, res) => res.status(418).json({ anything: 1 }));
r.get("/free2/:id", (_req, res) => res.status(599).json({ anything: 1 }));

// ---- 6. INLINE validator and inline arrow (the common style)
r.get("/inline", validate({ query: PageQuery }, { responses: { 200: UserS } }), (req, res) => {
  const page: number = req.query.page;
  return res.status(200).json({ id: String(page), name: "n" });
});
r.get("/inline-bad", validate({ query: PageQuery }, { responses: { 200: UserS } }), (_req, res) =>
  // @ts-expect-error inline validator: the declared body still constrains
  res.status(200).json({ id: 1 }),
);

// ---- 7. preceding plain handlers (constraint 3: they stay RouterHandler)
r.get(
  "/pre",
  (_req, _res, next) => next(),
  (_req, _res, next) => next(),
  validate({}, { responses: { 201: UserS } }),
  // @ts-expect-error 200 not declared; 201 is
  (_req, res) => res.status(200).json({ id: "1", name: "n" }),
);

// ---- 8. replace: false still declares responses
r.get("/norep", validate({ query: PageQuery }, { replace: false, responses: { 200: UserS } }), (req, res) => {
  // @ts-expect-error replace:false leaves req.query untyped (today's rule)
  const _p: number = req.query.page;
  return res.status(200).json({ id: "1", name: "n" });
});

// ---- 9. the server is held to the schema's INPUT (what the runtime check accepts)
r.get("/stamp", validate({}, { responses: { 200: Stamped } }), (_req, res) => res.status(200).json({ at: new Date() }));
r.get("/stamp-bad", validate({}, { responses: { 200: Stamped } }), (_req, res) =>
  // @ts-expect-error a string is not the schema's input (Date)
  res.status(200).json({ at: "2026-10-15" }),
);

// ---- 10. a body-less status (null)
r.delete("/del/:id", validate({ params: IdParams }, { responses: { 204: null, 404: ProblemS } }), (_req, res) =>
  res.status(204).end(),
);

// ---- 11. mounted sub-router: shape declared on the sub-router, validator at the mount
const sub = new BunRouter<"/users/:uid", { responses: { 200: User } }>();
sub.get("/posts", (_req, res) => res.status(200).json({ id: "1", name: "n" }));
sub.get("/posts2", (_req, res) =>
  // @ts-expect-error mount declared 200: User
  res.status(200).json({ code: "x" }),
);
r.use("/users/:uid", validate({}, { responses: { 200: UserS } }), sub);

// ---- 12. a sub-route's own validator wins over the mount's responses
sub.get("/own", validate({}, { responses: { 202: ProblemS } }), (_req, res) => res.status(202).json({ code: "ok" }));

// ---- 13. existing four-argument TypedRouteHandler uses still compile
const legacy: TypedRouteHandler<{ id: string }, Record<string, unknown>, unknown, unknown> = (_req, res) =>
  res.status(599).json({ any: 1 });
r.get("/legacy/:id", legacy);

// ---- 14. a real library (zod 4): input known, so the input type binds
const ZUser = z.object({ id: z.string(), name: z.string(), joined: z.date() });
r.get("/z", validate({}, { responses: { 200: ZUser } }), (_req, res) =>
  res.status(200).json({ id: "1", name: "n", joined: new Date() }));
r.get("/z-bad", validate({}, { responses: { 200: ZUser } }), (_req, res) =>
  // @ts-expect-error joined must be a Date for the server (the client sees a string)
  res.status(200).json({ id: "1", name: "n", joined: "2026-10-15" }));

// ---- BOUNDARIES (must compile; the documented escape hatches)
const vv = validate({}, { responses: { 200: UserS } });
r.get("/b1", vv, (_req, res) => res.status(200).send("anything at all")); // send() unconstrained
r.get("/b2", vv, (_req, res) => { res.status(200); return res.json({ id: "x", name: "y" }); }); // union only
function helper(res: BunResponse) { return res.json({ literally: "anything" }); }
r.get("/b3", vv, (_req, res) => helper(res)); // a bare BunResponse escapes
r.get("/b4", vv, async (_req, res) => { await Promise.resolve(); return res.status(200).json({ id: "y", name: "z" }); });
r.get("/b5", vv, () => ({ totally: "unchecked" })); // a returned body is ignored by the router
r.get("/b6", vv, (_req, res) => res.status(200).jsonp({ whatever: 1 })); // jsonp unconstrained
r.get("/b7", vv, (_req, res) => res.redirect("/elsewhere"));

export { r };
