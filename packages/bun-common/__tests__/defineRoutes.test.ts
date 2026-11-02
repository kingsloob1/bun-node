/**
 * AD (a2): the `defineRoutes` registry — a helper over `.describe()` that
 * declares a group of routes as data (plan §11 row (a2); the typed-client
 * plan's §8.5). Each definition registers on the registry's own router, the
 * property name becomes the route's `operationId`, and the registry mounts as
 * an ordinary sub-router.
 */
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunRouter } from "../lib/BunRouter";
import { validate } from "../lib/BunValidate";
import type { RouteDef } from "../lib/defineRoutes";
import { defineRoutes } from "../lib/defineRoutes";
import { routeDocFor } from "../lib/docs/routeDoc";
import type { OpenApiDocument } from "../lib/docs/index";
import { ConfigError } from "../lib/errors";
import { listRoutes } from "../lib/routeModel";
import { generateOpenApi } from "../lib/docs/index";

const IdParams = z.object({ id: z.string() });
const NewUser = z.object({ name: z.string() });
const PageQuery = z.object({ page: z.coerce.number().default(1) });
const User = z.object({ id: z.string() });
const UserList = z.object({ page: z.number(), type: z.string() });

/** A small registry reused across the suites. */
function usersRegistry() {
  return defineRoutes("/users", (r) => ({
    getUser: r.get(
      "/:id",
      validate({ params: IdParams }, { responses: { 200: User } }),
      (req, res) => {
        res.json({ id: req.params.id });
      },
    ),
    createUser: r.post(
      "/",
      validate(
        { body: NewUser },
        { onFailure: "respond", responses: { 201: NewUser } },
      ),
      (req, res) => {
        res.status(201).json(req.body);
      },
    ),
    listUsers: r.get(
      "/",
      validate({ query: PageQuery }, { responses: { 200: UserList } }),
      (req, res) => {
        res.json({ page: req.query.page, type: typeof req.query.page });
      },
    ),
  }));
}

/** The operationId a listed route's terminal callback carries, if any. */
function operationIdOf(router: BunRouter, routeIndex: number) {
  return routeDocFor(router.routes()[routeIndex]?.callbacks.at(-1))
    ?.operationId;
}

/** An operation out of a document (`openapi.test.ts`'s helper). */
function op(
  document: OpenApiDocument,
  path: string,
  method: string,
): Record<string, any> {
  return (document.paths as Record<string, Record<string, any>>)[path]?.[
    method
  ];
}

describe("defineRoutes: registration and serving", () => {
  it("mounts as an ordinary sub-router and serves", async () => {
    const users = usersRegistry();
    const app = new BunRouter();
    app.use(users.mount, users.router);

    const read = await app.fetch("/users/42");
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ id: "42" });

    const list = await app.fetch("/users?page=3");
    expect(await list.json()).toEqual({ page: 3, type: "number" });
  });

  it("registers on the registry's own router, so it serves unmounted too", async () => {
    const users = usersRegistry();
    const response = await users.router.fetch("/users/7");
    // The declared mount is a compile-time view; the route lives at "/:id" on
    // the inner router, which knows nothing of "/users".
    expect(response.status).toBe(404);
    expect((await users.router.fetch("/7")).status).toBe(200);
  });

  it("a validator inside a definition validates as usual", async () => {
    const users = usersRegistry();
    const app = new BunRouter();
    app.use(users.mount, users.router);

    const bad = await app.fetch("/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: 7 }),
    });
    expect(bad.status).toBe(400);

    const good = await app.fetch("/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    });
    expect(good.status).toBe(201);
    expect(await good.json()).toEqual({ name: "Ada" });
  });

  it("covers the six common verbs", async () => {
    const seen: string[] = [];
    const api = defineRoutes("/v", (r) => ({
      read: r.get("/x", (_req, res) => res.send("get")),
      create: r.post("/x", (_req, res) => res.send("post")),
      replace: r.put("/x", (_req, res) => res.send("put")),
      remove: r.delete("/x", (_req, res) => res.send("delete")),
      update: r.patch("/x", (_req, res) => res.send("patch")),
      every: r.all("/y", (req, res) => {
        seen.push(req.method);
        res.send("all");
      }),
    }));
    const app = new BunRouter();
    app.use(api.mount, api.router);

    for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"] as const) {
      const response = await app.fetch("/v/x", { method });
      expect(await response.text()).toBe(method.toLowerCase());
    }
    // `all()` answers any verb, and lists as ALL.
    expect((await app.fetch("/v/y", { method: "OPTIONS" })).status).toBe(200);
    expect(listRoutes(app).map((route) => route.key)).toContain("ALL /v/y");
    expect(seen).toEqual(["OPTIONS"]);
  });
});

describe("defineRoutes: the property name is the operationId", () => {
  it("names operations in the generated document, no annotation", () => {
    const users = usersRegistry();
    const app = new BunRouter();
    app.use(users.mount, users.router);

    const { document, warnings } = generateOpenApi(app, {
      title: "T",
      version: "1",
    });
    expect(warnings).toEqual([]);
    expect(op(document, "/users/{id}", "get").operationId).toBe("getUser");
    expect(op(document, "/users/", "post").operationId).toBe("createUser");
  });

  it("is readable through listRoutes' routeIndex lookup", () => {
    const users = usersRegistry();
    const app = new BunRouter();
    app.use(users.mount, users.router);

    const byKey = new Map(
      listRoutes(app).map((route) => [
        route.key,
        operationIdOf(app, route.routeIndex),
      ]),
    );
    expect(byKey.get("GET /users/:id")).toBe("getUser");
    expect(byKey.get("POST /users/")).toBe("createUser");
    expect(byKey.get("GET /users/")).toBe("listUsers");
  });

  it("control: a route registered without the registry has no declared operationId", () => {
    const users = usersRegistry();
    const app = new BunRouter();
    app.use(users.mount, users.router);
    app.get("/health", (_req, res) => res.send("ok"));

    const listed = listRoutes(app);
    const health = listed.find((route) => route.key === "GET /health")!;
    // No doc at all — the derived name in the document is the generator's,
    // not a property's.
    expect(operationIdOf(app, health.routeIndex)).toBeUndefined();

    const { document } = generateOpenApi(app, { title: "T", version: "1" });
    expect(op(document, "/health", "get").operationId).toBe("getHealth");
    expect(op(document, "/users/{id}", "get").operationId).toBe("getUser");
  });

  it(".describe()'s collision rules apply: a duplicate operation id is a ConfigError, never a rename", () => {
    const users = defineRoutes("/users", (r) => ({
      same: r.get("/:id", (_req, res) => res.json({})),
    }));
    const app = new BunRouter();
    app.use(users.mount, users.router);
    app
      .get("/other", (_req, res) => res.json({}))
      .describe({ operationId: "same" });

    expect(() => generateOpenApi(app, { title: "T", version: "1" })).toThrow(
      ConfigError,
    );
    expect(() => generateOpenApi(app, { title: "T", version: "1" })).toThrow(
      /operation id "same"/,
    );
  });

  it("merges with a doc the terminal callback already carries, as describe() does", () => {
    const handler = (_req: unknown, res: { send: (v: string) => void }) =>
      res.send("ok");
    const direct = new BunRouter();
    // The same terminal callback documented directly first...
    direct.get("/direct", handler).describe({ summary: "Direct" });
    defineRoutes("/users", (r) => ({
      // ...then reused in a registry: one doc, the operationId merged in.
      reused: r.get("/reused", handler),
    }));

    expect(routeDocFor(handler)).toEqual({
      summary: "Direct",
      operationId: "reused",
    });
  });
});

describe("defineRoutes: the returned registry", () => {
  it("carries every definition with its method, full path and callbacks", () => {
    const users = usersRegistry();
    expect(users.getUser.method).toBe("GET");
    expect(users.getUser.path).toBe("/users/:id");
    expect(users.createUser.method).toBe("POST");
    expect(users.createUser.path).toBe("/users/");
    expect(users.getUser.callbacks).toHaveLength(2);

    expect(users.mount).toBe("/users");
    expect(users.router).toBeInstanceOf(BunRouter);
  });

  it("an empty registry mounts nothing", () => {
    const empty = defineRoutes("/empty", () => ({}));
    const app = new BunRouter();
    app.use(empty.mount, empty.router);
    expect(listRoutes(app)).toEqual([]);
  });

  it("rejects a reserved property name", () => {
    expect(() =>
      defineRoutes("/users", (r) => ({
        mount: r.get("/:id", (_req, res) => res.json({})),
      })),
    ).toThrow(/"mount" is a reserved property/);
    expect(() =>
      defineRoutes("/users", (r) => ({
        router: r.get("/:id", (_req, res) => res.json({})),
      })),
    ).toThrow(/"router" is a reserved property/);
  });

  it("rejects a property the builder did not make", () => {
    expect(() =>
      defineRoutes("/users", () => ({
        // A hand-made record has no terminal callback to document.
        fake: {
          method: "GET",
          path: "/users/x",
          callbacks: [],
        } as unknown as RouteDef,
      })),
    ).toThrow(/"fake" is not a definition the builder made/);
  });
});

describe("RouteDef.describe(): a definition documents itself", () => {
  it("chains: it returns the same definition, whose own properties stay its data", () => {
    let chained: unknown;
    const users = defineRoutes("/users", (r) => {
      const plain = r.get("/:id", (_req, res) => res.json({}));
      chained = plain.describe({ summary: "Read one user" });
      expect(chained).toBe(plain);
      return { getUser: plain };
    });
    expect(users.getUser).toBe(chained as typeof users.getUser);
    // describe() lives on the prototype: the definition's keys are unchanged.
    expect(Object.keys(users.getUser)).toEqual(["method", "path", "callbacks"]);
    expect(users.getUser.method).toBe("GET");
    expect(users.getUser.path).toBe("/users/:id");
  });

  it("records the doc on the terminal callback, beside the property name's operationId", () => {
    const users = defineRoutes("/users", (r) => ({
      getUser: r
        .get("/:id", (_req, res) => res.json({}))
        .describe({
          summary: "Read one user",
          errors: ["NOT_FOUND"],
          cache: { tags: ["user:{id}"] },
        }),
    }));
    expect(routeDocFor(users.getUser.callbacks.at(-1))).toEqual({
      summary: "Read one user",
      errors: ["NOT_FOUND"],
      cache: { tags: ["user:{id}"] },
      operationId: "getUser",
    });
  });

  it("changes nothing at request time: a described route serves as before", async () => {
    const users = defineRoutes("/users", (r) => ({
      getUser: r
        .get("/:id", validate({ params: IdParams }), (req, res) => {
          res.json({ id: req.params.id });
        })
        .describe({ summary: "Read one user", errors: ["NOT_FOUND"] }),
    }));
    const app = new BunRouter();
    app.use(users.mount, users.router);
    const response = await app.fetch("/users/9");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "9" });
  });

  describe("merge order: the terminal callback's doc, the property name, then describe() in call order", () => {
    it("an explicit operationId wins over the property name, chained inside build", () => {
      const users = defineRoutes("/users", (r) => ({
        getUser: r
          .get("/:id", (_req, res) => res.json({}))
          .describe({ operationId: "readUser" }),
      }));
      const app = new BunRouter();
      app.use(users.mount, users.router);
      const { document } = generateOpenApi(app, { title: "T", version: "1" });
      expect(op(document, "/users/{id}", "get").operationId).toBe("readUser");
      expect(routeDocFor(users.getUser.callbacks.at(-1))?.operationId).toBe(
        "readUser",
      );
    });

    it("an explicit operationId wins too when describe() runs on the returned registry", () => {
      const users = defineRoutes("/users", (r) => ({
        getUser: r.get("/:id", (_req, res) => res.json({})),
      }));
      expect(routeDocFor(users.getUser.callbacks.at(-1))?.operationId).toBe(
        "getUser",
      );
      users.getUser.describe({ operationId: "readUser", summary: "Later" });
      expect(routeDocFor(users.getUser.callbacks.at(-1))).toEqual({
        operationId: "readUser",
        summary: "Later",
      });
    });

    it("control: without an explicit operationId the property name stays", () => {
      const users = defineRoutes("/users", (r) => ({
        getUser: r
          .get("/:id", (_req, res) => res.json({}))
          .describe({ summary: "Read" }),
      }));
      expect(routeDocFor(users.getUser.callbacks.at(-1))?.operationId).toBe(
        "getUser",
      );
    });

    it("wins per key over a doc the terminal callback already carries, keeping its other keys", () => {
      const handler = (_req: unknown, res: { send: (v: string) => void }) =>
        res.send("ok");
      new BunRouter().get("/direct", handler).describe({
        summary: "Direct",
        errors: ["GONE"],
        operationId: "direct",
      });
      defineRoutes("/users", (r) => ({
        reused: r.get("/reused", handler).describe({ summary: "Explicit" }),
      }));
      expect(routeDocFor(handler)).toEqual({
        // The explicit describe() wins its key...
        summary: "Explicit",
        // ...the earlier doc keeps the keys nobody rewrote...
        errors: ["GONE"],
        // ...and the property name replaces the earlier operationId.
        operationId: "reused",
      });
    });

    it("several describe() calls merge in call order, a nested object replaced whole", () => {
      const users = defineRoutes("/users", (r) => ({
        update: r
          .patch("/:id", (_req, res) => res.json({}))
          .describe({
            summary: "First",
            tags: ["users"],
            cache: { tags: ["user:{id}"] },
          })
          .describe({ summary: "Second", cache: { invalidates: ["users"] } }),
      }));
      expect(routeDocFor(users.update.callbacks.at(-1))).toEqual({
        summary: "Second",
        tags: ["users"],
        cache: { invalidates: ["users"] },
        operationId: "update",
      });
    });
  });

  it("hidden: true leaves the route out of the document", () => {
    const users = defineRoutes("/users", (r) => ({
      getUser: r.get("/:id", (_req, res) => res.json({})),
      internal: r
        .get("/internal", (_req, res) => res.json({}))
        .describe({ hidden: true }),
    }));
    const app = new BunRouter();
    app.use(users.mount, users.router);
    const { document } = generateOpenApi(app, { title: "T", version: "1" });
    expect(Object.keys(document.paths as object)).toEqual(["/users/{id}"]);
  });

  it("refuses a definition with no terminal callback, as BunRouter.describe() does", () => {
    defineRoutes("/users", (r) => {
      // Only an untyped call can register a route with no handler.
      const verb = r.get as unknown as (path: string) => RouteDef;
      const empty = verb("/none");
      expect(empty.callbacks).toEqual([]);
      expect(() => empty.describe({ summary: "x" })).toThrow(
        "describe(): the route has no terminal callback to document",
      );
      return {};
    });
  });

  it("refuses a doc that is not an object, as BunRouter.describe() does", () => {
    defineRoutes("/users", (r) => {
      const def = r.get("/:id", (_req, res) => res.json({}));
      for (const bad of [null, undefined, "summary", 3, ["x"]]) {
        expect(() => def.describe(bad as never)).toThrow(TypeError);
        expect(() => def.describe(bad as never)).toThrow(
          "describe(): expected a RouteDoc object",
        );
      }
      return { getUser: def };
    });
  });
});
