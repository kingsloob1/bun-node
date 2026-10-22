/**
 * bun-validate V7a (plan `docs/plans/bun-validate/` §4.5.1–§4.5.2):
 * `@Validate`, the request side, and `@Validated(part)` with its aliases,
 * through Nest's real pipeline on bun-nest's adapter and `fetch()`. The same
 * file runs on Nest 12 (the lock) and in the nest-matrix's Nest 11 column;
 * the skip rule's tests read the capability (whether the installed
 * `@nestjs/common` has `StandardSchemaValidationPipe`), never a version.
 *
 * Each rule has its negative control: without the pipe applying, the
 * schema-carrying entry's part is checked here (the gate test, both majors);
 * a keyed decorator's part is checked; a part with no decorator schema is
 * checked even with the pipe global; the vendor's own message is shown to
 * quote the planted key the answer withholds; a bad value reaches the
 * handler on a route with no `@Validate`.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No
 * top-level `await`: it perturbs decorator metadata in other test files.
 */
import type {
  INestApplication,
  MiddlewareConsumer,
  PipeTransform,
} from "@nestjs/common";
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import { requestParsing, signCookie } from "@kingsleyweb/bun-common";
import {
  Body,
  Controller,
  Get,
  Headers,
  Module,
  Param,
  Post,
  Query,
  UsePipes,
} from "@nestjs/common";
import * as nestCommon from "@nestjs/common";
import { APP_PIPE, NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  BunHttpAdapter,
  Validate,
  Validated,
  ValidBody,
  ValidCookies,
  ValidHeaders,
  ValidParams,
  ValidQuery,
  ValidSignedCookies,
  ValidationExceptionFilter,
} from "../lib";
import "reflect-metadata";

/* ---- schemas -------------------------------------------------------- */

const Page = z.object({ page: z.coerce.number().int().min(1) });
const CreateUser = z.object({
  name: z.string().min(1),
  age: z.coerce.number().int(),
});
const IdParams = z.object({ id: z.coerce.number().int() });
const ApiHeaders = z.object({ "x-n": z.coerce.number().int() });
const Session = z.object({ sid: z.string().min(1) });
const SignedUser = z.object({ uid: z.coerce.number().int().min(1) });
/** A schema whose vendor message quotes an unknown key it was sent. */
const Strict = z.object({ name: z.string() }).strict();
/** A key no test data should ever quote in an answer. */
const PLANTED = "secretKey-planted";
/** A value no message or log may quote. */
const SECRET = "hunter2-not-an-email";

/** The schema Nest's own pipe applies where the skip rule leaves a part to it. */
const NestBody = z.object({
  name: z.string().transform((name) => name.toUpperCase()),
});

/** A query schema answering with a Promise, as yup's does. */
const AsyncPage: StandardSchemaV1 = {
  "~standard": {
    version: 1,
    vendor: "test-async",
    validate: async (value) => {
      await Bun.sleep(1);
      const page = (value as { page?: unknown }).page;
      return typeof page === "string" && /^\d+$/.test(page) && Number(page) >= 1
        ? { value: { page: Number(page) } }
        : { issues: [{ message: "Expected a page number", path: ["page"] }] };
    },
  },
};

/** A schema counting how often it validates (the skip rule's probe). */
function counted(schema: StandardSchemaV1) {
  let calls = 0;
  const wrapped: StandardSchemaV1 = {
    "~standard": {
      version: 1,
      vendor: "test-counted",
      validate: (value) => {
        calls++;
        return schema["~standard"].validate(value);
      },
    },
  };
  return { schema: wrapped, calls: (): number => calls };
}

/* ---- the application, request side ---------------------------------- */

const COOKIE_SECRET = "cookie-secret-for-tests";
/** A signed `uid` cookie, as the request option's secret signs it. */
const signedUid = (value: string) =>
  encodeURIComponent(`s:${signCookie(value, COOKIE_SECRET)}`);

@Controller()
class PartsController {
  @Validate({
    params: IdParams,
    query: Page,
    headers: ApiHeaders,
    cookies: Session,
    signedCookies: SignedUser,
    body: CreateUser,
  })
  @Post("parts/:id")
  parts(
    @Param("id") id: unknown,
    @Query("page") page: unknown,
    @Headers("x-n") headerN: unknown,
    @Body() body: { name: string; age: unknown },
    @Validated("params") validParams: unknown,
    @Validated("headers") validHeaders: unknown,
    @Validated("cookies") validCookies: unknown,
    @Validated("signedCookies") validSigned: unknown,
  ) {
    return {
      id,
      typeOfId: typeof id,
      page,
      typeOfPage: typeof page,
      // The raw header stays a string: headers are never written back.
      headerN,
      typeOfHeaderN: typeof headerN,
      body,
      typeOfAge: typeof body.age,
      validParams,
      validHeaders,
      validCookies,
      validSigned,
    };
  }

  @Validate({ body: Strict })
  @Post("strict")
  strict(@Body() body: unknown) {
    return body;
  }

  @Validate({ query: AsyncPage })
  @Get("async")
  asyncQuery(@Validated("query") query: unknown) {
    return query;
  }

  // After nestjs-12-parity PR-5 a named wildcard is a `string[]`, so its
  // params schema takes an array.
  @Validate({ params: z.object({ path: z.array(z.string()).min(1) }) })
  @Get("files/*path")
  files(@Validated("params") params: unknown) {
    return params;
  }

  @Post("plain")
  plain(@Validated("body") body: unknown) {
    return { body: body ?? null };
  }
}

@Controller()
class AliasController {
  @Validate({
    params: IdParams,
    query: Page,
    headers: ApiHeaders,
    cookies: Session,
    signedCookies: SignedUser,
    body: CreateUser,
  })
  @Post("alias/:id")
  alias(
    @ValidBody() body: unknown,
    @ValidQuery() query: unknown,
    @ValidParams() params: unknown,
    @ValidHeaders() headers: unknown,
    @ValidCookies() cookies: unknown,
    @ValidSignedCookies() signed: unknown,
  ) {
    return { body, query, params, headers, cookies, signed };
  }
}

@Controller()
@Validate({ query: Page })
class MergeController {
  @Validate({ body: CreateUser })
  @Post("merge")
  merge(@Validated("query") query: unknown, @Validated("body") body: unknown) {
    return { query, body };
  }

  // The method's query schema replaces the class's, per part.
  @Validate({ query: z.object({ q: z.string() }) })
  @Post("merge-wins")
  wins(@Validated("query") query: unknown) {
    return query;
  }
}

/** The module every request-side test boots, with cookie parsing on. */
@Module({
  controllers: [PartsController, AliasController, MergeController],
})
class PartsModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(requestParsing({ parseCookies: { secret: COOKIE_SECRET } }))
      .forRoutes("*");
  }
}

/* ---- the capability gate, both majors -------------------------------- */

const gateCount = counted(z.object({ name: z.string() }));

@Controller()
class GateController {
  @Validate({ body: gateCount.schema })
  @Post("gate")
  gate(@Body() body: unknown) {
    return body;
  }
}

// A whole-part entry carrying a schema, exactly as Nest 12's
// `@Body({ schema })` writes it — defined directly, so the gate is probed on
// a Nest whose decorators cannot write it (11). With no pipe of Nest's to
// check the part, `@Validate` must check it on either major.
Reflect.defineMetadata(
  "__routeArguments__",
  { "3:0": { index: 0, data: undefined, pipes: [], schema: NestBody } },
  GateController,
  "gate",
);

@Module({ controllers: [GateController] })
class GateModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(requestParsing({ parseCookies: { secret: COOKIE_SECRET } }))
      .forRoutes("*");
  }
}

/* ---- the skip rule, where Nest has its own pipe (12) ----------------- */

/** Nest 12's `StandardSchemaValidationPipe`, when the installed `@nestjs/common` has it. */
const NestSchemaPipe = (nestCommon as unknown as Record<string, unknown>)
  .StandardSchemaValidationPipe as (new () => PipeTransform) | undefined;

/** `@Body({ schema, pipes })`, Nest 12's per-parameter schema and pipes. */
type BodyWith = (options: {
  schema: StandardSchemaV1;
  pipes?: unknown[];
}) => ParameterDecorator;

/** The counted schemas of the skip-rule routes, read by the tests. */
const skipCounts = {
  global: counted(z.object({ name: z.string() })),
  keyed: counted(z.object({ name: z.string() })),
  noSchema: counted(z.object({ name: z.string() })),
  methodPipe: counted(z.object({ name: z.string() })),
  paramPipe: counted(z.object({ name: z.string() })),
  classPipe: counted(z.object({ name: z.string() })),
  rawBody: counted(z.object({ name: z.string() })),
};

/**
 * The skip-rule modules, one controller per source of Nest's pipe. Built
 * only where the pipe exists: it is newed here, at decoration. Decorators
 * applied by call, so nothing runs at load.
 */
function skipModules(): Record<string, new () => object> {
  const Pipe = NestSchemaPipe!;
  const BodyWith = Body as unknown as BodyWith;

  class SkipController {
    skipGlobal(body: unknown) {
      return body;
    }
    skipKeyed(name: unknown) {
      return { name };
    }
    skipNoSchema(body: unknown) {
      return body;
    }
    skipMethodPipe(body: unknown) {
      return body;
    }
    skipParamPipe(body: unknown) {
      return body;
    }
  }
  const proto = SkipController.prototype;
  const routes = {
    "skip-global": skipCounts.global,
    "skip-keyed": skipCounts.keyed,
    "skip-no-schema": skipCounts.noSchema,
    "skip-method-pipe": skipCounts.methodPipe,
    "skip-param-pipe": skipCounts.paramPipe,
  } as const;
  for (const [path, countedSchema] of Object.entries(routes)) {
    const method = path.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const descriptor = Object.getOwnPropertyDescriptor(proto, method)!;
    Post(path)(proto, method, descriptor);
    Validate({ body: countedSchema.schema })(proto, method, descriptor);
  }
  // The parameter decorators: a whole-part `{ schema }` for skipGlobal, a
  // keyed one for skipKeyed, none for skipNoSchema, and the pipe itself at
  // the two pipe sources.
  const BodyWithSchema = Body as unknown as BodyWith;
  BodyWithSchema({ schema: NestBody })(proto, "skipGlobal", 0);
  (
    Body as unknown as (
      data: string,
      options: { schema: StandardSchemaV1 },
    ) => ParameterDecorator
  )("name", { schema: z.string() })(proto, "skipKeyed", 0);
  Body()(proto, "skipNoSchema", 0);
  UsePipes(new Pipe())(
    proto,
    "skipMethodPipe",
    Object.getOwnPropertyDescriptor(proto, "skipMethodPipe")!,
  );
  BodyWithSchema({ schema: NestBody })(proto, "skipMethodPipe", 0);
  BodyWithSchema({ schema: NestBody, pipes: [new Pipe()] })(
    proto,
    "skipParamPipe",
    0,
  );
  Controller()(SkipController);

  class SkipClassPipeController {
    skipClassPipe(body: unknown) {
      return body;
    }
  }
  const classProto = SkipClassPipeController.prototype;
  const classDescriptor = Object.getOwnPropertyDescriptor(
    classProto,
    "skipClassPipe",
  )!;
  Post("skip-class-pipe")(classProto, "skipClassPipe", classDescriptor);
  Validate({ body: skipCounts.classPipe.schema })(
    classProto,
    "skipClassPipe",
    classDescriptor,
  );
  BodyWith({ schema: NestBody })(classProto, "skipClassPipe", 0);
  Controller()(SkipClassPipeController);
  UsePipes(new Pipe())(SkipClassPipeController);

  class SkipRawBodyController {
    skipRawBody(body: unknown) {
      return body;
    }
  }
  const rawProto = SkipRawBodyController.prototype;
  const rawDescriptor = Object.getOwnPropertyDescriptor(
    rawProto,
    "skipRawBody",
  )!;
  Post("skip-raw-body")(rawProto, "skipRawBody", rawDescriptor);
  Validate({ body: skipCounts.rawBody.schema })(
    rawProto,
    "skipRawBody",
    rawDescriptor,
  );
  Body()(rawProto, "skipRawBody", 0);
  Controller()(SkipRawBodyController);
  // A RAW_BODY (12) entry carrying a schema, beside the real `@Body()` one:
  // a raw-body part, never `body`, so it must not make `@Validate` skip the
  // part even with the pipe global.
  Reflect.defineMetadata(
    "__routeArguments__",
    {
      ...(Reflect.getMetadata(
        "__routeArguments__",
        SkipRawBodyController,
        "skipRawBody",
      ) as Record<string, unknown>),
      "12:1": { index: 1, data: undefined, pipes: [], schema: NestBody },
    },
    SkipRawBodyController,
    "skipRawBody",
  );

  class SkipModule {}
  Module({
    controllers: [
      SkipController,
      SkipClassPipeController,
      SkipRawBodyController,
    ],
  })(SkipModule);

  class SkipAppPipeModule {}
  Module({
    controllers: [SkipController],
    providers: [{ provide: APP_PIPE, useClass: Pipe }],
  })(SkipAppPipeModule);

  return { SkipModule, SkipAppPipeModule };
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

let filtered: BunHttpAdapter; // PartsModule + ValidationExceptionFilter
let bare: BunHttpAdapter; // PartsModule, no filter (Nest's own 400)
let gate: BunHttpAdapter; // GateModule, no pipes (both majors)
let skipGlobal: BunHttpAdapter | undefined; // SkipModule + useGlobalPipes(SSVP)
let skipBare: BunHttpAdapter | undefined; // SkipModule, no pipes (the control)
let skipAppPipe: BunHttpAdapter | undefined; // SkipAppPipeModule

beforeAll(async () => {
  filtered = await boot(PartsModule, (app) => {
    app.useGlobalFilters(new ValidationExceptionFilter());
  });
  bare = await boot(PartsModule);
  gate = await boot(GateModule);
  if (NestSchemaPipe !== undefined) {
    const { SkipModule, SkipAppPipeModule } = skipModules();
    const Pipe = NestSchemaPipe;
    skipGlobal = await boot(SkipModule, (app) => {
      app.useGlobalPipes(new Pipe());
    });
    skipBare = await boot(SkipModule);
    skipAppPipe = await boot(SkipAppPipeModule);
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

const post = (
  adapter: BunHttpAdapter,
  path: string,
  body: unknown,
  init?: RequestInit,
) =>
  adapter
    .fetch(path, {
      ...init,
      method: "POST",
      headers: { "content-type": "application/json", ...init?.headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
    .then(answer);

const get = (adapter: BunHttpAdapter, path: string, init?: RequestInit) =>
  adapter.fetch(path, init).then(answer);

/* ---- every part ------------------------------------------------------- */

describe("@Validate: every part checked, written back, and on req.valid", () => {
  it("V1: a good request is coerced everywhere but the raw headers", async () => {
    expect(
      await post(
        filtered,
        "/parts/5?page=2",
        { name: "Ada", age: "41" },
        {
          headers: { "x-n": "7", cookie: `sid=abc123; uid=${signedUid("5")}` },
        },
      ),
    ).toEqual({
      status: 201,
      body: {
        id: 5,
        typeOfId: "number",
        page: 2,
        typeOfPage: "number",
        headerN: "7",
        typeOfHeaderN: "string",
        body: { name: "Ada", age: 41 },
        typeOfAge: "number",
        validParams: { id: 5 },
        validHeaders: { "x-n": 7 },
        validCookies: { sid: "abc123" },
        validSigned: { uid: 5 },
      },
    });
  });

  it("V2: every alias reads the same parsed parts", async () => {
    expect(
      await post(
        filtered,
        "/alias/3?page=4",
        { name: "Ada", age: "41" },
        {
          headers: { "x-n": "9", cookie: `sid=abc123; uid=${signedUid("6")}` },
        },
      ),
    ).toEqual({
      status: 201,
      body: {
        body: { name: "Ada", age: 41 },
        query: { page: 4 },
        params: { id: 3 },
        headers: { "x-n": 9 },
        cookies: { sid: "abc123" },
        signed: { uid: 6 },
      },
    });
  });

  it("V3: `@Validated` is `undefined` where nothing validated the part", async () => {
    expect(await post(filtered, "/plain", { name: "Ada" })).toEqual({
      status: 201,
      body: { body: null },
    });
  });

  it("V4: a class-level and a method-level `@Validate` merge per part", async () => {
    expect(
      await post(filtered, "/merge?page=3", { name: "Ada", age: "41" }),
    ).toEqual({
      status: 201,
      body: { query: { page: 3 }, body: { name: "Ada", age: 41 } },
    });
    // The method's query schema wins over the class's: no `page` is fine.
    expect(await post(filtered, "/merge-wins?q=x", {})).toEqual({
      status: 201,
      body: { q: "x" },
    });
  });

  it("V5: an asynchronous schema answers with a Promise and still checks", async () => {
    expect(await get(filtered, "/async?page=2")).toEqual({
      status: 200,
      body: { page: 2 },
    });
    expect(await get(filtered, "/async?page=0")).toEqual({
      status: 400,
      body: {
        error: "Validation failed",
        issues: [
          { target: "query", message: "Expected a page number", path: "page" },
        ],
      },
    });
  });

  it("V5b: a wildcard route's params are a `string[]`, and its schema takes one", async () => {
    expect(await get(filtered, "/files/a/b/c")).toEqual({
      status: 200,
      body: { path: ["a", "b", "c"] },
    });
  });
});

/* ---- failures --------------------------------------------------------- */

describe("@Validate: failures", () => {
  it("V6: every bad part's issues in one 400, under the filter", async () => {
    const { status, body } = await post(
      filtered,
      "/parts/x?page=0",
      { name: "", age: "x" },
      { headers: { "x-n": "abc", cookie: `sid=; uid=${signedUid("nope")}` } },
    );
    expect(status).toBe(400);
    const issues = (body as { issues: { target: string; path: string }[] })
      .issues;
    expect(issues.map((issue) => [issue.target, issue.path])).toEqual([
      ["headers", "x-n"],
      ["cookies", "sid"],
      ["signedCookies", "uid"],
      ["params", "id"],
      ["query", "page"],
      ["body", "name"],
      ["body", "age"],
    ]);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("V7: a tampered signed cookie fails; a forged unsigned one is absent", async () => {
    // An unsigned `uid` never reaches signedCookies, so it fails there.
    expect(
      (
        await post(
          filtered,
          "/parts/5?page=2",
          { name: "Ada", age: "41" },
          { headers: { "x-n": "7", cookie: "sid=abc123; uid=5" } },
        )
      ).status,
    ).toBe(400);
    // A tampered signed one is `false`, and fails the same way.
    expect(
      (
        await post(
          filtered,
          "/parts/5?page=2",
          { name: "Ada", age: "41" },
          { headers: { "x-n": "7", cookie: "sid=abc123; uid=s%3A5.forged" } },
        )
      ).status,
    ).toBe(400);
  });

  it("V8: without the filter, the 400 is Nest's own body", async () => {
    const { status, body } = await post(
      bare,
      "/parts/5?page=0",
      { name: "Ada", age: "41" },
      { headers: { "x-n": "7", cookie: `sid=abc123; uid=${signedUid("5")}` } },
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({
      statusCode: 400,
      error: "Bad Request",
      message: ["page: Too small: expected number to be >=1"],
    });
  });

  it("V9: a key the vendor's message quotes is withheld from the answer", async () => {
    const raw = (await Strict["~standard"].validate({
      name: "a",
      [PLANTED]: 1,
    })) as StandardSchemaV1.FailureResult;
    expect(raw.issues.some((issue) => issue.message.includes(PLANTED))).toBe(
      true,
    );

    const { status, body } = await post(filtered, "/strict", {
      name: "a",
      [PLANTED]: 1,
    });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).not.toContain(PLANTED);
  });

  it("V10: declaration mistakes are TypeErrors", () => {
    expect(() => Validate({ wat: Page } as never)).toThrow(TypeError);
    expect(() => Validate({ body: {} } as never)).toThrow(TypeError);
    expect(() => Validated("wat" as never)).toThrow(TypeError);
  });
});

/* ---- the capability gate, and the skip rule -------------------------- */

describe("the skip rule (Nest 12's own schema pipe)", () => {
  it("V11 (both majors): with no pipe of Nest's to check the part, `@Validate` checks it", async () => {
    const before = gateCount.calls();
    // The artificial whole-part entry carries a schema, but no pipe applies:
    // on Nest 11 none exists; on Nest 12 none is registered here.
    expect(await post(gate, "/gate", { name: "ada" })).toEqual({
      status: 201,
      body: { name: "ada" },
    });
    expect(gateCount.calls()).toBe(before + 1);
  });

  it.skipIf(NestSchemaPipe === undefined)(
    "V12: global via useGlobalPipes — the part is left to Nest's pipe",
    async () => {
      const before = skipCounts.global.calls();
      // NestBody upper-cases, once; our counted schema never runs.
      expect(await post(skipGlobal!, "/skip-global", { name: "ada" })).toEqual({
        status: 201,
        body: { name: "ADA" },
      });
      expect(skipCounts.global.calls()).toBe(before);
    },
  );

  it.skipIf(NestSchemaPipe === undefined)(
    "V13 (control): the same route with no pipes is checked here",
    async () => {
      const before = skipCounts.global.calls();
      expect(await post(skipBare!, "/skip-global", { name: "ada" })).toEqual({
        status: 201,
        body: { name: "ada" },
      });
      expect(skipCounts.global.calls()).toBe(before + 1);
    },
  );

  it.skipIf(NestSchemaPipe === undefined)(
    "V14: global via APP_PIPE — the part is left to Nest's pipe",
    async () => {
      const before = skipCounts.global.calls();
      expect(await post(skipAppPipe!, "/skip-global", { name: "ada" })).toEqual(
        {
          status: 201,
          body: { name: "ADA" },
        },
      );
      expect(skipCounts.global.calls()).toBe(before);
    },
  );

  it.skipIf(NestSchemaPipe === undefined)(
    "V15: method-level @UsePipes — the part is left to Nest's pipe",
    async () => {
      const before = skipCounts.methodPipe.calls();
      expect(
        await post(skipBare!, "/skip-method-pipe", { name: "ada" }),
      ).toEqual({
        status: 201,
        body: { name: "ADA" },
      });
      expect(skipCounts.methodPipe.calls()).toBe(before);
    },
  );

  it.skipIf(NestSchemaPipe === undefined)(
    "V16: parameter-level pipes — the part is left to Nest's pipe",
    async () => {
      const before = skipCounts.paramPipe.calls();
      expect(
        await post(skipBare!, "/skip-param-pipe", { name: "ada" }),
      ).toEqual({
        status: 201,
        body: { name: "ADA" },
      });
      expect(skipCounts.paramPipe.calls()).toBe(before);
    },
  );

  it.skipIf(NestSchemaPipe === undefined)(
    "V17: controller-level @UsePipes — the part is left to Nest's pipe",
    async () => {
      const before = skipCounts.classPipe.calls();
      expect(
        await post(skipBare!, "/skip-class-pipe", { name: "ada" }),
      ).toEqual({
        status: 201,
        body: { name: "ADA" },
      });
      expect(skipCounts.classPipe.calls()).toBe(before);
    },
  );

  it.skipIf(NestSchemaPipe === undefined)(
    "V18: a keyed decorator covers one property, never the part",
    async () => {
      const before = skipCounts.keyed.calls();
      expect(
        (await post(skipGlobal!, "/skip-keyed", { name: "ada" })).status,
      ).toBe(201);
      expect(skipCounts.keyed.calls()).toBe(before + 1);
    },
  );

  it.skipIf(NestSchemaPipe === undefined)(
    "V19: no decorator schema, pipe global — the part is still checked here",
    async () => {
      const before = skipCounts.noSchema.calls();
      expect(
        await post(skipGlobal!, "/skip-no-schema", { name: "ada" }),
      ).toEqual({
        status: 201,
        body: { name: "ada" },
      });
      expect(skipCounts.noSchema.calls()).toBe(before + 1);
    },
  );

  it.skipIf(NestSchemaPipe === undefined)(
    "V20: a RAW_BODY entry is never the body part",
    async () => {
      const before = skipCounts.rawBody.calls();
      expect(
        await post(skipGlobal!, "/skip-raw-body", { name: "ada" }),
      ).toEqual({
        status: 201,
        body: { name: "ada" },
      });
      expect(skipCounts.rawBody.calls()).toBe(before + 1);
    },
  );
});
