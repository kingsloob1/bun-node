# CLAUDE.md

Project knowledge for Claude Code and contributors. Auto-loaded each session.

## What this repo is

`bun-node` is a Bun-first monorepo (Bun workspaces + lerna + nx) with four
published packages under `packages/`:

- **`@kingsleyweb/bun-common`** — an Express-like HTTP layer for `Bun.serve`:
  `BunRequest`, `BunResponse`, `BunRouter` (extends `@routejs/router`),
  `BunHttpAdapter`, `BunWebSocket`, and a multipart upload system
  (`lib/multipart/`).
- **`@kingsleyweb/bun-nest`** — a NestJS adapter built on bun-common:
  `BunHttpAdapter` (extends NestJS `AbstractHttpAdapter`),
  `BunWebSocketAdapter`, file interceptors, decorators.
- **`@kingsleyweb/bun-jobs`** — background work on top of bun-common's
  primitives: `BunRunner` (run a JS/TS file on a schedule or on demand, in a
  child process, a `Worker` or in-process), `BunQueue`/`BunQueueWorker` (a
  job queue across processes and services) and the per-service `BunJobs`
  context, over pluggable drivers (memory, file, Redis, SQL). Being
  assembled in phases — see its `README.md` for what has landed.
- **`@kingsleyweb/bun-jobs-ui`** — a React management UI and API docs
  viewer for bun-jobs' management API (`createJobsApi`), prebuilt into
  `dist/` and served by a `jobsUi()` router. See
  [bun-jobs-ui](#bun-jobs-ui-phase-3-ui) below.

Each package: `lib/` source, `__tests__/` (bun:test), `tsc --noEmit`
typecheck, ESLint via `@antfu/eslint-config`. Bun runs the shipped `.ts`
source directly (`main` is `lib/index.ts`; no JS is emitted). All four
packages also ship built declarations in `dts/` and point `types` at them —
see [Packaging types](#packaging-types-declarations-ship-sources-ship-alongside).

Runtime is **Bun ≥ 1.4.2**: `engines.bun` says so in the root and in every
package, `bun-types`/`@types/bun` devDeps are `^1.4.2`, and each package
declares an optional `@types/bun >=1.4.2` peer so a consumer on older types
is warned instead of hitting opaque type errors. The floor matters because
bun-jobs' Redis and SQL drivers use `RedisClient.eval`/`xadd`/… and
`sql.listen`, which 1.4.2 is the first `bun-types` release to declare.

bun-nest's `BunHttpAdapter.use/get/post/...` delegate to `this.instance`,
which is a bun-common `BunRouter` — so routing/middleware behaviour lives in
bun-common.

## Dev workflow

```bash
bun scripts/typecheck.ts   # every project in the repo — must be clean
```

**Manual playground:** `bun playground/index.ts` serves bun-jobs, its
management API and the bun-jobs-ui app on one adapter at
`http://localhost:4000/jobs`, with a simulation that keeps every screen
moving (`playground/README.md`). It is a project of its own, like
`benchmarks/`: typechecked by `scripts/typecheck.ts`, linted with
`cd playground && bunx eslint .`, and outside the workspaces.

Then, in each affected package directory:

```bash
bunx eslint .              # lint — must have 0 errors
bun test                   # tests — must all pass
```

**Running the examples.** Each `examples/*/run-all.ts` runs four examples at a
time (two in `bun-jobs-ui`, where each drives Chrome). `--jobs N` or
`EXAMPLE_JOBS=N` changes the width; `--serial` restores one-at-a-time, whose
output is identical to the old runner's. Measured on `examples/bun-jobs`: 220 s
serial against 146 s pooled on one backend.

A handful of examples are held back and run alone afterwards, listed in
`RUN_ALONE` in the runner. The bar for that list is that the example **asserts
on a duration** — a sweep cadence, a lock expiry, a blocking read's wake budget
— not merely that it is slow: starved of CPU those read as broken. Being slow
is what `SLOW_FIRST` is for, which only reorders. Measured the other way too:
running several **backends** at once, rather than several examples, gave 5
failures across 8 backends, always in those files. So the backends stay serial.

**How much to run for one change.** The affected examples on memory plus one
server, which is seconds to a minute, and the full 8-backend sweep once per
merge window rather than per change — the peers' change reports name the areas
they touch. Do not try to select the affected examples mechanically: matching a
diff's identifiers against the examples selects nearly all of them, because
ordinary names appear everywhere.

`EXAMPLE_DRIVER` chooses the backend and defaults to `memory`. A URL variable
alone does nothing, so `EXAMPLE_MYSQL_URL=… bun run-all.ts` is a memory run that
looks like a MySQL one.

The repo's own tooling in the root `scripts/` (`typecheck.ts`,
`setup-databases.ts`, `consumer-check.ts`) belongs to no package, so it has its
own lint config; after touching one, lint it from there:

```bash
cd scripts && bunx eslint .   # 0 errors, and 0 warnings
```

It is the packages' config except that `no-console` and
`antfu/no-top-level-await` are off: every file there is a CLI entry point, whose
output is its product and which nothing imports.

**Lint the whole package, not `lib __tests__`.** That narrower scope was what
the workflow said for a long time, and it had the same blind spot the
`tsconfig` `include` did: it reported zero errors while `bunx eslint .` found
thirteen, in READMEs, benchmark code and `package.json`. The editor lints
everything, so the errors were visible there and nowhere else.

bun-jobs' integration suites need database servers, and skip (visibly) when
their URL is unset. `bun scripts/setup-databases.ts` provides them — system
packages by default, `--docker` for containers, `--dry-run` to see the plan
first. It never reinstalls an existing server and configures one only when a
connection with the expected credentials fails.

After changing bun-common, also run bun-nest's and bun-jobs' checks (both
depend on bun-common). The `eslint.config.mjs` `TS2742`/`TS2883` portability
hint is pre-existing noise — `scripts/typecheck.ts` filters it. There may be a
couple of intentional `no-console` ESLint *warnings* (error logging in catch
blocks with no logger in scope); warnings do not fail lint.

`packages/bun-jobs/bench/` is a **separate, unpublished package** with its own
`package.json`, lockfile and `node_modules` (the same shape as the root
`benchmarks/`, and excluded from the root `workspaces` list). It holds the
third-party comparators — BullMQ, bee-queue, node-resque, pg-boss,
graphile-worker, Agenda, Bree and the cron timers — so none of them reach a
published package's dependency tree. `scripts/typecheck.ts` and `bunx eslint .`
both cover it.

It benchmarks against its own databases (`bun_jobs_bench`, Redis database 14),
never the test suite's, so the two can never disturb each other.

`packages/bun-common/bench/` has the same shape: its own `package.json`,
`bun.lock` and `node_modules`, and it is not in `workspaces`. It declares the
XML benchmark's comparators, `fast-xml-parser` and `htmlparser2`. Before this
package existed nothing declared them, and its typecheck passed only where an
old install had left them in the root `node_modules`. Run `bun install` in each
of the three bench directories before `scripts/typecheck.ts`, or their projects
fail on missing modules.

## Typechecking

**One base config, extended everywhere.** `tsconfig.base.json` at the repo
root holds every compiler option; the `tsconfig.json`s below it add only
`paths`, `include` and, where a project needs them, `types`/`lib`. A file is therefore checked the same way wherever it is
checked from.

```bash
bun scripts/typecheck.ts          # every project in the repo
bun scripts/typecheck.ts --list   # just name them
```

Run that rather than `bunx tsc --noEmit` in one package — the packages are not
the only projects. There are also `packages/bun-common/bench`,
`packages/bun-common/playground`, `packages/bun-jobs/bench` and the standalone
`benchmarks/`, each a nested project with its own config because it resolves
third-party comparators from its own `node_modules`; the examples; and the root
`scripts/` (`scripts/tsconfig.json`).

The root `scripts/` were the last files no project claimed. The root
`tsconfig.json` includes nothing, so an editor put them in an inferred project,
where TypeScript 6 loads no `@types/*` and every `Bun`, `console` and `node:*`
was an error; the CLI never looked at them at all. Their project names
`types: ["bun"]` explicitly rather than relying on `setup-databases.ts`'s
`import("bun")` dragging the Bun globals in for the whole program. The root
`package.json` declares what the scripts' checks load (`@types/bun`, `eslint`,
`@antfu/eslint-config`, `eslint-config-prettier`, `eslint-plugin-prettier`)
instead of borrowing copies a package happens to hoist. bun-jobs-ui's
`__tests__/app/pkg` project, which only its own `typecheck.test.ts` checked, is
in the list too.

This replaced an arrangement worth understanding, because it hid real bugs.
Each package's `include` was `./lib/**/*` alone, so `tsc --noEmit` never saw
`__tests__/` or `scripts/`; `benchmarks/` had no config at all; and the root
`tsconfig.json` set *only* the decorator options while declaring no `include`,
which meant it claimed every file in the repo. An IDE resolving a package file
against that root project type-checked it with no `skipLibCheck`, no bundler
resolution and no Bun types, and reported a cascade of errors in files the CLI
called clean. Every documented command passed the whole time.

Two known-noise codes are filtered by the script: `TS2742`/`TS2883` on the
ESLint flat config's inferred default export, which cannot be named without a
path into a pnpm-style store.

## Benchmark regression guard

Phase 1 moved most of these numbers a long way, and a regression does not fail
a test — it just makes a figure smaller, and nobody reads a benchmark table
carefully on a Tuesday. So the table is an assertion:

```bash
cd packages/bun-jobs/bench
bun queue.ts --compare          # fails if anything regressed
bun runner.ts --compare
bun queue.ts --save-baseline    # re-record, after a deliberate change
```

`baselines/*.json` record what each scenario measured **and who led it**. The
comparison fails on either a figure falling behind its own baseline or a rival
overtaking us.

**The overtaken check is the sharper of the two**, and the one the claim
actually rests on. Comparing a figure to its own past is noisy — four runs of
one unchanged build gave 40,053 to 51,347 jobs/s on Redis contention, a 28%
spread, because that scenario runs three consumer processes — so the tolerance
is a blunt 35%, calibrated to that. Comparing against a *rival* is self
normalising: a busy machine slows both.

That is honest about what the guard catches. Every regression this benchmark
has actually caught was a factor rather than a percentage — a claim that went
O(n), a wakeup lost for a whole second, a table analysed on every insert. A
baseline is only meaningful on the machine that recorded it, which is why the
file records the platform and Bun version.

## Schema sync (`bun-jobs`, SQL and MongoDB)

The schema is created with `IF NOT EXISTS`, so a table an earlier version
created keeps its original shape for good — which means every schema
improvement that ships with an upgrade otherwise reaches new installs only.
`syncSchema` is how a deployment that already has tables gets them.

```ts
new SqlDriver({ url, syncSchema: true })          // on connect
await driver.syncSchema()                          // or explicitly
await driver.syncSchema({ dryRun: true })          // plan, change nothing
await driver.syncSchema({ alterColumns: true })    // including the rewrite
```

**Safe by default, and the split is the point.** Adding a column, dropping an
index or rebuilding one cannot stall a running queue on Postgres (the index
work is `CONCURRENTLY`) or on MySQL/MariaDB (InnoDB builds online, apart from a
brief metadata lock). **SQLite is the exception:** an index build locks out
writers until it finishes (measured ~1.7 s of blocked inserts on a 2M-row
table), so its `create-index` changes report `blocking: true` — the default
sync still makes them. Changing a column's *type* rewrites the table under a
lock that blocks every reader and writer, so it is reported with
`blocking: true` and `applied: false` unless `alterColumns` asks for it. Every
change comes back either way, so `dryRun` is a plan.

Measured against a table built the way an older version would have built it
(`jsonb` columns, five plain indexes), 5,000-job bulk enqueue: 25,189/s before,
26,825/s after the safe sync, 30,756/s once `alterColumns` runs too.

Two rules that keep it from doing harm:

- **It only drops indexes it named.** SQL matches the driver's own `ix_`
  convention; MongoDB names indexes after their key pattern, so one this driver
  no longer defines is indistinguishable from one somebody added by hand — there
  it drops only names on an explicit `RETIRED_INDEXES` list.
- **A column whose declared type is not what the engine reports back is
  exempt** (`retype: false`). `BIGSERIAL PRIMARY KEY` comes back as `bigint`,
  so comparing the strings would propose a nonsense rewrite on every sync
  forever. The baseline test — a freshly created schema must report no drift —
  is what catches this class of bug.

## bun-jobs-ui (phase 3 UI)

`packages/bun-jobs-ui` is two programs in one package:

- **`lib/`** — the server, Bun only: `jobsUi(options)` returns a bun-common
  router serving the HTML shell (with the injected `UiConfig`, CSP, SRI) and
  the hashed assets (`lib/assets.ts`).
- **`app/`** — the browser: React 19, TanStack Query, bundled by `Bun.build`.
  Its own project (`app/tsconfig.json`, DOM libs).
- **`lib/shared/`** — `UiConfig` and friends, imported by both. It is the
  only part of `lib/` the browser imports, so it must stay free of runtime
  imports (the bundle-safety test catches anything else crossing). It lives
  under `lib/` so the declarations build (`rootDir: lib`) covers it.

**Two build outputs, both gitignored, both built on `prepack`:** `dist/` is
the browser bundle (`bun scripts/build.ts`), `dts/` the declarations of `lib/`
alone (`bun run build:types`). `app/**` and the tests never reach `dts/`, so
no React or TanStack type does either. Its packaging test is
`__tests__/server/packaging.test.ts` (the server project's `include`).

**Mounting.** Beside the API, each at its own `basePath`; the UI's must not
equal or sit under the API's (`jobsUi()` throws a `ConfigError`):

```ts
const api = createJobsApi({ jobs, basePath: "/admin/jobs-api", authorize });
const ui = jobsUi({ api, basePath: "/admin/jobs" });   // or apiUrl: "..."
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);
```

**Browser safety.** `app/**` imports bun-jobs **only** from
`@kingsleyweb/bun-jobs/api/contract`, the browser-safe entry. A value import
from the package root would pull drivers, bun-common and `node:*` into the
bundle. `__tests__/app/pkg/bundle-safety.test.ts` builds the real app and
fails on any server marker, with a negative control.

**Bundle and dev fallback.** `bun scripts/build.ts` (run on `prepack`) writes
`dist/`. Without a `dist/` — the normal state in the repo — `jobsUi()` builds
`app/main.tsx` in memory on the first request, once per process, and logs one
`info` line saying so; `dev: true` always builds, `dev: false` requires
`dist/`. `__tests__/server/budget.test.ts` caps the entry module and every
lazy chunk (`BUNDLE_BUDGET`, raised only deliberately, per its comment).

**DOM tests — rules learned the hard way.** `bun test` shares globals and
modules across files, so order leaks are real:

- Call `setupDom()` from `__tests__/app/dom.ts` at the top level of every
  DOM test file, and take `render`/`fireEvent`/… from there. It registers
  happy-dom for the file and unregisters it after, so its `fetch`/`Response`
  never reach a server test.
- Never import `react-dom`, `@testing-library/react` or `app/boot` statically
  in a test: react-dom decides at evaluation whether a DOM exists, and loaded
  before happy-dom its `onChange` never fires. `dom.ts` loads it dynamically.
- `dom.ts` makes TanStack Query re-ask `isServer` per call. query-core
  otherwise decides once, at load, and a DOM-less file loaded first leaves
  every later polling test with no timers.
- `__tests__/app/domLeak.test.ts` is the guard: every file reaching
  `register-dom` calls `setupDom()`, none reaches react-dom statically.
- `setupDom()` preloads every lazy screen named in `app/screens/lazy.tsx`,
  so `React.lazy` resolves in microtasks and fake-timer tests do not depend
  on which file ran first.
- The suite must pass under `bun test --randomize`, not just in file order.
- Tests importing the bun-jobs package root (real-API integration,
  bundle-safety) live in `__tests__/app/pkg`, a DOM-free project typechecked
  by its own `typecheck.test.ts` and by `scripts/typecheck.ts`; they load the
  DOM side by dynamic import.

**The README is parsed.** Its `### What each element needs` table is read
by `examples/bun-jobs-ui/04-screens/permissions.ts`, which fails on any drift
from the UI's rules. A change to a row is a change to that example: report
it to the examples session before merging.

**E2E.** `__tests__/e2e/*.e2e.test.ts` drive the real app in headless Chrome
through `Bun.WebView`, against a real `createJobsApi`; they skip visibly when
no Chrome is found (`BUN_CHROME_PATH` points at one).

**Pre-merge gate:** `bun scripts/typecheck.ts`; `CI=1 bunx eslint .` in the
package; `bun test` plus `bun test --randomize` with a couple of seeds; and
`bun run-all.ts` in both `examples/bun-jobs-ui` and `examples/bun-nest`.

## Dependency policy

Prefer native/Bun APIs and the in-repo helpers over third-party libraries;
keep the dependency surface small.

- bun-common's small/old deps were replaced with native code in
  **`packages/bun-common/lib/utils/native.ts`** (type guards, `get/set/merge/
  cloneDeep/orderBy/omit/pick/each`, `etag`, cookie parse/serialize/sign,
  `fresh`, `rangeParser`, `appendVary`, `encodeUrl`, `getPort`,
  `createDeferred`, `waitUntil`, `sleep`, `withTimeout`, `computeBackoff`,
  `retry`, `serializeError`/`deserializeError`, `jsonClone`, `Mutex`,
  `Semaphore`) and **`lib/cors.ts`** (native CORS).
  `lib/index.ts` re-exports them via `export * from "./utils/native"`.
- `qs` → `picoquery` for query parsing (`DEFAULT_PARSE_QUERY_OPTS` uses
  `nestingSyntax: "js"`, `arrayRepeat: true`; strip a leading `?` before
  parsing).
- **Kept deliberately** (parsers where native is insufficient):
  `@routejs/router`, `busboy`, `file-type`, `parse-domain`, `mime`, `accepts`,
  `type-is`.

Before adding any dependency, check whether a Bun API or `native.ts` already
covers it; add new helpers to `native.ts` rather than new deps.

### Packaging types (declarations ship; sources ship alongside)

A published package ships built `.d.ts` + `.d.ts.map` in `dts/` next to its
`.ts` sources in `lib/`. Bun runs `lib/` (`main` and every `exports` `default`
point there; no JS is emitted); the type checker reads `dts/` (`types` and
every `exports` `types` condition). The maps point back into `lib/`, so
go-to-definition lands on real source. All four packages do this (for
bun-jobs-ui, `dts/` sits beside `dist/`, its prebuilt browser bundle). The recipe is
four files — `tsconfig.build.json` and `scripts/build-declarations.ts` copied
unchanged (keep the copies identical), a `consumer-check.json`, and
`__tests__/packaging.test.ts` — plus the `package.json` fields below, `dts/`
in the package `.gitignore`, and `./scripts/**/*` in its `tsconfig.json`
`include`.

- **Build**: `bun run build:types` (`scripts/build-declarations.ts`, also run
  on `prepack`). It runs `tsc -p tsconfig.build.json` (`emitDeclarationOnly`,
  `declarationMap`, `rootDir` `lib`, `outDir` `dts`), then rewrites every
  relative specifier in the declarations to `.js`/`/index.js` — tsc copies our
  extensionless specifiers verbatim, and `node16` consumers cannot follow
  them — then verifies: explicit specifiers, map sources published, `exports`
  targets exist, every `lib` module has a declaration, no import of a package a
  consumer may not have. `dts/` is gitignored. Never run `tsc -p
  tsconfig.build.json` by hand; the rewrite is not optional.
- **`exports`**: every entry is `{ "@kingsleyweb/source": lib, "types": dts,
  "default": lib }`, in that order. Keys: `.`, one explicit key per directory
  with an `index.ts` (a `./lib/*` pattern would map `lib/multipart` to a
  nonexistent `lib/multipart.ts`), `./lib/*.ts`, `./lib/*.js`, `./lib/*`,
  `./package.json`. Never a fallback array: Bun does not fall through one at
  runtime. `__tests__/packaging.test.ts` asserts the shape.
- **In-repo resolution**: `tsconfig.base.json` sets `customConditions:
  ["@kingsleyweb/source"]`, so the workspace always type-checks against `lib/`,
  never a stale `dts/` a previous pack left behind (measured: without it, a new
  export read as `TS2305` until someone rebuilt). Consumers never set it.
  `scripts/typecheck.ts` passes with `dts/` present and absent.
- **Acceptance**: `bun scripts/consumer-check.ts packages/<pkg> [--baseline
  <file>]` packs the package, installs the tarball outside the repo and checks
  every spelling in `<pkg>/consumer-check.json` under `bundler` / `bun-init` /
  `node16` (+ `browser` for browser entries) × `skipLibCheck` on/off, asserts
  each named export is not `any`, scans the shipped declarations for leaked
  imports, and imports each spelling under Bun. Any NEW-BROKEN cell fails.
  bun-common: 92/92 cells OK on TS 6.0 and 5.9, against 34 OK on raw `.ts`.
  bun-jobs-ui: 44/44 OK on TS 6.0 (its browser-safe `lib/shared/config` also
  under `browser`), against 28 OK on raw `.ts`.
  bun-nest: 66/66 OK on TS 6.0, against 34/66 on raw `.ts` (its last 8, the
  `./jobs` cells under `bun-init`/`node16`, cleared once bun-jobs shipped
  declarations). bun-jobs: 96/96 OK, against 28/96 on raw `.ts`, with its
  three `api/contract` spellings checked as `browser` entries (no Bun or Node
  types in their graph).
- **`@types/*` backing a type a shipped declaration imports stays a runtime
  `dependency`**, not a `devDependency` (`@types/accepts`, `@types/busboy`,
  `@types/type-is`). Measured: moved to devDependencies, 30 consumer cells
  broke with `TS7016` in `dts/index.d.ts` with `skipLibCheck` off, and with it
  on the root entry went silently `any`. Exceptions: `@types/bun` stays a devDep
  (runtime-env types the consumer already provides; pinning it risks a version
  clash), with the minimum expressed as an *optional* peer range,
  `peerDependencies["@types/bun"] = ">=1.4.2"`, never a pin; and libs that
  bundle their own types (`file-type`, `mime`, `parse-domain`) need no `@types`.
- **Re-export third-party types that appear in the public type surface.**
  `lib/index.ts` has `export type { BusboyConfig, FieldInfo, FileInfo } from
  "busboy"` because `MultiPartOptions`/`MultiPartFileRecord`/
  `MultiPartFieldRecord`/`getMultiParts` are built from them. It is not about
  our own emit (removing it causes no `TS2742`); it is the consumer's only way
  to *name* the type. Measured under `bun install --linker isolated`: a
  consumer re-exporting an inferred `getBusBoyConfig()` result gets `TS2883`
  with or without it, the fix TS asks for is an annotation, and `import type {
  BusboyConfig } from "@kingsleyweb/bun-common"` works only with the re-export
  (`TS2724` without), while importing from `"busboy"` directly fails with
  `TS2307` (not a direct dependency of theirs). bun-nest inherits bun-common's
  types transitively, so fixing bun-common usually suffices.
- **A declaration must never import an undeclared package, and imports an
  optional peer only behind an entry that exists for it.** bun-nest's `./jobs`
  is such an entry: `BunJobsApiModule` is written in bun-jobs' types, and
  bun-jobs is an optional peer. The entry says so in `consumer-check.json`,
  `"peers": ["@kingsleyweb/bun-jobs"]`. The build's verify step
  (`checkPeerScopes`) walks the declarations' import graph from every literal
  `exports` key and every `consumer-check.json` spelling, and fails when a
  declaration importing an optional peer is reachable from one that does not
  list it — the root above all. The consumer check installs two consumers:
  entries without `peers` are checked in one with **no** optional peer
  installed, so a root that reaches one breaks there; entries with `peers` in
  one that has them. Measured for bun-nest: the root without bun-jobs is 6/6
  OK and loads; `./jobs` without it is `TS2307` ×2 in `dts/jobs/*.d.ts` with
  `skipLibCheck` off, silently `any` bun-jobs types with it on, and "Cannot
  find module" at runtime — acceptable, since that subpath needs the peer.
- **Deep imports into a package without an `exports` map need a file
  extension.** tsc copies `@nestjs/common/interfaces` into the declaration
  verbatim, and a `node16` consumer resolves neither a directory nor an
  extensionless file there (`TS2307`). bun-nest imports
  `@nestjs/common/interfaces/index.js`, `…/cors-options.interface.js` and
  `@nestjs/core/adapters/http-adapter.js`.
- **Annotate a public field whose inferred type is environment-specific.**
  `eventEmitter = new EventEmitter()` emitted `EventEmitter<[never]>`, which
  failed `TS2344` against the consumer's `@types/node` in every strict
  column; `eventEmitter: EventEmitter` fixed it. No `TS2742`/`TS2883` arose
  in bun-nest's emit: its declarations name bun-common types through
  `@kingsleyweb/bun-common`, which exports them.

## Logging (`packages/bun-common/lib/logging.ts`)

`Logger` is **structured, not console-shaped**: six levels (`trace` `debug`
`info` `warn` `error` `fatal`), each `(message: string | Error, fields?)`,
plus `log` (alias of `info`), `child(bindings, { name?, level? })` and
`isLevelEnabled(level)`. No variadic `unknown[]` anywhere — that was the old
shape, and it typed nothing.

- `createLogger({ level, name, bindings, sink, enabled, time })` is the only
  implementation; sinks are `consoleSink({ console, format: "pretty"|"json" })`,
  `multiSink`, `collectSink`. `noopLogger` drops everything;
  `createTestLogger()` returns `{ logger, events }` for assertions.
- An `Error` logged as the message, or passed as `fields.error`, is lifted
  onto `LogEvent.error` — a sink has one place to look.
- **Options accept `LoggerLike`, not `Logger`**: a `Logger`, a bare `LogSink`
  function, or a pino / bunyan / winston / consola / log4js / tslog / NestJS /
  console-like logger. `resolveLogger(input?, fallback?)` returns a `Logger`
  as-is and otherwise detects the shape in a fixed order (pino → bunyan →
  winston → consola → log4js → tslog → Nest → console) and wraps it. Name the
  adapter (`fromPino`, `fromWinston`, ...) to skip detection.
- Adapters are **structural** — nothing imports those libraries. Each builds a
  `LogSink` and reuses `createLogger`, so `child()`, level filtering and error
  handling behave identically underneath any of them; bindings are passed in
  the library's structured slot (pino/bunyan's object argument, winston's
  meta), and adapters default to `level: "trace"` so the wrapped library stays
  the authority on its own threshold, delegating via `isLevelEnabled` when it
  has one.
- `BunRouter.logger` resolves once on first access; `setLogger`/`set logger`
  accept any `LoggerLike`. Call sites use `logger.error("message", { error })`,
  never `logger.error("message", err)`.

Compile-time guarantees are asserted in `__tests__/logging.type-test.ts`
(checked by the tests typecheck, not `bun test`); runtime behaviour and every
adapter's call mapping in `__tests__/logging.test.ts`.

## Router — Express 5 semantics

`BunRouter.handle()` (`packages/bun-common/lib/BunRouter.ts`) is a single-pass
Express 5 pipeline walk over `getMatchedLayers()` — every callback of every
matched route.

- Middleware and error handlers run in **route-registration order**. When
  several **route handlers** match, they also run in registration order by
  default, like Express; the `routeSpecificity` option (or
  `setRouteSpecificity()`) opts into **specificity** order instead — `true` for
  the built-in ranking (`routeSpecificityIteratees` — static beats param, fewer
  params / more regexp constraints win) or a custom comparator — with
  registration order as the stable tie-break.
- A callback with **4 parameters** is an **error handler**.
- A thrown error, a rejected promise, or `next(err)` switches the pipeline to
  *error mode*: regular layers are skipped, only error handlers run (invoked
  as `(err, req, res, next)`).
- An error handler calling `next()` with no argument clears the error and
  resumes normal processing; `next(err)` keeps propagating.
- `next('route')` skips the rest of the current route's callbacks;
  `next('router')` abandons the router.
- An unhandled error is re-thrown for the adapter's final error handler
  (`setErrorHandler` / `Bun.serve` `error()` callback).
- `use(path, ...)` registers middleware with `group: path` so
  `@routejs/router` compiles a **prefix** regex (Express prefix matching);
  plain `path:` routes are exact-match.

## Typed routes (generated overloads)

`BunRouter` and both `BunHttpAdapter`s carry **generated** verb overloads that
narrow a handler's request:

- `req.params` from the path literal — `get("/home/:name/:id?", h)` gives
  `{ name: string; id?: string }`. `*name` yields both the positional key and
  the name, matching what the matcher emits.
- `req.query` / `req.body` / `req.params` from a `BunValidate` middleware
  registered ahead of the handler in the same call, via a phantom `__shape`
  type it carries.

They live between `/* --- BEGIN generated typed overloads: <verb> --- */`
markers. **Do not edit them by hand** — regenerate:

```bash
cd packages/bun-common
bun scripts/generate-verb-overloads.ts          # rewrite both packages
bun scripts/generate-verb-overloads.ts --check  # CI: fail if stale
```

Three constraints discovered while building this, all verified by spike:

- They must be **generated per verb, inside the class, ahead of the existing
  overloads**. A single variadic overload cannot work (each position's type
  depends on the previous ones, leaving TypeScript no inference site), and
  declaring the set once and merging it via an interface fails because merged
  members are appended *after* the class's own — the wide
  `(path, ...callbacks)` signature then wins and the handler degrades to `any`.
- Exactly **one** position carries a shape: the validator immediately before
  the handler. Letting every position carry one worked in isolation but
  collapsed in the real class — as soon as a shape position received a
  non-validator, the overload was discarded and the call fell through to the
  untyped signature. `BunValidate` takes every target in one call, so this
  costs nothing in practice.
- Preceding positions are typed `RouterHandler`, not a union — a union gives
  TypeScript no single signature to contextually type an inline arrow against,
  and its parameters land on implicit `any`.

### Validation libraries

`BunValidate` accepts any [Standard Schema](https://standardschema.dev), so
nothing needs adapting. Verified against the real libraries, each passed in
directly, in `__tests__/bunValidate.libraries.test.ts` (runtime) and
`__tests__/bunValidate.libraries.type-test.ts` (inference):

| Library | Version | `~standard` |
|---|---|---|
| zod | 4 | native |
| yup | 1.7 | native |
| valibot | 1 | native |
| arktype | 2 | native |
| superstruct | 2 | **none** — wrap it |

They are **devDependencies of bun-common only** — the library imports none of
them, and the runtime dependency surface is unchanged. They exist so the
"works with any Standard Schema" claim is checked against four independent
implementations rather than asserted.

- **Inference is the point.** After `validate({ query: schema })` the
  handler's `req.query` is the *library's* inferred output: `z.coerce.number()`
  gives `number`, not `string`. The type test carries a negative control —
  flip one assertion and it must fail.
- **Issues follow the spec.** A failure is normalised to
  `{ target, message, path }`, where `path` is the spec's segments (plain or
  `{ key }`) joined with dots. Every library's messages arrive intact.
- **For a library without `~standard`**, `toStandardSchema(validate, { vendor })`
  wraps a plain (sync or async) validate function into a real Standard Schema,
  usable anywhere one is accepted. `superstruct` is covered that way.
- arktype gotcha: a bound cannot follow a morph, so `"string.integer.parse >= 1"`
  is a parse error — express the range inside the definition instead.

### Mounted sub-routers

A sub-router declares the path it will be mounted at, so its routes can see the
mount's params:

```ts
const users = new BunRouter<"/users/:id">();
users.get("/posts/:postId", (req) => req.params); // { id, postId }
adapter.use("/users/:id", users);
```

With a validator at the mount, its `query`/`body` reach the sub-router too, and
the declaration must include them:

```ts
const orgs = new BunRouter<"/orgs/:org", { query: { page: number } }>();
adapter.use("/orgs/:org", validate({ query: PageQuery }), orgs);
```

`use()` requires the declaration and the actual mount to agree — a wrong path,
a wrong shape, or a declared shape mounted without its validator are all
compile errors. Three details make that work, each easy to undo by accident:

- `NoInfer` on the router argument. Without it `TPath` also infers from the
  router, and TypeScript reconciles the two candidates by widening to their
  union — which both then satisfy, so a mismatch passes.
- A phantom `__mount` field (`declare`, so it emits nothing). Without it two
  differently-mounted routers are structurally identical and nothing to
  compare.
- The untyped `use` overloads take `UnmountedRouter`, not `Router`. Otherwise
  they swallow any mismatch the typed overloads reject.

**Mount `params` deliberately do not propagate into the types**, because they
do not propagate at runtime: `use()` middleware is not a route handler, so the
pipeline never binds params for it (a mount validator sees `{}`), and params
are rebound on entering each matched route regardless. Validators also chain —
each replaces `req.query` wholesale, so a sub-route's schema receives the
mount's *output*, not the raw query.

Compile-time assertions live in `__tests__/verbTyping.type-test.ts`,
`__tests__/mountTyping.type-test.ts` and
`packages/bun-nest/__tests__/nestVerbTyping.type-test.ts`; they are checked by
the tests typecheck, not `bun test`. Runtime coverage for mounting is in
`__tests__/bunValidate.test.ts`.

## Testing without a socket: `fetch()`

`BunRouter.fetch()` and both adapters' `fetch()` run a request through the real
pipeline and resolve the `Response`, with no port bound:

```ts
await router.fetch("/users/42");                        // string implies GET
await router.fetch("/posts", { method: "POST", body });  // path + RequestInit
await router.fetch({ url: "/posts", method: "POST", body });
await router.fetch(new Request("http://localhost/x"));   // full control
```

Named `fetch` because it is the same contract as `Bun.serve`'s `fetch` — a
`Request` in, a `Response` out. The adapters override it to delegate to
`handleNativeRequest`, *the very method* their `Bun.serve` handler calls, so a
socket-free test exercises the production path (not-found handlers, error
handlers, the payload guard, response finalisation) rather than an
approximation. `fetch.test.ts` asserts that parity directly by comparing
against a served request.

Prefer it over standing up a server: no port to release, so none of the
`SO_REUSEPORT` hazards below apply. Use a real server only when testing the
socket itself (WebSockets, streaming, keep-alive).

Without a socket there is no peer, so `requestIP()` is `null` and an upgrade
cannot succeed — a stub server reports both honestly rather than pretending.

## Testing conventions & gotchas

- Reuse the test helpers: `packages/bun-common/__tests__/helpers.ts`
  (`testServer`, `makeRequest`, `makeResponse`) and
  `packages/bun-nest/__tests__/helpers.ts` (`makeMultipartRequest`,
  `makeExecutionContext`, `makeCallHandler`). Don't stand up servers by hand.
- Always listen on port `0` (OS-assigned). A bare `Bun.serve({ fetch })` with
  no port defaults to 3000 and will collide with anything already on 3000.
- **Port-release pitfall:** `BunHttpAdapter.close()` must use
  `server.stop(true)` (force-close), never `stop(false)`. A graceful stop
  leaves keep-alive connections alive — and with `SO_REUSEPORT` a freshly
  bound server on the same port receives requests served by the *stale*
  server, producing baffling wrong/empty responses. `getPort` in `native.ts`
  also locks recently-handed-out ports for ~1s for the same reason.
- Writing tests has repeatedly surfaced real bugs here — keep test coverage
  thorough, and keep every existing test green.
- **Inline 4-arg error handlers need a hint.** TypeScript overload
  resolution cannot dispatch by arrow arity, so an untyped
  `(err, req, res, next) => …` inside `router.use/get/all/useMethod(...)`
  resolves through the wider overload and all four params infer as `any`
  (the IDE flags this even when CLI `tsc` doesn't, since CLI tsc doesn't
  cover tests). Use `satisfies RouterErrorMiddlewareHandler` to give the
  arrow a contextual type:

  ```ts
  router.use(((err, _req, res, _next) => {
    res.status(500).json({ error: String(err) });
  }) satisfies RouterErrorMiddlewareHandler);
  ```

  `RouterErrorMiddlewareHandler` is exported from
  `packages/bun-common/lib/types/general.ts`.

## Working preferences

- Match the real framework's semantics exactly when emulating one (e.g.
  Express 5 `use`) — look up the spec, don't approximate.
- Fix all ESLint errors with proper TypeScript types — no lazy `any`.
- The ESLint config restores antfu's `^_` ignore pattern for
  `unused-imports/no-unused-vars`: a leading underscore marks a deliberately
  unused binding (e.g. the mandatory 4th `next` param of an error handler).
- Add tests for every change.
- **Always document properties with a JSDoc description** — when creating a
  new class field, constructor parameter, or options/interface property, AND
  when editing an existing one that lacks a description. This includes
  positional constructor params and every field of inline or named options
  objects. Match the existing concise `/** … */` style (what the property is,
  its default, and any gotcha). Don't leave a public property undescribed.
