/**
 * The shared route set as a Nest 11 application on bun-nest's adapter, for
 * `servers.ts bun-nest`. The three `/mw` middleware go through Nest's own
 * `MiddlewareConsumer`, which is how a Nest app would write them; the
 * thousand `/r<i>/:id` routes are one generated controller each.
 */
import type { MiddlewareConsumer, NestMiddleware } from "@nestjs/common";
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Module,
  Param,
  Post,
  Req,
  UseInterceptors,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  BunHttpAdapter,
  FileInterceptor,
  UploadedFile,
} from "@kingsleyweb/bun-nest";
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

  @Get("assets/*path")
  assets() {
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

  @Post("form")
  @HttpCode(200)
  form(@Body() body: Record<string, string>) {
    return body;
  }

  @Post("binary")
  @HttpCode(200)
  binary(@Body() body: Uint8Array) {
    return { size: body.length };
  }

  @Post("text")
  @HttpCode(200)
  text(@Body() body: string) {
    return { length: body.length };
  }

  @Post("xml")
  @HttpCode(200)
  xml(@Body() body: { root: { n: unknown } }) {
    return { n: body.root.n };
  }

  @Post("upload")
  @HttpCode(200)
  @UseInterceptors(FileInterceptor("file", { storageType: "memory" }))
  upload(
    @Body() body: { field: string },
    @UploadedFile() file: { size: number } | undefined,
  ) {
    return { field: body.field, size: file?.size };
  }
}

function routeController(i: number) {
  class RouteController {
    handle(id: string) {
      return `r${i}:${id}`;
    }
  }
  Param("id")(RouteController.prototype, "handle", 0);
  const descriptor = Object.getOwnPropertyDescriptor(
    RouteController.prototype,
    "handle",
  )!;
  Get(":id")(RouteController.prototype, "handle", descriptor);
  Controller(`r${i}`)(RouteController);
  return RouteController;
}

export async function startNest(
  routes: number,
  // No body bytes kept, as the other frameworks keep none.
  makeAdapter: () => BunHttpAdapter = () =>
    new BunHttpAdapter(undefined, { request: { retainBuffer: false } }),
): Promise<number> {
  const controllers: unknown[] = [BenchController];
  for (let i = 0; i < routes; i++) controllers.push(routeController(i));

  @Module({ controllers: controllers as never[] })
  class AppModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(Bump, Bump2, Bump3).forRoutes("mw/*path");
    }
  }

  const app = await NestFactory.create(AppModule, makeAdapter(), {
    logger: false,
  });
  await app.listen(0);
  const url = await app.getUrl();
  return Number(new URL(url.replace("[::1]", "127.0.0.1")).port);
}
