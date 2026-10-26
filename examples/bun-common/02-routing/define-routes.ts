/**
 * Declaring routes as data — `defineRoutes()` registers a group of named
 * routes on its own router and mounts as an ordinary sub-router.
 *
 * ```bash
 * bun 02-routing/define-routes.ts
 * ```
 *
 * - The builder's verbs mirror the router's — `r.get(path, [validator],
 *   handler)` — and type the handler exactly as a direct call would.
 * - Each property name becomes the route's `operationId`, with no
 *   `.describe()` annotation; a route registered without the registry keeps
 *   the generator's derived one.
 * - `RoutesOf<typeof registry>` is a pure type: the flat route map a typed
 *   client is built over. The registry exists *for* inference — generation
 *   (`generateOpenApi` over statement-style routes) remains the default.
 */
import type { RoutesOf } from "@kingsleyweb/bun-common";
import { BunRouter, defineRoutes, validate } from "@kingsleyweb/bun-common";
import { generateOpenApi } from "@kingsleyweb/bun-common/lib/docs";
import { z } from "zod";
import { checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Declaring routes as data (defineRoutes)");

const IdParams = z.object({ id: z.string() });
const NewUser = z.object({ name: z.string() });
const PageQuery = z.object({ page: z.coerce.number().default(1) });

/* ------------------------------------------------------------------ */
step("A registry: routes declared as an object");

const users = defineRoutes("/users", (r) => ({
  getUser: r.get("/:id", validate({ params: IdParams }), (req, res) => {
    // req.params.id is a string — narrowed from the validator, as usual.
    res.json({ id: req.params.id });
  }),
  createUser: r.post(
    "/",
    // "respond": a failed body is answered 400 by the validator itself, so
    // this socket-free fetch shows it (the default mode throws, for an
    // adapter's final error handler).
    validate({ body: NewUser }, { onFailure: "respond" }),
    (req, res) => {
      // req.body is { name: string }.
      res.status(201).json(req.body);
    },
  ),
  listUsers: r.get("/", validate({ query: PageQuery }), (req, res) => {
    // req.query.page is a number — the coercion ran.
    res.json({ page: req.query.page });
  }),
}));

// Each definition answers its method, full path and callbacks.
show("users.getUser", {
  method: users.getUser.method,
  path: users.getUser.path,
});

/* ------------------------------------------------------------------ */
step("Mounted as an ordinary sub-router");

const app = new BunRouter();
app.use(users.mount, users.router);
// A route outside the registry, for contrast below.
app.get("/health", (_req, res) => res.send("ok"));

/** Fetches `path` from the app and answers `"<status> <body>"`. */
async function call(path: string | Request): Promise<string> {
  const response = await app.fetch(path);
  return `${response.status} ${await response.text()}`;
}

show("GET /users/42", await call("/users/42"));
show("GET /users?page=3 (query coerced)", await call("/users?page=3"));
show(
  "POST /users with a bad body — the validator answers 400",
  await call(
    new Request("http://localhost/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: 7 }),
    }),
  ),
);

/* ------------------------------------------------------------------ */
step("Property names are the operationIds");

const { document } = generateOpenApi(app, { title: "Users", version: "1" });
const operationIds = Object.fromEntries(
  Object.entries(document.paths as Record<string, Record<string, unknown>>).map(
    ([path, verbs]) => [
      path,
      Object.values(verbs).map(
        (operation) => (operation as { operationId?: string }).operationId,
      ),
    ],
  ),
);
show("operationId per path", operationIds);
checkEqual(
  "the registry's property names, not the derived names",
  operationIds["/users/{id}"],
  ["getUser"],
);
checkEqual(
  "a route outside the registry derives its operationId",
  operationIds["/health"],
  ["getHealth"],
);

/* ------------------------------------------------------------------ */
step("RoutesOf: the flat map, a pure type");

// The same shape generation emits, keyed "VERB /full/path" — read off
// `typeof` the registry, at compile time only. A typed client is built over
// it; nothing here runs.
type Api = RoutesOf<typeof users>;
type _params = Api["GET /users/:id"]["params"]; // { id: string }
type _body = Api["POST /users/"]["body"]; // { name: string }
type _query = Api["GET /users/"]["query"]; // { page: number }
const paramsProbe: _params = { id: "42" };
show("Api['GET /users/:id']['params'] accepts", paramsProbe);

summary();
