# What Bun can do natively, per network transport

This file is evidence for the Phase 2 remote-execution design. In that design a
worker holds the lease and pushes a job attempt to a remote executor. The
executor sends back progress, logs, heartbeats and the result. The dependency
policy rules out npm transport libraries in a published package, so what Bun
provides natively sets the limit on what bun-jobs can ship first-party. This
file records what Bun provides, **as measured on one machine on 2026-09-25**.

## Provenance

| Mark | Meaning |
|---|---|
| **[M]** | Measured here by a spike that can be re-run. The spike file is named in the row. |
| **[V]** | Read on 2026-09-25 from a primary source (Bun docs, Bun blog, bun-types, Node docs, GitHub). The URL or path is given. |
| **[U]** | Unverified. This covers inferences and claims that need a real network. |

**Environment.** The installed runtime is `bun --revision` →
**`1.4.3-canary.1+5f554969b`**. `bun --version` prints only `1.4.3`, but this
is a canary build and not a release. The newest release on the blog is v1.4.2
(2026-09-05). Other details: Linux 7.0.0-31-generic x86_64, and `lo` MTU 65536.
`net.core.rmem_default` is 212992 and `rmem_max` is 4194304. The bundled docs
come from `node_modules/bun-types` **1.4.2** in the main checkout. All
measurements ran on **loopback only**. A loopback link has no real loss, no
reordering, no path-MTU limit, no NAT and no middleboxes. Any row that depends
on those is marked [U] and says it needs a real network.

**Re-running.** The spikes are in
`/tmp/claude-1000/-home-kingsloob1-Desktop-projects-mine-bun-node/ae3600c2-7626-4de2-ab39-b5ca45258d5b/scratchpad/transports/`,
and that directory is below referred to as `$T`. It is a session scratchpad
outside the repo, so it will not survive forever. To keep the spikes, copy them
under this directory. Each spike is one self-contained `bun <file>.ts`. It binds
port 0, prints `RESULT …` lines and exits on its own. The TLS, HTTP/2, HTTP/3
and QUIC spikes need a self-signed pair next to them:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

## Verdict per transport

| Transport | Bun 1.4.3 status | First-party without npm? | The gotcha that matters most |
|---|---|---|---|
| HTTP/1.1 (`Bun.serve` + `fetch`) | **Native, stable** | Yes | A streamed response sends **no complete header block until the first body chunk**. `fetch()` does not resolve until then. The idle timers are coarse, in 4-second ticks. |
| SSE | **Server native; no client** (`EventSource` is `undefined` at runtime even though bun-types declares it) | Yes. The parser (~40 lines) and the reconnect logic are ours to write. | The server's `idleTimeout` kills a quiet stream unless `server.timeout(req, 0)` is set. The headers do not reach the client until the first event is written. |
| WebSocket | **Native, stable** | Yes | Server `send()` returns **`0` = silently dropped** once `backpressureLimit` is reached. The client's `bufferedAmount` is **unbounded**. |
| TCP (+TLS, Unix sockets) | **Native, stable** | Yes. We write the framing ourselves. | `write()` is **unbuffered**: it returns a partial count and the rest is gone unless the caller keeps it. Several documented behaviours are wrong: `shutdown(true)`, `end()`, `socket.timeout()`, custom ALPN. |
| UDP | **Native** (`Bun.udpSocket`) | Yes, as datagrams. No DTLS. | There is no flow control. A sender on the same box lost **99.5%** of a burst in the receive buffer. ICMP errors reach the `error` handler with an **`undefined`** argument. |
| HTTP/2 | **Server experimental** (`Bun.serve({ http2 })`). **Client experimental** (`fetch({ protocol: "http2" })`). `node:http2` is complete, with trailers. | Yes | `Bun.serve` cannot send **trailers** and cannot upgrade to WebSocket over h2. Default `fetch` does **not** use h2 unless it is asked to. |
| gRPC | **Absent** as an API. Feasible over `node:http2`, which carries trailers. | Only as a hand-written framing and codec on `node:http2` | `Bun.serve` cannot host it because it has no trailers. We would have to hand-roll protobuf. |
| HTTP/3 | **Experimental**, server and client | Not yet. The blog says not to ship it. | The client refuses a per-request `tls.ca` or `serverName` (`HTTP3Unsupported`). It trusts only the process-wide store or `rejectUnauthorized: false`. |
| Raw QUIC (`node:quic`) | **Experimental**: Node stability 1.0, and Bun emits `ExperimentalWarning` | Technically yes | Streams and datagrams work. The API is "early development" in Node itself and will move. |
| WebTransport / WebSocketStream | **Absent** | No | Not present at all. |

## Cross-cutting findings

These patterns show up in more than one transport. A protocol implementer
should know them before reading the sections below.

1. **The idle timers have 4-second granularity [M].**
   - `Bun.serve` `idleTimeout` N cut a silent stream at the next multiple of 4 s. Values 1–4 cut at 4.0 s, 5–8 at 8.0 s, and 10 at 12.0 s (`$T/http-idle-granularity.ts`).
   - A raw socket's `socket.timeout(n)` fired between n and n+4 s: 1→4.0 s, 2→2.0 s, 5→7.0 s (`$T/tcp-timeout.ts`).
   - `fetch`'s per-request `timeout` (ms) had a floor of about 8 s. Values 100/1000/3000 fired at 8.0 s, 5000/7000 at 12.0 s and 9000 at 16.0 s (`$T/http-client-timeout2.ts`).
   - Consequence: none of these can serve as a sub-4-second heartbeat deadline. Use an application timer, `AbortSignal.timeout()` (measured exact at 201 ms), or `setTimeout`.
2. **Sends that fail are silent unless the caller checks the return value [M].**
   - TCP `write()` returns a short count. WebSocket server `send()` returns `0`. UDP `send()` returns `true` even when the kernel later drops the datagram.
   - A TLS `write()` in `open()` before the handshake returns `0`.
   - None of these throw.
3. **Documentation and behaviour disagree in five places [M vs V].** These are listed under TCP and TLS below. Assert the behaviour in our own tests rather than relying on the docs.
4. **The build is a canary [M].** Every row here describes `1.4.3-canary.1+5f554969b`. Re-run the spikes on the release this ships against.

## 1. HTTP/1.1: `Bun.serve` + `fetch`

API: `Bun.serve({ fetch, idleTimeout, maxRequestBodySize, … })`, `server.timeout(req, s)` and `server.requestIP(req)`. On the client side: `fetch(url, { body: ReadableStream, duplex: "half", signal, keepalive, timeout, unix })`.

| # | Claim | Mark | Evidence |
|---|---|---|---|
| 1.1 | A streamed request body reaches the server incrementally. Chunks sent 250 ms apart arrived at 46/251/501/751 ms. | [M] | `$T/http.ts` A |
| 1.2 | **Full duplex works over one Bun→Bun HTTP/1.1 fetch.** The server echoed each chunk while the request body was still open, in a 3-message ping-pong. This is Bun-to-Bun on loopback. Proxies and load balancers that buffer request bodies would break it. | [M] / [U] through proxies | `$T/http.ts` B, `$T/http-extra.ts` |
| 1.3 | The client reads a streamed response incrementally. Chunks written 200 ms apart were read at 0/200/401/601/802 ms. | [M] | `$T/http.ts` C |
| 1.4 | **Header flush: the server sends `HTTP/1.1 200 OK` and `Content-Type`, then holds back `Date`, the framing header and the blank line until the first body chunk.** `fetch()` therefore resolved at 501 ms for a stream whose first chunk came at 500 ms. This held for no content type, `text/event-stream`, `application/octet-stream` and `application/x-ndjson`, and for a `type: "direct"` stream with `flush()`. Against a raw server that sends its headers at once, Bun's `fetch` resolved at 0 ms, so the delay is on Bun's server side. **Write a first chunk immediately** (for example an SSE comment) to "open" a stream. | [M] | `$T/http-extra.ts`, `$T/http-header-flush.ts`, `$T/http-header-flush2.ts`, `$T/http-header-flush3.ts` |
| 1.5 | A stream that closes after one chunk was sent with `Content-Length: 1` rather than chunked encoding, so Bun picks the framing only when it has to. | [M] | `$T/http-header-flush3.ts` |
| 1.6 | A client abort reaches the server. `req.signal` fired both before headers and mid-body. `AbortSignal.timeout(200)` gave a `TimeoutError` at 201 ms. | [M] | `$T/http.ts` D |
| 1.7 | `idleTimeout` resets the connection mid-response ("socket connection was closed unexpectedly") when the stream is silent, and also when the handler has not produced headers. `server.timeout(req, 0)` exempted one request, which survived 4.5 s under `idleTimeout: 3`. The maximum is 255; 256 throws; 0 disables. | [M], [V] `bun.com/docs/runtime/http/server` | `$T/http.ts` E, `$T/http-extra.ts` |
| 1.8 | Keep-alive: 5 sequential fetches used one client port. With `keepalive: false` each fetch used its own port. | [M] | `$T/http.ts` F |
| 1.9 | Backpressure propagates in both directions. A server stream on a client that stopped reading was pulled only 5 × 1 MiB in 1.5 s, out of 256 available. An upload to a server that was not reading was pulled 6–7 MiB. | [M] | `$T/http-backpressure.ts` |
| 1.10 | **`maxRequestBodySize` (default 128 MiB) caps the *total* of a streamed upload.** A 256 MiB duplex body produced `413` at the client. At the server, `for await (req.body)` threw "Request body exceeded maxRequestBodySize". This applies equally to a long-lived request stream carrying progress. `maxRequestBodySize: Infinity` lifted the cap (300 MiB read). Over the limit the result was an error and not silent truncation. | [M] | `$T/http-backpressure.ts`, `$T/http-bodylimit.ts`, `$T/http-extra.ts` |
| 1.11 | `fetch({ timeout })` is a per-request **idle** timer (default 5 min via `BUN_CONFIG_HTTP_IDLE_TIMEOUT`). It is not a deadline, and its granularity is coarse (see cross-cutting item 1). | [V] `bun-types/globals.d.ts` `BunFetchRequestInit.timeout`; [M] granularity | `$T/http-client-timeout.ts`, `$T/http-client-timeout2.ts` |
| 1.12 | `fetch` allows at most 256 simultaneous requests and queues the rest (`BUN_CONFIG_MAX_HTTP_REQUESTS`, maximum 65,535). | [V] `bun-types/docs/runtime/networking/fetch.mdx` | — |
| 1.13 | HTTP over a Unix socket works: `Bun.serve({ unix })` with `fetch(url, { unix })`. | [M] | `$T/tcp.ts` 5 |

## 2. SSE (server-sent events)

| # | Claim | Mark | Evidence |
|---|---|---|---|
| 2.1 | **There is no `EventSource` at runtime.** `typeof EventSource === "undefined"`, and `new EventSource()` throws `TypeError: undefined is not a constructor`. **bun-types declares a global `EventSource` anyway**, so the code typechecks and then fails at runtime. | [M]; [V] `bun-types/globals.d.ts:1732` | `$T/sse.ts` 1 |
| 2.2 | The upstream request is open: "Implement EventSource", oven-sh/bun#8474, state OPEN (checked with `gh`, 2026-09-25). | [V] https://github.com/oven-sh/bun/issues/8474 | — |
| 2.3 | Serving SSE is a `Response` over a `ReadableStream` or async generator with `content-type: text/event-stream`. Bun's own guide calls `server.timeout(req, 0)`. | [V] `bun-types/docs/guides/http/sse.mdx` | — |
| 2.4 | A hand-written parser over `fetch` + `TextDecoderStream` handled everything tested: multi-line `data`, `event`, `id`, `retry`, and an event split across two writes 100 ms apart. It reconnected and sent `Last-Event-ID` (the server saw `[null, "3"]`) and honoured `retry: 300`. **Reconnect and `Last-Event-ID` are entirely our code**, because no native client exists. | [M] | `$T/sse.ts` 2 |
| 2.5 | When the client aborts, the server stream's `cancel()` is called (count 1). | [M] | `$T/sse.ts` 2 |
| 2.6 | Without `server.timeout(req, 0)` a quiet SSE stream is cut according to the idle-timer rule (§1.7). With `idleTimeout: 2` a 3 s gap survived, because the cut rounds up to 4 s. | [M] | `$T/sse.ts` 3, `$T/http-idle-granularity.ts` |
| 2.7 | The header-flush rule (§1.4) applies. The client cannot tell the stream opened until the first event or comment arrives. | [M] | `$T/http-header-flush2.ts` |

## 3. WebSocket

API: the `Bun.serve({ websocket: { open, message, drain, ping, pong, close, maxPayloadLength, backpressureLimit, closeOnBackpressureLimit, idleTimeout, sendPings, perMessageDeflate } })` handler, `server.upgrade()`, and `ServerWebSocket.send/sendText/sendBinary/ping/pong/close/terminate/getBufferedAmount/cork`. On the client: global `WebSocket(url, { headers, tls, perMessageDeflate, protocols, proxy })` plus the non-standard `ping()`, `pong()`, `terminate()`, `pause()`, `resume()` and `isPaused`.

| # | Claim | Mark | Evidence |
|---|---|---|---|
| 3.1 | Text and binary frames round-trip. **The client's default `binaryType` delivers a Node `Buffer`**, not the spec's `Blob`. `"arraybuffer"` gives an `ArrayBuffer`. | [M] | `$T/ws.ts` 1 |
| 3.2 | `perMessageDeflate: true` on the server negotiated `permessage-deflate; server_no_context_takeover; client_no_context_takeover`. | [M] | `$T/ws.ts` 1 |
| 3.3 | **Ping/pong can be both sent and observed on both sides.** The client's `ping("x")` reached the server's `ping` handler. The server's `ws.ping()` was answered automatically by the client. The client receives `"ping"` and `"pong"` events whose data is an `ArrayBuffer`. These events are **not in bun-types' `WebSocketEventMap`** (untyped). | [M]; [V] `bun-types/bun.d.ts` `WebSocketEventMap` | `$T/ws.ts` 1 |
| 3.4 | The client's `send()` returns `undefined`. There is no client-side send status. | [M] | `$T/ws.ts` 1 |
| 3.5 | **A frame over `maxPayloadLength` closes with code `1006`**, not `1009`. The server's reason was "Received too big message, or other inflation error"; the client got 1006 "Connection ended". | [M] | `$T/ws.ts` 2 |
| 3.6 | **Server backpressure uses three return values.** Twelve 1 MiB `sendBinary` calls into a paused client, with `backpressureLimit` 4 MiB, returned `1048576` ×3 (sent), then `-1` ×5 (queued, buffer 0.8→4.8 MiB), then **`0` ×4 (dropped)**. After resume the client got **8 of 12** messages. `drain` fired three times as the buffer emptied. | [M] | `$T/ws.ts` 3 |
| 3.7 | With `closeOnBackpressureLimit: true` the server closed with `1006` once the limit was hit. A **paused client does not see that close until it resumes**. | [M] | `$T/ws.ts` 3b |
| 3.8 | **Client-side buffering is unbounded.** Sixty-four 1 MiB `send()` calls to a server whose event loop was blocked left `bufferedAmount` at 60.8 MiB, with no error and no limit. | [M] | `$T/ws.ts` 4 |
| 3.9 | Close codes arrive intact: server `close(4401, "lease lost")` gave the client `code=4401 reason="lease lost" wasClean=true`. After a client `terminate()` the server saw `1006`. A client `close(1006)` throws `InvalidAccessError`. | [M] | `$T/ws.ts` 5 |
| 3.10 | There is no automatic reconnection. After a server close, `readyState` is 3 and the server saw only one `open`. | [M] | `$T/ws.ts` 6 |
| 3.11 | With the default `sendPings`, a silent client that answers pings survived 20 s under `idleTimeout: 8`; the server logged 4 pongs. A **paused** client, which cannot answer, was closed by the server with 1006 "WebSocket timed out from inactivity". The paused client still showed the socket as open after 20 s: **the client has no liveness check of its own.** | [M] | `$T/ws.ts` 7, 7b |
| 3.12 | `wss://` with a pinned `tls.ca` and custom `headers` (such as `Authorization`) works. With default verification a self-signed server fails "TLS handshake failed". The upgrade also works on a `Bun.serve({ http2: true })` server (the client uses HTTP/1.1). | [M] | `$T/other.ts` |
| 3.13 | `ws+unix:///path` connects to `Bun.serve({ unix })`. | [M] | `$T/other.ts` |
| 3.14 | WebSockets over HTTP/2 are not supported. `server.upgrade()` works on HTTP/1.1 only and **returns `false` over HTTP/3**. | [V] `bun.com/docs/runtime/http/server`; https://bun.com/blog/bun-v1.4 | — |
| 3.15 | The client's `pause()`/`resume()` arrived in v1.4.1 (2026-09-04). | [V] https://bun.com/blog/bun-v1.4.1 | — |

## 4. TCP: `Bun.listen` / `Bun.connect` (+ TLS, Unix sockets)

API: `Bun.listen({ hostname, port | unix, tls, allowHalfOpen, socket: { open, data, drain, end, close, error, timeout, handshake } })` and `Bun.connect({ … connectError })`. The `Socket` methods used here are `write`, `end`, `shutdown`, `terminate`, `pause`, `resume`, `timeout`, `setKeepAlive`, `setNoDelay`, `flush` and `getTLSVersion`/`getPeerCertificate`/`alpnProtocol`/`authorized`.

| # | Claim | Mark | Evidence |
|---|---|---|---|
| 4.1 | **There are no message boundaries.** One 4 MiB payload arrived as 19 `data` events of 128–410 KiB. One hundred 10-byte writes in a row were coalesced (the last events were 160 and 840 bytes). A length-prefix or delimiter framing is mandatory. | [M] | `$T/tcp.ts` 1 |
| 4.2 | **`write()` is unbuffered.** It returns the bytes the kernel accepted. A 4 MiB write returned 3,395,691, and the remainder went on the next `drain`. | [M]; [V] `bun-types/bun.d.ts` `Socket.write`, `docs/runtime/networking/tcp.mdx` "Buffering" | `$T/tcp.ts` 1 |
| 4.3 | **Backpressure:** with the receiver `pause()`d, 64 × `write(1 MiB)` returned `1048576` ×3, `249963`, then `0` ×60. The kernel accepted 3.24 MiB, and that is all the receiver got after `resume()`. **60.76 MiB would be lost silently by a caller that ignores the return value.** One `drain` fired. | [M] | `$T/tcp.ts` 2 |
| 4.4 | **Doc mismatch:** `write(buf, byteOffset)` without `byteLength` throws `RangeError`. The length defaults to the whole buffer and not to the remainder the docs describe. Use `write(buf.subarray(off))`. | [M] vs [V] `bun.d.ts` | `$T/tcp.ts` 1b |
| 4.5 | **Doc mismatch (half-close):** a **server** half-close works. Against a python client that sends, does `SHUT_WR` and reads to EOF, `Bun.listen` got `data` then `end`, and a reply written in `end()` reached the client, with either `allowHalfOpen` setting. The **client** differs by method. **`shutdown()` with no argument** is the correct write-side half-close: the peer sees EOF and the client still receives the reply. **`shutdown(true)`**, documented as "shut down write side only", **sends no FIN** (the python server saw `eof=False`) and fires the client's own `end` immediately, so the reply never arrives. **`end()`**, documented as "remains readable", closed the client completely at once. A server write after that returned 15 and was lost. | [M] vs [V] `bun.d.ts` `Socket.shutdown`/`end` | `$T/tcp-halfclose.ts`, `$T/tcp-halfclose2.ts`, `$T/tcp-halfclose3.ts` |
| 4.6 | **Doc mismatch:** `socket.timeout(n)` fires the `timeout` handler once and **does not close the socket** (`readyState` 1, the peer never saw a close within 9 s), although the docs say it "is closed". Granularity is covered in cross-cutting item 1. | [M] vs [V] `bun.d.ts` `Socket.timeout` | `$T/tcp-timeout.ts`, `$T/tcp.ts` 6 |
| 4.7 | `setKeepAlive(true, 1000)` and `setNoDelay(true)` return `true`. Whether keep-alive probes detect a dead peer **needs a real network**, because loopback never loses a peer silently. | [M] return value; [U] effect | `$T/tcp.ts` 7 |
| 4.8 | A SIGKILLed peer process is detected at once (`end` then `close` at 502 ms), because the kernel sends a FIN. A cut cable or network partition sends nothing and would be found only by keep-alive or an application heartbeat. That case **needs a real network**. | [M] / [U] | `$T/tcp.ts` 8 |
| 4.9 | **TLS verification:** `tls: true` against a self-signed server gives `handshake(ok=false, "self signed certificate")` and a close. A pinned `ca` with `serverName` passes (TLSv1.3). A wrong `serverName` fails with a hostname mismatch. `rejectUnauthorized: false` connects with `authorized=false`. | [M] | `$T/tls.ts` |
| 4.10 | **mTLS:** with `requestCert` and `rejectUnauthorized` on the server, a client with a cert works and the server sees the peer CN. A client without a cert completes its side of the handshake (`ok=true`) and is then closed by the server, which is TLS 1.3 post-handshake rejection. | [M] | `$T/tls.ts` 4c |
| 4.11 | **TLS write timing:** when the client declares a `handshake` handler, `open()` fires **before** the handshake, and a `write()` there returns `0` and is dropped. Write in `handshake()`, or omit the handler so that `open()` waits. | [M]; [V] `bun.d.ts` `SocketHandler.open` | `$T/tls-write-timing.ts` |
| 4.12 | **Custom ALPN must be wire-format bytes** (length-prefixed, as `Uint8Array`, `Buffer` or `ArrayBuffer`). An array throws `ERR_INVALID_ARG_TYPE`. **A plain string is accepted and silently negotiates nothing** (`alpnProtocol === false`). Mismatched encodings fail with `TLSV1_ALERT_NO_APPLICATION_PROTOCOL`. | [M] | `$T/tls-alpn.ts` |
| 4.13 | Unix domain sockets work, both with a path and with a Linux abstract name (`"\0name"`). `remoteAddress` is `undefined` on them. | [M] | `$T/tcp.ts` 5 |
| 4.14 | `node:tls` has no PSK and no cross-process session resumption. Bun uses BoringSSL, so it has no `chacha20-poly1305` in `node:crypto`. | [V] `bun-types/docs/runtime/nodejs-compat.mdx` | — |

## 5. UDP: `Bun.udpSocket`

API: `await Bun.udpSocket({ hostname, port, binaryType, connect?: { hostname, port }, socket: { data(sock, buf, port, addr, flags), drain, error } })`. An unconnected socket has `send(data, port, ip)` → boolean and `sendMany([data, port, ip, …])` → count. A connected socket has `send(data)` and `sendMany([data…])`. There are also `setBroadcast`, `setTTL` and the multicast methods. `flags` is `{ truncated, ipv6 }`.

| # | Claim | Mark | Evidence |
|---|---|---|---|
| 5.1 | Present and working. `send`, `sendMany`, connected `send` and `sendMany` all delivered, and `flags` arrived as `{"truncated":false,"ipv6":false}`. | [M]; [V] `bun-types/docs/runtime/networking/udp.mdx` | `$T/udp.ts` 1 |
| 5.2 | There is no DNS resolution: `send(…, "localhost")` throws "Invalid address". | [M]; [V] `udp.mdx` | `$T/udp.ts` 1 |
| 5.3 | On IPv4 loopback, datagrams up to **65,507 bytes** went through intact. At 65,508 bytes and above, `send` **throws `EMSGSIZE`**, which is loud rather than silent. This says **nothing about real paths**, where anything above the path MTU (about 1,472 bytes of payload on Ethernet, less through tunnels) is fragmented or dropped. **Needs a real network.** | [M] / [U] | `$T/udp.ts` 2 |
| 5.4 | **Loss happens even on loopback, from the receive buffer.** A same-process burst of 200,000 × 1 KiB via connected `sendMany` was fully accepted by the kernel (`sendMany` never came up short, 1 `drain`), yet only **1,012 were received (99.5% lost)**. With the receiver in its own process, an unpaced burst of 20,000 lost 0.7%, and a paced one lost 8 of 20,000. UDP has no flow control, and **`Bun.udpSocket` offers no receive-buffer setting**. `node:dgram`'s `setRecvBufferSize` does work (212992 → 8388608). | [M] | `$T/udp.ts` 3, 6, 7 |
| 5.5 | No reordering was seen on loopback (0 out-of-order out of 1,012). **This says nothing about a real network.** | [M] / [U] | `$T/udp.ts` 3 |
| 5.6 | An ICMP port-unreachable (sending to a closed port) is reported by calling the `error` handler with **`undefined`** in place of an `Error`, on both connected and unconnected sockets. `send` still returned `true`. The error cannot be attributed to a particular send, and code that does `e.message` crashes. | [M] | `$T/udp.ts` 4 |
| 5.7 | **There is no DTLS.** `Bun.udpSocket({ tls: … })` is accepted **silently and ignored**. Nothing in bun-types mentions DTLS. The only encrypted UDP option is QUIC (§6). | [M]; [V] `bun.d.ts` `udp.SocketOptions` has no `tls` | `$T/udp.ts` 5 |
| 5.8 | `node:dgram` is marked "fully implemented, 99% of Node's tests". | [V] `nodejs-compat.mdx` | — |

## 6. HTTP/2, gRPC, HTTP/3, QUIC, WebTransport

| # | Claim | Mark | Evidence |
|---|---|---|---|
| 6.1 | `Bun.serve({ http2: true, tls })` serves h2 on the same port through ALPN. curl negotiated `HTTP/2`, and `curl --http1.1` got 1.1. It is **experimental**, and it shipped in v1.4.1 (2026-09-04). | [M]; [V] `bun.com/docs/runtime/http/server`, https://bun.com/blog/bun-v1.4.1 | `$T/h2.ts` A2 |
| 6.2 | `fetch(url, { protocol: "http2" })` multiplexes. Five concurrent requests to a 300 ms handler took 307 ms over **one** client connection. Full-duplex ping-pong works over h2. | [M] | `$T/h2.ts` A3, A4 |
| 6.3 | **Default `fetch` does not use h2.** The same five concurrent requests without `protocol` used five connections. With `BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1` (or `--experimental-http2-fetch`) they used one. | [M]; [V] `bun-types/globals.d.ts` `protocol` | `$T/h3.ts` 0 (run with and without the flag) |
| 6.4 | **`Bun.serve` cannot send trailers** (the `node:http2` client saw `trailers null`). Its docs say response trailers "needed by gRPC", server push and WebSockets over h2 are unsupported. | [M]; [V] `bun.com/docs/runtime/http/server` | `$T/h2.ts` A5 |
| 6.5 | **`node:http2` server and client work in Bun, trailers included.** A `createSecureServer` with `waitForTrailers` and `sendTrailers({ "grpc-status": "0" })` ran a bidi ping-pong with a `node:http2` client, and the client received `{"status":"0","message":"OK"}`. Cleartext h2c with prior knowledge and `session.ping()` (RTT 2 ms) also work. Bun's docs say "94% of Node's test suite passes". | [M]; [V] `nodejs-compat.mdx` | `$T/h2.ts` B, C |
| 6.6 | **gRPC** is feasible without npm only as our own code on `node:http2`: 5-byte length-prefixed messages, `grpc-status` trailers, and a **hand-written protobuf codec**, or a non-protobuf codec that no off-the-shelf gRPC peer will speak. Nothing native provides it. This is an inference from 6.4 and 6.5; no gRPC framing was built. | [U] | — |
| 6.7 | `Bun.serve({ http3: true, tls })` listens on UDP on the same port (a `*:port` UDP socket was seen) and adds `alt-svc: h3=":port"; ma=86400` to HTTP/1.1 responses. `http1: false` gives an h3-only server, which refused the HTTP/1.1 fetch. | [M] | `$T/h3.ts` 1, 2, 7; `$T/h3-probe.ts` |
| 6.8 | The `fetch({ protocol: "http3" })` client works against it (it needed no flag in this build) for streamed responses (reads at 1/151/301/451 ms), full-duplex ping-pong, a 4 MiB body in 16 ms, 20 concurrent requests and `AbortSignal.timeout` (the server's `req.signal` fired). | [M] | `$T/h3-probe2.ts` |
| 6.9 | **The HTTP/3 client does not accept a per-request `tls.ca` or `tls.serverName`.** Either one gives `HTTP3Unsupported`. With no `tls` it verifies against the process store: a self-signed cert gives `HTTP3HandshakeFailed`, and it passes once the cert is in `NODE_EXTRA_CA_CERTS`. `rejectUnauthorized: false` also works. **Per-executor CA pinning, and by the same token client certificates, are not available on h3 fetch.** Client certificates were not tried. | [M] / [U] mTLS | `$T/h3-probe2.ts` (run plain and with `NODE_EXTRA_CA_CERTS=cert.pem`) |
| 6.10 | HTTP/3 is **experimental**. The blog says "Don't ship `http3: true` to production yet", and notes that 0-RTT resumption is disabled, `server.upgrade()` returns `false` over H3, and `unix:` sockets skip the H3 listener (Bun 1.4, 2026-08-20). | [V] https://bun.com/blog/bun-v1.4, `bun.com/docs/runtime/http/server` | — |
| 6.11 | **Raw QUIC through `node:quic` works in Bun** with a custom ALPN (`bunjobs/1`): `listen` with `sni: {"*": {keys, certs}}`, and `connect` with `ca`/`servername`. It gave a TLS 1.3 session, a bidi stream ping-pong through `stream.writer.writeSync` and async iteration, and a datagram round trip (`sendDatagram` resolved to `1`). A 4000-byte datagram over `maxDatagramFrameSize` 1200 resolved to `0`, meaning refused. Connecting without the CA failed with `DEPTH_ZERO_SELF_SIGNED_CERT`, so verification is enforced. Importing it prints an `ExperimentalWarning`. | [M] | `$T/quic.ts` |
| 6.12 | Node marks `node:quic` "Stability: 1.0 – Early development" (added in v23.8.0; `alpn`/`sni` options added in v26.1.0/v24.16.0). Bun's page says "99% of Node.js's test suite passes". Bun lacks `quic.listEndpoints` (`undefined`), which Node main documents. Expect API churn. | [V] https://raw.githubusercontent.com/nodejs/node/main/doc/api/quic.md (snapshot at `$T/node-quic.md`); `nodejs-compat.mdx`; [M] `listEndpoints` | — |
| 6.13 | **WebTransport and `WebSocketStream` are absent** (`typeof … === "undefined"`). | [M] | `$T/h3.ts` 8 |

## 7. Other native options (for completeness)

| Option | Status | Note | Mark |
|---|---|---|---|
| `Worker` `postMessage`, `Bun.spawn({ ipc })` | Native | Local only. bun-jobs already uses these for runner isolation. They are not remote transports. | [V] `bun-types/docs/runtime/workers.mdx`, `child-process.mdx` |
| Unix-socket HTTP/WS/TCP | Native | Same-host executor sidecar with no TCP port (§1.13, §3.13, §4.13) | [M] |
| Broker-mediated (Redis streams/pub-sub via `Bun.RedisClient`, Postgres `LISTEN`/`NOTIFY` via `Bun.SQL`) | Native, already in bun-jobs' drivers | "Transport" through the queue's own backend. It needs no inbound port on the executor. It was not measured here. | [U] here |
| `BroadcastChannel` | In-process only | Not a network transport | [U] |

## What only a real network can show

The following were **not** measured and must not be inferred from loopback:

- UDP loss, reordering and duplication on a path, and the path MTU and fragmentation above about 1,472 bytes.
- Whether TCP keep-alive (`setKeepAlive`) detects a silent partition, and how quickly.
- How proxies and load balancers treat HTTP/1.1 full duplex (§1.2), SSE buffering and WebSocket idle cuts.
- NAT rebinding and connection migration under QUIC/HTTP/3.
- The latency of HTTP/3 against HTTP/1.1 over TLS. The blog's "2.7× faster" is for a static route on loopback, and this file did not reproduce it.

## Sources (all read 2026-09-25)

- Bun server docs: https://bun.com/docs/runtime/http/server (HTTP/2, HTTP/3, `idleTimeout`)
- Bun 1.4 blog (2026-08-20): https://bun.com/blog/bun-v1.4
- Bun v1.4.1 blog (2026-09-04): https://bun.com/blog/bun-v1.4.1
- Bun blog index (v1.4.2, 2026-09-05, newest release): https://bun.com/blog
- EventSource issue: https://github.com/oven-sh/bun/issues/8474 (OPEN)
- Node `quic` docs: https://raw.githubusercontent.com/nodejs/node/main/doc/api/quic.md
- Bundled Bun docs and types (bun-types 1.4.2): `node_modules/bun-types/{serve.d.ts,bun.d.ts,globals.d.ts}` and `docs/runtime/{http/server.mdx,networking/{tcp,udp,fetch}.mdx,nodejs-compat.mdx}`, `docs/guides/http/sse.mdx`, in `/home/kingsloob1/Desktop/projects/mine/bun-node`
