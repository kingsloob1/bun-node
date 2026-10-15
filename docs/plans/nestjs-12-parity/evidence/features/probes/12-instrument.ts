/**
 * Item 12: instrumentation — `instrument.instanceDecorator`, and the adapter
 * introspection hooks setOnRouteTriggered / setOnRequestHook / setOnResponseHook.
 */
import { Controller, Get, Injectable, Module, Param } from "@nestjs/common";
import { build, runCases, sleep, snap } from "./harness";

const ev: any = { decorated: [] as string[], mwCalls: 0, routeTriggered: [] as unknown[], requestHook: 0, responseHook: [] as unknown[] };

@Injectable()
class Svc {
  hello() {
    return "hi";
  }
}
@Controller("i")
class C {
  constructor(private readonly svc: Svc) {}
  @Get(":id")
  get(@Param("id") id: string) {
    return { id, svc: this.svc.hello() };
  }
}
@Module({ controllers: [C], providers: [Svc] })
class M {}

const instrument = {
  instanceDecorator: (instance: any) => {
    ev.decorated.push(typeof instance === "function" ? `fn:${instance.name || "anonymous"}` : instance?.constructor?.name);
    if (typeof instance === "function") {
      const wrapped = (...args: any[]) => {
        ev.mwCalls++;
        return instance(...args);
      };
      return wrapped;
    }
    return instance;
  },
};

await runCases("12-instrument", {
  all: async () => {
    const b = await build(M, { instrument }, {
      setup: (app) => {
        const a = app.getHttpAdapter();
        a.setOnRouteTriggered?.((method: unknown, path: unknown) => ev.routeTriggered.push({ method, path }));
        a.setOnRequestHook?.((req: any, _res: any, done: () => void) => {
          ev.requestHook++;
          done();
        });
        a.setOnResponseHook?.((req: any, res: any) => {
          ev.responseHook.push(res?.statusCode);
        });
        app.use(function plainMiddleware(_req: any, _res: any, next: any) {
          next();
        });
      },
    });
    try {
      const res = await snap(await b.request("/i/7"));
      await sleep(100);
      return {
        res,
        decoratedIncludes: {
          Svc: ev.decorated.includes("Svc"),
          C: ev.decorated.includes("C"),
          plainMiddleware: ev.decorated.includes("fn:plainMiddleware"),
        },
        decoratedMiddlewareCalls: ev.mwCalls,
        routeTriggered: ev.routeTriggered,
        requestHookCalls: ev.requestHook,
        responseHookStatuses: ev.responseHook,
      };
    } finally {
      await b.close();
    }
  },
});
