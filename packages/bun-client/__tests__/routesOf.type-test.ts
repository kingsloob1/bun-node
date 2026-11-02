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
import { defineRoutes, validate } from "@kingsleyweb/bun-common";
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

void inferred;
void views;
