import type {
  BunResponse,
  NextFunction,
  RouterHandler,
  StandardSchemaV1,
} from "@kingsleyweb/bun-common";
import { BunRouter, validate } from "@kingsleyweb/bun-common";
import { RequestMethod } from "@nestjs/common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";

let adapter: BunHttpAdapter | undefined;

afterEach(async () => {
  await adapter?.close();
  adapter = undefined;
});

describe("bun-nest BunHttpAdapter: Express 5 use semantics", () => {
  it("runs use() middleware before the route handler", async () => {
    adapter = new BunHttpAdapter(5000);
    const order: string[] = [];

    adapter.use(((_req, _res, next) => {
      order.push("middleware");
      next();
    }) as RouterHandler);
    adapter.get("/check", (async (_req, res) => {
      order.push("handler");
      return res.json({ order });
    }) as RouterHandler);

    await adapter.listen(0);
    const response = await fetch(
      `http://${adapter.listeningHost}:${adapter.listeningPort}/check`,
    );
    expect(response.status).toBe(200);
    expect(order).toEqual(["middleware", "handler"]);
  });

  it("catches a thrown route error with a use()-registered error handler", async () => {
    adapter = new BunHttpAdapter(5000);

    adapter.get("/boom", (async () => {
      throw new Error("nest route exploded");
    }) as RouterHandler);
    adapter.use(((
      err: unknown,
      _req: unknown,
      res: BunResponse,
      _next: NextFunction,
    ) => {
      return res
        .status(500)
        .json({ handled: true, message: (err as Error).message });
    }) as unknown as RouterHandler);

    await adapter.listen(0);
    const response = await fetch(
      `http://${adapter.listeningHost}:${adapter.listeningPort}/boom`,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      handled: true,
      message: "nest route exploded",
    });
  });

  it("forwards next(err) from middleware to the error handler", async () => {
    adapter = new BunHttpAdapter(5000);

    adapter.use(((_req, _res, next) => {
      next(new Error("rejected by middleware"));
    }) as RouterHandler);
    adapter.get("/never", (async (_req, res) =>
      res.json({ reached: true })) as RouterHandler);
    adapter.use(((
      err: unknown,
      _req: unknown,
      res: BunResponse,
      _next: NextFunction,
    ) => {
      return res.status(502).json({ message: (err as Error).message });
    }) as unknown as RouterHandler);

    await adapter.listen(0);
    const response = await fetch(
      `http://${adapter.listeningHost}:${adapter.listeningPort}/never`,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      message: "rejected by middleware",
    });
  });

  it("createMiddlewareFactory registers method-scoped middleware via useMethod", async () => {
    adapter = new BunHttpAdapter(5000);

    const factory = adapter.createMiddlewareFactory(RequestMethod.GET);
    factory("/factory-route", ((_req, res) =>
      res.json({ via: "middleware-factory" })) as RouterHandler);

    await adapter.listen(0);
    const response = await fetch(
      `http://${adapter.listeningHost}:${adapter.listeningPort}/factory-route`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ via: "middleware-factory" });
  });

  it("createMiddlewareFactory registers middleware, not a route handler", async () => {
    adapter = new BunHttpAdapter(5000);
    const order: string[] = [];

    // Middleware registered via the factory must run as middleware — before
    // the route handler — and pass control on with next().
    const factory = adapter.createMiddlewareFactory(RequestMethod.GET);
    factory("/checkpoint", ((_req, _res, next) => {
      order.push("factory-middleware");
      next();
    }) satisfies RouterHandler);
    adapter.get("/checkpoint", (async (_req, res) => {
      order.push("route");
      return res.json({ order });
    }) as RouterHandler);

    await adapter.listen(0);
    const response = await fetch(
      `http://${adapter.listeningHost}:${adapter.listeningPort}/checkpoint`,
    );
    expect(response.status).toBe(200);
    expect(order).toEqual(["factory-middleware", "route"]);
  });

  it("createMiddlewareFactory scopes middleware to the chosen method", async () => {
    adapter = new BunHttpAdapter(5000);
    let ran = false;

    const factory = adapter.createMiddlewareFactory(RequestMethod.POST);
    factory("/scoped", ((_req, _res, next) => {
      ran = true;
      next();
    }) satisfies RouterHandler);
    adapter.all("/scoped", (async (_req, res) =>
      res.json({ ok: true })) as RouterHandler);

    await adapter.listen(0);
    // A GET request must not trigger the POST-scoped middleware.
    await fetch(
      `http://${adapter.listeningHost}:${adapter.listeningPort}/scoped`,
    );
    expect(ran).toBe(false);
  });
});

describe("bun-nest BunHttpAdapter: use() mounts bun-common routers", () => {
  it("serves a plain router mounted at a path prefix, and only under it", async () => {
    adapter = new BunHttpAdapter();
    const ui = new BunRouter();
    ui.get("/", (_req, res) => res.send("home"));
    ui.get("/queues/:name", (req, res) => res.json(req.params));
    // No cast: a `BunRouter` is a valid `use()` argument.
    adapter.use("/admin/jobs", ui);

    expect(await (await adapter.fetch("/admin/jobs")).text()).toBe("home");
    const queue = await adapter.fetch("/admin/jobs/queues/emails");
    expect(queue.status).toBe(200);
    expect(await queue.json()).toEqual({ name: "emails" });
    expect((await adapter.fetch("/queues/emails")).status).toBe(404);
  });

  it("mounts a router with no path at the root, in order with middleware", async () => {
    adapter = new BunHttpAdapter();
    const seen: string[] = [];
    const router = new BunRouter();
    router.get("/ping", (_req, res) => {
      seen.push("route");
      return res.send("pong");
    });
    adapter.use((_req, _res, next) => {
      seen.push("middleware");
      next();
    }, router);

    const response = await adapter.fetch("/ping");
    expect(await response.text()).toBe("pong");
    expect(seen).toEqual(["middleware", "route"]);
  });

  it("gives a mount-declared router the mount's params and validated query", async () => {
    adapter = new BunHttpAdapter();
    const PageQuery: StandardSchemaV1<unknown, { page: number }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => {
          const page = Number((value as { page?: string }).page);
          return Number.isInteger(page)
            ? { value: { page } }
            : { issues: [{ message: "page must be an integer" }] };
        },
      },
    };
    const orgs = new BunRouter<"/orgs/:org", { query: { page: number } }>();
    orgs.get("/members/:member", (req, res) => {
      return res.json({ params: req.params, page: req.query.page });
    });
    adapter.use("/orgs/:org", validate({ query: PageQuery }), orgs);

    const ok = await adapter.fetch("/orgs/acme/members/ada?page=2");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      params: { org: "acme", member: "ada" },
      page: 2,
    });
    expect((await adapter.fetch("/orgs/acme/members/ada?page=x")).status).toBe(
      400,
    );
  });
});
