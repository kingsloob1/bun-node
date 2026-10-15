/** Item 10: HTTP QUERY end to end — @QueryMethod() route and middleware bound to RequestMethod.QUERY. */
import * as common from "@nestjs/common";
import { Body, Controller, Get, MiddlewareConsumer, Module, NestModule, RequestMethod } from "@nestjs/common";
import { build, kind, runCases, snap } from "./harness";

const QueryMethod: any = (common as any).QueryMethod;
const QUERY = (RequestMethod as any).QUERY;

function makeModule(withMiddleware: boolean) {
  @Controller("search")
  class C {
    @QueryMethod()
    q(@Body() body: any, @common.Req() req: any) {
      return { method: req.method, body, mw: req.mw ?? null };
    }
    @Get()
    g(@common.Req() req: any) {
      return { method: req.method, mw: req.mw ?? null };
    }
  }
  @Module({ controllers: [C] })
  class M implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      if (!withMiddleware) return;
      consumer
        .apply((req: any, _res: any, next: any) => {
          req.mw = "query-mw";
          next();
        })
        .forRoutes({ path: "search", method: QUERY });
    }
  }
  return M;
}

/** Feasibility of the fix: give BunRouter a `query()` and map RequestMethod.QUERY, on this adapter only. */
function patchBun(app: any) {
  const adapter = app.getHttpAdapter();
  const router = adapter.getInstance();
  router.query = function (...args: any[]) {
    return this.addRoute("query", ...args);
  };
  const orig = adapter.getRequestMethodStr.bind(adapter);
  adapter.getRequestMethodStr = (m: number) => (m === QUERY ? "query" : orig(m));
}

async function scenario(withMiddleware: boolean, patch = false) {
  if (!QueryMethod) return "not-applicable: no @QueryMethod in this @nestjs/common";
  let b;
  try {
    b = await build(makeModule(withMiddleware), {}, { setup: patch ? patchBun : undefined });
  } catch (e) {
    return { startupThrew: String(e).slice(0, 200) };
  }
  try {
    return {
      query: await snap(await b.request("/search", { method: "QUERY", headers: { "content-type": "application/json" }, body: '{"q":"x"}' })),
      get: await snap(await b.request("/search")),
    };
  } finally {
    await b.close();
  }
}

await runCases("10-query-method", {
  route: () => scenario(false),
  routeAndMiddleware: () => scenario(true),
  bunPatchedRouteAndMiddleware: () => (kind === "bun" ? scenario(true, true) : Promise.resolve("bun only")),
});
