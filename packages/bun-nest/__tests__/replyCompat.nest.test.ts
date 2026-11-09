/**
 * What `reply()` and `mapException()` answer, against
 * `@nestjs/platform-express` on the installed Nest, where each moved in 12.3
 * and 12.4:
 *
 * - a returned `Error` with a status of 400 or more says only the status from
 *   12.3.0 (its enumerable properties, an HTTP client's `config.headers`, say,
 *   are serialised before it, on Express as here);
 * - a stream that fails mid-body resets the connection from 11.2.8 and 12.3.0,
 *   so a client cannot take a partial file for a whole one;
 * - a client error in `http-errors`' shape reaches `@Catch(HttpException)`
 *   from 12.3.0, and a bad-JSON `BadRequestException` has a `cause` from 12.4.1;
 * - a returned web `Response`, `ReadableStream` or async generator is the core's
 *   own streaming path from 12.4.0.
 *
 * Express's answers are measured, whatever the installed Nest is, so the next
 * release's drift fails here. On the lock those cases cannot tell a fixed
 * adapter from a broken one where the behaviour is newer than the lock, so
 * `the adapter's read of the core` runs each behaviour with the capability put
 * there and taken away, on every Nest.
 *
 * `Content-Length` against `Transfer-Encoding` is not compared for a stream:
 * Bun frames a body that ended before its first flush with a length, and that
 * depends on timing; the client reads the same bytes.
 *
 * No top-level `await`: it perturbs decorator metadata in other test files.
 */
import type {
  ArgumentsHost,
  ExceptionFilter,
  INestApplication,
  MiddlewareConsumer,
} from "@nestjs/common";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import {
  Catch,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Module,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import { AbstractHttpAdapter } from "@nestjs/core/adapters/http-adapter.js";
import { BaseExceptionFilter } from "@nestjs/core/exceptions/base-exception-filter.js";
import { RouterResponseController } from "@nestjs/core/router/router-response-controller.js";
import { ExpressAdapter } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { withDefaultCharset } from "../lib/defaultCharset";
import { expressReference } from "./expressCompat/reference";
import "reflect-metadata";

/** A credential a client must never read back. */
const SECRET = "Bearer not-for-clients";

/** An HTTP client's error, as axios's carries its request's `config`. */
function clientError(): Error {
  return Object.assign(new Error("request failed"), {
    config: { headers: { authorization: SECRET } },
  });
}

/** An error in `http-errors`' shape. */
function httpError(status: number, expose: boolean): Error {
  return Object.assign(new Error("http-errors message"), {
    status,
    statusCode: status,
    expose,
  });
}

/** A source that yields one chunk, then fails. */
function failsAfterOneChunk(): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (sent) {
        this.destroy(new Error("source failed"));
      } else {
        sent = true;
        this.push("first");
      }
    },
  });
}

/** A source that yields a few chunks over several turns of the loop, then fails. */
function failsAfterAWhile(): Readable {
  let reads = 0;
  return new Readable({
    read() {
      reads++;
      if (reads > 3) {
        setTimeout(() => this.destroy(new Error("source failed")), 10);
      } else {
        setTimeout(() => this.push(`chunk${reads}`), 2);
      }
    },
  });
}

/** A generator that yields once, then fails. */
async function* generatorFails(): AsyncGenerator<string> {
  yield "a";
  throw new Error("generator failed");
}

/** A generator that yields over several turns of the loop, then fails. */
async function* generatorFailsLater(): AsyncGenerator<string> {
  yield "a";
  await Bun.sleep(5);
  yield "b";
  await Bun.sleep(5);
  throw new Error("generator failed");
}

/** A web stream that yields once, then errors. */
function webStreamFails(): ReadableStream<Uint8Array> {
  let pulls = 0;
  return new ReadableStream({
    async pull(controller) {
      pulls++;
      if (pulls === 1) {
        controller.enqueue(new TextEncoder().encode("w"));
      } else {
        await Bun.sleep(5);
        controller.error(new Error("stream failed"));
      }
    },
  });
}

/** A web stream of `chunks`. */
function webStream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

/** Text chunks, as a generator. */
async function* textChunks(): AsyncGenerator<string> {
  yield "a";
  yield "b";
}

/** JSON chunks, as a generator. */
async function* objectChunks(): AsyncGenerator<object> {
  yield { a: 1 };
  yield { a: 2 };
}

/** `tag`'s source: how many reads it saw, and whether it was destroyed. */
const SOURCES = new Map<string, { reads: number; destroyed: boolean }>();

/** A long source that records what happened to it under `tag`. */
function trackedSource(tag: string): Readable {
  const record = { reads: 0, destroyed: false };
  SOURCES.set(tag, record);
  let chunks = 0;
  const source = new Readable({
    highWaterMark: 16,
    read() {
      record.reads++;
      chunks++;
      if (chunks > 200) {
        this.push(null);
      } else {
        setTimeout(() => {
          if (!this.destroyed) {
            this.push("0123456789");
          }
        }, 1);
      }
    },
  });
  source.on("close", () => {
    record.destroyed = true;
  });
  return source;
}

@Controller("r")
class RepliesController {
  @Get("err-400")
  @HttpCode(400)
  err400() {
    return clientError();
  }

  @Get("err-500")
  @HttpCode(500)
  err500() {
    return clientError();
  }

  @Get("err-599")
  @HttpCode(599)
  err599() {
    return clientError();
  }

  @Get("err-200")
  err200() {
    return clientError();
  }

  @Get("err-text")
  @HttpCode(404)
  @Header("content-type", "text/plain")
  errText() {
    return clientError();
  }

  @Get("err-res")
  errRes(@Res({ passthrough: true }) res: { status: (code: number) => void }) {
    res.status(503);
    return clientError();
  }

  @Get("err-subclass")
  @HttpCode(422)
  errSubclass() {
    class CodedError extends Error {
      code = "E_CODED";
    }
    return new CodedError("coded");
  }

  @Get("file-fails-after-one")
  fileFailsAfterOne() {
    return new StreamableFile(failsAfterOneChunk());
  }

  @Get("file-fails-later")
  fileFailsLater() {
    return new StreamableFile(failsAfterAWhile());
  }

  @Get("file-fails-handler-ends")
  fileFailsHandlerEnds() {
    return new StreamableFile(failsAfterOneChunk()).setErrorHandler(
      (_err, res) => {
        res.end();
      },
    );
  }

  @Get("file-fails-handler-destroys")
  fileFailsHandlerDestroys() {
    return new StreamableFile(failsAfterOneChunk()).setErrorHandler(
      (_err, res) => {
        (res as unknown as { destroy: () => void }).destroy();
      },
    );
  }

  @Get("file-tracked/:tag")
  fileTracked(@Param("tag") tag: string) {
    return new StreamableFile(trackedSource(tag));
  }

  @Get("file-tracked-length/:tag")
  fileTrackedLength(@Param("tag") tag: string) {
    return new StreamableFile(trackedSource(tag), {
      length: 2000,
      type: "text/csv",
      disposition: "attachment",
    });
  }

  @Get("file-bytes")
  fileBytes() {
    return new StreamableFile(Buffer.from("hello"));
  }

  @Get("file-empty")
  fileEmpty() {
    return new StreamableFile(Readable.from([]));
  }

  @Get("generator-fails")
  generatorFails() {
    return generatorFails();
  }

  @Get("generator-fails-later")
  generatorFailsLater() {
    return generatorFailsLater();
  }

  @Get("web-stream-fails")
  webStreamFails() {
    return webStreamFails();
  }

  @Get("response-stream-fails")
  responseStreamFails() {
    return new Response(webStreamFails(), { status: 201 });
  }

  @Get("node-fails")
  nodeFails() {
    return failsAfterOneChunk();
  }

  @Get("response")
  response() {
    return new Response("héllo", {
      status: 201,
      headers: { "x-web": "1", "content-type": "text/plain" },
    });
  }

  @Get("response-keeps-header")
  @Header("x-before", "kept")
  @HttpCode(203)
  responseKeepsHeader() {
    return new Response("h");
  }

  @Get("response-custom-type")
  responseCustomType() {
    return new Response("h", { headers: { "content-type": "text/x-web" } });
  }

  @Get("response-charset")
  responseCharset() {
    return new Response("h", {
      headers: { "content-type": "text/plain; charset=latin1" },
    });
  }

  @Get("response-json")
  responseJson() {
    return Response.json({ a: 1 }, { status: 202 });
  }

  @Get("response-empty")
  responseEmpty() {
    return new Response(null, { status: 204, headers: { "x-web": "1" } });
  }

  @Get("response-cookies")
  responseCookies() {
    const headers = new Headers();
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    return new Response("c", { headers });
  }

  @Get("response-stream")
  responseStream() {
    return new Response(webStream("x", "y"), {
      headers: { "content-type": "text/plain" },
    });
  }

  @Get("response-length")
  responseLength() {
    return new Response("hello", { headers: { "content-length": "5" } });
  }

  @Get("web-stream")
  webStream() {
    return webStream("x", "y");
  }

  @Get("generator")
  generator() {
    return textChunks();
  }

  @Get("generator-objects")
  generatorObjects() {
    return objectChunks();
  }

  @Get("node")
  node() {
    return Readable.from(["n1", "n2"]);
  }

  @Get("header-text")
  @Header("content-type", "text/plain")
  headerText() {
    return "hé";
  }

  @Get("header-custom-text")
  @Header("content-type", "text/x-web")
  headerCustomText() {
    return "h";
  }

  @Get("header-json")
  @Header("content-type", "application/json")
  headerJson() {
    return { a: 1 };
  }

  @Get("header-json-text")
  @Header("content-type", "application/json")
  headerJsonText() {
    return "1";
  }

  @Get("header-extension")
  @Header("Content-Type", "html")
  headerExtension() {
    return "h";
  }

  @Get("header-charset")
  @Header("content-type", "text/plain; charset=latin1")
  headerCharset() {
    return { a: 1 };
  }

  @Get("header-binary")
  @Header("content-type", "application/octet-stream")
  headerBinary() {
    return { a: 1 };
  }

  @Post("json")
  @HttpCode(200)
  json(@Req() req: { body?: unknown }) {
    return req.body ?? null;
  }

  @Get("middleware-fails/:kind")
  middlewareFails() {
    return { reached: true };
  }
}

/** `next()`s the `http-errors` error the last path segment names. */
function failingMiddleware(
  req: { originalUrl?: string; url?: string },
  _res: unknown,
  next: (error?: unknown) => void,
) {
  const kind = (req.originalUrl ?? req.url ?? "").split("/").pop();
  const errors: Record<string, Error> = {
    "404-exposed": httpError(404, true),
    "403-hidden": httpError(403, false),
    "500-exposed": httpError(500, true),
    "500-hidden": httpError(500, false),
    mismatched: Object.assign(new Error("mismatched"), {
      status: 418,
      statusCode: 419,
      expose: true,
    }),
  };
  next(kind === undefined ? undefined : errors[kind]);
}

/** What a filter can read: that it ran, the status, and the error's `cause`. */
function filterBody(exception: HttpException) {
  const { cause } = exception as { cause?: unknown };
  return {
    filter: "http",
    status: exception.getStatus(),
    cause: cause instanceof Error ? cause.name : null,
  };
}

@Catch(HttpException)
class HttpExceptionOnlyFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<{
      status: (code: number) => { json: (body: unknown) => unknown };
    }>();
    res.status(exception.getStatus()).json(filterBody(exception));
  }
}

@Module({
  controllers: [RepliesController],
  providers: [{ provide: APP_FILTER, useClass: HttpExceptionOnlyFilter }],
})
class RepliesModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(failingMiddleware).forRoutes("r/middleware-fails/:kind");
  }
}

/** What a request came back with: the bytes, or that the connection was reset. */
interface Outcome {
  /** The status, or `undefined` if the headers never arrived. */
  status?: number;
  /** Whether the body arrived whole, as far as the client can tell. */
  ended: "complete" | "reset";
  /** The body, when it arrived. */
  body?: string;
  /** The headers that say what the body is, normalised for comparison. */
  headers: Record<string, string>;
}

/** Sends a request and records what a client can tell. */
async function outcome(url: string, init?: RequestInit): Promise<Outcome> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      ...init,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw error;
    }
    return { ended: "reset", headers: {} };
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (
      name === "content-type" ||
      name === "content-disposition" ||
      name.startsWith("x-web") ||
      name === "x-before"
    ) {
      headers[name] = value.toLowerCase().replace(/;\s*/g, "; ");
    }
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    headers["set-cookie"] = cookies.join(" | ");
  }
  try {
    const body = await response.text();
    return { status: response.status, ended: "complete", body, headers };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw error;
    }
    return { status: response.status, ended: "reset", headers };
  }
}

/** Boots {@link RepliesModule} on `adapter`, on a port of its own. */
async function bootReplies(
  adapter: BunHttpAdapter | ExpressAdapter,
): Promise<{ app: INestApplication; base: string }> {
  const app = await NestFactory.create(RepliesModule, adapter as never, {
    logger: false,
  });
  (
    app as unknown as {
      useBodyParser: (type: string, options: object) => unknown;
    }
  ).useBodyParser("json", { limit: "1kb" });
  await app.listen(0);
  return { app, base: (await app.getUrl()).replace("[::1]", "127.0.0.1") };
}

/**
 * Whether the reference has the core's streaming path for a returned web
 * `Response`, `ReadableStream` or async generator (12.4.0). Before it, Express
 * sends them as JSON, `{}`, and this adapter sends them as streams, a known
 * difference.
 */
const CORE_STREAMS_RETURNED_BODIES =
  typeof Reflect.get(RouterResponseController.prototype, "stream") ===
  "function";

/** Whether Nest's core calls the adapter's `mapException` at all (12.0.0). */
const CORE_CALLS_MAP_EXCEPTION =
  typeof (AbstractHttpAdapter.prototype as { mapException?: unknown })
    .mapException === "function";

/** The reference's `mapException`, as source, where it has one. */
const REFERENCE_MAP_EXCEPTION = String(
  Reflect.get(ExpressAdapter.prototype, "mapException") ?? "",
);

/** Whether Express keeps the `cause` of a mapped bad-JSON error (12.4.1). */
const REFERENCE_KEEPS_CAUSE = /BadRequestException\([^)]*cause/.test(
  REFERENCE_MAP_EXCEPTION,
);

describe("bun-nest vs platform-express: replies", () => {
  let express: Awaited<ReturnType<typeof bootReplies>>;
  let bun: Awaited<ReturnType<typeof bootReplies>>;

  beforeAll(async () => {
    express = await bootReplies(expressReference());
    bun = await bootReplies(new BunHttpAdapter());
  });

  afterAll(async () => {
    await express?.app.close();
    await bun?.app.close();
  });

  /** Both sides' outcomes for one request. */
  async function both(
    path: string,
    init?: RequestInit,
  ): Promise<[Outcome, Outcome]> {
    return [
      await outcome(`${express.base}${path}`, init),
      await outcome(`${bun.base}${path}`, init),
    ];
  }

  describe("a returned Error", () => {
    for (const name of [
      "err-400",
      "err-500",
      "err-599",
      "err-200",
      "err-text",
      "err-res",
      "err-subclass",
    ]) {
      it(`answers as Express: ${name}`, async () => {
        const [reference, ours] = await both(`/r/${name}`);
        expect(ours).toEqual(reference);
      });
    }
  });

  describe("a stream that fails mid-body", () => {
    for (const name of [
      "file-fails-after-one",
      "file-fails-later",
      "file-fails-handler-ends",
      "file-fails-handler-destroys",
    ]) {
      it(`ends as on Express: ${name}`, async () => {
        const [reference, ours] = await both(`/r/${name}`);
        expect(ours.ended).toBe(reference.ended);
        expect(ours.status).toBe(reference.status);
        if (reference.ended === "complete") {
          expect(ours.body).toBe(reference.body);
        }
      });
    }
  });

  describe.skipIf(!CORE_STREAMS_RETURNED_BODIES)(
    "a returned stream (the core's path, from 12.4.0)",
    () => {
      for (const name of [
        "generator-fails",
        "generator-fails-later",
        "web-stream-fails",
        "response-stream-fails",
        "node-fails",
      ]) {
        it(`resets as on Express when it fails: ${name}`, async () => {
          const [reference, ours] = await both(`/r/${name}`);
          expect(reference.ended).toBe("reset");
          expect(ours.ended).toBe("reset");
          expect(ours.status).toBe(reference.status);
        });
      }

      for (const name of [
        "response",
        "response-keeps-header",
        "response-custom-type",
        "response-charset",
        "response-json",
        "response-empty",
        "response-cookies",
        "response-stream",
        "web-stream",
        "generator",
        "generator-objects",
        "node",
      ]) {
        it(`answers as Express: ${name}`, async () => {
          const [reference, ours] = await both(`/r/${name}`);
          expect(ours).toEqual(reference);
        });

        it(`answers HEAD as Express: ${name}`, async () => {
          const [reference, ours] = await both(`/r/${name}`, {
            method: "HEAD",
          });
          expect(ours).toEqual(reference);
        });
      }
    },
  );

  describe("HEAD of a StreamableFile", () => {
    /** A `HEAD` to `path`, with the framing headers. */
    async function head(base: string, path: string) {
      const response = await fetch(`${base}${path}`, { method: "HEAD" });
      await response.text();
      return {
        status: response.status,
        length: response.headers.get("content-length"),
      };
    }

    for (const path of ["/r/file-bytes", "/r/file-empty"]) {
      it(`keeps the status, the type and a declared length: ${path}`, async () => {
        const [reference, ours] = await both(path, { method: "HEAD" });
        expect(ours).toEqual(reference);
        expect((await head(bun.base, path)).length).toBe(
          (await head(express.base, path)).length,
        );
      });
    }

    it("says the length a file declares, and its source is destroyed", async () => {
      const reference = await head(
        express.base,
        "/r/file-tracked-length/express-head-length",
      );
      const ours = await head(
        bun.base,
        "/r/file-tracked-length/bun-head-length",
      );
      expect(reference).toEqual({ status: 200, length: "2000" });
      expect(ours).toEqual(reference);
      await Bun.sleep(50);
      expect(SOURCES.get("bun-head-length")?.destroyed).toBe(true);
    });

    it("never says a file of unknown length is empty, and its source is destroyed", async () => {
      const reference = await head(
        express.base,
        "/r/file-tracked/express-head-plain",
      );
      const ours = await head(bun.base, "/r/file-tracked/bun-head-plain");
      expect(reference).toEqual({ status: 200, length: null });
      expect(ours).toEqual(reference);
      await Bun.sleep(50);
      expect(SOURCES.get("bun-head-plain")?.destroyed).toBe(true);
    });

    it("reads no more of the source than the first chunk needs", async () => {
      await head(bun.base, "/r/file-tracked/bun-head-reads");
      await Bun.sleep(50);
      expect(SOURCES.get("bun-head-reads")?.reads).toBeLessThan(5);
    });
  });

  describe("a client error raised outside a route", () => {
    for (const name of [
      "404-exposed",
      "403-hidden",
      "500-exposed",
      "500-hidden",
      "mismatched",
    ]) {
      it(`reaches the same filter or answer as Express: ${name}`, async () => {
        const [reference, ours] = await both(`/r/middleware-fails/${name}`);
        expect(ours).toEqual(reference);
      });
    }

    /** The fields of an answer the filter decides, without the message. */
    function filterFields({ status, body }: Outcome) {
      const parsed = JSON.parse(body ?? "{}") as Record<string, unknown>;
      return { status, filter: parsed.filter, cause: parsed.cause };
    }

    it("an over-limit body reaches the same filter as Express", async () => {
      const [reference, ours] = await both("/r/json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: "x".repeat(4000) }),
      });
      expect(filterFields(ours)).toEqual(filterFields(reference));
    });

    for (const [name, path, init] of [
      [
        "unparsable JSON",
        "/r/json",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{bad",
        },
      ],
      ["a path that cannot be decoded", "/r/middleware-fails/%FF", undefined],
    ] as const) {
      it(`${name} reaches the same filter, with the cause Express has`, async () => {
        const [reference, ours] = await both(path, init);
        // Express has it from 12.4.1, this adapter wherever the core maps
        // through it, since no read tells 12.4.0 from 12.4.1: only a filter
        // that reads `cause` can see the difference.
        const expected = filterFields(reference);
        if (CORE_CALLS_MAP_EXCEPTION && !REFERENCE_KEEPS_CAUSE) {
          expected.cause =
            name === "unparsable JSON" ? "SyntaxError" : "URIError";
        }
        expect(filterFields(ours)).toEqual(expected);
      });
    }
  });

  describe("a Content-Type set with @Header", () => {
    for (const name of [
      "header-text",
      "header-custom-text",
      "header-json",
      "header-json-text",
      "header-extension",
      "header-charset",
      "header-binary",
    ]) {
      it(`gets the charset Express gives it: ${name}`, async () => {
        const [reference, ours] = await both(`/r/${name}`);
        expect(ours).toEqual(reference);
      });
    }
  });
});

describe("the charset table is the one Express reads", () => {
  it("agrees with mime-types' contentType on every type in its database", () => {
    const require = createRequire(import.meta.url);
    const platformExpress = require.resolve("@nestjs/platform-express");
    const express = require.resolve("express", {
      paths: [dirname(platformExpress)],
    });
    const mimeTypes = require.resolve("mime-types", {
      paths: [dirname(express)],
    });
    const { contentType } = require(mimeTypes) as {
      contentType: (type: string) => string | false;
    };
    const database = require(
      require.resolve("mime-db", { paths: [dirname(mimeTypes)] }),
    ) as Record<string, unknown>;

    const types = [
      ...Object.keys(database),
      "text/x-not-in-the-database",
      "application/x-not-in-the-database",
      "TEXT/Plain",
      "Application/JSON",
      " text/plain",
      "text/plain;format=flowed",
      "text/plain; charset=latin1",
    ];
    expect(types.length).toBeGreaterThan(2000);
    expect(
      types.filter((type) => withDefaultCharset(type) !== contentType(type)),
    ).toEqual([]);
  });
});

/**
 * A Nest 12.3.0 or later, stood in on the installed core's prototypes, or one
 * older than it, while `build` runs: what the adapter reads when it is built.
 */
function withCore<T>(atLeast12_3: boolean, build: () => T): T {
  const adapterPrototype = AbstractHttpAdapter.prototype as unknown as Record<
    string,
    unknown
  >;
  const filterPrototype = BaseExceptionFilter.prototype as unknown as Record<
    string,
    unknown
  >;
  const mapException = adapterPrototype.mapException;
  const getHttpErrorMessage = filterPrototype.getHttpErrorMessage;
  const stubs = atLeast12_3
    ? {
        mapException: mapException ?? (() => undefined),
        getHttpErrorMessage: getHttpErrorMessage ?? (() => ""),
      }
    : { mapException, getHttpErrorMessage: undefined };
  adapterPrototype.mapException = stubs.mapException;
  filterPrototype.getHttpErrorMessage = stubs.getHttpErrorMessage;
  try {
    return build();
  } finally {
    adapterPrototype.mapException = mapException;
    filterPrototype.getHttpErrorMessage = getHttpErrorMessage;
  }
}

describe("the adapter's read of the core", () => {
  describe("mapException", () => {
    const newer = withCore(true, () => new BunHttpAdapter());
    const older = withCore(false, () => new BunHttpAdapter());

    it("from 12.3.0, maps a client error in http-errors' shape, keeping its message and cause", () => {
      const error = httpError(413, true);
      const mapped = newer.mapException(error) as HttpException;
      expect(mapped).toBeInstanceOf(HttpException);
      expect(mapped.getStatus()).toBe(413);
      expect(mapped.message).toBe("http-errors message");
      expect((mapped as { cause?: unknown }).cause).toBe(error);
    });

    it("from 12.3.0, hides a message that must not be exposed behind the status text", () => {
      const mapped = newer.mapException(httpError(403, false)) as HttpException;
      expect(mapped.getStatus()).toBe(403);
      expect(mapped.message).toBe("Forbidden");
    });

    it("from 12.3.0, leaves a server error and a look-alike unmapped", () => {
      const serverError = httpError(500, true);
      expect(newer.mapException(serverError)).toBe(serverError);
      const lookAlike = Object.assign(new Error("x"), {
        status: 418,
        statusCode: 419,
        expose: true,
      });
      expect(newer.mapException(lookAlike)).toBe(lookAlike);
    });

    it("before 12.3.0, leaves http-errors' shape for the core's filter", () => {
      const error = httpError(413, true);
      expect(older.mapException(error)).toBe(error);
    });

    it("keeps the cause of a bad-JSON or bad-path error on every version", () => {
      for (const adapter of [newer, older]) {
        const error = new SyntaxError("bad json");
        const mapped = adapter.mapException(error) as HttpException;
        expect(mapped.getStatus()).toBe(400);
        expect((mapped as { cause?: unknown }).cause).toBe(error);
      }
    });
  });

  describe("a returned Error", () => {
    /** Boots {@link RepliesModule} on an adapter built on the given core. */
    function bootOn(atLeast12_3: boolean) {
      return bootReplies(withCore(atLeast12_3, () => new BunHttpAdapter()));
    }

    it("from 12.3.0, says only the status: the credential stays home", async () => {
      const { app, base } = await bootOn(true);
      try {
        const answer = await outcome(`${base}/r/err-400`);
        expect(answer.status).toBe(400);
        expect(JSON.parse(answer.body ?? "")).toEqual({
          statusCode: 400,
          message: "Bad Request",
        });
        expect(answer.body).not.toContain(SECRET);

        const unknownStatus = await outcome(`${base}/r/err-599`);
        expect(JSON.parse(unknownStatus.body ?? "")).toEqual({
          statusCode: 599,
          message: "Error",
        });

        // Under a type that is not JSON, it is sent as JSON like any error body.
        const text = await outcome(`${base}/r/err-text`);
        expect(text.headers["content-type"]).toStartWith("application/json");
        expect(text.body).not.toContain(SECRET);

        // A status under 400 is a value like any other, as on Express.
        const ok = await outcome(`${base}/r/err-200`);
        expect(ok.body).toContain(SECRET);
      } finally {
        await app.close();
      }
    });

    it("before 12.3.0, serialises its properties, as Express does there", async () => {
      const { app, base } = await bootOn(false);
      try {
        const answer = await outcome(`${base}/r/err-400`);
        expect(answer.status).toBe(400);
        expect(answer.body).toContain(SECRET);
      } finally {
        await app.close();
      }
    });
  });

  describe.skipIf(!CORE_CALLS_MAP_EXCEPTION)(
    "an over-limit body, on a core that maps through the adapter",
    () => {
      it("reaches @Catch(HttpException) from 12.3.0, with its cause", async () => {
        const { app, base } = await bootReplies(
          withCore(true, () => new BunHttpAdapter()),
        );
        try {
          const answer = await outcome(`${base}/r/json`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ a: "x".repeat(4000) }),
          });
          expect(answer.status).toBe(413);
          expect(JSON.parse(answer.body ?? "")).toEqual({
            filter: "http",
            status: 413,
            cause: "PayloadTooLargeError",
          });
        } finally {
          await app.close();
        }
      });

      it("before 12.3.0, the core's filter answers it, with the adapter's message", async () => {
        const { app, base } = await bootReplies(
          withCore(false, () => new BunHttpAdapter()),
        );
        try {
          const answer = await outcome(`${base}/r/json`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ a: "x".repeat(4000) }),
          });
          expect(answer.status).toBe(413);
          const body = JSON.parse(answer.body ?? "") as Record<string, unknown>;
          expect(body.statusCode).toBe(413);
          expect(body.filter).toBeUndefined();
        } finally {
          await app.close();
        }
      });
    },
  );
});

describe("a StreamableFile whose handler destroys the response", () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    ({ app, base } = await bootReplies(new BunHttpAdapter()));
  });

  afterAll(async () => {
    await app?.close();
  });

  it("resets the connection after the headers, on every Nest", async () => {
    // Twenty times: the reset must never lose the status line, whichever turn
    // of the event loop the failure lands on.
    for (let i = 0; i < 20; i++) {
      const answer = await outcome(`${base}/r/file-fails-handler-destroys`);
      expect(answer).toEqual({
        status: 200,
        ended: "reset",
        headers: { "content-type": "application/octet-stream" },
      });
    }
  });

  it("ends the body when its handler only ends the response", async () => {
    const answer = await outcome(`${base}/r/file-fails-handler-ends`);
    expect(answer.ended).toBe("complete");
    expect(answer.status).toBe(200);
    expect(answer.body).toBe("first");
  });
});
