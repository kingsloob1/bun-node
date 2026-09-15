/**
 * Controllers and routing: every HTTP method decorator, every way a handler
 * reads a request, and every way it can answer — on `BunHttpAdapter`.
 *
 * ```bash
 * bun 02-http-adapter/controllers-and-routing.ts
 * ```
 *
 * Worth knowing:
 *
 * - `@Req()` is a bun-common `BunRequest` and `@Res()` a `BunResponse`: an
 *   Express-shaped API (`status`, `json`, `send`, `cookie`, `location`, …)
 *   over a native `Response`.
 * - `@Res()` without `passthrough` means *you* send the response; with
 *   `{ passthrough: true }` you may set headers or cookies and still return a
 *   value for Nest to send.
 * - Whatever a handler returns goes through `BunResponse.send`, so a
 *   `ReadableStream`, a Node `Readable`, a `Bun.file()`, a `Blob` or an async
 *   generator is streamed as-is.
 * - `@Redirect(url, status)` answers straight away with `Location` and an
 *   empty body, as on `@nestjs/platform-express`.
 * - A returned `StreamableFile` is streamed, its `type`, `disposition` and
 *   `length` filling in any header the handler did not set.
 * - One thing behaves differently from `@nestjs/platform-express` today:
 *   - `@Sse()` fails: Nest listens for `close` on `req.socket`, and
 *     `BunRequest`'s socket shim has no `once()`.
 * - `@Render(path)` serves the file at `path` as-is; there is no template
 *   engine behind it.
 */
import type {
  BunRequest,
  BunResponse,
  JsonValue,
} from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  All,
  Body,
  Controller,
  Copy,
  Delete,
  Get,
  Head,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Lock,
  Mkcol,
  Module,
  Move,
  Options,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Propfind,
  Proppatch,
  Put,
  Query,
  Redirect,
  Render,
  Req,
  Res,
  Search,
  StreamableFile,
  Unlock,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { show, step, title } from "../shared/console";
import "reflect-metadata";

/** A scratch directory for the page `@Render` serves. */
const scratch = await mkdtemp(join(tmpdir(), "bun-nest-routing-"));

/** The file `@Render` sends. Decorator arguments are evaluated at class definition. */
const PAGE = join(scratch, "welcome.html");
await Bun.write(PAGE, "<h1>Hello from a rendered page</h1>\n");

/* ------------------------------------------------------------------ */
/** One handler per HTTP method decorator, each echoing the method it serves. */
@Controller("verbs")
class VerbsController {
  @Get()
  get(@Req() req: BunRequest) {
    return { decorator: "@Get", method: req.method };
  }

  @Post()
  post(@Req() req: BunRequest) {
    return { decorator: "@Post", method: req.method };
  }

  @Put()
  put(@Req() req: BunRequest) {
    return { decorator: "@Put", method: req.method };
  }

  @Patch()
  patch(@Req() req: BunRequest) {
    return { decorator: "@Patch", method: req.method };
  }

  @Delete()
  delete(@Req() req: BunRequest) {
    return { decorator: "@Delete", method: req.method };
  }

  @Options()
  options(@Req() req: BunRequest) {
    return { decorator: "@Options", method: req.method };
  }

  /** A `HEAD` response has no body, so this one reports through a header. */
  @Head()
  @Header("x-decorator", "@Head")
  head() {
    return "";
  }

  @Search()
  search(@Req() req: BunRequest) {
    return { decorator: "@Search", method: req.method };
  }

  @Propfind()
  propfind(@Req() req: BunRequest) {
    return { decorator: "@Propfind", method: req.method };
  }

  @Proppatch()
  proppatch(@Req() req: BunRequest) {
    return { decorator: "@Proppatch", method: req.method };
  }

  @Mkcol()
  mkcol(@Req() req: BunRequest) {
    return { decorator: "@Mkcol", method: req.method };
  }

  @Copy()
  copy(@Req() req: BunRequest) {
    return { decorator: "@Copy", method: req.method };
  }

  @Move()
  move(@Req() req: BunRequest) {
    return { decorator: "@Move", method: req.method };
  }

  @Lock()
  lock(@Req() req: BunRequest) {
    return { decorator: "@Lock", method: req.method };
  }

  @Unlock()
  unlock(@Req() req: BunRequest) {
    return { decorator: "@Unlock", method: req.method };
  }

  /** `@All` matches every method on its path. */
  @All("any")
  any(@Req() req: BunRequest) {
    return { decorator: "@All", method: req.method };
  }
}

/* ------------------------------------------------------------------ */
/** Every way a handler reads the request. */
@Controller("inputs")
class InputsController {
  /** Named params, all params at once, and a param through a pipe. */
  @Get("users/:userId/posts/:postId")
  params(
    @Param() all: Record<string, string>,
    @Param("userId") userId: string,
    @Param("postId", ParseIntPipe) postId: number,
  ) {
    return { all, userId, postId, postIdType: typeof postId };
  }

  /** An optional param, a regexp-constrained param and a named wildcard. */
  @Get("archive/:year(\\d{4})/:month?")
  archive(@Param() params: Record<string, string>) {
    return { params };
  }

  @Get("files/*path")
  files(@Param("path") path: string) {
    return { path };
  }

  /** Query strings parse nested keys and repeated keys into objects and arrays. */
  @Get("search")
  query(@Query() query: Record<string, unknown>, @Query("tag") tag: unknown) {
    return { query, tag };
  }

  /** The parsed body, one field of it, one header, and every header. */
  @Post("echo")
  body(
    @Body() body: Record<string, unknown>,
    @Body("name") name: unknown,
    @Headers("x-client") client: string | undefined,
    @Headers() headers: Record<string, string>,
  ) {
    return { body, name, client, contentType: headers["content-type"] };
  }

  /** The raw `BunRequest`, and the client address through `@Ip()`. */
  @Get("request")
  request(@Req() req: BunRequest, @Ip() ip: string) {
    return {
      method: req.method,
      path: req.path,
      originalUrl: req.originalUrl,
      hostname: req.hostname,
      protocol: req.protocol,
      cookies: req.cookies,
      ip,
    };
  }
}

/* ------------------------------------------------------------------ */
/** Every way a handler answers. */
@Controller("responses")
class ResponsesController {
  /** `@HttpCode` replaces the default status; `@Header` adds a static header. */
  @Post("accepted")
  @HttpCode(HttpStatus.ACCEPTED)
  @Header("Cache-Control", "no-store")
  accepted() {
    return { queued: true };
  }

  /** `@Res()` alone: the handler owns the response and must send it. */
  @Get("raw")
  raw(@Res() res: BunResponse) {
    res.setHeader("x-teapot", "short and stout");
    return res.status(418).json({ brewed: false });
  }

  /** `@Res({ passthrough: true })`: set a cookie and a header, return the body. */
  @Get("passthrough")
  passthrough(@Res({ passthrough: true }) res: BunResponse) {
    res.cookie("session", "abc123", { httpOnly: true, path: "/" });
    res.setHeader("x-passthrough", "yes");
    return { ok: true };
  }

  /** `@Redirect()`: Nest sends the redirect; the handler returns nothing. */
  @Get("moved")
  @Redirect("/responses/raw", HttpStatus.MOVED_PERMANENTLY)
  moved() {}

  /** A web `ReadableStream`, streamed chunk by chunk. */
  @Get("stream/web")
  @Header("Content-Type", "text/plain; charset=utf-8")
  webStream() {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of ["one\n", "two\n", "three\n"]) {
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      },
    });
  }

  /** An async generator is an async iterable, so it streams too. */
  @Get("stream/generator")
  @Header("Content-Type", "text/plain; charset=utf-8")
  async *generator() {
    for (let chunk = 1; chunk <= 3; chunk++) {
      await Bun.sleep(5);
      yield `chunk ${chunk}\n`;
    }
  }

  /** A download: a `StreamableFile`, whose options become the headers. */
  @Get("stream/download")
  download() {
    const csv = Buffer.from("id,total\n1,9.99\n2,24.50\n");
    return new StreamableFile(csv, {
      type: "text/csv",
      disposition: 'attachment; filename="report.csv"',
    });
  }

  /** A `Bun.file()` is a `Blob`: sent with its own content type. */
  @Get("stream/file")
  file() {
    return Bun.file(PAGE);
  }

  /** `@Render(path)` sends the file at `path`; a returned `status` sets the code. */
  @Get("page")
  @Render(PAGE)
  page() {
    return { status: 200 };
  }
}

@Module({
  controllers: [VerbsController, InputsController, ResponsesController],
})
class AppModule {}

title("Controllers and routing on BunHttpAdapter");

const app = await NestFactory.create(AppModule, new BunHttpAdapter(), {
  logger: false,
  abortOnError: false,
});
await app.listen(0);
const url = await app.getUrl();
show("listening on", url);

/** What one call observed. */
interface Observed {
  /** The HTTP status. */
  status: number;
  /** The body: parsed JSON when the response is JSON, text otherwise. */
  body: JsonValue;
}

/** Calls the app and answers with the status and the (JSON or text) body. */
async function call(path: string, init?: RequestInit): Promise<Observed> {
  const response = await fetch(`${url}${path}`, init);
  const text = await response.text();
  const isJson = response.headers.get("content-type")?.includes("json");
  return { status: response.status, body: isJson ? JSON.parse(text) : text };
}

/* ------------------------------------------------------------------ */
step("Every HTTP method decorator");

const methods = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "SEARCH",
  "PROPFIND",
  "PROPPATCH",
  "MKCOL",
  "COPY",
  "MOVE",
  "LOCK",
  "UNLOCK",
];
for (const method of methods) {
  const { status, body } = await call("/verbs", { method });
  show(`${method.padEnd(9)} /verbs`, { status, body });
}

const head = await fetch(`${url}/verbs`, { method: "HEAD" });
show("HEAD      /verbs", {
  status: head.status,
  "x-decorator": head.headers.get("x-decorator"),
});

for (const method of ["GET", "DELETE", "PATCH"]) {
  show(`${method.padEnd(9)} /verbs/any`, await call("/verbs/any", { method }));
}

/* ------------------------------------------------------------------ */
step("Reading the request: @Param, @Query, @Body, @Headers, @Req, @Ip");

show("@Param", await call("/inputs/users/7/posts/42"));
show("optional param absent", await call("/inputs/archive/2026"));
show("optional param present", await call("/inputs/archive/2026/09"));
show("regexp constraint fails", (await call("/inputs/archive/26/09")).status);
show("named wildcard", await call("/inputs/files/docs/guides/intro.md"));
show(
  "@Query (nested and repeated keys)",
  await call("/inputs/search?tag=bun&tag=nest&filter[price][lt]=10&page=2"),
);
show(
  "@Body and @Headers",
  await call("/inputs/echo", {
    method: "POST",
    headers: { "content-type": "application/json", "x-client": "example" },
    body: JSON.stringify({ name: "Ada", roles: ["admin"] }),
  }),
);
show(
  "@Req and @Ip",
  await call("/inputs/request?debug=1", {
    headers: { cookie: "theme=dark; lang=en" },
  }),
);

/* ------------------------------------------------------------------ */
step("Answering: @HttpCode, @Header, @Res, passthrough, redirects");

const accepted = await fetch(`${url}/responses/accepted`, { method: "POST" });
show("@HttpCode(202) + @Header", {
  status: accepted.status,
  cacheControl: accepted.headers.get("cache-control"),
  body: await accepted.json(),
});

const raw = await fetch(`${url}/responses/raw`);
show("@Res() raw BunResponse", {
  status: raw.status,
  "x-teapot": raw.headers.get("x-teapot"),
  body: await raw.json(),
});

const passthrough = await fetch(`${url}/responses/passthrough`);
show("@Res({ passthrough: true })", {
  status: passthrough.status,
  "set-cookie": passthrough.headers.get("set-cookie"),
  "x-passthrough": passthrough.headers.get("x-passthrough"),
  body: await passthrough.json(),
});

const moved = await fetch(`${url}/responses/moved`, { redirect: "manual" });
show("@Redirect()", {
  status: moved.status,
  location: moved.headers.get("location"),
});

/* ------------------------------------------------------------------ */
step("Streaming and files");

show("ReadableStream", await call("/responses/stream/web"));
show("async generator", await call("/responses/stream/generator"));

const download = await fetch(`${url}/responses/stream/download`);
show("StreamableFile as a download", {
  contentType: download.headers.get("content-type"),
  disposition: download.headers.get("content-disposition"),
  length: download.headers.get("content-length"),
  body: await download.text(),
});

const file = await fetch(`${url}/responses/stream/file`);
show("Bun.file()", {
  contentType: file.headers.get("content-type"),
  body: await file.text(),
});

const page = await fetch(`${url}/responses/page`);
show("@Render", {
  status: page.status,
  contentType: page.headers.get("content-type"),
  body: await page.text(),
});

/* ------------------------------------------------------------------ */
step("Close");
await app.close();
await rm(scratch, { recursive: true, force: true });
show("closed");
