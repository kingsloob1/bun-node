import type { BunRequest } from "../lib/BunRequest";
import type { BunResponse } from "../lib/BunResponse";
import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter, toNativeRequest } from "../lib/BunRouter";

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

/**
 * A DOM shim (happy-dom, jsdom) replaces `globalThis.Request`, so a native
 * Bun `Request` built before it — or captured from Bun — is no longer an
 * `instanceof` the global. `fetch()` must still take it as a request, not as
 * an init object, or its method and body are silently dropped.
 */
describe("fetch: a Request from before a DOM shim replaced globalThis.Request", () => {
  /**
   * A stand-in for a shim's `Request`. It builds working requests (as
   * happy-dom's does), so the only thing that changes is that a native
   * `Request` is no longer an `instanceof` the global — which, before the
   * fix, turned a native `POST` into a bodiless `GET`.
   */
  class ShimRequest extends Request {}

  /** Runs `body` with `globalThis.Request` swapped for {@link ShimRequest}. */
  async function withShimmedRequest<T>(body: () => Promise<T>): Promise<T> {
    const native = globalThis.Request;
    globalThis.Request = ShimRequest;
    try {
      return await body();
    } finally {
      globalThis.Request = native;
    }
  }

  /** A native `POST` with a JSON body, built while `Request` is Bun's own. */
  function nativePost(): Request {
    return new Request("http://localhost/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "hello" }),
    });
  }

  it("BunRouter.fetch keeps its method and body", async () => {
    const router = new BunRouter();
    router.post("/echo", (req, res) => {
      res.json({ method: req.method, body: req.body });
    });

    const request = nativePost();
    const response = await withShimmedRequest(() => router.fetch(request));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      method: "POST",
      body: { title: "hello" },
    });
  });

  it("BunHttpAdapter.fetch keeps its method and body", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.post("/echo", (req, res) => {
      res.json({ method: req.method, body: req.body });
    });

    const request = nativePost();
    const response = await withShimmedRequest(() => adapter.fetch(request));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      method: "POST",
      body: { title: "hello" },
    });
  });

  it("still takes a plain { url, method, body } as the init form", async () => {
    const router = new BunRouter();
    router.post("/echo", (req, res) => {
      res.json({ method: req.method, body: req.body });
    });

    const response = await router.fetch({
      url: "/echo",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "init" }),
    });
    expect(await response.json()).toEqual({
      method: "POST",
      body: { title: "init" },
    });
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

  it("answers a QUERY with a body as a served request does", async () => {
    /** A QUERY route echoing its params, query string and body. */
    function buildQuery(adapter: BunHttpAdapter): void {
      adapter.query("/search/:index", (req, res) => {
        res.json({
          method: req.method,
          params: req.params,
          query: req.query,
          body: req.body,
        });
      });
    }

    const served = new BunHttpAdapter(0);
    buildQuery(served);
    await served.listen(0);

    const offline = new BunHttpAdapter(0);
    buildQuery(offline);

    const init = {
      method: "QUERY",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ term: "bun" }),
    };
    try {
      const overSocket = await fetch(
        `http://127.0.0.1:${served.listeningPort}/search/books?page=2`,
        init,
      );
      const offlineResponse = await offline.fetch("/search/books?page=2", init);

      expect(overSocket.status).toBe(200);
      expect(offlineResponse.status).toBe(overSocket.status);
      expect(offlineResponse.headers.get("content-type")).toBe(
        overSocket.headers.get("content-type"),
      );
      const body = await overSocket.text();
      expect(await offlineResponse.text()).toBe(body);
      expect(JSON.parse(body)).toEqual({
        method: "QUERY",
        params: { index: "books" },
        query: { page: "2" },
        body: { term: "bun" },
      });
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

/**
 * A client never sends a URL's fragment: `fetch("http://h/p/a#1/v")` puts
 * `GET /p/a` on the wire. `new Request(url).url` keeps the fragment (as the
 * Fetch spec says it must), so `fetch()` has to drop it itself, or a route
 * matches here that 404s over a socket.
 */
describe("fetch: drops the URL fragment, as an HTTP client does", () => {
  /** Echoes what the pipeline saw, minus the host (which differs). */
  function build(router: BunRouter): void {
    for (const path of ["/p/:id", "/p/:id/v"]) {
      router.get(path, (req, res) => {
        const native = new URL(req.request.url);
        res.json({
          route: path,
          id: req.params.id,
          url: req.url,
          originalUrl: req.originalUrl,
          path: req.path,
          hash: req.hash,
          query: req.query,
          nativeUrl: native.pathname + native.search + native.hash,
        });
      });
    }
  }

  /** The three forms a target can take, all of which must drop the fragment. */
  const forms = {
    "a string": (target: string) => target,
    "a { url } object": (target: string) => ({ url: target }),
    "a Request": (target: string) => new Request(`http://localhost${target}`),
  } as const;

  const targets = {
    "a fragment after a param": "/p/a@1#1/v",
    "a fragment after a query": "/p/x?q=1#frag",
    "%23 in a param": "/p/a%231",
    "%23 in a param and the query, then a fragment": "/p/a%231?q=%23#x/v",
    "an empty fragment": "/p/a#",
  };

  it("answers exactly what a served request gets, in every input form", async () => {
    const served = new BunHttpAdapter(0);
    build(served);
    await served.listen(0);

    const offline = new BunHttpAdapter(0);
    build(offline);

    try {
      for (const [label, target] of Object.entries(targets)) {
        const overSocket = await fetch(
          `http://127.0.0.1:${served.listeningPort}${target}`,
        );
        const expected = {
          label,
          status: overSocket.status,
          body: await overSocket.text(),
        };

        for (const [form, make] of Object.entries(forms)) {
          const response = await offline.fetch(make(target));
          expect({
            form,
            label,
            status: response.status,
            body: await response.text(),
          }).toEqual({ form, ...expected });
        }
      }
    } finally {
      await served.close();
    }
  });

  it("matches the path before the fragment, keeps the query and decodes %23", async () => {
    const router = new BunRouter();
    build(router);

    for (const [form, make] of Object.entries(forms)) {
      const afterParam = await router.fetch(
        make(targets["a fragment after a param"]),
      );
      expect({ form, body: await afterParam.json() }).toMatchObject({
        form,
        body: { route: "/p/:id", id: "a@1", url: "/p/a@1", hash: "" },
      });

      const afterQuery = await router.fetch(
        make(targets["a fragment after a query"]),
      );
      expect({ form, body: await afterQuery.json() }).toMatchObject({
        form,
        body: {
          route: "/p/:id",
          id: "x",
          url: "/p/x?q=1",
          query: { q: "1" },
          hash: "",
        },
      });

      const encoded = await router.fetch(make(targets["%23 in a param"]));
      expect({ form, body: await encoded.json() }).toMatchObject({
        form,
        body: { route: "/p/:id", id: "a#1", url: "/p/a%231", path: "/p/a%231" },
      });
    }
  });

  /**
   * A `Request` with a fragment is the one input `fetch()` rebuilds, so its
   * method, headers and body must survive the rebuild — a stream included.
   */
  it("a Request with a body and a fragment keeps its method, headers and body", async () => {
    const router = new BunRouter();
    router.post("/echo", (req, res) => {
      res.json({
        path: req.path,
        url: req.url,
        contentType: req.getHeader("content-type"),
        body: req.body,
      });
    });

    const cases = {
      text: {
        init: { body: "hello", headers: { "Content-Type": "text/plain" } },
        contentType: "text/plain",
        body: "hello",
      },
      json: {
        init: {
          body: JSON.stringify({ a: 1 }),
          headers: { "Content-Type": "application/json" },
        },
        contentType: "application/json",
        body: { a: 1 },
      },
      stream: {
        init: {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("stream"));
              controller.enqueue(new TextEncoder().encode("ed"));
              controller.close();
            },
          }),
          headers: { "Content-Type": "text/plain" },
          duplex: "half",
        },
        contentType: "text/plain",
        body: "streamed",
      },
    } satisfies Record<
      string,
      { init: RequestInit; contentType: string; body: unknown }
    >;

    for (const [label, { init, contentType, body }] of Object.entries(cases)) {
      const response = await router.fetch(
        new Request("http://localhost/echo#frag", { method: "POST", ...init }),
      );
      expect({
        label,
        status: response.status,
        body: await response.json(),
      }).toEqual({
        label,
        status: 200,
        body: { path: "/echo", url: "/echo", contentType, body },
      });
    }
  });

  /**
   * A request-like that is not this realm's `Request` (happy-dom's, in the
   * UI's DOM tests) cannot be rebuilt: Bun's constructor rejects its foreign
   * `signal`. It passes through as before, fragment and all, and the router
   * still matches on the path alone.
   */
  it("passes a foreign request-like with a fragment through, without throwing", async () => {
    const router = new BunRouter();
    build(router);

    const foreign = {
      url: "http://localhost/p/a#1/v",
      method: "GET",
      headers: new Headers(),
      signal: {},
      bodyUsed: false,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Request;

    expect(toNativeRequest(foreign)).toBe(foreign);
    const response = await router.fetch(foreign);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ route: "/p/:id", id: "a" });
  });

  /**
   * A used `Request` is never rebuilt: Bun would rebuild it with a silently
   * empty body (oven-sh/bun#44307) where the Fetch spec throws. So with or
   * without a fragment it passes through as-is, and a used body reads as no
   * body (`BunRequest` treats `bodyUsed` so); the router matches on the path
   * before the fragment. `bodyUsed` in the echo shows it was not rebuilt.
   */
  it("passes a used Request through as-is, with or without a fragment", async () => {
    /** Registers `POST /p/:id` and `POST /p/:id/v`, echoing what they saw. */
    function register(target: BunRouter): void {
      for (const path of ["/p/:id", "/p/:id/v"]) {
        target.post(path, (req, res) => {
          res.json({
            route: path,
            id: req.params.id,
            body: req.body ?? null,
            bodyUsed: req.request.bodyUsed,
          });
        });
      }
    }
    const router = new BunRouter();
    register(router);
    const adapter = new BunHttpAdapter(0);
    register(adapter);

    for (const [name, target] of [
      ["BunRouter", router],
      ["BunHttpAdapter", adapter],
    ] as const) {
      for (const url of ["http://localhost/p/a#1/v", "http://localhost/p/a"]) {
        const used = new Request(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "hello",
        });
        await used.text();

        expect(toNativeRequest(used)).toBe(used);
        const response = await target.fetch(used);
        expect({
          name,
          url,
          status: response.status,
          body: await response.json(),
        }).toEqual({
          name,
          url,
          status: 200,
          body: { route: "/p/:id", id: "a", body: null, bodyUsed: true },
        });
      }
    }
  });

  it("the router matches on the path alone when a url carries a fragment", () => {
    const router = new BunRouter();
    build(router);

    for (const requestUrl of ["/p/a#1/v", "/p/a#x?y/v", "/p/a?q#1/v"]) {
      const layers = router.getMatchedLayers({
        requestHost: "localhost",
        requestMethod: "GET",
        requestUrl,
      });
      expect({
        requestUrl,
        params: layers.map((layer) => layer.matched.params),
      }).toEqual({ requestUrl, params: [{ id: "a" }] });
    }
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
      // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error
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

/**
 * A client frames every body it sends: `Content-Length` when it knows the
 * size, `Transfer-Encoding: chunked` when it does not, and `Content-Length:
 * 0` for no body on any method but `GET`/`HEAD`. `new Request()` adds
 * neither, and `type-is` (`req.is()`, body-parser's "has a body") reads
 * them, so `fetch()` frames the body it builds the way Bun's own client
 * does. Each kind is sent served, as the reference, and through
 * `adapter.fetch()` and `router.fetch()`; all three must agree.
 */
describe("fetch: frames a request body as a client does on the wire", () => {
  /** What a handler saw of the request's framing and body. */
  interface Framing {
    /** `req.get("content-length")`, `null` without one. */
    length: string | null;
    /** `req.get("transfer-encoding")`, `null` without one. */
    transfer: string | null;
    /** `req.is()` for each of {@link IS_TYPES}, in order. */
    is: (string | false | null)[];
    /** `req.hasBody`. */
    hasBody: boolean;
    /** `req.body` as parsed, `null` when unset. */
    body: unknown;
  }

  /** The `req.is()` queries every case answers. */
  const IS_TYPES = ["multipart", "json", "urlencoded", "text/*"] as const;

  /** One body kind: how to make a fresh copy, and its method. */
  interface Kind {
    /** The case's name. */
    name: string;
    /** The request method. */
    method: string;
    /** A fresh body for one request (a body can be sent only once). */
    body: () => Bun.BodyInit | undefined;
    /** Extra request headers. */
    headers?: Record<string, string>;
    /** What the served handler sees, which the socket-free ones must too. */
    expected: Pick<Framing, "length" | "transfer">;
  }

  /** A `FormData` with one field. */
  const form = (): FormData => {
    const data = new FormData();
    data.append("a", "1");
    return data;
  };
  /** A `ReadableStream` of `"abc"`. */
  const stream = (): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abc"));
        controller.close();
      },
    });

  const KINDS: Kind[] = [
    {
      name: "a string",
      method: "POST",
      body: () => "héllo",
      expected: { length: "6", transfer: null },
    },
    {
      name: "a JSON string",
      method: "POST",
      body: () => '{"n":1}',
      headers: { "content-type": "application/json" },
      expected: { length: "7", transfer: null },
    },
    {
      name: "a Uint8Array",
      method: "POST",
      body: () => new Uint8Array([104, 105]),
      expected: { length: "2", transfer: null },
    },
    {
      name: "a Blob",
      method: "POST",
      body: () => new Blob(["abc"], { type: "text/plain" }),
      expected: { length: "3", transfer: null },
    },
    {
      name: "URLSearchParams",
      method: "POST",
      body: () => new URLSearchParams({ a: "1", b: "x y" }),
      expected: { length: "9", transfer: null },
    },
    {
      name: "a FormData",
      method: "POST",
      body: form,
      // Bun's boundary is a fixed-length random token: 165 bytes every time.
      expected: { length: "165", transfer: null },
    },
    {
      name: "a ReadableStream",
      method: "POST",
      body: stream,
      expected: { length: null, transfer: "chunked" },
    },
    {
      name: "no body, POST",
      method: "POST",
      body: () => undefined,
      expected: { length: "0", transfer: null },
    },
    {
      name: "no body, JSON-typed PUT",
      method: "PUT",
      body: () => undefined,
      headers: { "content-type": "application/json" },
      expected: { length: "0", transfer: null },
    },
    {
      name: "no body, GET",
      method: "GET",
      body: () => undefined,
      expected: { length: null, transfer: null },
    },
  ];

  /** Registers the reporting route on a router or adapter. */
  function build(target: BunRouter | BunHttpAdapter): void {
    target.all("/framing", (req, res) => {
      const framing: Framing = {
        length: req.get("content-length") ?? null,
        transfer: req.get("transfer-encoding") ?? null,
        is: IS_TYPES.map((type) => req.is(type)),
        hasBody: req.hasBody,
        body: req.body ?? null,
      };
      res.json(framing);
    });
  }

  /** The init each request of `kind` is sent with. */
  function initOf(kind: Kind): RequestInit {
    const body = kind.body();
    return {
      method: kind.method,
      ...(kind.headers ? { headers: kind.headers } : {}),
      ...(body === undefined ? {} : { body }),
    };
  }

  it("each body kind is framed, and read, as served", async () => {
    const served = new BunHttpAdapter(0);
    build(served);
    await served.listen(0);
    const offline = new BunHttpAdapter(0);
    build(offline);
    const router = new BunRouter();
    build(router);

    try {
      for (const kind of KINDS) {
        const overSocket = (await (
          await fetch(
            `http://127.0.0.1:${served.listeningPort}/framing`,
            initOf(kind),
          )
        ).json()) as Framing;
        expect({ kind: kind.name, length: overSocket.length }).toEqual({
          kind: kind.name,
          length: kind.expected.length,
        });
        expect({ kind: kind.name, transfer: overSocket.transfer }).toEqual({
          kind: kind.name,
          transfer: kind.expected.transfer,
        });

        for (const [via, answer] of [
          ["adapter.fetch", await offline.fetch("/framing", initOf(kind))],
          ["router.fetch", await router.fetch("/framing", initOf(kind))],
        ] as const) {
          expect({
            kind: kind.name,
            via,
            ...((await answer.json()) as Framing),
          }).toEqual({ kind: kind.name, via, ...overSocket });
        }
      }
    } finally {
      await served.close();
    }
  });

  it("a Request passed as it is keeps its headers, and req.is() still sees its body", async () => {
    const adapter = new BunHttpAdapter(0);
    build(adapter);
    const router = new BunRouter();
    build(router);

    for (const target of [adapter, router]) {
      const request = new Request("http://localhost/framing", {
        method: "POST",
        body: form(),
      });
      const seen = (await (await target.fetch(request)).json()) as Framing;
      // Its size is not known without reading it, so nothing is added...
      expect(seen.length).toBeNull();
      expect(seen.transfer).toBeNull();
      expect(request.headers.has("content-length")).toBe(false);
      // ...but it has a body, and `req.is()` says what it is, as served.
      expect(seen.hasBody).toBe(true);
      expect(seen.is).toEqual(["multipart", false, false, false]);
    }
  });

  it("keeps a framing header the caller set, and leaves the caller's init alone", async () => {
    const router = new BunRouter();
    build(router);

    const headers = { "content-length": "3" };
    const streamed = (await (
      await router.fetch("/framing", {
        method: "POST",
        body: stream(),
        headers,
      })
    ).json()) as Framing;
    expect(streamed.length).toBe("3");
    expect(streamed.transfer).toBeNull();
    expect(headers).toEqual({ "content-length": "3" });

    const chunked = (await (
      await router.fetch("/framing", {
        method: "POST",
        body: "abc",
        headers: { "transfer-encoding": "chunked" },
      })
    ).json()) as Framing;
    expect(chunked.length).toBeNull();
    expect(chunked.transfer).toBe("chunked");

    const data = form();
    const init: RequestInit = { method: "POST", body: data };
    await router.fetch("/framing", init);
    expect(init).toEqual({ method: "POST", body: data });
    expect(init.body).toBe(data);
  });

  it("toNativeRequest gives each body kind the length it is sent with", async () => {
    /** One body, and the framing the request built from it carries. */
    const table: [
      string,
      string,
      () => unknown,
      string | null,
      string | null,
    ][] = [
      ["an empty string", "POST", () => "", "0", null],
      ["a lone surrogate", "POST", () => "a\uD800b", "5", null],
      ["an emoji", "PUT", () => "é😀", "6", null],
      ["a DataView", "POST", () => new DataView(new ArrayBuffer(5)), "5", null],
      ["an ArrayBuffer", "POST", () => new ArrayBuffer(3), "3", null],
      ["a File", "POST", () => new File(["xyz"], "f.txt"), "3", null],
      ["an empty Blob", "POST", () => new Blob([]), "0", null],
      ["an empty FormData", "POST", () => new FormData(), "60", null],
      ["a number", "POST", () => 123, "3", null],
      [
        "an async iterable",
        "POST",
        async function* chunks() {
          yield "ab";
        },
        null,
        "chunked",
      ],
      // Bun's client sends this one's length (it sees the `Blob` behind the
      // stream); without reading it, a stream is a stream.
      [
        "a Response's body",
        "POST",
        () => new Response("abc").body,
        null,
        "chunked",
      ],
      ["no body, HEAD", "HEAD", () => undefined, null, null],
      ["no body, DELETE", "DELETE", () => undefined, "0", null],
      ["no body, OPTIONS", "OPTIONS", () => undefined, "0", null],
      ["no body, PATCH", "PATCH", () => undefined, "0", null],
      ["no body, QUERY", "QUERY", () => undefined, "0", null],
      ["a null body, POST", "POST", () => null, "0", null],
    ];
    for (const [name, method, make, length, transfer] of table) {
      const made = make();
      const body = (
        typeof made === "function" ? (made as () => unknown)() : made
      ) as Bun.BodyInit | null | undefined;
      const request = toNativeRequest("/x", { method, body });
      expect({
        name,
        length: request.headers.get("content-length"),
        transfer: request.headers.get("transfer-encoding"),
      }).toEqual({ name, length, transfer });
      if (length !== null) {
        // The length is the bytes the request carries.
        expect({
          name,
          bytes: (await request.arrayBuffer()).byteLength,
        }).toEqual({ name, bytes: Number(length) });
      }
    }
    // A bare path is a `GET` with nothing to frame.
    expect([...toNativeRequest("/x").headers.keys()]).toEqual([]);
  });

  it("serialises a FormData once, keeping its fields and implied multipart type", async () => {
    const data = form();
    data.append("file", new File(["xyz"], "f.txt", { type: "text/plain" }));
    const request = toNativeRequest("/x", { method: "POST", body: data });
    expect(request.headers.get("content-type")).toStartWith(
      "multipart/form-data; boundary=",
    );
    const length = Number(request.headers.get("content-length"));
    const parsed = await request.clone().formData();
    expect(parsed.get("a")).toBe("1");
    expect(await (parsed.get("file") as File).text()).toBe("xyz");
    expect((await request.arrayBuffer()).byteLength).toBe(length);

    // A Content-Type the caller set wins, as for any FormData body.
    const typed = toNativeRequest("/x", {
      method: "POST",
      body: form(),
      headers: { "content-type": "multipart/form-data; boundary=mine" },
    });
    expect(typed.headers.get("content-type")).toBe(
      "multipart/form-data; boundary=mine",
    );
  });
});

describe("fetch: a bare path starting with // is a path, not a host", () => {
  it("toNativeRequest keeps // paths on the origin, as a served request has them", () => {
    // A raw `GET //x/y` reaches Bun.serve as `http://<host>//x/y`; resolving
    // the string as a URL would read `x` as a host (and throw for `//`).
    expect(toNativeRequest("//").url).toBe("http://localhost//");
    expect(toNativeRequest("//x/y").url).toBe("http://localhost//x/y");
    expect(toNativeRequest("//a/../b").url).toBe("http://localhost//b");
    expect(toNativeRequest("/a?q=1#frag").url).toBe("http://localhost/a?q=1");
    // An absolute URL is still taken as one.
    expect(toNativeRequest("http://example.com//p").url).toBe(
      "http://example.com//p",
    );
  });

  it("routes a // path like a served request", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.use((req, res) => {
      res.send(`path:${req.path}`);
    });
    const res = await adapter.fetch("//x/y");
    expect(await res.text()).toBe("path://x/y");
    expect((await adapter.fetch("//")).status).toBe(200);
  });
});

/**
 * The caller leaving, socket-free as served. A served client leaves by
 * cancelling a body still being produced, or by aborting its own `fetch()`;
 * the handler's `req.signal` then aborts with Bun's `AbortError` ("The
 * connection was closed."), `res`, `req` and `req.socket` emit `close`, and
 * the caller's promise (or the read in progress on its body) rejects with its
 * abort reason. Each case runs served first, as the reference, then through
 * `router.fetch()` and `adapter.fetch()` (a path with a `RequestInit`, and a
 * `Request`), and asserts both the same outcome and what the served one is.
 * Every wait is on an event.
 */
describe("fetch: the caller leaving is a disconnect, as served", () => {
  /** What one request's handler saw of its client; each promise settles on its event. */
  interface Seen {
    /** The handler's `req.signal`. */
    signal: AbortSignal;
    /** The native request's own signal, `req.request.signal`. */
    requestSignal: AbortSignal;
    /** `req.signal`'s `abort` (at once if it was aborted already). */
    aborted: Promise<void>;
    /** `res` `'close'`. */
    resClose: Promise<void>;
    /** `req` `'close'`. */
    reqClose: Promise<void>;
    /** `req.socket` `'close'`. */
    socketClose: Promise<void>;
    /** The names of the `res` `'error'` events so far. */
    resErrors: string[];
    /** The source stream of `/stream` being cancelled. */
    sourceCancelled: Promise<void>;
    /** Settles {@link sourceCancelled}; called by that stream's `cancel`. */
    cancelSource: () => void;
  }

  /** Requests that reached a handler and are not yet taken, oldest first. */
  const arrived: Seen[] = [];
  /** Waiters for the next arrival. */
  const waiting: ((seen: Seen) => void)[] = [];

  /** The next request to reach a handler. */
  function nextArrival(): Promise<Seen> {
    const seen = arrived.shift();
    return seen
      ? Promise.resolve(seen)
      : new Promise((resolve) => waiting.push(resolve));
  }

  /** Records `req`/`res` as {@link Seen}, and announces its arrival. */
  function observe(req: BunRequest, res: BunResponse): Seen {
    const on = (subscribe: (fire: () => void) => void): Promise<void> =>
      new Promise((resolve) => subscribe(() => resolve()));
    const source = Promise.withResolvers<void>();
    const signal = req.signal;
    const seen: Seen = {
      signal,
      requestSignal: req.request.signal,
      aborted: signal.aborted
        ? Promise.resolve()
        : on((fire) => signal.addEventListener("abort", fire, { once: true })),
      resClose: on((fire) => res.once("close", fire)),
      reqClose: on((fire) => req.once("close", fire)),
      socketClose: on((fire) => req.socket.once("close", fire)),
      resErrors: [],
      sourceCancelled: source.promise,
      cancelSource: source.resolve,
    };
    res.on("error", (error) => seen.resErrors.push((error as Error).name));
    const waiter = waiting.shift();
    if (waiter) {
      waiter(seen);
    } else {
      arrived.push(seen);
    }
    return seen;
  }

  /** Releases each `/hold` handler waiting. */
  const holds: (() => void)[] = [];

  /** The app, the same served and socket-free. */
  function build(app: BunRouter): void {
    // A `write()` stream.
    app.get("/write", (req, res) => {
      observe(req, res);
      res.write("a");
    });
    // An SSE-like stream: its headers, a first comment, then silence.
    app.get("/sse", (req, res) => {
      observe(req, res);
      res.setHeader("Content-Type", "text/event-stream");
      res.flushHeaders();
      res.write(": ok\n\n");
    });
    // A stream passed to `send()`.
    app.get("/stream", (req, res) => {
      const seen = observe(req, res);
      res.send(
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new Uint8Array([97])),
          cancel: () => seen.cancelSource(),
        }),
      );
    });
    app.get("/buffered", (req, res) => {
      observe(req, res);
      res.send("hello");
    });
    // Answers only once its client has left.
    app.get("/pending", async (req, res) => {
      const seen = observe(req, res);
      await seen.aborted;
      void res.status(204).end();
    });
    app.get("/ping", (_req, res) => {
      res.send("pong");
    });
    // Waits until the test releases it, reading nothing of its client.
    app.get("/hold", async (_req, res) => {
      const held = Promise.withResolvers<void>();
      holds.push(held.resolve);
      await held.promise;
      void res.status(204).end();
    });
  }

  /** How a case reaches the app. */
  type Client = (path: string, init?: RequestInit) => Promise<Response>;

  /** Each mode, served first: a fresh app per mode, closed by the caller. */
  async function modes(): Promise<{
    clients: [name: string, client: Client][];
    close: () => Promise<void>;
  }> {
    const served = new BunHttpAdapter(0);
    build(served);
    const server = await served.listen(0);
    const router = new BunRouter();
    build(router);
    const offline = new BunHttpAdapter(0);
    build(offline);
    return {
      clients: [
        [
          "served",
          (path, init) => fetch(`http://127.0.0.1:${server.port}${path}`, init),
        ],
        ["router.fetch()", (path, init) => router.fetch(path, init)],
        ["adapter.fetch(path)", (path, init) => offline.fetch(path, init)],
        [
          "adapter.fetch(Request)",
          (path, init) =>
            offline.fetch(new Request(`http://localhost${path}`, init)),
        ],
      ],
      close: () => served.close(),
    };
  }

  /** `reason` as `name: message`, for comparing modes. */
  const describeReason = (reason: unknown): string =>
    `${(reason as Error).name}: ${(reason as Error).message}`;

  /** What a served disconnect aborts the request's signal with, in Bun. */
  const DISCONNECTED = "AbortError: The connection was closed.";

  it("cancelling a streamed body aborts req.signal and closes res, req and req.socket", async () => {
    const { clients, close } = await modes();
    try {
      for (const path of ["/write", "/sse", "/stream"]) {
        const outcomes: Record<string, unknown> = {};
        for (const [name, client] of clients) {
          const arrival = nextArrival();
          const response = await client(path);
          const seen = await arrival;
          const reader = response.body!.getReader();
          await reader.read();
          await reader.cancel();
          await Promise.all([
            seen.aborted,
            seen.resClose,
            seen.reqClose,
            seen.socketClose,
            path === "/stream" ? seen.sourceCancelled : undefined,
          ]);
          outcomes[name] = {
            reason: describeReason(seen.signal.reason),
            resErrors: seen.resErrors,
          };
        }
        const served = outcomes.served;
        expect(served).toEqual({
          reason: DISCONNECTED,
          // Bun cancels the body's source with the same reason, which a
          // `write()` stream reports as a stream error.
          resErrors: path === "/stream" ? [] : ["AbortError"],
        });
        expect(outcomes).toEqual({
          served,
          "router.fetch()": served,
          "adapter.fetch(path)": served,
          "adapter.fetch(Request)": served,
        });
      }
    } finally {
      await close();
    }
  });

  it("cancelling a buffered body leaves req.signal alone, as served", async () => {
    const { clients, close } = await modes();
    try {
      for (const [, client] of clients) {
        const arrival = nextArrival();
        const response = await client("/buffered");
        const seen = await arrival;
        await response.body!.cancel();
        // A request after it has gone the whole way through: a disconnect
        // would have aborted the signal by then (served, at once).
        expect(await (await client("/ping")).text()).toBe("pong");
        expect(seen.signal.aborted).toBe(false);
      }
    } finally {
      await close();
    }
  });

  it("a RequestInit signal aborted before the call rejects with its reason, and nothing is handled", async () => {
    const { clients, close } = await modes();
    try {
      // A `Request`'s own signal is read later: the next case.
      for (const [name, client] of clients) {
        if (name === "adapter.fetch(Request)") {
          continue;
        }
        const reason = new Error("left before asking");
        const handledBefore = arrived.length + waiting.length;
        const rejected = await client("/pending", {
          signal: AbortSignal.abort(reason),
        }).catch((error: unknown) => error);
        expect(rejected).toBe(reason);
        expect(
          await client("/ping", { signal: AbortSignal.abort() }).catch(
            (error: unknown) => (error as Error).name,
          ),
        ).toBe("AbortError");
        // Nothing reached a handler: no arrival was recorded.
        expect(await (await client("/ping")).text()).toBe("pong");
        expect(arrived.length + waiting.length).toBe(handledBefore);
      }
    } finally {
      await close();
    }
  });

  /**
   * A `Request`'s own signal is created by Bun on its first read (~200 ns, a
   * sixth of a socket-free request), so `fetch()` reads it only once the
   * router's pipeline waits on a layer or the handler reads `req.signal`.
   * One aborted before
   * the call is therefore honoured there, not before handling: a handler
   * that waits gets a disconnect and the caller a rejection, while one that
   * answers synchronously is answered. `req.request.signal` stays the
   * caller's own.
   */
  it("a Request's own signal aborted before the call is read once the pipeline waits", async () => {
    const router = new BunRouter();
    build(router);
    const reason = new Error("left before asking");
    const signal = AbortSignal.abort(reason);

    const arrival = nextArrival();
    const pending = router.fetch(
      new Request("http://localhost/pending", { signal }),
    );
    const seen = await arrival;
    expect(await pending.catch((error: unknown) => error)).toBe(reason);
    await seen.aborted;
    expect(describeReason(seen.signal.reason)).toBe(DISCONNECTED);
    expect(seen.requestSignal).toBe(signal);

    // Answered synchronously, the signal is never read.
    const answered = await router.fetch(
      new Request("http://localhost/ping", { signal }),
    );
    expect(await answered.text()).toBe("pong");
  });

  it("an abort while the response is pending rejects with its reason when nothing reads req.signal", async () => {
    const { clients, close } = await modes();
    try {
      const outcomes: Record<string, unknown> = {};
      for (const [name, client] of clients) {
        const controller = new AbortController();
        const reason = new Error("left while held");
        const pending = client("/hold", { signal: controller.signal });
        // Aborted in a later task than the call, as a caller giving up.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        controller.abort(reason);
        outcomes[name] =
          (await pending.catch((error: unknown) => error)) === reason;
        for (const release of holds.splice(0)) {
          release();
        }
      }
      expect(outcomes).toEqual({
        served: true,
        "router.fetch()": true,
        "adapter.fetch(path)": true,
        "adapter.fetch(Request)": true,
      });
    } finally {
      for (const release of holds.splice(0)) {
        release();
      }
      await close();
    }
  });

  it("an abort while the response is pending rejects with its reason, and the handler sees a disconnect", async () => {
    const { clients, close } = await modes();
    try {
      const outcomes: Record<string, unknown> = {};
      for (const [name, client] of clients) {
        const controller = new AbortController();
        const arrival = nextArrival();
        const pending = client("/pending", { signal: controller.signal });
        const seen = await arrival;
        const reason = new Error("left while waiting");
        controller.abort(reason);
        const rejected = await pending.catch((error: unknown) => error);
        await Promise.all([
          seen.aborted,
          seen.resClose,
          seen.reqClose,
          seen.socketClose,
        ]);
        outcomes[name] = {
          rejectedWithReason: rejected === reason,
          handlerSaw: describeReason(seen.signal.reason),
        };
      }
      const served = { rejectedWithReason: true, handlerSaw: DISCONNECTED };
      expect(outcomes).toEqual({
        served,
        "router.fetch()": served,
        "adapter.fetch(path)": served,
        "adapter.fetch(Request)": served,
      });
    } finally {
      await close();
    }
  });

  it("an abort after a stream started errors the read in progress, and the handler sees a disconnect", async () => {
    const { clients, close } = await modes();
    try {
      for (const path of ["/write", "/sse"]) {
        const outcomes: Record<string, unknown> = {};
        for (const [name, client] of clients) {
          const controller = new AbortController();
          const arrival = nextArrival();
          const response = await client(path, { signal: controller.signal });
          const seen = await arrival;
          const reader = response.body!.getReader();
          await reader.read();
          const reading = reader.read();
          const reason = new Error("left mid-stream");
          controller.abort(reason);
          const failed = await reading.catch((error: unknown) => error);
          await Promise.all([
            seen.aborted,
            seen.resClose,
            seen.reqClose,
            seen.socketClose,
          ]);
          outcomes[name] = {
            readRejectedWithReason: failed === reason,
            handlerSaw: describeReason(seen.signal.reason),
          };
        }
        const served = {
          readRejectedWithReason: true,
          handlerSaw: DISCONNECTED,
        };
        expect(outcomes).toEqual({
          served,
          "router.fetch()": served,
          "adapter.fetch(path)": served,
          "adapter.fetch(Request)": served,
        });
      }
    } finally {
      await close();
    }
  });
});
