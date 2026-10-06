/**
 * Express 5 behaviours a Nest app on `@nestjs/platform-express` relies on,
 * on `BunHttpAdapter` (both come from bun-common's router):
 *
 * - `@Get()` answers `HEAD` with the same status and headers and no body;
 * - a `MiddlewareConsumer` middleware may call `next()` later, from a
 *   callback, as callback-style Express middleware does.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other gateway test files.
 */
import type {
  INestApplication,
  MiddlewareConsumer,
  NestMiddleware,
} from "@nestjs/common";
import { Controller, Get, Header, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import "reflect-metadata";

/** Calls `next()` on a later turn of the event loop, as I/O-bound middleware does. */
class LateNext implements NestMiddleware {
  use(req: { late?: boolean }, _res: unknown, next: () => void) {
    setTimeout(() => {
      req.late = true;
      next();
    }, 5);
  }
}

@Controller()
class ParityController {
  @Get("page")
  @Header("x-page", "1")
  page() {
    return "page-body";
  }

  @Get("late")
  late() {
    return "after-late-next";
  }
}

@Module({ controllers: [ParityController] })
class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LateNext).forRoutes("late");
  }
}

let app: INestApplication;
let adapter: BunHttpAdapter;
let base: string;

beforeAll(async () => {
  adapter = new BunHttpAdapter();
  app = await NestFactory.create(AppModule, adapter, { logger: false });
  await app.listen(0);
  base = `http://127.0.0.1:${adapter.listeningPort}`;
});

afterAll(async () => {
  await app?.close();
});

describe("bun-nest: Express parity", () => {
  it("answers HEAD on a @Get() route with its headers and no body", async () => {
    const served = await fetch(`${base}/page`, { method: "HEAD" });
    expect(served.status).toBe(200);
    expect(served.headers.get("x-page")).toBe("1");
    expect(await served.text()).toBe("");

    const fetched = await adapter.fetch("/page", { method: "HEAD" });
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("x-page")).toBe("1");
    expect(await fetched.text()).toBe("");
  });

  it("continues after a middleware calls next() from a callback", async () => {
    const served = await fetch(`${base}/late`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("after-late-next");
    expect(await (await adapter.fetch("/late")).text()).toBe("after-late-next");
  });
});

@Controller()
class StuckController {
  @Get("stuck")
  async stuck() {
    await new Promise(() => {});
  }
}

@Module({ controllers: [StuckController] })
class StuckModule {}

describe("bun-nest: the request timeout covers a stuck controller", () => {
  it("answers a controller that never settles once the timeout passes", async () => {
    const timed = new BunHttpAdapter(100);
    const stuckApp = await NestFactory.create(StuckModule, timed, {
      logger: false,
    });
    await stuckApp.init();
    try {
      const started = performance.now();
      const response = await timed.fetch("/stuck");
      expect(response.status).toBe(500);
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      await stuckApp.close();
    }
  });
});
