# Scenario benchmark (wrk)

Bun 1.4.2 · 4 CPUs · wrk -t2 -c64 · 3 rounds × 5s after a 2s warm-up, medians · a fresh server process per cell, pinned to CPU 0 (wrk on the rest).

| Scenario | What it does |
|---|---|
| json | POST /json {"n":7}, JSON reply |
| urlencoded | POST /form a=1&b=two, the parsed fields back as JSON |
| multipart | POST /upload, a field and a 1 KiB file (multipart/form-data) |
| binary | POST /binary, 1 KiB application/octet-stream, its size back |
| text | POST /text hello world (text/plain), its length back |
| xml | POST /xml <root><n>7</n></root>, the parsed value back |

## Requests per second (median)

| Framework | json | urlencoded | multipart | binary | text | xml |
|---|---:|---:|---:|---:|---:|---:|
| bun-common (BunHttpAdapter) | 20,198 | 18,180 | 5,838 | 18,865 | 20,467 | **19,916** |
| bun-nest (Nest 11) | 13,581 | 12,890 | 3,149 | 11,477 | 13,436 | 12,630 |
| Express 5 (on Bun) | 8,598 | 7,440 | ✗ | 8,946 | 9,251 | ✗ |
| Hono | 22,652 | 19,311 | 16,834 | 22,858 | 24,233 | ✗ |
| Elysia 1.4 | 24,562 | 24,794 | 16,528 | 22,603 | 26,100 | ✗ |
| Elysia 2 (beta) | 24,861 | 23,900 | 16,894 | 22,079 | 25,442 | ✗ |
| Bun.serve routes (floor) | **30,231** | **25,809** | **20,831** | **26,510** | **30,113** | ✗ |
| hyper-express (Node.js) | 19,370 | 19,514 | 7,882 | 20,035 | 20,304 | ✗ |

## Relative to the fastest in each scenario

| Framework | json | urlencoded | multipart | binary | text | xml |
|---|---:|---:|---:|---:|---:|---:|
| bun-common (BunHttpAdapter) | 67% | 70% | 28% | 71% | 68% | 100% |
| bun-nest (Nest 11) | 45% | 50% | 15% | 43% | 45% | 63% |
| Express 5 (on Bun) | 28% | 29% | ✗ | 34% | 31% | ✗ |
| Hono | 75% | 75% | 81% | 86% | 80% | ✗ |
| Elysia 1.4 | 81% | 96% | 79% | 85% | 87% | ✗ |
| Elysia 2 (beta) | 82% | 93% | 81% | 83% | 84% | ✗ |
| Bun.serve routes (floor) | 100% | 100% | 100% | 100% | 100% | ✗ |
| hyper-express (Node.js) | 64% | 76% | 38% | 76% | 67% | ✗ |

## Latency p50 / p99 (ms, median of rounds)

| Framework | json | urlencoded | multipart | binary | text | xml |
|---|---:|---:|---:|---:|---:|---:|
| bun-common (BunHttpAdapter) | 2.91 / 7.15 | 3.17 / 8.58 | 8.78 / 39.69 | 3.05 / 10.06 | 2.92 / 6.66 | 3.00 / 7.09 |
| bun-nest (Nest 11) | 4.36 / 11.10 | 4.59 / 10.14 | 16.76 / 55.57 | 4.84 / 17.33 | 4.37 / 10.36 | 4.62 / 12.82 |
| Express 5 (on Bun) | 6.22 / 39.11 | 6.76 / 59.53 | ✗ | 5.89 / 52.91 | 5.84 / 55.08 | ✗ |
| Hono | 2.70 / 5.74 | 3.09 / 7.75 | 3.61 / 7.61 | 2.67 / 5.72 | 2.58 / 4.84 | ✗ |
| Elysia 1.4 | 2.49 / 6.48 | 2.46 / 5.99 | 3.58 / 8.38 | 2.56 / 7.50 | 2.27 / 6.15 | ✗ |
| Elysia 2 (beta) | 2.50 / 5.80 | 2.52 / 5.74 | 3.48 / 7.60 | 2.63 / 7.68 | 2.38 / 5.76 | ✗ |
| Bun.serve routes (floor) | 2.07 / 4.39 | 2.38 / 5.02 | 2.81 / 6.66 | 2.20 / 7.50 | 2.03 / 4.38 | ✗ |
| hyper-express (Node.js) | 3.10 / 6.27 | 3.13 / 5.61 | 7.58 / 15.50 | 3.04 / 5.91 | 2.96 / 5.70 | ✗ |

## Not measured

- Express 5 (on Bun) · multipart: not supported — no built-in multipart parser (needs multer)
- Express 5 (on Bun) · xml: not supported — no built-in XML parser
- Hono · xml: not supported — no built-in XML parser
- Elysia 1.4 · xml: not supported — no built-in XML parser
- Elysia 2 (beta) · xml: not supported — no built-in XML parser
- Bun.serve routes (floor) · xml: not supported — no built-in XML parser
- hyper-express (Node.js) · xml: not supported — no built-in XML parser
- hyper-express (Bun): failed to start — TypeError: symbol 'napi_register_module_v1' not found in native module. Is this a Node API (napi) module?
