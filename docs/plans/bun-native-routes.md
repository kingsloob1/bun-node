# Bun native routes: should Bun's router route for bun-common and bun-nest?

This plan asks whether **`Bun.serve({ routes })`** should do the routing, and
run the route handlers, for bun-common's `BunHttpAdapter` and bun-nest's
`BunHttpAdapter`. The goal is speed: to compete with Elysia and similar
frameworks on Bun. It explores every approach that looked viable, measures each
one, and recommends one — which turned out not to be native routing.

Written 2026-09-28 against `develop` at `bc00d7e`, on Bun
`1.4.3-canary.1+5f554969b`. **No library code was changed.** All the evidence is
under [`evidence/bun-native-routes/`](evidence/bun-native-routes/): spikes,
benchmarks, a working prototype of each routing design, the test harness that
ran the packages' own suites against them, and the raw results.

**The answer is no, not on this Bun.** Native routing can be made to match
Express 5 semantics exactly: the prototype's differential test found no
mismatch in 16,000 requests, and both packages' own suites pass on it. But it
does not make anything faster. Bun takes the same time to hand a request to a
route handler as to `fetch` (§4.1). The things that are slow today are inside
our code: a route-cache miss (two separate O(n) costs, both fixable in
JavaScript and both fixed in a prototype), and request parsing. An honest
go/no-go threshold is written down for the day Bun's own numbers change.

### Contents

1. [Executive summary](#1-executive-summary)
2. [Where a request's time goes today](#2-where-a-requests-time-goes-today)
3. [What Bun's native router is](#3-what-buns-native-router-is)
4. [The approaches](#4-the-approaches)
5. [The approaches compared](#5-the-approaches-compared)
6. [Semantics preservation](#6-semantics-preservation)
7. [bun-common specifics](#7-bun-common-specifics)
8. [bun-nest specifics](#8-bun-nest-specifics)
9. [Benchmark results](#9-benchmark-results)
10. [Feasibility](#10-feasibility)
11. [Rollout and phased delivery](#11-rollout-and-phased-delivery)
12. [Typed overloads, `fetch()` parity and the tests](#12-typed-overloads-fetch-parity-and-the-tests)
13. [Risks and open questions](#13-risks-and-open-questions)
14. [Bun behaviour worth reporting upstream](#14-bun-behaviour-worth-reporting-upstream)
15. [Evidence index](#15-evidence-index)

### How to read the markings

| Tag | Meaning |
|---|---|
| **[M]** | Measured on this machine, on this Bun, by a file in the evidence folder. The file is named, and its output is in `results/`. |
| **[T]** | Tested: a test ran and passed (or failed, where that was the point), with a negative control where one was possible. |
| **[S]** | Read from this repository's source at `bc00d7e`. |
| **[B]** | Read from Bun's or Elysia's source or docs at a pinned commit. Carried from [`survey.md`](evidence/bun-native-routes/survey.md), which cites each one. |
| **[I]** | Inference: reasoning from the facts above. It is not a finding. |
| **[U]** | Unverified. Nothing may rest on it without a check. |
| **[D]** | A design proposal of this plan. |

**The rule the recommendation follows:** every step of the recommended path is
[M] or [T]. Anything [B], [I] or [U] is labelled as such and carries no step on
its own.

---

## 1. Executive summary

### The one-paragraph version

Bun's route table dispatches a request **no faster than `fetch`** on this Bun.
That holds for a trivial handler and for our full pipeline, within the noise
(§4.1, [M]). So moving routing into Bun can only win where our own route lookup
is slow. The lookup is slow in exactly one case: the route cache misses. With
1,000 routes and a fresh id per request, bun-common serves **7,800 req/s**
instead of 48,500 [M]. A miss costs ~90 µs in process, and it is two O(n)
costs: the scan of every route (~60 µs), and, once the cache is full, its FIFO
eviction, `cache.keys().next()` on a `Map` that walks every slot deleted so far
(~18 µs at the 50,000 cap, in JavaScriptCore and V8 alike) [M]. A ~150-line
JavaScript **candidate index** (consulted only on a miss) plus a **ring-buffer
FIFO** (the same eviction policy, in O(1)) bring a miss to **~1.7 µs** [M] and
param-random to 40.0k req/s [M], with none of native routing's costs: no
raw-path guard, no `server.reload()`, no quadratic table build, and `fetch()`
stays the same code path. The biggest cost of all is not routing either.
Parsing a bodiless GET's (empty) body, query and cookies through promises
costs **~2.7 µs of a ~5.1 µs** in-process request [M]; turned off, bun-common
goes from 48k to 80k req/s [M]. **Recommended: do not route natively. Ship the
candidate index and the O(1) cache eviction first (PR-1), then a request parse
fast path (PR-2), then an opt-in static-response route (PR-3).** Keep the
native-routes prototype and its differential harness as the re-test kit, with
a written go/no-go threshold (§10.5).

### Headline numbers

`oha`, 64 connections, 8 s after a 2 s warm-up, median of 3 interleaved rounds,
one server process per cell, i9-11900H (16 threads), Bun 1.4.3-canary.1
(§9 has the method and every cell).

| req/s (median) | static | param | 3 middleware | 1,000 routes | 1,000 routes, fresh id per request | JSON POST |
|---|---:|---:|---:|---:|---:|---:|
| raw `Bun.serve` routes | 124,218 | 122,607 | 127,449 | 79,165 | 81,031 | 84,548 |
| Elysia 1.4.28 | 97,170 | 79,757 | 69,341 | 62,148 | 63,259 | 76,898 |
| **bun-common today** | 49,957 | 48,549 | 48,189 | 48,541 | **7,803** | 44,824 |
| bun-common, native partition prototype | 42,948 | 38,741 | 40,967 | 33,773 | 33,542 | 44,103 |
| **bun-common, PR-1 prototype** (index + ring FIFO)¹ | 49,542 | 49,038 | 49,620 | 48,923 | **39,955** | 44,856 |
| bun-common, PR-1 + PR-2 upper bound¹ | 79,032 | 80,460 | 78,747 | 80,667 | 56,783 | — |
| bun-nest today | 40,489 | 38,530 | 37,785 | 38,678 | 6,777 | 36,354 |
| bun-nest, PR-1 prototype¹ | 41,462 | 38,113 | 38,556 | 37,910 | 31,656 | 35,273 |

¹ From the second run (`results/bench-index-rc.json`), whose stock bun-common
row is 49,272 / 49,829 / 49,594 / 49,429 / 7,772 / 45,133; the others from
`results/bench-full.json`. "Upper bound" = parsing switched off, which skips
more than PR-2 would.

### The decisions it rests on

| # | Decision | Why |
|---|---|---|
| 1 | **Do not make Bun's router the dispatch path, on this Bun.** | Bun dispatches to a route handler no faster than to `fetch`: 127k vs 121k req/s with a trivial handler, and 79k vs 76–79k through our lean pipeline (`spikes/dispatch-only.ts`) [M]. The exact prototype was slower than today on cached paths [M] (§9). |
| 2 | **Fix the one slow routing case, the cache miss, in JavaScript.** | A miss scans all N routes, then evicts in O(deletions). Bucketing routes by first segment makes the scan O(bucket); a ring buffer of keys makes eviction O(1) with the same FIFO policy. Exact (16,000-request differential, 0 mismatches, negative control 2,222; both suites unchanged, including the FIFO-eviction tests) [T]; param-random 7.8k → 40.0k req/s [M]. |
| 3 | **Make the request parse fast path the second PR, not an afterthought.** | It is the largest single cost: 3.3 µs for `BunRequest.init` with defaults against 0.57 µs with parsing off (in process) [M]; end to end, 48k → 80k req/s [M]. Its semantics need a spike first (§4.7). |
| 4 | **Offer native static responses only as an explicit opt-in.** | A static `Response` route is the one thing Bun does much faster (~150k req/s [M]). But it answers every method and runs no middleware [B][M], so it cannot be inferred from a handler. |
| 5 | **Keep the native-routes prototype, and write the threshold that would reopen it.** | It works and is exact. What it lacks is a reason. §10.5 states what a future Bun must show. |

### What this plan is not

- **Not a claim that native routing cannot be exact.** It can. §4.2 and §6
  show how, and the prototype passes both packages' suites and the
  differential fuzz [T].
- **Not a rewrite of the router.** Every recommended change keeps
  `getMatchedLayers()`/`handle()` as the one place Express semantics live.
- **Not the whole gap to Elysia.** After PR-1 and PR-2, bun-common's lean
  figure is still below Elysia on the static route (§9.3). Closing the rest is
  pipeline work (§4.5), sized in §11 as a later, measured phase.

---

## 2. Where a request's time goes today

`bench/breakdown.ts` times each stage of `handleNativeRequest` for
`GET /user/42` in process: no sockets, 200k iterations, best of 5 [M]
(`results/breakdown.txt`).

| Stage (cumulative) | ns per request |
|---|---:|
| `new Request(url)` (the floor, not ours) | 206 |
| `BunRequest.init`, adapter defaults (body, query, cookies parsed) | 3,279 |
| `BunRequest.init`, body parse off, query and cookies on | 1,755 |
| `BunRequest.init`, all parsing off | 570 |
| + `new BunResponse` | 729 |
| + `getMatchedLayers` (route-cache hit) | 1,206 |
| + `handle()` (runs the route, `res.send`) | 2,153 |
| + `getNativeResponse` | 2,156 |
| whole `handleNativeRequest`, parsing off | 2,219 |
| whole `handleNativeRequest`, adapter defaults | 5,102 |
| floor: `new Request` + `new Response` | 410 |

What it says [M]:

- **Parsing is the largest cost.** Reading the empty body of a GET costs about
  1.5 µs; wrapping the (synchronous) query and cookie parses in promises costs
  about 1.2 µs more. Nothing here is routing.
- **The route lookup, on a cache hit, is ~0.48 µs** (the `getMatchedLayers`
  step). That is the most that any routing change can save on a cached path.
- **On a cache miss the lookup is O(N), twice over** (`bench/miss-cost.ts`,
  1,000 routes, a fresh path per call, cache full) [M]:

  | Miss path | µs per miss |
  |---|---:|
  | stock (scan every route + FIFO eviction) | 89.7 |
  | stock, cache off (scan only) | 60.8 |
  | stock, ring-buffer FIFO | 67.7 |
  | candidate index, stock FIFO eviction | 17.1 |
  | candidate index, cache off | 1.0 |
  | **candidate index + ring-buffer FIFO** | **1.7** |

  The eviction cost is `cache.delete(cache.keys().next().value)`: an
  insertion-ordered `Map` keeps deleted slots until it rehashes, and
  `keys().next()` walks past them. `spikes/map-fifo.ts` isolates it: 730 ns
  per insert at a 2,000 cap, **18,420 ns at 50,000**, against ~200 ns for a
  plain insert; Node 24 (V8) shows the same (878 / 19,579 ns) [M]. So it is
  not a Bun bug; it is our eviction. It became visible when the default cap
  was raised to 50,000 (`DEFAULT_ROUTE_CACHE_MAX`, `BunRouter.ts`) [S], and
  it is paid only by traffic whose distinct paths exceed the cap.

End to end the in-process figures are amplified (GC, promise jobs, socket
work): bun-common defaults serve ~48k req/s, 20.8 µs per request, against
~127k (7.9 µs) for a trivial `Bun.serve` handler [M] (§9). The lean
configuration serves ~80k (12.5 µs).

## 3. What Bun's native router is

The full survey, with a citation per claim, is
[`survey.md`](evidence/bun-native-routes/survey.md). What matters here,
re-measured on this Bun where marked:

| Behaviour | Bun `routes` | bun-common today |
|---|---|---|
| Matching structure | uWS segment tree per method; each node's children a `std::vector` scanned linearly [B] | `@routejs/router` regex per route, plus a per-path pipeline cache [S] |
| Precedence | static → param → wildcard, **regardless of registration order**, with backtracking [B][M] | **registration order** (Express); opt-in `routeSpecificity` [S][M] |
| Several handlers per path | no: one handler; it cannot decline (`undefined` is an error) [B][M] | yes: every matching layer runs in order until one responds [S] |
| Middleware | none | `use()` prefix middleware, error handlers [S] |
| Param syntax | `:name`, `*` only. `:a?`, `:id(\d+)` and `*rest` register **literally** (a param named `a?`) [M] | optional, regex, named wildcards, mid-segment params [S] |
| Param names | irrelevant to matching; same shape = same route, later replaces earlier [B] | significant [S] |
| Duplicate param names | throws at `Bun.serve()` [M] | accepted; the later capture wins (`/two/1/2` → `{ a: "2" }`) [M] |
| Non-ASCII key | throws [M] | allowed [S] |
| Mid-segment `:` (`/mid/:a-:b`) | accepted, matched as one param reported as `{ b: "1-2" }` [M] | two params [S] |
| Trailing slash | strict: `/a` ≠ `/a/` [M] | tolerant: `/a` matches `/a/` and vice versa [M] |
| Case | sensitive [M] | adapter default `caseSensitive: true`; BunRouter default `false` [S] |
| Param decoding | `%zz` → `"�"`, never an error [M] | `%zz` → **400** `URIError` (Express 5) [M] |
| Wildcard params | none [M] | `{"0": …, "rest": …}` [M] |
| HEAD on a GET route | answered by the GET handler, body dropped [M] | **404** [M] (§13, Q2) |
| Method not registered | falls to `fetch`; no 405 [M] | 404 (no 405) [M] |
| Static `Response` value | answers **every** method, ETag added [M][B] | n/a |
| Matching input | the **raw** request-target; `req.url` is **normalised** [M] | the normalised `req.url` [S] |
| Lookup cost | linear in the matched route's position among its siblings [M] | O(1) cache hit; O(N) miss [M] |
| Build cost | quadratic in siblings per node: 1,000 flat routes 70 ms, 4,000 1.1 s [M] | negligible [I] |
| Rebuild | `server.reload({ routes })` rebuilds the whole tree, synchronously [B] | n/a |

Two of these are sharp enough to shape every design:

- **Raw target versus normalised URL** (`results/dot-segments.txt`). Raw
  `GET /users/../a` reaches the handler for `/users/:id/:x` with
  `params { id: "..", x: "a" }`, while its `req.url` path is `/a`. A design
  that trusts "Bun sent it to key K" is wrong for such a request unless it
  re-checks the path it will actually match (§4.2's shape guard; proven
  load-bearing by a negative control, §10.1).
- **Sibling scaling** (`results/scaling.txt`, `scaling-order.txt`,
  `build-cost.txt`). With 5,000 flat siblings the last-registered route serves
  7.7k req/s against 120k for the first, and a miss that reaches `fetch` pays the
  whole scan (32.8k req/s). A route table of a few hundred siblings is fine;
  thousands are not.

## 4. The approaches

Every approach was prototyped or measured. The verdict line of each says which.

### 4.1 Bun dispatch alone — the question every approach depends on

Before any design: does Bun hand a request to a route handler faster than to
`fetch`? `spikes/dispatch-only.ts` reaches **the same stock pipeline**
(`handleNativeRequest`, route cache on) three ways, on a two-route table, with
trivial-handler controls. Median of 3 interleaved rounds, `oha -c 64`, 3 s [M]
(`results/dispatch-only.txt`):

| | `/static` | `/user/42` |
|---|---:|---:|
| trivial handler, `fetch` | 126,908 | 117,741 |
| trivial handler, route (function) | 120,698 | 121,258 |
| trivial handler, route (`{ GET }`) | 120,568 | 120,030 |
| adapter lean, `fetch` | 79,055 | 79,059 |
| adapter lean, route (function) | 75,559 | 75,957 |
| adapter lean, route (`{ GET }`) | 78,897 | 76,204 |
| adapter defaults, `fetch` | 48,847 | 52,257 |
| adapter defaults, route (function) | 49,603 | 48,332 |
| adapter defaults, route (`{ GET }`) | 47,841 | 48,395 |

**There is no dispatch gain** to collect: every route figure is within a few
percent of its `fetch` figure, in both directions. That agrees with Elysia's
own measurement when it adopted native routes: "dynamic routes perform 2-5%
faster", static negligible [B] (survey §9). It means a native design can only
win by making *our* per-request work smaller, and that work (§2) is mostly not
routing.

### 4.2 Approach 1 — build `routes` once, before `listen()`: the partition design

**What.** Every route handler whose path Bun can express exactly (static and
whole-segment `:param` segments, ASCII, no dot segments) becomes a native key,
one entry per method, with param names made positional (`/users/:p0`) because
Bun ignores them anyway [B]. Everything else (regex, optional, wildcard,
`all()` on an exotic method, anything with a `%`) is simply not a key; it is
reached through `fetch`, which stays the full pipeline.

The design's central idea, which is what makes it exact:

> **Bun's precedence only chooses a partition. BunRouter still decides.** Each
> (key, method) carries a precomputed **candidate list**: every route, middleware
> and error handler that is not *provably* disjoint from the key's shape, in
> registration order. The native handler runs the unchanged `getMatchedLayers()`
> over that list instead of the whole table. [D]

"Provably disjoint" is deliberately weak: only a literal-versus-literal
mismatch at an aligned segment (respecting each route's `caseSensitive`), or an
impossible segment count between two fully plain patterns, excludes a route. A
wildcard, regex or optional segment stops the comparison and keeps the route in.
So the candidate list is always a superset, and the router's own regexes do the
rest: registration order, `next('route')`, `next('router')`, error mode,
specificity, `req.baseUrl`, decode failures (400) all come from the same code
as today.

One guard is needed because of §3's raw-target finding: before using a key's
list, the handler checks that the path BunRouter will match (`req.url` up to
`?`) still has the key's shape. If not (a dot segment, `%2e`, a trailing slash),
it matches against the whole table, exactly as `fetch` would.

**Verdict: works and is exact, but slower than today on cached paths** [T][M].
Prototype: [`prototype/native-routes.ts`](evidence/bun-native-routes/prototype/native-routes.ts).
Results in §9 and §10.1. It wins only on cache misses, which §4.6 fixes more
cheaply.

**Route registration after `listen()`.** A new route changes candidate lists
(it may be a candidate of existing keys) and may deserve a key. The prototype
refreshes the lists synchronously on the next native request when the table's
length changed, which keeps it exact; and schedules a debounced
`server.reload()` for the new keys, which is only an optimisation. Until the
reload, a request for the new route is either served by an existing key whose
refreshed list includes it, or by `fetch` [T] (`sanity.test.ts`, "a route
added after listen()").

**Mounted routers.** `use(path, router)` flattens the sub-router's routes into
the parent's table at mount time (`mountRouter` → `mergeRoute`) [S], so they
are ordinary routes by the time the table is built; `routerId` and
`baseUrlRegexp` are carried per route, so `next('router')` and `req.baseUrl`
are unchanged [S][T]. A sub-router whose routes are added *after* it was
mounted is not reflected in the parent even today [S] — not a new limitation.

### 4.3 Approach 2 — rebuild with `server.reload({ routes })` as routes change

**What.** Rebuild Bun's table on every route change, debounced, instead of
treating late routes as `fetch` traffic.

**Measured facts** [M] (`results/reload.txt`):

- Cost equals building from scratch, and is quadratic in siblings: 10 routes
  0.09 ms, 100 routes 1.3 ms, **1,000 routes 92 ms, 5,000 routes 3.1 s**, all
  blocking the event loop.
- **Atomic for requests:** a request in flight keeps its old handler; the next
  request sees the new table; 599 reloads during 9,600 requests produced no
  miss and no error.
- **WebSockets survive:** a socket opened before a reload still echoes after it.
- `reload({ routes })` alone keeps `fetch` and `websocket`.
- Known Bun bug: `reload()` *without* `routes` drops static-`Response` routes
  (open PR #41577) [B]. Always pass `routes`.

**Verdict: only ever an optimisation layered on approach 1.** Correctness must
not depend on it (approach 1's lazy candidate refresh provides that), and with
a large flat table one reload can stall the server for tens of milliseconds to
seconds. Elysia makes the same choice from the other side: it reloads once after
`listen()` and serves later routes from `fetch` [B].

### 4.4 Approach 3 — hybrid: native only where the semantics map exactly

**What.** Register natively only routes whose behaviour Bun reproduces on its
own — static or `:param`, no middleware in front, no other route overlapping,
case-sensitive router, handlers that never call `next()` — and run them
without BunRouter at all.

**How "maps exactly" would be detected** [I]: key eligibility as in §4.2; *no*
candidate but the route itself (so no `use()` in front, no overlapping route,
no error handler in scope); the router `caseSensitive`; no `routeSpecificity`.
It still cannot be detected statically that a handler never calls `next()` or
throws, so the error pipeline and the not-found fallthrough still need the
adapter's wrapper; and params still need our decoding to keep the 400 on a bad
escape.

**Verdict: not recommended.** It is a strict subset of approach 1 (the
candidate list of such a route is one entry, which approach 1 already handles),
the saving it adds is the ~0.48 µs lookup (§2) that §4.1 shows is not
recovered by Bun dispatch, and real applications nearly always have a global
`use()` (body parser, CORS, logging), which disqualifies every route. In a Nest
app, `registerParserMiddleware` and `enableCors` register exactly such
middleware [S].

### 4.5 Approach 4 — precompiled per-route pipelines

**What.** Elysia-style: compose each route's pipeline once (Elysia builds a
string and `Function()`s it, omitting any feature the handler does not read,
awaiting only what is async [B]), or at least precompute each key's layer array
so a request only binds params.

**Measured upper bound** [M]. The `proto-ceiling` target (not exact; computes a
key's layers once and reuses them for every request, rebinding only Bun's
params) was **not faster** than the stock cached path either (§9.4: 45.6k vs
48.0k static, one round). With
routing out of the way, the remaining pipeline cost is `handle()`'s generic loop
(~0.95 µs in process, including `res.send`) and the wrappers (§2).

**What it would take to go further** [I]: a fast path inside `handle()` for
the common case (every layer synchronous, each calls `next()` once or
responds), with a fall-back to the general loop the moment anything else
happens; allocating one `next` per request instead of one per layer; skipping
the `debug` branch when off. Elysia-style source generation is not a fit: its
gains come from *not building* a context it can prove unused, which Express's
`req`/`res` contract does not allow (any middleware may read anything).

**Verdict: later, and measured first.** Sized as Phase C in §11, with its own
go/no-go.

### 4.6 Approach 6a — the JavaScript candidate index and O(1) cache eviction (recommended)

**What.** Approach 1's candidate list, computed from the *request path* in
JavaScript and used only on a cache miss. Routes are bucketed by their first
segment (lower-cased); a route whose first segment is a param, a wildcard or
absent (global middleware) goes in a list every request consults. On a miss,
the candidates are the request's bucket merged with that list in registration
order, minus any route provably disjoint from the concrete path (the same test
as §4.2). The unchanged `getMatchedLayers()` runs over them, and its result is
cached as today. A hit never touches the index. [D]

**Why it beats approach 1 for this job** [I from M/T]:

- No raw-path guard: the path it indexes *is* the one BunRouter matches.
- No `server.reload()`, no quadratic build, no linear sibling scan.
- `fetch()` and a served request are still one code path, so the `fetch()`
  parity guarantee holds by construction.
- It also helps a router that is never served (a bare `BunRouter.fetch()`,
  tests).

**The eviction half.** The index alone takes a miss from 89.7 µs to 17.1 µs;
the rest is the FIFO eviction (§2). `RingFifoCache` in the same prototype
keeps the policy exactly (FIFO, at most `routeCacheMax` entries, `0`
disables) but names the oldest key from a ring buffer of keys, so eviction is
one `Map.delete`: a miss becomes 1.7 µs [M]. Because the policy is unchanged,
the three tests that pin FIFO eviction (`router.test.ts` "evicts the oldest
entry…", and the two `routeCacheMax` adapter tests) pass unmodified [T]; a
two-generation cache tried first broke all three, and was dropped.

**Verdict: recommended as PR-1 (index + ring FIFO).** Exact [T] (§10.1);
param-random 7.8k → 40.0k req/s, and no cached scenario moved beyond
noise [M] (§9).
Prototype: [`prototype/candidate-index.ts`](evidence/bun-native-routes/prototype/candidate-index.ts).

### 4.7 Approach 6b — the request parse fast path

**What.** `BunRequest`'s constructor starts three parses and `init()` awaits
them all: the query (synchronous, wrapped in a promise), the cookies
(synchronous, wrapped), and the body, which *runs the whole read path even
for a GET without a body* [S] (`BunRequest.ts:1147-1188`, `#parseBody` at
`:2778`). A fast path finishes each synchronously when there is nothing to
read: no `?` in the URL, no `Cookie` header, and `request.body === null`.
`init()` then returns the request without a promise. [D]

**Measured upper bound** [M]: parsing off entirely, bun-common goes from ~48k
to ~80k req/s on every GET scenario (§9); in process, `BunRequest.init` from
3.3 µs to 0.57 µs, and 1.76 µs with only the body read removed.

**What must be preserved**, because a disabled parse is not the same state as
an empty one. After a bodiless request is parsed today: the buffer is the
(empty) one read, `req.body` is `undefined`, the body counts as parsed
(`BunRequest.ts:2819-2823`), and the body state becomes `ended`, so
`req.complete` is true and `end` fires (`:1153-1165`) [S]; `query` and
`cookies` are objects *assigned* by their parses rather than allocated lazily
[S], presumably empty [I]. The fast path must reach exactly that state; the lean configuration used for the
upper bound does not (it leaves the body unparsed), which is why this is a
spike-first PR and why its figure is an upper bound, not a promise. [U] until
the spike.

**Verdict: recommended as PR-2**, behind a spike whose output is the list of
observable fields and events, compared before and after on both packages'
suites.

### 4.8 Approach 5 — static responses and `Bun.file` routes

**What.** Serve a route Bun can answer with a constant `Response` (or a file)
straight from Bun's table.

**Measured** [M]: a static `Response` route serves ~150k req/s on this machine
(`oha` ceiling probe: 146–158k), against ~48k for the same constant through the
adapter (§9).

**Semantics** [M][B]: a static route answers **every method** (POST included),
adds an ETag, runs **no middleware**, and cannot be declined. It cannot be
*inferred* from a handler: a function returning a constant still sits behind
whatever `use()` the app registered (a body parser, CORS, auth), and skipping
them silently is the kind of break this plan exists to avoid.

**What already exists** [S]: the adapter's `server` option is spread into
`Bun.serve` (bun-common `BunHttpAdapter.ts:1108`, bun-nest `:876`), so `new BunHttpAdapter(0, {
server: { routes: { "/health": new Response("ok") } } })` already serves a
native static route today, ahead of the router.

**Verdict: PR-3, opt-in only** [D]: document the `server.routes` escape hatch
with its semantics (every method, no middleware), and optionally add a named
method (`adapter.staticRoute(path, response)`) that warns when the path
shadows a registered route. Never automatic.

### 4.9 Other ideas considered

- **A `nativeRoutes: true` adapter option** (approach 1 behind a flag). It is
  how approach 1 would ship if it ever earns it; §10.5 is the threshold.
- **Handing Bun's own `Request` through without wrapping.** Not compatible
  with the Express contract every middleware relies on (`req.params`,
  `req.query`, `req.body`, `res.status().json()`); the wrappers are the product.
  Their *construction* cost is the target (PR-2, Phase C), not their existence.
- **Pooling `BunRequest`/`BunResponse`.** Rejected [I]: both escape into user
  code (closures, async continuations, `res.on("finish")`), so a pooled object
  can be observed after reuse. The measured construction cost of `BunResponse`
  (~0.16 µs, §2) does not justify the risk.
- **`false` routes** (Bun ≥ 1.4: a key that falls through to `fetch` [B]) —
  only useful to carve a hole in a native wildcard; approach 1 registers no
  wildcards.

## 5. The approaches compared

"Speed" is the measured change against today's adapter with default options,
median req/s (§9). "Breaks" means Express 5 semantics as the repo's tests define
them.

| # | Approach | Speed vs today (median req/s, §9) | Semantic breaks | Complexity | Risk | Verdict |
|---|---|---|---|---|---|---|
| 1 | Native partition: `routes` built before `listen()`, candidate lists, shape guard | **−14% to −30%** on cached scenarios; param-random **+330%** (7.8k → 33.5k) [M] | none found: 16,000-request fuzz, both suites [T]; `fetch()` no longer covers the served path | high: ~340 lines, a guard, key eligibility, reload, a three-mode CI run | depends on Bun's raw-path matching and sibling scaling; slower on the common path | **no** |
| 2 | 1 + `server.reload()` on route changes | as 1 | none, if correctness never waits for a reload [T] | +debounce | a reload blocks the loop: 92 ms at 1,000 flat routes, 3.1 s at 5,000 [M] | only as part of 1 |
| 3 | Hybrid: native only where Bun's semantics already match | ≤ dispatch gain, which is 0 ± 4% [M] | none if detected strictly; real apps' global `use()` disqualifies nearly every route [S] | medium | small | **no** |
| 4 | Precompiled per-route pipelines | ceiling not faster on cached paths (45.6k vs 48.0k, one round) [M] | the ceiling itself is not exact | high (codegen) or medium (`handle()` fast path) | medium | later, measured (Phase C) |
| 5 | Static `Response` / `Bun.file` routes | ~150k vs ~50k for a constant route (+200%) [M] | answers every method, runs no middleware, adds an ETag [M][B] | low | high if inferred; low if opt-in | **opt-in only** (PR-3) |
| 6a | JS candidate index + ring FIFO cache | param-random 7.8k → 40.0k; cached scenarios within noise [M] | none: fuzz and both suites, FIFO tests included [T] | low: ~150 lines in one method's miss path | low | **yes** (PR-1) |
| 6b | Request parse fast path | upper bound +50% to +66% on bodiless GETs [M] | none intended; unproven until PR-2a [U] | low–medium | medium (event/state ordering) | **yes, spike first** (PR-2) |

## 6. Semantics preservation

Against the repo's rules (`CLAUDE.md`, "Router — Express 5 semantics") and the
current adapter's measured behaviour (`results/bunrouter-baseline.txt`). "Raw
Bun" is what `Bun.serve({ routes })` does on its own; the two designs are the
partition prototype (§4.2) and the candidate index (§4.6).

| Semantic | Raw Bun `routes` | Partition design (approach 1) | Candidate index (6a) |
|---|---|---|---|
| `use()` prefix middleware, in registration order before and between routes | none | preserved: middleware are candidates, in registration order [T] | preserved [T] |
| Error handlers (4-arity), `next(err)`, thrown and rejected errors | only `error()` | preserved: the router's own loop [T] | preserved [T] |
| `next('route')` | none | preserved [T] (`sanity.test.ts`) | preserved [T] |
| `next('router')` | none | preserved: `routerId` unchanged [T] (fuzzed) | preserved [T] |
| Several matching route handlers, registration order | static beats param regardless of order [M] | preserved: Bun picks the partition, the list keeps order (`/users/:id` registered first still wins `/users/new`) [T] | preserved [T] |
| `routeSpecificity` | fixed precedence | preserved: sorting runs inside `getMatchedLayers` over the same matched set [S]; fuzzed with it on [T] | preserved [S][T] |
| Optional `:a?`, regex `:id(\d+)`, `*name`, mid-segment params | literal or wrong [M] | never keys; reached through `fetch` or as candidates [T] | unchanged [T] |
| Param decoding, `%zz` → 400 | U+FFFD [M] | preserved: params come from routejs, not Bun [T] | preserved [T] |
| Trailing slash tolerance | strict [M] | preserved: `/a/` misses the key and reaches `fetch` [T] | preserved [T] |
| Case sensitivity | always sensitive [M] | preserved: a case variant misses and reaches `fetch`; candidates compare per route's setting [T] | preserved [T] |
| HEAD on a GET route (404 today) | answered by GET [M] | preserved: a method-mismatch guard sends it to `fetch` [T] | unchanged |
| OPTIONS / no 405 | falls to `fetch` [M] | unchanged [T] | unchanged |
| Not-found handlers, final error handler | n/a | unchanged: same `handleNativeRequest`, same `error()` [T] | unchanged |
| Payload guard (413) | n/a | unchanged: same `BunRequest.init` [T] | unchanged |
| `req.params` typing | n/a | unchanged: registration API untouched [S] | unchanged |
| `fetch()` parity | n/a | **changes**: `fetch()` does not go through Bun's table, so parity must be tested served-vs-`fetch()` (§12) | unchanged by construction |
| WebSocket upgrade from a route | works [M] | preserved: `server.upgrade` inside a route handler works; the websocket suites pass in native mode [T] | unchanged |
| Dot segments, `%2e`, raw `#` | routed on the raw path [M] | preserved **only with the shape guard** (negative control fails without it) [T] | not applicable |
| Routes added after `listen()` | invisible until `reload()` | preserved: lazy candidate refresh; `reload()` is only speed [T] | preserved: index rebuilt when the table grows [T] |
| `setInstance()` swapping the router | n/a | must rebuild (the prototype checks router identity) [I] | per-router, installed on the new one [I] |
| User `server.routes` passthrough | n/a | kept; the user's key wins a clash [D] | unchanged |
| `domain()`/host-scoped routes | no hosts | preserved: host routes are candidates; `hostRegexp` runs as today [I from S] | preserved [I from S] |
| Thousands of sibling routes | linear lookup, quadratic build [M] | inherits both | unaffected |

## 7. bun-common specifics

- **Where each recommended change lands** [S]:
  - PR-1 in `BunRouter.getMatchedLayers()`: on a miss, `this.routes()` is
    replaced by the candidate list, **keeping each route's original index**
    (the prototype used list-relative indices, which is equivalent for the loop
    [I] but changes the documented meaning of `MatchedLayerRecord.routeIndex`).
    The index is rebuilt lazily when `routes().length` changes, and dropped by
    `clearRouteCache()`. The route cache's eviction moves from
    `keys().next()` to a ring buffer of keys (same FIFO policy, same bound).
  - PR-2 in `BunRequest`'s constructor and `init()`.
  - PR-3 in the adapter's options and README.
- **`BunWebSocket`'s upgrade route** calls `router.getMatchedLayers()` without
  a request to find its own layer's params [S] (`BunWebSocket.ts:1037`); it goes through the index like any miss. Covered by the
  websocket suites in index mode [T].
- **`routeCacheMax`**: unchanged semantics. With the index a miss is cheap, so
  a smaller default (or not caching a path whose candidate list is tiny) becomes
  possible; left as Q4.
- **The adapter's `caseSensitive: true` default** differs from BunRouter's
  `false` [S]. It is why case variants fall to `fetch` under approach 1 and do
  not matter to the index.

## 8. bun-nest specifics

How Nest drives the adapter [S] (`@nestjs/core` 11.1.27, `nest-application.js`):
`app.init()` runs `httpAdapter.init()`, `registerParserMiddleware` (the body
parser, a global `use()`), the modules, **`registerRouter`** (middleware
first, via `createMiddlewareFactory` → `instance.useMethod(method, path, cb)`,
then every controller route via `router[method](path, handler)`), and last
**`registerRouterHooks`** (`setNotFoundHandler`, `setErrorHandler`).
`app.listen()` calls `init()` first. So every route exists before `listen()`.

| Nest feature | Effect under the recommended PRs | Under approach 1 (not recommended) |
|---|---|---|
| Global prefix, URI versioning | part of the registered path; indexed like any path | part of the key |
| Header / media-type / custom versioning | several handlers on one path, each calling `next()` on a mismatch [S] | all are candidates of the one key [T] |
| `forRoutes()` with wildcards (`mw/*path`) | a `useMethod` prefix with `*` → "everywhere" list or bucket; exact [T] | a candidate of every key it can reach [T] |
| `@Controller({ host })` | a host filter wrapping the handler [S]; unchanged | unchanged |
| Guards, interceptors, pipes, exception filters | run inside the route handler Nest registers [S]; unaffected | unaffected |
| `enableCors` | a global `use()` plus `options("*")` [S]; unchanged | preflights fall to `fetch` (no OPTIONS key) [T] |
| `app.init()` without `listen()` (tests, `adapter.fetch()`) | the index works without a server | no server, no native table: `fetch()` only |
| Body parser middleware | PR-2 must keep `handleBodyParsing` correct when the constructor finished the body synchronously [U] | unchanged |

bun-nest gains PR-1 and PR-2 **without code of its own**: its
`handleNativeRequest` calls `BunRequest.init(…, this.requestOpts)` and
`this.instance.handle(…)` on a bun-common `BunRouter` [S]. Measured in §9
(`proto-nest-index`).

## 9. Benchmark results

### 9.1 Method

- **Machine:** Intel i9-11900H, 16 threads, 62 GB, Linux 7.0.0-31. Other
  sessions share it.
- **Bun:** 1.4.3-canary.1 (`5f554969bc8ab2159583cdf5ff26f5277ca35e91`);
  `NODE_ENV=production` for servers.
- **Tool:** `oha` 1.14.0 (Rust, multi-threaded), 64 connections, keep-alive.
  Its ceiling on this machine is above 150k req/s (a static `Response` route
  reached 146–158k at 32–256 connections), so every figure below is
  server-bound.
- **Procedure** (`bench/run.ts`): one fresh server process per cell
  (`bench/servers.ts <target>`); 2 s warm-up discarded; 8 s measured; 3 rounds,
  interleaved (every cell of round 1, then round 2), median reported, every
  run kept in `results/bench-full.json`. Each round starts only when the
  1-minute load average is under 2; the load at the start of each cell is
  recorded (the benchmark itself raises it to ~3–4: one server core plus
  `oha`'s workers).
- **`bench/run.ts --verify`** checks every target answers every scenario
  correctly before any timing.

Scenarios, identical route set on every target: `static` (`GET /static`),
`param` (`GET /user/42`), `middleware` (`GET /mw/hit` behind three `use("/mw")`
middleware), `routes-1000` (`GET /r999/7` with 1,000 `/r<i>/:id` routes
registered), `param-random` (the same route, a fresh 8-digit id per request —
defeats any per-path cache), `json` (`POST /json`, `{"n":7}`).

Targets: `raw-routes` / `raw-fetch` (hand-written `Bun.serve`), `elysia`
(1.4.28), `bun-common` (defaults) and `bun-common-lean` (parsing off),
`bun-nest` (a Nest 11 app, three `MiddlewareConsumer` middleware, 1,000
generated controllers), and the prototypes: `proto-index*` (§4.6),
`proto-native*` (§4.2), `proto-nest-*`.

### 9.2 Results

`results/bench-full.json` (every run), `results/bench-full.log`. Median req/s
of 3 rounds; load at cell start 1.5–4.2 [M].

| Target | static | param | middleware | routes-1000 | param-random | json |
|---|---:|---:|---:|---:|---:|---:|
| raw-routes (`Bun.serve` routes) | 124,218 | 122,607 | 127,449 | 79,165 | 81,031 | 84,548 |
| raw-fetch (`Bun.serve` fetch) | 112,099 | 112,056 | 111,814 | 109,453 | 106,894 | 80,184 |
| elysia 1.4.28 | 97,170 | 79,757 | 69,341 | 62,148 | 63,259 | 76,898 |
| **bun-common** (defaults) | **49,957** | **48,549** | **48,189** | **48,541** | **7,803** | **44,824** |
| proto-index (6a, no ring) | 50,316 | 49,989 | 48,813 | 49,199 | 15,211 | 44,146 |
| proto-native (approach 1) | 42,948 | 38,741 | 40,967 | 33,773 | 33,542 | 44,103 |
| bun-common-lean (parsing off) | 74,874 | 80,390 | 78,337 | 78,816 | 8,675 | — |
| proto-index-lean | 76,932 | 79,788 | 78,915 | 77,790 | 16,097 | — |
| proto-native-lean | 66,531 | 54,654 | 59,170 | 44,914 | 45,543 | — |
| **bun-nest** | **40,489** | **38,530** | **37,785** | **38,678** | **6,777** | **36,354** |
| proto-nest-index | 41,327 | 39,904 | 38,546 | 37,600 | 15,092 | 34,714 |
| proto-nest-native | 36,683 | 30,360 | 30,959 | 27,800 | 27,075 | 35,459 |

The recommended PR-1 prototype (index **and** ring FIFO) was measured in a
second run, after `bench/miss-cost.ts` found the eviction cost; same method,
`results/bench-index-rc.json`:

| Target | static | param | middleware | routes-1000 | param-random | json |
|---|---:|---:|---:|---:|---:|---:|
| bun-common | 49,272 | 49,829 | 49,594 | 49,429 | 7,772 | 45,133 |
| **proto-index-rc (PR-1)** | **49,542** | **49,038** | **49,620** | **48,923** | **39,955** | **44,856** |
| bun-common-lean | 80,607 | 79,538 | 75,644 | 78,053 | 8,497 | — |
| proto-index-rc-lean (PR-1 + PR-2 upper bound) | 79,032 | 80,460 | 78,747 | 80,667 | 56,783 | — |
| bun-nest | 40,776 | 38,653 | 37,713 | 38,578 | 6,605 | 34,559 |
| **proto-nest-index-rc (PR-1)** | **41,462** | **38,113** | **38,556** | **37,910** | **31,656** | **35,273** |

(load at cell start 1.9–4.6.) PR-1 moves param-random **5.1×** on bun-common
(7.8k → 40.0k) and **4.8×** on bun-nest (6.6k → 31.7k), beating the native
prototype's 33.5k with none of its costs; every cached scenario is within
±2% of the stock adapter measured in the same run, inside the spread.

Reading it [M unless marked]:

- **Native routing is slower than today on every cached scenario**: −14% to
  −20% on static/param/middleware, −30% on routes-1000 (Bun's sibling scan over
  1,000 flat keys). It wins only param-random (7.8k → 33.5k). bun-nest shows
  the same shape.
- **Round-to-round spread** on cached scenarios is 1–8% (e.g. bun-common static
  48.6k/50.0k/50.7k; bun-common-lean middleware 71.8k/78.4k/78.3k). Differences
  under ~5% are noise.
- **Parsing, not routing, separates bun-common from lean**: +50% static, +66%
  param, +63% middleware, +62% routes-1000 with parsing off.
- raw-routes beats raw-fetch on static/param/middleware (+9–14%) but loses
  routes-1000 (−28%): with a trivial handler, Bun's route dispatch is a little
  faster than `fetch`'s URL work in JavaScript, until its sibling scan
  dominates. The same edge disappears behind our pipeline (§4.1).

### 9.3 Against Elysia

Elysia 1.4.28 uses Bun's native routes for every compiled route since 1.3 [B]
and compiles each handler to skip unused work [B]. Against it, median req/s [M]:

| | static | param | middleware | routes-1000 | param-random | json |
|---|---:|---:|---:|---:|---:|---:|
| elysia | 97,170 | 79,757 | 69,341 | 62,148 | 63,259 | 76,898 |
| bun-common today | 49,957 | 48,549 | 48,189 | 48,541 | 7,803 | 44,824 |
| bun-common, PR-1 (measured) | 49,542 | 49,038 | 49,620 | 48,923 | 39,955 | 44,856 |
| upper bound of PR-1 + PR-2 (proto-index-rc-lean) | 79,032 | 80,460 | 78,747 | 80,667 | 56,783 | — |
| bun-nest today | 40,489 | 38,530 | 37,785 | 38,678 | 6,777 | 36,354 |

- Elysia's own routes-1000 figure (62k vs 97k static) is Bun's sibling scan:
  it inherits the native router's costs along with its speed [I from M].
- With PR-1 and PR-2 at their upper bound, bun-common would pass Elysia on
  middleware (+14%) and routes-1000 (+30%), match it on param, and stay behind
  on param-random (−10%) and static (−19%) [I from M: the lean figures are an upper bound for
  PR-2]. JSON POST is the scenario PR-2 cannot help (it has a body to parse).
- The remaining static gap is pipeline cost (§4.5), not routing.

### 9.4 The native prototypes, and the ceiling

From a single quick round (5 s, `results/bench-ceiling-quick.log`), so read
it for direction only [M]:

| | static | param | middleware | routes-1000 | param-random |
|---|---:|---:|---:|---:|---:|
| bun-common | 48,014 | 45,702 | 49,883 | 47,621 | 7,889 |
| proto-native | 41,603 | 39,526 | 38,956 | 34,287 | 34,536 |
| proto-ceiling (layers computed once per key; not exact) | 45,573 | 41,037 | 43,971 | 32,904 | 34,714 |
| bun-common-lean | 79,972 | 81,305 | 77,952 | 76,032 | 8,765 |
| proto-native-lean | 65,517 | 55,356 | 58,868 | 44,751 | 42,388 |
| proto-ceiling-lean | 62,711 | 54,906 | 63,850 | 46,204 | 44,610 |

Even with the per-key matching removed entirely, the native path stays below
today's cached path. What the native path adds, per request, is a `WeakMap`
hand-off and the guard, and what it removes (a cache-key string and one `Map`
lookup) is worth no more than that; the dispatch itself gains nothing
(§4.1) [I from M]. That is why no refinement of approach 1 is recommended.

## 10. Feasibility

### 10.1 What is proven

Each item was run on this Bun; the file is in the evidence folder.

| Claim | Evidence |
|---|---|
| Bun dispatches to a route no faster than to `fetch` | `spikes/dispatch-only.ts` [M] |
| The partition design (approach 1) is exact | `prototype/tests/differential.test.ts`, 400 random tables × 40 raw requests = **16,000 requests, 1,474 natively routed, 0 mismatches** (`results/differential.txt`) [T] |
| … and its two safety mechanisms are load-bearing | same test with `BNR_NO_GUARD=1` (shape guard off): **4 mismatches**; with `BNR_BREAK_CANDIDATES=1` (middleware dropped from lists): **613 mismatches** [T] |
| … and it passes the packages' own suites | `prototype/tests/run-tests.ts`: bun-common **1,131 pass / 0 native breaks** (the one served-mode failure is a harness artefact: a test asserting `fetch()` binds no port); bun-nest **243 / 243, 0 breaks** (`results/prototype-tests-*.txt`) [T] |
| … including middleware, an error handler, `next('route')`, decoding, a raw dot segment, and a route added after `listen()` then moved into the table by `reload()` | `prototype/tests/sanity.test.ts`, 13/13 [T]; its dot-segment case fails without the guard [T] |
| The candidate index (6a) is exact | differential, same 16,000 requests, route cache on, off, and at a 4-entry cap with the ring FIFO (15,641 misses), and with `routeSpecificity: true`: 0 mismatches; negative control (wildcard routes wrongly dropped) **2,222 / 2,230 mismatches** [T] |
| … and, with the ring FIFO, passes the packages' own suites | index mode: bun-common 1,131 / 0 breaks (2,415 misses through the index), bun-nest 243 / 0 breaks (150 misses), the FIFO-eviction tests included [T] |
| A miss's two costs, and that PR-1 removes both | `bench/miss-cost.ts`: 89.7 µs → 1.7 µs; `spikes/map-fifo.ts` isolates the eviction [M] |
| PR-1 fixes the cache-miss cliff end to end | §9: param-random 7.8k → 40.0k [M] |
| Parsing is the largest per-request cost | `bench/breakdown.ts` [M]; lean vs defaults end to end [M] |
| `server.reload()` is atomic for requests and keeps WebSockets | `spikes/reload.ts` [M] |

### 10.2 What is still assumed

- **PR-2's semantics** (§4.7): the observable state after a synchronous
  "nothing to parse" must equal today's after an awaited parse. [U] until its
  spike. Its speed figure is an **upper bound** (the lean configuration skips
  more than the fast path would).
- **The index's effect on memory**: one `Map` of arrays plus one compiled
  record per route [I]; not measured. Negligible next to the route cache's
  50,000 entries [I].
- **Other operating systems**: everything was measured on Linux x64.

### 10.3 Blockers, each with its workaround or stop condition

| Blocker | Hits | Workaround, or stop |
|---|---|---|
| Bun dispatch is not faster than `fetch` | approach 1, 2, 3 | **Stop.** No workaround exists on our side; it is the reason for decision 1. Reopen per §10.5. |
| Raw target vs normalised `req.url` (Bun) | approach 1 | the shape guard (proven necessary) |
| Linear sibling lookup, quadratic build (Bun) | approach 1, 2 | nested tables fare better; flat thousands would need a stop. Not hit by the index. |
| A route handler cannot decline | approach 1, 3 | the handler always runs the router over the key's candidates; a guard failure runs the full table in the same call |
| `reload()` blocks, and drops static routes without `routes` (Bun) | approach 2 | always pass `routes`; debounce; never needed for correctness |
| `fetch()` no longer exercises the served path | approach 1 | served-vs-`fetch()` differential in the suite (§12) |
| Static responses skip middleware and answer every method | approach 5 | opt-in only, documented; never inferred |

### 10.4 The smallest first PR

**PR-1: the candidate index and the ring FIFO** (§4.6). It changes one
method's miss path and the cache's eviction in bun-common, touches no public
API, keeps `fetch()` and served requests on one code path, and has a measured
speedup on the one scenario that is slow today (param-random 7.8k → 40.0k, 5.1×; bun-nest 6.6k → 31.7k) with no
change beyond noise elsewhere. Its evidence is
already a prototype that passes both packages' suites unchanged.

### 10.5 Go/no-go

Measured against the current adapter, same machine, same run, `bench/run.ts`
medians:

- **Any routing PR ships** only if it improves its target scenario by
  **≥ 10%**, regresses no other scenario by more than **5%** (the observed
  round-to-round spread on a quiet machine is 3–8%, `results/bench-full.json`),
  and shows **0 breaks** in both suites and the differential fuzz, with its
  negative control failing. PR-1 meets this on param-random [M]; PR-2 must
  show it on `static`/`param`/`middleware` after its semantics spike.
- **Native dispatch (approach 1, behind `nativeRoutes: true`) reopens** only
  if, on a future Bun, `spikes/dispatch-only.ts` shows **`adapter(lean)
  route-get` ≥ 10% above `adapter(lean) fetch`** (median of 3, both paths), and
  the prototype then beats the index build on `static`, `param` and
  `middleware` by ≥ 10%. Today it shows −4% to 0% [M].

## 11. Rollout and phased delivery

No flag is needed for PR-1: it changes no behaviour, only the cost of a miss,
and ships default-on with the differential test as its guard. PR-2 changes
internal timing (no promise where there was one) but no observable state, and
also ships default-on once its spike and suites agree; if the spike finds an
observable difference that cannot be removed, it becomes an option
(`request.fastPath`, default off) instead [D]. PR-3 is opt-in by nature.

Effort is sized from what the prototypes took: the index and ring-cache
prototype was ~210 lines and a morning; the native prototype ~340 lines plus a test harness and a
day.

| Phase | PR | What | Depends on | Effort |
|---|---|---|---|---|
| A | **PR-1** | Candidate index in `BunRouter.getMatchedLayers()` miss path; original route indices kept; lazy rebuild; `clearRouteCache()` drops it. Ring-buffer FIFO eviction for the route cache. Tests: unit tests of the disjointness rule, the differential fuzz moved into `packages/bun-common/__tests__/` (fetch-based, seconds, fixed seeds, `routeSpecificity` on and off, cache on and off) with its negative control, and a `benchmarks/dispatch.ts` `cardinality` check. | — | 2–3 d |
| A | **PR-2a** | Spike: the observable-state list for a bodiless, query-less, cookie-less request, before/after, on both suites. Output: a go/no-go note on PR-2b. | — | 0.5–1 d |
| A | **PR-2b** | Parse fast path in `BunRequest`. Tests: every field and event from PR-2a, both adapters, `bun test --randomize`. Bench: `static`/`param`/`middleware` vs PR-1. | PR-2a | 2–3 d |
| B | **PR-3** | Static responses: README section on `server.routes` (every method, no middleware, ETag), optional `staticRoute()` with a shadowing warning. | — | 0.5–1 d |
| C | **PR-4** | `handle()` fast path (§4.5): measure first with a micro-benchmark; ship only against the go/no-go. | PR-1, PR-2b | 2–4 d (includes the measurement; may end in "no") |
| — | none | Approach 1 (`nativeRoutes`): not scheduled. The prototype and harness stay in the evidence folder; §10.5 says when to reopen. If the maintainer wants it anyway (Q1), it is ~5–7 d: both adapters' `listen()`, a `getMatchedLayers` candidates parameter, the guard, key eligibility, debounced reload, the three-mode suite run in CI. | — | (5–7 d) |

**Total recommended: ~7–12 d**, of which PR-1 (2–3 d) alone removes the only
routing cliff and PR-2 carries most of the rest of the gain.

Each PR runs the repo's gate: `bun scripts/typecheck.ts`, `bunx eslint .` in
the package, `bun test` and `bun test --randomize` in bun-common and bun-nest,
and `bun run-all.ts` in `examples/bun-nest` (routing is shared).

## 12. Typed overloads, `fetch()` parity and the tests

- **Typed-route overloads** are untouched by every recommended PR: they are
  compile-time only and sit on the registration API, which nothing here
  changes. `generate-verb-overloads.ts --check` stays in the gate.
- **`fetch()` parity.** Under PR-1 and PR-2 `fetch()` and a served request
  still share `handleNativeRequest` and `getMatchedLayers`, so `fetch.test.ts`'s
  parity assertion keeps its meaning. Under approach 1 it would not: `fetch()`
  cannot reach Bun's table (Bun's matcher is not callable in process [B]), so
  parity would have to be asserted served-vs-`fetch()`, as
  `prototype/tests/run-tests.ts` does (it runs each suite with `fetch()` over a
  real socket, with and without the native table, and diffs the outcomes).
- **The tests.** PR-1 brings the differential fuzz into the repo with its
  negative control, so a future change to the disjointness rule cannot pass by
  accident. The prototype's three-mode harness
  (`prototype/tests/run-tests.ts`, a `--preload` that swaps the adapter class
  in the packages' own test files) is kept in the evidence folder as the
  re-test kit for §10.5.

## 13. Risks and open questions

### 13.1 Risks

| Risk | Mitigation |
|---|---|
| The disjointness rule claims a route disjoint when routejs would match it | The rule only excludes on a plain literal mismatch or a plain length mismatch; anything with routejs syntax is kept. The fuzz includes regex, optional, wildcard, param-prefix `use()`, case variants, `%` escapes and dot segments, and its negative control shows it detects an over-eager rule [T]. |
| A future routejs change (new syntax character) | The syntax set is one constant; PR-1's unit tests enumerate routejs's tokens (`*`, `+`, `?`, `:`, `(`, `)`, `\`) [S]. |
| PR-2 changes a timing someone relies on (`await req.ready()` ordering, `data`/`end` events) | PR-2a's field-and-event list; both suites; `--randomize`. |
| Benchmark noise on a shared machine | Interleaved rounds, medians, recorded load, a 10% threshold (§10.5). |
| Bun changes route dispatch cost | §10.5's reopen criterion; the spike re-runs in seconds. |

### 13.2 Open questions for the maintainer

| # | Question | Default if unanswered |
|---|---|---|
| Q1 | Accept "no native dispatch on this Bun", or still want `nativeRoutes: true` as an experimental, measured-not-faster option? | No. |
| Q2 | Today a `HEAD` request to a GET-only route returns **404** [M] (§3). Bun answers it with the GET handler [M], and Express 5 is documented to as well [U, not checked here]. Intended? It is outside this plan, but surfaced by it. | Leave as is; separate issue. |
| Q3 | PR-2: is making `BunRequest.init()` synchronous for a request with nothing to parse acceptable, given `init()` is public? It already returns `BunRequest \| Promise<BunRequest>`. | Yes, if PR-2a finds no observable difference. |
| Q4 | With misses at ~1.7 µs, is a 50,000-entry cache still worth its memory? A hit is ~0.5 µs (§2), so the cache still pays, but a smaller default would do. | Leave the default; measure memory in PR-1. |
| Q5 | PR-3: a named `staticRoute()` method, or documentation of `server.routes` only? | Documentation only. |
| Q6 | Extend the bun-jobs benchmark regression guard (`--compare` against a baseline) to the router benchmarks? | Yes, with PR-1's `cardinality` scenario. |
| Q7 | The three Bun reproductions (§14): file them upstream? | Your call; nothing filed. |

## 14. Bun behaviour worth reporting upstream

Each has a minimal reproduction with no code of ours, in
[`evidence/bun-native-routes/bun-repros/`](evidence/bun-native-routes/bun-repros/),
and its output in `results/repro-*.txt`. Searches of oven-sh/bun issues
(2026-09-28: "routes dot segments", "routes normalize url", "routes .. params",
"routes many routes slow", "routes quadratic", "HttpRouter", "routes ../",
"route params hash") found no existing report of the first two. **Filed
2026-09-29:** the first as
[oven-sh/bun#44176](https://github.com/oven-sh/bun/issues/44176), the second as
[oven-sh/bun#44177](https://github.com/oven-sh/bun/issues/44177), and the third
added as a
[comment on #41363](https://github.com/oven-sh/bun/issues/41363#issuecomment-5880415977)
rather than a duplicate. Once a fix ships in the Bun version we require,
re-run `bun-repros/` and revisit the path-shape guard (§5) and the
sibling-scaling advice.

1. **`raw-target-routing.ts`** — `routes` matches the raw request-target while
   `req.url` is normalised. Raw `/public/..` and `/public/%2e%2e` reach
   `/public/:file` with `file: ".."` and `req.url` `/`; raw `/public/../admin`
   reaches `fetch` with `req.url` `/admin` although an `/admin` route exists;
   a raw `#frag` lands inside the param. The route chosen and `req.url` disagree,
   which matters to any path-based authorisation done in a route. [M]
2. **`sibling-scaling.ts`** — build time quadratic and lookup time linear in
   sibling position (uWS `HttpRouter` child vectors [B]). A performance
   characteristic rather than a correctness bug; reportable as such. [M]
3. **`mid-segment-param.ts`** — `/mid/:a-:b` is accepted and reports
   `{ b: "1-2" }`. Related to feature request #41363 (mixed segments); the bug
   is the silent acceptance with a wrong name. [M]

Known and already tracked, so not repeated: `reload()` without `routes` drops
static routes (open PR #41577); trailing slash (#17363); optional params
(#17491); wildcard params (#23999); literal segments not decoded (#37603) [B].

Incidental, ours: the route cache's FIFO eviction is O(deletions) (§2; not a
Bun bug, V8 behaves the same); `benchmarks/dispatch.ts`'s comments still give
the cache default as 2,000 (it is 50,000 [S]); and `adapter.fetch("//")` throws `Invalid URL` from
`toNativeRequest` (a bare path starting `//` is read as protocol-relative) [T]
(found by the fuzz; worked around there by passing absolute URLs).

## 15. Evidence index

All under [`evidence/bun-native-routes/`](evidence/bun-native-routes/). None of
it is in `scripts/typecheck.ts` or the workspaces; each folder has a
`tsconfig.json` so an editor resolves it.

| Path | What |
|---|---|
| `survey.md` | Bun `routes`, `reload()`, Elysia and Hono, from pinned sources |
| `spikes/semantics.ts`, `syntax.ts`, `dot-segments.ts` | What Bun's router accepts and how it matches |
| `spikes/bunrouter-baseline.ts` | The same probes against today's adapter |
| `spikes/scaling.ts`, `scaling-order.ts`, `build-cost.ts` | Lookup and build cost by table size and order |
| `spikes/reload.ts` | `reload()` cost, atomicity, WebSockets, a reload storm |
| `spikes/dispatch-only.ts` | Route vs `fetch` dispatch, same pipeline |
| `bench/servers.ts`, `nest-app.ts`, `run.ts` | The benchmark: targets, scenarios, runner (`--verify`) |
| `bench/breakdown.ts` | Per-stage cost, in process |
| `prototype/native-routes.ts`, `adapter.ts` | Approach 1, as a subclass (no library change) |
| `prototype/candidate-index.ts` | Approach 6a: the index, and `RingFifoCache` |
| `bench/miss-cost.ts`, `spikes/map-fifo.ts` | A miss's two costs; the `Map` FIFO eviction alone, in Bun and Node |
| `prototype/bench-target.ts` | The prototypes as benchmark targets |
| `prototype/tests/sanity.test.ts` | Approach 1 end to end |
| `prototype/tests/differential.test.ts` | The fuzz (`BNR_MODE=native\|index`, `BNR_NOCACHE`, negative controls) |
| `prototype/tests/preload.ts`, `run-tests.ts` | The packages' own suites against the prototypes |
| `bun-repros/` | Minimal Bun reproductions (§14) |
| `results/` | Every output quoted in this plan; `bench-full.*` is the main run, `bench-index-rc.*` the PR-1 run, `bench-ceiling-quick.log` the one-round ceiling run |

To re-run: `bun install` at the root and in `benchmarks/`; then from
`docs/plans/evidence/bun-native-routes/`, `bun bench/run.ts --verify`, `bun
bench/run.ts --out results/bench-full.json`, and `bun test
prototype/tests/` (with `BNR_SEEDS`, `BNR_MODE` as documented in each file).
