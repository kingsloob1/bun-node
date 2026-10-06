# Scenario benchmark (wrk)

Bun 1.4.2 · 4 CPUs · wrk -t2 -c64 · 3 rounds × 5s after a 2s warm-up, medians · a fresh server process per cell, pinned to CPU 0 (wrk on the rest).

| Scenario | What it does |
|---|---|
| wildcard | GET /assets/css/site/app.css, a /assets/* route |
| headers | GET /headers, 3 response headers set |

## Requests per second (median)

| Framework | wildcard | headers |
|---|---:|---:|
| bun-common (BunHttpAdapter) | 39,286 | 30,461 |
| bun-nest (Nest 11) | 23,260 | 20,244 |
| Express 5 (on Bun) | 13,656 | 15,582 |
| Hono | 27,303 | 35,094 |
| Elysia 1.4 | 29,252 | 32,714 |
| Elysia 2 (beta) | 48,849 | 35,648 |
| Bun.serve routes (floor) | **61,083** | **51,177** |
| hyper-express (Node.js) | 31,621 | 25,397 |

## Relative to the fastest in each scenario

| Framework | wildcard | headers |
|---|---:|---:|
| bun-common (BunHttpAdapter) | 64% | 60% |
| bun-nest (Nest 11) | 38% | 40% |
| Express 5 (on Bun) | 22% | 30% |
| Hono | 45% | 69% |
| Elysia 1.4 | 48% | 64% |
| Elysia 2 (beta) | 80% | 70% |
| Bun.serve routes (floor) | 100% | 100% |
| hyper-express (Node.js) | 52% | 50% |

## Latency p50 / p99 (ms, median of rounds)

| Framework | wildcard | headers |
|---|---:|---:|
| bun-common (BunHttpAdapter) | 1.41 / 4.50 | 1.93 / 4.72 |
| bun-nest (Nest 11) | 2.53 / 7.03 | 2.87 / 7.75 |
| Express 5 (on Bun) | 4.14 / 14.46 | 3.78 / 13.74 |
| Hono | 2.20 / 4.20 | 1.69 / 4.24 |
| Elysia 1.4 | 2.04 / 5.12 | 1.84 / 4.29 |
| Elysia 2 (beta) | 1.15 / 3.29 | 1.67 / 4.29 |
| Bun.serve routes (floor) | 0.98 / 2.41 | 1.14 / 3.16 |
| hyper-express (Node.js) | 1.91 / 4.16 | 2.44 / 5.05 |

## Not measured

- hyper-express (Bun): failed to start — TypeError: symbol 'napi_register_module_v1' not found in native module. Is this a Node API (napi) module?
