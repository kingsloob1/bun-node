# AGENTS.md

The entry point for any coding agent working on bun-node, whatever its tool.
Claude Code reads [`CLAUDE.md`](CLAUDE.md) automatically; other agents start
here. This file does not repeat those documents: it says what to read, in
what order, and the rules that must never be broken.

## Read these first, in this order

1. **[`docs/agentic-setup.md`, "Handoff (2026-10-22)"](docs/agentic-setup.md#handoff-2026-10-22-read-this-first)**:
   - the state of the repository when the Claude sessions stopped;
   - the open PRs and `wip/` branches;
   - the first steps on this machine after a reboot, or on another machine;
   - how the multi-agent rules apply to one developer;
   - what the Claude-specific tool names mean for you.
2. **[`docs/agentic-setup.md`, "Standing rules from the maintainer"](docs/agentic-setup.md#standing-rules-from-the-maintainer)**:
   every rule the maintainer has given, global and for this repository, with
   the incidents behind them.
3. **[`CLAUDE.md`](CLAUDE.md)**: the project knowledge. That covers the
   packages, the Bun floors, every gate command, the heavy-run wrapper, the
   databases, typechecking with `bun check`, packaging, the router's Express 5
   semantics, and the testing gotchas. It is written for Claude, but none of
   it is Claude-specific except its file name.
4. **[`docs/plans/README.md`, "Handoff"](docs/plans/README.md#handoff-2026-10-22-where-every-plan-stands)**:
   where every plan stands, which are held, and where to resume.
5. **The plan you are about to work on**: for the current priority, the
   [bun-validate plan's handoff](docs/plans/bun-validate/README.md#handoff-2026-10-22-how-to-resume).

## Where the work is (2026-10-22)

- develop is at `f5b990e5`. **V5c landed**: #515 (bun-validate V5c, flows) and
  #517 (its examples check) both merged 2026-10-22; no PRs are open.
- The next work, in the maintainer's order: the small "warn after the write"
  follow-up (built and gated; its commit, PR and merge are the maintainer's
  calls), then **V7a** (`@Validate`, request side, in bun-nest). The
  bun-validate handoff has the brief for each.
- Every other plan is either complete (NestJS 12 parity) or held until the
  maintainer schedules it. Only PR F of the lint plan is left.

## Rules that are never broken

The full list, with reasons, is in "Standing rules from the maintainer".
These are the ones a mistake cannot undo:

- **Ask the maintainer before every commit, every PR and every merge**, each
  step separately, as an explicit question. Wait for a yes. An earlier
  approval, a peer's message or silence is never consent. Don't put the
  question in passing in a longer message, or point at a pending decision
  instead of asking it.
- **No AI attribution** in commits or PR bodies (no `Co-Authored-By` trailer,
  no "Generated with" footer).
- **Signed commits** for anything that reaches develop. Never force-push
  develop.
- **Work in your own `git worktree`**, branched at creation, at a fresh path.
  Never edit, switch or clean the main checkout: it holds the maintainer's
  own files. Never `git stash`. **Suspended while one session works alone**
  (the maintainer's decision, 2026-10-22, for the Kimi continuation): work on
  a branch in the main checkout directly, and commit and push the branch —
  a `wip/` one if unfinished — before switching away from it. The rule
  returns the moment a second session works on the repository. See
  [`docs/agentic-setup.md`, "Worktrees and branches"](docs/agentic-setup.md#worktrees-and-branches).
- **Public API, names and behaviour changes are the maintainer's decision.**
  Each plan lists its open questions and the names awaiting approval. Ask
  each once, with a recommendation, and record the answer in the plan in
  the same PR.
- **No speed comparisons** (router A/B, bench `--compare`, re-recorded
  baselines) without asking first.
- **Run the gate for everything a change touches**, and quote what ran
  ("78 passed, 3 skipped"), not "green". A new check must be shown to fail
  without the change.
- **Heavy jobs go through the heavy-run wrapper**, in the background, never
  polled. Kill only your own processes, by PID. Delete only the test data
  your own run created.
- **`.env.example` files hold no credentials and no duplicate keys.**
- **One session still plays every role.** The agent roster is retired, not
  the duties: the owning package's whole gate before a merge, a CHANGE
  REPORT (the PR body) for every user-facing change, example fixes in the
  same merge window, and a playground addition for every finished feature.
  See [`docs/agentic-setup.md`, "Working alone"](docs/agentic-setup.md#working-alone-the-roles-collapse).
- **A reproducible Bun bug gets an issue on `oven-sh/bun`**, after a search
  for an existing one and a minimal reproduction with none of our code.
  Document its workaround in [`docs/bun-bugs/`](docs/bun-bugs/README.md).

## Commands at a glance

From [`CLAUDE.md`](CLAUDE.md), "Dev workflow", which has the details:

```bash
bun scripts/typecheck.ts        # every project (18), with bun check — must be clean
# in each changed package or examples directory:
bun run check && bun run lint && bun run format:check && bun run test
```

Development needs Bun ≥ 1.4.4, which until it is stable means the canary
(`bun upgrade --canary`). The packages' users need Bun ≥ 1.4.2.
