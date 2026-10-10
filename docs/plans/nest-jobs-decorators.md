# bun-jobs in NestJS: modules, decorators and the Nest pipeline for jobs

Implementation plan for integrating `@kingsleyweb/bun-jobs` into NestJS
through `@kingsleyweb/bun-nest`. The user asked for this on 2026-10-10:

> "a detailed plan on how to incorporate bun jobs with decorators for nest js.
> So a method in a service can be marked as a worker, helper injects to inject
> queues, etc. The plan should also look for ways to incorporate all of
> bun-jobs functionalities to nest js using decorators, guards, interceptors,
> pipelines, etc as the case maybe."

Written 2026-10-10 against `develop` at `bbe1120`. **No product code was
changed.** Every `file:line` is at `bbe1120`, relative to the repo root.
The evidence is in
[`evidence/nest-jobs-decorators/`](evidence/nest-jobs-decorators/README.md),
and every measurement there can be re-run with one command.
It includes a throwaway prototype (`proto.ts`), about 250 lines, that runs
the real Nest pipeline around real bun-jobs workers. The prototype is
evidence that the design works, not the design itself.

### Contents

1. [Executive summary](#1-executive-summary)
2. [What exists today](#2-what-exists-today)
3. [Module design and packaging](#3-module-design-and-packaging)
4. [Producers: injecting queues and the context](#4-producers-injecting-queues-and-the-context)
5. [Consumers: marking a method as a worker](#5-consumers-marking-a-method-as-a-worker)
6. [Events and the lifecycle](#6-events-and-the-lifecycle)
7. [The Nest pipeline around a job](#7-the-nest-pipeline-around-a-job)
8. [Scheduling](#8-scheduling)
9. [Every other bun-jobs feature](#9-every-other-bun-jobs-feature)
10. [Type safety](#10-type-safety)
11. [Back-compat, coexistence and migrating from `@nestjs/bullmq`](#11-back-compat-coexistence-and-migrating-from-nestjsbullmq)
12. [Tests and examples](#12-tests-and-examples)
13. [Risks](#13-risks)
14. [Open questions for the user](#14-open-questions-for-the-user)
15. [PR slicing and effort](#15-pr-slicing-and-effort)
16. [Names needing approval](#16-names-needing-approval)

### How to read the markings

These are the same marks the other plans use:

| Mark | Meaning |
|---|---|
| **[S]** | Read in this repo's source at `bbe1120`. The `file:line` is given |
| **[M]** | Measured here by a spike that can be re-run. The evidence file is named |
| **[V]** | Read on 2026-10-10 in a primary source: a packed npm tarball or the docs repo. Collected, with quotes and links, in [`evidence/nest-jobs-decorators/prior-art.md`](evidence/nest-jobs-decorators/prior-art.md) (**PA** below) |
| **[I]** | Inference. A claim to test, never a finding |
| **[U]** | Unverified. Nothing may rest on it |
| **[D]** | A design decision this plan proposes |

**ECC** is Nest's `ExternalContextCreator`. **GW** is
[`worker-gateway-and-isolation.md`](worker-gateway-and-isolation.md), **WR**
is [`worker-runtimes.md`](worker-runtimes.md), and **OT** is
[`opentelemetry.md`](opentelemetry.md).

---

## 1. Executive summary

### 1.1 The one-paragraph answer

**Yes: a method in a Nest service can be a bun-jobs worker, behind the
same guards, interceptors, pipes and filters as a controller.** Nest has a
supported seam for this: `ExternalContextCreator` (ECC). `@nestjs/graphql`
and `@golevelup/nestjs-rabbitmq` run their handlers through it, and
`@nestjs/bullmq` does not [V, PA §1, §7].

The prototype measured it [M, `results-pipeline.txt`]. Around a bun-jobs
handler, under a context type of our own, `"bun-jobs"`, all of these ran:

- a guard reading `Reflector` metadata;
- a pipe validating `@JobData()` against a Standard Schema;
- an interceptor timing the job;
- a filter turning a validation failure into `UnrecoverableJobError`;
- a user's own `createParamDecorator`;
- the app's `APP_GUARD` and `useGlobalInterceptors`.

The cost over a plain bun-jobs worker was 0 to 3 µs per job
[M, `results-scoped.txt`].

The plan has four layers, all on bun-nest's existing `./jobs` subpath, so
an app without bun-jobs still compiles none of it:

1. **`BunJobsModule`**: `forRoot`, `forRootAsync` and `registerQueue`. It
   owns one `BunJobs` context, or borrows one.
2. **Producers**: `@InjectQueue(name)` and `@InjectBunJobs()`. A typed queue
   token is a named abstract class extending `BunQueue`, which is the
   injection token and the type at once.
3. **Consumers**: `@Processor(queue, options)` on a class and `@Process(name?)`
   on its methods. Each queue gets one bun-jobs worker that dispatches on
   `job.name` to those methods, with parameter decorators (`@JobData()`, `@JobId()`,
   `@CurrentJob()`, `@JobSignal()`, `@JobProgress()`, …).
4. **Everything around them**:
   - lifecycle events: `@OnWorkerEvent`, `@OnQueueEvent`, `@OnJobsEvent`;
   - cluster-wide scheduling on repeat jobs: `@Cron`, `@Every`;
   - the management API's `authorize` decided by Nest guards;
   - a UI module;
   - summoned-worker and remote-executor helpers;
   - a terminus health indicator;
   - a testing module.

### 1.2 The decisions

| # | Decision | Why |
|---|---|---|
| D1 | **One worker per queue, dispatching on `job.name` to the `@Process(name)` methods of the `@Processor` classes on that queue.** No method-level workers. | A bun-jobs worker claims **every** job on its queue, whatever its name: `BunQueueWorkerOptions` has no name filter (`packages/bun-jobs/lib/queue/types.ts:914`) [S]. `BunJobs.start()` fails a name it has no handler for (`packages/bun-jobs/lib/BunJobs.ts:1162-1173`) [S]. So one worker per method would claim the other methods' jobs and fail them. `@nestjs/bull` had a worker per method, and `@nestjs/bullmq` dropped that because "it caused confusion" [V, PA §2]. §5.1 |
| D2 | **Handlers run through ECC under the context type `"bun-jobs"`**, with parameters stored under Nest's own `ROUTE_ARGS_METADATA`. | It is the seam Nest's maintainer points library authors to (nestjs/nest#9017) [V, PA §9], and it has been unchanged since v6.2, including in Nest 12 [V]. Using Nest's own metadata key is what lets a user's `createParamDecorator` work on a job, measured [M]. §7.1 |
| D3 | **Workers start in `onApplicationBootstrap`.** Each processor's worker drains **in its own instance's `onModuleDestroy`**, with a fallback drain in the jobs module. | `onApplicationBootstrap` comes after every `onModuleInit`, so connections opened there are ready. bullmq starts workers inside `onModuleInit` [V, PA §1]. Of eight measured drain points, only the per-instance one let a job in flight finish against a service in an imported or global module [M, `results-lifecycle.txt`]. §6.3 |
| D4 | **Global enhancers apply to jobs, as Nest applies them to microservices and GraphQL.** The docs give the `getType()` idiom. | ECC copies `APP_GUARD` and `useGlobal*` when a handler is built, and nothing public can exclude them [V, PA §7]; measured [M]. Fighting it would need Nest internals. §7.6 |
| D5 | **A guard's denial ends the job, with no retry**, as a `JobForbiddenError` that bun-jobs treats as unrecoverable. It can be configured per processor (Q4). | Measured, a denial is ECC's `ForbiddenException`, which bun-jobs retried until its attempts ran out [M]. A retry asks the same guard the same question. §7.5 |
| D6 | **A filter that returns a value completes the job with that value.** That is Nest's semantics, and it is documented loudly. A shipped `UnrecoverableOn(...)` filter covers the common mapping. | Measured [M]. Changing it would mean replacing Nest's exception proxy. §7.5 |
| D7 | **Request-scoped processors use only public API**: `ContextIdFactory.getByRequest(job)`, `registerRequestByContextId` and `moduleRef.resolve`, as `@nestjs/cqrs` does. `REQUEST` is the job. | bullmq does this through Nest's internal `Injector` [V, PA §1]. The public route measured about 35 to 80 µs per job extra [M]. §5.5 |
| D8 | **DI processors run in-process only.** Off-thread work stays a processor **file**, with a helper that builds a Nest context inside it. The per-attempt cost is stated: about 115 to 130 ms on top of bun-jobs' own ~135 ms. | A function cannot cross to another thread or process (`packages/bun-jobs/lib/queue/workerTarget.ts:551`) [S]. bun-jobs starts a fresh thread or process per attempt, so the whole Nest bootstrap is paid every time [M, `results-boot-cost.txt`]. §5.4 |
| D9 | **`@Cron` and `@Every` are bun-jobs repeat jobs: once per occurrence across every replica.** They coexist with `@nestjs/schedule` and do not replace it. | A repeat occurrence's id comes from the series key and its due time, so several producers schedule it once (README "Scheduling and repeatable jobs") [S]. `@nestjs/schedule` runs a timer in every replica [V, PA §3]. §8 |
| D10 | **Typed queues use a named abstract class token**: `@QueueToken("emails") export abstract class EmailsQueue extends BunQueue<Email, string, "welcome"> {}`. | It is the injection token and the type at once: a wrong payload or name is a compile error. A factory returning an anonymous class fails declaration emit with `TS4094` [M, `results-types.txt`]. §10 |
| D11 | **Everything ships on the existing `./jobs` subpath.** New subpaths only where a new optional peer starts: `./jobs-ui` (bun-jobs-ui) and `./jobs/terminus` (`@nestjs/terminus`). Plus `./jobs/testing`, so test helpers stay out of the production import graph. | `./jobs` already depends on bun-jobs alone, and `consumer-check.json`'s `peers` and the barrel-isolation test already guard it (`packages/bun-nest/consumer-check.json`, `__tests__/jobsApiBarrelIsolation.nest.test.ts`) [S]. §3.5 |
| D12 | **`BunJobsApiModule` is unchanged, and its `jobs` option becomes optional when `BunJobsModule` is imported.** Its `authorize` can be built from Nest guards with `guardsAuthorize([...])`. | That is additive. A guard decided `authorize` using only Nest's public `ExecutionContext` interface [M, `results-authorize.txt`]. §9.4 |

### 1.3 What it costs

| Part | Effort (bun-nest) | Other owners | Depends on |
|---|---|---|---|
| Core module and producers (PR-n1) | ~3 d | examples ~1 d | — |
| Consumers and lifecycle (PR-n2) | ~4 d | examples ~1 d | PR-n1 |
| The pipeline (PR-n3) | ~4 d | examples ~1 d | PR-n2 |
| Events (PR-n4) | ~2 d | — | PR-n2 |
| Scheduling and runners (PR-n5) | ~3 d | examples ~0.5 d | PR-n2 |
| API, guards as `authorize`, UI module (PR-n6) | ~2 d | UI review ~0.5 d | PR-n1 |
| Summoned, off-thread and remote helpers (PR-n7) | ~3 d | bun-jobs review | PR-n2 |
| Testing utilities (PR-n8) | ~2 d | — | PR-n3 |
| Terminus indicator (PR-n9) | ~1 d | — | PR-n1 |
| Playground (PR-n10) | ~1 d | UI review | PR-n3 |
| **Total** | **~25 d** | **~4.5 d** | |

§15 has the PRs. Nothing in bun-jobs needs to change for any of it. One
small addition elsewhere would help, and it is optional: a single-value
Standard Schema validation helper exported from bun-common (§7.4).

---

## 2. What exists today

### 2.1 bun-nest's `./jobs` subpath: the management API as a module

`@kingsleyweb/bun-nest/jobs` exports `BunJobsApiModule` (`forRoot`,
`forRootAsync`), `InjectJobsApi`, and the tokens `BUN_JOBS_API` and
`BUN_JOBS_API_OPTIONS` (`packages/bun-nest/lib/jobs/index.ts:220-239`) [S].
The module does not build a `BunJobs`: the app passes one, typically by
injecting a `BunJobs` that the app provides itself
(`packages/bun-nest/README.md`, "The jobs API module") [S]. Its
lifecycle hooks:

| Hook | What it does | Source |
|---|---|---|
| `onModuleInit` | mounts the router | `packages/bun-nest/lib/jobs/BunJobsApiModule.ts:165-168` [S] |
| `onApplicationBootstrap` | attaches the socket | `:171-181` [S] |
| `beforeApplicationShutdown` | closes the API, while the transport is still up | `:184-186` [S] |
| `onApplicationShutdown` | closes it again, harmlessly, for a host that skipped the earlier hook | `:189-191` [S] |

The reasons for each hook were measured when the module was built, and are
in its header comment (`:26-44`).

Packaging is the precedent this plan follows:

- bun-jobs is an **optional peer** (`packages/bun-nest/package.json`,
  `peerDependenciesMeta`) [S].
- Only the `./jobs` and `./lib/jobs` entries reach it [S].
- `consumer-check.json` marks those entries `"peers": ["@kingsleyweb/bun-jobs"]` [S].
- The build's `checkPeerScopes` fails if any other entry can reach a
  declaration that imports bun-jobs (CLAUDE.md, "Packaging types") [S].
- `jobsApiBarrelIsolation.nest.test.ts` proves at runtime that the barrel
  loads without bun-jobs [S].

`decorators.ts` re-exports Nest's own `UploadedFile` and `UploadedFiles`
(`packages/bun-nest/lib/decorators.ts:1`) [S]. `interceptors.ts` is the
multer-style upload interceptors [S]. Neither touches jobs.

### 2.2 bun-jobs' public surface, and where each part lands

`packages/bun-jobs/lib/index.ts` (998 lines) and the package README (7,939
lines) were read for this inventory [S]. Every user-facing feature is listed
below with the Nest surface this plan gives it, or the reason it needs none.

| bun-jobs feature | Where in bun-jobs [S] | Nest surface | § |
|---|---|---|---|
| `BunJobs`, the per-service context (namespace, driver, logger, defaults, `service`, `publishEvents`, `metrics`, `summon`, `workerControl`) | `lib/BunJobs.ts:322` | `BunJobsModule.forRoot/forRootAsync` options; `@InjectBunJobs()`; the class `BunJobs` as a token | 3 |
| `jobs.queue(name, opts)` and `BunQueue` (add, addBulk, addFlow, builder verbs, defaults, limits, pause, drain, clean, retry, repeatables, job defaults) | `lib/queue/BunQueue.ts:356` | `registerQueue`; `@InjectQueue`; typed `@QueueToken` classes. The methods themselves need no surface | 4 |
| Builder and drafts (`schedule/run/process/now/create`, `toQueue`) | README "Builder methods", "Saved drafts" | none: methods on the injected `BunJobs` or queue | 4.4 |
| Flows (`addFlow`, `getChildrenValues`) | README "Flows" | none for adding (a method). `@CurrentJob()` gives the handler `getChildrenValues()` | 4.4, 7.3 |
| `jobs.define(name, handler, opts)` and `jobs.start()`, the registry | `lib/BunJobs.ts:812`, `:1139` | `@DefineJob(name, opts)` on a method | 5.7 |
| `BunQueueWorker`: processor, concurrency, `target`, `lockDuration`, `deadLetterQueue`, `control`, `metrics`, … | `lib/queue/BunQueueWorker.ts:642` | `@Processor(queue, options)`; `@Process(name, { concurrency, rate })` | 5 |
| Per-name and queue limits (`setLimits`) | README "Rate and concurrency limits" | `@Process(name, { concurrency, rate })` stores per-name limits at bootstrap | 5.3 |
| Worker lifecycle: `pause`, `stop`, `close`, `state` | README "Pause, resume and shutdown" | started and drained by the module; `@InjectWorker(ProcessorClass)` for the rest | 6 |
| Worker and queue events (`active`, `progress`, `completed`, `failed`, `retrying`, `dead`, `deadLettered`, `stalled`, `lockLost`, `drained`, … and `event:name` scoped) | `lib/queue/types.ts:1380-1500` | `@OnWorkerEvent`, `@OnQueueEvent` | 6.1 |
| `JobsNotifier`: cross-process events from queues, runners and workers | README "Events and JobsNotifier" | `@OnJobsEvent`; `@InjectJobsNotifier()` | 6.1 |
| Repeat jobs (`repeat: { cron, every, tz, limit, key, catchUp }`), debounce, throttle | README "Scheduling and repeatable jobs" | `@Cron`, `@Every` (§8); debounce and throttle are job options, with no surface | 8 |
| `BunRunner` and `BunRunnerManager`: run a file on a schedule or on demand | `lib/runner/types.ts:836` (`file` is required) | `registerRunner`; `@InjectRunner(id)`; `@OnRunnerEvent` | 8.4 |
| Worker targets: in-process, worker-thread, child-process, container, custom | `lib/queue/workerTarget.ts:532-551` | the `target` option for **file** processors; `createProcessorContext()` for DI inside a file | 5.4 |
| Summoning (`summon` policies, groups, `runSummoned`, `summonedFromArgs`) | `lib/summon/worker.ts:1285`, `lib/summon/args.ts:238` | module option; `registerQueue({ summon })`; `runSummonedApplication()` | 9.1 |
| Remote executors (`createRemoteExecutor`) and the planned gateway | `lib/remote/index.ts:29`; GW §4.3 | `@RemoteHandler(name)` with `BunRemoteExecutorModule`; the gateway module is GW's PR-g2 | 9.2 |
| Management API (`createJobsApi`, `authorize`, live-events socket) | `lib/api/createJobsApi.ts:206`, `lib/api/config.ts:75-154` | `BunJobsApiModule`, unchanged; `guardsAuthorize()` | 9.4 |
| bun-jobs-ui (`jobsUi()`) | `packages/bun-jobs-ui/lib/index.ts` | `BunJobsUiModule` on `./jobs-ui` | 9.5 |
| Analytics and the `metrics` option | README "The `metrics` option" | a module option only | 9.7 |
| Worker and runner control from another process (`jobs.workers.controller`, `jobs.runners.controller`) | README "Controlling workers from another process" | none: methods on the injected context | 9.10 |
| Logging (`LoggerLike`) | README "Logging" | defaults to a Nest `Logger`, detected by bun-common's `resolveLogger` | 3.4 |
| Errors (`JobsError` family, `UnrecoverableJobError`) | `lib/shared/errors.ts:139` | `UnrecoverableOn(...)` filter; `JobForbiddenError` | 7.5 |
| Drivers, driver configs, schema sync | README "Drivers", "Schema sync" | module options (`driver`, `syncSchema` inside the config) | 3.2 |
| Dates in words (`dateParser`) | README "Dates in words" | a module option | 3.2 |
| Shutdown | `lib/BunJobs.ts:1355` | the module's hooks | 6.3 |

### 2.3 Prior art, and what each piece teaches

All of these were read from the packed npm tarballs, for Nest 11 and Nest 12 [V, PA].

| Package | Handler shape | Pipeline? | Lifecycle | Request scope | Lesson for us |
|---|---|---|---|---|---|
| `@nestjs/bullmq` 11.0.5 / 12.0.0 | `@Processor(queue \| {name, scope, configKey}, workerOptions?)` on a class extending `WorkerHost`, with one `process(job, token?)`; `@OnWorkerEvent(event)`; `@QueueEventsListener` + `@OnQueueEvent`; `@InjectQueue(name?)`, `@InjectFlowProducer(name?)` | **No.** "Enhancers aren't supported (and there's no plan to do so)", nestjs/bull#429 | workers start in `onModuleInit` (BullMQ's `autorun` defaults to true); they close in `onApplicationShutdown`, after the HTTP server | job = `REQUEST`, through the internal `Injector.loadPerContext`; listeners on scoped classes are ignored with a warning | the shape users know; tokens `BullQueue_<name>`; file-path "sandboxed" processors with no DI |
| `@nestjs/bull` 11.0.4 (legacy) | `@Process(name? \| {name, concurrency})` per method, one `queue.process` each | no | — | — | per-method workers were dropped for confusion |
| `@nestjs/schedule` 6.1.3 / 12.0.2 | `@Cron(expr, {name, timeZone \| utcOffset, disabled, waitForCompletion, threshold, initialDelay})`, `@Interval`, `@Timeout`, `SchedulerRegistry` | no | explores in `onModuleInit`; starts in `onApplicationBootstrap`; stops in `beforeApplicationShutdown` | scoped providers skipped with a warning | local timers in every replica |
| `@nestjs/event-emitter` 3.1.0 / 12.0.1 | `@OnEvent(event, {async, promisify, suppressErrors, prependListener})` | no | registers in `onApplicationBootstrap` | payload = `REQUEST` | `suppressErrors` defaults to true |
| `@nestjs/cqrs` 11.0.3 / 12.1.0 | `@CommandHandler`, `@EventsHandler`, `@Saga` | no | registers in `onApplicationBootstrap` | **public API only**: `ContextIdFactory.create()`, `registerRequestByContextId`, `moduleRef.resolve` | the request-scope route to copy |
| `@nestjs/graphql` 13.4.5 | resolvers | **yes**, through ECC, context type `'graphql'`, `GqlExecutionContext.create(ctx)` | — | yes | the context-type pattern to copy |
| `@nestjs/microservices` 11.2.7 | `@MessagePattern` | yes, with its own copy of the context creator that throws `RpcException` | — | yes | why a guard denial is HTTP-shaped in ECC |
| `@golevelup/nestjs-rabbitmq` 9.1.0 | `@RabbitSubscribe`, `@RabbitRPC` | **yes**, through ECC, context type `'rmq'`; it copies Reflect metadata onto its bound handler | — | no | third-party precedent; its README warns that global enhancers apply |
| `@wavezync/nestjs-pgboss` 7.0.2 | `@Job(name)` | no: binds methods directly | `onApplicationBootstrap` | no | the minimal contrast |

---

## 3. Module design and packaging

### 3.1 The shape [D]

```ts
import { BunJobsModule } from "@kingsleyweb/bun-nest/jobs";

@Module({
  imports: [
    BunJobsModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        namespace: "shop",
        service: "api",
        driver: { type: "redis", url: config.getOrThrow("REDIS_URL") },
        defaultJobOptions: { attempts: 3 },
        publishEvents: true,
      }),
    }),
    EmailsModule,
  ],
})
export class AppModule {}

@Module({
  imports: [BunJobsModule.registerQueue({ name: "emails", options: { defaultJobOptions: { attempts: 5 } } })],
  providers: [EmailProcessor, SignupService],
})
export class EmailsModule {}
```

- **`forRoot(options)` and `forRootAsync({ imports, inject, useFactory | useClass | useExisting })`**
  build one `BunJobs` context. The options are every `BunJobsOptions` field
  (namespace, driver, logger, defaultJobOptions, runnerDefaults,
  registryQueue, dateParser, publishEvents, processEvery, service,
  workerControl, metrics, summon). Module options sit beside them:

  | Module option | Default | What it does |
  |---|---|---|
  | `isGlobal` | `true` | Registers the module globally. |
  | `jobs` | none | An existing `BunJobs` to borrow instead of building one. It is never closed by the module. |
  | `name` | none | A context name. See §3.3. |
  | `autoStart` | `true` | Whether workers start at bootstrap. |
  | `shutdown` | `{ timeout: 30_000 }` | `{ timeout?, force? }` for draining workers. |
  | `enhancers` | `true` | Whether handlers run through the Nest pipeline. |
  | `token` | none | A named class extending `BunJobs<Jobs>`, provided as well, for typed registries (§5.7). |
  | `scheduleQueue` | `"nest-schedule"` | The queue `@Cron` and `@Every` use (§8.1). |
  | `pruneSchedules` | `false` | Whether undeclared schedule series are removed at boot (§8.2). |

- **Built on `ConfigurableModuleBuilder`** with `setClassMethodName("forRoot")`
  and `setExtras({ isGlobal: true }, …)`, the documented recipe; it has no
  built-in `isGlobal` [V, PA §6]. It gives `useClass`, `useExisting` and
  `useFactory` for free. `BunJobsApiModule` hand-writes `forRootAsync` with
  `useFactory` only (`BunJobsApiModule.ts:57-67`) [S]. The new module should
  not copy that: Q13.
- **Global by default**, like `BullModule`'s core module [V, PA §1], so
  `registerQueue` in a feature module needs nothing but itself. This does
  not decide where workers drain. That was measured to matter, and it is
  done per processor instead (§6.3).
- **Its providers:**
  - the `BunJobs` (token: the class `BunJobs`, plus `getBunJobsToken(name?)`);
  - the options;
  - the explorer (§5.2);
  - the registry the decorators read from.

### 3.2 Building or borrowing the context [D]

| Given | Built here? | Closed by the module? |
|---|---|---|
| options without `jobs` | yes: `new BunJobs(options)`, which builds the driver from a config (README "BunJobs options") [S] | yes, in `onApplicationShutdown`, after workers have drained and queues have closed |
| `jobs: existing` | no | no. Its workers, which the module created, are closed. The context is the app's |

This is bun-jobs' own rule for drivers, "a config is built and closed here;
an instance is never closed by it" (README "BunJobs options") [S], applied one
level up. Schema sync, `dateParser` and every driver config field are
passed through untouched (`driver: { type: "sql", url, syncSchema: true }`).
None of them needs a Nest surface.

### 3.3 Several contexts in one app [D]

A context is one namespace on one backend. An app talking to two (its own
service's jobs, and a shared "billing" namespace) imports the module twice:

```ts
BunJobsModule.forRoot({ namespace: "shop", driver }),
BunJobsModule.forRoot({ name: "billing", namespace: "billing", driver: billingDriver }),
```

Tokens are qualified by the context name, so there are no collisions:

| Token for | Default context | Named context |
|---|---|---|
| the context | `BunJobs`, and `getBunJobsToken()` | `getBunJobsToken("billing")` |
| a queue | `getQueueToken("emails")` → `"bun-jobs:queue:emails"` | `getQueueToken("emails", "billing")` → `"bun-jobs:billing:queue:emails"` |

The decorators take the context last: `@InjectQueue("emails", "billing")`,
and `@Processor("emails", { context: "billing" })`. bullmq calls this
`configKey`; it is the same idea [V, PA §1].

Two contexts with the **same namespace on the same backend** see the same
queues. That is bun-jobs' model, and not a collision ("Namespace" in the
README's Concepts) [S]. A module that registers a queue name in two
contexts gets two providers, keyed by context.

### 3.4 The logger [D]

`logger` defaults to `new Logger("BunJobs")` from `@nestjs/common`. bun-jobs
accepts a `LoggerLike`, and bun-common's `resolveLogger` detects a NestJS
logger by its shape (CLAUDE.md "Logging") [S]. So bun-jobs' records reach the
app's own `app.useLogger(...)` with no adapter. Passing `logger` overrides
it, and `logger: false` maps to bun-common's `noopLogger`.

### 3.5 Packaging: grow `./jobs`, and three new subpaths [D]

| Entry | Holds | Peers it needs (`consumer-check.json`) | Why separate |
|---|---|---|---|
| `./jobs` (exists) | `BunJobsApiModule` (unchanged), `BunJobsModule`, every decorator, the explorer, `BunJobsExecutionContext`, the pipes and filters, `guardsAuthorize`, `createProcessorContext`, `runSummonedApplication`, `BunRemoteExecutorModule` | `@kingsleyweb/bun-jobs` | already where the dependency on bun-jobs starts |
| `./jobs-ui` (new) | `BunJobsUiModule` | `@kingsleyweb/bun-jobs`, `@kingsleyweb/bun-jobs-ui` | a second optional peer: a `./jobs` that reached bun-jobs-ui would break every app without it, which is the failure `checkPeerScopes` exists to catch |
| `./jobs/terminus` (new) | `BunJobsHealthIndicator`, `BunJobsHealthModule` | `@kingsleyweb/bun-jobs`, `@nestjs/terminus` | the same reason |
| `./jobs/testing` (new) | `BunJobsTestingModule`, `runJob`, `drainJobs` | `@kingsleyweb/bun-jobs` | keeps test helpers out of a production import graph, the way `@kingsleyweb/bun-jobs/provider/testing` does |

Each new entry follows the recipe in CLAUDE.md "Packaging types":

- `{ "@kingsleyweb/source", "types", "default" }`, in that order;
- explicit `./lib/...` keys;
- a `consumer-check.json` entry with its `peers`;
- a packaging test for the shape.

The barrel-isolation test gains `./jobs-ui` and `./jobs/terminus`. Each must
fail by naming its own missing peer, and the barrel must still load.

**Why not a separate package (`@kingsleyweb/bun-nest-jobs`)?** The
optional-peer split already gives what a package would: zero cost to apps
without bun-jobs, measured when `./jobs` was introduced (bun-nest README
"Installing bun-jobs is what makes the subpath compile") [S]. A package
would add a release train for no consumer benefit. Q2 asks the user.

---

## 4. Producers: injecting queues and the context

### 4.1 `registerQueue` [D]

```ts
BunJobsModule.registerQueue(
  { name: "emails", options: { defaultJobOptions: { attempts: 5 } } }, // QueueCreateOptions
  { name: "images", summon: imagesPolicy },                            // §9.1
  EmailsQueue,                                                         // a typed token class, §10.2
)
BunJobsModule.registerQueueAsync({ name: "emails", inject: [...], useFactory: (...) => ({ options }) })
```

Each entry provides `getQueueToken(name, context)` as
`useFactory: (jobs) => jobs.queue(name, options)`, and exports it.

- **A queue's options apply on the first call that creates it.** A later
  call with different options is ignored, with one warning
  (`BunJobs.ts:575-680`, README "The BunJobs registry and builder") [S]. Two
  feature modules registering `emails` with different options therefore
  get the first module's options and a bun-jobs warning. The module
  **adds a check at bootstrap**: when two `registerQueue` calls for one
  queue in one context carry options that differ, it throws a
  `ConfigError` naming both modules, before any queue is created. The
  warning is right for bun-jobs' imperative API. A declarative Nest
  registration can be checked up front, and should be (Q14).
- A queue that is never registered can still be reached through
  `jobs.queue(name)` or the builder's `toQueue(name)`. Registration exists
  to make a queue injectable, and to own its options.

### 4.2 Injection decorators [D]

| Decorator | Resolves to | Note |
|---|---|---|
| `@InjectQueue(name \| TokenClass, context?)` | `getQueueToken(name, context)` | Takes a name or a typed token class (§10.2). With the class, `@Inject(EmailsQueue)` or plain constructor typing works too, under `emitDecoratorMetadata` |
| `@InjectBunJobs(context?)` | `getBunJobsToken(context)` | Plain `constructor(jobs: BunJobs)` also works for the default context |
| `@InjectJobsNotifier(context?)` | a `JobsNotifier` opened at bootstrap and closed at shutdown | §6.1 |
| `@InjectRunner(id, context?)` | a registered `BunRunner` | §8.4 |
| `@InjectWorker(ProcessorClass)` | a `WorkerRef`, whose `worker` getter returns the `BunQueueWorker` serving that class's queue | The worker is built at bootstrap, after DI, so what is injected is a provider-backed handle. Its getter throws a `ConfigError` before `onApplicationBootstrap` |
| `@InjectSummonController(queue, context?)` | `jobs.summonController(queue)` (`BunJobs.ts:684`) [S] | §9.1 |

There is **no `@InjectFlowProducer`**. bullmq needs a separate
`FlowProducer`, while `addFlow` is a method of every bun-jobs queue (README
"Flows") [S]. The migration table maps one to the other (§11.3).

### 4.3 Producing a job

```ts
@Injectable()
export class SignupService {
  constructor(
    @InjectQueue(EmailsQueue) private readonly emails: EmailsQueue,
    private readonly jobs: BunJobs,
  ) {}

  async signedUp(user: User) {
    await this.emails.add("welcome", { to: user.email }, { attempts: 3 });
    await this.jobs.schedule("reindex", { id: user.id }).toQueue("search").in("5 minutes").start();
  }
}
```

### 4.4 The builder, drafts, flows, job defaults, limits: no surface [D]

Each of these is a method on an injected object, and a decorator would add
a second spelling of the same call:

- builder verbs and `toQueue`;
- drafts (`create().save()`);
- `addFlow`;
- queue job defaults (`setJobDefaults` and `applyJobDefaults`);
- `setLimits`;
- `pause` and `resume`, `drain`, `clean`, `retryAll`;
- `listRepeatables` and `disableRepeatable`;
- `getDemand`, `walk` and `count`.

The rule this plan follows throughout: **a decorator exists where it
attaches behaviour to a method or a class at discovery time.** Calling an
API does not need one.

---

## 5. Consumers: marking a method as a worker

### 5.1 Three shapes, compared

| | **(A) bullmq's `WorkerHost`** | **(B) `@Processor` class + `@Process(name?)` methods** | **(C) a method-level `@QueueWorker(queue)` on any provider** |
|---|---|---|---|
| What the user writes | `@Processor("emails") class P extends WorkerHost { async process(job) { switch (job.name) … } }` | `@Processor("emails") class P { @Process("welcome") welcome(@JobData() d) {…} @Process() other(job) {…} }` | `class SignupService { @QueueWorker("emails") welcome(job) {…} }` |
| bun-jobs workers created | one per class | **one per queue**: classes on one queue share it (§5.3) | one per decorated method |
| Dispatch by job name | the user's `switch` | the integration, by `@Process(name)`; a bare `@Process()` is the catch-all | none: the worker claims every name on its queue |
| Behaviour when a queue carries several job names | correct | correct | **wrong**: the worker for `welcome` claims a `digest` job and fails it. A bun-jobs worker claims any job on its queue, and the registry fails a name it has no handler for (`BunJobs.ts:1162-1173`) [S] |
| Concurrency and worker options | one place | one place, on the class | per method, so several claim loops on one queue |
| Per-handler pipeline (guards, pipes, …) | one handler, so a `switch` inside it | **per method** | per method |
| Lifecycle events (`@OnWorkerEvent`) | on the class | **on the class**, the worker's owner | no obvious owner |
| What the user asked for ("a method in a service marked as a worker") | no: one fixed method | **yes**: any method, named per job | yes, literally |

**Recommendation: (B)** [D]. It is what the user asked for, a method per
job, with the per-method pipeline that makes guards and pipes useful, and
it maps exactly onto bun-jobs' model: one worker per queue, dispatching on
`job.name`, as `BunJobs.start()` and `defineProcessors` already do
(README "One file, many job names") [S]. (C) cannot be made correct on
bun-jobs, because a worker cannot be told to claim only some names: its
claim takes any waiting job on the queue. bullmq removed the per-method
shape of `@nestjs/bull` for the confusion it caused [V, PA §2]. (A) is
offered anyway for migration, as `class P extends JobsHost` with a
`process(job, ctx)` method (§11.3), and it is just (B) with one catch-all
method.

**A service that is also a processor.** The user's "a method in a service"
is (B) with `@Processor` on the service itself:

```ts
@Processor("emails", { concurrency: 5 })
export class EmailService {
  constructor(private readonly mailer: Mailer) {}

  async sendNow(to: string) { … }                       // an ordinary method

  @Process("welcome")
  async welcome(@JobData(new StandardSchemaPipe(EmailSchema)) data: Email, @JobProgress() progress: JobProgressFn) {
    await progress(10);
    return this.mailer.send(data.to, "Welcome");
  }

  @Process()                                           // any other name on this queue
  async other(@CurrentJob() job: Job) { throw new UnrecoverableJobError(`unknown job ${job.name}`); }
}
```

### 5.2 Discovery and the explorer [D]

At `onApplicationBootstrap`, the explorer (`BunJobsExplorer`, internal) does
the following, with `DiscoveryService.getProviders()` and
`MetadataScanner.getAllMethodNames(prototype)` (`scanFromPrototype` is
deprecated [V, PA §6]):

1. finds every provider whose class carries `@Processor`, `@Process`,
   `@DefineJob`, `@Cron`/`@Every`, `@OnWorkerEvent`, `@OnQueueEvent`,
   `@OnJobsEvent`, `@OnRunnerEvent` or `@RemoteHandler` metadata;
2. builds one ECC handler per decorated method (§7.1);
3. builds one `jobs.worker(queue, dispatcher, options)` per queue, from
   the `@Processor` classes on it (§5.3), and calls `run()` (§6.2).

The `metatype` / `instance.constructor` ternary from bullmq is kept, so
`useFactory` and `useValue` providers are found too [V, PA §1]. Only
providers are scanned, not controllers. Kamil Myśliwiec on nestjs/nest#11272:
ECC "was designed to be used only for providers". A controller gets an empty
module key, and its module-scoped enhancers do not resolve [V, PA §9]. The
explorer therefore throws a `ConfigError` for `@Processor` on a controller,
rather than letting it half work.

The explorer is internal: it is not exported, and is not a name for
approval. bullmq's `manualRegistration` [V, PA §1] becomes `autoStart: false`
(§3.1). Discovery still runs, but no worker starts until
`BunJobsLifecycle.start()`. Tests (§9.9) and summoned processes (§9.1) need
that.

### 5.3 `@Processor` and `@Process` options [D]

```ts
@Processor(queue: string | QueueTokenClass, options?: ProcessorOptions)
@Process(name?: string, options?: ProcessOptions)
```

- **`ProcessorOptions`** is `BunQueueWorkerOptions` without `namespace`,
  `driver` and `autorun` (owned by the module), plus:

  | Field | Default | What it does |
  |---|---|---|
  | `scope` | `Scope.DEFAULT` | The Nest scope. Written as `SCOPE_OPTIONS_METADATA`, exactly as bullmq does, so no `@Injectable` is needed [V, PA §1]. |
  | `context` | the default context | The named context (§3.3). |
  | `enhancers` | the module's | Turns the pipeline off for this class. |
  | `onDenied` | `"fail"` | What a guard's denial does: `"fail"` or `"retry"` (§7.5). |

  Everything bun-jobs takes passes through unchanged:
  - `concurrency`, `lockDuration`, `heartbeatInterval`, `stalledInterval`,
    `maxStalledCount`, `pollInterval`, `maxBlock`;
  - `maintenance`, `drainDelay`, `deadLetterQueue`, `backoffStrategies`;
  - `control`, `stopPersistence`, `metrics`, `publish`;
  - `id`, `key`, `name`, `service`.

  `target` is the exception: a `@Process` method can only run in-process,
  and any other `target` is refused at bootstrap (§5.4).

  `concurrency` stays changeable at runtime through `@InjectWorker(P)`, and
  through a remote configuration override (README "Controlling workers from
  another process") [S].
- **`ProcessOptions`** is `{ concurrency?, rate? }`: a per-name limit.
  At bootstrap, the explorer merges these into the queue's stored per-name
  limits. It uses the same merge-don't-replace rule as
  `#storeDefinitionLimits` (`BunJobs.ts:1206-1232`) [S]: the queue's rate,
  its overall concurrency and every other name are left as they were, and
  nothing is written when nothing would change.
  - **This is a cluster-wide write**, so the docs say so.
  - A per-name limit is enforced by name skipping, not by a separate worker
    (README "Rate and concurrency limits") [S], so it composes with (B)'s
    single worker.
- **Two classes on one queue in one context share one worker.** The
  explorer builds one worker per (context, queue). Its dispatcher holds the
  merged handler map of every `@Processor` class on that queue. This
  follows from §5.1: two workers on one queue would each claim the other's
  names. Three cases are a `ConfigError` at bootstrap, naming both classes:
  - two classes register the same job name;
  - two classes register a catch-all `@Process()`;
  - two classes set different worker options.

  A job whose name no class handles fails as `UnrecoverableJobError`, so it
  goes to `dead` rather than being retried. A worker in another deployment
  may know the name, so the error message says this process does not handle
  it. That is the registry's own rule (`BunJobs.ts:1162-1173`) [S], with an
  unrecoverable error instead of a retryable one, since no retry here will
  find a handler. Q15 asks whether to keep bun-jobs' retryable
  `ConfigError` instead.

### 5.4 Where the attempt runs: `target` [D]

**What is possible:**

- **In-process (the default)**: the DI-built method is called on the
  worker's own thread, through the whole pipeline. This is the only target
  a `@Process` method can have. `@Processor(queue, { target: "worker-thread" })`
  on a class with `@Process` methods is a `ConfigError` at bootstrap. It
  repeats bun-jobs' own refusal ("needs a processor file: a function cannot
  be sent to another process or Worker", `workerTarget.ts:551`), but earlier
  and naming the class.
- **Off-thread, without DI**: register a processor **file** as the
  worker. bullmq's "sandboxed processors" are the same [V, PA §1]:

  ```ts
  BunJobsModule.registerWorker({
    queue: "images",
    processor: new URL("./processors/resize.ts", import.meta.url),
    options: { target: { kind: "child-process", spawn: { passEnv: ["S3_BUCKET"] } }, concurrency: 4 },
  })
  ```

  `registerWorker` is a plain worker owned by the module, so it starts and
  drains with the others. It is the path for `"container"` too (GW §5.3).
- **Off-thread, with DI inside the file**: `createProcessorContext(WorkerModule)`,
  exported from `./jobs`, builds a Nest **application context** (no HTTP)
  inside the processor file, once per thread or process, and resolves a
  provider from it:

  ```ts
  // processors/resize.ts
  import { defineProcessor } from "@kingsleyweb/bun-jobs";
  import { createProcessorContext } from "@kingsleyweb/bun-nest/jobs";
  import { ImagesWorkerModule, ResizeService } from "../images";

  export default defineProcessor(async (job, ctx) => {
    const app = await createProcessorContext(ImagesWorkerModule); // cached per thread/process
    return app.get(ResizeService).resize(job.data, ctx.signal);
  });
  ```

**The honest limits:**

- **The bootstrap is paid on every attempt.** bun-jobs starts a fresh
  `Worker` or child process for each attempt (README "Where attempts run")
  [S]. Measured on a three-provider module, it added a median 115 to 130 ms
  per attempt, on top of the ~135 ms a fresh thread or process already
  spends loading bun-jobs [M, `results-boot-cost.txt`]. A real module that
  opens database connections pays for those too, every attempt. The cache
  helps only with `"in-process"`, where no fresh context is needed anyway.
- **The Nest pipeline does not cross the boundary.** Guards, interceptors
  and filters on the parent's side would see a file, not a method. Inside
  the file, the user calls services directly. The helper does not run
  `@Process` methods off-thread: that would need the same Nest module in
  the child, and a DI graph the child cannot share.
- **A child sees what bun-jobs passes it.** A `child-process` attempt gets an
  environment allowlist by default (README "Upgrading: a `child-process`
  target no longer inherits `process.env`") [S]. A module that reads
  `process.env.DATABASE_URL` at construction fails in the child unless
  `passEnv` names it. The helper's docs say so first.
- **A warm pool would remove the per-attempt cost.** bun-jobs' custom
  target API (`WorkerTargetFactory`, README "A custom target") [S] allows a
  pool of long-lived threads, each bootstrapping the Nest context once and
  running many attempts. It is feasible, but it is a new target with its
  own close and kill semantics, under the runner-review pitfalls of
  `docs/agentic-setup.md` ("Reviewing runner changes"). **Deferred** (Q11).

### 5.5 DI scope: singleton, request-scoped and durable processors [D]

- **Singleton (the default).** Handlers are built once, at bootstrap.
  Measured overhead over a plain bun-jobs worker: 0 to 3 µs per job at 20,000
  jobs (11 to 15 µs/job plain, 14 to 17 µs/job through the pipeline)
  [M, `results-scoped.txt`].
- **`scope: Scope.REQUEST` (or any processor depending on a request-scoped
  provider).** Each job gets a fresh DI sub-tree:

  ```ts
  const contextId = ContextIdFactory.getByRequest(job);   // consults a ContextIdStrategy: durable trees
  moduleRef.registerRequestByContextId(job, contextId);    // REQUEST is the job
  const instance = await moduleRef.resolve(ProcessorClass, contextId, { strict: false });
  const handler = ecc.create(instance, method, name, ROUTE_ARGS_METADATA, paramsFactory, contextId, …);
  ```

  - This is public API only. It is `@nestjs/cqrs`'s route. bullmq uses the
    internal `Injector.loadPerContext` instead [V, PA §1, §5], and Nest 12
    lists `Injector` under `@nestjs/core/internal`, "not part of the public
    API" [V, PA §9].
  - Measured: every job got a distinct instance (60,150 of 60,150 across
    the 20,000-job rounds), and `REQUEST` was the job in every one. The cost was 35 to 80 µs per job at 20,000 jobs,
    against 14 to 17 for a singleton [M, `results-scoped.txt`].
  - The prototype used `ContextIdFactory.create()`. The design uses
    `getByRequest(job)`, as bullmq does [V], so a durable `ContextIdStrategy`
    can attach a parent context. A tenant per job is the obvious use.
    `getByRequest` records the context id on the object it is given, so the
    job view carries one extra symbol-keyed property for the attempt. bullmq
    lives with the same [I]: PR-n2 checks that the property cannot reach a
    serialised job (`toJSON()`).
  - **The strategy is global** (`ContextIdFactory.apply` is static) and
    receives a bun-jobs `Job` here, not an HTTP request [V, PA §1]. A
    strategy that reads `request.headers` must handle a job. The docs give
    the pattern:

    ```ts
    attach(contextId, request) {
      const tenant = isBunJob(request) ? request.data.tenant : request.headers["x-tenant"];
      …
    }
    ```

    The type guard `isBunJob(value)` is exported for this.
- **Lifecycle events on request-scoped classes.** bullmq ignores them with
  a warning [V, PA §1], which is the kind of silent half-working this repo
  avoids. **A `ConfigError` at bootstrap instead**, naming the class and the
  method. Put listeners on a singleton.
- **Request-scoped classes get no lifecycle hooks** [V, PA §6], so such a
  processor's worker is drained by the jobs module's fallback drain (§6.3),
  not per instance.

### 5.6 What the handler receives [D]

A handler with **no** parameter decorators is called as `(job, ctx)`: the
bun-jobs `Job` and `ProcessorContext` (`lib/queue/types.ts:792-821`) [S].
ECC passes the original arguments through when no parameter metadata exists
(`external-context-creator.js:64-70`) [S, `node_modules/@nestjs/core`].
**Once any parameter is decorated, every parameter must be**: ECC fills only
decorated positions, and the rest arrive as `null` [V, PA §7]. The explorer
checks this at bootstrap (it can count decorated indexes against
`design:paramtypes`), and throws a `ConfigError` naming the parameter.

### 5.7 The registry: `@DefineJob` [D]

bun-jobs' registry (`jobs.define(name, handler, opts)` then `jobs.start()`)
gives every job of a name its defaults (attempts, backoff, timeout,
per-name concurrency) wherever it is added from (README "Defining and adding
jobs") [S]. Its Nest form is a method decorator on any provider:

```ts
@Injectable()
export class ReportJobs {
  @DefineJob("send-report", { attempts: 5, backoff: { type: "exponential", delay: 1000 }, concurrency: 2 })
  async sendReport(@JobData() data: { month: string }) { … }
}
```

- At bootstrap, the explorer calls `jobs.define(name, eccHandler, opts)` for
  each such method, then `jobs.start(registryWorkerOptions)` once, if any
  were defined. `jobs.now("send-report", …)` and the builder then check the
  name and apply its defaults, as they do without Nest.
- It runs through the same pipeline as `@Process`. The difference is
  bun-jobs': a defined job lives on the registry queue (`registryQueue`,
  default `"jobs"`), and the definition's options travel with the name.
- **Typed registries** keep their compile-time checks with a named context
  class: `export abstract class AppJobs extends BunJobs<Jobs> {}`, with
  `forRoot({ token: AppJobs })`. The same `TS4094` rule as §10.2 applies:
  it must be named.

---

## 6. Events and the lifecycle

### 6.1 Event decorators [D]

bun-jobs has four event sources, and each gets a decorator:

| Decorator | Source | Where it may sit | Hears |
|---|---|---|---|
| `@OnWorkerEvent(event)` | the class's queue's worker, which classes on one queue share (§5.3) | a `@Processor` class | this process's worker. Events: `ready`, `active`, `progress`, `completed`, `failed`, `retrying`, `dead`, `deadLettered`, `stalled`, `lockLost`, `drained`, `paused`, `resumed`, `closing`, `closed`, `error`, and any `event:name` scoped form such as `completed:welcome` (`lib/queue/types.ts:1458-1500`) [S] |
| `@OnQueueEvent(queue, event, { context? })` | the injected queue's emitter | any singleton provider | that queue's events. These are local, unless the queue was registered with `subscribe: true`, in which case other processes' published events are re-emitted (README "Queue options") [S]. Events: `added`, `completed`, `failed`, `dead`, `retried`, `debounced`, `throttled`, `repeatScheduled`, `summon`, … (`types.ts:1370-1440`) |
| `@OnJobsEvent({ kind?, type?, target? })` | a `JobsNotifier` the module opens on first use | any singleton provider | **every process's** published events in the namespace: queue, runner and worker events (`control`, `state`, `config`) and summon events (README "Events and JobsNotifier") [S] |
| `@OnRunnerEvent(id, event)` | a registered runner (§8.4) | any singleton provider | `started`, `finished`, `failed`, `timeout`, `killed`, `skipped`, `queued`, … (README "Handlers, messages and kills") [S] |

- **Typed by the event name.** Each decorator is generic over the event map,
  `BunQueueWorkerEvents` and friends. The method's parameters are checked
  with the same typed-descriptor technique §10.3 measured:
  `@OnWorkerEvent("completed")` requires `(job: Job, result: unknown) => …`.
  The payload types come from the processor's queue token when it has one.
- **Errors in listeners are caught and logged, never rethrown.** bun-jobs'
  `safeEmit` swallows a **synchronous** throw in silence, so that "a
  failing metrics listener must not fail the job it observed"
  (`lib/shared/emitter.ts:160-180`) [S]. An `async` listener's rejection
  would escape as an unhandled rejection. The explorer therefore wraps each
  listener, awaiting it and logging any error at `error` with the class,
  method and event. That is the same default as `@nestjs/event-emitter`'s
  `suppressErrors: true` [V, PA §4], with a log line added.
- **Listeners do not run through the pipeline.** A listener is an
  observer, so guards and pipes have nothing to decide.
  `@nestjs/event-emitter` and `@nestjs/bullmq` do the same [V]. Interceptors
  would be useful for tracing, but OT's span model already covers worker
  events.
- **Notifier cost is opt-in.** The notifier opens at bootstrap only if some
  provider uses `@OnJobsEvent` or `@InjectJobsNotifier`. Its `queues`,
  `runners` and `workers` lists are the union of what the decorators name,
  or `"all"` when one leaves `target` out. The `workers` list costs a
  second subscription per queue, which is why it defaults to none (README,
  the `workers` option) [S].
- **Nothing is heard that was never published.** Cross-process events need
  `publishEvents: true` (or `publish` per object) in the producing process
  (README "Events and JobsNotifier") [S]. The module logs a `warn` once at
  bootstrap when an `@OnJobsEvent` exists and `publishEvents` is off in this
  process. It cannot know about other processes, so the log is phrased as a
  reminder, not an error.

### 6.2 When things start [D]

| Step | Nest hook | What happens |
|---|---|---|
| 1 | provider construction | `BunJobs` is built from options (the driver connects lazily on first use) |
| 2 | `onModuleInit` (jobs module) | queues are registered; the options conflict check (§4.1) runs |
| 3 | `onModuleInit` (every module) | the app's own init: database connections, caches |
| 4 | `onApplicationBootstrap` (jobs module) | discovery; ECC handlers built; per-name limits stored; `jobs.define()` calls; repeat series added (§8); notifier opened; **workers and runners started** (unless `autoStart: false`) |
| 5 | `onApplicationBootstrap` (`BunJobsApiModule`) | the socket attached, as today |

**Why `onApplicationBootstrap` and not `onModuleInit`:**

- **Ordering.** A worker started in `onModuleInit` may claim a job before
  another module's `onModuleInit` has opened what the handler uses. Global
  modules (distance `MAX`) run their hooks first [S,
  `node_modules/@nestjs/core/nest-application-context.js:308-319`; V, PA §6].
  bullmq starts in `onModuleInit` because BullMQ's `autorun` defaults to
  true [V, PA §1]. `@nestjs/schedule`, `@nestjs/event-emitter` and
  `@nestjs/cqrs` start in `onApplicationBootstrap` [V].
- **Global enhancers.** ECC copies them when a handler is created [V, PA §7].
  `app.useGlobalGuards()` is called between `NestFactory.create()` and
  `init()`, so handlers built at bootstrap see them. Measured: an interceptor
  added with `useGlobalInterceptors` before `init()` ran for every job
  [M, `results-pipeline.txt`].

The cost is that a job added during another provider's `onModuleInit` waits
until bootstrap to run. That is a matter of milliseconds, and a job is
queued state, so nothing is lost.

### 6.3 When things stop: draining on `app.close()` [D]

Nest's close sequence is `onModuleDestroy` → `beforeApplicationShutdown`
→ `dispose()` (the HTTP server stops) → `onApplicationShutdown`. Each step
walks modules root first, global modules last, and within one module runs
the providers' hooks **concurrently** (`Promise.all`) [S,
`node_modules/@nestjs/core/hooks/on-module-destroy.hook.js:30-55`; V, PA §6].
The question is where a worker must drain so that a job in flight finishes
before the services it uses are destroyed.

**Measured** [M, `results-lifecycle.txt`]: a 300 ms job uses a database whose
service closes it in `onModuleDestroy`, and `app.close()` lands 50 ms in.

| | Drain point | Where the database service lives | Job |
|---|---|---|---|
| A | jobs module, `onModuleDestroy` (module global) | same module as the processor | **failed** |
| B | jobs module, `beforeApplicationShutdown` | a module the feature imports | **failed** |
| C | jobs module, `onModuleDestroy` (module global) | a module the feature imports | **failed** |
| D | jobs module, `onModuleDestroy` (module **not** global, imported by the root) | a module the feature imports | completed |
| E | **each processor instance's own `onModuleDestroy`** | a module the feature imports | **completed** |
| F | each processor instance's own `onModuleDestroy` | **the same module** as the processor | **failed** (destroyed concurrently) |
| H | each processor instance's own `onModuleDestroy` | a `@Global` module | **completed** |
| G | jobs module, `onModuleDestroy` (module global) | a `@Global` module | **failed** |

So:

1. **Each processor's worker drains in that processor instance's own
   `onModuleDestroy` slot** (E, H).
   - The explorer installs a hook on the instance that closes the worker
     (`close({ timeout })`, §3.1's `shutdown`), then calls the class's own
     `onModuleDestroy`, if it has one. When classes share a queue's
     worker, the first of them to be destroyed closes it; `close()` is
     idempotent, and a later call resolves when the first finishes (README
     "Pause, resume and shutdown") [S].
   - A processor's dependencies live in modules it imports, or in global
     modules, and both are destroyed after it [M].
   - This is an own-property hook on a user instance. It is the one piece
     of "magic" in the design, so it is documented, and `JobsHost` (§11.3)
     offers an explicit alternative: a base class whose `onModuleDestroy`
     drains, for users who prefer to see it.
2. **A fallback drain in the jobs module's `onModuleDestroy`** closes every
   worker not yet closed: request-scoped processors (no instance hooks,
   §5.5), `registerWorker` workers (§5.4), runners and the registry worker.
   It also closes the notifier.
3. **Queues stay open until `onApplicationShutdown`.** A provider's own
   `onModuleDestroy` may still enqueue a job, an "account closed" email
   for example. Then the context is closed, if the module built it (§3.2).
4. **The caveat (F)**: a resource provider in the *same* module as a
   processor is destroyed at the same time as the processor's worker
   drains. The docs say: give the processor's resources their own module.
   That is Nest's own advice for lifecycle ordering, and the case is
   measured. Q7 asks whether to go further.

**Signals.** Nest runs none of this on `SIGTERM` unless the app calls
`app.enableShutdownHooks()` [V, PA §6]. Ideally the module would log a
`warn` at bootstrap when workers start without shutdown hooks. Whether it
can detect that is **[U]**: no public read of the setting was found. If
there is none, the README's quick start calls `enableShutdownHooks()` and
says why.

**Budget.** `shutdown.timeout` (default 30 s) is passed to each
`worker.close({ timeout })`. A job still running at the timeout has its
signal aborted, and its lock left to lapse for the stalled sweep (README
"Pause, resume and shutdown") [S]. A platform with a short grace period
(README "Shutdown budgets per platform") sets it lower.

**Nest 12.1.2** adds `httpAdapter.beforeClose?.()` before the hooks run [V,
PA §6]. It is not a jobs concern, and bun-nest targets `^11`. It is noted for
the Nest 12 decision (Q9).

---

## 7. The Nest pipeline around a job

### 7.1 How a handler is wrapped [D]

```ts
const handler = ecc.create(
  instance,                         // the processor (or a per-job instance, §5.5)
  instance[method],                 // the UNBOUND prototype method: metadata is read from it
  method,
  ROUTE_ARGS_METADATA,              // Nest's own key: createParamDecorator works (§7.3)
  jobsParamsFactory,                // (type, data, [job, ctx]) => value
  contextId,                        // STATIC_CONTEXT, or the job's (§5.5)
  undefined,
  { guards: true, interceptors: true, filters: true },  // all three: see below
  "bun-jobs",                       // the context type
);
// the worker's processor: (job, ctx) => handler(job, ctx)
```

Three ECC behaviours were read in its source and shape the call [V, PA §7]:

- **Pass all three options or none.** The options default only when the
  argument is `undefined`. `{ guards: true }` alone silently turns off
  interceptors and filters.
- **Pass the unbound method.** Method metadata (`@UseGuards`,
  `@SetMetadata`) is read from the `callback` argument. A bound or wrapped
  function loses it. golevelup copies every metadata key onto its bound
  handler for this reason.
- **Global enhancers are copied at `create()`.** Build handlers at
  bootstrap (§6.2).

`ExternalContextCreator` is imported from the `@nestjs/core` root. It is not
in Nest 12's `@nestjs/core/internal` entry, it has no `@publicApi` tag, and
the docs never mention it. Its signature is identical in 11.1.27 and 12.1.2.
Its release notes call it "for 3rd-party libraries purposes" (v5.2.0), and
Kamil Myśliwiec has pointed library authors at it (nestjs/nest#9017)
[V, PA §9]. §13 R1 weighs the risk.

The other imports, and their status:

| Import | Status |
|---|---|
| `ROUTE_ARGS_METADATA` and `SCOPE_OPTIONS_METADATA` | from `@nestjs/common/constants`, a deep path. Nest 12's `exports` map keeps `./*` [V, PA §9]. The values (`"__routeArguments__"`, `"scope:options"`) are stable strings, so the code can define them itself if the path ever closes. |
| `assignMetadata` | a deep import from `route-params.decorator`. The prototype used it. The design re-implements its five lines, to avoid the path. |
| `ExecutionContextHost` and `Injector` | **not used** |

### 7.2 The context type and `BunJobsExecutionContext` [D]

`getType()` answers `"bun-jobs"` in guards, interceptors, pipes' parameter
factories and filters (`host.getType()`), measured in all four
[M, `results-pipeline.txt`]. Nest's `ContextType` is still
`'http' | 'ws' | 'rpc'` in 12.1.2 [V, PA §7], so we follow `@nestjs/graphql`'s
pattern:

```ts
export type BunJobsContextType = "bun-jobs" | ContextType;

export class BunJobsExecutionContext {                    // mirrors GqlExecutionContext.create(ctx)
  static create(context: ExecutionContext | ArgumentsHost): BunJobsExecutionContext;
  getJob<TData = unknown, TResult = unknown>(): Job<TData, TResult>;  // args[0]
  getProcessorContext(): ProcessorContext;                            // args[1]: signal, logger, attempt, log, heartbeat
  getQueueName(): string;
  getHandlerName(): string;                                           // the @Process name, or "*"
}
export function isBunJobsContext(context: ArgumentsHost): boolean;   // getType() === "bun-jobs"
```

`BunJobsExecutionContext.create(ctx).getJob()` is what the brief's
`switchToJob()` means. Nest's `ArgumentsHost` has no extension point to add
a `switchToJob()` method [I], so the integration uses the static wrapper
that GraphQL uses. A `.switchToJob()` that patched the host would reach
into Nest's internals.

### 7.3 Parameter decorators [D]

| Decorator | Value | Pipes |
|---|---|---|
| `@JobData(property?, ...pipes)` | `job.data`, or `job.data[property]` | yes. Like `@Body(property?, ...pipes)` |
| `@JobId()` | `job.id` | yes |
| `@JobName()` | `job.name` | yes |
| `@CurrentJob()` | the `Job` itself: `log`, `updateProgress`, `getChildrenValues()` for flows, `extendLock`, `fail` | — |
| `@JobContext()` | the `ProcessorContext` | — |
| `@JobSignal()` | `ctx.signal`: aborted on timeout, worker close and lock loss | — |
| `@JobProgress()` | `(value) => job.updateProgress(value)`, a `JobProgressFn` | — |
| `@JobLogger()` | `ctx.logger`, bound to the job's ids | — |
| `@JobAttempt()` | `ctx.attempt`, from 1 | — |

- Each is stored under `ROUTE_ARGS_METADATA` with our own numeric type,
  and ECC asks our `ParamsFactory` for the value
  (`exchangeKeyForValue(type, data, [job, ctx])`) [S,
  `external-context-creator.js:115-130`]. Measured in the prototype for
  `@JobData`, `@JobId` and a user's `createParamDecorator` [M].
- **A user's own decorator works**, because `createParamDecorator` always
  writes to `ROUTE_ARGS_METADATA` [V, PA §7]. Measured: `@Attempt()`, built
  with `createParamDecorator` and reading
  `BunJobsExecutionContext`-style accessors, received `1` [M].
- **The name `@Job()` is avoided.** It would collide with the `Job` type
  that every handler file imports from bun-jobs. `@CurrentJob()` follows
  Nest's own `@CurrentUser` convention from the docs. Q10.
- **A progress written after an abort is dropped.** bun-jobs drops a
  progress value written after the attempt was given up, silently (README
  "A progress value reported after the worker gave up…") [S]. `@JobProgress()`
  changes nothing about that, and its JSDoc says so.

### 7.4 Pipes: validating job data [D]

- **Nest's own `ValidationPipe` (class-validator) works unchanged.** ECC
  passes each parameter's `design:paramtypes` metatype to pipes
  (`contextUtils.mergeParamsMetatypes`, `external-context-creator.js:57-59`)
  [S]. So `@JobData(new ValidationPipe()) data: WelcomeDto` validates against
  the DTO class. **[I]**: not run, since class-validator is not installed in
  the repo. The examples agent's example would be the proof.
- **Standard Schema** (zod 4, valibot 1, arktype 2, yup 1.7, or anything
  wrapped by `toStandardSchema`): a new `StandardSchemaPipe(schema)`,
  exported from bun-nest's **root**, because it is just as useful in a
  controller.
  - It validates with `schema["~standard"].validate(value)` and throws
    `BadRequestException` with bun-common's issue shape,
    `{ target, message, path }` (CLAUDE.md "Validation libraries") [S].
  - Measured in the prototype with a `toStandardSchema` schema: an invalid
    payload threw `BadRequestException` before the handler ran [M].
  - Its parameter type is inferred from the schema
    (`StandardSchemaV1.InferOutput`), the way bun-common's `validate()`
    infers `req.query` (§10.4 explains why that does not reach the
    parameter's declared type).
- **One helper wanted from bun-common.** The issue formatting (`formatPath`)
  is private to `BunValidate.ts` (`packages/bun-common/lib/BunValidate.ts:368`)
  [S]. A small export, `validateStandard(schema, value) → { value } | { issues: ValidationIssue[] }`,
  would let the pipe reuse it rather than copy it. It is a recommendation to
  the bun-common owner, and optional: the pipe can format its own.
- **A validation failure is not worth retrying.** `UnrecoverableOn(BadRequestException)`
  (§7.5) makes a bad payload go to `dead` on its first attempt. Measured:
  `dead … UnrecoverableJobError: invalid data … (attemptsMade=1)` with
  `attempts: 3` [M].

### 7.5 Guards, filters and job failure [D]

| Situation | What Nest does through ECC [M, `results-pipeline.txt`] | What the integration does |
|---|---|---|
| A guard returns `false` | throws `ForbiddenException` (an `HttpException`). bun-jobs retried it: `attemptsMade=2` of 2 | **Maps it to `JobForbiddenError`**, whose `name` is `UnrecoverableJobError`'s, so it goes to `dead` with no retry. bun-jobs keys unrecoverability on the error's **name** ("An error named `UnrecoverableJobError` ends the job's retries, whether or not it is an instance of the class", README "A custom target") [S]. `onDenied: "retry"` keeps the retry (Q4) |
| A guard throws its own exception | that exception | unchanged: it is the guard's decision |
| A filter rethrows | the job fails with what it threw | unchanged. `UnrecoverableOn(...types)` is a shipped `@Catch(...types)` filter that rethrows as `UnrecoverableJobError` with the original as `cause` |
| **A filter returns a value** | **the job completes with that value**, measured: `completed: "recovered"` | unchanged, because it is Nest's semantics, and a filter author may want exactly that. `BaseJobExceptionFilter`'s JSDoc and the README say it first: *to fail the job, throw* |
| No filter matches | Nest's `ExternalExceptionFilter` logs the error at `error`, with its stack, then rethrows. Measured: `ERROR [ExceptionsHandler] Error: plain failure` | Q5 decides between keeping it, as microservices do, and replacing it |
| `UnrecoverableJobError` or `job.fail()` | passes through | unchanged: bun-jobs sends the job to `dead` |
| `JobTimeoutError` or a lost lock | the signal aborts; the error passes through the filters | unchanged. Filters see it, and should rethrow |

Telling the denial apart: ECC throws `ForbiddenException` with Nest's
`FORBIDDEN_MESSAGE` [S, `external-context-creator.js:153-160`]. A guard's own
`ForbiddenException` with that same message would be mapped the same way.
The explorer checks the instance and the message, and documents the
ambiguity. Microservices avoid the question by keeping their own copy of the
context creator [V, PA §7], which costs internals.

### 7.6 Global enhancers reach jobs [D]

Measured: an `APP_GUARD` and an `app.useGlobalInterceptors()` interceptor
both ran for every job [M]. A global guard written for HTTP that reads
`switchToHttp().getRequest().headers` would see a `Job` and deny, or throw.
So the README's first pipeline paragraph says:

```ts
canActivate(context: ExecutionContext) {
  if (context.getType<BunJobsContextType>() !== "http") return true;  // jobs, ws, rpc: not this guard's business
  …
}
```

This is how Nest already behaves for microservices, GraphQL and golevelup,
whose README carries the same warning [V, PA]. Excluding globals would mean
building ECC from a container whose `ApplicationConfig` has none, which is
internal. `enhancers: false` (module, or per processor) turns the whole
pipeline off and calls methods directly, as bullmq does. Q3.

### 7.7 Interceptors that ship, and ones that should not exist [D]

- **Logging and timing**: `JobLoggingInterceptor` logs one line per attempt
  (job, name, attempt, duration, outcome) through the context's logger.
  Measured as a hand-written interceptor in the prototype [M].
- **Tracing**: OT plans spans per attempt inside bun-jobs itself. An
  interceptor would duplicate them. The plan ships none, and points at OT.
- **Retries: none.** An `rxjs` `retry()` in an interceptor retries inside
  one attempt, under one lock, invisibly to `attemptsMade`, backoff, dead
  letters and the UI. bun-jobs' `attempts` and `backoff` are the retry
  mechanism (README "Retries and backoff") [S]. The README says so, and
  shows `@Process("x")` with the job's own `attempts`.
- **Timeouts: none.** The job's `timeout` option aborts `ctx.signal` and fails
  with `JobTimeoutError` [S]. An `rxjs` `timeout()` would abandon the work
  without aborting it.

### 7.8 Guards that make sense on a job

- **Feature flags or a kill switch**: deny, and the job goes to `dead`, or is
  retried with `onDenied: "retry"` and a backoff that waits for the flag.
- **Tenant authorization**: a job carrying `data.tenantId` that the
  processor's tenant may not touch.
- **Not authentication.** A job has no caller. The guard checks what the
  job claims, so authorization at enqueue time stays the producer's job.

---

## 8. Scheduling

### 8.1 `@Cron` and `@Every`: repeat jobs, not timers [D]

```ts
@Injectable()
export class Maintenance {
  @Cron("0 3 * * *", { tz: "Europe/London", name: "nightly-cleanup" })
  async nightly(@JobData() _data: unknown, @JobSignal() signal: AbortSignal) { … }

  @Every("5 minutes", { immediately: true })
  async refreshRates() { … }
}
```

Each decorated method becomes **a bun-jobs repeat series on a schedule
queue**, added at bootstrap. A worker on that queue dispatches each
occurrence to the method, through the pipeline:

- **The queue** is `scheduleQueue` (a module option, default
  `"nest-schedule"`), or `@Cron(expr, { queue })`.
- **The series key** is `options.name`, else `<Class>.<method>`, so
  restarting the app updates the series rather than duplicating it. The key
  is stable as long as the class and method are not renamed (README "Repeat
  keys you choose are namespaced") [S].
- **The options are bun-jobs' `repeat` options**: `cron`, `every`, `tz`,
  `limit`, `startAt`, `endAt`, `immediately`, `catchUp`
  (README "Scheduling and repeatable jobs") [S]. The job options `attempts`,
  `backoff`, `timeout` and `deadLetter` sit beside them.
- **What it means across replicas: once per occurrence, cluster-wide.**
  Occurrence ids are derived from the series key and the due time
  (`repeatJobId`), so N replicas adding the same series schedule each
  occurrence once [S]. That is the main difference from `@nestjs/schedule`,
  which runs a `cron` timer in every replica [V, PA §3].
- **`@Every(interval)`** accepts what `every` accepts: milliseconds, a
  duration (`"5 minutes"`), words (`"every monday"`) or a cron expression
  [S]. `@Cron(expr)` is `{ repeat: { cron: expr } }`, with six fields when
  seconds are given.
- **Validated at bootstrap.** `validateCron(expr, { tz })` [S] runs before
  anything is written. A bad expression or an unknown zone is a
  `ConfigError` naming the class and method.
- **Disabled series.** `queue.disableRepeatable(key)` (and the UI) can stop
  a series. Re-adding a disabled series at the next boot does **not**
  re-enable it, and schedules nothing (README "Disabling a series") [S].
  That is the right behaviour: an operator's "off" survives a deploy. The
  docs say so, since it differs from `@nestjs/schedule`'s `disabled`
  option, which is code.
- **`@Cron(expr, { disabled: true })`** declares the series without adding
  it, for parity.

### 8.2 Removed decorators leave series behind [D]

When a method's `@Cron` is deleted, its series stays stored, and the next
occurrence still runs, with no handler. The dispatcher fails it as
unrecoverable, with "no `@Cron` handler for series `<key>`". Deleting it
automatically at bootstrap is unsafe during a rolling deploy, where the old
version still declares the series while the new one starts. So:

- At bootstrap, the module lists the schedule queue's repeatables
  (`listRepeatables()`) [S], and logs one `warn` naming every series that no
  `@Cron` or `@Every` in this process declares.
- `pruneSchedules: true` (a module option, off by default) removes them, for
  apps that deploy one version at a time.
- Q8 asks the user.

### 8.3 `@nestjs/schedule`: coexist, do not replace [D]

| | `@nestjs/schedule` | `@Cron` here |
|---|---|---|
| Runs | in every replica, on a local timer [V] | once per occurrence, cluster-wide, as a job |
| Survives a restart mid-run | no | yes: retries, `attempts`, the stalled sweep |
| Visible in the UI and API | no | yes: repeatables, runs, logs, analytics |
| Needs a backend | no | yes: a driver with queue state. Every built-in one has it (README "Disabling a series") [S] |
| `@Interval(ms)` / `@Timeout(ms)` | yes | `@Every(ms)`; a one-shot is `@Every(ms, { limit: 1 })` |

They are different tools: a per-replica timer (refreshing a local cache)
belongs in `@nestjs/schedule`. The integration does not import it, and the
decorator names do not clash at runtime. They do clash at import:
`import { Cron } from "@nestjs/schedule"` beside ours in one file needs an
alias. Q12 weighs `@JobCron` against `@Cron`.

### 8.4 Runners [D]

A `BunRunner` runs a **file** on a schedule or on demand: `file` is
required (`lib/runner/types.ts:836`) [S], and its modes are in-process,
worker-thread and child-process. A DI method cannot be a runner's handler,
for the same reason as §5.4. So runners get registration, not a method
decorator:

```ts
BunJobsModule.registerRunner({
  id: "cleanup",
  file: new URL("./runners/cleanup.ts", import.meta.url),
  schedule: "0 */10 * * * *",
  executionMode: "child-process",
  args: { days: 30 },
})
```

- `registerRunner` builds `jobs.runner(options)`, so it is registered with
  `jobs.runners`, the `BunRunnerManager`. It starts at bootstrap and stops in
  the fallback drain (§6.3), with `stop({ timeout })`.
- `@InjectRunner("cleanup")` returns the runner, for `trigger()`, `pause()`,
  `kill()` and `updateSchedule()`. `@OnRunnerEvent("cleanup", "failed")`
  listens to it (§6.1).
- Inside the runner file, `jobsFromContext(ctx)` gives bun-jobs [S], and
  `createProcessorContext(Module)` gives Nest DI, at §5.4's cost per run.
- **When to use which:** `@Cron` for a method that should run once
  cluster-wide on a schedule. A runner for a script with its own process,
  a single-run lock, kill escalation and run logs (README "BunRunner") [S].

---

## 9. Every other bun-jobs feature

### 9.1 Summoning, including groups [D]

**The controller side (a producer process).**

- The `summon` option of `forRoot` is `BunJobsOptions.summon`, passed
  through: policies keyed by queue, or an array of groups (`{ queues,
  overrides?, …policy }`) (README "One policy for several queues") [S].
- `registerQueue({ name, summon: policy })` adds one policy per queue, next
  to the queue's other options, and calls `jobs.summonController(queue,
  policy)` (`BunJobs.ts:684`) [S] at bootstrap.
  - Two sources naming the same queue is a `ConfigError`, matching
    bun-jobs' "A queue named twice anywhere in the option" rule [S].
- Summoners from `defineSummoner` or `defineComputeProvider` are values, and
  often need configuration. `forRootAsync`'s factory is where they are
  built, from injected config.
- `@InjectSummonController(queue)` gives `status()`, `reset()` and `now()`.
- `onSummonFailed` is a policy field. A Nest provider that wants it injects
  the controller and listens to its `summon` event, or uses
  `@OnQueueEvent(queue, "summon")` on a subscribing queue.
- **Summon groups** from `docs/plans/summon-multi-queue.md`: Part A's
  `group` and Part B's `unit: "shared"` are policy fields. They pass through
  the same way, and need no Nest surface.

**The summoned side (the process a platform starts).** A summoned process
runs one worker under `runSummoned()`, which starts the worker itself and
refuses one that is already running (README "Summoned workers") [S]. In
Nest:

```ts
// worker.ts — the file the platform runs
import { runSummonedApplication } from "@kingsleyweb/bun-nest/jobs";
import { WorkerModule } from "./worker.module";

await runSummonedApplication(WorkerModule, { idleFor: 30_000 });
```

`runSummonedApplication(module, options)`:

1. calls `summonedFromArgs()` [S];
2. creates a Nest **application context** with `autoStart: false`, so no
   worker starts by itself;
3. finds the `@Processor` class for `summon.queue`, or each queue of a
   group unit;
4. builds its worker with `{ summon }`;
5. hands it to `runSummoned()`, which runs it until idle, a deadline or a
   signal, then exits.

The Nest context is closed in `runSummoned`'s close path, after the worker
has closed and before `process.exit`. The exact hook is to be agreed with
the bun-jobs agent [I]. `runSummoned`'s `signals` stay its own, so Nest's
`enableShutdownHooks` must stay off in that process, or the two would race
for `SIGTERM`. The helper refuses an app with shutdown hooks enabled, if
that can be detected (§6.3's [U]).

### 9.2 Remote executors and the gateway [D]

- **The remote executor** (`createRemoteExecutor({ secret, handlers })`,
  a fetch handler) [S]. Its Nest form:
  - `@RemoteHandler(name)` on provider methods.
  - `BunRemoteExecutorModule.forRoot({ path, secret, …executorOptions })`
    collects them into `handlers`, and mounts the executor on bun-nest's
    adapter at `path`.
  - The executor must receive the body **unread**, because the signature
    covers the exact bytes (README "Mount it where the body is untouched")
    [S]. The module mounts with bun-common's per-route `requestParsing`
    opt-out (CLAUDE.md; bun-nest README "Per-route parsing") [S]. **[I]**:
    to be proved by a test that a signed request verifies through the
    module.
  - Handlers run through the pipeline, under the same `"bun-jobs"` context
    type (the executor's `job` and `ctx` have the same shape [I]: to be
    checked against `lib/remote/types.ts`).
- **The gateway**, which hosts executors that dial in, is not built yet
  (README: "The gateway side that calls it lands in a later release") [S].
  GW's PR-g2 already plans `BunJobsGatewayModule` in bun-nest's `./jobs`
  (GW §10.2, §12) [S]. That module takes its `BunJobs` from `BunJobsModule`
  when one is imported, the same rule as §9.4. Nothing else here depends on
  it.

### 9.3 Worker targets

§5.4. In summary:

- `@Process` methods run in-process.
- Files run anywhere, including `"container"`, through `registerWorker`.
- `createProcessorContext` gives a file DI, at a measured cost per attempt.

### 9.4 The management API, with Nest guards for `authorize` [D]

- **`BunJobsApiModule` keeps its API.** One additive change: `jobs` becomes
  optional when `BunJobsModule` is imported. The module injects `BunJobs`
  (or `getBunJobsToken(context)`) with `@Optional()`, and throws today's
  `ConfigError` only when neither source gives one. Existing apps that pass
  `jobs` see no change.
- **`guardsAuthorize(guards, options?)`** builds the API's `authorize` from
  Nest guards:

  ```ts
  BunJobsApiModule.forRootAsync({
    inject: [ModuleRef],
    useFactory: (moduleRef: ModuleRef) => ({
      basePath: "/admin/jobs",
      authorize: guardsAuthorize(moduleRef, [SessionGuard, JobsRolesGuard]),
    }),
  })
  ```

  - Each guard is asked with an `ExecutionContext` of type `"http"`.
    `switchToHttp().getRequest()` is the `BunRequest`, the same object a
    bun-nest controller receives.
  - `getHandler()` and `getClass()` are a policy class whose methods stand
    for "read" and "mutate", carrying `@Roles(...)`-style metadata.
  - `jobsApiContextOf(context)` returns the API's
    `JobsApiAuthorizeContext`: action, mutation, queue, jobId, transport,
    channel (`lib/api/config.ts:75-150`) [S].
  - **Measured** with a `Reflector`-based role guard [M, `results-authorize.txt`]:
    - a reader was allowed `GET /queues` (200) and refused `POST
      …/emails/pause` (403);
    - an admin was allowed to pause (200);
    - a controller beside the API was untouched.
  - The `ExecutionContext` is built from the **public interface** alone:
    no `ExecutionContextHost` import.
  - A guard that throws `UnauthorizedException` maps to
    `{ allow: false, status: 401 }`; `ForbiddenException` or `false` maps to
    403.
- **Why not run the API's routes through Nest's real pipeline?** They are a
  bun-common router mounted on the adapter, not controllers. The bun-nest
  README says so ("Nest guards, pipes and interceptors do not run for these
  routes — use `authorize`") [S]. `authorize` is asked per request **and per
  WebSocket channel** (README "Authorization") [S], which no HTTP guard
  chain covers. Calling the guards from `authorize` covers both transports.

### 9.5 bun-jobs-ui under Nest [D]

`BunJobsUiModule.forRoot({ basePath, authorize?, …UiOptions })` on
`./jobs-ui`:

- it takes the `JobsApi` from `BUN_JOBS_API`;
- it builds `jobsUi({ api, basePath, … })`;
- it mounts it in `onModuleInit`, the way `BunJobsApiModule` mounts the
  API (`BunJobsApiModule.ts:165-168`) [S].

Today's example does the same by hand (`examples/bun-nest/06-jobs-ui/mount.ts`)
[S]. The UI's `authorize` can be `guardsAuthorize(...)` too. The UI must not
sit at or under the API's basePath; `jobsUi()` throws a `ConfigError` for
that (CLAUDE.md "Mounting") [S], so the module surfaces it at boot. Review:
the bun-jobs-ui agent.

### 9.6 WebSocket live events

**No new surface.** `BunJobsApiModule` already attaches the API's
live-events socket to bun-nest's `BunWebSocket`. That socket's coexistence
with `@WebSocketGateway`s is measured and documented (bun-nest README
"Sharing the server with gateways") [S]. An app that wants jobs events on its
**own** gateway writes:

```ts
@WebSocketGateway({ path: "/live" })
export class LiveGateway {
  @WebSocketServer() server!: BunWebSocketServerType;
  @OnJobsEvent({ kind: "queue", type: "completed", target: "emails" })
  completed(event: QueueDriverEvent) { this.server.publish("emails", JSON.stringify(event.payload)); }
}
```

That needs only §6.1. The snippet is a sketch [I]: the gateway server's type and `publish` call are to be checked against bun-nest's `BunWebSocketAdapter` when the examples agent writes the recipe.

### 9.7 Metrics

**No new surface.** The `metrics` option passes through `forRoot` and
`@Processor` (README "The `metrics` option") [S]. The management API serves
analytics, and the demand route's Prometheus exposition
(`?format=prometheus`, README "Reading a queue") [S]. Tracing is OT's.

### 9.8 Health: `@nestjs/terminus` [D]

`BunJobsHealthIndicator`, on `./jobs/terminus`, uses terminus' current API,
`HealthIndicatorService.check(key).up()/.down()` (11.1.1 and later; 12.1.0
adds `.degraded()` and `.attempt()`) [V, PA §8]:

```ts
@Get("health") @HealthCheck()
check() {
  return this.health.check([
    () => this.jobs.isHealthy("jobs", { queues: ["emails"], maxOutstanding: 10_000, requireWorkers: true }),
  ]);
}
```

| Check | How | Down when |
|---|---|---|
| backend reachable | `driver.ping()` (`lib/drivers/driver.ts:101`) [S] | `false`, or a throw, within `timeout` |
| backlog | `queue.getDemand({ cap })`: `outstanding` (README "Queue methods") [S] | above `maxOutstanding` |
| this process's workers | each explorer worker's `state` | `stopped`, or closing, while the app is not |
| someone is consuming | `queue.getDemand()`'s `workers` (live, any process) [S] | `requireWorkers` and 0 workers with demand > 0 |

`timeout` defaults to 1,000 ms, because a health probe must not hang on a
dead backend. Terminus' deprecated `HealthIndicator` base class is not used
[V, PA §8].

### 9.9 Testing utilities (`./jobs/testing`) [D]

```ts
const moduleRef = await Test.createTestingModule({
  imports: [BunJobsTestingModule.forRoot(), EmailsModule],   // MemoryDriver, autoStart: false, a fresh namespace
}).compile();
const app = await moduleRef.init();

const outcome = await runJob(app, "emails", "welcome", { to: "ada@example.com" });
// { state: "completed", result: "sent:ada@example.com", attempts: 1, error?: Error, logs: string[] }
```

- **`BunJobsTestingModule.forRoot(options?)`** is `BunJobsModule` with:
  - `driver: new MemoryDriver()`;
  - a namespace unique per module (`test-<uuid>`);
  - `autoStart: false`;
  - `shutdown: { timeout: 1_000 }`.

  It exports the same tokens, so the app's own modules resolve
  `@InjectQueue` as usual.
- **`runJob(app, queue, name, data, opts?)`**:
  1. adds a real job;
  2. starts that queue's worker if it is stopped;
  3. waits until the job settles: `completed`, or `dead` after its
     attempts, with backoff collapsed to `0` unless `opts.backoff`;
  4. returns the outcome, with the job's log.

  It goes through the **real** worker and the **real** pipeline: guards,
  pipes, filters, scope. It is the counterpart of `adapter.fetch()` for
  HTTP (CLAUDE.md "Testing without a socket") [S].
- **`drainJobs(app, { queues? })`** runs workers until every listed queue
  has no demand, for flows and fan-out. It returns the settled jobs.
- **Overrides are plain Nest**:
  - `.overrideProvider(getQueueToken("emails")).useValue(fakeQueue)` for a
    producer test;
  - `.overrideProvider(EmailsQueue).useValue(...)` for a typed token;
  - `.overrideGuard(FlagGuard).useValue({ canActivate: () => true })` works,
    because guards are resolved through the container ECC uses. **[I]**: to
    be proved in PR-n8.
- **Isolation.** Each `runJob` uses the module's own namespace and memory
  driver, so tests in parallel files (`bun test --parallel`) cannot meet.

### 9.10 The rest: no Nest surface needed

| Feature | Why nothing is added |
|---|---|
| Worker and runner control from another process (`jobs.workers.controller(q)`, `jobs.runners.controller(id)`) | methods on the injected context |
| Dead letters | `deadLetterQueue` (`@Processor` option) and `deadLetter` (job option); a dead-letter queue is processed by an ordinary `@Processor` |
| Debounce and throttle | job options |
| Job defaults and the rewrite | queue methods; the management API serves them |
| Read APIs (`list`, `walk`, `page`, `countAdded`, `listWorkers`, throughput) | queue and context methods |
| Errors | re-exported types from bun-jobs; §7.5's mapping |
| Dates in words (`dateParser`) | a module option |
| Schema sync | inside the driver config |
| `purge`, `listQueues`, `listRunners` | context methods |

---

## 10. Type safety

### 10.1 What TypeScript can and cannot see [M, `results-types.txt`]

| Link | Enforceable? | How |
|---|---|---|
| A string token to the parameter's type (`@InjectQueue("emails") q: BunQueue<Wrong>`) | **no** | A parameter decorator is typed `(target, key, index)`. It never sees the parameter's type |
| A **class token** to the parameter's type | **yes** | The token *is* the type. With `emitDecoratorMetadata`, no `@Inject` is needed at all. Measured: a wrong payload and an undeclared name were both compile errors |
| `@Inject(EmailsQueue) q: BunQueue<Wrong>` (the token written twice, differently) | no | the same reason as the first row; possible only by writing the type twice |
| A `(job, ctx)` handler's payload and result against its queue | **yes** | `@Process` overloaded with a typed `TypedPropertyDescriptor`. Measured: a wrong `Job<Wrong>` and a wrong result type (`number` for `string`) were both errors |
| A job name against the queue's declared names | **yes** | measured: `@Process(EmailsQueue, "nope")` is an error |
| `@JobData() data: Wrong` | **no** | a parameter decorator again. The typed `@Process(Queue, name)` **refuses** a handler written with parameter decorators (measured), so the two styles are exclusive |
| An event listener's parameters | yes | the same typed-descriptor technique, keyed by event name |

### 10.2 Typed queue tokens [D]

```ts
@QueueToken("emails")
export abstract class EmailsQueue extends BunQueue<Email, string, "welcome" | "digest"> {}
```

- **The class is never instantiated.** The provider is `{ provide: EmailsQueue,
  useFactory: (jobs) => jobs.queue("emails") }`, which hands back the real
  `BunQueue`. `@QueueToken(name)` records the name. `registerQueue(EmailsQueue)`
  and `@Processor(EmailsQueue)` read it.
- **It must be a named class.** The tempting
  `const EmailsQueue = defineQueue<Email>("emails")` returns an anonymous
  class. Measured, it fails declaration emit under `declaration: true` (the
  repo's base config, and any library) with `TS4094`, once for each of
  `BunQueue`'s 57 private and protected members, plus `TS4023`. The named form is
  clean [M, `results-types.txt`]. bun-nest ships `dts/`, and so may its
  users.
- `@QueueToken` also writes a phantom `__types` field type for the
  decorators to read the payload, result and names back. It is `declare`d,
  so it emits nothing. This is the same trick as bun-common's `__mount`
  (CLAUDE.md "Mounted sub-routers") [S].

### 10.3 Typed handlers [D]

Two spellings, and the user picks per method:

```ts
@Processor(EmailsQueue)
export class EmailProcessor {
  // Typed: the payload, result and name are checked against EmailsQueue.
  @Process(EmailsQueue, "welcome")
  async welcome(job: Job<Email, string>, ctx: ProcessorContext) { return `sent:${job.data.to}`; }

  // Decorated: pipes and parameter decorators. The payload type is the user's word.
  @Process("digest")
  async digest(@JobData(new StandardSchemaPipe(DigestSchema)) data: Digest) { … }
}
```

The decorated form gets its safety at **run time**, from the pipe: the
schema validates what TypeScript cannot. The README recommends a schema
pipe on every `@JobData()` whose payload crosses a deployment boundary.

### 10.4 What cannot be closed

- **Producer and consumer in different deployments.** The token class is
  shared code. Two services that agree on it compile against the same
  types. Two that do not, do not. That is true of any queue; the schema pipe
  is the runtime net.
- **`StandardSchemaPipe`'s inference does not reach a parameter.** The
  pipe's output type is known, but a parameter decorator cannot impose it on
  the parameter (§10.1). The README shows `data: StandardSchemaV1.InferOutput<typeof Schema>`.
- **The typed registry** (`BunJobs<Jobs>`) keeps all of bun-jobs' checks on
  `now`, `schedule`, `define` and `add` through a named context class (§5.7).
  `@DefineJob(name)` can check the name against the map (measured technique,
  §10.1), but `@JobData()` cannot check the payload.

---

## 11. Back-compat, coexistence and migrating from `@nestjs/bullmq`

### 11.1 `BunJobsApiModule` [D]

- **No breaking change.** Its options, tokens, hooks and behaviour stay.
- **`jobs` becomes optional when `BunJobsModule` is imported** (§9.4). The
  type change is additive (required to optional).
- **The README's example**, which today injects a `BunJobs` the app provides
  itself, switches to `BunJobsModule`, with the old form kept as "bring your
  own context".
- **Order is safe.** `BunJobsApiModule` mounts in `onModuleInit`, and
  `BunJobsModule` creates the context at construction, before any init
  hook. The API's `close()` never closes the `BunJobs` (README "Mounting,
  injection and shutdown") [S], so the two modules' shutdowns do not
  overlap.

### 11.2 Apps that also use `@nestjs/bullmq`, `@nestjs/schedule` or `@nestjs/event-emitter`

| Package | Clash? | Notes |
|---|---|---|
| `@nestjs/bullmq` | **names only**: `Processor`, `Process` (in `@nestjs/bull`), `InjectQueue`, `OnWorkerEvent`, `OnQueueEvent` | alias one side on import (`import { Processor as BunProcessor }`). Metadata keys are prefixed `bun-jobs:`, so there is no runtime clash. Tokens differ (`BullQueue_emails` and `bun-jobs:queue:emails`) |
| `@nestjs/schedule` | names: `Cron` | §8.3 (Q12) |
| `@nestjs/event-emitter` | none | `@OnJobsEvent` is distinct from `@OnEvent` |

### 11.3 Migrating from `@nestjs/bullmq`: the mapping [D]

| `@nestjs/bullmq` [V, PA §1] | Here | Notes |
|---|---|---|
| `BullModule.forRoot({ connection, prefix, defaultJobOptions })` | `BunJobsModule.forRoot({ namespace, driver, defaultJobOptions })` | `prefix` → `namespace`; `connection` → `driver: { type: "redis", url }` (or SQL, MongoDB, file, memory) |
| `BullModule.forRootAsync(...)` | `BunJobsModule.forRootAsync(...)` | the same `useFactory`/`useClass`/`useExisting` |
| `BullModule.registerQueue({ name, defaultJobOptions })` | `BunJobsModule.registerQueue({ name, options: { defaultJobOptions } })` | |
| `BullModule.registerFlowProducer({ name })` + `@InjectFlowProducer()` | **nothing**: `queue.addFlow(node)` | children may name other queues (README "Flows") [S] |
| `configKey` | `context` | §3.3 |
| `@InjectQueue("emails") queue: Queue` | `@InjectQueue("emails") queue: BunQueue`, or a typed `EmailsQueue` token | |
| `queue.add(name, data, { attempts, backoff, delay, priority, jobId, removeOnComplete, repeat })` | the same names | **priority**: lower runs first in both [I for BullMQ]. `repeat.pattern` → `repeat.cron`; `repeat.every` is the same [I]. BullMQ's own options were not part of this survey |
| `@Processor("emails", workerOptions)` + `class extends WorkerHost { process(job) }` | `@Processor("emails", options)` + `class extends JobsHost { process(job, ctx) }` | `JobsHost` is a catch-all `@Process()`, plus an explicit drain hook (§6.3) and a `worker` getter |
| `switch (job.name)` inside `process` | `@Process("name")` per method | optional, and recommended (§5.1) |
| `WorkerHost.worker` | `this.worker` on `JobsHost`, or `@InjectWorker(P)` | |
| `@OnWorkerEvent("completed")` | `@OnWorkerEvent("completed")` | the same name. Payloads follow bun-jobs (`types.ts:1458-1500`) |
| `@QueueEventsListener("emails")` + `@OnQueueEvent("completed")` | `@OnJobsEvent({ kind: "queue", target: "emails", type: "completed" })`, or `@OnQueueEvent("emails", "completed")` on a subscribing queue | cross-process needs `publishEvents` in the producer of the events |
| `@Processor({ name, scope: Scope.REQUEST })` | `@Processor(name, { scope: Scope.REQUEST })` | the job is `REQUEST` in both |
| sandboxed `processors: [path]` | `registerWorker({ queue, processor: path, options: { target: "child-process" \| "worker-thread" } })` | |
| `UnrecoverableError` | `UnrecoverableJobError` | matched by name |
| `job.updateProgress()`, `job.log()` | the same; or `@JobProgress()` | |
| `token` (the second `process` argument) | `ctx` (`ProcessorContext`): `signal`, `heartbeat()`, `log()` | |
| `manualRegistration` + `BullRegistrar.register()` | `autoStart: false` + `BunJobsLifecycle.start()` | |
| *(none)* | guards, interceptors, pipes, filters, `@JobData()` and friends | §7 |

The examples agent's migration example ports one bullmq Nest app file by
file, and asserts the same outcomes (§12.2).

---

## 12. Tests and examples

### 12.1 What each PR's tests prove

Every test runs a real Nest application (`NestFactory.create` with
`BunHttpAdapter`, or `createApplicationContext`) on a real bun-jobs driver:
memory always, plus the file driver for the cross-process cases. Nothing is
mocked between Nest and bun-jobs. The conformance target is **Nest's own
pipeline**: each pipeline test asserts what Nest does for an HTTP route with
the same enhancers, written beside it in the same file, so a difference is
visible.

| PR | Tests | Negative control |
|---|---|---|
| PR-n1 | `forRoot`/`forRootAsync` (`useFactory`, `useClass`, `useExisting`); `jobs` borrowed vs built (the driver closed only when built); `registerQueue` in two feature modules; the options-conflict `ConfigError`; named contexts and their tokens; the Nest logger receiving bun-jobs records; the packaging tests for `./jobs`; the barrel still loads without bun-jobs | the conflict check removed → the test of two differing registrations fails |
| PR-n2 | one worker per class; name dispatch; catch-all; two classes on one queue merged; duplicate name → `ConfigError`; unknown name → `dead`; per-name limits stored by merge (the queue's other limits untouched); `target` on a `@Process` class refused; request scope (a distinct instance per job, `REQUEST` is the job, durable strategy sees a `Job`); **the lifecycle matrix of `lifecycle.ts` as a test**: E and H complete, F documented; `autoStart: false` | the per-instance drain replaced by a module drain → scenario E fails, as measured |
| PR-n3 | for each of guard, interceptor, pipe and filter: method-, class- and global-level (`APP_*` and `useGlobal*`), with `getType() === "bun-jobs"`; a user's `createParamDecorator`; all nine parameter decorators; undecorated-parameter refusal; `ValidationPipe` with a DTO **if class-validator is added as a devDependency** (Q16), and `StandardSchemaPipe` with zod and valibot (already devDependencies of bun-common); `JobForbiddenError` → dead with `attemptsMade=1`; `onDenied: "retry"`; filter-returns-value → completed; `UnrecoverableOn`; `enhancers: false` | each pipeline assertion is paired with the same enhancer on an HTTP route in the same app |
| PR-n4 | each event decorator; scoped `completed:name`; an async listener's rejection logged, not unhandled; `@OnJobsEvent` across two processes on the file driver; listeners on a request-scoped class → `ConfigError` | `publishEvents: false` in the producer → no event, and the warn is logged |
| PR-n5 | `@Cron`/`@Every` scheduling exactly one occurrence across **two** app instances on one file-driver backend; series key stability across a restart; invalid cron and unknown tz → `ConfigError` at boot; an undeclared series warned, and pruned only with `pruneSchedules`; a disabled series stays disabled across a restart; `@DefineJob` defaults applied by `jobs.now`; `registerRunner` start and stop | two instances with the dedupe defeated (a random key) → two runs, proving the test can see duplicates |
| PR-n6 | `BunJobsApiModule` without `jobs` + `BunJobsModule`; with neither → today's error; `guardsAuthorize`: 200/403/401 per role, per transport (HTTP and a socket channel); `BunJobsUiModule` mounted, refusing a basePath under the API's | a guard that always allows → the 403 test fails |
| PR-n7 | `runSummonedApplication`: exits 0 on idle, through a real `localCompute` summon on SQLite (the summon tests' pattern); `createProcessorContext` in a `child-process` target, resolving a provider; `registerWorker` with a file; `@RemoteHandler` through `BunRemoteExecutorModule`, with a signed request (body unread) | an unsigned request → 401 |
| PR-n8 | `runJob`, `drainJobs`; `overrideProvider` on a queue token and on a typed token; `overrideGuard` reaching the job pipeline; two test files in parallel do not meet | — |
| PR-n9 | `isHealthy` up, down on `ping` false, down on backlog, down with no workers, a timeout on a hung ping | — |
| all | a `*.type-test.ts`: every `@ts-expect-error` of `results-types.txt`, under the tests' typecheck (CLAUDE.md, "Compile-time assertions") | each directive is itself the control: unused, it fails as `TS2578` |

### 12.2 Examples the examples agent would write

In `examples/bun-nest/`, a new folder `07-jobs/` (the examples agent owns the
numbering):

| Example | Shows, with checks |
|---|---|
| `quick-start.ts` | `BunJobsModule.forRoot`, `registerQueue`, `@InjectQueue`, a `@Processor` with two `@Process` methods; a job added by a controller and completed |
| `typed-queues.ts` | a `@QueueToken` class; typed `@Process(Queue, name)`; the compile errors as `@ts-expect-error` lines |
| `pipeline.ts` | a guard (feature flag), a `StandardSchemaPipe`, a timing interceptor and `UnrecoverableOn`; `APP_GUARD` with the `getType()` idiom; a filter returning a value |
| `request-scope.ts` | a request-scoped processor with `REQUEST` as the job; a durable tenant strategy |
| `events.ts` | `@OnWorkerEvent`, `@OnQueueEvent`, `@OnJobsEvent` across two processes |
| `shutdown.ts` | `enableShutdownHooks`; a job in flight finishing during `app.close()`; the same-module caveat |
| `cron.ts` | `@Cron` and `@Every` across two app instances, running once |
| `registry.ts` | `@DefineJob` with `jobs.now()` and the builder |
| `runners.ts` | `registerRunner`, `@InjectRunner`, `@OnRunnerEvent` |
| `api-guards.ts` | `BunJobsApiModule` without `jobs`; `guardsAuthorize` with a role guard |
| `ui-module.ts` | `BunJobsUiModule` (replacing the hand mount in `06-jobs-ui/mount.ts`, or beside it) |
| `summoned.ts` | `runSummonedApplication` with `localCompute` |
| `off-thread.ts` | `registerWorker` with `child-process`, and `createProcessorContext` |
| `testing.ts` | `BunJobsTestingModule` and `runJob` (as a script asserting outcomes) |
| `health.ts` | terminus (skips visibly when `@nestjs/terminus` is not installed) |
| `migrate-from-bullmq.ts` | §11.3 as running code |
| `10-options/jobs-module-options.ts` | every module, processor and process option, the way the other option tours do |

Each example asserts with `examples/bun-nest/shared/check.ts`, as the
existing ones do [S]. For the driver-backed ones,
`EXAMPLE_DRIVER` plus the URLs apply (CLAUDE.md "Running the examples").

---

## 13. Risks

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | **ECC is undocumented.** A Nest major could change it | low: unchanged since v6.2, kept in the root export by Nest 12, and endorsed for libraries [V, PA §9] | one internal module (`jobs/pipeline.ts`) holds every ECC call; a conformance test per enhancer type (§12.1) fails loudly on a change; `enhancers: false` is the escape hatch |
| R2 | **Nest 12 is ESM-only, needs Node ≥ 20, and is out** (12.0.0 shipped 2026-08-27; 12.1.2 is latest) [V, PA §9]. bun-nest peers `^11` | certain, for the question | the design uses only what is identical in 11 and 12 [V]. Supporting 12 is bun-nest's own decision, not this plan's (Q9). The two deep imports (`@nestjs/common/constants`, `route-params.decorator`) are avoided as §7.1 says |
| R3 | **Bun reads `experimentalDecorators` and `emitDecoratorMetadata` from the working directory's `tsconfig.json`, not the file's.** With them off, parameter decorators are silently not applied, and Nest injects `undefined` [M, `results-decorator-config.txt`] | real: it hit the spikes. Any app run from a directory whose tsconfig lacks the flags | the README states it: run from the app's root, or put the flags in the root tsconfig. The module checks at bootstrap that `design:paramtypes` exists on one of its own decorated classes, and throws a `ConfigError` naming the cause if not (cheap, and it turns `undefined` injection into a message). **Reported upstream** on oven-sh/bun#28605 (below) |
| R4 | `reflect-metadata` must be loaded once, before decorators run | as for any Nest app | `@nestjs/core` imports it itself [S, `node_modules/@nestjs/core/index.d.ts:1`]; the README keeps Nest's usual `import "reflect-metadata"` |
| R5 | **The per-instance drain hook** is an own property on a user's instance | low | documented; chained to the class's own `onModuleDestroy`; `JobsHost` offers the explicit form; a test asserts the user's hook still runs, once |
| R6 | **Global enhancers written for HTTP break jobs** (D4) | high on first use | the README's first pipeline paragraph; a bootstrap `debug` line listing the global guards that will apply to jobs |
| R7 | **A DI processor off-thread is expensive** (~115–130 ms per attempt for a trivial module [M]) | certain, if used | refused for `@Process`; offered only as `createProcessorContext` in a file, with the number in its JSDoc; a warm pool deferred (Q11) |
| R8 | **Request scope costs 35–80 µs per job** [M] | certain, if used | opt-in only; documented with the number |
| R9 | A filter returning a value silently completes a failed job (D6) | medium | the README and `BaseJobExceptionFilter`'s JSDoc say it first |
| R10 | **Raw-`.ts` packaging**: bun-nest ships sources, so a consumer compiles `./jobs`; any new peer leaking into `./jobs` breaks apps without it | low | `checkPeerScopes`, `consumer-check.json` `peers`, the barrel-isolation test extended to the new subpaths (§3.5) |
| R11 | Two scheduling systems in one app (`@nestjs/schedule` and ours) confuse users | medium | the §8.3 table in the README |
| R12 | Event listeners' errors swallowed | — | wrapped and logged (§6.1) |
| R13 | Nest's `ExternalExceptionFilter` logs every unfiltered job error with its stack, per attempt [M] | certain | Q5 |

**The Bun issue (R3).** The reproduction is Bun-only, with no Nest:
a parameter decorator applies when run from the directory whose tsconfig
enables `experimentalDecorators`, and does not when the same file is run
from its parent. It exits 1 while the bug is present. oven-sh/bun was
searched for "experimentalDecorators", "emitDecoratorMetadata",
"decorators tsconfig working directory" and "tsconfig nearest file":

- **#28605** reports the same lookup for `jsxImportSource` ("jsxImportSource
  from nested tsconfig ignored when running from workspace root").
- **#6326** (decorator metadata with `extends`) does not reproduce here:
  `extends` works [M].

The session reproduced it on `1.4.3-canary.1+bbdc5a519` and, as the same
root cause, added it to #28605 as a comment rather than a duplicate issue:
<https://github.com/oven-sh/bun/issues/28605#issuecomment-6091707278>. A fix
PR for #28605, #28606, mentioned decorator settings but was closed
unmerged. The workaround above goes once a stable Bun fixes it; when PR-n1
lands, it gets a `docs/bun-bugs/` entry naming #28605.

---

## 14. Open questions for the user

Each has a recommendation. **Q1, Q4, Q5 and Q9 shape the API**, and are the
ones to answer before PR-n2.

| # | Question | Recommendation |
|---|---|---|
| **Q1** | Workers per **class** (`@Processor` + `@Process(name)`), or per **method** (`@QueueWorker(queue)` on any service method)? | **Per class** (§5.1). A per-method worker claims other methods' jobs and fails them, because a bun-jobs worker claims any name on its queue. The user's "a method in a service" is met by putting `@Processor` on the service |
| Q2 | Ship on `./jobs` (plus `./jobs-ui`, `./jobs/terminus` and `./jobs/testing`), or as a new package? | **`./jobs` and the three subpaths** (§3.5) |
| **Q3** | Global enhancers apply to jobs (Nest's semantics), or should the module exclude them? | **Apply, with the `getType()` idiom documented** (D4). Excluding them needs Nest internals; `enhancers: false` remains |
| **Q4** | A guard's denial: dead at once (`JobForbiddenError`), or retried like any error? | **Dead at once by default**; `onDenied: "retry"` per processor (§7.5) |
| **Q5** | Nest logs every unfiltered job error at `error`, with a stack, per attempt (measured). Keep that, as microservices do, or replace it? | **Keep it for v1.** Replacing it means calling ECC with `filters: false` and invoking the user's filters ourselves. That needs `ExternalExceptionFilterContext`, which is not exported from `@nestjs/core`'s root (`node_modules/@nestjs/core/exceptions/index.d.ts:1` exports only `BaseExceptionFilter`) [S], so it is a deep import of an internal. That is the cost D4 declines elsewhere. For apps that want less noise, the README shows a catch-all `@Catch()` filter, applied with `@UseFilters` on a processor class, that rethrows. A filter that matches means Nest's logging fallback never runs. It shadows global filters for that class only, and the README says so. Revisit if Nest exposes the handler |
| Q6 | `REQUEST` in a request-scoped processor: the job (bullmq parity), or a `{ job, ctx }` pair? | **The job**, for parity, with the context via `@JobContext()` |
| Q7 | The same-module caveat (§6.3 F): document it, or also drain every worker at the very start of `close()`? There is no public hook earlier than the first `onModuleDestroy` | **Document it** and keep the measured per-instance drain. A pre-close hook would need patching `app.close`. Revisit if Nest 12's `beforeClose` (on the HTTP adapter) proves usable: bun-nest owns that adapter |
| Q8 | `@Cron` series removed from the code: warn only, or prune at boot? | **Warn by default; prune with `pruneSchedules: true`** (§8.2) |
| **Q9** | Support Nest 12 (ESM-only) in this work, or separately? | **Separately**, as a bun-nest decision. This design runs on both [V] |
| Q10 | The decorator for the whole job: `@CurrentJob()` (no clash with the `Job` type), or `@Job()` (bullmq users' guess)? | **`@CurrentJob()`** |
| Q11 | Off-thread DI: only `createProcessorContext` (per-attempt bootstrap), or also a warm-pool target? | **The helper now; the pool later**, as its own plan, under the runner-review rules |
| Q12 | `@Cron` / `@Every`, or `@JobCron` / `@JobEvery` to avoid clashing with `@nestjs/schedule` on import? | **`@Cron` and `@Every`**: the clash is an import alias, and users reach for `@Cron` first. Weak preference; the user's call |
| Q13 | Build the module with `ConfigurableModuleBuilder` (gaining `useClass` and `useExisting`), when `BunJobsApiModule` hand-writes `useFactory` only? | **`ConfigurableModuleBuilder`** for the new module. Leave `BunJobsApiModule` as it is |
| Q14 | Two `registerQueue` calls for one queue with different options: a `ConfigError` at bootstrap, or bun-jobs' one warning? | **`ConfigError`** (§4.1) |
| Q15 | A job whose name no processor in this process handles: `dead` at once, or bun-jobs' retryable `ConfigError` (left for "a deployment that does define it")? | **`dead` at once** for `@Processor` queues, which are per-service by design. The registry (`@DefineJob`) keeps bun-jobs' rule unchanged |
| Q16 | Add `class-validator` and `class-transformer` as bun-nest devDependencies, so the `ValidationPipe` path is tested? | **Yes**: devDependencies only, for one test |

---

## 15. PR slicing and effort

Focused days for someone who knows the code, as in the other plans. Every
PR is in `packages/bun-nest/**`: built by the bun-nest agent, or by the
features agent under its review, while that role is unfilled
(`docs/agentic-setup.md`). Each passes bun-nest's full gate alone:
`bun scripts/typecheck.ts`, `CI=1 bunx eslint .`, `bun run test`,
`bun scripts/consumer-check.ts packages/bun-nest`, and
`examples/bun-nest`'s `run-all.ts`. Each sends the examples agent a CHANGE
REPORT. None changes `packages/bun-jobs/**`.

| PR | What it ships | Depends on | Effort | Other owners |
|---|---|---|---|---|
| **PR-n1** core module and producers | `BunJobsModule` (`forRoot`, `forRootAsync`, `registerQueue`, `registerQueueAsync`, named contexts, Nest logger default, build-or-borrow, `onApplicationShutdown` close); tokens and `getQueueToken`/`getBunJobsToken`; `@InjectQueue`, `@InjectBunJobs`; `@QueueToken` typed classes; the options-conflict check; README section; consumer-check entries | — | ~3 d | examples ~1 d |
| **PR-n2** consumers and lifecycle | `@Processor`, `@Process` (names, catch-all, per-name limits); the explorer (discovery, one worker per queue, merge rules); `JobsHost`; request scope (public API); `registerWorker`; `autoStart` and `BunJobsLifecycle`; per-instance and fallback drains; `@InjectWorker`; `shutdown`; `@DefineJob` | PR-n1 | ~4 d | examples ~1 d |
| **PR-n3** the pipeline | ECC wrapping under `"bun-jobs"`; `BunJobsExecutionContext`, `isBunJobsContext`, `BunJobsContextType`; nine parameter decorators and the all-or-none check; `JobForbiddenError` and `onDenied`; `UnrecoverableOn`, `BaseJobExceptionFilter`; `StandardSchemaPipe` (root export); `JobLoggingInterceptor`; Q5's answer; `enhancers: false`; the type tests | PR-n2 | ~4 d | examples ~1 d; bun-common: optional `validateStandard` |
| **PR-n4** events | `@OnWorkerEvent`, `@OnQueueEvent`, `@OnJobsEvent`, `@OnRunnerEvent`; `@InjectJobsNotifier`; listener error wrapping; typed listener signatures | PR-n2 | ~2 d | — |
| **PR-n5** scheduling and runners | `@Cron`, `@Every`; the schedule queue; validation at boot; undeclared-series warn and `pruneSchedules`; `registerRunner`, `@InjectRunner` | PR-n2 (PR-n4 for `@OnRunnerEvent`) | ~3 d | examples ~0.5 d |
| **PR-n6** API, guards, UI | `BunJobsApiModule.jobs` optional; `guardsAuthorize`, `jobsApiContextOf`; `./jobs-ui` with `BunJobsUiModule` (consumer-check `peers`, barrel isolation) | PR-n1 | ~2 d | bun-jobs-ui agent review ~0.5 d |
| **PR-n7** summoned, off-thread, remote | `runSummonedApplication`; `createProcessorContext`; `@InjectSummonController`, `registerQueue({ summon })`; `@RemoteHandler`, `BunRemoteExecutorModule` | PR-n2 | ~3 d | bun-jobs agent review (summon and remote) |
| **PR-n8** testing | `./jobs/testing`: `BunJobsTestingModule`, `runJob`, `drainJobs` | PR-n3 | ~2 d | — |
| **PR-n9** terminus | `./jobs/terminus`: `BunJobsHealthIndicator`, `BunJobsHealthModule`; `@nestjs/terminus` as an optional peer and a devDependency | PR-n1 | ~1 d | — |
| **PR-n10** playground | a Nest app beside the playground's adapter showing processors, cron and the pipeline (the playground rule) | PR-n3 | ~1 d | bun-jobs-ui agent review |
| | **Total** | | **~25 d** | ~4.5 d |

**Order:**

1. PR-n1 → PR-n2 → PR-n3.
2. Then PR-n4, PR-n5, PR-n7 and PR-n8, which do not touch each other's
   files. PR-n6 and PR-n9 can go any time after PR-n1.
3. PR-n10 last.

**The smallest useful release is PR-n1 to PR-n3** (~11 d): modules,
injection, processors and the pipeline. That is the user's literal request.

**Not in this plan:**

- the warm-pool target (Q11);
- Nest 12 support (Q9);
- `BunJobsGatewayModule`, which is GW's PR-g2.

---

## 16. Names needing approval

Every new public name. All are on `@kingsleyweb/bun-nest/jobs`, unless the
table says otherwise.

| Name | Kind | Why this name |
|---|---|---|
| `BunJobsModule` (`forRoot`, `forRootAsync`, `registerQueue`, `registerQueueAsync`, `registerWorker`, `registerRunner`) | module | beside `BunJobsApiModule`; `registerQueue` is bullmq's verb |
| `BunJobsModuleOptions`, `BunJobsModuleAsyncOptions`, `RegisterQueueOptions`, `RegisterWorkerOptions`, `RegisterRunnerOptions` | types | |
| module options `isGlobal`, `jobs`, `name`, `autoStart`, `shutdown`, `enhancers`, `scheduleQueue`, `pruneSchedules`, `token` | options | |
| `getBunJobsToken`, `getQueueToken`, `getRunnerToken` | functions | bullmq's `getQueueToken` |
| `InjectQueue`, `InjectBunJobs`, `InjectJobsNotifier`, `InjectRunner`, `InjectWorker`, `InjectSummonController` | decorators | `Inject*` per Nest convention |
| `QueueToken` | class decorator | names the typed token's queue |
| `Processor`, `Process` | decorators | bullmq and bull users' names |
| `ProcessorOptions` (+ `scope`, `context`, `enhancers`, `onDenied`), `ProcessOptions` (`concurrency`, `rate`) | types | |
| `JobsHost` | abstract class | bullmq's `WorkerHost`, named for jobs |
| `WorkerRef` | class | what `@InjectWorker` injects |
| `DefineJob` | method decorator | `jobs.define()` |
| `BunJobsLifecycle` (`start()`, `stop()`) | provider | `autoStart: false`'s other half |
| `OnWorkerEvent`, `OnQueueEvent`, `OnJobsEvent`, `OnRunnerEvent` | decorators | bullmq's first two |
| `Cron`, `Every` | decorators | Q12 |
| `CronOptions`, `EveryOptions` | types | |
| `JobData`, `JobId`, `JobName`, `CurrentJob`, `JobContext`, `JobSignal`, `JobProgress`, `JobLogger`, `JobAttempt` | parameter decorators | Q10 for `CurrentJob` |
| `JobProgressFn` | type | |
| `BunJobsExecutionContext`, `BunJobsContextType`, `isBunJobsContext`, `isBunJob` | class, type, functions | GraphQL's `GqlExecutionContext` pattern |
| `JobForbiddenError` | error | its `name` is `UnrecoverableJobError` (§7.5) |
| `UnrecoverableOn`, `BaseJobExceptionFilter` | filter factory, base class | |
| `JobLoggingInterceptor` | interceptor | |
| `StandardSchemaPipe` | pipe, **root** export of bun-nest | useful in controllers too |
| `guardsAuthorize`, `jobsApiContextOf` | functions | |
| `createProcessorContext` | function | |
| `runSummonedApplication` | function | `runSummoned` for a Nest module |
| `RemoteHandler`, `BunRemoteExecutorModule` | decorator, module | |
| `BunJobsUiModule` | module, on **`./jobs-ui`** | |
| `BunJobsHealthIndicator`, `BunJobsHealthModule`, `isHealthy` options (`queues`, `maxOutstanding`, `requireWorkers`, `timeout`) | indicator, module, on **`./jobs/terminus`** | |
| `BunJobsTestingModule`, `runJob`, `drainJobs`, `RunJobOutcome` | module, functions, type, on **`./jobs/testing`** | |
| `./jobs-ui`, `./jobs/terminus`, `./jobs/testing` (+ `./lib/...` spellings) | package entries | §3.5 |
| metadata keys `bun-jobs:*` | internal strings | not exported; listed because they are visible to `Reflect` |

Two names are suggested to other owners, and are theirs to accept:

- **`validateStandard`**, in bun-common (§7.4).
- **`BunJobsGatewayModule`**, already in GW §12.

---

## Appendix: evidence

[`evidence/nest-jobs-decorators/`](evidence/nest-jobs-decorators/README.md)
holds the prototype, the seven spikes, their raw output and the prior-art
notes (`prior-art.md`). Like the other evidence folders, nothing in it is part
of a package, and the repo's tooling does not typecheck or lint it. It has
its own `tsconfig.json`, because of R3.
