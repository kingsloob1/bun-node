/**
 * A Nest application booted cold in a process of its own (PR-S6, plan
 * §3.5): `SecurityModule` with a subclass of `SecurityGuard` as the global
 * guard, the shape that failed injection on ConcaveHR's first boots after a
 * deploy. Prints `RESULT=ok` with what it answered, or `RESULT=fail:<why>`.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { BunHttpAdapter } from "../../../lib/BunHttpAdapter";
import { SecurityGuard, SecurityModule } from "../../../lib/security/index";
import "reflect-metadata";

/** A guard subclass with no constructor of its own: injection rests on the parent's declared dependencies. */
@Injectable()
class AppSecurityGuard extends SecurityGuard {}

@Controller()
class AppController {
  @Get("x")
  x() {
    return "x";
  }
}

@Module({
  imports: [
    SecurityModule.forRoot({
      policy: {
        lists: [
          { ip: "203.0.113.66", action: "block" },
          { user: "mallory", action: "block" },
        ],
      },
      identify: (req: BunRequest) => {
        const user = req.request.headers.get("x-user");
        return user === null ? undefined : { user };
      },
      globalGuard: false,
      logger: () => {},
    }),
  ],
  controllers: [AppController],
  providers: [{ provide: APP_GUARD, useClass: AppSecurityGuard }],
})
class AppModule {}

try {
  const adapter = new BunHttpAdapter();
  const app = await NestFactory.create(AppModule, adapter, {
    logger: false,
    abortOnError: false,
  });
  await app.init();
  const statuses = [
    (await adapter.fetch("/x", { remoteAddress: "198.51.100.1" })).status,
    (await adapter.fetch("/x", { remoteAddress: "203.0.113.66" })).status,
    (await adapter.fetch("/x", { headers: { "x-user": "mallory" } })).status,
  ];
  await app.close();
  console.log(`RESULT=ok ${statuses.join(",")}`);
} catch (error) {
  console.log(
    `RESULT=fail:${error instanceof Error ? error.message : String(error)}`,
  );
}
