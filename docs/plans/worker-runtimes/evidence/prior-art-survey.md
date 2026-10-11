# Remote / off-process / serverless worker contracts — prior-art survey

Research date **2026-09-22**. Provenance is marked per system:

- **[SELF — PRIMARY]** I read the source/spec myself in this session.
- **[AGENT — PRIMARY]** A delegated research agent read primary sources (source files, protos, SQL, official docs) at a pinned version; exact file paths given so any line is spot-checkable. Second-hand but primary-source-based.
- **UNVERIFIED** items are called out explicitly throughout, and collected at the end.

Nothing below is filled in from model knowledge. Where a fact could not be closed from a primary source, the row says so.

---

# 1. INNGEST — the signed HTTP handler contract **[SELF — PRIMARY]**

Sources read: `github.com/inngest/inngest/blob/main/docs/SDK_SPEC.md` (HEAD, 2,259 lines); `inngest-js` `src/components/InngestCommHandler.ts`, `src/helpers/net.ts`, `src/helpers/strings.ts`, `src/helpers/consts.ts`; executor side `pkg/execution/driver/httpdriver/httpdriver.go`, `.../util.go`, `pkg/enums/opcode.go`; docs `/platform/signing-keys`, `/setup/connect`, `/usage-limits/inngest`, changelog `2025-06-20-connect`.

**`SDK_SPEC.md` is a normative RFC-2119 spec for exactly the artifact you are writing. Read it in full.**

## 1.1 One URL, three methods

"This endpoint MUST retain the same URL for all actions below, where only the request method will change and query string parameters added."

| Method | Meaning |
|---|---|
| `GET` | Introspection / health check — a versioned JSON capability document |
| `PUT` | **Trigger a Sync.** Body empty. Responds `{ message: string, modified: boolean }` |
| `POST` | Call Request — run a function or step |

**The inversion worth stealing: `PUT` does not carry the config — it is a doorbell.** On receiving it the SDK makes its *own* outbound `POST https://api.inngest.com/fn/register` carrying the config, authenticated with its signing key. The registration payload therefore always travels on a connection the SDK initiated, so the inbound `PUT` needs no trust at all. If a `deployId` query param was on the `PUT` it must be copied to the outbound POST query string (and must *not* appear in the payload's `url`) so the two halves correlate.

## 1.2 Request signing — exact bytes

Header **`X-Inngest-Signature`**, a query string with no leading `?`:

```
t=1705586504&s=3f1c811920eb25da7fa70e3ac484e32e93f01dbbca7c9ce2365f2062a3e10c26
```

`t` = unix **seconds**; `s` = hex HMAC-SHA256. From `inngest-js/src/helpers/net.ts`:

```js
const encoded = typeof data === "string" ? data : canonicalize(data);
const key     = signingKey.replace(/^signkey-[\w]+-/, "");   // strip "signkey-prod-"
hmac(SHA256, key).update(encoded).update(ts).digest("hex")
// native path: subtle.sign("HMAC", importKey(raw, TextEncoder().encode(key)),
//                          TextEncoder().encode(encoded + ts))
```

Three details a spec must nail:

1. **Message is `body ‖ timestamp`** — raw body bytes, then the ASCII decimal timestamp. No envelope, no newline join.
2. **The HMAC key is the ASCII text of the hex suffix, not decoded bytes.** `signkey-prod-12345678` → key is the 8 bytes `"12345678"`. Contrast the *bearer* token (§1.3), where the same suffix **is** hex-decoded before hashing. Two treatments of one string — a genuine footgun; diverge from it.
3. **If raw bytes are unavailable, canonicalize.** Spec: "if the raw bytes of the request body are inaccessible, the body should first be parsed using the JSON Canonicalization Scheme (JCS) as specified in RFC 8785." The escape hatch for frameworks that hand you a parsed object (Next.js, Lambda proxy events).

**Replay window: 5 minutes, clamped BOTH directions:**

```js
const delta = Date.now() - ts * 1000;
// Clamp both ends: negative delta (future-skewed `t`) would otherwise give
// captured requests an unbounded replay
return Math.abs(delta) > 1000 * 60 * 5;
```

That comment records a real fixed bug — a one-sided `delta > window` check lets an attacker replay forever with a future-dated `t`. Comparison is `timingSafeEqual`.

**Every auth failure is `500`, not `401`** — missing key, missing signature, expired timestamp, bad HMAC. Deliberate: no oracle distinguishing "wrong signature" from "no key configured", and a misconfigured deploy self-heals on retry.

## 1.3 Outbound auth — the bearer is a *hashed* key

```
signkey-prod-12345678
  → sha256(hex_decode("12345678"))
  → Authorization: Bearer signkey-prod-b2ed992186a5cb19f6668aade821f502c1d00970dfd0e35128d51bac4649916c
```

(`hashSigningKey`: `sha256().update(key, "hex").digest("hex")` — note `"hex"`, so here it *is* decoded.) One secret, two derivations; plaintext never crosses the wire either way.

## 1.4 Key rotation

`INNGEST_SIGNING_KEY` + `INNGEST_SIGNING_KEY_FALLBACK`. Try primary, catch, try fallback — and **return which key succeeded**, because the response is then signed with **the same key that validated the request**. During a rotation window each request/response pair is internally consistent with no coordination. Supported TS ≥3.18.0, Python ≥0.3.9, Go ≥0.7.2. (Vercel's integration does not auto-rotate.)

## 1.5 Response signing — partial answer

**The SDK does sign its responses**, on the same `x-inngest-signature` header, same `t=…&s=…` format, same construction over the response body (`getResponseSignature`, applied in `prepareActionRes`). Signing failure → `500` rather than an unsigned body.

`X-Inngest-Req-Version` is separate and mandatory on every Call Request response: **MUST be `2`**. Plus `X-Inngest-Sdk` (`inngest-js:v1.2.3`) — "Requests made or responses given to an Inngest Server without this header will be rejected."

**COULD NOT VERIFY:** (a) any header spelled `X-Inngest-Sig` — absent from the current spec and `headerKeys`; if it existed it is historical. (b) **Whether the Inngest executor verifies the response signature.** `httpdriver.go` *sets* `X-Inngest-Signature` on outbound requests; I found no response-signature verification there. It may live elsewhere in the partly-closed server. Treat "Inngest verifies responses back" as **unconfirmed**; what is confirmed is that the SDK sends one.

## 1.6 The Call Request body

`POST ?fnId=<composite id>` (optionally `&stepId=<hash>`):

```ts
{
  event: Event, events: Array<Event>,
  steps: { [hashedStepId: string]: { data: any } | { error: {name,message,stack?} } },
  ctx: {
    run_id: string,
    attempt: number,                      // 0-based
    disable_immediate_execution: boolean, // set once parallelism has been used
    use_api: boolean,                     // payload was trimmed; go fetch it
    stack: { stack: Array<string>, current: number }  // COMPLETION ORDER of steps
  }
}
```

**`ctx.use_api`** is the answer to platform body-size limits: when state exceeds what the host accepts, Inngest **trims the request** and sets the flag; the SDK then pulls the full payload itself via `GET {api}/v0/runs/:run_id/batch` (events) and `GET {api}/v0/runs/:run_id/actions` (steps), with the hashed-key bearer. Either failing → respond `500`.

**`ctx.stack.stack`** is the completion order. The SDK memoizes in *this* order rather than discovery order, which makes non-determinism detectable: if the next step in the stack can't be found, the code changed mid-run — warn, then fall back to a scan. The ordering array is a free drift detector.

## 1.7 Step opcodes; 206 vs 200

`206 Partial Content` + a JSON **array** = "mid-execution, here are ops to schedule". `200` = returned; body is the return value. Multiple array entries = parallelism.

```ts
Array<{ id: string; op: string; displayName?: string; opts?: Record<string, any> }>
```

| `op` | Shape | Memoized as |
|---|---|---|
| `StepPlanned` | `{id, op, displayName?}` | — (Inngest re-calls with `?stepId=<hash>`) |
| `StepRun` | `{id, op, data}` | `{data}` |
| `StepError` | `{id, op, error:{name,message,stack?}}` | `{error}` |
| `StepNotFound` | `{id, op}` | — (code changed, step gone) |
| `Sleep` | `opts:{duration: "2h45m" \| ISO-8601}` | `null` |
| `WaitForEvent` | `opts:{event, timeout, if?: <CEL>}` | **the whole event payload, not nested in `data`**; `null` on timeout |
| `InvokeFunction` | `opts:{function_id, payload}` | `{data}` / `{error}` |
| `AiGateway`, `Gateway` (HTTP fetch), `WaitForSignal` | per type | `{data}` / `{error}` |

Numeric values (`pkg/enums/opcode.go`): `None=0, Step=1, StepRun=2, StepError=3, StepPlanned=4, Sleep=5, WaitForEvent=6, InvokeFunction=7, AIGateway=8, Gateway=9, WaitForSignal=10, RunComplete=11, StepFailed=12, SyncRunComplete=13, DiscoveryRequest=14, DeferAdd, DeferAbort`. (The live Go enum now classifies `StepPlanned` as *sync*; SDK_SPEC §10.2 still lists it async — minor spec drift.)

**Step IDs: hex SHA-1 of a human-readable name.** `my-step-id` → `e7d8a2f140845095749d60246ff1110c9d01d76a`. Repeats within a run append `:n` before hashing (`my-step-id`, `my-step-id:1`, `my-step-id:2`; zero-index has no suffix) — that is how a step inside a loop stays addressable. Rationale given: "IDs are hashed to ensure a consistent length and format across multiple SDKs, allowing cross-language, cross-cloud migrations of Functions mid-Run." **A strong argument for content-addressed step IDs in any design where a foreign worker might resume another's run.**

**Immediate execution** (skip a round trip) requires all three: `ctx.disable_immediate_execution === false`, `stepId` query param literally `"step"`, and exactly one Run step discovered. Otherwise `StepPlanned` first.

## 1.8 Retry control — and the executor's real rule

| Situation | Status | Headers |
|---|---|---|
| Success | `200` | `X-Inngest-Req-Version: 2`, `X-Inngest-Sdk` |
| Steps reported | `206` | same |
| Retriable error | `500` | `X-Inngest-No-Retry: false` |
| Non-retriable | `400` | **`X-Inngest-No-Retry: true`** |
| Delayed retry | `500` | `Retry-After` + `X-Inngest-No-Retry: false` |

`Retry-After` is RFC 9110 **plus** RFC 3339 dates as an accepted alternative to HTTP-date.

Executor decision, verbatim from `httpdriver/util.go`:

```go
func ShouldRetry(status int, noRetryHeader, sdkVersion string) bool {
	// Always obey the no-retry header if it's set.
	if noRetryHeader != "" { return noRetryHeader != "true" }
	// In the absence of a no-retry header, this is only a no-retry response if
	// the status code is 4XX.
	if status < 400 || status > 499 { return true }
	... // then semver-gates on the X-Inngest-Sdk header
}
```

**Header wins; absent it, 4xx stops and everything else retries; an unparseable SDK version retries.** Every ambiguity resolves toward retrying — the right default for at-least-once. Also: a memoized `{error}` the developer lets propagate **MUST** be reported non-retriable, since the step already exhausted its own retries.

## 1.9 Introspection (`GET`)

Versioned by `schema_version` (current `"2024-05-24"`). **Signature-gated disclosure**: validate if the header is present; on success return the authenticated document, else the unauthenticated one.

- Unauthenticated: `authentication_succeeded: false | null` (**`false` = signed but invalid, `null` = unsigned** — a two-valued "no"), `function_count`, `has_event_key`, `has_signing_key`, `has_signing_key_fallback`, `mode: "cloud"|"dev"`, `capabilities?`, `extra?`.
- Authenticated adds `app_id`, `api_origin`, `event_api_origin`, `env`, `framework`, `sdk_language`, `sdk_version`, `serve_origin`, `serve_path`, and **`signing_key_hash` / `signing_key_fallback_hash` / `event_key_hash`** — sha256 hashes, so an operator can confirm *which* key an instance runs without the key leaving the box.

Forward-compat rule: "An SDK MUST NOT set any top-level keys not specified in the aforementioned schemas, with the exception of `capabilities`. An SDK MAY put any arbitrary data into the `extra` field."

`capabilities` is `{ "connect": "v1", "in_band_sync": "v1", "trust_probe": "v1" }` — **per-feature version strings, not one protocol version.** The right shape when third-party implementations will lag.

## 1.10 Function config sync (`POST /fn/register`)

```ts
{ url, deployType: "ping", appName, sdk: "inngest-js:v1.2.3", v: "0.1", framework?, functions: [...] }
```

Each function: `id` (composite), `name?`, `triggers: Array<{event, expression?} | {cron}>`, and `steps.step.runtime = { type: "http", url }` where the url is the serve url + `?stepId=step&fnId=<id>` — **the worker tells the server how to call it back, per function**. `steps.step.retries.attempts` default `4` (= 3 retries).

Policy fields, **declared by the worker, enforced by the server**:

- `concurrency`: number, or up to two `{ limit, key?: <CEL>, scope?: "fn"|"env"|"account" }`
- `throttle`: `{ limit, period, key?, burst? (default 1) }` — **queues** excess
- `rateLimit`: `{ limit, period, key? }` — **drops** excess *(the throttle/rateLimit split — delay vs discard — is a distinction most libraries blur; naming them differently is right)*
- `debounce`: `{ period, key?, timeout? }`; `batchEvents`: `{ maxSize (≤100), timeout "1s".."60s", key? }`
- `singleton`: `{ key?, mode: "skip"|"cancel" }`; `priority`: `{ run?: <CEL → −600..600> }` (seconds of queue-jumping)
- `cancel`: `[{ event, if?: <CEL with `event` and `async`>, timeout? }]`
- `timeouts`: `{ start?, finish? }` — schedule-to-start and start-to-close by another name
- `idempotency`: a CEL key; overrides `rateLimit`

All keys are **CEL expressions over the event**, which is what makes them expressible in JSON a foreign worker can emit.

Sync responses: `200 {ok:true, modified?:boolean}`; `400 {error:string}` = bad config *or* wrong server (dev SDK reached cloud, hence `X-Inngest-Expected-Server-Kind`, forwarded from the inbound `X-Inngest-Server-Kind`). **In-band sync** (`X-Inngest-Sync-Kind: in-band`, gated by `INNGEST_ALLOW_IN_BAND_SYNC`) ships registration on a normal execution response.

## 1.11 Inngest Connect — outbound WebSocket workers

Announced **2025-06-20**. TS ≥3.34.1, Go ≥0.11.2, Python ≥0.5.0. Protos: `proto/connect/v1/connect.proto`.

**Solves:** no public URL; no per-step HTTP round trip; no platform HTTP timeout on long steps; horizontal scale without inbound LB; workers become first-class dashboard objects. **Explicitly not for serverless** — requires a long-running process. Limits: 3 concurrent connections free, 20 paid, ≤10 apps per connection.

Sync payload changes one field: `runtime.type` becomes **`"ws"`**, `url` no longer required.

**Phase 1 — HTTP start.** `POST {api}/v0/connect/start`, `Content-Type: application/protobuf`, `Authorization: Bearer {hashedSigningKey}`. Body `StartRequest{exclude_gateways[]}` → `StartResponse{connection_id (ULID), gateway_endpoint, gateway_group, session_token, sync_token}`. Errors: `401` retry with fallback key, fatal if both fail; `429` fatal on first connect, retriable on reconnect; other retriable.

**Authenticate over HTTP with the long-lived secret, receive short-lived session tokens, then use those on the socket.** The durable secret touches one endpoint. Copy this.

**Phase 2 — handshake.** Sub-protocol **`v0.connect.inngest.com`**, 10s connect timeout, 10MB read limit. Envelope `ConnectMessage { GatewayMessageType kind = 1; bytes payload = 2; }`. Three steps: `GATEWAY_HELLO` (5s timeout; anything else aborts) → `WORKER_CONNECT` → `GATEWAY_CONNECTION_READY` (20s timeout).

`WorkerConnectRequestData` carries `connection_id`, `instance_id`, `auth_data` (session+sync tokens), `capabilities` (JSON), `apps[]` (`AppConfiguration{app_name, app_version?, functions: bytes /* JSON, same shape as HTTP sync */}`), `system_attributes`, `sdk_version`, `sdk_language`, `started_at`, `max_worker_concurrency`. **Registration and connection are the same act.**

`GatewayConnectionReadyData { heartbeat_interval, extend_lease_interval }` — **duration strings, server-chosen.** "These server-provided intervals govern all subsequent heartbeat and lease extension timing." The worker hard-codes nothing; the server retunes the fleet.

**`GatewayMessageType`:** `0 GATEWAY_HELLO`, `1 WORKER_CONNECT`, `2 GATEWAY_CONNECTION_READY`, `3 GATEWAY_EXECUTOR_REQUEST`, `4 WORKER_READY`, `5 WORKER_REQUEST_ACK`, `6 WORKER_REPLY`, `7 WORKER_REPLY_ACK`, `8 WORKER_PAUSE`, `9 WORKER_HEARTBEAT`, `10 GATEWAY_HEARTBEAT`, `11 GATEWAY_CLOSING`, `12 WORKER_REQUEST_EXTEND_LEASE`, `13 WORKER_REQUEST_EXTEND_LEASE_ACK`, `14 SYNC_FAILED`.

**Execution flow** on `GATEWAY_EXECUTOR_REQUEST` (`{request_id, account_id, env_id, app_id, app_name, function_id, function_slug, step_id?, request_payload /* the SAME JSON as the HTTP POST body */, system_trace_ctx, user_trace_ctx, run_id, lease_id}`):

1. **Ack receipt immediately** (`WORKER_REQUEST_ACK`) — separating "I have it" from "I'm done" lets the gateway redispatch fast on a dropped connection without waiting out the lease.
2. **Extend the lease** at `extend_lease_interval` with the current `lease_id`; the ack returns a **`new_lease_id`** that replaces it. Absent → stop extending. **A rotating lease token — a fencing token in all but name.**
3. Execute with identical logic to HTTP.
4. **`WORKER_REPLY`** with `SDKResponse{request_id, status: NOT_COMPLETED=0|DONE=1|ERROR=2, body /* JSON */, no_retry, retry_after? (RFC3339), request_version, run_id, …}`. Status maps **exactly** onto the HTTP codes: `DONE→200`, `ERROR→500`, `NOT_COMPLETED→206`. **One execution semantics, two transports — the most important structural decision in the design.**
5. Wait for `WORKER_REPLY_ACK` (5s timeout both SDKs).

**Heartbeats:** send at `heartbeat_interval`; **2 consecutive missed gateway heartbeats** ⇒ connection dead, reconnect (counter incremented on send, zeroed on receive).

**Reliable delivery:** pending-ack map (5s) → on timeout buffer → flush via **`POST {api}/v0/connect/flush`** with the protobuf `SDKResponse` as body, ≤5 retries with backoff, attempted before each reconnect, after each new connection, and during shutdown. **An HTTP fallback for the result of a WebSocket job — a dropped socket never loses completed work.** The best idea in Connect and cheap to copy.

**Gateway draining** (`GATEWAY_CLOSING`): establish the replacement connection first (excluding the draining `gateway_group`), migrate in-flight lease extensions onto the new socket, *then* close the old. Make-before-break.

**Graceful shutdown:** `WORKER_PAUSE` → drain pool → flush buffer → close code `1000`, reason `WORKER_SHUTDOWN`. **Reconnect backoff:** `[1s, 2s, 5s, 10s, 20s, 30s, 60s, 120s, 300s]`. **States:** `CONNECTING → ACTIVE → RECONNECTING / CLOSING → CLOSED`.

**Directly relevant to Bun:** the TS SDK runs the WebSocket in a `worker_threads` Worker by default (`INNGEST_CONNECT_ISOLATE_EXECUTION=true`) "to prevent user code from blocking heartbeats." A single-threaded runtime *will* miss heartbeats under a CPU-bound job. (Crash recovery: respawn 500ms→30s backoff, give up after 10 consecutive crashes.)

## 1.12 Checkpointing (newest)

Opt-in; sync config gains `{"checkpoint":{"batch_steps":0,"batch_interval":"3s","max_runtime":"0s"}}`. Sync opcodes are POSTed to **`{api}/v1/checkpoint/{runID}/async`** *without yielding the HTTP response*, so N steps cost one invocation. On any async opcode (`Sleep`, `WaitForEvent`, `InvokeFunction`, `Gateway`, …) the SDK **must** stop and fall back to the `206` yield. `qi_id` (from `ctx.qi_id`) lets the server reset the retry counter per checkpoint. On any checkpoint-API error but 401, **fall back to returning all buffered steps in the 206** — the optimisation can never lose a run.

## 1.13 Limits

1,000 steps/function · 4 MiB per step output · 32 MiB run state · step timeout up to **2 hours** · run duration 30d/90d/366d by plan · sleep up to 1 year · event payload 256 KiB–3 MiB by plan · 5,000 events/request · batch 10 MiB.

## 1.14 (a)–(e)

- **(a)** One URL; `GET` introspect, `PUT` sync doorbell, `POST` invoke. Every request HMAC-signed over `body‖timestamp`, 5-minute two-sided window. Responses `200` / `206` (opcode array) / `4xx|5xx` + `X-Inngest-No-Retry`. State arrives in the request, keyed by SHA-1 of the step name; the worker holds nothing. Alternatively the same semantics over an outbound WebSocket with identical status mapping.
- **(b)** **Push**, with Connect as an inverted-transport option — but Connect is still *server-dispatched*; the socket solves reachability, not scheduling.
- **(c)** HTTP mode: **no lease** — the HTTP request *is* the lease; retries driven by status. Connect: explicit `lease_id` extended at a server-dictated interval, returning a **new** id each time, 2-missed-heartbeat death detection, plus the HTTP flush fallback.
- **(d)** One `signkey-<env>-<hex>` used two ways: HMAC key (suffix as ASCII) inbound, `sha256(hex_decode(suffix))` as bearer outbound. Rotation via a fallback key; responses signed by whichever key validated the request.
- **(e) COPY:** the whole shape — one URL/three methods, `t=…&s=…` over `body‖timestamp` with a **two-sided** clamp, content-addressed step IDs, `206`-with-opcodes, `X-Inngest-No-Retry` + `Retry-After`, signature-gated introspection with per-feature `capabilities` and key *hashes*, and Connect's HTTP-flush fallback.
- **(e) AVOID:** using one secret two different ways (ASCII for HMAC, hex-decoded for the bearer hash).

---

# 2. FAKTORY — the documented language-agnostic wire protocol **[SELF — PRIMARY]**

Sources: `github.com/contribsys/faktory/blob/main/docs/protocol-specification.md` (518 lines); `server/commands.go`; `manager/working.go`; wiki `Worker-Lifecycle`, `Security`. **Latest release v1.10.0, published 2026-08-10.**

**The model for "a remote system adheres to a contract".** Short, RFC-2119, scoped ("FWP does not dictate how work units are scheduled or executed"), written explicitly "from the point of view of the implementor of an FWP client."

## 2.1 Transport

TCP port **7419**. Commands are **CRLF-terminated lines**: verb, optional space, optional args. Responses are **Redis RESP** — reusing existing, trivially-parseable, binary-safe framing rather than inventing one. Errors are RESP Errors. URL `tcp://` or `tcp+tls://` with password in userinfo, read from `FAKTORY_URL`, or indirected via `FAKTORY_PROVIDER` naming another env var (so a PaaS can inject `FAKTORYTOGO_URL`).

"Clients MUST follow the syntax outlined in this specification strictly. It is a syntax error to send a command with missing or extraneous spaces or arguments." One command at a time per connection, untagged.

## 2.2 The work unit

**Three required fields only:** `jid` (String, globally unique), `jobtype` (String — "discriminator used by a worker to decide how to execute a job"), `args` (Array).

Optional: `queue` (default `"default"`), **`reserve_for`** (Integer 60+, default **1800**), `at` (RFC3339), `retry` (default **25**; `0` discards, `-1` → dead set), `backtrace` (default 0), `created_at`, `custom` (free-form JSON hash). Server-set read-only: `enqueued_at`, `failure`.

Three required fields is the right number, and **`jobtype` as a string discriminator** is what makes the protocol language-agnostic — the server never needs to know what a job means.

## 2.3 States

`SCHEDULED` →(`at` elapses)→ `ENQUEUED` →(`FETCH`)→ `WORKING` →(`ACK`)→ gone; `WORKING` →(`FAIL` **or reservation expiry**)→ `RETRIES` → `ENQUEUED`, or `DEAD` when retries exhaust.

## 2.4 Connection lifecycle

Five states: **Not Identified → Identified → (Quiet) → (Terminating) → End.**

**`HI`** (server greets first): `+HI {"v":2}`, plus `{"i":<iterations>,"s":"<salt>"}` when a password is required.

**`HELLO`** (client, MUST be first). Required `v: 2`. For a protected server, `pwdhash` = hex of the `i`-th iterated SHA-256:

```
hash = password + s
for 0..i { hash = sha256(hash) }
hex(hash)
```

Consumers must also send `hostname`, **`wid`**, `pid`, `labels: [String]`. Multiple connections may share a `wid`, but then "the same `hostname`, `pid`, and `labels` values MUST be provided in all the `HELLO` commands."

The spec's examples are literal transcripts (`S: +HI {"v":2}` / `C: HELLO {"v":2}` / `S: +OK`). **For a wire protocol, worked transcripts are worth more than prose — include them.**

## 2.5 Commands

Spec'd: **`HELLO`, `END`, `INFO`, `FLUSH`** (all); **`PUSH`** (producer); **`FETCH`, `ACK`, `FAIL`, `BEAT`** (consumer).

Present in `server/commands.go` at HEAD but **absent from the spec document**: `PUSHB` (bulk push), `MUTATE`, `BATCH`, `TRACK`, `QUEUE` (with `LATENCY`/`PAUSE`/`RESUME`/`REMOVE`). A cautionary tale: the normative spec has drifted behind the implementation.

**`FETCH [queue...]`** → Bulk String (job JSON) | **Null Bulk String** (nothing) | Error. Queues checked **in the order given**, first hit wins — priority by argument order, no server-side config. "If no work units are found, `FETCH` will block for up to 2 seconds on the *first* queue provided."
**Discrepancy found:** spec and wiki say **2 seconds**; `server/commands.go` uses `context.WithTimeout(ctx, 5*time.Second)`. Also a quiet/terminating client that calls `FETCH` gets `time.Sleep(2*time.Second)` then nil — the server rate-limits a misbehaving worker rather than erroring.

"If a work unit is returned from `FETCH`, the client MUST subsequently send either an `ACK` or `FAIL` for the `jid`… A client SHOULD send at most one `ACK` or `FAIL` for a given job."

**`ACK {"jid": "..."}`** → `+OK`.
**`FAIL {"jid","errtype","message","backtrace":[...]}`** → `+OK`. **Structured failure, not a string** — so a dashboard can group by error class across languages. (Wiki: capped at 1000 bytes / 30 backtrace lines by default.)

**`BEAT {"wid","current_state","rss_kb"}`** → `+OK` | **a Bulk String `{"state":"quiet"|"terminate"}`** | Error.

**The cleverest part of the protocol: the heartbeat is bidirectional control in a single round trip** — liveness up, the server's shutdown intent down, no second channel, no server→client push (the server "MUST send data only as a result of a client command", except `HI`).

```
C: BEAT {"wid": "4qpc2443vpvai","rss_kb":54176}
S: +OK
C: BEAT {"wid": "4qpc2443vpvai","rss_kb":55272}
S: +{"state": "quiet"}
C: BEAT {"wid": "4qpc2443vpvai","current_state": "quiet"}
S: +{"state": "terminate"}
C: END
S: +OK
```

Note `current_state` going *up*: a worker that receives SIGTSTP/SIGTERM locally reports its own transition.

**Timing:** consumers MUST BEAT; SHOULD NOT more often than every **5s**; MUST at least every **60s**; **15s recommended**. Wiki: "After 60 seconds without a beat, Faktory will remove them from the Busy page." **"Clients that are not consumers MUST NOT send `BEAT` commands"** — a producer-only connection is explicitly a different animal.

**Quiet:** stop fetching, **MUST NOT terminate, MUST keep beating.** Wiki: "Once a worker has been quieted, it must be terminated. You can't 'unquiet' a worker."
**Terminating:** stop fetching, "SHOULD issue a `FAIL` for any currently executing jobs within 30 seconds", MUST reach End within 30s. (Wiki says 25s — more drift.) **Failing your own in-flight jobs on shutdown is correct and rarely implemented** — it returns them to `RETRIES` immediately instead of waiting out a 30-minute reservation.

**`END`:** "the server will close the connection immediately. There is no response to read." Asymmetry: "A server MUST NOT unilaterally close the connection to a consumer without sending a Quiet or Terminating response to a `BEAT`… The server is allowed to unilaterally close the connection to clients that are not consumers."

## 2.6 Reservations — the lease

From `manager/working.go`:

```go
timeout := job.ReserveFor
if timeout == 0  { timeout = DefaultTimeout }   // 1800s
if timeout < 60  { timeout = 60 }               // floor
if timeout > 86400 { timeout = 86400 }          // ceiling: 1 day
exp := now.Add(timeout * time.Second)
```

A `Reservation{Job, Since/reserved_at, Expiry, Wid}` goes into a **Redis sorted set scored by expiry**; `ReapExpiredJobs` sweeps by score in batches of 10 and re-enqueues.

There **is** a lease extension (`ExtendReservation(jid, until)`), but it is **in-memory only**, applied lazily at reap time — "Since modifying the score of a SortedSet member is an expensive operation in Redis, we keep the latest deadline in memory and extend the reservation when it expires." Cheap, but does not survive a server restart.

**`jid` is NOT a fencing token.** From `manager.Acknowledge`:

```go
res := m.clearReservation(jid)
if res == nil {
    util.Infof("No such job to acknowledge %s", jid)
    return nil, nil
}
```

A late `ACK` — from a worker whose reservation expired and whose job has already been re-enqueued and possibly re-run — is a **silent no-op**. The worker never learns it lost the race. Faktory is honestly at-least-once with no stale-worker rejection.

## 2.7 (a)–(e)

- **(a)** CRLF line protocol over TCP/7419, RESP responses. `HELLO`(+`pwdhash`) → `FETCH q1 q2` → execute a job identified only by a `jobtype` string and `args` → `ACK {jid}` or `FAIL {jid, errtype, message, backtrace}`; `BEAT {wid}` every ~15s whose *response* carries the quiet/terminate directive; `END`.
- **(b)** **Pull**, 2s (spec) / 5s (impl) blocking `FETCH`. No inbound reachability needed.
- **(c)** Per-job reservation (`reserve_for`, default 1800s, clamped 60s–86400s), expiry-scored sorted set swept by a reaper, expiry → `RETRIES`. Liveness is the separate `BEAT` (5s min / 15s recommended / 60s max). Extension exists but is in-memory and lazy. **No fencing.**
- **(d)** Optional password: server sends `{i, s}` in `HI`, client returns hex of the `i`-th iterated `sha256(password + salt)`. Password never crosses the wire; iteration count server-chosen; salt per-connection. TLS via `tcp+tls://`. No per-job auth, no ACLs.
- **(e) COPY:** BEAT-response-as-control-channel; the three-required-fields job with a `jobtype` string discriminator; structured `FAIL` with `errtype`; queue priority by argument order; `FETCH` returning null rather than an error when idle; a terminating worker FAILing its own in-flight jobs; and the literal `C:`/`S:` transcripts.
- **(e) AVOID:** a silently-ignored late ACK — make the ack carry a lease token the server can reject with an explicit `LeaseLost`; and don't let the normative spec drift behind the implementation the way FWP has.

---

# 3. GOOGLE CLOUD TASKS **[AGENT — PRIMARY, docs.cloud.google.com, accessed 2026-09-22]**

**(a)** An HTTPS URL. One request per attempt with the task's own method/body/headers plus metadata headers: `X-CloudTasks-QueueName`, `X-CloudTasks-TaskName`, `X-CloudTasks-TaskRetryCount`, `X-CloudTasks-TaskExecutionCount`, `X-CloudTasks-TaskETA`, and on retries `X-CloudTasks-TaskPreviousResponse`, `X-CloudTasks-TaskRetryReason`. App Engine targets use `X-AppEngine-*` plus `X-AppEngine-FailFast`. Cloud Tasks overrides `Host`, `Content-Length`, `User-Agent: Google-Cloud-Tasks`, and reserves `X-Google-*`/`X-AppEngine-*`. Defaults: POST, `Content-Type: application/octet-stream`, headers ≤80 KB, URL ≤2083 chars.

**Worth stealing: `RetryCount` counts dispatches, `ExecutionCount` counts dispatches that produced a response** — their difference is the number of attempts that timed out. Two counters, one free diagnostic.

**The ack is the status code:** "If the worker… returns a successful HTTP response code (200–299), the task will be removed from the queue. If any other HTTP response code is returned or no response is received, the task will be retried." `429`/`503` (or a high error rate) trigger a higher backoff rate, and `Retry-After` is honoured. On App Engine targets `503` additionally throttles the queue's whole dispatch rate; `429` does not.

**(b)** Pure push. **Pull queues are gone** — the migration guide lists "Pull queues" under features not available, pointing at Pub/Sub. v2 has no `leaseTasks`/`acknowledgeTask`/`renewLease`. *(UNVERIFIED: whether `v2beta2` still exposes `leaseTasks`.)*

**(c)** No lease, no heartbeat, no extend call. `dispatchDeadline` only: **HTTP targets default 10 minutes, range 15s–30 minutes**, fixed at task creation. App Engine: `0` = env default (10min standard/automatic, 24h manual/basic, 60min flex), else 15s–24h15s. The sharp edge, verbatim: *"when the request is cancelled, Cloud Tasks will stop listening for the response, but whether the worker stops processing depends on the worker."* **No mutual exclusion at all**; idempotency is the only defence. Tasks deleted after 31 days. No ordering; duplicates explicitly expected.

**Backoff, exactly:** `minBackoff`, doubled `maxDoublings` times, then **linear**, then clamped at `maxBackoff`. Official example (min 10s, max 300s, maxDoublings 3): **10, 20, 40, 80, 160, 240, 300, 300, …** Bounded by `maxAttempts` (−1 = unlimited) and `maxRetryDuration` (from first attempt).

**Flow control is two numbers:** `maxDispatchesPerSecond` (≤500) and `maxConcurrentDispatches` (≤5,000), plus pause/resume and a deliberate slow ramp after idle. `maxBurstSize` is output-only, derived.

**(d)** Per-dispatch minted tokens: `oidcToken{service_account_email, audience}` (audience defaults to the target URI) or `oauthToken{service_account_email, scope}`, in `Authorization`. OIDC for your own handlers, OAuth only for `*.googleapis.com`. On Cloud Run the platform validates signature+audience before your code runs (`roles/run.invoker`).

**Important correction to a common belief:** the header-stripping guarantee is documented **only for App Engine** targets. For a generic HTTP target there is no Google edge in front of your URL and **no such guarantee**. `X-CloudTasks-*` is metadata, never authentication.

**Named-task dedup:** identical id to an existing/recently-deleted/executed task → `ALREADY_EXISTS`. Window is **24 hours (or 9 days for queue.yaml-created queues)**, not ~1 hour (that is the legacy App Engine figure). Costs: "significantly increased latency" per create, and **sequential ids degrade the whole queue** — "The infrastructure relies on an approximately uniform distribution of task ids"; hash your ids.

**(e) COPY:** attempt metadata in headers (so the worker is a plain HTTP endpoint with no SDK), 2xx-is-the-ack, and the five-field declarative retry policy with the doubling-then-linear curve.
**(e) AVOID:** a deadline that can neither be extended nor actually stop the worker; and named-task dedup with a 24h–9d tombstone and a sequential-id performance cliff.

---

# 4. AWS SQS + LAMBDA EVENT SOURCE MAPPING **[AGENT — PRIMARY, docs.aws.amazon.com, accessed 2026-09-22]**

**(a)** Two layers. Raw SQS: `ReceiveMessage` (long poll ≤20s, ≤10 messages) → body + a **per-receive** `ReceiptHandle` + `ApproximateReceiveCount`; ack with `DeleteMessage(ReceiptHandle)`; nack early with `ChangeMessageVisibility(handle, 0)`; or let the lease lapse. Lambda ESM: AWS runs the poller, your function gets a batch, and **the return value is the ack**.

**(b)** Pull at the protocol level, disguised as push by the managed ESM. **The structurally important trick:** the same queue serves an in-process poller and a serverless function, because the serverless integration is *just a hosted poller plus a response-shaped ack*. It needed no second protocol. The strongest argument in the survey for making pull/lease the core and push a thin adapter.

**(c) Visibility timeout.** Default **30s**, per-queue and per-message, starts on delivery. `ChangeMessageVisibility` extends it — AWS documents the heartbeat pattern explicitly. But: **maximum 12 hours from *first* receive, and "Extending the timeout doesn't reset this 12-hour limit."** Not mutual exclusion: "Amazon SQS doesn't guarantee that a message won't be delivered more than once within the visibility timeout period."

**Receipt handles are NOT fencing tokens.** From the `DeleteMessage` API reference, verbatim:

> *"If you receive the same message more than once, you will get a different `ReceiptHandle` each time… you must use the `ReceiptHandle` from the most recent time you received the message. **If you use an old `ReceiptHandle`, the request will succeed, but the message might not be deleted.**"*

A stale delete returns **HTTP 200 and silently does nothing**. And "Amazon SQS can delete a message from a queue even if a visibility timeout setting causes the message to be locked by another consumer." `ChangeMessageVisibility` *does* surface an invalid handle; `DeleteMessage` does not.

**The ESM does not heartbeat.** `AWSLambdaSQSQueueExecutionRole` grants only `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` (+ logs) — **no `ChangeMessageVisibility`**. Hence the folklore constant: *"set the source queue's visibility timeout to at least six times the configuration timeout on your function"* (+ `MaximumBatchingWindowInSeconds`). Lambda hard-validates function timeout ≤ queue visibility timeout.

**`ReportBatchItemFailures`** — enable via `--function-response-types "ReportBatchItemFailures"`:

```json
{ "batchItemFailures": [ { "itemIdentifier": "id2" }, { "itemIdentifier": "id4" } ] }
```

`itemIdentifier` is the **`messageId`**, not the receipt handle. Verbatim rules — complete success on: empty list, null list, empty `EventResponse`, null `EventResponse`. **Complete failure** on: invalid JSON, empty `itemIdentifier`, null `itemIdentifier`, bad key name, **or an `itemIdentifier` whose message id doesn't exist**. A thrown exception fails the whole batch. FIFO: "stop processing messages after the first failure and return all failed **and unprocessed** messages." Side effect: with it enabled "Lambda doesn't scale down message polling when function invocations fail." AWS's debugging hint: `NumberOfMessagesDeleted` at 0 means your response shape is wrong.

**Batching/scaling:** batch ≤10,000 standard / 10 FIFO (>10 requires a ≥1s window); the 6 MB invoke payload caps it. Batch window ≤5min, standard only — but "might wait for up to 20 seconds" at low traffic. Standard queues start at 5 concurrent invocations, scale by **+300/min**, max **1,250** per ESM. `MaximumConcurrency` 2–1,000. Provisioned mode: `MinimumPollers` 2–200, `MaximumPollers` 2–10,000 (the console page says 2–2,000 — AWS's docs contradict themselves).

**DLQ:** `maxReceiveCount` counts **receives, not failures** — a crash before ack burns an attempt like a thrown error. Lambda recommends ≥5. Standard-queue gotcha: the DLQ does **not** reset the enqueue timestamp, so a DLQ needs *longer* retention than its source (FIFO does reset it). With `maxReceiveCount > 3`, a message received 3+ times goes to the *back* of the queue, distorting `ApproximateAgeOfOldestMessage`.

**FIFO "exactly-once" is dedup at *send*, not receive** — a 5-minute `MessageDeduplicationId` window (or content hash of the body only). A consumer that crashes mid-work still gets it again.

**(d)** SigV4 on every API call; IAM both sides; nothing carried in the message. When AWS pushes to an HTTPS worker (SNS) it switches to **payload signature verification** (`SignatureVersion` 1/SHA1 or 2/SHA256), "you must verify the signature before processing any Amazon SNS messages", including `Subscribe`/`Unsubscribe` confirmations; validate the cert chain and "Reject any message with an unexpected `TopicArn` to prevent spoofing."

**(e) COPY:** the extendable lease + the partial-batch ack shape with its "empty list = all good, unknown id = whole batch fails" strictness, and the broker-counted receive-count → DLQ → redrive-back loop.
**(e) AVOID:** an advisory lease token whose stale use returns success. Make the ack take a monotonic lease token and return an explicit `LeaseLost`. And avoid the ESM's non-heartbeating poller whose entire correctness story is "6×".

---

# 5. TEMPORAL **[AGENT — PRIMARY: protos, server source, docs]**

## 5.1 Contract

`temporal.api.workflowservice.v1.WorkflowService`. **Poll** (long-poll, unary, one task/call): `PollWorkflowTaskQueue`, `PollActivityTaskQueue`, `PollNexusTaskQueue`. **Respond**: `Respond{Workflow,Activity,Nexus}Task{Completed,Failed,Canceled}` (+ `…ById` variants), `RespondQueryTaskCompleted`. **Lifecycle**: `RecordActivityTaskHeartbeat` (+ById), `RecordWorkerHeartbeat`, `ShutdownWorker`.

`PollActivityTaskQueueResponse` carries `task_token`, `input`, **`heartbeat_details`** (the resumption channel), `attempt`, and all four timeouts inline. `RecordActivityTaskHeartbeatResponse` returns **`cancel_requested`**, `activity_paused`, `activity_reset`.

**Two piggyback optimisations worth stealing:** `RespondWorkflowTaskCompletedResponse` can return `workflow_task` (the entire *next* poll response, when `return_new_workflow_task` is set) **and** `activity_tasks[]` (eagerly dispatched activities). Completing a task and receiving the next is one round trip. **A pull protocol does not have to pay a poll per task.**

## 5.2 Long-poll timings

`common/dynamicconfig/constants.go`: `MatchingLongPollExpirationInterval = time.Minute`; `HistoryLongPollExpirationInterval = 20s`. Docs: "The effective timeout on this call will be shorter of the caller-supplied gRPC timeout and the server's configured long-poll timeout." Empty poll returns success with an empty `task_token`; the worker re-polls. *(The empty-token convention is observed SDK behaviour; no verbatim doc sentence was found. The 60s is verified from source.)*

## 5.3 Task tokens — fencing tokens

`bytes` on the wire; internally a protobuf in the **server's** internal API, `proto/internal/temporal/server/api/token/v1/message.proto`, `message Task`:

```
namespace_id, workflow_id, run_id, scheduled_event_id (int64), attempt (int32),
activity_id, workflow_type, activity_type, clock (VectorClock),
started_event_id (int64), version (int64), started_time, start_version,
component_ref (bytes), activity_attempt_stamp (int32)
```

**No signing or encryption** — plain protobuf, opaque by convention only. Validation in `service/history/api/respondactivitytaskcompleted/api.go`:

```go
if !isRunning || api.IsActivityTaskNotFoundForToken(token, ai, &isCompletedByID) {
    return nil, consts.ErrActivityTaskNotFound
}
```

Mechanism, from the CHASM activity package docs: `activity_attempt_stamp` "is an int32 that represents the attempt stamp captured when the current worker started the attempt… a task token issued at start remains valid until that attempt completes", and it is "incremented on each new attempt and on options updates, so that in-flight tasks from the previous attempt or pre-update state are discarded." *(The body of `IsActivityTaskNotFoundForToken` is **UNVERIFIED** — the file 404'd.)*

**The design split worth copying: the task token is not the credential.** Authn/authz is per-connection; the token only identifies and fences.

## 5.4 Four timeouts; which is the lease

| Timeout | Meaning | Default |
|---|---|---|
| **Schedule-To-Start** | queue → pickup; detects a starved worker fleet | infinity |
| **Start-To-Close** | max for ONE attempt — **the lease** | none (strongly recommended) |
| **Schedule-To-Close** | total across retries | infinity |
| **Heartbeat** | max interval between heartbeats; `0s` disables | none |

**No extend-lease RPC — the heartbeat *is* the renewal.** With a heartbeat timeout set, the effective lease is the heartbeat interval.

**Client throttle confirmed at 80%:** the smaller of `heartbeatTimeout * 0.8` and `maxHeartbeatThrottleInterval`. Defaults: throttle 30s, max 60s. App code can heartbeat in a tight loop; the SDK coalesces.

**Cancellation only arrives on the heartbeat:** "Activity Cancellations are delivered to Activities from the Temporal Service when they Heartbeat. Activities that don't Heartbeat can't receive a Cancellation." Same structural trick as Faktory's `BEAT`.

## 5.5 Sticky queues

```protobuf
message TaskQueue {
    string name = 1; TaskQueueKind kind = 2;   // default NORMAL
    // Iff kind == STICKY, this contains the name of the normal task queue
    // that the sticky worker is running on.
    string normal_name = 3;
}
message StickyExecutionAttributes {
    TaskQueue worker_task_queue = 1;
    google.protobuf.Duration schedule_to_start_timeout = 2;
}
```

The worker returns `sticky_attributes` on completion naming a worker-private queue; the server then sends that workflow's next task there with **incremental history only** (the worker still has the object cached). Missing `schedule_to_start_timeout` → re-dispatched on the normal queue with full history. `ShutdownWorker` tells the server a sticky queue is dead so it doesn't wait out the timeout. **A cache-affinity hint with a short-timeout fallback, never a correctness mechanism** — the right shape for any worker that caches run state.

## 5.6 Worker versioning

A **Worker Deployment Version** = deployment name + Build ID, reported via `deployment_options` on every poll *and* every completion. Two behaviours sent as `versioning_behavior` on completion: **PINNED** ("guaranteed to complete on a single Worker Deployment Version") and **AUTO_UPGRADE** ("will move to the latest Worker Deployment Version automatically"). Routing: a **Current Version** plus an optional **Ramping Version** taking a percentage in [0,100]. Drainage lifecycle **Inactive → Active → Draining → Drained**.

**GA 2026-03-30** across all SDKs (`temporal.io/blog/ga-worker-versioning-public-preview-upgrade-on-continue-as-new`), with **Upgrade on Continue-as-New** in public preview. *(UNVERIFIED: removal of experimental Build-ID versioning in March 2026; min server/SDK versions.)*

## 5.7 Serverless workers — Temporal now supports this

**Announced 2026-07-17.** Docs `docs.temporal.io/serverless-workers`. **Public Preview** on Temporal Cloud.

**The model is push-to-start, then pull — and it required no protocol change at all.**

A **Worker Controller Instance (WCI)** — itself a system Workflow — watches task-queue conditions. When a task cannot sync-match to an existing poller, the WCI "triggers the configured compute provider to start a Worker." The invoked Lambda then creates an ordinary Temporal client and **polls the task queue as usual**, works, and exits.

> task submitted → Matching tries sync match → no poller → WCI signalled → provider invoked → worker starts, polls, works, exits

**The most important structural finding in the survey.** Temporal got serverless workers by making the *scheduler* able to summon compute while the worker contract stayed what it was — the same conclusion AWS reached with the Lambda ESM.

- **Providers**: AWS Lambda (Public Preview); Amazon Bedrock AgentCore Runtime and GCP Cloud Run Worker Pools (Pre-release).
- **Auth to your compute is IAM role assumption, not a token**: "Temporal assumes an IAM role in your AWS account to invoke a Lambda function" with `lambda:InvokeFunction` + `lambda:GetFunction`, and the trust policy uses an **ExternalId condition to prevent confused-deputy attacks**. Separate from the Lambda execution role.
- **Config comes from env vars, not the invocation event**: `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`, `TEMPORAL_API_KEY`, `TEMPORAL_TLS_CLIENT_CERT_PATH`/`…_KEY_PATH`. **The docs never specify a Lambda event payload shape** — the architecture implies the event carries no task data. *(UNVERIFIED but strongly implied.)*
- TypeScript handler:
  ```ts
  export const handler = runWorker({ deploymentName: 'sdk-demo', buildId: 'v1' }, (config) => {
    config.workerOptions.taskQueue = TASK_QUEUE;
    config.workerOptions.workflowBundle = { codePath: require.resolve('./workflow-bundle.js') };
    config.workerOptions.activities = activities;
  });
  ```
  Tuned-down defaults: `maxConcurrentActivityTaskExecutions: 2`, `maxConcurrentWorkflowTaskExecutions: 10`, `maxConcurrentLocalActivityExecutions: 2`, `shutdownGraceTime: 5s`, **`shutdownDeadlineBufferMs: 7000`** ("how much time before the Lambda deadline the Worker begins its graceful shutdown"). Recommended Lambda timeout 600s; docs warn the 3s default "is too short for the Worker to start, connect to Temporal, and register the Task Queue."
- **Limits**: "an Activity must finish within the invocation limit (15 minutes maximum), minus the shutdown deadline buffer." **Workflow duration: no limit** — a workflow spans many invocations. **Eager Activities not supported**: "Lambda invocations don't maintain persistent connections." *(Sticky-queue behaviour under serverless undocumented.)*
- Blog scale claim: 100,000 workflows, 0→4,000 workers, ~$10 of Lambda at list price. SDKs: Go, Python, Java, .NET, TypeScript.

**`shutdownDeadlineBufferMs` is small and worth copying outright:** a serverless worker must *begin* graceful shutdown before the platform's deadline, not at it.

## 5.8 Nexus

Cross-team/namespace/cluster operations "whose lifetime may extend beyond a traditional RPC." Handlers are polled like everything else (`PollNexusTaskQueue` → `RespondNexusTaskCompleted/Failed`); a **Nexus Endpoint** is a reverse proxy forwarding to an upstream namespace + task queue.

**There is an HTTP variant.** The frontend exposes `POST /nexus/endpoints/{endpoint}/services/{service}/{operation}`, implementing the **Nexus over HTTP** spec (Temporal uses the Nexus Go SDK; `nexus.NewHTTPHandler`). Async completion arrives on `/namespaces/{namespace}/nexus/callback`. Nexus tasks have their own token type. *(Nexus auth UNVERIFIED.)*

## 5.9 Auth

Cloud mTLS (client certs), or API keys → gRPC metadata `authorization: Bearer <key>` plus a `temporal-namespace` header *(lightly verified — the api-keys page doesn't state the header)*. Max key expiry 2 years, shown once. Self-hosted: **`ClaimMapper`** (default JWT requires a `permissions` claim of `"<namespace>:<read|write|worker|admin>"`) + **`Authorizer`**. **Footgun, verbatim:** "If you do not explicitly configure an `Authorizer`, Temporal uses the default `noopAuthorizer`. This default allows every API request, with no authentication or access control."

## 5.10 (a)–(e)

- **(a)** One gRPC service; long-poll (≤60s, one task/call) → work → respond, keyed by an opaque attempt-fenced `task_token`. `RecordActivityTaskHeartbeat` carries liveness, progress checkpoints and cancellation in one RPC. User data is `Payloads`, never interpreted by the server.
- **(b)** **Pull**, with two push-shaped optimisations inside it, plus (since 2026-07) a genuine push *trigger* where the invoked worker still pulls.
- **(c)** Lease = start-to-close per attempt, shortened to the heartbeat timeout. No extend RPC. Heartbeat `details` handed to the next attempt as `heartbeat_details`. SDK throttles at 80%. Stale completions fenced by `attempt` + `activity_attempt_stamp`.
- **(d)** mTLS or Bearer + `temporal-namespace`; self-hosted ClaimMapper/Authorizer (default allows everything). Serverless uses IAM role assumption with an ExternalId.
- **(e) COPY:** the long-poll pull contract with an attempt-fenced opaque token whose **heartbeat is simultaneously the lease renewal, the progress checkpoint and the cancellation channel** — and the 2026 serverless model where the scheduler summons compute rather than inventing a second protocol.
- **(e) AVOID:** four overlapping timeouts as the only knobs, and unsafe defaults (`noopAuthorizer`, unset start-to-close).

---

# 6. HATCHET **[AGENT — PRIMARY: protos on `main`, PRs, tag v0.53.6]**

## 6.1 The Dispatcher service

`api-contracts/dispatcher/dispatcher.proto`, verbatim:

```protobuf
service Dispatcher {
    rpc Register(WorkerRegisterRequest) returns (WorkerRegisterResponse) {}
    rpc Listen(WorkerListenRequest) returns (stream AssignedAction) {}
    rpc ListenV2(WorkerListenRequest) returns (stream AssignedAction) {}
    rpc Heartbeat(HeartbeatRequest) returns (HeartbeatResponse) {}
    rpc SendStepActionEvent(StepActionEvent) returns (ActionEventResponse) {}
    rpc SendBatchActionEvent(BatchActionEvent) returns (ActionEventResponse) {}
    rpc RefreshTimeout(RefreshTimeoutRequest) returns (RefreshTimeoutResponse) {}
    rpc ReleaseSlot(ReleaseSlotRequest) returns (ReleaseSlotResponse) {}
    rpc RestoreEvictedTask(RestoreEvictedTaskRequest) returns (RestoreEvictedTaskResponse) {}
    rpc UpsertWorkerLabels(...) rpc Unsubscribe(...) rpc GetVersion(...) rpc PutOverridesData(...)
    rpc SubscribeToWorkflowEvents(...) rpc SubscribeToWorkflowRuns(...) rpc SendGroupKeyActionEvent(...)
}
```

**Registration declares capacity and capability — which is what makes push safe:**

```protobuf
message WorkerRegisterRequest {
    string worker_name = 1;
    repeated string actions = 2;          // action ids this worker can run
    repeated string services = 3;
    optional int32 slots = 4;             // concurrency capacity
    map<string, WorkerLabels> labels = 5;
    optional string webhook_id = 6;       // <- vestige of webhook workers
    optional RuntimeInfo runtime_info = 7;
    map<string, int32> slot_config = 9;   // per-action slot limits
}
```

**Dispatch is a server stream.** `AssignedAction` carries `action_id`, `action_type`, `action_payload` (JSON string), `task_id`, `task_run_external_id`, `retry_count`, `priority`, batch fields. `enum ActionType { START_STEP_RUN, CANCEL_STEP_RUN, START_GET_GROUP_KEY, START_BATCH }` — **cancellation is a pushed message on the same stream.**

**Results are unary, one call per transition**: `StepActionEvent { …, event_type, event_payload, retry_count?, should_not_retry? }` with `StepActionEventType { UNKNOWN, STARTED, COMPLETED, FAILED, ACKNOWLEDGED, CANCELLED }`. Note **`should_not_retry`** — Inngest's `X-Inngest-No-Retry` as a field.

**`RefreshTimeout(task_run_external_id, increment_timeout_by)` is an explicit extend-the-lease RPC** (a duration string, e.g. `"15m"`) — exactly what Temporal deliberately lacks. Plus `ReleaseSlot`, `RestoreEvictedTask`.

`ListenV2` marks the worker active when the stream opens and inactive when it closes, with a dedicated thread sending `Heartbeat` every **4 seconds** *(lightly verified — SDK docs, not a proto comment)*. PR #4916 "guard worker `isActive` using a session id instead of just a timestamp" shows liveness is **session-id based, not timestamp based** — a good correction to copy.

**Logs and streaming output are first-class RPCs on the same channel**: `PutLog(task_run_external_id, created_at, message, level?, metadata, task_retry_count?)` and `PutStreamEvent(…, bytes message, event_index?)`.

## 6.2 v1 vs v0; durable execution

Terminology moved **step run → task**; the proto shows the migration mid-flight. A **second dispatcher**, `api-contracts/v1/dispatcher.proto`, service `V1Dispatcher`, handles durable execution: `DurableTask` (bidi), `RegisterDurableEvent` (deprecated after `DurableEventLog`), `ListenForDurableEvent`. Messages include `DurableTaskMemoRequest` (keyed memos + invocation tracking), `DurableTaskWaitForRequest`, `DurableTaskEvictInvocationRequest`, `DurableTaskServerEvictNotice`, `DurableTaskErrorResponse` (nondeterminism).

**Hatchet's replay state lives server-side as a memo log, and a durable task can be evicted mid-wait and later restored (`RestoreEvictedTask`).** That is how a `sleepFor(7 days)` doesn't hold a slot — materially different from Inngest's stateless re-invocation and Trigger.dev's CRIU checkpointing, and arguably the cheapest of the three.

`PushEvent`: `Push(PushEventRequest{key, payload /*JSON*/, event_timestamp, additional_metadata?, priority?, scope?}) → Event`, plus `BulkPush`, `ReplaySingleEvent`.

## 6.3 Webhook workers — what they were, what happened

**What they were (v0):** docs page `v0-docs.hatchet.run/home/features/webhooks` *(the live site's TLS cert has EXPIRED; read from the repo at tag `v0.53.6`)*. Hatchet let you "run workflows in serverless environments like AWS Lambda, Vercel, GCP Cloud Functions, and CloudFlare Workers", with "first-class support only in the Typescript and Go SDKs". Introduced by **PR #542 "feat: webhook workers" (steebchen), merged 2024-06-25**, 130 commits, closing issue #347 "Serverless support". The PR TODO shows the intended design: webhook signature verification and header handling, plus a healthcheck that would "call API route before starting" and "ping continuously", **whose response carries `Actions` and `Workflows` arrays**.

**COULD NOT BE VERIFIED — state this plainly:** the exact v0 wire protocol. The signature header name (`x-hatchet-signature` appears only in secondary/SEO sources; the `HMACAuth` struct in the repo belongs to Hatchet's *inbound* webhook validation, a different feature), the request body shape, and whether results returned in the HTTP response or over gRPC. `internal/services/dispatcher/dispatcher.go` at `v0.53.6` contains no webhook POST, no signature header, no signing code.

**What happened.** Three verified points: (1) `optional string webhook_id = 6;` **still exists** in `WorkerRegisterRequest` on `main`; (2) `HMACAuth` is documented on pkg.go.dev as "part of the old generics-based v1 Go SDK" and deprecated; (3) **`docs.hatchet.run/v1/webhooks` is a completely different feature** — *inbound* webhooks that **trigger** tasks (Stripe/GitHub/Slack sources, CEL like `'stripe:' + input.type`). No webhook-worker page in v1 docs, and no page saying they were removed. **UNVERIFIED whether formally removed or merely undocumented.**

## 6.4 What is replacing them — read this first

- **PR #4910, "engine-side gRPC operator support for out-of-process operators" (abelanger5) — opened 2026-09-07, MERGED 2026-09-22 (today).** 64 commits, branch `belanger/grpc-operator`. Adds `api-contracts/operators/operators.proto` *(file 404'd; messages UNVERIFIED)*. Operators are "basically just workers with some special and lower-level capabilities" — they can "decompose durable tasks into async request/response streams". Service `OperatorService` with two bidi streams, `Listen` and `DurableTask`. Tenant-scoped, uses the existing `HATCHET_CLIENT_TOKEN`, gated by `SERVER_GRPC_OPERATORS_ENABLED=true`.
- **PR #4949, "feat: serverless typescript sdk" — opened 2026-09-11, still OPEN and marked DRAFT.** Branch `belanger/serverless-ts-core`, adds `sdks/typescript-serverless/` (`src/handler/{action,context,contract,errors,freshness,healthcheck,http,nonce-set,registry,signature,trigger}.ts`, `src/handler/durable/{frames,invocation,socket,transport}`, `src/adapters/cloudflare.ts`, `LIMITATIONS.md`, `examples/serverless/cloudflare-workers/`). Demo: `github.com/abelanger5/cloudflare-serverless-demo`. **Do not cite as shipped.**

### The new serverless-endpoint protocol (draft, fully specified in-branch)

**The most directly copyable design in the survey — it is your project, being built, this month.**

- **Push over plain HTTP POST** from a Hatchet operator to your endpoint. **Two routes: healthcheck and trigger.** Registration is REST: `POST /api/v1/stable/tenants/$TENANT_ID/serverless/endpoints` with the healthcheck URL, trigger URL and signing secret; returns an endpoint id and an assigned **namespace** (workflow names and event keys prefixed `<namespace>_`).
- **Signing: HMAC-SHA256 over the raw body.** Header **`X-Hatchet-Signature`**, alongside **`X-Hatchet-Timestamp`** and **`X-Hatchet-Endpoint-Id`**. Verification order: signature over raw body → parse JSON → timestamp within **`REQUEST_MAX_AGE_SECONDS = 5 * 60`** **in either direction** (401, `retry: false`) → endpoint id match (403). **Independently lands on the same two decisions as Inngest: a 5-minute window, clamped both directions.**
- **Envelope** (`api-contracts/v1/serverless.proto`), serialized as **protojson** ("lowerCamelCase field names, int64 values as decimal strings, bytes as base64 and enums as names"):
  ```protobuf
  message ServerlessTriggerRequest {
      string endpoint_id; string namespace;
      AssignedAction action;   // the SAME AssignedAction as the gRPC dispatcher
      int64 timestamp;         // Unix seconds at which the request was built
      int32 version;           // currently 1
  }
  message ServerlessHealthcheckRequest  { endpoint_id, namespace, timestamp }
  message ServerlessHealthcheckResponse { workflows, actions, durable, runtime }
  message ServerlessTriggerError        { string error; optional bool retry; }
  ```
  **Reusing `AssignedAction` verbatim is the key move: one task representation, two transports.**
- **The HTTP status code is the protocol:** `200`+JSON success with output · `204` success, undefined return · `400` malformed/unsupported version/missing action · `401` bad signature or stale timestamp · `403` endpoint id mismatch · `404` no task served for that action id · `405` non-POST · **`422` `NonRetryableError`, a serverless-limitation error, or a durable task sent to the plain trigger route ("upgrade me")** · `500` retryable, body `{"error": "..."}`.
- **The endpoint declares its own workflows on healthcheck**: `{ workflows: <CreateWorkflowVersionRequest[] canonical protobuf>, actions: <sorted served action ids>, durable: {supported}, runtime: {name, sdkVersion} }`. **Registration is pull-from-the-endpoint, not a separate deploy step** — contrast Inngest's outbound `POST /fn/register`. This one needs no outbound credential at all.
- **Durable tasks ride a WebSocket** upgraded from the same endpoint, with **`X-Hatchet-Nonce`**, **`X-Hatchet-Task-Id`**, **`X-Hatchet-Invocation`**. The upgrade signature payload is `endpointId . timestamp . nonce . taskId . invocation` joined with dots, and **the nonce is consumed from a bounded in-memory set to stop replay**. Frames: `ServerlessFirstFrame { action, namespace, invocation_count, inline_wait_budget_ms }`, then `DurableTaskRequest`/`DurableTaskResponse` (**the same messages as the gRPC stream**), `ServerlessErrorFrame`, `ServerlessDoneFrame { output, error, status, retry }`. So `ctx.now`, `ctx.sleepFor`, `ctx.waitForEvent`, `ctx.spawnChild` are RPCs back over the socket.
- **`LIMITATIONS.md` is itself worth copying as an artifact.** No gRPC client inside the runtime, so non-durable child spawning, streaming, cancellation, worker slots and labels throw `ServerlessLimitationError` — an *explicit, typed* "this transport cannot do that". Durable frames capped at **4 MiB**. Bundle is ~40 SDK modules + `@bufbuild/protobuf` + `zod`, edge-compatible, with a `scripts/check-edge-entry.mjs` CI guard.

## 6.5 (a)–(e)

- **(a)** gRPC: `Register` (actions, slots, labels) → `ListenV2` stream of `AssignedAction` → unary `SendStepActionEvent`, with `RefreshTimeout`, `ReleaseSlot`, `RestoreEvictedTask`, `PutLog`/`PutStreamEvent` on the same channel. New HTTP variant: signed POST of a protojson-wrapped `AssignedAction`, status code as the result, plus a signed WebSocket upgrade for durable tasks.
- **(b)** Push over a worker-initiated stream.
- **(c)** Heartbeat every ~4s; liveness session-id based; `RefreshTimeout` is an explicit lease extension; durable tasks evicted and restored rather than holding a slot.
- **(d)** Tenant-scoped `HATCHET_CLIENT_TOKEN` in gRPC metadata; per-endpoint HMAC secret + nonce for serverless.
- **(e) COPY:** one task representation over **both** transports, the status-code-as-result table (incl. `422` = "wrong route, upgrade"), healthcheck-as-registration, the per-upgrade nonce from a bounded set, and a written `LIMITATIONS.md` of typed errors.
- **(e) AVOID:** shipping a serverless transport, leaving it undocumented across a major version, and reusing its name for an unrelated feature — Hatchet is now rebuilding what it had in 2024.

---

# 7. BULLMQ **[AGENT — PRIMARY: `master` @ v6.3.8]**

## 7.1 Sandboxed processors — "the child never touches Redis" is CORRECT

And can be stated more strongly: **the child never touches Redis *and* never holds a live `Job`.** It receives a plain serialized object; every mutating method on it is replaced by an IPC sender, and the **parent** performs the Redis write.

Files: `src/classes/{worker,child-pool,child,main,main-worker,main-base,child-processor,sandbox,job,lock-manager}.ts`, `src/enums/{child-command,parent-command}.ts`, `src/commands/{extendLock-2,moveStalledJobsToWait-9}.lua`, `docs/gitbook/guide/workers/{sandboxed-processors,stalled-jobs}.md`.

Main-file resolution (`worker.ts` ~L320-345): `path.join(path.dirname(module.filename || __filename), 'main-worker.js' | 'main.js')`, falling back to `process.cwd() + '/dist/cjs/classes/<main>.js'`. `ChildPool` defaults to `dist/cjs/classes/main.js` or `dist/esm/classes/main.js` by CJS detection. `CHILD_KILL_TIMEOUT = 30_000`.

**Both enums are numeric** (wire values are integers, not strings):

```
ChildCommand  = Init, Start, Stop, GetChildrenValuesResponse,
                GetIgnoredChildrenFailuresResponse, GetDependenciesCountResponse,
                MoveToWaitingChildrenResponse, Cancel, GetDependenciesResponse
ParentCommand = Completed, Error, Failed, InitFailed, InitCompleted, Log,
                MoveToDelayed, MoveToWait, Progress, Update, GetChildrenValues,
                GetIgnoredChildrenFailures, GetDependenciesCount,
                MoveToWaitingChildren, GetDependencies
```

*(Declaration order = wire value, since they are bare `enum`s. If you depend on the numbers, re-read the two files — member order is verified, an explicit numeric assertion is not.)*

- **Init handshake:** `{cmd: Init, value: processFile}` → child `await import(...)`, **requires a function default export** → `{cmd: InitCompleted}` or `{cmd: InitFailed, err: errorToJSON(err)}` **then `process.exit()`**. A failed-init child is never reusable; `ChildPool.retain` also SIGKILLs it.
- **Start:** `{cmd: Start, job: job.asJSONSandbox(), token}`
- **Cancel:** `{cmd: Cancel, value: signal.reason}` → child calls `abortController.abort(reason)`; **the processor receives the `AbortSignal` as its 3rd argument.**
- **Result:** `{cmd: Completed, value: result ?? null}` / `{cmd: Failed, value: errorToJSON(err)}`. **Wart:** `ParentCommand.Error` carries the error under `err` not `value`, so `sandbox.ts` reads `msg.value ?? msg.err`. Do not reproduce.
- `uncaughtException` → `{cmd: Failed, value: errorToJSON(err)}` then `process.exit()`. `SIGTERM`/`SIGINT` → `waitForCurrentJobAndExit()`.

**Serialization:** `job.asJSONSandbox()` = `{...this.asJSON(), queueName, queueQualifiedName, prefix}` (`job.ts` L518). `asJSON()` keeps `data`/`returnvalue` as JSON **strings**; the child re-parses in `wrapJob`.

**Proxying back — fire-and-forget:** `updateProgress` → `{cmd: Progress, value}` (also sets `this.progress` locally so a sync read works); `log` → `{cmd: Log}`; `moveToDelayed` → `{cmd: MoveToDelayed, value:{timestamp, token}}`; `moveToWait`; `updateData` → `{cmd: Update, value: data}`.
**Request/response:** the child generates `requestId = Math.random().toString(36).substring(2,15)`, sends `{requestId, cmd, value}`, then `waitResponse(requestId, receiver, RESPONSE_TIMEOUT, name)` where **`RESPONSE_TIMEOUT = process.env.NODE_ENV === 'test' ? 500 : 5_000`**. The parent replies `{requestId, cmd: <X>Response, value}`. Covers `moveToWaitingChildren`, `getChildrenValues`, `getIgnoredChildrenFailures`, `getDependenciesCount`, `getDependencies`. **Any throw inside the parent's `msgHandler` rejects the whole job.**

**Worker threads:** `useWorkerThreads: true`, added in **v3.13.0** — "still not as lightweight as we could expect since Node's runtime needs to be duplicated by every thread." `Child.pid` uses `Math.abs(worker.threadId)` because thread ids go negative after termination.

**Directly relevant to bun-jobs:** `parent.stdout?.pipe(...)` is null-guarded with a source comment citing **bullmq#2232 — Bun ignores `worker_threads` stdin/stdout/stderr options.** Plan for that rather than piping child stdio.

Context: **BullMQ v6.0.0 shipped 2026-07-30** with pluggable queue backends (`IQueueBackend`, Redis **and PostgreSQL**), removed legacy repeatables, made ioredis an optional peer.

## 7.2 Fencing and the stalled sweep — with one refinement to the claim

Defaults (`worker.ts` constructor): `lockDuration: 30000`, `stalledInterval: 30000`, `maxStalledCount: 1`, `concurrency: 1`, `drainDelay: 5`, `runRetryDelay: 15000`, `autorun: true`, `lockRenewTime = opts.lockRenewTime || lockDuration / 2` (15_000). The constructor **throws** if `maxStalledCount < 0` or `stalledInterval <= 0`. Worker identity: `this.id = randomUUID()`.

The lock is `<prefix>:<queue>:<jobId>:lock` whose **value is the worker's job token**, with a PX expiry.

`extendLock-2.lua`, verbatim:

```lua
-- KEYS[1] 'lock', KEYS[2] 'stalled'; ARGV: token, lockDuration(ms), jobId
if rcall("GET", KEYS[1]) == ARGV[1] then
  if rcall("SET", KEYS[1], ARGV[1], "PX", ARGV[2]) then
    rcall("SREM", KEYS[2], ARGV[3])   -- also un-marks it as maybe-stalled
    return 1 end end
return 0
```

**Renewal is an atomic compare-and-set on the token, returning 1/0 so the caller learns it lost the lock**, and it clears the `stalled` set entry in the same script.

**REFINEMENT — act on this.** The `moveToFinished` half of the fencing claim was **inferred, not read**: `moveToFinished-*.lua` was not opened, and the exact lock-mismatch error strings were not verified. Either narrow the claim to what is quotable — "renewal is an atomic compare-and-set on the token inside `extendLock-2.lua`" — or open `src/commands/moveToFinished-*.lua` before asserting the completion half. The only error string quotable verbatim is the stalled one below.

Renewal loop: `src/classes/lock-manager.ts` — a `setTimeout` chain every `lockRenewTime / 2`, batching all due jobs into one `extendLocks-1.lua` call. Failures emit `lockRenewalFailed` + `error`; successes `locksRenewed`. `lockRenewTime: 0` disables renewal. *(UNVERIFIED: whether `extendLocks-1.lua` differs materially from `extendLock-2.lua`.)*

**`moveStalledJobsToWait-9.lua` is a two-pass mark-and-sweep** (run every `stalledInterval` from `worker.ts` L1379-1382):

1. **Guard.** `SET stalledCheckKey ts PX maxCheckTime` with an early `return {}` if present ⇒ **with N workers only one sweeps per interval.** No thundering herd, no coordination service.
2. **Sweep.** `SMEMBERS stalled`; `DEL stalled`. For each id: **re-check that `<job>:lock` does not exist** (a live lock means not stalled); if truly stalled `LREM active 1 jobId`; if that removed something `HINCRBY job stc 1`; if `stc > maxStalledCount` and it isn't a job-scheduler job, set `defa = "job stalled more than allowable limit"`; then `moveJobToWait` with `RPUSH` + `XADD events * event stalled jobId`.
3. **Mark.** `LRANGE active 0 -1`; `SADD stalled <ids>` in batches of 7000.

**The property that beats a plain expiry check:** a job is stalled only if it was in `active` at the *previous* sweep **and** its lock is gone *now* — one full interval of grace plus the lock TTL, never a single missed renewal. A plain "lock expired ⇒ stalled" check kills a job on one slow tick.

**BullMQ Pro:** groups (round-robin across unlimited groups, "as if you had a virtual queue per group", with rate limiting as a core feature of groups) and observables (state machines, clean cancellation, proper TTL).

**(a)** In-process Redis client via Lua, with an optional child_process/worker_thread sandbox whose contract is a numeric-enum IPC protocol. **(b)** Pull. **(c)** 30s token lock, compare-and-set renewal at 15s, two-pass mark-and-sweep every 30s under a single-sweeper key, `maxStalledCount` 1 then fail. **(d)** Redis credentials; no per-worker identity or authz.
**(e) COPY:** the token-checked-in-Lua renewal (an ack/renewal that can **fail** with "you lost the lock"), the two-pass mark-and-sweep with its guard key, and the sandbox rule that the child touches only IPC verbs.
**(e) AVOID:** `maxStalledCount` 1 paired with a lock a CPU-bound child can starve; and the `Error`-carries-`err`-not-`value` inconsistency.

---

# 8. BULLMQ-PROXY **[AGENT — PRIMARY: `main` @ v1.5.3 + docs.bullmq.net]** — citable, with caveats

`github.com/taskforcesh/bullmq-proxy`. MIT. **`"private": true` — not published to npm**; distributed as a Docker image.

**It is written in Bun.** `Bun.serve`, `bun src/index.ts`. The architecture page states the runtime choice is "mostly due to its much better HTTP and WebSocket performance and memory consumption than … NodeJS." Directly quotable.

**Maintenance status:** last **feature** release **v1.5.3, 2025-02-15**; every commit since is dependency/CVE maintenance (latest 2026-07-28). 87 stars. The README roadmap still has unchecked boxes for queue actions, job actions, flows, dynamic rate-limit, manual consumption, global queue events. **A working prototype frozen ~19 months** — cite as a design reference and existence proof, not a maintained product.

**REST surface:**

```
POST   /queues/:queueName/jobs                     addJobs         authByTokens
GET    /queues/:queueName/jobs                     getJobs         authByTokens
GET    /queues/:queueName/jobs/:jobId              getJob          authByTokens
POST   /workers                                    addWorker       authByTokens
GET    /workers                                    getWorkers      authByTokens
DELETE /workers/:queueName                         removeWorker    authByTokens
POST   /queues/:queueName/jobs/:jobId/progress     updateProgress  authForWorkers
POST   /queues/:queueName/jobs/:jobId/logs         addLog          authForWorkers
GET    /queues/:queueName/jobs/:jobId/logs         getLogs         authByTokens
```

`addJobs` takes a JSON **array** of `{name, data, opts}` → `queue.addBulk`. `getJobs` defaults `start=0&length=10&statuses=waiting,active,completed,failed`.

**The worker endpoint is a webhook registration, not a connection:**

```ts
interface WorkerMetadata {
  queue: string;
  endpoint: { url: string; method: "post"|"get"|"put"|"delete"|"patch";
              headers?: Record<string,string>; timeout?: number /* ms */ };
  opts?: WorkerSimpleOptions;  // BullMQ WorkerOptions MINUS connection, lockDuration,
                               // lockRenewTime, stalledInterval, useWorkerThreads — server-owned
}
```

**One worker per queue** — re-POSTing replaces it. Note which options are withheld: **everything about the lease is server-owned and not negotiable by the remote worker** — the consequence of the push model.

Registration is fanned out across replicas by Lua: `HSET bmqp:w:meta <queue> <json>` + `XADD bmpq:w:stream MAXLEN 100 * worker <queue>`. Every proxy runs an `XREAD BLOCK 5000` loop, re-reads the hash, compares a **sha256 of the metadata JSON**, and rebuilds the Worker if changed. *(Config bug in source: `workerMetadataStream` reads `WORKER_METADATA_KEY`, the same env var as the hash key.)*

**Job delivery** — the proxy runs a real BullMQ Worker in-process whose processor is an HTTP call:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), workerEndpoint.timeout || 3000);   // DEFAULT 3000ms
const response = await fetch(workerEndpoint.url, {
  method: workerEndpoint.method, headers: workerEndpoint.headers,
  body: JSON.stringify({ job: job.toJSON(), token }),
  signal: controller.signal,
});
if (!response.ok) throw new Error(response.statusText);
return response.headers.get('content-type')?.includes('application/json')
  ? response.json() : response.text();
```

Body is `{job: JobJson, token: string}` where **`token` is the job's Redis lock token**. Success = `response.ok` (200–299 in source; **the docs say "between 200 and 209" — source wins**). Non-ok throws → normal BullMQ retry/backoff. Timeout default **3s**; the docs note the proxy only *requests* abort, and flag API Gateway 30s / Lambda 15min ceilings.

**The best idea in the repo — `authForWorkers`:** the callback routes read `Authorization: Bearer <token>` and compare it to `GET <prefix>:<queueName>:<jobId>:lock`. **The bearer must equal the current lock token of that exact job.** One Redis GET, and the credential is one job wide and dies with the lease. Everything else uses `authByTokens` — a static bearer from `AUTH_TOKENS`, no scopes, no per-queue ACL.

**WebSocket side (implemented, undocumented):** `/ws/queues/:queueName`, `/ws/queues/:queueName/process/:concurrency`, `/ws/queues/:queueName/events`. `WorkerController.open` creates a real Worker whose processor RPCs over the socket: proxy→client `{"id": <int>, "data": {"type":"process","payload": job.data}}`; client→proxy `{"id": <same>, "data": {"result": …}}` or `{"id": …, "data": {"err": {message, stack}}}`. Default `messageTimeout: 15000`. **Two anti-patterns worth citing:** (i) **only `job.data` crosses** — no id, no attempts, no token, so a WS worker cannot report progress or logs; the two transports are not semantically equivalent. (ii) `route.auth` is only set by `addHttpRoute`, so **the WS routes appear to have no auth check** *(read as such in `fetch-handler.ts`; no test or doc confirms either way — say "appears unauthenticated in source")*. The Bun client also connects to `${host}/queues/:q/process/:c` while the server route is `/ws/queues/…` — one is stale.

Config: `AUTH_TOKENS`, `PORT` (8080), `QUEUE_PREFIX` (`bull`), `REDIS_*`, `QUEUE_CACHE_SIZE` (100), `WORKER_METADATA_KEY`, `MAX_LEN_WORKER_METADATA_STREAM` (100).

**(a)** Register a webhook per queue over REST; the proxy POSTs `{job, token}` to your URL and treats the HTTP response as the job result; side-channel REST calls for progress/logs authenticated by the job's own lock token. **(b)** Push. **(c)** All leasing stays server-side; the remote worker has no heartbeat obligation and cannot extend anything — its only deadline is the endpoint `timeout`, default 3s. **(d)** Static bearer for the control plane; per-job lock token for callbacks; WS appears unauthenticated.
**(e) COPY:** the per-job capability token.
**(e) AVOID:** making the HTTP response the only completion signal with a **3-second default** and no ack or heartbeat — any job longer than one request is unrepresentable.

**Dashboards:** bull-board mounts via framework adapters (express|fastify|koa|hapi|nestjs|hono|h3|elysia|**bun**) or standalone. Both it and taskforce.sh are effectively **Redis readers** — no worker-side agent, no control plane; bull-board writes only for its opt-in 90-day metrics store. *(bull-board verified from its README; **taskforce.sh is inference from the product description, not source-verified**.)*

---

# 9. TRIGGER.DEV **[AGENT — PRIMARY: `main` @ v4.6.4, released 2026-09-22]**

**Deployment.** `npx trigger.dev@latest deploy` bundles `trigger/` and builds a **container image** (remote build provider by default). A deploy creates a date-based **version** (`20250228.1`) freezing all tasks; **a run is locked to the current version when it starts and its retries stay there**. `--skip-promotion` + `promote` decouples deploy from promotion. Pinning via `trigger(payload, {version})` or `TRIGGER_VERSION`. `triggerAndWait`/`batchTriggerAndWait` auto-lock children to the parent's version; `trigger`/`batchTrigger` do not.
Runtimes: Node 21.7.3 (default), node-22 22.16.0, node-24 24.18.0, node-26 26.4.0, and **`bun` 1.3.3, officially "experimental"**.

**Checkpoint/restore — CRIU, and it survived into v4, but not for self-hosters.** A running container is frozen *from outside* via `docker checkpoint create` (local) or `crictl checkpoint` through the CRI (K8s); in K8s the tar is wrapped into an **OCI image with Buildah** and pushed to a registry — hence `TaskRunCheckpoint` carrying both `location` and an optional `imageRef`. Triggered by `wait.for(...)` and `triggerAndWait()`: the worker signals "suspendable" over Node IPC, the controller calls `suspendRun()` on the Workload API, the run goes `WAITING_TO_RESUME`, the checkpoint row is written and **all concurrency is released**. On resume the image is pulled and started **possibly on a different worker**; `continueRunExecution()` is validated against the snapshot id. Fallback without CRIU: `docker pause` (dev only — not persisted). Best source: indepth.dev, **2026-03-28**, `indepth.dev/posts/1020/en/how-trigger-dev-checkpoints-containers` *(the article warns it describes specific revisions)*; corroborated by Trigger.dev's March 2024 v3 developer-preview post.

Verified in v4 source: `CheckpointType` is now **`DOCKER | KUBERNETES | COMPUTE`** — `COMPUTE` added by migration `20260328000000_add_compute_checkpoint_type` *(what it orchestrates is UNVERIFIED)*. **The checkpointer is an external service the supervisor calls over HTTP** (`packages/core/src/v3/serverOnly/checkpointClient.ts`): `POST {TRIGGER_CHECKPOINT_URL}/api/v1/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/suspend` → `{ok:true}`, and `…/restore`. **That service is not in the open-source repo** — v3's `apps/coordinator`, `apps/docker-provider` and `apps/kubernetes-provider` are gone from `main`. **CRIU was not dropped but is unavailable self-hosted:** the feature table reads **Warm starts ❌, Checkpoints ❌, Auto-scaling ❌** self-hosted vs ✅ cloud, and `TRIGGER_WARM_START_URL`/`TRIGGER_CHECKPOINT_URL`/`TRIGGER_METADATA_URL` sit under "Not used for self-hosting".

**v4 GA 2025-08-18**, built on **Run Engine 2** — "warm starts: 100-300ms execution vs several seconds for cold starts", plus waitpoints (human-in-the-loop approval, HTTP callbacks, idempotency). **v3 is EOL**: 4.5.0 is the last version supporting SDK v3 tasks; 4.5.1+ reject v3 triggers, batch triggers and deploys.

**The supervisor↔platform protocol** (`packages/core/src/v3/runEngineWorker/supervisor/http.ts`):

```
POST /engine/v1/worker-actions/connect
POST /engine/v1/worker-actions/dequeue
POST /engine/v1/worker-actions/heartbeat
POST /engine/v1/worker-actions/runs/:runId/snapshots/:snapshotId/heartbeat
POST /engine/v1/worker-actions/runs/:runId/snapshots/:snapshotId/attempts/start
POST /engine/v1/worker-actions/runs/:runId/snapshots/:snapshotId/attempts/complete
GET  /engine/v1/worker-actions/runs/:runId/snapshots/latest
GET  /engine/v1/worker-actions/runs/:runId/snapshots/since/:snapshotId
GET  /engine/v1/worker-actions/runs/:runId/snapshots/:snapshotId/continue
POST /engine/v1/worker-actions/runs/:runId/snapshots/:snapshotId/suspend
POST /engine/v1/worker-actions/runs/:runId/logs/debug
```

`dequeue` → `{maxResources?:{cpu,memory}, maxRunCount?, queueClass?}` ⇒ an **array** of `DequeuedMessage`. Source comment: *"The server derives the actual queue name from the token, so this only ever selects between the authenticated worker's own queues."* `attempts/start` ⇒ `StartRunAttemptResult & {envVars}` — **where the run's env vars are handed over**.

**Transport: pull, with a push side-channel.** `RunQueueConsumer` is a **short-poll loop, not long-poll**: `TRIGGER_DEQUEUE_INTERVAL_MS` **250ms** when work was returned, `TRIGGER_DEQUEUE_IDLE_INTERVAL_MS` **1000ms** idle, `TRIGGER_DEQUEUE_MAX_RUN_COUNT` **10**. A `preDequeue` hook reports free CPU/memory and **can skip the poll entirely** (`maxResources.cpu === 0`). Separately, `SupervisorSession` opens **socket.io** to `<apiUrl>/worker` and emits `run:subscribe`/`run:unsubscribe`; the platform pushes `run:notify`. **Pull for work assignment, push for wake-ups on runs you already hold.**

**Auth headers:** `Authorization: Bearer <TRIGGER_WORKER_TOKEN>` (`tr_wgt_…`), `x-trigger-worker-instance-name`, `x-trigger-worker-deployment-id`, `x-trigger-worker-managed-secret` (must match the webapp's `MANAGED_WORKER_SECRET`), `x-trigger-worker-runner-id`, and `x-trigger-worker-environment-id` ("verified environment id recovered from the deployment token … the platform scopes the snapshot read by it"). The group token is minted **admin-only**: `POST /admin/api/v1/workers` with a `tr_pat_…` bearer ⇒ `{token:{plaintext:"tr_wgt_…"}}`, **shown once**; `file://` is supported.

**Leases: no lock token — the lease is the execution snapshot.** Every action is addressed `runs/:runId/snapshots/:snapshotId/…`, so **a stale worker acting on an old snapshot id is rejected by construction** — optimistic concurrency. Per-status heartbeat timeouts (`internal-packages/run-engine/src/engine/index.ts`):

```
PENDING_EXECUTING: 60_000   PENDING_CANCEL: 60_000   EXECUTING: 60_000
EXECUTING_WITH_WAITPOINTS: 60_000     SUSPENDED: 600_000
```

The supervisor heartbeats every **30s** with live CPU/memory **and the task list** (capacity reporting); runs heartbeat separately; the runner polls its own snapshot. Resume is idempotent and guarded by snapshot id (retried up to 8 times with jitter). **Runner↔supervisor** is a second, local **Workload API** on port **8020** with its own headers and token — **the run container never holds the worker-group token.**

**Self-hosted workers against Trigger.dev Cloud: UNVERIFIED, probably not publicly available.** The mechanism exists in code, but worker groups are documented only under self-hosting, the token requires a **platform admin PAT**, and there is no docs page for BYOC. Leave the row unverified.

**Can another language be a worker? No.** The unit of deployment is an OCI image **built by their CLI from your TypeScript project**; the task-side contract is Node IPC plus `@trigger.dev/core` internals. The supervisor's contract *is* reimplementable, but doing so makes you **a container orchestrator for their images, not a worker** — and it is unversioned and undocumented as a public API.

**(e) COPY:** address every worker action as `(runId, snapshotId)` so a stale worker is rejected by construction, and make the dequeue request carry free resources so the **server** right-sizes the batch.
**(e) AVOID:** binding the work unit to a container image built by your own CLI — it is what makes Trigger.dev's worker un-implementable by anyone else, and why their own self-hosted tier loses checkpoints and warm starts.

---

# 10. QUIRREL **[AGENT — PRIMARY: source + GitHub API, 2026-09-22]**

**Repo state:** `quirrel-dev/quirrel`, MIT, 928 stars, **NOT ARCHIVED**. But **last release v1.14.1, 2023-06-26**, and the three most recent `main` commits are all 2023-06-26. `pushed_at` reads 2026-09-18 — almost certainly a bot branch *(inference; branches not enumerated)*. **The accurate phrasing for your argument: not archived, but unreleased and untouched on `main` for over three years. Do not say "archived".**

**Hosted service: shut down.** "Current Quirrel customers had access through **July 31, 2022**"; billing ended 2022-08-01. Replacement recommended: Netlify Scheduled Functions, else self-host or Zeplo. **Netlify acquired Quirrel, announced 2022-02-01**; founder Simon Knott joined. Lineage → Netlify Scheduled Functions (2022 beta) → Netlify Async Workloads. **UNVERIFIED: no primary source states Async Workloads descends *technically* from Quirrel — that framing is press-level, not engineering-level.**

**The callback contract** (`src/api/worker/index.ts` @ `main`):

```
POST <endpoint>                          // method HARD-CODED POST
Content-Type: text/plain                 // HARD-CODED
x-quirrel-meta: {"id","count","exclusive","retry","nextRepetition"}   // a JSON STRING in a header
x-quirrel-signature: v=<ms>,d=<digest>   // only when tokenId is set
body: <the payload as a string — the AES-256-GCM envelope if encryption is on>
```

**Ack rule:** 2xx → acknowledge. Anything else → `reportFailure(...)`, and **HTTP 404 ⇒ `dontReschedule: true`** — a missing endpoint is treated as permanent. **That rule is the sharpest idea in the design:** it distinguishes "your handler failed" from "your handler isn't there", which a pure 2xx/non-2xx contract cannot.

**The signature — primary source `github.com/quirrel-dev/secure-webhooks/blob/master/src/index.ts`:**

```ts
sign(input, secret, timestamp = Date.now()) =>
  `v=${timestamp},d=${HMAC_SHA256_hex(secret, input + timestamp)}`
```

- Format **`v=<unixMILLIseconds>,d=<digest>`**. **Not** Stripe's `t=…;v1=…`. Note **milliseconds**, unlike Inngest's `t` in seconds.
- **Bytes digested: the raw request body string concatenated with the decimal millisecond timestamp** — literally `input + timestamp`. No method, path or header canonicalisation.
- Symmetric = HMAC-SHA256 hex; asymmetric = RSA/EC `createSign("sha256")`, base64.
- **Replay window 5 minutes** (`FIVE_MINUTES = 5*60*1000`), `Math.abs(now - poststamp) > timeout` — **clamped in both directions**, independently of Inngest.
- **The Quirrel token itself is the HMAC secret** (`symmetric.sign(payload, token)`), unless `webhookSigningPrivateKey` is set for asymmetric signing.

Client verification (`src/client/index.ts`, `respondTo()`/`isValidSignature()`): **signature checking is skipped entirely unless `process.env.NODE_ENV === "production"`** — a serious footgun. Missing → `401 "Signature missing"`; bad → `401 "Signature invalid"`. Rotation: tries `token`, then `quirrelOldToken` (`QUIRREL_OLD_SECRETS`). Success → `200 "OK"`; thrown error → `500 String(error)` (nothing structured).

**Rest of the model.** App→Quirrel: `Authorization: Bearer ${QUIRREL_TOKEN}`. **E2E encryption**: client-side `aes-256-gcm`, 32-char secret, random IV, plus **a 4-char descriptor (first 4 chars of the secret's MD5) so secrets can be rotated** — the broker cannot read payloads. **Idempotency**: `id`; `override` (**the client throws if `override` is set without `id`**); `exclusive`. **Retries are an explicit array of backoff intervals**, `retry: (number|string)[]`, **min 1, max 10**, and **`retry` and `repeat` cannot be combined** (the client throws). No implicit exponential backoff. `enqueueMany()` limit 1000. Backend is a custom Redis library, **Owl**. The worker has optional **SSRF prevention** (`ssrf-filter.ts`).

**(a)** POST to a URL you registered, `Content-Type: text/plain`, body = the payload string, an `x-quirrel-meta` JSON header, and `x-quirrel-signature: v=<ms>,d=<hmac(token, body+ms)>`. 2xx = ack; non-2xx = retry; 404 = give up. **(b)** Push. **(c)** **No leases, no heartbeats, no visibility timeout** — the HTTP response *is* the ack and the request lifetime *is* the lease. **(d)** Bearer inbound; HMAC over `body+timestamp` with a 5-minute two-sided window outbound; the token doubles as the signing secret.
**(e) COPY:** the signed-callback shape, `404 ⇒ never retry`, and E2E payload encryption with a key descriptor for rotation.
**(e) AVOID:** gating verification on `NODE_ENV === "production"`; using the auth token as the HMAC key; "2xx or nothing" as the only result channel.

---

# 11. GRAPHILE WORKER **[AGENT — PRIMARY: v0.18.0, 2026-09-08]**

Fetch is a batched `UPDATE … FROM (CTE)`, not `get_job` (`src/sql/getJobs.ts`):

```sql
with j as (
  select jobs.job_queue_id, jobs.priority, jobs.run_at, jobs.id
    from graphile_worker._private_jobs as jobs
    where jobs.is_available = true and run_at <= now() and task_id = any($2::int[])
      and (jobs.job_queue_id is null
           or jobs.job_queue_id in (select id from _private_job_queues
                                    where is_available = true for update skip locked))
    order by priority asc, run_at asc limit <batchSize> for update skip locked
), q as ( update _private_job_queues set locked_by = $1::text, locked_at = now() from j … )
update _private_jobs as jobs
  set attempts = jobs.attempts + 1, locked_by = $1::text, locked_at = now()
  from j where jobs.id = j.id returning *;
```

**Rare and useful:** the source documents **four named-queue strategies with measured throughput** — strat 0 ≈ 11.8k jobs/s; strat 1 ≈ 40 jobs/s with 100k stuck jobs; strat 2 ≈ 843 jobs/s; strat 3 unsafe. **Strategy 2 ships.** Batch fetches dedupe to one job per named queue to preserve serial execution.

- `$1` is the **WorkerPool id, not the worker id**. Pool = `${continuous ? "pool" : "otpool"}-${randomBytes(9).toString("hex")}`; worker = `worker-${randomBytes(9).toString("hex")}`. You may not set `workerId` when `concurrency > 1`.
- **Stale-lock reset: 4 hours** (`src/sql/resetLockedAt.ts`: `where locked_at < now() - interval '4 hours'`).
- The stable interface since 0.16 is the **`graphile_worker.jobs` view** (`id, queue_name, task_identifier, priority, run_at, attempts, max_attempts, last_error, created_at, updated_at, key, locked_at, locked_by, revision, flags`) — **deliberately no `payload`**. Docs warn: don't read it frequently, and **don't read it in a transaction** (jobs read inside a txn get skipped as if absent).
- **Channels: `jobs:insert` and `worker:migrate`** (`src/main.ts:537`). Payload is `pg_notify('jobs:insert', '{"r":<random>,"count":<n>}')` — **the random `r` exists to defeat Postgres' in-transaction NOTIFY de-duplication.** Subtle, load-bearing, free. **Poll fallback `pollInterval: 2000` ms.**
- `add_job(...)`; **`max_attempts` default 25** (≈3 days). **Backoff `exp(least(10, attempt))` seconds** — attempt 1 → 2.72s, 5 → 2m28s, 10 → 6h7m, capped there.
- `job_key_mode`: **`replace`** (debounce), **`preserve_run_at`** (throttle), **`unsafe_dedupe`** (marked dangerous). **Locked jobs are never overwritten** — the existing row's key is cleared and `attempts := max_attempts`, and a new job created. Array payloads merge.
- `forbiddenFlags` is evaluated **every time a worker looks for a job**, so it must resolve fast.

**Remote/HTTP worker story: none — confirmed by exhaustive grep.** Searching the whole v0.18.0 tree for "other language", "non-node", "http worker", "remote worker", "python", "golang" returns **exactly one hit**, `website/docs/index.md:68`: *"Executes tasks written in Node.js (these can call out to any other language or networked service)."* The **producer** side is language-agnostic (anything that can `select graphile_worker.add_job(...)`, including a Postgres trigger).

**(a)** No remote contract; the contract is SQL. **(b)** Pull, NOTIFY-woken, 2s poll safety net. **(c)** `locked_at`/`locked_by` (pool id); **no heartbeat at all** — only the blunt 4-hour reset. **(d)** Postgres credentials.
**(e) COPY:** NOTIFY-for-latency + poll-for-safety **with a random field to defeat coalescing**, and the `job_key`/`job_key_mode` triad.
**(e) AVOID:** a 4-hour fixed stale-lock window with no heartbeat.

---

# 12. RIVER **[AGENT — PRIMARY: v0.47.0, 2026-08-31]**

States: `available, cancelled, completed, discarded, retryable, running, scheduled` + **`pending`** (migration 004). `river_job` columns include `attempt`, `max_attempts`, `attempted_at`, **`attempted_by text[]`**, `errors jsonb[]`, `priority smallint (1..4)`, `tags`. Fetch index `btree(state, queue, priority, scheduled_at, id)`.

`JobGetAvailable`: `FOR UPDATE SKIP LOCKED` CTE → `UPDATE … state='running', attempt=attempt+1, attempted_at=now(), attempted_by = array_append(<ring-buffered to @max_attempted_by>, @attempted_by::text)`. **`attempted_by` is a bounded ring of client identifiers.** Notify: `pg_notify('river_insert', json_build_object('queue', NEW.queue))`, reworked into a notification outbox in migration 007.

**No lease column and no heartbeat: `state='running'` is the lease and it never expires on its own.**

- **Rescuer**: `RescueStuckJobsAfter` defaults to **1 hour**, or `JobTimeout + 1 hour` if `JobTimeout` > 1h.
- `JobTimeout` default **1 minute** (cancels the job's context). After `JobStuckThreshold` (**10s**) it is "stuck"; a `JobStuckHandler` can alert, add a worker slot (`AddWorkerSlot: true`), or trigger a restart.
- **Worst-case recovery ≈ 1h 1min.** River Pro sells "active job rescue" as the fix.
- Maintenance services run by a **single leader-elected client** (`river_leader`, constrained to `name='default'`): Cleaner (24h cancelled/completed, 7d discarded), Periodic Enqueuer, Queue Cleaner, Reindexer (`REINDEX INDEX CONCURRENTLY`, daily midnight UTC), Scheduler (every 5s).
- **Default retry `ATTEMPT^4` seconds** — 1s, 16s, 1m21s, … Snoozes decrement the attempt count; the policy uses the *error* count so the schedule stays stable across versions.
- `UniqueOpts`: ByArgs (narrowable by a `river:"unique"` struct tag), ByPeriod, ByQueue, ByState. **Enforced at insert only; execution is at-least-once**, and uniqueness lapses when completed rows are cleaned at 24h.

**Non-Go workers: insert-only — confirmed with quotes.** Python repo description is literally *"Python insert-only client for River."*; README: *"Allows jobs to be inserted in Python and run by a Go worker, but doesn't support working jobs in Python."* Ruby identical. *(Only the pgx driver's SQL was read; `riversqlite`/`riverdatabasesql` may differ.)*

**(e) COPY:** the explicit, sanctioned **insert-only client tier** for other languages, plus `attempted_by` as a bounded ring.
**(e) AVOID:** `state='running'` as the lease with a 1-hour rescuer as the only backstop.

---

# 13. OBAN **[AGENT — PRIMARY: v2.24.0, 2026-08-25]** — my earlier "no cross-language worker" was wrong

States (8): `:suspended, :scheduled, :available, :executing, :retryable, :completed, :cancelled, :discarded`. **`attempted_by`** records **node, queue and producer nonce**.

**Leadership** (`Oban.Peer`): "Leadership is used by plugins, primarily, to prevent duplicate work across nodes." `Oban.Peers.Database` (default) uses a row per instance in **`oban_peers`**; `Oban.Peers.Global` uses distributed Erlang. **Re-checked every 30 seconds**; a departing leader broadcasts. *(No explicit lease TTL beyond the 30s check is stated — UNVERIFIED.)*

**Orphan rescue** is `Oban.Plugins.Lifeline` (OSS; now deprecated in favour of `Oban.Lifeline`). Historically: queue activity recorded as heartbeats in `oban_beats` (batch writes, 5-minute retention), `rescue_after` **default 60 minutes**, swept **once a minute**, "guaranteed to only rescue jobs that belong to dead queue processes or nodes." **PARTIALLY UNVERIFIED FOR v2.24** — the live page is now a deprecation stub, so the current default and whether `oban_beats` exists could not be confirmed. **If you cite 60 minutes, attribute it to the 2.23/2.0-rc docs.** Pro `DynamicLifeline` 404'd.

**Pro composition:** `Batch` (callbacks `handle_attempted/1`, `handle_cancelled/1`, `handle_completed/1`, `handle_discarded/1`, `handle_exhausted/1`, `handle_retryable/1`), **Chain** (strict sequential order), **Workflow** (a DAG; `Workflow.append()` added 2026-03-09 preserves the ancestor chain for nested sub-workflows).

**Cross-language worker: YES.** **Oban Pro for Python both enqueues and executes** against the same Postgres schema. Latest **v0.6.4, 2026-09-03**. v0.6 adds Signals (pause awaiting an external event, then resume), Workflow Status, Unique Workflows. A v0.6.1 fix concerns worker processes: "Each engine now opens its own client-mode Oban… so worker queries resolve to connections owned by that process." Source: `oban.pro/releases/py_pro`. **Caveats: commercial; only the releases page was read; whether an Elixir Oban instance and a Python Oban instance interoperate on one database is UNVERIFIED.** No HTTP/remote worker protocol in OSS Oban.

**(e) COPY:** `attempted_by` recording **node + queue + producer nonce** — it makes orphan rescue *provably* safe ("only rescue jobs belonging to dead producers") rather than time-based guessing.
**(e) AVOID:** orphan rescue behind a leader-elected plugin with a 60-minute default.

---

# 14. SIDEKIQ **[AGENT — PRIMARY: v8.1.7 on `main`]** — correction: OSS uses `BRPOP`

`lib/sidekiq/fetch.rb` (`Sidekiq::BasicFetch`):

```ruby
TIMEOUT = 2
@queues = config.queues.map { |q| "queue:#{q}" }
queue, job = redis { |conn| conn.blocking_call(TIMEOUT, "brpop", *qs, TIMEOUT) }
UnitOfWork#acknowledge  # "nothing to do"
UnitOfWork#requeue      # conn.rpush(queue, job)
```

`queue:<name>` is a Redis LIST; popped with **`BRPOP`** (2s timeout so the thread notices shutdown); **`acknowledge` is a no-op because the job is already gone from Redis.** Queue weighting is `@queues.shuffle` (then `uniq!`) on **every** call. Graceful shutdown `bulk_requeue`s via `RPUSH`. **A `kill -9` loses them** — the entire reason super_fetch exists. `LMOVE` into a private queue is **Sidekiq Pro's `super_fetch`**, not OSS.

**super_fetch (Pro, closed source — docs only):** `LMOVE` (older `RPOPLPUSH`/`BRPOPLPUSH`) into a **private per-process queue** registered at start-up. Orphan recovery, quoted: jobs are reclaimed *"if the process's heartbeat has expired (it takes 60 seconds to expire); AND if a minute has passed since the last orphan check"*, plus *"the orphan check will run a complete SCAN of the Redis database for orphaned queues once an hour"*. The wiki is blunt: **"super_fetch might recover jobs in 5 minutes or 3 hours, there's no guarantee."** Poison pill: 3 crashes in 72 hours → Dead set. *(Private-queue key format UNVERIFIED — Pro is closed; secondary sources describe an `sq|` prefix.)*

**Job format:** required `class`, `jid` (12 random bytes as 24 hex chars), `args`, `created_at`, `enqueued_at` — **Unix epoch milliseconds as integers since Sidekiq 8.0; previously float seconds** (a breaking change for cross-language clients). Optional `queue`, `retry`, `at`, and on retry `retry_count`, `error_message`, `error_class`, `error_backtrace`, `failed_at`, `retried_at`.

**The process registry — the thing to copy** (`lib/sidekiq/launcher.rb`, `component.rb`):

- **Identity** = `"#{hostname}:#{Process.pid}:#{process_nonce}"`, `process_nonce = SecureRandom.hex(6)`.
- **`BEAT_PAUSE = 10`** — heartbeat every 10 seconds.
- Each beat, in a `MULTI`: `SADD "processes" <identity>`; `EXISTS <identity>`; `HSET <identity> info … concurrency … busy … beat <Time.now.to_f> rtt_us … quiet … rss …`; **`EXPIRE <identity> 60`**; **`RPOP "<identity>-signals"`** — how remote signals (TSTP/TERM) reach the process.
- Executing jobs live in `<identity>:work`, rewritten each beat with `EXPIRE 60`. Clean shutdown: `SREM`, `UNLINK`.
- **A dead worker is noticed purely by the 60s TTL expiring on `<identity>` while it stays in the `processes` set** — exactly what super_fetch's orphan scan looks for.
- Each beat also does an RTT check (`PING` in µs, warn above 50,000µs) and flushes `stat:processed`/`stat:failed`.

**Cross-language:** the format is JSON in a Redis list, but **the official wiki documents only *client* (enqueue-side) libraries** — Coffeekiq (Node), sidekiq-job-php, rust-sidekiq — with a caveat about maintenance and commercial-feature compatibility. A cross-language **worker** exists but is *not* on that page: `jrallison/go-workers`, using `brpoplpush` and "a unique process ID for recovery of in-progress jobs on crash" — widely forked, apparently unmaintained upstream, **not verified against Sidekiq 8's millisecond timestamps.** **So cross-language interop is real and load-bearing in practice, but de-facto, not a specified contract** — good supporting evidence for documenting the protocol.

**(e) COPY:** the process registry — `SADD processes <host:pid:nonce>` + a self-expiring `<identity>` hash refreshed every 10s with a 60s TTL, carrying `busy`, `concurrency`, `rss`, `rtt_us`, plus a `<identity>-signals` list for remote quiet/stop. Liveness, dashboard and remote control in ~30 lines.
**(e) AVOID:** OSS Sidekiq's no-op acknowledge; selling reliable fetch as the paid tier; orphan recovery depending on an hourly full `SCAN`.

---

# CROSS-CUTTING CONCLUSIONS

**1. Make the pull/lease protocol the *only* protocol; solve serverless by changing who *starts* the process.** Three systems converged independently in 2025–26. AWS: the Lambda ESM is a hosted poller plus a response-shaped ack. Temporal (2026-07): the Worker Controller invokes Lambda when a task can't sync-match; the invoked worker then polls exactly as a long-running worker does. Inngest went the other way (HTTP push first) and had to define a whole protobuf WebSocket protocol later; Hatchet did the reverse (gRPC first) and is now defining an HTTP protocol for serverless.

**The two who invented a second protocol both survived it the same way: making the task representation and result semantics identical across transports.** Inngest: `DONE/ERROR/NOT_COMPLETED ↔ 200/500/206`. Hatchet: the serverless envelope wraps the *same* `AssignedAction`, and durable frames are the *same* messages as the gRPC stream. bullmq-proxy is the counter-example — its WebSocket transport sends only `job.data`, so a WS worker cannot report progress or logs. **If you ship two transports, that identity is not optional.**

**2. Fencing: four right, four wrong.**

| Fences correctly | Mechanism |
|---|---|
| **BullMQ** | compare-and-set on the token inside `extendLock-2.lua`, returns 1/0 |
| **Temporal** | `attempt` + `activity_attempt_stamp` in the task token → `ErrActivityTaskNotFound` |
| **Trigger.dev** | every action addressed `(runId, snapshotId)` — optimistic concurrency, no lock |
| **Inngest Connect** | `lease_id` **rotated** on every extension |

| Fails silently | Failure mode |
|---|---|
| **SQS** | stale `DeleteMessage` returns **200 and does nothing** |
| **Faktory** | late `ACK` logs "No such job to acknowledge", returns nil |
| **Graphile / River / Oban / Sidekiq** | no fencing; a revived worker can still write its result |

**Trigger.dev's version is cheapest to implement and easiest to explain:** a monotonic state id on the job, carried in the URL of every mutation.

**3. Nobody ships short, renewed leases — this is your differentiator.** Graphile 4h. River 1h (sells the fix). Oban 60min (sells the fix). Sidekiq Pro: "5 minutes or 3 hours, there's no guarantee." Cloud Tasks and Quirrel have no lease at all; bullmq-proxy's remote worker cannot extend anything and gets a 3-second default. Only BullMQ (30s/15s), Temporal (heartbeat-as-renewal), Hatchet (`RefreshTimeout`) and Inngest Connect (server-dictated interval) do it properly.

**4. Three systems independently converged on the same signature design.** Inngest, Quirrel and Hatchet's 2026 draft all use **HMAC-SHA256 over `rawBody ‖ timestamp`, with a 5-minute window clamped in BOTH directions**, in a single header. Different encodings (`t=…&s=…` seconds vs `v=…,d=…` milliseconds vs a separate `X-Hatchet-Timestamp`), identical substance. **The substance is settled.**

**5. Scope the worker's credential to the job.** bullmq-proxy's `authForWorkers` is the sharpest version — the callback bearer must equal that job's current lock token. Compare Trigger.dev, where the run container never holds the worker-group token.

**6. Publish what the remote transport *cannot* do, as typed errors.** Hatchet's `LIMITATIONS.md` + `ServerlessLimitationError`; Inngest's `capabilities` map. Silent divergence between transports is how people lose trust in a protocol.

**7. Heartbeat payloads should carry capacity; dequeue requests should carry free resources.** Trigger.dev's heartbeat carries CPU/memory *and* the task list, and its dequeue **skips the poll entirely when full**. Hatchet declares `slots` and `slot_config`. Sidekiq's heartbeat carries `busy`, `concurrency`, `rss`, `rtt_us` and reads a signals list. **The heartbeat is free; make it do three jobs.**

**8. Small things worth stealing verbatim.** Graphile's **random `r` field in the NOTIFY payload** to defeat coalescing · Cloud Tasks' two counters (dispatches vs dispatches-that-answered) · Quirrel's **404 ⇒ never retry** · Temporal's **`shutdownDeadlineBufferMs`** · Inngest Connect's **`POST /v0/connect/flush`** HTTP fallback · River's `attempted_by` bounded ring · BullMQ's **two-pass mark-and-sweep** with its single-sweeper guard key · Hatchet's **`422` = "wrong route, upgrade"** · bullmq-proxy is **written in Bun** and says why · BullMQ's source comment that **Bun ignores `worker_threads` stdio options** (bullmq#2232).

---

# EVERYTHING EXPLICITLY UNVERIFIED

**Inngest:** whether the executor verifies response signatures (the SDK does sign them); any header spelled `X-Inngest-Sig`.
**Faktory:** none material — but note the spec/impl drift (undocumented `PUSHB`/`MUTATE`/`BATCH`/`TRACK`/`QUEUE`; `FETCH` blocking 2s spec vs 5s code; terminate grace 30s spec vs 25s wiki).
**Temporal:** body of `IsActivityTaskNotFoundForToken`; the empty-`task_token` convention as a doc sentence; removal of experimental Build-ID versioning; min server/SDK versions for Deployment Versioning; the Lambda event payload shape; sticky-queue behaviour under serverless; Nexus auth.
**Hatchet:** the v0 webhook-worker wire protocol *in full* (signature header name, body shape, result path); whether webhook workers were formally removed; `operators.proto` contents; the 4s `ListenV2` interval. **PR #4949 is DRAFT, not merged.**
**BullMQ:** which minor added each enum member; whether `extendLocks-1.lua` differs from `extendLock-2.lua`; **the `moveToFinished-*.lua` token check (inferred, not quoted — narrow the claim or open the file)**; the lock-mismatch error strings (only "job stalled more than allowable limit" is quotable).
**bullmq-proxy:** WS routes being genuinely unauthenticated (read as such, no test/doc); which of the two mismatched WS URLs is stale. **taskforce.sh as a pure Redis reader — inferred, not source-verified.**
**Trigger.dev:** what `CheckpointType.COMPUTE` orchestrates; warm-start internals (cloud-side, closed); whether Cloud offers customer-run worker groups.
**Quirrel:** whether Netlify Async Workloads descends *technically* from Quirrel (press-level only); the `pushed_at` vs last-`main`-commit discrepancy.
**Oban:** current `Oban.Lifeline` `rescue_after` default and whether `oban_beats` exists in v2.24 (the 60min figure is from 2.23/2.0-rc docs); Pro `DynamicLifeline`; whether Oban Pro for Python and Elixir Oban share one database.
**Sidekiq:** super_fetch's private-queue key format; whether `go-workers` works with Sidekiq 8's millisecond timestamps.
**River:** only the pgx driver's SQL was read.
**Cloud Tasks:** Google JWKS endpoint URL; whether the SA `email` claim is guaranteed; whether `v2beta2 leaseTasks` is still callable.
**SQS:** FIFO throughput numbers; EventBridge Pipes batching/partial-failure shape; SNS byte-level string-to-sign.

---

# PRIORITY READING

1. **`inngest/inngest/docs/SDK_SPEC.md`** — a normative RFC-2119 spec for exactly the artifact you are writing.
2. **`contribsys/faktory/docs/protocol-specification.md`** — the better template for a *wire* protocol, with literal `C:`/`S:` transcripts. (Also learn from its failure: a spec nobody tests against rots.)
3. **Hatchet branch `belanger/serverless-ts-core`** (`sdks/typescript-serverless/`, `api-contracts/v1/serverless.proto`, `LIMITATIONS.md`) — your project, being built, this month.
4. **`docs.temporal.io/serverless-workers`** — the argument for not writing a second protocol at all.
5. **BullMQ `src/commands/{extendLock-2,moveStalledJobsToWait-9}.lua`** — ~60 lines that are the best lease-and-sweep implementation in the survey.