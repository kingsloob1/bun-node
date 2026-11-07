# bun-security: evidence

Spikes behind [`../README.md`](../README.md) and its sub-plans, run
2026-11-07 on Bun **1.4.4-canary.1+11c367163** (`bun --revision`), linux-x64,
loopback only. **None measures speed** (the standing rule); each records
behaviour. Re-run with `bun <file>` from the folder; the recorded output is
kept as it was printed.

| Folder | What it shows | Files |
|---|---|---|
| [`client-ip/`](client-ip/) | what `server.requestIP()` reports (TCP: `{ address, family, port }`; Unix socket: `null`); a **default or `"::"` listener reports IPv4 clients as `::ffff:127.0.0.1`, family `IPv6`**; `X-Forwarded-For`, `Forwarded`, `X-Real-IP` pass through untouched; two `X-Forwarded-For` lines arrive joined with `", "`; `idleTimeout` 256 is refused (max 255); `server.timeout()` exists | `spike.ts`, `results.txt`, `dualstack.ts`, `results-dualstack.txt` |
| [`request-shape/`](request-shape/) | raw-socket requests: Bun resolves dot segments, encoded dots and backslashes in `req.url`, keeps `%2F` and `//`, takes the host of an absolute-form target from `Host`; answers 431 to a 20 KB header, 400 to `Content-Length` with `Transfer-Encoding` and to a missing `Host`; closes unknown and lower-case methods without a response; **accepts two `Host` lines** (a Bun bug against RFC 9112 §3.2) | `spike.ts`, `results.txt`, `repro-duplicate-host.ts` (exits 1 while the bug is present) |
| [`crypto/`](crypto/) | Ed25519 signing and verification through `crypto.subtle` (a tampered byte fails) and `node:crypto`; HMAC-SHA256; `timingSafeEqual` throwing on unequal lengths; `Bun.CryptoHasher` SHA-256 matching `node:crypto` | `spike.ts`, `results.txt` |
