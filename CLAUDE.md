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

Each package: `lib/` source, `__tests__/` (bun:test), a `bun check`
typecheck (`bun run check`), ESLint via `@antfu/eslint-config` (`eslint.legacy.config.mjs`, the
lint gate until the [bun-lint-fmt](docs/plans/bun-lint-fmt/README.md) flip) beside `bun lint`. Bun runs the shipped `.ts`
source directly (`main` is `lib/index.ts`; no JS is emitted). All four
packages also ship built declarations in `dts/` and point `types` at them —
see [Packaging types](#packaging-types-declarations-ship-sources-ship-alongside).

There are two Bun floors (the user's decision, 2026-10-10). **Using** the
packages needs **Bun ≥ 1.4.2**: every package's `engines.bun` says so, and
each declares an optional `@types/bun >=1.4.2` peer so a consumer on older
types is warned instead of hitting opaque type errors. That floor matters
because bun-jobs' Redis and SQL drivers use `RedisClient.eval`/`xadd`/… and
`sql.listen`, which 1.4.2 is the first `bun-types` release to declare.
**Developing** the repo needs **Bun ≥ 1.4.4** (the user's decision,
2026-10-17), for `bun lint` and `bun fmt`; until 1.4.4 is stable that is the
canary, **`bun upgrade --canary`** (plain `bun upgrade` after). 1.4.3 was the
first stable release with `bun check` (2026-10-10), which every type check
here runs (see [Typechecking](#typechecking)). The root `package.json` has
`packageManager: bun@1.4.4` and `engines.bun >=1.4.4`, and
`scripts/typecheck.ts` refuses an older Bun. Every 1.4.4 canary reports
`Bun.version` "1.4.4", so the floor cannot tell them apart: the lint and
format setup was verified on **1.4.4-canary.1+5f5799ed1** (`bun --revision`),
and the plan's figures are as old as that build. The machine moved to
**1.4.4-canary.1+6bb5dc195** on 2026-10-20 (the user's decision): `bun lint`
gave the same findings, rule by rule, in all 12 linted directories,
`bun fmt --check` flagged the same 92 files, and `scripts/typecheck.ts` stayed
clean (measured against the old binary on develop f325f269). **A later canary can change
rule or format output**: a new finding or a reformatted file after
`bun upgrade --canary` is the canary's, and goes to the bun-lint-fmt plan's
lead with both revisions rather than being fixed in passing. Using the
packages still needs only 1.4.2. The packages' `bun-types` devDeps stay
`^1.4.3` (there are no stable 1.4.4 types). The `@types/bun` devDeps stay `^1.4.2`, because `@types/bun` 1.4.3 is not
on npm yet; the range takes it when it lands. Until then `@types/bun` 1.4.2
pins `bun-types` 1.4.2 exactly, so the checks still read the 1.4.2
declarations, and `bun.lock` holds both copies. On Bun 1.4.2, a package's
`"check": "bun check"` script runs itself forever (measured): `bun upgrade --canary`.

bun-nest's `BunHttpAdapter.use/get/post/...` delegate to `this.instance`,
which is a bun-common `BunRouter` — so routing/middleware behaviour lives in
bun-common.

## Dev workflow

```bash
bun scripts/typecheck.ts   # every project in the repo — must be clean
                           # (same as `bun run check` or `bun check` at the root)
```

**Manual playground:** `bun playground/index.ts` serves bun-jobs, its
management API and the bun-jobs-ui app on one adapter at
`http://localhost:4000/jobs`, with a simulation that keeps every screen
moving (`playground/README.md`). It is a project of its own, like
`benchmarks/`: typechecked by `scripts/typecheck.ts`, linted with
`cd playground && bun run lint:eslint`, and outside the workspaces.

Then, in each affected package directory:

```bash
bun run check              # bun check on the package's projects
bun run lint:eslint        # ESLint, the lint gate until PR E — must have 0 errors
bun run lint               # bun lint: runs, reports what PR B fixes, gates nothing yet
bun run test               # type-check the tests, then run them in parallel — must all pass
```

**Lint, between PR A and PR E of [bun-lint-fmt](docs/plans/bun-lint-fmt/README.md)
§7.** ESLint is still the gate: each linted directory's config is
`eslint.legacy.config.mjs`, a name ESLint does not discover, so run it as
`bun run lint:eslint` (`eslint -c eslint.legacy.config.mjs .`); a bare
`bunx eslint .` finds no config. `bun run lint` (in a `lint` script, `bun lint`
is the linter) reads the root `bunfig.toml`, type-aware, and exits 1 until each
owner's findings are fixed. A disable directive names the rule's canonical
name (`@typescript-eslint/…`, `n/…`; the ESLint configs `renamePlugins` to
match), and both tools read it. For a rule only `bun lint` runs (the
type-aware ones), ESLint does not call the directive unused, nor delete it on
`--fix` (`eslint.legacy.directives.mjs`); where ESLint runs the same check under
another name, list both (`no-throw-literal, @typescript-eslint/only-throw-error`).
There is no `format` script yet: Prettier, through
ESLint, still formats, and it and `bun fmt` disagree on 78 files, so do
not run `bun fmt` on a whole directory before PR E.

**Tests run in parallel.** Each test suite's `test` script is
`bun test --check --parallel --timings=bun-timings.json` (`--check`: see
[Bun's checker, not tsc](#buns-checker-not-tsc)) — one worker process per
CPU core of the host (Bun's default for a bare `--parallel`, on 1.4.3), the slowest
files started first from the suite's committed `bun-timings.json`. The count follows the machine, so the same
script runs 16 workers on this 16-core host, 4 on a 4-core laptop and 32 on
a 32-core box (the user's decision, 2026-10-09: development moves between
devices). To pin one run, add the count: `bun run test --parallel=8` — a
later `--parallel=N` wins over the script's bare one. The heavy-run
wrapper decides how many heavy jobs share the machine, so a suite no
longer has to hold back for other sessions' runs (the user's decision,
2026-10-07). Measured serial against `bun run test` on this 16-core host:
bun-common 7.2 s → 3.5 s, bun-nest 3.4 s → 1.1 s, bun-jobs-ui 136 s →
22–46 s at 16 workers, bun-jobs with all five database URLs about 24 min →
391–445 s at 16 (458–498 s at its former 4). Every figure here was measured at 16 workers or fewer;
a bigger host runs more, untested. Each worker of a database-backed suite
holds its own connections (about 180 per server at 16), so the
`max_connections` `setup-databases.ts` sets scales with the cores too
(below): run it again on a new machine before the suites.
The flags are in the scripts because `bunfig.toml`'s `[test]` silently ignores
`parallel` and `timings` (Bun 1.4.3, measured); both exist from 1.4.2.
So plain `bun test` is still the one-process run, as is
`bun run test:serial` (which also checks types first).

- **`bun run test:timings`** re-measures and rewrites `bun-timings.json`. The
  file goes stale as tests are added, renamed or slowed: refresh it now and
  then, and commit it with the change that made it stale. Stale costs only
  scheduling — an entry for a deleted file is ignored, and a file with no
  entry runs **first**, not last. A malformed file (`{}`, a merge conflict)
  fails `bun run test`, and `--update-timings` merges rather than repairs, so
  the script deletes the file before measuring.
- **`--parallel` implies `--isolate`**, a fresh global per file, so it cannot
  catch one file leaking into another. `bun test --randomize --seed=N`
  (serial) is the check for that, with bun-jobs-ui's `domLeak.test.ts`; keep
  them in any gate.
- **bun-jobs' order check per PR is `bun run test:seeded`** (the user's
  decision, 2026-10-10). `scripts/test-seeded.ts` deals the test files into 4
  shards by a shuffle seeded with `--seed`, and runs each shard as one serial
  `bun test --randomize --seed=N ./file …` process, the four side by side,
  with the database URLs removed (the database suites skip visibly;
  `--with-databases` keeps them). So it takes an ordinary slot, not the whole
  machine — run it through the heavy-run wrapper with a ticket, like any
  full suite:
  `HEAVY_TICKET=<session>-seeded /tmp/claude-1000/bun-node-heavy-run.sh nice -n 10 timeout 2400 bun run test:seeded > <log> 2>&1`.
  Measured with seeds 1–3, 5m10s–6m20s at 1.1–1.9 cores, 5309 pass, 579
  skip, 0 fail each, against 21m36s for the same serial run unsharded and
  about 24 min serial with all five URLs. It type-checks once
  first (a bare `bun --check` in the package, about a second) and starts no shard when that
  fails. The seed is printed first when it was picked; `--seed N` reproduces
  a run, and the summary gives each shard's serial command. Each shard runs
  in its own process group, so SIGINT or SIGTERM stops everything the tests
  spawned too; a SIGKILL to the script does not reach the shards, so never
  stop it with `kill -9` or `timeout -k` (a plain `timeout N` sends SIGTERM).
  - **The shards are balanced by `bun-timings.seeded.json`**, per-file
    durations measured serially without the URLs (`bun-timings.json` is
    parallel with them, and predicted a serial shard poorly). Dealt
    round-robin, the shortest shard ended 3–5 minutes before the longest;
    balanced, within a minute. Refresh it like `bun-timings.json`, with
    `bun run test:seeded --update-timings`, and commit it with the change
    that made it stale. The heavy files (a quarter of a shard's share or
    more: three today) are placed first, each on a shard the seed picks among
    those it still fits on under the fair share, so two of them can share a
    shard but three never pile up. Measured on seed 7: before the refresh,
    two new untimed files dealt at the median put one shard at 7m24s against
    4m58s–5m17s; after it, 5m18s–6m28s.
  - **A shard sees only the leaks between its own files, and only when the
    leaking file runs first** — `--randomize` shuffles the file order too. At
    4 shards, simulated over 1000 seeds with the timings of 2026-10-11, two
    light files share a shard 0.32 of the time, so one seed catches a leak
    between them about one time in six (the right order is half of that); a
    heavy and a light file 0.17, about one in twelve. Of the three heavy
    files, `summon-shared-unit-xproc` and `summon-register-claim` share 0.33
    of the time, and `provider/testing/conformance` never shares with either
    (208 s plus either passes a shard's fair share of 334 s), so those two
    pairs are left to the merge-window run. A single serial run catches any
    pair one time in two. That is why the seed varies from run to run.
    The negative control: a planted leak between two files passed
    `bun run test` and failed the shard that held both (seed 4).
  - **The serial seeded run with all five URLs runs once per merge window**,
    not per PR: `HEAVY_EXCLUSIVE=1`, `bun test --randomize --seed=N` with the
    five `BUN_JOBS_TEST_*_URL`s set. bun-jobs-ui keeps its serial
    `--randomize` seeds in its own gate, unchanged.
- **bun-jobs runs one worker per core too**, with no cap (the user's
  decision, 2026-10-10): its database servers grow with the host instead.
  At about 11 connections per worker per server, a 64-core host opens about
  720, so `setup-databases.ts` scales `max_connections` with the cores
  (below); a server set up on a smaller machine needs the script run again.
  It ran 4 until 2026-10-10, when three
  rounds of load-proofing made it hold at 16: before them, 16 workers failed
  1–6 tests per run — the event contracts, `countDemand`, timing
  assertions, two fixture races — and two of the causes were real bugs (a
  worker's maintenance passes piling up until a Postgres pool stalled for a
  minute, and a limiter give-back lost to its own compare-and-set). The
  bar: three seeded runs at 16, exclusive, all five database URLs, 0
  failures. A test that starts failing at 16 is fixed, not answered by
  lowering the count.
- **bun-jobs-ui runs one worker per core** (16 here): measured 2026-10-07 under the wrapper,
  three runs, one beside a second heavy job (load peaking at 51): 1716 of
  1716 each time, in 22–46 s. Its earlier cap at 4 came from several
  unwrapped suites running at once (load 24–88), which the wrapper now
  prevents. Its serial `--randomize` seeds stay in the gate.
- **Heavy runs take a slot.** Several sessions share this machine, so a
  heavy job runs through `/tmp/claude-1000/bun-node-heavy-run.sh <command>`,
  installed from this repo's `scripts/heavy-run.sh` (below):
  two slots, the second open only while the 1-minute load is under the core
  count, so two heavy jobs run together on an idle machine and one at a time
  on a busy one. Slot 1 is the old `/tmp/claude-1000/bun-node-heavy.lock`, so
  a plain `flock` on it still counts. The command's exit status is passed
  through; giving up after `HEAVY_WAIT` (default 90 min) exits 75.
  - **bun-jobs' full suite with database URLs runs alone**: `bun run test`
    and, once per merge window, its serial `--randomize` run. Prefix
    `HEAVY_EXCLUSIVE=1`. It shares five servers and asserts on durations.
    The per-PR `bun run test:seeded` removes the URLs and takes an ordinary
    slot (the user's decision, 2026-10-10).
  - **Heavy:** full suites, every bun-jobs-ui test (they drive the DOM and
    Chrome), the bun-jobs and bun-jobs-ui `run-all.ts`, `check-types.ts`,
    benches, and repeat, concurrent-copy and load loops.
  - **Not heavy, run directly:** lint in any directory (ESLint or `bun lint`),
    `bun scripts/typecheck.ts`, `bun scripts/consumer-check.ts`, and every
    **targeted** test run in any package except bun-jobs-ui — named files,
    directories or filters, with or without database URLs
    (`bun test __tests__/summon __tests__/api`, `bun test summon provider`);
    the bun-common and bun-nest suites and `run-all.ts` (seconds each), single
    examples and the template's test. (The user's rulings of 2026-10-07.)
  - **Waiting costs nothing, so never poll for it.** Waiters block in the
    kernel on a turnstile lock, and only the head of the line tries the
    slots. Start a heavy job with the Bash tool's `run_in_background` and a
    ticket, then stop: the completion notification says when it ended. No
    `sleep`, polling, `tail` or "still waiting" turns, in agents above all.
    ```bash
    HEAVY_TICKET=<session>-<task> /tmp/claude-1000/bun-node-heavy-run.sh \
      timeout 2400 bun run-all.ts > <log> 2>&1
    ```
  - **A ticket survives a usage limit.** Re-issuing the same command with
    the same `HEAVY_TICKET` attaches to the job still queued or running and
    exits with its status, or returns the recorded status at once if it has
    finished (`HEAVY_RERUN=1` runs it again). A ticket whose job died is free
    at once, and the next call runs it.
  - **Exclusive jobs cannot starve ordinary ones:** once one exclusive job has
    started since the last ordinary one, the next steps back while ordinary
    jobs wait, so the two kinds alternate.
  - **The wrapper decides from each job's history** (`HEAVY_MODE=auto`, the
    default since 2026-10-07): the median wall time and cores of the last 10
    successful runs of the job's key. No history, or none with CPU recorded:
    a slot. Median cores at or above `HEAVY_EXCLUSIVE_CORES` (75% of the
    cores): exclusive. Median under `HEAVY_DIRECT_SECONDS` (60) and under
    `HEAVY_DIRECT_CORES` (2): it runs at once, holding no slot. Otherwise a
    slot, or at once when no slot is free but it fits: the 1-minute load,
    plus the cores of jobs started in the last minute (the load does not show
    them yet), plus its own median cores is under `HEAVY_MAX_LOAD`, and no
    exclusive job is waiting or running. `HEAVY_EXCLUSIVE=1` and an explicit
    `HEAVY_MODE` (`slot`, `exclusive`, `direct`) always win. CPU history
    cannot see the five database servers, so the bun-jobs DB suite is still
    marked `HEAVY_EXCLUSIVE=1` by hand. A job run at once keeps its ticket,
    records its history and is listed. The wrapper says what it decided on
    stderr as it starts: `bun-node-heavy-run: auto → slot (median 6m10s, 3.2
    cores, n=4)`.
  - `/tmp/claude-1000/bun-node-heavy-queue.sh` lists every job holding or
    waiting for a slot: its state, how long it has waited, an **EST** of its
    run, its session and ticket. The state is the phase each wrapper records
    for itself (in line, head of the line, stepping back, for the reserve, for
    slots, attached, RUNNING, `RUNNING (direct)` with no slot), then how it
    runs: `[auto→slot]`, `[auto→direct]`, `[auto→exclusive]`, or the mode the
    caller set. EST is the median of the last 10 successful
    runs of the same kind of job and the median cores they used,
    `~6m10s, 3.2 cores (n=4)`, plus `~2m left` or
    `overrun +1m` for a running one, or `unknown` with no history. It comes
    from `/tmp/claude-1000/bun-node-heavy-history.tsv`, one line per finished
    job (epoch, key, seconds, exit status, then CPU seconds of the job's
    process tree, cores, the load at start and at end, where it ran and the
    mode asked; lines from before 2026-10-07 have the first four, and still
    count for EST); the key is the directory relative
    to its git top level, the command without what does not change how long
    it takes (a leading `timeout N` or `nice`, and `--seed`/`--randomize`
    and output paths such as `--log-dir <path>` anywhere, so every seed of a
    suite shares one estimate, wherever it logs; older history
    lines are read the same way), and `[exclusive]` and `EXAMPLE_DRIVER` when
    set, so a run in any worktree counts (`bun-node-heavy-run.sh --key
    <command>` prints it). The queue's COMMAND column is the whole command
    line, quoted so it can be pasted back. Session names
    come from `/tmp/claude-1000/bun-node-sessions`.
  - **The source is the repo**: `scripts/heavy-run.sh` and
    `scripts/heavy-queue.sh`, tested by `scripts/__tests__/heavy-run.test.ts`.
    `bun scripts/install-heavy-run.ts` installs them into `/tmp/claude-1000`
    (`--dry-run` for the plan, `--dir` elsewhere): an atomic rename, so a
    running job keeps the copy it started with, and the replaced wrapper
    stays as `bun-node-heavy-run.prev.sh`. Run it after any change to those
    scripts, once merged, and again after a reboot clears `/tmp`. Never edit
    the installed copies.
  - Wrap the heavy command, not a script that also installs or sleeps, and
    give it a `timeout`. Never `flock -o` on these locks: on this machine it
    drops the lock while the command runs.
  - The single lock this replaced queued 14 jobs for up to 40 minutes at a
    load of about 6 on 16 cores — seconds-long runs waiting behind long ones.

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

**A sweep needs the URLs as well as the driver, on every backend including
`memory`.** Three examples name a server of their own whatever `EXAMPLE_DRIVER`
says — `08-drivers/postgres-and-mysql.ts`, `08-drivers/redis.ts` and
`08-drivers/mongodb.ts` — so with none exported **those three sit out** and
the run reads three short of the total. Each says which variable it wants, so
nothing is hidden; the trap is that the count is stable across runs *because*
the same three sit out, and a stable count reads like coverage. One more sits
out partly: `10-options/driver-options.ts` covers the MongoDB options only with
`EXAMPLE_MONGODB_URL` set, and passes either way. Export all five
and every example runs on each of the eight backends. `bun scripts/setup-databases.ts
--dry-run` prints the URLs, which is where to take them from rather than
writing them out: **MariaDB is 3306 and MySQL 3307**, the reverse of the
obvious guess, because the two conflict on 3306 so MySQL runs as a container
on 3307.

So quote what **ran**, not what was green: "68 passed, 3 skipped" and
"examples/bun-jobs is green" are both true, and together they imply a coverage
of the driver-backed paths that neither supports. And before concluding a URL is
broken, read what `setup-databases.ts` below says about MySQL — probing one by
hand tests a constructor these examples never use, and it looks broken when it
is not.

The repo's own tooling in the root `scripts/` (`typecheck.ts`,
`setup-databases.ts`, `consumer-check.ts`, `nest-matrix.ts`, and the heavy-run
wrapper `heavy-run.sh`, `heavy-queue.sh` and `install-heavy-run.ts`) belongs to
no package, so it has its own lint config and its own tests; after touching one,
check it, from the root:

```bash
bun run lint:eslint:scripts   # cd scripts && eslint -c eslint.legacy.config.mjs . — 0 errors, and 0 warnings
bun run lint:scripts          # cd scripts && bun lint — reports, gates nothing until PR E
bun run test:scripts          # scripts/__tests__/
```

It is the packages' config except that `no-console` and
`antfu/no-top-level-await` are off: every file there is a CLI entry point, whose
output is its product. A script a test needs to reach exports what the test
calls and starts only under `if (import.meta.main)`, so importing it runs
nothing — `consumer-check.ts` is the first, for its leak scanner.

That scanner reads a declaration's imports with `ts.preProcessFile`, not a
regex: tsc copies JSDoc into `dts/`, so prose containing `from "…"` read as an
import of a package with that sentence for a name, and the check exited 1 on a
clean package. A guard that fires on prose gets routed around, so the fix went
in the scanner rather than the comment.

**Lint the whole package, not `lib __tests__`.** That narrower scope was what
the workflow said for a long time, and it had the same blind spot the
`tsconfig` `include` did: it reported zero errors while `bunx eslint .` found
thirteen, in READMEs, benchmark code and `package.json`. The editor lints
everything, so the errors were visible there and nowhere else.

bun-jobs' integration suites need database servers, and skip (visibly) when
their URL is **unset**. A URL that is **set but unreachable fails** the suite,
naming the backend and the connection error (`reportUnreachable` in
`__tests__/helpers/backends.ts`) — a set variable is a claim of coverage, and
the two used to be the same bit, so a broken URL reported a clean pass for an
engine nothing had touched. `examples/**` already behaved this way; the test
suites now match it.

`bun scripts/setup-databases.ts` provides the servers — system packages by
default, `--docker` for containers, `--dry-run` to see the plan first. It never
reinstalls an existing server and configures one only when a connection with
the expected credentials fails. That check connects **the way the suites do**,
which for MySQL means taking `allowPublicKeyRetrieval` out of the URL and
passing it as a `SQL` option: **Bun honours it as an option and ignores it in a
URL**, so `new SQL(url)` on the configured MySQL URL fails with
`ERR_MYSQL_PUBLIC_KEY_RETRIEVAL_NOT_ALLOWED` while the driver connects fine.
Probing that URL by hand is therefore misleading — it looks broken and is not.
It also raises MariaDB's and MySQL's `max_connections` to at least
`MAX_CONNECTIONS` (1000; `--max-connections=N` overrides it) and Postgres's to
`POSTGRES_MAX_CONNECTIONS` (700; `--postgres-max-connections=N`), and never
lowers one, because one 16-worker `bun test --parallel` run peaks at about 180
connections per server against their defaults of 151 and 100. Those are the
figures for 16 cores (`BASELINE_CORES`): the suites run a worker per core, so
on a bigger host the defaults scale in proportion (`connectionsForCores`: 64
cores → 4000 and 2800), never below them on a smaller one, and never past
the servers' ceilings. `--help` prints the value for the host it runs on. Postgres's
`ALTER SYSTEM` applies only on a restart, which drops open connections, so
the script prints the restart command and restarts only with
`--restart-postgres`.

After changing bun-common, also run bun-nest's and bun-jobs' checks (both
depend on bun-common). The `eslint.legacy.config.mjs` `TS2742`/`TS2883` portability
hint is pre-existing noise — `scripts/typecheck.ts` filters it. There may be a
couple of intentional `no-console` ESLint *warnings* (error logging in catch
blocks with no logger in scope); warnings do not fail lint.

`packages/bun-jobs/bench/` is a **separate, unpublished package** with its own
`package.json`, lockfile and `node_modules` (the same shape as the root
`benchmarks/`, and excluded from the root `workspaces` list). It holds the
third-party comparators — BullMQ, bee-queue, node-resque, pg-boss,
graphile-worker, Agenda, Bree and the cron timers — so none of them reach a
published package's dependency tree. `scripts/typecheck.ts` and
`bun run lint:eslint` both cover it.

It benchmarks against its own databases (`bun_jobs_bench`, Redis database 14),
never the test suite's, so the two can never disturb each other.

`packages/bun-common/bench/` has the same shape: its own `package.json`,
`bun.lock` and `node_modules`, and it is not in `workspaces`. It declares the
XML benchmark's comparators, `fast-xml-parser` and `htmlparser2`. Before this
package existed nothing declared them, and its typecheck passed only where an
old install had left them in the root `node_modules`. Run
`bun install --frozen-lockfile` in each of the three bench directories, in
`templates/compute-provider/` (below) and in `tools/vscode-bun-lint/` (the
editor extension, for `@types/vscode`), before `scripts/typecheck.ts`, or their
projects fail on missing modules. **Frozen, not plain**: a plain `bun install`
re-resolves against the registry and rewrites the lock, so the gate checks
whatever was published that day. Measured 2026-10-17: on Bun 1.4.4-canary a
plain install in the template pulled `@types/busboy` 1.5.5 and strtok3 10.6.0
and turned `scripts/typecheck.ts` from 17/17 to 16/17; frozen stayed 17/17
(the canary fixes oven-sh/bun#44299, so the template's lock, recorded without
bun-common's dependencies, no longer matches). Change a lock on purpose, in
its own commit.

### Nest versions

bun-nest supports NestJS 11 and 12 from one build (the user's decision,
2026-10-17; `docs/plans/nestjs-12-parity/` §8). **The floor is 11.1.20**:
below it `bun --check` fails on `Ack` and the CORS delegate overloads, and
two SSE tests fail (measured, §8.1). Nest versions other than the lock's run
as columns of `scripts/nest-matrix.ts` (§9.3):

| Column | When |
|---|---|
| 12-latest (12.1.3) | every gate: it is develop's lock, the repo itself |
| 11-latest (11.2.7) | every PR touching bun-nest or bun-common |
| 11.1.20 and 12.0.0 (the floors) | once per merge window |
| a new Nest release | when it ships, before the lock moves |

A bun-jobs PR that changes `createJobsApi`'s options or `JobsApi`'s shape also
runs bun-nest's suite and the 11.2.7 copy (bun-nest's `BunJobsApiModule` is
written in those types).

```bash
bun scripts/nest-matrix.ts --prepare 11.2.7      # direct: copy, pin, install, assert
HEAVY_TICKET=<session>-nest-matrix /tmp/claude-1000/bun-node-heavy-run.sh \
  nice -n 10 timeout 1800 bun scripts/nest-matrix.ts --run 11.2.7 > <log> 2>&1
```

A copy lives at `~/bun-node-nest-matrix/<version>/` (`--dir` or
`NEST_MATRIX_DIR`), never under a dot segment such as `~/.cache`: Express's
`send` refuses every file there, failing two expressCompat probes on both
majors. `--run` runs bun-nest's suite, a bare `bun --check` in bun-nest,
`examples/bun-nest`, bun-jobs-ui's `nest.nest.test.ts` and consumer-check
(its consumer pinned to the column's Nest, its work in
`<base>/cc-<version>/`), one line per check with counts, full output in
`<copy>/matrix-logs/`. `--dry-run` prints the plan, `--list` the copies.
Several versions in one `--run` (`--run 12.1.3 11.2.7`) run in turn.
**Separate `--run`s may run at once**, as wrapped jobs (the wrapper decides
how many). bun-nest's suite binds only port 0 since PR-2 (measured
2026-10-17: two suites side by side were clean in 4 of 4 rounds; with the old
fixed port 10000 put back, 2 of 2 rounds failed a `beforeAll` on
`EADDRINUSE`). Its two WebSocket serialisation tests make `JSON.stringify`
overflow, about 1.5 s of CPU in Bun (oven-sh/bun#45791), and used to race
fixed deadlines (3 s, and bun:test's 5 s); since PR-3 the deep-payload test
waits for the server's `RangeError` and the adapter test has a 30 s
deadline. Three and four suites side by side, 25 suites at loads up to 64,
then had no timeout, where three had one in 2 of 2 rounds before. One test
is still load-sensitive there: `sse.nest.test.ts`'s idle-timeout control
failed 2 of those 25 suites with `ECONNRESET`.

### The compute-provider template

`templates/compute-provider/` is the starter template for a third-party
compute provider (`bun-jobs-provider-example`): the fictional Acme Compute
summon provider, its fake platform, a green conformance test and a consumer
type check. It is a standalone package like the bench ones — its own
`package.json` and `bun.lock`, not in `workspaces` — and it is written to be
**copied out of the repo**, so nothing inside it points back in except
`package.json`'s `overrides`:

- **Resolution.** It declares `@kingsleyweb/bun-jobs` as a published plugin
  would (a peer range, a dev dependency), and `overrides` points it and
  bun-common at `file:../../packages/…`, because neither is on a registry. Bun
  1.4.3 materialises a `file:` directory as a tree of per-file symlinks, so an
  edit to a package file is seen at once and a **new** file only after the next
  `bun install` there; 1.4.4-canary makes hardlinks instead, so an edit that
  replaces a file (`git checkout`, most editors' save) reaches the template
  only after the next install (measured 2026-10-17: a negative control passed
  falsely until the reinstall). bun-common arrives through the override **without its
  own dependencies** (a Bun behaviour: a `file:` directory that replaces a
  transitive dependency is installed with none of its dependencies,
  oven-sh/bun#44299), so
  inside the repo they resolve from the root `node_modules`, an ancestor; a
  copy outside the repo points `overrides` at packed tarballs instead (the
  template's README, step 2).
- **Types.** Its own `tsconfig.json` is a plugin author's: no source
  condition, so it would read bun-jobs' built `dts/`, which the repo does not
  keep. The repo checks the same files through `templates/tsconfig.json`
  (the base config, source condition), which is what `scripts/typecheck.ts`
  lists. `bun scripts/check-types.ts` checks the author's view: it packs
  bun-common and bun-jobs (their `prepack` builds `dts/`), copies the
  template out, installs and checks it against those tarballs, packs it, and
  type-checks a consumer under `bundler` and `node16` with `skipLibCheck` off.
  Its checks run `bun check`, which reproduced tsc 6.0's errors for both
  columns, `node16`'s TS2834 on an extensionless relative import in a shipped
  declaration included (measured, 2026-10-10); its `scripts/build.ts` still
  emits the declarations with tsc. The template's own tests do not take
  `bun test --check` and it has no `check` script: inside the repo its
  author's config reaches bun-jobs' source, and fails there.
- **Lint.** `templates/eslint.legacy.config.mjs` (the packages' config, plus
  the `scripts/` exemption for the template's own `scripts/`), outside the
  template so a copy carries none of the repo's lint dependencies; the
  template's `lint:eslint` names it (`-c ../eslint.legacy.config.mjs`) until
  PR E removes ESLint. `bun lint` reads the template's own
  `templates/compute-provider/bunfig.toml` (the root's rules without
  `eslint-plugin-regexp`, so it needs no dependency), found from the working
  directory up, so it wins when run from the template.
- **Gate**, for any change to the provider API (`lib/provider/**`, the
  summon types it re-exports) or to the template:

  ```bash
  cd templates/compute-provider
  bun install --frozen-lockfile && bun run test && bun scripts/check-types.ts
  CI=1 bun run lint:eslint
  ```

  plus `bun scripts/typecheck.ts` from the root. The test is the conformance
  kit against the template's fake (about 5 s, a temporary SQLite file for the
  handoff); `check-types.ts` about 25 s. The template's README is its quick
  start, so a change to what a provider must do is a change there too.

## Working with other Claude sessions

Several Claude sessions work on this repository at once, each owning a
package or a role. [`docs/agentic-setup.md`](docs/agentic-setup.md) is the
working agreement between them — who owns what, change reports, the commit,
PR and merge rules, worktrees, the heavy-run wrapper and subagents. Read it
before your first edit.

Plans live in [`docs/plans/`](docs/plans/README.md), one folder per main plan
(`docs/plans/<plan>/README.md`, with its sub-plans and `evidence/` inside it);
a new plan starts in that shape and a follow-up goes in the folder of the plan
it extends. The index there states the rule.

## Bun bugs

Bun behaviour that bun-node works around is documented in
[`docs/bun-bugs/`](docs/bun-bugs/README.md): one report and one minimal,
Bun-only reproduction per bug. A reproduction exits 1 while the bug is
present, so after raising the Bun floor, run them to see which workaround can
go. When you work around a new one, add it there (the README says how).

## Typechecking

**One base config, extended everywhere.** `tsconfig.base.json` at the repo
root holds every compiler option; the `tsconfig.json`s below it add only
`paths`, `include` and, where a project needs them, `types`/`lib`. A file is therefore checked the same way wherever it is
checked from.

```bash
bun scripts/typecheck.ts          # every project in the repo
bun scripts/typecheck.ts --list   # just name them
bun run check                     # the same, at the root; in a package, its projects
```

Run that rather than `bun run check` in one package — the packages are not
the only projects. There are also `packages/bun-common/bench`,
`packages/bun-common/playground`, `packages/bun-jobs/bench` and the standalone
`benchmarks/`, each a nested project with its own config because it resolves
third-party comparators from its own `node_modules`; the examples; the
compute-provider template (`templates/tsconfig.json`); the root `scripts/`
(`scripts/tsconfig.json`); and the VS Code extension for `bun lint` and
`bun fmt` (`tools/vscode-bun-lint/`, opt-in until PR E of
`docs/plans/bun-lint-fmt/`; its README says how to install it).

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
path into a pnpm-style store. Neither tsc 6.0 nor `bun check` reported them
on any project on 2026-10-10; the filter stays in case an ESLint config
upgrade brings them back.

### Bun's checker, not tsc

Every type check in the repo runs Bun's built-in checker, `bun check`, instead
of `tsc --noEmit` (the user's decision, 2026-10-10). It reads the same
`tsconfig.json`, reports the errors of TypeScript 7 (`bun -p
process.versions.typescript`: 7.0.2, where the repo's own `typescript` is 6.0.3
for the editor and the declaration build), and uses every core. Measured on
this machine: all 17 projects gave the same verdict as the tsc version of
`scripts/typecheck.ts`, clean, in 7–10 s against 109–112 s (load 9–13); a
deliberate error in
seven of them gave the same error lines from both, on 1.4.3 and on the 1.4.4
canary (TS2322, TS2339, TS2307, TS7006, TS2578, TS2584, TS2305; tsc exits 2,
`bun check` 1).

- **`bun check` runs a `check` script when the nearest `package.json` has
  one** (Bun's rule: "your script wins"), and the root's `check` is
  `scripts/typecheck.ts`. So `bun check -p <project>` from anywhere in the
  repo runs the whole repo instead; `-p`, `--project=`, `--cwd` and `bunx` all
  do (measured). Code that checks one project runs a bare `bun --check` in the
  project's directory, which is always the checker, and drops `AGENT`,
  `CLAUDECODE` and `REPL_ID` from its environment: they switch the output to
  a tagged, multi-line format for AI agents, and a bare `bun --check` ignores
  `--no-pretty`. `scripts/typecheck.ts`, bun-jobs-ui's
  `__tests__/app/pkg/typecheck.test.ts`, bun-jobs'
  `scripts/prove-type-controls.ts` and `scripts/test-seeded.ts`, and the
  template's `check-types.ts` do this.
  Inside a package's `check` script, `bun check` is the checker.
- **Packages:** `bun run check` is `bun check`, and in bun-jobs-ui `bun check
  && bun check -p app && bun check -p __tests__/app/pkg`, its three projects.
  An error placed in each project in turn failed it.
- **`bun test --check`** type-checks the test files and what they import
  before running anything, once, not per worker: with an error, a
  `--parallel` run printed one error and ran no tests. Every package's `test`
  scripts carry it. The check itself takes 0.3–0.6 s in bun-common (78 files),
  0.4–0.7 s in bun-nest (246), 0.7–0.8 s in bun-jobs (537) and 2.0–2.5 s in
  bun-jobs-ui (822, three projects); whole suites measured 21.9/23.0 s → 27.1/26.4 s
  for bun-jobs-ui and 229.9/230.2 s → 220.9 s for bun-jobs (no database
  URLs), the latter inside the noise. It checks each file with its **nearest** `tsconfig.json`,
  so bun-jobs-ui has `__tests__/app/tsconfig.json`, which only extends
  `app/tsconfig.json`: without it the app tests were checked with the
  package's DOM-free config and failed with 1,715 errors. It does not cover
  `*.type-test.ts` (not test files) or anything the tests load another way;
  `bun scripts/typecheck.ts` and `bun run check` do. The template's tests do
  not take it: their nearest config is the plugin author's, which in the repo
  reaches bun-jobs' source under stricter options (106 errors).
- **Builds:** bun-jobs-ui's `scripts/build.ts` (prepack) passes `check: true`
  to `Bun.build`, the API's `--check`, through `buildAssets`; about 175 ms.
  The in-memory build `jobsUi()` makes on a request never checks.
- **tsc stays only where `bun check` cannot do the job:** emitting
  declarations (`scripts/build-declarations.ts` and `tsconfig.build.json` in
  each package, the template's `scripts/build.ts`), and
  `scripts/consumer-check.ts`, whose matrix reproduces what consumers' own tsc
  5.9 and 6.0 report. bun-jobs' `referenceCheck.ts` and `docsCheck.ts` use
  TypeScript's compiler API (the checker's view of exports; snippets compiled
  in memory), not a type-check command.

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
- `__tests__/app/unmountLeaks.test.tsx` is the guard that replaced
  `@eslint-react`'s dropped `web-api-no-leaked-*` rules: the real app under
  StrictMode, live on, over a `HandleLedger` (`handleLedger.ts`) recording
  every timer, frame, window/document listener, socket, observer and fetch,
  with a negative control per kind (`cleanupPairs.test.ts` is only a static
  tripwire). A new screen gets a case that asserts its **start** (its
  TanStack interval, its channels in `socket.held`, for a live screen an
  event and the 250 ms coalescing timeout open), then **Phase A** (navigate
  to `/docs`: channels released, timers closed) and **Phase B** (`cleanup()`,
  `nativeSleep(20)`, `queryClient.clear()`, `nativeSleep(20)`,
  `assertNoneOpen()`; that order is measured). Await every `act`: one left
  un-awaited, or a case cut off by the test timeout, breaks React's act scope
  and every later test in the file records nothing.
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

**Pre-merge gate:** `bun scripts/typecheck.ts`; `CI=1 bun run lint:eslint` in the
package; `bun run test` plus `bun test --randomize` with a couple of seeds
(serial — the only check left for order leaks, since `--parallel` isolates
files); and
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
  on `prepack`). It runs `tsc -p tsconfig.build.json` — tsc, because
  `bun check` never emits — (`emitDeclarationOnly`,
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
  It runs each consumer's own tsc, deliberately not `bun check`: the point is
  what a consumer on TypeScript 5.9 or 6.0 sees.
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
(checked by `bun run check`; `bun test`, even with `--check`, never reads a
`*.type-test.ts`); runtime behaviour and every
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
- A layer is finished when it calls `next()` or sends a **complete**
  response; until then the pipeline waits (`waitForLayer`): for a `next`
  called from a callback, an async handler's promise, a response, or an open
  stream's end. An async handler's `next()` or response moves on without
  awaiting the promise (a later rejection is logged); an open stream
  (`res.write()`) handed on with `next()` stays open for the next layer.
  `handle()`'s `timeout` (the adapters pass their request timeout) fails a
  wait with `Request Timedout` while nothing has been sent, answered without
  the request (`isRequestTimeoutError`). `dispatch()` returns synchronously
  when no layer had to wait. A pipeline that parks (`#park`) gets **one**
  promise for all its waits (`#ensureAsync`); a wake from `next()`, a
  response or a stream's end resumes a microtask later — never inside the
  call that woke it, so `res.send(); next(err)` in one tick still reaches
  the error handlers. The adapters and `fetch()` serve through
  `serveRequest(options, hooks)`, which finishes the request (its `Response`,
  or a stream's as soon as it opens) inside that same promise;
  `awaitPipelineOrStream` remains for a router whose `handle()` is
  overridden.
- An error after the response started still runs the error handlers; one
  none handles destroys a streamed response (`res.destroy`) and is logged.
- A route without its own HEAD handler answers `HEAD` with its GET one;
  socket-free `fetch()` drops the body as `Bun.serve` does (`toFetchResponse`).
- An unhandled error is re-thrown for the adapter's final error handler
  (`setErrorHandler` / `Bun.serve` `error()` callback).
- `use(path, ...)` registers middleware with `group: path` so
  `@routejs/router` compiles a **prefix** regex (Express prefix matching);
  plain `path:` routes are exact-match.
- Paths are compiled at registration by a port of path-to-regexp 8.4.2
  (`lib/utils/expressPath.ts`, MIT; the version Express 5.3 runs, and a
  devDependency for its differential fuzz only). Routejs-only forms (`:x?`,
  `:x(re)`) are bridged; a malformed path throws `PathSyntaxError`. Plain
  paths compile byte-identical to routejs, so the RouteTree and the route
  cache treat them as before. A named wildcard's array is frozen, since
  matched params are cached and shared across requests.

## Typed routes (generated overloads)

`BunRouter` and both `BunHttpAdapter`s carry **generated** verb overloads that
narrow a handler's request:

- `req.params` from the path literal — `get("/home/:name/:id?", h)` gives
  `{ name: string; id?: string }`. Paths are path-to-regexp 8's (Express 5's)
  syntax: `*name` yields a `string[]` under its name only (no positional key;
  a bare `*` keeps `"0"`), and `{*name}` an optional `string[]`, matching what
  the matcher emits. The walker (`lib/types/routeParams.ts`) reads the literal
  character by character; a non-literal path falls back to
  `ParamsDictionary`.
- `req.query` / `req.body` / `req.params` from a `BunValidate` middleware
  registered ahead of the handler in the same call, via a phantom `__shape`
  type it carries.

They live between `/* --- BEGIN generated typed overloads: <verb> --- */`
markers. A verb the base class lacks (`proppatch` and `query` on `BunRouter`)
is declared without `override` and is still generated; the generator prints
the verbs it found. **Do not edit them by hand** — regenerate:

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
`bun run check`, not `bun test` (`--check` covers test files only). Runtime coverage for mounting is in
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
  (the IDE may flag this where the CLI check passes). Use `satisfies RouterErrorMiddlewareHandler` to give the
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
