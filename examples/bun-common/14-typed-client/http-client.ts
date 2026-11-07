/**
 * A typed HTTP client over a `defineRoutes` registry — no generated file, no
 * OpenAPI: `RoutesOf<typeof registry>` is the route map, and
 * `createClient<Routes>()` calls it. Each behaviour is asserted.
 *
 * ```bash
 * bun 14-typed-client/http-client.ts
 * ```
 *
 * - **Routes are the server's own path literals**: `api.get("/users/:id", …)`
 *   is a string a search finds on both sides. `params`, `query` and `body` are
 *   typed from the registry's BunValidate schemas (their *wire* side: what is
 *   sent, not what the handler reads after coercion).
 * - **A result is discriminated by status**: `r.ok` separates the declared 2xx
 *   statuses from the declared errors, and `r.status === 404` narrows `error`
 *   to that status's body. A status the route does not declare throws
 *   `UnexpectedStatusError` only when the client was given a manifest that
 *   lists the declared ones (the generator writes it, see
 *   `generate-client.ts`); here every status is "declared".
 * - **`api.url()` builds a URL and sends nothing.**
 * - **The type-level half**: each `@ts-expect-error` below is a call the
 *   compiler refuses. `bun scripts/typecheck.ts` fails if one starts to
 *   compile — that is the proof, so the lines are never run.
 *
 * The `RoutesOf` map carries the wire types but not the `operationId`s or
 * `x-bun-errors` (they are `.describe()` facts, not types): for `api.op` and
 * an error `code` narrowed to the declared ones, generate the map instead
 * (`generate-client.ts`).
 */
import type { RoutesOf } from "@kingsleyweb/bun-common";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { createClient } from "@kingsleyweb/bun-client";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { createApi } from "./helpers/api";

title("A typed HTTP client over a defineRoutes registry");

const api = createApi();

/** The client's route map, inferred from the registry. */
type Routes = RoutesOf<typeof api.users>;

const adapter = new BunHttpAdapter(0, { logger: noopLogger });
adapter.use(api.users.mount, api.users.router);
const server = await adapter.listen(0);
const client = createClient<Routes>({
  baseUrl: `http://127.0.0.1:${server.port}`,
});

try {
  /* ---------------------------------------------------------------- */
  step("A call, and a result discriminated by status");

  const found = await client.get("/users/:id", { params: { id: "1" } });
  show("GET /users/1", { ok: found.ok, status: found.status });
  checkEqual("a 200 is ok", [found.ok, found.status], [true, 200]);
  if (found.ok) {
    // `data` is the 2xx body: the registry's User, typed.
    checkEqual("data.name is typed and read", found.data.name, "Ada");
  }

  const missing = await client.get("/users/:id", { params: { id: "99" } });
  checkEqual(
    "a declared 404 is a result, not a throw",
    [missing.ok, missing.status],
    [false, 404],
  );
  if (!missing.ok && missing.status === 404) {
    // Narrowed by the status: `error` is the 404's Problem body.
    checkEqual(
      "the 404's body is typed (error.code)",
      missing.error.code,
      "NOT_FOUND",
    );
  }

  /* ---------------------------------------------------------------- */
  step("A query, and a body");

  const listed = await client.get("/users/", { query: { q: "gra" } });
  checkEqual(
    "the query reached the validator",
    listed.ok ? listed.data.map((user) => user.name) : [],
    ["Grace"],
  );

  const created = await client.post("/users/", {
    body: { name: "Linus", email: "linus@example.com" },
  });
  checkEqual("a 201", created.status, 201);
  const clash = await client.post("/users/", {
    body: { name: "Other Ada", email: "ada@example.com" },
  });
  checkEqual("a declared 409", [clash.ok, clash.status], [false, 409]);

  const renamed = await client.patch("/users/:id", {
    params: { id: "1" },
    body: { name: "Ada Lovelace" },
  });
  checkEqual(
    "PATCH with params and a body",
    renamed.ok && renamed.data.name,
    "Ada Lovelace",
  );

  /* ---------------------------------------------------------------- */
  step("api.url() sends nothing");

  const before = api.state.hits.length;
  const url = client.url("/users/:id", { params: { id: "1" } });
  show("url", url);
  check(
    "it is the route's URL, under baseUrl",
    url === `http://127.0.0.1:${server.port}/users/1`,
    url,
  );
  checkEqual("and the server saw no request", api.state.hits.length, before);

  /* ---------------------------------------------------------------- */
  step("The type-level half: calls the compiler refuses");

  /**
   * Never called: every statement here is a compile error that
   * `@ts-expect-error` swallows. If the types ever loosened, the directive
   * would be unused and `bun scripts/typecheck.ts` would fail.
   */
  const refused = async (): Promise<void> => {
    // @ts-expect-error -- a route the registry does not declare
    await client.get("/accounts/:id", { params: { id: "1" } });
    // @ts-expect-error -- params are strings on the wire, not numbers
    await client.get("/users/:id", { params: { id: 1 } });
    // @ts-expect-error -- the body's email is required
    await client.post("/users/", { body: { name: "No email" } });
    // @ts-expect-error -- the body's name is a string
    await client.post("/users/", { body: { name: 7, email: "a@b.co" } });
    // @ts-expect-error -- GET /users/ declares no `page` query
    await client.get("/users/", { query: { page: 2 } });
    const r = await client.get("/users/:id", { params: { id: "1" } });
    // @ts-expect-error -- 418 is not one of GET /users/:id's statuses (200 or 404)
    if (r.status === 418) void r;
  };
  void refused;
  show("six calls refused at compile time (see the source)");
} finally {
  await adapter.close();
}

summary();
