/**
 * Sub-routers — `use(router)`, `use(path, router)`, typed mount params, a
 * validator at the mount, and `group()` / `domain()`.
 *
 * ```bash
 * bun 02-routing/sub-routers.ts
 * ```
 *
 * - Mounting flattens the sub-router's routes into the parent, prefixed with
 *   the mount path. Middleware inside it becomes prefix middleware at the mount.
 * - `new BunRouter<"/users/:id">()` declares where a router will be mounted, so
 *   its handlers see `req.params.id`. `use()` refuses — at compile time — a
 *   mount whose path or validated shape disagrees with the declaration.
 * - Mount params do not reach *mount-level* middleware: params are bound when
 *   a route is entered, and `use()` middleware is not a route.
 * - A validator at the mount replaces `req.query`/`req.body` wholesale, so the
 *   sub-router's handlers see its parsed output.
 */
import type {
  RouterErrorMiddlewareHandler,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import { BunRouter, toStandardSchema, validate } from "@kingsleyweb/bun-common";
import { checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Sub-routers");

/** `?page=` as a positive whole number, defaulting to 1. */
const PageQuery = toStandardSchema<{ page: number }>((input) => {
  const page = Number((input as { page?: unknown } | undefined)?.page ?? 1);
  return Number.isInteger(page) && page > 0
    ? { value: { page } }
    : {
        issues: [
          { message: "page must be a positive whole number", path: ["page"] },
        ],
      };
});

/** Fetches `path` from `router` and answers `"<status> <body>"`. */
async function call(
  router: BunRouter,
  path: string | Request,
): Promise<string> {
  const response = await router.fetch(path);
  return `${response.status} ${await response.text()}`;
}

/* ------------------------------------------------------------------ */
step("use(router) and use(path, router)");

const health = new BunRouter();
health.get("/health", (_req, res) => res.send("ok"));

const users = new BunRouter();
users.get("/", (_req, res) => res.send("all users"));
users.get("/:id", (req, res) => res.send(`user ${req.params.id}`));

const app = new BunRouter();
app.use(health);
app.use("/users", users);

show("GET /health — mounted at the root", await call(app, "/health"));
show("GET /users", await call(app, "/users"));
show("GET /users/7", await call(app, "/users/7"));
show("GET /7 — not reachable without the prefix", await call(app, "/7"));

/* ------------------------------------------------------------------ */
step("Middleware inside a sub-router, and mount order");

const order: string[] = [];
const audited = new BunRouter();
audited.use((req, _res, next) => {
  order.push(`audit ${req.path}`);
  next();
});
audited.get("/report", (_req, res) => res.send("report"));

const logRequest: RouterHandler = (req, _res, next) => {
  order.push(`log ${req.path}`);
  next();
};

const ordered = new BunRouter();
ordered.use("/admin", logRequest, audited); // left to right, as registered
ordered.get("/public", (_req, res) => res.send("public"));

show("GET /admin/report", await call(ordered, "/admin/report"));
show("GET /public", await call(ordered, "/public"));
show("order — the sub-router's middleware only ran under /admin", order);

/* ------------------------------------------------------------------ */
step("Typed mount params: BunRouter<'/accounts/:accountId'>");

const accounts = new BunRouter<"/accounts/:accountId">();
accounts.get("/invoices/:invoiceId", (req, res) => {
  // Both keys are typed: the mount's and the route's own.
  const { accountId, invoiceId } = req.params;
  res.json({ accountId, invoiceId });
});

const seenByMountMiddleware: Record<string, string>[] = [];
const billing = new BunRouter();
billing.use("/accounts/:accountId", (req, _res, next) => {
  seenByMountMiddleware.push({ ...req.params });
  next();
});
billing.use("/accounts/:accountId", accounts);

show(
  "GET /accounts/acme/invoices/2024-001",
  await call(billing, "/accounts/acme/invoices/2024-001"),
);
show("params a use() middleware at the mount saw", seenByMountMiddleware);

/* ------------------------------------------------------------------ */
step("A validator at the mount reaches the sub-router");

const members = new BunRouter<"/orgs/:org", { query: { page: number } }>();
members.get("/members", (req, res) => {
  // `page` is a number: the mount's validator produced it.
  const next: number = req.query.page + 1;
  res.json({ org: req.params.org, page: req.query.page, next });
});

const orgs = new BunRouter();
orgs.use("/orgs/:org", validate({ query: PageQuery }), members);
orgs.use(((error, _req, res, _next) => {
  res.status(400).send((error as Error).message);
}) satisfies RouterErrorMiddlewareHandler);

show(
  "GET /orgs/acme/members?page=3",
  await call(orgs, "/orgs/acme/members?page=3"),
);
show("GET /orgs/acme/members", await call(orgs, "/orgs/acme/members"));
show(
  "GET /orgs/acme/members?page=zero",
  await call(orgs, "/orgs/acme/members?page=zero"),
);

/** Mounts that disagree with their declaration — each one a compile error. */
function _mismatchedMounts(): void {
  const declared = new BunRouter<"/users/:id">();
  // @ts-expect-error mounted at a different path than it declared
  app.use("/accounts/:id", declared);

  // @ts-expect-error declares a validated query, but is mounted without one
  app.use("/orgs/:org", members);
}

/* ------------------------------------------------------------------ */
step("group(): a prefix, three ways");

const v1 = new BunRouter();
v1.get("/status", (_req, res) => res.send("v1 status"));

const versioned = new BunRouter();
versioned.group("/v1", v1); // a router
versioned.group("/v2", (router) => {
  // A callback that fills a fresh BunRouter, whose routes are then flattened
  // in — typed, and binding params like any other route.
  router.get("/items/:id", (req, res) => {
    res.send(`v2 item ${req.params.id}`);
  });
});
// Middleware: several functions, or one declaring `(req, res)` or more. A
// single one-parameter function would be read as the callback form above, and
// a lone inline arrow needs `satisfies RouterHandler` for its types.
versioned.group("/v3", ((_req, res) => {
  res.send("v3: prefix middleware via group()");
}) satisfies RouterHandler);

show("GET /v1/status", await call(versioned, "/v1/status"));
show("GET /v2/items/7", await call(versioned, "/v2/items/7"));
show("GET /v3/anything/below", await call(versioned, "/v3/anything/below"));

/* ------------------------------------------------------------------ */
step("domain(): routes for one host");

const admin = new BunRouter();
admin.get("/dashboard", (req, res) => {
  res.send(`admin dashboard on ${req.hostname}`);
});

const hosts = new BunRouter();
hosts.domain("admin.example.test", admin);
hosts.get("/dashboard", (_req, res) => res.send("the public dashboard"));

show(
  "GET http://admin.example.test/dashboard",
  await call(hosts, new Request("http://admin.example.test/dashboard")),
);
show("GET http://localhost/dashboard", await call(hosts, "/dashboard"));

/* ------------------------------------------------------------------ */
step("domain(pattern, callback): host captures are typed params");

const tenants = new BunRouter();
tenants.domain(":tenant.example.test", (router) => {
  router.get("/users/:id", (req, res) => {
    // Both keys are typed — `tenant` from the host, `id` from the path.
    const { tenant, id }: { tenant: string; id: string } = req.params;
    res.json({ tenant, id });
  });

  // A group inside the domain keeps the host's params.
  router.group("/teams/:team", (group) => {
    group.get("/", (req, res) => {
      res.json({ tenant: req.params.tenant, team: req.params.team });
    });
  });
});

const tenantUser = await call(
  tenants,
  new Request("http://acme.example.test/users/7"),
);
show("GET http://acme.example.test/users/7", tenantUser);
checkEqual(
  "the host's tenant and the path's id both reach req.params",
  tenantUser,
  '200 {"tenant":"acme","id":"7"}',
);
checkEqual(
  "a group inside the domain sees the tenant too",
  await call(tenants, new Request("http://globex.example.test/teams/red/")),
  '200 {"tenant":"globex","team":"red"}',
);
checkEqual(
  "another host does not match",
  await call(tenants, new Request("http://example.test/users/7")),
  "404 ",
);

/* ------------------------------------------------------------------ */
step("Mount prefixes ignore case, like Express");

const caseSeen: string[] = [];
const reports = new BunRouter();
reports.use((req, _res, next) => {
  caseSeen.push(req.baseUrl);
  next();
});
reports.get("/Summary", (req, res) => res.send(`summary at ${req.baseUrl}`));

const caseApp = new BunRouter();
caseApp.use("/Reports", reports);

checkEqual(
  "a differently-cased request reaches the mount, baseUrl in its own spelling",
  await call(caseApp, "/reports/summary"),
  "200 summary at /reports",
);
checkEqual("…and the sub-router's middleware ran under the mount", caseSeen, [
  "/reports",
]);

const strictApp = new BunRouter({ caseSensitive: true });
strictApp.use("/Reports", reports);
checkEqual(
  "caseSensitive: true refuses it",
  await call(strictApp, "/reports/summary"),
  "404 ",
);

summary();
