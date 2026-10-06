# Scenario benchmark (wrk)

Bun 1.4.2 · 4 CPUs · wrk -t2 -c64 · 3 rounds × 5s after a 2s warm-up, medians · a fresh server process per cell, pinned to CPU 0 (wrk on the rest).

| Scenario | What it does |
|---|---|
| static | GET /static |
| param | GET /user/42 |
| middleware | GET /mw/hit behind 3 middleware |
| async | GET /async, a handler that awaits once |
| headers | GET /headers, 3 response headers set |
| json | POST /json {"n":7}, JSON reply |
| text | POST /text hello world (text/plain), its length back |
| multipart | POST /upload, a field and a 1 KiB file (multipart/form-data) |

## Requests per second (median)

| Framework | static | param | middleware | async | headers | json | text | multipart |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| bun-common (BunHttpAdapter) | 73,686 | 77,745 | 72,955 | 68,498 | 66,616 | 52,469 | 55,559 | 29,518 |
| bun-nest (Nest 11) | 52,634 | 47,644 | 45,345 | 50,901 | 47,467 | 30,579 | 32,608 | 15,095 |
| Elysia 2 (beta) | **95,342** | **90,511** | **73,216** | **80,351** | **74,999** | **60,022** | **60,234** | **38,986** |

## Relative to the fastest in each scenario

| Framework | static | param | middleware | async | headers | json | text | multipart |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| bun-common (BunHttpAdapter) | 77% | 86% | 100% | 85% | 89% | 87% | 92% | 76% |
| bun-nest (Nest 11) | 55% | 53% | 62% | 63% | 63% | 51% | 54% | 39% |
| Elysia 2 (beta) | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |

## Latency p50 / p99 (ms, median of rounds)

| Framework | static | param | middleware | async | headers | json | text | multipart |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| bun-common (BunHttpAdapter) | 0.74 / 3.06 | 0.71 / 2.59 | 0.77 / 3.13 | 0.82 / 2.90 | 0.86 / 2.89 | 1.09 / 3.64 | 1.06 / 3.45 | 1.92 / 6.73 |
| bun-nest (Nest 11) | 1.08 / 4.18 | 1.23 / 4.04 | 1.28 / 5.57 | 1.11 / 4.24 | 1.23 / 4.30 | 1.90 / 5.88 | 1.85 / 5.09 | 3.50 / 18.51 |
| Elysia 2 (beta) | 0.60 / 2.16 | 0.63 / 2.38 | 0.79 / 2.98 | 0.70 / 2.55 | 0.77 / 2.63 | 0.98 / 2.84 | 0.96 / 2.90 | 1.50 / 4.11 |
