import type { RouterHandler } from "../lib/types/general";
import { describe, expect, it } from "bun:test";
import { BunResponse } from "../lib/BunResponse";
import { BunRouter } from "../lib/BunRouter";
import { makeRequest } from "./helpers";

/** Convenience: layers matched for a request signature. */
function layersFor(
  router: BunRouter,
  method: string,
  url: string,
  host = "localhost",
) {
  return router.getMatchedLayers({
    requestHost: host,
    requestMethod: method,
    requestUrl: url,
  });
}

describe("BunRouter: route registration", () => {
  it("registers routes for the common HTTP verbs", () => {
    const router = new BunRouter();
    router.get("/r", () => {});
    router.post("/r", () => {});
    router.put("/r", () => {});
    router.patch("/r", () => {});
    router.delete("/r", () => {});
    router.head("/r", () => {});
    router.options("/r", () => {});
    expect(router.routes().length).toBe(7);
  });

  it("registers the extended/WebDAV verbs", () => {
    const router = new BunRouter();
    const verbs = [
      "checkout",
      "copy",
      "lock",
      "merge",
      "mkactivity",
      "mkcol",
      "move",
      "notify",
      "propfind",
      "proppatch",
      "purge",
      "report",
      "search",
      "subscribe",
      "trace",
      "unlock",
      "unsubscribe",
      "view",
    ] as const;

    for (const verb of verbs) {
      (router[verb] as (p: string, cb: () => void) => unknown)("/r", () => {});
    }
    expect(router.routes().length).toBe(verbs.length);
  });

  it("addRoute registers a route under an explicit method", () => {
    const router = new BunRouter();
    router.addRoute("get", "/added", () => {});
    expect(layersFor(router, "GET", "/added")).toHaveLength(1);
  });

  it("add registers a route under an explicit method", () => {
    const router = new BunRouter();
    router.add("post", "/added", () => {});
    expect(layersFor(router, "POST", "/added")).toHaveLength(1);
  });

  it("any registers a route matching several methods", () => {
    const router = new BunRouter();
    router.any(["GET", "POST"], "/multi", () => {});
    expect(layersFor(router, "GET", "/multi").length).toBeGreaterThan(0);
    expect(layersFor(router, "POST", "/multi").length).toBeGreaterThan(0);
  });

  it("all registers a path-scoped, method-agnostic route", () => {
    const router = new BunRouter();
    router.all("/any-method", () => {});
    expect(layersFor(router, "GET", "/any-method").length).toBeGreaterThan(0);
    expect(layersFor(router, "DELETE", "/any-method").length).toBeGreaterThan(
      0,
    );
  });

  it("use registers middleware (no method)", () => {
    const router = new BunRouter();
    router.use(() => {});
    expect(router.routes().length).toBe(1);
  });

  it("setRoute registers a named route and rejects duplicate names", () => {
    const router = new BunRouter();
    router.setRoute({
      path: "/a",
      method: "GET",
      name: "alpha",
      callbacks: [() => {}],
    });
    expect(() =>
      router.setRoute({
        path: "/b",
        method: "GET",
        name: "alpha",
        callbacks: [],
      }),
    ).toThrow("already exists");
  });
});

describe("BunRouter: getRouteByName", () => {
  it("resolves a route registered with a name", () => {
    const router = new BunRouter();
    router.setRoute({
      path: "/named",
      method: "GET",
      name: "namedRoute",
      callbacks: [() => {}],
    });
    expect(router.getRouteByName("namedRoute")).toBeDefined();
    expect(router.getRouteByName("missing")).toBeUndefined();
  });
});

describe("BunRouter: getMatchedLayers", () => {
  it("matches a route handler for the right method and path", () => {
    const router = new BunRouter();
    router.get("/users/:id", () => {});

    const handlers = layersFor(router, "GET", "/users/42").filter(
      (layer) => layer.isRouteHandler,
    );
    expect(handlers).toHaveLength(1);
    expect(handlers[0].matched.params).toEqual({ id: "42" });
  });

  it("does not match a route handler for a different method", () => {
    const router = new BunRouter();
    router.get("/users", () => {});

    const handlers = layersFor(router, "POST", "/users").filter(
      (layer) => layer.isRouteHandler,
    );
    expect(handlers).toHaveLength(0);
  });

  it("flags middleware layers as non-route-handlers", () => {
    const router = new BunRouter();
    router.use(() => {});

    const [layer] = layersFor(router, "GET", "/anything");
    expect(layer).toBeDefined();
    expect(layer.isRouteHandler).toBe(false);
    expect(layer.isErrorHandler).toBe(false);
  });

  it("flags a 4-argument callback as an error handler", () => {
    const router = new BunRouter();
    // A 4-arity callback is an Express-style error handler.
    const errorHandler = (
      _err: unknown,
      _req: unknown,
      _res: unknown,
      _next: unknown,
    ) => {};
    router.use(errorHandler as unknown as RouterHandler);

    const [layer] = layersFor(router, "GET", "/anything");
    expect(layer.isErrorHandler).toBe(true);
  });

  it("emits one layer per callback of a route", () => {
    const router = new BunRouter();
    router.get(
      "/multi",
      () => {},
      () => {},
      () => {},
    );

    const handlers = layersFor(router, "GET", "/multi").filter(
      (layer) => layer.isRouteHandler,
    );
    expect(handlers).toHaveLength(3);
    expect(handlers.map((layer) => layer.callbackIndex)).toEqual([0, 1, 2]);
  });
});

describe("BunRouter: caching", () => {
  it("builds a stable, query-stripped cache key", () => {
    const router = new BunRouter();
    const key = router.getCacheKey({
      requestHost: "localhost",
      requestMethod: "GET",
      requestUrl: "/x?y=1",
    });
    expect(key).toContain("path:/x");
    expect(key).toContain("method:GET");
    expect(key).not.toContain("y=1");
  });

  it("clearRouteCache returns the router for chaining", () => {
    const router = new BunRouter();
    router.get("/cached", () => {});
    layersFor(router, "GET", "/cached");
    expect(router.clearRouteCache()).toBe(router);
  });

  it("re-resolves layers registered after the cache was cleared", () => {
    const router = new BunRouter();
    expect(layersFor(router, "GET", "/late")).toHaveLength(0);

    router.get("/late", () => {});
    router.clearRouteCache();
    expect(layersFor(router, "GET", "/late")).toHaveLength(1);
  });

  it("returns the identical cached array on a repeated lookup (zero-alloc hit)", () => {
    const router = new BunRouter();
    router.get("/y", () => {});

    const first = layersFor(router, "GET", "/y");
    const second = layersFor(router, "GET", "/y");
    expect(second).toBe(first);
  });

  it("invalidates the cache when a new route is registered", () => {
    const router = new BunRouter();
    router.get("/x", () => {});

    const before = layersFor(router, "GET", "/x").filter(
      (l) => l.isRouteHandler,
    );
    expect(before).toHaveLength(1);

    // Registering another matching route must drop the stale cache entry.
    router.get("/x", () => {});
    const after = layersFor(router, "GET", "/x").filter(
      (l) => l.isRouteHandler,
    );
    expect(after).toHaveLength(2);
  });

  it("stays correct under high path cardinality (LRU eviction)", () => {
    const router = new BunRouter();
    router.get("/items/:id", () => {});

    // Far more distinct paths than the cache bound — eviction must not break
    // matching; every lookup still resolves correctly.
    for (let i = 0; i < 1200; i++) {
      const layers = layersFor(router, "GET", `/items/${i}`).filter(
        (l) => l.isRouteHandler,
      );
      expect(layers).toHaveLength(1);
      expect(layers[0].matched.params).toEqual({ id: String(i) });
    }
  });
});

describe("BunRouter: group & domain", () => {
  it("group prefixes the paths of a nested router", () => {
    const router = new BunRouter();
    const child = new BunRouter();
    child.get("/list", () => {});
    router.group("/api", child);

    expect(
      layersFor(router, "GET", "/api/list").filter((l) => l.isRouteHandler),
    ).toHaveLength(1);
    expect(
      layersFor(router, "GET", "/list").filter((l) => l.isRouteHandler),
    ).toHaveLength(0);
  });

  it("domain scopes a nested router to a host", () => {
    const router = new BunRouter();
    const child = new BunRouter();
    child.get("/info", () => {});
    router.domain("api.test", child);

    expect(
      layersFor(router, "GET", "/info", "api.test").filter(
        (l) => l.isRouteHandler,
      ),
    ).toHaveLength(1);
    expect(
      layersFor(router, "GET", "/info", "other.test").filter(
        (l) => l.isRouteHandler,
      ),
    ).toHaveLength(0);
  });
});

describe("BunRouter: logger", () => {
  it("falls back to console and accepts a custom logger", () => {
    const router = new BunRouter();
    expect(router.logger).toBe(console);

    const custom = { log() {}, error() {}, warn() {} };
    router.setLogger(custom);
    expect(router.logger).toBe(custom);
  });
});

describe("BunRouter: handle", () => {
  async function run(router: BunRouter, method: string, path: string) {
    const request = await makeRequest({
      url: `http://localhost${path}`,
      method,
    });
    const response = new BunResponse(request);
    const result = await router.handle({
      requestHost: "localhost",
      requestMethod: method,
      requestUrl: path,
      request,
      response,
    });
    return { result, response };
  }

  it("invokes the matched handler and ends the response", async () => {
    const router = new BunRouter();
    router.get("/hello", async (_req, res) => res.json({ ok: true }));

    const { result, response } = await run(router, "GET", "/hello");
    expect(result).toBeTruthy();
    const native = await response.getNativeResponse(1000);
    expect(await native.json()).toEqual({ ok: true });
  });

  it("exposes route params to the handler", async () => {
    const router = new BunRouter();
    router.get("/items/:id", async (req, res) => {
      return res.json({ id: req.params.id });
    });

    const { response } = await run(router, "GET", "/items/7");
    const native = await response.getNativeResponse(1000);
    expect(await native.json()).toEqual({ id: "7" });
  });

  it("returns undefined when nothing matches", async () => {
    const router = new BunRouter();
    router.get("/known", () => {});

    const { result } = await run(router, "GET", "/unknown");
    expect(result).toBeUndefined();
  });

  it("propagates an unhandled error thrown by a handler", async () => {
    const router = new BunRouter();
    router.get("/boom", async () => {
      throw new Error("handler failure");
    });

    await expect(run(router, "GET", "/boom")).rejects.toThrow(
      "handler failure",
    );
  });
});
