# Host and full target read on demand (`8910d9f`, fix in the next commit, against `c192778`)

`wrk-run.ts`, 64 connections, server on one CPU, `base/*` from a worktree
of `c192778`; medians, req/s
(`../../bun-native-routes/results/wrk/elysia2-lazy-host.json`).

First run, `8910d9f`, 3 rounds:

| target | static | param | routes-1000 | param-random | async | headers | json |
|---|---:|---:|---:|---:|---:|---:|---:|
| elysia2 | 111,867 | 108,794 | 107,794 | 100,104 | 102,357 | 93,933 | 62,935 |
| bun-common, before | 98,068 | 100,851 | 100,729 | 75,171 | 85,024 | 79,442 | 48,279 |
| bun-common, after | 106,872 | 104,014 | 106,961 | 68,780 | 85,589 | 80,141 | 50,218 |
| bun-common / elysia2 | 96% | 96% | 99% | 69% | 84% | 85% | 80% |
| bun-nest, before | 56,037 | 48,417 | 49,171 | 39,189 | 56,769 | 51,181 | 32,531 |
| bun-nest, after | 56,424 | 50,526 | 49,325 | 40,438 | 56,456 | 50,116 | 33,115 |

param-random fell, and stayed down over 5 rounds (76,033 → 67,946): a
route-cache miss handed `options.requestHost` to `matchRoute` for every
candidate route, so the new getter (and `req.host` behind it) ran per
candidate. `matchRoute` now takes the options and reads the host only for a
route with a host pattern. Re-run with that fix, 5 rounds:

| target | param-random | routes-1000 |
|---|---:|---:|
| bun-common, before | 72,319 | 99,983 |
| bun-common, after | 72,928 | 99,079 |

The gain is on a cache hit — static +9%, param +3%, routes-1000 +6% on the
first run, 9–12% in process (`ab-scen.ts`); routes-1000's second figure is
within the run-to-run spread. bun-nest is unchanged: its per-request cost is
elsewhere (the body parsers' header reads, Nest's own layers).
