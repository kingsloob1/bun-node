/**
 * Type probe of the http-complete design, against a PATCHED copy of
 * bun-common (http-complete.patch; run.sh copies this file into the copy's
 * `spike/`). Pass condition: a bare `bun --check` on the copy exits 0, so
 * every `@ts-expect-error` below fires (TS2578 otherwise). The negative
 * control: run.sh strips every directive into `zz-mutant.ts` and counts the
 * errors, one per directive.
 */
import type { BunResponse } from "../lib/BunResponse";
import type { TypedRouteHandler } from "../lib/types/general";
import { z } from "zod";
import { BunRouter } from "../lib/BunRouter";
import { validate } from "../lib/BunValidate";
import { chunks, opaque, sse } from "../lib/responseContract";

const User = z.object({ id: z.string(), name: z.string() });
const Problem = z.object({ code: z.string() });

const r = new BunRouter();

/* ---- the contract: per status, headers + cookies + body by media type ---- */
const contract = validate(
  {
    headers: z.object({ "x-n": z.coerce.number(), authorization: z.string() }),
    cookies: z.object({ n: z.coerce.number(), theme: z.enum(["dark", "light"]).optional() }),
    signedCookies: z.object({ sid: z.string() }),
  },
  {
    responses: {
      200: {
        headers: z.object({
          "x-ratelimit-remaining": z.string().regex(/^\d+$/),
          "content-type": z.literal("application/json"),
        }),
        cookies: z.object({ sid: z.object({ value: z.string(), httpOnly: z.literal(true) }) }),
        content: { "application/json": User },
      },
      201: { content: { "text/plain": z.string(), "application/octet-stream": z.instanceof(Uint8Array) } },
      204: null,
      302: { headers: z.object({ location: z.string().startsWith("/app") }) },
      404: Problem,
    },
  },
);

r.get("/u/:id", contract, (req, res) => {
  /* ---- POSITIVE: request parts ---- */
  const n: number = req.cookies.n; // cookies target: the schema's output
  const theme: "dark" | "light" | undefined = req.cookies.theme;
  const sid: string = req.signedCookies.sid;
  const xn: number = req.valid.headers["x-n"]; // typed headers: through req.valid
  const auth: string = req.valid.headers.authorization;
  const rawXn: string | string[] = req.headers["x-n"]!; // req.headers stays the raw view
  const cookiesAgain: number = req.valid.cookies.n;
  void [n, theme, sid, xn, auth, rawXn, cookiesAgain];

  /* ---- NEGATIVE: request parts ---- */
  // @ts-expect-error N1 undeclared cookie read
  void req.cookies.nope;
  // @ts-expect-error N2 a declared cookie read as the wrong type (n is a number)
  const _s1: string = req.cookies.n;
  // @ts-expect-error N3 a typed header read as the wrong type (x-n is a number)
  const _s2: string = req.valid.headers["x-n"];
  // @ts-expect-error N4 a header the schema does not declare, on the typed view
  void req.valid.headers["x-other"];
  // @ts-expect-error N5 an undeclared signed cookie
  void req.signedCookies.other;

  /* ---- POSITIVE: responses ---- */
  res.set("X-RateLimit-Remaining", "9"); // declared, any case
  res.set("x-ratelimit-remaining", "9");
  res.set("Content-Type", "application/json");
  res.set("X-Request-Id", "anything"); // undeclared names take any header value
  res.header("X-RateLimit-Remaining", "8");
  res.cookie("sid", "abc", { httpOnly: true });
  res.cookie("other", { any: "value" }); // undeclared cookies: any cookie value
  if (n === 1) return res.status(201).send("created");
  if (n === 2) return res.status(201).send(new Uint8Array([1]));
  if (n === 3) return res.status(404).json({ code: "NOPE" });
  if (n === 4) return res.redirect(302, "/app/home");
  if (n === 5) return res.redirect("/app/home"); // 302 is declared
  if (n === 6) return res.status(204).send(null);
  if (n === 7) return res.send(Response.json({ id: "a", name: "b" })); // a native Response is always accepted (checked at runtime)

  /* ---- NEGATIVE: responses ---- */
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
  return res.status(200).json({ id: "a", name: "b" });
});

/* ---- redirect(url) needs 302 declared ---- */
r.get("/r", validate({}, { responses: { 301: null, 303: null } }), (_req, res) => {
  res.redirect(303, "/a");
  // @ts-expect-error N16 redirect(url) sends 302, which is not declared
  return res.redirect("/a");
});

/* ---- streams and SSE declare their media type; send() takes a stream there ---- */
r.get("/s", validate({}, { responses: { 200: { content: { "text/event-stream": sse({ tick: z.object({ n: z.number() }) }), "image/png": opaque() } } } }), (_req, res) => {
  res.status(200).send(new ReadableStream());
  res.status(200).send(new Blob([]));
  // @ts-expect-error N17 a plain object where only a stream and an image are declared
  return res.status(200).send({ tick: 1 });
});
r.get("/c", validate({}, { responses: { 200: { content: { "text/plain": chunks(z.string().max(5)) } } } }), (_req, res) => res.send("abc"));

/* ---- no validator: req.valid is empty; everything else as today ---- */
r.get("/plain", (req, res) => {
  // @ts-expect-error N18 nothing validated, so req.valid has no headers
  void req.valid.headers;
  const anyCookie = req.cookies.whatever; // JsonValue, as today
  void anyCookie;
  res.set("X-Anything", "1");
  return res.status(599).json({ anything: 1 });
});

/* ---- boundaries that must compile ---- */
function helper(res: BunResponse) {
  return res.status(500).json({ escaped: true }); // a bare BunResponse is unconstrained
}
r.get("/b", validate({}, { responses: { 200: User } }), (_req, res) => helper(res));
const legacy: TypedRouteHandler<{ id: string }, { page: number }> = (req, res) => res.json({ id: req.params.id, page: req.query.page });
const pageQuery = validate({ query: z.object({ page: z.coerce.number() }) });
r.get("/legacy/:id", pageQuery, legacy);
// L1, a pinned LIMIT (not a control): an inline validator followed by a
// handler declared as TypedRouteHandler still loses TShape. The patch lifts
// it for a ResolvedHandler-typed one (verbTyping.type-test.ts), not this one.
// @ts-expect-error L1 inline validator + a TypedRouteHandler-typed handler
r.get("/legacy2/:id", validate({ query: z.object({ page: z.coerce.number() }) }), legacy);
