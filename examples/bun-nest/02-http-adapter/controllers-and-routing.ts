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
 * - `@Sse()` streams Nest's own event stream, over a socket and through
 *   `adapter.fetch()` alike: one `id:`/`data:` frame per event, ending when
 *   the Observable completes. When the client disconnects, the socket shim's
 *   `close` reaches Nest, which unsubscribes.
 * - `@Render(path)` differs from `@nestjs/platform-express`: it serves the
 *   file at `path` as-is, with no template engine behind it.
 */
import type {
  BunRequest,
  BunResponse,
  JsonValue,
} from "@kingsleyweb/bun-common";
import type { MessageEvent } from "@nestjs/common";
import type { Observable } from "rxjs";
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
  Sse,
  StreamableFile,
  Unlock,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { finalize, interval, map, Subject, take, takeUntil } from "rxjs";
import { checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
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

/* ------------------------------------------------------------------ */
/** Whether the endless stream's Observable has been unsubscribed. */
let endlessUnsubscribed = false;

/**
 * Emits as the example closes, ending a stream that is still open. Only a
 * failure leaves one open, and it must fail the run rather than hang it.
 */
const closing = new Subject<void>();

/** Server-sent events: Nest's `@Sse()`, over an rxjs Observable. */
@Controller("events")
class EventsController {
  /** Three events a few milliseconds apart, then the Observable completes. */
  @Sse("ticks")
  ticks(): Observable<MessageEvent> {
    return interval(5).pipe(
      take(3),
      map((n) => ({ data: { tick: n + 1 } })),
    );
  }

  /** Never completes: only the client disconnecting ends it. */
  @Sse("endless")
  endless(): Observable<MessageEvent> {
    endlessUnsubscribed = false;
    return interval(5).pipe(
      takeUntil(closing),
      map((n) => ({ data: `beat ${n + 1}` })),
      finalize(() => {
        endlessUnsubscribed = true;
      }),
    );
  }
}

@Module({
  controllers: [
    VerbsController,
    InputsController,
    ResponsesController,
    EventsController,
  ],
})
class AppModule {}

title("Controllers and routing on BunHttpAdapter");

const adapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, adapter, {
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
step("Server-sent events: @Sse()");

/** What reading an event stream observed. */
interface EventStream {
  /** The HTTP status; `0` when no response arrived in time. */
  status: number;
  /** The `Content-Type` header, or `null`. */
  contentType: string | null;
  /** Every byte of the body read, as text. */
  body: string;
  /**
   * How reading stopped: the server `ended` the stream, the caller's `until`
   * was met (`stopped`), or the deadline passed first (`timed out`).
   */
  outcome: "ended" | "stopped" | "timed out";
}

/**
 * Sends a request and reads its event stream until the server ends it,
 * `until` holds for the body so far, or `timeout` milliseconds pass. Every
 * wait has that deadline, so a stream that never ends fails a check rather
 * than hanging the example.
 */
async function readEventStream(
  send: (signal: AbortSignal) => Promise<Response>,
  options: {
    /** Stop reading once the body so far satisfies this. */
    until?: (body: string) => boolean;
    /** The deadline, in milliseconds. Defaults to `5000`. */
    timeout?: number;
  } = {},
): Promise<{
  /** What was read. */
  read: EventStream;
  /** Hangs up: aborts the request, closing the connection. */
  abort: () => void;
}> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timed out">((resolve) => {
    timer = setTimeout(resolve, options.timeout ?? 5000, "timed out");
  });
  const read: EventStream = {
    status: 0,
    contentType: null,
    body: "",
    outcome: "timed out",
  };

  try {
    const response = await Promise.race([send(controller.signal), deadline]);
    if (response === "timed out") {
      abort();
      return { read, abort };
    }
    read.status = response.status;
    read.contentType = response.headers.get("content-type");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk === "timed out") {
        abort();
        await reader.cancel().catch(() => {});
        return { read, abort };
      }
      if (chunk.done) {
        read.outcome = "ended";
        return { read, abort };
      }
      read.body += decoder.decode(chunk.value, { stream: true });
      if (options.until?.(read.body)) {
        read.outcome = "stopped";
        return { read, abort };
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

// Nest writes one blank line when the stream opens, then one frame per event:
// an `id:` it numbers from 1, a `data:` line (an object is sent as JSON) and a
// blank line. No `event:` line unless the message sets a `type`.
const TICKS =
  "\n" +
  'id: 1\ndata: {"tick":1}\n\n' +
  'id: 2\ndata: {"tick":2}\n\n' +
  'id: 3\ndata: {"tick":3}\n\n';

const { read: served } = await readEventStream((signal) =>
  fetch(`${url}/events/ticks`, { signal }),
);
show("served @Sse()", served);
checkEqual(
  "served: 200 with text/event-stream",
  [served.status, served.contentType],
  [200, "text/event-stream"],
);
checkEqual("served: exactly three frames, in order", served.body, TICKS);
checkEqual(
  "served: the stream ends when the Observable completes",
  served.outcome,
  "ended",
);

// `adapter.fetch()` runs the same request through the adapter's pipeline with
// no socket involved, and the stream is the same.
const { read: socketFree } = await readEventStream((signal) =>
  adapter.fetch("/events/ticks", { signal }),
);
show("adapter.fetch() @Sse()", socketFree);
checkEqual(
  "adapter.fetch(): 200 with text/event-stream",
  [socketFree.status, socketFree.contentType],
  [200, "text/event-stream"],
);
checkEqual(
  "adapter.fetch(): exactly three frames, in order",
  socketFree.body,
  TICKS,
);
checkEqual(
  "adapter.fetch(): the stream ends when the Observable completes",
  socketFree.outcome,
  "ended",
);

// An endless stream: read its first frame, then hang up. The disconnect
// reaches Nest as `close` on `req.socket`, and Nest unsubscribes.
const { read: endless, abort: hangUp } = await readEventStream(
  (signal) => fetch(`${url}/events/endless`, { signal }),
  { until: (body) => body.includes("data: beat 1\n\n") },
);
checkEqual(
  "served, endless: the first frame arrives and the stream stays open",
  [endless.outcome, endlessUnsubscribed],
  ["stopped", false],
);
hangUp();
const unsubscribed = await waitFor(
  "the endless Observable to be unsubscribed",
  () => endlessUnsubscribed,
  { timeout: 5000 },
).then(
  () => true,
  () => false,
);
checkEqual(
  "served, endless: hanging up unsubscribes the Observable",
  unsubscribed,
  true,
);

/* ------------------------------------------------------------------ */
step("Close");
closing.next();
await app.close();
await rm(scratch, { recursive: true, force: true });
show("closed");
summary();
