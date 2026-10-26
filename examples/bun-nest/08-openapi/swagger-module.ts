/**
 * `@nestjs/swagger` on `BunHttpAdapter`, asserted: a DTO-class `@Body()`,
 * `@ApiResponse()` and `DocumentBuilder` → `SwaggerModule.createDocument` →
 * `SwaggerModule.setup("api", …)`, then the JSON document, the UI page and
 * one of the UI's own static assets fetched over a real socket, with a
 * mutating route answering beside the docs.
 *
 * ```bash
 * bun 08-openapi/swagger-module.ts
 * ```
 *
 * This is the verified recipe of api-docs-generation phase (d) (plan
 * `docs/plans/api-docs-generation` §8.6); `packages/bun-nest`'s
 * `__tests__/swagger.nest.test.ts` holds the full matrix, including the
 * differential against `@nestjs/platform-express`.
 *
 * Worth knowing:
 *
 * - `@nestjs/swagger` is a **devDependency of this examples package** (it is
 *   nobody's peer: nothing in `@kingsleyweb/bun-nest` imports it). Where it
 *   is not installed this example prints a line starting `skipped:` and
 *   exits 0. It resolves from the repo's root `node_modules`, like every
 *   other package here — there is no install step in this folder.
 * - The scanner reads **Nest metadata only**: a route registered directly on
 *   the adapter (`adapter.get("/direct", …)`) is served but never appears in
 *   the document, and the docs routes themselves are registered the same
 *   way, so they are not in it either.
 * - `SwaggerModule.setup` serves its own bundled `swagger-ui-dist` copy from
 *   `node_modules` through `useStaticAssets` — nothing is fetched from a
 *   CDN, and nothing is shared with bun-common's `docsRouter`, which serves
 *   its own pinned viewer from a CDN. The two never share a route or an
 *   origin.
 * - Decorator metadata comes from the **working directory's** `tsconfig.json`
 *   (oven-sh/bun#28605): run this from `examples/bun-nest`.
 * - What `setGlobalPrefix` does to each half, and what `@Render` needs, are
 *   in the package README's
 *   [OpenAPI with `@nestjs/swagger`](../../packages/bun-nest/README.md#openapi-with-nestjsswagger).
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import process from "node:process";
import { Body, Controller, Get, Module, Param, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, summary } from "../shared/check";
import "reflect-metadata";

/** Where `@nestjs/swagger` is absent, skip visibly rather than fail. */
const SWAGGER_INSTALLED = (() => {
  try {
    Bun.resolveSync("@nestjs/swagger", import.meta.dir);
    return true;
  } catch {
    return false;
  }
})();

if (!SWAGGER_INSTALLED) {
  console.log(
    "skipped: @nestjs/swagger is not installed (a devDependency of examples/bun-nest)",
  );
  process.exit(0);
}

const { ApiProperty, ApiResponse, DocumentBuilder, SwaggerModule } =
  await import("@nestjs/swagger");

class CreateUserDto {
  @ApiProperty() name!: string;
  @ApiProperty() age!: number;
}

class UserDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiProperty() age!: number;
}

@Controller("users")
class UsersController {
  @Post()
  @ApiResponse({ status: 201, type: UserDto })
  create(@Body() body: CreateUserDto): UserDto {
    return { id: 1, ...body };
  }

  @Get(":id")
  @ApiResponse({ status: 200, type: UserDto })
  byId(@Param("id") id: string): UserDto {
    return { id: Number(id), name: "ada", age: 36 };
  }
}

@Module({ controllers: [UsersController] })
class AppModule {}

const adapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, adapter, { logger: false });

// Served, but invisible to the scanner: it reads Nest metadata only.
adapter.get("/direct", (_req, res) => res.json({ direct: true }));

const config = new DocumentBuilder()
  .setTitle("Users API")
  .setDescription("bun-nest + @nestjs/swagger")
  .setVersion("1.0")
  .build();
const document = SwaggerModule.createDocument(app, config);
SwaggerModule.setup("api", app, document);

await app.listen(0);
const base = `http://127.0.0.1:${adapter.listeningPort}`;

try {
  // The JSON document, with the controller's paths and the DTO components.
  const json = await fetch(`${base}/api-json`);
  checkEqual("GET /api-json status", json.status, 200);
  const served = (await json.json()) as Record<string, any>;
  checkEqual("document title", served.info.title, "Users API");
  checkEqual("document paths", Object.keys(served.paths).sort(), [
    "/users",
    "/users/{id}",
  ]);
  checkEqual("DTO components", Object.keys(served.components.schemas).sort(), [
    "CreateUserDto",
    "UserDto",
  ]);
  check(
    "POST /users documents its DTO",
    served.paths["/users"].post.requestBody.content["application/json"].schema
      .$ref === "#/components/schemas/CreateUserDto",
    served.paths["/users"].post,
  );

  // The UI page, with and without the trailing slash.
  for (const path of ["/api", "/api/"]) {
    const ui = await fetch(`${base}${path}`);
    checkEqual(`GET ${path} status`, ui.status, 200);
    check(
      `GET ${path} is the UI`,
      (ui.headers.get("content-type") ?? "").includes("text/html") &&
        (await ui.text()).includes('id="swagger-ui"'),
    );
  }

  // One of the UI's own static assets, served from the bundled
  // swagger-ui-dist through `useStaticAssets`.
  const bundle = await fetch(`${base}/api/swagger-ui-bundle.js`);
  checkEqual("GET /api/swagger-ui-bundle.js status", bundle.status, 200);
  check(
    "the bundle is JavaScript, served whole",
    (bundle.headers.get("content-type") ?? "").includes("javascript") &&
      (await bundle.text()).length > 1_000_000,
  );

  // A mutating route answers beside the docs.
  const created = await fetch(`${base}/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "ada", age: 36 }),
  });
  checkEqual("POST /users status", created.status, 201);
  checkEqual("POST /users body", await created.json(), {
    id: 1,
    name: "ada",
    age: 36,
  });

  // The controls: the adapter route is served but undocumented, and a
  // changed `DocumentBuilder` title changes the document (so the title
  // check above is not vacuous).
  checkEqual("GET /direct status", (await fetch(`${base}/direct`)).status, 200);
  check(
    "the adapter route is not in the document",
    !("/direct" in served.paths) && !("/api-json" in served.paths),
    Object.keys(served.paths),
  );
  const changed = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle("Changed title").setVersion("1.0").build(),
  );
  checkEqual(
    "a changed title is visible",
    (changed.info as { title: string }).title,
    "Changed title",
  );
} finally {
  await app.close();
}

summary();
