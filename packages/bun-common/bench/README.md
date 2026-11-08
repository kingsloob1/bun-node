# `bun-common` benchmarks

**`sse.ts`** is the server-sent events fan-out guard (bun-native-routes plan
§16.9): events/s delivered to many clients by `res.sse()`, against a raw
`Bun.serve` stream with the same byte-length queue and against `res.write()`.
It needs no install. See [SSE fan-out](#sse-fan-out) below.

**`trustProxy.ts`** is the `trustProxy` per-request cost guard: nanoseconds
per request through the adapter's own request path under four trust
settings, and the `server.requestIP()` calls each request makes. See
[trustProxy](#trustproxy) below.

**`xml.ts`** measures `parseXmlToObject` (from `lib/utils/native.ts`) against
**fast-xml-parser**, **htmlparser2** (a DOM build and a SAX build) and Bun's
native **`HTMLRewriter`**.

This directory is a separate, unpublished package with its own `package.json`,
lockfile and `node_modules`, so the comparators never reach
`@kingsleyweb/bun-common`'s dependency tree.

## Setup

```bash
cd packages/bun-common/bench
bun install
```

Without the install the script still runs. It skips the two third-party
comparators with a note and measures only `parseXmlToObject` and
`HTMLRewriter`.

## Run

```bash
bun xml.ts          # or: bun run xml
```

## What it measures

Each contender turns a generated `<catalog>` of `<book>` records into the
**same plain object**: root-keyed, `@_`-prefixed attributes, repeated children
collected into arrays, and numeric and boolean text coerced. The figure
reflects parsing and object building, not differences in output shape.

The document sizes are 10, 100, 1,000, 5,000 and 20,000 records. For each size
the script prints ms/op, ops/sec, MB/s and the ratio to `parseXmlToObject`.

`HTMLRewriter` applies HTML semantics. It doesn't decode XML entities and isn't
XML-correct, so it is there only as a throughput reference.

## SSE fan-out

```bash
bun sse.ts                    # print the table
bun sse.ts --compare          # fail if res.sse() regressed or was overtaken
bun sse.ts --save-baseline    # record baselines/sse.json, after a deliberate change
SSE_SHAPES=10x100 bun sse.ts  # a smoke run: clients x events each
```

Each cell starts a fresh server process (`--serve <target>`) and a client
process of raw TCP sockets (`--clients`), which open every stream, wait for
the first bytes, then time the delivery of M broadcast 58-byte events to each
of N clients. The targets are `raw-hwm` (the ceiling), `common-write` (the
rival) and `common-sse`.

`--compare` fails when `res.sse()` falls more than 35% behind its own
baseline, or when `res.write()` delivers more than 10% more events/s than it.
The second is the sharper check, because a busy machine slows both. The
margin came with S10 (2026-11-08): `res.write()` now streams on the same
64 KiB byte-length queue as `res.sse()`, so the two are near ties (from 14%
behind to 1% ahead in the A/B), where `res.write()` used to run at about
half the speed.

`baselines/sse.json` was recorded once on 2026-11-03, at the user's request
(Bun 1.4.4-canary.1+11c367163, linux-x64, exclusive through the heavy-run
wrapper, 1-minute load 1.54 at the start and the end). It records each
cell's events/s; a baseline is meaningful only on the machine that recorded
it. Run the guard through the heavy-run wrapper, alone, and only with the
maintainer's go-ahead (no speed comparisons without asking).

## trustProxy

```bash
bun trustProxy.ts                   # print the table
bun trustProxy.ts --compare         # fail on a regression
bun trustProxy.ts --save-baseline   # record baselines/trustProxy.json
TP_REQUESTS=2000 bun trustProxy.ts  # a smoke run
```

Each request goes through `BunHttpAdapter`'s `serveNativeRequest`, the
method its `Bun.serve` handler calls, with a stand-in server whose
`requestIP()` returns a fresh address object per call (as Bun's does) and
counts the calls. No socket: the figure is the framework's cost alone, which
a loopback socket's 20-50 µs would drown. The settings are `off`, `hop1`
(`trustProxy: 1`), `cidr` (four private and CGNAT ranges) and `cloudflare`
(`behindCloudflare()`: 22 ranges plus `clientIpHeader`); the handler reads
nothing, `req.ip`, `req.protocol`, `req.host`, or all three. Every request
carries `X-Forwarded-For`, `-Proto`, `-Host` and `CF-Connecting-IP` from a
trusted peer, so each trusted walk runs in full. Each cell is warmed, then
timed over `TP_REQUESTS` requests (20,000) in `TP_ROUNDS` rounds (5), in a
rotating order, and the median kept.

`--compare` fails when a cell makes more `requestIP()` calls per request than
the baseline (exact, so it holds on any machine), or when a trusted setting's
overhead over `off` for the same reads, measured in the same run, is more
than twice the baseline's plus 2 µs. `baselines/trustProxy.json` records the
Bun revision, the platform and the load; run it through the heavy-run
wrapper, exclusive.
