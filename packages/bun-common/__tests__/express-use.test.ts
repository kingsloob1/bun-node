import type {
  NextFunction,
  RouterErrorMiddlewareHandler,
  RouterHandler,
} from "../lib/types/general";
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunResponse } from "../lib/BunResponse";
import { BunRouter } from "../lib/BunRouter";
import { makeRequest } from "./helpers";

/** Drives a router through one request and returns the result + response. */
async function run(router: BunRouter, method: string, path: string) {
  const request = await makeRequest({
    url: `http://localhost${path}`,
    method,
  });
  const response = new BunResponse(request);
  const result = await router.handle({
    requestHost: request.host,
    requestMethod: request.method,
    requestUrl: request.originalUrl,
    request,
    response,
  });
  return { result, response };
}

describe("Express 5 use: middleware ordering", () => {
  it("runs middleware in registration order before the handler", async () => {
    const router = new BunRouter();
    const order: string[] = [];

    router.use((_req, _res, next) => {
      order.push("mw1");
      next();
    });
    router.use((_req, _res, next) => {
      order.push("mw2");
      next();
    });
    router.get("/x", async (_req, res) => {
      order.push("handler");
      return res.json({ ok: true });
    });

    await run(router, "GET", "/x");
    expect(order).toEqual(["mw1", "mw2", "handler"]);
  });

  it("a middleware that responds short-circuits the pipeline", async () => {
    const router = new BunRouter();
    const order: string[] = [];

    router.use(async (_req, res) => {
      order.push("mw");
      return res.json({ from: "middleware" });
    });
    router.get("/x", (_req, _res) => {
      order.push("handler");
    });

    const { response } = await run(router, "GET", "/x");
    expect(order).toEqual(["mw"]);
    const native = await response.getNativeResponse(1000);
    expect(await native.json()).toEqual({ from: "middleware" });
  });
});

describe("Express 5 use: error-handler detection", () => {
  it("treats a 4-argument callback as an error handler and skips it when no error", async () => {
    const router = new BunRouter();
    const order: string[] = [];

    router.use(
      (_err: unknown, _req: unknown, _res: unknown, next: NextFunction) => {
        order.push("errorHandler");
        (next as NextFunction)();
      },
    );
    router.get("/x", async (_req, res) => {
      order.push("handler");
      return res.json({ ok: true });
    });

    await run(router, "GET", "/x");
    expect(order).toEqual(["handler"]);
  });

  it("routes a thrown error to the error handler, skipping later middleware", async () => {
    const router = new BunRouter();
    const order: string[] = [];

    router.use((_req, _res, _next) => {
      order.push("mw1");
      throw new Error("boom");
    });
    router.use((_req, _res, next) => {
      order.push("mw2-regular");
      next();
    });
    router.use(
      (err: unknown, _req: unknown, res: BunResponse, _next: NextFunction) => {
        order.push(`errorHandler:${(err as Error).message}`);
        return res.status(500).json({ error: (err as Error).message });
      },
    );
    router.get("/x", async (_req, res) => {
      order.push("handler");
      return res.json({ ok: true });
    });

    const { response } = await run(router, "GET", "/x");
    expect(order).toEqual(["mw1", "errorHandler:boom"]);
    const native = await response.getNativeResponse(1000);
    expect(native.status).toBe(500);
    expect(await native.json()).toEqual({ error: "boom" });
  });

  it("forwards a rejected async middleware promise to the error handler", async () => {
    const router = new BunRouter();
    let caught: unknown;

    router.use(async () => {
      throw new Error("async failure");
    });
    router.use(
      (err: unknown, _req: unknown, res: BunResponse, _next: NextFunction) => {
        caught = err;
        return res.status(500).json({ ok: false });
      },
    );

    await run(router, "GET", "/x");
    expect((caught as Error).message).toBe("async failure");
  });

  it("routes next(err) to the error handler", async () => {
    const router = new BunRouter();
    let caught: unknown;

    router.use((_req, _res, next) => {
      next(new Error("explicit"));
    });
    router.use(
      (err: unknown, _req: unknown, res: BunResponse, _next: NextFunction) => {
        caught = err;
        return res.status(500).json({ ok: false });
      },
    );

    await run(router, "GET", "/x");
    expect((caught as Error).message).toBe("explicit");
  });
});

describe("Express 5 use: error recovery & propagation", () => {
  it("an error handler calling next() clears the error and resumes middleware", async () => {
    const router = new BunRouter();
    const order: string[] = [];

    router.use((_req, _res, _next) => {
      order.push("mw1");
      throw new Error("boom");
    });
    router.use((_req, _res, next) => {
      order.push("mw2-before-recovery");
      next();
    });
    router.use(
      (_err: unknown, _req: unknown, _res: unknown, next: NextFunction) => {
        order.push("errorHandler-recovers");
        next();
      },
    );
    router.get("/x", async (_req, res) => {
      order.push("handler");
      return res.json({ ok: true });
    });

    const { response } = await run(router, "GET", "/x");
    // mw2 (regular) is skipped while the error is active; the handler runs
    // once the error handler clears the error.
    expect(order).toEqual(["mw1", "errorHandler-recovers", "handler"]);
    expect(response.headersSent).toBe(true);
  });

  it("an error handler calling next(err) propagates to the next error handler", async () => {
    const router = new BunRouter();
    const seen: string[] = [];

    router.use((_req, _res, _next) => {
      throw new Error("first");
    });
    router.use(
      (err: unknown, _req: unknown, _res: unknown, next: NextFunction) => {
        seen.push(`handler1:${(err as Error).message}`);
        next(new Error("second"));
      },
    );
    router.use(
      (err: unknown, _req: unknown, res: BunResponse, _next: NextFunction) => {
        seen.push(`handler2:${(err as Error).message}`);
        return res.status(500).json({ ok: false });
      },
    );

    await run(router, "GET", "/x");
    expect(seen).toEqual(["handler1:first", "handler2:second"]);
  });

  it("re-throws an unhandled error for the adapter's final handler", async () => {
    const router = new BunRouter();
    router.get("/x", async () => {
      throw new Error("unhandled");
    });

    await expect(run(router, "GET", "/x")).rejects.toThrow("unhandled");
  });
});

describe("Express 5 use: next('route') and next('router')", () => {
  it("next('route') skips the remaining callbacks of the current route", async () => {
    const router = new BunRouter();
    const order: string[] = [];

    router.get(
      "/x",
      (_req, _res, next) => {
        order.push("routeA-cb1");
        next("route");
      },
      (_req, _res, next) => {
        order.push("routeA-cb2");
        next();
      },
    );
    router.get("/x", async (_req, res) => {
      order.push("routeB");
      return res.json({ ok: true });
    });

    await run(router, "GET", "/x");
    expect(order).toEqual(["routeA-cb1", "routeB"]);
  });

  it("next('router') abandons the rest of the pipeline", async () => {
    const router = new BunRouter();
    const order: string[] = [];

    router.use((_req, _res, next) => {
      order.push("mw");
      next("router");
    });
    router.get("/x", (_req, _res) => {
      order.push("handler");
    });

    const { result } = await run(router, "GET", "/x");
    expect(order).toEqual(["mw"]);
    expect(result).toBeUndefined();
  });
});

describe("BunRouter: route specificity", () => {
  it("prefers a static route over a param route regardless of registration order", async () => {
    // Specificity ordering is opt-in (default is registration order).
    const router = new BunRouter({ routeSpecificity: true });
    const hit: string[] = [];

    // Param route registered FIRST; the static route is still more specific.
    router.get("/users/:id", async (_req, res) => {
      hit.push("param");
      return res.json({});
    });
    router.get("/users/me", async (_req, res) => {
      hit.push("static");
      return res.json({});
    });

    await run(router, "GET", "/users/me");
    expect(hit).toEqual(["static"]);
  });

  it("falls through to the param route for non-static paths", async () => {
    const router = new BunRouter();
    const hit: string[] = [];

    router.get("/users/:id", async (req, res) => {
      hit.push(`param:${req.params.id}`);
      return res.json({});
    });
    router.get("/users/me", async (_req, res) => {
      hit.push("static");
      return res.json({});
    });

    await run(router, "GET", "/users/123");
    expect(hit).toEqual(["param:123"]);
  });

  it("supports the WebDAV proppatch verb", async () => {
    const router = new BunRouter();
    let ran = false;
    router.proppatch("/resource", async (_req, res) => {
      ran = true;
      return res.json({ ok: true });
    });

    await run(router, "PROPPATCH", "/resource");
    expect(ran).toBe(true);
  });
});

describe("Express 5 use: path-prefix matching", () => {
  it("use(path, mw) matches by prefix, not exact path", async () => {
    const router = new BunRouter();
    const hits: string[] = [];

    router.use("/api", (_req, _res, next) => {
      hits.push("api-mw");
      next();
    });
    router.get("/api/users", async (_req, res) => res.json({ ok: true }));
    router.get("/other", async (_req, res) => res.json({ ok: true }));

    await run(router, "GET", "/api/users");
    expect(hits).toEqual(["api-mw"]);

    hits.length = 0;
    await run(router, "GET", "/other");
    expect(hits).toEqual([]);
  });
});

/**
 * Express 5's `Router({ caseSensitive })` compiles `use()` prefixes and routes
 * with the same path-to-regexp `sensitive` flag, so the setting covers both.
 * routejs rebuilds a prefix regex from its exact regex's `source`, which drops
 * the `i` flag — these tests pin that it is restored.
 */
describe("Express 5 use: prefix matching honours caseSensitive", () => {
  /** A router whose `/Admin` prefix middleware answers with `req.baseUrl`. */
  function adminRouter(options?: { caseSensitive?: boolean }): BunRouter {
    const router = new BunRouter(options);
    router.use("/Admin", (req, res) => res.send(`mw ${req.baseUrl}`));
    return router;
  }

  it("ignores case by default, with baseUrl in the request's spelling", async () => {
    const response = await adminRouter().fetch("/admin/x");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("mw /admin");
  });

  it("ignores case with caseSensitive: false", async () => {
    const router = adminRouter({ caseSensitive: false });
    expect(await (await router.fetch("/ADMIN/x")).text()).toBe("mw /ADMIN");
    expect(await (await router.fetch("/Admin")).text()).toBe("mw /Admin");
    // Still a segment-boundary prefix, whatever the case.
    expect((await router.fetch("/administrators")).status).toBe(404);
  });

  it("refuses a differently-cased prefix with caseSensitive: true", async () => {
    const router = adminRouter({ caseSensitive: true });
    expect((await router.fetch("/admin/x")).status).toBe(404);
    expect(await (await router.fetch("/Admin/x")).text()).toBe("mw /Admin");
  });

  it("a mounted sub-router's middleware and baseUrl ignore case", async () => {
    const seen: string[] = [];
    const sub = new BunRouter();
    sub.use((req, _res, next) => {
      seen.push(`mw ${req.baseUrl}`);
      next();
    });
    sub.get("/Posts", (req, res) => res.send(`route ${req.baseUrl}`));
    const app = new BunRouter();
    app.use("/Users/:id", sub);

    const response = await app.fetch("/users/7/posts");
    expect(await response.text()).toBe("route /users/7");
    expect(seen).toEqual(["mw /users/7"]);
  });

  it("a mounted sub-router follows the mounting router's caseSensitive: true", async () => {
    const sub = new BunRouter();
    sub.use((_req, res) => res.send("mw"));
    const app = new BunRouter({ caseSensitive: true });
    app.use("/Users", sub);

    expect((await app.fetch("/users/x")).status).toBe(404);
    expect(await (await app.fetch("/Users/x")).text()).toBe("mw");
  });

  it("group() and useMethod() prefixes ignore case too", async () => {
    const router = new BunRouter();
    router.group("/Grp", ((_req, res) => {
      res.send("group");
    }) satisfies RouterHandler);
    router.useMethod("POST", "/Forms", (_req, res) => res.send("forms"));
    router.group("/Cb/:id", (child) => {
      child.get("/Item", (req, res) => res.send(`cb ${req.baseUrl}`));
    });

    expect(await (await router.fetch("/grp/x")).text()).toBe("group");
    expect(
      await (await router.fetch("/forms/x", { method: "POST" })).text(),
    ).toBe("forms");
    expect(await (await router.fetch("/cb/1/item")).text()).toBe("cb /cb/1");
  });

  it("requests differing only in case never share a cache entry", async () => {
    const router = adminRouter({ caseSensitive: true });
    // Warm the cache with the matching spelling first, then the other.
    expect((await router.fetch("/Admin/x")).status).toBe(200);
    expect((await router.fetch("/admin/x")).status).toBe(404);
    expect((await router.fetch("/Admin/x")).status).toBe(200);

    const insensitive = adminRouter();
    expect(await (await insensitive.fetch("/ADMIN/x")).text()).toBe(
      "mw /ADMIN",
    );
    // Same route, other spelling: its own entry, its own baseUrl.
    expect(await (await insensitive.fetch("/admin/x")).text()).toBe(
      "mw /admin",
    );
  });
});

describe("Express 5 use: BunHttpAdapter integration over HTTP", () => {
  it("an error handler registered via use() catches a thrown route error", async () => {
    const adapter = new BunHttpAdapter(5000);
    adapter.get("/boom", async () => {
      throw new Error("route exploded");
    });
    adapter.use(
      (err: unknown, _req: unknown, res: BunResponse, _next: NextFunction) => {
        return res.status(500).json({
          handledBy: "use-error-handler",
          message: (err as Error).message,
        });
      },
    );
    await adapter.listen(0);

    try {
      const response = await fetch(
        `http://${adapter.listeningHost}:${adapter.listeningPort}/boom`,
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        handledBy: "use-error-handler",
        message: "route exploded",
      });
    } finally {
      await adapter.close();
    }
  });

  it("a regular use() middleware runs before the route handler over HTTP", async () => {
    const adapter = new BunHttpAdapter(5000);
    adapter.use((req, _res, next) => {
      (req as unknown as Record<string, unknown>).touchedByMiddleware = true;
      next();
    });
    adapter.get("/check", async (req, res) => {
      const touched =
        (req as unknown as Record<string, unknown>).touchedByMiddleware ===
        true;
      return res.json({ touched });
    });
    await adapter.listen(0);

    try {
      const response = await fetch(
        `http://${adapter.listeningHost}:${adapter.listeningPort}/check`,
      );
      expect(await response.json()).toEqual({ touched: true });
    } finally {
      await adapter.close();
    }
  });
});

describe("Express 5: req.baseUrl", () => {
  it('is the matched mount inside it, and "" again outside', async () => {
    const seen: Record<string, string> = {};

    const users = new BunRouter();
    users.use((req, _res, next) => {
      seen.subMiddleware = req.baseUrl;
      next();
    });
    users.get("/posts", (req, _res, next) => {
      seen.subRoute = req.baseUrl;
      next();
    });

    const app = new BunRouter();
    app.use((req, _res, next) => {
      seen.appMiddleware = req.baseUrl;
      next();
    });
    app.use("/api", (req, _res, next) => {
      seen.prefixMiddleware = req.baseUrl;
      next();
    });
    app.use("/api/users/:id", users);
    app.get("/api/users/:id/posts", (req, res) => {
      seen.appRoute = req.baseUrl;
      res.send("ok");
    });

    const response = await app.fetch("/api/users/42/posts");
    expect(response.status).toBe(200);
    expect(seen).toEqual({
      appMiddleware: "",
      prefixMiddleware: "/api",
      subMiddleware: "/api/users/42",
      subRoute: "/api/users/42",
      appRoute: "",
    });
  });

  it('joins nested mounts, and is "" for a router mounted at /', async () => {
    const inner = new BunRouter();
    inner.get("/x", (req, res) => res.send(req.baseUrl));
    const outer = new BunRouter();
    outer.use("/b", inner);
    const app = new BunRouter();
    app.use("/a", outer);

    const atRoot = new BunRouter();
    atRoot.get("/y", (req, res) => res.send(`[${req.baseUrl}]`));
    app.use("/", atRoot);

    expect(await (await app.fetch("/a/b/x")).text()).toBe("/a/b");
    expect(await (await app.fetch("/y")).text()).toBe("[]");
  });

  it("keeps the request's own spelling, not the pattern's", async () => {
    const sub = new BunRouter();
    sub.get("/", (req, res) => res.send(req.baseUrl));
    const app = new BunRouter();
    app.use("/files/:name", sub);

    expect(await (await app.fetch("/files/a%20b/")).text()).toBe(
      "/files/a%20b",
    );
  });
});

describe("Express 5: req.next", () => {
  it("is the current layer's next()", async () => {
    const router = new BunRouter();
    router.get("/n", (req, res, next) => {
      res.json({
        same: req.next === next,
      });
    });

    expect(await (await router.fetch("/n")).json()).toEqual({ same: true });
  });

  it("lets res.format() hand its 406 to the error handlers", async () => {
    const router = new BunRouter();
    router.get("/doc", (_req, res) => {
      res.format({ json: (_r, formatted) => formatted.json({ ok: true }) });
    });
    router.use(((error, _req, res, _next) => {
      const { status, message } = error as Error & { status: number };
      res.status(status).json({ caught: message });
    }) satisfies RouterErrorMiddlewareHandler);

    const response = await router.fetch("/doc", {
      headers: { Accept: "image/png" },
    });
    expect(response.status).toBe(406);
    expect(await response.json()).toEqual({ caught: "Not Acceptable" });
  });

  it("reaches the adapter's fallback when nothing handles the 406", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.get("/doc", (_req, res) => {
      res.format({ json: (_r, formatted) => formatted.json({ ok: true }) });
    });

    const response = await adapter.fetch("/doc", {
      headers: { Accept: "image/png" },
    });
    expect(response.status).toBe(406);
    expect(await response.text()).toContain("<pre>Not Acceptable</pre>");
  });
});
