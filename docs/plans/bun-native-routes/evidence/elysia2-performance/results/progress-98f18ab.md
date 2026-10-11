# Progress snapshot at `98f18ab`

`wrk-run.ts`, every scenario, 3 rounds × 4 s, medians, req/s
(`../../bun-native-routes/results/wrk/elysia2-plan-progress.json`).

| target | static | param | middleware | routes-1000 | param-random | json | async | headers |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| bun-common | 34,084 | 35,045 | 34,874 | 35,174 | 28,756 | 18,105 | 28,836 | 27,868 |
| bun-nest | 21,315 | 19,610 | 17,201 | 19,482 | 16,139 | 11,782 | 20,711 | 19,064 |
| elysia2 | 48,823 | 43,363 | 33,809 | 42,935 | 43,598 | 23,541 | 45,540 | 34,218 |
| bun-common / elysia2 | 70% | 81% | **103%** | 82% | 66% | 77% | 63% | 81% |

Against bun-native-routes §17's develop figures (same machine): bun-common
static 18,179 → 34,084 (+87%), param 19,955 → 35,045 (+76%), middleware
18,533 → 34,874 (+88%), routes-1000 17,798 → 35,174 (+98%), param-random
7,064 → 28,756 (4.1×), json 14,288 → 18,105 (+27%); bun-nest static 14,596 →
21,315 (+46%), param-random 5,951 → 16,139 (2.7×).

In process (`vs-elysia` pattern, one process): Elysia 2 `GET /static`
531 ns, bun-common 1,252 ns (lean options 1,074 ns), `new Response("ok")`
302 ns. What is left over the native response — about 950 ns against
Elysia's 230 — is, by profile: the request URL read and split (~160 ns),
`BunRequest`/`BunResponse` construction and their fields, the bodiless
request's `Content-Length`/`Transfer-Encoding` reads (needed: a declared
empty body is `{}`/`""`, and a `Content-Encoding` on it is refused before
routing), the route-cache `Map.get` on a fresh path string, the pipeline
state and per-layer `next`, and `send`'s bookkeeping.
