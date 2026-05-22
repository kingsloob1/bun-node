import type {
  BunResponse,
  NextFunction,
  RouterHandler,
} from "@kingsleyweb/bun-common";
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

  it("createMiddlewareFactory registers a route via registerVerb", async () => {
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
});
