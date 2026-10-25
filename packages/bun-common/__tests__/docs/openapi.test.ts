/**
 * AD (a): the OpenAPI generator — `generateOpenApi` over `listRoutes` +
 * `.describe()`, the ported-and-extended `toOpenApiPath` (plan §10.2), the
 * strict/lenient escalation, and the §9.2 invariants (dangling refs, standalone
 * components, path-parameter parity, route/document parity, determinism).
 *
 * The meta-schema matrix lives in `openapi.meta.test.ts`; the golden document
 * in `openapi.fixture.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunRouter } from "../../lib/BunRouter";
import { validate } from "../../lib/BunValidate";
import { documented } from "../../lib/contract/schemas";
import { ConfigError } from "../../lib/errors";
import { chunks, opaque, sse, variants } from "../../lib/responseBodies";
import type { OpenApiDocument } from "../../lib/docs/index";
import {
  danglingRefs,
  generateOpenApi,
  toOpenApiPath,
} from "../../lib/docs/index";

/* ------------------------------------------------------------------ *
 * toOpenApiPath — every §10.2 row.
 * ------------------------------------------------------------------ */
describe("toOpenApiPath (plan §10.2)", () => {
  it("converts a plain parameter", () => {
    expect(toOpenApiPath("/users/:id")).toEqual({
      templates: [{ path: "/users/{id}", params: [{ name: "id" }] }],
      warnings: [],
    });
  });

  it("a wildcard is undocumentable, never thrown", () => {
    for (const path of ["/files/*rest", "/files/{*rest}", "/files/*"]) {
      const result = toOpenApiPath(path);
      expect(result.templates).toEqual([]);
      expect(result.undocumentable).toMatch(/wildcard/);
    }
  });

  it("a regex constraint lifts to a pattern", () => {
    expect(toOpenApiPath("/re/:id(\\d+)")).toEqual({
      templates: [
        { path: "/re/{id}", params: [{ name: "id", pattern: "^(?:\\d+)$" }] },
      ],
      warnings: [],
    });
  });

  it("an optional parameter documents as two paths by default", () => {
    expect(toOpenApiPath("/opt/:a?")).toEqual({
      templates: [
        { path: "/opt/{a}", params: [{ name: "a" }] },
        { path: "/opt", params: [] },
      ],
      warnings: [],
    });
  });

  it("an optional parameter under `warn` documents as one required path, with a warning", () => {
    const result = toOpenApiPath("/opt/:a?", { optionalParams: "warn" });
    expect(result.templates).toEqual([
      { path: "/opt/{a}", params: [{ name: "a" }] },
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/optional/);
  });

  it("an optional `{…}` group documents as two paths", () => {
    expect(toOpenApiPath("/a{/:b}")).toEqual({
      templates: [
        { path: "/a/{b}", params: [{ name: "b" }] },
        { path: "/a", params: [] },
      ],
      warnings: [],
    });
  });

  it("a mid-path optional parameter swallows its segment's slash", () => {
    const result = toOpenApiPath("/a/:b?/c");
    expect(result.templates.map((template) => template.path)).toEqual([
      "/a/{b}/c",
      "/a/c",
    ]);
  });

  it("a segment-internal parameter pair documents with a warning", () => {
    const result = toOpenApiPath("/slug/:a-:b");
    expect(result.templates).toEqual([
      { path: "/slug/{a}-{b}", params: [{ name: "a" }, { name: "b" }] },
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/poorly supported/);
  });

  it("a bare group or optional literal is undocumentable", () => {
    expect(toOpenApiPath("/a/(b)").undocumentable).toMatch(/bare/);
    expect(toOpenApiPath("/ab?c").undocumentable).toMatch(/optional literal/);
  });

  it("a repeated parameter or literal is undocumentable", () => {
    expect(toOpenApiPath("/r/:a+").undocumentable).toMatch(/repeats/);
    expect(toOpenApiPath("/r/:a*").undocumentable).toMatch(/repeats/);
  });

  it("a pathless `*` route is undocumentable", () => {
    expect(toOpenApiPath("*").undocumentable).toMatch(/pathless/);
  });

  it("is deterministic", () => {
    for (const path of ["/users/:id", "/re/:id(\\d+)", "/opt/:a?"]) {
      expect(toOpenApiPath(path)).toEqual(toOpenApiPath(path));
    }
  });
});

/* ------------------------------------------------------------------ *
 * A small router used across the suites.
 * ------------------------------------------------------------------ */
const IdParams = z.object({ id: z.string() });
const SearchQuery = z.object({
  q: z.string().min(1),
  tags: z.array(z.string()).optional(),
});
const NewUser = z.object({ name: z.string().min(2) });
const User = z.object({ id: z.string(), name: z.string() });

function basicRouter(): BunRouter {
  const router = new BunRouter();
  router
    .get(
      "/users/:id",
      validate(
        { params: IdParams, query: SearchQuery },
        { responses: { 200: User, 404: null } },
      ),
      (req, res) => res.json({ id: req.params.id, name: "ada" }),
    )
    .describe({ summary: "Read one user", tags: ["Users"] });
  router
    .post(
      "/users",
      validate({ body: NewUser }, { responses: { 201: User } }),
      (req, res) => res.status(201).json({ id: "u_1", name: req.body.name }),
    )
    .describe({ summary: "Create a user", tags: ["Users"] });
  return router;
}

/** An operation out of a document. */
function op(
  document: OpenApiDocument,
  path: string,
  method: string,
): Record<string, any> {
  return (document.paths as Record<string, Record<string, any>>)[path]?.[
    method
  ];
}

describe("generateOpenApi: the basics", () => {
  it("documents a validated router: paths, parameters, bodies, responses", () => {
    const { document, warnings } = generateOpenApi(basicRouter(), {
      title: "T",
      version: "1.0.0",
    });
    expect(warnings).toEqual([]);
    expect(document.openapi).toBe("3.1.2");
    expect(document.info).toEqual({ title: "T", version: "1.0.0" });
    expect(document.servers).toEqual([{ url: "/" }]);

    const read = op(document, "/users/{id}", "get");
    expect(read.operationId).toBe("getUsersById");
    expect(read.summary).toBe("Read one user");
    expect(read.tags).toEqual(["Users"]);
    expect(read.parameters).toEqual([
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "q",
        in: "query",
        required: true,
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "tags",
        in: "query",
        required: false,
        schema: { type: "array", items: { type: "string" } },
        style: "form",
        explode: true,
      },
    ]);
    // A response of `null` has no content; a declared one has its schema.
    expect(Object.keys(read.responses)).toEqual(["200", "404"]);
    expect(read.responses["200"].description).toBe("OK");
    expect(
      read.responses["200"].content["application/json"].schema.properties,
    ).toHaveProperty("id");
    expect(read.responses["404"].content).toBeUndefined();

    const create = op(document, "/users", "post");
    expect(create.operationId).toBe("postUsers");
    expect(create.requestBody).toEqual({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: { name: { type: "string", minLength: 2 } },
            required: ["name"],
          },
        },
      },
    });
    expect(Object.keys(create.responses)).toEqual(["201"]);
  });

  it("hidden routes and the filter drop operations", () => {
    const router = basicRouter();
    router
      .get("/healthz", (_req, res) => res.json({ ok: true }))
      .describe({ hidden: true });
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
      filter: (route) => route.method === "GET",
    });
    expect(Object.keys(document.paths as object).sort()).toEqual([
      "/users/{id}",
    ]);
    // The GET keeps its responses; nothing warns about what was dropped.
    expect(warnings).toEqual([]);
  });

  it("a route with no declared responses gets a placeholder `default`, and strict rejects it", () => {
    const router = new BunRouter();
    router.get("/bare", (_req, res) => res.json({}));
    const lenient = generateOpenApi(router, { title: "T", version: "1" });
    expect(
      (
        op(lenient.document, "/bare", "get").responses as Record<
          string,
          unknown
        >
      ).default,
    ).toEqual({ description: "Unspecified" });
    expect(
      lenient.warnings.some((warning) =>
        warning.message.includes("no responses declared"),
      ),
    ).toBe(true);
    expect(() =>
      generateOpenApi(router, { title: "T", version: "1", strict: "strict" }),
    ).toThrow(ConfigError);
  });

  it("strict escalates every warning to one ConfigError naming them all", () => {
    const router = new BunRouter();
    router.get("/files/*rest", (_req, res) => res.json({}));
    router.get("/bare", (_req, res) => res.json({}));
    let caught: unknown;
    try {
      generateOpenApi(router, { title: "T", version: "1", strict: "strict" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const message = (caught as ConfigError).message;
    expect(message).toContain("wildcard");
    expect(message).toContain("no responses declared");
    expect(
      ((caught as ConfigError).details?.warnings as unknown[]).length,
    ).toBe(2);
    // Lenient on the same router: a document, and the same warnings collected.
    const lenient = generateOpenApi(router, { title: "T", version: "1" });
    expect(Object.keys(lenient.document.paths as object)).toEqual(["/bare"]);
    expect(lenient.warnings.length).toBe(2);
  });

  it("an undocumentable path is left out, warned in lenient and thrown in strict", () => {
    const router = new BunRouter();
    router
      .get("/files/*rest", (_req, res) => res.json({}))
      .describe({ summary: "Files" });
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
    });
    expect(document.paths).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      stage: "path",
      route: "GET /files/*rest",
    });
    expect(() =>
      generateOpenApi(router, { title: "T", version: "1", strict: "strict" }),
    ).toThrow(/wildcard/);
  });

  it("the first registration wins a method+path collision; strict throws", () => {
    const router = new BunRouter();
    router
      .get("/dup", (_req, res) => res.json({ first: true }))
      .describe({ summary: "First" });
    router
      .get("/dup", (_req, res) => res.json({ second: true }))
      .describe({ summary: "Second" });
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
    });
    expect(op(document, "/dup", "get").summary).toBe("First");
    expect(
      warnings.some((warning) => warning.message.includes("two routes")),
    ).toBe(true);
    expect(() =>
      generateOpenApi(router, { title: "T", version: "1", strict: "strict" }),
    ).toThrow(/two routes/);
  });

  it("a duplicate operation id is a ConfigError in either mode, never a rename", () => {
    const router = new BunRouter();
    router
      .get("/a", (_req, res) => res.json({}))
      .describe({ operationId: "same" });
    router
      .get("/b", (_req, res) => res.json({}))
      .describe({ operationId: "same" });
    for (const strict of ["lenient", "strict"] as const) {
      expect(() =>
        generateOpenApi(router, { title: "T", version: "1", strict }),
      ).toThrow(/operation id "same"/);
    }
  });

  it("a custom operationId namer and the documented derivation", () => {
    const router = new BunRouter();
    router.get("/users/:id/posts", (_req, res) => res.json([]));
    const derived = generateOpenApi(router, { title: "T", version: "1" });
    expect(op(derived.document, "/users/{id}/posts", "get").operationId).toBe(
      "getUsersByIdPosts",
    );
    const named = generateOpenApi(router, {
      title: "T",
      version: "1",
      operationId: (route) => `op:${route.key}`,
    });
    expect(op(named.document, "/users/{id}/posts", "get").operationId).toBe(
      "op:GET /users/:id/posts",
    );
  });

  it("a regex-constrained route is partial and warns that its middleware was not replayed", () => {
    const router = new BunRouter();
    router.use("/re", (req, _res, next) => {
      void req;
      next();
    });
    router.get("/re/:id(\\d+)", (_req, res) => res.json({}));
    const { warnings } = generateOpenApi(router, { title: "T", version: "1" });
    expect(
      warnings.some(
        (warning) =>
          warning.message.includes("was not replayed") &&
          warning.route === "GET /re/:id(\\d+)",
      ),
    ).toBe(true);
  });

  it("an `all()` route is skipped with a warning", () => {
    const router = new BunRouter();
    router.all("/anything", (_req, res) => res.json({}));
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
    });
    expect(document.paths).toEqual({});
    expect(warnings.some((warning) => warning.message.includes("all()"))).toBe(
      true,
    );
  });

  it("is deterministic: two calls deep-equal", () => {
    const router = basicRouter();
    const first = generateOpenApi(router, { title: "T", version: "1" });
    const second = generateOpenApi(router, { title: "T", version: "1" });
    expect(second.document).toEqual(first.document);
    expect(second.warnings).toEqual(first.warnings);
  });

  it("document-wide security, and a per-operation override", () => {
    const router = new BunRouter();
    router
      .get("/open", (_req, res) => res.json({}))
      .describe({ security: [], responses: { 200: { schema: User } } });
    router
      .get("/closed", (_req, res) => res.json({}))
      .describe({ responses: { 200: { schema: User } } });
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    });
    expect(warnings).toEqual([]);
    expect(document.security).toEqual([{ bearer: [] }]);
    expect(
      (document.components as Record<string, unknown>).securitySchemes,
    ).toEqual({ bearer: { type: "http", scheme: "bearer" } });
    expect(op(document, "/open", "get").security).toEqual([]);
    expect(op(document, "/closed", "get").security).toBeUndefined();
  });

  it("a security requirement naming an undeclared scheme is a ConfigError", () => {
    const router = new BunRouter();
    router.get("/x", (_req, res) => res.json({}));
    expect(() =>
      generateOpenApi(router, {
        title: "T",
        version: "1",
        securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
        security: [{ oauth: [] }],
      }),
    ).toThrow(/does not declare/);
  });

  it("tags collect the used ones, described from options.tags", () => {
    const { document } = generateOpenApi(basicRouter(), {
      title: "T",
      version: "1",
      tags: { Users: { description: "User management" } },
    });
    expect(document.tags).toEqual([
      { name: "Users", description: "User management" },
    ]);
  });

  it("deprecated and x- extensions land on the operation", () => {
    const router = new BunRouter();
    router
      .get("/old", (_req, res) => res.json({}))
      .describe({
        deprecated: true,
        extensions: { "x-audience": "partners" },
        responses: { 200: null },
      });
    const operation = op(
      generateOpenApi(router, { title: "T", version: "1" }).document,
      "/old",
      "get",
    );
    expect(operation.deprecated).toBe(true);
    expect(operation["x-audience"]).toBe("partners");
  });
});

/* ------------------------------------------------------------------ *
 * The request side.
 * ------------------------------------------------------------------ */
describe("generateOpenApi: the request side", () => {
  it('documents cookies as `in: "cookie"` parameters (plan §4.11)', () => {
    const router = new BunRouter();
    router.get(
      "/me",
      validate(
        {
          cookies: z.object({ session: z.string() }),
          signedCookies: z.object({ token: z.string() }),
          headers: z.object({ "x-tenant": z.string() }),
        },
        { responses: { 200: User } },
      ),
      (_req, res) => res.json({ id: "u_1", name: "ada" }),
    );
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
    });
    expect(warnings).toEqual([]);
    const parameters = op(document, "/me", "get").parameters;
    expect(parameters).toContainEqual({
      name: "session",
      in: "cookie",
      required: true,
      schema: { type: "string" },
    });
    expect(parameters).toContainEqual({
      name: "token",
      in: "cookie",
      required: true,
      description: "A signed cookie.",
      schema: { type: "string" },
    });
    expect(parameters).toContainEqual({
      name: "x-tenant",
      in: "header",
      required: true,
      schema: { type: "string" },
    });
  });

  it("an optional body is not required (bodyPlacement, plan §4.12 m6)", () => {
    const router = new BunRouter();
    router.post(
      "/maybe",
      validate(
        { body: z.object({ note: z.string() }).optional() },
        { responses: { 200: User } },
      ),
      (_req, res) => res.json({ id: "u_1", name: "ada" }),
    );
    const { document } = generateOpenApi(router, { title: "T", version: "1" });
    expect(op(document, "/maybe", "post").requestBody.required).toBe(false);
  });

  it(".describe({ request }) replaces a discovered target wholesale", () => {
    const router = new BunRouter();
    router.get(
      "/things",
      validate(
        { query: z.object({ ignored: z.string() }) },
        { responses: { 200: User } },
      ),
      (_req, res) => res.json({ id: "u_1", name: "ada" }),
    );
    // Agreeing override: no warning, the override's shape.
    const agreeing = generateOpenApi(router, { title: "T", version: "1" });
    expect(agreeing.warnings).toEqual([]);

    const disagreeing = new BunRouter();
    disagreeing
      .get(
        "/things",
        validate(
          { query: z.object({ ignored: z.string() }) },
          { responses: { 200: User } },
        ),
        (_req, res) => res.json({ id: "u_1", name: "ada" }),
      )
      .describe({ request: { query: z.object({ page: z.coerce.number() }) } });
    const { document, warnings } = generateOpenApi(disagreeing, {
      title: "T",
      version: "1",
    });
    expect(
      warnings.some(
        (warning) =>
          warning.stage === "request" &&
          warning.message.includes("request.query") &&
          warning.message.includes("disagrees"),
      ),
    ).toBe(true);
    const parameters = op(document, "/things", "get").parameters;
    expect(parameters.map((param: { name: string }) => param.name)).toEqual([
      "page",
    ]);
  });

  it("a .describe() params key the path does not declare warns and is dropped", () => {
    const router = new BunRouter();
    router
      .get("/users/:id", (_req, res) => res.json({}))
      .describe({
        request: { params: z.object({ id: z.string(), other: z.string() }) },
        responses: { 200: { schema: User } },
      });
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
    });
    expect(
      warnings.some((warning) => warning.message.includes('"other"')),
    ).toBe(true);
    expect(
      op(document, "/users/{id}", "get").parameters.map(
        (param: { name: string }) => param.name,
      ),
    ).toEqual(["id"]);
  });

  it(".describe({ request: { body } }) honours requestMediaTypes and requestRequired", () => {
    const router = new BunRouter();
    router
      .post("/import", (_req, res) => res.json({}))
      .describe({
        request: { body: z.object({ row: z.string() }) },
        requestMediaTypes: ["application/json", "application/x-ndjson"],
        requestRequired: false,
        responses: { 200: { schema: User } },
      });
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
    });
    expect(warnings).toEqual([]);
    const body = op(document, "/import", "post").requestBody;
    expect(body.required).toBe(false);
    expect(Object.keys(body.content).sort()).toEqual([
      "application/json",
      "application/x-ndjson",
    ]);
  });

  it("a regex-constrained path param carries its pattern", () => {
    const router = new BunRouter();
    router
      .get("/re/:id(\\d+)", (_req, res) => res.json({}))
      .describe({ responses: { 200: { schema: User } } });
    const { document } = generateOpenApi(router, { title: "T", version: "1" });
    expect(op(document, "/re/{id}", "get").parameters).toEqual([
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^(?:\\d+)$" },
      },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * The response side.
 * ------------------------------------------------------------------ */
describe("generateOpenApi: the response side", () => {
  it("documents response headers and Set-Cookie", () => {
    const router = new BunRouter();
    router.get(
      "/me",
      validate(
        {},
        {
          responses: {
            200: {
              headers: z.object({ "x-request-id": z.string() }),
              cookies: z.object({ session: z.any() }),
              content: { "application/json": User },
            },
          },
        },
      ),
      (_req, res) => res.json({ id: "u_1", name: "ada" }),
    );
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
    });
    expect(warnings).toEqual([]);
    const response = op(document, "/me", "get").responses["200"];
    expect(response.headers["x-request-id"]).toEqual({
      required: true,
      schema: { type: "string" },
    });
    expect(response.headers["Set-Cookie"]).toEqual({
      description: "Sets the cookie `session`.",
      schema: { type: "string" },
    });
  });

  it("a variants status: oneOf bodies, variant-only headers required:false, the x-variants table", () => {
    const router = new BunRouter();
    router.get(
      "/users/:id",
      validate(
        { params: IdParams },
        {
          responses: {
            200: variants(
              {
                full: {
                  description: "The whole record.",
                  headers: z.object({ "x-full": z.literal("yes") }),
                  content: { "application/json": User },
                },
                empty: {
                  content: null,
                },
              },
              {
                by: { header: "x-view" },
              },
            ),
          },
        },
      ),
      (_req, res) => res.json({ id: "u_1", name: "ada" }),
    );
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
    });
    expect(warnings).toEqual([]);
    const response = op(document, "/users/{id}", "get").responses["200"];
    expect(response.headers["x-full"].required).toBe(false);
    expect(response.headers["x-full"].description).toMatch(/full/);
    // Only `full` has a body: one schema, no oneOf needed.
    expect(
      response.content["application/json"].schema.properties,
    ).toHaveProperty("id");
    expect(response["x-variants"]).toMatchObject({
      names: ["full", "empty"],
      by: { part: "headers", name: "x-view" },
      variants: {
        full: { headers: ["x-full"], mediaTypes: ["application/json"] },
        empty: { headers: [], mediaTypes: [] },
      },
    });
  });

  it("two variants over one media type become a oneOf", () => {
    const Admin = z.object({ role: z.literal("admin") });
    const Member = z.object({ role: z.literal("member") });
    const router = new BunRouter();
    router.get(
      "/who",
      validate(
        {},
        {
          responses: {
            200: variants(
              {
                admin: { content: { "application/json": Admin } },
                member: { content: { "application/json": Member } },
              },
              { by: { cookie: "role" } },
            ),
          },
        },
      ),
      (_req, res) => res.json({ role: "admin" }),
    );
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
    });
    expect(warnings).toEqual([]);
    const response = op(document, "/who", "get").responses["200"];
    const oneOf = response.content["application/json"].schema.oneOf;
    expect(oneOf).toHaveLength(2);
    expect(
      oneOf[0].properties.role.const ?? oneOf[0].properties.role.enum,
    ).toBeDefined();
    expect(response["x-variants"].by).toEqual({
      part: "cookies",
      name: "role",
      values: { admin: "admin", member: "member" },
    });
  });

  it('an implicit 400 from onFailure: "respond" is included, marked', () => {
    const router = new BunRouter();
    router.get(
      "/q",
      validate(
        { query: SearchQuery },
        { onFailure: "respond", responses: { 200: User } },
      ),
      (_req, res) => res.json({ id: "u_1", name: "ada" }),
    );
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
    });
    expect(warnings).toEqual([]);
    const badRequest = op(document, "/q", "get").responses["400"];
    expect(badRequest["x-implicit"]).toBe(true);
    expect(badRequest.description).toMatch(/framework/);
    expect(
      badRequest.content["application/json"].schema.properties,
    ).toHaveProperty("issues");
  });

  it("chunks, sse and opaque bodies (plan §4.12 M4)", () => {
    const Row = z.object({ n: z.number() });
    const router = new BunRouter();
    router.get(
      "/stream",
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
      (_req, res) => res.send(""),
    );
    router.get(
      "/events",
      validate(
        {},
        {
          responses: {
            200: {
              content: { "text/event-stream": sse({ tick: Row, note: null }) },
            },
          },
        },
      ),
      (_req, res) => res.send(""),
    );
    router.get(
      "/logo",
      validate(
        {},
        { responses: { 200: { content: { "image/png": opaque() } } } },
      ),
      (_req, res) => res.send(""),
    );
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
    });
    expect(warnings).toEqual([]);

    const streamed = op(document, "/stream", "get").responses["200"].content[
      "application/x-ndjson"
    ].schema;
    expect(streamed.description).toMatch(/newline-delimited/);
    expect(streamed.properties).toHaveProperty("n");

    const events = op(document, "/events", "get").responses["200"].content[
      "text/event-stream"
    ].schema;
    expect(events.type).toBe("string");
    expect(events.description).toMatch(/Server-sent events/);
    expect(events["x-sse-events"].tick.properties).toHaveProperty("n");
    expect(events["x-sse-events"].note).toBeNull();

    const image = op(document, "/logo", "get").responses["200"].content[
      "image/png"
    ].schema;
    expect(image.description).toMatch(/opaque/);
  });

  it('responses convert with "input", except under responseOutput: "parsed"', () => {
    const WithDefault = z.object({
      name: z.string(),
      role: z.enum(["admin", "user"]).default("user"),
    });
    const plain = new BunRouter();
    plain.get(
      "/u",
      validate({}, { responses: { 200: WithDefault } }),
      (_req, res) => res.json({ name: "ada", role: "user" }),
    );
    const parsed = new BunRouter({ responseOutput: "parsed" });
    parsed.get(
      "/u",
      validate({}, { responses: { 200: WithDefault } }),
      (_req, res) => res.json({ name: "ada", role: "user" }),
    );
    const plainSchema = op(
      generateOpenApi(plain, { title: "T", version: "1" }).document,
      "/u",
      "get",
    ).responses["200"].content["application/json"].schema;
    expect(plainSchema.required).toEqual(["name"]);
    const parsedSchema = op(
      generateOpenApi(parsed, { title: "T", version: "1" }).document,
      "/u",
      "get",
    ).responses["200"].content["application/json"].schema;
    expect(parsedSchema.required).toEqual(["name", "role"]);
  });

  it("Decision 4: the validator beats .describe() on a disagreement, with a warning", () => {
    const router = new BunRouter();
    router
      .get(
        "/users/:id",
        validate({ params: IdParams }, { responses: { 200: User } }),
        (req, res) => res.json({ id: req.params.id, name: "ada" }),
      )
      .describe({
        responses: {
          200: { schema: z.object({ wrong: z.string() }) },
          404: { description: "No such user" },
        },
      });
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
    });
    expect(
      warnings.some(
        (warning) =>
          warning.stage === "response" && warning.message.includes("wins"),
      ),
    ).toBe(true);
    const responses = op(document, "/users/{id}", "get").responses;
    // The validator's 200, not the .describe() one…
    expect(
      responses["200"].content["application/json"].schema.properties,
    ).toHaveProperty("id");
    expect(
      responses["200"].content["application/json"].schema.properties,
    ).not.toHaveProperty("wrong");
    // …and the .describe()-only 404 lands verbatim.
    expect(responses["404"].description).toBe("No such user");
  });

  it("a no-validator route gets the .describe() document verbatim", () => {
    const router = new BunRouter();
    router
      .get("/legacy", (_req, res) => res.json({}))
      .describe({
        summary: "Legacy",
        responses: {
          200: {
            description: "Fine",
            schema: { type: "object", properties: { ok: { type: "boolean" } } },
            examples: { one: { summary: "an ok", value: { ok: true } } },
          },
          204: null,
        },
      });
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
    });
    expect(warnings).toEqual([]);
    const responses = op(document, "/legacy", "get").responses;
    expect(responses["200"].description).toBe("Fine");
    expect(responses["200"].content["application/json"].schema).toEqual({
      type: "object",
      properties: { ok: { type: "boolean" } },
    });
    expect(responses["200"].content["application/json"].examples).toEqual({
      one: { summary: "an ok", value: { ok: true } },
    });
    expect(responses["204"].content).toBeUndefined();
  });

  it("documented() rows carry their JSON Schema; a component name dedups shared schemas", () => {
    const Note = documented<{ text: string }>({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    const router = new BunRouter();
    router.get("/a", validate({}, { responses: { 200: Note } }), (_req, res) =>
      res.json({ text: "a" }),
    );
    router.get("/b", validate({}, { responses: { 200: Note } }), (_req, res) =>
      res.json({ text: "b" }),
    );
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
      componentName: () => "Note",
    });
    expect(warnings).toEqual([]);
    expect((document.components as Record<string, unknown>).schemas).toEqual({
      Note: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    });
    expect(
      op(document, "/a", "get").responses["200"].content["application/json"]
        .schema,
    ).toEqual({ $ref: "#/components/schemas/Note" });
    expect(danglingRefs(document)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * .describe() — the store and the method.
 * ------------------------------------------------------------------ */
describe(".describe()", () => {
  it("chains (returns this), beside setName", () => {
    const router = new BunRouter();
    const returned = router
      .get("/x", (_req, res) => res.json({}))
      .describe({ summary: "X" })
      .setName("x")
      .describe({ deprecated: true });
    expect(returned).toBe(router);
    const { document } = generateOpenApi(router, { title: "T", version: "1" });
    // Two calls merge, last write winning per key.
    expect(op(document, "/x", "get").summary).toBe("X");
    expect(op(document, "/x", "get").deprecated).toBe(true);
  });

  it("throws a TypeError after a middleware registration", () => {
    const router = new BunRouter();
    router.use((_req, _res, next) => next());
    expect(() => router.describe({ summary: "no" })).toThrow(TypeError);
    expect(() => router.describe({ summary: "no" })).toThrow(
      /can not describe middleware/,
    );
    const mounted = new BunRouter();
    const sub = new BunRouter();
    sub.get("/in", (_req, res) => res.json({}));
    mounted.use("/sub", sub);
    expect(() => mounted.describe({ summary: "no" })).toThrow(TypeError);
  });

  it("survives use(subRouter) mounting: the sub-router's docs land on the flattened routes", () => {
    const sub = new BunRouter();
    sub
      .get("/posts/:postId", (_req, res) => res.json({}))
      .describe({
        summary: "Read one post",
        responses: { 200: { schema: User } },
      });
    const root = new BunRouter();
    root.use("/api", sub);
    const { document, warnings } = generateOpenApi(root, {
      title: "T",
      version: "1",
    });
    expect(warnings).toEqual([]);
    expect(op(document, "/api/posts/{postId}", "get").summary).toBe(
      "Read one post",
    );
  });

  it("a double-mounted sub-router shares the doc (and derives per-path operation ids)", () => {
    const sub = new BunRouter();
    sub
      .get("/posts", (_req, res) => res.json([]))
      .describe({
        summary: "List posts",
        responses: { 200: { schema: User } },
      });
    const root = new BunRouter();
    root.use("/a", sub);
    root.use("/b", sub);
    const { document, warnings } = generateOpenApi(root, {
      title: "T",
      version: "1",
    });
    expect(warnings).toEqual([]);
    expect(op(document, "/a/posts", "get").summary).toBe("List posts");
    expect(op(document, "/b/posts", "get").summary).toBe("List posts");
    expect(op(document, "/a/posts", "get").operationId).toBe("getAPosts");
    expect(op(document, "/b/posts", "get").operationId).toBe("getBPosts");
  });

  it("is keyed on the terminal callback: the same handler registered twice shares its doc", () => {
    const handler = (_req: unknown, res: { json: (v: unknown) => void }) =>
      res.json({});
    const router = new BunRouter();
    router.get("/one", handler as never).describe({
      summary: "Shared",
      responses: { 200: { schema: User } },
    });
    router.get("/two", handler as never);
    const { document } = generateOpenApi(router, { title: "T", version: "1" });
    expect(op(document, "/one", "get").summary).toBe("Shared");
    // The WeakMap is keyed on the function: the second registration of the
    // same handler reads the same doc. Documented, deliberate (Decision 1).
    expect(op(document, "/two", "get").summary).toBe("Shared");
  });
});

/* ------------------------------------------------------------------ *
 * §9.2 invariants.
 * ------------------------------------------------------------------ */
describe("generateOpenApi: the §9.2 invariants", () => {
  it("no dangling refs, on a router exercising components", () => {
    const router = basicRouter();
    const { document } = generateOpenApi(router, {
      title: "T",
      version: "1",
      componentName: (schema) =>
        typeof schema === "object" &&
        schema !== null &&
        "~standard" in schema &&
        (schema["~standard"] as { vendor?: string }).vendor === "zod"
          ? "Zod"
          : undefined,
    });
    expect(danglingRefs(document)).toEqual([]);
  });

  it("every path template's parameters equal the route's params, each required", () => {
    const router = new BunRouter();
    router
      .get("/users/:id/posts/:postId", (_req, res) => res.json({}))
      .describe({ responses: { 200: { schema: User } } });
    router
      .get("/opt/:a?", (_req, res) => res.json({}))
      .describe({ responses: { 200: { schema: User } } });
    const { document } = generateOpenApi(router, { title: "T", version: "1" });
    const expected: Record<string, string[]> = {
      "/users/{id}/posts/{postId}": ["id", "postId"],
      "/opt/{a}": ["a"],
      "/opt": [],
    };
    for (const [path, names] of Object.entries(expected)) {
      const operation = op(document, path, "get");
      const parameters = (operation.parameters ?? []) as {
        name: string;
        in: string;
        required: boolean;
      }[];
      const pathParams = parameters.filter((param) => param.in === "path");
      expect(pathParams.map((param) => param.name)).toEqual(names);
      for (const param of pathParams) {
        expect(param.required).toBe(true);
      }
    }
  });

  it("route/document parity: the real status of a synthesized request is declared", async () => {
    const router = basicRouter();
    router
      .get("/healthz", (_req, res) => res.json({ ok: true }))
      .describe({
        responses: { 200: { schema: z.object({ ok: z.boolean() }) } },
      });
    const { document, warnings } = generateOpenApi(router, {
      title: "T",
      version: "1",
    });
    expect(warnings).toEqual([]);
    const paths = document.paths as Record<
      string,
      Record<string, { responses: Record<string, unknown> }>
    >;
    for (const [path, item] of Object.entries(paths)) {
      // Synthesize a request path: each {param} filled with "1", the required
      // query of the /users route satisfied.
      const concrete =
        path.replaceAll(/\{[^}]+\}/g, "1") +
        (path === "/users/{id}" ? "?q=x" : "");
      for (const [method, operation] of Object.entries(item)) {
        const response = await router.fetch(concrete, {
          method: method.toUpperCase(),
          ...(method === "post"
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name: "ada" }),
              }
            : {}),
        });
        expect(
          Object.hasOwn(operation.responses, String(response.status)),
          `${method.toUpperCase()} ${concrete} answered ${response.status}, which the document does not declare`,
        ).toBe(true);
      }
    }
  });
});
