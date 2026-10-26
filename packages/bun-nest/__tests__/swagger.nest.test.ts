/**
 * api-docs-generation phase (d) (plan `docs/plans/api-docs-generation/` §8.6,
 * risk 17(a)–(c)): `@nestjs/swagger` end-to-end against `BunHttpAdapter`.
 * A real Nest application with a DTO-class `@Body()`, `@ApiResponse()` and
 * `DocumentBuilder` → `createDocument` → `SwaggerModule.setup("api", …)` is
 * probed over a real socket (`app.listen(0)`): the JSON document, the UI page
 * with and without the trailing slash, the UI's own bundle from
 * `useStaticAssets`, and a mutating route beside the docs.
 *
 * The control is differential: the same module booted on
 * `@nestjs/platform-express` must produce a deep-equal `createDocument`
 * output and answer the same probes. The gap probes of §8.6 are assertions
 * here: what `setGlobalPrefix` does to the document and to the docs routes
 * (with and without `useGlobalPrefix: true`), whether bun-common's
 * `listRoutes`/`generateOpenApi` see the prefixed controller paths, the
 * scanner in an app also mounting the jobs API module and a WebSocket
 * gateway, and what `@Render("index")` does with no engine registered.
 *
 * `@nestjs/swagger` is a devDependency; where it is absent the suite skips
 * visibly rather than failing. It is loaded inside the describe callback —
 * not at module scope, and with no top-level `await` — because a top-level
 * `await` perturbs decorator metadata across files (the gateway suites'
 * rule), and a static import would fail the file instead of skipping it.
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type { INestApplication } from "@nestjs/common";
import type { OpenAPIObject } from "@nestjs/swagger";
import type { BunJobs } from "@kingsleyweb/bun-jobs";
import { listRoutes, ConfigError } from "@kingsleyweb/bun-common";
import { generateOpenApi } from "@kingsleyweb/bun-common/lib/docs";
import { MemoryDriver, BunJobs as Jobs } from "@kingsleyweb/bun-jobs";
import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  Post,
  Render,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunWebSocketAdapter } from "../lib/BunWebSocketAdapter";
import { BunJobsApiModule } from "../lib/jobs/index";
import "reflect-metadata";

/** Whether `@nestjs/swagger` is installed, so the suite can skip visibly. */
const SWAGGER_PRESENT = (() => {
  try {
    Bun.resolveSync("@nestjs/swagger", import.meta.dir);
    return true;
  } catch {
    return false;
  }
})();

/** A booted application under test: its base URL and how to close it. */
interface Booted {
  app: INestApplication;
  base: string;
  /** The adapter, on the bun side. */
  adapter?: BunHttpAdapter;
}

/**
 * Boots `module` on `BunHttpAdapter` or `ExpressAdapter`, listening on port 0.
 * `beforeListen` runs between `create` and `listen` — where `createDocument`
 * and `SwaggerModule.setup` belong: routes registered after Nest's own go
 * unheard on the express side (its not-found handler is mounted first).
 */
async function boot(
  side: "bun" | "express",
  module: new () => object,
  beforeListen?: (app: INestApplication, adapter?: BunHttpAdapter) => void,
): Promise<Booted> {
  const adapter = side === "bun" ? new BunHttpAdapter() : new ExpressAdapter();
  const app = await NestFactory.create(module, adapter, { logger: false });
  beforeListen?.(app, side === "bun" ? (adapter as BunHttpAdapter) : undefined);
  await app.listen(0, "127.0.0.1");
  const port =
    side === "bun"
      ? Number((adapter as BunHttpAdapter).listeningPort)
      : (app.getHttpServer() as { address: () => { port: number } }).address()
          .port;
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    ...(side === "bun" ? { adapter: adapter as BunHttpAdapter } : {}),
  };
}

/** The status and content type of a response, compared across the two adapters. */
async function probe(response: Response) {
  return {
    status: response.status,
    type: response.headers.get("content-type")?.split(";")[0],
    body: await response.text(),
  };
}

describe.skipIf(!SWAGGER_PRESENT)(
  "bun-nest: @nestjs/swagger end-to-end (api-docs-generation phase d)",
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- bun:test awaits an async describe callback
  async () => {
    // `describe.skipIf` skips the cases, not the callback: return before the
    // dynamic import where the package is absent, so the file skips instead
    // of failing.
    if (!SWAGGER_PRESENT) {
      console.log("skipped: @nestjs/swagger is not installed");
      return;
    }
    const { ApiProperty, ApiResponse, DocumentBuilder, SwaggerModule } =
      await import("@nestjs/swagger");

    /* ---- the application ------------------------------------------- */

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

    @Controller()
    class PagesController {
      @Get("page")
      @Render("index")
      page() {
        return {};
      }
    }

    @Module({ controllers: [UsersController, PagesController] })
    class AppModule {}

    const config = new DocumentBuilder()
      .setTitle("Swagger probe API")
      .setDescription("phase (d)")
      .setVersion("1.0")
      .build();

    /* ---- the differential: one module, both adapters --------------- */

    describe("against platform-express", () => {
      let bun: Booted & { adapter: BunHttpAdapter };
      let express: Booted;
      let bunDocument: Record<string, any>;
      let expressDocument: Record<string, any>;

      beforeAll(async () => {
        bun = (await boot("bun", AppModule, (app, adapter) => {
          // An adapter-registered route: served, but invisible to the scanner.
          adapter!.get("/direct", (_req, res) => res.json({ direct: true }));
          bunDocument = SwaggerModule.createDocument(app, config);
          SwaggerModule.setup("api", app, bunDocument as OpenAPIObject);
        })) as typeof bun;

        express = await boot("express", AppModule, (app) => {
          expressDocument = SwaggerModule.createDocument(app, config);
          SwaggerModule.setup("api", app, expressDocument as OpenAPIObject);
        });
      });

      afterAll(async () => {
        await bun?.app.close();
        await express?.app.close();
      });

      it("scans a deep-equal document on both adapters", () => {
        expect(bunDocument).toEqual(expressDocument);
        expect(Object.keys(bunDocument.paths).sort()).toEqual([
          "/page",
          "/users",
          "/users/{id}",
        ]);
        const post = bunDocument.paths["/users"].post;
        expect(post.requestBody.content["application/json"].schema.$ref).toBe(
          "#/components/schemas/CreateUserDto",
        );
        expect(
          post.responses["201"].content["application/json"].schema.$ref,
        ).toBe("#/components/schemas/UserDto");
        expect(Object.keys(bunDocument.components.schemas).sort()).toEqual([
          "CreateUserDto",
          "UserDto",
        ]);
      });

      it("answers GET /api-json with the document, byte-equal on both", async () => {
        const b = await probe(await fetch(`${bun.base}/api-json`));
        const e = await probe(await fetch(`${express.base}/api-json`));
        expect(b.status).toBe(200);
        expect(b.type).toBe("application/json");
        expect(JSON.parse(b.body).info.title).toBe("Swagger probe API");
        expect(b).toEqual(e);
      });

      it("answers GET /api and /api/ with the UI page", async () => {
        for (const path of ["/api", "/api/", "/api/index.html"]) {
          const b = await probe(await fetch(`${bun.base}${path}`));
          const e = await probe(await fetch(`${express.base}${path}`));
          expect(b.status).toBe(200);
          expect(b.type).toBe("text/html");
          expect(b.body).toContain('id="swagger-ui"');
          expect(b).toEqual(e);
        }
      });

      it("serves the UI's own bundle from useStaticAssets", async () => {
        for (const path of [
          "/api/swagger-ui-bundle.js",
          "/api/swagger-ui-init.js",
        ]) {
          const b = await probe(await fetch(`${bun.base}${path}`));
          const e = await probe(await fetch(`${express.base}${path}`));
          expect(b.status).toBe(200);
          expect(b.type).toContain("javascript");
          expect(b.body.length).toBeGreaterThan(100);
          expect(b).toEqual(e);
        }
      });

      it("answers the LICENSE route's thrown NotFoundException alike", async () => {
        // swagger-module.js registers a `${finalPath}/LICENSE` route whose
        // handler throws — through a raw adapter route, not Nest's pipeline.
        // Both adapters answer a JSON 404; the wording is each side's own.
        const b = await probe(await fetch(`${bun.base}/api/LICENSE`));
        const e = await probe(await fetch(`${express.base}/api/LICENSE`));
        expect(b.status).toBe(404);
        expect(e.status).toBe(404);
        expect(JSON.parse(b.body)).toEqual({
          message: "Not Found",
          statusCode: 404,
        });
        expect(JSON.parse(e.body).statusCode).toBe(404);
      });

      it("runs a mutating route beside the docs", async () => {
        const init = {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "ada", age: 36 }),
        };
        const b = await probe(await fetch(`${bun.base}/users`, init));
        const e = await probe(await fetch(`${express.base}/users`, init));
        expect(b.status).toBe(201);
        expect(JSON.parse(b.body)).toEqual({ id: 1, name: "ada", age: 36 });
        expect(b).toEqual(e);

        const byId = await fetch(`${bun.base}/users/7`);
        expect(byId.status).toBe(200);
        expect(await byId.json()).toEqual({ id: 7, name: "ada", age: 36 });
      });

      it("answers @Render without an engine as platform-express does: a 500", async () => {
        // §8.6's note predates the view-engine subsystem: `render` is no
        // longer a `Bun.file` send. With no engine registered and no
        // extension on the view, both adapters answer Nest's 500.
        const b = await probe(await fetch(`${bun.base}/page`));
        const e = await probe(await fetch(`${express.base}/page`));
        expect(b.status).toBe(500);
        expect(e.status).toBe(500);
        expect(JSON.parse(b.body)).toEqual({
          statusCode: 500,
          message: "Internal server error",
        });
      });

      /* ---- negative controls ---------------------------------------- */

      it("keeps an adapter-registered route out of the document", async () => {
        const direct = await fetch(`${bun.base}/direct`);
        expect(direct.status).toBe(200);
        expect(await direct.json()).toEqual({ direct: true });
        // …but the scanner reads Nest metadata only: no /direct, and none of
        // swagger's own adapter routes, in `paths`.
        expect(Object.keys(bunDocument.paths)).not.toContain("/direct");
        expect(Object.keys(bunDocument.paths)).not.toContain("/api-json");
      });

      it("shows a changed DocumentBuilder title in the document", () => {
        // The vacuity control for the title assertions above: a different
        // config produces a different served document.
        const other = SwaggerModule.createDocument(
          bun.app,
          new DocumentBuilder()
            .setTitle("Changed title")
            .setVersion("1.0")
            .build(),
        );
        expect(other.info.title).toBe("Changed title");
        expect(other.info.title).not.toBe(bunDocument.info.title);
      });
    });

    /* ---- §8.6's gap probes, as assertions --------------------------- */

    describe("setGlobalPrefix (risk 17b)", () => {
      @Module({ controllers: [UsersController] })
      class PrefixedModule {}

      it("documents prefixed paths but serves the docs unprefixed by default", async () => {
        let document!: Record<string, any>;
        const app = await boot("bun", PrefixedModule, (nestApp) => {
          nestApp.setGlobalPrefix("v1");
          document = SwaggerModule.createDocument(nestApp, config);
          SwaggerModule.setup("api", nestApp, document as OpenAPIObject);
        });
        try {
          // The scanner applies the global prefix to the controller paths…
          expect(Object.keys(document.paths).sort()).toEqual([
            "/v1/users",
            "/v1/users/{id}",
          ]);
          // …but setup's own routes go straight to the adapter, so the docs
          // sit at /api, not /v1/api.
          const json = await fetch(`${app.base}/api-json`);
          expect(json.status).toBe(200);
          expect(
            ((await json.json()) as { paths: object }).paths,
          ).toHaveProperty(["/v1/users/{id}"]);
          expect((await fetch(`${app.base}/v1/api-json`)).status).toBe(404);
          expect((await fetch(`${app.base}/api`)).status).toBe(200);
          expect((await fetch(`${app.base}/v1/api`)).status).toBe(404);
          // The controller itself moved under the prefix.
          expect((await fetch(`${app.base}/v1/users/3`)).status).toBe(200);
          expect((await fetch(`${app.base}/users/3`)).status).toBe(404);

          // Risk 17(b), answered: Nest bakes the prefix into the routes it
          // registers, so bun-common's `listRoutes` sees `/v1/users/:id`…
          const keys = listRoutes(app.adapter!.getInstance()).map(
            (route) => route.key,
          );
          expect(keys).toContain("POST /v1/users");
          expect(keys).toContain("GET /v1/users/:id");

          // …and `generateOpenApi` over the adapter's router documents the
          // prefixed controller paths — once swagger's own routes are out of
          // the way: its doubled docs routes (`GET /api`, `GET /api/` and the
          // static mount's `GET /api`) share the default operation id
          // `getApi`, which is a ConfigError, never a silent rename.
          const router = app.adapter!.getInstance();
          expect(() =>
            generateOpenApi(router, { title: "t", version: "1" }),
          ).toThrow(ConfigError);
          expect(() =>
            generateOpenApi(router, { title: "t", version: "1" }),
          ).toThrow(/operation id "getApi"/);
          const generated = generateOpenApi(router, {
            title: "t",
            version: "1",
            filter: (route) => !route.path.startsWith("/api"),
          });
          expect(Object.keys(generated.document.paths ?? {}).sort()).toEqual([
            "/v1/users",
            "/v1/users/{id}",
          ]);
          // No `.describe()` metadata on Nest-registered routes: each warns.
          expect(generated.warnings).toHaveLength(2);
        } finally {
          await app.app.close();
        }
      });

      it("serves the docs under the prefix with useGlobalPrefix: true", async () => {
        const app = await boot("bun", PrefixedModule, (nestApp) => {
          nestApp.setGlobalPrefix("v1");
          const document = SwaggerModule.createDocument(nestApp, config);
          SwaggerModule.setup("api", nestApp, document as OpenAPIObject, {
            useGlobalPrefix: true,
          });
        });
        try {
          const json = await fetch(`${app.base}/v1/api-json`);
          expect(json.status).toBe(200);
          expect(
            ((await json.json()) as { paths: object }).paths,
          ).toHaveProperty(["/v1/users"]);
          expect((await fetch(`${app.base}/api-json`)).status).toBe(404);
          for (const path of ["/v1/api", "/v1/api/"]) {
            const ui = await fetch(`${app.base}${path}`);
            expect(ui.status).toBe(200);
            expect(ui.headers.get("content-type")).toContain("text/html");
          }
          const bundle = await fetch(`${app.base}/v1/api/swagger-ui-bundle.js`);
          expect(bundle.status).toBe(200);
          expect(bundle.headers.get("content-type")).toContain("javascript");
        } finally {
          await app.app.close();
        }
      });
    });

    describe("a mixed app (risk 17c): jobs API module and a gateway beside the scanner", () => {
      @WebSocketGateway()
      class ProbeGateway {
        @SubscribeMessage("ping")
        ping() {
          return { event: "pong", data: 1 };
        }
      }

      it("scans only the controllers, with jobs and WebSocket modules mounted", async () => {
        const jobs: BunJobs = new Jobs({
          namespace: `swagger-mixed-${Math.random().toString(36).slice(2, 8)}`,
          driver: new MemoryDriver(),
          publishEvents: true,
        });

        @Module({
          imports: [
            BunJobsApiModule.forRoot({
              jobs,
              basePath: "/admin/jobs",
              authorize: () => true,
            }),
          ],
          controllers: [UsersController],
          providers: [ProbeGateway],
        })
        class MixedModule {}

        const adapter = new BunHttpAdapter();
        const app = await NestFactory.create(MixedModule, adapter, {
          logger: false,
        });
        try {
          app.useWebSocketAdapter(
            new BunWebSocketAdapter({ httpAdapter: adapter }),
          );
          const document = SwaggerModule.createDocument(app, config);
          SwaggerModule.setup("api", app, document as OpenAPIObject);
          await app.listen(0, "127.0.0.1");
          const base = `http://127.0.0.1:${adapter.listeningPort}`;

          // The scanner reads Nest's container, which the adapter does not
          // influence: the jobs API's adapter-mounted routes and the
          // gateway's messages produce no paths.
          expect(Object.keys(document.paths).sort()).toEqual([
            "/users",
            "/users/{id}",
          ]);

          // …while everything it ignored still works.
          const meta = await fetch(`${base}/admin/jobs/meta`);
          expect(meta.status).toBe(200);
          expect(await meta.json()).toMatchObject({ protocol: 1 });
          const json = await fetch(`${base}/api-json`);
          expect(json.status).toBe(200);
          const created = await fetch(`${base}/users`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "ada", age: 36 }),
          });
          expect(created.status).toBe(201);
        } finally {
          await app.close();
          await jobs.close();
        }
      });
    });
  },
);
