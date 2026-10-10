/**
 * bun-common's `BunHttpAdapter` and `BunRouter` brought to the Express
 * behaviour bun-nest's adapter has (PR #320), pinned at the unit level. The
 * expected values are Express 5.2's, measured by bun-nest's
 * `expressCompat.common.test.ts`, which sends the same requests to
 * `@nestjs/platform-express`'s adapter:
 *
 * - views: the adapter and the router hold one `BunViews` (`views`), every
 *   response they build renders through it — served, `fetch()`, the error
 *   handlers, a `BunWebSocket`'s dedicated server — so its cache and locals
 *   are shared, and the adapter has Express's view helpers;
 * - the adapter's Nest-shaped `redirect`, `render`, `useStaticAssets` and
 *   `getRequestHostname` behave as platform-express's;
 * - a body that does not parse is routed by a bare router — `router.fetch()`
 *   and a `BunWebSocket` dedicated server alike, the refusal on
 *   `req.bodyDecodingError` — and refused before routing by the adapter.
 */
import type { ViewEngine } from "../lib/views";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { BunWebSocket } from "../lib/BunWebSocket";
import { createTestLogger } from "../lib/logging";
import { BunViews } from "../lib/views";

let root: string;
let pub: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bun-common-adapter-views-"));
  pub = await mkdtemp(join(tmpdir(), "bun-common-adapter-static-"));
  await writeFile(join(root, "page.tpl"), "page");
  await writeFile(join(pub, "a.txt"), "a");
  await mkdir(join(pub, "dir"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(pub, { recursive: true, force: true });
});

/** `<file name>|<locals as JSON>`, without the engine-only keys. */
const echoEngine: ViewEngine = (path, options, callback) => {
  const { settings: _s, _locals: _l, cache: _c, ...locals } = options;
  callback(
    null,
    `${path.slice(path.lastIndexOf("/") + 1)}|${JSON.stringify(locals)}`,
  );
};

const badJson = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: '{"a":',
};

describe("BunHttpAdapter views", () => {
  it("renders every response through the adapter's views, configured by Express's helpers", async () => {
    const app = new BunHttpAdapter();
    expect(app.views).toBeInstanceOf(BunViews);
    expect(app.setBaseViewsDir(root)).toBe(app);
    expect(app.setViewEngine("tpl")).toBe(app);
    expect(app.engine("tpl", echoEngine)).toBe(app);
    expect(app.setLocal("site", "S")).toBe(app);
    app.get("/page", (_req, res) => {
      res.locals.user = "u";
      res.render("page", { title: "T" });
    });

    const res = await app.fetch("/page");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe(
      'page.tpl|{"site":"S","user":"u","title":"T"}',
    );

    // Served, through the same views.
    await app.listen(0, "127.0.0.1");
    try {
      const served = await fetch(`${app.url}/page`);
      expect(await served.text()).toBe(
        'page.tpl|{"site":"S","user":"u","title":"T"}',
      );
    } finally {
      await app.close();
    }
  });

  it("takes a views option, and shares its cache across requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bun-common-adapter-cache-"));
    await writeFile(join(dir, "gone.tpl"), "x");
    const views = new BunViews();
    views.root = dir;
    views.defaultEngine = "tpl";
    views.engine("tpl", echoEngine);
    views.cache = true;
    const app = new BunHttpAdapter(0, { views });
    expect(app.views).toBe(views);
    app.get("/gone", (_req, res) => res.render("gone"));

    expect((await app.fetch("/gone")).status).toBe(200);
    // The second request finds the view in the cache the first one filled,
    // although the file is gone: one BunViews for every response.
    await unlink(join(dir, "gone.tpl"));
    const again = await app.fetch("/gone");
    expect(again.status).toBe(200);
    expect(await again.text()).toBe("gone.tpl|{}");
    await rm(dir, { recursive: true, force: true });
  });

  it("renders in the response its setErrorHandler handlers are given", async () => {
    const app = new BunHttpAdapter();
    app.setBaseViewsDir(root).setViewEngine("tpl").engine("tpl", echoEngine);
    app.get("/throws", () => {
      throw new Error("boom");
    });
    app.setErrorHandler((err, _req, res, _next) => {
      res.status(500).render("page", { message: (err as Error).message });
    });

    const res = await app.fetch("/throws");
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('page.tpl|{"message":"boom"}');
  });

  it("applies the view settings through set/enable/disable and warns once about any other", () => {
    const { logger, events } = createTestLogger();
    const app = new BunHttpAdapter(0, { logger });
    expect(app.set("views", [root, "/elsewhere"])).toBe(app);
    expect(app.views.root).toEqual([root, "/elsewhere"]);
    app.set("view engine", "tpl");
    expect(app.views.defaultEngine).toBe("tpl");
    app.enable("view cache");
    expect(app.views.cache).toBe(true);
    app.disable("view cache");
    expect(app.views.cache).toBe(false);
    app.set("view options", { delimiter: "?" });
    expect(app.views.settings["view options"]).toEqual({ delimiter: "?" });

    app.set("trust proxy", true);
    app.enable("trust proxy");
    const warnings = events.filter((event) => event.level === "warn");
    expect(warnings.map((event) => event.message)).toEqual([
      'set("trust proxy") has no effect on BunHttpAdapter: only the view settings ("views", "view engine", "view cache", "view options") apply',
    ]);
  });
});

describe("BunRouter views", () => {
  it("renders router.fetch() responses through the router's views", async () => {
    const views = new BunViews();
    views.root = root;
    views.defaultEngine = "tpl";
    views.engine("tpl", echoEngine);
    const router = new BunRouter({ views });
    expect(router.views).toBe(views);
    router.get("/page", (_req, res) => res.render("page", { a: 1 }));

    const res = await router.fetch("/page");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('page.tpl|{"a":1}');
  });

  it("creates its own views on first read, kept across requests", async () => {
    const router = new BunRouter();
    const views = router.views;
    expect(router.views).toBe(views);
    views.root = root;
    views.engine("tpl", echoEngine);
    views.locals.site = "S";
    router.get("/page", (_req, res) => res.render("page.tpl"));
    expect(await (await router.fetch("/page")).text()).toBe(
      'page.tpl|{"site":"S"}',
    );
  });

  it("renders a BunWebSocket dedicated server's responses through the router's views", async () => {
    const router = new BunRouter();
    router.views.root = root;
    router.views.engine("tpl", echoEngine);
    router.get("/page", (_req, res) => res.render("page.tpl", { b: 2 }));
    const ws = new BunWebSocket({
      router,
      newInstance: true,
      listen: { port: 0 },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ws.port}/page`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('page.tpl|{"b":2}');
    } finally {
      ws.killServer(ws.getServer());
    }
  });
});

describe("BunHttpAdapter's Nest-shaped helpers (as @nestjs/platform-express)", () => {
  let app: BunHttpAdapter;

  beforeAll(async () => {
    app = new BunHttpAdapter();
    app.setBaseViewsDir(root).setViewEngine("tpl").engine("tpl", echoEngine);
    app.useStaticAssets(pub, { prefix: "/static" });
    app.get("/redir", (_req, res) => app.redirect(res, 0, "/a b"));
    app.get("/redir-301", (_req, res) => app.redirect(res, 301, "/r"));
    app.get("/render", (_req, res) => {
      app.render(res, "page", { status: 201, title: "T" });
    });
    app.get("/render-missing", (_req, res) => app.render(res, "nope", {}));
    app.get("/host", (req, res) => {
      res.json({ host: app.getRequestHostname(req) });
    });
    await app.listen(0, "127.0.0.1");
  });

  afterAll(async () => {
    await app.close();
  });

  it("redirect: Express's status, encoded Location and body, 302 for 0", async () => {
    const res = await fetch(`${app.url}/redir`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/a%20b");
    expect(res.headers.get("vary")).toBe("Accept");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("Found. Redirecting to /a%20b");

    const permanent = await fetch(`${app.url}/redir-301`, {
      redirect: "manual",
      headers: { accept: "text/html" },
    });
    expect(permanent.status).toBe(301);
    expect(await permanent.text()).toBe(
      "<p>Moved Permanently. Redirecting to /r</p>",
    );
  });

  it("render: through the views, a status key only a local", async () => {
    const res = await fetch(`${app.url}/render`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe('page.tpl|{"status":201,"title":"T"}');

    // A missing view goes to the error handling: finalhandler's 500.
    const missing = await fetch(`${app.url}/render-missing`);
    expect(missing.status).toBe(500);
    expect(await missing.text()).toContain("<pre>Internal Server Error</pre>");
  });

  it("useStaticAssets: the bare prefix answers 301 to the directory", async () => {
    const res = await fetch(`${app.url}/static`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/static/");
    expect(await (await fetch(`${app.url}/static/a.txt`)).text()).toBe("a");
  });

  it("getRequestHostname: the host name without its port", async () => {
    const res = await fetch(`${app.url}/host`, {
      headers: { host: "a.example.com:8080" },
    });
    expect(await res.json()).toEqual({ host: "a.example.com" });
    const plain = await fetch(`${app.url}/host`);
    expect(await plain.json()).toEqual({ host: "127.0.0.1" });
  });
});

describe("a body that does not parse: a bare router routes it, the adapter refuses it", () => {
  /** A route reporting what it saw of the body. */
  function reportingRouter(): BunRouter {
    const router = new BunRouter();
    router.post("/j", (req, res) => {
      const refused = req.bodyDecodingError as
        | (Error & { status?: number; type?: string })
        | undefined;
      res.json({
        body: req.body ?? null,
        refused: refused ? [refused.name, refused.status, refused.type] : null,
      });
    });
    return router;
  }
  const routed = {
    body: null,
    refused: ["SyntaxError", 400, "entity.parse.failed"],
  };

  it("router.fetch() routes it, the refusal on req.bodyDecodingError", async () => {
    const res = await reportingRouter().fetch("/j", badJson);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(routed);
  });

  it("…exactly as a BunWebSocket dedicated server serving the router does", async () => {
    const ws = new BunWebSocket({
      router: reportingRouter(),
      newInstance: true,
      listen: { port: 0 },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ws.port}/j`, badJson);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(routed);
    } finally {
      ws.killServer(ws.getServer());
    }
  });

  it("the adapter answers it with finalhandler's 400 before any route", async () => {
    const app = new BunHttpAdapter();
    let ran = false;
    app.post("/j", (_req, res) => {
      ran = true;
      res.json({});
    });
    const res = await app.fetch("/j", badJson);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("<pre>Bad Request</pre>");
    expect(ran).toBe(false);
  });
});
