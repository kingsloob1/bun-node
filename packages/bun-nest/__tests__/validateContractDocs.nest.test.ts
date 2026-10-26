/**
 * A `@Validate`d Nest controller's contract reaches the document: bun-common's
 * `attachContract` also writes reflect metadata, which NestJS's
 * `RouterExplorer.copyMetadataToCallback` carries onto the route handler it
 * wraps the method in — so `listRoutes`/`generateOpenApi` see it. (The
 * bun-common half has its own unit test in `__tests__/contract/core.test.ts`.)
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type { INestApplication } from "@nestjs/common";
import { Body, Controller, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunHttpAdapter, Validate } from "../lib";
import { generateOpenApi } from "../../bun-common/lib/docs";
import { listRoutes } from "../../bun-common/lib/routeModel";
import "reflect-metadata";

/** A create-user payload. */
const NewUser = z.object({ name: z.string().min(1) });

@Controller("users")
class UsersController {
  @Post()
  @Validate({ body: NewUser })
  create(@Body() body: unknown) {
    return body;
  }
}

@Module({ controllers: [UsersController] })
class AppModule {}

describe("a @Validate'd controller's contract reaches the route model", () => {
  it("listRoutes and generateOpenApi see the controller's body schema", async () => {
    const adapter = new BunHttpAdapter(0);
    const app: INestApplication = await NestFactory.create(AppModule, adapter, {
      logger: false,
    });
    await app.init();

    const listed = listRoutes(adapter.instance).find(
      (route) => route.key === "POST /users",
    );
    expect(listed).toBeDefined();
    expect(
      listed?.contract?.entries.some(
        (row) => row.side === "inbound" && row.part === "body",
      ),
    ).toBe(true);

    const { document } = generateOpenApi(adapter.instance, {
      title: "t",
      version: "1",
    });
    const paths = document.paths as
      Record<string, Record<string, { requestBody?: unknown }>> | undefined;
    expect(paths?.["/users"]?.post?.requestBody).toBeDefined();

    await app.close();
  });
});
