/**
 * HTTP `QUERY` (RFC 10008) on bun-nest: NestJS's `@QueryMethod()` and
 * `RequestMethod.QUERY`, which arrived in Nest 11.2.0 (nestjs/nest #17162)
 * and route through the adapter's `query()` (`REQUEST_METHOD_MAP`) and
 * `getRequestMethodStr`.
 *
 * The shape of Nest's own `integration/query-method/e2e/query-method.spec.ts`
 * (v12.1.3), ported, not copied: a `QUERY` route with a body, a named one,
 * the wrong method, `@Param`/`@Query`/`@Body` through a guard, an interceptor
 * and a pipe, an exception filter. Beside it: `forRoutes({ method: QUERY })`
 * middleware, `GET`/`HEAD` never answered by a `QUERY` route, and `@All()`.
 * Each request is sent both served and through `adapter.fetch()`.
 *
 * Nest below 11.2 has neither, so the suite is skipped there, visibly. The
 * decorator and the enum member are read from `@nestjs/common` at run time:
 * Nest 11.1's types lack them.
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type {
  ArgumentsHost,
  CallHandler,
  CanActivate,
  ExceptionFilter,
  INestApplication,
  MiddlewareConsumer,
  NestInterceptor,
  PipeTransform,
} from "@nestjs/common";
import type { Observable } from "rxjs";
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
  Query,
  Req,
  RequestMethod,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { map } from "rxjs";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import "reflect-metadata";

/** `@QueryMethod(path?)`, when the installed Nest has it (11.2.0+). */
const NestQueryMethod = (
  common as unknown as {
    QueryMethod?: (path?: string | string[]) => MethodDecorator;
  }
).QueryMethod;

/** `RequestMethod.QUERY`, when the installed Nest has it (11.2.0+). */
const QUERY = (
  RequestMethod as unknown as Record<string, RequestMethod | undefined>
).QUERY;

/** Whether this Nest has HTTP `QUERY`: the suite runs only then. */
const HAS_QUERY = NestQueryMethod !== undefined && QUERY !== undefined;

/**
 * `@QueryMethod(path?)`, or a no-op where Nest lacks it: the classes below
 * are still declared on Nest 11.1, though never booted there.
 */
const QueryMethod: (path?: string) => MethodDecorator =
  NestQueryMethod ?? (() => () => undefined);

interface SearchFilters {
  name?: string;
  page?: number;
}

@Injectable()
class AllowGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

@Injectable()
class TagInterceptor implements NestInterceptor {
  intercept(_context: unknown, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(map((result: object) => ({ ...result, intercepted: true })));
  }
}

@Injectable()
class UppercasePipe implements PipeTransform {
  transform(value: unknown) {
    return typeof value === "string" ? value.toUpperCase() : value;
  }
}

@Catch(BadRequestException)
class RejectFilter implements ExceptionFilter {
  // `@Inject`: the injection token does not rest on emitted type metadata.
  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
  ) {}

  catch(_exception: BadRequestException, host: ArgumentsHost) {
    const response: unknown = host.switchToHttp().getResponse();
    this.adapterHost.httpAdapter.reply(
      response,
      { handledBy: "RejectFilter" },
      400,
    );
  }
}

@Controller("items")
class ItemsController {
  @QueryMethod()
  findAll(@Body() filters: SearchFilters) {
    return { results: [], filters };
  }

  @QueryMethod("search")
  search(@Body() filters: SearchFilters) {
    return { endpoint: "search", filters };
  }

  @UseFilters(RejectFilter)
  @QueryMethod("reject")
  reject(): never {
    throw new BadRequestException("nope");
  }

  // After "search" and "reject": a parameter route first would shadow them.
  @UseGuards(AllowGuard)
  @UseInterceptors(TagInterceptor)
  @QueryMethod(":id")
  findOne(
    @Param("id") id: string,
    @Query("tenant", UppercasePipe) tenant: string,
    @Body() filters: SearchFilters,
  ) {
    return { id, tenant, filters };
  }
}

/** A path served for `GET` and `QUERY` by two handlers, and by `@All()`. */
@Controller("mixed")
class MixedController {
  @Get()
  get() {
    return { handler: "get" };
  }

  @QueryMethod()
  query(@Body() body: unknown) {
    return { handler: "query", body };
  }

  @QueryMethod("first")
  queryFirst() {
    return { handler: "query" };
  }

  @All("first")
  allAfter(@Req() req: { method: string }) {
    return { handler: "all", method: req.method };
  }

  @All("any")
  any(@Req() req: { method: string }) {
    return { handler: "all", method: req.method };
  }
}

/** Marks a response with `X-Query-Mw` (for `QUERY /mixed` only). */
function markQuery(
  _req: unknown,
  res: { setHeader: (name: string, value: string) => void },
  next: () => void,
) {
  res.setHeader("x-query-mw", "ran");
  next();
}

@Module({
  controllers: [ItemsController, MixedController],
  providers: [AllowGuard, TagInterceptor, UppercasePipe, RejectFilter],
})
class QueryModule {
  configure(consumer: MiddlewareConsumer) {
    if (QUERY !== undefined) {
      consumer.apply(markQuery).forRoutes({ path: "mixed", method: QUERY });
    }
  }
}

describe.skipIf(!HAS_QUERY)(
  "HTTP QUERY on bun-nest (Nest 11.2+; skipped below)",
  () => {
    let app: INestApplication;
    let adapter: BunHttpAdapter;
    let base = "";

    beforeAll(async () => {
      adapter = new BunHttpAdapter();
      // `abortOnError: false`: a route the adapter cannot register fails
      // this hook, rather than exiting the process silently.
      app = await NestFactory.create(QueryModule, adapter, {
        logger: false,
        abortOnError: false,
      });
      await app.listen(0, "127.0.0.1");
      base = `http://127.0.0.1:${adapter.listeningPort}`;
    });

    afterAll(async () => {
      await app?.close();
    });

    /** Status, a header and the JSON body, as a served request and `fetch()` give them. */
    async function both(path: string, method: string, body?: unknown) {
      const init: RequestInit = {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      };
      const answers = [];
      for (const res of [
        await fetch(`${base}${path}`, init),
        await adapter.fetch(path, init),
      ]) {
        const text = await res.text();
        answers.push({
          status: res.status,
          mw: res.headers.get("x-query-mw"),
          json: text ? (JSON.parse(text) as unknown) : null,
        });
      }
      expect(answers[1]).toEqual(answers[0]);
      return answers[0]!;
    }

    it("routes QUERY /items to @QueryMethod(), with its body", async () => {
      const res = await both("/items", "QUERY", { name: "nestjs", page: 1 });
      expect([res.status, res.json]).toEqual([
        200,
        { results: [], filters: { name: "nestjs", page: 1 } },
      ]);
    });

    it("routes QUERY /items/search to @QueryMethod('search')", async () => {
      const res = await both("/items/search", "QUERY", { name: "test" });
      expect([res.status, res.json]).toEqual([
        200,
        { endpoint: "search", filters: { name: "test" } },
      ]);
    });

    it("answers GET, HEAD and POST /items with 404: a QUERY route takes QUERY only", async () => {
      for (const method of ["GET", "HEAD", "POST"]) {
        expect((await both("/items", method)).status).toBe(404);
      }
    });

    it("combines @Param(), @Query() and @Body() through a guard, an interceptor and a pipe", async () => {
      const res = await both("/items/42?tenant=acme", "QUERY", {
        name: "nestjs",
      });
      expect([res.status, res.json]).toEqual([
        200,
        {
          id: "42",
          tenant: "ACME",
          filters: { name: "nestjs" },
          intercepted: true,
        },
      ]);
    });

    it("runs exception filters for a QUERY route", async () => {
      const res = await both("/items/reject", "QUERY", {});
      expect([res.status, res.json]).toEqual([
        400,
        { handledBy: "RejectFilter" },
      ]);
    });

    it("runs forRoutes({ method: QUERY }) middleware for QUERY only", async () => {
      const query = await both("/mixed", "QUERY", { a: 1 });
      expect([query.status, query.mw, query.json]).toEqual([
        200,
        "ran",
        { handler: "query", body: { a: 1 } },
      ]);
      const get = await both("/mixed", "GET");
      expect([get.status, get.mw, get.json]).toEqual([
        200,
        null,
        { handler: "get" },
      ]);
      const head = await both("/mixed", "HEAD");
      expect([head.status, head.mw]).toEqual([200, null]);
    });

    it("@All() answers QUERY; a @QueryMethod() declared before it takes QUERY first", async () => {
      expect((await both("/mixed/any", "QUERY", {})).json).toEqual({
        handler: "all",
        method: "QUERY",
      });
      expect((await both("/mixed/first", "QUERY", {})).json).toEqual({
        handler: "query",
      });
      expect((await both("/mixed/first", "GET")).json).toEqual({
        handler: "all",
        method: "GET",
      });
    });
  },
);
