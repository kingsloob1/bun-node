/** Item 3 helper: what exception object reaches Nest's filters for each pre-route failure. */
import { ArgumentsHost, Body, Catch, Controller, ExceptionFilter, Get, Module, Param, Post } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import { build, runCases, snap } from "./harness";

const seen: unknown[] = [];
@Catch()
class Spy extends BaseExceptionFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    seen.push({
      ctor: exception?.constructor?.name,
      name: exception?.name,
      message: exception?.message,
      status: exception?.status,
      statusCode: exception?.statusCode,
      expose: exception?.expose,
      type: exception?.type,
      ownKeys: exception && typeof exception === "object" ? Object.keys(exception) : typeof exception,
    });
    return super.catch(exception, host);
  }
}
@Controller()
class C {
  @Post("echo")
  echo(@Body() body: any) {
    return { body };
  }
  @Get("p/:id")
  p(@Param("id") id: string) {
    return { id };
  }
}
@Module({ controllers: [C] })
class M {}

await runCases("03b-exception-shapes", {
  cases: async () => {
    const b = await build(M, {}, {
      setup: (app) => {
        app.useGlobalFilters(new Spy(app.getHttpAdapter()));
        app.use((req: any, _res: any, next: any) => ((req.originalUrl ?? req.url) === "/mw/obj" ? next({ statusCode: 409, message: "conflict" }) : next()));
        app.useBodyParser("json", { limit: "1kb" });
      },
    });
    const out: Record<string, unknown> = {};
    try {
      for (const [k, init, path] of [
        ["invalidJson", { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" }, "/echo"],
        ["overLimit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: "x".repeat(4000) }) }, "/echo"],
        ["badPercentParam", {}, "/p/%FF"],
        ["mwPlainObject", {}, "/mw/obj"],
      ] as const) {
        seen.length = 0;
        const res = await snap(await b.request(path, init as RequestInit));
        out[k] = { status: res.status, seen: [...seen] };
      }
      return out;
    } finally {
      await b.close();
    }
  },
});
