# Prior art: NestJS integrations for job queues, schedulers and handler pipelines

Researched 2026-10-10. Every claim is marked **VERIFIED** (I read the installed or
downloaded source, or the doc page text) or **INFERRED** (reasoned from source, not
stated anywhere or not run).

## Sources read

- **Installed in the worktree** (`<repo>/node_modules/@nestjs/`):
  only `common`, `core` and `websockets`, all **11.1.27**. bun-nest's `package.json` declares
  `@nestjs/common`/`core`/`websockets` `^11.0.0` peers (dev `^11.1.27`). VERIFIED.
- **Downloaded with `npm pack`** into `research/pkgs/` (read-only copies):
  - Latest: `@nestjs/core` 12.1.2, `common` 12.1.2, `websockets` 12.1.2, `microservices` 12.1.2,
    `bullmq` 12.0.0, `bull` 12.0.0, `bull-shared` 12.0.0, `schedule` 12.0.2, `event-emitter` 12.0.1,
    `cqrs` 12.1.0, `graphql` 14.0.3, `terminus` 12.1.0, `@golevelup/nestjs-rabbitmq` 9.1.0,
    `@golevelup/nestjs-discovery` 7.1.0, `@wavezync/nestjs-pgboss` 7.0.2, `bullmq` 6.3.12, `eventemitter2` 6.4.9.
  - The last Nest-11-compatible lines (to match what is installed): `core` 11.2.7, `microservices` 11.2.7,
    `bullmq` 11.0.5, `bull` 11.0.4, `bull-shared` 11.0.4, `schedule` 6.1.3, `event-emitter` 3.1.0,
    `cqrs` 11.0.3, `graphql` 13.4.5, `terminus` 11.1.1.
- **Docs**: raw markdown from `nestjs/docs.nestjs.com` at master `e0984c78` (2026-10-09), saved in
  `research/docs/`. The docs were reorganised: queues/events/scheduling are now `content/application/*`,
  terminus `content/reliability/terminus.md`, discovery `content/fundamentals/discovery-service.md`.
- GitHub issues/PRs via `gh`.

Quotes below come from the compiled `dist/*.js` / `*.d.ts` (what ships). Where the ts source is linked,
the path was confirmed to exist on the default branch (`master`, except wavezync `main`); line content
was read from the compiled output of the same version, not from the GitHub ts.

---

## 9 (first, because it frames everything). Versions and stability

| Package | Latest (npm, 2026-10-10) | Last line for Nest 11 | Notes |
|---|---|---|---|
| `@nestjs/core` / `common` | 12.1.2 (2026-09-30) | 11.2.7 (2026-09-30) | 12.0.0 shipped 2026-08-27 |
| `@nestjs/bullmq` | 12.0.0 | 11.0.5 | 12.0.0 peers: core `^10 \|\| ^11 \|\| ^12`, bullmq `^3..^6` |
| `@nestjs/bull` | 12.0.0 | 11.0.4 | peers core `^8..^12`, bull `^3.3 \|\| ^4` |
| `@nestjs/schedule` | 12.0.2 | 6.1.3 | 12.x peers core `^11 \|\| ^12`; dep `cron` 4.4.0 |
| `@nestjs/event-emitter` | 12.0.1 | 3.1.0 | 12.x peers core `^11 \|\| ^12`; dep `eventemitter2` 6.4.9 |
| `@nestjs/cqrs` | 12.1.0 | 11.0.3 | 12.x peers core `^12` only |
| `@nestjs/microservices` | 12.1.2 | 11.2.7 | |
| `@nestjs/graphql` | 14.0.3 | 13.4.5 | 14.x peers core `^12` |
| `@nestjs/terminus` | 12.1.0 | 11.1.1 | 12.x peers core `^11 \|\| ^12` |
| `@golevelup/nestjs-rabbitmq` | 9.1.0 | same | peers core `^11.1.24 \|\| ^12` |

VERIFIED (`npm view`, each tarball's `package.json`).

- **Nest 12 packages are ESM** (`"type": "module"`, explicit `.js` specifiers) and `engines.node >= 20`.
  VERIFIED for core/common/microservices/websockets/cqrs/schedule/event-emitter/graphql/terminus/bullmq 12.
  The 12.x satellite versions (bullmq/schedule/event-emitter/terminus) still accept core 11.
- **`@nestjs/core` 12 adds an `./internal` entry.** Its `internal.d.ts` header, VERIFIED:
  > `Internal module - not part of the public API. These exports are used by sibling @nestjs packages. Do not depend on these in your application code. @internal`

  It re-exports `Injector`, `InstanceWrapper`, `Module`, `ExecutionContextHost`, `ContextUtils`,
  `STATIC_CONTEXT`, `REQUEST_CONTEXT_ID`, the guards/pipes/interceptors consumers and context creators, etc.
  The `exports` map still has `"./*": "./*.js"`, so deep imports keep working. VERIFIED.
- **`ExternalContextCreator` is exported from the `@nestjs/core` root** in 11.1.27 and 12.1.2
  (`index.d.ts` → `export * from './helpers'` → `export * from './external-context-creator'`), and it
  is **not** in the 12 `internal` list. It carries **no `@publicApi` tag** and **docs.nestjs.com never
  mentions it** (GitHub code search for `ExternalContextCreator` in `nestjs/docs.nestjs.com`: 0 hits).
  VERIFIED.
- Its stability rests on maintainer statements and release notes, not documentation. VERIFIED quotes:
  - Release notes: v4.6.5 "use `ApplicationConfig` within `ExternalContextCreator`"; v5.2.0
    "**enhance `ExternalContextCreator` (for 3rd-party libraries purposes)**"; v5.3.0 "now supports
    pipes"; v6.2.0 "customizable `ExternalContextCreator` (pass options object that determines which
    enhancers should be applied - interceptors, guards, or filters respectively)".
  - Kamil Myśliwiec, [nestjs/nest#9017](https://github.com/nestjs/nest/issues/9017): "enhancers are
    'transfer protocol-agnostic' … To leverage enhancers in a standalone application (Nest context) then
    you should be using `ExternalContextCreator` that you can retrieve from the container using
    `app.get(ExternalContextCreator)`. Check out the `@nestjs/graphql` repository to learn how we bind
    enhancers to routes from within an external library."
  - Kamil, [nestjs/nest#11272](https://github.com/nestjs/nest/issues/11272): "`ExternalContextCreator` was
    designed to be used only for providers." (Its `getContextModuleKey` searches only
    `moduleRef.hasProvider(ctor)`, so a **controller** used as a handler gets module key `''` and its
    module-scoped (DI) enhancers/filters do not resolve.)
  - [nestjs/nest#12165](https://github.com/nestjs/nest/issues/12165) → PR #12166 (merged 2023-07-31):
    `createApplicationContext` now gets an `ApplicationConfig`, so `APP_GUARD`-style global enhancers work
    through `ExternalContextCreator` in standalone contexts (necord, nest-commander were affected).
- **The signature is identical in 11.1.27 and 12.1.2** (only ESM syntax differs). VERIFIED by diff.
- **INFERRED**: treat it as "public by export and by maintainer endorsement, undocumented, semver-stable in
  practice (unchanged since v6.2)". Importing it from the root (`import { ExternalContextCreator } from
  '@nestjs/core'`) avoids the `internal` entry. Do **not** import `ExecutionContextHost`/`Injector` deep
  paths if avoidable — those are the ones Nest 12 labels internal (bullmq 12 still deep-imports
  `@nestjs/core/injector/injector.js` and `.../request-constants.js`).

---

## 1. `@nestjs/bullmq` (11.0.5 read in full; 12.0.0 diffed — only ESM conversion)

Repo: <https://github.com/nestjs/bull/tree/master/packages/bullmq/lib>

### Decorators — VERIFIED (`dist/decorators/*.d.ts`)

```ts
export interface ProcessorOptions {
    name?: string;          // queue name
    scope?: Scope;          // "Specifies the lifetime of an injected Processor."
    configKey?: string;     // shared config key
}
export declare function Processor(queueName: string): ClassDecorator;
export declare function Processor(queueName: string, workerOptions: NestWorkerOptions): ClassDecorator;
export declare function Processor(processorOptions: ProcessorOptions): ClassDecorator;
export declare function Processor(processorOptions: ProcessorOptions, workerOptions: NestWorkerOptions): ClassDecorator;

export declare const OnWorkerEvent: (eventName: keyof WorkerListener) => MethodDecorator;
export declare function QueueEventsListener(queueName: string, queueEventsOptions?: NestQueueEventOptions): ClassDecorator;
export declare const OnQueueEvent: (eventName: keyof QueueEventsListener) => MethodDecorator;
export declare const InjectQueue: (name?: string) => ReturnType<typeof Inject>;
export declare const InjectFlowProducer: (name?: string) => ReturnType<typeof Inject>;

export interface NestWorkerOptions extends PartialThisParameter<WorkerOptions, 'connection'> {
    /** @deprecated … not supported in BullMQ 5 … */ sharedConnection?: boolean;
}
```

`@Processor` implementation ([processor.decorator.ts](https://github.com/nestjs/bull/blob/master/packages/bullmq/lib/decorators/processor.decorator.ts)), VERIFIED:

```js
function Processor(queueNameOrOptions, maybeWorkerOptions) {
    const options = queueNameOrOptions && typeof queueNameOrOptions === 'object'
        ? queueNameOrOptions : { name: queueNameOrOptions };
    return (target) => {
        SetMetadata(SCOPE_OPTIONS_METADATA, options)(target);   // 'scope:options' — what @Injectable writes
        SetMetadata(PROCESSOR_METADATA, options)(target);       // 'bullmq:processor_metadata'
        if (maybeWorkerOptions) SetMetadata(WORKER_METADATA, maybeWorkerOptions)(target);
    };
}
```

**`scope` behaviour**: writing the options object to `SCOPE_OPTIONS_METADATA` is exactly what
`@Injectable({ scope })` does, so `@Processor({ name, scope: Scope.REQUEST })` makes the class
request-scoped in DI without a separate `@Injectable`. VERIFIED (constant `SCOPE_OPTIONS_METADATA =
"scope:options"` in `@nestjs/common/constants.d.ts`). The class must still be listed in `providers`.

### Hosts — VERIFIED (`dist/hosts/*`)

```ts
export declare abstract class WorkerHost<T extends Worker = Worker> {
    private readonly _worker;
    get worker(): T;
    abstract process(job: Job, token?: string): Promise<any>;
}
export declare abstract class QueueEventsHost<T extends QueueEvents = QueueEvents> implements OnApplicationShutdown {
    private _queueEvents;
    get queueEvents(): T;
    onApplicationShutdown(signal?: string): Promise<void>;   // closes this._queueEvents
}
```

`worker` getter throws until registration: *'"Worker" has not yet been initialized. Make sure to interact
with worker instances after the "onModuleInit" lifecycle hook is triggered for example, in the
"onApplicationBootstrap" hook, or if "manualRegistration" is set to true make sure to call
"BullRegistrar.register()"'*. The explorer assigns `instance._worker = worker` (a private field written
from outside). VERIFIED.

### Module API — VERIFIED (`dist/bull.module.d.ts`, interfaces)

```ts
export declare class BullModule {
    static set queueClass(cls: Type);          // e.g. QueuePro
    static set flowProducerClass(cls: Type);
    static set workerClass(cls: Type);
    static forRoot(bullConfig: BullRootModuleOptions): DynamicModule;
    static forRoot(configKey: string, bullConfig: BullRootModuleOptions): DynamicModule;
    static forRootAsync(asyncBullConfig: SharedBullAsyncConfiguration): DynamicModule;
    static forRootAsync(configKey: string, asyncBullConfig: SharedBullAsyncConfiguration): DynamicModule;
    static registerQueue(...options: RegisterQueueOptions[]): DynamicModule;
    static registerQueueAsync(...options: RegisterQueueAsyncOptions[]): DynamicModule;
    static registerFlowProducer(...options: RegisterFlowProducerOptions[]): DynamicModule;
    static registerFlowProducerAsync(...options: RegisterFlowProducerAsyncOptions[]): DynamicModule;
}
export interface BullModuleExtraOptions { manualRegistration?: boolean; }
export interface BullRootModuleOptions extends Bull.QueueOptions { extraOptions?: BullModuleExtraOptions; }
export interface SharedBullAsyncConfiguration extends Pick<ModuleMetadata, 'imports'> {
    useExisting?; useClass?; useFactory?: (...args) => Promise<Bull.QueueOptions> | Bull.QueueOptions;
    inject?; extraOptions?: BullModuleExtraOptions; extraProviders?: Provider[];
}
export interface RegisterQueueOptions extends PartialThisParameter<QueueOptions, 'connection'> {
    name?: string;                 // @default default
    configKey?: string;
    processors?: BullQueueProcessor[];   // callbacks or file paths (sandboxed)
    /** @deprecated */ sharedConnection?: boolean;
    forceDisconnectOnShutdown?: boolean; // @default false
}
```

- `forRoot` returns `{ global: true, module: BullModule, providers: [sharedConfig, BULL_EXTRA_OPTIONS_TOKEN], exports: same }`. VERIFIED.
- The explorer is **not** in `forRoot`; `registerQueue*`/`registerFlowProducer*` import
  `coreModuleDefinition = { global: true, module: BullModule, imports: [DiscoveryModule], providers:
  [BullExplorer, BullMetadataAccessor, BullRegistrar, ProcessorDecoratorService], exports: [BullRegistrar] }`. VERIFIED.
- Tokens ([bull-shared](https://github.com/nestjs/bull/blob/master/packages/bull-shared/lib/bull.tokens.ts) and bullmq utils), VERIFIED:
  `getQueueToken(name) => name ? \`BullQueue_${name}\` : 'BullQueue_default'`;
  `getFlowProducerToken(name) => name ? \`BullFlowProducer_${name}\` : 'BullFlowProducer_default'`;
  `getSharedConfigToken(configKey)`, `BULL_CONFIG_DEFAULT_TOKEN = "BULL_CONFIG(default)"`;
  **`JOB_REF = REQUEST`** (from `@nestjs/core`).
- Queue shutdown ([bull.providers.ts](https://github.com/nestjs/bull/blob/master/packages/bullmq/lib/bull.providers.ts)), VERIFIED:
  the factory monkey-patches `queue.onApplicationShutdown = async function () { close inline workers; await this.close(); if (forceDisconnectOnShutdown) disconnect }`.
  Flow producers default `forceDisconnectOnShutdown ?? true`.

### `BullRegistrar` / `manualRegistration` — VERIFIED ([bull.registrar.ts](https://github.com/nestjs/bull/blob/master/packages/bullmq/lib/bull.registrar.ts))

```js
onModuleInit() {
    const extraOptions = this.getModuleExtras();      // moduleRef.get(BULL_EXTRA_OPTIONS_TOKEN, { strict: false })
    if (extraOptions?.manualRegistration) return;
    this.register();                                  // → bullExplorer.register()
}
```

Docs ([application/queues.md](https://github.com/nestjs/docs.nestjs.com/blob/master/content/application/queues.md)):
"By default, `BullModule` automatically registers BullMQ components (queues, processors, and event listener
services) in the `onModuleInit` lifecycle hook … inject `BullRegistrar` and call its `register()` method,
ideally within the `onModuleInit()` or `onApplicationBootstrap()` lifecycle hook. … Until you call
`BullRegistrar#register()`, no BullMQ components work, which means no jobs are processed." VERIFIED.

### `BullExplorer` — discovery, start, close — VERIFIED ([bull.explorer.ts](https://github.com/nestjs/bull/blob/master/packages/bullmq/lib/bull.explorer.ts))

- `register() { this.registerWorkers(); this.registerQueueEventListeners(); }`
- Discovery: `this.discoveryService.getProviders().filter(wrapper => this.metadataAccessor.isProcessor(!wrapper.metatype || wrapper.inject ? wrapper.instance?.constructor : wrapper.metatype))`
  — the ternary supports `useValue`/`useFactory` providers (comment in source explains `metatype` is null
  or the factory function there). Providers only, not controllers.
- `isRequestScoped = !wrapper.isDependencyTreeStatic()`; non-`WorkerHost` instance → `InvalidProcessorClassError`.
- **Start**: `new BullExplorer._workerClass(queueName, processor, { connection, sharedConnection, prefix, telemetry, ...workerOptions })`.
  BullMQ's `WorkerOptions.autorun` is "@defaultValue true" ("Condition to start processor at instance
  creation", VERIFIED in bullmq 6.3.12 `worker-options.d.ts`), so **jobs start being pulled inside
  `BullRegistrar.onModuleInit`**.
  INFERRED consequence: `BullModule`'s core module is global, and global modules are hooked early (lowest
  distance first is reversed: "the most deeply imported modules (and global modules) go first"), so a
  processor can receive a job **before** other modules' `onModuleInit`/`onApplicationBootstrap` have run.
- **Close**: `onApplicationShutdown(signal) { return Promise.all(this.workers.map(w => w.close())); }`
  — i.e. after `onModuleDestroy`, `beforeApplicationShutdown` and the HTTP server close.
  `Worker.close(force?)` "waits for current jobs to finalize" unless `force`. VERIFIED.
- **Request-scoped / durable processors** (quote):

```js
handleProcessor(instance, queueName, queueOpts, moduleRef, isRequestScoped, options = {}) {
    const methodKey = 'process';
    let processor;
    if (isRequestScoped) {
        processor = async (...args) => {
            const jobRef = args[0];
            const contextId = ContextIdFactory.getByRequest(jobRef);
            if (this.moduleRef.registerRequestByContextId &&
                !contextId[REQUEST_CONTEXT_ID]) {
                // Additional condition to prevent breaking changes in
                // applications that use @nestjs/bull older than v7.4.0.
                this.moduleRef.registerRequestByContextId(jobRef, contextId);
            }
            const contextInstance = await this.injector.loadPerContext(instance, moduleRef, moduleRef.providers, contextId);
            const processor = contextInstance[methodKey].bind(contextInstance);
            return this.processorDecoratorService.decorate(processor)(...args);
        };
    } else {
        processor = instance[methodKey].bind(instance);
        processor = this.processorDecoratorService.decorate(processor);
    }
    const worker = new BullExplorer._workerClass(queueName, processor, { … , ...options });
    instance._worker = worker;
    this.workers.push(worker);
}
```

  Notes: `this.injector = new Injector()` (internal class, deep import), `moduleRef` here is
  `wrapper.host` (the provider's `Module`). The **job object is the `REQUEST`** (`JOB_REF`).
  `ContextIdFactory.getByRequest(job)` consults a globally applied `ContextIdStrategy` when the job
  carries no `REQUEST_CONTEXT_ID`, so **durable** providers work, but the strategy's `attach(contextId,
  request)` receives a BullMQ `Job`, not an HTTP request (INFERRED — an HTTP-shaped strategy reading
  `request.headers` must handle that). For a request-scoped processor the `instance` from discovery is a
  prototype placeholder; the worker is still created once and `instance._worker` is set on it.
- **Worker/queue event listeners on request-scoped classes are ignored with a warning**: `Warning!
  "${wrapper.name}" class is request-scoped and it defines an event listener … Since event listeners cannot
  be registered on scoped providers, this handler will be ignored.` Listener binding:
  `instance.worker.on(options.eventName, instance[key].bind(instance))`. Queue-events listeners get a new
  `QueueEvents(queueName, {connection, prefix, sharedConnection, telemetry, ...queueEventsOptions})`
  each. Method scan uses the deprecated `metadataScanner.scanFromPrototype`. VERIFIED.
  Open issue for scoped event handlers: [nestjs/bull#1942](https://github.com/nestjs/bull/issues/1942).
- **No guards/interceptors/pipes/filters**: the processor is called directly. The only hook is
  `ProcessorDecoratorService.decorate(processor: Processor): Processor` — "This method can be overridden
  to provide custom behavior for processor decoration." VERIFIED. Kamil, [nestjs/bull#429](https://github.com/nestjs/bull/issues/429):
  "**Enhancers aren't supported (and there's no plan to do so)**". VERIFIED. (The docs mention "NestJS
  Observe instruments queue consumers automatically"; INFERRED that `ProcessorDecoratorService` is that
  instrumentation seam.)

### Sandboxed processors — VERIFIED

Only through `registerQueue({ processors: [...] })`, not `@Processor`. Types:
`BullQueueProcessor = BullQueueProcessorCallback | BullQueueAdvancedProcessor | BullQueueSeparateProcessor | BullQueueAdvancedSeparateProcessor`;
`BullQueueSeparateProcessor = string | URL`;
`BullQueueAdvancedSeparateProcessor extends Partial<WorkerOptions> { concurrency?; path: BullQueueSeparateProcessor; useWorkerThreads?: boolean }`.
`createQueueAndWorkers` builds `new workerClass(queueName, path, {connection, sharedConnection, prefix, ...processorOptions})`
— BullMQ forks/threads the file itself. Docs: "Because your function runs in a forked process, dependency
injection (and the IoC container) isn't available. Your processor function must contain (or create) all
instances of the external dependencies it needs." Example: `processors: [join(import.meta.dirname, 'processor.js')]`.

---

## 2. `@nestjs/bull` (legacy, 11.0.4) — VERIFIED

Repo: <https://github.com/nestjs/bull/tree/master/packages/bull/lib>

```ts
export interface ProcessOptions { name?: string; concurrency?: number; }
export declare function Process(): MethodDecorator;
export declare function Process(name: string): MethodDecorator;
export declare function Process(options: ProcessOptions): MethodDecorator;
export declare function Processor(): ClassDecorator;
export declare function Processor(queueName: string): ClassDecorator;
export declare function Processor(processorOptions: ProcessorOptions): ClassDecorator;  // { name?, scope? }
export declare const OnQueueEvent: (eventNameOrOptions: BullQueueEvent | BullQueueEventOptions) => MethodDecorator;
export declare const OnQueueActive: (options?: QueueEventDecoratorOptions) => MethodDecorator;
// …OnQueueError/Waiting/Stalled/Progress/Completed/Failed/Paused/Resumed/Cleaned/Drained/Removed,
// and OnGlobalQueue* for each (12 + 12).
```

- Per-method model: `explore()` in **`onModuleInit`** scans each `@Processor` class's methods; each
  `@Process` method becomes `queue.process(name?, concurrency?, callback)` on the **one Bull queue**
  (Bull 3/4 API) — so several `@Process` handlers share a queue and Bull routes by `job.name`. Request-scoped
  handlers use `createContextId()` + `registerRequestByContextId(job, contextId)` +
  `injector.loadPerContext` (no `ContextIdFactory`, so no durable strategy). Listener options
  `{name, id}` filter events by job name/id.
- Docs warning (legacy section): "When you define multiple consumers for the same queue, the `concurrency`
  option in `@Process({ concurrency: 1 })` doesn't take effect. The minimum `concurrency` matches the
  number of consumers defined. This applies even if the `@Process()` handlers use different names."
- **Why bullmq dropped it** — docs (BullMQ section): "In Bull, you could designate that a job handler
  method handles **only** jobs of a certain type … by passing that `name` to the `@Process()` decorator …
  **BullMQ doesn't support this behavior, because it caused confusion.** Instead, use a `switch` statement
  on the job name to call different services or logic for each kind of job". INFERRED underlying reason:
  BullMQ's `Worker` takes exactly one processor function per worker (no named `process()`), so the
  Nest wrapper maps one class → one `Worker` → one `process()`; per-name concurrency was illusory in Bull.

---

## 3. `@nestjs/schedule` (6.1.3; 12.0.2 differs only in ESM + `getInterval<T>`/`getTimeout<T>` generics and exporting `ScheduleExplorer`)

Repo: <https://github.com/nestjs/schedule/tree/master/lib>. VERIFIED from `dist/*.d.ts`/`.js`.

```ts
export type CronOptions = {
    name?: string;
    timeZone?: unknown;
    utcOffset?: unknown;
    unrefTimeout?: boolean;
    /** If true, no additional instances of cronjob will run until the current onTick callback has completed.
     *  Any new scheduled executions that occur while the current cronjob is running will be skipped entirely. */
    waitForCompletion?: boolean;
    /** This flag indicates whether the job will be executed at all. @default false */
    disabled?: boolean;
    /** Threshold in ms … Default is 250 */ threshold?: number;
    /** Delay in milliseconds before the first cron execution after application bootstrap. */ initialDelay?: number;
} & ({ timeZone?: string; utcOffset?: never } | { timeZone?: never; utcOffset?: number });

export declare function Cron(cronTime: CronJobParams['cronTime'], options?: CronOptions): MethodDecorator;
export declare function Interval(timeout: number): MethodDecorator;
export declare function Interval(name: string, timeout: number): MethodDecorator;
export declare function Timeout(timeout: number): MethodDecorator;
export declare function Timeout(name: string, timeout: number): MethodDecorator;

export declare class SchedulerRegistry {
    doesExist(type: 'cron' | 'timeout' | 'interval', name: string): boolean;
    getCronJob(name: string): CronJob<null, null>;
    getInterval(name: string): any;          // <T = any>(name): T in 12.x
    getTimeout(name: string): any;
    addCronJob(name: string, job: CronJob): void;
    addInterval<T = any>(name: string, intervalId: T): void;
    addTimeout<T = any>(name: string, timeoutId: T): void;
    getCronJobs(): Map<string, CronJob>;
    deleteCronJob(name: string): void;
    getIntervals(): string[];
    deleteInterval(name: string): void;
    getTimeouts(): string[];
    deleteTimeout(name: string): void;
}
export declare class ScheduleModule {
    static forRoot(options?: ScheduleModuleOptions): DynamicModule;   // { cronJobs?, intervals?, timeouts? }
    static forRootAsync(options: ScheduleModuleAsyncOptions): DynamicModule;
}
export declare enum CronExpression { EVERY_SECOND = "* * * * * *", EVERY_5_SECONDS = "*/5 * * * * *", …, EVERY_MINUTE = "*/1 * * * *", EVERY_5_MINUTES = "0 */5 * * * *", EVERY_HOUR = "0 0-23/1 * * *", EVERY_DAY_AT_1AM = "0 01 * * *", … }  // ~80 members; 6-field (seconds) and 5-field mixed
```

Lifecycle — VERIFIED ([schedule.explorer.ts](https://github.com/nestjs/schedule/blob/master/lib/schedule.explorer.ts), [scheduler.orchestrator.ts](https://github.com/nestjs/schedule/blob/master/lib/scheduler.orchestrator.ts)):

- `ScheduleExplorer.onModuleInit() → explore()`: scans `[...discoveryService.getControllers(), ...getProviders()]`
  with `metadataScanner.getAllMethodNames(prototype)` (falls back to `scanFromPrototype` for Nest < 9.3.2).
  **Non-static (request-scoped) providers are skipped with a warning**: `Cannot register cron job
  "${wrapper.name}@${key}" because it is defined in a non static provider.`
- Each handler is wrapped: `async (...args) => { try { await methodRef.call(instance, ...args) } catch (error) { this.logger.error(error) } }`
  — **no enhancers, errors only logged**.
- `SchedulerOrchestrator.onApplicationBootstrap() { mountTimeouts(); mountIntervals(); mountCron(); }`
  — cron via `CronJob.from({ ...options, onTick: target, start: !options.disabled && !options.initialDelay })`;
  `initialDelay` uses a `setTimeout` then `cronJob.start()`. Unnamed jobs get `crypto.randomUUID()`.
- `beforeApplicationShutdown() { clearTimeouts(); clearIntervals(); closeCronJobs(); }` — stops before
  the server closes; does **not** await in-flight ticks (INFERRED from code: `deleteCronJob` stops the job;
  nothing awaits a running `onTick`).
- Docs: "The scheduled jobs start in the `onApplicationBootstrap` lifecycle hook, which ensures that all
  modules have loaded and declared their scheduled jobs."

---

## 4. `@nestjs/event-emitter` (3.1.0; 12.0.1 differs only in ESM, re-exports `EventEmitter2` from a local shim, exports `EVENT_LISTENER_METADATA` and interfaces)

Repo: <https://github.com/nestjs/event-emitter/blob/master/lib/event-subscribers.loader.ts>. VERIFIED.

```ts
export type OnEventType = string | symbol | Array<string | symbol>;
export declare const OnEvent: (event: OnEventType, options?: OnEventOptions) => MethodDecorator;
export type OnEventOptions = OnOptions & { prependListener?: boolean; suppressErrors?: boolean; };
// eventemitter2 6.4.9:
export interface OnOptions { async?: boolean, promisify?: boolean, nextTick?: boolean, objectify?: boolean }
export interface EventEmitterModuleOptions extends ConstructorOptions { global?: boolean; inheritRequestContextId?: boolean; }
export declare class EventEmitterReadinessWatcher { waitUntilReady(): Promise<void>; setReady(): void; setErrored(error: Error): void; }
```

- `EventSubscribersLoader.onApplicationBootstrap()` → `loadEventListeners()` → `setReady()`;
  `onApplicationShutdown() { this.eventEmitter.removeAllListeners(); }`.
- Scans `[...getProviders(), ...getControllers()].filter(w => w.instance && !w.isAlias)` with
  `getAllMethodNames`. `prependListener` chooses `eventEmitter.prependListener` vs `on`; `async`/
  `promisify`/`nextTick`/`objectify` are passed straight to eventemitter2.
- `suppressErrors` **defaults to true**: `if (options?.suppressErrors ?? true) { this.logger.error(error.message, error.stack) } else { throw e }`.
- **Request-scoped listeners are supported** (unlike bull/schedule):

```js
registerRequestScopedListener(eventListenerContext) {
    const { listenerMethod, event, eventListenerInstance, moduleRef, listenerMethodKey, options } = eventListenerContext;
    listenerMethod(event, async (...args) => {
        const request = this.getRequestFromEventPayload(args);   // args.length > 1 ? args : args[0]
        const contextId = this.options.inheritRequestContextId
            ? ContextIdFactory.getByRequest(request)
            : ContextIdFactory.getByRequest({ payload: request });
        this.moduleRef.registerRequestByContextId(request, contextId);
        const contextInstance = await this.injector.loadPerContext(eventListenerInstance, moduleRef, moduleRef.providers, contextId);
        return this.wrapFunctionInTryCatchBlocks(contextInstance, listenerMethodKey, args, options);
    }, options);
}
```

  Docs: "If an event listener belongs to a request-scoped provider, Nest creates a new instance of that
  provider for every event it handles. The event payload takes the place of the request object … set the
  `inheritRequestContextId` option of `forRoot()` to `true` so that the listener reuses that request's DI
  sub-tree". Also: "Events emitted before or during the `onApplicationBootstrap` lifecycle hook … may be
  missed" → `await eventEmitterReadinessWatcher.waitUntilReady()`.
- No enhancers.

---

## 5. `@nestjs/cqrs` (11.0.3; 12.1.0 same handler model)

Repo: <https://github.com/nestjs/cqrs/tree/master/src>. VERIFIED.

```ts
export declare const CommandHandler: (command: ICommand | (new (...args: any[]) => ICommand), options?: InjectableOptions) => ClassDecorator;
export declare const EventsHandler: (...events: (IEvent | (new (...args: any[]) => IEvent) | InjectableOptions)[]) => ClassDecorator;
export declare const Saga: () => PropertyDecorator;
export declare class CommandBus {
    execute<R = void>(command: Command<R>): Promise<R>;
    execute<R = void>(command: Command<R>, context?: AsyncContext): Promise<R>;
    execute<T extends CommandBase, R = any>(command: T, context?: AsyncContext): Promise<R>;
    bind<T extends CommandBase>(handler: InstanceWrapper<ICommandHandler<T>>, id: string): void;
    register(handlers?: InstanceWrapper<ICommandHandler<CommandBase>>[]): void;
}
```

- `@CommandHandler` stores `COMMAND_HANDLER_METADATA` on the class, gives the command class a
  `{ id: randomUUID() }` (`COMMAND_METADATA`), and applies `Injectable(options)` when options are given
  (so `scope: Scope.REQUEST` goes there).
- Registration: `CqrsModule.onApplicationBootstrap()` → `ExplorerService.explore()` walks
  `ModulesContainer` (not `DiscoveryService`) filtering wrappers by metadata key, then
  `commandBus.register(commands)` etc.
- Request-scoped handlers (present in 11.0.3, VERIFIED):

```js
bind(handler, id) {
    if (handler.isDependencyTreeStatic()) {
        const instance = handler.instance;
        if (!instance.execute) throw new InvalidCommandHandlerException();
        this.handlers.set(id, (command) => instance.execute(command));
        return;
    }
    this.handlers.set(id, async (command, context) => {
        context ??= AsyncContext.of(command) ?? new AsyncContext();
        if (!AsyncContext.isAttached(context)) {
            this.moduleRef.registerRequestByContextId(context, context.id);
            context.attachTo(command);
        }
        const instance = await this.moduleRef.resolve(handler.metatype, context.id, { strict: false });
        return instance.execute(command);
    });
}
```

  `AsyncContext` has `readonly id = ContextIdFactory.create()`, `attachTo(target)` (non-enumerable symbol
  property), `static of/isAttached/merge`. Docs: "The payload must be an instance of `AsyncContext` …
  It acts as the request context". This is the cleanest public-API pattern: **`ContextIdFactory.create()` +
  `moduleRef.registerRequestByContextId(payload, id)` + `moduleRef.resolve(metatype, id, { strict: false })`** —
  no internal `Injector`. No enhancers.

---

## 6. Nest core APIs (installed 11.1.27; 12.1.2 identical except where noted)

### `DiscoveryService` / `DiscoveryModule` — VERIFIED ([discovery-service.ts](https://github.com/nestjs/nest/blob/master/packages/core/discovery/discovery-service.ts))

```ts
export type DiscoveryOptions = FilterByInclude /* { include?: Function[] } */ | FilterByMetadataKey /* { metadataKey?: string } */;
export type DiscoverableDecorator<T> = ((opts?: T) => CustomDecorator) & { KEY: string };
export declare class DiscoveryService {
    static createDecorator<T>(): DiscoverableDecorator<T>;
    getProviders(options?: DiscoveryOptions, modules?: Module[]): InstanceWrapper[];
    getControllers(options?: DiscoveryOptions, modules?: Module[]): InstanceWrapper[];
    getMetadataByDecorator<T extends DiscoverableDecorator<any>>(decorator: T, instanceWrapper: InstanceWrapper, methodKey?: string):
        T extends DiscoverableDecorator<infer R> ? R | undefined : T | undefined;
    protected getModules(options?: DiscoveryOptions): Module[];
}
export declare class DiscoveryModule {}
```

`createDecorator` implementation:

```js
static createDecorator() {
    const metadataKey = uid(21);
    const decoratorFn = (opts) => (target, key, descriptor) => {
        if (!descriptor) {
            DiscoverableMetaHostCollection.addClassMetaHostLink(target, metadataKey);
        }
        SetMetadata(metadataKey, opts ?? {})(target, key, descriptor);
    };
    decoratorFn.KEY = metadataKey;
    return decoratorFn;
}
```

So the `{ metadataKey }` fast path indexes **classes only**; a method-level use writes metadata but does
not register the class. Docs: "The same decorator can also be applied to methods. To read method-level
metadata, pass the method name as the third argument to `getMetadataByDecorator()`." (INFERRED version
of introduction: v10.x; I did not pin the release.) `InstanceWrapper`/`Module` types come from
`@nestjs/core/injector/*` (Nest 12: `@nestjs/core/internal`).

### `MetadataScanner` — VERIFIED

```ts
/** @deprecated @see getAllMethodNames */
scanFromPrototype<T extends Injectable, R = any>(instance: T, prototype: object | null, callback: (name: string) => R): R[];
/** @deprecated */ getAllFilteredMethodNames(prototype: object): IterableIterator<string>;
getAllMethodNames(prototype: object | null): string[];
```

(schedule's fallback comment dates `getAllMethodNames` to Nest 9.3.2.)

### `Reflector` — VERIFIED

```ts
export interface CreateDecoratorOptions<TParam = any, TTransformed = TParam> {
    key?: string;                                // @default uid(21)
    transform?: (value: TParam) => TTransformed; // @default value => value
}
export type ReflectableDecorator<TParam, TTransformed = TParam> = ((opts?: TParam) => CustomDecorator) & { KEY: string };
static createDecorator<TParam>(options?: CreateDecoratorOptions<TParam>): ReflectableDecorator<TParam>;
static createDecorator<TParam, TTransformed>(options: CreateDecoratorWithTransformOptions<TParam, TTransformed>): ReflectableDecorator<TParam, TTransformed>;
get<T extends ReflectableDecorator<any>>(decorator: T, target: Type<any> | Function): T extends ReflectableDecorator<any, infer R> ? R : unknown;
get<TResult = any, TKey = any>(metadataKey: TKey, target: Type<any> | Function): TResult;
getAll / getAllAndMerge / getAllAndOverride (decorator or key overloads, targets: (Type | Function)[])
```

### `ModuleRef` — VERIFIED (`injector/module-ref.d.ts`)

```ts
abstract get<TInput = any, TResult = TInput>(typeOrToken, options?: ModuleRefGetOrResolveOpts): TResult | Array<TResult>;  // + strict/each overloads
abstract resolve<TInput = any, TResult = TInput>(typeOrToken, contextId?: { id: number }, options?: { strict?: boolean; each?: undefined | false }): Promise<TResult>;
abstract resolve<…>(typeOrToken, contextId?, options?: { strict?: boolean; each: true }): Promise<Array<TResult>>;
abstract create<T = any>(type: Type<T>, contextId?: ContextId): Promise<T>;
introspect<T = any>(token: Type<T> | string | symbol): IntrospectionResult;
registerRequestByContextId<T = any>(request: T, contextId: ContextId): void;   // = container.registerRequestProvider(request, contextId)
```

### `ContextIdFactory` / `ContextIdStrategy` / durable — VERIFIED ([context-id-factory.ts](https://github.com/nestjs/nest/blob/master/packages/core/helpers/context-id-factory.ts))

```ts
export interface ContextId { readonly id: number; payload?: unknown; getParent?(info: HostComponentInfo): ContextId; }
export interface HostComponentInfo { token: InjectionToken; isTreeDurable: boolean; }
export type ContextIdResolverFn = (info: HostComponentInfo) => ContextId;
export interface ContextIdResolver { payload: unknown; resolve: ContextIdResolverFn; }
export interface ContextIdStrategy<T = any> {
    attach(contextId: ContextId, request: T): ContextIdResolverFn | ContextIdResolver | undefined;
}
export declare class ContextIdFactory {
    static create(): ContextId;
    static getByRequest<T extends Record<any, any> = any>(request: T, propsToInspect?: string[]): ContextId;  // default ['raw']
    static apply(strategy: ContextIdStrategy): void;   // ONE global strategy
}
```

`getByRequest`: returns `request[REQUEST_CONTEXT_ID]` or `request[prop][REQUEST_CONTEXT_ID]` if set; else
`create()` if no strategy; else a new id whose `getParent`/`payload` come from `strategy.attach`.
`@Injectable({ scope: Scope.REQUEST, durable: true })` — docs: "Nest reads the `durable` flag only on
providers explicitly declared with `Scope.REQUEST`". The microservices `getContextId` shows the canonical
durable handshake: register `isTreeDurable ? contextId.payload : Object.assign(request, contextId.payload)`
as the request provider.

### `ConfigurableModuleBuilder` — VERIFIED (`@nestjs/common/module-utils`)

```ts
export interface ConfigurableModuleBuilderOptions { optionsInjectionToken?: string | symbol; moduleName?: string; alwaysTransient?: boolean; }
export declare class ConfigurableModuleBuilder<ModuleOptions, StaticMethodKey extends string = 'register', FactoryClassMethodKey extends string = 'create', ExtraModuleDefinitionOptions = {}> {
    constructor(options?: ConfigurableModuleBuilderOptions, parentBuilder?: ConfigurableModuleBuilder<ModuleOptions>);
    setExtras<ExtraModuleDefinitionOptions>(extras: ExtraModuleDefinitionOptions, transformDefinition?: (definition: DynamicModule, extras: ExtraModuleDefinitionOptions) => DynamicModule): ConfigurableModuleBuilder<…>;
    setClassMethodName<StaticMethodKey extends string>(key: StaticMethodKey): ConfigurableModuleBuilder<…>;
    setFactoryMethodName<FactoryClassMethodKey extends string>(key: FactoryClassMethodKey): ConfigurableModuleBuilder<…>;
    build(): ConfigurableModuleHost<ModuleOptions, StaticMethodKey, FactoryClassMethodKey, ExtraModuleDefinitionOptions>;
}
// host: { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN, ASYNC_OPTIONS_TYPE, OPTIONS_TYPE }
```

`isGlobal` is not built in; the documented recipe is
`.setExtras({ isGlobal: false }, (definition, extras) => ({ ...definition, global: extras.isGlobal }))`.
golevelup's `RabbitMQModule extends ConfigurableModuleClass` (prior art for a module that both is
configurable and does discovery in its own `onApplicationBootstrap`).

### Lifecycle order — VERIFIED (`nest-application-context.js`)

```js
async init() { … await this.callInitHook(); await this.callBootstrapHook(); … }   // onModuleInit (all modules) then onApplicationBootstrap (all modules)
async close(signal) {                      // 11.1.27
    await this.initializationPromise;
    await this.callDestroyHook();          // onModuleDestroy        (modules reversed)
    await this.callBeforeShutdownHook(signal); // beforeApplicationShutdown (reversed)
    await this.dispose();                  // NestApplication: socketModule, microservicesModule, httpAdapter.close(), connected microservices
    await this.callShutdownHook(signal);   // onApplicationShutdown  (reversed)
    this.unsubscribeFromProcessSignals();
}
```

- Module order: `getModulesToTriggerHooksOn()` sorts by `b.distance - a.distance`; docs: "the most deeply
  imported modules (and global modules) go first, and the root module goes last. Each module's hooks are
  awaited before Nest moves on to the next module. The shutdown hooks run in the reverse order."
- Within a module, hooks run with `Promise.all` over **static, non-transient** instances
  (`wrapper.isDependencyTreeStatic() && !wrapper.isTransient`), then transient ones, then the module class.
  Request-scoped classes never get hooks (docs warning).
- `enableShutdownHooks(signals = [], options = {})`: listens on all `ShutdownSignal`s if none given; the
  handler runs the same destroy → beforeShutdown → dispose → shutdown sequence, then
  `process.kill(process.pid, signal)` (or `process.exit(0)` with `useProcessExit`). Docs: disabled by
  default; `app.close()` "doesn't terminate the Node.js process".
- **Nest 12.1.2 change**: `close()` → `shutdown()` (memoised `shutdownPromise`) → `runShutdownSequence`,
  which adds `await this.prepareClose()` first; for `NestApplication` that is
  `this.httpAdapter && await this.httpAdapter.beforeClose?.()` — `AbstractHttpAdapter.beforeClose(): void`,
  "Called by `app.close()` before the shutdown hooks run. No-op by default; override to enter a 'shutting
  down' state." Not in 11.1.27 or 11.2.7. VERIFIED. (Relevant to bun-nest's `BunHttpAdapter` if it ever
  targets 12.)
- INFERRED design consequence: a worker closed in `onModuleDestroy`/`beforeApplicationShutdown` drains
  **before** the HTTP server closes; bullmq closes workers in `onApplicationShutdown` (after), schedule
  stops timers in `beforeApplicationShutdown`.

---

## 7. The pipeline outside HTTP

### `ExternalContextCreator` — VERIFIED (installed 11.1.27, `helpers/external-context-creator.d.ts`; [source](https://github.com/nestjs/nest/blob/master/packages/core/helpers/external-context-creator.ts))

```ts
export interface ParamsFactory {
    exchangeKeyForValue(type: number, data: ParamData, args: any): any;
}
export interface ExternalContextOptions { guards?: boolean; interceptors?: boolean; filters?: boolean; }
export declare class ExternalContextCreator {
    static fromContainer(container: NestContainer): ExternalContextCreator;
    create<TParamsMetadata extends ParamsMetadata = ParamsMetadata, TContext extends string = ContextType>(
        instance: Controller,
        callback: (...args: unknown[]) => unknown,
        methodName: string,
        metadataKey?: string,
        paramsFactory?: ParamsFactory,
        contextId?: ContextId,
        inquirerId?: string,
        options?: ExternalContextOptions,
        contextType?: TContext,
    ): (...args: any[]) => Promise<any>;
    getMetadata<TMetadata, TContext extends string = ContextType>(instance, methodName, metadataKey?, paramsFactory?, contextType?): ExternalHandlerMetadata;
    getContextModuleKey(moduleCtor: Function | undefined): string;
    exchangeKeysForValues<TMetadata = any>(keys, metadata, moduleContext, paramsFactory, contextId?, inquirerId?, contextFactory?): ParamProperties[];
    createPipesFn(...); getParamValue(...); transformToResult(resultOrDeferred: any): Promise<any>;
    createGuardsFn<TContext extends string = ContextType>(guards, instance, callback, contextType?): Function | null;
    registerRequestProvider<T = any>(request: T, contextId: ContextId): void;
}
```

It is a provider of `InternalCoreModule` (`{ provide: ExternalContextCreator, useFactory: () =>
ExternalContextCreator.fromContainer(container) }`), so it is injectable anywhere. VERIFIED.

`create()` body (abridged, exact semantics), VERIFIED:

```js
create(instance, callback, methodName, metadataKey, paramsFactory, contextId = STATIC_CONTEXT, inquirerId,
       options = { interceptors: true, guards: true, filters: true }, contextType = 'http') {
    const moduleKey = this.getContextModuleKey(instance.constructor);       // providers only
    const { argsLength, paramtypes, getParamsMetadata } = this.getMetadata(instance, methodName, metadataKey, paramsFactory, contextType);
    const pipes = this.pipesContextCreator.create(instance, callback, moduleKey, contextId, inquirerId);
    const guards = this.guardsContextCreator.create(instance, callback, moduleKey, contextId, inquirerId);
    const exceptionFilter = this.filtersContextCreator.create(instance, callback, moduleKey, contextId, inquirerId);
    const interceptors = options.interceptors ? this.interceptorsContextCreator.create(...) : [];
    …
    const fnCanActivate = options.guards ? this.createGuardsFn(guards, instance, callback, contextType) : null;
    const fnApplyPipes = this.createPipesFn(pipes, paramsOptions);
    const handler = (initialArgs, ...args) => async () => {
        if (fnApplyPipes) { await fnApplyPipes(initialArgs, ...args); return callback.apply(instance, initialArgs); }
        return callback.apply(instance, args);
    };
    const target = async (...args) => {
        const initialArgs = this.contextUtils.createNullArray(argsLength);
        fnCanActivate && (await fnCanActivate(args));
        const result = await this.interceptorsConsumer.intercept(interceptors, args, instance, callback, handler(initialArgs, ...args), contextType);
        return this.transformToResult(result);                 // Observable → lastValueFrom
    };
    return options.filters ? this.externalErrorProxy.createProxy(target, exceptionFilter, contextType) : target;
}
```

Design-relevant facts (all VERIFIED from the code above unless marked):

1. **Options default only when the argument is `undefined`.** Passing `{ guards: true }` disables
   interceptors and filters (missing keys are falsy). golevelup passes `undefined`.
2. **Global enhancers are included and snapshotted at `create()` time.** Every `*ContextCreator.createContext`
   prepends `getGlobalMetadata(contextId, inquirerId)` = `applicationConfig.getGlobalGuards()` (both
   `app.useGlobalGuards(...)` and `APP_GUARD` providers, which the scanner adds via
   `applicationConfig.addGlobalGuard`), plus request-scoped global ones when `contextId !== STATIC_CONTEXT`.
   Same for interceptors, pipes, filters. `useGlobalGuards` *replaces* the array (`this.globalGuards =
   this.globalGuards.concat(guards)`) so a handler created **before** `app.useGlobal*()` misses them
   (INFERRED from the code; `NestFactory.create` → user `useGlobal*` → `listen()`/`init()` → hooks, so
   creating handlers in `onModuleInit`/`onApplicationBootstrap` is safe). `INestApplicationContext`
   (standalone) has no `useGlobal*`; only `APP_*` providers apply there (fixed in PR #12166, 2023).
   golevelup's README warns: global enhancers "will also apply to all RabbitMQ message handlers. If you
   were previously expecting all contexts to be HTTP contexts, you may need to add conditional logic".
3. **Guard rejection throws `ForbiddenException`** (`common_1.ForbiddenException(FORBIDDEN_MESSAGE)`) — an
   HTTP exception — whereas `RpcContextCreator` throws `RpcException` and `WsContextCreator` `WsException`.
4. **Filters**: `ExternalErrorProxy.createProxy` catches, builds `new ExecutionContextHost(args)`,
   `host.setType(type)`, calls `exceptionsHandler.next(e, host)`. `ExternalExceptionsHandler.next` tries
   custom filters (class/method `@UseFilters` + global filters, reversed); **if none handles it, the base
   `ExternalExceptionFilter.catch` logs the error (unless `IntrinsicException`) and re-throws it.** So a
   filter that returns a value swallows the error (the job would "succeed" with that value); otherwise the
   error propagates to the caller (the queue). INFERRED: a job library must decide what a filter's return
   means.
5. **Pipes run only on decorated params.** `createPipesFn` returns `null` when `paramsOptions` is empty,
   and then `callback.apply(instance, args)` gets the raw args. When some params are decorated, the call
   uses a fresh `createNullArray(argsLength)` where `argsLength = max(decorated index) + 1`: **undecorated
   parameters receive `null`/are dropped**. (Same as HTTP.) Global pipes therefore only touch decorated params.
6. **Param metadata key**: `getMetadata` reads `Reflect.getMetadata(metadataKey || '', instance.constructor, methodName)`.
   `createParamDecorator` always writes to `ROUTE_ARGS_METADATA = "__routeArguments__"`, under the key
   `` `${uid(21)}${CUSTOM_ROUTE_ARGS_METADATA}:${index}` `` with `{ index, factory, data, pipes }`; built-in
   decorators use `` `${paramtype}:${index}` ``. graphql (`PARAM_ARGS_METADATA = '__routeArguments__'`),
   microservices (`PARAM_ARGS_METADATA = ROUTE_ARGS_METADATA`) and golevelup (`ROUTE_ARGS_METADATA`) all
   use the same key, so **user `createParamDecorator` decorators work in every context**.
7. **Custom vs numeric params**: in `exchangeKeysForValues`, a key containing `__customRouteArgs__` gets
   `extractValue = (...args) => factory(data, contextFactory(args))`, where `contextFactory` builds an
   `ExecutionContextHost(args, instance.constructor, instance[methodName])` with `setType(contextType)` —
   so a custom decorator calls `ctx.getType()`/`ctx.getArgByIndex(i)`/`ctx.switchToRpc()`. Any other key
   maps `type = Number(key.split(':')[0])` and calls **`paramsFactory.exchangeKeyForValue(numericType, data, args)`**.
   A library defines its own numeric param types (golevelup: `RABBIT_PARAM_TYPE = 3`, `HEADER = 4`,
   `REQUEST = 5`; they overlap `RouteParamtypes` numbers, which is harmless because the factory is per
   context).
8. **`getHandler()` is the `callback` you pass, method metadata is read from it** (`reflectMethodMetadata(callback, key)`
   for `@UseGuards` etc.; `ExecutionContextHost(args, constructorRef, handler)`). Passing a bound or
   wrapped function loses `@SetMetadata`/`@UseGuards` method metadata — golevelup copies every
   `Reflect.getMetadataKeys(originalHandler)` onto `boundHandler` for exactly this reason. Pass the
   prototype method (`prototype[methodName]`) as graphql does.
9. **Metadata is cached per `(instance, methodName)`** in `HandlerMetadataStorage`; for request-scoped
   handlers graphql/microservices call `create()` per request with the per-context instance and
   `contextId`, `inquirerId = wrapper.id`.

### `ExecutionContext.getType` / `ContextType` / `ExecutionContextHost.setType` — VERIFIED

- `@nestjs/common` `arguments-host.interface.d.ts`: `export type ContextType = 'http' | 'ws' | 'rpc';`
  and `getType<TContext extends string = ContextType>(): TContext;` (unchanged in 12.1.2).
- `ExecutionContextHost`: `constructor(args, constructorRef = null, handler = null)`, `contextType = 'http'`,
  `setType(type) { type && (this.contextType = type); }`, `getType() { return this.contextType; }`.
- graphql: `export type GqlContextType = 'graphql' | ContextType;` and
  `GqlExecutionContext extends ExecutionContextHost` with `static create(context: ExecutionContext)` →
  `new GqlExecutionContext(normalizeResolverArgs(context.getArgs()), context.getClass(), context.getHandler()); gqlContext.setType(type)`,
  plus `getRoot/getArgs/getContext/getInfo` = `getArgByIndex(0..3)`. **That is the whole mechanism for a
  custom context type**: pass a string as `create(..., contextType)` and ship a typed helper that wraps
  `ExecutionContext`. Docs (`fundamentals/execution-context.md`): "It returns `'http'`, `'rpc'`, or `'ws'`
  out of the box, and packages such as `@nestjs/graphql` add their own types" with
  `host.getType<GqlContextType>() === 'graphql'`.

### How the first-party transports use it — VERIFIED

- **@nestjs/graphql 13.4.5** ([resolvers-explorer.service.ts](https://github.com/nestjs/graphql/blob/master/packages/graphql/lib/services/resolvers-explorer.service.ts))
  uses `ExternalContextCreator` directly:
  `this.externalContextCreator.create(instance, prototype[resolver.methodName], resolver.methodName, PARAM_ARGS_METADATA, paramsFactory, undefined, undefined, contextOptions, 'graphql')`.
  Request-scoped: per call, `gqlContext = paramsFactory.exchangeKeyForValue(GqlParamtype.CONTEXT, undefined, args)`,
  `contextId = ContextIdFactory.getByRequest(gqlContext, ['req'])` (then defines `REQUEST_CONTEXT_ID` on it),
  registers the REQUEST provider by hand (`InternalCoreModule`'s `REQUEST` wrapper →
  `setInstanceByContextId(contextId, { instance: contextId.getParent ? contextId.payload : request, isResolved: true })`),
  `injector.loadPerContext(...)`, then `create(contextInstance, …, contextId, wrapper.id, contextOptions, 'graphql')`.
  `contextOptions` disables enhancers for field resolvers unless `fieldResolverEnhancers` opts in.
  `GqlParamsFactory.exchangeKeyForValue` maps ROOT/ARGS/CONTEXT/INFO to `args[0..3]`.
- **@nestjs/microservices 11.2.7** has its **own copy**, `RpcContextCreator.create(instance, callback,
  moduleKey, methodName, contextId?, inquirerId?, defaultCallMetadata?)`, `contextType = 'rpc'`, guard
  failure → `RpcException(FORBIDDEN_MESSAGE)`, filters via `RpcProxy` (`host.setType('rpc')`).
  `ListenersController.createRequestScopedHandler` per message: `RequestContextHost.create(pattern, data, reqCtx)`,
  `getContextId(request, isTreeDurable)` (`ContextIdFactory.getByRequest`, define `REQUEST_CONTEXT_ID`,
  `container.registerRequestProvider(isTreeDurable ? contextId.payload : Object.assign(request, contextId.payload), contextId)`),
  `injector.loadPerContext(instance, moduleRef, moduleRef.controllers, contextId)`, then
  `contextCreator.create(contextInstance, contextInstance[methodKey], moduleKey, methodKey, contextId, wrapper.id, …)`.
- **@nestjs/websockets 11.1.27**: its own `WsContextCreator.create(instance, callback, moduleKey, methodName)`,
  `contextType = 'ws'`, `WsProxy` sets `'ws'`; no `contextId` parameter (gateways cannot be request-scoped).
- INFERRED: first-party transports fork the creator to throw their own exception types; third parties
  (graphql is first-party but external, golevelup, necord) reuse `ExternalContextCreator`.

---

## 8. `@nestjs/terminus` custom indicators — VERIFIED

11.1.1 (`health-indicator/health-indicator.service.d.ts`):

```ts
export declare class HealthIndicatorService { check<const Key extends string>(key: Key): HealthIndicatorSession<Key>; }
export declare class HealthIndicatorSession<Key extends Readonly<string> = string> {
    constructor(key: Key);
    down<T extends AdditionalData>(data?: T & WithoutStatus<T>): HealthIndicatorResult<Key, 'down', T>;
    down<T extends string>(data?: T): HealthIndicatorResult<Key, 'down', { message: T }>;
    up<T extends AdditionalData>(data?: T & WithoutStatus<T>): HealthIndicatorResult<Key, 'up', T>;
    up<T extends string>(data?: T): HealthIndicatorResult<Key, 'up', { message: T }>;
}
```

12.1.0 adds `degraded(...)`, `attempt(fn: ({ signal: AbortSignal }) => Promise<AdditionalData | void> | AdditionalData | void): HealthCheckAttempt<Key>`,
and `HealthCheckAttempt implements PromiseLike<HealthIndicatorResult<Key>>` with `withTimeout(ms)` and
`cacheFor(ttlMs)`. Docs example (current master):

```ts
@Injectable()
export class DogHealthIndicator {
  constructor(private readonly healthIndicatorService: HealthIndicatorService) {}
  isHealthy(key: string) {
    return this.healthIndicatorService.check(key)
      .attempt(async ({ signal }) => { /* … */ return { breeds: n }; })
      .withTimeout(1000);
  }
}
```

The old class is still shipped in 11.1.1 **and 12.1.0**, marked:
"`@deprecated` **This class has been deprecated and will be removed in the next major release.** Instead
utilise the `HealthIndicatorService`" (`export declare abstract class HealthIndicator { protected getStatus(key, isHealthy, data?) }`,
used with `HealthCheckError`). INFERRED: for a plan targeting Nest 11 use `check(key).up()/down()`
(available on both); `attempt()` is 12-only.

---

## Third-party prior art

### `@golevelup/nestjs-rabbitmq` 9.1.0 — VERIFIED ([rabbitmq.module.ts](https://github.com/golevelup/nestjs/blob/master/packages/rabbitmq/src/rabbitmq.module.ts))

- `RabbitMQModule extends ConfigurableModuleClass`, imports `@golevelup/nestjs-discovery`'s
  `DiscoveryModule`, injects `ExternalContextCreator` and `RabbitRpcParamsFactory`.
- `onApplicationBootstrap()` (guarded by a static `bootstrapped` flag): for each connection with
  `registerHandlers`, `discover.providerMethodsWithMetaAtKey(RABBIT_HANDLER)` (+ controllers when
  `enableControllerDiscovery`), then per method:

```js
const originalHandler = discoveredMethod.handler;
const instance = discoveredMethod.parentClass.instance;
const boundHandler = originalHandler.bind(instance);
// Copy all Reflect metadata from the original prototype method to the bound function so that
// metadata-based features continue to work correctly (e.g. isRabbitContext(), method-level
// interceptors, guards and pipes whose metadata lives on the function object).
for (const metaKey of Reflect.getMetadataKeys(originalHandler)) {
    Reflect.defineMetadata(metaKey, Reflect.getMetadata(metaKey, originalHandler), boundHandler);
}
const handler = this.externalContextCreator.create(instance, boundHandler, discoveredMethod.methodName,
    ROUTE_ARGS_METADATA, this.rpcParamsFactory, undefined /* contextId */, undefined /* inquirerId */,
    undefined /* options */, RABBIT_CONTEXT_TYPE_KEY /* 'rmq' */);
```

- `isRabbitContext` does **not** use `getType()`:
  `(executionContext) => Reflect.getMetadataKeys(executionContext.getHandler()).includes(RABBIT_HANDLER)`.
  The README offers both: `context.getType<'http' | typeof RABBIT_CONTEXT_TYPE_KEY>() === RABBIT_CONTEXT_TYPE_KEY`
  and `isRabbitContext(context)`.
- `RabbitRpcParamsFactory.exchangeKeyForValue(type, data, args)`: index 0/1/2 for PARAM/REQUEST/HEADER
  types, `data && !isObject(data) ? args[index]?.[data] : args[index]`. Param decorators
  `RabbitPayload(propertyKey?, ...pipes)`, `RabbitHeader`, `RabbitRequest` write `ROUTE_ARGS_METADATA`.
- `@RabbitSubscribe(config)`/`@RabbitRPC(config)` = `makeRabbitDecorator({ type })` (SetMetadata
  `RABBIT_HANDLER`).
- **No request-scoped handler support** (static `parentClass.instance`, `contextId` undefined). INFERRED
  from code; README does not claim it.

### `@wavezync/nestjs-pgboss` 7.0.2 (the maintained "nestjs-pgboss") — VERIFIED ([handler-scanner.service.ts](https://github.com/wavezync/nestjs-pgboss/blob/main/lib/handler-scanner.service.ts))

- `@Job(name, options?: WorkOptions, queueOptions?: QueueOptions)`, `@CronJob(name, cron, options?: ScheduleOptions)` method decorators.
- `PgBossModule.onApplicationBootstrap()` → scan every module's providers (raw `ModulesContainer`,
  `Object.getOwnPropertyNames(prototype)`), `pgBossService.registerJob(jobName, methodRef.bind(instance), …)`;
  `onModuleDestroy()` → `boss.stop()`.
- **Does not use `ExternalContextCreator`**: no guards/interceptors/pipes/filters, no request scope
  (`provider.instance` must be an object). Useful as the "minimal" contrast. (`@wahyubucil/nestjs-pgboss`
  is not on npm — 404.)

---

## Summary table: who does what

| | Discovery | Starts in | Stops in | Request scope | Enhancers |
|---|---|---|---|---|---|
| @nestjs/bullmq | `DiscoveryService.getProviders()` + class metadata | `onModuleInit` (Worker autorun) | `onApplicationShutdown` | yes, `ContextIdFactory.getByRequest(job)` + `Injector.loadPerContext`; job = `REQUEST` | none (`ProcessorDecoratorService` hook) |
| @nestjs/bull | same, per-method `@Process` | `onModuleInit` | queue `onApplicationShutdown` | yes, `createContextId()` | none |
| @nestjs/schedule | controllers + providers, `getAllMethodNames` | `onApplicationBootstrap` | `beforeApplicationShutdown` | skipped with warning | none; errors logged |
| @nestjs/event-emitter | providers + controllers | `onApplicationBootstrap` | `onApplicationShutdown` | yes, payload = `REQUEST` | none; `suppressErrors` default true |
| @nestjs/cqrs | `ModulesContainer` walk | `onApplicationBootstrap` | — | yes, `AsyncContext` + `moduleRef.resolve` | none |
| @nestjs/graphql | own explorer | schema build | — | yes | `ExternalContextCreator`, `'graphql'` |
| @nestjs/microservices | own | `listen` | `dispose` | yes (durable aware) | own `RpcContextCreator`, `'rpc'` |
| golevelup rabbitmq | golevelup discovery | `onApplicationBootstrap` | — | no | `ExternalContextCreator`, `'rmq'` |
| wavezync pgboss | `ModulesContainer` | `onApplicationBootstrap` | `onModuleDestroy` | no | none |
