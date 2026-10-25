/**
 * AD (c): the pinned CDN assets and the viewer pages (`lib/docs/viewer.ts`),
 * served through {@link docsRouter} — the pins, the five page builders, the
 * Content Security Policy, and the `viewer` option's forms. Modelled on
 * bun-jobs' `__tests__/api/api-docs.test.ts` (the donor), whose own pins and
 * pages it still nets through the shims.
 */
import { describe, expect, it } from "bun:test";
import process from "node:process";
import { BunRouter } from "../../lib/BunRouter";
import type { OpenApiDocument } from "../../lib/docs/types";
import { ConfigError } from "../../lib/errors";
import type { DocsRouterOptions } from "../../lib/docs/router";
import { docsRouter } from "../../lib/docs/router";
import type { PinnedAsset, ResolvedDocsCdn } from "../../lib/docs/viewer";
import {
  assetUrl,
  DOCS_CDN,
  docsPageHeaders,
  resolveDocsCdn,
  swaggerUiPage,
} from "../../lib/docs/viewer";

/** A minimal OpenAPI document for the pages to point at. */
const OPENAPI_DOCUMENT: OpenApiDocument = {
  openapi: "3.1.2",
  info: { title: "The API", version: "1.0.0" },
  paths: {},
};

/** A minimal AsyncAPI 3.0.0 document (hand-supplied until phase (e)). */
const ASYNCAPI_DOCUMENT = {
  asyncapi: "3.0.0",
  info: { title: "The Events API", version: "1.0.0" },
  channels: {
    ticks: {
      address: "ticks",
      messages: { tick: { payload: { type: "object" } } },
    },
  },
  operations: {
    onTick: {
      action: "receive",
      channel: { $ref: "#/channels/ticks" },
    },
  },
};

/** A docsRouter mounted at `/docs`; the returned function fetches under it. */
function mounted(
  options: DocsRouterOptions,
): (path: string) => Promise<Response> {
  const root = new BunRouter();
  root.use("/docs", docsRouter(options));
  return (path) => root.fetch(`/docs${path}`);
}

/** The CSP directives of a response, by name. */
function csp(response: Response): Record<string, string> {
  const header = response.headers.get("content-security-policy") ?? "";
  return Object.fromEntries(
    header.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name, values.join(" ")];
    }),
  );
}

/** The default pins, resolved. */
const cdn: ResolvedDocsCdn = resolveDocsCdn(DOCS_CDN);

/** All five assets: name, the pin, and the files the pin carries. */
const ALL_ASSETS: readonly (readonly [
  name: string,
  asset: PinnedAsset,
  files: readonly ("js" | "css")[],
])[] = [
  ["scalar", DOCS_CDN.scalar, ["js"]],
  ["swaggerUi", DOCS_CDN.swaggerUi, ["js", "css"]],
  ["redoc", DOCS_CDN.redoc, ["js"]],
  ["rapidoc", DOCS_CDN.rapidoc, ["js"]],
  ["asyncapi", DOCS_CDN.asyncapi, ["js", "css"]],
];

describe("the pinned assets", () => {
  it("pins one exact version per viewer with sha384 hashes, and defaults to jsDelivr", () => {
    expect(Object.keys(DOCS_CDN).sort()).toEqual([
      "asyncapi",
      "rapidoc",
      "redoc",
      "scalar",
      "swaggerUi",
    ]);
    for (const [name, asset, files] of ALL_ASSETS) {
      expect(asset.version, name).toMatch(/^\d+\.\d+\.\d+$/);
      // No range, ever: the hashes are of exactly these bytes.
      expect(asset.version, name).not.toMatch(/[\^~x*]|latest/);
      expect(asset.integrity?.js, name).toMatch(/^sha384-[\w+/]+={0,2}$/);
      if (files.includes("css")) {
        expect(asset.css, name).toBeDefined();
        expect(asset.integrity?.css, name).toMatch(/^sha384-[\w+/]+={0,2}$/);
      } else {
        // Scalar, Redoc and RapiDoc bundle their styles; no stylesheet pin.
        expect(asset.css, name).toBeUndefined();
      }
    }
    // The controls: a range and a non-sha384 hash are both refused.
    expect(/^\d+\.\d+\.\d+$/.test("^1.76.0")).toBe(false);
    expect(/^sha384-[\w+/]+={0,2}$/.test("sha256-abc")).toBe(false);

    expect(cdn.origin).toBe("https://cdn.jsdelivr.net");
    expect(assetUrl(cdn, cdn.swaggerUi, "js")).toBe(
      `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${DOCS_CDN.swaggerUi.version}/swagger-ui-bundle.js`,
    );
    expect(assetUrl(cdn, cdn.scalar, "js")).toBe(
      `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${DOCS_CDN.scalar.version}/dist/browser/standalone.js`,
    );
    expect(assetUrl(cdn, cdn.asyncapi, "css")).toBe(
      `https://cdn.jsdelivr.net/npm/@asyncapi/react-component@${DOCS_CDN.asyncapi.version}/styles/default.min.css`,
    );
  });

  it("takes a mirror, and refuses a range, a bad hash or a bad base URL", () => {
    const mirrored = resolveDocsCdn(DOCS_CDN, {
      baseUrl: "https://assets.example/npm/",
      swaggerUi: {
        version: "5.0.0",
        integrity: {
          js: `sha384-${"a".repeat(64)}`,
          css: `sha384-${"b".repeat(64)}`,
        },
      },
    });
    expect(mirrored.baseUrl).toBe("https://assets.example/npm");
    expect(mirrored.origin).toBe("https://assets.example");
    expect(mirrored.swaggerUi.version).toBe("5.0.0");
    // A mirror without hashes for its own bytes loads without SRI, rather
    // than with hashes that cannot match.
    expect(
      resolveDocsCdn(DOCS_CDN, { swaggerUi: { version: "5.0.0" } }).swaggerUi
        .integrity,
    ).toBeUndefined();

    expect(() =>
      resolveDocsCdn(DOCS_CDN, { swaggerUi: { version: "^5.0.0" } }),
    ).toThrow(ConfigError);
    expect(() =>
      resolveDocsCdn(DOCS_CDN, {
        asyncapi: {
          version: "3.2.2",
          integrity: { js: "sha256-x", css: "sha384-y" },
        },
      }),
    ).toThrow(/sha384/);
    expect(() => resolveDocsCdn(DOCS_CDN, { baseUrl: "ftp://mirror" })).toThrow(
      /http\(s\)/,
    );
  });
});

describe("the pages", () => {
  it("serves no page when viewer is omitted (the default), and the JSON always", async () => {
    const fetch = mounted({ openapi: OPENAPI_DOCUMENT });
    expect((await fetch("/openapi.json")).status).toBe(200);
    expect((await fetch("/")).status).toBe(404);

    // `viewer: {}` opts into nothing either.
    const empty = mounted({ openapi: OPENAPI_DOCUMENT, viewer: {} });
    expect((await empty("/")).status).toBe(404);
    // No asyncapi document: neither its JSON nor its page exists.
    const withPage = mounted({
      openapi: OPENAPI_DOCUMENT,
      viewer: { openapi: "scalar" },
    });
    expect((await withPage("/asyncapi.json")).status).toBe(404);
    expect((await withPage("/asyncapi")).status).toBe(404);
  });

  it("serves Scalar at the mount root by default — the string and object forms agree", async () => {
    const pages: string[] = [];
    for (const spec of ["scalar", {}, { name: "scalar" }] as const) {
      const fetch = mounted({
        openapi: OPENAPI_DOCUMENT,
        viewer: { openapi: spec },
      });
      const response = await fetch("/");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
      const html = await response.text();
      expect(html).toContain(
        `<script src="${assetUrl(cdn, DOCS_CDN.scalar, "js")}" integrity="${DOCS_CDN.scalar.integrity!.js}" crossorigin="anonymous"></script>`,
      );
      expect(html).toContain('Scalar.createApiReference("#ui", {');
      expect(html).toContain('url: "\\/docs\\/openapi.json"');
      expect(html).toContain("<title>The API — OpenAPI</title>");
      pages.push(html);
    }
    // The three forms produce the same page (the nonce is the only per-request
    // difference).
    const normalize = (html: string) =>
      html.replaceAll(/nonce="[^"]+"/g, 'nonce="…"');
    expect(normalize(pages[1])).toBe(normalize(pages[0]));
    expect(normalize(pages[2])).toBe(normalize(pages[0]));
  });

  it("serves each OpenAPI viewer with its pinned asset", async () => {
    const fetch = mounted({
      openapi: OPENAPI_DOCUMENT,
      viewer: { openapi: "swagger-ui" },
    });
    const swagger = await (await fetch("/")).text();
    expect(swagger).toContain(
      `<script src="${assetUrl(cdn, DOCS_CDN.swaggerUi, "js")}" integrity="${DOCS_CDN.swaggerUi.integrity!.js}" crossorigin="anonymous"></script>`,
    );
    expect(swagger).toContain(
      `<link rel="stylesheet" href="${assetUrl(cdn, DOCS_CDN.swaggerUi, "css")}" integrity="${DOCS_CDN.swaggerUi.integrity!.css}" crossorigin="anonymous">`,
    );
    expect(swagger).toContain("window.ui = SwaggerUIBundle({");
    expect(swagger).toContain('request.credentials = "same-origin"');

    const redocFetch = mounted({
      openapi: OPENAPI_DOCUMENT,
      viewer: { openapi: "redoc" },
    });
    const redoc = await (await redocFetch("/")).text();
    // Redoc 3.x is ESM-only: an import map pins the URL and its hash, and the
    // nonce'd module initialiser imports it.
    const redocUrl = assetUrl(cdn, DOCS_CDN.redoc, "js");
    expect(redoc).toContain(
      `{"imports":{"redoc":"${redocUrl}"},"integrity":{"${redocUrl}":"${DOCS_CDN.redoc.integrity!.js}"}}`,
    );
    expect(redoc).toContain('import { init as redocInit } from "redoc";');
    expect(redoc).toContain('document.getElementById("ui")');

    const rapidocFetch = mounted({
      openapi: OPENAPI_DOCUMENT,
      viewer: { openapi: "rapidoc" },
    });
    const rapidoc = await (await rapidocFetch("/")).text();
    expect(rapidoc).toContain(
      `<script src="${assetUrl(cdn, DOCS_CDN.rapidoc, "js")}" integrity="${DOCS_CDN.rapidoc.integrity!.js}" crossorigin="anonymous"></script>`,
    );
    expect(rapidoc).toContain('document.createElement("rapi-doc")');
    expect(rapidoc).toContain(
      'element.setAttribute("spec-url", "\\/docs\\/openapi.json")',
    );
  });

  it("serves the AsyncAPI page with the official component by default, and Scalar as an opt-in", async () => {
    const fetch = mounted({
      openapi: OPENAPI_DOCUMENT,
      asyncapi: ASYNCAPI_DOCUMENT,
      viewer: { openapi: "scalar", asyncapi: "asyncapi" },
    });
    expect((await fetch("/asyncapi.json")).status).toBe(200);
    const page = await (await fetch("/asyncapi")).text();
    expect(page).toContain(
      `<script src="${assetUrl(cdn, DOCS_CDN.asyncapi, "js")}" integrity="${DOCS_CDN.asyncapi.integrity!.js}" crossorigin="anonymous"></script>`,
    );
    expect(page).toContain(
      `<link rel="stylesheet" href="${assetUrl(cdn, DOCS_CDN.asyncapi, "css")}" integrity="${DOCS_CDN.asyncapi.integrity!.css}" crossorigin="anonymous">`,
    );
    expect(page).toContain("AsyncApiStandalone.render(");
    expect(page).toContain('url: "\\/docs\\/asyncapi.json"');
    expect(page).toContain("<title>The Events API — AsyncAPI</title>");

    // Scalar renders the AsyncAPI document too (upstream work-in-progress).
    const scalar = mounted({
      asyncapi: ASYNCAPI_DOCUMENT,
      viewer: { asyncapi: "scalar" },
    });
    const scalarPageHtml = await (await scalar("/asyncapi")).text();
    expect(scalarPageHtml).toContain('Scalar.createApiReference("#ui", {');
    expect(scalarPageHtml).toContain('url: "\\/docs\\/asyncapi.json"');
    expect(scalarPageHtml).toContain(
      "<title>The Events API — AsyncAPI</title>",
    );
  });

  it("sends the CSP, the hardening headers, and a nonce matching the inline scripts", async () => {
    const fetch = mounted({
      openapi: OPENAPI_DOCUMENT,
      asyncapi: ASYNCAPI_DOCUMENT,
      viewer: { openapi: "scalar", asyncapi: "asyncapi" },
    });
    for (const path of ["/", "/asyncapi"]) {
      const response = await fetch(path);
      const html = await response.text();
      const directives = csp(response);
      expect(directives).toEqual({
        "default-src": "'none'",
        "script-src": expect.stringMatching(
          /^'nonce-[\w+/]+={0,2}' https:\/\/cdn\.jsdelivr\.net$/,
        ),
        "style-src": "https://cdn.jsdelivr.net 'unsafe-inline'",
        "img-src": "'self' data: https://cdn.jsdelivr.net",
        "font-src": "https://cdn.jsdelivr.net",
        "connect-src": "'self'",
        "base-uri": "'none'",
        "form-action": "'none'",
        "frame-ancestors": "'none'",
        "object-src": "'none'",
      });
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cache-control")).toBe("no-store");

      const nonce = directives["script-src"].match(/'nonce-([^']+)'/)![1];
      // Every inline script carries this request's nonce, and no other (the
      // AsyncAPI/Scalar pages have exactly one).
      const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)([^>]*)>/g)];
      expect(inline).toHaveLength(1);
      expect(inline[0][1]).toContain(`nonce="${nonce}"`);
    }

    // Redoc's page has two nonce'd inline scripts (the import map and the
    // module initialiser); both carry the request's nonce.
    const redocFetch = mounted({
      openapi: OPENAPI_DOCUMENT,
      viewer: { openapi: "redoc" },
    });
    const redocResponse = await redocFetch("/");
    const redocHtml = await redocResponse.text();
    const redocNonce =
      csp(redocResponse)["script-src"].match(/'nonce-([^']+)'/)![1];
    const redocInline = [
      ...redocHtml.matchAll(/<script(?![^>]*\ssrc=)([^>]*)>/g),
    ];
    expect(redocInline).toHaveLength(2);
    for (const [, attributes] of redocInline) {
      expect(attributes).toContain(`nonce="${redocNonce}"`);
    }

    // The control: a second request gets a different nonce, so the page cannot
    // be cached with one and replayed.
    const first = await fetch("/");
    const second = await fetch("/");
    expect(csp(first)["script-src"]).not.toBe(csp(second)["script-src"]);
  });

  it("passes the object form's options through to the viewer's own configuration", async () => {
    // Scalar: spread into `createApiReference`'s configuration.
    const scalar = mounted({
      openapi: OPENAPI_DOCUMENT,
      viewer: {
        openapi: { name: "scalar", theme: "purple", layout: "classic" },
      },
    });
    const scalarHtml = await (await scalar("/")).text();
    expect(scalarHtml).toContain('"theme": "purple",');
    expect(scalarHtml).toContain('"layout": "classic",');

    // Swagger UI: spread into `SwaggerUIBundle`'s configuration.
    const swagger = mounted({
      openapi: OPENAPI_DOCUMENT,
      viewer: { openapi: { name: "swagger-ui", docExpansion: "none" } },
    });
    const swaggerHtml = await (await swagger("/")).text();
    expect(swaggerHtml).toContain('"docExpansion": "none",');
    expect(swaggerHtml).toContain("deepLinking: true,");

    // Redoc: the second argument of `init`.
    const redoc = mounted({
      openapi: OPENAPI_DOCUMENT,
      viewer: { openapi: { name: "redoc", hideDownloadButton: true } },
    });
    const redocHtml = await (await redoc("/")).text();
    expect(redocHtml).toContain('{"hideDownloadButton":true}');

    // RapiDoc: assigned as element properties.
    const rapidoc = mounted({
      openapi: OPENAPI_DOCUMENT,
      viewer: { openapi: { name: "rapidoc", renderStyle: "read" } },
    });
    const rapidocHtml = await (await rapidoc("/")).text();
    expect(rapidocHtml).toContain('element["renderStyle"] = "read";');

    // The AsyncAPI component: spread into its `config`.
    const asyncapi = mounted({
      asyncapi: ASYNCAPI_DOCUMENT,
      viewer: { asyncapi: { name: "asyncapi", "x-extra": "yes" } },
    });
    const asyncapiHtml = await (await asyncapi("/asyncapi")).text();
    expect(asyncapiHtml).toContain(
      'config: { show: { sidebar: true, errors: true }, "x-extra": "yes" }',
    );
  });

  it("escapes `</script` in embedded values, and HTML in the title", async () => {
    const fetch = mounted({
      openapi: {
        ...OPENAPI_DOCUMENT,
        info: { title: "</title><script>alert(1)</script>", version: "1" },
      },
      viewer: {
        openapi: {
          name: "scalar",
          "x-note": "</script><script>alert(1)</script>",
        },
      },
    });
    const html = await (await fetch("/")).text();
    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).not.toContain("</title><script>alert(1)</script>");
    // JSON.stringify's slash escape is valid JavaScript and breaks the tag.
    expect(html).toContain("<\\/script><script>alert(1)<\\/script>");
    expect(html).toContain("&lt;/title&gt;");
  });

  it("puts requestHeaders in Swagger UI's requestInterceptor (the CSRF generalisation)", () => {
    const withHeaders = swaggerUiPage({
      cdn,
      title: "The API",
      documentUrl: "/docs/openapi.json",
      requestHeaders: { "x-bun-jobs-csrf": "1", "x-tenant": "play" },
    });
    expect(withHeaders.html).toContain(
      'request.headers["x-bun-jobs-csrf"] = "1";',
    );
    expect(withHeaders.html).toContain('request.headers["x-tenant"] = "play";');
    expect(withHeaders.html).toContain('request.credentials = "same-origin"');

    // The control: no requestHeaders, no header lines.
    const plain = swaggerUiPage({
      cdn,
      title: "The API",
      documentUrl: "/docs/openapi.json",
    });
    expect(plain.html).not.toContain("request.headers[");
    expect(plain.html).toContain('request.credentials = "same-origin"');

    // docsPageHeaders is the CSP builder both packages share.
    const headers = docsPageHeaders(cdn, plain.nonce);
    expect(headers["Content-Security-Policy"]).toContain(
      `script-src 'nonce-${plain.nonce}' https://cdn.jsdelivr.net`,
    );
  });

  it("moves the tags and the CSP origin to a mirror", async () => {
    const fetch = mounted({
      openapi: OPENAPI_DOCUMENT,
      viewer: { openapi: "scalar" },
      cdn: { baseUrl: "https://assets.example/npm" },
    });
    const response = await fetch("/");
    expect(csp(response)["script-src"]).toContain("https://assets.example");
    expect(csp(response)["script-src"]).not.toContain("jsdelivr");
    const html = await response.text();
    expect(html).toContain(
      `https://assets.example/npm/@scalar/api-reference@${DOCS_CDN.scalar.version}/`,
    );
    // The versions are unchanged, so the mirror serves the pinned bytes and
    // the hashes still apply (a mirror that re-encodes overrides the versions
    // with its own hashes — the pins block covers that).
    expect(html).toContain(DOCS_CDN.scalar.integrity!.js);
  });
});

/*
 * The pinned AsyncAPI component must understand AsyncAPI 3.0.0, the version a
 * hand-supplied document here is written in. `@asyncapi/react-component`
 * bundles `@asyncapi/parser` at ^3.6.2, whose 3.x line added 3.0.0 support.
 *
 * The bundle itself needs a DOM, so the check below parses a served document
 * with that parser instead — the same code the viewer runs before it renders.
 * It is opt-in, because the parser is not a dependency of this package:
 * `BUN_COMMON_DOCS_PARSER_DIR` points at a `node_modules` holding
 * `@asyncapi/parser` (installed at that range).
 */

/** The parser's `parse`, from `BUN_COMMON_DOCS_PARSER_DIR`, when it is available. */
async function loadAsyncApiParser(): Promise<
  | ((document: unknown) => Promise<{
      /** Whether a document came back. */
      parsed: boolean;
      /** The AsyncAPI version it reported. */
      version?: string;
      /** Error-severity diagnostics. */
      errors: string[];
    }>)
  | undefined
> {
  const dir = process.env.BUN_COMMON_DOCS_PARSER_DIR;
  if (!dir) {
    return undefined;
  }
  try {
    const module = (await import(`${dir}/@asyncapi/parser/cjs/index.js`)) as {
      Parser: new () => {
        parse: (input: unknown) => Promise<{
          document?: { version: () => string };
          diagnostics: { severity: number; message: string }[];
        }>;
      };
    };
    const parser = new module.Parser();
    return async (document) => {
      const result = await parser.parse(document);
      return {
        parsed: !!result.document,
        version: result.document?.version(),
        errors: result.diagnostics
          .filter((diagnostic) => diagnostic.severity === 0)
          .map((diagnostic) => diagnostic.message),
      };
    };
  } catch {
    return undefined;
  }
}

const parseAsyncApi = await loadAsyncApiParser();

describe("the pinned AsyncAPI component's parser", () => {
  it("is pinned to the 3.x line, which is the one that reads AsyncAPI 3.0.0", () => {
    expect(DOCS_CDN.asyncapi.version.startsWith("3.")).toBe(true);
    // The control: the 1.x component (parser 2.x) would not qualify.
    expect("^2.0.0".startsWith("^3.")).toBe(false);
  });

  it.skipIf(!parseAsyncApi)(
    "parses the served document with no errors",
    async () => {
      const fetch = mounted({ asyncapi: ASYNCAPI_DOCUMENT });
      const document = await (await fetch("/asyncapi.json")).json();
      const result = await parseAsyncApi!(structuredClone(document));
      expect(result).toEqual({ parsed: true, version: "3.0.0", errors: [] });

      // The control: a document nobody would serve is refused, so the check
      // above can fail.
      const broken = structuredClone(document) as { info?: unknown };
      delete broken.info;
      const bad = await parseAsyncApi!(broken);
      expect(bad.parsed).toBe(false);
      expect(bad.errors.length).toBeGreaterThan(0);
    },
  );
});

/*
 * The assets are pinned by hash, so a changed byte fails to load. This fetches
 * them and checks the hashes really are of the bytes the CDN serves. Opt-in
 * (`BUN_COMMON_DOCS_NETWORK=1`), because the suite must not need the network.
 */
describe.skipIf(process.env.BUN_COMMON_DOCS_NETWORK !== "1")(
  "the CDN assets (network)",
  () => {
    /** The `sha384-…` of what a URL serves. */
    async function sriOf(url: string): Promise<string> {
      const response = await fetch(url, { redirect: "follow" });
      expect(response.status).toBe(200);
      const hasher = new Bun.CryptoHasher("sha384");
      hasher.update(new Uint8Array(await response.arrayBuffer()));
      return `sha384-${hasher.digest("base64")}`;
    }

    for (const [, asset, files] of ALL_ASSETS) {
      for (const file of files) {
        it(`matches the pinned hash: ${asset.package}@${asset.version} ${file}`, async () => {
          expect(await sriOf(assetUrl(cdn, asset, file))).toBe(
            // `files` only lists what the pin carries, so this exists.
            asset.integrity![file]!,
          );
        });
      }
    }

    it("would notice a changed asset (the control)", async () => {
      const actual = await sriOf(assetUrl(cdn, cdn.swaggerUi, "js"));
      expect(actual).not.toBe(await sriOf(assetUrl(cdn, cdn.swaggerUi, "css")));
      expect(actual).not.toBe(`sha384-${"a".repeat(64)}`);
    });
  },
);
