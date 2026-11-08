/**
 * The other C1 type source: a map inferred with bun-common's `RoutesOf` from
 * a `defineRoutes` registry (plan §3.4's opt-in, §8.5), read by the client
 * as it is. And the receiver/sender views PR-M1 adds to `RoutesOf` (§8.5),
 * read in preference when present.
 *
 * `RoutesOf` carries the validator's **parsed** shapes for params, query and
 * body, and each response as a handler spec whose `json` is the wire body;
 * since PR-M1 each entry also carries the `send` and `receive` views, which
 * the client reads instead. Case 4 shows the gap §2.2 named, now closed.
 *
 * Each `@ts-expect-error` is a negative control. Checked by `bun run check`.
 */
import type { Client, Jsonify, Result } from "../lib/index";
import type { RoutesOf } from "@kingsleyweb/bun-common";
import {
  defineRoutes,
  sse as declareSse,
  validate,
} from "@kingsleyweb/bun-common";
import { sse } from "../lib/sse";
import { z } from "zod";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const User = z.object({ id: z.string(), name: z.string() });
const Problem = z.object({ title: z.string(), code: z.literal("NOT_FOUND") });
const Page = z.object({ page: z.coerce.number().default(1) });

export const users = defineRoutes("/users", (r) => ({
  getUser: r.get(
    "/:id",
    validate(
      { params: z.object({ id: z.string() }), query: Page },
      { responses: { 200: User, 404: Problem } },
    ),
    (req, res) => res.status(200).json({ id: req.params.id, name: "Ada" }),
  ),
  createUser: r.post(
    "/",
    validate(
      { body: z.object({ name: z.string() }) },
      { responses: { 201: User } },
    ),
    (req, res) => res.status(201).json({ id: "1", name: req.body.name }),
  ),
}));

type Api = RoutesOf<typeof users>;
declare const api: Client<Api>;

async function inferred() {
  // 1. Keys and params come from the registry (the query: case 4).
  const r = await api.get("/users/:id", {
    params: { id: "1" },
    query: { page: 1 },
  });
  // @ts-expect-error -- wrong params, from the validator's schema
  void api.get("/users/:id", { params: { id: 1 }, query: { page: 1 } });
  // @ts-expect-error -- unknown route
  void api.get("/users");

  // 2. Responses: the handler spec's `json`, by status, narrowed as usual.
  type _r = Expect<Equal<typeof r, Result<Api["GET /users/:id"]>>>;
  if (r.ok) {
    type _data = Expect<Equal<typeof r.data, { id: string; name: string }>>;
  } else {
    type _code = Expect<Equal<typeof r.error.code, "NOT_FOUND">>;
  }

  // 3. The body, required and checked.
  void api.post("/users/", { body: { name: "a" } });
  // @ts-expect-error -- wrong body
  void api.post("/users/", { body: { name: 1 } });

  // 4. The parsed-shape gap (§2.2), closed by PR-M1's `send` view: the
  // defaulted `page` is optional for the sender, and its wire type is the
  // coercion's output (a number), so a string is still refused.
  void api.get("/users/:id", { params: { id: "1" }, query: {} });
  void api.get("/users/:id", { params: { id: "1" }, query: { page: 2 } });
  // @ts-expect-error -- the send view: `page` is a number on the wire, not a string
  void api.get("/users/:id", { params: { id: "1" }, query: { page: "x" } });
}

// 5. The PR-M1 views, when an entry has them, win over the parsed fields.
interface WithViews {
  "GET /things/:id": {
    params: { id: number };
    query: { page: number };
    responses: {
      200: {
        json: { wrong: true };
        send: unknown;
        headers: unknown;
        cookies: unknown;
      };
    };
    send: { params: { id: string }; query: { page?: string | number } };
    receive: { 200: { id: string; at: Date } };
  };
}
declare const viewed: Client<WithViews>;
async function views() {
  const r = await viewed.get("/things/:id", { params: { id: "1" }, query: {} });
  if (r.ok) {
    type _data = Expect<
      Equal<typeof r.data, Jsonify<{ id: string; at: Date }>>
    >;
  }
  // @ts-expect-error -- the send view's params are strings, not the parsed number
  void viewed.get("/things/:id", { params: { id: 1 } });
}

// 6. A coerced header (`z.coerce.number()`, `z.coerce.boolean()`) is its
// output on the wire's send view, a number or a boolean; the call takes it,
// and the client sends its string.
export const tenants = defineRoutes("/tenants", (r) => ({
  list: r.get(
    "/",
    validate(
      {
        headers: z.object({
          "x-limit": z.coerce.number(),
          "x-dry-run": z.coerce.boolean().optional(),
          "x-tenant": z.string(),
        }),
      },
      { responses: { 200: z.array(z.string()) } },
    ),
    (_req, res) => res.status(200).json([]),
  ),
}));
declare const tenantApi: Client<RoutesOf<typeof tenants>>;
async function coercedHeaders() {
  type Sent = RoutesOf<typeof tenants>["GET /tenants/"]["send"]["headers"];
  type _limit = Expect<Equal<Sent["x-limit"], number>>;
  void tenantApi.get("/tenants/", {
    headers: { "x-limit": 10, "x-dry-run": true, "x-tenant": "t" },
  });
  // @ts-expect-error -- the wire type is the coercion's output, a number
  void tenantApi.get("/tenants/", { headers: { "x-limit": "10" } });
  // @ts-expect-error -- a string header stays a string
  void tenantApi.get("/tenants/", { headers: { "x-tenant": 1 } });
}

// 7. An event stream: `RoutesOf` marks it `stream: "sse"` with its events,
// so `sse()` reads it typed, and the verbs do not offer it.
export const feeds = defineRoutes("/feeds", (r) => ({
  ticks: r.get(
    "/:id",
    validate(
      { params: z.object({ id: z.string() }) },
      {
        responses: {
          200: declareSse({
            tick: z.object({ n: z.number() }),
            gap: null,
          }),
        },
      },
    ),
    (_req, res) => res.status(200).send(""),
  ),
}));
declare const feedApi: Client<RoutesOf<typeof feeds>>;
async function eventStreams() {
  const stream = sse(feedApi, "GET /feeds/:id", { params: { id: "1" } });
  for await (const event of stream) {
    if (event.event === "tick") {
      type _tick = Expect<Equal<typeof event.data, { n: number }>>;
    } else {
      type _gap = Expect<Equal<typeof event.data, undefined>>;
    }
  }
  stream.on("$gap", (_data) => {
    type _gapData = Expect<Equal<typeof _data, undefined>>;
  });
  // @ts-expect-error -- no such event
  stream.on("tock", () => {});
  // @ts-expect-error -- an event stream is read with sse(), not a verb
  void feedApi.get("/feeds/:id", { params: { id: "1" } });
  // @ts-expect-error -- and its params are the validator's
  void sse(feedApi, "GET /feeds/:id", { params: { id: 1 } });
}

void inferred;
void views;
void coercedHeaders;
void eventStreams;
