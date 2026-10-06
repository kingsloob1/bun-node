/**
 * The adapter's `etag` option is every response's starting point; a
 * controller overrules it for its own response with `res.setEtag(...)`.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other gateway test files.
 */
import type { BunResponse } from "@kingsleyweb/bun-common";
import type { INestApplication } from "@nestjs/common";
import { etag } from "@kingsleyweb/bun-common";
import { Controller, Get, Module, Res } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import "reflect-metadata";

@Controller()
class TagController {
  @Get("tagged")
  tagged() {
    return "body";
  }

  @Get("untagged")
  untagged(@Res({ passthrough: true }) res: BunResponse) {
    res.setEtag(false);
    return "body";
  }

  @Get("strong")
  strong(@Res({ passthrough: true }) res: BunResponse) {
    res.etag = "strong";
    return "body";
  }
}

@Module({ controllers: [TagController] })
class AppModule {}

let app: INestApplication;
let adapter: BunHttpAdapter;

beforeAll(async () => {
  adapter = new BunHttpAdapter(0, { etag: "weak" });
  app = await NestFactory.create(AppModule, adapter, { logger: false });
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

describe("bun-nest: per-response ETag", () => {
  it("uses the adapter's option unless the controller overrules it", async () => {
    const tagged = await adapter.fetch("/tagged");
    expect(tagged.headers.get("etag")).toBe(`W/${etag("body")}`);
    expect((await adapter.fetch("/untagged")).headers.get("etag")).toBeNull();
    expect((await adapter.fetch("/strong")).headers.get("etag")).toBe(
      etag("body"),
    );
  });

  it("answers 304 to a matching If-None-Match", async () => {
    const response = await adapter.fetch("/tagged", {
      headers: { "if-none-match": `W/${etag("body")}` },
    });
    expect(response.status).toBe(304);
  });
});
