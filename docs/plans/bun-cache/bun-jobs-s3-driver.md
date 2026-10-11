# bun-jobs on S3: a driver, a blob store, or an archive?

A plan for adding Bun's S3 support (`Bun.s3`, `S3Client`) to
`@kingsleyweb/bun-jobs`. The user asked for it in these words: *"the plan
should see how it can add an additional driver to bun-jobs which is the bun
file s3 file storage."*

The plan weighs six options against the guarantees bun-jobs gives today:

- **(a)** a full queue driver built on S3 conditional writes;
- **(b0)** no S3 at all: a `maxDataBytes` size limit on job data, added after
  the bun-jobs agent's review;
- **(b)** S3 as a blob store for large job data;
- **(c)** S3 as an archive for finished jobs and event logs;
- **(d)** a hybrid, with a lock or compare-and-set service elsewhere and the
  storage on S3;
- **(e)** not doing it.

It builds on §16 of [`bun-cache/README.md`](README.md). That analysis found that
every queue guarantee bun-jobs gives rests on **one atomic conditional write on
one backend**. The question here is whether S3 can be that backend.

Written 2026-10-10 against `develop` at `bbe11201`, and revised seven times the same
day after the bun-jobs agent's reviews. **Every `file:line` is pinned to
`develop` at `fddee0af`**, the base this PR is cut from. It includes #314
(summon groups), #339, #344 and #347. Of the files cited here, only
`queue/BunQueueWorker.ts` and `summon/controller.ts` moved between `8279bdf`
and `7e1841fe`. Between `7e1841fe` and `fddee0af` only
`sql/sql-driver.ts`, `examples/bun-jobs-ui/04-screens/permissions.ts` and
the bun-jobs-ui README moved. Every citation into them is re-pinned. The
changelogs' "pinned to `7e1841fe`" headings record the base each round was
checked against. The changelogs are at the end of
§1. **No product code was changed.** Every `file:line` is
relative to `packages/bun-jobs/` unless it says otherwise. The evidence is in
[`evidence/bun-jobs-s3-driver/`](evidence/bun-jobs-s3-driver/README.md).

### Contents

1. [Executive summary](#1-executive-summary)
2. [What the driver contract needs from storage](#2-what-the-driver-contract-needs-from-storage)
3. [What S3 offers](#3-what-s3-offers)
4. [The candidate designs](#4-the-candidate-designs)
5. [Latency, throughput and cost per design](#5-latency-throughput-and-cost-per-design)
6. [The conformance kit: what each design passes](#6-the-conformance-kit-what-each-design-passes)
7. [Testing infrastructure](#7-testing-infrastructure)
8. [Measured evidence](#8-measured-evidence)
9. [Risks](#9-risks)
10. [Open questions for the user](#10-open-questions-for-the-user)
11. [PR slicing and effort](#11-pr-slicing-and-effort)
12. [Names needing approval](#12-names-needing-approval)

### How to read the markings

These are the same marks as the other plans:

| Mark | Meaning |
|---|---|
| **[S]** | Read in this repo's source at `fddee0af`, with the `file:line` given |
| **[M]** | Measured here by a spike that can be re-run; the evidence file is named |
| **[W]** | Read on the web from a primary source (docs, source or announcement) at the date given, with a link |
| **[I]** | Inference: a claim to test, never a finding |
| **[U]** | Unverified: nothing may rest on it |
| **[D]** | A design decision this plan proposes |

---

## 1. Executive summary

### 1.1 The one-paragraph answer

**S3 can now do the one thing a queue needs, but only just, and only on some
stores.**

- **The primitive exists.** `If-None-Match: *` (create-once) and
  `If-Match: <etag>` (compare-and-swap) on `PUT` give the atomic conditional
  write that claim-once, fencing and versioned queue state rest on.
- **Measured here.** On four S3-compatible servers, 32-way races had exactly
  one winner, and a prototype claimed 300 of 300 jobs exactly once at 16
  workers [M].
- **But Bun's `S3Client` cannot send those headers.** A driver needs its own
  SigV4 signing; oven-sh/bun#17339 is open, and now carries this use case [M,
  W].
- **Hot objects serialise.** One object under compare-and-swap commits 4 to
  269 times a second on loopback, roughly 5 to 10 on S3 Standard [I], and
  once a second on R2 and GCS by documented limit [W].
- **There is no notification**, so every wait is a billed poll.
- **Many "S3-compatible" stores reject, ignore or lose conditional writes**
  (B2, MinIO under quorum loss, Tigris global buckets) [W].

**What a full driver (a) would cost:**

| Measure | Figure |
|---|---|
| Ready-to-start latency, S3 Standard | about 370 ms p50 analytically (330 ms from the measured notice; §5.1) |
| Cost per million jobs | about $48 |
| Idle cost per worker | about $42 a month, plus $52 per polled subscription |
| Claim ceiling with limits set | about 5/s |
| Effort | 25 days or more |

**Two reviews sharpened the safer options.**

- **(b0) `maxDataBytes`.** It closes the actual hole, job data with no size
  limit, in 1.5 to 2 days, with no storage and no driver change.
- **(b) a blob store**, for job **data only**, is real work:
  - every record-building site;
  - repeats kept inline;
  - a `JobPatch.blob` flag in all six drivers;
  - a read model that never hands out a pointer;
  - dead-letter copies;
  - deletes deferred to a grace sweep.

  16 to 19.5 days.
- **(c) an archive of jobs only.** It needs a retention hold, driven by a
  persisted entry, in all six drivers. Event export is descoped. 9 to 11
  days.

None of the three touches a queue guarantee (claims, leases, settles).

### 1.2 The decisions

| # | Decision | Why |
|---|---|---|
| D0 | **First, `maxDataBytes` (PR-S1a): refuse job data over a configured size, measured in UTF-8 bytes with no extra stringify.** It is queue-level, and dead letters are exempt. Recommended, **pending the user's approval** (public API). | The cheapest fix for unbounded inline data (`lib/drivers/driver.ts:1161`): no storage, every driver, mirrors the runner's `maxResultBytes`. §4.2 |
| D1 | **Then (b), the blob store, for job data only, and never for repeats.** `JobPatch.blob` carries the flag atomically with `data`. The driver stamps `opts.blobAt` with every flag write, and every delete waits for a grace sweep timed from it. `job.data` throws until loaded. | Offloads what (b0) would refuse. Results are out (`job.returnValue` is synchronous, and lives in events and `flow.values` too). Repeats are out because an occurrence copies the previous one's data down the series. §4.3 |
| D2 | **(c), the archive, for jobs only, as a separate later decision.** `archiveHold?` in the drivers reads the persisted `__win:archive` entry, with keyset reads and a lag-windowed mark. | Retention runs inside the drivers and in processes that never configured the archive, so the hold must live there. Event export is descoped: its retention is per namespace, `cleanEvents` is internal, and the contract says events are not an audit trail. §4.4 |
| D3 | **Do not build (a), the full S3 driver, now.** Revisit only for a workload with no database at all, on an allow-list of AWS S3 and S3 Express, after a one-day verification against real AWS. | Latency, idle cost, hot-object ceilings, and the stores that silently break claim-once. §5, §9 |
| D4 | **(d), a hybrid with compare-and-set elsewhere, collapses into (b).** | Once claims and leases live in a database, so does the record. §4.5 |
| D5 | **If (a) is ever built:** SigV4-signed conditional headers; a nonce in every compare-and-swapped body; **conditional `DELETE`** on allow-listed stores (no tombstones); claim keys of incarnation plus claim counter; `excludeNames` from name-carrying index keys; a pause read per claim; settle re-checks the lock token on 412; a connect-time probe. | The review's findings 4 to 8, and the ETag ABA [M]. §2.2, §2.3, §4.1 |
| D6 | **The S3 test server is SeaweedFS 4.48, pinned, not MinIO**, for bun-jobs and bun-cache alike, as a `dockerOnly` entry in `setup-databases.ts`. **Proposed owner: the bun-jobs agent.** | MinIO's images could not be pulled and its repository is archived; SeaweedFS honoured every conditional header [M, W]. §7 |

### 1.3 What it costs

| Part | Effort | Depends on |
|---|---|---|
| PR-S1a `maxDataBytes` (b0), *pending approval* | ~1.5–2 d | — |
| PR-S0 S3 test server, *proposed owner: the bun-jobs agent*; shared with bun-cache PR-C7 | ~1–1.5 d | — |
| PR-S1 blob store (b), data only | ~16–19.5 d | PR-S0; best after PR-S1a |
| PR-S2 archive (c), jobs only | ~9–11 d | PR-S0, PR-S1 |
| **All four** | **~27.5–34 d** | |
| UI, examples, playground | *~7–8 d (their owners)* | each |
| *(a): verification spike, then the driver* | *~1 d, then ~25 d or more; not scheduled* | a workload |

### 1.4 The bun-jobs agent's review points, and where each is answered

**First round (before the draft):**

| Point | Answer | Where |
|---|---|---|
| 1. Every operation needing compare-and-set, with `file:line`, and what `If-Match` / `If-None-Match` gives each | A table of 22 rows, plus the ETag ABA trap; conditional `DELETE` on an allow-list | §2.2 |
| 2. Does Bun's `S3Client` expose the headers and an ETag on every path? | **No headers on any path.** ETag on `stat()` and `list()` only. Conditional `PUT`s, and `GET`s that need their ETag, require hand-made SigV4 `fetch()` (confirmed by the owner against bun-types 1.4.2) | §3.1 [M] |
| 3. Polling and wakeup latency with no notify; poll interval against cost | p50 notice 25 / 66 / 86 / 495 ms at 25 / 100 / 250 / 1000 ms polls (corrected run); an idle floor of about $42 a month per worker on S3 Standard, plus $52 per polled subscription; about 370 ms p50 from ready to start analytically (330 ms from the measured notice) | §5.1, §5.2 [M] |
| 4. Non-AWS stores: conditional writes and read-after-write, each marked | 12 stores, each marked measured, documented or unverified | §3.2, §3.3 |
| 5. Cost per million jobs, per design | (a) $48.30 / (b0) $0 / (b) $5.40 / (c) $0.005 on S3 Standard | §5.4 [M] |

**Second to eighth rounds (the reviews of the draft):** the changelogs below.

### 1.5 Changelog of the second round (2026-10-10)

| # | Review finding | What moved |
|---|---|---|
| 1 | (b) touches more than claimed | (b) is **data only**. Result offload is withdrawn (`job.returnValue` is synchronous, `Job.ts:161`; results also live in the `completed` event and `flow.values`). Every write path and read path is listed. The flag moves into `opts` (no schema change). Effort 5 → 8–10 d. §4.3 |
| 2 | Blob deletion and orphan races | No eager deletes. Random per-write keys. One `lastModified` grace sweep, modelled on the SQL orphaned-log sweep. Dead-letter copies re-offload. §4.3 |
| 3 | (c) under-specified; needs driver changes | `archiveHold?` in six drivers and `readEvents?` in three. Keyset reads, a lag window, the dead-job policy; `removeOnComplete: true` is never archived. New contract cases. Effort 4 → 8–10 d. §4.4, §6.2 |
| 4 | (a) misses `excludeNames` and pause | The encoded name is in the index key, with a `StartAfter` cursor; a pause read per claim, added to latency and cost. §2.2, §4.1, §5 |
| 5 | (a) claim keys collide | `claims/<id>/<incarnation>-<n>`, with claim objects garbage-collected. §4.1 |
| 6 | (a) tombstones contradict the rest | Dropped. Conditional `DELETE` on the allow-list instead. §2.2, D5 |
| 7 | (a) settle on a 412 | Re-`GET` and check `lockToken`; `updateProgress` is listed as an unfenced writer. §2.2, §4.1 |
| 8 | (a) index under-specified | The failed, children and expires indexes; marker moves on priority change; `wake` on every ready path; `countDemand` order; a dense event sequence or a skew-covering lag window. §2.3 |
| 9 | §6 misstated the contract helper | Corrected: analytics, attribution and `cleanEvents` already gate; run logs are required on purpose; the wait cases pass at 250 ms. Per-group gating is only needed by (a). §6 |
| 10 | Evidence | `pickup-poll.ts` fixed and re-run (it overstated `HEAD`/s 1.5 to 2×); the idle model gains lease renewals and add-ons ($42 floor); the claim prototype's path is stated; the server start lines are written out; `seaweed-startup.ts` added (3.8 to 6.0 s, replacing "about a second"); the `bun-cache` link is noted as same-PR. §5.2, §8, evidence README |
| 11 | #17339 stale | The comment is posted; §3.1 and §10 Q6 updated |
| 12 | §7 | SeaweedFS pinned to 4.48, as a `dockerOnly` plan entry; the `\| cat` advice corrected here and in `bun-cache/README.md` §13.2; one proposed owner for PR-S0 |
| New | A cheaper first step | **PR-S1a `maxDataBytes`**, pending the user's approval. §4.2, §10 Q1 |

### 1.6 Changelog of the third round (2026-10-10, against `develop` 8279bdf)

| # | Review finding | What moved |
|---|---|---|
| N1 | `opts.blob` cannot change on an update (`JobPatch` has only `data`, `priority`, `runAt`, `onlyIn`) | **`JobPatch.blob`**, written atomically with `data` in all six drivers, with contract cases (the flag with `data`, with a priority patch, with `rewritePendingOptions`). Priced per driver: memory and file trivial; SQL through `dialect.jsonSetValues`; MongoDB through the priority CAS loop; Redis through a new overlay field and reader rule. About 2.5 d. "No driver change" is dropped. The "fixed at create" rule was rejected because a reused id could pair data with the wrong flag. §4.3 |
| N2 | Repeats and flows missing from the write paths | Every record-building site is listed. **Repeats stay inline**: definitions, occurrences, and any `updateData` / `update` / `BunQueue.update` on a record with a `repeatKey`, because the worker's next occurrence copies `...record` from the previous one (`BunQueueWorker.ts:4191`). The check site is one helper, `planData` (`queue/blobData.ts`), called from `#buildRecord`, `Job.#update`, `BunQueue.update` (which reads first, only when over the threshold) and the debounce patch. Flows offload per node (they cannot use repeat or debounce, `BunQueue.ts:1532`). §4.3 |
| N3 | The grace counted from the wrong time | The pointer carries `at`. A superseded key goes when the **current** pointer's `at` passes the grace; an orphan when its own `lastModified` does. A 404 re-reads the record once and follows a new pointer. "An offloaded job stays offloaded", so a current pointer always has an `at`. §4.3 |
| N4 | The lifecycle backstop deletes referenced data; some queues are never swept | Backstop dropped (README: do not set one, or set it longer than any job lives). `queue.sweepBlobs()` for DLQs and producer-only queues, since the minute lease runs only in workers (`BunQueueWorker.ts:5254`). §4.3 |
| N5 | Dead letters | Corrected: "shortened, never refused" is about the letter's **id** (`deadLetter.ts:63-66`), not its data, and the plan no longer claims data is shortened. Letters are exempt from (b0) (the DLQ gets no `maxDataBytes`; pinned by a test). The DLQ gets `blobs`. An offloaded job's letter carries a copied `dataRef`; one that died of a missing blob, `dataRef.missing`. `maxDataBytes` is queue-level only. §4.2, §4.3 |
| N6 | Missing or corrupt blobs | `UnrecoverableJobError` after the re-read; transport errors are retried. `BlobMissingError` is withdrawn. §4.3 |
| N7 | `loadData()` and `dataOffloaded` | `job.data` stays `TData` and throws `BlobNotLoadedError` until loaded. The store travels in `hooks` through all eight construction sites. `getJob` resolves; lists do not. `updateData(big)` returns real data. `opts.blob` is stripped from the API's opts. §4.3 |
| N8 | Executors and remote | Thread, child and container: the host resolves (no size cap on those paths; the child has no driver access). Remote: the executor's cap is `maxBodyBytes` (1 MiB, 413 `TOO_LARGE`), not `maxMessageBytes`. There is no remote dispatcher in bun-jobs, so the presigned-URL `dataRef` is recorded as a contract for whoever builds one; PR-S1 changes nothing under `lib/remote`. §4.3 |
| N9 | Per-process configuration | The persisted `__win:blobs` marker makes a worker without the store refuse to start. The archive hold is read by the drivers from the persisted `__win:archive` entry (an entry without a mark holds everything), whatever a process configured. §4.3, §4.4 |
| N10 | Events per namespace against a per-queue mark | Event export is **descoped** from (c): retention is one setting per driver tracked per namespace; `cleanEvents` is internal; a `seq` cursor needs a lag window; events are not an audit trail. §4.4 |
| N11 | UI and API | `GET /jobs/:id/data` with a new opt-in action, `jobs.readData`; a `PATCH` writing the pointer back is refused; `UpdateJobDialog` fetches or opens read-only; the parsed README rows change, so UI-S1 goes to the examples agent first. UI-S1 1 → 2–3 d. §4.3 |
| N12 | Stale against `develop` | Every citation re-verified against 8279bdf: 52 wrong and 14 imprecise ones fixed (BunQueueWorker +43, driverContract +52, `setup-databases.ts`, `meta.ts:144`, summon controller lines, the contract table's ranges, `keys.ts:41`). Recounts: 209 cases (the missing "worker control entries" row added), `getQueueState!` 13, `updateJob!` 9. #319 and #314 statements updated. |
| N13 | (b0)'s check is not free | `assertJsonSafe` is `jsonClone` and discards its string. A sized variant stringifies once, measures with one `Buffer.byteLength` (UTF-8, not `.length`), and parses that same string: no extra stringify. §4.2 |
| N14 | Evidence | `cost-model.ts` no longer prints the withdrawn result row (re-run); `pickup-poll.ts`'s comment says 1.5–2× with figures; MinIO's `mc mb` written out; the latency headline gives both 370 ms (analytic, P/2) and 330 ms (measured). |
| N15 | (a)'s wake list | It adds `updateJob` moving `runAt` earlier, `resumeQueue`, and a parent made ready by `recordChild` or `requeueParent`. §2.3 |
| Effort | — | (b0) 1.5–2 d and PR-S0 1–1.5 d, adopted. (b) 13–16 d, above the owner's 11–14 by `JobPatch.blob`'s per-driver cost. (c) 9–11 d, below the owner's 10–12 because event export is descoped. Total 24.5–30.5 d (owner 24–30). §11 |

### 1.7 Changelog of the fourth round (2026-10-10, against `develop` 8279bdf)

| # | Review finding | What moved |
|---|---|---|
| R1 | "Offloaded stays offloaded" was not enforced | With `blobs` configured, **every data patch reads the record first**: `BunQueue.update`, the debounce patch, and `Job.#update` (its `#record` may be stale). "Stays offloaded" is now a preference. **The driver stamps `opts.blobAt = now`** with every `JobPatch.blob`, `true` or `false`. The sweep times any superseded key from `blobAt`, whatever the data is now. New sweep rows for a letter's `data.dataRef.key` and for a job with no `blobAt`. The `PATCH` guard compares with the record its own read returned. §6.2 tests match. §4.3 |
| R2 | `__win:blobs` read only at start | It is re-read on the `__win:jdef` cadence, through a cache like `JobDefaultsCache` (`BunQueueWorker.ts:1234`, 1 s, `jobDefaults.ts:67`). A worker that claims an offloaded job without the store fails it retryably, without running the handler, and stops with a `ConfigError`. A store move goes through `blobs.previous` and `queue.resetBlobMarker()`. §4.3 |
| R3 | `sweepBlobs` had no cursor | The cursor is persisted in `__win:blobs` and wraps at the end; workers' sweeps and `sweepBlobs()` share it. §4.3 |
| R4 | How workers get the store | `BunQueueWorkerOptions.blobs`, passed by `BunJobs` (`BunJobs.ts:774`). `fileBuriedLetter` (from `Job.ts:424`) takes the store from the `Job`'s hooks. Listed in §12 |
| R5 | A letter copy hitting a transport error | Bounded retry (3), then `copyFailed` with the source pointer, completed by the DLQ's sweep while the source exists. `missing` only after a 404, never for a 5xx. The README says re-driving a letter reads `dataRef`, since its `data` is `null`. §4.3 |
| R6 | MongoDB's CAS loop | Overlay fields `optsBlob` and `optsBlobAt` beside `opts`, as on Redis. A data patch stays one `findOneAndUpdate`, does not race `rewritePendingOptions`, and never throws after `PATCH_RETRIES`. §4.3 |
| R7 | A large repeat | Stays inline unless `maxDataBytes` is set, with one `warn` per repeat key. §4.3 |
| R8 | `getJob` with `resolveData` | Never throws over a blob: it returns the job unresolved, with `BlobNotLoadedError.reason` set to `missing`, `corrupt`, `unavailable` or `no-store`. Internal reads go through `driver.getJob` and pay no `GET`; the API's `queue.getJob` calls pass `resolveData: false`. §4.3 |
| R9 | The route's path; `readOnly` | `GET /queues/:queue/jobs/:id/data` (`jobs.ts:456`). `jobs.readData` is a read, so `readOnly` keeps it when named (`constants.ts:77-89`, `:150-156`). `permissions.ts:143`'s "Nine actions" becomes ten (EX). §4.3, §6.2, §12 |
| R10 | Citations | `[S]` mark at 8279bdf. `Job.ts:191` (constructor). `remote/executor/executor.ts:81`, `:319`, `:845`. `remote/executor/http.ts:134`. `cleanEvents` is declared on the exported `QueueDriver` but called by nothing outside the drivers. |
| R11 | (c) on a custom driver; count retention | `BunJobs` with `archive` refuses a driver without `archiveHold?`. `removeOnComplete: { count: N }` can overshoot N by the jobs finished within `lagWindow`, plus any archive backlog. §4.4 |
| §12 | Pending wording | One sentence: every name in the table is pending the user's approval |
| Effort | — | (b) gains 0.5–1 d for R1 to R4: 13.5–17 d (round 5 raises it further, §1.8). Total 25–31.5 d at round 4 (owner 24–30). §4.3, §11 |

### 1.8 Changelog of the fifth round (2026-10-10, pinned to `develop` 7e1841fe)

| # | Review finding | What moved |
|---|---|---|
| M1 | A store-less process's data patch corrupts an offloaded job | **Driver rule, in all six drivers:** a `JobPatch` carrying `data` without `blob` counts as `blob: false`, clearing the flag and stamping `opts.blobAt = now` in the same step. A producer, API process or old version then writes a well-formed inline record, and the sweep times the superseded key from `blobAt`. A record never flagged may skip the `opts` write. Contract case and suite case added. "Without `blobs`, nothing changes" is corrected. §4.3, §6.2 |
| M2 | A `copyFailed` letter's source was unprotected | Filing `copyFailed` also writes a **hold** in the source queue's state, `__win:blobhold:<sha256(key)>` = `{ key, letter, until }`: a driver write, so it works during an S3 outage. The source sweep keeps held keys and retries the copy, and so does the DLQ's sweep or `sweepBlobs()`; a completed copy patches the letter and deletes the hold. The hold is bounded by `copyHold` (default 7 days), then the key falls back to its ordinary rows. The `removeOnFail` interaction is documented, and §6.2 tests are added. §4.3 |
| L1 | "Retryable" could kill a job with `attempts: 1` | *Superseded in round 6 (§1.9): the refund on `failJob` became `releaseJob?`.* The store-less worker no longer consumes an attempt and is never dead-lettered by this path. Leaving it to the stalled sweep was rejected: that waits out the lock, counts a stall, and buries past `maxStalledCount`. §4.3 |
| L2 | Re-pin to `develop` 7e1841fe | Of the cited files, only `queue/BunQueueWorker.ts` and `summon/controller.ts` changed (#339, #344). Every citation into them is re-pinned (+8 after line 754 of the worker, +33 after 5134; the controller's CAS writes at `:1817`, `:2449`, `:2813`, `:3044`, `:3656`, its subscription at `:1242-1248`), and each was checked at 7e1841fe. `summon/group.ts:45`, `:84` and `summon/types.ts:249` are unmoved. The [S] mark and the intro now name 7e1841fe. |
| Nit | The reason tables disagreed | §4.3's table gains `not-loaded`, matching §12's five reasons. |
| Effort | — | (b) is now 15–18.5 d. `JobPatch.blob` with the default is 2.75 d, and M2 plus L1 add 1–1.25 d. Total 26.5–33 d (owner 24–30). §4.3, §11 |

### 1.9 Changelog of the sixth round (2026-10-10, pinned to `develop` 7e1841fe)

| # | Review finding | What moved |
|---|---|---|
| L1 | The refund rode on `failJob` and kept its bookkeeping | Replaced by a **release**: a new optional driver method, `releaseJob?(q, id, token, runAt, now)`, chosen over a `FailOutcome` field because optional methods are what `driverImplements` and `DRIVER_FEATURES` probe, and a field would be silently ignored by an older driver. **Contract, in all six drivers:** fenced on the token; back to `delayed` or `waiting`, never `failed`; `attemptsMade` decremented (the claim's increment, `memory-driver.ts:978`); no failure or metric count; `failedReason`, `stacktrace` and `stalledCount` untouched; the lock cleared. `processedOn` and `processedBy` keep the release's stamp until the next claim. The worker checks at the top of `#process`, before the heartbeat (`BunQueueWorker.ts:2808-2812`) and the `active` emit and publish (`:2836-2837`), and publishes no `failed`. `blobs` requires `releaseJob?`, which is the probe for the whole blob contract. Why it cannot loop: one release per store-less worker process, then it stops and refuses on restart. The stalled-sweep rejection is kept (`DEFAULT_MAX_STALLED` = 1, `shared/constants.ts:141`). `refundAttempt` is removed from §4.3, §6.2, §11 and §12. §4.3 |
| M2(a) | Holds whose letter is gone | The sweep reads `hold.letter` before copying. If the letter is gone, it deletes the hold, makes no copy, and the key falls back to its ordinary rows. §4.3, §6.2 |
| M2(b) | The DLQ cannot find `copyFailed` letters | Dropped the DLQ-side completion and its test: such a letter has no key under the DLQ prefix, and finding it would need a payload scan. Completion is the **source** queue's sweep or `sweepBlobs()` only. Stated: holds are bounded by the letters filed during an outage and still within `copyHold`; a pass pays one queue-state read per scanned key; two sweeps racing one copy are harmless (last patch wins, the loser's copy is swept as an orphan, the hold delete is idempotent). §4.3, §6.2 |
| Nits | — | "may skip" → "does skip": a deployment that never uses `blobs` sees no change to stored `opts`. The opts DTO strips both `blob` and `blobAt`, matching §12. |
| README | Summoned units | A note in §4.3's README notes: a summoned unit without `blobs` refuses at start once the marker exists, so a controller could re-summon it in a loop, bounded by the summon circuit and backoff (`summon/types.ts:272-289`). Fix: configure `blobs` in the summoned unit's code. |
| Effort | — | (b) is now 15.5–19 d (`releaseJob?` costs 0.75 d against the refund's 0.25–0.5). Total 27–33.5 d (owner 24–30). §4.3, §11 |

### 1.10 Changelog of the seventh round (2026-10-10, pinned to `develop` 7e1841fe)

| # | Review finding | What moved |
|---|---|---|
| MED | Where the refusal sits decides whether a summon loop is bounded | **The start-time refusal is pinned** inside `run()`'s startup, after `ensureQueue` (`BunQueueWorker.ts:1545`) and before `#armMaintenance` (`:1585`) and `void this.#report()` (`:1592`). So it comes before the first report: no worker record, no summon claim (made in `#report`, `:4965-4972`), no exit mark. **On the in-flight path**, after `releaseJob`, the worker's stop makes **`run()` reject** with the `ConfigError`, never a clean `close()` that would resolve it. The README note's [I] is replaced by the verified text: the attempt is settled as lost once `bootBudget` passes (`controller.ts:1794`; `define.ts:23`) and counted as a failure (`:1552-1572`, `#fail` `:2328-2342`), so backoff and circuit bound the loop. Also stated: a refusal after the report, or a clean close, would reset `failures` (`:1541`) and delete `lossStreak` (`:1536`) and loop every `cooldown`; and the in-flight path's code 1 (`summon/worker.ts:745-757`, `:1515-1517`) counts only as a late loss (`#failLate`, `:2380`) while watched. §4.3 |
| LOW | The release skipped the limiter give-back | The release path returns `attempt.reserved` through `#limiter?.release(record.name)` itself, because it returns before `#process`'s `try` (`:2839`), whose `finally` (`:2898-2907`) would. A test is added. §4.3, §6.2 |
| LOW | Releasing to `waiting` | `releaseJob` requires `runAt > now`, so the job always goes through `delayed`. `promoteDelayed` then restores its order and wakes waiters; a direct release to `waiting` would need its own wake, since Redis's `CLAIM` deletes the wake key once the queue empties (`redis/scripts.ts:808`). A contract case refuses `runAt <= now`. §4.3, §6.2 |
| LOW | Method versus field | Corrected: the package gates new operations as optional methods and new field promises as declared capabilities (`capabilities.jobAttribution`, `driver.ts:69-87`; `readApis.ts:193-197`). The release stays a method (an operation with its own fence, transition and result, and `failJob`'s contract unchanged). **`JobPatch.blob` is now gated on a declared capability, `capabilities.blobData`**, after that precedent, with `features.blobData` in the API. `blobs` requires both. §4.3, §12 |
| LOW | "At most one job" | Now "at most its concurrency" (`concurrency`, `queue/types.ts:1023`). |
| Effort | — | Unchanged. The capability, the limiter give-back and the rejecting `run()` fit inside the 0.75 d already counted for `releaseJob?` and its worker check. (b) stays at 15.5–19 d, and the total at 27–33.5 d. |

### 1.11 Changelog of the eighth round (2026-10-10, pinned to `develop` 7e1841fe)

| # | Review finding | What moved |
|---|---|---|
| MED | As worded, the in-flight stop exited as a success | The chain is stated, with citations: `#stopped` is only resolved (`BunQueueWorker.ts:1570`, `:1646`, `:2312`); the worker's close emits `closing` (`:2002`), which `runSummoned`'s `#onClosing` (`summon/worker.ts:812-831`) takes for an owner close; the later `#beginClose("error")` returns early (`:1247-1249`); and the close writes code 0 into the claim's mark (`BunQueueWorker.ts:5178-5179`), so the controller would count a proven success (`controller.ts:1531-1541`). **Fix:** the release path sets the worker's own `#exitMark = { reason: "error", code: 1 }` before closing; `#onClosing` checks it through a new `exitMark` getter and takes `#beginClose({ reason: "error" })`; `#stopped` is **rejected** after the close, which is a `run()` contract change listed in §12; `BunJobs` (`BunJobs.ts:1192`) catches the rejection, logs it and emits `error`. Every `run()` caller at `7e1841fe` is listed with its change (autorun and `runSummoned` already handle it; the playground and examples configure no `blobs`). The §6.2 test now asserts the claim's exit mark (code 1, reason `error`) and the controller's late loss, not only the process exit code. §4.3, §6.2, §12 |
| LOW | `features.blobData` wiring | It follows `jobAttribution`: an empty `DRIVER_FEATURES` entry with `probeFeatures` reading the capability (`api/routes/meta.ts:92-96`, `:182-185`); `supportsBlobData` checking `=== true` (as `:139-141`); two `s.boolean()` schema fields (`api/schemas/meta.ts` beside `:21`, `:213`); the contract DTOs (`api/contract/types.ts:3844`, `:3909`, `:3983`). Typed `boolean`. Added to PR-S1's row. §4.3, §11, §12 |
| Effort | — | (b) is now 16–19.5 d (+0.5 d). Total 27.5–34 d (owner 24–30). §4.3, §11 |
| Round 8, final | `#stopped` could not be rejected (`close()` awaits it, `BunQueueWorker.ts:2127`) | `#stopped` stays resolve-only. The error goes in a private `#stopError`, and `run()` rethrows it after its await at both returns (`:1528`, `:1624`). §4.3 and §12 reworded. |
| Round 8, final | Name both DTOs | `DriverCapabilitiesDto.blobData` (`api/contract/types.ts:3844`) and `MetaDto.features.blobData` (`:3909`, beside `jobAttribution` at `:3983`), matching the two `s.boolean()` schema fields. Earlier lines `:3901`/`:3975` corrected. §4.3, §12 |
| Round 8, final | `runSummoned`'s misleading log | Its rejection handler (`summon/worker.ts:745-757`) checks `member.ready` and logs "Summoned worker stopped with an error" for a ready worker instead of "could not start". Added to the worker changes. §4.3 |
| Round 8, final | Re-pinned to develop `fddee0af` | Rebased onto `fddee0af`. Of the cited files, only `sql/sql-driver.ts` (+20 after line 6790: `:7361` → `:7381`, `:8552-8566` → `:8572-8586`), `permissions.ts` (`:131` → `:143`) and the bun-jobs-ui README (`:418` → `:419`) moved since `7e1841fe`. Those citations are re-pinned. The [S] mark and the intro name `fddee0af`. |


---

## 2. What the driver contract needs from storage

### 2.1 The contract, in size [S]

A bun-jobs driver implements `JobsDriver` (`lib/drivers/driver.ts:2879`),
which is made of three parts:

- **`DriverLifecycle`** (`:91`): `connect`, `close`, `ping`, `purge`,
  `syncSchema?`, `listRunners` and `listQueues`;
- **`RunnerDriver`** (`:390`): 29 members, covering locks, state, history,
  run logs, metrics and queued triggers;
- **`QueueDriver`** (`:1975`): 64 members, 34 of them optional.

Two rules apply everywhere: every call is namespaced, and **a driver never
reads the clock**. `now` is always passed in (`:44-52`).

**Capabilities.** A driver reports `blockingWait`, `events`
(`push | poll | local`), `multiProcess`, `multiHost` and `jobAttribution?`
(`:56-88`).

**Degrading.** There is no capability for "unsupported". A driver degrades by
**leaving optional methods out**:

- the management API's `DRIVER_FEATURES` and `probeFeatures` prune routes
  (`api/routes/meta.ts:67-187`);
- the queue throws `NotSupportedError` at call sites such as
  `queue/jobDefaults.ts:505` and `queue/repeatControl.ts:393`.

So a driver can drop flows, limits or analytics and the rest still works.
Claim, lock, settle, wait, publish and subscribe are required.

### 2.2 Method by method: what needs an atomic conditional write [S]

The bun-jobs agent asked for this table. It lists every operation that needs
compare-and-set or create-once. The last column says what S3's two
conditional headers give each call, and what is missing:

- **`If-None-Match: *`** is create-once. A `PUT` succeeds only if the object
  does not exist.
- **`If-Match: <etag>`** is compare-and-swap. A `PUT` succeeds only if the
  object's ETag is still the one read.

| Operation | Contract (atomicity as documented) | Where it is used | With `If-None-Match` / `If-Match` on S3 |
|---|---|---|---|
| `addJob`, `addJobs` | Idempotent on id: an existing id answers `added: false` (`driver.ts:1979-1988`). Repeats depend on it (`repeat:<key>:<runAt>`, `queue/repeat.ts:20-32`) | every add; repeat scheduling | **`If-None-Match: *`** on `jobs/<id>`. A 412 means `added: false`. Exact |
| `claimJob` | Moves the next due job to `active` and stamps the claim, atomically. **Exactly one caller** may receive a job, and the claim answers `null` while the queue is **paused** (`:1993-1996`; contract case `driverContract.ts:3502`). It must honour **`excludeNames`** on every claim path, skipping jobs of those names rather than waiting behind them (`:1255-1263`; the contract's pile case `driverContract.ts:4316-4383`) | `BunQueueWorker` claim loop | **No single-call equivalent.** The file driver claims by atomic `rename` of a marker (`file-driver.ts:1388-1406`), and S3 has no rename. Either a **create-once claim object** (`If-None-Match`, so one winner, measured), followed by `If-Match` on the record; or `If-Match` on the record directly. **The claim key must be unique per claim, not per attempt** (§4.1): `attemptsMade` resets on `retryJob(resetAttempts)` (`memory-driver.ts:2426-2429`) and repeat ids are reused (`queue/repeat.ts:30-32`), so `claims/<id>/<attempt>` would 412 forever. Pause costs a read per claim (`GET` of the pause object, cached by the driver's 250 ms `PauseCache`). Finding *which* job to try needs a `LIST` of a ready index whose keys carry the encoded job name, so `excludeNames` costs no `GET` (§2.3) |
| `claimJobs?` | Each job claimed once; the batch is not atomic; never throw after a claim (`:2015-2026`) | batch claims | A loop of the above. There is no multi-object atomicity, and none is needed |
| `extendJobLock` | Holder only: fenced on `lockToken` (`:2031-2038`) | heartbeat every `lockDuration/3` = 10 s per active job (`queue/BunQueueWorker.ts:1153-1155`) | **`If-Match`** on the record, after a `GET` that checked the token. The ETag stands in for "still holding" |
| `completeJob`, `failJob`, `completeJobs?` | Holder only; clears the lock (`:2040-2073`) | every settle | **`If-Match`** with the ETag the claim's or last renewal's `PUT` returned (no re-read on the fast path, measured). **A 412 is not a lost lock**: unfenced writers change the record's ETag while it is active (`updateProgress`, `updateJob`, `Job.updateData`, below). On a 412: re-`GET`, check `lockToken`, and retry the settle on the new ETag; only a different token is a lost lock |
| `updateProgress` (unfenced) | Writes progress on a job; no holder check (`:2118-2122`) | `job.updateProgress()` from a handler | **`If-Match`** read-modify-write on the record, retried on 412. It is a second writer to an active record, which is why settle must re-check on 412 |
| `buryJob?`, `updateJob?`, `clearJobLogs?`, `rewritePendingOptions?` | Check and write in one atomic step (`:2089-2090`, `:2146-2149`, `:2190-2193`, `:2221-2237`) | dead-lettering; admin patches; job defaults rewrite | **`If-Match`** per record. Exact per record |
| `recoverStalled` | Lapsed or lockless active jobs go back to waiting or dead (`:2711-2723`). It runs under the `__win:fheal` lease | every 30 s, by the lease holder | **`If-Match`** per record. Finding lapsed jobs needs an ordered `active/` index (§4.1) |
| `promoteDelayed` | Due delayed or failed jobs go to waiting (`:2690-2709`) | 1/s per worker (`BunQueueWorker.ts:404-405`) | **`If-Match`** per record, plus index markers. **There is no ranged update**, so it is one request pair per due job |
| `recordChild?`, `requeueParent?` | The parent's move is atomic with the child's outcome. The stale check reads the child "under the same hold" (`:2254-2310`) | flows | **`If-Match`** on the parent. The child read stays **outside** the compare-and-swap, so the "same hold" rule weakens to: re-read the child after a successful parent write, and repair on mismatch [I] |
| `setQueueState?` | Write only if the version equals `expected` (`null` = absent). Check and write are one atomic step. Versions only increase, and a deleted entry restarts at 1 (`:2773-2783`) | every reserved entry below | **`If-None-Match: *`** for `expected = null`; **`If-Match`** otherwise; **delete is a conditional `DELETE` with `If-Match`**. AWS has had it since 2025-09-16 (§3.3), and SeaweedFS, RustFS and Versity honoured it [M]. MinIO ignores it [M], which is one more reason MinIO is off (a)'s allow-list. **No tombstones**: they would need `If-Match` on every later create (or `addJob` answers `added: false` forever), and a sweeper's unconditional `DELETE` of a tombstone races a re-created entry such as a lease or a summon marker (`summon/claim.ts:477`) |
| ↳ `__win:summon` marker | CAS whenever a check changes it | `summon/marker.ts:14`; `summon/controller.ts:1817`, `:2449`, `:2813`, `:3044`, `:3656` | `If-Match`. Low rate (every 30 s plus events) |
| ↳ `__win:summon-claim:<id>` | create-once per summoned worker, then CAS | `summon/claim.ts:40`, `:148-227` | `If-None-Match`, then `If-Match`. Exact |
| ↳ `__win:summon-group:<name>` (summon groups, on `develop` since #314), stored under the pseudo-queue `__bunjobs` (`shared/keys.ts:41`) | charged by CAS before the queue's marker | `summon/group.ts:45`, `:84` | `If-Match` on **one object shared by every queue in the group**. A hot object (§5.3) |
| ↳ `limiter` (rate and concurrency limits) | CAS on every reservation and commit, renewed every lease/3 = 10 s, up to 12 retries (`queue/limits.ts:86`, `:217`, `:683-695`) | every claim when limits are set | `If-Match` on **one object per queue, contended by every worker**. The measured single-object ceiling is 4 to 269 commits/s (§5.3). **The tightest spot in the design** |
| ↳ `__win:fheal`, `__win:msweep` sweep leases | CAS renew every 30 s / 60 s per queue (`BunQueueWorker.ts:151`, `:158`) | stalled and minute sweeps | `If-Match`. Low rate |
| ↳ `__win:debounce:<id>`, `__win:throttle:<id>` | CAS per add that uses them (`queue/windows.ts:30-33`) | debounced and throttled adds | `If-None-Match` / `If-Match`. Exact |
| ↳ `__win:jdef` job defaults | CAS on admin change; read ≤1/s per process (`queue/jobDefaults.ts:60-67`) | defaults | `If-Match`. Low rate |
| ↳ `__win:wcfg:`, `wctl:`, `wstop:`, `wchg` worker control | admin CAS (`queue/workerControl.ts:48-63`) | remote worker control | `If-Match`. Low rate |
| `acquireLock` / `renewLock` / `releaseLock` (runner) | free or expired; fail closed; holder only (`driver.ts:392-412`) | `BunRunner` exclusivity | `If-None-Match` to acquire a free lock; **`If-Match`** to take an expired one (expiry kept in the body) and to renew; release is a conditional `DELETE` with `If-Match` |
| `setState`, `incrementCounters`, history (runner) | read-modify-write on one runner (`:416-485`) | every run | `If-Match` on one runner object. Exact, but serialised per runner |
| `pushQueuedTrigger`, `popQueuedTriggerIf` | push with a length check is atomic; compare-and-pop with exactly one winner of N (`:716-768`) | runner triggers | `If-Match` on the runner object. Exact |
| Schema and version records | `syncSchema?` is optional and only for backends with a schema (`:104-116`) | — | **Nothing to sync.** One `bun-jobs/format` object, written `If-None-Match` on first connect, records the layout version. A newer layout refuses to start against an older one, the same way `RETIRED_INDEXES` gates MongoDB |

**The two ABA traps.** Both were found by measurement, and the design must
avoid each of them.

- **The ETag is MD5 of the content.** On every server tested, writing the
  same bytes gave the same ETag [M `conditional-writes.ts`]. On AWS, the ETag
  of a single-part upload without SSE-KMS is also the MD5 [W: AWS S3 docs,
  "Checking object integrity"]. So a record that goes A → B → A has the same
  ETag before and after, and a stale `If-Match` would succeed. **Every object
  written under compare-and-swap must carry a version or nonce in its body**,
  as bun-jobs' `setQueueState` already does with its monotonic versions.
- **Conditional delete is not portable** (MinIO ignores it [M]). Design (a)
  runs only on an allow-list of stores where it is honoured (§3.3), and
  deletes with `If-Match`. *The first draft proposed tombstones instead; the
  bun-jobs agent's review showed they break re-creation and race the sweeper,
  so they are dropped.*

### 2.3 Everything else the contract needs

| Need | Where in the contract | On S3 |
|---|---|---|
| **Ordering and priorities.** Claims go by priority, then `createdAt`, then id (`driver.ts:2022-2024`); `excludeNames` skips names (`:1255-1263`); a priority change **reorders** a waiting job (`:2140-2145`) | `claimJob`, `updateJob` | An index of marker objects whose names sort the same way as the file driver's do (its waiting marker is `pad(priority)-pad(createdAt)-encodeName(id)`, with **no** name in it: `#markerFor`, `file-driver.ts:4558-4586`; `file-names.ts:18-25`). Design (a)'s key **adds the job's encoded name**, `pad(priority)-pad(createdAt)-encodeName(name)-id`, so a claim skips excluded names from the listing alone, and pages past a pile of them with a `StartAfter` cursor instead of a `GET` per skipped marker. `LIST` returns keys in UTF-8 binary order [W: AWS `ListObjectsV2` docs], so the first page is the head of the queue. A priority change is a marker **move** (create the new, then delete the old). **The index is advisory**: the claim's conditional write is the truth, and a stale marker is skipped and reaped |
| **Indexes the first draft missed** | `failed` jobs awaiting retry (`promoteDelayed` reads them, `:2694-2705`); `waiting-children` (flows); `expiresAt` for `pruneExpired` (`:2756`) | Three more marker families, `ix/failed/pad(runAt)-…`, `ix/children/pad(createdAt)-…`, `ix/expires/pad(expiresAt)-…`. Without the last, `pruneExpired` has nothing to list |
| **Wake on every path that makes work ready** | `addJob`, `promoteDelayed`, `recoverStalled`, `retryJob`, `promoteJob`, `updateJob` moving `runAt` to now or earlier, `resumeQueue`, and a flow parent made ready by `recordChild` or `requeueParent` | Each bumps the `wake` object, or a waiter sleeps a full poll interval past a job that became ready |
| **`countDemand`'s read order** | reads `active`, then due `delayed`/`failed`, then `waiting`, a source before its destination, so a moving job is counted at least once (`:2362-2365`) | Holds per **record**, not between markers: a marker move is a create plus a delete, so a job can be in neither listing for a moment. Counting must either tolerate a one-off undercount, or create the destination marker before deleting the source and dedupe by id (the order this plan specifies) |
| **Delayed jobs and repeats.** `promoteDelayed` and `nextDelayedAt` (`:2705`, `:2835`); repeat records upserted (`:2827-2833`) | timers | A `delayed/pad(runAt)-id` index, listed from the front (`LIST` with no `StartAfter`, stopping at the first future marker) |
| **Flows** | `recordChild?`, `requeueParent?`, `markChildRecorded?` (`:2280-2324`) | `If-Match` on the parent; the redelivery repair already exists (`BunQueueWorker.ts:3518`) |
| **The event log and notify.** `publish`, `subscribe`, `waitForJob` (`:2841-2870`). SQL keeps a serial `seq`, and `EventGaps` re-asks for missing numbers, which **needs a dense integer sequence** to see a hole (`eventGaps.ts:1-20`); the file driver appends to `events.jsonl` and readers poll by offset (`file-driver.ts:4154-4356`) | events, waits | **No append and no notification.** A `(ms, writer, seq)` key cannot reveal a hole. A dense sequence needs a counter under compare-and-swap per channel, which is another hot object; the alternative is a lag window, re-listing the last N seconds, which **must cover cross-host clock skew**, since `ms` is each writer's clock. And a `wake` object whose ETag is polled with `HEAD`. **Every wait is a poll** (§5.2) |
| **Counts and listing.** `countJobs`, `listJobs`, `findJobs?`, `countDemand?` (`:2343-2399`) | the management API and summon demand | Counting needs **`LIST` of the whole index** (1000 keys per request), or a counter object under compare-and-swap (another hot object). `findJobs` falls back to a scan (`readApis.ts`) |
| **Cross-process control.** Pause flag, worker registry, worker control | `pauseQueue` (`:2821`), `registerWorker?` (`:2425`) | Plain `PUT` and `GET`; the pause flag is cached 250 ms to 1 s already (`shared/pauseCache.ts:22`) |
| **Schema and sync** | `syncSchema?` | None needed (the format object above) |

---

## 3. What S3 offers

### 3.1 Bun's `S3Client`, path by path [M]

The bun-jobs agent asked whether Bun exposes the conditional headers and an
ETag on every path a driver would use. It does not.

| Path | Conditional headers | ETag returned | Measured |
|---|---|---|---|
| `S3Client.write()` / `S3File.write()` | **No.** Undeclared `ifNoneMatch`, `ifMatch` and `headers` options are not sent ([`bun-cache` evidence, `s3-wire.ts`](evidence/results-s3-wire.txt)) | **No.** It returns the byte count | `conditional-writes.ts`: `write() returns number 2` |
| `S3File.text()`, `.bytes()`, `.stream()` | **No** (`If-Match` on a read is irrelevant here) | **No** | `text()` gives the body only |
| `S3Client.stat()` | — | **Yes**, `etag` (plus `size`, `lastModified`, `type`) | a `HEAD` |
| `S3Client.list()` | — | **Yes**, `eTag` per key | `ListObjectsV2` |
| `S3Client.delete()` | **No** | — | — |
| `S3Client.presign(key, { method: "PUT" })` + `fetch()` with the header **unsigned** | Sent by `fetch`; signed headers are `host` only | **Yes**, the `PUT` response's `ETag` header | honoured by all four servers tested (below); **unknown on AWS** [U] |
| Our own SigV4 header signing + `fetch()` (~40 lines, `node:crypto` HMAC) | **Yes**, signed | **Yes**, on the `PUT` response, and on a `GET` response's headers | honoured by all four servers tested |

**What a driver has to do.** It can use `S3Client` for plain writes, reads,
`stat()` and `list()`, but it needs **its own SigV4-signed `fetch()`** for
every conditional `PUT`, and for every `GET` whose ETag it needs:
`S3File.text()` does not return one, so it would cost an extra `HEAD` or a
race-prone `stat()`.

**Why not the presigned path?** It works on every server we tested, but on
AWS:

- the SigV4 docs require only `host` and `x-amz-*` headers to be signed
  [W: [IAM SigV4 reference](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-authentication-methods.html)];
- the AWS SDK itself **signs** `if-none-match` and `if-match` into a
  presigned URL (`X-Amz-SignedHeaders=host;if-none-match`)
  [M `aws-sdk-presign/`];
- nothing found shows AWS honouring an *unsigned* one [U].

The SigV4 signer is small. Adding a dependency on the AWS SDK for it would
break the package's no-runtime-dependency rule.

**Upstream.** [oven-sh/bun#17339](https://github.com/oven-sh/bun/issues/17339)
("S3 - Conditional Writes & User Metadata") has been open since 2025-02-14
[W]. A comment with this use case was posted on 2026-10-10
([comment](https://github.com/oven-sh/bun/issues/17339#issuecomment-6092094546)).
If the feature lands, the signer can go. It is a missing feature, not a bug,
so the standing rule on filing Bun bugs does not apply.

### 3.2 Conditional writes on the servers we could run [M]

`conditional-writes.ts`, against four S3-compatible servers on loopback.
`minio/minio` and `quay.io/minio/minio` could not be pulled, so MinIO is the
`bitnamilegacy` build of 2025-05-24:

| Server | `If-None-Match: *` (presigned / signed) | `If-Match` (presigned / signed) | Conditional `DELETE` (`If-Match`, wrong ETag) | 32-way create-once race | 32-way compare-and-swap race | One-object counter, 16 writers |
|---|---|---|---|---|---|---|
| MinIO 2025.5.24 | 412 / 412 | 412 / 412 | **ignored: deleted** | 1 winner, 31 × 412 | 1 winner, 31 × 412 | 160 of 160, **269 commits/s**, 196 attempts |
| SeaweedFS 4.48 | 412 / 412 | 412 / 412 | 412 | 1 winner | 1 winner | 160 of 160, **23/s**, 302 attempts |
| RustFS (2026-10-03) | 412 / 412 | 412 / 412 | 412 | 1 winner | 1 winner | 160 of 160, **4/s**, 2,048 attempts |
| Versity S3 Gateway 1.8.0 | 412 / 412 | 412 / 412 | 412 | 1 winner | 1 winner | 160 of 160, **56/s**, 1,956 attempts |

**What this shows:**

- **Conditional `PUT` is honoured** on all four servers, by both paths.
- **Races have exactly one winner.**
- **Lost updates: none.** A counter under compare-and-swap loses nothing.
- **Throughput on one hot object is low and erratic even on loopback**
  (4 to 269 commits/s), because losers retry: RustFS needed 12.8 attempts
  per commit. On a network, each attempt also costs a round trip (§5.3).
- **Two traps.** MinIO ignores `If-Match` on `DELETE`, and **the ETag is the
  MD5 of the content**, so identical bytes give identical ETags (§2.2).
- **Single node on loopback.** Distributed consistency and network latency
  are not measured here.

### 3.3 Conditional writes and consistency elsewhere [W]

The bun-jobs agent asked for each store's support and read-after-write
guarantee, marked verified, documented or unverified:

| Store | `If-None-Match: *` on `PUT` | `If-Match` on `PUT` | Conditional `DELETE` | Read-after-write and list-after-write | Per-key write limit | Mark |
|---|---|---|---|---|---|---|
| **AWS S3** (general purpose) | yes, since 2024-08-20 ([announcement](https://aws.amazon.com/about-aws/whats-new/2024/08/amazon-s3-conditional-writes/)) | yes, since 2024-11-25 ([announcement](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-s3-functionality-conditional-writes)) | yes, since 2025-09-16 ([docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-deletes.html)) | **strong** for `PUT`, `DELETE`, `GET` and `LIST` in all regions; bucket configuration is eventual ([docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel)) | none documented | documented |
| **AWS S3 Express One Zone** (directory buckets) | yes | yes | yes | strong | — | documented |
| **Cloudflare R2** | yes | yes | not listed | strong globally ([docs](https://developers.cloudflare.com/r2/reference/consistency/)) | **1 write/s per key; 429 above it** ([limits](https://developers.cloudflare.com/r2/platform/limits/)) | documented |
| **Google Cloud Storage** (XML API) | via `x-goog-if-generation-match: 0` | via generation match, not ETag | via generation | strong ([docs](https://docs.cloud.google.com/storage/docs/consistency)) | **1 write/s per object name** ([quotas](https://docs.cloud.google.com/storage/quotas)) | documented; **needs a different header set** |
| **MinIO** | yes (PR #16551, 2023; `*` in #19682, 2024) | yes | **ignored** in 2025.5.24 [M] | strict, **only on xfs, zfs or btrfs** ([docs](https://github.com/minio/minio/blob/master/docs/distributed/README.md)) | — | **measured** single node; **the repository is archived** ("NO LONGER MAINTAINED"); **conditional `PUT`s ignored their condition when read quorum was lost**, fixed in #21653 (2025-10-24), after the last community release |
| **SeaweedFS** | yes | yes | yes | — | — | **measured** single node (4.48); distributed unverified [U] |
| **RustFS** | yes | yes | yes | — | — | **measured** single node; distributed unverified [U] |
| **Versity S3 Gateway** | yes | yes | yes | follows its backend (POSIX here) | — | **measured** (1.8.0, POSIX backend) |
| **Ceph RGW** | yes | yes, since 2014 | fixed 2025-07 (ceph#63348) | strong within a zone [U] | — | documented; open bugs on versioning-suspended buckets (#72049) and CopyObject (#71588) |
| **Tigris** | yes | yes | yes | **global and dual-region buckets are eventually consistent** ([docs](https://www.tigrisdata.com/docs/objects/conditionals)) | — | documented |
| **Backblaze B2** | **rejected with an error** (as of 2025-07, [Proxmox patch](https://lists.proxmox.com/pipermail/pbs-devel/2025-July/014234.html)) | unknown | unknown | — | — | documented by a third party |
| **Wasabi** | unknown | unknown | unknown | — | — | **unverified**: no primary source found |

**What this means for a driver:**

- **AWS S3, S3 Express, and R2 within its 1 write/s per key** are the only
  stores where design (a) could stand on documented ground.
- **R2 and GCS's one write per second per key** rules out a hot object
  entirely. It also rules out a **job shorter than about 1 s**: its claim and
  settle are two writes to the same record within a second (§5.3).
- **Elsewhere, design (a) must probe at connect and refuse to start** if a
  repeated create-once `PUT` does not answer 412. Even a passing probe cannot
  prove that a distributed deployment keeps the guarantee under failure, as
  MinIO's quorum bug shows.
- **Designs (b) and (c) use no conditional writes**, so every store above
  works for them, B2 included.

### 3.4 Latency and request-rate limits [W, M]

| | S3 Standard | S3 Express One Zone | Loopback servers [M] |
|---|---|---|---|
| Small-object latency | "roughly 100–200 ms" ([AWS performance guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html)); one third-party run in eu-north-1: `PUT` p50 70 ms, p99 137 ms; `GET` p50 26 ms ([topicpartition.io, 2025-03-04, n = 100](https://topicpartition.io/misc/AWS-S3-PUT-latency-benchmark)) | "single-digit millisecond" | `PUT` p50 1.5 to 14.7 ms, `GET` 0.7 to 1.1 ms, `HEAD` 0.6 to 0.8 ms, `LIST` (≤100 keys) 2.4 to 14.2 ms (`conditional-writes.ts`) |
| Rate per prefix | ≥ 3,500 writes/s and 5,500 reads/s per partitioned prefix, scaling gradually, with 503 `SlowDown` while it scales | 100k writes/s and 200k reads/s per bucket by default | — |
| Failed conditional requests | billed at the normal rate ([docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html)) | same | — |

### 3.5 Prices (read 2026-10-10) [W]

| Store | Writes and `LIST` | `GET` and `HEAD` | `DELETE` | Storage | Source |
|---|---|---|---|---|---|
| S3 Standard (us-east-1) | $0.005 per 1,000 | $0.0004 per 1,000 | free | $0.023 / GB-month | AWS Price List API, published 2026-09-28 |
| S3 Express One Zone | $0.00113 per 1,000 | $0.00003 per 1,000 | — | $0.11 / GB-month, plus $0.0032/GB uploaded and $0.0006/GB retrieved | same |
| Cloudflare R2 | $4.50 per million (Class A; `LIST` is Class A) | $0.36 per million (Class B) | free | $0.015 / GB-month, no egress fee | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Backblaze B2 | free (classes A to C) | free | free | $5 to $6.95 / TB-month (its pages disagree) | Backblaze pricing pages |

---

## 4. The candidate designs

### 4.1 (a) A full driver on conditional writes [D, sketch]

```
<prefix>/<ns>/format                                   layout version, If-None-Match on first connect
<prefix>/<ns>/q/<queue>/jobs/<id>                      JobRecord + version nonce   (If-None-Match add; If-Match moves)
<prefix>/<ns>/q/<queue>/claims/<id>/<incarnation>-<n>  create-once claim, n = the record's claim counter + 1 (If-None-Match)
<prefix>/<ns>/q/<queue>/ix/waiting/<pad(prio)>-<pad(createdAt)>-<encodeName(name)>-<id>   empty markers, advisory
<prefix>/<ns>/q/<queue>/ix/{failed,children,expires}/…  the three the first draft missed (§2.3)
<prefix>/<ns>/q/<queue>/ix/delayed/<pad(runAt)>-<id>
<prefix>/<ns>/q/<queue>/ix/active/<pad(lockExpiresAt)>-<id>
<prefix>/<ns>/q/<queue>/ix/{completed,dead}/<pad(finishedOn)>-<id>
<prefix>/<ns>/q/<queue>/state/<name>                   setQueueState entries        (If-None-Match / If-Match; conditional DELETE)
<prefix>/<ns>/q/<queue>/ev/<pad(ms)>-<writer>-<seq>    one object per event
<prefix>/<ns>/q/<queue>/wake                           ETag polled by waiters
<prefix>/<ns>/r/<runner>/{lock,state}                  runner lock and state        (If-Match)
```

**Claim:**

1. Read the pause object. The driver's `PauseCache` keeps it for 250 ms
   (`shared/pauseCache.ts:22`). If the queue is paused, answer `null`
   (`driver.ts:1993-1996`).
2. `LIST ix/waiting/` (first page, `maxKeys` 32). Skip markers whose encoded
   name is in `excludeNames` from the key alone. If a whole page is
   excluded, list on from a `StartAfter` cursor at the last skipped key
   (`driver.ts:1255-1263`; the pile case `driverContract.ts:4316-4383`).
3. Pick a marker, spreading workers across the page.
4. `GET jobs/<id>` and check that it is still waiting. The record carries
   `incarnation` (a random nonce written when the record is created, so a
   reused id is a new incarnation) and `claims` (a counter bumped by every
   claim).
5. `PUT claims/<id>/<incarnation>-<claims + 1>` with `If-None-Match: *`. A 412
   means another worker won this claim, so take the next marker.
   - **Why not `<attempt>`?** `attemptsMade` resets on
     `retryJob(resetAttempts: true)` (`memory-driver.ts:2426-2429`), and
     repeat ids are deterministic (`queue/repeat.ts:30-32`). A key per
     attempt would 412 forever after a reset or a reuse, so the job could
     never be claimed again.
   - The claim counter never goes back, and a new incarnation starts a new
     key space.
6. `PUT jobs/<id>` (active, token, `lockExpiresAt`, `claims + 1`) with
   `If-Match` on the ETag from step 4.
7. `PUT ix/active/…`, then `DELETE` the waiting marker: destination first, so
   `countDemand` sees the job at least once (§2.3).

Claim objects are garbage. The stalled sweep deletes those older than
`lockDuration` whose record has moved past them.

**Settle** is a `PUT jobs/<id>` with `If-Match`, using the ETag the last `PUT`
returned. A 412 means re-`GET`, check `lockToken`, and retry on the new ETag:
`updateProgress` and `updateJob` write an active record without the lock
(`driver.ts:2118-2122`), so a 412 is not proof of a lost lock. Only a
different token is. Settle is followed by the `completed` marker, then the
deletion of the `active` marker.

**Why a claim object, and not only `If-Match` on the record?** Both work. The
claim object makes losing cheap: a 412 on a tiny object, instead of a failed
`PUT` of the whole record.

**What holds** (the prototype measured the claim and settle path, through
presigned URLs with an unsigned header and keys of `claims/<id>`, with no
stall, retry or reuse; the rest is [I]):

- **Exactly-once claim.** 300 of 300 jobs, at 1, 4 and 16 workers, on MinIO
  and on SeaweedFS [M `claim-proto.ts`].
- **Fenced renew and settle** (`If-Match`, with the re-check above).
- **Idempotent add** (`If-None-Match`).
- **Versioned queue-state compare-and-set**, including the summon marker and
  claims, with conditional deletes on the allow-listed stores.
- **Runner locks**, and the runner's queued-trigger compare-and-pop.

**What weakens:**

- **Ordering is approximate.** The index is a set of separate objects written
  around the record's write. A crash between the two leaves a marker without
  a job or a job without a marker. Both are healed by listing, as the file
  driver heals its own litter (`file-driver.ts:1431-1452`, `:3751-3758`).
  Until a heal runs, a job can be skipped. A priority change is a marker
  move (§2.3).
- **Flows.** The child read is outside the parent's compare-and-swap (§2.2).
- **Counts** cost a full `LIST` of the index, and are approximate during
  writes.
- **Events have no dense sequence.** `EventGaps` cannot see a hole in
  `(ms, writer, seq)` keys. It needs either a compare-and-swap counter per
  channel (a hot object) or a re-listing lag window wider than cross-host
  clock skew (§2.3).

**What does not hold:**

- **Low pickup latency at low cost.** There is no notification, so every
  wait is a poll, and every poll is a billed request (§5.2).
- **Hot objects under contention.** The `limiter`, a summon group's entry,
  and any counter: one object per queue, compare-and-swap serialised.
  Measured ceilings are 4 to 269 commits/s on loopback, and the network adds
  a round trip per attempt (§5.3).
- **`multiHost: true` on stores whose conditional writes are unverified**
  (§3.3). The driver must refuse to start on a store off the allow-list, or
  one that fails a connect-time probe: a create-once `PUT` of a probe object
  twice must answer 412 the second time, and a conditional `DELETE` with a
  wrong ETag must answer 412.

**Effort:** the first draft said 18 to 22 days. The bun-jobs agent reads that
as optimistic, given the indexes, the event sequence, the claim and settle
rules above, and the contract's 209 cases (`__tests__/helpers/driverContract.ts`).
**Read it as 25 days or more** [I]. It is unscheduled either way. Most of the
file driver's logic (6,157 lines) would be rewritten, because `rename` and
`O_APPEND` have no S3 equivalent.

### 4.2 (b0) A size limit first: `maxDataBytes` [D; recommended, pending the user's approval]

**The cheapest fix for the unbounded-inline-data hole needs no new storage.**
Today:

- job `data` is stored inline (`driver.ts:1161`);
- the only check is `assertJsonSafe` (`shared/json.ts:34-40`), which is
  bun-common's `jsonClone` (`packages/bun-common/lib/utils/native.ts:2727-2735`):
  a `JSON.stringify` and a `JSON.parse`, with the string discarded;
- nothing caps the size;
- the runner already caps *its* results: `maxResultBytes`, 16 KiB by default
  (`runner/types.ts:898`), enforced by `stringifyBounded`
  (`shared/json.ts:49-69`).

**What it adds.** A **queue-level** option, `maxDataBytes`, on `BunQueue`,
and on `BunJobs` for the queues it builds: the largest UTF-8 size of `data`'s
JSON encoding.

- **Not a job-defaults key.** Job defaults are per job and stored in
  `__win:jdef`, so a producer could raise its own limit.
- **Processes need not agree.** Each process applies its own setting. The
  limit guards the writer, so a producer without it simply does not check.

**The check.** A variant of `assertJsonSafe`, called `assertJsonSafeSized(value, label, maxBytes)`:

1. stringify once;
2. measure with one `Buffer.byteLength(json, "utf8")`, not `.length`, which
   counts UTF-16 units;
3. throw `SerializationError` (`shared/errors.ts:366`) with the size and the
   limit;
4. otherwise `JSON.parse` **that same string**.

That is what `jsonClone` does today, plus one `Buffer.byteLength`, with **no
extra stringify**. It runs only when `maxDataBytes` is set.

**It refuses; it never truncates.** A handler must never receive a silently
cut payload. That is the deliberate difference from `maxResultBytes`, which
stores a marker in place of a run's result.

**Every site that writes `data`, and whether it checks [S]:**

| Site | Where | Checked? |
|---|---|---|
| `#buildRecord` (the one `assertJsonSafe` on add) | `queue/BunQueue.ts:2964-3024`, the call at `:3001` | **yes**: this one site covers `add` (`#addSimple`, `:683`), `addBulk` (`:765`), the first occurrence of a repeat (`#addRepeatable`, `:3100-3106`), every flow node (`#addFlowNode`, `:1600-1621`) and a debounce's new window (`:2723-2739`) |
| the repeat definition (`upsertRepeat` in `#addRepeatable`) | `:3100-3106` | yes, the same value checked once |
| `Job.updateData`, `Job.update` | `queue/Job.ts:442-447`, `:483`; all go through `Job.#update`, `:619-633` | **yes** |
| `BunQueue.update` | `queue/BunQueue.ts:1784-1834` (driver call `:1819`) | **yes** |
| debounce replacement (a patch) | `:2647-2656` | **yes** |
| the worker's next repeat occurrence | `queue/BunQueueWorker.ts:4136`, `addJob` at `:4191-4211`, copying `...record` | **no.** It copies data already checked when it was written. Refusing inside the worker would fail where no caller can act (the reasoning of `queue/options.ts:356-361`). A series written before the limit was lowered keeps running, and the README says so |
| repeat heal and re-enable (`occurrenceRecord`) | `queue/repeatControl.ts:266-296`; `BunQueueWorker.ts:5610-5614`; `repeatControl.ts:335` | **no**, same reason |
| a dead letter | `queue/deadLetter.ts:52-67` | **exempt** (below) |

**Dead letters are exempt, and the plan does not claim their data is
shortened.**

- **What "shortened, never refused" means.** The comment at
  `queue/deadLetter.ts:63-66` is about the letter's **job id**
  (`shortenJobId(...)`), not its data.
- **What a letter is.** A new job on the dead-letter queue. Its data is a
  wrapper, `{ queue, id, name, data, failedReason, attemptsMade, diedAt }`
  (`:54-62`; type `queue/types.ts:1230-1245`), whose `data` is the dead
  job's raw `record.data` (`:58`).
- **The wrapper goes through the DLQ's own `#buildRecord`.** It can already
  throw there today, on a value that is not JSON-safe, and that does not
  change.
- **Why the exemption holds.** The DLQ `BunQueue` is built from
  `{ namespace, driver, logger }` only (`BunQueueWorker.ts:4072-4076`), and
  `fileBuriedLetter` uses `{ namespace, driver }` (`deadLetter.ts:99-102`).
  So the DLQ never receives a source queue's `maxDataBytes`, and (b0) adds
  nothing to that construction. A test pins it.
- **The alternative was worse.** Refusing a letter for its size would lose
  the record of a failure at exactly the point the failure is being kept.

**The default is none**, so nothing changes until a user sets it. Whether a
later major release should default it is §10 Q2. **It is public API**, so it
needs the user's approval before it is built (§12).

**Effort:** 1.5 to 2 days (the owner's range): the sized helper, five call
sites, the DLQ pin, tests on every backend.

### 4.3 (b) S3 as a blob store for job data [D]

**Not a queue driver.** A capability any driver can use:

```ts
const jobs = new BunJobs({
  driver: postgres,                                  // the queue stays where claims are atomic
  blobs: s3Blobs({ client: new S3Client({ bucket: "jobs-data" }), offloadAbove: 256 * 1024 }),
});
await queue.add("render", { video: hugeBuffer });    // data over 256 KiB goes to S3
```

**Scope: data only, and not on repeats.**

- **Results are out.** `job.returnValue` is a synchronous property
  (`queue/Job.ts:161`), and a result also lives in the `completed` event
  payload (`BunQueueWorker.ts:3054-3058`, stored in SQL's events table at
  `sql/sql-driver.ts:7381`, delivered to `on("completed")` at
  `BunQueue.ts:3315-3321`), in a flow parent's `flow.values`
  (`driver.ts:906`) and in `settledOutcome` (`BunQueueWorker.ts:361`).
  Offloading results is a separate, breaking proposal.
- **Repeats stay inline: definitions, occurrences, and patches to
  occurrences.**
  - **Why.** The worker builds the next occurrence by spreading
    `...record` from the **claimed previous occurrence**
    (`BunQueueWorker.ts:4191`), not from the definition's data, which heal
    and re-enable use (`repeatControl.ts:266-296`). So an `updateData` on
    one occurrence propagates down the series. If an occurrence held a
    pointer, every later occurrence would share its blob key. Once the
    first occurrence was removed, the sweep would delete a blob the
    successors still point at.
  - **So none of these may offload:**
    - a repeat definition (`#addRepeatable`, `BunQueue.ts:3100-3106`);
    - its occurrences;
    - a `Job.updateData`, `Job.update` or `BunQueue.update` on any record
      whose `repeatKey` is not `null` (`JobRecord.repeatKey`,
      `driver.ts:1224`).
  - Repeat data is bounded by (b0) instead. **A repeat whose data is over
    `offloadAbove` therefore stays inline unless `maxDataBytes` is set**, and
    the queue logs one `warn` per repeat key the first time it happens,
    naming the size, the threshold and this rule.
  - Debounce cannot combine with repeat (`queue/JobDraft.ts:309`), and a
    flow node cannot use repeat, debounce or throttle
    (`BunQueue.ts:1532`). So the debounce and flow paths never meet a
    repeat.

**The check site.** One helper, `planData(data, current)` in a new
`queue/blobData.ts`, decides inline or offload. Every writer calls it:

| Writer | Where | What it knows |
|---|---|---|
| `#buildRecord` | `BunQueue.ts:2964-3024` | whether the add is a repeat (`opts.repeat`); flows and debounce windows pass through here |
| `Job.#update` | `queue/Job.ts:619-633` | its `#record`, which **may be stale**, so with `blobs` configured it re-reads the record (`driver.getJob`) before deciding |
| `BunQueue.update` | `BunQueue.ts:1784-1834` | **nothing today**: it patches by id without reading (driver call at `:1819`). With `blobs` configured it reads the record first, **for every data patch**, small or large |
| debounce replacement | `:2647-2656` | today only the debounce pointer entry, not the job (`:2647`). With `blobs` configured it reads the pending job first. A debounced job is never a repeat |

**With `blobs` configured, every data patch reads the record first**: one
`getJob` per data patch. That read is what lets `planData` see the current
`repeatKey` and offload state. A process **without** `blobs` adds no read
and sends no `blob` field; the driver's default below still keeps its patch
from corrupting an offloaded job.

**Four more rules.**

- **An offloaded job prefers to stay offloaded.** When the read shows the job
  is offloaded, `planData` offloads every later data patch too, even a small
  one. It is a preference, not an invariant the sweep relies on: the read
  and the patch are two steps, so a concurrent patch can still leave an
  inline record whose last blob is now superseded.
- **The driver stamps the time the flag was written.** Whenever a patch
  carries `JobPatch.blob` (`true` or `false`), the driver writes
  **`opts.blobAt = now`** in the same atomic step, where `now` is the
  argument `updateJob` already receives (`driver.ts:2151-2156`). The driver
  never reads the clock. `#buildRecord` stamps it on an offloaded add. The
  sweep times every superseded key from this field, whatever the data is
  now (below).
- **A data patch without `blob` counts as `blob: false`** (a driver rule, in
  all six drivers). A process without `blobs` (a producer, an API process,
  an old version) that calls `queue.update`, triggers the debounce patch,
  or calls `Job.updateData` sends `data` and no `blob`.
  - **Without the rule**, the driver would keep `opts.blob: true` over the
    new inline data, and every reader would take that data for a pointer.
  - **With it**, the driver clears the flag and stamps `opts.blobAt = now`
    in the same step. The record is a well-formed inline one, and the sweep
    times the superseded key correctly.
  - **A record that was never flagged** does skip the `opts` write: an
    absent flag already reads as `false`. A deployment that never uses
    `blobs` therefore sees no change at all to its stored `opts`. Its superseded keys, if any, fall under
    the sweep's "no `blobAt`" row.
  - A contract case pins it (§6.2).
- **The id-reuse race.** A removal and re-add of the same id between the
  read and the patch would apply the patch to the new incarnation. The patch
  carries the data, its flag and the stamp together, so the worst case is a
  well-formed pointer and flag, or inline data and flag, on the new
  incarnation. A mismatched pair cannot happen. The same race exists today
  for a plain data patch.

**The pointer and its flag (N1): `JobPatch.blob`, not a fixed rule.**

- **What is stored.** `data` becomes `{ $blob: { key, size, sha256, at } }`,
  where `at` is the write time in ms. The record says so with
  **`opts.blob = true`**. `opts` is JSON in every driver
  (`StoredJobOptions`, `driver.ts:1066`), so there is no new column.
- **The flag must be able to change on an update.** Today
  `JobPatch` is `data?`, `priority?`, `runAt?`, `onlyIn?`
  (`driver.ts:1287-1296`), with no `opts`. Two writers already edit `opts`,
  though:
  - a priority patch rewrites `opts.priority` and `opts.explicit`
    (`:2140-2145`);
  - `rewritePendingOptions` (`:2249`, called from `BunQueue.ts:2193`).
- **So (b) adds `JobPatch.blob?: boolean`**, written in the **same atomic
  step** as `data`, together with `opts.blobAt = now`, in all six drivers,
  plus contract cases.
- **Why not "fixed at create"?** That rule (only `add` decides, and patches
  inherit) needs no driver change. But it either forces a big update onto an
  inline job to stay inline, which defeats (b), or lets a reused id pair
  data with the wrong flag. A wrong flag means a pointer handed to a handler
  as data, or user data read as a pointer.

**What `JobPatch.blob` costs, per driver [S, I for the estimate]:**

| Driver | How it applies a patch today | Change | Estimate |
|---|---|---|---|
| memory | in-place mutation; `opts` spread for priority (`memory-driver.ts:1120-1188`) | one more spread | 0.1 d |
| file | closure inside `#mutateHeld`, `next = {...record}` (`file-driver.ts:1852-1906`) | one more spread | 0.1 d |
| SQL (pg, sqlite, mysql, mariadb) | one `UPDATE … RETURNING` where supported, otherwise `SELECT … FOR UPDATE` + `UPDATE` (`sql/sql-driver.ts:3618-3740`); opts edited in SQL | an assignment through the existing `dialect.jsonSetValues` (`sql/dialect.ts:270`), all four dialects | 0.5 d |
| MongoDB | a data-only patch is one `findOneAndUpdate`; a priority patch is a read-then-CAS loop on the `opts` JSON string, 3 retries, then a `DriverError` (`mongo/mongo-driver.ts:3239-3340`, `PATCH_RETRIES` at `:342`) | **two top-level overlay fields, `optsBlob` and `optsBlobAt`, beside `opts`**, laid over it on read, as on Redis. A data patch then stays **one** `findOneAndUpdate` setting `data` and both fields. The other choice, the CAS loop on the `opts` string, was rejected: it would race `rewritePendingOptions`, which rewrites that string, and a busy job would throw after `PATCH_RETRIES` | 0.5 d |
| Redis | one Lua script, `UPDATE_JOB` (`redis/scripts.ts:2537-2614`), which never re-encodes the record's `blob` field and writes overlay fields instead (`data`, `optsPriority`, `xmask`), laid over by `#toRecord` (`redis/redis-driver.ts:1952-1986`, `:4875-4908`) | a new overlay field, in the style of the `o:<option>` fields (`OPTION_FIELD_PREFIX`, `scripts.ts:2310`, read at `redis-driver.ts:4948`), plus a reader rule | 0.75 d |
| contract | — | the flag and `blobAt` change atomically with `data`; a data patch without `blob` clears the flag and stamps `blobAt`; `rewritePendingOptions` leaves both alone; a priority patch on an offloaded job keeps them; on MongoDB and Redis, the overlays read back through `getJob`, `listJobs` and `findJobs` | 0.75 d |
| | | **Total** | **≈ 2.75 d** |

**Reads (N7).**

- **What a `Job` holds.** A `Job` is built from `(driver, ref, record,
  wasAdded, hooks)` (its constructor, `queue/Job.ts:191`) and has no queue reference.
  The blob store therefore travels in `hooks`, through every construction
  site:
  - `BunQueue.#view` (`BunQueue.ts:2891-2899`) and `Job.#view`
    (`Job.ts:639-647`);
  - the direct constructions at `BunQueue.ts:1578`, `:1625` and
    `BunQueueWorker.ts:2788`, `:3259`, `:3348`, `:4118`.
- **How a worker gets the store.** A new option,
  **`BunQueueWorkerOptions.blobs`**. `BunJobs` passes its own `blobs` when it
  builds a worker (`BunJobs.ts:774`), as it passes `publish` and `service`.
  A worker built directly takes the option itself.
- **`job.data` stays typed `TData`, and never silently holds a pointer.**
  For an offloaded job not yet loaded, `data` is a getter that throws
  `BlobNotLoadedError`. Today it is a plain field (`Job.ts:135`, `:211`).
  `await job.loadData()` fetches, verifies, caches and returns `TData`.
- **Who resolves.**
  - The worker resolves before the handler runs, so a handler always sees
    real data.
  - `BunQueue.getJob` (`BunQueue.ts:932`) resolves by default (one `GET`).
    `getJobs`, `listJobs`, `findJobs` and the API's lists do not
    (`resolveData: false`). No list costs a `GET` per job.
  - **`getJob` never throws over a blob.** When its `GET` fails it returns
    the job unresolved, and the cause is in `job.data`'s
    `BlobNotLoadedError`, whose `reason` is one of:

    | `reason` | Cause | Mark |
    |---|---|---|
    | `not-loaded` | the job was read with `resolveData: false` (a list, or an internal read) and `loadData()` has not run yet | [D] |
    | `missing` | a 404, after the same one re-read of the record as the worker's | [D] |
    | `corrupt` | a `sha256` mismatch | [D] |
    | `unavailable` | a transport error | [D] |
    | `no-store` | the reading process has no `blobs` | [D] |

    `getJob` itself never produces `not-loaded`, since it always tries.
    `job.loadData()` retries, and rethrows the same error on failure. A read
    for display should not fail because one blob is down.
  - **Internal reads pay no `GET`.** `BunQueue`, the worker and `Job` read
    through `driver.getJob`, which never resolves:
    - `BunQueue.ts:940`, `:1576`, `:2675`, `:2694`;
    - `BunQueueWorker.ts:3275`, `:3285`, `:3335`, `:3460`, `:3737`, `:4027`,
      `:5600`;
    - `Job.ts:671`, `:680`, `:689`.

    The API's own `queue.getJob` calls (`api/routes/jobs.ts:86`, `:109`,
    `:591`, `:683`) pass `resolveData: false`.
- **A handler's own `updateData(big)`.** It returns a view built from the
  driver's record (`Job.ts:625-633`), which holds the pointer. The helper
  seeds that view's cache with the value it just wrote, so `view.data` is
  the real value.
- **`toJSON()`** (`Job.ts:697-699`) returns the record. It carries the
  pointer and `opts.blob`, and the README says so.

**When the blob cannot be read (N3, N6).**

- **A 404:** re-read the record once.
  - If its pointer changed (a patch landed in between), follow the new one.
  - If it is the same pointer, the blob is gone: fail with
    **`UnrecoverableJobError`**, which goes straight to the dead set with no
    further attempts (`shared/errors.ts:135-150`; the worker's `retryable`
    check, `BunQueueWorker.ts:3869-3878`).
  - The error's message names the key. A missing blob does not come back on
    retry, so spending attempts on it only delays the dead letter.
- **A `sha256` mismatch:** `UnrecoverableJobError` likewise.
- **Transport errors** (5xx, timeouts, connection resets): an ordinary
  failure, retried under the job's normal `attempts`.

**Dead letters (N5).**

- **The DLQ gets the blob store.** Both DLQ constructions pass `blobs`, and
  still no `maxDataBytes`, as in (b0):
  - the worker's (`BunQueueWorker.ts:4072-4076`), from its own
    `BunQueueWorkerOptions.blobs`;
  - `fileBuriedLetter` (`deadLetter.ts:99-102`), called from `Job`'s bury
    path (`Job.ts:424`), which takes the store from the `Job`'s hooks.
- **A dead offloaded job.** The letter does not embed the pointer as raw
  data. It gets a typed **`dataRef`** instead, which needs a new field on
  the `DeadLetter` type (`queue/types.ts:1230-1245`):
  - the blob is **copied** (a `GET`, then a `PUT`) to a key owned by the
    letter, `blobs/<ns>/<dlq>/<letterId>/<uuid>`;
  - the letter stores `{ ..., data: null, dataRef: { key, size, sha256, at } }`.
  - Removing the original therefore never strands the letter.
- **When the copy hits a transport error.** The copy retries a bounded
  number of times (3, with backoff). If it still fails:
  - the letter is filed with `dataRef: { ...sourcePointer, copyFailed: true }`;
  - **and the source key is held.** In the same step as filing, the worker
    writes a hold entry in the **source** queue's state,
    `__win:blobhold:<sha256(key)>`, as
    `{ key, letter: { queue, id }, until: now + copyHold }`. It is created
    with `setQueueState(expected: null)`, one entry per hold, so no single
    object grows. That is a **driver** write, so it works during an S3
    outage;
  - **the source queue's sweep keeps held keys** whatever their row says,
    and completes the copy for each hold it meets. That is the source queue's
    worker sweep, or `sweepBlobs()` on the source queue; the source queue is
    the one with workers. For each hold:
    - **it reads `hold.letter` first** (one driver read). If the letter is
      gone (removed, pruned or drained), it deletes the hold and leaves the
      key to its ordinary sweep rows. Otherwise each pass would spend a `GET`
      and a `PUT` copying for nobody, and leave an orphan copy for up to
      `copyHold`;
    - if the letter exists, it copies, patches the letter's `dataRef` to the
      copy, and deletes the hold;
  - **only the source side completes copies.** A `copyFailed` letter has no
    key under the DLQ's prefix, because its `dataRef` names the source key,
    so the DLQ's sweep never meets it. Finding such letters from the DLQ
    would need a scan of letter payloads, which the driver contract offers
    no index for;
  - **what holds cost.** Their number is bounded by the dead letters filed
    during an outage that are still within `copyHold`. Each key a pass scans
    costs one queue-state read for its hold, on top of the record read the
    sweep already makes;
  - **two sweeps racing one copy are harmless.** Both copy to fresh random
    keys, and the last letter patch wins; the loser's copy has no reference
    and is swept as an orphan. Deleting the hold is idempotent;
  - **the hold is bounded.** It expires at `until` (`copyHold`, default 7
    days). After that the source key falls back to its ordinary sweep rows,
    and a later 404 on it makes the letter `missing: true`. The sweep
    deletes expired hold entries;
  - **why it is needed.** Without the hold, the source would be unprotected
    whenever `removeOnFail` deletes the dead job (`true`, a `ttl` or a
    `count`). The no-record row times from the blob's own `lastModified`,
    which is its write time, not the job's removal, so the source sweep
    could delete the blob before the copy completed. The README states the
    `removeOnFail` interaction and the 7-day bound;
  - only a **404** on the source makes the letter `missing: true`.
  - **A 5xx never does.**
- **A job that died *of* a missing blob.** There is nothing to copy. The
  letter gets `dataRef: { ...pointer, missing: true }`, so it records what
  was lost rather than failing to be written.
- **Re-driving a letter.** A letter's `data` is `null` whenever it has a
  `dataRef`. A consumer that re-adds the original job must read the data
  through `dataRef` (`job.loadData()` on the letter does it). The README
  says so beside the dead-letter example.
- **An inline job with large data.** It dies into a wrapper that, on a DLQ
  with `blobs`, is offloaded whole like any other record.

**Deletion: deferred, with a grace that counts from the right moment
(N3, N4).**

- **Removals do not report ids.** `pruneExpired` and `drainQueue` return
  counts (`driver.ts:2756`, `:2758`), and `purge` returns nothing (`:103`).
  `removeOnComplete` deletes inside the settle, and count retention runs
  inside the driver (`sql/sql-driver.ts:770-786`). And eager deletes race
  claims and id reuse. **So (b) never deletes eagerly.**
- **Keys carry a random per-write segment**:
  `blobs/<ns>/<queue>/<jobId>/<uuid>`. Two writes never share a key, and an
  id's reuse never reaches an older incarnation's blob.
- **One sweep decides every delete**, modelled on the SQL driver's
  orphaned-log sweep (`sql/sql-driver.ts:8572-8586`).
  - **How it walks.** It pages through `blobs/<ns>/<queue>/` a bounded
    number of keys per call, from a **cursor persisted in `__win:blobs`**
    (written by compare-and-set), so successive lease holders and
    `sweepBlobs()` calls continue where the last stopped. At the end of the
    prefix the cursor **wraps** to the start.
  - **What it checks.** For each key `K`, it reads the record named by `K`'s
    id segment: a job, or on a dead-letter queue, a letter.

  | Record state | Decision | Why that clock |
  |---|---|---|
  | a job whose pointer is `K` | keep | — |
  | `K` is held (`__win:blobhold:<sha256(K)>` in this queue's state, `until` not passed) | keep, and retry the letter's copy | a `copyFailed` letter still needs it (above); the hold expires at `until` |
  | a letter whose `data.dataRef.key` is `K` | keep | the letter owns its copy |
  | a job whose data is anything else: another pointer `K'`, or inline data (`K` superseded) | delete `K` only when the record's **`opts.blobAt`** is older than `blobGrace` | `K` stopped being current when the flag was last written, not when `K` was. Counting from `K`'s own `lastModified` would delete a long-lived job's old blob the moment it was superseded, under a claim that had just read the old record. `blobAt` is stamped by the driver whatever the patch made the data (§4.3, rules) |
  | a job with no `opts.blobAt` (it was never offloaded, for example a lost add whose id already existed inline) | delete `K` when **`K`'s `lastModified`** is older than `blobGrace` | no flag write to time from |
  | no record | delete `K` when **`K`'s `lastModified`** is older than `blobGrace` | covers an `add` still in flight (blob written before record) and a removed job, which no claim can reach any more |

  `blobGrace` defaults to 1 hour.
- **No bucket lifecycle backstop.** The first draft suggested deleting after
  30 days. A lifecycle rule cannot tell referenced data from orphaned, and
  would delete data that is still in use:
  - delayed jobs due later than 30 days;
  - dead jobs, which are kept forever by default (`removeOnFail: false`,
    `queue/options.ts:209`);
  - dead letters.

  The README says not to set one, or to set it longer than any job may live.
- **Queues no worker sweeps.** The minute lease that would run the sweep is
  armed only in a worker's `#armMaintenance` (`BunQueueWorker.ts:158`,
  `:5254`, `:5291-5310`). A DLQ, or any producer-only queue, is never swept.
  So (b) adds **`queue.sweepBlobs({ limit })`** on `BunQueue`. It runs one
  bounded pass from the persisted cursor and returns `{ deleted, scanned,
  wrapped }`. The README shows it on a `BunRunner` schedule for such
  queues.

**Mixed configuration (N9).**

- **The marker.** The first offload in a queue writes a persisted marker,
  **`__win:blobs`**: the store kind and a fingerprint of its bucket and
  prefix.
- **Workers check the marker, at start and while running.**
  - A `BunQueueWorker` reads the marker at start. If it is there and the
    worker has no `blobs`, or a different fingerprint, the worker refuses
    to start with a `ConfigError`.
  - **Where the refusal sits.** Inside `run()`'s startup, after
    `ensureQueue` (`BunQueueWorker.ts:1545`) and **before**
    `#armMaintenance` (`:1585`) and `void this.#report()` (`:1592`). So
    `run()` rejects before the worker's first report: it writes no worker
    record, never claims a summon id (the claim happens inside `#report`,
    `:4965-4972`), and leaves no exit mark. That placement is what bounds a
    summon loop (README notes, below).
  - It **re-reads the marker on the `__win:jdef` cadence**, through a cache
    like the worker's `JobDefaultsCache` (`BunQueueWorker.ts:1234`), trusted
    for at most a second (`DEFAULT_JOB_DEFAULTS_REFRESH_MS`,
    `queue/jobDefaults.ts:67`) and consulted before each claim. That catches
    a marker written after the worker started.
  - It also guarantees that whichever worker holds the sweep lease has the
    store.
- **A worker that claims an offloaded job without the store** (inside that
  window) does not run the handler and **releases** the job: it neither
  fails it nor consumes an attempt. `attempts` defaults to 1
  (`DEFAULT_JOB_OPTIONS`, `queue/options.ts:202-210`), so an ordinary
  retryable failure would kill the job. A forced retry through `failJob`
  would not do either, even with a refund: `failJob` counts a failure
  (`memory-driver.ts:1056`), overwrites `failedReason` and `stacktrace`, and
  parks the job in `failed`, where failed lists and counts see it and
  `countDemand` counts a due failed job.
  - **Where the check runs.** At the top of `#process`
    (`BunQueueWorker.ts:2767`), before the heartbeat is armed (`:2808-2812`)
    and before the `active` emit and publish (`:2836-2837`). So subscribers
    never see `active` for it, and this path publishes no `failed`. (A
    worker **with** the store resolves the blob after the heartbeat is
    armed, so a slow `GET` keeps the lock.)
  - **What it does.** It calls a new optional driver method,
    **`releaseJob?(q, id, token, runAt, now)`**, with `runAt = now + 5 s`.
    It then gives back the limiter reservation itself: `attempt.reserved` and
    `#limiter?.release(record.name)`, which the path would otherwise skip,
    since it returns before `#process`'s `try` (`:2839`), whose `finally`
    (`:2898-2907`) does that. Then it **stops itself as an error, not as a
    close**.
  - **Why the stop needs care.** Today a worker's own stop reads as a
    success all the way up:
    - `run()` never rejects after start: `#stopped` is only ever resolved
      (`:1570`, `:1646`, `:2312`), and the JSDoc says it "Resolves when the
      loop has stopped" (`:1517-1525`);
    - the worker's close emits `closing` first (`:2002`), which a summoned
      unit's `#onClosing` (`summon/worker.ts:812-831`) takes for an owner's
      close, setting reason `closed`;
    - a later `#beginClose({ reason: "error" })` (`:745-757`) then returns
      early, because a reason is already set (`:1247-1249`), so the unit
      exits `closed`, code 0;
    - the claim's exit mark also says code 0, because the worker's close
      writes `{ reason: #exitMark?.reason ?? "closed", code: #exitMark?.code
      ?? 0 }` (`BunQueueWorker.ts:5178-5179`), and only `SET_EXIT_MARK`
      (`:4822`) sets `#exitMark`;
    - so the controller would count a proven success
      (`controller.ts:1531-1541`): `failures` reset, `lossStreak` deleted,
      and the circuit never fed.
  - **So the release path changes four things:**
    1. **It sets the worker's own `#exitMark = { reason: "error", code: 1 }`**
       before it closes, so the close writes code 1 into the claim's mark.
    2. **`runSummoned`'s `#onClosing` checks that mark** through a new
       read-only getter on the worker (`exitMark`). On an error mark it takes
       `#beginClose({ reason: "error" })` instead of the owner-close path,
       so the unit exits `error`, code 1 (`codeFor`, `:1515-1517`).
    3. **`run()` rethrows a stored error.** `#stopped` stays resolve-only,
       and cannot simply be rejected:
       - `close()` itself awaits it (`await this.#untilEscalated(this.#stopped.promise)`,
         `BunQueueWorker.ts:2127`), so rejecting it first would make
         `close()` throw;
       - after the close it is too late, because the loop has already
         resolved it (`:1570`, `:1646`, `:2312`).

       Instead the release path stores the `ConfigError` in a private
       **`#stopError`**. `run()` rethrows it after its await at both of its
       returns (`:1528` and `:1624`):
       `await this.#stopped.promise; if (this.#stopError) throw this.#stopError;`.
       This is a **contract change** to `run()`: it can now reject after
       start, and its JSDoc says so (§12).
    4. **Callers of `run()` handle the rejection** (below).
    5. **`runSummoned` logs it truthfully.** Its rejection handler
       (`summon/worker.ts:745-757`) logs "Summoned worker could not start"
       and sets `startFailed`. Harmless here, but misleading for a worker
       that was already ready. It checks `member.ready` and, for a ready
       worker, logs "Summoned worker stopped with an error" instead.
  - **The `run()` callers at `7e1841fe`:**

    | Caller | Today | Change |
    |---|---|---|
    | `BunJobs` (`BunJobs.ts:1192`) | `void worker.run()` | catches it, logs it, and emits `error` on the `BunJobs` |
    | the worker's `autorun` (`BunQueueWorker.ts:1273-1276`) | already `.catch(…#emitError…)` | none |
    | `runSummoned` (`summon/worker.ts:717`) | handles a rejection already | none beyond item 2 |
    | the playground (`playground/mailer.ts:70`, `scheduling.ts:511`, `simulation.ts:146`, `targets.ts:278`) | `void worker.run()` | none needed until the playground configures `blobs`; PR-S1's playground addition catches (bun-jobs-ui agent reviews) |
    | the examples (about 95 call sites in `examples/bun-jobs`, 33 in `examples/bun-jobs-ui`) | mostly `void worker.run()` | none needed: none configures `blobs`, so none can reach the release path. The (b) examples catch |
    | the bun-jobs README (8 snippets) | `worker.run()` | the snippet in the (b) section catches; the `run()` reference notes the new rejection |
    | bun-nest, templates | no worker `run()` calls | — |
  - **The contract, in all six drivers, with a contract case for each
    point:**
    - fenced on the token, like `failJob`;
    - **`runAt` must be later than `now`** (a contract error otherwise), so
      the job always goes back to **`delayed`**, **never `failed`**, and
      never straight to `waiting`. `promoteDelayed` then makes it ready at
      its ordinary position (priority, `createdAt`, id) and wakes waiters,
      as for any delayed job. A release straight to `waiting` would need its
      own wake on every driver, since Redis's `CLAIM` deletes the queue's
      wake key once it empties (`redis/scripts.ts:808`, in `CLAIM`). The
      worker's +5 s always satisfies the rule;
    - `attemptsMade` is decremented, undoing the claim's increment
      (`memory-driver.ts:978`);
    - no failure, throughput or metric count;
    - `failedReason`, `stacktrace` and `stalledCount` untouched;
    - the lock cleared (`lockToken`, `lockExpiresAt`, `workerId`), all in
      one atomic step.
  - **`processedOn` and `processedBy` keep the release's stamp** until the
    next claim overwrites both (`memory-driver.ts:979`, `:985`). Restoring
    them would need the claim to save the previous values. "Last claimed by
    the worker that released it" is also the true diagnostic, as it is for
    a stalled job (`driver.ts:2711-2714`).
  - **Why a method for the release, and a capability for `JobPatch.blob`.**
    The package gates two kinds of change two ways:
    - **New operations are optional methods**, probed by `driverImplements`
      (`api/routes/meta.ts:144`) and advertised through `DRIVER_FEATURES`
      (`:67`);
    - **new promises about existing methods' fields are declared
      capabilities.** The precedent is `capabilities.jobAttribution`
      (`driver.ts:69-87`): declaring it promises that the claim paths and
      `findJobs` honour the attribution fields, and `readApis.ts:193-197`
      trusts those fields only when it is declared.

    **The release is an operation.** It has its own fence, its own state
    transition and its own result. As a `FailOutcome` field it would be
    neither: a driver written before it would read `{ retry: true }` and run
    an ordinary `failJob`, with all the bookkeeping above. A field could be
    gated by a capability too, but a separate method keeps `failJob`'s
    contract unchanged, and a missing method fails loudly at the call.

    **`JobPatch.blob` and its `blob: false` default are a promise about
    `updateJob`'s fields**, the `jobAttribution` case exactly. So (b) gates
    them on a **declared capability, `capabilities.blobData?: true`**. A
    driver that declares it promises:
    - `JobPatch.blob`, with the `opts.blobAt` stamp;
    - the `blob: false` default;
    - the overlay reads.

    **`blobs` requires both** `capabilities.blobData` and `releaseJob?`:
    `BunJobs`, or a queue or worker given `blobs`, refuses with a
    `ConfigError` a driver without either. The management API reports it as
    `features.blobData`, wired exactly like `jobAttribution`:
    - an empty `DRIVER_FEATURES.blobData` entry, with `probeFeatures` reading
      the capability (`api/routes/meta.ts:92-96`, `:182-185`);
    - a `supportsBlobData(driver)` that checks `=== true`, like
      `supportsJobAttribution` (`:139-141`);
    - the two `s.boolean()` fields in `api/schemas/meta.ts` (beside
      `jobAttribution` at `:21` and `:213`);
    - the two contract DTO fields that match them, both `boolean`:
      **`DriverCapabilitiesDto.blobData`**, beside `jobAttribution` at
      `api/contract/types.ts:3844` (interface at `:3829`); and
      **`MetaDto.features.blobData`**, in `MetaDto.features` (`:3909`)
      beside `jobAttribution` at `:3983`, which bun-jobs-ui reads.

    It is typed `boolean`, not `?: true`.
  - **It cannot loop.** Only a worker that started before the marker existed,
    or within its ≤ 1 s cache window, can claim such a job. It releases what
    it holds and stops, and on restart it refuses at start. So each
    store-less worker process releases **at most its concurrency** (the
    claims in flight at once, `concurrency`, `queue/types.ts:1023`).
  - **Why not leave it to the stalled sweep** (stop without settling)? The
    sweep waits out the lock (30 s by default) and counts a stall. Past
    `maxStalledCount` it buries the job (`recoverStalled`,
    `driver.ts:2711-2728`), and the default is 1 (`DEFAULT_MAX_STALLED`,
    `shared/constants.ts:141`). That breaks "never dead-letters".
- **Moving the store** (a new bucket or prefix) is explicit:
  - deploy every process with the new store, configured with
    **`blobs.previous`** set to the old one, so pointers written before the
    move still resolve;
  - then call **`queue.resetBlobMarker()`**, which rewrites `__win:blobs`
    with the new fingerprint by compare-and-set.

  Old pointers keep resolving through `previous` until their jobs are
  removed and swept. A worker still on the old store then refuses, as
  above.
- **Readers without the store.** A `BunQueue` without `blobs` still reads
  flagged jobs: `job.data` throws `BlobNotLoadedError`, naming the missing
  option. The API reports `dataOffloaded: true`, and its data route (below)
  answers "not configured".

**Executors (N8).**

- **Thread, child process and container.** The host resolves the blob
  before dispatch:
  - the runner target passes the whole record (`queue/workerTarget.ts:872`);
  - it is serialised into the start message (`runner/executors/spawn.ts:490-517`);
  - by `postMessage` to a thread, over JSON IPC to a child
    (`spawn.ts:171`), or as frames to a container
    (`runner/bootstrap/container-frames.ts:34-53`);
  - **none of those paths has a size cap**;
  - a child has no driver access in any case (its job channel offers log,
    heartbeat and children reads only, `runner/bootstrap/child-runtime.ts:497-509`).
- **Remote.** This package has only the **executor** side:
  - the executor caps a request body at **`maxBodyBytes`**, 1 MiB by
    default (`remote/executor/executor.ts:81`, `:319`);
  - `readBounded` (`remote/executor/http.ts:134`) throws
    `RemoteMessageTooLargeError` (`shared/errors.ts:520`), answered as
    **413 `TOO_LARGE`** (`remote/executor/executor.ts:845`);
  - `maxMessageBytes` is only the hello field (`remote/types.ts:561`) and
    the API's WebSocket frame cap; it does not bound the job envelope;
  - there is **no remote dispatcher** in bun-jobs today: nothing outside
    `lib/remote` imports it.
- **Who would send a presigned URL.** Whoever builds the dispatcher (the
  gateway work of [`worker-gateway-and-isolation.md`](../worker-runtimes/worker-gateway-and-isolation.md))
  owns this decision, and (b) records the contract for them:
  - for an offloaded job, send `dataRef: { url, sha256, size }` instead of
    `data`, where `url` is a short-lived presigned `GET` from `s3Blobs`
    (Bun's `S3Client.presign`, measured in
    [`evidence/results-s3-wire.txt`](evidence/results-s3-wire.txt));
  - the executor fetches and verifies;
  - with `fileBlobs`, which cannot presign, the host resolves, and the
    1 MiB cap applies.
  - **PR-S1 changes nothing under `lib/remote`.**

**API and UI (N11).**

- **Options.** `toJobOptionsDto` (`api/serialize.ts:205-211`) passes `opts`
  through verbatim, so it must **strip `blob` and `blobAt`** (§12).
- **The job DTO** gains `dataOffloaded` and `dataBytes`. `include=data`
  (`api/contract/constants.ts:223-228`) returns the pointer for an offloaded
  job, never the bytes.
- **A new route, `GET /queues/:queue/jobs/:id/data`**, following `getJob`'s
  path (`api/routes/jobs.ts:456`), with a new opt-in action,
  **`jobs.readData`** (added to `JOBS_API_ACTIONS` and
  `JOBS_API_OPT_IN_ACTIONS`, `api/contract/constants.ts:19`, `:158-169`).
  - **Opt-in because** it can stream data far larger than any other
    response.
  - **A read, so `readOnly` keeps it** when `actions` names it. It is not in
    `JOBS_API_MUTATIONS` (`constants.ts:77-89`), the rule `providers.read`
    follows (`:150-156`).
  - **The opt-in set grows from nine actions to ten**, so the sentence
    "Nine actions are opt-in" in
    `examples/bun-jobs-ui/04-screens/permissions.ts:143` changes with it
    (EX covers it).
  - **Where nothing is offloaded,** it returns inline data too, so clients
    have one way to fetch data.
- **`PATCH /queues/:queue/jobs/:id`** (`api/routes/jobs.ts:632`, body
  capped by `maxJobDataBytes`, `api/config.ts:272`) goes through
  `BunQueue.update`, so through its read and `planData`. A body whose `data`
  deep-equals the pointer **in the record that read returned** is refused
  with 409, so a pointer can never be written back as data.
- **The UI.**
  - `UpdateJobDialog` pre-fills its editor from `job.data`
    (`packages/bun-jobs-ui/app/screens/job/UpdateJobDialog.tsx:46-48`).
  - For an offloaded job, it fetches through the new route when the user
    has `jobs.readData`. Otherwise it opens read-only: "data stored in the
    blob store".
  - The job screen shows the size and a fetch button.
  - **This changes the parsed README table** ("What each element needs",
    `packages/bun-jobs-ui/README.md:342`; for example the "Job Edit" row at
    `:419`), which `examples/bun-jobs-ui/04-screens/permissions.ts` reads.
    So UI-S1 goes to the examples agent before it merges.

**README notes for (b).** Besides those named above (no lifecycle rule;
`toJSON()` carries the pointer; re-driving a letter reads `dataRef`; the
`removeOnFail` interaction and the 7-day `copyHold`), the README says:

- **Summoned units need the store too.** A summoned unit starts fresh, so
  once a queue's `__win:blobs` marker exists, a unit without `blobs` is
  refused. [S, `summon/controller.ts` and `summon/define.ts` read at
  `7e1841fe`]
  - **At start: the bounded case.** A summoned unit started without
    `blobs` refuses before its first report, so it never claims its summon
    id and writes no exit mark. The controller settles the attempt as lost
    once its `bootBudget` passes (180 s by default, `summon/define.ts:23`;
    the attempt's `until`, `controller.ts:1794`) and counts it as a
    failure (`controller.ts:1552-1572`, `#fail` at `:2328-2342`): the
    doubling backoff applies, and after `circuit.failures` losses (5 by
    default, `summon/types.ts:281-289`) the circuit opens. Each attempt
    still starts a unit, and none is reported as exited-with-error.
  - **Why the refusal must come before the first report.** A refusal after
    it, or a clean `close()`, would be unbounded:
    - the report wins the summon claim;
    - the exit mark would say code 0;
    - the attempt would then settle as registered or proven, which resets
      `failures` to 0 (`controller.ts:1541`) and deletes `lossStreak`
      (`:1536`);
    - so the controller could re-summon every `cooldown` (10 s by default),
      without bound.

    Hence the start-time refusal's placement (Mixed configuration, above).
  - **In flight (the release path).** A unit that has started, reported and
    claimed a job before the marker appeared releases the job. It sets its
    exit mark to `{ reason: "error", code: 1 }` before closing, and
    `runSummoned`'s `#onClosing` sees that mark and closes the unit as
    `error` rather than as an owner close. So the claim's exit mark and the
    process both say code 1 (`codeFor`, `summon/worker.ts:1515-1517`).
    Without those two steps the stop would exit `closed`, code 0, and the
    controller would count a proven success (§4.3, Mixed configuration).
    For the controller, code 1 counts only as a **late loss** (`#failLate`,
    `controller.ts:2380`), and only while the attempt is still watched; it
    does not reset anything. This path is rare: only inside the marker's
    ≤ 1 s cache window.
  - **What to do:** configure `blobs` in the code the summoned unit runs,
    the same store as the queue's. The refusal's message names the marker
    and says so.

**Guarantees.** Every queue guarantee is unchanged: claims, leases and
settles do not touch S3. The changes are these:

- **`JobPatch.blob`**, a driver change in six drivers, with contract cases;
- **a new failure mode**: an unreadable blob fails an attempt, and a
  missing one dead-letters it at once;
- **a refusal**, at start or on the marker's re-read, for workers missing
  the store, and for `blobs` on a driver without `releaseJob?`;
- **one extra record read per data patch**, only when `blobs` is
  configured.

**S3 features used:** `write`, `file().bytes()`, `delete`, `list` and
`presign`. **No conditional writes, so every S3-compatible store works.**

**Effort: about 16 to 19.5 days**, against the owner's 11 to 14. Most of the
difference is `JobPatch.blob`, which costs about 2.75 days on its own once
counted per driver. The round-4 fixes (R1 to R4) add about 1 day, and the
copy holds and `releaseJob?` (rounds 5 and 6) about 1.5, and round 8's error
exit and API wiring about 0.5.

| Part | Estimate |
|---|---|
| `planData` and the write sites, with the repeat rule | 1.5 d |
| `JobPatch.blob` across six drivers, with the `blob: false` default and contract cases | 2.75 d |
| the `Job` read model: getter, `loadData()`, hooks through eight construction sites | 1.5 d |
| worker resolution, the re-read and the error mapping | 1 d |
| dead letters (`dataRef`, copy, missing) | 1 d |
| the sweep (grace by `at`) and `sweepBlobs()` | 1.5 d |
| API: DTO, route, action, `PATCH` guard | 1.5 d |
| the `__win:blobs` marker and the refusal | 0.5 d |
| `s3Blobs` and `fileBlobs` | 1 d |
| the suites on every backend (§6.2) | 2 d |
| README | 0.5 d |
| round 4: the read on every data patch and the `blobAt` stamp (R1), the marker re-read and in-flight refusal (R2), the persisted cursor (R3), `BunQueueWorkerOptions.blobs` (R4) | 0.5–1 d |
| rounds 5 and 6: the copy holds, their letter check and retry (M2, 0.75 d); `releaseJob?` in six drivers with its contract cases, and the worker's early check (L1, 0.75 d); M1's `blob: false` default is in the `JobPatch.blob` row above | 1.5 d |
| round 8: the error exit mark, `#onClosing`'s check, the rejecting `run()` and `BunJobs`'s catch, with the summoned-unit test; `features.blobData` through the API | 0.5 d |
| **Total** | **≈ 17.25–17.75 d** |

### 4.4 (c) S3 as an archive for finished jobs [D]

```ts
new BunJobs({ driver, archive: s3Archive({ client, after: "7d", format: "ndjson.zst" }) });
```

**Scope: jobs only. Event export is descoped (N10).**

- **The contract says events are not an audit trail.** They are "a live
  notification channel rather than an audit trail" (`driver.ts:2856-2858`).
- **Retention is per namespace; the archive mark would be per queue.**
  Event retention is **one setting per driver instance**, `eventRetentionMs`
  (`shared/eventRetention.ts:21`). Its sweep is tracked **per namespace**
  (`#swept`, `:33`; `due(ns)`, `:50-63`), and it runs inside `publish`.
  Storage, by contrast, is per channel, that is per queue. A per-queue mark
  therefore cannot hold a per-namespace prune.
- **`cleanEvents` is declared on the exported `QueueDriver`**
  (`driver.ts:2862`), but nothing outside the drivers calls it: no
  `BunJobs`, `BunQueue` or API path cleans events, so there is no caller-side
  place to hold it.
- **No driver reads stored events back.** SQL's serial `seq` read as a
  cursor would skip a late-committing lower `seq`, which is exactly what
  `EventGaps` exists for. So an event reader would need its own lag window.

A later plan can take events on with those four problems named. Job records
already carry each job's outcome.

**Why it needs driver changes.** Three of retention's four paths run
**inside** the drivers:

- `pruneExpired` (`driver.ts:2756`);
- the settle-time count sweep (`sql/sql-driver.ts:770-786`, and its
  equivalents in the other drivers);
- TTL-based `removeOnComplete`, whose default is `{ ttl: 24 h }`
  (`queue/options.ts:202-210`; `shared/constants.ts:150`).

**`removeOnComplete: true`** deletes at settle by design
(`sql/sql-driver.ts:3247-3253`): such jobs are never archived, and the
README says so.

**The hold comes from the persisted entry, not from process configuration
(N9).**

- **Where the mark lives.** `__win:archive` holds the queue's committed mark.
  It is written by compare-and-set, and only ever increases.
- **Drivers read it themselves.** A new optional driver capability,
  **`archiveHold?`**, makes the driver's own retention read the entry in the
  same step as the delete:
  - SQL: `AND finished_on <= (SELECT … FROM kv …)`;
  - Redis: an `HGET` inside the Lua script;
  - MongoDB: a read, then a delete filtered on the mark;
  - file and memory: a read under the hold.
- **Every process honours it.** A process **without** the `archive` option
  still keeps every unarchived job. If the entry exists but has no mark yet
  (the archiver has not run), **everything is held**.
- **Dead jobs.** `removeOnFail: false` is the default (`queue/options.ts:209`),
  so dead jobs are kept forever unless configured. The archive copies them
  and keeps them unless `removeOnFail` says otherwise (§10 Q4).
- **Paging.** `listJobs` pages by offset (`driver.ts:2343-2347`), which
  shifts under deletes, and `completed` and `dead` are read separately. The
  archive reads each state with a **keyset cursor on `(finishedOn, id)`**,
  through `findJobs` where a driver has it (`:2399`), and a new optional
  keyset read where it does not.
- **A lag window.** `finishedOn` is each worker's clock. The mark only
  advances to `now − lagWindow`, by default 5 minutes, longer than the lock
  duration plus clock skew. A late or skewed commit is therefore still
  archived.
- **Who runs it.** The minute-lease holder (`__win:msweep`), and also
  `queue.archiveNow({ limit })` for queues no worker serves (the gap
  described in §4.3).
- **Batches.** Up to 1,000 jobs or 8 MiB, under
  `archive/<ns>/<queue>/<state>/<yyyy>/<mm>/<dd>/<firstFinished>-<lastFinished>-<firstId>.ndjson.zst`.
  The key is deterministic, so a re-run after a crash rewrites the same
  object. Readers dedupe by id.
- **Reading back.** `archive.list({ queue, state, from, to })` and
  `archive.read(key)`. The UI's archive browser is a later bun-jobs-ui PR.

- **A driver without the hold is refused.** `BunJobs` with `archive`
  configured refuses to start, with a `ConfigError`, on a driver
  (including a custom one) that does not implement `archiveHold?`.
  Archiving without the hold would race retention, so the refusal comes
  before the first job is lost unarchived.
- **Count retention can overshoot.** A `removeOnComplete: { count: N }`
  queue can hold more than N finished jobs while the newest wait for the
  mark, by up to the jobs finished within `lagWindow` (plus any backlog the
  archiver has not reached). The README says so.

**Guarantees.** Unchanged for the queue. With the hold, retention removes a
finished job only after it is archived. Deliberate deletions are not
archived: `removeJob`, `cleanJobs`, `drainQueue` and `purge`.

**Effort: about 9 to 11 days**, against the owner's 10 to 12 days, which
included event export. Descoping it removes `readEvents?`, the event hold
and its lag window.

| Part | Estimate |
|---|---|
| `archiveHold?` in six drivers (SQL ×4 dialects 1.5, Redis Lua 1, MongoDB 0.75, file and memory 0.75), with contract cases | 4 d |
| keyset reads | 1.5 d |
| the writer, the reader, batching, zstd | 2 d |
| the mark and the lag window | 0.5 d |
| `archiveNow()` and the suites | 1.5 d |
| README | 0.5 d |
| **Total** | **≈ 10 d** |

### 4.5 (d) A hybrid: compare-and-set elsewhere, storage on S3 [D]

The idea is that records and indexes live on S3, while claims, leases and
queue state live in a service that has atomic operations (Redis, Postgres).

On inspection, it collapses into (b):

- **The claim path still touches both.** Read the index, claim on Redis, read
  the record from S3, write it back. That is more requests than either
  backend alone.
- **The claim, the lease and the state record are most of what a job record
  is.** Once they live in Redis or Postgres, so does the record. What is
  left for S3 is the payload, which is (b).
- **Two backends double the failure modes**, and nothing guarantees a
  consistent snapshot across them.

**Verdict: no separate design.** (b) is the hybrid worth having.

### 4.6 (e) Not doing it

The case for building nothing:

- **Every bun-jobs user already has a database with atomic operations**:
  SQLite needs nothing but a file.
- **S3 as a queue is slow and expensive at queue rates** (§5).
- **Conditional-write support varies across S3-compatible stores**, and a
  store that silently ignores the headers would **double-run jobs**
  (§3.3, §9).

The case against building nothing: (b0), (b) and (c) fix real gaps today
(no size limit on job data, no offload, no archive) without touching a queue
guarantee. (b0) alone costs 1.5 to 2 days.

---

## 5. Latency, throughput and cost per design

### 5.1 Latency on the job's path [I, from §3.4 and M]

The figures below use S3 Standard's documented "100–200 ms" for small
objects, and the one third-party run (`PUT` p50 70 ms, `GET` p50 26 ms).
There is no published `LIST` figure, so it is assumed to be about 50 ms [U].

| Design | Added to `add()` | Added between "job is ready" and "handler starts" | On S3 Express |
|---|---|---|---|
| (a) | 3 `PUT`s: record, marker, wake. About 140 ms before the job is visible to `LIST` | Notice (p50 86 ms at a 250 ms poll [M `pickup-poll.ts`, corrected run]), then the claim: the pause read (`GET`, about 26 ms, absorbed by the 250 ms `PauseCache` under load) + `LIST` + `GET` + create-once `PUT` + `If-Match` `PUT`, five serial requests, about 240 ms p50. **About 330 ms p50 from the measured notice, or about 370 ms analytically** (a uniform arrival waits P/2 = 125 ms at a 250 ms poll, plus the `HEAD`; the measured 86 ms, n = 25 on a loaded machine, is below that, so the analytic figure is the safer headline). **Roughly 0.5 to 1 s at p99** | Claim ≈ 5 × single-digit ms; pickup still bound by the poll interval |
| (b0) | one size check on the JSON already produced | none | — |
| (b) | One `PUT` of the payload, only for offloaded data (about 70 ms plus transfer) | One `GET` of the payload (about 26 ms plus transfer) | — |
| (c) | none | none (background) | — |
| Today, Postgres | one `INSERT` with `pg_notify` | `LISTEN` wake (p50 0.14 ms, [bun-cache evidence](evidence/results-pg-listen.txt)) + one claim statement | — |

### 5.2 Polling: pickup latency against cost [M]

S3 has no notification. A waiter can only poll, and every poll is a billed
request. Measured on loopback MinIO [M `pickup-poll.ts`], with costs from
[M `cost-model.ts`]:

| Wait poll interval | Notice latency p50 / max | `HEAD`/s per idle waiter | One idle worker per 30 days, defaults, on S3 Standard / Express / R2 |
|---|---|---|---|
| 25 ms (the file driver's floor, `file-driver.ts:222`) | 25 / 57 ms | 27.7 | $71 / $11 / $64 |
| 100 ms | 66 / 129 ms | 9.5 | $52 / $10 / $47 |
| 250 ms | 86 / 257 ms | 3.8 | $46 / $9.6 / $41 |
| 1000 ms (bun-jobs' `pollInterval`, `shared/constants.ts:144`) | 495 / 995 ms | 1.0 | $43 / $9.4 / $39 |

*Corrected after review.* The first run counted each sample's baseline
`stat` as a waiter's poll and divided by total time, overstating `HEAD`/s by
1.5 to 2× ($91 rather than $71 at 25 ms). `pickup-poll.ts` now counts only
the polling loop's requests over the polling time. The loopback notice
latencies are noisy on a shared machine: the 250 ms row's p50 came in below
its 100 ms row's in this run.

**The idle cost has a floor of about $42 a month per worker** on S3 Standard
($38 on R2, $9.3 on Express), whatever the wait-poll interval
[M `cost-model.ts`]. It is made of:

- `promoteDelayed` 1/s on every worker (`queue/BunQueueWorker.ts:404-405`),
  at 2 `LIST`s per run (the delayed and failed indexes): $26;
- the claim attempt's `LIST` before each wait, 1/s at the default
  `pollInterval`: $13;
- the pause read (1/s), the worker registry (a `PUT` and a `LIST` every
  10 s), and the sweep leases (reads every 30 s and 60 s, plus the holder's
  renewals): about $3.

A driver would have to cache `nextDelayedAt` and list only when something is
due, which is a change to the driver, and a correctness risk if a producer in
another process adds an earlier job.

**On top of the floor, per idle worker per month on S3 Standard**
[M `cost-model.ts`]:

| Add-on | Cost | Source |
|---|---|---|
| Any **polled subscription**: a queue that `subscribe`s (`BunQueue.ts:538`), a summon controller's events trigger (`summon/controller.ts:1242-1248`), or worker control with `subscribe: true` (`BunQueueWorker.ts:4351-4353`), each a `LIST` of an event prefix every 250 ms | **+$52 each** | On a polling driver, worker control's subscription is off by default (`BunQueueWorker.ts:1197-1207`), but a queue or summon subscription is the user's choice |
| Worker control on (`control ?? false`): a `GET` of `__win:wchg` every 2 s | +$0.52 | `BunQueueWorker.ts:486` |
| A summon controller's check every 30 s (`countDemand`: 3 `LIST`s) | +$1.30 | `summon/types.ts:249` |

**Ten idle workers on S3 Standard therefore cost about $430 to $1,000 a month
before any job runs**, depending on the poll interval and subscriptions. A
small managed Postgres costs less than that, and answers in under a
millisecond [I].

### 5.3 Hot objects: the real throughput limit of (a) [M, W]

**One object under compare-and-swap is serialised:** every commit is a `GET`
plus a conditional `PUT`, and losers retry. The measured single-object
ceilings on loopback were 4 to 269 commits/s, with up to 12.8 attempts per
commit [M `conditional-writes.ts`]. On S3 Standard, at about 100 ms a round
trip, that is **roughly 5 to 10 commits/s per object** before retries
[I]. On R2 and GCS it is **one write per second per key**, by documented
limit [W].

**What lives on a hot object in bun-jobs:**

- **The `limiter`** (rate and concurrency limits): compare-and-swap on every
  reservation and commit (`queue/limits.ts:86`, `:683-695`). **With limits
  set, a queue on S3 tops out near 5 claims/s on Standard and 1/s on R2**
  [I].
- **A summon group's shared budget** (`summon-multi-queue.md` §3.4), charged
  on every summon.
- **Runner state** (`setState`, `incrementCounters`): every run of a runner.
- **The `wake` object**, written on every `add`. On R2 that must coalesce to
  one write per second per queue.
- **On R2 and GCS, every job record.** Claim and settle are two writes to
  one key, so **a job shorter than 1 s gets a 429 on its settle**. It must
  wait out the second, which adds up to 1 s per short job.

**Without limits, claims shard across job objects** and are bounded by the
per-prefix rate: at about 9.5 writes per job, 3,500 writes/s is roughly 370
jobs/s per prefix, before S3 scales the prefix [I]. The prototype reached 59
to 509 jobs/s on loopback, with 16 workers costing 1.5 `LIST`s and 0.3 lost
claim races per job [M `claim-proto.ts`].

### 5.4 Cost per million jobs [M `cost-model.ts`, prices W]

Requests only. Storage is negligible for queue metadata (4 GB is about $0.09
a month on Standard).

| Design | Writes / reads per job | S3 Standard | S3 Express | R2 | B2 |
|---|---|---|---|---|---|
| (a) full driver, short job, no events (incl. a pause read per claim) | 9.5 / 2 | **$48.30** | $10.79 | $43.47 | $0 (but B2 rejects `If-None-Match`) |
| (a) with events on and one heartbeat | 13.5 / 6 | $69.90 | $15.44 | $62.91 | — |
| (b0) `maxDataBytes` | 0 / 0 | **$0** | — | — | — |
| (b) data offloaded | 1 / 1 (+ the sweep's `LIST` pages, amortised) | **$5.40** per million *offloaded* jobs | $1.16 | $4.86 | $0 |
| (c) archive, batches of 1,000 | 0.001 / 0 | **$0.005** | $0.001 | $0.005 | $0 |

The "data and result offloaded" row of the first draft is gone: result
offload is out of scope (§4.3).

Add the idle floor of §5.2 for (a), about $42 a month per worker on S3 Standard. For (b), the cost falls only on jobs
large enough to offload, and buys smaller rows in the queue's own database.
(c) costs nothing per job; its cost is storage, about $0.023 per GB-month
on Standard, for an audit trail that does not exist today.

---

## 6. The conformance kit: what each design passes

**The suite.** The shared driver contract has 209 cases
(`__tests__/helpers/driverContract.ts`), run by six drivers. Its own
concurrency cases are:

- parallel `addJobs` on a shared id (`:2371-2402`);
- claim-once (`:2497`);
- fencing (`:2866`, `:3114`, `:3263`, `:3908`);
- a compare-and-set race (`:4607-4611`);
- eight parallel compare-and-pop contenders (`:642-655`).

**How the suite treats optional methods** (corrected after the bun-jobs
agent's review) [S]:

- **Several groups already gate themselves.**
  - Analytics returns early when the driver has none of the metric methods
    (`analytics()` is `undefined`; `driverContract.ts:1150-1172`,
    `:1209-1212`).
  - Attribution is opted out by name when `capabilities.jobAttribution` is
    absent (`:7486`, with the capability check at `:7503`; `:7582`; `:7624`; with `!driver.claimJobs`).
  - `cleanEvents` is gated (`:5688`).
- **Run logs are asserted present on purpose.** "A missing one is a driver
  that is not finished, not a driver that opted out" (`:733-738`).
- **The rest use `!`.** `recordChild` 28 times, `setQueueState` 18,
  `buryJob` 14, `getQueueState` 13 and `updateJob` 9. A driver that leaves
  those features out fails their cases instead of skipping them.

The owner would accept a helper that gates each remaining feature group on
`driverImplements` (`api/routes/meta.ts:144`), all-or-nothing per group, with
a **visible** skip (`it.skipIf`). **It is not needed until a driver omits
methods.** (b0), (b) and (c) add no driver that does, so none of the
scheduled PRs needs it; design (a) would.

### 6.1 Design (a) [I unless marked]

| Contract group (lines, cases) | Under (a) | Why |
|---|---|---|
| lifecycle, discovery and purge (`:237`, `:10466`; 6) | pass | `purge` is a `LIST` and `DELETE` of the namespace prefix |
| locks (`:246-343`; 6) | pass | `If-None-Match` to acquire, `If-Match` to renew and release |
| runner state, incl. `popQueuedTriggerIf` with 8 contenders (`:347-722`; 14) | pass on AWS; **429s on R2** | compare-and-swap on one runner object, the hot-object case |
| run logs (`:726-1086`; 11) | pass, slowly | append becomes read-modify-write under compare-and-swap |
| analytics and grouped reads (`:1090-2335`; 20) | pass, or leave out | per-writer minute objects merged on read; costly. Leaving them out already skips the group (`analytics()` undefined, `:1209-1212`) |
| jobs (`:2339-4712`; 52) | pass, including the races, **if** §4.1's claim rules hold | create-once add (measured), claim-once (measured), `If-Match` fencing (measured), compare-and-set race (measured). The pause case (`:3502`), the `excludeNames` pile case (`:4316-4383`), retry with `resetAttempts`, and id reuse are **not** exercised by the prototype; they depend on the pause read, the name-carrying index keys and the incarnation-plus-counter claim keys |
| flows (`:4716-5637`; 18) | **at risk** | `recordChild` reads the child outside the parent's compare-and-swap (§2.2); the stale-child cases may fail |
| waiting and events (`:5641-5838`; 6) | pass at a production poll interval (corrected) | the wake case gives `waitForJob` a 2,000 ms budget (`:5648`), and the timeout case asserts a **lower** bound of 40 ms on a 60 ms wait (`:5667`), so a 250 ms poll passes both. The subscriber cases use `waitFor` with its own timeout. `cleanEvents` is gated (`:5688`) |
| `countDemand` (`:5916-6528`; 14), read APIs (`:6532-7420`; 16), attribution (`:7422-8503`; 15), creation time (`:8505-9147`; 8) | pass, with `LIST` scans | linear in the number of jobs |
| worker control entries (`:5842-5910`; 1) | pass | compare-and-swap per entry |
| clearing logs, run history, job-defaults rewrite (`:9149-10464`; 22) | pass | compare-and-swap per record |
| cross-process suites (`queue-crossprocess.test.ts`, `runner-crossprocess.test.ts`) | pass | exactly-once across processes is what `claim-proto.ts` measured in one process with 16 concurrent workers; across processes it is [I] |

### 6.2 Designs (b0), (b) and (c)

**Which designs change drivers.**

- **(b0) changes no driver.**
- **(b) adds `JobPatch.blob`** to `updateJob` in all six drivers.
- **(c) adds the optional `archiveHold?`.**

Their contract cases gate on the method or field's presence, all-or-nothing,
with a visible skip.

**New contract cases:**

- **(b) `JobPatch.blob`:**
  - the flag and `opts.blobAt` (= the call's `now`) change in the same step
    as `data`, for `blob: true` and `blob: false`;
  - **a data patch with no `blob` field on a flagged record** clears the
    flag and stamps `blobAt`, as a store-less writer's patch must;
  - **`releaseJob?`**: with the token, the job goes to `delayed`, never
    `failed` or `waiting`, and a `runAt` not later than `now` is refused. `attemptsMade` is one lower than
    after the claim. The failed count and throughput metrics are unchanged.
    `failedReason`, `stacktrace` and `stalledCount` are unchanged. The lock
    and `workerId` are cleared, and `processedOn` and `processedBy` keep the
    release's stamp. Without the token it changes nothing;
  - a priority patch on an offloaded job keeps both;
  - `rewritePendingOptions` leaves both alone;
  - on MongoDB and Redis, the overlay fields read back through `getJob`,
    `listJobs` and `findJobs`, and a MongoDB data patch is one
    `findOneAndUpdate` (no `PATCH_RETRIES` path).
- **(c) `archiveHold?`:** a finished job above the mark survives
  `pruneExpired`, the count sweep and TTL `removeOnComplete`, and goes once
  the mark passes it. An entry with no mark holds everything. `BunJobs` with
  `archive` refuses a driver without `archiveHold?`.

**Each feature's own suite, run against every backend:**

- **(b0):**
  - the limit refuses on every checked site of §4.2: `#buildRecord` (add,
    `addBulk`, the first repeat occurrence, flow nodes, a debounce window),
    `Job.updateData`, `Job.update`, `BunQueue.update`, and a debounce
    replacement;
  - the size is UTF-8 bytes (a multi-byte string over the limit by bytes but
    not by `.length` is refused);
  - one stringify (a spy on `JSON.stringify` counts one call);
  - no limit means no check;
  - a dead letter of an over-limit job is still written: the DLQ pin;
  - the worker's next repeat occurrence is not refused after the limit is
    lowered.
- **(b):**
  - round-trips above and below the threshold through every write site;
  - **repeats stay inline**: a repeat definition, its occurrences, and an
    over-threshold `updateData` on an occurrence all stay inline, and the
    one-time warning fires once per repeat key;
  - **every data patch reads the record** when `blobs` is configured:
    `BunQueue.update`, the debounce patch, and `Job.#update` with a stale
    `#record` (a small patch to a job offloaded since the view was built is
    offloaded);
  - **a concurrent patch that leaves the record inline**: its superseded key
    is timed by the record's `opts.blobAt`, and is deleted only after the
    grace;
  - a 404 after a concurrent patch follows the new pointer;
  - a 404 on the current pointer, and a hash mismatch, each dead-letter at
    once (`UnrecoverableJobError`); a transport error is retried;
  - the grace sweep, one case per row of its table:
    - a superseded key survives until the record's `opts.blobAt` is past the
      grace, whether the record now holds another pointer or inline data;
    - a key whose record has no `blobAt`, or no record, survives until its
      own `lastModified` is past the grace;
    - a key still referenced, by a job's pointer or by a letter's
      `data.dataRef.key`, is never deleted;
    - the cursor persists across calls and wraps at the end;
  - `add` racing `removeJob` on one id leaves no dangling pointer;
  - dead letters:
    - an offloaded job's letter carries a copied `dataRef`, which survives
      the original's removal;
    - a job that died of a missing blob carries `dataRef.missing`;
    - a copy that hits 5xx past its retries files `copyFailed`, never
      `missing`, and writes a `__win:blobhold:` entry in the source queue;
    - with `removeOnFail: true`, the source job is gone, yet the source
      sweep (or `sweepBlobs()` on the source queue) keeps the held key past
      its grace and completes the copy, patching the letter and deleting the
      hold;
    - a hold whose letter has been removed is deleted without a copy, and
      the key falls back to its ordinary rows;
    - two sweeps completing one hold at once leave one referenced copy; the
      other copy is swept as an orphan;
    - an expired hold no longer protects the key, and the sweep deletes the
      expired entry;
    - a letter filed through `Job`'s bury path (`fileBuriedLetter`) uses the
      `Job`'s store;
  - a worker without `blobs`, on a queue whose `__win:blobs` exists, refuses
    to start;
  - its refusal comes before the first report: no worker record, no summon
    claim, no exit mark, and `run()` rejects;
  - one that sees the marker appear after starting does not run the
    handler. It releases the job (`releaseJob?`) before any `active` emit or
    publish, with no `failed` event, and gives its limiter reservation back:
    a limited queue's slot count returns to what it was. Its `run()`
    **rejects** with the `ConfigError` rather than resolving. With
    `attempts: 1` the job is not dead-lettered, and its `attemptsMade` is
    what it was before the claim;
  - in a summoned unit, the release path exits with code 1, **and** the
    claim's exit mark records code 1 with reason `error`, **and** a watching
    controller counts a late loss (`lossStreak` rises; `failures` is not
    reset). A process-exit check alone could pass by accident;
  - `run()` rejects only after the close has finished; `BunJobs` catches the
    rejection and emits `error`, with no unhandled rejection;
  - `blobs` on a driver without `capabilities.blobData` or without
    `releaseJob?` is refused with a `ConfigError`;
  - **a store-less producer's `queue.update` on an offloaded job** leaves a
    well-formed inline record that a reader with `blobs` reads as data, not
    as a pointer;
  - `resetBlobMarker()` with `blobs.previous` keeps old pointers resolving;
  - `job.data` on an unloaded offloaded job throws `BlobNotLoadedError`;
  - `getJob` resolves, and on a 404, a hash mismatch, a transport error or
    no store returns the job unresolved, with `BlobNotLoadedError.reason`
    set accordingly (it never throws);
  - lists do not resolve, and no internal `driver.getJob` path costs a `GET`;
  - a handler's `updateData(big)` returns a view with real data;
  - API:
    - `include=data` returns the pointer;
    - `GET /queues/:queue/jobs/:id/data` needs `jobs.readData`, and a
      `readOnly` API that names it keeps it;
    - a `PATCH` whose data deep-equals the pointer in the record its own read
      returned is refused with 409;
    - `opts` carries no `blob`;
  - `sweepBlobs()` on a producer-only queue.
- **(c):**
  - the hold, driven by the persisted entry, keeps unarchived jobs from a
    process **without** the `archive` option;
  - a late `finishedOn` inside the lag window is still archived;
  - a crash between write and mark re-archives the same key;
  - the mark only moves forward;
  - dead jobs are archived and kept unless `removeOnFail` says otherwise;
  - `removeOnComplete: true` jobs are not archived (documented);
  - `archiveNow()` on a queue with no worker;
  - `list` and `read` round-trip.

The (b) and (c) suites run against the file implementations and the S3 test
server.

---

## 7. Testing infrastructure

**MinIO is no longer a good default.**

- `minio/minio` and `quay.io/minio/minio` could not be pulled here on
  2026-10-10 (`pull access denied`, `unauthorized`) [M].
- The `minio/minio` repository is archived as "NO LONGER MAINTAINED", and
  its last community release lacks the conditional-write quorum fix [W,
  §3.3].
- [`bun-cache/README.md`](README.md) §13.2 (PR-C7) planned MinIO. **This plan
  supersedes that choice for both packages.** bun-cache's §13.2 already says
  SeaweedFS, since the amendment landed with #319 (`d5ec1050`).

**Recommended [D]:**

- **SeaweedFS**, pinned to **`chrislusf/seaweedfs:4.48`** (Apache-2.0), as
  the S3 test server for bun-jobs and bun-cache. In this plan's spikes it
  honoured every conditional header, including `DELETE` [M]. It went from
  `docker run` to answering a signed bucket-create in **3.8 to 6.0 s** over
  three rounds [M `seaweed-startup.ts`]. *The first draft said "about a
  second", with no evidence file behind it.*
- **Versity S3 Gateway** (`versity/versitygw`, 1.8.0, Apache-2.0) is an
  optional second server for the conditional cases of design (a) only,
  being a different implementation [M]. It is not needed for (b0), (b) or
  (c).

**Setup: it fits `scripts/setup-databases.ts` as it stands** [S]:

- **The path.** A plan entry with `dockerOnly`, the same path MySQL already
  takes (`dockerOnly` at `:881`; MySQL's entry at `:1994`, its `dockerOnly` at
  `:2015` and container `bun-jobs-mysql` at `:2018`, on 3307). It is `bun-jobs-s3` on `127.0.0.1:8333`, with
  the script's usual `--ulimit nofile=65536:65536`.
- **Readiness.** A signed bucket-create returning 200 or "already owned"
  defines it, within the plan entry's `readyTimeout` (60 s covers the
  measured 6 s with margin). It also creates the bucket, because Bun's
  `S3Client` has no method for that.
- **The snap Docker caveat does not apply here.** *Corrected after review:*
  the "pipe through `| cat`" advice is for a shell's captured output. The
  script's `run()` (`:389-414`) captures through `Bun.spawn` pipes, and the
  script uses no bind mounts, so there is no `/tmp` path for snap Docker to
  miss. The only rule is to keep it that way: no `/tmp` bind mount for the
  data. The same correction applies to [`bun-cache/README.md`](README.md) §13.2,
  edited to match.
- **Authentication.** SeaweedFS run as `server -s3`, with no identity
  configuration, accepted our signed requests [M]. That is acceptable for a
  test server bound to `127.0.0.1` only, and the script says so.
- **`--dry-run`** prints
  `BUN_JOBS_TEST_S3_URL=s3://test:test@127.0.0.1:8333/bun-jobs-test`.
  bun-cache's `BUN_CACHE_TEST_S3_URL` falls back to it, so one server serves
  both packages.
- **Tests** go in `scripts/__tests__/setup-databases.test.ts`, beside
  MySQL's.

**Owner, proposed:** the bun-jobs agent, since bun-jobs' suite is the first to
need the server. bun-cache's PR-C7 reuses it. `scripts/` is shared, so the
PR tells the agents whose suites use the script. This is not yet decided
(§10 Q8).

**The rules match the database suites:** unset means skipped, visibly; set
but unreachable means the suite fails, naming the backend
(`__tests__/helpers/backends.ts:101-147`). Each run uses a prefix carrying
its pid and timestamp, and deletes exactly that prefix.

**Real AWS, once, by hand.** The [U] items are:

- an unsigned conditional header on a presigned URL;
- the behaviour under real latency;
- the 409 `ConditionalRequestConflict` path.

A manual script, `BUN_JOBS_S3_AWS_URL=… bun …`, settles them against a
scratch bucket for a few cents. It is a prerequisite of any work on (a), not
of (b0), (b) or (c).

---

## 8. Measured evidence

All on Bun 1.4.3 (`bbdc5a519`), on the shared 16-thread laptop. Re-run each
with the command in
[`evidence/bun-jobs-s3-driver/README.md`](evidence/bun-jobs-s3-driver/README.md).

| Spike | Finding | Used in |
|---|---|---|
| `conditional-writes.ts` | **Bun's `S3Client` paths:** `write()` returns a byte count, with no ETag and no conditional headers; `text()` has no ETag; `stat()` and `list()` do. **On all four servers:** `If-None-Match` and `If-Match` on `PUT` are honoured both through a presigned URL plus an unsigned header and through hand-made SigV4. 32-way races have exactly one winner. A compare-and-swap counter loses nothing, at 4 to 269 commits/s. **MinIO 2025.5.24 ignores `If-Match` on `DELETE`.** The ETag is MD5 of the content. Loopback p50: `PUT` 1.5 to 14.7 ms, `GET` 0.7 to 1.1 ms, `LIST` 2.4 to 14.2 ms | §2.2, §3.1, §3.2, §5.3 |
| `claim-proto.ts` | **Through the presigned-URL path with the conditional header unsigned** ([U] on AWS), not the SigV4 path D5 recommends; claim keys `claims/<id>`; no pause, `excludeNames`, stall, retry, `resetAttempts` or id reuse. Claim-once on S3: 300 of 300 at 1, 4 and 16 workers, on MinIO and SeaweedFS. 59 to 509 jobs/s on loopback. Per job: `LIST` 1.0 to 1.5, create-once 1.0 to 1.3, `GET` 1, `If-Match` `PUT` 2, `DELETE` 1; `add` costs 2 create-once `PUT`s | §4.1, §5.3, §5.4, §6.1 |
| `pickup-poll.ts` (corrected run) | Notice latency p50 against poll interval: 25 ms at 25 ms, 66 at 100, 86 at 250, 495 at 1000; `HEAD`/s per waiter 27.7, 9.5, 3.8, 1.0. The first run overstated `HEAD`/s 1.5 to 2× by counting a per-sample baseline `stat` | §5.1, §5.2 |
| `cost-model.ts` | Cost per million jobs per design and store, now with a pause read per claim; the idle floor per worker per month ($42 on S3 Standard) with lease renewals; add-ons for a polled subscription, worker control and a summon controller | §5.2, §5.4 |
| `seaweed-startup.ts` | Pinned `chrislusf/seaweedfs:4.48`: `docker run` to a signed bucket-create returning 200 in 3.8, 6.0 and 5.7 s | §7 |
| `aws-sdk-presign/` | The AWS SDK signs `if-none-match` and `if-match` into presigned URLs (`X-Amz-SignedHeaders=host;if-none-match`), and adds an empty-body CRC32 by default | §3.1 |
| `docker pull` (by hand, recorded in the evidence README) | `minio/minio` and `quay.io/minio/minio` cannot be pulled; `bitnamilegacy/minio`, `chrislusf/seaweedfs`, `rustfs/rustfs` and `versity/versitygw` can | §7 |

**Taken from documentation, not measured here:**

- everything about AWS S3, S3 Express, R2, GCS, Ceph, Tigris, B2 and Wasabi:
  conditional support, consistency, per-key limits, latency, prices;
- MinIO's quorum bug and archived status;
- whether AWS honours an unsigned conditional header [U].

**Links.** §3.1 links `evidence/results-s3-wire.txt`, which is on
`develop` since #319 merged.

---

## 9. Risks

| Risk | Applies to | Likelihood | Mitigation |
|---|---|---|---|
| **A store that ignores conditional headers double-runs jobs**, silently | (a) | High across "S3-compatible" stores (B2 rejects them; MinIO lost them under quorum loss; Tigris global buckets are eventual) | Probe at connect and refuse to start; support AWS S3 and S3 Express only, by allow-list; document every other store as unsupported for (a) |
| **The ETag ABA**: same bytes, same ETag | (a) | Certain without a nonce [M] | A version or nonce in every body under compare-and-swap |
| **Cost surprise**: an idle floor of about $42 a month per worker on S3 Standard, plus $52 per polled subscription | (a) | Certain at defaults [M] | Don't build (a); if built, larger defaults and `nextDelayedAt` caching, both documented |
| **R2 and GCS: one write per second per key** | (a) | Certain [W] | Not supported for (a) |
| **Bun's `S3Client` changes** (#17339 lands) | all | Medium (good news) | The SigV4 helper is only needed for (a); (b) and (c) use `S3Client` as it is |
| **`job.data` on an unloaded offloaded job** | (b) | Certain, by design | It throws `BlobNotLoadedError` rather than holding a pointer; the worker and `getJob` resolve; `loadData()`; documented in the README and the change report |
| **Orphan blobs** after crashes, duplicate ids, updates and every removal path (none of which report ids) | (b) | Certain, by design | Random per-write keys; every delete deferred to the grace sweep; `sweepBlobs()` for queues no worker serves (§4.3) |
| **A superseded blob deleted under a claim** that read the old record | (b) | Would be likely with a grace counted from the old blob's own write | The grace counts from the record's `opts.blobAt`, stamped by the driver with every flag write; a 404 re-reads the record once and follows the new pointer (§4.3) |
| **A repeat series sharing one blob**, deleted after the first occurrence's removal | (b) | Would be certain if repeats offloaded | Repeats stay inline: definitions, occurrences and patches on any record with a `repeatKey` (§4.3) |
| **A store-less writer patches an offloaded job** (a producer or API process without `blobs`) | (b) | Medium in mixed deployments | The driver treats a data patch without `blob` as `blob: false`: the record becomes well-formed inline data, never inline data under a pointer flag (§4.3) |
| **A `copyFailed` letter's source deleted before the copy** | (b) | Likely with `removeOnFail` set, during an S3 outage | A bounded hold in the source queue's state; both sweeps retry the copy; 404 alone means `missing` (§4.3) |
| **A worker without the store claims offloaded jobs** | (b) | Medium in mixed deployments | The persisted `__win:blobs` marker, read at start and re-read at most once a second, makes such a worker refuse to start, or fail the claimed job retryably and stop (§4.3) |
| **`JobPatch.blob` drifts between drivers** (Redis's overlay field, MongoDB's CAS loop) | (b) | Medium | Contract cases for the flag with `data`, with a priority patch and with `rewritePendingOptions` (§6.2) |
| **A bucket lifecycle rule deletes referenced data** | (b) | Medium if a user adds one | The README says not to, or to set it longer than any job may live (delayed, dead and dead-lettered jobs) |
| **`maxDataBytes` refuses a payload a user relied on** | (b0) | Low: no default, opt-in | Off unless set; the error names the size and the limit |
| **The archive hold stalls retention across six drivers** if the archiver stops, including from processes that never configured the archive | (c) | Low | An `archive-lagging` event after N missed cycles; a persisted override in `__win:archive` (`hold: false`, set by `archive.release()`) lets retention proceed unarchived, documented |
| **A blob store outage fails attempts** | (b) | Low | Transport errors are retried under the job's `attempts`; only a 404 or a hash mismatch is unrecoverable; jobs under the threshold are unaffected |
| **Data exposure**: payloads land in a bucket with its own access policy | (b), (c) | Medium | The README requires a private bucket; optional server-side encryption through the client's own options; the key layout carries no data |

---

## 10. Open questions for the user

Each question has a recommended answer.

1. **Add `maxDataBytes` (PR-S1a, (b0)) first?** **Recommended: yes,
   pending your approval**, because it adds public API: a queue-level option
   (not a job-defaults key, so a producer cannot raise it).
   - **What it closes:** the unbounded-inline-data hole, with no new
     storage, on every driver.
   - **Shape and cost:** it mirrors the runner's `maxResultBytes`
     (`runner/types.ts:898`), but refuses instead of truncating. Dead letters
     are exempt. About 1.5 to 2 days.
   - **Why first:** this was the bun-jobs agent's suggestion. It makes (b) a
     choice, "store it elsewhere", rather than the only remedy.
2. **Should `maxDataBytes` ever get a default** (say, 1 MiB) in a later major
   release? **Recommended: decide after (b0) ships and users report sizes.**
   v1 has no default, so nothing changes for anyone.
3. **Build (b), the blob store, after (b0)?** **Recommended: yes, scoped to
   job data only.**
   - **Cost:** about 16 to 19.5 days. The owner read 11 to 14; the per-driver
     cost of `JobPatch.blob` (about 2.5 days) is the difference.
   - **What it touches:** no queue guarantee. It does change drivers:
     `JobPatch.blob` in all six. It works on every S3-compatible store.
   - **Repeats stay inline**, and so does any patch to a repeat occurrence
     (§4.3).
   - **Results are out of scope.** A synchronous `job.returnValue`
     (`Job.ts:161`), the `completed` event and `flow.values` make result
     offload a separate, breaking proposal.
4. **Build (c), the archive?** **Recommended: yes, after (b), as a separate
   decision.**
   - **Cost:** about 9 to 11 days, for jobs only. It needs `archiveHold?` in
     six drivers. The owner read 10 to 12 with event export, which this plan
     descopes (§4.4).
   - **Event export later, or never?** **Recommended: a separate plan if
     anyone asks.** Events are "a live notification channel rather than an
     audit trail" (`driver.ts:2856-2858`), and their retention is per
     namespace while the archive is per queue.
   - **Dead jobs:** archive them and keep them, unless `removeOnFail` says
     otherwise (`queue/options.ts:209` defaults to keeping them).
   - **`removeOnComplete: true` jobs are never archived**, and the README
     says so.
5. **Build (a), the full S3 driver?** **Recommended: not now.**
   - **Why:**
     - realistically 25 days or more;
     - about 370 ms from ready to start at p50 on S3 Standard (analytic; 330 ms measured);
     - $48 per million jobs, plus about $42 a month per idle worker;
     - about 5 claims/s with limits on Standard, 1/s on R2;
     - safe only on an allow-list of AWS S3 and S3 Express.
   - **When to revisit:** when a workload needs a queue with **no database at
     all**, on AWS. Even then, first spend a day on the real-AWS verification
     of §7, and prefer S3 Express.
6. **oven-sh/bun#17339:** the comment with this use case **is posted**
   ([comment, 2026-10-10](https://github.com/oven-sh/bun/issues/17339#issuecomment-6092094546)).
   Nothing more is asked of you here. The issue stays a feature request, not
   a bug report.
7. **One `BlobStore` interface with S3 and file implementations**, rather
   than S3 only? **Recommended: yes.** The file implementation makes the
   feature testable everywhere, and is useful on single-host setups.
8. **The S3 test server: SeaweedFS 4.48 instead of MinIO, owned by whom?**
   **Recommended:**
   - SeaweedFS, pinned, for bun-jobs and bun-cache alike (§7);
   - the **bun-jobs agent as the proposed owner** of PR-S0. It is a shared
     `scripts/` change and not yet scheduled; bun-cache's PR-C7 reuses it.
9. **Who builds (b0), (b) and (c)?** **Recommended:** the bun-jobs agent,
   which owns `packages/bun-jobs/**`, or the features agent under its
   review.
   - The bun-jobs-ui agent adds the offloaded-data view and, later, the
     archive browser.
   - The examples agent adds one example each.

---

## 11. PR slicing and effort

Each PR passes the bun-jobs gate alone:

- `bun scripts/typecheck.ts`;
- `CI=1 bunx eslint .`;
- `bun run test` plus `--randomize` with two seeds, with the database URLs
  and `BUN_JOBS_TEST_S3_URL`, run through the heavy-run wrapper with
  `HEAVY_EXCLUSIVE=1`, as the bun-jobs DB suite requires.

Each PR that adds user-facing API sends the examples agent a change report.

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-S1a** `maxDataBytes` (b0), *recommended, pending the user's approval* | a queue-level option on `BunQueue` and `BunJobs` (not a job-defaults key); `assertJsonSafeSized` (one stringify, one `Buffer.byteLength`, parse the same string); the five checked sites of §4.2; the DLQ pin (letters exempt); tests on every backend; README | — | ~1.5–2 d |
| **PR-S0** S3 test server, *proposed owner: the bun-jobs agent* | SeaweedFS `4.48` as a `dockerOnly` plan entry in `scripts/setup-databases.ts` (container `bun-jobs-s3`, readiness by signed bucket-create, `--dry-run` URL); `BUN_JOBS_TEST_S3_URL`; a helper in `__tests__/helpers/backends.ts` with the skip and fail rules; cases in `scripts/__tests__/setup-databases.test.ts`. Reused by bun-cache's PR-C7 | — | ~1–1.5 d |
| **PR-S1** blob store (b), data only | `BlobStore`, `s3Blobs`, `fileBlobs` (with `previous`); `blobs`, `offloadAbove`, `blobGrace`; `BunQueueWorkerOptions.blobs` (passed by `BunJobs`); `planData` and every write site, with the repeat rule (and its one-time warning) and a record read before every data patch; **`JobPatch.blob` with the `opts.blobAt` stamp and the `blob: false` default in six drivers** (overlay fields on MongoDB and Redis), declared by **`capabilities.blobData`** and reported as `features.blobData` (an empty `DRIVER_FEATURES` entry, `supportsBlobData`, the two schema fields, the contract `features` type), and **`releaseJob?`** (to `delayed` only; both required by `blobs`), with contract cases; the `Job` read model (`BlobNotLoadedError` with `reason`, `loadData()`, `resolveData`); worker resolution, the 404 re-read, `UnrecoverableJobError`; dead-letter `dataRef` (copy with bounded retry; `copyFailed` with a bounded hold in the source queue, completed by the source queue's sweep after a letter check; `missing` only on a 404); the grace sweep timed by `blobAt`, with the letter row and a persisted, wrapping cursor; `queue.sweepBlobs()`; the `__win:blobs` marker, its re-read, the start-time refusal before the first report, the in-flight refusal (a release before any `active` emit, the limiter reservation returned, the worker's exit mark set to `error`/1, `runSummoned`'s `#onClosing` honouring it, `run()` rejecting after the close, `BunJobs` catching it) and `queue.resetBlobMarker()`; API (`opts` stripped, `dataOffloaded`, `dataBytes`, `GET /queues/:queue/jobs/:id/data` with `jobs.readData`, the `PATCH` guard on the record it read); the suites of §6.2; README. Nothing under `lib/remote` | PR-S0 for the S3 run; best after PR-S1a | ~16–19.5 d |
| *UI-S1* | the job screen's size and fetch button; `UpdateJobDialog` fetches through the new route, or opens read-only; the parsed "What each element needs" rows (reported to the examples agent before merging) | PR-S1 | *~2–3 d (bun-jobs-ui agent)* |
| **PR-S2** archive (c), jobs only | `archiveHold?` in six drivers (and a start-time refusal for a driver without it), driven by the persisted `__win:archive` entry (no mark = hold all), with contract cases; keyset reads on `(finishedOn, id)`; the lag-windowed mark; `ArchiveStore`, `s3Archive`, `fileArchive`; dead-job policy; `queue.archiveNow()`; `archive.release()`; `archive.list` and `archive.read`; NDJSON, zstd; README. No event export | PR-S0, PR-S1 (shared S3 plumbing) | ~9–11 d |
| *UI-S2* | archive browser | PR-S2 | *~2 d (bun-jobs-ui agent), later* |
| *EX* | one example each for S1a, S1 and S2, on memory plus one server, and the S3 test server; the `permissions.ts` update for UI-S1 | each | *~2.5 d (examples agent)* |
| *PG* | the playground offloads one demo job's data | PR-S1 | *~0.5 d* |
| *PR-S3a* (not scheduled) | real-AWS verification spike for (a): unsigned versus signed conditional headers, 409 handling, latency, the §4.1 claim against S3 Standard and S3 Express | — | *~1 d* |
| *PR-S3* (not scheduled) | design (a), the full driver, on the allow-list only: SigV4 helper, connect-time probe, the §4.1 claim and settle rules, the full index set and wake list of §2.3, an event sequence, the contract helper's per-group gating, the `nextDelayedAt` cache | PR-S3a and a workload | *~25 d or more* |
| | **Total, if all scheduled (S1a, S0, S1, S2)** | | **~27.5–34 d** |
| | **The recommended first step alone (S1a)** | | **~1.5–2 d** |

**Against the owner's read** (round 3):

| Part | Owner | This plan | Why |
|---|---|---|---|
| (b0) | 1.5–2 d | 1.5–2 d | adopted |
| PR-S0 | 1–1.5 d | 1–1.5 d | adopted |
| (b) | 11–14 d | 16–19.5 d | `JobPatch.blob` costs about 2.75 days once priced per driver (§4.3): Redis's and MongoDB's overlay fields and the `blob: false` default; round 4's R1 to R4 add 0.5–1 d; the copy holds and `releaseJob?` (rounds 5 and 6) add 1.5 d; round 8's error exit and API wiring add 0.5 d |
| (c) | 10–12 d | 9–11 d | the owner's figure included event export, which is descoped (§4.4) |
| **Total** | 24–30 d | 27.5–34 d | |

---

## 12. Names needing approval

**Every name in this table is pending the user's approval.** It covers the
scheduled PRs only; design (a) gets names if it is ever scheduled.

| Name | Kind | Where | Why this name |
|---|---|---|---|
| **`maxDataBytes`** (*pending the user's approval, PR-S1a*) | option | `BunQueueOptions`, `BunJobsOptions`; **queue-level only**, not job defaults | mirrors the runner's `maxResultBytes`; "data" is the job's own field name |
| `assertJsonSafeSized` | internal helper | `shared/json.ts` | `assertJsonSafe` with a byte limit, one stringify |
| `blobs` | option | `BunJobsOptions`, `BunQueueOptions`, **`BunQueueWorkerOptions`** (passed by `BunJobs`, `BunJobs.ts:774`) | the store of large values |
| `blobs.previous` | option | `s3Blobs`, `fileBlobs` | the store pointers written before a move still resolve through |
| `BlobStore` | interface (`put`, `get`, `delete`, `list`, `presign?`) | root | what any blob backend implements |
| `s3Blobs`, `fileBlobs` | functions | root | `<backend>Blobs` |
| `offloadAbove`, `blobGrace` | options | `blobs` | the threshold in bytes; how long a superseded or orphaned blob is kept |
| `JobPatch.blob` | driver contract field | `lib/drivers/driver.ts` (`JobPatch`, `:1287-1296`) | the flag travels with `data` in one atomic step; the driver stamps `opts.blobAt` with it; a data patch without it counts as `false` |
| `releaseJob?(q, id, token, runAt, now)` | optional driver method | `QueueDriver` | hands a claimed job back unrun: to `delayed` (`runAt` must be later than `now`), attempt undone, no failure recorded; required by `blobs` |
| `capabilities.blobData`, `features.blobData: boolean`, `supportsBlobData`, `DriverCapabilitiesDto.blobData`, `MetaDto.features.blobData` | declared driver capability, API feature, helper, DTO fields | `DriverCapabilities` (beside `jobAttribution`, `driver.ts:87`); `api/routes/meta.ts`, `api/schemas/meta.ts`, `api/contract/types.ts` (`:3844`, `:3983`) | promises `JobPatch.blob`, its `blobAt` stamp, the `blob: false` default and the overlay reads; required by `blobs`; wired like `jobAttribution` |
| **`BunQueueWorker.run()` may reject after start** | contract change | `BunQueueWorker` (`run()`, JSDoc at `:1517-1525`; a private `#stopError`) | today it only resolves. `#stopped` stays resolve-only; the blob release path stores its `ConfigError` in `#stopError`, and `run()` rethrows it after awaiting `#stopped` at both returns (`:1528`, `:1624`) |
| `worker.exitMark` | read-only getter | `BunQueueWorker` | lets `runSummoned`'s `#onClosing` tell a worker's own error stop from an owner's close |
| `opts.blob`, `opts.blobAt` | stored job options (flag, time) | `StoredJobOptions` (`driver.ts:1066`), internal; overlay fields `optsBlob`/`optsBlobAt` on MongoDB and Redis; stripped from the API's opts DTO | marks `data` as a pointer; `blobAt` is when the flag was last written, which the sweep times superseded keys from |
| `$blob` (`key`, `size`, `sha256`, `at`) | pointer inside an offloaded job's `data` | raw records, `toJSON()`, API `include=data` | only meaningful when `opts.blob` is set; `at` is the blob's write time, kept for diagnosis |
| `job.loadData()`, `BlobNotLoadedError` (`reason`: `not-loaded`, `missing`, `corrupt`, `unavailable`, `no-store`; the same five as §4.3's table) | method, error class | `Job`, root | `job.data` stays `TData`: it throws until loaded, never holds a pointer |
| `resolveData` | read option | `BunQueue.getJob` (default `true`), lists (default `false`) | whether a read fetches offloaded data |
| `queue.sweepBlobs({ limit })` → `{ deleted, scanned, wrapped }` | method | `BunQueue` | one bounded sweep pass from the persisted cursor, for queues no worker serves |
| `queue.resetBlobMarker()` | method | `BunQueue` | rewrites `__win:blobs` to the configured store's fingerprint after a move |
| `__win:blobs` | reserved queue-state entry | internal | the store's kind and fingerprint, and the sweep's cursor; a worker without a matching store refuses to start or stops |
| `__win:blobhold:<sha256(key)>` | reserved queue-state entries | internal, in the **source** queue | one hold per `copyFailed` letter: `{ key, letter, until }` |
| `copyHold` | option | `blobs` | how long a hold protects a source key; default 7 days |
| `DeadLetter.dataRef` (`missing?`, `copyFailed?`) | field | `queue/types.ts` (`DeadLetter`) | a letter's own copy of an offloaded job's data; `copyFailed` while the copy is retried; `missing` only after a 404 |
| `dataOffloaded`, `dataBytes` | DTO fields | `./api/contract` job DTO | the UI can say so without fetching |
| `GET /queues/{queue}/jobs/{id}/data`, action **`jobs.readData`** (opt-in; a read, kept by `readOnly` when named) | route, action | management API | fetches data alone, beside `getJob`'s path; opt-in because it can be large |
| `archive` | option | `BunJobsOptions` | — |
| `ArchiveStore`, `s3Archive`, `fileArchive` | interface, functions | root | as for blobs |
| `after`, `lagWindow`, `batchSize`, `maxBatchBytes` | options | `archive` | `after` reads as "archive after 7d" |
| `archive.list`, `archive.read`, `archive.release()` | methods | the archive handle | `release()` sets the persisted `hold: false` override |
| `queue.archiveNow({ limit })` | method | `BunQueue` | one archive pass, for queues no worker serves |
| `archiveHold?` | optional driver capability | `QueueDriver` | retention honours the persisted mark; `archive` refuses a driver without it |
| `__win:archive` | reserved queue-state entry | internal | the archive's mark and override, beside `__win:msweep` |
| `archive-lagging` | event | `BunJobs` | retention is waiting on the archive |
| `blobs/<ns>/<queue>/<jobId>/<uuid>`, `blobs/<ns>/<dlq>/<letterId>/<uuid>`, `archive/<ns>/<queue>/<state>/<yyyy>/<mm>/<dd>/…` | key layouts | S3 | readable by people browsing the bucket |
| `BUN_JOBS_TEST_S3_URL`, container `bun-jobs-s3` | env variable, container | tests, `setup-databases.ts` | beside `BUN_JOBS_TEST_*` and the other `bun-jobs-*` containers |

**Withdrawn:**

- `offloadResults` and `returnValueOffloaded` (round 2), with result offload;
- `BlobMissingError` (round 3), replaced by `UnrecoverableJobError` for a
  missing or corrupt blob;
- `readEvents?` and the archive's `events` and `hold` options (round 3),
  with event export.

---

## Appendix: evidence

[`evidence/bun-jobs-s3-driver/`](evidence/bun-jobs-s3-driver/README.md) holds
the spikes and their output. Like the other evidence folders, it is not part
of any package, and the repo's tooling does not typecheck or lint it.
