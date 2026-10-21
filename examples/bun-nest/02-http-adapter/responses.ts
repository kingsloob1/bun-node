/**
 * Responses as `@nestjs/platform-express` sends them, on `BunHttpAdapter`:
 * a status Express refuses, a `StreamableFile` whose client leaves, and a
 * handler that writes and then throws.
 *
 * ```bash
 * bun 02-http-adapter/responses.ts
 * ```
 *
 * Worth knowing:
 *
 * - On Nest 12, `reply()` applies any status Nest passes, `0` and `NaN`
 *   included, and checks it as Express 5's `res.status` does, so an
 *   `HttpException` with such a status ends as Nest's `500`. Nest 11's
 *   platform-express skips a falsy status, and so does the adapter there:
 *   the answer keeps the `200` it had. The adapter tells the two apart by a
 *   capability of the core (`AbstractHttpAdapter.prototype.mapException`,
 *   new in 12.0.0), never a version string, and so does this example.
 * - A `StreamableFile`'s source is destroyed when the client leaves before
 *   it is read to the end, even when it leaves before the handler returned
 *   the file, as on platform-express 12: an abandoned download holds no file
 *   descriptor. This holds on every Nest here.
 * - A handler that `write()`s through `@Res()` and then throws gets Nest's
 *   exception layer, which sees the headers as sent and ends the stream: the
 *   client receives what was written, with the `200` it started with,
 *   rather than waiting forever.
 * - These are socket behaviours, so the requests are served on port 0.
 */
import type { BunResponse } from "@kingsleyweb/bun-common";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  Controller,
  Get,
  HttpException,
  Module,
  Param,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { AbstractHttpAdapter, NestFactory } from "@nestjs/core";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import "reflect-metadata";

/**
 * The installed `@nestjs/common`'s version, for the output: read from its
 * `package.json` on disk, since Nest 12's `exports` map has none.
 * @returns The version string, such as "12.2.0".
 */
async function nestCommonVersion(): Promise<string> {
  let dir = dirname(Bun.resolveSync("@nestjs/common", import.meta.dir));
  for (;;) {
    const file = Bun.file(join(dir, "package.json"));
    if (await file.exists()) {
      const pkg = (await file.json()) as { name?: string; version: string };
      if (pkg.name === "@nestjs/common") return pkg.version;
    }
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error("@nestjs/common's package.json was not found");
    dir = parent;
  }
}

/** The installed `@nestjs/common`'s version: printed, it gates nothing. */
const NEST_VERSION = await nestCommonVersion();

/**
 * Whether the core is Nest 12's, whose platform-express applies every
 * non-nil status: `mapException` arrived on `AbstractHttpAdapter` in 12.0.0.
 */
const NEST_12_REPLY =
  typeof (AbstractHttpAdapter.prototype as { mapException?: unknown })
    .mapException === "function";

/** A promise with its opener. */
function gate(): { promise: Promise<void>; open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

/** Tags of the `StreamableFile` sources that have closed. */
const closedSources = new Set<string>();

/** Opened by `/files/late` once its source exists; the script then leaves. */
const lateEntered = gate();
/** `/files/late` returns its file once this is opened. */
const lateRelease = gate();

/** An endless source that records `tag` in {@link closedSources} once it closes. */
function endlessSource(tag: string): Readable {
  let i = 0;
  const source = new Readable({
    read() {
      setTimeout(() => this.push(`chunk ${i++}\n`), 10);
    },
  });
  source.once("close", () => closedSources.add(tag));
  return source;
}

@Controller()
class ResponsesController {
  @Get("status/zero")
  statusZero() {
    throw new HttpException("zero", 0);
  }

  @Get("status/nan")
  statusNan() {
    throw new HttpException("nan", Number.NaN);
  }

  /** An endless download, returned at once. */
  @Get("files/now/:tag")
  now(@Param("tag") tag: string) {
    return new StreamableFile(endlessSource(tag));
  }

  /** An endless download, returned only after the client has gone. */
  @Get("files/late/:tag")
  async late(@Param("tag") tag: string) {
    const source = endlessSource(tag);
    lateEntered.open();
    await lateRelease.promise;
    return new StreamableFile(source);
  }

  /** Writes, then throws in the same tick. */
  @Get("write-then-throw/sync")
  writeThenThrowSync(@Res() res: BunResponse) {
    res.write("partial");
    throw new Error("after write");
  }

  /** Writes, then throws a few milliseconds later. */
  @Get("write-then-throw/async")
  async writeThenThrowAsync(@Res() res: BunResponse) {
    res.write("partial");
    await Bun.sleep(5);
    throw new Error("after write");
  }
}

@Module({ controllers: [ResponsesController] })
class ResponsesModule {}

/**
 * `work`'s result, or `"hung for <ms> ms"` if it takes longer; the timer is
 * cleared either way, so it never holds the process open.
 */
async function within<T>(ms: number, work: Promise<T>): Promise<T | string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`hung for ${ms} ms`), ms);
  });
  try {
    return await Promise.race([work, hung]);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
title("Responses as platform-express sends them");
show("@nestjs/common", NEST_VERSION);

const adapter = new BunHttpAdapter();
const app = await NestFactory.create(ResponsesModule, adapter, {
  logger: false,
});
await app.listen(0);
const url = await app.getUrl();

/** A served request's status and JSON body. */
async function statusAndBody(path: string) {
  const response = await fetch(`${url}${path}`);
  return { status: response.status, body: await response.json() };
}

step("A status Express refuses: 0 and NaN");
{
  const zero = await statusAndBody("/status/zero");
  const nan = await statusAndBody("/status/nan");
  show("HttpException('zero', 0)", zero);
  show("HttpException('nan', NaN)", nan);
  if (NEST_12_REPLY) {
    const internal = {
      status: 500,
      body: { statusCode: 500, message: "Internal server error" },
    };
    checkEqual(
      "Nest 12: the status is applied, Express 5's check refuses it, Nest answers 500",
      [zero, nan],
      [internal, internal],
    );
  } else {
    checkEqual(
      "Nest 11: a falsy status is skipped, as its platform-express skips it",
      [zero.status, nan.status],
      [200, 200],
    );
  }
}

/* ------------------------------------------------------------------ */
step("A StreamableFile's source is destroyed when the client leaves");
{
  const reader = (
    await fetch(`${url}/files/now/read-then-left`)
  ).body!.getReader();
  const first = await reader.read();
  show("first chunk", new TextDecoder().decode(first.value));
  check(
    "the source is open while the client reads",
    !closedSources.has("read-then-left"),
  );
  await reader.cancel();
  await waitFor("the source to close", () =>
    closedSources.has("read-then-left"),
  ).catch(() => undefined);
  check(
    "it closes once the client cancels mid-download",
    closedSources.has("read-then-left"),
    [...closedSources],
  );

  const leaving = new AbortController();
  const request = fetch(`${url}/files/late/left-early`, {
    signal: leaving.signal,
  }).catch(() => "aborted");
  await lateEntered.promise;
  leaving.abort();
  await request;
  // Give the server time to see the disconnect, then let the handler return.
  await Bun.sleep(100);
  lateRelease.open();
  await waitFor("the late source to close", () =>
    closedSources.has("left-early"),
  ).catch(() => undefined);
  check(
    "it closes when the client left before the handler returned the file",
    closedSources.has("left-early"),
    [...closedSources],
  );
}

/* ------------------------------------------------------------------ */
step("A handler that writes, then throws: the stream ends");
for (const kind of ["sync", "async"]) {
  const answer = await within(
    10_000,
    fetch(`${url}/write-then-throw/${kind}`).then(async (response) => ({
      status: response.status,
      body: await response.text(),
    })),
  );
  show(`GET /write-then-throw/${kind}`, answer);
  checkEqual(
    `${kind}: the client gets what was written, with its 200, and the end`,
    answer,
    { status: 200, body: "partial" },
  );
}

await app.close();
summary();
