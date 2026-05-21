# Router benchmarks

Throughput comparison of **BunRouter** (`@kingsleyweb/bun-common`) against
**Express 5**, **Bun.serve** native routes, **Elysia** and **Hono**.

## Setup

```bash
cd benchmarks
bun install
```

## Run

```bash
bun bench.ts                                   # static route, 50 conns, 10s
bun bench.ts --route all --connections 100     # every scenario, heavier load
bun bench.ts -r param,deep -f bun-router,hono  # focused comparison
bun bench.ts -r mixed -c 200 -p 8 --workers 4  # pipelined, multi-worker load
bun bench.ts --route all --json > results.json # machine-readable output
```

`bun bench.ts --help` lists every option.

## What it measures

Each framework registers the **same** routes and returns the **same** tiny
payloads, so the figure reflects routing — dispatch, param extraction and the
middleware chain — not serialization.

| Scenario     | Exercises                                              |
| ------------ | ------------------------------------------------------ |
| `static`     | plain dispatch (`GET /ping`)                           |
| `param`      | one path parameter (`GET /user/:id`)                   |
| `deep`       | nested multi-parameter path                            |
| `wildcard`   | wildcard / catch-all matching                          |
| `middleware` | a chain of N pass-through middlewares (`--middleware-count`) |
| `notfound`   | the unmatched-route / 404 path                         |
| `mixed`      | all of the above paths, rotated                        |

`autocannon` generates the load. The `notfound` scenario reports `non-2xx`
responses by design (every response is a 404).

## Caveats

- The load generator and the server share one machine. Pass `--workers N` to
  move load generation onto worker threads, freeing the event loop for the
  server. Absolute numbers are environment-specific; the **relative** ranking
  is the point.
- `BunRouter` is benchmarked through `BunHttpAdapter` with body/cookie/query
  parsing disabled, so the figure reflects routing rather than request
  pre-processing.
- `Bun.serve` native routes have no per-route middleware, so the `middleware`
  scenario is a plain route for that entry.
