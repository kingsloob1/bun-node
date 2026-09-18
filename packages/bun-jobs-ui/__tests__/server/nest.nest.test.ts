/**
 * The UI mounted on a NestJS app through bun-nest's `BunHttpAdapter.use()`,
 * beside the API — the documented Nest recipe (no module). `reflect-metadata`
 * is imported last, as bun-nest's own suites do.
 */
import type { INestApplication } from "@nestjs/common";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "bun:test";
import { fetchShell, fixtureUi } from "./helpers";
import "reflect-metadata";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("on bun-nest's BunHttpAdapter", () => {
  it("serves the shell and assets beside the API and a controller", async () => {
    @Controller("hello")
    class HelloController {
      @Get()
      hello() {
        return { hello: "nest" };
      }
    }

    @Module({ controllers: [HelloController] })
    class AppModule {}

    const jobs = new BunJobs({
      namespace: `ui-nest-${crypto.randomUUID().slice(0, 8)}`,
      driver: new MemoryDriver(),
      logger: noopLogger,
    });
    cleanups.push(() => jobs.close());
    const api = createJobsApi({
      jobs,
      basePath: "/admin/jobs-api",
      mode: "jobs",
      authorize: () => true,
      websocket: false,
      logger: noopLogger,
    });
    cleanups.push(() => api.close());
    const ui = fixtureUi({ api, basePath: "/admin/jobs" });

    const adapter = new BunHttpAdapter(30000);
    const app = (await NestFactory.create(AppModule, adapter as never, {
      logger: false,
    })) as INestApplication;
    cleanups.push(() => app.close());
    // bun-nest's `use()` is typed for handlers only, so a router needs the
    // same cast `BunJobsApiModule` uses; at runtime it mounts like bun-common's.
    adapter.use(api.basePath, api.router as never);
    adapter.use(ui.basePath, ui.router as never);
    await app.init();

    const { response, shell } = await fetchShell(adapter, "/admin/jobs/queues");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      `'nonce-${shell.configNonce}'`,
    );
    expect(shell.config.apiBase).toBe("/admin/jobs-api");

    const asset = await adapter.fetch(shell.script.src);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );

    expect((await adapter.fetch("/admin/jobs-api/meta")).status).toBe(200);
    expect(await (await adapter.fetch("/hello")).json()).toEqual({
      hello: "nest",
    });
    // Nest's own 404 for anything neither claims.
    expect((await adapter.fetch("/elsewhere")).status).toBe(404);
  });

  it("mounts without a cast through getInstance().use()", async () => {
    @Module({})
    class AppModule {}

    const ui = fixtureUi({ apiUrl: "/jobs-api" });
    const adapter = new BunHttpAdapter(30000);
    const app = (await NestFactory.create(AppModule, adapter as never, {
      logger: false,
    })) as INestApplication;
    cleanups.push(() => app.close());
    adapter.getInstance().use(ui.basePath, ui.router);
    await app.init();

    const { response, shell } = await fetchShell(adapter, "/jobs");
    expect(response.status).toBe(200);
    expect(shell.config.basePath).toBe("/jobs");
    expect((await adapter.fetch(shell.script.src)).status).toBe(200);
  });
});
