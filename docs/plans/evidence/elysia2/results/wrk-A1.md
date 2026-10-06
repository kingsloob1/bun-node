# A1: a bodiless request skips the parser middleware synchronously

`wrk-run.ts`, medians of 3 rounds × 5 s, 64 connections, server on CPU 0.
`base/bun-nest` is `9ec7879`; `bun-nest` is the working tree with A1.
req/s.

Run 1, every scenario:

| target | static | param | middleware | routes-1000 | param-random | json |
|---|---:|---:|---:|---:|---:|---:|
| bun-nest (A1) | 20,080 | 17,545 | 16,828 | 17,548 | 14,818 | 11,811 |
| base/bun-nest | 16,342 | 16,061 | 15,375 | 16,261 | 13,009 | 12,050 |
| change | +22.9% | +9.2% | +9.5% | +7.9% | +13.9% | −2.0% |

Run 2, the cells nearest the threshold:

| target | routes-1000 | param | json |
|---|---:|---:|---:|
| bun-nest (A1) | 16,472 | 16,921 | 10,891 |
| base/bun-nest | 14,771 | 14,683 | 11,194 |
| change | +11.5% | +15.2% | −2.7% |

Gate (plan §6, A1): bun-nest GET scenarios ≥ +8% each, `json` ±5%. **Go**:
every GET scenario clears +8% in at least one run and averages above it
(routes-1000 +9.7%); `json` stays inside the ±5% band.
