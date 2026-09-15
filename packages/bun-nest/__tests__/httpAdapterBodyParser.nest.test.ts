/**
 * `BunHttpAdapter` behaviour a NestJS application reaches through its own
 * API, matched against `@nestjs/platform-express`'s ExpressAdapter:
 *
 *  - `app.useBodyParser(type, options)`: `type` picks the requests a parser
 *    reads (body-parser's default per kind), `limit` answers 413 through
 *    Nest's exception layer, each kind registers once and kinds stack;
 *  - `app.listen()` on a busy port rejects (the adapter reports it through
 *    the HTTP server's `error` event);
 *  - `@Render()` with a handler returning nothing still renders.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other gateway test files.
 */
import type {
  BodyParserOptions,
  BodyParserType,
  BunRequest,
} from "@kingsleyweb/bun-common";
import type { INestApplication, RawBodyRequest } from "@nestjs/common";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  Controller,
  Get,
  HttpCode,
  Module,
  Post,
  Render,
  Req,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import "reflect-metadata";

/** A file `@Render()` sends. */
const PAGE = join(tmpdir(), `bun-nest-render-${process.pid}.html`);

@Controller()
class EchoController {
  @Post("echo")
  @HttpCode(200)
  echo(@Req() req: RawBodyRequest<BunRequest>) {
    return { raw: req.rawBody?.toString() ?? null };
  }

  @Get("page")
  @Render(PAGE)
  page() {
    // Nothing: Nest hands `render` an `undefined` options argument.
  }
}

@Module({ controllers: [EchoController] })
class AppModule {}

/** `app.useBodyParser`, which NestJS declares on its platform-specific app types only. */
interface BodyParserApp {
  /** Registers a parser through the adapter, with the app's `rawBody` option. */
  useBodyParser: (type: BodyParserType, options?: BodyParserOptions) => unknown;
}

/** Applications to close after each test. */
const apps: INestApplication[] = [];

afterEach(async () => {
  while (apps.length) {
    await apps.pop()?.close();
  }
});

beforeAll(async () => {
  await Bun.write(PAGE, "<p>page</p>");
});

afterAll(async () => {
  await Bun.file(PAGE).delete();
});

/** A Nest app with Nest's own parser off, configured by `setup` before init. */
async function makeApp(setup: (app: BodyParserApp) => void) {
  const adapter = new BunHttpAdapter();
  const app = await NestFactory.create(AppModule, adapter as never, {
    logger: false,
    bodyParser: false,
    rawBody: true,
  });
  apps.push(app);
  setup(app as unknown as BodyParserApp);
  await app.init();
  return adapter;
}

/** POSTs `body` as `type` to `/echo`. */
function post(adapter: BunHttpAdapter, type: string, body: string) {
  return adapter.fetch("/echo", {
    method: "POST",
    headers: { "content-type": type },
    body,
  });
}

const BIG_JSON = JSON.stringify({ text: "x".repeat(64) });
const BIG_TEXT = "y".repeat(64);

describe("NestJS app.useBodyParser(): type", () => {
  it("reads only the kind's default media type", async () => {
    const adapter = await makeApp((app) => app.useBodyParser("json"));

    expect(
      await (await post(adapter, "application/json", '{"a":1}')).json(),
    ).toEqual({
      raw: '{"a":1}',
    });
    // Skipped: not read, so no rawBody.
    expect(await (await post(adapter, "text/plain", "hello")).json()).toEqual({
      raw: null,
    });
  });

  it("honours an explicit `type`", async () => {
    const adapter = await makeApp((app) =>
      app.useBodyParser("text", { type: "application/x-custom" }),
    );

    expect(
      await (await post(adapter, "application/x-custom", "custom")).json(),
    ).toEqual({
      raw: "custom",
    });
    expect(await (await post(adapter, "text/plain", "plain")).json()).toEqual({
      raw: null,
    });
  });
});

describe("NestJS app.useBodyParser(): limit", () => {
  it("answers a body over the limit 413 through Nest's exception layer", async () => {
    const adapter = await makeApp((app) =>
      app.useBodyParser("json", { limit: 16 }),
    );

    const response = await post(adapter, "application/json", BIG_JSON);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ statusCode: 413 });
  });

  it("does not apply one kind's limit to a request of another type", async () => {
    const adapter = await makeApp((app) =>
      app.useBodyParser("json", { limit: 16 }),
    );

    expect((await post(adapter, "text/plain", BIG_TEXT)).status).toBe(200);
  });
});

describe("NestJS app.useBodyParser(): registrations", () => {
  it("stacks different kinds, each with its own options", async () => {
    const adapter = await makeApp((app) => {
      app.useBodyParser("json", { limit: 16 });
      app.useBodyParser("text", { limit: "1kb" });
    });

    const text = await post(adapter, "text/plain", BIG_TEXT);
    expect(text.status).toBe(200);
    expect(await text.json()).toEqual({ raw: BIG_TEXT });
    expect((await post(adapter, "application/json", BIG_JSON)).status).toBe(
      413,
    );
  });

  it("registers a kind once: a second call for it does nothing", async () => {
    const adapter = await makeApp((app) => {
      app.useBodyParser("json", { limit: 16 });
      app.useBodyParser("json", { limit: "1mb" });
    });

    expect((await post(adapter, "application/json", BIG_JSON)).status).toBe(
      413,
    );
  });
});

describe("NestJS app.listen()", () => {
  it("rejects with the bind error when the port is taken", async () => {
    const holder = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("taken"),
    });
    const app = await NestFactory.create(
      AppModule,
      new BunHttpAdapter() as never,
      {
        logger: false,
      },
    );
    apps.push(app);

    try {
      await expect(app.listen(Number(holder.port))).rejects.toBeInstanceOf(
        Error,
      );
    } finally {
      await holder.stop(true);
    }
  });
});

describe("NestJS @Render()", () => {
  it("renders when the handler returns nothing", async () => {
    const adapter = await makeApp(() => undefined);

    const response = await adapter.fetch("/page");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<p>page</p>");
  });
});
