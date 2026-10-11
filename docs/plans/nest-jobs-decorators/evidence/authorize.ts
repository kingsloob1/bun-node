/**
 * Q: Can an app's own Nest guards — built by DI, reading metadata through
 * Reflector — decide the management API's `authorize`, using only Nest's
 * public interfaces (no ExecutionContextHost deep import)?
 *
 * The API is mounted on bun-nest's adapter beside a controller. A role guard
 * reads `@Roles(...)` from a small policy class whose methods stand for
 * "read" and "mutate", and the request's `x-role` header.
 *
 * Run: bun authorize.ts
 */
import "reflect-metadata";
import type { CanActivate, ExecutionContext, Type } from "@nestjs/common";
import type { BunRequest } from "@kingsleyweb/bun-common";
import type { JobsApiAuthorize, JobsApiAuthorizeContext } from "@kingsleyweb/bun-jobs";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { Controller, Get, Inject, Injectable, Module } from "@nestjs/common";
import { ModuleRef, NestFactory, Reflector } from "@nestjs/core";

const Roles = Reflector.createDecorator<string[]>();

/** Stands in for the API's routes, so guards have a handler and a class to read. */
class JobsApiPolicy {
  @Roles(["reader", "admin"]) read() {}
  @Roles(["admin"]) mutate() {}
}

@Injectable()
class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.get(Roles, context.getHandler()) ?? [];
    const req = context.switchToHttp().getRequest<BunRequest>();
    return roles.includes(req.getHeader("x-role") ?? "");
  }
}

/** What `@kingsleyweb/bun-nest/jobs` could offer: guards as `authorize`, on public interfaces only. */
const API_CONTEXT = new WeakMap<object, JobsApiAuthorizeContext>();
export const jobsApiContextOf = (context: ExecutionContext) => API_CONTEXT.get(context.switchToHttp().getRequest());
function guardsAuthorize(moduleRef: ModuleRef, guards: Type<CanActivate>[]): JobsApiAuthorize {
  return async (req, apiContext) => {
    const policy = JobsApiPolicy.prototype;
    const handler = apiContext.mutation ? policy.mutate : policy.read;
    API_CONTEXT.set(req, apiContext);
    const args = [req, undefined, undefined];
    const context: ExecutionContext = {
      getType: <T extends string>() => "http" as T,
      getClass: <T>() => JobsApiPolicy as T,
      getHandler: () => handler,
      getArgs: <T extends unknown[]>() => args as T,
      getArgByIndex: <T>(i: number) => args[i] as T,
      switchToHttp: () => ({ getRequest: <T>() => req as T, getResponse: <T>() => undefined as T, getNext: <T>() => undefined as T }),
      switchToRpc: () => { throw new Error("not rpc"); },
      switchToWs: () => { throw new Error("not ws"); },
    };
    for (const guard of guards) {
      const instance = moduleRef.get(guard, { strict: false });
      if (!(await instance.canActivate(context))) return { allow: false, status: 403, reason: guard.name };
    }
    return true;
  };
}

const jobs = new BunJobs({ namespace: "nestjobs-authorize", driver: new MemoryDriver() });
await jobs.queue("emails").add("welcome", { to: "ada@example.com" });

@Controller("health")
class Health { @Get() ok() { return { ok: true }; } }

@Module({ controllers: [Health], providers: [RolesGuard] })
class AppModule {}

const adapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, adapter, { logger: false });
const api = createJobsApi({ jobs, basePath: "/admin/jobs", authorize: guardsAuthorize(app.get(ModuleRef), [RolesGuard]), websocket: false });
adapter.use(api.basePath, api.router);
await app.init();

for (const [method, path, role] of [
  ["GET", "/admin/jobs/queues", "reader"],
  ["GET", "/admin/jobs/queues", "nobody"],
  ["POST", "/admin/jobs/queues/emails/pause", "reader"],
  ["POST", "/admin/jobs/queues/emails/pause", "admin"],
  ["GET", "/health", "nobody"],
] as const) {
  const res = await adapter.fetch(path, { method, headers: { "x-role": role, "content-type": "application/json", origin: "http://localhost" }, ...(method === "POST" ? { body: "{}" } : {}) });
  const body = (await res.text()).slice(0, 90);
  console.log(`${method.padEnd(4)} ${path.padEnd(32)} x-role=${role.padEnd(6)} -> ${res.status} ${body}`);
}
console.log(`queue paused afterwards: ${await jobs.queue("emails").isPaused()}`);
await app.close();
await api.close();
await jobs.close();
