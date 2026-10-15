# Evidence: NestJS 12 parity

The evidence behind [`../README.md`](../README.md). Gathered on
**2026-10-15** on one shared machine (Linux 7.0.0-38-generic x86_64, 16
cores), against `develop` at `73bf4a00`, with Bun 1.4.4-canary.1
(`7583003d8`) unless a row names 1.4.2 (`744846f84`) or 1.4.3
(`c6da4a4d3`), NestJS **12.1.3** and, for the Nest 11 side, develop's lock
(`@nestjs/core`/`common`/`websockets` 11.1.27, `platform-express` 11.2.7),
TypeScript 6.0.3. Peer sessions ran at the same time. Nothing here is part of
a published package, and the repo's tooling does not build, type-check or
lint it ([`../../README.md`](../../README.md) says why).

**Where it ran.** No product file was changed. Every measurement ran in a
copy of the repo with one Nest version installed into it:
[`nest-mirror.sh`](nest-mirror.sh) makes one (`nest-mirror.sh <repo> <dest>
<version>`; it keeps every other dependency at develop's lock and asserts
`@kingsleyweb/*` resolve inside the copy). The copies lived under `~/.cache`;
a dot segment in the path makes Express's `send` refuse files, which is why
two expressCompat probes fail in every copy on both majors (see
[`failures/`](failures/README.md)). Make your copies elsewhere.

| Path | Question | Re-run | Result |
|---|---|---|---|
| [`npm-registry.md`](npm-registry.md) | Is Nest 12 released? Versions, dates, peer ranges, engines, module format, `exports` maps, against 11.1.27/11.2.7 | the `npm view` commands in the file | itself [V] |
| [`contract-diff.md`](contract-diff.md) | What changed in `AbstractHttpAdapter` and `HttpServer` between v11.1.27 and v12.1.3, against our adapter, member by member | `git diff v11.1.27 v12.1.3 -- packages/core/adapters/http-adapter.ts packages/common/interfaces/http/http-server.interface.ts` in a `nestjs/nest` clone | itself [V], gaps [M] where marked |
| [`changelog/matrix-core-common-testing.md`](changelog/matrix-core-common-testing.md) | Every non-merge commit `v11.1.27..v12.1.3` (and the 11.2.x branch) touching `core`, `common`, `testing`, classified AFFECTS / NO / UNKNOWN against our code; appendix buckets every other commit in the range | read-only; its probes in `changelog/probes-core/` (run inside a 12 copy) | 199 rows: 53 AFFECTS, 146 NO (2 reverted before release), 0 UNKNOWN |
| [`changelog/matrix-platforms-ws.md`](changelog/matrix-platforms-ws.md), [`notes-platforms.md`](changelog/notes-platforms.md) | The same for `platform-express`, `websockets`, `platform-ws`, `platform-socket.io`, `platform-fastify`, `microservices`, including the commits inside the v12.0.0 merge; ExpressAdapter, WsAdapter and multer method by method against ours | `bun <probe>` in `changelog/probes-platforms/` | 235 rows: 42 AFFECTS, 190 NO, 3 UNKNOWN |
| [`changelog/addendum-coverage.md`](changelog/addendum-coverage.md) | Did the two matrices miss any commit? The 1207 commits of the range against the 718 they name; the 22 unnamed non-merge commits that touch a Nest package, classified | the `git rev-list` commands in the file | all 22 NO; every commit touching a Nest package classified |
| [`failures/`](failures/README.md) | Why bun-nest's own suite fails 7/427 on Nest 12; the Nest commit behind each; prototype patches | `nest-mirror.sh`, then `bun test --parallel` in `packages/bun-nest`; `patch -p1 < failures/fix-all.patch` | 5 Nest 12 failures + 2 dot-path artefacts; 427/427 on both majors with the patches |
| [`routing/`](routing/README.md) | Do routes, prefix and exclusions, versioning, middleware, not-found, `QUERY`, host routing and Nest 12's route options answer the same on platform-express and ours, on 11 and 12? | `MIRROR11=… MIRROR12=… routing/harness/run-all.sh` | 175 requests: 130 same, 3 regressions on 12, D1–D8 with causes |
| [`features/`](features/README.md) | Cookies, CSRF and security headers, exception mapping, SSE, `StreamableFile`, shutdown and `listen`, body and Standard Schema, uploads, WebSockets (against platform-ws), `QUERY`, logging, instrumentation: Express against ours on 12 (and 11) | the loop in `features/README.md` | 20 gaps, G1–G20 ([`features/report.md`](features/report.md)) |
| [`runs/`](runs/) | Raw logs of every suite, check, example and consumer-check run quoted in the plan, and the Nest 11 floor bisect ([`runs/floor-bisect.txt`](runs/floor-bisect.txt)) | the commands in the plan's §2.2 and §8.1 | as recorded |
| [`bun-bug-fetch-double-slash/`](bun-bug-fetch-double-slash/README.md) | Bun's `fetch()` drops the first `/` of a `//…` request target: a single-file reproduction, the issue search, a draft issue (not filed) | `bun repro.mjs` (exits 1 while present) | reproduced on 1.4.2, 1.4.3, 1.4.4-canary; Node 24.2.0 correct |

## The run logs (`runs/`)

| File | What | Result |
|---|---|---|
| `bun-nest-suite.nest11.worktree.log` | bun-nest `bun test --parallel`, the worktree itself (Nest 11) | 427 pass, 0 fail |
| `bun-nest-suite.nest12.run1.log`, `.run2.log` | the same in a Nest 12.1.3 copy | 420 / 7 each (a third run alike) |
| `bun-nest-suite.nest12.bun1.4.2.log`, `.bun1.4.3.log` | Nest 12 under stable Bun 1.4.2 and 1.4.3 | 420 / 7, the same 7 |
| `bun-nest-suite.nest11-mirror.bun1.4.{2,3}.log` | Nest 11 in a `~/.cache` copy | 425 / 2 (the dot-path artefact) |
| `expressCompat.nest11-mirror.dot-path.log` | expressCompat alone, Nest 11 copy, canary | 126 / 2: proves the artefact |
| `bun-nest-suite.nest11.0.0.log`, `.nest11.1.7.log` | the suite at the claimed floor and at 11.1.7 | 410 / 6 of 416; 423 / 4 |
| `bun-nest-suite.nest{11,12}.fixed.nondot.log` | with `failures/fix-all.patch`, outside dot directories | 427 / 0 on both |
| `check.bun-nest.nest12.log` | `bun --check` in bun-nest on 12 | no type errors, 255 files |
| `consumer-check-nest12-ts{6.0.3,5.9.3}.log`, `consumer-check-nest11-ts6.0.3.log` | `bun scripts/consumer-check.ts packages/bun-nest` (`--typescript`, `--work` in the copy); the 12 consumers verified on `@nestjs/core`/`common` 12.1.3 | 11 spellings × 6 cells OK, Bun runtime OK, on each |
| `examples-bun-nest.nest{11,12}.log`, `.nest12.fixed.log` | `examples/bun-nest` `bun run-all.ts` | 20/20; 15/20 (5 failed); 20/20 |
| `bun-jobs-ui-nest-test.nest12.log` | bun-jobs-ui `__tests__/server/nest.nest.test.ts` on 12 (through the heavy-run wrapper) | 2 / 0 |

Also measured and quoted in the plan, without a separate log: the shipped
`dts/` built against Nest 11 and against Nest 12 are byte-identical
(`diff -r` of the two copies' `packages/bun-nest/dts`); Bun resolves
`require("@nestjs/core/package.json")` on 12 where Node 24 does not.

## Sources

Read for this plan (primary sources only; all on 2026-10-15):

- **npm registry:** `npm view` of `@nestjs/{core,common,platform-express,platform-fastify,websockets,platform-ws,platform-socket.io,testing,microservices}` at 12.1.3, 11.1.27 and 11.2.7; `dist-tags` and `time`; `@oven/bun-linux-x64` 1.4.2 and 1.4.3 (the Bun binaries used).
- **GitHub releases** of `nestjs/nest`, every tag from v11.1.27 to v12.1.3 and v11.2.0–v11.2.6 (`gh api repos/nestjs/nest/releases/tags/<tag>`); v12.0.1, v12.1.2 and v11.2.7 have no release page, so their commits came from git.
- **`nestjs/nest` git**, a clone with every tag: `git log v11.1.27..v12.1.3` (579 first-parent commits; 211 non-merge commits in core/common/testing), `v11.2.1..v11.2.7`, and the diffs of every commit the matrices mark as read; files read at `v12.1.3` include `packages/core/{adapters/http-adapter.ts,nest-application.ts,application-config.ts,router/{router-explorer,routes-resolver,route-specificity-sorter,route-conflict-detector}.ts,helpers/router-method-factory.ts,exceptions/base-exception-filter.ts}`, `packages/common/{interfaces/http/http-server.interface.ts,enums/request-method.enum.ts,decorators/http/request-mapping.decorator.ts}`, `packages/platform-express/adapters/express-adapter.ts`, `packages/websockets/web-sockets-controller.ts`, and the integration specs listed in the plan's §9.1.
- **`nestjs/docs.nestjs.com`** at `2ad58ec` (2026-10-13): `content/migration.md` in full, `content/controllers.md` ("Route conflicts and resolution order"), `content/faq/global-prefix.md`, `content/faq/http-adapter.md`.
- **`oven-sh/bun`**: `.github/ISSUE_TEMPLATE/2-bug-report.yml`, and the issue searches in `bun-bug-fetch-double-slash/search-results.txt`.

Paths such as `../nest-src`, `../commits-pkgs.tsv`, `../repo12` and
`../test-bun-nest-nest12-run1.log` inside the matrices refer to the scratch
directory they were written in; the commit lists are reproducible with the
`git log` commands each matrix states, and the logs they cite are in `runs/`.
A conclusion here is as old as this folder: re-run before relying.
