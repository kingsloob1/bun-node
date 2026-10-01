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

**Addendum, 2026-10-01: server-sent events (§16).** Planned on `develop` at
`fb0eceb`, same Bun build. A streaming body is just a `Response`, so SSE works
on every dispatch path this plan discusses. §16 measures what works today
(NestJS's own `@Sse()` already streams on bun-nest), the gaps found (a hang, a
12-second cut-off, a swallowed error), and proposes `res.sse()` and friends.
Its evidence is under
[`evidence/bun-native-routes/sse/`](evidence/bun-native-routes/sse/).

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
16. [Server-sent events (SSE) helpers](#16-server-sent-events-sse-helpers)

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
| `sse/` | §16: SSE spikes, the helper prototype and its tests, the fan-out benchmark; outputs in `sse/results/` (indexed in §16.13) |

To re-run: `bun install` at the root and in `benchmarks/`; then from
`docs/plans/evidence/bun-native-routes/`, `bun bench/run.ts --verify`, `bun
bench/run.ts --out results/bench-full.json`, and `bun test
prototype/tests/` (with `BNR_SEEDS`, `BNR_MODE` as documented in each file).

## 16. Server-sent events (SSE) helpers

Added 2026-10-01 against `develop` at `fb0eceb`, on the same Bun build
(`1.4.3-canary.1+5f554969b`). The request: "expose SSE helpers for both
httpAdapter and nest". **Plan only; no library code changed.** Every probe is
in [`evidence/bun-native-routes/sse/`](evidence/bun-native-routes/sse/), each
with its command and its output in `sse/results/`. The markings are the ones
defined under "How to read the markings" at the top.

### 16.1 The short answer

An event stream is a `Response` whose body is a `ReadableStream`, so SSE needs
nothing from Bun's router and works on every path this plan discusses: `fetch`,
a native route, and the socket-free `fetch()`. Most of the plumbing already
exists. bun-common's `res.write()` streams, `compression()` flushes each event
of a `text/event-stream`, and **NestJS's own `@Sse()` already streams on
bun-nest**, served and through `adapter.fetch()` [M]. What is missing is
correctness at the edges, plus an API that makes the right thing the default.

| # | Decision | Why |
|---|---|---|
| 1 | **Fix four streaming bugs first (PR-sse1), before any new API.** | Each is measured, and each hits `@Sse()` or plain `res.write()` today (§16.2). Two of them are one-line fixes, and a runtime patch of those two passes both suites [T]. |
| 2 | **Add `res.sse()` and a standalone `sseResponse()` to bun-common (PR-sse2).** | They open the stream with a first chunk, exempt it from `idleTimeout`, send heartbeats, honour backpressure, bound a slow client's queue and stop on disconnect. Getting any of these wrong by hand fails silently (§16.2). |
| 3 | **For bun-nest, `@Sse()` is the API; ship no new decorator (PR-sse3).** | It works today. After PR-sse1 it also survives errors and silence [T]. `@Res() res.sse()` covers imperative use for free, because `@Res()` is a `BunResponse`. |
| 4 | **Put the wire format in a dependency-free `@kingsleyweb/bun-common/sse` entry, and later lift bun-jobs' parser into it.** | That gives one implementation of the framing rules, which bun-jobs can import (it already depends on bun-common), and a browser-safe entry. |

### 16.2 What works today, and what does not

**bun-common**, a hand-written stream (`setHeader` + `res.write`), events 200 ms
apart (`sse/common-sse.ts`, `results/common-sse.txt`) [M]:

| Case | Result |
|---|---|
| Handler starts a producer and returns (the README pattern) | streams live: events at 208 / 407 / 607 ms |
| **Handler `await`s its own producer** | **held back**: headers at 601 ms, all three events at 602 ms. The same in `adapter.fetch()` and `router.fetch()`. With the prototype helper too (`prototype-sse.test.ts`, "TODAY'S GAP") |
| `flushHeaders()`, first event 500 ms later | `fetch()` resolves only at 501 ms: Bun holds the header block until the first body chunk (as `remote-transports.md` §2.1 found) |
| A `: open` comment first | headers at 1 ms |
| `router.fetch()` / `adapter.fetch()`, no socket | stream live, same timings as served |
| `requestTimeout` 300 ms, a 1 s stream | unaffected once the stream is open |
| `requestTimeout` 300 ms, first write at 500 ms | **500 at 302 ms**: the timeout covers the wait for the first chunk |
| `compression()`, `Accept-Encoding: gzip` | gzip, one flush per event (205 / 404 / 605 ms) |
| Client disconnects | `req.signal` abort, `res` `close` and `req.socket` `close`, all at once; a later `write()` returns `false` |
| `adapter.close()` (`server.stop(true)`) with a stream open | the client gets "socket closed unexpectedly" 2 ms later; the server sees abort and `close` |
| **Write, then throw / `next(err)` / an async throw** | **the error handler never runs (0 calls) and the stream stays open**: the client is still waiting at 1.5 s, in all four shapes |
| `Last-Event-ID` | `req.get("last-event-id")` reads it |

The reference for that last row is Express 5.2.1, on Bun's `node:http`
(`sse/express-after-headers.ts`): the error handler **runs** with
`res.headersSent === true`, and the default handler (finalhandler 2.1.1)
destroys the socket, so the client sees the stream end abruptly [M].
BunRouter's loop breaks as soon as `response.headersSent` is true, before
error mode is consulted (`BunRouter.ts:4657`, `:4817`) [S], so the error is
dropped. CLAUDE.md asks for Express 5 semantics; this is a deviation, and on a
stream it is a leak.

**bun-nest**, NestJS 11.1.27's `@Sse()` (`sse/nest-sse.ts`,
`results/nest-sse.txt`) [M]:

| Case | Result |
|---|---|
| `interval(200)` × 3 | live: 209 / 408 / 610 ms; Nest's own headers (`text/event-stream`, `no-cache, no-store, … no-transform`, `x-accel-buffering: no`) |
| `adapter.fetch()` after `app.init()`, no socket | live, same timings; `@Res()` streams too |
| Multi-line `data`, `id`, `retry` | split per line; `id` and `retry` kept |
| `data: ""` or `data: 0` | **dropped by Nest's encoder** (`message.data ? …`, `sse-stream.js`) [B]; the client sees an event with only `id:`. Nest's own behaviour, not ours |
| Observable errors after one event | `event: error`, `data: after`, then the stream ends |
| **Observable errors before the first event, or the handler throws** | **hangs** until Bun's `idleTimeout` resets the connection (the client saw the reset at 24 s). On platform-express this is a 500 |
| Client disconnects | unsubscribed within 1 ms |
| `app.close()` with a stream open | the stream ends (client error), and the subscription is torn down |
| **One event, then silence** | **cut at 12.0 s** (`idle-timeout.ts`) |
| `@Headers("last-event-id")` | works |
| `@Res() res`, imperative `res.write` | live |

The hang's cause [S][T]: `SseStream`'s constructor calls
`req.socket.setKeepAlive(true)` before anything is sent. `BunResponse.isLongLived` is
`req.isKeepAlive || _isLongLived`, and `headersSent` returns `isLongLived`. So
from then on `send()` returns early (`if (this.headersSent) return this`), and
the exception filter's 500 goes nowhere. (`adapter.isHeadersSent()` peeks at
the native response instead, and returns `false`; the two disagree.)

The cut-off's cause [S][M]: Node's idiom for "no timeout", which `SseStream`
also calls, is `req.socket.setTimeout(0)`. On our socket shim it is a no-op
(`BunRequest.ts:1588`). Bun's own exemption is `server.timeout(req, 0)`.

**Both fixes, proven** (`sse/nest-fixes.ts`, `results/nest-fixes.txt`). The
fixes are applied as a runtime patch (`sse/fixes-preload.ts`): `headersSent`
stops counting keep-alive, and `socket.setTimeout(0)` calls
`server.timeout(request, 0)`. Run unpatched (the negative control), both
failing cases give "no response within 3 s" and the quiet stream is cut at
12.0 s. Run patched, both are a `500` with Nest's JSON in 12 ms, and the quiet
stream is still open after 16 s [T]. With the same patch preloaded, bun-nest's
suite passes 245 of 245 and bun-common's passes 1,137 of 1,138
(`results/fixes-suites.txt`) [T]. The one failure is the test that pins the
old behaviour ("reports isLongLived only once setKeepAlive(true) is called"
asserts `headersSent` is `true` after `setKeepAlive(true)`), which PR-sse1
changes deliberately.

**Bun's idle timeout** (`sse/idle-timeout.ts`, `results/idle-timeout.txt`;
default `idleTimeout` 10 s, watched 30 s) [M]:

| Stream | Outcome |
|---|---|
| raw `Bun.serve`, silent after one comment | cut at 12.0 s |
| raw, `server.timeout(req, 0)` | survived |
| adapter, silent after one comment | cut at 12.0 s |
| adapter, `: ping` every 5 s / every 9 s | survived / survived |
| adapter, `req.server.timeout(req.request, 0)` | survived |
| adapter, `req.socket.setTimeout(0)` (the Node idiom) | **cut at 12.0 s** |
| adapter, handler never writes | reset at 12.0 s |
| bun-nest `@Sse()`, one event then silent | **cut at 12.0 s** |
| prototype `sse()` helper, no heartbeat | survived |

The 12.0 s, rather than 10 s, is Bun's 4-second timer granularity
(`remote-transports` evidence, cross-cutting finding 1) [M]. So a heartbeat
alone keeps a stream alive only if its interval stays under `idleTimeout`, and
the default is 10 s. That is why the helper does both. It always exempts the
request, so a heartbeat is free to be as slow as proxies allow: nginx's
`proxy_read_timeout` defaults to 60 s [U].

### 16.3 Proposed API: bun-common

All names are proposals; §16.12 tabulates them for approval. The prototype in
`sse/prototype-sse.ts` implements each one outside the package, and
`sse/prototype-sse.test.ts` passes 10 of 10 [T].

```ts
import { encodeSseEvent, sseResponse } from "@kingsleyweb/bun-common/sse";

// 1. Imperative, on the response (bun-common and, through @Res(), bun-nest)
app.get("/events", (req, res) => {
  const stream = res.sse({ heartbeatMs: 15_000 }); // headers, ": ok", exemption
  const off = feed.subscribe(async (item) => {
    if (!(await stream.send({ event: "item", id: item.seq, data: item }))) off(); // false = closed
  });
  stream.onClose(off);               // client gone, server closing, or stream.close()
  stream.lastEventId;                // the request's Last-Event-ID, or undefined
});

// 2. Declarative: any async iterable, any route, or a native route
app.get("/ticks", (_req, res) => res.send(sseResponse(ticks())));
Bun.serve({ routes: { "/raw": (req, server) => sseResponse(ticks(), { request: req, server }) } });

// 3. The wire format alone, for broadcasting one event to many streams
const bytes = encodeSseEvent({ event: "price", data: { p: 101.5 } }); // encode once
for (const s of subscribers) void s.send(bytes);
```

What `res.sse()` does, and why each step [D, each backed by §16.2]:

1. Sets `Content-Type: text/event-stream`, `Cache-Control: no-cache` (S7 below
   asks about adding `no-transform`) and `X-Accel-Buffering: no`, unless the
   handler already set them. It never sets `Connection`, which HTTP/2 forbids.
2. Calls `req.server.timeout(req.request, 0)` when the server has `timeout`. The
   socket-free stub has none (`BunRouter.ts`, `fetchStubServer`) [S]; PR-sse1
   gives the stub a no-op `timeout`.
3. Enqueues `: ok` at once, because Bun sends no header block before the first
   chunk.
4. Returns an `SseWriter` (prototype name `SseStream`), which has the
   following members:
   - `send(message | Uint8Array): Promise<boolean>` resolves at once while
     under the high-water mark, and otherwise once the client has read; it
     resolves `false` once the stream is closed.
   - `comment(text)`, `close()`, `closed`, `onClose(fn)`, `signal` (aborts on
     close) and `lastEventId`.
5. Runs a heartbeat comment every `heartbeatMs` (default 15 000; `0` turns it
   off) and stops it on close.
6. Closes on `req.signal` abort.
7. Bounds the queue. Past `maxQueuedBytes` (default 8 MiB) a client that stopped
   reading is disconnected, not buffered without limit (§16.9).
8. Produces the response at once with a streaming body, so the adapter
   returns it even while the handler is still awaiting (PR-sse1 fix 3).

`sseResponse(source, init?)` is the same writer without a `BunResponse`. The
source is an async iterable of `SseMessage`, or a `(writer) => …` callback. It
returns a `Response` for `res.send()`, a native route, `Bun.serve`'s `fetch`, or
a test. `encodeSseEvent`/`formatSseEvent` are the framing alone.

**What is deliberately not proposed:**

- A `req.lastEventId` on `BunRequest`: the header is one `req.get()` away, and
  the writer carries it (S6).
- A generator-returning-handler convention like Elysia's: our handlers return
  nothing, and `res.send(sseResponse(gen()))` says the same thing explicitly.
- Retrying or replaying missed events: resumption is the application's (it owns
  the ids). The helper only surfaces `Last-Event-ID` and can send `retry`.

### 16.4 Proposed API: bun-nest

**NestJS's `@Sse()` is the API, and it needs no bun-nest code.** It already
streams; the two failures in §16.2 are bun-common bugs, fixed in PR-sse1, and
bun-nest inherits the fixes. NestJS needs these from the adapter and objects
[S] (`router-response-controller.js`, `sse-stream.js`, `@nestjs/core` 11.1.27):

| NestJS calls | bun-nest today |
|---|---|
| `response.writableEnded` | `BunResponse` has no `writableEnded`: `undefined`, which is falsy, so it proceeds [S]. Worth adding as a getter in PR-sse1 (Node semantics) |
| `request.socket.setKeepAlive(true)`, `setNoDelay(true)` | shimmed; `setKeepAlive` is what makes `headersSent` lie (fix 1) |
| `request.socket.setTimeout(0)` | a no-op; should exempt the request (fix 2) |
| `request.socket.once/removeListener("close")` | works: bridged from `req.signal` [M] |
| `stream.pipe(response)`, i.e. `on("unpipe"/"close"/"finish")`, `emit("pipe")`, `write`, `end` | works [M] |
| `response.writeHead(status, headers)`, `flushHeaders()` | works; but headers reach the wire only with the first chunk, which Nest writes at once (`\n`) [M] |
| The exception filter's `reply` / `isHeadersSent` | works once fix 1 lands [T] |
| An adapter that returns the response before the handler's promise settles | bun-nest has it (`BunHttpAdapter.ts:366-390`); bun-common does not (fix 3) |

**Imperative use** needs nothing new either. `@Res() res: BunResponse` then
`res.sse()` is the bun-common API. N7 shows `@Res()` streaming today [M].

**Optional, not recommended:** a bun-nest `@SseStream()` parameter decorator
that injects the writer. It would duplicate `@Res()`, and it would take the
handler out of Nest's interceptor path for the response, as `@Res()` does.

### 16.5 Wire format and headers

The WHATWG HTML Standard, "Server-sent events" (§9.2) [B, not pinned]. These
are the encoder's rules, each a unit test in PR-sse2 (and in the prototype
[T]):

- One `data:` line per line of the payload, split on CRLF, CR or LF (all three
  are line ends to a parser). A non-string is `JSON.stringify`ed first. `""`
  and `0` are sent (`data: ` / `data: 0`), unlike Nest.
- Each event ends in a blank line (`\n\n`). The encoder emits LF only.
- `event` and `id` must not contain CR or LF, and `id` must not contain NUL
  (the parser ignores such an id). They are rejected with a `TypeError` rather
  than silently sanitised as Nest does, because a silent rewrite breaks
  resumption.
- `retry` is a non-negative integer of milliseconds.
- A comment is `: text`. The heartbeat is an empty comment (`:`).
- The byte order mark is never sent.

**Headers.** `text/event-stream` (UTF-8 is implied), `Cache-Control: no-cache`
and `X-Accel-Buffering: no` (nginx). NestJS adds `no-store, must-revalidate,
max-age=0, no-transform`, `Pragma`, `Expire` and `Connection: keep-alive`.
`no-transform` matters: our `compression()` skips any response that carries it
(`compression.ts:1014`) [S], so Nest's streams are never compressed and ours
would be.

**Compression.** `compression()` already flushes after every chunk of a
`text/event-stream` [M] (case F, and the prototype test through `res.send`).
Leaving it to the middleware is therefore safe. S7 asks whether the helper
should opt out by default anyway, via `no-transform`, as proxies that transform
also tend to buffer (`remote-transports.md` §2.2).

**HTTP/1.1 and HTTP/2.** Bun serves h2 when given `http2: true` and `tls`
(experimental since 1.4.1); the adapter's `server` option passes both through.
An event stream arrived intact over h2 raw, through the adapter, and with
Nest's `Connection: keep-alive` set, which h2 forbids and Bun evidently drops
(`sse/h2.ts`, `results/h2.txt`) [M]. Per-event timing over h2 was not measured
[U]. Browsers cap HTTP/1.1 at about six connections per origin, so each
`EventSource` tab costs one; h2 multiplexes them [U, browser behaviour].

**CORS.** `cors()` headers set before the first chunk go out with it, for
`res.write` and for the helper (`sse/cors.ts`) [M]. `EventSource` with
`withCredentials` needs a specific origin and
`Access-Control-Allow-Credentials: true`, which `cors({ origin, credentials })`
gives; nothing SSE-specific is needed.

**Reconnection.** On reconnect the browser resends the last `id` as
`Last-Event-ID` and waits `retry` ms first. The server's part is to send ids
and to read the header. The writer exposes `lastEventId` and sends `retry:` on
request, and nothing more (§16.3, "not proposed").

### 16.6 Lifecycle

| Event | Today | After PR-sse1 / PR-sse2 |
|---|---|---|
| Client disconnects | `req.signal`, `res` `close`, `req.socket` `close`; writes return `false` [M] | plus the writer's `onClose`, `signal`; `send()` resolves `false` [T] |
| `adapter.close()` / `app.close()` | `stop(true)` cuts every stream at once; the client sees a connection error, the server an abort [M] | unchanged. A graceful drain (a final `event: close`, then end) is S9 |
| Bun `idleTimeout` | cuts a quiet stream at 12 s [M] | the helper and `socket.setTimeout(0)` exempt it [T] |
| The adapter's `requestTimeout` | does not apply once a stream is open; does apply before the first chunk [M] | unchanged; `res.sse()` writes its first chunk at once, so it is never hit |
| Error before the first chunk | bun-common: an ordinary error, 500 [I]. bun-nest `@Sse()`: **hang** [M] | 500 everywhere [T] |
| Error after the first chunk, through the router | **dropped; the stream stays open** [M] | Express: the error handlers run with `headersSent` true; still unhandled, the stream is aborted, which the client sees as a cut connection (Express destroys the socket) [D] |
| Error inside `sseResponse`'s source | — | the stream closes. An `event: error` is sent only through an `onError` option, so no message leaks by default (S5) [D] |
| A handler that awaits its stream | bun-common: everything is **held until it returns** [M]. bun-nest: streams a `write()` stream [M] | the adapter and `router.fetch()` return the response as soon as it has a streaming body, as bun-nest does for `write()`; the pipeline keeps running, and its later error goes to the row above [D] |

**Fix 3's precise rule** [D], ported from bun-nest's `handleNativeRequest`:
while the pipeline is pending, race it against "a native response exists and
its body is a stream". That covers a long-lived `write()` stream, which is
bun-nest's condition today (`res.isLongLived`), and also `send()` of a
`ReadableStream`, Node `Readable` or async iterable. The prototype helper sends
its stream that way, and is held today ("TODAY'S GAP" test) [T]. This is the
bun-nest code, widened, with its logging moved to the structured logger:
`logger.error(msg, { error })`, where bun-nest today passes `error.stack` as a
second string. Responses with a buffered body are untouched, so the PR-1/PR-2
fast paths (`settledResponse`) keep their shape. bun-nest adopts the widened
condition too.

### 16.7 `fetch()` parity, the tests, and bun-jobs' parser

- **Parity holds by construction.** The helper is a `ReadableStream` body that
  `send()` turns into a `Response`, on the same `handleNativeRequest` and
  `handle()` path. `router.fetch()` and `adapter.fetch()` return the streaming
  `Response`, and a test can read events as they arrive (D1, D2, N10) [M]. The
  one parity gap today is the awaiting handler (held in both modes), which fix
  3 closes for both.
- **The test reader.** Bun has no `EventSource` at runtime, although bun-types
  declares one (`remote-transports` evidence §2.1) [M]. So tests need a reader:
  `readSse(body)`, an async iterable of parsed events. Phase 2's PR-2a2 is
  writing exactly that for bun-jobs, as `lib/remote/protocol/sse.ts`. It
  follows the WHATWG interpretation algorithm (CR/LF/CRLF across chunks, BOM,
  `retry` digits only, NUL in `id`) and has a length bound. It is in progress
  in its own worktree and imports nothing [S, read-only].
- **How the two relate.** The writer and the parser are two halves of one
  format. They live apart now because of the dependency direction: bun-jobs
  depends on bun-common, never the reverse. The recommendation (S8) is not to
  block PR-2a2. Instead, once it merges, PR-sse2 lifts `SseParser`/`readSse`
  **verbatim** into `bun-common/lib/sse/`, with its tests and vectors, and
  bun-jobs imports them from `@kingsleyweb/bun-common/sse` (a follow-up owned
  by the Phase 2 session, PR-sse5). The encoder's tests then round-trip
  through the real parser, so the two halves cannot drift. If PR-sse2 lands
  first, it ships the encoder and a test-only reader, and the lift happens in
  PR-sse5 either way. bun-jobs' `EventSource` ban test stays in bun-jobs.
- **Why a subpath.** `lib/sse/` imports nothing (web streams only), so
  `@kingsleyweb/bun-common/sse` can be a browser-safe entry, checked under
  `browser` in `consumer-check.json` like bun-jobs' `api/contract`. That lets
  bun-jobs' protocol code import it without pulling bun-common's server
  surface. The packaging recipe's rules apply: one explicit `exports` key, and
  a `consumer-check.json` spelling.
- **Test conventions.** Idle-timeout tests use `idleTimeout: 1`, which Bun cuts
  at 4.0 s, rather than the default 12 s. Disconnect tests wait on the writer's
  `onClose`, not on time. A served-versus-`fetch()` pair covers each helper.

### 16.8 Native routes, and this plan's PR-1 to PR-4

- **Native routes.** A function route returning `sseResponse(…, { request,
  server })` streams like any other `Response`; the route handler receives the
  `server` the exemption needs. A static `Response` route cannot stream per
  client (§4.8), so the helper is no use there. `nativeRoutes: true` is not
  scheduled (§10.5); if it ever is, SSE needs nothing from it.
- **PR-1 (candidate index).** Independent; no shared code.
- **PR-2 (parse fast path).** Independent, though `BunRequest` is touched by
  both (PR-sse1 changes the socket shim's `setTimeout`). Land in either order.
- **PR-3 (static responses).** Its README section should say that SSE needs a
  function route.
- **PR-4 (`handle()` fast path).** **Shares code with PR-sse1**: fix 4 changes
  what `handle()` does once `headersSent` is true. PR-sse1 should land first,
  and PR-4's differential must then include "error after headers" cases.

### 16.9 Performance and limits

**Fan-out.** `sse/perf.ts` runs one server process per cell. The server
broadcasts a 58-byte event to every open stream, 100 events per stream per
macrotask, and N raw-TCP clients count events until each has M (`perf-clients.ts`).
Medians of 3 interleaved rounds, on a shared machine (load 13.8–18.0 during the
run), `results/perf.txt` and `perf.json` [M]:

| Target | ev/s, 100 × 1,000 | ev/s, 1,000 × 100 | idle KiB per conn (1,000) |
|---|---:|---:|---:|
| raw `Bun.serve`, `ReadableStream`, default strategy | 907,195 | 542,076 | 2.0 |
| raw, 64 KiB byte-length strategy | **2,475,964** | **2,082,509** | 5.6 |
| raw, `type: "direct"`, flush per macrotask | 887,764 | 572,008 | 2.5 |
| bun-common `res.write` | 477,927 | 317,228 | 14.6 |
| **bun-common + prototype `sse()`** | **1,913,324** | **1,581,690** | 17.1 |
| bun-nest `@Sse()` (`Subject`) | 201,125 | 137,041 | 29.6 |

Reading it [M unless marked]:

- **The queuing strategy is the largest lever.** The same raw server is 2.7× to
  3.8× faster with a 64 KiB byte-length high-water mark than with the default
  (one chunk). The prototype uses that strategy, and through the full adapter
  it reaches 77% of the best raw figure at 100 clients and 76% at 1,000. That
  is 4× to 5× `res.write`, whose stream has a one-chunk mark and a `Map` of
  pending chunks keyed by `Bun.nanoseconds()` strings (`BunResponse.ts:1345`,
  `:1468`) [S]. Moving `res.write` onto the writer's queue is part of PR-sse2,
  measured against this table (S10).
- **bun-nest's `@Sse()`** costs Nest's per-subscriber formatting and an rxjs
  `concatMap` promise per event (`router-response-controller.js`) [S]. It is
  still ~137k events/s across 1,000 clients. Apps that broadcast heavily can
  use `@Res() res.sse()` with a pre-encoded event.
- **Memory per idle connection** is our wrappers: ~2 KiB raw, ~15–17 KiB through
  bun-common (`BunRequest` + `BunResponse` + the stream), ~30 KiB through Nest.
  That is ~17 MiB per 1,000 idle streams. The 100-client idle figures are below
  RSS noise (some are negative), so only the 1,000-client column is quoted.
- `type: "direct"` was not faster here, with one flush per macrotask [M]. It
  is not proposed.

**A client that stops reading** (`sse/backpressure.ts`: a socket with a 64 KiB
receive buffer that never reads; 64 MiB of distinct 1 KiB events offered over
4 s) [M]:

| Writer | Accepted | Server RSS |
|---|---:|---:|
| raw, `enqueue` regardless | 64.0 MiB | +68.1 MiB |
| raw, produce only on `pull` | 4.1 MiB | ~0 |
| bun-common `res.write` (always returns `true`) | 64.0 MiB | **+80.0 MiB** |
| prototype, `await send()` | 4.1 MiB | +3.2 MiB |
| prototype, `send()` not awaited | closed at 12.1 MiB (8 MiB queued + buffers) | +19.1 MiB |
| bun-nest `@Sse()` | 64.0 MiB | +35.3 MiB |

Bun propagates backpressure: a pull-based stream stops at ~4 MiB in flight, as
`remote-transports.md` §2.1 found [M]. `res.write()` and Nest's path ignore it,
so **one stalled client can grow the server without bound**. The writer's
awaitable `send()` plus `maxQueuedBytes` is the fix for code that uses it.
`res.write()` keeps Node's contract (it returns `true` while it buffers). For
`@Sse()`, PR-sse3 documents the risk and S10 asks whether `res.write()` should
start returning `false` past the high-water mark, as Node's does.

### 16.10 Prior art, briefly

| Library | What it does | What we copy |
|---|---|---|
| NestJS 11.1.27 `@Sse()` [B] | `Observable<MessageEvent>`; `SseStream` (a Node `Transform`) pipes into the raw response; header block committed on the next macrotask with a bare `\n`; `event: error` after headers; auto `id` | nothing to copy; we make it work (§16.4). We do **not** copy dropping falsy `data` |
| Express 5.2.1 [B][M] | no helper: `res.write` by hand; errors after headers reach error handlers, then finalhandler destroys the socket | the error semantics (fix 4) |
| Hono 4.12.21 `streamSSE(c, cb, onError)` [B] | a `TransformStream`; `writeSSE` awaits the writer (backpressure); splits data on CR/LF/CRLF; throws on CR/LF in `event`/`id`/`retry`; `onAbort`; an error calls `onError`, then sends `event: error` and closes | awaited writes, the field validation, `onError` |
| Elysia 1.4.28 `sse()` [B] | a generator handler; yielded values framed as `data:`; sets `transfer-encoding: chunked`, `cache-control: no-cache`, `connection: keep-alive` | the async-iterable source (`sseResponse(gen())`) |
| better-sse [U, not read] | sessions and channels (broadcast), keep-alive pings, `Last-Event-ID` | channels are out of scope; `encodeSseEvent` is the broadcast primitive |
| Fastify [U, not read] | writes to `reply.raw`, or uses a plugin | nothing |

### 16.11 PR slicing

| PR | What | Depends on | Effort | Package / tarball |
|---|---|---|---|---|
| **PR-sse1** | **Streaming correctness in bun-common.** (1) `headersSent` stops counting `socket.setKeepAlive`. (2) `socket.setTimeout(0)` calls `server.timeout(request, 0)`; the fetch stub gets a no-op `timeout`. (3) The adapter and `router.fetch()` return a response with a streaming body at once (bun-nest's race, ported and widened; bun-nest takes the wider condition too). (4) An error after headers runs the error handlers, and if still unhandled aborts the stream. (5) `res.writableEnded`. Tests: every §16.2 row, served and `fetch()`; `@Sse()` edge tests in bun-nest; `--randomize` | — | 2–3 d | bun-common, plus a few lines in bun-nest's adapter; no new export; no size change |
| **PR-sse2** | **The helpers.** `lib/sse/`: `formatSseEvent`, `encodeSseEvent`, `SseWriter`, `sseResponse`, the test reader (or the lifted parser, §16.7); `res.sse()`; the `./sse` subpath (exports, `consumer-check.json` incl. `browser`); `res.write` on the byte-length queue if S10 says yes; README "Server-sent events"; a fan-out benchmark guard | PR-sse1 | 3–4 d | bun-common; ~9 KB source (prototype 8.5 KB), ~4 KB of declarations [I]; no dependency |
| **PR-sse3** | **bun-nest.** README section: `@Sse()` is supported, with its edges (Nest's encoder drops falsy `data`; the idle exemption; `app.close()` cuts streams); `@Res() res.sse()` for imperative use; the backpressure caveat | PR-sse1 (PR-sse2 for the `res.sse()` docs) | 0.5–1 d | bun-nest docs and tests only |
| **PR-sse4** | **Docs and examples**: a change report to the examples session. `examples/bun-common/05-response/files-and-streams.ts` gains `res.sse()`. The stale line in `examples/bun-nest/02-http-adapter/controllers-and-routing.ts` ("`@Sse()` fails …") is wrong today [M] and must go. A new bun-nest `@Sse()` example | PR-sse2, PR-sse3 | 0.5 d here; the examples session's own time | examples only |
| PR-sse5 | **bun-jobs** imports the parser (and, for its executor's `http-stream` writer, the encoder) from `@kingsleyweb/bun-common/sse` | PR-2a2, PR-sse2 | 0.5 d | Phase 2 session |

**Total: ~6–8.5 d** (here, excluding the examples session and PR-sse5).
PR-sse1 alone makes `@Sse()` production-safe.

- **Reviewers.** The maintainer, for every PR. The examples session reviews
  PR-sse4, as the owner of `examples/**`. The Phase 2 session reviews PR-sse5
  and the parser lift in PR-sse2.
- **UI impact.** None: bun-jobs-ui and bun-jobs use no SSE today (grep for
  `event-stream`/`EventSource` in their `lib/` and `app/` finds nothing) [S].
  No parsed README table is touched.
- **The gate** for each PR is the usual one: `bun scripts/typecheck.ts`, `CI=1
  bunx eslint .` in each package, `bun test` and `bun test --randomize` in
  bun-common and bun-nest, `bun run-all.ts` in `examples/bun-common` and
  `examples/bun-nest`, and for PR-sse2 `bun scripts/consumer-check.ts
  packages/bun-common`.
- **Order against PR-1 to PR-4:** independent of PR-1 to PR-3, and ahead of
  PR-4 (§16.8). It can start now.

### 16.12 Open questions, names, risks

**Open questions**, each with the recommended answer. **Decided by the user
on 2026-10-01:** every recommendation below was accepted. The names are
confirmed again with each PR.

| # | Question | Recommended |
|---|---|---|
| S1 | Approve the names below? | As proposed, with `SseWriter` rather than `SseStream`, which is NestJS's internal class name |
| S2 | Should `res.sse()` send an opening `: ok` comment by default? | Yes: without a first chunk the client cannot see the headers (§16.2) |
| S3 | Heartbeat default? | 15 s, `0` to disable. The request is exempt from `idleTimeout` anyway; the heartbeat is for proxies, and for noticing dead peers |
| S4 | Slow-client policy? | Awaitable `send()`, plus disconnect past `maxQueuedBytes` (default 8 MiB). No "drop events" mode in v1 |
| S5 | What does an error from `sseResponse`'s source send? | Nothing by default: close the stream and log. With an `onError(error, writer)` option, the app decides (Hono's shape). Nest's `event: error` with the raw message is not copied |
| S6 | `req.lastEventId` on `BunRequest`? | No: `req.get("last-event-id")` and `writer.lastEventId` cover it |
| S7 | Should the helper send `no-transform` (opting out of `compression()` and proxy transforms)? | Yes, by default, matching Nest and `remote-transports.md`. `{ compress: true }` drops it |
| S8 | Lift PR-2a2's parser into `bun-common/sse` once it merges? | Yes, verbatim, with its vectors; bun-jobs imports it (PR-sse5) |
| S9 | Should `adapter.close()` end streams gracefully (a final event, then end) rather than cut them? | Not in v1: it matches Express's and Nest's `close()`. Revisit with a `closeStreams` option if asked |
| S10 | Move `res.write()` onto the byte-length queue (measured 4–5× on fan-out), and return `false` past the high-water mark as Node does? | Yes to the queue in PR-sse2, if `res.write`'s tests stay green. `false` past the mark too: it is Node's contract, and `drain` is already emitted |
| S11 | PR-sse1 changes three behaviours someone might rely on: `headersSent` after `setKeepAlive(true)`, an awaiting handler's response timing, and errors after headers. Accept them as bug fixes in a minor version? | Yes. Each is a deviation from Node or Express, and the packages are unpublished |

**Names needing approval:**

| Proposed | Kind | Where | Alternatives |
|---|---|---|---|
| `res.sse(options?)` | method | `BunResponse` | `res.eventStream()`, `res.startSse()` |
| `SseWriter` | class | `bun-common/sse` | `SseStream` (prototype; clashes with Nest's), `EventStreamWriter` |
| `SseMessage` | type | `bun-common/sse` | `SseEvent` (taken by PR-2a2's parsed event), `ServerSentEvent` |
| `SseWriterOptions` (`heartbeatMs`, `highWaterMark`, `maxQueuedBytes`, `open`, `compress`, `onError`) | type | `bun-common/sse` | `keepAliveMs`, `pingMs` for `heartbeatMs` |
| `sseResponse(source, init?)` | function | `bun-common/sse` | `createSseResponse`, `toSseResponse` |
| `formatSseEvent`, `encodeSseEvent` | functions | `bun-common/sse` | `serializeSse` |
| `readSse`, `SseParser` | function, class | `bun-common/sse` | keep PR-2a2's names |
| `writer.onClose`, `.signal`, `.lastEventId`, `.closed` | members | `SseWriter` | `on("close")` |
| `@kingsleyweb/bun-common/sse` | entry | packaging | root only |
| `res.writableEnded` | getter | `BunResponse` | none (Node's name) |

**Risks:**

| Risk | Mitigation |
|---|---|
| Fix 1 changes `headersSent` for any code calling `setKeepAlive(true)` | Patched, both suites pass except the test that pins the old value [T]; Node never ties the two |
| Fix 3 changes when an awaiting streaming handler's error surfaces | Fix 4 defines it (Express's); tests for both, served and `fetch()` |
| Fix 4 changes `handle()`, which PR-4 will optimise | PR-sse1 first; PR-4's differential gains after-headers cases |
| An exempt stream to a dead peer (NAT, sleeping laptop) never times out | The heartbeat write fails eventually and closes it; `heartbeatMs` is on by default |
| Proxies buffer (nginx, Cloudflare, ALB) | `X-Accel-Buffering: no`, `no-transform`, and an opening comment; documented per proxy [U, not tested here] |
| Bun later sends headers before the first chunk, or changes the 4 s idle granularity | Harmless: the comment and the exemption are still correct. The spikes re-run in a minute |
| bun-common's stream wrapper costs ~15 KiB per idle connection | Measured, documented; `sseResponse` on a native route avoids the wrappers where that matters |
| The perf figures were taken on a loaded, shared machine | Ratios within each round are the claim, not absolutes; `perf.json` keeps every run |

### 16.13 Evidence

All under [`evidence/bun-native-routes/sse/`](evidence/bun-native-routes/sse/),
run from the repository root after `bun install` (and `bun install` in
`benchmarks/` for the Express probe). Outputs in `sse/results/`.

| File | What | Output |
|---|---|---|
| `common-sse.ts` | bun-common streaming today, cases A–J (§16.2) | `common-sse.txt` |
| `express-after-headers.ts` | Express 5.2.1's error-after-headers semantics | `express-after-headers.txt` |
| `nest-sse.ts` | `@Sse()` on bun-nest, N1–N10 | `nest-sse.txt` |
| `nest-fixes.ts`, `fixes-preload.ts` | fixes 1 and 2 as a runtime patch, with a negative control (`--no-patch`); the preload runs both suites | `nest-fixes.txt`, `fixes-suites.txt` |
| `idle-timeout.ts` | `idleTimeout` against quiet streams, ten ways (~30 s) | `idle-timeout.txt` |
| `prototype-sse.ts`, `prototype-sse.test.ts` | the proposed helpers, outside the package, and their tests (`bun test …/prototype-sse.test.ts`) | `prototype-sse-test.txt` |
| `perf.ts`, `perf-server.ts`, `perf-clients.ts` | the fan-out benchmark (`SSE_SHAPES`, `SSE_TARGETS` to narrow) | `perf.txt`, `perf.json` |
| `backpressure.ts` | a stalled client against each writer | `backpressure.txt` |
| `h2.ts` | SSE over HTTP/2 (needs `openssl`, `curl`) | `h2.txt` |
| `cors.ts` | `cors()` headers on a stream | `cors.txt` |
| `lib.ts` | the timestamped event reader the probes share | — |
