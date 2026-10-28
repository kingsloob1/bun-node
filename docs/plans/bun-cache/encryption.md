# bun-cache: at-rest encryption, name hashing and pluggable compression

A sub-plan of [`README.md`](README.md) (the bun-cache plan). It plans three
features that share one mechanism, a chain of **transforms** the core applies
to every stored entry:

- **at-rest encryption**: an `encrypt` option on `createCache`, with a
  built-in AES-256-GCM, key rotation, key providers, and user-supplied
  ciphers;
- **name hashing**: keys, namespaces and tags stored as keyed hashes, so a
  dump of the store does not show them either;
- **pluggable compression**: Brotli and deflate beside zstd and gzip, and
  user-supplied compressors, configured the same way as ciphers.

On write the order is **encode → compress → encrypt**. On read it is the
reverse.

The user approved encryption in principle on 2026-10-28 ("plan it, then
build"). The same day they added three things: pluggable ciphers, key
providers and hashing functions; a survey and measurement of what Bun itself
offers for encryption; and customisable compression in the same configuration
style.

### Status (2026-10-28)

**Approved in full by the user on 2026-10-28.** That covers every
recommendation in §13 and every name in §14, as written. The user also
decided:

- **The build order:** PR-Z1 (compression) is built now. PR-E1 to PR-E3
  (encryption, name hashing, docs and playground) follow after the
  Cloudflare drivers (PR-C10, PR-C11).
- **The decompression cap (Q18):** a separate small PR, built now. It bounds
  decompression at `maxEntryBytes`, and a bomb reads as a miss plus an event.
- **Tag stripping on stamp-mode drivers:** only encrypted caches close it,
  because their tags are sealed in the envelope. For plain caches it is
  documented, not hardened.

**PR-Z1 built (2026-10-28)**, stacked on the decompression cap (#564): `"br"`
and raw `"deflate"`, `CacheCompressor` (sync or async) with
`compress.previous`, the per-call `compress: false`, and entry format 2
(written only for `br`, `deflate` or a user compressor; develop's own entries
pinned as byte fixtures). Every compressor goes through #564's bound:
`decompressBounded` takes the header's compressor id and decodes br and
deflate with node:zlib's `maxOutputLength`, and a user compressor is handed
the cap and held to it. Departures, each a question in the PR: a second
`decompress` argument, `maxOutputLength`; a `level` beside a user compressor
refused.

**PR-E1 built (2026-10-28)**, on develop `d41aa084` (after PR-Z1 and the
Cloudflare drivers): the `"BE"` envelope and the built-in `"aes-256-gcm"`
with a key per entry (`lib/core/encrypt.ts`); rings, `keys` functions with
`keyRefresh` and the unknown-id refresh; `aad`; the sealed tags and expiry,
trusted over the driver's; `CacheDecryptError` and the `"encrypt"`/`"decrypt"`
phases, with no deletion on failure; `acceptUnencrypted`; `CacheCipher` with
`previous`; `runCacheCipherConformance`; `keyId` on `hit` and `stale-hit`;
the README's "Encryption at rest". Every §11 test but `rawDump` (PR-E2), each
with its negative control. Decisions the plan left open, each a question in
the PR:
- **The tag-stamp check runs on every driver** for an encrypted cache, not
  only on stamps drivers: an index driver's tag index lives apart from the
  entry (SQL `tags`, Redis tag sets), so stripping it there must still miss.
  It costs one stamp read per tagged read, cached for `tagStampCacheMs`.
- **A failed `keys` call is retried** by a later operation at most once per
  second; `keyRefresh` is checked as operations run (no timer) and is
  refused beside a static ring.

The user kept both (2026-10-28). One fix followed, found by the examples
agent: a cache **without** `encrypt` read a sealed entry as a decode failure
and deleted it, so one process missing the configuration during a rollout
would wipe its peers' encrypted entries (against Q8). It now recognises the
`"BE"` magic and reads the entry as a miss with an `error` event
(`phase: "decrypt"`, `CacheDecryptError` reason `"cipher"`, the key id when
well-formed), never deleting it; its own `set` or load still overwrites it,
as any write of the app's does. No new name or reason.

Measured on the real cache ([`bench-e1-overhead.ts`](evidence/encryption/bench-e1-overhead.ts)):
`set`/`get` +3.9/+4.0 µs at 100 B on the memory driver (+8.4/+6.0 µs on
loopback Redis), +5.8/+4.6 µs at 4 KiB, and within the noise from 70 KB up.
Seal and open alone take about 2.6 µs each at 100 B, against §3.2's 1.8 and
1.9 µs for the bare cipher: the envelope's body, AAD and copies.

Written 2026-10-28 against `develop` at `251a64f1` (#560). **No product code
was changed.** Every `file:line` is at `251a64f1`, relative to
`packages/bun-cache/` unless it says otherwise. The marks are the main
plan's: [S] source-read, [M] measured, [W] read on the web, [I] inference,
[D] design.

Every measurement is on this machine (i9-11900H, 16 threads, Linux
7.0.0-38-generic), on Bun **1.4.4-canary.1+a0cc096ce**, at a load average of
3 to 6 from peer sessions, under `nice -n 10`. The evidence is in
[`evidence/encryption/`](evidence/encryption/README.md). Each script there
re-runs with one command.

### Status

**Plan only, 2026-10-28.** It awaits the user's answers to §13. Building is
four PRs (§12): PR-Z1 (compression), then PR-E1 (encryption), PR-E2 (name
hashing) and PR-E3 (docs, playground).

### Contents

1. [Summary](#1-summary)
2. [Threat model](#2-threat-model)
3. [What Bun offers, measured](#3-what-bun-offers-measured)
4. [The cipher design](#4-the-cipher-design)
5. [Keys](#5-keys)
6. [Pluggable ciphers](#6-pluggable-ciphers)
7. [Name hashing](#7-name-hashing)
8. [Compression](#8-compression)
9. [Interplay with the rest of bun-cache](#9-interplay-with-the-rest-of-bun-cache)
10. [The API](#10-the-api)
11. [Testing](#11-testing)
12. [PR slicing and effort](#12-pr-slicing-and-effort)
13. [Open questions for the user](#13-open-questions-for-the-user)
14. [Names needing approval](#14-names-needing-approval)
15. [Risks](#15-risks)
16. [Evidence](#16-evidence)

---

## 1. Summary

### The answer

- **Encryption.** Use **AES-256-GCM through `node:crypto`**, which on Bun is
  synchronous BoringSSL.
  - **Speed.** Sealing 100 B takes 1.0 µs and opening it 1.1 µs. That is 11×
    less than `crypto.subtle` awaited per operation, which costs about 12 µs
    on Bun at any small size [M].
  - **A key per entry.** Each entry gets its own key, derived from the user's
    key and a random 128-bit salt. This costs about 0.7 µs more per seal. It
    removes GCM's limit of 2^32 encryptions per key, which a cache writing
    10,000 entries a second would reach in **5 days** with plain random
    nonces [M].
- **What gets sealed.** The **whole entry** is sealed: the header, the full
  key, the payload, and copies of the tags and the hard expiry. The
  ciphertext is bound to its namespace and key by AAD.
  - **A swap attack.** We ran one on the real `createCache` [M]. Encryption
    done today, as a custom `Codec`, serves the wrong value when an attacker
    swaps two entries' payloads, in one namespace or across two.
  - **The envelope.** With the envelope, every swap, tamper, wrong-key and
    unknown-key case is a miss.
  - **Tag stripping.** Stripping an entry's tags in the store lets it survive
    `invalidateTags` today, on the file driver. With the tags inside the
    envelope, it does not.
- **Names.** Optional HMAC-SHA-256 name hashing (`hashNames`) is done **in
  the core**. Everything below the core then sees only hashed names: the
  drivers, the bus, L1 and the flight map.
  - **Its own key.** It takes a separate key that never rotates, because a
    changed names key would orphan every stored name.
- **Compression.** Add `br` and `deflate`, and user compressors. A one-byte
  compressor id goes into a **format-2 header**. It is written only when the
  new algorithms are used, so existing deployments write format 1 as they do
  today.
  - **zstd stays the default.** At equal ratio it is 3.5× faster than Brotli
    at quality 4. On incompressible bytes it gives up 50× sooner than gzip or
    deflate [M].
- **Custom transforms.** User ciphers and compressors may be **sync or
  async**. The core awaits only a returned promise. The read and write paths
  are already async, so an extra `await` costs 0.36 µs at 100 B [M]. The
  built-ins stay sync.

### The decisions this plan proposes

| # | Decision | Section |
|---|---|---|
| E1 | Encryption is a core transform, not a codec and not a driver wrapper | §4.1 |
| E2 | Built-in `"aes-256-gcm"`: `node:crypto`, a key per entry by HKDF from a 128-bit salt, a 96-bit nonce, nonces from `crypto.getRandomValues` | §4.2–§4.4 |
| E3 | The envelope seals the whole entry, plus the tags and the hard expiry, and the core trusts those over the driver's clear copies | §4.3 |
| E4 | AAD = a label, the namespace, the full key, an optional `aad` context, and the envelope's own prefix | §4.5 |
| E5 | A failed open is a miss with an `error` event (`phase: "decrypt"`), and the entry is **not deleted** | §4.6 |
| E6 | Keys are exactly 32 bytes; no passphrases in v1; key ids in the envelope; the first key encrypts and all keys decrypt; a key provider function may be async | §5 |
| E7 | User ciphers and compressors take ids 128–255, may return promises, and are checked by a conformance helper | §6, §8.4 |
| E8 | Name hashing is in the core, with its own stable key, as 128-bit hex HMACs bound to the namespace | §7 |
| E9 | The compressor id lives in a format-2 header, written only when needed | §8.3 |
| E10 | No per-namespace overrides; two `createCache` calls over one driver give that. Per call, only `compress: false` | §10.3 |

### What it costs

- **Effort.** About **10.5 focused days** over four PRs (§12).
- **Runtime.** About 1–2 µs of CPU per operation at 100 B. That is under a
  quarter of the encode-and-compress cost at 4 KiB, and 2–8% from 70 KB up
  [M]. A networked driver's round trip, 0.1 ms or more, hides all of it.

---

## 2. Threat model

### 2.1 What at-rest encryption protects [D]

It protects against **a reader of the store**, without the app's keys, who
learns the cached values:

- a dump or backup of Redis, a SQL database, MongoDB, an S3 bucket or the
  file driver's directory;
- a stolen disk or snapshot;
- a store operator, or a co-tenant of a managed store (Upstash, a shared
  database);
- a compromised store that can read everything.

It also protects against **a writer to the store** who wants the app to
accept forged or misplaced data. With the AAD and the sealed tags, such a
writer can only:

- delete entries;
- **replay an older ciphertext of the same key**, inside the lifetime it was
  written with (spike D1, §4.5);
- leave garbage, which reads as a miss.

They cannot:

- make the app serve a value under another key or namespace;
- forge a value;
- extend an entry's hard expiry, which comes from the sealed copy;
- strip its tags to dodge an invalidation.

### 2.2 What it does not protect [D]

- **A compromised app process.** It holds the keys, the decrypted values in
  L1, and every value it loads. Nothing in a cache library can help here.
- **Traffic and metadata analysis.** These stay visible:
  - each entry's size, ±1 byte (no padding, §13 Q14);
  - when it was written (`ca`, `at`, the file's mtime, the S3 `at=`);
  - when it expires (the driver's `expiresAt`, which native TTLs and
    sweepers need);
  - how often it is read (the store's own logs);
  - how many entries a namespace holds.
- **Names, unless `hashNames` is on** (§7). Keys, namespaces and tags appear
  in the store as written (§2.3). Turning on encryption alone does not change
  that.
- **Counter values.** Counters are plain integers, so that the backend can add
  to them atomically (§9.6).
- **A compression oracle.** Suppose an attacker can place chosen text inside a
  value that also holds a secret, and can watch the stored size. Then the
  compressed length leaks the secret byte by byte. This is the CRIME and
  BREACH class of attack [I]. Encryption hides the bytes, not the length.
  Such values belong in a cache with `compress: false`, or are written with
  `set(…, { compress: false })` (§8.5).
- **Availability.** A writer can always delete entries, or fill the store.

### 2.3 What each driver stores in clear today [S]

**Names** means keys, namespaces and tags. **Value bytes** are the core's
header and payload. The header holds the **full key** in clear
(`lib/core/header.ts:12-15`), so even a hashed long key is readable in the
value.

| Driver | Names in clear | Value bytes | Metadata in clear |
|---|---|---|---|
| memory | in process | in process | — |
| file | the namespace (`encodeSegment`); keys and tags as **unsalted** SHA-256, which a guess of a short key like `user:42` confirms; tags **verbatim** in each entry file's frame (`drivers/file.ts:133-152`) | the `.bce` file after its frame | `expiresAt` (14-byte frame), mtime, counter JSON `{ value, expiresAt, createdAt }`, lock JSON, `bus.log` JSON (keys, tags, namespace) |
| SQLite, Postgres, MySQL, MariaDB | `entries.ns`, `entries.k`, `entries.tg` (JSON), `tags.tag`, `stamps.tag`, `locks.k`; `bus.msg` (MySQL, MariaDB, SQLite), the `NOTIFY` payload (Postgres) | `entries.v` | `exp`, `ca`, `n` (counters), `stamps.at`/`exp` |
| Redis | key names `<p>:{<ns>}:e:<key>`, `…:t:<tag>`, `…:s:<tag>`; tags as JSON in each entry frame; pub/sub messages | the frame after its first line | `PEXPIREAT`, counter hashes `n`/`x`/`c`, stamps `"<at> <until>"` |
| MongoDB | `_id.ns`, `_id.k`, `tags[]`, the stamps' `_id.tag`; the capped `bus` collection | `v` | `exp`, `ca`, `n` |
| S3 | the namespace segment; keys and tags as unsalted SHA-256 in object names | the object body | `Content-Type: …; exp=; at=`, `lastModified`, counter objects |

The **bus** stores names at rest on four drivers. The SQL bus table keeps
them for `busRetention` (60 s), the MongoDB capped collection until it wraps,
and the file `bus.log` until compaction. That is the only reason name hashing
has to happen above the bus (§7.1).

### 2.4 What must stay in clear, and what can be sealed [D]

| Item | Stays in clear because | Sealed |
|---|---|---|
| `StoredEntry.expiresAt` | Native TTLs (Redis `PEXPIREAT`, the MongoDB TTL index) and every sweeper read it | A **copy** inside the envelope. The core enforces that copy, so a raised clear expiry gains the attacker nothing |
| `StoredEntry.tags` | `deleteByTags` on index drivers works through them | A copy inside the envelope. The stamps-mode read check (`cache.ts:609-626` today reads `raw.tags`) and `getEntry().tags` use the sealed copy. In the clear they are **hashed** under `hashNames` |
| `StoredEntry.key` and the namespace | Every driver addresses by them | Under `hashNames`, an HMAC in clear. The full key is always inside the sealed header |
| The envelope prefix: magic, version, cipher id, key id, salt, nonce | Needed to open the entry | Authenticated as AAD, not encrypted |
| `createdAt`, `freshUntil`, `loadMs`, codec id, flags, the full key, the payload | — | **Sealed.** The `negative` flag is sealed too, so a reader cannot tell which lookups came back empty |
| Counter values (`n`) | `INCRBY`, `$inc`, `n = n + ?` | No (§9.6) |
| Lock owner tokens | Compare-and-delete | Not needed: a random UUID (`cache.ts:1037`) |

---

## 3. What Bun offers, measured

### 3.1 The survey [M] [W]

Probed with [`probe-subtle.ts`](evidence/encryption/probe-subtle.ts) and
`bun -e`. The output is in `results-probe-subtle.txt`.

| API | Sync | What it offers here | Verdict |
|---|---|---|---|
| `node:crypto` `createCipheriv`/`createDecipheriv` | **yes** | `aes-128/192/256-gcm`. BoringSSL native since Bun 1.2.6 [W] | **The built-in** |
| `node:crypto` ChaCha20-Poly1305 | — | **Not on Bun:** `ERR_CRYPTO_UNKNOWN_CIPHER`. Open as [oven-sh/bun#8072](https://github.com/oven-sh/bun/issues/8072) since 2024-01-09 | — |
| `node:crypto` AES-GCM-SIV, OCB, CCM, XChaCha20 | — | Unknown cipher, all four. OCB is [oven-sh/bun#42580](https://github.com/oven-sh/bun/issues/42580). `getCiphers()` lists 28 ciphers, and GCM is the only AEAD among them | — |
| `crypto.subtle` AES-GCM | no | Async, imported `CryptoKey`. Its output is byte-compatible with node's GCM: each opens the other's (sanity block of `bench-ciphers.ts`) | Not the built-in: about 12 µs of thread hop per op. A user cipher may use it (§6) |
| `crypto.subtle` ChaCha20-Poly1305 | no | **Present** (the WICG "Modern Algorithms" set). It imports only as `"raw-secret"`, not `"raw"` [M] | Slower than GCM from 70 KB up (§3.2). For user ciphers |
| `crypto.subtle` HMAC, HKDF | no | Both work | 12 µs per awaited op: not for per-op name hashing |
| `Bun.CryptoHasher("sha256", key)` | **yes** | **HMAC** when given a key: the same bytes as `createHmac` [M] | **The name hasher**, and the per-entry key derivation |
| `node:crypto` `createHmac`, `hkdfSync`, `scryptSync` | yes | `hkdfSync` takes 1.1 µs; `scryptSync` takes 85 ms at N = 2^15 | `hkdfSync` once per key at startup; scrypt only if passphrases are ever wanted (§13 Q6) |
| `Bun.hash` | yes | wyhash: 64-bit, unkeyed, not cryptographic | **Not usable to hide names.** Anyone can recompute it from a guessed name |
| `Bun.password` | async and sync | argon2id and bcrypt password hashing. It writes PHC strings with a **random salt** | **Not for data.** It cannot encrypt, and cannot derive a stable key: it is for storing and checking passwords |
| `crypto.getRandomValues` | yes | 12 random bytes in **0.04 µs**, against `randomBytes(12)`'s **2.8 µs** on Bun (3.4 µs and 4.7 µs on Node 24.2.0) | **The nonce and salt source**. No `getrandom` syscall per call for either API (`strace`) |

**The "faster" claim.** Bun 1.2.6's release notes say Bun rewrote `Cipheriv`
and `Decipheriv` natively on BoringSSL.
- **What the notes measured.** Their aes-256-gcm benchmark went from 1.15 ms
  to 3.54 µs per iteration, on an M1 Max
  ([bun.sh/blog/bun-v1.2.6](https://bun.sh/blog/bun-v1.2.6), "Faster, more
  compatible `node:crypto`") [W].
- **Confirmed here.** A 100 B seal plus open takes 2.2 µs, which is that
  order. It is about 11× less than WebCrypto awaited per operation.
- **Not checked.** We did not compare Bun's GCM with Node's GCM; the choice
  does not need it.
- **One more finding.** The cost of a small seal was not the cipher at all:
  `randomBytes(12)` took 2.8 of the 3.7 µs ([`bench-nonce.ts`](evidence/encryption/bench-nonce.ts)).
  This is not a Bun regression, since Node 24 is no faster
  (`repro-randombytes.mjs`). Bun's `getRandomValues`, however, is 60× faster
  than Bun's `randomBytes`.

### 3.2 Cipher cost [M]

From [`bench-ciphers.ts`](evidence/encryption/bench-ciphers.ts), section 1:
random bytes, with the AAD set. Each cell is µs per op of wall time, then
CPU µs per op. The median of 5 rounds is shown.

| Candidate | Op | 100 B | 4 KiB | 70 KB | 1 MiB |
|---|---|---|---|---|---|
| node AES-256-GCM | seal | 1.03 / 1.10 | 2.24 / 2.82 | 20.3 / 27.3 | 309 / 404 |
| node AES-256-GCM | open | 1.14 / 1.17 | 1.89 / 2.11 | 16.0 / 20.1 | 173 / 219 |
| **node AES-256-GCM, a key per entry** (the built-in) | seal | 1.76 / 1.83 | 3.38 / 3.94 | 29.5 / 40.3 | 403 / 531 |
| **the same** | open | 1.90 / 1.96 | 2.59 / 2.78 | 14.6 / 18.1 | 179 / 226 |
| node GCM behind an `await` | seal | 1.39 / 1.43 | 2.53 / 2.89 | 19.8 / 26.3 | 321 / 416 |
| subtle AES-GCM, awaited one by one | seal | 11.8 / 16.0 | 15.0 / 19.6 | 42.3 / 53.1 | 554 / 667 |
| subtle AES-GCM, awaited one by one | open | 11.5 / 16.1 | 14.3 / 18.8 | 35.2 / 42.7 | 418 / 478 |
| subtle AES-GCM, 64 in flight | seal | 4.07 / 12.3 | 6.15 / 16.9 | 26.0 / 66.3 | 496 / 1413 |
| subtle AES-GCM, `importKey` per entry | seal | 17.8 / 23.2 | 19.4 / 24.7 | 60.0 / 70.6 | 609 / 724 |
| subtle ChaCha20-Poly1305 | seal | 14.7 / 19.7 | 19.6 / 24.9 | 89.0 / 101 | 1140 / 1243 |
| subtle ChaCha20-Poly1305 | open | 11.8 / 16.6 | 16.3 / 21.4 | 72.8 / 82.1 | 851 / 925 |

How to read it:

- **subtle runs off-thread.** Its CPU exceeds its wall time. At 64 in flight
  it reaches node's per-op wall time at 100 B, but burns 12× the CPU to get
  there.
- **The per-entry key costs** 0.7 µs per seal and 0.8 µs per open at 100 B.
  From 70 KB up it is noise.
- **ChaCha20-Poly1305** has no edge on this x86 machine, which has AES-NI. Its
  usual advantage is on CPUs without AES instructions [I].

### 3.3 Against bun-cache's own write and read path [M]

From `bench-ciphers.ts`, section 2. The values are cache-shaped records,
taken through `bun:jsc` `serialize` (the default codec) and zstd from 16 KiB
(the default threshold). Each cell is µs per op of wall time.

| JSON size | Stored payload | encode + zstd | + seal | Seal's share | decode | open + decode | Open's share |
|---|---|---|---|---|---|---|---|
| 63 B | 83 B | 1.06 | 2.38 | 56% | 0.60 | 1.89 | 68% |
| 4,164 B | 2,193 B | 13.1 | 16.2 | 19% | 8.36 | 10.8 | 23% |
| 70,042 B | 2,403 B (zstd) | 286 | 312 | 8% | 143 | 140 | within noise |
| 1,048,807 B | 29,328 B (zstd) | 4,392 | 4,486 | 2% | 1,979 | 1,926 | within noise |

**Compression first makes encryption cheap on large values.** The cipher
sees the compressed bytes: 2.4 KB, not 70 KB.

**Whole cache operations** ([`bench-cache-overhead.ts`](evidence/encryption/bench-cache-overhead.ts),
the real `createCache`, with a driver wrapper that seals like the built-in).
This is the noisiest measurement here. Three runs at a load of 3–6 gave:

- memory, 100 B: `set` +3 to +8 µs, `get` +3 to +9 µs, on 3–8 µs;
- SQLite, 4 KiB: no difference out of the noise.

The wrapper copies more than the core would. Read these as the upper bound
of the overhead, not its value.

---

## 4. The cipher design

### 4.1 Where encryption lives [D] [M]

We considered three places:

- **A `Codec`.** This is the only hook today, and it is **wrong**:
  - a codec sees the value, not its key, so it cannot bind the ciphertext to
    it;
  - the header (the full key, `createdAt`, the flags) stays in clear and
    unauthenticated.

  Spike A ([`swap-attack.ts`](evidence/encryption/swap-attack.ts)) swaps two
  entries' payloads and keeps each one's clear header. The real
  `createCache` then serves alice's admin record for `user:2`, and tenant
  a's invoice in tenant b. Also, `Codec.encode` is synchronous.
- **A driver wrapper** (`encryptDriver(driver)`). This works for values.
  Spike B shows it, as the spike's stand-in. It fails for names:
  - the core keys L1, the flight map, the stamp cache and bus messages by
    the names it passes down;
  - so hashing names below the core means a bus message from another process
    arrives with hashes the receiving core cannot match to its own L1.
- **The core** — **chosen**.
  - **Where it runs.** `#write` (`cache.ts:774`) seals after `encodeEntry`,
    and `#decodeStored` (`cache.ts:579`) opens before `decodeEntry`. Both
    are already async.
  - **Every other path.** It also covers `touch` (`cache.ts:1739`), the
    background-refresh rewrite (`cache.ts:1377-1394`) and `getMany`.
  - **L1 gets the plaintext.** `#l1CopyOfWrite` (`cache.ts:913`) is handed
    the plaintext entry bytes, not the sealed ones, so L1 never decrypts.
  - **The only API change** is the new options.

### 4.2 The built-in cipher: `"aes-256-gcm"` [D] [M]

- **Implementation.** `node:crypto` `createCipheriv("aes-256-gcm")`, with the
  key given as a `Buffer`. A `KeyObject` measured the same: 1.02 against
  1.03 µs.
- **A key per entry.** Each seal draws a 16-byte **salt** and a 12-byte
  **nonce** from `crypto.getRandomValues`. Then:

  ```
  K      = HKDF-SHA-256(ikm = user key, salt = "", info = "bun-cache/enc/1/aes-256-gcm")   once per key
  K_salt = HKDF-Expand(K, "entry" ‖ salt, 32) = HMAC-SHA-256(K, "entry" ‖ salt ‖ 0x01)       per seal, Bun.CryptoHasher
  sealed = AES-256-GCM(K_salt, nonce, plaintext, AAD)                                        16-byte tag
  ```

- **Why a key per entry, and not plain random nonces** (§4.4): a nonce repeat
  under one GCM key leaks the XOR of two plaintexts and the authentication
  key, which allows forgery. The per-entry key moves the birthday bound from
  96 bits to the salt's 128. This is the same idea as XAES-256-GCM [I].
- **Why not ChaCha20-Poly1305 or AES-GCM-SIV.** Neither is in Bun's
  `node:crypto` (§3.1); ChaCha20 is subtle-only, async and slower here.
  GCM-SIV would make nonce repeats harmless, but it is not available.

### 4.3 The envelope [D]

```
offset  size  field                                    (built-in cipher)
0       2     magic "BE"
2       1     envelope version 1
3       1     cipher id: 1 = "aes-256-gcm"; 128–255 a user cipher (§6)
4       1     key id length L (1–32)
5       L     key id, UTF-8
5+L     16    salt
21+L    12    nonce
33+L    n     ciphertext of the sealed body
33+L+n  16    GCM tag

sealed body = u8 body version (1)
            | f64 LE expiresAt (-1 = none)
            | u16 LE tag count | per tag: u16 LE length, UTF-8
            | the core entry: the format-1 or format-2 header and its payload (lib/core/header.ts; §8.3)
```

**For a user cipher**, the core writes bytes 0–3. Everything after them is
the cipher's own output: its key id, its nonce and its tag.

**The size.**
- The built-in adds **49 + L bytes**, so 56 B for a seven-character id such
  as `2026-10`.
- The sealed body adds 11 bytes, plus the tags.
- An entry of 140 B grows to about 210 B; one of 70 KB grows by under 0.1%.
- `maxEntryBytes` and the driver's cap are checked against the **sealed**
  size (§9.2).

**What the core trusts.** It takes `expiresAt` and the tags from the sealed
body, never from the driver's `StoredEntry`. Two things follow:
- an attacker who raises the clear expiry gains nothing;
- an attacker who strips the clear tags gains nothing. Spike C1 measures the
  hole as it is today: on the file driver, an entry whose tags were removed in
  the store survives `invalidateTags`. Spike C2 shows the same entry
  invalidated once the tags come from the envelope.

### 4.4 Nonces at volume [M]

From [`nonce-bound.ts`](evidence/encryption/nonce-bound.ts). NIST SP 800-38D
§8.3 caps random 96-bit nonces at 2^32 encryptions per key.

| Writes/s | Time to reach 2^32 seals | P(any repeat) after 1 year, plain random nonces | After 1 year, a key per entry (128-bit salt) |
|---|---|---|---|
| 100 | 497 days | 6.3e-11 | 1.5e-20 |
| 1,000 | 49.7 days | 6.3e-9 | 1.5e-18 |
| 10,000 | 5.0 days | 6.3e-7 | 1.5e-16 |
| 100,000 | 11.9 hours | 6.3e-5 | 1.5e-14 |

- **Counters are not an option.** A counter nonce would need coordination
  across processes, which a cache does not have.
- **Rotating keys is not an option.** No process can count the cluster's
  writes to know when to rotate.
- **The per-entry key is the fix,** at the 0.7 µs measured in §3.2.

### 4.5 AAD: binding a ciphertext to its place [D] [M]

```
AAD = "bun-cache/enc/1" 0x00 | full namespace 0x00 | full key 0x00 | encrypt.aad (or empty) 0x00 | envelope bytes 0 .. end of nonce
```

**Its parts.**
- **The plaintext names.** The namespace and key are the plaintext full
  ones, not the stored forms. So the binding does not depend on `hashNames`
  or the long-key hashing.
- **The envelope prefix** binds the cipher id and the key id.
- **`aad`** is optional context such as `"prod"`. With it, an entry written
  by one environment does not open in another that shares the key.

**What spike B measured**, on the real `createCache`:

| Attack | Envelope without AAD (control) | With AAD |
|---|---|---|
| Swap `user:1` and `user:2` in one namespace | miss (B0a): the full key inside the sealed header differs | miss (B1) |
| Copy tenant-a's `invoice:8` over tenant-b's | **served tenant a's invoice** (B0b) | miss (B2) |
| Flip one ciphertext bit | — | miss (B3) |
| **Replay** an older ciphertext of the same key | — | **served the old value** (D1): not preventable without a server-side version, which a cache store does not offer |

So the AAD is what stops a cross-namespace swap, and the sealed full key is
a second guard within one namespace. A replay is bounded by the sealed
`freshUntil` and `expiresAt`: a replayed entry is at most as fresh as when it
was written. The README says so.

### 4.6 When an entry does not open [D]

These outcomes are **a miss**, with an `error` event (`phase: "decrypt"`,
error `CacheDecryptError` with a `reason`):

- the tag fails (`"auth"`);
- the key id is unknown (`"unknown-key"`, after one key refresh, §5.4);
- the bytes are not an envelope (`"unencrypted"`), unless
  `acceptUnencrypted`;
- the envelope is malformed (`"malformed"`);
- a user cipher throws (`"cipher"`).

How each case is handled:

- **Never thrown, not even under `strict`.** This matches decode errors
  (§3.2 of the main plan). A cache that cannot read an entry falls back to
  the origin.
- **Not deleted.** Unlike decode failures, which `#deleteInBackground`
  removes (`cache.ts:595`). During a key rollout, a process that does not
  yet have the new key would otherwise delete every entry its peers wrote.
  The entry is overwritten by the next `set` or load anyway.
- **Logged** at `warn` at most once per 10 s per reason, as driver errors are.
  The message names the key id, never key material or plaintext.
- **Writes.** When a write cannot seal (no key yet, the provider failed, a
  user cipher threw), the `set` resolves `false` with an `error` event
  (`phase: "encrypt"`). It throws only under `strict`, as a driver write
  does (§3.14). Nothing is stored unencrypted, ever.

---

## 5. Keys

### 5.1 Key material [D] [M]

- **The format.** A key is **32 bytes**: a `Uint8Array`, or a string that
  decodes to exactly 32 bytes as base64, base64url or hex.
  - Anything else is a `TypeError` at `createCache`, and the message gives
    `openssl rand -base64 32`.
  - **No passphrases in v1** (§13 Q6). A passphrase needs a slow KDF and a
    stored salt. scrypt at N = 2^15 costs 85 ms, and 316 ms at 2^17
    ([`bench-hmac.ts`](evidence/encryption/bench-hmac.ts)). Users then get
    the salt wrong: a random salt per start is a cold cache on every boot. A
    helper can come later.
- **Derivation.** Per key and per use, with HKDF-SHA-256 and a distinct
  `info` (`bun-cache/enc/1/aes-256-gcm`, `bun-cache/names/1`). One key's
  bytes are never used directly for two purposes. `hkdfSync` takes 1.1 µs,
  once per key per process.

### 5.2 Key ids and rotation [D] [M]

- **The ring.** `keys: [{ id, key }, …]`.
  - The **first** encrypts, and **all** decrypt.
  - An id is 1–32 bytes of `[A-Za-z0-9._-]`; ids are unique, and the ring is
    not empty.
  - The id is written into every envelope, so a read picks its key directly
    without trying each one.
- **The rotation runbook** (in the README). Spike B4 opens an entry written
  under `2026-09` with the ring `[2026-10, 2026-09]`.
  1. Deploy `[old, new]`: every process can read the new key's entries.
  2. Deploy `[new, old]`: new writes use the new key.
  3. After the longest TTL plus its stale window, deploy `[new]`.

  Skipping step 1 costs only misses while the deploy rolls. Entries are not
  deleted on failure (§4.6).
- **Re-encrypt on read** (`reencrypt`): **not in v1** (§13 Q7). It would turn
  reads into writes during a rotation, and TTL turnover re-encrypts anyway.
  The `CacheDecryptError` reason and the `keyId` on `hit` (§10.2) show when
  an old key is no longer used.

### 5.3 Key providers: KMS, Vault, environment [D]

`keys` may be a function returning the ring or a promise of it. bun-cache
never talks to a KMS itself: there is no dependency. The README shows the
envelope-key pattern, where the function asks the KMS to decrypt a data key
once.

- **When it is called.** On first use, and again every `keyRefresh` ms
  (default: never after the first call).
- **Before it answers.** Operations wait for the first call. A read waits at
  most the read `timeout` and is then a miss; a write resolves `false`.
- **An unknown key id on read** triggers one early refresh, at most once per
  10 s. A process then learns a peer's new key without a restart.
- **When it rejects.** An `error` event (`phase: "encrypt"` on a write,
  `"decrypt"` on a read) and the previous ring stays. Before any ring exists,
  writes resolve `false` and reads miss.
- **Validation.** Each answer is checked like a static ring (§5.1). An
  invalid ring is rejected as a provider failure, never half-applied.

---

## 6. Pluggable ciphers

### 6.1 The interface [D]

```ts
interface CacheCipher {
  /** Stored in the envelope: 128–255 (1–127 are the package's). */
  id: number;
  /** Seals `plaintext`, authenticating `context.aad`. May be async. */
  seal(plaintext: Uint8Array, context: CacheCipherContext): Uint8Array | Promise<Uint8Array>;
  /** Opens what `seal` wrote; throws when it does not authenticate. May be async. */
  open(sealed: Uint8Array, context: CacheCipherContext): Uint8Array | Promise<Uint8Array>;
}
interface CacheCipherContext {
  /** The full namespace, plaintext. */
  namespace: string;
  /** The full key, plaintext. */
  key: string;
  /** The AAD the core built (§4.5), without the user cipher's own bytes. The cipher must authenticate it. */
  aad: Uint8Array;
}
```

`encrypt: { cipher: myCipher }` replaces the built-in. Its key management is
its own business: KMS calls, HSMs, a library such as `@noble/ciphers`. Then:

- **`keys` is refused** beside a user cipher: a `TypeError` naming the
  conflict.
- **`hashNames` still works**, with its own key (§7).
- **`previous: [oldCipher, …]`** decrypts entries written by an earlier
  cipher, as the key ring does for keys. The built-in
  `"aes-256-gcm"` is always readable when `keys` are given.
- **An unknown cipher id is a miss** (`"cipher"`), as an unknown codec id is.

### 6.2 Sync or async [D] [M]

- **The user cipher may return a promise.** The core awaits only a thenable,
  so a sync cipher pays nothing for the option.
- **The cost of the extra `await`.** The core's read and write paths are
  already async (`#write`, `#decodeStored`). Putting a sync GCM seal behind
  an `await` added **0.36 µs** at 100 B (1.03 to 1.39 µs, §3.2).
- **Async ciphers run where the built-ins run.** `#l1CopyOfWrite` works on
  the plaintext and needs no cipher. `touch` and the refresh rewrite are
  async already.
- **The built-in stays sync.** subtle's 11 µs hop buys nothing for a cipher
  that `node:crypto` runs in 1 µs.

### 6.3 Checking a user cipher [D]

`./testing` gains `runCacheCipherConformance(name, cipher)`, on `bun:test`.
It asserts:

- a round trip at 0 B, 100 B, 70 KB and 1 MiB;
- the ciphertext does not contain the plaintext;
- two seals of the same input differ: a randomised nonce;
- a flipped bit fails;
- a changed `aad`, `namespace` or `key` fails;
- truncation fails;
- an async cipher round-trips.

A cipher that ignores `aad` fails the suite. The negative control is a test
cipher that does exactly that.

---

## 7. Name hashing

### 7.1 Where and how [D] [M]

- **On.** `encrypt.hashNames: { key }` turns it on.
  - **It requires encryption.** The sealed header carries the full key, and
    without encryption that key is readable in the value, which would make
    hashing pointless. `createCache` refuses `hashNames` with no cipher.
- **The hash.** Each name becomes the lower-case hex of the first 128 bits
  of `HMAC-SHA-256(K_names, …)`, bound to its kind and namespace:

  ```
  K_names        = HKDF-SHA-256(hashNames.key, info = "bun-cache/names/1")
  stored ns      = hex128(HMAC(K_names, "ns"  0x00 full namespace))
  stored key     = hex128(HMAC(K_names, "key" 0x00 full namespace 0x00 full key))
  stored tag     = hex128(HMAC(K_names, "tag" 0x00 full namespace 0x00 tag))
  ```

- **Why bind keys and tags to the namespace.** Without it, the same key in
  two namespaces hashes alike, and the dump shows which tenants hold the
  same key.
- **Why 32 hex characters.**
  - The format fits every driver's rules: SQL `VARCHAR(255)`, file and S3
    segments, Redis hash tags. It is case-proof for the file driver's
    `encodeSegment`.
  - A collision between two stored keys only makes them overwrite each
    other's entries: a miss, never a wrong value. The sealed header's full
    key is checked on read (`cache.ts:490-495`).
  - At 2^40 keys the chance of any collision is about 2^-49.
- **Cost.** 0.44 µs (12 B) to 0.61 µs (200 B) per name with
  `Bun.CryptoHasher`, against 0.68–0.85 µs with `createHmac`
  ([`bench-hmac.ts`](evidence/encryption/bench-hmac.ts)). The core keeps a
  bounded memo (by default, the last 10,000 names), since hot keys repeat.
- **In the core.** `this.#ns` and `#storedKey()` (`cache.ts:225-243`) answer
  the hashed forms, and tags are hashed before every driver call. So the
  drivers, L1, the flight map, the stamp cache and **bus messages** all see
  one consistent set of hashed names (§4.1).
  - **Events keep the plaintext.** `hit`, `miss`, `fenced` and the rest go to
    the app's own listeners, which already know the names.
  - **The core's two log lines** (`cache.ts:1073`, `1403`) switch to the
    stored form, because logs are often stored.
- **Long keys.** The current `#` + SHA-256 step (§3.7 of the main plan) is
  skipped under `hashNames`: an HMAC already has a fixed length.

### 7.2 Per driver [S] [D]

| Driver | Under `hashNames` | Unchanged |
|---|---|---|
| memory | Hashed map keys (no reason to, but harmless) | — |
| file | Directory and file names from hex, so `encodeSegment` is a pass-through; the entry frame's tags hashed | The frame's `expiresAt`, mtime |
| SQLite and SQL | `ns`, `k`, `tg`, `tags.tag`, `stamps.tag`, `locks.k`, `bus.msg` (hashed names in JSON) | `exp`, `ca`, `n` |
| Redis | Key names `<p>:{<hns>}:e:<hk>`. The hash tag is still one per namespace, so one slot per namespace, as today. The frame's tag JSON is hashed | TTLs, counter fields |
| MongoDB | `_id`, `tags[]`, `bus.m` | `exp`, `ca`, `n` |
| S3 | Object names (the namespace segment; `sha256(hashed key)`) | `Content-Type` `exp=` and `at=` |

**Behaviour that stays the same.**
- `clear()`, `invalidateTags()` and the bus work as before, since every
  driver matches the namespace exactly (`memory.ts:310`, `ns = ?`, the Redis
  `{<ns>}` scan).
- Nothing ever needs a prefix relation between a namespace and its children:
  `clear()` does not reach child namespaces today (§3.7).
- **Counters** are hashed the same way as entries, by key (§9.6).
- **The HTTP response cache** gains most. Its keys contain URLs, query
  strings and `Vary` header values (`lib/http/key.ts:113-128`). Its path tags
  contain paths (`key.ts:146`). All of them become opaque.

### 7.3 Debuggability [D]

`cache.describeKey(key, tags?)` returns `{ namespace, key, tags }`: the
stored forms, to find an entry in a dump or a `redis-cli` session. A `get`
with `{ tier: "l2" }` still works for checking a value. The README covers
finding a key by its hash.

### 7.4 A user hash, and all or nothing [D]

- **A user hash.** `hashNames: { hash(name, context) }` replaces the HMAC,
  for example to match an existing scheme.
  - `context` is `{ kind: "namespace" | "key" | "tag", namespace }`.
  - The output must be 1–200 bytes, with no NUL or newline, and is checked
    on first use. It must be deterministic, which the README says and a
    conformance case checks: hash twice, compare.
- **All or nothing.** Hashing applies to the whole cache and every
  `namespace()` view of it. Mixed views would make one view's entries
  invisible to another under the same name.
- **Turning it on is a flush.** Old entries sit under plaintext names nobody
  asks for any more, and expire or are swept. The README says to `clear()`
  first, or to accept the orphans. The same holds for changing
  `hashNames.key`, which is why it is its own key and **never rotates with
  the encryption keys**. Rotating it means a new, empty cache, as a
  `version` bump does.

---

## 8. Compression

### 8.1 The algorithms, measured [M]

From [`bench-compression.ts`](evidence/encryption/bench-compression.ts):
deterministic JSON records, an HTML table page, and random
(incompressible) bytes. Each cell is the ratio, then compress µs, then
decompress µs. The run has the full table, including zstd 1 and 9, gzip 1
and Brotli 1 and 5.

| Algorithm | JSON 4 KiB | JSON 70 KB | JSON 1 MiB | HTML 100 B | HTML 70 KB | Random 70 KB | Random 1 MiB |
|---|---|---|---|---|---|---|---|
| zstd 3 (default) | 3.8× 17 / 6.6 | 5.0× 184 / 64 | 20.8× 967 / 442 | 1.1× 3.9 / 1.6 | 6.9× 128 / 53 | 1.0× **27** / 7.4 | 1.0× **356** / 91 |
| gzip 6 (Bun) | 3.7× 26 / 7.5 | 5.1× 817 / 53 | 14.9× 3389 / 380 | 1.0× 7.0 / 1.9 | 7.7× 684 / 45 | 1.0× 1335 / 8.7 | 1.0× 20685 / 123 |
| deflate 6, raw (Bun) | 3.8× 30 / 7.5 | 5.1× 792 / 64 | 14.9× 3180 / 358 | 1.2× 7.1 / 1.9 | 7.7× 675 / 43 | 1.0× 1380 / 8.4 | 1.0× 20730 / 90 |
| deflate 6, zlib-wrapped (node:zlib) | 3.7× 27 / 8.8 | 5.1× 779 / 75 | 14.9× 3243 / 594 | 1.1× 10 / 4.4 | 7.7× 713 / 58 | 1.0× 1337 / 20 | 1.0× 20376 / 243 |
| br 4 (bun-common's default) | 3.9× 56 / 10 | 5.0× 642 / 124 | 20.0× 3917 / 871 | **1.4×** 12 / 3.4 | 7.1× 528 / 90 | 1.0× 110 / 22 | 1.0× 2199 / 322 |
| br 11 (Brotli's default) | 4.4× 5145 / 14 | 6.4× **90397** / 137 | 28.2× **3.04 s** / 844 | 2.2× 256 / 3.8 | 9.6× 90140 / 88 | 1.0× 17216 / 21 | 1.0× 0.36 s / 316 |

What the numbers show:

- **zstd 3 stays the default.**
  - It matches Brotli 4's ratio on JSON in a quarter to a third of the
    time, and gzip's ratio in a quarter of the time.
  - Its decompression is the fastest but one.
  - On incompressible bytes, an image or something already compressed, it
    gives up in 27 µs at 70 KB. gzip and deflate spend 1.3 ms there, and
    20 ms at 1 MiB, before the core's "only if smaller" rule
    (`cache.ts:478`) throws the result away.
- **Brotli's quality default must be 4.** Its own default, 11, takes 90 ms
  for 70 KB and 3 s for 1 MiB: 140× and 780× the time of quality 4, for at
  most 1.4× the ratio. That confirms the reason bun-common's
  `compression.ts:125-127` gives for its quality 4 ("two orders of magnitude
  slower").
  - **Where Brotli helps a cache:** **small text**, through its built-in
    dictionary. 100 B of HTML compresses 1.4× at quality 4, where zstd gives
    1.1×, but that only matters with a threshold far under the default.
- **deflate is raw DEFLATE** (RFC 1951) through `Bun.deflateSync`. It is the
  same ratio as the zlib-wrapped form, 6 bytes shorter, and its 1 MiB
  decompression is 0.36 ms against 0.59 ms. The stored bytes never reach HTTP,
  so HTTP's zlib wrapping (RFC 9110 §8.4.1.2), which bun-common must use, does
  not apply. The README says so, because the name is the same.
- **Bun has no `Bun.brotli*`.** The Bun functions are `deflateSync`,
  `gunzipSync`, `gzipSync`, `inflateSync`, `zstdCompress(Sync)` and
  `zstdDecompress(Sync)`. Brotli is `node:zlib` `brotliCompressSync` and
  `brotliDecompressSync`.
- **The async forms are slower per operation** ("Async forms" in the
  results). `await Bun.zstdCompress` took 1.6 ms against `zstdCompressSync`'s
  0.69 ms on 1 MiB. `await zlib.gzip` took 160 µs against 52 at 4 KiB. They
  buy only an unblocked loop, so the built-ins stay sync. bun-common's
  `asyncThreshold` (64 KiB) exists because an HTTP body may be 10 MiB; a
  cache entry is capped at 4 MiB by default.

### 8.2 The defaults [D]

| `algorithm` | Default `level` | Range | Implementation |
|---|---|---|---|
| `"zstd"` (default) | 3 | 1–22 | `Bun.zstdCompressSync` / `zstdDecompressSync` |
| `"gzip"` | 6 | 0–9 | `Bun.gzipSync` / `gunzipSync` |
| `"br"` | **4** (bun-common's) | 0–11 | `node:zlib` `brotliCompressSync` with `BROTLI_PARAM_QUALITY` |
| `"deflate"` | 6 | 0–9 | `Bun.deflateSync` / `inflateSync` (raw) |

- **The threshold stays 16 KiB for every algorithm** (§13 Q13). Lowering it
  would change the CPU and the stored size of every existing deployment. The
  README shows that at 4 KiB, zstd saves 3.8× for 17 µs.
- **`level` is the one tuning knob.** It means Brotli's quality for `"br"`.
  bun-common's full `brotli`/`zstd` option objects are not mirrored: a cache
  entry is one buffer, not a stream, and the other parameters are
  window and stream controls.

### 8.3 The header: a format 2, written only when needed [S] [D]

- **No room in today's flags byte.** It has three free bits (bits 5–7,
  `header.ts:31-42`), not enough for two more algorithms plus user ids.
- **Format 2** has one extra byte after the flags:

  ```
  format 2:  "BC" | 2 | codec | flags (bits 0–1 zero; counter, negative, rawString as today) | compressor id | f64 createdAt | f64 freshUntil | f64 loadMs | u32 key length | key | payload
  compressor id: 0 none, 1 zstd, 2 gzip, 3 br, 4 deflate (raw), 128–255 a user compressor
  ```

- **When each is written.** The core writes **format 1 whenever it can
  express the entry**: no compression, zstd or gzip. That is every entry a
  cache configured as today writes. Format 2 is written only for `br`,
  `deflate` or a user compressor.
- **Why.** During a rolling deploy, a process on the old version reads a
  format-2 entry as a decode failure (`header.ts:110-114`): a miss, deleted.
  That is acceptable during the deploy that **turns on** Brotli. It is not
  acceptable for every deploy of the new version.
- **Reading.** The decoder reads both formats. An unknown compressor id is a
  miss with `phase: "decode"`, as an unknown codec id is (`codecs.ts:110`).
- **Encryption is separate.** It has its own magic (`"BE"`) and wraps either
  format.

### 8.4 User compressors [D]

```ts
interface CacheCompressor {
  /** Stored in the header: 128–255 (0–127 are the package's). */
  id: number;
  compress(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>;
  decompress(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>;
}
```

- **How to use one.** `compress: { algorithm: myCompressor, threshold }`. It
  takes the same option slot as a built-in name: one configuration style for
  both kinds, and the same as `encrypt.cipher`.
- **Sync or async.** Either, as with ciphers (§6.2).
- **The "only if smaller" rule** applies to user compressors too.
- **Reading old entries.** Every built-in always decompresses.
  `compress.previous: [oldCompressor]` keeps entries from an earlier user
  compressor readable; without it they are misses.
- **The decompression bomb.** No decompression is capped today [S]:
  `#decodeValue` calls `Bun.zstdDecompressSync` and `Bun.gunzipSync` with no
  output limit (`cache.ts:498-503`). So a store writer can plant a small
  entry that expands to gigabytes on read.
  - **Encryption closes this** for encrypted caches: a forged entry does not
    open.
  - **Plain caches** need a cap, which is outside this plan (§13 Q18). A
    user compressor gets no more protection than the built-ins.
- **A dictionary-trained zstd** is the obvious user compressor. Bun's native
  zstd ignores a dictionary (bun-common's comment at `compression.ts:828`),
  so it goes through `node:zlib` `zstdCompressSync({ dictionary })`. The
  README shows it.

### 8.5 Sharing with bun-common [S] [D]

- **The type, not the code.** bun-cache already depends on bun-common
  (`package.json:141`), and imports its types (`types.ts:10`). The
  `algorithm` union is typed **`CompressionEncoding | CacheCompressor`**,
  with `CompressionEncoding` imported from bun-common (`compression.ts:61`).
  The two spellings cannot drift: if bun-common adds an encoding, bun-cache's
  exhaustive `switch` fails to compile until it handles it.
- **No shared runtime helper.** bun-common's `createCodec`
  (`compression.ts:750`) is internal, and HTTP-shaped: streams, RFC 9842
  dictionaries, zlib-wrapped deflate, flush kinds, prefixes. Exporting it
  would make an HTTP detail a cache format.
- **The Brotli default, 4, is mirrored** with a comment pointing at
  `compression.ts:737`. bun-common exports no constant for it, and adding one
  is a bun-common name (§13 Q12).
- **Per call, `compress: false`** on `set`, `setMany`, `getOrSet` and `wrap`.
  This is for values the caller knows are already compressed (images,
  archives), where gzip, deflate and Brotli would waste up to 20 ms per MiB
  before the "only if smaller" rule discards their work. It is also the
  escape from the compression oracle (§2.2).

---

## 9. Interplay with the rest of bun-cache

### 9.1 Compression ratios [D]

Unchanged. Compression runs first, on plaintext; ciphertext does not
compress.

### 9.2 `maxEntryBytes` [D]

Checked on the bytes the driver receives: the sealed envelope (§4.3, +56 B
and the tags). For a store-imposed cap (`capabilities.maxEntryBytes`),
`oversize` reports the sealed size against it, and `stats().bytesWritten`
counts sealed bytes.

### 9.3 L1 [S]

L1 already holds decoded values (§4.1 of the main plan), so it never
decrypts on a hit and never holds ciphertext. The bus carries names, never
values (R13): with `hashNames`, hashed names.

### 9.4 The HTTP response cache and bun-nest [S]

`cacheResponse` stores frames as cache values (`lib/http/frame.ts`), and the
bun-nest decorators call `getOrSet`. Both inherit encryption and name hashing
with no change: they use `createCache`'s cache. Hashing the HTTP keys
matters most (§7.2).

### 9.5 Stats, events and logs [D]

- **Events** keep plaintext names: they are the app's own in-process API.
  - **New:** an optional `keyId` on `hit` and `stale-hit` from an encrypted
    entry, so a listener can watch an old key drain.
  - **New:** `phase: "encrypt" | "decrypt"` on `error`.
- **No event or error carries plaintext values or key material.**
  `CacheDecryptError`'s message names the reason and the key id only.
- **Logs** use the stored names under `hashNames` (§7.1).
- **`stats()`** gains nothing: the `error` events cover decryption failures.

### 9.6 Counters [D]

- **They stay plaintext integers.** `INCRBY`, `$inc` and `n = n + ?` need
  the number, and an encrypted counter cannot be incremented by the backend.
  Order-preserving or homomorphic schemes are out of scope.
- **Their names are hashed** under `hashNames`, as entries' are.
- **Not refused.** A counter is usually a rate-limit or hit count, so the
  README documents it rather than refusing `increment` on an encrypted cache
  (§13 Q10).

### 9.7 Other processes and other languages [D]

- **Every process sharing the cache needs the same keys** (and `hashNames`
  key). One without them misses (§4.6).
- **A non-Bun reader** (the main plan's Q8, `codec: "json"`) now also needs
  the keys and the envelope format, both specified in the README:
  HKDF-SHA-256, HMAC-SHA-256 and AES-256-GCM are in every standard library.
- **`acceptUnencrypted: true`** lets an encrypted cache read plain entries
  during a migration. Writes are always sealed. It is **off by default**:
  with it on, anyone who can write to the store can inject plaintext values
  the app accepts (§13 Q9).

### 9.8 `validate` (V10) and stamps mode [S]

- **`validate`** runs after the entry is opened, on the decoded value, as
  today.
- **The stamps-mode tag check** uses the sealed tags (§4.3), hashed again for
  the stamp lookup when `hashNames` is on.

---

## 10. The API

### 10.1 Example [D]

```ts
import { createCache, redisDriver } from "@kingsleyweb/bun-cache";

const cache = createCache({
  driver: redisDriver({ url }),
  compress: { algorithm: "br", level: 4, threshold: 4096 },   // or "zstd" (default), "gzip", "deflate", or a CacheCompressor
  encrypt: {
    keys: [
      { id: "2026-10", key: process.env.CACHE_KEY_2026_10! },  // the first encrypts
      { id: "2026-09", key: process.env.CACHE_KEY_2026_09! },  // still decrypts
    ],
    // or: keys: async () => await loadKeysFromKms(), keyRefresh: 300_000,
    // or: cipher: myCipher (a CacheCipher), previous: [oldCipher],
    aad: "prod",                                       // optional context bound into every entry
    hashNames: { key: process.env.CACHE_NAMES_KEY! },  // optional; never rotated
    // acceptUnencrypted: true,                        // migration only
  },
});

await cache.set("img:1", pngBytes, { compress: false });        // already compressed
cache.describeKey("user:42", ["org:7"]);  // { namespace: "3f…", key: "9a…", tags: ["c1…"] }
```

### 10.2 Types [D]

```ts
interface CacheEncryptOptions {
  /** The built-in cipher's keys: the first encrypts, all decrypt. A function may be async (a KMS). Required unless `cipher` is a CacheCipher. */
  keys?: CacheKeyRing | (() => CacheKeyRing | Promise<CacheKeyRing>);
  /** Re-call a `keys` function after this many ms. Default: never (an unknown key id still triggers one refresh per 10 s). */
  keyRefresh?: number;
  /** `"aes-256-gcm"` (the default) or a user CacheCipher. */
  cipher?: "aes-256-gcm" | CacheCipher;
  /** User ciphers that still decrypt. */
  previous?: readonly CacheCipher[];
  /** Extra context bound into every entry's AAD (an environment, an app id). Default: none. */
  aad?: string | Uint8Array;
  /** Hash keys, namespaces and tags in the store: an HMAC key (never rotated), or a function. Default: off. */
  hashNames?: { key: string | Uint8Array } | { hash: (name: string, context: CacheNameContext) => string };
  /** Read entries written without encryption (migration). Default: false. */
  acceptUnencrypted?: boolean;
}
type CacheKeyRing = readonly CacheKey[];
interface CacheKey { id: string; key: string | Uint8Array }
interface CacheNameContext { kind: "namespace" | "key" | "tag"; namespace: string }

interface CompressOptions {                          // widened
  algorithm?: CompressionEncoding | CacheCompressor; // "br" | "zstd" | "gzip" | "deflate", from bun-common
  threshold?: number;
  level?: number;
  previous?: readonly CacheCompressor[];
}
```

### 10.3 No per-namespace overrides [D]

The user asked whether per-namespace or per-call overrides would help.

- **Per call:** only `compress: false` (§8.5). A per-call `encrypt: false`
  would make one leaked flag a plaintext entry.
- **Per namespace:** a `namespace(name, { encrypt })` view would put two
  storage formats under one cache's names, and an encrypting view would then
  have to accept plaintext. That is the injection hole of §9.7. Two
  `createCache` calls over **one driver** give the same result with no new
  option:

  ```ts
  const driver = redisDriver({ url });
  const secret = createCache({ driver, namespace: "secret", encrypt: { keys } });
  const pub = createCache({ driver, namespace: "public" });
  ```

  The driver is shared, and its `close()` runs once per cache. bun-cache's
  rule that a driver closes only what it created already covers this.

### 10.4 Validation errors [D]

Each is a `TypeError` at `createCache`, naming the option:

- a key that is not 32 bytes;
- a malformed, empty or duplicate key id;
- an empty ring;
- `keys` beside a user cipher;
- a cipher, compressor or `previous` id outside 128–255, or one that
  duplicates another;
- `hashNames` with no cipher;
- `hashNames.key` the same bytes as an encryption key. This is allowed,
  because HKDF separates them, but **warned**;
- `level` outside its algorithm's range;
- `aad` over 1 KiB.

---

## 11. Testing

Each guarantee has a test and a **negative control**: a mutation that must
fail it, recorded in the PR.

| Guarantee | Test | Negative control |
|---|---|---|
| Tamper is a miss | Flip a bit in each region: prefix, salt, nonce, body, tag | `setAuthTag` skipped, or AES-CTR: the test fails |
| Swap is a miss | Within a namespace, across namespaces, across caches with different `aad` | AAD omitted: the cross-namespace case serves the wrong value (as spike B0b) |
| Wrong or unknown key is a miss, **not deleted**, with an `error` (`"decrypt"`) | A ring without the writer's key; then the right ring reads the entry | Delete on failure: the second read misses |
| Rotation | Written under `a`, read with `[b, a]`; new writes under `b` | Encrypting with the last key: the "new writes" assertion fails |
| Key provider | Async ring; an unknown id triggers one refresh; a rejection keeps the old ring | No early refresh: the peer's new key is never learned |
| Sealed tags win | Strip the tags in the store, then `invalidateTags`: a miss (stamps and index drivers) | Using `raw.tags`: the entry survives (as spike C1) |
| Sealed expiry wins | Raise the clear `expiresAt` past the sealed one: a miss after the sealed one | Using `raw.expiresAt`: served |
| Nonces and salts do not repeat | 100,000 seals, all distinct | A fixed salt: the test fails |
| **No plaintext in any store** | The kit's new `rawDump` factory field yields every byte a driver stored (rows, keys, objects, files, the bus). Sentinel values, keys, namespaces and tags are written, then searched for in UTF-8 and UTF-16 | Encryption off: the values are found. `hashNames` off: the names are found |
| `acceptUnencrypted: false` | A plaintext entry injected into the store is a miss | Accepted: the test fails |
| User ciphers | `runCacheCipherConformance` on a sync and an async test cipher | An AAD-ignoring cipher fails the helper |
| Compression | Each algorithm round-trips at the four sizes. **Format-1 entries written by develop decode** (byte fixtures pinned in the test). Format 2 is written only for `br`, `deflate` or user ids. An unknown compressor id is a miss. An async user compressor works. `compress: false` per call stores the payload uncompressed | Format 2 always: the fixtures' rolling-deploy test fails. `previous` ignored: the old compressor's entries miss |
| Every driver | The conformance kit's full pass with `encrypt` and `hashNames` on, on all nine drivers, the two-process pass included | — |

**What `rawDump` covers, per driver:**

| Driver | What it reads |
|---|---|
| file | Walks the root |
| SQLite | The database file, its `-wal` and `-shm` |
| SQL | `SELECT *` from the run's tables, cast to bytes |
| Redis | `SCAN` the prefix, then `DUMP` each key, plus its name |
| MongoDB | Every document of the run's collections as BSON |
| S3 | Lists the prefix, then `GET`s each object, with names and `Content-Type` |
| memory | Its maps, through a test hook |

Each cloud driver PR (C8–C11) adds its own.

**The gate** is the bun-cache gate in `RULES.md` and CLAUDE.md, with every
`BUN_CACHE_TEST_*_URL` set. PR-E2 touches every driver's kit pass, so it
runs every URL.

---

## 12. PR slicing and effort

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-Z1** compression | Format-2 header (written only when needed) and the dual-format decoder. `"br"` and `"deflate"`, with per-algorithm default levels. `CacheCompressor` (sync or async) and `compress.previous`. Per-call `compress: false`. The async-transform plumbing in `#write`, `#decodeStored`, `touch` and the refresh rewrite. Fixture tests for format-1 entries; README | — | ~2 d |
| **PR-E1** encryption | The envelope and the built-in `"aes-256-gcm"` with per-entry keys. Keys, ids and rings; `keys` functions with `keyRefresh` and the unknown-id refresh. `aad`. Sealed tags and expiry, used by the core. `CacheDecryptError` and the `"encrypt"`/`"decrypt"` phases, with no deletion on failure. `acceptUnencrypted`. `CacheCipher` with `previous`. `runCacheCipherConformance`. The `keyId` on `hit` events. Tests in §11 except `rawDump`; README "Encryption at rest" with the rotation runbook and the KMS pattern | PR-Z1 (the async plumbing) | ~4 d |
| **PR-E2** names | `hashNames` (HMAC and user hash) in the core: names, tags, the bus, the stamp cache, logs. `describeKey`. The kit's `rawDump` field, implemented in the tests of all nine drivers. The kit's full pass with encryption and hashing on, every driver | PR-E1 | ~3.5 d |
| **PR-E3** docs and playground | README sections finished. A playground item showing a value as stored (sealed bytes, hashed names) beside the decoded one. The change report to the examples agent, who writes the examples | PR-E2 | ~1 d |
| | **Total** | | **~10.5 d** |

- **Order.** Z1 → E1 → E2 → E3. Z1 is core-only and could also land before
  or between the cloud drivers. Each cloud driver PR merged after E2 adds a
  `rawDump`; one merged before gets it in E2.
- **Reviews.** The bun-common agent reviews Z1, which imports
  `CompressionEncoding`.
- **Owners.** The bun-cache role owns all four PRs. No other package changes:
  bun-common is untouched unless §13 Q12 says otherwise.

---

## 13. Open questions for the user

Each question has a recommended answer.

1. **Where encryption lives.** In the core, as here, or as a driver wrapper
   (`encryptDriver(driver)`)? **Recommended: the core** (§4.1). A wrapper
   cannot hash names consistently with L1 and the bus, and a codec cannot
   bind ciphertext to its key (spike A).
2. **The built-in cipher.** **Recommended:** AES-256-GCM through
   `node:crypto`, with a key per entry derived from a 128-bit salt.
   - The alternative is plain random-nonce GCM, which saves 0.7 µs per seal
     but reaches NIST's limit in 5 days at 10,000 writes/s (§4.4).
   - ChaCha20-Poly1305 through `crypto.subtle` is async and slower here.
   - We offer no second built-in; a `CacheCipher` covers the rest.
3. **Sync or async user ciphers and compressors.** **Recommended: either**
   (`T | Promise<T>`, awaited only when a promise). The cost is 0.36 µs per
   op at 100 B, paid only by async ones. The built-ins stay sync (§6.2,
   §8.1).
4. **The names key.** **Recommended:** a separate key (`hashNames: { key }`),
   never rotated, since rotating it flushes the cache. The alternative,
   deriving it from the primary encryption key, would flush on every
   rotation.
5. **The option's name: `hashNames` or `hashKeys`.** **Recommended:
   `hashNames`.** It hashes namespaces and tags too, not only keys.
6. **Passphrases.** **Recommended: not in v1.** Keys are exactly 32 bytes,
   generated with `openssl rand -base64 32`. A passphrase helper (scrypt
   N = 2^15, 85 ms, with a required deployment salt) can come later if asked
   for.
7. **Re-encrypt on read during a rotation.** **Recommended: not in v1.** TTL
   turnover re-encrypts, and the runbook (§5.2) needs no writes on reads.
8. **Delete an entry that does not open?** **Recommended: no.** A miss and an
   `error` event only. Deleting would let one misconfigured process wipe its
   peers' entries during a key rollout (§4.6).
9. **`acceptUnencrypted` for migrating an existing cache.** **Recommended:
   yes, off by default,** documented as a migration-window setting that lets
   a store writer inject values.
10. **Counters.** **Recommended:** plain integers, with hashed names and
    documented; no option to refuse `increment` on an encrypted cache
    (§9.6).
11. **Overrides.** **Recommended:** none per namespace (two `createCache`
    calls over one driver, §10.3); per call, `compress: false` only.
12. **Compression names and sharing with bun-common.** **Recommended:**
    - spell the algorithms **`"br"`**, `"zstd"`, `"gzip"` and `"deflate"`,
      typed by importing bun-common's `CompressionEncoding`, not `"brotli"`;
    - share no runtime code;
    - mirror the Brotli quality 4 in a comment, rather than adding a
      `DEFAULT_BROTLI_QUALITY` export to bun-common.
13. **Compression defaults.** **Recommended:**
    - zstd stays the default;
    - the threshold stays 16 KiB for every algorithm (lowering it changes
      every existing deployment's CPU and size);
    - the default levels are zstd 3, gzip 6, `br` 4 and deflate 6;
    - `deflate` is raw DEFLATE.
14. **Size padding** (hiding exact entry sizes). **Recommended: no.** It
    costs space on every entry, and sizes stay visible within the padding
    anyway. Documented as not protected (§2.2).
15. **The `aad` option.** **Recommended: include it.** It is cheap, and
    stops a staging cache from opening production entries that share a key.
16. **An error class for failed opens.** **Recommended:
    `CacheDecryptError`,** with `reason` (`"auth"`, `"unknown-key"`,
    `"unencrypted"`, `"malformed"`, `"cipher"`) and `keyId`. Rotation
    mistakes can then be monitored without parsing messages.
17. **When to build it.** **Recommended:** PR-Z1 next, since it is core-only
    and small. Then E1 to E3, before or after the cloud drivers C8–C11, as
    the user prefers. A cloud driver landing after E2 brings its own
    `rawDump`.
18. **A decompression cap** (found while planning, §8.4). Today any entry's
    decompressed size is unbounded, so a store writer can plant a
    decompression bomb in a plain cache. **Recommended: a follow-up**, not
    part of this plan. Cap the output at a multiple of `maxEntryBytes`
    (zstd's frame header states its size; gzip and Brotli need a streaming
    limit), as its own small PR with its own name.

---

## 14. Names needing approval

Every new public or persisted name. Nothing here is in the main plan's §21.

| Name | Kind | Where | Why this name |
|---|---|---|---|
| `encrypt` | option | `CreateCacheOptions` | The verb, beside `compress` |
| `CacheEncryptOptions` | type | root | After `CompressOptions` |
| `keys`, `keyRefresh`, `cipher`, `previous`, `aad`, `hashNames`, `acceptUnencrypted` | options | `CacheEncryptOptions` | `aad` is the AEAD term; `previous` is also used by `compress` |
| `CacheKey` (`id`, `key`), `CacheKeyRing` | types | root | A ring is the usual term for a set of rotating keys |
| `"aes-256-gcm"` | cipher name | `cipher` | `node:crypto`'s spelling |
| `CacheCipher` (`id`, `seal`, `open`), `CacheCipherContext` (`namespace`, `key`, `aad`) | types | root | Seal and open are the AEAD verbs; not `encrypt`/`decrypt`, which the option already uses |
| `CacheNameContext` (`kind`, `namespace`) | type | root | The argument of `hashNames.hash` |
| `describeKey(key, tags?)` → `{ namespace, key, tags }` | method | `Cache` | It says what it answers |
| `CacheDecryptError` (`reason`, `keyId`) | error class | root | After `CacheDriverError` |
| `"encrypt"`, `"decrypt"` | values | `CacheErrorPhase` | Beside `"decode"` and `"validate"` |
| `keyId` | event field | `hit`, `stale-hit` | Optional; only on encrypted entries |
| `"br"`, `"deflate"` | values | `CompressOptions.algorithm` | bun-common's `CompressionEncoding` spellings |
| `CacheCompressor` (`id`, `compress`, `decompress`) | type | root | After `Codec` |
| `previous` | option | `CompressOptions` | Matches `encrypt.previous` |
| `compress: false` | per-call option | `set`, `setMany`, `getOrSet`, `wrap` | The cache option's name |
| `runCacheCipherConformance` | function | `./testing` | After `runCacheDriverConformance` |
| `rawDump` | factory field | the conformance kit's factory result | It yields what the driver stored, raw |
| `"BE"` envelope v1; entry format 2 with a compressor-id byte; cipher ids 1 and 128–255; compressor ids 0–4 and 128–255 | persisted formats | stored bytes | Specified in the README for other readers |
| `bun-cache/enc/1`, `bun-cache/enc/1/aes-256-gcm`, `bun-cache/names/1`, `"entry"`, `"ns"`, `"key"`, `"tag"` | persisted labels | HKDF `info`, AAD and HMAC inputs | Changing one changes every stored entry or name |

---

## 15. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **A misconfigured key turns a cache into all misses** (a typo, a missing env var in one service) | Medium | `error` events and a rate-limited `warn` with the key id. A key that is not 32 bytes fails at `createCache`, not at first read. The README's rotation runbook |
| **A user cipher that ignores the AAD, or reuses nonces** | Medium | `runCacheCipherConformance`, linked from the `CacheCipher` JSDoc and the README |
| **The names key is lost or changed**, which is a full cache flush | Low | It is documented as like a `version` bump, and it is a separate option, so a rotation of the encryption keys cannot change it by accident |
| **Bun's `node:crypto` changes** (ChaCha20 arrives in #8072; a regression) | Low | The built-in uses only `createCipheriv("aes-256-gcm")`, HMAC and HKDF, all in Node's test suite that Bun runs. The bench scripts re-run on an upgrade |
| **Compression oracle** on mixed secret and attacker data | Low, but real | Documented. `compress: false` per call, or a separate cache (§2.2) |
| **The format-2 header during a rolling deploy** | Certain, once | Written only when `br`, `deflate` or a user compressor is chosen, so only the deploy that turns one on sees misses |
| **Debugging is harder under `hashNames`** | Certain | `describeKey`. Logs use the stored names; events keep the plaintext |
| **Small-value overhead** (+1–2 µs CPU per op; +56 B per entry) | Certain | Measured and documented. The overhead is under the cost of a networked round trip by two orders of magnitude |

---

## 16. Evidence

[`evidence/encryption/`](evidence/encryption/README.md) indexes each script,
its command and its captured output. The prior art behind §4.2 (XAES-256-GCM,
NIST SP 800-38D) is cited, not copied.
