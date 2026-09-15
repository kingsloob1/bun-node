/**
 * Typed routes — `req.params` inferred from the path literal, and
 * `req.query` / `req.body` / `req.params` from a `validate()` middleware
 * registered just before the handler.
 *
 * ```bash
 * bun 02-routing/typed-routes.ts
 * ```
 *
 * - The inference is compile-time; the runtime half of each section shows the
 *   values really have the types claimed (a coerced `page` is a `number`).
 * - The validator must sit **immediately before** the handler, and one
 *   `validate({ query, body, params })` call covers every target.
 * - `validate` accepts any Standard Schema — zod, valibot, arktype, yup pass
 *   straight in. `toStandardSchema` wraps a plain function, used here so the
 *   example needs no validation library.
 * - A failed validation calls `next(ValidationError)` by default, so the
 *   response shape is the error handler's; `onFailure: "respond"` answers
 *   directly with the issues.
 */
import type {
  ExtractRouteParams,
  JsonValue,
  RouterErrorMiddlewareHandler,
  TypedRouteHandler,
} from "@kingsleyweb/bun-common";
import {
  BunRouter,
  toStandardSchema,
  validate,
  ValidationError,
} from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

title("Typed routes");

// A schema's input is `unknown`: it is untrusted until the schema says otherwise.

/** `?page=` coerced to a positive whole number, defaulting to 1. */
const PageQuery = toStandardSchema<{ page: number }>((input) => {
  const page = Number((input as { page?: unknown } | undefined)?.page ?? 1);
  return Number.isInteger(page) && page > 0
    ? { value: { page } }
    : {
        issues: [
          { message: "must be a positive whole number", path: ["page"] },
        ],
      };
});

/** A post's body: a non-empty title and optional tags. */
const PostBody = toStandardSchema<{ title: string; tags: string[] }>(
  (input) => {
    const body = (input ?? {}) as { title?: unknown; tags?: unknown };
    if (typeof body.title !== "string" || body.title === "") {
      return { issues: [{ message: "is required", path: ["title"] }] };
    }
    const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
    return { value: { title: body.title, tags } };
  },
);

/** `:id` as a number. */
const NumericId = toStandardSchema<{ id: number }>((input) => {
  const id = Number((input as { id?: unknown } | undefined)?.id);
  return Number.isInteger(id)
    ? { value: { id } }
    : { issues: [{ message: "must be numeric", path: ["id"] }] };
});

/** Answers a ValidationError with 400 and its issues; anything else with 500. */
const validationErrors = ((error, _req, res, _next) => {
  if (error instanceof ValidationError) {
    res.status(error.status).json({ issues: error.issues });
    return;
  }
  res.status(500).json({ error: String(error) });
}) satisfies RouterErrorMiddlewareHandler;

const router = new BunRouter();

/** Fetches from the router and prints the status and JSON body. */
async function call(path: string, init?: RequestInit): Promise<void> {
  const response = await router.fetch(path, init);
  show(
    `${init?.method ?? "GET"} ${path} → ${response.status}`,
    await response.json(),
  );
}

/** A JSON request body for `init`. */
function json(body: JsonValue, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/* ------------------------------------------------------------------ */
step("Params from the path");

router.get("/files/:bucket/:version?/*key", (req, res) => {
  // { bucket: string; version?: string; 0: string; key: string }
  const bucket: string = req.params.bucket;
  const version: string | undefined = req.params.version;
  res.json({
    bucket,
    version: version ?? null,
    key: req.params.key,
    positional: req.params[0],
  });
});

await call("/files/photos/v2/2024/beach.jpg");

// The same extraction, as a type of its own.
const example: ExtractRouteParams<"/files/:bucket/:version?/*key"> = {
  bucket: "photos",
  0: "a/b.jpg",
  key: "a/b.jpg",
};
show("ExtractRouteParams value", example);

/* ------------------------------------------------------------------ */
step("query from a validator");

router.get("/posts", validate({ query: PageQuery }), (req, res) => {
  // `page` is a number here, not `unknown` or `string`.
  const offset: number = (req.query.page - 1) * 20;
  res.json({ page: req.query.page, offset, pageIsA: typeof req.query.page });
});

await call("/posts?page=3");
await call("/posts");

/* ------------------------------------------------------------------ */
step("body and params, one validator for several targets");

router.put(
  "/posts/:id",
  validate({ params: NumericId, body: PostBody }),
  (req, res) => {
    const id: number = req.params.id; // the validator's type wins over the path's
    const tags: string[] = req.body.tags;
    res.json({ id, idIsA: typeof id, title: req.body.title, tags });
  },
);

await call(
  "/posts/12",
  json({ title: "Typed routes", tags: ["bun", 1] }, "PUT"),
);

/* ------------------------------------------------------------------ */
step(
  "Plain middleware may come first; the validator must be last before the handler",
);

router.post(
  "/drafts/:author",
  (req, _res, next) => {
    show("middleware sees the raw body", req.body);
    next();
  },
  validate({ body: PostBody }),
  (req, res) => {
    res.status(201).json({ author: req.params.author, title: req.body.title });
  },
);

await call("/drafts/ada", json({ title: "Draft" }));

/* ------------------------------------------------------------------ */
step("A handler typed on its own, reused on a route");

const listComments: TypedRouteHandler<{ id: string }, { page: number }> = (
  req,
  res,
) => {
  res.json({ post: req.params.id, page: req.query.page });
};
// A handler declared ahead of the call cannot follow an inline `validate(...)`
// (a TypeScript inference limit — see `ResolvedHandler`): spell out the verb's
// type arguments, as here, or store the validator in a const first.
router.get<"/posts/:id/comments", { query: { page: number } }>(
  "/posts/:id/comments",
  validate({ query: PageQuery }),
  listComments,
);

await call("/posts/9/comments?page=2");

/* ------------------------------------------------------------------ */
step("When validation fails");

router.post(
  "/strict",
  validate({ body: PostBody }, { onFailure: "respond", status: 422 }),
  (_req, res) => res.json({ ok: true }),
);

// Error handlers run in registration order, so this one follows the routes.
router.use(validationErrors);

await call("/posts?page=-1");
await call("/posts/abc", json({}, "PUT"));
await call("/strict", json({ tags: [] }));

/** Registrations the types refuse — each line is a compile error. */
function _refused(): void {
  router.get("/posts", validate({ query: PageQuery }), (req) => {
    // @ts-expect-error page is a number, not a string
    const page: string = req.query.page;
    return page;
  });
  router.get("/users/:id", (req) => {
    // @ts-expect-error the path declares no :name
    return req.params.name;
  });
}
