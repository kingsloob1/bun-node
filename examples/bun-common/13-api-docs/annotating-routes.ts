/**
 * Annotating routes by hand — `.describe()` and `generateOpenApi()` turn any
 * `BunRouter` into an OpenAPI 3.1 document, no validator required.
 *
 * ```bash
 * bun 13-api-docs/annotating-routes.ts
 * ```
 *
 * `from-validators.ts` shows the schemas the validators hand over for free;
 * this one shows the annotation half: prose (`summary`, `tags`,
 * `deprecated`), a hand-written request or response for a route with no
 * validator, `hidden` for what must not be documented, and the document the
 * generator builds from all of it.
 *
 * The asymmetry to remember: a `request` schema in `.describe()` **documents
 * without enforcing** — nothing validates it at runtime. And where a
 * validator declares a response, the validator wins over `.describe()` (with
 * a warning if they disagree). Enforcement lives on the validator; prose
 * lives on `.describe()`.
 */
import { BunRouter, validate } from "@kingsleyweb/bun-common";
import { generateOpenApi } from "@kingsleyweb/bun-common/lib/docs";
import { z } from "zod";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Annotating routes (.describe + generateOpenApi)");

const router = new BunRouter();

// A validated route: the schemas are discovered; .describe() adds the prose.
router
  .get(
    "/users/:id",
    validate(
      { params: z.object({ id: z.string() }) },
      { responses: { 200: z.object({ id: z.string(), name: z.string() }) } },
    ),
    (req, res) => res.json({ id: req.params.id, name: "ada" }),
  )
  .describe({
    summary: "Read one user",
    description: "Reads the user `:id`, when it exists.",
    tags: ["Users"],
    operationId: "readUser",
  });

// A route with no validator: the request is documented inline (and still not
// enforced — nothing validates the query at runtime).
router
  .get("/search", (req, res) => res.json({ q: req.query.q ?? null, hits: [] }))
  .describe({
    summary: "Search",
    tags: ["Users"],
    request: {
      query: z.object({ q: z.string().min(1) }),
    },
    responses: {
      200: {
        schema: z.object({
          q: z.string().nullable(),
          hits: z.array(z.string()),
        }),
      },
    },
  });

// A legacy endpoint documented with a raw JSON Schema, no library at all.
router
  .post("/legacy/report", (req, res) => res.status(202).end())
  .describe({
    summary: "Queue a report",
    request: {
      body: {
        type: "object",
        properties: { kind: { type: "string", enum: ["daily", "weekly"] } },
        required: ["kind"],
      },
    },
    requestRequired: true,
    responses: { 202: null },
  });

// A health check nobody should see in the document.
router
  .get("/healthz", (_req, res) => res.json({ ok: true }))
  .describe({ hidden: true });

// An optional path parameter documents as two paths (OpenAPI path parameters
// are always required, so `/opt/:a?` becomes `/opt` and `/opt/{a}`).
router
  .get("/opt/:a?", (req, res) => res.json({ a: req.params.a ?? null }))
  .describe({
    responses: { 200: { schema: z.object({ a: z.string().nullable() }) } },
  });

/* ------------------------------------------------------------------ */
step("generateOpenApi(router, { title, version })");

const { document, warnings } = generateOpenApi(router, {
  title: "Annotating routes",
  version: "1.0.0",
});
show("warnings", warnings);
checkEqual("nothing degraded", warnings.length, 0);
check("OpenAPI 3.1", document.openapi === "3.1.2");

/** The operation shape this example reads, structurally. */
interface OperationView {
  operationId?: string;
  summary?: string;
  tags?: string[];
  parameters?: { name: string; schema: Record<string, unknown> }[];
  requestBody?: {
    content: Record<string, { schema: { required?: string[] } }>;
  };
  responses?: Record<string, { content?: unknown }>;
}

const paths = document.paths as Record<string, Record<string, OperationView>>;
checkEqual("the documented paths", Object.keys(paths).sort(), [
  "/legacy/report",
  "/opt",
  "/opt/{a}",
  "/search",
  "/users/{id}",
]);
check("the hidden route is absent", !("/healthz" in paths));

const readUser = paths["/users/{id}"].get;
checkEqual("the declared operationId wins", readUser.operationId, "readUser");
checkEqual(
  "summary and tags",
  [readUser.summary, readUser.tags],
  ["Read one user", ["Users"]],
);
check(
  "the validator's params schema documented the path parameter",
  readUser.parameters?.[0].schema.type === "string",
);

const search = paths["/search"].get;
checkEqual(
  "the inline query schema became a query parameter",
  search.parameters?.map((param) => param.name),
  ["q"],
);

const legacy = paths["/legacy/report"].post;
check(
  "the raw JSON Schema body documented",
  legacy.requestBody?.content["application/json"].schema.required?.includes(
    "kind",
  ) === true,
);
check(
  "a `null` response has no content",
  !(legacy.responses && "content" in legacy.responses["202"]),
);

/* ------------------------------------------------------------------ */
step("strict mode turns every warning into a ConfigError");

const messy = new BunRouter();
messy.get("/files/*rest", (_req, res) => res.json({})); // a wildcard: no OpenAPI form
messy.get("/bare", (_req, res) => res.json({})); // no responses declared

const lenient = generateOpenApi(messy, { title: "Messy", version: "1" });
show(
  "lenient warnings",
  lenient.warnings.map((warning) => warning.message),
);
checkEqual("lenient collects, never throws", lenient.warnings.length, 2);

let threw = false;
try {
  generateOpenApi(messy, { title: "Messy", version: "1", strict: "strict" });
} catch {
  threw = true;
}
check("strict throws a ConfigError", threw);

/* ------------------------------------------------------------------ */
step("the document is served like anything else");

const app = new BunRouter();
app.get("/openapi.json", (_req, res) => res.json(document));
const response = await app.fetch("/openapi.json");
check("the document is fetchable", response.status === 200);
const served = (await response.json()) as { openapi: string };
checkEqual("and it is the generated one", served.openapi, "3.1.2");

summary();
