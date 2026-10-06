/**
 * bun-common's `requestParsing()` as NestJS functional middleware on
 * bun-nest's adapter, with the adapter's `deferBody` request option: a
 * route raises its body cap above the adapter's, and changes its query and
 * cookie parsing, without touching other routes.
 *
 * `bodyParser: false` keeps Nest from registering its global body parser,
 * which would read (and cap) every body before any route's middleware.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other gateway test files.
 */
import type { INestApplication, MiddlewareConsumer } from "@nestjs/common";
import { requestParsing } from "@kingsleyweb/bun-common";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter, requestParsing as reexported } from "../lib";
import "reflect-metadata";

@Controller()
class UploadController {
  @Post("upload")
  @HttpCode(200)
  upload(@Body() body: { pad: string }) {
    return { length: body.pad.length };
  }

  @Post("small")
  @HttpCode(200)
  small(@Body() body: unknown) {
    return { body };
  }

  @Get("flat")
  flat(@Query() query: unknown) {
    return query;
  }

  @Get("cookies")
  cookies(@Req() req: { cookies: unknown }) {
    return req.cookies;
  }
}

@Module({ controllers: [UploadController] })
class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(requestParsing({ parseBody: { maxContentLength: "8kb" } }))
      .forRoutes("upload");
    consumer
      .apply(requestParsing({ parseQueryOpts: { nesting: false } }))
      .forRoutes("flat");
    consumer
      .apply(requestParsing({ parseCookies: false }))
      .forRoutes("cookies");
  }
}

let app: INestApplication;
let adapter: BunHttpAdapter;

beforeAll(async () => {
  adapter = new BunHttpAdapter(0, {
    request: { parseBody: { maxContentLength: 128 }, deferBody: true },
  });
  app = await NestFactory.create(AppModule, adapter, {
    logger: false,
    bodyParser: false,
  });
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

const big = JSON.stringify({ pad: "x".repeat(2000) });
const post = (path: string, body: string) =>
  adapter.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

describe("bun-nest: requestParsing middleware", () => {
  it("is re-exported by bun-nest", () => {
    expect(reexported).toBe(requestParsing);
  });

  it("raises the body cap for its route only", async () => {
    const upload = await post("/upload", big);
    expect(upload.status).toBe(200);
    expect(await upload.json()).toEqual({ length: 2000 });
    expect((await post("/small", big)).status).toBe(413);
    expect(await (await post("/small", '{"a":1}')).json()).toEqual({
      body: { a: 1 },
    });
  });

  it("sets query and cookie parsing per route", async () => {
    expect(await (await adapter.fetch("/flat?a[b]=1")).json()).toEqual({
      "a[b]": "1",
    });
    const cookies = await adapter.fetch("/cookies", {
      headers: { cookie: "a=1" },
    });
    expect(await cookies.json()).toEqual({});
  });
});
