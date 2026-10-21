# `idleTimeout` from 1 to 4 cuts an actively streaming response at 4 s

| | |
|---|---|
| **Bun** | 1.4.4-canary.1 (`6bb5dc19`, measured here), and 1.4.2 (`744846f8`) and 1.4.3 (`c6da4a4d`) as measured in the comment on the issue; Linux x64 |
| **Status** | Filed: [oven-sh/bun#46211](https://github.com/oven-sh/bun/issues/46211) (the streaming case is a comment on it) |
| **Reproduction** | [`idle-timeout-cuts-active-stream.ts`](./idle-timeout-cuts-active-stream.ts) (exits 1 while present; about 18 s) |
| **Worked around in** | Nothing to work around in code: bun-common's adapter sets no `idleTimeout`. Documented where a user can set one: the `server` option's JSDoc in `packages/bun-common/lib/BunHttpAdapter.ts` and the warning under the adapter options in `packages/bun-common/README.md`. A `res.write()` stream already exempts its own request (`req.socket.setTimeout(0)` → `server.timeout(request, 0)`), so only a stream passed to `res.send()` is exposed |

## What happens

A `Bun.serve` response whose body is a stream, writing every 50 ms to a client
that reads every chunk, is cut at the first 4-second timeout sweep when
`idleTimeout` is `1`–`4`. `0` and `5` keep the same stream open:

```
Bun 1.4.4 (6bb5dc19)
open  idleTimeout 0: open at 6000 ms, 240 bytes read
open  idleTimeout 5: open at 6000 ms, 240 bytes read
CUT   idleTimeout 4: TypeError at 4001 ms, 158 bytes read
```

The client is not the cause: a Node v24.2.0 `http.get` reading the same stream
from a separate `Bun.serve` process gets `aborted` at 4044 ms with
`idleTimeout: 4`, and is still open at 6 s with `5`. Every stream shape cuts
the same way (`start` with `enqueue`, `pull`, `type: "direct"`, an async
generator), as do `websocket`, `development`, `error` and an async `fetch`
beside it (all measured 2026-10-21 on 1.4.4-canary.1+6bb5dc195).

Through bun-common's adapter with `server: { idleTimeout: 4 }`, a stream
passed to `res.send()` (a `ReadableStream`, an async generator, a Node
`Readable`) is cut at 4.0 s; a `res.write()` server-sent events stream and a
`Readable` piped into `res` stay open, because opening one calls
`server.timeout(request, 0)`.

The issue's mechanism: usockets keeps timeouts in 4-second ticks, and a value
of 1–4 is one tick, so the deadline is the next sweep, 0–4 s away, whatever
the socket does in between.

## Why it is a bug

`idleTimeout` is documented as the seconds a connection may be **idle**. A
connection writing every 50 ms is not idle. With a value of 4 or less every
streamed response, server-sent events included, is capped at about 4 s, and
an ordinary request can be cut almost at once (the issue's first case).

## What to remove once it is fixed

The warning under the adapter options and in "Streaming and server-sent
events" in `packages/bun-common/README.md`, and the `idleTimeout` sentences of
the `server` option's JSDoc in `packages/bun-common/lib/BunHttpAdapter.ts`.
