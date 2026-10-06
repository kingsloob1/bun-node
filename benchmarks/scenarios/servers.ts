/**
 * One scenario server per process, for `../wrk.ts`: `bun servers.ts <target>`
 * binds port 0, registers the shared route set and prints `READY <port>`, so
 * the load tool never shares an event loop (or a core) with the server.
 *
 * The route set every target registers identically:
 *
 *   GET  /static          -> "ok"
 *   GET  /user/:id        -> the id
 *   GET  /assets/*        -> "ok", a wildcard route (/assets/css/site/app.css)
 *   GET  /mw/hit          -> "mw:3", behind three `/mw` middleware that each
 *                            bump a counter on the request
 *   POST /json            -> {"ok":true,"n":<body.n>}
 *   GET  /async           -> "ok", from a handler that awaits once first
 *   GET  /headers         -> "ok" with Content-Type, Access-Control-Allow-Origin
 *                            and Vary set
 *   GET  /r<i>/:id        -> "r<i>:<id>" for i in 0..ROUTES-1 (ROUTES env,
 *                            default 1000): the lookup-cost set
 *
 * And one route per body type, each answering JSON built from what it parsed:
 *
 *   POST /form    urlencoded `a=1&b=two`        -> {"a":"1","b":"two"}
 *   POST /upload  multipart: field + 1 KiB file -> {"field":"v","size":1024}
 *   POST /binary  1 KiB application/octet-stream -> {"size":1024}
 *   POST /text    text/plain `hello world`      -> {"length":11}
 *   POST /xml     `<root><n>7</n></root>`       -> {"n":7}  (only where the
 *                 framework parses XML itself; see UNSUPPORTED in ../wrk.ts)
 *
 * bun-common and bun-nest run with `retainBuffer: false`: no other framework
 * keeps a body's bytes, so they do not either (the library default keeps them).
 *
 * Targets: bun-common, bun-nest, express, hono, elysia, elysia2, bun-serve
 * (Bun's native `routes`). hyper-express is a Node.js addon and runs from
 * `../hyper-express/scenarios.mjs` instead (see `../wrk.ts`).
 */
import process from "node:process";
import { BENCH_PARSE_BODY } from "./parse-body";

const ROUTES = Number(process.env.ROUTES ?? 1000);

/** The three headers `GET /headers` sets, on every target. */
export const HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "access-control-allow-origin": "*",
  vary: "Origin",
} as const;

/** One `/mw` middleware's work: count itself on the request. */
function bump(req: { hits?: number }): void {
  req.hits = (req.hits ?? 0) + 1;
}

type Req = {
  params: Record<string, string>;
  body: { n: number };
  hits?: number;
};
type Res = {
  send: (body: string) => unknown;
  json: (body: unknown) => unknown;
  set: (name: string, value: string) => Res;
};
type Next = () => void;
type ExpressStyle = {
  get: (
    path: string,
    ...handlers: ((req: Req, res: Res, next: Next) => unknown)[]
  ) => unknown;
  post: (
    path: string,
    ...handlers: ((req: Req, res: Res, next: Next) => unknown)[]
  ) => unknown;
  use: (
    path: string,
    ...handlers: ((req: Req, res: Res, next: Next) => unknown)[]
  ) => unknown;
};

/**
 * The shared route set on an Express-style API (bun-common, Express).
 * `wildcard` is the catch-all's spelling: Express 5 requires a named one.
 */
function registerExpressStyle(app: ExpressStyle, wildcard = "/assets/*"): void {
  const mw = (req: Req, _res: Res, next: Next) => {
    bump(req);
    next();
  };
  app.use("/mw", mw);
  app.use("/mw", mw);
  app.use("/mw", mw);
  app.get("/static", (_req, res) => res.send("ok"));
  app.get("/user/:id", (req, res) => res.send(req.params.id));
  app.get(wildcard, (_req, res) => res.send("ok"));
  app.get("/mw/hit", (req, res) => res.send(`mw:${req.hits}`));
  app.post("/json", (req, res) => res.json({ ok: true, n: req.body.n }));
  app.get("/async", async (_req, res) => {
    await null;
    res.send("ok");
  });
  app.get("/headers", (_req, res) => {
    res.set("content-type", HEADERS["content-type"]);
    res.set(
      "access-control-allow-origin",
      HEADERS["access-control-allow-origin"],
    );
    res.set("vary", HEADERS.vary);
    res.send("ok");
  });
  for (let i = 0; i < ROUTES; i++) {
    app.get(`/r${i}/:id`, (req, res) => res.send(`r${i}:${req.params.id}`));
  }
}

async function start(target: string | undefined): Promise<number> {
  switch (target) {
    case "bun-common": {
      // Default options (query, cookie and body parsing on, as an app has
      // them), doing no work the other frameworks skip: no body bytes kept,
      // no file-type sniffing of uploads.
      const lib = await import("../../packages/bun-common/lib/index");
      const adapter = new lib.BunHttpAdapter(0, {
        request: { retainBuffer: false, parseBody: BENCH_PARSE_BODY },
      });
      registerExpressStyle(adapter as unknown as ExpressStyle);
      const uploads = lib.transformUploadOptions({ storageType: "memory" });
      type BodyReq = { body: unknown };
      type JsonRes = { json: (body: unknown) => unknown };
      adapter.post("/form", (req, res) => {
        res.json((req as BodyReq).body as Record<string, string>);
      });
      adapter.post("/binary", (req, res) => {
        res.json({ size: ((req as BodyReq).body as Uint8Array).length });
      });
      adapter.post("/text", (req, res) => {
        res.json({ length: ((req as BodyReq).body as string).length });
      });
      adapter.post("/xml", (req, res) => {
        res.json({ n: ((req as BodyReq).body as { root: { n: unknown } }).root.n });
      });
      adapter.post("/upload", async (req, res) => {
        const { body, file } = await lib.handleMultipartSingleFile(
          req,
          "file",
          uploads,
        );
        (res as unknown as JsonRes).json({
          field: (body as { field: string }).field,
          size: file?.size,
        });
      });
      const server = await adapter.listen(0);
      return server.port!;
    }

    case "bun-nest": {
      const { startNest } = await import("./nest-app");
      return await startNest(ROUTES);
    }

    case "express": {
      const { default: express } = (await import("express")) as unknown as {
        default: (() => ExpressStyle & {
          listen: (
            port: number,
            cb: () => void,
          ) => { address: () => { port: number } };
        }) & { json: () => (req: Req, res: Res, next: Next) => void };
      };
      const app = express();
      app.use("/json", express.json());
      // Express parses neither XML nor multipart without another package.
      const mod = express as unknown as {
        urlencoded: (o: object) => (req: Req, res: Res, next: Next) => void;
        raw: (o: object) => (req: Req, res: Res, next: Next) => void;
        text: (o: object) => (req: Req, res: Res, next: Next) => void;
      };
      app.use("/form", mod.urlencoded({ extended: false }));
      app.use("/binary", mod.raw({ type: "application/octet-stream" }));
      app.use("/text", mod.text({ type: "text/plain" }));
      const body = (req: Req) => (req as unknown as { body: unknown }).body;
      app.post("/form", (req, res) => res.json(body(req)));
      app.post("/binary", (req, res) =>
        res.json({ size: (body(req) as Uint8Array).length }),
      );
      app.post("/text", (req, res) =>
        res.json({ length: (body(req) as string).length }),
      );
      registerExpressStyle(app, "/assets/*splat");
      return await new Promise<number>((resolve) => {
        const server = app.listen(0, () => resolve(server.address().port));
      });
    }

    case "hono": {
      const { Hono } = await import("hono");
      type Env = { Variables: { hits: number } };
      const app = new Hono<Env>();
      for (let i = 0; i < 3; i++) {
        app.use("/mw/*", async (c, next) => {
          c.set("hits", (c.get("hits") ?? 0) + 1);
          await next();
        });
      }
      app.get("/static", (c) => c.text("ok"));
      app.get("/user/:id", (c) => c.text(c.req.param("id")));
      app.get("/assets/*", (c) => c.text("ok"));
      app.get("/mw/hit", (c) => c.text(`mw:${c.get("hits")}`));
      app.post("/json", async (c) => {
        const body = await c.req.json<{ n: number }>();
        return c.json({ ok: true, n: body.n });
      });
      app.post("/form", async (c) => c.json(await c.req.parseBody()));
      app.post("/upload", async (c) => {
        const body = await c.req.parseBody();
        return c.json({ field: body.field, size: (body.file as File).size });
      });
      app.post("/binary", async (c) =>
        c.json({ size: (await c.req.arrayBuffer()).byteLength }),
      );
      app.post("/text", async (c) =>
        c.json({ length: (await c.req.text()).length }),
      );
      app.get("/async", async (c) => {
        await null;
        return c.text("ok");
      });
      app.get("/headers", (c) => {
        c.header(
          "access-control-allow-origin",
          HEADERS["access-control-allow-origin"],
        );
        c.header("vary", HEADERS.vary);
        return c.text("ok");
      });
      for (let i = 0; i < ROUTES; i++) {
        app.get(`/r${i}/:id`, (c) => c.text(`r${i}:${c.req.param("id")}`));
      }
      return Bun.serve({ port: 0, fetch: app.fetch }).port!;
    }

    case "elysia":
    case "elysia2": {
      // `elysia2` is the Elysia 2 beta (the alias in ../package.json).
      const { Elysia } = (await import(
        target === "elysia2" ? "elysia2" : "elysia"
      )) as typeof import("elysia");
      let app = new Elysia()
        .get("/static", () => "ok")
        .get("/user/:id", ({ params }) => params.id)
        .get("/assets/*", () => "ok")
        .guard(
          {
            beforeHandle: [
              (ctx) => void bump(ctx as { hits?: number }),
              (ctx) => void bump(ctx as { hits?: number }),
              (ctx) => void bump(ctx as { hits?: number }),
            ],
          },
          (g) =>
            g.get("/mw/hit", (ctx) => `mw:${(ctx as { hits?: number }).hits}`),
        )
        .get("/async", async () => {
          await null;
          return "ok";
        })
        .get("/headers", ({ set }) => {
          Object.assign(set.headers, HEADERS);
          return "ok";
        })
        .post("/json", ({ body }) => ({
          ok: true,
          n: (body as { n: number }).n,
        }))
        .post("/form", ({ body }) => body)
        .post("/upload", ({ body }) => {
          const form = body as { field: string; file: File };
          return { field: form.field, size: form.file.size };
        })
        .post("/binary", ({ body }) => ({
          size: (body as ArrayBuffer).byteLength,
        }))
        .post("/text", ({ body }) => ({ length: (body as string).length }));
      for (let i = 0; i < ROUTES; i++) {
        app = app.get(
          `/r${i}/:id`,
          ({ params }) => `r${i}:${params.id}`,
        ) as unknown as typeof app;
      }
      app.listen(0);
      return app.server!.port!;
    }

    case "bun-serve": {
      const routes: Record<string, unknown> = {
        "/static": () => new Response("ok"),
        "/assets/*": () => new Response("ok"),
        "/user/:id": (req: Bun.BunRequest<"/user/:id">) =>
          new Response(req.params.id),
        "/mw/hit": (req: Bun.BunRequest) => {
          const r = req as unknown as { hits?: number };
          bump(r);
          bump(r);
          bump(r);
          return new Response(`mw:${r.hits}`);
        },
        "/async": async () => {
          await null;
          return new Response("ok");
        },
        "/headers": () => new Response("ok", { headers: HEADERS }),
        "/json": {
          POST: async (req: Bun.BunRequest) => {
            const body = (await req.json()) as { n: number };
            return Response.json({ ok: true, n: body.n });
          },
        },
        "/form": {
          POST: async (req: Bun.BunRequest) =>
            Response.json(
              Object.fromEntries(new URLSearchParams(await req.text())),
            ),
        },
        "/upload": {
          POST: async (req: Bun.BunRequest) => {
            const form = await req.formData();
            return Response.json({
              field: form.get("field"),
              size: (form.get("file") as File).size,
            });
          },
        },
        "/binary": {
          POST: async (req: Bun.BunRequest) =>
            Response.json({ size: (await req.arrayBuffer()).byteLength }),
        },
        "/text": {
          POST: async (req: Bun.BunRequest) =>
            Response.json({ length: (await req.text()).length }),
        },
      };
      for (let i = 0; i < ROUTES; i++) {
        routes[`/r${i}/:id`] = (req: Bun.BunRequest<"/r0/:id">) =>
          new Response(`r${i}:${req.params.id}`);
      }
      return Bun.serve({
        port: 0,
        routes: routes as Record<string, () => Response>,
        fetch: () => new Response("Not Found", { status: 404 }),
      }).port!;
    }

    default:
      throw new Error(`unknown target ${target}`);
  }
}

if (import.meta.main) {
  const port = await start(process.argv[2]);
  console.log(`READY ${port}`);
}
