# Scenario benchmark (wrk)

Bun 1.4.2 · 4 CPUs · wrk -t2 -c64 · 3 rounds × 5s after a 2s warm-up, medians · a fresh server process per cell, pinned to CPU 0 (wrk on the rest).

| Scenario | What it does |
|---|---|
| static | GET /static |
| param | GET /user/42 |
| middleware | GET /mw/hit behind 3 middleware |
| routes-1000 | GET /r999/7, the last of 1000 param routes |
| param-random | GET /r999/<fresh 8-digit id> per request |
| json | POST /json {"n":7}, JSON reply |
| async | GET /async, a handler that awaits once |
| headers | GET /headers, 3 response headers set |

## Requests per second (median)

| Framework | static | param | middleware | routes-1000 | param-random | json | async | headers |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| bun-common (BunHttpAdapter) | 41,355 | 42,238 | 40,911 | 39,937 | 33,414 | 19,476 | 33,277 | 29,677 |
| bun-nest (Nest 11) | 23,229 | 20,683 | 19,916 | 21,104 | 18,273 | 12,884 | 23,825 | 21,743 |
| Express 5 (on Bun) | 15,865 | 15,001 | 13,596 | 3,652 | 3,558 | 8,957 | 14,692 | 15,605 |
| Hono | 48,880 | 21,274 | 30,002 | 21,875 | 23,091 | 23,022 | 43,018 | 35,424 |
| Elysia 1.4 | 40,920 | 32,856 | 23,138 | 23,192 | 25,286 | 25,262 | 37,207 | 31,129 |
| Elysia 2 (beta) | 51,219 | 44,287 | 34,289 | **46,543** | **50,781** | 25,434 | 43,492 | 38,112 |
| Bun.serve routes (floor) | **59,218** | **60,925** | **58,458** | 23,159 | 27,147 | **29,710** | **52,297** | **51,470** |
| hyper-express (Node.js) | 32,886 | 28,324 | 30,663 | 23,231 | 24,633 | 20,105 | 28,903 | 24,552 |

## Relative to the fastest in each scenario

| Framework | static | param | middleware | routes-1000 | param-random | json | async | headers |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| bun-common (BunHttpAdapter) | 70% | 69% | 70% | 86% | 66% | 66% | 64% | 58% |
| bun-nest (Nest 11) | 39% | 34% | 34% | 45% | 36% | 43% | 46% | 42% |
| Express 5 (on Bun) | 27% | 25% | 23% | 8% | 7% | 30% | 28% | 30% |
| Hono | 83% | 35% | 51% | 47% | 45% | 77% | 82% | 69% |
| Elysia 1.4 | 69% | 54% | 40% | 50% | 50% | 85% | 71% | 60% |
| Elysia 2 (beta) | 86% | 73% | 59% | 100% | 100% | 86% | 83% | 74% |
| Bun.serve routes (floor) | 100% | 100% | 100% | 50% | 53% | 100% | 100% | 100% |
| hyper-express (Node.js) | 56% | 46% | 52% | 50% | 49% | 68% | 55% | 48% |

## Latency p50 / p99 (ms, median of rounds)

| Framework | static | param | middleware | routes-1000 | param-random | json | async | headers |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| bun-common (BunHttpAdapter) | 1.37 / 4.11 | 1.35 / 4.21 | 1.45 / 4.03 | 1.45 / 4.52 | 1.63 / 9.37 | 3.06 / 7.88 | 1.83 / 4.91 | 2.01 / 4.91 |
| bun-nest (Nest 11) | 2.54 / 6.89 | 2.85 / 8.22 | 2.96 / 7.67 | 2.85 / 7.11 | 3.13 / 10.78 | 4.48 / 11.59 | 2.51 / 6.64 | 2.74 / 7.06 |
| Express 5 (on Bun) | 3.67 / 12.98 | 3.87 / 11.73 | 4.19 / 11.50 | 15.11 / 36.55 | 15.51 / 40.85 | 5.95 / 66.86 | 3.90 / 10.58 | 3.71 / 12.71 |
| Hono | 1.19 / 3.02 | 2.76 / 5.85 | 2.06 / 3.95 | 2.74 / 5.45 | 2.58 / 5.16 | 2.68 / 4.78 | 1.39 / 3.45 | 1.72 / 4.07 |
| Elysia 1.4 | 1.38 / 4.04 | 1.87 / 4.17 | 2.66 / 5.45 | 2.64 / 5.57 | 2.44 / 5.32 | 2.44 / 5.54 | 1.61 / 4.39 | 1.94 / 4.52 |
| Elysia 2 (beta) | 1.10 / 3.34 | 1.27 / 3.59 | 1.76 / 5.06 | 1.25 / 3.76 | 1.13 / 3.87 | 2.41 / 5.42 | 1.33 / 3.77 | 1.60 / 4.01 |
| Bun.serve routes (floor) | 0.97 / 3.06 | 0.98 / 2.70 | 0.98 / 2.77 | 2.63 / 5.11 | 2.28 / 4.70 | 2.12 / 3.98 | 1.10 / 2.86 | 1.18 / 2.90 |
| hyper-express (Node.js) | 1.91 / 3.98 | 2.19 / 4.35 | 2.01 / 4.40 | 2.67 / 5.20 | 2.55 / 5.16 | 3.01 / 5.55 | 2.16 / 4.43 | 2.50 / 4.94 |

## Not measured

- hyper-express (Bun): failed to start — TypeError: symbol 'napi_register_module_v1' not found in native module. Is this a Node API (napi) module?

_Command: `bun wrk.ts --rounds 3` (2026-10-04). Absolute req/s depend on the machine: this VM had been up under an hour and measured every target at roughly half what an earlier session's machine did, so compare within this table, not across runs._
