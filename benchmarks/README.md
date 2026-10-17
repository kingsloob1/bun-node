# Router benchmarks

Throughput comparison of **BunRouter** (`@kingsleyweb/bun-common`) against
**Express 5**, **Bun.serve** native routes, **Elysia 1.4**, **Elysia 2** (beta, the `elysia2` alias),
**Hono** and **hyper-express** (uWebSockets.js, in its own process under Node.js
and under Bun — see [`hyper-express/README.md`](hyper-express/README.md); it does
not load under Bun).

## Setup

```bash
cd benchmarks
bun install
(cd hyper-express && npm run setup)   # optional: the hyper-express entries
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

## Router regression guard (`router-guard.ts`)

The routing speed claims are an assertion, not a table someone has to
remember to read: `baselines/router.json` records what each cell measured on
this machine, and `--compare` fails when one regressed. It is the router's
counterpart of bun-jobs' guard (`packages/bun-jobs/bench`, CLAUDE.md
"Benchmark regression guard").

```bash
bun router-guard.ts --verify            # every scenario answers right; times nothing
bun router-guard.ts --compare           # fails (exit 1) if a cell regressed
bun router-guard.ts --save-baseline     # re-record, after a deliberate change
bun router-guard.ts --roots before=../../wt-a,after=../../wt-b   # A/B two checkouts
bun router-guard.ts --help              # every option and scenario
```

It is a heavy run (about 8 minutes for every cell, 16 for an A/B): run it
through the heavy-run wrapper as exclusive, in the background, never polled:

```bash
HEAVY_EXCLUSIVE=1 HEAVY_TICKET=<session>-router-guard \
  /tmp/claude-1000/bun-node-heavy-run.sh nice -n 10 timeout 1800 \
  bun router-guard.ts --compare > ~/.cache/<session>/router-guard.log 2>&1
```

**What it times.** No sockets: `adapter.fetch(new Request(url))` runs the
same `handleNativeRequest` that `Bun.serve` calls, so a cell is the router and
its pipeline (request and response wrappers, matching, the handler, the
`Response`), not the network. Three targets, each with 1,000 `/r<i>/:id`
routes registered beside the scenario routes:

| Target | Level | What |
|---|---|---|
| `bun-common` | `match` | `getMatchedLayers()` alone: the matcher, where a 2x matching regression is not diluted by the ~1.2 µs of wrappers around it |
| `bun-common` | `fetch` | bun-common's `BunHttpAdapter`, body/cookie/query parsing off |
| `bun-nest` | `fetch` | a Nest app (`NestFactory.create`, `app.init()`, no `listen`) on bun-nest's adapter |
| `hono` | `fetch` | Hono's `app.fetch` on the same routes: the rival each bun-common figure records |

| Scenario | Request |
|---|---|
| `static`, `param`, `deep` | `/static`, `/user/42`, `/api/v1/users/7/books/99` |
| `wildcard`, `wildcard-named` | `/assets/css/site/app.css` on `/assets/*` (Nest: `assets/*path`); `/files/a/b/c.txt` on `/files/*path` |
| `routes-1000` | `/r999/42`, the last of the 1,000 routes |
| `routes-1000-cold`, `param-cold` | a fresh id per request over 120,000 ids, above the route cache: every request a cache miss, so the matcher itself runs |
| `notfound` | `/no/such/route/exists`, a 404 |
| `middleware` | `/mw/hit` behind three `/mw` middleware (Nest: `MiddlewareConsumer`) |
| `mounted` | `/api/v2/acme/items/5`, a sub-router mounted at `/api/v2/:org` |
| `prefix-param`, `prefix-notfound-inside`, `prefix-notfound-outside` | Nest only, `setGlobalPrefix("v1")`: `/v1/user/42`, `/v1/no/such`, `/no/such` (the 404s exercise the prefix-scoped not-found handler) |

**Method.** One fresh process per (target, scenario, round), so one
scenario's shapes cannot make another's call sites polymorphic. Rounds are
interleaved (every cell once, then again), and with `--roots` each cell
alternates between the checkouts (A B, then B A), so drift cannot favour one
side. Each process checks its scenario's answer (status and body, at several
ids of a rotation), warms up for 400 ms, then times 9 batches of about 80 ms
and keeps the best. A cell's figure is the **best of its 5 rounds**; its
median and every round are recorded too. Each round first waits (up to 5
minutes) for the 1-minute load to fall under a quarter of the cores, and
records the load it started at.

Best rather than median, because the noise here is one-sided. Measured on one
A/B run whose first rounds started at a load of 16-18: those rounds ran 10-20%
slower than the last two (load 2.6), and the two sides of the A/B agreed
within a few percent only in the quiet rounds. A minimum discounts the busy
minutes; a median keeps half of them.

**The tolerance is 15%** (`TOLERANCE`), calibrated, not chosen. One unchanged
build, three full runs on the i9-11900H (16 threads) that recorded the
baseline, 43 cells each: the worst cell's figure differed by **8.4%** between
runs (`bun-common/fetch/static`), the 90th percentile by 6.9%, the median by
2.4%, before any drift correction. 15% sits clear of the worst. It is far
tighter than bun-jobs' 35% because nothing here crosses a process boundary or
touches a database. What it is for is a factor: the controls below.

**Machine drift.** Hono's code never changes here (this directory's lockfile
pins it), so its cells measure the machine. Their median now/was is the
run's drift, our cells are judged net of it, and Hono's cells are never
failed themselves. Measured: a run at a load of about 4, against a baseline
recorded at 2.5-3, moved every Hono cell by +2% to +24% (median +7.9%), and
before this correction failed Hono's own `routes-1000` at +24%. A drift past
the tolerance either way fails the run as **drift**: the machine was too busy
(or too different) to judge. A `--targets bun-nest` run measures no rival
and is judged without a correction.

A comparison fails on:

- **slower**: a cell grew more than 15% past its baseline, net of drift;
- **overtaken**: a bun-common cell that beat Hono in the baseline no longer
  does. This one normalises itself, as a busy machine slows both;
- **missing**: a cell the baseline has, and this run attempted, produced no
  figure (a scenario that stopped answering correctly fails `--verify` the
  same way).

An improvement never fails it, and a new scenario fails nothing until a
baseline records it. A baseline holds only on the machine that recorded it:
`baselines/router.json` names the CPU, the Bun version and revision, the git
SHA and the Nest version. On other hardware, re-record rather than chase it.

**Controls**, measured 2026-10-17 against the committed baseline, each in a
scratch copy of bun-common with the slowdown at the top of
`getMatchedLayers()`:

| Change | Result |
|---|---|
| none (the same build again, two runs) | **passes** both: drift +6.0% and -2.2%, ours at most +1.6% and +7.0% net of it |
| none, on a busy machine (load 42 at the start, about 4 after) | **refuses to judge**: drift +16.3% fails the run as `drift`, and no cell of ours is blamed |
| a `new RegExp` compiled per request | **fails**, 30 regressions: `match` cells 30-40 ns to ~2.9 µs, `fetch` cells +206% to +385% |
| a 1,200 ns spin per request (about 2x) | **fails** all 22 bun-common cells and 2 Hono leads: `fetch` +71% to +151% |
| a 250 ns spin (it measured about +300 ns) | **fails** all 11 `match` cells and 9 of 11 `fetch` cells (+16% to +28% net); `param-cold` and `middleware` pass at +14% net |

The last row is the threshold doing its job: a third of a microsecond on a
~1.2 µs request is about where 15% sits, and the matcher-only cells, where it
is a factor of eight, catch it regardless.

**Checking a change.** For a change to routing, run an A/B of the base and
the branch in two worktrees (`--roots base=<dir>,pr=<dir>`): it alternates
every cell between the two, so it is the sharper comparison, and it needs no
baseline. Then `--compare` on the branch against the committed baseline. A
change that is meant to move a figure re-records the baseline
(`--save-baseline`) in the same PR, with the A/B table in its description.
`--from <file>` judges a run saved with `--json` again, without measuring.

**`--root` and `--roots`.** bun-common, bun-nest and the `@nestjs/*` packages
are loaded from the checkout named, so this one copy of the script measures
any revision (a worktree, a `scripts/nest-matrix.ts` copy for another Nest
major), always with this directory's Hono and `tsconfig.json`. The Nest app
applies its decorators as calls, so it does not depend on the decorator
options Bun reads from the working directory's `tsconfig.json`.

**What it does not do.** It does not measure Bun's HTTP stack or a socket
(`wrk.ts` does), and it does not include body parsing (`wrk.ts`'s body
scenarios do).

## Scenario benchmark with `wrk` (`wrk.ts`)

`bench.ts` drives load from JavaScript in the same process, which caps it
near 70k req/s. `wrk.ts` drives every framework with the native `wrk`, one
fresh server process per (framework, scenario) cell (`scenarios/servers.ts`,
the Nest app in `scenarios/nest-app.ts`), pinned to CPU 0 with `wrk` on the
other cores. It checks each response before timing it, interleaves rounds and
reports medians.

```bash
bun wrk.ts                                        # every target and scenario, 3 rounds
bun wrk.ts --targets bun-common,elysia2 --scenarios json,multipart
bun wrk.ts --rounds 5 --markdown out.md --json out.json
```

| Scenario | Request |
|---|---|
| `static`, `param`, `wildcard` | `GET /static`, `GET /user/42`, `GET /assets/css/app.css` |
| `middleware` | `GET /mw/hit` through three middleware |
| `routes-1000`, `param-random` | `GET /r999/42` among 1,000 param routes; the same with a fresh id per request |
| `async`, `headers` | an `async` handler; three response headers set |
| `json` | `POST /json {"n":7}` |
| `urlencoded` | `POST /form a=1&b=two`, the parsed fields back |
| `multipart` | `POST /upload`, a field and a 1 KiB file |
| `binary` | `POST /binary`, 1 KiB `application/octet-stream`, its size back |
| `text` | `POST /text`, `text/plain`, its length back |
| `xml` | `POST /xml <root><n>7</n></root>`, the parsed value back |

Every framework is measured doing the same work. bun-common and bun-nest run
with `retainBuffer: false` (no other framework keeps a parsed body's bytes)
and multipart's `detectFileType: false` (none sniffs an upload's type), set
once in `scenarios/parse-body.ts`. A framework without a built-in parser for
a kind is listed under **Not measured** with the reason, not given a
third-party one: Express has none for multipart or XML, and only bun-common
and bun-nest parse XML.

Results are in `results/`: `scenarios-wrk.md` for the routing scenarios,
`body-scenarios-wrk.md` for the bodies.

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

## Dispatch-strategy benchmark (`dispatch.ts`)

Where `bench.ts` compares *frameworks*, `dispatch.ts` compares the ways to get
a request to a handler **on Bun itself**, over one identical route set.

```bash
bun dispatch.ts --verify        # prove every strategy returns the same thing
bun dispatch.ts                 # end-to-end req/s (autocannon)
bun dispatch.ts --micro         # routing-decision cost only, no sockets
bun dispatch.ts --help          # every option
```

### Strategies

| id                   | What it is                                                  |
| -------------------- | ----------------------------------------------------------- |
| `bun-router`         | `BunHttpAdapter`/`BunRouter`, pipeline cache on (default)     |
| `bun-router-nocache` | the same router, cache dropped before every match             |
| `bun-router-methods` | BunRouter with each path registered once per verb (5x routes) |
| `bun-serve-routes`   | `Bun.serve` native `routes`, bare-function form               |
| `bun-serve-methods`  | the same table as `{ GET, POST, PUT, PATCH, DELETE }` objects |
| `fs-router`          | `Bun.FileSystemRouter` ("nextjs") driven from `fetch`         |
| `fetch-manual`       | a hand-written dispatcher inside `fetch`                      |

### Shared route set

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

### Scenarios

`static`, `param`, `deep`, `optional-present`, `optional-absent`, `wildcard`,
`notfound`, `cardinality`, `mixed`.

`cardinality` rotates over `--cardinality` (default 5000) distinct
`/user/:id` values — above `routeCacheMax` (2000), BunRouter's per-path
pipeline cache thrashes, which no other scenario exposes.

### Two modes

- **HTTP** (default) — `autocannon` over loopback. Real end-to-end throughput,
  but Bun's HTTP stack and the socket syscalls are a large shared constant that
  compresses the differences between matchers.
- **`--micro`** — in-process, no sockets: times only the routing decision.
  Each strategy runs in a **freshly spawned process** (measuring several in one
  process lets one matcher's shapes make another's call sites polymorphic —
  observed to move figures by 3x) and reports the fastest of `--repeats` passes.
  `bun-serve-routes`/`bun-serve-methods` cannot participate: Bun's native
  matcher is internal and is not callable outside a running server.

### Caveats

- `--verify` is the guard against a strategy that looks fast because it is
  answering the wrong thing. Run it after any edit.
- In `--micro`, `fetch-manual` on the `static` scenario is an optimistic
  outlier: the match result never escapes, so JavaScriptCore sinks the
  allocation entirely. Trust the HTTP table for that comparison.
- `bun-router*` is measured with body/cookie/query parsing disabled, so the
  figure reflects routing rather than request pre-processing.
