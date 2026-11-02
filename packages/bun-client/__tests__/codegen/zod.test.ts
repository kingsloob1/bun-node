/**
 * The zod emitter (typed-client plan §5.2, §5.3, §12.1's PR-C4 row):
 *
 * - the golden modules, both flavours, for the C2 corpus and the fixture
 *   app, regenerated with the CLI from the package directory:
 *
 *   ```bash
 *   F=__tests__/codegen/fixtures
 *   for flavour in mini classic; do
 *     bun lib/codegen/cli.ts generate --openapi $F/corpus.openapi.json --out $F/corpus.gen.ts --zod $F/corpus.zod-$flavour.gen.ts --zod-flavour $flavour
 *     bun lib/codegen/cli.ts generate --module $F/app.ts --out $F/app.gen.ts --zod $F/app.zod-$flavour.gen.ts --zod-flavour $flavour
 *   done
 *   ```
 * - what each keyword becomes, and what is left unchecked with a warning;
 * - the generated schemas accept and reject what the server's own schemas
 *   do, over a corpus of wire values, except §5.3's documented differences,
 *   which are pinned;
 * - the round trip: the client validating real answers of the fixture app
 *   through `router.fetch()` with the generated module, both flavours.
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-contract";
import type { SchemaSource } from "../../lib/index";
import type { Routes } from "./fixtures/app.gen";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { generateRoutes, loadDocuments } from "../../lib/codegen/index";
import { createClient, ValidationError } from "../../lib/index";
import { schemasFromZod } from "../../lib/zod";
import * as classicApp from "./fixtures/app.zod-classic.gen";
import * as miniApp from "./fixtures/app.zod-mini.gen";
import * as classicCorpus from "./fixtures/corpus.zod-classic.gen";
import * as miniCorpus from "./fixtures/corpus.zod-mini.gen";
import { ADA, Address, buildRouter, Problem, User } from "./fixtures/app";
import { manifest } from "./fixtures/app.gen";

const FIXTURES = join(import.meta.dir, "fixtures");

/** A fixture's text. */
const text = (name: string) => Bun.file(join(FIXTURES, name)).text();

/** Whether a Standard Schema accepts `value` (synchronously, as zod's do). */
function accepts(schema: unknown, value: unknown): boolean {
  const result = (schema as StandardSchemaV1)["~standard"].validate(value);
  if (result instanceof Promise) throw new Error("expected a sync schema");
  return result.issues === undefined;
}

/** The zod module `generateRoutes` writes for `document`. */
function zodOf(
  document: object,
  flavour: "mini" | "classic" = "mini",
): { code: string; warnings: readonly { at: string; message: string }[] } {
  return generateRoutes(document, {
    zod: { flavour, routesModule: "./api.gen" },
  }).zod!;
}

/** A one-route document whose request body is `schema`. */
function bodyDocument(schema: unknown, components: object = {}): object {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/x": {
        post: {
          requestBody: {
            required: true,
            content: { "application/json": { schema } },
          },
          responses: { "204": { description: "none" } },
        },
      },
    },
    components: { schemas: components },
  };
}

describe("golden modules", () => {
  it.each(["mini", "classic"] as const)(
    "writes the corpus golden (%s)",
    async (flavour) => {
      const document = (await Bun.file(
        join(FIXTURES, "corpus.openapi.json"),
      ).json()) as object;
      const result = generateRoutes(document, {
        zod: { flavour, routesModule: "./corpus.gen" },
      });
      expect(result.zod!.code).toBe(await text(`corpus.zod-${flavour}.gen.ts`));
      expect(result.zod!.code).toContain(`typesHash: ${result.hash}\n`);
    },
  );

  it.each(["mini", "classic"] as const)(
    "writes the fixture app's golden (%s)",
    async (flavour) => {
      const loaded = await loadDocuments({ module: join(FIXTURES, "app.ts") });
      const result = generateRoutes(loaded.openapi, {
        ...(loaded.asyncapi === undefined ? {} : { asyncapi: loaded.asyncapi }),
        documentWarnings: loaded.warnings,
        zod: { flavour, routesModule: "./app.gen" },
      });
      expect(result.zod!.code).toBe(await text(`app.zod-${flavour}.gen.ts`));
    },
  );

  it("differs between the flavours only in the import and the annotation", async () => {
    const mini = await text("corpus.zod-mini.gen.ts");
    const classic = await text("corpus.zod-classic.gen.ts");
    expect(
      classic
        .replace('import { z } from "zod";', 'import { z } from "zod/mini";')
        .replaceAll("z.ZodType", "z.ZodMiniType"),
    ).toBe(mini);
  });

  it("leaves the route map untouched (control: the same code without the option)", async () => {
    const document = (await Bun.file(
      join(FIXTURES, "corpus.openapi.json"),
    ).json()) as object;
    expect(
      generateRoutes(document, { zod: { routesModule: "./x" } }).code,
    ).toBe(generateRoutes(document).code);
    expect(generateRoutes(document).zod).toBeUndefined();
  });
});

describe("keywords", () => {
  it("checks formats, lengths, patterns, ranges and multiples", () => {
    const { code } = zodOf(
      bodyDocument({
        type: "object",
        required: ["a"],
        properties: {
          a: { type: "string", format: "email", maxLength: 254 },
          b: { type: "string", format: "uuid" },
          c: { type: "string", format: "date-time" },
          d: { type: "string", format: "date" },
          e: { type: "string", format: "uri" },
          f: { type: "string", minLength: 2, pattern: "^a/b$" },
          g: { type: "integer", minimum: 1, exclusiveMaximum: 10 },
          h: { type: "number", minimum: 0, exclusiveMinimum: true },
          i: { type: "number", multipleOf: 0.5 },
          j: { type: "array", items: { type: "string" }, minItems: 1 },
          k: { type: "string", format: "hostname" },
          l: { type: "integer", minimum: -9007199254740991 },
        },
      }),
    );
    for (const expected of [
      "a: z.email().check(z.maxLength(254)),",
      "b: z.optional(z.guid()),",
      "c: z.optional(z.iso.datetime({ offset: true })),",
      "d: z.optional(z.iso.date()),",
      "e: z.optional(z.url()),",
      String.raw`f: z.optional(z.string().check(z.minLength(2), z.regex(/^a\/b$/))),`,
      "g: z.optional(z.int().check(z.gte(1), z.lt(10))),",
      "h: z.optional(z.number().check(z.gt(0))),",
      "i: z.optional(z.number().check(z.multipleOf(0.5))),",
      "j: z.optional(z.array(z.string()).check(z.minLength(1))),",
      // An unknown format, and zod's own safe-integer bound, add nothing.
      "k: z.optional(z.string()),",
      "l: z.optional(z.int()),",
    ])
      expect(code).toContain(expected);
  });

  it("leaves a pattern that does not compile unchecked, without a check that would throw at load", () => {
    const { code } = zodOf(bodyDocument({ type: "string", pattern: "(" }));
    expect(code).toContain("body: z.string(),");
  });

  it("writes nullable unions, enums with null, records, tuples and intersections", () => {
    const { code } = zodOf(
      bodyDocument(
        {
          type: "object",
          properties: {
            a: { type: ["string", "null"] },
            b: { enum: ["x", null] },
            c: { type: "object", additionalProperties: { type: "number" } },
            d: {
              type: "array",
              prefixItems: [{ type: "string" }],
              items: false,
            },
            e: {
              allOf: [
                { $ref: "#/components/schemas/A" },
                { type: "object", properties: { n: { type: "number" } } },
              ],
            },
            f: { const: 3 },
            g: { type: "string", nullable: true },
          },
        },
        { A: { type: "object", properties: { s: { type: "string" } } } },
      ),
    );
    for (const expected of [
      "a: z.optional(z.nullable(z.string())),",
      'b: z.optional(z.nullable(z.literal("x"))),',
      "c: z.optional(z.record(z.string(), z.number())),",
      "d: z.optional(z.tuple([z.string()])),",
      "f: z.optional(z.literal(3)),",
      "g: z.optional(z.nullable(z.string())),",
    ])
      expect(code).toContain(expected);
    expect(code).toMatch(/e: z\.optional\(\s*z\.intersection\(\s*A,/);
  });

  it("names what it cannot check, in the header and the result (control: a checkable schema warns nothing)", () => {
    const { code, warnings } = zodOf(
      bodyDocument({
        type: "object",
        properties: {
          a: { not: { type: "string" } },
          b: { $ref: "other.json#/X" },
          c: { const: { deep: true } },
        },
      }),
    );
    expect(warnings.map((w) => w.message)).toEqual([
      "`not` cannot be checked; not checked",
      '`$ref` "other.json#/X" points outside the document; not checked',
      "a `const` or `enum` value that is an object or array is not checked",
    ]);
    expect(code).toContain("Not checked:\n * - POST /x body.a: `not`");
    expect(zodOf(bodyDocument({ type: "string" })).warnings).toEqual([]);
  });

  it("writes each component after those it uses; a cycle goes through a hoisted accessor", () => {
    const { code } = zodOf(
      bodyDocument(
        { $ref: "#/components/schemas/A" },
        {
          A: {
            type: "object",
            properties: { b: { $ref: "#/components/schemas/B" } },
          },
          B: {
            type: "object",
            properties: {
              a: { $ref: "#/components/schemas/A" },
              self: { $ref: "#/components/schemas/B" },
            },
          },
          C: {
            type: "object",
            properties: { a: { $ref: "#/components/schemas/A" } },
          },
        },
      ),
    );
    const order = [...code.matchAll(/^export const (\w+)/gm)].map((m) => m[1]);
    expect(order).toEqual(["B", "A", "C", "schemas"]);
    expect(code).toContain("a: z.optional(z.lazy(lazyA)),");
    expect(code).toContain("self: z.optional(z.lazy(() => B)),");
    expect(code).toContain("b: z.optional(B),");
    expect(code).toContain("function lazyA(): z.ZodMiniType {\n  return A;\n}");
  });

  it("gives a component named like the module's own names another name", () => {
    const { code } = zodOf(
      bodyDocument(
        { $ref: "#/components/schemas/z" },
        {
          z: { type: "string" },
          schemas: { type: "number" },
        },
      ),
    );
    expect(code).toContain("export const zSchema: z.ZodMiniType = z.string();");
    expect(code).toContain(
      "export const schemasSchema: z.ZodMiniType = z.number();",
    );
    expect(code).toContain("body: zSchema,");
  });

  it("checks params, query and headers; leaves out what it cannot check", () => {
    const { code } = zodOf({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/files/{path}": {
          put: {
            "x-bun-route-key": "PUT /files/*path",
            parameters: [
              {
                name: "path",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
              { name: "Page", in: "query", schema: { type: "integer" } },
              {
                name: "X-Tenant",
                in: "header",
                required: true,
                schema: { type: "string" },
              },
            ],
            requestBody: {
              content: {
                "multipart/form-data": { schema: { type: "object" } },
              },
            },
            responses: {
              "200": {
                description: "ok",
                content: { "text/plain": { schema: { type: "string" } } },
              },
              "201": {
                description: "file",
                content: { "application/octet-stream": {} },
              },
              "202": {
                description: "events",
                content: { "text/event-stream": {} },
              },
              default: {
                description: "x",
                content: { "application/json": { schema: {} } },
              },
            },
          },
        },
      },
    });
    expect(code).toContain(`  "PUT /files/*path": {
    params: z.looseObject({
      path: z.array(z.string()),
    }),
    query: z.looseObject({
      Page: z.optional(z.int()),
    }),
    headers: z.looseObject({
      "x-tenant": z.string(),
    }),
    responses: {
      200: z.string(),
    },
  },`);
  });
});

/**
 * The fixture app's own schemas (the server's) beside the generated ones,
 * over wire values: what a server sends (its schema's input side, a `Date`
 * where the schema says `z.date()`) is checked by the server's schema;
 * the same value after JSON, by the generated one.
 */
describe("the generated schemas agree with the server's (§12.1)", () => {
  const user = { ...ADA };
  /** Wire values, and whether the server's schema accepts each. */
  const corpus: [what: string, value: Record<string, unknown>][] = [
    ["Ada", user],
    ["an extra field (a newer server)", { ...user, extra: 1 }],
    ["no name", { ...user, name: undefined }],
    ["a name that is a number", { ...user, name: 7 }],
    ["a role outside the enum", { ...user, role: "guest" }],
    ["a null nickname", { ...user, nickname: null }],
    ["no nickname", { ...user, nickname: undefined }],
    ["a malformed createdAt", { ...user, createdAt: "yesterday" }],
    ["an address", { ...user, address: { city: "London", zip: null } }],
    ["an address without its city", { ...user, address: { zip: "1" } }],
    ["scores that are not numbers", { ...user, scores: { chess: "nine" } }],
    ["tags that are not a list", { ...user, tags: "math" }],
  ];

  it.each([
    ["mini", miniApp],
    ["classic", classicApp],
  ] as const)("User (%s)", (_flavour, generated) => {
    for (const [what, value] of corpus) {
      const wire = JSON.parse(JSON.stringify(value)) as unknown;
      expect({ what, generated: accepts(generated.User, wire) }).toEqual({
        what,
        generated: accepts(User, value),
      });
    }
  });

  it.each([
    ["mini", miniApp],
    ["classic", classicApp],
  ] as const)(
    "pins §5.3's difference: z.date() is not checked on the wire (%s)",
    (_flavour, generated) => {
      const wrong = { ...user, joined: "not a date" };
      // The server refuses a `joined` that is not a Date...
      expect(accepts(User, wrong)).toBe(false);
      // ...the generated schema cannot say so: the document has no type for it.
      expect(accepts(generated.User, wrong)).toBe(true);
    },
  );

  it.each([
    ["mini", miniApp],
    ["classic", classicApp],
  ] as const)("Address and Problem (%s)", (_flavour, generated) => {
    for (const value of [
      { city: "x", zip: null },
      { city: "x", zip: "1" },
      { city: 1, zip: null },
      { zip: null },
    ])
      expect(accepts(generated.Address, value)).toBe(accepts(Address, value));
    for (const value of [
      { type: "t", title: "t", code: "C" },
      { type: "t", title: "t", code: "C", detail: "d" },
      { type: "t", title: "t" },
      { type: "t", title: "t", code: 1 },
    ])
      expect(accepts(generated.Problem, value)).toBe(accepts(Problem, value));
  });

  it.each([
    ["mini", miniCorpus],
    ["classic", classicCorpus],
  ] as const)(
    "the corpus module loads and recurses through its cycle (%s)",
    (_flavour, generated) => {
      const tree = {
        id: "a",
        children: [{ id: "b", children: [] }],
        meta: { owner: { id: "c", children: [] } },
      };
      expect(accepts(generated.Tree, tree)).toBe(true);
      expect(
        accepts(generated.Tree, {
          ...tree,
          meta: { owner: { id: 1, children: [] } },
        }),
      ).toBe(false);
      expect(accepts(generated.Named, { name: "" })).toBe(false);
    },
  );
});

describe("the round trip: the client validates the app's real answers through router.fetch()", () => {
  it.each([
    ["mini", () => import("./fixtures/app.zod-mini.gen")],
    ["classic", () => import("./fixtures/app.zod-classic.gen")],
  ] as const)("%s", async (_flavour, schemas) => {
    const router = buildRouter();
    const warnings: string[] = [];
    let served = 0;
    const api = createClient<Routes>({
      baseUrl: "http://app.test",
      fetch: (request) => {
        served++;
        return router.fetch(request);
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

    // Every route, every declared answer: no warning.
    const read = await api.get("/api/users/:id", {
      params: { id: "42" },
      query: { page: 2, expand: ["org"] },
    });
    expect(read.status).toBe(200);
    expect(
      (await api.get("/api/users/:id", { params: { id: "7" } })).status,
    ).toBe(404);
    expect(
      (await api.post("/api/users", { body: { name: "Grace" } })).status,
    ).toBe(201);
    expect(
      (await api.post("/api/users", { body: { name: "Ada" } })).status,
    ).toBe(409);
    expect(
      (await api.post("/api/shapes", { body: { kind: "square", side: 2 } }))
        .status,
    ).toBe(200);
    expect((await api.get("/api/categories")).status).toBe(200);
    expect(
      (await api.delete("/api/users/:id", { params: { id: "42" } })).status,
    ).toBe(204);
    expect(
      (await api.get("/api/users/:id/events", { params: { id: "42" } })).status,
    ).toBe(200);
    expect(warnings).toEqual([]);
    expect(served).toBe(8);

    // A request the generated schema refuses is never sent.
    const refused = await api
      .post("/api/shapes", { body: { kind: "triangle", side: 1 } as never })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ValidationError);
    expect(served).toBe(8);

    // Control: an answer drifted from the document is reported, and delivered.
    const drifted = createClient<Routes>({
      baseUrl: "http://app.test",
      fetch: async (request) => {
        const response = await router.fetch(request);
        const body = (await response.json()) as Record<string, unknown>;
        return Response.json(
          { ...body, role: "guest" },
          { status: response.status },
        );
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
    const r = await drifted.get("/api/users/:id", { params: { id: "42" } });
    expect(r.ok && r.data.role).toBe("guest" as never);
    expect(warnings).toEqual([
      expect.stringContaining(
        "GET /api/users/:id response 200 failed validation: response.role:",
      ) as string,
    ]);
  });
});

describe("schemasFromZod (./zod)", () => {
  /** A Standard Schema that is not zod's. */
  const foreign = {
    "~standard": {
      version: 1 as const,
      vendor: "valibot",
      validate: (value: unknown) => ({ value }),
    },
  };

  it("returns the map as given for zod schemas of both flavours (control for the refusals below)", () => {
    const map = {
      "GET /users/:id": {
        params: miniApp.User,
        responses: { 200: classicApp.User, 404: null },
      },
    };
    expect(schemasFromZod<Routes>(map as never)).toBe(map as never);
  });

  it("refuses a value that is not a zod schema, naming where", () => {
    expect(() =>
      schemasFromZod<Routes>({
        "GET /api/users/:id": { body: foreign as never },
      }),
    ).toThrow(
      "schemasFromZod(): GET /api/users/:id body is not a zod 4 schema",
    );
    expect(() =>
      schemasFromZod<Routes>({
        "GET /api/users/:id": { responses: { 200: foreign as never } },
      }),
    ).toThrow(
      "schemasFromZod(): GET /api/users/:id response 200 is not a zod 4 schema (or null)",
    );
  });

  it("refuses a key that is not a route key", () => {
    expect(() => schemasFromZod({ users: {} })).toThrow(
      'schemasFromZod(): "users" is not a route key ("VERB /path")',
    );
  });
});
