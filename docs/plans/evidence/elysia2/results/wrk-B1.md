# B1: route-cache admission by hit ratio

`FifoCache` with `admission`: over windows of 4,096 lookups, a window
whose hit ratio is under 25% turns full admission off, and only one new key
in 64 is stored until the ratio recovers. `wrk-run.ts`, medians of 3 rounds,
`base/*` is `b9df92d` (A2). req/s.

| target | param-random | routes-1000 | static |
|---|---:|---:|---:|
| bun-common (B1) | 24,942 | 27,848 | 29,134 |
| base/bun-common | 22,977 | 28,766 | 30,618 |
| change | **+8.5%** | −3.2% | −4.8% |
| bun-nest (B1) | 16,424 | 18,758 | 20,376 |
| base/bun-nest | 15,272 | 19,234 | 19,960 |
| change | **+7.5%** | −2.5% | +2.1% |

Gate (plan §6, B1): `param-random` ≥ +7% in both packages, cached scenarios
±5%. **Go.** The cached paths' hit path only gained two counter updates; their
moves are inside the round-to-round band.

In process, one heap: no difference (fresh 10,442 → 10,514 ns), because the
saving is memory — a 50,000-entry map of layer arrays kept alive and swept
by the GC — which an interleaved A/B in one process shares between both
trees. After 20,000 fresh paths the cache holds 4,344 entries, not 20,000.
