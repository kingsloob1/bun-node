# Why param-random, json, async, headers and wildcard still trail Elysia 2

Research, 2026-10-04, at `44b76be`. Every figure is measured on this session's
machine (Bun 1.4.2, 4 vCPUs) unless marked **[read]** (traced in the source,
not timed) or **[est]** (an estimate from the measurements around it).

## Where they stand

`benchmarks/wrk.ts`, 3 rounds, medians (`benchmarks/results/scenarios-wrk.md`):

| Scenario | bun-common | Elysia 2 | bun-common / Elysia 2 |
|---|---:|---:|---:|
| static (reference) | 41,355 | 51,219 | 81% |
| param-random | 33,414 | 50,781 | **66%** |
| json (after `44b76be`) | 19,662 | 26,712 | **74%** |
| async | 33,277 | 43,492 | **77%** |
| headers | 30,461 | 35,648 | **85%** |
| wildcard (one path) | 39,286 | 48,849 | **80%** |

In process — the same request through each framework's handler, no socket,
fresh `Request` per call, 7 interleaved rounds, medians
(`evidence/trailing-scenarios/research-inproc.ts`):

| Scenario | bun-common | Elysia 2 | Gap | Gap beyond static's |
|---|---:|---:|---:|---:|
| static | 1,537 ns | 895 ns | 641 ns | — |
| json | 6,093 ns | 3,140 ns | 2,953 ns | **2,312 ns** |
| async | 2,926 ns | 1,374 ns | 1,552 ns | **911 ns** |
| param-random | 4,514 ns | 2,038 ns | 2,476 ns | **1,835 ns** |
| headers | 3,460–4,327 ns | 2,037–2,085 ns | 1,375–2,289 ns | **~700–1,600 ns** |
| wildcard (one path) | 1,417–1,539 ns | 940–955 ns | 477–584 ns | **~0** |
| wildcard (fresh path per request) | 4,479 ns | 1,798 ns | 2,681 ns | **~2,000 ns** |

(The headers and wildcard rows come from a second harness run,
`evidence/trailing-scenarios/research-wh2.ts`, whose static gap was 689 ns; ranges are two runs.)

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

**It does not move `wrk`'s json figure:** re-measured after the fix,
bun-common 19,662 req/s against Elysia 2's 26,712 (74%), against 19,476
before. A request `Bun.serve` hands over evidently reads its body through the
socket's stream either way [est], so building the stream early costs only an
in-process `Request` (the adapters' `fetch()`, tests). The fix stays — it is
correct and it is what the code meant — but it is not a served-json gain, and
the in-process json figures below overstate the read path's share of a
served request accordingly.

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

## 4. headers — `GET /headers`, three `res.set()` then `send("ok")`

**What Elysia 2 does** [read]: the handler assigns into `set.headers`, a
plain null-prototype object, and the route passes that object as the
`headers` of `new Response(text, init)`: one native conversion. It never
reads a request header.

**What bun-common does** [read]: `res.set()` → `setHeader()` → the lazily
created `Headers` (`new Headers()`) → one native `Headers#set` per header.
`send()` → `#respondWithText` then (because a header was set, the
no-headers fast path is off): `#applyFreshnessAndStrip` → `req.fresh`, which
builds the **request's** `Headers` and reads `If-Modified-Since` and
`If-None-Match`; `has("content-type")`; and `new Response(text, options)`
with the `Headers`.

**Measured** (micro-benchmarks on this machine, `evidence/trailing-scenarios/research-hdr.ts`):

| Step | Time |
|---|---:|
| `new Response("ok")` | 298 ns |
| `new Response("ok", { headers: plainObject })` — Elysia's way | 929–1,039 ns |
| `new Headers()` + 3 × `set` + `new Response` — our way | 1,545 ns |
| `new Headers()` + 3 × `set` alone | 523 ns |
| `new Response` with an existing 3-entry `Headers` | 686 ns |
| Request `Headers` built + 2 `get` (the freshness check) | ~220 ns |
| Our 3 × `res.set` on a fresh request/response | ~850 ns (≈ 330 ns over the bare native calls) |
| Our whole `res.set` × 3 + `send` | 2,245 ns over a header-less `send` |

In the request's profile: native `Headers#set` 13%, `new Headers` 9.7%,
`Headers#get`/`has` reads 5%.

This **reverses** `elysia2-performance.md` §4.5, which measured a `Headers`
object faster than a plain record (1,292 vs 1,340 ns) on the earlier
machine. Here a plain object handed to `new Response` is 300–600 ns cheaper
than building a `Headers`. Re-measure on the target machine before acting.

**Why it trails, ranked:**

1. **Headers built as a `Headers` object, one native call per header**,
   where a plain object costs one conversion — ~300–600 ns.
2. **The freshness check on every response with a header** reads the
   request's conditional headers — ~220 ns, plus it takes the request off the
   lazy-headers path. Express does the same check (`res.send` → `req.fresh`),
   so it stays; but it can be ordered cheaper (below).
3. **The JS around each call** (`set` → `setHeader` → the `headersObj`
   getter → an `isArray` check) — ~110 ns per header.
4. **The rest of the header path in `send`** (`has("content-type")`, the
   options object, status reads) — ~250 ns.

**What would make it faster than Elysia's, keeping Express semantics:**

| Change | Gain [est] | Exact? |
|---|---|---|
| Keep set headers in a null-prototype record (lower-cased name → value) and hand it to `new Response`; build a real `Headers` only when something needs one (`append`, a multi-value header, `Set-Cookie`, iteration, `getHeaders()`, a transform) | ~300–600 ns | Yes, if every read (`get`, `has`, `getHeaderNames`) is answered from the record with the same case-insensitive, comma-joined semantics. Re-measure first: it contradicts §4.5 |
| Freshness: decide from the **response** first. With neither `ETag` nor `Last-Modified`, only `If-None-Match: *` can make it fresh (the `fresh` module's rule), so read that one header, not two; skip `If-Modified-Since` and `Cache-Control` | ~50–100 ns | Yes |
| `res.set(name, string)` straight to the record — no `setHeader` hop, no `isArray` when the value is a string | ~150–250 ns for three headers | Yes |
| Track "a Content-Type was set" as a flag at set time instead of `has()` at send | ~40 ns | Yes |
| A `res.set(object)` fast path (Express accepts an object) that copies into the record in one loop | ~100 ns when used | Yes |

Together about 600–1,000 ns of the ~1.6 µs — enough to pass Elysia 2 on this
scenario, since its own header path is ~630 ns (929 − 298).

**Tried, measured, reverted** (after `b2374a0`). The record was built: plain
single-value headers kept in a null-prototype record, handed to
`new Response` as one object, read back (`get`, `getHeader`, `hasHeader`,
`removeHeader`) from the record, and turned into a `Headers` only for an
append, an array, an unusual value or iteration — with the response-first
freshness ordering beside it. Isolated, the record is cheaper
(`new Response` with a 3-key object 1,117–1,158 ns against 1,404 ns for
`Headers` + 3 `set`). In the request it was not:

| A/B | static | headers |
|---|---:|---:|
| `wrk`, 5 rounds, `b2374a0` → record | 37,528 → 35,841 | 28,331 → 26,709 |
| in process, interleaved, 3 runs | −12% … 0% | **+6% … +11% slower** |
| in process, record with no name/value validation | — | −0.1% … +7% |

So neither the validation nor the representation is where the time goes on
this Bun; the freshness reordering also reads two response headers to save
one request header, which is no saving when there is no conditional request
(the common case). Both were reverted; the parity tests written for them
(`__tests__/responseHeaders.test.ts`) stay, and pass on the original code.

What is left for headers is what Express itself requires — the freshness
check reading the request's conditional headers (which builds the request's
`Headers`), and a `Headers` store answering `get`/`has`/`getHeaders` — plus the
fixed per-request cost. The next lever there is not the store but the
freshness check: ask Bun for the two conditional headers without building the
request's `Headers` (no API for that today), or skip it for responses that can
never be fresh — which `If-None-Match: *` prevents, exactly.

## 5. wildcard — `GET /assets/*`

**What Elysia 2 does** [read]: the radix tree has a wildcard node under
`/assets/`; the walk reaches it and takes the rest of the path as `*`. No
regex, no cache.

**What bun-common does** [read]: the same as a param route — the per-path
cache, and on a miss the candidate index (bucket `assets`), the route's
regex (`/assets/*` compiled by `@routejs/router`), the layer list.

**Measured:**

- **One repeated path** (`/assets/css/site/app.css`, what both benchmarks
  send): the path is a cache hit after the first request, so wildcard costs
  what static costs — `wrk` 80% of Elysia 2 against static's 81%; in process
  the gap beyond static is ~0. Nothing wildcard-specific to fix.
- **A fresh path per request** (`/assets/<id>/site/app.css`, what real asset
  traffic looks like): 4,479 ns against Elysia 2's 1,798 ns — a 2.7 µs gap,
  the same as param-random. Every path misses the cache.

**Why it trails:** on real traffic, the param-random causes exactly — the
per-path cache that only misses, the layer list built per path, and a regex
instead of a tree walk. A wildcard route serving many files is the most common
way to hit that path in production.

**What would close it:** the param-random changes (§3) — per-route layer
templates, a bounded cache while admission is off — apply unchanged. One more
specific to wildcards: a route whose pattern ends in `*` with a literal prefix
can be matched by `startsWith(prefix)` in the candidate index, skipping the
regex for that route (~100–200 ns [est], exact as long as the regex's
case-sensitivity and trailing-slash rules are reproduced). The benchmarks
should also gain a **wildcard-random** scenario: the one-path figure hides
this.

## Summary of causes

| Scenario | Main cause | Second | Third |
|---|---|---|---|
| json | Four-step body read vs `request.json()` — kept for exact bytes | Header/option work for body-parser semantics | (fixed) a stream built by reading `request.body` |
| async | ~12 objects per parked layer vs ~6 | `queueMicrotask` for the Express "next tick" rule | A no-op reaction on the handler's promise |
| param-random | Layer list built per path | A per-path cache that only misses, and grows | Regex instead of a tree walk |
| headers | A `Headers` object with one native call per header vs one plain object | The freshness check reads the request's headers | JS hops around each `set` |
| wildcard | Nothing on one path (it is the fixed cost); on fresh paths, the param-random causes | — | — |

All three share the fixed cost a static request pays — 641 ns in process
against Elysia 2 — which is still the largest single item for async.

## 6. Route lookup: a regex-free matcher against a radix tree

Asked to try both and keep the faster. Both were prototyped against the real
route table (the benchmark's 1,000 `/r<i>/:id` routes plus every other route
shape), compiled from each route's **own regex source** so they answer for
exactly that regex, and checked against `exec` on every lookup before timing
(`evidence/elysia2/lookup-prototypes.ts`).

- **A — regex-free matcher**: the existing per-segment candidate index, with
  each candidate's `exec` replaced by a compiled segment comparison.
- **B — radix tree**: the index replaced. B1/B2 (a tree of segments, `Map`
  per node) were *slower* than today: a `Map.get` on the root's 1,007 keys with
  a freshly sliced, lower-cased segment alone cost 150–250 ns. B3 walked
  characters instead (Elysia's memoirist does the same) — no substring, no
  hashing — but still ran the old index for the 3 routes outside the grammar.
  **B4** hangs those as regex leaves at their literal prefix, so nothing else
  runs.

Lookup alone, per fresh path (3 interleaved rounds, this machine):

| Workload | Current | A matcher | B4 radix |
|---|---:|---:|---:|
| param-random `/r999/<id>` | 1,136–1,206 ns | 911–1,013 ns | **869–980 ns** |
| wildcard, fresh path | 1,114–1,167 ns | 998–1,321 ns | **747–821 ns** |
| static `/static` | 579–780 ns | 611–701 ns | **399–502 ns** |

**B4 won everywhere** and became `lib/utils/routeTree.ts`; the per-segment
index is gone. It is held to the regexes by two differential tests (a hand
table of every shape over ~3,400 paths with a negative control, and 400
random tables × 2 case modes × 60 paths, exact captures). Request level:

| | before | tree |
|---|---:|---:|
| `wrk` param-random, 5 rounds | 31,292 | **35,267 (+12.7%)** |
| `wrk` routes-1000 (a cache hit), 5 rounds | 40,062 | 40,278 |
| in process param-random, 2 runs | 5,271 / 5,610 ns | 5,056 / 5,410 ns (−4%) |

## 7. Body scenarios — urlencoded, multipart, binary, text, xml

Scripts: `evidence/trailing-scenarios/multipart/`, `urlencoded-parsers.ts`,
`parse-body-resolve.ts` and `profiling/` (indexed in that directory's
`README.md`).

The `wrk` harness gained five body scenarios beside `json`. bun-common and
bun-nest run them with `retainBuffer: false` and multipart's
`detectFileType: false`, because no other framework keeps the bytes or sniffs
uploads. The first smoke run had bun-common at 63–74% of the fastest
framework on every kind but one: **multipart, at 11%** (2,468 req/s against
22,140 for `Bun.serve`).

**Multipart: where the time went.** This was measured on a served-like
request (one field and a 1 KiB file, with `Content-Length`, as wrk sends it)
in process:

| Cost | Share | Fix |
|---|---:|---|
| `file-type` sniffing | ~30% (7 µs JPEG, 35 µs unrecognised, 393 µs a minimal PNG) | `detectFileType: false` skips it; the default is unchanged |
| busboy fed by `Readable.from(buffer).pipe()` | ~25% | `bb.end(buffer)`: the stream machinery cost more than busboy's own parse (38 → 22 µs) |
| capped body read chunk by chunk | ~20% | one `arrayBuffer()` when `Content-Length` is within the cap, as every other kind already did |
| query parser and a throwing `JSON.parse` per field | ~10% | plain names (`[\w-]+`) skip the parser; only a value that can open a JSON text reaches `JSON.parse`; held to the old answers by a differential test |

Result: **189.6 → 87.0 µs** per upload, and `wrk` multipart 2,468 → 4,221
req/s after the first two rows alone (the full run is in
`benchmarks/results/body-scenarios-wrk.md`). What remains is about a third
busboy, construction included.

**The object-form `parseBody` was resolved per request.** Opting out of
sniffing needs `parseBody.contentTypes.multipart.opts`, which is the
capped object form, and that form cost served json, urlencoded and text 5–12%
against `parseBody: true`. It rebuilt a `BodyParseConfig` with a `Set` and a
`Map` for every request: 707 ns, and 2.9% self time under load. It is now
built once per options object, frozen and shared (copy-on-write as the
default already was), and reused while a snapshot of the object's fields
still matches, so mutating the object is still honoured: **707 → 144 ns**.
Profiled under `wrk`, the two configs are now within 2%.

**Would Bun's `formData()` be faster for urlencoded?** No:

| Body | `text()` + picoquery (kept) | `formData()` | `text()` + `URLSearchParams` |
|---|---:|---:|---:|
| `a=1&b=two` | **1.91 µs** | 3.92 µs | 2.93 µs |
| 20 encoded fields | 26.5 µs | 24.1 µs | **20.7 µs** |
| `user[name]=…&user[langs]=…` | **3.32 µs** | 7.56 µs | 5.54 µs |

It is twice as slow on small and nested forms and only 9% faster on a large
flat one, and its flat entries would still need picoquery for nesting.

**Multipart is the opposite case.** `request.formData()` parsed the upload,
file bytes included, in **8.9 µs** against busboy's ~38 µs. Using it would
change what the parse answers: part names decode as UTF-8 where busboy's
default is latin1, the limits would be checked after parsing rather than
while streaming (so which limit is reported when several are exceeded can
differ), and `isPartAFile`, `fieldSize` truncation and the charsets options
have no equivalent. It is a decision, not a refactor, so it has not been made.

**`formData()` against busboy, measured.** Both parsers started from the
buffered body, as `BunRequest` holds it, and both answers were checked equal
before timing:

| Upload | busboy | `formData()` | ratio |
|---|---:|---:|---:|
| 1 field + 1 KiB file (the wrk scenario) | 24.8 µs | 9.5 µs | 2.6× |
| 10 fields, no file | 33.3 µs | 12.7 µs | 2.6× |
| 50 fields, no file | 150.8 µs | 38.8 µs | 3.9× |
| 1 field + 100 KiB file | 132.0 µs | 94.7 µs | 1.4× |
| 1 field + 1 MiB file | 1.26 ms | 918.5 µs | 1.4× |
| 5 files × 100 KiB | 628.9 µs | 417.6 µs | 1.5× |
| 1 field + 10 MiB file | 12.93 ms | 11.46 ms | 1.1× |

For the wrk upload that is ~15 µs of the ~87 µs request (about 17%). For
large files it shrinks to ~10%, because copying the bytes dominates both.

The two parsers answer the same bytes differently:

| Input | busboy (today) | `formData()` |
|---|---|---|
| UTF-8 part name / filename, raw | latin1 mojibake (`cafÃ©`) unless `defParamCharset: "utf8"` | UTF-8 (`café`) |
| RFC 5987 `filename*=UTF-8''…` | a file named `naïve.txt` | **a text field; the file is lost** |
| `filename="C:\dir\x.txt"` | basename `x.txt` (unless `preservePath`) | **the full path**: a path-traversal hazard for disk storage |
| part with no `filename` but a file `Content-Type` | a file | a text field |
| field with `Content-Type: text/plain; charset=latin1` | decoded (`é`) | **mis-decoded (`�`)** |
| file with no `Content-Type` | `text/plain` (RFC 7578) | `application/octet-stream` |
| a file's type | `text/plain` | `text/plain;charset=utf-8` |
| `Content-Transfer-Encoding` | reported as `encoding` | not reported |
| part with no `name` | kept, under `undefined` | dropped |
| truncated or garbage body | `Unexpected end of form` | `TypeError: … missing final boundary` |
| CRLF / LF in values, repeated names, preamble, quoted boundary | same | same |

The parse options have no `formData()` equivalent either: `limits` (it would
check them after the parse, and could report a different one when several
are exceeded), `isPartAFile`, `preservePath`, `defCharset`,
`defParamCharset`.

**Verdict: not a replacement.** Three of the differences lose data or open a
hazard (`filename*`, a charset-tagged field, a path in a filename). `limits`,
`isPartAFile` and the charsets are documented options that would stop
working. A native path is defensible only as an **opt-in** parser, documented
with this table, that keeps the basename strip and the post-parse limit
checks. It would be worth about 17% on a small upload, and it is offered,
not made.

**A busboy-exact parser for a body in memory (`lib/multipart/buffered.ts`).**
Every alternative was measured, as was the cost of busboy itself. bun-common
always holds the whole body before parsing it, so busboy's streaming
machinery (Writable, a Readable per file, streamsearch over chunks) is pure
cost. The new parser:

- finds the boundary with native `Buffer.indexOf`;
- reads a part's whole header block, in the shape clients send it
  (`Content-Disposition` with `name` and `filename`, at most a plain
  `Content-Type`), with one anchored regex built from busboy's own
  TOKEN/QDTEXT/FIELD_VCHAR tables;
- falls back to busboy's header and parameter parsers for any other shape;
- decodes parameters and charsets with busboy's own helpers
  (`busboy/lib/utils.js`).

Anything unusual answers `undefined`, and the request runs busboy. That
covers a limit reached, a truncated or malformed body, junk after a boundary,
and a header block near busboy's caps. Busboy's errors and limit events are
therefore unchanged. A seeded differential fuzz against busboy (bodies with
odd names, `filename*`, paths, charsets, folded headers, partial boundaries
inside values, junk, truncation, limits) found **0 mismatches in 100,000
cases**. A negative control (keeping file paths) is caught, and every body
Bun's `FormData` encoder produces is answered without a hand-off. The fuzz
also found a real ReDoS in the first header regex: a 16 KB header of blanks
cost 820 ms. It is fixed, with a test that fails on the old regex.

Every parser, from the buffered body, answers checked equal
(`evidence/trailing-scenarios/multipart/alternatives/speed.ts`, this VM):

| Upload | busboy 1.6 | @fastify/busboy 3.2 | **bun-common** | Bun `formData()` | @remix-run/multipart-parser 1.0 | @mjackson/multipart-parser 0.10 | multipasta 0.2 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 field + 1 KiB file | 12.1 µs | 17.9 µs | **2.5 µs** | 3.9 µs | 9.3 µs | 8.8 µs | 13.1 µs |
| 10 fields | 19.7 µs | 34.5 µs | **4.6 µs** | 5.0 µs | 16.2 µs | 16.1 µs | 23.2 µs |
| 50 fields | 80.2 µs | 148.5 µs | **14.8 µs** | 16.7 µs | 71.5 µs | 88.2 µs | 105.6 µs |
| 1 field + 100 KiB file | 116.2 µs | 29.1 µs | **13.9 µs** | 28.4 µs | 36.8 µs | 37.8 µs | 67.4 µs |
| 1 field + 1 MiB file | 1.02 ms | 200.7 µs | **170.0 µs** | 529.6 µs | 404.0 µs | 395.0 µs | 721.2 µs |
| 5 files × 100 KiB | 522.7 µs | 122.6 µs | **83.9 µs** | 156.1 µs | 205.0 µs | 184.9 µs | 355.4 µs |
| 1 field + 10 MiB file | 11.68 ms | 2.59 ms | **2.46 ms** | 6.19 ms | 5.61 ms | 5.08 ms | 8.74 ms |

The Remix parser (`remix-run/remix` `packages/multipart-parser`) and its
predecessor (`mjackson/remix-the-web`, published as
`@mjackson/multipart-parser`) answer alike. Both differ from busboy on 8 of 9
probes (`alternatives/remix-semantics.ts`):

- they keep a path in a file name;
- they throw on a latin1 field;
- they give no default type to a file sent without one;
- they report `""` for an empty filename;
- they report one "not finished" error for both truncation and a malformed
  header.

@fastify/busboy is faster than busboy only on large files.

`getMultiParts` around the parser was then restructured:

- the default inflators and the file-path walk became module functions,
  instead of closures rebuilt per call;
- the buffered path calls its handlers directly rather than through an
  emitter;
- the `Content-Type` is read without building the request's header object.

Same machine, `wrk`, 3 rounds (`benchmarks/results/multipart-wrk.md`):

| | before (`5ee4f6b`) | after |
|---|---:|---:|
| in process, one upload | 43 µs | 23 µs |
| bun-common | 14,519 req/s | **21,375 req/s (+47%)** |
| bun-nest | 8,260 req/s | **12,367 req/s (+50%)** |
| Elysia 2 (the same runs) | 42,597 | 36,675 |

bun-common went from 34% of Elysia 2 to 50–58%. What remains is spread
across the request pipeline, with no multipart hotspot left. The parser is
about 2.5 µs of a request.

`isPartAFile`, documented as honoured, never was: busboy 1.x does not read
it. It is now documented as ignored and deprecated, with a test pinning
that.

## Status of the fixes (2026-10-04)

| Fix | Commit | Result |
|---|---|---|
| json: `request.json()` for a plain JSON body; `retainBuffer` keeps the bytes; shared default body config; no codings parse for an absent `Content-Encoding` | `b2374a0` | **`wrk` json 19,662 → 21,462 req/s, 74% → 88% of Elysia 2**; in process 6.1 → 5.0 µs |
| headers: header record + response-first freshness | — | Built, measured slower (+6–11% in process), **reverted** (§4) |
| async: no per-park wake closure | `8c98cb8` | Kept as a simplification; within noise |
| param-random / wildcard (fresh paths): radix tree route lookup | `85b6e22` | **`wrk` param-random 31,292 → 35,267 req/s (+12.7%)**; see §6 |
| multipart: busboy fed in one write, one native read under a cap, plain-name inflation, `detectFileType` | `f5abecd` | in process **189.6 → 87.0 µs** per upload; see §7 |
| object-form `parseBody`: resolved once per options object | `f5abecd` | 707 → 144 ns per request; the capped config no longer trails `parseBody: true` |
| multipart: busboy-exact buffered parser; `getMultiParts` restructured | (this commit) | `wrk` multipart **14,519 → 21,375 req/s** (+47%), bun-nest +50%; parser fastest of seven candidates; see §7 |

## Recommended order

0. ~~**headers record + freshness ordering**~~ — built and measured: no gain
   in the request (see §4), reverted.
1. **json internals** — `parseContentCodings("")`, no `BodyParseConfig` for a
   boolean `parseBody`, one `content-type` read. Exact, small, ~200–350 ns.
2. **async allocation** — fold the wait into the pipeline state and drop the
   per-park closures. Exact, ~150–300 ns.
3. **param-random layer templates** — the largest exact gain, a medium change;
   it fixes wildcard on real (many-path) traffic too.
4. **json text path** — the largest json gain, but it needs a decision on what
   `req.buffer` means for a non-UTF-8 JSON body.
