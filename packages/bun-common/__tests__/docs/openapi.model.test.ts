/**
 * The documents as the model (typed-client plan §3.0, §8.2, PR-M1): every
 * operation `generateOpenApi` emits carries `x-bun-route-key`, the key
 * `listRoutes` lists it under — through a mount, a double mount, a nested
 * mount with params and a `defineRoutes` registry — and `.describe({ errors,
 * cache })` arrive as `x-bun-errors` and `x-bun-cache`, a registry's own
 * `RouteDef.describe()` included.
 */
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunRouter } from "../../lib/BunRouter";
import { validate } from "../../lib/BunValidate";
import { defineRoutes } from "../../lib/defineRoutes";
import type { DocWarning, OpenApiDocument } from "../../lib/docs/index";
import { generateOpenApi, toOpenApiPath } from "../../lib/docs/index";
import { listRoutes } from "../../lib/routeModel";

const OPTIONS = { title: "Model", version: "1.0.0" };
const METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
];

/** One emitted operation, with where it sits. */
interface Operation {
  readonly path: string;
  readonly method: string;
  readonly operation: Record<string, unknown>;
}

/** Every operation of a document. */
function operationsOf(document: OpenApiDocument): Operation[] {
  const out: Operation[] = [];
  const paths = document.paths as Record<string, Record<string, unknown>>;
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (METHODS.includes(method)) {
        out.push({
          path,
          method,
          operation: operation as Record<string, unknown>,
        });
      }
    }
  }
  return out;
}

/** The warnings this PR's extensions raise (each starts with `.describe()`). */
function extensionWarnings(warnings: readonly DocWarning[]): string[] {
  return warnings
    .map((warning) => warning.message)
    .filter((message) => message.startsWith(".describe()"));
}

/** The operation at `path`/`method`. */
function op(
  document: OpenApiDocument,
  path: string,
  method: string,
): Record<string, unknown> {
  const item = (document.paths as Record<string, Record<string, unknown>>)[
    path
  ];
  expect(item).toBeDefined();
  return item[method] as Record<string, unknown>;
}

/** An app with every shape a route key must survive. */
function app(): BunRouter {
  const router = new BunRouter();
  router
    .get("/health", (_req, res) => res.json({ ok: true }))
    .describe({ hidden: true });
  router.get("/root/:a?", (_req, res) => res.json({}));
  router.get("/re/:id(\\d+)", (_req, res) => res.json({}));
  router.get("/files/*rest", (_req, res) => res.json({}));
  router.all("/any", (_req, res) => res.json({}));

  // A sub-router, mounted twice: one doc, two keys.
  const users = new BunRouter();
  users
    .get(
      "/:id",
      validate({ params: z.object({ id: z.string() }) }),
      (req, res) => res.json({ id: req.params.id }),
    )
    .describe({
      errors: ["NOT_FOUND"],
      cache: { tags: ["user:{id}"] },
    });
  users
    .patch("/:id", (_req, res) => res.json({}))
    .describe({ cache: { invalidates: ["user:{id}", "users"] } });
  router.use("/users", users);
  router.use("/v2/users", users);

  // A nested mount whose own path has params.
  const members = new BunRouter();
  members.get("/members/:memberId", (_req, res) => res.json({}));
  const orgs = new BunRouter();
  orgs.use("/:org", members);
  router.use("/orgs", orgs);

  // A registry.
  const posts = defineRoutes("/posts", (r) => ({
    listPosts: r.get("/", (_req, res) => res.json([])),
    getPost: r.get("/:postId", (_req, res) => res.json({})),
  }));
  router.use(posts.mount, posts.router);
  return router;
}

describe("x-bun-route-key", () => {
  it("is on every operation, and is the listing's key", () => {
    const router = app();
    const { document } = generateOpenApi(router, OPTIONS);
    const operations = operationsOf(document);
    expect(operations.length).toBeGreaterThan(0);
    const listed = new Map(listRoutes(router).map((r) => [r.key, r]));
    for (const { path, method, operation } of operations) {
      const key = operation["x-bun-route-key"];
      expect(typeof key).toBe("string");
      const route = listed.get(key as string);
      expect(route).toBeDefined();
      // The key names the operation's own method, and its path documents as
      // this operation's template.
      expect(route!.method.toLowerCase()).toBe(method);
      expect(toOpenApiPath(route!.path).templates.map((t) => t.path)).toContain(
        path,
      );
    }
  });

  it("agrees with listRoutes both ways: every documentable route is in the document under its key", () => {
    const router = app();
    const { document } = generateOpenApi(router, OPTIONS);
    const emitted = new Set(
      operationsOf(document).map((o) => o.operation["x-bun-route-key"]),
    );
    const documentable = listRoutes(router)
      .filter((route) => route.method !== "ALL")
      .filter((route) => route.key !== "GET /health") // hidden
      .filter((route) => toOpenApiPath(route.path).undocumentable === undefined)
      .map((route) => route.key);
    expect([...emitted].sort()).toEqual([...documentable].sort());
    expect(emitted).toEqual(
      new Set([
        "GET /root/:a?",
        "GET /re/:id(\\d+)",
        "GET /users/:id",
        "PATCH /users/:id",
        "GET /v2/users/:id",
        "PATCH /v2/users/:id",
        "GET /orgs/:org/members/:memberId",
        "GET /posts/",
        "GET /posts/:postId",
      ]),
    );
  });

  it("keeps the Express form OpenAPI's template loses: an optional param's two paths carry one key, a regex param its pattern", () => {
    const { document } = generateOpenApi(app(), OPTIONS);
    expect(op(document, "/root", "get")["x-bun-route-key"]).toBe(
      "GET /root/:a?",
    );
    expect(op(document, "/root/{a}", "get")["x-bun-route-key"]).toBe(
      "GET /root/:a?",
    );
    expect(op(document, "/re/{id}", "get")["x-bun-route-key"]).toBe(
      "GET /re/:id(\\d+)",
    );
  });

  it("survives a mount, a double mount, a nested mount with params and a registry", () => {
    const { document } = generateOpenApi(app(), OPTIONS);
    expect(op(document, "/users/{id}", "get")["x-bun-route-key"]).toBe(
      "GET /users/:id",
    );
    expect(op(document, "/v2/users/{id}", "get")["x-bun-route-key"]).toBe(
      "GET /v2/users/:id",
    );
    expect(
      op(document, "/orgs/{org}/members/{memberId}", "get")["x-bun-route-key"],
    ).toBe("GET /orgs/:org/members/:memberId");
    const listPosts = op(document, "/posts/", "get");
    expect(listPosts["x-bun-route-key"]).toBe("GET /posts/");
    expect(listPosts.operationId).toBe("listPosts");
    expect(op(document, "/posts/{postId}", "get")["x-bun-route-key"]).toBe(
      "GET /posts/:postId",
    );
  });

  it("is the generator's own: a hand-written one is replaced, with a warning", () => {
    const router = new BunRouter();
    router
      .get("/x", (_req, res) => res.json({}))
      .describe({ extensions: { "x-bun-route-key": "GET /y", "x-other": 1 } });
    const { document, warnings } = generateOpenApi(router, OPTIONS);
    const operation = op(document, "/x", "get");
    expect(operation["x-bun-route-key"]).toBe("GET /x");
    expect(operation["x-other"]).toBe(1);
    expect(extensionWarnings(warnings)).toEqual([
      '.describe() extensions set "x-bun-route-key", which the generator also sets; the generator wins',
    ]);
  });
});

describe("x-bun-errors and x-bun-cache", () => {
  it("are emitted from .describe({ errors, cache }), and survive both mounts", () => {
    const { document, warnings } = generateOpenApi(app(), OPTIONS);
    for (const prefix of ["/users", "/v2/users"]) {
      const get = op(document, `${prefix}/{id}`, "get");
      expect(get["x-bun-errors"]).toEqual(["NOT_FOUND"]);
      expect(get["x-bun-cache"]).toEqual({ tags: ["user:{id}"] });
      const patch = op(document, `${prefix}/{id}`, "patch");
      expect(patch["x-bun-errors"]).toBeUndefined();
      expect(patch["x-bun-cache"]).toEqual({
        invalidates: ["user:{id}", "users"],
      });
    }
    expect(extensionWarnings(warnings)).toEqual([]);
  });

  it("are absent where nothing declares them, and [] / {} where declared empty", () => {
    const router = new BunRouter();
    router.get("/plain", (_req, res) => res.json({}));
    router
      .get("/empty", (_req, res) => res.json({}))
      .describe({ errors: [], cache: {} });
    const { document } = generateOpenApi(router, OPTIONS);
    const plain = op(document, "/plain", "get");
    expect(Object.keys(plain).filter((k) => k.startsWith("x-"))).toEqual([
      "x-bun-route-key",
    ]);
    const empty = op(document, "/empty", "get");
    expect(empty["x-bun-errors"]).toEqual([]);
    expect(empty["x-bun-cache"]).toEqual({});
  });

  it("reach a registry's route through its terminal callback's doc", () => {
    const handler = (_req: unknown, res: { send: (v: string) => void }) =>
      res.send("ok");
    // The doc is keyed on the terminal callback (routeDoc.ts), so a handler
    // documented once carries its doc into the registry that reuses it.
    new BunRouter()
      .get("/elsewhere", handler)
      .describe({ errors: ["GONE"], cache: { tags: ["post"] } });
    const posts = defineRoutes("/posts", (r) => ({
      getPost: r.get("/:postId", handler),
    }));
    const router = new BunRouter();
    router.use(posts.mount, posts.router);
    const { document } = generateOpenApi(router, OPTIONS);
    const get = op(document, "/posts/{postId}", "get");
    expect(get.operationId).toBe("getPost");
    expect(get["x-bun-errors"]).toEqual(["GONE"]);
    expect(get["x-bun-cache"]).toEqual({ tags: ["post"] });
  });

  it("win over a hand-written extension of the same name, with a warning only when they differ", () => {
    const router = new BunRouter();
    router
      .get("/a/:id", (_req, res) => res.json({}))
      .describe({
        errors: ["A"],
        cache: { tags: ["a:{id}"] },
        extensions: {
          "x-bun-errors": ["B"],
          "x-bun-cache": { tags: ["a:{id}"] },
        },
      });
    router
      .get("/hand", (_req, res) => res.json({}))
      .describe({ extensions: { "x-bun-errors": ["HAND"] } });
    const { document, warnings } = generateOpenApi(router, OPTIONS);
    expect(op(document, "/a/{id}", "get")["x-bun-errors"]).toEqual(["A"]);
    expect(op(document, "/a/{id}", "get")["x-bun-cache"]).toEqual({
      tags: ["a:{id}"],
    });
    // A hand-written one alone passes through verbatim.
    expect(op(document, "/hand", "get")["x-bun-errors"]).toEqual(["HAND"]);
    expect(extensionWarnings(warnings)).toEqual([
      '.describe() extensions set "x-bun-errors", which .describe({ errors }) also sets; .describe({ errors }) wins',
    ]);
  });

  it("warn on a cache template naming a param the path lacks, and on a non-string entry", () => {
    const router = new BunRouter();
    router
      .get("/u/:id", (_req, res) => res.json({}))
      .describe({
        errors: ["OK", 3 as unknown as string],
        cache: { tags: ["u:{id}", "u:{slug}"], invalidates: ["all"] },
      });
    const { document, warnings } = generateOpenApi(router, OPTIONS);
    const get = op(document, "/u/{id}", "get");
    expect(get["x-bun-errors"]).toEqual(["OK"]);
    expect(get["x-bun-cache"]).toEqual({
      tags: ["u:{id}", "u:{slug}"],
      invalidates: ["all"],
    });
    expect(extensionWarnings(warnings)).toEqual([
      ".describe() errors holds a non-string (number); dropped",
      '.describe() cache.tags template "u:{slug}" names {slug}, which is not a param of the path; emitted as written',
    ]);
    // Strict mode escalates them, as every warning.
    expect(() =>
      generateOpenApi(router, { ...OPTIONS, strict: "strict" }),
    ).toThrow(/names \{slug\}/);
  });
});

describe("a described defineRoutes registry (RouteDef.describe())", () => {
  /** A registry under a mount with a param: one route described, or none. */
  function registry(described: boolean) {
    return defineRoutes("/orgs/:org/posts", (r) => {
      const getPost = r.get(
        "/:postId",
        validate({ params: z.object({ org: z.string(), postId: z.string() }) }),
        (req, res) => res.json({ id: req.params.postId }),
      );
      const updatePost = r.patch("/:postId", (_req, res) => res.json({}));
      if (described) {
        getPost.describe({
          summary: "Read one post",
          errors: ["NOT_FOUND", "FORBIDDEN"],
          // `org` is the mount's param: the full path declares it.
          cache: { tags: ["post:{postId}", "org:{org}"] },
        });
        updatePost.describe({
          cache: { invalidates: ["post:{postId}"] },
          extensions: { "x-bun-route-key": "PATCH /elsewhere" },
        });
      }
      return { getPost, updatePost };
    });
  }

  /** The registry mounted as written, inside a router mounted at `/api`. */
  function nested(described: boolean): BunRouter {
    const posts = registry(described);
    const orgs = new BunRouter();
    orgs.use(posts.mount, posts.router);
    const router = new BunRouter();
    router.use("/api", orgs);
    return router;
  }

  it("emits its summary, x-bun-errors and x-bun-cache through a nested mount", () => {
    const { document, warnings } = generateOpenApi(nested(true), OPTIONS);
    const path = "/api/orgs/{org}/posts/{postId}";
    const get = op(document, path, "get");
    expect(get.summary).toBe("Read one post");
    expect(get.operationId).toBe("getPost");
    expect(get["x-bun-errors"]).toEqual(["NOT_FOUND", "FORBIDDEN"]);
    expect(get["x-bun-cache"]).toEqual({
      tags: ["post:{postId}", "org:{org}"],
    });
    const patch = op(document, path, "patch");
    expect(patch.operationId).toBe("updatePost");
    expect(patch["x-bun-cache"]).toEqual({ invalidates: ["post:{postId}"] });
    expect(patch["x-bun-errors"]).toBeUndefined();
    // The only extension warning is the hand-written route key's: `{org}`,
    // the mount's param, is the full path's, so no template warning.
    expect(extensionWarnings(warnings)).toEqual([
      '.describe() extensions set "x-bun-route-key", which the generator also sets; the generator wins',
    ]);
  });

  it("leaves x-bun-route-key unchanged: the listing's key, the same as an undescribed twin's", () => {
    const router = nested(true);
    const keysOf = (r: BunRouter) =>
      operationsOf(generateOpenApi(r, OPTIONS).document)
        .map(
          (o) =>
            `${o.method} ${o.path} ${String(o.operation["x-bun-route-key"])}`,
        )
        .sort();
    expect(keysOf(router)).toEqual([
      "get /api/orgs/{org}/posts/{postId} GET /api/orgs/:org/posts/:postId",
      "patch /api/orgs/{org}/posts/{postId} PATCH /api/orgs/:org/posts/:postId",
    ]);
    expect(keysOf(router)).toEqual(keysOf(nested(false)));
    const listed = listRoutes(router).map((route) => route.key);
    expect(listed.sort()).toEqual([
      "GET /api/orgs/:org/posts/:postId",
      "PATCH /api/orgs/:org/posts/:postId",
    ]);
  });

  it("control: the undescribed twin has the names and keys, and none of the doc", () => {
    const { document } = generateOpenApi(nested(false), OPTIONS);
    const get = op(document, "/api/orgs/{org}/posts/{postId}", "get");
    expect(get.operationId).toBe("getPost");
    expect(get.summary).toBeUndefined();
    expect(get["x-bun-errors"]).toBeUndefined();
    expect(get["x-bun-cache"]).toBeUndefined();
  });
});
