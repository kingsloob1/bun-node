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
