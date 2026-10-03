import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunResponse } from "../lib/BunResponse";
import { BunRouter } from "../lib/BunRouter";
import { makeRequest } from "./helpers";

/**
 * `dispatch()` is `handle()` without the promise when none is needed, and
 * the adapters' served path uses it so a synchronous request reaches
 * `Bun.serve` as a `Response`.
 */

async function run(router: BunRouter, path = "/a") {
  const request = await makeRequest({ url: `http://localhost${path}` });
  const response = new BunResponse(request);
  const result = router.dispatch({
    requestHost: "localhost",
    requestMethod: "GET",
    requestUrl: path,
    request,
    response,
  });
  return { result, response };
}

describe("BunRouter.dispatch", () => {
  it("returns synchronously when every layer finishes synchronously", async () => {
    const router = new BunRouter();
    router.use((_req, _res, next) => next());
    router.get("/a", (_req, res) => res.send("ok"));
    const { result, response } = await run(router);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toBeTruthy();
    expect(await response.settledResponse?.text()).toBe("ok");
  });

  it("returns undefined synchronously when nothing answers", async () => {
    const router = new BunRouter();
    router.get("/a", (_req, _res, next) => next());
    expect((await run(router)).result).toBeUndefined();
  });

  it("throws synchronously for an unhandled synchronous error", async () => {
    const router = new BunRouter();
    router.get("/a", () => {
      throw new Error("sync");
    });
    await expect(run(router)).rejects.toThrow("sync");
  });

  it("becomes a promise from the first async layer, then runs the rest", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    router.use(async (_req, _res, next) => {
      await Promise.resolve();
      order.push("async");
      next();
    });
    router.use((_req, _res, next) => {
      order.push("sync");
      next();
    });
    router.get("/a", (_req, res) => res.send("done"));
    router.use(((_err, _req, res, _next) => {
      res.status(500).send("error");
    }) satisfies RouterErrorMiddlewareHandler);
    const { result, response } = await run(router);
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBeTruthy();
    expect(order).toEqual(["async", "sync"]);
    expect(await response.settledResponse?.text()).toBe("done");
  });

  it("handle() still always returns a promise", async () => {
    const router = new BunRouter();
    router.get("/a", (_req, res) => res.send("ok"));
    const request = await makeRequest({ url: "http://localhost/a" });
    const handled = router.handle({
      requestHost: "localhost",
      requestMethod: "GET",
      requestUrl: "/a",
      request,
      response: new BunResponse(request),
    });
    expect(handled).toBeInstanceOf(Promise);
    expect(await handled).toBeTruthy();
  });
});

/** Exposes the adapter's served request path to the test. */
class Probe extends BunHttpAdapter {
  serve(request: Request) {
    return this.serveNativeRequest(request, {
      requestIP: () => null,
      upgrade: () => false,
    } as never);
  }
}

describe("BunHttpAdapter: served path", () => {
  it("returns a Response, not a promise, for a bodiless synchronous request", async () => {
    const adapter = new Probe(0);
    adapter.get("/sync", (_req, res) => res.send("sync"));
    const served = adapter.serve(new Request("http://localhost/sync"));
    expect(served).toBeInstanceOf(Response);
    expect(await (served as Response).text()).toBe("sync");
  });

  it("returns a promise when a body has to be read, or a handler is async", async () => {
    const adapter = new Probe(0);
    adapter.post("/body", (req, res) => res.json(req.body));
    adapter.get("/async", async (_req, res) => {
      await Promise.resolve();
      res.send("async");
    });
    const posted = adapter.serve(
      new Request("http://localhost/body", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"n":1}',
      }),
    );
    expect(posted).toBeInstanceOf(Promise);
    expect(await (await posted)!.json()).toEqual({ n: 1 });
    const later = adapter.serve(new Request("http://localhost/async"));
    expect(later).toBeInstanceOf(Promise);
    expect(await (await later)!.text()).toBe("async");
  });

  it("rejects rather than throws when the pipeline throws", async () => {
    const adapter = new Probe(0);
    adapter.get("/boom", () => {
      throw new Error("boom");
    });
    const served = adapter.serve(new Request("http://localhost/boom"));
    expect(served).toBeInstanceOf(Promise);
    await expect(served).rejects.toThrow("boom");
  });

  it("answers 404 synchronously when no route matches and no not-found handler is set", () => {
    const served = new Probe(0).serve(new Request("http://localhost/none"));
    expect(served).toBeInstanceOf(Response);
    expect((served as Response).status).toBe(404);
  });
});
