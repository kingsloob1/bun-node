# Working with Claude agents on bun-node

bun-node is developed by several Claude Code sessions at once, on one machine,
in one repository, for one maintainer. This document is how they divide the
work, talk to each other, use git, share the machine and hand work to
subagents. Every rule here exists because breaking it cost something; where
the incident is worth knowing, it is named.

It is written for two readers: a Claude session starting work on this repo
(read it before your first edit), and the maintainer deciding who does what.
`CLAUDE.md` holds the project knowledge; this file holds the working
agreement between the agents.

- [Handoff (2026-10-22): read this first](#handoff-2026-10-22-read-this-first)
- [Standing rules from the maintainer](#standing-rules-from-the-maintainer)
- [The agents](#the-agents)
- [Ownership](#ownership)
- [Talking to each other](#talking-to-each-other)
- [Commit, PR and merge](#commit-pr-and-merge)
- [Worktrees and branches](#worktrees-and-branches)
- [Gates](#gates)
- [Sharing the machine](#sharing-the-machine)
- [Subagents](#subagents)
- [Memory](#memory)
- [Plans](#plans)
- [Bun bugs](#bun-bugs)
- [Starting a new agent](#starting-a-new-agent)

## Handoff (2026-10-22): read this first

On 2026-10-22 the maintainer stopped every Claude session working on this
repository, so that development could continue with another model. This
section is written for that developer, human or model, who arrives without
any session's memory. Everything a session knew that the repository did not
has been written into this file, [`CLAUDE.md`](../CLAUDE.md) and the plans.
The rest of this file describes the multi-agent setup that ran until then;
[Working alone](#working-alone-the-roles-collapse) says how its rules apply to
one developer.

### The state at handoff

- **develop** is at `bc2b1a5f` (#501). Every agent's work is merged except
  the two open PRs below. No agent is running and none may resume (the user's
  instruction). No worktree holds uncommitted changes. No local commit is
  missing from GitHub: every local branch and worktree head was checked
  against the remotes on 2026-10-22. So were the dangling commits since
  2026-10-14, each a pre-rebase copy of merged work.
- **Open PRs**, both pushed and gated, neither merged:

  | PR | Branch, head | What | To land |
  |---|---|---|---|
  | #515 | `feat/bun-validate-v5c-flows`, `d4046e65` | bun-validate V5c: schemas for flows (bun-jobs) | rebase onto develop (the conflict is in `docs/plans/bun-validate/README.md` only), re-gate, merge |
  | #517 | `examples/v5c-warn-refused`, `c3dc87c2` | the examples check for #515's `"warn"` fix; its base is #515's branch | merge into #515's branch first |

  The exact steps, gate and resolution are in the bun-validate plan's
  [Handoff](plans/bun-validate/README.md#handoff-2026-10-22-how-to-resume).
- **Pushed `wip/` branches**: `wip/stash-2026-10-07-playground-local-compute`
  and `wip/stash-2026-09-23-examples-read-apis`. They preserve the only two
  stash entries in the repository, both old and superseded by merged work.
  [`docs/plans/README.md`](plans/README.md#handoff-2026-10-22-where-every-plan-stands)
  says what each holds. The stash entries themselves were left in place.
- **Worktrees on the machine**, beside the main checkout:
  `../bun-node-v5c-a0` and `../bun-node-v5c-check-74`. They belonged to the
  stopped agents, are clean, and sit at #515's and #517's heads. Remove them
  (and their local branches) once those PRs merge. `../bun-node-handoff-b8`
  holds the branch that wrote this section, `docs/handoff-2026-10-22`; remove
  it once that merges.
- **The main checkout** (`bun-node/`, on `develop`) is the user's. It holds
  one untracked file of theirs, `playground/compute/obinna-queue-worker.ts.orig`.
  Never edit, switch or clean the main checkout; work in your own worktree.
- **Where every plan stands**, and what is held:
  [`docs/plans/README.md`, "Handoff"](plans/README.md#handoff-2026-10-22-where-every-plan-stands).
  The user's current priority is bun-validate. Next there is V5c to finish,
  then V7a.
- **No standing permissions remain.** The two time-boxed ones (the
  2026-10-20 overnight window to commit, open PRs and merge without asking,
  and auto-resume after a usage limit) expired. Every commit, PR and merge
  needs the user's own yes, each step separately.

### First steps on this machine

The machine rebooted on 2026-10-22, which empties `/tmp`. Before any gate:

1. **Bun.** `bun --revision` should be a 1.4.4 canary. Everything was last
   verified on `1.4.4-canary.1+6bb5dc195`. If a later canary changes lint or
   format output, that change is the canary's (CLAUDE.md, "Dev workflow").
2. **The heavy-run wrapper is not installed** after the reboot:
   `bun scripts/install-heavy-run.ts` from an up-to-date develop
   ([Where the wrapper comes from](#where-the-wrapper-comes-from)).
3. **Databases.** Run `bun scripts/setup-databases.ts` (`--dry-run` first
   prints the plan and the five URLs). A restart resets MariaDB's
   `max_connections` to 151, which shows up as MariaDB-only "Too many
   connections" failures in bun-jobs' full suite. Check that all five ports
   answer: Postgres 5432, MariaDB **3306**, MySQL **3307**, Redis 6379,
   MongoDB 27017. Postgres's raised limit needs `--restart-postgres`. A
   permanent fix is still owed: recreate the MariaDB container with
   `--max-connections`, so a restart keeps it.
4. **GitHub.** The gh CLI's active account may be `kingsloob1-concavehr`,
   which is not a collaborator. Check with `gh api user --jq .login`; if it is
   not `kingsloob1`, prefix each gh command with
   `GH_TOKEN=$(gh auth token --user kingsloob1)` and pass
   `-R kingsloob1/bun-node`. Never `gh auth switch`: that changes the user's
   global state for their other work.
5. **Blame.** Run `git config blame.ignoreRevsFile .git-blame-ignore-revs`
   once per clone.
6. **A worktree per task**
   ([Worktrees and branches](#worktrees-and-branches)): `bun install` at
   its root, then `bun install --frozen-lockfile` in
   `packages/bun-common/bench`, `packages/bun-jobs/bench`, `benchmarks/`,
   `templates/compute-provider/` and `tools/vscode-bun-lint/`, then
   `bun scripts/typecheck.ts` (18 projects).

### On another machine

- Clone, then `bun upgrade --canary` (development needs Bun ≥ 1.4.4).
  Install as in step 6 above. Provide the databases with
  `bun scripts/setup-databases.ts --docker`. For bun-jobs-ui's e2e tests and
  examples, provide a Chrome (`BUN_CHROME_PATH`).
- **Signed commits.** develop's ruleset requires them. This machine signs
  with the repository's SSH key configuration (`gpg.format=ssh`,
  `user.signingkey=~/.ssh/id_ed25519.pub`, `commit.gpgsign=true`). Elsewhere,
  set up a signing key that GitHub accepts for the pushing account, and ask
  the user which account and key to use.
- The stopped sessions' memory (`~/.claude/projects/…/memory/`) and their
  notes in `~/.cache/bun-node-*` stay on the old machine. Their durable
  content is copied into this file, CLAUDE.md and the plans. Nothing else
  is needed from them.

### Working alone: the roles collapse

One developer now holds every role in [The agents](#the-agents). The rules
between agents still hold; they become a checklist per PR:

- **Reviews by the owner**: run that package's whole gate yourself before
  merging a PR that touches it ([Gates](#gates)). After a bun-common change,
  also run bun-nest's and bun-jobs' gates, bun-jobs' `test:seeded` included.
  For bun-nest, also the 11.2.7 Nest matrix column.
- **CHANGE REPORT to the examples agent**: for every user-facing change,
  write the PR body as that report (what changed, signatures, defaults,
  limits, which example checks change). Land the example additions or fixes
  under `examples/**` in the same merge window: in the same PR, or stacked
  on its branch ([Merge order](#merge-order)). Write the package README's
  reference section in the feature's branch.
- **The playground** gets every finished feature
  ([Ownership](#ownership)): typecheck, `cd playground && bun run lint &&
  bun run format:check`, and a smoke run on `PORT=0` that stops cleanly.
- **One asker**: ask the user each decision once, then record the answer in
  the plan (its questions and names sections) in the same PR, so nobody asks
  again.
- `ListAgents`, `SendMessage`, session names and the roster need no
  successor. [Subagents](#subagents) still applies if your tool has them.

### The tools this file names

This file was written for Claude Code. If your tool differs:

- **"The `AskUserQuestion` popup"** means a separate, explicit question to
  the user about one decision (commit, open the PR, merge), with your
  recommendation first. Then you wait for the answer. It never goes in
  passing in a longer message, and silence or an earlier approval is never
  consent.
- **"`run_in_background` and the completion notification"** means: start
  long jobs detached, and don't spend turns watching them. With the heavy-run
  wrapper, re-issuing the same command with the same `HEAVY_TICKET` attaches
  to the job, or returns its recorded result at once, so you never re-queue.
- **"Memory"** is Claude Code's per-project notes. Keep durable facts in the
  plans, CLAUDE.md and this file instead.

## Standing rules from the maintainer

These are the maintainer's rules, collected on 2026-10-22 from their global
instructions (which apply to every repository they work in) and from the
decisions they gave the sessions on this one. Most also appear, with their
mechanics, elsewhere in this file or in CLAUDE.md. Here they sit in one
place, because they are what any successor most needs to follow. Where a
rule was learned from an incident, the incident is named.

### From the maintainer's global instructions (every repository)

**Consent for commit, PR and merge.**

- **Every request to commit, open a PR or merge is its own explicit question**
  (Claude Code: an `AskUserQuestion` call), never a question in passing in the
  reply text. This is absolute: every repository, every session, every time.
  It covers follow-ups, one-line and documentation-only changes, and merging
  something approved at an earlier stage. Approval of a commit is not
  approval of a PR, and approval of a PR is not approval of a merge.
- These phrasings are **not allowed**, because they are the same question in
  disguise:
  - "Shall I commit this?", "Want me to open a PR?", "Say the word and I'll
    merge.";
  - "Ready to merge whenever you are.", "Tell me if you'd like this landed.";
  - offering a choice of landing strategy in prose ("its own PR, or folded
    into the open one?");
  - pointing at a pending decision instead of asking it: "waiting on your
    merge decision", "#155 is still open for you", "I'll ask before
    merging", "nothing needs you except the merge".
- **The test before ending any turn:** is anything ready to commit, open or
  merge that the user has not decided? If yes, the question is in this turn.
- **The reply text carries the evidence**: gate results, what was verified
  and how, what changed, and what is still unproven. The question carries the
  decision.
- **Never commit unasked.** (2026-09-10: sixteen commits landed on a branch
  during an autonomous run. The work was wanted; the unprompted commits were
  not.) A plan's "one commit per phase" describes the history's shape; it is
  not permission to write it.
- **No AI attribution** in commits or PRs: no `Co-Authored-By` trailer, no
  "Generated with" footer, even when a tool's defaults add them.
- **Delete your own branch and worktree, local and remote, once merged.**

**Reproducible Bun bugs get an issue on `oven-sh/bun`.** This needs no
permission first; it is a standing instruction.

1. **Search the existing issues first**, before reducing the bug, in several
   phrasings (`gh search issues --repo oven-sh/bun "<symptom>"`). If one
   exists, run its reproduction on our build and add what is new as a
   comment: our version, OS and arch, any other affected API, a workaround.
   Don't open a duplicate. (2026-09-27: hours went into reducing a
   `toBeNull()` false pass before a search found oven-sh/bun#37310 with the
   reproduction in it.)
2. **Prove it is Bun's.** Reduce it to a minimal reproduction with none of
   our code: one file, run with `bun`, showing expected against actual. If it
   only happens inside our code, keep reducing, or say exactly which of our
   code it needs. A bug that does not reproduce minimally is not ready.
3. **Read how Bun wants issues filed, every time**, from the repository: the
   issue templates (`.github/ISSUE_TEMPLATE/`), `CONTRIBUTING.md` and any
   "before filing" guidance. Follow the template's fields exactly, with
   `bun --revision`, `bun --version`, OS, arch and the reproduction.
4. **File it with `gh issue create -R oven-sh/bun`.** Keep it factual, with
   no speculation beyond what the reproduction shows. Include none of our
   proprietary code, paths, hostnames or secrets.
5. **Tell the user the URL.** Note it where the workaround lives (a code
   comment and [`docs/bun-bugs/`](bun-bugs/README.md)), so the workaround
   can go once Bun fixes it.

Filing needs no permission, but working around the bug in our code follows
the consent rules above.

**`.env.example` hygiene.** This applies to every `.env.example`,
`.env.sample`, `.env.template` and `example.env`, whenever one is created,
edited or committed, including edits the user made and asked you to commit.

1. **No duplicate keys.** A commented-out copy of a key that also appears
   live is a duplicate, so remove it. If the copy was there to show a format,
   keep that as a plain comment with a placeholder value. The check must
   print nothing:
   `grep -oE '^\s*#?\s*[A-Z][A-Z0-9_]*=' .env.example | sed -E 's/^\s*#?\s*//; s/=$//' | sort | uniq -d`
2. **No sensitive values** without the user's explicit approval of that
   specific value. That means secrets, API keys (test keys too: `sk_test_…`
   is a secret), passwords, tokens, DSNs, connection strings, real database
   hosts and ports, and real production URLs, whether live or commented.
   Leave such a value empty or use an obvious placeholder. Non-sensitive
   defaults (`false`, `3600`, `NGN`) are fine. An approval covers one value in
   one request.
3. **Before committing**, review every non-empty value
   (`grep -nE '^\s*#?\s*[A-Z][A-Z0-9_]*=.+' .env.example`). If a credential
   has to be stripped, check whether it was ever committed
   (`git log --all -S '<value>'`). If it was, tell the user it needs
   rotating, not just deleting.
4. **Tell the user** what was stripped and why, in the reply that reports
   the commit.

### This repository's rules

**Git and GitHub**

- **Signed commits** on everything that reaches develop (a ruleset since
  2026-09-29). Check one with
  `gh api repos/kingsloob1/bun-node/commits/<sha> --jq .commit.verification`.
  Never force-push develop.
- **Never `git stash`.** The stash list is shared by every worktree. Use a
  commit on your branch, or a patch file outside the repository.
- **A worktree per task, branched at creation, at a fresh path per check.**
  Run `bun install` in it and assert `@kingsleyweb/*` resolves inside it.
  (2026-09-19: a reused worktree path gave deterministic false failures.
  2026-09-26: a long-lived worktree without a fresh install reported a pass
  the code did not earn.)
- **Never type a full SHA** by extending a short one. Take it from
  `git rev-parse`, `git ls-remote` or `gh pr view`, and pass it to
  `--match-head-commit` or `--force-with-lease` as a variable. (2026-10-11:
  guessed SHAs failed two guards.)
- **Merge, confirm `MERGED`, then clean up, joined with `&&`, never `;`.**
  (2026-09-29: a refused merge's `;`-chained cleanup deleted #235's branch.)
- **The gh account and PR bodies**: step 4 of
  [First steps](#first-steps-on-this-machine). `gh pr edit` fails silently
  here; update a body with
  `gh api -X PATCH repos/kingsloob1/bun-node/pulls/N -F body=@file` and
  read it back.
- **Before removing a worktree or branch you did not create**, check it
  (`git -C <path> status --short`, unpushed commits) and ask its owner.
  (2026-09-23 and 2026-09-27: two worktrees were wrongly claimed.)

**Decisions belong to the user**

- **Public API, names and behaviour changes** are approved by the user
  before they are built. Each plan lists the names awaiting approval (its
  "Names needing approval" section) and its open questions. Ask each one
  once, give a recommendation, and record the answer in the plan.
- **Conditional approvals** ("merge after the joint gate") are fine. Merge
  when the condition is met; bring it back to the user if the check finds a
  problem.
- **No speed comparisons without asking** (2026-10-20): no router-guard A/B,
  no bench `--compare`, and no re-recorded baseline unless the user says yes
  for that change. Tests, the Nest matrix, consumer-check and the examples are
  unaffected. (Chained 20–40-minute A/Bs had stalled the machine for hours.)
- **Held plans stay held** until the user schedules them
  ([`docs/plans/README.md`](plans/README.md#handoff-2026-10-22-where-every-plan-stands)).
- **Don't remove a Bun workaround because a canary fixes the bug.** It stays
  until the fix is in a stable release, and for shipped code until
  `engines.bun` excludes the affected versions (2026-10-06).

**Code**

- Prefer native and Bun APIs and the in-repo helpers (`native.ts`) over new
  dependencies (CLAUDE.md, "Dependency policy").
- When emulating a framework (Express 5, NestJS, path-to-regexp, `fresh`),
  match its semantics exactly: look up the spec or port the source, don't
  approximate.
- Fix lint errors with real TypeScript types, with no lazy `any`. Give every
  new or edited property, field, option and constructor parameter a JSDoc
  description: what it is, its default, any gotcha.
- **Tests for every change**, and every existing test kept green. Show a
  new check is able to fail: run it on the base, or mutate the code (a
  negative control). Writing tests has repeatedly found real bugs here.
- **The four `scripts/build-declarations.ts` and four `tsconfig.build.json`
  are one file**: change all four together or none
  (`buildDeclarations.test.ts`). (2026-10-20: a per-package `--fix` turned
  develop red, #433 → #436.)
- **Never autofix `@typescript-eslint/no-duplicate-type-constituents`**: its
  fix deletes deliberate compile-time guards.
- Don't edit generated code by hand: the typed verb overloads come from
  `bun scripts/generate-verb-overloads.ts`.
- **Parsed READMEs are code**: the bun-jobs-ui "What each element needs"
  table and bun-jobs' scaler recipes are read by examples. (2026-09: a
  docs-only edit turned develop red, #141.)
- **Type-check with `bun check`**, not `tsc` (2026-10-10). tsc stays only
  for emitting declarations and consumer-check's TS 5.9/6.0 matrix.
- **Check the file before claiming how code behaves**, and quote
  `file:line`. Prefer a measurement to an argument. A claim about a knob goes
  stale when the knob changes, so re-read prose against develop.

**Tests, gates and examples**

- **Quote what ran, not what was green**: "78 passed, 3 skipped", with the
  backends.
- **Frozen lockfile installs** in the bench directories, `benchmarks/`, the
  template and the VS Code extension. A plain install rewrites the lock
  against the registry. Change a lock on purpose, in its own commit.
- **A bun-common change runs bun-jobs' `test:seeded` and `bun run check`**,
  not a subset. (2026-10-21: a gate that ran only `__tests__/api` let V1
  break `runner-legacy-modes.test.ts`.)
- **Examples green in the merge window**: a change that breaks an example
  check lands with its fix, never leaving develop red. Re-run on the exact
  tree being merged, rebased onto the current develop tip.
- **Example prose must be true on develop**, not only on the branch.
- **A test that starts failing under load is fixed**, not answered by
  lowering the worker count.
- A job reads `active` once it is claimed, before its handler runs. A test
  that needs "it is running" waits for a marker the handler writes.

**The machine**

- **Heavy jobs go through the wrapper**, with a ticket, under `nice -n 10`
  and a `timeout`, started in the background and never polled
  ([Heavy runs](#heavy-runs)). bun-jobs' suite with database URLs is
  `HEAVY_EXCLUSIVE=1`. While a seeded or full suite runs, start nothing else
  of your own: an unwrapped job beside it caused 7 timing failures
  (2026-10-17). (2026-10-08: load around 30 on 16 cores rebooted the
  machine.)
- **Kill by PID only, and only your own**: never `pkill` or `killall` by
  pattern.
- **Delete only the test data your run created**, its exact namespaces,
  never a `LIKE` sweep. Redis databases: 13 for examples, 15 for tests, 14
  for benchmarks.
- **Keep scratch you need after a crash under `~/.cache/`**, not `/tmp`,
  which a reboot empties.
- Docker is a snap and cannot write `/tmp`: pipe captured docker output
  through `| cat`. `/tmp` can run out of inodes with space free (`df -i /tmp`).

**Plans and docs**

- **The plans folder layout** (2026-10-11): `docs/plans/<plan>/README.md`,
  with sub-plans and `evidence/` inside it, and the index updated in the same
  change ([Plans](#plans)).
- **Keep a plan's Status current** in the PR that changes it, and record
  every user decision there in the same PR.
- **Every finished feature reaches the playground** (2026-09-30), for the
  user to see and try.

## The agents

Each session holds one or more **roles**: one package to own, and plans to lead (below). Session names (`bun-node-c0`, `bun-node-3a`, …)
change whenever a session restarts, so address peers by the name `ListAgents`
shows today, and think in roles.

| Role | Owns | Does |
|---|---|---|
| **bun-common agent** | `packages/bun-common/**` | the HTTP layer: router, request/response, adapter, WebSocket, multipart, logging, `native.ts`; its tests, bench and package README |
| **bun-nest agent** | `packages/bun-nest/**` | the NestJS adapter, WebSocket adapter, interceptors and decorators; its tests and package README |
| **bun-jobs agent** | `packages/bun-jobs/**` (but see `lib/runner/**` below) | queues, drivers, schema sync, the management API; its tests, bench and package README; reviews every PR that touches `packages/bun-jobs/**` — compute providers, summon and host isolation are built by the features agent under this review |
| **bun-jobs-ui agent** | `packages/bun-jobs-ui/**`, `playground/**` | the React UI and its server; its tests, e2e and package README; reviews every playground change |
| **Examples agent** | `examples/**`, and the example links and tables in package READMEs | a self-asserting example for every user-facing change; reviews runner changes |
| **Features agent** | nothing exclusively | cross-package and phase work: performance; summon and compute providers (`lib/summon/**`, `lib/provider/**`, `lib/providers/**`, `localCompute`); remote workers and the gateway (`lib/remote/**`); host isolation (the runner's executors, the container target); and their plans in `docs/plans/`. Built in the owner's package with the owner's review. Also the [main agent](#the-main-agent) |

**Retired 2026-10-22.** The user stopped every session for the handoff
above. The last roster, after the reboot of 2026-10-20, was: bun-node-ea
(Common, Validate & Cache), bun-node-a9 (Nest), bun-node-a0 (Jobs &
Telemetry), bun-node-2f (UI, Views & Client), bun-node-4c (Examples &
Tooling), and the main agent (Features and Coordinator, last as bun-node-b8).
The tables below are kept for the ownership they describe, which
[Working alone](#working-alone-the-roles-collapse) turns into a checklist.

**As of 2026-10-16.** Each session carries several roles (the user's
decision): it owns a package, as the table above says, and **leads** one or
more plans in [`docs/plans/`](plans/README.md). A plan's lead designs it,
keeps its Status current, and builds its PRs. A PR that lands in another
agent's package is built under that package owner's review, exactly as the
features agent's cross-package work is. Each session is renamed to its
name, which is then its `ListAgents` address; the second column is the name it
started with:

| Name (the address) | Started as | Owns | Leads |
|---|---|---|---|
| Bun-Node Common, Validate & Cache Agent | bun-node-11 | `packages/bun-common/**` (the bun-common agent) | [`bun-validate/`](plans/bun-validate/README.md), [`bun-cache/`](plans/bun-cache/README.md) (and the `@kingsleyweb/bun-cache` package once it exists, except its S3 driver sub-plan), [`api-docs-generation/`](plans/api-docs-generation/README.md), [`bun-native-routes/`](plans/bun-native-routes/README.md) (including the SSE helpers, PR-sse2 to sse5) |
| Bun-Node Nest Agent | bun-node-15 | `packages/bun-nest/**` (the bun-nest agent) | [`nestjs-12-parity/`](plans/nestjs-12-parity/README.md), [`nest-jobs-decorators/`](plans/nest-jobs-decorators/README.md), [`typed-client/nest-typed-routes.md`](plans/typed-client/nest-typed-routes.md) |
| Bun-Node Jobs & Telemetry Agent | bun-node-e9 | `packages/bun-jobs/**` (the bun-jobs agent) | [`opentelemetry/`](plans/opentelemetry/README.md), [`bun-cache/bun-jobs-s3-driver.md`](plans/bun-cache/bun-jobs-s3-driver.md) |
| Bun-Node UI, Views & Client Agent | bun-node-99 | `packages/bun-jobs-ui/**`, `playground/**` (the bun-jobs-ui agent) | [`bun-views/`](plans/bun-views/README.md) (and `@kingsleyweb/bun-views` once it exists), [`typed-client/`](plans/typed-client/README.md) (except its Nest sub-plan) |
| Bun-Node Examples & Tooling Agent | bun-node-74 (until renamed) | `examples/**` (the examples agent) | [`bun-lint-fmt/`](plans/bun-lint-fmt/README.md): the lint and format tooling in every directory, each package's config changed under its owner's review |
| Bun-Node Features Agent and Coordinator of other UI Agents | bun-node-ae | nothing exclusively (the features agent; also the [main agent](#the-main-agent)) | [`worker-runtimes/`](plans/worker-runtimes/README.md) and all its sub-plans (summon and compute providers, remote workers and the gateway, host isolation); performance; anything cross-package no one else leads |

A plan not in this table is the features agent's until it is assigned.

Update the dated table when a session is replaced. Nothing else in this file
should need to change for that.

### The main agent

The features agent is also the **main agent** (the user's decision,
2026-10-09): it makes sure every role above has a session. On startup, and
again after a restart or a usage limit, it:

1. Runs `ListAgents` and matches each live session to a role in the dated
   table. A session whose role it cannot tell (one from another window, or
   one the table does not name) is asked for its role, not assumed, and a
   session that holds no role keeps none unless the user says so.
2. For every role with no live session, **recommends to the user** that they
   start one: it names the role, what the role owns, and gives the kickoff
   prompt from [Starting a new agent](#starting-a-new-agent) with the role
   filled in. It recommends; the user starts sessions. Until a session takes
   the role, the main agent tells the user who covers that role's work — for
   bun-common and bun-nest, the features agent, as the paragraph above says.
3. Once the user has started a session, assigns it its role by message: the
   role, the paths it owns, today's roster, and any in-flight work it
   inherits (branches, open PRs, owed reviews and reports).
4. Updates the dated table in one combined edit once the new sessions have
   their roles, so the file has a single writer. It is a committed file, so
   the edit goes through the usual commit, PR and merge popups.

If no features agent is running, the first session the user starts does
steps 1 and 2, recommending a features agent first.

## Ownership

**One writer per file.** Overlapping edits and duplicated examples are the
failure this split exists to prevent.

- **Only the owner edits its paths.** Anyone else who finds a problem there
  sends the owner a report (below) and waits for the fix. That includes a
  one-character typo, a failing test and a wrong README row.
- **Shared files** — the root `CLAUDE.md`, `README.md`, `package.json`,
  `tsconfig.base.json`, `scripts/`, `templates/`, `docs/` — have no single
  owner. Before editing one, tell the agents whose work it
  describes; a CLAUDE.md section about a package is that package owner's to
  review.
- **A feature that spans packages** is built by the features agent (or by the
  owner of the package it mostly lives in), and every other package it
  touches is reviewed by that package's owner before merge.
- **`lib/runner/**` and `lib/queue/workerTarget.ts`** are written by whoever
  builds the feature, and reviewed by the examples agent. Host-isolation and
  executor changes (`lib/runner/executors/**`, `workerTarget.ts`, the
  container target) are also reviewed by the bun-jobs agent (the user's
  decision, 2026-10-01). Both check against the pitfalls in
  [Reviewing runner changes](#reviewing-runner-changes).
- **Package READMEs:** a feature branch writes the reference section for its
  feature in its own package README. The examples agent owns the example
  links, tables and option tours, and every `examples/*/README.md`.
- **Done includes the playground.** Whoever builds a feature writes its
  addition to `playground/` (`bun playground/index.ts`, served at
  `http://localhost:4000/jobs`) so the user can see and try it, as its own
  small PR or in the feature's last one. The playground is the bun-jobs-ui
  agent's (the user's decision, 2026-10-06), so it reviews every playground
  change before merge: the typecheck, `cd playground && bun run lint && bun run format:check`,
  and a smoke run on `PORT=0` that exercises the feature, stops on SIGINT and
  leaves no processes or data. The playground runs the working tree live, so
  flip a feature's capability flag last, after everything it advertises works.
- **Contract fixtures are the one exception to one writer per file.** A
  change to bun-jobs' `api/contract` may make the minimal fixture additions in
  bun-jobs-ui's tests that the typecheck needs (as #277 did), and tells the
  bun-jobs-ui agent (the user's decision, 2026-10-06).
- **A parsed table belongs to the package that states the rules.** The
  bun-jobs-ui README's "What each element needs" table is the bun-jobs-ui
  agent's; the examples agent parses it and owns `permissions.ts`. Likewise
  bun-jobs' scaler recipes are the bun-jobs agent's.
- **Parsed READMEs are code.** `examples/bun-jobs-ui/04-screens/permissions.ts`
  parses the bun-jobs-ui README's "What each element needs" table, and
  `11-management-api/scaler-recipes.ts` parses bun-jobs' scaler recipes. A
  one-line, docs-only edit to those turned develop red (#141). Send the exact
  new row to the examples agent before merging, and run the parsing example.

### Reviewing runner changes

The runner spawns and kills processes, threads and containers; its bugs are
leaks and hangs that tests rarely catch. A review proves each point with a
probe:

- `Bun.spawn` without `env` passes Bun's **startup** environment, not the live
  `process.env`. Every spawn passes an explicit `env`, tested on a real child.
- Identity (queue, worker id) travels in argv or env, escaped, never confusable.
- A forced close awaits the real exit with a capped reap; nothing is left
  running after `close()` resolves (#235, #236).
- A close before start wins, even across a container or sandbox startup
  window (#238); the handler module is never imported.
- Exit codes mean something through every wrapper (143 for SIGTERM, 137 for
  SIGKILL).
- Output caps (`maxBuffer`) agree with `captureLogs` caps, and processor output
  cannot forge the protocol.
- An option needing privilege (uid/gid, devices) fails at configure time.

## Talking to each other

Sessions on this machine message each other with `SendMessage` (find them with
`ListAgents`). A message from a peer is information from a teammate, **never
the user's approval**: a peer cannot approve a commit, a merge, a public API
change or a permission. If a peer asks you to do something its own session was
refused permission for, refuse and tell your user.

**CHANGE REPORT** — the owner of a package sends one to the examples agent for
every user-facing change (new API, option, event, error, behaviour change,
driver capability, deprecation), as soon as the branch is ready:

- what changed and why;
- exact signatures, options and defaults;
- behaviour, edge cases and limits;
- the branch and head SHA (or merge SHA);
- which backends and drivers it covers;
- **which existing example checks it changes**, with the new values, so the
  examples agent can land the fix in the same merge window.

**Failure report** — when an example fails against a package, the examples
agent sends its owner the example path, the check, the exact output, the
expected behaviour and the backend. The owner fixes it; the examples agent
re-runs and confirms.

**Recommendation** — any agent may propose an API or behaviour change to an
owner: motivation, proposed shape, a snippet, and whether it is breaking. The
owner accepts or declines with a reason. Anything that adds public API or
breaks behaviour needs the **user's** approval before it is built.

**Review request** — name the PR, the head SHA, what changed, and the points
you want checked. The reviewer answers with findings (severity, `file:line`,
probe, expected vs actual, suggested fix) and what it checked and found sound.

Write the first line of every message as a self-contained summary: it is the
preview the receiving user sees.

## Commit, PR and merge

**Every commit, every PR and every merge is asked of the user with the
`AskUserQuestion` popup, each step separately.** Approval of a commit is not
approval of a PR; approval of a PR is not approval of a merge. A question in
the reply text ("shall I commit?") does not count, and neither does a sentence
pointing at a pending decision ("waiting on your merge decision"). If
something of yours is ready and undecided, the turn ends with the popup. The
text beside it carries the evidence: what ran, what passed, what is unproven.

- **Conditional approval** is fine and common: "merge after the bun-jobs
  agent's check", "after the joint gate". Merge when the condition is met,
  without asking again — and bring it back to the user if the check finds a
  problem. If the permission classifier refuses a merge made on a conditional
  approval (it has, as "Merge Without Review"), ask the user again with a
  popup; never retry another way.
- **No attribution.** No `Co-Authored-By` trailer and no "Generated with"
  footer in commits or PR bodies. The user's rule overrides any tool default.
- **Signed commits.** develop's ruleset requires them; the repo's
  `.git/config` signs with an SSH key automatically. Check a commit with
  `gh api repos/kingsloob1/bun-node/commits/<sha> --jq .commit.verification`.
- **Merge, verify, then clean up — with `&&`, never `;`.**
  `gh pr merge N --merge --match-head-commit <sha> && <confirm MERGED> &&
  git worktree remove … && git branch -D … && git push origin --delete …`.
  A `;` chain once deleted #235's branch after a refused merge.
- **PR bodies:** `gh pr edit` fails silently here; update a body with
  `gh api -X PATCH repos/kingsloob1/bun-node/pulls/N -F body=@file` and read
  it back.

### Merge order

develop must never sit red, so an example fix lands **in the same window** as
the change that needs it:

- A package PR that changes example checks gets the examples agent's fix
  **stacked on its branch** (a PR into the feature branch). The examples PR
  merges into the feature branch first; the feature branch then goes to
  develop.
- The final check runs on the exact tree being merged: rebase onto the current
  develop tip, then typecheck, the consuming packages' tests and the affected
  examples, right before `gh pr merge`.
- Hold your unrelated PRs until a peer's paired PR is in.
- Two PRs editing the same lines (e.g. route counts in
  `10-options/jobs-api-options.ts`): whichever reaches develop second is
  rebased and re-run.

## Worktrees and branches

Several sessions share one `.git`, so git state is shared state.

- **Work in your own `git worktree`**, never by switching the main checkout:
  `git worktree add -b <branch> ../bun-node-<topic>-<suffix> origin/develop`.
  The main checkout may hold the user's own uncommitted work.
- **A fresh worktree path for every check.** Reusing a path gave deterministic
  false failures.
- **`bun install` in the worktree and assert `@kingsleyweb/*` resolves inside
  it** (`bun -e "console.log(require.resolve('@kingsleyweb/bun-jobs'))"`).
  Otherwise the gate validates another tree.
- **Branch every worktree at creation**, and remove your own the moment it
  merges — local branch, remote branch and worktree. Never remove another
  session's, even if it looks abandoned; ask its owner.
- **Never `git stash`.** The stash list is shared by every worktree and every
  session. Use a commit on your branch or a patch file in your scratchpad.
- **In a shared checkout, check `git branch --show-current` before editing.**
  A peer may have switched it.

## Gates

Before asking for a commit, run what the change touches; before a merge, the
full gate on the rebased branch. `CLAUDE.md` has each package's commands; in
short:

- `bun scripts/typecheck.ts` — every project, with `bun check`, and all must
  pass (Bun ≥ 1.4.4 for development, which until it is stable is the canary:
  `bun upgrade --canary`, verified on 1.4.4-canary.1+5f5799ed1 and, from
  2026-10-20, 6bb5dc195; the packages'
  users need 1.4.2; the user's decisions of 2026-10-10 and 2026-10-17). A new
  lint finding or reformatted file after a `bun upgrade --canary` is the
  canary's: report it to the bun-lint-fmt lead with both `bun --revision`s
  rather than fixing it in passing. Check one project with a bare `bun --check`
  in its directory, not `bun check -p`: `bun check` runs the nearest
  `package.json`'s `check` script, and the root's runs the whole repo. In a
  fresh worktree, first `bun install --frozen-lockfile` in
  `packages/bun-common/bench`, `packages/bun-jobs/bench`, `benchmarks/`,
  `templates/compute-provider/` and `tools/vscode-bun-lint/`: without them those projects fail on missing
  modules, and that noise hides real errors in the same projects. Frozen,
  because a plain install re-resolves and rewrites the lock, so the gate would
  check whatever the registry served that day (`CLAUDE.md`, "Dev workflow").
- `bun run lint` (0 errors) and `bun run format:check` (clean) in each
  changed package or examples directory (`bun run lint:scripts` and
  `bun run format:check:scripts` from the root for `scripts/`; `bun run
  format:check` at the root covers the whole repository). The gate since PR E
  of [`bun-lint-fmt`](plans/bun-lint-fmt/README.md); nothing runs ESLint, whose
  `eslint.legacy.config.mjs` files stay until PR F. `bun lint --fix` never
  edits one of the four `scripts/build-declarations.ts` or `tsconfig.build.json`
  copies alone (the same change to all four, or none), and never autofixes
  `@typescript-eslint/no-duplicate-type-constituents` (`CLAUDE.md`, "Lint and
  format"). A branch older than the one-time reformat rebases over it with
  `bun scripts/reformat.ts --resolve` (`CLAUDE.md` has the three steps), not by
  hand; `git config blame.ignoreRevsFile .git-blame-ignore-revs` once per clone.
- `bun run test` in each changed package (it type-checks the tests first,
  `bun test --check`), plus `bun test --randomize` (serial) for bun-jobs-ui
  and `bun run test:seeded` for bun-jobs: 4 serial shards side by side,
  without the database URLs, in an ordinary slot through the heavy-run
  wrapper with a ticket, about 6 minutes (the user's decision, 2026-10-10). bun-jobs' serial `--randomize` run with all
  five URLs is exclusive and runs once per merge window, not per PR. After a
  bun-common change, also bun-nest and bun-jobs;
  after a bun-jobs `api/contract` change, also bun-jobs-ui, whose fixtures and
  tests type against the contract.
- `bun run-all.ts` in each affected `examples/*` directory. A bun-jobs-ui
  change runs both `examples/bun-jobs-ui` and `examples/bun-nest` (whose
  `06-jobs-ui/mount.ts` serves the UI). For bun-jobs, set
  `EXAMPLE_DRIVER` **and** the five `EXAMPLE_*_URL`s (from
  `bun scripts/setup-databases.ts --dry-run`); a URL alone runs on memory, and
  a run without URLs is three short, because three examples sit out.
- **Quote what ran, not what was green.** "78 passed, 3 skipped" is the
  result; "examples green" is not.
- **Negative controls.** A new check is shown to fail: on the base before the
  change, or by mutating the example. A check that cannot fail on its base is
  decoration, and so is example prose that is only true on the branch.

## Sharing the machine

### Heavy runs

Heavy jobs go through the shared wrapper, which admits two at once on an idle
machine and one on a busy one (agreed by all sessions and their users on
2026-10-06; `CLAUDE.md` has the detail):

```bash
HEAVY_TICKET=13-ui-runall /tmp/claude-1000/bun-node-heavy-run.sh \
  timeout 2400 bun run-all.ts > run-all.log 2>&1
HEAVY_TICKET=c0-db-suite HEAVY_EXCLUSIVE=1 /tmp/claude-1000/bun-node-heavy-run.sh \
  timeout 1800 bun run test > suite.log 2>&1
```

- **Never spend turns waiting** (the user's rule, 2026-10-07). Start the job
  with the Bash tool's `run_in_background`, then stop; the completion
  notification wakes you. The wrapper waits in the kernel, so the wait itself
  costs nothing — a `sleep`, a poll or a "still queued" turn costs units.
- **After a usage limit**, re-issue the exact command with the same
  `HEAVY_TICKET`: you get its result, or you attach to it in the line,
  instead of a new place at the back. Its state is in
  `/tmp/claude-1000/bun-node-heavy-jobs/<ticket>.status`.

- **Exclusive** (`HEAVY_EXCLUSIVE=1`): bun-jobs' full suite with database
  URLs, and its serial `--randomize` run with them, once per merge window.
  Its per-PR `bun run test:seeded` removes the URLs and takes a slot.
- **Wrapper:** full suites, every bun-jobs-ui test (DOM and Chrome), the
  bun-jobs and bun-jobs-ui run-alls, `check-types.ts`, benches, and repeat,
  concurrent-copy and load loops.
- **Direct, no wrapper:** lint and format checks in any directory (`bun lint`, `bun fmt --check`), `bun scripts/typecheck.ts`,
  `bun scripts/consumer-check.ts`, every targeted test run in any package
  except bun-jobs-ui (named files, directories or filters, with or without
  database URLs, e.g. `bun test __tests__/summon __tests__/api`), the
  bun-common and bun-nest suites and run-alls, single examples, the template
  test. (The user's rulings, 2026-10-07.)
- Wrap the heavy command, not a script that also installs or sleeps; give it a
  `timeout`; never `flock -o` (it drops the lock while the command runs).
- **The wrapper decides how a job runs from its history** (`HEAVY_MODE=auto`,
  the default since 2026-10-07), from the median wall time and cores of the
  last 10 successful runs of its key:
  - no history, or none with CPU recorded: a slot;
  - median cores at or above `HEAVY_EXCLUSIVE_CORES` (75% of the cores):
    exclusive;
  - median under `HEAVY_DIRECT_SECONDS` (60) and `HEAVY_DIRECT_CORES` (2): at
    once, holding no slot;
  - otherwise a slot, or at once when none is free but it fits: the 1-minute
    load, plus the cores of jobs started in the last minute, plus its own
    median cores is under `HEAVY_MAX_LOAD`, with no exclusive job waiting or
    running.

  `HEAVY_EXCLUSIVE=1` and an explicit `HEAVY_MODE` (`slot`, `exclusive`,
  `direct`) always win. CPU history cannot see the database servers, so the
  bun-jobs DB suite still needs `HEAVY_EXCLUSIVE=1`. The wrapper prints its
  decision on stderr as it starts, e.g.
  `bun-node-heavy-run: auto → slot (median 6m10s, 3.2 cores, n=4)`. A job run
  at once keeps its ticket, records its history and is listed by the queue.
- To see the queue: `/tmp/claude-1000/bun-node-heavy-queue.sh` — every job
  holding or waiting for a slot, its phase (each wrapper records its own),
  how long it has waited, an **EST** column, its session and ticket. Keep
  `/tmp/claude-1000/bun-node-sessions` (`<claude pid> <name>`) current when
  sessions change. A job running with no slot reads `RUNNING (direct)`, and
  each state ends with how the job runs: `[auto→slot]`, `[auto→direct]`,
  `[auto→exclusive]`, or the mode its caller set.
- **EST** is the median of the last 10 successful runs of the same kind of
  job and the median cores they used: `~6m10s, 3.2 cores (n=4)` while it
  waits, `~6m10s, 3.2 cores, ~2m left` or `~6m10s, 3.2 cores, overrun +1m`
  while it runs, `unknown` with no history, and no cores figure while none of
  those runs recorded CPU. Every finished job appends a line to
  `/tmp/claude-1000/bun-node-heavy-history.tsv`: epoch, key, seconds, exit
  status, then CPU seconds of the job's whole process tree, cores (CPU over
  wall), the 1-minute load at start and at end, where it ran (`direct`, a slot
  number or `all`) and the mode asked; lines from before 2026-10-07 have the
  first four fields and still count. The key is the directory
  relative to the git top level, the command without what does not change
  how long it takes (a leading `timeout N` or `nice`, and `--seed`,
  `--randomize` and output paths such as `--log-dir <path>` anywhere, so every
  seed of a suite shares one estimate, wherever it logs), and
  `[exclusive]` and `EXAMPLE_DRIVER` when set, so runs in different worktrees
  share an estimate; `bun-node-heavy-run.sh --key <command>` prints it. The
  queue shows each job's whole command, quoted so it can be pasted back.

#### Where the wrapper comes from

The wrapper and the queue listing are `scripts/heavy-run.sh` and
`scripts/heavy-queue.sh` in this repo, tested by
`scripts/__tests__/heavy-run.test.ts`. Install or refresh the copies in
`/tmp/claude-1000` with:

```bash
bun scripts/install-heavy-run.ts            # --dry-run to see the plan first
```

It renames each file into place, so a job already running keeps the copy it
started with, and keeps the replaced wrapper as `bun-node-heavy-run.prev.sh`.
Run it after any change to those scripts (once merged), and after a reboot
clears `/tmp`. Never edit the installed copies: the next install overwrites
them.

### Processes, data and services

- **Kill by PID only, and only your own.** Never `pkill`/`killall` by
  pattern: peers run the same commands.
- **Delete only the test data your run created** — its exact namespaces,
  never a `LIKE` prefix sweep.
- **Database servers** come from `bun scripts/setup-databases.ts` (containers
  with `--docker`). After a reboot they may be down; re-run it. MariaDB is
  3306 and MySQL 3307.
- **Docker is snap** here: it cannot write `/tmp`, so captured docker output
  can be silently empty — pipe through `| cat`, keep bind mounts out of `/tmp`.
- **`/tmp` can run out of inodes** with space free. When file or SQLite tests
  fail everywhere, check `df -i /tmp`.
- **Clean up after yourself:** Chrome profiles, containers and images by the
  name you gave them, and stop your own background waiters when you no longer
  need them. When the user asks every session to clean up, report what you
  stopped.

## Subagents

A session stays responsive by handing long work to subagents.

- **Delegate** anything long: writing an example set, a suite run, an
  investigation, a review. Several focused agents beat one long one.
- **Disjoint files.** No two agents edit the same file. Give each its own
  worktree when they touch the same package.
- **A progress file per agent**, written before any code and updated after
  each step: plan, done (files, gate results), left, decisions. A design
  agent's decisions go in the file, not only in its report — a report is one
  context compaction away from lost.
- **A scratch subdirectory per agent**, and it deletes only there (a shared
  scratchpad was once wiped by an agent's cleanup).
- **Every brief carries the rules that apply:** don't commit, push or stash;
  kill by PID; the heavy-run wrapper with a ticket, run in the background and
  never polled; negative controls; the progress file path; what to report.
- **Verify a report, don't relay it.** Re-run its key check and read the files
  it says it changed. Reports have claimed gates that never ran.
- **After a usage limit**, audit each agent's on-disk state (worktree, diff,
  last gate) before resuming; finish small work yourself, brief a new agent
  for the rest, and clear dead agents and orphaned worktrees.
- **A subagent refused by the permission system** stops and reports. Do not
  run the refused action yourself on its behalf; ask the user.

## Memory

Each session has a file-based memory under
`~/.claude/projects/-home-kingsloob1-Desktop-projects-mine-bun-node/memory/`,
shared by every session on this project, indexed by `MEMORY.md`. Save there
what the repo cannot tell a future session: user decisions and preferences,
agreements between sessions, measured gotchas, pointers to external issues.
Not code structure, git history or anything already in `CLAUDE.md`. Update a
memory rather than duplicating it; another session may have written the same
fact.

## Plans

Plans live in [`docs/plans/`](plans/README.md), one folder per main plan (the
user's decision, 2026-10-11): `docs/plans/<plan>/README.md` is the main plan,
a sub-plan that helps implement it sits in that folder
(`<plan>/<sub-plan>.md`, or `<plan>/<sub-plan>/README.md` when it has
sub-plans of its own), and evidence goes in `<plan>/evidence/` (a file
sub-plan's under the parent's `evidence/<sub-plan>/`). A new plan starts in
that shape; a follow-up plan goes in the folder of the plan it extends, not
beside it. `docs/plans/README.md` is the index: add the plan, sub-plan or
evidence folder to it in the same change. Moving a plan file changes every
relative link into and out of it, so check them all, `#anchors` included.

## Bun bugs

A reproducible bug in Bun itself (the runtime, `bun test`, the bundler, a Bun
API) is filed on `oven-sh/bun` without asking: search the existing issues
first, reduce it to a single-file reproduction with none of our code, follow
the repo's issue template, and tell the user the URL. A subagent drafts the
issue in its scratch directory; the session reproduces it and files it.
Document the workaround in [`docs/bun-bugs/`](bun-bugs/README.md) and name
the issue where the workaround lives, so it can go when Bun fixes it.

## Starting a new agent

For when the multi-session setup resumes (it was retired on 2026-10-22,
[above](#handoff-2026-10-22-read-this-first)). The user starts a session in this repository and gives it its role. A kickoff
prompt, for the bun-common agent (swap the package for bun-nest):

> You are the **bun-common agent** for bun-node. You own
> `packages/bun-common/**`. Read `CLAUDE.md` and `docs/agentic-setup.md`
> first, then `ListAgents` to find the other sessions and introduce yourself
> to each: your role, the paths you own, and that you will send CHANGE
> REPORTs to the examples agent. Ask the features agent which bun-common work
> it has in flight, and agree who finishes each item. Review every PR that
> touches `packages/bun-common/**`. Follow the commit, PR and merge rules
> exactly: every step is a popup.

For any other role, the main agent fills in the same shape from the role
table:

> You are the **\<role\>** for bun-node. You own \<its paths\>. Read
> `CLAUDE.md` and `docs/agentic-setup.md` first, then `ListAgents` to find
> the other sessions and introduce yourself to each: your role and the paths
> you own. Ask the main agent (the features agent) for your assignment and
> the work you inherit. \<What the role reviews, from the table.\> Follow the
> commit, PR and merge rules exactly: every step is a popup.

On the first day, the new agent:

1. Tells the main agent its role and session name, for the dated roster
   table above; the main agent makes that edit, so the table has one writer.
2. Learns the package's gate: `bun run test`, `bun run lint`, `bun run format:check`,
   `bun run check`, and — for bun-common — the downstream bun-nest and bun-jobs
   checks and the bench guard; for bun-nest, `examples/bun-nest`.
3. Reads its package's open PRs and the memory entries that mention it.

When a session is retired, it hands its in-flight work to its successor in
writing (branches, worktrees, open PRs, owed reports), removes its merged
worktrees, and the roster table is updated.
