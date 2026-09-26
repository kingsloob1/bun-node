# Remote transports: one protocol, many bindings

Design for carrying a Phase 2 remote attempt over more than one network
protocol: HTTP request/response, HTTP with a streamed response, SSE,
WebSocket in both directions, TCP (with TLS and Unix sockets), UDP, HTTP/2,
and, through the plugin system, gRPC, QUIC and message brokers. Every one of
them must carry health checks, progress, logs and heartbeats, so that a worker
can tell that the executor built for that protocol is actually working.

The user's request, verbatim: *"Make phase 2 to also accept different web
protocol, tcp, udp, websocket, sse, etc. The different protocol must support
health checks, send progress reports, etc to ensure that the worker built for
that protocol is actually working. Ensure example usage of these protocols is
properly documented."*

Written 2026-09-25 on `docs/phase2-transports`, stacked on the Phase 1 branch
(`e11cc8c`). **No code was changed.** Every repository line number below was
read at `e11cc8c`.

It extends two plans and does not repeat them:

- [`worker-runtimes.md`](worker-runtimes.md) §5 is the signed remote-worker
  contract. It was written HTTP-first. This document separates its **message
  protocol** from its **transport** and adds the bindings. WR §5's signing,
  idempotency, fencing, error taxonomy and outcome table are reused unchanged
  wherever this document does not say otherwise, and §4.13 lists every place
  it does.
- [`compute-provider-plugins.md`](compute-provider-plugins.md) §8 is the
  `execute` facet, the pluggable transport. It was `send(request) →
  Response`. CPP §8 is revised with this document to add a session shape;
  the interface lives there.

Where this document and those two disagree about transports, this one is
newer.

### Contents

1. [Executive summary](#1-executive-summary)
2. [What the evidence forces](#2-what-the-evidence-forces)
3. [Architecture: protocol, binding, transport](#3-architecture-protocol-binding-transport)
4. [The message protocol](#4-the-message-protocol)
5. [The health model](#5-the-health-model)
6. [Progress, logs and heartbeats on every transport](#6-progress-logs-and-heartbeats-on-every-transport)
7. [The bindings](#7-the-bindings)
8. [Configuration: what a user writes](#8-configuration-what-a-user-writes)
9. [The executor side: per-transport servers](#9-the-executor-side-per-transport-servers)
10. [Conformance, per binding](#10-conformance-per-binding)
11. [Documentation deliverables](#11-documentation-deliverables)
12. [Observability and the Workers page](#12-observability-and-the-workers-page)
13. [Phases and effort](#13-phases-and-effort)
14. [Risks](#14-risks)
15. [Open questions](#15-open-questions)
16. [Appendix A: the crypto spike run for this plan](#appendix-a-the-crypto-spike-run-for-this-plan)
17. [Appendix B: what still needs a real network](#appendix-b-what-still-needs-a-real-network)

### How to read the markings

| Tag | Meaning |
|---|---|
| **[M]** | Measured on this machine by a re-runnable spike. `[M bun §1.4]` is row 1.4 of [`evidence/remote-transports/bun-transports.md`](evidence/remote-transports/bun-transports.md), whose spikes are in [`evidence/remote-transports/spikes/`](evidence/remote-transports/spikes/). `[M A]` is this plan's own spike, [Appendix A](#appendix-a-the-crypto-spike-run-for-this-plan). |
| **[V key]** | Read on 2026-09-25 in a primary source. The key resolves in the Sources table of [`evidence/remote-transports/platform-transports.md`](evidence/remote-transports/platform-transports.md). `[V bun §6.10]` is a [V] row of `bun-transports.md`. |
| **[V-prior]** | Carried from an earlier plan or evidence file, which is named. |
| **[S]** | Read from this repository's source at `e11cc8c`; the file and line are given. |
| **[I]** | Inference. It is a claim to test, not a finding. |
| **[U]** | Unverified. Nothing may rest on it without a check. |
| **[D]** | A design proposal of this plan. Almost everything in §3–§13 is [D]; it is marked where the distinction matters. |

**Section references.** `WR §n` is §n of [`worker-runtimes.md`](worker-runtimes.md),
`CPP §n` is §n of [`compute-provider-plugins.md`](compute-provider-plugins.md),
and a bare `§n` is this document.

**Every measurement here is from one machine, on loopback, on a canary
build** (`bun --revision` → `1.4.3-canary.1+5f554969b`; the newest release
is v1.4.2) [M bun, "Environment"]. Loopback has no loss, no reordering, no
path MTU, no NAT and no middlebox. Anything that depends on those is [U] and
is listed in [Appendix B](#appendix-b-what-still-needs-a-real-network). The
spikes must be re-run on the release Phase 2 ships against, and that re-run
is a gate item of every sub-phase in §13.

This plan's history has three withdrawn claims, each an inference presented as
a finding (`worker-runtimes.md` appendix). The evidence files keep [I] and [U]
visibly apart from [M] and [V]; so does this one.

---

## 1. Executive summary

### 1.1 The one-paragraph answer

Phase 2 defines **one versioned message protocol** and a set of **bindings**
that carry it. The protocol is twenty message types (`hello`, `welcome`,
`invoke`, `accepted`, `rejected`, `progress`, `log`, `heartbeat`, `ping`,
`pong`, `health`, `health-result`, `result`, `fail`, `cancel`, `status`,
`status-result`, `ack`, `close`, `problem`), a session state machine, an
attempt state machine, and a **reliability layer** (sequence numbers,
cumulative acknowledgements, a bounded outbox for resumption, and, for a
transport that is not reliable, retransmission, a send window and
fragmentation). Every frame is authenticated on its own with HMAC-SHA256 under
the WR §5.6 secret, bound to its session, direction and sequence number; on a
transport that is not confidential (UDP, plaintext TCP), frames are sealed with
AES-256-GCM under keys derived from that secret. All of this lives in the
bun-jobs core, one implementation, above the transport, so **a transport only
moves opaque bytes and never holds the secret**. Each binding then specifies
how it connects, frames, orders, bounds, keeps alive, resumes and secures
those bytes. **Health** is the same on every binding: liveness (application
`ping`/`pong` and a periodic `heartbeat`), readiness (`health`, and the
capacity every heartbeat carries), and a **functional canary**, a synthetic
invoke that goes through the executor's real dispatch path and must come back
with progress, a log line and a result. Every executor also serves a plain
HTTP `GET /healthz` and `/readyz` for the platform's own checks, which cannot
see a WebSocket or a UDP flow. The `execute` facet becomes transport-agnostic
by gaining a **session shape** (`open()` or `listen()` returning a duplex
session of frames) beside today's **exchange shape** (`send(Request) →
Response`), and the first-party transports are written on that public API.

### 1.2 The decisions

| # | Decision | Why |
|---|---|---|
| T1 | **Separate the message protocol from the transport.** One protocol, versioned by `WORKER_PROTOCOL_VERSION`; bindings are appendices of `PROTOCOL.md`. | WR §5's envelopes already say what to carry; only the framing differs per transport. `worker-runtimes.md` §5.2 already said a later WebSocket would be "a re-framing of the same envelopes" [V-prior]. Inngest Connect puts the same JSON body inside its socket envelope [V-prior prior-art-survey §Inngest]. |
| T2 | **The reliability layer lives in the core, not in the UDP binding.** Resumption on WebSocket and TCP needs sequence numbers, acknowledgements and an outbox anyway; UDP only adds retransmission timers, a window and fragmentation on top of the same machinery. | One implementation serves reconnection on every session transport and reliability on UDP and on at-most-once brokers. It also keeps the UDP binding thin enough to be written on the public API (§3.2), which the no-privileged-internals rule requires. |
| T3 | **Every frame is authenticated individually,** bound to `(session, direction, sequence)`. On a transport the core must treat as not confidential, frames are AEAD-sealed. | A session transport has no request boundary for WR §5.6's whole-body signature. Per-frame authentication also fixes a weakness WR §5.10 documented: progress frames on a stream were applied before the stream's signature could be verified. Cost: ~10–12 µs per frame with `crypto.subtle` [M A]. |
| T4 | **The `execute` facet has two shapes**: exchange (`send(Request) → Response`, unchanged) and session (`open()`/`listen()` → a duplex session of frames). | HTTP is request/response; forcing it into a pipe helps nobody. Existing exchange providers (`httpsExecute`, `lambdaExecute`, Acme Functions) keep working. |
| T5 | **Health is three checks on every binding**: liveness, readiness, and a functional canary through the real handler path. Plus a plain HTTP `/healthz`/`/readyz` on every executor for the platform. | A ping proves the socket, not the handler. Platforms cannot health-check a WebSocket (ALB [V aws-alb-hc]) or UDP (NLB checks UDP targets over TCP/HTTP [V aws-nlb-hc]; AKS has no UDP probes [V az-aks-lb]), and some check only at deploy (Railway [V railway-hc]). The protocol heartbeat is the one signal that works everywhere [V platform §4.3]. |
| T6 | **Every deadline is an application timer.** No liveness or heartbeat deadline uses `idleTimeout`, `socket.timeout()` or `fetch`'s `timeout`. | Bun's built-in network timers fire in 4-second ticks, and `fetch`'s never before ~8 s [M bun cross-cutting 1]; `AbortSignal.timeout()` is exact [M bun §1.6, M A]. |
| T7 | **Heartbeats are application bytes, every 10 s by default.** | Keepalives that do not count: HTTP/2 PING on ALB [V aws-alb-attrs], TCP keepalive on Global Accelerator [V aws-ga]; Heroku counts bytes [V heroku-routing]. The shortest idle clocks on the paths in the matrix are 30 s (GCP classic LB backend timeout, Linux UDP conntrack, Global Accelerator UDP) [V gcp-lb-timeouts, linux-ct, aws-ga]. |
| T8 | **Heartbeat loss with a live gateway fails the attempt fast**, as `RemoteAttemptLostError`: retryable, and it counts as an attempt, as a crashed child process does today. | The gateway holds the lease the whole time (`BunQueueWorker.ts:2228-2232`, `:3429-3458`) [S], so it can decide without waiting for the lease to lapse and the stalled sweep to run. The next attempt carries a larger fence (WR §5.8), so a partitioned executor that is still running cannot settle. |
| T9 | **HTTP/2 is an experimental flag on the HTTP bindings, first-party.** | Same binding, different `fetch` option; multiplexing measured [M bun §6.2]; experimental in Bun [V bun §6.1]. |
| T10 | **gRPC is a third-party plugin.** bun-jobs publishes an informative `.proto` of the message protocol. | No Bun API; `Bun.serve` cannot send trailers [M bun §6.4]; an interoperable codec means hand-written protobuf or an npm library the dependency policy forbids in a published package. A plugin package may depend on `@grpc/grpc-js`. §7.10 |
| T11 | **HTTP/3 and raw QUIC are deferred**, with the session API shaped so a plugin can add them without an API change. | Bun: "Don't ship `http3: true` to production yet" [V bun §6.10]; the h3 client cannot pin a per-executor CA [M bun §6.9]; `node:quic` is "Early development" [V bun §6.12]. §7.11 |
| T12 | **TCP and UDP are specified in full, and first-party**, with their honest value recorded: polyglot executors and private networks, not reach. | The user asked for them. The research recommended against them because they reach no platform WebSocket cannot [V platform §1.2]; §1.3 answers that. |
| T13 | **UDP frames are always AEAD-sealed; there is no plaintext UDP mode.** | There is no DTLS in Bun: `Bun.udpSocket({ tls })` is silently ignored [M bun §5.7]. AES-256-GCM costs the same as HMAC per 1,200-byte frame (11.8 µs against 11.5 µs) [M A], so integrity-only would save nothing. |
| T14 | **Brokered transports (NATS, MQTT, AMQP, Kafka) are plugins** on the session shape, with `direction: "brokered"`. | Every one needs an npm client. The core's reliability layer covers an at-most-once broker. §7.12 |
| T15 | **Phase 2 is split into sub-phases 2a–2f, all committed, built in order 2a, 2b, 2c, 2d, 2e, 2f** (the user's decision, 2026-09-25, Q-T1). 2a (HTTP unary and streamed, the health model, the session-capable facet) is the first milestone. | 2a alone reaches every platform with an inbound HTTP path [V platform §1.1], so it is the natural first release; each later sub-phase adds a binding on the layers before it. §13 |

### 1.3 What the research recommended, and why this plan specifies TCP and UDP anyway

`platform-transports.md` §1.2 concluded: **"Do not specify raw TCP or UDP.
They reach no platform that WebSocket over an outbound connection cannot"**
[V platform §1.2, its recommendation marked I]. That is correct about
*reach*, and this plan does not dispute it: raw TCP and UDP are inbound only
where a container or VM runs behind an L4 load balancer the user owns, or on
Fly, which are exactly the hosts where an ordinary pull-mode `BunQueueWorker`
already runs [V platform §1.1].

The user asked for them, so they are specified fully. Their honest value is
elsewhere:

- **Polyglot executors.** A pull worker needs a bun-jobs driver: Lua scripts
  for Redis, the SQL schema and its claim statements, the Mongo documents.
  None of that exists in Go, Rust or Python. An executor that speaks this
  protocol over TCP needs a socket, HMAC-SHA256 and JSON, which every language
  has in its standard library [I]. A Go image-processing service, a Rust
  inference server, a Python ML worker on a GPU box: each can take bun-jobs
  work without a driver port. §11.3 commits a stdlib-only Python executor to
  prove that `PROTOCOL.md` is sufficient.
- **Private networks.** A Cloud Run worker pool takes "IP based L4 ingress
  with Direct VPC", from inside the VPC only, and must "listen for TCP
  connections" [V gcr-model, gcr-contract]. Render private services take
  "almost any port … any protocol" on the private network [V render-privnet].
  Railway's private network carries any traffic, UDP included
  [V railway-private]. On those, TCP needs no HTTP stack, no load balancer and
  no request timeout.
- **Same-host sidecars.** A Unix socket to a sidecar in the same pod or VM
  needs no port and no TLS [M bun §4.13].
- **UDP specifically**: low-overhead heartbeats and very small jobs inside one
  datacenter, and executors on devices whose stacks are UDP-first [I]. It is
  the weakest case, and §14 says so.

Where each is hostable is in §7.7 and §7.8, taken from the matrix.

### 1.4 Where each transport lands

| Binding | Id | First-party | Sub-phase | Hostable inbound (from [V platform §1.1]) |
|---|---|---|---|---|
| HTTP request/response | `http` | yes | 2a | universal where there is inbound HTTP |
| HTTP with a streamed response | `http-stream` | yes | 2a | near universal; opt-in or capped on Lambda URL, API GW REST, Netlify; not on API GW HTTP API or ALB→Lambda |
| SSE | `sse` | yes: per-attempt framing in 2a, session mode in 2d | 2a / 2d | as `http-stream` |
| WebSocket, forward | `ws` | yes | 2b | wide, not universal |
| WebSocket, reversed | `ws-reverse` | yes | 2d | any long-running host with outbound TCP; not FaaS |
| TCP (+TLS, Unix) | `tcp` | yes (reverse TCP in 2d) | 2c | rare, never FaaS |
| UDP | `udp` | yes, `experimental` until a real-network run | 2e | rarest |
| HTTP/2 | flag on `http`/`http-stream` | yes, experimental | 2f | partial |
| gRPC | plugin | no; informative `.proto` in 2f docs | — | partial |
| HTTP/3, QUIC | — | deferred | — | NLB QUIC listeners; CF edge |
| NATS, MQTT, AMQP, Kafka | plugin | no; mapping guide in Phase 3 | — | wherever the broker is |

---

## 2. What the evidence forces

### 2.1 Measured Bun behaviour, and the rule each forces

| Fact | Mark | Rule in this design |
|---|---|---|
| `idleTimeout`, `socket.timeout(n)` and `fetch`'s `timeout` fire in 4-second ticks; `fetch`'s never before ~8 s | [M bun cross-cutting 1] | T6: every protocol deadline is an app timer or `AbortSignal.timeout()`. Built-in timers are set to their maximum or `0` and act only as backstops. |
| `AbortSignal.timeout(200)` fired at 201 ms; 250 → 250 ms; 1000 → 1001 ms | [M bun §1.6, M A] | The timer the design relies on is accurate at the granularity it needs. |
| `EventSource` is `undefined` at runtime although bun-types declares it | [M bun §2.1] | The SSE parser, reconnect and `Last-Event-ID` are ours (§7.4). A lint rule or a test forbids `EventSource` in `lib/`, because it typechecks and then throws. |
| `Bun.serve` holds the header block until the first body chunk; `fetch()` does not resolve until then | [M bun §1.4] | Every streaming executor writes its first frame (`accepted`, or an SSE comment) immediately (§7.3). |
| A quiet stream is cut by `idleTimeout` unless `server.timeout(req, 0)` | [M bun §1.7, §2.6] | Executor servers call `server.timeout(req, 0)` on every streamed response; liveness is the heartbeat. |
| `maxRequestBodySize` (default 128 MiB) caps the *total* of a streamed upload, and errors rather than truncates | [M bun §1.10] | No binding streams frames in a request body indefinitely; the SSE session mode sends gateway frames as separate POSTs (§7.4). |
| WebSocket server `send()` returns `0` (dropped) past `backpressureLimit`; client `bufferedAmount` is unbounded; oversize frames close 1006, not 1009; a paused client never learns of a close | [M bun §3.6–§3.8, §3.5, §3.7, §3.11] | The WS binding checks every `send()` result and treats `0` as a failed session; bounds its own buffers on both ends; refuses an oversize message before sending; runs app-level liveness on both ends (§7.5). |
| TCP `write()` is unbuffered: a paused receiver kept 3.24 MiB of 64 MiB written | [M bun §4.2, §4.3] | The TCP binding keeps a bounded outbound queue per socket and writes the remainder on `drain` (§7.7). |
| `shutdown(true)` sends no FIN; client `end()` closes both ways; `socket.timeout()` does not close; `write(buf, offset)` without a length throws; custom ALPN needs wire-format bytes; a write in `open()` before the TLS handshake is dropped | [M bun §4.4–§4.6, §4.11, §4.12] | Each is a line in §7.7's rules, and a test (§10). |
| UDP has no flow control (a same-process burst lost 99.5% in the receive buffer); `Bun.udpSocket` has no receive-buffer option; ICMP errors reach `error()` as `undefined`; no DNS in `send()`; no DTLS | [M bun §5.2, §5.4, §5.6, §5.7] | The core's send window (§4.5.3), a lookup before connect, an `error` handler that never dereferences its argument, AEAD in the core (§7.8). |
| HTTP/2 server and client work, experimental; default `fetch` does not use h2 | [M bun §6.1–§6.3] | HTTP/2 is an explicit, experimental flag (§7.9). |
| h3 `fetch` refuses a per-request `tls.ca` or `serverName` | [M bun §6.9] | HTTP/3 is deferred (§7.11). |
| HMAC-SHA256 via `crypto.subtle`: 10.3 µs (64 B), 11.5 µs (1,200 B), 23.4 µs (16 KiB) per sign, sequential; `node:crypto` `createHmac` 1.7 µs at 1,200 B; HKDF → AES-256-GCM round-trips, 16-byte overhead, rejects a flipped byte, 11.8 µs per 1,200 B; X25519 and Ed25519 work | [M A] | Per-frame authentication is affordable (T3); AEAD for UDP costs nothing extra (T13); forward-secret sessions are possible later (§4.4.5). |

### 2.2 Platform traps, and the rule each forces

| Trap | Source | Rule |
|---|---|---|
| Proxies buffer streams: nginx `proxy_buffering on`; Cloudflare Tunnel buffers unless `Content-Type: text/event-stream`; Cloudflare "Standard" body buffering; API GW REST and Lambda URLs default `BUFFERED`; App Engine flex in 64 KB blocks; ingress-nginx the opposite default | [V nginx-proxy, cf-tunnel, cf-buffering, aws-apigw-stream, aws-furl-modes, gae-flex, ingress-nginx-cm] | Streams are SSE-framed and send `Content-Type: text/event-stream`, `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-transform`; the session open runs a **buffering probe**, and a buffered path is downgraded to unary with the reason shown (§5.7). |
| Idle timeouts drop quiet connections: ALB 60 s (HTTP/2 PING does not reset it), Heroku 55 s, nginx 60 s, Azure LB 4 min silent drop, classic GCP LB 30 s even on an active WebSocket, NAT 350 s, Azure outbound 4 min | [V aws-alb-attrs, heroku-routing, nginx-ws, az-lb-reset, gcp-lb-timeouts, aws-nat] | T7: a 10 s application heartbeat by default, configurable, clamped by a binding's known idle timeout. The classic GCP LB's 30 s cap on *active* WebSockets cannot be heartbeated through; the selection guide says so (§11.2). |
| Timeouts that fail the caller but not the work: Azure Functions 230 s → 502 while the function continues; Cloud Run 504 and the instance is not terminated; Lambda streams billed after disconnect | [V az-func-http, gcr-timeout, aws-lambda-stream] | A lost response is re-attached before it is retried; a retry reuses the idempotency key; outcomes are retained by the executor until acknowledged; fencing blocks a stale settle (§4.9). The docs are candid that a store-less executor may run the handler twice. |
| UDP flows re-routed after a short idle: NLB 120 s to "a new target", GCP passthrough 60 s, conntrack 30 s | [V aws-nlb, gcp-netlb-ct, linux-ct] | UDP keepalive ≤ 25 s is enforced as a `ConfigError`; a connection id lets a session survive a port rebinding; a stateless reset tells the gateway at once when it reached an instance that does not know the session (§7.8). |
| Platform health checks cannot see the protocol: ALB cannot check WebSockets; NLB checks UDP targets over TCP/HTTP; AKS has no UDP probes; Railway checks only at deploy; Fly's top-level checks do not route; CF Containers ping only at startup | [V aws-alb-hc, aws-nlb-hc, az-aks-lb, railway-hc, fly-hc, cf-ctr-class] | Every executor serves plain HTTP `GET /healthz` and `/readyz` (§5.5). |
| Deploys and maintenance cut connections by design (DO code updates, CF releases, Render instance replacement, GFE maintenance, Cloud Run outbound resets) | [V cf-do-ws, cf-net-ws, render-ws, gcp-lb-timeouts, gcr-contract] | An attempt is addressed by job, attempt and fence, never by connection; sessions resume (§4.5); an executor can announce a drain (`close` with `drain: true`) and a dialling executor makes before it breaks (§7.6). |
| UDP fragmentation: Spectrum drops fragmented UDP; Fly's UDP MTU is ~1,300 | [V cf-spectrum-lim, fly-udp] | Datagrams are at most 1,200 bytes and the core fragments above that (§7.8). |

### 2.3 What bun-jobs already has that this builds on

| What | Where | Used for |
|---|---|---|
| Per-attempt lease renewal on a timer, for the whole attempt | `packages/bun-jobs/lib/queue/BunQueueWorker.ts:2228-2232` [S] | The gateway holds the lease while an attempt is remote, whatever the transport (§5.6) |
| `#heartbeat()`: `extendJobLock`; a lost lock emits `lockLost` and aborts the attempt | `BunQueueWorker.ts:3429-3458` [S] | A lost lock sends `cancel` to the executor (§4.7) |
| `heartbeatInterval` defaults to `max(250, lockDuration / 3)`; `lockDuration` defaults to 30,000 ms | `BunQueueWorker.ts:961-968`, `shared/constants.ts:135` [S] | The lease cadence is independent of the remote heartbeat (§5.2) |
| `UnrecoverableJobError` matched by class and by name | `BunQueueWorker.ts:3235-3236` [S] | `failed-fatal` and `handler-not-found` stay fatal after crossing a wire (`worker-runtimes.md` §11 Phase 2) |
| `WorkerTargetExecutor.run(attempt)`; every write goes through the attempt's `Job` | `lib/queue/workerTarget.ts:209-258` [S] | `RemoteTarget` implements it; `progress` and `log` frames become `job.updateProgress()`/`job.log()` on the attempt's write lane |
| The management API's WebSocket session: three-valued `send()` handled (bytes, `-1` queued, `0` dropped), `maxBufferedBytes`, a heartbeat on a timer, `pong`, `resume` with gap reporting | `lib/api/ws/session.ts:53-60`, `:338-343`, `:514`, `:1443`; `lib/api/ws/protocol.ts:104`, `:157` [S] | The model for the WS binding's backpressure and resume handling. **Not the same socket** (`worker-runtimes.md` §5.1) |
| The runner's IPC opens with `{ t: "ready", pid, protocol }` | `lib/runner/protocol.ts:186` [S] | Precedent for a versioned session handshake |
| `stringifyBounded(value, maxBytes)` | `lib/shared/json.ts:49` [S] | Bounding every message before it is framed |

---

## 3. Architecture: protocol, binding, transport

### 3.1 Four layers

```
 gateway (bun-jobs process, holds the driver and the lease)
 ┌──────────────────────────────────────────────────────────────────────┐
 │ RemoteTarget  — claim, lease, envelope, settle   (worker-runtimes §5) │
 │ Protocol core — messages, session + attempt state machines, health,   │
 │                 reliability layer, frame codec, MAC / AEAD            │  ← one implementation, browser-safe
 ├──────────────────────────────────────────────────────────────────────┤
 │ Transport     — the execute facet: moves opaque frames               │  ← pluggable (first-party or plugin)
 └──────────────────────────────────────────────────────────────────────┘
                 │  bytes: HTTP body / SSE event / WS message /
                 │  length-prefixed TCP frame / UDP datagram / broker message
 ┌──────────────────────────────────────────────────────────────────────┐
 │ Transport server — Bun.serve / Bun.listen / Bun.udpSocket / a dialler │  ← runtime kit (§9), or a polyglot's own
 │ Protocol core    — the same code, executor role                       │
 │ Dispatch         — handlers by job name, the canary, the store        │
 └──────────────────────────────────────────────────────────────────────┘
 executor (remote platform, holds no driver)
```

- **The protocol core** is `lib/remote/protocol/` [D], browser-safe like
  `lib/api/contract/` (`worker-runtimes.md` §6.3), so an executor on workerd
  runs the same code. It owns everything that makes the conversation correct.
- **A binding** is the specification of how the core's frames ride one
  transport: an appendix of `PROTOCOL.md` (§11.5).
- **A transport** is the code implementing a binding on one side. Host side,
  it is an `execute` facet; executor side, a server in the runtime kit (§9).

### 3.2 Who does what

| Concern | Protocol core | Transport | Why there |
|---|---|---|---|
| Message schemas, versions, negotiation | ✓ | — | One definition for every binding |
| MAC and AEAD, key derivation, anti-replay | ✓ | — | **The transport never holds the secret** (`compute-provider-plugins.md` decision 6). A buggy or hostile transport can fail to deliver an outcome; it cannot forge one |
| Sequence numbers, acknowledgements, the resume outbox | ✓ | — | Needed by every session transport |
| Retransmission, send window, fragmentation | ✓, enabled when the transport declares `reliable: false` or a small `maxFrameBytes` | — | Makes UDP and at-most-once brokers thin (T2) |
| Liveness, readiness and canary timing; the breaker | ✓ | — | Health must mean the same on every binding |
| Connecting, dialling, listening, TLS, ALPN | — | ✓ | Transport-specific |
| Framing bytes on the wire (length prefix, SSE event, WS message, datagram) | — | ✓ | Transport-specific |
| Byte-level backpressure: honouring `drain`, bounding buffers, never dropping silently | — | ✓, reported through `bufferedBytes()` and a rejecting `send()` | Only the transport sees the socket |
| Reconnecting to the same executor | — | ✓ (`reconnect()`), when it can | Only the transport knows the address |
| Platform auth on top (a Google ID token, SigV4) | — | ✓ | As today (`compute-provider-plugins.md` §8.1) |

A transport that meets its declared capabilities (§3.3) is correct by
construction on the rest; the conformance kit (§10) checks the declarations
against fault-injecting fakes.

### 3.3 Transport capabilities

A transport declares what it is, and the core reads the declaration; nothing
is known by name [D]. The TypeScript is in `compute-provider-plugins.md`
§8.2. The fields, and what the core does with each:

| Capability | Values | The core |
|---|---|---|
| `binding` | `"http"`, `"http-stream"`, `"sse"`, `"ws"`, `"ws-reverse"`, `"tcp"`, `"udp"`, or a plugin's own id | Shows it on the Workers page; names the `PROTOCOL.md` appendix |
| `shape` | `"exchange"` \| `"session"` | Uses the exchange driver (`send(Request)`) or the session driver (`open()`/`listen()`) |
| `direction` | `"forward"` \| `"reverse"` \| `"brokered"` | Dials, listens, or joins a broker |
| `streaming` | boolean | Whether progress and heartbeats can arrive during an attempt; `false` disables heartbeat liveness for attempts on that endpoint (§6) |
| `duplex` | boolean | Whether the gateway can send mid-attempt on the same channel (cancel, ping) or needs a new exchange |
| `ordered` | boolean | `false`: the core reorders by sequence number before delivering |
| `reliable` | boolean | `false`: the core retransmits, windows and acknowledges (§4.5.3) |
| `maxFrameBytes` | bytes | Above it the core fragments (binary encoding only) |
| `maxMessageBytes` | bytes | Above it a message is refused before sending: `PayloadTooLargeError`, non-retryable |
| `encoding` | `"text"` \| `"binary"` | Picks the frame codec (§4.3) |
| `confidential` | boolean | `false`: the core seals every frame with AEAD (§4.4.3). `true` only when the transport provides TLS to the executor, or the peer is loopback or a Unix socket |
| `flowControl` | boolean | `false`: the core enforces its send window |
| `resumable` | boolean | Whether `reconnect()` can reach the *same* executor, so a session can resume (§4.5.2) |
| `maxDurationMs` | ms | The longest attempt this path allows; reconciled with the handshake as today (`compute-provider-plugins.md` §8.3) |
| `maxConcurrency` | number, optional | A platform cap on attempts in flight |
| `idleTimeoutMs` | ms, optional | The shortest idle clock the transport knows is on its path; the core clamps its keepalive below it |
| `platformProbe` | boolean | Whether the facet implements `probe()` (the executor's `/healthz`) |

### 3.4 Direction: forward, reversed, brokered

- **Forward.** The gateway dials the executor: `http`, `http-stream`, `sse`,
  `ws`, `tcp`, `udp`. The executor needs an inbound path.
- **Reversed.** The executor dials the gateway: `ws-reverse`, and TCP in its
  reverse form. The gateway becomes a server. This is the only practical path
  to a long-running executor with no inbound path [V platform §1.2], and it
  is not available on FaaS (§7.6).
- **Brokered.** Both dial a broker (NATS, MQTT, AMQP, Kafka). The broker is
  the relay. Plugin only (§7.12).

Whoever dials sends `hello`; whoever is dialled answers `welcome`. Roles
(`gateway` or `executor`) are carried in the messages and are independent of
who dialled.

---

## 4. The message protocol

`WORKER_PROTOCOL_VERSION` stays `1`, and this is its content [D]. WR §5.4's
per-feature strings remain the way capabilities are negotiated; this plan adds
`session`, `health`, `attempt-status`, `stream-resume`, `resume`, `canary` and
`udp-aead` to that map.

### 4.1 The messages

`dir`: `g→e` gateway to executor, `e→g` the reverse. **Class**: `R` is
reliable (sequenced, acknowledged, retransmitted or replayed until
acknowledged), `U` is unreliable where the transport is (latest value wins:
on UDP it rides a bare datagram and is never retransmitted; on a text
transport it is sequenced like everything else, and a receiver ignores one
older than a value it already has), `0` is unsequenced (handshake and bare
acknowledgements).

| `op` | dir | Class | Purpose | Required |
|---|---|---|---|---|
| `hello` | dialler → dialled | 0 | Open or resume a session: protocol versions, role, nonce, requested timings, `resume` | MUST (session shape) |
| `welcome` | dialled → dialler | 0 | Accept: chosen version, nonce, the executor's handshake document (WR §5.4 fields), capacity, limits, `resumed` | MUST (session shape) |
| `invoke` | g→e | R | Run these jobs (WR §5.5's body, plus `kind: "job" \| "run"`) | MUST |
| `accepted` | e→g | R | "I have it and have started": per job, within `acceptTimeoutMs` | MUST on a streaming binding |
| `rejected` | e→g | R | "Not now": `BUSY`, `DRAINING`, `STALE_FENCE`, `DUPLICATE_RUNNING`, `TOO_LARGE`. **Does not burn an attempt** (WR §5.5) | MUST |
| `progress` | e→g | U | A job's progress value | SHOULD |
| `log` | e→g | R | A log line for a job | SHOULD |
| `heartbeat` | e→g | U | Every `heartbeatMs`, idle or not: the running attempts, capacity, the executor's clock | MUST on a streaming binding |
| `ping` | either | U | Liveness and RTT: sent when a direction has been quiet for `keepaliveMs` | MUST |
| `pong` | either | U | Immediate answer to `ping`, with capacity | MUST |
| `health` | g→e | R | Readiness probe: author checks, capacity, draining state | MUST |
| `health-result` | e→g | R | Its answer | MUST |
| `result` | e→g | R | A job completed: `status: "completed"`, `result` | MUST |
| `fail` | e→g | R | A job failed: `status: "failed" \| "failed-fatal" \| "handler-not-found"`, `error`, `retryAfterMs` | MUST |
| `cancel` | g→e | R | Stop these attempts: timeout, lost lock, worker closing, `cancel()` | SHOULD (advertised as `cancel`) |
| `status` | g→e | R | What happened to these attempts? Used after a session could not resume | SHOULD (advertised as `attempt-status`) |
| `status-result` | e→g | R | Per attempt: `running`, `done` with its retained outcome, or `unknown` | SHOULD |
| `ack` | either | 0 | A bare acknowledgement when nothing else is going the other way within `ackDelayMs` | MUST (session shape) |
| `close` | either | R | Ending the session, with a code; `drain: true` means "no new invokes, in-flight attempts continue" | MUST |
| `problem` | either | R | A non-fatal protocol error as a `ProblemDto` (`UNSUPPORTED_OP`, a malformed message) | MUST |

The exchange shape (`http`, `http-stream`) uses a subset: `invoke`,
`cancel`, `health` and `status` are POSTs as WR §5.3 has them, and the answers
are unary JSON or a stream of the `e→g` messages above (§7.2, §7.3). The
handshake stays WR §5.4's `GET`.

**What is deliberately absent.** There is no `claim`, `extend` or `complete`
from the executor: the executor never touches the lease (WR §5.9 option A).
There is no message by which an executor can refer to a job it was not sent on
that session.

### 4.2 Message bodies

Every message is a JSON object with `op` and, except `ack`, `at`: the sender's
clock in epoch ms, informative only (§4.12). Unknown fields are ignored
(forward compatibility, WR §5.12). Job-scoped messages carry `job` (the job id)
and `attempt` (1-based); outcome messages also carry the `fence` they answer,
so the gateway can refuse a stale one.

```jsonc
// hello (gateway dials)
{"op":"hello","v":1,"protocols":[1],"role":"gateway","nonce":"q3JtZ2FfZ3c0bE1uUXpXRA",
 "t":1790000000,"worker":{"id":"api.media.h7f3-4211-1789","key":"api.media"},
 "want":{"keepaliveMs":10000,"heartbeatMs":10000,"ackDelayMs":50},
 "resume":null,"features":{"session":"v1","health":"v1","cancel":"v1","attempt-status":"v1","resume":"v1"}}

// welcome
{"op":"welcome","v":1,"protocol":1,"role":"executor","nonce":"Ym9iX2V4ZWN1dG9yX25vbg",
 "name":"media-ws","runtime":"bun","sdk":"@kingsleyweb/bun-jobs/remote@2.3.0",
 "names":["resize-image"],"maxBatch":25,"maxDurationMs":3300000,"maxMessageBytes":1048576,
 "timing":{"keepaliveMs":10000,"heartbeatMs":10000},
 "capacity":{"inFlight":0,"max":8,"accepting":true},
 "features":{"session":"v1","health":"v1","cancel":"v1","attempt-status":"v1","resume":"v1","canary":"v1","idempotency":"v1","fencing":"v1"},
 "resumed":null,"now":1790000000123,"at":1790000000123}

// invoke — WR §5.5's body; `id` is the envelope id, unique per send
{"op":"invoke","v":1,"id":"inv_01JB7Q2M9S0P","kind":"job","now":1790000000456,"deadlineAt":1790000025456,
 "namespace":"shop","queue":"media","jobs":[{"id":"01JB7Q2M8ZRT9V","name":"resize-image","data":{"url":"…"},
 "attempt":1,"maxAttempts":3,"timeoutMs":20000,"idempotencyKey":"shop:media:01JB7Q2M8ZRT9V:1",
 "fence":"h7f3-4211-1789:1790000000400","delivery":1}],"at":1790000000456}

{"op":"accepted","job":"01JB7Q2M8ZRT9V","attempt":1,"fence":"h7f3-4211-1789:1790000000400","duplicate":false,"at":1790000000470}
{"op":"rejected","job":"01JB7Q2M8ZRT9V","attempt":1,"code":"BUSY","retryAfterMs":2000,"at":1790000000470}
{"op":"progress","job":"01JB7Q2M8ZRT9V","attempt":1,"pseq":4,"progress":40,"at":1790000001200}
{"op":"log","job":"01JB7Q2M8ZRT9V","attempt":1,"level":"info","message":"frame 400/1000","at":1790000001201}
{"op":"heartbeat","running":[{"job":"01JB7Q2M8ZRT9V","attempt":1,"since":1790000000470}],
 "capacity":{"inFlight":1,"max":8,"accepting":true},"at":1790000010470}
{"op":"ping","id":"p17","at":1790000020000}
{"op":"pong","id":"p17","capacity":{"inFlight":1,"max":8,"accepting":true},"at":1790000020003}
{"op":"health","id":"h3","at":1790000030000}
{"op":"health-result","id":"h3","ok":true,"capacity":{"inFlight":1,"max":8,"accepting":true},
 "checks":[{"id":"gpu","status":"pass"},{"id":"model-loaded","status":"pass"}],"at":1790000030004}
{"op":"result","job":"01JB7Q2M8ZRT9V","attempt":1,"fence":"h7f3-4211-1789:1790000000400","status":"completed",
 "result":{"bytes":20481},"durationMs":2655,"at":1790000003111}
{"op":"fail","job":"01JB7Q2M8ZRT9X","attempt":2,"fence":"…","status":"failed",
 "error":{"name":"FetchError","message":"upstream returned 503","code":"UPSTREAM_UNAVAILABLE"},"retryAfterMs":30000,"at":…}
{"op":"cancel","jobs":[{"job":"01JB7Q2M8ZRT9V","attempt":1}],"reason":"timeout","at":…}
{"op":"status","jobs":[{"job":"01JB7Q2M8ZRT9V","attempt":1}],"at":…}
{"op":"status-result","jobs":[{"job":"01JB7Q2M8ZRT9V","attempt":1,"state":"done",
 "outcome":{"op":"result","status":"completed","result":{"bytes":20481},"fence":"…"}}],"at":…}
{"op":"ack"}
{"op":"close","code":"DRAINING","drain":true,"retryAfterMs":0,"at":…}
{"op":"problem","problem":{"type":"urn:bun-jobs:error:UNSUPPORTED_OP","title":"…","status":400,"code":"UNSUPPORTED_OP"},"fatal":false,"at":…}
```

`error` is bun-common's `SerializedError`, and `result`/`fail` bodies are
exactly WR §5.5's outcome objects plus `op`, `attempt` and `fence`. The unary
`invoke-result` envelope of WR §5.5 is kept, and its `outcomes[]` are these
bodies, so one outcome representation serves every binding.

`progress` carries `pseq`, a per-attempt counter, because on UDP it is
unreliable and a late datagram must not overwrite a newer value. The final
progress value is repeated in `result` (`progress`), so a lost last
`progress` never leaves a job at 90%.

### 4.3 Frames: two encodings of one frame

A **frame** is one message plus the fields that authenticate and sequence
it. Text transports (`http-stream`, `sse`, `ws`) use the text encoding;
`tcp` and `udp` use the binary one [D].

#### 4.3.1 Text frame

One line of UTF-8, no raw line feed inside (JSON serialisers escape it):

```
BJ1 <seq> <ack> <mac> <json>
```

- `seq`: decimal. Per session, per direction, starting at `1` and increasing
  by exactly one per sequenced frame. `0` for unsequenced frames (`hello`,
  `welcome`, `ack`).
- `ack`: decimal. The highest `seq` received contiguously from the peer; `0`
  when none.
- `mac`: base64url, unpadded (43 characters), of HMAC-SHA256 (§4.4.1).
- `json`: the message.

A receiver splits on the first four spaces and keeps the rest intact:
Python's `line.split(" ", 4)` does exactly that, but JavaScript's
`split(" ", 4)` **discards** the remainder, so a JavaScript reader finds the
four spaces with `indexOf` instead. `PROTOCOL.md` says so beside the grammar. Every text transport is ordered and
reliable, so on text transports **every message is sequenced** except the
three unsequenced ones, class `U` included: one sequence space with no holes
is what makes a gap detectable (§4.4.2). A replayed `heartbeat` or `progress`
is recognised as stale by its `at` or `pseq` and ignored.

#### 4.3.2 Binary frame

Big-endian throughout. A TCP frame is this, preceded by the TCP binding's
4-byte length (§7.7); a UDP datagram is exactly this (§7.8).

| Offset | Size | Field | Meaning |
|--:|--:|---|---|
| 0 | 2 | `magic` | `0x42 0x4A` (`"BJ"`) |
| 2 | 1 | `version` | `0x01` |
| 3 | 1 | `flags` | bit 0 `SEQUENCED`; bit 1 `SEALED` (AEAD, else HMAC); bit 2 `HANDSHAKE`; bit 3 `RESET`; others zero |
| 4 | 8 | `connId` | UDP: chosen by the dialler in `hello`. TCP: zero |
| 12 | 8 | `pn` | Packet number: per session, per direction, strictly increasing on **every** frame including retransmissions. Anti-replay and the AEAD nonce |
| 20 | 8 | `seq` | Message sequence number when `SEQUENCED`; zero otherwise |
| 28 | 8 | `ack` | Highest `seq` received contiguously |
| 36 | 8 | `sack` | Bitmap: bit *i* set when `ack + 1 + i` was received (selective acknowledgement, UDP) |
| 44 | 2 | `fragIndex` | 0-based |
| 46 | 2 | `fragCount` | `1` when not fragmented |
| 48 | N | `payload` | The JSON bytes of the message, or of this fragment of it; ciphertext when `SEALED` |
| 48+N | 32 or 16 | `tag` | HMAC-SHA256 (32 bytes) or the AES-GCM tag (16 bytes) |

A retransmitted fragment keeps its `seq`, `fragIndex` and `fragCount` and
gets a new `pn`, so an AEAD nonce is never reused.

### 4.4 Authentication and confidentiality

#### 4.4.1 The frame MAC

For a frame that is not sealed:

```
text:    mac = HMAC-SHA256(key, "BJ1" LF sid LF dir LF seq LF ack LF json)
binary:  tag = HMAC-SHA256(key, "BJ1b" LF sid LF dir LF header[0..48] payload)
```

- `key` is the WR §5.6 secret, bytes of its UTF-8. With a rotation list, the
  sender uses the first key and the receiver accepts any (WR §5.6 unchanged).
- `sid` is the **session id**: `nonceDialler "." nonceDialled`, the two
  128-bit base64url nonces from `hello` and `welcome`. For an `http-stream`
  response, whose request was WR §5.6-signed, `sid` is the invoke envelope's
  `id`.
- `dir` is the sender's role: `g` or `e`.
- `LF` is byte `0x0A`.

**What this binds.** A frame verifies only in its own session (`sid`), in
its own direction (`dir`: a frame cannot be reflected back at its sender), at
its own position (`seq`, and `pn` in binary), with its own acknowledgement
(`ack`: an attacker cannot forge acks to make a sender drop frames from its
outbox) [D]. The MAC is compared in constant time (WR §5.6).

**The handshake frames** (`hello`, `welcome`, `seq` 0) cannot use a `sid`
that does not exist yet. `hello` is MAC'd with `sid` = `-` and carries `t`
(Unix seconds) and `nonce`; the receiver applies WR §5.6's replay window in both
directions (`Math.abs(now - t * 1000) > window`) and **MUST** keep a nonce
cache for the window, which a session-capable executor always can because it
is a long-lived process. `welcome` is MAC'd with `sid` = the `hello`'s nonce,
which binds it to that `hello`. Replaying a captured `hello` gets nothing: the
nonce cache refuses it, and even a fresh `welcome` would be useless without
the key to MAC what follows. A bare `ack` is MAC'd in the session like any
frame; a replayed one carries an `ack` no higher than the current one and is a
no-op.

#### 4.4.2 Replay protection after the handshake

- **Text** (ordered, reliable): a frame's `seq` must be exactly one more than
  the last delivered. Lower is a duplicate (dropped silently, as resumption
  produces them). Higher is a protocol error: `close` with `SEQUENCE_GAP`,
  then resume.
- **Binary on TCP**: `pn` strictly increasing; `seq` as for text.
- **Binary on UDP**: a sliding window over `pn` per direction, the
  technique IPsec and DTLS use [I, not re-read today], 1,024 packets wide
  here; a `pn` below the window or already seen is dropped silently. `seq`
  duplicates are dropped after reassembly.

#### 4.4.3 Sealing (AEAD) where the transport is not confidential

When `capabilities.confidential` is `false` and the peer is not loopback or a
Unix socket, every binary frame after the handshake is **sealed** [D]:

```
k_g, k_e  = HKDF-SHA256(ikm = key, salt = nonceDialler || nonceDialled,
                        info = "bun-jobs/1 aead g" | "bun-jobs/1 aead e", L = 32)
nonce     = dirConst(4 bytes: 0x00000067 "g" / 0x00000065 "e") || pn (8 bytes)
aad       = "BJ1b" LF sid LF dir LF header[0..48]
payload   = AES-256-GCM-Encrypt(k_dir, nonce, plaintext, aad)   // tag 16 bytes
```

HKDF is two HMAC calls (RFC 5869) and AES-256-GCM is in WebCrypto, Go's
`crypto/cipher`, Rust's RustCrypto crates and Python's `cryptography`
package [I]. Both were measured working in Bun, with a flipped ciphertext byte
rejected (`OperationError`) [M A]. The gateway signs `hello` with its first
key; the executor derives with whichever of its keys verified that `hello`.

Sealing applies to UDP always (T13), to `tcp://` without TLS, and to a broker
plugin that declares `confidential: false`. Text transports are always TLS or
loopback (WR §5.6's `https` rule, extended to `wss`), so the text encoding has no
sealed form.

#### 4.4.4 What sealing does not give

- **No forward secrecy in the symmetric mode.** The keys derive from the
  long-term secret and two nonces that cross the wire in clear. Anyone who
  records the traffic and later learns the secret can decrypt it [I]. TLS
  1.3, which `tcp+tls://` and `wss://` use, has forward secrecy.
- **Not a reviewed protocol.** It is a small, conventional construction
  (HKDF, AES-GCM with a counter nonce, an anti-replay window), but it has had
  no cryptographic review. §14 records this as a risk, and UDP stays
  `experimental` until it has.

#### 4.4.5 The asymmetric and forward-secret modes

WR §5.6 offers an opt-in asymmetric mode (the gateway holds an Ed25519 private
key, the executor only its public key). On a session transport, `hello` and
`welcome` then carry ephemeral X25519 public keys, each signed with Ed25519
(the executor needs its own keypair, whose public key the gateway pins), and
the frame keys derive from the X25519 shared secret instead of the long-term
key. That gives forward secrecy on every binding, UDP included. X25519 and
Ed25519 both work in Bun's WebCrypto [M A]. It is a feature string
(`session-keys: "x25519-v1"`) and **Phase 4**, not Phase 2: it is a handshake
protocol in its own right, and it should follow the symmetric mode's real
network run, not precede it [D].

### 4.5 The reliability layer

One implementation in the core, used on every session transport [D].

#### 4.5.1 Always: sequence, acknowledgement, duplicate suppression

- Each side numbers its sequenced frames and keeps every sequenced frame in
  an **outbox** until the peer acknowledges it. (On a binary transport class
  `U` frames are unsequenced and never enter it.)
- Acknowledgements ride in every frame's `ack` field. When a side has
  received a sequenced frame and has nothing to send within `ackDelayMs`
  (default 50 ms), it sends a bare `ack`.
- The outbox is bounded by `resumeBufferBytes` (default 4 MiB). A sender
  whose outbox is full stops sending new `R` frames (backpressure into the
  attempt, §4.8); if the peer has acknowledged nothing for
  `livenessTimeoutMs`, the session is dead (§5).

#### 4.5.2 On a reliable transport: resumption

When a session's connection drops without a `close`, the dialler reconnects
(`reconnect()`, when `resumable`) and sends `hello` with
`resume: { sid, received: <last seq delivered> }`. The dialled side answers
`welcome` with `resumed: true` and **replays its outbox above `received`**;
the dialler does the same from the `received` in `welcome`. Text frames are
replayed byte for byte, class `U` included, so the sequence has no holes; the
receiver discards a replayed `heartbeat` or `progress` that is older than
what it has. Binary frames of class `U` were never sequenced, so they are not
in the outbox; sequenced binary frames are replayed with new `pn`s and MACs.

`resumed: false` (the peer restarted, the outbox overflowed, the resume
window passed) is not a failure of the attempts. The gateway sends `status`
for every attempt in flight and settles from `status-result`: `done` settles
with the retained outcome, `running` re-attaches (the executor now reports on
the new session), `unknown` enters the lost-attempt path (§4.7). An executor
that does not advertise `attempt-status` makes every in-flight attempt
`unknown`.

`resumeWindowMs` (default 30,000) bounds how long the gateway tries to
resume before it gives up on the session.

#### 4.5.3 On an unreliable transport: retransmission, window, fragmentation

Enabled when the transport declares `reliable: false`, `ordered: false` or
`flowControl: false` [D]:

- **Retransmission.** A sequenced fragment unacknowledged after the
  retransmission timeout is sent again with a new `pn`. The timeout follows
  RFC 6298's shape [I, not re-read today]: SRTT and RTTVAR from acknowledged
  frames that were not retransmitted, initial 1 s, floor 200 ms, ceiling
  10 s, doubling on each retry. After `maxRetransmits` (default 8) or
  `livenessTimeoutMs` without progress, the session is dead.
- **Selective acknowledgement.** `ack` plus the 64-bit `sack` bitmap; a
  sender retransmits only what is neither acknowledged nor selectively
  acknowledged.
- **Window.** At most `window` unacknowledged sequenced fragments in flight
  (default 32, about 38 KB at 1,200-byte datagrams, a sixth of Linux's
  default 212,992-byte receive buffer [M bun, "Environment"]). The receiver
  advertises its window in `welcome`; the sender halves its window on a
  detected loss and grows it by one per round trip, up to the advertised
  value (additive increase, multiplicative decrease) [D]. This exists
  because UDP has no flow control, and a burst the receiver cannot drain is
  simply lost: 99.5% in the same-process spike [M bun §5.4].
- **Fragmentation.** A message whose frame would exceed `maxFrameBytes` is
  cut into fragments before sealing, each its own frame with `fragIndex` and
  `fragCount`, so each fragment is authenticated and a forged fragment cannot
  poison reassembly [D]. A message is delivered once all its fragments are
  in; an incomplete message is dropped after `livenessTimeoutMs`.
  `maxMessageBytes` on UDP defaults to 64 KiB (56 fragments) and is capped at
  256 KiB: larger payloads belong in object storage (WR §5.10).
- **Ordering.** Sequenced messages are delivered in `seq` order, so the
  protocol above sees an ordered stream. Class `U` messages (`heartbeat`,
  `ping`, `pong`, `progress`) are sent unsequenced and delivered on arrival;
  `progress` uses `pseq` to drop a stale value.

§7.8 fixes which messages ride bare datagrams and which require this layer.

### 4.6 The session state machine (gateway side)

| From | Event | To |
|---|---|---|
| `closed` | `open()` resolves, or `listen()` yields a connection | `handshaking` |
| `handshaking` | `welcome` verified, protocol agreed | `proving` |
| `handshaking` | bad MAC, `hello` refused, `UNSUPPORTED_PROTOCOL`, an `auth`/`misconfigured` error | `closed`; the breaker opens (§4.10) |
| `proving` | the canary passes | `ready` |
| `proving` | the canary fails or times out | `closed`; counts toward the breaker |
| `ready` | `close` with `drain: true` | `draining` |
| `draining` | every in-flight attempt settled | `closed` |
| `ready` | nothing verified for `livenessTimeoutMs`, or the connection dropped without `close` | `suspect` |
| `suspect` | `reconnect()` succeeds and `hello` asks to resume | `resuming` |
| `suspect` | not `resumable`, or no reconnect within `resumeWindowMs` | `lost` |
| `resuming` | `resumed: true`; both outboxes replayed | `ready` |
| `resuming` | `resumed: false` | `proving` as a new session; its in-flight attempts are settled or re-attached by `status` (§4.5.2) |
| `lost` | its in-flight attempts enter §4.7's lost path; the pool opens a replacement | `closed` |

- **`proving`** is new: after the handshake and before the first real
  invoke, the gateway runs the functional canary (§5.3). A session that has
  not proved itself takes no work. On a pool of sessions (§8.2), each one
  proves itself.
- **`draining`**: the executor sent `close` with `drain: true`. No new
  invokes; in-flight attempts finish on this session. A dialling executor
  opens its replacement session first (§7.6).
- **`lost`**: attempts in flight go through §4.7's lost path; the breaker
  counts a transport failure; the pool opens a new session.

### 4.7 The attempt state machine (gateway side)

```
 claimed ─▶ sent ─┬─ accepted ─▶ running ─┬─ result/fail (fence matches) ─▶ settled
                  │                        ├─ deadline passes ─▶ cancel sent ─▶ failed (timeout, as today)
                  │                        ├─ lock lost (#heartbeat) ─▶ cancel sent ─▶ abandoned
                  │                        └─ attempt silent > attemptSilenceMs, or session lost
                  │                               ─▶ reattaching ─┬─ status: running ─▶ running
                  │                                               ├─ status: done ─▶ settled from retained outcome
                  │                                               └─ unknown / no answer ─▶ lost
                  │                                                     ─▶ failed: RemoteAttemptLostError
                  │                                                        (retryable; counts as an attempt)
                  ├─ rejected ─▶ released (not an attempt; endpoint backs off)
                  └─ no accepted within acceptTimeoutMs ─▶ cancel ─▶ transport retry
                                                          (same idempotencyKey, delivery + 1;
                                                           attemptsMade unchanged)
```

**Why a lost attempt counts as an attempt** [D, T8]. The executor accepted
it and may have done part of the work: that is what a crashed child process
is today, and a crashed child process's attempt counts. It is retryable, so a
job with attempts left runs again, with a new claim and therefore a larger
fence. **Why an unaccepted one does not**: nothing proved it started, and the
same idempotency key lets an executor that did start it answer from its
cache, which is WR §4.2.8's `transportRetry` rule.

**The executor side** is smaller: `received → verified → rejected |
accepted → running → done`. A `done` attempt's outcome is **retained until
the gateway acknowledges the frame that carried it**, or for
`resultRetentionMs` (default 10 min) when the session is gone, so a `status`
after an unresumable reconnect can answer `done` instead of `unknown` [D]. An
executor also keeps running an accepted attempt if the gateway disappears,
until `deadlineAt` or a `cancel`; aborting on disconnect would turn every
network blip into a lost attempt.

### 4.8 Backpressure that never burns an attempt

WR §5.9's three layers stand: `maxBatch`, `capacity`, and `rejected`/`429`.
Sessions add two more [D]:

- **Capacity on every heartbeat and pong.** The gateway narrows its in-flight
  count for that session toward `capacity.max - capacity.inFlight`, and stops
  sending to a session whose `accepting` is `false`.
- **Byte backpressure from the transport.** When `bufferedBytes()` passes the
  high-water mark (default 1 MiB) or the outbox is full, the gateway stops
  sending invokes on that session; attempts already running are unaffected.
  A transport never drops a frame silently: `send()` rejects instead.

`rejected` with `BUSY` or `DRAINING`, and a `send()` that rejected before the
executor could have seen the invoke, release the job without moving
`attemptsMade`, exactly as WR §5.5's `rejected` row.

### 4.9 Idempotency, fencing, and lost responses

WR §5.8 is reused unchanged: the per-job `idempotencyKey`, the monotonic
`fence`, and the gateway's settle conditional on its lock token. What the
bindings add is **re-attachment before retry**, so that a response lost to an
intermediary does not become a second run [D]:

1. The attempt's channel dies: a stream cut by Azure's 230 s limit or a
   Cloud Run 504 [V az-func-http, gcr-timeout], a WebSocket closed by an idle
   timer, a UDP flow re-routed.
2. The gateway still holds the lease, so it has time. It re-attaches:
   session transports resume (§4.5.2); `http-stream` re-attaches with
   `Last-Event-ID` if the executor advertises `stream-resume` (§7.4), else
   re-POSTs the **same** invoke (same `idempotencyKey`, `delivery + 1`).
3. The executor recognises the key. With a store: a finished attempt is
   answered from the retained outcome; a running one on the same instance is
   joined (`accepted` with `duplicate: true`); a running one on another
   instance is `rejected` `DUPLICATE_RUNNING`, and the gateway waits and asks
   again.
4. Without a store, or on another instance of a store-less deployment, the
   handler runs again.

**What that guarantees, stated plainly.** No job is settled twice and no
stale executor settles over a newer attempt: the lock token and the fence
ensure that on every binding. **Whether the handler body runs twice after a
lost response depends on the executor having a store.** On the three
"caller fails, work continues" platforms, the selection guide (§11.2) tells
the user to configure one, and the user guide repeats WR §5.8's sentence: *a
push-mode handler must be idempotent.*

### 4.10 Errors and close codes

WR §5.3's two error shapes stay: a transport error is a `ProblemDto`; a job
error is a `SerializedError` inside `fail`. What each maps to [D]:

| Condition | How it arrives | Breaker | Attempt |
|---|---|---|---|
| MAC or AEAD failure on a frame | dropped and counted; three in a row → `close` `SIGNATURE_INVALID` | trips at once (WR §5.6's 401 rule) | not burned |
| `hello` refused: wrong key, `t` outside the window, replayed nonce | `close` `SIGNATURE_*` / `REPLAYED`, or HTTP 401 | trips at once | — |
| `UNSUPPORTED_PROTOCOL` | `close` with `supported`, or HTTP 400 | fallback, then trips | — |
| `UNSUPPORTED_OP` | `problem`, non-fatal | no | per WR §5.3, capability recorded absent |
| `SEQUENCE_GAP`, `FRAME_TOO_LARGE`, malformed frame | `close`, then resume | counts | not burned unless the attempt is then lost |
| Liveness timeout | local decision | counts | §4.7 lost path |
| Executor draining | `close` `DRAINING`, `drain: true` | no | in-flight continue |
| Executor overloaded | `rejected` `BUSY`, `pong.capacity` | no | not burned |

WebSocket close codes carry the same names in the private range [D]:
`4400` protocol error, `4401` signature, `4403` forbidden (a reverse
executor this gateway does not accept), `4408` liveness timeout, `4409`
superseded by a resumed connection, `4413` frame too large, `4429` busy,
`4503` draining. Close codes arrive intact [M bun §3.9]. TCP and UDP send a
`close` frame before shutting down, and a TCP half-close uses `shutdown()`
with no argument [M bun §4.5].

### 4.11 Cancellation

- **Session bindings**: a `cancel` frame. The executor aborts the handler's
  `signal`. The gateway does **not** wait for it (WR §5.10): it fails or
  abandons the attempt at once, and ignores and acknowledges any `result` or
  `fail` that arrives for it afterwards.
- **`http-stream`**: the gateway aborts its `fetch`, which reaches the
  executor as `req.signal` [M bun §1.6], and also POSTs `cancel` (WR §5.10),
  because an intermediary may not propagate the abort [I].
- **`http` unary**: abort, plus a POST `cancel` when the executor advertises
  it.

### 4.12 Clocks and deadlines

WR §5.11 stands: the gateway's `now` and `deadlineAt` are authoritative, and
`hello`'s `t` is checked against the replay window in both directions. Two
additions [D]:

- Every message's `at` is the sender's clock, **informative only**: the
  gateway uses it to measure buffering (§5.7) and skew, never to decide.
- **Every deadline in this document is enforced with an application timer**
  (`setTimeout`, `AbortSignal.timeout()`), never with `idleTimeout`,
  `socket.timeout()` or `fetch`'s `timeout` (T6). Built-in timers are set as
  backstops only: `Bun.serve`'s `idleTimeout` to 255 or `server.timeout(req,
  0)` for a streamed response; the WS handler's `idleTimeout` above
  `livenessTimeoutMs`.

### 4.13 What changes in `worker-runtimes.md` §5

| WR section | Change |
|---|---|
| WR §5.2 Transport | Becomes a summary that points here. HTTP remains the default and the only binding every platform supports. |
| WR §5.3 Endpoints | Unchanged for the exchange shape, plus two SHOULD operations, `health` and `status`. Session transports use the messages of §4.1. |
| WR §5.4 Handshake | Unchanged for HTTP (`GET`). On a session transport the same document arrives in `welcome`. New feature strings (§4 above). |
| WR §5.5 Invoke | Unchanged body; adds `kind`. Per-job `accepted`/`rejected` on streaming bindings; outcomes become `result`/`fail` messages whose bodies are WR §5.5's outcome objects. |
| WR §5.6 Signing | Unchanged for the exchange shape's request and unary response. **Adds the per-frame MAC** (§4.4.1) and **sealing** (§4.4.3). The `https`-only rule extends to `wss`; `tcp://` and `udp://` are allowed because their frames are sealed. |
| WR §5.7 State machine | Refined by §4.6 and §4.7 here; the job's own states are unchanged: **push mode still adds no job states and no driver methods**. |
| WR §5.8 Idempotency and fencing | Unchanged; adds re-attachment before retry (§4.9) and outcome retention. |
| WR §5.9 Leases | Unchanged: option A. Remote heartbeats are liveness evidence, never lease renewal (§5.6). |
| WR §5.10 Cancellation, progress | Cancellation per binding (§4.11). **Streamed frames are now verified one by one**, which replaces "progress frames are applied optimistically and the final result only after verification". |
| WR §5.11 Clock skew | Unchanged, plus §4.12. |
| WR §5.12 Conformance | Gains per-binding groups (§10). |

---

## 5. The health model

The user's requirement is that health checks and progress "ensure that the
worker built for that protocol is actually working". That is three different
questions, and a ping answers only the first [D].

### 5.1 Three questions, on every binding

| Question | Signal | What it proves | What it does not |
|---|---|---|---|
| **Liveness**: is the executor reachable and responsive? | `ping` → `pong` when a direction has been quiet for `keepaliveMs`; the executor's `heartbeat` every `heartbeatMs` | The path is open in both directions, the executor's event loop runs, and it can verify and sign | That a handler can run |
| **Readiness and capacity**: can it take work, and how much? | `capacity` on every `heartbeat`, `pong` and `welcome`; the `health` probe with the author's checks | It is accepting, how many slots are free, and that its own dependencies (a model loaded, a GPU, a database of its own) say they are ready | That the dispatch path works end to end |
| **Function**: does the handler path actually work? | The **canary**, a synthetic `invoke` of the reserved job name `bun-jobs:canary` (§5.3) | Verify → decode → dispatch → a handler → `progress` → `log` → `result` → sign → the transport, in both directions, on this binding, with timings | That a *specific* user handler works (that is what attempts and their outcomes show) |

### 5.2 Timing, and the rules it follows

| Setting | Default | Bound | Why |
|---|---|---|---|
| `keepaliveMs` | 10,000 | ≤ 25,000 on `udp` (`ConfigError` above); ≤ 50,000 elsewhere; clamped below a transport's declared `idleTimeoutMs` | Under the 30 s idle clocks of the GCP classic LB, Linux UDP conntrack and Global Accelerator UDP, and well under Heroku's 55 s and ALB's 60 s [V gcp-lb-timeouts, linux-ct, aws-ga, heroku-routing, aws-alb-attrs] |
| `heartbeatMs` (executor) | the gateway's `keepaliveMs`, sent in `hello`; the executor may answer a larger value in `welcome` if it cannot keep up | ≥ 1,000 | One heartbeat per session per interval covers every running attempt, so its cost does not grow with concurrency |
| `livenessTimeoutMs` | 25,000 (2.5 × keepalive) | ≥ 2 × keepalive | Two missed intervals, Inngest Connect's rule [V-prior prior-art-survey §Inngest], plus margin |
| `attemptSilenceMs` | 30,000 (3 × heartbeat) | ≥ 2 × heartbeat | An attempt missing from `heartbeat.running` for this long enters the lost path (§4.7) |
| `acceptTimeoutMs` | 5,000 | — | "I have it" is separate from "I'm done", as Inngest's `WORKER_REQUEST_ACK` [V-prior] |
| `resumeWindowMs` | 30,000 | — | Reconnect and resume before giving up on a session |
| `canaryIntervalMs` | 300,000 | `0` disables the periodic canary; it still runs at session open and as the breaker's half-open probe | Cost on per-invocation platforms (§15 Q-T7) |
| `canaryTimeoutMs` | 10,000 | — | A canary is small by construction |

The lease is independent of all of these. The gateway renews it every
`heartbeatInterval` (`max(250, lockDuration / 3)`, 10 s by default) for as long
as the attempt is in flight (`BunQueueWorker.ts:961-968`, `:2228-2232`) [S],
whatever the executor does. A remote heartbeat is **evidence that the remote
attempt is alive**, never a lease renewal (WR §5.9 option A stands). That is why
heartbeat loss can fail an attempt fast (§4.7) without any risk of the lease
lapsing first.

Every timer above is an application timer (T6). The executor sends its
heartbeat from a timer that a CPU-bound handler blocks, which is correct (a
blocked event loop cannot cancel, report or answer) but surprising; §14 has
the risk and its mitigation.

### 5.3 The functional canary

A canary is an ordinary `invoke` whose single job has the reserved name
`bun-jobs:canary`, `synthetic: true` and
`data: { nonce, steps: 3, stepMs: 100 }` [D]:

1. The gateway claims nothing and writes nothing to the driver. The canary's
   `idempotencyKey` is `canary:<sid>:<n>`, and its `fence` is the session's
   own.
2. The executor's built-in canary handler (part of the protocol core, so every
   first-party executor has it, and `PROTOCOL.md` requires it of any other
   executor that advertises `canary`) emits `accepted`, then `steps`
   `progress` frames `stepMs` apart, one `log` line, runs the author's
   optional `health.check()`, and answers `result` with `{ nonce, checks }`.
3. The gateway checks: the nonce echoes; every frame verified; `progress`
   arrived in order and **spread over time** (the buffering check, §5.7);
   total latency under `canaryTimeoutMs`; every author check `pass`.

It runs **at session open** (the `proving` state, §4.6: a session that has not
proved itself takes no work), **every `canaryIntervalMs`**, and **as the
breaker's half-open probe**. On the `http` binding it is a POST like any
invoke; on a stateless platform it proves the path to *an* instance, which is
what the gateway will use next.

An executor that does not advertise `canary` is proved by `health` alone, and
the Workers page says "not functionally probed".

### 5.4 Thresholds, the breaker, and what the Workers page shows

The circuit breaker of §5.7 and §10.2 of `worker-runtimes.md` gains health
inputs [D]:

| Input | Effect |
|---|---|
| Canary fails at session open | The session never becomes `ready`; counts as a transport failure |
| Two consecutive periodic canaries fail, or one times out | Breaker opens for the endpoint; running attempts continue |
| `livenessTimeoutMs` passes | The session is `suspect`, then resumes or is `lost` (§4.6); counts |
| `health-result.ok: false` | The session stops taking new work (`accepting: false` behaviour) until a later `health` passes; does not count |
| MAC failure, a refused `hello`, `auth`/`misconfigured` from the facet | Breaker opens at once (§4.10) |
| Half-open | One canary; pass → closed, fail → open again with backoff |

The endpoint's health is one of four states, each with a reason:

| State | When |
|---|---|
| `healthy` | At least one session `ready`, the last canary passed, liveness within bounds |
| `degraded` | Working, with a caveat: the path buffers streams and was downgraded to unary (§5.7); the canary is slower than `canaryTimeoutMs / 2`; capacity is zero; the transport cannot report during attempts (`streaming: false`) |
| `unhealthy` | The breaker is open |
| `unknown` | Never probed yet, or the canary is not supported and `health` has not answered |

These, with the evidence behind them, go on `WorkerTargetInfo.remote.health`
(§12).

### 5.5 Coexisting with the platform's own health checks

Platforms check health with the probes *they* support, and several cannot see
this protocol at all [V platform §4.3]:

- ALB: "Health checks do not support WebSockets" [V aws-alb-hc];
- NLB: UDP and QUIC targets are checked with TCP, HTTP or HTTPS
  [V aws-nlb-hc];
- AKS: "For cluster UDP services, no health probes" [V az-aks-lb];
- ACA probes are TCP or HTTP only; ACI exec or httpGet only; Cloud Run
  liveness HTTP or gRPC [V az-aca-probes, az-aci-api, gcr-hc].

So **every executor serves plain HTTP/1.1 on a port the platform can probe**
[D], whatever its job transport:

| Path | Answers | Meaning | Auth |
|---|---|---|---|
| `GET /healthz` | `200` with `{"ok":true}`, or `503` | The process is up and its event loop answers | none, and it discloses nothing |
| `GET /readyz` | `200` or `503` with `{"ready":false,"reason":"draining"}` | Accepting work: not draining, capacity above zero, the author's readiness checks pass; for a **reversed** executor, *connected to at least one gateway*, which is Inngest Connect's rule for its `readinessProbe` [V inngest-connect] | none |

For `http`/`http-stream` executors these are two more routes on the same
server (an executor mounted at a path serves them under that path too). For
`ws` executors they are routes on the same `Bun.serve` that upgrades the
socket. For `tcp` and `udp` executors the runtime kit starts a small
`Bun.serve` on `healthPort`: for `udp` it defaults to the job's port number on
TCP, which is what an NLB check of a UDP target hits; for `tcp` it has no
default, because the job port speaks the binary protocol, and a platform whose
check is only a TCP connect can point at the job port itself [D].

**How the two coexist.** The platform's check decides *routing and restarts on
the platform*; the protocol's heartbeat and canary decide *whether bun-jobs
sends work*. They answer different questions and neither replaces the other.
Where the platform checks only at deploy (Railway, Fly's top-level checks,
Cloudflare Containers' `pingEndpoint`) [V railway-hc, fly-hc, cf-ctr-class],
the protocol heartbeat is the only continuous signal, which is the platform
file's conclusion [V platform §4.3]. The execute facet's optional `probe()`
(`compute-provider-plugins.md` §8.2) lets the gateway read `/healthz` itself
for the Workers page, never to route.

### 5.6 Heartbeats during an attempt, and the lease

- The executor lists every running attempt in `heartbeat.running`, each
  heartbeat. An attempt missing from it for `attemptSilenceMs`, or a session
  lost with it in flight, enters the lost path (§4.7).
- A handler may call `ctx.heartbeat()` to send a heartbeat now (coalesced to
  at most one per 250 ms), as a sign of life before a long blocking step.
- The gateway's own lease renewal is untouched: `#heartbeat()` keeps calling
  `extendJobLock` on its timer, and a lost lock aborts the attempt and sends
  `cancel` (`BunQueueWorker.ts:3429-3458`) [S]. The worker still holds the
  lease for the whole attempt, on every binding.
- **What fail-fast buys**, with the defaults: an executor that freezes
  (SIGSTOP, a hung VM, a silent partition) is detected in 25–30 s, instead of
  at the attempt's timeout (the target's `timeout`, WR §4.2.8, or the job's
  own), which for a long job is minutes or hours. A process that dies
  outright on the same host is detected at once on TCP and WebSocket, because
  the kernel sends a FIN (`end` then `close` at 502 ms after SIGKILL)
  [M bun §4.8]; a partition sends nothing and is found only by the heartbeat
  [U, needs a real network].

### 5.7 Detecting a buffering path

A buffering proxy makes a live stream look dead: nothing arrives until the
end, so heartbeats "stop" [V platform §4.1]. The platform file's design
consequence is that the handshake must tell "buffered" from "dead" [I there].
This design does it with the canary [D]:

- The canary's three `progress` frames are 100 ms apart by their `at`
  stamps. If they **arrive** within 20 ms of each other and of the `result`,
  something held them: the path buffers.
- A path that buffers is marked `streaming: buffered` for that endpoint. The
  gateway then stops relying on heartbeats for attempts on it (it uses the
  request's timeout, as unary does), asks for a unary response
  (`accept: application/json`) and shows the endpoint as `degraded` with the
  reason "a proxy between the worker and the executor buffers streamed
  responses". It re-probes at every canary, so fixing the proxy clears it.
- A path that buffers in blocks (App Engine flex's 64 KB [V gae-flex]) also
  holds three small frames, and is caught the same way. Heroku's 1 MB router
  buffer is a flow-control window, not a hold [V heroku-routing], and passes.
- Executors always send the headers that switch buffering off where they
  can: `Content-Type: text/event-stream` (Cloudflare Tunnel's condition
  [V cf-tunnel]), `X-Accel-Buffering: no` (nginx, App Engine [V nginx-proxy,
  gae-flex]) and `Cache-Control: no-cache, no-transform`.

Whether Cloud Run's front end, ALB, ACA's Envoy or CloudFront buffer is
[U] [V platform §5 item 2]. The probe is what makes that unknown safe.

---

## 6. Progress, logs and heartbeats on every transport

| Binding | Progress and logs during the attempt | Heartbeats during the attempt | Health |
|---|---|---|---|
| `http` (unary) | **None until the end**: returned in the outcome (WR §5.5's `logs`, `progress`) | **None**: liveness during an attempt is the request's own timeout | canary as a POST; `/healthz` |
| `http-stream` | On the response, as SSE-framed text frames, verified one by one | `heartbeat` frames on the response | canary; buffering probe; `/healthz` |
| `sse` | Same as `http-stream`; re-attachable with `Last-Event-ID` | Same | Same |
| `ws`, `ws-reverse` | Frames on the socket | `heartbeat` frames; `ping`/`pong` both ways | canary; `health`; `/healthz` on the same port |
| `tcp` | Frames on the socket | Same | Same; `/healthz` on `healthPort` |
| `udp` | `log` sequenced; `progress` on bare datagrams, latest wins | `heartbeat`, `ping`, `pong` on bare datagrams | Same; `/healthz` over TCP |
| plugin (broker) | Frames on the broker | Same | Same, plus the broker's own |

**The choice for request/response HTTP, justified.** Three ways exist to get
progress out of a request/response exchange [D]:

1. **A streamed response** (`http-stream`). Chosen as the default: the
   progress rides the very request the gateway already holds open, needs no
   inbound surface on the gateway, and works on almost every platform
   [V platform §1.1].
2. **A callback** from the executor to the gateway. Rejected, as WR §10.6
   rejected it: an inbound write surface on the internet, a second auth path,
   and a reaper for callbacks that never come.
3. **Polling** with `status` over a second request. Kept only as a
   capability, not as a way to report progress: on a multi-instance platform
   the second request reaches a different instance, which does not know the
   attempt unless the executor has a shared store [I].

So on a strictly unary path (API Gateway HTTP API, ALB → Lambda, a buffered
Function URL [V aws-apigw-stream, aws-alb-lambda, aws-furl-modes]) there is no
in-attempt liveness at all, and the design says so rather than faking it: the
endpoint is `degraded` with the reason "this transport cannot report during an
attempt", liveness is the request timeout, and progress arrives with the
outcome.

---

## 7. The bindings

### 7.1 What every binding specifies

Each subsection below fills the same checklist, and so does each
`PROTOCOL.md` appendix (§11.5): **establishment and direction; framing and
message boundaries; signing and replay; ordering and reliability; maximum
message size; keepalive and idle timeouts; backpressure; reconnection and
resumption; TLS; the health endpoint; where it is hostable; the Bun behaviour
it must handle.**

### 7.2 HTTP request/response (`http`)

| Aspect | Specification |
|---|---|
| Establishment | The gateway POSTs to the endpoint URL; `GET` is the WR §5.4 handshake. Exchange shape, forward |
| Framing | One request body, one response body: WR §5.3's envelopes, unchanged |
| Signing | WR §5.6 unchanged: HMAC over `t "." rawBody`, both directions |
| Ordering, reliability | One exchange; a lost response is re-attached by re-POSTing the same invoke (§4.9) |
| Max message | The handshake's `maxBodyBytes` (default 1 MiB), reconciled with the facet's `maxMessageBytes` |
| Keepalive, idle | None within an exchange. Keep-alive connections between exchanges [M bun §1.8]. The executor sets `idleTimeout: 255`, or `server.timeout(req, 0)`, because a long job is a silent request [M bun §1.7] |
| Backpressure | `rejected`, HTTP 429 with `Retry-After`, `capacity` (WR §5.9) |
| Reconnection | Not applicable; re-POST with `delivery + 1` |
| TLS | `https` required except loopback (WR §5.6) |
| Health | Canary as a POST; `/healthz` and `/readyz` on the same server |
| Hostable | Wherever there is inbound HTTP [V platform §1.1] |
| Bun | `fetch`'s `timeout` is an idle timer with an ~8 s floor, so the invoke's deadline is `AbortSignal.timeout(deadline)` [M bun §1.11, §1.6]. `fetch` queues above 256 in flight (`BUN_CONFIG_MAX_HTTP_REQUESTS`) [V bun §1.12], so `maxInFlight` above 256 needs that raised, and the docs say so |

### 7.3 HTTP with a streamed response (`http-stream`)

The default for an `https://` endpoint whose handshake advertises
`progress-stream`.

| Aspect | Specification |
|---|---|
| Establishment | POST invoke with `accept: text/event-stream, application/x-ndjson;q=0.5, application/json;q=0.1`. Exchange shape, forward |
| Framing | **SSE framing by default**: each text frame (§4.3.1) is one event, `id: <seq>`, `event: <op>`, `data: <the whole frame line>`. NDJSON (one text frame per line) is accepted for executors that cannot send SSE; Cloudflare Tunnel buffers anything that is not `text/event-stream` [V cf-tunnel], so NDJSON is the fallback, not the default. The request stays WR §5.6-signed |
| First bytes | The executor writes `: open` and the `accepted` frames **at once**: `Bun.serve` sends no complete header block until the first body chunk, and `fetch()` does not resolve until then [M bun §1.4] |
| Signing | Per-frame MAC with `sid` = the invoke `id`, `dir` = `e`, `seq` from 1 (§4.4.1). The gateway never reuses an invoke `id`, so a captured stream cannot be replayed into another request. Each frame is verified before it is applied |
| Ordering, reliability | Ordered and reliable within the stream. A stream that ends without a terminal frame for a job leaves that job `unknown` (WR §5.5); the gateway re-attaches (§4.9) |
| End | After every job's `result`/`fail`, a `close` frame with code `COMPLETE`, then the response ends |
| Max message | Per frame, `maxMessageBytes`; the stream as a whole is unbounded, but a platform may cap it (Lambda 200 MB and 2 MBps after 6 MB; Netlify 20 MB [V aws-furl-modes, netlify-cfg]); `stringifyBounded` bounds each `log` and `result` (`shared/json.ts:49`) [S] |
| Keepalive, idle | `heartbeat` frames every `heartbeatMs` are the keepalive. The executor calls `server.timeout(req, 0)` [M bun §1.7, §2.6] |
| Backpressure | Bun propagates it end to end: a client that stops reading pulls only ~5 MiB [M bun §1.9]. The executor's writer awaits the stream's readiness rather than buffering without bound |
| Reconnection | Re-attach with `Last-Event-ID` when `stream-resume` is advertised (§7.4), else re-POST (§4.9) |
| TLS | As `http` |
| Health | Canary with the buffering probe (§5.7); `/healthz` |
| Hostable | Near universal, with caveats: `RESPONSE_STREAM` on Lambda URLs (not in a VPC), `STREAM` on API GW REST (15 min, 5 min idle, edge 30 s), Netlify 60 s; not API GW HTTP API or ALB → Lambda [V platform §1.1] |

### 7.4 SSE (`sse`)

SSE is two things in this design, and they land at different times [D].

**(a) The stream framing of `http-stream` (2a).** Everything above. Bun has no
`EventSource` [M bun §2.1], so the gateway parses the stream itself over
`fetch` and `TextDecoderStream`; a hand-written parser handled multi-line
`data`, `event`, `id`, `retry` and events split across writes [M bun §2.4].
It is ~40 lines, lives in `lib/remote/protocol/sse.ts` [D], and never touches
the global `EventSource`, which typechecks and throws.

**(b) Re-attachment with `Last-Event-ID` (2a, feature `stream-resume`).** When
a stream drops mid-attempt, the gateway sends `GET <url>?attempt=<job>:<attempt>`,
WR §5.6-signed, with `Last-Event-ID: <last seq>`. An executor that still has the
attempt (a long-lived process, or a shared store of retained frames) answers
the same stream from `seq + 1`. Reconnect and `Last-Event-ID` worked in the
spike, and the `retry:` field was honoured [M bun §2.4]. On a stateless
multi-instance platform the `GET` reaches another instance, which answers
`404 ATTEMPT_UNKNOWN`, and the gateway falls back to re-POSTing the invoke
(§4.9). Nothing depends on affinity.

**(c) Session mode (2d, binding id `sse`).** One long-lived `GET` event stream
per session carries every `e→g` frame for many attempts; `g→e` frames are
separate signed POSTs carrying the `sid`. It gives a session transport over
plain HTTP/1.1 where WebSocket is not available or is stripped, with
`Last-Event-ID` resumption for free.

| Aspect | Session mode |
|---|---|
| Establishment | `GET` with `accept: text/event-stream`, WR §5.6-signed, answered with a `welcome` event; `hello` rides the `GET`'s query and headers |
| Framing | `e→g`: SSE events carrying text frames. `g→e`: POST bodies, each one text frame (or several, one per line) |
| Where it works | **Only where the POSTs reach the process holding the stream**: one long-lived instance, or sticky routing that is guaranteed rather than best effort. Cloud Run's affinity is best effort [V gcr-ws]; a POST that reaches another instance is answered `409 SESSION_ELSEWHERE`, and the gateway closes the session and falls back to `http-stream` |
| Why not request-body streaming | A long-lived request body would carry `g→e` frames on one connection, but `maxRequestBodySize` caps the *total* of a streamed upload (128 MiB default) [M bun §1.10], and proxies that buffer request bodies break full duplex [U bun §1.2] |
| Keepalive | `heartbeat` events; `ping` as POSTs |
| Hostable | Long-lived single-instance HTTP hosts behind HTTP-only proxies [I] |

### 7.5 WebSocket, forward (`ws`)

| Aspect | Specification |
|---|---|
| Establishment | The gateway opens `wss://…` with subprotocol `bun-jobs.v1` and a WR §5.6-signed upgrade `GET` (so the unsigned public handshake stays available on plain `GET`). The first frame is `hello`. Session shape, forward |
| Framing | One WebSocket **text** message per text frame. Binary messages are refused with `4400` |
| Signing | Per-frame MAC (§4.4.1) |
| Ordering, reliability | Ordered and reliable per connection; across reconnects, the reliability layer's resume (§4.5.2) |
| Max message | `welcome.maxMessageBytes`, at or below the executor's `maxPayloadLength`. The sender refuses an oversize message itself (`PayloadTooLargeError`), because Bun closes an oversize frame with `1006`, not `1009` [M bun §3.5] |
| Keepalive, idle | Application `ping`/`heartbeat` every 10 s. Bun's `sendPings` stays on as a backstop only: a paused client is closed by the server but **still shows the socket as open** [M bun §3.11], so the gateway (the client here) runs its own liveness timer |
| Backpressure, executor (server) side | Every `send()` result is checked: bytes sent, `-1` queued, **`0` dropped** [M bun §3.6]. `0` is treated as a dead session (close `4429`, resume), never ignored. `backpressureLimit` is set, `closeOnBackpressureLimit` is `false`, and the executor stops producing frames while `getBufferedAmount()` is above `maxBufferedBytes`, resuming on `drain`, as the management API's session does (`api/ws/session.ts:53-60`, `:1443`) [S] |
| Backpressure, gateway (client) side | The client's `bufferedAmount` is unbounded [M bun §3.8], so the transport refuses `send()` above its high-water mark and polls `bufferedAmount` to learn when it has drained. There is no client send status (`send()` returns `undefined` [M bun §3.4]) |
| Reconnection | No automatic reconnection exists [M bun §3.10]; the transport's `reconnect()` dials again with backoff and jitter, and the core resumes |
| TLS | `wss` required except loopback; a pinned `tls.ca` and custom headers work on the client [M bun §3.12]. `ws+unix://` for a local executor [M bun §3.13] |
| Health | Canary, `health`, and `/healthz` on the same `Bun.serve` |
| Hostable | ALB, NLB, Cloud Run (≤60 min per connection), GCP ALB, ACA, App Service (setting on), AKS via Gateway API, CF Workers/DO/Containers (via `fetch`), Railway (no limit), Render (closed on instance replacement), Heroku (55 s idle), Vercel (beta, ≤ max duration), Deno Deploy, Lambda MicroVMs, Kubernetes. **Not** Lambda Function URLs, ALB → Lambda or API GW HTTP/REST; API GW's WebSocket API terminates the socket itself, so the executor never holds it [V platform §1.1, aws-apigw-ws-overview] |
| Traps | The classic GCP ALB closes an **active** WebSocket at the 30 s backend timeout, so a heartbeat cannot save it [V gcp-lb-timeouts]; Application Gateway applies its 20 s request timeout to the WebSocket session [V az-appgw-ws]; Vercel keeps existing sockets on the old deployment [V vercel-ws]. The selection guide names each |
| Bun, other | The client's default `binaryType` delivers a `Buffer` [M bun §3.1] (irrelevant for text frames); `ping`/`pong` events are untyped in bun-types [V bun §3.3]; WebSockets over HTTP/2 and HTTP/3 are unsupported [V bun §3.14] |

### 7.6 WebSocket, reversed (`ws-reverse`)

The executor dials out to the gateway, and the gateway pushes invokes down
the socket the executor opened [D]. This is the practical way to reach a
long-running executor with no inbound path: a Cloud Run worker pool reached
from outside its VPC, a Render background worker, an ACA app or job with
ingress off, an ECS task with no load balancer, anything behind NAT
[V platform §1.2].

| Aspect | Specification |
|---|---|
| Establishment | The **gateway listens** (`listen: "wss://0.0.0.0:8443/bun-jobs"` on the remote worker). Each executor dials it, sends `hello` with `role: "executor"`, its `name`, and its executor id; the gateway answers `welcome`. Session shape, `direction: "reverse"`; the facet implements `listen()` |
| Which gateway | Any gateway of the queue will do, because every worker of a queue claims from the same queue. So a pool of remote workers sits behind one DNS name or load balancer, and each executor connection lands on one of them. **No relay is needed for this** [I]. A gateway claims only as much as its connected executors advertise (`sum(capacity.max - inFlight)`), so a gateway with no executors claims nothing |
| Framing, signing, ordering, size, backpressure | As `ws` (§7.5), with the roles of client and server swapped: the gateway is now the Bun server and must check `send()` results; the executor is the client with the unbounded `bufferedAmount` |
| Authentication | The executor's `hello` is MAC'd with the shared secret, and the gateway also accepts only executor names it is configured for (`4403` otherwise). An executor can deliver outcomes only for attempts pushed to it on that session with a matching fence, so the WR §10.6 hazard ("anyone who learns a job id can mark it complete") does not arise [D] |
| Keepalive | Application heartbeats every 10 s both ways. The dialled-out socket crosses the platform's egress path, which drops quiet flows: Cloud Run 10/20 min, NAT gateway 350 s, Azure outbound 4 min, Global Accelerator 340 s ignoring TCP keepalive [V gcr-contract, aws-nat, az-lb-reset, aws-ga] |
| Reconnection | The executor reconnects with backoff and jitter, from 500 ms to 30 s (the range Inngest Connect uses to respawn its connection worker [V-prior]), and asks to resume. A resume needs the *same* gateway, and behind a shared load balancer a redial may land elsewhere. So `welcome` may carry `resumeAt`, the gateway's own direct address when one is configured (Inngest's start call hands out a specific gateway endpoint in the same way [V-prior]); the executor redials that first and the shared address second. A gateway that is not reached within `resumeWindowMs` fails the attempts it had in flight on that executor as lost (§4.7); the executor keeps their outcomes retained, so a later session to that gateway answers `status` from them [D] |
| Draining | An executor shutting down sends `close` with `drain: true`, opens its replacement connection first if it is being replaced, finishes in-flight attempts, then closes: make before break, Inngest Connect's `GATEWAY_CLOSING` pattern [V-prior] |
| TLS | The gateway needs a certificate the executors trust. A private CA pinned in the executor's config is the expected case |
| Health | `/readyz` on the executor is `200` only while connected to at least one gateway [V inngest-connect]; the gateway runs the canary on each new executor session |
| Where it breaks | (1) **Not on FaaS**: a reversed socket needs a process that stays alive between jobs; Inngest states the same limit for Connect [V inngest-connect]. Durable Objects can hold an outbound WebSocket but it "do[es] not hibernate" and pins the object for up to 15 minutes [V cf-do-ws]. (2) **The worker becomes a server**: a listener, TLS, auth, and a public or peered address, which WR §5.2 chose HTTP push to avoid [V-prior]. (3) **A relay is infrastructure**: when the *gateway* cannot have an inbound address either, something both sides dial must exist. bun-jobs ships none; a broker plugin (§7.12) is that relay. (4) **No scale from zero**: nothing can start a stopped executor through its own socket; pair it with summon-compute (Phase 1.5) [I]. (5) **Egress idle clocks**, above |

**Reverse TCP** is the same arrangement over §7.7's framing
(`listen: "tcp+tls://0.0.0.0:7443"`), for executors that allow outbound TCP
but no inbound [V platform §1.2]. It lands with `ws-reverse` in 2d because the
listener, the capacity-gated claiming and the executor registry are shared.

### 7.7 TCP, TLS and Unix sockets (`tcp`)

| Aspect | Specification |
|---|---|
| Establishment | Forward: the gateway `Bun.connect`s to `tcp+tls://host:port`, `tcp://host:port` or `unix:///path`. Reverse: §7.6. The first 8 bytes each way are the preface `BJRP/1\r\n`, then frames; `hello` is the first frame. Session shape |
| Framing | **4-byte big-endian length, then one binary frame** (§4.3.2). A length above the advertised `maxFrameBytes` (default 16 MiB) is a protocol error and closes the connection. TCP has no message boundaries: 4 MiB arrived as 19 `data` events, and one hundred 10-byte writes were coalesced [M bun §4.1] |
| Signing | Per-frame HMAC over `tcp+tls://` and `unix://`; **sealed (AEAD)** over plaintext `tcp://` (§4.4.3) |
| Ordering, reliability | Ordered and reliable per connection; resume across reconnects (§4.5.2); class `U` frames unsequenced |
| Max message | `maxMessageBytes` (default 16 MiB); no fragmentation needed |
| Keepalive, idle | Application `ping`/`heartbeat`. `setKeepAlive(true, 10_000)` and `setNoDelay(true)` are set [M bun §4.7] but are **backstops**: whether keep-alive detects a silent partition needs a real network [U bun §4.7], and Global Accelerator ignores TCP keep-alive [V aws-ga]. `socket.timeout()` is not used: it does not close the socket and fires up to 4 s late [M bun §4.6] |
| Backpressure | **`write()` is unbuffered** [M bun §4.2]. Each socket has a bounded outbound queue (`maxBufferedBytes`, default 4 MiB): `write()` what the kernel takes, keep the rest, continue on `drain`, and make the transport's `send()` reject when the queue is full. Written with `write(buf.subarray(offset))`, never `write(buf, offset)`, which throws [M bun §4.4]. A caller that ignored the return value would have lost 60.76 MiB of 64 in the spike [M bun §4.3] |
| Half-close | `shutdown()` with **no argument** is the write-side close. Not `shutdown(true)`, which sends no FIN, and not `end()`, which closes both directions at once [M bun §4.5] |
| Reconnection | The transport redials with backoff; the core resumes |
| TLS | `tcp+tls://` with a pinned `ca` and `serverName` [M bun §4.9]; mTLS with `requestCert` [M bun §4.10]. ALPN `bun-jobs/1`, passed as **wire-format bytes** (`\x0abun-jobs/1`): a plain string is accepted and silently negotiates nothing [M bun §4.12]. When the client declares a `handshake` handler, it writes in `handshake()`, not `open()`, where a write before the handshake returns `0` and is dropped [M bun §4.11] |
| Unix sockets | `unix:///path` and Linux abstract names work [M bun §4.13]; `confidential: true`, HMAC only; filesystem permissions are the access control. `remoteAddress` is `undefined` [M bun §4.13], so logs name the path |
| Health | `/healthz` and `/readyz` on `healthPort` over HTTP |
| Hostable | AWS NLB (ECS/EC2/EKS), GCP passthrough or proxy NLB, GKE LoadBalancer, GCE, ACA TCP ingress (VNet environments only), ACI, AKS, Fly `[[services]]` with no handlers, Railway TCP Proxy, Render private services (private network), Cloud Run worker pools (Direct VPC, from inside the VPC), Spectrum (Enterprise add-on), Kubernetes, VMs. **Never** FaaS, Cloud Run services, App Service, App Runner, Heroku, Vercel, Netlify, Deno Deploy, CF Workers or Containers [V platform §1.1] |
| Honest value | Polyglot executors and private networks (§1.3); same-host sidecars over Unix sockets |

### 7.8 UDP (`udp`)

UDP is specified in full, and it is the binding with the most machinery,
because UDP gives none of what the protocol needs: no reliability, no order,
no flow control, no boundaries above one datagram, no security [D].

#### 7.8.1 Establishment and the datagram

| Aspect | Specification |
|---|---|
| Establishment | The gateway resolves the host (Bun's UDP `send` does no DNS and throws "Invalid address" for a name [M bun §5.2]; `Bun.dns.lookup` works [M A]), opens a connected `Bun.udpSocket`, and sends `hello` in one datagram with the `HANDSHAKE` flag and a fresh 8-byte `connId`, **padded to 1,200 bytes**. The executor answers `welcome` in one datagram **no larger than the `hello`** |
| Handshake retry | The gateway resends `hello` (same nonce) at 1 s, 2 s, 4 s until `welcome` or `livenessTimeoutMs` |
| Datagram | Exactly one binary frame (§4.3.2), at most **1,200 bytes** including header and tag (`maxFrameBytes`), so the JSON payload per datagram is at most 1,136 bytes. 1,200 is under IPv6's 1,280 minimum MTU with headers and under Fly's ~1,300 [V fly-udp]; Spectrum drops fragmented UDP [V cf-spectrum-lim]. On loopback, 65,507 bytes passed and 65,508 threw `EMSGSIZE` [M bun §5.3], which says nothing about a real path [U] |
| `maxDatagramBytes` | Configurable up to 1,452 on a path known to be plain Ethernet, never above what the peer advertises. No path-MTU discovery in v1 [D] |

#### 7.8.2 Which messages ride bare datagrams, and which need the reliability layer

| Messages | How | Why |
|---|---|---|
| `heartbeat`, `ping`, `pong`, `progress` | **Bare datagrams**: unsequenced, never retransmitted, delivered on arrival | Periodic and idempotent: the next one supersedes a lost one; retransmitting a stale heartbeat would lie about liveness. `progress` carries `pseq` so a late one is dropped, and the final value is repeated in `result` |
| `hello`, `welcome` | Handshake datagrams, retried by the dialler | Before the session exists |
| `ack` | Bare, carried in every datagram's header; a standalone one when nothing else is due within `ackDelayMs` | — |
| `invoke`, `accepted`, `rejected`, `log`, `result`, `fail`, `cancel`, `health`, `health-result`, `status`, `status-result`, `close`, `problem` | **The reliability layer**: sequenced, fragmented if needed, retransmitted, windowed, delivered in order | Each must arrive exactly once, and in order relative to the others: a `result` before its `accepted`, or a lost `invoke`, is a correctness bug, not a stale reading |
| The canary | Through the reliability layer like any invoke, with its `progress` on bare datagrams | It exercises the real path |

#### 7.8.3 Authentication and confidentiality

**There is no DTLS in Bun**: `Bun.udpSocket({ tls })` is accepted and
silently ignored, and bun-types has no DTLS option [M bun §5.7]. So:

- Every datagram after the handshake is **sealed** with AES-256-GCM under
  per-direction keys derived by HKDF from the shared secret and both nonces
  (§4.4.3). That gives **confidentiality and integrity**, and the 1,024-bit
  `pn` window gives replay protection (§4.4.2). A datagram that fails to open
  is dropped silently and counted: answering it would make the executor an
  oracle and an amplifier.
- `hello` and `welcome` are HMAC'd with the long-term key (§4.4.1) and carry
  no job data.
- **Amplification.** An attacker who spoofs a victim's address and replays a
  captured `hello` inside the replay window gets nothing: the nonce cache
  refuses it. Even a first `hello` gets a `welcome` no larger than itself,
  because `hello` is padded to 1,200 bytes [D], the rule QUIC applies to its
  Initial packets [I, not re-read today].
- **No forward secrecy** in the symmetric mode; the X25519 mode (§4.4.5)
  gives it, in Phase 4. §14 records that this is a hand-rolled secure channel.

#### 7.8.4 Reliability, ordering, flow control

The core's reliability layer (§4.5.3), enabled because the UDP transport
declares `reliable: false`, `ordered: false`, `flowControl: false`,
`maxFrameBytes: 1200`, `confidential: false`:

- selective acknowledgement, retransmission on an RFC 6298-shaped timeout
  (initial 1 s, floor 200 ms, ceiling 10 s), `maxRetransmits` 8;
- a window of 32 fragments by default, halved on loss, grown by one per round
  trip up to the receiver's advertised window;
- fragmentation before sealing; reassembly with a deadline; `maxMessageBytes`
  64 KiB by default, 256 KiB at most;
- in-order delivery of sequenced messages.

Why a window rather than trusting the kernel: `Bun.udpSocket` has no
receive-buffer option, and a burst the receiver's buffer cannot hold is lost
(99.5% of 200,000 same-process datagrams; 0.7% of an unpaced 20,000 across
processes; 8 of a paced 20,000) [M bun §5.4]. `node:dgram`'s
`setRecvBufferSize` works (212,992 → 8,388,608) [M bun §5.4]; the executor
server may use `node:dgram` instead where a larger buffer is wanted, and the
choice is invisible on the wire [D].

#### 7.8.5 NAT, re-routing, and ICMP

- **Keepalive ≤ 25 s is enforced** (`ConfigError` above): Linux conntrack
  forgets a UDP flow after 30 s, Global Accelerator after 30 s, GCP's
  passthrough NLB tracks for 60 s, and NLB re-routes after 120 s to "a new
  target" [V linux-ct, aws-ga, gcp-netlb-ct, aws-nlb].
- **Connection id.** The executor identifies the session by `connId`, not by
  the source address, and moves the session to a new source address when a
  datagram from it opens under the session's key. A NAT rebinding therefore
  does not end the session [D].
- **Stateless reset.** Every instance behind a load balancer shares the
  secret, so each can compute `resetToken = HMAC(key, "reset" LF connId)[0..16]`.
  An instance that receives a datagram for a `connId` it does not know
  answers one small `RESET` datagram carrying the token. The gateway,
  which learned the token from `welcome`, verifies it and re-handshakes at
  once instead of waiting out `livenessTimeoutMs`. The reset is no larger than
  the datagram that caused it [D].
- **ICMP errors** reach the `error` handler with **`undefined`** instead of an
  `Error`, and `send` still returned `true` [M bun §5.6]. The transport never
  dereferences the argument; it counts the event and asks the core to `ping`
  now.

#### 7.8.6 The rest of the checklist

| Aspect | Specification |
|---|---|
| Reconnection | A new handshake. A resume (`hello.resume`) works as on any session, because the reliability layer's outbox is in the core |
| Backpressure | The window, plus `bufferedBytes()` from the transport; `sendMany` for batches of fragments [M bun §5.1] |
| Health | `/healthz` and `/readyz` **over TCP/HTTP** on `healthPort`: NLB checks UDP targets that way [V aws-nlb-hc], and AKS has no UDP probes at all [V az-aks-lb] |
| Hostable | AWS NLB (UDP 120 s fixed idle), GCP passthrough NLB and GKE LoadBalancer, GCE, ACI, AKS LoadBalancer, Fly (dedicated IPv4, `fly-global-services`, MTU ~1,300), Spectrum (Enterprise add-on), Railway (private network only), Kubernetes where the provider supports it, VMs. Everything else: no [V platform §1.1] |
| Honest value | The weakest of the bindings. Small jobs and low-overhead heartbeats inside one private network; UDP-first devices [I]. Where confidentiality and reliability over UDP matter, QUIC is the better answer, and it is deferred (§7.11) |
| Status | `experimental` until the real-network measurements of Appendix B are made and the sealing has had a review (§14) |

### 7.9 HTTP/2: an experimental flag on the HTTP bindings, first-party

**Decision** [D]: `httpVersion: "2"` on `http` and `http-stream`, off by
default, marked experimental.

- **What it buys.** Many concurrent invokes over one connection: five
  concurrent requests to a 300 ms handler took 307 ms over one client
  connection [M bun §6.2], against five connections without it [M bun §6.3].
  Full duplex works over h2 [M bun §6.2].
- **Why a flag, not a binding.** The frames, signing and semantics are the
  `http`/`http-stream` bindings' own; only `fetch({ protocol: "http2" })` and,
  on the executor, `Bun.serve({ http2: true, tls })` change [M bun §6.1].
- **Why experimental.** Bun marks both halves experimental (server v1.4.1)
  [V bun §6.1]; default `fetch` does not use h2 unless asked [M bun §6.3].
- **Traps.** ALB does not count HTTP/2 PING toward its idle timer
  [V aws-alb-attrs], which is one more reason heartbeats are application data.
  Heroku terminates h2 at the router and forwards HTTP/1.1 [V heroku-routing].
  Cloud Run's end-to-end h2 needs h2c [V gcr-http2]; whether `Bun.serve`
  serves h2c is [U] (the spike measured h2c only through `node:http2`
  [M bun §6.5]).

### 7.10 gRPC: a third-party plugin, not first-party

**Decision** [D]: bun-jobs does not ship a gRPC transport. It publishes an
**informative `.proto`** of the message protocol in `PROTOCOL.md` (appendix
G), so that a plugin and a polyglot implementer share one schema, and the
session shape of the execute facet is sufficient for a gRPC bidirectional
stream.

Reasons:

1. **No Bun API.** gRPC is feasible only as our own framing on `node:http2`
   [U bun §6.6, an inference from §6.4 and §6.5].
2. **`Bun.serve` cannot send trailers** [M bun §6.4], and gRPC's status is a
   trailer; the executor server would have to be `node:http2`, whose trailers
   work [M bun §6.5].
3. **Interop is the whole value of gRPC, and it needs protobuf.** A
   hand-written codec is a maintenance burden; a JSON-over-gRPC codec talks to
   no off-the-shelf gRPC peer. The dependency policy keeps `@grpc/grpc-js` and
   `protobufjs` out of a published package; a plugin package may take them.
4. **Reach is decent, which is why a plugin is worth encouraging.** Cloud Run
   (all stream types), ALB (gRPC target groups), GCP ALB, ACA, Fly
   `h2_backend`, Kubernetes `GRPCRoute`, Lambda MicroVMs [V platform §1.1].

The author guide's transport chapter uses gRPC as its worked example of a
session-shape plugin, in outline (§11.3).

### 7.11 HTTP/3 and QUIC: deferred

**Decision** [D]: neither is specified for Phase 2. Revisit when both
conditions hold: Bun marks `http3` stable, and its h3 client accepts a
per-request `tls.ca`.

- Bun's own words: "Don't ship `http3: true` to production yet"; 0-RTT is
  disabled; `server.upgrade()` returns `false` over h3 [V bun §6.10].
- **The h3 client refuses a per-request `tls.ca` or `serverName`
  (`HTTP3Unsupported`)** and trusts only the process-wide store or
  `rejectUnauthorized: false` [M bun §6.9]. That breaks per-executor
  certificate pinning, which the TCP and WebSocket bindings rely on for
  private CAs.
- `node:quic` works in Bun with a custom ALPN, bidirectional streams and
  datagrams [M bun §6.11], but Node marks it "Early development" and Bun lacks
  part of its API [V bun §6.12].

QUIC is nevertheless the *right* long-term answer to "UDP with reliability
and encryption", which is an argument for keeping the UDP binding minimal.
The session shape is designed so a QUIC plugin maps attempts to streams and
heartbeats to datagrams with no API change [I]; a third party may ship one
behind its own experimental flag.

### 7.12 Third-party transports through the plugin system

A provider plugin ships a transport by implementing the execute facet's
session shape with `direction: "brokered"` (or `"forward"` for a
point-to-point protocol) [D]. What the protocol asks of it:

- **Carry frames opaquely.** The frame is the text or binary encoding; the
  plugin must not parse, transform or re-encode it. It never holds the secret
  and never needs to.
- **Declare capabilities truthfully.** NATS core is at-most-once: `reliable:
  false`, and the core retransmits. JetStream, AMQP with acknowledgements and
  Kafka are at-least-once: `reliable: true`, and the core's duplicate
  suppression absorbs redelivery. MQTT QoS 0/1/2 map to `reliable: false`,
  `true` (duplicates absorbed), `true`. Brokers are rarely end-to-end
  encrypted, so `confidential: false` and the core seals, unless the broker
  connection is TLS to a broker the user trusts with job data.
- **A naming convention for routing**, recommended in the author guide:
  executors of a queue join a shared subscription on
  `bun-jobs.<namespace>.<queue>.hello`; a session then uses
  `bun-jobs.s.<sid>.g` and `bun-jobs.s.<sid>.e`. The broker is the relay of
  §7.6, which is exactly its value.
- **Its runtime half** (`./runtime`) uses the browser-safe protocol core,
  `createExecutorSession()` (§9), plus its broker client.

None is first-party: every broker needs an npm client, and the dependency
policy keeps those out of a published package. One exception is worth
recording as a later possibility, not a plan: Redis Streams and Postgres
`LISTEN`/`NOTIFY` are reachable through Bun's native clients, so a
`redis-stream` transport could be first-party. Its only use would be a
polyglot executor that can reach Redis but cannot run a bun-jobs driver [I];
a Bun executor that can reach Redis should run a pull worker instead.

---

## 8. Configuration: what a user writes

### 8.1 The URL's scheme picks the binding

The shorthand target of `worker-runtimes.md` §4.2.8 keeps its shape; its
`url` now selects a first-party provider by scheme [D]:

| `url` | Binding | Provider (`./providers/*`) | Frames |
|---|---|---|---|
| `https://…` | `http-stream` when the handshake advertises `progress-stream`, else `http` | `httpsExecute` | text over TLS; unary JSON |
| `http://localhost…` | as above, loopback only (WR §5.6) | `httpsExecute` | as above |
| `wss://…` (`ws://` loopback only) | `ws` | `wsExecute` | text over TLS |
| `ws+unix:///path` | `ws` over a Unix socket [M bun §3.13] | `wsExecute` | text |
| `tcp+tls://host:port` | `tcp` | `tcpExecute` | binary over TLS, HMAC |
| `tcp://host:port` | `tcp` | `tcpExecute` | binary, **sealed** |
| `unix:///path` | `tcp` over a Unix socket | `tcpExecute` | binary, HMAC |
| `udp://host:port` | `udp`, experimental | `udpExecute` | binary, **sealed** |
| `listen: "wss://0.0.0.0:8443/…"` | `ws-reverse` | `wsListen` | text over TLS |
| `listen: "tcp+tls://0.0.0.0:7443"` | reverse `tcp` | `tcpListen` | binary over TLS |

Anything else, or a plugin, is passed as `provider` (§8.3).

### 8.2 The target's new fields

Additions to `RemoteEndpointTarget` (`worker-runtimes.md` §4.2.8), with the
JSDoc `CLAUDE.md` requires [D]:

```ts
/** Phase 2: the transport-related fields of a remote target. Joins WR §4.2.8's `url`, `secret`, `timeout`, `maxInFlight`, `batch`, … */
export interface RemoteEndpointTransportOptions {
  /**
   * Where the executor is. The scheme picks the binding (`https:`, `wss:`,
   * `tcp+tls:`, `tcp:`, `unix:`, `udp:`; §8.1). Exactly one of `url` and
   * `listen` is given.
   */
  url?: string;
  /**
   * For a reversed binding: where this worker listens for executors to dial
   * in, e.g. `"wss://0.0.0.0:8443/bun-jobs"`. Makes the worker a server; see
   * the security note in the user guide before exposing it.
   */
  listen?: string | RemoteListenOptions;
  /**
   * Chooses between the HTTP bindings when the scheme allows several:
   * `"http"` forces unary responses, `"http-stream"` requires a stream, and
   * `"sse"` uses the SSE session mode (§7.4, single-instance executors only).
   * Unset, the handshake decides.
   */
  binding?: "http" | "http-stream" | "sse";
  /** TLS for the connection to the executor. Unset, the system trust store and the URL's host are used. */
  tls?: RemoteTlsOptions;
  /**
   * How many sessions to hold open to the executor, for the session bindings.
   * Behind a load balancer, several sessions reach several instances.
   * Defaults to `1`. Ignored by the HTTP bindings, which open a request per
   * invoke.
   */
  sessions?: number;
  /** Liveness timing (§5.2). Every value is enforced with an application timer. */
  heartbeat?: RemoteHeartbeatOptions;
  /** Health probing (§5.3–§5.4). */
  health?: RemoteHealthOptions;
  /**
   * `"2"` sends HTTP-binding requests over HTTP/2 (experimental in Bun,
   * §7.9). Defaults to `"1.1"`. Ignored by the other bindings.
   */
  httpVersion?: "1.1" | "2";
}

/** TLS settings for reaching an executor. */
export interface RemoteTlsOptions {
  /** PEM certificate(s) to trust instead of the system store: pin a private CA or a self-signed executor. */
  ca?: string | string[];
  /** The name to verify the executor's certificate against. Defaults to the URL's host. */
  serverName?: string;
  /** PEM client certificate, for executors that require mTLS. Needs `key`. */
  cert?: string;
  /** PEM private key for `cert`. Read it from the environment or a secret store; never commit one. */
  key?: string;
}

/** Where a reversed remote worker listens for executors. */
export interface RemoteListenOptions {
  /** The listen address, e.g. `"wss://0.0.0.0:8443/bun-jobs"` or `"tcp+tls://0.0.0.0:7443"`. */
  url: string;
  /** The server certificate and key, PEM. Required for `wss:` and `tcp+tls:`. */
  tls?: { cert: string; key: string; ca?: string | string[]; requestCert?: boolean };
  /**
   * Executor names this worker accepts. An executor whose `hello` names
   * another is closed with `4403`. Unset, any executor holding the secret
   * is accepted.
   */
  executors?: string[];
  /**
   * This worker's own direct address, sent to each executor in `welcome` as
   * `resumeAt`, so a reconnecting executor can resume here rather than
   * landing on another worker behind the shared address (§7.6). Unset, no
   * `resumeAt` is sent.
   */
  advertise?: string;
}

/** Liveness timing for a remote target. */
export interface RemoteHeartbeatOptions {
  /** How long a direction may be quiet before a `ping`, and the executor's heartbeat period, in ms. Default `10_000`; at most `25_000` on UDP. */
  keepaliveMs?: number;
  /** How long without any verified frame before a session is suspect, in ms. Default `2.5 × keepaliveMs`. */
  livenessTimeoutMs?: number;
  /** How long an attempt may be missing from the executor's heartbeats before it is treated as lost, in ms. Default `3 × keepaliveMs`. */
  attemptSilenceMs?: number;
  /** How long to wait for `accepted` after sending an invoke, in ms, before a transport retry. Default `5_000`. */
  acceptTimeoutMs?: number;
  /** How long to try to resume a dropped session before giving up on it, in ms. Default `30_000`. */
  resumeWindowMs?: number;
}

/** Health probing for a remote target. */
export interface RemoteHealthOptions {
  /** Whether to run the functional canary (§5.3). Default `true` when the executor advertises `canary`. */
  canary?: boolean;
  /** How often to run the canary on each ready session, in ms. `0` runs it only at session open and as the breaker's half-open probe. Default `300_000`. */
  canaryIntervalMs?: number;
  /** How long one canary may take before it counts as failed, in ms. Default `10_000`. */
  canaryTimeoutMs?: number;
  /** How often to send `health` (readiness), in ms. Default `60_000`; readiness also rides every heartbeat. */
  readinessIntervalMs?: number;
  /** Whether to read the executor's `/healthz` through the facet's `probe()` for the Workers page. Default `false`. Never used to route. */
  probePlatform?: boolean;
}
```

`WORKER_CONFIG_KEYS` gains **no** transport keys. §8.2 of
`worker-runtimes.md` refused `endpointUrl` as a remote-code-execution control
panel; a binding or a listen address is the same kind of setting, and
timing is a deployment decision, not a dashboard one [D].

### 8.3 Snippets, host side

```ts
// Streamed HTTP (the default for https:)
jobs.remoteWorker("media", { url: "https://media.example.run.app/bun-jobs", secret });

// WebSocket, pinning a private CA, two sessions
jobs.remoteWorker("media", {
  url: "wss://gpu.internal:8443/bun-jobs",
  secret,
  tls: { ca: process.env.EXECUTOR_CA! },
  sessions: 2,
});

// TCP with TLS to a Go service in the VPC
jobs.remoteWorker("inference", { url: "tcp+tls://inference.svc:7443", secret, tls: { ca } });

// A Unix-socket sidecar
jobs.remoteWorker("thumbs", { url: "unix:///run/thumbs.sock", secret });

// UDP inside a private network (frames sealed; experimental)
jobs.remoteWorker("pings", { url: "udp://10.0.3.7:7000", secret, heartbeat: { keepaliveMs: 5_000 } });

// Reversed: executors with no inbound path dial this worker
jobs.remoteWorker("reports", {
  listen: { url: "wss://0.0.0.0:8443/bun-jobs", tls: { cert, key }, executors: ["reports-pool"] },
  secret,
});

// A plugin transport
import { natsExecute } from "@acme/bun-jobs-provider-nats";
jobs.remoteWorker("etl", { provider: natsExecute({ servers: ["nats://nats:4222"] }), secret });
```

---

## 9. The executor side: per-transport servers

`worker-runtimes.md` §6.1's `createRemoteExecutor()` stays the one
implementation of the executor, browser-safe, in `./remote` [D]. It now
returns a `RemoteExecutor` that is still callable as a fetch handler, so every
existing snippet keeps working, and that can also take sessions:

```ts
/** The executor built by `createRemoteExecutor()`. */
export interface RemoteExecutor {
  /** Handles one HTTP request: the handshake, a unary or streamed invoke, cancel, status, and `/healthz`/`/readyz`. */
  (request: Request): Promise<Response>;
  /**
   * Runs the protocol over a session transport the caller provides: a socket,
   * a datagram channel, a broker subscription. The runtime kit's servers call
   * it; a third-party runtime transport calls it directly.
   */
  acceptSession: (io: ExecutorSessionIO) => ExecutorSession;
  /** Current readiness, for a platform probe the caller serves itself. */
  readiness: () => { ready: boolean; reason?: string; capacity: { inFlight: number; max: number } };
  /**
   * Stops taking new invokes, tells every session (`close` with `drain`),
   * and resolves when in-flight attempts have settled or `graceMs` passed.
   */
  drain: (options?: { graceMs?: number }) => Promise<void>;
}
```

`createRemoteExecutor`'s options gain `health?: { check?: (ctx) =>
Promise<HealthCheck[]> }` (the author's readiness and canary checks),
`resultRetentionMs`, `resumeBufferBytes`, `maxConcurrency` (the capacity it
advertises) and `heartbeatMs` (the most frequent heartbeat it will send).

**The servers**, a new entry `./remote/serve` [D]. It uses Bun APIs, so it is
**not** browser-safe and not for workerd; FaaS executors keep using the fetch
handler and `defineRuntimeAdapter`. Each server handles the Bun behaviour of §2.1
so the author does not have to:

| Function | Binding | What it takes care of |
|---|---|---|
| `serveHttp(executor, { port, hostname, tls, http2, path })` | `http`, `http-stream`, `sse` | `server.timeout(req, 0)` on streams; the immediate first frame; SSE headers; `/healthz`, `/readyz` |
| `serveWebSocket(executor, { port, tls, path, maxMessageBytes, maxBufferedBytes })` | `ws` | The upgrade and its signature check; every `send()` result; `backpressureLimit` and `drain`; health routes on the same server; `idleTimeout` as a backstop only |
| `serveTcp(executor, { port \| unix, tls, healthPort, maxBufferedBytes })` | `tcp` | Length-prefixed framing; the outbound queue and `drain`; ALPN as wire bytes; writes in `handshake()`; `shutdown()` for half-close; a health server |
| `serveUdp(executor, { port, hostname, healthPort, recvBufferBytes })` | `udp` | Datagram I/O, `connId` routing, stateless reset, ICMP `undefined`; a TCP health server; `node:dgram` when `recvBufferBytes` is set |
| `dialWebSocket(executor, { url, tls, name })`, `dialTcp(…)` | `ws-reverse`, reverse `tcp` | Dialling, backoff and jitter, `resumeAt`, make-before-break drain, `/readyz` = connected |

Third parties building a runtime transport (a broker) call
`executor.acceptSession(io)` with their own `io`
(`compute-provider-plugins.md` §8.4 has the type). They never touch frames'
security: the executor core does that.

**Worked executors** for every binding are in the author guide (§11.3). The
shortest, for WebSocket:

```ts
import { createRemoteExecutor } from "@kingsleyweb/bun-jobs/remote";
import { serveWebSocket } from "@kingsleyweb/bun-jobs/remote/serve";

const executor = createRemoteExecutor({
  secret: process.env.BUN_JOBS_SECRET!,
  name: "gpu-ws",
  maxConcurrency: 4,
  health: { check: async () => [{ id: "gpu", status: (await gpuReady()) ? "pass" : "fail" }] },
  handlers: {
    "resize-image": async (job, ctx) => {
      for (let i = 1; i <= 10; i++) {
        await resizeTile(job.data, i, { signal: ctx.signal });
        await job.updateProgress(i * 10);    // a progress frame, now
      }
      ctx.log("done");
      return { tiles: 10 };
    },
  },
});

serveWebSocket(executor, {
  port: 8443,
  tls: { cert: Bun.file("cert.pem"), key: Bun.file("key.pem") },
});
```

---

## 10. Conformance, per binding

Every binding passes **the same protocol conformance**, and then its own
binding-specific checks. All of it runs locally with no cloud, against fakes
on loopback [D].

### 10.1 Protocol conformance, run on every binding

`conformRemoteExecutor()` (`worker-runtimes.md` §7.1) is generalised: it
takes an endpoint URL of any scheme in §8.1 (or a transport object for a
plugin) and runs one suite over it.

| Group | Checks (each a stable id) |
|---|---|
| handshake | `hello`/`welcome` or `GET`; version negotiation; `UNSUPPORTED_PROTOCOL` is negotiable; unknown fields tolerated; a replayed `hello` refused (nonce cache); a `hello` outside the window refused |
| frame security | a flipped byte refused; a frame replayed at an old `seq`/`pn` dropped; a frame from another session refused (`sid`); a frame reflected back refused (`dir`); a forged `ack` refused; on sealed bindings, a datagram under the wrong key dropped silently |
| invoke | success; `result` round-trips JSON exactly; `handler-not-found`; a thrown error is `failed`; `failed-fatal` honoured; `retryAfterMs` honoured; outcomes keyed by id; batches |
| accept and reject | `accepted` within `acceptTimeoutMs` on a streaming binding; `rejected BUSY` at capacity, and the attempt is not burned |
| progress and log | frames arrive **during** the attempt, in order, verified one by one; the final progress is in `result` |
| heartbeat | periodic, listing running attempts; stops listing a finished one |
| health | `ping` → `pong` with capacity; `health` → `health-result` with the author's checks; the canary echoes its nonce with progress spread over time |
| cancel | a `cancel` aborts the handler's signal; a late outcome for it is acknowledged and ignored |
| duplicate delivery | the same `idempotencyKey` twice answers from the store, or runs twice when there is none (reported, SHOULD) |
| lost response | the channel is cut after `accepted`: the gateway re-attaches (`status`, `Last-Event-ID`, or re-POST) and settles once |
| reconnection | the connection is cut mid-attempt: the session resumes with no duplicate and no gap; with the outbox forced to overflow, `resumed: false` and `status` recover |
| fencing | a stale `fence` is refused `STALE_FENCE` (SHOULD) |
| limits | an oversize message is refused by the sender with `PayloadTooLargeError`, not by a platform close |
| platform probe | `/healthz` answers `200`; `/readyz` is `503` while draining |

### 10.2 Binding-specific checks

| Binding | Checks | Fake used |
|---|---|---|
| `http` | a buffered response is still verified; 404/405 trip the breaker without burning an attempt (WR §5.5) | none |
| `http-stream`, `sse` | the first frame arrives immediately (the header-flush regression [M bun §1.4]); frames split across chunk boundaries and events split across writes parse; **buffering is detected and the endpoint downgraded**, both "hold until end" and "64 KiB blocks"; `Last-Event-ID` re-attaches; a stream longer than `idleTimeout` survives; `EventSource` is never referenced | `bufferingHttpProxy({ mode })` |
| `ws`, `ws-reverse` | a paused peer: server `send()` returning `0` is handled as a dead session, not a silent loss [M bun §3.6]; the gateway's `bufferedAmount` stays bounded [M bun §3.8]; a paused client is detected by application liveness [M bun §3.11]; an oversize message is refused before sending [M bun §3.5]; an idle-cutting proxy is kept alive by heartbeats and, when it cuts anyway, the session resumes; reverse: make-before-break drain, `4403` for an unknown executor, capacity-gated claiming | `idleCuttingProxy({ idleMs })` |
| `tcp` | frames delivered one byte at a time, coalesced, and with the length prefix split; a receiver paused while 64 MiB is written loses nothing [M bun §4.3]; half-close with `shutdown()` delivers the reply [M bun §4.5]; ALPN negotiates `bun-jobs/1`; a pinned CA passes and a wrong `serverName` fails [M bun §4.9]; sealed `tcp://` refuses a tampered frame | `tcpChunker({ chunkBytes })` |
| `udp` | with **seeded** loss (0–20%), reordering, duplication, delay and a 1,200-byte MTU: every sequenced message arrives exactly once and in order, and every job completes exactly once; bare heartbeats are lost without harm; a source-port rebinding keeps the session; a `RESET` from an instance that does not know the `connId` triggers an immediate re-handshake; a replayed `hello` is refused; a `welcome` is never larger than its `hello`; ICMP `undefined` does not crash [M bun §5.6]; keepalive above 25 s is a `ConfigError` | `lossyUdpProxy({ loss, reorder, duplicate, delayMs, mtu, rebindEveryMs, seed })` |
| any | an executor frozen with SIGSTOP mid-attempt is detected within `attemptSilenceMs` + one interval, and the attempt fails as `RemoteAttemptLostError`; killed with SIGKILL, TCP and WebSocket detect it at once [M bun §4.8] | `spawnExecutor()` (a child process the kit can stop and kill) |

### 10.3 Where it lives

- `./remote/testing`: the generalised `conformRemoteExecutor`, and the fakes
  above, **shipped**, because a third party writing a transport or a polyglot
  executor needs the lossy UDP proxy as much as we do. Each fake is a small
  Bun server on port 0 (`CLAUDE.md`'s rule), deterministic under a seed. One
  more, `lossySession(session, { loss, reorder, duplicate, seed })`, injects
  the same faults at the frame level around any `DuplexSession`, so a broker
  plugin that declares `reliable: false` gets UDP's loss tests without a
  network proxy.
- `./provider/testing`: `runExecuteConformance` gains session-shape checks.
  A transport's declared capabilities are tested under the fakes: one that
  declares `reliable: true` must surface a mid-frame reset as a closed
  session and never deliver a truncated frame; one that declares
  `ordered: true` must not reorder under the chunker; `send()` must reject,
  not drop, above its buffer.
- The CLI: `bunx --bun @kingsleyweb/bun-jobs conform <url> --secret …`
  accepts every scheme.
- **Everything runs in `bun test` with no network beyond loopback.** The
  measurements loopback cannot make are Appendix B's, and belong to the tier-3
  script (`worker-runtimes.md` §7.2), not to CI.

---

## 11. Documentation deliverables

The user was explicit: example usage of these protocols must be properly
documented. So the documentation is scoped, located and tested like code, in
the pattern `compute-provider-plugins.md` §15 set [D].

### 11.1 The files

All under `packages/bun-jobs/docs/`, shipped in the package (`files` gains
`"docs"`, `compute-provider-plugins.md` §15.1).

| File | Audience | Content |
|---|---|---|
| `docs/remote/README.md` | everyone | What remote execution is; the four layers; which document to read next |
| `docs/remote/transports.md` | application developers | **The transport selection guide** (§11.2) |
| `docs/remote/transports/http.md`, `http-stream.md`, `sse.md`, `websocket.md`, `websocket-reverse.md`, `tcp.md`, `udp.md`, `http2.md` | application developers | **One user guide per binding** (§11.4) |
| `docs/remote/PROTOCOL.md` | implementers in any language | **The wire specification**, RFC 2119, with per-binding appendices and test vectors (§11.5) |
| `docs/remote/executor-guide.md` | authors of executors | **Per-protocol sections with a complete worked executor for each binding** (§11.3) |
| `docs/providers/author-guide.md` | plugin authors | Gains a "Writing a transport" chapter (§11.3) |
| `docs/remote/health.md` | operators | The health model, the states on the Workers page, and platform health-check recipes |
| `docs/remote/LIMITATIONS.md` | everyone | `worker-runtimes.md` §5's typed "this transport cannot do that" list, now per binding |
| `docs/remote/polyglot/python-tcp/executor.py` | implementers | A stdlib-only Python executor over `tcp+tls` (§11.3) |

### 11.2 The transport selection guide

The heart of `docs/remote/transports.md`: a table from the platform matrix,
with the trap to know on each row. Its content, as proposed [D], with every
fact carried from `platform-transports.md`:

| The executor runs on | Use | The trap |
|---|---|---|
| Lambda behind a Function URL | `http-stream` with `RESPONSE_STREAM`; else `http` | Default is `BUFFERED`; streaming is not available in a VPC; 2 MBps after 6 MB [V aws-furl-modes, aws-lambda-stream]. Maximum request duration undocumented [U] |
| Lambda behind API Gateway HTTP API | `http` | No streaming; 30 s integration timeout [V aws-apigw-http-quotas] |
| Lambda or HTTP behind API Gateway REST | `http-stream` with `STREAM` | 15 min; idle 5 min, **30 s on edge-optimized** [V aws-apigw-stream] |
| ALB → ECS/EC2 | `http-stream` or `ws` | Idle 60 s by default, not reset by HTTP/2 PING; ALB health checks cannot check WebSockets, so point them at `/healthz` [V aws-alb-attrs, aws-alb-hc] |
| ALB → Lambda | `http` | No chunked responses, no WebSockets [V aws-alb-lambda, aws-blog-stream] |
| NLB → ECS/EC2/EKS | `tcp`, `ws`, `udp` | UDP idle fixed at 120 s, then a flow may go to a new target; UDP targets are health-checked over TCP/HTTP [V aws-nlb, aws-nlb-hc] |
| Lambda MicroVMs | `ws` or `http-stream` | Up to 8 h; endpoint timeouts [U] [V aws-microvm-net, aws-lambda-quotas] |
| Cloud Run service | `http-stream` or `ws` | ≤ 60 min per request, WebSockets included; on timeout a 504 while **the instance keeps running**, so configure an executor store [V gcr-ws, gcr-timeout]. Front-end buffering [U]: the canary's probe covers it |
| Cloud Run worker pool | `tcp` from inside the VPC; `ws-reverse` from outside | No URL; L4 TCP to per-instance private IPs only [V gcr-model, gcr-dvpc] |
| Cloud Run job, ACA job, Render background worker, ECS with no LB | `ws-reverse` | No inbound path [V gcr-contract, render-bg]; long-running only |
| GKE / Kubernetes | `http-stream` or `ws` through a Gateway; `tcp`/`udp` through a Service LoadBalancer | ingress-nginx read/send timeouts 60 s and it was retired in March 2026; classic `gke-l7-gxlb` closes even active WebSockets at 30 s [V ingress-nginx-misc, ingress-nginx-home, gcp-lb-timeouts, gke-gw] |
| GCE / any VM | any | nginx in front buffers and cuts at 60 s unless told otherwise; firewall conntrack needs a packet every 10 min [V nginx-proxy, nginx-ws, gcp-fw] |
| Azure Functions | `http` or `http-stream` for attempts under 230 s | 230 s → 502 **while the function keeps running**; whether a stream survives past it [U] [V az-func-http] |
| Azure Container Apps (app) | `http-stream`, `ws`; `tcp` in a VNet environment | 240 s request timeout; whether it applies to WS/SSE [U] [V az-aca-ingress] |
| ACI | `tcp`, `udp`, `http` | Probes are exec/httpGet only; IP may change [V az-aci-api, az-aci-faq] |
| AKS | any | LB idle 4 min by default; no UDP probes [V az-aks-lb] |
| App Service | `http-stream`, `ws` (setting on) | 230/240 s response cap [V az-appsvc-timeout, az-appsvc-cfg] |
| Application Gateway in front | avoid `ws` for long attempts | Its request timeout (20 s default) applies to the WebSocket session [V az-appgw-ws] |
| Cloudflare Workers | `http-stream`, `ws` via `WebSocketPair` | Body buffering "Standard" by default; WS idle period unstated [V cf-buffering, cf-net-ws] [U] |
| Cloudflare Containers | `http-stream`, `ws` via the Worker's `fetch` | No TCP or UDP inbound; `containerFetch` has no WebSockets [V cf-ctr-arch, cf-ctr-class] |
| Behind Cloudflare's proxy | `http-stream` (SSE-framed) | Tunnel buffers anything but `text/event-stream`; 125 s to first byte → 524 [V cf-tunnel, cf-524] |
| Fly Machines | `ws`, `tcp`, `udp` | UDP needs a dedicated IPv4 and `fly-global-services`, MTU ~1,300; `http_options.idle_timeout` default [U] [V fly-udp, fly-services] |
| Railway | `ws` (no limit), `http-stream` | HTTP closed after 5 min with no data, 15 min total; health checks only at deploy; UDP on the private network only [V railway-limits, railway-hc, railway-private] |
| Render web service | `http-stream` (100 min), `ws` | WebSockets close on instance replacement [V render-vs-vercel, render-ws] |
| Heroku | `http-stream` or `ws` | 30 s to first byte, then a 55 s rolling window; HTTP/2 terminated at the router; no TCP routing [V heroku-routing] |
| Vercel | `http-stream`; `ws` (beta) | Both end at the function's maximum duration [V vercel-limits, vercel-ws] |
| Netlify | `http` | Streams capped at 60 s and 20 MB [V netlify-cfg] |
| A polyglot service (Go, Rust, Python) you run | `tcp+tls` or `ws` | See §1.3; `udp` only on a private network |
| A sidecar on the same host | `unix:` | — |

The guide opens with the three rules every row depends on: heartbeats are
application data inside the shortest idle clock on the path; every executor
serves `/healthz`; and on a platform where a timeout fails the caller but not
the work, configure an executor store or accept that a handler may run twice.

### 11.3 The executor guide and the author guide

`docs/remote/executor-guide.md` has **one section per binding, each with a
complete, runnable executor** (not a fragment), its health check, its
progress reporting, and the platform notes for where it is usually deployed
[D]:

1. HTTP unary on `Bun.serve`, and the same handler as a Next.js route and a
   Cloudflare Worker (the fetch handler, unchanged from `worker-runtimes.md`
   §6.4).
2. Streamed HTTP (SSE framing) on `serveHttp`, reporting progress per tile.
3. SSE with re-attachment: an executor with a retained-frame store answering
   `Last-Event-ID`.
4. WebSocket, forward: `serveWebSocket` (the §9 example, complete).
5. WebSocket, reversed: `dialWebSocket` from a Cloud Run worker pool or a
   Render background worker, with `/readyz` and a make-before-break drain.
6. TCP with TLS, and a Unix-socket sidecar, on `serveTcp`.
7. UDP on `serveUdp`, with its TCP health port.
8. **A polyglot executor**: `polyglot/python-tcp/executor.py`, stdlib only
   (`socket`, `ssl`, `hmac`, `hashlib`, `json`, `struct`), speaking
   `tcp+tls` with HMAC frames. It is ~250 lines [I]. It exists to prove that
   `PROTOCOL.md` is enough to implement an executor with no access to this
   repo. A test runs `conformRemoteExecutor` against it when `python3` is on
   `PATH`, and skips visibly otherwise, in the repo's convention for optional
   tools. **UDP and `tcp://` need AES-GCM, which Python's standard library
   lacks** (it needs the `cryptography` package), so the polyglot example is
   TCP over TLS [I].

The plugin author guide (`compute-provider-plugins.md` §15.2) gains a chapter,
**"Writing a transport"**: the session shape; declaring capabilities
truthfully; what the core does for you (security, reliability, health); the
buffering and backpressure rules; the fakes; and two worked examples. The
first is a complete session-shape transport over a fictional "Acme Queue"
broker, in the template (a fictional platform, for the reason CPP §15.2
gives). The second, in outline, is a gRPC bidirectional stream carrying text
frames, which is what a real gRPC plugin would do.

### 11.4 A user guide per binding

Each of `docs/remote/transports/<binding>.md` has the same sections [D]:

1. **When to use it**, and where it is hostable (from §11.2).
2. **Configuring the worker** (`url`/`listen`, `tls`, `sessions`,
   `heartbeat`, `health`).
3. **Health and progress behaviour**: what liveness means on this binding,
   what the canary proves, what the Workers page shows, and, for `http`,
   what it cannot show.
4. **Failure modes**, as a table: symptom, what the worker does, what to
   check. For example, on `ws`: "closed with 4408 every ~60 s" → an idle
   timer shorter than `keepaliveMs` on the path.
5. **Platform notes**: the traps from §11.2 for this binding.
6. **Security**: TLS or sealing; for `ws-reverse`, the worker is now a
   server, and what that exposes.

### 11.5 `PROTOCOL.md`, with per-binding appendices

The body is §4 and §5 of this document, written normatively (RFC 2119),
with literal transcripts. The appendices are §7's bindings, each with the
checklist of §7.1:

| Appendix | Content |
|---|---|
| A | `http` (§5 of `worker-runtimes.md`, carried over) |
| B | `http-stream` and `sse`: the SSE event mapping, the first-frame rule, `Last-Event-ID`, the session mode |
| C | `ws` and `ws-reverse`: subprotocol, close codes, `resumeAt` |
| D | `tcp`: preface, length prefix, ALPN bytes, Unix sockets |
| E | `udp`: byte diagrams of every datagram kind, the handshake padding, the reliability parameters, stateless reset |
| F | HTTP/2 notes |
| G | An **informative** `.proto` of the messages, for gRPC plugins and polyglot implementers |
| H | Brokered transports: the routing convention and the capability mapping (§7.12) |
| V | **Test vectors**: for a fixed secret, `sid`, `seq`, `ack` and JSON, the expected text-frame MAC; a binary frame's bytes and tag; HKDF outputs; an AES-GCM sealed datagram. An implementer in any language checks their code against these without running Bun |

The vectors are generated by a script and checked by a test, so the document
cannot drift from the code [D].

### 11.6 Runnable examples, for the examples session

A new directory, `examples/bun-jobs/NN-transports/`, each example against a
local executor, each demonstrating **health checks and progress**, with **a
failure demo per binding** [D]:

| Example | Local executor | Demonstrates | Asserts |
|---|---|---|---|
| `http.ts` | `Bun.serve` + fetch handler | unary invoke; canary at start; progress only in the outcome | outcome, progress at the end, `degraded: cannot report during an attempt` |
| `http-stream.ts` | `serveHttp` | live progress and logs; heartbeats; a buffering proxy in front → detection and downgrade | progress arrives before the result; buffering flagged, then cleared when the proxy is removed |
| `sse.ts` | `serveHttp` with a retained-frame store | the hand-written SSE parser; a proxy that cuts the stream mid-attempt → `Last-Event-ID` re-attach | the job completes once; no duplicate progress |
| `websocket.ts` | `serveWebSocket` | canary, `health`, progress, `cancel`; an idle-cutting proxy → resume | resumed with no gap; cancel aborts the handler |
| `websocket-reverse.ts` | `dialWebSocket` | the executor dials the worker; capacity-gated claiming; `/readyz` follows the connection | claims stop with no executor connected |
| `tcp.ts` | `serveTcp` with TLS (a committed test-only certificate) | framing, TLS pinning, progress | — |
| `unix-socket.ts` | `serveTcp({ unix })` | a sidecar | — |
| `udp.ts` | `serveUdp` behind `lossyUdpProxy` (10% loss, reordering, duplication, seeded) | sealed frames; exactly-once completion over loss | every job completes exactly once |
| `health-checks.ts` | `serveWebSocket` | all three levels; `/healthz`; a failing author check stops new work; a failing canary opens the breaker, and a passing half-open canary closes it | the state sequence |
| `failures/<binding>-frozen.ts` ×6 | each binding's executor in a child process | **the executor is frozen with SIGSTOP mid-attempt**: no FIN, no heartbeats | heartbeat loss detected within `attemptSilenceMs` + one interval; the attempt fails as `RemoteAttemptLostError` and succeeds on a second executor. For `http`, the honest counterpart: detection only at the request timeout |
| `failures/<binding>-killed.ts` ×3 (`ws`, `tcp`, `udp`) | same | SIGKILL: TCP and WebSocket see the FIN at once [M bun §4.8]; UDP relies on the heartbeat, and ICMP arrives as `undefined` [M bun §5.6] | the detection path taken |
| `NN-providers/custom-session-transport.ts` | an in-memory fake broker | a session-shape execute provider written by the examples session, passing `runExecuteConformance` and the protocol suite through `lossySession()`; the "outside" transport the execute gate needs (§13.1) | the kit reports `ok`; three jobs complete exactly once under loss |

**How they are kept true.** They are typechecked by `scripts/typecheck.ts`
and run by `run-all.ts` like every example. The failure demos and
`udp.ts` assert on durations, so they go in `RUN_ALONE`, by `CLAUDE.md`'s
rule for examples that assert a duration. They use short timings
(`keepaliveMs: 500`), which application timers make reliable
[M bun §1.6, M A]. They run on `memory` and on one server backend like any
change, and in the full 8-backend sweep once per merge window. The test
certificate for `tcp.ts` is committed as a fixture and says so in its file
name; generating one would need `openssl`, which Bun cannot replace [I].

Per the examples protocol, the bun-jobs session sends a change report at each
sub-phase that lands a binding, and the examples session writes and runs that
binding's examples before the README links them.

### 11.7 How the documentation stays true

- Code blocks in every guide are extracted and typechecked by a
  `docs.type-test.ts` (`compute-provider-plugins.md` §15.6).
- The executor guide's worked executors are **the examples' executors**, so
  they cannot disagree.
- `PROTOCOL.md`'s test vectors are generated and checked by a test.
- The Python executor passes `conformRemoteExecutor` whenever `python3` is
  present.
- The reference drift test covers `./remote/serve` and the new
  `./providers/*` entries.
- The selection guide's facts carry their evidence keys, and each facet gate
  re-reads the rows marked [U].

---

## 12. Observability and the Workers page

`WorkerTargetInfo.remote` gains the binding, the endpoint's health (§5.4) and
session counts [D]. The definition, with its JSDoc, is WR §8.1, the one place
it lives. In brief:

- `binding`: `"http"`, `"http-stream"`, `"sse"`, `"ws"`, `"ws-reverse"`,
  `"tcp"`, `"udp"`, or a plugin's id;
- `health`: `state` (`healthy`, `degraded`, `unhealthy`, `unknown`) with a
  `reason`, the last `pong`'s `rttMs`, the last reported `capacity`, and the
  last `canary` (when, whether it passed, how long it took);
- `sessions`: open, resumed and lost, for the session bindings;
- `lastSeenAt`, now the last verified message of any kind, and `endpoint`,
  now any scheme, shown with nothing past the authority.

The UI session adds the binding badge, the health state with its reason, the
canary's last result and the session counts to the Target card, and a
"health" filter to the Workers table. A new element on the Workers page is a
change to `packages/bun-jobs-ui/README.md`'s `### What each element needs`
table, which `examples/bun-jobs-ui/04-screens/permissions.ts` parses, so the
examples session is told before merge (`CLAUDE.md`).

`WORKER_EVENT_TYPES` gains nothing: a health change is a `state` event with a
reason, as `worker-runtimes.md` §8.4 decided.

---

## 13. Phases and effort

Focused days for someone who wrote the code, as in the other plans. Owners
by role.

### 13.1 The sub-phases

| Sub-phase | What | Effort (bun-jobs session) |
|---|---|---|
| **2a** | Everything `worker-runtimes.md` §11 Phase 2 already lists (~22.5 d), **plus**: the message protocol v1 with the text codec, per-frame MAC and test vectors (3 d); the gateway's attempt state machine with accept timeouts and re-attach by re-POST (1.5 d); the health model: liveness, readiness, canary, breaker inputs, health on the worker record (2.5 d); the execute facet's session shape, capabilities and registration check, net of the old facet work (1 d); `http-stream` with SSE framing, the first-frame rule, buffering probe and downgrade, and the SSE parser (2 d); `serveHttp` and the executor core's session entry (1.5 d); tests with the buffering and idle-cutting fakes and a SIGSTOP executor (1.5 d); docs: `PROTOCOL.md` core with appendices A and B, the selection guide, two user guides, the executor guide's first three sections (2 d); re-measuring the HTTP and SSE spikes on the shipped Bun release (0.5 d) | **~38 d** |
| **2b** | WebSocket forward, and the reliability layer's outbox and resume: the layer with bare acks and `status`/`status-result` (3.5 d); the `ws` client transport with bounded buffering and reconnect (2 d); `serveWebSocket` (1 d); tests: paused peers, backpressure, oversize, resume and outbox overflow (1.5 d); appendix C, user guide, worked executor (1 d); re-measure (0.5 d) | **~9.5 d** |
| **2c** | TCP, TLS and Unix sockets: the binary codec and sealing (HKDF, AES-GCM, anti-replay) (2 d); the `tcp` transport: queue and `drain`, framing, ALPN bytes, handshake timing, half-close, Unix (2.5 d); `serveTcp` (1 d); tests: chunker, 64 MiB paused reader, TLS, sealing vectors (1.5 d); appendix D, user guide, worked executor (1 d); the Python executor and its conformance run (1.5 d); re-measure (0.5 d) | **~10 d** |
| **2d** | Reversed and session-mode transports: the reverse listener, executor registry, capacity-gated claiming (2.5 d); `dialWebSocket`/`dialTcp` with backoff, `resumeAt` and drain (1.5 d); SSE session mode and `Last-Event-ID` re-attach from a retained-frame store (2 d); tests (1.5 d); docs (1 d) | **~8.5 d** |
| **2e** | UDP: retransmission, window, fragmentation and reassembly in the reliability layer (3 d); the `udp` transport: `connId`, rebinding, DNS, ICMP, handshake padding, stateless reset (1.5 d); `serveUdp` with its health port (1 d); `lossyUdpProxy` and its tests (2.5 d); appendix E with byte diagrams and vectors, user guide, worked executor (1.5 d); re-measure, and the tier-3 real-network run plan for Appendix B (0.5 d) | **~10 d** |
| **2f** | HTTP/2 flag: `fetch` protocol option, `Bun.serve({ http2 })` in `serveHttp`, multiplexing tests, appendix F and the informative `.proto` (appendix G) | **~1.5 d** |
| | **Phase 2 total** | **~77.5 d** (was ~22.5 d) |

**All six sub-phases are committed** (the user's decision, 2026-09-25,
Q-T1), and are built **in order: 2a, 2b, 2c, 2d, 2e, 2f**. 2b's reliability
layer is what 2c–2e build on; 2f depends only on 2a but is scheduled last.

**2a is the first milestone** (~38 d). It already reaches every platform with
an inbound HTTP path, with health, live progress and heartbeats wherever the
path streams, and an honest `degraded` where it does not, so it is a release
point; each later sub-phase adds its binding on top of what shipped.

**The execute stability gate** (`compute-provider-plugins.md` §10.4) covers
more than it did: the facet is proven transport-agnostic only when at least
one session-shape transport written outside the bun-jobs session passes the
kits too. The Acme Queue transport in the template does not count, because
the bun-jobs session writes it; the examples session's
`custom-session-transport.ts` (§11.6) qualifies at minimum.

### 13.2 Phases 3 and 4

| Phase | Change | Effort |
|---|---|---|
| **3** | The per-binding conformance: `conformRemoteExecutor` over every scheme, the CLI, and the fakes shipped in `./remote/testing` (3 d); `runExecuteConformance`'s session-shape and capability checks (1.5 d); the author guide's "Writing a transport" chapter with the Acme Queue transport in the template, and the broker mapping guide (appendix H) (1 d) | ~17 d → **~22.5 d** |
| **4** | Streaming progress and cancellation move into 2a (−3 d); per-binding bench scenarios, `push-loopback` for `http`, `http-stream`, `ws`, `tcp` and `udp` (2 d); the tier-3 real-network script for Appendix B (2 d); the X25519 forward-secret session mode (§4.4.5) is **not** costed here and needs its own decision (§15 Q-T3) | ~10 d → **~11 d** |

### 13.3 Other owners

| Owner | Work | Effort |
|---|---|---|
| the examples session | §11.6: nine examples and nine failure demos, landing with the sub-phase of their binding | ~6 d |
| the UI session | §12: the binding badge, health state and reason, canary result, session counts, the health filter; the README row | ~2 d |

### 13.4 Totals

| | Before | After |
|---|---|---|
| Phase 2 | ~22.5 d | **~77.5 d** |
| Phase 3 | ~17 d | **~22.5 d** |
| Phase 4 | ~10 d | **~11 d** |
| All phases, bun-jobs session (`worker-runtimes.md` §11) | ~108 d | **~169.5 d** |
| Other owners | ~14.5 d | **~22.5 d** |

The ~61.5 d added is the user's request in full. About 9.5 d of it is the
bun-jobs session's documentation (the examples session's ~6 d is on top), and
about 28.5 d is TCP, UDP and the reversed bindings (2c, 2d, 2e), whose reach
is narrow (§1.3).

---

## 14. Risks

- **The UDP reliability layer is a real protocol to maintain.**
  Retransmission timing, windows, congestion response and fragmentation are
  where transport protocols spend years. This one is kept deliberately
  small, measured only on loopback, and `experimental` until the tier-3 run.
  If it misbehaves on a real network, the fix is to narrow UDP's scope (small
  messages, private networks), not to grow it into QUIC.
- **The sealing is a hand-rolled secure channel.** HKDF, AES-GCM with a
  counter nonce and an anti-replay window are conventional, but the
  composition has had no cryptographic review, and the symmetric mode has no
  forward secrecy (§4.4.4). Mitigations: test vectors, the conformance
  checks, TLS wherever TLS exists (`tcp+tls://`, `wss://`), and an external
  review before UDP or `tcp://` leave `experimental`.
- **Everything in Appendix B is unmeasured**, and several design constants
  rest on those unknowns: the 1,200-byte datagram, the 10 s keepalive, the
  buffering probe's thresholds, the RTO's initial value.
- **The Bun build is a canary.** Every [M] row is `1.4.3-canary.1`. Each
  sub-phase re-runs its spikes on the shipped release first; a behaviour that
  changed changes the binding, not the other way round.
- **A CPU-bound handler blocks heartbeats** and is declared lost although it
  is working. Inngest runs its socket in a worker thread for exactly this
  reason [V-prior prior-art-survey §Inngest]. Mitigations: the docs say so in
  the executor guide; `attemptSilenceMs` is configurable; `ctx.heartbeat()`
  before a long step; and an executor option to run handlers in a `Worker`
  (Phase 4 hardening, not costed).
- **Per-frame MAC cost** is ~10–12 µs per frame with `crypto.subtle`
  [M A]. Heartbeats and batched acknowledgements make it negligible, but a
  handler that reports progress in a tight loop would not be:
  `job.updateProgress()` on an executor is coalesced to one frame per 100 ms
  per attempt [D].
- **Reverse mode makes the worker a server**, with a listener, a certificate
  and an address, which WR §5.2 chose HTTP push to avoid. The user guide says so
  before its first example.
- **No relay.** When neither side can accept a connection, bun-jobs offers
  only a broker plugin. That is a real gap for NAT-to-NAT deployments.
- **Double execution after a lost response** on store-less executors (§4.9).
  The design prevents double *settlement*, not a second run of the handler.
- **Surface.** Seven bindings times the conformance matrix is a lot to keep
  green. The single protocol core is the mitigation: a binding is framing and
  I/O, and most of its tests are the shared suite.
- **HTTP/2 in Bun is experimental**; the flag may need to be removed if it
  regresses.

---

## 15. Open questions

- ~~**Q-T1** Is ~77.5 d for Phase 2 acceptable, or should 2a ship first and
  2b–2f be scheduled on demand?~~ **Decided 2026-09-25 by the user: all of
  2a–2f is committed (~77.5 d), built in order 2a, 2b, 2c, 2d, 2e, 2f.**
  §13.1, T15 and `worker-runtimes.md` §11 carry the schedule.
- **Q-T2** UDP is always sealed (T13). Should an integrity-only mode exist
  for private networks where encryption is not wanted? It would save nothing
  measurable [M A].
- **Q-T3** Build the X25519 forward-secret mode (§4.4.5), and when? Before
  UDP leaves `experimental` is the natural point.
- **Q-T4** gRPC stays third-party. Should the repo carry a reference gRPC
  plugin in an unpublished directory (the `bench/` shape), so the session API
  is proven against it before the execute facet reaches 1.0?
- **Q-T5** Is a first-party relay permanently out of scope, or worth a plan of
  its own once reverse mode is in use?
- **Q-T6** The 10 s heartbeat keeps a streamed FaaS response billing and
  busy, which it already is while the attempt runs. Is 10 s right as the
  default, or should HTTP bindings default to 15 s?
- **Q-T7** The periodic canary costs an invocation every 5 min per session on
  per-invocation platforms (8,640 per month). Keep 5 min, or default to
  "at open and half-open only" on the HTTP bindings?
- **Q-T8** May the repo's tests use `python3` when present (skipped visibly
  otherwise) to run the polyglot executor?
- **Q-T9** The SSE session mode (§7.4 c) serves only single-instance
  executors behind HTTP-only paths. 2d is committed (Q-T1); the question is
  only whether this one component stays in its scope, or is replaced by
  per-attempt SSE with re-attachment, which 2a already has.
- **Q-T10** Should the URL scheme choose the binding (§8.1), or should
  `binding` always be explicit?
- **Q-T11** A lost attempt counts as an attempt (T8). The alternative is to
  treat it as a stall (`maxStalledCount`), which does not consume a retry.
  This plan prefers "counts", for parity with a crashed child process.
- ~~**Q-T12** Drop WR §4.2.8's rule that a target `timeout` above
  `lockDuration` is a `ConfigError`?~~ **Decided 2026-09-25 by the user: the
  rule is removed.** Its premise, "the lease would lapse mid-call", is false:
  the gateway renews the lease on its own timer for the whole remote call
  (`BunQueueWorker.ts:2228-2232`, `#heartbeat()` at `:3429-3458`) [S], and
  with heartbeat liveness a long `timeout` is what a long remote job needs.
  The decided text is at every site that stated the rule: WR §4.2.8
  (`timeout`'s JSDoc), WR §5.5 (`deadlineAt`, which was "derived from the
  lease"), WR §5.9, WR §8.2 (`endpointTimeout`) and WR §10.2 (the first row).
  **The `timeout` default** was derived from `lockDuration` for the same false
  reason. Proposed instead, **for the implementer to confirm**: the
  endpoint's reconciled `maxDurationMs` (the smaller of the transport's
  declaration and the remote's handshake). The job's own `timeout` still
  bounds each attempt, because the worker already wraps the target's `run()`
  in it (`BunQueueWorker.ts:2269-2274`) [S], so the effective bound is
  `min(job timeout, maxDurationMs)`. A fixed ceiling was considered and not
  proposed: no one figure suits both a 30 s Lambda and a 60 min Cloud Run
  request, while `maxDurationMs` is the platform's own. The reasoning is in
  WR §4.2.8.

---

## Appendix A: the crypto spike run for this plan

Run on 2026-09-25 with `bun --revision` → `1.4.3-canary.1+5f554969b`, the
same machine as `bun-transports.md`. Sequential calls, one process, loopback
not involved. The files are in the session scratchpad
(`scratchpad/p2design/crypto.ts`, `dns.ts`); the listing below is complete
enough to re-create them.

```ts
const enc = new TextEncoder();
const secret = enc.encode("x".repeat(32));
const hmacKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
// sign/verify 20,000 times at 64 B, 1,200 B, 16 KiB; time per call
// node:crypto createHmac("sha256", secret).update(msg).digest() 50,000 times at 1,200 B
const ikm = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
const aes = await crypto.subtle.deriveKey(
  { name: "HKDF", hash: "SHA-256", salt: enc.encode("session-nonces"), info: enc.encode("bun-jobs udp v1 g2e") },
  ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
// encrypt 1,200 B with a 12-byte IV and AAD; decrypt; flip one ciphertext byte and decrypt again
// X25519: generateKey ×2, deriveBits both ways, compare; Ed25519: sign and verify
// AbortSignal.timeout(250) and (1000): time to "abort"
// Bun.dns.lookup("localhost", { family: 4 }) and node:dns/promises lookup
```

| Result | Value |
|---|---|
| HMAC-SHA256 sign / verify, `crypto.subtle`, 64 B | 10.3 µs / 10.2 µs |
| same, 1,200 B | 11.5 µs / 12.2 µs |
| same, 16 KiB | 23.4 µs / 22.3 µs |
| `node:crypto` `createHmac`, 1,200 B | 1.7 µs |
| HKDF-SHA256 → AES-256-GCM | round-trips; 16-byte overhead; a flipped byte is rejected with `OperationError`; 11.8 µs per 1,200 B encrypt |
| X25519 | both sides agree; 32-byte public key |
| Ed25519 | 64-byte signature; verifies |
| ChaCha20-Poly1305 in `crypto.subtle` | encrypts in this canary build. Not relied on: `bun-transports.md` §4.14 records it absent from `node:crypto`, and AES-GCM is what every other language's standard tooling has |
| `AbortSignal.timeout(250)`, `(1000)` | fired at 250 ms and 1,001 ms |
| `Bun.dns.lookup("localhost", { family: 4 })` | `[{ address: "127.0.0.1", family: 4, ttl: 0 }]` |

**What this does not show.** The `crypto.subtle` figures are sequential and
include promise overhead; concurrent throughput was not measured. The
`node:crypto` figure is synchronous and not usable in a browser-safe core.

---

## Appendix B: what still needs a real network

Carried from both evidence files, plus the constants of this design that rest
on them. None of it can be measured on loopback, and none is closed.

| Unknown | Source | What in this design rests on it |
|---|---|---|
| UDP loss, reordering and duplication on a real path | [U bun §5.5] | The window, the RTO, `maxRetransmits` |
| Path MTU and fragmentation above ~1,472 bytes; through tunnels | [U bun §5.3] | The 1,200-byte datagram |
| Whether TCP keep-alive detects a silent partition, and how fast | [U bun §4.7, §4.8] | Nothing: the application heartbeat is primary. Confirms or refutes keep-alive as a backstop |
| How proxies treat HTTP/1.1 full duplex | [U bun §1.2] | Why the SSE session mode uses POSTs, not a streamed request |
| Whether Cloud Run's front end, ALB, ACA's Envoy and CloudFront buffer SSE or NDJSON | [U platform §5 item 2] | The buffering probe's value on those platforms |
| Whether an Azure Functions stream survives past 230 s | [U platform §5 item 3] | Whether Azure can host attempts over ~4 min at all |
| Cloudflare's WebSocket idle period; Spectrum's idle timeouts | [U platform §5 item 4] | The keepalive on Cloudflare paths |
| Fly's `http_options.idle_timeout` default; WebSockets through Fly's `http` handler | [U platform §5 item 5] | The keepalive on Fly |
| Whether GKE's default `gce` Ingress builds a classic or a global ALB | [U platform §5 item 9] | Whether `ws` works for long attempts on GKE |
| Lambda Function URL maximum request duration; Lambda MicroVM endpoint timeouts | [U platform §5 items 1, 10] | `maxDurationMs` for those |
| NAT rebinding and connection migration | [U bun "What only a real network can show"] | The UDP `connId` design |
| WebSockets on Azure Functions, Netlify, Cloud Run functions, App Runner | [U platform §5 item 8] | Rows of the selection guide |
| Whether `Bun.serve` serves h2c | [U, §7.9] | HTTP/2 to Cloud Run end to end |

The tier-3 script (`worker-runtimes.md` §7.2, costed in Phase 4 here) is
where these are measured, by someone with credentials, before a release; each
answer replaces a [U] in the selection guide and, where it changes a
constant, in this design.
