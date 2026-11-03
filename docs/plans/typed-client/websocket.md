# Typed client: WebSocket channels, both directions

A sub-plan of [`README.md`](README.md) (**TC**): how the typed client talks to
a WebSocket channel with typed, validated messages in both directions,
request/response over the socket, subscriptions, server push, reconnection and
backpressure, for bun-common's `defineChannel()` channels and for bun-nest's
gateways. Live query invalidation (TC D15) is one channel built this way
(§9).

Written 2026-11-02 against `develop` at `e80ab379`. **No product code was
changed.** Every `file:line` is at `e80ab379` and relative to `packages/`
unless it says otherwise. Markings as in TC: **[S]** source, **[M]** measured
(evidence named), **[V]** third party at a pinned version, **[I]** inference,
**[U]** unverified, **[D]** decision. **BV** is
[`bun-validate/README.md`](../bun-validate/README.md), **AD**
[`api-docs-generation/README.md`](../api-docs-generation/README.md), **NTR**
[`nest-typed-routes.md`](nest-typed-routes.md). Evidence:
[`evidence/transports/ws-typing/`](evidence/transports/README.md).

**Status (2026-11-02): approved by the user** (TC §14, Q19–Q21; names as in
TC §16 and §13.3 here). **Nothing is built.** The next PRs are TC's **PR-K**,
**PR-M1** and **PR-C1**; this sub-plan's PRs follow them as TC §15 orders.
**The reply-id mismatch is fixed by PR-W1**: `docs/asyncapi.ts:617`
documents a reply that echoes the request's id, which the handler dispatch
(`channel.ts:296-308`) never sends (§2, §10.1). **PR-W1 is built**
(2026-11-03, branch `feat/bun-common-channel-server`; TC's Status row):
§10.1–10.4; §10.5 is not in it. **PR-W2 is built** (2026-11-03, branch
`feat/bun-client-channel`; TC's Status row): the client of §3–§8, the
generator's `Channels`; `"bun-nest"` is PR-W3's. **PR-W3 is built**
(2026-11-03, branch `feat/bun-client-nest-codec`; TC's Status row): §11's
codec, the generator reading `gatewayAsyncApi()`'s packets, NTR §7's
shared maps; its names (the ack as the sent type `"<event> ack"`,
`ChannelDescriptor.codec`) **approved by the user on 2026-11-03**.

### Contents

1. [Summary and decisions](#1-summary-and-decisions)
2. [What exists today](#2-what-exists-today)
3. [Where the types come from](#3-where-the-types-come-from)
4. [The client API](#4-the-client-api)
5. [Validation, both directions](#5-validation-both-directions)
6. [Errors](#6-errors)
7. [Reconnection, subscriptions and resume](#7-reconnection-subscriptions-and-resume)
8. [Backpressure](#8-backpressure)
9. [Live invalidation is a channel](#9-live-invalidation-is-a-channel)
10. [Server pieces this needs](#10-server-pieces-this-needs)
11. [Nest gateways](#11-nest-gateways)
12. [Tests](#12-tests)
13. [PRs, questions and names](#13-prs-questions-and-names)

---

## 1. Summary and decisions

bun-validate built the server half of what the old TC §6.5 called "typed
channels (later, PR-M4)": `defineChannel()` checks every received frame,
types and checks every sent one, documents the channel in AsyncAPI 3.0, and
keeps its pure contract browser-safe (`channelContract()` in
`@kingsleyweb/bun-common/contract`). What is missing is the **client**, and
three server details a client needs: replies that echo the request's id,
send status (backpressure), and typed path params on the socket.

| # | Decision | Why |
|---|---|---|
| W-D1 | **The channel's contract is the type source.** In a monorepo the client imports the shared `channelContract()` module and infers; in a separate repo it reads a generated `Channels` map from the AsyncAPI document. | The same split as HTTP (TC D3). Measured over 200 channels of 16 messages: inference adds 2.7 s of tsc over declaring the schemas (6.61 s against 3.92 s), a generated map checks in 1.25 s; `bun --check` takes 324 ms and 60 ms [M, `ws-typing/results.txt`]. §3 |
| W-D2 | **One client object per channel**: `channel(api, contract, { params, query })` returns `send`, `request`, `on`, `messages()` and `close`, typed by the contract. | The envelope `{ type, id?, data }` is keyed by `type` on both sides (`contract/channel.ts:25-29`) [S], so a `type` literal narrows the data, as a path literal narrows an HTTP call. §4 |
| W-D3 | **Request/response is `request(type, data)`**, available for the types the contract's `replies` names; the client stamps the envelope's `idField`, the server's reply echoes it. | `replies` and `envelope.idField` are already in the contract and the AsyncAPI document (`contract/channel.ts:46-69`, `docs/asyncapi.ts:614-617`, `:771-775`) [S]; the server does not echo the id yet (§10.1). §4.2 |
| W-D4 | **Both directions are checked on the client**: a send through the contract's sender guard, a received frame through its receiver guard, with the built-in schemas (generated Zod, or the shared contract's own) and any BYO Standard Schema, under TC §5.5's defaults. | The guards already exist and are browser-safe (`contract/guard.ts:430`, `:463`) [S]; reusing them is TC D20. §5 |
| W-D5 | **Reconnect, heartbeat, resubscribe and resume are the client's**; resume is an app-level protocol the channel declares, not a built-in. | bun-jobs-ui's live client is the tuned reference (backoff 500 ms → 30 s, half-jittered; heartbeat 25 s plus 5 s slack; `app/live/client.ts:366-384`, `:618-664`) [S]; bun-jobs' `{ epoch, afterSeq }` resume is its own protocol (`bun-jobs/lib/api/ws/session.ts:964-1060`) [S]. §7 |
| W-D6 | **Backpressure is surfaced, not hidden**: the client exposes `bufferedAmount` and a `sendWhenReady()`; the server's checked `send` returns Bun's send status. | The browser `WebSocket` has no drain event; Bun's `ws.send()` returns `-1` under backpressure and `0` when dropped (`node_modules/bun-types/serve.d.ts:1-40`) [V], and `defineChannel`'s send discards it (`channel.ts:336-358`, `:429-436`) [S]. §8 |
| W-D7 | **Envelopes are codecs**: `"bun-common"` (the default), `"bun-nest"` (socket.io-style packets with acks) and a custom `{ encode, decode }`. | bun-nest's adapter speaks EVENT/ACK packets, not bun-common frames (`bun-nest/lib/BunWebSocketAdapter.ts:242`, `:1547-1605`) [S]; bun-jobs' frames are flat, not `{ type, data }` (`bun-jobs/lib/api/ws/protocol.ts:96-296`) [S]. §11 |
| W-D8 | **Live invalidation is one channel declared with `defineChannel`** (`liveChannel()`), not a bespoke protocol. | It gets validation, AsyncAPI and the client for free; TC's old PR-M3 shrinks. §9 |

---

## 2. What exists today

All [S], at `e80ab379`:

- **The pure channel contract** (BV V8, #525, 2026-10-24):
  `contract/channel.ts` exports `wsTransport` (`:25`, both sides keyed by
  `type`, one part `data`), `ChannelSpec` (`:71-102`: `path`, `request` for
  the upgrade, `receives`, `sends`, `messageValidation`, `closeOnInvalid`,
  `binary`, `subprotocol`, `envelope.idField`, `replies`, `topics`,
  `fallback`, `meta`), the envelope `ChannelMessage` (`:105-112`), the error
  frame `ChannelErrorFrame` (`:126-139`, codes `VALIDATION`,
  `UNKNOWN_MESSAGE`, `UNSUPPORTED_DATA`) and `channelContract(spec)`
  (`:226-262`), which returns `{ contract, meta, spec }` with the spec's
  literal type kept. Browser-safe: `__tests__/contract/browserSafety.test.ts`
  bundles the entry. Measured here: the guards plus `channelContract` bundle
  for a browser at 19.2 KB minified, **6.8 KB gzip**, with no `node:`, `bun:`
  or `Bun.` marker [M, `contract-reuse/results.txt`].
- **The server binding** `defineChannel(spec)` (`channel.ts:196`): `checks()`
  for the upgrade's request schemas, `handler(handlers)` dispatching by
  `type` with the received data parsed (`:297-307`), typed `send(ws, type,
  data)` and `publish(ws, topic, type, data)` (`:151-171`) checked under the
  `out` policy, frames handled one at a time per socket, an error frame for an
  invalid, unknown or binary frame (`:270-296`).
- **What it does not do:** a handler's return value is ignored (`:298-307`),
  and `send` takes no id, so **a reply never echoes the request's id** even
  though `replies` is declared and the AsyncAPI document says the id is
  "echoed by it" (`docs/asyncapi.ts:617`). Only error frames echo it
  (`channel.ts:214-216`, `:283`, `:294`); the handler dispatch
  (`:296-308`) sends nothing back. **PR-W1 fixes this mismatch** (§10.1).
  `publish` needs a socket (no
  server-wide publish). `send` returns `void`, so Bun's backpressure status is
  lost (`:336-358`, `:429-436`). A handler sees `ServerWebSocket<never>`, so
  `ws.data.params` is untyped there (`:100`; `BunWebSocket.ts:119`,
  `params?: ParamsDictionary`).
- **`router.ws()`** takes a middleware chain since #536 (`BunRouter.ts:1918-1975`):
  `TPath` types the **middleware's** `req.params`, not the socket handler's.
- **AsyncAPI 3.0** (AD (e), #539, 2026-10-26): `generateAsyncApi()`
  (`docs/asyncapi.ts:279`) documents channels, their upgrade side, replies as
  `operation.reply` (`:757-775`), the envelope with its id field (`:608-651`),
  and `x-bun-common-subprotocol`, `-binary`, `-topics`, `-sse-fallback`
  (`:791-800`). `docsRouter()` serves it (`docs/router.ts:190`).
- **bun-nest gateways** (BV V9, #526): `@ValidateMessage(schema, { ack })`
  checks a payload and the returned ack (`bun-nest/lib/wsValidation.ts:376-390`),
  `@Emits` checks declared emits (`:236`), `TypedSocket` types
  `@ConnectedSocket()` (`:94`); `gatewayAsyncApi()` documents gateways
  (`bun-nest/lib/gateway-docs.ts:195`). The adapter's acks are client →
  server only: a handler's return becomes `ACK [value]` (`BunWebSocketAdapter.ts:1434-1440`);
  there is no server → client emit-with-ack.
- **bun-jobs' socket** is its own protocol: inbound frames checked
  (`bun-jobs/lib/api/ws/session.ts:168-190`, `:461`), **outbound frames not**
  (`:1551`), resume by `{ epoch, afterSeq }` with a replay ring and a `gap`
  frame (`ws/hub.ts:131-162`, `:435`). It does not use `defineChannel`.
- **bun-jobs-ui's live client** casts every frame unchecked
  (`bun-jobs-ui/app/live/client.ts:983`) and is the tuned reconnect
  reference (`:366-384`, `:618-664`, `:1018-1041`).

---

## 3. Where the types come from

### 3.1 Two sources, one client type [D]

| Layout | Source | What the client imports |
|---|---|---|
| **Monorepo** (default when the contract module is browser-safe) | the shared `channelContract()` module: `export const chat = channelContract({ path, receives, sends, replies })` | `channel(api, chat, { params })`, typed by `typeof chat.spec` |
| **Separate repo**, or any AsyncAPI 3.0 server | `bun-client generate` reads the AsyncAPI document and writes a `Channels` map (and generated Zod, TC §5.2) | `channel(api, "/rooms/:room", { params })`, typed by `Channels["/rooms/:room"]` |

The spec module must import nothing of the server: BV's m12 split exists for
exactly this (`contract/channel.ts:1-9`). Today a server declares
`defineChannel({ … })` inline, which builds the contract inside a server
module; §10.2 adds `defineChannel(chat)` taking a prebuilt contract, so the
spec lives in a shared module and the binding in the server.

### 3.2 What the inference costs [M]

`evidence/transports/ws-typing/`: N channels, each with 8 client → server
and 8 server → client messages, every message its own zod object schema (3 to
6 fields: strings, numbers, enums, arrays, a coercion, an optional, a nested
object), 2 declared replies; modules of 10; each client module calls every
message once (`send`, `request`, `on`) and carries `@ts-expect-error`
negative controls (an unknown type, missing data, a request on a type with no
reply, a wrong field type). TypeScript 6.0.3 `--extendedDiagnostics` and a
bare `bun --check` (TypeScript 7), median of 3, through the heavy-run wrapper:

| Channels | declare only (tsc s / MB) | **inferred client** (tsc s / MB) | **generated map** (tsc s / MB) | `bun --check` ms: declare / infer / generated |
|---|---|---|---|---|
| 10 | 0.67 / 123 | 0.87 / 177 | 0.42 / 90 | 80 / 88 / 39 |
| 50 | 1.03 / 218 | 2.13 / 327 | 0.62 / 151 | 68 / 134 / 49 |
| 200 | 3.92 / 456 | **6.61 / 1,022** | **1.25 / 230** | 121 / 324 / 60 |

- Inference costs about +70% over declaring the schemas at 200 channels
  (3.0 M instantiations against 0.84 M) and doubles the memory; a generated
  map is cheaper than declaring the schemas at all, as for HTTP (TC §3.2).
- **Under `bun --check`, which is the repo's checker, all of it is under a
  third of a second.** The tsc column is what a consumer on tsc 6 pays.
- Negative control: a wrong field type planted in `out/infer-200/client7.ts`
  fails `bun --check` with TS2322 ("Found 1 error in 1 file, checked 53
  files"); restored, clean [M].

So inference is fine for monorepos of ordinary size, and generation is the
default for separate repos and very large apps, the same rule as HTTP (TC
D3).

### 3.3 The direction rule [D]

The client **sends what the server receives** and **receives what the server
sends**, so the client's types flip the contract's sides:

| Client action | Contract side | Type |
|---|---|---|
| `send`, `request` | `inbound` (`receives`) | `WireInput<S>` (each field's input, or its output where the input is `unknown`; BV §4.1.4, `contract/model.ts:443`) [S] |
| `on`, `messages()`, a `request`'s reply | `outbound` (`sends`) | `Jsonify<WireInput<S>>`: the wire side, after JSON (BV §4.12 M2, approved 2026-10-17) |

The spike's `ChannelClient<S>` (`ws-typing/client-types.ts`) is this rule
written out in 60 lines; the package's version reuses the contract core's
`Sent`/`Received` types rather than restating them.

---

## 4. The client API

### 4.1 Opening a channel [D]

```ts
import { createClient } from "@kingsleyweb/bun-client";
import { channel } from "@kingsleyweb/bun-client/channel";
import { chat } from "../shared/chat.contract";          // channelContract({...}), browser-safe

const api = createClient<Routes>({ baseUrl: "/api" });
const room = channel(api, chat, { params: { room: "lobby" }, query: { name: "ada" } });

room.send("say", { text: "hi" });                          // typed by chat.spec.receives.say
const said = await room.request("say", { text: "hi" });    // typed by sends[replies.say]
const off = room.on("said", (m) => console.log(m.by, m.text));
for await (const m of room.messages("someoneTyping")) …     // async iterator, ends on close()
room.close();
```

- **The URL** is built like an HTTP call's (`baseUrl`, params substituted and
  encoded, query serialised with TC §6.1's serialiser), with `http` → `ws`.
- **The upgrade's request side** (`request: { params, query, headers }`) types
  the open call's options. Headers cannot be set on a browser `WebSocket`
  [V]: a token goes in the query or a subprotocol (TC §3.3's
  `token.<t>` convention), and the type says so by omitting `headers` in the
  browser build [D].
- **One socket per channel instance**; a second `channel()` with the same
  URL shares it (refcounted), as the live client's subscriptions are [D].
- **State** is observable: `room.state` (`"connecting" | "open" |
  "reconnecting" | "closed"`), `room.on("$state", fn)`; the `$` prefix keeps
  client events apart from message types, which may not start with `$`
  (checked when the contract is read) [D].

### 4.2 Request/response [D]

- `request(type, data, { timeout })` is offered only for a `type` the
  contract's `replies` maps (a type error otherwise, a control in the spike).
- The client stamps `envelope.idField` (default `"id"`) with a counter per
  socket, keeps a pending table, and resolves when a frame of the reply type
  arrives **with the same id**; an error frame with that id rejects with a
  `ChannelError` (§6). Frames without an id are ordinary pushes.
- **Timeout** default 30 s (TC's request default); a reconnect rejects every
  pending request with `DisconnectedError` rather than resending, because a
  request may not be idempotent. `retry: true` per call opts in.
- Server side, §10.1 makes the reply echo the id.

### 4.3 Server push and subscriptions [D]

- **Push** is `on(type, fn)` / `messages(type?)`. A frame of a declared type
  without an id, or with an id the client did not send, is a push.
- **Subscriptions** are not a built-in protocol: bun-common's channels have
  topics (Bun's pub/sub, `meta.topics`), but which topics a socket joins is
  the app's decision (`ws.subscribe` in the open handler or a `subscribe`
  message). The client offers one hook: `resubscribe(room)`, run after every
  reconnect, where the app re-sends its own `subscribe` messages (§7). The
  live channel (§9) is a worked example with a declared `subscribe` message.

---

## 5. Validation, both directions

[D], reusing TC §5's rules unchanged:

| Direction | Built-in | BYO | Default (development / production) | Failure does |
|---|---|---|---|---|
| **Send** (`send`, `request`) | the contract's sender guard over `inbound` (`createSender`), with the shared contract's own schemas or the generated Zod | a Standard Schema per message type, after the built-in one, `replace: true` to drop it (TC §5.4) | on / off | **throws** `ValidationError` before anything is written (direction `"send"`, the message `type` as the key) |
| **Receive** (pushes, replies) | the receiver guard over `outbound` (`createReceiver`) | the same | on / off | **warns and delivers** the frame as received by default; `onFailure.receive: "drop"` drops it and emits `$invalid`; `"throw"` rejects a pending request |

- **The error frame is always checked**, with its fixed shape, in every
  mode: it is the one frame the client acts on (§6) [D].
- **The guards are the contract core's**, imported from the shared contract
  package (TC D20), so the client and the server cannot disagree on what
  "valid" means, including BV's value-free issue scrubbing and
  prototype-key stripping (`contract/model.ts:330-383`) [S].
- **Measured on a data channel** with the same envelope and guards: 1,000
  checked JSON messages in 13–20 ms between two native peers, the invalid and
  the undeclared message each refused with their issues [M,
  `webrtc/results.txt`], so the check is not the bottleneck of a socket.
- **Binary frames**: a channel with `binary: true` carries the same JSON
  envelope in a binary frame (`contract/channel.ts:64-65`) [S]; the client
  sends text unless told otherwise. Raw binary payloads (not an envelope) are
  `webrtc.md` §5's case, and out of scope for channels until a server
  declares them.

---

## 6. Errors

[D]. All extend TC's `ClientError`:

| Error | When | Carries |
|---|---|---|
| `ChannelError` | an error frame arrives (`VALIDATION`, `UNKNOWN_MESSAGE`, `UNSUPPORTED_DATA`; `EXCEPTION` from the `"bun-nest"` codec, below); for a request, its id matches | `code` (that union), `status`, `issues`, `detail`, the request's `type` when known |
| `ValidationError` | a send fails the sender guard; a received frame fails under `"throw"` | TC §5.4's shape, with `direction: "send" \| "receive"` and `target: "data"` |
| `RequestTimeoutError` | no reply within `timeout` | `type`, `id`, the timeout |
| `DisconnectedError` | the socket dropped with requests pending | the close code and reason |
| `ChannelClosedError` | a send or request after `close()`, or a close the client will not retry (1007 from `closeOnInvalid`, 1008, 4000-range app codes listed in `fatalCloseCodes`) | the close code and reason |

Error frames without an id that match nothing pending are delivered to
`on("$error")` and, by default, logged.

**`"bun-nest"` and a failed acked event.** bun-nest's `exception` frame
carries `ackId`, the id of the event that failed, when it asked for an ack (a
`request()`): `ValidationExceptionFilter`'s frame and any `BaseWsExceptionFilter`
`catch` (a `WsException`, a thrown error, a guard's refusal). The codec
rejects the request with that id at once: a `ChannelError` with the frame's
`code` for the validation frame, `"EXCEPTION"` (`status` the frame's when a
number, else 500; `detail` its `message`) for the others, and emits no
`$error` for it (as for any error frame a request waits for). A frame with
no `ackId` (an older server, an event sent without an id) is as before: the
request times out. An `ackId` no request waits for is a push (a
`WsException` frame) or a `$error` (a `VALIDATION` one), as before.

---

## 7. Reconnection, subscriptions and resume

[D], with bun-jobs-ui's tuned values as defaults [S, `app/live/client.ts:366-384`]:

| Behaviour | Default | Option |
|---|---|---|
| Reconnect | exponential, half-jittered, 500 ms doubling to 30 s; reset after the socket stays open 60 s | `reconnect: { initialMs, maxMs, stableAfterMs } \| false` |
| Fatal close codes (no retry) | 1007, 1008, 4400–4499 | `fatalCloseCodes` |
| Heartbeat watchdog | none by default (a bun-common channel sends no heartbeat); when the contract declares a heartbeat type, 2 × its interval + 5 s of silence closes and reconnects with code 4000 | `heartbeat: { type, intervalMs, slackMs }` |
| Ping | none; when declared, a `ping` every `intervalMs` while idle | `ping: { type, intervalMs }` |
| Outbound while disconnected | buffered, at most 100 messages, flushed in order on open; over the limit, `send` throws `ChannelClosedError` | `offline: { buffer: number } \| "fail"` |
| Resubscribe | the app's `resubscribe(room)` runs after every (re)open, before the buffer flushes | `resubscribe` |
| Resume | none built in; the app's `resubscribe` sends whatever cursor it kept (`{ epoch, afterSeq }` for bun-jobs), and a declared `gap` message tells the app it missed events | — |
| Refcounting | the socket closes when the last `channel()` handle closes | — |

The reasons are bun-jobs-ui's: its client found the half-jitter, the
stable-after reset and the policy-close cap by running against a real server
for weeks (`app/live/client.ts:118-143`) [S]. A gap after a reconnect makes
the live layer invalidate every active query (TC D15, §9).

---

## 8. Backpressure

- **Client.** A browser `WebSocket` queues without limit and has no drain
  event; only `bufferedAmount` says how much is queued [V, MDN].
  `WebSocketStream`, which has real backpressure, is Chromium-only [V]. So:
  `room.bufferedAmount`, and `await room.sendWhenReady(type, data, {
  highWaterMark })` (default 1 MiB), which polls `bufferedAmount` every
  animation frame (every 16 ms outside a browser) until it is under the mark
  [D]. `send` stays synchronous and never waits.
- **Server.** Bun's `ws.send()` returns `-1` when backpressure was applied,
  `0` when the message was dropped, else the bytes sent; `drain(ws)` fires
  when it clears; `backpressureLimit` and `closeOnBackpressureLimit` bound it
  (`node_modules/bun-types/serve.d.ts:1-40`, `:434-491`) [V]. `defineChannel`'s
  send queues the write behind the socket's frames and drops the status
  (`channel.ts:336-358`) [S]. §10.4 returns it.

---

## 9. Live invalidation is a channel

TC D15's live queries (push invalidations, not data) become one
`defineChannel` contract that bun-common ships, instead of the old PR-M3's
bespoke frames [D]:

```ts
// bun-common, browser-safe half
export const liveContract = channelContract({
  path: "/__live",
  receives: { subscribe: Tags, unsubscribe: Tags, resume: Cursor },
  sends: { invalidate: Invalidate /* { tags, seq, epoch } */, gap: Gap, hello: Hello },
  replies: { subscribe: "hello", resume: "hello" },
});
// server
app.use(liveInvalidation({ authorize, source: cache }));   // mounts defineChannel(liveContract) and its SSE fallback
publishTags(["user:42"]);
```

- **Server** (bun-common `./live`): refcounted tag topics on Bun's pub/sub;
  a ring of recent `{ seq, tags }` per process for resume (bun-jobs' hub is
  the model, `ws/hub.ts:131-162`); a `gap` when the epoch changed or the
  cursor fell off the ring. Sources: `publishTags()`, a route's
  `cache.invalidates` on success (TC §8.1), and bun-cache's tag
  invalidations when a cache is passed. bun-cache has no tag-invalidation
  event today (`bun-cache/lib/core/types.ts:709` lists the events) [S]; the
  PR adds one, or subscribes to the cache's bus [I].
- **Client** (`./live`): subscribes to the tags of the observed queries
  (refcounted), invalidates by tag (TC §6.4), and on a `gap` or an epoch
  change invalidates every active query. Its SSE fallback is `sse.md`'s
  client over the channel's `fallback` endpoint.
- It is authenticated by the app's `authorize`, like bun-jobs' API
  (`bun-jobs/lib/api/config.ts:543`) [S].

---

## 10. Server pieces this needs

All in bun-common, each small [D]:

1. **Replies echo the id.** A handler may return the reply's data for a type
   that `replies` maps; it is sent as the reply type with the request's id,
   checked under the `out` policy. `send(ws, type, data, { id })` for a reply
   sent later. Without this the AsyncAPI document describes behaviour the
   runtime lacks (`docs/asyncapi.ts:617`) [S]. Type: a handler for a replied
   type is typed to return the reply's wire input (or `void` to answer later).
2. **`defineChannel(contract)`** accepts a `channelContract()` result, so the
   spec lives in a shared module (§3.1); the inline form stays.
3. **Typed socket params**: a channel handler's `ws` is typed with
   `params` from the channel's path literal (the same `ResolveParams` the
   verbs use) and the upgrade's parsed `request` parts.
4. **Send status**: `send` and `publish` return the `ws.send` status once the
   write runs, as a promise (`Promise<number>`), since the write is queued
   behind the frame chain; and a `server`-level `publish(topic, type, data)`
   through the adapter's server (Bun's `server.publish`), so a route handler
   can push without holding a socket.
5. **bun-jobs** checks its outbound frames under a policy (`session.ts:1551`),
   to match `defineChannel`'s `out` side. Moving bun-jobs onto
   `defineChannel` is not proposed (its protocol predates it and has
   consumers); a `"bun-jobs"` codec covers its envelope (§11).

---

## 11. Nest gateways

- **Types.** A Nest gateway's message schemas live in decorators
  (`@ValidateMessage`, `@Emits`), which the type system cannot read off the
  class (BV V9's note: `TypedSocket` takes the `as const` map, not the class)
  [S]. So a Nest client's types come from **generation** over
  `gatewayAsyncApi()`'s document, or, in a monorepo, from the same shared
  `as const` maps the gateway passes to its decorators: NTR §7 now says to put
  them in a shared module, as §3.1 does for channels.
- **Envelope.** bun-nest speaks socket.io-style packets: EVENT `[name,
  ...args]`, ACK with the packet id, BINARY_EVENT with base64 parts
  (`BunWebSocketAdapter.ts:242`, `:1547-1605`) [S]. The client's
  `"bun-nest"` codec maps `send(type, data)` to EVENT `[type, data]` and
  `request(type, data)` to EVENT with an id answered by ACK, which is exactly
  Nest's ack (`@Ack()` or the handler's return, `:1434-1440`) [S]. The ack's
  type is `@ValidateMessage`'s `ack` schema, which the AsyncAPI document
  carries as the operation's reply (`bun-nest/lib/gateway-docs.ts:478-517`)
  [S]; PR-W3 checks the generated type against a live ack.
- **Server → client acks** (`emitWithAck`) do not exist in the adapter
  [S]; not proposed.
- **What NTR's PR-N5 becomes**: built, as V9. What is left is the codec and
  the shared-map convention (§13).

---

## 12. Tests

[D], each with a negative control:

- **Types** (`websocket.type-test.ts`): the spike's controls as the base
  (unknown type, missing data, `request` on an unreplied type, wrong field
  type), plus `Jsonify` on a received `Date`, a `null` message taking no
  data, and the generated map and the inferred client agreeing (`Equal`)
  for the same contract.
- **Runtime, against a real `defineChannel` server on port 0**: send and
  receive, both checked; a planted invalid server frame warned and delivered,
  dropped under `"drop"`; a request resolved by its id while an unrelated
  push of the same type arrives first (the control: a client matching by
  type alone resolves with the wrong frame); a timeout; a reconnect rejecting
  pending requests and re-running `resubscribe`; a fatal close code not
  retried; the offline buffer's order and limit; `sendWhenReady` waiting on
  a large `bufferedAmount`.
- **Server pieces**: the reply echoes the id (control: today's binding does
  not); `defineChannel(contract)` equals the inline form's AsyncAPI;
  `send`'s status is `-1` under a forced backpressure limit.
- **Nest**: the `"bun-nest"` codec against a gateway with
  `@ValidateMessage(…, { ack })`, on Nest 11 and 12 (the matrix, CLAUDE.md).
- `bun test --randomize` with two seeds, as every TC PR.

---

## 13. PRs, questions and names

### 13.1 PRs

| PR | What | Depends on | Effort |
|---|---|---|---|
| **PR-W1** server pieces (bun-common) | §10.1–10.4: echoed replies, `defineChannel(contract)`, typed socket params, send status, server-level publish | — | ~3 d |
| **PR-W2** channel client (bun-client) | `channel()` from `./channel`, codecs (`bun-common`, custom), send/request/on/messages, both-direction validation, errors, reconnect, offline buffer, `sendWhenReady`; AsyncAPI → `Channels` in the generator | TC PR-C1, PR-C2 (the generator), PR-K (the guards), PR-W1 | ~5 d |
| **PR-W3** Nest codec | the `"bun-nest"` codec and acks; NTR §7's shared-map convention; the matrix | PR-W2 | ~1.5 d |
| **PR-W4** live invalidation | `liveContract`, `liveInvalidation()`, `publishTags()`, bun-cache source; the client's `./live` over a channel (and over SSE, `sse.md`) | PR-W1, PR-W2, TC PR-C5 | ~4 d (replaces TC's old PR-M3 + PR-C7, ~7.5 d) |
| *later* | a `"bun-jobs"` codec, if the bun-jobs-ui pilot moves its live client | the pilot | ~1 d |

### 13.2 Questions

TC §14 Q19–Q21, **answered 2026-11-02: approved as recommended.**

### 13.3 Names (approved 2026-11-02)

| Name | Kind | Where |
|---|---|---|
| `channel`, `ChannelClient`, `ChannelOptions` | function, types | bun-client `./channel` |
| `send`, `request`, `on`, `messages`, `close`, `state`, `bufferedAmount`, `sendWhenReady`, `$state`, `$error`, `$invalid` | members, events | `ChannelClient` |
| `reconnect` (`initialMs`, `maxMs`, `stableAfterMs`), `fatalCloseCodes`, `heartbeat`, `ping`, `offline`, `resubscribe`, `codec` | options | `ChannelOptions` |
| `ChannelError`, `RequestTimeoutError`, `DisconnectedError`, `ChannelClosedError` | classes | bun-client `.` |
| `"bun-common"`, `"bun-nest"` | codec names | `ChannelOptions.codec` |
| `defineChannel(contract)` | overload | bun-common root |
| `send(…, { id })`, `send`/`publish` returning `Promise<number>` | signature changes | bun-common `Channel` |
| `liveContract`, `liveInvalidation`, `publishTags` | constant, functions | bun-common `./live` (new entry) |
| `live` | function | bun-client `./live` |
