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

<a id="handoff-2026-10-22-where-every-plan-stands"></a>

## Where every plan stands (2026-11-10)

Checked on 2026-11-10 against `origin/develop` at `ae01cfe9` (#752): the
merged PRs, `gh pr list` and the code. **There are no open PRs.** Verify any
state below against `git log origin/develop` and `gh pr list` before acting
on it: this table is as of that commit. The handoff of 2026-10-22 (every agent
stopped so that another model could continue) is in
[`docs/agentic-setup.md`](../agentic-setup.md), "Handoff (2026-10-22)", which
still covers the machine and the maintainer's standing rules. Then read the
plan you are about to work on.

| Plan | State on 2026-11-10 | Next | Where to resume |
|---|---|---|---|
| [`bun-validate/`](bun-validate/README.md) | **complete but for one V11 item**: V0–V3c (#463, #470, #477, #482, #484, #495), V4 #502, V5a #507, V5c #515, V5b #530, V6 #501, V7a #522, V7b #523, V8 #525, V9 #526, V10 (inside bun-cache's PR-C1, #544), V12 #528, V13 #524, AD (b0) #527; V11 inferred done but for one item: its bun-common half is `res.sse({ contract })` in bun-native-routes' PR-sse2 (#633), its Nest half `@Validate`'s per-event `@Sse()` checks (#523); V3c's per-event `variants()` on an SSE writer is not built (no `variant` in `lib/sse/`) | V11's per-event `variants()`, if still wanted | its Status |
| [`nestjs-12-parity/`](nestjs-12-parity/README.md) | **complete** (PR-0 to PR-11 and three additions merged; PR-11 as #467) | none; the version matrix stays live (CLAUDE.md, "Nest versions") | its Status |
| [`bun-lint-fmt/`](bun-lint-fmt/README.md) | **through PR E** (#462): `bun lint` and `bun fmt` are the gate | **PR F**: remove ESLint and Prettier; its precondition is met; it needs the user's go-ahead | its [Handoff](bun-lint-fmt/README.md#handoff-2026-10-22) |
| [`worker-runtimes/`](worker-runtimes/README.md) and [`summon-compute/`](worker-runtimes/summon-compute/README.md) | Phases 0, 1 and 1r merged; Phase 1.5 merged except the cloud providers; summon groups ([`summon-multi-queue.md`](worker-runtimes/summon-compute/summon-multi-queue.md)) complete, its two open items carried into 1.5d by #393 | **held** by the user's order: 1.5c (AWS, Fly), 1.5d (Google, Azure), 1.5e (Render, SSH), 1.5g (live verification), 1.5s (the stability gate), none started; Phase 2 per its own §11 | each plan's Status (2026-10-11); nothing has changed since but PR-B4 (#379) and its UI and examples (#383, #386) merging |
| [`bun-native-routes/`](bun-native-routes/README.md) | the routing question is answered (`Bun.serve({ routes })` gives no speed-up on 1.4.3; oven-sh/bun#44176 and #44177 filed, #41363 commented); the **SSE helpers**: PR-sse1 #267, PR-sse2 #633 (with the typed client's four additions) and S10 #663 merged; the broadcast channel (PR-sse2b, §16.14), PR-sse3 and PR-sse5 not started, PR-sse4 partly done | **held** | §16 |
| [`bun-cache/`](bun-cache/README.md) | **complete**: PR-C1 to PR-C8, PR-C10, PR-C11, PR-H0 to PR-H2b, PR-N1, PR-N2, PR-T1, PR-B1, PR-K1, PR-C1b and PR-R1 (#544 to #586), the playground #572, [`encryption.md`](bun-cache/encryption.md)'s PR-Z1 to PR-E3 (#567, #571, #574, #577, #579), the speed work (#595 to #623) and the driver follow-ups (#674, #676); PR-C9 (Upstash over REST) deferred by the user (2026-10-28) | none; [`bun-jobs-s3-driver.md`](bun-cache/bun-jobs-s3-driver.md) is a separate proposal, unbuilt beyond its S3 test server (#560) | the plan's Status |
| [`api-docs-generation/`](api-docs-generation/README.md) | **complete except (g)**: (b0) #527, (b) #529, (a) #531, (c) #532, (d) #533, (a2) #534, (b2) #535, (e) #539, (f) #541 and #542, tag groups #629, `defaultTags` #632; (b1) shipped as bun-validate's V3a (#482) | (g), the swagger bridge: optional, and §11 says it may be dropped | its Status |
| [`typed-client/`](typed-client/README.md) (with [`nest-typed-routes.md`](typed-client/nest-typed-routes.md)) | **complete**: PR-K #592, PR-C1 #593, PR-M1 #594, PR-M2 #596, PR-C2 #597, PR-C3 #599, PR-C4 #600 (follow-ups #626), PR-C5 #608, PR-C6 #611, PR-C8 #612, PR-C9 #614, PR-W1 #627, PR-S1 #628, PR-W2 #630, PR-W3 #634, PR-W4 #637 (follow-ups #679 to #681), PR-G1 #638, PR-R1 #639, PR-R2 #640, NTR #641 to #643, the pilot #648 and #649, the examples #651, the 2026-11-08 follow-ups #685 to #689 | the on-demand items only (`./vue`, `./svelte`, `./solid`, `./preact`, upload progress, a `"bun-jobs"` codec), and SSR's `<ApiHydrate>` after bun-views' PR-5 | its Status |
| [`bun-views/`](bun-views/README.md) | PR-C (#320), PR-C2 (#328) and PR-0 (#324) merged; PR-1 to PR-8 not started | **held** | its Status |
| [`nest-jobs-decorators/`](nest-jobs-decorators/README.md) | **complete** (PR-n1 to PR-n10 merged, #721 to #747, with follow-ups #745, #746, #748; PR-n1 to PR-n9 shipped in 3.0.0-rc.2) | none; the playground's browser review is owed | its Status |
| [`bun-ui/`](bun-ui/README.md) | BU-1 #666, BU-2 #708, BU-3 #709 and BU-5 #710 merged (the old names cleaned up in #713), released in 3.0.0-rc.1 (#712); BU-4 (the shared kit) not started | BU-4, which may follow rc.1; bun-security's PR-U1 builds on it | its Status |
| [`bun-security/`](bun-security/README.md) | approved 2026-11-07; its foundations merged: trustProxy #653, the throttle T1 to T3 #654 to #656; nothing of the package built | **held**: building M1 waits for the user's go-ahead | its Status |
| [`opentelemetry/`](opentelemetry/README.md) | plan only | **held** (the user's decision) | the plan |

**Held** means the user has not scheduled it, not that it is blocked. The
user's order (2026-10-17): Nest 12 parity, then BunValidate complete and
transport-agnostic, then BunValidate in Nest (all three done), then the rest.
Ask the user before starting any held plan.

**Pushed branches that are not PRs.** *Historical: neither `wip/` branch is on
GitHub any more (`git ls-remote origin 'refs/heads/wip/*'` is empty on
2026-11-10).* Two `wip/` branches preserved the only
stash entries in the repository. They are old, and both were superseded by
merged work. Each is a stash commit: the first parent is its base, the
second the index, the third (when there is one) the untracked files. Inspect
one with `git show <branch>` and `git show <branch>^3`; never apply one
blindly.

| Branch | Head | What it holds |
|---|---|---|
| `wip/stash-2026-10-07-playground-local-compute` | `49befc34` | the playground's switch to the library's `localCompute()` as it stood on 2026-10-07 (`playground/index.ts`, `compute/platform.ts`, `summoning.ts`), and in its untracked part an early `playground/compute/obinna-queue-worker.ts`. The feature merged since, in its own form (`3c070a38`, "summon on the library localCompute()"). The untracked `playground/compute/obinna-queue-worker.ts.orig` in the main checkout is that same file, byte for byte |
| `wip/stash-2026-09-23-examples-read-apis` | `f0d975a8` | a draft of `examples/bun-jobs/10-options/read-apis.ts` and an edit to `jobs-api-options.ts`, stashed on `docs/maintenance-split`; `read-apis.ts` has been on develop in its own, later form for weeks |

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
- **[`typed-client/`](typed-client/README.md)** — a type-aware client
  library for every transport bun-node serves (revised and approved by the user 2026-11-02; built 2026-11-02 to 2026-11-08, #592 to #689, as `@kingsleyweb/bun-client` and `@kingsleyweb/bun-contract`): types
  from the server's contracts through its OpenAPI and AsyncAPI documents (or
  inferred in a monorepo), validation of both directions, an SWR data layer,
  live sync.
  - [`websocket.md`](typed-client/websocket.md) — typed WebSocket channels:
    request/response, push, reconnection, backpressure, Nest gateways, live
    invalidation as a channel.
  - [`sse.md`](typed-client/sse.md) — typed server-sent events with
    `Last-Event-ID` resume.
  - [`webrtc.md`](typed-client/webrtc.md) — what of WebRTC can be typed:
    signalling and data channels, not media; Bun has no WebRTC.
  - [`graphql.md`](typed-client/graphql.md) — bun-node serves no GraphQL;
    a typed call for external APIs, on demand.
  - [`other-transports.md`](typed-client/other-transports.md) — named
    operations, uploads, downloads, streamed bodies; gRPC and Connect out.
  - [`nest-typed-routes.md`](typed-client/nest-typed-routes.md) — the NestJS
    half: decorators, a dev types module, typed gateways (mostly built by
    bun-validate; revised 2026-11-02).
  - Evidence: [`typed-client/evidence/`](typed-client/evidence/README.md)
    (backs all of them; the 2026-11-02 spikes are its
    [`transports/`](typed-client/evidence/transports/README.md) project:
    WebSocket typing cost, WebRTC peers under Bun, GraphQL sizes and
    gql.tada's check cost, the contract core in a browser) — a standalone Bun project (query-core and its five
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
  over pluggable drivers, with HTTP and Nest utilities. **Complete**
  (2026-11-10): #544 to #623, #674, #676; PR-C9 deferred by the user.
  - [`bun-jobs-s3-driver.md`](bun-cache/bun-jobs-s3-driver.md) — bun-jobs on
    S3: a driver, a blob store, or an archive.
  - [`encryption.md`](bun-cache/encryption.md) — at-rest encryption
    (AES-256-GCM with a key per entry, rotation, key providers, user
    ciphers), keyed hashing of keys, namespaces and tags, and pluggable
    compression (`br`, `deflate`, user compressors) as one chain of
    transforms.
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
    [`encryption/`](bun-cache/evidence/encryption/README.md), on Bun
    1.4.4-canary.1+a0cc096ce: what Bun offers for encryption (`node:crypto`
    has AES-GCM but no ChaCha20-Poly1305; `crypto.subtle` has both),
    **measured** at 100 B to 1 MiB against bun-cache's own encode and zstd
    path; nonce sources (`getRandomValues` 0.04 µs, `randomBytes` 2.8 µs);
    HMAC and HKDF costs; a swap, tamper, tag-strip and replay attack run on
    the real `createCache`; zstd, gzip, deflate and Brotli at four sizes on
    JSON, HTML and incompressible bytes, sync and async.
- **[`bun-security/`](bun-security/README.md)** — `@kingsleyweb/bun-security`
  and its UI as bun-ui's `/security` (approved 2026-11-07, all open questions answered as recommended; the UI's package changed by the user on 2026-11-08, [`bun-ui/`](bun-ui/README.md); its foundations, trustProxy #653 and the throttle #654 to #656, merged; nothing of the package built yet): a
  request-defence engine (lists, bans, counted rules and escalation, request
  shape, safe rules, deception, challenges, sensitive-endpoint profiles, API
  keys, response controls) on the trust-proxy and throttle foundations, a
  control plane for one service, one system or a fleet (signed bundles,
  RBAC, step-up, approvals, a hash-chained audit log), pluggable storage
  drivers, and a management UI with a live, paginated analytics page;
  ConcaveHR's defence mapped onto it.
  - [`layers.md`](bun-security/layers.md) — the layers L1–L14 in request
    order, with defaults, actions and the v1 cut.
  - [`topologies.md`](bun-security/topologies.md) — single service, one
    host, several systems; shared state; failure modes.
  - [`control-plane.md`](bun-security/control-plane.md) — policy model,
    bundles, management API, RBAC, audit, agents, secrets, self-DoS bounds.
  - [`storage.md`](bun-security/storage.md) — the security store's drivers,
    a shared SQL module, schema sync, encryption, conformance.
  - [`ui.md`](bun-security/ui.md) — bun-ui's `/security`, pagination, live
    updates, the analytics page.
  - Evidence: [`bun-security/evidence/`](bun-security/evidence/README.md) —
    on Bun 1.4.4-canary.1+11c367163, behaviour only: what `requestIP()`
    reports (IPv4-mapped addresses on a default listener), how Bun
    normalises request targets on raw sockets and which limits it enforces
    below the handler, a duplicate-`Host` reproduction, and the signing
    primitives (Ed25519, HMAC).
- **[`bun-ui/`](bun-ui/README.md)** — `@kingsleyweb/bun-ui` (approved
  2026-11-08, all open questions answered as recommended; BU-1, BU-2, BU-3 and BU-5
  merged, #666 and #708 to #710, and released in 3.0.0-rc.1; BU-4 may follow
  rc.1): one package for every UI, `/jobs` and
  `/docs` first, then bun-security's `/security`; bun-jobs-ui and
  bun-api-docs-ui moved in with `git mv`, a shared kit (shell, CSP, SRI,
  assets, `unauthorized`, design system, DOM-test harness), domain packages
  as optional peers scoped per entry, bun-common's `"self-hosted"` viewer
  on `/docs/hosted`, the old names deprecated on npm; bun-security's UI
  becomes its `/security` entry (applied to that plan).
  - Evidence: [`bun-ui/evidence/`](bun-ui/evidence/README.md) — on Bun
    1.4.4-canary.1+11c367163, bytes and behaviour only: both bundles built
    and the rc.0 tarballs broken down (one bun-ui ≈ 6.8 MB unpacked, 71%
    source maps); the React lint rules over the docs app (1 error, 2
    warnings); a branch rebased over a pure `git mv` of the package (edits
    follow the files; a new file needs one `git add`).
- **[`api-docs-generation/`](api-docs-generation/README.md)** — auto-generated
  API documentation: OpenAPI 3.1 for the HTTP adapter, AsyncAPI 3.0 for the
  WebSocket adapter. **Complete except the optional (g)** (2026-11-10): #527
  to #542, #629, #632.
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
  NestJS: modules, decorators and the Nest pipeline for jobs. **Complete**
  (2026-11-10): every PR merged, PR-n1 to PR-n9 in 3.0.0-rc.2, with examples in
  `examples/bun-nest/15-jobs/`.
  - Evidence: [`nest-jobs-decorators/evidence/`](nest-jobs-decorators/evidence/README.md) —
    bun-jobs in NestJS through decorators, **measured** on Bun 1.4.3 and Nest
    11.1.27 against a throwaway prototype: the Nest pipeline (guards,
    interceptors, pipes, filters, custom parameter decorators, global
    enhancers) around a job handler through `ExternalContextCreator`; where to
    drain workers on `app.close()`; request-scoped processors per job; the
    per-attempt cost of a Nest context off-thread; what TypeScript catches
    from token to handler; Bun's decorator tsconfig lookup; guards as the
    management API's `authorize`. Re-run 2026-11-08 on Bun 1.4.4-canary,
    Nest 12.2.0 and 11.2.7 (`rerun-2026-11-08/`), with a new spike for the
    refresh: module construction, durable request scope, V6's pipes and Nest
    12's `StandardSchemaValidationPipe` on a job parameter, and hook order
    within one module.
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
