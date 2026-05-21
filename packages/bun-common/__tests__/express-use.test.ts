import type { NextFunction } from "../lib/types/general";
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
    const router = new BunRouter();
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
