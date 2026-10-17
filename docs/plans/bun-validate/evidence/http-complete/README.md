# http-complete: cookies, typed headers, and per-status response contracts for every body kind

Plan evidence (a spike), not product code. It answers the design questions
behind the user's requirements of 2026-10-17:

> "robustness and features to be complete with cookies, header, response body
> and status validation and full typing"
>
> "The bun validate for response can validate even response headers and the
> response body. It shouldnt be for only json body."

and the decisions already settled: `cookies` is a full request target,
request headers are fully typed, responses are validated and typed per status
with an **undeclared status a failure**, and a status's contract covers its
**headers** (Set-Cookie too) and a **body of any form**.

Recorded 2026-10-17 on `develop` at `68023d36`, Bun 1.4.4-canary.1
(`5f5799ed1`), 16 cores. `file:line` citations are at `68023d36`, relative to
`packages/bun-common/` unless they say otherwise. Nothing here is part of a
package or of a project the repo checks. The transport-agnostic core (the
runner, the issue shape, the policy) is the sibling spike
[`../contract-core/`](../contract-core/); `lib/responseContract.ts` in the patch
carries a minimal local runner only.

## Files

| File | What it is |
|---|---|
| `http-complete.patch` | the prototype, on a copy of bun-common: 8 files, +1220/−98. It **contains** `../response-typing/response-typing.patch` and extends it. 512 of the added lines are the new `lib/responseContract.ts` |
| `request-parts.probe.ts` | Q1 (cookies) and Q2 (headers) on **today's unpatched** bun-common |
| `types.probe.ts` | the typing, with 18 negative controls (N1–N18) and one pinned limit (L1) |
| `runtime.probe.ts` | H1–H52 through `router.fetch()`: every body kind × `off`/`warn`/`error` × zod (sync) and yup (Promise), then status, headers, Set-Cookie, request parts, exemptions |
| `bench.ts` | cost per body kind per request: no validator, mode `off`, mode `error` with zod |
| `run.sh` | rebuilds the scratch copy and runs everything |
| `results.txt` | the recorded outputs of `run.sh` and of the wrapped bench |

## Running it

```bash
# from this directory, after `bun install` at the repo root
bash run.sh [scratch-dir]          # default ~/.cache/bun-node-11/validate-plan/s2/spike
BENCH=1 bash run.sh [scratch-dir]  # also the bench, through the heavy-run wrapper
```

`run.sh` copies `packages/bun-common` and `packages/bun-nest` into the scratch
dir (a `node_modules` whose `@kingsleyweb/bun-common` points at the copy, and
an unpatched base copy beside it), applies `http-complete.patch`, and runs
steps a–h (i with `BENCH=1`). It deletes nothing outside the scratch dir. Every
type check is a bare `bun --check` with `AGENT`, `CLAUDECODE` and `REPL_ID`
unset (the repo's `CLAUDE.md`, "Bun's checker, not tsc"). The bench alone is
heavy; the recorded run was:

```bash
cd <scratch>/packages/bun-common
HEAVY_TICKET=bun-node-11-httpcost /tmp/claude-1000/bun-node-heavy-run.sh \
  nice -n 10 timeout 900 bun spike/bench.ts > <log> 2>&1
```

### Pass conditions

| Step | Pass |
|---|---|
| a. `request-parts.probe.ts` (unpatched) | Q1c: a forged **unsigned** `sid` passes a `cookies` schema; Q1d/Q1e: it, and a tampered signed one, fail a `signedCookies` schema; Q2-c-replace: `req.is`, `typeIs.hasBody`, `req.accepts`, busboy and `rawHeaders` break; Q2-b-copy: nothing breaks |
| b. patched bun-common, lib + `__tests__` + `scripts` + the three spike files | no errors |
| c. `types.probe.ts` with every `@ts-expect-error` removed | **19** errors in `zz-mutant.ts` (N1–N18 and L1) |
| d. bun-nest against the patched copy | **1** error, `bun-jobs/lib/api/errors.ts:409` (a consumer finding, below) |
| e. `types.probe.ts` against the **unpatched** base | errors (25 recorded) |
| f. `generate-verb-overloads.ts --check` | `lib/BunRouter.ts: up to date (25 verbs)`, `../bun-nest/lib/BunHttpAdapter.ts: up to date (16 verbs)` |
| g. `runtime.probe.ts` | per H-case as in the table below: `off` passes the bad body, `warn` passes it and logs once, `error` answers 500 before a stream starts and cuts the stream after; every GOOD case passes in `error` |
| h. bun-common's suite, patched and base | the same counts and the same failures in both (recorded: 1569 pass, 11 skip, 3 fail each; the 3 are the scratch location: `sendFile` refuses a path under the dot-directory `~/.cache` with `dotfiles: "ignore"`, and `build-declarations` looks for the other packages) |
| i. `bench.ts` | a benchmark: read the minimums and the load average it prints |

---

## Results

### Request cookies (Q1, `request-parts.probe.ts`, H47–H51)

**How they are parsed and stored today.** The `Cookie` header is parsed on the
first touch of `req.cookies`/`req.signedCookies`, or a `parseCookies()` call
(`BunRequest.ts:2972`, `:3006`, `:4451`). Values are strings, or the parsed
JSON of a `j:` cookie, so typed `Record<string, JsonValue>`. With a secret,
every `s:` cookie **moves** from `cookies` to `signedCookies`: its unsigned
value when a secret verifies it, `false` when none does (`:4502-4520`, as
cookie-parser). Q1a: `{ cookies: { plain: "1", obj: { x: 1 } }, signedCookies:
{ sid: "alice", bad: false } }`. Both have setters, and nothing in any
package's `lib/` reads `req.cookies` after the parse (grep: only
`requestParsing.ts:133-134`, which resets them).

**A `cookies` schema cannot require a signature** (Q1b, Q1c): a forged
unsigned `sid=alice` lands in `req.cookies` and passes `z.object({ sid:
z.string() })`. Against `signedCookies` the forged cookie is absent and fails
(Q1d), and a tampered one is `false` and fails (Q1e); a genuine one passes
(Q1f). The patched copy does the same through `validate()`: H49 genuine 200,
H50 forged 400, H51 tampered 400, each issue with target `signedCookies`.

**Recommendation: two targets, `cookies` and `signedCookies`, both written
back like `query`** (H46: `req.cookies.n` is the number 7; H47: a bad cookie
is a 400 with target `cookies`). Write-back strips what the schema does not
declare (Q1g: `other` gone), exactly as `query` and `body` do today; the type
says what is there, and `replace: false` or a loose object schema is the
escape. Typed through `ValidationShape` and the overloads' `MountedHandler`
(`ResolveCookies`, `ResolveSignedCookies`); the overloads are byte-identical
(step f).

### Request headers (Q2, `request-parts.probe.ts`, H46, H48)

**What `req.headers` is**: a plain-object cache built from the native
`Headers` on first read, lower-case names, `set-cookie` an array
(`BunRequest.ts:5154-5180`); `req.setHeader`/`removeHeader` throw the cache
away (`:5194-5218`), so it is rebuilt from the native headers (Q2a). **Who
reads it later**: busboy, handed `this.headers` for an unbuffered multipart
body (`:3850`); `type-is` (`typeIs.hasBody`, `req.is`, `:4158`, `:4684`) and
`accepts` (`req.accepts`, `:5367`), which read nothing but `request.headers`
(`index.ts:515-528`); `rawHeaders` and `headersDistinct` (`:5248`, `:5273`);
and any Express-style middleware. `req.get()`/`getHeader()` read the native
`Headers`, not it.

| Option | Measured (Q2, one multipart POST with `Accept: text/html`, schema `{ "x-n": z.coerce.number() }`) | Verdict |
|---|---|---|
| (a) type-only, no write-back | the handler reads `"5"` (string) where the type would say `number` — the G1 finding, a type that lies whenever a schema coerces or defaults | no |
| (b) a parsed copy on `req.valid` | **nothing breaks**: `req.is` `"multipart"`, `hasBody` true, `accepts(json)` false (correct), busboy constructs, `rawHeaders` 8; `req.valid.headers["x-n"]` is `5` | **yes** |
| (c) replace `req.headers` with the output | zod strips undeclared keys: `req.is` → `null`, `typeIs.hasBody` → `false`, `req.accepts("json")` → `"json"` (wrong: Accept was text/html), busboy throws `Missing Content-Type`, `rawHeaders` 8 → 2. And a later `req.setHeader` silently restores the raw string (`x-n` back to `"5"`), so the type lies again | no |
| (c') merge the output over `req.headers` | the readers survive, but `headersDistinct` now holds `[5]` (a number in a `string[]`), the coerced value reaches every third-party reader, and `req.setHeader` still reverts it | no |

Names arrive lower-cased, so a schema keyed `"X-N"` never matches (Q2e); the
design documents lower-case keys, and the response side accepts any case in
`set()`/`header()` (it types `Lowercase<N>`).

**Recommendation: (b)**, `req.valid`, holding **every** validated part
(`headers`, `cookies`, `signedCookies`, `params`, `query`, `body`), Hono's
`c.req.valid(...)` as a property. Headers are only ever there; the other parts
are also written back as today. H46 (patched): `req.valid.headers["x-n"]` is
`number 5` while `req.headers["x-n"]` stays `string 5` and `req.accepts` still
works; H48: a bad header is a 400 with target `headers`. Typed by reading the
validator's shape (`ResolveValid`), so it adds no key to `__shape` and the
existing `validate.type-test.ts` assertions hold unchanged.

### Responses: the hook point (re-checked)

The existing finding holds on `68023d36`, and narrows: **every producer
commits through one private setter**, `BunResponse`'s `set response`
(`BunResponse.ts:1300`), which runs the transforms (`:1356`, synchronous, given
the serialised text, `BunResponseTransform` `:235-252`), certifies the request
(`markResponded`), wakes the pipeline's waiters and emits `finish`. `json()`
builds the native `Response` at once (`:1463-1497`, `Response.json` on the
no-headers path), and so do `send()` (`:1769`), a passed-through `Response`
(`:1790`), `redirect()` (`:2377`), `sendFile()` after its `stat` (`:2846`), and
the first `write()` (`initLongLivedConnection`, `:1952`). Building the native
`Response` is harmless; **handing it on** is the point of no return. So the
gate sits **in that setter, before the transforms**: the `Response` exists but
nobody has it. `headersSent` reads only `#nativeResponse` (`:2576`), and the
pipeline waits on `headersSent` or `next()` (`BunRouter.ts:808`), so a held
commit simply leaves the layer parked until the verdict commits it or raises.

One gate, two calls: `commit(res, response, ctx)` at the setter, and
`chunk(res, chunk)` for each `write()` of an open stream. Each answers
`undefined` (go), `{ reject }` (nothing has gone out: enter the error
pipeline), `{ replace }` (a stream wrapped so its chunks are checked), or
`{ destroy }` (a chunk after the start), synchronously when the vendor is, or
as a Promise, which **holds** the commit (or the chunk, in order) in `"error"`
mode and is only logged in `"warn"`. A rejection goes to the current layer's
`req.next` (set per layer, `BunRouter.ts:5474`), so the app's error handler
renders it; with none, `router.fetch()` rejects with the
`ResponseValidationError` (H43), as a request `ValidationError` does today
(G4). The gate lives in `BunResponseState` and is installed per request by a
validator whose mode is not `"off"`; with `"off"` no gate exists.

### Runtime cases (`runtime.probe.ts`, step g)

Bad body: `off` → the bad body goes out; `warn` → it goes out and one `warn`
is logged; `error` → as shown. Every GOOD case is the declared status with its
body, for both vendors.

| H | Kind | zod / yup, mode `error`, bad body |
|---|---|---|
| H1–H2 | `json()` | 500 `body.id: …expected string, received number` |
| H3–H4 | `send(text)` | 500 `body: Too small…` / `this must be at least 3 characters` |
| H5–H6 | `send(html)` | 500 `body: must start with "<"` |
| H7–H8 | `send(Buffer)` | 500 `body: expected 4 bytes` |
| H9–H10 | `send(Uint8Array)` | 500 `body: expected 4 bytes` |
| H11–H12 | `send(Blob)` (`image/png`) | 500 `body: not a PNG signature` (read with `arrayBuffer()`, so held for **both** vendors) |
| H13–H14 | `send(native Response)` | 500 `body.id: …` (read from `response.clone()`) |
| H15–H16 | `redirect()` | 500 `headers.location: must start with "/app"`; the 500 carries **no** `Location` (H45) |
| H17–H18 | `sendFile()` | 500 `body: must start with "ok"` |
| H19–H20 | `send(ReadableStream)`, `chunks()` | **200**, `abc` then the body is cut off; logged at `error` |
| H21–H22 | `write()`/`end()`, `chunks()` | **200**, `abc` then cut off; logged at `error` (yup: the chain keeps order, and `end()` does not close a destroyed stream cleanly) |
| H23–H24 | SSE, `sse({ tick })` | **200**, the first event, then cut off at the bad one |

| H | Case | `warn` | `error` |
|---|---|---|---|
| H25 | status 418 undeclared | 418 sent, logged | 500 `status 418 is not declared (declared: 200)` |
| H26 | implicit 200, only 201 declared | 200 sent, logged | 500 `status 200 is not declared` |
| H27 | `send("hi")` where only JSON is declared | sent, logged | 500 `media type text/plain is not declared` |
| H28 | response header `x-ratelimit-remaining: many` | sent, logged | 500 `headers.x-ratelimit-remaining: must match /^\d+$/` |
| H29 | that header missing | sent, logged | 500 `…expected string, received undefined` |
| H30 | that header right | 200 | 200 |
| H31 | `Set-Cookie: sid` without `HttpOnly` | sent, logged | 500 `cookies.sid.httpOnly: expected true` |
| H32 | `Set-Cookie` as declared | 200 | 200 |
| H33 | `204: null`, empty | 204 | 204 |
| H34 | `404: null`, a body sent | sent, logged | 500 `status 404 declares no body` |
| H35 | `redirect(301)`, only 302 declared | 301 sent, logged | 500 `status 301 is not declared` |
| H36 | `sendStatus(404)` undeclared | sent, logged | 500 |
| H37 | `text/csv` where only JSON is declared | sent, logged | 500 `media type text/csv is not declared` |
| H38 | `write()` with an undeclared media type | sent, logged | **500**: refused at the stream's opening, before anything went out |
| H39 | SSE event `boom` undeclared | sent, logged | 200, cut off, logged |
| H40 | a stream against a whole-body schema | sent; one `warn` "not checked… declare chunks() or sse()" | the same: not buffered, not failed |
| H41 | `HEAD` on a GET route, bad body | — | 500 (checked as GET would be) |
| H42 | 304 from freshness, 304 undeclared | — | 304 (implicit when the request was conditional) |
| H43 | `error`, no app error handler | — | `router.fetch()` rejects with `ResponseValidationError` |
| H44 | handler throws; the error handler's 500 is undeclared | — | 500 `BoomError` (the original error), the mismatch logged at `warn`: an error handler's response is reported, never replaced |
| H45 | refused redirect | — | the 500 has no `Location` |
| H46–H51 | request headers, cookies, signed cookies | see above | |
| H52 | a handler **returns** a native `Response` | — | no response within 300 ms: bun-common ignores return values (`BunRouter.ts:5286`); `res.send(response)` is the supported form (H13) |

### Types (`types.probe.ts`, steps b–f)

The patched copy checks clean with its own `__tests__` (step b, 95 files) and
the probe; all **19** directives fire (step c: N1–N18 plus the pinned limit L1);
the probe against the unpatched base fails with 25 errors (e); the generated
overloads are **byte-identical** (f).

| # | Control (each must be a compile error) | Error |
|---|---|---|
| N1 | an undeclared cookie read, `req.cookies.nope` | TS2339 |
| N2 | a declared cookie read as the wrong type | TS2322 |
| N3 | a typed header read as the wrong type, `const s: string = req.valid.headers["x-n"]` | TS2322 |
| N4 | an undeclared header on the typed view | TS7053 |
| N5 | an undeclared signed cookie | TS2339 |
| N6 | wrong body for a status | TS2353 |
| N7 | undeclared status, `status(418)` | TS2345 (`'200 \| 201 \| 204 \| 302 \| 404'`) |
| N8 | text sent where only JSON is declared | TS2345 |
| N9 | a wrong header value type, `set("X-RateLimit-Remaining", 5)` | TS2345 |
| N10 | a header value outside its declared literal | TS2345 |
| N11 | `redirect(301, …)`, 301 undeclared | TS2769 |
| N12 | `json()` on a status declaring only text and bytes | TS2345 (`never`) |
| N13 | bytes where only JSON is declared | TS2345 |
| N14 | a body on a `null` status | TS2345 (`never`) |
| N15 | a declared `Set-Cookie` given a number | TS2345 |
| N16 | `redirect(url)` (302) where 302 is undeclared | TS2345 (`never`) |
| N17 | a plain object where only a stream and an image are declared | TS2353 |
| N18 | `req.valid.headers` with no validator | TS2339 |
| L1 | (a limit, not a control) an inline validator followed by a handler typed `TypedRouteHandler` still loses `TShape` | TS2769 |

Two findings from the type work:

- **A pinned limit is lifted.** `__tests__/verbTyping.type-test.ts:181-182`
  pins "an inline generic validator loses inference to TShape" with a
  `@ts-expect-error`. With the handler's request passed as one type argument
  (`TypedRouteHandler`'s new `TReq`), the inline form infers for a
  `ResolvedHandler`-typed handler, and the negative control below it still
  fires. The patch replaces that directive with a comment (5 lines); a
  `TypedRouteHandler`-typed one is still limited (L1).
- **Typing `set()`/`header()`/`cookie()` by declared names makes a generic
  `this` unassignable to `BunResponse` inside the class**: 35 internal
  `return this`/`setResponse(this)` sites failed, fixed by one private
  `#self` getter. Outside the class, a typed `res` still passes to a helper
  taking a bare `BunResponse` (the boundary in the probe compiles).
  `json()`/`status()` alone (the response-typing patch) did not cause it.

**Consumer finding (step d).** Widening `ValidationTarget` with `cookies` and
`signedCookies` breaks bun-jobs: `lib/api/errors.ts:409` maps request issues
into `ProblemIssueDto`, whose `target` is the four-member union, declared twice
(`bun-jobs/lib/api/contract/types.ts:61`, `lib/api/serialize.ts:65`). That is
the management API's contract, which bun-jobs-ui reads.

### Cost per body kind (`bench.ts`, step i)

Two wrapped runs (`results.txt` has both, verbatim). **Run 2 is the one to
quote**: 15 rounds, load 18.0 at the start and 15.6 at the end on 16 cores,
every median within 25% of its minimum. Run 1 (7 rounds) ran at load 23.7 →
39.9 while other sessions' jobs held the machine; its spread is wide (some
`error` minimums below their baseline), so only its order of magnitude counts.
Minimums, µs per request through `router.fetch()`, zod, valid bodies:

| Body kind | base (no validator) | `off` (validator, no gate) | `error` | gate cost (`error` − `off`) | run 1 `error` − base |
|---|---|---|---|---|---|
| `json()`, 20-item list | 3.28 | 3.24 | 6.01 | **+2.77** | +7.26 |
| `send(text)` | 1.97 | 2.09 | 3.36 | **+1.27** | +7.93 |
| `send(html)` | 2.49 | 2.84 | 3.85 | **+1.01** | +2.71 |
| `send(Buffer)`, 512 B | 2.57 | 2.77 | 4.21 | **+1.44** | +37.72 |
| `send(Uint8Array)`, 512 B | 2.35 | 2.46 | 3.46 | **+1.00** | −9.55 (noise) |
| `send(Blob)`, 512 B (read, held) | 2.79 | 3.12 | 5.51 | **+2.39** | +10.42 |
| `send(native Response)` (clone, held) | 3.60 | 3.67 | 11.95 | **+8.28** | +26.57 |
| `redirect()` (headers only) | 3.93 | 3.98 | 5.59 | **+1.61** | +3.28 |
| `sendFile()` (file read, held) | 28.99 | 28.50 | 44.26 | **+15.76** | +37.48 |
| `send(ReadableStream)`, 4 chunks (piped through a check) | 4.56 | 4.47 | 16.08 | **+11.61** | +27.10 |
| `write()`/`end()`, 4 chunks | 8.86 | 9.38 | 11.56 | **+2.18** | +5.27 |
| SSE, 4 events | 9.31 | 9.91 | 17.63 | **+7.72** | +10.87 |
| request `headers` + `cookies` validated, copied to `req.valid` | 2.95 | — | 5.91 | **+2.96** (vs no validator) | +4.04 |

Read: **`off` costs nothing beyond the validator itself** (no gate is
installed; `off` − base is within the noise). A buffered body checked in place
costs about 1–3 µs, the schema's own price. The expensive kinds are the ones
that must **read** something to check it, or wrap a stream: a cloned
`Response` (+8), a `TransformStream` piped into a user stream (+12), SSE
framing (+8), a file read (+16). All are `"error"`/`"warn"` costs only, which
is why the default stays `"off"` and the advice stays `"error"` in development
and tests. An async vendor's cost (yup) is the plan's existing figure (+228 µs
minimum per request, `../results-proto.txt`) and was not re-measured here.

---

## Design conclusions

### Per body kind

Every kind is checked at **one hook**, the commit point (`set response`),
for status, headers, `Set-Cookie` and media type; the body is checked there
too unless it streams, in which case each chunk or event is checked as it is
written. A status not declared is a mismatch, whatever the body.

| Body kind | What the schema sees | When it is checked | `off` | `warn` | `error` |
|---|---|---|---|---|---|
| `json(value)`, `send(object)` | the raw value (`#sentBody`), not its text | at the commit point, before the `Response` is handed on | no gate | sent; one `warn` (after it, for a Promise) | sync: decides in place; Promise: **held**; a mismatch → `ResponseValidationError` (500) through the error pipeline |
| `send(string)`, text/HTML | the string; parsed first when the media type is JSON (`res.type("json").send(text)`) | commit point | no gate | sent, logged | as `json()` |
| `send(Buffer \| Uint8Array \| ArrayBuffer)` | a `Uint8Array` view; decoded to a string for `text/*`, parsed for JSON | commit point | no gate | sent, logged | as `json()` |
| `send(Blob)` | its bytes, read with `blob.arrayBuffer()` (a Blob reads again, so what is sent is untouched) | commit point; the read is async, so **held for every vendor** | no gate | sent; checked after | held until read and checked |
| `res.send(new Response(…))` | status and headers off that `Response`; the body read from `response.clone()` | commit point; held (async read) | no gate | sent; checked after | held |
| a handler **returning** a `Response` | not supported by bun-common today (H52) | — | — | — | — (a separate feature; it would route into `send(response)`) |
| `redirect()` | status (a declared 3xx) and headers (`location`); the generated body is exempt | commit point | no gate | sent, logged | 500; `Location` dropped from it |
| `sendFile()` / `download()` | status (200, 206, and the 304/404/412/416 it can answer, each declared or a mismatch; a conditional 304 is implicit), headers, and the file's bytes **only** when a whole-body schema is declared for its type; `opaque()` declares the type without reading | commit point, after `stat`, ranges and freshness | no gate | sent; checked after | held while read |
| `send(ReadableStream \| Readable \| async iterable)` | status, headers and media type at the commit; then each chunk (`chunks(S)`) through a `TransformStream` piped in | commit point, then per chunk as it flows | no gate | chunks pass; each mismatch logged | before the start: 500. After: the stream is **errored** (the client sees it cut off) and the mismatch logged at `error` |
| `write()` / `end()` | the same: the first `write()` opens the stream and commits; then each chunk | commit at the first write (can still be refused: H38), then per write; an async verdict chains so order holds, and `end()` waits for the chain | no gate | passes, logged | before the start: 500. After: `res.destroy(error)` and log at `error`; `end()` never closes a destroyed stream cleanly |
| SSE (`text/event-stream`) | each event, framed by blank lines across chunk boundaries; `data` JSON-parsed when it parses; the schema chosen by the `event:` name (`message` by default); an undeclared name is a mismatch | per event, as written | no gate | passes, logged | the stream is cut off at the bad event, logged |
| a stream against a **whole-body** schema | nothing: a stream is never buffered | — | — | one `warn` per route: declare `chunks()` or `sse()` | the same (not failed) |
| `sendStatus()`, `handleNotFound()`, `sendFile` failures, 204/205/304 | status and headers; the body is exempt (framework-made or stripped) | commit point | no gate | logged | 500 |
| `HEAD` | checked as the GET it reuses (the body is dropped by Bun, not by the check) | commit point | | | 500 on a mismatch (H41) |
| an error handler's own response | checked, **only reported** | commit point | | logged | logged, never replaced (H44): replacing it would mask the error it renders |

What `"error"` can still do once a body has started: **only cut it off**. The
status line and headers are out; the router already runs the error handlers
for a late error and destroys a stream none handles (`CLAUDE.md`, "Router —
Express 5 semantics"), and the gate does the same directly: `res.destroy()`
for `write()` chunks, `controller.error()` for a piped stream, plus a log line
at `error`, since no client-visible status can carry it. Everything decided at
the commit point (status, headers, cookies, media type, a buffered body)
happens **before** anything goes out, so a mismatch there is always a clean
500.

On a refusal the gate drops the refused response's own headers (`Location`,
`Set-Cookie`, `Content-*`, `ETag`, `Last-Modified`) and keeps the ones set for
the request as a whole (CORS, `Vary`), so the 500 describes itself (H45).

### Request headers and cookies

- **Headers: option (b).** `req.valid.headers`, typed, holding the parsed
  output; `req.headers` stays the raw view that busboy, `type-is` and
  `accepts` read (Q2). Never written back.
- **Cookies: two targets, `cookies` and `signedCookies`**, validated, written
  back (as `query`/`body`) and typed on `req.cookies` / `req.signedCookies`,
  and copied to `req.valid` like every other part. Only `signedCookies` can
  require a signature (Q1c–Q1f, H49–H51).
- **`req.valid`** holds every part a validator parsed, merged across a
  mount's and a route's validators at runtime. Its type is read off the
  route's shape, so a mount's parts the route also declares are the route's.

### The final signatures (as prototyped)

```ts
// bun-common, BunValidate.ts
export type ValidationTarget = "params" | "query" | "body" | "headers" | "cookies" | "signedCookies";
export interface ValidationSchemas {
  params?: StandardSchemaV1; query?: StandardSchemaV1; body?: StandardSchemaV1;
  headers?: StandardSchemaV1;        // lower-case keys; typed on req.valid.headers only
  cookies?: StandardSchemaV1;        // req.cookies, written back
  signedCookies?: StandardSchemaV1;  // req.signedCookies: verified only; tampered = false
}
validate<S, H, R, const RS extends ResponseSchemas | undefined>(schemas: S, options?: {
  // …today's options, plus:
  responses?: RS;                                   // by status; undeclared = mismatch
  responseValidation?: "off" | "warn" | "error";    // default "off"
  logger?: LoggerLike;
}): ValidatorMiddleware<ValidatedShapeFor<S, H, R, RS>>;

// bun-common, responseContract.ts
type ResponseSchemas = Readonly<Record<number, ResponseSpec>>;
type ResponseSpec =
  | StandardSchemaV1                       // shorthand: { content: { "application/json": S } }
  | null                                   // no body
  | {
      headers?: StandardSchemaV1;          // lower-case names; set-cookie excluded
      cookies?: StandardSchemaV1;          // { [name]: { value, httpOnly, secure, sameSite?, path?, domain?, maxAge?, expires?, partitioned } }
      content?: Readonly<Record<string, ContentSpec>> | null;   // media type (type/* and */* fall back) → body
    };
type ContentSpec = StandardSchemaV1 | null | StreamChunks | SseEvents | OpaqueBody;
function chunks<S extends StandardSchemaV1>(chunk: S): StreamChunks<S>;
function sse<const E extends Record<string, StandardSchemaV1 | null>>(events: E): SseEvents<E>;
function opaque(): OpaqueBody;
class ResponseValidationError extends Error {
  issues: { target: "response"; part: "status" | "headers" | "cookies" | "body" | "chunk" | "event"; message: string; path: string }[];
  responseStatus: number; status: 500;
}

// bun-common, BunRequest.ts: three defaulted, trailing type parameters
class BunRequest<TParams, TQuery, TBody,
  TCookies = Record<string, JsonValue>,
  TSignedCookies = Record<string, JsonValue>,
  TValid = Record<never, never>> {
  get cookies(): TCookies; get signedCookies(): TSignedCookies;
  declare valid: TValid;                    // every parsed part: headers, cookies, signedCookies, params, query, body
}

// bun-common, BunResponse.ts (TResponses from the response-typing patch, now a map of
// { json, send, headers, cookies } per status)
status<const C extends AllowedStatus<TResponses>>(code: C): BunResponse<_, NarrowResponses<TResponses, C>>;
json<T extends JsonBodyFor<TResponses>>(body: T): BunResponse;          // the JSON media types' bodies
send(body: SendBodyFor<TResponses>): BunResponse;                       // every declared body, or a native Response
set<N extends string, V extends HeaderValueFor<TResponses, N>>(name: N, value: V, replace?: boolean): this;
header<N extends string, V extends HeaderValueFor<TResponses, N>>(name: N, value: V): this;
cookie<N extends string, V extends CookieValueFor<TResponses, N>>(name: N, value: V, opts?: BunCookieOptions): this;
redirect(url: RedirectUrl<TResponses>): BunResponse;                    // 302 must be declared
redirect<const C extends RedirectStatus<TResponses>>(status: C, url: string): BunResponse;  // declared 3xx

// bun-common, types/general.ts and types/routeTyping.ts
type TypedRouteHandler<TParams, TQuery, TBody, R = unknown,
  TRes = BunResponse, TReq = BunRequest<TParams, TQuery, TBody>> = (req: TReq, res: TRes, next: NextFunction) => R | Promise<R>;
// MountedHandler / ResolvedHandler pass
//   TRes = BunResponse<unknown, ResolveResponses<Shape>>
//   TReq = BunRequest<P, Q, B, ResolveCookies<Shape>, ResolveSignedCookies<Shape>, ResolveValid<Shape>>
// where ResolveValid<S> = { [K in keyof S as K extends "responses" ? never : K]: S[K] }
```

Typing rules, beyond the response-typing patch's input/output rule (a body is
held to the schema's input, its output when the input is `unknown`):
`json()` takes the bodies of `application/json` and `*+json`; `send()` takes
every media type's body (`text/*` its schema's type, bytes their schema's type
or a `Blob`, `chunks()`/`sse()` a stream or a string, `opaque()` bytes, a
`Blob` or a stream, `null` nothing) and always a native `Response`;
`set()`/`header()` constrain a declared name in any case and leave any other
name free; `cookie()` constrains a declared name to its `value`'s type;
`write()` is not typed per event.

### Open questions, each with a recommendation

1. **An undeclared 304 made by freshness from a conditional request: allowed?**
   Recommended: **yes**, implicitly (H42). It is the framework's answer to
   an `ETag` the route sent, not the handler's choice.
2. **An error handler's response: checked and only reported, never
   replaced?** Recommended: **yes** (H44); otherwise every thrown error on a
   route without `500` declared turns into a `ResponseValidationError` and the
   original is lost. Declare such statuses once with `commonResponses`.
3. **On a refusal, drop the refused response's own headers?** Recommended:
   **yes, the list above** (H45); keep request-wide ones.
4. **A whole-body schema against a stream: buffer it, fail it, or skip with a
   warning?** Recommended: **skip with one warning per route** (H40); a
   stream's contract is `chunks()` or `sse()`.
5. **Blobs, files and a passed-through `Response` are read to be checked
   (always async, so `"error"` holds them).** Recommended: **yes**, and
   `opaque()` for large files and images, which declares the type without
   reading. A size bound is a later option.
6. **A handler returning a native `Response`.** Recommended: **out of scope
   here** (bun-common ignores return values, H52); if it is ever supported, it
   routes into `send(response)` and inherits this check.
7. **Widening `ValidationTarget` breaks bun-jobs' `ProblemIssueDto`**
   (step d). Recommended: **widen the DTO** in the same PR (both copies), a
   management-API contract change the bun-jobs-ui owner reviews; the V1
   `ValidationIssue<TTarget>` parameter does not avoid it, since bun-jobs maps
   real request issues.
8. **Type `req.valid` under `replace: false` too?** The runtime fills it
   either way. Recommended: **yes, later**: it changes five existing
   assertions in `validate.type-test.ts` that pin `replace: false` to an empty
   shape; the spike kept them.
9. **Accept the lifted inline-validator limit** (`verbTyping.type-test.ts`
   changes 5 lines)? Recommended: **yes**; the test pinned a limit so that
   lifting it would be noticed.
10. **Typed SSE writes** (`res.event("tick", data)` typed by `sse()`).
    Recommended: **later**, a helper on top of `write()`; this spike checks
    events at runtime only.
11. **The response cookie view: values as written (`j:`/`s:` kept) or
    decoded?** Recommended: **as written plus the attributes**, since the
    contract is about the header that goes out; a `signed` flag can come later.
12. **Header value types render as `string | (string & string[])`** in
    errors. Recommended: tidy with a non-distributive `Extract` in the PR;
    cosmetic.
13. **The internal `#self` getter** (35 sites) needed once `set()`/`header()`/
    `cookie()` are typed. Recommended: **accept it**; the alternatives
    (interface merging, an intersection type on `res`) put the raw signature
    first and the controls stop firing.
