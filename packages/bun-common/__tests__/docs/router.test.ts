/**
 * AD (c): {@link docsRouter} itself — the routes it registers (hidden from a
 * later `generateOpenApi`), `authorize` covering the JSON and the pages, the
 * document URL resolved per request from `req.baseUrl` under `use()`/`group()`/
 * `domain()` mounts, a thunk document re-read per request, and the
 * misconfiguration `ConfigError`s at construction.
 */
import { describe, expect, it } from "bun:test";
import { BunRouter } from "../../lib/BunRouter";
import { ConfigError } from "../../lib/errors";
import { generateOpenApi } from "../../lib/docs/openapi";
import { docsRouter } from "../../lib/docs/router";
import type { OpenApiDocument } from "../../lib/docs/types";

/** A minimal OpenAPI document. */
const OPENAPI_DOCUMENT: OpenApiDocument = {
  openapi: "3.1.2",
  info: { title: "The API", version: "1.0.0" },
  paths: {},
};

/** A minimal AsyncAPI 3.0.0 document. */
const ASYNCAPI_DOCUMENT = {
  asyncapi: "3.0.0",
  info: { title: "The Events API", version: "1.0.0" },
};

/** The viewer on, for both documents. */
const WITH_VIEWER = {
  viewer: { openapi: "scalar", asyncapi: "asyncapi" },
} as const;

describe("docsRouter", () => {
  it("serves the documents as JSON, at the default or the given paths", async () => {
    const root = new BunRouter();
    root.use(
      "/docs",
      docsRouter({ openapi: OPENAPI_DOCUMENT, asyncapi: ASYNCAPI_DOCUMENT }),
    );
    const openapi = await root.fetch("/docs/openapi.json");
    expect(openapi.status).toBe(200);
    expect(await openapi.json()).toEqual(OPENAPI_DOCUMENT as never);
    expect(await (await root.fetch("/docs/asyncapi.json")).json()).toEqual(
      ASYNCAPI_DOCUMENT as never,
    );

    const custom = new BunRouter();
    custom.use(
      "/docs",
      docsRouter({
        openapi: OPENAPI_DOCUMENT,
        openapiPath: "/spec.json",
        asyncapi: ASYNCAPI_DOCUMENT,
        asyncapiPath: "/events/spec.json",
      }),
    );
    expect((await custom.fetch("/docs/spec.json")).status).toBe(200);
    expect((await custom.fetch("/docs/events/spec.json")).status).toBe(200);
    expect((await custom.fetch("/docs/openapi.json")).status).toBe(404);
  });

  it("marks every route hidden, so generateOpenApi never documents the docs", async () => {
    const app = new BunRouter();
    app
      .get("/users", (_req, res) => res.json([]))
      .describe({
        summary: "List users",
        responses: { 200: { schema: { type: "array" } } },
      });
    app.use(
      "/docs",
      docsRouter({
        openapi: OPENAPI_DOCUMENT,
        asyncapi: ASYNCAPI_DOCUMENT,
        ...WITH_VIEWER,
      }),
    );

    const { document, warnings } = generateOpenApi(app, {
      title: "App",
      version: "1.0.0",
    });
    expect(warnings).toEqual([]);
    expect(Object.keys(document.paths as object)).toEqual(["/users"]);

    // The control: the docs routes really are routed (and would document
    // themselves without `hidden`).
    expect((await app.fetch("/docs/openapi.json")).status).toBe(200);
    expect((await app.fetch("/docs/asyncapi.json")).status).toBe(200);
    expect((await app.fetch("/docs/")).status).toBe(200);
    expect((await app.fetch("/docs/asyncapi")).status).toBe(200);
    const listedPaths = Object.keys(document.paths as object);
    for (const docs of [
      "/docs/openapi.json",
      "/docs/asyncapi.json",
      "/docs/",
      "/docs",
      "/docs/asyncapi",
    ]) {
      expect(listedPaths).not.toContain(docs);
    }
  });

  it("runs authorize before every route, covering the JSON and the pages", async () => {
    const calls: string[] = [];
    const denied = new BunRouter();
    denied.use(
      "/docs",
      docsRouter({
        openapi: OPENAPI_DOCUMENT,
        asyncapi: ASYNCAPI_DOCUMENT,
        ...WITH_VIEWER,
        authorize: (req, res) => {
          calls.push(req.path);
          res.status(403).json({ error: "denied" });
        },
      }),
    );
    for (const path of [
      "/docs/openapi.json",
      "/docs/asyncapi.json",
      "/docs/",
      "/docs/asyncapi",
    ]) {
      const response = await denied.fetch(path);
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toEqual({ error: "denied" });
    }
    expect(calls.sort()).toEqual(
      [
        "/docs/openapi.json",
        "/docs/asyncapi.json",
        "/docs/",
        "/docs/asyncapi",
      ].sort(),
    );

    // The control: an authorizer that says yes lets everything through.
    const allowed = new BunRouter();
    allowed.use(
      "/docs",
      docsRouter({
        openapi: OPENAPI_DOCUMENT,
        asyncapi: ASYNCAPI_DOCUMENT,
        ...WITH_VIEWER,
        authorize: (_req, _res, next) => next(),
      }),
    );
    expect((await allowed.fetch("/docs/openapi.json")).status).toBe(200);
    expect((await allowed.fetch("/docs/")).status).toBe(200);
  });

  it("points the pages at their document under any mount (req.baseUrl)", async () => {
    /** The document URL a page points at. */
    const documentUrlOf = (html: string): string =>
      html.match(/url: "(.*?)",/)![1].replaceAll("\\/", "/");

    // use()
    const used = new BunRouter();
    used.use(
      "/docs",
      docsRouter({
        openapi: OPENAPI_DOCUMENT,
        asyncapi: ASYNCAPI_DOCUMENT,
        ...WITH_VIEWER,
      }),
    );
    expect(documentUrlOf(await (await used.fetch("/docs/")).text())).toBe(
      "/docs/openapi.json",
    );
    expect(
      documentUrlOf(await (await used.fetch("/docs/asyncapi")).text()),
    ).toBe("/docs/asyncapi.json");
    // The asyncapi page's URL sits in a different line shape.
    const asyncapiHtml = await (await used.fetch("/docs/asyncapi")).text();
    expect(asyncapiHtml).toContain('url: "\\/docs\\/asyncapi.json"');

    // group()
    const grouped = new BunRouter();
    grouped.group(
      "/grouped",
      docsRouter({
        openapi: OPENAPI_DOCUMENT,
        asyncapi: ASYNCAPI_DOCUMENT,
        ...WITH_VIEWER,
      }),
    );
    expect(documentUrlOf(await (await grouped.fetch("/grouped/")).text())).toBe(
      "/grouped/openapi.json",
    );

    // domain(): a host-scoped mount adds no path prefix.
    const domained = new BunRouter();
    domained.domain(
      "api.test",
      docsRouter({
        openapi: OPENAPI_DOCUMENT,
        asyncapi: ASYNCAPI_DOCUMENT,
        ...WITH_VIEWER,
      }),
    );
    const onHost = await domained.fetch("http://api.test/");
    expect(onHost.status).toBe(200);
    expect(documentUrlOf(await onHost.text())).toBe("/openapi.json");
    // The control: another host does not reach the router at all.
    expect((await domained.fetch("http://other.test/")).status).toBe(404);

    // domain() + a path mount inside it.
    const inner = new BunRouter();
    inner.use(
      "/docs",
      docsRouter({
        openapi: OPENAPI_DOCUMENT,
        asyncapi: ASYNCAPI_DOCUMENT,
        ...WITH_VIEWER,
      }),
    );
    const hostScoped = new BunRouter();
    hostScoped.domain("api.test", inner);
    expect(
      documentUrlOf(
        await (await hostScoped.fetch("http://api.test/docs/")).text(),
      ),
    ).toBe("/docs/openapi.json");

    // No mount at all: baseUrl is "".
    const bare = docsRouter({
      openapi: OPENAPI_DOCUMENT,
      asyncapi: ASYNCAPI_DOCUMENT,
      ...WITH_VIEWER,
    });
    expect(documentUrlOf(await (await bare.fetch("/")).text())).toBe(
      "/openapi.json",
    );
  });

  it("re-reads a thunk document per request; a value document is served as given", async () => {
    let calls = 0;
    const root = new BunRouter();
    root.use(
      "/docs",
      docsRouter({
        openapi: () => ({
          ...OPENAPI_DOCUMENT,
          "x-calls": ++calls,
        }),
      }),
    );
    const first = (await (await root.fetch("/docs/openapi.json")).json()) as {
      "x-calls": number;
    };
    const second = (await (await root.fetch("/docs/openapi.json")).json()) as {
      "x-calls": number;
    };
    expect([first["x-calls"], second["x-calls"]]).toEqual([1, 2]);

    // The control: a value document never changes between requests.
    const valued = new BunRouter();
    valued.use("/docs", docsRouter({ openapi: OPENAPI_DOCUMENT }));
    expect(await (await valued.fetch("/docs/openapi.json")).json()).toEqual(
      await (await valued.fetch("/docs/openapi.json")).json(),
    );
  });

  it("throws ConfigError for misconfiguration, at construction", () => {
    expect(() => docsRouter({})).toThrow(ConfigError);
    expect(() => docsRouter({})).toThrow(/nothing to serve/);
    // A viewer page without its document.
    expect(() =>
      docsRouter({
        openapi: OPENAPI_DOCUMENT,
        viewer: { asyncapi: "asyncapi" },
      }),
    ).toThrow(ConfigError);
    expect(() =>
      docsRouter({
        asyncapi: ASYNCAPI_DOCUMENT,
        viewer: { openapi: "scalar" },
      }),
    ).toThrow(/viewer\.openapi/);
    // An unknown viewer name, on either spec.
    expect(() =>
      docsRouter({
        openapi: OPENAPI_DOCUMENT,
        viewer: { openapi: "stoplight" as never },
      }),
    ).toThrow(/unknown viewer "stoplight"/);
    expect(() =>
      docsRouter({
        asyncapi: ASYNCAPI_DOCUMENT,
        viewer: { asyncapi: "redoc" as never },
      }),
    ).toThrow(/unknown viewer "redoc"/);
    // A bare boolean (the old `ui: true` habit) is not a viewer declaration.
    expect(() =>
      docsRouter({
        openapi: OPENAPI_DOCUMENT,
        viewer: { openapi: true as never },
      }),
    ).toThrow(/a viewer name or a \{ name/);
    // A bad CDN is resolved at construction, not on the first page request.
    expect(() =>
      docsRouter({ openapi: OPENAPI_DOCUMENT, cdn: { baseUrl: "ftp://x" } }),
    ).toThrow(/http\(s\)/);
    expect(() =>
      docsRouter({
        openapi: OPENAPI_DOCUMENT,
        cdn: { scalar: { version: "^1.76.0" } },
      }),
    ).toThrow(/exact version/);

    // The control: a good configuration constructs.
    expect(() =>
      docsRouter({
        openapi: OPENAPI_DOCUMENT,
        asyncapi: ASYNCAPI_DOCUMENT,
        ...WITH_VIEWER,
      }),
    ).not.toThrow();
  });

  it("titles the pages from options.title, else the document's info.title", async () => {
    const titled = new BunRouter();
    titled.use(
      "/docs",
      docsRouter({
        openapi: OPENAPI_DOCUMENT,
        asyncapi: ASYNCAPI_DOCUMENT,
        ...WITH_VIEWER,
        title: "Fixed title",
      }),
    );
    expect(await (await titled.fetch("/docs/")).text()).toContain(
      "<title>Fixed title — OpenAPI</title>",
    );

    const fromDocument = new BunRouter();
    fromDocument.use(
      "/docs",
      docsRouter({
        openapi: OPENAPI_DOCUMENT,
        asyncapi: ASYNCAPI_DOCUMENT,
        ...WITH_VIEWER,
      }),
    );
    expect(await (await fromDocument.fetch("/docs/")).text()).toContain(
      "<title>The API — OpenAPI</title>",
    );
  });
});
