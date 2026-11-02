# Typed client: server-sent events

A sub-plan of [`README.md`](README.md) (**TC**): typed, validated event
streams over SSE, with `Last-Event-ID` resume, for bun-common routes and
Nest's `@Sse()`. SSE is also the fallback transport of the live channel
([`websocket.md`](websocket.md) §9).

Written 2026-11-02 against `develop` at `e80ab379`. **No product code was
changed.** `file:line` at `e80ab379`, relative to `packages/`. Markings as in
TC. **BNR** is [`bun-native-routes/README.md`](../bun-native-routes/README.md)
(its §16 owns the SSE writer).

**Status (2026-11-02): approved by the user** (TC §14, Q22; names as in
TC §16). **Nothing is built.** The next PRs are TC's **PR-K**,
**PR-M1** and **PR-C1**; this sub-plan's PRs follow them as TC §15 orders.

---

## 1. Summary and decisions

| # | Decision | Why |
|---|---|---|
| S-D1 | **The type source is the route's declared response: `sse({ event: schema })`** (BV V3b). The client's event union is keyed by event name, with each event's data typed from its schema's wire side after JSON. | It is already declared, checked per event on the server, and documented: `responseBodies.ts:204`, OpenAPI's `x-sse-events` (`docs/openapi.ts:1819-1835`), AsyncAPI's SSE endpoints (`docs/asyncapi.ts:846`) [S]. Nothing new for a route author. |
| S-D2 | **The client reads SSE over `fetch` with its own parser**, never `EventSource`. | `EventSource` sends no custom headers [V, MDN], so no `Authorization`; and **Bun has no `EventSource` at runtime** although bun-types declares it (measured: `typeof EventSource` is `"undefined"` on 1.4.4-canary.1+11c367163; oven-sh/bun#8474 "Implement EventSource" is open) [M, V], so an `EventSource` client would not run under Bun (SSR, tests, a Bun service calling another). |
| S-D3 | **`Last-Event-ID` resume is the client's default**: it remembers the last `id:` it received and sends it as the `Last-Event-ID` header on every reconnect, honouring the server's `retry:`. | The SSE standard's own resume, which `EventSource` does implicitly [V]; the server half (reading the header, replaying) is BNR PR-sse2's (§4). |
| S-D4 | **A gap is an event the route declares** (`gap`), sent when the server cannot replay from the given id; the client surfaces it, and the live layer invalidates every active query on it. | The same contract as the WebSocket channel's `gap` (`websocket.md` §7); bun-jobs' `gap` frame is the precedent (`bun-jobs/lib/api/ws/session.ts:1039`) [S]. |
| S-D5 | **Validation per event**, both built-in and BYO, under TC §5.5's defaults (on in development, warn and deliver). | Mirrors the server's per-event check (`responseBodies.ts:186-200`) [S]. |

---

## 2. What exists today

- **The declaration**: `sse(events, { data })` (BV V3b, #484, 2026-10-21;
  `responseBodies.ts:204-247`) declares a `text/event-stream` body checked
  event by event: the schema is chosen by the event's name (`message` when
  there is no `event:` line), `data` decoded as JSON or text, an undeclared
  name a mismatch, the stream cut at a bad event under `"error"`. Its events
  are a contract on the `sse` transport, keyed by `event` with parts `data`
  and `id` (`contract/sse.ts:16-20`) [S].
- **Documents**: OpenAPI 3.1 lists a stream's events under `x-sse-events`
  (`docs/openapi.ts:1830`); AsyncAPI 3.0 documents SSE endpoints and a
  channel's SSE fallback (`docs/asyncapi.ts:800`, `:846`) [S].
- **A parser exists server-side**: `SseFramer` frames events across chunk
  boundaries for the response check (`responseBodies.ts:536-630`), but it
  lives in the package root, not the browser-safe entry [S].
- **No writer**: there is no `res.sse()`, `SseWriter`, event-id generation,
  `retry:` emission, heartbeat, or `Last-Event-ID` handling in bun-common.
  BNR §16's PR-sse2 (the writer, with BV's V11 typed `res.sse({ contract })`)
  is not built; PR-sse1 (streams that stay open) merged as #267 [S, git log;
  the BNR status table still says "plan only"].
- **Nest**: `@Sse()` works on bun-nest (`bun-nest/__tests__/sse.nest.test.ts`)
  and `@Validate`'s responses check `@Sse` per event (BV V7b, #523) [S].
- **Bun**: no `EventSource` (S-D2) [M].

---

## 3. The client

### 3.1 API [D]

```ts
const stream = sse(api, "GET /jobs/:id/events", { params: { id }, signal });

for await (const e of stream) {            // e: { event: "progress"; data: Progress; id?: string } | { event: "done"; … }
  if (e.event === "progress") bar.set(e.data.percent);
}
stream.on("done", (d) => toast(d.result)); // or listeners
stream.lastEventId;                         // what a reconnect will send
stream.close();
```

- The route key form (`"GET /path"`) is the HTTP map's (TC §6.1); a route
  whose 200 response is an `sse()` declaration is offered by `sse()` and
  not by `api.get()` (the generated map marks it `stream: "sse"`) [D].
- **Parser**: a fresh, browser-safe implementation in bun-client (~120 lines
  [I]) of the WHATWG event-stream rules: CRLF, LF or CR line ends, a blank
  line ending an event, `:` comments, `id:` (ignored when it contains NUL),
  `retry:` (digits only), multi-line `data:` joined by `\n`, BOM stripped.
  It is tested against the server's `SseFramer` with a shared corpus, so the
  two cannot drift [D]; moving `SseFramer` into the shared contract package
  (TC D20) is the alternative if the corpus shows they must be one.
- **Typed events**: `event` narrows `data`; `data` is decoded as the route
  declared it (`data: "json" | "text"`, `responseBodies.ts:69-76`) [S].

### 3.2 Resume and reconnection [D]

| Behaviour | Default | Option |
|---|---|---|
| Reconnect | after the server's `retry:` value if one was sent, else 3 s; doubling on consecutive failures to 30 s, half-jittered; reset after 60 s open | `reconnect: { initialMs, maxMs } \| false` |
| `Last-Event-ID` | the last `id:` seen, sent as the header on every reconnect | `lastEventId` to start from a known id |
| Heartbeat watchdog | none by default; when the route documents a heartbeat interval, 2 × it + 5 s with no bytes (comments count) reconnects | `heartbeatMs` |
| Stop | a `204` answer, `close()`, the signal, or a 4xx other than 408/429 | `fatalStatuses` |
| Gap | a declared `gap` event (S-D4) is delivered like any event, and `stream.on("$gap")` fires | — |

A fresh `fetch` per reconnect carries the client's headers and auth (TC §6.1),
so a refreshed token applies to the next attempt.

### 3.3 Validation and errors [D]

- Each event's `data` is checked with its event's built-in schema
  (generated Zod, or the shared schema module's) and any BYO Standard Schema;
  an undeclared event name is a validation issue (the server's rule).
  Default: on in development, off in production; a failure **warns and
  delivers**, `onFailure: "drop"` drops the event, `"throw"` ends the
  iterator with a `ValidationError`.
- The stream's HTTP status and headers go through the HTTP core's
  `Result` first: a declared error status (a 401 problem) is a typed
  `HttpError` before any event is read (TC §4.3).
- Errors: `HttpError`, `ValidationError` (direction `"receive"`, target
  `"data"`, the event name as the key), `NetworkError` on a drop the client
  will retry (not surfaced unless retries are off), `StreamClosedError`
  on a fatal status.

### 3.4 Backpressure [D]

Reading is pull-based: the parser reads the response body only as fast as
the iterator is consumed, so a slow consumer slows the TCP window, which is
the backpressure SSE has [V, the Streams standard]. Listeners (`on`) consume
eagerly and drop nothing; an app that needs a bounded buffer uses the
iterator.

---

## 4. What the server must add (BNR PR-sse2)

BNR §16 already plans the writer; the typed client needs four things from it,
which this plan asks BNR's PR-sse2 to carry [D]:

1. **`res.sse({ contract })`** (BV V11): `send({ event, data, id })` typed
   and checked by the route's `sse()` declaration, before encoding.
2. **Ids**: `send` takes an `id`, or an `ids: "auto"` option numbers events
   per stream.
3. **Resume**: `req.get("last-event-id")` handed to an optional
   `resume(lastEventId)` hook that returns the events to replay, or `"gap"`
   to send the declared `gap` event.
4. **`retry:` and heartbeat comments** as writer options.

The client works against any SSE server without them (an id-less stream
simply cannot resume) [D].

---

## 5. Tests

- **Parser**: the WHATWG corpus cases (line ends, comments, `id` with NUL,
  `retry` with non-digits, multi-line data, BOM), and the shared corpus with
  `SseFramer` (control: a framer that splits only on `\n\n` fails the CR
  cases).
- **Client, against a real stream on port 0** (a plain handler writing the
  event-stream format, so the test does not wait for PR-sse2): typed
  iteration; `Last-Event-ID` sent on reconnect (control: the header absent
  when no id was seen); `retry:` honoured; a declared `gap`; a validation
  failure in each mode; a 401 before the stream as `HttpError`; abort.
- **Types**: event narrowing; `api.get()` refused for an SSE route.

## 6. PRs and effort

| PR | What | Depends on | Effort |
|---|---|---|---|
| **PR-S1** SSE client | `sse()` from `./sse`, the parser and its shared corpus, resume, reconnect, validation, errors; `stream: "sse"` and event maps in the generator (from `x-sse-events`) | TC PR-C1, PR-C2 | ~3 d |
| *(BNR PR-sse2)* | the writer with §4's four additions | BNR | BNR's estimate, plus ~1 d for §4 |

Questions: answered 2026-11-02 (TC §14 Q22, approved as recommended). Names (approved 2026-11-02): `sse` (function, `./sse`), `EventStream`,
`StreamClosedError`, `$gap`, `heartbeatMs`, `fatalStatuses` (TC §16).
