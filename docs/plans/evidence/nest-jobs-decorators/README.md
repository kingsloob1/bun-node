# Evidence: bun-jobs in NestJS through decorators

The evidence behind [`../../nest-jobs-decorators.md`](../../nest-jobs-decorators.md).
Gathered on **2026-10-10**, on one shared laptop (i9-11900H, 16 threads,
Linux 7.0.0-38-generic), with Bun 1.4.3 (`1.4.3-canary.1+bbdc5a519`),
`@nestjs/common` and `@nestjs/core` 11.1.27 and TypeScript 6.0.3, against
`develop` at `bbe1120`. Peer sessions ran at the same time, at load averages of 17 to 29, so
compare within a run. Nothing here is part of a published package, and the
repo's tooling does not build, typecheck or lint it ([`../README.md`](../README.md)
says why).

`proto.ts` is a throwaway prototype of the integration, about 250 lines,
just enough to run the real Nest pipeline around real bun-jobs workers. It
is **not** the design. Its names, options and error handling are cut down to
what the spikes need. Every spike except `boot-cost.ts`,
`decorator-config.ts` and `authorize.ts` imports it.

| Path | Question | Re-run | Result file |
|---|---|---|---|
| `pipeline.ts` | Do guards, interceptors, pipes, exception filters and a user's own `createParamDecorator` run around a bun-jobs handler through `ExternalContextCreator`, under the context type `"bun-jobs"`? Do `APP_GUARD` and `app.useGlobalInterceptors` reach it? What does a filter's return value do to the job? What does Nest log on an unfiltered job error? | `bun pipeline.ts` | `results-pipeline.txt` |
| `lifecycle.ts` | On `app.close()`, which drain point lets a job that is in flight finish before the service it uses is destroyed? Eight scenarios | `bun lifecycle.ts` | `results-lifecycle.txt` |
| `scoped.ts` | A request-scoped processor: a fresh DI sub-tree per job with `REQUEST` set to the job. Per-job cost against a singleton and a plain worker | `bun scoped.ts 2000`, `bun scoped.ts 20000` | `results-scoped.txt` |
| `boot-cost.ts`, `nest-boot-child.ts` | What would a worker-thread or child-process attempt pay to build a Nest context for a DI processor? bun-jobs starts a fresh thread or process for every attempt | `bun boot-cost.ts` | `results-boot-cost.txt` |
| `types.ts` | What TypeScript catches from an injected queue to a decorated handler, under `declaration: true` | `bunx tsc --noEmit -p .` | `results-types.txt` |
| `decorator-config.ts`, `decorator-config/` | Why the spikes injected `undefined` before this folder had a `tsconfig.json` | `bun decorator-config.ts` | `results-decorator-config.txt` |
| `prior-art.md` | What `@nestjs/bullmq`, `@nestjs/bull`, `@nestjs/schedule`, `@nestjs/event-emitter`, `@nestjs/cqrs`, `@nestjs/microservices`, `@nestjs/graphql`, `@nestjs/terminus`, `@golevelup/nestjs-rabbitmq` and `@wavezync/nestjs-pgboss` do, and Nest core's `DiscoveryService`, `MetadataScanner`, `Reflector`, `ModuleRef`, `ContextIdFactory`, `ConfigurableModuleBuilder`, lifecycle order and `ExternalContextCreator`. Read 2026-10-10 from the packed npm tarballs (Nest 11 and 12 lines) and docs.nestjs.com at `e0984c78`; each claim marked VERIFIED or INFERRED. The tarballs and saved doc pages it names under `research/` were not kept | — | — |
| `authorize.ts` | Can an app's own guard, built by DI and reading `Reflector` metadata, decide the management API's `authorize`, using only Nest's public interfaces? | `bun authorize.ts` | `results-authorize.txt` |

## Headlines

- **The whole Nest pipeline runs around a job handler** (`results-pipeline.txt`):
  - guards, including one reading `Reflector` metadata;
  - a pipe validating `@JobData()` against a Standard Schema;
  - a class interceptor;
  - a method filter;
  - a user's own `createParamDecorator`.

  `getType()` answers `"bun-jobs"` in all of them. **The global ones reach
  jobs too.** `APP_GUARD` and `app.useGlobalInterceptors()` both ran for every
  job.
- Where errors end up (`results-pipeline.txt`):
  - **A filter that returns a value completes the job with that value.**
  - **An error with no filter is logged by Nest's `ExceptionsHandler`, with
    its stack, and then rethrown.** bun-jobs records it as usual.
  - **A guard that denies throws `ForbiddenException`**, which bun-jobs
    retries like any other error.
- **Only a drain attached to each processor instance let the in-flight job
  finish** (scenarios E and H in `results-lifecycle.txt`).
  - Draining in the jobs module's `onModuleDestroy` failed (A, C, G), and so
    did draining in `beforeApplicationShutdown` (B). In each, the
    "database" was already closed.
  - A non-global jobs module imported by the root module worked (D), but
    only because of where it sits among the modules.
  - A database service in the **same module** as the processor is destroyed
    concurrently with the processor, and the job failed (F).
- **Per-job cost** (`results-scoped.txt`, 20,000 jobs, memory driver):
  - a singleton processor through the full pipeline costs 0 to 3 µs/job over
    a plain worker (11 to 15 µs/job);
  - a request-scoped one costs about 35 to 80 µs/job.
- **An off-thread DI processor pays the Nest bootstrap on every attempt**
  (`results-boot-cost.txt`).
  - A small three-provider context adds about 115 to 130 ms per attempt,
    over the ~135 ms that importing bun-jobs already costs in a fresh thread
    or process.
  - An application module that opens connections pays those too.
- **Types** (`results-types.txt`):
  - A token that *is* the queue's type catches a wrong payload and a wrong
    name. The token has to be a named abstract class extending `BunQueue`: a
    factory returning an anonymous class fails declaration emit (`TS4094`,
    once per private or protected member of `BunQueue`, 57 in all, and `TS4023`).
  - A method decorator can check a `(job, ctx)` handler's payload and result,
    and it refuses a handler written with parameter decorators.
  - `@JobData()` cannot be checked.
- **Bun takes `experimentalDecorators` and `emitDecoratorMetadata` from the
  working directory's `tsconfig.json`, not from the file's nearest one**
  (`results-decorator-config.txt`). When they are off, parameter decorators
  are silently not applied, and Nest injects `undefined`.
  - This folder has its own `tsconfig.json` for that reason; run the spikes
    from here.
  - A Bun-only reproduction is drafted for upstream (the plan's §13 R3). The
    same lookup is reported for `jsxImportSource` in oven-sh/bun#28605.
- **Guards can decide the API's `authorize`** (`results-authorize.txt`).
  - With an `ExecutionContext` built from the public interface:
    - a reader is allowed `GET /queues` and refused `POST …/pause` (403);
    - an admin is allowed both;
    - a controller beside the API is untouched.
