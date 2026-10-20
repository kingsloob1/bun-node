# `JSON.stringify` on a deeply nested array takes 0.8–1.5 s past ~30,000 levels

| | |
|---|---|
| **Bun** | 1.4.3 (`c6da4a4d`) and 1.4.4-canary.1 (`5f5799ed`), Linux x64 |
| **Status** | Filed: [oven-sh/bun#45791](https://github.com/oven-sh/bun/issues/45791) |
| **Reproduction** | [`json-stringify-deep-nesting-slow.ts`](./json-stringify-deep-nesting-slow.ts) (exits 1 while present) |
| **Worked around in** | bun-nest's tests only: `__tests__/websocketDeepPayload.nest.test.ts` (waits for the server's `RangeError`, not a fixed time) and `__tests__/websocketAdapter.test.ts` ("a packet that cannot be serialised", its own 30 s deadline) |

## What happens

`JSON.parse` accepts any depth in milliseconds. `JSON.stringify` of the value
it returns is linear up to about 28,000 levels, then about 1,000 times slower:

```
fast  depth 28000   0.9 ms, ok
SLOW  depth 32000   902.1 ms, ok
SLOW  depth 200000  1572.2 ms, RangeError
```

Node v24.2.0 throws `RangeError` from 5,000 levels on, in about 6 ms at any
depth.

## Why it is a bug

It is a performance cliff, not a wrong answer: a 14% deeper value costs a
thousand times more, and rejecting an over-deep value costs 1.5 s of CPU. A
server that echoes a client's parsed message (bun-nest's WebSocket adapter
guards the `JSON.stringify` of every reply) spends that on each such message,
and tests that make it happen need seconds of slack under load: two of
bun-nest's timed out at loads of 42 and more.

## What to remove once it is fixed

Nothing has to go: the two tests stay correct. Their deadlines (`STEP_MS` in
the deep-payload test, `DEADLINE_MS` in the adapter test) can come back down,
and their comments citing the 1.4 s cost should be updated.
