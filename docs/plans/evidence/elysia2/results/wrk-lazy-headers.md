# Lazy request headers (`28804fa` against `088fb34`)

`wrk-run.ts --rounds 3`, 64 connections, server pinned to one CPU, `base/*`
served from a worktree of `088fb34`; medians, req/s
(`../../bun-native-routes/results/wrk/elysia2-lazy-headers.json`). `wrk`
sends a `Host` header only, so this is the smallest headers object Bun
builds; a browser-sized request costs more to materialise (13% of raw
throughput against 4% here, measured before the change).

| target | static | param | routes-1000 | param-random | async | headers | json |
|---|---:|---:|---:|---:|---:|---:|---:|
| elysia2 | 115,744 | 105,559 | 99,806 | 101,025 | 101,597 | 82,150 | 59,943 |
| bun-common, before | 80,220 | 80,838 | 83,654 | 58,005 | 69,251 | 73,131 | 51,513 |
| bun-common, after | 101,950 | 91,844 | 90,415 | 65,274 | 77,693 | 72,579 | 51,434 |
| change | **+27%** | **+14%** | **+8%** | **+13%** | **+12%** | −1% | 0% |
| bun-common / elysia2 | 88% | 87% | 91% | 65% | 76% | 88% | 86% |
| bun-nest, before | 54,797 | 50,501 | 49,840 | 40,395 | 54,609 | 49,977 | 34,032 |
| bun-nest, after | 56,026 | 49,735 | 51,299 | 39,495 | 56,490 | 48,409 | 32,654 |

- The gain is on every GET that reads no header: the request's `Headers` is
  never built. `headers` (reads a request header) and `json` (has a body)
  build it either way, and do not move.
- bun-nest does not move: its default body parsers check `hasBody`, which
  reads `Content-Length`/`Transfer-Encoding` — exact there needs them (a
  declared empty body still runs through a parser's `type`, limit and
  `rawBody`).
- The machine was quieter than for `progress-98f18ab.md` (Elysia 2 static
  115k here, 49k there), so compare ratios across files, not req/s.
- During round 1 the working tree was stashed for a few seconds; a round
  served from it then would have measured the base, which only lowers the
  "after" medians.
