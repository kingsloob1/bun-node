/**
 * An optional param documents its route on several paths
 * (`optionalParams: "two-paths"`), and an `operationId` is unique in an
 * OpenAPI 3.1 document. A declared id (or one `options.operationId` returns)
 * stays on the path with every param; each shorter path gets
 * `Without<Params>`. A derived id already differs per path, and the routes'
 * `x-bun-route-key` is shared by the paths, as before.
 */
import { describe, expect, it } from "bun:test";
import { BunRouter } from "../../lib/BunRouter";
import { defineRoutes } from "../../lib/defineRoutes";
import type { OpenApiDocument } from "../../lib/docs/index";
import { generateOpenApi } from "../../lib/docs/index";
import { ConfigError } from "../../lib/errors";

const OPTIONS = { title: "Optional", version: "1.0.0" };

interface Operation {
  operationId?: string;
  "x-bun-route-key"?: string;
}

/** `"<method> <path>"` to the operation. */
function operationsOf(document: OpenApiDocument): Record<string, Operation> {
  const out: Record<string, Operation> = {};
  const paths = document.paths as Record<string, Record<string, Operation>>;
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      out[`${method} ${path}`] = operation;
    }
  }
  return out;
}

/** `"<method> <path>"` to the operation id. */
function idsOf(document: OpenApiDocument): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(operationsOf(document)).map(([key, op]) => [
      key,
      op.operationId,
    ]),
  );
}

describe("an optional param's paths", () => {
  it("keeps a described id on the full path and names the short one", () => {
    const app = new BunRouter();
    app
      .get("/root/:a?", (_req, res) => res.json({}))
      .describe({ operationId: "getRoot" });
    const { document } = generateOpenApi(app, OPTIONS);
    expect(idsOf(document)).toEqual({
      "get /root/{a}": "getRoot",
      "get /root": "getRootWithoutA",
    });
  });

  it("does the same for a defineRoutes property name", () => {
    const routes = defineRoutes("/pages", (r) => ({
      getPage: r.get("/:n?", (_req, res) => res.json({})),
    }));
    const app = new BunRouter();
    app.use(routes.mount, routes.router);
    const { document } = generateOpenApi(app, OPTIONS);
    expect(idsOf(document)).toEqual({
      "get /pages/{n}": "getPage",
      "get /pages": "getPageWithoutN",
    });
  });

  it("keeps two optional params unique, naming what each path drops", () => {
    const app = new BunRouter();
    app
      .get("/x/:a?/:b?", (_req, res) => res.json({}))
      .describe({ operationId: "getX" });
    const { document } = generateOpenApi(app, OPTIONS);
    const ids = idsOf(document);
    expect(ids).toEqual({
      "get /x/{a}/{b}": "getX",
      "get /x/{a}": "getXWithoutB",
      "get /x/{b}": "getXWithoutA",
      "get /x": "getXWithoutAAndB",
    });
    expect(new Set(Object.values(ids)).size).toBe(4);
  });

  it("leaves derived ids as they were, and the route key shared", () => {
    const app = new BunRouter();
    app.get("/root/:a?", (_req, res) => res.json({}));
    const { document } = generateOpenApi(app, OPTIONS);
    const operations = operationsOf(document);
    expect(idsOf(document)).toEqual({
      "get /root/{a}": "getRootByA",
      "get /root": "getRoot",
    });
    expect(operations["get /root/{a}"]["x-bun-route-key"]).toBe(
      "GET /root/:a?",
    );
    expect(operations["get /root"]["x-bun-route-key"]).toBe("GET /root/:a?");
  });

  it("applies to an id the operationId option returns", () => {
    const app = new BunRouter();
    app.get("/root/:a?", (_req, res) => res.json({}));
    const { document } = generateOpenApi(app, {
      ...OPTIONS,
      operationId: () => "named",
    });
    expect(idsOf(document)).toEqual({
      "get /root/{a}": "named",
      "get /root": "namedWithoutA",
    });
  });

  it("composes with a later mount's suffix", () => {
    const routes = defineRoutes("/pages", (r) => ({
      getPage: r.get("/:n?", (_req, res) => res.json({})),
    }));
    const app = new BunRouter();
    app.use(routes.mount, routes.router);
    const v2 = new BunRouter();
    v2.use(routes.mount, routes.router);
    app.use("/v2", v2);
    const { document } = generateOpenApi(app, OPTIONS);
    expect(idsOf(document)).toEqual({
      "get /pages/{n}": "getPage",
      "get /pages": "getPageWithoutN",
      "get /v2/pages/{n}": "getPageV2",
      "get /v2/pages": "getPageV2WithoutN",
    });
  });

  it("still throws when a derived id meets another route's id", () => {
    const app = new BunRouter();
    app
      .get("/root/:a?", (_req, res) => res.json({}))
      .describe({ operationId: "getRoot" });
    app
      .get("/other", (_req, res) => res.json({}))
      .describe({ operationId: "getRootWithoutA" });
    expect(() => generateOpenApi(app, OPTIONS)).toThrow(ConfigError);
  });

  it('under optionalParams "warn" there is one path and the id is as declared', () => {
    const app = new BunRouter();
    app
      .get("/root/:a?", (_req, res) => res.json({}))
      .describe({ operationId: "getRoot" });
    const { document } = generateOpenApi(app, {
      ...OPTIONS,
      optionalParams: "warn",
    });
    expect(idsOf(document)).toEqual({ "get /root/{a}": "getRoot" });
  });
});
