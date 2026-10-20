/**
 * Several Nest applications on one HTTP adapter, one with a global prefix and
 * one without, booted on `@nestjs/platform-express`'s `ExpressAdapter` (with
 * 12.0.2's prefix fix carried back on 12.0.0 and 12.0.1: see
 * `expressCompat/reference.ts`) and on
 * `BunHttpAdapter`, both registration orders, sent the same requests. Every
 * answer must be Express's, whatever Nest major is installed.
 *
 * From Nest 12 Express scopes each application's not-found handler
 * (nestjs/nest #16372): the prefixed one answers at or under its prefix, the
 * unprefixed one everywhere else, skipping paths under another application's
 * prefix so they reach that application's routes and its 404. On Nest 11
 * every handler is global and the first registered answers.
 *
 * One known difference: on Express a not-found handler is a layer in the
 * stack, so one that covers a path shadows the routes of an application
 * initialised after it (`GET /root` is 404 with the api first, `GET
 * /api/hello` with the root first); here not-found handlers run only once no
 * route matched, so the route answers. It shows on Nest 11, where every
 * handler is global, and on Nest 12 with a parameterised prefix, which
 * Express mounts as `use("/:tenant")`, covering every first segment (and
 * which its prefix skip compares as written). Express 12's scoping fixes
 * both orders for a literal prefix.
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type { INestApplication } from "@nestjs/common";
import type { ExpressAdapter } from "@nestjs/platform-express";
import type { Side } from "./expressCompat/app";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AbstractHttpAdapter } from "@nestjs/core/adapters/http-adapter.js";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { comparable, observe } from "./expressCompat/app";
import {
  BACKPORT_PREFIX_FIX,
  expressReference,
  unfixedExpressAdapter,
} from "./expressCompat/reference";
import "reflect-metadata";

/** Nest 12 or later, by the capability the adapter reads (`mapException`). */
const NEST_12 =
  typeof (AbstractHttpAdapter.prototype as { mapException?: unknown })
    .mapException === "function";

@Controller()
class ApiController {
  @Get("hello")
  hello() {
    return { app: "api" };
  }
}

@Module({ controllers: [ApiController] })
class ApiModule {}

@Controller()
class RootController {
  @Get("root")
  root() {
    return { app: "root" };
  }
}

@Module({ controllers: [RootController] })
class RootModule {}

/**
 * Both applications on one adapter of `side`, initialised in `order`, the
 * prefixed one under `prefix`.
 */
async function boot(
  side: Side,
  order: "api first" | "root first",
  prefix: string,
): Promise<{ apps: INestApplication[]; base: string }> {
  const adapter =
    side === "express" ? expressReference() : new BunHttpAdapter();
  const api = await NestFactory.create(ApiModule, adapter, { logger: false });
  api.setGlobalPrefix(prefix);
  const root = await NestFactory.create(RootModule, adapter, {
    logger: false,
  });
  const apps = order === "api first" ? [api, root] : [root, api];
  for (const app of apps) {
    await app.init();
  }
  // Through the application created last: each one's construction gives
  // Express's adapter a new `http.Server`, and an earlier application would
  // wait for a server that never listens.
  await root.listen(0, "127.0.0.1");
  const server = root.getHttpServer() as { address: () => { port: number } };
  const port =
    side === "express"
      ? server.address().port
      : Number((adapter as BunHttpAdapter).listeningPort);
  return { apps, base: `http://127.0.0.1:${port}` };
}

const PATHS = [
  "/api/hello",
  "/root",
  "/api/nope",
  "/api",
  "/nope",
  "/apiary",
  "/root/x",
];

/**
 * The known differences (see above): the path whose route the first
 * application's not-found handler shadows on Express. None on Nest 12 with a
 * literal prefix.
 */
function shadowedOnExpress(order: "api first" | "root first", prefix: string) {
  if (NEST_12 && !prefix.includes(":")) {
    return [];
  }
  // With a parameterised prefix, `/api/hello` is `/:tenant/hello`.
  return order === "api first" ? ["/root"] : ["/api/hello"];
}

for (const prefix of ["api", ":tenant"]) {
  for (const order of ["api first", "root first"] as const) {
    describe(`several applications on one adapter, prefix ${prefix}, ${order}`, () => {
      const booted: Partial<
        Record<Side, { apps: INestApplication[]; base: string }>
      > = {};

      beforeAll(async () => {
        booted.express = await boot("express", order, prefix);
        booted.bun = await boot("bun", order, prefix);
      });

      afterAll(async () => {
        for (const side of ["express", "bun"] as const) {
          for (const app of booted[side]?.apps.toReversed() ?? []) {
            await app.close();
          }
        }
      });

      const known = shadowedOnExpress(order, prefix);

      for (const path of PATHS) {
        const differs = known.includes(path);
        it(`GET ${path} ${differs ? "differs from Express, as documented above" : "answers as Express"}`, async () => {
          const pick = ({
            status,
            body,
            "content-type": type,
          }: Record<string, string>) => ({
            status,
            body,
            type,
          });
          const express = pick(
            comparable(await observe(booted.express!.base, path)),
          );
          const bun = pick(comparable(await observe(booted.bun!.base, path)));
          if (differs) {
            expect([express.status, bun.status]).toEqual(["404", "200"]);
            return;
          }
          expect(bun).toEqual(express);
        });
      }
    });
  }
}

/**
 * The guard on the backport in `expressCompat/reference.ts`: where it is
 * applied (12.0.0, 12.0.1), the unfixed reference must really answer a miss
 * under the prefix with Express's own page, and the fixed one with Nest's
 * JSON 404. Should a release fix the bug without `normalizePrefix`, the first
 * test fails, and the backport can go. Skipped where it is not applied.
 */
describe.if(BACKPORT_PREFIX_FIX)(
  "the reference's prefix-scoped not-found on 12.0.0 and 12.0.1",
  () => {
    async function missUnderPrefix(adapter: ExpressAdapter) {
      const app = await NestFactory.create(ApiModule, adapter, {
        logger: false,
      });
      app.setGlobalPrefix("api");
      await app.listen(0, "127.0.0.1");
      try {
        const { port } = (
          app.getHttpServer() as { address: () => { port: number } }
        ).address();
        return comparable(
          await observe(`http://127.0.0.1:${port}`, "/api/nope"),
        );
      } finally {
        await app.close();
      }
    }

    it("unfixed, a miss under the prefix falls through to Express's HTML page", async () => {
      const res = await missUnderPrefix(unfixedExpressAdapter());
      expect(res.status).toBe("404");
      expect(res["content-type"]).toStartWith("text/html");
      expect(res.body).toContain("Cannot GET /api/nope");
    });

    it("with 12.0.2's fix, it is Nest's JSON 404", async () => {
      const res = await missUnderPrefix(expressReference());
      expect(res.status).toBe("404");
      expect(res["content-type"]).toStartWith("application/json");
      expect(JSON.parse(res.body)).toMatchObject({ statusCode: 404 });
    });
  },
);
