/**
 * `generateRoutes` (typed-client plan §3.2, §12.1 PR-C2): the golden files,
 * determinism, the header, warnings, and what each extension becomes.
 *
 * The goldens are regenerated with the CLI, from the package directory, and a
 * change to the generator that changes them is reviewed as their diff:
 *
 * ```bash
 * bun lib/codegen/cli.ts generate --openapi __tests__/codegen/fixtures/corpus.openapi.json --out __tests__/codegen/fixtures/corpus.gen.ts
 * bun lib/codegen/cli.ts generate --openapi __tests__/codegen/fixtures/thirdParty.openapi.yaml --out __tests__/codegen/fixtures/thirdParty.gen.ts
 * bun lib/codegen/cli.ts generate --module __tests__/codegen/fixtures/app.ts --out __tests__/codegen/fixtures/app.gen.ts
 * bun lib/codegen/cli.ts generate --module __tests__/codegen/fixtures/mounts.ts --out __tests__/codegen/fixtures/mounts.gen.ts
 * ```
 */
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { BunRouter } from "@kingsleyweb/bun-common";
import { generateOpenApi } from "@kingsleyweb/bun-common/lib/docs";
import {
  documentsHash,
  generateRoutes,
  loadDocuments,
} from "../../lib/codegen/index";

const FIXTURES = join(import.meta.dir, "fixtures");

/** A fixture's text. */
const text = (name: string) => Bun.file(join(FIXTURES, name)).text();

/** The corpus document, fresh. */
const corpus = async () =>
  (await Bun.file(join(FIXTURES, "corpus.openapi.json")).json()) as Record<
    string,
    unknown
  >;

/**
 * A copy of `value` with the keys of every map the generator sorts reversed
 * (paths, path items, components, responses, events, x-bun-cache), so a
 * deterministic generator gives the same bytes. Property order is the
 * document's own and is left alone.
 */
function reorder(value: unknown, sorted = true): unknown {
  if (Array.isArray(value)) return value.map((item) => reorder(item, false));
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>).map(
    ([key, child]): [string, unknown] => [
      key,
      reorder(
        child,
        [
          "paths",
          "schemas",
          "responses",
          "x-sse-events",
          "components",
        ].includes(key) || key.startsWith("/"),
      ),
    ],
  );
  return Object.fromEntries(sorted ? entries.reverse() : entries);
}

describe("golden outputs", () => {
  it("writes the corpus golden: refs, recursion, unions, nullable, enums, maps, arrays, tuples, errors, cache, events", async () => {
    expect(generateRoutes(await corpus()).code).toBe(
      await text("corpus.gen.ts"),
    );
  });

  it("writes the third-party golden from a YAML OpenAPI 3.0 document with no x-bun-*", async () => {
    const { openapi } = await loadDocuments({
      openapi: join(FIXTURES, "thirdParty.openapi.yaml"),
    });
    expect(generateRoutes(openapi).code).toBe(await text("thirdParty.gen.ts"));
  });

  it("writes the fixture app's golden from its router, documented in process", async () => {
    const loaded = await loadDocuments({ module: join(FIXTURES, "app.ts") });
    const result = generateRoutes(loaded.openapi, {
      ...(loaded.asyncapi === undefined ? {} : { asyncapi: loaded.asyncapi }),
      documentWarnings: loaded.warnings,
    });
    expect(result.code).toBe(await text("app.gen.ts"));
    expect(result.routes).toBe(12);
  });
});

describe("determinism", () => {
  it("gives the same bytes on every run", async () => {
    const document = await corpus();
    const first = generateRoutes(document).code;
    for (let run = 0; run < 3; run++)
      expect(generateRoutes(document).code).toBe(first);
  });

  it("gives the same bytes whatever order the document's maps are in", async () => {
    const document = await corpus();
    const shuffled = reorder(document) as Record<string, unknown>;
    expect(Object.keys(shuffled.paths as object)).not.toEqual(
      Object.keys(document.paths as object),
    );
    const a = generateRoutes(document);
    const b = generateRoutes(shuffled);
    // The hash is over canonical JSON, so it agrees too.
    expect(b.hash).toBe(a.hash);
    expect(b.code).toBe(a.code);
  });

  it("does not mutate the document", async () => {
    const document = await corpus();
    const before = JSON.stringify(document);
    generateRoutes(document);
    expect(JSON.stringify(document)).toBe(before);
  });
});

describe("the header", () => {
  it("records the documents' hash, with the AsyncAPI document when given", async () => {
    const document = await corpus();
    const asyncapi = { asyncapi: "3.0.0", info: { title: "x", version: "1" } };
    const alone = generateRoutes(document);
    const both = generateRoutes(document, { asyncapi });
    expect(alone.hash).toBe(documentsHash({ openapi: document }));
    expect(both.hash).toBe(documentsHash({ openapi: document, asyncapi }));
    expect(both.hash).not.toBe(alone.hash);
    expect(alone.code).toContain(`typesHash: ${alone.hash}\n`);
    // Only the hash differs, in the header and in the `typesHash` export.
    expect(both.code.replaceAll(both.hash, "")).toBe(
      alone.code.replaceAll(alone.hash, ""),
    );
  });

  it("exports the same hash as `typesHash`, a persisted cache's buster (plan §6.4, PR-C8)", async () => {
    const result = generateRoutes(await corpus());
    expect(result.code).toContain(
      `\nexport const typesHash = "${result.hash}";\n`,
    );
    expect(result.code.split(result.hash).length - 1).toBe(2);
  });

  it("keeps the `typesHash` export's name from a component: one named so is renamed", () => {
    const { code } = generateRoutes({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {},
      components: { schemas: { typesHash: { type: "string" } } },
    });
    expect(code).toContain("export type typesHashSchema = string;");
    expect(code.match(/export const typesHash = /g)).toHaveLength(1);
  });

  it("lists every warning, the producer's first", () => {
    const { code, warnings } = generateRoutes(
      {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: { "/a": { get: { responses: {} } } },
      },
      { documentWarnings: [{ at: "GET /a", message: "from the producer" }] },
    );
    expect(warnings).toEqual([
      { at: "GET /a", message: "from the producer" },
      {
        at: "GET /a",
        message: "no response is declared; typed `{ 200: unknown }`",
      },
    ]);
    expect(code).toContain(
      " * - GET /a: from the producer\n * - GET /a: no response is declared",
    );
  });

  it("imports RouteManifest from the client module named", () => {
    const { code } = generateRoutes(
      { openapi: "3.1.0", info: { title: "t", version: "1" }, paths: {} },
      { clientModule: "../client" },
    );
    expect(code).toContain('import type { RouteManifest } from "../client";');
    expect(code).toContain("export interface Routes {}\n");
    expect(code).toContain(
      "export const manifest = {} as const satisfies RouteManifest<Routes>;\n",
    );
  });
});

describe("what the generator degrades, and says so", () => {
  it("warns for every schema typed `unknown` or left out in the corpus", async () => {
    const { warnings } = generateRoutes(await corpus());
    expect(
      warnings.map((warning) => `${warning.at}: ${warning.message}`),
    ).toEqual([
      "GET /nothing: no response is declared; typed `{ 200: unknown }`",
      "GET /pets response 2XX: a status range is not typed; a status the route does not declare is handled by `undeclaredStatus`",
      "GET /trees/:id response default: a `default` response is not typed; a status the route does not declare is handled by `undeclaredStatus`",
      'OPTIONS /nothing response 200: `$ref` "#/components/schemas/Missing" names no component; typed `unknown`',
      'POST /pets: operationId "createPet" is also POST /forms\'s; left out of `api.op` for this route',
      "components.schemas.Pet allOf[1].conditional: `if`, `then` cannot be expressed in TypeScript; typed `unknown`",
      'components.schemas.Pet allOf[1].external: `$ref` "other.json#/Thing" points outside the document; typed `unknown`',
      "components.schemas.Pet allOf[1].notString: `not` cannot be expressed in TypeScript; typed `unknown`",
      'components.schemas.Pet allOf[1].selfPointer → #/components/schemas/Pet/allOf/1/properties/selfPointer: `$ref` "#/components/schemas/Pet/allOf/1/properties/selfPointer" is recursive and not a component, so it has no name to recurse through; typed `unknown`',
    ]);
  });

  it("warns when x-bun-errors has no code property to narrow", () => {
    const { warnings, code } = generateRoutes({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/a": {
          get: {
            "x-bun-errors": ["NOPE"],
            responses: {
              "200": { description: "OK" },
              "404": { description: "Not Found" },
            },
          },
        },
      },
    });
    expect(warnings).toEqual([
      {
        at: "GET /a",
        message:
          "`x-bun-errors` lists codes, but no declared error response has a `code` property to narrow",
      },
    ]);
    expect(code).toContain("404: undefined;");
  });

  it("refuses what is not an OpenAPI 3 document", () => {
    expect(() => generateRoutes({ swagger: "2.0" })).toThrow(TypeError);
    expect(() => generateRoutes({ openapi: 3 })).toThrow(
      "expected an OpenAPI 3.x document",
    );
  });
});

describe("route keys", () => {
  it("takes x-bun-route-key when it names the operation's method, else derives one from the path", () => {
    const { code, warnings } = generateRoutes({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/a/{id}": {
          get: {
            "x-bun-route-key": "GET /a/:id(\\d+)",
            responses: { "204": { description: "x" } },
          },
        },
        "/b/{id}.json": { get: { responses: { "204": { description: "x" } } } },
        "/c": {
          post: {
            "x-bun-route-key": "GET /c",
            responses: { "204": { description: "x" } },
          },
        },
      },
    });
    expect(code).toContain('"GET /a/:id(\\\\d+)": {');
    expect(code).toContain('"GET /b/:id.json": {');
    expect(code).toContain('"POST /c": {');
    expect(warnings).toEqual([
      {
        at: "POST /c",
        message:
          '`x-bun-route-key` "GET /c" is not "POST /…"; keyed "POST /c" instead',
      },
    ]);
  });

  it("merges an optional param's two documented paths into one entry, the param optional", () => {
    const { code } = generateRoutes({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/users": {
          get: {
            "x-bun-route-key": "GET /users/:id?",
            responses: { "200": { description: "x" } },
          },
        },
        "/users/{id}": {
          get: {
            "x-bun-route-key": "GET /users/:id?",
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: { "200": { description: "x" } },
          },
        },
      },
    });
    const routes = code.slice(0, code.indexOf("export const manifest"));
    expect(routes.match(/"GET \/users\/:id\?": \{/g)).toHaveLength(1);
    expect(code).toContain("    params: {\n      id?: string;\n    };");
  });

  it("keeps one entry, named by the declared id, for an optional param the generator documents on two paths", () => {
    const app = new BunRouter();
    app
      .get("/root/:a?", (_req, res) => res.json({}))
      .describe({ operationId: "getRoot" });
    const { document } = generateOpenApi(app, { title: "t", version: "1" });
    const ids = Object.values(
      document.paths as Record<string, { get: { operationId: string } }>,
    ).map((item) => item.get.operationId);
    expect(ids.toSorted()).toEqual(["getRoot", "getRootWithoutA"]);
    const { code, warnings } = generateRoutes(document);
    expect(code.slice(0, code.indexOf("export const manifest"))).toContain(
      '"GET /root/:a?": {',
    );
    expect(code.match(/"GET \/root\/:a\?": \{/g)).toHaveLength(2); // route + manifest
    expect(code).toContain('operationId: "getRoot"');
    expect(code).not.toContain("getRootWithoutA");
    expect(warnings.filter((w) => w.message.includes("operationId"))).toEqual(
      [],
    );
  });

  it("types a wildcard as an array of segments", () => {
    const { code } = generateRoutes({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/f": {
          get: {
            "x-bun-route-key": "GET /files/*path",
            responses: { "200": { description: "x" } },
          },
        },
      },
    });
    expect(code).toContain("    params: {\n      path: string[];\n    };");
  });
});
