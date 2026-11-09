/**
 * Request-scoped processors, asserted: `scope: Scope.REQUEST` gives each job a
 * fresh instance with `REQUEST` being the job, and a durable
 * `ContextIdStrategy` can share one tree per tenant.
 *
 * ```bash
 * cd examples/bun-nest && bun 15-jobs/request-scope.ts
 * ```
 *
 * With `scope: Scope.REQUEST` on `@Processor`, or a dependency on a
 * request-scoped provider, each job resolves a new instance through Nest's
 * public `ModuleRef.resolve`, at a cost the package README measures in tens of
 * microseconds per job (not measured here). What is checked:
 *
 * - **A fresh instance per job**, and what `@Inject(REQUEST)` gives it is the
 *   **job** itself, `isBunJob(request)` true. Nothing is written on the job.
 * - **A singleton that depends on a request-scoped provider is per job too**
 *   (scope bubbles up, as in an HTTP app).
 * - **A durable strategy**, the multi-tenant recipe. A `ContextIdStrategy` is
 *   global and receives the job where it receives an HTTP request elsewhere,
 *   so one that reads `request.headers` must handle a job: `isBunJob(value)`
 *   tells them apart. Here a tenant's jobs share one `Tenant` instance. The
 *   control comes first: with no strategy, three jobs build three `Tenant`s;
 *   with it, three jobs of two tenants build two.
 *
 * A request-scoped processor gets no lifecycle hook, so its worker drains last,
 * when the jobs module closes (see the package README, "starting and
 * draining"). The strategy is process-global, so the example removes it.
 *
 * Decorators on parameters need the working directory's `tsconfig.json`
 * (oven-sh/bun#28605): run this from `examples/bun-nest`.
 */
import type { BunQueue, Job } from "@kingsleyweb/bun-jobs";
import type { ContextIdStrategy, HostComponentInfo } from "@nestjs/core";
import type { INestApplicationContext } from "@nestjs/common";
import {
  BunJobsModule,
  getQueueToken,
  isBunJob,
  Process,
  Processor,
} from "@kingsleyweb/bun-nest/jobs";
import { Inject, Injectable, Module, Scope } from "@nestjs/common";
import { ContextIdFactory, NestFactory, REQUEST } from "@nestjs/core";
import { check, checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";
import { watchQueue } from "./helpers/outcomes";
import "reflect-metadata";

/** Every instance a scenario's processors were built as, to count them. */
const instances = new Set<unknown>();

/** A processor per job: `REQUEST` is the job. */
@Processor("scoped", { scope: Scope.REQUEST })
class Scoped {
  constructor(@Inject(REQUEST) readonly request: unknown) {}

  @Process()
  run(job: Job) {
    instances.add(this);
    return this.request === job && isBunJob(this.request);
  }
}

/** Request-scoped itself: a singleton that needs it is per job too. */
@Injectable({ scope: Scope.REQUEST })
class PerJob {
  constructor(@Inject(REQUEST) readonly job: Job) {}
}

@Processor("bubbled")
class Bubbled {
  constructor(private readonly perJob: PerJob) {}

  @Process()
  run(job: Job) {
    instances.add(this);
    return this.perJob.job === job;
  }
}

/** How many `Tenant`s were built, so a durable tree is provably shared. */
const tenantsBuilt: Tenant[] = [];

/** A durable provider: one instance per tenant, once a strategy says so. */
@Injectable({ scope: Scope.REQUEST, durable: true })
class Tenant {
  constructor() {
    tenantsBuilt.push(this);
  }
}

@Processor("tenants", { scope: Scope.REQUEST })
class ByTenant {
  constructor(private readonly tenant: Tenant) {}

  @Process()
  run() {
    return tenantsBuilt.indexOf(this.tenant);
  }
}

/** An application with all three processors. */
function boot(): Promise<INestApplicationContext> {
  @Module({
    imports: [
      BunJobsModule.forRoot({
        namespace: `examples-nest-scope-${crypto.randomUUID().slice(0, 8)}`,
        driver: { type: "memory" },
        logger: false,
      }),
      BunJobsModule.registerQueue(
        { name: "scoped" },
        { name: "bubbled" },
        { name: "tenants" },
      ),
    ],
    providers: [Scoped, PerJob, Bubbled, Tenant, ByTenant],
  })
  class AppModule {}
  return NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
}

title("Request-scoped processors");

/* ------------------------------------------------------------------ */
step("A fresh instance per job, and REQUEST is the job");

{
  const app = await boot();
  try {
    const queue = app.get<BunQueue>(getQueueToken("scoped"), { strict: false });
    const watcher = watchQueue(app, "scoped");
    const added = await Promise.all([1, 2, 3].map(() => queue.add("x", {})));
    const outcomes = await Promise.all(
      added.map((job) => watcher.outcome(job.id)),
    );
    checkEqual(
      "each job's REQUEST was that job (isBunJob)",
      outcomes.map((outcome) => outcome.result),
      [true, true, true],
    );
    checkEqual("three jobs, three instances", instances.size, 3);
    instances.clear();

    const bubbled = app.get<BunQueue>(getQueueToken("bubbled"), {
      strict: false,
    });
    const bubbledWatcher = watchQueue(app, "bubbled");
    const one = await bubbled.add("x", {});
    const two = await bubbled.add("x", {});
    checkEqual(
      "a singleton processor needing a request-scoped provider sees that job's",
      [
        (await bubbledWatcher.outcome(one.id)).result,
        (await bubbledWatcher.outcome(two.id)).result,
      ],
      [true, true],
    );
    checkEqual("and is per job: two jobs, two instances", instances.size, 2);
    check("isBunJob refuses what is not a job", !isBunJob({ data: {} }));
  } finally {
    await app.close();
  }
}

/* ------------------------------------------------------------------ */
step("Durable tenants: the control, then the strategy");

/** Adds one job per tenant name and waits for all, answering their results. */
async function runTenants(
  app: INestApplicationContext,
  tenants: string[],
): Promise<unknown[]> {
  const queue = app.get<BunQueue>(getQueueToken("tenants"), { strict: false });
  const watcher = watchQueue(app, "tenants");
  const added = [];
  for (const tenant of tenants) added.push(await queue.add("x", { tenant }));
  return (await Promise.all(added.map((job) => watcher.outcome(job.id)))).map(
    (outcome) => outcome.result,
  );
}

{
  // The control: no strategy, so a durable provider is built per job anyway.
  const app = await boot();
  try {
    tenantsBuilt.length = 0;
    await runTenants(app, ["a", "a", "b"]);
    checkEqual(
      "without a strategy, three jobs build three Tenants",
      tenantsBuilt.length,
      3,
    );
  } finally {
    await app.close();
  }
}

{
  const durableByTenant = new Map<
    string,
    ReturnType<typeof ContextIdFactory.create>
  >();
  const seen: unknown[] = [];
  const strategy: ContextIdStrategy = {
    attach(contextId, request) {
      seen.push(request);
      // A job carries its tenant in its data; an HTTP request in a header.
      const tenant = isBunJob<{ tenant: string }>(request)
        ? request.data.tenant
        : "http";
      let durable = durableByTenant.get(tenant);
      if (durable === undefined) {
        durable = ContextIdFactory.create();
        durableByTenant.set(tenant, durable);
      }
      return (info: HostComponentInfo) =>
        info.isTreeDurable ? durable : contextId;
    },
  };
  ContextIdFactory.apply(strategy);
  const app = await boot();
  try {
    tenantsBuilt.length = 0;
    const results = await runTenants(app, ["a", "a", "b"]);
    check(
      "the strategy was handed jobs",
      seen.length === 3 && seen.every((value) => isBunJob(value)),
      seen,
    );
    checkEqual(
      "with it, three jobs of two tenants build two Tenants",
      tenantsBuilt.length,
      2,
    );
    check(
      "tenant a's two jobs shared one; tenant b's did not",
      results[0] === results[1] && results[2] !== results[0],
      results,
    );
  } finally {
    // The strategy is process-global: put the default back.
    ContextIdFactory.apply({ attach: () => undefined });
    await app.close();
  }
}

summary();
