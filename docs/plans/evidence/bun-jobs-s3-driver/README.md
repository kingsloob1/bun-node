# Evidence: an S3 driver for bun-jobs

The evidence behind [`../../bun-jobs-s3-driver.md`](../../bun-jobs-s3-driver.md).
Gathered on **2026-10-10** (revised the same day after the bun-jobs agent's review) on the shared laptop (i9-11900H, 16 threads,
Linux 7.0.0-38-generic) with Bun **1.4.3** (`bbdc5a519`). Peer sessions were
running, so compare within a run. Nothing here is part of a published package,
and the repo's tooling does not build, typecheck or lint it
([`../README.md`](../README.md)).

| Path | What it is | Re-run |
|---|---|---|
| `conditional-writes.ts` | Against four S3-compatible servers: what Bun's `S3Client` returns on each path (`write`, `text`, `stat`, `list`) and whether an ETag comes with it; `If-None-Match: *` and `If-Match: <etag>` on `PUT` through **a presigned URL plus `fetch()` with the header unsigned**, and through **our own SigV4 signature with the header signed**; conditional `DELETE`; 32 concurrent create-once and 32 concurrent compare-and-swap writers; a compare-and-swap counter on one object (16 writers × 10); loopback latency per request type; read- and list-after-write | `bun conditional-writes.ts` |
| `claim-proto.ts` | A throwaway prototype of design (a)'s hot path, **through the presigned-URL path with the conditional header unsigned** (honoured by these servers, [U] on AWS), not the SigV4 path the plan recommends; it keys claims `claims/<id>` and never exercises stall, retry, `resetAttempts` or id reuse: job objects, a ready index of marker objects, claim-once by a create-once claim object, activation and completion by `If-Match`. Exactly-once, jobs/s at 1, 4 and 16 workers, and requests per job by type | `bun claim-proto.ts` |
| `pickup-poll.ts` | **Corrected 2026-10-10:** the first run counted each sample's baseline `stat` as a waiter's poll and divided by total time, overstating `HEAD`/s by 1.5 to 2×; it now counts only the loop's `HEAD`s over the polling time. With no notification, how long a waiter polling a `wake` object's ETag with `HEAD` every 25, 100, 250 and 1000 ms takes to notice a write, and how many requests per second that costs (MinIO, loopback) | `bun pickup-poll.ts` |
| `seaweed-startup.ts` | Seconds from `docker run` of the pinned `chrislusf/seaweedfs:4.48` to a signed bucket-create answering 200, three rounds (3.8 to 6.0 s), for PR-S0's readiness wait | `bun seaweed-startup.ts` |
| `cost-model.ts` | Pure arithmetic (revised: a pause read per claim; the idle floor with lease renewals; add-ons for control, a polled subscription and a summon controller): requests per job per design (from `claim-proto.ts` plus the counted index writes) and an idle worker's steady requests, times each store's request prices read on 2026-10-10 | `bun cost-model.ts` |
| `aws-sdk-presign/` | Offline: which headers the AWS SDK (`@aws-sdk/client-s3` 3.1149.0) signs into a presigned URL for `IfNoneMatch` and `IfMatch`, and the empty-body CRC32 it adds by default | `cd aws-sdk-presign && bun install && bun signed-headers.ts && bun checksum.ts` |
| `results-*.txt`, `aws-sdk-presign/results.txt` | Captured output | — |

## Servers

`minio/minio` and `quay.io/minio/minio` could **not** be pulled on
2026-10-10 (`pull access denied` and `unauthorized`): MinIO no longer
publishes community images there [U for the reason; the failure is
measured]. The spikes used four images that could be pulled:

| Name | Image | Version | Started with |
|---|---|---|---|
| MinIO | `bitnamilegacy/minio:latest` | `DEVELOPMENT.2025-05-24T17-08-30Z` (image built 2025-06-06) | `docker run -d --rm --name cacheplan-e6-minio --ulimit nofile=65536:65536 -p 127.0.0.1:19101:9000 -e MINIO_ROOT_USER=spikeuser -e MINIO_ROOT_PASSWORD=spikesecret123 -e MINIO_DEFAULT_BUCKETS=jobs bitnamilegacy/minio:latest` |
| SeaweedFS | `chrislusf/seaweedfs:latest` (= `4.48`, same image id `sha256:7b5ca1f1…`) | 4.48 (2026-09-28) | `docker run -d --rm --name cacheplan-e6-seaweed --ulimit nofile=65536:65536 -p 127.0.0.1:19102:8333 chrislusf/seaweedfs:latest server -s3` |
| RustFS | `rustfs/rustfs:latest` | image of 2026-10-03 | `docker run -d --rm --name cacheplan-e6-rustfs --ulimit nofile=65536:65536 -p 127.0.0.1:19103:9000 -e RUSTFS_ACCESS_KEY=spikeuser -e RUSTFS_SECRET_KEY=spikesecret123 rustfs/rustfs:latest` |
| Versity S3 Gateway | `versity/versitygw:latest` | v1.8.0 | `docker run -d --rm --name cacheplan-e6-versity --ulimit nofile=65536:65536 -p 127.0.0.1:19104:7070 --entrypoint sh versity/versitygw:latest -c 'mkdir -p /srv/vgw && exec versitygw --access spikeuser --secret spikesecret123 --port :7070 posix /srv/vgw'` |

Every container ran with `--ulimit nofile=65536:65536`, and interactive
`docker` output was piped through `| cat` (the snap Docker caveat in
CLAUDE.md, which applies to a shell's captured output; scripts that capture
through `Bun.spawn` pipes, as `setup-databases.ts` does, are unaffected). The
containers were removed afterwards, and each run deleted exactly its own prefix
(`cw-<pid>-<ms>/`, `cp-<pid>-<ms>-w<n>/`, `pp-<pid>/`).

Between the first runs and the revision, the `bitnamilegacy/minio`, `rustfs`
and `versitygw` images disappeared from the local Docker store; this work did
not remove them. MinIO was pulled again for the corrected `pickup-poll.ts`
run, whose bucket was created with `mc mb` inside the container because
`MINIO_DEFAULT_BUCKETS` had not run yet:

```bash
docker exec cacheplan-e6-minio sh -c 'mc alias set l http://127.0.0.1:9000 spikeuser spikesecret123 && mc mb -p l/jobs' | cat
```

**No AWS S3, R2, Backblaze or Wasabi was reachable from here.** Everything
the plan says about them comes from their documentation and is marked so.
**Single-node servers on loopback** say nothing about a distributed
deployment's consistency, and nothing about network latency. The latencies
here are each server's own cost, not S3's.
