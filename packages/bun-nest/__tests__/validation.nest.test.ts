/**
 * bun-validate V6 (plan `docs/plans/bun-validate/` §4.5.3, §4.5.5): the
 * pipes, `SchemaDto` and the filter, through Nest's real pipeline on
 * bun-nest's adapter and `fetch()`. The same file runs on Nest 12 (the lock)
 * and in the nest-matrix's Nest 11 column; nothing here reads a version.
 *
 * Each rule has its negative control: the same app without the global pipe
 * lets every bad value through (`results-nest.txt`'s NOPIPE run); without
 * the filter, the pipes answer Nest's own 400 and a `ValidationError` is
 * Nest's 500; the vendor's own message is shown to quote the planted value
 * the answer withholds; a yup pipe answers with a Promise where zod's does
 * not.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No
 * top-level `await`: it perturbs decorator metadata in other test files.
 */
import type {
  ArgumentMetadata,
  ExecutionContext,
  INestApplication,
  MiddlewareConsumer,
} from "@nestjs/common";
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import {
  ResponseValidationError,
  validate,
  ValidationError,
} from "@kingsleyweb/bun-common";
import {
  BadRequestException,
  Body,
  Controller,
  createParamDecorator,
  Get,
  Headers,
  Logger,
  Module,
  Param,
  Post,
  Query,
  UseFilters,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { firstValueFrom, isObservable } from "rxjs";
import * as yup from "yup";
import { z } from "zod";
import {
  BunHttpAdapter,
  SchemaDto,
  StandardSchemaPipe,
  StandardValidationException,
  StandardValidationModule,
  StandardValidationPipe,
  ValidationExceptionFilter,
} from "../lib";
import "reflect-metadata";

/* ---- schemas and DTOs --------------------------------------------- */

const CreateUser = z.object({
  name: z.string().min(1),
  age: z.coerce.number().int(),
});
class CreateUserDto extends SchemaDto(CreateUser) {}

const Page = z.object({ page: z.coerce.number().int().min(1) });
class PageDto extends SchemaDto(Page) {}

const ApiHeaders = z.object({ "x-api-version": z.enum(["1", "2"]) });
class ApiHeadersDto extends SchemaDto(ApiHeaders) {}

const YupUser = yup.object({
  name: yup.string().required(),
  age: yup.number().required(),
});
class YupUserDto extends SchemaDto(YupUser) {}

/** A schema whose vendor message quotes an unknown key it was sent. */
const Strict = z.object({ name: z.string() }).strict();

/** A plain class, as a class-validator DTO would be: passed through untouched. */
class PlainDto {
  /** Any field; nothing checks it. */
  name?: unknown;
}

/** A custom decorator handing on the request's headers. */
const ReqHeaders = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<{ headers: unknown }>().headers,
);

/** A custom decorator handing on the request's query, typed with a DTO. */
const QueryOf = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<{ query: unknown }>().query,
);

/* ---- the application ---------------------------------------------- */

@Controller()
class UsersController {
  @Post("users")
  create(@Body() body: CreateUserDto) {
    const age: number = body.age;
    return { name: body.name, age, typeofAge: typeof age };
  }

  @Get("users")
  list(@Query() query: PageDto) {
    return { page: query.page, typeofPage: typeof query.page };
  }

  @Post("mixed/:id")
  mixed(
    @Body() body: CreateUserDto,
    @Param("id") id: string,
    @Query("note") note: string,
  ) {
    return { age: body.age, id, note, typeofId: typeof id };
  }

  @Post("plain")
  plain(@Body() body: PlainDto) {
    return { body, isPlain: body instanceof PlainDto };
  }

  @Get("custom-dto")
  customDto(@QueryOf() query: PageDto) {
    return { page: query.page, typeofPage: typeof query.page };
  }

  @Get("headers-dto")
  headersDto(@Headers() headers: ApiHeadersDto) {
    return { version: headers["x-api-version"] };
  }

  @Post("yup-dto")
  yupDto(@Body() body: YupUserDto) {
    return { age: body.age, typeofAge: typeof body.age };
  }

  @Post("pipe/body")
  pipeBody(@Body(new StandardSchemaPipe(CreateUser)) body: unknown) {
    return body;
  }

  @Get("pipe/query")
  pipeQuery(@Query(new StandardSchemaPipe(Page)) query: unknown) {
    return query;
  }

  @Get("pipe/query-key")
  pipeQueryKey(
    @Query("page", new StandardSchemaPipe(z.coerce.number().int().min(1)))
    page: number,
  ) {
    return { page, typeofPage: typeof page };
  }

  @Get("pipe/param/:id")
  pipeParam(
    @Param("id", new StandardSchemaPipe(z.coerce.number().int())) id: number,
  ) {
    return { id, typeofId: typeof id };
  }

  @Get("pipe/headers")
  pipeHeaders(
    @ReqHeaders(new StandardSchemaPipe(ApiHeaders)) headers: unknown,
  ) {
    return headers;
  }

  @Post("pipe/yup")
  pipeYup(@Body(new StandardSchemaPipe(YupUser)) body: unknown) {
    return body;
  }

  @Post("pipe/strict")
  pipeStrict(@Body(new StandardSchemaPipe(Strict)) body: unknown) {
    return body;
  }

  @Get("mw")
  middlewareValidated(@Query() query: unknown) {
    return { query };
  }

  @Get("response-error")
  responseError() {
    throw new ResponseValidationError(
      [
        {
          target: "body",
          message: "Invalid input: expected number",
          path: "id",
          key: "200",
        },
      ],
      200,
    );
  }

  @Get("gated-response")
  gatedResponse() {
    return { id: "not-a-number" };
  }

  @Get("other-400")
  other400() {
    throw new BadRequestException("not a validation error");
  }
}

/** The same routes, with the filter applied by class (Nest injects the adapter host). */
@Controller("scoped")
@UseFilters(ValidationExceptionFilter)
class ScopedController {
  @Post("users")
  create(@Body(new StandardSchemaPipe(CreateUser)) body: unknown) {
    return body;
  }
}

/** Applies `validate()` to `/mw` as Nest middleware, `next(err)` on failure. */
function configure(consumer: MiddlewareConsumer) {
  consumer.apply(validate({ query: Page })).forRoutes("mw");
  consumer
    .apply(
      validate(
        {},
        {
          responses: { 200: z.object({ id: z.number() }) },
          responseValidation: "error",
        },
      ),
    )
    .forRoutes("gated-response");
}

@Module({ controllers: [UsersController, ScopedController] })
class BareModule {
  configure(consumer: MiddlewareConsumer) {
    configure(consumer);
  }
}

@Module({
  imports: [StandardValidationModule],
  controllers: [UsersController, ScopedController],
})
class ValidatedModule {
  configure(consumer: MiddlewareConsumer) {
    configure(consumer);
  }
}

@Module({
  imports: [
    StandardValidationModule.forRoot({
      messages: "generic",
      redactPaths: true,
    }),
  ],
  controllers: [UsersController],
})
class GenericModule {}

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

/** The modules' apps, by what is registered. */
let validated: BunHttpAdapter; // StandardValidationModule: pipe + filter
let pipeOnly: BunHttpAdapter; // useGlobalPipes, no filter
let noPipe: BunHttpAdapter; // nothing global (the control)
let bareFilter: BunHttpAdapter; // useGlobalFilters(new ValidationExceptionFilter())
let generic: BunHttpAdapter; // forRoot({ messages: "generic", redactPaths: true })

beforeAll(async () => {
  validated = await boot(ValidatedModule);
  pipeOnly = await boot(BareModule, (app) =>
    app.useGlobalPipes(new StandardValidationPipe()),
  );
  noPipe = await boot(BareModule);
  bareFilter = await boot(BareModule, (app) => {
    app.useGlobalPipes(new StandardValidationPipe());
    app.useGlobalFilters(new ValidationExceptionFilter());
  });
  generic = await boot(GenericModule);
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

const post = (adapter: BunHttpAdapter, path: string, body: unknown) =>
  adapter
    .fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
    .then(answer);

const get = (adapter: BunHttpAdapter, path: string, init?: RequestInit) =>
  adapter.fetch(path, init).then(answer);

/* ---- SchemaDto + StandardValidationPipe ---------------------------- */

describe("SchemaDto with the global StandardValidationPipe", () => {
  it("N1: a valid body reaches the handler as the schema's output", async () => {
    expect(await post(validated, "/users", { name: "Ada", age: "41" })).toEqual(
      {
        status: 201,
        body: { name: "Ada", age: 41, typeofAge: "number" },
      },
    );
  });

  it("N2: an invalid body is refused with { error, issues } under the filter", async () => {
    expect(await post(validated, "/users", { name: "", age: "x" })).toEqual({
      status: 400,
      body: {
        error: "Validation failed",
        issues: [
          {
            target: "body",
            message: "Too small: expected string to have >=1 characters",
            path: "name",
          },
          {
            target: "body",
            message: "Invalid input: expected number, received NaN",
            path: "age",
          },
        ],
      },
    });
  });

  it("N3/N4: a query DTO is coerced, and refused when invalid", async () => {
    expect(await get(validated, "/users?page=2")).toEqual({
      status: 200,
      body: { page: 2, typeofPage: "number" },
    });
    expect(await get(validated, "/users?page=0")).toEqual({
      status: 400,
      body: {
        error: "Validation failed",
        issues: [
          {
            target: "query",
            message: "Too small: expected number to be >=1",
            path: "page",
          },
        ],
      },
    });
  });

  it("control: without the global pipe every value passes unchecked (results-nest.txt NOPIPE)", async () => {
    expect(await post(noPipe, "/users", { name: "Ada", age: "41" })).toEqual({
      status: 201,
      body: { name: "Ada", age: "41", typeofAge: "string" },
    });
    expect(await post(noPipe, "/users", { name: "", age: "x" })).toEqual({
      status: 201,
      body: { name: "", age: "x", typeofAge: "string" },
    });
    expect(await get(noPipe, "/users?page=0")).toEqual({
      status: 200,
      body: { page: "0", typeofPage: "string" },
    });
  });

  it("passes the parameters that are not SchemaDto-typed through untouched", async () => {
    expect(
      await post(validated, "/mixed/7?note=hi", { name: "Ada", age: "3" }),
    ).toEqual({
      status: 201,
      body: { age: 3, id: "7", note: "hi", typeofId: "string" },
    });
  });

  it("passes a plain class DTO through untouched (a class-validator DTO stays ValidationPipe's)", async () => {
    expect(await post(validated, "/plain", { name: 1, extra: true })).toEqual({
      status: 201,
      body: { body: { name: 1, extra: true }, isPlain: false },
    });
  });

  it("skips a custom decorator's parameter, as Nest's ValidationPipe does", async () => {
    expect(await get(validated, "/custom-dto?page=0")).toEqual({
      status: 200,
      body: { page: "0", typeofPage: "string" },
    });
  });

  it("never sees @Headers(): Nest runs no pipe on it (both majors)", async () => {
    expect(
      await get(validated, "/headers-dto", {
        headers: { "x-api-version": "9" },
      }),
    ).toEqual({ status: 200, body: { version: "9" } });
  });

  it("awaits an async vendor (yup)", async () => {
    expect(await post(validated, "/yup-dto", { name: "a", age: "5" })).toEqual({
      status: 201,
      body: { age: 5, typeofAge: "number" },
    });
    const refused = await post(validated, "/yup-dto", { name: "a" });
    expect(refused).toEqual({
      status: 400,
      body: {
        error: "Validation failed",
        issues: [
          { target: "body", message: "age is a required field", path: "age" },
        ],
      },
    });
  });

  it("without the filter, answers Nest's own 400 body", async () => {
    expect(await post(pipeOnly, "/users", { name: "", age: "x" })).toEqual({
      status: 400,
      body: {
        statusCode: 400,
        message: [
          "name: Too small: expected string to have >=1 characters",
          "age: Invalid input: expected number, received NaN",
        ],
        error: "Bad Request",
      },
    });
  });
});

/* ---- prototype-pollution keys ------------------------------------- */

describe("a body with an own __proto__ key (yup): stripped first, as Nest 12's pipes do", () => {
  const PROTO_BODY = '{"name":"n","age":"6","__proto__":{"polluted":"yes"}}';

  it("control: yup alone crashes on it (what answered 500 before the strip)", async () => {
    let failure: unknown;
    try {
      await YupUser["~standard"].validate(JSON.parse(PROTO_BODY));
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("resolve is not a function");
  });

  it("StandardSchemaPipe answers 201 with the schema's output", async () => {
    expect(await post(validated, "/pipe/yup", PROTO_BODY)).toEqual({
      status: 201,
      body: { name: "n", age: 6 },
    });
  });

  it("a SchemaDto under StandardValidationPipe answers 201 with the schema's output", async () => {
    expect(await post(validated, "/yup-dto", PROTO_BODY)).toEqual({
      status: 201,
      body: { age: 6, typeofAge: "number" },
    });
  });
});

/* ---- the stripProtoKeys option ------------------------------------ */

const Loose = z.looseObject({ name: z.string() });
class LooseDto extends SchemaDto(Loose) {}

@Controller("proto")
class ProtoController {
  @Post("dto")
  dto(@Body() body: LooseDto) {
    return Object.keys(body);
  }

  @Post("pipe")
  pipe(
    @Body(new StandardSchemaPipe(Loose, { stripProtoKeys: "minimal" }))
    body: object,
  ) {
    return Object.keys(body);
  }
}

@Module({
  imports: [StandardValidationModule.forRoot({ stripProtoKeys: "minimal" })],
  controllers: [ProtoController],
})
class MinimalProtoModule {}

@Module({
  imports: [StandardValidationModule],
  controllers: [ProtoController],
})
class DefaultProtoModule {}

describe('the stripProtoKeys option: "nest" (default) or "minimal"', () => {
  const BODY = '{"name":"a","prototype":1,"__proto__":{"polluted":"yes"}}';
  let minimal: BunHttpAdapter;
  let byDefault: BunHttpAdapter;
  beforeAll(async () => {
    minimal = await boot(MinimalProtoModule);
    byDefault = await boot(DefaultProtoModule);
  });

  it('forRoot({ stripProtoKeys: "minimal" }) reaches the global pipe: a prototype field is kept', async () => {
    expect(await post(minimal, "/proto/dto", BODY)).toEqual({
      status: 201,
      body: ["name", "prototype"],
    });
  });

  it('negative control: the default ("nest") deletes it', async () => {
    expect(await post(byDefault, "/proto/dto", BODY)).toEqual({
      status: 201,
      body: ["name"],
    });
  });

  it("StandardSchemaPipe keeps its own option, whatever the module's", async () => {
    for (const app of [minimal, byDefault]) {
      expect(await post(app, "/proto/pipe", BODY)).toEqual({
        status: 201,
        body: ["name", "prototype"],
      });
    }
  });

  it('both pipes, called directly: "minimal" keeps prototype, the default deletes it', () => {
    const body = { type: "body", metatype: LooseDto } as const;
    const fresh = () => JSON.parse(BODY) as object;
    expect(
      Object.keys(
        new StandardValidationPipe({ stripProtoKeys: "minimal" }).transform(
          fresh(),
          body,
        ) as object,
      ),
    ).toEqual(["name", "prototype"]);
    expect(
      Object.keys(
        new StandardValidationPipe().transform(fresh(), body) as object,
      ),
    ).toEqual(["name"]);
    expect(
      Object.keys(
        new StandardSchemaPipe(Loose, { stripProtoKeys: "minimal" }).transform(
          fresh(),
          body,
        ) as object,
      ),
    ).toEqual(["name", "prototype"]);
    expect(
      Object.keys(
        new StandardSchemaPipe(Loose).transform(fresh(), body) as object,
      ),
    ).toEqual(["name"]);
  });

  it("refuses any other value with a TypeError when built", () => {
    const bad = { stripProtoKeys: "Nest" } as never;
    expect(() => new StandardSchemaPipe(Loose, bad)).toThrow(
      'StandardSchemaPipe: stripProtoKeys must be "nest" or "minimal" (or unset)',
    );
    expect(() => new StandardValidationPipe(bad)).toThrow(TypeError);
    expect(() => StandardValidationModule.forRoot(bad)).toThrow(TypeError);
  });
});

/* ---- StandardSchemaPipe -------------------------------------------- */

describe("StandardSchemaPipe on each part", () => {
  it("@Body: hands on the output, refuses with the body's issues", async () => {
    expect(
      await post(validated, "/pipe/body", { name: "a", age: "2" }),
    ).toEqual({ status: 201, body: { name: "a", age: 2 } });
    expect(await post(validated, "/pipe/body", { name: "a" })).toEqual({
      status: 400,
      body: {
        error: "Validation failed",
        issues: [
          {
            target: "body",
            message: "Invalid input: expected number, received NaN",
            path: "age",
          },
        ],
      },
    });
  });

  it("@Query(): the whole query", async () => {
    expect(await get(validated, "/pipe/query?page=3")).toEqual({
      status: 200,
      body: { page: 3 },
    });
    expect((await get(validated, "/pipe/query?page=x")).status).toBe(400);
  });

  it("@Query('page'): one key, its name prefixed to the path", async () => {
    expect(await get(validated, "/pipe/query-key?page=4")).toEqual({
      status: 200,
      body: { page: 4, typeofPage: "number" },
    });
    expect(await get(validated, "/pipe/query-key?page=0")).toEqual({
      status: 400,
      body: {
        error: "Validation failed",
        issues: [
          {
            target: "query",
            message: "Too small: expected number to be >=1",
            path: "page",
          },
        ],
      },
    });
  });

  it("@Param('id'): target params", async () => {
    expect(await get(validated, "/pipe/param/12")).toEqual({
      status: 200,
      body: { id: 12, typeofId: "number" },
    });
    expect(await get(validated, "/pipe/param/x")).toEqual({
      status: 400,
      body: {
        error: "Validation failed",
        issues: [
          {
            target: "params",
            message: "Invalid input: expected number, received NaN",
            path: "id",
          },
        ],
      },
    });
  });

  it("headers, through a custom decorator (target custom)", async () => {
    const ok = await get(validated, "/pipe/headers", {
      headers: { "x-api-version": "2" },
    });
    expect(ok).toEqual({ status: 200, body: { "x-api-version": "2" } });
    const bad = await get(validated, "/pipe/headers", {
      headers: { "x-api-version": "3" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({
      error: "Validation failed",
      issues: [
        {
          target: "custom",
          message: 'Invalid option: expected one of "1"|"2"',
          path: "x-api-version",
        },
      ],
    });
  });

  it("an async vendor (yup)", async () => {
    expect(await post(validated, "/pipe/yup", { name: "n", age: "6" })).toEqual(
      { status: 201, body: { name: "n", age: 6 } },
    );
    expect((await post(validated, "/pipe/yup", { age: 1 })).status).toBe(400);
  });

  it("the filter applied by class gets the adapter host injected", async () => {
    expect(await post(pipeOnly, "/scoped/users", { name: "" })).toEqual({
      status: 400,
      body: {
        error: "Validation failed",
        issues: [
          {
            target: "body",
            message: "Too small: expected string to have >=1 characters",
            path: "name",
          },
          {
            target: "body",
            message: "Invalid input: expected number, received NaN",
            path: "age",
          },
        ],
      },
    });
  });
});

/* ---- the filter ---------------------------------------------------- */

describe("ValidationExceptionFilter", () => {
  it("answers a validate() middleware's ValidationError with its status", async () => {
    expect(await get(validated, "/mw?page=1")).toEqual({
      status: 200,
      body: { query: { page: 1 } },
    });
    expect(await get(validated, "/mw?page=0")).toEqual({
      status: 400,
      body: {
        error: "Validation failed",
        issues: [
          {
            target: "query",
            message: "Too small: expected number to be >=1",
            path: "page",
          },
        ],
      },
    });
  });

  it("control: without it, a ValidationError is Nest's 500", async () => {
    expect(await get(pipeOnly, "/mw?page=0")).toEqual({
      status: 500,
      body: { statusCode: 500, message: "Internal server error" },
    });
  });

  it("answers a ResponseValidationError with 500 and its issues", async () => {
    expect(await get(validated, "/response-error")).toEqual({
      status: 500,
      body: {
        error: "Response validation failed",
        issues: [
          {
            target: "body",
            message: "Invalid input: expected number",
            path: "id",
            key: "200",
          },
        ],
      },
    });
  });

  it("answers a refused response from validate()'s response gate, and logs it once", async () => {
    expect(await get(validated, "/gated-response")).toEqual({
      status: 500,
      body: {
        error: "Response validation failed",
        issues: [
          {
            target: "body",
            message: "Invalid input: expected number, received string",
            path: "id",
            key: "200",
            mediaType: "application/json",
          },
        ],
      },
    });
    const errors: string[] = [];
    const quiet = () => undefined;
    const adapter = new BunHttpAdapter(0);
    const app = await NestFactory.create(ValidatedModule, adapter, {
      logger: {
        log: quiet,
        warn: quiet,
        debug: quiet,
        verbose: quiet,
        error: (message: unknown, ...rest: unknown[]) => {
          errors.push([message, ...rest].map(String).join(" "));
        },
      },
    });
    await app.init();
    try {
      expect((await get(adapter, "/gated-response")).status).toBe(500);
      expect((await get(adapter, "/users?page=0")).status).toBe(400);
    } finally {
      await app.close();
    }
    const logged = errors.filter((line) =>
      line.includes("Response validation failed"),
    );
    expect(logged).toHaveLength(1);
    expect(errors).toHaveLength(1); // the 400 is not logged
    expect(logged[0]).not.toContain("not-a-number");
  });

  it("control: without it, a refused response is Nest's 500", async () => {
    expect(await get(pipeOnly, "/gated-response")).toEqual({
      status: 500,
      body: { statusCode: 500, message: "Internal server error" },
    });
  });

  it("leaves every other error to Nest: another 400, invalid JSON", async () => {
    expect(await get(validated, "/other-400")).toEqual({
      status: 400,
      body: {
        message: "not a validation error",
        error: "Bad Request",
        statusCode: 400,
      },
    });
    expect(await post(validated, "/users", '{"name":')).toMatchObject({
      status: 400,
      body: { error: "Bad Request", statusCode: 400 },
    });
  });

  it("works built with no adapter (an Express-style response)", async () => {
    expect(await post(bareFilter, "/users", { name: "a", age: "x" })).toEqual({
      status: 400,
      body: {
        error: "Validation failed",
        issues: [
          {
            target: "body",
            message: "Invalid input: expected number, received NaN",
            path: "age",
          },
        ],
      },
    });
    expect((await get(bareFilter, "/response-error")).status).toBe(500);
  });

  it("answers through the adapter it is given, and ends a started response", () => {
    const calls: unknown[][] = [];
    let started = false;
    const adapter = {
      reply: (...args: unknown[]) => calls.push(["reply", ...args]),
      isHeadersSent: () => started,
      end: (...args: unknown[]) => calls.push(["end", ...args]),
    };
    const res = { marker: "res" };
    const host = {
      getType: () => "http",
      switchToHttp: () => ({ getResponse: () => res }),
    } as unknown as Parameters<ValidationExceptionFilter["catch"]>[1];
    const error = new ValidationError(
      [{ target: "query", message: "m", path: "p" }],
      422,
    );
    for (const given of [adapter, { httpAdapter: adapter }]) {
      calls.length = 0;
      started = false;
      new ValidationExceptionFilter(given).catch(error, host);
      started = true;
      new ValidationExceptionFilter(given).catch(error, host);
      expect(calls).toEqual([
        [
          "reply",
          res,
          {
            error: "Validation failed",
            issues: [{ target: "query", message: "m", path: "p" }],
          },
          422,
        ],
        ["end", res],
      ]);
    }
  });

  it("is selected for the three error classes only", () => {
    const caught = Reflect.getMetadata(
      "__filterCatchExceptions__",
      ValidationExceptionFilter,
    ) as unknown[];
    expect(caught).toHaveLength(3);
    expect(caught).toContain(ValidationError);
    expect(caught).toContain(ResponseValidationError);
    expect(caught).toContain(StandardValidationException);
    expect(caught).not.toContain(BadRequestException);
  });

  it("in rpc, returns an Observable that errors, as Nest's BaseRpcExceptionFilter does (TCP: validationRpc.nest.test.ts)", async () => {
    const filter = new ValidationExceptionFilter();
    const host = { getType: () => "rpc" } as unknown as Parameters<
      ValidationExceptionFilter["catch"]
    >[1];
    /** What the Observable `filter.catch` returns errors with. */
    const errorOf = async (error: Error): Promise<unknown> => {
      const answer = filter.catch(error, host);
      expect(isObservable(answer)).toBe(true);
      return firstValueFrom(answer!).then(
        () => "no error",
        (reason: unknown) => reason,
      );
    };
    expect(
      await errorOf(
        new ValidationError([{ target: "body", message: "m", path: "" }], 400),
      ),
    ).toEqual({
      status: "error",
      statusCode: 400,
      code: "VALIDATION",
      message: "Validation failed",
      issues: [{ target: "body", message: "m", path: "" }],
    });
    // A server fault: Nest's own answer (logged by Nest's filter).
    const logged = spyOn(Logger.prototype, "error").mockImplementation(
      () => {},
    );
    try {
      expect(
        await errorOf(
          new ResponseValidationError(
            [{ target: "body", message: "m", path: "id", key: "200" }],
            200,
          ),
        ),
      ).toEqual({ status: "error", message: "Internal server error" });
    } finally {
      logged.mockRestore();
    }
  });

  it("rethrows outside HTTP, WebSocket and rpc contexts (a job fails with the error)", () => {
    const filter = new ValidationExceptionFilter();
    const error = new ValidationError(
      [{ target: "body", message: "m", path: "" }],
      400,
    );
    const host = { getType: () => "bun-jobs" } as unknown as Parameters<
      ValidationExceptionFilter["catch"]
    >[1];
    expect(() => filter.catch(error, host)).toThrow(error);
  });
});

/* ---- privacy, wording and options --------------------------------- */

describe("no received value in issues, and the wording options", () => {
  const PLANTED = "PLANTED_9c1f";

  it("withholds a vendor message quoting a planted key (zod strict)", async () => {
    // The control: the vendor's own message quotes it.
    const raw = (await Strict["~standard"].validate({
      name: "a",
      [PLANTED]: 1,
    })) as StandardSchemaV1.FailureResult;
    expect(raw.issues.some((i) => i.message.includes(PLANTED))).toBe(true);

    const refused = await validated.fetch("/pipe/strict", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a", [PLANTED]: 1 }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain(PLANTED);
  });

  it("withholds a vendor message quoting a planted value (yup)", async () => {
    const raw = (await YupUser["~standard"].validate({
      name: "a",
      age: PLANTED,
    })) as StandardSchemaV1.FailureResult;
    expect(raw.issues.some((i) => i.message.includes(PLANTED))).toBe(true);

    for (const adapter of [validated, pipeOnly]) {
      const refused = await adapter.fetch("/pipe/yup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "a", age: PLANTED }),
      });
      expect(refused.status).toBe(400);
      expect(await refused.text()).not.toContain(PLANTED);
    }
  });

  it("messages: 'generic' and redactPaths through forRoot()", async () => {
    expect(await post(generic, "/users", { name: "", age: "1" })).toEqual({
      status: 400,
      body: {
        error: "Validation failed",
        issues: [
          { target: "body", message: "Invalid value (too_small)", path: "" },
        ],
      },
    });
  });

  it("the same options on StandardSchemaPipe, and no key prefix under redactPaths", () => {
    const pipe = new StandardSchemaPipe(z.coerce.number().min(1), {
      messages: "generic",
      redactPaths: true,
    });
    const metadata: ArgumentMetadata = { type: "query", data: "page" };
    let caught: unknown;
    try {
      void pipe.transform("0", metadata);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as { issues: unknown }).issues).toEqual([
      { target: "query", message: "Invalid value (too_small)", path: "" },
    ]);
  });

  it("throws the exported StandardValidationException, a BadRequestException carrying the issues", () => {
    let caught: unknown;
    try {
      void new StandardSchemaPipe(Page).transform(
        { page: "0" },
        { type: "query" },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StandardValidationException);
    expect(caught).toBeInstanceOf(BadRequestException);
    const exception = caught as StandardValidationException;
    expect(exception.getStatus()).toBe(400);
    expect(exception.issues).toEqual([
      {
        target: "query",
        message: "Too small: expected number to be >=1",
        path: "page",
      },
    ]);
    expect(exception.getResponse()).toEqual({
      statusCode: 400,
      message: ["page: Too small: expected number to be >=1"],
      error: "Bad Request",
    });
    expect(exception.message).toBe(
      "Validation failed — query.page: Too small: expected number to be >=1",
    );
  });

  it("refuses a wrong option value at construction, as validate() does", () => {
    const wrong = { messages: "Generic" } as unknown as { messages: "generic" };
    expect(() => new StandardSchemaPipe(Page, wrong)).toThrow(TypeError);
    expect(() => new StandardValidationPipe(wrong)).toThrow(TypeError);
    expect(() => StandardValidationModule.forRoot(wrong)).toThrow(TypeError);
    const notBoolean = { redactPaths: "yes" } as unknown as {
      redactPaths: boolean;
    };
    expect(() => new StandardValidationPipe(notBoolean)).toThrow(TypeError);
  });

  it("refuses something that is not a Standard Schema", () => {
    const notASchema = { parse: () => 1 } as unknown as StandardSchemaV1;
    expect(() => new StandardSchemaPipe(notASchema)).toThrow(TypeError);
    expect(() =>
      SchemaDto(notASchema as unknown as StandardSchemaV1<unknown, object>),
    ).toThrow(TypeError);
  });
});

/* ---- sync when the vendor is sync --------------------------------- */

describe("sync when the vendor is sync", () => {
  const body: ArgumentMetadata = { type: "body" };

  it("StandardSchemaPipe answers zod synchronously, yup with a Promise", async () => {
    const zodOut = new StandardSchemaPipe(CreateUser).transform(
      { name: "a", age: "1" },
      body,
    );
    expect(zodOut).not.toBeInstanceOf(Promise);
    expect(zodOut).toEqual({ name: "a", age: 1 });

    // The control: an async vendor's answer is visibly a Promise.
    const yupOut = new StandardSchemaPipe(YupUser).transform(
      { name: "a", age: "1" },
      body,
    );
    expect(yupOut).toBeInstanceOf(Promise);
    expect(await yupOut).toEqual({ name: "a", age: 1 });
  });

  it("a zod failure throws synchronously; a yup failure rejects", async () => {
    expect(() =>
      new StandardSchemaPipe(CreateUser).transform({ name: "a" }, body),
    ).toThrow(BadRequestException);
    const rejected = new StandardSchemaPipe(YupUser).transform({}, body);
    expect(rejected).toBeInstanceOf(Promise);
    await expect(rejected).rejects.toBeInstanceOf(BadRequestException);
  });

  it("StandardValidationPipe passes the rest through synchronously", () => {
    const pipe = new StandardValidationPipe();
    const value = { a: 1 };
    expect(pipe.transform(value, { type: "body", metatype: PlainDto })).toBe(
      value,
    );
    expect(pipe.transform(value, { type: "body" })).toBe(value);
    expect(
      pipe.transform({ page: "2" }, { type: "query", metatype: PageDto }),
    ).toEqual({ page: 2 });
  });

  it("a direct call with no metadata names the part 'custom'", () => {
    try {
      void new StandardSchemaPipe(Page).transform({ page: "x" });
      throw new Error("not refused");
    } catch (error) {
      expect((error as { issues: { target: string }[] }).issues[0].target).toBe(
        "custom",
      );
    }
  });
});

/* ---- SchemaDto ----------------------------------------------------- */

describe("SchemaDto", () => {
  it("carries its schema, inherited by subclasses", () => {
    expect(CreateUserDto.schema).toBe(CreateUser);
    class Sub extends CreateUserDto {}
    expect(Sub.schema).toBe(CreateUser);
    expect(
      new StandardValidationPipe().transform(
        { name: "x", age: "9" },
        { type: "body", metatype: Sub },
      ),
    ).toEqual({ name: "x", age: 9 });
  });

  it("only a SchemaDto class is validated, not any class with a static schema", () => {
    class HasSchema {
      /** A Standard Schema, but the class is not a SchemaDto. */
      static readonly schema = Page;
    }
    const value = { page: "0" };
    expect(
      new StandardValidationPipe().transform(value, {
        type: "query",
        metatype: HasSchema,
      }),
    ).toBe(value);
  });

  it("a DTO whose schema was overridden with a non-schema is a declaration error", () => {
    class Broken extends SchemaDto(Page) {
      static override readonly schema = {} as unknown as typeof Page;
    }
    expect(() =>
      new StandardValidationPipe().transform(
        {},
        { type: "body", metatype: Broken },
      ),
    ).toThrow(TypeError);
  });
});
