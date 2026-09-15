/**
 * Typed handlers — `req.params`, `req.query` and `req.body` inferred from the
 * path and from the validator in front of the handler.
 *
 * ```bash
 * bun 06-validation/typed-handlers.ts
 * ```
 *
 * Most of what this example shows happens in the compiler: each handler
 * assigns a request member to a variable of the type it should have, so if
 * inference ever fell back to `unknown` or `any` the typecheck of this file
 * would fail. The `@ts-expect-error` lines are the negative controls — they
 * must stay errors.
 *
 * The rules:
 *
 * - `req.params` comes from the path literal: `"/users/:id/:tab?"` gives
 *   `{ id: string; tab?: string }`. A params schema overrides it.
 * - `req.query` / `req.body` come from the `validate()` middleware immediately
 *   before the handler, in the same call. Without one they stay the untyped
 *   `Record<string, unknown>` and body-parser union.
 * - Only that one position carries a shape; other middleware may come before
 *   it.
 * - A sub-router can declare the path it is mounted at, and the validated
 *   shape of the mount: `new BunRouter<"/orgs/:org", { query: ... }>()`.
 */
import type {
  InferValidatedShape,
  JsonValue,
  ResolvedHandler,
  RouterHandler,
  StandardSchemaV1,
  TypedRouteHandler,
} from "@kingsleyweb/bun-common";
import { BunRouter, validate } from "@kingsleyweb/bun-common";
import { z } from "zod";
import { show, step, title } from "../shared/console";

title("Typed handlers");

const router = new BunRouter();

/** GETs `path` and answers with the JSON body. */
async function getJson(path: string, init?: RequestInit): Promise<JsonValue> {
  return (await (await router.fetch(path, init)).json()) as JsonValue;
}

/* ------------------------------------------------------------------ */
step("Params from the path literal");

router.get("/users/:id/:tab?", (req, res) => {
  const id: string = req.params.id;
  const tab: string | undefined = req.params.tab;
  // @ts-expect-error — the path declares no `:org`.
  const _org = req.params.org;
  res.json({ id, tab: tab ?? null });
});

router.get("/files/*path", (req, res) => {
  // A named wildcard gives both the positional key and the name.
  const path: string = req.params.path;
  res.json({ path, positional: req.params[0] });
});

show("GET /users/7/settings", await getJson("/users/7/settings"));
show("GET /users/7", await getJson("/users/7"));
show("GET /files/docs/a/b.txt", await getJson("/files/docs/a/b.txt"));

/* ------------------------------------------------------------------ */
step("Query and body from the validator in front of the handler");

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  status: z.enum(["open", "closed"]).optional(),
});
const IssueBody = z.object({
  title: z.string(),
  labels: z.array(z.string()).default([]),
});

router.get("/issues", validate({ query: ListQuery }), (req, res) => {
  // A number — the schema coerced the string from the URL.
  const page: number = req.query.page;
  const status: "open" | "closed" | undefined = req.query.status;
  // @ts-expect-error — a number is not a string.
  const _asString: string = req.query.page;
  res.json({ page, status: status ?? null, type: typeof page });
});

router.post(
  "/repos/:repo/issues",
  validate({ query: ListQuery, body: IssueBody }),
  (req, res) => {
    const repo: string = req.params.repo; // still from the path
    const labels: string[] = req.body.labels;
    res.status(201).json({ repo, title: req.body.title, labels });
  },
);

show(
  "GET /issues?page=2&status=open",
  await getJson("/issues?page=2&status=open"),
);
show(
  "POST /repos/bun-node/issues",
  await getJson("/repos/bun-node/issues", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Typed at last" }),
  }),
);

/* ------------------------------------------------------------------ */
step("A params schema overrides what the path inferred");

router.get(
  "/invoices/:id",
  validate({ params: z.object({ id: z.coerce.number() }) }),
  (req, res) => {
    const id: number = req.params.id;
    res.json({ id, type: typeof id });
  },
);

show("GET /invoices/1001", await getJson("/invoices/1001"));

/* ------------------------------------------------------------------ */
step(
  "Other middleware may come first; the validator must be last before the handler",
);

/** Plain middleware: typed `RouterHandler`, it contributes no shape. */
const requireUser: RouterHandler = (req, res, next) => {
  if (!req.getHeader("x-user")) {
    return res.status(401).json({ error: "who are you?" });
  }
  return next();
};

router.get(
  "/me/issues",
  requireUser,
  validate({ query: ListQuery }),
  (req, res) => {
    const page: number = req.query.page;
    res.json({ user: req.getHeader("x-user"), page });
  },
);

show(
  "GET /me/issues?page=5",
  await getJson("/me/issues?page=5", { headers: { "X-User": "ada" } }),
);

/* ------------------------------------------------------------------ */
step(
  "InferValidatedShape and ResolvedHandler: handlers written apart from their route",
);

const createIssueSchemas = { query: ListQuery, body: IssueBody };

/** What `validate(createIssueSchemas)` parses: `{ query: …; body: … }`. */
type CreateIssueShape = InferValidatedShape<typeof createIssueSchemas>;

/** A handler declared on its own, with the request a route would give it. */
const createIssue: ResolvedHandler<
  "/projects/:project/issues",
  CreateIssueShape
> = (req, res) => {
  const project: string = req.params.project;
  const page: number = req.query.page;
  res.status(201).json({ project, page, title: req.body.title });
};

// Known issue: passing `createIssue` itself as the last argument matches no
// overload (TS2769), even though its type is the route's own handler type.
// Calling it from an inline arrow — which the overload types — works.
router.post(
  "/projects/:project/issues",
  validate(createIssueSchemas),
  (req, res, next) => {
    return createIssue(req, res, next);
  },
);

/** The same idea with every type spelled out: params, query, body. */
const closeIssue: TypedRouteHandler<
  { id: string },
  Record<string, unknown>, // the unvalidated query, spelled as the router types it
  { reason: string }
> = (req, res) => {
  res.json({ closed: req.params.id, reason: req.body.reason });
};

// Explicit type arguments type a handler with no validator at all. Nothing
// checks the request at runtime, so this is a promise you are making.
router.post<"/issues/:id/close", { body: { reason: string } }>(
  "/issues/:id/close",
  (req, res, next) => {
    return closeIssue(req, res, next);
  },
);

show(
  "POST /projects/bun/issues?page=3",
  await getJson("/projects/bun/issues?page=3", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Shape from InferValidatedShape" }),
  }),
);
show(
  "POST /issues/12/close",
  await getJson("/issues/12/close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "fixed" }),
  }),
);

/* ------------------------------------------------------------------ */
step("StandardSchemaV1.InferInput / InferOutput");

/** What a client may send: `page` is optional, and anything coercible. */
type ListInput = StandardSchemaV1.InferInput<typeof ListQuery>;
/** What the handler receives: `page` is always a number. */
type ListOutput = StandardSchemaV1.InferOutput<typeof ListQuery>;

const sent: ListInput = { status: "open" };
const received: ListOutput = ListQuery.parse(sent);
show("input → output", { sent, received });

/* ------------------------------------------------------------------ */
step("Mounted sub-routers: the mount's params and validated query");

const PageQuery = z.object({ page: z.coerce.number().int().min(1) });

/** Declares where it will be mounted, and what the mount validates. */
const members = new BunRouter<"/orgs/:org", { query: { page: number } }>();

members.get("/members/:memberId", (req, res) => {
  const org: string = req.params.org; // from the mount path
  const memberId: string = req.params.memberId; // from its own path
  const page: number = req.query.page; // from the mount's validator
  res.json({ org, memberId, page, type: typeof page });
});

router.use("/orgs/:org", validate({ query: PageQuery }), members);

show(
  "GET /orgs/acme/members/9?page=2",
  await getJson("/orgs/acme/members/9?page=2"),
);

/** Mounts the compiler refuses. Never called — it exists to be type-checked. */
function _mountsThatDoNotCompile(): void {
  // @ts-expect-error — declared for "/orgs/:org", mounted at "/teams/:team".
  router.use("/teams/:team", validate({ query: PageQuery }), members);
  // @ts-expect-error — it expects a validated query, but no validator is mounted.
  router.use("/orgs/:org", members);
}
show("mismatched mounts are compile errors", typeof _mountsThatDoNotCompile);
