/**
 * Invalid JSON in a body declared JSON is a 400 on bun-nest, as on Nest's
 * Express platform (body-parser's `entity.parse.failed`), whether the body
 * is read while the request is built or by Nest's body parser middleware.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other gateway test files.
 */
import type { INestApplication } from "@nestjs/common";
import { Body, Controller, HttpCode, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib";
import "reflect-metadata";

@Controller()
class EchoController {
  @Post("echo")
  @HttpCode(200)
  echo(@Body() body: unknown) {
    return { body };
  }
}

@Module({ controllers: [EchoController] })
class AppModule {}

const apps: INestApplication[] = [];

/** A Nest app on a fresh adapter with the given request options. */
async function create(
  request: ConstructorParameters<typeof BunHttpAdapter>[1],
  bodyParser = true,
): Promise<BunHttpAdapter> {
  const adapter = new BunHttpAdapter(0, request);
  const app = await NestFactory.create(AppModule, adapter, {
    logger: false,
    bodyParser,
  });
  await app.init();
  apps.push(app);
  return adapter;
}

let built: BunHttpAdapter;
let deferred: BunHttpAdapter;

beforeAll(async () => {
  built = await create({});
  deferred = await create({ request: { deferBody: true } });
});

afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

const post = (adapter: BunHttpAdapter, body: string) =>
  adapter.fetch("/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

describe("bun-nest: invalid JSON", () => {
  for (const [name, adapter] of [
    ["read while the request is built", () => built],
    ["read by Nest's body parser (deferBody)", () => deferred],
  ] as const) {
    it(`is a 400 when ${name}`, async () => {
      const bad = await post(adapter(), '{"a":');
      expect(bad.status).toBe(400);
      const good = await post(adapter(), '{"a":1}');
      expect([good.status, await good.json()]).toEqual([
        200,
        { body: { a: 1 } },
      ]);
    });
  }
});
