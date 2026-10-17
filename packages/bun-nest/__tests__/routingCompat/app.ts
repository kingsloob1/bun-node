/**
 * The route table of the routing differential: controllers, middleware and
 * modules, one source for Nest 11 and Nest 12. What only one major has
 * (`@QueryMethod`, `RequestMethod.QUERY`) is feature-detected, never read
 * from a version string.
 *
 * Every handler answers JSON `{ h, ..., trail }` and sets `x-h`, so a HEAD,
 * whose body is dropped, still says which handler ran; every middleware
 * appends its name to `req.trail` and writes the trail to `x-trail`.
 *
 * Ported from the plan's harness,
 * `docs/plans/nestjs-12-parity/evidence/routing/harness/app.ts`.
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type { MiddlewareConsumer, NestMiddleware } from "@nestjs/common";
import * as common from "@nestjs/common";
import {
  All,
  Controller,
  Get,
  Head,
  Header,
  HostParam,
  HttpCode,
  Injectable,
  Module,
  Options,
  Param,
  Post,
  Redirect,
  Req,
  RequestMethod,
  Scope,
  Search,
  Version,
  VERSION_NEUTRAL,
} from "@nestjs/common";
import { RouterModule } from "@nestjs/core";
import "reflect-metadata";

/** `@QueryMethod`'s shape. */
type QueryMethodDecorator = (path?: string) => MethodDecorator;

/** `@QueryMethod` (HTTP QUERY), added in 11.2.0 (#17162); undefined on 11.1.x. */
export const QueryMethod = (common as Record<string, unknown>).QueryMethod as
  | QueryMethodDecorator
  | undefined;

/** Whether this Nest has `RequestMethod.QUERY` (11.2.0 and 12). */
export const HAS_QUERY =
  (RequestMethod as Record<string, unknown>).QUERY !== undefined;

/** A request on either adapter: Express's `req` or a `BunRequest`. */
type AnyReq = Record<string, any>;

/** The middleware trail so far. */
function trail(req: AnyReq): string[] {
  return req.trail ?? [];
}

/** A request header, on Express's `req` and on `BunRequest` alike. */
export function header(req: AnyReq, name: string): string | undefined {
  const value =
    typeof req.get === "function" ? req.get(name) : req.headers?.[name];
  return value == null ? undefined : String(value);
}

/** What every handler answers. */
function answer(h: string, req: AnyReq, extra: Record<string, unknown> = {}) {
  return { h, ...extra, trail: trail(req) };
}

/** A named middleware class that records itself on the trail. */
export function trailMiddleware(name: string): new () => NestMiddleware {
  const cls = {
    [name]: class {
      use(req: AnyReq, res: AnyReq, next: () => void) {
        req.trail = [...trail(req), name];
        res.setHeader("x-trail", req.trail.join(">"));
        next();
      }
    },
  }[name];
  return cls;
}

// ---------------------------------------------------------------- routes

@Controller("users")
export class UsersController {
  @Get(":id")
  @Header("x-h", "users.byId")
  byId(@Param("id") id: string, @Req() req: AnyReq) {
    return answer("users.byId", req, { id });
  }

  /** Declared after `:id`: on an order-sensitive router `:id` wins. */
  @Get("me")
  @Header("x-h", "users.me")
  me(@Req() req: AnyReq) {
    return answer("users.me", req);
  }
}

@Controller("files")
export class FilesController {
  @Get("*path")
  @Header("x-h", "files.star")
  star(@Param() params: unknown, @Req() req: AnyReq) {
    return answer("files.star", req, { params });
  }
}

@Controller("files2")
export class Files2Controller {
  @Get("{*path}")
  @Header("x-h", "files2.optStar")
  optStar(@Param() params: unknown, @Req() req: AnyReq) {
    return answer("files2.optStar", req, { params });
  }
}

@Controller()
export class OptionalController {
  @Get("opt{/:x}")
  @Header("x-h", "opt")
  opt(@Param() params: unknown, @Req() req: AnyReq) {
    return answer("opt", req, { params });
  }
}

@Controller()
export class LegacyStarController {
  @Get("legacy/*")
  @Header("x-h", "legacy.star")
  legacy(@Param() params: unknown, @Req() req: AnyReq) {
    return answer("legacy.star", req, { params });
  }
}

@Controller()
export class LegacyGroupController {
  @Get("old/(.*)")
  @Header("x-h", "old.group")
  old(@Param() params: unknown, @Req() req: AnyReq) {
    return answer("old.group", req, { params });
  }
}

/** `:x?`: path-to-regexp 1 syntax, which path-to-regexp 8 rejects. */
@Controller()
export class OptionalParamController {
  @Get("optp/:x?")
  @Header("x-h", "optp")
  optp(@Param() params: unknown, @Req() req: AnyReq) {
    return answer("optp", req, { params });
  }
}

/** `:id(\d+)`: a regexp constraint, which path-to-regexp 8 rejects. */
@Controller()
export class ConstrainedParamController {
  @Get("num/:id(\\d+)")
  @Header("x-h", "num")
  num(@Param() params: unknown, @Req() req: AnyReq) {
    return answer("num", req, { params });
  }
}

@Controller()
export class MiscController {
  @Get("t")
  @Header("x-h", "t")
  t(@Req() req: AnyReq) {
    return answer("t", req);
  }

  @Get("Case")
  @Header("x-h", "Case")
  caseRoute(@Req() req: AnyReq) {
    return answer("Case", req);
  }

  @All("any")
  @Header("x-h", "any")
  any(@Req() req: AnyReq) {
    return answer("any", req, { method: req.method });
  }

  @Head("hd")
  @Header("x-h", "hd.head")
  hdHead(@Req() req: AnyReq) {
    return answer("hd.head", req);
  }

  @Get("hd")
  @Header("x-h", "hd.get")
  hdGet(@Req() req: AnyReq) {
    return answer("hd.get", req);
  }

  @Get("gonly")
  @Header("x-h", "gonly")
  gonly(@Req() req: AnyReq) {
    return answer("gonly", req);
  }

  @Options("opts")
  @Header("x-h", "opts")
  opts(@Req() req: AnyReq) {
    return answer("opts", req);
  }

  @Search("srch")
  @Header("x-h", "srch")
  srch(@Req() req: AnyReq) {
    return answer("srch", req);
  }

  @Get("redir")
  @Header("x-h", "redir")
  @Redirect("https://example.test/r", 301)
  redir() {}

  @Post("code")
  @HttpCode(202)
  @Header("x-h", "code")
  code(@Req() req: AnyReq) {
    return answer("code", req);
  }

  @Get("hdr")
  @Header("x-custom", "1")
  @Header("x-h", "hdr")
  hdr(@Req() req: AnyReq) {
    return answer("hdr", req);
  }
}

/**
 * `@QueryMethod("q")` (HTTP QUERY), applied by hand because the decorator
 * exists only from 11.2.0. Its own controller: on an adapter whose router
 * has no `query()`, registering it fails the whole application.
 */
@Controller()
export class QueryController {
  @Header("x-h", "q")
  q(@Req() req: AnyReq) {
    return answer("q", req);
  }

  @Get("gq")
  @Header("x-h", "gq")
  gq(@Req() req: AnyReq) {
    return answer("gq", req);
  }
}

if (QueryMethod) {
  const proto = QueryController.prototype;
  QueryMethod("q")(proto, "q", Object.getOwnPropertyDescriptor(proto, "q")!);
}

export const MwQuery = trailMiddleware("MwQuery");
export const MwQueryAll = trailMiddleware("MwQueryAll");

/**
 * Middleware bound to `RequestMethod.QUERY`, which the adapter's
 * `getRequestMethodStr` must map; `undefined` where the core has no QUERY.
 */
@Module({ controllers: [QueryController] })
export class QueryMiddlewareModule {
  configure(consumer: MiddlewareConsumer) {
    const query = (RequestMethod as Record<string, unknown>).QUERY as
      | RequestMethod
      | undefined;
    if (query === undefined) return;
    consumer.apply(MwQuery).forRoutes({ path: "q", method: query });
    consumer
      .apply(MwQueryAll)
      .forRoutes({ path: "gq", method: RequestMethod.ALL });
  }
}

/** #17710: duplicate internal slashes in the declared paths. */
@Controller("dbl/")
export class DoubleSlashController {
  @Get("/inner")
  @Header("x-h", "dbl.inner")
  inner(@Req() req: AnyReq) {
    return answer("dbl.inner", req);
  }

  @Get("a//b")
  @Header("x-h", "dbl.ab")
  ab(@Req() req: AnyReq) {
    return answer("dbl.ab", req);
  }
}

@Controller({ host: ":sub.example.com", path: "host" })
export class HostController {
  @Get()
  @Header("x-h", "host")
  host(@HostParam("sub") sub: string, @Req() req: AnyReq) {
    return answer("host", req, { sub });
  }
}

@Module({
  controllers: [
    UsersController,
    FilesController,
    Files2Controller,
    MiscController,
    DoubleSlashController,
    HostController,
  ],
})
export class RoutesModule {}

/** One controller per module, so a syntax one adapter rejects fails alone. */
export function moduleOf(...controllers: (new () => object)[]) {
  @Module({ controllers })
  class SyntaxModule {}
  return SyntaxModule;
}

// ---------------------------------------------------------------- prefix

@Controller()
export class SmallController {
  @Get("hello")
  @Header("x-h", "hello.get")
  hello(@Req() req: AnyReq) {
    return answer("hello.get", req);
  }

  @Post("hello")
  @HttpCode(200)
  @Header("x-h", "hello.post")
  helloPost(@Req() req: AnyReq) {
    return answer("hello.post", req);
  }

  @Get("health")
  @Header("x-h", "health")
  health(@Req() req: AnyReq) {
    return answer("health", req);
  }
}

@Module({ controllers: [SmallController, FilesController] })
export class PrefixModule {}

/** #18072: a URI-versioned route, excluded from the prefix for one version. */
@Controller()
export class VersionedSmallController {
  @Get("hello")
  @Version("1")
  @Header("x-h", "vhello.v1.get")
  helloV1(@Req() req: AnyReq) {
    return answer("vhello.v1.get", req);
  }

  @Post("hello")
  @Version("1")
  @HttpCode(200)
  @Header("x-h", "vhello.v1.post")
  helloV1Post(@Req() req: AnyReq) {
    return answer("vhello.v1.post", req);
  }

  @Get("hello")
  @Version("2")
  @Header("x-h", "vhello.v2.get")
  helloV2(@Req() req: AnyReq) {
    return answer("vhello.v2.get", req);
  }
}

@Module({ controllers: [VersionedSmallController] })
export class VersionedPrefixModule {}

// ---------------------------------------------------------------- RouterModule

/** Reached through `RouterModule` at `admin/` (#17710's slash collapsing). */
@Controller("items")
export class AdminItemsController {
  @Get(":id")
  @Header("x-h", "admin.items.byId")
  byId(@Param("id") id: string, @Req() req: AnyReq) {
    return answer("admin.items.byId", req, { id });
  }
}

@Module({ controllers: [AdminItemsController] })
export class AdminModule {}

/** A child of `AdminModule` at `/nested//`. */
@Controller("/leaf/")
export class NestedLeafController {
  @Get()
  @Header("x-h", "nested.leaf")
  leaf(@Req() req: AnyReq) {
    return answer("nested.leaf", req);
  }
}

@Module({ controllers: [NestedLeafController] })
export class NestedModule {}

@Module({
  imports: [
    AdminModule,
    NestedModule,
    RouterModule.register([
      {
        path: "admin/",
        module: AdminModule,
        children: [{ path: "/nested//", module: NestedModule }],
      },
    ]),
  ],
})
export class RouterModuleApp {}

// ---------------------------------------------------------------- versioning

@Controller("ver")
export class VersionedController {
  @Get()
  @Version("1")
  @Header("x-h", "ver.v1")
  one(@Req() req: AnyReq) {
    return answer("ver.v1", req);
  }

  @Get()
  @Version(["2", "3"])
  @Header("x-h", "ver.v2or3")
  two(@Req() req: AnyReq) {
    return answer("ver.v2or3", req);
  }

  @Get()
  @Version(VERSION_NEUTRAL)
  @Header("x-h", "ver.neutral")
  neutral(@Req() req: AnyReq) {
    return answer("ver.neutral", req);
  }
}

@Controller({ path: "cv", version: "2" })
export class ControllerVersionedController {
  @Get()
  @Header("x-h", "cv.v2")
  get(@Req() req: AnyReq) {
    return answer("cv.v2", req);
  }
}

@Controller("plain")
export class PlainController {
  @Get()
  @Header("x-h", "plain")
  get(@Req() req: AnyReq) {
    return answer("plain", req);
  }
}

@Module({
  controllers: [
    VersionedController,
    ControllerVersionedController,
    PlainController,
  ],
})
export class VersioningModule {}

// ---------------------------------------------------------------- middleware

@Controller()
export class MwLiteController {
  @Get("t")
  @Header("x-h", "t.get")
  t(@Req() req: AnyReq) {
    return answer("t.get", req);
  }

  @Post("t")
  @HttpCode(200)
  @Header("x-h", "t.post")
  tPost(@Req() req: AnyReq) {
    return answer("t.post", req);
  }

  @Get("hd")
  @Header("x-h", "hd.get")
  hd(@Req() req: AnyReq) {
    return answer("hd.get", req);
  }

  @Get("gonly")
  @Header("x-h", "gonly")
  gonly(@Req() req: AnyReq) {
    return answer("gonly", req);
  }

  @Get("trans")
  @Header("x-h", "trans")
  trans(@Req() req: AnyReq) {
    return answer("trans", req);
  }
}

/** #18075: a controller whose paths carry their own slashes. */
@Controller("/slash/")
export class SlashController {
  @Get("/x")
  @Header("x-h", "slash.x")
  x(@Req() req: AnyReq) {
    return answer("slash.x", req);
  }
}

/** #17846: a transient middleware, followed by another. */
@Injectable({ scope: Scope.TRANSIENT })
export class TransientMw implements NestMiddleware {
  use(req: AnyReq, res: AnyReq, next: () => void) {
    req.trail = [...trail(req), "Transient"];
    res.setHeader("x-trail", req.trail.join(">"));
    next();
  }
}

export const MwAll = trailMiddleware("MwAll");
export const MwUsers = trailMiddleware("MwUsers");
export const MwFiles = trailMiddleware("MwFiles");
export const MwPostT = trailMiddleware("MwPostT");
export const MwGetHd = trailMiddleware("MwGetHd");
export const MwCtrl = trailMiddleware("MwCtrl");
export const MwSlash = trailMiddleware("MwSlash");
export const AfterTransient = trailMiddleware("AfterTransient");
export const MwHello = trailMiddleware("MwHello");
export const MwStarPath = trailMiddleware("MwStarPath");
export const MwNeutral = trailMiddleware("MwNeutral");
export const MwV1 = trailMiddleware("MwV1");
export const MwVerCtrl = trailMiddleware("MwVerCtrl");

@Module({
  controllers: [
    UsersController,
    FilesController,
    MwLiteController,
    SlashController,
  ],
  providers: [TransientMw],
})
export class MwBasicModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(MwAll).forRoutes("*");
    consumer.apply(MwUsers).forRoutes("users");
    consumer.apply(MwFiles).forRoutes("files/*path");
    consumer
      .apply(MwPostT)
      .forRoutes({ path: "t", method: RequestMethod.POST });
    consumer
      .apply(MwGetHd)
      .forRoutes({ path: "hd", method: RequestMethod.GET });
    consumer
      .apply(MwCtrl)
      .exclude("users/me", { path: "gonly", method: RequestMethod.GET })
      .forRoutes(UsersController, MwLiteController);
    consumer.apply(MwSlash).forRoutes(SlashController);
    consumer.apply(TransientMw, AfterTransient).forRoutes("trans");
  }
}

@Module({ controllers: [SmallController] })
export class MwPrefixModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(MwAll).forRoutes("*");
    consumer
      .apply(MwStarPath)
      .forRoutes({ path: "*path", method: RequestMethod.ALL });
    consumer.apply(MwHello).forRoutes("hello");
  }
}

@Module({ controllers: [VersionedController, PlainController] })
export class MwVersionModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(MwNeutral).forRoutes({
      path: "ver",
      method: RequestMethod.ALL,
      version: VERSION_NEUTRAL,
    });
    consumer
      .apply(MwV1)
      .forRoutes({ path: "ver", method: RequestMethod.GET, version: "1" });
    consumer.apply(MwVerCtrl).forRoutes(VersionedController);
  }
}

// ---------------------------------------------------------------- Nest 12 route options

@Controller("s")
export class SpecController {
  @Get(":id")
  @Header("x-h", "s.byId")
  byId(@Param("id") id: string, @Req() req: AnyReq) {
    return answer("s.byId", req, { id });
  }

  @Get("me")
  @Header("x-h", "s.me")
  me(@Req() req: AnyReq) {
    return answer("s.me", req);
  }

  @Get("*rest")
  @Header("x-h", "s.rest")
  rest(@Param() params: unknown, @Req() req: AnyReq) {
    return answer("s.rest", req, { params });
  }

  @Get("a/:x")
  @Header("x-h", "s.aParam")
  aParam(@Param("x") x: string, @Req() req: AnyReq) {
    return answer("s.aParam", req, { x });
  }

  @Get("a/b")
  @Header("x-h", "s.ab")
  ab(@Req() req: AnyReq) {
    return answer("s.ab", req);
  }
}

/** `@All` declared before `@Get` on one path: Express runs the first declared. */
@Controller("ag")
export class AllGetController {
  @All()
  @Header("x-h", "ag.all")
  all(@Req() req: AnyReq) {
    return answer("ag.all", req);
  }

  @Get()
  @Header("x-h", "ag.get")
  get(@Req() req: AnyReq) {
    return answer("ag.get", req);
  }
}

@Module({ controllers: [SpecController, AllGetController] })
export class SpecModule {}

@Controller()
export class DupOneController {
  @Get("dupx")
  @Header("x-h", "dup.one")
  one(@Req() req: AnyReq) {
    return answer("dup.one", req);
  }
}

@Controller()
export class DupTwoController {
  @Get("dupx")
  @Header("x-h", "dup.two")
  two(@Req() req: AnyReq) {
    return answer("dup.two", req);
  }
}

@Module({ controllers: [DupOneController, DupTwoController, SpecController] })
export class DupModule {}
