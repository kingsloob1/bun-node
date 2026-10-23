/**
 * bun-validate V7b (plan `docs/plans/bun-validate/` §4.5.4, §4.7.2):
 * `@Validate({ responses, responseValidation })`, the response side, through
 * Nest's real pipeline on bun-nest's adapter and `fetch()`. The interceptor
 * checks what `map()` and `catchError` see (the final status, the `@Header()`
 * headers, the returned body, a thrown non-2xx) and each `@Sse()` event; the
 * adapter's before-write hook checks what they cannot (a plain `@Res()`, a
 * `StreamableFile`, a redirect). A refusal is a `ResponseValidationError`
 * (500), which `ValidationExceptionFilter` answers with
 * `{ error: "Response validation failed", issues }`.
 *
 * Covered: every declared-status case (R1–R6), response headers (R7–R8),
 * `reply()` (R9–R13), thrown non-2xx (R14–R16), plain `@Res()` (R17–R18),
 * `StreamableFile` (R19–R20), redirects (R21–R22), `@Sse()` (R23–R25),
 * `variants()` (R26–R29), the `warn`/`off` modes (R30–R31), the parsed output
 * (V13, R35–R37), the global
 * `ResponseValidationInterceptor` (R32–R33) and, on Nest 12 only, the
 * serializer's placement (R34).
 *
 * A bad body plants `SECRET` everywhere one is refused: no answer, issue or
 * `event: error` data may quote it. The same file runs on Nest 12 (the lock)
 * and in the nest-matrix's Nest 11 column; R34 reads the capability (whether
 * the installed `@nestjs/common` has `StandardSchemaValidationPipe`), never a
 * version, and builds its module by call so nothing Nest-12-only is touched
 * at load on 11.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other test files.
 */
import type { INestApplication, MessageEvent } from "@nestjs/common";
import { Buffer } from "node:buffer";
import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Module,
  Post,
  Redirect,
  Res,
  Sse,
  StreamableFile,
} from "@nestjs/common";
import * as nestCommon from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { from, Observable, of } from "rxjs";
import { z } from "zod";
import { opaque, sse, variants } from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  reply,
  ResponseValidationInterceptor,
  Validate,
  ValidationExceptionFilter,
} from "../lib";
import "reflect-metadata";

/* ---- schemas -------------------------------------------------------- */

const User = z.object({ id: z.number(), name: z.string() });
const Created = z.object({ id: z.number() });
const Problem = z.object({ error: z.string() });
const CreateUser = z.object({
  name: z.string().min(1),
  age: z.coerce.number().int(),
});

/** A value no answer, issue or stream event may quote. */
const SECRET = "hunter2-the-response-id";

/* ---- the application, map()/catchError side -------------------------- */

const replyResponses = {
  201: { content: { "application/json": Created } },
} as const;

const replyHeaderResponses = {
  201: {
    headers: z.object({ "x-a": z.literal("1") }),
    content: { "application/json": Created },
  },
} as const;

const AdminRequestHeaders = z.object({ "x-admin": z.literal("1").optional() });
const AdminView = z.object({ id: z.number(), role: z.literal("admin") });
const UserView = z.object({ id: z.number(), role: z.literal("user") }).strict();

const variantResponses = {
  200: variants({
    admin: {
      when: (valid) =>
        (valid.headers as Record<string, unknown> | undefined)?.["x-admin"] ===
        "1",
      headers: z.object({ "x-admin": z.literal("1") }),
      content: { "application/json": AdminView },
    },
    user: { content: { "application/json": UserView } },
  }),
} as const;

@Controller()
class ResponsesController {
  @Validate({ responses: { 200: User }, responseValidation: "error" })
  @Get("ok")
  ok() {
    return { id: 1, name: "ada" };
  }

  @Validate({ responses: { 200: User }, responseValidation: "error" })
  @Get("bad")
  bad() {
    return { id: SECRET, name: "ada" };
  }

  @Validate({ responses: { 201: Created }, responseValidation: "error" })
  @Post("made")
  made() {
    return { id: 1 };
  }

  @Validate({ responses: { 202: Created }, responseValidation: "error" })
  @HttpCode(202)
  @Get("accepted")
  accepted() {
    return { id: 2 };
  }

  @Validate({ responses: { 200: User }, responseValidation: "error" })
  @HttpCode(418)
  @Get("teapot")
  teapot() {
    return { id: 1, name: "ada" };
  }

  @Validate({
    responses: {
      200: {
        headers: z.object({ "x-n": z.coerce.number().int() }),
        content: { "application/json": User },
      },
    },
    responseValidation: "error",
  })
  @Header("x-n", "5")
  @Get("header-ok")
  headerOk() {
    return { id: 1, name: "ada" };
  }

  @Validate({
    responses: {
      200: {
        headers: z.object({ "x-n": z.coerce.number().int() }),
        content: { "application/json": User },
      },
    },
    responseValidation: "error",
  })
  @Header("x-n", "abc")
  @Get("header-bad")
  headerBad() {
    return { id: 1, name: "ada" };
  }

  @Validate({ responses: replyResponses, responseValidation: "error" })
  @Post("reply-ok")
  replyOk() {
    return reply<typeof replyResponses>(201, { id: 7 });
  }

  @Validate({ responses: replyResponses, responseValidation: "error" })
  @Post("reply-bad")
  replyBad() {
    return reply<typeof replyResponses>(201, { id: SECRET } as never);
  }

  @Validate({ responses: replyResponses, responseValidation: "error" })
  @Post("reply-undeclared")
  replyUndeclared() {
    return reply<typeof replyResponses>(418 as never, { id: 1 } as never);
  }

  @Validate({ responses: replyHeaderResponses, responseValidation: "error" })
  @Post("reply-header-ok")
  replyHeaderOk() {
    return reply<typeof replyHeaderResponses>(
      201,
      { id: 7 },
      { headers: { "x-a": "1" } },
    );
  }

  @Validate({ responses: replyHeaderResponses, responseValidation: "error" })
  @Post("reply-header-missing")
  replyHeaderMissing() {
    return reply<typeof replyHeaderResponses>(201, { id: 7 });
  }

  @Validate({ responses: { 409: Problem }, responseValidation: "error" })
  @Get("conflict")
  conflict() {
    throw new HttpException({ error: "taken" }, 409);
  }

  @Validate({ responses: { 409: Problem }, responseValidation: "error" })
  @Get("conflict-bad")
  conflictBad() {
    throw new HttpException({ wrong: SECRET }, 409);
  }

  @Validate({
    body: CreateUser,
    responses: { 201: Created },
    responseValidation: "error",
  })
  @Post("guarded")
  guarded() {
    return { id: 1 };
  }

  @Validate({ responses: { 200: User }, responseValidation: "warn" })
  @Get("warned")
  warned() {
    return { id: SECRET, name: "ada" };
  }

  @Validate({ responses: { 200: User } })
  @Get("unchecked")
  unchecked() {
    return { id: SECRET, name: "ada" };
  }
}

@Controller()
class VariantsController {
  @Validate({
    headers: AdminRequestHeaders,
    responses: variantResponses,
    responseValidation: "error",
  })
  @Get("view-user")
  viewUser() {
    return { id: 1, role: "user" };
  }

  @Validate({
    headers: AdminRequestHeaders,
    responses: variantResponses,
    responseValidation: "error",
  })
  @Header("x-admin", "1")
  @Get("view-admin")
  viewAdmin() {
    return { id: 1, role: "admin" };
  }

  @Validate({
    headers: AdminRequestHeaders,
    responses: variantResponses,
    responseValidation: "error",
  })
  @Header("x-admin", "1")
  @Get("view-leak")
  viewLeak() {
    return { id: 1, role: "admin" };
  }

  @Validate({
    headers: AdminRequestHeaders,
    responses: variantResponses,
    responseValidation: "error",
  })
  @Get("view-reply")
  viewReply() {
    return reply<typeof variantResponses>(
      200,
      { id: 1, extra: "begone" } as never,
      { variant: "admin" },
    );
  }
}

@Module({ controllers: [ResponsesController, VariantsController] })
class ResponsesModule {}

/* ---- the before-write hook side: plain @Res(), StreamableFile, redirect */

/** A response object as the plain `@Res()` routes use it. */
interface RouteRes {
  status: (code: number) => RouteRes;
  json: (body: unknown) => unknown;
}

@Controller()
class HookController {
  @Validate({
    responses: { 206: z.object({ raw: z.literal(true) }) },
    responseValidation: "error",
  })
  @Get("raw-ok")
  rawOk(@Res() res: RouteRes) {
    res.status(206).json({ raw: true });
  }

  @Validate({ responses: { 200: User }, responseValidation: "error" })
  @Get("raw-bad")
  rawBad(@Res() res: RouteRes) {
    res.status(200).json({ id: SECRET, name: "ada" });
  }

  @Validate({
    responses: { 200: { content: { "text/csv": opaque() } } },
    responseValidation: "error",
  })
  @Get("file")
  file() {
    return new StreamableFile(Buffer.from("a,b\n1,2\n"), { type: "text/csv" });
  }

  @Validate({
    responses: { 200: { content: { "application/json": User } } },
    responseValidation: "error",
  })
  @Get("file-wrong-type")
  fileWrongType() {
    return new StreamableFile(Buffer.from("a,b\n1,2\n"), { type: "text/csv" });
  }

  @Validate({
    responses: {
      301: { headers: z.object({ location: z.string().startsWith("/app") }) },
    },
    responseValidation: "error",
  })
  @Redirect()
  @Get("goto-ok")
  gotoOk() {
    return { url: "/app/target", statusCode: 301 };
  }

  @Validate({
    responses: {
      301: { headers: z.object({ location: z.string().startsWith("/app") }) },
    },
    responseValidation: "error",
  })
  @Redirect()
  @Get("goto-bad")
  gotoBad() {
    return { url: "/elsewhere/target", statusCode: 301 };
  }
}

@Module({ controllers: [HookController] })
class HookModule {}

/* ---- the parsed output (V13) -------------------------------------------------- */

/** V13's shape: `id`, a defaulted `role`; zod strips an unknown key. */
const Packed = z.object({
  id: z.number(),
  role: z.string().default("user"),
});

/** The reply route's table, shared by the decorator and `reply()`. */
const packedResponses = {
  201: { content: { "application/json": Packed } },
} as const;

@Controller()
class ParsedController {
  @Validate({
    responses: { 200: { content: { "application/json": Packed } } },
    responseValidation: "error",
    responseOutput: "parsed",
  })
  @Get("parsed-return")
  parsedReturn() {
    return { id: 1, password: SECRET };
  }

  @Validate({
    responses: packedResponses,
    responseValidation: "error",
    responseOutput: "parsed",
  })
  @Post("parsed-reply")
  parsedReply() {
    // The typed body refuses an undeclared key at compile time; the wire
    // shows the parse: the default applied.
    return reply<typeof packedResponses>(201, { id: 2 });
  }

  @Validate({
    responses: { 200: { content: { "application/json": Packed } } },
    responseValidation: "error",
    responseOutput: "parsed",
  })
  @Get("parsed-res")
  parsedRes(@Res() res: RouteRes) {
    // The before-write hook passes or refuses, never replaces: checked as sent.
    res.status(200).json({ id: 1, password: SECRET });
  }
}

@Module({ controllers: [ParsedController] })
class ParsedModule {}

/* ---- @Sse() ---------------------------------------------------------- */

const sseResponses = {
  200: {
    content: {
      "text/event-stream": sse({ tick: z.object({ n: z.number() }) }),
    },
  },
};

@Controller()
class SseController {
  @Validate({ responses: sseResponses, responseValidation: "error" })
  @Sse("ticks-ok")
  ticksOk(): Observable<MessageEvent> {
    return of({ comment: "hb" } as unknown as MessageEvent, {
      type: "tick",
      data: { n: 1 },
    });
  }

  @Validate({ responses: sseResponses, responseValidation: "error" })
  @Sse("ticks-cut")
  ticksCut(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      subscriber.next({ type: "tick", data: { n: 1 } });
      // Asynchronous, so the good event (and with it the headers) is written
      // first: the refusal then reaches the client as Nest's `event: error`.
      setTimeout(() => {
        subscriber.next({ type: "tick", data: { n: SECRET } });
      }, 5);
    });
  }

  @Validate({ responses: sseResponses, responseValidation: "error" })
  @Sse("ticks-burst")
  ticksBurst(): Observable<MessageEvent> {
    // A synchronous burst, the good event and a bad one in one emission:
    // both must be checked, in order (a concurrency hole once let the bad
    // one through, unchecked and first).
    return from([
      { type: "tick", data: { n: 1 } },
      { type: "tick", data: { n: SECRET } },
    ] as MessageEvent[]);
  }

  @Validate({ responses: sseResponses, responseValidation: "error" })
  @Sse("ticks-bad-first")
  ticksBadFirst(): Observable<MessageEvent> {
    return of({ type: "tick", data: { n: SECRET } } as MessageEvent);
  }
}

@Module({ controllers: [SseController] })
class SseModule {}

/* ---- the global ResponseValidationInterceptor ------------------------ */

@Controller()
class WatchedController {
  // The route's own `@Validate` checks under the default "off" (it would only
  // adjust a named variant); the global interceptor's "error" refuses.
  @Validate({ responses: { 200: User } })
  @Get("watched")
  watched() {
    return { id: SECRET, name: "ada" };
  }

  @Get("unwatched")
  unwatched() {
    return { id: SECRET, name: "ada" };
  }
}

@Module({ controllers: [WatchedController] })
class WatchedModule {}

/* ---- the serializer's placement (Nest 12 only) ----------------------- */

/** Nest 12's own schema pipe: the capability the serializer arrived with. */
const NestSchemaPipe = (nestCommon as unknown as Record<string, unknown>)
  .StandardSchemaValidationPipe;

/** Nest 12's `StandardSchemaSerializerInterceptor`, when installed. */
const StandardSerializer = (nestCommon as unknown as Record<string, unknown>)
  .StandardSchemaSerializerInterceptor as
  (new (reflector: unknown) => object) | undefined;

/** Nest 12's `@SerializeOptions`, when installed. */
const SerializeOptions = (nestCommon as unknown as Record<string, unknown>)
  .SerializeOptions as
  ((options: { schema: unknown }) => MethodDecorator) | undefined;

/** Upper-cases `name`: the serialized output differs from the handler's return. */
const SerializerSchema = z.object({
  name: z.string().transform((name) => name.toUpperCase()),
});

/**
 * The serializer probe's module, built by call so nothing Nest-12-only runs
 * at load on Nest 11. The route's declared 200 matches the handler's RAW
 * return (`{ name: "ada" }`), never the serialized output (`{ name: "ADA" }`).
 */
function serializerModule(): new () => object {
  class SerializerController {
    serialized() {
      return { name: "ada" };
    }
  }
  const proto = SerializerController.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "serialized")!;
  Get("serialized")(proto, "serialized", descriptor);
  SerializeOptions!({ schema: SerializerSchema })(
    proto,
    "serialized",
    descriptor,
  );
  Validate({
    responses: { 200: z.object({ name: z.literal("ada") }) },
    responseValidation: "error",
  })(proto, "serialized", descriptor);
  Controller()(SerializerController);

  class SerializerModule {}
  Module({ controllers: [SerializerController] })(SerializerModule);
  return SerializerModule;
}

/* ---- boot ------------------------------------------------------------ */

const apps: INestApplication[] = [];

/** Boots `module` on a fresh adapter; `setup` runs before `init()`. */
async function boot(
  module: new () => object,
  setup?: (app: INestApplication) => void,
): Promise<BunHttpAdapter> {
  const adapter = new BunHttpAdapter(0);
  const app = await NestFactory.create(module, adapter, { logger: false });
  setup?.(app);
  await app.init();
  apps.push(app);
  return adapter;
}

let filtered: BunHttpAdapter; // ResponsesModule + ValidationExceptionFilter
let bare: BunHttpAdapter; // ResponsesModule, no filter (Nest's own 500)
let hooked: BunHttpAdapter; // HookModule + filter
let events: BunHttpAdapter; // SseModule + filter
let watched: BunHttpAdapter; // WatchedModule + global ResponseValidationInterceptor
let parsed: BunHttpAdapter; // ParsedModule (V13), no filter needed: nothing is refused
let serialized: BunHttpAdapter | undefined; // SerializerModule (Nest 12 only)

beforeAll(async () => {
  filtered = await boot(ResponsesModule, (app) => {
    app.useGlobalFilters(new ValidationExceptionFilter());
  });
  bare = await boot(ResponsesModule);
  hooked = await boot(HookModule, (app) => {
    app.useGlobalFilters(new ValidationExceptionFilter());
  });
  events = await boot(SseModule, (app) => {
    app.useGlobalFilters(new ValidationExceptionFilter());
  });
  watched = await boot(WatchedModule, (app) => {
    app.useGlobalFilters(new ValidationExceptionFilter());
    app.useGlobalInterceptors(new ResponseValidationInterceptor());
  });
  parsed = await boot(ParsedModule);
  if (NestSchemaPipe !== undefined) {
    serialized = await boot(serializerModule(), (app) => {
      app.useGlobalFilters(new ValidationExceptionFilter());
      app.useGlobalInterceptors(
        new (StandardSerializer as new (reflector: unknown) => never)(
          app.get(Reflector),
        ),
      );
    });
  }
});

afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

/** Status and parsed JSON body. */
async function answer(
  response: Response,
): Promise<{ status: number; body: unknown }> {
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : text };
}

const get = (adapter: BunHttpAdapter, path: string, init?: RequestInit) =>
  adapter.fetch(path, init).then(answer);

const post = (adapter: BunHttpAdapter, path: string, body: unknown) =>
  adapter
    .fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    .then(answer);

/** The issues of a filter answer, typed for the assertions. */
interface IssueView {
  target: string;
  path: string;
  key?: string;
  mediaType?: string;
  variant?: string;
  message: string;
}

/** The `{ error, issues }` a refusal answers with under the filter. */
function refusal(body: unknown): { error: string; issues: IssueView[] } {
  return body as { error: string; issues: IssueView[] };
}

/* ---- declared statuses, checked in map() ------------------------------ */

describe("@Validate responses: declared statuses (R1–R6)", () => {
  it("R1: a valid 200 passes", async () => {
    expect(await get(filtered, "/ok")).toEqual({
      status: 200,
      body: { id: 1, name: "ada" },
    });
  });

  it("R2: a body mismatch is a 500 under the filter, with no value quoted", async () => {
    const { status, body } = await get(filtered, "/bad");
    expect(status).toBe(500);
    const { error, issues } = refusal(body);
    expect(error).toBe("Response validation failed");
    expect(issues[0].target).toBe("body");
    expect(issues[0].key).toBe("200");
    expect(issues[0].path).toBe("id");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("R3: a POST's default 201 passes when declared", async () => {
    expect(await post(filtered, "/made", {})).toEqual({
      status: 201,
      body: { id: 1 },
    });
  });

  it("R4: an @HttpCode(202) passes when declared", async () => {
    expect(await get(filtered, "/accepted")).toEqual({
      status: 202,
      body: { id: 2 },
    });
  });

  it("R5: an undeclared status (@HttpCode(418)) is refused, target status", async () => {
    const { status, body } = await get(filtered, "/teapot");
    expect(status).toBe(500);
    const { error, issues } = refusal(body);
    expect(error).toBe("Response validation failed");
    expect(issues.map((issue) => issue.target)).toEqual(["status"]);
    expect(issues[0].key).toBe("418");
  });

  it("R6: without the filter, the refusal is Nest's own 500, still value-free", async () => {
    const { status, body } = await get(bare, "/bad");
    expect(status).toBe(500);
    expect(body).toEqual({
      statusCode: 500,
      message: "Internal server error",
    });
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
});

/* ---- response headers -------------------------------------------------- */

describe("@Validate responses: @Header() headers (R7–R8)", () => {
  it("R7: a declared header, coerced, passes", async () => {
    const res = await filtered.fetch("/header-ok");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-n")).toBe("5");
    expect(await res.json()).toEqual({ id: 1, name: "ada" });
  });

  it("R8: a header value the schema refuses is a 500, target headers", async () => {
    const { status, body } = await get(filtered, "/header-bad");
    expect(status).toBe(500);
    const { error, issues } = refusal(body);
    expect(error).toBe("Response validation failed");
    expect(issues[0].target).toBe("headers");
    expect(issues[0].path).toBe("x-n");
    expect(issues[0].key).toBe("200");
  });
});

/* ---- reply() ----------------------------------------------------------- */

describe("@Validate responses: reply() (R9–R13)", () => {
  it("R9: reply(201, …) from a @Post() answers 201, checked", async () => {
    expect(await post(filtered, "/reply-ok", {})).toEqual({
      status: 201,
      body: { id: 7 },
    });
  });

  it("R10: a reply() whose body breaks the status's schema is a 500", async () => {
    const { status, body } = await post(filtered, "/reply-bad", {});
    expect(status).toBe(500);
    const { error, issues } = refusal(body);
    expect(error).toBe("Response validation failed");
    expect(issues[0].target).toBe("body");
    expect(issues[0].key).toBe("201");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("R11: a reply() at an undeclared status is a 500, target status", async () => {
    const { status, body } = await post(filtered, "/reply-undeclared", {});
    expect(status).toBe(500);
    const { error, issues } = refusal(body);
    expect(error).toBe("Response validation failed");
    expect(issues.map((issue) => issue.target)).toEqual(["status"]);
    expect(issues[0].key).toBe("418");
  });

  it("R12: reply() headers are applied before the check: a declared required header passes", async () => {
    const res = await filtered.fetch("/reply-header-ok", { method: "POST" });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-a")).toBe("1");
    expect(await res.json()).toEqual({ id: 7 });
  });

  it("R13: a reply() missing a declared required header is a 500, target headers", async () => {
    const { status, body } = await post(filtered, "/reply-header-missing", {});
    expect(status).toBe(500);
    const { error, issues } = refusal(body);
    expect(error).toBe("Response validation failed");
    expect(issues[0].target).toBe("headers");
    expect(issues[0].path).toBe("x-a");
    expect(issues[0].key).toBe("201");
  });
});

/* ---- thrown non-2xx, checked in catchError ------------------------------ */

describe("@Validate responses: thrown non-2xx (R14–R16)", () => {
  it("R14: a thrown 409 whose body keeps the declared schema passes through unchanged", async () => {
    expect(await get(filtered, "/conflict")).toEqual({
      status: 409,
      body: { error: "taken" },
    });
  });

  it("R15: a thrown 409 whose body breaks the declared schema is a 500 keyed 409", async () => {
    const { status, body } = await get(filtered, "/conflict-bad");
    expect(status).toBe(500);
    const { error, issues } = refusal(body);
    expect(error).toBe("Response validation failed");
    expect(issues[0].target).toBe("body");
    expect(issues[0].key).toBe("409");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("R16: a thrown StandardValidationException is rethrown unchecked (a 400, never double-wrapped)", async () => {
    const { status, body } = await post(filtered, "/guarded", {
      name: "",
      age: "x",
    });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("Validation failed");
  });
});

/* ---- plain @Res(), checked by the before-write hook --------------------- */

describe("@Validate responses: plain @Res() through the before-write hook (R17–R18)", () => {
  it("R17: res.status(206).json(valid) passes, as sent", async () => {
    expect(await get(hooked, "/raw-ok")).toEqual({
      status: 206,
      body: { raw: true },
    });
  });

  it("R18: res.status(200).json(bad) is refused: a fresh 500, the bad body never sent", async () => {
    const { status, body } = await get(hooked, "/raw-bad");
    expect(status).toBe(500);
    const { error, issues } = refusal(body);
    expect(error).toBe("Response validation failed");
    expect(issues[0].target).toBe("body");
    expect(issues[0].key).toBe("200");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
});

/* ---- StreamableFile, checked by the before-write hook -------------------- */

describe("@Validate responses: StreamableFile through the before-write hook (R19–R20)", () => {
  it("R19: a declared content type (opaque()) passes, bytes intact", async () => {
    const res = await hooked.fetch("/file");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(await res.text()).toBe("a,b\n1,2\n");
  });

  it("R20: a media type the status does not declare is refused", async () => {
    const { status, body } = await get(hooked, "/file-wrong-type");
    expect(status).toBe(500);
    const { error, issues } = refusal(body);
    expect(error).toBe("Response validation failed");
    expect(issues[0].target).toBe("body");
    expect(issues[0].key).toBe("200");
  });
});

/* ---- redirects, checked by the before-write hook ------------------------- */

describe("@Validate responses: redirects through the before-write hook (R21–R22)", () => {
  it("R21: a redirect whose location the schema accepts passes, with its Location", async () => {
    const res = await hooked.fetch("/goto-ok");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/app/target");
    await res.body?.cancel();
  });

  it("R22: a redirect whose location the schema refuses is a 500, the Location dropped", async () => {
    const res = await hooked.fetch("/goto-bad");
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
    const { error, issues } = refusal(await res.json());
    expect(error).toBe("Response validation failed");
    expect(issues[0].target).toBe("headers");
    expect(issues[0].path).toBe("location");
    expect(issues[0].key).toBe("301");
  });
});

/* ---- @Sse() --------------------------------------------------------------- */

describe("@Validate responses: @Sse() per event (R23–R25)", () => {
  it("R23: a valid tick and a comment-only heartbeat pass, unchecked heartbeat and all", async () => {
    const res = await events.fetch("/ticks-ok");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    // The heartbeat is never checked: no refusal, on any Nest. How it is
    // serialised is Nest's own (a `: hb` comment line where SseStream knows
    // comments, an id-only line on Nest 11.1), not this check's concern.
    expect(text).not.toContain("event: error");
    expect(text).toContain("event: tick");
    expect(text).toContain('data: {"n":1}');
  });

  it("R24: a bad event after the commit cuts the stream: an event: error quoting no value", async () => {
    const res = await events.fetch("/ticks-cut");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    // The good event was written before the refusal.
    expect(text).toContain("event: tick");
    expect(text).toContain('data: {"n":1}');
    // The refusal reaches the client as Nest's `event: error`, value-free.
    expect(text).toContain("event: error");
    expect(text).not.toContain(SECRET);
  });

  it("R25: a synchronously emitted bad FIRST event fails before the commit: a 500 through the filters", async () => {
    const res = await events.fetch("/ticks-bad-first");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    const { error, issues } = refusal(await res.json());
    expect(error).toBe("Response validation failed");
    expect(issues[0].target).toBe("body");
    expect(issues[0].key).toBe("200");
    expect(JSON.stringify({ error, issues })).not.toContain(SECRET);
  });

  it("R25b: a synchronous burst is checked in order: the bad event never reaches the client", async () => {
    const res = await events.fetch("/ticks-burst");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('data: {"n":1}');
    expect(text).not.toContain(SECRET);
    expect(text).toContain("event: error");
    // The good event precedes the refusal.
    expect(text.indexOf('data: {"n":1}')).toBeLessThan(
      text.indexOf("event: error"),
    );
  });
});

/* ---- variants() ------------------------------------------------------------- */

describe("@Validate responses: variants() (R26–R29)", () => {
  it("R26: a non-admin request answered with the user body passes", async () => {
    expect(await get(filtered, "/view-user")).toEqual({
      status: 200,
      body: { id: 1, role: "user" },
    });
  });

  it("R27: an admin request answered with the admin body passes, with the variant's header", async () => {
    const res = await filtered.fetch("/view-admin", {
      headers: { "x-admin": "1" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-admin")).toBe("1");
    expect(await res.json()).toEqual({ id: 1, role: "admin" });
  });

  it("R28: an admin body sent to a non-admin is refused, the excluded variant named", async () => {
    const { status, body } = await get(filtered, "/view-leak");
    expect(status).toBe(500);
    const { error, issues } = refusal(body);
    expect(error).toBe("Response validation failed");
    expect(issues.some((issue) => issue.variant === "admin")).toBe(true);
    expect(
      issues.some((issue) =>
        issue.message.includes('matches variant "admin", which does not apply'),
      ),
    ).toBe(true);
  });

  it("R29: reply(…, { variant }) adjusts: the literal is filled, undeclared fields stripped, the header set", async () => {
    const res = await filtered.fetch("/view-reply", {
      headers: { "x-admin": "1" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-admin")).toBe("1");
    expect(await res.json()).toEqual({ id: 1, role: "admin" });
  });
});

/* ---- the modes -------------------------------------------------------------- */

describe("@Validate responses: the warn and off modes (R30–R31)", () => {
  it('R30: "warn" sends a mismatched response (200, the body as returned)', async () => {
    expect(await get(filtered, "/warned")).toEqual({
      status: 200,
      body: { id: SECRET, name: "ada" },
    });
  });

  it('R31: "off" (the default) checks nothing', async () => {
    expect(await get(filtered, "/unchecked")).toEqual({
      status: 200,
      body: { id: SECRET, name: "ada" },
    });
  });
});

/* ---- the parsed output (V13) ------------------------------------------------- */

describe('@Validate responses: responseOutput "parsed" (V13, R35–R37)', () => {
  it("R35: a returned body passes as the schema's output: the key stripped, the default applied", async () => {
    expect(await get(parsed, "/parsed-return")).toEqual({
      status: 200,
      body: { id: 1, role: "user" },
    });
  });

  it("R36: a reply()'s body the same", async () => {
    expect(await post(parsed, "/parsed-reply", {})).toEqual({
      status: 201,
      body: { id: 2, role: "user" },
    });
  });

  it("R37: a plain @Res() response is checked as sent, never parsed (the hook cannot replace)", async () => {
    expect(await get(parsed, "/parsed-res")).toEqual({
      status: 200,
      body: { id: 1, password: SECRET },
    });
  });
});

/* ---- the global ResponseValidationInterceptor ------------------------------- */

describe("ResponseValidationInterceptor, global (R32–R33)", () => {
  it('R32: a route declaring responses under the default "off" is still refused by the global "error"', async () => {
    const { status, body } = await get(watched, "/watched");
    expect(status).toBe(500);
    const { error, issues } = refusal(body);
    expect(error).toBe("Response validation failed");
    expect(issues[0].target).toBe("body");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("R33: a route with no responses passes through", async () => {
    expect(await get(watched, "/unwatched")).toEqual({
      status: 200,
      body: { id: SECRET, name: "ada" },
    });
  });
});

/* ---- the serializer's placement (Nest 12 only) -------------------------------- */

describe("the serializer's placement (R34, Nest 12)", () => {
  it.skipIf(NestSchemaPipe === undefined)(
    "R34: a method-level @Validate inside a global serializer checks the handler's raw return; the serializer then serializes",
    async () => {
      // The declared 200 matches only the RAW return (`ada`): had the check
      // seen the serialized output (`ADA`) it would refuse. The client still
      // receives the serialized output: the global serializer is outside, so
      // it runs after the method-level interceptor in the response phase.
      expect(await get(serialized!, "/serialized")).toEqual({
        status: 200,
        body: { name: "ADA" },
      });
    },
  );
});
