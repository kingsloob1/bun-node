# Evidence: remote transports

The evidence behind [`../../remote-transports.md`](../../remote-transports.md),
the design for carrying a Phase 2 remote attempt over HTTP, streamed HTTP,
SSE, WebSocket (both directions), TCP, UDP, HTTP/2 and plugin transports.
Gathered on **2026-09-25**. Nothing here is part of a published package, and
nothing here is built, typechecked or linted by the repo's tooling (the
parent [`../README.md`](../README.md) says why).

| File | What it is | Marks |
|---|---|---|
| [`bun-transports.md`](bun-transports.md) | What Bun provides natively per transport, **measured** on one machine, with the gotcha that matters most for each: 4-second timer ticks, no `EventSource`, WebSocket `send()` dropping at the backpressure limit, unbuffered TCP `write()`, UDP with no flow control and no DTLS, experimental HTTP/2 and HTTP/3 | [M] [V] [U] |
| [`platform-transports.md`](platform-transports.md) | Which of ~35 platform shapes accept which transport inbound and outbound, their idle and lifetime limits, their health mechanisms, and where intermediaries silently break a protocol | [V] [V-prior] [I] [U] |
| [`spikes/`](spikes/) | The 27 re-runnable spikes `bun-transports.md` cites | — |

## Reading the spikes

`bun-transports.md` refers to the spike directory as `$T`, a session
scratchpad. **`$T` is this `spikes/` directory**: the files here are
byte-identical copies (checked with `cmp` on 2026-09-25), kept so the
measurements outlive the session.

- Each spike is one self-contained `bun <file>.ts`. It binds port 0, prints
  `RESULT …` lines, and exits on its own.
- The TLS, HTTP/2, HTTP/3 and QUIC spikes (`tls*.ts`, `h2.ts`, `h3*.ts`,
  `quic.ts`, `other.ts`) need a self-signed pair **next to them**, which is
  deliberately not committed:

  ```sh
  openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 \
    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
  ```

- `h3-probe2.ts` is run twice: plain, and with `NODE_EXTRA_CA_CERTS=cert.pem`.
  `h3.ts` section 0 is run with and without
  `BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1`.
- The spikes use `as any` freely (32 occurrences) and nothing typechecks
  them; they are measurements, not code to copy.

The design document adds **one spike of its own**, for per-frame signing
cost, AES-GCM sealing, X25519/Ed25519 support, timer accuracy and DNS lookup.
It is listed in full in its [Appendix A](../../remote-transports.md#appendix-a-the-crypto-spike-run-for-this-plan);
its files stayed in the session scratchpad.

## Provenance

| Mark | Meaning |
|---|---|
| **[M]** | Measured by a spike that can be re-run; the file is named |
| **[V]** | Read on 2026-09-25 in a primary source; the key resolves in the file's Sources |
| **[V-prior]** | Carried from an earlier file in this repo, which is named, and not re-read |
| **[I]** | Inference. A claim to test, never a finding |
| **[U]** | Unverified. Nothing may rest on it |

Treat the marks as load-bearing. Three claims in the worker-runtimes plan were
withdrawn after a second reading, each an inference presented as a finding.
**No inference in these files has been upgraded**, and the design carries the
marks into every fact it quotes.

## Two cautions before relying on anything here

1. **The runtime was a canary**: `bun --revision` →
   `1.4.3-canary.1+5f554969b`, while the newest release was v1.4.2. Re-run the
   spikes on the release Phase 2 ships against. The design makes that re-run a
   gate item of each sub-phase.
2. **Everything was measured on loopback**, which has no loss, reordering,
   path MTU, NAT or middlebox. What only a real network can show is listed at
   the end of `bun-transports.md` and, together with the platform unknowns,
   in the design's [Appendix B](../../remote-transports.md#appendix-b-what-still-needs-a-real-network).

## Where the research and the design part ways

`platform-transports.md` §1.2 recommends **not** specifying raw TCP or UDP,
because they reach no platform that WebSocket over an outbound connection
cannot. The user asked for them, so the design specifies both in full, and
records their value as polyglot executors and private networks rather than
reach (`remote-transports.md` §1.3). The recommendation is kept here as
written; it is evidence, and the design answers it rather than editing it.
