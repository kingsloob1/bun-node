# Evidence: bun-cache encryption, name hashing and compression

The evidence behind [`../../encryption.md`](../../encryption.md).

**Where it ran.** Gathered on **2026-10-28** on the shared laptop
(i9-11900H, 16 threads, Linux 7.0.0-38-generic), on Bun
**1.4.4-canary.1+a0cc096ce**, under `nice -n 10`. Peer sessions were running,
at a load average of 3 to 6, so compare figures within one run, not across
machines.

**Not part of a package.** Nothing here is part of a published package. Like
the rest of `docs/`, the repo's lint, format and typecheck gates do not cover
it (`bunfig.toml` ignores `docs/**`).

**The two spikes that load bun-cache** load the worktree's
`packages/bun-cache/lib/index.ts` by relative path, so they measure develop
at `251a64f1`. `BUN_CACHE_LIB` points them elsewhere. Their temporary files go
under `$SPIKE_DIR` (default: the OS temp directory) and are removed.

| Script | What it measures | Re-run | Output |
|---|---|---|---|
| `probe-subtle.ts` | Which algorithms `crypto.subtle` accepts on this Bun: AES-GCM, ChaCha20-Poly1305, AES-OCB, AES-CTR, AES-KW, HMAC and HKDF | `bun probe-subtle.ts` | `results-probe-subtle.txt` |
| `bench-ciphers.ts` | Seal and open at 100 B, 4 KiB, 70 KB and 1 MiB, wall and CPU per op, for these candidates: `node:crypto` AES-256-GCM (Buffer and `KeyObject` keys, with a per-entry HMAC-derived key, behind an `await`); `crypto.subtle` AES-GCM (awaited, 64 in flight, `importKey` per entry); subtle ChaCha20-Poly1305. Then the same seal and open against bun-cache's own encode + zstd and decode paths, on cache-shaped values. A sanity block checks every round trip, that node's GCM and subtle's open each other's output, and that a flipped bit fails | `nice -n 10 bun bench-ciphers.ts` | `results-bench-ciphers.txt` |
| `bench-nonce.ts` | Where a 100 B seal's time goes: `randomBytes(12)`, `getRandomValues`, `randomFillSync`, a pooled source, and the cipher alone | `nice -n 10 bun bench-nonce.ts` | `results-bench-nonce.txt` |
| `repro-randombytes.mjs` | The same nonce sources on Bun and on Node 24.2.0 (`node repro-randombytes.mjs`), to tell a Bun regression from Node's own cost | `bun repro-randombytes.mjs; node repro-randombytes.mjs` | `results-randombytes.txt` |
| `bench-hmac.ts` | HMAC-SHA-256 of a 12 B tag, a 40 B key and a 200 B HTTP key through `Bun.CryptoHasher` (keyed), `createHmac` and `crypto.subtle.sign`, against plain SHA-256 and `Bun.hash`. Also HKDF through `hkdfSync` and subtle, and scrypt at N = 2^14, 2^15 and 2^17 | `nice -n 10 bun bench-hmac.ts` | `results-bench-hmac.txt` |
| `nonce-bound.ts` | Arithmetic, not a measurement: time to NIST's 2^32 seals per key, and the chance of a nonce repeat in a year, at 100 to 100,000 writes/s, for random 96-bit nonces and for a 128-bit salt with a per-entry key | `bun nonce-bound.ts` | `results-nonce-bound.txt` |
| `swap-attack.ts` | On the **real** `createCache`, `memoryDriver` and `fileDriver`, what a store writer achieves (see below) | `bun swap-attack.ts` | `results-swap-attack.txt` |
| `bench-cache-overhead.ts` | Whole `set`/`get` on the real cache, memory and SQLite drivers, at 100 B and 4 KiB: plain, and through a sealing driver wrapper. **Noisy**: three runs are in the output, and the wrapper copies more than the core would | `nice -n 10 bun bench-cache-overhead.ts` | `results-bench-cache-overhead.txt` |
| `bench-compression.ts` | zstd 1/3/9, gzip 1/6, raw and zlib-wrapped deflate, and Brotli 1/4/5/11 at 100 B, 4 KiB, 70 KB and 1 MiB of JSON, HTML and random bytes: ratio, compress and decompress µs. Then the async forms (`Bun.zstdCompress`, `zlib.gzip`, `zlib.brotliCompress`) against their sync forms. It also lists the compressors on `Bun` (no Brotli) | `nice -n 10 bun bench-compression.ts` (about 2 min) | `results-bench-compression.txt` |

**What `swap-attack.ts` runs:**

- **A.** Encryption done as a custom `Codec`, the only hook today, with the
  payloads swapped between keys and between namespaces.
- **B.** The plan's envelope, as a driver wrapper. B0a and B0b are its
  controls, without AAD. Then swap, cross-namespace copy, a flipped bit,
  rotation, a wrong key, an unknown key id, and a check that no plaintext
  sits in the stored bytes.
- **C.** Stripping an entry's tags in a stamps-mode store before
  `invalidateTags`, today and with the tags inside the envelope.
- **D.** Replaying an older ciphertext of the same key.

**Findings used by the plan:**

- **The survey** (§3.1).
  - `node:crypto` on Bun has no ChaCha20-Poly1305 (oven-sh/bun#8072),
    GCM-SIV, OCB (oven-sh/bun#42580) or CCM.
  - `crypto.subtle` has ChaCha20-Poly1305, imported only as `"raw-secret"`.
  - `Bun.CryptoHasher` with a key is HMAC.
- **Nonces** (§3.1). `getRandomValues` takes 0.04 µs against `randomBytes`'
  2.8 µs. Node 24 is no faster at `randomBytes`, so this is not filed as a Bun
  bug.
- **The cipher** (§3.2–§3.3, §4.2). `node:crypto` GCM takes about 1 µs at
  100 B and subtle about 12 µs. A per-entry key adds 0.7 µs.
- **The attacks** (§4.1, §4.5). A codec cannot bind ciphertext to its key,
  and the AAD stops the cross-namespace swap. The tags must come from the
  sealed body.
- **Compression** (§8.1). zstd stays the default; Brotli quality 4, not 11;
  deflate raw.
