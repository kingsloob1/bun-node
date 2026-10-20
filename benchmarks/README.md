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
remember to read. Routing speed must stay the same or improve (the user's
rule, 2026-10-17), and two checks hold it to that:

- **The PR gate is the A/B against the PR's base** (`--roots base=…,pr=…`):
  both checkouts measured in one session, every cell alternating between
  them, judged at **5%**. See **The PR gate** below.
- **`--compare` is the cross-day sanity check**: one checkout against
  `baselines/router.json`, a run recorded on another day, judged at **15%**
  net of the machine's drift.

It is the router's counterpart of bun-jobs' guard (`packages/bun-jobs/bench`,
CLAUDE.md "Benchmark regression guard").

```bash
bun router-guard.ts --verify            # every scenario answers right; times nothing
bun router-guard.ts --roots base=../../wt-base,pr=../../wt-pr   # the PR gate: exit 1 regressed, 3 options changed
bun router-guard.ts --compare           # the cross-day check against the baseline; exit 1 / 3 the same
bun router-guard.ts --save-baseline     # re-record, after a deliberate change
bun router-guard.ts --help              # every option and scenario
```

It is a heavy run (about 16 minutes for every cell, under half an hour for an
A/B): run it through the heavy-run wrapper as exclusive, in the background,
never polled:

```bash
HEAVY_EXCLUSIVE=1 HEAVY_TICKET=<session>-router-guard \
  /tmp/claude-1000/bun-node-heavy-run.sh nice -n 10 timeout 2400 \
  bun router-guard.ts --roots base=<base worktree>,pr=<PR worktree> --max-wait 60 \
  --json ~/.cache/<session>/router-ab.json > ~/.cache/<session>/router-ab.log 2>&1
```

**What it times.** Four levels, each judged against its own baseline cells,
so a change to one stage lands on its own cells: a change to `fetch()`'s
entry (rebuilding the caller's `Request`, say) moves `fetch` and leaves
`route` and `match` alone, and a routing change moves `match` or `route`
first.

| Level | Timed | Targets |
|---|---|---|
| `match` | `getMatchedLayers()` alone: the matcher, where a 2x matching regression is not diluted by the wrappers around it | bun-common |
| `route` | the route walk: `router.dispatch()` on pipeline options over a `BunRequest` and `BunResponse` built (1,024 at a time) before the clock starts, as `serveNativeRequest` builds them. Matching, every layer, the handler's `res.send`; not `fetch()`'s entry, not the `Response` | bun-common, bun-nest |
| `fetch` | `adapter.fetch(new Request(url))`, socket-free: the same `handleNativeRequest` `Bun.serve` calls, plus `fetch()`'s entry and the `Response` | all three |
| `served` | a real `Bun.serve` on port 0, closed with `stop(true)`: a `fetch()` round trip over loopback, one at a time (`static`, `param`, `notfound` only) | all three |

The targets, each with 1,000 `/r<i>/:id` routes registered beside the
scenario routes: `bun-common` (its `BunHttpAdapter`, body/cookie/query
parsing off), `bun-nest` (a Nest app on bun-nest's adapter, `app.init()`,
listening only for `served`), and `hono` (`app.fetch` on the same routes,
the rival each bun-common figure records).

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
| `routes-1000-specificity` | `routes-1000` with `routeSpecificity: true`, which re-orders the matched layers (bun-common, bun-nest) |
| `head` | `HEAD /user/42`, answered by the GET route (the HEAD branch of `matchRoute`) |
| `host` | `acme.example.com/tenant/users/7` on `domain(":tenant.example.com")` (Nest: `@Controller({ host })` with `@HostParam`) |
| `validate` | `/validated/42` behind `validate({ params })` with a hand-written Standard Schema (bun-common) |

A scenario that changes the router as a whole is built only in its own
process: a host-scoped route puts the host into every cache key, and route
specificity re-orders every pipeline, so neither may reach another cell.
At the `route` level a 404 is the walk alone: the not-found handlers run
after it, in the adapter, so they are timed at `fetch` and `served`.

**Router options** are recorded per target in the baseline
(`routerOptions`): the route cache's size (`routeCacheMax`, 50,000),
`caseSensitive` (`true`, the adapters' default) and `routeSpecificity`; a
cell that ran with other options (`routes-1000-specificity`) records its own.
`--compare` checks them too: see **options changed** below.

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

**`--compare`'s tolerance is 15%** (`TOLERANCE`), calibrated, not chosen. One unchanged
build, three full runs on the i9-11900H (16 threads) that recorded the
baseline (92 cells, load 2.5-4), spread of each cell's figure across the
three, before any drift correction:

| Level | Cells | Median | 90th percentile | Worst |
|---|---:|---:|---:|---:|
| `match` | 15 | 2.6% | 4.9% | 5.3% (`head`) |
| `route` | 28 | 2.3% | 6.3% | 7.7% (`bun-common/route/wildcard`) |
| `fetch` | 40 | 2.2% | 7.0% | 8.6% (`bun-common/fetch/wildcard`) |
| `served` | 9 | 3.3% | 5.3% | 5.3% (`bun-common/served/param`) |

15% sits clear of the worst on every level (the first version, `fetch` and
`match` only, measured 8.4% worst over 43 cells). It is far tighter than
bun-jobs' 35% because nothing here crosses a process boundary or touches a
database. What it is for is a factor: the controls below.

**Machine drift.** Hono's code never changes here (this directory's lockfile
pins it), so its cells measure the machine. Their median now/was is the
run's drift, per level: `fetch` and `served` take it from Hono's cells at
their own level, and `match` and `route`, where Hono has no cell, from all of
them. Our cells are judged net of their level's drift, and Hono's cells are
never failed themselves. Measured: a run at a load of about 4, against a baseline
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

**Options changed.** A cell whose router options (its own, else its
target's) differ from the baseline's measures another configuration, so it is
neither passed nor failed. The comparison prints, per target, every differing
key and how many cells it covers, then each such cell with its figures and
`not judged`, and marks its row in the table `options changed`:

```text
  OPTS  bun-common: router options differ from the baseline: caseSensitive true → false (48 cells)
  OPTS  bun-common/fetch/static                    options changed  1595ns  ->  1617ns (+1.3%, +0.9% net of drift); not judged
  ...
verdict: options changed (exit 3). 48 cell(s) ran with other router options than the baseline, ...
```

When nothing else regressed, the run ends with that verdict line and **exits
3** (`EXIT_OPTIONS_CHANGED`), not 0: a PR that changes a default (say
`caseSensitive` to `false`) is due a `--save-baseline` in the same PR, not a
fix, and a pass would leave those cells unjudged against a stale baseline from
then on. A real regression in any other cell still exits 1, and its summary
says how many cells went unjudged. The cells whose options match are judged
as before, and a file that recorded no options (Hono's cells, a run from
before them) is compared on figures alone. Exit 2 stays a usage error.

An improvement never fails it, and a new scenario fails nothing until a
baseline records it. A baseline holds only on the machine that recorded it:
`baselines/router.json` names the CPU, the Bun version and revision, the git
SHA and the Nest version. On other hardware, re-record rather than chase it.

**The committed baseline** was recorded on Bun **1.4.4-canary.1+6bb5dc195**
(develop 7241eeea, 2026-10-20), when the machine moved there from
+5f5799ed1. Every 1.4.4 canary reports `Bun.version` "1.4.4", so the file's
`bunRevision` is what tells them apart; after a Bun upgrade, re-record. A
canary can move a cell: `bun-common/match/notfound` is bimodal per process,
about 31 ns or about 39 ns. On +5f5799ed1 nearly every process took the fast
mode (the earlier baseline: 30.7-32.5 ns); on +6bb5dc195, 2 rounds in 50.
A best of 5 rounds that catches the fast mode makes a baseline that every
later run of the build fails on that cell (+22%), and one recorded in a busy
stretch fails them on drift. Both `--save-baseline` runs on +6bb5dc195 were
unusable, one each way. The baseline committed is a full run of the same
commit and build, recorded as the base side of a same-build A/B; all seven
other same-build runs pass `--compare` against it. So before committing a
re-recorded baseline, judge other runs of the same build against it, each
saved with `--json`: `bun router-guard.ts --from <run.json> --compare
--baseline <new file>` must exit 0 for every one.

**Could `--compare` be tighter?** Not on this data. Same build, growth net of
drift: three runs one evening (+5f5799ed1) reached +6.8%; seven runs over
four hours (+6bb5dc195) against the committed baseline reached `match`
+11.5%, `route` +10.9%, `fetch` +8.4%, `served` +3.4%; and the same bun-nest
code measured two days apart (bun-nest only, so no rival to correct by)
moved up to +12.0%. 15% stays. `--compare` spans days and machines; the A/B,
both sides in one session, is what can be tight.

**Controls**, measured 2026-10-17/18 against the baseline committed then
(Bun +5f5799ed1), each in
a scratch copy of bun-common with the slowdown at the top of
`getMatchedLayers()` (so inside `dispatch()`, and under every level):

| Change | Result |
|---|---|
| none (the same build, two more runs) | **passes** both: drift at most 2.4% on any level, ours at most +4.8% raw |
| none, on a busy machine (load 42 at the start; first version) | **refuses to judge**: drift +16.3% fails the run as `drift`, and no cell of ours is blamed |
| a `new RegExp` compiled per request | **fails** all 48 bun-common cells: `match` 30-90 ns to 3.0-3.6 µs, `route` +356% to +5,995%, `fetch` +160% to +301%, `served` +19% to +22% |
| a 1,200 ns spin per request (about 2x on `fetch`) | **fails** all 45 `match`, `route` and `fetch` cells (`route` +129% to +2,318%, `fetch` +50% to +107%); the 3 `served` cells pass at +2% to +7% |
| a 250 ns spin (it measured about +300 ns) | **fails** all 15 `match` and all 15 `route` cells (+30% to +553%) and 12 of 15 `fetch` cells (+15% to +27%); `fetch` on the two cold rotations and `head` pass at +7% to +11% |

The last row is why the `route` level exists: a third of a microsecond is
about where 15% sits on a whole `fetch()` (1.2-2.6 µs), so a routing change
of that size can pass there, while the walk alone (0.05-1 µs) shows it as a
factor. The `served` cells are the opposite: a loopback round trip is about
31 µs, so 15% there is ~4.7 µs, and they exist to catch a change to the
socket path (`Bun.serve`'s entry, the `Response` on the wire), not to resolve
routing.

**The PR gate: the A/B against the PR's base.** A PR that touches the
request path (bun-common, bun-nest) runs an A/B of the commit it targets and
its branch: a detached worktree of the base (`git worktree add --detach
<dir> origin/develop`, then `bun install --frozen-lockfile` in it) and the
PR's worktree, **base first** (`--roots base=<dir>,pr=<dir>`, the command
above). Both are measured in one session, every cell alternating between them
(A B, then B A), so the comparison needs no baseline and the machine's drift
lands on both sides. The first root is the base, printed as `base <label>`;
every other root is a side judged against it.

Each cell gives two estimates of a side's change: **best**, its best of the
rounds against the base's, and **paired**, the median over the rounds of each
round's side / base ratio (round *r* of the two sides ran seconds apart, so
drift cancels in the ratio). A cell fails as **slower** only when **both**
grew past **5%** (`AB_TOLERANCE`, per level; 5% on all four): noise moves one
of them at a time (a lucky best, a busy round), and a change in the code moves
both. The table shows both columns and flags the failing cells. The run also
fails on a **missing** cell (the base has it, the side does not) and on
**noise**: Hono's code is the same on both sides, so its cells are an A = A
pair inside every A/B, and one that moved past 5% either way means the
session was too noisy to judge (the A/B's counterpart of `--compare`'s
**drift**). A cell whose router options differ between the sides is not
judged. Exit codes match `--compare`'s:

| Exit | Verdict |
|---|---|
| 0 | `verdict: pass`: no cell of ours grew past 5% |
| 1 | `verdict: regression`: a cell **slower**, **missing** or **noise**, or a problem (a wrong answer; a child that ran on another Bun build than the parent, e.g. Bun upgraded mid-run) |
| 3 | `verdict: options changed`: nothing regressed, but some cells ran with other router options than the base (`routerOptions`, as above) and were not judged |
| 2 | a usage error |

**How 5% was set.** Three same-build A/Bs, the same develop checkout
(7241eeea) given as both roots, every target, 5 rounds, exclusive, Bun
1.4.4-canary.1+6bb5dc195, loads 3.4-5.3. Worst cell per run, in the figure
judged (the smaller of the two estimates when both grew):

| Run | Worst cell of ours | Hono's worst (either way) | Verdict |
|---|---|---:|---|
| 1 | +4.0% `bun-common/fetch/param-cold` | 2.4% | pass |
| 2 | +2.9% `bun-common/match/mounted` | 0.8% | pass |
| 3 | +3.1% `bun-common/route/mounted` | 1.9% | pass |

Per level over the three (276 cells), worst slower / faster: `match`
+2.9% / -3.0%, `route` +3.1% / -4.7%, `fetch` +4.0% / -2.8%, `served`
+1.9% / -1.2%. The levels are close enough for one figure; `served` is the
quietest, but its 30-40 µs round trip shows a routing change least anyway.
Either estimate alone is wider: `paired` up to +6.1% on a cell whose `best`
moved -0.7% (`bun-common/route/routes-1000-cold`), and `best` once -19% from
a single fast round of `bun-common/match/notfound` (below). A rule on `paired`
alone at 4% failed an A = A run on a Hono cell (+4.1% paired, +0.9% best), and
on both estimates at 4% another A = A run failed at +4.0%: hence 5%, a point
over the worst A = A cell.

**Controls**, measured with the gate as it stands:

| Change | Result |
|---|---|
| none: the three A = A runs above, and one more on Bun 1.4.4-canary.1+5f5799ed1 | **pass** all four (worst +4.0%) |
| the 404 negative control: the bun-nest not-found fast path with PR-2's per-request `split` and `some`/`filter`/`map` put back (base: develop + the fast path; side: the same plus the control) | **fails exactly the three 404 cells** at `fetch`: `notfound` +7.6% (best +7.6%, paired +7.6%), `prefix-notfound-inside` +8.1% (+8.1%, +8.7%), `prefix-notfound-outside` +7.9% (+9.2%, +7.9%); every other cell passes (`served/notfound` +2.3%) |
| the same control's earlier A/B (Bun +5f5799ed1, judged with `--from`) | **fails** the same three: +6.8%, +6.6%, +6.2% |
| a side with `caseSensitive` changed (a saved run, doctored) | **exit 3**: 45 cells not judged, 32 pass; with +8% on one other cell too, **exit 1** |
| Bun replaced mid-run (the parent on one build, the children on another) | **exit 1**, a problem per cell: `ran on Bun 6bb5dc195, but the run started on 5f5799ed1` |

The same 404 control **passes** `--compare`: 6-8% is inside 15%. That is why
the A/B, not `--compare`, is the gate.

A change meant to move a figure says so with the A/B table in its
description, and re-records the baseline (`--save-baseline`) in the same PR;
one that changes router options on purpose gets exit 3 from both checks, and
re-records too. `--from <file>` judges a run saved with `--json` again
without measuring: an A/B file as an A/B (its first root the base), a single
run with `--compare`.

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
