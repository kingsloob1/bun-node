# Evidence: Elysia 2's throughput, and what bun-common can take from it

Backs [`../../elysia2-performance.md`](../../elysia2-performance.md). Written
2026-10-03 on Bun 1.4.2 (`744846f8`), a 4-vCPU Xeon @ 2.80 GHz, against
`claude/wizardly-feynman-c72eec` at `ae1a7cc`. Elysia 2.0.0-beta.21 and
1.4.28 are the copies in `benchmarks/node_modules` (`elysia2`, `elysia`).

Everything here runs **in one process**, single-threaded, for a few seconds:
no load generator, no long-running server. `served.ts` is the one exception
to "no socket" — a same-process probe over one connection — and its result
was too noisy to carry a claim (see the plan, §2.4).

## How the measurements pin a commit

The working tree was being edited by another session while these ran, so
every script that loads bun-common or bun-nest takes `PKG_ROOT`: a directory
holding `bun-common/` and `bun-nest/` to load instead of the workspace
copies. The figures in `results/` were taken against a snapshot of `ae1a7cc` (files
named `*-85423c1.txt`: a later snapshot of `85423c1`, after the main
session's `5381f49` and `32ce0f3`) made with

```bash
S=<scratch>/snap
git archive <commit> packages/bun-common packages/bun-nest tsconfig.base.json | tar -x -C $S   # ae1a7cc or 85423c1
mkdir -p $S/node_modules/@kingsleyweb
for e in node_modules/*; do [ "$(basename $e)" = @kingsleyweb ] || ln -s "$PWD/$e" $S/node_modules/; done
ln -s $S/packages/bun-common $S/node_modules/@kingsleyweb/bun-common
ln -s $S/packages/bun-nest   $S/node_modules/@kingsleyweb/bun-nest
```

and run as `NODE_ENV=production BUN_OPTIONS= PKG_ROOT=$S/node_modules/@kingsleyweb bun <script>`.
`NODE_ENV=production` is what `wrk-run.ts` gives the servers (Elysia compiles
routes lazily and releases its JIT state only in production). `BUN_OPTIONS=`
clears the `--smol` this environment's shell exports; `results/smol.txt`
shows it makes no difference in process.

## Files

| File | What it measures | Output |
|---|---|---|
| `targets.ts` | The shared route set of `../bun-native-routes/bench/servers.ts`, built in process for `raw`, `elysia2`, `elysia1`, `bun-common` (+ `-lean`, `-nocache`), `bun-nest` (+ `-nobp`, Nest's `bodyParser: false`) | — |
| `nest-app.ts` | A copy of the bench's Nest app that takes the adapter instance and does not listen | — |
| `inproc.ts` | Each target's `fetch` per scenario, ns/request; `POLLUTE=<bytes>` walks a buffer between requests to evict caches | `results/inproc.txt`, `results/inproc-pollute.txt`, `results/smol.txt` |
| `inproc-matrix.ts` | `inproc.ts` one process per cell, 3 interleaved rounds, median | `results/inproc-matrix.txt`, `results/inproc-variants.txt`; at `85423c1`: `results/inproc-matrix-85423c1.txt` |
| `breakdown.ts` | Cumulative stages of one `GET /user/42`, Elysia 2 (replayed from its source) beside bun-common (the adapter's own calls) | `results/breakdown.txt` |
| `emitted.ts` | The source Elysia 2's JIT emits for each benchmark route (its `setOnEmit` test hook) | `results/emitted.txt` |
| `micro.ts` | Isolated costs: per-request objects, URL, lookup, response, pipeline, async, JSON body | `results/micro.txt` |
| `micro2.ts` | Prototypes beside today's code: header storage, 404/error, a sync fast loop, an async-wait shape, cache admission | `results/micro2.txt`, `results/micro2-admission.txt`; group K at `85423c1`: `results/micro2-wait-85423c1.txt` |
| `miss-breakdown.ts` | An uncached route lookup, piece by piece | `results/miss-breakdown.txt` |
| `nest-breakdown.ts` | A bun-nest request: adapter, router dispatch, Nest's own callback | `results/nest-breakdown.txt`; at `85423c1`: `results/nest-breakdown-85423c1.txt` |
| `first-access.ts` | First read of each native `Request` property | `results/first-access.txt` |
| `sizes.ts` | Shallow size and field count of the per-request objects | `results/sizes.txt` |
| `profile.ts` | A loop for `bun --cpu-prof-md` | `results/prof/inproc-*.md` |
| `served.ts` | Same-process served probe (one pipelined connection) — inconclusive, kept as the record | `results/served-static.txt`, `results/prof/served-*.md` |

A conclusion here is as old as the file. Re-run before relying on it.
