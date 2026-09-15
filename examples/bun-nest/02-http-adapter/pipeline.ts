/**
 * The request pipeline on `BunHttpAdapter`: guards, interceptors, pipes and
 * exception filters around a handler — and the adapter-level fallbacks
 * behind them, `setNotFoundHandler` and `setErrorHandler`.
 *
 * ```bash
 * bun 02-http-adapter/pipeline.ts
 * ```
 *
 * Worth knowing:
 *
 * - Between a matched route and its handler everything is plain NestJS, in
 *   Nest's order: middleware → guards → interceptors → pipes → handler →
 *   interceptors → filters. The adapter hands it a `BunRequest` and a
 *   `BunResponse` and sends what comes back.
 * - Validation needs no `class-validator`: a small pipe runs any
 *   [Standard Schema](https://standardschema.dev) (zod, valibot, arktype, …),
 *   and bun-common's `toStandardSchema` turns a plain function into one.
 * - Behind Nest's own handling sit three fallbacks, for what never reaches a
 *   controller:
 *   - `adapter.setNotFoundHandler` — a request no route matched. Nest adds its
 *     own at init (`Cannot GET /x`); one added earlier runs first, and
 *     returning nothing from it stops the ones after.
 *   - an Express-style 4-argument error middleware, added with `app.use()`
 *     after `app.init()` so it follows the routes — for errors thrown by raw
 *     middleware, which Nest's filters never see.
 *   - `adapter.setErrorHandler` — an error nothing in the router handled. It
 *     runs from `Bun.serve`'s `error` callback, so this example listens on a
 *     real socket.
 */
import type {
  BunRequest,
  BunResponse,
  JsonValue,
  RouterErrorMiddlewareHandler,
  StandardSchemaV1,
} from "@kingsleyweb/bun-common";
import type {
  ArgumentMetadata,
  ArgumentsHost,
  CallHandler,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  NestInterceptor,
  PipeTransform,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { toStandardSchema } from "@kingsleyweb/bun-common";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  BadRequestException,
  Body,
  Catch,
  Controller,
  DefaultValuePipe,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Post,
  Query,
  RequestTimeoutException,
  SetMetadata,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { catchError, map, of, throwError, timeout, TimeoutError } from "rxjs";
import { show, step, title } from "../shared/console";
import "reflect-metadata";

/** What ran for the request being shown, in order. */
const trail: string[] = [];

/* ------------------------------------------------------------------ */
/* Guards                                                              */

/** Metadata key marking a handler as reachable without an API key. */
const IS_PUBLIC = "isPublic";

/** Marks a handler as public. */
const Public = () => SetMetadata(IS_PUBLIC, true);

/** Roles a handler requires. */
const Roles = Reflector.createDecorator<string[]>();

/** Global guard: an `x-api-key` header, unless the handler is `@Public()`. */
class ApiKeyGuard implements CanActivate {
  constructor(
    /** Reads the `@Public()` metadata. */
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    trail.push("ApiKeyGuard");
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const req = context.switchToHttp().getRequest<BunRequest>();
    return req.getHeader("x-api-key") === "secret";
  }
}

/** Route guard, resolved by Nest's injector: `x-roles` must include every `@Roles`. */
@Injectable()
class RolesGuard implements CanActivate {
  constructor(
    /** Reads the `@Roles()` metadata. */
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    trail.push("RolesGuard");
    const required = this.reflector.get(Roles, context.getHandler()) ?? [];
    const req = context.switchToHttp().getRequest<BunRequest>();
    const held = (req.getHeader("x-roles") ?? "").split(",");
    return required.every((role) => held.includes(role));
  }
}

/* ------------------------------------------------------------------ */
/* Pipes                                                               */

/** Validates a value against any Standard Schema, answering 400 with the issues. */
class SchemaPipe<T> implements PipeTransform<unknown, Promise<T>> {
  constructor(
    /** The schema the value must satisfy. */
    private readonly schema: StandardSchemaV1<unknown, T>,
  ) {}

  async transform(value: unknown): Promise<T> {
    trail.push("SchemaPipe");
    const result = await this.schema["~standard"].validate(value);
    if (result.issues) {
      throw new BadRequestException({
        message: "Validation failed",
        issues: result.issues.map((issue) => {
          const path = (issue.path ?? []).map((segment) => {
            return typeof segment === "object"
              ? String(segment.key)
              : String(segment);
          });
          return { path: path.join("."), message: issue.message };
        }),
      });
    }

    return result.value;
  }
}

/** Global pipe: trims every string field of a body. */
class TrimBodyPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata) {
    if (metadata.type !== "body" || typeof value !== "object" || !value) {
      return value;
    }

    trail.push("TrimBodyPipe");
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => {
        return [key, typeof field === "string" ? field.trim() : field];
      }),
    );
  }
}

/** An order as the handler receives it. */
interface NewOrder {
  /** The product ordered. */
  sku: string;
  /** How many, a whole number of at least 1. */
  quantity: number;
}

/** A Standard Schema from a plain function, via bun-common. */
const NewOrderSchema = toStandardSchema<unknown, NewOrder>((input) => {
  const candidate = (input ?? {}) as Record<string, unknown>;
  const issues: { message: string; path: string[] }[] = [];

  if (typeof candidate.sku !== "string" || candidate.sku.length === 0) {
    issues.push({ message: "must be a non-empty string", path: ["sku"] });
  }

  const quantity = Number(candidate.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) {
    issues.push({ message: "must be a whole number ≥ 1", path: ["quantity"] });
  }

  return issues.length > 0
    ? { issues }
    : { value: { sku: String(candidate.sku), quantity } };
});

/* ------------------------------------------------------------------ */
/* Interceptors                                                        */

/** Wraps every result in `{ data }` and reports how long the handler took. */
@Injectable()
class EnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    trail.push("EnvelopeInterceptor (before)");
    const started = performance.now();
    const res = context.switchToHttp().getResponse<BunResponse>();

    return next.handle().pipe(
      map((data: unknown) => {
        trail.push("EnvelopeInterceptor (after)");
        const took = (performance.now() - started).toFixed(2);
        res.setHeader("x-response-time", `${took}ms`);
        return { data };
      }),
    );
  }
}

/** Answers from a cache without running the handler at all. */
@Injectable()
class CacheInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    trail.push("CacheInterceptor");
    const req = context.switchToHttp().getRequest<BunRequest>();
    if (req.query.cached === "1") {
      return of({ fromCache: true });
    }

    return next.handle();
  }
}

/** Gives up on a slow handler with 408. */
@Injectable()
class TimeoutInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    trail.push("TimeoutInterceptor");
    return next.handle().pipe(
      timeout(50),
      catchError((error: unknown) => {
        return throwError(() => {
          return error instanceof TimeoutError
            ? new RequestTimeoutException("the report took too long")
            : error;
        });
      }),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Exception filters                                                   */

/** A domain error that is not an `HttpException`. */
class OutOfStockError extends Error {
  constructor(
    /** The product that ran out. */
    readonly sku: string,
  ) {
    super(`${sku} is out of stock`);
    this.name = "OutOfStockError";
  }
}

/** Route filter: turns the domain error into 409. */
@Catch(OutOfStockError)
class OutOfStockFilter implements ExceptionFilter<OutOfStockError> {
  catch(error: OutOfStockError, host: ArgumentsHost) {
    trail.push("OutOfStockFilter");
    const res = host.switchToHttp().getResponse<BunResponse>();
    return res
      .status(HttpStatus.CONFLICT)
      .json({ error: "out_of_stock", sku: error.sku });
  }
}

/** Global filter: one shape for every `HttpException`. */
@Catch(HttpException)
class HttpErrorFilter implements ExceptionFilter<HttpException> {
  catch(error: HttpException, host: ArgumentsHost) {
    trail.push("HttpErrorFilter");
    const http = host.switchToHttp();
    const req = http.getRequest<BunRequest>();
    const res = http.getResponse<BunResponse>();
    return res.status(error.getStatus()).json({
      statusCode: error.getStatus(),
      path: req.path,
      detail: error.getResponse(),
    });
  }
}

/* ------------------------------------------------------------------ */
@Controller("orders")
@UseInterceptors(EnvelopeInterceptor)
class OrdersController {
  /** Built-in pipes, with defaults for missing query parameters. */
  @Get()
  @Public()
  list(
    @Query("limit", new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query("open", new DefaultValuePipe(false), ParseBoolPipe) open: boolean,
  ) {
    trail.push("OrdersController.list");
    return { limit, open, orders: [] };
  }

  @Get("slow/report")
  @Public()
  @UseInterceptors(TimeoutInterceptor)
  async slowReport() {
    trail.push("OrdersController.slowReport");
    await Bun.sleep(200);
    return { report: "finally" };
  }

  @Get(":id")
  @Public()
  @UseInterceptors(CacheInterceptor)
  one(@Param("id", ParseIntPipe) id: number) {
    trail.push("OrdersController.one");
    return { id, sku: "pen" };
  }

  @Post()
  @UseFilters(OutOfStockFilter)
  create(@Body(new SchemaPipe(NewOrderSchema)) order: NewOrder) {
    trail.push("OrdersController.create");
    if (order.sku === "unobtainium") {
      throw new OutOfStockError(order.sku);
    }

    return { created: order };
  }

  @Post(":id/refund")
  @Roles(["admin"])
  @UseGuards(RolesGuard)
  refund(@Param("id", ParseIntPipe) id: number) {
    trail.push("OrdersController.refund");
    return { refunded: id };
  }
}

@Module({ controllers: [OrdersController] })
class ShopModule {}

/** Thrown by raw middleware; handled by a router-level error middleware. */
class TeapotError extends Error {
  override name = "TeapotError";
}

title("The request pipeline on BunHttpAdapter");

const adapter = new BunHttpAdapter();

// Added before `app.init()`, so these run ahead of the ones Nest adds.
adapter.setNotFoundHandler((req, res) => {
  trail.push("setNotFoundHandler");
  res
    .status(404)
    .json({ error: "no_route", method: req.method, path: req.path });
});
adapter.setErrorHandler((error, _req, res, _next) => {
  trail.push("setErrorHandler");
  res.status(500).json({
    error: "unhandled",
    message: error instanceof Error ? error.message : String(error),
  });
});

const app = await NestFactory.create(ShopModule, adapter, {
  logger: false,
  abortOnError: false,
});
app.useGlobalGuards(new ApiKeyGuard(app.get(Reflector)));
app.useGlobalPipes(new TrimBodyPipe());
app.useGlobalFilters(new HttpErrorFilter());

// Raw middleware — outside every Nest guard, pipe and filter.
app.use((req: BunRequest, _res: BunResponse, next: () => void) => {
  trail.push("raw middleware");
  if (req.path === "/explode/teapot") {
    throw new TeapotError("I'm a teapot");
  }
  if (req.path === "/explode/other") {
    throw new Error("raw middleware failed");
  }
  next();
});
await app.init();

// Registered after init, so it follows every route in the pipeline.
const teapotHandler: RouterErrorMiddlewareHandler = (
  error,
  _req,
  res,
  next,
) => {
  if (!(error instanceof TeapotError)) {
    return next(error as Error);
  }

  trail.push("router error middleware");
  return res.status(418).json({ error: "teapot", message: error.message });
};
app.use(teapotHandler);

await app.listen(0);
const url = await app.getUrl();
show("listening on", url);

/** Calls the app over HTTP and prints the status, trail and body. */
async function call(label: string, path: string, init: RequestInit = {}) {
  trail.length = 0;
  const response = await fetch(`${url}${path}`, init);
  const text = await response.text();
  show(label, {
    status: response.status,
    trail: [...trail],
    body: text ? JSON.parse(text) : "",
  });
}

/** Request options for a JSON `POST` carrying the given headers. */
function post(
  body: JsonValue,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

/* ------------------------------------------------------------------ */
step("Built-in pipes and the envelope interceptor");
await call("GET /orders?limit=5&open=true", "/orders?limit=5&open=true");
await call("GET /orders (defaults)", "/orders");
await call("GET /orders?limit=many", "/orders?limit=many");

/* ------------------------------------------------------------------ */
step("Guards");
await call("POST /orders without a key", "/orders", post({ sku: "pen" }));
await call(
  "POST /orders/7/refund as a viewer",
  "/orders/7/refund",
  post({}, { "x-api-key": "secret", "x-roles": "viewer" }),
);
await call(
  "POST /orders/7/refund as an admin",
  "/orders/7/refund",
  post({}, { "x-api-key": "secret", "x-roles": "viewer,admin" }),
);

/* ------------------------------------------------------------------ */
step("A Standard Schema pipe and a route-scoped filter");
const key = { "x-api-key": "secret" };
await call("invalid order", "/orders", post({ sku: "", quantity: 0 }, key));
await call(
  "valid order (trimmed by the global pipe)",
  "/orders",
  post({ sku: "  pen  ", quantity: "2" }, key),
);
await call(
  "out of stock (OutOfStockFilter)",
  "/orders",
  post({ sku: "unobtainium", quantity: 1 }, key),
);

/* ------------------------------------------------------------------ */
step("Interceptors that short-circuit or time out");
await call("GET /orders/3", "/orders/3");
await call("GET /orders/3?cached=1", "/orders/3?cached=1");
await call("GET /orders/slow/report", "/orders/slow/report");

/* ------------------------------------------------------------------ */
step("Adapter-level fallbacks");
await call("GET /nowhere (setNotFoundHandler)", "/nowhere");
await call("GET /explode/teapot (router error middleware)", "/explode/teapot");
await call("GET /explode/other (setErrorHandler)", "/explode/other");

await app.close();
show("closed");
