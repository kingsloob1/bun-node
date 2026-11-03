/**
 * Compile-time assertions for `RoutesOf`'s client views (typed-client plan
 * §4.1, §8.5, PR-M1): `send`, what a sender is held to (each part's
 * `WireInput`), and `receive`, what a receiver gets (each declared body's
 * `Jsonify` of its wire input, or of its output under `responseOutput:
 * "parsed"`). Checked by `bun run check` (`bun check`), never by `bun test`.
 * Every `@ts-expect-error` is a negative control: if the error stops
 * appearing, the check fails on the unused directive.
 */
import { z } from "zod";
import type { RoutesOf } from "../lib/defineRoutes";
import { validate } from "../lib/BunValidate";
import { defineRoutes } from "../lib/defineRoutes";
import { chunks, opaque, sse, variants } from "../lib/responseBodies";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const IdParams = z.object({ id: z.coerce.number() });
const PageQuery = z.object({
  page: z.coerce.number(),
  q: z.string().default(""),
});
const Tenant = z.object({ "x-tenant": z.string() });
const NewUser = z.object({
  name: z.string().transform((name) => name.length),
  born: z.date(),
});
const User = z.object({
  id: z.string(),
  born: z.date(),
  nick: z.string().default("anon"),
});
const Problem = z.object({ code: z.literal("NOT_FOUND"), title: z.string() });

const users = defineRoutes("/users", (r) => ({
  getUser: r.get(
    "/:id",
    validate(
      { params: IdParams, query: PageQuery, headers: Tenant },
      { responses: { 200: User, 204: null, 404: Problem } },
    ),
    (req, res) => {
      // The handler's view is the parsed one: id is a number here.
      type _id = Expect<Equal<typeof req.params.id, number>>;
      res.status(200).json({ id: "u", born: new Date() });
    },
  ),
  createUser: r.post(
    "/",
    validate(
      { body: NewUser },
      { responses: { 201: User }, responseOutput: "parsed" },
    ),
    (_req, res) => {
      res.status(201).json({ id: "u", born: new Date(), nick: "n" });
    },
  ),
  hooked: r.patch(
    "/:id",
    validate(
      { body: z.object({ n: z.string() }) },
      { hooks: { body: { transform: (body) => ({ len: body.n.length }) } } },
    ),
    (req, res) => {
      // The hook decides the handler's body, not the sender's.
      type _b = Expect<Equal<typeof req.body, { len: number }>>;
      res.json({});
    },
  ),
  variant: r.put(
    "/:id",
    validate(
      { params: z.object({ id: z.string() }) },
      {
        responses: {
          200: variants({
            full: { content: { "application/json": User } },
            short: { content: { "text/plain": z.string() } },
          }),
        },
      },
    ),
    (_req, res) => {
      res.status(200).variant("short").send("ok");
    },
  ),
  bodies: r.get(
    "/bodies",
    validate(
      {},
      {
        responses: {
          200: {
            content: {
              "application/x-ndjson": chunks(User, { framing: "ndjson" }),
            },
          },
          201: {
            content: { "application/octet-stream": chunks(z.any()) },
          },
          202: opaque("application/pdf"),
          203: { content: { "text/csv": opaque() } },
          205: opaque(),
          206: { content: { "image/png": z.any() } },
          207: { content: { "text/event-stream": sse({ tick: User }) } },
        },
      },
    ),
    (_req, res) => {
      res.status(202).send(new Blob(["%PDF"]));
    },
  ),
  ping: r.get("/ping/:who", (_req, res) => {
    res.send("pong");
  }),
}));

type Api = RoutesOf<typeof users>;
type Get = Api["GET /users/:id"];
type Create = Api["POST /users/"];
type Hooked = Api["PATCH /users/:id"];
type Variant = Api["PUT /users/:id"];
type Ping = Api["GET /users/ping/:who"];
type Bodies = Api["GET /users/bodies"];

/* --- send: the wire input ------------------------------------------- */

// A coerced param: the server parses a number, a sender sends the coercion's
// output type (its input is `unknown`), and the old fields keep the parsed view.
type _paramsSend = Expect<Equal<Get["send"]["params"], { id: number }>>;
type _paramsParsed = Expect<Equal<Get["params"], { id: number }>>;

// A defaulted query key is optional for the sender and required once parsed.
type _querySend = Expect<
  Equal<Get["send"]["query"], { page: number; q?: string | undefined }>
>;
type _queryParsed = Expect<Equal<Get["query"], { page: number; q: string }>>;

// Headers are part of the send view.
type _headersSend = Expect<
  Equal<Get["send"]["headers"], { "x-tenant": string }>
>;

// A transform: the sender sends the input (a string), the handler reads the
// output (a number); a `z.date()` is sent as a `Date` (the client serialises).
type _bodySend = Expect<
  Equal<Create["send"]["body"], { name: string; born: Date }>
>;
type _bodyParsed = Expect<Equal<Create["body"]["name"], number>>;

// A transform hook changes the handler's view only.
type _hookedSend = Expect<Equal<Hooked["send"]["body"], { n: string }>>;
type _hookedParsed = Expect<Equal<Hooked["body"], { len: number }>>;

// No schema: the path's captures, no query, no headers, no body.
type _pingSend = Expect<
  Equal<
    Ping["send"],
    {
      params: { who: string };
      query: Record<never, never>;
      headers: Record<never, never>;
      body: undefined;
    }
  >
>;

/* --- send: the negative controls ------------------------------------ */

declare function send<K extends keyof Api>(key: K, part: Api[K]["send"]): void;

// The 2026-10-10 control (plan §8.5): a string where the coercion's output
// is a number.
send("GET /users/:id", {
  params: { id: 1 },
  // @ts-expect-error page is a number for the sender, not a string
  query: { page: "x" },
  headers: { "x-tenant": "t" },
  body: undefined,
});
send("GET /users/:id", {
  // @ts-expect-error a param the route does not declare
  params: { id: 1, slug: "s" },
  query: { page: 1 },
  headers: { "x-tenant": "t" },
  body: undefined,
});
send("GET /users/:id", {
  // @ts-expect-error the param's wire type is a number (coerced), not a string
  params: { id: "1" },
  query: { page: 1 },
  headers: { "x-tenant": "t" },
  body: undefined,
});
send("POST /users/", {
  params: {},
  query: {},
  headers: {},
  // @ts-expect-error the transform's output (a number) is not what crosses the wire
  body: { name: 4, born: new Date() },
});
// The positive controls: the same calls, right.
send("GET /users/:id", {
  params: { id: 1 },
  query: { page: 2 },
  headers: { "x-tenant": "t" },
  body: undefined,
});
send("POST /users/", {
  params: {},
  query: {},
  headers: {},
  body: { name: "Ada", born: new Date() },
});

/* --- receive: the JSON a client parses ------------------------------ */

// As sent (the default): the wire input after JSON — a Date arrives a string,
// a defaulted field is as optional as the handler was allowed to leave it.
type _receive200 = Expect<
  Equal<
    Get["receive"][200],
    { id: string; born: string; nick?: string | undefined }
  >
>;
type _receive204 = Expect<Equal<Get["receive"][204], undefined>>;
type _receive404 = Expect<
  Equal<Get["receive"][404], { code: "NOT_FOUND"; title: string }>
>;
type _receiveStatuses = Expect<Equal<keyof Get["receive"], 200 | 204 | 404>>;

// `responseOutput: "parsed"` on the validator: the output after JSON, so the
// defaulted field is present.
type _receiveParsed = Expect<
  Equal<Create["receive"][201], { id: string; born: string; nick: string }>
>;

// Variants: the union of their bodies, per media class.
type _receiveVariants = Expect<
  Equal<
    Variant["receive"][200],
    { id: string; born: string; nick?: string | undefined } | string
  >
>;

// Nothing declared: `{ 200: unknown }`, like the server's view.
type _receiveUndeclared = Expect<Equal<Ping["receive"], { 200: unknown }>>;
type _receiveHooked = Expect<Equal<Hooked["receive"], { 200: unknown }>>;

// Streams and downloads (typed-client plan, other-transports.md §4): an
// NDJSON stream is one JSON value per line; a raw one its bytes; a byte
// media type a Blob (opaque or not); opaque text a string; opaque under a
// JSON key unknown (never read); an event stream unknown (PR-S1's).
type _receiveNdjson = Expect<
  Equal<
    Bodies["receive"][200],
    AsyncIterable<{ id: string; born: string; nick?: string | undefined }>
  >
>;
type _receiveRaw = Expect<
  Equal<Bodies["receive"][201], AsyncIterable<Uint8Array>>
>;
type _receivePdf = Expect<Equal<Bodies["receive"][202], Blob>>;
type _receiveCsv = Expect<Equal<Bodies["receive"][203], string>>;
type _receiveOpaqueJson = Expect<Equal<Bodies["receive"][205], unknown>>;
type _receivePng = Expect<Equal<Bodies["receive"][206], Blob>>;
type _receiveSse = Expect<Equal<Bodies["receive"][207], unknown>>;
type NdjsonIsValue = Equal<Bodies["receive"][200], Get["receive"][200]>;
// @ts-expect-error a negative control: an NDJSON stream is not its line's value
type _receiveNdjsonNotValue = Expect<NdjsonIsValue>;
type RawIsText = Equal<Bodies["receive"][201], AsyncIterable<string>>;
// @ts-expect-error a negative control: a raw stream yields bytes, not strings
type _receiveRawNotText = Expect<RawIsText>;

// @ts-expect-error a status the route does not declare
type _receiveUnknownStatus = Get["receive"][500];

// Exported on purpose: declaration emit must be able to name a registry's
// type, as a consumer's `export const api = defineRoutes(…)` needs (an
// unexported interface in the `__schemas` phantom failed here with TS4023).
export const _registry = users;
