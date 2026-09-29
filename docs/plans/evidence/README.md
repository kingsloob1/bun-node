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
| `bun-native-routes/` | `../bun-native-routes.md` | What `Bun.serve({ routes })` and `server.reload()` do on the canary build, **measured** by spikes; the router benchmark (bun-common, bun-nest, Elysia, raw Bun) run with `oha`; two routing prototypes (native partition, JS candidate index) with a differential fuzz and a harness that runs the packages' own suites against them; minimal Bun reproductions. Indexed in the plan's §15 |
| `worker-gateway-and-isolation/` | `../worker-gateway-and-isolation.md` | A throwaway gateway on the real `BunQueueWorker` benchmarked direct, over reversed WebSocket and HTTP long-poll, and as a raw pull proxy on memory, Redis and Postgres; a protocol matrix of Bun 1.4.3 as client and server; Docker, bubblewrap and Bun-level limits **measured** against a hostile job, cold start, warm and single-use pools; a 17-platform survey of nested isolation. Indexed in its own `README.md` |

## Provenance, and why it is marked

Every factual row in the survey, and every number in the OTel plan, is tagged
as **measured here**, **read from a primary source at a pinned version**, or
**unverified**. Treat that marking as load-bearing. Three claims in the
worker-runtimes plan were withdrawn or re-attributed after a second reading,
and in each case the failure was the same shape: a plausible inference from a
secondary source that nobody had checked against the code it described.

A conclusion in these files is as old as the file. Re-run before relying.
