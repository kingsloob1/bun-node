/**
 * `acceptUndecodableBody`: a router (the option) or a route (the marker
 * middleware) that receives a body the adapter could not decode, routed with
 * `req.bodyDecodingError` set as `router.fetch()` routes it, instead of the
 * adapter's early refusal (finalhandler's 400/415 before any route).
 *
 * Pinned here:
 * - an opted-in router authorizing first (bun-jobs' order) answers its own
 *   400 for an allowed caller and 403 for a denied one, served and through
 *   `adapter.fetch()`; the same router without the option gets the early
 *   HTML 400 with `authorize` never called (the negative control);
 * - a route that did not opt in, on the same adapter, is still refused early;
 * - which route decides, and nested mounts: the innermost router that set the
 *   option wins, a route's marker wins over its router, the first matching
 *   route handler decides, and with none the most deeply mounted middleware;
 * - a body over its cap is still refused with 413 before routing;
 * - nothing opted in: the decision does not even match the request.
 */
import type { NextFunction } from "../lib/types/general";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest } from "../lib/BunRequest";
import { acceptUndecodableBody, BunRouter } from "../lib/BunRouter";
import { noopLogger } from "../lib/logging";
import { testServer } from "./helpers";

/** A JSON POST: `{` (undecodable) unless `body` is given; `allow` sets `x-allow`. */
function post(allow: boolean, body = "{"): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(allow ? { "x-allow": "1" } : {}),
    },
    body,
  };
}

/** What a router recorded: `authorize` and handler calls. */
interface Calls {
  authorize: number;
  handler: number;
}

/**
 * A router in bun-jobs' management-API order: authorize first (403 without
 * `x-allow`), then refuse an undecodable body with its own JSON 400
 * `INVALID_JSON`, then answer; its own JSON 404 for any other path.
 */
function apiRouter(options?: { acceptUndecodableBody?: boolean }): {
  router: BunRouter;
  calls: Calls;
} {
  const calls: Calls = { authorize: 0, handler: 0 };
  const router = new BunRouter(options);
  router.use((req, res, next) => {
    calls.authorize++;
    if (req.getHeader("x-allow") !== "1") {
      res.status(403).json({ code: "FORBIDDEN" });
      return;
    }
    next();
  });
  router.post("/q/pause", (req, res) => {
    calls.handler++;
    const refused = req.bodyDecodingError;
    if (refused) {
      res
        .status(400)
        .json({ code: "INVALID_JSON", status: refused.status ?? null });
      return;
    }
    res.json({ paused: true, body: req.body ?? null });
  });
  router.use((_req, res) => {
    res.status(404).json({ code: "ROUTE_NOT_FOUND" });
  });
  return { router, calls };
}

/** The adapter's early refusal: finalhandler's HTML page. */
async function expectEarlyRefusal(res: Response, status = 400): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await res.text()).toContain("<pre>");
}

/** `[status, JSON body]` of a response. */
async function json(res: Response): Promise<[number, unknown]> {
  return [res.status, await res.json()];
}

describe("an opted-in router on BunHttpAdapter, served and through adapter.fetch", () => {
  const opted = apiRouter({ acceptUndecodableBody: true });
  const plain = apiRouter();
  const app = new BunHttpAdapter(0, { logger: noopLogger });
  /** Requests the adapter-level middleware ahead of every mount saw. */
  let globalRan = 0;
  /** Calls of the adapter's own route that did not opt in. */
  let plainRouteRan = 0;

  beforeAll(async () => {
    // Adapter-level middleware ahead of the mounts runs for a routed request.
    app.use((_req, _res, next: NextFunction) => {
      globalRan++;
      next();
    });
    app.use("/api", opted.router);
    app.use("/plain-api", plain.router);
    app.post("/plain", (_req, res) => {
      plainRouteRan++;
      res.json({});
    });
    await app.listen(0, "127.0.0.1");
  });

  afterAll(async () => {
    await app.close();
  });

  const transports = [
    [
      "adapter.fetch",
      (path: string, init: RequestInit) => app.fetch(path, init),
    ],
    [
      "served",
      (path: string, init: RequestInit) => fetch(`${app.url}${path}`, init),
    ],
  ] as const;

  for (const [name, send] of transports) {
    describe(name, () => {
      it("allowed: authorize runs, then the router's own 400 INVALID_JSON", async () => {
        const before = { ...opted.calls };
        const ranBefore = globalRan;
        expect(await json(await send("/api/q/pause", post(true)))).toEqual([
          400,
          { code: "INVALID_JSON", status: 400 },
        ]);
        expect(opted.calls).toEqual({
          authorize: before.authorize + 1,
          handler: before.handler + 1,
        });
        expect(globalRan).toBe(ranBefore + 1);
      });

      it("denied: 403, not a word about the body", async () => {
        const before = { ...opted.calls };
        const res = await send("/api/q/pause", post(false));
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(await json(res)).toEqual([403, { code: "FORBIDDEN" }]);
        expect(opted.calls).toEqual({
          authorize: before.authorize + 1,
          handler: before.handler,
        });
      });

      it("a body that decodes is unaffected", async () => {
        expect(
          await json(await send("/api/q/pause", post(true, '{"a":1}'))),
        ).toEqual([200, { paused: true, body: { a: 1 } }]);
      });

      it("a path no route handler claims: the opted-in router's own 404", async () => {
        const before = opted.calls.authorize;
        expect(await json(await send("/api/nope", post(true)))).toEqual([
          404,
          { code: "ROUTE_NOT_FOUND" },
        ]);
        expect(opted.calls.authorize).toBe(before + 1);
      });

      it("control: the same router without the option is refused early, authorize never called", async () => {
        const before = { ...plain.calls };
        const ranBefore = globalRan;
        for (const allow of [true, false]) {
          await expectEarlyRefusal(
            await send("/plain-api/q/pause", post(allow)),
          );
        }
        expect(plain.calls).toEqual(before);
        expect(globalRan).toBe(ranBefore);
        // …while a body that decodes reaches it.
        expect(
          await json(await send("/plain-api/q/pause", post(true, "{}"))),
        ).toEqual([200, { paused: true, body: {} }]);
      });

      it("control: a route of the adapter's own, not opted in, is refused early", async () => {
        const before = plainRouteRan;
        await expectEarlyRefusal(await send("/plain", post(true)));
        expect(plainRouteRan).toBe(before);
      });

      it("control: a path nothing matches is refused early, not a 404", async () => {
        await expectEarlyRefusal(await send("/nowhere", post(true)));
      });
    });
  }
});

describe("a Content-Encoding refusal is covered too", () => {
  it("routes the 415 to an opted-in route; refuses it on one that did not opt in", async () => {
    const app = new BunHttpAdapter(0, { logger: noopLogger });
    app.post("/in", acceptUndecodableBody(), (req, res) => {
      res.json({ refused: req.bodyDecodingError?.status ?? null });
    });
    app.post("/out", (_req, res) => {
      res.json({});
    });
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "compress",
      },
      body: "{}",
    };
    expect(await json(await app.fetch("/in", init))).toEqual([
      200,
      { refused: 415 },
    ]);
    await expectEarlyRefusal(await app.fetch("/out", init), 415);
  });
});

describe("which route decides, and nested mounts", () => {
  /** A route answering 200 with what it saw of the refusal. */
  const report =
    (tag: string) =>
    (req: BunRequest, res: import("../lib/BunResponse").BunResponse) => {
      res.json({ tag, refused: req.bodyDecodingError?.status ?? null });
    };

  /** `200 <tag>` routed, or `"refused"` for the early HTML 400. */
  async function outcome(app: BunHttpAdapter, path: string): Promise<string> {
    const res = await app.fetch(path, post(true));
    if (
      res.status === 400 &&
      res.headers.get("content-type")?.startsWith("text/html")
    ) {
      return "refused";
    }
    const body = (await res.json()) as { tag?: string; code?: string };
    return `${res.status} ${body.tag ?? body.code}`;
  }

  it("an opted-in router behind a mount that did not opt in: the inner router wins", async () => {
    const inner = new BunRouter({ acceptUndecodableBody: true });
    inner.post("/r", report("inner"));
    for (const outerOption of [undefined, false]) {
      const outer = new BunRouter({ acceptUndecodableBody: outerOption });
      outer.post("/own", report("outer"));
      outer.use("/in", inner);
      const app = new BunHttpAdapter(0, { logger: noopLogger });
      app.use("/v1", outer);
      expect(await outcome(app, "/v1/in/r")).toBe("200 inner");
      // The outer router's own route keeps its own setting.
      expect(await outcome(app, "/v1/own")).toBe("refused");
    }
  });

  it("the reverse: an unset router inherits the opted-in mount, an explicit false refuses", async () => {
    const unset = new BunRouter();
    unset.post("/r", report("unset"));
    const off = new BunRouter({ acceptUndecodableBody: false });
    off.post("/r", report("off"));
    const outer = new BunRouter({ acceptUndecodableBody: true });
    outer.post("/own", report("outer"));
    outer.use("/unset", unset);
    outer.use("/off", off);
    const app = new BunHttpAdapter(0, { logger: noopLogger });
    app.use("/v1", outer);
    expect(await outcome(app, "/v1/own")).toBe("200 outer");
    expect(await outcome(app, "/v1/unset/r")).toBe("200 unset");
    expect(await outcome(app, "/v1/off/r")).toBe("refused");
  });

  it("the adapter's own router option opts in everything it does not override", async () => {
    const off = new BunRouter({ acceptUndecodableBody: false });
    off.post("/r", report("off"));
    const app = new BunHttpAdapter(0, {
      logger: noopLogger,
      router: { acceptUndecodableBody: true },
    });
    app.post("/r", report("app"));
    app.use("/off", off);
    expect(await outcome(app, "/r")).toBe("200 app");
    expect(await outcome(app, "/off/r")).toBe("refused");
    // Nothing matched: the adapter's own setting, so its 404 rather than a 400.
    expect((await app.fetch("/nowhere", post(true))).status).toBe(404);
  });

  it("a route's marker wins over its router's false; its sibling stays refused", async () => {
    const router = new BunRouter({ acceptUndecodableBody: false });
    router.post("/marked", acceptUndecodableBody(), report("marked"));
    router.post("/sibling", report("sibling"));
    const app = new BunHttpAdapter(0, { logger: noopLogger });
    app.use(router);
    expect(await outcome(app, "/marked")).toBe("200 marked");
    expect(await outcome(app, "/sibling")).toBe("refused");
  });

  it("the first route handler the request matches decides, in pipeline order", async () => {
    const opted = new BunRouter({ acceptUndecodableBody: true });
    opted.post("/r", report("opted"));

    const plainFirst = new BunHttpAdapter(0, { logger: noopLogger });
    plainFirst.post("/r", (_req, _res, next) => next());
    plainFirst.use(opted);
    expect(await outcome(plainFirst, "/r")).toBe("refused");

    const optedFirst = new BunHttpAdapter(0, { logger: noopLogger });
    optedFirst.use(opted);
    optedFirst.post("/r", report("plain"));
    expect(await outcome(optedFirst, "/r")).toBe("200 opted");
  });

  it("with no route handler, the most deeply mounted middleware decides", async () => {
    const notFound =
      (tag: string) =>
      (_req: BunRequest, res: import("../lib/BunResponse").BunResponse) => {
        res.status(404).json({ tag });
      };
    const off = new BunRouter({ acceptUndecodableBody: false });
    off.use(notFound("off"));
    const outer = new BunRouter({ acceptUndecodableBody: true });
    outer.use("/off", off);
    outer.use(notFound("outer"));
    const app = new BunHttpAdapter(0, { logger: noopLogger });
    app.use("/v1", outer);
    // A trailing adapter-level middleware (depth 0) does not outvote the mount.
    app.use((_req, res) => {
      res.status(404).json({ tag: "app" });
    });
    expect(await outcome(app, "/v1/missing")).toBe("404 outer");
    expect(await outcome(app, "/v1/off/missing")).toBe("refused");
    // Outside every opted-in mount: the adapter's own (unset) setting.
    expect(await outcome(app, "/elsewhere")).toBe("refused");
  });
});

describe("a body over its cap is still refused with 413", () => {
  it("before routing, even for an opted-in router; under the cap it is routed", async () => {
    const { router, calls } = apiRouter({ acceptUndecodableBody: true });
    const app = new BunHttpAdapter(0, {
      logger: noopLogger,
      request: { parseBody: { maxContentLength: 16 } },
    });
    app.use("/api", router);

    const over = await app.fetch(
      "/api/q/pause",
      post(true, `{${"x".repeat(64)}`),
    );
    expect(over.status).toBe(413);
    expect(calls).toEqual({ authorize: 0, handler: 0 });

    // Control: the same undecodable body under the cap is routed.
    expect(await json(await app.fetch("/api/q/pause", post(true)))).toEqual([
      400,
      { code: "INVALID_JSON", status: 400 },
    ]);
    expect(calls).toEqual({ authorize: 1, handler: 1 });
  });
});

describe("routesUndecodableBody()", () => {
  async function badRequest(path: string): Promise<BunRequest> {
    const created = BunRequest.init(
      new Request(`http://localhost${path}`, post(true)),
      testServer,
      { parseBody: true },
    );
    return created instanceof BunRequest ? created : await created;
  }

  it("answers false without matching while nothing opted in", async () => {
    const router = new BunRouter();
    router.post("/r", (_req, res) => res.json({}));
    const match = spyOn(router, "getMatchedLayers");
    const req = await badRequest("/r");
    expect(req.bodyDecodingError?.status).toBe(400);
    expect(router.routesUndecodableBody(req)).toBe(false);
    expect(match).not.toHaveBeenCalled();
  });

  it("matches once something did, sharing the pipeline's cache", async () => {
    const router = new BunRouter();
    router.post("/r", acceptUndecodableBody(), (_req, res) => res.json({}));
    const req = await badRequest("/r");
    expect(router.routesUndecodableBody(req)).toBe(true);
    // The pipeline's lookup for the same request is the cached array.
    const layers = router.getMatchedLayers({
      requestHost: req.host,
      requestMethod: req.method,
      requestUrl: req.originalUrl,
      requestPath: req.path,
    });
    expect(
      router.getMatchedLayers({
        requestHost: req.host,
        requestMethod: req.method,
        requestUrl: req.originalUrl,
      }),
    ).toBe(layers);
  });

  it("router.fetch() is unchanged: it routes with or without the option", async () => {
    for (const option of [undefined, false, true]) {
      const { router, calls } = apiRouter({ acceptUndecodableBody: option });
      expect(await json(await router.fetch("/q/pause", post(true)))).toEqual([
        400,
        { code: "INVALID_JSON", status: 400 },
      ]);
      expect(calls).toEqual({ authorize: 1, handler: 1 });
    }
  });
});
