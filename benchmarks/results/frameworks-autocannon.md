# Framework benchmark (autocannon) — 2026-10-04

Command: `bun bench.ts -r all -f all -c 100 --workers 2` (10 s per run after a 3 s warm-up, BUN_OPTIONS unset). Raw output below.

```
Router throughput benchmark
  Bun 1.4.2  ·  4 CPUs
  frameworks: bun-router, express, bun-serve, bun-fetch, elysia, elysia2, hono, hyper-express-node, hyper-express-bun  ·  scenarios: static, param, deep, wildcard, middleware, notfound, mixed
  middleware chain length: 5

  ! Skipping hyper-express (Bun): failed to start — TypeError: symbol 'napi_register_module_v1' not found in native module. Is this a Node API (napi) module?

  Scenario: static  GET /ping  —  100 conns, 10s, pipelining 1
  -----------------------------------------------------------------------------------------------------
  Framework                          Req/s    Latency avg    Latency p99      Throughput        vs best
  -----------------------------------------------------------------------------------------------------
  Bun.serve (routes)                72,088        0.88 ms        5.00 ms       8.04 MB/s   1.00x (best)
  Elysia 1.4                        70,088        0.95 ms        5.00 ms       7.82 MB/s          1.03x
  Elysia 2 (beta)                   68,080        1.03 ms        5.00 ms       7.60 MB/s          1.06x
  Bun.serve (fetch)                 65,264        1.10 ms        5.00 ms       7.28 MB/s          1.10x
  Hono                              59,814        1.22 ms        6.00 ms       6.67 MB/s          1.21x
  hyper-express (Node.js)           57,296        1.27 ms        5.00 ms       4.21 MB/s          1.26x
  BunRouter (bun-common)            57,206        1.28 ms        5.00 ms       6.38 MB/s          1.26x
  Express 5                         23,317        3.79 ms       10.00 ms       5.07 MB/s          3.09x

  Scenario: param  GET /user/42  —  100 conns, 10s, pipelining 1
  -----------------------------------------------------------------------------------------------------
  Framework                          Req/s    Latency avg    Latency p99      Throughput        vs best
  -----------------------------------------------------------------------------------------------------
  Elysia 1.4                        64,877        1.11 ms        5.00 ms       7.24 MB/s   1.00x (best)
  Bun.serve (fetch)                 63,704        1.14 ms        5.00 ms       7.11 MB/s          1.02x
  BunRouter (bun-common)            60,531        1.23 ms        5.00 ms       6.75 MB/s          1.07x
  Elysia 2 (beta)                   60,246        1.24 ms        5.00 ms       6.72 MB/s          1.08x
  Bun.serve (routes)                57,950        1.26 ms        8.00 ms       6.47 MB/s          1.12x
  Hono                              55,075        1.34 ms        6.00 ms       6.15 MB/s          1.18x
  hyper-express (Node.js)           47,629        1.57 ms        5.00 ms       3.50 MB/s          1.36x
  Express 5                         22,586        3.91 ms       10.00 ms       4.91 MB/s          2.87x

  Scenario: deep  GET /api/v1/users/7/books/99  —  100 conns, 10s, pipelining 1
  -----------------------------------------------------------------------------------------------------
  Framework                          Req/s    Latency avg    Latency p99      Throughput        vs best
  -----------------------------------------------------------------------------------------------------
  Bun.serve (fetch)                 66,016        1.12 ms        5.00 ms       7.49 MB/s   1.00x (best)
  Elysia 1.4                        62,693        1.16 ms        5.00 ms       7.11 MB/s          1.05x
  BunRouter (bun-common)            58,661        1.25 ms        5.00 ms       6.66 MB/s          1.13x
  Elysia 2 (beta)                   57,774        1.28 ms        6.00 ms       6.56 MB/s          1.14x
  hyper-express (Node.js)           55,939        1.28 ms        4.00 ms       4.21 MB/s          1.18x
  Hono                              55,930        1.33 ms        6.00 ms       6.35 MB/s          1.18x
  Bun.serve (routes)                53,985        1.39 ms        8.00 ms       6.13 MB/s          1.22x
  Express 5                         21,290        4.19 ms       12.00 ms       4.67 MB/s          3.10x

  Scenario: wildcard  GET /assets/css/site/app.css  —  100 conns, 10s, pipelining 1
  -----------------------------------------------------------------------------------------------------
  Framework                          Req/s    Latency avg    Latency p99      Throughput        vs best
  -----------------------------------------------------------------------------------------------------
  Bun.serve (routes)                71,770        0.90 ms        4.00 ms       8.01 MB/s   1.00x (best)
  Bun.serve (fetch)                 61,523        1.20 ms        5.00 ms       6.86 MB/s          1.17x
  Elysia 2 (beta)                   61,454        1.20 ms        5.00 ms       6.86 MB/s          1.17x
  Elysia 1.4                        60,323        1.24 ms        5.00 ms       6.73 MB/s          1.19x
  Hono                              58,518        1.27 ms        6.00 ms       6.53 MB/s          1.23x
  hyper-express (Node.js)           56,589        1.25 ms        4.00 ms       4.16 MB/s          1.27x
  BunRouter (bun-common)            56,336        1.30 ms        5.00 ms       6.29 MB/s          1.27x
  Express 5                         19,554        4.63 ms       13.00 ms       4.25 MB/s          3.67x

  Scenario: middleware  GET /chain  —  100 conns, 10s, pipelining 1
  -----------------------------------------------------------------------------------------------------
  Framework                          Req/s    Latency avg    Latency p99      Throughput        vs best
  -----------------------------------------------------------------------------------------------------
  Bun.serve (fetch)                 67,936        1.00 ms        5.00 ms       7.58 MB/s   1.00x (best)
  Elysia 1.4                        66,742        1.05 ms        5.00 ms       7.45 MB/s          1.02x
  Bun.serve (routes)                66,512        1.06 ms        6.00 ms       7.42 MB/s          1.02x
  Elysia 2 (beta)                   63,806        1.15 ms        5.00 ms       7.12 MB/s          1.06x
  hyper-express (Node.js)           53,997        1.35 ms        5.00 ms       3.97 MB/s          1.26x
  BunRouter (bun-common)            53,126        1.39 ms        5.00 ms       5.93 MB/s          1.28x
  Hono                              42,890        1.80 ms        7.00 ms       4.79 MB/s          1.58x
  Express 5                         22,298        3.98 ms       11.00 ms       4.85 MB/s          3.05x

  Scenario: notfound  GET /no/such/route/exists/here  —  100 conns, 10s, pipelining 1
  -----------------------------------------------------------------------------------------------------
  Framework                          Req/s    Latency avg    Latency p99      Throughput        vs best
  -----------------------------------------------------------------------------------------------------
  Bun.serve (routes)                68,790        0.96 ms        5.00 ms       8.59 MB/s   1.00x (best)
  BunRouter (bun-common)            67,659        1.05 ms        4.00 ms       5.29 MB/s          1.02x
  Bun.serve (fetch)                 60,526        1.21 ms        6.00 ms       7.56 MB/s          1.14x
  Elysia 1.4                        56,525        1.32 ms        6.00 ms       7.06 MB/s          1.22x
  Elysia 2 (beta)                   55,432        1.34 ms        6.00 ms      10.31 MB/s          1.24x
  hyper-express (Node.js)           53,683        1.35 ms        5.00 ms       4.66 MB/s          1.28x
  Hono                              44,259        1.71 ms        8.00 ms       5.78 MB/s          1.55x
  Express 5                         22,662        3.93 ms       11.00 ms       9.42 MB/s          3.04x

  Scenario: mixed  GET (rotating paths)  —  100 conns, 10s, pipelining 1
  -----------------------------------------------------------------------------------------------------
  Framework                          Req/s    Latency avg    Latency p99      Throughput        vs best
  -----------------------------------------------------------------------------------------------------
  hyper-express (Node.js)           41,376        1.92 ms        7.00 ms       3.05 MB/s   1.00x (best)
  Bun.serve (routes)                33,462        2.31 ms        7.00 ms       3.75 MB/s          1.24x
  Elysia 1.4                        30,363        2.73 ms       11.00 ms       3.40 MB/s          1.36x
  Elysia 2 (beta)                   29,331        2.90 ms       11.00 ms       3.28 MB/s          1.41x
  Bun.serve (fetch)                 29,142        2.96 ms       11.00 ms       3.26 MB/s          1.42x
  BunRouter (bun-common)            29,091        3.00 ms        7.00 ms       3.26 MB/s          1.42x
  Hono                              27,110        3.27 ms       11.00 ms       3.04 MB/s          1.53x
  Express 5                         14,892        6.20 ms       14.00 ms       3.24 MB/s          2.78x

```
