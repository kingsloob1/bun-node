# Evidence: worker gateway and job isolation

The evidence behind
[`../../worker-gateway-and-isolation.md`](../../worker-gateway-and-isolation.md).
Gathered on **2026-09-29**, on one shared laptop: i9-11900H with 16 threads,
Linux 7.0.0-31, Bun `1.4.3-canary.1+5f554969b`, and snap Docker 29.8.0. Peer
sessions ran at the same time, so the load is recorded with each result.
Nothing here is part of a published package, and nothing here is built,
typechecked or linted by the repo's tooling
([`../README.md`](../README.md) says why).

| Path | What it is | Re-run |
|---|---|---|
| `gateway-bench/bench.ts`, `executor.ts`, `wire.ts` | A throwaway gateway on the real `BunQueueWorker`, through a custom target. It covers direct, reversed WebSocket, reversed HTTP long-poll and a raw pull proxy. | `bun gateway-bench/bench.ts --backend redis --mode ws --batch on --jobs 10000 --concurrency 32` |
| `gateway-bench/run-matrix.sh` | The full matrix: memory, Redis and Postgres × 4 modes × batching on/off × 3 runs, plus a latency run each. It writes `gateway-bench/results.ndjson`. | `OUT=results.ndjson ./gateway-bench/run-matrix.sh` |
| `gateway-bench/summarize.ts` | Medians and latency percentiles into a table. | `bun gateway-bench/summarize.ts > results/gateway-bench.md` |
| `protocol-matrix.ts` | One round trip per protocol, as client and as server. | `CERT_DIR=<dir> bun protocol-matrix.ts` |
| `h2-check.ts` | h2c on `Bun.serve` with a control, and `fetch` multiplexing. | `CERT_DIR=<dir> bun h2-check.ts` |
| `results/` | The outputs of the three rows above. | — |
| `isolation/` | Docker, bubblewrap and Bun-level limits against a hostile job. It has its own [`RESULTS.md`](isolation/RESULTS.md). | Commands in `RESULTS.md` |
| `platform-isolation.md` | 17 platforms: nesting, userns, `/dev/kvm`, per-task hardening, egress and metadata, with ~110 sources. | Research, not a script |

## Before running

- **Databases.** The gateway bench uses Redis database 14 and the test
  Postgres database. Take the URLs from `bun scripts/setup-databases.ts
  --dry-run`, and override them with `GW_REDIS_URL` and `GW_POSTGRES_URL`.
  Each run uses a fresh namespace (`gwplan-<pid>-<ms>`) and drains only its
  own queue.
- **Certificates.** The TLS rows need a self-signed pair, which is
  deliberately not committed:

  ```sh
  openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 \
    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
  ```

- **Docker is a snap here.** It cannot read `/tmp`, so every file a
  container mounts lives in this directory. Pipe Docker's output through
  `| cat`. The scripts name containers `gwplan-*` and remove them.

## Provenance

The same marks as the other evidence folders:

| Mark | Meaning |
|---|---|
| **[M]** | measured by a script here |
| **[V]** | read from a primary source on 2026-09-29 |
| **[V-prior]** | carried from an earlier evidence file, which is named |
| **[I]** | inference |
| **[U]** | unverified |

## Cautions

- **Loopback only.** The gateway numbers include no real network round
  trip, proxy or loss.
- **The pull-proxy mode is a lower bound, not a like-for-like figure.** It
  skips events, metrics and every worker chore.
- **Container Bun is 1.4.2** (`oven/bun:1`), because `oven/bun:1.4.3` did
  not exist on the day. Host Bun is the 1.4.3 canary.
