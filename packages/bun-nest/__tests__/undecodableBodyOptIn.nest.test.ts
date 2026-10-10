import type { BunRequest } from "@kingsleyweb/bun-common";
/**
 * `acceptUndecodableBody` on bun-nest's adapter: a body the adapter could not
 * decode reaches a router or route that opted in, `req.bodyDecodingError`
 * set, instead of the adapter's early refusal — so a guard can authorize the
 * caller before anything is said about the body.
 *
 * - a bun-common router mounted on the Nest adapter with the option (how
 *   bun-jobs' management API is mounted) authorizes first: an allowed caller
 *   gets its own 400 INVALID_JSON, a denied one 403; a Nest controller route
 *   on the same adapter, which did not opt in, is still refused early with
 *   with Nest's own 400, its guard never called (the negative control);
 * - the adapter's `router: { acceptUndecodableBody: true }` opts the Nest
 *   controllers in: the guard runs first, 403 or the controller's own 400;
 * - a body over its cap is still refused with 413 before any guard;
 * - out of scope, pinned: with `deferBody` the body is read by Nest's body
 *   parser inside the pipeline, which answers 400 as before.
 *
 * Served on port 0 and through `adapter.fetch()`. `reflect-metadata` is
 * imported last per the import-sort rule. No top-level `await`: it perturbs
 * decorator metadata in other gateway test files.
 */
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from "@nestjs/common";
import { BunRouter } from "@kingsleyweb/bun-common";
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Injectable,
  Module,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib";
import "reflect-metadata";

/** Calls into the Nest app's guard and controller. */
const nestCalls = { guard: 0, handler: 0 };

/** Allows a request carrying `x-allow: 1`; Nest answers 403 otherwise. */
@Injectable()
class AllowHeaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    nestCalls.guard++;
    const req = context.switchToHttp().getRequest<BunRequest>();
    return req.getHeader("x-allow") === "1";
  }
}

@Controller("nest")
@UseGuards(AllowHeaderGuard)
class PauseController {
  @Post("q/pause")
  @HttpCode(200)
  pause(@Req() req: BunRequest, @Body() body: unknown) {
    nestCalls.handler++;
    if (req.bodyDecodingError) {
      throw new BadRequestException({ code: "INVALID_JSON" });
    }
    return { paused: true, body: body ?? null };
  }
}

@Module({ controllers: [PauseController], providers: [AllowHeaderGuard] })
class AppModule {}

/** A JSON POST: `{` (undecodable) unless `body` is given; `allow` sets `x-allow`. */
function post(allow: boolean, body = "{"): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(allow ? { "x-allow": "1" } : {}),
    },
    body,
  };
}

/** `[status, JSON body]` of a response. */
async function json(res: Response): Promise<[number, unknown]> {
  return [res.status, await res.json()];
}

/** bun-jobs' order on a bun-common router: authorize, then the body. */
function apiRouter(calls: { authorize: number }): BunRouter {
  const router = new BunRouter({ acceptUndecodableBody: true });
  router.use((req, res, next) => {
    calls.authorize++;
    if (req.getHeader("x-allow") !== "1") {
      res.status(403).json({ code: "FORBIDDEN" });
      return;
    }
    next();
  });
  router.post("/q/pause", (req, res) => {
    if (req.bodyDecodingError) {
      res.status(400).json({ code: "INVALID_JSON" });
      return;
    }
    res.json({ paused: true });
  });
  return router;
}

const apps: INestApplication[] = [];

/** A served Nest app over `adapter`, and its base URL. */
async function serve(adapter: BunHttpAdapter): Promise<string> {
  const app = await NestFactory.create(AppModule, adapter, { logger: false });
  apps.push(app);
  await app.listen(0);
  return `http://127.0.0.1:${adapter.listeningPort}`;
}

afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

describe("a bun-common router mounted on the Nest adapter with the option", () => {
  const apiCalls = { authorize: 0 };
  const adapter = new BunHttpAdapter();
  let base = "";

  beforeAll(async () => {
    adapter.use("/api", apiRouter(apiCalls));
    base = await serve(adapter);
  });

  for (const [name, send] of [
    [
      "adapter.fetch",
      (path: string, init: RequestInit) => adapter.fetch(path, init),
    ],
    [
      "served",
      (path: string, init: RequestInit) => fetch(`${base}${path}`, init),
    ],
  ] as const) {
    describe(name, () => {
      it("allowed: authorize runs, then the router's own 400 INVALID_JSON", async () => {
        const before = apiCalls.authorize;
        expect(await json(await send("/api/q/pause", post(true)))).toEqual([
          400,
          { code: "INVALID_JSON" },
        ]);
        expect(apiCalls.authorize).toBe(before + 1);
      });

      it("denied: 403", async () => {
        const before = apiCalls.authorize;
        expect(await json(await send("/api/q/pause", post(false)))).toEqual([
          403,
          { code: "FORBIDDEN" },
        ]);
        expect(apiCalls.authorize).toBe(before + 1);
      });

      it("control: the Nest route beside it, not opted in, is refused early, its guard never called", async () => {
        const before = { ...nestCalls };
        for (const allow of [true, false]) {
          // Nest's own answer to the adapter's refusal, not the route's.
          const [status, body] = await json(
            await send("/nest/q/pause", post(allow)),
          );
          expect(status).toBe(400);
          expect(body).toMatchObject({ statusCode: 400, error: "Bad Request" });
          expect((body as { code?: string }).code).toBeUndefined();
        }
        expect(nestCalls).toEqual(before);
        // …while a body that decodes reaches it.
        expect(
          await json(await send("/nest/q/pause", post(true, '{"a":1}'))),
        ).toEqual([200, { paused: true, body: { a: 1 } }]);
      });
    });
  }
});

describe("the adapter's router option opts the Nest controllers in", () => {
  const adapter = new BunHttpAdapter(0, {
    router: { acceptUndecodableBody: true },
  });
  let base = "";

  beforeAll(async () => {
    base = await serve(adapter);
  });

  for (const [name, send] of [
    [
      "adapter.fetch",
      (path: string, init: RequestInit) => adapter.fetch(path, init),
    ],
    [
      "served",
      (path: string, init: RequestInit) => fetch(`${base}${path}`, init),
    ],
  ] as const) {
    describe(name, () => {
      it("allowed: the guard, then the controller's own 400", async () => {
        const before = { ...nestCalls };
        const [status, body] = await json(
          await send("/nest/q/pause", post(true)),
        );
        expect([status, (body as { code?: string }).code]).toEqual([
          400,
          "INVALID_JSON",
        ]);
        expect(nestCalls).toEqual({
          guard: before.guard + 1,
          handler: before.handler + 1,
        });
      });

      it("denied: the guard's 403, the controller never called", async () => {
        const before = { ...nestCalls };
        const [status] = await json(await send("/nest/q/pause", post(false)));
        expect(status).toBe(403);
        expect(nestCalls).toEqual({
          guard: before.guard + 1,
          handler: before.handler,
        });
      });
    });
  }
});

describe("what the option leaves alone", () => {
  it("a body over its cap: 413 before any guard", async () => {
    const adapter = new BunHttpAdapter(0, {
      router: { acceptUndecodableBody: true },
      request: { parseBody: { maxContentLength: 16 } },
    });
    await serve(adapter);
    const before = { ...nestCalls };
    const res = await adapter.fetch(
      "/nest/q/pause",
      post(true, `{${"x".repeat(64)}`),
    );
    expect(res.status).toBe(413);
    expect(nestCalls).toEqual(before);
    // Control: under the cap, the same adapter routes it to the guard.
    expect((await adapter.fetch("/nest/q/pause", post(true))).status).toBe(400);
    expect(nestCalls.guard).toBe(before.guard + 1);
  });

  it("out of scope: with deferBody, Nest's body parser reads it in the pipeline and answers 400 as before", async () => {
    const adapter = new BunHttpAdapter(0, {
      router: { acceptUndecodableBody: true },
      request: { deferBody: true },
    });
    await serve(adapter);
    const before = { ...nestCalls };
    const [status, body] = await json(
      await adapter.fetch("/nest/q/pause", post(true)),
    );
    expect(status).toBe(400);
    expect((body as { code?: string }).code).toBeUndefined();
    expect(nestCalls).toEqual(before);
  });
});
