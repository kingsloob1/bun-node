/**
 * The adapter's instrumentation hooks: `setOnRequestHook` and
 * `setOnResponseHook` (platform-express's), and `addBeforeWriteHook`
 * (bun-nest's own, for checking a response before it is written).
 *
 * ```bash
 * bun 02-http-adapter/hooks.ts
 * ```
 *
 * Worth knowing:
 *
 * - All three are off by default, and cost one field read per request while
 *   none is set. They work on every Nest this adapter supports.
 * - `setOnRequestHook((req, res, done) => …)` runs first for every request,
 *   before middleware, body parsing and routes. The request continues on
 *   `done()`, not when a returned promise resolves; `done(error)` sends the
 *   error to Nest's exception layer. Only the first completion counts.
 * - `setOnResponseHook((req, res) => …)` runs after the response is sent, so
 *   it reads the outcome and cannot change it. It also sees the answers of
 *   the adapter's error handling: a middleware's error, a refused body.
 * - `addBeforeWriteHook((context) => …)` sees each response once it is
 *   produced and before any of it is written: `phase` (`"response"` for
 *   what the request's own handlers produced, Nest's not-found answer
 *   included, or `"error"` for one the error handling produced), the final
 *   `status`, the `headers` exactly as they will be written, and `body.kind`
 *   (with the value of a buffered body; a stream is never read). Throwing
 *   refuses the response: it is discarded and the error goes through Nest's
 *   filters, so the client gets a `500` (or an `HttpException`'s status)
 *   keeping the request-wide headers such as CORS, but not the refused
 *   response's own `Location`, `Set-Cookie`, `Content-*` or `ETag`. A throw
 *   in phase `"error"` is only logged, so a check cannot loop.
 *   `addBeforeWriteHook` returns a function that removes the hook.
 * - Requests go through `adapter.fetch()`, the pipeline `Bun.serve` runs,
 *   with no socket.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { BunBeforeWriteContext } from "@kingsleyweb/bun-nest";
import { Readable } from "node:stream";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  Body,
  Controller,
  Get,
  HttpException,
  Module,
  Post,
  Redirect,
  StreamableFile,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import "reflect-metadata";

/** What ran for the request being shown, in order. */
const trail: string[] = [];

@Controller()
class HooksController {
  @Get("items")
  items() {
    trail.push("handler");
    return { items: ["pen"] };
  }

  @Post("items")
  create(@Body() body: unknown) {
    return { body: body ?? null };
  }

  @Get("text")
  text() {
    return "plain words";
  }

  @Get("old")
  @Redirect("/items", 301)
  old() {}

  @Get("file")
  file() {
    return new StreamableFile(Readable.from(["a,b\n"]), { type: "text/csv" });
  }
}

@Module({ controllers: [HooksController] })
class HooksModule {}

/** Records itself in the trail, and fails `/mw-fails` with a 418. */
function middleware(
  req: BunRequest,
  _res: BunResponse,
  next: (error?: unknown) => void,
) {
  trail.push("middleware");
  next(
    req.path === "/mw-fails"
      ? new HttpException("middleware refused", 418)
      : undefined,
  );
}

/* ------------------------------------------------------------------ */
title("Instrumentation hooks on BunHttpAdapter");

const adapter = new BunHttpAdapter();
const app = await NestFactory.create(HooksModule, adapter, {
  logger: false,
  cors: { origin: "https://shop.test" },
});
app.use(middleware);

/** The statuses `setOnResponseHook` saw, in order. */
const responded: number[] = [];

adapter.setOnRequestHook((req, res, done) => {
  trail.push("request hook");
  if (req.path === "/refused-by-hook") {
    done(new HttpException("the request hook refused", 403));
    return;
  }
  res.setHeader("x-request-id", "r-1");
  done();
});
adapter.setOnResponseHook((_req, res) => {
  responded.push(res.statusCode);
});

await app.init();

/** A request through the whole pipeline, with no socket; its status and JSON or text body. */
async function ask(path: string, init?: RequestInit) {
  trail.length = 0;
  const response = await adapter.fetch(path, init);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: kept as text
  }
  return { status: response.status, headers: response.headers, body };
}

step("setOnRequestHook: first for every request");
{
  const answer = await ask("/items");
  show("GET /items ran", trail);
  checkEqual(
    "the request hook runs before the middleware and the route; done() continues",
    [answer.status, [...trail]],
    [200, ["request hook", "middleware", "handler"]],
  );
  checkEqual(
    "what it set on the response is on the answer",
    answer.headers.get("x-request-id"),
    "r-1",
  );

  const refused = await ask("/refused-by-hook");
  show("GET /refused-by-hook", refused.body);
  checkEqual(
    "done(error) goes to Nest's exception layer: its 403, and nothing after the hook runs",
    [refused.status, refused.body, [...trail]],
    [
      403,
      { statusCode: 403, message: "the request hook refused" },
      ["request hook"],
    ],
  );
  // The response hook runs a turn after each send: let these two arrive
  // before the next step counts.
  await waitFor("two responses seen", () => responded.length >= 2).catch(
    () => undefined,
  );
}

/* ------------------------------------------------------------------ */
step("setOnResponseHook: after the send, error answers included");
{
  responded.length = 0;
  const statuses = [
    (await ask("/items")).status,
    (await ask("/nope")).status,
    (await ask("/mw-fails")).status,
    (
      await ask("/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      })
    ).status,
  ];
  await waitFor("four responses seen", () => responded.length >= 4).catch(
    () => undefined,
  );
  show("statuses answered", statuses);
  show("statuses the response hook saw", responded);
  checkEqual(
    "it sees each response's final status: a route's, Nest's 404, a middleware's error, a refused body",
    { answered: statuses, seen: [...responded] },
    { answered: [200, 404, 418, 400], seen: [200, 404, 418, 400] },
  );
}

/* ------------------------------------------------------------------ */
step("addBeforeWriteHook: each response before it is written");
{
  /** What the hook saw, one line per response. */
  const seen: string[] = [];
  /** The path the hook refuses, when set. */
  let refusePath: string | undefined;

  const removeHook = adapter.addBeforeWriteHook(
    (context: BunBeforeWriteContext) => {
      seen.push(
        `${context.phase} ${context.status} ${context.body.kind} ${context.request.path}`,
      );
      if (context.phase === "response" && context.request.path === refusePath) {
        throw new Error("does not match its schema");
      }
    },
  );

  for (const path of ["/items", "/text", "/old", "/file", "/nope"]) {
    await ask(path);
  }
  show("seen", seen);
  checkEqual(
    "phase, the final status and the body's kind: a route, text, a redirect, a file, and Nest's 404",
    [...seen],
    [
      "response 200 json /items",
      "response 200 text /text",
      "response 301 text /old",
      "response 200 streamable-file /file",
      "response 404 json /nope",
    ],
  );

  seen.length = 0;
  refusePath = "/old";
  const refused = await ask("/old", {
    headers: { origin: "https://shop.test" },
  });
  show("GET /old, refused", refused.body);
  checkEqual(
    "a throw refuses it: Nest's 500, keeping CORS, without the redirect's Location",
    {
      status: refused.status,
      body: refused.body,
      cors: refused.headers.get("access-control-allow-origin"),
      location: refused.headers.get("location"),
    },
    {
      status: 500,
      body: { statusCode: 500, message: "Internal server error" },
      cors: "https://shop.test",
      location: null,
    },
  );
  checkEqual(
    "the 500 is seen too, in phase error",
    [...seen],
    ["response 301 text /old", "error 500 response /old"],
  );

  removeHook();
  seen.length = 0;
  const after = await ask("/old");
  check(
    "the remover removes it: the same redirect goes out, and nothing is seen",
    after.status === 301 &&
      after.headers.get("location") === "/items" &&
      seen.length === 0,
    { after: [after.status, after.headers.get("location")], seen },
  );
}

await app.close();
summary();
