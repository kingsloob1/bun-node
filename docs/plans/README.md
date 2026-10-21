# Plans

The design and implementation plans for bun-node, and the measurements,
probes and source surveys they rest on.

## How this folder is laid out

Every main plan is a folder named after it (the user's decision, 2026-10-11):

- **`<plan>/README.md` is the main plan.**
- **A sub-plan** that helps implement it sits inside that folder, as
  `<plan>/<sub-plan>.md`, or as a folder of its own, `<plan>/<sub-plan>/README.md`,
  when it has sub-plans of its own.
- **Evidence** goes in the plan's `evidence/` folder: `<plan>/evidence/`. A
  sub-plan's evidence goes under its own folder's `evidence/` when it is a
  folder, and under the parent's `evidence/<sub-plan>/` when it is a file.
- **A new plan starts in this shape**, even with no sub-plans or evidence yet:
  `docs/plans/<plan>/README.md`.
- **A follow-up plan goes in the folder of the plan it extends**, as a
  sub-plan, not beside it at the top level.
- **This file is the index.** Add a plan, a sub-plan or an evidence folder to
  it in the same change that creates it.

Links between plans are relative, so a move changes them: after moving a
file, check every link into and out of it, `#anchors` included.

## Index

- **[`worker-runtimes/`](worker-runtimes/README.md)** — where a
  `BunQueueWorker` can run: execution targets other than the defining process,
  and the published contract a foreign system can implement.
  - [`control-plane-rename.md`](worker-runtimes/control-plane-rename.md) —
    renaming the control planes to `RemoteWorker` and `RemoteRunner`
    (implemented).
  - [`remote-transports.md`](worker-runtimes/remote-transports.md) — one
    remote-attempt protocol carried over many network bindings.
  - [`worker-gateway-and-isolation.md`](worker-runtimes/worker-gateway-and-isolation.md) —
    remote workers that do not connect to the driver, and a sandbox for the
    job.
  - [`compute-provider-plugins.md`](worker-runtimes/compute-provider-plugins.md) —
    how a third party adds a compute platform.
  - **[`summon-compute/`](worker-runtimes/summon-compute/README.md)** —
    starting a worker when a queue needs one.
    - [`summon-multi-queue.md`](worker-runtimes/summon-compute/summon-multi-queue.md) —
      summon groups: one budget, and one unit, for several queues.
    - Evidence: [`summon-compute/evidence/`](worker-runtimes/summon-compute/evidence/README.md) —
      three platform surveys (AWS; Google and Azure; PaaS, SSH and
      Kubernetes) for starting compute on demand, including a SigV4 signer
      checked against test vectors and a token helper not yet run against
      real endpoints; also backs `compute-provider-plugins.md`.
      [`evidence/summon-multi-queue/`](worker-runtimes/summon-compute/evidence/summon-multi-queue/README.md) —
      two spikes on all eight backends (Bun 1.4.3): where a summon group's
      shared state can live (a pseudo-queue's state is listed as a queue on
      file and memory only), compare-and-set contention on one shared entry
      against one per queue, and the boot cost and RSS of one unit with N
      workers against N units.
  - Evidence: [`worker-runtimes/evidence/`](worker-runtimes/evidence/) —
    [`prior-art-survey.md`](worker-runtimes/evidence/prior-art-survey.md), a
    14-system prior-art survey read from pinned primary sources;
    [`phase2-slicing/`](worker-runtimes/evidence/phase2-slicing/README.md)
    (backs the main plan's §11, Phase 2 as PRs), four spikes on the canary
    build that de-risk the Phase 2 PR slicing: the per-frame MAC's cost
    through `crypto.subtle` and `node:crypto` (sequential, concurrent, CPU
    against wall time), the SSE buffering probe through streaming and
    buffering Bun proxies, and WebSocket backpressure with protocol-sized
    frames in both directions;
    [`remote-transports/`](worker-runtimes/evidence/remote-transports/README.md)
    (also backs the main plan's §5), what Bun provides per network transport,
    **measured** by 27 re-runnable spikes (loopback, canary build), and which
    of ~35 platform shapes accept which transport;
    [`worker-gateway-and-isolation/`](worker-runtimes/evidence/worker-gateway-and-isolation/README.md),
    a throwaway gateway on the real `BunQueueWorker` benchmarked direct, over
    reversed WebSocket and HTTP long-poll, and as a raw pull proxy on memory,
    Redis and Postgres; a protocol matrix of Bun 1.4.3 as client and server;
    Docker, bubblewrap and Bun-level limits **measured** against a hostile
    job, cold start, warm and single-use pools; a 17-platform survey of
    nested isolation.
- **[`bun-native-routes/`](bun-native-routes/README.md)** — whether
  `Bun.serve({ routes })` should route, and run the handlers, for bun-common's
  and bun-nest's `BunHttpAdapter`.
  - [`elysia2-performance.md`](bun-native-routes/elysia2-performance.md) —
    Elysia 2's throughput, and what bun-common and bun-nest can take from it
    without giving up the Express 5 contract.
  - [`research-trailing-scenarios.md`](bun-native-routes/research-trailing-scenarios.md) —
    why param-random, json, async, headers and wildcard still trailed Elysia 2,
    then the body-parsing work.
  - Evidence: [`bun-native-routes/evidence/`](bun-native-routes/evidence/) —
    what `Bun.serve({ routes })` and `server.reload()` do on the canary build,
    **measured** by spikes; the router benchmark (bun-common, bun-nest,
    Elysia, raw Bun) run with `oha`; two routing prototypes (native partition,
    JS candidate index) with a differential fuzz and a harness that runs the
    packages' own suites against them; minimal Bun reproductions; and, in
    `sse/`, server-sent events through both adapters (NestJS `@Sse()`,
    `idleTimeout`, errors after headers, backpressure, a fan-out benchmark)
    with a prototype of the proposed helpers, and (2026-10-17) a prototype of
    the broadcast channel, `createSseChannel()` (express-sse's conveniences,
    replay, topics, NestJS `@Sse()`/`@SseSignal()`), §16.14. Indexed in the
    plan's §15 and §16.13.
    [`elysia2-performance/`](bun-native-routes/evidence/elysia2-performance/README.md),
    Elysia 2 (2.0.0-beta.21) read end to end and measured **in process**
    beside bun-common and bun-nest at `ae1a7cc` (a pinned snapshot, via
    `PKG_ROOT`): whole requests per scenario, a stage breakdown, Elysia's
    emitted route code, isolated technique costs, prototypes of the proposed
    changes (sync fast loop, single async wait, cache admission), a bun-nest
    breakdown, CPU profiles; no load generator.
    [`research-trailing-scenarios/`](bun-native-routes/evidence/research-trailing-scenarios/README.md),
    in-process A/B and stage scripts, CPU-profile summarisers, multipart
    stage costs, `file-type` costs, Bun `formData()` against busboy (speed and
    20 behaviour probes), urlencoded parser comparison.
- **[`typed-client/`](typed-client/README.md)** — a type-aware client request
  library: one route model, types from the server, an SWR data layer, live
  sync.
  - [`nest-typed-routes.md`](typed-client/nest-typed-routes.md) — the NestJS
    half: decorators, the route model, a dev types module, typed gateways.
  - Evidence: [`typed-client/evidence/`](typed-client/evidence/README.md)
    (backs both) — a standalone Bun project (query-core and its five
    adapters, swr, nanostores, openapi-fetch, zod, valibot, ajv and others,
    pinned and installed there only) **measuring**, on Bun 1.4.3 and
    TypeScript 6.0.3: a route map type accumulating on a patched copy of the
    real `BunRouter` against a registry, at 50/200/1000 routes, with
    declaration emit; a route model walked from statement-style routes, a
    generated `.d.ts` with a parity check, and its type-check cost at 1000
    routes; generated Zod (size, validation cost, what survives JSON Schema);
    the dev live sync loop end to end under `--hot`, `--watch` and polling; a
    dependency-free SWR core with a React binding (27 tests); bundle sizes of
    every data layer and validator considered; and Nest controllers turned
    into the same model through `DiscoveryService` on bun-nest.
- **[`bun-cache/`](bun-cache/README.md)** — `@kingsleyweb/bun-cache`: caching
  over pluggable drivers, with HTTP and Nest utilities.
  - [`bun-jobs-s3-driver.md`](bun-cache/bun-jobs-s3-driver.md) — bun-jobs on
    S3: a driver, a blob store, or an archive.
  - Evidence: [`bun-cache/evidence/`](bun-cache/evidence/README.md) — spikes
    on Bun 1.4.3 for a caching package: Bun's `S3Client` on the wire against
    a recording stub (no metadata, no conditional writes, `Content-Type`
    parameters survive `stat()`), SQLite WAL throughput through `bun:sqlite`
    and Bun's `SQL`, Postgres `sql.listen` and Redis pub/sub latency,
    single-flight under 1000 concurrent misses, native codecs and
    compression, SQL bytes columns and atomic increments on four engines, a
    file store's atomic writes, a typed-overload slot check, and a
    Keyv/cache-manager compatibility probe.
    [`bun-jobs-s3-driver/`](bun-cache/evidence/bun-jobs-s3-driver/README.md),
    Bun 1.4.3 against four S3-compatible servers (MinIO 2025.5.24, SeaweedFS
    4.48, RustFS, Versity S3 Gateway 1.8.0): conditional writes through a
    presigned URL plus `fetch` and through hand-made SigV4, races, a
    compare-and-swap counter on one object, loopback latency; a prototype of
    a claim-once path on S3; pickup latency against poll interval (corrected
    after review); a cost model per design; the pinned SeaweedFS test
    server's startup time; the AWS SDK's presigned signed headers.
- **[`api-docs-generation/`](api-docs-generation/README.md)** — auto-generated
  API documentation: OpenAPI 3.1 for the HTTP adapter, AsyncAPI 3.0 for the
  WebSocket adapter.
  - Evidence: [`api-docs-generation/evidence/`](api-docs-generation/evidence/README.md) —
    TypeScript spikes for response contracts, decorators and inference.
- **[`bun-views/`](bun-views/README.md)** — `@kingsleyweb/bun-views`:
  rendering UI components to HTML per request, a framework-agnostic core with
  one adapter per framework, React first.
  - Evidence: [`bun-views/evidence/`](bun-views/evidence/README.md) — a
    standalone Bun project (React 19.3, Express 5.3, Vue 3.5, Svelte 5.57,
    Preact 11, Solid 1.9, installed there only) **measuring** server
    rendering on Bun 1.4.3: for React, `renderToString` against streaming
    against buffered and `prerender`, React 19 server behaviour, SSR through
    bun-common's adapter over a socket (TTFB, HEAD, errors after the headers,
    and a `compression()` stall on streamed bodies with its controls),
    throughput against Express on Node and on Bun, loading `.tsx` views by
    path and reloading them, the Express engine contract on real Express,
    hydration in Chrome under a nonce CSP with SRI, and a type-level spike for
    typed props; then a framework-agnostic core and five adapters (React,
    Vue, Svelte, Preact, Solid) through it: rendering, streaming, async data,
    errors, compile steps against the existing Bun plugins, client bundles,
    hydration in Chrome, and props typing per framework (was
    `react-views/`).
- **[`nest-jobs-decorators/`](nest-jobs-decorators/README.md)** — bun-jobs in
  NestJS: modules, decorators and the Nest pipeline for jobs.
  - Evidence: [`nest-jobs-decorators/evidence/`](nest-jobs-decorators/evidence/README.md) —
    bun-jobs in NestJS through decorators, **measured** on Bun 1.4.3 and Nest
    11.1.27 against a throwaway prototype: the Nest pipeline (guards,
    interceptors, pipes, filters, custom parameter decorators, global
    enhancers) around a job handler through `ExternalContextCreator`; where to
    drain workers on `app.close()`; request-scoped processors per job; the
    per-attempt cost of a Nest context off-thread; what TypeScript catches
    from token to handler; Bun's decorator tsconfig lookup; guards as the
    management API's `authorize`.
- **[`nestjs-12-parity/`](nestjs-12-parity/README.md)** — bun-nest and
  bun-common on NestJS 12 (12.1.3, released): every change from 11.1.27
  classified, the adapter contract, routing parity with platform-express,
  supporting 11 and 12 together, the test matrix and the PRs. **Approved in
  full on 2026-10-17** (Q1–Q8 answered, PR-0 to PR-11), led by the bun-nest
  agent; its Status section tracks the PRs.
  - Evidence: [`nestjs-12-parity/evidence/`](nestjs-12-parity/evidence/README.md) —
    two changelog matrices (434 rows) and a coverage check: every commit in
    `v11.1.27..v12.1.3` touching a Nest package classified; the npm registry facts; the adapter contract diffed member by
    member; **measured** in repo copies with Nest 12.1.3 or 11.x installed
    (`nest-mirror.sh`), on Bun 1.4.2, 1.4.3 and 1.4.4-canary: bun-nest's
    suite (420/427 on 12) with the seven failures root-caused and prototype
    patches (427/427 on both majors), `examples/bun-nest`, consumer-check on
    TS 6.0 and 5.9, the Nest 11 floor bisect (11.1.20); a routing
    differential (175 requests, platform-express against `BunHttpAdapter`,
    Nest 11 and 12); twelve feature probes (cookies, CSRF and security
    headers, exception mapping, SSE, `StreamableFile`, shutdown, Standard
    Schema, uploads, WebSockets against platform-ws, `QUERY`, logging,
    instrumentation); a Bun `fetch()` double-slash bug, reproduced and
    drafted, not filed.
- **[`opentelemetry/`](opentelemetry/README.md)** — OpenTelemetry for
  bun-node.
  - Evidence: [`opentelemetry/evidence/`](opentelemetry/evidence/README.md) —
    a standalone Bun project measuring OTel span cost and Bun's
    `AsyncLocalStorage` behaviour.
- **[`bun-validate/`](bun-validate/README.md)** — an audit of what
  `BunValidate` validates and types today (requests yes; responses, Nest,
  WebSockets, job data and caches no), and, revised 2026-10-17 to the user's
  full scope, one transport-agnostic validation contract every transport plugs
  into: HTTP requests with cookies and typed headers, responses by status with
  headers and every body kind, NestJS on 11 and 12, WebSockets, SSE on both
  adapters, job data, results and flows, an extension point for gRPC, Kafka,
  RabbitMQ/AMQP and UDP, and the runtime metadata OpenAPI, AsyncAPI and the
  typed client read. Adopts the [`api-docs-generation/`](api-docs-generation/README.md)
  `@Validate` design and orders it with its own PRs.
  - Evidence: [`bun-validate/evidence/`](bun-validate/evidence/README.md) —
    on Bun 1.4.4-canary.1 at `73bf4a00`: runtime and type probes of today's
    BunValidate (`fetch()`, no socket; 7 type controls), which vendors answer
    synchronously and what one check costs, a prototype of response checks
    that answers 500 on a sync or async mismatch with its per-request cost,
    the api-docs plan's response typing re-applied to today's bun-common as a
    patch with its type tests, bun-nest checked against it and the overloads
    unchanged, and a `SchemaDto` + global pipe through Nest's real pipeline
    on bun-nest. Added 2026-10-17 at `68023d36`: `contract-core/` (the
    transport-agnostic core, eight transports declared, UDP and in-process
    broker adapters, 24 type controls) and `http-complete/` (a patch on a copy
    of bun-common: cookies, typed headers, response checks for every body kind,
    H1–H52, 18 type controls, cost per body kind), and `nest-interceptor/`
    (bun-node-15's probe of what a Nest interceptor sees on Nest 11 and 12).
    Added 2026-10-21 at `a471c18d`: `response-variants/` (V3c, the plan's
    §4.4.6): a prototype of response variants composed with the real V3a
    types and overloads on both adapters (21 type controls, line-exact), a
    runtime matcher with cases RV1–RV28 (whole matches, `when` sync and
    async, discriminants, `refine`, `.variant()` filling single literals and
    stripping undeclared body fields, no value in any issue, the loose-subset
    leak limit and its fix), and the matcher's cost per variant count.
- **[`bun-lint-fmt/`](bun-lint-fmt/README.md)** — replacing ESLint and
  Prettier with `bun lint` and `bun fmt` (there is no oxlint to drop): rule and
  formatter parity, the proposed `bunfig.toml`, VS Code, gating on a stable
  Bun release, the phases and PRs.
  - Evidence: [`bun-lint-fmt/evidence/`](bun-lint-fmt/evidence/README.md) —
    on Bun 1.4.4-canary.1 at `5f5799ed1`, in clones of develop: ESLint's
    effective config (384 rules) mapped onto `bun lint`'s 1,021 (127 native,
    85 under another name or upstream, 172 missing); a shadow run reproducing
    all 71 ESLint findings natively and explaining 743 more, with single-file
    reproductions against the upstream plugins and oxlint; `bun fmt` against
    Prettier 3.8.4 and 3.9.10 on every file (identical to 3.9.10), its
    idempotence, `--debug-check`, the parsed READMEs and the generated
    overloads; import and `package.json` sorting churn; `--doctor` per
    directory; ESLint, `bun lint`, Prettier and `bun fmt` timed three times
    each; editor-path latency.

## Evidence

The evidence folders hold the measurements, probes and source surveys the
plans rest on. They are kept because a plan that says "measured" is only worth
as much as the ability to re-run the measurement — and because several
conclusions here were **reversed** once someone re-read the source, which is
the strongest argument for keeping the workings rather than the summary.

Nothing in an `evidence/` folder is part of any published package. No
`tsconfig.json` in one is in `scripts/typecheck.ts`'s `PROJECTS` list, and no
directory is in the root `workspaces`, so none of it is built, typechecked or
linted by the repo's own tooling. That is deliberate: the spikes contain
**intentional type errors**. Recorded output (`results*`, `*.out`) is kept as
it was recorded, including the paths it printed, which may predate the
folders' move to this layout.

### Provenance, and why it is marked

Every factual row in the survey, and every number in the OTel plan, is tagged
as **measured here**, **read from a primary source at a pinned version**, or
**unverified**. Treat that marking as load-bearing. Three claims in the
worker-runtimes plan were withdrawn or re-attributed after a second reading,
and in each case the failure was the same shape: a plausible inference from a
secondary source that nobody had checked against the code it described.

A conclusion in these files is as old as the file. Re-run before relying.
