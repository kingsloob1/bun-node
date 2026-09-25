# Renaming the control planes: `RemoteWorker` and `RemoteRunner`

Status: **decided** (2026-09-25). This is the implementation plan; nothing is
implemented yet.
Tree read: `origin/develop` at `d54d1fe` (it includes #146, #151 and #152).
Every `file:line` below is from that tree unless it says "simulated head".

### Contents

1. [Decisions](#1-decisions)
2. [Old to new: the mapping](#2-old-to-new-the-mapping)
3. [Corrections recorded](#3-corrections-recorded)
4. [Proven on a simulated head](#4-proven-on-a-simulated-head)
5. [What the two classes are](#5-what-the-two-classes-are)
6. [Persisted and wire strings: do not change](#6-persisted-and-wire-strings-do-not-change)
7. [Inventory and sizes](#7-inventory-and-sizes)
8. [Ownership and sequencing](#8-ownership-and-sequencing)
9. [Method](#9-method)
10. [Proving nothing was missed](#10-proving-nothing-was-missed)
11. [Risks](#11-risks)
12. [Considered and rejected](#12-considered-and-rejected)
13. [Appendices](#appendices)

---

## 1. Decisions

The packages are **not published**, so this is a clean rename. There are no
deprecated aliases, no compatibility re-exports and no deprecation cycle.

| # | Decision | Chosen |
|---|---|---|
| **D1** | Names for the control planes | **Set A, `*Controller`.** `WorkerController`, `WorkerControllerOptions`, `WorkerControllerManager`, `RunnerController`, `RunnerControllerOptions`. The accessor `.remote(x)` becomes `.controller(x)` on both managers. The logger names become `"worker-controller"` / `"runner-controller"`. `supportsRemoteWorkerControl` becomes `supportsWorkerControlRoutes`. The files become `lib/queue/WorkerController.ts` and `lib/runner/RunnerController.ts` |
| **D2** | The option names | **Rename both**, which is option (b). This plan had recommended (a), keeping them; the user chose (b). `remoteControl` becomes **`control`** and `WorkerRemoteControlOptions` becomes **`WorkerControlOptions`**. `remoteConfig` becomes **`allowedOverrides`** and `RunnerRemoteConfigOptions` becomes **`RunnerAllowedOverrides`** |
| **D3** | The "registered by another process" sense of *remote* | **non-local** for identifiers, which mirrors the DTO field `isLocal`. User-facing copy says "registered in another process" / "Other process" |
| **D4** | `WorkerTarget` | Renamed to **`WorkerSelector`** in this rename (Phase 0), so that `WorkerTarget` is free for Phase 1's execution-target option (`target: "thread" \| …`, `docs/plans/worker-runtimes.md:1123-1128`) |
| **D5** | `workerRemoteControl`, the public `BunJobs` option (`BunJobs.ts:129`) | **`workerControl`**, approved by the user. The overlap with the API capability flag of the same name is accepted (below) |

**Why `control`.** It matches what the option turns on, everywhere that
state is already named:

- the heartbeat record's persisted `control.enabled` (`queue/BunQueueWorker.ts:1250`,
  `drivers/driver.ts:1603-1608`);
- the OpenAPI `WorkerControl` schema (`api/schemas/workers.ts:114-115`);
- the `control` events (`queue/RemoteWorker.ts:549-559`,
  `runner/RemoteRunner.ts:609-619`);
- the controller classes.

A worker built with `control: true` reports `control.enabled` and obeys a
`WorkerController`.

**Why `allowedOverrides`.** It is an allow-list: *"What a remote controller may
change about this runner"* (`runner/types.ts:832-836`, `:353`). It is persisted
as `config:allowed` (`runner/config.ts:48`, `:292-294`).

**Why `WorkerSelector` (D4).** The type says *which* workers an instruction
is addressed to: `{ id }` or `{ key }` (`queue/RemoteWorker.ts:40-52`). It
never said where a worker runs, and Phase 1 needs `WorkerTarget` for exactly
that. There are 10 uses, all in bun-jobs: `queue/RemoteWorker.ts:41,286,299,315,341,392,494`,
`queue/index.ts:103`, `lib/index.ts:590` (root export) and `README.md:1034`.
There are **none** in `examples/**`, `packages/bun-jobs-ui/**` or
`playground/**`. `WorkerSelector` is collision-free (`git grep -w -i`).

The methods' parameter is still called `target` (`pause(target: WorkerSelector)`).
That is a local name, UNCOUPLED. Rename it to `selector` in the same file if
the bun-jobs session wants the IDE hints to match. The mapping leaves it
alone. The future-feature plan's own `WorkerTarget`
(`docs/plans/worker-runtimes.md:1123-1128`) is the name being freed, and it
stays.

**Why the `workerControl` overlap is accepted (D5).** The management API's
capability flag is also `workerControl` (`api/contract/types.ts:2973`,
`api/routes/meta.ts:69,184`, `api/schemas/meta.ts:194`). They are different
objects with the same subject:

- `MetaDto.features.workerControl` says the **backend can store** control
  entries;
- `BunJobsConfig.workerControl` sets **each worker's `control` default** for
  workers this context creates (`BunJobs.ts:577`).

They cannot collide in code. A reader who meets both learns one fact about
worker control from each.

The flag's JSDoc (`contract/types.ts:2968-2972`) says *"A worker also has to
be started with `remoteControl` to obey them"*. The mapping turns that into
"started with `control`". The prose pass (§9) rewords it to say what the
option is now: *"A worker also has to be started with `control` (a
`BunJobs` context's `workerControl`, on by default) to obey them"*.

**Internal names that follow from D2.** Signed off by the bun-jobs session on
2026-09-25:

| Old | New | Why |
|---|---|---|
| `resolveRemoteControl` (`runner/options.ts:105`) | `resolveControl` | internal |
| `#remote`, the local `remote` and `remoteOptions` (`BunQueueWorker.ts:741`, `:1000-1013`, `:1251`, `:1280`, `:3620`, `:3628`) | `#controlOptions`, the local `control` and `controlOptions` | Not `#control`, because the class already has a public `get control(): WorkerControlInfo` (`BunQueueWorker.ts:1248`) |
| test env `REMOTE_CONTROL` (`__tests__/fixtures/processes/runner-owner.ts:40`, `runner-config-crossprocess.test.ts:133`, `runner-remote-crossprocess.test.ts:136,245`) | `RUNNER_CONTROL` | uncoupled |

**Collision check.** These have no declaration anywhere in `packages/`,
`examples/` or `playground/` (checked with `git grep -w`):
`WorkerControlOptions`, `allowedOverrides`, `RunnerAllowedOverrides`,
`resolveControl`, `WorkerController*` and `RunnerController*`.

`control` as an options key does not exist today in `BunQueueWorkerOptions`
(`queue/types.ts`) or `BunRunnerOptions` / `ResolvedRunnerOptions`
(`runner/types.ts`). `BunRunner` exposes `readonly options`
(`runner/BunRunner.ts:138`), so `runner.options.control` becomes a boolean.
`BunQueueWorker` exposes no `options`, so its only `control` is the status
getter.

One real collision turned up in a test, and only in the simulation (§4):
`packages/bun-jobs-ui/__tests__/app/pkg/worker-first-start.integration.test.ts:115,125`.
Its `QUEUES` object already has a `control` key, so a blind `remoteControl` →
`control` gives `TS1117`. The mapping renames that key `nonLocalControl`,
because it is the other-context variant, paired with `remotePage`.

## 2. Old to new: the mapping

One row per symbol, file, accessor, option, logger name and user-visible
string.

- **COUPLED**: library surface or strings that consumers call or assert on,
  so they must change in lockstep.
- **UNCOUPLED**: names a consumer chose itself.
- **Signs off**: *bun-jobs* = the bun-jobs session; *examples* = the examples
  session, which also reviews `lib/runner/**` public surface; *UI* = the UI
  session.

The machine-readable copy is `rename-mapping.tsv` (§9). "Where" is the
declaration, or the place the string is defined.

### 2.1 Control planes (D1)

| Old | New | Kind | Coupling | Where | Signs off |
|---|---|---|---|---|---|
| `lib/queue/RemoteWorker.ts` | `lib/queue/WorkerController.ts` | file (`git mv`) | COUPLED | — | bun-jobs |
| `lib/runner/RemoteRunner.ts` | `lib/runner/RunnerController.ts` | file (`git mv`) | COUPLED | — | bun-jobs + examples |
| `RemoteWorker` | `WorkerController` | class | COUPLED | `queue/RemoteWorker.ts:203` | bun-jobs |
| `RemoteWorkerOptions` | `WorkerControllerOptions` | type | COUPLED | `:160` | bun-jobs |
| `RemoteWorkerManager` | `WorkerControllerManager` | class; the type of `BunJobs.workers` (`BunJobs.ts:303`) | COUPLED | `:578` | bun-jobs |
| `RemoteWorkerManager.remote(queue)` | `WorkerControllerManager.controller(queue)` | accessor | COUPLED | `:608` | bun-jobs |
| `RemoteWorkerController` (import alias) | removed: one value import of `WorkerController` | alias | internal | `api/routes/workers.ts:3,20` | bun-jobs |
| `supportsRemoteWorkerControl` | `supportsWorkerControlRoutes` | function (subpath `./lib/api`, `api/index.ts:156`) | COUPLED | `api/routes/workers.ts:100` | bun-jobs |
| `"remote-worker"` | `"worker-controller"` | logger name | observable (§6.4) | `queue/RemoteWorker.ts:226` | bun-jobs |
| `RemoteRunner` | `RunnerController` | class (in `consumer-check.json:13`) | COUPLED | `runner/RemoteRunner.ts:96` | bun-jobs + examples |
| `RemoteRunnerOptions` | `RunnerControllerOptions` | type | COUPLED | `:34` | bun-jobs + examples |
| `BunRunnerManager.remote(id)` | `BunRunnerManager.controller(id)` | accessor; `{@link remote}` at `:33,144` | COUPLED | `runner/BunRunnerManager.ts:211` | bun-jobs + examples |
| `"remote-runner"` | `"runner-controller"` | logger name | observable | `runner/RemoteRunner.ts:130` | bun-jobs + examples |
| `RemoteRunnerInfo` | `SharedRunnerInfo` | type | COUPLED | `runner/types.ts:411` | bun-jobs + examples |
| `RemoteRunRecord` | `TypedRunRecord` | type | COUPLED | `runner/types.ts:381` | bun-jobs + examples |
| `RemoteRunHistoryPage` | `TypedRunHistoryPage` | type (deep-path only today, §3.1) | COUPLED | `runner/types.ts:390` | bun-jobs + examples |
| `WorkerTarget` | `WorkerSelector` (**D4**) | type (root `lib/index.ts:590`, `queue/index.ts:103`) | COUPLED (bun-jobs only; no uses in UI, examples or playground) | `queue/RemoteWorker.ts:41` | bun-jobs |
| `const remote = workersOf(…)`, `remote: RemoteWorker` params | `controller` | local variable | UNCOUPLED, but in the PR | `api/routes/workers.ts:150-801` | bun-jobs |

### 2.2 Options (D2)

| Old | New | Kind | Coupling | Where | Signs off |
|---|---|---|---|---|---|
| `remoteControl` (worker) | `control` | option | COUPLED | `queue/types.ts:994` | bun-jobs |
| `WorkerRemoteControlOptions` | `WorkerControlOptions` | type (root `lib/index.ts:589`, `queue/index.ts:173`) | COUPLED | `queue/types.ts:887` | bun-jobs |
| `remoteControl` (runner) | `control` | option | COUPLED | `runner/types.ts:830`; resolved `:880` | bun-jobs + examples |
| `resolveRemoteControl` | `resolveControl` | function | internal | `runner/options.ts:105` | bun-jobs + examples |
| `remoteConfig` | `allowedOverrides` | option | COUPLED | `runner/types.ts:837`; resolved `:898`, `options.ts:224-226`, `BunRunner.ts:283,285` | bun-jobs + examples |
| `RunnerRemoteConfigOptions` | `RunnerAllowedOverrides` | type (root `lib/index.ts:742`, `runner/index.ts:94`) | COUPLED | `runner/types.ts:354` | bun-jobs + examples |
| `"remoteConfig.executionModes must name at least one execution mode"` | `"allowedOverrides.executionModes must …"` | `ConfigError` message | COUPLED (message) | `runner/options.ts:76` | bun-jobs + examples |
| `` `remoteConfig.executionModes must only contain …` `` | `` `allowedOverrides.executionModes must only contain …` `` | `ConfigError` message | COUPLED (message) | `runner/options.ts:84` | bun-jobs + examples |
| `workerRemoteControl` | `workerControl` (**D5**) | BunJobs option (also `#workerRemoteControl` at `:339,379,577`) | COUPLED | `BunJobs.ts:129` | bun-jobs |
| `#remote`, local `remote`, `remoteOptions` | `#controlOptions`, `control`, `controlOptions` | private and local | internal | `BunQueueWorker.ts:741,1000-1013` | bun-jobs |
| `REMOTE_CONTROL` | `RUNNER_CONTROL` | test env var | UNCOUPLED | `__tests__/fixtures/processes/runner-owner.ts:40` | bun-jobs |
| description text `` `remoteControl: true` `` / `` `remoteControl: "auto"` `` / `` `remoteControl.interval` `` / `` `remoteConfig.executionModes` `` | `control…` / `allowedOverrides…` | OpenAPI description prose | COUPLED: **asserted** by `__tests__/api/api-runners.test.ts:979-987` | `routes/support.ts:177`, `routes/workers.ts:97`, `routes/runners.ts:161`, `schemas/workers.ts:119`, `schemas/runners.ts:165`, `contract/types.ts:1717,2429,2970` | bun-jobs |
| UI copy `remoteConfig.executionModes` | `allowedOverrides.executionModes` | user-visible | COUPLED: **asserted** by UI `config.test.tsx:246,540` | `ConfigEditorDialog.tsx:224`, `actions/explain.ts:67` | UI |
| `QUEUES.remoteControl` / `remotePage` (UI test data) | `nonLocalControl` / `nonLocalPage` | test data key | UNCOUPLED (would collide, §1) | `worker-first-start.integration.test.ts:123,125,844,885` | UI |

### 2.3 Non-local (D3)

| Old | New | Kind | Coupling | Where | Signs off |
|---|---|---|---|---|---|
| `RunnerSource.list()` → `{ local, remote }` | `{ local, nonLocal }` | field (subpath `./lib/api`, `api/index.ts:341`) | COUPLED | `api/sources.ts:388-397`; used at `routes/runners.ts:272,297`, `routes/analytics.ts:649-651`; tests `api-runner-resolve.test.ts:133`, `api-sources.test.ts:322,386,401` | bun-jobs |
| `REMOTE_LATENCY_NOTE` | `NON_LOCAL_LATENCY_NOTE` | const (`api/index.ts:143`) | COUPLED | `routes/support.ts:176` | bun-jobs |
| testid `runner-remote-hint` | `runner-non-local-hint` | DOM contract | COUPLED: **examples** `06-browser/runner-and-job-tools.ts:2221`; UI README `:763` | `actions/index.tsx:135` | UI + examples |
| testid `trigger-remote-note` | `trigger-non-local-note` | DOM contract | COUPLED | `actions/TriggerDialog.tsx:93` | UI |
| testid `remote-note` | `non-local-note` | DOM contract | COUPLED | `RunnerScreen.tsx:291` | UI |
| README row "Runner remote hint" | "Runner non-local hint" | parsed table row | COUPLED: **examples** `04-screens/permissions.ts:1593` | UI `README.md:351` | UI + examples |
| gate name `"runner: remote hint"` | `"runner: non-local hint"` | examples key | COUPLED within the examples | `examples/bun-jobs-ui/04-screens/permissions.ts:1592,4344` | examples |
| `REMOTE_RUNNER_NOTE` | `NON_LOCAL_RUNNER_NOTE` | UI const | COUPLED within the UI | `runnerFormat.ts:197` | UI |
| `REMOTE_ACTIVE` | `NON_LOCAL_ACTIVE` | UI const | COUPLED within the UI | `runnerFormat.ts:61` | UI |
| `gates.remoteOnly` | `gates.nonLocalOnly` | UI field | COUPLED within the UI | `actions/gating.ts:31,66` | UI |
| copy "N remote runners" | "N runners in other processes" | **user-visible** | asserted by `list.test.tsx:106` | `RunnersListScreen.tsx:247` | UI |
| badge "Remote" (list) | "Other process" | **user-visible** | asserted by `list.test.tsx:91` | `RunnersListScreen.tsx:62` | UI |
| badge "Remote" (runner screen) | "Other process" | **user-visible** | asserted by `screen.test.tsx:186` (`"PausedRemote"`) | `RunnerScreen.tsx:273` | UI |
| summary value "No (remote)" | "No (another process)" | **user-visible** | asserted by `screen.test.tsx:192` | `RunnerScreen.tsx:112` | UI |
| `remoteRunnerFixture`, `remoteRunner()`, `remoteHint` | `nonLocalRunnerFixture`, `nonLocalRunner()`, `nonLocalHint` | test fixtures | UNCOUPLED; **in the main PR by the UI session's choice** | `__tests__/app/runners/fixtures.ts:129`, `__tests__/app/runners/actions/fixtures.tsx:103`, `realApiClearHistory.tsx:31` | UI |
| the examples' own `remoteRunner`, `remote`, `RemoteProcess`, `startRemoteWorker`, `helpers/remote-worker.ts`, `helpers/remote-process.ts`, `remoteHeard`, `remoteView` | the examples session's choice | uncoupled names | UNCOUPLED; **on the examples session's schedule** | `examples/**` | examples |

### 2.4 Kept, explicitly

A name that still contains *remote* after this rename stays by decision:

| Kept | Where | Why |
|---|---|---|
| error titles "Worker cannot be controlled remotely", "Runner cannot be configured remotely" | `api/errors.ts:124,129` | wire, and accurate (§6.3) |
| details "was started without remote control" / "predates remote control"; "has no owner that supports remote configuration" | `api/routes/workers.ts:179-180`; `runner/RemoteRunner.ts:568` | wire, accurate |
| capability prose: "remote control", "remote configuration", "remotely", "a remote controller", "remote override", "There is no remote kill" | ~100 lines in lib/app/README (Appendix B) | describes controlling from afar, which stays true |
| README anchor `#changing-a-runners-configuration-remotely` | `packages/bun-jobs/README.md:106,2517,2637,2921,3915` | accurate. Renaming it breaks in-page links |
| example files `07-runner/remote-control.ts`, `10-options/remote-control.ts` (in `RUN_ALONE`, `examples/bun-jobs/run-all.ts:59`) | examples | the examples session's call |
| data: runner ids `remote`, `remote-sync`, `remote-owned`; namespaces `remote-control`, `tour-remote`, `fu-remote`; the notifier example's queue `remote` | tests, examples | data, not names |
| unrelated: `BunQueue#onRemoteEvent` (`queue/BunQueue.ts:492,2947`), "remote server", "remote document", `remoteAddress`, `--remote-debugging-port` | various | not this concept |

## 3. Corrections recorded

### 3.1 `RemoteRunHistoryPage` and `RunHistoryPage`

- `RemoteRunHistoryPage` is **not exported** from the package root or from
  `lib/runner/index.ts` at `d54d1fe`. It exists only at `runner/types.ts:390`.
  The coordinator confirmed this with a compile probe, including a negative
  control. It is public only through the return type of
  `RemoteRunner.historyPage()` (`RemoteRunner.ts:396-412`), and nameable only
  by deep path.
- `RunHistoryPage` (`drivers/runHistory.ts:70-91`) is `{ records: RunRecord[];
  total; offset? }`. `RunRecord.result` is `unknown` (`drivers/driver.ts:198`).
- `RemoteRunHistoryPage<TResult>` (`runner/types.ts:390-400`) is the same three
  fields, but with `records: RemoteRunRecord<TResult>[]`: the result typed as
  `TResult | TruncatedRunResult` (`:381-384`).

**So they are distinct.** One is the driver-level page and the other is its
typed-result view, and at `TResult = unknown` they are structurally identical.

One could absorb the other by making `RunHistoryPage<TResult = unknown>` and
`RunRecord<TResult>` generic. That would change the **driver contract types**,
and pull `TruncatedRunResult` (`runner/types.ts:368`) into `drivers/`. Today
`drivers/` imports nothing from `runner/` (checked). That is a type-design
change, not a rename.

**This plan renames only**, to `TypedRunHistoryPage`. Adding a root export for
it, and any absorption, is **a scope addition for the bun-jobs session to
review**. It is not part of the mapping.

### 3.2 Trigger is not owner-only

From source, only **kill** and **reset stats** are owner-only:

- `LOCAL_ONLY` at `bun-jobs-ui/app/screens/runners/actions/explain.ts:42-45`;
- the gate `remoteOnly: !runner.isLocal && (canKill || canReset)`,
  `actions/gating.ts:66`;
- the API answers 409 `RUNNER_NOT_LOCAL`.

A trigger on a non-local runner is queued for its owner
(`actions/TriggerDialog.tsx:89-97`; `runner/RemoteRunner.ts:301-316`). Pause,
resume, reschedule, configure and clear history all work from anywhere,
through stored state.

## 4. Proven on a simulated head

The latest proof ran on `rename/full2` in the features session's scratchpad:
a fresh `git archive d54d1fe`, with a new `bun install` at the root and in the
three bench directories. It used the current `rename-mapping.tsv` (68 rows,
including D4), and then the **single** hand edit: deleting the now-duplicate
`import type { WorkerController }` at `api/routes/workers.ts:3`. `full2` is
not a git repository, so every search below uses plain `grep -r`.

**`bun scripts/typecheck.ts`: 16 projects, no type errors.**

| Project | Result |
|---|---|
| `packages/bun-common` | ok |
| `packages/bun-common/bench` | ok |
| `packages/bun-common/playground` | ok |
| `packages/bun-nest` | ok |
| `packages/bun-jobs` | ok |
| `packages/bun-jobs/bench` | ok |
| `packages/bun-jobs-ui` | ok |
| `packages/bun-jobs-ui/app` | ok |
| `benchmarks` | ok |
| `playground` | ok |
| `examples/bun-jobs` | ok |
| `examples/bun-common` | ok |
| `examples/bun-nest` | ok |
| `examples/bun-jobs-ui` | ok |
| `packages/bun-jobs-ui/__tests__/app/pkg` | ok |
| `scripts` | ok |

**The strict old-name greps (§10.1), with a negative control.** Both run with
`grep -rn -I -E … --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=dts`:

| Tree | Pattern 1 (`packages examples playground`) | Pattern 2 (`packages`) | old files present |
|---|--:|--:|--:|
| base (`rename/basefull`, a fresh `d54d1fe` archive) | **475** | **69** | 2 |
| head (`rename/full2`) | **0** | **0** | 0 |

**The other checks on `full2`:**

- Do-not-change: all 65 literals are present in `packages/bun-jobs/lib`, with
  identical counts on base and head.
- The case-insensitive residual (§10.2): 35 lines, the same 35 as Appendix C.
  The KEEP set is 102 lines, as in Appendix B.

**From the earlier run on `rename/full`** (the same mapping without D4, also
the one hand edit):

- **Lint.** `CI=1 bunx eslint .` gave formatting and import-order errors only.
  After `bunx eslint . --fix` (twice in bun-jobs), `packages/bun-jobs-ui`,
  `examples/bun-jobs`, `examples/bun-jobs-ui` and `playground` were clean.
  **One** manual edit remained: `__tests__/fix-core-keystop.test.ts:89`, where
  `antfu/consistent-chaining` and prettier disagree about a method chain.
  Split the chain.
- **Tests.** See §10.4. D4 changes one type name in bun-jobs, so it cannot
  change a runtime result. It was proven by the typecheck above.

## 5. What the two classes are

Both classes are control planes. They write state the driver persists and
publish a hint event, and neither of them runs anything.

- `RemoteWorker`: *"Controls the workers of one queue, wherever they run"*
  (`queue/RemoteWorker.ts:177-178`). It writes through `writeWorkerControl`
  (`:421-431`) and `writeWorkerConfig` (`:471-477`), and it publishes `control`
  (`:537-566`). It never claims a job.
- `RemoteRunner`: *"Controls a runner registered by **any** process sharing
  the driver and namespace"* (`runner/RemoteRunner.ts:64-67`). It writes
  `setState` (`:167-170`, `:191-194`, `:212-215`) and pushes queued triggers
  (`:339-351`). *"There is no remote kill"* (`:93-94`).
- Their JSDoc already calls them "the controller" (`RemoteWorker.ts:213,588,607`;
  `RemoteRunner.ts:46,108`). So does the API: `ResolvedRunner.controller`
  (`api/sources.ts:328,338`), `const { controller } = await
  services.runners.resolve(id)` (`routes/runners.ts:276,323`).

`docs/plans/worker-runtimes.md` §2.2 (`:174-190`) calls the name a trap. §4
and §5 there are the remote-execution feature the freed names go to. After
this rename, *remote* in an identifier means **executes elsewhere**, and
nothing else.

## 6. Persisted and wire strings: do not change

**No persisted key, event name, channel, operationId, tag, schema name,
`x-bun-jobs-*` field or cursor literal contains "remote".** Nor does either
option name reach storage or the wire:

- `control` (was `remoteControl`) surfaces only as the heartbeat record's
  `control.enabled` (`BunQueueWorker.ts:1250`, `driver.ts:1603-1608`) and the
  DTO `WorkerControlDto.enabled` (`contract/types.ts:1716-1718`);
- `allowedOverrides` (was `remoteConfig`) surfaces only as `config:allowed`
  and `RunnerConfigInfo.allowed` (`runner/config.ts:48`).

Both of those names stay. The user's running `playground/` therefore keeps its
data across the rename; it needs a restart, and its two option spellings
change (`playground/scheduling.ts:145`, `playground/README.md:61`).

The machine-checkable list is `rename-do-not-change.txt` (§9). Every entry
was verified unchanged on the simulated head.

### 6.1 Stored by the drivers

| String | Where | If changed |
|---|---|---|
| runner key `` `r:${id}` `` | `shared/keys.ts:70-72` | **strands live state for good.** A runner record is never removed: not by `remove()`, not by stopping, not by process exit. Only `driver.purge(namespace)` erases it (`BunRunnerManager.ts:31-41,140-149`). A new key orphans the pause flag, the schedule and the overrides |
| runner fields `paused`, `schedule`, `file`, `name`, `queueRuns`, `maxQueuedRuns`, `lockTtl`, `updatedAt`, `updatedBy` | `runner/BunRunner.ts:414-426` | same |
| `config:executionMode` … `config:updatedAt` (including `config:allowed`) | `runner/config.ts:36-58` | same |
| `stat:*` counters | `RemoteRunner.ts:54-62,358,597,633` | same |
| worker prefixes `wcfg:`, `wctl:`, `wstop:`, `wchg` under `RESERVED_STATE_PREFIX` = `"__win:"` | `queue/workerControl.ts:47-63`, `queue/windows.ts:27` | pending instructions and overrides are lost |
| heartbeat `control` fields (`enabled`, `mode`, `appliedSeq`, `configSeq`, `pending`, `stopPersistence`, `stopPersistenceOverridable`, `lastError`) | `drivers/driver.ts:1603-1640` | records from running workers stop parsing |

### 6.2 Cursors

The complete literal set:

- prefixes `"jl1."` (`drivers/jobCursor.ts:45`) and `"rh1."`
  (`drivers/runHistory.ts:95`);
- kinds `"jobsList"` (`jobCursor.ts:48`) and `"runHistory"`
  (`runHistory.ts:98`);
- on the jobs list only, the walk binding `[ns, queue, sorted states joined by
  ",", sort ?? "natural", order]` (`jobCursor.ts:203-211`), with sorts
  `["natural", "createdAt"]` (`api/contract/constants.ts:224`) and orders
  `"asc"` / `"desc"`;
- the envelope `{ v: 1, k, w, p }` (`drivers/pageCursor.ts:79-85`).

The run-history binding is `[ns, runner, order]` (`runHistory.ts:111-113`),
with no sort and no fallback. Its runner id is caller data. Cursors are
minted and parsed at `routes/jobs.ts:226,326,360` and
`routes/runners.ts:369,413`.

1. **Kind and binding literals are covered, not only prefixes.** A change to
   any of them makes every cursor already minted read as another walk: a
   correct but useless 400 `INVALID_ARGUMENT`.
2. **`"natural"` at `jobCursor.ts:208` is wire content.** It appears in no
   request and no type.
3. **The prefix digit is the migration mechanism.** A payload change is
   `jl1` → `jl2` (or `rh1` → `rh2`), never a quiet reshape. Which case applies
   today: nothing is publicly deployed, so a reshape would 400 only the cursors
   live clients of the user's own deployment hold. This rename touches none of
   it.
4. **The two `walkParts` (`jobCursor.ts:203`, `runHistory.ts:111`) stay
   separate.** Merging them changes one payload, which makes it a
   prefix-version change, not a refactor.

### 6.3 Management API

- **operationIds**: 74 in total, 70 literal plus `` `${name}Worker` `` at
  `routes/workers.ts:264`. None contains *remote*.
- **tags**: `Analytics`, `Docs`, `Jobs`, `Meta`, `Queues`, `Runners`, `Workers`.
- **actions**: `workers.*` and `runners.*`.
- **schema names**: including `WorkerControl`, `RunnerInfo`, `RunRecord`.
- **AsyncAPI and WebSocket**: `lib/api/spec/*` and `lib/api/ws/*` contain no
  *remote*.
- **`x-bun-jobs-*`**: `codes`, `action`, `mutation`, `requires`, `csrf`
  (`spec/openapi.ts:215-259`).
- The capability flag `workerControl` is at `contract/types.ts:2973`.
- The DTO has `isLocal` and the deprecated `local` (`routes/runners.ts:281-300`).

The only wire strings containing *remote* are prose, and all of them are kept:

| String | Where | Asserted by |
|---|---|---|
| title "Worker cannot be controlled remotely" | `api/errors.ts:124` | — |
| title "Runner cannot be configured remotely" | `api/errors.ts:129` | UI `config.test.tsx:552,571` (as a fixture) |
| details "…was started without remote control" / "…predates remote control" | `routes/workers.ts:179-180` | — |
| detail "…has no owner that supports remote configuration…" | `RemoteRunner.ts:568`, via `routes/runners.ts:225-228` | — |

The OpenAPI **descriptions** change under D2, from `remoteControl…` to
`control…`. That is prose in the generated document, not a contract field.
`api-runners.test.ts:979-987` follows it mechanically. Consider tightening its
assertion to the backticked `` `control: true` ``, because the bare
substring `control: true` is weaker than the old `remoteControl: true` was.

### 6.4 Observable, but not stored

The logger names change from `"remote-worker"` / `"remote-runner"` to
`"worker-controller"` / `"runner-controller"`. They reach the `child()`
logger's `name` (`shared/logger.ts:18-24`). A log filter keyed on the old
names misses the new ones. No test or example asserts on them.

### 6.5 Examples that would catch a wire change

- `examples/bun-jobs/10-options/remote-control.ts`: stored control state,
  read back by a second process.
- `examples/bun-jobs-ui/06-browser/workers.ts` and `live-events.ts`: socket
  payloads and serialised worker records, including `control.enabled`.

Run them in the gate. Their only edits are the mapped call sites.

## 7. Inventory and sizes

The scan is case-insensitive over the whole repo: 1,542 lines in 144 files.
Families are counted on the base in lines and occurrences; Appendix A lists
every file.

| Family | Sense | Files | Lines | Occ. |
|---|---|--:|--:|--:|
| C1 class and type names | controller | 39 | 175 | 185 |
| C2 accessor `.remote()` / `remote(id)` | controller | 39 | 132 | 132 |
| C3 logger names | controller | 2 | 2 | 2 |
| O1 `remoteControl` family | capability (now D2) | 43 | 111 | 123 |
| O2 `remoteConfig` family | capability (now D2) | 22 | 54 | 56 |
| T3c non-local strings others assert on | non-local | 13 | 25 | 25 |
| T3u non-local words and identifiers | non-local | 42 | 120 | 125 |

**Lines changed by the mechanical mapping**, measured on `full2` against a
fresh base, before `eslint --fix` (which re-wraps a few more). The
`packages/bun-jobs/lib` row includes the two moved files: 21 lines in
`WorkerController.ts` and 24 in `RunnerController.ts`.

| Area | Files | Lines |
|---|--:|--:|
| `packages/bun-jobs/lib` | 29 | 223 |
| `packages/bun-jobs/__tests__` | 26 | 172 |
| `packages/bun-jobs/README.md` | 1 | 46 |
| `packages/bun-jobs/consumer-check.json` | 1 | 1 |
| `packages/bun-jobs-ui/app` | 8 | 19 |
| `packages/bun-jobs-ui/__tests__` | 15 | 60 |
| `packages/bun-jobs-ui/README.md` | 1 | 4 |
| `playground` | 2 | 2 |
| **`examples/bun-jobs`** | **10** | **52** |
| **`examples/bun-jobs-ui`** | **4** | **15** |

**The examples half, resized for D2 (b).** It is 67 lines in 14 files.
Breakdown of the coupled part:

- the accessor, 35 lines;
- `control`, 13 lines / 14 occurrences;
- `allowedOverrides`, 9 lines / 9 occurrences, including the type-level key
  `| "remoteConfig"` at `06-browser/runner-and-job-tools.ts:284`, which is
  compile-coupled;
- the D3 strings, 4 lines (`permissions.ts:1592,1593,4344`,
  `runner-and-job-tools.ts:2221`).

Per file:

| File | Lines |
|---|--:|
| `07-runner/helpers/runner-owner.ts` | 1 |
| `07-runner/remote-control.ts` | 7 |
| `10-options/errors.ts` | 2 |
| `10-options/notifier.ts` | 2 |
| `10-options/remote-control.ts` | 19 |
| `10-options/run-logs-and-clears.ts` | 3 |
| `10-options/runner-options.ts` | 13 |
| `11-management-api/helpers/discovered-queue.ts` | 1 |
| `11-management-api/live-events-delivery.ts` | 1 |
| `examples/bun-jobs/README.md` | 3 |
| `04-screens/permissions.ts` | 3 |
| `06-browser/live-events.ts` | 2 |
| `06-browser/runner-and-job-tools.ts` | 8 |
| `06-browser/workers.ts` | 2 |

The examples' uncoupled names are **not** in the mapping's `code` scope for
D3, and stay on their owner's schedule.

**Description-text assertions D2 breaks, both followed by the mapping:**

- `api-runners.test.ts:979-987`, the OpenAPI descriptions;
- UI `config.test.tsx:246,540`, the UI copy.

Both were green in the simulated typecheck; their runtime result is in §10.4.

## 8. Ownership and sequencing

Owners, by role:

- **the bun-jobs session** owns `packages/bun-jobs/**`;
- **the examples session** owns `examples/**`, and reviews public-surface
  changes in `packages/bun-jobs/lib/runner/**` (the bun-jobs session
  implements there);
- **the UI session** owns `packages/bun-jobs-ui/**` and `playground/**`;
- **the features session** drives this rename.

**PR 1 (the features session):**

- bun-jobs `lib/`, `__tests__/`, `README.md` and `consumer-check.json`;
- the UI identifiers and copy (§2.3), which the UI session asked to have in
  the main PR, fixtures included;
- `playground/` (2 lines);
- `docs/plans/worker-runtimes.md`: nine references
  (`:51,174,177,182,188,232,312,340,2706`), plus a line recording that the
  name is now free.

**PR 2 (the examples session, stacked on PR 1):**

- apply `rename-mapping.tsv` to `examples/**` (the `code` scope);
- then **rewrite** the prose it touches, because "`RemoteWorker`, the
  lower-level call" (`10-options/remote-control.ts:698`) now needs different
  words, not substituted ones.

**Merge.** `scripts/typecheck.ts:35-38` typechecks the examples, so neither PR
is green alone. Run the gate on PR 2's head. Then merge PR 2 into PR 1's
branch and land PR 1 as **one merge commit**, so `develop` never carries a red
commit.

**Sign-offs**

| Area | Sign-off |
|---|---|
| `lib/runner/**`: `RemoteRunner.ts` → `RunnerController.ts`, `types.ts` (including `TypedRunHistoryPage`, `RunnerAllowedOverrides`, `control`), `options.ts` (messages at `:76,84`), `index.ts`, `BunRunnerManager.ts`, `BunRunner.ts`, `config.ts`, `clearHistory.ts` | **the examples session and the bun-jobs session.** A rename is not feature-driven, so both review |
| `lib/queue/**`, `lib/BunJobs.ts` (including the flagged `workerControl`), `lib/index.ts`, `lib/api/**`, `lib/shared/**`, `__tests__/**`, README, `consumer-check.json` | the bun-jobs session |
| `packages/bun-jobs-ui/**`, `playground/**` | the UI session |
| `examples/**` (PR 2) | the examples session |
| the §3.1 scope addition (export `TypedRunHistoryPage` from the root; absorb it into `RunHistoryPage` or not) | **Decided by the bun-jobs session, 2026-09-25: neither — rename only, keep it unexported.** Exporting or absorbing is an API decision, and a rename that also makes one is harder to review and to revert. It lives in `lib/runner/**`, so making it public is the examples session's call to raise afterwards |

**In-flight work.**

- `gh pr list --state open` shows only **#154** (`feat/ui-jobs-cursor`).
  Among files that mention "remote", it touches only
  `packages/bun-jobs-ui/README.md`, at hunks `:116-135` and `:231-237`. The
  rename edits that README at `:123`, `:350-432` and `:756-764`. There is no
  textual conflict, but lines shift by +65. **Merge #154 first**, then
  re-apply.
- The bun-jobs session reports no branches or worktrees touching
  `RemoteRunner.ts` or `RemoteWorker.ts`.
- Local worktree `fix/count-jobs-predicate` is clean at `d54d1fe`.

**Gate**, on the stacked head, in a fresh worktree:

1. `bun install`, and assert `@kingsleyweb/*` resolves inside the worktree.
   Run `bun install` in `packages/bun-jobs/bench`, `packages/bun-common/bench`
   and `benchmarks/`. Delete `packages/bun-jobs/dts/` and
   `packages/bun-jobs-ui/dist/`.
2. `bun scripts/typecheck.ts`: clean.
3. `CI=1 bunx eslint .` in `packages/bun-jobs`, `packages/bun-jobs-ui`,
   `examples/bun-jobs`, `examples/bun-jobs-ui` and `playground`.
4. `bun run build:types` in `packages/bun-jobs`, then
   `bun scripts/consumer-check.ts packages/bun-jobs`. The baseline is 96/96.
   Its values now say `RunnerController`; add `WorkerController`.
5. `bun test` in `packages/bun-jobs` with every database URL exported.
   `bun test` and `bun test --randomize` (two seeds) in `packages/bun-jobs-ui`.
6. `bun run-all.ts` in `examples/bun-jobs`, `examples/bun-jobs-ui` and
   `examples/bun-nest`. Run the **full 8-backend sweep** once, with
   `EXAMPLE_DRIVER` per backend and all five URLs exported, and expect **71
   of 71** per backend in `examples/bun-jobs`. Quote what ran.
7. §10 and the do-not-change check.

## 9. Method

Artifacts, in the features session's scratchpad
(`/tmp/claude-1000/-home-kingsloob1-Desktop-projects-mine-bun-node/ae3600c2-7626-4de2-ab39-b5ca45258d5b/scratchpad/`):

- **`rename-mapping.tsv`**: `old<TAB>new<TAB>kind<TAB>match`, with a header
  row, ordered longest-`old` first.
  - `match` is `word`, meaning `(?<![A-Za-z0-9_$])OLD(?![A-Za-z0-9_$])`, or
    `literal`, meaning an exact substring.
  - `kind` is `<what>@<scope>`. The scope is `code` (`packages/`, `examples/`,
    `playground/`), `packages` (`packages/` only), or `file=<path>` (base
    paths, so the one row scoped to `lib/queue/RemoteWorker.ts` must be
    re-pointed at `WorkerController.ts` if the move is done first).
  - Rows are applied in file order, so `RemoteWorkerManager` is replaced
    before `RemoteWorker`, and `trigger-remote-note` before `remote-note`.
  - The rows never match bare `remote` outside a file scope. Data strings
    (runner ids, namespaces) are untouched.
- **`rename-do-not-change.txt`**: 65 literals, one per line. The check:
  `grep -rF -- "$literal" packages/bun-jobs/lib | wc -l` must be equal on the
  base and the head for every line.
- `rename/apply.pl`: the applier used for the simulation (`perl apply.pl
  <tsv> <root>`).

Steps:

1. `git mv` the two files as a move-only commit, taken when the owner asks
   to commit. This keeps `log --follow` and blame.
2. Apply the TSV. In PR 1 that is the `code` rows limited to `packages/` and
   `playground/`, plus all `packages` and `file=` rows. In PR 2 it is the
   `code` rows on `examples/`.
3. **By hand, the only code edits the TSV leaves:**
   - delete the duplicate `import type { WorkerController }` at
     `api/routes/workers.ts:3`;
   - split the chain at `__tests__/fix-core-keystop.test.ts:89`.
4. `bunx eslint . --fix` in each touched project; bun-jobs needs it twice.
5. **The prose pass.** Rewrite every edited JSDoc and README sentence, rather
   than trusting the substitution, and clear the 35 lines in Appendix C.
   - These carry measured or quantitative claims. Re-read each and keep the
     number and what it measures intact:
     - `runner/types.ts:814-829`: "tens of milliseconds on every backend" and
       "a query every few dozen milliseconds **per runner**". It sits in the
       rewritten `BunRunnerManager.remote()` / `remoteControl` sentence;
     - `README.md:3146`: 25 ms file / 50 ms SQL and MongoDB;
     - `routes/support.ts:177`: 25–50 ms and "30s", asserted by
       `api-runners.test.ts:979-987`;
     - `routes/workers.ts:97`: 2 s, 10 s;
     - `BunJobs.ts:117-129`: 2 s;
     - `RemoteRunner.ts:80-83,229-231`: 30 s.
   - `BunRunnerManager.ts:31-41` gives the rationale for "a record is never
     removed" that §6.1 relies on. Keep its meaning exactly.
   - The capability flag's JSDoc, `contract/types.ts:2968-2972`: reword it to
     *"A worker also has to be started with `control` (a `BunJobs` context's
     `workerControl`, on by default) to obey them"* (D5).
   - The "Remote worker control:" / "Remote runner control:" / "Remote runner
     configuration:" headers (`lib/index.ts:138,639,758`, `runner/config.ts:16`,
     `contract/types.ts:2968`) read as "control of a remote worker" once
     *remote* means execution. Reword them: "Worker control from another
     process", and so on.
   - Rename the README code samples' `const remote = await
     jobs.runners.controller(…)` (`README.md:2939,3006`) after the runner:
     `cleanup`, `report`.
6. Optional, and uncoupled: rename the test files `runner-remote.test.ts`,
   `runner-remote.type-test.ts`, `runner-remote-crossprocess.test.ts` and
   `followups-remote-u4.test.ts`, and update `runner-config.test.ts:22`, which
   names one of them.

## 10. Proving nothing was missed

### 10.1 Must print nothing: the old names

This runs over `packages/`, `examples/` and `playground/`. In the real
worktree use `git grep` as shown. In an extracted copy that is not a git
repository, use `grep -rn -I -E '<same pattern>' packages examples playground
--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=dts`, because
`git grep` there searches nothing and prints 0 for the wrong reason. Always
run the same command on the base as a negative control; it must be positive
(475 and 69 lines, §4).

```sh
git grep -n -I -E '\bRemote(Worker|Runner)(Manager|Options|Info|Controller)?\b|RemoteRun(Record|HistoryPage)|supportsRemoteWorkerControl|"remote-(worker|runner)"|\.remote(<[^>]*>)?\(|\{@link remote\}|\bremote\((id|queue)?\)|remoteControl|remoteConfig|RemoteControlOptions|RemoteConfigOptions|REMOTE_CONTROL|runner-remote-hint|trigger-remote-note|[Rr]unner:? remote hint|\bWorkerTarget\b' \
  -- packages examples playground
git grep -n -I -E 'REMOTE_LATENCY_NOTE|REMOTE_RUNNER_NOTE|REMOTE_ACTIVE|remoteOnly|remoteRunner|remoteHint|remote-note|"No \(remote\)"|remotePage|PausedRemote|>Remote<|^\s+Remote$' \
  -- packages
test ! -e packages/bun-jobs/lib/queue/RemoteWorker.ts && test ! -e packages/bun-jobs/lib/runner/RemoteRunner.ts
```

On `full2`, both print 0 lines. On the base they print 475 and 69 (§4).

### 10.2 The final case-insensitive grep

```sh
KEEP='remote(ly)?[ -]?(control|config)|[Rr]emotely|Remote-configuration|remote (kill|edit|caller|override|change)|remote `(stop|start|trigger)|(predates|since|before|by a|\(a) remote$|#onRemoteEvent|[Rr]emote (event|listener|server|document)|remote-debugging|remoteAddress|"Remote"|remote-control(\.ts|")'
git grep -n -I -i remote -- packages playground CLAUDE.md README.md \
  | grep -v -E '^packages/[^/]+/(__tests__|bench)/' \
  | grep -v -E "$KEEP"
```

**It must print nothing.** On the simulated head, before the prose pass, it
prints exactly the 35 lines of Appendix C, and those are the prose pass's
to-do list.

**The set of lines it is allowed to leave behind:**

1. **KEEP, in `lib/`, `app/`, the READMEs and `playground/`**: the lines
   matching `$KEEP`. That is 102 lines on the simulated head, in the files
   and counts of Appendix B. After the prose pass the count may fall, but no
   file may rise above its Appendix B figure, and no new file may appear.
   Check with:

   ```sh
   git grep -n -I -i remote -- packages playground CLAUDE.md README.md \
     | grep -v -E '^packages/[^/]+/(__tests__|bench)/' | grep -E "$KEEP" \
     | cut -d: -f1 | sort | uniq -c
   ```

   What they are:
   - capability prose ("remote control", "remote configuration",
     "remotely", "a remote controller", "remote override", "remote edit",
     "remote caller", "remote `stop`", "There is no remote kill");
   - the wire titles and details of §6.3;
   - lines wrapped as "…predates remote / since remote / by a remote" +
     "configuration|control" on the next line;
   - `BunQueue#onRemoteEvent` and "remote event/listener" (driver events
     from another process);
   - "remote server" (`mongo-driver.ts:2382`) and "(a remote" + "document"
     (UI `docs/schema/resolve.ts:39`);
   - README links to the examples' `remote-control.ts`.
2. **Everything under `packages/*/__tests__/**`** (473 lines on `full2`): test titles, local variables such as `const remote = new
   WorkerController(…)`, and data ids. These are UNCOUPLED and on the bun-jobs
   and UI sessions' own schedules. §10.1 already guarantees no old *name*
   survives there.
3. **Everything under `examples/**`** (241 lines on `full2`): UNCOUPLED, on the examples
   session's schedule, with §10.1 covering the coupled strings.

### 10.3 The do-not-change check

```sh
L=/tmp/claude-1000/-home-kingsloob1-Desktop-projects-mine-bun-node/ae3600c2-7626-4de2-ab39-b5ca45258d5b/scratchpad/rename-do-not-change.txt
while IFS= read -r l; do
  b=$(git grep -F -- "$l" d54d1fe -- packages/bun-jobs/lib | wc -l)
  h=$(git grep -F -- "$l" -- packages/bun-jobs/lib | wc -l)
  [ "$b" = "$h" ] || echo "CHANGED: $l ($b -> $h)"
done < "$L"
```

It must print nothing. On the simulated head it prints nothing.

### 10.4 Test run on the simulated head

Run on the simulated head, with no database URLs set, so the SQL, Redis and MongoDB suites skip visibly:

- **`packages/bun-jobs`: 3,095 pass, 405 skip, 1 fail**, across 185 files.
  - The one failure is `queue-worker.test.ts` › "aborts an attempt that
    outlives its timeout". That file is byte-identical on base and head.
  - It is a **pre-existing flake**. On an untouched `d54d1fe` copy it failed
    1 of 3 runs, and on the head 2 of 3.
- **`packages/bun-jobs-ui`: 1,541 pass, 1 fail.**
  - The failure was `screen.test.tsx:186`, which asserts the concatenated
    badge text `"PausedRemote"`. The run found it, and it is now a row in the
    TSV (`"PausedRemote"` → `"PausedOther process"`).
  - **In the real PR this becomes a second hand edit, at the UI session's
    request (2026-09-25):** replace the concatenated assertion with one
    assertion per badge ("Paused", "Other process"). The concatenation was
    already weak — it passes if a single badge reads "PausedRemote" — and the
    rename makes that visible. The TSV row stays, so the dry run remains green;
    the per-badge form is what the PR ships.
  - With it applied, `__tests__/app/runners` is **233 pass, 0 fail**.
- Not run here: the gate's database-backed suites, `--randomize`, and the
  examples sweep. Those belong to the real gate (§8).

## 11. Risks

- **A too-broad substitution** reaching data or a stored literal. The TSV
  never matches bare `remote` outside a file scope, and §10.3 guards the
  literals.
- **`control` next to `worker.control`.** On a worker, the option `control`
  (what to obey) and the getter `worker.control` (`WorkerControlInfo`, what it
  reports) share a name. That is deliberate, following the user's rationale,
  and the types differ. A reader of `new BunQueueWorker(q, fn, { control:
  true })` and `worker.control.enabled` sees the connection the name intends.
- **`workerControl` next to `features.workerControl`** (§1). Decided by the
  user as D5; accepted.
- **`control` the option and `control` the getter** (raised by the bun-jobs
  session). `options.control` is `boolean | WorkerControlOptions`, while the
  existing public getter `worker.control` (`BunQueueWorker.ts:1248`) returns
  `WorkerControlInfo` — `enabled`, `mode`, `appliedSeq`, `pending`. Same name,
  different types. Accepted, because it follows an existing input-versus-
  resolved pattern: `logger` takes `LoggerLike` and its getter returns the
  resolved `Logger`. **Prose pass adds one sentence** to the option's JSDoc:
  the getter reports live control state rather than echoing the option.
  `BunRunner` has no `control` getter, so the runner side is clean.
- **The description-text assertion at `api-runners.test.ts:979-987`** must
  assert the backticked `` `control: true` `` / `` `control: "auto"` `` form,
  not bare `control` (agreed with the bun-jobs session). `remoteControl` was a
  distinctive token; bare `control` appears throughout unrelated prose, so the
  mechanical rewrite would keep passing if the option's description were
  deleted outright.
- **A known flake is not a waiver.** `queue-worker.test.ts` "aborts an
  attempt that outlives its timeout" fails intermittently at elevated load on
  untouched bases too (a wall-clock memory-driver test). It is not caused by
  the rename, but the gate **re-runs** it until it passes rather than waiving
  it — a rename is not proven on a run where a test failed.
- **Stale builds** hide a miss: `dts/`, and a prebuilt `bun-jobs-ui/dist/`
  that `jobsUi()` prefers unless `dev: true`. Delete both before the gate.
- **Prose that changes meaning**, especially the quantitative sentences
  (§9 step 5).
- **`develop` red between merges** if the pair is merged separately (§8).
- **Log filters** keyed on the old logger names (§6.4). Say so in the PR.
- **Peers' edits** landing before the window. Re-run `gh pr list`, §10.1 and
  §10.2 on the final base.
- **After merge**, add one line to `CLAUDE.md` under bun-jobs: "*Controller*
  = control plane (stores intent, runs nothing); `Remote*` is reserved for
  remote execution".

## 12. Considered and rejected

**Naming sets (D1)**

- **B, `*Control`** (`WorkerControl`, `RunnerControl`, `.control()`).
  `WorkerControl` is already an OpenAPI schema name (`schemas/workers.ts:114-115`,
  asserted by `api-workers.test.ts:1149`). `lib/queue/WorkerControl.ts` would
  also differ from the existing `workerControl.ts` only by case, which breaks
  on macOS and Windows.
- **C, `*ControlPlane`** (`WorkerControlPlane`, `.controlPlane()`). No
  collisions, but long. "Plane" usually names a whole system, not a per-queue
  object.
- **D, `*Handle`.** It clashes with the bench's `RunnerHandle`
  (`bench/lib/types.ts:139`). In this codebase *handle* means a live
  execution (`RunHandle`, `ExecutorHandle` in `runner/executors/executor.ts`),
  which is the very confusion the rename removes.
- **The variant of A with class-prefixed types** (`RunnerControllerInfo`,
  `RunnerControllerRunRecord`). It misdescribes them: they describe the
  runner, and `BunRunner.history()` returns the same shape.
- **Accessor `.control(x)`.** It reads as a verb with no object. `.controller(x)`
  is a noun getter like `jobs.queue()` (`BunJobs.ts:488`) and
  `jobs.notifier()` (`:1159`), and it matches the managers' JSDoc.

**Options (D2)**

- **(a) Keep both.** This plan's recommendation, on the grounds that
  "controlled from afar" stays true. Not chosen: the user preferred names that
  match the stored `control` state and the `config:allowed` allow-list.
- **(b′) Rename `remoteConfig` alone.** Superseded by (b).
- **`overridable`** for `remoteConfig`. Superseded by `allowedOverrides`,
  which names the allow-list and matches `config:allowed`.

**Non-local (D3)**

- **other-process.** Accurate and matches the UI copy, but it makes long
  identifiers. It is kept as the user-facing wording.
- **foreign.** Already means unexpected or untrusted input here (bun-common
  multipart "foreign field", `native.test.ts:984`).
- **unowned.** Wrong: these runners have an owner, the docs' word for the
  registering process (`RemoteRunner.ts:80-86`).

**`RemoteRunHistoryPage`**

- **Absorbing it into a generic `RunHistoryPage<TResult>`** is not rejected on
  its merits, but deferred: it changes driver contract types and layering
  (§3.1). The same goes for **adding a root export**. Both belong to the
  bun-jobs session, outside this rename.

**Sequencing**

- **One atomic PR written by the features session.** The examples session
  asked to write its own prose.
- **Per-owner PRs merged back to back.** That leaves `develop` red between
  the two merges.

---

## Appendices

### Appendix A: per-file counts on the base

Families as in Appendix D. Counted over `packages`, `examples`, `playground`,
`CLAUDE.md`, `README.md`, `docs/plans/worker-runtimes.md` and `scripts`, at
`d54d1fe`. "Lines" counts distinct lines. "Occ." counts matches, so a line
with two hits counts twice.

#### C1 class/type — 39 files, 175 lines, 185 occurrences

By area: `docs` 9 lines / 10 occ.; `examples/bun-jobs` 7 lines / 8 occ.; `examples/bun-jobs-ui` 5 lines / 5 occ.; `packages/bun-jobs` 153 lines / 161 occ.; `packages/bun-jobs-ui` 1 lines / 1 occ.

| File | Lines | Occ. |
|---|--:|--:|
| `docs/plans/worker-runtimes.md` | 9 | 10 |
| `examples/bun-jobs-ui/06-browser/helpers/remote-process.ts` | 1 | 1 |
| `examples/bun-jobs-ui/06-browser/live-events.ts` | 2 | 2 |
| `examples/bun-jobs-ui/06-browser/workers.ts` | 2 | 2 |
| `examples/bun-jobs/10-options/remote-control.ts` | 5 | 5 |
| `examples/bun-jobs/10-options/run-logs-and-clears.ts` | 1 | 1 |
| `examples/bun-jobs/README.md` | 1 | 2 |
| `packages/bun-jobs-ui/app/screens/runners/actions/explain.ts` | 1 | 1 |
| `packages/bun-jobs/README.md` | 16 | 17 |
| `packages/bun-jobs/__tests__/api/api-clear.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/api/api-sources.test.ts` | 2 | 2 |
| `packages/bun-jobs/__tests__/api/api-workers.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/clear-actions.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/followups-remote-u4.test.ts` | 6 | 6 |
| `packages/bun-jobs/__tests__/runner-force.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/runner-remote.test.ts` | 2 | 2 |
| `packages/bun-jobs/__tests__/runner-remote.type-test.ts` | 13 | 13 |
| `packages/bun-jobs/__tests__/worker-control.test.ts` | 10 | 10 |
| `packages/bun-jobs/__tests__/worker-first-state.test.ts` | 2 | 2 |
| `packages/bun-jobs/consumer-check.json` | 1 | 1 |
| `packages/bun-jobs/lib/BunJobs.ts` | 3 | 3 |
| `packages/bun-jobs/lib/api/config.ts` | 2 | 2 |
| `packages/bun-jobs/lib/api/errors.ts` | 1 | 1 |
| `packages/bun-jobs/lib/api/index.ts` | 1 | 1 |
| `packages/bun-jobs/lib/api/routes/workers.ts` | 13 | 16 |
| `packages/bun-jobs/lib/api/serialize.ts` | 5 | 5 |
| `packages/bun-jobs/lib/api/sources.ts` | 7 | 8 |
| `packages/bun-jobs/lib/index.ts` | 8 | 8 |
| `packages/bun-jobs/lib/queue/RemoteWorker.ts` | 12 | 12 |
| `packages/bun-jobs/lib/queue/index.ts` | 4 | 4 |
| `packages/bun-jobs/lib/runner/BunRunner.ts` | 3 | 3 |
| `packages/bun-jobs/lib/runner/BunRunnerManager.ts` | 4 | 5 |
| `packages/bun-jobs/lib/runner/RemoteRunner.ts` | 18 | 18 |
| `packages/bun-jobs/lib/runner/clearHistory.ts` | 2 | 2 |
| `packages/bun-jobs/lib/runner/config.ts` | 1 | 1 |
| `packages/bun-jobs/lib/runner/index.ts` | 3 | 5 |
| `packages/bun-jobs/lib/runner/types.ts` | 8 | 8 |
| `packages/bun-jobs/lib/shared/errors.ts` | 1 | 1 |
| `packages/bun-jobs/lib/shared/events.ts` | 1 | 1 |

#### C2 accessor — 39 files, 132 lines, 132 occurrences

By area: `examples/bun-jobs` 31 lines / 31 occ.; `examples/bun-jobs-ui` 4 lines / 4 occ.; `packages/bun-jobs` 95 lines / 95 occ.; `packages/bun-jobs-ui` 2 lines / 2 occ.

| File | Lines | Occ. |
|---|--:|--:|
| `examples/bun-jobs-ui/06-browser/live-events.ts` | 2 | 2 |
| `examples/bun-jobs-ui/06-browser/workers.ts` | 2 | 2 |
| `examples/bun-jobs/07-runner/remote-control.ts` | 6 | 6 |
| `examples/bun-jobs/10-options/errors.ts` | 2 | 2 |
| `examples/bun-jobs/10-options/notifier.ts` | 1 | 1 |
| `examples/bun-jobs/10-options/remote-control.ts` | 7 | 7 |
| `examples/bun-jobs/10-options/run-logs-and-clears.ts` | 2 | 2 |
| `examples/bun-jobs/10-options/runner-options.ts` | 10 | 10 |
| `examples/bun-jobs/11-management-api/live-events-delivery.ts` | 1 | 1 |
| `examples/bun-jobs/README.md` | 2 | 2 |
| `packages/bun-jobs-ui/__tests__/app/pkg/worker-actions.integration.test.ts` | 1 | 1 |
| `packages/bun-jobs-ui/__tests__/app/pkg/worker-transitions.integration.test.ts` | 1 | 1 |
| `packages/bun-jobs/README.md` | 15 | 15 |
| `packages/bun-jobs/__tests__/api/api-clear.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/api/api-runners.test.ts` | 3 | 3 |
| `packages/bun-jobs/__tests__/clear-actions.test.ts` | 5 | 5 |
| `packages/bun-jobs/__tests__/fix-core-keystop.test.ts` | 2 | 2 |
| `packages/bun-jobs/__tests__/fix-runner-b17.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/fixtures/processes/runner-owner.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/followups-remote-u4.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/runner-config-crossprocess.test.ts` | 2 | 2 |
| `packages/bun-jobs/__tests__/runner-config-error-keys.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/runner-config.test.ts` | 21 | 21 |
| `packages/bun-jobs/__tests__/runner-force.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/runner-pause-gate.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/runner-remote-crossprocess.test.ts` | 2 | 2 |
| `packages/bun-jobs/__tests__/runner-remote.test.ts` | 21 | 21 |
| `packages/bun-jobs/__tests__/runner-remote.type-test.ts` | 2 | 2 |
| `packages/bun-jobs/__tests__/runner.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/worker-control.test.ts` | 1 | 1 |
| `packages/bun-jobs/lib/BunJobs.ts` | 1 | 1 |
| `packages/bun-jobs/lib/api/routes/workers.ts` | 1 | 1 |
| `packages/bun-jobs/lib/index.ts` | 1 | 1 |
| `packages/bun-jobs/lib/queue/RemoteWorker.ts` | 2 | 2 |
| `packages/bun-jobs/lib/runner/BunRunnerManager.ts` | 3 | 3 |
| `packages/bun-jobs/lib/runner/RemoteRunner.ts` | 2 | 2 |
| `packages/bun-jobs/lib/runner/types.ts` | 1 | 1 |
| `packages/bun-jobs/lib/shared/errors.ts` | 1 | 1 |
| `packages/bun-jobs/lib/shared/events.ts` | 1 | 1 |

#### C3 log name — 2 files, 2 lines, 2 occurrences

By area: `packages/bun-jobs` 2 lines / 2 occ.

| File | Lines | Occ. |
|---|--:|--:|
| `packages/bun-jobs/lib/queue/RemoteWorker.ts` | 1 | 1 |
| `packages/bun-jobs/lib/runner/RemoteRunner.ts` | 1 | 1 |

#### O1 remoteControl — 43 files, 111 lines, 123 occurrences

By area: `examples/bun-jobs` 13 lines / 14 occ.; `packages/bun-jobs` 93 lines / 104 occ.; `packages/bun-jobs-ui` 3 lines / 3 occ.; `playground` 2 lines / 2 occ.

| File | Lines | Occ. |
|---|--:|--:|
| `examples/bun-jobs/07-runner/helpers/runner-owner.ts` | 1 | 1 |
| `examples/bun-jobs/07-runner/remote-control.ts` | 1 | 1 |
| `examples/bun-jobs/10-options/notifier.ts` | 1 | 1 |
| `examples/bun-jobs/10-options/remote-control.ts` | 5 | 5 |
| `examples/bun-jobs/10-options/runner-options.ts` | 3 | 4 |
| `examples/bun-jobs/11-management-api/helpers/discovered-queue.ts` | 1 | 1 |
| `examples/bun-jobs/README.md` | 1 | 1 |
| `packages/bun-jobs-ui/__tests__/app/pkg/runner-config.integration.test.ts` | 1 | 1 |
| `packages/bun-jobs-ui/__tests__/app/pkg/worker-first-start.integration.test.ts` | 2 | 2 |
| `packages/bun-jobs/README.md` | 17 | 21 |
| `packages/bun-jobs/__tests__/api/api-runners.test.ts` | 2 | 2 |
| `packages/bun-jobs/__tests__/api/api-workers.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/fix-core-control.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/fix-core-idle-stop.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/fix-core-keystop.test.ts` | 2 | 2 |
| `packages/bun-jobs/__tests__/fixtures/processes/runner-owner.ts` | 1 | 2 |
| `packages/bun-jobs/__tests__/followups-remote-u4.test.ts` | 2 | 2 |
| `packages/bun-jobs/__tests__/notifier.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/runner-config-crossprocess.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/runner-config.test.ts` | 17 | 18 |
| `packages/bun-jobs/__tests__/runner-pause-gate.test.ts` | 2 | 2 |
| `packages/bun-jobs/__tests__/runner-remote-crossprocess.test.ts` | 3 | 3 |
| `packages/bun-jobs/__tests__/runner-remote.test.ts` | 7 | 7 |
| `packages/bun-jobs/__tests__/worker-control.test.ts` | 5 | 5 |
| `packages/bun-jobs/__tests__/worker-first-state.test.ts` | 1 | 1 |
| `packages/bun-jobs/lib/BunJobs.ts` | 2 | 2 |
| `packages/bun-jobs/lib/api/contract/types.ts` | 2 | 2 |
| `packages/bun-jobs/lib/api/routes/runners.ts` | 1 | 1 |
| `packages/bun-jobs/lib/api/routes/support.ts` | 1 | 2 |
| `packages/bun-jobs/lib/api/routes/workers.ts` | 1 | 1 |
| `packages/bun-jobs/lib/api/schemas/workers.ts` | 1 | 1 |
| `packages/bun-jobs/lib/drivers/driver.ts` | 1 | 1 |
| `packages/bun-jobs/lib/index.ts` | 1 | 1 |
| `packages/bun-jobs/lib/queue/BunQueueWorker.ts` | 1 | 1 |
| `packages/bun-jobs/lib/queue/index.ts` | 1 | 1 |
| `packages/bun-jobs/lib/queue/types.ts` | 2 | 3 |
| `packages/bun-jobs/lib/runner/BunRunner.ts` | 3 | 3 |
| `packages/bun-jobs/lib/runner/RemoteRunner.ts` | 2 | 2 |
| `packages/bun-jobs/lib/runner/options.ts` | 6 | 9 |
| `packages/bun-jobs/lib/runner/types.ts` | 3 | 3 |
| `packages/bun-jobs/lib/shared/events.ts` | 1 | 1 |
| `playground/README.md` | 1 | 1 |
| `playground/scheduling.ts` | 1 | 1 |

#### O2 remoteConfig — 22 files, 54 lines, 56 occurrences

By area: `examples/bun-jobs` 2 lines / 2 occ.; `examples/bun-jobs-ui` 7 lines / 7 occ.; `packages/bun-jobs` 38 lines / 40 occ.; `packages/bun-jobs-ui` 7 lines / 7 occ.

| File | Lines | Occ. |
|---|--:|--:|
| `examples/bun-jobs-ui/06-browser/runner-and-job-tools.ts` | 7 | 7 |
| `examples/bun-jobs/10-options/remote-control.ts` | 2 | 2 |
| `packages/bun-jobs-ui/__tests__/app/pkg/runner-config.integration.test.ts` | 3 | 3 |
| `packages/bun-jobs-ui/__tests__/app/runners/actions/config.test.tsx` | 2 | 2 |
| `packages/bun-jobs-ui/app/screens/runners/actions/ConfigEditorDialog.tsx` | 1 | 1 |
| `packages/bun-jobs-ui/app/screens/runners/actions/explain.ts` | 1 | 1 |
| `packages/bun-jobs/README.md` | 6 | 6 |
| `packages/bun-jobs/__tests__/api/api-runner-config.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/fix-runner-b17.test.ts` | 3 | 3 |
| `packages/bun-jobs/__tests__/fixtures/processes/runner-owner.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/runner-config-error-keys.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/runner-config.test.ts` | 4 | 4 |
| `packages/bun-jobs/__tests__/runner-config.type-test.ts` | 2 | 2 |
| `packages/bun-jobs/lib/api/contract/types.ts` | 1 | 1 |
| `packages/bun-jobs/lib/api/schemas/runners.ts` | 1 | 1 |
| `packages/bun-jobs/lib/index.ts` | 1 | 1 |
| `packages/bun-jobs/lib/runner/BunRunner.ts` | 4 | 4 |
| `packages/bun-jobs/lib/runner/RemoteRunner.ts` | 1 | 1 |
| `packages/bun-jobs/lib/runner/config.ts` | 1 | 1 |
| `packages/bun-jobs/lib/runner/index.ts` | 1 | 1 |
| `packages/bun-jobs/lib/runner/options.ts` | 5 | 5 |
| `packages/bun-jobs/lib/runner/types.ts` | 5 | 7 |

#### T3c non-local coupled — 13 files, 25 lines, 25 occurrences

By area: `examples/bun-jobs-ui` 4 lines / 4 occ.; `packages/bun-jobs` 7 lines / 7 occ.; `packages/bun-jobs-ui` 14 lines / 14 occ.

| File | Lines | Occ. |
|---|--:|--:|
| `examples/bun-jobs-ui/04-screens/permissions.ts` | 3 | 3 |
| `examples/bun-jobs-ui/06-browser/runner-and-job-tools.ts` | 1 | 1 |
| `packages/bun-jobs-ui/README.md` | 3 | 3 |
| `packages/bun-jobs-ui/__tests__/app/runners/actions/gating.test.tsx` | 4 | 4 |
| `packages/bun-jobs-ui/__tests__/app/runners/actions/trigger.test.tsx` | 1 | 1 |
| `packages/bun-jobs-ui/__tests__/app/runners/realApiClearHistory.tsx` | 1 | 1 |
| `packages/bun-jobs-ui/__tests__/app/runners/screen.test.tsx` | 2 | 2 |
| `packages/bun-jobs-ui/app/screens/runners/RunnerScreen.tsx` | 1 | 1 |
| `packages/bun-jobs-ui/app/screens/runners/actions/TriggerDialog.tsx` | 1 | 1 |
| `packages/bun-jobs-ui/app/screens/runners/actions/index.tsx` | 1 | 1 |
| `packages/bun-jobs/lib/api/index.ts` | 1 | 1 |
| `packages/bun-jobs/lib/api/routes/runners.ts` | 5 | 5 |
| `packages/bun-jobs/lib/api/routes/support.ts` | 1 | 1 |

#### T3u non-local words/ids — 42 files, 120 lines, 125 occurrences

By area: `examples/bun-jobs` 4 lines / 4 occ.; `examples/bun-jobs-ui` 15 lines / 17 occ.; `packages/bun-jobs` 23 lines / 23 occ.; `packages/bun-jobs-ui` 78 lines / 81 occ.

| File | Lines | Occ. |
|---|--:|--:|
| `examples/bun-jobs-ui/04-screens/permissions.ts` | 8 | 8 |
| `examples/bun-jobs-ui/06-browser/pause-and-retry.ts` | 1 | 1 |
| `examples/bun-jobs-ui/06-browser/runner-and-job-tools.ts` | 4 | 5 |
| `examples/bun-jobs-ui/README.md` | 2 | 3 |
| `examples/bun-jobs/07-runner/remote-control.ts` | 1 | 1 |
| `examples/bun-jobs/10-options/jobs-api-options.ts` | 1 | 1 |
| `examples/bun-jobs/10-options/run-logs-and-clears.ts` | 1 | 1 |
| `examples/bun-jobs/README.md` | 1 | 1 |
| `packages/bun-jobs-ui/README.md` | 5 | 5 |
| `packages/bun-jobs-ui/__tests__/app/pagination.test.tsx` | 1 | 1 |
| `packages/bun-jobs-ui/__tests__/app/pkg/clear-actions.integration.test.ts` | 12 | 13 |
| `packages/bun-jobs-ui/__tests__/app/pkg/runner-config.integration.test.ts` | 2 | 2 |
| `packages/bun-jobs-ui/__tests__/app/runners/actions/clearHistory.test.tsx` | 6 | 6 |
| `packages/bun-jobs-ui/__tests__/app/runners/actions/config.test.tsx` | 1 | 1 |
| `packages/bun-jobs-ui/__tests__/app/runners/actions/fixtures.tsx` | 1 | 1 |
| `packages/bun-jobs-ui/__tests__/app/runners/actions/gating.test.tsx` | 14 | 16 |
| `packages/bun-jobs-ui/__tests__/app/runners/actions/trigger.test.tsx` | 3 | 3 |
| `packages/bun-jobs-ui/__tests__/app/runners/fixtures.ts` | 1 | 1 |
| `packages/bun-jobs-ui/__tests__/app/runners/helpers.test.ts` | 8 | 8 |
| `packages/bun-jobs-ui/__tests__/app/runners/list.test.tsx` | 2 | 2 |
| `packages/bun-jobs-ui/__tests__/app/runners/realApiClearHistory.tsx` | 2 | 2 |
| `packages/bun-jobs-ui/__tests__/app/runners/screen.test.tsx` | 5 | 5 |
| `packages/bun-jobs-ui/app/screens/runners/RunnerScreen.tsx` | 2 | 2 |
| `packages/bun-jobs-ui/app/screens/runners/RunnersListScreen.tsx` | 1 | 1 |
| `packages/bun-jobs-ui/app/screens/runners/actions/RunnerDialogs.tsx` | 1 | 1 |
| `packages/bun-jobs-ui/app/screens/runners/actions/gating.ts` | 2 | 2 |
| `packages/bun-jobs-ui/app/screens/runners/actions/index.tsx` | 2 | 2 |
| `packages/bun-jobs-ui/app/screens/runners/actions/triggerOutcome.tsx` | 1 | 1 |
| `packages/bun-jobs-ui/app/screens/runners/runnerFormat.ts` | 6 | 6 |
| `packages/bun-jobs/README.md` | 1 | 1 |
| `packages/bun-jobs/__tests__/api/api-analytics.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/api/api-runners.test.ts` | 3 | 3 |
| `packages/bun-jobs/__tests__/api/api-sources.test.ts` | 3 | 3 |
| `packages/bun-jobs/__tests__/followups-remote-u4.test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/runner-config-crossprocess.test.ts` | 2 | 2 |
| `packages/bun-jobs/__tests__/runner-config.test.ts` | 4 | 4 |
| `packages/bun-jobs/__tests__/runner-config.type-test.ts` | 1 | 1 |
| `packages/bun-jobs/__tests__/runner-remote-crossprocess.test.ts` | 2 | 2 |
| `packages/bun-jobs/lib/api/routes/analytics.ts` | 1 | 1 |
| `packages/bun-jobs/lib/api/serialize.ts` | 1 | 1 |
| `packages/bun-jobs/lib/index.ts` | 2 | 2 |
| `packages/bun-jobs/lib/runner/config.ts` | 1 | 1 |

#### D4 `WorkerTarget` — 4 files, 10 lines, 10 occurrences

These are the only uses in `packages/`, `examples/` and `playground/`.

| File | Lines | Occ. |
|---|--:|--:|
| `packages/bun-jobs/README.md` | 1 | 1 |
| `packages/bun-jobs/lib/index.ts` | 1 | 1 |
| `packages/bun-jobs/lib/queue/RemoteWorker.ts` | 7 | 7 |
| `packages/bun-jobs/lib/queue/index.ts` | 1 | 1 |

### Appendix B: the KEEP lines allowed in lib, app, READMEs and playground

This is the per-file count on the simulated head, after the mapping and before the prose pass. Paths are post-move. After the prose pass, a file's count may fall but never rise, and no new file may appear.

| File | Lines |
|---|--:|
| `packages/bun-common/lib/utils/native.ts` | 1 |
| `packages/bun-jobs/lib/api/contract/constants.ts` | 6 |
| `packages/bun-jobs/lib/api/contract/types.ts` | 5 |
| `packages/bun-jobs/lib/api/errors.ts` | 2 |
| `packages/bun-jobs/lib/api/routes/runners.ts` | 2 |
| `packages/bun-jobs/lib/api/routes/workers.ts` | 2 |
| `packages/bun-jobs/lib/api/schemas/workers.ts` | 2 |
| `packages/bun-jobs/lib/api/sources.ts` | 1 |
| `packages/bun-jobs/lib/drivers/driver.ts` | 3 |
| `packages/bun-jobs/lib/drivers/metrics.ts` | 1 |
| `packages/bun-jobs/lib/drivers/mongo/mongo-driver.ts` | 2 |
| `packages/bun-jobs/lib/queue/BunQueue.ts` | 4 |
| `packages/bun-jobs/lib/queue/BunQueueWorker.ts` | 3 |
| `packages/bun-jobs/lib/queue/jobDefaults.ts` | 1 |
| `packages/bun-jobs/lib/queue/types.ts` | 2 |
| `packages/bun-jobs/lib/runner/BunRunnerManager.ts` | 2 |
| `packages/bun-jobs/lib/runner/BunRunner.ts` | 5 |
| `packages/bun-jobs/lib/runner/config.ts` | 1 |
| `packages/bun-jobs/lib/runner/options.ts` | 1 |
| `packages/bun-jobs/lib/runner/RunnerController.ts` | 8 |
| `packages/bun-jobs/lib/runner/types.ts` | 9 |
| `packages/bun-jobs/lib/shared/events.ts` | 2 |
| `packages/bun-jobs/lib/shared/workers.ts` | 1 |
| `packages/bun-jobs/README.md` | 25 |
| `packages/bun-jobs-ui/app/screens/docs/schema/resolve.ts` | 1 |
| `packages/bun-jobs-ui/app/screens/queues/panels/jobDefaults/draft.ts` | 1 |
| `packages/bun-jobs-ui/app/screens/runners/actions/config.ts` | 1 |
| `packages/bun-jobs-ui/app/screens/runners/actions/explain.ts` | 1 |
| `packages/bun-jobs-ui/app/screens/runners/actions/gating.ts` | 1 |
| `packages/bun-jobs-ui/app/screens/workers/actions/explain.ts` | 1 |
| `packages/bun-jobs-ui/app/screens/workers/actions/gating.ts` | 2 |
| `packages/bun-jobs-ui/app/screens/workers/WorkerConfigCard.tsx` | 1 |
| `packages/bun-jobs-ui/README.md` | 1 |
| `playground/scheduling.ts` | 1 |

### Appendix C: the prose pass, the lines §10.2 prints before it

These are the 35 lines on the simulated head that are neither mapped nor KEEP. They are line numbers of the simulated head, which equal base numbers in these files. Each must be reworded: non-local sense to "registered in another process" / "non-local"; the "Remote … control/configuration:" headers to "… from another process"; the README code samples' `remote` variable to the runner's name.

```text
packages/bun-jobs/lib/runner/config.ts:16: * Remote runner configuration: where the override lives, how a controller
packages/bun-jobs/lib/index.ts:138: * Remote runner configuration: the execution modes, the settings an override
packages/bun-jobs/lib/index.ts:639: * Remote worker control: what a worker can be asked to be, what may be
packages/bun-jobs/lib/index.ts:758:// Remote runner control: a runner registered by any process sharing the
packages/bun-jobs/lib/queue/WorkerController.ts:441:      // second path a local worker could take and a remote one could not.
packages/bun-jobs/lib/api/serialize.ts:670: * or a remote runner alike — then applies `serialize.runner`.
packages/bun-jobs/README.md:2939:const remote = await jobs.runners.controller("cleanup");
packages/bun-jobs/README.md:2940:await remote.clearHistory({ staleAfter: 3 * 86_400_000 });
packages/bun-jobs/README.md:3006:const remote = await jobs.runners.controller("report");
packages/bun-jobs/README.md:3007:await remote.updateConfig({ executionMode: "worker" });
packages/bun-jobs/README.md:3008:await remote.updateConfig({ concurrency: { runMode: "parallel", maxConcurrency: 3 } });
packages/bun-jobs/README.md:3009:export const config = await remote.config(); // effective, code, overridden, seq, ...
packages/bun-jobs/README.md:3010:await remote.resetConfig(); // back to what the code asks for
packages/bun-jobs/README.md:4123:reads no remote runner beyond it.
packages/bun-jobs/lib/api/contract/types.ts:2968:     * Remote worker control: the backend can both list workers and record
packages/bun-jobs/lib/api/routes/define.ts:56:  /** Runner lookup, local or remote. */
packages/bun-jobs/lib/api/routes/analytics.ts:702: *   and does not read a remote runner beyond it;
packages/bun-jobs/lib/api/routes/analytics.ts:1271:      description: `\`series\` is every runner's outcomes summed — the namespace roll-up, one read, when the API reaches the namespace's runners through a manager; the l…
packages/bun-jobs-ui/app/screens/runners/RunnersListScreen.tsx:34: * One row: a local runner with its name and lifecycle status, or a remote id
packages/bun-jobs-ui/app/screens/runners/runnerFormat.ts:60:/** The badge of a remote runner that is not paused. */
packages/bun-jobs-ui/app/screens/runners/runnerFormat.ts:140: * The header's badges: the local instance's status (or, for a remote runner,
packages/bun-jobs-ui/app/screens/runners/runnerFormat.ts:196:/** The sentence a remote runner's screen carries. */
packages/bun-jobs-ui/app/screens/runners/runnerFormat.ts:201: * Orders the list: local runners first, then remote ones, each group in the
packages/bun-jobs-ui/app/screens/runners/runnerFormat.ts:202: * order the API gave (local by registration, remote sorted by id).
packages/bun-jobs-ui/app/screens/runners/actions/triggerOutcome.tsx:8: * (with its position, and for a remote runner who starts it), or skipped
packages/bun-jobs-ui/app/screens/runners/actions/gating.ts:47: * 409 `RUNNER_NOT_LOCAL`), so they are not offered for a remote one.
packages/bun-jobs-ui/README.md:123:| `/runners` | Every runner in the namespace (`GET /runners`): local ones first, with their name and status, then remote ones by id. Filtered by id or name in the browser, then paged in…
packages/bun-jobs-ui/README.md:350:| Runner Clear history… | mutation `runners.clearHistory`, on any runner: unlike Kill… and Reset stats…, a runner registered only in another process gets it too, and it does not bring u…
packages/bun-jobs-ui/README.md:404:remote hint does not apply.
packages/bun-jobs-ui/README.md:426:  item's `isRunning`). A remote runner has no lifecycle status here: the list
packages/bun-jobs-ui/README.md:430:- **Remote runners** are registered by another process. Pause, resume,
packages/bun-jobs-ui/README.md:432:  adopts them at its next sync; the screen says so. A trigger for a remote
packages/bun-jobs-ui/app/screens/runners/actions/RunnerDialogs.tsx:213: * remote runner too; the small print about long parallel runs shows only
packages/bun-jobs-ui/app/api/runners.ts:62:/** `GET /runners`: local runners (with name and status), then remote ids. */
packages/bun-jobs-ui/app/screens/runners/actions/index.tsx:45: * process; for a remote one a hint says why they are absent. Clearing the
```

### Appendix D: family patterns

Occurrences are counted with `git grep -I -o -E`, and lines with
`git grep -n -I -E`.

| Family | Pattern |
|---|---|
| C1 class/type | `Remote(Worker\|Runner\|Run)[A-Za-z]*` |
| C2 accessor | `\bremote\((id\|queue)?\)\|\.remote(<[^>]*>)?\(\|\{@link remote\}\|async remote<\|^  remote\(queue` |
| C3 log name | `"remote-(worker\|runner)"` |
| O1 remoteControl | `remoteControl\|RemoteControlOptions\|resolveRemoteControl\|REMOTE_CONTROL` |
| O2 remoteConfig | `remoteConfig\|RemoteConfigOptions` |
| T3c non-local, coupled | `runner-remote-hint\|trigger-remote-note\|"remote-note"\|Runner remote hint\|runner: remote hint\|REMOTE_LATENCY_NOTE` |
| D4 | `\bWorkerTarget\b` (whole word) |
| T3u non-local, words and identifiers | `[Rr]emote runner\|remoteRunner\|REMOTE_RUNNER\|REMOTE_ACTIVE\|remoteOnly\|remoteHint\|remote hint` |

The families overlap, since one line can hold both a class name and an
accessor, so the family tables do not sum to the repo total.
