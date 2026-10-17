import "reflect-metadata";
import {
  type ArgumentMetadata,
  type CallHandler,
  Controller,
  type ExecutionContext,
  Get,
  Header,
  HttpCode,
  Injectable,
  type MessageEvent,
  Module,
  type NestInterceptor,
  type PipeTransform,
  Post,
  Redirect,
  Res,
  Sse,
  UseInterceptors,
  UsePipes,
} from "@nestjs/common";
import * as common from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { NestFactory, Reflector } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { z } from "zod";
import { interval, map as rxMap, take } from "rxjs";
import { map, tap } from "rxjs/operators";

const MAJOR = Number((await import("@nestjs/core/package.json")).version.split(".")[0]);
const c = common as Record<string, any>;
const log: Record<string, unknown[]> = {};
const push = (k: string, v: unknown) => (log[k] ??= []).push(v);

function snap(res: any) {
  const h = typeof res.getHeaders === "function" ? res.getHeaders() : {};
  const pick: Record<string, unknown> = {};
  for (const k of ["x-a", "x-b", "location", "content-type"]) if (h[k] !== undefined) pick[k] = h[k];
  return { status: res.statusCode, headers: pick, headersSent: !!res.headersSent };
}

@Injectable()
class Probe implements NestInterceptor {
  constructor(private readonly tag = "probe") {}
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const res = ctx.switchToHttp().getResponse();
    const key = `${ctx.getHandler().name}`;
    push(key, { at: `${this.tag}:before`, ...snap(res) });
    return next.handle().pipe(map((v) => {
      push(key, { at: `${this.tag}:map`, value: v instanceof c.StreamableFile ? "StreamableFile" : v, ...snap(res) });
      return v;
    }));
  }
}

@Injectable()
class OrderPipe implements PipeTransform {
  transform(v: unknown, m: ArgumentMetadata) {
    push("order", `pipe:${m.type}`);
    return v;
  }
}
@Injectable()
class OrderInterceptor implements NestInterceptor {
  intercept(_c: ExecutionContext, next: CallHandler) {
    push("order", "interceptor:before");
    return next.handle();
  }
}

const Out = z.object({ a: z.number() }).transform((o) => ({ ...o, serialized: true }));

@Controller()
@UseInterceptors(new Probe())
class C {
  @Get("get") get() { return { a: 1 }; }
  @Post("post") post() { return { a: 1 }; }
  @Get("code") @HttpCode(202) code() { return { a: 1 }; }
  @Get("hdr") @Header("x-a", "1") hdr() { return { a: 1 }; }
  @Get("redir") @Redirect("/x", 301) redir() { return { a: 1 }; }
  @Post("pass") pass(@Res({ passthrough: true }) res: any) { res.status(203); res.setHeader("x-b", "2"); return { a: 1 }; }
  @Get("plainres") plainres(@Res() res: any) { res.status(206); res.setHeader("x-b", "2"); res.json({ a: 1 }); return { ignored: true }; }
  @Get("file") file() { return new c.StreamableFile(Buffer.from("hi"), { type: "text/plain" }); }
  @Sse("sse") sse() {
    return interval(5).pipe(take(2), rxMap((i): MessageEvent => ({ type: i ? "done" : "tick", data: { i } })));
  }
  @Get("order") @UseInterceptors(OrderInterceptor) @UsePipes(OrderPipe) order(@c.Query() _q: unknown) { push("order", "handler"); return 1; }
}

// Nest 12 only: order vs StandardSchemaSerializerInterceptor, and RawBody({schema}).
const controllers: any[] = [C];
if (MAJOR >= 12) {
  const Ser = c.StandardSchemaSerializerInterceptor;
  const reflector = new Reflector();
  @Controller("ser")
  class S {
    @Get("probe-outer") @c.SerializeOptions({ schema: Out }) @UseInterceptors(new Probe("outer"), new Ser(reflector)) outer() { return { a: 1 }; }
    @Get("probe-inner") @c.SerializeOptions({ schema: Out }) @UseInterceptors(new Ser(reflector), new Probe("inner")) inner() { return { a: 1 }; }
    @Post("raw") raw(@c.RawBody({ schema: z.object({ never: z.literal(true) }) }) b: unknown) { return { got: String(b) }; }
    @Post("rawcustom") @UsePipes(new c.StandardSchemaValidationPipe({ validateCustomDecorators: true })) rawc(@c.RawBody({ schema: z.string().min(100) }) b: unknown) { return { got: String(b) }; }
    @Post("bodyschema-nopipe") nopipe(@c.Body({ schema: z.object({ n: z.number() }) }) b: unknown) { return { got: b }; }
    @Post("bodyprop") prop(@c.Query("page", { schema: z.string() }) _p: unknown, @c.Body({ schema: z.object({ n: z.number() }) }) _b: unknown) { return 1; }
  }
  controllers.push(S);
}

@Module({ controllers })
class M {}

async function run(kind: "express" | "bun") {
  for (const k of Object.keys(log)) delete log[k];
  const adapter = kind === "express" ? new ExpressAdapter() : new BunHttpAdapter();
  const app = await NestFactory.create(M, adapter as any, { logger: false, rawBody: true });
  await app.listen(0, "127.0.0.1");
  const url = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  const out: Record<string, unknown> = {};
  const call = async (method: string, p: string, body?: string) => {
    const r = await fetch(url + p, { method, redirect: "manual", body, headers: body ? { "content-type": "application/json" } : {} });
    const text = await r.text();
    return { status: r.status, xa: r.headers.get("x-a"), xb: r.headers.get("x-b"), loc: r.headers.get("location"), body: text.slice(0, 160) };
  };
  for (const [m, p] of [["GET", "/get"], ["POST", "/post"], ["GET", "/code"], ["GET", "/hdr"], ["GET", "/redir"], ["POST", "/pass"], ["GET", "/plainres"], ["GET", "/file"], ["GET", "/sse"], ["GET", "/order?x=1"]] as const) {
    out[p] = await call(m, p);
  }
  if (MAJOR >= 12) {
    out["/ser/probe-outer"] = await call("GET", "/ser/probe-outer");
    out["/ser/probe-inner"] = await call("GET", "/ser/probe-inner");
    out["/ser/raw"] = await call("POST", "/ser/raw", JSON.stringify({ a: 1 }));
    out["/ser/rawcustom"] = await call("POST", "/ser/rawcustom", JSON.stringify({ a: 1 }));
    out["/ser/bodyschema-nopipe"] = await call("POST", "/ser/bodyschema-nopipe", JSON.stringify({ n: "not-a-number" }));
    const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, controllers[1], "prop");
    out.routeArgsMeta = Object.fromEntries(Object.entries(meta).map(([k, v]: any) => [k, { index: v.index, data: v.data, hasSchema: !!v.schema, pipes: v.pipes.length }]));
  } else {
    const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, C, "pass");
    out.routeArgsMeta = meta;
  }
  await app.close();
  console.log(JSON.stringify({ major: MAJOR, kind, responses: out, interceptor: log }, null, 1));
}

await run("express");
await run("bun");
process.exit(0);
