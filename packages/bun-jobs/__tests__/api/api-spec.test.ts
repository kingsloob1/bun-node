import type {
  JobsApiConfig,
  OpenApiDocument,
  OpenApiSecurityScheme,
} from "../../lib/api/config";
import type { AnyRouteDef } from "../../lib/api/routes/define";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { resolveConfig } from "../../lib/api/config";
import {
  buildJobsApi,
  builtInRoutes,
  createJobsApi,
} from "../../lib/api/createJobsApi";
import { defineRoute } from "../../lib/api/routes/define";
import { s } from "../../lib/api/schema/builder";
import { generateOpenApi, toOpenApiPath } from "../../lib/api/spec/openapi";
import {
  collectRefs,
  danglingRefs,
  pruneSchemaComponents,
  resolveRef,
} from "../../lib/api/spec/refs";
import { toAsyncApiSecurityScheme } from "../../lib/api/spec/security";
import { ConfigError } from "../../lib/index";
import { apiConfig, openContexts, testRoutes } from "./fixtures";

afterAll(async () => {
  await Promise.all(openContexts.map((jobs) => jobs.close()));
});

const schemes: Record<string, OpenApiSecurityScheme> = {
  bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
  apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
};

/** The document for a configuration, over the built-in and test routes. */
function documentFor(overrides: Partial<JobsApiConfig> = {}): OpenApiDocument {
  const resolved = resolveConfig(apiConfig(overrides));
  return buildJobsApi(resolved, [
    ...builtInRoutes(resolved),
    ...testRoutes(),
  ]).openapi();
}

/** Every combination the spec must be valid in. */
const MATRIX = (["jobs", "runner", "both"] as const).flatMap((mode) =>
  [false, true].flatMap((readOnly) =>
    [false, true].map((security) => ({
      name: `mode ${mode}, readOnly ${readOnly}, security ${security ? "on" : "off"}`,
      overrides: {
        mode,
        readOnly,
        ...(security ? { docs: { securitySchemes: schemes } } : {}),
      } satisfies Partial<JobsApiConfig>,
    })),
  ),
);

/** An operation out of a document. */
function op(document: OpenApiDocument, path: string, method: string) {
  return (
    document.paths as Record<string, Record<string, Record<string, unknown>>>
  )[path]![method]!;
}

describe("the generated document", () => {
  it("resolves every $ref and keeps operation ids unique, in every combination", () => {
    for (const { name, overrides } of MATRIX) {
      const document = documentFor(overrides);
      expect({ name, dangling: danglingRefs(document) }).toEqual({
        name,
        dangling: [],
      });
      const ids = Object.values(
        document.paths as Record<
          string,
          Record<string, { operationId: string }>
        >,
      )
        .flatMap((item) => Object.values(item))
        .map((operation) => operation.operationId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBeGreaterThan(0);
    }
  });

  it("converts paths and describes parameters, arrays as form/explode", () => {
    const document = documentFor();
    const retry = op(document, "/queues/{queue}/items/{id}/retry", "post");
    expect(retry.parameters).toEqual([
      {
        name: "queue",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^[\\w.-]+$" },
      },
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "integer", minimum: 1 },
      },
      {
        name: "state",
        in: "query",
        required: false,
        schema: {
          type: "array",
          items: { $ref: "#/components/schemas/JobState" },
        },
        style: "form",
        explode: true,
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, default: 20 },
      },
    ]);
    expect(retry.requestBody).toEqual({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              ids: { type: "array", items: { type: "string" }, maxItems: 2 },
            },
            required: ["ids"],
            additionalProperties: false,
          },
        },
      },
    });
    // A path parameter with no schema is still declared, as a string.
    expect(op(document, "/runners/{runner}/thing", "get").parameters).toEqual([
      {
        name: "runner",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ]);
  });

  it("documents responses and problems, with codes and extensions", () => {
    const document = documentFor();
    const retry = op(document, "/queues/{queue}/items/{id}/retry", "post");
    const responses = retry.responses as Record<
      string,
      Record<string, unknown>
    >;

    expect(responses["200"]).toEqual({
      description: "OK",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/TestItem" },
        },
      },
    });
    expect(responses["204"]).toEqual({ description: "No Content" });
    expect(responses["400"]!["x-bun-jobs-codes"]).toEqual([
      "BULK_LIMIT",
      "INVALID_JSON",
      "VALIDATION",
    ]);
    expect(responses["401"]!["x-bun-jobs-codes"]).toEqual(["UNAUTHORIZED"]);
    expect(responses["403"]!["x-bun-jobs-codes"]).toEqual([
      "CSRF_REJECTED",
      "FORBIDDEN",
    ]);
    expect(responses["404"]!["x-bun-jobs-codes"]).toEqual(["QUEUE_NOT_FOUND"]);
    expect(responses["413"]!["x-bun-jobs-codes"]).toEqual([
      "PAYLOAD_TOO_LARGE",
    ]);
    expect(responses["415"]!["x-bun-jobs-codes"]).toEqual([
      "UNSUPPORTED_MEDIA_TYPE",
    ]);
    expect(responses["403"]!.content).toEqual({
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/Problem" },
      },
    });
    expect(responses.default).toEqual({
      $ref: "#/components/responses/Problem",
    });

    expect(retry["x-bun-jobs-action"]).toBe("jobs.retry");
    expect(retry["x-bun-jobs-mutation"]).toBe(true);
    expect(retry["x-bun-jobs-requires"]).toEqual([]);
    expect(op(document, "/logs-test", "get")["x-bun-jobs-requires"]).toEqual([
      "getJobLogs",
    ]);

    // A read with no inputs gets no validation or CSRF problems.
    const meta = op(document, "/meta", "get").responses as Record<
      string,
      unknown
    >;
    expect(Object.keys(meta).sort()).toEqual(["200", "401", "403", "default"]);
    // With CSRF off, mutations document no CSRF problems.
    const noCsrf = op(
      documentFor({ csrf: false }),
      "/queues/{queue}/items/{id}/retry",
      "post",
    );
    expect(
      (noCsrf.responses as Record<string, unknown>)["415"],
    ).toBeUndefined();
  });

  it("keeps only the components something reaches", () => {
    const schemasOf = (document: OpenApiDocument) =>
      Object.keys((document.components as { schemas: object }).schemas);

    expect(schemasOf(documentFor())).toEqual(
      expect.arrayContaining([
        "JobState",
        "Meta",
        "Permissions",
        "Problem",
        "TestItem",
        "TestRunnerThing",
      ]),
    );
    expect(schemasOf(documentFor({ mode: "jobs" }))).not.toContain(
      "TestRunnerThing",
    );
    expect(schemasOf(documentFor({ mode: "runner" }))).not.toContain(
      "TestItem",
    );
    expect(schemasOf(documentFor({ mode: "runner" }))).not.toContain(
      "JobState",
    );
    expect(schemasOf(documentFor({ readOnly: true }))).not.toContain(
      "TestItem",
    );
    // The Problem schema stays: every operation references it.
    expect(
      schemasOf(documentFor({ mode: "runner", readOnly: true })),
    ).toContain("Problem");
    // The API-wide schemas are always registered; with only the meta and docs
    // routes nothing reaches Error, JobRef, PageInfo or JobState, so pruning
    // must have removed them.
    const metaOnly = createJobsApi(
      apiConfig({ runners: false, actions: ["meta.read", "docs.read"] }),
    );
    expect(schemasOf(metaOnly.openapi()).sort()).toEqual([
      "ChannelPermission",
      "Meta",
      "MetaCsrf",
      "MetaLimits",
      "Permissions",
      "Problem",
    ]);
    // With the job routes, the shared schemas they use are kept.
    expect(schemasOf(createJobsApi(apiConfig()).openapi())).toEqual(
      expect.arrayContaining([
        "Error",
        "Job",
        "JobRef",
        "JobState",
        "PageInfo",
      ]),
    );
  });

  it("declares security from docs, and says so when there is none", () => {
    const secured = documentFor({ docs: { securitySchemes: schemes } });
    expect(
      (secured.components as { securitySchemes: unknown }).securitySchemes,
    ).toEqual(schemes);
    expect(secured.security).toEqual([{ bearer: [] }, { apiKey: [] }]);

    const chosen = documentFor({
      docs: { securitySchemes: schemes, security: [{ bearer: [] }] },
    });
    expect(chosen.security).toEqual([{ bearer: [] }]);

    const open = documentFor();
    expect(open.security).toBeUndefined();
    expect(open.components).not.toHaveProperty("securitySchemes");
    expect((open.info as { description: string }).description).toMatch(
      /declares no security schemes/,
    );

    expect(() =>
      createJobsApi(
        apiConfig({
          docs: { securitySchemes: schemes, security: [{ oauth: [] }] },
        }),
      ),
    ).toThrow(/does not declare/);
    expect(() =>
      createJobsApi(apiConfig({ docs: { security: [{ bearer: [] }] } })),
    ).toThrow(/declares none/);
  });

  it("defaults servers to basePath, and takes title, version and servers from docs", () => {
    const plain = createJobsApi(apiConfig()).openapi();
    expect(plain.servers).toEqual([{ url: "/admin/jobs" }]);
    expect((plain.info as { title: string }).title).toBe(
      "bun-jobs management API (api-routes)",
    );
    expect((plain.info as { version: string }).version).toMatch(
      /^\d+\.\d+\.\d+/,
    );

    const custom = createJobsApi(
      apiConfig({
        docs: {
          title: "Ops",
          version: "9.9.9",
          servers: [{ url: "https://ops.example/jobs" }],
        },
      }),
    ).openapi();
    expect(custom.info).toMatchObject({ title: "Ops", version: "9.9.9" });
    expect(custom.servers).toEqual([{ url: "https://ops.example/jobs" }]);
  });
});

describe("generator guards", () => {
  const config = () => resolveConfig(apiConfig());
  const base = (): AnyRouteDef =>
    defineRoute({
      method: "GET",
      path: "/a/:id",
      operationId: "a",
      action: "jobs.read",
      mode: "any",
      summary: "a",
      tags: [],
      responses: { 200: s.object({}) },
      handler: () => ({ body: {} }),
    });

  it("converts Express paths and refuses what OpenAPI cannot describe", () => {
    expect(toOpenApiPath("/queues/:queue/jobs/:id")).toEqual({
      path: "/queues/{queue}/jobs/{id}",
      names: ["queue", "id"],
    });
    expect(() => toOpenApiPath("/a/:id?")).toThrow(/optional parameter/);
    expect(() => toOpenApiPath("/a/*rest")).toThrow(/cannot describe/);
  });

  it("refuses duplicate operation ids, stray params and undocumentable codes", () => {
    expect(() =>
      generateOpenApi([base(), { ...base(), path: "/b" }], config()),
    ).toThrow(ConfigError);
    expect(() =>
      generateOpenApi(
        [{ ...base(), params: s.query(s.object({ other: s.string() })) }],
        config(),
      ),
    ).toThrow(/does not have/);
    expect(() =>
      generateOpenApi([{ ...base(), errors: ["MADE_UP"] }], config()),
    ).toThrow(/no known status/);
    expect(() =>
      generateOpenApi(
        [
          {
            ...base(),
            responses: { 200: s.object({}), 404: null },
            errors: ["JOB_NOT_FOUND"],
          },
        ],
        config(),
      ),
    ).toThrow(/both as a response and as a problem/);
  });
});

describe("$ref utilities", () => {
  it("collects, resolves and reports dangling references", () => {
    const document = {
      a: { $ref: "#/defs/x~1y" },
      defs: { "x/y": { b: { $ref: "#/defs/missing" } } },
    };
    expect([...collectRefs(document)].sort()).toEqual([
      "#/defs/missing",
      "#/defs/x~1y",
    ]);
    expect(resolveRef(document, "#/defs/x~1y")).toEqual({
      b: { $ref: "#/defs/missing" },
    });
    expect(resolveRef(document, "https://elsewhere/x")).toBeUndefined();
    expect(danglingRefs(document)).toEqual(["#/defs/missing"]);
  });

  it("prunes unreachable schema components, following references transitively", () => {
    const document = {
      paths: { "/x": { $ref: "#/components/schemas/A" } },
      components: {
        schemas: {
          A: { properties: { b: { $ref: "#/components/schemas/B" } } },
          B: { type: "string" },
          Orphan: { $ref: "#/components/schemas/OrphanChild" },
          OrphanChild: { type: "string" },
        },
      },
    };
    pruneSchemaComponents(document);
    expect(Object.keys(document.components.schemas)).toEqual(["A", "B"]);
  });
});

describe("AsyncAPI security mapping", () => {
  it("maps each OpenAPI scheme type, with notes for browser sockets", () => {
    expect(toAsyncApiSecurityScheme(schemes.bearer!)).toMatchObject({
      scheme: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      browserNote: expect.stringContaining("Authorization"),
    });
    expect(
      toAsyncApiSecurityScheme({ type: "http", scheme: "basic" }).scheme,
    ).toEqual({
      type: "http",
      scheme: "basic",
    });
    expect(toAsyncApiSecurityScheme(schemes.apiKey!)).toEqual({
      scheme: { type: "httpApiKey", in: "header", name: "x-api-key" },
      browserNote: "A browser WebSocket cannot send the x-api-key header.",
    });
    expect(
      toAsyncApiSecurityScheme({ type: "apiKey", in: "query", name: "token" }),
    ).toEqual({
      scheme: { type: "httpApiKey", in: "query", name: "token" },
    });
    expect(
      toAsyncApiSecurityScheme({
        type: "oauth2",
        flows: {
          clientCredentials: {
            tokenUrl: "https://id.example/token",
            scopes: { "jobs:read": "Read" },
          },
        },
      }).scheme,
    ).toEqual({
      type: "oauth2",
      flows: {
        clientCredentials: {
          tokenUrl: "https://id.example/token",
          availableScopes: { "jobs:read": "Read" },
        },
      },
    });
    expect(
      toAsyncApiSecurityScheme({
        type: "openIdConnect",
        openIdConnectUrl: "https://id.example/.well-known",
      }).scheme,
    ).toEqual({
      type: "openIdConnect",
      openIdConnectUrl: "https://id.example/.well-known",
    });
  });
});

/*
 * Meta-schema validation.
 *
 * The OpenAPI 3.1 meta-schema is vendored at
 * `__tests__/fixtures/schemas/oas-3.1.json`, fetched from
 * https://spec.openapis.org/oas/3.1/schema/2022-10-07 on 2026-09-15 (its own
 * `$id` records the source). It needs ajv 8 with its draft 2020-12 build and
 * ajv-formats, which are devDependencies of bun-jobs.
 *
 * TODO(merge): until `bun install` has installed those devDependencies in the
 * workspace, `ajv/dist/2020` does not resolve and this block is skipped
 * (visibly). `BUN_JOBS_TEST_AJV_DIR` may point at a `node_modules` holding
 * them, to run it anyway.
 */

/** The ajv surface the validation uses. */
interface AjvLike {
  /** Compiles a schema into a validator. */
  compile: (
    schema: unknown,
  ) => ((data: unknown) => boolean) & { errors?: unknown };
  /** Registers a schema under a key. */
  addSchema: (schema: unknown, key?: string) => unknown;
  /** Registers a format. */
  addFormat: (name: string, format: boolean) => unknown;
}

/** Loads ajv 8 (draft 2020-12) with formats, from the workspace or `BUN_JOBS_TEST_AJV_DIR`. */
async function loadAjv(): Promise<AjvLike | undefined> {
  const roots = [
    "",
    ...(process.env.BUN_JOBS_TEST_AJV_DIR
      ? [`${process.env.BUN_JOBS_TEST_AJV_DIR}/`]
      : []),
  ];
  for (const root of roots) {
    try {
      const ajvSpecifier: string = `${root}ajv/dist/2020${root ? ".js" : ""}`;
      const formatsSpecifier: string = `${root}ajv-formats${root ? "/dist/index.js" : ""}`;
      const ajvModule = (await import(ajvSpecifier)) as { default?: unknown };
      const formatsModule = (await import(formatsSpecifier)) as {
        default?: unknown;
      };
      const Ajv = (ajvModule.default ?? ajvModule) as new (
        options: object,
      ) => AjvLike;
      const addFormats = (formatsModule.default ?? formatsModule) as (
        ajv: AjvLike,
      ) => void;
      const ajv = new Ajv({ strict: false, allErrors: true });
      addFormats(ajv);
      // The OAS schema names a `media-range` format ajv-formats does not
      // define; it annotates media types and constrains nothing generated here.
      ajv.addFormat("media-range", true);
      return ajv;
    } catch {
      // Not installed here; try the next root.
    }
  }
  return undefined;
}

const ajv = await loadAjv();

describe.skipIf(!ajv)("OpenAPI 3.1 meta-schema validation (ajv)", async () => {
  // `describe.skipIf` skips the cases, not the callback: without this the body
  // below still runs and `ajv!.compile` throws where ajv is not installed,
  // failing the file instead of skipping it.
  if (!ajv) {
    return;
  }
  const vendored = await Bun.file(
    new URL("../fixtures/schemas/oas-3.1.json", import.meta.url),
  ).text();
  // ajv 8 does not register the `$dynamicAnchor: "meta"` the OAS schema
  // declares under `$defs/schema`, and resolves `$dynamicRef: "#meta"` to the
  // document root instead — whose `unevaluatedProperties: false` then rejects
  // every schema keyword. For the default dialect (no `jsonSchemaDialect`, as
  // generated here) the anchor's target is exactly `$defs/schema`, so pointing
  // the reference there is the same check. The fixture itself is unchanged.
  const metaSchema = JSON.parse(
    vendored.replaceAll('"$dynamicRef": "#meta"', '"$ref": "#/$defs/schema"'),
  ) as Record<string, unknown>;
  expect(vendored).toContain('"$dynamicRef": "#meta"');
  const validateDocument = ajv!.compile(metaSchema);

  for (const { name, overrides } of MATRIX) {
    it(`is a valid OpenAPI 3.1 document: ${name}`, () => {
      const document = documentFor(overrides);
      const valid = validateDocument(document);
      expect({
        valid,
        errors: valid ? undefined : validateDocument.errors,
      }).toEqual({
        valid: true,
        errors: undefined,
      });
    });

    it(`compiles every component schema: ${name}`, () => {
      const document = documentFor(overrides);
      const key = `urn:bun-jobs:test:${name.replaceAll(/\W+/g, "-")}`;
      ajv!.addSchema({ $id: key, components: document.components }, key);
      for (const component of Object.keys(
        (document.components as { schemas: object }).schemas,
      )) {
        expect(() =>
          ajv!.compile({ $ref: `${key}#/components/schemas/${component}` }),
        ).not.toThrow();
      }
    });
  }

  it("rejects a broken document and an invalid schema (the controls)", () => {
    const document = documentFor();
    delete (document.info as { version?: string }).version;
    expect(validateDocument(document)).toBe(false);
    expect(() => ajv!.compile({ type: "strnig" })).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * AsyncAPI 3.0
 * ------------------------------------------------------------------ */

/** The AsyncAPI document for a configuration, over the built-in routes. */
function asyncDocumentFor(
  overrides: Partial<JobsApiConfig> = {},
): Record<string, any> | undefined {
  const resolved = resolveConfig(apiConfig(overrides));
  const api = buildJobsApi(resolved, builtInRoutes(resolved));
  const document = api.asyncapi();
  void api.close();
  return document;
}

describe("the generated AsyncAPI document", () => {
  it("resolves every $ref, and each operation's messages belong to its channel, in every combination", () => {
    for (const { name, overrides } of MATRIX) {
      const document = asyncDocumentFor(overrides)!;
      expect({ name, dangling: danglingRefs(document) }).toEqual({
        name,
        dangling: [],
      });
      for (const [id, operation] of Object.entries(
        document.operations as Record<
          string,
          { channel: { $ref: string }; messages: { $ref: string }[] }
        >,
      )) {
        for (const message of operation.messages) {
          expect({ id, ref: message.$ref }).toEqual({
            id,
            ref: expect.stringMatching(
              new RegExp(`^${operation.channel.$ref}/messages/`),
            ),
          });
        }
      }
    }
    // The control: removing a component the document uses leaves it dangling.
    const broken = asyncDocumentFor()!;
    delete broken.components.messages["queue.added"];
    expect(danglingRefs(broken)).toContain("#/components/messages/queue.added");
  });

  it("prunes channels, operations, messages and schemas by mode", () => {
    const channelsOf = (document: Record<string, any>) =>
      Object.keys(document.channels).sort();
    const messagesOf = (document: Record<string, any>) =>
      Object.keys(document.components.messages);
    const schemasOf = (document: Record<string, any>) =>
      Object.keys(document.components.schemas);

    const both = asyncDocumentFor({ mode: "both" })!;
    expect(channelsOf(both)).toEqual([
      "all",
      "connection",
      "job",
      "queue",
      "queues",
      "runner",
      "runners",
    ]);
    expect(messagesOf(both)).toEqual(
      expect.arrayContaining([
        "queue.repeatScheduled",
        "runner.killed",
        "subscribe",
      ]),
    );
    expect(messagesOf(both).filter((name) => name.includes("."))).toHaveLength(
      21 + 8,
    );

    const jobs = asyncDocumentFor({ mode: "jobs" })!;
    expect(channelsOf(jobs)).toEqual(["connection", "job", "queue", "queues"]);
    expect(messagesOf(jobs).some((name) => name.startsWith("runner."))).toBe(
      false,
    );
    expect(schemasOf(jobs).some((name) => name.startsWith("Runner"))).toBe(
      false,
    );
    expect(Object.keys(jobs.operations)).not.toContain("receiveRunnerEvents");

    const runner = asyncDocumentFor({ mode: "runner" })!;
    expect(channelsOf(runner)).toEqual(["connection", "runner", "runners"]);
    expect(messagesOf(runner).some((name) => name.startsWith("queue."))).toBe(
      false,
    );
    expect(schemasOf(runner).some((name) => name.startsWith("Queue"))).toBe(
      false,
    );
    expect(runner.channels.runner.parameters).toEqual({
      runner: { description: expect.any(String) },
    });

    // readOnly removes mutations, and the socket has none.
    expect(asyncDocumentFor({ readOnly: true })).toEqual(asyncDocumentFor());
  });

  it("has no document, and no /asyncapi.json, without a socket", () => {
    const routed = (overrides: Partial<JobsApiConfig>) =>
      createJobsApi(apiConfig(overrides)).routes.map(
        (route) => route.operationId,
      );
    expect(routed({})).toContain("getAsyncApiDocument");
    // The route snapshot's socket half, pinned here.
    expect(
      createJobsApi(apiConfig()).routes.filter(
        (route) => route.action === "docs.read",
      ),
    ).toEqual([
      {
        method: "GET",
        path: "/admin/jobs/openapi.json",
        operationId: "getOpenApiDocument",
        action: "docs.read",
        mutation: false,
      },
      {
        method: "GET",
        path: "/admin/jobs/asyncapi.json",
        operationId: "getAsyncApiDocument",
        action: "docs.read",
        mutation: false,
      },
    ]);
    for (const overrides of [
      { websocket: false as const },
      { actions: ["meta.read", "docs.read", "events.connect"] as const },
      { actions: ["meta.read", "docs.read", "events.subscribe"] as const },
    ]) {
      const config = {
        ...overrides,
        actions: overrides.actions ? [...overrides.actions] : undefined,
      };
      expect(asyncDocumentFor(config)).toBeUndefined();
      expect(routed(config)).not.toContain("getAsyncApiDocument");
    }
    // Docs off: the function still works, the route is gone.
    expect(asyncDocumentFor({ docs: false })?.asyncapi).toBe("3.0.0");
    expect(routed({ docs: false })).not.toContain("getAsyncApiDocument");
  });

  it("maps security schemes, and says so when there are none", () => {
    const secured = asyncDocumentFor({ docs: { securitySchemes: schemes } })!;
    expect(secured.components.securitySchemes).toEqual({
      bearer: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        "x-bun-jobs-note": expect.stringContaining("Authorization"),
      },
      apiKey: {
        type: "httpApiKey",
        in: "header",
        name: "x-api-key",
        "x-bun-jobs-note":
          "A browser WebSocket cannot send the x-api-key header.",
      },
    });
    expect(secured.servers.api.security).toEqual([
      { $ref: "#/components/securitySchemes/bearer" },
      { $ref: "#/components/securitySchemes/apiKey" },
    ]);
    const chosen = asyncDocumentFor({
      docs: { securitySchemes: schemes, security: [{ bearer: [] }] },
    })!;
    expect(Object.keys(chosen.components.securitySchemes)).toEqual(["bearer"]);

    const open = asyncDocumentFor()!;
    expect(open.components.securitySchemes).toBeUndefined();
    expect(open.servers.api.security).toBeUndefined();
    expect(open.info.description).toMatch(/declares no security schemes/);
  });

  it("serves /asyncapi.json with the request's host, or the configured server", async () => {
    const api = createJobsApi(apiConfig());
    const response = await api.router.fetch("/asyncapi.json", {
      headers: { host: "ops.example:8443", "x-forwarded-proto": "https" },
    });
    expect(response.status).toBe(200);
    const served = (await response.json()) as Record<string, any>;
    expect(served.servers.api).toMatchObject({
      host: "ops.example:8443",
      pathname: "/admin/jobs/ws",
      protocol: "wss",
    });
    expect(served.servers.api.variables).toBeUndefined();
    // The function's copy keeps the variable, and is a fresh copy each time.
    const own = api.asyncapi()!;
    expect(own.servers).toMatchObject({
      api: { host: "{host}", variables: { host: { default: "localhost" } } },
    });
    (own.info as { title: string }).title = "changed";
    expect((api.asyncapi()!.info as { title: string }).title).not.toBe(
      "changed",
    );
    await api.close();

    const fixed = createJobsApi(
      apiConfig({
        docs: { asyncapiServer: { host: "jobs.example", protocol: "wss" } },
      }),
    );
    const fixedDocument = (await (
      await fixed.router.fetch("/asyncapi.json", { headers: { host: "other" } })
    ).json()) as Record<string, any>;
    expect(fixedDocument.servers.api).toMatchObject({
      host: "jobs.example",
      protocol: "wss",
    });
    await fixed.close();
  });

  it("reports the socket and the AsyncAPI path in /meta", async () => {
    const api = createJobsApi(
      apiConfig({ websocket: { heartbeatMs: 1000, maxSubscriptions: 7 } }),
    );
    const meta = (await (await api.router.fetch("/meta")).json()) as Record<
      string,
      any
    >;
    expect(meta.websocket).toEqual({
      path: "/admin/jobs/ws",
      heartbeatMs: 1000,
      maxSubscriptions: 7,
    });
    expect(meta.docs).toEqual({
      openapi: "/admin/jobs/openapi.json",
      asyncapi: "/admin/jobs/asyncapi.json",
    });
    await api.close();
  });
});

/*
 * AsyncAPI 3.0.0 JSON Schema validation.
 *
 * The official schema ships in `@asyncapi/specs` (a devDependency of bun-jobs)
 * as `schemas/3.0.0.json`, a draft-07 bundle, so it is compiled with ajv's
 * draft-07 build rather than the 2020-12 one above.
 *
 * TODO(merge): until `bun install` has installed `@asyncapi/specs`, this block
 * is skipped (visibly). `BUN_JOBS_TEST_ASYNCAPI_DIR` may point at a
 * `node_modules` holding it (and `BUN_JOBS_TEST_AJV_DIR` at one holding ajv).
 */

/** Loads ajv's draft-07 build and the AsyncAPI 3.0.0 schema, or `undefined` when either is missing. */
async function loadAsyncApiValidator(): Promise<
  ((document: unknown) => { valid: boolean; errors: unknown }) | undefined
> {
  const ajvRoots = [
    "",
    ...(process.env.BUN_JOBS_TEST_AJV_DIR
      ? [`${process.env.BUN_JOBS_TEST_AJV_DIR}/`]
      : []),
  ];
  const specRoots = [
    undefined,
    ...(process.env.BUN_JOBS_TEST_ASYNCAPI_DIR
      ? [process.env.BUN_JOBS_TEST_ASYNCAPI_DIR]
      : []),
  ];
  let schemaPath: string | undefined;
  for (const root of specRoots) {
    try {
      schemaPath =
        root === undefined
          ? Bun.resolveSync(
              "@asyncapi/specs/schemas/3.0.0.json",
              import.meta.dir,
            )
          : `${root}/@asyncapi/specs/schemas/3.0.0.json`;
      if (await Bun.file(schemaPath).exists()) {
        break;
      }
      schemaPath = undefined;
    } catch {
      schemaPath = undefined;
    }
  }
  if (!schemaPath) {
    return undefined;
  }
  for (const root of ajvRoots) {
    try {
      const ajvSpecifier: string = root ? `${root}ajv/dist/ajv.js` : "ajv";
      const formatsSpecifier: string = `${root}ajv-formats${root ? "/dist/index.js" : ""}`;
      const ajvModule = (await import(ajvSpecifier)) as { default?: unknown };
      const formatsModule = (await import(formatsSpecifier)) as {
        default?: unknown;
      };
      const Ajv = (ajvModule.default ?? ajvModule) as new (
        options: object,
      ) => AjvLike;
      const addFormats = (formatsModule.default ?? formatsModule) as (
        ajv: AjvLike,
      ) => void;
      const draft07 = new Ajv({ strict: false, allErrors: true });
      addFormats(draft07);
      const schema = (await Bun.file(schemaPath).json()) as {
        definitions: Record<string, unknown>;
      };
      // The bundle embeds the draft-07 meta-schema under its own `$id`, which
      // ajv already registers; two schemas under one id is refused, and the
      // built-in one is the same document. (Dropped rather than asserted: this
      // runs at import time, where a failed assertion would fail the file
      // instead of a test.)
      delete schema.definitions["http://json-schema.org/draft-07/schema"];
      const validate = draft07.compile(schema);
      return (document) => {
        const valid = validate(document);
        return { valid, errors: valid ? undefined : validate.errors };
      };
    } catch {
      // Not installed here; try the next root.
    }
  }
  return undefined;
}

const validateAsyncApi = await loadAsyncApiValidator();

describe.skipIf(!validateAsyncApi)(
  "AsyncAPI 3.0.0 JSON Schema validation (@asyncapi/specs)",
  () => {
    for (const { name, overrides } of MATRIX) {
      it(`is a valid AsyncAPI 3.0.0 document: ${name}`, () => {
        expect(validateAsyncApi!(asyncDocumentFor(overrides))).toEqual({
          valid: true,
          errors: undefined,
        });
      });
    }

    it("is valid with a fixed server, oauth2 and openIdConnect schemes", () => {
      const document = asyncDocumentFor({
        docs: {
          asyncapiServer: { host: "jobs.example:443", protocol: "wss" },
          securitySchemes: {
            oauth: {
              type: "oauth2",
              flows: {
                clientCredentials: {
                  tokenUrl: "https://id.example/token",
                  scopes: { "jobs:read": "Read" },
                },
              },
            },
            oidc: {
              type: "openIdConnect",
              openIdConnectUrl:
                "https://id.example/.well-known/openid-configuration",
            },
          },
        },
      });
      expect(validateAsyncApi!(document)).toEqual({
        valid: true,
        errors: undefined,
      });
    });

    it("rejects broken documents (the controls)", () => {
      const badAction = asyncDocumentFor()!;
      badAction.operations.subscribe.action = "publish";
      expect(validateAsyncApi!(badAction).valid).toBe(false);
      const noInfo = asyncDocumentFor()!;
      delete noInfo.info;
      expect(validateAsyncApi!(noInfo).valid).toBe(false);
      const badServer = asyncDocumentFor()!;
      delete badServer.servers.api.protocol;
      expect(validateAsyncApi!(badServer).valid).toBe(false);
    });
  },
);
