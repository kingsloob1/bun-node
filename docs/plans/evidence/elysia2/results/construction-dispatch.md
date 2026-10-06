# Construction and dispatch, toward Elysia 2's context

Three commits on top of B1 (`58d0d97`):

- `9c5b523` — build nothing a request does not need (no options copy, no
  init-task array, lazy empty query and cookies, a shared empty body
  buffer, no `originalUrl` concatenation or second path split, `method`
  read once);
- `6d3cf63` — an `indexOf`-only URL split that never searches a slice, and
  no `WeakSet` entry per served text response (only `fetch()`'s requests,
  marked with `markSocketFree`, need it);
- `c50687e` — the route cache keyed by path (no concatenated key to hash),
  a cheaper `headersSent`, cookies parsed on first touch.

In process, interleaved (one process, both trees, medians):

| | before | after |
|---|---:|---:|
| `BunRequest.init` + `new BunResponse` (adapter defaults) | 967 ns (`58d0d97`) | 434 ns |
| one-layer `dispatch` (cache hit, `next()`) | 240 ns (`6d3cf63`) | 130 ns |
| cache-hit lookup alone | 107 ns | ~20 ns |
| served `GET /static` | 2,636 ns (`58d0d97`) | ~1,300 ns |

`wrk` (3 rounds, req/s), against `58d0d97`:

| target | static | param | middleware | routes-1000 |
|---|---:|---:|---:|---:|
| bun-common | 35,068 | 35,111 | 33,550 | 36,746 |
| base/bun-common | 29,029 | 32,255 | 31,046 | 31,298 |
| change | **+20.8%** | +8.9% | +8.1% | **+17.4%** |
| bun-nest | 21,978 | 19,567 | 18,206 | 19,629 |
| base/bun-nest | 19,788 | 18,466 | 16,930 | 18,486 |
| change | +11.1% | +6.0% | +7.5% | +6.2% |
