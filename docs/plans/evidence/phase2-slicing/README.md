# Evidence: Phase 2 as PRs

The spikes behind [`../../worker-runtimes.md`](../../worker-runtimes.md) §11,
"Phase 2 as PRs: 2a, 2b and 2r". Run on **2026-10-01** on the machine the
other transport evidence used: an i9-11900H, 16 threads, Linux 7.0.0-31,
**Bun `1.4.3-canary.1+5f554969b`** (still the build RT measured on
2026-09-25; no release has replaced it here), loopback only, shared with peer
sessions at a 1-minute load of 3 to 6. Nothing here is part of a published
package, or built, typechecked or linted by the repo's tooling (the parent
[`../README.md`](../README.md) says why).

Each spike is one self-contained `bun <file>.ts` in [`spikes/`](spikes/). It
binds port 0, prints `RESULT …` lines and exits. Its output from this run is
beside this file as `results-<spike>.txt`.

| Spike | Question | Answer |
|---|---|---|
| [`mac-throughput.ts`](spikes/mac-throughput.ts) | What does RT §4.3.1's text frame cost with its per-frame MAC, built and checked the way the protocol core would? | `crypto.subtle` HMAC is 10.8, 12.5 and 24.2 µs per sign at 150 B, 1.2 KiB and 16 KiB, one at a time (RT Appendix A's figures, reproduced). `node:crypto` `createHmac` is 0.9, 1.6 and 12.8 µs. **A whole frame, encoded and then parsed and verified, costs 27–30 µs with `crypto.subtle` and 4.8–7.6 µs with `node:crypto`** at 150 B–1.2 KiB (67 against 42 µs at 16 KiB). [`results`](results-mac-throughput.txt) |
| [`mac-concurrency-cpu.ts`](spikes/mac-concurrency-cpu.ts) | `crypto.subtle` with 64 signs in flight ran at 2.5 µs per sign: is that parallelism or amortised overhead? | **Parallelism.** CPU time over wall time is 1.6 with one in flight and 4.2–4.5 with 64–512 in flight: Bun runs WebCrypto on a thread pool. The CPU cost per sign stays ~10 µs, so concurrency hides the latency but not the cost, which other cores pay. [`results`](results-mac-concurrency-cpu.txt) |
| [`sse-canary-probe.ts`](spikes/sse-canary-probe.ts) | Does RT §5.7's buffering probe (three `progress` events 100 ms apart; "buffered" when they arrive within 20 ms of each other and of the `result`) tell a streaming path from a buffering one on Bun's server? | **Yes, both ways, twice each.** Direct, a Bun proxy returning `fetch(upstream)` unchanged, and a Bun proxy re-streaming chunk by chunk all delivered the events 100 ms apart, the first byte at 0–1 ms (the `: open` comment). A proxy that buffers the whole body, and one that forwards only in 64 KiB blocks, delivered **the headers and all three events at 301 ms**, gaps 0 ms; the rule called both "buffered". So the test fakes can be plain `Bun.serve` proxies. [`results`](results-sse-canary-probe.txt) |
| [`ws-backpressure.ts`](spikes/ws-backpressure.ts) | With protocol-sized frames (211 B), how do the server's three `send()` results and the client's `bufferedAmount` behave? | **Server to a paused client:** 19,235 frames went out (`> 0`, ~4 MB into kernel buffers), then 4,878 were queued (`-1`) up to the 1 MiB `backpressureLimit`, then `send()` returned `0`. Every sent or queued frame was delivered after resume, `drain` fired once, and an `END` marker sent after the first `0` was itself dropped (the first run hung on it). **Client to a server whose event loop was blocked 1.5 s:** after 4,000 × 1 KiB sends `bufferedAmount` was only 42,040 B, flat while the server was blocked, and reached 0 within 2 ms of the unblock. [`results`](results-ws-backpressure.txt) |

## What the spikes change in the slicing

- **The MAC is affordable per frame, but not through `crypto.subtle` at the
  gateway's rates.** The 2026-09-29 gateway prototype reached 76,580 jobs/s on
  memory with `node:crypto` (`../worker-gateway-and-isolation/`). Two frames per
  job at ~30 µs, sequentially, caps one awaited chain near 16,000 jobs/s; with
  frames in flight the latency hides, but ~10 µs of CPU per sign lands on
  other cores of the host. PR-2a2 therefore gives the protocol core an internal
  MAC seam: `crypto.subtle` by default (browser-safe, what an isolate runs),
  and `node:crypto` injected on the Bun-only host side and in `./remote/serve`.
  Both produce the same bytes, which the test vectors pin.
- **Neither the kernel nor `bufferedAmount` is a bound.** Loopback absorbed ~4 MB
  before either side's buffer moved, so `bufferedAmount` cannot be the flow
  control the session relies on: the reliability layer's acknowledged outbox
  (`resumeBufferBytes`, RT §4.5.1) is. `bufferedAmount` is still a usable
  *drain* signal (it fell to 0 within 2 ms), which is all RT §7.5 asks of it.
  PR-2b1 carries the outbox bound; PR-2b2 and PR-g1b poll `bufferedAmount`.
- **A `0` from `send()` loses that frame and every frame after it until
  `drain`**, so RT §7.5's rule (treat `0` as a dead session, close `4429`,
  resume) is necessary, not cautious: the next frame sent before `drain` was
  lost too.
- **A buffering path also holds the `accepted` frame**, so the attempt state
  machine's accept timeout (RT §4.7, 5 s) would fire on a long attempt over a
  path that began buffering after its last canary. PR-2a8 treats an accept
  timeout on `http-stream` as a buffering signal: re-probe before a transport
  retry ([I], a test in that PR).

## What this does not show

Loopback only, one machine, a canary build. No proxy here is a real nginx,
Cloudflare or cloud load balancer; RT Appendix B's tier-3 run is still where
those are measured. The MAC figures are single-process; a host also running
claims, settles and a driver client was not measured.
