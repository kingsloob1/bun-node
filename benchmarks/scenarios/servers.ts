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
 * Targets: bun-common, bun-nest, express, hono, elysia, elysia2, bun-serve
 * (Bun's native `routes`). hyper-express is a Node.js addon and runs from
 * `../hyper-express/scenarios.mjs` instead (see `../wrk.ts`).
 */
import process from "node:process";

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
      const { BunHttpAdapter } =
        await import("../../packages/bun-common/lib/index");
      // Default options: query, cookie and body parsing on, as an app has them.
      const adapter = new BunHttpAdapter(0, {});
      registerExpressStyle(adapter as unknown as ExpressStyle);
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
        }));
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
