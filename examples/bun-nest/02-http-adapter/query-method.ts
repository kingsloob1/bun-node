/**
 * HTTP `QUERY` (RFC 10008) on `BunHttpAdapter`: a safe, idempotent request
 * whose query travels in the body — a `GET` whose question does not fit in a
 * URL. Nest's `@QueryMethod()` and `RequestMethod.QUERY` serve it from Nest
 * 11.2.0; the adapter's own `query()` serves it on every version.
 *
 * ```bash
 * bun 02-http-adapter/query-method.ts
 * ```
 *
 * Worth knowing:
 *
 * - `adapter.query(path, handler)` registers a raw `QUERY` route beside Nest's
 *   controllers, on Nest 11.1 as on 11.2 and 12. Its params are typed from
 *   the path literal, as `adapter.get()`'s are.
 * - `@QueryMethod(path?)` arrived in Nest 11.2.0 with `RequestMethod.QUERY`.
 *   Nest below 11.2.0 has neither, so this example reads both from
 *   `@nestjs/common` at run time, runs those checks only where
 *   `"QUERY" in RequestMethod`, and says so on a line starting `skipped:`,
 *   naming the installed version, when they sit out. The 11.1.20 column of
 *   `bun scripts/nest-matrix.ts` shows that branch.
 * - A `QUERY` route answers `QUERY` only: `GET`, `HEAD` and `POST` on it are
 *   404, and it is no `GET` fallback either. Its body is parsed exactly as a
 *   `POST`'s is, JSON and URL-encoded alike.
 * - `@Param`, `@Query`, `@Body`, guards, interceptors, pipes and exception
 *   filters behave as on `@nestjs/platform-express`, and
 *   `forRoutes({ path, method: RequestMethod.QUERY })` middleware runs for
 *   `QUERY` alone. `@All()` answers `QUERY` too.
 * - Bun's `Request` upper-cases a lowercase method it knows, so `"query"`
 *   arrives as `QUERY`; a mixed-case `"Query"` becomes `GET`
 *   (oven-sh/bun#42497). Send `"QUERY"`. `../bun-common`'s
 *   `02-routing/verbs-and-params.ts` shows both.
 * - Every request below is sent twice, over the socket and through
 *   `adapter.fetch()`, and each check asserts that the two agree.
 */
import type {
  BunRequest,
  BunResponse,
  JsonValue,
} from "@kingsleyweb/bun-common";
import type {
  ArgumentsHost,
  CallHandler,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  MiddlewareConsumer,
  NestInterceptor,
  NestModule,
  PipeTransform,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import * as common from "@nestjs/common";
import {
  All,
  BadRequestException,
  Body,
  Catch,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  ParseIntPipe,
  Query,
  Req,
  RequestMethod,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { map } from "rxjs";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import "reflect-metadata";

/** The installed `@nestjs/common`'s version, which decides what runs below. */
const NEST_VERSION = (
  (await import("@nestjs/common/package.json")) as { version: string }
).version;

/**
 * Whether this Nest has HTTP `QUERY`: the gate for every `@QueryMethod()`
 * check. Nest 11.1's `RequestMethod` has no `QUERY` member.
 */
const HAS_QUERY = "QUERY" in RequestMethod;

/** `RequestMethod.QUERY` where the installed Nest has it (11.2.0+). */
const QUERY = (
  RequestMethod as unknown as Record<string, RequestMethod | undefined>
).QUERY;

/** `@QueryMethod(path?)` where the installed Nest has it (11.2.0+). */
const NestQueryMethod = (
  common as unknown as {
    QueryMethod?: (path?: string | string[]) => MethodDecorator;
  }
).QueryMethod;

/**
 * `@QueryMethod(path?)`, or a decorator that does nothing where Nest lacks
 * it: the controllers below are still declared on Nest 11.1, and their
 * `QUERY` methods are simply never routed there.
 */
const QueryMethod: (path?: string) => MethodDecorator =
  NestQueryMethod ?? (() => () => undefined);

/** The filters a `QUERY` request carries in its body. */
interface SearchFilters {
  /** A name to match. */
  name?: string;
  /** The page wanted. */
  page?: number;
}

/* ------------------------------------------------------------------ */
/** Lets a request through only with `x-token: let-me-in`; Nest's 403 otherwise. */
@Injectable()
class TokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<BunRequest>();
    return req.getHeader("x-token") === "let-me-in";
  }
}

/** Marks what a handler returns, so a check can see the interceptor ran. */
@Injectable()
class TagInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next
      .handle()
      .pipe(map((result: object) => ({ ...result, intercepted: true })));
  }
}

/** Upper-cases a string argument. */
@Injectable()
class UppercasePipe implements PipeTransform {
  transform(value: unknown) {
    return typeof value === "string" ? value.toUpperCase() : value;
  }
}

/** Answers a `BadRequestException` with a body of its own. */
@Catch(BadRequestException)
class RejectFilter implements ExceptionFilter {
  // `@Inject`: the token does not rest on emitted type metadata.
  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
  ) {}

  catch(exception: BadRequestException, host: ArgumentsHost) {
    this.adapterHost.httpAdapter.reply(
      host.switchToHttp().getResponse(),
      { handledBy: "RejectFilter", message: exception.message },
      422,
    );
  }
}

/** `QUERY /items…`: one `@QueryMethod()` per path. */
@Controller("items")
class ItemsController {
  @QueryMethod()
  findAll(@Body() filters: SearchFilters) {
    return { handler: "findAll", filters };
  }

  @QueryMethod("search")
  search(@Body() filters: SearchFilters) {
    return { handler: "search", filters };
  }

  @UseFilters(RejectFilter)
  @QueryMethod("reject")
  reject(): never {
    throw new BadRequestException("no such filter");
  }

  // After "search" and "reject": a parameter route declared first would
  // shadow both, as on Express.
  @UseGuards(TokenGuard)
  @UseInterceptors(TagInterceptor)
  @QueryMethod(":id")
  findOne(
    @Param("id", ParseIntPipe) id: number,
    @Query("tenant", UppercasePipe) tenant: string,
    @Body() filters: SearchFilters,
  ) {
    return { handler: "findOne", id, tenant, filters };
  }
}

/** `/mixed…`: `GET` and `QUERY` on one path, and `@All()`. */
@Controller("mixed")
class MixedController {
  @Get()
  get() {
    return { handler: "get" };
  }

  @QueryMethod()
  query(@Body() body: JsonValue) {
    return { handler: "query", body };
  }

  // Declared before the `@All()` on the same path, so it takes `QUERY` first.
  @QueryMethod("first")
  queryFirst() {
    return { handler: "query" };
  }

  @All("first")
  allAfter(@Req() req: BunRequest) {
    return { handler: "all", method: req.method };
  }

  @All("any")
  any(@Req() req: BunRequest) {
    return { handler: "all", method: req.method };
  }
}

/** Marks a response `x-query-mw: ran`; applied to `QUERY /mixed` only. */
function markQuery(_req: BunRequest, res: BunResponse, next: () => void) {
  res.setHeader("x-query-mw", "ran");
  next();
}

@Module({
  controllers: [ItemsController, MixedController],
  providers: [TokenGuard, TagInterceptor, UppercasePipe, RejectFilter],
})
class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    if (QUERY !== undefined) {
      consumer.apply(markQuery).forRoutes({ path: "mixed", method: QUERY });
    }
  }
}

/* ------------------------------------------------------------------ */
title("HTTP QUERY on BunHttpAdapter");
show("@nestjs/common", NEST_VERSION);

const adapter = new BunHttpAdapter();

// Raw adapter routes, beside Nest's controllers: these work on every Nest.
adapter.query("/raw/search/:index", (req, res) => {
  return res.json({
    method: req.method,
    index: req.params.index,
    query: req.query as JsonValue,
    body: req.body as JsonValue,
  });
});
adapter.query("/raw/echo", (req, res) => {
  return res.json({ method: req.method, body: req.body as JsonValue });
});
adapter.post("/raw/echo", (req, res) => {
  return res.json({ method: req.method, body: req.body as JsonValue });
});

const app = await NestFactory.create(AppModule, adapter, {
  logger: false,
  abortOnError: false,
});
await app.listen(0);
const url = await app.getUrl();
show("listening on", url);

/** What one request observed. */
interface Observed {
  /** The HTTP status. */
  status: number;
  /** The `x-query-mw` header `markQuery` sets, or `null`. */
  mw: string | null;
  /** The body: parsed JSON when there is one, `null` when it is empty. */
  body: JsonValue;
}

/** Reads a response into an `Observed`. */
async function observe(response: Response): Promise<Observed> {
  const text = await response.text();
  return {
    status: response.status,
    mw: response.headers.get("x-query-mw"),
    body: text ? (JSON.parse(text) as JsonValue) : null,
  };
}

/** What a request answered over the socket and through `adapter.fetch()`. */
interface Both {
  /** Over the socket. */
  served: Observed;
  /** Through `adapter.fetch()`, with no socket. */
  fetched: Observed;
}

/** Sends one request both ways: over the socket and through `adapter.fetch()`. */
async function both(path: string, init: RequestInit = {}): Promise<Both> {
  return {
    served: await observe(await fetch(`${url}${path}`, init)),
    fetched: await observe(await adapter.fetch(path, init)),
  };
}

/** A request with a JSON body. */
function json(method: string, body: unknown, headers = {}): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

/**
 * Passes when the socket and `adapter.fetch()` both answered with exactly
 * `expected`, which also makes the two agree.
 */
function checkBoth(label: string, actual: Both, expected: Partial<Observed>) {
  const pick = (observed: Observed) =>
    Object.fromEntries(
      Object.keys(expected).map((key) => [
        key,
        observed[key as keyof Observed],
      ]),
    );
  checkEqual(
    label,
    [pick(actual.served), pick(actual.fetched)],
    [expected, expected],
  );
}

/* ------------------------------------------------------------------ */
step("Which Nest has QUERY");

checkEqual(
  "@QueryMethod() and RequestMethod.QUERY exist together, from Nest 11.2.0",
  {
    "QUERY in RequestMethod": HAS_QUERY,
    "@QueryMethod exported": NestQueryMethod !== undefined,
  },
  {
    "QUERY in RequestMethod": Bun.semver.satisfies(NEST_VERSION, ">=11.2.0"),
    "@QueryMethod exported": Bun.semver.satisfies(NEST_VERSION, ">=11.2.0"),
  },
);

/* ------------------------------------------------------------------ */
step("adapter.query(): a raw QUERY route, on every Nest");

const search = await both(
  "/raw/search/books?limit=2",
  json("QUERY", { author: "Le Guin" }),
);
show("QUERY /raw/search/books?limit=2", search.served);
checkBoth(
  "QUERY reaches the route, with its params, query and JSON body",
  search,
  {
    status: 200,
    body: {
      method: "QUERY",
      index: "books",
      query: { limit: "2" },
      body: { author: "Le Guin" },
    },
  },
);

/** Each body, sent as `QUERY` and as `POST` to `/raw/echo`, and what it parses to. */
const bodies: Array<[string, RequestInit, JsonValue]> = [
  [
    "JSON",
    { headers: { "content-type": "application/json" }, body: '{"a":[1,2]}' },
    { a: [1, 2] },
  ],
  [
    "URL-encoded",
    {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1&b=two",
    },
    { a: "1", b: "two" },
  ],
  [
    "text",
    { headers: { "content-type": "text/plain" }, body: "plain words" },
    "plain words",
  ],
];
for (const [kind, init, parsed] of bodies) {
  const asQuery = await both("/raw/echo", { ...init, method: "QUERY" });
  const asPost = await both("/raw/echo", { ...init, method: "POST" });
  show(`${kind} body`, asQuery.served.body);
  /** Each answer's status and the body the handler read, POST's first. */
  const read = [asPost, asQuery].flatMap(({ served, fetched }) =>
    [served, fetched].map((o) => [
      o.status,
      (o.body as { body?: JsonValue } | null)?.body ?? null,
    ]),
  );
  checkEqual(
    `a ${kind} body is parsed for QUERY as for POST`,
    read,
    [0, 1, 2, 3].map(() => [200, parsed]),
  );
}

const rawWrongMethods: Record<string, number> = {};
for (const method of ["GET", "HEAD", "POST"]) {
  const answer = await both("/raw/search/books", { method });
  rawWrongMethods[`${method} served`] = answer.served.status;
  rawWrongMethods[`${method} fetch()`] = answer.fetched.status;
}
checkEqual(
  "GET, HEAD and POST on the raw QUERY route are 404",
  rawWrongMethods,
  {
    "GET served": 404,
    "GET fetch()": 404,
    "HEAD served": 404,
    "HEAD fetch()": 404,
    "POST served": 404,
    "POST fetch()": 404,
  },
);

checkBoth(
  'method: "query" reaches it too — Bun\'s Request upper-cases the method',
  await both("/raw/echo", json("query", { lower: true })),
  { status: 200, body: { method: "QUERY", body: { lower: true } } },
);

/* ------------------------------------------------------------------ */
step("@QueryMethod(): Nest's QUERY routes (Nest 11.2+)");

/** How many checks the `@QueryMethod()` steps hold, for the skip line. */
const GATED_CHECKS = 11;

if (!HAS_QUERY) {
  show(
    `skipped: Nest < 11.2.0 has no @QueryMethod() or RequestMethod.QUERY; ${GATED_CHECKS} checks skipped on Nest ${NEST_VERSION}`,
  );
} else {
  const findAll = await both(
    "/items",
    json("QUERY", { name: "nestjs", page: 1 }),
  );
  show("QUERY /items", findAll.served);
  checkBoth("QUERY /items reaches @QueryMethod(), with its body", findAll, {
    status: 200,
    body: { handler: "findAll", filters: { name: "nestjs", page: 1 } },
  });

  checkBoth(
    'QUERY /items/search reaches @QueryMethod("search")',
    await both("/items/search", json("QUERY", { name: "test" })),
    { status: 200, body: { handler: "search", filters: { name: "test" } } },
  );

  const wrongMethods: Record<string, JsonValue> = {};
  for (const method of ["GET", "HEAD", "POST"]) {
    const answer = await both("/items", { method });
    wrongMethods[`${method} served`] = [
      answer.served.status,
      answer.served.body,
    ];
    wrongMethods[`${method} fetch()`] = [
      answer.fetched.status,
      answer.fetched.body,
    ];
  }
  /** Nest's 404 body for `method /items`. */
  const notFound = (method: string) => ({
    message: `Cannot ${method} /items`,
    error: "Not Found",
    statusCode: 404,
  });
  checkEqual(
    "GET, HEAD and POST /items are Nest's 404: a QUERY route takes QUERY only",
    wrongMethods,
    {
      "GET served": [404, notFound("GET")],
      "GET fetch()": [404, notFound("GET")],
      "HEAD served": [404, null],
      "HEAD fetch()": [404, null],
      "POST served": [404, notFound("POST")],
      "POST fetch()": [404, notFound("POST")],
    },
  );

  /* ---------------------------------------------------------------- */
  step("@Param, @Query and @Body through a guard, an interceptor and pipes");

  const allowed = await both(
    "/items/42?tenant=acme",
    json("QUERY", { name: "nestjs" }, { "x-token": "let-me-in" }),
  );
  show("QUERY /items/42?tenant=acme", allowed.served);
  checkBoth(
    "ParseIntPipe, UppercasePipe, the guard and the interceptor all run",
    allowed,
    {
      status: 200,
      body: {
        handler: "findOne",
        id: 42,
        tenant: "ACME",
        filters: { name: "nestjs" },
        intercepted: true,
      },
    },
  );

  checkBoth(
    "the guard refuses a request without the token: Nest's 403",
    await both("/items/42?tenant=acme", json("QUERY", {})),
    {
      status: 403,
      body: {
        message: "Forbidden resource",
        error: "Forbidden",
        statusCode: 403,
      },
    },
  );

  checkBoth(
    "ParseIntPipe refuses /items/abc: Nest's 400",
    await both("/items/abc", json("QUERY", {}, { "x-token": "let-me-in" })),
    {
      status: 400,
      body: {
        message: "Validation failed (numeric string is expected)",
        error: "Bad Request",
        statusCode: 400,
      },
    },
  );

  checkBoth(
    "an exception filter answers a QUERY route's error",
    await both("/items/reject", json("QUERY", {})),
    {
      status: 422,
      body: { handledBy: "RejectFilter", message: "no such filter" },
    },
  );

  /* ---------------------------------------------------------------- */
  step("forRoutes({ path, method: RequestMethod.QUERY }) and @All()");

  const mixedQuery = await both("/mixed", json("QUERY", { a: 1 }));
  const mixedGet = await both("/mixed", { method: "GET" });
  const mixedHead = await both("/mixed", { method: "HEAD" });
  show("QUERY /mixed", mixedQuery.served);
  show("GET /mixed", mixedGet.served);
  checkEqual(
    "the QUERY middleware runs for QUERY /mixed, not for GET or HEAD",
    [mixedQuery, mixedGet, mixedHead].flatMap(({ served, fetched }) => [
      [served.status, served.mw],
      [fetched.status, fetched.mw],
    ]),
    [
      [200, "ran"],
      [200, "ran"],
      [200, null],
      [200, null],
      [200, null],
      [200, null],
    ],
  );
  checkEqual(
    "QUERY and GET /mixed reach their own handlers",
    [mixedQuery.served.body, mixedQuery.fetched.body, mixedGet.served.body],
    [
      { handler: "query", body: { a: 1 } },
      { handler: "query", body: { a: 1 } },
      { handler: "get" },
    ],
  );

  checkBoth(
    "@All() answers QUERY",
    await both("/mixed/any", json("QUERY", {})),
    {
      status: 200,
      body: { handler: "all", method: "QUERY" },
    },
  );

  const first = await both("/mixed/first", json("QUERY", {}));
  const firstGet = await both("/mixed/first", { method: "GET" });
  check(
    "a @QueryMethod() declared before @All() takes QUERY; GET still reaches @All()",
    Bun.deepEquals(
      [first.served.body, first.fetched.body, firstGet.served.body],
      [
        { handler: "query" },
        { handler: "query" },
        { handler: "all", method: "GET" },
      ],
    ),
    { query: first, get: firstGet },
  );
}

/* ------------------------------------------------------------------ */
step("Close");

await app.close();
show("closed");
summary();
