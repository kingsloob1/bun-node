# Lifecycle spike: draining `close()` without the stale-server hazard

PR-6b's spike (the user's Q6: "drain with a 10 s cap … spike first"), run on
2026-10-20 on the shared 16-core machine under load (1-minute load 30–60 from
peer sessions). Bun **1.4.2** (`744846f84`, the users' floor), **1.4.3**
(`c6da4a4d3`, S1 and S2 only) and **1.4.4-canary.1** (`6bb5dc195`); the same
results on each. Every script is Bun-only (no bun-node code) except S8, which
imports bun-common's `getPort`, and the 9847b5443 probe. Results are in
`results/<script>.<variant>.<bun>.json`.

## Re-run

```bash
D=docs/plans/nestjs-12-parity/evidence/lifecycle-spike   # from the repo root
cd $D
B=bun   # or a 1.4.2 binary, e.g. one unpacked from @oven/bun-linux-x64@1.4.2
for m in false true; do $B s1-hazard.ts $m reuse; done     # S1
$B s2-listener.ts reuse                                     # S2
for d in graceful drain force; do $B s3-longlived.ts $d; done  # S3
$B s4-connclose.ts; $B s5-unix.ts                           # S4, S5
$B s6-unread-stream.ts 3; $B s7-raw-unread.ts               # S6, S7
$B s8-getport.ts                                            # S8
# the 9847b5443 probe needs bun-nest's decorator config: run it from there
(cd ../../../../../packages/bun-nest && bun ../../$D/probe-9847b5443.ts)
```

Each prints one JSON line; none takes more than a few seconds.

## What each measured

| Script | Question | Result |
|---|---|---|
| `s1-hazard.ts` (raw sockets) | After `stop(false)`, does an idle or a busy keep-alive connection keep serving the old server once a new one binds the same port (with and without `reusePort`)? | **No.** The idle connection is closed at once (before the next send); the busy one finishes its response (200 "A"), then closes; fresh connections reach the new server. `stop(false)` resolves when the in-flight request ends (352–373 ms). `stop(true)` cuts the in-flight request. |
| `s2-listener.ts` | During a graceful drain, does the old listener still accept connections (SO_REUSEPORT would split them)? Does Bun's fetch pool, warmed on the old server, reach the new one? | 20 of 20 fresh connections reach the new server; the pooled client gets the new server 4 of 4. |
| `s3-longlived.ts` | **The negative control.** What does a graceful stop leave behind? `graceful` = `stop(false)` alone (not awaited); `drain` = `stop(false)`, wait for `pendingRequests === 0` up to a cap (1 s here), then `stop(true)`; `force` = `stop(true)`. | `graceful`: after close and with a new server on the port, the old **SSE stream keeps flowing** (14–15 chunks in 600 ms) and the old **WebSocket still answers** (`A:ping`); `pendingRequests` 1, `pendingWebSockets` 1. `drain`: the in-flight request finishes, the stream is cut at the cap, the WebSocket is closed, both counters 0. `force`: the in-flight request is reset. |
| `s3` (also) | What does `pendingRequests` count? | A streaming response until it ends; WebSockets only in `pendingWebSockets`. `stop(false)`'s promise waits for both, so the drain waits on `pendingRequests`. |
| `s4-connclose.ts` | Does Bun honour a `Connection: close` response header? | Yes: sent, and the socket closed after the response (so the `503` can match Express). |
| `s5-unix.ts` | `Bun.serve({ unix })` | Works; `port`/`hostname` undefined, `url` `unix:///path`, `server.address` the path string; `EADDRINUSE` on an existing file, `ENOENT` in a missing directory; the file is removed on stop; `hostname` beside `unix` throws. |
| `s6-unread-stream.ts`, `s7-raw-unread.ts` | Why did the features probe's `closeWithOpenSseDefault` close in ~565 ms? | Bun's `fetch` **client** ends a streaming body it is not reading after 0.4–1 s (S6); a raw TCP client that stops reading keeps the stream open 3 s+ (S7). A client artefact, not the server; tests keep reading the stream. |
| `s8-getport.ts` | Does bun-common's `getPort()` ~1 s lock still have a reason, given S1/S2? | Its probe server has no connections, so `stop(true)` frees the port at once (an immediate rebind succeeds) and two lock-free probes of one candidate both return it. With the lock, sequential and concurrent callers get distinct ports. **Still needed**, for the hand-out race (a port probed free, not yet bound by its caller), not for stale keep-alive servers. |
| `probe-9847b5443.ts` | Nest 12.0.2's platform-ws fix (9847b5443): after `app.close()`, is a gateway's route still live on a caller-owned server? | **Yes** on bun-nest (Nest 12.1.3): the upgrade still gets `101` and opens a socket with no gateway bound. AFFECTS `BunWebSocketAdapter.dispose()`; the fix needs a bun-common API (a `ws()` route cannot be unregistered). |

## Verdict

`close()` drains as `stop(false)` → wait for `pendingRequests` to reach 0, at
most `closeDrainTimeout` (10 s by default) → `stop(true)`, and always ends with
`stop(true)` before it resolves. The keep-alive form of the CLAUDE.md
"Port-release pitfall" does not reproduce on Bun 1.4.2 and later (S1, S2); its
rule stands for the reason S3 measured: a graceful stop alone leaves long-lived
streams and WebSockets served by the old server.
