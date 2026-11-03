# A `node:net` write after the peer closed emits no `'error'`, so the `mongodb` driver can hang

| | |
|---|---|
| **Bun** | 1.4.4-canary.1+11c367163, Linux x64 |
| **Status** | Filed: [oven-sh/bun#47834](https://github.com/oven-sh/bun/issues/47834) (2026-11-03) |
| **Reproduction** | [`node-net-write-after-peer-close-no-error.ts`](./node-net-write-after-peer-close-no-error.ts) (exits 1 while present) |
| **Worked around in** | Documented only: bun-jobs' README, "High availability", MongoDB (`timeoutMS` in the URL) |

## What happens

A `node:net` socket whose peer has closed its side (the socket's `end` has
arrived) answers a `write()` with `false` and calls the write's callback with `EPIPE`,
but never emits `error` on the socket: it emits `close` with `hadError`
false. Node emits `error` with `EPIPE`, so a caller waiting on the socket
rather than the callback is answered there and not here.

```
write() after the peer closed: false; then: nothing within 2 s
events: end, close
Node v24.2.0 answers: false; then: error (EPIPE); events: end, error(EPIPE)
```

The `mongodb` package (6.21.0 measured) writes each command as
`if (!socket.write(bytes)) await once(socket, "drain")`. Under Bun, a
command written in that window waits for a `drain` that never comes. Measured
on a single-node replica set (`mongo:7` in Docker), with the container killed
and restarted under a client reading in a loop: under Node 24.2.0 the client
recovered (its slowest read 1.0 s); under Bun one read stayed pending for 20 s
and more in two of three runs. In bun-jobs, that was one `queue.add` that
never settled, and a worker that stopped claiming, in three of three runs.
`socketTimeoutMS` did not help. `timeoutMS` (client-side operation timeout)
ended the read with `MongoOperationTimeoutError: Timed out at socket write`
after its 5 s, and the client recovered.

## Why it is a bug

Node's `stream.Writable` contract: a write that fails is reported. Its
callback gets the error and the stream emits `error`, so a caller waiting on
`drain` or `error` (`events.once` rejects on `error`) is answered either way.
Here the callback gets it but the stream never emits it. The issue's
plain-JS reproduction, run under both runtimes:

```
bun:  write() returned false; then: nothing within 2 s; events: end, write callback EPIPE, close false
node: write() returned false; then: error (EPIPE); events: end, write callback EPIPE, error EPIPE
```

## What to remove once it is fixed

The README's advice to set `timeoutMS` on a MongoDB URL for this reason (bun-jobs'
README, "High availability", MongoDB); `timeoutMS` stays worth setting for
its own sake.
