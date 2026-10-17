# SSE channel (broadcast hub): evidence

Recorded by bun-node-11 on 2026-10-17, for a change to §16 of
[`../../README.md`](../../README.md): the user asked to "add the new
convenience of express-sse to the plan intend for sse". It proposes a
broadcast channel on top of the §16 writer, prototyped here outside the
packages. Bun 1.4.4 (`1.4.4-canary.1+5f5799ed1`), worktree at `develop`
`56d6afde`. Names are proposals.

## What express-sse 1.0.0 does (read, not run)

`npm pack express-sse@1.0.0`, `index.js` (151 lines) [S]:

| express-sse | What it does | Here |
|---|---|---|
| `new SSE(initial, { isSerialized, initialEvent })` | initial values for new clients; `isSerialized` (default) sends one event per item | `createSseChannel({ initial })`: messages, or a function of the subscriber (possibly async) |
| `sse.init` | a route handler | `channel.handler(opts?)`, and `channel.subscribe(req, res)` beneath it |
| `sse.send(data, event?, id?)` | an event to every client | `channel.send(message, { topic? })` |
| `sse.serialize(list)` | one event per item | `channel.sendList(items, { event?, topic? })` |
| `sse.updateInit(data)`, `sse.dropInit()` | replace or drop the initial state | `channel.setInitial()`, `channel.clearInitial()` |

What it gets wrong, which the channel must not copy [S]:

- **The initial state goes to everyone.** `init()` sends it with
  `this.serialize(this.initial)`, which emits on the shared emitter, so every
  connected client receives the initial state again whenever anyone connects.
- **Ids are per connection** (`let id = 0` inside `init`), so two clients see
  different ids for the same event and `Last-Event-ID` means nothing. There is
  no resumption.
- `res.write()` with no backpressure, no bound and no heartbeat; formats every
  event once per client (three or four `write` calls each); `data` is always
  `JSON.stringify`ed, so a string arrives quoted; `isCompressed` sets
  `Content-Encoding: deflate` without compressing; `setMaxListeners` grows by
  two per client.

## Files

| File | What | Output |
|---|---|---|
| `channel-prototype.ts` | the hub: `createSseChannel`, `SseChannel`, the transport interface and an in-memory bus | — |
| `channel-writer.ts` | the §16 writer with shared `send()` promises (`SharedDrainWriter`, `sseShared`), the change the perf run argues for | — |
| `channel-prototype.test.ts` | 15 cases, served and `router.fetch()` | `results/channel-test.txt` |
| `channel-controls.ts` | each test's negative control: one planted bug (`CHANNEL_MUTATE`) per tag, which must fail it | `results/channel-test.txt` |
| `channel-perf.ts` | fan-out to 1,000 and 100 readers with and without a stalled client, the drop, RSS, `send()` cost, registry memory | `results/channel-perf.txt`, `channel-perf.json` |
| `channel-nest.ts` | `@Sse()` over the channel (`channelObservable`), `@SseSignal()`, bun-nest and Express, Nest 11.1.27 / 11.2.7 / 12.1.3 | `results/channel-nest.txt` |

## How to run

From the repository root, after `bun install`:

```bash
bun test docs/plans/bun-native-routes/evidence/sse/channel-prototype.test.ts   # targeted, not heavy
bun docs/plans/bun-native-routes/evidence/sse/channel-controls.ts              # 3 base runs + 12 mutations, ~10 s

# heavy: through the wrapper, in the background, alone
HEAVY_TICKET=<session>-sse-channel /tmp/claude-1000/bun-node-heavy-run.sh \
  nice -n 10 timeout 1200 bun docs/plans/bun-native-routes/evidence/sse/channel-perf.ts 3 > <log> 2>&1
```

The Nest probe runs once per Nest version, from a scratch directory (Bun reads
the decorator options from the cwd's `tsconfig.json`, oven-sh/bun#28605):

```bash
E=docs/plans/bun-native-routes/evidence/sse
for v in 11.2.7 12.1.3; do        # bun scripts/nest-matrix.ts --prepare <v> first
  d=<scratch>/nest-$v; mkdir -p $d
  cp $E/channel-nest.ts $E/channel-prototype.ts $E/prototype-sse.ts $E/lib.ts $d/
  echo '{"compilerOptions":{"experimentalDecorators":true,"emitDecoratorMetadata":true,"target":"ES2022","module":"ESNext"}}' > $d/tsconfig.json
  ln -s ~/bun-node-nest-matrix/$v/node_modules $d/node_modules
  (cd $d && bun channel-nest.ts)
done
# 11.1.27, the repo's own: the same, with node_modules -> the checkout's node_modules
```

**Pass conditions.** The test file passes 15 of 15, in file order and under
`--randomize`. `channel-controls.ts` exits 0: every mutation fails each test
tagged with it. `channel-perf.ts`: the readers' events/s with a stalled client
present are not below the run without it (within the round-to-round spread),
the stalled client is dropped in every B cell, and the channel's `size`
afterwards is the reader count. `channel-nest.ts`: on every version and
adapter, C1 shows the initial state then the live event, C2 a teardown with
`size 0`, C3 the two replayed events and no initial state, C4 the initial
state, C6 `size 0`, C7 `end=done`.

## Results

### Tests (`results/channel-test.txt`) [T]

15 of 15 pass, in file order and with `--randomize --seed=1` and `--seed=2`.
Each case is tagged with the planted bug that must fail it, and
`channel-controls.ts` confirms all 12 do:

| Case | Negative control (`CHANNEL_MUTATE=`) |
|---|---|
| a disconnect unregisters, waiting on the writer's `onClose` | `no-unsubscribe` |
| the initial state goes first, also when async and raced by a `send()` | `initial-unheld` (live events not held during the async snapshot) |
| `Last-Event-ID` in the buffer replays exactly the later events, no initial state; the newest id replays nothing (`"current"`) | `replay-include-last` |
| an id older than the buffer, or unknown, is a miss: the initial state, with `ctx.replay === "miss"` | `miss-sends-buffer` |
| assigned ids carry a per-instance prefix: a restarted process never "replays" an old id | `plain-ids` (ids `1`, `2`, …) |
| `sendList`: one event per item, in order, one chunk per subscriber | `sendlist-reverse` |
| topics, index and scan: only subscribers of the topic; broadcasts to all; replay filtered by topic | `topics-leak` |
| `close()` ends served and `fetch()` subscribers (`end=done`); later requests get 204 | `close-no-end` |
| encode once: 1 encoder call per `send()`, one bytes object shared by 50 subscribers | `encode-per-sink` |
| a subscriber that never reads does not stall another (2,000 events of 1 KB) | `await-each` (the hub awaits each writer in turn) |
| past `maxQueuedBytes` the stalled one is closed and removed while the reader continues | `no-unsubscribe` |
| served and `router.fetch()` get identical events, and both unregister on disconnect | `unsubscribe-on-signal` |
| a transport carries events between two channels once each; replay works on the receiving side with the sender's id | `no-origin-check` |
| one shared heartbeat reaches every subscriber | built in: `heartbeatMs: 0` in the same test sends none |

One finding came from a control: with `unsubscribe-on-signal`, which is
Node's `req.on("close")` idiom and express-sse's, the served subscriber is
removed but the `router.fetch()` one is not (size 1). **The socket-free
request's `signal` does not abort when the body is cancelled**, so the
channel must unsubscribe on the writer's close, never on the request's.

### Fan-out (`results/channel-perf.txt`, `channel-perf.json`) [M]

Bun 1.4.4, 16 cores, **a shared machine: the 1-minute load rose from 5.7 to
46 during the run** (other sessions' jobs started in the middle). Medians of
3 rounds. `proto` is the §16 prototype writer; `shared` is `channel-writer.ts`.
The absolute events/s moved 10× between rounds of the same cell under that
load (shared, 100 × 10,000: 183k to 2.79M), so only same-round comparisons
and the memory figures are claims.

| Cell (58-byte events unless noted) | `proto` ev/s | `shared` ev/s |
|---|---:|---:|
| A 1,000 readers × 1,000 | 1,463,709 | 1,806,271 |
| A 1,000 readers × 1,000, **+ 1 stalled client** | 1,488,440 | 1,076,235 |
| A 100 readers × 10,000 | 1,522,755 | 553,750 |
| A 100 readers × 10,000, **+ 1 stalled client** | 1,591,455 | 1,234,969 |

**The stalled client does not stall the readers.** Per round, the run with
the stalled client got 0.89×, 0.95×, 1.04× (proto, 1,000) and 1.05×, 1.22×,
0.85× (proto, 100) of the same round's run without it; for `shared`, whose
first two rounds ran in the load spike, 0.60× to 2.23×, centred on 1. A stall
would be near zero: the readers would get nothing until the stalled client
was dropped, and in the B cells below that took 5 to 63 s, during which the
readers received 0.31M to 2.6M events/s.

**The drop** (B: broadcast until the stalled client is dropped; it was, in
12 of 12 cells, and the channel's size afterwards was the reader count):

| Cell | Offered to the stalled client at the drop | Time to the drop | Server RSS at the drop (no GC) |
|---|---:|---:|---:|
| 100 readers + 1, 58 B, `proto` | 10.7 MiB | 14.6 s (13.1–62.7) | **+119.4 MiB** (104–123) |
| 100 readers + 1, 58 B, `shared` | 10.6 MiB | 18.4 s (7.3–53.7) | **+32.7 MiB** (31–34) |
| 1,000 readers + 1, 4 KiB, `proto` | 10.5 MiB | 8.4 s (6.2–47.9) | +138.6 MiB (129–143) |
| 1,000 readers + 1, 4 KiB, `shared` | 10.5 MiB | 5.9 s (5.4–8.2) | +86.1 MiB (84–87) |

- 10.5–10.7 MiB is the 8 MiB `maxQueuedBytes` plus ~2.5 MiB the sockets hold.
  The bound holds through the hub, at the same figure in every cell.
- The time is set by how fast the channel offers bytes (100 events per stream
  per macrotask here), and so by the load, not by the bound.
- **The RSS difference is the writer's promises.** The stock `send()`
  allocates a promise per call, and past the high-water mark a promise and a
  waiter closure per call, which a hub that never awaits leaves to pile up.
  Measured alone (`SseStream`, unread, 58-byte events until 8 MiB trips):
  145,762 sends, 13.8 MiB of heap at the peak, 1,112 ns per send. With shared
  promises: about 0 heap, 514 ns per send. Hence `channel-writer.ts`.
- RSS after a GC: 1,000 idle subscribers cost +10–12 MiB over a fresh
  adapter (~10.5 KiB each, mostly `BunRequest`/`BunResponse`/the stream), and
  +18–24 MiB after a million deliveries.

**`send()` and the registry, in process** (no-op writers, median of 3):

| | 1,000 subscribers | 100 subscribers |
|---|---:|---:|
| broadcast, ns per `send()` | 22,714 (~23 ns per subscriber) | 2,753 |
| one topic of 10, `Map<topic, Set>` index, ns per `send()` | 3,395 (reaches 100) | 855 (reaches 10) |
| one topic of 10, scan with a predicate, ns per `send()` | 20,808 | 2,348 |

Registry memory: **397 bytes per subscriber** (the sink, its `Set` entries
and closures), **786 with three topics** (~130 bytes per topic membership).

### Nest (`results/channel-nest.txt`) [M]

`@SseSignal()` is exported by Nest **11.2.7 and 12.1.3, not 11.1.27** (the
repo's lock). Likewise `MessageEvent.comment` (a comment-only event): 11.2.7
and 12.1.3 have it, 11.1.27 does not. Identical results on 11.1.27, 11.2.7 and
12.1.3, on bun-nest's `BunHttpAdapter` and on `ExpressAdapter`:

| Case | Result, every version and adapter |
|---|---|
| C1 new client | `event: init` (the initial state), then the live event, in order |
| C2 client disconnect | torn down in 1–15 ms, `channel.size` 0. On 11.2.7 and 12.1.3 the `SseSignal` abort comes first (Nest's `finalize()` aborts, then unsubscribes); on 11.1.27 Nest's unsubscribe alone does it |
| Nest's disconnect source on bun-nest | `request.socket.once` is a function, `destroyed` is `false` before, `'close'` fires, `destroyed` is `true` at close: the shim satisfies `request.socket ?? response` and its `destroyed` check |
| C3 `Last-Event-ID` of a live event | the two later events, no initial state |
| C4 `Last-Event-ID: 1` | a miss, so the initial state again. `1` is **Nest's** id: Nest numbers every event without an `id`, so the initial state arrives as `id: 1` |
| C5, C6 | two open: `size` 2; after both cancel and `app.close()`, 0 |
| C7 `channel.close()` | Nest's stream ends (`end=done`) |
| C9 (bun-nest) `@Res()` + `channel.subscribe(req, res)` | the byte path, served and through `adapter.fetch()`: `: ok`, initial, live; size 1, then 0 on cancel |
| Control, both unsubscribe paths removed | C2 reports size 1: the check can fail |

**The encode-once loss on Nest's path** (C8, in process: K subscribers through
Nest's own `SseStream` and the `map` + `concatMap` of
`router-response-controller`, against K byte writers): **2.3–8.8 µs per event
per subscriber against 25–161 ns, 55× to 152×**, across four runs (it is
load-sensitive). At 1,000 subscribers one event costs ~2.5–9 ms of CPU through
`@Sse()`, against ~25–90 µs through the byte path. bun-nest apps that broadcast
heavily can use `@Res()` with `channel.subscribe()` (C9).

## Design conclusions

### The API (final proposal)

```ts
import { createSseChannel } from "@kingsleyweb/bun-common/sse";   // also from the root

const prices = createSseChannel({
  initial: async (ctx) => [{ event: "snapshot", data: await book.snapshot() }], // or SseMessage[]
  replay: 100,              // keep the last 100 events for Last-Event-ID; default 0 (off)
  heartbeatMs: 15_000,      // one timer for the channel; 0 disables
  writer: { maxQueuedBytes: 8 * 1024 * 1024 },   // per subscriber, SseWriterOptions
  transport,                // optional, cross-process; default process-local
});

app.get("/prices", prices.handler());                                  // express-sse's sse.init
app.get("/rooms/:id", prices.handler({ topics: (req) => [`room:${req.params.id}`] }));
app.get("/custom", (req, res) => { const sub = prices.subscribe(req, res, { topics: ["a"] }); });
Bun.serve({ routes: { "/raw": (req, server) => prices.response(req, { server }) } });

prices.send({ event: "tick", data: { p: 101.5 } });                    // -> subscribers reached
prices.send({ data: "hi" }, { topic: "room:7" });
prices.sendList(rows, { event: "row" });                               // express-sse's serialize
prices.setInitial([...]); prices.clearInitial();                       // updateInit / dropInit
prices.size; prices.closed; prices.close();
```

```ts
function createSseChannel(options?: SseChannelOptions): SseChannel;
interface SseChannelOptions {
  initial?: SseMessage[] | ((ctx: SseInitialContext) => SseMessage[] | Promise<SseMessage[]>);
  replay?: number;          // default 0
  heartbeatMs?: number;     // default 15 000
  writer?: Omit<SseWriterOptions, "heartbeatMs" | "signal">;
  transport?: SseChannelTransport;
  idPrefix?: string;        // default a per-instance epoch, e.g. "mgqk3x9a2f."
  onError?: (error: unknown) => void;   // a failed initial(), a failed publish
}
class SseChannel {
  readonly size: number;
  readonly closed: boolean;
  subscribe(req: BunRequest, res: BunResponse, opts?: SseSubscribeOptions): SseSubscription | undefined; // res.sse() inside; 204 once closed
  handler(opts?: { topics?: Iterable<string> | ((req: BunRequest) => Iterable<string>) }): (req: BunRequest, res: BunResponse) => void;
  response(request: Request, init?: SseSubscribeOptions & { server?: Bun.Server<unknown> }): Response;
  attach(writer: SseWriter, opts?: SseSubscribeOptions): SseSubscription;      // the primitive
  listen(fn: (m: SseMessage) => void, opts?: SseSubscribeOptions & { onEnd?: () => void }): SseSubscription; // for adapters that format themselves
  send(message: SseMessage, opts?: { topic?: string }): number;
  sendList(items: readonly unknown[], opts?: { event?: string; topic?: string }): number;
  setInitial(initial: SseChannelOptions["initial"]): void;
  clearInitial(): void;
  close(): void;
}
interface SseSubscribeOptions { topics?: Iterable<string>; lastEventId?: string }
interface SseInitialContext { replay: "none" | "miss"; lastEventId?: string; topics: ReadonlySet<string> }
interface SseSubscription {
  readonly writer?: SseWriter;
  readonly replay: "none" | "hit" | "current" | "miss";
  readonly replayed: number;
  readonly ready: Promise<void>;     // the initial state or replay is queued
  unsubscribe(): void;
}
// bun-nest (rxjs is Nest's dependency, not bun-common's)
function channelObservable(channel: SseChannel, opts?: SseSubscribeOptions & { signal?: AbortSignal }): Observable<MessageEvent>;
```

What changed from the brief, on measurement or by test:

- **`send()` never awaits, and returns the number of subscribers reached.** A
  hub that awaits each writer stalls everyone behind a stalled one (the
  `await-each` control).
- **One heartbeat timer per channel**, not one per subscriber: the writers are
  opened with `heartbeatMs: 0` and the channel writes one pre-encoded `:` to
  all.
- **The transport carries the structured message (with its id), not encoded
  bytes**, so a `listen()` subscriber (Nest) in another process gets remote
  events too; each process encodes once on receipt, still once per event per
  process.
- **The §16 writer's `send()` should return shared promises** (one resolved
  constant under the high-water mark, one drain promise per backed-up
  period). No API change; it removes the promise pile-up measured above.
- **A closed channel answers 204**, which tells `EventSource` to stop
  reconnecting (WHATWG HTML §9.2), rather than opening a stream to close it.
- **An async `initial` holds live events** for that subscriber until the
  snapshot is queued, then sends snapshot then held events. A rejected
  `initial()` goes to `onError` and the held events still go out.

### The replay-miss rule

On subscribe, with a `Last-Event-ID`:

1. **Found in the buffer, with later events: `"hit"`.** Send the later events
   (filtered by the subscriber's topics), as one chunk, and **not** the
   initial state.
2. **Found, and it is the newest: `"current"`.** Send nothing; the client is
   up to date.
3. **Not found: `"miss"`.** It is older than the buffer, from another process
   instance, from Nest's own numbering (C4), or garbage: the buffer cannot
   say what was missed, and replaying part of it would hide a gap. Treat the
   client as new: send the initial state, and tell `initial` it is a miss
   (`ctx.replay === "miss"`, `ctx.lastEventId`), so an application can
   prepend a `reset` event or send a fuller snapshot. With no `initial`, a
   missed client just gets live events, and `subscription.replay` says
   `"miss"`.

Matching is by exact id string, never by numeric order, so caller-supplied ids
work, and assigned ids carry a per-instance prefix so a restarted process
cannot match an old id to a new event (`plain-ids` control). Replay applies
only to `send()`/`sendList()` events, not to the initial state.

### Topics: an index, not a predicate

A `Map<topic, Set<subscriber>>` costs ~130 bytes per membership and makes a
topic send proportional to its recipients (3.4 µs to reach 100 of 1,000); a
predicate over every subscriber costs as much as a broadcast (20.8 µs), for
every topic send, however few it reaches. Semantics: a send without a topic
reaches everyone; a send with one reaches only that topic's subscribers; a
subscriber with no topics gets broadcasts only (never another room's events by
default). One topic per event; subscribers may hold several.

### The cross-process transport

```ts
interface SseTransportEnvelope { origin: string; message: SseMessage; topic?: string }
interface SseChannelTransport {
  publish(envelope: SseTransportEnvelope): void | Promise<void>;
  subscribe(listener: (envelope: SseTransportEnvelope) => void): () => void;
}
```

The channel is process-local by design. With a transport it delivers each
local send at once, publishes it, ignores its own echo (`origin`), and
delivers and buffers each remote one. Ids are assigned by the sending process,
so replay works on any process that saw the event (test: two channels on an
in-memory bus). Ordering is per receiver: the order a process received events
in, which the transport defines. The envelope must be JSON-serialisable; the
in-memory bus round-trips it through JSON, as a wire would. No adapter ships:
Redis pub/sub, NATS or Postgres `LISTEN` fit in ~20 lines each.

### The Nest pairing

`@Sse()` returning `channelObservable(channel, { lastEventId, signal })` gives
Nest subscribers the initial state, replay and live events, and unsubscribes
when the client goes, on bun-nest and Express, Nest 11.1.27 to 12.1.3. Nest's
own unsubscribe suffices; `@SseSignal()` (Nest 11.2.0+) is a second, earlier path,
used when present. Three limits, documented rather than worked around: Nest
formats per subscriber (55–152× the byte path; `@Res()` +
`channel.subscribe()` keeps encode-once on bun-nest); Nest numbers events
without ids, so an initial-state id is Nest's (a reconnect with it is a miss,
which is still correct); and the channel's heartbeat does not reach Nest
subscribers on 11.1.x, which has no comment event (on 11.2.0+ the adapter
could emit `{ comment: "" }`), so they rely on PR-sse1's idle exemption.

### Which §16 guarantees hold through the hub

| §16 guarantee | Through the channel |
|---|---|
| Backpressure | **Becomes the bound.** A broadcast cannot wait for its slowest reader without stalling the others, so the channel never awaits; awaitable `send()` stays for one-writer code |
| Bounded queue (`maxQueuedBytes`) | **Holds**: the stalled client was dropped at 10.5–10.7 MiB offered in 12 of 12 cells, and unregistered. Its promise overhead is not bounded by it today: hence shared promises |
| Heartbeat | **Holds, cheaper**: one timer for the channel. Not for Nest's `listen()` subscribers (above) |
| Idle exemption | **Holds**: `subscribe()` opens `res.sse()`, `response()` passes `server`. Nest relies on PR-sse1 fix 2 |
| Stop on disconnect | **Holds**, served and `fetch()`, through the writer's `onClose`; not through `req.signal`, which `fetch()` never aborts on cancel |
| Encode once | **Holds** on the byte path (1 encoder call, one shared object); lost on Nest's `@Sse()` path by Nest's design |

### Names needing approval

| Proposed | Kind | Alternatives |
|---|---|---|
| `createSseChannel(options?)`, `SseChannel`, `SseChannelOptions` | function, class, type | `SseHub`, `SseBroadcaster`, `createSseBroadcast` |
| `initial`, `setInitial()`, `clearInitial()` | option, methods | express-sse's `updateInit`/`dropInit`; `snapshot` |
| `replay` | option (event count) | `history`, `bufferSize`, `replayLast` |
| `subscribe(req, res, opts?)`, `handler(opts?)`, `response(request, init?)` | methods | `connect`, `route()`, `toResponse()` |
| `attach(writer, opts?)`, `listen(fn, opts?)` | methods | `add`, `addWriter`, `onMessage` |
| `send(message, { topic })`, `sendList(items, opts)` | methods | `broadcast`, `publish`; `sendEach`, `serialize` (express-sse's) |
| `size`, `closed`, `close()` | members | `count`, `subscribers` |
| `SseSubscription` (`replay`: `"none"`/`"hit"`/`"current"`/`"miss"`, `replayed`, `ready`, `unsubscribe`) | type | `resumed: boolean` |
| `SseInitialContext` | type | — |
| `topics` / `topic` | options | `rooms`, `channels` |
| `SseChannelTransport`, `SseTransportEnvelope` | types | `SseChannelAdapter`, `SseBridge` |
| `idPrefix` | option | `idEpoch` |
| `channelObservable(channel, opts?)` (bun-nest) | function | `fromSseChannel`, `toObservable` |

### Open questions

| # | Question | Recommended |
|---|---|---|
| C1 | Where does the channel live? | bun-common `lib/sse/`, exported from the root and `./sse`. It needs no runtime import beyond the writer (`subscribe()` calls `res.sse()`), so the `./sse` entry stays dependency-free. `channelObservable` in bun-nest |
| C2 | Adopt shared promises in the §16 writer's `send()`? | Yes, in PR-sse2: −87 MiB RSS at a stalled client's drop, half the cost per send, no API change |
| C3 | Replay default? | Off (`0`); ids are assigned only when replay is on, so a channel without it sends exactly what the caller gave |
| C4 | On a miss, send a marker event by default? | No: the initial state, with `ctx.replay === "miss"` for the app to mark it. A default `reset` event would be a protocol the client did not ask for |
| C5 | A subscriber with no topics: broadcasts only, or everything? | Broadcasts only. A wildcard (`"*"`) can come later if asked |
| C6 | A replay bound in bytes as well as events? | Not in v1: count only, documented (the buffer holds the encoded bytes, so N × event size) |
| C7 | Ship a transport adapter (Redis)? | No: the interface, and the in-memory bus as a test helper. bun-jobs' Redis driver could offer one later |
| C8 | Nest heartbeat? | `channelObservable` emits `{ comment: "" }` every `heartbeatMs` on Nest ≥ 11.2 (detect `comment` support), and relies on the idle exemption on 11.1.x |
| C9 | express-sse's positional `send(data, event, id)`? | No: `send(message)` with `SseMessage`, like the writer. Migration is one line, documented |
| C10 | A graceful `close()` (a final event, then end)? | Not in v1: `close()` ends streams and later requests get 204, as §16's S9 decided for `adapter.close()` |
| C11 | The perf run's machine was loaded (load 5.7→46) | The memory, drop and per-round claims stand; re-run `channel-perf.ts` exclusive (`HEAVY_EXCLUSIVE=1`) before quoting absolute events/s in the plan |
