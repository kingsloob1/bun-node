/**
 * The kit's router (`lib/kit/serve.ts`) and shell (`lib/kit/shell.ts`),
 * driven as a UI that is neither the jobs UI nor the docs viewer would drive
 * them: its own config element, problem URN, log label, `connect-src`, an
 * extra route, and its own guards. The jobs and docs server tests cover the
 * same code through `jobsUi()` and `docsUi()`; these pin what the kit takes
 * from each UI, so a third UI gets exactly what it passes.
 */
import type { RouterHandler } from "@kingsleyweb/bun-common";
import type { UiAsset, UiAssets } from "../../../lib/kit/assets";
import type { UiRouterOptions } from "../../../lib/kit/serve";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import { integrityOf } from "../../../lib/kit/assets";
import { ASSET_CACHE_CONTROL } from "../../../lib/kit/browser/shared";
import { createUiRouter, decide, problemSender } from "../../../lib/kit/serve";
import { createUiShellRenderer } from "../../../lib/kit/shell";

/** The element id this test UI's config travels in. */
const ELEMENT_ID = "test-ui-config";

/** One served file of the hand-made bundle. */
function asset(name: string, text: string, type: string): UiAsset {
  const body = new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
  const integrity = integrityOf(body);
  return {
    name,
    body,
    type,
    size: body.byteLength,
    integrity,
    etag: `"${integrity.slice(7, 39)}"`,
  };
}

/** A bundle of one module and one stylesheet, no build needed. */
const ASSETS: UiAssets = {
  entry: { js: "main-abc.js", css: ["main-abc.css"] },
  files: new Map([
    [
      "main-abc.js",
      asset("main-abc.js", "console.log(1)", "text/javascript; charset=utf-8"),
    ],
    [
      "main-abc.css",
      asset("main-abc.css", "body{}", "text/css; charset=utf-8"),
    ],
  ]),
  source: "memory",
};

/** The test UI's config, as a UI would inline it. */
const CONFIG = {
  version: 1,
  title: "Test </script> UI",
  basePath: "/test",
  assetsPath: "/test/assets",
  theme: "dark",
} as const;

/** The test UI's router over {@link ASSETS}, with overrides. */
function testUi(overrides: Partial<UiRouterOptions> = {}) {
  const { logger, events } = createTestLogger();
  const router = createUiRouter({
    label: "test ui",
    logger,
    problem: problemSender("urn:test-ui:error:"),
    loadAssets: () => Promise.resolve(ASSETS),
    createRenderer: (assets) =>
      createUiShellRenderer(ELEMENT_ID, CONFIG, assets),
    connectSrc: (req) => [`wss://${req.get("host") ?? "none"}`],
    middleware: [],
    unauthorized: null,
    ...overrides,
  });
  return { router, events };
}

/** A navigation, as a browser makes one. */
const NAVIGATE = { headers: { "sec-fetch-mode": "navigate" } };

describe("the kit's router, for a third UI", () => {
  it("serves the shell under a strict, self-only CSP with the UI's connect-src", async () => {
    const { router } = testUi();
    const res = await router.fetch("/", { headers: { host: "ui.example" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? "";
    expect(nonce).not.toBe("");
    expect(csp).toBe(
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}'`,
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self' wss://ui.example",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ].join("; "),
    );
    const html = await res.text();
    // The UI's own element id, its config escaped for a script context.
    expect(html).toContain(
      `<script type="application/json" id="${ELEMENT_ID}" nonce="${nonce}">`,
    );
    expect(html).toContain("Test \\u003c/script\\u003e UI");
    expect(html).toContain("<title>Test &lt;/script&gt; UI</title>");
    expect(html).toContain('<meta name="color-scheme" content="dark">');
    const js = ASSETS.files.get("main-abc.js")!;
    expect(html).toContain(
      `<script type="module" src="/test/assets/main-abc.js" integrity="${js.integrity}" nonce="${nonce}"></script>`,
    );
  });

  it("serves a bundle file immutable, with its ETag, and 304 for a match", async () => {
    const { router } = testUi();
    const res = await router.fetch("/assets/main-abc.css");
    const css = ASSETS.files.get("main-abc.css")!;
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(ASSET_CACHE_CONTROL);
    expect(res.headers.get("etag")).toBe(css.etag);
    expect(await res.text()).toBe("body{}");
    const again = await router.fetch("/assets/main-abc.css", {
      headers: { "if-none-match": `W/${css.etag}` },
    });
    expect(again.status).toBe(304);
  });

  it("answers a missing or nested bundle path with the UI's own problem type", async () => {
    const { router } = testUi();
    for (const path of ["/assets/nope.js", "/assets", "/assets/a/b.js"]) {
      const res = await router.fetch(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await res.json()).toEqual({
        type: "urn:test-ui:error:NOT_FOUND",
        title: "Not found",
        status: 404,
        code: "NOT_FOUND",
        detail: `No asset ${path}`,
        instance: path,
      });
    }
  });

  it("registers the UI's own routes ahead of the shell's catch-all", async () => {
    const extra: RouterHandler = (_req, res) => {
      res.json({ extra: true });
    };
    const { router } = testUi({
      routes: [{ path: "/extra.json", handler: extra }],
    });
    expect(await (await router.fetch("/extra.json")).json()).toEqual({
      extra: true,
    });
    // Negative control: without the route, the path is a client route.
    const plain = testUi().router;
    expect((await plain.fetch("/extra.json")).headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
  });

  it("runs before, then middleware, then authorize, on every route", async () => {
    const order: string[] = [];
    const step =
      (name: string): RouterHandler =>
      (_req, _res, next) => {
        order.push(name);
        next();
      };
    const seen: { asset: boolean; path: string }[] = [];
    const { router } = testUi({
      before: [step("before")],
      middleware: [step("middleware")],
      authorize: (_req, context) => {
        order.push("authorize");
        seen.push(context);
        return true;
      },
      routes: [
        {
          path: "/extra.json",
          handler: (_req, res) => {
            res.json({});
          },
        },
      ],
    });
    for (const path of ["/", "/assets/main-abc.js", "/extra.json"]) {
      order.length = 0;
      expect((await router.fetch(path)).status).toBe(200);
      expect(order).toEqual(["before", "middleware", "authorize"]);
    }
    expect(seen).toEqual([
      { asset: false, path: "/" },
      { asset: true, path: "/assets/main-abc.js" },
      { asset: false, path: "/extra.json" },
    ]);
  });

  it("redirects a denied navigation of the shell only, never a bundle file or an extra route", async () => {
    const { router } = testUi({
      authorize: () => ({ allow: false, status: 401 }),
      unauthorized: {
        redirectTo: "/login",
        returnParam: "returnTo",
        statuses: [401],
      },
      routes: [
        {
          path: "/extra.json",
          handler: (_req, res) => {
            res.json({});
          },
        },
      ],
    });
    const shell = await router.fetch("/page?x=1", NAVIGATE);
    expect(shell.status).toBe(303);
    expect(shell.headers.get("location")).toBe(
      "/login?returnTo=%2Fpage%3Fx%3D1",
    );
    for (const path of ["/assets/main-abc.js", "/extra.json"]) {
      const res = await router.fetch(path, NAVIGATE);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { type: string }).type).toBe(
        "urn:test-ui:error:UNAUTHORIZED",
      );
    }
    // Negative control: not a navigation, so the shell keeps the problem.
    expect((await router.fetch("/page")).status).toBe(401);
  });

  it("logs a throwing authorize and a failed bundle load under the UI's label", async () => {
    const thrown = testUi({
      authorize: () => {
        throw new Error("boom");
      },
    });
    const res = await thrown.router.fetch("/");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { type: string }).type).toBe(
      "urn:test-ui:error:INTERNAL",
    );
    expect(thrown.events.map((event) => event.message)).toEqual([
      "test ui authorize threw; refusing the request",
    ]);

    const broken = testUi({
      loadAssets: () => Promise.reject(new Error("no bundle")),
    });
    expect((await broken.router.fetch("/")).status).toBe(500);
    expect(broken.events.map((event) => event.message)).toEqual([
      "test ui could not load its bundle",
    ]);
  });

  it("answers HEAD on every route without a body", async () => {
    const { router } = testUi();
    for (const path of ["/", "/assets/main-abc.js", "/assets/nope.js"]) {
      const res = await router.fetch(path, { method: "HEAD" });
      expect(await res.text()).toBe("");
    }
  });
});

describe("decide", () => {
  it("allows only true and { allow: true }, 401 only for status 401, 403 otherwise", () => {
    expect(decide(true)).toEqual({ allow: true });
    expect(decide({ allow: true })).toEqual({ allow: true });
    expect(decide({ allow: false, status: 401, reason: "who?" })).toEqual({
      allow: false,
      status: 401,
      reason: "who?",
    });
    expect(decide({ allow: false, status: 429 })).toEqual({
      allow: false,
      status: 403,
    });
    for (const odd of [false, "yes", 1, null, undefined, {}]) {
      expect(decide(odd)).toEqual({ allow: false, status: 403 });
    }
  });
});
