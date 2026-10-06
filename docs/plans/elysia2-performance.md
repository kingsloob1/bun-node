# Elysia 2's throughput: what bun-common and bun-nest can take from it

This plan asks how **Elysia 2** (2.0.0-beta.21) serves 1.6× bun-common's
requests per second on the same Bun, and which of its techniques bun-common
and bun-nest can adopt **without giving up the Express 5 contract**: a mutable
`req`/`res` every middleware may read, `next()`, error handlers by arity,
`next('route')`, and the rest of [CLAUDE.md](../../CLAUDE.md#router--express-5-semantics).

It follows [bun-native-routes.md](bun-native-routes.md), whose §17 left
bun-common at 62–82% of Elysia 2 on the cached scenarios, 50% on
`param-random` and 60% on `json`, and named the rest of the gap as "the cost
of the Express contract". This plan takes that apart: Elysia 2's source read
end to end, each technique measured in isolation against bun-common's
equivalent step, and the ones that survive the Express contract turned into
PRs with go/no-go thresholds. ("§17" below always means bun-native-routes
§17; every other section number is this plan's.)

Written 2026-10-03 against `claude/wizardly-feynman-c72eec` at `ae1a7cc`, on
Bun **1.4.2** (`744846f8`), a 4-vCPU Xeon @ 2.80 GHz (the machine of §17).
Elysia 2's `dist/` and Elysia 1.4.28's are the copies in
`benchmarks/node_modules`. **No library code was changed.** All the evidence
is under [`evidence/elysia2/`](evidence/elysia2/), and every figure was taken
in process against a snapshot of `ae1a7cc` (the working tree was being edited
by another session at the time; the snapshot recipe is in its
[README](evidence/elysia2/README.md)).

**The answer, in one line:** Elysia 2's speed comes from doing almost nothing
per request that a route does not need, and the Express contract forbids only
the *static proof* of what a route needs, not the *laziness* that makes it
cheap. Most of the gap is recoverable without breaking semantics, and the
largest single pieces are not where §17 looked for them: a bodiless request still runs
bun-nest's async body-parser middleware (**~2.8 µs of a ~10.7 µs** in-process
Nest request), and every asynchronous layer is waited on through a promise,
a timer-free race and a subscription that cost **~1.8 µs** where Elysia's
compiled async tail costs 0.47 µs.

### Contents

1. [Executive summary](#1-executive-summary)
2. [Where a request's time goes: Elysia 2 beside bun-common](#2-where-a-requests-time-goes-elysia-2-beside-bun-common)
3. [How Elysia 2 serves a request](#3-how-elysia-2-serves-a-request)
4. [The techniques, one by one](#4-the-techniques-one-by-one)
5. [bun-nest specifics](#5-bun-nest-specifics)
6. [Ranked PRs, phases and go/no-go](#6-ranked-prs-phases-and-gono-go)
7. [What is not worth copying, and why](#7-what-is-not-worth-copying-and-why)
8. [Risks and open questions](#8-risks-and-open-questions)
9. [Evidence index](#9-evidence-index)

### How to read the markings

| Tag | Meaning |
|---|---|
| **[M]** | Measured on this machine, on this Bun, by a script in [`evidence/elysia2/`](evidence/elysia2/). The script is named; its output is in `results/`. |
| **[S]** | Read from source: this repository at `ae1a7cc`, or a dependency at the version installed in `node_modules` (Elysia 2.0.0-beta.21 `dist/`, memoirist 1.2.2, @nestjs/core 11.1.27, Express 5.2.1, body-parser 2.2.2). File and line are given. |
| **[I]** | Inference: reasoning from the facts above. Not a finding. |
| **[U]** | Unverified. Nothing may rest on it without a check. |
| **[D]** | A design proposal of this plan. |

**The rule the recommendations follow** (as in bun-native-routes.md): every
recommended step rests on [M] or [S]. Anything [I] or [U] is labelled and
carries no step on its own. Every end-to-end gain below is an *estimate*
from an in-process measurement (§2.4 says how they relate); each PR's
go/no-go is the end-to-end `wrk-run.ts` figure, not the estimate.

---

## 1. Executive summary

### The one-paragraph version

Elysia 2 does not use Bun's native router for its routes. It serves every
request through one `fetch` that builds a six-field context, slices the path
out of the URL, finds a static route in a dictionary or a dynamic one in a
radix tree, and calls a per-route function compiled on the route's first
request. That function contains only what the route's handler and hooks can
reach: a route whose handler reads nothing parses nothing, has no `try`
around a parse, allocates no headers, and returns `new Response(value)`. In
process that is **0.93 µs for `GET /static` against bun-common's 2.66 µs and
bun-nest's 10.67 µs** [M]. Elysia's *static* proof of what a route reads
(`sucrose`, a tokenizer over `Function.prototype.toString`) cannot be
copied: in the Express model any middleware may read anything, and Elysia
itself gives up and parses everything as soon as a hook passes its context to
another function — which the benchmark's own middleware route does [M]
(§3.4). But its *effects* can be had exactly, by laziness at access time
(Express 5's own `req.query` is a getter [S]), by not building per-layer
machinery for the common synchronous case, by not caching what will never be
looked up again, and by waiting on an asynchronous handler with one
promise instead of three. Ten such changes are ranked below and phased in §6;
for bun-nest, one change alone — letting a bodiless request skip the
body-parser middleware synchronously, exactly as body-parser itself does [S]
— is worth an estimated **+11% to +25%** on every bun-nest GET scenario.

### Headline numbers

In process, ns per request, median of 3 fresh processes (each best of 5),
`NODE_ENV=production` ([`inproc-matrix.ts`](evidence/elysia2/inproc-matrix.ts),
`results/inproc-matrix.txt`) [M]. The `wrk` row of each target is §17's
end-to-end figure, for scale.

| ns per request (in process) | static | param | middleware | routes-1000 | param-random | json |
|---|---:|---:|---:|---:|---:|---:|
| raw `fetch`, hand-written | 658 | 782 | 706 | 879 | 1,155 | 2,583 |
| **Elysia 2** | **926** | **1,057** | **1,837** | **1,234** | **1,918** | **4,404** |
| Elysia 1.4.28 (`app.fetch`, not its native table) | 753 | 935 | 2,830 | 1,152 | 1,534 | 4,018 |
| **bun-common** (`ae1a7cc`) | **2,664** | **2,984** | **3,418** | **3,143** | **8,868** | **10,640** |
| **bun-nest** (`ae1a7cc`) | **10,670** | **11,769** | **13,012** | **12,523** | **19,657** | **21,643** |
| *§17 `wrk`, req/s: Elysia 2* | *49,434* | *47,538* | *34,262* | *46,475* | *46,818* | *25,130* |
| *§17 `wrk`, req/s: bun-common* | *30,511* | *30,549* | *27,971* | *29,440* | *23,538* | *14,979* |
| *§17 `wrk`, req/s: bun-nest* | *17,627* | *16,901* | *15,799* | *16,797* | *13,609* | *10,632* |

### The ten opportunities, ranked by expected gain

"In process" is measured [M]. "End to end" converts it at the 2×–4× this
machine has shown for bun-common's own code (§2.4) and is an estimate [I];
routing work converts at 1.5×, the ratio measured for it.

| # | Opportunity | Measured in process | Est. end to end, target scenario | Owner | Section |
|---|---|---:|---|---|---|
| 1 | JSON body: read with `request.json()`-class cost when nothing needs the raw bytes | `BunRequest.init` of a small JSON POST **10.0 µs** vs `await request.json()` **0.48 µs** over the `Request` floor | `json` +26% (2×) to the Elysia 2 figure (4×) | main session | §4.6 |
| 2 | **bun-nest: bodiless requests skip the parser middleware synchronously** | **−2.8 µs** static, −2.9 param, −2.7 middleware, −3.3 routes-1000, −4.3 param-random (upper bound: `bodyParser: false`) | bun-nest GETs **+11% (2×) to +25% (4×)** | this plan | §5.3 |
| 3 | **Wait on an async layer with one promise** (no per-wait `new Promise`, subscription array, or second wait in the adapter) | `await`-ing handler: **2.85 µs → 1.06–1.18 µs** (router); +0.6 µs adapter wrapper | bun-nest GETs **+8% (2×) to +18% (4×)**; any async Express handler | this plan | §4.4 |
| 4 | Lazy `BunRequest` state (headers, URL parts, query, cookies, params) | `BunRequest.init` defaults **0.89–1.44 µs** vs Elysia's context **0.06 µs** | all GETs +6% (2×) to +14% (4×) | main session | §4.1 |
| 5 | **Route-cache admission:** stop caching one-off paths | fresh path: **4.19 µs** today vs **2.36 µs** with no insert; cached paths unchanged | `param-random` **+7% to +12%** (1.5×) | this plan | §4.2 |
| 6 | **A faster uncached match** (precomputed per-route layers, cheaper candidates) | uncached lookup **1.87 µs** (0.62 candidates, 0.48 regex + params, ~0.7 layer arrays) vs memoirist **0.31 µs** | `param-random` +5% (1.5×), on top of #5 | this plan | §4.2 |
| 7 | **A synchronous fast loop** in `dispatch` for the common case, falling back to `#runPipeline` | 0 layers **1,070 → 761 ns**; 3 `use()` **1,463 → 967 ns**; 10 **2,072 → 1,394 ns** | `static`/`param` +2–4%, `middleware` +3–6% | this plan | §4.3 |
| 8 | **Headers set through `res.set()`**: cut the JS around `Headers` (not the `Headers` itself) | 3 headers + send: **2,334 ns** vs the same `Headers` built by hand **1,292 ns** | not on the bench; ~+6% (2×) on a CORS-style app | this plan | §4.5 |
| 9 | **Hot-path string hygiene**: path once from the URL, `method`/`originalUrl` cached, params decoded only when `%` | `host`+`method`+`originalUrl` **285 ns** vs Elysia's `extractPath` **63 ns**; decode **−112 ns** per param on a miss | +1–2% everywhere | this plan, with main session | §4.7 |
| 10 | Fewer, smaller per-request objects (`BunResponse` cold state, the options object, pipeline state) | `new BunResponse` **117 ns**, 31 fields / 320 B vs Elysia's 6 fields / 64 B (+48 B `set`) | small in process; the gap roughly doubles under cache pressure (§2.4) | this plan | §4.8 |

### The decisions it rests on

| # | Decision | Why |
|---|---|---|
| 1 | **Do not copy sucrose (static inference over `Function.toString`).** | It is Elysia's mechanism for skipping work, but Express's middleware model defeats it: Elysia infers "everything" for any hook that passes its context to a function, and then parses query, headers and cookies and schedules a microtask per request ([`emitted.txt`](evidence/elysia2/results/emitted.txt), the `/mw/hit` route) [M][S]. Lazy getters give the same skip exactly, at access time. |
| 2 | **Do not generate code with `new Function`.** | The win of a compiled route is the *absence* of generic machinery; a plain-JS fast path gets most of it (#7: −0.3 to −0.7 µs [M]), and Elysia itself returns plain closures, not generated code, for its simplest routes (`createInlineHandler`, jit.mjs:157-162, 574-596) [S]. |
| 3 | **Keep `Headers`; cut what surrounds it.** | Elysia's null-prototype header record is *slower* on Bun 1.4.2 than a `Headers` object (1,340 vs 1,292 ns for three headers; tuples 1,593 ns) [M]. The 1 µs to recover is bun-common's own `set()`/`send()` logic. |
| 4 | **Put bun-nest's two changes first.** | They are exact by construction (body-parser skips a bodiless request before anything else, read.js:50-55 [S]; the async-wait change keeps every observable behaviour), small, and worth more than any bun-common change on the bench. |
| 5 | **Gate every PR on `wrk-run.ts`, not on these estimates.** | In-process savings have converted at 1.5× to 7× end to end on this machine (§2.4) [M]; the spread is too wide to promise a figure. |

### Status since the measurements (`85423c1`)

While this plan was written the main session landed `5381f49` (rarely-read
`BunRequest`/`BunResponse` state held lazily, including 23 of
`BunResponse`'s stream, event and upgrade fields — most of #10's
`BunResponse` half) and `32ce0f3` (a body read in one native call and parsed
synchronously: `BunRequest.init` on a small JSON POST 8.4 → 5.3 µs by its
own measure, `wrk` `json` 15.9k → 19.1k req/s — part of #1). Re-measured on
a snapshot of `85423c1` (`results/inproc-matrix-85423c1.txt`,
`micro2-wait-85423c1.txt`, `nest-breakdown-85423c1.txt`) [M]:

| ns, in process | static | param | middleware | routes-1000 | param-random | json |
|---|---:|---:|---:|---:|---:|---:|
| bun-common | 3,072 | 2,896 | 3,787 | 3,214 | 9,347 | 9,353 |
| bun-nest | 10,913 | 12,592 | 14,443 | 13,904 | 21,370 | 20,711 |
| bun-nest, `bodyParser: false` | 8,180 | 10,310 | 12,402 | 10,595 | 17,012 | 17,816 |

The GET figures did not move beyond this run's noise (the machine was busier
than for the main matrix); `json` fell 1.3 µs. **#2 (−2.7 µs on bun-nest
GETs) and #3 are unchanged by those commits**: the bodiless parser still
costs 2.0–4.4 µs per bun-nest request, and `dispatch` on an awaited handler
is 1,967 ns against 845–1,169 ns for the prototypes (floor 838 ns). The rest
of this plan cites `ae1a7cc` figures; the ranking holds at `85423c1`.

### What this plan is not

- **Not a case for dropping the wrappers.** `BunRequest`/`BunResponse` are
  the product (bun-native-routes §4.9); every change here keeps them and their
  observable state.
- **Not the main session's work.** Lazy `BunRequest` fields and the JSON body
  fast path are being done concurrently; they are sized here (#1, #4) so the
  ranking is complete, and their design notes are inputs, not instructions.
- **Not native routing.** Elysia 2 itself moved *off* Bun's route table for
  function handlers (§3.1, against Elysia 1.4's `mapRoutes`), which agrees
  with bun-native-routes §1.

---

## 2. Where a request's time goes: Elysia 2 beside bun-common

### 2.1 One request, stage by stage

`GET /user/42` (1,001 routes registered), cumulative ns, each stage timed on
its own, best of 5 × 200k ([`breakdown.ts`](evidence/elysia2/breakdown.ts),
`results/breakdown.txt`) [M]. Elysia's stages replay what its source does
(fetch.mjs `createFetchHandler`, context.mjs, memoirist); its last row is its
real `app.fetch`. bun-common's stages are the adapter's own calls.

| Stage | Elysia 2 | | bun-common | |
|---|---:|---|---:|---|
| `new Request(url)` (the floor, not ours) | 277 | | 290 | |
| the per-request object(s) | 353 | `new Context` + `extractPath` (+76) | 1,961 | `BunRequest.init` defaults (+1,437), `new BunResponse` (+234) |
| route lookup | 632 | static-map miss + `memoirist.find` (+279) | 2,439 | `host`/`method`/`originalUrl` + `getMatchedLayers` cache hit (+478) |
| handler + response | 950 | handler + `new Response(value)` (+318) | 3,866 | `dispatch`: pipeline, handler, `res.send` (+1,427) |
| **whole request** | **1,227** | real `app.fetch` | **3,946** | real `serveNativeRequest` |

Reading it [M]:

- **The wrapper objects are the largest single difference**: +1.67 µs
  against +0.08 µs. `BunRequest.init` with the adapter's defaults is
  0.89 µs on a reused native request and 1.44 µs on a fresh one
  (`micro.ts` A; `breakdown.txt`), because a fresh `Request` materialises
  `headers` (+127–247 ns) and `body` (+104–125 ns) on first read, and the
  constructor reads both ([`first-access.ts`](evidence/elysia2/first-access.ts)) [M].
  Elysia's fast lane reads only `url` and `method`.
- **The lookup is not the problem on a hit**: 0.14 µs for `getMatchedLayers`
  (`micro.ts` C) against 0.16 µs for `memoirist.find`. What costs is the
  string work around it: `host` + `method` + `originalUrl` are 285 ns
  against Elysia's 63 ns `extractPath` (`micro.ts` B) [M].
- **The pipeline and the response** cost 1.43 µs against 0.32 µs.
  `new BunResponse` + `send('ok')` is 562 ns against 270 ns for
  `new Response('ok')`; the rest is `#runPipeline`'s per-request and
  per-layer machinery (§4.3) [M].
- Elysia's real `fetch` costs 0.28 µs more than the replay: its `withOrigin`
  wrapper, the `try` in its fetch handler, and its route function's own
  `try`/`instanceof Error` checks (fetch.mjs:330-339, jit.mjs:157-162) [S].

### 2.2 Whole requests, every scenario

The headline table (§1). Per scenario, bun-common's in-process excess over
Elysia 2 is 1.74 / 1.93 / 1.58 / 1.91 / 6.95 / 6.24 µs (static, param,
middleware, routes-1000, param-random, json) [M]. The two outliers are
param-random (the route cache, §4.2) and json (body parsing, §4.6). The
CPU profiles say the same thing in another form
([`profile.ts`](evidence/elysia2/profile.ts), `results/prof/`) [M]: Elysia 2
spends **66%** of its static request inside Bun's own `Request` and
`Response` constructors (34.3% + 31.9%), bun-common **28%** (16.3% + 12.0%),
the rest spread over ~40 of its own functions, none above 5%.

### 2.3 bun-nest

`GET /static` on bun-nest, in process
([`nest-breakdown.ts`](evidence/elysia2/nest-breakdown.ts), `results/nest-breakdown.txt`) [M]:

| | Nest's default (body parser on) | `bodyParser: false` |
|---|---:|---:|
| whole adapter path (`serveNativeRequest`) | 10,432 | 7,842 |
| `BunRequest.init` + `new BunResponse` | 1,748 | 1,870 |
| + `router.dispatch` (bun-common pipeline, incl. `#waitLayer`) | 9,780 | 7,219 |
| Nest's own route callback, called directly and awaited | 4,908 | 5,352 |

So a bun-nest GET is roughly: **1.8 µs** of request/response objects,
**~3.3 µs** of Nest's own async chain (`RouterProxy` → execution context →
interceptors consumer → pipes → response controller → `reply`), **~1.9 µs**
of bun-common waiting for that chain (§4.4), **~0.6 µs** of the adapter's
second wait, and **~2.6 µs** of a body-parser middleware that has no body to
parse (§5) [M]. The matrix variant agrees: `bun-nest-nobp` is 2.8 µs faster
on static, 2.9 on param, 2.7 on middleware, 3.3 on routes-1000 and 4.3 on
param-random (`results/inproc-variants.txt`) [M].

### 2.4 Why the in-process gap understates the served one

The in-process gap between bun-common and Elysia 2 is 1.6–7.0 µs; the
end-to-end gap in §17 is 6.6–27.0 µs [M, both]. Per scenario the ratio is
7.2 / 6.1 / 4.2 / 6.5 / 3.0 / 4.3. Inside bun-common the ratio is smaller:
param-random against routes-1000 is 5.7 µs in process and 8.5 µs end to end
(1.5×); bun-nest against bun-common static is 8.0 µs and 24.0 µs (3.0×).

Two experiments on the cause:

- **Not CPU pinning or `--smol`.** Pinning the in-process run to one core
  (`taskset -c 3`) changed nothing beyond noise, nor did the `--smol` this
  shell exports (`results/smol.txt`) [M].
- **Cache pressure, at least in part.** Walking a 1 MiB buffer between
  requests (`POLLUTE=1048576`, a crude stand-in for the socket and kernel
  work a served request is interleaved with) roughly doubles bun-common's
  excess over Elysia 2: static 2.2 → 3.4–7.4 µs (median 4.8), param 2.1 →
  3.8–4.6 µs (`results/inproc-pollute.txt`, 3 rounds each) [M]. Over the
  `Request` floor, Elysia's own cost grows by ~1.6 µs (0.6 → 2.2) and
  bun-common's by ~4.1 µs (2.8 → 6.9). bun-common touches ~40
  functions and two objects of 31–50 fields per request (`sizes.ts`:
  432 B and 320 B shallow, against Elysia's 64 B context and 48 B `set`)
  [M]; under eviction, footprint costs more than its in-process time
  suggests [I].

A same-process served probe ([`served.ts`](evidence/elysia2/served.ts)) was
tried to measure served-only costs (Bun materialising a served request's
headers lazily from uWS) and could not resolve them: ~37–64 µs of loopback
round trip per request in this VM, ±3 µs between rounds
(`results/served-static.txt`). Served-only costs stay **[U]**.

**How this plan converts** [I]: an in-process saving in bun-common's own
request path is budgeted at **2×** end to end (conservative: below every
cross-framework ratio, above the routing-only one) with **4×** as the
central case; a routing-only saving at **1.5×**. These are for ranking. Each
PR's go/no-go is a `wrk-run.ts` measurement.

---

## 3. How Elysia 2 serves a request

Read from `benchmarks/node_modules/elysia2/dist/` (readable ESM, no source
maps needed) [S] unless marked. Paths below are relative to that `dist/`.

### 3.1 `Bun.serve`: `fetch` for everything, native routes only for constants

- **`listen()` starts the server with a gated `fetch`** that queues requests
  until the app is built (`adapter/bun/index.mjs:216-243`), then **publishes
  with `server.reload(serve)`** once the routes are compiled
  (`publish`, :518-546). Function handlers are never native routes.
- **Native routes are used for two things only**: HTML bundles
  (`collectHTMLBundleRoutes`, :106-148) and **static values**: a route whose
  handler is *not a function* (`.get("/", "ok")` or a `Response`) and whose
  pipeline has no hooks is turned into a prebuilt `Response` in Bun's table
  (`collectStaticRoutes`, :149-212; `buildNativeStaticResponse`,
  compile/handler/index.mjs:204-230). It is off when any `onRequest` or
  trace hook or HOC exists (:153). The benchmark's handlers are functions, so
  **none of its routes is native**.
- **Contrast, Elysia 1.4.28** registered every route in Bun's table
  (`mapRoutes(app)` merged into `routes`, `dist/adapter/bun/index.mjs`
  ~:158-218), which is what gave it Bun's sibling scan at 1,000 routes
  (bun-native-routes §17). Elysia 2 dropped it.
- **`withOrigin`** (:63-70) stores the native `Request` in a module slot for
  the synchronous part of `fetch`, so the route can tell it is Bun's own
  request and **defer reading `request.signal`** (which Bun materialises
  lazily; `adapter/origin.mjs`). Measured here: the first `signal` read on a
  fresh request is **639–690 ns** [M] (`first-access.ts`). bun-common never
  reads `signal` on its hot path [S] (`BunRequest.ts:1477,1510` are an event
  bridge and `aborted`), so there is nothing to copy (§7).

### 3.2 What runs per request

`createFetchHandler` (handler/fetch.mjs:104-340) picks **one of four fetch
functions at build time**: with trace hooks, with async `onRequest` hooks,
with sync ones, or none. With none (the benchmark) it is ten lines
(:330-339, arguments abridged):

```js
return (request, server) => {
  const context = new Context(request);
  extractPath(request.url, context);
  context.server = server ?? null;
  try { return findRoute(context, request, map, router, …); }
  catch (error) { return fail(context, error); }
};
```

- **The context** (context.mjs:51-70) is one class instance per request whose
  constructor writes `request` and `set = { headers: Object.create(null),
  status, cookie }`; the fetch handler then adds `qi`, `path`, `server`, and
  `findRoute` adds `params` for a dynamic route. Decorators, `store`,
  `status()`, `redirect()` live on the **prototype** (`buildDecorator`,
  :18-23), never copied per request. Six fields, always in the same order,
  so the shape is monomorphic [S]; replayed, it costs **58 ns** (`micro.ts`
  A) [M].
- **The path** is two `indexOf`s and a `slice` on `request.url`
  (`extractPath`, fetch.mjs:13-17, `authorityEnd` utils.mjs:638); the query's
  start index is kept in `context.qi` for a later parse. **63 ns** [M].
- **`findRoute`** (fetch.mjs:69-103): `map[method][path]` (a null-prototype
  dictionary of static routes), a trailing-slash retry, `map['*']`, then
  `router.find(method, path)` for dynamic routes; params are
  `decodeURIComponent`ed **only when the path contains `%`** (:97, :30-36).
- **Not found** returns a **cached `Response`'s `.clone()`**
  (handler/utils.mjs:31-35); `emptyResponse` likewise (:9).
- **The route function is compiled on first use.** `handler()` (base.mjs
  :1247-1270) returns a trampoline to `#jitDispatch` (:1312-1345), which
  compiles the route, stores the result in the static map (or the radix
  store) and calls it; later requests call the compiled function directly.
  In production without `precompile`, the JIT's bookkeeping is released once
  every route has run (`#publishGeneration`, :1484-1521).

### 3.3 Routing: a dictionary and a radix tree, no cache

- **Static paths** go into `~map[method][path]` (base.mjs `#buildRouterUnsafe`,
  :1523-1636; :1617-1621 for the plain case). One property read: **27 ns**
  [M] (`micro.ts` C).
- **Dynamic paths** go into **memoirist 1.2.2**, a radix tree whose children
  are indexed by the next character code (`node.inert[charCode]`) and whose
  param nodes slice up to the next `/` (memoirist `dist/index.mjs`
  `matchRoute`, :235-299). Lookup is O(path length), independent of the
  number of routes: **157 ns** for `/r999/7` with 1,001 routes, **311 ns**
  for a fresh id (string included) [M].
- **There is no cache.** A fresh path costs what a repeated one does. That
  is why Elysia 2's `routes-1000` and `param-random` sit beside its `static`
  (46.5k / 46.8k / 49.4k req/s, §17) [M].

### 3.4 The compile step

`compileHandler` (compile/handler/index.mjs:404-527) resolves the route's
hooks, then takes the cheapest of three exits:

1. **Context-free routes** (:478-490): a GET/HEAD handler with no hooks whose
   source matches `/^(?:async\s*)?\(\s*\)\s*=>/` (`isBareArrow`, :402) gets
   `createInlineHandler(compact, handler)` (jit.mjs:157-162): call, reject an
   `Error`, map the value. The benchmark's `/static` takes this exit.
2. **Inline closures** (jit.mjs:574-596): after the JIT has *built* the
   source, if the only helpers it linked are the response mapper (and
   `forwardError`), the source is discarded and the same kind of closure is
   returned. The benchmark's `/user/:id` and `/r<i>/:id` take this exit (the
   emitted source in `results/emitted.txt` is printed by the test hook
   before this check).
3. **Generated code** (jit.mjs:163-597): a `function route(c){…}` string
   assembled from the route's hooks and `new Function`'d with its helpers as
   parameters (:597).

**What decides what the code does** is `describeRoute`
(compile/handler/descriptor.mjs:66-169) over **sucrose's inference**
(sucrose.mjs:230-283): it tokenizes the source of the handler *and every
hook* (`inferFunction`, :61-219) and records which context members
(`query`, `headers`, `body`, `cookie`, `set`, `route`, `defer`) the first
parameter is read for. **Anything it cannot follow means "everything"**: a
`toString` override, `arguments`/`eval`, a template literal touching the
context, a computed key it cannot resolve — and passing the context itself
to a function (:197-216). From that:

- `query` read → `c.query = parseQueryFromURL(url, c.qi)` (jit.mjs:267-280);
  `headers` → `c.headers = request.headers.toJSON()` (:281-285); `cookie` →
  a deferred-decode jar (:321-358); body only for non-GET/HEAD methods whose
  code reads `body` or declares a schema/parser (descriptor.mjs:77-78).
- **Sync or async** (descriptor.mjs:114-122): the route function is `async`
  only if something forces it (a body to parse, an async handler or hook…).
  Otherwise it is synchronous with an **async tail**: each call site checks
  `typeof r?.then === 'function'` and, only then, jumps into a generated
  `async function _t(c, _rk, …)` that resumes at that site
  (`awaitSite`, compile/handler/utils.mjs:389-396). A synchronous request
  never creates a promise.
- **Response mode** (descriptor.mjs:126-128): `compact` when nothing can set
  headers/status/cookies (`mapCompactResponse`), `set` otherwise.

**The benchmark's routes, as compiled** (`emitted.ts`,
`results/emitted.txt`) [M]:

- `/static`, `/user/:id`, `/r<i>/:id`: inline closures, no generated code.
- `/json` (POST, reads `body`): `async function route(c)` that reads
  `content-type`, checks `content-length`/`transfer-encoding`
  (`hasRequestBody`, compile/handler/utils.mjs:35-40), and awaits
  `request.json()`; the result goes through `mapCompactResponse`.
- `/mw/hit` (three `beforeHandle` hooks that call `bump(ctx)`): **sucrose
  gives up** (the context is passed to a function), so the generated route
  **parses the query, builds `headers` with `toJSON()`, parses cookies**,
  checks the abort signal between hooks, and schedules an `afterResponse`
  drain with `queueMicrotask` on every request. This is the benchmark's
  most Express-like route, and it is where Elysia 2 is slowest (1.84 µs in
  process, 34.3k req/s end to end) and bun-common closest (82%) [M].

### 3.5 Hooks

- `derive` is promoted to `beforeHandle` (`promoteDerive`, index.mjs:77-88);
  `resolve` likewise. Each `beforeHandle` becomes an inline call; a non-
  `undefined` return short-circuits to the response (jit.mjs:397-438).
- A guard's hooks on a sub-app become a **compact prefix**
  (`~beforeHandlePrefix`, index.mjs:244-253), run by `runBeforeHandlePrefix`.
- `afterHandle`/`mapResponse` inline after the handler; `afterResponse` and
  `defer()` drain in a `queueMicrotask` (jit.mjs:380).
- **Errors**: one `try` per route function; the `catch` calls
  `finalizeRouteError` → the app's error pipeline (handler/fetch.mjs:43-62,
  handler/utils.mjs:61-65). A thrown error costs about what bun-common's does
  in process: **5.7 µs vs 6.8 µs** for a 500 (`micro2.ts` I) [M].

### 3.6 Responses

`mapCompactResponse` (adapter/web-standard/handler.mjs:83-103): a string is
`new Response(s)` with **no init at all** on Bun (Bun supplies
`text/plain;charset=utf-8`); an object or array is `Response.json(v)`; a
`Response` passes through. With `set` in play, `mapResponse` (:69-81) checks
whether anything was set and otherwise falls back to the compact path; when
something was, `set.headers` — a null-prototype record — is passed as
`ResponseInit.headers` (:31-58, `handleSet` adapter/utils.mjs:300-322).
There is **no ETag**, no `X-Powered-By`, no freshness check.

### 3.7 Bodies

`WebStandardAdapter.parse` (adapter/web-standard/index.mjs:10-39) calls the
platform: `request.json()`, `request.text()`, `request.formData()`,
`request.arrayBuffer()`. The generated parse (jit.mjs:67-130) sniffs the
content type by `charCodeAt` before comparing strings. **GET and HEAD are
never parsed** (descriptor.mjs:77-78), and **Elysia sets no body size
limit** of its own (no `maxRequestBodySize` or length check in `dist/`
outside file responses; Bun.serve's own limit applies) [S]. Measured:
`await request.json()` is **0.48 µs** above the cost of building the POST
request; `text()` + `JSON.parse` 0.57 µs; `arrayBuffer()` + `TextDecoder` +
`JSON.parse` 1.79 µs; `bytes()` + `Buffer` + `JSON.parse` 1.18 µs
(`micro.ts` G) [M].

### 3.8 Everything else that is measurable

| Technique | Where | Measured |
|---|---|---|
| A cached 404 `Response` cloned per request | handler/utils.mjs:31-35 | `clone()` **525 ns** vs `new Response(undefined, {status: 404})` **416 ns**: slower [M] (`micro2.ts` I) |
| Static values promoted to Bun's table | adapter/bun/index.mjs:149-212 | not on the benchmark (function handlers); bun-common has the opt-in (`server.routes`, bun-native-routes PR-3) |
| Params decoded only when the path has `%` | fetch.mjs:97 | `decodeURIComponent` on a plain id **112 ns** saved [M] (`miss-breakdown.ts`) |
| Query parsed by hand from the remembered `?` index | parse-query.mjs:13+ | flat, null-prototype, no nesting; only when the route reads `query` |
| One `try` per route, none per hook | jit.mjs:261, 597 | free in JSC when nothing throws [I] |
| Prototype-shared helpers, fixed context shape | context.mjs:18-70 | 58 ns per context [M] |

---

## 4. The techniques, one by one

Each: what it is, evidence, Express 5 compatibility, expected gain, risk, and
a design for bun-common/bun-nest [D].

### 4.1 Build only what is read (laziness instead of inference) — main session

**What.** Elysia allocates a six-field context and parses nothing unless the
compiled route reads it (§3.4). bun-common builds a 50-field `BunRequest` and
reads `headers`, `url` parts and the body state in the constructor
(`BunRequest.ts:1123-1330`, `this.headersObj = request.headers` at :1231,
`#finishAbsentBody` at :1326-1345) [S].

**Evidence.** `BunRequest.init` defaults: 0.89 µs on a reused native request,
1.44 µs fresh; `new BunRequest` with parsing off 142–180 ns; Elysia's context
58 ns (`micro.ts` A, `breakdown.txt`) [M]. First reads on a fresh request:
`headers` 127–247 ns, `body` 104–125 ns (`first-access.ts`) [M].

**Express 5 compatibility: yes, and closer to Express.** Express 5's
`req.query` is itself a getter that parses on every access
(`express/lib/request.js:217-228`); its query parser default is `'simple'`
(`querystring.parse`, `application.js:97`); cookies and bodies exist only
when a middleware adds them [S]. A cached lazy getter is observably the same
as an eager field for every reader.

**Gain.** Up to ~1 µs in process per request → +6% (2×) to +14% (4×) on
every GET [I].

**Design notes for the main session** [D]: keep `headersObj` lazy (a getter
over `request.headers`); compute the path once from `request.url` the way
`extractPath` does and keep it (§4.7). One shortcut that looks tempting is
**not** exact: deciding "no body" from `request.body === null` alone. Express's
test is type-is `hasBody` — a `Transfer-Encoding` header or a numeric
`Content-Length` (`type-is/index.js:98-101`) [S] — so a `Content-Length: 0`
JSON request *has* a body for body-parser, which parses it to `{}`
(`body-parser/lib/types/json.js:55-59`) [S]. The header reads stay; what can
go is reading them twice (the constructor's `#finishAbsentBody` and the
parser middleware's own check).

### 4.2 Routing without a per-path cache

**What.** Elysia: static dictionary + radix tree, nothing cached (§3.3).
bun-common: every lookup is keyed by `METHOD path` in a 50,000-entry FIFO
cache of layer arrays (`getMatchedLayers`, `BunRouter.ts:4764-4933`;
`FifoCache`, `utils/routeIndex.ts:258-312`); a miss runs the candidate index
and the route regexes and builds the layer array [S].

**Evidence** (`micro.ts` C, `micro2.ts` L, `miss-breakdown.ts`) [M]:

| Lookup, 1,000 `/r<i>/:id` routes | ns |
|---|---:|
| Elysia: static dictionary | 27 |
| Elysia: memoirist, repeated path / fresh id | 157 / 311 |
| bun-common: cache hit | 140–143 |
| bun-common: **fresh path, today (cache inserting, 50,000 cap)** | **3,932–4,194** |
| bun-common: fresh path, cap 256 / 1,000 / 5,000 | 3,002 / 3,248 / 3,408 |
| bun-common: fresh path, `routeCacheMax: 0` | 1,850–2,359 |
| bun-common: repeated path, `routeCacheMax: 0` | 971 |

and the uncached miss, piece by piece: **candidates 0.62 µs** (splitting the
path, the bucket lookup, the merge, `isDisjoint`), **regex + params
0.48 µs** (of which `decodeURIComponent` 0.11 µs), and **~0.7 µs** building
the entry and layer arrays and the matched objects [M].

In the whole request (`inproc-variants.txt`) [M]: param-random **9.07 µs →
6.10 µs** with the cache off, but routes-1000 3.25 → 5.36 µs and middleware
3.67 → 5.94 µs. The cache is worth keeping for repeated paths and costs
~3 µs per one-off path; at a 50,000 cap, ~1.8 µs of that is the cost of
inserting and retaining (a cap of 256 still costs 0.7 µs over none).

**Express 5 compatibility: yes.** The cache is transparent: what is matched
does not depend on whether a path was cached (bun-native-routes §4.6, the
PR-1 differential). Elysia's tree itself is not a drop-in: Express routes
are regexes (`@routejs/router`), prefix-matched `use()`, case options,
host routes, and registration-order merging (CLAUDE.md "Router").

**Design** [D]:

- **PR-B1, admission.** Keep the cache; stop inserting when it is not paying.
  Count lookups and hits over a window (e.g. 4,096 lookups); when the hit
  ratio of the last window is below a threshold (e.g. 25%), insert only one
  miss in 64 (enough to notice a working set returning). Counters only, no
  per-key state: a doorkeeper (admit on second sighting) and a fixed 1-in-8
  sample were both prototyped and cost ~0.6–0.7 µs per miss of their own
  (`micro2.ts` L: 3,051 / 2,952 ns against 2,359 ns uncached) [M] — the
  window-ratio design avoids both the per-key state and most insertions [I].
  Exact by construction; the PR-1 differential and the three FIFO tests stay
  as they are.
- **PR-B2, a cheaper miss.** (a) Precompute, per route, its layer
  descriptors (route index, callback index, `isErrorHandler`,
  `isRouteHandler`, router id, callback) once at registration; a miss then
  binds only the per-request part (matched params, `baseUrl`) instead of
  building a fresh object per callback. (b) In `RouteCandidateIndex.candidates`
  find the first segment with `indexOf` rather than splitting the whole path,
  and run `isDisjoint` only on bucketed candidates. (c) `decodeParam` returns
  the value untouched when it has no `%` (exact: `decodeURIComponent` of a
  `%`-free string is the identity [S, ECMA-262]).
  Target: the uncached miss from 1.87 µs toward ~0.6 µs [I].

**Gain.** param-random: −1.8 to −3.0 µs in process from B1, −1.3 µs more
from B2 [M for B1's bound, I for B2] → +7–12% and +5% end to end at 1.5× [I].
No change on cached scenarios (B1 never stops admitting while hits are high).

**Risk.** B1: a working set larger than the window that alternates with
one-off traffic could see admission off when it would have helped; the
1-in-64 sample bounds the damage. B2: touches `getMatchedLayers`, the one
place Express semantics live — gate on the PR-1 differential with its
negative control.

### 4.3 The compiled pipeline, without compiling

**What.** An Elysia route is one function containing its hooks inline
(§3.4–3.5). bun-common's `#runPipeline` (`BunRouter.ts:5005-5140`) is a
general loop: per request a `PipelineState` and options object; **per layer**
a `LayerStep` object and a `next` closure (:5072-5086), the exited-router
check, error-mode gate, the deferred-body check, `baseUrl`/`next` writes,
`layerFinished`, `#settleLayer` (with its `debug` branch) [S].

**Evidence** (`micro2.ts` J: same cached layer arrays, a prototype loop that
handles only "every layer synchronous; each calls `next()` with no argument
or completes the response" and bails otherwise) [M]:

| | `dispatch` today | fast loop, `next` per layer | fast loop, `next` per request |
|---|---:|---:|---:|
| route only | 1,070 | 761 | 752 |
| 3 `use()` + route | 1,463 | 967 | 923 |
| 10 `use()` + route | 2,072 | 1,394 | 1,228 |
| *floor: `new BunResponse` + `send('ok')`* | *711* | | |

So the generic loop costs ~0.3 µs per request plus ~40–60 ns per layer
over a loop with the same semantics for that case [M]. Elysia's equivalent
(three hooks + handler + `new Response`) is 277 ns (`micro.ts` E) [M].

**Express 5 compatibility: yes, for the subset it handles, by falling
back.** The fast loop must reach exactly the state the general loop would:
params bound once per route, `req.route`, `req.baseUrl`, `req.next` set per
layer, `headersSent`/stream checks. Anything else — a promise, a `next(arg)`,
`next('route')`/`next('router')`, a thrown error, an error handler, a
deferred body, a layer that neither calls `next` nor responds — hands the
**current index** to `#runPipeline` (which already resumes from
`state.index`). Keep **one `next` per layer**: a stale `next()` from an
earlier layer is ignored today (`step.nextCalled`), and the per-request
variant would change that; the measured difference is 9–166 ns.

**Design** [D]: `dispatch()` (`BunRouter.ts:4977-5003`) tries
`#runSync(layers, request, response)` first; it returns a result or the
index to continue from, and `#runPipeline` takes over from there with a
`PipelineState` built only then. The `debug` log becomes the fallback's
concern (debug on → always the general loop).

**Gain.** −0.3 to −0.5 µs (0–3 layers), −0.7 µs (10 layers) in process →
+2–4% `static`/`param`, +3–6% `middleware` at 2–4× [I]. Smaller than §4.4–4.6
— **ship only if it clears its gate** (§6).

**Risk.** A second code path for the most important semantics in the
package. The suites, the differential and a new "fast loop vs general loop"
property test over random layer behaviours (sync next, sync respond, throw,
`next(err)`, `next('route')`, async) must agree.

### 4.4 Sync first, one promise only when something is async

**What.** Elysia's route is synchronous until a value is actually a
thenable, then jumps into an async tail that resumes at that call site
(`awaitSite`, compile/handler/utils.mjs:389-396) — one `await` per
asynchronous site, nothing else. bun-common already returns synchronously
when every layer is synchronous (PR-4). But when a layer returns a pending
promise, `#waitLayer` → `waitForLayer` (`BunRouter.ts:660-731`) allocates a
`new Promise`, a `finish` closure, a `wake` closure, subscribes to
`onceResponded` (an array plus an unsubscribe closure,
`BunResponse.ts:2018-2032`), attaches `then` to the pending promise, and
re-enters `#runPipeline` through another `then`. The adapter then wraps the
pipeline's promise in `awaitPipelineOrStream` (`BunRouter.ts:612-656`) —
another `new Promise` and another `onceResponded` subscription — and bun-nest
`await`s that inside an `async` method (`#awaitPipeline`,
bun-nest `BunHttpAdapter.ts:440-472`). An async layer that *finished* before
returning (called `next()` or responded) still gets a
`#watchLateRejection` (`then(undefined, …)`, :5193-5212) [S].

**Evidence** [M]:

| Whole request, bun-common lean (`micro.ts` F) | ns |
|---|---:|
| `(q, s) => s.send('ok')` | 2,757 |
| `async (q, s) => { s.send('ok') }` (finished before returning) | 3,566 |
| `async (q, s) => { await null; s.send('ok') }` | **5,067** |
| `async` middleware `{ await null; next() }` + sync route | 5,663 |
| *Elysia 2: `() => 'ok'` / `async () => { await null; return 'ok' }`* | *1,000 / 1,471* |

An awaited handler costs bun-common **+2.31 µs**; Elysia **+0.47 µs**.
In isolation (`micro2.ts` K), `router.dispatch` on such a handler is
**2,847 ns**; the handler alone awaited is 997 ns; a prototype that waits
with `pending.then(() => res.settledResponse)` is **1,056 ns**, and with
one `Promise` racing `onceResponded` for the early-response case
**1,184 ns** [M]. In bun-nest every route handler is such a layer
(`RouterProxy.createProxy` is `async`, `@nestjs/core/router/router-proxy.js:6-17`)
[S], and the adapter's second wait adds another ~0.6 µs
(`nest-breakdown.txt`: 7,842 vs 7,219) [M].

**Express 5 compatibility: yes.** What `waitForLayer` guarantees must stay:
move on at `next()`, at a complete response, or at the promise's settlement
(whichever first), keep a stream open until it ends, fail at `timeout` while
nothing was sent, log a late rejection, and return a stream's `Response` as
soon as it opens. None of that needs a promise *per wait*; it needs a place
for the response to signal.

**Design** [D]:

- One **pipeline-level** deferred, created the first time a layer goes
  asynchronous (not per wait). `BunResponse` gets a single-slot listener
  (`#onSettle`) instead of the `onceResponded` array for this internal use;
  `next()`'s `wake` writes to the same deferred. The pending promise gets one
  `then(onFulfilled, onRejected)` whose handlers check the layer index they
  were created for (a stale settlement after the pipeline moved on goes to
  the late-rejection log).
- The timer is created only when `timeout > 0` (already true) and cleared in
  the same place.
- The adapter does not wrap the router's promise again: `dispatch` resolves
  with the outcome `awaitPipelineOrStream` produces today (`{ routeUsed }`
  or `{ stream }`), so both adapters and `fetch()` share one wait. bun-nest's
  `#awaitPipeline` stops being `async`.
- `#watchLateRejection` attaches one shared, module-level rejection handler
  through a `WeakMap<Promise, PipelineState>` only when the layer returned a
  promise that has not settled (`Bun.peek.status` says so synchronously).

**Gain.** −1.7 to −1.8 µs per awaited layer in the router, −0.6 µs in the
adapter → bun-nest GETs +8% (2×) to +18% (4×) [I]; any async Express handler
by the same amount. **The benchmark's bun-common routes are synchronous, so
its table will not show this** — §6 adds an `async` scenario.

**Risk.** Medium: this is the code that fixed four pre-existing hangs (§17.1
of bun-native-routes). Every test added for those must pass unchanged, plus
`--randomize`.

### 4.5 Responses: keep `Headers`, cut what surrounds it

**What.** Elysia passes a null-prototype record as `ResponseInit.headers`
(§3.6). bun-common already sends a response with no headers set without a
`Headers` object (PR-4, `#canSkipHeaders`, `BunResponse.ts:566-575`) [S]. A
response that sets any header goes through `res.set()` → `setHeader` →
`Headers.set`, then `#respondWithText`'s ETag/freshness/strip logic [S].

**Evidence** [M]: three headers + JSON text, `micro2.ts` H:

| | ns |
|---|---:|
| `new Headers()`, 3× `set`, `new Response(body, {headers})` | 1,292 |
| null-prototype record, 3 writes, `new Response` (Elysia) | 1,340 |
| record of `[name, value]` → tuple array → `new Response` (Node's shape) | 1,593 |
| **`BunResponse`: `set` ×3 + `send`** | **2,334** |
| one header: `BunResponse` `set` + `send` / raw `new Response(…, {headers})` | 1,256 / 770 (`micro.ts` D) |

So **the representation is not the cost**; on Bun 1.4.2 a `Headers` object is
as fast as a record. The ~1 µs is bun-common's own work around it.

**Express 5 compatibility: yes**; nothing observable changes.

**Design** [D]: profile `set`/`setHeader`/`#respondWithText` with headers
(not on today's bench) and remove per-call work: header-name normalisation
done once per distinct name (a small cache of canonical names), the
`content-type` charset handling only for `Content-Type`, `hasHeader("ETag")`
skipped when ETag is off, `#applyFreshnessAndStrip` skipped when no
validator header is set and the status is not 204/205/304 (freshness needs
`ETag` or `Last-Modified`). Add a `headers` scenario to the bench first.

**Gain.** Up to −1 µs per response that sets headers [M bound] → ~+6% on a
CORS-style app at 2× [I]. None on today's bench.

### 4.6 Bodies — main session

**What and evidence.** §3.7. bun-common: `BunRequest.init` of the
benchmark's JSON POST is **10.0 µs** (`micro.ts` G) against
`await request.json()` 1.53 µs including the 1.05 µs request floor [M];
bun-common's `json` scenario is 10.6 µs in process against Elysia's 4.4 µs
(§1) [M].

**Express 5 compatibility: partly.** What must stay (body-parser 2.x
semantics, as bun-common implements them): the 100 kb default `limit` and
413 before any handler, `type` matching, `inflate`/encodings, `strict`,
`reviver`, `verify`/`rawBody`, a 400 with the parse error. What Elysia does
that **cannot** be copied: never parsing GET/HEAD bodies, and no size limit.

**Design notes for the main session** [D]: when the type is JSON, no
`verify`/`rawBody` consumer is registered, and `Content-Encoding` is absent
or `identity`, `content-length` ≤ limit → `request.json()` directly (or
`text()` + `JSON.parse` with the reviver: +0.09 µs, `micro.ts` G), mapping
its `SyntaxError` to body-parser's 400; otherwise today's path. A missing
`content-length` (chunked) needs the streaming cap and stays on today's
path.

**Gain.** Up to ~7 µs in process → `json` +26% (2×) to Elysia's figure (4×) [I].
*`32ce0f3` has since taken `BunRequest.init` on this request from 8.4 to
5.3 µs by its own measure; in process the `json` scenario went 10.6 →
9.4 µs (`inproc-matrix-85423c1.txt`) [M], still 5 µs above Elysia 2. It
reads the body with `arrayBuffer()` and keeps the bytes (`req.buffer`,
`rawBody`, `data` events need them), rather than `request.json()`. What is
left is mostly not the parse: a profile of that path puts the time in the
native `arrayBuffer()` and the wrapper's construction and header reads.
`f7af3f6` then added the missing 400 for invalid JSON.*

### 4.7 Hot-path string work

**What.** Elysia computes the path once (`extractPath`) and reads
`request.method` directly. bun-common recomputes: `get method()`
upper-cases on every access (`BunRequest.ts:3571-3573`); `originalUrl`
rebuilds `path + search + hash` on every access (:3697-3700);
`getMatchedLayers` strips the query again from `originalUrl`
(`getRequestPathFromRequestURL`, `BunRouter.ts:4469-4480`) [S]. The CPU
profile of static has `method` at 2.2%, `splitRequestUrl` ~6.7% across its
lines, `getRequestPathFromRequestURL` 2.1% self time [M].

**Evidence.** `host` + `method` + `originalUrl` on a new `BunRequest`:
285 ns over construction; `extractPath`: 63 ns; `toUpperCase` 35 ns per
call (`micro.ts` B) [M].

**Express 5 compatibility: yes.** Caching a value derived from immutable
inputs; `req.url` stays writable (Express rewrites it in mounts), so the
cache must key on the current `url`, or be invalidated by the `url` setter
[D].

**Design** [D]: the adapter computes `path` and the query index once from
`request.url` and passes them to `dispatch` (the router stops re-deriving
them); `BunRequest` caches `method` (Bun's `request.method` is immutable)
and `originalUrl`. Coordinate with the main session (it owns
`BunRequest`'s fields).

**Gain.** −0.2 to −0.3 µs → +1–2% [I].

### 4.8 Fewer, smaller per-request objects

**What.** Elysia: one context (6 fields, 64 B) + one `set` record (48 B) +
the `Response`. bun-common: `BunRequest` (50 fields, 432 B shallow),
`BunResponse` (31 fields, 320 B), the pipeline options object
(`BunHttpAdapter.ts:441-448`), `PipelineState`, and per layer `LayerStep` +
`next` (`sizes.ts`, [S]) [M].

**Evidence.** `new BunResponse` 117–125 ns (`micro.ts` A); under cache
pressure bun-common's excess over Elysia roughly doubles (§2.4) [M].

**Express 5 compatibility: yes**: private-field layout is not observable.

**Design** [D]: move `BunResponse`'s stream, upgrade, transform, emitter and
`sentBody` state into one lazily allocated `#cold` object (22 of its
fields serve only streaming (13), a WebSocket upgrade (4), `compression()`'s
transforms (2) or the event emitter (3), `BunResponse.ts:479-681` [S]);
build the pipeline options object once per request and reuse it as
`PipelineState` (one allocation instead of two). Measure each with
`breakdown.ts` and `POLLUTE`.

**Gain.** −0.1 to −0.3 µs in process [I]; more under load if §2.4's
mechanism holds [U]. *`5381f49` has since moved 23 of `BunResponse`'s
fields into a lazily created holder (~6 ns per initialised field by its own
measure); what remains of this item is the options/state objects.*

### 4.9 Already equal, or already done

- **Synchronous return to `Bun.serve`** — done in PR-4 (bun-native-routes
  §17.1); keep it.
- **A response with no headers set needs no `Headers`** — done in PR-4.
- **No ETag unless asked** — bun-common's default is off
  (`BunResponse.ts` `#etag`, "Opt-in because hashing every body has a
  measurable per-request cost") [S]; Express's default is weak ETags
  (`application.js:95`) [S] — a documented, deliberate difference.
- **Static responses natively** — the opt-in `server.routes` (PR-3).
- **Not reading `request.signal`** — bun-common does not on its hot path [S].

---

## 5. bun-nest specifics

### 5.1 What Nest does on every request

With no guards, pipes or interceptors (the benchmark) [S, @nestjs/core 11.1.27]:

1. `RouterProxy.createProxy` wraps the route in an `async` function with a
   `try`/`catch` (`router/router-proxy.js:6-17`). Nest middleware is wrapped
   the same way (`middleware/middleware-module.js:134-160`).
2. The execution context (`router/router-execution-context.js:36-49`):
   `createNullArray(argsLength)`; `fnCanActivate` (null without guards);
   `setStatus` → `adapter.status(res, 200)`; `interceptorsConsumer.intercept`
   (`interceptors/interceptors-consumer.js:10-12`: `async`, returns `next()`
   when there are none); the handler closure, `async`, which runs
   `fnApplyPipes` — an `async` `Promise.all` over every decorated parameter,
   each an `async` `resolveParamValue` (:145-157) — then the method;
   `await`; then `fnHandleResponse` (:181-186): `async`,
   `transformToResult` (`async`, an `isObservable` check,
   `router-response-controller.js:31-36`), then `apply` (`async`, :14-16) →
   `adapter.reply`.
3. bun-nest registers **one body-parser middleware for every path**
   (`registerParserMiddleware` → `registerBodyParser`,
   `BunHttpAdapter.ts:808-846`), `async`, which `await`s
   `req.handleBodyParsing(true, options, parser)` on **every** request
   (:823-834), bodiless or not; `handleBodyParsing`
   (bun-common `BunRequest.ts:3349-3424`) is itself `async` and runs its
   option handling and `Content-Encoding` parse before reaching the body.

So a bun-nest GET runs six to ten `async` functions before `reply` (seven
for `/static`, which has no decorated parameter; a `@Param` adds the
`Promise.all` and two more per parameter), plus bun-common's wait for the async route layer and the
adapter's second wait (§4.4).

### 5.2 Measured

§2.3 [M]: a bun-nest GET is ~10.7 µs in process: request/response objects
1.8, Nest's own chain ~3.3, bun-common's wait ~1.9, adapter wait ~0.6, the
bodiless parser ~2.6–2.8 µs. Nest middleware costs 0.77 µs each (bun-nest
middleware − static: 13.0 − 10.7 µs for three) against bun-common's 0.25 µs
each (3,418 − 2,664 ns for three, §1 table) [M] — the `async` proxy plus a `#watchLateRejection` per
layer.

### 5.3 What bun-nest can short-circuit legitimately

| # | Change | Exact because | Measured | Est. gain |
|---|---|---|---|---|
| N1 | **The parser middleware calls `next()` synchronously for a request with no body** (bun-common already knows: `#finishAbsentBody` ran in the constructor, with type-is's own `hasBody` test), without entering `handleBodyParsing` or creating a promise | body-parser 2.2.2's `jsonParser` is `read(…)` (`lib/types/json.js:87-89`), and `read` skips a bodiless request before any other check — `if (!hasBody(req)) { next(); return }` (`lib/read.js:50-55`) — before type, charset, inflate or limit, having only set `req.body = undefined` when absent (:46-48; bun-common's bodiless `req.body` is already `undefined`, bun-native-routes §4.7); `rawBody` is only set "when this parser parsed a body" (bun-nest's own comment, :826-829) | −2.8 µs static … −4.3 µs param-random (`bodyParser: false` upper bound; the real change keeps one synchronous middleware call, ~0.1 µs [I]) | **+11% (2×) to +25% (4×)** on GETs |
| N2 | §4.4's single wait, in the router and in `#awaitPipeline` | §4.4 | −1.7–1.8 µs router + −0.6 µs adapter | +8% to +18% |
| N3 | A cheaper finished-async-layer path (§4.4, last bullet) for Nest middleware | the rejection is still logged | part of 0.77 µs per Nest middleware [I] | +1–3% on `middleware` |
| N4 | `reply()`'s status handling: Nest calls `status(res, 200)` then `reply(res, body, undefined)`; `status(200)` costs +0.1 µs on `send` (`micro.ts` D: 667 vs 562 ns) because the init then carries a status | `200` is the default status | ~0.1 µs | <1% |

**What bun-nest cannot legitimately short-circuit**: Nest's own chain
(~3.3 µs). Replacing `RouterExecutionContext` or `RouterProxy`, skipping
`intercept`/`transformToResult`, or calling the controller method directly
would bypass guards, pipes, interceptors and exception filters that an app
may add at any time (globally, after `init`), and would track Nest internals
that change between minors. The right place for it is upstream [I]: a
synchronous fast path in `RouterExecutionContext.create` when the route has
no guards, pipes or interceptors (all known at `create` time,
:30-35) — an open question (§8), not a PR here.

---

## 6. Ranked PRs, phases and go/no-go

Measured with `bench/wrk-run.ts` against the commit before the PR, same
machine, same run, medians of 3 rounds (bun-native-routes §17.2's method).
Thresholds in the style of bun-native-routes §10.5:

- **A PR ships** only if it improves its **target** scenario(s) by at least
  the threshold given, regresses **no other** scenario by more than **5%**
  (the observed round-to-round spread), and shows **0 breaks** in both
  packages' suites, under `bun test --randomize` with two seeds, and — for
  anything touching `getMatchedLayers` or the pipeline — in the PR-1
  differential with its negative control failing.
- **A PR whose target is not on today's bench** adds the scenario first,
  in its own commit, measured before and after.
- **No-go means revert**, not "tune later": each PR is independent.

**New bench scenarios, before Phase B** (a commit to
`docs/plans/evidence/bun-native-routes/bench/servers.ts` and `wrk-run.ts`;
each target registers the same route):

- `async`: `GET /async`, a handler that `await`s a resolved promise, then
  responds (Elysia: `async () => { await null; return "ok" }`).
- `headers`: `GET /headers`, a response with three headers set
  (Content-Type, Access-Control-Allow-Origin, Vary).

### Phase A — bun-nest (do first: largest gain per line changed)

| PR | Change | Files | Effort | Evidence | Target, threshold |
|---|---|---|---|---|---|
| **A1** ✅ landed — `wrk` static +23%, param +9/+15%, middleware +9.5%, routes-1000 +7.9/+11.5%, param-random +14%, json −2/−3% ([`wrk-A1.md`](evidence/elysia2/results/wrk-A1.md)) | Bodiless request: the parser middleware calls `next()` synchronously (N1) | bun-nest `BunHttpAdapter.ts` `registerBodyParser` (:808-846); a bun-common `req.hasNoBody` (or reuse of `#finishAbsentBody`'s result) exposed for it | S | [M] `inproc-variants.txt`, [S] body-parser read.js:50-55 | bun-nest `static`, `param`, `middleware`, `routes-1000`, `param-random` **≥ +8%** each; `json` unchanged ±5% |
| **A2** ✅ landed — in process `/async` −26%, async middleware −31%; `wrk` bun-nest static/param/middleware +8–9%, bun-common `async` +6–10% (short of +10%) ([`wrk-A2.md`](evidence/elysia2/results/wrk-A2.md)) | One wait per asynchronous pipeline; no second wait in the adapters (§4.4, N2, N3) | bun-common `BunRouter.ts` `waitForLayer`/`#waitLayer`/`#watchLateRejection`/`dispatch`, `awaitPipelineOrStream`; `BunResponse.ts` single-slot settle listener; both adapters' `#routeRequest`/`#awaitPipeline` | M | [M] `micro.ts` F, `micro2.ts` K, `nest-breakdown.txt` | bun-nest GETs **≥ +5%**; bun-common `async` **≥ +10%**; bun-common sync scenarios ±5% |

### Phase B — bun-common routing

| PR | Change | Files | Effort | Evidence | Target, threshold |
|---|---|---|---|---|---|
| **B1** | Route-cache admission by recent hit ratio (§4.2) | `utils/routeIndex.ts` `FifoCache` (or a wrapper), `BunRouter.getMatchedLayers` | S | [M] `micro2.ts` L, `inproc-variants.txt` | `param-random` **≥ +7%** (bun-common and bun-nest); cached scenarios ±5% |
| **B2** | Cheaper uncached match: per-route layer templates, first-segment candidates, `%`-only decode (§4.2) | `BunRouter.ts` `getMatchedLayers`, `matchRoute`, `decodeParam`; `utils/routeIndex.ts` `candidates` | L | [M] `miss-breakdown.txt` | `param-random` **≥ +5%** over B1; uncached lookup ≤ 1.0 µs in `miss-breakdown.ts` |

### Phase C — bun-common pipeline and response

| PR | Change | Files | Effort | Evidence | Target, threshold |
|---|---|---|---|---|---|
| **C1** | Hot-path string work: path computed once and passed to `dispatch`; `method`/`originalUrl` cached (§4.7) — with the main session | `BunHttpAdapter.ts` both, `BunRouter.ts` `getMatchedLayers`, `BunRequest.ts` getters | S | [M] `micro.ts` B, profiles | in process `breakdown.ts` lookup stage **≥ −150 ns**; no `wrk` regression > 5% |
| **C2** | Synchronous fast loop with fall-back (§4.3) | `BunRouter.ts` `dispatch`, new `#runSync` | M | [M] `micro2.ts` J | `static`, `param`, `middleware` **≥ +5%**, else no-go (a second path must pay for itself) |
| **C3** | `res.set()`/`send()` with headers (§4.5) | `BunResponse.ts` `setHeader`, `#respondWithText`, `send` | M | [M] `micro2.ts` H | `headers` **≥ +8%**; others ±5% |
| **C4** | `BunResponse` cold state; one options/state object per request (§4.8) | `BunResponse.ts`, `BunHttpAdapter.ts`, `BunRouter.ts` | M | [M] `sizes.ts`, `micro.ts` A | in process `new BunResponse` **≤ 70 ns**; `wrk` ≥ +2% on `static` or no-go |

### Main session (landed while this plan was written)

| Change | Evidence | Target, threshold (suggested) | Landed |
|---|---|---|---|
| Lazy `BunRequest` fields (§4.1) | [M] `micro.ts` A, `breakdown.txt`, `first-access.txt` | `static`/`param` ≥ +10% | `5381f49`, first step: rarely-read state held lazily (request + response + `send`, 1,931 → 1,745 ns in an interleaved A/B); the headers / URL parts / query / cookies of §4.1 remain |
| JSON body fast path (§4.6) | [M] `micro.ts` G | `json` ≥ +15% | `32ce0f3`: `wrk` `json` 15,867 → 19,058 req/s (+20%) bun-common, 10,699 → 11,539 (+8%) bun-nest, same run |
| A body declared JSON that does not parse answers 400 (§4.6's "a 400 with the parse error") | [S] body-parser `read.js` | 0 breaks | `f7af3f6`: was routed with `req.body` undefined; now body-parser's 400, `type: "entity.parse.failed"` |

**Order.** A1 → A2 → (bench scenarios) → B1 → C1 → B2 → C2 → C3 → C4.
A1 and B1 are small and independent; A2 is the one with the most semantic
surface and should land before C2 (both touch `dispatch`).

**Projected end state** [I], assuming every PR and the main session's land
at their in-process figures, converted at 2× (1.5× for routing): bun-common
`static` 32.8 → ~29.5 µs (≈34k req/s, 69% of Elysia 2; ≈38k and 78% at
4×), `param-random` 42.5 → ~33 µs (≈30k, 65%), `json` 66.8 → ~50 µs
(≈20k, 80%); bun-nest `static` 56.7 → ~44 µs (≈23k). The static route
stays the hardest: what is left there is the wrappers' existence, which
§4.9 of bun-native-routes keeps. These are budgets, not promises; the gates
above decide.

---

## 7. What is not worth copying, and why

| Elysia 2 technique | Why not |
|---|---|
| **sucrose** (static inference of what a route reads, sucrose.mjs:61-283) | The Express contract lets any middleware read anything, and real stacks pass `req` to helpers (`cors(req, …)`, loggers, auth); sucrose then infers "everything" (sucrose.mjs:197-216) — as it does on the benchmark's own `/mw/hit`, which it compiles to parse the query, headers and cookies on every request [M] (`emitted.txt`). Lazy getters reach the same skip exactly and without parsing source text. |
| **`new Function` code generation** (jit.mjs:597) | The measured win of a compiled route is the missing machinery, which a plain-JS fast path recovers (§4.3: −0.3 to −0.7 µs) [M]; Elysia itself discards its generated source for simple routes in favour of closures (jit.mjs:574-596) [S]. Codegen adds debuggability, stack-trace and `eval`-policy costs for no measured gain. |
| **A null-prototype record instead of `Headers`** | Slower on Bun 1.4.2: 1,340 vs 1,292 ns for three headers; tuples 1,593 ns [M] (`micro2.ts` H). |
| **Cached 404 `Response` + `clone()`** | `clone()` 525 ns vs `new Response(undefined, {status: 404})` 416 ns [M]. |
| **Native routes for function handlers** | Elysia 2 itself left them (§3.1) [S]; bun-native-routes §1 measured no dispatch gain [M there]. The constant-value promotion already exists as an opt-in. |
| **The `origin` slot to defer `request.signal`** | bun-common never reads `signal` on the hot path [S]; keep it that way (a first read is 639–690 ns [M]). |
| **Lazy per-route JIT on first request** | bun-common already builds a path's layers on its first request and caches them; nothing to add. |
| **Never parsing GET/HEAD bodies; no body size limit** | Not Express semantics: body-parser parses any request that `hasBody` (read.js:50-55) and caps at 100 kb by default [S]. |
| **Elysia's flat query parser** (parse-query.mjs) | The win is *when* the query is parsed (lazily, §4.1), not *how*; changing the parser changes `req.query`'s shape (bun-common's default is picoquery with nesting; Express 5's default is `querystring.parse`, `application.js:97`) [S]. A semantics question (§8), not a performance one. |
| **The `afterResponse` microtask, `defer()`** | A feature with a per-request cost Elysia pays only when used; bun-common's `finish`/`close` events are already lazy (`BunResponse.ts` `emitFinish`, no emitter → no work) [S]. |

---

## 8. Risks and open questions

### 8.1 Risks

| Risk | Where | Mitigation |
|---|---|---|
| The in-process → end-to-end conversion (1.5×–7×) is wide; a PR may measure smaller than budgeted | every estimate | the gates are `wrk-run.ts` figures; no PR ships on an estimate |
| A2 reworks the wait that fixed four hangs | §4.4 | all their tests unchanged; `--randomize`; a stale-settlement test (a promise that settles after its layer moved on) |
| C2 duplicates the pipeline's semantics | §4.3 | fall back on anything unusual; a property test comparing fast and general loops over random layer behaviours |
| B1 can switch admission off for a mixed workload | §4.2 | a 1-in-64 sample keeps re-checking; the ratio and window are constants with tests |
| A1 changes when `rawBody` and `req.body` are set for a bodiless request | §5.3 | assert the before/after state of a bodiless request through the parser (as PR-2a's spike did for `BunRequest`) |

### 8.2 Open questions

1. **Served-only costs.** A served request's `headers`, `url` and `signal`
   are materialised by Bun from uWS; this plan could not measure them
   (§2.4). Is `request.headers` on a served request more expensive than the
   127–247 ns of a constructed one? [U] — answerable with a CPU profile of a
   server under `wrk` (the other session's harness), comparing
   `raw: + req.headers` with `raw` (`served.ts` cells).
2. **Why the conversion is 7× across frameworks but 1.5× within routing**
   [I: cache footprint, §2.4]. A `perf stat` of the served path (cache
   misses per request) would settle it.
3. **Should bun-common's default query parser be Express 5's `simple`?**
   (Not performance: semantics. Today it is qs-like nesting via picoquery.)
4. **Is "a stale `next()` is ignored" a guarantee?** Express's router does
   not guard it; bun-common does (`step.nextCalled`). C2 keeps it; if it is
   not a guarantee, one `next` per request saves 9–166 ns more (`micro2.ts` J).
5. **Upstream Nest**: would `@nestjs/core` accept a synchronous fast path in
   `RouterExecutionContext.create` for routes with no guards, pipes or
   interceptors? That is the ~3.3 µs bun-nest cannot remove itself (§5.3).
6. **`BUN_OPTIONS=--smol` in this environment's shell.** `wrk-run.ts` passes
   `process.env` to the servers (`wrk-run.ts:84`), so §17's servers may have
   run with `--smol`. In process it made no difference (`results/smol.txt`)
   [M]; under load it is [U].

---

## 9. Evidence index

Everything is under [`evidence/elysia2/`](evidence/elysia2/) (its
[README](evidence/elysia2/README.md) has the snapshot recipe and how to run
each script). Results in `results/`.

| Claim | Script | Result |
|---|---|---|
| Whole request per scenario, five targets (§1, §2.2) | `inproc-matrix.ts` (+ `targets.ts`) | `inproc-matrix.txt` |
| `bun-common-nocache`, `bun-nest-nobp` (§2.3, §4.2, §5) | `inproc-matrix.ts` | `inproc-variants.txt` |
| Stage breakdown (§2.1) | `breakdown.ts` | `breakdown.txt` |
| Cache pressure (§2.4) | `inproc.ts` with `POLLUTE` | `inproc-pollute.txt` |
| `--smol` (§2.4, §8) | `inproc.ts` | `smol.txt` |
| Served probe, inconclusive (§2.4) | `served.ts` | `served-static.txt`, `prof/served-*.md` |
| CPU profiles (§2.2, §4.7, §5) | `profile.ts` + `bun --cpu-prof-md` | `prof/inproc-*.md` |
| Elysia 2's compiled routes (§3.4) | `emitted.ts` | `emitted.txt` |
| Isolated costs A–G (§3, §4) | `micro.ts` | `micro.txt` |
| Prototypes H–L (§4.2–4.5, §7) | `micro2.ts` | `micro2.txt`, `micro2-admission.txt` |
| Uncached lookup pieces (§4.2) | `miss-breakdown.ts` | `miss-breakdown.txt` |
| bun-nest request (§2.3, §5) | `nest-breakdown.ts` | `nest-breakdown.txt` |
| First reads of native `Request` properties (§2.1, §4.1) | `first-access.ts` | `first-access.txt` |
| Object sizes (§2.4, §4.8) | `sizes.ts` | `sizes.txt` |
