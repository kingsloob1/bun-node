/**
 * Headers in the generated files (typed-client plan §5.6, a PR-C4
 * follow-up):
 *
 * - the route map's `responseHeaders` and the zod module's, per status, by
 *   lower-case name, from `responses.<status>.headers` (a `$ref`'d header
 *   and a `$ref`'d response included); `Content-Type` and `Set-Cookie` left
 *   out, the first spelling of a name winning;
 * - a header crosses as a string, so a schema that describes strings is
 *   checked by it and any other as `z.string()`, request headers included
 *   (a documented `integer` request header used to be generated as
 *   `z.number()`, which refused the `"42"` the client sends);
 * - the round trip: the fixture app's documented headers checked on its
 *   real answers, both flavours, and a drifted one reported.
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-contract";
import type { RouteSchemas, SchemaSource } from "../../lib/index";
import type { Routes } from "./fixtures/app.gen";
import { describe, expect, it } from "bun:test";
import { generateRoutes } from "../../lib/codegen/index";
import { createClient } from "../../lib/index";
import { schemasFromZod } from "../../lib/zod";
import * as miniCorpus from "./fixtures/corpus.zod-mini.gen";
import * as classicCorpus from "./fixtures/corpus.zod-classic.gen";
import { buildRouter } from "./fixtures/app";
import { manifest } from "./fixtures/app.gen";

/** Whether a Standard Schema accepts `value` (synchronously, as zod's do). */
function accepts(schema: unknown, value: unknown): boolean {
  const result = (schema as StandardSchemaV1)["~standard"].validate(value);
  if (result instanceof Promise) throw new Error("expected a sync schema");
  return result.issues === undefined;
}

/** A one-route document: `parameters` on the operation, `headers` on its 200. */
function headersDocument(
  parameters: readonly object[],
  headers: Record<string, unknown>,
): object {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/x": {
        get: {
          parameters,
          responses: {
            "200": {
              description: "OK",
              headers,
              content: { "application/json": { schema: { type: "string" } } },
            },
          },
        },
      },
    },
  };
}

describe("the generated route map's responseHeaders", () => {
  it("types each status's headers by lower-case name, strings as declared and anything else as string", () => {
    const { code } = generateRoutes(
      headersDocument([], {
        "X-Count": { required: true, schema: { type: "integer" } },
        "X-Mode": { schema: { enum: ["a", "b"] } },
        "X-Flag": { schema: { type: "boolean" } },
        "Content-Type": { schema: { type: "string" } },
        "Set-Cookie": { schema: { type: "string" } },
      }),
    );
    expect(code).toContain(
      [
        "    responseHeaders: {",
        "      200: {",
        '        "x-count": string;',
        '        "x-mode"?: "a" | "b";',
        '        "x-flag"?: string;',
        "      };",
        "    };",
      ].join("\n"),
    );
    expect(code).not.toContain("content-type");
    expect(code).not.toContain("set-cookie");
  });

  it("a route with no declared response header has no responseHeaders (control: one header gives it)", () => {
    expect(generateRoutes(headersDocument([], {})).code).not.toContain(
      "responseHeaders",
    );
    expect(
      generateRoutes(headersDocument([], { "X-A": { schema: {} } })).code,
    ).toContain('"x-a"?: string;');
  });
});

describe("the generated zod module's headers", () => {
  /** The zod module for `document`. */
  const zodOf = (document: object) =>
    generateRoutes(document, {
      zod: { flavour: "mini", routesModule: "./api.gen" },
    }).zod!.code;

  it("checks a non-string header, request or response, as a string (control: a string schema keeps its checks)", () => {
    const code = zodOf(
      headersDocument(
        [
          {
            name: "X-Page",
            in: "header",
            required: true,
            schema: { type: "integer" },
          },
          {
            name: "X-Trace",
            in: "header",
            schema: { type: "string", minLength: 2 },
          },
        ],
        {
          "X-Count": { required: true, schema: { type: "number" } },
          "X-Id": { schema: { type: "string", format: "uuid" } },
        },
      ),
    );
    expect(code).toContain('"x-page": z.string(),');
    expect(code).toContain(
      '"x-trace": z.optional(z.string().check(z.minLength(2))),',
    );
    expect(code).toContain(
      [
        "    responseHeaders: {",
        "      200: z.looseObject({",
        '        "x-count": z.string(),',
        '        "x-id": z.optional(z.guid()),',
        "      }),",
        "    },",
      ].join("\n"),
    );
  });

  it.each([
    ["mini", miniCorpus],
    ["classic", classicCorpus],
  ] as const)(
    "%s: the corpus's headers accept what a server sends and refuse what it must not",
    (_flavour, module) => {
      const schemas = module.schemas as Readonly<Record<string, RouteSchemas>>;
      const pets = schemas["GET /pets"].responseHeaders![200];
      // As `Headers` reads them: lower-case names, string values, extras kept.
      expect(accepts(pets, { "x-total-count": "3" })).toBe(true);
      expect(
        accepts(pets, {
          "x-total-count": "3",
          "x-page-kind": "next",
          link: "</pets?page=2>",
          "content-type": "application/json",
        }),
      ).toBe(true);
      // Required, an enum, the `$ref`'d header's `minLength`.
      expect(accepts(pets, {})).toBe(false);
      expect(
        accepts(pets, { "x-total-count": "3", "x-page-kind": "last" }),
      ).toBe(false);
      expect(accepts(pets, { "x-total-count": "3", link: "" })).toBe(false);
      // A `$ref`'d response's headers.
      const tree = schemas["GET /trees/:id"].responseHeaders![404];
      expect(accepts(tree, { "x-reason": "gone" })).toBe(true);
      expect(accepts(tree, {})).toBe(false);
    },
  );
});

describe("the round trip: the fixture app's documented headers on its real answers", () => {
  it.each([
    ["mini", () => import("./fixtures/app.zod-mini.gen")],
    ["classic", () => import("./fixtures/app.zod-classic.gen")],
  ] as const)(
    "%s: no warning on the real answer; a drifted header is reported (the control)",
    async (_flavour, schemas) => {
      const router = buildRouter();
      const warnings: string[] = [];
      let drift: Record<string, string> = {};
      const api = createClient<Routes>({
        baseUrl: "http://app.test",
        fetch: async (request) => {
          const response = await router.fetch(request);
          const headers = new Headers(response.headers);
          for (const [name, value] of Object.entries(drift))
            headers.set(name, value);
          return new Response(response.body, {
            status: response.status,
            headers,
          });
        },
        manifest,
        retry: false,
        headers: { "x-tenant": "acme" },
        mode: "development",
        schemas: schemas as () => Promise<SchemaSource<Routes>>,
        logger: {
          warn: (message: string) => void warnings.push(message),
          error: () => {},
          debug: () => {},
        },
      });
      const read = await api.get("/api/users/:id", { params: { id: "42" } });
      expect(read.status).toBe(200);
      expect(read.response.headers.get("x-request-id")).toBe("req-1");
      expect(warnings).toEqual([]);

      drift = { "x-request-id": "other" };
      const drifted = await api.get("/api/users/:id", {
        params: { id: "42" },
      });
      expect(drifted.status).toBe(200);
      expect(warnings).toEqual([
        expect.stringContaining(
          "GET /api/users/:id response 200 failed validation: headers.x-request-id:",
        ) as string,
      ]);
    },
  );
});

describe("schemasFromZod's responseHeaders", () => {
  it("refuses a value that is not a zod schema, naming where (control: a zod schema is accepted)", async () => {
    const { z } = await import("zod");
    const map = {
      "GET /x": { responseHeaders: { 200: z.looseObject({ a: z.string() }) } },
    };
    expect(schemasFromZod(map)).toBe(map);
    expect(() =>
      schemasFromZod({
        "GET /x": {
          responseHeaders: {
            200: {
              "~standard": { version: 1, vendor: "x", validate: () => ({}) },
            } as never,
          },
        },
      }),
    ).toThrow(
      "schemasFromZod(): GET /x response 200 headers is not a zod 4 schema",
    );
  });
});
