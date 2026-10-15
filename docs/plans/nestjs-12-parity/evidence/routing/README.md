# Routing differential harness: platform-express vs BunHttpAdapter, Nest 11 vs 12

One Nest application per group (21 groups, 175 requests), booted on
`@nestjs/platform-express`'s `ExpressAdapter` and on bun-nest's
`BunHttpAdapter`, under Nest 11 and Nest 12; the same requests go to each, and
every difference is reported. Results: [`results/results.md`](results/results.md) (tables,
verdicts, causes with `file:line`), raw data `results/raw-nest11.json`,
`results/raw-nest12.json`, and the joined rows `results/results.rows.json`.

## Re-run

```bash
# from the repo root: make the two mirrors (see ../nest-mirror.sh), then
docs/plans/nestjs-12-parity/evidence/nest-mirror.sh . /path/to/repo11 11.2.7
docs/plans/nestjs-12-parity/evidence/nest-mirror.sh . /path/to/repo12 12.1.3
MIRROR11=/path/to/repo11 MIRROR12=/path/to/repo12 \
  docs/plans/nestjs-12-parity/evidence/routing/harness/run-all.sh        # every group
#   ... run-all.sh mw-     # only groups whose name contains "mw-" (overwrites results/ partially)
```

`run-all.sh` copies `harness/{app,probes,run}.ts` and `tsconfig.json` into
`<mirror>/spikes-routing/` (so `@nestjs/*`, `express` and
`../packages/bun-nest` resolve through that mirror), runs
`bun run.ts <out.json> [filter]` from there (the cwd matters: Bun takes the
decorator options from the cwd's `tsconfig.json`), then `harness/compare.ts`,
which writes `results/results.md` and appends the hand-written
`harness/causes.md`. A full run takes about 2 s; three runs (two by the agent
that wrote it, one from this folder) gave identical rows. Type check:
`cd <mirror>/spikes-routing && env -u AGENT -u CLAUDECODE -u REPL_ID bun --check` (clean).

The recorded run used the mirrors this plan measured in: Nest 11 = develop's
lock (core/common 11.1.27, platform-express 11.2.7), Nest 12 = 12.1.3.

## Versions (read from the mirrors' node_modules by `run.ts`)

| | Nest 11 run (`repo11`) | Nest 12 run (`repo12`) |
|---|---|---|
| @nestjs/core, common | 11.1.27 | 12.1.3 |
| @nestjs/platform-express | 11.2.7 | 12.1.3 |
| express | 5.2.1 | 5.2.1 |
| path-to-regexp | 8.4.2 | 8.4.2 |
| bun-nest / bun-common | develop `73bf4a00` (`lib/` identical to the worktree) | same |
| Bun | 1.4.4-canary.1+7583003d8 | same |

## What it does

- **Groups** (`harness/probes.ts`): `routes` (static vs param order, encoded
  params, `*path`/`{*path}`, trailing slash, case, duplicate slashes, `@All`,
  `@Head`, `@Options`, `@Search`, `@Redirect`, `@HttpCode`, `@Header`, host
  routing, not-found and method misses); `query-method` (`@QueryMethod`, on
  its own because it fails the Bun app at boot on 12); `syntax-*` (optional
  group, legacy `*` and `(.*)`, one controller each so a rejected syntax fails
  alone); `prefix` (`setGlobalPrefix('api', { exclude: ['health', { path:
  'hello', method: GET }, 'files/*path'] })`); `prefix-array`;
  `ver-uri|header|header-neutral-default|media|custom`; `mw-basic`
  (string, wildcard, `{ path, method }`, controller classes, `exclude`,
  transient), `mw-prefix`, `mw-version`; and, on Nest 12 only, `n12-*`
  (`routeResolutionStrategy`, `routeConflictPolicy`, and bun-common's own
  `routeSpecificity` on top).
- **Per request** it records status, body (parsed JSON), `content-type`,
  `allow`, `x-powered-by`, `location`, `x-custom`, the handler that ran (every
  handler sets `x-h`) and the middleware trail (every middleware appends to
  `x-trail`); per boot, every warning/error Nest logged (a capturing
  `LoggerService`: the legacy-route warnings, the conflict warnings) and any
  boot error.
- **Transport:** Express is served on port 0 and asked with `fetch`. The Bun
  adapter is asked through its socket-free `adapter.fetch()` and, as a
  cross-check, over its own socket on port 0; the two agreed on every request.
  A path starting with `//` is sent over a raw TCP socket, because Bun's
  `fetch` client rewrites the request target `//a//b` to `/a//b` (measured;
  Node 24's `fetch` does not).
- **Verdicts** compare Express and Bun on each Nest version and each adapter
  across versions: `same`, `bun differs from express (11 and 12)`,
  `bun differs from express on 12` (Nest-12-only groups), `regression in bun
  on 12`, `Nest 12 changed both`, `bun matches on 12 only`, and `bun differs
  on 12: Nest 12 changed express, bun kept 11's answer`.

## What it does not cover

- **Express runs on Bun's `node:http`**, not on Node: the reference is
  Express-on-Bun. Where Bun's `node:http` differs from Node's (method parsing,
  HEAD, header casing), this harness cannot see it.
- Response details the existing `__tests__/expressCompat*` suite already
  compares (every header, ETag, content-type defaults, cookies, static files,
  views, body parsing, CORS, SSE, `StreamableFile`): this harness compares the
  routing fields only, and every handler returns JSON so the known
  text/plain-vs-text/html default does not mask routing differences.
- `RouterModule` paths (where #17710's slash collapsing applies), `@Controller`
  with an array of paths or of hosts, regexp hosts, `@Version` on a controller
  combined with method versions beyond one case, request-scoped controllers,
  `forRoutes` with `RequestMethod.QUERY` (it would throw in our
  `getRequestMethodStr`; see causes D1), multiple Nest apps on one adapter,
  `app.use()` (raw Express middleware) and `useGlobalPrefix` interplay with
  static assets, WebSocket upgrades, Fastify.
- Error mapping beyond the one malformed-param probe (invalid JSON bodies are
  covered by `expressCompat`'s "invalid JSON" probe; see causes D2).
- Nest 11.2.x core: the Nest 11 run is develop's pin (core 11.1.27 with
  platform-express 11.2.7), so `@QueryMethod`, added in 11.2.0, is absent
  there.

## Relation to the existing comparison

`packages/bun-nest/__tests__/expressCompat.nest.test.ts` (+ `expressCompat/app.ts`,
`probes.ts`) already boots one app per group on both adapters and compares
status, every header and the body, with a `KNOWN` list of accepted
differences; its routing coverage is a global prefix with one `{ path,
method }` exclusion, URI/HEADER/MEDIA_TYPE versioning, three middleware
configs (`mw/*path`, a controller with `exclude`, a `{ path, method }`), a
host controller, HEAD/OPTIONS/POST on one GET route and one unknown path.
`expressParity.nest.test.ts` adds HEAD on a `@Get` and late `next()` from
middleware. This harness extends that approach (same boot-both, same
measured-Express-is-the-expectation rule) to path syntax, order, case, every
exclusion form, CUSTOM versioning, the middleware fixes of 12.x, not-found
scoping, QUERY, and Nest 12's route options, and adds the Nest 11-vs-12 axis.
As a parity test it would become a fourth `__tests__` group with a `KNOWN`
list keyed like `expressCompat`'s.
