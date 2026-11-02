/**
 * The generator's fixture app (typed-client plan §12.1, PR-C2's parity row):
 * a `defineRoutes` registry with zod schemas, so the same routes can be typed
 * two ways and compared — generated from the OpenAPI document
 * (`app.gen.ts`, written by `bun-client generate --module` from this file),
 * and inferred with bun-common's `RoutesOf` (its `send`/`receive` views).
 *
 * It covers named components (`.meta({ id })`), recursion, an enum, a
 * nullable field, a record, arrays, a discriminated union, a coerced and
 * defaulted query key, a required header, `x-bun-errors`, `x-bun-cache`, an
 * SSE stream, a bodiless status, a route that declares nothing, and a
 * `z.date()` (the documented §5.3 difference). The handlers answer what the
 * e2e test expects.
 */
import type { RouterErrorMiddlewareHandler } from "@kingsleyweb/bun-common";
import type { RouteDoc } from "@kingsleyweb/bun-common/lib/docs";
import {
  BunRouter,
  defineRoutes,
  sse,
  validate,
} from "@kingsleyweb/bun-common";
import { z } from "zod";

export const Role = z.enum(["admin", "member"]).meta({ id: "Role" });

export const Address = z
  .object({ city: z.string(), zip: z.string().nullable() })
  .meta({ id: "Address", description: "Where a user lives." });

export const User = z
  .object({
    id: z.string(),
    name: z.string().meta({ description: "The display name." }),
    role: Role,
    address: Address.optional(),
    tags: z.array(z.string()),
    scores: z.record(z.string(), z.number()),
    nickname: z.string().nullable(),
    createdAt: z.iso.datetime(),
    joined: z.date(),
  })
  .meta({ id: "User" });

export const Category = z
  .object({
    name: z.string(),
    get children() {
      return z.array(Category);
    },
  })
  .meta({ id: "Category" });

export const Problem = z
  .object({
    type: z.string(),
    title: z.string(),
    code: z.string(),
    detail: z.string().optional(),
  })
  .meta({ id: "Problem" });

const Shape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("circle"), radius: z.number() }),
  z.object({ kind: z.literal("square"), side: z.number() }),
]);

/**
 * Documents a handler: `.describe()` keys its doc on the route's terminal
 * callback, so documenting the handler once carries the doc into the
 * registry that registers it (bun-common's `routeDoc.ts`).
 */
function documented<H extends object>(handler: H, doc: RouteDoc): H {
  new BunRouter().get("/", handler as never).describe(doc);
  return handler;
}

/** The one user the app knows. */
export const ADA: z.input<typeof User> = {
  id: "42",
  name: "Ada",
  role: "admin",
  tags: ["math"],
  scores: { chess: 9 },
  nickname: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  joined: new Date(Date.UTC(2026, 0, 1)),
};

/** A problem+json body for `code`. */
function problem(code: string, title: string) {
  return { type: "about:blank", title, code };
}

export const api = defineRoutes("/api", (r) => ({
  getUser: r.get(
    "/users/:id",
    validate(
      {
        params: z.object({ id: z.string() }),
        query: z.object({
          page: z.coerce.number().default(1),
          expand: z.array(z.string()).optional(),
        }),
        headers: z.object({ "x-tenant": z.string() }),
      },
      { responses: { 200: User, 404: Problem } },
    ),
    documented(
      (req, res) =>
        req.params.id === ADA.id
          ? res.status(200).json(ADA)
          : res.status(404).json(problem("NOT_FOUND", "No such user")),
      {
        summary: "Read one user",
        errors: ["NOT_FOUND", "GONE"],
        cache: { tags: ["user:{id}"] },
      },
    ),
  ),
  createUser: r.post(
    "/users",
    validate(
      {
        body: z.object({
          name: z.string(),
          role: Role.default("member"),
          address: Address.optional(),
        }),
      },
      { responses: { 201: User, 409: Problem } },
    ),
    documented(
      (req, res) =>
        req.body.name === ADA.name
          ? res.status(409).json(problem("CONFLICT", "Taken"))
          : res.status(201).json({
              ...ADA,
              id: "43",
              name: req.body.name,
              role: req.body.role,
            }),
      { errors: ["CONFLICT"], cache: { invalidates: ["users"] } },
    ),
  ),
  deleteUser: r.delete(
    "/users/:id",
    validate(
      { params: z.object({ id: z.string() }) },
      { responses: { 204: null } },
    ),
    (_req, res) => res.status(204).end(),
  ),
  userEvents: r.get(
    "/users/:id/events",
    validate(
      { params: z.object({ id: z.string() }) },
      {
        responses: {
          200: {
            content: {
              "text/event-stream": sse({
                progress: z.object({ percent: z.number() }),
                done: z.object({ ok: z.boolean() }),
              }),
            },
          },
        },
      },
    ),
    (_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.status(200).send('event: done\ndata: {"ok":true}\n\n');
    },
  ),
  listCategories: r.get(
    "/categories",
    validate({}, { responses: { 200: z.array(Category) } }),
    (_req, res) =>
      res
        .status(200)
        .json([{ name: "root", children: [{ name: "leaf", children: [] }] }]),
  ),
  draw: r.post(
    "/shapes",
    validate({ body: Shape }, { responses: { 200: Shape } }),
    (req, res) => res.status(200).json(req.body),
  ),
  health: r.get("/health", (_req, res) => res.json({ ok: true })),
}));

/**
 * A fresh router with the registry mounted, and an error handler answering
 * a failed request check with its status as problem+json: what the
 * generator documents and the e2e test serves.
 */
export function buildRouter(): BunRouter {
  const router = new BunRouter();
  router.use(api.mount, api.router);
  router.use(((error, _req, res, _next) => {
    const { status, message } = error as { status?: number; message?: string };
    res.status(status ?? 500).json(problem("INVALID", message ?? "Failed"));
  }) satisfies RouterErrorMiddlewareHandler);
  return router;
}

export default buildRouter;
