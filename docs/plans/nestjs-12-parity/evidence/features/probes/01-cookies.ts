/** Item 1: Nest 12 built-in cookies (#17834) vs bun-common's cookie parsing. */
import * as common from "@nestjs/common";
import { Controller, Get, Module, Res } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { createHmac } from "node:crypto";
import { build, kind, runCases, snap } from "./harness";

const Cookies: any = (common as any).Cookies;
const SignedCookies: any = (common as any).SignedCookies;
const has = typeof Cookies === "function";

function sign(value: string, secret: string) {
  return `s:${value}.${createHmac("sha256", secret).update(value).digest("base64").replace(/=+$/, "")}`;
}
const SECRET = "nest-secret";
const cookieHeader = [
  "a=b",
  `s=${encodeURIComponent(sign("v", SECRET))}`,
  `bad=${encodeURIComponent("s:v.badsig")}`,
  `j=${encodeURIComponent('j:{"x":1}')}`,
  "enc=%E2%82%AC",
  "dup=1",
  "dup=2",
  'q="quoted"',
  "constructor=c",
].join("; ");

function makeModule() {
  if (!has) return undefined;
  @Controller()
  class C {
    constructor(private readonly host: HttpAdapterHost) {}
    @Get("read")
    read(@Cookies() all: any, @Cookies("a") a: any, @Cookies("j") j: any, @Cookies("toString") ts: any) {
      return { all, a, j, toStringType: typeof ts };
    }
    @Get("read-signed")
    readSigned(@SignedCookies() all: any, @SignedCookies("s") s: any, @SignedCookies("bad") bad: any) {
      return { all, s, bad: bad === undefined ? "undefined" : bad };
    }
    @Get("set")
    set(@Res({ passthrough: true }) res: any) {
      const a = this.host.httpAdapter as any;
      a.setCookie(res, "plain", "v 1", { httpOnly: true, path: "/" });
      try {
        a.setCookie(res, "signed", "v2", { signed: true });
      } catch (e) {
        return { setSignedThrew: String(e) };
      }
      a.clearCookie(res, "gone", { path: "/" });
      return "ok";
    }
  }
  @Module({ controllers: [C] })
  class M {}
  return M;
}

const headers = { cookie: cookieHeader };
async function scenario(options: any, bunOptions?: any, setup?: (app: any) => void) {
  const M = makeModule();
  if (!M) return "not-applicable: @nestjs/common has no Cookies decorator";
  const b = await build(M, options, { bunOptions, setup });
  try {
    return {
      read: await snap(await b.request("/read", { headers })),
      readSigned: await snap(await b.request("/read-signed", { headers })),
      set: await snap(await b.request("/set")),
    };
  } finally {
    await b.close();
  }
}

await runCases("01-cookies", {
  nestSecret: () => scenario({ cookies: { secret: SECRET } }),
  noSecret: () => scenario({}),
  // bun-common's own secret / cookie-parser on express (the pre-12 way)
  middlewareSecretOnly: () =>
    scenario({}, { request: { parseCookies: { secret: SECRET } } }, (app) => {
      if (kind === "express") app.use(require("cookie-parser")(SECRET));
    }),
  bunParseCookiesOff: () =>
    kind === "bun" ? scenario({ cookies: { secret: SECRET } }, { request: { parseCookies: false } }) : Promise.resolve("bun only"),
});
