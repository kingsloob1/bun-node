/**
 * Validating requests — params, query, body and headers, what happens when a
 * request fails, and the hooks around a schema.
 *
 * ```bash
 * bun 06-validation/validate-requests.ts
 * ```
 *
 * `validate({ ...schemas }, options)` builds an ordinary router middleware from
 * [Standard Schema](https://standardschema.dev) schemas — zod here, but any
 * library that implements the spec works (see `schema-libraries.ts`).
 *
 * A few things worth knowing before reading it:
 *
 * - Targets are validated in a fixed order: headers, params, query, body.
 * - On success the parsed value **replaces** `req.params` / `req.query` /
 *   `req.body`, so a coercing schema changes what the handler reads. Headers are
 *   checked but never replaced.
 * - On failure the default is `next(ValidationError)`, so the application's own
 *   error handler decides what the client sees.
 * - Every request here goes through `router.fetch()` — the real pipeline, with
 *   no port bound.
 */
import type {
  JsonValue,
  RouterErrorMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import {
  BunRouter,
  BunValidate,
  validate,
  ValidationError,
} from "@kingsleyweb/bun-common";
import { z } from "zod";
import { show, step, title } from "../shared/console";

/** What a request through {@link call} came back with. */
interface Outcome {
  /** The HTTP status. */
  status: number;
  /** The body, parsed as JSON when it is JSON, otherwise the text. */
  body: JsonValue;
}

title("Validating requests");

const router = new BunRouter();

/** Sends a request through the router and reads the response back. */
async function call(path: string, init?: RequestInit): Promise<Outcome> {
  const response = await router.fetch(path, init);
  const text = await response.text();
  let body: JsonValue = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON — keep the text.
  }
  return { status: response.status, body };
}

/** A JSON `POST` with extra headers. */
function postJson(
  body: JsonValue,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

/* ------------------------------------------------------------------ */
step("params: the values matched out of the path, coerced");

const UserParams = z.object({ id: z.coerce.number().int().positive() });

router.get("/users/:id", validate({ params: UserParams }), (req, res) => {
  // `req.params.id` is a number here — the schema's output, not the string
  // the path matched.
  res.json({ id: req.params.id, type: typeof req.params.id });
});

show("GET /users/42", await call("/users/42"));

/* ------------------------------------------------------------------ */
step("query: every value arrives as a string; the schema decides the types");

const SearchQuery = z.object({
  q: z.string().min(1),
  page: z.coerce.number().int().min(1).default(1),
  sort: z.enum(["asc", "desc"]).default("desc"),
});

router.get("/search", validate({ query: SearchQuery }), (req, res) => {
  res.json({ query: req.query, pageType: typeof req.query.page });
});

show("GET /search?q=bun&page=3", await call("/search?q=bun&page=3"));
show("GET /search?q=bun (defaults filled in)", await call("/search?q=bun"));

/* ------------------------------------------------------------------ */
step("body: a parsed JSON body, with unknown keys stripped by the schema");

const NewPost = z.object({
  title: z.string().min(3),
  tags: z.array(z.string()).max(5).default([]),
});

router.post("/posts", validate({ body: NewPost }), (req, res) => {
  res.status(201).json({ created: req.body });
});

show(
  "POST /posts",
  await call("/posts", postJson({ title: "Hello", admin: true })),
);

/* ------------------------------------------------------------------ */
step("headers: checked, but req.headers is left as it was");

// Header names arrive lower-cased.
const ApiKeyHeaders = z.object({ "x-api-key": z.string().min(8) });

router.get("/private", validate({ headers: ApiKeyHeaders }), (req, res) => {
  // Headers are never replaced: `req.headers` is still every header, not just
  // the one the schema kept.
  res.json({
    key: req.getHeader("x-api-key"),
    stillHasOtherHeaders: "x-trace-id" in req.headers,
  });
});

show(
  "GET /private with a key",
  await call("/private", {
    headers: { "X-Api-Key": "s3cret-key", "X-Trace-Id": "t-1" },
  }),
);

/* ------------------------------------------------------------------ */
step("Failure, onFailure: 'next' (the default) — your error handler decides");

// Registered before the error handler below, which catches what it passes on.
router.get(
  "/orders/:id",
  validate({ params: z.object({ id: z.uuid() }) }),
  (req, res) => {
    res.json({ id: req.params.id });
  },
);

/* ------------------------------------------------------------------ */
step("onFailure: 'respond' — the middleware answers by itself");

router.get(
  "/respond",
  validate({ query: SearchQuery }, { onFailure: "respond", status: 422 }),
  (_req, res) => {
    res.send("unreachable when the query is invalid");
  },
);

router.get(
  "/respond-formatted",
  validate(
    { query: SearchQuery },
    {
      onFailure: "respond",
      // Shape the body however the API documents errors.
      formatError: (error, req) => {
        return {
          type: "https://example.test/problems/validation",
          instance: req.path,
          errors: error.issues.map(
            (issue) => `${issue.path}: ${issue.message}`,
          ),
        };
      },
    },
  ),
  (_req, res) => {
    res.send("unreachable when the query is invalid");
  },
);

show("GET /respond?page=0", await call("/respond?page=0"));
show("GET /respond-formatted?page=x", await call("/respond-formatted?page=x"));

/* ------------------------------------------------------------------ */
step("onFailure: 'throw' — for the error pipeline or the adapter's handler");

router.get(
  "/throw",
  validate({ query: SearchQuery }, { onFailure: "throw" }),
  (_req, res) => {
    res.send("unreachable when the query is invalid");
  },
);

/* ------------------------------------------------------------------ */
step("abortEarly: stop at the first target that fails");

router.post(
  "/everything",
  validate(
    { query: SearchQuery, body: NewPost },
    { onFailure: "respond" }, // collects issues from every target
  ),
  (_req, res) => {
    res.send("ok");
  },
);
router.post(
  "/first-only",
  validate(
    { query: SearchQuery, body: NewPost },
    { onFailure: "respond", abortEarly: true },
  ),
  (_req, res) => {
    res.send("ok");
  },
);

show(
  "POST /everything — query and body both wrong",
  await call("/everything?page=0", postJson({ title: "x" })),
);
show(
  "POST /first-only — query is checked before body, so only it is reported",
  await call("/first-only?page=0", postJson({ title: "x" })),
);

/* ------------------------------------------------------------------ */
step("replace: false — validate, but hand the handler the raw values");

router.get(
  "/raw",
  validate({ query: SearchQuery }, { replace: false }),
  (req, res) => {
    // The types still say number (they follow the schema); the value is the
    // string from the URL because nothing was written back.
    res.json({ page: req.query.page, type: typeof req.query.page });
  },
);

show("GET /raw?q=bun&page=2", await call("/raw?q=bun&page=2"));

/* ------------------------------------------------------------------ */
step("hooks: normalize before the schema, transform after it");

const TaggedQuery = z.object({ tag: z.array(z.string().min(1)) });

router.get(
  "/tagged",
  validate(
    { query: TaggedQuery },
    {
      onFailure: "respond",
      hooks: {
        query: {
          // `?tag=a` parses to a string, `?tag=a&tag=b` to an array, and a
          // client may send `?tag=a,b`. Reshape all three before validating.
          normalize: (value) => {
            const raw = value.tag;
            const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
            return {
              tag: list.flatMap((entry) => String(entry).split(",")),
            };
          },
        },
      },
    },
  ),
  (req, res) => {
    res.json({ tag: req.query.tag });
  },
);

router.post(
  "/drafts",
  validate(
    { body: NewPost },
    {
      hooks: {
        body: {
          // Runs only after a successful parse, receiving the schema's typed
          // output. Its result is what the handler sees, and its return type
          // is the handler's `req.body` type: `slug` and `authorId` included.
          transform: (value, req) => {
            return {
              ...value,
              slug: value.title.toLowerCase().replaceAll(/\W+/g, "-"),
              authorId: req.getHeader("x-user-id"),
            };
          },
        },
      },
    },
  ),
  (req, res) => {
    res.status(201).json({ draft: req.body });
  },
);

show("GET /tagged?tag=a,b&tag=c", await call("/tagged?tag=a,b&tag=c"));
show(
  "POST /drafts",
  await call(
    "/drafts",
    postJson({ title: "Hello Bun World" }, { "X-User-Id": "u-7" }),
  ),
);

/* ------------------------------------------------------------------ */
step("Chaining validators: the second sees the first one's output");

const RawRange = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
});
const WithDays = z
  .object({ from: z.date(), to: z.date() })
  .refine((range) => range.to >= range.from, {
    message: "to must not be before from",
    path: ["to"],
  })
  .transform((range) => ({
    ...range,
    days: Math.round((range.to.getTime() - range.from.getTime()) / 86_400_000),
  }));

router.get(
  "/reports",
  validate({ query: RawRange }, { onFailure: "respond" }),
  validate({ query: WithDays }, { onFailure: "respond" }),
  (req, res) => {
    res.json({ days: req.query.days });
  },
);

show(
  "GET /reports?from=2026-01-01&to=2026-01-31",
  await call("/reports?from=2026-01-01&to=2026-01-31"),
);
show(
  "GET /reports?from=2026-02-01&to=2026-01-01",
  await call("/reports?from=2026-02-01&to=2026-01-01"),
);

/* ------------------------------------------------------------------ */
step("BunValidate: the class behind validate()");

const guard = new BunValidate({
  schemas: { params: UserParams, query: SearchQuery },
  onFailure: "respond",
});
show("guard.schemas has", Object.keys(guard.schemas));

router.get("/admin/users/:id", guard.middleware(), (req, res) => {
  res.json({ id: req.params.id, q: req.query.q });
});
// `BunValidate.middleware(options)` is `new BunValidate(options).middleware()`.
router.get(
  "/admin/audit/:id",
  BunValidate.middleware({ schemas: { params: UserParams } }),
  (req, res) => {
    res.json({ id: req.params.id });
  },
);

show("GET /admin/users/5?q=kim", await call("/admin/users/5?q=kim"));
show("GET /admin/audit/7", await call("/admin/audit/7"));

/* ------------------------------------------------------------------ */
step("The error handler: ValidationError and its issues");

// Issue paths are dotted: nested keys and array indexes both appear.
router.post(
  "/nested",
  validate({
    body: z.object({
      customer: z.object({ address: z.object({ zip: z.string().length(5) }) }),
      items: z.array(z.object({ sku: z.string() })),
    }),
  }),
  (_req, res) => {
    res.send("ok");
  },
);

// One handler for the whole router. It must come after the routes it covers —
// error handlers run in registration order, like Express. Both 'next' and
// 'throw' failures land here.
router.use(((error, _req, res, _next) => {
  if (error instanceof ValidationError) {
    res.status(error.status).json({
      name: error.name,
      message: error.message,
      status: error.status,
      targets: error.targets,
      issues: error.issues,
    });
    return;
  }
  res.status(500).json({ error: String(error) });
}) satisfies RouterErrorMiddlewareHandler);

show("GET /users/abc (next)", await call("/users/abc"));
show("GET /orders/not-a-uuid (next)", await call("/orders/not-a-uuid"));
show("GET /throw?page=-1 (throw)", await call("/throw?page=-1"));
show("GET /private without a key (a header issue)", await call("/private"));

// Issue paths are dotted: nested keys and array indexes both appear.
router.post(
  "/nested",
  validate({
    body: z.object({
      customer: z.object({ address: z.object({ zip: z.string().length(5) }) }),
      items: z.array(z.object({ sku: z.string() })),
    }),
  }),
  (_req, res) => {
    res.send("ok");
  },
);
show(
  "POST /nested — see each issue's path",
  await call(
    "/nested",
    postJson({ customer: { address: { zip: "1" } }, items: [{ sku: 1 }] }),
  ),
);

// A ValidationError can be built directly, e.g. for a check a schema cannot
// express; the message summarises every issue.
const handMade = new ValidationError(
  [
    { target: "body", path: "email", message: "is already registered" },
    { target: "body", path: "", message: "account limit reached" },
  ],
  409,
);
show("new ValidationError(...).message", handMade.message);
show("…targets and status", {
  targets: handMade.targets,
  status: handMade.status,
});
