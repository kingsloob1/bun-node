import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunResponse } from "../lib/BunResponse";
import { BunRouter, isRequestTimeoutError } from "../lib/BunRouter";
import { createTestLogger } from "../lib/logging";
import { makeRequest } from "./helpers";

/**
 * A pipeline that goes asynchronous waits on one promise for all of its
 * layers (`dispatch`/`dispatchOrStream`), and a parked layer still ends at
 * whichever comes first of its `next()`, its promise, a complete response,
 * its stream's end or the timeout — with the Express rules around each.
 */

/** What {@link serve}'s hooks make of a pipeline. */
type Served =
  | { routeUsed: unknown; stream?: undefined }
  | { stream: Response; routeUsed?: undefined };

/** Runs `router` on a fresh GET `path` through `serveRequest`. */
async function serve(router: BunRouter, path = "/x", timeout?: number) {
  const request = await makeRequest({ url: `http://localhost${path}` });
  const response = new BunResponse(request);
  const late: unknown[] = [];
  const result = router.serveRequest<Served>(
    {
      requestHost: "localhost",
      requestMethod: "GET",
      requestUrl: path,
      request,
      response,
      timeout,
    },
    {
      respond: (_options, routeUsed) => ({ routeUsed }),
      stream: (_options, stream) => ({ stream }),
      error: (_options, error) => error,
      lateError: (_options, error) => {
        late.push(error);
      },
    },
  );
  return { result, response, late };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("serveRequest: one wait for an asynchronous pipeline", () => {
  it("is synchronous when every layer is", async () => {
    const router = new BunRouter();
    router.get("/x", (_req, res) => res.send("ok"));
    const { result } = await serve(router);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toMatchObject({ routeUsed: { path: "/x" } });
  });

  it("finishes through its hooks: error() for a throw or a rejection, a respond() that throws rejects", async () => {
    const router = new BunRouter();
    router.get("/sync", () => {
      throw new Error("sync");
    });
    router.get("/async", async () => {
      await null;
      throw new Error("async");
    });
    router.get("/ok", async (_req, res) => {
      await null;
      res.send("ok");
    });
    const hooks = {
      respond: (_options: unknown, routeUsed: unknown) => {
        if ((routeUsed as { path?: string })?.path === "/ok") {
          throw new Error("respond failed");
        }
        return routeUsed;
      },
      stream: (_options: unknown, stream: Response) => stream,
      error: (_options: unknown, error: unknown) =>
        new Error(`carried: ${(error as Error).message}`),
      lateError: () => {},
    };
    const run = async (path: string) => {
      const request = await makeRequest({ url: `http://localhost${path}` });
      return router.serveRequest(
        {
          requestHost: "localhost",
          requestMethod: "GET",
          requestUrl: path,
          request,
          response: new BunResponse(request),
        },
        hooks,
      );
    };
    expect(run("/sync")).rejects.toThrow("carried: sync");
    expect(run("/async")).rejects.toThrow("carried: async");
    expect(run("/ok")).rejects.toThrow("respond failed");
  });

  it("resolves { routeUsed } after async middleware and an async handler", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    for (const name of ["a", "b"]) {
      router.use(async (_req, _res, next) => {
        await null;
        order.push(name);
        next();
      });
    }
    router.get("/x", async (_req, res) => {
      await null;
      order.push("handler");
      res.send("ok");
    });
    const { result, response } = await serve(router);
    expect(result).toBeInstanceOf(Promise);
    const outcome = await result;
    expect(outcome).toMatchObject({ routeUsed: { path: "/x" } });
    expect(order).toEqual(["a", "b", "handler"]);
    expect(await response.settledResponse!.text()).toBe("ok");
  });

  it("resolves at the response, not when the handler's promise settles", async () => {
    const router = new BunRouter();
    const { promise: release, resolve } = Promise.withResolvers<void>();
    let finished = false;
    router.get("/x", async (_req, res) => {
      await null;
      res.send("early");
      await release;
      finished = true;
    });
    const { result } = await serve(router);
    // Already answered while the handler still waits.
    expect(await result).toMatchObject({ routeUsed: { path: "/x" } });
    expect(finished).toBe(false);
    resolve();
    await tick();
    expect(finished).toBe(true);
  });

  it("runs the error handlers for next(err) called right after sending", async () => {
    // Express runs them (finalhandler then cuts the socket); the layer is
    // read once the tick that sent the response is over.
    for (const handler of [
      (_req: unknown, res: BunResponse, next: (e?: unknown) => void) => {
        res.send("x");
        next(new Error("after send"));
      },
      async (_req: unknown, res: BunResponse, next: (e?: unknown) => void) => {
        await null;
        res.send("x");
        next(new Error("after send"));
      },
    ]) {
      const router = new BunRouter();
      router.setLogger(createTestLogger().logger);
      const seen: unknown[] = [];
      router.get("/x", handler as never);
      router.use(((err, _req, res, next) => {
        seen.push([(err as Error).message, res.headersSent]);
        next(err as Error);
      }) satisfies RouterErrorMiddlewareHandler);
      const { result } = await serve(router);
      await (result instanceof Promise ? result : Promise.resolve(result));
      expect(seen).toEqual([["after send", true]]);
    }
  });

  it("goes on at next() even while the handler's promise is pending, after its tick", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    const { promise: release, resolve } = Promise.withResolvers<void>();
    router.use(async (_req, _res, next) => {
      await null;
      next();
      order.push("after next()");
      await release;
      order.push("middleware done");
    });
    router.get("/x", (_req, res) => {
      order.push("handler");
      res.send("ok");
    });
    const { result } = await serve(router);
    await result;
    // The rest of the middleware's tick runs before the next layer.
    expect(order).toEqual(["after next()", "handler"]);
    resolve();
    await tick();
    expect(order.at(-1)).toBe("middleware done");
  });

  it("logs a rejection after the pipeline moved on, and resolves normally", async () => {
    const router = new BunRouter();
    const { logger, events } = createTestLogger();
    router.setLogger(logger);
    router.get("/x", async (_req, res) => {
      await null;
      res.send("ok");
      await null;
      throw new Error("too late");
    });
    const { result } = await serve(router);
    expect(await result).toMatchObject({ routeUsed: { path: "/x" } });
    await tick();
    expect(events.map((e) => [e.message, e.error?.message])).toContainEqual([
      "Error from a handler after it had moved on",
      "too late",
    ]);
  });

  it("logs a later rejection of a non-promise thenable that had finished", async () => {
    const router = new BunRouter();
    const { logger, events } = createTestLogger();
    router.setLogger(logger);
    let reject!: (error: unknown) => void;
    router.get("/x", (_req, res) => {
      res.send("ok");
      // A thenable that is not a native Promise, rejected after finishing.
      return {
        then(_ok: unknown, fail: (error: unknown) => void) {
          reject = fail;
        },
      };
    });
    const { result } = await serve(router);
    expect(result).toBeTruthy();
    reject(new Error("thenable"));
    expect(events.map((e) => e.error?.message)).toContain("thenable");
  });

  it("enters error mode for a rejection before the layer finished", async () => {
    const router = new BunRouter();
    router.get("/x", async () => {
      await null;
      throw new Error("boom");
    });
    router.use(((err, _req, res, _next) => {
      res.status(500).send((err as Error).message);
    }) satisfies RouterErrorMiddlewareHandler);
    const { result, response } = await serve(router);
    await result;
    expect(response.statusCode).toBe(500);
    expect(await response.settledResponse!.text()).toBe("boom");
  });

  it("rejects with an unhandled error", async () => {
    const router = new BunRouter();
    router.get("/x", async () => {
      await null;
      throw new Error("unhandled");
    });
    const { result } = await serve(router);
    expect(result).rejects.toThrow("unhandled");
  });

  it("keeps waiting when the promise resolves without finishing, until a later next()", async () => {
    const router = new BunRouter();
    router.use((_req, _res, next) => {
      setTimeout(next, 5);
      return Promise.resolve();
    });
    router.get("/x", (_req, res) => res.send("later"));
    const { result, response } = await serve(router);
    await result;
    expect(await response.settledResponse!.text()).toBe("later");
  });

  it("resolves { stream } as soon as a stream opens; a later error cuts it off", async () => {
    const router = new BunRouter();
    const { logger, events } = createTestLogger();
    router.setLogger(logger);
    const { promise: release, resolve } = Promise.withResolvers<void>();
    router.get("/x", async (_req, res) => {
      await null;
      res.write("part");
      await release;
      throw new Error("after the stream opened");
    });
    const { result, response, late } = await serve(router);
    const outcome = await result;
    expect((outcome as { stream?: Response }).stream).toBeInstanceOf(Response);
    expect(response.isStreamOpen).toBe(true);
    resolve();
    await tick();
    await tick();
    // No error handler took it, and the status line is gone: the pipeline
    // logs it and destroys the stream (it never rejects, so onLateError,
    // which reports a rejected pipeline, is not called).
    expect(events.map((e) => [e.message, e.error?.message])).toContainEqual([
      "Unhandled error after the response was sent",
      "after the stream opened",
    ]);
    expect(response.isStreamOpen).toBe(false);
    expect(late).toEqual([]);
  });

  it("fails after the timeout while nothing was sent", async () => {
    const router = new BunRouter();
    router.get("/x", () => {
      // Neither responds nor calls next().
    });
    const { result } = await serve(router, "/x", 20);
    let error: unknown;
    try {
      await result;
    } catch (caught) {
      error = caught;
    }
    expect(isRequestTimeoutError(error)).toBe(true);
  });

  it("dispatch() resolves the bare outcome, not { routeUsed }", async () => {
    const router = new BunRouter();
    router.get("/x", async (_req, res) => {
      await null;
      res.send("ok");
    });
    const request = await makeRequest({ url: "http://localhost/x" });
    const dispatched = router.dispatch({
      requestHost: "localhost",
      requestMethod: "GET",
      requestUrl: "/x",
      request,
      response: new BunResponse(request),
    });
    expect(dispatched).toBeInstanceOf(Promise);
    expect(await dispatched).toMatchObject({ path: "/x" });
  });
});

describe("the adapters serve through the single wait", () => {
  it("answers async handlers and middleware, and an overridden handle()", async () => {
    const app = new BunHttpAdapter(0);
    app.use(async (_req, _res, next) => {
      await null;
      next();
    });
    app.get("/a", async (_req, res) => {
      await null;
      res.json({ ok: true });
    });
    expect(await (await app.fetch("/a")).json()).toEqual({ ok: true });

    class Overridden extends BunRouter {
      calls = 0;
      override async handle(
        options: Parameters<BunRouter["handle"]>[0],
      ): ReturnType<BunRouter["handle"]> {
        this.calls++;
        return super.handle(options);
      }
    }
    const router = new Overridden();
    router.get("/o", async (_req, res) => {
      await null;
      res.send("overridden");
    });
    const viaRouter = new BunHttpAdapter(0);
    viaRouter.setInstance(router);
    expect(await (await viaRouter.fetch("/o")).text()).toBe("overridden");
    expect(router.calls).toBe(1);
    expect(await (await router.fetch("/o")).text()).toBe("overridden");
    expect(router.calls).toBe(2);
  });
});
