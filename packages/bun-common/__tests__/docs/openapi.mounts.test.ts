/**
 * One route at several mounts (`generateOpenApi`'s operation ids): a declared
 * `operationId` — a `defineRoutes` property name or `.describe({
 * operationId })` — lives on the terminal callback, so mounting the router
 * twice declares it twice. The first mount keeps the id, each later mount's
 * gets the suffix of where its mount differs from the first one's; every
 * other duplicate is still a `ConfigError`. The single-mount golden
 * (`openapi.fixture.test.ts`) pins that nothing else moved.
 */
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunRouter } from "../../lib/BunRouter";
import { validate } from "../../lib/BunValidate";
import { defineRoutes } from "../../lib/defineRoutes";
import type { OpenApiDocument } from "../../lib/docs/index";
import { generateOpenApi } from "../../lib/docs/index";
import { ConfigError } from "../../lib/errors";

const OPTIONS = { title: "Mounts", version: "1.0.0" };

/** Every operation id of a document, by `"<method> <path>"`. */
function idsOf(document: OpenApiDocument): Record<string, string> {
  const out: Record<string, string> = {};
  const paths = document.paths as Record<
    string,
    Record<string, { operationId?: string }>
  >;
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (typeof operation.operationId === "string") {
        out[`${method} ${path}`] = operation.operationId;
      }
    }
  }
  return out;
}

/** A users registry with a validator, a declared response and a renamed route. */
function usersRegistry() {
  return defineRoutes("/users", (r) => ({
    getUser: r
      .get(
        "/:id",
        validate(
          { params: z.object({ id: z.string() }) },
          { responses: { 200: z.object({ id: z.string() }) } },
        ),
        (req, res) => res.json({ id: req.params.id }),
      )
      .describe({ summary: "Read one user" }),
    listUsers: r.get("/", (_req, res) => res.json([])),
    create: r
      .post("/", (_req, res) => res.status(201).json({}))
      .describe({ operationId: "createUser" }),
  }));
}

/** An identifier a generated client's `api.op` can name without quoting. */
const IDENTIFIER = /^[a-z_$][\w$]*$/i;

describe("a registry mounted at two paths", () => {
  /** The registry at `/users` and, through a parent router, at `/v2/users`. */
  function twice(): BunRouter {
    const users = usersRegistry();
    const app = new BunRouter();
    app.use(users.mount, users.router);
    const v2 = new BunRouter();
    v2.use(users.mount, users.router);
    app.use("/v2", v2);
    return app;
  }

  it("documents both mounts: the first keeps the ids, the second's carry its mount's suffix", () => {
    const { document } = generateOpenApi(twice(), OPTIONS);
    expect(idsOf(document)).toEqual({
      "get /users/{id}": "getUser",
      "get /users/": "listUsers",
      "post /users/": "createUser",
      "get /v2/users/{id}": "getUserV2",
      "get /v2/users/": "listUsersV2",
      "post /v2/users/": "createUserV2",
    });
  });

  it("is deterministic, adds no warning, and passes strict mode", () => {
    const first = generateOpenApi(twice(), OPTIONS);
    const second = generateOpenApi(twice(), OPTIONS);
    expect(second.document).toEqual(first.document);
    expect(
      first.warnings.filter((warning) => warning.stage === "operation"),
    ).toEqual([]);
    // The registry's routes declare responses, except two; filtering those
    // out, strict mode (which escalates every warning) has nothing to throw.
    const strict = generateOpenApi(twice(), {
      ...OPTIONS,
      strict: "strict",
      filter: (route) => route.method === "GET" && route.path.endsWith(":id"),
    });
    expect(idsOf(strict.document)).toEqual({
      "get /users/{id}": "getUser",
      "get /v2/users/{id}": "getUserV2",
    });
  });

  it("keeps every other part of the doc on both mounts, and the route keys distinct", () => {
    const { document } = generateOpenApi(twice(), OPTIONS);
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const one = paths["/users/{id}"].get;
    const two = paths["/v2/users/{id}"].get;
    expect(one.summary).toBe("Read one user");
    expect(two.summary).toBe("Read one user");
    expect(one["x-bun-route-key"]).toBe("GET /users/:id");
    expect(two["x-bun-route-key"]).toBe("GET /v2/users/:id");
    const { operationId: _a, "x-bun-route-key": _b, ...restOne } = one;
    const { operationId: _c, "x-bun-route-key": _d, ...restTwo } = two;
    expect(restTwo).toEqual(restOne);
  });

  it("names every operation with a valid identifier", () => {
    const { document } = generateOpenApi(twice(), OPTIONS);
    for (const id of Object.values(idsOf(document))) {
      expect(id).toMatch(IDENTIFIER);
    }
  });

  it("follows the registration order: the mount registered first keeps the ids", () => {
    const users = usersRegistry();
    const app = new BunRouter();
    const v2 = new BunRouter();
    v2.use(users.mount, users.router);
    app.use("/v2", v2);
    app.use(users.mount, users.router);
    const ids = idsOf(generateOpenApi(app, OPTIONS).document);
    expect(ids["get /v2/users/{id}"]).toBe("getUser");
    // `/users` against `/v2/users` differs in nothing it keeps, so the whole
    // mount is the suffix.
    expect(ids["get /users/{id}"]).toBe("getUserUsers");
  });
});

describe("the suffix", () => {
  /** The ids of one `GET /:id` route described `getPost`, mounted at each path in turn. */
  function idsAt(...mounts: string[]): string[] {
    const posts = new BunRouter();
    posts
      .get("/posts/:id", (_req, res) => res.json({}))
      .describe({ operationId: "getPost" });
    const app = new BunRouter();
    for (const mount of mounts) app.use(mount, posts);
    const ids = idsOf(generateOpenApi(app, OPTIONS).document);
    return Object.values(ids);
  }

  it("is the segments where the mount differs from the first one's", () => {
    expect(idsAt("/a", "/b")).toEqual(["getPost", "getPostB"]);
    expect(idsAt("/api/v1", "/api/v2", "/api/v3")).toEqual([
      "getPost",
      "getPostV2",
      "getPostV3",
    ]);
    expect(idsAt("/api/v1/x", "/api/v2/x")).toEqual(["getPost", "getPostV2"]);
    expect(idsAt("/internal-api", "/public-api")).toEqual([
      "getPost",
      "getPostPublicApi",
    ]);
  });

  it("spells a mount's params as the default id does, By<Name>", () => {
    expect(idsAt("/teams", "/orgs/:org")).toEqual([
      "getPost",
      "getPostOrgsByOrg",
    ]);
    expect(idsAt("/orgs/:org", "/teams/:team")).toEqual([
      "getPost",
      "getPostTeamsByTeam",
    ]);
  });

  it("is the whole mount when the mounts differ in nothing it keeps", () => {
    expect(idsAt("/api/users", "/users")).toEqual(["getPost", "getPostUsers"]);
  });

  it("refuses the root mount, which has no words to suffix", () => {
    expect(() => idsAt("/a", "/")).toThrow(ConfigError);
    expect(() => idsAt("/a", "/")).toThrow(
      /"getPost" is declared on a route mounted twice .* has no words/,
    );
  });
});

describe("what is still a ConfigError", () => {
  it("two different routes given one id by hand", () => {
    const router = new BunRouter();
    router
      .get("/a", (_req, res) => res.json({}))
      .describe({ operationId: "same" });
    router
      .get("/b", (_req, res) => res.json({}))
      .describe({ operationId: "same" });
    expect(() => generateOpenApi(router, OPTIONS)).toThrow(
      /Two routes share the operation id "same"/,
    );
  });

  it("two registries naming a route alike, mounted apart (different handlers)", () => {
    const users = defineRoutes("/users", (r) => ({
      list: r.get("/", (_req, res) => res.json([])),
    }));
    const posts = defineRoutes("/posts", (r) => ({
      list: r.get("/", (_req, res) => res.json([])),
    }));
    const app = new BunRouter();
    app.use(users.mount, users.router);
    app.use(posts.mount, posts.router);
    expect(() => generateOpenApi(app, OPTIONS)).toThrow(ConfigError);
    expect(() => generateOpenApi(app, OPTIONS)).toThrow(
      /Two routes share the operation id "list" \(GET \/users\/ and GET \/posts\/\)/,
    );
  });

  it("one described handler registered at two paths of one mount", () => {
    const handler = (_req: unknown, res: { json: (v: unknown) => void }) =>
      res.json({});
    const sub = new BunRouter();
    sub.get("/one", handler as never).describe({ operationId: "shared" });
    sub.get("/two", handler as never);
    const app = new BunRouter();
    app.use("/a", sub);
    expect(() => generateOpenApi(app, OPTIONS)).toThrow(
      /Two routes share the operation id "shared" \(GET \/a\/one and GET \/a\/two\)/,
    );
  });

  it("one described handler at two different paths of two mounts", () => {
    const handler = (_req: unknown, res: { json: (v: unknown) => void }) =>
      res.json({});
    const a = new BunRouter();
    a.get("/one", handler as never).describe({ operationId: "shared" });
    const b = new BunRouter();
    b.get("/two", handler as never);
    const app = new BunRouter();
    app.use("/a", a);
    app.use("/b", b);
    expect(() => generateOpenApi(app, OPTIONS)).toThrow(
      /Two routes share the operation id "shared" \(GET \/a\/one and GET \/b\/two\)/,
    );
  });

  it("a suffixed id another route already declares", () => {
    const users = usersRegistry();
    const app = new BunRouter();
    app
      .get("/legacy", (_req, res) => res.json({}))
      .describe({ operationId: "getUserV2" });
    app.use(users.mount, users.router);
    const v2 = new BunRouter();
    v2.use(users.mount, users.router);
    app.use("/v2", v2);
    expect(() => generateOpenApi(app, OPTIONS)).toThrow(
      /Two routes share the operation id "getUserV2" \(GET \/legacy and GET \/v2\/users\/:id\)/,
    );
  });

  it("a namer's duplicate: the suffix covers declared ids only", () => {
    const posts = new BunRouter();
    posts.get("/posts", (_req, res) => res.json([]));
    const app = new BunRouter();
    app.use("/a", posts);
    app.use("/b", posts);
    expect(() =>
      generateOpenApi(app, { ...OPTIONS, operationId: () => "listPosts" }),
    ).toThrow(/Two routes share the operation id "listPosts"/);
    // Undeclared, the derived ids differ per path, as before.
    expect(
      Object.values(idsOf(generateOpenApi(app, OPTIONS).document)),
    ).toEqual(["getAPosts", "getBPosts"]);
  });
});
