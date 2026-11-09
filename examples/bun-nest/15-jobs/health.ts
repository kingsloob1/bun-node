/**
 * A terminus health check for the jobs backend, asserted:
 * `BunJobsHealthIndicator` and `BunJobsHealthModule` from
 * `@kingsleyweb/bun-nest/jobs/terminus`, behind a real `@nestjs/terminus`
 * `/health` route, called through `adapter.fetch()` (no port).
 *
 * ```bash
 * cd examples/bun-nest && bun 15-jobs/health.ts
 * ```
 *
 * `@nestjs/terminus` is an **optional peer** of bun-nest, which is why the
 * indicator has an entry of its own and `./jobs` never imports it. This
 * example needs it: where it does not resolve, the example prints a
 * `skipped:` line and exits 0 (`run-all.ts` counts that as passing). It
 * resolves from this repository's `node_modules` (a bun-nest devDependency).
 *
 * `isHealthy(key, options)` never rejects: anything that goes wrong is `down`.
 * Checked, with the endpoint's status as terminus gives it (200 or 503):
 *
 * - **Up**, with the queue's figures in the body.
 * - **Down when the backend's `ping` answers `false`**, with a message.
 * - **Down when `ping` throws, and the caller is told nothing of why**: the
 *   body holds none of the connection error (these endpoints are often
 *   public; the cause goes to Nest's logger).
 * - **Down within `timeout` on a hung `ping`.**
 * - **Down on a backlog** above `maxOutstanding`, and up at the limit.
 * - **`requireWorkers`**: down while a queue has demand and nothing in any
 *   process is serving it, up once this application's worker is.
 *
 * - **A worker parked on purpose is up**, listed in `parked`: `BunJobsLifecycle.stop()`
 *   is a decision, and a platform restarting the service for it would undo it.
 * - **`queues` left out means this application's queues**, so a probe does not
 *   read other services' queues on a shared backend; `queues: "all"` reads
 *   what the backend knows.
 *
 * Decorators on parameters need the working directory's `tsconfig.json`
 * (oven-sh/bun#28605): run this from `examples/bun-nest`.
 */
import type { BunQueue } from "@kingsleyweb/bun-jobs";
import type { BunJobsHealthIndicator as Indicator } from "@kingsleyweb/bun-nest/jobs/terminus";
import type { HealthCheckService as Checks } from "@nestjs/terminus";
import type { INestApplication } from "@nestjs/common";
import process from "node:process";
import { BunJobs, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  BunJobsLifecycle,
  BunJobsModule,
  getQueueToken,
  Process,
  Processor,
} from "@kingsleyweb/bun-nest/jobs";
import { Controller, Get, Inject, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import "reflect-metadata";

title("BunJobsHealthIndicator behind a terminus /health route");

// Skips visibly, as the optional peer may not be installed.
let terminus: typeof import("@nestjs/terminus");
let health: typeof import("@kingsleyweb/bun-nest/jobs/terminus");
try {
  terminus = await import("@nestjs/terminus");
  health = await import("@kingsleyweb/bun-nest/jobs/terminus");
} catch (error) {
  console.log(
    `skipped: @nestjs/terminus is not installed (${(error as Error).message})`,
  );
  process.exit(0);
}
const { HealthCheck, HealthCheckService } = terminus;
const { BunJobsHealthIndicator, BunJobsHealthModule } = health;

/** A memory driver whose `ping` does as told. */
class PingingDriver extends MemoryDriver {
  /** What `ping` does. */
  answer: () => Promise<boolean> = () => Promise.resolve(true);

  override async ping(): Promise<boolean> {
    return await this.answer();
  }
}

@Processor("emails")
class Emails {
  @Process()
  run() {
    return "sent";
  }
}

/** What `/health` passes to the indicator, set by each scenario. */
let checked: Parameters<Indicator["isHealthy"]>[1] = {};

@Controller("health")
class HealthController {
  constructor(
    @Inject(HealthCheckService)
    private readonly health: Checks,
    @Inject(BunJobsHealthIndicator)
    private readonly jobs: Indicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.jobs.isHealthy("jobs", checked)]);
  }
}

/** The endpoint's answer: terminus' 200 or 503, and its body. */
interface Answer {
  /** The HTTP status. */
  status: number;
  /** The body terminus wrote. */
  body: {
    status: string;
    info: Record<string, Record<string, unknown>>;
    error: Record<string, { message?: string }>;
  };
}

// An application with a worker on emails, a ping we control and /health.
const driver = new PingingDriver();

@Module({
  imports: [
    BunJobsModule.forRoot({
      namespace: `examples-nest-health-${crypto.randomUUID().slice(0, 8)}`,
      driver,
      logger: false,
      // So the worker's presence is shown, not assumed.
      autoStart: false,
      shutdown: { timeout: 500 },
    }),
    BunJobsModule.registerQueue({ name: "emails" }),
    BunJobsHealthModule,
  ],
  providers: [Emails],
  controllers: [HealthController],
})
class AppModule {}

const adapter = new BunHttpAdapter();
const app = (await NestFactory.create(AppModule, adapter, {
  logger: false,
  abortOnError: false,
})) as INestApplication;
await app.init();

/** Asks `/health` with these options. */
async function ask(options: typeof checked): Promise<Answer> {
  checked = options;
  const response = await adapter.fetch("/health");
  return {
    status: response.status,
    body: (await response.json()) as Answer["body"],
  };
}

try {
  const emails = app.get<BunQueue>(getQueueToken("emails"), { strict: false });
  const lifecycle = app.get(BunJobsLifecycle, { strict: false });

  step("Up, with the queue's figures");

  const up = await ask({ queues: ["emails"], maxOutstanding: 10 });
  show("the jobs entry of the body", up.body.info.jobs);
  checkEqual("200 and ok", [up.status, up.body.status], [200, "ok"]);
  check(
    "the queue's figures are in the answer",
    JSON.stringify(up.body.info.jobs).includes('"emails"'),
    up.body.info.jobs,
  );

  step("A backlog");

  await emails.add("a", {});
  await emails.add("b", {});
  checkEqual(
    "two waiting, limit two: up",
    (await ask({ queues: ["emails"], maxOutstanding: 2 })).status,
    200,
  );
  const backlog = await ask({ queues: ["emails"], maxOutstanding: 1 });
  checkEqual(
    "limit one: 503, naming the queue",
    [backlog.status, backlog.body.error.jobs?.message],
    [503, '"emails" has more than 1 jobs outstanding'],
  );

  step("requireWorkers: demand and nobody serving it");

  const noWorker = await ask({ queues: ["emails"], requireWorkers: true });
  checkEqual(
    "autoStart is off, so nothing serves the two jobs: 503",
    [noWorker.status, noWorker.body.error.jobs?.message],
    [503, '"emails" has demand and no live worker'],
  );
  check(
    "without requireWorkers the same state is not down",
    (await ask({ queues: ["emails"] })).status === 200,
  );

  await lifecycle.start();
  await waitFor(
    "the worker to drain the queue",
    async () => (await emails.getDemand()).outstanding === 0,
  );
  checkEqual(
    "with the worker started and the queue drained: up again",
    (await ask({ queues: ["emails"], requireWorkers: true, maxOutstanding: 0 }))
      .status,
    200,
  );

  step("A worker parked on purpose is up, and shown");

  await lifecycle.stop();
  const stopped = await ask({ queues: ["emails"] });
  checkEqual("BunJobsLifecycle.stop(): still 200", stopped.status, 200);
  check(
    "and `parked` lists the queue",
    JSON.stringify(stopped.body.info.jobs?.parked).includes("emails"),
    stopped.body.info.jobs,
  );
  await lifecycle.start();

  step("queues left out: this application's; \"all\": the backend's");

  // Another service's queue on the same backend, with a backlog.
  await app.get(BunJobs).queue("other-service").add("a", {});
  checkEqual(
    "with `queues` left out, the other service's backlog is not read: 200",
    (await ask({ maxOutstanding: 0 })).status,
    200,
  );
  const all = await ask({ queues: "all", maxOutstanding: 0 });
  checkEqual(
    'with `queues: "all"` it is: 503, naming it',
    [all.status, all.body.error.jobs?.message],
    [503, '"other-service" has more than 0 jobs outstanding'],
  );

  step("The backend itself");

  driver.answer = () => Promise.resolve(false);
  const unreachable = await ask({});
  checkEqual(
    "ping answers false: 503, with a message",
    [unreachable.status, unreachable.body.error.jobs?.message],
    [503, "The backend is unreachable"],
  );

  driver.answer = () =>
    Promise.reject(new Error("connect ECONNREFUSED 10.0.0.9:6379"));
  const thrown = await ask({});
  checkEqual("ping throws: 503", thrown.status, 503);
  check(
    "and the caller is told nothing of why",
    !JSON.stringify(thrown.body).includes("10.0.0.9"),
    thrown.body,
  );

  driver.answer = () => new Promise<boolean>(() => {});
  const startedAt = Date.now();
  const hung = await ask({ timeout: 100 });
  const took = Date.now() - startedAt;
  checkEqual("a hung ping: 503", hung.status, 503);
  check("within its timeout, not left waiting", took >= 90 && took < 900, took);

  driver.answer = () => Promise.resolve(true);
  checkEqual(
    "and up again when the backend answers",
    (await ask({})).status,
    200,
  );
} finally {
  await app.close();
}

summary();
