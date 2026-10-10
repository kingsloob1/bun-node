/**
 * One NestJS application, booted twice — on `@nestjs/platform-express`'s
 * `ExpressAdapter` and on bun-nest's `BunHttpAdapter` — so a test can send
 * both the same request and compare what comes back. Express 5 is the
 * reference: every behaviour asserted against it is what Express itself does,
 * measured, not what we believe it does.
 *
 * The controllers cover what a Nest app on platform-express leans on:
 * `@Render`/view engines, `@Redirect`, `@HttpCode`/`@Header`, `@Res()` in
 * both modes, `@Next()`, `StreamableFile`, `@Sse()`, static assets, body
 * parsing, exception filters, request properties, the Express response
 * helpers, and middleware ordering.
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type {
  ArgumentsHost,
  ExceptionFilter,
  INestApplication,
  MessageEvent,
  MiddlewareConsumer,
  NestApplicationOptions,
  NestMiddleware,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  BadRequestException,
  Body,
  Catch,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HostParam,
  HttpCode,
  HttpException,
  Module,
  Next,
  Post,
  Redirect,
  Render,
  Req,
  RequestMethod,
  Res,
  Sse,
  StreamableFile,
  UseFilters,
  Version,
  VERSION_NEUTRAL,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import { interval, map, take } from "rxjs";
import { BunHttpAdapter } from "../../lib/BunHttpAdapter";
import "reflect-metadata";

/** The fixture directory: `views/` (EJS templates) and `public/` (static files). */
export const FIXTURES = join(
  import.meta.dir,
  "..",
  "fixtures",
  "express-compat",
);
/** The views directory handed to `setBaseViewsDir`. */
export const VIEWS = join(FIXTURES, "views");
/** The directory served by `useStaticAssets`. */
export const PUBLIC = join(FIXTURES, "public");
/** The secret both sides sign cookies with. */
export const COOKIE_SECRET = "compat-secret";

/** Signs `value` as cookie-parser / cookie-signature do: `s:<value>.<hmac>`. */
export function signCookie(value: string, secret = COOKIE_SECRET): string {
  const mac = createHmac("sha256", secret)
    .update(value)
    .digest("base64")
    .replace(/=+$/, "");
  return `s:${value}.${mac}`;
}

/** Which adapter an application runs on. */
export type Side = "express" | "bun";

/**
 * The slice of a response object the controllers call through `@Res()`:
 * what Express's `res` offers. On the Bun side a missing method is a
 * runtime `TypeError`, which the comparison then shows.
 */
interface CompatResponse {
  locals: Record<string, unknown>;
  status: (code: number) => CompatResponse;
  json: (body: unknown) => unknown;
  send: (body?: unknown) => unknown;
  end: (body?: unknown) => unknown;
  setHeader: (name: string, value: string) => unknown;
  type: (type: string) => CompatResponse;
  render: (
    view: string,
    options?: object | ((err: Error | null, html?: string) => void),
    callback?: (err: Error | null, html?: string) => void,
  ) => void;
  cookie: (name: string, value: unknown, options?: object) => CompatResponse;
  clearCookie: (name: string, options?: object) => CompatResponse;
  sendFile: (path: string, options?: object) => unknown;
  download: (path: string, filename?: string) => unknown;
  attachment: (filename?: string) => CompatResponse;
  format: (handlers: Record<string, () => void>) => unknown;
  append: (name: string, value: string | string[]) => CompatResponse;
  vary: (field: string) => CompatResponse;
  location: (url: string) => CompatResponse;
  sendStatus: (code: number) => unknown;
  redirect: (statusOrUrl: number | string, url?: string) => unknown;
}

/** The request properties the controllers read through `@Req()`. */
interface CompatRequest {
  ip?: string;
  ips?: string[];
  hostname?: string;
  protocol?: string;
  secure?: boolean;
  originalUrl?: string;
  baseUrl?: string;
  path?: string;
  url?: string;
  query?: unknown;
  cookies?: unknown;
  signedCookies?: unknown;
  xhr?: boolean;
  subdomains?: string[];
  rawBody?: Uint8Array;
  trail?: string[];
  headers: Record<string, string | string[] | undefined>;
}

@Controller()
export class ViewsController {
  @Get("render")
  @Render("index")
  render() {
    return { title: "Hello" };
  }

  @Get("render-undefined")
  @Render("plain")
  renderUndefined() {
    return undefined;
  }

  @Get("render-missing")
  @Render("nope")
  renderMissing() {
    return {};
  }

  @Get("render-broken")
  @Render("broken")
  renderBroken() {
    return {};
  }

  @Get("render-status")
  @Render("status")
  renderStatus() {
    return { status: 201 };
  }

  @Get("render-code")
  @HttpCode(203)
  @Render("plain")
  renderCode() {
    return {};
  }

  @Get("render-ext")
  @Render("plain.ejs")
  renderExt() {
    return {};
  }

  @Get("render-dir")
  @Render("sub")
  renderDir() {
    return {};
  }

  @Get("res-render")
  resRender(@Res() res: CompatResponse) {
    res.locals.resLocal = "from-res";
    res.render("index", { title: "Res" });
  }

  @Get("res-render-cb")
  resRenderCb(@Res() res: CompatResponse) {
    res.render("plain", (err, html) => {
      res.send(err ? `error: ${err.message}` : `[${(html ?? "").trim()}]`);
    });
  }
}

@Controller()
export class RedirectController {
  @Get("redir")
  @Redirect("/target")
  redir() {}

  @Get("redir-301")
  @Redirect("/target", 301)
  redir301() {}

  @Get("redir-dynamic")
  @Redirect("/target", 301)
  redirDynamic() {
    return { url: "/dynamic", statusCode: 307 };
  }

  @Get("redir-dynamic-url")
  @Redirect("/target", 301)
  redirDynamicUrl() {
    return { url: "/dynamic" };
  }

  @Get("redir-relative")
  @Redirect("relative/path")
  redirRelative() {}

  @Get("redir-back")
  @Redirect("back")
  redirBack() {}

  @Get("redir-encode")
  @Redirect("/a b/ü?q=1 2&x=%20")
  redirEncode() {}

  @Get("redir-passthrough")
  @Redirect("/target")
  redirPassthrough(@Res({ passthrough: true }) res: CompatResponse) {
    res.setHeader("x-pass", "1");
  }
}

@Catch(ForbiddenException)
class TeapotFilter implements ExceptionFilter {
  catch(exception: ForbiddenException, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<CompatResponse>();
    res.status(418).json({ filtered: exception.message });
  }
}

@Controller()
export class ResponseController {
  @Get("code")
  @HttpCode(202)
  @Header("x-a", "1")
  @Header("Cache-Control", "none")
  code() {
    return { ok: true };
  }

  @Get("res-raw")
  resRaw(@Res() res: CompatResponse) {
    res.status(201).json({ raw: true });
  }

  @Get("res-pass")
  @Header("x-h", "h")
  resPass(@Res({ passthrough: true }) res: CompatResponse) {
    res.status(206);
    res.setHeader("x-p", "1");
    return { pass: true };
  }

  @Get("next")
  nextFirst(@Next() next: () => void) {
    next();
  }

  @Get("next")
  nextSecond() {
    return "second";
  }

  @Get("num")
  num() {
    return 42;
  }

  @Get("bool")
  bool() {
    return true;
  }

  @Get("null")
  nullBody() {
    return null;
  }

  @Get("undef")
  undef() {
    return undefined;
  }

  @Get("str")
  str() {
    return "<b>text</b>";
  }

  @Get("arr")
  arr() {
    return [1, "two"];
  }

  @Get("buf")
  buf() {
    return Buffer.from("buffered");
  }

  @Get("err-body")
  @Header("Content-Type", "text/plain")
  errBody() {
    return { statusCode: 400, message: "x" };
  }

  @Get("file")
  file() {
    return new StreamableFile(Buffer.from("streamed"), {
      type: "text/plain",
      disposition: 'attachment; filename="s.txt"',
      length: 8,
    });
  }

  @Get("file-plain")
  filePlain() {
    return new StreamableFile(Readable.from(["a", "b"]));
  }

  @Get("file-bytes")
  fileBytes() {
    return new StreamableFile(new Uint8Array([104, 105]));
  }

  @Sse("sse")
  sse(): Observable<MessageEvent> {
    return interval(5).pipe(
      take(2),
      map((i) => ({ data: { i } })),
    );
  }

  @Get("http-exc")
  httpExc() {
    throw new BadRequestException("bad thing");
  }

  @Get("http-exc-obj")
  httpExcObj() {
    throw new HttpException({ custom: 1 }, 409);
  }

  @Get("plain-error")
  plainError() {
    throw new Error("boom");
  }

  @Get("filtered")
  @UseFilters(TeapotFilter)
  filtered() {
    throw new ForbiddenException("nope");
  }

  @Post("echo")
  @HttpCode(200)
  echo(@Body() body: unknown) {
    return { body: body ?? null, type: typeof body };
  }

  @Get("req-props")
  reqProps(@Req() req: CompatRequest) {
    return {
      ip: req.ip,
      ips: req.ips,
      hostname: req.hostname,
      protocol: req.protocol,
      secure: req.secure,
      originalUrl: req.originalUrl,
      baseUrl: req.baseUrl,
      path: req.path,
      url: req.url,
      query: req.query,
      cookies: req.cookies,
      signedCookies: req.signedCookies,
      xhr: req.xhr,
      subdomains: req.subdomains,
    };
  }

  @Get("res-cookie")
  resCookie(@Res() res: CompatResponse) {
    res.cookie("a", "1", { httpOnly: true, maxAge: 60000, path: "/" });
    res.cookie("o", { x: 1 });
    res.cookie("sig", "v", { signed: true });
    res.clearCookie("b");
    res.clearCookie("c", { path: "/p", maxAge: 1000 });
    res.send("ok");
  }

  @Get("res-type")
  resType(@Res() res: CompatResponse) {
    res.type("html").send("<b>hi</b>");
  }

  @Get("res-type-json")
  resTypeJson(@Res() res: CompatResponse) {
    res.type("json").send('{"a":1}');
  }

  @Get("res-send-obj")
  resSendObj(@Res() res: CompatResponse) {
    res.send({ sent: 1 });
  }

  @Get("res-send-num")
  resSendNum(@Res() res: CompatResponse) {
    res.status(200).send("5");
  }

  @Get("res-sendfile")
  resSendFile(@Res() res: CompatResponse) {
    res.sendFile(join(PUBLIC, "a.txt"));
  }

  @Get("res-sendfile-root")
  resSendFileRoot(@Res() res: CompatResponse) {
    res.sendFile("data.json", { root: PUBLIC });
  }

  @Get("res-download")
  resDownload(@Res() res: CompatResponse) {
    res.download(join(PUBLIC, "a.txt"), "renamed.txt");
  }

  @Get("res-attachment")
  resAttachment(@Res() res: CompatResponse) {
    res.attachment("report.pdf").send("pdf");
  }

  @Get("res-format")
  resFormat(@Res() res: CompatResponse) {
    res.format({
      "text/plain": () => res.send("text"),
      "application/json": () => res.json({ json: true }),
      default: () => res.status(406).send("nope"),
    });
  }

  @Get("res-append")
  resAppend(@Res() res: CompatResponse) {
    res.append("Link", ["<a>", "<b>"]);
    res.append("Link", "<c>");
    res.append("Warning", "199 x");
    res.send("ok");
  }

  @Get("res-vary")
  resVary(@Res() res: CompatResponse) {
    res.vary("Accept").vary("Origin").vary("accept");
    res.send("ok");
  }

  @Get("res-location")
  resLocation(@Res() res: CompatResponse) {
    res.location("/loc").status(201).end();
  }

  @Get("res-send-status")
  resSendStatus(@Res() res: CompatResponse) {
    res.sendStatus(418);
  }

  @Get("res-json-null")
  resJsonNull(@Res() res: CompatResponse) {
    res.json(null);
  }

  @Get("res-redirect")
  resRedirect(@Res() res: CompatResponse) {
    res.redirect("/r");
  }

  @Get("res-redirect-301")
  resRedirect301(@Res() res: CompatResponse) {
    res.redirect(301, "/r");
  }
}

/** Appends `name` to `req.trail`, so a handler can report the order. */
function trail(name: string) {
  return (req: CompatRequest, _res: unknown, next: () => void) => {
    req.trail = [...(req.trail ?? []), name];
    next();
  };
}

class TrailA implements NestMiddleware {
  use = trail("A");
}

class TrailB implements NestMiddleware {
  use = trail("B");
}

class TrailC implements NestMiddleware {
  use = trail("C");
}

@Controller("mw")
export class MiddlewareController {
  @Get("one")
  one(@Req() req: CompatRequest) {
    return req.trail ?? [];
  }

  @Post("one")
  @HttpCode(200)
  postOne(@Req() req: CompatRequest) {
    return req.trail ?? [];
  }

  @Get("skip")
  skip(@Req() req: CompatRequest) {
    return req.trail ?? [];
  }
}

@Controller({ host: ":account.example.com", path: "host" })
export class HostController {
  @Get()
  host(@HostParam("account") account: string) {
    return { account };
  }
}

@Module({
  controllers: [
    ViewsController,
    RedirectController,
    ResponseController,
    MiddlewareController,
    HostController,
  ],
})
export class CompatModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TrailA).forRoutes("mw/*path");
    consumer.apply(TrailB).exclude("mw/skip").forRoutes(MiddlewareController);
    consumer
      .apply(TrailC)
      .forRoutes({ path: "mw/one", method: RequestMethod.POST });
  }
}

@Module({ controllers: [ViewsController] })
export class ViewsModule {}

@Controller()
export class SmallController {
  @Get("hello")
  hello() {
    return { hello: true };
  }

  @Get("health")
  health() {
    return "healthy";
  }

  @Post("echo")
  @HttpCode(200)
  echo(@Body() body: unknown, @Req() req: CompatRequest) {
    return {
      body: body ?? null,
      raw:
        req.rawBody === undefined ? null : Buffer.from(req.rawBody).toString(),
    };
  }
}

@Module({ controllers: [SmallController] })
export class SmallModule {}

@Controller("ver")
export class VersionedController {
  @Get()
  @Version("1")
  one() {
    return "v1";
  }

  @Get()
  @Version(["2", "3"])
  two() {
    return "v2or3";
  }

  @Get()
  @Version(VERSION_NEUTRAL)
  neutral() {
    return "neutral";
  }
}

@Module({ controllers: [VersionedController] })
export class VersionedModule {}

/** What a booted application exposes to a test. */
export interface Booted {
  /** Which adapter it runs on. */
  side: Side;
  /** The Nest application. */
  app: INestApplication;
  /** `http://127.0.0.1:<port>`, the address it listens at. */
  base: string;
}

/**
 * The application methods platform-express adds on top of
 * `INestApplication` (`NestExpressApplication`), all optional: on the Bun
 * side Nest's adapter proxy only exposes what the adapter implements.
 */
export interface ExpressLikeApp {
  setBaseViewsDir?: (path: string | string[]) => unknown;
  setViewEngine?: (engine: string) => unknown;
  setLocal?: (key: string, value: unknown) => unknown;
  useStaticAssets?: (path: string, options?: object) => unknown;
  set?: (setting: string, value: unknown) => unknown;
  engine?: (
    ext: string,
    fn: (
      path: string,
      options: object,
      callback: (err: Error | null, html?: string) => void,
    ) => void,
  ) => unknown;
  useBodyParser?: (type: string, options?: object) => unknown;
}

/** Configures an application before it listens; told which side it is. */
export type Configure = (
  app: INestApplication & ExpressLikeApp,
  side: Side,
) => void | Promise<void>;

/** Creates, configures and starts `module` on one adapter, on port 0. */
export async function boot(
  side: Side,
  module: new () => object,
  configure?: Configure,
  options: NestApplicationOptions = {},
): Promise<Booted> {
  const adapter =
    side === "express"
      ? new ExpressAdapter()
      : new BunHttpAdapter(0, bunCookieAdapterOptions());
  const app = await NestFactory.create(module, adapter, {
    logger: false,
    ...options,
  });
  await configure?.(app as INestApplication & ExpressLikeApp, side);
  await app.listen(0, "127.0.0.1");
  const server = app.getHttpServer() as { address: () => { port: number } };
  const port =
    side === "express"
      ? server.address().port
      : Number((adapter as BunHttpAdapter).listeningPort);
  return { side, app, base: `http://127.0.0.1:${port}` };
}

/** Boots `module` on both adapters with the same configuration. */
export async function bootBoth(
  module: new () => object,
  configure?: Configure,
  options?: NestApplicationOptions,
): Promise<Record<Side, Booted>> {
  const [express, bun] = await Promise.all([
    boot("express", module, configure, options),
    boot("bun", module, configure, options),
  ]);
  return { express, bun };
}

/** The main application's configuration: views, locals, static files, cookies. */
export const configureCompat: Configure = (app, side) => {
  app.setBaseViewsDir?.(VIEWS);
  app.setViewEngine?.("ejs");
  app.setLocal?.("appName", "Compat");
  app.useStaticAssets?.(PUBLIC, { prefix: "/static", maxAge: 1000 });
  app.useStaticAssets?.(PUBLIC, {
    prefix: "/static2",
    dotfiles: "allow",
    index: false,
    etag: false,
    immutable: true,
    maxAge: "1d",
  });
  if (side === "express") {
    app.use(cookieParser(COOKIE_SECRET));
  }
  app.use(trail("G"));
};

/**
 * The Bun adapter's options matching an Express app's defaults plus
 * cookie-parser: the cookie secret as its request option, and weak ETags,
 * which Express's `etag` setting turns on by default (bun-nest's is off).
 */
export function bunCookieAdapterOptions() {
  return {
    request: { parseCookies: { secret: COOKIE_SECRET } },
    etag: "weak" as const,
  };
}

/** What one request came back with, normalised for comparison. */
export interface Observed {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Response headers that differ by server, not by behaviour. */
const IGNORED_HEADERS = new Set([
  "date",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "x-powered-by",
]);

/** Sends `path` to `base` and records status, headers and body. */
export async function observe(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<Observed> {
  const res = await fetch(`${base}${path}`, {
    redirect: "manual",
    ...init,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    if (!IGNORED_HEADERS.has(name) && name !== "set-cookie") {
      headers[name] = value;
    }
  });
  const cookies = res.headers.getSetCookie();
  if (cookies.length) {
    headers["set-cookie"] = cookies
      .map((c) => c.replace(/Expires=[^;]+/i, "Expires=<date>"))
      .join(" | ");
  }
  return { status: res.status, headers, body: await res.text() };
}
