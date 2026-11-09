/**
 * Loads `BunHttpAdapter` over a stand-in for the core's
 * `MiddlewareModule.prototype.registerHandler`, in the shape one range of Nest
 * releases has, then reports how many times the core's exact `/api$` entry ran
 * a middleware for `GET /api/`. The adapter asks the core once, as its module
 * loads, so each shape needs a process of its own.
 *
 * `bun run.ts <shape>`; `coreMiddlewareProbe.test.ts` drives it.
 */
import { RequestMethod } from "@nestjs/common";
import { MiddlewareModule } from "@nestjs/core/middleware/middleware-module.js";

/** A middleware as the core hands it to an adapter. */
type Middleware = (req: object, res: object, next: () => void) => unknown;

/** What `registerHandler` reads of its `this`. */
interface Self {
  /** The core's path extractor: one route's paths. */
  routeInfoPathExtractor: { extractPathsFrom: (route: object) => string[] };
}

/** What `registerHandler` reads of the adapter. */
interface Adapter {
  /** The adapter's registration, per method. */
  createMiddlewareFactory: (
    method: unknown,
  ) => (path: string, handler: Middleware) => unknown;
}

/** Registers `handler` at each of the route's paths, as every shape does. */
async function mount(
  self: Self,
  adapter: Adapter,
  route: { method: unknown },
  handler: Middleware,
): Promise<void> {
  const router = await adapter.createMiddlewareFactory(route.method);
  for (const path of self.routeInfoPathExtractor.extractPathsFrom(route)) {
    router(path, handler);
  }
}

/** Runs `proxy` for the first path to match a request, and skips the others. */
function guarded(proxy: Middleware, handled: WeakSet<object>): Middleware {
  return (req, res, next) => {
    if (handled.has(req)) return next();
    handled.add(req);
    return proxy(req, res, next);
  };
}

/** `registerHandler`, in each shape it has had or may have. */
const SHAPES: Record<
  string,
  (
    this: Self,
    adapter: Adapter,
    route: { method: unknown },
    proxy: Middleware,
    handled: WeakSet<object>,
  ) => Promise<void>
> = {
  /** Up to 11.2.7 and 12.1.3: every matching path runs the middleware. */
  async noGuard(adapter, route, proxy) {
    await mount(this, adapter, route, proxy);
  },
  /** 11.2.8 on, and 12.2.0: guarded per request, by a set of its own. */
  async ownGuard(adapter, route, proxy) {
    await mount(this, adapter, route, guarded(proxy, new WeakSet()));
  },
  /** From 12.3.0: guarded per request, by a set its caller hands it. */
  async callerGuard(adapter, route, proxy, handled) {
    await mount(this, adapter, route, guarded(proxy, handled));
  },
  /** A core the probe cannot ask, whatever it changed. */
  async unreadable() {
    throw new TypeError("not the registerHandler the probe knows");
  },
};

const shape = SHAPES[process.argv[2] ?? ""];
if (!shape) throw new Error(`unknown shape: ${process.argv[2]}`);
Object.assign(MiddlewareModule.prototype, { registerHandler: shape });

const { BunHttpAdapter } = await import("../../../lib/BunHttpAdapter");
// The probe answers a few microtasks after the module loads.
await Bun.sleep(0);

const adapter = new BunHttpAdapter();
let runs = 0;
adapter.createMiddlewareFactory(RequestMethod.ALL)(
  "/api$",
  (_req: object, _res: object, next: () => void) => {
    runs++;
    next();
  },
);
await adapter.fetch("/api/");
process.stdout.write(`${JSON.stringify({ runs })}\n`);
