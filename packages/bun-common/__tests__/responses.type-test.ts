/**
 * Compile-time checks for typed responses (plan §4.4.4, V3a), from
 * `evidence/http-complete/types.probe.ts` (N6–N16, without V3b's streams).
 * Checked by `bun run check` (a `*.type-test.ts` is never run by
 * `bun test`). Each directive below must fire on the line under it, and
 * only there: a run with every directive stripped gives exactly one error
 * per directive, each on its own line (recorded with the V3a gate).
 */
import type { BunResponse } from "../lib/BunResponse";
import type { TypedRouteHandler } from "../lib/types/general";
import { z } from "zod";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { validate } from "../lib/BunValidate";

const User = z.object({ id: z.string(), name: z.string() });
const Problem = z.object({ code: z.string() });

const r = new BunRouter();

const contract = validate(
  {},
  {
    responses: {
      200: {
        headers: z.object({
          "x-ratelimit-remaining": z.string().regex(/^\d+$/),
          "content-type": z.literal("application/json"),
        }),
        cookies: z.object({
          sid: z.object({ value: z.string(), httpOnly: z.literal(true) }),
        }),
        content: { "application/json": User },
      },
      201: {
        content: {
          "text/plain": z.string(),
          "application/octet-stream": z.instanceof(Uint8Array),
        },
      },
      204: null,
      302: { headers: z.object({ location: z.string().startsWith("/app") }) },
      404: Problem,
    },
    responseValidation: "error",
  },
);

r.get("/u/:id", contract, (req, res) => {
  const n = Number(req.params.id);

  /* ---- POSITIVE ---- */
  res.set("X-RateLimit-Remaining", "9"); // declared, any case
  res.set("x-ratelimit-remaining", "9");
  res.set("Content-Type", "application/json");
  res.set("X-Request-Id", "anything"); // an undeclared name takes any value
  res.header("X-RateLimit-Remaining", "8");
  res.cookie("sid", "abc", { httpOnly: true });
  res.cookie("other", { any: "value" }); // an undeclared cookie: any value
  if (n === 1) return res.status(201).send("created");
  if (n === 2) return res.status(201).send(new Uint8Array([1]));
  if (n === 3) return res.status(404).json({ code: "NOPE" });
  if (n === 4) return res.redirect(302, "/app/home");
  if (n === 5) return res.redirect("/app/home"); // 302 is declared
  if (n === 6) return res.status(204).send(null);
  // A native Response is always accepted (checked at runtime).
  if (n === 7) return res.send(Response.json({ id: "a", name: "b" }));

  /* ---- NEGATIVE ---- */
  // @ts-expect-error N6 wrong body for a status (200 declares User)
  if (n === 8) return res.status(200).json({ code: "NOPE" });
  // @ts-expect-error N7 undeclared status
  if (n === 9) return res.status(418).json({ id: "a", name: "b" });
  // @ts-expect-error N8 text sent where only JSON is declared (200)
  if (n === 10) return res.status(200).send("hi");
  // @ts-expect-error N9 a wrong header value type (declared string, given number)
  res.set("X-RateLimit-Remaining", 5);
  // @ts-expect-error N10 a header value outside its declared literal
  res.set("content-type", "text/html");
  // @ts-expect-error N11 redirect to an undeclared 3xx
  if (n === 11) return res.redirect(301, "/app");
  // @ts-expect-error N12 json() on a status that declares only text and bytes
  if (n === 12) return res.status(201).json({ id: "a", name: "b" });
  // @ts-expect-error N13 bytes sent where only JSON is declared (200)
  if (n === 13) return res.status(200).send(new Uint8Array([1]));
  // @ts-expect-error N14 a body on a status declared body-less (204: null)
  if (n === 14) return res.status(204).json({});
  // @ts-expect-error N15 a declared Set-Cookie given the wrong value type
  res.cookie("sid", 5);
  // @ts-expect-error N19 header() is held like set()
  res.header("x-ratelimit-remaining", 5);
  return res.status(200).json({ id: "a", name: "b" });
});

/* ---- redirect(url) needs 302 declared ---- */
r.get(
  "/r",
  validate({}, { responses: { 301: null, 303: null } }),
  (_req, res) => {
    res.redirect(303, "/a");
    // @ts-expect-error N16 redirect(url) sends 302, which is not declared
    return res.redirect("/a");
  },
);

/* ---- the server is held to the wire input, field by field (M1) ---- */
r.get(
  "/wire",
  validate(
    {},
    {
      responses: {
        200: z.object({
          at: z.date(),
          n: z.coerce.number(),
          q: z.string().default(""),
        }),
      },
    },
  ),
  (_req, res) => {
    res.json({ at: new Date(), n: 1 }); // `q` is optional on the wire
    // @ts-expect-error N20 a z.date() field takes a Date, not its JSON string
    res.json({ at: "2026-10-21", n: 1 });
    // @ts-expect-error N21 a coerced field takes its output (number), not any string
    return res.json({ at: new Date(), n: "1" });
  },
);

/* ---- wildcard and parameterised media keys ---- */
r.get(
  "/media",
  validate(
    {},
    {
      responses: {
        200: {
          content: {
            "text/*": z.string(),
            "text/plain; version=0.0.4": z.string().startsWith("#"),
          },
        },
        201: { content: { "*/*": User } },
      },
    },
  ),
  (_req, res) => {
    res.status(200).send("# metrics");
    res.status(201).json({ id: "a", name: "b" }); // json() falls under */*
    // @ts-expect-error N22 only text is declared for 200
    return res.status(200).json({ id: "a", name: "b" });
  },
);

/* ---- no validator: everything as today ---- */
r.get("/plain", (_req, res) => {
  res.set("X-Anything", "1");
  res.cookie("any", { x: 1 });
  return res.status(599).json({ anything: 1 });
});

/* ---- boundaries that must compile ---- */
function helper(res: BunResponse) {
  return res.status(500).json({ escaped: true }); // a bare BunResponse is unconstrained
}
r.get("/b", validate({}, { responses: { 200: User } }), (_req, res) =>
  helper(res),
);
const legacy: TypedRouteHandler<{ id: string }, { page: number }> = (
  req,
  res,
) => res.json({ id: req.params.id, page: req.query.page });
const pageQuery = validate({ query: z.object({ page: z.coerce.number() }) });
r.get("/legacy/:id", pageQuery, legacy);

/* ---- a request shape and responses together, through the adapter ---- */
const adapter = new BunHttpAdapter(0, { responseValidation: "warn" });
adapter.post(
  "/users",
  validate(
    { body: z.object({ name: z.string() }) },
    { responses: { 201: User, 409: Problem } },
  ),
  (req, res) => {
    const name: string = req.body.name;
    if (name === "taken") return res.status(409).json({ code: "TAKEN" });
    // @ts-expect-error N23 the adapter's verbs hold res too
    return res.status(201).json({ id: 1, name });
  },
);
