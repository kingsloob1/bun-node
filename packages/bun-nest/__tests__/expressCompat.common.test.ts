/**
 * Differential test of **bun-common's** `BunHttpAdapter` against
 * `@nestjs/platform-express`'s `ExpressAdapter`, with no Nest application:
 * the same adapter calls — the view settings (`setBaseViewsDir`,
 * `setViewEngine`, `engine`, `setLocal`, `set`, `enable`), `render`,
 * `redirect`, `useStaticAssets`, `getRequestHostname`, `setErrorHandler` and
 * the body parser — made on each adapter, and the same requests sent to the
 * Express server, to bun-common's adapter served on port 0, and to its
 * socket-free `fetch()`. The two bun-common columns must also agree with
 * each other.
 *
 * It is the bun-common column of `expressCompat.nest.test.ts` (same
 * fixtures, same normalisation, same reasons for the known differences); it
 * lives in bun-nest because Express is a devDependency here.
 *
 * Express runs with `env` set to `production`, so its `finalhandler` answers
 * an unhandled error with the status message rather than the stack — what
 * bun-common's `finalErrorResponse` always does.
 */
import type { Observed } from "./expressCompat/app";
import type { KnownDifference } from "./expressCompat/probes";
import { BunHttpAdapter as CommonHttpAdapter } from "@kingsleyweb/bun-common";
import { ExpressAdapter } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  comparable,
  observe,
  observeResponse,
  PUBLIC,
  VIEWS,
} from "./expressCompat/app";
import {
  BODY_CHANGES,
  SERVE_STATIC_REDIRECT,
  STATIC_VARY,
} from "./expressCompat/probes";

/** A request handler, typed loosely: each adapter passes its own req/res. */
type Handler = (req: any, res: any, next: (err?: unknown) => void) => unknown;

/** The adapter surface both adapters offer and the apps below use. */
interface AdapterLike {
  get: (path: string, handler: Handler) => unknown;
  post: (path: string, handler: Handler) => unknown;
  render: (res: any, view: string, options?: any) => unknown;
  redirect: (res: any, status: number, url: string) => unknown;
  useStaticAssets: (path: string, options: any) => unknown;
  getRequestHostname: (req: any) => string;
  setBaseViewsDir: (path: string | string[]) => unknown;
  setViewEngine: (engine: string) => unknown;
  engine: (
    ext: string,
    fn: (
      path: string,
      options: Record<string, unknown>,
      cb: (err: Error | null, html?: string) => void,
    ) => void,
  ) => unknown;
  setLocal: (key: string, value: unknown) => unknown;
  set: (setting: string, value: unknown) => unknown;
  enable: (setting: string) => unknown;
  disable: (setting: string) => unknown;
  setErrorHandler: (handler: (...args: any[]) => unknown) => unknown;
  registerParserMiddleware: (prefix?: string, rawBody?: boolean) => unknown;
}

/** A probe: a name, a path and its `RequestInit`. */
interface Probe {
  name: string;
  path: string;
  init?: RequestInit;
}

/** An application configured identically on both adapters, and its probes. */
interface Group {
  name: string;
  configure: (app: AdapterLike) => void;
  probes: Probe[];
}

const html = { headers: { accept: "text/html" } };
const json = { headers: { accept: "application/json" } };
const badJson = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: '{"a":',
};

/** An engine for `.tpl`: `<file name>|<title>|<site>`, called back async. */
const tplEngine: Parameters<AdapterLike["engine"]>[1] = (path, options, cb) => {
  setTimeout(() => {
    cb(
      null,
      `${path.slice(path.lastIndexOf("/") + 1)}|${String(options.title)}|${String(options.site)}`,
    );
  }, 0);
};

const GROUPS: Group[] = [
  {
    name: "helpers",
    configure: (app) => {
      app.setBaseViewsDir(VIEWS);
      app.setViewEngine("ejs");
      app.setLocal("appName", "Common");
      app.useStaticAssets(PUBLIC, { prefix: "/static", maxAge: 1000 });
      app.registerParserMiddleware();

      app.get("/render", (_req, res) => {
        app.render(res, "index", { title: "T" });
      });
      app.get("/render-status", (_req, res) => {
        app.render(res, "status", { status: 201 });
      });
      app.get("/render-ext", (_req, res) => app.render(res, "plain.ejs", {}));
      app.get("/render-dir", (_req, res) => app.render(res, "sub", {}));
      app.get("/render-missing", (_req, res) => app.render(res, "nope", {}));
      app.get("/render-broken", (_req, res) => app.render(res, "broken", {}));
      app.get("/res-render", (_req, res) => {
        res.locals.resLocal = "L";
        res.render("index", { title: "R" });
      });
      app.get("/redir", (_req, res) => app.redirect(res, 302, "/a b/ü?q=1 2"));
      app.get("/redir-301", (_req, res) => app.redirect(res, 301, "/r"));
      app.get("/host", (req, res) => {
        res.json({ host: app.getRequestHostname(req) });
      });
      app.post("/echo", (req, res) => {
        res.json({ body: req.body ?? null });
      });
      app.get("/throws", () => {
        throw new Error("boom");
      });
      // Registered last, as Express needs: its `setErrorHandler` is `use()`.
      app.setErrorHandler((err: Error, _req: any, res: any, next: any) => {
        if (err.message !== "boom") {
          next(err);
          return;
        }
        res.status(500);
        res.render("index", { title: `error: ${err.message}` });
      });
    },
    probes: [
      { name: "render with locals and setLocal", path: "/render" },
      { name: "render {status} is a local", path: "/render-status" },
      { name: "render with extension", path: "/render-ext" },
      { name: "render directory index", path: "/render-dir" },
      { name: "render missing view", path: "/render-missing" },
      { name: "render template throws", path: "/render-broken" },
      { name: "HEAD render", path: "/render", init: { method: "HEAD" } },
      { name: "res.render + res.locals", path: "/res-render" },
      { name: "error handler renders", path: "/throws" },
      { name: "redirect default Accept", path: "/redir" },
      { name: "redirect Accept html", path: "/redir", init: html },
      { name: "redirect Accept json", path: "/redir", init: json },
      { name: "redirect HEAD", path: "/redir", init: { method: "HEAD" } },
      { name: "redirect 301", path: "/redir-301" },
      { name: "hostname", path: "/host" },
      {
        name: "hostname, Host with port",
        path: "/host",
        init: { headers: { host: "a.example.com:8080" } },
      },
      { name: "static prefix without slash", path: "/static" },
      { name: "static index", path: "/static/" },
      { name: "static file", path: "/static/a.txt" },
      { name: "static dir without slash", path: "/static/dir" },
      {
        name: "JSON body",
        path: "/echo",
        init: { ...badJson, body: '{"a":1}' },
      },
      { name: "invalid JSON", path: "/echo", init: badJson },
    ],
  },
  {
    name: "settings",
    configure: (app) => {
      app.set("views", [PUBLIC, VIEWS]);
      app.set("view engine", "tpl");
      app.engine("tpl", tplEngine);
      app.enable("view cache");
      app.disable("view cache");
      app.setLocal("site", "S");
      app.get("/page", (_req, res) => app.render(res, "page", { title: "P" }));
    },
    probes: [{ name: "set() views + view engine, engine()", path: "/page" }],
  },
];

/** Fields known to differ from Express, keyed `"<group>/<probe>"`. */
const KNOWN: Record<string, KnownDifference> = {
  "helpers/static file": { fields: ["vary"], reason: STATIC_VARY },
  "helpers/static index": { fields: ["vary"], reason: STATIC_VARY },
  "helpers/static prefix without slash": {
    fields: BODY_CHANGES,
    reason: SERVE_STATIC_REDIRECT,
  },
  "helpers/static dir without slash": {
    fields: BODY_CHANGES,
    reason: SERVE_STATIC_REDIRECT,
  },
};

/** The two servers of one group. */
interface Booted {
  express: { adapter: ExpressAdapter; base: string };
  common: { adapter: CommonHttpAdapter; base: string };
}

async function boot(group: Group): Promise<Booted> {
  const express = new ExpressAdapter();
  // finalhandler shows the status message, not the stack, in production.
  express.set("env", "production");
  group.configure(express as unknown as AdapterLike);
  express.initHttpServer({});
  await new Promise<void>((resolve) => {
    express.listen(0, "127.0.0.1", () => resolve());
  });
  const address = express.getHttpServer().address() as { port: number };

  // Express's `etag` setting is on (weak) by default; bun-common's is off.
  const common = new CommonHttpAdapter(0, { etag: "weak" });
  group.configure(common as unknown as AdapterLike);
  await common.listen(0, "127.0.0.1");

  return {
    express: { adapter: express, base: `http://127.0.0.1:${address.port}` },
    common: { adapter: common, base: common.url.replace(/\/$/, "") },
  };
}

/**
 * Sends `probe` through bun-common's `fetch()`, with no socket involved. A
 * `Host` header becomes the URL's host, as `Bun.serve` builds a request's URL
 * from it: `fetch()` reads the host from the URL, not from the header.
 */
async function viaFetch(
  adapter: CommonHttpAdapter,
  base: string,
  probe: Probe,
): Promise<Observed> {
  const host = new Headers(probe.init?.headers).get("host");
  const origin = host ? `http://${host}` : base;
  return observeResponse(
    await adapter.fetch(new Request(`${origin}${probe.path}`, probe.init)),
  );
}

function describeGroup(group: Group) {
  describe(`bun-common adapter vs platform-express: ${group.name}`, () => {
    let apps: Booted | undefined;

    beforeAll(async () => {
      apps = await boot(group);
    });

    afterAll(async () => {
      await apps?.express.adapter.close();
      await apps?.common.adapter.close();
    });

    for (const probe of group.probes) {
      const known = KNOWN[`${group.name}/${probe.name}`];
      it(`${probe.init?.method ?? "GET"} ${probe.path} — ${probe.name}`, async () => {
        const express = comparable(
          await observe(apps!.express.base, probe.path, probe.init),
        );
        const served = comparable(
          await observe(apps!.common.base, probe.path, probe.init),
        );
        const fetched = comparable(
          await viaFetch(apps!.common.adapter, apps!.common.base, probe),
        );

        // Served and socket-free answer identically, but for the
        // `Content-Length` Bun adds as it writes a body to the socket.
        const { "content-length": _servedLength, ...servedRest } = served;
        const { "content-length": _fetchedLength, ...fetchedRest } = fetched;
        expect(fetchedRest).toEqual(servedRest);

        const names = new Set([
          ...Object.keys(express),
          ...Object.keys(served),
        ]);
        const differing = [...names].filter(
          (name) => express[name] !== served[name],
        );
        const unexpected = differing.filter(
          (name) => !known?.fields.includes(name),
        );

        // Every field outside the known differences is Express's.
        expect(
          Object.fromEntries(unexpected.map((name) => [name, served[name]])),
        ).toEqual(
          Object.fromEntries(unexpected.map((name) => [name, express[name]])),
        );

        // A known difference that no longer differs is taken off the list.
        const stale = (known?.fields ?? []).filter(
          (name) => !differing.includes(name),
        );
        expect(stale).toEqual([]);
      });
    }
  });
}

for (const group of GROUPS) {
  describeGroup(group);
}
