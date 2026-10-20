/**
 * Whether the installed `@nestjs/core` runs a middleware once per request
 * when several of its paths match it (12.2.0), asked the way
 * `BunHttpAdapter` asks it: through the core's own
 * `MiddlewareModule.prototype.registerHandler`, with stand-ins, one
 * middleware registered at two paths and the same request sent through both.
 * The tests read it inside a test, never at the top level (top-level `await`
 * perturbs decorator metadata in the gateway test files).
 */
import { RequestMethod } from "@nestjs/common";
import { MiddlewareModule } from "@nestjs/core/middleware/middleware-module.js";

/** A middleware as the core registers it. */
type Middleware = (req: object, res: object, next: () => void) => unknown;

/** Resolves `true` where the core runs a middleware once per request. */
export async function coreRunsMiddlewareOnce(): Promise<boolean> {
  const registerHandler = (
    MiddlewareModule.prototype as unknown as Record<
      string,
      (...args: unknown[]) => Promise<void>
    >
  ).registerHandler;
  const registered: Middleware[] = [];
  let runs = 0;
  await registerHandler.call(
    { routeInfoPathExtractor: { extractPathsFrom: () => ["/a", "/b"] } },
    {
      createMiddlewareFactory: () => (_path: string, h: Middleware) =>
        registered.push(h),
    },
    { path: "a", method: RequestMethod.ALL },
    (_req: object, _res: object, next: () => void) => {
      runs++;
      next();
    },
  );
  const req = {};
  for (const h of registered) {
    await h(req, {}, () => {});
  }
  return registered.length === 2 && runs === 1;
}
