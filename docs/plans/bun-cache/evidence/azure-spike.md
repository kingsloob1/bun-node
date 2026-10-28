# Spike: Azure Blob Storage on Azurite

The plan's question (Status, 2026-10-27): **does Azurite cover the Lease Blob
and conditional-write paths** an `azureBlobDriver` would rely on? Run
2026-10-28 on this machine (Bun 1.4.4-canary.1+a0cc096ce) against
**Azurite 3.37.0** (`mcr.microsoft.com/azure-storage/azurite:3.37.0`, the
newest tag on MCR that day, blob service only), provisioned by
`bun scripts/setup-databases.ts --only=azure`. No Azure account was
available: **nothing here was run against real Azure**, and every claim about
Azure itself is from Microsoft's documentation, marked [W].

**Answer: yes, both.** Azurite checks Shared Key signatures, honours
`If-Match`/`If-None-Match` on Put Blob and Delete Blob with the status codes
Azure documents, picks exactly one winner among 50 concurrent conditional
writers, and implements Lease Blob's five actions (acquire, renew, release,
break, change) with their conflicts, the 15–60 s duration range and server-side
expiry. The driver uses **conditional writes** for counters and locks, not
leases (below, "Leases: measured, not used").

## What was measured

`azure-spike/wire.ts` (output: [`results-azure-wire.txt`](results-azure-wire.txt)),
signing every request with the driver's own Shared Key signer
(`packages/bun-cache/lib/drivers/azure-sign.ts`): `fetch` only, no Azure SDK.
It writes under `bun-cache-probe/<pid>-<time>/` and deletes exactly the blobs
it listed there (18 deleted; the container measured empty afterwards).

```bash
bun scripts/setup-databases.ts --only=azure     # Azurite on 127.0.0.1:10000
BUN_CACHE_TEST_AZURE_URL=$(bun scripts/setup-databases.ts --only=azure --print-env | sed -n 's/^export BUN_CACHE_TEST_AZURE_URL=//p') \
  bun docs/plans/bun-cache/evidence/azure-spike/wire.ts
```

### Signing (Shared Key)

| Request | Azurite |
|---|---|
| Signed with the development key | 201 / 200 |
| Signed with a wrong key | **403** `AuthorizationFailure` ("Server failed to authenticate the request…") |
| Unsigned, private container | 403 |
| Signed 20 minutes in the past | **200** — Azure refuses a request older than 15 minutes [W: "Authorize with Shared Key"]; Azurite does not check |
| `x-ms-version: 2099-01-01` | 400 `InvalidHeaderValue` (unsupported version; `--skipApiVersionCheck` would allow it) |
| `x-ms-version` 2021-12-02, 2025-01-05, 2025-11-05, 2026-02-06 | 200 each |
| A blob named `name with spaces/^a~b!'()*%/é`, path segments percent-encoded | 201, read back |
| `Range: bytes=1-2` (a standard header, so in the string to sign) and `x-ms-range` | 206 each |

So the string to sign (verb, eleven standard headers, canonicalized `x-ms-*`
headers, `/<account><path>` plus the sorted query) is right in the parts these
requests exercise, including the path-style form where the account appears
twice (`/devstoreaccount1/devstoreaccount1/<container>/…`), which the docs say
the emulator needs. The driver pins `x-ms-version: 2025-01-05`.

### Put, Get, Head

- **Put Blob** answers 201 with the blob's `ETag` (quoted, `"0x1C71B84B70DCF80"`)
  and `Last-Modified`. **`Content-Type` keeps its parameters**:
  `application/x-bun-cache; exp=1760000000000; at=1759999999000` comes back
  verbatim on `GET`, `HEAD` and in a listing — so the S3 driver's type scheme
  works unchanged. `x-ms-meta-exp` metadata round-trips too, but a metadata
  name must be a C# identifier (`x-ms-meta-bad-name` → 400 `InvalidMetadata`).
- **Get Blob** on a missing blob: 404 `BlobNotFound`.
- **`Last-Modified` has whole seconds** (two writes 300 ms apart answer the same
  value), so write order comes from the type's `at=` parameter, as on S3.
- ETags are not ordered (`0x275337AB8F24320` then `0x22E6C098F7433C0`): an
  identity, never a version number.
- A 64 MiB single Put Blob: 201 in 320 ms, read back whole. Azure's documented
  limit for one Put Blob is 5000 MiB [W: "Put Blob", version 2019-12-12 and
  later]; Azurite's was not probed past 64 MiB.
- Sequential latency on loopback: GET 0.9 ms, PUT 1.5 ms.

### Conditional writes

| Request | Azurite | Azure [W: "Specify conditional headers for Blob service operations"] |
|---|---|---|
| Put `If-None-Match: *`, absent | 201 | 201 |
| Put `If-None-Match: *`, present | **409 `BlobAlreadyExists`** (not 412; the body is unchanged) | 409 `BlobAlreadyExists` |
| Put `If-Match: <current>` | 201 | 201 |
| Put `If-Match: <stale>` | 412 `ConditionNotMet` | 412 |
| Put `If-Match: <etag>` on a missing blob | 412 `ConditionNotMet` | 412 |
| Delete `If-Match: <stale>` | 412 `ConditionNotMet` | 412 |
| Delete `If-Match: <current>` | 202 | 202 |
| Delete, missing | **404 `BlobNotFound`** | 404 |
| Delete `If-Match`, missing | 412 `ConditionNotMet` | 412 |
| `If-Match` with a listing's ETag, unquoted (`0x…`) or quoted | 202 either way | — |

- **Delete answers whether the blob was there** (202 against 404), so the
  driver's `delete` is one request per key — S3 needs a `HEAD` first.
- **Concurrency.** 5 and 50 concurrent `If-None-Match: *` creates of one blob:
  exactly 1 × 201, the rest 409, in 11 ms and 101 ms; 5 and 50 concurrent
  `If-Match` swaps on one ETag: exactly 1 × 201, the rest 412, in 9 ms and
  70 ms. **No serialisation**, unlike SeaweedFS 4.48's second per loser
  (PR-C7), so the S3 driver's per-key lock queue is kept for the billed failed
  requests it saves, not for speed.
- 200 compare-and-swap increments from 20 unbatched workers: exactly 200, after
  ~2,430 lost races, in 4.2–5.2 s. Hence the driver batches one key's
  increments in a process, as the S3 driver does.

### Leases: measured, not used

| Request | Azurite |
|---|---|
| Acquire on a missing blob | 404 `BlobNotFound` |
| Acquire with duration 5, 14 or 61 s | 400 `InvalidHeaderValue` (15–60 s, or -1 for infinite) |
| Acquire 15 s with a proposed id A | 201, `x-ms-lease-id: A` |
| Acquire as B while A holds | 409 `LeaseAlreadyPresent` |
| Acquire again as A | 201 (re-acquire; a new duration is allowed) |
| Renew as A / as B | 200 / 409 `LeaseIdMismatchWithLeaseOperation` |
| Put or Delete without the lease id | 412 `LeaseIdMissing` |
| Put with A's id / B's id | 201 / 412 `LeaseIdMismatchWithBlobOperation` |
| Get while leased | 200 (reads need no id) |
| Release as B / as A / as A again | 409 / 200 / 409 |
| Break, period 0 | 202, `x-ms-lease-time: 0`; B then acquires (201) |
| Break, period 2 s | 202; A refused during it (409), acquires after it (201) |
| Change A → B, then release as B | 200, 200 |
| 50 concurrent acquires with distinct ids | exactly 1 × 201, 49 × 409, in 41 ms |
| A 15 s lease left to lapse | another id acquired it after 15.14–15.16 s |
| A proposed id that is not a GUID (`owner-1`) | **201** — Azure requires a GUID [W: "Lease Blob"]; Azurite does not check |
| `If-None-Match: *` on a leased blob / `If-Match` without the id | 409 `BlobAlreadyExists` / 412 `LeaseIdMissing` |
| ETag before and after taking a lease | unchanged |

**Why the driver does not lock with leases.** A lease is Azure's native lock
and is judged by the server's clock, not the clients' — its one real advantage.
But its duration is **15–60 s or infinite**, and the cache's lock TTL is
anything from 1 s (`getOrSet`'s floor) to the loader's hard timeout or
`lockTtl` (30 s by default) and beyond: a 1 s lock would be held for 15 s by a
holder that died, and one over 60 s cannot be expressed without a renewer (an
infinite lease outlives a crashed holder for ever). The kit's lapsed-lock cases
use TTLs of tens of milliseconds. Conditional writes give any TTL with the
same atomicity (one winner of 50, measured above), are the mechanism the S3
driver already proves, and keep counters and locks on one code path. A lease
would also need the owner mapped to a GUID (real Azure refuses others), and a
lock blob created before it can be leased (404 otherwise). The cost of the
choice: a lock's lapse is judged by each process's clock against the
`expiresAt` its holder wrote, as on S3 and the file driver.

### List Blobs

- `?restype=container&comp=list&prefix=…&maxresults=2`: 5 blobs came in 3
  pages through `NextMarker`, in name order. `maxresults=6000` answered 200
  (Azure returns at most 5000 a page [W: "List Blobs"]).
- **Each item carries `Last-Modified`, `Etag` (unquoted), `Content-Length` and
  `Content-Type` with its parameters** (and `Metadata` with
  `include=metadata`). So the sweeper learns every object's kind, expiry and
  write time from the listing alone, with **no `HEAD` per object** — the S3
  driver's `HEAD`s and its memo are not needed here.
- Names are XML-escaped (`a&amp;b&lt;c&gt;'"`), so the listing parser decodes
  the five entities.

### Blob Batch

`POST ?restype=container&comp=batch` with an empty body answered 202 on
Azurite. A batch delete (up to 256 subrequests [W: "Blob Batch"]) would cut
`clear` and the sweeper's deletes to one request per 256 blobs, but it is a
`multipart/mixed` body of separately signed subrequests; not built, not
measured beyond that, and left as a follow-up.

## What Azurite does not emulate faithfully (found here)

1. **No clock-skew check**: a request signed 20 minutes ago succeeds; Azure
   refuses one older than 15 minutes (403).
2. **Non-GUID lease ids are accepted**; Azure answers 400. (The driver uses no
   leases.)
3. **API versions**: Azurite refuses a version newer than it knows (400) unless
   started with `--skipApiVersionCheck`; Azure supports its own list. The
   driver pins `2025-01-05`, which Azurite 3.37.0 accepts.
4. Beyond what was measured, from Azurite's README [W]: no geo-replication or
   tiers in effect, no soft delete or versioning, and its own size and
   throughput limits rather than Azure's scalability targets. Account-level
   features the README of the driver warns about — **soft delete and blob
   versioning** keep deleted cache entries billable on a real account — are
   untested here.

## Real Azure: untested

No account was available. The status codes in the conditional-writes table
match Microsoft's documentation for every row; the signing follows the
documented string to sign and is checked against Azurite's verifier and the
documentation's own example strings (the driver's tests). Latency, request
pricing, throttling (503 `ServerBusy`) and the 15-minute skew are Azure's and
were not measured.
