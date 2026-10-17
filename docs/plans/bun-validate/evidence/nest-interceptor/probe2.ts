import "reflect-metadata";
import { type CallHandler, Controller, type ExecutionContext, Injectable, Module, type NestInterceptor, Sse, UseInterceptors } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { interval, map as rxMap, of, take } from "rxjs";
import { map } from "rxjs/operators";
const MAJOR = Number((await import("@nestjs/core/package.json")).version.split(".")[0]);
@Injectable() class Bad implements NestInterceptor {
  intercept(_c: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(map((e: any) => { if (e.type === "bad") throw new Error("issue at data.n: secret-value"); return e; }));
  }
}
@Controller() @UseInterceptors(Bad)
class C {
  @Sse("sync-first") a() { return of({ type: "bad", data: 1 }); }
  @Sse("async-second") b() { return interval(5).pipe(take(2), rxMap((i) => ({ type: i ? "bad" : "ok", data: i }))); }
  @Sse("untyped") c() { return of({ data: { x: 1 } }); }
}
@Module({ controllers: [C] }) class M {}
for (const kind of ["express", "bun"] as const) {
  const app = await NestFactory.create(M, (kind === "express" ? new ExpressAdapter() : new BunHttpAdapter()) as any, { logger: false });
  await app.listen(0, "127.0.0.1");
  const url = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  for (const p of ["/sync-first", "/async-second", "/untyped"]) {
    const r = await fetch(url + p); const t = await r.text();
    console.log(MAJOR, kind, p, r.status, r.headers.get("content-type"), JSON.stringify(t.slice(0, 200)));
  }
  await app.close();
}
process.exit(0);
