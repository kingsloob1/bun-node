# Live sync: edit a route, time until the client's types file changes

```bash
cd docs/plans/evidence/typed-client/sync && bun e2e.ts        # ~1 min; ITER=10 by default
```

Backs `../../../typed-client.md` §3.3. Bun 1.4.3 (`bbdc5a519`), linux-x64,
2026-10-10.

| File | What it does |
|---|---|
| `dev-types.ts` | The server half: `devTypes({ enabled })` serves the route model at `/__bun/types` (ETag = model hash, 304 on `If-None-Match`) and a WebSocket at `/__bun/types/ws` that sends `{ type: "model", hash }` on connect and on every change. It refuses to start under `NODE_ENV=production` or without `enabled: true`, demands a bearer token, answers only loopback peers, and answers 404 (not 401) otherwise. The hub lives on `globalThis`, so it survives `bun --hot` |
| `watch.ts` | The client half: connects, compares the announced hash with the one in the generated file's header, fetches the model with `If-None-Match`, emits with `../codegen/emit-dts.ts`, writes atomically (temp + rename) only on change. Reconnects with backoff. `POLL_MS=1000` turns it into the hey-api/Kubb shape (poll with `If-None-Match`) for comparison |
| `e2e.ts` | For each mode, copies a small app into `.run/<mode>/` (git-ignored), starts it, starts the watcher, then 10 times rewrites `routes.ts` with a new field name and times until the generated file contains it |

## Results (`results.txt`)

```
{"mode":"hot","iterations":10,"editToFileMs":{"median":49,"p90":68,"max":68,"min":44},"watcherFetchMsMedian":0,"watcherEmitWriteMsMedian":0,"serverModelMsMedian":1.3,"serverEvaluations":11,"watcherReconnects":0,"noTokenStatus":404,"withTokenStatus":200,"ifNoneMatchStatus":304}
{"mode":"watch","iterations":10,"editToFileMs":{"median":160,"p90":163,"max":163,"min":159},"watcherFetchMsMedian":0,"watcherEmitWriteMsMedian":0,"serverModelMsMedian":5.5,"serverEvaluations":11,"watcherReconnects":20,"noTokenStatus":404,"withTokenStatus":200,"ifNoneMatchStatus":304}
{"mode":"poll","iterations":10,"editToFileMs":{"median":560,"p90":1043,"max":1043,"min":69},"watcherFetchMsMedian":1,"watcherEmitWriteMsMedian":1,"serverModelMsMedian":1.28,"serverEvaluations":11,"watcherReconnects":0,"noTokenStatus":404,"withTokenStatus":200,"ifNoneMatchStatus":304}
production: REFUSED: devTypes: refused under NODE_ENV=production
```

- **`bun --hot`: 49 ms median from saving the file to the client's file
  changing**, p90 68 ms. Almost all of it is Bun noticing the edit and
  re-evaluating; building the model takes ~1.3 ms, fetch and emit ~1 ms. The
  WebSocket survives the hot reload (0 reconnects).
- **`bun --watch`** (the process restarts): 160 ms, two reconnect events per
  edit, because the restart drops the socket and the watcher re-reads the
  hash on reconnect.
- **Polling every second** (the existing tools' shape): 560 ms median,
  ~1 s p90: the poll interval dominates.
- The guard: no token → 404, token → 200, matching ETag → 304, and
  `NODE_ENV=production` refuses to start.

Not measured: how long the editor's TypeScript server takes to show the new
type after the file changes. That is the language server's re-check of the
importing files and is the same for any generator.
