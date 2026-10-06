# Scenario benchmark (wrk)

Bun 1.4.2 · 4 CPUs · wrk -t2 -c64 · 3 rounds × 5s after a 2s warm-up, medians · a fresh server process per cell, pinned to CPU 0 (wrk on the rest).

| Scenario | What it does |
|---|---|
| multipart | POST /upload, a field and a 1 KiB file (multipart/form-data) |

## Requests per second (median)

| Framework | multipart |
|---|---:|
| bun-common (BunHttpAdapter) | 21,375 |
| bun-nest (Nest 11) | 12,367 |
| Express 5 (on Bun) | ✗ |
| Hono | 37,387 |
| Elysia 1.4 | 38,166 |
| Elysia 2 (beta) | 36,675 |
| Bun.serve routes (floor) | **47,375** |
| hyper-express (Node.js) | 16,364 |

## Relative to the fastest in each scenario

| Framework | multipart |
|---|---:|
| bun-common (BunHttpAdapter) | 45% |
| bun-nest (Nest 11) | 26% |
| Express 5 (on Bun) | ✗ |
| Hono | 79% |
| Elysia 1.4 | 81% |
| Elysia 2 (beta) | 77% |
| Bun.serve routes (floor) | 100% |
| hyper-express (Node.js) | 35% |

## Latency p50 / p99 (ms, median of rounds)

| Framework | multipart |
|---|---:|
| bun-common (BunHttpAdapter) | 2.62 / 9.47 |
| bun-nest (Nest 11) | 4.48 / 22.60 |
| Express 5 (on Bun) | ✗ |
| Hono | 1.61 / 3.53 |
| Elysia 1.4 | 1.57 / 4.06 |
| Elysia 2 (beta) | 1.63 / 4.24 |
| Bun.serve routes (floor) | 1.22 / 3.20 |
| hyper-express (Node.js) | 3.63 / 6.89 |

## Not measured

- Express 5 (on Bun) · multipart: not supported — no built-in multipart parser (needs multer)
- hyper-express (Bun): failed to start — TypeError: symbol 'napi_register_module_v1' not found in native module. Is this a Node API (napi) module?
