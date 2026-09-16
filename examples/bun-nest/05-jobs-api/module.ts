import type { JobsApi } from "@kingsleyweb/bun-nest/jobs";
/**
 * The bun-jobs management API as a NestJS module: mount it, inject it, call it
 * with credentials, shut it down.
 *
 * ```bash
 * bun 05-jobs-api/module.ts
 * ```
 *
 * `BunJobsApiModule.forRoot(...)` from `@kingsleyweb/bun-nest/jobs` mounts
 * `@kingsleyweb/bun-jobs`'s management API — queues, jobs, runners, an OpenAPI
 * document and a live-events socket — under a prefix of your choosing. The
 * module is on its own entry point, never the package barrel, because using it
 * requires `@kingsleyweb/bun-jobs` installed and most Nest applications have no
 * jobs at all.
 *
 * Worth knowing:
 *
 * - **`authorize` is the gate, not Nest's guards.** These routes are mounted on
 *   the adapter's router, below Nest's pipeline, so guards, pipes and
 *   interceptors do not run for them and `setGlobalPrefix` does not apply.
 *   `authorize` is called once per request with the action being attempted, and
 *   it is required — `createJobsApi` throws without it.
 * - **`@InjectJobsApi()`** hands any provider the built `JobsApi`: its
 *   `routes`, `openapi()`, `mode` and the live `websocket.sessions` count.
 * - **`app.close()` closes the API too**, in `beforeApplicationShutdown` — while
 *   the HTTP server is still up, so any live-events client is told `1001`
 *   "going away" rather than seeing the socket vanish. It never closes the
 *   `BunJobs` context you passed in; that stays yours.
 * - The memory driver keeps everything in this process, so the example needs no
 *   database.
 */
import { BunJobs, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { BunJobsApiModule, InjectJobsApi } from "@kingsleyweb/bun-nest/jobs";
import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { show, step, title } from "../shared/console";
import "reflect-metadata";

/** Who may do what, decided from the bearer token a request carries. */
const TOKENS: Record<string, "reader" | "admin"> = {
  "read-only-token": "reader",
  "admin-token": "admin",
};

title("The jobs management API as a NestJS module");

/* ------------------------------------------------------------------ */
step("A jobs context with some work in it");

const jobs = new BunJobs({
  namespace: "examples-nest-api",
  driver: new MemoryDriver(),
  publishEvents: true,
});

await jobs.queue("emails").add("welcome", { to: "ada@example.com" });
await jobs.queue("emails").add("receipt", { to: "grace@example.com" });
await jobs.queue("reports").add("nightly", { day: "monday" });
show("queues", await jobs.listQueues());

/* ------------------------------------------------------------------ */
step("A provider that injects the built JobsApi");

@Injectable()
class JobsAdminService {
  constructor(
    /** The API this module built, injected by its token. */
    @InjectJobsApi() private readonly api: JobsApi,
  ) {}

  /** A summary an operator page might show, read straight off the API. */
  summary() {
    return {
      basePath: this.api.basePath,
      mode: this.api.mode,
      routes: this.api.routes.length,
      liveSessions: this.api.websocket?.sessions ?? 0,
    };
  }
}

@Controller("ops")
class OpsController {
  constructor(private readonly admin: JobsAdminService) {}

  /** A route of the application's own, beside the mounted API. */
  @Get("jobs-api")
  describe() {
    return this.admin.summary();
  }
}

/* ------------------------------------------------------------------ */
step("Mount it with forRoot: a base path, and an authorize that means it");

@Module({
  imports: [
    BunJobsApiModule.forRoot({
      jobs,
      // The prefix the whole API lives under; it also forms the socket's path
      // and the URLs in the OpenAPI document.
      basePath: "/admin/jobs",
      authorize: (req, context) => {
        const header = req.getHeader("authorization") ?? "";
        const role = TOKENS[header.replace(/^Bearer /, "")];

        if (!role) {
          return { allow: false, status: 401, reason: "Sign in to continue" };
        }

        // Reads for everybody who signed in; changes for admins only.
        return context.mutation && role !== "admin"
          ? { allow: false, status: 403, reason: "Admins only" }
          : true;
      },
    }),
  ],
  controllers: [OpsController],
  providers: [JobsAdminService],
})
class AppModule {}

const adapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, adapter, {
  logger: false,
  abortOnError: false,
});
await app.listen(0);
const url = await app.getUrl();
show("listening on", url);

/** Calls the API with a token, answering with the status and the JSON body. */
async function call(path: string, token?: string, init?: RequestInit) {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  return { status: response.status, body: await response.json() };
}

/* ------------------------------------------------------------------ */
step("Without credentials: authorize answers before any handler runs");
show("GET /admin/jobs/meta (no token)", await call("/admin/jobs/meta"));

/* ------------------------------------------------------------------ */
step("With a reader's token: the read routes answer");
show("GET /admin/jobs/meta", await call("/admin/jobs/meta", "read-only-token"));
show(
  "GET /admin/jobs/queues",
  await call("/admin/jobs/queues", "read-only-token"),
);
show(
  "GET /admin/jobs/queues/emails/counts",
  await call("/admin/jobs/queues/emails/counts", "read-only-token"),
);

/* ------------------------------------------------------------------ */
step("A change, which the same token may not make");
const paused = await call(
  "/admin/jobs/queues/emails/pause",
  "read-only-token",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
  },
);
show("POST …/queues/emails/pause as a reader", paused);

const pausedAsAdmin = await call(
  "/admin/jobs/queues/emails/pause",
  "admin-token",
  { method: "POST", headers: { "content-type": "application/json" } },
);
show("POST …/queues/emails/pause as an admin", pausedAsAdmin);
show("the queue is paused", await jobs.queue("emails").isPaused());

/* ------------------------------------------------------------------ */
step("The application's own routes are untouched by the mount");
show("GET /ops/jobs-api", await call("/ops/jobs-api"));
show("GET /nowhere", (await call("/nowhere")).status);

/* ------------------------------------------------------------------ */
step("Close: the module closes the API, the context stays yours");
await app.close();
show("app closed");

await jobs.queue("emails").add("still-usable", { to: "hopper@example.com" });
show("the BunJobs context still works", await jobs.listQueues());
await jobs.close();
show("context closed");
