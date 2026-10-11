# A2: one promise per asynchronous pipeline, finished inside it

`wrk-run.ts`, medians, 64 connections, server on CPU 0. `base/*` is
`d5ec29c` (A1 and the `async`/`headers` scenarios landed); the other rows
are the working tree with A2 (`serveRequest` + `ServeHooks`). req/s.

## In process (interleaved, one process, median of 21 rounds × 20k)

[`ab-async.ts`](../ab-async.ts) (`/tmp/claude-0/prev` is a worktree of the comparison commit): both trees' `BunHttpAdapter` loaded side by side,
lean request options, served path (`serveNativeRequest`).

| route | before | after | change |
|---|---:|---:|---:|
| `GET /sync` (sync handler) | 1,698 ns | 1,603 ns | −5.6% |
| `GET /done` (async handler, sends before any await) | 1,918 ns | 1,757 ns | −8.4% |
| `GET /async` (awaits once, then sends) | 4,258 ns | 3,134 ns | **−26.4%** |
| `GET /amw/x` (async middleware, sync handler) | 4,567 ns | 3,160 ns | **−30.8%** |

bun-nest, `nest-breakdown.ts` (BP=1), whole adapter path: 6,937 / 8,118 ns
before, 6,303 / 6,004 ns after (two runs each; before the `ServeHooks`
step, which removed the adapter's own `then`).

## wrk

Run 1 (3 rounds):

| target | async | static | param | middleware |
|---|---:|---:|---:|---:|
| bun-common (A2) | 26,887 | 32,005 | 29,393 | 28,880 |
| base/bun-common | 24,559 | 30,644 | 31,405 | 29,347 |
| change | +9.5% | +4.4% | −6.4% | −1.6% |
| bun-nest (A2) | 19,157 | 21,130 | 17,823 | 17,562 |
| base/bun-nest | 18,763 | 19,309 | 16,533 | 16,245 |
| change | +2.1% | **+9.4%** | **+7.8%** | **+8.1%** |

Run 2 (5 rounds), bun-common's cells:

| target | param | async | static |
|---|---:|---:|---:|
| bun-common (A2) | 30,399 | 24,919 | 31,482 |
| base/bun-common | 30,140 | 23,572 | 30,407 |
| change | +0.9% | +5.7% | +3.5% |

## Gate (plan §6, A2)

- bun-nest GETs ≥ +5%: **met** (static, param, middleware +8–9%).
- bun-common sync scenarios ±5%: **met** (run 1's param −6.4% did not
  reproduce: +0.9% over 5 rounds).
- bun-common `async` ≥ +10%: **not met end to end** — +9.5% and +5.7%
  (−26% in process). Shipped on the bun-nest target, which the plan ranks
  first, with this shortfall recorded.

An earlier variant resumed synchronously inside `res.send()` and measured
−25% on `/async` before the `ServeHooks` step, but a `next(err)` called
right after `res.send()` in the same tick then never reached the error
handlers, which Express runs; it was reverted, and
`__tests__/asyncWait.test.ts` pins the rule.
