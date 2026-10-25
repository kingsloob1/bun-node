/**
 * AD (a), plan §9.1: every generated document is validated against the
 * OpenAPI 3.1 meta-schema, vendored at
 * `__tests__/fixtures/schemas/oas-3.1.json` (fetched from
 * https://spec.openapis.org/oas/3.1/schema/2022-10-07 on 2026-09-15 by
 * bun-jobs, copied here 2026-10-25; the file's own `$id` records the source).
 * It needs ajv 8 with its draft 2020-12 build and ajv-formats, both
 * devDependencies of bun-common.
 *
 * The escape hatch is bun-jobs': `BUN_COMMON_TEST_AJV_DIR` may point at a
 * `node_modules` holding them, and where neither is installed the suite skips
 * visibly rather than failing.
 *
 * The matrix (§9.1): { no schemas, zod, valibot, arktype, yup, mixed } ×
 * { no security, bearer, apiKey } × { strict, lenient }.
 */
import { describe, expect, it } from "bun:test";
import process from "node:process";
import { toJsonSchema as valibotToJsonSchema } from "@valibot/to-json-schema";
import { type } from "arktype";
import * as v from "valibot";
import * as yup from "yup";
import { z } from "zod";
import { BunRouter } from "../../lib/BunRouter";
import { validate } from "../../lib/BunValidate";
import type {
  OpenApiOptions,
  OpenApiSecurityScheme,
} from "../../lib/docs/index";
import {
  danglingRefs,
  generateOpenApi,
  valibotConverter,
} from "../../lib/docs/index";

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

/** Loads ajv 8 (draft 2020-12) with formats, from the workspace or `BUN_COMMON_TEST_AJV_DIR`. */
async function loadAjv(): Promise<AjvLike | undefined> {
  const roots = [
    "",
    ...(process.env.BUN_COMMON_TEST_AJV_DIR
      ? [`${process.env.BUN_COMMON_TEST_AJV_DIR}/`]
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

/* ------------------------------------------------------------------ *
 * The matrix's routers.
 * ------------------------------------------------------------------ */

/** The security cells. */
const SECURITY: Record<
  string,
  { securitySchemes?: Record<string, OpenApiSecurityScheme> }
> = {
  none: {},
  bearer: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  },
  apiKey: {
    securitySchemes: {
      key: { type: "apiKey", in: "header", name: "x-api-key" },
    },
  },
};

/**
 * One router per schema cell. Every route declares responses (a strict cell
 * must be warning-free), every path is documentable.
 */
function matrixRouter(cell: string): {
  router: BunRouter;
  options: Partial<OpenApiOptions>;
} {
  const router = new BunRouter();
  if (cell === "none") {
    // No validator anywhere: everything comes from .describe().
    router
      .get("/ping", (_req, res) => res.json({ ok: true }))
      .describe({
        summary: "Liveness",
        responses: { 200: { schema: { type: "object" } } },
      });
    router
      .post("/echo/:room", (req, res) => res.json({ room: req.params.room }))
      .describe({
        request: {
          params: { type: "object", properties: { room: { type: "string" } } },
          body: { type: "object" },
        },
        responses: { 200: { schema: { type: "object" } }, 400: null },
      });
    return { router, options: {} };
  }

  const options: Partial<OpenApiOptions> = {
    converters: { valibot: valibotConverter(valibotToJsonSchema) },
  };
  /** The cell's query/body/response schemas. */
  const schemas = (():
    { q: never; b: never; r: never } | { q: any; b: any; r: any } => {
    switch (cell) {
      case "zod":
        return {
          q: z.object({ page: z.coerce.number().int().min(1).default(1) }),
          b: z.object({ name: z.string().min(2) }),
          r: z.object({ id: z.string(), name: z.string() }),
        };
      case "valibot":
        return {
          q: v.object({ page: v.optional(v.pipe(v.string(), v.minLength(1))) }),
          b: v.object({ name: v.pipe(v.string(), v.minLength(2)) }),
          r: v.object({ id: v.string(), name: v.string() }),
        };
      case "arktype":
        return {
          q: type({ "page?": "string" }),
          b: type({ name: "string >= 2" }),
          r: type({ id: "string", name: "string" }),
        };
      case "yup":
        return {
          q: yup.object({ page: yup.string().optional() }),
          b: yup.object({ name: yup.string().min(2).required() }),
          r: yup.object({
            id: yup.string().required(),
            name: yup.string().required(),
          }),
        };
      default:
        // mixed: a different vendor per target.
        return {
          q: z.object({ page: z.string().optional() }),
          b: v.object({ name: v.pipe(v.string(), v.minLength(2)) }),
          r: type({ id: "string", name: "string" }),
        };
    }
  })();

  router
    .get(
      "/users/:id",
      validate(
        { params: z.object({ id: z.string() }), query: schemas.q },
        { responses: { 200: schemas.r, 404: null } },
      ),
      (req, res) => res.json({ id: req.params.id, name: "ada" }),
    )
    .describe({ summary: "Read one user", tags: ["Users"] });
  router
    .post(
      "/users",
      validate(
        {
          body: schemas.b,
          headers:
            cell === "mixed"
              ? yup.object({ "x-tenant": yup.string().required() })
              : z.object({}),
        },
        { responses: { 201: schemas.r } },
      ),
      (req, res) =>
        res
          .status(201)
          .json({ id: "u_1", name: (req.body as { name: string }).name }),
    )
    .describe({ summary: "Create a user", tags: ["Users"] });
  return { router, options };
}

/** The document for one matrix cell. */
function documentFor(
  cell: string,
  security: string,
  strict: "strict" | "lenient",
) {
  const { router, options } = matrixRouter(cell);
  return generateOpenApi(router, {
    title: "Matrix",
    version: "1.0.0",
    strict,
    ...options,
    ...SECURITY[security],
  });
}

const MATRIX = ["none", "zod", "valibot", "arktype", "yup", "mixed"].flatMap(
  (cell) =>
    Object.keys(SECURITY).flatMap((security) =>
      (["strict", "lenient"] as const).map((strict) => ({
        name: `schemas ${cell}, security ${security}, ${strict}`,
        cell,
        security,
        strict,
      })),
    ),
);

describe("the generator across the matrix", () => {
  it("no warnings in any strict cell (strict would throw otherwise)", () => {
    for (const { name, cell, security, strict } of MATRIX) {
      const { warnings } = documentFor(cell, security, strict);
      expect({ name, warnings }).toEqual({ name, warnings: [] });
    }
  });

  it("no dangling $refs in any cell", () => {
    for (const { name, cell, security, strict } of MATRIX) {
      const { document } = documentFor(cell, security, strict);
      expect({ name, dangling: danglingRefs(document) }).toEqual({
        name,
        dangling: [],
      });
    }
  });

  it("operation ids are unique in every cell", () => {
    for (const { name, cell, security, strict } of MATRIX) {
      const { document } = documentFor(cell, security, strict);
      const ids = Object.values(
        document.paths as Record<
          string,
          Record<string, { operationId: string }>
        >,
      )
        .flatMap((item) => Object.values(item))
        .map((operation) => operation.operationId);
      expect({ name, unique: new Set(ids).size === ids.length }).toEqual({
        name,
        unique: true,
      });
    }
  });
});

// eslint-disable-next-line @typescript-eslint/no-misused-promises -- bun:test awaits an async describe callback
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
  const validateDocument = ajv.compile(metaSchema);

  for (const { name, cell, security, strict } of MATRIX) {
    it(`is a valid OpenAPI 3.1 document: ${name}`, () => {
      const { document } = documentFor(cell, security, strict);
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
      const { document } = documentFor(cell, security, strict);
      const schemas =
        (document.components as { schemas?: object } | undefined)?.schemas ??
        {};
      const key = `urn:bun-common:test:${name.replaceAll(/\W+/g, "-")}`;
      ajv.addSchema({ $id: key, components: { schemas } }, key);
      for (const component of Object.keys(schemas)) {
        expect(() =>
          ajv.compile({ $ref: `${key}#/components/schemas/${component}` }),
        ).not.toThrow();
      }
    });
  }

  it("rejects a broken document and an invalid schema (the controls)", () => {
    const { document } = documentFor("zod", "none", "lenient");
    delete (document.info as { version?: string }).version;
    expect(validateDocument(document)).toBe(false);
    expect(() => ajv.compile({ type: "strnig" })).toThrow();
  });
});
