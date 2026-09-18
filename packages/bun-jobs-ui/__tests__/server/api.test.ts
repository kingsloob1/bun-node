/**
 * The UI beside a real `createJobsApi` (memory driver) on one bun-common
 * `BunHttpAdapter`: both answer, and the configuration the page carries is
 * what the API actually routes.
 */
import type { JobsApi } from "@kingsleyweb/bun-jobs";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterEach, describe, expect, it } from "bun:test";
import { fetchShell, fixtureUi } from "./helpers";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A jobs context and an API over it, closed after the test. */
function realApi(basePath: string): JobsApi {
  const jobs = new BunJobs({
    namespace: `ui-api-${crypto.randomUUID().slice(0, 8)}`,
    driver: new MemoryDriver(),
    publishEvents: true,
    logger: noopLogger,
  });
  cleanups.push(() => jobs.close());
  const api = createJobsApi({
    jobs,
    basePath,
    mode: "jobs",
    authorize: () => true,
    logger: noopLogger,
  });
  cleanups.push(() => api.close());
  return api;
}

describe("beside createJobsApi on a BunHttpAdapter", () => {
  it("both answer, and the injected config matches the API", async () => {
    const api = realApi("/admin/jobs-api");
    const ui = fixtureUi({ api, basePath: "/admin/jobs" });
    const app = new BunHttpAdapter();
    cleanups.push(() => app.close());
    app.use(api.basePath, api.router);
    app.use(ui.basePath, ui.router);

    // The API.
    const meta = await app.fetch("/admin/jobs-api/meta");
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({ protocol: 1 });

    // The UI, and its deep links.
    for (const path of [
      "/admin/jobs",
      "/admin/jobs/",
      "/admin/jobs/queues/mail",
    ]) {
      const { response, shell } = await fetchShell(app, path);
      expect(response.status).toBe(200);
      expect(shell.config.apiBase).toBe("/admin/jobs-api");
    }
    const { shell } = await fetchShell(app, "/admin/jobs");
    expect((await app.fetch(shell.script.src)).status).toBe(200);
    expect((await app.fetch(shell.styles[0]!.href)).status).toBe(200);

    // The config is what the API routes, not a guess.
    expect(api.websocket).toBeDefined();
    expect(shell.config.websocket).toEqual({
      path: api.websocket!.path,
      port: null,
    });
    expect(shell.config.websocket!.path).toBe("/admin/jobs-api/ws");
    expect(shell.config.docs).not.toBeNull();
    const openapi = await app.fetch(shell.config.docs!.openapi);
    expect(openapi.status).toBe(200);
    expect(await openapi.json()).toMatchObject({ openapi: "3.1.0" });
    expect(shell.config.docs!.asyncapi).toBeString();
    const asyncapi = await app.fetch(shell.config.docs!.asyncapi!);
    expect(asyncapi.status).toBe(200);
    expect(await asyncapi.json()).toMatchObject({ asyncapi: "3.0.0" });

    // Neither swallows the other, nor the host's 404.
    expect((await app.fetch("/admin/jobs-api/nope")).status).toBe(404);
    expect(
      (await app.fetch("/admin/jobs-api/nope")).headers.get("content-type"),
    ).toBe("application/problem+json");
    expect((await app.fetch("/elsewhere")).status).toBe(404);
  });

  it("reports docs as null when the API serves none", async () => {
    const jobs = new BunJobs({
      namespace: `ui-api-${crypto.randomUUID().slice(0, 8)}`,
      driver: new MemoryDriver(),
      logger: noopLogger,
    });
    cleanups.push(() => jobs.close());
    const api = createJobsApi({
      jobs,
      basePath: "/jobs-api",
      mode: "jobs",
      authorize: () => true,
      docs: false,
      websocket: false,
      logger: noopLogger,
    });
    cleanups.push(() => api.close());
    const ui = fixtureUi({ api });
    expect(ui.config.docs).toBeNull();
    expect(ui.config.websocket).toBeNull();
  });

  it("leaves requests under the API's path to the API, whichever is mounted first", async () => {
    // The API nested under the UI, and the UI mounted first: without the
    // guard, the UI's catch-all would answer the API's GETs with HTML.
    const api = realApi("/admin/api");
    const ui = fixtureUi({ api, basePath: "/admin" });
    const app = new BunHttpAdapter();
    cleanups.push(() => app.close());
    app.use(ui.basePath, ui.router);
    app.use(api.basePath, api.router);

    const meta = await app.fetch("/admin/api/meta");
    expect(meta.status).toBe(200);
    expect(meta.headers.get("content-type")).toContain("application/json");
    const missing = await app.fetch("/admin/api/nope");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    // And the UI still has everything else under it.
    expect((await app.fetch("/admin/queues")).headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
  });

  it("serves through a real socket too", async () => {
    const api = realApi("/jobs-api");
    const ui = fixtureUi({ api });
    const app = new BunHttpAdapter();
    app.use(api.basePath, api.router);
    app.use(ui.basePath, ui.router);
    const server = await app.listen(0);
    cleanups.push(() => app.close());
    const origin = `http://localhost:${server.port}`;

    const page = await fetch(`${origin}/jobs/queues`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const src = /<script type="module" src="([^"]+)"/.exec(html)![1]!;
    const asset = await fetch(`${origin}${src}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    const head = await fetch(`${origin}/jobs`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await fetch(`${origin}/jobs-api/meta`)).status).toBe(200);
  });
});

describe("api.info (a newer API's read-only summary)", () => {
  /** A real API with an `info` of the upcoming `JobsApiInfo` shape grafted on. */
  function withInfo(info: unknown): JobsApi {
    const api = realApi("/jobs-api");
    return Object.assign(Object.create(api) as JobsApi, {
      basePath: api.basePath,
      routes: api.routes,
      websocket: api.websocket,
      info,
    });
  }

  it("is preferred for the CSRF header, the socket (with its port) and the docs", () => {
    const api = withInfo({
      basePath: "/jobs-api",
      namespace: "ns",
      mode: "jobs",
      readOnly: false,
      csrf: { header: "x-bun-jobs-csrf", requireJson: true },
      docs: { openapi: "/jobs-api/spec.json" },
      websocket: { path: "/jobs-api/live", port: 4123 },
    });
    const ui = fixtureUi({ api });
    expect(ui.config.csrfHeader).toBe("x-bun-jobs-csrf");
    expect(ui.config.websocket).toEqual({ path: "/jobs-api/live", port: 4123 });
    expect(ui.config.docs).toEqual({
      openapi: "/jobs-api/spec.json",
      asyncapi: null,
    });
  });

  it("reports none when info says none", () => {
    const api = withInfo({
      csrf: { header: null, requireJson: false },
      docs: null,
      websocket: null,
    });
    const ui = fixtureUi({ api });
    expect(ui.config.csrfHeader).toBeNull();
    expect(ui.config.websocket).toBeNull();
    expect(ui.config.docs).toBeNull();
  });

  it("an explicit csrfHeader still wins over info", () => {
    const api = withInfo({ csrf: { header: "x-from-api", requireJson: true } });
    expect(fixtureUi({ api, csrfHeader: "x-mine" }).config.csrfHeader).toBe(
      "x-mine",
    );
    expect(fixtureUi({ api, csrfHeader: false }).config.csrfHeader).toBeNull();
  });

  it("falls back to routes and api.websocket for fields info lacks", () => {
    const api = withInfo({ csrf: { header: "x-h", requireJson: true } });
    const ui = fixtureUi({ api });
    expect(ui.config.websocket?.path).toBe("/jobs-api/ws");
    expect(ui.config.docs?.openapi).toBe("/jobs-api/openapi.json");
  });
});
