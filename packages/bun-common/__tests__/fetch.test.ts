import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";

/**
 * `fetch()` runs a request through the router with no socket bound. These
 * tests cover the input forms, and — more importantly — assert that the
 * socket-free path produces the same result as a real request over a port,
 * since a test helper that diverges from production is worse than none.
 */

/**
 * `setErrorHandler` handlers run as Express error middleware: only `next`
 * moves the chain, and a return value means nothing.
 */
describe("BunHttpAdapter: setErrorHandler() chain, as Express error middleware", () => {
  /** An adapter whose `/boom` route throws `Error("first")`. */
  function throwing() {
    const adapter = new BunHttpAdapter(0);
    adapter.get("/boom", () => {
      throw new Error("first");
    });
    return adapter;
  }

  it("next(err) hands the new error to the next handler, whatever the handler returns", async () => {
    const adapter = throwing();
    adapter.setErrorHandler(((_error, _req, res, next) => {
      next(new Error("second"));
      return res;
    }) satisfies RouterErrorMiddlewareHandler);
    adapter.setErrorHandler(((error, _req, res, _next) => {
      res.status(502).json({ seen: (error as Error).message });
    }) satisfies RouterErrorMiddlewareHandler);

    const response = await adapter.fetch("/boom");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ seen: "second" });
  });

  it("a handler that responds and returns a value ends the chain", async () => {
    const adapter = throwing();
    let laterRan = false;
    adapter.setErrorHandler(((_error, _req, res, _next) => {
      res.status(503).send("handled");
      return res;
    }) satisfies RouterErrorMiddlewareHandler);
    adapter.setErrorHandler(((_error, _req, res, _next) => {
      laterRan = true;
      res.status(500).send("overwritten");
    }) satisfies RouterErrorMiddlewareHandler);

    const response = await adapter.fetch("/boom");
    expect(await response.text()).toBe("handled");
    expect(response.status).toBe(503);
    expect(laterRan).toBe(false);
  });

  it("next(err) past the last handler is answered as finalhandler, for that error", async () => {
    const adapter = throwing();
    adapter.setErrorHandler(((_error, _req, _res, next) => {
      next(Object.assign(new Error("teapot"), { status: 418 }));
    }) satisfies RouterErrorMiddlewareHandler);

    const response = await adapter.fetch("/boom");
    expect(response.status).toBe(418);
    expect(await response.text()).toContain("<pre>I&#39;m a Teapot</pre>");
  });

  it("next() leaves error mode: nothing follows, so 404", async () => {
    const adapter = throwing();
    let laterRan = false;
    adapter.setErrorHandler(((_error, _req, _res, next) => {
      next();
    }) satisfies RouterErrorMiddlewareHandler);
    adapter.setErrorHandler(((_error, _req, res, _next) => {
      laterRan = true;
      res.status(500).send("error handler");
    }) satisfies RouterErrorMiddlewareHandler);

    const response = await adapter.fetch("/boom");
    expect(response.status).toBe(404);
    expect(laterRan).toBe(false);
  });

  it("next(err) called from a callback after the handler returned still moves on", async () => {
    const adapter = throwing();
    adapter.setErrorHandler(((error, _req, _res, next) => {
      setTimeout(next, 5, error);
    }) satisfies RouterErrorMiddlewareHandler);
    adapter.setErrorHandler(((error, _req, res, _next) => {
      res.status(503).json({ late: (error as Error).message });
    }) satisfies RouterErrorMiddlewareHandler);

    const response = await adapter.fetch("/boom");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ late: "first" });
  });
});

describe("BunRouter.fetch: input forms", () => {
  it("treats a bare path as a GET", async () => {
    const router = new BunRouter();
    router.get("/ping", (req, res) => res.json({ method: req.method }));

    const response = await router.fetch("/ping");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ method: "GET" });
  });

  it("extracts route params from the path", async () => {
    const router = new BunRouter();
    router.get("/user/:id", (req, res) => res.json({ id: req.params.id }));

    expect(await (await router.fetch("/user/42")).json()).toEqual({ id: "42" });
  });

  it("parses the query string", async () => {
    const router = new BunRouter();
    router.get("/search", (req, res) => res.json({ query: req.query }));

    expect(await (await router.fetch("/search?q=bun&page=2")).json()).toEqual({
      query: { q: "bun", page: "2" },
    });
  });

  it("accepts a RequestInit carrying a url", async () => {
    const router = new BunRouter();
    router.post("/posts", (req, res) => {
      res.json({ method: req.method, body: req.body });
    });

    const response = await router.fetch({
      url: "/posts",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "hello" }),
    });

    expect(await response.json()).toEqual({
      method: "POST",
      body: { title: "hello" },
    });
  });

  it("accepts a Request object as-is", async () => {
    const router = new BunRouter();
    router.get("/thing", (req, res) => res.json({ url: req.path }));

    const response = await router.fetch(
      new Request("http://example.test/thing", {
        headers: { "X-Token": "abc" },
      }),
    );
    expect(await response.json()).toEqual({ url: "/thing" });
  });

  it("accepts a URL", async () => {
    const router = new BunRouter();
    router.get("/u", (_req, res) => res.send("ok"));

    const response = await router.fetch(new URL("http://localhost/u"));
    expect(await response.text()).toBe("ok");
  });

  it("applies a RequestInit passed alongside a path", async () => {
    const router = new BunRouter();
    router.put("/p", (req, res) => res.json({ method: req.method }));

    const response = await router.fetch("/p", { method: "PUT" });
    expect(await response.json()).toEqual({ method: "PUT" });
  });

  it("passes headers through", async () => {
    const router = new BunRouter();
    router.get("/h", (req, res) => {
      res.json({ token: req.getHeader("x-token") });
    });

    const response = await router.fetch("/h", {
      headers: { "X-Token": "secret" },
    });
    expect(await response.json()).toEqual({ token: "secret" });
  });
});

describe("BunRouter.fetch: pipeline behaviour", () => {
  it("404s when nothing matches", async () => {
    const router = new BunRouter();
    router.get("/known", (_req, res) => res.send("ok"));

    expect((await router.fetch("/unknown")).status).toBe(404);
  });

  it("runs middleware in registration order", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    router.use((_req, _res, next) => {
      order.push("first");
      next();
    });
    router.use((_req, _res, next) => {
      order.push("second");
      next();
    });
    router.get("/x", (_req, res) => {
      order.push("handler");
      res.send("ok");
    });

    await router.fetch("/x");
    expect(order).toEqual(["first", "second", "handler"]);
  });

  it("routes an error to a 4-arg error handler", async () => {
    const router = new BunRouter();
    router.get("/boom", () => {
      throw new Error("kaboom");
    });
    router.use(((error, _req, res, _next) => {
      res.status(500).json({ message: (error as Error).message });
    }) satisfies RouterErrorMiddlewareHandler);

    const response = await router.fetch("/boom");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "kaboom" });
  });

  it("honours next('route')", async () => {
    const router = new BunRouter();
    router.get(
      "/skip",
      (_req, _res, next) => next("route"),
      (_req, res) => res.send("not reached"),
    );
    router.get("/skip", (_req, res) => res.send("second route"));

    expect(await (await router.fetch("/skip")).text()).toBe("second route");
  });
});

describe("BunHttpAdapter.fetch: matches a real socket request", () => {
  /** Registers the same app on an adapter. */
  function build(adapter: BunHttpAdapter): void {
    adapter.get("/user/:id", (req, res) => {
      res.status(201).json({ id: req.params.id, q: req.query });
    });
    adapter.setNotFoundHandler((_req, res) => {
      res.status(404).json({ error: "nope" });
    });
  }

  it("produces the same status, headers and body as a served request", async () => {
    const served = new BunHttpAdapter(0);
    build(served);
    await served.listen(0);

    const offline = new BunHttpAdapter(0);
    build(offline);

    try {
      for (const target of ["/user/42?a=1", "/missing"]) {
        const overSocket = await fetch(
          `http://127.0.0.1:${served.listeningPort}${target}`,
        );
        const offlineResponse = await offline.fetch(target);

        expect(offlineResponse.status).toBe(overSocket.status);
        expect(offlineResponse.headers.get("content-type")).toBe(
          overSocket.headers.get("content-type"),
        );
        expect(await offlineResponse.text()).toBe(await overSocket.text());
      }
    } finally {
      await served.close();
    }
  });

  it("runs the adapter's not-found handler", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.setNotFoundHandler((_req, res) => {
      res.status(404).json({ handled: true });
    });

    const response = await adapter.fetch("/nothing");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ handled: true });
  });

  it("needs no port, so repeated calls cannot collide", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.get("/n", (_req, res) => res.send("ok"));

    const results = await Promise.all(
      Array.from({ length: 20 }, () => adapter.fetch("/n")),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(adapter.isListening).toBe(false);
  });
});

describe("BunHttpAdapter.fetch: setErrorHandler", () => {
  function build(adapter: BunHttpAdapter) {
    adapter.get("/boom", () => {
      throw new Error("exploded");
    });
    adapter.setErrorHandler((error, req, res) => {
      res.status(502).json({ error: (error as Error).message, path: req.path });
    });
  }

  it("runs the error handlers, exactly as a served request does", async () => {
    const served = new BunHttpAdapter(0);
    build(served);
    await served.listen(0);

    const offline = new BunHttpAdapter(0);
    build(offline);

    try {
      const overSocket = await fetch(
        `http://127.0.0.1:${served.listeningPort}/boom`,
      );
      const offlineResponse = await offline.fetch("/boom");

      expect(offlineResponse.status).toBe(502);
      expect(offlineResponse.status).toBe(overSocket.status);
      expect(await offlineResponse.json()).toEqual(await overSocket.json());
    } finally {
      await served.close();
    }
  });

  it("answers for the error a throwing error handler raised", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.get("/boom", () => {
      throw new Error("exploded");
    });
    adapter.setErrorHandler(() => {
      throw Object.assign(new Error("handler failed"), { status: 503 });
    });

    const response = await adapter.fetch("/boom");
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("<pre>Service Unavailable</pre>");
  });
});

describe("BunHttpAdapter.fetch: no error handler (finalhandler fallback)", () => {
  /** Routes whose errors nothing handles. */
  function build(adapter: BunHttpAdapter) {
    adapter.useBodyParser("json", false, { limit: 10 });
    adapter.all("/boom", () => {
      throw new Error("secret detail");
    });
    adapter.get("/teapot", () => {
      throw Object.assign(new Error("short and stout"), {
        status: 418,
        headers: { "X-Brew": "refused" },
      });
    });
    adapter.get("/status-code", () => {
      throw Object.assign(new Error("gone"), { statusCode: 410 });
    });
    adapter.get("/not-an-error-status", () => {
      throw Object.assign(new Error("odd"), { status: 302 });
    });
    adapter.get("/primitive", () => {
      // eslint-disable-next-line no-throw-literal
      throw "a bare string";
    });
    adapter.post("/json", (_req, res) => res.send("parsed"));
    adapter.get("/hang", () => undefined);
  }

  const cases: { target: string; init?: RequestInit; status: number }[] = [
    { target: "/boom", status: 500 },
    { target: "/boom", init: { method: "HEAD" }, status: 500 },
    { target: "/teapot", status: 418 },
    { target: "/status-code", status: 410 },
    { target: "/not-an-error-status", status: 500 },
    { target: "/primitive", status: 500 },
    {
      target: "/json",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "x".repeat(100) }),
      },
      status: 413,
    },
    // A timeout carries no request, so it takes the fallback too.
    { target: "/hang", status: 500 },
  ];

  it("resolves the same response a served request gets", async () => {
    const served = new BunHttpAdapter(100);
    build(served);
    await served.listen(0);

    const offline = new BunHttpAdapter(100);
    build(offline);

    try {
      for (const { target, init, status } of cases) {
        const overSocket = await fetch(
          `http://127.0.0.1:${served.listeningPort}${target}`,
          init,
        );
        const offlineResponse = await offline.fetch(target, init);

        expect([target, offlineResponse.status]).toEqual([target, status]);
        expect(offlineResponse.status).toBe(overSocket.status);
        for (const header of [
          "content-type",
          "content-security-policy",
          "x-content-type-options",
          "x-brew",
        ]) {
          expect(offlineResponse.headers.get(header)).toBe(
            overSocket.headers.get(header),
          );
        }
        expect(await offlineResponse.text()).toBe(await overSocket.text());
      }
    } finally {
      await served.close();
    }
  });

  it("sends the status message as an HTML page, never the error's detail", async () => {
    const adapter = new BunHttpAdapter(100);
    build(adapter);

    const response = await adapter.fetch("/boom");
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await response.text();
    expect(body).toContain("<pre>Internal Server Error</pre>");
    expect(body).not.toContain("secret detail");
    expect(body).not.toContain("at ");

    const tooLarge = await adapter.fetch("/json", cases[6]?.init);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.text()).toContain("<pre>Payload Too Large</pre>");

    const teapot = await adapter.fetch("/teapot");
    expect(teapot.headers.get("x-brew")).toBe("refused");

    const head = await adapter.fetch("/boom", { method: "HEAD" });
    expect(head.status).toBe(500);
    expect(await head.text()).toBe("");
  });
});
