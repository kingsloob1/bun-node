# Spike: `redisDriver` on Upstash over `rediss://`

The plan's question (Status, 2026-10-27): does `redisDriver` over
`rediss://…upstash.io` already work, mooting a REST driver (PR-C9,
`upstashDriver`)? Run 2026-10-28 from this machine (Lagos, Bun
1.4.4-canary.1+a0cc096ce) against a free-tier Upstash database in
`us-east-1` (`INFO`: `upstash_version:1.19.4`, `redis_version:8.4.0`,
`redis_mode:standalone`, `cluster_enabled:0`). The URL is a credential: it
appears in no file here, and every captured output was redacted (the URL, the
host name, client addresses).

**Answer: yes.** With no change to the driver's commands, the conformance kit
and every Redis-specific test pass on Upstash:
**39 pass, 3 skip, 0 fail in 112.8 s** (`__tests__/drivers/upstash.test.ts`; the skips: the kit's `expiry.sweep`, native expiry, and `tags.stamps`, not advertised — as on the local server — and the distant-server test, which needs a plain `redis://` URL to relay). What had to change was
the test harness (latency, one missing admin command) and one driver default
(`firstConnectTimeout`).

## What was measured

Scripts and redacted output in [`upstash-spike/`](upstash-spike/); each reads
`BUN_CACHE_TEST_UPSTASH_REDIS_URL` (or `REDIS_PROBE_URL` for a local server),
writes under its own `bun-cache-probe:<pid>…` prefix and deletes exactly those
keys.

| Script | What | Result |
|---|---|---|
| `probe.ts` | Latency, every command the driver uses, Lua behaviours, expiry exactness, pub/sub | `results-probe.txt` |
| `probe2.ts` | Expiry offset by horizon, cross-connection read-your-writes | `results-probe2.txt` |
| `connect-probe.ts` | First-connect time, and the driver's connect under its default bound | `results-connect-probe.txt` |
| `gap-probe.ts` | Dropping a subscriber connection without `CLIENT KILL` | `results-gap-probe.txt` |
| `monitor.ts`, `opcost.ts` | Commands per driver operation, counted from `MONITOR` | `results-opcost-local.txt` |
| (the lane) | The final run of `upstash.test.ts`: counts, `MONITOR` tally, per-test durations | `results-lane.txt` |

**Latency per operation** (round trip from Lagos to `us-east-1`): `PING`,
`GET`, `SET` and `EVALSHA` p50 296–306 ms (min 296, max 346–582, n = 20
each). Concurrent commands pipeline on one connection: 50 `GET`s at once took
330 ms. Pub/sub, publish to delivery: 301 ms. `RedisClient.connect()` over
TLS: 549–1004 ms (n = 11; three round trips); the driver's `connect()`
(connect plus `INFO cluster`): 760–864 ms (n = 10).

**Commands.** Every command the driver sends works: `EVALSHA`/`EVAL` (and
`SCRIPT LOAD`/`EXISTS`), Lua with `cjson`, `redis.pcall` error tables and keys
outside `KEYS`; `GET`/`getBuffer` (byte-exact for all 256 byte values, also
written through a Lua argument), `SET … PX`, `PEXPIREAT`, `PERSIST`,
`UNLINK`, `SCAN … MATCH`, `MGET`/`MSET`, `HSET`/`HMGET`/`HINCRBY`, `INFO
cluster`, `CLIENT SETNAME`/`GETNAME`/`ID`/`LIST`, `PUBLISH`/`SUBSCRIBE`,
`QUIT`, `PEXPIRETIME`, `TIME`, `MONITOR`. **Missing: `CLIENT KILL`** ("ERR
Command is not available"; Upstash's command list has no `CLIENT KILL`). Only
the test harness used it.

**Expiry.** `PEXPIRETIME` after a `PEXPIREAT` reads a few ms off the value
sent: -35 to +22 ms in two sessions, 0 to 2 ms in a third, for horizons from
1 s to 30 days (not proportional to the horizon). `SET … PXAT` reads the same
offsets (-12/-13 ms in the session where `PEXPIREAT` read -16), in a script or
not, so `PXAT` would not make it exact. The driver is unaffected: an entry's
frame carries its exact `expiresAt`, which every read checks, so the server's
own expiry is only a few ms early or late.

**Consistency.** A write on one connection read back at once on another: 30
of 30 plain `SET`s and 30 of 30 Lua `SET`s were seen. (Upstash documents
eventual consistency across connections and causal consistency per
connection; the fence runs inside a script at the primary either way.)

**A bus gap without `CLIENT KILL`.** `QUIT` sent on the subscriber connection
makes the server close it; Bun reconnects it (813 ms to Upstash, 60 ms
locally), `redisBus`'s `onconnect` reports the gap and resubscribes, and the
next message is delivered. That is the path a `CLIENT KILL` takes.

**Commands per driver operation**, counted from `MONITOR` (which shows the
`redis.call`s inside a script; Upstash bills a script as one command plus each
call): `get` 1; `set` of a new key 5, +1 per tag, +1 when it replaces an entry
and +1 per old tag, +1 per fenced tag; `touch` 4; `increment` 3 (existing) or
6 (new); `acquireLock`/`releaseLock` 3; `delete` 1 + 3 per entry (+1 per tag
it carried) + 2 per absent key; `deleteByTags` 1 + 3 per tag + 2 per member
(+1 per tag it carried); `getStamps` 1; `publish` 1. The same counts on a
local Redis (`results-opcost-local.txt`): the scripts are the same.

**One run of the Upstash lane** (the final one, under `MONITOR`): 2,446
commands, of which 58 are not billed (`HELLO` 39, `INFO` 17, `PING` 2) —
about 2,390 billed, half a percent of the free plan's 500,000 a month. The
largest share is the kit's increments (200 in one process, 100 + 100 across
two: `EVALSHA` 698, `HMGET` 426, `HINCRBY` 401). The slowest tests: the
two-process lock 11.8 s (50 sequential releases), the namespaces case and the
20-round fence race 9.5 s each, the counters 6.5 s (a 3 s TTL waited out),
the kit's round trip 4.8 s (a 1 MiB entry); the 42 tests sum to 97 s.

## The first run's failures, classified

The coordinator's first run of `redis.test.ts` against Upstash: 27 pass,
2 skip, 13 fail, 2 errors.

| Failure | Cause | Class | Change |
|---|---|---|---|
| 8 tests at bun:test's 5 s timeout (the kit's round trip and two-process lock; the specifics' namespaces, sweep, fence race, bus, cache) | Each runs 15–60 sequential round trips; at ~300 ms each that is 5–20 s | harness, latency | the lane's default timeout is 120 s |
| the kit's `touch` answered `false` | The entry was written to expire in 100 ms; by the time the touch arrived (a round trip later) Redis had expired it, so `false` was right | kit, latency | the kit's entry expires in 60 s (a mutated `touch(null)` still fails the case) |
| `ERR Command is not available: 'CLIENT KILL'` (the bus-gap case) | Upstash has no `CLIENT KILL`; only the test's `busGap` sent it | Upstash, harness | the lane sends `QUIT` on the bus's subscriber (its `duplicate()` is captured through the client the kit's driver is given) |
| `PEXPIRETIME` 22 ms late, 5 ms early | Upstash reads expiry a few ms off what was set (`PXAT` the same) | Upstash, harmless | the lane allows 100 ms |
| "Expected and actual values must be numbers" | `getCounter` answered `undefined`: the counter's 60 ms TTL lapsed during the round trips | harness, latency | the lane's short TTL is 3 s |
| "the redis cache driver is closed" in `releaseLock`; `Connection closed` from `close()` | The kit's cleanup closed the driver under a test that had timed out and was still running (its 50 sequential releases), rejecting its commands in flight | harness, after the timeouts | none needed: gone once nothing times out |

**One driver issue**, found while measuring: `firstConnectTimeout` defaulted to
1 s, and a TLS connect to Upstash took 549–1004 ms here (one of the first two
connects took 1004.7 ms), so the default refused a healthy server about as
often as not on a cold connect, and the kit's two-process pass (a fresh
process, a fresh connect) was at its mercy. The default is now **5 s**. The
new test runs the driver through a relay that holds every chunk 550 ms each
way in front of the local Redis (a connect of 1.1 s): it passes, and fails
with the 1 s default ("no connection to 127.0.0.1:… within 1000ms").

## What Upstash changes for a user (README, "Upstash and other managed Redis")

- **Each command is a round trip to the database's region**, so the app
  belongs in that region, and an `l1` for hot keys matters more.
- **Billing per command**, scripts at one plus their calls: a cached read is
  1, a write 5–10.
- **Eviction** is off by default (writes fail at the size limit); turned on,
  it is "optimistic-volatile" — keys with a TTL first, then any key — so a tag
  set or stamp (no TTL, deliberately) can be evicted under pressure, as with
  `allkeys-*` on Redis.
- **10 MB per request** on the free and pay-as-you-go plans (the core's 4 MiB
  `maxEntryBytes` is under it).
- **Scripts take the global lock** by default, and a cold key a script names
  outside `KEYS` is loaded from disk with it held. Upstash's
  `#!lua flags=allow-key-locking` would lock only the hash tag of `KEYS[1]` —
  every driver script already passes a key of its namespace's tag, and every
  other key it touches shares that tag — but plain Redis rejects the unknown
  flag, so it would have to be an option.

## Is a REST `upstashDriver` (PR-C9) still worth building?

Not as the way to use Upstash: `redisDriver` over `rediss://` passes the whole
kit, keeps one pipelined connection (50 commands in one round trip) and a
pushed bus, and needs no new code. A REST driver would pay an HTTPS request
per command or per `/pipeline` batch (which is not atomic, so the atomic paths
would still be `EVAL` requests), and its bus would ride the REST API's
`/subscribe` server-sent-events stream (documented, not measured here).

Its only audience is **a Bun process that can reach Upstash over HTTPS but
not over TCP** — an egress proxy or firewall that passes port 443 only, or a
host whose platform offers HTTP egress alone. The edge runtimes the REST API
exists for (Cloudflare Workers, Vercel Edge, Fastly Compute, Deno Deploy)
cannot run bun-cache at all: it is a Bun package. The `KV_REST_API_*`
variables of Vercel's Upstash integration need a REST client; the same
integration also hands out a `rediss://` URL (`KV_URL` / `REDIS_URL`, by
Vercel's documentation, not checked here), which `redisDriver` takes as is.

**Recommendation (a question for the user): defer PR-C9** — do not build it
now, and build it if someone asks for HTTP-only egress — and document Upstash
as `redisDriver({ url: <its rediss:// URL> })` (done: the README's "Upstash
and other managed Redis").
