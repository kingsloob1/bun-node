/**
 * `BunHttpAdapter`'s `throttle` option: bun-common's `throttle()`, run ahead
 * of every route, every Nest middleware, every guard and the not-found
 * handler, so a burst of 404s counts too; its refusal is bun-common's `429`
 * problem document, answered before Nest sees the request. Nest's
 * `@SkipThrottle()` does not reach it (it configures `BunThrottlerGuard`).
 *
 * Requests go through `adapter.fetch()`, which has no address, so every
 * request is the one client `"unknown"` unless the option's `key` says
 * otherwise. `reflect-metadata` is imported last per the import-sort rule.
 */
import type {
  CanActivate,
  INestApplication,
  MiddlewareConsumer,
  NestModule,
} from "@nestjs/common";
import { throttle } from "@kingsleyweb/bun-common";
import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { SkipThrottle } from "../lib/throttler/decorators";
import "reflect-metadata";

/** What ran, in order: middleware and guards push here. */
const seen: string[] = [];

@Injectable()
class RecordingGuard implements CanActivate {
  canActivate() {
    seen.push("guard");
    return true;
  }
}

@Controller()
class ItemsController {
  @Get("a")
  a() {
    return "a";
  }

  @SkipThrottle()
  @Get("health")
  health() {
    return "ok";
  }
}

@Module({
  controllers: [ItemsController],
  providers: [{ provide: APP_GUARD, useClass: RecordingGuard }],
})
class ItemsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req: unknown, _res: unknown, next: () => void) => {
        seen.push("middleware");
        next();
      })
      .forRoutes("*");
  }
}

let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  seen.length = 0;
});

/** Boots {@link ItemsModule} on an adapter with `throttle`. */
async function boot(
  option: ConstructorParameters<typeof BunHttpAdapter>[1],
): Promise<BunHttpAdapter> {
  const adapter = new BunHttpAdapter(0, option);
  app = await NestFactory.create(ItemsModule, adapter, {
    logger: false,
    abortOnError: false,
  });
  await app.init();
  return adapter;
}

describe("BunHttpAdapter's throttle option", () => {
  it("counts every route and the not-found handler as one budget, and refuses before middleware and guards", async () => {
    const adapter = await boot({ throttle: { limit: 3, window: "1m" } });
    expect((await adapter.fetch("/a")).status).toBe(200);
    expect((await adapter.fetch("/missing")).status).toBe(404);
    expect((await adapter.fetch("/also-missing")).status).toBe(404);
    seen.length = 0;
    const refused = await adapter.fetch("/a");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(((await refused.json()) as { code: string }).code).toBe(
      "TOO_MANY_REQUESTS",
    );
    // Refused ahead of Nest: no middleware, no guard ran.
    expect(seen).toEqual([]);
    // A 404 is refused too.
    expect((await adapter.fetch("/missing")).status).toBe(429);
  });

  it("is not affected by @SkipThrottle(), which configures BunThrottlerGuard", async () => {
    const adapter = await boot({ throttle: { limit: 1, window: "1m" } });
    expect((await adapter.fetch("/health")).status).toBe(200);
    expect((await adapter.fetch("/health")).status).toBe(429);
  });

  it("takes a built throttle() too, and keys on the option's key", async () => {
    const adapter = await boot({
      throttle: throttle({
        limit: 1,
        window: "1m",
        key: (req) => String(req.headers["x-client"] ?? "none"),
        headers: "ietf",
      }),
    });
    const one = await adapter.fetch("/a", { headers: { "x-client": "one" } });
    expect(one.status).toBe(200);
    expect(one.headers.get("ratelimit-policy")).toBe('"default";q=1;w=60');
    expect(
      (await adapter.fetch("/a", { headers: { "x-client": "two" } })).status,
    ).toBe(200);
    expect(
      (await adapter.fetch("/a", { headers: { "x-client": "one" } })).status,
    ).toBe(429);
  });

  it("throttles nothing when not given", async () => {
    const adapter = await boot(undefined);
    for (let i = 0; i < 5; i++) {
      expect((await adapter.fetch("/a")).status).toBe(200);
    }
    expect(seen).toContain("middleware");
    expect(seen).toContain("guard");
  });
});
