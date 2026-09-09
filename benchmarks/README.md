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

---

# Dispatch-strategy benchmark (`dispatch.ts`)

Where `bench.ts` compares *frameworks*, `dispatch.ts` compares the ways to get
a request to a handler **on Bun itself**, over one identical route set.

```bash
bun dispatch.ts --verify        # prove every strategy returns the same thing
bun dispatch.ts                 # end-to-end req/s (autocannon)
bun dispatch.ts --micro         # routing-decision cost only, no sockets
bun dispatch.ts --help          # every option
```

## Strategies

| id                   | What it is                                                  |
| -------------------- | ----------------------------------------------------------- |
| `bun-router`         | `BunHttpAdapter`/`BunRouter`, pipeline cache on (default)     |
| `bun-router-nocache` | the same router, cache dropped before every match             |
| `bun-router-methods` | BunRouter with each path registered once per verb (5x routes) |
| `bun-serve-routes`   | `Bun.serve` native `routes`, bare-function form               |
| `bun-serve-methods`  | the same table as `{ GET, POST, PUT, PATCH, DELETE }` objects |
| `fs-router`          | `Bun.FileSystemRouter` ("nextjs") driven from `fetch`         |
| `fetch-manual`       | a hand-written dispatcher inside `fetch`                      |

## Shared route set

Chosen to vary the parameter shape, since that is where the strategies differ
most:

| Route                                     | Parameters             |
| ----------------------------------------- | ---------------------- |
| `/ping`                                   | none (static)          |
| `/user/:id`                               | 1 required             |
| `/api/v1/users/:userId/books/:bookId`     | 2 required (deep)      |
| `/search/:category/:page?`                | 1 required + 1 optional|
| `/assets/*`                               | catch-all              |

The file-based fixtures live in `pages/`; `[[...page]]` is the optional
catch-all. `Bun.serve`'s native table has no optional-parameter syntax, so it
registers `/search/:category` and `/search/:category/:page` separately.

## Scenarios

`static`, `param`, `deep`, `optional-present`, `optional-absent`, `wildcard`,
`notfound`, `cardinality`, `mixed`.

`cardinality` rotates over `--cardinality` (default 5000) distinct
`/user/:id` values — above `routeCacheMax` (2000), BunRouter's per-path
pipeline cache thrashes, which no other scenario exposes.

## Two modes

- **HTTP** (default) — `autocannon` over loopback. Real end-to-end throughput,
  but Bun's HTTP stack and the socket syscalls are a large shared constant that
  compresses the differences between matchers.
- **`--micro`** — in-process, no sockets: times only the routing decision.
  Each strategy runs in a **freshly spawned process** (measuring several in one
  process lets one matcher's shapes make another's call sites polymorphic —
  observed to move figures by 3x) and reports the fastest of `--repeats` passes.
  `bun-serve-routes`/`bun-serve-methods` cannot participate: Bun's native
  matcher is internal and is not callable outside a running server.

## Caveats

- `--verify` is the guard against a strategy that looks fast because it is
  answering the wrong thing. Run it after any edit.
- In `--micro`, `fetch-manual` on the `static` scenario is an optimistic
  outlier: the match result never escapes, so JavaScriptCore sinks the
  allocation entirely. Trust the HTTP table for that comparison.
- `bun-router*` is measured with body/cookie/query parsing disabled, so the
  figure reflects routing rather than request pre-processing.
