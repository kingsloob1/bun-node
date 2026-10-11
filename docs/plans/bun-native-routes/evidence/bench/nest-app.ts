/**
 * The shared route set as a Nest 11 application on bun-nest's adapter, for
 * `servers.ts bun-nest`. The three `/mw` middleware go through Nest's own
 * `MiddlewareConsumer`, which is how a Nest app would write them; the
 * thousand `/r<i>/:id` routes are one generated controller each.
 */
import type { MiddlewareConsumer, NestMiddleware } from "@nestjs/common";
import { Body, Controller, Get, Header, HttpCode, Module, Param, Post, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import "reflect-metadata";

class Bump implements NestMiddleware {
  use(req: { hits?: number }, _res: unknown, next: () => void) {
    req.hits = (req.hits ?? 0) + 1;
    next();
  }
}
class Bump2 extends Bump {}
class Bump3 extends Bump {}

@Controller()
class BenchController {
  @Get("static")
  static() {
    return "ok";
  }

  @Get("user/:id")
  user(@Param("id") id: string) {
    return id;
  }

  @Get("mw/hit")
  mw(@Req() req: { hits?: number }) {
    return `mw:${req.hits}`;
  }

  @Get("async")
  async asyncRoute() {
    await null;
    return "ok";
  }

  @Get("headers")
  @Header("Content-Type", "text/plain; charset=utf-8")
  @Header("Access-Control-Allow-Origin", "*")
  @Header("Vary", "Origin")
  headers() {
    return "ok";
  }

  @Post("json")
  @HttpCode(200)
  json(@Body() body: { n: number }) {
    return { ok: true, n: body.n };
  }
}

function routeController(i: number) {
  class RouteController {
    handle(id: string) {
      return `r${i}:${id}`;
    }
  }
  Param("id")(RouteController.prototype, "handle", 0);
  const descriptor = Object.getOwnPropertyDescriptor(RouteController.prototype, "handle")!;
  Get(":id")(RouteController.prototype, "handle", descriptor);
  Controller(`r${i}`)(RouteController);
  return RouteController;
}

export async function startNest(routes: number, makeAdapter: () => BunHttpAdapter = () => new BunHttpAdapter()): Promise<number> {
  const controllers: unknown[] = [BenchController];
  for (let i = 0; i < routes; i++) controllers.push(routeController(i));

  @Module({ controllers: controllers as never[] })
  class AppModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(Bump, Bump2, Bump3).forRoutes("mw/*path");
    }
  }

  const app = await NestFactory.create(AppModule, makeAdapter(), { logger: false });
  await app.listen(0);
  const url = await app.getUrl();
  return Number(new URL(url.replace("[::1]", "127.0.0.1")).port);
}
