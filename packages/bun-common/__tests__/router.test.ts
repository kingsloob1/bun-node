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

describe("BunRouter: route cache (routeCacheMax)", () => {
  it("serves a cache hit as the same array reference (zero-allocation)", () => {
    const router = new BunRouter();
    router.get("/cached", () => {});

    const first = layersFor(router, "GET", "/cached");
    const second = layersFor(router, "GET", "/cached");
    expect(second).toBe(first);
  });

  it("accepts a custom routeCacheMax and still routes correctly", () => {
    const router = new BunRouter({ routeCacheMax: 1 });
    router.get("/a", () => {});
    router.get("/b", () => {});

    expect(layersFor(router, "GET", "/a")).toHaveLength(1);
    expect(layersFor(router, "GET", "/b")).toHaveLength(1);
    expect(layersFor(router, "GET", "/a")).toHaveLength(1);
  });

  it("evicts the oldest entry once routeCacheMax is exceeded (FIFO)", () => {
    const router = new BunRouter({ routeCacheMax: 1 });
    router.get("/x", () => {});
    router.get("/y", () => {});

    const x1 = layersFor(router, "GET", "/x");
    // Caching a second distinct signature evicts "/x" (max = 1).
    layersFor(router, "GET", "/y");
    const x2 = layersFor(router, "GET", "/x");

    // "/x" was recomputed (not served from cache) — a fresh, equal array.
    expect(x2).not.toBe(x1);
    expect(x2).toEqual(x1);
  });

  it("falls back to the default cap for an invalid routeCacheMax", () => {
    // 0 is non-positive — rejected in favour of the 2000 default, so a
    // re-requested signature is still served from cache.
    const router = new BunRouter({ routeCacheMax: 0 });
    router.get("/z", () => {});

    const z1 = layersFor(router, "GET", "/z");
    const z2 = layersFor(router, "GET", "/z");
    expect(z2).toBe(z1);
  });
});

describe("BunRouter: pipeline advances only via next()", () => {
  async function exec(router: BunRouter, method: string, path: string) {
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

  it("a verb handler that calls next() advances to the next verb handler", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    router.get("/a", (_req, _res, next) => {
      order.push("first");
      next();
    });
    router.get("/a", (_req, res) => {
      order.push("second");
      res.json({ order });
    });

    const { response } = await exec(router, "GET", "/a");
    const native = await response.getNativeResponse(1000);
    expect(order).toEqual(["first", "second"]);
    expect(await native.json()).toEqual({ order: ["first", "second"] });
  });

  it("a verb handler that calls next() advances to middleware", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    router.get("/a", (_req, _res, next) => {
      order.push("verb");
      next();
    });
    router.use((_req, res) => {
      order.push("middleware");
      res.json({ order });
    });

    const { response } = await exec(router, "GET", "/a");
    await response.getNativeResponse(1000);
    expect(order).toEqual(["verb", "middleware"]);
  });

  it("an all() handler that calls next() advances to a verb handler", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    router.all("/a", (_req, _res, next) => {
      order.push("all");
      next();
    });
    router.get("/a", (_req, res) => {
      order.push("get");
      res.json({ order });
    });

    const { response } = await exec(router, "GET", "/a");
    await response.getNativeResponse(1000);
    expect(order).toEqual(["all", "get"]);
  });

  it("runs a chain of verb and all handlers in order when each calls next()", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    router.get("/a", (_req, _res, next) => {
      order.push("get1");
      next();
    });
    router.all("/a", (_req, _res, next) => {
      order.push("all");
      next();
    });
    router.post("/a", (_req, _res, next) => {
      // Different method — must not run for a GET request.
      order.push("post");
      next();
    });
    router.get("/a", (_req, res) => {
      order.push("get2");
      res.json({ order });
    });

    const { response } = await exec(router, "GET", "/a");
    await response.getNativeResponse(1000);
    expect(order).toEqual(["get1", "all", "get2"]);
  });

  it("hangs when a verb handler neither sends a response nor calls next()", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    router.get("/a", () => {
      order.push("stuck");
    });
    router.get("/a", (_req, res) => {
      order.push("never");
      res.json({ order });
    });

    const { result, response } = await exec(router, "GET", "/a");
    // The first handler ran but never advanced the pipeline.
    expect(order).toEqual(["stuck"]);
    // handle() resolves truthy (not a 404) — the request is left in flight.
    expect(result).toBeTruthy();
    expect(response.headersSent).toBe(false);
    // No response will ever be produced — the request hangs until timeout.
    await expect(response.getNativeResponse(20)).rejects.toThrow("Timedout");
  });

  it("hangs when an async verb handler forgets to respond or call next()", async () => {
    const router = new BunRouter();
    router.get("/a", async () => {
      // Forgot to send a response or call next().
    });

    const { result, response } = await exec(router, "GET", "/a");
    expect(result).toBeTruthy();
    expect(response.headersSent).toBe(false);
    await expect(response.getNativeResponse(20)).rejects.toThrow("Timedout");
  });

  it("hangs when an all() handler neither sends a response nor calls next()", async () => {
    const router = new BunRouter();
    router.all("/a", () => {
      // No response, no next().
    });

    const { result, response } = await exec(router, "GET", "/a");
    expect(result).toBeTruthy();
    expect(response.headersSent).toBe(false);
    await expect(response.getNativeResponse(20)).rejects.toThrow("Timedout");
  });

  it("hangs when a middleware neither sends a response nor calls next()", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    router.use(() => {
      order.push("middleware");
    });
    router.get("/a", (_req, res) => {
      order.push("route");
      res.json({ order });
    });

    const { response } = await exec(router, "GET", "/a");
    // The middleware never called next() — the route handler is unreachable.
    expect(order).toEqual(["middleware"]);
    expect(response.headersSent).toBe(false);
    await expect(response.getNativeResponse(20)).rejects.toThrow("Timedout");
  });

  it("ignores a handler's return value — a returned body does not respond", async () => {
    const router = new BunRouter();
    router.get("/a", () => ({ returned: true }));

    const { response } = await exec(router, "GET", "/a");
    // Returning a value is not sending a response — the request hangs.
    expect(response.headersSent).toBe(false);
    await expect(response.getNativeResponse(20)).rejects.toThrow("Timedout");
  });

  it("stops the pipeline once a verb handler sends a response", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    router.get("/a", (_req, res) => {
      order.push("first");
      res.json({ winner: "first" });
    });
    router.get("/a", (_req, res) => {
      order.push("second");
      res.json({ winner: "second" });
    });

    const { response } = await exec(router, "GET", "/a");
    const native = await response.getNativeResponse(1000);
    expect(order).toEqual(["first"]);
    expect(await native.json()).toEqual({ winner: "first" });
  });

  it("returns undefined (404-able) when the last handler calls next()", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    router.get("/a", (_req, _res, next) => {
      order.push("one");
      next();
    });
    router.get("/a", (_req, _res, next) => {
      order.push("two");
      next();
    });

    const { result } = await exec(router, "GET", "/a");
    // Every handler passed via next() and nothing responded — unhandled.
    expect(order).toEqual(["one", "two"]);
    expect(result).toBeUndefined();
  });
});

describe("BunRouter: use(router) — mounted sub-routers", () => {
  async function exec(router: BunRouter, method: string, path: string) {
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

  it("use(router) mounts a sub-router's routes", async () => {
    const sub = new BunRouter();
    sub.get("/hello", (_req, res) => res.json({ from: "sub" }));

    const app = new BunRouter();
    app.use(sub);

    const { response } = await exec(app, "GET", "/hello");
    const native = await response.getNativeResponse(1000);
    expect(await native.json()).toEqual({ from: "sub" });
  });

  it("use(path, router) mounts a sub-router under a path prefix", async () => {
    const sub = new BunRouter();
    sub.get("/users/:id", (req, res) => res.json({ id: req.params.id }));

    const app = new BunRouter();
    app.use("/api", sub);

    const mounted = await exec(app, "GET", "/api/users/42");
    const native = await mounted.response.getNativeResponse(1000);
    expect(await native.json()).toEqual({ id: "42" });

    // The un-prefixed path must not resolve.
    const unmounted = await exec(app, "GET", "/users/42");
    expect(unmounted.result).toBeUndefined();
  });

  it("runs middleware inside a mounted sub-router and advances via next()", async () => {
    const sub = new BunRouter();
    const order: string[] = [];
    sub.use((_req, _res, next) => {
      order.push("sub-mw");
      next();
    });
    sub.get("/x", (_req, res) => {
      order.push("sub-route");
      res.json({ order });
    });

    const app = new BunRouter();
    app.use(sub);

    const { response } = await exec(app, "GET", "/x");
    await response.getNativeResponse(1000);
    expect(order).toEqual(["sub-mw", "sub-route"]);
  });

  it("use(middleware, router) preserves registration order", async () => {
    const order: string[] = [];
    const sub = new BunRouter();
    sub.get("/x", (_req, res) => {
      order.push("sub");
      res.json({ order });
    });

    const app = new BunRouter();
    app.use((_req, _res, next) => {
      order.push("mw");
      next();
    }, sub);

    const { response } = await exec(app, "GET", "/x");
    await response.getNativeResponse(1000);
    expect(order).toEqual(["mw", "sub"]);
  });

  it("next('router') exits the current mount and runs the next matching router", async () => {
    const order: string[] = [];
    const routerA = new BunRouter();
    routerA.get("/x", (_req, _res, next) => {
      order.push("A1");
      next("router");
    });
    routerA.get("/x", (_req, res) => {
      // Must be skipped — its router was exited.
      order.push("A2");
      res.json({ order });
    });

    const routerB = new BunRouter();
    routerB.get("/x", (_req, res) => {
      order.push("B");
      res.json({ order });
    });

    const app = new BunRouter();
    app.use(routerA);
    app.use(routerB);

    const { response } = await exec(app, "GET", "/x");
    const native = await response.getNativeResponse(1000);
    expect(order).toEqual(["A1", "B"]);
    expect(await native.json()).toEqual({ order: ["A1", "B"] });
  });

  it("next('router') skips a mounted router's error handlers too", async () => {
    const order: string[] = [];
    const routerA = new BunRouter();
    routerA.get("/x", (_req, _res, next) => {
      order.push("A");
      next("router");
    });
    routerA.use(
      (_err: unknown, _req: unknown, _res: unknown, _next: unknown) => {
        // A's error handler must not run — the router was exited.
        order.push("A-error");
      },
    );

    const routerB = new BunRouter();
    routerB.get("/x", (_req, res) => {
      order.push("B");
      res.json({ order });
    });

    const app = new BunRouter();
    app.use(routerA);
    app.use(routerB);

    const { response } = await exec(app, "GET", "/x");
    await response.getNativeResponse(1000);
    expect(order).toEqual(["A", "B"]);
  });

  it("next('router') hands off correctly after specificity reordering", async () => {
    const order: string[] = [];
    // routerB's static `/x` is more specific than routerA's `/:id`, so it
    // runs first even though routerA was mounted first.
    const routerA = new BunRouter();
    routerA.get("/:id", (_req, res) => {
      order.push("A");
      res.json({ order });
    });

    const routerB = new BunRouter();
    routerB.get("/x", (_req, _res, next) => {
      order.push("B");
      next("router");
    });

    // Specificity ordering is opt-in — enable it on the handling router.
    const app = new BunRouter({ routeSpecificity: true });
    app.use(routerA);
    app.use(routerB);

    const { response } = await exec(app, "GET", "/x");
    await response.getNativeResponse(1000);
    // B runs first (more specific), exits its router, A then responds.
    expect(order).toEqual(["B", "A"]);
  });

  it("next('router') from the router's own route abandons the pipeline", async () => {
    const order: string[] = [];
    const app = new BunRouter();
    app.get("/x", (_req, _res, next) => {
      order.push("own");
      next("router");
    });
    app.get("/x", (_req, res) => {
      order.push("after");
      res.json({ order });
    });

    const { result } = await exec(app, "GET", "/x");
    // next('router') from a non-mounted route abandons everything.
    expect(order).toEqual(["own"]);
    expect(result).toBeUndefined();
  });

  it("a verb handler in a mounted router can still advance via plain next()", async () => {
    const order: string[] = [];
    const sub = new BunRouter();
    sub.get("/x", (_req, _res, next) => {
      order.push("sub1");
      next();
    });
    sub.get("/x", (_req, res) => {
      order.push("sub2");
      res.json({ order });
    });

    const app = new BunRouter();
    app.use(sub);

    const { response } = await exec(app, "GET", "/x");
    await response.getNativeResponse(1000);
    expect(order).toEqual(["sub1", "sub2"]);
  });
});

describe("BunRouter: routeSpecificity option", () => {
  async function exec(router: BunRouter, method: string, path: string) {
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

  it("defaults to registration order (Express semantics)", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    // Param route registered first; with the default it runs first.
    router.get("/users/:id", (_req, res) => {
      order.push("param");
      res.json({ order });
    });
    router.get("/users/me", (_req, res) => {
      order.push("static");
      res.json({ order });
    });

    await exec(router, "GET", "/users/me");
    expect(order).toEqual(["param"]);
  });

  it("routeSpecificity: true prefers the more specific route handler", async () => {
    const router = new BunRouter({ routeSpecificity: true });
    const order: string[] = [];
    router.get("/users/:id", (_req, res) => {
      order.push("param");
      res.json({ order });
    });
    router.get("/users/me", (_req, res) => {
      order.push("static");
      res.json({ order });
    });

    await exec(router, "GET", "/users/me");
    // Static beats param regardless of registration order.
    expect(order).toEqual(["static"]);
  });

  it("accepts a custom comparator that sorts route handlers", async () => {
    // A custom rule: param routes run before static ones — the opposite of
    // both registration order and the built-in ranking, proving it is used.
    const paramFirst = (
      a: { route: { path?: string | null } },
      b: { route: { path?: string | null } },
    ) => {
      const aParam = String(a.route.path ?? "").includes(":");
      const bParam = String(b.route.path ?? "").includes(":");
      return Number(bParam) - Number(aParam);
    };

    const router = new BunRouter({ routeSpecificity: paramFirst });
    const order: string[] = [];
    // Static registered first — the comparator still puts the param first.
    router.get("/users/me", (_req, res) => {
      order.push("static");
      res.json({ order });
    });
    router.get("/users/:id", (_req, res) => {
      order.push("param");
      res.json({ order });
    });

    await exec(router, "GET", "/users/me");
    expect(order).toEqual(["param"]);
  });

  it("keeps use() middleware in registration order while reordering routes", async () => {
    const router = new BunRouter({ routeSpecificity: true });
    const order: string[] = [];
    router.use((_req, _res, next) => {
      order.push("mw1");
      next();
    });
    // Param route registered before the static route.
    router.get("/users/:id", (_req, res) => {
      order.push("param");
      res.json({ order });
    });
    router.use((_req, _res, next) => {
      order.push("mw2");
      next();
    });
    router.get("/users/me", (_req, _res, next) => {
      order.push("static");
      next();
    });

    await exec(router, "GET", "/users/me");
    // Middleware keeps its slots (mw1 first, mw2 third); the route handlers
    // are specificity-reordered, so `static` runs before `param`.
    expect(order).toEqual(["mw1", "static", "mw2", "param"]);
  });

  it("includes all() route handlers in specificity ordering", async () => {
    const router = new BunRouter({ routeSpecificity: true });
    const order: string[] = [];
    // all() registered first; the static get() is still more specific.
    router.all("/thing/:id", (_req, _res, next) => {
      order.push("all-param");
      next();
    });
    router.get("/thing/exact", (_req, res) => {
      order.push("get-static");
      res.json({ order });
    });

    await exec(router, "GET", "/thing/exact");
    expect(order).toEqual(["get-static"]);
  });

  it("exposes route params to an all() handler", async () => {
    const router = new BunRouter();
    router.all("/users/:id", (req, res) => res.json({ id: req.params.id }));

    const { response } = await exec(router, "GET", "/users/7");
    const native = await response.getNativeResponse(1000);
    expect(await native.json()).toEqual({ id: "7" });
  });

  it("setRouteSpecificity() switches ordering and drops the cache", async () => {
    const router = new BunRouter();
    router.get("/p/:id", (_req, res) => res.json({ which: "param" }));
    router.get("/p/exact", (_req, res) => res.json({ which: "static" }));

    // Default: registration order — the param route (registered first) wins.
    const before = await exec(router, "GET", "/p/exact");
    const beforeNative = await before.response.getNativeResponse(1000);
    expect(await beforeNative.json()).toEqual({ which: "param" });

    // Enabling specificity drops the cache so the new ordering takes effect.
    expect(router.setRouteSpecificity(true)).toBe(router);
    const after = await exec(router, "GET", "/p/exact");
    const afterNative = await after.response.getNativeResponse(1000);
    expect(await afterNative.json()).toEqual({ which: "static" });
  });
});

describe("BunRouter: useMethod — method-scoped middleware", () => {
  async function exec(router: BunRouter, method: string, path: string) {
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

  it("registers a layer that is middleware, not a route handler", () => {
    const router = new BunRouter();
    router.useMethod("GET", "/x", () => {});

    const [layer] = layersFor(router, "GET", "/x");
    expect(layer).toBeDefined();
    // Like use(): isEndpoint stays false — it is not a route handler.
    expect(layer.isRouteHandler).toBe(false);
  });

  it("matches only the given HTTP method", () => {
    const router = new BunRouter();
    router.useMethod("POST", "/x", () => {});

    expect(layersFor(router, "POST", "/x").length).toBeGreaterThan(0);
    expect(layersFor(router, "GET", "/x")).toHaveLength(0);
  });

  it("ALL makes it method-agnostic, exactly like use()", () => {
    const router = new BunRouter();
    router.useMethod("ALL", () => {});

    expect(layersFor(router, "GET", "/anything").length).toBeGreaterThan(0);
    expect(layersFor(router, "POST", "/anything").length).toBeGreaterThan(0);
  });

  it("runs as middleware before the route handler", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    router.useMethod("GET", (_req, _res, next) => {
      order.push("mw");
      next();
    });
    router.get("/x", (_req, res) => {
      order.push("route");
      res.json({ order });
    });

    const { response } = await exec(router, "GET", "/x");
    await response.getNativeResponse(1000);
    expect(order).toEqual(["mw", "route"]);
  });

  it("keeps registration order even when specificity is enabled", async () => {
    const router = new BunRouter({ routeSpecificity: true });
    const order: string[] = [];
    router.useMethod("GET", (_req, _res, next) => {
      order.push("mw");
      next();
    });
    // Param route registered before the static one.
    router.get("/users/:id", (_req, _res, next) => {
      order.push("param");
      next();
    });
    router.get("/users/me", (_req, res) => {
      order.push("static");
      res.json({ order });
    });

    const { response } = await exec(router, "GET", "/users/me");
    await response.getNativeResponse(1000);
    // The route handlers are specificity-sorted (static first); the
    // useMethod middleware keeps its registration slot at the front.
    expect(order).toEqual(["mw", "static"]);
  });
});
