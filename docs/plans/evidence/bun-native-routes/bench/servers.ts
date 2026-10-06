/**
 * One benchmark server per process: `bun servers.ts <target>` binds port 0,
 * registers the shared route set and prints `READY <port>`. `run.ts` spawns
 * these, so the load tool never shares an event loop with the server.
 *
 * The route set every target registers identically:
 *
 *   GET  /static          -> "ok"
 *   GET  /user/:id        -> the id
 *   GET  /mw/hit          -> "mw:3", behind three `use("/mw", …)` middleware
 *                            that each bump a counter on the request
 *   POST /json            -> {"ok":true,"n":<body.n>}
 *   GET  /r<i>/:id        -> "r<i>:<id>" for i in 0..ROUTES-1 (ROUTES env,
 *                            default 1000) — the lookup-cost set
 *
 * Targets:
 *   raw-routes     Bun.serve native `routes`, hand-written middleware
 *   raw-fetch      Bun.serve `fetch` with a hand-written switch
 *   bun-common     @kingsleyweb/bun-common BunHttpAdapter, default options
 *   bun-common-lean  the same with body/cookie/query parsing off
 *   bun-nest       @kingsleyweb/bun-nest BunHttpAdapter in a Nest app
 *   elysia         Elysia 1.4 (from benchmarks/node_modules)
 *   elysia2        Elysia 2 beta (the `elysia2` alias in benchmarks/package.json)
 *   proto-*        the prototype variants in ../prototype (see there)
 */
import process from "node:process";

const ROUTES = Number(process.env.ROUTES ?? 1000);
const target = process.argv[2];

type Mw = (req: { hits?: number }) => void;
const bump: Mw = (req) => {
  req.hits = (req.hits ?? 0) + 1;
};

async function start(): Promise<number> {
  switch (target) {
    case "raw-routes": {
      const routes: Record<string, unknown> = {
        "/static": () => new Response("ok"),
        "/user/:id": (req: Bun.BunRequest<"/user/:id">) => new Response(req.params.id),
        "/mw/hit": (req: Bun.BunRequest) => {
          const r = req as unknown as { hits?: number };
          bump(r);
          bump(r);
          bump(r);
          return new Response(`mw:${r.hits}`);
        },
        "/json": {
          POST: async (req: Bun.BunRequest) => {
            const body = (await req.json()) as { n: number };
            return Response.json({ ok: true, n: body.n });
          },
        },
      };
      for (let i = 0; i < ROUTES; i++) {
        routes[`/r${i}/:id`] = (req: Bun.BunRequest<"/r0/:id">) => new Response(`r${i}:${req.params.id}`);
      }
      const server = Bun.serve({
        port: 0,
        routes: routes as Record<string, () => Response>,
        fetch: () => new Response("Not Found", { status: 404 }),
      });
      return server.port!;
    }

    case "raw-fetch": {
      const server = Bun.serve({
        port: 0,
        async fetch(req) {
          const { pathname } = new URL(req.url);
          if (pathname === "/static") return new Response("ok");
          if (pathname.startsWith("/user/")) return new Response(pathname.slice(6));
          if (pathname === "/mw/hit") {
            const r = req as unknown as { hits?: number };
            bump(r);
            bump(r);
            bump(r);
            return new Response(`mw:${r.hits}`);
          }
          if (pathname === "/json" && req.method === "POST") {
            const body = (await req.json()) as { n: number };
            return Response.json({ ok: true, n: body.n });
          }
          const m = /^\/r(\d+)\/([^/]+)$/.exec(pathname);
          if (m && Number(m[1]) < ROUTES) return new Response(`r${m[1]}:${m[2]}`);
          return new Response("Not Found", { status: 404 });
        },
      });
      return server.port!;
    }

    case "bun-common":
    case "bun-common-lean": {
      const { BunHttpAdapter } = await import("@kingsleyweb/bun-common");
      const adapter = new BunHttpAdapter(
        0,
        target === "bun-common-lean"
          ? { request: { parseBody: false, parseCookies: false, parseQuery: false } }
          : {},
      );
      registerExpressStyle(adapter);
      const server = await adapter.listen(0);
      return server.port!;
    }

    case "bun-nest": {
      const { startNest } = await import("./nest-app");
      return await startNest(ROUTES);
    }

    case "elysia":
    case "elysia2": {
      // `elysia2` is Elysia 2 (benchmarks/package.json aliases the beta).
      const { Elysia } = (await import(
        target === "elysia2" ? "../../../../../benchmarks/node_modules/elysia2" : "../../../../../benchmarks/node_modules/elysia"
      )) as typeof import("../../../../../benchmarks/node_modules/elysia");
      let app = new Elysia()
        .get("/static", () => "ok")
        .get("/user/:id", ({ params }) => params.id)
        .guard(
          {
            beforeHandle: [
              (ctx) => void bump(ctx as { hits?: number }),
              (ctx) => void bump(ctx as { hits?: number }),
              (ctx) => void bump(ctx as { hits?: number }),
            ],
          },
          (g) => g.get("/mw/hit", (ctx) => `mw:${(ctx as { hits?: number }).hits}`),
        )
        .post("/json", ({ body }) => ({ ok: true, n: (body as { n: number }).n }));
      for (let i = 0; i < ROUTES; i++) {
        app = app.get(`/r${i}/:id`, ({ params }) => `r${i}:${params.id}`) as unknown as typeof app;
      }
      app.listen(0);
      return app.server!.port!;
    }

    default: {
      if (target?.startsWith("proto-")) {
        // read by native-routes.ts at load: set before the first import
        if (target.includes("ceiling")) process.env.BNR_CEILING = "1";
        const { startPrototype } = await import("../prototype/bench-target");
        return await startPrototype(target, ROUTES, registerExpressStyle);
      }
      throw new Error(`unknown target ${target}`);
    }
  }
}

/** The shared route set, on anything with the Express-style BunRouter API. */
export function registerExpressStyle(app: {
  get: (...a: never[]) => unknown;
  post: (...a: never[]) => unknown;
  use: (...a: never[]) => unknown;
}): void {
  type Req = { params: Record<string, string>; body: { n: number }; hits?: number };
  type Res = { send: (b: string) => unknown; json: (b: unknown) => unknown };
  type Next = () => void;
  const a = app as unknown as {
    get: (path: string, ...h: ((req: Req, res: Res, next: Next) => unknown)[]) => void;
    post: (path: string, ...h: ((req: Req, res: Res, next: Next) => unknown)[]) => void;
    use: (path: string, ...h: ((req: Req, res: Res, next: Next) => unknown)[]) => void;
  };
  const mw = (req: Req, _res: Res, next: Next) => {
    bump(req);
    next();
  };
  a.use("/mw", mw);
  a.use("/mw", mw);
  a.use("/mw", mw);
  a.get("/static", (_req, res) => res.send("ok"));
  a.get("/user/:id", (req, res) => res.send(req.params.id));
  a.get("/mw/hit", (req, res) => res.send(`mw:${req.hits}`));
  a.post("/json", (req, res) => res.json({ ok: true, n: req.body.n }));
  for (let i = 0; i < ROUTES; i++) {
    a.get(`/r${i}/:id`, (req, res) => res.send(`r${i}:${req.params.id}`));
  }
}

if (import.meta.main) {
  const port = await start();
  console.log(`READY ${port}`);
}
