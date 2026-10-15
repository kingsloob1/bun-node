/** Item 3: mapException (#adapter error mapping), errorCode, #17709 statusCode errors. */
import { BadRequestException, Body, Controller, Get, HttpException, Module, Param, Post } from "@nestjs/common";
import { build, runCases, snap } from "./harness";

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
  @Get("code")
  code() {
    throw new BadRequestException("with code", { errorCode: "E_CODE" } as any);
  }
  @Get("code-plain")
  codePlain() {
    throw new HttpException("plain", 409, { errorCode: "E_PLAIN" } as any);
  }
  @Get("route-status-error")
  routeStatusError() {
    throw Object.assign(new Error("teapot from route"), { statusCode: 418 });
  }
}
@Module({ controllers: [C] })
class M {}

const errors: Record<string, () => unknown> = {
  plainError: () => new Error("boom"),
  errorWithStatusCode: () => Object.assign(new Error("teapot"), { statusCode: 418 }),
  httpErrorsShape: () => Object.assign(new Error("unprocessable"), { status: 422, statusCode: 422, expose: true }),
  plainObject: () => ({ statusCode: 409, message: "conflict" }),
  syntaxError: () => new SyntaxError("bad syntax"),
  uriError: () => new URIError("URI malformed"),
  string: () => "a string",
};

function setup(app: any) {
  app.use((req: any, res: any, next: any) => {
    const url: string = req.originalUrl ?? req.url;
    const m = /^\/mw\/(\w+)/.exec(url);
    if (m && errors[m[1]]) return next(errors[m[1]]());
    next();
  });
  app.useBodyParser("json", { limit: "1kb" });
}

await runCases("03-exceptions", {
  cases: async () => {
    const b = await build(M, {}, { setup });
    try {
      const r: Record<string, unknown> = {};
      const json = { "content-type": "application/json" };
      r.invalidJson = await snap(await b.request("/echo", { method: "POST", headers: json, body: "{bad" }));
      r.overLimit = await snap(await b.request("/echo", { method: "POST", headers: json, body: JSON.stringify({ a: "x".repeat(4000) }) }));
      r.badEncoding = await snap(await b.request("/echo", { method: "POST", headers: { ...json, "content-encoding": "br-nope" }, body: "{}" }));
      r.badPercentParam = await snap(await b.request("/p/%FF"));
      r.errorCode = await snap(await b.request("/code"));
      r.errorCodePlain = await snap(await b.request("/code-plain"));
      r.routeStatusError = await snap(await b.request("/route-status-error"));
      for (const name of Object.keys(errors)) r[`mw_${name}`] = await snap(await b.request(`/mw/${name}`));
      return r;
    } finally {
      await b.close();
    }
  },
});
