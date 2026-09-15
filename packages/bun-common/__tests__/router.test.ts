import type { BunRequest } from "../lib/BunRequest";
import type {
  RouterErrorMiddlewareHandler,
  RouterHandler,
} from "../lib/types/general";
import { Router } from "@routejs/router";
import { describe, expect, it } from "bun:test";
import { BunResponse } from "../lib/BunResponse";
import { BunRouter } from "../lib/BunRouter";
import { BunWebSocket } from "../lib/BunWebSocket";
import { createTestLogger, isLogger } from "../lib/logging";
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
  it("defaults to a structured console logger", () => {
    const router = new BunRouter();
    expect(isLogger(router.logger)).toBe(true);
    expect(router.logger.level).toBe("info");
  });

  it("returns a structured logger unchanged", () => {
    const { logger, events } = createTestLogger();
    const router = new BunRouter({ logger });

    expect(router.logger).toBe(logger);
    router.logger.warn("careful");
    expect(events.at(-1)).toMatchObject({ level: "warn", message: "careful" });
  });

  it("adapts a console-like logger, so old call sites keep working", () => {
    const lines: unknown[][] = [];
    const custom = {
      log: (...args: unknown[]) => lines.push(args),
      error: () => {},
      warn: () => {},
    };

    const router = new BunRouter();
    router.setLogger(custom);

    expect(isLogger(router.logger)).toBe(true);
    router.logger.info("hello", { requestId: "abc" });
    expect(lines).toHaveLength(1);
    expect(String(lines[0][0])).toContain("hello");
    expect(lines[0][1]).toEqual({ requestId: "abc" });
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

  it("disables the cache entirely for routeCacheMax: 0", () => {
    // 0 turns the cache off, so every call re-matches from scratch and
    // returns a fresh (but equal) array rather than the cached reference.
    const router = new BunRouter({ routeCacheMax: 0 });
    router.get("/z", () => {});

    const z1 = layersFor(router, "GET", "/z");
    const z2 = layersFor(router, "GET", "/z");
    expect(z2).not.toBe(z1);
    expect(z2).toEqual(z1);
    // Still routes correctly with the cache off.
    expect(z2).toHaveLength(1);
  });

  it("keeps nothing cached while disabled", async () => {
    const router = new BunRouter({ routeCacheMax: 0 });
    router.get("/nocache", (_req, res) => res.send("ok"));

    layersFor(router, "GET", "/nocache");
    layersFor(router, "GET", "/nocache");

    // clearRouteCache stays a no-op — there is nothing to clear.
    expect(router.clearRouteCache()).toBe(router);

    const request = await makeRequest({ url: "http://localhost/nocache" });
    const response = new BunResponse(request);
    await router.handle({
      requestHost: request.host,
      requestMethod: "GET",
      requestUrl: "/nocache",
      request,
      response,
    });
    expect(await response.getNativeResponse().then((r) => r.text())).toBe("ok");
  });

  it("falls back to the default cap for a negative routeCacheMax", () => {
    // Negative is invalid (not a request to disable) — the 2000 default
    // applies, so a re-requested signature is served from cache.
    const router = new BunRouter({ routeCacheMax: -5 });
    router.get("/neg", () => {});

    const n1 = layersFor(router, "GET", "/neg");
    const n2 = layersFor(router, "GET", "/neg");
    expect(n2).toBe(n1);
  });
});

describe("BunRouter: direct route matching (no routejs LRU)", () => {
  it("extracts required, optional and catch-all params identically", async () => {
    const router = new BunRouter();
    const seen: Record<string, unknown>[] = [];
    router.get("/user/:id", (req, res) => {
      seen.push({ ...req.params });
      res.send("ok");
    });
    router.get("/search/:category/:page?", (req, res) => {
      seen.push({ ...req.params });
      res.send("ok");
    });
    router.get("/assets/*", (req, res) => {
      seen.push({ ...req.params });
      res.send("ok");
    });

    async function hit(path: string) {
      const request = await makeRequest({ url: `http://localhost${path}` });
      const response = new BunResponse(request);
      await router.handle({
        requestHost: request.host,
        requestMethod: "GET",
        requestUrl: path,
        request,
        response,
      });
    }

    await hit("/user/42");
    await hit("/search/books");
    await hit("/search/books/2");
    await hit("/assets/css/site/app.css");

    expect(seen[0]).toEqual({ id: "42" });
    expect(seen[1]).toEqual({ category: "books" });
    expect(seen[2]).toEqual({ category: "books", page: "2" });
    expect(seen[3]).toEqual({ 0: "css/site/app.css" });
  });

  it("percent-decodes param values", async () => {
    const router = new BunRouter();
    let captured: string | undefined;
    router.get("/user/:name", (req, res) => {
      captured = req.params.name as string;
      res.send("ok");
    });

    const path = "/user/ada%20lovelace";
    const request = await makeRequest({ url: `http://localhost${path}` });
    const response = new BunResponse(request);
    await router.handle({
      requestHost: request.host,
      requestMethod: "GET",
      requestUrl: path,
      request,
      response,
    });

    expect(captured).toBe("ada lovelace");
  });

  it("rejects a non-matching method and a non-matching path", () => {
    const router = new BunRouter();
    router.post("/only-post", () => {});

    expect(layersFor(router, "GET", "/only-post")).toHaveLength(0);
    expect(layersFor(router, "POST", "/only-post")).toHaveLength(1);
    expect(layersFor(router, "POST", "/nope")).toHaveLength(0);
  });

  it("stays correct across more distinct paths than any internal cache holds", () => {
    // Exercises the path that used to thrash routejs's 250-entry per-route
    // LRU: every one of these must still match and carry the right param.
    const router = new BunRouter({ routeCacheMax: 16 });
    router.get("/item/:id", () => {});

    for (let i = 0; i < 600; i++) {
      const layers = layersFor(router, "GET", `/item/${i}`);
      expect(layers).toHaveLength(1);
      expect((layers[0].matched.params as Record<string, string>).id).toBe(
        String(i),
      );
    }
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
    routerA.use(((_err, _req, _res, _next) => {
      // A's error handler must not run — the router was exited.
      order.push("A-error");
    }) satisfies RouterErrorMiddlewareHandler);

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

describe("BunRouter: verb/all/use accept 4-arg error handlers", () => {
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

  it("a verb method (get) accepts an error handler alongside a thrower", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    const thrower: RouterHandler = () => {
      order.push("thrown");
      throw new Error("boom");
    };
    const errHandler: RouterErrorMiddlewareHandler = (
      err,
      _req,
      res,
      _next,
    ) => {
      order.push(`caught:${(err as Error).message}`);
      res.json({ order });
    };

    router.get("/x", thrower, errHandler);

    const { response } = await exec(router, "GET", "/x");
    const native = await response.getNativeResponse(1000);
    expect(order).toEqual(["thrown", "caught:boom"]);
    expect(await native.json()).toEqual({ order: ["thrown", "caught:boom"] });
  });

  it("router.use accepts a 4-arg error handler", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    router.get("/x", () => {
      order.push("h");
      throw new Error("from-route");
    });
    router.use(((err, _req, res, _next) => {
      order.push(`use-err:${(err as Error).message}`);
      res.json({ order });
    }) satisfies RouterErrorMiddlewareHandler);

    const { response } = await exec(router, "GET", "/x");
    await response.getNativeResponse(1000);
    expect(order).toEqual(["h", "use-err:from-route"]);
  });

  it("router.all accepts a 4-arg error handler", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    router.get("/x", () => {
      throw new Error("blast");
    });
    router.all("/x", ((err, _req, res, _next) => {
      order.push(`all-err:${(err as Error).message}`);
      res.json({ order });
    }) satisfies RouterErrorMiddlewareHandler);

    const { response } = await exec(router, "GET", "/x");
    await response.getNativeResponse(1000);
    expect(order).toEqual(["all-err:blast"]);
  });

  it("router.useMethod accepts a 4-arg error handler", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    router.get("/x", () => {
      throw new Error("scoped");
    });
    router.useMethod("GET", ((err, _req, res, _next) => {
      order.push(`um-err:${(err as Error).message}`);
      res.json({ order });
    }) satisfies RouterErrorMiddlewareHandler);

    const { response } = await exec(router, "GET", "/x");
    await response.getNativeResponse(1000);
    expect(order).toEqual(["um-err:scoped"]);
  });
});

describe("BunRouter: Express 5 catch-all path normalisation", () => {
  it("use('*splat', mw) matches every path", () => {
    const router = new BunRouter();
    router.use("*splat", () => {});
    expect(layersFor(router, "GET", "/anywhere").length).toBeGreaterThan(0);
    expect(layersFor(router, "GET", "/").length).toBeGreaterThan(0);
  });

  it("use('{*splat}', mw) matches every path", () => {
    const router = new BunRouter();
    router.use("{*splat}", () => {});
    expect(layersFor(router, "GET", "/anywhere").length).toBeGreaterThan(0);
  });

  it("use('/*splat', mw) matches every absolute path", () => {
    const router = new BunRouter();
    router.use("/*splat", () => {});
    expect(layersFor(router, "GET", "/anywhere").length).toBeGreaterThan(0);
  });

  it("use('/api/{*rest}', mw) matches under the prefix but not other roots", () => {
    const router = new BunRouter();
    router.use("/api/{*rest}", () => {});
    expect(layersFor(router, "GET", "/api/foo").length).toBeGreaterThan(0);
    expect(layersFor(router, "GET", "/api/v1/users").length).toBeGreaterThan(0);
    expect(layersFor(router, "GET", "/other")).toHaveLength(0);
  });

  it("normalises catch-all in verb methods too (get('*splat', h))", () => {
    const router = new BunRouter();
    router.get("*splat", () => {});
    expect(layersFor(router, "GET", "/anywhere").length).toBeGreaterThan(0);
  });

  it("leaves a normal path with params unchanged", () => {
    const router = new BunRouter();
    router.use("/users/:id", () => {});
    expect(layersFor(router, "GET", "/users/123").length).toBeGreaterThan(0);
  });

  it("leaves a bare star unchanged", () => {
    const router = new BunRouter();
    router.use("*", () => {});
    expect(layersFor(router, "GET", "/anywhere").length).toBeGreaterThan(0);
  });
});

describe("BunRouter: accepts a typed RouterErrorMiddlewareHandler", () => {
  // `RouterErrorMiddlewareHandler`-typed handlers compile cleanly on every
  // callback-accepting method (the err/req/res/next types come from the
  // explicit annotation; TS cannot dispatch overloads by an untyped arrow's
  // arity, so prefer `satisfies RouterErrorMiddlewareHandler` for inline
  // error handlers).

  it("accepts an annotated error handler on a verb method", () => {
    const router = new BunRouter();
    router.get("/x", ((err, _req, _res, _next) => {
      void err;
    }) satisfies RouterErrorMiddlewareHandler);
    expect(router.routes().length).toBe(1);
  });

  it("accepts an annotated error handler on use()", () => {
    const router = new BunRouter();
    router.use(((err, _req, _res, _next) => {
      void err;
    }) satisfies RouterErrorMiddlewareHandler);
    expect(router.routes().length).toBe(1);
  });

  it("accepts an annotated error handler on all()", () => {
    const router = new BunRouter();
    router.all("/x", ((err, _req, _res, _next) => {
      void err;
    }) satisfies RouterErrorMiddlewareHandler);
    expect(router.routes().length).toBe(1);
  });

  it("accepts an annotated error handler on useMethod()", () => {
    const router = new BunRouter();
    router.useMethod("GET", ((err, _req, _res, _next) => {
      void err;
    }) satisfies RouterErrorMiddlewareHandler);
    expect(router.routes().length).toBe(1);
  });
});

describe("BunRouter: Express 5 named wildcards", () => {
  /** Params captured by `path` when `url` is matched. */
  function paramsFor(path: string, url: string): Record<string, string> {
    const router = new BunRouter();
    router.get(path, () => {});
    const layers = layersFor(router, "GET", url);
    expect(layers).toHaveLength(1);
    return layers[0].matched.params as Record<string, string>;
  }

  it("exposes *name as req.params.name, keeping the positional key", () => {
    expect(paramsFor("/assets/*splat", "/assets/css/site/app.css")).toEqual({
      "0": "css/site/app.css",
      splat: "css/site/app.css",
    });
  });

  it("supports the braced {*name} form", () => {
    expect(paramsFor("/assets/{*splat}", "/assets/a/b.css")).toEqual({
      "0": "a/b.css",
      splat: "a/b.css",
    });
  });

  it("leaves a bare * positional only", () => {
    expect(paramsFor("/assets/*", "/assets/a/b.css")).toEqual({
      "0": "a/b.css",
    });
  });

  it("maps several named wildcards positionally", () => {
    expect(paramsFor("/f/*a/g/*b", "/f/one/g/two")).toEqual({
      "0": "one",
      "1": "two",
      a: "one",
      b: "two",
    });
  });

  it("names a wildcard alongside a regexp-constrained param", () => {
    expect(paramsFor("/n/:id(\\d+)/*rest", "/n/42/x/y")).toEqual({
      "0": "x/y",
      id: "42",
      rest: "x/y",
    });
  });

  it("withholds names when a bare regexp group shares the counter", () => {
    // routejs numbers bare groups and wildcards from one counter, so the nth
    // numeric key is not reliably the nth wildcard — binding a name here could
    // attach it to the wrong capture, so only positional keys are published.
    const params = paramsFor("/n/(\\d+)/*rest", "/n/42/x/y");
    expect(params).toEqual({ "0": "42", "1": "x/y" });
    expect(params).not.toHaveProperty("rest");
  });
});

describe("BunRouter: params are bound per route, not per callback", () => {
  it("lets a middleware replace params for later callbacks of the same route", async () => {
    const router = new BunRouter();
    const seen: unknown[] = [];
    router.get(
      "/u/:id",
      (req, _res, next) => {
        // Replace wholesale — the bound object comes from the pipeline cache
        // and is shared by every request with this signature.
        req.params = { ...req.params, id: String(Number(req.params.id) * 2) };
        next();
      },
      (req, res) => {
        seen.push({ ...req.params });
        res.send("ok");
      },
    );

    const request = await makeRequest({ url: "http://localhost/u/21" });
    const response = new BunResponse(request);
    await router.handle({
      requestHost: request.host,
      requestMethod: "GET",
      requestUrl: "/u/21",
      request,
      response,
    });

    expect(seen).toEqual([{ id: "42" }]);
  });

  it("rebinds params when the pipeline moves to a different route", async () => {
    const router = new BunRouter();
    const seen: unknown[] = [];
    router.get("/u/:id", (req, _res, next) => {
      req.params = { id: "clobbered" };
      next();
    });
    router.get("/u/:other", (req, res) => {
      seen.push({ ...req.params });
      res.send("ok");
    });

    const request = await makeRequest({ url: "http://localhost/u/7" });
    const response = new BunResponse(request);
    await router.handle({
      requestHost: request.host,
      requestMethod: "GET",
      requestUrl: "/u/7",
      request,
      response,
    });

    // The second route's own params win — the first route's edit does not leak.
    expect(seen).toEqual([{ other: "7" }]);
  });

  it("does not leak a replacement into a later request on the same path", async () => {
    const router = new BunRouter();
    const seen: string[] = [];
    router.get(
      "/p/:id",
      (req, _res, next) => {
        req.params = { ...req.params, id: "replaced" };
        next();
      },
      (req, res) => {
        seen.push(req.params.id as string);
        res.send("ok");
      },
    );

    for (const url of ["/p/1", "/p/1"]) {
      const request = await makeRequest({ url: `http://localhost${url}` });
      const response = new BunResponse(request);
      await router.handle({
        requestHost: request.host,
        requestMethod: "GET",
        requestUrl: url,
        request,
        response,
      });
    }

    expect(seen).toEqual(["replaced", "replaced"]);
  });
});

describe("BunRouter: caseSensitive and host options", () => {
  it("caseSensitive: true refuses a differently-cased path", async () => {
    const router = new BunRouter({ caseSensitive: true });
    router.get("/Users", (_req, res) => res.send("hit"));

    expect((await router.fetch("/users")).status).toBe(404);
    expect((await router.fetch("/Users")).status).toBe(200);
  });

  it("matching ignores case by default, like Express", async () => {
    const router = new BunRouter();
    router.get("/Users", (_req, res) => res.send("hit"));

    expect((await router.fetch("/users")).status).toBe(200);
  });

  it("caseSensitive covers use() prefixes and mounted routes", async () => {
    const router = new BunRouter({ caseSensitive: true });
    const child = new BunRouter();
    child.get("/Info", (_req, res) => res.send("child"));
    router.use("/Api", child);

    expect((await router.fetch("/api/info")).status).toBe(404);
    expect(await (await router.fetch("/Api/Info")).text()).toBe("child");
  });

  it("a use() prefix ignores case by default, like Express", async () => {
    const router = new BunRouter();
    router.use("/Api", (_req, res) => res.send("prefix"));

    expect(await (await router.fetch("/api/info")).text()).toBe("prefix");
  });

  it("the prefix regex carries the i flag only when case-insensitive", () => {
    const flags = (options?: { caseSensitive?: boolean }) => {
      const router = new BunRouter(options);
      router.use("/Api", () => {});
      return router.routes()[0]?.pathRegexp.flags;
    };

    expect(flags()).toContain("i");
    expect(flags({ caseSensitive: false })).toContain("i");
    expect(flags({ caseSensitive: true })).not.toContain("i");
  });

  it("host scopes the router's routes to that host", async () => {
    const router = new BunRouter({ host: "api.example.test" });
    router.get("/where", (req, res) => res.send(req.hostname));

    // A literal host is also the origin a bare path resolves against.
    expect(await (await router.fetch("/where")).text()).toBe(
      "api.example.test",
    );
    const elsewhere = await router.fetch(
      new Request("http://other.example.test/where"),
    );
    expect(elsewhere.status).toBe(404);
  });

  it("a host pattern scopes routes, and is not used as the origin", async () => {
    const router = new BunRouter({ host: ":tenant.example.test" });
    router.get("/who", (req, res) => res.json(req.params));

    expect((await router.fetch("/who")).status).toBe(404);
    const matched = await router.fetch(
      new Request("http://acme.example.test/who"),
    );
    expect(await matched.json()).toEqual({ tenant: "acme" });
  });
});

describe("BunRouter: group() and domain() call forms", () => {
  it("group(path, ...callbacks) registers prefix middleware", async () => {
    const router = new BunRouter();
    // A lone inline middleware arrow needs `satisfies`: TypeScript tries the
    // `(router) => …` overload first and cannot then type its parameters.
    router.group("/v3", ((_req, res) => {
      res.send("v3 middleware");
    }) satisfies RouterHandler);

    expect(await (await router.fetch("/v3/deep/path")).text()).toBe(
      "v3 middleware",
    );
    expect((await router.fetch("/v4")).status).toBe(404);
  });

  it("group(path, ...callbacks) runs several callbacks in order", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    router.group(
      "/chain",
      (_req, _res, next) => {
        order.push("first");
        next();
      },
      (_req, res) => {
        order.push("second");
        res.send("done");
      },
    );

    expect(await (await router.fetch("/chain/x")).text()).toBe("done");
    expect(order).toEqual(["first", "second"]);
  });

  it("group(path, callback) routes bind their params", async () => {
    const router = new BunRouter();
    router.group("/v2", (child) => {
      child.get("/items/:id", (req, res) => res.send(`id=${req.params.id}`));
    });

    expect(await (await router.fetch("/v2/items/5")).text()).toBe("id=5");
  });

  it("routes from a plain @routejs/router Router bind their params", async () => {
    const router = new BunRouter();
    const plain = new Router();
    plain.use((_req: BunRequest, _res: BunResponse, next: () => void) => {
      next();
    });
    plain.get("/items/:id", (req: BunRequest, res: BunResponse) => {
      res.send(`id=${req.params.id}`);
    });
    router.group("/plain", plain);

    expect(await (await router.fetch("/plain/items/9")).text()).toBe("id=9");
    const layers = layersFor(router, "GET", "/plain/items/9");
    expect(layers.map((layer) => layer.isRouteHandler)).toEqual([false, true]);
  });

  it("domain(host, ...callbacks) registers host-scoped middleware", async () => {
    const router = new BunRouter();
    router.domain("mw.example.test", ((_req, res) => {
      res.send("host middleware");
    }) satisfies RouterHandler);

    const onHost = await router.fetch(
      new Request("http://mw.example.test/any/path"),
    );
    expect(await onHost.text()).toBe("host middleware");
    expect((await router.fetch("/any/path")).status).toBe(404);
  });

  it("domain(pattern, callback) puts host captures in req.params", async () => {
    const router = new BunRouter();
    let subdomains: unknown;
    router.domain(":tenant.example.test", (child) => {
      child.get("/users/:id", (req, res) => {
        subdomains = req.subdomains;
        res.json(req.params);
      });
    });

    const response = await router.fetch(
      new Request("http://acme.example.test/users/7"),
    );
    expect(await response.json()).toEqual({ tenant: "acme", id: "7" });
    // `req.subdomains` stays the request's own list, never the captures.
    expect(Array.isArray(subdomains)).toBe(true);
  });

  // The host-param types rest on these two precedence rules; see the domain()
  // assertions in router-adapter.type-test.ts.
  it("a domain() nested in another keeps the outer host, and group() inherits it", async () => {
    const router = new BunRouter();
    router.domain(":tenant.example.test", (outer) => {
      outer.domain(":region.inner.test", (inner) => {
        inner.get("/n", (req, res) => res.json(req.params));
      });
      outer.group("/g/:id", (group) => {
        group.get("/x", (req, res) => res.json(req.params));
      });
    });

    const onOuter = await router.fetch(
      new Request("http://acme.example.test/n"),
    );
    expect(await onOuter.json()).toEqual({ tenant: "acme" });
    expect(
      (await router.fetch(new Request("http://eu.inner.test/n"))).status,
    ).toBe(404);
    const grouped = await router.fetch(
      new Request("http://acme.example.test/g/5/x"),
    );
    expect(await grouped.json()).toEqual({ tenant: "acme", id: "5" });
  });

  it("domain() overrides the router's host option", async () => {
    const router = new BunRouter({ host: ":opt.example.test" });
    router.domain(":dom.other.test", (child) => {
      child.get("/d", (req, res) => res.json(req.params));
    });

    const onDomain = await router.fetch(new Request("http://x.other.test/d"));
    expect(await onDomain.json()).toEqual({ dom: "x" });
    expect(
      (await router.fetch(new Request("http://x.example.test/d"))).status,
    ).toBe(404);
  });

  it("host captures in every form the host pattern supports", async () => {
    const router = new BunRouter();
    router.domain(":tenant-:region.example.test", (child) => {
      child.get("/two", (req, res) => res.json(req.params));
    });
    router.domain("api.:v(\\d+)?.versions.test", (child) => {
      child.get("/v", (req, res) => res.json(req.params));
    });
    router.domain("*.wild.test", (child) => {
      child.get("/w", (req, res) => res.json(req.params));
    });

    const two = await router.fetch(
      new Request("http://acme-eu.example.test/two"),
    );
    expect(await two.json()).toEqual({ tenant: "acme", region: "eu" });
    const versioned = await router.fetch(
      new Request("http://api.2.versions.test/v"),
    );
    expect(await versioned.json()).toEqual({ v: "2" });
    const unversioned = await router.fetch(
      new Request("http://api.versions.test/v"),
    );
    expect(await unversioned.json()).toEqual({});
    const wild = await router.fetch(new Request("http://a.b.wild.test/w"));
    expect(await wild.json()).toEqual({ 0: "a.b" });
  });
});

describe("BunRouter: setName", () => {
  it("names the route the previous verb call registered", () => {
    const router = new BunRouter();
    router.get("/profile", () => {}).setName("profile");

    expect(router.getRouteByName("profile")?.path).toBe("/profile");
  });

  it("names routes registered by all() and any()", () => {
    const router = new BunRouter();
    router.all("/everything", () => {}).setName("everything");
    router.any(["GET", "POST"], "/some", () => {}).setName("some");

    expect(router.getRouteByName("everything")?.path).toBe("/everything");
    expect(router.getRouteByName("some")?.path).toBe("/some");
  });

  it("throws after middleware, as @routejs/router does", () => {
    const router = new BunRouter();
    router.get("/a", () => {});
    router.use(() => {});

    expect(() => router.setName("mw")).toThrow(
      "setName can not set name for middleware",
    );
    expect(() => new BunRouter().setName("nothing")).toThrow(TypeError);
  });

  it("throws after a mount, rather than renaming a flattened route", () => {
    const router = new BunRouter();
    const child = new BunRouter();
    child.get("/x", () => {});
    router.group("/g", child);

    expect(() => router.setName("x")).toThrow(TypeError);
  });

  it("refuses a name another route already has", () => {
    const router = new BunRouter();
    router.get("/a", () => {}).setName("taken");
    router.get("/b", () => {});

    expect(() => router.setName("taken")).toThrow("already exists");
  });
});

describe("BunRouter: undecodable params (Express 5)", () => {
  it("passes a 400 URIError to the error handlers instead of rejecting", async () => {
    const router = new BunRouter();
    const seen: string[] = [];
    router.use((_req, _res, next) => {
      seen.push("middleware before");
      next();
    });
    router.get("/static/*file", (_req, res) => {
      seen.push("handler");
      res.send("served");
    });
    router.use(((error, _req, res, _next) => {
      const failure = error as URIError & { status: number };
      res.status(failure.status).json({
        name: failure.name,
        message: failure.message,
      });
    }) satisfies RouterErrorMiddlewareHandler);

    const response = await router.fetch("/static/%E0%A4%A");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      name: "URIError",
      message: "Failed to decode param '%E0%A4%A'",
    });
    expect(seen).toEqual(["middleware before"]);
  });

  it("re-throws it when no error handler claims it", async () => {
    const router = new BunRouter();
    router.get("/users/:id", (_req, res) => res.send("unreachable"));

    let caught: unknown;
    try {
      await router.fetch("/users/%zz");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(URIError);
    expect((caught as { status?: number }).status).toBe(400);
  });

  it("leaves routes whose params decode untouched, and raises a fresh error each time", async () => {
    const router = new BunRouter();
    router.get("/users/:id", (req, res) => res.send(req.params.id));
    const errors: unknown[] = [];
    router.use(((error, _req, res, _next) => {
      errors.push(error);
      res.status(400).send("bad");
    }) satisfies RouterErrorMiddlewareHandler);

    expect(await (await router.fetch("/users/a%20b")).text()).toBe("a b");
    await router.fetch("/users/%zz");
    await router.fetch("/users/%zz");
    expect(errors).toHaveLength(2);
    expect(errors[0]).not.toBe(errors[1]);
  });
});

describe("BunRouter: req.route and req.subdomains", () => {
  it("sets req.route to the matched route on entering a route handler", async () => {
    const router = new BunRouter();
    let inMiddleware: unknown = "unset";
    let inHandler: { path?: string; method?: string } | undefined;
    router.use((req, _res, next) => {
      inMiddleware = req.route;
      next();
    });
    router.get("/users/:id", (req, res) => {
      inHandler = req.route ?? undefined;
      res.send("ok");
    });

    await router.fetch("/users/42");
    expect(inMiddleware).toBeUndefined();
    expect(inHandler?.path).toBe("/users/:id");
    expect(inHandler?.method).toBe("GET");
  });

  it("leaves req.subdomains a string[] after routing", async () => {
    const router = new BunRouter();
    let subdomains: unknown;
    router.get("/users/:id", (req, res) => {
      subdomains = req.subdomains;
      res.send("ok");
    });

    await router.fetch("http://api.example.com/users/42");
    expect(subdomains).toEqual(["api"]);
  });
});

describe("BunRouter: ws()", () => {
  const handler = { message: () => undefined };

  it("throws when no BunWebSocket is attached", () => {
    const router = new BunRouter();
    expect(() => router.ws("/chat", handler)).toThrow(
      "no BunWebSocket is attached",
    );
  });

  it("registers the upgrade route before returning", () => {
    const socketRoutes = new BunRouter();
    const socket = new BunWebSocket({
      newInstance: false,
      router: socketRoutes,
      getServer: () => undefined,
    });
    const router = new BunRouter({ bunWebsocket: socket });

    expect(router.ws("/chat", handler)).toBe(router);
    expect(socketRoutes.routes().map((route) => route.path)).toEqual(["/chat"]);
  });

  it("refuses a handler that is not an object", () => {
    const socket = new BunWebSocket({
      newInstance: false,
      router: new BunRouter(),
      getServer: () => undefined,
    });
    const router = new BunRouter({ bunWebsocket: socket });

    expect(() => router.ws("/chat", null as never)).toThrow(TypeError);
  });
});
