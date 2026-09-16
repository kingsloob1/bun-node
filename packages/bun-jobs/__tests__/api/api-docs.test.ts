import type {
  JobsApiAuthorizeContext,
  JobsApiConfig,
} from "../../lib/api/config";
import process from "node:process";
import { BunRouter } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it } from "bun:test";
import { createJobsApi } from "../../lib/api/createJobsApi";
import {
  assetUrl,
  ASYNCAPI_PARSER_RANGE,
  DEFAULT_CDN_BASE_URL,
  DOCS_CDN,
  resolveDocsCdn,
} from "../../lib/api/docs/cdn";
import { ConfigError } from "../../lib/index";
import { apiConfig, openContexts } from "./fixtures";

/**
 * The docs UI: the pinned assets, the two generated pages and their Content
 * Security Policy, and the routes that serve them — which exist only when
 * `docs.ui` asks for them.
 */

afterAll(async () => {
  await Promise.all(openContexts.splice(0).map((jobs) => jobs.close()));
});

/** Every API a test built, closed afterwards. */
const apis: { close: () => Promise<void> }[] = [];

afterAll(async () => {
  await Promise.all(apis.splice(0).map((api) => api.close()));
});

/** A mounted API, with `docs.ui` on unless a test says otherwise. */
function mounted(overrides: Partial<JobsApiConfig> = {}) {
  const calls: JobsApiAuthorizeContext[] = [];
  const api = createJobsApi(
    apiConfig({
      docs: { ui: true, ...(overrides.docs === false ? {} : overrides.docs) },
      authorize: (_req, context) => {
        calls.push(context);
        return overrides.authorize
          ? (overrides.authorize as (...args: unknown[]) => boolean)(
              _req,
              context,
            )
          : true;
      },
      ...overrides,
    }),
  );
  apis.push(api);
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  return { api, root, calls, fetch: (path: string) => root.fetch(path) };
}

/** The CSP directives of a response, by name. */
function csp(response: Response): Record<string, string> {
  const header = response.headers.get("content-security-policy") ?? "";
  return Object.fromEntries(
    header.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name!, values.join(" ")];
    }),
  );
}

describe("the pinned assets", () => {
  it("pins exact versions with sha384 hashes, and defaults to jsDelivr", () => {
    expect(DEFAULT_CDN_BASE_URL).toBe("https://cdn.jsdelivr.net/npm");
    for (const asset of [DOCS_CDN.swaggerUi, DOCS_CDN.asyncapi]) {
      expect(asset.version).toMatch(/^\d+\.\d+\.\d+$/);
      // No range, ever: the hashes below are of exactly these bytes.
      expect(asset.version).not.toMatch(/[\^~x*]|latest/);
      expect(asset.integrity!.js).toMatch(/^sha384-[\w+/]+={0,2}$/);
      expect(asset.integrity!.css).toMatch(/^sha384-[\w+/]+={0,2}$/);
    }
    // The controls: a range and a non-sha384 hash are both refused.
    expect(/^\d+\.\d+\.\d+$/.test("^5.32.15")).toBe(false);
    expect(/^sha384-[\w+/]+={0,2}$/.test("sha256-abc")).toBe(false);

    const cdn = resolveDocsCdn(undefined);
    expect(cdn.origin).toBe("https://cdn.jsdelivr.net");
    expect(assetUrl(cdn, cdn.swaggerUi, "js")).toBe(
      `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${DOCS_CDN.swaggerUi.version}/swagger-ui-bundle.js`,
    );
    expect(assetUrl(cdn, cdn.asyncapi, "css")).toBe(
      `https://cdn.jsdelivr.net/npm/@asyncapi/react-component@${DOCS_CDN.asyncapi.version}/styles/default.min.css`,
    );
  });

  it("takes a mirror, and refuses a range, a bad hash or a bad base URL", () => {
    const mirrored = resolveDocsCdn({
      cdn: {
        baseUrl: "https://assets.example/npm/",
        swaggerUi: {
          version: "5.0.0",
          integrity: {
            js: `sha384-${"a".repeat(64)}`,
            css: `sha384-${"b".repeat(64)}`,
          },
        },
      },
    });
    expect(mirrored.baseUrl).toBe("https://assets.example/npm");
    expect(mirrored.origin).toBe("https://assets.example");
    expect(mirrored.swaggerUi.version).toBe("5.0.0");
    // A mirror without hashes for its own bytes loads without SRI, rather
    // than with hashes that cannot match.
    expect(
      resolveDocsCdn({ cdn: { swaggerUi: { version: "5.0.0" } } }).swaggerUi
        .integrity,
    ).toBeUndefined();

    expect(() =>
      resolveDocsCdn({ cdn: { swaggerUi: { version: "^5.0.0" } } }),
    ).toThrow(ConfigError);
    expect(() =>
      resolveDocsCdn({
        cdn: {
          asyncapi: {
            version: "3.1.8",
            integrity: { js: "sha256-x", css: "sha384-y" },
          },
        },
      }),
    ).toThrow(/sha384/);
    expect(() => resolveDocsCdn({ cdn: { baseUrl: "ftp://mirror" } })).toThrow(
      /http\(s\)/,
    );
  });
});

describe("the pages", () => {
  it("serves both viewers only with docs.ui, and the AsyncAPI one only with a socket", async () => {
    const on = mounted();
    const swagger = await on.fetch("/admin/jobs/docs");
    const asyncapi = await on.fetch("/admin/jobs/docs/asyncapi");
    expect([swagger.status, asyncapi.status]).toEqual([200, 200]);
    expect(swagger.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );

    // The control: off by default.
    const off = mounted({ docs: {} });
    expect((await off.fetch("/admin/jobs/docs")).status).toBe(404);
    expect((await off.fetch("/admin/jobs/docs/asyncapi")).status).toBe(404);
    expect(off.api.routes.map((route) => route.operationId)).not.toContain(
      "getDocsUi",
    );

    // No socket: the page that renders its document is not routed.
    const socketless = mounted({ websocket: false });
    expect((await socketless.fetch("/admin/jobs/docs")).status).toBe(200);
    expect((await socketless.fetch("/admin/jobs/docs/asyncapi")).status).toBe(
      404,
    );

    // Custom paths are honoured.
    const custom = mounted({
      docs: { ui: true, uiPath: "/ui", asyncapiUiPath: "/ui/events" },
    });
    expect((await custom.fetch("/admin/jobs/ui")).status).toBe(200);
    expect((await custom.fetch("/admin/jobs/ui/events")).status).toBe(200);
    expect((await custom.fetch("/admin/jobs/docs")).status).toBe(404);
  });

  it("sends the CSP, the hardening headers, and a nonce matching its one inline script", async () => {
    const app = mounted();
    for (const path of ["/admin/jobs/docs", "/admin/jobs/docs/asyncapi"]) {
      const response = await app.fetch(path);
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

      const nonce = directives["script-src"]!.match(/'nonce-([^']+)'/)![1]!;
      expect(html).toContain(`<script nonce="${nonce}">`);
      // Every inline script carries this request's nonce, and no other.
      const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)([^>]*)>/g)];
      expect(inline).toHaveLength(1);
      expect(inline[0]![1]).toContain(`nonce="${nonce}"`);
    }

    // The control: a second request gets a different nonce, so the page cannot
    // be cached with one and replayed.
    const first = await app.fetch("/admin/jobs/docs");
    const second = await app.fetch("/admin/jobs/docs");
    expect(csp(first)["script-src"]).not.toBe(csp(second)["script-src"]);
  });

  it("loads the pinned bundles with integrity and crossorigin, and points at this API's documents", async () => {
    const app = mounted();
    const swagger = await (await app.fetch("/admin/jobs/docs")).text();
    expect(swagger).toContain(
      `<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${DOCS_CDN.swaggerUi.version}/swagger-ui-bundle.js" integrity="${DOCS_CDN.swaggerUi.integrity.js}" crossorigin="anonymous"></script>`,
    );
    expect(swagger).toContain(
      `integrity="${DOCS_CDN.swaggerUi.integrity.css}" crossorigin="anonymous">`,
    );
    expect(swagger).toContain('url: "\\/admin\\/jobs\\/openapi.json"');
    expect(swagger).toContain('request.credentials = "same-origin"');

    const asyncapi = await (
      await app.fetch("/admin/jobs/docs/asyncapi")
    ).text();
    expect(asyncapi).toContain(
      `<script src="https://cdn.jsdelivr.net/npm/@asyncapi/react-component@${DOCS_CDN.asyncapi.version}/browser/standalone/index.js" integrity="${DOCS_CDN.asyncapi.integrity.js}" crossorigin="anonymous"></script>`,
    );
    expect(asyncapi).toContain("AsyncApiStandalone.render(");
    expect(asyncapi).toContain('url: "\\/admin\\/jobs\\/asyncapi.json"');

    // A mirror moves both the tags and the CSP origin.
    const mirror = mounted({
      docs: { ui: true, cdn: { baseUrl: "https://assets.example/npm" } },
    });
    const page = await mirror.fetch("/admin/jobs/docs");
    expect(csp(page)["script-src"]).toContain("https://assets.example");
    expect(csp(page)["script-src"]).not.toContain("jsdelivr");
    expect(await page.text()).toContain(
      "https://assets.example/npm/swagger-ui-dist@",
    );
  });

  it("adds the CSRF header in the interceptor only when one is configured", async () => {
    const withHeader = mounted({ csrf: { header: "x-bun-jobs-csrf" } });
    const page = await (await withHeader.fetch("/admin/jobs/docs")).text();
    expect(page).toContain('request.headers["x-bun-jobs-csrf"] = "1"');
    // The control: the default configuration has no header, so none is set.
    const plain = await (await mounted().fetch("/admin/jobs/docs")).text();
    expect(plain).not.toContain("request.headers[");
    expect(plain).toContain('request.credentials = "same-origin"');
  });

  it("is behind docs.read, and reports its path in /meta", async () => {
    const app = mounted();
    await app.fetch("/admin/jobs/docs");
    expect(
      app.calls.filter((call) => call.action === "docs.read"),
    ).not.toHaveLength(0);
    expect(
      app.calls.every((call) => call.transport === "http" && !call.mutation),
    ).toBe(true);

    const meta = (await (await app.fetch("/admin/jobs/meta")).json()) as {
      docs: {
        openapi: string;
        asyncapi?: string;
        ui?: string;
        asyncapiUi?: string;
      };
    };
    expect(meta.docs).toEqual({
      openapi: "/admin/jobs/openapi.json",
      asyncapi: "/admin/jobs/asyncapi.json",
      ui: "/admin/jobs/docs",
      asyncapiUi: "/admin/jobs/docs/asyncapi",
    });
    // The control: with the pages off, `/meta` advertises neither.
    const off = mounted({ docs: {} });
    const offMeta = (await (await off.fetch("/admin/jobs/meta")).json()) as {
      docs: { ui?: string; asyncapiUi?: string };
    };
    expect(offMeta.docs.ui).toBeUndefined();
    expect(offMeta.docs.asyncapiUi).toBeUndefined();

    // Only the viewer that is routed is advertised: no socket, no AsyncAPI page.
    const socketless = mounted({ websocket: false });
    const socketlessMeta = (await (
      await socketless.fetch("/admin/jobs/meta")
    ).json()) as { docs: { ui?: string; asyncapiUi?: string } };
    expect(socketlessMeta.docs.ui).toBe("/admin/jobs/docs");
    expect(socketlessMeta.docs.asyncapiUi).toBeUndefined();
  });

  it("refuses the pages when authorize denies docs.read", async () => {
    const denied = mounted({
      authorize: (_req: unknown, context: JobsApiAuthorizeContext) =>
        context.action !== "docs.read",
    } as Partial<JobsApiConfig>);
    for (const path of ["/admin/jobs/docs", "/admin/jobs/docs/asyncapi"]) {
      const response = await denied.fetch(path);
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
    }

    const unauthenticated = mounted({
      authorize: (_req: unknown, context: JobsApiAuthorizeContext) =>
        context.action === "docs.read" ? { allow: false, status: 401 } : true,
    } as Partial<JobsApiConfig>);
    expect((await unauthenticated.fetch("/admin/jobs/docs")).status).toBe(401);
    // The control: an allowed caller still gets the page.
    expect((await mounted().fetch("/admin/jobs/docs")).status).toBe(200);
  });
});

/*
 * The pinned AsyncAPI component must understand AsyncAPI 3.0.0, which is what
 * this API generates. `@asyncapi/react-component` bundles `@asyncapi/parser`
 * at ASYNCAPI_PARSER_RANGE, whose 3.x line added 3.0.0 support.
 *
 * The bundle itself needs a DOM, so the check below parses a generated
 * document with that parser instead — the same code the viewer runs before it
 * renders. It is opt-in, because the parser is not a dependency of this
 * package: `BUN_JOBS_DOCS_PARSER_DIR` points at a `node_modules` holding
 * `@asyncapi/parser` (installed at ASYNCAPI_PARSER_RANGE).
 */

/** The parser's `parse`, from `BUN_JOBS_DOCS_PARSER_DIR`, when it is available. */
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
  const dir = process.env.BUN_JOBS_DOCS_PARSER_DIR;
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
    expect(ASYNCAPI_PARSER_RANGE).toMatch(/^\^3\./);
    expect(DOCS_CDN.asyncapi.version.startsWith("3.")).toBe(true);
    // The control: the 1.x component (parser 2.x) would not qualify.
    expect(/^\^3\./.test("^2.0.0")).toBe(false);
  });

  it.skipIf(!parseAsyncApi)(
    "parses this API's generated document with no errors",
    async () => {
      const app = mounted();
      const document = app.api.asyncapi()!;
      const result = await parseAsyncApi!(structuredClone(document));
      expect(result).toEqual({ parsed: true, version: "3.0.0", errors: [] });

      // The control: a document the generator would never emit is refused, so
      // the check above can fail.
      const broken = structuredClone(document) as unknown as {
        operations: Record<string, { action: string }>;
      };
      broken.operations.subscribe!.action = "publish";
      const bad = await parseAsyncApi!(broken);
      expect(bad.parsed).toBe(false);
      expect(bad.errors.length).toBeGreaterThan(0);
    },
  );
});

/*
 * The assets are pinned by hash, so a changed byte fails to load. This fetches
 * them and checks the hashes really are of the bytes the CDN serves. Opt-in
 * (`BUN_JOBS_DOCS_NETWORK=1`), because the suite must not need the network.
 */
describe.skipIf(process.env.BUN_JOBS_DOCS_NETWORK !== "1")(
  "the CDN assets (network)",
  () => {
    const cdn = resolveDocsCdn(undefined);

    /** The `sha384-…` of what a URL serves. */
    async function sriOf(url: string): Promise<string> {
      const response = await fetch(url, { redirect: "follow" });
      expect(response.status).toBe(200);
      const hasher = new Bun.CryptoHasher("sha384");
      hasher.update(new Uint8Array(await response.arrayBuffer()));
      return `sha384-${hasher.digest("base64")}`;
    }

    for (const asset of [cdn.swaggerUi, cdn.asyncapi]) {
      for (const file of ["js", "css"] as const) {
        it(`matches the pinned hash: ${asset.package}@${asset.version} ${file}`, async () => {
          expect(await sriOf(assetUrl(cdn, asset, file))).toBe(
            asset.integrity![file],
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
