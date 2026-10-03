/**
 * A copy of ../bun-native-routes/bench/nest-app.ts that takes the adapter
 * instance (so a snapshot of bun-nest can be measured) and does not listen.
 * The shared route set as a Nest 11 application on bun-nest's adapter. The three `/mw` middleware go through Nest's own
 * `MiddlewareConsumer`, which is how a Nest app would write them; the
 * thousand `/r<i>/:id` routes are one generated controller each.
 */
import type { MiddlewareConsumer, NestMiddleware } from "@nestjs/common";
import { Body, Controller, Get, HttpCode, Module, Param, Post, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

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

/**
 * The app on `adapter`, initialised but not listening: the in-process
 * harness calls the adapter's request entry directly.
 */
export async function initNest(routes: number, adapter: object, options: { bodyParser?: boolean } = {}): Promise<void> {
  const controllers: unknown[] = [BenchController];
  for (let i = 0; i < routes; i++) controllers.push(routeController(i));

  @Module({ controllers: controllers as never[] })
  class AppModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(Bump, Bump2, Bump3).forRoutes("mw/*path");
    }
  }

  const app = await NestFactory.create(AppModule, adapter as never, { logger: false, ...options });
  await app.init();
}
