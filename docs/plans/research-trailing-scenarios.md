# Why param-random, json and async still trail Elysia 2

Research, 2026-10-04, at `44b76be`. Every figure is measured on this session's
machine (Bun 1.4.2, 4 vCPUs) unless marked **[read]** (traced in the source,
not timed) or **[est]** (an estimate from the measurements around it).

## Where they stand

`benchmarks/wrk.ts`, 3 rounds, medians (`benchmarks/results/scenarios-wrk.md`):

| Scenario | bun-common | Elysia 2 | bun-common / Elysia 2 |
|---|---:|---:|---:|
| static (reference) | 41,355 | 51,219 | 81% |
| param-random | 33,414 | 50,781 | **66%** |
| json | 19,476 | 25,434 | **77%** |
| async | 33,277 | 43,492 | **77%** |

In process — the same request through each framework's handler, no socket,
fresh `Request` per call, 7 interleaved rounds, medians
(`scratchpad/research-inproc.ts`):

| Scenario | bun-common | Elysia 2 | Gap | Gap beyond static's |
|---|---:|---:|---:|---:|
| static | 1,537 ns | 895 ns | 641 ns | — |
| json | 6,093 ns | 3,140 ns | 2,953 ns | **2,312 ns** |
| async | 2,926 ns | 1,374 ns | 1,552 ns | **911 ns** |
| param-random | 4,514 ns | 2,038 ns | 2,476 ns | **1,835 ns** |

The "beyond static" column is what each scenario adds on top of the fixed
per-request cost every bun-common request pays (the request and response
wrappers, the pipeline). That fixed part is the subject of
`elysia2-performance.md` §2; this document is about the rest.

## A regression found on the way (fixed in `44b76be`)

The json profile showed `#finishAbsentBody` at 9.5% of a JSON POST. The lazy
headers change (`28804fa`) had made it decide "no body" from `request.body`
before any header, for every method. On a request that **has** a body, that
getter builds a `ReadableStream`, and `arrayBuffer()` then reads through it
instead of Bun's direct path. A JSON POST went 6.1 → 7.3 µs in process. The
`wrk` json figure above was measured with the regression in place.

The fix: only a GET or HEAD (which almost never has a body, so `request.body`
is `null` and cheap) is decided without headers; every other method checks
`Content-Length`/`Transfer-Encoding` first, as before. A test now counts
`request.body` reads on a served-shaped POST.

## 1. json — `POST /json {"n":7}`

**What Elysia 2 does** [read]: routes first, then `await request.json()` —
one native call that reads and parses — then `Response.json(value)`.
It reads two headers (`content-type`, `content-length`) and never looks at
`Content-Encoding`.

**What bun-common does** [read]: reads the body while the request is built,
before routing (`BunRequest#readInitialBody`): `request.arrayBuffer()` →
`Buffer.from()` → `buffer.toString()` → `JSON.parse`, with the header reads,
the `Content-Encoding` check and the size checks body-parser semantics need.
The reply is the same `Response.json`.

**Measured, cost by part** (CPU profile of `BunRequest.init` on a JSON POST,
excluding the harness's own `new Request`):

| Part | Share of `init` | Elysia 2 equivalent |
|---|---:|---|
| `arrayBuffer` + `Buffer.from` + `toString` + `JSON.parse` | ~38% | `request.json()` |
| `Headers.get` ×4–5 and building `Headers` | ~14% | 2 reads |
| `#readInitialBody` itself (promise wiring) | ~8% | an `await` |
| URL split | ~7% | one `indexOf` + slice |
| `parseContentCodings("")` — two arrays for an absent header | ~4.5% | none |
| `BodyParseConfig` built per POST, option normalisation, kind detection | ~4% | none |

And the read path on its own:

| Read | Time |
|---|---:|
| `request.json()` | 332–542 ns |
| `request.text()` + `JSON.parse` | ~880 ns |
| `request.bytes()` + `TextDecoder` + `JSON.parse` | 930–1,055 ns |
| `arrayBuffer()` + `Buffer.from` + `toString()` + `JSON.parse` (ours) | 1,140–1,890 ns |

The promise hops are **not** the difference: both sides take about four
between the native read and the `Response` [read].

**Why it trails, ranked:**

1. **The four-step read** — 600–1,500 ns more than `request.json()`. We keep
   the raw bytes because `req.buffer` ("the exact bytes received"),
   `rawBody`, the `data` events, `Content-Encoding` decoding and the size cap
   are all defined on them. `request.json()` gives none of that back.
2. **Header and option work body-parser semantics need** — ~20% of `init`:
   the extra header reads, `parseContentCodings` allocating for an absent
   header, a `BodyParseConfig` per POST.
3. Everything a static request pays (the fixed 641 ns).

**What would close it:**

| Change | Gain [est] | Exact? |
|---|---|---|
| `parseContentCodings("")` returns a shared empty array; build no `BodyParseConfig` for a boolean `parseBody` | ~150–250 ns | Yes, purely internal |
| One header read for `content-type`, reused by kind detection and the parse | ~50–100 ns | Yes |
| `request.text()` + `JSON.parse` when the body is declared JSON, has no `Content-Encoding`, no cap to enforce while streaming and nobody asked for bytes; `req.buffer` built from the text on first read | ~300–700 ns | **Not quite**: bytes rebuilt from text differ from the received bytes when the body is not valid UTF-8 (a lone `\xff` comes back as U+FFFD). Needs a decision, or `buffer` documented as "the decoded text's bytes" on that path |
| `request.json()` on the same conditions | ~800–1,300 ns | Further from exact: no bytes at all, and its error is Bun's, not body-parser's `entity.parse.failed` text (wrappable) |

## 2. async — `GET /async`, `async () => { await null; send("ok") }`

**What Elysia 2 does** [read]: the handler returns a promise; its compiled
route chains one `.then` (build the `Response`) and one `.catch`. About six
objects per request.

**What bun-common does** [read], when a layer returns a pending promise
(`BunRouter#park`): it creates the pipeline's own promise and executor and a
response listener (`#ensureAsync`), a wait record and a `next` wake closure,
subscribes `.then(onFulfilled, onRejected)` to the handler's promise, and —
when the handler sends — queues a microtask (`#wake` → `queueMicrotask`) to
resume. About twelve objects. The handler's own `.then` reaction then fires
and finds the wait already claimed: a wasted reaction.

**Measured:** in the async profile, `#park` 7.6%, `#ensureAsync` 7.0%,
`queueMicrotask` 2.5%, the extra `Promise` 1.6%, the wake/resume/advance
closures about 3% — **~22% of the request**, against Elysia's `.then` +
`.catch`. Async adds 1,389 ns to a bun-common request (async minus static)
and 479 ns to an Elysia 2 one.

**Why it trails, ranked:**

1. **Allocation per park, not ticks.** Both sides take about four microtask
   hops [read]. We allocate twice the objects, because the pipeline must also
   end at `next()`, a sent response, a stream's end or the timeout —
   whichever comes first — and Express 5 requires the move to happen a
   microtask *after* the event (so `res.send(); next(err)` in one tick still
   reaches the error handlers).
2. **The `queueMicrotask` on a response.** It is what implements that
   Express rule. ~95–150 ns.
3. **The no-op reaction** on the handler's promise once the response won.

**What would close it** (all keep the Express semantics):

| Change | Gain [est] |
|---|---|
| Fold the wait record into the pipeline state (a generation number instead of a fresh object per wait) and wake from `next()` without a per-park closure | ~100–200 ns |
| Reuse one executor-free promise per pipeline (the pipeline is the only waiter) | ~50–100 ns |
| When the wake is a sent response **and** the handler's promise is the only thing outstanding, let that promise's own reaction be the "one microtask later" instead of a separate `queueMicrotask`, falling back to `queueMicrotask` if the handler keeps running | ~100–150 ns, but subtle: it must still move on promptly when the handler awaits something long after sending |

Realistically about half the gap; the rest is the price of supporting
`next()`, streams and the timeout on the same path.

## 3. param-random — `GET /r999/<fresh id>`, 1,000 param routes

**What Elysia 2 does** [read]: a radix tree (memoirist) walked
character by character to `/r999/:id` — no regex, no per-path cache — and
returns `{ store, params }`: about eight objects per request.

**What bun-common does** [read]: the path cache misses (every path is new);
the candidate index narrows 1,000 routes to the one in the `r999` bucket; that
route's regex runs; the Express layer list for the request is built (an entry,
a `matched` record, a layer record per callback, the arrays around them), and
the cache considers storing it (admission keeps 1 in 64 while the hit ratio is
low). About 25 objects.

**Measured** (param-random profile): cache `get` 6.4%, cache `set` 2.3%,
candidates 6.7% + path bounds 1.8%, `matchRoute` 6.8% + the regex 0.8%,
`getMatchedLayers` building the list 7.7%, `decodeParam` 1% — **~34% of the
request** goes to finding the route. The cache miss itself costs more as the
cache fills: a `Map.get` miss with a fresh key is ~55 ns at 1,000 entries and
~110 ns at 50,000, and a stream of fresh paths fills the cache to its cap at
the sampling rate. In `wrk` this scenario also has bun-common's worst tail:
9.4 ms p99 against Elysia 2's 3.9 ms.

**Why it trails, ranked:**

1. **The layer list is built per path, not per route.** Express semantics
   (several matching routes and middleware, run in order) need a list;
   building and sizing it per request is ~8–10% of the request.
2. **A per-path cache that cannot help.** Every lookup misses, and the map
   grows; the miss, the admission bookkeeping and the occasional insert are
   ~9%.
3. **Regex matching** after the candidate filter (~7.5%) where a tree walk
   compares characters.

**What would close it:**

| Change | Gain [est] | Risk |
|---|---|---|
| Per-route layer templates: precompute each route's layers once; per request only the params change (bind them in the pipeline, not in the layer) | ~300–500 ns | Medium: the layer record carries `matched` today; tests cover it |
| Keep the cache small while admission is off (≤4,096 entries), so a miss stays a small-map miss | ~50 ns | Needs an eviction structure that can shrink |
| A radix candidate index for static prefixes + whole-segment params, keeping regex for the rest | ~200–400 ns | Large; the differential route tests are the safety net |

## Summary of causes

| Scenario | Main cause | Second | Third |
|---|---|---|---|
| json | Four-step body read vs `request.json()` — kept for exact bytes | Header/option work for body-parser semantics | (fixed) a stream built by reading `request.body` |
| async | ~12 objects per parked layer vs ~6 | `queueMicrotask` for the Express "next tick" rule | A no-op reaction on the handler's promise |
| param-random | Layer list built per path | A per-path cache that only misses, and grows | Regex instead of a tree walk |

All three share the fixed cost a static request pays — 641 ns in process
against Elysia 2 — which is still the largest single item for async.

## Recommended order

1. **json internals** — `parseContentCodings("")`, no `BodyParseConfig` for a
   boolean `parseBody`, one `content-type` read. Exact, small, ~200–350 ns.
2. **async allocation** — fold the wait into the pipeline state and drop the
   per-park closures. Exact, ~150–300 ns.
3. **param-random layer templates** — the largest exact gain, a medium change.
4. **json text path** — the largest json gain, but it needs a decision on what
   `req.buffer` means for a non-UTF-8 JSON body.
