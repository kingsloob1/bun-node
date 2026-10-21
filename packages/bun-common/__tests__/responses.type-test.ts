/**
 * Compile-time checks for typed responses (plan §4.4.4, V3a and V3b), from
 * `evidence/http-complete/types.probe.ts` (N6–N17), plus V3b's body helpers
 * (`chunks()`, `sse()`, `opaque()`, a media type mapped to `null`, and the
 * status-level `opaque(mediaType)`: S1–S14).
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
import { chunks, opaque, sse } from "../lib/responseBodies";

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

/* ---- V3b: streamed bodies, opaque() and a media type mapped to null ---- */
const Tick = z.object({ n: z.number() });
const streams = validate(
  {},
  {
    responses: {
      200: {
        content: {
          "text/event-stream": sse({ tick: Tick, done: null }),
          "application/x-ndjson": chunks(Tick, { framing: "ndjson" }),
        },
      },
      201: { content: { "image/png": opaque() } },
      202: { content: { "text/plain": null } },
      203: { content: { "application/json": chunks(z.string()) } },
    },
  },
);
r.get("/streams", streams, (req, res) => {
  const n = Number(req.query.n);
  /* ---- POSITIVE ---- */
  if (n === 1) return res.status(200).send(new ReadableStream());
  if (n === 2)
    return res.status(200).send(async function* () {
      yield "data: 1\n\n";
    });
  if (n === 3) return res.status(200).send('event: tick\ndata: {"n":1}\n\n'); // one chunk
  if (n === 4) return res.status(201).send(new Blob([]));
  if (n === 5) return res.status(201).send(Response.json({}));
  if (n === 6) return res.status(202).send(null);
  res.status(200).write("data: anything\n\n"); // write() is not typed per chunk
  /* ---- NEGATIVE ---- */
  // @ts-expect-error S1 a plain object where only streams are declared
  if (n === 7) return res.status(200).send({ n: 1 });
  // @ts-expect-error S2 json() where only a stream is declared under a JSON key
  if (n === 8) return res.status(203).json("x");
  // @ts-expect-error S3 a body where the media type is mapped to null
  if (n === 9) return res.status(202).send("x");
  // @ts-expect-error S4 json() on a status whose only media type is opaque image/png
  if (n === 10) return res.status(201).json({ a: 1 });
  // @ts-expect-error S5 an undeclared status beside stream bodies
  return res.status(204).send(new ReadableStream());
});

/* ---- the helpers' own types ---- */
const raw = chunks(z.string());
const rawFraming: "raw" = raw.framing;
const nd = chunks(Tick, { framing: "ndjson" });
const ndFraming: "ndjson" = nd.framing;
const ev = sse({ tick: Tick });
const evData: "json" = ev.data;
const tx = sse({ tick: z.string() }, { data: "text" });
const txData: "text" = tx.data;
const tickSchema: typeof Tick = ev.events.tick;
void [rawFraming, ndFraming, evData, txData, tickSchema];
// @ts-expect-error S6 an unknown framing
chunks(z.string(), { framing: "lines" });
// @ts-expect-error S7 chunks() takes a Standard Schema
chunks("x");
// @ts-expect-error S8 an event must be a Standard Schema or null
sse({ tick: "x" });
// @ts-expect-error S9 an unknown data format
sse({ tick: Tick }, { data: "xml" });
// @ts-expect-error S10 the framing is the declared one, not another
const wrongFraming: "ndjson" = raw.framing;
// @ts-expect-error S11 an undeclared event is not on the declaration
void ev.events.boom;
void wrongFraming;

/* ---- opaque(mediaType): a whole status's spec, the keyed form's twin ---- */
/** Whether two types are the same (not merely mutually assignable). */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const png = opaque("image/png");
const pngType: "image/png" = png.mediaType;
const keyless: undefined = opaque().mediaType;
void [pngType, keyless];
r.get(
  "/opaque",
  validate(
    {},
    {
      responses: {
        200: opaque("image/png"), // = { content: { "image/png": opaque() } }
        201: { content: { "image/png": opaque() } },
        202: opaque("image/*"),
        203: opaque("text/plain; version=0.0.4"),
      },
    },
  ),
  (req, res) => {
    const n = Number(req.query.n);
    /* ---- POSITIVE ---- */
    if (n === 1) return res.status(200).send(new Blob([]));
    if (n === 2) return res.status(200).send(Response.json({}));
    if (n === 3) return res.status(202).send(new Uint8Array([1]));
    if (n === 4) return res.status(203).send("# metrics");
    type Short = ReturnType<typeof res.status<200>>;
    type Keyed = ReturnType<typeof res.status<201>>;
    const sameSend: Equal<
      Parameters<Short["send"]>[0],
      Parameters<Keyed["send"]>[0]
    > = true;
    const sameJson: Equal<
      Parameters<Short["json"]>[0],
      Parameters<Keyed["json"]>[0]
    > = true;
    void [sameSend, sameJson];
    /* ---- NEGATIVE ---- */
    // @ts-expect-error S12 json() on a status declared opaque("image/png"), as on the keyed form (S4)
    if (n === 5) return res.status(200).json({ a: 1 });
    return res.status(201).send(new Blob([]));
  },
);
// @ts-expect-error S13 opaque() takes a media type (type/subtype), not a bare name
opaque("png");
validate(
  {},
  {
    responses: {
      200: {
        content: {
          // @ts-expect-error S14 opaque(mediaType) inside a content map: the key already names the media type
          "image/png": opaque("image/png"),
        },
      },
    },
  },
);
