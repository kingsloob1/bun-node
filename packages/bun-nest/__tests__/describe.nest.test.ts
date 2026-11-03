/**
 * `@Describe` (typed-client plan `nest-typed-routes.md` §3.2, PR-N3): a
 * controller route's `RouteDoc`, written as `"bun:describe"` reflect
 * metadata, which NestJS's `copyMetadataToCallback` carries onto the handler
 * it registers, and bun-common's generators read beside `.describe()`'s store.
 *
 * - **Parity**: a controller app's `generateOpenApi(adapter.instance)`
 *   document deep-equals a bun-common router app's for the same routes,
 *   declared with `validate()` and `.describe()` (summary, description,
 *   tags, operationId, deprecated, errors, cache, extensions, responses,
 *   hidden, a global prefix). Control: the controller app without
 *   `@Describe` differs.
 * - A controller-level `@Describe`: under each route method (the method's
 *   keys win, tags combined), `hidden` on the class hides every route, an
 *   inherited method is not touched; stacking on a method and on a class.
 * - Misuse throws at decoration.
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type { INestApplication } from "@nestjs/common";
import type { OpenApiDocument } from "@kingsleyweb/bun-common/lib/docs";
import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunRouter, validate } from "@kingsleyweb/bun-common";
import { generateOpenApi } from "@kingsleyweb/bun-common/lib/docs";
import { BunHttpAdapter, Describe, Validate } from "../lib";
import "reflect-metadata";

const IdParams = z.object({ id: z.string() });
const User = z.object({ id: z.string(), name: z.string() });
const UserPatch = z.object({ name: z.string().min(1) });
const Problem = z.object({ code: z.string(), message: z.string() });

/** The document options both apps are documented with. */
const DOC = { title: "Users", version: "1" } as const;

@Controller("users")
@Describe({ tags: ["users"] })
class UsersController {
  @Get(":id")
  @Validate({ params: IdParams, responses: { 200: User, 404: Problem } })
  @Describe({
    summary: "Read one user",
    description: "By id.",
    operationId: "getUser",
    errors: ["NOT_FOUND"],
    cache: { tags: ["user:{id}"] },
  })
  one(@Param("id") id: string) {
    return { id, name: "Ada" };
  }

  @Patch(":id")
  @Validate({ params: IdParams, body: UserPatch, responses: { 200: User } })
  @Describe({
    tags: ["writes"],
    cache: { invalidates: ["user:{id}", "users"] },
  })
  @Describe({ deprecated: true, extensions: { "x-team": "core" } })
  update(@Param("id") id: string, @Body() body: { name: string }) {
    return { id, name: body.name };
  }

  @Post()
  @Validate({ body: UserPatch, responses: { 201: User } })
  @Describe({ hidden: true })
  create(@Body() body: { name: string }) {
    return { id: "1", name: body.name };
  }
}

@Controller("health")
@Describe({ hidden: true })
class HealthController {
  @Get()
  ok() {
    return { ok: true };
  }
}

@Module({ controllers: [UsersController, HealthController] })
class AppModule {}

/** The same routes, undescribed: the control. */
@Controller("users")
class PlainUsersController {
  @Get(":id")
  @Validate({ params: IdParams, responses: { 200: User, 404: Problem } })
  one(@Param("id") id: string) {
    return { id, name: "Ada" };
  }

  @Patch(":id")
  @Validate({ params: IdParams, body: UserPatch, responses: { 200: User } })
  update(@Param("id") id: string, @Body() body: { name: string }) {
    return { id, name: body.name };
  }
}

@Module({ controllers: [PlainUsersController] })
class PlainModule {}

/** The router app: the same routes, with `validate()` and `.describe()`. */
function routerApp(): BunRouter {
  const app = new BunRouter();
  app
    .get(
      "/api/users/:id",
      validate(
        { params: IdParams },
        { responses: { 200: User, 404: Problem } },
      ),
      (_req, res) => res.json({ id: "1", name: "Ada" }),
    )
    .describe({
      tags: ["users"],
      summary: "Read one user",
      description: "By id.",
      operationId: "getUser",
      errors: ["NOT_FOUND"],
      cache: { tags: ["user:{id}"] },
    });
  app
    .patch(
      "/api/users/:id",
      validate(
        { params: IdParams, body: UserPatch },
        { responses: { 200: User } },
      ),
      (_req, res) => res.json({ id: "1", name: "Ada" }),
    )
    .describe({
      tags: ["users", "writes"],
      cache: { invalidates: ["user:{id}", "users"] },
      deprecated: true,
      extensions: { "x-team": "core" },
    });
  app
    .post(
      "/api/users",
      validate({ body: UserPatch }, { responses: { 201: User } }),
      (_req, res) => res.json({ id: "1", name: "Ada" }),
    )
    .describe({ hidden: true });
  app
    .get("/api/health", (_req, res) => res.json({}))
    .describe({ hidden: true });
  return app;
}

const apps: INestApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

/** Boots `module` on a fresh adapter under the `api` prefix, and documents it. */
async function documentOf(module: object): Promise<OpenApiDocument> {
  const adapter = new BunHttpAdapter(0);
  const app = await NestFactory.create(module as never, adapter, {
    logger: false,
  });
  apps.push(app);
  app.setGlobalPrefix("api");
  await app.init();
  return generateOpenApi(adapter.instance, DOC).document;
}

describe("@Describe: a controller's document equals a router app's", () => {
  it("summary, description, tags, operationId, deprecated, errors, cache, extensions and hidden, under a global prefix", async () => {
    const nest = await documentOf(AppModule);
    const router = generateOpenApi(routerApp(), DOC).document;
    expect(nest).toEqual(router);
    // What the equality rests on, spelled out once.
    const paths = nest.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(Object.keys(paths)).toEqual(["/api/users/{id}"]);
    expect(paths["/api/users/{id}"]?.get).toMatchObject({
      summary: "Read one user",
      operationId: "getUser",
      tags: ["users"],
      "x-bun-errors": ["NOT_FOUND"],
      "x-bun-cache": { tags: ["user:{id}"] },
    });
    expect(paths["/api/users/{id}"]?.patch).toMatchObject({
      tags: ["users", "writes"],
      deprecated: true,
      "x-team": "core",
      "x-bun-cache": { invalidates: ["user:{id}", "users"] },
    });
  });

  it("control: the same controllers without @Describe document none of it", async () => {
    const nest = await documentOf(PlainModule);
    const router = generateOpenApi(routerApp(), DOC).document;
    expect(nest).not.toEqual(router);
    const get = (
      nest.paths as Record<string, Record<string, Record<string, unknown>>>
    )["/api/users/{id}"]?.get;
    expect(get?.summary).toBeUndefined();
    expect(get?.["x-bun-errors"]).toBeUndefined();
    expect(get?.["x-bun-cache"]).toBeUndefined();
  });
});

describe("@Describe on a controller, and stacking", () => {
  /** The doc `method` carries. */
  const docOf = (prototype: object, name: string) =>
    Reflect.getMetadata(
      "bun:describe",
      Object.getOwnPropertyDescriptor(prototype, name)?.value as object,
    ) as Record<string, unknown> | undefined;

  it("merges under each route method the class declares: the method's keys win, tags are combined", () => {
    @Describe({ tags: ["a"], summary: "class", deprecated: true })
    @Describe({ tags: ["base"], description: "lower" })
    class C {
      @Get()
      @Describe({ summary: "method", tags: ["m"] })
      list() {}

      @Get("x")
      plain() {}

      /** Not a route: left alone. */
      helper() {}
    }
    expect(docOf(C.prototype, "list")).toEqual({
      tags: ["a", "m"],
      summary: "method",
      deprecated: true,
      description: "lower",
    });
    expect(docOf(C.prototype, "plain")).toEqual({
      tags: ["a"],
      summary: "class",
      deprecated: true,
      description: "lower",
    });
    expect(docOf(C.prototype, "helper")).toBeUndefined();
  });

  it("leaves an inherited route method alone (its function is the base's)", () => {
    class Base {
      @Get()
      list() {}
    }
    @Describe({ tags: ["child"] })
    class Child extends Base {
      @Get("own")
      own() {}
    }
    expect(docOf(Child.prototype, "own")).toEqual({ tags: ["child"] });
    expect(docOf(Base.prototype, "list")).toBeUndefined();
  });

  it("refuses what is not a doc, and what is not a method", () => {
    expect(() => Describe(null as never)).toThrow(TypeError);
    expect(() => Describe(["x"] as never)).toThrow(TypeError);
    expect(() =>
      (Describe({ summary: "s" }) as MethodDecorator)({}, "field", {
        get: () => 1,
      }),
    ).toThrow(/only methods are routes/);
  });
});
