/**
 * Q: Can a Nest app's controllers become the SAME route model as a BunRouter
 * app, at runtime, with DiscoveryService and metadata only (no TS transformer),
 * on bun-nest's adapter? And can a dev-only, guarded endpoint serve it?
 *
 * Run from THIS directory (oven-sh/bun#28605): cd …/typed-client/nest && bun explore.ts
 */
import "reflect-metadata";
import type { CanActivate, DynamicModule, ExecutionContext } from "@nestjs/common";
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common/lib/types/standardSchema.ts";
import type { JsonSchema, ModelRoute, RouteModel } from "../codegen/describe";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { Body, Controller, Get, Headers, HttpCode, Injectable, Module, Param, Post, Query, RequestMethod, Res, SetMetadata, UseGuards } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ApplicationConfig, DiscoveryModule, DiscoveryService, MetadataScanner, NestFactory, Reflector } from "@nestjs/core";
import { z } from "zod";
import { canonical, keysInValuesOut, operationIdFor, toJson } from "../codegen/describe";
import { emitRoutes } from "../codegen/emit-dts";

// ---------- what a route author writes ----------
const TYPED_ROUTE = "bun:typed-route";
interface TypedRouteOptions {
  params?: StandardSchemaV1; query?: StandardSchemaV1; body?: StandardSchemaV1;
  responses: Record<number, StandardSchemaV1 | null>;
}
type Out<R> = { [K in keyof R]: R[K] extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<R[K]> : undefined }[keyof R];
/** Records the schemas for the explorer AND constrains the method's return type (api-docs-generation §3.8.3). */
function TypedRoute<const R extends Record<number, StandardSchemaV1 | null>>(options: TypedRouteOptions & { responses: R }) {
  return <T extends (...args: never[]) => Out<R> | Promise<Out<R>>>(target: object, key: string | symbol, descriptor: TypedPropertyDescriptor<T>) => {
    SetMetadata(TYPED_ROUTE, options)(target, key, descriptor);
  };
}

const User = z.object({ id: z.string(), name: z.string(), email: z.email() });
const Problem = z.object({ type: z.string(), title: z.string(), status: z.number() });

@Controller("users")
class UsersController {
  @Get(":id")
  @TypedRoute({ params: z.object({ id: z.string() }), responses: { 200: User, 404: Problem } })
  one(@Param("id") id: string) {
    return { id, name: "Ada", email: "ada@example.com" };
  }

  @Get()
  @TypedRoute({ query: z.object({ page: z.coerce.number().int().default(1) }), responses: { 200: z.array(User) } })
  list(@Query("page") _page: number) {
    return [];
  }

  @Post()
  @HttpCode(201)
  @TypedRoute({ body: z.object({ name: z.string(), email: z.email() }), responses: { 201: User } })
  create(@Body() body: { name: string; email: string }) {
    return { id: "1", ...body };
  }

  @Get("untyped/legacy")
  legacy() {
    return { ok: true };
  }
}

// A controller documented only with @nestjs/swagger-shaped metadata: the key
// and value shape @ApiResponse writes ('swagger/apiResponse'), set by hand here
// because installing @nestjs/swagger beside the root's Nest would duplicate @nestjs/core.
@Controller("health")
class HealthController {
  @Get()
  ok() {
    return { ok: true };
  }
}
Reflect.defineMetadata("swagger/apiResponse", { 200: { description: "OK", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } }, HealthController.prototype.ok);

// ---------- the explorer ----------
const VERB: Record<number, string> = { [RequestMethod.GET]: "GET", [RequestMethod.POST]: "POST", [RequestMethod.PUT]: "PUT", [RequestMethod.DELETE]: "DELETE", [RequestMethod.PATCH]: "PATCH", [RequestMethod.ALL]: "ALL" };
const join = (...parts: (string | undefined)[]) => `/${parts.flatMap(p => (p ?? "").split("/")).filter(Boolean).join("/")}`;

@Injectable()
class TypedRoutesExplorer {
  constructor(private readonly discovery: DiscoveryService, private readonly scanner: MetadataScanner, private readonly reflector: Reflector, private readonly config: ApplicationConfig) {}
  explore(): RouteModel {
    const routes: ModelRoute[] = [];
    const prefix = this.config.getGlobalPrefix();
    for (const wrapper of this.discovery.getControllers()) {
      const proto = (wrapper.metatype as { prototype: object } | undefined)?.prototype;
      if (!proto) continue;
      const base = Reflect.getMetadata(PATH_METADATA, wrapper.metatype as object) as string;
      for (const name of this.scanner.getAllMethodNames(proto)) {
        const fn = (proto as Record<string, () => unknown>)[name]!;
        const sub = Reflect.getMetadata(PATH_METADATA, fn) as string | undefined;
        const verb = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
        if (sub === undefined || verb === undefined) continue;
        const method = VERB[verb]!;
        const path = join(prefix, base, sub);
        const warnings: string[] = [];
        const where = `${method} ${path}`;
        const request: ModelRoute["request"] = {};
        let responses: Record<string, JsonSchema | null> = {};
        const typed = this.reflector.get<TypedRouteOptions>(TYPED_ROUTE, fn);
        const swagger = Reflect.getMetadata("swagger/apiResponse", fn) as Record<string, { schema?: JsonSchema }> | undefined;
        if (typed) {
          if (typed.params) request.params = keysInValuesOut(typed.params, warnings, `${where} params`);
          if (typed.query) request.query = keysInValuesOut(typed.query, warnings, `${where} query`);
          if (typed.body) request.body = toJson(typed.body, "input", warnings, `${where} body`);
          for (const [st, s] of Object.entries(typed.responses)) responses[st] = s ? toJson(s, "output", warnings, `${where} ${st}`) : null;
        } else if (swagger) {
          responses = Object.fromEntries(Object.entries(swagger).map(([st, r]) => [st, r.schema ?? {}]));
          warnings.push("from @nestjs/swagger metadata: responses only");
        } else {
          warnings.push("no @TypedRoute or swagger metadata: untyped");
        }
        const params = [...path.matchAll(/:(\w+)/g)].map(m => m[1]!);
        routes.push({ key: `${method} ${path}`, method, path, params, operationId: `${(wrapper.metatype as { name: string }).name.replace(/Controller$/, "").toLowerCase()}.${name}` || operationIdFor(method, path), request, responses, warnings });
      }
    }
    routes.sort((a, b) => a.key.localeCompare(b.key));
    return { version: 1, hash: new Bun.CryptoHasher("sha256").update(canonical(routes)).digest("hex").slice(0, 16), routes };
  }
}

// ---------- the dev endpoint: a module that refuses production, a guard ----------
const TOKEN = crypto.randomUUID();
@Injectable()
class DevTypesGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ getHeader: (n: string) => string | undefined; ip?: string | null }>();
    return req.getHeader("authorization") === `Bearer ${TOKEN}`; // + loopback in the real thing
  }
}
@Controller("__bun/types")
@UseGuards(DevTypesGuard)
class DevTypesController {
  constructor(private readonly explorer: TypedRoutesExplorer) {}
  @Get()
  model(@Headers("if-none-match") inm: string | undefined, @Res({ passthrough: true }) res: { status: (n: number) => unknown; setHeader: (k: string, v: string) => unknown }) {
    const model = this.explorer.explore();
    res.setHeader("etag", `"${model.hash}"`);
    if (inm === `"${model.hash}"`) {
      res.status(304);
      return undefined;
    }
    return model;
  }
}
@Module({})
class DevTypesModule {
  static forRoot(options: { enabled: boolean }): DynamicModule {
    if (process.env.NODE_ENV === "production") throw new Error("DevTypesModule: refused under NODE_ENV=production");
    if (!options.enabled) return { module: DevTypesModule }; // nothing registered at all
    return { module: DevTypesModule, imports: [DiscoveryModule], controllers: [DevTypesController], providers: [TypedRoutesExplorer, DevTypesGuard], exports: [TypedRoutesExplorer] };
  }
}

@Module({ imports: [DevTypesModule.forRoot({ enabled: true })], controllers: [UsersController, HealthController] })
class AppModule {}

// ---------- run ----------
const adapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, adapter, { logger: false });
app.setGlobalPrefix("api");
await app.init();
const t0 = performance.now();
const model = app.get(TypedRoutesExplorer).explore();
const exploreMs = performance.now() - t0;
console.log(`explored ${model.routes.length} routes in ${exploreMs.toFixed(2)} ms, hash ${model.hash}`);
for (const r of model.routes) console.log(`  ${r.key.padEnd(34)} ${r.operationId.padEnd(18)} ${r.warnings.join("; ")}`);

// cross-check against what the adapter actually registered
const registered = new Set(adapter.getInstance().routes().filter(r => r.path).map(r => `${(r.method ?? "ALL").toUpperCase()} ${r.path}`));
const missing = model.routes.filter(r => !registered.has(r.key)).map(r => r.key);
console.log(`registered on the adapter: ${registered.size}; explored keys missing from it: ${missing.length ? missing.join(", ") : "none"}`);

await Bun.write(new URL("./nest-routes.gen.ts", import.meta.url), emitRoutes(model));

// the dev endpoint, through the adapter (no socket)
const noToken = await adapter.fetch("/api/__bun/types");
const withToken = await adapter.fetch("/api/__bun/types", { headers: { authorization: `Bearer ${TOKEN}` } });
const etag = withToken.headers.get("etag");
const again = await adapter.fetch("/api/__bun/types", { headers: { authorization: `Bearer ${TOKEN}`, "if-none-match": etag ?? "" } });
console.log(`dev endpoint: no token ${noToken.status}, token ${withToken.status} (etag ${etag}), if-none-match ${again.status}`);
const prod = Bun.spawnSync(["bun", "-e", `process.env.NODE_ENV="production"; try { (${DevTypesModule.forRoot.toString().replace(/^forRoot/, "function")})({ enabled: true }); console.log("STARTED") } catch (e) { console.log("REFUSED:", e.message) }`]);
console.log(`production: ${prod.stdout.toString().trim()}`);
await app.close();
