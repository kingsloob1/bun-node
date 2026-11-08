# bun-jobs in NestJS: modules, decorators and the Nest pipeline for jobs

Implementation plan for integrating `@kingsleyweb/bun-jobs` into NestJS
through `@kingsleyweb/bun-nest`. The user asked for this on 2026-10-10:

> "a detailed plan on how to incorporate bun jobs with decorators for nest js.
> So a method in a service can be marked as a worker, helper injects to inject
> queues, etc. The plan should also look for ways to incorporate all of
> bun-jobs functionalities to nest js using decorators, guards, interceptors,
> pipelines, etc as the case maybe."

Written 2026-10-10 against `develop` at `bbe1120`, and **refreshed
2026-11-08 against `b1a9f80b`** (3.0.0-rc.1 published). **No product code
was changed.** Every `file:line` is now at `b1a9f80b`, relative to the repo
root, unless it is marked as being at `bbe1120`.
The evidence is in
[`evidence/`](evidence/README.md),
and every measurement there can be re-run with one command.
It includes a throwaway prototype (`proto.ts`), about 250 lines, that runs
the real Nest pipeline around real bun-jobs workers. The prototype is
evidence that the design works, not the design itself.

### Refreshed 2026-11-08: what changed

The user wants this plan refreshed and then built, starting with PR-n1 to
PR-n3. The prototype was re-run on Nest **12.2.0** (the repo's lock) and
**11.2.7** (a `scripts/nest-matrix.ts` copy), on Bun
`1.4.4-canary.1+11c367163`, and a new spike (`evidence/refresh.ts`) checks
what the refresh adds [M, `evidence/rerun-2026-11-08/`]. The core design
holds on both majors unchanged: the pipeline, the global enhancers, the
per-instance drain, request scope, guards as `authorize`, the type tokens.
What changed, and where:

- **Validation is bun-validate V6's, already merged** (#501). bun-nest's root
  exports `StandardSchemaPipe`, `SchemaDto`, `StandardValidationPipe`,
  `StandardValidationException` and `ValidationExceptionFilter`, and its own
  test runs them under ECC with the context type `"bun-jobs"`. This plan no
  longer ships a pipe: §7.4 is rewritten around V6. **`@JobData()` is
  recorded as Nest's BODY parameter type**, as microservices' `@Payload()`
  is, so global pipes treat job data as a body (measured, D13). bun-jobs'
  own job schemas (V5) are the first line, and a pipe the second (§7.4).
- **The UI module is dropped** (D11, Q17). `@kingsleyweb/bun-jobs-ui` is gone,
  folded into `@kingsleyweb/bun-ui/jobs` (#708–#710, #713), and the repo now
  says in two places that the jobs UI under Nest has no module. `./jobs-ui`
  and `BunJobsUiModule` are withdrawn in favour of the documented
  `adapter.use()` recipe, with `guardsAuthorize` usable for the UI's
  `authorize` too (§9.5).
- **Nest 11 and 12 are both supported** (`^11.1.20 || ^12.0.0`,
  [`nestjs-12-parity/`](../nestjs-12-parity/README.md)). Q9 is resolved, and
  every PR runs the 11.2.7 matrix column. One behaviour differs between
  majors: **Nest 12 runs a module's hooks in dependency order**, so the
  same-module drain caveat (§6.3 F) is gone on 12 and stays on 11 (measured;
  Q7 resolved). Nest 12.2 also adds `StandardSchemaValidationPipe` and
  `@Body({ schema })`; §7.4 says how `@JobData({ schema })` relates.
- **bun-nest's newer modules set the conventions** (§2.3): decorators and
  injection applied **by call** with explicit tokens (oven-sh/bun#28605,
  R3), modules written by hand with `useFactory`/`useClass`/`useExisting`
  (`BunThrottlerModule`), boot checks that collect every problem into one
  bun-common `ConfigError`, and enhancers that pass through a non-HTTP
  context. Q13's recommendation changes to the hand-written form.
- **bun-jobs grew** (§2.2): job schemas and `JobDataValidationError`,
  `JobsClosedError`, summon shared units, typed flow children, the closed
  `ApiErrorCode` and `x-bun-errors` (#648), origin checks that follow the
  app's `trustProxy` (#691), the repeat race fix with `updateRepeat` (#693),
  and `parseDuration` from bun-common (#692). None of it needs a new Nest
  surface; it passes through, and §2.2's map says where.
- **One claim was wrong** (§5.5): `ContextIdFactory.getByRequest(job)` writes
  nothing on the job (measured; Nest's HTTP router is what attaches the
  context id).
- **§14** keeps 14 questions with refreshed recommendations, resolves Q7 and
  Q9, and adds Q17 to Q19. **§15** is ~23 d (was ~25 d); PR-n1 to PR-n3 are
  ~9.5 d. **§16** drops `StandardSchemaPipe`, `BunJobsUiModule` and
  `./jobs-ui`.

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
| **[S]** | Read in this repo's source at `b1a9f80b` (2026-11-08), or at `bbe1120` where the text says so. The `file:line` is given. `node_modules/@nestjs/*` paths are Nest 12.2.0 unless a version is named |
| **[M]** | Measured here by a spike that can be re-run. The evidence file is named; `rerun-2026-11-08/` holds the refresh's runs on Nest 12.2.0 and 11.2.7 |
| **[V]** | Read on 2026-10-10 in a primary source: a packed npm tarball or the docs repo. Collected, with quotes and links, in [`evidence/prior-art.md`](evidence/prior-art.md) (**PA** below). Not re-read in the refresh, except where a Nest source is cited as [S] |
| **[I]** | Inference. A claim to test, never a finding |
| **[U]** | Unverified. Nothing may rest on it |
| **[D]** | A design decision this plan proposes |

**ECC** is Nest's `ExternalContextCreator`. **GW** is
[`worker-gateway-and-isolation.md`](../worker-runtimes/worker-gateway-and-isolation.md), **WR**
is [`worker-runtimes/README.md`](../worker-runtimes/README.md), and **OT** is
[`opentelemetry/README.md`](../opentelemetry/README.md).

---

## 1. Executive summary

### 1.1 The one-paragraph answer

**Yes: a method in a Nest service can be a bun-jobs worker, behind the
same guards, interceptors, pipes and filters as a controller.** Nest has a
supported seam for this: `ExternalContextCreator` (ECC). `@nestjs/graphql`
and `@golevelup/nestjs-rabbitmq` run their handlers through it, and
`@nestjs/bullmq` does not [V, PA §1, §7].

The prototype measured it [M, `results-pipeline.txt`], and the refresh
measured it again on Nest 12.2.0 and 11.2.7 with the same outcome in every
case [M, `rerun-2026-11-08/pipeline-*.txt`]. Around a bun-jobs handler,
under a context type of our own, `"bun-jobs"`, all of these ran:

- a guard reading `Reflector` metadata;
- a pipe validating `@JobData()` against a Standard Schema, and bun-validate
  V6's `StandardSchemaPipe` and global `StandardValidationPipe` doing the
  same [M, `rerun-2026-11-08/refresh-*.txt`];
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
   - the management API's `authorize`, and the jobs UI's, decided by Nest
     guards (the UI itself keeps its documented `adapter.use()` recipe, with
     no module: Q17);
   - summoned-worker and remote-executor helpers;
   - a terminus health indicator;
   - a testing module.

Validation is not a layer of its own any more: bun-validate V6 put it in
bun-nest's root (§7.4), and bun-jobs V5 put job schemas in the queue and the
worker (§2.2).

### 1.2 The decisions

| # | Decision | Why |
|---|---|---|
| D1 | **One worker per queue, dispatching on `job.name` to the `@Process(name)` methods of the `@Processor` classes on that queue.** No method-level workers. | A bun-jobs worker claims **every** job on its queue, whatever its name: `BunQueueWorkerOptions` has no name filter (`packages/bun-jobs/lib/queue/types.ts:1119-1422`; its `name` only names the worker, `:1182`) [S]. `BunJobs.start()` fails a name it has no handler for with a retryable `ConfigError` (`packages/bun-jobs/lib/BunJobs.ts:1478-1487`) [S]. So one worker per method would claim the other methods' jobs and fail them. `@nestjs/bull` had a worker per method, and `@nestjs/bullmq` dropped that because "it caused confusion" [V, PA §2]. §5.1 |
| D2 | **Handlers run through ECC under the context type `"bun-jobs"`**, with parameters stored under Nest's own `ROUTE_ARGS_METADATA`. | It is the seam Nest's maintainer points library authors to (nestjs/nest#9017) [V, PA §9]. Its `create()` signature is the same in 11.2.7 and 12.2.0, and it is still a root export of `@nestjs/core` on 12.2.0 (`node_modules/@nestjs/core/helpers/index.d.ts:2`) [S]. Using Nest's own metadata key is what lets a user's `createParamDecorator` work on a job, measured on both majors [M]. §7.1 |
| D3 | **Workers start in `onApplicationBootstrap`.** Each processor's worker drains **in its own instance's `onModuleDestroy`**, with a fallback drain in the jobs module. | `onApplicationBootstrap` comes after every `onModuleInit`, so connections opened there are ready. bullmq starts workers inside `onModuleInit` [V, PA §1]. Of eight measured drain points, only the per-instance one let a job in flight finish against a service in an imported or global module, on Nest 11 and on 12 [M, `results-lifecycle.txt`, `rerun-2026-11-08/lifecycle-*.txt`]. On Nest 12 it also covers a service in the processor's own module, because 12 runs a module's hooks in dependency order. §6.3 |
| D4 | **Global enhancers apply to jobs, as Nest applies them to microservices and GraphQL.** The docs give the `getType()` idiom. | ECC copies `APP_GUARD` and `useGlobal*` when a handler is built, and nothing public can exclude them [V, PA §7]; measured on both majors [M]. Fighting it would need Nest internals. bun-nest's own global enhancers already pass a non-HTTP context through (§2.3). §7.6 |
| D5 | **A guard's denial ends the job, with no retry**, as a `JobForbiddenError` that bun-jobs treats as unrecoverable. It can be configured per processor (Q4). | Measured, a denial is ECC's `ForbiddenException`, which bun-jobs retried until its attempts ran out [M]. A retry asks the same guard the same question. §7.5 |
| D6 | **A filter that returns a value completes the job with that value.** That is Nest's semantics, and it is documented loudly. A shipped `UnrecoverableOn(...)` filter covers the common mapping. | Measured [M]. Changing it would mean replacing Nest's exception proxy. §7.5 |
| D7 | **Request-scoped processors use only public API**: `ContextIdFactory.getByRequest(job)`, `registerRequestByContextId` and `moduleRef.resolve`, as `@nestjs/cqrs` does. `REQUEST` is the job. | bullmq does this through Nest's internal `Injector` [V, PA §1]. The public route measured about 35 to 80 µs per job extra [M], and a durable strategy sees the `Job` on both majors [M, `rerun-2026-11-08/refresh-*.txt`]. §5.5 |
| D8 | **DI processors run in-process only.** Off-thread work stays a processor **file**, with a helper that builds a Nest context inside it. The per-attempt cost is stated: about 115 to 130 ms on top of bun-jobs' own ~135 ms. | A function cannot cross to another thread or process (`packages/bun-jobs/lib/queue/workerTarget.ts:545-550`) [S]. bun-jobs starts a fresh thread or process per attempt, so the whole Nest bootstrap is paid every time [M, `results-boot-cost.txt`, not re-run]. §5.4 |
| D9 | **`@Cron` and `@Every` are bun-jobs repeat jobs: once per occurrence across every replica.** They coexist with `@nestjs/schedule` and do not replace it. | A repeat occurrence's id comes from the series key and its due time (`packages/bun-jobs/lib/queue/repeat.ts:20-32`), so several producers schedule it once [S]. #693 made advancing a series atomic (`updateRepeat`) without changing that. `@nestjs/schedule` runs a timer in every replica [V, PA §3]. §8 |
| D10 | **Typed queues use a named abstract class token**: `@QueueToken("emails") export abstract class EmailsQueue extends BunQueue<Email, string, "welcome"> {}`. | It is the injection token and the type at once: a wrong payload or name is a compile error. A factory returning an anonymous class fails declaration emit with `TS4094` [M, `results-types.txt`; re-run, `rerun-2026-11-08/types.txt`: now 64 of them]. §10 |
| D11 | **Everything ships on the existing `./jobs` subpath.** New subpaths only where a new optional peer starts: `./jobs/terminus` (`@nestjs/terminus`). Plus `./jobs/testing`, so test helpers stay out of the production import graph. **No `./jobs-ui`** (Q17). | `./jobs` already depends on bun-jobs alone, and `consumer-check.json`'s `peers`, the per-peer-set consumers (#666) and the barrel-isolation test already guard it (`packages/bun-nest/consumer-check.json:113-134`, `scripts/consumer-check.ts:45-52`, `packages/bun-nest/__tests__/jobsApiBarrelIsolation.nest.test.ts`) [S]. The UI has no Nest module by the repo's own documented choice (`examples/bun-nest/06-jobs-ui/mount.ts:11-12`) [S]. §3.5, §9.5 |
| D12 | **`BunJobsApiModule` is unchanged, and its `jobs` option becomes optional when `BunJobsModule` is imported.** Its `authorize`, and the jobs UI's, can be built from Nest guards with `guardsAuthorize(...)`. | That is additive. A guard decided `authorize` using only Nest's public `ExecutionContext` interface, on both majors [M, `results-authorize.txt`, `rerun-2026-11-08/authorize-*.txt`]. §9.4 |
| D13 | **Validation is bun-validate V6's** (`StandardSchemaPipe`, `SchemaDto` with `StandardValidationPipe`), and **`@JobData()` is recorded as Nest's BODY parameter type**, as microservices' `@Payload()` is. A validation failure ends the job with no retry (Q18). | V6 is merged and already tested under ECC as `"bun-jobs"` (`packages/bun-nest/__tests__/validationExternalContext.nest.test.ts`) [S]. Nest tells pipes `"body"` only for BODY; `StandardValidationPipe`, Nest's `ValidationPipe` and Nest 12's `StandardSchemaValidationPipe` all skip a `"custom"` parameter, measured [M, `rerun-2026-11-08/refresh-*.txt`]. `RpcParamtype.PAYLOAD` is 3 for the same reason (`node_modules/@nestjs/microservices/enums/rpc-paramtype.enum.js:3`) [S]. Q19. §7.3, §7.4 |
| D14 | **The module's own code follows bun-nest's current conventions**: `Module`, `Injectable` and `Inject` applied by call with explicit tokens, a hand-written `forRoot`/`forRootAsync` (Q13), boot checks collected into one bun-common `ConfigError`. | oven-sh/bun#28605 (R3) is still open and still reproduces on `1.4.4-canary.1+11c367163` [M, `rerun-2026-11-08/decorator-config.txt`]; every bun-nest module since `bbe1120` is written this way (§2.3) [S]. |

### 1.3 What it costs

| Part | Effort (bun-nest) | Other owners | Depends on |
|---|---|---|---|
| Core module and producers (PR-n1) | ~3 d | examples ~1 d | — |
| Consumers and lifecycle (PR-n2) | ~4 d | examples ~1 d | PR-n1 |
| The pipeline (PR-n3) | ~2.5 d | examples ~1 d | PR-n2 |
| Events (PR-n4) | ~2 d | — | PR-n2 |
| Scheduling and runners (PR-n5) | ~3 d | examples ~0.5 d | PR-n2 |
| API and guards as `authorize` (PR-n6) | ~1.5 d | examples ~0.5 d | PR-n1 |
| Summoned, off-thread and remote helpers (PR-n7) | ~3 d | bun-jobs review | PR-n2 |
| Testing utilities (PR-n8) | ~2 d | — | PR-n3 |
| Terminus indicator (PR-n9) | ~1 d | — | PR-n1 |
| Playground (PR-n10) | ~1 d | UI review | PR-n3 |
| **Total** | **~23 d** | **~4 d** | |

§15 has the PRs. Nothing in bun-jobs, bun-common or bun-ui needs to change
for any of it. The bun-common helper this plan once asked for,
`validateStandard`, exists (§7.4).

---

## 2. What exists today

### 2.1 bun-nest's `./jobs` subpath: the management API as a module

`@kingsleyweb/bun-nest/jobs` exports `BunJobsApiModule` (`forRoot`,
`forRootAsync`), `InjectJobsApi`, and the tokens `BUN_JOBS_API` and
`BUN_JOBS_API_OPTIONS` (`packages/bun-nest/lib/jobs/index.ts:28-34`), and
re-exports the types `JobsApi`, `JobsApiAction`, `JobsApiAuthorize` and
`JobsApiConfig` from bun-jobs (`:42-47`) [S]. (The first version of this plan
cited `:220-239`; the file has 47 lines.) The tokens are plain `Symbol(...)`
(`lib/jobs/tokens.ts:10`, `:13`) [S]. The module does not build a `BunJobs`:
the app passes one, typically by injecting a `BunJobs` that the app provides
itself (`packages/bun-nest/README.md:2582`, "The jobs API module") [S].
`forRootAsync` takes `useFactory` only (`BunJobsApiModule.ts:57-67`), and
neither form sets `global` (`:136-162`) [S]. Its lifecycle hooks, unchanged
since `bbe1120`:

| Hook | What it does | Source |
|---|---|---|
| `onModuleInit` | mounts the router | `packages/bun-nest/lib/jobs/BunJobsApiModule.ts:165-167` [S] |
| `onApplicationBootstrap` | attaches the socket | `:171-181` [S] |
| `beforeApplicationShutdown` | closes the API, while the transport is still up | `:184-186` [S] |
| `onApplicationShutdown` | closes it again, harmlessly, for a host that skipped the earlier hook | `:189-191` [S] |

The reasons for each hook were measured when the module was built, and are
in its header comment (`:18-44`). Two details matter here:

- It is still written with `@Module({})` and `@Inject(...)` as syntax
  (`:113`, `:123-132`), with explicit tokens so that it "does not depend on
  `emitDecoratorMetadata`" (`:127-131`) [S]. Every module bun-nest has
  gained since applies them by call instead (§2.3).
- It throws no `ConfigError`. A non-Bun adapter gets a `TypeError`
  (`:99-102`) [S].

Packaging is the precedent this plan follows:

- bun-jobs is an **optional peer**, as is bun-cache since the `./cache` entry
  (`packages/bun-nest/package.json:106-136`) [S]. Nest is
  `^11.1.20 || ^12.0.0` (`:109-112`) [S].
- Only the `./jobs` and `./lib/jobs` entries reach bun-jobs [S].
- `consumer-check.json` marks those entries `"peers": ["@kingsleyweb/bun-jobs"]`
  (`packages/bun-nest/consumer-check.json:113-134`) [S].
- **Since #666, the consumer check installs one consumer per distinct peer
  set** (`scripts/consumer-check.ts:45-52`, `planConsumers` `:562-585`) [S].
  An entry is checked with exactly the optional peers it lists and none of
  the others, so `./jobs` is checked without bun-cache, and an entry that
  silently needs a second peer fails.
- The build's `checkPeerScopes` fails if any entry can reach a declaration
  that imports an optional peer it does not list
  (`packages/bun-nest/scripts/build-declarations.ts:273-341`) [S].
- `jobsApiBarrelIsolation.nest.test.ts` proves at runtime that the barrel
  loads without bun-jobs and without bun-cache, and that each subpath fails
  naming its own missing peer [S].

`decorators.ts` re-exports Nest's own `UploadedFile` and `UploadedFiles`
[S]. `interceptors.ts` is the multer-style upload interceptors [S]. Neither
touches jobs. Nothing in bun-nest's `lib/` uses ECC today; the only use is a
V6 test (§2.3) [S].

### 2.2 bun-jobs' public surface, and where each part lands

`packages/bun-jobs/lib/index.ts` (1,021 lines; 998 at `bbe1120`) and the
package README (9,027 lines; 7,939) were read again for this inventory [S].
Paths are under `packages/bun-jobs/` unless they say otherwise. Every
user-facing feature is listed below with the Nest surface this plan gives
it, or the reason it needs none. The subpath exports are unchanged since
`bbe1120`, and bun-jobs still depends on bun-common alone [S].

| bun-jobs feature | Where in bun-jobs [S] | Nest surface | § |
|---|---|---|---|
| `BunJobs`, the per-service context (namespace, driver, logger, defaults, `service`, `publishEvents`, `metrics`, `summon`, `workerControl`) | `lib/BunJobs.ts:372`; options `:95-212`. **New:** nothing can be built once `close()` begins (`JobsClosedError`, `lib/shared/errors.ts:437`) | `BunJobsModule.forRoot/forRootAsync` options; `@InjectBunJobs()`; the class `BunJobs` as a token | 3 |
| `jobs.queue(name, opts)` and `BunQueue` (add, addBulk, addFlow, builder verbs, defaults, limits, pause, drain, clean, retry, repeatables, job defaults) | `lib/BunJobs.ts:677-757`; `lib/queue/BunQueue.ts:385` | `registerQueue`; `@InjectQueue`; typed `@QueueToken` classes. The methods themselves need no surface | 4 |
| **Job schemas (new, bun-validate V5)**: `schema` and `dataValidation` on a queue, a worker and a definition; `JobDataValidationError`; `JobMapFromSchemas` | `lib/queue/jobSchema.ts:40`, `:131`, `:160`, `:219`; `lib/shared/errors.ts:168`; README `:1603` | none: passed through `registerQueue({ options })`, `@Processor(queue, options)` and `@DefineJob(name, opts)`. §7.4 says how they relate to pipes | 7.4 |
| Builder and drafts (`schedule/run/process/now/create`, `toQueue`) | `lib/BunJobs.ts:1215-1368`; `lib/queue/JobBuilder.ts:157`; `lib/queue/JobDraft.ts:57` | none: methods on the injected `BunJobs` or queue | 4.4 |
| Flows (`addFlow`, `getChildrenValues`, now typed: `Job<TData, TResult, TChildren>`) | `lib/queue/BunQueue.ts:1744`; `lib/queue/Job.ts:154`, `:734` | none for adding (a method). `@CurrentJob()` gives the handler `getChildrenValues()` | 4.4, 7.3 |
| `jobs.define(name, handler, opts)` (now with a schema overload) and `jobs.start()`, the registry | `lib/BunJobs.ts:1047-1082`, `:1455`; unknown name `:1478-1487` | `@DefineJob(name, opts)` on a method | 5.7 |
| `BunQueueWorker`: processor, concurrency, `target`, `lockDuration`, `deadLetterQueue`, `control`, `metrics`, … | `lib/queue/BunQueueWorker.ts:734`; options `lib/queue/types.ts:1119-1422` | `@Processor(queue, options)`; `@Process(name, { concurrency, rate })` | 5 |
| Per-name and queue limits (`setLimits`) | `lib/queue/BunQueue.ts:2334`; `lib/queue/limits.ts:44` | `@Process(name, { concurrency, rate })` stores per-name limits at bootstrap | 5.3 |
| Worker lifecycle: `pause`, `stop`, `close`, `state` | `lib/queue/BunQueueWorker.ts:1567-2043` | started and drained by the module; `@InjectWorker(ProcessorClass)` for the rest | 6 |
| Worker and queue events (`active`, `progress`, `completed`, `failed`, `retrying`, `dead`, `deadLettered`, `stalled`, `lockLost`, `drained`, …; 13 of them also as `event:name`) | `lib/queue/types.ts:1538-1714` | `@OnWorkerEvent`, `@OnQueueEvent` | 6.1 |
| `JobsNotifier`: cross-process events from queues, runners and workers | `lib/notifier.ts:99`; `lib/BunJobs.ts:1683` | `@OnJobsEvent`; `@InjectJobsNotifier()` | 6.1 |
| Repeat jobs (`repeat: { cron, every, tz, limit, key, catchUp }`), debounce, throttle. **New:** advancing a series is one atomic step (`updateRepeat`, #693); `every` reads durations through bun-common's `parseDuration` (#692) | `lib/queue/types.ts:62`, `:139-152`; `lib/queue/repeat.ts:30`, `:198`; `lib/queue/repeatControl.ts:246`; `lib/drivers/driver.ts:2843` | `@Cron`, `@Every` (§8); debounce and throttle are job options, with no surface | 8 |
| `BunRunner` and `BunRunnerManager`: run a file on a schedule or on demand | `lib/runner/BunRunner.ts:162`; `lib/runner/types.ts:836` (`file` is required) | `registerRunner`; `@InjectRunner(id)`; `@OnRunnerEvent` | 8.4 |
| Worker targets: in-process, worker-thread, child-process, container, custom | `lib/queue/workerTarget.ts:485-551` | the `target` option for **file** processors; `createProcessorContext()` for DI inside a file | 5.4 |
| Summoning (`summon` policies, groups, **shared units** (new), `runSummoned`, `summonedFromArgs`) | `lib/summon/types.ts:220`, `:482`; `lib/summon/groups.ts:33`; `lib/summon/group.ts`; `lib/summon/worker.ts:1686-1707`; `lib/summon/args.ts:239` | module option; `registerQueue({ summon })`; `runSummonedApplication()` | 9.1 |
| Remote executors (`createRemoteExecutor`) and the planned gateway (still not built: GW's PR-g2 is "Not started") | `lib/remote/index.ts:29`; `docs/plans/worker-runtimes/worker-gateway-and-isolation.md:60` | `@RemoteHandler(name)` with `BunRemoteExecutorModule`; the gateway module is GW's PR-g2 | 9.2 |
| Management API (`createJobsApi`, `authorize`, live-events socket). **New:** a closed `ApiErrorCode` and per-operation `x-bun-errors` (#648); origin and CSRF checks that follow the app's `trustProxy` (#691); OpenAPI, AsyncAPI and docs endpoints | `lib/api/createJobsApi.ts:210`; `lib/api/config.ts:77-156`, `:543`, `:578-598`; `lib/api/contract/types.ts:94`; `lib/api/contract/constants.ts:1105-1178`; `lib/api/spec/openapi.ts:244` | `BunJobsApiModule`, unchanged; `guardsAuthorize()` | 9.4 |
| The typed client (new): bun-ui's jobs screens call the API through `createClient` over a route map generated from `createJobsApi().openapi()` | `packages/bun-ui/app/jobs/api/typed.ts:49`; `packages/bun-ui/scripts/jobs/routes-openapi.ts:26-55` | none: it is the UI's, and works against the API whichever module mounts it | 9.4 |
| The jobs UI (`jobsUi()`, now `@kingsleyweb/bun-ui/jobs`) | `packages/bun-ui/lib/jobs/jobsUi.ts:707` | **none**: the documented `adapter.use()` recipe; `guardsAuthorize()` for its `authorize` (Q17) | 9.5 |
| Analytics and the `metrics` option | `lib/drivers/metrics.ts:910`; `lib/api/routes/analytics.ts:1204` | a module option only | 9.7 |
| Worker and runner control from another process (`jobs.workers.controller`, `jobs.runners.controller`) | `lib/BunJobs.ts:383-389`; `lib/queue/WorkerController.ts:609` | none: methods on the injected context | 9.10 |
| Logging (`LoggerLike`) | `packages/bun-common/lib/logging.ts:1027` (`resolveLogger`); `lib/BunJobs.ts:108` | defaults to a Nest `Logger`, detected by bun-common's `resolveLogger` | 3.4 |
| Errors (`JobsError` family, `UnrecoverableJobError`, **new** `JobDataValidationError`, `JobsClosedError`; bun-jobs' own `ConfigError`) | `lib/shared/errors.ts:34`, `:143`, `:168`, `:437`, `:478` | `UnrecoverableOn(...)` filter; `JobForbiddenError` | 7.5 |
| Drivers, driver configs, schema sync | `lib/drivers/driver.ts:101` (`ping`), `:116` (`syncSchema`); `lib/drivers/create-driver.ts:23` | module options (`driver`, `syncSchema` inside the config) | 3.2 |
| Dates in words (`dateParser`) | `lib/shared/humanTime.ts:396`; `lib/BunJobs.ts:125` | a module option | 3.2 |
| Shutdown | `lib/BunJobs.ts:1649` (`close`), `:1550` (`stop`) | the module's hooks | 6.3 |

### 2.3 What bun-nest and bun-common gained since `bbe1120`

None of this existed when the plan was written. Each item either removes
work from this plan or sets a convention the new module should follow.

| What | Where [S] | What it means here |
|---|---|---|
| **bun-validate V6**: `StandardSchemaPipe`, `SchemaDto` + global `StandardValidationPipe`, `StandardValidationException` (a `BadRequestException` with `{ target, message, path }` issues), `ValidationExceptionFilter`, `StandardValidationModule`, all at bun-nest's root | `packages/bun-nest/lib/validation.ts:313`, `:396`, `:452-488`, `:217-240`, `:682`, `:856`; plan `docs/plans/bun-validate/README.md:1808-1817` | §7.4 uses them as they are. Its header names "a job handler built with Nest's `ExternalContextCreator`" (`:6-7`), and `__tests__/validationExternalContext.nest.test.ts` runs both pipes under ECC as `"bun-jobs"`, with a `@JobData` recorded as BODY (`:25-50`, `:88-145`). `StandardValidationPipe` skips `"custom"` parameters (`:476`). `ValidationExceptionFilter` rethrows for any context type but `http`, `ws` and `rpc` (`:738-740`), so a global one leaves job errors alone |
| `validateStandard(schema, value, target, …)`, the single-value helper this plan asked bun-common for | `packages/bun-contract/lib/issues.ts:382`, exported from bun-common's root (`packages/bun-common/lib/index.ts:525`) | the ask is withdrawn: it exists |
| `BunThrottlerModule`, `@Throttle`, `@SkipThrottle`, `BunThrottlerGuard` (#656, #673) | `packages/bun-nest/lib/throttler/module.ts:225`; `guard.ts:254` | **the pattern for `BunJobsModule`**: a hand-written `forRoot` and `forRootAsync` with `useFactory`, `useClass` and `useExisting` (`module.ts:232-279`); options token `Symbol.for(...)` "so two copies of the package agree" (`:24-30`); a boot check in `onApplicationBootstrap` that collects every problem into one bun-common `ConfigError` (`:79-157`); Nest metadata keys read by value, not by deep import (`module.ts:33-35`). Its guard returns `true` for a non-HTTP context (`guard.ts:278`), so `globalGuard: true` never touches a job |
| `./cache`: `BunCacheModule`, `@InjectCache`, `@Cacheable`/`@CachePut`/`@CacheEvict` | `packages/bun-nest/lib/cache/BunCacheModule.ts:164`; `registry.ts:62` | the second optional-peer subpath beside `./jobs`; discovery through an injected `DiscoveryService` with `DiscoveryModule` imported (`registry.ts:153`, `:186`), which is what §5.2's explorer does too. Its interceptor passes non-HTTP contexts through (`interceptor.ts:346`) |
| `@Invalidates`, `@Describe`, `DevTypesModule` (typed-client N2–N4) | `packages/bun-nest/lib/invalidates.ts:155`; `devTypesModule.ts:233` | `@Invalidates`' interceptor skips non-HTTP contexts (`invalidates.ts:77`). The typed-client plan withdrew its `LiveModule` in favour of `app.use(...)` (`docs/plans/typed-client/nest-typed-routes.md:45`), the same choice as the jobs UI's (Q17) |
| **Decorators applied by call** | `packages/bun-nest/lib/throttler/guard.ts:550-556`; `cache/BunCacheModule.ts:240-246`; `devTypesModule.ts:213-220` | every module since `bbe1120` writes `Injectable()(Class)`, `Inject(TOKEN)(Class, undefined, 0)` and `Module({...})(Class)`, citing oven-sh/bun#28605, so bun-nest's own classes work whatever the working directory's tsconfig says (R3, D14) |
| `trustProxy` on both adapters | `packages/bun-common/lib/trustProxy.ts:40`; `packages/bun-nest/lib/BunHttpAdapter.ts:1211` | `guardsAuthorize`'s guards see `req.ip`, `req.protocol` and `req.hostname` as the app's `trustProxy` says, and so does the jobs API's origin check (#691) |
| `throttle()` in bun-common | `packages/bun-common/lib/throttle.ts:1011` | nothing for jobs: a job has bun-jobs' own `rate` and `throttle` options |
| `fetch({ remoteAddress })`, socket-free requests with a peer address | `packages/bun-common/lib/BunRouter.ts:642`; `packages/bun-nest/lib/BunHttpAdapter.ts:2125` | `./jobs/testing` and PR-n6's tests drive `guardsAuthorize` and IP-based guards without a socket (§9.9) |
| `parseDuration` and `toDurationMs` | `packages/bun-common/lib/utils/duration.ts:76`, `:132` | what bun-jobs' `every` reads, so `@Every("5 minutes")` means what bun-jobs means |
| Nest 12 support, and `beforeClose` on the adapter (503 during the shutdown hooks) | `docs/plans/nestjs-12-parity/README.md:20-28`; `packages/bun-nest/lib/BunHttpAdapter.ts:3395` | every PR here runs the 11.2.7 column, and its lifecycle tests assert per major (§6.3) |
| bun-common's `ConfigError` and bun-jobs' own `ConfigError` are two classes | `packages/bun-common/lib/errors.ts:19`; `packages/bun-jobs/lib/shared/errors.ts:478` | the module's boot checks throw bun-common's, as bun-nest's other modules do; errors bun-jobs throws pass through as they are |

### 2.4 Prior art, and what each piece teaches

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

- **Written by hand, the way `BunThrottlerModule` is** (Q13): `forRoot`, and
  `forRootAsync` with `useFactory` (+ `inject`, `imports`), `useClass` and
  `useExisting`, both built by one internal `moduleOf()` that returns the
  `DynamicModule` (`packages/bun-nest/lib/throttler/module.ts:160-199`,
  `:232-279`) [S]. A `forRootAsync` with none of the three is a bun-common
  `ConfigError` (`:263-266`) [S].
  - The first version recommended `ConfigurableModuleBuilder`. It still
    works: its `setExtras({ isGlobal: true }, …)` recipe gave `forRoot` and
    all three async forms, and a global module, on Nest 11.2.7 and 12.2.0
    [M, `rerun-2026-11-08/refresh-*.txt` case 1]. It is no longer the
    recommendation, for two reasons. **Named contexts** (§3.3) need one set
    of tokens per `name`, and the builder has one `MODULE_OPTIONS_TOKEN` per
    builder, so a wrapper would rewrite its providers anyway. And bun-nest's
    modules since `bbe1120` are all hand-written (§2.3).
  - The options token is `Symbol.for("@kingsleyweb/bun-nest/jobs:options")`
    (and `…:options:<name>` for a named context), as the throttler's and the
    cache's are, so two copies of the package agree.
  - Every class in the module applies `Module`, `Injectable` and `Inject` by
    call, with explicit tokens and no reliance on `design:paramtypes` (D14).
    That keeps bun-nest's own wiring correct when an app runs from a
    directory whose tsconfig lacks the decorator flags (R3). A user's
    processors still use decorator syntax; R3's boot check covers them.
  - `BunJobsApiModule` keeps its `useFactory`-only `forRootAsync`
    (`BunJobsApiModule.ts:57-67`) [S].
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

### 3.5 Packaging: grow `./jobs`, and two new subpaths [D]

| Entry | Holds | Peers it needs (`consumer-check.json`) | Why separate |
|---|---|---|---|
| `./jobs` (exists) | `BunJobsApiModule` (unchanged), `BunJobsModule`, every decorator, the explorer, `BunJobsExecutionContext`, the filters, `guardsAuthorize`, `createProcessorContext`, `runSummonedApplication`, `BunRemoteExecutorModule` | `@kingsleyweb/bun-jobs` | already where the dependency on bun-jobs starts. The validation pipes stay at bun-nest's root, where V6 put them |
| `./jobs/terminus` (new) | `BunJobsHealthIndicator`, `BunJobsHealthModule` | `@kingsleyweb/bun-jobs`, `@nestjs/terminus` | a second optional peer: a `./jobs` that reached `@nestjs/terminus` would break every app without it. Since #666 this entry gets a consumer of its own with exactly these two peers installed (§2.1) |
| `./jobs/testing` (new) | `BunJobsTestingModule`, `runJob`, `drainJobs` | `@kingsleyweb/bun-jobs` | keeps test helpers out of a production import graph, the way `@kingsleyweb/bun-jobs/provider/testing` does |

Each new entry follows the recipe in CLAUDE.md "Packaging types":

- `{ "@kingsleyweb/source", "types", "default" }`, in that order;
- explicit `./lib/...` keys;
- a `consumer-check.json` entry with its `peers`;
- a packaging test for the shape.

The barrel-isolation test gains `./jobs/terminus` beside the `./jobs` and
`./cache` cases it has. Each must fail by naming its own missing peer, and
the barrel must still load. `@nestjs/terminus` joins
`peerDependenciesMeta` as optional, and as a devDependency.

**No `./jobs-ui`.** The first version planned `BunJobsUiModule` on its own
subpath, with bun-jobs-ui as a second optional peer. bun-jobs-ui no longer
exists; its successor is `@kingsleyweb/bun-ui/jobs` (§2.2), which bun-nest
does not depend on in any way today. The repo's documented position is that
the UI has no Nest module, because it is a bun-common router that the
adapter mounts like the API (`examples/bun-nest/06-jobs-ui/mount.ts:11-12`,
`packages/bun-ui/__tests__/jobs/server/nest.nest.test.ts:2-3`,
`packages/bun-nest/README.md:440-467`), and bun-ui's own plan schedules
none (`docs/plans/bun-ui/README.md:542-548`) [S]. A module would reverse
that, and add bun-ui as a third optional peer of bun-nest for a
`jobsUi()` call and one `adapter.use()`. §9.5 keeps the recipe and adds
only `guardsAuthorize` for the UI's `authorize` (Q17).

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
  (`packages/bun-jobs/lib/BunJobs.ts:644-676`, `:701-757`, `#warnIgnoredQueueOptions` `:762`) [S]. Two
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
| `@InjectSummonController(queue, context?)` | `jobs.summonController(queue)` (`BunJobs.ts:810`) [S] | §9.1 |

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

- **How it gets `DiscoveryService`.** The module imports `DiscoveryModule`
  and injects `DiscoveryService` and `ExternalContextCreator` by token, as the
  prototype does on both majors [M] and as bun-nest's cache registry does
  (`packages/bun-nest/lib/cache/registry.ts:153`, `:186`) [S]. bun-nest has
  two other discovery styles, and both are avoided: the throttler's boot
  check reads Nest's internal `container` through `Reflect.get`
  (`lib/throttler/module.ts:94`), and gateway docs build
  `new DiscoveryService(ModulesContainer)` because Nest 12.2.0 does not
  auto-register it (`lib/gateway-docs.ts:211-231`) [S].
- **Boot checks are collected**, as the throttler's are (`module.ts:79-157`)
  [S]: every misconfiguration found in one pass (a controller processor, two
  catch-alls, an off-thread `target`, an undecorated parameter, a bad cron)
  is listed in one bun-common `ConfigError`, rather than the first one alone.
- **`useFactory` and `useValue` processors on Nest 11.** ECC finds a
  handler's module from the instance's class, and Nest 12.2 adds a fallback
  that finds the module whose provider holds the instance
  (`helpers/external-context-creator.js:54-56`, `getHostModuleKey`) [S]; Nest
  11.2.7 has no fallback. A factory-provided processor whose class is not
  also a provider somewhere may therefore lose its **module-scoped**
  enhancers on 11 [I]. PR-n3 tests one on both columns, and refuses it with a
  `ConfigError` on 11 if it does.

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
  - `id`, `key`, `name`, `service`;
  - the worker's job checks (bun-validate V5): `schema`, `dataValidation`
    and `resultValidation` (`WorkerValidationOptions`,
    `packages/bun-jobs/lib/queue/jobSchema.ts:160`) [S]. One worker serves
    the whole queue (below), so its `schema` covers every name on it; a
    per-name check is a pipe (§7.4).

  `target` is the exception: a `@Process` method can only run in-process,
  and any other `target` is refused at bootstrap (§5.4).

  `concurrency` stays changeable at runtime through `@InjectWorker(P)`, and
  through a remote configuration override (README "Controlling workers from
  another process") [S].
- **`ProcessOptions`** is `{ concurrency?, rate? }`: a per-name limit.
  At bootstrap, the explorer merges these into the queue's stored per-name
  limits. It uses the same merge-don't-replace rule as
  `#storeDefinitionLimits` (`BunJobs.ts:1513-1547`) [S]: the queue's rate,
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
  it. That is the registry's own rule (`BunJobs.ts:1478-1487`) [S], with an
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
  be sent to another process or Worker", `workerTarget.ts:545-550`), but earlier
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
    against 14 to 17 for a singleton [M, `results-scoped.txt`]. Re-run at
    2,000 jobs on Nest 12.2.0 and 11.2.7: 6,150 of 6,150 distinct, `REQUEST`
    the job in all, 32 to 49 µs per job against 12 to 21 for a singleton
    [M, `rerun-2026-11-08/scoped-*.txt`; indicative only, not a benchmark].
  - The prototype used `ContextIdFactory.create()`. The design uses
    `getByRequest(job)`, as bullmq does [V], so a durable `ContextIdStrategy`
    can attach a parent context. A tenant per job is the obvious use.
    Measured on both majors: the strategy received the `Job` (it read
    `data.tenant`), and **`getByRequest` wrote nothing on the job**: no own
    symbol property, nothing in `JSON.stringify(job)`
    [M, `rerun-2026-11-08/refresh-*.txt` case 2]. It only reads
    `request[REQUEST_CONTEXT_ID]` (`node_modules/@nestjs/core/helpers/context-id-factory.js:26-51`);
    what attaches that symbol for HTTP is Nest's router, non-enumerably
    (`router/router-explorer.js:274-275`) [S]. The first version of this plan
    said the opposite. The design attaches nothing either, so a provider
    calling `getByRequest(this.request)` itself inside a job's tree gets a
    fresh context, not the job's. That case is rare, and PR-n2 documents it
    rather than reaching for `REQUEST_CONTEXT_ID`, which is exported only
    from `@nestjs/core/internal` on 12 [S].
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
bun-jobs `Job` and `ProcessorContext` (`packages/bun-jobs/lib/queue/types.ts:1002-1026`) [S].
ECC passes the original arguments through when no parameter metadata exists
(`helpers/external-context-creator.js:77-82`) [S, `node_modules/@nestjs/core`, 12.2.0].
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
| `@OnWorkerEvent(event)` | the class's queue's worker, which classes on one queue share (§5.3) | a `@Processor` class | this process's worker. Events: `ready`, `active`, `progress`, `completed`, `failed`, `retrying`, `dead`, `deadLettered`, `stalled`, `lockLost`, `drained`, `paused`, `resumed`, `closing`, `closed`, `error` (`packages/bun-jobs/lib/queue/types.ts:1667-1714`), and the `event:name` scoped form, such as `completed:welcome`, of the 13 job events that have one (`added` … `throttled`, `JobScopedEvent`, `:1538-1551`; not `stalled`, `lockLost`, `drained` or the worker's own) [S]. The decorator's type refuses a scoped form of any other event |
| `@OnQueueEvent(queue, event, { context? })` | the injected queue's emitter | any singleton provider | that queue's events. These are local, unless the queue was registered with `subscribe: true`, in which case other processes' published events are re-emitted (README "Queue options") [S]. Events: `added`, `completed`, `failed`, `dead`, `retried`, `debounced`, `throttled`, `repeatScheduled`, `summon`, `cleaned`, … (`packages/bun-jobs/lib/queue/types.ts:1579-1657`) [S] |
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
  (`packages/bun-jobs/lib/shared/emitter.ts:166-179`) [S]. An `async` listener's rejection
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
  `node_modules/@nestjs/core/nest-application-context.js:336-342`; V, PA §6].
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
walks modules root first, global modules last
(`node_modules/@nestjs/core/nest-application-context.js:336-342`) [S]. **Within
one module the two majors differ** [S]:

- **Nest 11** (11.2.7) runs the providers' hooks **concurrently**
  (`Promise.all`, `hooks/on-module-destroy.hook.js:31-45` in the 11.2.7
  copy).
- **Nest 12** (12.0.0 and 12.2.0) groups them by **dependency depth**, the
  `hierarchyLevel` the injector records (`injector/injector.js:91`), and runs
  the groups one after another, dependents first on destroy and shutdown,
  dependencies first on init and bootstrap
  (`hooks/on-module-destroy.hook.js:30-38`, `hooks/utils/get-sorted-hierarchy-levels.js`).
  A rejected hook is logged and the close goes on (`Promise.allSettled`,
  `:38`), where 11 rejects `app.close()`.

Measured with two providers of one module, one depending on the other:
12.2.0 destroyed the dependent first and waited for it; 11.2.7 destroyed
the dependency first [M, `rerun-2026-11-08/refresh-*.txt` case 4]. The
question is where a worker must drain so that a job in flight finishes
before the services it uses are destroyed.

**Measured** [M, `results-lifecycle.txt` on 11.1.27; `rerun-2026-11-08/lifecycle-*.txt`
on 11.2.7 and 12.2.0]: a 300 ms job uses a database whose service closes it
in `onModuleDestroy`, and `app.close()` lands 50 ms in.

| | Drain point | Where the database service lives | Nest 11 | Nest 12 |
|---|---|---|---|---|
| A | jobs module, `onModuleDestroy` (module global) | same module as the processor | **failed** | **failed** |
| B | jobs module, `beforeApplicationShutdown` | a module the feature imports | **failed** | **failed** |
| C | jobs module, `onModuleDestroy` (module global) | a module the feature imports | **failed** | **failed** |
| D | jobs module, `onModuleDestroy` (module **not** global, imported by the root) | a module the feature imports | completed | completed |
| E | **each processor instance's own `onModuleDestroy`** | a module the feature imports | **completed** | **completed** |
| F | each processor instance's own `onModuleDestroy` | **the same module** as the processor | **failed** (destroyed concurrently) | **completed** (the processor depends on it, so it goes first) |
| H | each processor instance's own `onModuleDestroy` | a `@Global` module | **completed** | **completed** |
| G | jobs module, `onModuleDestroy` (module global) | a `@Global` module | **failed** | **failed** |

So:

1. **Each processor's worker drains in that processor instance's own
   `onModuleDestroy` slot** (E, H; and F on Nest 12).
   - The explorer installs a hook on the instance that closes the worker
     (`close({ timeout })`, §3.1's `shutdown`), then calls the class's own
     `onModuleDestroy`, if it has one. When classes share a queue's
     worker, the first of them to be destroyed closes it; `close()` is
     idempotent, and a later call resolves when the first finishes (README
     "Pause, resume and shutdown") [S].
   - A processor's dependencies live in modules it imports, or in global
     modules, and both are destroyed after it [M]. On Nest 12 that holds
     inside its own module too.
   - This is an own-property hook on a user instance. It is the one piece
     of "magic" in the design, so it is documented, and `JobsHost` (§11.3)
     offers an explicit alternative: a base class whose `onModuleDestroy`
     drains, for users who prefer to see it. Nest 12 finds the hook by
     property lookup at close, as 11 does, so an own property works on both
     [M].
2. **A fallback drain in the jobs module's `onModuleDestroy`** closes every
   worker not yet closed: request-scoped processors (no instance hooks,
   §5.5), `registerWorker` workers (§5.4), runners and the registry worker.
   It also closes the notifier.
3. **Queues stay open until `onApplicationShutdown`.** A provider's own
   `onModuleDestroy` may still enqueue a job, an "account closed" email
   for example. Then the context is closed, if the module built it (§3.2).
   After that, bun-jobs refuses a new queue or worker with
   `JobsClosedError` (`packages/bun-jobs/lib/shared/errors.ts:437`) [S], so a
   late `onApplicationShutdown` enqueue fails loudly rather than reopening
   a driver.
4. **The caveat (F) is Nest 11's only**: there, a resource provider in the
   *same* module as a processor is destroyed at the same time as the
   processor's worker drains. The docs say, for Nest 11: give the
   processor's resources their own module. That is Nest's own advice for
   lifecycle ordering, and the case is measured on both majors. Q7 is
   resolved by this: nothing more is built for it (§14).

**Signals.** Nest runs none of this on `SIGTERM` unless the app calls
`app.enableShutdownHooks()` [V, PA §6]. No public read of the setting exists
on either major: Nest 12.2's state is a private `shutdownCleanupRefs`
(`node_modules/@nestjs/core/nest-application-context.d.ts:22`) [S]. So the
module does not try to detect it; the README's quick start calls
`enableShutdownHooks()` and says why.

**Budget.** `shutdown.timeout` (default 30 s) is passed to each
`worker.close({ timeout })`. A job still running at the timeout has its
signal aborted, and its lock left to lapse for the stalled sweep (README
"Pause, resume and shutdown") [S]. A platform with a short grace period
(README "Shutdown budgets per platform") sets it lower.

**The adapter's `beforeClose`.** bun-nest's `BunHttpAdapter` implements
Nest 12's `beforeClose` and answers 503 while the shutdown hooks run
(`packages/bun-nest/lib/BunHttpAdapter.ts:3395`; gap G7 in `docs/plans/nestjs-12-parity/README.md:716-717`, closed by PR-6b, #447) [S]. So an
HTTP request that would enqueue a job during a drain gets a 503 rather than
a job added to a closing process. Nothing here depends on it.

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
the docs never mention it. Its signature is identical in 11.1.27 and 12.1.2
[V], and again in 11.2.7 and 12.2.0: the declarations differ only in `.js`
import specifiers, `getParamValue`'s parameter typed as `ArgumentMetadata`,
and a private `getHostModuleKey` that 12.2 adds (§5.2) [S,
`helpers/external-context-creator.d.ts` in both]. It is still exported from
the root on 12.2.0 (`helpers/index.d.ts:2`) [S]. Its release notes call it
"for 3rd-party libraries purposes" (v5.2.0), and Kamil Myśliwiec has pointed
library authors at it (nestjs/nest#9017) [V, PA §9]. §13 R1 weighs the risk.

Nest 12.2's ECC also passes a parameter's `schema` (Nest 12's
`@Body({ schema })`) through to the pipes (`helpers/external-context-creator.js:148-173`)
[S]. 11.2.7's does not. §7.4 says why the design does not depend on it.

The other imports, and their status:

| Import | Status |
|---|---|
| `ROUTE_ARGS_METADATA` and `SCOPE_OPTIONS_METADATA` | **defined by value**: `"__routeArguments__"` and `"scope:options"` (`node_modules/@nestjs/common/constants.js:15`, `:17`, the same in 11.2.7) [S]. The prototype's deep import of `@nestjs/common/constants.js` resolves on both majors (Nest 12's map has `./*.js`, `docs/plans/nestjs-12-parity/README.md:206-208`) [M], but bun-nest's throttler already reads Nest's keys by value (`lib/throttler/module.ts:33-35`) [S], and the new code does the same. A test asserts each value equals Nest's constant, so a rename fails loudly. |
| `assignMetadata` | a deep import from `route-params.decorator`. The prototype used it. The design re-implements its five lines, to avoid the path. |
| `ExecutionContextHost` and `Injector` | **not used** |

### 7.2 The context type and `BunJobsExecutionContext` [D]

`getType()` answers `"bun-jobs"` in guards, interceptors, pipes' parameter
factories and filters (`host.getType()`), measured in all four
[M, `results-pipeline.txt`]. Nest's `ContextType` is still
`'http' | 'ws' | 'rpc'` in 12.1.2 [V, PA §7] and in 12.2.0 (`node_modules/@nestjs/common/interfaces/features/arguments-host.interface.d.ts:1`) [S], so we follow `@nestjs/graphql`'s
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
| `@JobData(property?, ...pipes)`, or `@JobData({ property?, schema?, pipes? })` | `job.data`, or `job.data[property]` | yes. Like `@Body(property?, ...pipes)`, and recorded as Nest's **BODY** type, so pipes are told `"body"` (D13, Q19). `schema` adds V6's `StandardSchemaPipe(schema)` (§7.4) |
| `@JobId()` | `job.id` | yes |
| `@JobName()` | `job.name` | yes |
| `@CurrentJob()` | the `Job` itself: `log`, `updateProgress`, `getChildrenValues()` for flows, `extendLock`, `fail` | — |
| `@JobContext()` | the `ProcessorContext` | — |
| `@JobSignal()` | `ctx.signal`: aborted on timeout, worker close and lock loss | — |
| `@JobProgress()` | `(value) => job.updateProgress(value)`, a `JobProgressFn` | — |
| `@JobLogger()` | `ctx.logger`, bound to the job's ids | — |
| `@JobAttempt()` | `ctx.attempt`, from 1 | — |

- Each is stored under `ROUTE_ARGS_METADATA`, `@JobData` as BODY (3) and
  the others with our own numeric types, chosen above Nest's
  `RouteParamtypes` (0 to 15 on 12.2.0,
  `node_modules/@nestjs/common/enums/route-paramtypes.enum.d.ts`) [S] so
  they never meet one. Nest reports any type it does not know to pipes as
  `"custom"` (`node_modules/@nestjs/core/pipes/params-token-factory.js:3-14`)
  [S]. ECC asks our `ParamsFactory` for the value
  (`exchangeKeyForValue(type, data, [job, ctx])`) [S,
  `helpers/external-context-creator.js:164`]. Measured in the prototype for
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

### 7.4 Validating job data: bun-jobs' schemas first, V6's pipes second [D]

The first version of this plan designed a `StandardSchemaPipe` for bun-nest's
root, and asked bun-common for a single-value helper. Both now exist, built
by bun-validate (§2.3), and bun-jobs gained job schemas of its own. So this
section is about using them, and about the one choice that is the
integration's own: what Nest tells a pipe a job's data is.

**Two layers, and which to use.**

| Layer | Where | Checks | On failure |
|---|---|---|---|
| **bun-jobs' job schemas** (bun-validate V5) | `registerQueue({ options: { schema } })` at enqueue; `@Processor(queue, { schema })` before the handler; `@DefineJob(name, { schema })` per defined name (`packages/bun-jobs/lib/queue/jobSchema.ts:131`, `:160`) [S] | every job on the queue (one worker serves it all, §5.3), in **every** process that adds or runs it, Nest or not | enqueue: `JobDataValidationError`, nothing written; processing: the attempt fails as `UnrecoverableJobError` (`jobSchema.ts:55-60`) [S] |
| **V6's pipes** on a handler's parameter | `@JobData(new StandardSchemaPipe(S))`, `@JobData({ schema: S })`, or a `SchemaDto` type under a global `StandardValidationPipe` (`packages/bun-nest/lib/validation.ts:313`, `:396`, `:452`) [S] | one `@Process` method's input, after the guards, inside the Nest pipeline | `StandardValidationException`, a `BadRequestException` with `{ target, message, path }` issues (`validation.ts:217-240`) [S]; the integration ends the job without a retry (Q18) |

The README recommends the first for data that crosses a deployment
boundary, since it is checked at the producer too, and the second for a
per-name check on a queue that carries several names, or for a transform a
handler wants (`z.coerce.number()`).

**Measured** [M, `rerun-2026-11-08/refresh-*.txt` case 5], through the
prototype on Nest 12.2.0 and 11.2.7, identically:

| How | `{ to: "ada@…" }` | `{ to: 42 }` |
|---|---|---|
| `StandardSchemaPipe(Email)` on `@JobData`, recorded as BODY | completed | dead, `StandardValidationException`, issues `[{ target: "body", message: "to must be a string", path: "to" }]` |
| the same, recorded as one of our own types | completed | dead, the same, with `target: "custom"` |
| global `StandardValidationPipe` (`APP_PIPE`), parameter typed `class EmailDto extends SchemaDto(Email)`, recorded as BODY | completed | dead, `target: "body"` |
| the same, recorded as one of our own types | completed | **completed**: the pipe skipped the parameter |

**`@JobData()` is recorded as Nest's BODY type** (D13). That last row is the
reason. A global pipe in Nest validates only `body`, `query` and `param`
parameters by default: V6's `StandardValidationPipe` skips `"custom"`
(`validation.ts:476`) [S], Nest's `ValidationPipe` and Nest 12's
`StandardSchemaValidationPipe` do the same unless `validateCustomDecorators`
is set [S, `node_modules/@nestjs/common/pipes/standard-schema-validation.pipe.d.ts`],
and Nest 12's was measured to skip it [M, case 3]. Recorded as BODY, an
app's existing global validation applies to job data with no change, as it
does to a microservice's `@Payload()`, which is the same numeric type
(`RpcParamtype.PAYLOAD = 3`, `node_modules/@nestjs/microservices/enums/rpc-paramtype.enum.js:3`)
[S]. V6's own ECC test records its `@JobData` the same way
(`packages/bun-nest/__tests__/validationExternalContext.nest.test.ts:25-50`)
[S]. The cost is that a global pipe written for request bodies now sees job
data, and an issue's `target` reads `"body"`. Q19 asks the user.

**`@JobData({ schema })`.** Nest 12.2 added `@Body({ schema })` and a
`StandardSchemaValidationPipe` that reads the parameter's `schema` from
ECC's metadata [S]. Measured on 12.2.0: our decorator recording `schema` the
same way was validated by that pipe only when the parameter was BODY or the
pipe had `validateCustomDecorators` [M, case 3]. Nest 11 has neither, so a
`schema` recorded only as metadata would be **silently ignored on 11**. The
design therefore turns `{ schema }` into V6's `StandardSchemaPipe(schema)`
on the parameter, which validates on both majors, and does not also record
it as Nest 12 metadata (an app with Nest 12's global pipe would otherwise
validate twice).

**What the handler's parameter type is.** Unchanged from the first version:
a pipe cannot type its parameter, so the parameter is annotated with
`StandardSchemaV1.InferOutput<typeof S>` or is a `SchemaDto` class (V6's own
advice, `validation.ts:300-312`) [S]; §10.4.

**Nest's `ValidationPipe` (class-validator)** works the same way, since ECC
passes each parameter's `design:paramtypes` metatype to pipes
(`helpers/external-context-creator.js:70-72`) [S], and it validates a BODY
parameter globally. **[I]**: still not run, since class-validator is not
installed in the repo (Q16).

**`ValidationExceptionFilter` stays out of the way.** V6's filter answers
for `http`, `ws` and `rpc`, and rethrows anything else
(`validation.ts:738-740`) [S], so an app that applies it globally keeps job
validation failures as errors, which §7.5 then maps.

### 7.5 Guards, filters and job failure [D]

| Situation | What Nest does through ECC [M, `results-pipeline.txt`] | What the integration does |
|---|---|---|
| A guard returns `false` | throws `ForbiddenException` (an `HttpException`). bun-jobs retried it: `attemptsMade=2` of 2 | **Maps it to `JobForbiddenError`**, whose `name` is `UnrecoverableJobError`'s, so it goes to `dead` with no retry. bun-jobs keys unrecoverability on the error's **name** ("An error named `UnrecoverableJobError` ends the job's retries, whether or not it is an instance of the class", README "A custom target") [S]. `onDenied: "retry"` keeps the retry (Q4) |
| A guard throws its own exception | that exception | unchanged: it is the guard's decision |
| A filter rethrows | the job fails with what it threw | unchanged. `UnrecoverableOn(...types)` is a shipped `@Catch(...types)` filter that rethrows as `UnrecoverableJobError` with the original as `cause` |
| **A filter returns a value** | **the job completes with that value**, measured: `completed: "recovered"` | unchanged, because it is Nest's semantics, and a filter author may want exactly that. `BaseJobExceptionFilter`'s JSDoc and the README say it first: *to fail the job, throw* |
| No filter matches | Nest's `ExternalExceptionFilter` logs the error at `error`, with its stack, then rethrows. Measured: `ERROR [ExceptionsHandler] Error: plain failure` | Q5 decides between keeping it, as microservices do, and replacing it |
| A pipe throws `StandardValidationException` (V6) | the job fails with it, and bun-jobs retries it like any error not named `UnrecoverableJobError` (`packages/bun-jobs/lib/queue/BunQueueWorker.ts:4273-4281`) [S] | **Ends the job with no retry**, rethrown as `UnrecoverableJobError` with the original as `cause` and its `issues` kept, as bun-jobs' own processing check does (`jobSchema.ts:55-60`) [S]. `onInvalid: "retry"` per processor keeps the retry (Q18). The match is on V6's class, so a user's own `BadRequestException` is left alone |
| `UnrecoverableJobError` or `job.fail()` | passes through | unchanged: bun-jobs sends the job to `dead` |
| `JobTimeoutError` or a lost lock | the signal aborts; the error passes through the filters | unchanged. Filters see it, and should rethrow |

Telling the denial apart: ECC throws `ForbiddenException` with Nest's
`FORBIDDEN_MESSAGE` (`"Forbidden resource"`) [S, `helpers/external-context-creator.js:194`, `guards/constants.js:1`]. A guard's own
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

**bun-nest's own global enhancers are already safe for jobs.** Each one
passes a non-HTTP context through: `BunThrottlerGuard` (also installed as an
`APP_GUARD` by `globalGuard: true`, `lib/throttler/guard.ts:278`), the cache
interceptor (`lib/cache/interceptor.ts:346`), `@Invalidates`
(`lib/invalidates.ts:77`), `@Validate`'s interceptors (`lib/validate.ts:489`,
`:1197`), and `ValidationExceptionFilter` rethrows (`lib/validation.ts:738-740`)
[S]. So the idiom above is needed for the app's own globals, not bun-nest's;
PR-n3 has a test that installs them all globally and runs a job through.

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
- **`@Every(interval)`** accepts what `every` accepts: milliseconds, or a
  string read as a duration (`"5 minutes"`, `"1h 30m"`), else as a cron
  expression, else as words (`"every monday"`)
  (`packages/bun-jobs/lib/queue/repeat.ts:198-238`) [S]. Durations are bun-common's `parseDuration` since #692
  (`packages/bun-common/lib/utils/duration.ts:76`) [S], the same parser
  bun-common's own options use. `@Cron(expr)` is `{ repeat: { cron: expr } }`,
  with six fields when seconds are given.
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
- **Re-adding at every boot stays safe after #693.** That PR made advancing
  a series one atomic step, through the new optional driver method
  `updateRepeat` (`packages/bun-jobs/lib/drivers/driver.ts:2843`, in all five
  built-in drivers), so a series removed while a worker schedules its next
  occurrence stays removed (`packages/bun-jobs/lib/queue/repeatControl.ts:246`)
  [S]. Adding a series still goes through `upsertRepeat`: create or update,
  keeping `count` and `createdAt` of a stored series
  (`packages/bun-jobs/lib/queue/BunQueue.ts:3423`, `:3457-3460`) [S]. So N
  replicas adding the same `@Cron` at boot is still idempotent, and
  `pruneSchedules` (§8.2) removing an undeclared series cannot be undone by
  a worker in flight. **[I]**: N replicas creating a brand-new `every`
  series in the same moment each anchor `createdAt` on their own clock, so
  there could briefly be two first occurrences; cron series are unaffected.
  PR-n5's two-instance test covers `@Every` as well as `@Cron`.

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
  policy)` (`BunJobs.ts:810`) [S] at bootstrap.
  - Two sources naming the same queue is a `ConfigError`, matching
    bun-jobs' "A queue named twice anywhere in the option" rule [S].
- Summoners from `defineSummoner` or `defineComputeProvider` are values, and
  often need configuration. `forRootAsync`'s factory is where they are
  built, from injected config.
- `@InjectSummonController(queue)` gives `status()`, `reset()` and `now()`.
- `onSummonFailed` is a policy field. A Nest provider that wants it injects
  the controller and listens to its `summon` event, or uses
  `@OnQueueEvent(queue, "summon")` on a subscribing queue.
- **Summon groups** from `docs/plans/worker-runtimes/summon-compute/summon-multi-queue.md`: Part A's
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

- **`BunJobsApiModule` keeps its API.** One additive change: when its
  options give neither `jobs` nor `queues`/`runners`, it takes the `BunJobs`
  of `BunJobsModule` (or `getBunJobsToken(context)` with a new `context`
  option), injected as optional. With neither source, `createJobsApi`'s own
  bun-jobs `ConfigError` stands, "createJobsApi needs `jobs`, or
  `queues`/`runners` to manage" (`packages/bun-jobs/lib/api/config.ts:1254`)
  [S]. (The first version called it "today's `ConfigError`" of the module;
  the module throws none of its own, only a `TypeError` for a non-Bun
  adapter, `BunJobsApiModule.ts:99-102`.) Existing apps that pass `jobs` see
  no change. The new injection is by call, with an explicit token (D14).
- **What the API gained since `bbe1120` needs nothing from Nest** [S]:
  - its errors are a closed `ApiErrorCode`, and each operation lists its
    codes under `x-bun-errors` in the OpenAPI document (#648;
    `packages/bun-jobs/lib/api/contract/types.ts:94`,
    `lib/api/spec/openapi.ts:244`). A denial from `guardsAuthorize` is the
    API's own `UNAUTHORIZED` or `FORBIDDEN` problem, as the re-run shows
    (`urn:bun-jobs:error:FORBIDDEN`, `rerun-2026-11-08/authorize-*.txt`) [M];
  - its origin and CSRF checks follow the app's `trustProxy` unless the
    API's own `trustProxy` says otherwise (#691; `lib/api/config.ts:578-598`,
    `lib/api/auth.ts:482-602`). Behind a proxy, a Nest app sets `trustProxy`
    on `BunHttpAdapter` (`packages/bun-nest/lib/BunHttpAdapter.ts:1211`) and
    both the API and the guards see the client's address and scheme.
- **`guardsAuthorize(moduleRef, guards, options?)`** builds an `authorize`
  from Nest guards, for the API and for the jobs UI (§9.5):

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
    channel (`packages/bun-jobs/lib/api/config.ts:77-156`) [S]. A guard on
    the UI reads the UI's `{ asset, path }` the same way, typed by the
    caller (`jobsApiContextOf<JobsUiAuthorizeContext>(context)`), so bun-nest
    needs no type from bun-ui.
  - The function it returns is `(req, context) => Promise<JobsApiAuthorizeResult>`.
    The UI's `JobsUiAuthorize` takes the same request and answers the same
    result type (`packages/bun-ui/lib/jobs/types.ts:10-36`) [S], so one
    `guardsAuthorize(...)` value fits either option.
  - **Measured** with a `Reflector`-based role guard [M, `results-authorize.txt`]:
    - a reader was allowed `GET /queues` (200) and refused `POST
      …/emails/pause` (403);
    - an admin was allowed to pause (200);
    - a controller beside the API was untouched.

    Re-run unchanged on Nest 12.2.0 and 11.2.7
    [M, `rerun-2026-11-08/authorize-*.txt`].
  - Tests drive it socket-free with `adapter.fetch(path, { remoteAddress })`
    (`packages/bun-common/lib/BunRouter.ts:642`), so an IP-based guard is
    tested without a port.
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

### 9.5 The jobs UI under Nest: the recipe, no module [D]

**Changed in the refresh.** The first version planned
`BunJobsUiModule.forRoot(...)` on a `./jobs-ui` subpath. It is withdrawn
(D11, Q17):

- `@kingsleyweb/bun-jobs-ui` is gone. The UI is `jobsUi()` from
  `@kingsleyweb/bun-ui/jobs` (`packages/bun-ui/lib/jobs/jobsUi.ts:707`),
  returning `{ router, basePath, config }` (`types.ts:151-161`), with either
  `api` or `apiUrl` (`types.ts:119-143`) [S].
- The repo documents the UI under Nest as **a recipe with no module**:
  `jobsUi({ api: app.get(BUN_JOBS_API), basePath, authorize })`, then
  `adapter.use(ui.basePath, ui.router)` (`examples/bun-nest/06-jobs-ui/mount.ts:11-12`,
  `:91-106`; `packages/bun-nest/README.md:440-467`; bun-ui's
  `guides/jobs.md:57-70`), and the Nest matrix runs bun-ui's test of exactly
  that (`packages/bun-ui/__tests__/jobs/server/nest.nest.test.ts`,
  `scripts/nest-matrix.ts:1180-1187`) [S].
- bun-ui is not a peer of bun-nest at all, and bun-ui's plan schedules no
  Nest module (`docs/plans/bun-ui/README.md:542-548`) [S]. The typed-client
  plan made the same choice for live invalidation (`LiveModule` withdrawn,
  §2.3).

What this plan adds is **`guardsAuthorize` for the UI's `authorize`** (§9.4),
and the recipe in the jobs section of bun-nest's README, rewritten around
`BunJobsModule`:

```ts
const app = await NestFactory.create(AppModule, adapter);   // AppModule imports BunJobsModule and BunJobsApiModule
const ui = jobsUi({
  api: app.get(BUN_JOBS_API),
  basePath: "/admin/jobs",
  authorize: guardsAuthorize(app.get(ModuleRef), [SessionGuard]),
});
adapter.use(ui.basePath, ui.router);
await app.init();
```

The UI must not sit at or under the API's basePath; `jobsUi()` throws
bun-jobs' `ConfigError` for that (`jobsUi.ts:489-493`) [S]. Guards,
`setGlobalPrefix` and the rest of Nest's pipeline do not run for the UI's
routes, as the example says (`mount.ts:22-25`) [S]. If the user wants the
module back, it is ~0.5 d in PR-n6 plus bun-ui as a third optional peer of
bun-nest, with its own consumer set (#666).

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
- **The HTTP side of the same app** is tested socket-free with
  `adapter.fetch(...)`, which since `3b1edaa4` takes a `remoteAddress`
  (`packages/bun-nest/lib/BunHttpAdapter.ts:2125`;
  `packages/bun-common/lib/BunRouter.ts:642`) [S]. A test that enqueues
  through a controller and then calls `drainJobs` needs no port, and an
  IP-keyed guard or throttle sees the address the test gives. The README's
  testing section shows the pair.

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
  clean [M, `results-types.txt`]. Re-run on `b1a9f80b`: 64 `TS4094` (BunQueue
  has grown) and 7 `TS4023`, still only at the anonymous token, and `bun
  --check` in the folder reports the same 71 [M, `rerun-2026-11-08/types.txt`].
  bun-nest ships `dts/`, and so may its users.
- **A token can take its types from job schemas.** bun-jobs now exports
  `JobMapFromSchemas` (`packages/bun-jobs/lib/queue/jobSchema.ts:219`) [S].
  A queue registered with `schema` can be typed by a token class written
  against the same schemas, so the compile-time types and the runtime check
  come from one object. PR-n1's type test covers one such token [I].
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

The decorated form gets its safety at **run time**, from the pipe or from
the queue's own schema (§7.4): the schema validates what TypeScript cannot.
The README recommends a queue `schema` for every payload that crosses a
deployment boundary, and a pipe for a per-name check. `StandardSchemaPipe`
is V6's, from bun-nest's root.

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
| bun-nest's own `BunThrottlerModule`, `BunCacheModule`, V6 validation | none | their enhancers pass a non-HTTP context through or rethrow (§7.6). Two consequences: `@Throttle` on a `@Process` method does nothing for a job (its guard skips it, and its boot check reads controllers only, `lib/throttler/module.ts:79-157`) [S]; job rate limits are bun-jobs' `rate` and per-name limits (§5.3). `@Cacheable` is different: it wraps the method itself and keys on its arguments (`lib/cache/decorators.ts:152`) [S], so on a `@Process` method it would cache across jobs **[I]**. The README says not to; PR-n3 tests it, and the boot check refuses `@Cacheable`/`@CachePut` on a `@Process` method if the test shows it caching |

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
| `@OnWorkerEvent("completed")` | `@OnWorkerEvent("completed")` | the same name. Payloads follow bun-jobs (`packages/bun-jobs/lib/queue/types.ts:1667-1714`) |
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
`BunHttpAdapter`, or `createApplicationContext`) on a real bun-jobs driver,
**on both Nest majors**: the lock's 12.2.0 in the suite, and the 11.2.7
column of `scripts/nest-matrix.ts` on every PR here (CLAUDE.md "Nest
versions"). A behaviour that differs by major is asserted per major, never
skipped on one. The drivers:
memory always, plus the file driver for the cross-process cases. Nothing is
mocked between Nest and bun-jobs. The conformance target is **Nest's own
pipeline**: each pipeline test asserts what Nest does for an HTTP route with
the same enhancers, written beside it in the same file, so a difference is
visible.

| PR | Tests | Negative control |
|---|---|---|
| PR-n1 | `forRoot`/`forRootAsync` (`useFactory`, `useClass`, `useExisting`, and none → `ConfigError`); `isGlobal: false` really local; `jobs` borrowed vs built (the driver closed only when built; a borrowed context left open); `registerQueue` in two feature modules, with a queue `schema` passed through; the options-conflict `ConfigError`; named contexts and their tokens; the Nest logger receiving bun-jobs records; R3's boot check (a class with no `design:paramtypes` → `ConfigError` naming the cause); the metadata keys defined by value equal Nest's constants; a token typed from `JobMapFromSchemas`; the packaging tests for `./jobs`; the barrel still loads without bun-jobs; consumer-check's `./jobs` consumer | the conflict check removed → the test of two differing registrations fails |
| PR-n2 | one worker per class; name dispatch; catch-all; two classes on one queue merged; duplicate name → `ConfigError`; unknown name → `dead`; per-name limits stored by merge (the queue's other limits untouched); `target` on a `@Process` class refused; request scope (a distinct instance per job, `REQUEST` is the job, durable strategy sees a `Job`, nothing written on the job); **the lifecycle matrix of `lifecycle.ts` as a test**: E and H complete on both majors, F completes on 12 and fails on 11 (asserted per major, so a Nest change in either direction is seen); a `close()`d context refusing a late queue (`JobsClosedError`); `autoStart: false` | the per-instance drain replaced by a module drain → scenario E fails, as measured |
| PR-n3 | for each of guard, interceptor, pipe and filter: method-, class- and global-level (`APP_*` and `useGlobal*`), with `getType() === "bun-jobs"`; a user's `createParamDecorator`; all nine parameter decorators; undecorated-parameter refusal; **V6**: `StandardSchemaPipe` on `@JobData` (zod and valibot), `@JobData({ schema })`, a `SchemaDto` parameter under a global `StandardValidationPipe`, each with the issue `target` `"body"`; on 12, Nest's `StandardSchemaValidationPipe` with `@JobData({ schema })` not validating twice; `ValidationPipe` with a DTO **if class-validator is added as a devDependency** (Q16); `StandardValidationException` → dead with `attemptsMade=1` and `onInvalid: "retry"` (Q18); `JobForbiddenError` → dead with `attemptsMade=1`; `onDenied: "retry"`; filter-returns-value → completed; `UnrecoverableOn`; `enhancers: false`; bun-nest's own globals (throttler guard, cache interceptor, `ValidationExceptionFilter`) installed and a job unaffected; `@Cacheable` on a `@Process` method (§11.2); a `useFactory` processor's module-scoped enhancers on both majors (§5.2) | each pipeline assertion is paired with the same enhancer on an HTTP route in the same app; `@JobData` recorded as a custom type → the global `StandardValidationPipe` row passes the bad payload, as measured |
| PR-n4 | each event decorator; scoped `completed:name`; an async listener's rejection logged, not unhandled; `@OnJobsEvent` across two processes on the file driver; listeners on a request-scoped class → `ConfigError` | `publishEvents: false` in the producer → no event, and the warn is logged |
| PR-n5 | `@Cron`/`@Every` scheduling exactly one occurrence across **two** app instances on one file-driver backend; series key stability across a restart; invalid cron and unknown tz → `ConfigError` at boot; an undeclared series warned, and pruned only with `pruneSchedules`; a disabled series stays disabled across a restart; `@DefineJob` defaults applied by `jobs.now`; `registerRunner` start and stop | two instances with the dedupe defeated (a random key) → two runs, proving the test can see duplicates |
| PR-n6 | `BunJobsApiModule` without `jobs` + `BunJobsModule`, and with a named `context`; with neither → `createJobsApi`'s `ConfigError`; `guardsAuthorize`: 200/403/401 per role, per transport (HTTP and a socket channel), the problem's `code` from the closed `ApiErrorCode`; the same `guardsAuthorize` value as the jobs UI's `authorize` (bun-ui as a devDependency of the test only); a guard reading `req.ip` under `trustProxy`, driven by `fetch({ remoteAddress })` | a guard that always allows → the 403 test fails |
| PR-n7 | `runSummonedApplication`: exits 0 on idle, through a real `localCompute` summon on SQLite (the summon tests' pattern); `createProcessorContext` in a `child-process` target, resolving a provider; `registerWorker` with a file; `@RemoteHandler` through `BunRemoteExecutorModule`, with a signed request (body unread) | an unsigned request → 401 |
| PR-n8 | `runJob`, `drainJobs`; `overrideProvider` on a queue token and on a typed token; `overrideGuard` reaching the job pipeline; two test files in parallel do not meet | — |
| PR-n9 | `isHealthy` up, down on `ping` false, down on backlog, down with no workers, a timeout on a hung ping | — |
| all | a `*.type-test.ts`: every `@ts-expect-error` of `results-types.txt`, checked by `bun run check` (a `*.type-test.ts` is not a test file, so `bun test --check` never reads it; CLAUDE.md "Bun's checker, not tsc") | each directive is itself the control: unused, it fails as `TS2578` |

### 12.2 Examples the examples agent would write

In `examples/bun-nest/`, a new folder `15-jobs/`: 07 to 14 are taken
(validation, openapi, asyncapi, options, cache, typed-client, trust-proxy,
throttle) [S]. The examples agent owns the numbering:

| Example | Shows, with checks |
|---|---|
| `quick-start.ts` | `BunJobsModule.forRoot`, `registerQueue`, `@InjectQueue`, a `@Processor` with two `@Process` methods; a job added by a controller and completed |
| `typed-queues.ts` | a `@QueueToken` class; typed `@Process(Queue, name)`; the compile errors as `@ts-expect-error` lines |
| `pipeline.ts` | a guard (feature flag), a timing interceptor and `UnrecoverableOn`; `APP_GUARD` with the `getType()` idiom; a filter returning a value |
| `validation.ts` | a queue `schema` checked at enqueue and before the handler; V6's `StandardSchemaPipe` and `@JobData({ schema })` on one name; a `SchemaDto` under a global `StandardValidationPipe`; a bad payload dead at once (Q18). Beside `07-validation/`, which owns V6 for HTTP |
| `request-scope.ts` | a request-scoped processor with `REQUEST` as the job; a durable tenant strategy |
| `events.ts` | `@OnWorkerEvent`, `@OnQueueEvent`, `@OnJobsEvent` across two processes |
| `shutdown.ts` | `enableShutdownHooks`; a job in flight finishing during `app.close()`; the same-module caveat on Nest 11 (the example prints which major it ran on) |
| `cron.ts` | `@Cron` and `@Every` across two app instances, running once |
| `registry.ts` | `@DefineJob` with `jobs.now()` and the builder |
| `runners.ts` | `registerRunner`, `@InjectRunner`, `@OnRunnerEvent` |
| `api-guards.ts` | `BunJobsApiModule` without `jobs`; `guardsAuthorize` with a role guard |
| `06-jobs-ui/mount.ts` (changed, not new) | the recipe on `BunJobsModule`, with `guardsAuthorize` as the UI's `authorize` |
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
| R1 | **ECC is undocumented.** A Nest major could change it | low: unchanged since v6.2, kept in the root export by Nest 12.2.0 (`helpers/index.d.ts:2`) [S], and endorsed for libraries [V, PA §9]. 12.2 did change its internals (a module-key fallback, `schema` passed to pipes) without changing the signature [S] | one internal module (`jobs/pipeline.ts`) holds every ECC call; a conformance test per enhancer type (§12.1) fails loudly on a change; `enhancers: false` is the escape hatch |
| R2 | **Two Nest majors behave differently in places this design touches.** bun-nest supports `^11.1.20 \|\| ^12.0.0` (`packages/bun-nest/package.json:109-112`) [S]. Found so far: a module's hook order (§6.3: F completes on 12, fails on 11), `StandardSchemaValidationPipe` and `{ schema }` (12.2 only, §7.4), ECC's module-key fallback (12.2 only, §5.2) [M, S] | certain: they exist | every PR runs the 11.2.7 column (§12.1), and the floors 11.1.20 and 12.0.0 once per merge window; a per-major behaviour is asserted per major; nothing depends on a 12-only API (`{ schema }` becomes V6's pipe). The deep imports are avoided (§7.1) |
| R3 | **Bun reads `experimentalDecorators` and `emitDecoratorMetadata` from the working directory's `tsconfig.json`, not the file's.** With them off, parameter decorators are silently not applied, and Nest injects `undefined` [M, `results-decorator-config.txt`] | real: it hit the spikes, and still reproduces on `1.4.4-canary.1+11c367163` [M, `rerun-2026-11-08/decorator-config.txt`]. Any app run from a directory whose tsconfig lacks the flags | bun-nest's own classes apply their decorators by call, as every module since `bbe1120` does (D14), so the module's wiring cannot be dropped. For the user's processors, the README states it: run from the app's root, or put the flags in the root tsconfig. The module checks at bootstrap that `design:paramtypes` exists on one of its own decorated classes, and throws a `ConfigError` naming the cause if not (cheap, and it turns `undefined` injection into a message). **Reported upstream** on oven-sh/bun#28605 (below) |
| R4 | `reflect-metadata` must be loaded once, before decorators run | as for any Nest app | `@nestjs/core` imports it itself [S, `node_modules/@nestjs/core/index.js:7`, `index.d.ts:1`]; the README keeps Nest's usual `import "reflect-metadata"` |
| R5 | **The per-instance drain hook** is an own property on a user's instance | low | documented; chained to the class's own `onModuleDestroy`; `JobsHost` offers the explicit form; a test asserts the user's hook still runs, once |
| R6 | **Global enhancers written for HTTP break jobs** (D4) | high on first use | the README's first pipeline paragraph; a bootstrap `debug` line listing the global guards that will apply to jobs |
| R7 | **A DI processor off-thread is expensive** (~115–130 ms per attempt for a trivial module [M]) | certain, if used | refused for `@Process`; offered only as `createProcessorContext` in a file, with the number in its JSDoc; a warm pool deferred (Q11) |
| R8 | **Request scope costs 35–80 µs per job** [M] | certain, if used | opt-in only; documented with the number |
| R9 | A filter returning a value silently completes a failed job (D6) | medium | the README and `BaseJobExceptionFilter`'s JSDoc say it first |
| R10 | **A peer leaking across entries**: Bun runs `lib/` and a consumer's checker reads `dts/`, so a new peer reachable from `./jobs` breaks apps without it, at run time or in types | low | `checkPeerScopes`, `consumer-check.json` `peers` with one consumer per peer set (#666), and the barrel-isolation test extended to `./jobs/terminus` (§3.5). Dropping `./jobs-ui` removes the riskiest case: bun-ui is a ~6.8 MB peer (`docs/plans/README.md`, bun-ui evidence) |
| R11 | Two scheduling systems in one app (`@nestjs/schedule` and ours) confuse users | medium | the §8.3 table in the README |
| R12 | Event listeners' errors swallowed | — | wrapped and logged (§6.1) |
| R13 | Nest's `ExternalExceptionFilter` logs every unfiltered job error with its stack, per attempt [M] | certain | Q5 |
| R14 | **`@JobData()` as BODY puts job data in front of an app's global pipes** (D13): a global `ValidationPipe` with `whitelist`/`forbidNonWhitelisted`, or a pipe that assumes an HTTP body, now runs on jobs | medium, for apps with such pipes | it is the point of the choice, as with microservices' `@Payload()`; the README's validation paragraph says so first; Q19 lets the user choose `"custom"` instead |
| R15 | **Two `ConfigError` classes**: bun-common's (the module's boot checks, as bun-nest's other modules) and bun-jobs' (what `createJobsApi`, `jobsUi()` and bun-jobs throw) [S, §2.3] | low | a boot failure is read, not caught; the README names both, and `instanceof` checks in tests use the right one |
| R16 | **A `useFactory` processor may lose module-scoped enhancers on Nest 11** (§5.2) [I] | low: processors are classes | PR-n3 tests it on both columns; refused with a `ConfigError` on 11 if it does |

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
lands, it gets a `docs/bun-bugs/` entry naming #28605 (there is none yet:
bun-nest's by-call comments cite the issue directly).

Re-checked 2026-11-08: #28605 is still open (last updated 2026-10-10), and
the spike gives the same four results on `1.4.4-canary.1+11c367163`
[M, `rerun-2026-11-08/decorator-config.txt`].

---

## 14. Open questions for the user

Each has a recommendation, refreshed on 2026-11-08. **Q1, Q4, Q5, Q18 and
Q19 shape the API of PR-n2 and PR-n3**, and Q13 and Q14 shape PR-n1's, so
those are the ones to answer before building starts. Two questions of the
first version are resolved by what changed, and are listed after the table
with the reason.

| # | Question | Recommendation |
|---|---|---|
| **Q1** | Workers per **class** (`@Processor` + `@Process(name)`), or per **method** (`@QueueWorker(queue)` on any service method)? | **Per class** (§5.1). A per-method worker claims other methods' jobs and fails them, because a bun-jobs worker still claims any name on its queue (no name filter, `packages/bun-jobs/lib/queue/types.ts:1119-1422`). The user's "a method in a service" is met by putting `@Processor` on the service |
| Q2 | Ship on `./jobs` (plus `./jobs/terminus` and `./jobs/testing`), or as a new package? | **`./jobs` and the two subpaths** (§3.5). Since #666 each peer set gets its own consumer check, so the optional-peer split is now proven per entry, not just per package |
| **Q3** | Global enhancers apply to jobs (Nest's semantics), or should the module exclude them? | **Apply, with the `getType()` idiom documented** (D4). Excluding them needs Nest internals; `enhancers: false` remains. bun-nest's own global enhancers already skip jobs (§7.6), so only the app's own need the idiom |
| **Q4** | A guard's denial: dead at once (`JobForbiddenError`), or retried like any error? | **Dead at once by default**; `onDenied: "retry"` per processor (§7.5) |
| **Q5** | Nest logs every unfiltered job error at `error`, with a stack, per attempt (measured again on 11.2.7 and 12.2.0). Keep that, as microservices do, or replace it? | **Keep it for v1.** Replacing it means calling ECC with `filters: false` and invoking the user's filters ourselves, which needs `ExternalExceptionFilterContext`. It is still not exported from `@nestjs/core`'s root or its `internal` entry on 12.2.0 (`exceptions/index.d.ts:1` exports only `BaseExceptionFilter`; `internal.d.ts:36` only `BaseExceptionFilterContext`) [S], so it is a deep import of an internal: the cost D4 declines elsewhere. For apps that want less noise, the README shows a catch-all `@Catch()` filter on a processor class that rethrows; a filter that matches means Nest's logging fallback never runs. Revisit if Nest exposes the handler |
| Q6 | `REQUEST` in a request-scoped processor: the job (bullmq parity), or a `{ job, ctx }` pair? | **The job**, for parity, with the context via `@JobContext()` |
| Q8 | `@Cron` series removed from the code: warn only, or prune at boot? | **Warn by default; prune with `pruneSchedules: true`** (§8.2). #693 made pruning safe against a worker in flight |
| Q10 | The decorator for the whole job: `@CurrentJob()` (no clash with the `Job` type), or `@Job()` (bullmq users' guess)? | **`@CurrentJob()`** |
| Q11 | Off-thread DI: only `createProcessorContext` (per-attempt bootstrap), or also a warm-pool target? | **The helper now; the pool later**, as its own plan, under the runner-review rules |
| Q12 | `@Cron` / `@Every`, or `@JobCron` / `@JobEvery` to avoid clashing with `@nestjs/schedule` on import? | **`@Cron` and `@Every`**: the clash is an import alias, and users reach for `@Cron` first. Weak preference; the user's call |
| **Q13** | Build `BunJobsModule` by hand, as `BunThrottlerModule` is (all three async forms, one `moduleOf()`), or with Nest's `ConfigurableModuleBuilder`? | **By hand, like `BunThrottlerModule`** (changed from the first version). The builder works on both majors (measured), but named contexts need one options token per name and the builder has one per builder, and every bun-nest module since October is hand-written. Leave `BunJobsApiModule` as it is |
| **Q14** | Two `registerQueue` calls for one queue with different options: a `ConfigError` at bootstrap, or bun-jobs' one warning? | **`ConfigError`** (§4.1), listing both modules. It now covers a queue `schema` too, since two differing schemas on one queue would check jobs two ways |
| Q15 | A job whose name no processor in this process handles: `dead` at once, or bun-jobs' retryable `ConfigError` (left for "a deployment that does define it")? | **`dead` at once** for `@Processor` queues, which are per-service by design. The registry (`@DefineJob`) keeps bun-jobs' rule unchanged (`BunJobs.ts:1478-1487`, still retryable) |
| Q16 | Add `class-validator` and `class-transformer` as bun-nest devDependencies, so Nest's `ValidationPipe` is tested on job data? | **Yes, devDependencies only, for one test.** V6 covers Standard Schema, but class-validator DTOs are what most Nest apps use, and D13 is what lets their global `ValidationPipe` see job data; a test should prove it rather than infer it |
| **Q17** (new) | The jobs UI under Nest: keep the documented recipe (`jobsUi()` + `adapter.use()`, no module), or add a `BunJobsUiModule` on a `./jobs-ui` subpath? | **Keep the recipe; no module** (§9.5). bun-jobs-ui, which the module was planned around, is gone; its successor `@kingsleyweb/bun-ui/jobs` is not a bun-nest peer, and the repo, bun-ui's plan and its Nest test all say "no module". This plan adds `guardsAuthorize` for the UI's `authorize` and rewrites the recipe around `BunJobsModule`. A module would cost ~0.5 d and a third optional peer |
| **Q18** (new) | A job whose data fails a validation pipe (V6's `StandardValidationException`): dead at once, or retried like any error? | **Dead at once by default**, as `UnrecoverableJobError` with the issues kept, and `onInvalid: "retry"` per processor. A retry sees the same data and fails the same way, and bun-jobs' own job-schema check already ends the attempt as unrecoverable (`jobSchema.ts:55-60`), so the two layers behave alike |
| **Q19** (new) | Should pipes see `@JobData()` as a request **body** (Nest's BODY type, as microservices' `@Payload()` does), or as a **custom** parameter? | **As a body.** Then an app's global `ValidationPipe` or V6 `StandardValidationPipe` validates job data with no change (measured: as custom, the global pipe let a bad payload through), and issues read `target: "body"`. The cost is that every global pipe now sees job data (R14). As custom, global validation skips jobs unless the app sets `validateCustomDecorators` |

**Resolved since the first version:**

- **Q7** (the same-module caveat: document it, or also drain earlier?) is
  resolved by Nest 12, which orders a module's hooks by dependency: the
  processor drains before a provider it depends on in its own module
  (measured, §6.3). On Nest 11 the caveat stays, documented, as the first
  version recommended. Nothing is built for it.
- **Q9** (support Nest 12 in this work, or separately?) is resolved:
  bun-nest supports `^11.1.20 || ^12.0.0` since the
  [`nestjs-12-parity/`](../nestjs-12-parity/README.md) plan completed, so
  this work targets both, and every PR runs the 11.2.7 column (§12.1).

## 15. PR slicing and effort

Focused days for someone who knows the code, as in the other plans. Every
PR is in `packages/bun-nest/**`, owned by the Nest role
(`docs/agentic-setup.md`, "Ownership"; with the roles collapsed, whoever
holds it). Each passes bun-nest's gate alone (CLAUDE.md "Dev workflow"):

- `bun scripts/typecheck.ts` from the root;
- in `packages/bun-nest`: `bun run check`, `bun run lint`,
  `bun run format:check`, `bun run test`;
- `bun scripts/consumer-check.ts packages/bun-nest` (one consumer per peer
  set since #666);
- the **11.2.7 column**, `bun scripts/nest-matrix.ts --run 11.2.7`, through
  the heavy-run wrapper (CLAUDE.md "Nest versions": every PR touching
  bun-nest);
- `examples/bun-nest`'s `run-all.ts`.

The first version's `CI=1 bunx eslint .` is gone: `bun lint` and `bun fmt`
are the gate since bun-lint-fmt's PR E. Each PR sends the examples agent a
CHANGE REPORT. None changes `packages/bun-jobs/**`, `packages/bun-common/**`
or `packages/bun-ui/**`.

| PR | What it ships | Depends on | Effort | Other owners |
|---|---|---|---|---|
| **PR-n1** core module and producers | `BunJobsModule` hand-written (`forRoot`, `forRootAsync` with `useFactory`/`useClass`/`useExisting`, `registerQueue`, `registerQueueAsync`, named contexts, `isGlobal`, Nest logger default, build-or-borrow, `onApplicationShutdown` close); `Symbol.for` options tokens, `getQueueToken`/`getBunJobsToken`; `@InjectQueue`, `@InjectBunJobs`; `@QueueToken` typed classes; the options-conflict check; R3's boot check; every class wired by call (D14); README section; `consumer-check.json` entries | — | ~3 d | examples ~1 d |
| **PR-n2** consumers and lifecycle | `@Processor`, `@Process` (names, catch-all, per-name limits); the explorer (`DiscoveryModule`, one worker per queue, merge rules, collected boot checks); `JobsHost`; request scope (public API); `registerWorker`; `autoStart` and `BunJobsLifecycle`; per-instance and fallback drains; `@InjectWorker`; `shutdown`; `@DefineJob`; the lifecycle matrix per major | PR-n1 | ~4 d | examples ~1 d |
| **PR-n3** the pipeline | ECC wrapping under `"bun-jobs"`; `BunJobsExecutionContext`, `isBunJobsContext`, `BunJobsContextType`; nine parameter decorators, `@JobData` as BODY with `{ schema }` mapped to V6's `StandardSchemaPipe`, and the all-or-none check; `JobForbiddenError` and `onDenied`; the validation mapping and `onInvalid` (Q18); `UnrecoverableOn`, `BaseJobExceptionFilter`; `JobLoggingInterceptor`; Q5's answer; `enhancers: false`; the type tests | PR-n2 | ~2.5 d (was ~4 d: V6 ships the pipe) | examples ~1 d |
| **PR-n4** events | `@OnWorkerEvent` (its scoped form typed to the 13 scoped events), `@OnQueueEvent`, `@OnJobsEvent`, `@OnRunnerEvent`; `@InjectJobsNotifier`; listener error wrapping; typed listener signatures | PR-n2 | ~2 d | — |
| **PR-n5** scheduling and runners | `@Cron`, `@Every`; the schedule queue; validation at boot; undeclared-series warn and `pruneSchedules`; `registerRunner`, `@InjectRunner`; the two-instance test for both `@Cron` and `@Every` | PR-n2 (PR-n4 for `@OnRunnerEvent`) | ~3 d | examples ~0.5 d |
| **PR-n6** API and guards | `BunJobsApiModule` taking `BunJobsModule`'s context (and a `context` option); `guardsAuthorize`, `jobsApiContextOf`, usable for the API and the jobs UI; the jobs UI recipe in the README and `06-jobs-ui/mount.ts` rewritten around `BunJobsModule` (Q17) | PR-n1 | ~1.5 d (was ~2 d: no UI module) | examples ~0.5 d |
| **PR-n7** summoned, off-thread, remote | `runSummonedApplication` (groups and shared units included); `createProcessorContext`; `@InjectSummonController`, `registerQueue({ summon })`; `@RemoteHandler`, `BunRemoteExecutorModule` | PR-n2 | ~3 d | bun-jobs owner review (summon and remote) |
| **PR-n8** testing | `./jobs/testing`: `BunJobsTestingModule`, `runJob`, `drainJobs`; the `fetch({ remoteAddress })` pairing in the README | PR-n3 | ~2 d | — |
| **PR-n9** terminus | `./jobs/terminus`: `BunJobsHealthIndicator`, `BunJobsHealthModule`; `@nestjs/terminus` as an optional peer, with its own consumer set, and a devDependency | PR-n1 | ~1 d | — |
| **PR-n10** playground | a Nest app beside the playground's adapter showing processors, cron and the pipeline (the playground rule) | PR-n3 | ~1 d | UI owner review |
| | **Total** | | **~23 d** | ~4 d + reviews |

**Order:**

1. PR-n1 → PR-n2 → PR-n3.
2. Then PR-n4, PR-n5, PR-n7 and PR-n8, which do not touch each other's
   files. PR-n6 and PR-n9 can go any time after PR-n1.
3. PR-n10 last.

**The smallest useful release is PR-n1 to PR-n3** (~9.5 d): modules,
injection, processors and the pipeline. That is the user's literal request,
and what the user asked to build first. In detail:

- **PR-n1** is buildable on the answers to Q13 and Q14, and Q2 (the
  subpath). It ships no worker: an app can inject queues and add jobs, and
  nothing yet consumes them under Nest. Files: `packages/bun-nest/lib/jobs/`
  gains `BunJobsModule.ts`, `tokens.ts` (grown), `decorators/inject.ts`,
  `queueToken.ts`, `bootCheck.ts`; `index.ts` re-exports them;
  `consumer-check.json` lists the names; the barrel test is unchanged.
- **PR-n2** needs Q1, Q6 and Q15. After it, `@Processor`/`@Process` run
  jobs with `(job, ctx)` handlers, drain correctly on both majors, and
  request scope works; the pipeline is not yet wrapped (handlers are called
  directly, as with `enhancers: false`).
- **PR-n3** needs Q3, Q4, Q5, Q10, Q16, Q18 and Q19. It turns the pipeline
  on, and with it the parameter decorators and V6 validation.
- A release between PR-n2 and PR-n3 would ship decorators whose parameter
  decorators do nothing, so **PR-n2 and PR-n3 merge in one merge window**,
  or PR-n2 keeps the parameter decorators unexported until PR-n3.

**Not in this plan:**

- the warm-pool target (Q11);
- `BunJobsGatewayModule`, which is GW's PR-g2 (still not started);
- a Nest module for the jobs UI (Q17);
- OpenTelemetry spans, which are OT's (still a plan).

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
| `ProcessorOptions` (+ `scope`, `context`, `enhancers`, `onDenied`, `onInvalid`), `ProcessOptions` (`concurrency`, `rate`) | types | `onInvalid` is new (Q18) |
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
| `guardsAuthorize`, `jobsApiContextOf` | functions | for the API's `authorize` and the jobs UI's (§9.4) |
| `JobDataOptions` (`property`, `schema`, `pipes`) | type | the object form of `@JobData()` (§7.3) |
| `BunJobsApiModule` option `context` | option | which named context's `BunJobs` the API takes (§9.4) |
| `createProcessorContext` | function | |
| `runSummonedApplication` | function | `runSummoned` for a Nest module |
| `RemoteHandler`, `BunRemoteExecutorModule` | decorator, module | |
| `BunJobsHealthIndicator`, `BunJobsHealthModule`, `isHealthy` options (`queues`, `maxOutstanding`, `requireWorkers`, `timeout`) | indicator, module, on **`./jobs/terminus`** | |
| `BunJobsTestingModule`, `runJob`, `drainJobs`, `RunJobOutcome` | module, functions, type, on **`./jobs/testing`** | |
| `./jobs/terminus`, `./jobs/testing` (+ `./lib/...` spellings) | package entries | §3.5 |
| metadata keys `bun-jobs:*` | internal strings | not exported; listed because they are visible to `Reflect` |

**Withdrawn since the first version:** `StandardSchemaPipe` (V6 shipped it
at bun-nest's root, approved under bun-validate), `BunJobsUiModule` and
`./jobs-ui` (Q17), and the suggestion of `validateStandard` to bun-common
(it exists). One name is still suggested to another owner, and is theirs to
accept:

- **`BunJobsGatewayModule`**, already in GW §12.

---

## Appendix: evidence

[`evidence/`](evidence/README.md)
holds the prototype, the seven spikes and the refresh's `refresh.ts`, their
raw output (the first run's `results-*.txt`, and `rerun-2026-11-08/` for
Nest 12.2.0 and 11.2.7) and the prior-art notes (`prior-art.md`). Like the other evidence folders, nothing in it is part
of a package, and the repo's tooling does not typecheck or lint it. It has
its own `tsconfig.json`, because of R3.
