# agent-features — Nest 12 adapter-facing feature probes

Probes of every new/changed Nest 12 feature that goes through an HTTP or
WebSocket adapter (routing excluded), on `@nestjs/platform-express` and our
`BunHttpAdapter` / `BunNestWebsocketAdapter`. Findings: `report.md`.

## Versions (read from node_modules / measured)
- Bun 1.4.4 (`bun --revision`: 1.4.4-canary.1+7583003d8), Linux x64. Express runs on the Bun runtime too.
- `repo12` mirror: @nestjs/core, common, platform-express, websockets **12.1.3**; multer 2.4.0; zod 4.6.1; file-type 22.1.1; @standard-schema/spec 1.1.0
- `repo11` mirror: @nestjs/core, common, websockets **11.1.27**; platform-express **11.2.7**; multer 2.4.0; file-type 22.0.1
- `ws12/` (scratch project here): @nestjs/core, common, websockets, platform-ws, platform-express **12.1.3**; ws 8.22.0; zod 4.6.1; rxjs 7.8.2
- @kingsleyweb/bun-nest / bun-common 2.2.0 (mirror `lib/` identical to worktree bun-node-nest12-ae-1015, checked with `diff -rq`)

## Layout
- `probes/`: the probes, `harness.ts` and `tsconfig.json`. They import
  `@nestjs/*` and `../packages/bun-nest/lib/...`, so they run from a
  directory **inside a mirror** (`../nest-mirror.sh`), e.g.
  `<mirror>/spikes-features/` (Bun reads decorator options from the **cwd's**
  tsconfig: always run from that directory). The Nest 11 run used the same
  files minus `07b-rawbody-schema-debug.ts`.
- `ws12/`: a standalone project (`package.json`, `bun.lock`) with
  `@nestjs/platform-ws` 12.1.3 for the platform-ws side of `09-ws`; `bun install`
  there, then run `ws12/spikes/09-ws.ts ws`.
- `results/<probe>.<kind>.<11|12>.json`: measured output (`kind` = express | bun | ws). `.err` = stderr.
- `compare.ts a.json b.json [--strict]` (leaf diff; without `--strict` ignores content-length, x-powered-by, "; " in content-type),
  `brief.ts a.json b.json` (one line per response).

## Re-run
Each probe prints one JSON document. `bun` uses `adapter.fetch()` (no socket) unless the probe needs one (SSE,
StreamableFile, shutdown, WS: served on 127.0.0.1:0); `express` is always served on 127.0.0.1:0.

```bash
F=docs/plans/nestjs-12-parity/evidence/features      # from the repo root
for v in 12 11; do                                    # MIRROR12 / MIRROR11 made by ../nest-mirror.sh
  m=MIRROR$v; mkdir -p ${!m}/spikes-features && cp $F/probes/* ${!m}/spikes-features/ && cd ${!m}/spikes-features
  for p in 01-cookies 02-security 03-exceptions 03b-exception-shapes 04-sse 05-streamable 06-shutdown 07-body-schema 08-uploads 10-query-method 12-instrument; do
    for k in express bun; do timeout 120 bun $p.ts $k > $OLDPWD/$F/results/$p.$k.$v.json 2> $OLDPWD/$F/results/$p.$k.$v.err; done
  done
  timeout 60 bun 09-ws.ts bun > $OLDPWD/$F/results/09-ws.bun.$v.json
  timeout 60 bun 11-logging.ts > $OLDPWD/$F/results/11-logging.$v.json
  cd $OLDPWD
done
(cd ${MIRROR12}/spikes-features && timeout 60 bun 02-security.ts bun --served)     # a real Host header
(cd ${MIRROR12}/spikes-features && timeout 60 bun 10-query-method.ts bun --served)
(cd $F/ws12 && bun install && cd spikes && timeout 60 bun 09-ws.ts ws)
bun $F/brief.ts $F/results/02-security.express.12.json $F/results/02-security.bun.12.json
```
The plan's author re-ran `02-security` and `06-shutdown` on Nest 12 after
the agent: the same verdicts (security headers missing on our 403s; the
403/400 order with an invalid body; no 503 during shutdown; in-flight
requests reset; invalid port and socket path hang).

`07-body-schema` and `01/02` print "not-applicable" on Nest 11 (features absent). `03b-exception-shapes` shows the
exception object each pre-route failure hands Nest's filters; `07b-rawbody-schema-debug.ts` shows `@RawBody({schema})`
metadata. Each probe runs in seconds; none is heavy (no wrapper needed).

| probe | item |
|---|---|
| 01-cookies | 1 cookies option, setCookie/clearCookie/signer, @Cookies/@SignedCookies |
| 02-security | 2 enableCsrfProtection / useSecurityHeaders (`--served` for a real Host) |
| 03-exceptions, 03b | 3 mapException, errorCode, #17709 |
| 04-sse | 4 SSE 11.2.x–12.1.3 |
| 05-streamable | 5 StreamableFile |
| 06-shutdown | 6 return503OnClosing, drain, forceCloseConnections, listening state, concurrent close, listen errors / socket path |
| 07-body-schema | 7 rawBody, Standard Schema decorators, pipe, serializer |
| 08-uploads | 8 multer vs bun-nest interceptors, limits merge, nesting/array index, FileTypeValidator |
| 09-ws | 9 disconnect reason, request-scoped gateways, hook errors, WsException delivery, @MessageBody({schema}) |
| 10-query-method | 10 HTTP QUERY route + middleware (incl. a monkey-patch feasibility case) |
| 11-logging | 11 adapter log call shapes on Nest 11 vs 12 ConsoleLogger |
| 12-instrument | 12 instrument.instanceDecorator, setOnRouteTriggered/OnRequestHook/OnResponseHook |
