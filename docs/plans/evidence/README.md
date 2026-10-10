# Plan evidence

The measurements, probes and source surveys the plan documents in
`docs/plans/` rest on. They are kept because a plan that says "measured" is
only worth as much as the ability to re-run the measurement — and because
several conclusions here were **reversed** once someone re-read the source,
which is the strongest argument for keeping the workings rather than the
summary.

Nothing here is part of any published package. No `tsconfig.json` in this tree
is in `scripts/typecheck.ts`'s `PROJECTS` list, and no directory is in the root
`workspaces`, so none of it is built, typechecked or linted by the repo's own
tooling. That is deliberate: the spikes contain **intentional type errors**.

| Directory | Backs | What it is |
|---|---|---|
| `opentelemetry/` | `../opentelemetry.md` | A standalone Bun project measuring OTel span cost and Bun's `AsyncLocalStorage` behaviour |
| `api-docs/` | `../api-docs-generation.md` | TypeScript spikes for response contracts, decorators and inference |
| `worker-runtimes/` | `../worker-runtimes.md` | A 14-system prior-art survey read from pinned primary sources |
| `summon-compute/` | `../summon-compute.md`, `../compute-provider-plugins.md` | Three platform surveys (AWS; Google and Azure; PaaS, SSH and Kubernetes) for starting compute on demand, including a SigV4 signer checked against test vectors and a token helper not yet run against real endpoints. Indexed in its own `README.md` |
| `remote-transports/` | `../remote-transports.md`, `../worker-runtimes.md` §5 | What Bun provides per network transport, **measured** by 27 re-runnable spikes (loopback, canary build), and which of ~35 platform shapes accept which transport. Indexed in its own `README.md` |
| `bun-native-routes/` | `../bun-native-routes.md` | What `Bun.serve({ routes })` and `server.reload()` do on the canary build, **measured** by spikes; the router benchmark (bun-common, bun-nest, Elysia, raw Bun) run with `oha`; two routing prototypes (native partition, JS candidate index) with a differential fuzz and a harness that runs the packages' own suites against them; minimal Bun reproductions; and, in `sse/`, server-sent events through both adapters (NestJS `@Sse()`, `idleTimeout`, errors after headers, backpressure, a fan-out benchmark) with a prototype of the proposed helpers. Indexed in the plan's §15 and §16.13 |
| `worker-gateway-and-isolation/` | `../worker-gateway-and-isolation.md` | A throwaway gateway on the real `BunQueueWorker` benchmarked direct, over reversed WebSocket and HTTP long-poll, and as a raw pull proxy on memory, Redis and Postgres; a protocol matrix of Bun 1.4.3 as client and server; Docker, bubblewrap and Bun-level limits **measured** against a hostile job, cold start, warm and single-use pools; a 17-platform survey of nested isolation. Indexed in its own `README.md` |
| `summon-multi-queue/` | `../summon-multi-queue.md` | Two spikes on all eight backends (Bun 1.4.3): where a summon group's shared state can live (a pseudo-queue's state is listed as a queue on file and memory only), compare-and-set contention on one shared entry against one per queue, and the boot cost and RSS of one unit with N workers against N units. Indexed in its own `README.md` |
| `phase2-slicing/` | `../worker-runtimes.md` §11 (Phase 2 as PRs) | Four spikes on the canary build that de-risk the Phase 2 PR slicing: the per-frame MAC's cost through `crypto.subtle` and `node:crypto` (sequential, concurrent, CPU against wall time), the SSE buffering probe through streaming and buffering Bun proxies, and WebSocket backpressure with protocol-sized frames in both directions. Indexed in its own `README.md` |
| `elysia2/` | `../elysia2-performance.md` | Elysia 2 (2.0.0-beta.21) read end to end and measured **in process** beside bun-common and bun-nest at `ae1a7cc` (a pinned snapshot, via `PKG_ROOT`): whole requests per scenario, a stage breakdown, Elysia's emitted route code, isolated technique costs, prototypes of the proposed changes (sync fast loop, single async wait, cache admission), a bun-nest breakdown, CPU profiles. No load generator. Indexed in its own `README.md` |
| `nest-jobs-decorators/` | `../nest-jobs-decorators.md` | bun-jobs in NestJS through decorators, **measured** on Bun 1.4.3 and Nest 11.1.27 against a throwaway prototype: the Nest pipeline (guards, interceptors, pipes, filters, custom parameter decorators, global enhancers) around a job handler through `ExternalContextCreator`; where to drain workers on `app.close()`; request-scoped processors per job; the per-attempt cost of a Nest context off-thread; what TypeScript catches from token to handler; Bun's decorator tsconfig lookup; guards as the management API's `authorize`. Indexed in its own `README.md` |
| `trailing-scenarios/` | `../research-trailing-scenarios.md` | Why json, async, param-random, headers and wildcard trailed Elysia 2, then the body-parsing work: in-process A/B and stage scripts, CPU-profile summarisers, multipart stage costs, `file-type` costs, Bun `formData()` against busboy (speed and 20 behaviour probes), urlencoded parser comparison. Indexed in its own `README.md` |
| `bun-views/` | `../bun-views.md` | A standalone Bun project (React 19.3, Express 5.3, Vue 3.5, Svelte 5.57, Preact 11, Solid 1.9, installed there only) **measuring** server rendering on Bun 1.4.3: for React, `renderToString` against streaming against buffered and `prerender`, React 19 server behaviour, SSR through bun-common's adapter over a socket (TTFB, HEAD, errors after the headers, and a `compression()` stall on streamed bodies with its controls), throughput against Express on Node and on Bun, loading `.tsx` views by path and reloading them, the Express engine contract on real Express, hydration in Chrome under a nonce CSP with SRI, and a type-level spike for typed props; then a framework-agnostic core and five adapters (React, Vue, Svelte, Preact, Solid) through it: rendering, streaming, async data, errors, compile steps against the existing Bun plugins, client bundles, hydration in Chrome, and props typing per framework. Indexed in its own `README.md` (was `react-views/`) |

## Provenance, and why it is marked

Every factual row in the survey, and every number in the OTel plan, is tagged
as **measured here**, **read from a primary source at a pinned version**, or
**unverified**. Treat that marking as load-bearing. Three claims in the
worker-runtimes plan were withdrawn or re-attributed after a second reading,
and in each case the failure was the same shape: a plausible inference from a
secondary source that nobody had checked against the code it described.

A conclusion in these files is as old as the file. Re-run before relying.
