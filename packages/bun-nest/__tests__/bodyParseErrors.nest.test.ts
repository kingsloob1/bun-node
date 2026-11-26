/**
 * Invalid JSON in a body declared JSON is a 400 on bun-nest, as on Nest's
 * Express platform (body-parser's `entity.parse.failed`), whether the body
 * is read while the request is built or by Nest's body parser middleware.
 *
 * It is Nest's own `BadRequestException` answer, as on Express, on Nest 11
 * and 12 alike: Nest 11's core maps a `SyntaxError` or `URIError` raised
 * outside a route to `BadRequestException`; Nest 12 moved that mapping into
 * the adapter (`mapException`, nestjs/nest #15075). The same holds for a
 * path parameter that cannot be decoded and a middleware's `next(err)`,
 * except, from Nest 11.2.10, a middleware's error without a `status` of 400:
 * the core leaves it unmapped, a generic 500 (its message may hold internal
 * details), as on Express.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other gateway test files.
 */
import type { INestApplication, MiddlewareConsumer } from "@nestjs/common";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Post,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { RoutesResolver } from "@nestjs/core/router/routes-resolver.js";
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

  @Get("users/:id")
  user(@Param("id") id: string) {
    return { id };
  }

  @Get("mw/:kind")
  mw(@Param("kind") kind: string) {
    return { kind };
  }
}

/**
 * `next()`s a `SyntaxError` or `URIError` for `/mw/syntax` and `/mw/uri`,
 * and one with a `status` of 400, as a parser sets it, for `/mw/syntax-400`
 * and `/mw/uri-400`.
 */
function failing(
  req: { url?: string },
  _res: unknown,
  next: (error?: unknown) => void,
) {
  if (req.url?.endsWith("/syntax-400")) {
    next(
      Object.assign(new SyntaxError("bad syntax from middleware"), {
        status: 400,
      }),
    );
    return;
  }
  if (req.url?.endsWith("/uri-400")) {
    next(
      Object.assign(new URIError("bad uri from middleware"), { status: 400 }),
    );
    return;
  }
  if (req.url?.endsWith("/syntax")) {
    next(new SyntaxError("bad syntax from middleware"));
    return;
  }
  if (req.url?.endsWith("/uri")) {
    next(new URIError("bad uri from middleware"));
    return;
  }
  next();
}

@Module({ controllers: [EchoController] })
class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(failing).forRoutes("mw/*path");
  }
}

/**
 * Whether the installed core leaves a `SyntaxError` without a `status` of 400
 * unmapped (Nest 11.2.10 and later): read from its own
 * `mapExternalException`, which Nest 12 does not have (its adapter maps).
 */
const CORE_LEAVES_UNMARKED_SYNTAX_ERRORS = (() => {
  const map = (RoutesResolver.prototype as { mapExternalException?: unknown })
    .mapExternalException;
  if (typeof map !== "function") {
    return false;
  }
  const probe = new SyntaxError("probe");
  return (
    (map as (this: object, error: unknown) => unknown).call(
      { isHttpFastifyError: () => false },
      probe,
    ) === probe
  );
})();

/** Nest's built-in filter's answer to an error it does not know. */
const INTERNAL_ERROR = { statusCode: 500, message: "Internal server error" };

/** `BadRequestException(message)`'s body, as Nest's filters write it. */
function badRequest(message: string) {
  return { message, error: "Bad Request", statusCode: 400 };
}

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
      // Nest's BadRequestException, carrying the parser's message.
      const body = (await bad.json()) as { message?: unknown };
      expect(typeof body.message).toBe("string");
      expect(body).toEqual(badRequest(body.message as string));
      const good = await post(adapter(), '{"a":1}');
      expect([good.status, await good.json()]).toEqual([
        200,
        { body: { a: 1 } },
      ]);
    });
  }
});

describe("bun-nest: a SyntaxError or URIError outside a route's handler", () => {
  it("is a 400 for a path parameter that cannot be decoded, as on Express", async () => {
    const res = await built.fetch("/users/%E0%A4%A");
    expect([res.status, await res.json()]).toEqual([
      400,
      badRequest("Failed to decode param '%E0%A4%A'"),
    ]);
    const ok = await built.fetch("/users/caf%C3%A9");
    expect([ok.status, await ok.json()]).toEqual([200, { id: "café" }]);
  });

  it("is a 400 for a middleware's next(err) with a status of 400, with the error's message", async () => {
    for (const [path, message] of [
      ["/mw/syntax-400", "bad syntax from middleware"],
      ["/mw/uri-400", "bad uri from middleware"],
    ] as const) {
      const res = await built.fetch(path);
      expect([res.status, await res.json()]).toEqual([
        400,
        badRequest(message),
      ]);
    }
  });

  it(`is ${CORE_LEAVES_UNMARKED_SYNTAX_ERRORS ? "a generic 500 (Nest 11.2.10 and later)" : "a 400, with the error's message,"} for a middleware's next(err) without a status`, async () => {
    for (const [path, message] of [
      ["/mw/syntax", "bad syntax from middleware"],
      ["/mw/uri", "bad uri from middleware"],
    ] as const) {
      const res = await built.fetch(path);
      expect([res.status, await res.json()]).toEqual(
        CORE_LEAVES_UNMARKED_SYNTAX_ERRORS
          ? [500, INTERNAL_ERROR]
          : [400, badRequest(message)],
      );
    }
    const ok = await built.fetch("/mw/fine");
    expect([ok.status, await ok.json()]).toEqual([200, { kind: "fine" }]);
  });
});
