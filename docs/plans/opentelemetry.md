# OpenTelemetry for bun-node — implementation plan

Status: plan only, nothing implemented. Written 2026-09-22 against `develop`
at `8396815`, Bun 1.4.3-canary.1 on linux-x64.

Everything below marked **measured** was run on this machine while writing
this; everything marked **assumed** was not. Where the research is
inconclusive the text says so rather than picking a side.

---

## 1. Executive summary

### 1.1 What this adds

Three signals across three packages:

| Package | Traces | Metrics | Logs |
|---|---|---|---|
| bun-common | HTTP server span per request, optional middleware/handler spans, WebSocket spans | `http.server.request.duration`, `http.server.active_requests` | correlation only (inject `trace_id`/`span_id` into `LogEvent`) |
| bun-nest | inherits bun-common's; enriches `http.route` from Nest's route registration; gateway message spans | inherits | inherits |
| bun-jobs | producer/consumer spans with W3C context carried inside the job record, driver spans, runner spans | queue depth, claim wait, process duration, outcomes, worker busyness — **exposed from the counters that already exist**, not a parallel set | correlation only |

### 1.2 The dependency question — firm recommendation

**Take `@opentelemetry/api` as an _optional peer_ of `@kingsleyweb/bun-common`
only, imported by exactly one file, reachable from exactly one new `exports`
entry: `@kingsleyweb/bun-common/otel`. Everything else in the repo — every
instrumented file, and all of bun-jobs and bun-nest — talks to a
zero-dependency internal interface (`TelemetryHooks`) and never names an OTel
type.**

This is deliberately *not* the `logging.ts` pattern, and the reasons are
specific:

- **`logging.ts` is structural because there are eight incompatible logging
  libraries and no standard.** `resolveLogger` exists to paper over pino vs
  winston vs consola. There is no equivalent fragmentation in tracing: there
  is one API package, and it exists precisely so libraries can embed it.
  The OTel spec's versioning document states the goal outright —
  *"Instrumentation APIs cannot create a version conflict, ever"* — and
  guarantees a stable API major is supported for **at least three years**
  after its successor ships. `@opentelemetry/api` has been `1.x` since 2021
  and is currently `1.9.1`.
- **A structural shim cannot do the job.** A `LoggerLike` adapter is ~30 lines
  per backend because a logger is six functions of `(string, object)`. A
  tracer is not: to be useful ours must participate in `context.active()`, so
  that a consumer's own DB/HTTP-client spans nest under our server span and our
  job span. Reimplementing `Context`, `SpanContext`, trace flags, `tracestate`
  parsing, `TextMapPropagator`, `Baggage`, and the Meter API with its
  instrument kinds and bucket advisories is roughly 2,000 lines re-deriving a
  stable spec — and at the end, to interoperate, it still has to hand off to
  `@opentelemetry/api`. A private tracer that does not share the active context
  produces disconnected traces, which is worse than no traces.
- **A hard dependency is still wrong.** `@opentelemetry/api` in
  `dependencies` puts it in the tree of every consumer, including the majority
  who never turn tracing on. That is the thing `CLAUDE.md`'s dependency policy
  exists to prevent.

The split therefore is:

```
lib/telemetry/index.ts     core   — zero deps, exported from the root barrel,
                                    imported by BunRouter/BunHttpAdapter/…
lib/telemetry/otel.ts      bridge — the ONLY file importing @opentelemetry/api,
                                    reachable only from exports["./otel"]
```

`checkPeerScopes` in `scripts/build-declarations.ts` enforces that separation
mechanically: the root entry must never reach a declaration importing an
optional peer. This is bun-nest's `./jobs` precedent, applied once.

**One new entry point in the whole repo.** bun-jobs and bun-nest gain *no*
OTel peer and *no* new subpath: a consumer writes

```ts
import { otelTelemetry } from "@kingsleyweb/bun-common/otel";
const jobs = new BunJobs({ namespace: "svc", telemetry: otelTelemetry() });
```

because `TelemetryHooks` is a bun-common type and bun-jobs already depends on
bun-common.

### 1.3 Measured, on this machine, Bun 1.4.3-canary.1

`@opentelemetry/api@1.9.1`, `@opentelemetry/sdk-trace-base@2.11.0`,
`@opentelemetry/context-async-hooks@2.11.0`, 200k–500k iterations after a 20k
warm-up. The empty-loop floor is ~9 ns/op, so subtract that for marginal cost.

| Operation | ns/op | Notes |
|---|---:|---|
| `if (!enabled) return` (loop floor baseline) | 8.7 | the number to beat |
| `context.active()` | 9.5 | |
| `trace.getSpan(context.active())` | 16.7 | |
| **no-op** tracer: `startSpan` + `end` | 24.1 | SDK absent |
| **no-op** tracer: `startSpan` + 6 attrs + `end` | 20.0 | attrs are free on a no-op |
| **no-op** tracer: `startActiveSpan(name, syncFn)` | **184.4** | closure + context dance; **avoid on hot paths** |
| ALS context manager: `context.with(ctx, syncFn)` | 63.9 | |
| SDK on, AlwaysOn, BatchSpanProcessor: `startSpan` + 6 attrs + `end` | **1,193** | |
| SDK on, AlwaysOn: `startActiveSpan` + `end` | 1,378 | |
| SDK on, **AlwaysOff** sampler: `startSpan` + 6 attrs + `end` | 527 | sampled-out still allocates |

Two conclusions drive the design:

1. Even a no-op span is ~15 ns of marginal cost, and `startActiveSpan` is
   ~175 ns. That is not zero. **The default must be an `undefined` check on an
   instance field, not a null-object tracer**, and the traced path must live in
   a separate method so the hot path is one monomorphic branch.
2. A recorded span is ~1.2 µs. Against `throughput/memory` at 127,762 jobs/s
   (7.8 µs/job, `packages/bun-jobs/bench/baselines/queue.json`), a producer +
   consumer span pair is ~2.4 µs — **~31 % on the memory backend**, ~7 % on
   Redis (33 µs/job), ~1 % on Postgres. Telemetry-on must never be benchmarked
   against the existing baselines.

### 1.4 Bun's own OTel support — verified state

- **There is no shipped Bun OpenTelemetry integration.** `Bun.otel` exists
  only in oven-sh/bun **PR #39965**, `state: open`, `merged: false`, created
  2026-08-21, last touched 2026-09-02. `https://bun.com/docs/runtime/opentelemetry`
  404s. Probed locally: `import("bun:otel")` fails with `Cannot find package 'otel'`.
  **Nothing in this plan may assume it.** If it lands, it routes
  `@opentelemetry/api` to Bun's native provider — so an API-only design like
  this one benefits automatically and needs no change.
- **What Bun 1.4 did ship** (blog, 2026-08-20) is Node-compat:
  `@opentelemetry/instrumentation-http` and `-fs` work against `node:http`/`node:fs`,
  and `shimmer` + `require-in-the-middle` patch bundled code. That does **not**
  reach `Bun.serve`, which is why bun-common must instrument itself.
- **AsyncLocalStorage works, with documented holes.** Bun's Node-compat table:
  `AsyncLocalStorage` and `AsyncResource` implemented; `createHook`,
  `executionAsyncId`, `triggerAsyncId` are stubs and async ids are always `0`.
  1.4.1 made `run()` ~2× faster (28.8 → 15.9 ns/op) by dropping a per-`await`
  allocation; 1.4.2 fixed an ALS leak that 1.4.1 introduced.
  **Bun documents that ALS does not propagate into `MessagePort`,
  `BroadcastChannel` or `Worker` events.**
- **Measured here, filling gaps the research could not close:**

  ```
  bodies: [ "req-1", "req-2", "req-3", "req-4" ]
  handler observations:
    1:leaked=none:seen=req-1   2:leaked=none:seen=req-2
    3:leaked=none:seen=req-3   4:leaked=none:seen=req-4
  worker sees store: undefined
  ```

  A `Bun.serve` handler starts with **no inherited ALS store** even when the
  caller is inside one; a store entered *inside* the handler survives
  `setTimeout`, `await`, a failed `fetch` and four interleaved concurrent
  requests with no cross-contamination; a `new Worker()` sees nothing. Also
  verified: ALS survives `queueMicrotask` and `for await` over a
  `ReadableStream`.

  That is exactly the shape needed: we own the per-request context, nobody
  leaks into it, and the `Worker` boundary must be crossed by serialising
  `traceparent` — which the runner protocol already has a slot for.
- The repo already depends on this behaviour: `packages/bun-jobs/lib/runner/consoleCapture.ts:42`
  uses an `AsyncLocalStorage<ConsoleSink>` to attribute console calls per
  in-process run, for exactly the same reason.

### 1.5 Semantic conventions targeted

**semconv v1.44.0** (released 2026-08-04).

- **HTTP spans and `http.server.request.duration`: Stable.**
- **Messaging spans and metrics: Development** — nothing adopted for bun-jobs
  is API-stable, and v1.44.0 itself restructured messaging spans into five
  per-operation definitions and moved `messaging.consumer.group.name` and
  `messaging.destination.subscription.name` off the generic span tables. Pin
  the version in code and treat a semconv bump as a breaking change to the
  telemetry surface, behind an opt-in flag.
- `url.full` is a **client**-span attribute. It must not be set on our server
  spans.

---

## 2. Design — the public API surface

### 2.1 The core interface (`packages/bun-common/lib/telemetry/index.ts`)

Zero dependencies. Every instrumented file imports only from here. Nothing in
this file names an OpenTelemetry type, so it is safe for the root barrel.

```ts
/** A value an attribute may carry — what every backend can represent. */
export type AttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

/** Attributes set on a span or a measurement. */
export type Attributes = Record<string, AttributeValue | undefined>;

/**
 * The span kinds this repo emits, spelled as the OTel enum's names rather
 * than its numbers so the core never imports `@opentelemetry/api`.
 * The bridge maps them.
 */
export type SpanKindName =
  | "internal"
  | "server"
  | "client"
  | "producer"
  | "consumer";

/**
 * An opaque handle to a propagation context — a W3C `traceparent`/`tracestate`
 * pair as extracted or as it will be injected.
 *
 * Deliberately a plain object: it is what crosses a process boundary inside a
 * job record or the runner protocol, so it must survive `JSON.stringify`.
 * `tracestate` is omitted when empty and truncated by the bridge (see
 * {@link OtelTelemetryOptions.maxTraceStateBytes}).
 */
export interface TraceCarrier {
  /** The W3C `traceparent` header value, e.g. `00-<32 hex>-<16 hex>-01`. */
  traceparent: string;
  /** The W3C `tracestate` header value, when the producer had one. */
  tracestate?: string;
}

/**
 * A span being started. Built by the caller only when telemetry is on, so
 * nothing here is allocated on the default path.
 */
export interface SpanSpec {
  /** The span name, already low-cardinality (e.g. `GET /users/:id`). */
  name: string;
  /** The span kind. Defaults to `"internal"`. */
  kind?: SpanKindName;
  /** Attributes known at creation; sampling-relevant ones belong here. */
  attributes?: Attributes;
  /**
   * Contexts to link to, for a consumer span whose producer ran in another
   * process (possibly days earlier). Preferred over parenting — see
   * §4.4.
   */
  links?: readonly TraceCarrier[];
  /**
   * A remote context to use as the **parent** instead of the ambient one.
   * Set only when the caller has opted into parent-child across a queue
   * (`jobSpanParent: "creation-context"`); otherwise pass it in `links`.
   */
  parent?: TraceCarrier;
  /** Start time in epoch milliseconds. Defaults to now. */
  startTime?: number;
}

/** A started span. Every method must be safe to call after `end()`. */
export interface TelemetrySpan {
  /** Sets one attribute. Ignored once the span has ended. */
  setAttribute: (key: string, value: AttributeValue) => void;
  /** Sets several attributes in one call. */
  setAttributes: (attributes: Attributes) => void;
  /**
   * Records an error on the span and sets its status to error, with
   * `error.type` taken from the error's `name` (or `constructor.name`).
   */
  recordError: (error: unknown) => void;
  /**
   * Marks the span failed without an exception — used where the semconv
   * asks for `error.type` from a status code rather than a throw.
   */
  setError: (type: string, message?: string) => void;
  /** Adds a timestamped event. */
  addEvent: (name: string, attributes?: Attributes, time?: number) => void;
  /** Ends the span. Idempotent. `endTime` is epoch milliseconds. */
  end: (endTime?: number) => void;
  /**
   * The span's own context, for injecting into an outgoing message or
   * response. `undefined` when the span is not recording, so a caller
   * never writes a meaningless carrier into a job payload.
   */
  carrier: () => TraceCarrier | undefined;
}

/**
 * What an instrumented site is handed. A package holds one of these or
 * `undefined`; `undefined` is the default and costs one branch.
 */
export interface TelemetryHooks {
  /**
   * Starts a span **without** making it active. Cheapest form; use it when
   * nothing downstream needs `context.active()`.
   */
  startSpan: (spec: SpanSpec) => TelemetrySpan;
  /**
   * Starts a span, makes it the active context for `fn`, and returns what
   * `fn` returns. The span is **not** ended for you — the caller ends it,
   * because our pipelines outlive the synchronous call (a streamed response,
   * a job settled off the critical path).
   */
  withSpan: <T>(span: TelemetrySpan, fn: () => T) => T;
  /**
   * Both at once: start, activate, run. Equivalent to
   * `withSpan(startSpan(spec), fn)` and provided because the bridge can do
   * it in one context entry.
   */
  startActive: <T>(spec: SpanSpec, fn: (span: TelemetrySpan) => T) => T;
  /** Extracts a remote context from inbound headers (`traceparent`/`tracestate`). */
  extract: (headers: Headers | Record<string, string | string[] | undefined>) =>
    | TraceCarrier
    | undefined;
  /**
   * The carrier of the **currently active** span, or `undefined`. This is
   * what a producer writes into a job record so a consumer in another
   * process can link back to it.
   */
  active: () => TraceCarrier | undefined;
  /** Adds to a counter. `unit` and description are fixed by the instrument name. */
  count: (name: string, value: number, attributes?: Attributes) => void;
  /** Records a value into a histogram. */
  record: (name: string, value: number, attributes?: Attributes) => void;
  /** Adds to (or subtracts from) an up-down counter. */
  adjust: (name: string, delta: number, attributes?: Attributes) => void;
  /**
   * Registers an asynchronous gauge, polled by the SDK's collection cycle.
   * Returns a function that unregisters it — call it on `close()`, or a
   * closed queue keeps being polled.
   */
  observe: (
    name: string,
    callback: (report: (value: number, attributes?: Attributes) => void) =>
      | void
      | Promise<void>,
  ) => () => void;
  /**
   * Whether anything is recording right now. A caller may skip building an
   * expensive attribute set behind it. Cheap: the bridge caches the answer
   * per collection cycle.
   */
  readonly enabled: boolean;
}
```

`TelemetryHooks`, `SpanSpec`, `TelemetrySpan`, `TraceCarrier`, `Attributes`,
`AttributeValue` and `SpanKindName` are re-exported from
`packages/bun-common/lib/index.ts` — they name no peer, so `checkPeerScopes`
is satisfied.

### 2.2 The bridge (`packages/bun-common/lib/telemetry/otel.ts`)

The only file in the repo that writes `from "@opentelemetry/api"`.

```ts
/** What {@link otelTelemetry} accepts. Every field is optional. */
export interface OtelTelemetryOptions {
  /**
   * The tracer provider. Defaults to the globally registered one
   * (`trace.getTracerProvider()`), which is a no-op until the application
   * installs an SDK — so a library user who forgets to start the SDK gets
   * silence, not a crash.
   */
  tracerProvider?: TracerProvider;
  /** The meter provider. Defaults to the globally registered one. */
  meterProvider?: MeterProvider;
  /**
   * The propagator used by {@link TelemetryHooks.extract} and
   * `carrier()`. Defaults to the global propagator, which the SDK sets to
   * `tracecontext,baggage` unless `OTEL_PROPAGATORS` says otherwise.
   */
  propagator?: TextMapPropagator;
  /**
   * Instrumentation scope name recorded on every span. Defaults to
   * `"@kingsleyweb/bun-common"`; pass the package name when bridging for
   * bun-jobs so a backend can filter by subsystem.
   */
  scope?: string;
  /**
   * Version recorded with the scope. Defaults to this package's version.
   */
  scopeVersion?: string;
  /**
   * Cap on the `tracestate` written into a job record or the runner
   * protocol, in bytes. A W3C `tracestate` may be 512 bytes; carried on
   * every job that is 512 bytes of storage per job for a value most
   * deployments do not read. Defaults to `256`; `0` drops `tracestate`
   * entirely. `traceparent` (55 bytes) is never dropped.
   */
  maxTraceStateBytes?: number;
  /**
   * Whether `enabled` reports `true` when no SDK is registered. Defaults to
   * `false`, so `if (tel.enabled)` guards skip work under a no-op provider.
   */
  alwaysEnabled?: boolean;
}

/**
 * Builds {@link TelemetryHooks} over the OpenTelemetry API.
 *
 * Requires `@opentelemetry/api` (an optional peer of this package). Importing
 * `@kingsleyweb/bun-common/otel` without it installed is a resolution error,
 * which is the intended, loud failure.
 */
export function otelTelemetry(options?: OtelTelemetryOptions): TelemetryHooks;
```

### 2.3 Turning it on — bun-common

```ts
/**
 * Telemetry for this adapter. Absent (the default) means **off**: no span is
 * started, no attribute object is built, and the request path takes one
 * branch. Pass `otelTelemetry()` from `@kingsleyweb/bun-common/otel`, or any
 * {@link TelemetryHooks}.
 */
telemetry?: TelemetryHooks | HttpTelemetryOptions;
```

```ts
/** Per-adapter tuning for HTTP telemetry. */
export interface HttpTelemetryOptions {
  /** Where spans and measurements go. Required. */
  hooks: TelemetryHooks;
  /**
   * Emit a `SERVER` span per request. `true` by default whenever `hooks`
   * is given.
   */
  spans?: boolean;
  /**
   * Record `http.server.request.duration` and, when `activeRequests` is on,
   * `http.server.active_requests`. `true` by default.
   */
  metrics?: boolean;
  /**
   * Record `http.server.active_requests`. `false` by default — it is
   * Development in semconv v1.44.0 and costs an up-down counter add on both
   * edges of every request.
   */
  activeRequests?: boolean;
  /**
   * Emit one `INTERNAL` span per pipeline layer (`BunRouter.handle`'s loop).
   * `false` by default. It multiplies span volume by the middleware depth
   * and is the single most expensive option here — see §7.
   */
  layerSpans?: boolean;
  /**
   * Inject `traceparent` into every outgoing response, so a browser or a
   * gateway can correlate. `false` by default: it is not what W3C Trace
   * Context is for, it leaks internal ids to clients, and it adds 62 bytes
   * to every response.
   */
  injectResponseHeaders?: boolean;
  /**
   * Request headers copied onto the span as `http.request.header.<key>`
   * (lowercased). Opt-in in semconv; empty by default. Never include
   * `authorization` or `cookie`.
   */
  requestHeaders?: readonly string[];
  /** Response headers copied as `http.response.header.<key>`. Empty by default. */
  responseHeaders?: readonly string[];
  /**
   * Rewrites or suppresses a span. Return `null` to drop the span entirely
   * (a health check, a metrics scrape), or a partial spec to rename it or
   * add attributes. Called **before** the span is created, so a dropped
   * request costs one call and no span.
   */
  filter?: (req: BunRequest) => Partial<SpanSpec> | null;
  /**
   * How `url.query` is handled. `"omit"` (the default) leaves it off;
   * `"redact"` sets it with the semconv's sensitive-parameter list replaced
   * by `REDACTED`; `"raw"` sets it verbatim — only for an internal service.
   */
  query?: "omit" | "redact" | "raw";
  /**
   * Instrument WebSocket lifecycle and messages. `false` by default: a chatty
   * socket produces one span per frame.
   */
  websocket?: boolean | WebSocketTelemetryOptions;
}
```

Both `BunRouter` and `BunHttpAdapter` accept it; the adapter forwards its own
to the router it constructs (`packages/bun-common/lib/BunHttpAdapter.ts:303`,
the `super({...})` call), exactly as `logger` is forwarded today. A
`setTelemetry()` setter mirrors `setLogger()`
(`packages/bun-common/lib/BunRouter.ts:612`).

### 2.4 Turning it on — bun-jobs

Added to `BunJobsOptions` (`packages/bun-jobs/lib/BunJobs.ts:57`), and to
`BunQueueOptions` (`lib/queue/types.ts:819`), `BunQueueWorkerOptions`,
`BunRunnerOptions` and `JobsApiConfig` (`lib/api/config.ts:488`) — merged
under each, the component's own winning, the same layering `metrics` and
`logger` already use.

```ts
/** Per-context tuning for bun-jobs telemetry. */
export interface JobsTelemetryOptions {
  /** Where spans and measurements go. Required. */
  hooks: TelemetryHooks;
  /**
   * The value written to `messaging.system`. Defaults to `"bunjobs"`.
   * semconv permits a custom value when no registry value applies; override
   * it if a deployment standardises on something else.
   */
  system?: string;
  /**
   * Emit producer spans on `add`/`addBulk`/`addFlow`. `true` by default.
   */
  producerSpans?: boolean;
  /**
   * Emit consumer (`process`) spans in the worker. `true` by default.
   */
  consumerSpans?: boolean;
  /**
   * How a `process` span relates to the enqueue that created it.
   *
   * - `"link"` (the default) — the process span starts a **new trace** and
   *   carries a link to the creation context. This is what the messaging
   *   semconv recommends, and the only shape that survives a job delayed for
   *   days, a batch claim, retries across processes and clock skew.
   * - `"creation-context"` — the process span is a child of the enqueue
   *   span. Only for single, promptly-processed jobs; see §9 for what
   *   breaks.
   * - `"none"` — carry no context at all; nothing is written into the job.
   */
  jobSpanParent?: "link" | "creation-context" | "none";
  /**
   * Emit a `CLIENT` span around each driver call (`addJob`, `claimJob`,
   * `completeJob`, …). `false` by default: it doubles span volume and the
   * duration is already on the enclosing span.
   */
  driverSpans?: boolean;
  /**
   * Emit spans for runner runs (`BunRunner.#startRun`). `true` by default —
   * a run is coarse, so the volume is low.
   */
  runnerSpans?: boolean;
  /**
   * Whether the job's `data` size is recorded as
   * `messaging.message.body.size`. `false` by default (Opt-In in semconv,
   * and it costs a serialisation to measure).
   */
  bodySize?: boolean;
  /**
   * Publish the queue's existing counters as OTel instruments. `true` by
   * default. This reads what `drivers/metrics.ts` and
   * `queue/workerMetrics.ts` already collect; it starts no new bookkeeping.
   */
  metrics?: boolean;
  /**
   * How often the observable gauges (queue depth, live workers) are allowed
   * to hit the driver, in milliseconds. Defaults to `10_000`. The SDK's
   * collection interval may be shorter; a cached value is reported in
   * between, because `countJobs` is a real query on SQL and Mongo.
   */
  gaugeMinIntervalMs?: number;
}
```

### 2.5 Turning it on — bun-nest

Three surfaces, in increasing order of convenience:

```ts
// 1. plain: the adapter takes the same option bun-common's does
const adapter = new BunHttpAdapter(0, { telemetry: otelTelemetry() });

// 2. a module, mirroring BunJobsApiModule (lib/jobs/BunJobsApiModule.ts)
@Module({ imports: [BunTelemetryModule.forRoot({ hooks: otelTelemetry() })] })

// 3. async, with DI
BunTelemetryModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => ({ hooks: otelTelemetry({ scope: cfg.get("SERVICE") }) }),
});
```

```ts
/** What {@link BunTelemetryModule.forRoot} accepts. */
export interface BunTelemetryModuleOptions extends HttpTelemetryOptions {
  /**
   * Also apply these hooks to every `BunJobs` context resolvable from the
   * container. `false` by default — a job context usually configures its own,
   * and silently attaching to one the application built elsewhere is
   * surprising.
   */
  attachJobs?: boolean;
  /**
   * Emit an `INTERNAL` span named `<Controller>.<handler>` around each
   * controller method. **`false` by default**, because
   * `@opentelemetry/instrumentation-nestjs-core` already emits exactly that
   * span and a consumer running both would see it twice. See §9.6.
   */
  handlerSpans?: boolean;
}
```

The module follows `BunJobsApiModule`'s lifecycle discipline
(`packages/bun-nest/lib/jobs/BunJobsApiModule.ts:113-200`): it resolves the
adapter through `HttpAdapterHost` by token, checks it with the same
`instanceof`-then-capability-probe pattern (`looksLikeBunAdapter`, line 73),
and installs the hooks in `onModuleInit` — before Nest registers its
not-found and error handling, and before the first request.

### 2.6 Log correlation

`LogEvent` (`packages/bun-common/lib/logging.ts:60`) gains two optional
fields, populated by the sink wrapper rather than by every call site:

```ts
/** The active trace's id, when telemetry is on and a span is recording. */
traceId?: string;
/** The active span's id, when telemetry is on and a span is recording. */
spanId?: string;
```

and a new sink combinator in the bridge:

```ts
/**
 * Wraps a sink so every record it receives carries the active `traceId` and
 * `spanId`. Costs one `trace.getSpan(context.active())` per record
 * (16.7 ns measured) and nothing when no span is active.
 */
export function correlatingSink(sink: LogSink): LogSink;
```

This stays in `otel.ts` — it needs `context`/`trace` — so `logging.ts` keeps
its zero dependencies. Adding the two optional fields to `LogEvent` is
type-only and reaches no peer.

---

## 3. Per-package instrumentation tables

Attribute stability is from semconv v1.44.0: **S** = Stable, **D** =
Development.

### 3.1 bun-common — HTTP server span

| Where | Detail |
|---|---|
| File | `packages/bun-common/lib/BunHttpAdapter.ts` |
| Method | `protected async handleNativeRequest(nativeRequest, server)`, **line 344** |
| Shape | add a guard at the very top: `if (this.#telemetry === undefined) return this.#handleNativeRequestPlain(nativeRequest, server);` — the existing body moves to `#handleNativeRequestPlain` verbatim, and `#handleNativeRequestTraced` wraps it. One branch on the hot path; nothing else changes. |
| Span name | `` `${method} ${route}` `` when `http.route` is known, else the method alone. semconv: *"Instrumentation MUST NOT default to using URI path as a `{target}`."* |
| Kind | `SERVER` |
| Starts | immediately after `BunRequest.init` resolves (line 348-351) — the request must exist to read the method and path, and `init` may await body parsing which belongs inside the span. |
| Ends | in a `finally` around the whole body, after the `Response` is resolved at line 452-456 (`res.settledResponse ?? await res.getNativeResponse(...)`), the 404 at line 460, and the upgrade returns at line 432/451. |
| Parent | `hooks.extract(req.headers)` — `req.headers` is `packages/bun-common/lib/BunRequest.ts:3255`. |

Attributes, and where each is read:

| Attribute | Stab. | Level | Source |
|---|---|---|---|
| `http.request.method` | S | Required | `BunRequest.ts:3217` `get method()`; `_OTHER` for an unknown verb |
| `url.path` | S | Required | `BunRequest.ts:3198` `get path()` |
| `url.scheme` | S | Required | `BunRequest.ts:3227` `get protocol()` |
| `http.route` | S | Cond. Req. | set **late** — see below |
| `http.response.status_code` | S | Cond. Req. | `BunResponse.ts:829` `get statusCode()`, read at end |
| `error.type` | S | Cond. Req. | the thrown error's `name`, or the status code as a string for a 5xx with no throw |
| `http.request.method_original` | S | Cond. Req. | the raw verb when it was mapped to `_OTHER` |
| `url.query` | S | Cond. Req. | `BunRequest.ts:3208` `get querystring()`, only when `query !== "omit"` |
| `server.address` / `server.port` | S | Rec. | `BunRequest.ts:3221` `get host()` / `3239 get hostname()` |
| `client.address` | S | Rec. | `BunRequest.ts:3322` `get ip()` — `null` under `fetch()` with no socket, so the attribute is omitted, not set to `"null"` |
| `network.protocol.version` | S | Rec. | `"1.1"` unless Bun reports otherwise; **assumed**, verify against `server.requestIP`/protocol at implementation time |
| `user_agent.original` | S | Rec. | header |
| `http.request.header.<k>` / `http.response.header.<k>` | S | Opt-In | `requestHeaders`/`responseHeaders` option |

**`http.route` is the hard part.** The route is not known when the span
starts: it is decided inside `BunRouter.handle`
(`packages/bun-common/lib/BunRouter.ts:4582`), where `matchedRoute` is
assigned at line 4646 from `layer.matched`. semconv permits this explicitly —
*"if it becomes available later, instrumentation MUST populate it before the
span ends"*. Implementation: `handle()` already returns
`matchedRoute | true | undefined`; the adapter reads `routeUsed` at line 396
and, when it is a `matchedRoute`, sets `http.route` and renames the span
before ending it. For a mounted sub-router the pattern must be
`layer.baseUrl + matched.path` — `baseUrl` is on `MatchedLayer`
(`BunRouter.ts:163`) and is the mount prefix. **Verify this against
`__tests__/mountTyping` and `express-use.test.ts` fixtures in phase 1; I have
read the fields but not confirmed the concatenation for every mount shape.**

Span status, per semconv (Stable):

| Outcome | Status | `error.type` |
|---|---|---|
| 1xx/2xx/3xx | unset | — |
| **4xx on a SERVER span** | **unset** | unset |
| 5xx | `Error` | the status code as a string |
| throw reaching `handleRequestError` (line 541) | `Error` | the error's `name` |
| client aborted (`req.signal`) | unset | unset — semconv: intentional cancellation is not an error |

Error handling: `handleNativeRequest` re-throws with the request attached
(line 391-395); `handleRequestError` (**line 541**) runs the registered error
handlers and `finalErrorResponse` (**line 618**, and the free function at
**line 154**) produces the response. The span must be ended by the `finally`
in `#handleNativeRequestTraced`, *after* `handleRequestError` has produced its
response — otherwise the status code is missing on exactly the spans that
matter. `finalErrorResponse` already computes the status via `errorStatusCode`
(**line 84**); reuse it rather than re-deriving.

### 3.2 bun-common — pipeline layer spans (`layerSpans`, default off)

| Where | Detail |
|---|---|
| File | `packages/bun-common/lib/BunRouter.ts` |
| Method | `override async handle(...)`, **line 4582** — the `for` loop at **line 4611** |
| Start/end | around the invocation at **lines 4662-4676** (`layer.callback(...)` and the conditional `await`) |
| Name | `middleware` / `handler` / `error handler` + the layer's registered path — from `layer.isErrorHandler`, `layer.isRouteHandler` and `layer.matched.path`, all already read by the debug log at **line 4694** |
| Kind | `INTERNAL` |
| Attributes | `bunrouter.layer.kind`, `bunrouter.layer.index` (`layer.routeIndex`), `bunrouter.router.id` (`layer.routerId`), `http.route` |
| Error | `didThrow` at **line 4677** already captures it; record on the layer span, then let case 1 (**line 4700**) proceed unchanged |

This shares the debug-log site, which is a useful signal: the loop already
tolerates a per-layer side effect behind `this.localOptions?.debug`
(**line 4693**). `layerSpans` takes the same position in the loop and the same
branch discipline.

### 3.3 bun-common — WebSocket

| Where | Method / line | Span | Kind | Notes |
|---|---|---|---|---|
| `lib/BunWebSocket.ts` | `_wsHandler.open`, **line 484** | `websocket open <route>` | `SERVER` | parent extracted from the **upgrade** request's headers, which `ws.data` carries (`WebSocketClientData.headers`, `lib/BunWebSocket.ts:82`). This is the only place the trace can enter a socket. |
| | `_wsHandler.message`, **line 489** | `websocket message <route>` | `CONSUMER` | linked to the open span's carrier, stored on `ws.data` at upgrade. One span per frame — why `websocket` defaults to off. |
| | `_wsHandler.close`, **line 493** | `websocket close <route>` | `SERVER` | ends the connection span; attributes `ws.close.code`, `ws.close.reason` |
| | `processRegisteredRouteHandlerFor`, **line 891** | — | — | the `Promise.allSettled` at **line 916** swallows handler rejections; a span must record from inside each handler's own promise, not from the settled array, or every error is lost |

Route: `ws.data?.route ?? ws.data?.path` (**line 902**) — the registered
pattern, already low-cardinality. Use it, never the concrete path.

The connection's carrier is stored on `ws.data` so `message` and `close` can
link to `open`. `WebSocketClientData` is built at upgrade
(`lib/utils/wsUpgrade.ts`), which is the place to add an optional
`trace?: TraceCarrier` field.

### 3.4 bun-common — static, compression, multipart

| File | Hook | Span | Default |
|---|---|---|---|
| `lib/serveStatic.ts:348` `createServeStaticHandler` | around the handler it returns | `INTERNAL` `static <route>`, attrs `file.path` (relative, never absolute), `http.response.body.size` | off |
| `lib/compression.ts:1401` `compression()` | around the encode | `INTERNAL` `compress`, attrs `http.response.header.content_encoding`, input/output size | off — it is on the response path of every request |
| `lib/BunRequest.ts:1817` `getMultiParts` | around the parse | `INTERNAL` `multipart parse`, attrs part count, total bytes, `error.type` on a `MultipartError` (`lib/multipart/errors.ts`) | **on** when spans are on — a slow upload is exactly what a trace is for, and it is one span per multipart request, not per request |

All three sit under the request span automatically through
`context.active()`, provided the server span was made active with
`withSpan` — which is why the server span uses `startActive` and not the
cheaper `startSpan`.

### 3.5 bun-nest

| File | Method / line | What |
|---|---|---|
| `lib/BunHttpAdapter.ts` | `handleNativeRequest`, **line 322** | the same guard-and-delegate split as bun-common's. Note the streaming race at **lines 366-390**: when `Bun.peek.status(pipeline) === "pending"` and a long-lived response is returned early (line 388), **the span must not end there** — the pipeline is still running. End it on the `pipeline.catch`/completion at line 379-386, not on the `return streamed`. This is the one place where the two adapters genuinely differ and a naive copy would report every SSE stream as 0 ms. |
| `lib/BunHttpAdapter.ts` | `registerVerb`, **line 1432** | Nest knows the route template here (`path`) before any request. Stash it on the layer so `http.route` is available even for a controller mounted with a global prefix and a version — richer than what `matchedRoute.path` alone gives. |
| `lib/BunHttpAdapter.ts` | `handleRequestError`, **line 943**; `setErrorHandler`, **line 1149** | record the error and the final status on the server span, as in §3.1 |
| `lib/BunWebSocketAdapter.ts` | `invokeHandler`, **line 871** | `CONSUMER` span `<namespace> <event>` around the handler call. The three result shapes (observable at 895, promise at 901, plain at 913) each need the span ended on their own completion; `onError` (line 883) records. |
| | `bindClientConnect`, **line 681** / `bindClientDisconnect`, **line 741** | connection span start/end |
| | `dispatchToHandlers`, **line 925** | nothing of its own — it fans out to `invokeHandler` |
| `lib/interceptors.ts` | `intercept`, **lines 192, 229, 263, 298, 331** | `INTERNAL` `file upload` around each `handleMultipart*` call; `transformUploadException` (**line 120**) is where `error.type` comes from |

**Nest-specific route enrichment.** Nest registers routes through
`registerVerb` (line 1432) with the fully-resolved path including the global
prefix and version. Capturing it there and keying it by the `BunRouter` route
gives `http.route` values like `/api/v2/users/:id` where the router alone
would report `/users/:id`. semconv: *"SHOULD include the application root if
there is one."*

### 3.6 bun-jobs — producer

| Where | Detail |
|---|---|
| File | `packages/bun-jobs/lib/queue/BunQueue.ts` |
| Method | `#addSimple`, **line 614** (and `#addBulk`, **line 673**; `#addRepeatable`, **line 2620**; `#addFlowNode`, **line 1229**) |
| Span | `` `enqueue ${this.name}` `` — `{messaging.operation.name} {destination}` |
| Kind | `PRODUCER` |
| Starts | at the top of `#addSimple`, before `#buildRecord` (line 626) — the record must be built *inside* the span so its carrier is the span's own |
| Ends | after `driver.addJob` returns (line 630) and the emits at 636-650, in a `finally` |
| Carrier write | inside `#buildRecord` (**line 2557**), as a new `trace` field on the returned record — see §4.3 |

| Attribute | Stab. | Value |
|---|---|---|
| `messaging.operation.name` | D | `"enqueue"` (a semconv-listed example for `messaging.client.sent.messages`) |
| `messaging.operation.type` | D | `"send"` |
| `messaging.system` | D | `"bunjobs"` (configurable) |
| `messaging.destination.name` | D | `this.name` |
| `messaging.message.id` | D | `record.id` |
| `messaging.batch.message_count` | D | `#addBulk` only — semconv: *"SHOULD NOT set on spans that operate with a single message"* |
| `messaging.message.body.size` | D | Opt-In, `bodySize` option |
| `error.type` | S | on a throw |
| `bunjobs.job.name` | — | `record.name` (ours; see §9.9 on the namespace) |
| `bunjobs.job.delay_ms` | — | `record.runAt - record.createdAt`, only when > 0 |
| `bunjobs.repeat.key` | — | `record.repeatKey`, when set |

Kind is `PRODUCER` because the enqueue span's own context **is** the creation
context — semconv's `span.messaging.send.producer` case, which is the
recommended shape for a single-message API. `addBulk` uses the batch shape:
one `send` span with `messaging.batch.message_count`, and (per semconv,
RECOMMENDED) one `create` span per message that the send links to. Make the
per-message `create` spans opt-in: `addBulk` of 5,000 jobs would otherwise be
5,001 spans, and `enqueue-bulk/memory` runs at 163,136 jobs/s.

**Windowed adds are a trap.** `#addWindowed` (debounce/throttle) may return a
job that was *not* added. `#addSimple` already distinguishes this at
**line 633** (`if (!added)`), emitting `duplicate`. The span must set
`bunjobs.job.added = false` and **must not** write a carrier into a record
nobody stored.

### 3.7 bun-jobs — consumer

| Where | Detail |
|---|---|
| File | `packages/bun-jobs/lib/queue/BunQueueWorker.ts` |
| Claim | `#claimUpToConcurrency`, **line 1791** — `CLIENT` span `receive <queue>` around `claimJobBatch` (line 1827), `messaging.operation.type = "receive"`, `messaging.batch.message_count = records.length`. Off by default: the loop claims continuously and an empty claim is the common case. |
| Process | `#process(record)`, **line 1941** |
| Span | `` `process ${this.queueName}` `` |
| Kind | `CONSUMER` |
| Starts | at the very top of `#process`, before the `Job` is constructed (line 1950) — the `onProgress`/`onFail` closures should run inside the span's context |
| Made active | around the processor invocation at **lines 2000-2019**, so anything the processor traces nests under it |
| Ends | in the existing `finally` at **line 2049** — which already clears the heartbeat and the reservation, so it is the one place every exit path passes |
| Parent/link | from `record.trace`; `"link"` by default (§4.4) |

| Attribute | Stab. | Value |
|---|---|---|
| `messaging.operation.name` | D | `"process"` |
| `messaging.operation.type` | D | `"process"` |
| `messaging.system` | D | `"bunjobs"` |
| `messaging.destination.name` | D | `this.queueName` |
| `messaging.message.id` | D | `record.id` |
| `messaging.consumer.group.name` | D | the worker's **stable key**, not `this.id`. See §9.5. In v1.44.0 this is a metrics attribute; on the span it is our own refinement, which v1.44.0 explicitly invites. |
| `messaging.client.id` | D | `this.id` (the incarnation) — high cardinality, span-only, never on a metric |
| `error.type` | S | from `#recordFailure` |
| `bunjobs.job.name` | — | `record.name` |
| `bunjobs.job.attempt` | — | `record.attemptsMade` |
| `bunjobs.job.max_attempts` | — | `record.maxAttempts` |
| `bunjobs.job.queue_wait_ms` | — | `Date.now() - record.runAt` at span start — the claim latency, computed from fields already on the record |
| `bunjobs.job.stalled_count` | — | `record.stalledCount`, when > 0 |

Outcomes:

| Path | Line | Span effect |
|---|---|---|
| success → `#settle` | **2120** | status unset. **Note `#settle` is deliberately not awaited** (comment at line 2032-2043): the span must end when the processor returns, not when the write lands, or every job span carries a database round trip it did not spend. Add an event `settled` from the `settle` callback at line 2150 instead. |
| `job.fail()` | `failedWith` at **1965**, handled at **2023** | `error.type` from the `UnrecoverableJobError` |
| throw / reject | **2046** → `#recordFailure`, **line 2756** | `recordError`; add `bunjobs.job.will_retry` from the `delay !== false` branch at **line 2797** |
| `LockLostError` | **line 2761** | status unset, event `lock-lost` — the job is not ours and someone else will record its outcome |
| timeout | `withTimeout` at **line 2015** | `error.type = "JobTimeoutError"` (the name `#recordFailure` assigns at line 2771) |
| dead-letter | `#fileDeadLetter`, **line 2929** | event `dead-lettered` with `messaging.destination.name` of the DLQ |
| repeat scheduling | `#scheduleNextRepeat`, **line 3011** | `PRODUCER` span `schedule <queue>` — it genuinely enqueues the next occurrence, and doing it *before* the job runs (line 1878) is load-bearing |

### 3.8 bun-jobs — driver spans (`driverSpans`, default off)

Do **not** edit the five drivers. Wrap instead: `createDriver`
(`lib/drivers/create-driver.ts:22`) and `resolveDriver` (same file, **line 85**)
are the two chokepoints where every driver instance is produced. A
`tracedDriver(driver, hooks, config)` proxy wraps the ~60 methods of
`QueueDriver`/`RunnerDriver` (`lib/drivers/driver.ts:1710` onward) with a
`CLIENT` span each.

| Attribute | Value |
|---|---|
| `db.system.name` | `"redis"` / `"postgresql"` / `"mysql"` / `"mariadb"` / `"sqlite"` / `"mongodb"`; for `file` and `memory` omit it and set `bunjobs.driver` |
| `bunjobs.driver.operation` | the method name (`addJob`, `claimJob`, …) |
| `messaging.destination.name` | `q.queue` from the `QueueRef` first argument |
| `error.type` | on a throw |

Span name: `` `${driver} ${method}` ``. The proxy must preserve optional
methods as *absent* — `typeof driver.claimJobs === "function"` is a live
capability check in `claimBatch.ts` and a proxy that materialises every key
would change behaviour. Build the wrapper from `Object.keys` of the instance
plus its prototype chain, not from a static list.

### 3.9 bun-jobs — runner spans

| Where | Detail |
|---|---|
| File | `packages/bun-jobs/lib/runner/BunRunner.ts` |
| Method | `#startRun`, **line 1551** |
| Span | `` `run ${this.name}` ``, kind `INTERNAL` (it is not messaging — nothing is enqueued) |
| Starts | after `runId` is minted (line 1552), before `appendHistory` (line 1566) |
| Ends | in `#finish` (**line 1777**), after `handle.done` resolves (line 1778) and the record is assigned (line 1786) — that is where `status`, `durationMs`, `exitCode` and `error` exist |
| Carrier out | into `#buildContext` (**line 1740**), as a new `trace` field on the `RunContext` → `SerializableContext` — §4.5 |

| Attribute | Value |
|---|---|
| `bunjobs.runner.id` | `this.id` |
| `bunjobs.runner.name` | `this.name` |
| `bunjobs.run.id` | `runId` |
| `bunjobs.run.mode` | `this.#executionMode` — `"in-process"` / `"spawn"` / `"worker"` |
| `bunjobs.run.source` | `source` (`RunSource`) |
| `bunjobs.run.status` | from `outcome.status` at end |
| `bunjobs.run.exit_code` / `bunjobs.run.signal` | when present |
| `error.type` | from `outcome.error` (a `SerializedError`, so `.name`) |

### 3.10 bun-jobs — management API and notifier

The API is a `BunRouter` (`lib/api/createJobsApi.ts`), so it is already
covered by bun-common's server spans once the host adapter is instrumented.
Two additions worth having:

| Where | Span |
|---|---|
| `lib/api/ws/session.ts` | `CONSUMER` span per inbound socket command, named by the command; the session is long-lived so the connection span would be useless |
| `lib/notifier.ts:460` `#deliver(event)` | `CONSUMER` span `notify <target>` linked to the publisher's carrier, when `publishEvents` is on. The event envelope (`queueEvent` in `lib/drivers/driver.ts`) would need a `trace` field — **defer to phase 5**; it is a second wire-format change and the value is lower than the queue's. |

---

## 4. Context propagation

### 4.1 Inbound HTTP

`hooks.extract(req.headers)` in `handleNativeRequest`. `BunRequest.headers`
(`lib/BunRequest.ts:3255`) returns `Record<string, string | string[]>`; the
bridge's getter must take the first element of an array, since a duplicated
`traceparent` is a malformed request and W3C says to treat it as absent.

The extracted context becomes the server span's parent. Standard
`ParentBased` sampling then applies: a sampled inbound `traceparent` forces
our span to be sampled. That is correct for HTTP and wrong for delayed jobs —
see §4.4.

### 4.2 Outbound

- **Response headers**: `injectResponseHeaders`, default **off**. When on,
  set `traceparent` via `res.setHeader` (`lib/BunResponse.ts:1642`) before
  `getNativeResponse` — after `headersSent` (line 1638) it is too late, and
  for a streamed response it is *always* too late, so the option is a no-op
  on `isLongLived` responses and should log once at `debug` when it skips.
- **Outgoing `fetch`**: **we do not instrument `fetch`.** Bun's native `fetch`
  is not undici-backed and emits no `diagnostics_channel` events, so
  `@opentelemetry/instrumentation-undici` produces nothing under Bun — a
  verified, external finding. Wrapping `globalThis.fetch` is what Sentry and
  `@photon-ai/otel` do, and it is a *global* side effect that a library must
  not perform. Document it: outgoing HTTP is the application's job, and the
  application's wrapper will pick up our active context for free.

### 4.3 HTTP → job enqueue (same process)

Free. `hooks.active()` inside `#addSimple` returns the server span's carrier
because the server span was made active with `withSpan`. Measured: ALS
survives `await`, timers, `fetch` and four concurrent `Bun.serve` requests
without leaking between them.

### 4.4 Enqueue → process, across processes and days — **the hard part**

**Wire format.** A new optional field on `JobRecord`
(`packages/bun-jobs/lib/drivers/driver.ts:1031`):

```ts
/**
 * The W3C trace context of the `add()` that created the job, when telemetry
 * was on and a span was recording.
 *
 * Written once, by the producer, and never rewritten — a retry keeps the
 * original creation context, which is what makes every attempt of a job link
 * back to the same enqueue. Absent for a job added by a producer with
 * telemetry off, by an older version, or with `jobSpanParent: "none"`.
 *
 * A driver stores it with the record and never interprets it.
 */
trace?: TraceCarrier | null;
```

**Backward compatibility, per backend:**

| Backend | Change | Compatible with jobs already queued? |
|---|---|---|
| memory | none — the record is the object | yes |
| file | none — the record is JSON | yes |
| Redis | one more hash field | yes |
| MongoDB | schemaless | yes |
| **SQL** | **a new `trace` column** | yes, with the `processedBy` treatment |

SQL is the only real work, and there is an exact precedent to copy:
`processed_by_id`/`_key`/`_host`/`_pid`
(`packages/bun-jobs/lib/drivers/sql/schema.ts:50-53`), whose own comment says
it is *"named by an insert only for a record carrying a stamp, and by a claim
only while the table has them, so a table created before they existed keeps
accepting jobs and claims until a sync adds them."* Add `trace` to
`JOB_COLUMNS` (line 40 region) and to `jobColumnTypes` as `jsonType`, with the
same conditional naming, and one `add-column` entry in `schemaSync.ts`. Per
`CLAUDE.md`'s schema-sync rules, adding a column is non-blocking on Postgres,
MySQL/MariaDB and SQLite, so the default `syncSchema()` applies it.

A job enqueued before the column exists reads back `trace: undefined`, which
is the "no creation context" case the worker already has to handle. A job
enqueued *with* a trace and claimed by a worker running an older build is
ignored harmlessly. **Both directions are safe; nothing needs draining.**

The alternative — stashing the carrier in `opts` (`StoredJobOptions`,
`driver.ts:942`), which is already a JSON blob with a non-option field
(`explicit`) — needs no schema change at all. Rejected because
`rewritePendingOptions` (`driver.ts:1982`) walks and rewrites `opts` in bulk,
and dragging 55-311 bytes of trace context through every option rewrite of
every pending job is a real cost for a field that is not an option. Worth
reconsidering only if the SQL column proves harder than it looks.

**Size.** `traceparent` is fixed at 55 bytes. `tracestate` may be 512.
`maxTraceStateBytes` defaults to 256 and truncates at a comma boundary (W3C
allows dropping entries; it does not allow a malformed value).

**Link, not parent — by default.** semconv v1.44.0 is unambiguous that links
are the default mechanism, and gives three reasons, all of which apply here:
it is the only structure guaranteed across messaging models, the only option
for batches (a span has one parent, and `claimJobs` claims many), and the only
option when consumption happens inside another ambient context. Three more
reasons specific to bun-jobs:

1. **Delay.** A job may be `delayed` for days (`runAt`). Parenting would keep
   a trace nominally open across that gap; Jaeger and Tempo close a trace
   minutes after its last span and would file the consumer span under a trace
   that has already been written out and indexed.
2. **Retries.** `record.maxAttempts` with backoff means one enqueue can have
   N process spans spread over hours. As children they are siblings in one
   enormous trace; as links each attempt is its own trace that points back.
3. **Sampling.** `ParentBased` is age-blind — the OTel SDK spec branches only
   on {no parent, remote sampled, remote not sampled, local sampled, local not
   sampled}. A week-old sampled `traceparent` force-samples the consumer span
   forever. Starting a new trace lets the consumer's own sampler decide.

`jobSpanParent: "creation-context"` is offered because semconv permits it
*"exclusively for single messages scenarios"* and it produces the trace shape
people expect from a demo. Its JSDoc must say what §9 says.

**Which span links to what:**

- The `enqueue` (`send`, PRODUCER) span's context **is** the creation context
  and is written into the record. No separate `create` span for a single add.
- The `process` (CONSUMER) span links to `record.trace`.
- The `receive` (CLIENT) span, when enabled, links to each claimed record's
  `trace` — up to `claimJobs`' batch size.
- `#scheduleNextRepeat` (line 3011) produces a *new* job; its `enqueue` span's
  parent is the current process span, and the new record gets that span's
  carrier. A repeat series therefore forms a chain of linked traces, which is
  correct: occurrence N+1 was caused by occurrence N running.

### 4.5 Runner child process and Worker

`SerializableContext` (`packages/bun-jobs/lib/runner/protocol.ts:39`) is the
one structure both executors serialise, so one field covers spawn and worker:

```ts
/**
 * The run's trace context, for the child to link its own spans to. Absent
 * when the parent had telemetry off. Crosses as JSON like everything else
 * here, so it is a carrier and not a live context — the child cannot join
 * the parent's ALS, only reference it.
 */
trace?: TraceCarrier;
```

`PROTOCOL_VERSION` (line 21) stays `1`: an added optional field is read by
neither an older child nor an older parent, and both already tolerate absence.
The field is set in `#buildContext` (`BunRunner.ts:1740`) and in
`IsolatedProcessor.run`'s `runContext` (`lib/queue/isolation.ts:146-168`).

For an **isolated job** (`isolation.ts:130`) nothing extra is needed: the
executor already sends `job: record` (line 175), and `record.trace` rides
along in it.

The child reads it in `lib/runner/bootstrap/child-runtime.ts`, and — if the
child has its own SDK — starts a root span linked to it. **The child usually
has no SDK**, because it is a bare handler file. Two honest options, both to
be offered:

- **Default:** the child emits nothing. The parent's run span covers the
  child's whole lifetime, which is most of what a run trace is for.
- **Opt-in (`runnerSpans` + the child calling a helper):** the child
  initialises its own SDK and starts a linked root span. A `bun-jobs`-supplied
  `childTelemetry()` helper cannot install an SDK for the user — the exporter
  endpoint is theirs — so this is documentation plus a `ctx.trace` field on
  `RunContext`, not machinery.

**ALS does not cross a `Worker`.** Verified locally (`worker sees store:
undefined`) and documented by Bun (*"AsyncLocalStorage context is not
propagated into MessagePort, BroadcastChannel or Worker events"*). The carrier
in `SerializableContext` is the only mechanism; there is no alternative to
investigate.

### 4.6 WebSocket

W3C Trace Context has no WebSocket binding. Two levels:

- **Connection-level (default):** extract from the upgrade request's headers
  at `open` (§3.3); every message span links to the connection span. Works
  with any client, needs no protocol change.
- **Message-level (opt-in):** for bun-nest's gateway protocol, whose packets
  are already structured objects (`eventPacket`,
  `packages/bun-nest/lib/BunWebSocketAdapter.ts:768`), a `traceparent` key may
  be added to the envelope. This is a **wire-format change visible to
  browsers**, so it is opt-in, versioned, and out of scope before phase 6.

---

## 5. Metrics catalogue

### 5.1 Principle

Expose what is already counted. `packages/bun-jobs/lib/drivers/metrics.ts`
and `lib/queue/workerMetrics.ts` collect a complete set today and write it to
the driver for the management API's analytics screens. An OTel meter must read
those same increments, at the same call sites, and must not start a second
accounting.

The mechanism: `WorkerMetricsRecorder.count()`
(`lib/queue/workerMetrics.ts:63`) and the sites that call it
(`BunQueueWorker.ts:2133` for `completed`, `:2821` and `:2859` for `failed`) also call
`hooks.count(...)`. One extra call, guarded by the same `undefined` check.

### 5.2 HTTP (bun-common)

| Instrument | Type | Unit | Stab. | Attributes | Source |
|---|---|---|---|---|---|
| `http.server.request.duration` | Histogram | **`s`** | S | `http.request.method`, `url.scheme`, `http.route`, `http.response.status_code`, `error.type`, `network.protocol.version` | the server span's own duration, recorded in the same `finally` |
| `http.server.active_requests` | UpDownCounter | `{request}` | D | `http.request.method`, `url.scheme` only | `+1` after `BunRequest.init`, `-1` in the `finally` |
| `http.server.request.body.size` | Histogram | `By` | D | as duration | `Content-Length`, or the parsed body size; off by default |
| `http.server.response.body.size` | Histogram | `By` | D | as duration | off by default |

`http.server.request.duration` **must** be created with the semconv
`ExplicitBucketBoundaries` advisory:
`[0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]`.
Note the unit: **seconds**, not milliseconds. Everything internal in this repo
is in milliseconds, so the bridge divides by 1000 at the boundary — one place,
and a type test should pin it.

`server.address`/`server.port` are Recommended on the *span* and Opt-In on the
*metric*. Follow that split exactly; it is a deliberate cardinality decision
and copying the span's attribute set onto the metric is the classic way to
blow up a time-series database.

### 5.3 Queue and worker (bun-jobs)

Existing → proposed. "Existing source" names what already computes the number.

| Instrument | Type | Unit | Attributes | Existing source |
|---|---|---|---|---|
| `messaging.client.sent.messages` | Counter | `{message}` | `messaging.operation.name`=`enqueue`, `.system`, `.destination.name`, `error.type` | `BunQueue.#addSimple`'s `added` flag (line 630-634); `countAddedJobs` (`driver.ts:2179`) counts the same event for analytics |
| `messaging.client.consumed.messages` | Counter | `{message}` | + `messaging.consumer.group.name` | `WorkerMetricsRecorder.completed` + `.failed` (`workerMetrics.ts:65-67`) |
| `messaging.process.duration` | Histogram | **`s`** | `messaging.operation.name`=`process`, `.system`, `.destination.name`, `.consumer.group.name`, `error.type` | `DurationStats` / `addDuration` (`metrics.ts:378`) — the worker already times each attempt |
| `messaging.client.operation.duration` | Histogram | **`s`** | + `messaging.operation.type` | the producer and claim spans' durations |
| `bunjobs.queue.jobs` | **Observable** UpDownCounter | `{job}` | `messaging.destination.name`, `bunjobs.job.state` (`waiting`/`delayed`/`active`/`completed`/`failed`/`dead`/`waiting-children`) | `driver.countJobs(q)` (`driver.ts:2082`), which the API's `/overview` already calls. **This is the queue-depth gauge semconv does not define.** |
| `bunjobs.job.queue.duration` | Histogram | `s` | `messaging.destination.name`, `bunjobs.job.name` | **new** — `Date.now() - record.runAt` at `#process` entry (line 1941). Nothing stores it today; `roundtrip` in the bench measures the same quantity end-to-end. This is the "claim latency" the queue currently has no number for. |
| `bunjobs.job.attempts` | Histogram | `{attempt}` | `messaging.destination.name`, outcome | `record.attemptsMade` at settle/fail |
| `bunjobs.job.retries` | Counter | `{retry}` | `messaging.destination.name`, `error.type` | the `delay !== false` branch in `#recordFailure` (line 2797) |
| `bunjobs.job.dead_lettered` | Counter | `{job}` | source and destination queue | `#fileDeadLetter` (line 2929) |
| `bunjobs.worker.busyness` | **Observable** Gauge | `1` (ratio 0-1) | `messaging.consumer.group.name` | `BusynessSample` / `addBusynessSample` (`metrics.ts:596`), sampled from the heartbeat (`#heartbeat`, line 2971) |
| `bunjobs.worker.active_jobs` | **Observable** UpDownCounter | `{job}` | `messaging.consumer.group.name` | `this.#active.size` (`BunQueueWorker.ts`) |
| `bunjobs.worker.count` | **Observable** UpDownCounter | `{worker}` | `messaging.destination.name` | `driver.listWorkers(q, now)` (`driver.ts:2137`) — the live inventory, heartbeat-based |
| `bunjobs.runner.runs` | Counter | `{run}` | `bunjobs.runner.name`, `bunjobs.run.status` | `RunnerRunCounters` (`metrics.ts:188`): `started`, `completed`, `failed`, `timedOut`, `killed`, `skipped` — one counter with a status attribute rather than six instruments |
| `bunjobs.runner.duration` | Histogram | `s` | `bunjobs.runner.name`, `bunjobs.run.status` | `record.durationMs` in `#finish` (`BunRunner.ts:1789`) |

**The histogram bucket mismatch is real and must be handled deliberately.**
The repo's internal histogram (`DURATION_HISTOGRAM_BOUNDS`, `durationBin` at
`metrics.ts:316`) is log2 in **milliseconds** up to 2^23 ms (~2.3 h) —
designed for the analytics screens and for mergeable storage. semconv advises
14 explicit boundaries in **seconds** topping out at 10 s. They are answering
different questions. Do not reshape either: the OTel histogram takes the
semconv advisory, and the internal one keeps its bins. The same measurement
feeds both; only the bucketing differs.

**Observable instruments need an unregister.** `hooks.observe` returns a
disposer, and `BunQueue.close()` / `BunQueueWorker.#close()`
(`BunQueueWorker.ts:1420`) must call it. A closed worker whose gauge is still
registered keeps the driver alive and keeps querying a queue nobody consumes —
the exact failure mode `#closeDeadLetters` and `#disarmMaintenance`
(line 1388) exist to prevent for timers.

---

## 6. Packaging

### 6.1 Decision: one new subpath, in bun-common. No new package.

| Option | Verdict |
|---|---|
| **A. `@kingsleyweb/bun-common/otel` subpath** (recommended) | One entry, one `consumer-check.json` entry with `"peers": ["@opentelemetry/api"]`, no new package to version. bun-jobs and bun-nest get the bridge through bun-common, which they already depend on, and declare **no** OTel peer at all. |
| B. A fifth package `@kingsleyweb/bun-otel` | Would need its own `dts/`, `tsconfig.build.json`, `scripts/build-declarations.ts` copy, `consumer-check.json`, packaging test, release lockstep with four other packages — and it would depend on bun-common for `TelemetryHooks` anyway. All of that to avoid one `exports` key. Reconsider only if the bridge grows package-specific code that cannot live in bun-common. |
| C. A subpath in each of the three packages | Three peers to declare, three `checkPeerScopes` scopes to keep honest, three bridges to keep in step. No benefit: nothing in bun-jobs' or bun-nest's bridge would name an OTel type that bun-common's does not. |

### 6.2 bun-common `package.json` — exact shape of the delta

```jsonc
{
  "exports": {
    ".": {
      "@kingsleyweb/source": "./lib/index.ts",
      "types": "./dts/index.d.ts",
      "default": "./lib/index.ts"
    },
    // NEW — the bridge. The only entry that may reach @opentelemetry/api.
    "./otel": {
      "@kingsleyweb/source": "./lib/telemetry/otel.ts",
      "types": "./dts/telemetry/otel.d.ts",
      "default": "./lib/telemetry/otel.ts"
    },
    "./lib": { /* unchanged */ },
    // NEW — the core. A directory with an index.ts needs its own explicit key
    // (a `./lib/*` pattern would map `lib/telemetry` to a nonexistent
    // `lib/telemetry.ts`). Imports no peer, so the root may reach it.
    "./lib/telemetry": {
      "@kingsleyweb/source": "./lib/telemetry/index.ts",
      "types": "./dts/telemetry/index.d.ts",
      "default": "./lib/telemetry/index.ts"
    },
    "./lib/multipart": { /* unchanged */ },
    "./lib/multipart/storage": { /* unchanged */ },
    "./lib/*.ts": { /* unchanged */ },
    "./lib/*.js": { /* unchanged */ },
    "./lib/*": { /* unchanged */ },
    "./package.json": "./package.json"
  },

  "peerDependencies": {
    "@opentelemetry/api": ">=1.9.0 <2",   // NEW
    "@types/bun": ">=1.4.2",
    "typescript": "^5.9.3 || ^6.0.0"
  },
  "peerDependenciesMeta": {
    "@opentelemetry/api": { "optional": true },   // NEW
    "@types/bun": { "optional": true },
    "typescript": { "optional": true }
  },

  "devDependencies": {
    // NEW — for the tests only; the library imports none of the SDK.
    // Same posture as zod/yup/valibot/arktype, which exist so the
    // "any Standard Schema" claim is checked rather than asserted.
    "@opentelemetry/api": "^1.9.1",
    "@opentelemetry/sdk-trace-base": "^2.11.0",
    "@opentelemetry/sdk-metrics": "^2.11.0",
    "@opentelemetry/context-async-hooks": "^2.11.0",
    "@opentelemetry/core": "^2.11.0"
  }
}
```

`dependencies` is unchanged. `@opentelemetry/api` ships its own types, so no
`@types/*` runtime dependency is needed (the `file-type`/`mime`/`parse-domain`
exception in `CLAUDE.md`).

Range `>=1.9.0 <2`, never a pin: a consumer may already have the API from
another library, and the spec's whole promise is that any `1.x` interoperates.

### 6.3 `consumer-check.json` — the new entry

```jsonc
{
  "entries": [
    { "spelling": "@kingsleyweb/bun-common", "values": [ /* … */, "noopTelemetry" ],
      "types": [ /* … */, "TelemetryHooks", "SpanSpec", "TelemetrySpan", "TraceCarrier" ] },
    {
      "spelling": "@kingsleyweb/bun-common/otel",
      "peers": ["@opentelemetry/api"],
      "values": ["otelTelemetry", "correlatingSink"],
      "types": ["OtelTelemetryOptions"],
      "snippet": "const t = m.otelTelemetry();\nexport type _hooks = Expect<IsAny<typeof t.startSpan>>;"
    },
    { "spelling": "@kingsleyweb/bun-common/lib/telemetry",
      "values": ["noopTelemetry"], "types": ["TelemetryHooks"] }
  ]
}
```

What this buys, mechanically:

- `checkImports` (`scripts/build-declarations.ts:360`) sees
  `@opentelemetry/api` in `peerDependenciesMeta` as optional and files it under
  `peerImports` rather than failing.
- `checkPeerScopes` (**line 273**) then walks the declaration import graph from
  every literal `exports` key and every `consumer-check.json` spelling.
  `dts/telemetry/otel.d.ts` is reachable only from `exports["./otel"]` and the
  `"@kingsleyweb/bun-common/otel"` spelling, which declares the peer. The root
  is **not** reachable to it, because `lib/index.ts` re-exports only
  `lib/telemetry/index.ts`. If someone later adds
  `export * from "./telemetry/otel"` to the barrel, the build fails with the
  exact message:
  `dts/telemetry/otel.d.ts: imports "@opentelemetry/api", an optional peer, and is reachable from exports["."], …`
  That guard is the reason to structure it this way rather than by convention.
- The consumer check installs two consumers: entries without `peers` in one
  with no optional peer, entries with `peers` in one that has them. Expected
  result, by analogy with bun-nest's `./jobs` (6/6 without the peer, and the
  `./jobs` cells `TS2307` ×2 without it): the root entry must be fully green
  with `@opentelemetry/api` absent, and `./otel` green only with it present.
- Cell count: bun-common is 92/92 today. Two new spellings × (bundler /
  bun-init / node16) × (skipLibCheck on/off) = **12 new cells, 104 total**, of
  which the `./otel` six run only in the peer-bearing consumer.

`./lib/telemetry/otel.ts` remains reachable through the `./lib/*.ts` pattern
key. Pattern keys are not roots in `checkPeerScopes`
(`if (!key.includes("*"))`, line 295), so it does not fail the build; a
consumer deep-importing it without the peer gets `TS2307`, which is the same
deal `mongodb` has today and is correct.

### 6.4 Optional peer — import discipline

`CLAUDE.md`'s rule is about declarations. There is a second, runtime rule the
repo learned from MongoDB (`lib/drivers/mongo/mongo-driver.ts:476-485,
5500-5520`): a package shipping raw `.ts` makes the *consumer* compile our
source, so a static `import type { … } from "mongodb"` anywhere reachable from
the barrel is `TS2307` for everyone without it.

`@opentelemetry/api` is in a different position from `mongodb` and the
difference matters: `otel.ts` is **not reachable from the barrel**, so a static
`import { context, trace, propagation, SpanKind, SpanStatusCode } from
"@opentelemetry/api"` at the top of `otel.ts` is correct and should be used.
It is not the mongo case, and the `const specifier: string = "mongodb"`
dynamic-import dance is unnecessary here — it would also make the bridge async
for no reason. The check that proves it: `bun scripts/typecheck.ts` must pass
with `@opentelemetry/api` uninstalled, which it will, because
`customConditions: ["@kingsleyweb/source"]` resolves `./otel` to `lib/` only
when something imports it, and nothing in the workspace does except the tests
(which have it as a devDependency).

### 6.5 bun-jobs and bun-nest

No `exports` change. No peer change. `BunJobsOptions.telemetry?: TelemetryHooks`
names a bun-common type, and bun-common is a real `dependency` of both — so
`checkImports`' `guaranteed` set (line 366) covers it and nothing new is
reachable.

---

## 7. Performance

### 7.1 The cost when telemetry is off

The target is "indistinguishable from today". The measured floor for a
predictable `undefined` check on an instance field is ~1 ns; the no-op tracer
is ~15 ns marginal and `startActiveSpan` ~175 ns, so a null-object design is
not acceptable. The rules:

1. **`#telemetry` is `TelemetryHooks | undefined`, never a null object.** The
   check is `if (this.#telemetry === undefined)`, monomorphic, and JIT-hoisted
   out of the layer loop in `BunRouter.handle`.
2. **The traced path lives in a separate method.** `handleNativeRequest`
   becomes a two-line dispatcher; the existing body becomes
   `#handleNativeRequestPlain`. The plain path keeps its current inline shape
   and its current inlining behaviour, instead of growing branches inside a
   1,400-line method.
3. **No attribute object is built before the branch.** Every
   `{ "http.request.method": …, … }` literal lives inside the traced method.
4. **No `try/finally` is added to the plain path.** The existing
   `try/catch` at `BunHttpAdapter.ts:373` stays as it is.
5. **`BunRouter.handle`'s layer loop takes one hoisted local**
   (`const layerSpans = this.#telemetry !== undefined && this.#layerSpans;`)
   read before the loop, not a field access per layer.

Expected cost with telemetry off: **one branch per request, one per job, one
per run, one hoisted branch per pipeline loop.** Below the noise floor of every
benchmark in the repo. Phase 1's acceptance criterion is that
`benchmarks/bench.ts --route all` and `bun queue.ts --compare` are unchanged.

### 7.2 The cost when telemetry is on

| Path | Added spans | Measured span cost | Path cost today | Overhead |
|---|---|---|---|---|
| HTTP request, spans only | 1 SERVER | ~1.2 µs + ~64 ns for `context.with` | — (no guarded baseline) | see below |
| HTTP request, `layerSpans` | 1 + N layers | ~1.2 µs × (1+N) | — | **the expensive option**; a 6-middleware chain is 8.4 µs |
| Job, memory backend | 2 (producer + consumer) | ~2.4 µs | 7.8 µs/job (`throughput/memory` 127,762/s) | **~31 %** |
| Job, Redis | 2 | ~2.4 µs | 33 µs/job (`throughput/redis` 29,900/s) | ~7 % |
| Job, Postgres | 2 | ~2.4 µs | 117 µs/job (`throughput/postgres` 8,557/s) | ~2 % |
| Job, `driverSpans` on | +2 to +4 CLIENT | +2.4 to 4.8 µs | | doubles the above; correctly off by default |
| Runner run | 1 | ~1.2 µs | milliseconds | negligible |

A span sampled *out* still costs ~527 ns (measured), because the SDK allocates
a `NonRecordingSpan` and evaluates the sampler. Head sampling reduces export
volume, not our cost. Tell users this: the lever that actually removes our cost
is `spans: false`, not a sampler.

### 7.3 The benchmark guard

`CLAUDE.md` calibrates the queue guard's tolerance at a blunt 35 %, against a
measured 28 % spread on the Redis contention scenario. A 31 % telemetry-on
regression on `throughput/memory` would slip under that. Therefore:

- **Telemetry must never be enabled in `packages/bun-jobs/bench/`.** Add an
  assertion to the harness that `jobs.telemetry === undefined`, so an
  accidental global SDK or a stray option cannot quietly halve a headline
  number and still pass.
- **Which scenarios need re-baselining after phase 1 (telemetry off):**
  none, if §7.1 holds. Run `bun queue.ts --compare` and `bun runner.ts
  --compare` as the gate; if anything moves, the branch placement is wrong,
  not the baseline.
- **A separate, non-gating baseline for telemetry-on.** Add
  `bun queue.ts --telemetry --save-baseline`, writing
  `baselines/queue.telemetry.json`. It records the cost rather than defending
  it, and is the only place the overtaken check would be meaningless anyway
  (BullMQ and pg-boss are not instrumented in the comparators).
- **The overtaken check is unaffected**, since telemetry stays off in the
  compared runs. That matters: it is the sharper of the two checks and the one
  the claim rests on. Margins today, for reference:
  `throughput/redis` 29,900 vs bee-queue 21,065 (+42 %);
  `throughput/postgres` 8,557 vs pg-boss 5,552 (+54 %);
  `contention/mongodb` 3,318 vs agenda 1,205 (+175 %). Telemetry-on at 7 % on
  Redis would not overturn any of them, but that is not a reason to measure it
  in the same table.
- `benchmarks/` (the router comparison) has **no baseline guard** — nothing
  gates it. Record a before/after by hand for `--route static,middleware` in
  phase 1's PR description and keep it in the plan's follow-up, since that is
  the only evidence the HTTP branch is free.

---

## 8. Testing strategy

### 8.1 Asserting spans without a collector

`InMemorySpanExporter` + `SimpleSpanProcessor` from
`@opentelemetry/sdk-trace-base`, and `InMemoryMetricExporter` +
`PeriodicExportingMetricReader` from `@opentelemetry/sdk-metrics`, both
devDependencies of bun-common only. Verified working under Bun 1.4.3-canary.1
while writing this plan.

### 8.2 The global-leak problem — this is the DOM lesson again

`@opentelemetry/api` registers on
`globalThis[Symbol.for("opentelemetry.js.api.1")]`. `bun test` shares globals
and modules across files, so a test file that registers a provider and does not
tear it down leaves every later file — including files asserting that
telemetry is *off* — running against a live SDK. That is the same class of
failure as `register-dom` leaking `fetch`/`Response` into server tests, and it
deserves the same treatment:

```ts
// packages/bun-common/__tests__/otel.ts
/**
 * Registers an in-memory OTel SDK for this file and unregisters it after,
 * so no other test file sees a provider. Call it at the top level of every
 * telemetry test file and take `spans`/`metrics`/`hooks` from the result.
 */
export function setupOtel(options?: { contextManager?: boolean }): {
  /** Spans finished so far, in end order. */
  spans: () => ReadableSpan[];
  /** Forces a metric collection and returns the resource metrics. */
  metrics: () => Promise<ResourceMetrics>;
  /** Hooks built over the registered providers. */
  hooks: TelemetryHooks;
  /** Clears the exporters between assertions within one file. */
  reset: () => void;
};
```

`setupOtel` must, in its `afterAll`: `provider.shutdown()`,
`trace.disable()`, `metrics.disable()`, `propagation.disable()` and
`context.disable()`. All five, in that order — `trace.disable()` alone leaves
the context manager installed and the next file's `context.active()` is no
longer `ROOT_CONTEXT`.

A guard test in the shape of `__tests__/app/domLeak.test.ts`:
`otelLeak.test.ts` reads every `__tests__/*.ts`, and fails any file that
imports `@opentelemetry/sdk-trace-base` without calling `setupOtel()`.

The suite must pass under `bun test --randomize` with a couple of seeds — the
same bar bun-jobs-ui holds.

### 8.3 What to assert

| Area | Assertion |
|---|---|
| Off by default | with no `telemetry` option, `setupOtel()` registered, a full request through `adapter.fetch("/users/42")` produces **zero** spans. This is the test that catches an accidental always-on hook. |
| Span shape | name is `GET /users/:id` (the **pattern**, not `/users/42`), kind `SERVER`, `http.route` set, `url.path` set, `url.full` **absent** |
| Late route | a request that 404s has span name `GET` and no `http.route` |
| Status | 404 and 422 leave the status unset; 500 sets `Error` + `error.type`; a thrown `TypeError` sets `error.type: "TypeError"` |
| Propagation in | a request with `traceparent: 00-<id>-<span>-01` produces a span whose `traceId` is `<id>` and whose parent is `<span>` |
| Mounted routers | `http.route` includes the mount prefix, for `use("/users/:id", subRouter)` |
| `fetch()` parity | `fetch.test.ts`'s existing served-vs-socketless comparison extended to spans: the same request through a real server and through `adapter.fetch()` produces the same span name, kind and attribute set (minus `client.address`, which is honestly `null` with no socket) |
| Job link | enqueue in process A's context, claim and process; the process span's `traceId` **differs** from the enqueue's and its `links[0].context.traceId` **equals** it. The negative control: with `jobSpanParent: "creation-context"`, they are equal and there is no link. |
| Carrier round trip | a `JobRecord` written by the memory driver and read back has an intact `trace.traceparent`; a record written *without* one reads back `undefined` and the worker starts a root span with no link |
| Old jobs | a `JobRecord` literal with no `trace` field, inserted directly into each driver, processes cleanly — the backward-compatibility claim in §4.4 asserted, not assumed |
| Runner boundary | a `spawn` and a `worker` run where the child echoes `ctx.trace?.traceparent` back over the protocol; it must equal the parent run span's carrier |
| Metrics | `http.server.request.duration` is in **seconds** (a 50 ms request lands in the `0.075` bucket, not the `10` overflow); the bucket boundaries equal the semconv advisory |
| Observables | closing a queue unregisters its gauges — collect after `close()` and assert the queue's series is gone |
| Cardinality | `messaging.consumer.group.name` on a metric equals the worker's **stable key** across a simulated restart (two workers, different `id`, same `key`), not its incarnation id |

### 8.4 Type tests

In `__tests__/telemetry.type-test.ts` (checked by the tests typecheck, not
`bun test`), with a negative control as `bunValidate.libraries.type-test.ts`
has:

- `TelemetryHooks` is structurally satisfiable **without** importing
  `@opentelemetry/api` — an object literal with the right methods assigns. This
  is the compile-time proof that the core is dependency-free.
- `new BunHttpAdapter(0, { telemetry: hooks })` type-checks with a hand-rolled
  hooks object.
- `SpanSpec["attributes"]` rejects `undefined` values being *read* as
  `AttributeValue` (the `| undefined` is for the writer's convenience only).
- `TraceCarrier` is JSON-serialisable: `JSON.parse(JSON.stringify(c))` is
  assignable back to `TraceCarrier`. This pins the cross-process constraint in
  the type system.
- The unit of `record("http.server.request.duration", …)` — a branded
  `Seconds` type on the two duration instruments would make the ms/s mistake a
  compile error. Worth it; it is the single most likely silent bug in this plan.

### 8.5 Packaging tests

`__tests__/packaging.test.ts` gains: `exports["./otel"]` exists with the
three-key shape in the right order; `lib/index.ts` does **not** re-export
`./telemetry/otel`; `consumer-check.json` has a `./otel` entry declaring the
peer. `buildDeclarations.test.ts` already unit-tests `checkPeerScopes` — add a
case for a root reaching an OTel-importing declaration and assert it is
reported.

---

## 9. Bottlenecks, risks and open questions

**9.1 `Bun.otel` may land and change the calculus.** PR #39965 is open,
unmerged, and untouched since 2026-09-02. If it merges, `@opentelemetry/api`
resolves to Bun's native provider and our bridge keeps working unchanged —
that is the main reason to build on the API rather than on an SDK. But its
claimed cost (~0.9 µs/traced request natively vs ~80 k instructions for the JS
SDK) would make always-on tracing viable in a way it is not today, and the
"off by default" posture might then be wrong. **Do not design for it. Revisit
when it ships.**

**9.2 AsyncLocalStorage gaps in Bun.** Verified working for our paths
(`await`, timers, `queueMicrotask`, stream iteration, `Bun.serve` handlers,
concurrent request isolation). Documented as *not* working for `MessagePort`,
`BroadcastChannel` and `Worker` events — the last of which is why the runner
carries a serialised carrier. Two open items I could not resolve: whether
Bun's `AsyncContextFrame` is now parent-linked or still a cloned flat array
(issue #24324 closed without a clear statement), and whether PR #33069
(`PerformanceObserver` and signal-handler context loss) merged. Neither is on
our path, but a consumer whose own instrumentation uses those will see gaps
and may blame us.

**9.3 Cardinality from unparameterised routes.** `http.route` comes from
`matchedRoute.path`, which is the registered pattern — safe. The danger is the
paths that have no pattern: a 404, a `use()`-only request, and a wildcard
route where the matcher emits both a positional key and a name. semconv is
explicit that instrumentation MUST NOT fall back to the URI path, so those
spans are named by the method alone and carry no `http.route`. A test must
assert this, because the natural thing to write — `span.name = `${method}
${req.path}`` — is a metrics-database outage for anyone serving
`/files/<uuid>`.

**9.4 `layerSpans` is a trap and should be documented as one.** A request
through six middlewares plus a handler is seven extra spans at ~1.2 µs each,
and seven times the export volume. It is genuinely useful for finding which
middleware is slow, once. It is not a production setting. Default off, JSDoc
says so, and the option should probably take a predicate rather than a boolean
so it can be narrowed to one route.

**9.5 Worker identity cardinality.** `WorkerMetricsRecorderOptions.key`'s
JSDoc already states the lesson: *"The worker's **stable** key
(`WorkerInfo.key`), never its per-incarnation id: keyed by incarnation, a
rolling redeploy would shred the series into one per replica."* The OTel meter
must obey the same rule, and `messaging.client.id` (the incarnation) belongs on
**spans only**. A metric attributed by incarnation id in a Kubernetes
deployment produces a new time series on every pod restart.

**9.6 Double instrumentation with a consumer's existing setup.** Three cases,
and the news is mostly good:

- **`@opentelemetry/instrumentation-http`**: produces **nothing** for us.
  It patches `node:http`, and `Bun.serve` is not `node:http`. The
  `nodeHttpServer()` shim (`BunHttpAdapter.ts:#nodeHttpServer`,
  `initNodeHttpServer`) is an event-emitter facade, not a real server, so it is
  not patched either. **No duplicate SERVER span.** Worth stating in the README
  because everyone will assume otherwise.
- **`@opentelemetry/instrumentation-nestjs-core`**: patches `NestFactory.create`
  and the request context, emitting `INTERNAL` spans named
  `<Controller>.<handler>`. These nest correctly under our SERVER span and are
  *complementary*. The conflict is only if we also emit a handler span — hence
  `handlerSpans: false` by default in `BunTelemetryModule`. A startup check
  that logs one `warn` when it detects the nestjs-core instrumentation *and*
  `handlerSpans: true` would be cheap and kind.
- **`@opentelemetry/instrumentation-express`**: irrelevant, nothing here is
  Express. But note Bun issue **#26536** (still open): `requestHook` callbacks
  in the Express and Fastify instrumentations never fire under Bun, so those
  users get high-cardinality span names today. Our instrumentation does not
  depend on that mechanism.

**9.7 Cross-process clock skew.** Span start/end come from each process's
`Date.now()`. With parent-child across a queue, a consumer on a host 200 ms
behind the producer renders as a child starting *before* its parent — some
backends reject that, others draw it wrong. Links carry no temporal
implication and are immune. One more reason for the `"link"` default, and a
line in the `jobSpanParent: "creation-context"` JSDoc.

**9.8 Sampling long-lived job traces.** A job retried over three days with
`jobSpanParent: "creation-context"` produces spans days apart in one trace.
Concretely: Jaeger and Tempo finalise a trace after a completion window
measured in minutes; the later spans are written as a second, fragmentary
trace with the same id, or dropped. And `ParentBased` sampling is age-blind —
a week-old sampled `traceparent` force-samples every attempt forever. There is
**no OTel guidance on stale parent contexts**; the research confirmed the spec
is silent (`ParentBased` branches only on presence/remoteness/sampled-ness) and
that consistent sampling across *linked* traces is an open specification issue
(opentelemetry-specification#2918). The defensible answer is the semconv's
structural one: link, start a new trace, let the consumer sample. That is the
default here, and the reasoning belongs in the README so nobody "fixes" it.

**9.9 The `bunjobs.*` attribute namespace is genuinely unresolved in the
spec.** `messaging-spans.md` says system-specific messaging attributes MUST
live under `messaging.{system}.*`; `general/naming.md` says not to use an
existing OTel namespace as a prefix for your own attributes, and lists
messaging as a **known exception** pending migration. So `messaging.bunjobs.*`
follows the registry's precedent (`messaging.kafka.*`) and `bunjobs.*` follows
the forward-looking rule. This plan uses `bunjobs.*` — it is the one that
cannot collide with a future semconv addition, and the semconv itself says
messaging will migrate that way. Flag it in the README as a documented choice
that may change, and keep every `bunjobs.*` attribute behind one constant map
so a rename is one edit.

**9.10 `messaging.system: "bunjobs"` is a bare, unprefixed custom value.**
Spec-legal (*"otherwise, a custom value MAY be used"*), and consistent with
bare registry values like `rabbitmq` and `pulsar`, but `naming.md`'s
"avoid generic names" principle argues for something unambiguous. `"bunjobs"`
is distinctive enough. Make it configurable (`JobsTelemetryOptions.system`) so
a deployment that disagrees is not stuck.

**9.11 Messaging semconv is Development and just moved.** v1.44.0 restructured
messaging spans into five per-operation definitions and removed
`messaging.consumer.group.name` and `messaging.destination.subscription.name`
from the generic span tables (verified: 3 occurrences in v1.43.0's
`messaging-spans.md`, 0 in v1.44.0's). Anything we adopt can move again. Pin
the targeted version in a constant, put it in the README table, and treat a
semconv bump as a minor-version change to the telemetry surface.

**9.12 What happens with no SDK.** `otelTelemetry()` against the default
global providers returns real objects whose spans are `NonRecordingSpan` —
~15-24 ns per span, no export, no memory growth. Safe. The failure mode to
document is the other one: importing `@kingsleyweb/bun-common/otel` **without
`@opentelemetry/api` installed** is a module-resolution error at import time.
That is intentional and loud, and `consumer-check.json` asserts it.

**9.13 Where the span must not end.** Two places where the obvious code is
wrong and a test must pin it: bun-nest's streaming early return
(`BunHttpAdapter.ts:388` — the pipeline is still running), and bun-jobs'
deliberately un-awaited `#settle` (`BunQueueWorker.ts:2032-2043` — awaiting it
to end the span would reintroduce exactly the serial round trip that comment
says was removed to reach graphile-worker's numbers).

**9.14 The `Promise.allSettled` in `processRegisteredRouteHandlerFor`**
(`BunWebSocket.ts:916`) swallows handler rejections. A WebSocket message span
that records from the settled array loses every error. Record inside each
handler's promise.

**9.15 Open questions I could not close.**
- Whether `network.protocol.version` is obtainable from `Bun.serve` at all. I
  found no accessor. If not, omit it — a hardcoded `"1.1"` is a lie on an
  HTTP/2 server.
- Whether `layer.baseUrl + matched.path` is the correct `http.route` for every
  mount shape (nested mounts, `next('router')` exits, host-pattern routes). I
  have read the fields; I have not proved the concatenation.
- Whether a `Proxy`-based traced driver measurably slows the untraced path in
  Bun's JIT. `driverSpans` is off by default, but the wrapper only exists when
  telemetry is on — so the risk is confined to traced deployments. Measure in
  phase 4 before enabling it anywhere.
- Whether `import-in-the-middle` works under Bun's loader. Only
  `require-in-the-middle` is named as working in Bun 1.4's notes. Irrelevant to
  us (we do not patch), but it determines what a consumer's own
  auto-instrumentation can reach, and therefore what our spans will have as
  siblings.

---

## 10. Phased delivery

Each phase ships on its own, passes `bun scripts/typecheck.ts`,
`CI=1 bunx eslint .` in each touched package, `bun test` plus
`bun test --randomize`, and — from phase 3 — `bun queue.ts --compare`.
Estimates are engineer-days for someone who knows this codebase.

### Phase 1 — the core interface and the bridge (3-4 d)

- `lib/telemetry/index.ts`: the types above, plus `noopTelemetry` (for tests
  and for a consumer who wants an explicit off) and
  `resolveTelemetry(input?: TelemetryHooks | HttpTelemetryOptions)`, mirroring
  `resolveLogger`'s shape.
- `lib/telemetry/otel.ts`: `otelTelemetry`, `correlatingSink`.
- Packaging: the two `exports` keys, the optional peer, `consumer-check.json`,
  the packaging-test assertions, the `checkPeerScopes` regression case.
- `__tests__/otel.ts` (`setupOtel`), `otelLeak.test.ts`,
  `telemetry.type-test.ts`.
- **Ships nothing user-visible.** Acceptance:
  `bun scripts/consumer-check.ts packages/bun-common` at 104/104, green in
  both the peer-bearing and peer-free consumers.

### Phase 2 — bun-common HTTP spans and metrics (4-5 d)

- The dispatcher split in `BunHttpAdapter.handleNativeRequest` (line 344).
- Span attributes, late `http.route`, status rules, error paths through
  `handleRequestError` (line 541).
- `http.server.request.duration` and `http.server.active_requests`.
- `layerSpans` in `BunRouter.handle` (line 4582), off by default.
- Tests per §8.3, including the `fetch()`-vs-served parity extension.
- Acceptance: `benchmarks/bench.ts --route static,param,middleware` unchanged
  with telemetry off (recorded in the PR); README section.

### Phase 3 — bun-jobs producer and consumer, with the wire format (6-8 d)

The largest phase, because it is the wire format and five drivers.

- `JobRecord.trace`, the SQL column + `schemaSync` entry, driver round-trip
  tests for all five including the "record without the field" case.
- Producer spans in `BunQueue.#addSimple`/`#addBulk`/`#addRepeatable`/`#addFlowNode`.
- Consumer spans in `BunQueueWorker.#process`, with every outcome path.
- `jobSpanParent` with `"link"` default; the link-vs-parent test with its
  negative control.
- `bunjobs.job.queue.duration`.
- Acceptance: `bun queue.ts --compare` and `bun runner.ts --compare` pass
  unchanged with telemetry off; the new `--telemetry` baseline recorded.

### Phase 4 — bun-jobs metrics, drivers, runner (4-5 d)

- The metrics catalogue of §5.3, wired at the existing counter sites.
- Observable gauges with disposers, and the close-unregisters test.
- `tracedDriver` behind `driverSpans`, with the optional-method-preservation
  test.
- Runner spans, `SerializableContext.trace`, the spawn/worker echo test.

### Phase 5 — bun-nest (3-4 d)

- The adapter split, with the streaming early-return handled (§9.13).
- Route enrichment from `registerVerb` (line 1432).
- `BunTelemetryModule.forRoot`/`forRootAsync`, modelled on `BunJobsApiModule`.
- Gateway message spans in `invokeHandler` (line 871).
- The nestjs-core coexistence check and its `warn`.

### Phase 6 — optional and deferred (3-4 d, or dropped)

- WebSocket instrumentation in bun-common (§3.3).
- `serveStatic` / `compression` / multipart spans.
- Notifier event carriers (`lib/notifier.ts:460`) — a second wire-format
  change; only if someone asks.
- Message-level WebSocket propagation in bun-nest's gateway envelope — a
  browser-visible protocol change; needs its own decision.

**Total: 23-30 days** for phases 1-5, which is the complete, shippable
product. Phase 6 is discretionary.

### Documentation owed at each phase

Per `CLAUDE.md`'s examples protocol, every user-facing change goes to the
examples session as a change report before merge. Phases 2, 3, 4 and 5 each
add a public option and therefore each owe one. A worked example under
`examples/` — an HTTP request that enqueues a job, processed by a worker in a
second process, with the resulting two-trace-plus-link shape shown — is the
thing that will make the link-not-parent decision stick.
