import type { INestApplication } from "@nestjs/common";
/**
 * The bun-jobs management UI in a NestJS application: `jobsUi()` from
 * `@kingsleyweb/bun-jobs-ui`, mounted beside `BunJobsApiModule` on bun-nest's
 * `BunHttpAdapter`.
 *
 * ```bash
 * bun 06-jobs-ui/mount.ts
 * ```
 *
 * There is no Nest module for the UI: it is a bun-common router, and it is
 * mounted on the adapter the same way the jobs API module mounts the API.
 *
 * Worth knowing:
 *
 * - **Hand the UI the API the module built.** `app.get(BUN_JOBS_API)` answers
 *   with the `JobsApi` once `NestFactory.create` has resolved; `jobsUi({ api })`
 *   then reads its basePath, socket and docs paths.
 * - **Mount it with `adapter.use(ui.basePath, ui.router)`.** The adapter's
 *   `use()` takes a bun-common router as it takes middleware, with no cast —
 *   the same way `BunJobsApiModule` mounts the API.
 * - **Below Nest's pipeline.** Like the API, the UI's routes are not
 *   controllers: Nest guards, interceptors and `setGlobalPrefix` do not apply.
 *   Guard the page with the UI's `authorize`; the data stays guarded by the
 *   API's.
 * - **Mount before `listen()`** (or `init()`), like any adapter middleware.
 */
import { BunJobs, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { BUN_JOBS_API, BunJobsApiModule } from "@kingsleyweb/bun-nest/jobs";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import "reflect-metadata";

title("The jobs UI in a NestJS application");

/** The signed-in operator's session cookie; anything else may not open the UI. */
const SESSION = "session=operator";

/* ------------------------------------------------------------------ */
step("A jobs context, the API module and a controller of the app's own");

const jobs = new BunJobs({
  namespace: "examples-nest-ui",
  driver: new MemoryDriver(),
  publishEvents: true,
});
await jobs.queue("emails").add("welcome", { to: "ada@example.com" });

@Controller("health")
class HealthController {
  /** A route of the application's own, beside the UI and the API. */
  @Get()
  health() {
    return { ok: true };
  }
}

@Module({
  imports: [
    BunJobsApiModule.forRoot({
      jobs,
      basePath: "/admin/jobs-api",
      authorize: (req) =>
        req.getHeader("cookie")?.includes(SESSION) === true
          ? true
          : { allow: false, status: 401 },
      // This example is about the page; 05-jobs-api and bun-jobs' examples
      // cover the live-events socket.
      websocket: false,
    }),
  ],
  controllers: [HealthController],
})
class AppModule {}

const adapter = new BunHttpAdapter();
const app = (await NestFactory.create(AppModule, adapter, {
  logger: false,
})) as INestApplication;
// A global prefix applies to controllers only, not to what is mounted on
// the adapter — the UI and the API keep their own basePaths.
app.setGlobalPrefix("v1");

/* ------------------------------------------------------------------ */
step("jobsUi() over the API the module built, mounted with adapter.use");

const ui = jobsUi({
  api: app.get(BUN_JOBS_API),
  basePath: "/admin/jobs",
  title: "Operations",
  // The same session the API checks; a signed-out visitor gets a 401 problem
  // instead of the page. The bundle is public: it holds no data.
  authorize: (req, { asset }) =>
    asset || req.getHeader("cookie")?.includes(SESSION) === true
      ? true
      : { allow: false, status: 401, reason: "Sign in to open the jobs UI" },
});
show("ui.config", ui.config);

// `ui.router` is a bun-common `BunRouter`; the adapter's `use()` mounts it
// under `ui.basePath` like any sub-router.
adapter.use(ui.basePath, ui.router);

await app.listen(0);
const url = (await app.getUrl()).replace("[::1]", "localhost");
show("open", `${url}${ui.basePath}`);

/* ------------------------------------------------------------------ */
step("Requests, over the socket");

const signedIn = { headers: { cookie: SESSION } };

const page = await fetch(`${url}/admin/jobs/queues`, signedIn);
const html = await page.text();
checkEqual(
  "the shell, for a signed-in operator",
  [page.status, page.headers.get("content-type")],
  [200, "text/html; charset=utf-8"],
);
check("titled Operations", html.includes("<title>Operations</title>"));

const src = /<script type="module" src="([^"]+)"/.exec(html)![1]!;
const bundle = await fetch(`${url}${src}`);
await bundle.arrayBuffer();
checkEqual(
  "the bundle, cookie or not",
  [bundle.status, bundle.headers.get("content-type")],
  [200, "text/javascript; charset=utf-8"],
);

const anonymous = await fetch(`${url}/admin/jobs`);
const problem = (await anonymous.json()) as { code: string; detail: string };
checkEqual(
  "signed out: a 401 problem, not the page",
  [anonymous.status, problem.code, problem.detail],
  [401, "UNAUTHORIZED", "Sign in to open the jobs UI"],
);

const queues = await fetch(`${url}/admin/jobs-api/queues`, signedIn);
checkEqual("the API beside it answers", queues.status, 200);
await queues.arrayBuffer();

const health = await fetch(`${url}/v1/health`);
checkEqual("and so do the app's controllers", await health.json(), {
  ok: true,
});

await app.close();

/* ------------------------------------------------------------------ */
step("The same mount, without a socket");

const second = new BunHttpAdapter();
const secondApp = (await NestFactory.create(AppModule, second, {
  logger: false,
})) as INestApplication;
const secondUi = jobsUi({ api: secondApp.get(BUN_JOBS_API), basePath: "/ops" });
second.use(secondUi.basePath, secondUi.router);
await secondApp.init();

// `fetch()` runs the adapter's real pipeline with no socket bound.
const socketFree = await second.fetch("/ops/runners");
await socketFree.arrayBuffer();
checkEqual(
  "adapter.fetch(): the shell, with no port bound",
  [socketFree.status, socketFree.headers.get("content-type")],
  [200, "text/html; charset=utf-8"],
);

await secondApp.close();
await jobs.close();

summary();
