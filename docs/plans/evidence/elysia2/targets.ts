/**
 * The shared route set of `../bun-native-routes/bench/servers.ts`, built
 * in process (no socket) for every target, each exposing the function
 * `Bun.serve` would call: `(request) => Response | Promise<Response>`.
 *
 * Imported by `inproc.ts` and `profile.ts`. `NODE_ENV=production` should be
 * set by the caller, as `wrk-run.ts` sets it for the servers.
 */
import process from "node:process";
import { registerExpressStyle } from "../bun-native-routes/bench/servers";

export const ROUTES = Number(process.env.ROUTES ?? 1000);
export type Serve = (request: Request) => Response | Promise<Response | undefined> | undefined;
const stub = { requestIP: () => null, upgrade: () => false, port: 0 } as never;

const bump = (req: { hits?: number }) => {
  req.hits = (req.hits ?? 0) + 1;
};

/**
 * Where bun-common and bun-nest are loaded from: the repo's own packages by
 * default, or a snapshot (`PKG_ROOT=<dir holding bun-common/ and bun-nest/>`)
 * so a measurement can pin a commit while the working tree changes.
 */
const PKG_ROOT = process.env.PKG_ROOT ?? "@kingsleyweb";

const E2 = "../../../../benchmarks/node_modules/elysia2/dist/index.mjs";
const E2_ORIGIN = "../../../../benchmarks/node_modules/elysia2/dist/adapter/origin.mjs";
const E1 = "../../../../benchmarks/node_modules/elysia/dist/index.mjs";

/** Elysia's app with the shared routes (same code as servers.ts). */
async function elysiaApp(path: string) {
  const { Elysia } = (await import(path)) as typeof import("../../../../benchmarks/node_modules/elysia");
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
  return app;
}

export async function makeTarget(name: string): Promise<Serve> {
  switch (name) {
    case "elysia2": {
      const app = await elysiaApp(E2);
      const fetch = app.fetch as unknown as (r: Request, s: unknown) => Response;
      // What the Bun adapter wraps `fetch` in (adapter/bun/index.mjs
      // `withOrigin`): marks the request as Bun's own, so the abort signal
      // is not materialised on the synchronous lane.
      const { origin } = (await import(E2_ORIGIN)) as { origin: { request?: Request } };
      return (request) => {
        origin.request = request;
        try {
          return fetch(request, stub);
        } finally {
          origin.request = undefined;
        }
      };
    }
    case "elysia1": {
      const app = await elysiaApp(E1);
      const fetch = app.fetch as unknown as (r: Request) => Response;
      return (request) => fetch(request);
    }
    case "bun-common":
    case "bun-common-nocache":
    case "bun-common-lean": {
      const { BunHttpAdapter } = (await import(`${PKG_ROOT}/bun-common`)) as typeof import("@kingsleyweb/bun-common");
      const adapter = new BunHttpAdapter(
        0,
        name === "bun-common-lean"
          ? { request: { parseBody: false, parseCookies: false, parseQuery: false } }
          : name === "bun-common-nocache"
            ? { routeCacheMax: 0 }
            : {},
      );
      registerExpressStyle(adapter as never);
      const serve = (adapter as unknown as { serveNativeRequest: (r: Request, s: unknown) => Response }).serveNativeRequest.bind(adapter);
      return (request) => serve(request, stub);
    }
    case "bun-nest":
    case "bun-nest-nobp": {
      const { initNest } = await import("./nest-app");
      const { BunHttpAdapter } = (await import(`${PKG_ROOT}/bun-nest`)) as typeof import("@kingsleyweb/bun-nest");
      const adapter = new BunHttpAdapter();
      // `bun-nest-nobp`: Nest's `bodyParser: false`, so bun-nest registers no
      // parser middleware (the json scenario then has no body to read).
      await initNest(ROUTES, adapter, name === "bun-nest-nobp" ? { bodyParser: false } : {});
      const serve = (adapter as unknown as { serveNativeRequest: (r: Request, s: unknown) => Response }).serveNativeRequest.bind(adapter);
      return (request) => serve(request, stub);
    }
    case "raw": {
      // The hand-written floor: what a framework-free `fetch` does.
      return (req) => {
        const url = req.url;
        const s = url.indexOf("/", 8);
        const q = url.indexOf("?", s);
        const pathname = q === -1 ? url.slice(s) : url.slice(s, q);
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
          return req.json().then((body) => Response.json({ ok: true, n: (body as { n: number }).n }));
        }
        const slash = pathname.indexOf("/", 1);
        return new Response(`${pathname.slice(1, slash)}:${pathname.slice(slash + 1)}`);
      };
    }
    default:
      throw new Error(`unknown target ${name}`);
  }
}

/** One fresh native request per call, as `Bun.serve` hands `fetch`. */
export const SCENARIOS: Record<string, () => Request> = {
  "static": () => new Request("http://localhost/static"),
  "param": () => new Request("http://localhost/user/42"),
  "middleware": () => new Request("http://localhost/mw/hit"),
  "routes-1000": () => new Request(`http://localhost/r${ROUTES - 1}/7`),
  "param-random": () => new Request(`http://localhost/r${ROUTES - 1}/${10_000_000 + ((Math.random() * 89_999_999) | 0)}`),
  "json": () =>
    new Request("http://localhost/json", {
      method: "POST",
      body: '{"n":7}',
      headers: { "content-type": "application/json" },
    }),
};

/** The body each target must answer with (a correctness check, not timed). */
export async function check(serve: Serve, scenario: string): Promise<string> {
  const r = await serve(SCENARIOS[scenario]());
  if (!r) return "<none>";
  return `${r.status} ${r.headers.get("content-type")} ${await r.text()}`;
}
