# OpenTelemetry probes

Backs the cost and context-propagation claims in `../../opentelemetry.md`.
A standalone Bun project — not a workspace member, not in `PROJECTS`.

```bash
bun install
bun probe.ts        # no-op and ALS costs, context propagation
bun probe2.ts       # SDK-on span cost, sampler cost (500k iterations)
bun serve-als.ts    # does a Bun.serve handler inherit an ALS store?
bun worker-als.ts   # does a Worker see the parent's ALS store?
```

## What these established

Measured on Bun 1.4.3-canary.1. Re-run before trusting; a Bun release can
move any of it.

| Operation | ns/op |
|---|---:|
| no-op `startSpan` + `end` | 24.1 |
| no-op `startActiveSpan(name, fn)` | **184.4** |
| ALS `context.with` | 63.9 |
| SDK on: `startSpan` + 6 attributes + `end` | **1,193** |
| SDK on, `AlwaysOff` sampler | 527 |

Two consequences the plan leans on:

1. **`startActiveSpan` costs ~184 ns even as a no-op**, so "telemetry off" must
   be an `undefined` check on an instance field with the traced body in a
   separate method — never a null-object tracer.
2. **Sampling out is not free** (527 ns), so an always-on hook point that
   samples away is still a cost.

`serve-als.ts` and `worker-als.ts` establish the propagation boundaries: a
`Bun.serve` handler starts with **no inherited ALS store** even when the caller
is inside one; a store entered *inside* the handler survives timers, `await`,
a failed `fetch` and concurrent interleaved requests with no cross-contamination;
and a `Worker` sees nothing, which is why the runner protocol has to carry
trace context explicitly.

`import("bun:otel")` failed at the time of measurement (`Cannot find package
'otel'`). Bun PR #39965 was open and unmerged.
