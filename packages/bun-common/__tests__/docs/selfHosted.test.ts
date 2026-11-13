/**
 * The `"self-hosted"` docs viewer (AD (f) F2): the `@kingsleyweb/bun-ui/docs`
 * bundle served from this origin — the shell at the mount root (and
 * `/asyncapi`), the client-route fallbacks, the hashed assets under
 * `/assets/` with SRI over the local bytes, the strict self-only CSP, the
 * `{ name, ...options }` pass-through, and the missing-peer ConfigError.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "bun:test";
import { BunRouter } from "../../lib/BunRouter";
import { docsRouter } from "../../lib/docs/router";
import {
  registerSelfHostedViewer,
  SELF_HOSTED_PACKAGE,
} from "../../lib/docs/selfHosted";
import type { OpenApiDocument } from "../../lib/docs/types";
import { ConfigError } from "../../lib/errors";
import { createTestLogger } from "../../lib/logging";

/** A minimal OpenAPI document. */
const OPENAPI_DOCUMENT: OpenApiDocument = {
  openapi: "3.1.2",
  info: { title: "The API", version: "1.0.0" },
  paths: {},
};

/** A minimal AsyncAPI document. */
const ASYNCAPI_DOCUMENT = {
  asyncapi: "3.0.0",
  info: { title: "The Events API", version: "1.0.0" },
} as never;

/** The router with both documents self-hosted, mounted at /docs. */
function mounted(viewer: Record<string, unknown> = {}) {
  const root = new BunRouter();
  root.use(
    "/docs",
    docsRouter({
      openapi: OPENAPI_DOCUMENT,
      asyncapi: ASYNCAPI_DOCUMENT,
      viewer: { openapi: "self-hosted", asyncapi: "self-hosted", ...viewer },
    }),
  );
  return root;
}

/** The shell page at `path`, with its headers. */
async function page(root: BunRouter, path: string) {
  const response = await root.fetch(path);
  expect(response.status).toBe(200);
  const html = await response.text();
  return { response, html };
}

/** The value of one attribute in a tag's source, or `""`. */
function attribute(tag: string, name: string): string {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
}

/** The config a shell carries, parsed. */
function shellConfig(html: string): Record<string, unknown> {
  const match =
    /<script type="application\/json" id="bun-api-docs-ui-config"[^>]*>([\s\S]*?)<\/script>/.exec(
      html,
    );
  expect(match).not.toBeNull();
  return JSON.parse(match![1]) as Record<string, unknown>;
}

describe("the self-hosted viewer", () => {
  it("serves the shell at the mount root, under the strict self-only CSP", async () => {
    const root = mounted();
    const { response, html } = await page(root, "/docs/");
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const csp = response.headers.get("content-security-policy")!;
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeString();
    expect(csp).toBe(
      `default-src 'self'; script-src 'self' 'nonce-${nonce!}'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    );
    // The module script is the package's bundle, nonce'd, with SRI.
    const script = /<script type="module"[^>]*>/.exec(html)?.[0] ?? "";
    expect(attribute(script, "src")).toMatch(
      /^\/docs\/assets\/main-[\w-]+\.js$/,
    );
    expect(attribute(script, "integrity")).toMatch(/^sha384-[\w+/]+=*$/);
    expect(attribute(script, "nonce")).toBe(nonce as string);
    expect(html).toContain("<title>The API</title>");
  });

  it("points the page's config at the mount's own document, and carries the pass-through options", async () => {
    const root = mounted({
      openapi: {
        name: "self-hosted",
        theme: "dark",
        extensions: ["x-acme"],
        csrfHeader: "x-csrf",
      },
    });
    const { html } = await page(root, "/docs/");
    expect(shellConfig(html)).toEqual({
      version: 1,
      title: "The API",
      basePath: "/docs",
      assetsPath: "/docs/assets",
      documentUrl: "/docs/openapi.json",
      csrfHeader: "x-csrf",
      extensions: ["x-acme"],
      theme: "dark",
    });
  });

  it("serves the client routes of the page (the SPA fallback), with the same shell", async () => {
    const root = mounted();
    for (const path of ["/docs/http", "/docs/http/listQueues"]) {
      const { html } = await page(root, path);
      expect(shellConfig(html).documentUrl).toBe("/docs/openapi.json");
    }
  });

  it("serves the AsyncAPI page at /asyncapi with its own config, and its client routes", async () => {
    const root = mounted();
    const { html } = await page(root, "/docs/asyncapi");
    expect(shellConfig(html)).toMatchObject({
      title: "The Events API",
      basePath: "/docs/asyncapi",
      assetsPath: "/docs/assets",
      documentUrl: "/docs/asyncapi.json",
    });
    const deep = await page(root, "/docs/asyncapi/ws/channel-queue");
    expect(shellConfig(deep.html).basePath).toBe("/docs/asyncapi");
  });

  it("serves the assets with immutable caching, their SRI over the local bytes, and 304 on a matching ETag", async () => {
    const root = mounted();
    const { html } = await page(root, "/docs/");
    const src = attribute(
      /<script type="module"[^>]*>/.exec(html)?.[0] ?? "",
      "src",
    );
    const integrity = attribute(
      /<script type="module"[^>]*>/.exec(html)?.[0] ?? "",
      "integrity",
    );
    const asset = await root.fetch(src);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(asset.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const body = new Uint8Array(await asset.arrayBuffer());
    // The shell's integrity is the local bytes', computed when the bundle was read.
    const digest = `sha384-${new Bun.CryptoHasher("sha384").update(body).digest("base64")}`;
    expect(digest).toBe(integrity);

    const etag = asset.headers.get("etag")!;
    const again = await root.fetch(src, {
      headers: { "if-none-match": etag },
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");

    const head = await root.fetch(src, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(body.byteLength));
    expect(await head.text()).toBe("");
  });

  it("404s an unknown asset as a problem, never the shell", async () => {
    const root = mounted();
    const response = await root.fetch("/docs/assets/nope.js");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps the JSON documents on their routes", async () => {
    const root = mounted();
    expect((await root.fetch("/docs/openapi.json")).status).toBe(200);
    expect(await (await root.fetch("/docs/asyncapi.json")).json()).toEqual(
      ASYNCAPI_DOCUMENT,
    );
  });

  it("a bad pass-through option is a ConfigError at construction", () => {
    for (const options of [
      { theme: "blue" },
      { extensions: [] },
      { extensions: ["acme"] },
      { csrfHeader: 42 },
    ]) {
      let caught: unknown;
      try {
        mounted({ openapi: { name: "self-hosted", ...options } });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
    }
  });

  it("a theme object gives its page its own stylesheet, linked last and served with the bundle (control: the other page keeps the built-in palette)", async () => {
    const root = mounted({
      openapi: {
        name: "self-hosted",
        theme: {
          mode: "dark",
          light: { accent: "#0f766e" },
          dark: { accent: "#2dd4bf" },
        },
      },
    });
    const { response, html } = await page(root, "/docs/");
    expect(shellConfig(html).theme).toBe("dark");
    const links = [...html.matchAll(/<link rel="stylesheet"[^>]*>/g)].map(
      ([tag]) => attribute(tag, "href"),
    );
    const themeHref = links.at(-1)!;
    expect(themeHref).toMatch(/^\/docs\/assets\/theme-[\da-f]{12}\.css$/);
    // The CSP is the same strict self-only one: the theme is a file of its own.
    expect(response.headers.get("content-security-policy")).toContain(
      "style-src 'self';",
    );
    const css = await root.fetch(themeHref);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const text = await css.text();
    expect(text).toContain("--accent: #0f766e;");
    expect(text).toContain(':root[data-theme="dark"] {\n  --accent: #2dd4bf;');

    const other = await page(root, "/docs/asyncapi");
    expect(other.html).not.toContain("theme-");
    expect(shellConfig(other.html).theme).toBe("system");
  });

  it("logs a theme's contrast problems on the router's logger at the first page request", async () => {
    const { logger, events } = createTestLogger();
    const root = new BunRouter();
    const docs = docsRouter({
      openapi: OPENAPI_DOCUMENT,
      viewer: {
        openapi: {
          name: "self-hosted",
          theme: { light: { accent: "#8ab4f8" } },
        },
      },
    });
    docs.setLogger(logger);
    root.use("/docs", docs);
    await page(root, "/docs/");
    await page(root, "/docs/");
    const warned = events
      .filter((event) => event.level === "warn")
      .map((event) => String(event.message));
    expect(warned).toContain(
      "the openapi viewer: theme.light: accentContrast #ffffff on accent #8ab4f8 is 2.11:1, below 4.5:1 (primary buttons, accent badges)",
    );
    // Once, not per request.
    expect(warned).toHaveLength(4);
  });

  it("a bad theme colour is a ConfigError naming the viewer and the token", () => {
    let caught: unknown;
    try {
      mounted({
        openapi: { name: "self-hosted", theme: { light: { accent: "teal" } } },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toBe(
      'the openapi viewer: theme.light.accent must be a colour as "#rgb" or "#rrggbb"',
    );
  });

  it("a theme object with a bun-ui older than 3.2.0 names the upgrade (control: a scheme still works there)", () => {
    const real = createRequire(import.meta.url)(
      `${SELF_HOSTED_PACKAGE}/docs/hosted`,
    ) as Record<string, unknown>;
    // The peer as 3.1.x shipped it: no theme functions.
    const { resolveThemeInput: _r, themedAssets: _t, ...older } = real;
    const register = (theme: unknown) =>
      registerSelfHostedViewer(
        new BunRouter(),
        {
          openapi: {
            document: () => OPENAPI_DOCUMENT,
            path: "/openapi.json",
            options: { theme: theme as never },
          },
        },
        undefined,
        { require: () => older },
      );
    let caught: unknown;
    try {
      register({ light: { accent: "#0f766e" } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toBe(
      `the openapi viewer: a theme object needs ${SELF_HOSTED_PACKAGE} 3.2.0 or later`,
    );
    expect(() => register("dark")).not.toThrow();
  });

  it("without the package installed, names the install (the require seam)", () => {
    let caught: unknown;
    try {
      registerSelfHostedViewer(
        new BunRouter(),
        {
          openapi: {
            document: () => OPENAPI_DOCUMENT,
            path: "/openapi.json",
            options: {},
          },
        },
        undefined,
        {
          require: () => {
            throw new Error("Cannot find module");
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toContain(SELF_HOSTED_PACKAGE);
    expect((caught as Error).message).toContain("bun add");
  });

  it("the require seam is handed the peer's hosted module path", () => {
    const seen: string[] = [];
    registerSelfHostedViewer(
      new BunRouter(),
      {
        openapi: {
          document: () => OPENAPI_DOCUMENT,
          path: "/openapi.json",
          options: {},
        },
      },
      undefined,
      {
        require: (specifier) => {
          seen.push(specifier);
          return createRequire(import.meta.url)(specifier);
        },
      },
    );
    expect(seen).toEqual([`${SELF_HOSTED_PACKAGE}/docs/hosted`]);
  });

  it("a CDN viewer name still works on the same router shape (control)", async () => {
    const root = new BunRouter();
    root.use(
      "/docs",
      docsRouter({ openapi: OPENAPI_DOCUMENT, viewer: { openapi: "scalar" } }),
    );
    const { html } = await page(root, "/docs/");
    expect(html).toContain("cdn.jsdelivr.net");
    expect((await root.fetch("/docs/openapi.json")).status).toBe(200);
    // No self-hosted assets on it.
    expect((await root.fetch("/docs/assets/x.js")).status).toBe(404);
  });
});
