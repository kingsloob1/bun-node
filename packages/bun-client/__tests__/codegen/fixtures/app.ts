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
 * SSE stream, a bodiless status, a route that declares nothing, a
 * `z.date()` and a `.refine()` (the documented §5.3 differences, which the
 * generated header names), response headers (`.describe()`, §5.6); and
 * since PR-C9 the bodies beyond JSON: a multipart upload with documented
 * files, an urlencoded form, an NDJSON stream, a raw stream and a download. The handlers answer
 * what the e2e test expects.
 */
import type { RouterErrorMiddlewareHandler } from "@kingsleyweb/bun-common";
import type { RouteDoc } from "@kingsleyweb/bun-common/lib/docs";
import {
  BunRouter,
  chunks,
  defineRoutes,
  opaque,
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

/** What the upload route answers: the caption and each file it received. */
const Upload = z.object({
  caption: z.string().optional(),
  files: z.array(
    z.object({
      field: z.string(),
      name: z.string(),
      type: z.string(),
      size: z.number(),
    }),
  ),
});

/** One line of the NDJSON export. */
const Row = z.object({ id: z.string(), name: z.string() });

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
      (req, res) => {
        if (req.params.id !== ADA.id) {
          res.status(404).json(problem("NOT_FOUND", "No such user"));
          return;
        }
        res.setHeader("x-request-id", "req-1");
        res.setHeader("x-rate-limit", "100");
        res.status(200).json(ADA);
      },
      {
        summary: "Read one user",
        errors: ["NOT_FOUND", "GONE"],
        cache: { tags: ["user:{id}"] },
        responses: {
          200: {
            headers: {
              "X-Request-Id": {
                description: "The request's id.",
                schema: { type: "string", pattern: "^req-" },
              },
              "X-Rate-Limit": { schema: { type: "integer", minimum: 0 } },
            },
          },
        },
      },
    ),
  ),
  createUser: r.post(
    "/users",
    validate(
      {
        body: z
          .object({
            name: z.string(),
            role: Role.default("member"),
            address: Address.optional(),
          })
          .refine((user) => user.name.trim() !== "", "A name is not blank"),
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
  uploadAvatar: r
    .post(
      "/users/:id/avatar",
      validate(
        {
          params: z.object({ id: z.string() }),
          body: z.object({ caption: z.string().optional() }),
        },
        { responses: { 201: Upload } },
      ),
      async (req, res) => {
        const parts = await req.getMultiParts({});
        const files = [...parts.files.keys()].map((file) => ({
          field: file.fieldname,
          name: file.originalFilename,
          type: file.mimeType,
          size: file.file.byteLength,
        }));
        res.status(201).json({
          caption: (parts.fields as { caption?: string }).caption,
          files: files.sort((a, b) =>
            a.field === b.field ? a.size - b.size : a.field < b.field ? -1 : 1,
          ),
        });
      },
    )
    .describe({
      request: {
        files: {
          avatar: {
            required: true,
            maxBytes: 1024,
            mediaTypes: ["image/png", "image/jpeg"],
            description: "The new picture.",
          },
          extras: { maxCount: 3 },
        },
      },
    }),
  login: r
    .post(
      "/sessions",
      validate(
        {
          body: z.object({
            user: z.string(),
            tags: z.array(z.string()).optional(),
          }),
        },
        {
          responses: {
            200: z.object({ user: z.string(), tags: z.array(z.string()) }),
          },
        },
      ),
      (req, res) =>
        res
          .status(200)
          .json({ user: req.body.user, tags: req.body.tags ?? [] }),
    )
    .describe({ requestMediaTypes: ["application/x-www-form-urlencoded"] }),
  exportUsers: r.get(
    "/exports/users",
    validate(
      {},
      {
        responses: {
          200: {
            content: {
              "application/x-ndjson": chunks(Row, { framing: "ndjson" }),
            },
          },
        },
      },
    ),
    (_req, res) => {
      res.setHeader("content-type", "application/x-ndjson");
      res
        .status(200)
        .send('{"id":"42","name":"Ada"}\n{"id":"43","name":"Grace"}\n');
    },
  ),
  avatarBytes: r.get(
    "/users/:id/avatar",
    validate(
      { params: z.object({ id: z.string() }) },
      {
        responses: {
          200: { content: { "application/octet-stream": chunks(z.any()) } },
        },
      },
    ),
    (_req, res) => {
      res.setHeader("content-type", "application/octet-stream");
      res.status(200).send(new Uint8Array([1, 2, 3]));
    },
  ),
  report: r.get(
    "/users/:id/report",
    validate(
      { params: z.object({ id: z.string() }) },
      { responses: { 200: opaque("application/pdf"), 404: Problem } },
    ),
    (req, res) => {
      if (req.params.id !== ADA.id) {
        res.status(404).json(problem("NOT_FOUND", "No such user"));
        return;
      }
      res.setHeader(
        "content-disposition",
        `attachment; filename="report-${req.params.id}.pdf"`,
      );
      res.setHeader("content-type", "application/pdf");
      res.status(200).send(new Blob(["%PDF-1.7"]));
    },
  ),
}));

/**
 * A fresh router with an upload middleware, the registry mounted, and an
 * error handler answering a failed request check with its status as
 * problem+json: what the generator documents and the e2e test serves.
 */
export function buildRouter(): BunRouter {
  const router = new BunRouter();
  // A multipart body's fields reach `req.body` (and so the validator) only
  // once something parses it: the upload middleware an app runs first.
  router.use(async (req, _res, next) => {
    if (
      String(req.headers["content-type"] ?? "").startsWith(
        "multipart/form-data",
      )
    )
      req.body = (await req.getMultiParts({})).fields;
    next();
  });
  router.use(api.mount, api.router);
  router.use(((error, _req, res, _next) => {
    const { status, message } = error as { status?: number; message?: string };
    res.status(status ?? 500).json(problem("INVALID", message ?? "Failed"));
  }) satisfies RouterErrorMiddlewareHandler);
  return router;
}

export default buildRouter;
