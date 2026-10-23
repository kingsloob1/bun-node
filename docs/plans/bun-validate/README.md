# BunValidate: one validation contract for HTTP, Nest, WebSockets, SSE, jobs and any transport

An audit of what `BunValidate` does today, and a plan to make it complete and
transport-agnostic. The user asked for the audit on 2026-10-15:

> "I need to know if bun validate currently types and validates the response
> from each endpoint and also the helper decorator for the full bun validate
> decorator, interceptor, pipelines etc. I also want the plan to contain how
> bun validate feeds into websocket, bun jobs, bun cache and the typed route.
> If not prepare a plan to implement this."

and set the full scope on 2026-10-17, in these words:

> "robustness and features to be complete with cookies, header, response body
> and status validation and full typing"
>
> "the nest js bun validate implementation with body, query, header, cookie and
> response body and status validation and typing"
>
> "built to support future typed client and open api doc generation"
>
> "built in such a way that it is usable for other validations such as bun
> websocket, bun queue data and response, bun queue flow, grpc, message brokers
> (apache kafka, rabbitMQ, amqp), sse for both http adapter, udp etc."
>
> "The bun validate for response can validate even response headers and the
> response body. It shouldnt be for only json body."

with the order: **(1)** full NestJS 12 support (the
[nestjs-12-parity plan](../nestjs-12-parity/README.md), built first by the
Nest agent); **(2)** BunValidate made robust and complete; **(3)** BunValidate's
NestJS implementation.

So this document has two halves: **Part A** answers the 2026-10-15 questions
with evidence (§2), and **Part B** designs the whole of the 2026-10-17 scope
(§4 to §9). Part A is unchanged from the first version apart from §2.9, which
adds what the revision measured, and §2.3's "planned fix" column.

First written 2026-10-15 against `develop` at `73bf4a00`; **revised
2026-10-17 against `68023d36`**. **No product code was changed.** Every
`file:line` is relative to `packages/` unless it says otherwise; Part A's are
at `73bf4a00`, the revision's at `68023d36`. Measurements ran on the installed
Bun, 1.4.4-canary.1; the repo's floor is 1.4.3. The evidence is in
[`evidence/`](evidence/README.md), and each measurement there re-runs with one
command.

### Status (2026-10-22)

**Paused for a handoff on 2026-10-22** (the user's decision): every agent
stopped, and development continues with another model. Read
[Handoff (2026-10-22)](#handoff-2026-10-22-how-to-resume) below before
anything else in this plan: it lists what merged, what is open, the decisions
not yet written into §8, and the next PR's brief.

| Part | State |
|---|---|
| This plan | **revised to the user's 2026-10-17 scope**. The eight ★ questions in §8 are **answered** (2026-10-17, each as recommended); the rest are asked before the PR each gates. Group 1 started once the whole [nestjs-12-parity](../nestjs-12-parity/README.md) plan had merged (the user's decision, 2026-10-17) |
| Group 1 (§6): V0, V1, V2, V3a, V3b | **merged 2026-10-21**: V0 #463, V1 #470, V2 #477, V3a #482, V3b #484 (bun-common; examples beside each) |
| Group 1: **V3c**, response variants (§4.4.6) | **merged 2026-10-21**, #495 (bun-common; examples #496). Added 2026-10-21 (the user's decision: group 1 includes V3c, before group 2); planned and spiked ([`evidence/response-variants/`](evidence/response-variants/README.md)); its questions are Q-H15–Q-H31: all answered 2026-10-21 (Q-H17 and Q-H18 changed by the user: an async `when`, and `.variant()` adjusting the response) and its names approved. Two measured departures from §4.4.6's table: `validate()`'s `RS` constraint is `ResponseSchemas<InferValidatedShape<S>>`, without `H` (with `H` in it TypeScript cannot infer `variants()`'s request view, so `when` is typed by the schemas' outputs, not a `transform` hook's result); and a plain status's `refine` written inline with an inferred parameter needs `satisfies Refine` (a context-sensitive function in `responses` fixes `RS` to its default) |
| Group 2: **V6**, the Nest pipes and filter (§4.5.3, §4.5.5) | **merged 2026-10-21**, #501 (bun-nest, with its review fixes: the `rpc` filter, `stripProtoKeys: "nest" \| "minimal"` in `validateStandard`, which strips only when given a rule, and `gatewayPipes()`; examples #503): `StandardSchemaPipe`, `SchemaDto`, `StandardValidationPipe`, `ValidationExceptionFilter`, `StandardValidationModule` (Q7 and Q8 answered by the user 2026-10-21, as recommended); the pipes take `validate()`'s `messages` and `redactPaths`; tested on Nest 12 and in the 11.2.7 column, with expressCompat groups against platform-express and, on 12, against Nest's own `StandardSchemaValidationPipe` |
| Follow-up: **V13**, the `"parse"` response mode (Q5) | **built 2026-10-23, PR pending** (bun-common and bun-nest; examples beside it). Its spelling, answered 2026-10-23 (the user's decision): a separate option **`responseOutput: "as-sent" \| "parsed"`** (default `"as-sent"`), not a fourth mode — composing with every policy. As built: on `validate()`'s options, `BunRouter`, both adapters (bun-nest's through its `router` option) and `@Validate`'s `ValidateSchemas`; under `"off"` a passing body is still parsed (Q-H29's reasoning: the author asked for the output); a failing one is per the mode; only buffered JSON-classed bodies (streams, text, bytes-as-such and files are out); under variants, the matched variant's output. On bun-nest, a plain `@Res()` response is checked as sent (the before-write hook passes or refuses, never replaces). The type `ResponseOutputMode` is exported from bun-common's root |
| The transport-agnostic core (§4.1) | spiked: [`evidence/contract-core/`](evidence/contract-core/README.md), with a UDP and an in-process broker adapter, 24 type controls shown to fire |
| HTTP completeness: cookies, typed headers, responses of every body kind (§4.3, §4.4) | spiked as a patch on a copy of bun-common: [`evidence/http-complete/`](evidence/http-complete/README.md), H1–H52 at runtime, 18 type controls shown to fire, cost per body kind |
| NestJS (§4.5) | designed with the Nest agent (bun-node-15); waits on nestjs-12-parity PR-2, PR-3, PR-5, PR-6a and PR-6c (§6); bun-node-15 reviewed §4.5 with a probe on Nest 11 and 12 (`evidence/nest-interceptor/`) |
| bun-jobs data, results and flows (§4.8) | designed with the Jobs & Telemetry agent (bun-node-e9), from its survey of the code; e9 builds it |
| **V4**, bun-jobs alignment (§4.8.5, §4.12 M5 and m11) | **merged 2026-10-21**, #502 (bun-jobs; examples beside it, #504). `s` carries `~standard.jsonSchema` (`draft-2020-12` and `draft-07`; any other target throws), its input built through the documents' `toJsonSchema`, so `s.documented` keywords and named `$defs` are included; a defaulted key is optional on input and required in output, in the types too. `validateResponses` takes `"off" \| "warn" \| "error"` (`true` is `"warn"`), checked with `validateStandard` and refused with `ResponseValidationError`, rather than through bun-common's gate (the API's `default` problem response has no place there, m8). Every route's terminal layer carries its full contract through `forwardContract` (87 of 87 routes, tested against the OpenAPI document). Of the issue-flattening copies, `define.ts`'s adopted `validateStandard`; `remote/schemas.ts` and `provider/configure.ts` keep theirs, as the scrub was then broader than the issue's path |
| **V5a**, job data and results (§4.8.1–§4.8.4, flows excepted) | **merged 2026-10-21**, #507 (bun-jobs; examples #510); Q-J1–Q-J3 answered and its names approved the same day |
| **V5c**, flows (§4.8.2's `addFlow` and flows-route rows, §4.8.4) | **merged 2026-10-22**, #515 (bun-jobs; the examples for V5c merged as #516, and its examples fix #517 merged into #515's branch first): `addFlow`'s pre-write pass over every node (its own queue's checks; other queues' where the process can see them), the flows route's 400 `VALIDATION` at body paths, typed `getChildrenValues()` through `FlowChildrenValues` and a job map entry's `children`, `optional` (Q-C9). `recordOf` not used: children are keyed `queue:id`, and the parent needs no second check. Also `6aa72631`: in `addBulk` and `addFlow`, a `"warn"` entry's "written anyway" warning waits until every entry's check has passed; since the follow-up of 2026-10-22 it is logged only **after the write succeeds**, in `add`, `addBulk` and `addFlow` alike. Its names approved 2026-10-21 (§9) |
| Group 2: **V7a**, `@Validate` request side | **merged 2026-10-22**, #522 (bun-nest; the example beside it): `@Validate` (method/class, merged per part) checks every part before Nest's pipes, writes parsed parts back in place (headers excepted) and onto `req.valid`; `@Validated(part)` plus the six aliases read it. The skip rule composes with Nest 12 exactly as §4.5.1 and a9's conditions say: whole-part `{ schema }` only, the pipe from any of the four sources, capability-read, never a version; Nest 11 never skips; RAW_BODY is never `body`. `StandardValidationException` is generic in its target union (defaults unchanged). Q-N1–Q-N4 answered 2026-10-21 (§8.4) |
| Group 2: **V7b**, `@Validate` responses | **built 2026-10-22, PR pending** (bun-common and bun-nest; the example beside it): bun-common's `createResponseChecker` (the commit gate's engine outside the router, the gate's host retyped to the structural `ResponseGateRequest`) and the eight response-typing types exported; bun-nest's `@Validate({ responses, responseValidation })` checked in the interceptor's `map()`/`catchError` (status, `@Header()` headers, returned body, thrown non-2xx), `reply(status, body, { headers, variant })` typed per status, plain `@Res()`/`StreamableFile`/redirects through the before-write hook, `@Sse()` per event in order (`concatMap` — a synchronous burst once skipped the checks), variants, `ResponseValidationInterceptor` (global, default `"error"`). Its two questions answered 2026-10-22 (below) |
| Follow-ups of group 1, merged 2026-10-21 | `messages` and `redactPaths` as `validate()` options #486 (#487); `close()` drains, `drainAndStop`, `closeDrainTimeout` #488 (#491), bun-nest on it #493; socket-free `fetch()` frames a body as a client does #489 (#490); HEAD on a GET route on the fast path #494; `getPort()` retry #497; `fresh()` an exact port of fresh 2.0.0 #498 (#499); the scrub scoped to the issue's path #505 (#506); a thenable schema result is async, scrub keys at the path #511 (#512); bun-jobs' remote and provider issue messages pinned #509; the API's old-spelling hint survives the scrub #500 |
| OpenAPI, AsyncAPI, typed client ([`api-docs-generation/`](../api-docs-generation/README.md) "AD", [`typed-client/`](../typed-client/README.md) "TC") | plan only; §4.11 says what they read from this plan's runtime metadata; reviewed against TC by bun-node-99, and its findings are requirements of the PRs they name (§4.12) |
| Validate-on-read for caches ([`bun-cache/`](../bun-cache/README.md), "BC" §3.13) | plan only; uses this plan's core |

### Handoff (2026-10-22): how to resume

Written by the main agent when the user stopped every agent so that another
model could continue. Nothing of this plan is in flight: no agent, no
uncommitted work, no queued heavy run. All of it is on GitHub, as merged PRs,
two open PRs, or the decisions below. The working rules (consent popups,
signed commits, gates, the heavy-run wrapper) are in
[`docs/agentic-setup.md`](../../agentic-setup.md), "Handoff" and "Standing
rules from the maintainer"; read them first.

**develop** is at `bc2b1a5f` (#501). Merged: group 1 entire (V0 #463, V1
#470, V2 #477, V3a #482, V3b #484, V3c #495) and its follow-ups, group 2's V6
(#501), group 3's V4 (#502) and V5a (#507). The Status table above lists
each, with its examples PR.

#### Open PRs

| PR | Branch, head | What | State |
|---|---|---|---|
| **#515** | `feat/bun-validate-v5c-flows`, `d4046e65` | **V5c**, flows: `addFlow`'s pre-write pass, the flows route's 400 `VALIDATION` at body paths, typed `getChildrenValues()` (`FlowChildrenValues`, `JobChildrenOf`, `TChildren`, per-child `optional`), and `6aa72631`: in `addBulk` and `addFlow`, a `"warn"` entry's "written anyway" warning waits until **every entry's check has passed**, so a bulk or flow another entry refuses warns nothing (it is still logged before the write, not after it: an open follow-up, below) | gated on develop `666ad4b5` (the PR body has every figure: 1723 pass / 0 fail targeted with all five database URLs, `test:seeded` passed, 18 projects clean, consumer-check 160/160, lint and format clean, 5 negative controls). **Approved** by the bun-common agent (the plan's lead), including its re-review of `6aa72631`. The seeded re-run after `6aa72631` exited 0 but its log was not kept, so the re-gate below is not optional. Q-C9 and its names were approved by the user on 2026-10-21. The bench `--compare` it was allowed failed 7 rows, which the user **accepted on the code evidence** (the PR body says why). **Now conflicting with develop**, in this file only (below) |
| **#517** | `examples/v5c-warn-refused`, `c3dc87c2` | the examples check for `6aa72631`: a refused flow holding a `"warn"` node logs no "written anyway" warning (`examples/bun-jobs/03-job-registry/validating-flows.ts`) | its base is #515's branch, not develop; gated on `d4046e65` (30/30 on memory ×3, postgres, redis, sqlite), with a negative control on `3a96f61c` |

**To land them**, in this order, each step asked of the user separately
(commit, PR, merge):

1. Merge #517 into `feat/bun-validate-v5c-flows` (it is the examples fix
   stacked on the feature branch, [Merge order](../../agentic-setup.md#merge-order)).
2. Rebase `feat/bun-validate-v5c-flows` onto `origin/develop`. The one
   conflict is this README's Status table: keep develop's table (it already
   has a V5c row, from the handoff) and set that row to **merged** with #515's
   number; keep #515's own edits to Q-C9 (§8.2) and its V5c paragraph in §9.
   No code file conflicts (`git merge-tree --write-tree origin/develop
   origin/feat/bun-validate-v5c-flows` names only this file).
3. Re-gate the rebased head, in a **fresh** worktree:
   - `bun install` at the root, then `bun install --frozen-lockfile` in
     `packages/bun-common/bench`, `packages/bun-jobs/bench`, `benchmarks/`,
     `templates/compute-provider/` and `tools/vscode-bun-lint/`;
   - `bun scripts/typecheck.ts` (18 projects);
   - in `packages/bun-jobs`: `bun run check`, `bun run lint`,
     `bun run format:check`; the targeted run with all five
     `BUN_JOBS_TEST_*_URL`s (`bun test job-schema flow typed-registry
     job-ids job-fail fix-mongo fix-redis-slots mongo-driver __tests__/api
     __tests__/remote`, path filters, the set #515 ran); and
     `bun run test:seeded` through the heavy-run wrapper (CLAUDE.md, "Tests
     run in parallel");
   - `bun scripts/consumer-check.ts packages/bun-jobs` (160/160 before);
   - `examples/bun-jobs`: `03-job-registry/validating-flows.ts` on memory and
     one server (`EXAMPLE_DRIVER` **and** the URL), then `bun run-all.ts` for
     the merge window.
   - **No bench run**: the one allowed is spent, and the user's rule is no
     speed comparisons without asking.
4. Optionally refresh `bun-timings.json` and `bun-timings.seeded.json`
   (`bun run test:timings`, `bun run test:seeded --update-timings`): V5c's
   new test file, `job-schema-flows.test.ts`, and V5a's have no entries
   (`flowChildren.type-test.ts` is checked by `bun run check`, never run), which costs scheduling only.
   Commit the refresh with the change that made it stale, or on its own.
   Tests known to flake under load (not V5c's): local-compute's "kills a unit
   at its lifetime" and "localCompute conforms on redis", and
   `createTicker`'s interval. Re-run on a quiet machine before blaming a
   change.
5. Merge with `--match-head-commit`, confirm `MERGED`, then delete the
   branches (local and remote) and the stopped agents' worktrees
   `../bun-node-v5c-a0` and `../bun-node-v5c-check-74` (both clean, at the PR
   heads; nothing in them is not on GitHub).

**Left open by V5c** (from #515's review section; none blocks the merge):
a bare `BunQueueWorker`'s processor is not typed for children (`TChildren` is
not on it; the bun-jobs agent's next item after the warning fix below); a refused flow reports its first failing node only, as `addBulk`
does (V5b's question, below); a registry node on a registry queue this process
has not created is checked under the default `"error"` policy; `flowPath` is in
the error's `context`, not its message; `optional` is types-only and the flows
route body does not accept it; and the playground has no V5c addition yet
(the user's rule: every feature reaches the playground).

**Owed right after V5c, as its own small PR** (agreed in #515's review by the
bun-jobs and bun-common agents): log a `"warn"` entry's "written anyway"
warning **after the write succeeds**, in `add`, `addBulk` and `addFlow`
alike. ✅ **Landed 2026-10-22**: the check helpers (`#checkData`, `#checkBulk`,
`#checkFlow`) collect a `"warn"` outcome's warning instead of logging it, and
each caller logs the collected warnings only after its write has succeeded —
a refused entry or a failed write (a driver error) warns nothing. `update()`
and `Job.updateData()` were out of the agreed scope and still log before
their write. The wording "written anyway" is unchanged: the examples
(`examples/bun-jobs/03-job-registry/validating-flows.ts` and the V5a ones)
match it.

#### Decisions taken but not yet recorded elsewhere

- **Q-N1–Q-N4**, answered by the user on 2026-10-21 and now written into §8.4:
  compose with Nest 12's schema options; a `reply()` helper (V7b);
  `@Validated(part)` **plus** six per-part aliases; keep the name `@Validate`.
- **The Nest agent's review conditions for V7a's skip rule** (bun-node-a9,
  2026-10-21), binding on V7a:
  - detect a `StandardSchemaValidationPipe` from **all four** sources
    (global, through `useGlobalPipes` or `APP_PIPE`; controller; method;
    parameter), gated on a capability read once (a prototype member, an enum
    key, or `@nestjs/core/internal` through `createRequire`), never on a
    version string, each source with its own test;
  - when detection is unreliable, **do not skip**; check the part;
  - **Nest 11 never skips**, proved on the 11.1.20 and 11.2.7 matrix
    columns;
  - `@Body("field", { schema })` and a keyed `@Query("page", { schema })`
    cover one key, so they never skip the whole part.
- **The rules for any bun-nest PR of group 2** (a9's, the same day):
  - both Nest majors (`^11.1.20 || ^12.0.0`): no `override` of a member
    Nest 11 lacks; Nest types used structurally;
  - Nest 12's native schema pieces get a capability gate and either a Nest 11
    path or a clear "needs Nest 12" error, with tests on both columns;
  - param decorators are applied by call in tests,
    `Inject(TOKEN)(target, undefined, 0)`, because Bun drops decorators that
    the cwd's tsconfig does not enable (oven-sh/bun#28605);
  - child-process Nest fixtures set their cwd to `packages/bun-nest`;
  - deep imports carry `.js`; bun-common is imported from its root only;
  - every new export goes in `lib/index.ts` and `consumer-check.json`;
  - responses go through PR-6c's before-write hook
    (`addBeforeWriteHook(ctx)` returns a remover):
    - `ctx.phase` is `"response"` or `"error"`, and under `"error"`
      `ctx.response` is undefined;
    - `ctx.body.kind` is one of `json`, `text`, `buffer`, `stream`, `file`,
      `blob`, `empty`;
    - a throw refuses the response, and a fresh 500 goes through Nest's
      filters with CORS kept;
    - a returned promise holds the write, capped by the request timeout;
    - variants and `@Res()` go through the same hook.
  - **The gate per PR:**
    - in bun-nest: `bun run check`, `bun run lint`, `bun run format:check`,
      `bun run test`, and a `bun test --randomize --seed=N`;
    - `bun scripts/typecheck.ts`;
    - `examples/bun-nest`'s `bun run-all.ts`;
    - consumer-check, 66/66 plus the new cells;
    - `scripts/nest-matrix.ts --run 11.2.7`, and for V7a also 11.1.20 and
      12.0.0;
    - expressCompat and routingCompat green, with new probes against
      platform-express;
    - no speed A/B.
- **V7a's example lives at `examples/bun-nest/07-validation/validate-decorator.ts`**
  (agreed by the bun-common and examples agents), not the `08-validate/` the
  plan once named.
- **V5b's question, still to be put to the user**: when a flow is refused
  through the API, collect every failing node's issues into one 400, as
  `ruleIssues` does? The bun-common agent recommends **yes**.
- **V7b's questions, answered by the user on 2026-10-22**: (1) root exports
  from bun-common of `InferResponses`, `VariantNames`, `NarrowVariant`,
  `DeclaredAbsent`, `ResponseTypeMap`, `JsonBodyFor`, `SendBodyFor` and
  `AllowedStatus` — **approved**, and bun-nest's `reply()` is typed with them
  (`Pick` narrows per status; nothing else needed exporting). (2) How V7b
  checks responses on the Nest side — **a purpose-built checker exported
  from bun-common's root**, rather than bun-nest duplicating the commit
  gate's engine; built as `createResponseChecker(responses, options)` over
  `ResponseContractGate` (the gate's first parameter retyped to a structural
  `ResponseGateRequest`: it only ever read `res.req`).

#### What comes next, in the user's order

1. **Finish V5c** (above). Independent of group 2.
2. **V7a**, `@Validate` request side (§6 row 7, §4.5.1, §4.5.2). Its
   dependencies have all merged (V2, V6, nestjs-12-parity PR-3 and PR-5).
   Built in bun-nest under the rules above. Its names are approved through
   Q-N3 and Q-N4: `@Validate`, `@Validated(part)`, `@ValidBody()`,
   `@ValidQuery()`, `@ValidParams()`, `@ValidHeaders()`, `@ValidCookies()`,
   `@ValidSignedCookies()`; no `@Cookies()` of ours. Record them in §9 in
   the PR. CHANGE REPORT (the list of what changed for users) in the PR body,
   and the example above in the same merge window.
3. **V7b**, `@Validate` responses (§6 row 8): ask the exports question
   first; `reply(status, body, { headers })` (Q-N2), `@Sse`, variants, and
   `@Res()` through the before-write hook.
4. **V13**, the `"parse"` response mode (§6 row 8a): not designed beyond its
   row; its open points are listed there.
5. **Group 3, after group 2** unless the user reorders: V8 (WebSocket
   channels), V9 (Nest gateways), V11 (SSE, inside
   [bun-native-routes](../bun-native-routes/README.md)' PR-sse2, which has
   not started), V5b (after V12's converter, with the question above), V10
   (inside bun-cache's core PR, which has not started).
6. **Group 4**: AD (b0), V12, AD (e).

**Speed comparisons**: none without asking the user first (their rule,
2026-10-20). V3a's router A/B and V5a/V5c's one bench run each were asked for
and granted; no standing permission remains.

#### Small bun-common follow-ups (none started)

- A lazy empty-body settle for a non-GET request with `Content-Length: 0`
  (socket-free and served), from #489.
- Raise the timeouts of tests that fail under load: the compression flush and
  SSE test, RouteTree's 5 s differential test, and the async-control
  example's timing.
- `fresh()` and `If-None-Match: *`: #498 shipped the zero-cost subset (the
  user's choice). A GET with no headers set still answers 200 on the fast path
  where Express answers 304 (18 cells, documented in the README). A patch for
  the fast path exists only on the old machine
  (`~/.cache/bun-node-11/followups/inm/scratch/fastpath.patch`); it is not
  needed unless the user asks for that case.

The stopped agents' notes, which this section copies from, stay on the old
machine only: `~/.cache/bun-node-11/validate-g1/decisions.md`,
`~/.cache/bun-node-11/validate-g1/group2-a9-rules.md` and
`~/.cache/bun-node-e9/validate/v5c/PROGRESS.md`.

### Contents

0. [Why this is a main plan](#0-why-this-is-a-main-plan)
1. [Executive summary](#1-executive-summary)
2. [Part A: the audit](#2-part-a-the-audit)
3. [What other plans already decide](#3-what-other-plans-already-decide)
4. [Part B: the design](#4-part-b-the-design)
5. [Tests](#5-tests)
6. [PR slicing, effort and owners](#6-pr-slicing-effort-and-owners)
7. [Risks](#7-risks)
8. [Open questions for the user](#8-open-questions-for-the-user)
9. [Names needing approval](#9-names-needing-approval)
10. [Evidence](#10-evidence)

### How to read the markings

- **[M]** measured here, by a file in [`evidence/`](evidence/README.md),
  named in the bracket.
- **[S]** read from source.
- **[P]** decided in another plan, cited; not restated.
- **[A]** agreed with the owning agent (bun-node-15 for bun-nest, bun-node-e9
  for bun-jobs), on 2026-10-17.
- **[D]** designed here.
- **[I]** inferred and not run; a PR must prove it.

---

## 0. Why this is a main plan

The folder rule puts a follow-up inside the plan it extends. This is not a
follow-up of one plan:

- **Five plans each own a slice of validation and none owns validation.** AD
  puts responses on the validator to document them; TC reads them to type a
  client; NTR ([`typed-client/nest-typed-routes.md`](../typed-client/nest-typed-routes.md))
  and NJD ([`nest-jobs-decorators/`](../nest-jobs-decorators/README.md)) each
  plan a `StandardSchemaPipe` (the same name, two designs) and each asks
  bun-common for a shared helper under a different name; BC plans a `validate`
  option on caches. Someone has to say which of these is the one.
- **The user's scope is transport-agnostic.** HTTP is one of a dozen places a
  schema checks a message: WebSockets, SSE on both adapters, job data, results
  and flows, and gRPC, Kafka, RabbitMQ/AMQP and UDP, for which no package
  exists yet. One contract has to serve all of them, so it cannot live inside
  any one consumer plan.
- **The audit found three defects and two gaps in what exists** (§2.3), which
  belong to BunValidate, not to any consumer plan.

So this is the hub: it designs the one core every transport plugs into (§4.1,
§4.2), applies it transport by transport (§4.3 to §4.10), **adopts** AD's
`@Validate` and TC's `defineChannel` designs by reference and corrects them
where a re-run disagreed (§3), and gives one PR order across all of it (§6).

### 0.1 What changed in the 2026-10-17 revision

| Before | Now | Why |
|---|---|---|
| An HTTP validator with add-ons for other places | **one transport-agnostic contract** (§4.1): parts → schemas, one runner, one issue shape, one policy, types derived from it, schemas readable at runtime | the user's scope (§0) |
| Headers validate-only (old Q9) | **typed**, on a new `req.valid` view; never written back | the user; writing back breaks busboy, `type-is` and `accepts` [M `http-complete` Q2] |
| Cookies "later, on demand" (old Q10) | **`cookies` and `signedCookies` targets**, validated, written back, typed | the user; a forged unsigned cookie passes a `cookies` schema, so signatures need their own target [M H49–H51] |
| Responses optional, JSON bodies only, streams excluded | **per status: status, headers, cookies, and a body of every kind**, keyed by media type; an undeclared status is a failure; streams per chunk, SSE per event | the user |
| One hook moved before `json()` builds the `Response` | **one commit gate in `BunResponse`'s single `set response` setter** that every producer goes through, plus a chunk gate for streams | re-measured at `68023d36` [M `http-complete`] |
| Nest: `@Validate` adopted from AD | **`@Validate` composing with Nest 12's own Standard Schema pipes**, on Nest 11 and 12, with response checks in the interceptor (it sees the final status and `@Header()` headers, measured) plus a before-write hook PR-6c adds for redirects, files and `@Res()` | Nest 12.0 added `StandardSchemaValidationPipe` and `@Body({ schema })`; bun-nest supports 11 and 12 [A] |
| Job data and results | **plus flows, and every other write of job data**, checks living in `BunQueue` | e9's survey: enqueue bypasses the definitions today [A] |
| — | **an extension point for future transports**, proven by two spike adapters | the user |
| PRs ordered by dependency | **re-sliced in the user's order**: core + HTTP, then Nest, then other transports, then client/docs hooks (§6) | the user |

---

## 1. Executive summary

### 1.1 The answer

Unchanged from the first version: **no, BunValidate neither types nor
validates responses**, on any endpoint, on either adapter. **The request side
is solid**: any Standard Schema vendor, four targets, typed handlers through
the generated overloads, three failure modes. **bun-nest has no validation
piece at all**: no decorator, pipe, interceptor or filter; users hand-write a
pipe today. **Nothing feeds WebSockets, job data or caches.** The one place
in the repo that already validates responses is bun-jobs' management API,
which logs a mismatch and nothing more.

| # | Question | Answer | Key evidence |
|---|---|---|---|
| A1 | Response validated at runtime? | **No** | a body breaking a declared schema goes out `200` [M `R1`]; no response target (`bun-common/lib/BunValidate.ts:9`); bun-jobs' API alone checks, and only logs (`bun-jobs/lib/api/routes/define.ts:289-297`) |
| A2 | Response typed? | **No** | `res` is a bare `BunResponse` in every typed handler (`bun-common/lib/types/general.ts:447-458`); `res.status(418).json({ anything })` compiles after a validator; a `responses` option is TS2353 [M `T2`–`T4`, `T9`] |
| A3 | Request side | **Yes, with 3 defects** | targets `params`/`query`/`body`/`headers`; output-typed `req.*`; but an explicit `status: undefined` answers a failed request **200** [M `R2h`], a `cookies` schema is silently ignored [M `R5`, `T7`], headers are validated but never typed [M `T6`] |
| A4 | bun-nest decorator, pipe, interceptor, filter | **No** | `bun-nest/lib/decorators.ts` is one re-export line; `interceptors.ts` is multipart only (`:182-321`); the examples hand-rolled a `SchemaPipe` (`examples/bun-nest/02-http-adapter/pipeline.ts:137-160` at ab01c57a; since #503 the example uses V6's `StandardSchemaPipe`, `packages/bun-nest/lib/validation.ts`) |
| A5 | WebSocket messages | **No** | messages are `string \| Buffer` (`bun-common/lib/BunWebSocket.ts:393-411`) [M `T10`]; bun-nest casts parsed JSON (`bun-nest/lib/BunWebSocketAdapter.ts:962-964`) |
| A6 | bun-jobs data and results | **No** | typed by type arguments only; `{ to: 42 }` reached a `BunQueue<{ to: string }>` worker [M `R8`]; `define()` has no schema option [M `T11`]. `s` **is** a Standard Schema [M `R7`] |
| A7 | bun cache | **No code**; BC plans `validate` on read | BC §3.13 |
| A8 | Typed routes, client, OpenAPI | **Request shapes yes; responses no; OpenAPI no** | the phantom `__shape` carries request shapes only (`bun-common/lib/types/routeTyping.ts:88-95`); a validator's schemas are unreachable at runtime [M `R9`] |

### 1.2 The decisions

| # | Decision | Why |
|---|---|---|
| V-D1 | **Standard Schema V1 is the one schema contract** everywhere; its JSON Schema companion (`StandardJSONSchemaV1`, AD (b0)) is the one route to documents. No vendor dependency anywhere. | It already is the contract in bun-common, bun-jobs' providers and bun-jobs' `s` [S, §2.6]. |
| V-D2 | **One transport-agnostic core in bun-common** (§4.1): a transport declares its **parts** and its **key** (`defineTransport`); a **contract** maps parts to schemas on an inbound and an outbound side; **one runner** (`validateStandard`) answers synchronously when the vendor does; **one issue shape**; **one policy**, `"off" \| "warn" \| "error"`; types derive from the contract; the contract is readable at runtime (`getContract`, `describeContract`). | Spiked: HTTP, WebSocket, SSE, jobs with flows, Kafka, gRPC, UDP and a broker each declare in 3–5 lines; 24 type controls fire [M `contract-core`]. |
| V-D3 | **Three rules hold in every transport**: an issue never carries the received value; a part with no schema costs nothing (synchronous, no allocation); one optional `onIssues` hook, free when unset, feeds telemetry. | Agreed with e9 [A]. Measured: the vendors' own messages leak values (valibot, arktype, yup, zod) and the core scrubs them; the no-schema path retains 0 objects over 100,000 messages; the hook costs nothing measurable [M `contract-core` C11–C17]. |
| V-D4 | **HTTP requests**: targets `params`, `query`, `headers`, `cookies`, `signedCookies`, `body`; every parsed part also lands on a typed **`req.valid`**; headers are **never** written back. | Replacing `req.headers` broke busboy, `type-is` and `accepts` and reverted on `setHeader`; `req.valid` broke nothing [M `http-complete` Q2, H46]. Signed cookies need their own target [M H49–H51]. |
| V-D5 | **HTTP responses**: per status, `headers`, `cookies` and a `content` map from media type to body schema (or `null`, `chunks(S)`, `sse({...})`, `opaque()`); an undeclared status, media type, header or cookie is a mismatch. | The user. OpenAPI's own shape (`content: { "application/json": … }`). |
| V-D6 | **One commit gate** in `BunResponse`'s `set response` setter, which every producer passes through, checks status, headers, cookies, media type and a buffered body **before** the response is handed on; a **chunk gate** checks each streamed chunk or SSE event. | Re-measured at `68023d36`: `json()`, text, bytes, `Blob`, `send(Response)`, `redirect`, `sendFile` and the first `write()` all commit there [M `http-complete`]. |
| V-D7 | **Policy on a response**: `"off"` installs no gate; `"warn"` sends and logs once, never holding; `"error"` makes a mismatch a `ResponseValidationError` (500) through the error pipeline, **holding** the commit while an async vendor settles; after a body has started it can only cut the stream off and log. Default `"off"`. | Measured for every body kind × mode × a sync and an async vendor (H1–H24) [M]. |
| V-D8 | **Response typing**: `status()` narrows to declared statuses; `json()`, `send()`, `set()`, `header()`, `cookie()` and `redirect()` take what that status declares; the server is held to the schema's **input**, or its **output** when the input is `unknown`, **field by field** (`WireInput`, §4.1.4). The generated overloads stay byte-identical. | 18 controls fire; `generate-verb-overloads --check` up to date [M `http-complete`]; the input/output rule from the first version [M `response-typing/`]. |
| V-D9 | **bun-nest**: `@Validate({ params, query, headers, cookies, body, responses })`, an interceptor, **composes** with Nest 12's `@Body({ schema })` and `StandardSchemaSerializerInterceptor` instead of replacing them, and does everything itself on Nest 11; `SchemaDto(S)` types parameters; one generic `@Validated(part)` parameter decorator (no `@Cookies()` of ours: Nest 12.1 has one); responses checked in the interceptor's `map()`/`catchError`, which see the final status and `@Header()` headers, plus PR-6c's before-write hook (name TBD) for redirects, `StreamableFile` and plain `@Res()`. | Agreed with bun-node-15 [A]; `SchemaDto` measured [M `nest-schema-dto.ts`]; what `map()` sees measured on Nest 11 and 12 [M `nest-interceptor/`]. |
| V-D10 | **WebSockets**: a channel contract keyed by message type on both sides; an invalid frame gets an error frame and the socket stays open; messages stay in order. | bun-jobs' API socket already does this (`bun-jobs/lib/api/ws/session.ts:136`, `:168-210`, `:1590-1603`) [S]. |
| V-D11 | **SSE on both adapters**: a contract keyed by event name, checked per event as it is written, through bun-common's `SseWriter` (bun-native-routes PR-sse2) and Nest's `@Sse()`. | No plan types SSE events today; the per-event gate is measured [M `http-complete` H21–H24]. |
| V-D12 | **bun-jobs**: a definition carries `schema: { data, result }`, **beside** its options; checks live in `BunQueue` so every enqueue path (add, bulk, flows, the API, updates, debounce, repeat series) runs them; processing re-runs the data schema once, in the worker, before any executor; flows validate every node before the first write. | e9's survey of the code and its nine constraints [A]. |
| V-D13 | **Future transports** (gRPC, Kafka, RabbitMQ/AMQP, UDP) need no core change: `defineTransport` plus a small adapter; no integrations are built. | Two spike adapters, UDP over loopback (about 100 lines) and an in-process broker (about 80) [M `contract-core` C1–C9]. |
| V-D14 | **Docs and the typed client read one thing**: the contract a route, channel, SSE endpoint or job definition carries (`getContract`), flattened by `describeContract` to `{ side, key, part, mediaType, schema }` rows. AD's `__schemas` becomes that. | Spiked [M `contract-core` C20]; AD and TC already expect request parts and per-status responses (§4.11). |
| V-D15 | **Response variants** (V3c, added 2026-10-21): within one status, `variants({ name: { when?, headers, cookies, content, refine? } }, { by?, refine? })`; a response must match **one** variant whole; `when` on the validated request makes a variant acceptable only for the requests it holds for; a discriminant (`by`, a response header or cookie) selects one; `res.status(200).variant(name)` narrows the types; no variant applicable is a mismatch. | The user's need (2026-10-21). Spiked against the real V3a types and overloads (21 controls fire, line-exact) and as a runtime matcher (RV1–RV28) [M `response-variants`]; §4.4.6. The user's answers (2026-10-21): `when` may be async; `.variant()` adjusts the response (fills single literals, strips undeclared body fields). |

### 1.3 What it costs

| Work | Effort | Owner |
|---|---|---|
| Group 1 — core and HTTP completeness, bun-common (V0, V1, V2, V3a, V3b; V3c added 2026-10-21) | **~14–15 d**, **+5 d** for V3c | bun-common agent (bun-node-11) |
| Group 2 — NestJS (V6, V7a, V7b) | **~8.5–10.5 d** (V7b +0.5 d for V3c's variants) | bun-common agent builds in bun-nest; bun-node-15 reviews |
| Group 3 — other transports: WebSocket (V8, V9), SSE (V11), jobs (V4, V5a, V5c, V5b), cache (V10) | **~17–20 d** | bun-common agent (WS, SSE); bun-node-e9 (jobs); BC's owner (cache) |
| Group 4 — client and docs hooks (AD (b0), V12, AD (a)/(b)/(e) deltas) | **~3 d new** + AD's own estimates; bun-node-99 reviewed the shapes (§4.12) | bun-common agent |
| Examples, per PR | **~5 d** | bun-node-74 |

§6 has the order and the per-PR figures.

---

## 2. Part A: the audit

### 2.1 A1 — Is the response validated at runtime? **No**

- **There is no response target.** `ValidationTarget` is
  `"params" | "query" | "body" | "headers"` (`bun-common/lib/BunValidate.ts:9`);
  the middleware validates those and calls `next()`
  (`BunValidate.ts:469-508`). Nothing in it, or in the router pipeline, sees
  the response again [S].
- **Measured**: passing `{ responses: { 200: User }, validateResponses:
  "throw" }` through a cast, a handler sending `{ totally: "wrong" }` was
  answered `200 application/json {"totally":"wrong"}` [M `R1`].
- **`BunResponse.json` checks nothing**: it records the value
  (`#sentBody`) and builds the `Response` at once
  (`bun-common/lib/BunResponse.ts:1463-1470`, `Response.json` at `:1495`)
  [S].
- **The hook that exists cannot host it.** `addResponseTransform`
  (`BunResponse.ts:1336`) runs **synchronously** as the `Response` is
  produced and sees the serialised text, not the value
  (`BunResponseTransform`, `:235-252`) [S]. An async vendor cannot answer
  there (yup returns a Promise [M `results-vendors.txt`]).
- **Prior art in the repo: bun-jobs' management API.** Each route declares
  `responses` by status (`bun-jobs/lib/api/routes/define.ts:51`, typed
  handler results `:54-56`), and with `validateResponses: true` the result is
  checked against the schema for its status and a mismatch is **logged at
  `error`; the response is sent unchanged** (`define.ts:289-297`,
  `responseMismatch` `:313-342`). Default `false`, "on in tests"
  (`bun-jobs/lib/api/config.ts:641`, `:1519`) [S]. It is internal to
  `defineRoute` and not available to any other router.

### 2.2 A2 — Is the response typed? **No**

- `TypedRouteHandler` types `req` from the path and the validator, and gives
  `res: BunResponse` with nothing narrowed
  (`bun-common/lib/types/general.ts:447-458`) [S].
- The shape a validator advertises, `ValidationShape`, has `params`, `query`
  and `body` only (`bun-common/lib/types/routeTyping.ts:88-95`), and
  `MountedHandler`, which every generated overload uses
  (`bun-common/lib/BunRouter.ts:1824-1911` for `get`;
  `bun-nest/lib/BunHttpAdapter.ts:1686-1773`), passes no response type
  (`routeTyping.ts:192-202`) [S].
- The only response typing is per call: `res.json<User>(x)`
  (`BunResponse.ts:1452-1463`), restated by hand at every call [S].
- **Measured** [`audit-types.ts`, `results-types.txt`; 7 negative controls,
  all fire]: after a validator, `res.status(418).json({ anything: 1 })`
  compiles (`T2`, and `T9` on bun-nest's adapter); `validate(s, { responses })`
  is TS2353 (`T3`); a handler returning a non-matching value compiles (`T4`);
  `res.json<User>({ id: 1 })` is refused (`T5`, the per-call check works).

### 2.3 A3 — The request side today: **yes, with three defects and two gaps**

What works [S, M `results-runtime.txt`]:

- **Targets**: `params`, `query`, `body`, `headers` (`BunValidate.ts:9-21`).
  Order fixed `headers → params → query → body` (`:433-434`).
- **Any Standard Schema**: zod 4, yup 1.7, valibot 1, arktype 2 natively,
  superstruct through `toStandardSchema` (`BunValidate.ts:345-365`; covered by
  `__tests__/bunValidate.libraries.test.ts` and `.type-test.ts`). bun-jobs'
  `s` too [M `R7a`/`R7b`].
- **Coercion is the schema's**, not BunValidate's: `page=2` passes
  `z.coerce.number()` and fails `z.number()` [M `R2a`, `R3`]; a `normalize`
  hook reshapes raw input first (`:174-190`). `params` coercion is written
  back [M `R6a`].
- **Errors**: `ValidationError` with `issues: { target, message, path }[]`,
  `targets` and `status` (`:126-162`). `onFailure`: `"next"` (default: the
  Express error pipeline), `"throw"`, `"respond"` (`{ error: "Validation
  failed", issues }`, or `formatError`) (`:117-123`, `:510-528`). Issues from
  every target by default; `abortEarly` stops at the first [M `R6b`].
- **Typing**: `req.params`/`query`/`body` become the schema's **output**, or a
  `transform` hook's return (`:94-114`); `replace: false` leaves the request
  types alone (`:110-114`) [S; `__tests__/validate.type-test.ts`] [M `T1`].

Defects and gaps found:

| # | Finding | Evidence | Planned fix |
|---|---|---|---|
| G1 | **Headers are validated but neither written back nor typed.** `x-n: "5"` passes `z.coerce.number()` and the handler still reads the string `"5"`; `req.headers` keeps its raw type. `InferValidatedShape` does carry a `headers` key (`:79-80`), but `ValidationShape` has none, so it never reaches `req`. | [M `R4a`, `T6`]; write-back skipped on purpose (`:291-295`) | V2: typed on `req.valid`, never written back (§4.3.3) |
| G2 | **`cookies` is not a target, and a `cookies` schema next to a known one compiles and is ignored at runtime**: a failing cookie reached the handler. Alone it is TS2353. | [M `R5`, `T7`] | V0: unknown target is a `ConfigError`; V2: `cookies` and `signedCookies` targets (§4.3.2) |
| G3 | **An explicit `undefined` option overrides its default.** The constructor spreads `options` over the defaults (`:425-431`), so `{ onFailure: "respond", status: undefined }` answered a **failed** request `200` with the issues body. It compiles. | [M `R2h`, `T8`] | V0 |
| G4 | **The default failure mode gives a client nothing to act on** unless the app adds an error handler: on `BunHttpAdapter` a failed query is an HTML `400 Bad Request` page; `BunRouter.fetch()` rejects with the `ValidationError`. With an app error handler, the issues are all there. | [M `R2b`, `R2f`, `R2g`] | V-D2's issue shape reused by every adapter-level filter (§4.4); Q11 |
| G5 | **The schemas are unreachable at runtime.** `validate()` returns a bare function (own keys `length`, `name`), so no route list, document or client can read them. | [M `R9`]; AD Decision 2 | AD (b)'s `__schemas`, landed early in V1 |

### 2.4 A4 — bun-nest: decorator, interceptor, pipe, filter? **None exist**

- `bun-nest/lib/decorators.ts` is one line re-exporting Nest's
  `UploadedFile(s)`; `lib/interceptors.ts` holds the multipart mixins
  (`:182-321`); there is no pipe, guard, filter or discovery code in
  `bun-nest/lib` [S].
- **The typed overloads reach the adapter's own verbs, not controllers.**
  `adapter.get("/x", validate({ query }), handler)` is typed exactly as on a
  router [M `T9`], but a controller method is registered by Nest's router
  proxy, so no `__shape` reaches it (NTR §2) [S, P].
- **Users write the pipe themselves today**: the bun-nest pipeline example
  defines a 20-line `SchemaPipe` over `~standard.validate`
  (`examples/bun-nest/02-http-adapter/pipeline.ts:137-160`, at ab01c57a) [S].
  Since #503 the example uses V6's `StandardSchemaPipe`
  (`packages/bun-nest/lib/validation.ts`) instead.

Against the "full set" asked for:

| Piece | Exists | Planned where | This plan |
|---|---|---|---|
| Method decorator applying request **and** response schemas | no | AD §3.8 (`@Validate`, an interceptor), phase (g) | adopted; corrected input/output rule (§4.3) |
| Parameter decorators typed from the schema | no; **impossible as decorators** (AD §3.8.3 measured; parameter decorators have no type link) | AD: annotate with `Infer<typeof S>` | **`SchemaDto(S)` classes** give the type with no restating [M] (§4.4) |
| `ValidationPipe` equivalent on Standard Schema | no | NTR §4.1 and NJD §7.4 (two `StandardSchemaPipe`s) | one `StandardSchemaPipe` + a global `StandardValidationPipe` reading `SchemaDto` metatypes (§4.4) |
| Response-validation interceptor | no | inside AD's `@Validate` | also standalone, globally, reading `@Validate` metadata (§4.4) |
| Exception filter for the validation shape | no | NTR's `ProblemDetailsFilter` (problem+json) | `ValidationExceptionFilter` for BunValidate's `ValidationError` and the pipes (§4.4) |
| Coexistence with Nest's `ValidationPipe` / class-validator | — | AD §3.6 (class DTOs, phase (b2)), §3.8 | §4.4.6 |

### 2.5 A5 — WebSockets: are messages validated or typed? **No**

- **bun-common**: a route handler's `message` is `string | Buffer`
  (`bun-common/lib/BunWebSocket.ts:393-411`; `router.ws` at
  `bun-common/lib/BunRouter.ts:1406-1428`) [S, M `T10`]. No message, event,
  topic or schema concept exists (AD §2.3's table still holds).
- **bun-nest**: the adapter `JSON.parse`s a frame and **casts** it to its
  packet type (`bun-nest/lib/BunWebSocketAdapter.ts:962-964`), then hands
  `data[1]` to the `@SubscribeMessage` handler. Outgoing `emit`s can be typed
  by a hand-written `WsEventMap` (`:54-65`), not by a schema [S]. Nest's own
  pipes run on gateway handlers, so `@MessageBody(new SomePipe())` would
  validate a payload today [I].
- **Prior art inside the repo**: bun-jobs' management API socket validates
  every client frame against a schema chosen by its `op`
  (`bun-jobs/lib/api/ws/session.ts:136`, `:168-200`), answers an invalid one
  with `{ type: "error", id?, code, status, detail }` and keeps the socket
  open (`:461-464`, `:1590-1603`), and runs messages in order through one
  promise chain (`:468`) [S]. The remote-worker protocol validates its frames
  synchronously with `s` (`bun-jobs/lib/remote/schemas.ts:551-574`) [S].

### 2.6 A6 — bun-jobs: data, results, `s` and `validateResponses`

- **Job data is typed, never validated.** `BunQueue<TData, TResult>` and the
  registry's `JobMap` are type-level only
  (`bun-jobs/lib/queue/BunQueue.ts:356-364`, `lib/queue/types.ts:266`);
  `BunJobs.define(name, handler, options)` has no schema option
  (`lib/BunJobs.ts:936-956`) [S, M `T11`]. **Measured**: a job added with
  `{ to: 42 }` to a `BunQueue<{ to: string }>` reached the worker and
  completed (`"sent number"`) [M `R8`]. The management API's
  `POST /queues/:queue/jobs` takes `data: s.unknown(...)`
  (`lib/api/schemas/jobs.ts:513`) [S].
- **`s` is the management API's own schema builder, and it is a Standard
  Schema**: each schema is `{ json, coerce, "~standard": { vendor:
  "bun-jobs", validate } }` (`lib/api/schema/builder.ts:31-47`, `:206-232`),
  validating synchronously against its own JSON Schema; bun-common's
  `validate()` already takes it (`define.ts:515`) [S, M `R7`]. It carries its
  JSON Schema as `.json`, **not** as `~standard.jsonSchema` [M `R7c`], and is
  exported from `@kingsleyweb/bun-jobs/lib/api` only, not the package root
  (`lib/api/index.ts:161-178`) [S].
- **`lib/api/schema/coerce.ts`** turns query and path strings into numbers,
  booleans and arrays **inside validation** for a schema wrapped in
  `s.query(...)` (`coerce.ts:1-12`, `:70-90`), so the inferred `number` is the
  truth about what a handler receives [S].
- **Could BunValidate and `s` share one abstraction?** They already share
  the contract (Standard Schema). What they do not share is the runner (the
  three copies of issue flattening above) and the route to JSON Schema (`s`
  has `.json`; zod and arktype have `~standard.jsonSchema`; valibot, yup and
  `toStandardSchema` have neither [M `results-vendors.txt`]). §4.1 closes both.
  `s` stays bun-jobs' small internal DSL; it is not a candidate for
  bun-common, which takes any vendor.
- **Provider configs already use Standard Schema with the sync/async rule
  this plan generalises**: a sync schema throws a `ConfigError` from
  `provider(config)`, an async one settles `ready` later
  (`lib/provider/define.ts:214-222`, `lib/provider/configure.ts:382`, `:471`)
  [S].

### 2.7 A7 — bun cache: **no code; validation is planned**

- No cache package or value cache exists (BC §2.1, re-checked: no
  `packages/bun-cache`) [S].
- BC §3.13 types a cache by a key-pattern map (`createCache<Schema>`) and
  offers `validate: { "user:*": UserSchema }`, any Standard Schema, checked
  on read; a failing value is a miss with an `error` event [P].
- BC §9.6 already settled where `cacheResponse()` may sit relative to
  `validate()` in the typed overloads [P].

### 2.8 A8 — Typed routes, the typed client and OpenAPI

- **Request shapes flow; responses do not.** `ValidatorMiddleware<TShape>`
  carries a phantom `__shape` (`BunValidate.ts:553-556`); the generated
  overloads take it in exactly one position and type the following handler
  through `MountedHandler` (`routeTyping.ts:192-202`) [S].
- **The typed client** (TC) builds its route model from AD's `__schemas` and
  `responses` (TC D2, D6); nothing of it is built [P].
- **OpenAPI from BunValidate schemas: not today.** The schemas are not
  reachable at runtime [M `R9`]; AD (b) plans `__schemas` and a converter
  reading `~standard.jsonSchema` first. Today zod 4 and arktype 2 carry
  it; valibot, yup, `s` and `toStandardSchema` do not
  [M `results-vendors.txt`], which matches AD's Decision 3 table.

### 2.9 What the 2026-10-17 revision measured and read

At `68023d36`. These facts shape §4; each is cited where it is used.

- **Request headers exist twice** [S]. `req.headersObj` is the native
  `Headers`, read lazily, with a setter (`bun-common/lib/BunRequest.ts:1529-1533`).
  `req.headers` is a plain `Record<string, string | string[]>` built from it
  on first read and cached, also with a setter (`:5154-5163`); `setHeader` and
  `removeHeader` clear the cache (`:5197`, `:5218`). **The two do not sync**:
  assigning `req.headers` leaves `getHeader`, `fresh` and CORS reading the
  original. busboy (`:3850`), `accepts` (`:5367`), `type-is` (`:4158`,
  `:4684`), `rawHeaders` and `headersDistinct` read `req.headers`.
- **Replacing `req.headers` with a schema's output breaks the request**
  [M `http-complete` Q2]: on one multipart POST, `req.is("multipart")` became
  `null`, `typeIs.hasBody` `false`, busboy threw `Missing Content-Type`,
  `rawHeaders` fell from 8 to 2, and the coerced value reverted to `"5"` after
  a later `setHeader`. Merging instead put the number `5` into
  `headersDistinct`, and still reverted. A parsed copy beside it broke nothing.
- **Cookies** [S]: `req.cookies` and `req.signedCookies` are
  `Record<string, JsonValue>` with getters and setters, parsed lazily
  (`BunRequest.ts:2972-3018`); a `j:` cookie is parsed JSON; a signed cookie no
  secret verifies is `false`. **A forged unsigned `sid` lands in
  `req.cookies` and passes a `cookies` schema**; against `signedCookies` it is
  absent and fails, and a tampered one is `false` and fails
  [M `http-complete` Q1c–Q1e, H49–H51]. No library code reads `req.cookies`
  after the parse, so writing a parsed value back is safe [M Q1g].
- **Every response commits through one setter** [S, M]: `BunResponse`'s
  private `set response` (`bun-common/lib/BunResponse.ts:1300`) is reached by
  `json()`'s fast path, text, bytes, `Blob`, `send(Response)`, `redirect`,
  `sendFile` and the stream the first `write()` opens. It runs the (synchronous,
  text-only) transforms, `markResponded`, the waiters and `finish`. Building
  the native `Response` is harmless; handing it on is the point of no return.
  `headersSent` reads only the native response (`:2576`) and the pipeline
  waits on it (`BunRouter.ts:808`), so a commit can be **held**.
- **Status writers** [S]: `status()` (`BunResponse.ts:1397`), the `statusCode`
  setter (`:1402`), `writeHead` (`:1933`), `redirect` (`:2420`; its
  `ResponseInit` form returns `Response.redirect`, `:2380-2397`),
  `sendStatus` (`:3115`), the freshness 304 (`:1544`), `handleNotFound`
  (`:2803`), the 416 of `#respondWithStatus` (`:2813`) and `sendFile`'s 206
  (`:3003`). Every one is visible at the commit point.
- **A handler's return value is ignored** (`BunRouter.ts:5286`): returning a
  native `Response` sends nothing [M `http-complete` H52].
- **SSE**: no helper exists in bun-common or bun-nest; the
  [bun-native-routes plan](../bun-native-routes/README.md) §16 designs one
  (PR-sse2: `lib/sse/`, `res.sse()` returning an `SseWriter`, a `./sse`
  subpath), whose `SseMessage.data` is untyped. **No plan validates SSE
  events.** Nest's `@Sse()` streams on bun-nest unchanged [S].
- **Nest 12 ships Standard Schema itself** [A, from the nestjs-12-parity
  plan's changelog evidence]: 12.0.0 (#16373) added
  `StandardSchemaValidationPipe`, `@Body/@Query/@Param({ schema })`,
  `StandardSchemaSerializerInterceptor` and `@SerializeOptions({ schema })`;
  #17107 put field paths in its messages; 12.1.0 (#17834) added
  `@Cookies()`/`@SignedCookies()`. None exist on 11, and bun-nest supports
  both majors. `@RawBody({ schema })` is validated only when the pipe is
  `StandardSchemaValidationPipe({ validateCustomDecorators: true })` (it
  receives a `Buffer`) [M `nest-interceptor/`].
- **bun-jobs** [A, from e9's survey; paths under `bun-jobs/lib/`]:
  - **Enqueue bypasses the definitions.** `BunQueue.add`, `addBulk`,
    `addFlow` and the API's add route never consult the definitions
    (`JOB_ROUTER` serves only the builder verbs; `BunJobs#addDefined` is never
    called). A check keyed on `define()` must live in `BunQueue`.
  - **Flows**: `BunQueue.addFlow(node)` with `FlowNode { name, data, opts?,
    queue?, children? }` (`queue/types.ts:168-185`); a parent waits as
    `waiting-children`. Children are keyed **`queue:id`** (`drivers/flow.ts:11-13`),
    not by name; a parent reads `job.getChildrenValues(): Record<string,
    unknown>` (`queue/Job.ts:694-697`), untyped. **A flow add is atomic on no
    driver**: a synchronous `#planFlow` pre-pass, then one awaited `addJob`
    per node (`queue/BunQueue.ts:1494-1635`).
  - **Isolated targets** (Worker, child process, container) receive the raw
    `JobRecord` (`queue/workerTarget.ts:871-872`) over JSON or a structured
    clone; `#buildRecord` asserts JSON safety (`BunQueue.ts:3001`).
  - **Other writes of data**: `BunQueue.update`, `Job.updateData`/`update`,
    `PATCH /queues/:queue/jobs/:id` (`BunQueue.ts:1784-1837`,
    `Job.ts:453-517`), debounce replacements (`:2647-2655`), repeat series
    (`queue/repeat.ts:292`, `queue/repeatControl.ts:274`).
  - **A fourth copy of issue flattening** (`provider/configure.ts:134-155`)
    joins the three §4.1 of the first version listed.
  - The management API's `VALIDATION` problem is **400**
    (`api/errors.ts:92`), as BunValidate's default is.
- **The vendors' own issue messages leak the received value** [M
  `contract-core` C11]: valibot in its messages and path objects, arktype
  `(was "…")`, yup `cast from the value`, zod for an unrecognised key.

---

## 3. What other plans already decide

Adopted by reference. This plan builds on them and changes only what §4 says.

| Piece | Where | Status | This plan's delta |
|---|---|---|---|
| `__schemas` on the validator middleware | AD Decision 2, phase (b) | plan | **becomes the contract** the middleware carries (`getContract`, §4.1.5); lands in V1 |
| Spec types 1.1.0 (`StandardJSONSchemaV1`) | AD phase (b0) | plan | unchanged; group 4 |
| `validate(schemas, { responses })`, `BunResponse<_, TResponses>`, `status()` narrows, `json()` constrains | AD §3.7, phase (b1) | plan | **extended to headers, cookies and every body kind** (§4.4); the input/output rule (§4.4.4) |
| Runtime response checking, `"off" \| "log" \| "throw"` at finalisation | AD §3.5 | plan | **replaced**: the commit gate (§4.4.2), modes `"off" \| "warn" \| "error"` |
| `@Validate` interceptor, class + method, return-type constraint, swagger bridge | AD §3.8, phase (g) | plan | composes with Nest 12; headers and cookies; per-status responses in the interceptor and PR-6c's before-write hook (§4.5) |
| `StandardSchemaPipe` | NTR §4.1; NJD §7.4 | plan, twice | **one pipe, bun-nest root**, on the core (§4.5.3) |
| `ProblemDetailsFilter` | NTR §3.3 | plan | `ValidationExceptionFilter` beside it (§4.5.5) |
| `defineChannel({ receives, sends })` | TC §6.5, PR-M4 | plan, validation semantics open | a WebSocket contract on the core; the semantics (§4.6) |
| `@ValidateMessage`, `@Emits` | NTR §7, PR-N5 | plan | on the core; error frame and filter (§4.6.2) |
| SSE helpers: `res.sse()`, `SseWriter`, `./sse` | bun-native-routes §16, PR-sse2 | plan, not started; this plan's lead owns it | the writer takes an SSE contract (§4.7) |
| `validate` on read for caches | BC §3.13 | plan | runner and order only (§4.10) |
| Client-side validation, `Jsonify` responses, the route model | TC §3.0, §4.1, §5 | plan | reads `describeContract` (§4.11) |
| NestJS 12 support | [nestjs-12-parity](../nestjs-12-parity/README.md) | plan, being built | the Nest PRs here stack on its PR-2, PR-3, PR-5, PR-6a, PR-6c (§6) |

---

## 4. Part B: the design

### 4.1 The contract core (bun-common) [D, M `contract-core`]

One model every transport plugs into. Spiked in
[`evidence/contract-core/`](evidence/contract-core/README.md): `core.ts` is the
prototype, `transports.ts` declares eight transports through it, `udp.ts` and
`broker.ts` are working adapters, `types.probe.ts` holds 24 type controls
(all shown to fire, line-exact), and `run.ts` cases C1–C22.

#### 4.1.1 Transports, parts, keys and contracts

A **transport** says which **parts** a message has on each **side** and, when
a side carries several kinds of message, the name of its **key**. A
**contract** maps parts to schemas.

```ts
type Schema = StandardSchemaV1;
interface MediaMap { readonly [mediaType: string]: Schema }       // OpenAPI's `content`
type PartDecl = Schema | MediaMap | null;                        // null: must be absent (a 204 body)
interface SideSpec { parts: readonly string[]; key?: string; media?: readonly string[] }
interface TransportSpec { name: string; inbound?: SideSpec; outbound?: SideSpec }

function defineTransport<const T extends TransportSpec>(spec: T): Transport<T>;
interface Transport<T> {
  spec: T;
  contract<const D extends ContractDef<T>>(def: D & StrictDef<T, D>, meta?: ContractMeta): Contract<T, D>;
}
```

| Transport | Inbound | Outbound | Key |
|---|---|---|---|
| HTTP | `params`, `query`, `headers`, `cookies`, `signedCookies`, `body` (by media type) | `headers`, `cookies`, `body` (by media type) | outbound: `status` |
| WebSocket | `data` | `data` | `type` on both |
| SSE | (the HTTP request) | `data`, `id` | `event` |
| jobs | `data` | `result` | — (a flow's children are a part, §4.8.4) |
| Kafka | `payload`, `key`, `headers` | the same (a producer's outbound is a consumer's inbound) | `topic` |
| RabbitMQ / AMQP | `payload`, `headers`, `properties` | the same | `routingKey` |
| gRPC | `request`, `metadata` | `response`, `metadata` | `method` |
| UDP (spike) | `payload`, `meta` | `payload` | `type` |

A **side** that has a key is a map from key to parts (a status to its
response); a side without one is one set of parts (a request). A part listed in
`media` takes a `MediaMap`, so HTTP's nesting is **key → parts → media
type**, with nothing more in the model:

```ts
http.contract({
  inbound: { params: IdParams, query: Page, cookies: Session },
  outbound: {
    200: { headers: z.object({ "x-rate-limit-remaining": z.coerce.number() }),
           body: { "application/json": User, "text/plain": z.string() } },
    201: { headers: z.object({ location: z.string() }), body: { "application/json": User } },
    204: { body: null },
  },
});
```

What the spike changed from the first sketch, each for a measured reason
(`contract-core/README.md`, "What changed"): a message is **flat** and uses the
transport's own key name (`{ status, headers, body }`, `{ topic, payload,
key }`), because Kafka has a part called `key`; `defineTransport` rejects a key
that is also a part. `StrictDef` exists because a `const` generic skips
excess-property checks, so `http.contract({ inbound: { bdy } })` compiled
without it. Declaration mistakes are type errors **and** `TypeError`s at
runtime (C22).

#### 4.1.2 One runner, and one issue shape

```ts
interface ValidationIssue<TTarget extends string = string> {
  target: TTarget;      // the part ("body", "headers", "payload"), or the key's name when the key is undeclared
  message: string;      // never quotes the received value (§4.1.6)
  path: string;         // dotted, "" for the part itself — today's meaning
  key?: string;         // the status, message type, event, topic or method
  mediaType?: string;   // when the part is keyed by media type
}
type StandardOutcome<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

function validateStandard<S extends Schema>(
  schema: S, value: unknown, target: string, key?: string, mediaType?: string,
): StandardOutcome<InferOutput<S>> | Promise<StandardOutcome<InferOutput<S>>>;
```

- **Synchronous when the vendor is** [M C10]: zod 4.6, valibot 1.5, arktype
  2.2 and a hand-rolled sync schema answer synchronously at every level (the
  runner, a receiver, a sender); yup 1.7 and an async schema return a Promise,
  and so does any message with one async part. That is what lets a broker
  publish reject before the enqueue (C8) and an HTTP response decide before it
  is handed on (§4.4.2).
- **`ValidationIssue` keeps today's three fields and their meaning**; `key`
  and `mediaType` are optional additions, and the type parameter defaults to
  `string`, while BunValidate's request side narrows it to its targets. The
  first version's `target`-only shape is a special case.
- **The four copies of issue flattening** (`BunValidate.ts:368-379`,
  `bun-jobs/lib/api/routes/define.ts:313-342`,
  `bun-jobs/lib/remote/schemas.ts:551-574`,
  `bun-jobs/lib/provider/configure.ts:134-155`) and the examples' pipe become
  calls to it, as each owner decides.

#### 4.1.3 Guards, and one policy

```ts
type Policy = "off" | "warn" | "error";
interface GuardOptions {
  policy?: Policy;                                                       // default "error"
  logger?: LoggerLike;                                                   // "warn" logs here
  onIssues?: (issues: readonly ValidationIssue[], ctx: IssueContext) => void;  // telemetry; free when unset
  undeclaredKey?: "report" | "allow";                                    // default "report"
}
interface IssueContext { transport: string; side: "inbound" | "outbound"; key?: string; policy: Policy }
class ContractError extends Error { issues: readonly ValidationIssue[]; context: IssueContext }
interface Guard<In, Out> { (message: In): Out | ContractError | Promise<Out | ContractError>; readonly checks: boolean }

function createReceiver<C, Sd>(contract: C, side: Sd, options?: GuardOptions): Guard<unknown, Received<C, Sd>>;
function createSender<C, Sd>(contract: C, side: Sd, options?: GuardOptions): Guard<Sent<C, Sd>, Sent<C, Sd>>;
```

- **Two guards, because the two ends want different things** [M]: a
  **receiver parses** and hands on each part's output (a `z.coerce.date()`
  arrives as a `Date`, C1); a **sender checks** and hands back the very object
  it was given, because what goes on the wire is the sender's value. One
  Kafka topic map is the producer's outbound and the consumer's inbound.
- **A guard returns a `ContractError` rather than throwing**, and is compiled
  once per side with a plan per key; that is what keeps the no-schema path
  allocation-free and the sync answer sync. `guard.checks === false` lets an
  adapter skip the call entirely.
- **The policy** (the same three words everywhere):

  | Policy | Receiver (inbound) | Sender (outbound) |
  |---|---|---|
  | `"off"` | no check; the raw message is handed on | no check |
  | `"warn"` | checked; on a mismatch one log line (no values) and the **raw** message is handed on | checked; sent anyway; one log line |
  | `"error"` | a mismatch is a `ContractError` the adapter turns into its transport's refusal (HTTP 400, an error frame, a rejected enqueue) | a mismatch is refused before anything is written, where the transport allows (§4.4.2) |

  `"warn"` and `"off"` on a **receiver** hand a handler a value its type says
  was parsed when it was not (C3, C4: a `Date`-typed field is a string). So
  receivers default to `"error"`, and §8 asks whether they may take anything
  else (Q-C1).
- Each adapter maps a `ContractError` to its transport's refusal: HTTP's
  request side keeps BunValidate's `ValidationError` and `onFailure` modes
  (§4.3.4); HTTP's response side raises `ResponseValidationError` (§4.4.3);
  WebSocket answers an error frame (§4.6); jobs reject the enqueue or fail the
  job (§4.8).

#### 4.1.4 Static types from the contract

```ts
type ReceiveOf<S> = StandardSchemaV1.InferOutput<S>;
// Field by field: each field's input type, or its output where the input is
// `unknown` (a coercion), with the input's optionality; deep through objects
// and arrays. (The spike's `SendOf` applied this to the whole part; V1 replaces it.)
type WireInput<S> = DeepWire<StandardSchemaV1.InferInput<S>, StandardSchemaV1.InferOutput<S>>;
type Received<C, Sd>;   // the flat message: { [keyName]: K, ...each part's output }, a union over the keys
type Sent<C, Sd>;       // the same, each part held to WireInput
type KeysOf<C, Sd>; type PartsOf<C, Sd, K, R>;
type MediaValue<M, R> = { mediaType: K; value: … };   // a union over the media map
```

- A **receiver** gets each part's **output**; a **sender** is held, **field
  by field**, to each field's **input**, or its **output** where the input is
  `unknown` (`WireInput`). This is
  the first version's rule (§4.4.4), now general: the spike checks it on HTTP,
  WebSocket, SSE, jobs, Kafka and gRPC (`types.probe.ts`).
- **The rule applies per field, not per part** (bun-node-99's review, M1;
  §4.12): the spike's `SendOf` takes the whole part's input, so a query
  `z.object({ page: z.coerce.number(), q: z.string().default("") })` sends as
  `{ page: unknown; q?: string }` and `{ page: "x" }` compiles. V1 replaces it
  with a deep **`WireInput<S>`**: each field takes its input type, or its output
  where the input is `unknown` (a coercion), with the input's optionality.
  `Sent`, V-D8's response typing and TC's client inputs all use it.
- An undeclared key (a 418), a missing required part (a 201 without
  `Location`), a body on a `null` part, a media type a status does not
  declare, and a part a transport does not have are all type errors.
- **What the wire changes is not the core's**: a header arrives as a
  string, a JSON body as its `Jsonify`. A client's response types follow the
  **wire**, `Jsonify<WireInput<S>>`, not the schema's output (a body `{ n:
  z.string().transform(s => s.length) }` is sent as a string, M2), and its
  output only when the client parses with the schema itself (TC §5.4). §8 Q-C5
  proposes a per-transport `wire` mapping, which V1 also records as **data**
  on each row (§4.12, m3), because generated client validators need it at
  runtime.

#### 4.1.5 Contracts readable at runtime

```ts
const CONTRACT: unique symbol;                    // the spike's Symbol.for("bun-validate.contract"); the name is §9's
function attachContract<X extends object, C>(target: X, contract: C): X & Carries<C>;
function getContract<C>(x: Carries<C>): C;
function getContract(x: unknown): AnyContract | undefined;
function describeContract(c: AnyContract): ContractDescription;
interface ContractDescription {
  // Every side and key the contract declares, even one with no parts (`202: {}`),
  // and whether a side is declared at all ("nothing declared" ≠ "declared empty").
  sides: { inbound?: { declared: true; keys?: string[] }; outbound?: { declared: true; keys?: string[] } };
  entries: ContractEntry[];   // in canonical order (§4.12, m1)
}
interface ContractEntry {
  side: "inbound" | "outbound"; keyName?: string; key?: string; part: string; mediaType?: string;
  kind: "value" | "chunks" | "sse" | "opaque";        // §4.12 M4; an sse() expands into nested event rows
  encoding: "path-string" | "querystring" | "header-string" | "cookie-string" | "signed-cookie" | "set-cookie" | "body";  // m3
  origin?: string;                                    // the layer it came from, after mergeContracts (M3)
  schema: StandardSchemaV1; vendor?: string;
  nested?: ContractEntry[];                           // an sse() row's event rows (V3b, approved 2026-10-21)
}
```

- A validator middleware, a channel handler, an SSE endpoint, a job
  definition and a Nest route each **carry** their contract under one symbol,
  non-enumerable, so nothing changes for code that enumerates them [M C20: the
  handler has no enumerable keys].
- `describeContract` flattens a contract into its declared sides and keys
  plus rows a generator walks: one per `(side, key, part, mediaType)`, each
  with its body `kind`, its wire `encoding` and its `origin` (§4.12, from
  bun-node-99's review: B1, M3, M4, m3). An OpenAPI or AsyncAPI generator, the route
  model and bun-jobs' `/definitions` read **only this** (§4.11). The spike's
  seven-row HTTP contract took its JSON Schema from zod's
  `~standard.jsonSchema` (C20).
- **This replaces AD's `__schemas`**: the same idea (the middleware carries
  its schemas), one name for every transport, and a typed accessor.

#### 4.1.6 Three rules every transport keeps [A, M]

1. **An issue never carries the received value.** The vendors' own messages
   do (valibot, arktype, yup, zod; §2.9), so the runner copies only `message`
   and the path keys, and replaces a message quoting a received leaf with
   `Invalid value (<code>)`. After that, nothing leaked in any of 9 cases, and
   a `"warn"` log holds only `transport, side, key` and each issue's `target,
   path, message, key` [M C11, C12]. **Two limits**, put to the user as Q-C2
   and Q-C3: a path can still hold user data (an unknown key's name, a record
   keyed by user data), and the scrub is a heuristic.
2. **No schema costs nothing.** A side or key with no schema answers
   synchronously with the same object and allocates nothing; 100,000 retained
   results add 0 live objects (199,999 with one zod part) [M C13–C15]. An
   adapter with no contract never calls the guard. bun-jobs' enqueue
   throughput is benchmark-guarded, so this is a release gate there (§4.8).
3. **One telemetry hook**, `onIssues(issues, ctx)`, called once per failing
   message and never on a passing one; with and without it, a valid message
   cost 164 and 165 ns [M C16, C17]. Its first user is the OpenTelemetry
   plan's `validation.failed` span event, with `validation.target`,
   `validation.issue_count` and the paths, never values [A, e9].

#### 4.1.7 Cost [M `contract-core` C18]

Minimum of three runs, on a 2-field object, in ns, at load 9–13 on 16 cores
(it had peaked at 61 minutes before, so read these as orders of magnitude):

| Vendor | `~standard.validate` | `validateStandard` | receiver | sender |
|---|---|---|---|---|
| zod | 71 | 79 | 199 | 172 |
| valibot | 65 | 74 | 189 | 165 |
| arktype | 63 | 84 | 197 | 173 |

These are fixed costs, lost in the noise on a 20-item list (zod 4.3 µs).
A failing message costs about 1.7 µs (the scrub and a `ContractError` stack).
A keyed side with no schema for the key costs about 15 ns; Q-C6 proposes a
cached `checksKey(key)` for routers and topic tables.

#### 4.1.8 Where it lives

`packages/bun-common/lib/contract/`, exported from the package root **and**
from a **browser-safe subpath** (`@kingsleyweb/bun-common/contract`), as
`./sse` is for the SSE parser (bun-native-routes §16). Its browser user is a
**shared contract module**, a channel's or a route's contract imported by both
the server and a browser client (§4.12, m12); the typed client itself needs
nothing of bun-common at runtime, and bun-jobs-ui reads `/definitions` as
JSON. The core
needs no Bun or Node API: the spike's `core.ts` has one import, the
`StandardSchemaV1` type, which bun-common vendors in
`bun-common/lib/types/standardSchema.ts` (no imports) [S]; the real module
takes it from there, so the subpath stays browser-safe, which V1 proves with a
bundle-safety test like bun-jobs-ui's [I]. §8 Q-C7.

### 4.2 The extension point: adding a transport [D, M `contract-core`]

A transport is a declaration plus an adapter; the core does the rest. **No
gRPC, Kafka, RabbitMQ/AMQP or UDP integration is built**: we have no
packages for them, and this plan only makes sure one would need nothing new.

**What a transport author writes**:

1. `defineTransport({ name, inbound, outbound })` — part and key names, and
   which parts take media maps (3–5 lines, `transports.ts`).
2. An adapter that, at its two seams, calls `createReceiver(...)` on what
   arrives and `createSender(...)` on what leaves, and maps a `ContractError`
   to the transport's refusal (an error reply, a nack, a dead letter).
3. `attachContract(handler, contract)` wherever it registers a handler, so
   docs and clients find it.

**What it gets**: typed handlers and senders, validation in three policies,
the issue shape, the no-value and no-cost rules, the telemetry hook, and
document rows from `describeContract`.

**The proof** [M]:

- **UDP over loopback** (`udp.ts`, `Bun.udpSocket`, port 0; the server about 55
  lines, the client about 45): a valid datagram reaches the typed handler
  parsed (C1); an invalid one gets an error frame `{ target: "payload", path:
  "text", key: "chat.post" }` and the handler is not called (C2); `"warn"`
  logs once and passes the raw value (C3); `"off"` never calls the schema
  (C4); an undeclared `type` is `target: "type"` (C5); the typed client
  refuses an invalid request before sending (C6).
- **An in-process broker** (`broker.ts`, about 80 lines; topic → handlers,
  parts `payload`, `key`, `headers`): a valid publish answers synchronously and
  the consumer sees coerced output (C7); an invalid one returns a
  `ContractError` synchronously with zero deliveries (C8); a yup topic answers
  with a Promise and a schema-less one synchronously (C9). It checks on publish
  **and** on delivery, which is right across services and redundant in one
  process; Q-C8.

**How the named future transports map** (declarations in `transports.ts`,
types only):

| Transport | Key | Parts | A refusal is | Documents |
|---|---|---|---|---|
| gRPC | `method` | `request`, `metadata` / `response`, `metadata` | `INVALID_ARGUMENT` with the issues in details | protobuf is its own contract; the schema checks the decoded message |
| Kafka | `topic` | `payload`, `key`, `headers` | a dead-letter topic, or a skipped offset with a log | AsyncAPI `channels` (§4.11) |
| RabbitMQ / AMQP | `routingKey` | `payload`, `headers`, `properties` | a nack without requeue (to the dead-letter exchange) | AsyncAPI |
| UDP | `type` | `payload`, `meta` | an error datagram | AsyncAPI |

A guide, "Writing a transport", goes in bun-common's README with V1, using the
UDP adapter as its worked example.

### 4.3 HTTP requests in bun-common [D, M `http-complete`]

`validate()` and `BunValidate` keep their signatures and behaviour; underneath,
a validator becomes an HTTP contract on the core (§4.1) with a receiver guard
on its inbound side, and the middleware carries the contract
(`attachContract`). Existing code compiles and behaves as today, apart from
V0's two fixes.

#### 4.3.1 V0: the fixes that ride first (unchanged from the first version)

- **G3**: defaults survive an explicit `undefined` (the constructor spreads
  `options` over the defaults, `BunValidate.ts:425-431`, so `{ onFailure:
  "respond", status: undefined }` answered a failed request **200** [M
  `R2h`]).
- **G2**: a key outside the known targets is a `ConfigError` at construction,
  because a type cannot catch it on an inferred generic [M `R5`, `T7`].

#### 4.3.2 Targets

```ts
type ValidationTarget = "params" | "query" | "body" | "headers" | "cookies" | "signedCookies";
interface ValidationSchemas {
  params?: StandardSchemaV1; query?: StandardSchemaV1; body?: StandardSchemaV1;
  headers?: StandardSchemaV1;        // lower-case keys; typed on req.valid.headers; never written back
  cookies?: StandardSchemaV1;        // req.cookies: written back and typed
  signedCookies?: StandardSchemaV1;  // req.signedCookies: only verified cookies; a tampered one is false
}
```

The fixed order becomes `headers → cookies → signedCookies → params → query →
body`, so a cheap header or session check fails before a body is parsed.

- **Cookies are two targets** [M H47–H51]: only `signedCookies` can require a
  signature, since a forged unsigned `sid` lands in `req.cookies` and passes a
  `cookies` schema (§2.9). Both are written back (as `query` and `body` are)
  and typed on `req.cookies` / `req.signedCookies`. A schema that strips
  unknown keys strips unknown cookies, as it does unknown query keys.
- **Headers are typed, never written back** [M Q2, H46]: §2.9 shows what
  replacing or merging `req.headers` breaks. Schema keys are lower-case
  (a `Content-Type`-keyed schema fails, Q2e); the README says so.

#### 4.3.3 `req.valid`: every parsed part, typed

```ts
class BunRequest<TParams, TQuery, TBody,
  TCookies = Record<string, JsonValue>,
  TSignedCookies = Record<string, JsonValue>,
  TValid = Record<never, never>> {
  get cookies(): TCookies;
  get signedCookies(): TSignedCookies;
  declare valid: TValid;   // { headers?, cookies?, signedCookies?, params?, query?, body? } as parsed
}
```

- `req.valid` holds each part a validator parsed, as Hono's
  `c.req.valid("header")` does: the **one** place a typed header lives
  (`req.valid.headers["x-n"]` is the number `5` while `req.headers["x-n"]`
  stays `"5"` and `accepts` still works, H46), and a uniform view of the rest.
  A mount's validator and a route's merge at runtime; the route's type wins on
  a key both declare (`MergeShape`, as today).
- The three new `BunRequest` type parameters are **trailing and defaulted**,
  so every existing `BunRequest<P, Q, B>` compiles [M: bun-common's own
  `__tests__`, 95 files, and bun-nest's lib and tests, check clean against the
  patch].
- Under `replace: false`, `req.*` keep their raw types as today; whether
  `req.valid` is still typed there is Q-H8 (it changes five existing type-test
  assertions).

#### 4.3.4 Failures

Unchanged: `ValidationError` (`issues`, `targets`, `status`, default 400),
`onFailure: "next" | "throw" | "respond"`, `abortEarly`. Issues now come from
the core, so they carry no received value (§4.1.6) and gain the optional
`key` and `mediaType` fields. bun-jobs' management API maps BunValidate issues
into its own `ProblemIssueDto`, whose `target` is today's four-member union
(`bun-jobs/lib/api/contract/types.ts:61`, `api/serialize.ts:65`): widening
`ValidationTarget` breaks it at `bun-jobs/lib/api/errors.ts:409` [M
`http-complete` step d]. That DTO is the contract bun-jobs-ui reads, so V2
widens it in the same PR, reviewed by bun-node-e9 and bun-node-99 (Q-H7).

#### 4.3.5 Typing

`ValidationShape` gains `cookies`, `signedCookies`, `headers` and `responses`
(§4.4); `MountedHandler` and `ResolvedHandler` pass
`BunRequest<P, Q, B, ResolveCookies<S>, ResolveSignedCookies<S>,
ResolveValid<S>>`, and `TypedRouteHandler` gains `TRes` and `TReq` as trailing
parameters. **The generated overloads are byte-identical**
(`generate-verb-overloads.ts --check`: "up to date (25 verbs)" and "(16
verbs)") [M]. One documented limit lifts: an inline validator followed by a
`ResolvedHandler`-typed handler now infers, which changes five lines of
`__tests__/verbTyping.type-test.ts:181-182` (Q-H9). A handler typed
`TypedRouteHandler` ahead of the call keeps the limit (L1, pinned by the
probe).

After nestjs-12-parity PR-5, named wildcards (`*name`, `{*name}`) are
`string[]` everywhere [A]: a `params` schema on a wildcard route must accept
an array, and V2's type tests carry one such case.

### 4.4 HTTP responses in bun-common: status, headers, cookies and every body kind [D, M `http-complete`]

#### 4.4.1 The response contract

```ts
validate(
  { params: IdParams },
  {
    responses: {
      200: { headers: RateLimit, content: { "application/json": User, "text/plain": z.string() } },
      201: { headers: z.object({ location: z.string() }), content: { "application/json": User } },
      204: null,                                   // no body
      302: { headers: z.object({ location: z.string().startsWith("/app") }) },
      404: Problem,                                // shorthand: { content: { "application/json": Problem } }
    },
    responseValidation: "error",                   // per validator; else the router's or adapter's; default "off"
  },
);
```

```ts
type ResponseSchemas = Readonly<Record<number, ResponseSpec>>;
type ResponseSpec =
  | StandardSchemaV1                     // shorthand for { content: { "application/json": S } }
  | OpaqueBody<`${string}/${string}`>    // opaque("image/png"): shorthand for { content: { "image/png": opaque() } } (V3b)
  | null                                 // no body
  | {
      headers?: StandardSchemaV1;        // lower-case names; set-cookie is the cookies part
      cookies?: StandardSchemaV1;        // { [name]: { value, httpOnly, secure, sameSite?, path?, domain?, maxAge?, expires?, partitioned } }
      content?: Readonly<Record<string, ContentSpec>> | null;   // media type → body; type/* and */* fall back
    };
type ContentSpec = StandardSchemaV1 | null | StreamChunks | SseEvents | OpaqueBody<undefined>;  // opaque(mediaType) here: a TypeError
function chunks<S extends StandardSchemaV1, const F extends "raw" | "ndjson" = "raw">(
  chunk: S, options?: { framing?: F }): StreamChunks<S, F>;                        // a stream, per chunk (or NDJSON line)
function sse<const E extends Record<string, StandardSchemaV1 | null>, const D extends "json" | "text" = "json">(
  events: E, options?: { data?: D }): SseEvents<E, D>;                             // per event name (Q-C13)
function opaque<const M extends `${string}/${string}` | undefined = undefined>(
  mediaType?: M): OpaqueBody<M>;                                                 // a type, never read; 200: opaque("image/png") = { content: { "image/png": opaque() } }
```

- **An undeclared status is a mismatch**, as the user asked: whatever the
  body, a status the contract does not list fails (H25, H26, H35, H36).
  Statuses a route does not own (the validator's own 400, an auth 401) are
  declared once on the router or adapter with `commonResponses` (TC §4.2),
  which merges under every route's `responses`.
- **Response headers and cookies are parts**: a mismatched or missing
  `x-ratelimit-remaining` (H28, H29) and a `Set-Cookie` without `HttpOnly`
  where the contract requires it (H31) fail like a body does.
- **Media types are keys**, matched on the bare type with parameters and case
  ignored at runtime (`text/plain; charset=utf-8` matches `text/plain`), and
  exact in the types; an undeclared one is a mismatch (H27, H37, H38). Wildcards
  are Q-C4.
- The **HTTP transport declares** `outbound: { key: "status", parts:
  ["headers", "cookies", "body"], media: ["body"] }`; the `content` map is the
  body's media map, and `chunks()`, `sse()` and `opaque()` are body schemas
  with a stated reading rule.

#### 4.4.2 Where it is checked: one commit gate and one chunk gate

Every producer commits through `BunResponse`'s private `set response`
(`BunResponse.ts:1300`, §2.9). The design puts **one gate in that setter,
before the transforms**, and one more on each streamed write:

- **`commit()`** checks the status, the headers, the `Set-Cookie`s, the media
  type and a buffered body, and answers *go*, *reject*, *replace* (a stream
  wrapped so its chunks are checked) or *destroy*.
- **`chunk()`** checks each `write()` of an open stream or each chunk of a
  piped one, and each SSE event.
- A **Promise** verdict in `"error"` mode **holds** the commit (or the chunk,
  in order) until it settles; that is safe because `headersSent` reads only the
  native response and the pipeline waits on it (§2.9).
- A *reject* goes to the layer's `next` (`BunRouter.ts:5474`), so the app's
  error handler renders the `ResponseValidationError`; with none, the
  adapter's 500, and `router.fetch()` rejects with it (H43).
- **Before the body has started, `"error"` is always a clean 500. After it
  has started, it can only cut the stream off** (`res.destroy()` for
  `write()`, `controller.error()` for a piped stream) and log at `error`; the
  status line is already out. The router already runs error handlers for a
  late error and destroys a stream none handles (CLAUDE.md, "Router"), so this
  matches it.
- On a refusal, the refused response's own headers (`Location`,
  `Set-Cookie`, `Content-*`, `ETag`, `Last-Modified`) are dropped and the
  request-wide ones (CORS, `Vary`) kept, so the 500 describes itself (H45,
  Q-H3).
- `"off"` installs no gate at all.

This corrects the first version's hook (inside `json()`/`send()`, before the
`Response` is built): building it is harmless; handing it on is the point of no
return, and one setter covers every kind.

#### 4.4.3 Every body kind

| Body | What the schema sees | When | `"error"` |
|---|---|---|---|
| `json(value)`, `send(object)` | the raw value, not its text | commit | sync vendor decides in place; a Promise holds; a mismatch → `ResponseValidationError` (500) |
| `send(string)`, text or HTML | the string; parsed first when the media type is JSON | commit | 500 |
| `send(Buffer \| Uint8Array \| ArrayBuffer)` | a `Uint8Array`; decoded for `text/*`, parsed for JSON | commit | 500 |
| `send(Blob)` | its bytes, read with `arrayBuffer()` (a Blob reads again, so what is sent is untouched) | commit; **always async, so held for every vendor** | held, then 500 |
| `res.send(new Response(…))` | status and headers from it; the body from `clone()` | commit; held | held, then 500 |
| a handler **returning** a `Response` | not supported by bun-common (return values are ignored, H52) | — | out of scope (Q-H6) |
| `redirect()` | status (a declared 3xx) and headers (`location`); the generated body is exempt | commit | 500, with `Location` dropped |
| `sendFile()` / `download()` | status (200, 206, and the 304/404/412/416 it can answer), headers; the file's bytes **only** under a whole-body schema; `opaque()` declares the type unread | commit, after `stat`, ranges and freshness | held while read, then 500 |
| `send(ReadableStream \| Readable \| async iterable)` | status, headers and media type at the commit; then each chunk via `chunks(S)` through a piped `TransformStream` | commit, then per chunk | before the start 500; after, the stream is errored and logged |
| `write()` / `end()` | the first `write()` commits (it can still be refused, H38); then each write, async verdicts chained in order, `end()` waiting for the chain | commit, then per write | before the start 500; after, `destroy()` and a log |
| SSE (`text/event-stream`) | each event, framed across chunk boundaries; `data` decoded as declared (`data: "json"`, the default, or `"text"`; Q-C13); the schema chosen by the event name (`message` by default); an undeclared name is a mismatch | per event | cut off at the bad event, logged (H23, H24, H39) |
| a stream against a **whole-body** schema | nothing: a stream is never buffered | — | one `warn` per route (H40, Q-H4) |
| `sendStatus()`, `handleNotFound()`, `sendFile` failures, 204/205/304 | status and headers; the body is exempt | commit | 500 |
| `HEAD` | checked as the GET it reuses | commit | 500 on a mismatch (H41) |
| a freshness 304 for a conditional request | allowed without being declared (Q-H1) | — | — (H42) |
| an error handler's own response | checked and **only reported** (Q-H2) | commit | logged, never replaced (H44) |

All of it is measured through `router.fetch()` for each kind × `off`/`warn`/
`error` × zod and yup (H1–H24): `off` sends the bad body, `warn` sends it and
logs once, `error` answers 500 for every buffered kind and cuts streams off
with an `error` log, and every **good** body answers 200 under `error` with
both vendors.

#### 4.4.4 Typing

```ts
status<const C extends AllowedStatus<TResponses>>(code: C): BunResponse<_, NarrowResponses<TResponses, C>>;
json<T extends JsonBodyFor<TResponses>>(body: T): BunResponse;              // application/json and *+json bodies
send(body: SendBodyFor<TResponses>): BunResponse;                           // every declared body, or a native Response
set<N extends string, V extends HeaderValueFor<TResponses, N>>(name: N, value: V, replace?: boolean): this;
header<N extends string, V extends HeaderValueFor<TResponses, N>>(name: N, value: V): this;
cookie<N extends string, V extends CookieValueFor<TResponses, N>>(name: N, value: V, opts?: BunCookieOptions): this;
redirect(url: RedirectUrl<TResponses>): BunResponse;                        // 302 must be declared
redirect<const C extends RedirectStatus<TResponses>>(status: C, url: string): BunResponse;
```

- **The server is held to the schema's input, or its output when the input is
  `unknown`** (the first version's correction, §4.3 there, measured in
  `response-typing/`): a `z.date()` field must be a `Date` on the server; a
  `toStandardSchema<User>` wrapper binds by its output.
- `set()`/`header()` constrain a **declared** name (in any case) and leave any
  other name free; `cookie()` constrains a declared name's value; `write()` is
  not typed per event (typed SSE writes come with the writer, §4.7).
- **18 negative controls fire** (`types.probe.ts`, N1–N18): wrong body for a
  status, undeclared status, text where only JSON is declared, a wrong header
  value type, an undeclared cookie read, a typed header read, among others;
  the probe against **unpatched** bun-common fails 25 times. Typing
  `set`/`header`/`cookie` broke 35 internal `this` call sites in the class,
  which one private `#self` getter fixes (Q-H13); a typed `res` still passes to
  a helper that takes a bare `BunResponse`.
- **Boundaries** (compile, by design): a helper taking a bare `BunResponse`
  escapes; separate `res.status(200); res.json(b)` is held only to the union;
  a declared status never sent is not an error.

#### 4.4.5 Policy settings and cost

`responseValidation: "off" | "warn" | "error"` on a validator, a router and an
adapter (the most specific wins); default `"off"` (Q2). Measured per request
through the pipeline, zod, minimum µs [M `http-complete` bench, run 2: 15
rounds, load 18.0 → 15.6 on 16 cores; medians within 25% of the minimums]:

| Kind | Base | `off` | `error` | Gate cost |
|---|---|---|---|---|
| json, 20 items | 3.28 | 3.24 | 6.01 | +2.77 |
| text | 1.97 | 2.09 | 3.36 | +1.27 |
| html | 2.49 | 2.84 | 3.85 | +1.01 |
| Buffer | 2.57 | 2.77 | 4.21 | +1.44 |
| Uint8Array | 2.35 | 2.46 | 3.46 | +1.00 |
| Blob | 2.79 | 3.12 | 5.51 | +2.39 |
| native `Response` | 3.60 | 3.67 | 11.95 | +8.28 |
| redirect | 3.93 | 3.98 | 5.59 | +1.61 |
| `sendFile` | 28.99 | 28.50 | 44.26 | +15.76 |
| `ReadableStream`, 4 chunks | 4.56 | 4.47 | 16.08 | +11.61 |
| `write`/`end`, 4 chunks | 8.86 | 9.38 | 11.56 | +2.18 |
| SSE, 4 events | 9.31 | 9.91 | 17.63 | +7.72 |
| request headers + cookies | 2.95 | — | 5.91 | +2.96 |

`"off"` costs nothing beyond the validator; the dearer kinds are those that
must read something (a cloned `Response`, a file) or wrap a stream. yup was not
re-measured; the first version's figure, +228 µs per request in `"error"`,
stands (it always answers with a Promise). Hence the default `"off"`, and the
README's advice: `"error"` in development and tests, `"off"` or `"warn"` in
production.

**bun-jobs' `validateResponses`** keeps its boolean and accepts the modes
(`true` = `"warn"`), so the two speak one vocabulary (V4).

#### 4.4.6 Response variants (V3c)

[D, M [`evidence/response-variants/`](evidence/response-variants/README.md)]
**The need, the user's (2026-10-21)**: within **one** status the response
differs by who asked or by what it carries. An admin, recognised by a request
header, gets another body and headers; a request cookie, or a response header
or cookie, changes what is sent. A union per part, which V3a already accepts,
fails three ways: it cannot tie the parts together (`x-admin: 1` with a
`UserView` passes), it cannot tie the response to the request (a non-admin
answered with the `AdminView` passes: a leak), and it types `res` as the union
in every branch. V3c fixes all three for the cases the spike covers, and
states where the fix stops (the leak limit below).

**The declaration** [D, M]:

```ts
validate(
  { headers: z.object({ "x-admin": z.literal("1").optional() }) },
  {
    responses: {
      200: variants(
        {
          admin: {
            when: (valid, req) => valid.headers["x-admin"] === "1",   // valid: the parsed parts, typed; may be async
            headers: z.object({ "x-admin": z.literal("1") }),
            content: { "application/json": AdminView },
            description: "to admins (x-admin: 1)",                    // for documents: a `when` cannot be
          },
          user: { content: { "application/json": UserView } },       // no `when`: for every request (optional)
        },
        { by: { header: "x-admin", values: { admin: "1", user: null } } },  // optional: the response selects
      ),
      404: Problem,
    },
    responseValidation: "error",
  },
);

res.status(200).variant("admin").json(adminView);   // narrowed; x-admin: 1 filled, undeclared fields stripped
res.status(200).json(body);                         // the union, as V3a types it; nothing adjusted
```

```ts
function variants<
  const T extends Readonly<Record<string, VariantSpec<V>>>,
  const B extends Discriminant<keyof T & string> | undefined = undefined,
  V = UntypedValid,                      // inferred from validate()'s schemas; UntypedValid under commonResponses
>(table: T, options?: { by?: B; refine?: Refine }): ResponseVariants<T, B, V>;

interface VariantSpec<V> extends ResponseSpecObject {      // headers, cookies, content: V3a's own spec
  when?: (valid: V, req: BunRequest) => boolean | Promise<boolean>;  // a boolean decided in place; absent: every request
  refine?: Refine;                                         // a whole-response check after the parts pass
  description?: string;                                    // what documents say instead of the `when`
}
type Discriminant<N extends string> =
  | { header: string; values?: { [K in N]?: string | true | null } }   // default: each variant's name
  | { cookie: string; values?: { [K in N]?: string | true | null } };  // true: present; null: absent
type Refine = (response: RefineResponse, req: BunRequest) => readonly RefineIssue[] | undefined;
interface RefineResponse { status; headers; cookies; mediaType; body; variant }   // as the gate saw them
interface RefineIssue { part: "status" | "headers" | "cookies" | "body"; path?: string; message: string }

// BunResponse: narrows (literal fields optional, LiteralOptional), records, and adjusts at the commit
variant<const N extends VariantNames<TResponses>>(name: N): BunResponse<_, NarrowVariant<TResponses, N>>;
```

**One mechanism, not two** [D, M RV1–RV8]: a variant is **acceptable** for a
response when it is **selected**, its **`when` holds**, and **every part
matches, whole** (then its `refine`). `when` (on the request) and the
discriminant (on the response) are two filters on the same candidate set, so
the user's item 4 needs no second feature:

1. **Selected**: the variant `res.variant()` named; else the one the
   discriminant's value selects; else every variant. The two must agree when
   both are present (RV8a–b, RV6c).
2. **Applicable**: the selected variants whose `when` holds, one call per
   variant that has one (RV12: 8 variants, 8 calls; a status with no variants,
   0). A `when` that answers a Promise is awaited, holding the commit. For a
   named variant whose `when` holds, `.variant()` now **adjusts** the
   response (below).
3. **Matched**: the first applicable variant whose headers, cookies, media
   type and body all pass, cheap parts first, each variant stopping at its
   first failing part. A part is never taken from one variant and another part
   from another (RV2: `x-admin: 1` with a user body is refused, with each
   variant's own issues).

**The decisions**:

- **No variant applicable is a mismatch** (RV5; Q-H16, answered), refused
  under `"error"` and logged under `"warn"`, like an undeclared status. There
  is no implicit fallback. **A default variant is optional**: no status needs
  one, and a table where every variant has a `when` is complete (RV5's is).
  A variant with no `when` is only how to declare a fallback, for the authors
  who want one. The issue: `No variant of this status applies to this request
  (2 excluded by when)`.
- **`when` reads `req.valid`, typed by the validator**, plus the raw request
  second, for what no schema parsed (an auth middleware's `req.user`). Its
  parameter is exactly the parsed parts: `Equal<typeof valid, { headers: {
  "x-admin"?: "1" }; cookies: { sid?: string } }>` holds, inferred through the
  nested `variants()` call with nothing restated; reading a part no validator
  parsed is a type error (VT7), and so is comparing a parsed header with a
  number (VT8) [M]. **A part with no validator is absent**: from the type, and
  `undefined` at runtime, so a `when` reading it answers `false` and does not
  throw (RV11). Under `commonResponses` (a router has no validator) the view is
  `UntypedValid`, every part optional and `unknown`. Under a mount, a route's
  `when` is typed by its own validator while `req.valid` holds every layer's
  parts at runtime (B3, [I]).
- **`when` runs at the commit**, never at request time (the status is
  unknown until then), and **may be asynchronous** (Q-H17, the user's answer
  of 2026-10-21), with a fast path [M RV10b–e]. A `when` that returns a
  boolean is decided in place: no Promise is made and a sync verdict stays
  sync (RV10c). One that returns a Promise is awaited, holding the commit as
  an async vendor does (RV10b), and must resolve to a boolean. A non-boolean
  (VT9, VT18 in the types; RV10d), a throw (RV10a) or a rejection (RV10e) is
  a **failed check**: under `"error"` a 500 with `The response could not be
  checked`, the error itself logged and never in an issue. It still takes
  `(valid, req)`.
- **The discriminant** (`by`): a response header or a `Set-Cookie` name;
  `values` maps each variant to the value that selects it (default: its name),
  a string matching exactly, `true` any value, `null` absence, tried in that
  order. Two variants on one value, a `values` key naming no variant, and an
  empty `variants({})` are `TypeError`s (RV14), and the second a type error
  too (VT14). A value that selects nothing is refused on `headers.<name>` (or
  `cookies.<name>`) with the **declared** values, never the received one:
  `Does not select a variant (expected full, summary)` (RV6f–g). The
  discriminant turns N body checks into one, and is what lets a typed client
  tell variants apart (below). `null` exists because "this header must be
  absent" in a headers schema is vendor-specific: zod 4's `z.undefined()`
  makes the key required, so it is `z.never().optional()` there [M].
- **`res.variant(name)` narrows the types, records the name, and adjusts the
  response** (Q-H18, the user's answer of 2026-10-21; designed below). The gate
  checks that variant alone, its `when` still enforced (RV8a, RV23: named for a
  non-admin request, refused before anything is adjusted). On a status with no
  variants it is a type error (VT5, VT16, VT17) and a runtime issue (RV8c).

**What `.variant()` adjusts** [D, M RV18–RV28]. `.variant(name)` fills what
the variant's schemas allow **exactly one value** for, wherever the handler
did not set it, and strips body fields the variant does not declare, so the
handler writes only what varies. Anything it cannot adjust (a required field
with no single value, missing or wrong, or a value the handler set) is left to
the check like any mismatch: 500 under `"error"`, logged under `"warn"`.
`.variant()` **never throws**; an adjust that fails leaves the response as the
handler made it, and logs.

| What | Filled from | When | Spike |
|---|---|---|---|
| the discriminant header or cookie | `by.values[name]`, an exact string only (`true` and `null` are not one value) | the handler set none | RV18 (`x-view`), RV24 (the handler's own other value is kept, and refused as a disagreement) |
| a declared header | the headers schema's required property with one value | the header is absent | RV18 (`x-tier`), RV22 (a wrong `x-tier` the handler set is kept and refused) |
| a declared cookie | the cookies schema's required property, when its `value` **and every attribute it requires** have one value; `path: "/"` as `res.cookie()` defaults | that `Set-Cookie` is absent | RV28 (`mode` filled with `httpOnly`; `sid`, any value, not fillable: the handler's kept, and its absence refused, RV28b) |
| the status | the one status that declares a variant of that name | `status()` was never called | RV20 (`created` → 201) |
| `Content-Type` | the variant's one declared media type, when it is JSON-classed (`application/json`, `*+json`) and the body is a JSON value | only `json()`'s implicit type is set, never one the handler set | RV18 (`application/vnd.admin+json`) |
| literal body fields | required properties with one value, at any depth inside objects the handler sent, and in every element of arrays it sent; an object or element is never created | the field is `undefined` | RV18 (`kind`, `meta.v`, `items[].k`), RV20 |
| undeclared body fields | removed from every object whose JSON Schema lists `properties` and allows nothing more | always, for a JSON body | RV18 (three removed at three depths), RV25 |

- **How "one value" is found, per vendor** [M]: from the schema's
  **`~standard.jsonSchema.input()`** (the wire side), read once per variant at
  declaration: a property with `const`, or an `enum` of one. Measured on zod
  4.6 (`z.literal("admin")` → `{ "const": "admin" }`, `z.enum(["one"])` →
  `{ "enum": ["one"] }`) and arktype 2.2 (`"'admin'"` → `{ "const": "admin" }`).
  valibot 1.5 and yup 1.7 carry no `~standard.jsonSchema`, nor does
  `toStandardSchema()` without its `jsonSchema` option, so **their variants are
  not adjustable**: nothing filled, nothing stripped (RV26), and V3c says so
  once per variant at declaration (Q-H25). Vendor internals (zod's `_zod.def`)
  are never read: a vendor-neutral rule, or nothing. zod throws converting
  `z.date()` and other unrepresentable types unless asked otherwise, so the
  call passes `libraryOptions: { unrepresentable: "any" }` (an opaque,
  per-vendor option of the Standard JSON Schema spec; zod then writes `{}`,
  which is neither filled nor stripped); a converter that still throws makes
  that schema not adjustable.
- **How stripping works, and its limits** [M RV27]: by JSON Schema, not by the
  schema's output. The output would apply transforms and defaults (a
  `z.coerce.number()`, a `Date`), sending a value of the wrong wire type,
  which is the `"parse"` mode's business (below). An object is stripped when
  its node lists `properties` and has neither `additionalProperties: true` or
  a schema, nor `patternProperties` (zod writes `additionalProperties` only for
  a record or a passthrough object, so a plain `z.object` strips); `$ref`s into
  `$defs` are followed. **Not stripped and not filled**: a union, an
  intersection or a discriminated union (`anyOf`/`oneOf`/`allOf`: RV27 keeps
  a member's extra key; choosing a branch would need the check first), a
  record (its keys stay), tuples, and anything past depth 16. What was
  removed is recorded as a path and a count (`body.meta: stripped 1 undeclared
  field`), never a key name: a key of a user-keyed record is user data
  (§4.1.6).
- **When it runs**: at the commit, before the check, and only after the
  named variant's `when` holds (so a refused response is never adjusted,
  RV23). Headers, cookies, the status and `Content-Type` are adjusted for
  every body kind the gate sees before the status line is out, the first
  `write()` included. The **body** is adjusted only for a JSON value
  (`json()`, `send(object)`): never text, bytes, a `Blob`, a passed-through
  `Response`, a stream, an `opaque()` body or a `sendFile()`. The handler's
  object is **never mutated**: copy-on-write along the changed paths (RV19). A
  body that changed is serialised again into a new native `Response`; the
  `json()` fast path built one already, which is harmless until handed on
  (§2.9). A `.variant()` called after the response committed is too late: it
  is ignored, with one `warn` per route.
- **With the discriminant and `when`**: the order is: select the named
  variant, decide its `when` (a refusal stops here), adjust (the discriminant
  is filled first), then check that the discriminant now selects the named
  variant (a value the handler set for another variant is kept and refused,
  RV24), then check the parts whole. Without `.variant()` nothing is
  adjusted: the gate cannot know which variant the handler meant.
- **Under `responseValidation: "off"`**: V3a installs no gate there, but
  `.variant()`'s adjust is what the handler asked for, and its stripping is a
  privacy measure, so a validator that declares variants installs an
  adjust-only step under `"off"` (no `when`, no check), costing one field read
  when `.variant()` was not named (Q-H29).
- **The types follow** [M VT19–VT21]: after `.variant()`, `json()` and
  `send()` take the variant's body with every required single-literal field
  **optional**, through nested objects and array elements
  (`.variant("admin").json({ id, meta: { at } })` compiles, `kind` and
  `meta.v` filled), only when every JSON body schema of the variant carries
  `~standard.jsonSchema` **in its type** (zod's does, valibot's does not, so a
  valibot literal stays required: VT21). On the union, without `.variant()`,
  nothing is optional (VT19), and a non-literal field never is (VT20). A
  header or cookie a variant fills was already optional to `set()` and
  `cookie()`.
- **What it costs** [M `bench.sh`]: the plan is built once per variant at
  declaration (one JSON Schema conversion per schema). Per response, a walk of
  the declared shape and the body's own keys: see the cost table below
  (`adjust fill+strip`, and `reserialize` for the new `Response` when the body
  changed). A `.variant()` with nothing to change walks the plan and copies
  nothing (the `named` rows include it).
- **Without `.variant()`, `res` is the union**: each variants status enters
  V3a's type map as the **union** of its variants' specs, each tagged
  `variant: N`, and V3a's `SpecField` already distributes over a union, so
  `status()`, `json()`, `send()`, `set()`, `header()` and `cookie()` take the
  union with no change to them (§1 of the probe). The runtime still enforces
  whole matches and `when`.
- **`refine`**, on a variant or on `variants(…, { refine })`, runs after the
  parts pass, synchronously, with the whole response (`status`, `headers`,
  `cookies`, `mediaType`, the parsed `body`, the matched `variant`) and the
  request; its issues go through the core's scrub **against every part**,
  since it sees all of them (RV9b: a message quoting a body value under
  `headers.x-total` came out `Invalid value`) [M]. A plain status's spec
  object takes `refine` too.
- **A plain status is unchanged**: V3a's issues, no `variant` field (RV15);
  `when` on a plain status is a `TypeError` naming `variants()` (RV14).
- **Merging** (`commonResponses`, a mount's validator): a variants status is
  replaced **whole** by a more specific layer's declaration of that status,
  never merged per part. `mergeOutboundDefs` merges per part today
  (`bun-common/lib/responseValidation.ts:320`, `{ ...out[status], ...parts }`),
  so V3c special-cases it (Q-H22).
- **Streams** (`chunks()`, `sse()` in a variant's `content`): the commit
  narrows the candidates by status, headers, cookies and media type; when
  more than one applicable variant remains, each chunk is checked against the
  survivors, a variant failing a chunk dropping out, and the stream is cut off
  when none survives [I, Q-H24]. A discriminant or `res.variant()` avoids it.

**What an issue says** [M RV2, RV3, RV5, RV6, RV16]: never a received value
(§4.1.6), and never which variant was "nearly" matched with values. A refusal
carries a status-level summary (`The response matches no acceptable variant
(admin, user)`), then each **applicable** variant's issues in full, each
tagged with an optional **`variant`** field (a new optional field of the
core's `ValidationIssue`, Q-H19), with its path and the vendor's scrubbed
message. **On the failure path only**, the gate also checks the variants
`when` excluded and names one the response matches in full: `The response
matches variant "admin", which does not apply to this request` (RV3, RV13b).
That is the leak's own diagnosis, and it costs nothing on a passing response.
Variant names are the author's, like statuses; the README says a
`ResponseValidationError`'s issues are for logs, not for the client. Three
planted values (a body field, a discriminant value, a value a `refine` message
quoted) appear in none of the 44 verdicts (RV16).

**The leak limit** [M RV17, RV25]: the gate **checks, it never strips**,
except through `.variant()`. A user view that is a structural **subset** of the
admin view (`z.object({ id })` against `z.object({ id, salary })`) accepts
the admin body, so a non-admin answered with it is **sent** (RV17a); the types
let it through too (B2: no excess-property check on `json()`'s type
parameter). The same table with `z.strictObject` for the user view refuses it
and names the admin variant (RV17b). So variants catch the leak only where the
less-privileged variant's schema rejects what the privileged one adds: a
strict object, a discriminating literal (`role: "user"`, as RV1–RV4 use), or a
discriminant. **`.variant("user")` closes it for the handlers that name their
variant**: the admin-only `salary` is stripped and the user body sent (RV25,
the same loose table as RV17a). The README documents the limit with a
strict-schema example, and the **`"parse"` response mode** (Q5: send the
schema's output, stripping unknown keys) is planned as a follow-up feature,
**V13** in §6, for every response a handler sends without `.variant()`
(Q-H20, the user's answer of 2026-10-21).

**Typing: composes with the real V3a types; the overloads stay
byte-identical** [M `types.probe.ts`, 21 controls, line-exact]. The probe
imports the real `BunRouter` (its generated overloads), `BunResponse`
(`status()` with `AllowedStatus`/`NarrowResponses`, `json`/`send`/`set`/
`cookie`), `InferResponses`, `InferValidatedShape`, `ValidatorMiddleware` and
bun-nest's `BunHttpAdapter`, and adds `.variant()` to the real `BunResponse`
by module augmentation, changing no lib file. Handlers registered through the
real overloads, on both adapters, get the union, narrow with `.variant()`, and
refuse VT1–VT21. `generate-verb-overloads.ts --check` is up to date on the
base (27 and 17 verbs), and nothing V3c changes is an input of the generator:
the overloads name only `MountedHandler`, `ValidatorMiddleware<TShape>` and
`RouterHandler`. **Unchanged**: the overloads, `MountedHandler`,
`ResolvedHandler`, `ResolveResponses`, `TypedRouteHandler`'s `TRes`,
`AllowedStatus`, `NarrowResponses`, `SpecField`, bun-nest's adapter.
**What V3c changes**:

| File (`bun-common/lib/`) | Change |
|---|---|
| `responseBodies.ts` | `variants()` and its types |
| `responseValidation.ts` | the adjust plan per variant, built at declaration from `~standard.jsonSchema` (through the core's `jsonSchemaOf`), and the adjust step at the commit, before the check, also under `"off"` (Q-H29), swapping in a re-serialised `Response` when the body changed; an async `when` held like an async vendor, a sync one decided in place; `ResponseSpec` gains `ResponseVariants`; `ResponseSchemas` takes the `when` view as a defaulted type parameter (`ResponseSchemas<V = UntypedValid>`); `toOutboundDef` compiles variants and refuses the declaration mistakes; `mergeOutboundDefs` replaces a variants status whole; the gate's `#check` gains the three steps (asking only the vendor's result while matching, building issues on the refusal path alone) and the failure-path diagnosis; the chunk gate carries survivors |
| `BunValidate.ts` | the `RS` constraint of `validate()`, `BunValidate.middleware`, `BunValidate` and `BunValidateOptions` becomes `ResponseSchemas<InferValidatedShape<S, H>>`, so `when` is typed: a constraint change, no type parameter added, removed or reordered |
| `types/responseTyping.ts` | `InferResponses` maps a variants status to the tagged union (the spike's `InferVariantResponses`); `VariantNames`, `NarrowVariant`, with `LiteralOptional` for a variant whose body schemas carry `~standard.jsonSchema` in their types (VT19–VT21); `HeaderArg` learns a declared-absent marker, so a discriminant's `null` refuses `set()` (B1; the probe's §7 checks the rule with `Equal`) |
| `BunResponse.ts` | `variant()`, typed by the class's own `TResponses`, recording the name for the gate (a `warn` once per route when called after the commit); two flags the adjust reads: whether the handler set the status, and whether `Content-Type` is only `json()`'s implicit one |
| `contract/model.ts`, `contract/describe.ts` | `ValidationIssue.variant?`; `ContractEntry.variant?` and the variants table on `sides` (below) |

Two things the spike had to get right, each now a requirement: `variants()`'s
discriminant parameter takes `NoInfer` in the return type (without it the
contextual `Discriminant | undefined` became `B`, and every header of every
variant typed as the variant's name), and a declaration is matched with
`infer` for the request view, not `unknown` (its `when` parameter is
contravariant, so the match failed and the status fell back to a plain spec).
Both are in `evidence/response-variants/README.md`.

**`describeContract`** (V1's core) [D]: one row per `(side, key, variant,
part, mediaType)`, each with an optional **`variant`** field, flat rather than
`nested` like V3b's `sse()` rows, because variants share their status's key
space and part names, where SSE events open a new key space (`event`). Each
variants status also appears on the side: `sides.outbound.variants: { "200":
{ names: ["admin", "user"], conditional: ["admin"], by?: { part: "headers",
name: "x-admin", values: { admin: "1", user: null } }, descriptions: { admin:
"…" } } }`. A `when` is a function and is never described; `conditional` and
`description` are what documents get. A generator that ignores `variant` sees
two `application/json` rows for one status, so V12 and TC read the field
(Q-H21).

**Cost** [M `bench.sh`]: the prototype matcher alone (no router), zod, each
scenario in its own process pinned to one CPU, three runs, the **lowest**
minimum in ns per response, 15 rounds of 20,000 after 200,000 warm-up calls;
load 8.5 falling to 5.7 on 16 cores (other sessions' jobs; separate processes
of one scenario differed by up to 3x, so read orders of magnitude). Every
response is accepted; "last" matches the last of N variants with no
discriminant, so N−1 variants fail first.

| Variants | first matches | last matches | last, issues built while matching | `by` header | `res.variant()` |
|---|---|---|---|---|---|
| none (a plain status) | 541 | | | | |
| 1 | 525 | 544 | 413 | 455 | 415 |
| 2 | 437 | 1,138 | 3,312 | 439 | 436 |
| 4 | 473 | 2,170 | 8,374 | 468 | 521 |
| 8 | 619 ¹ | 4,428 | 19,216 | 439 | 436 |

¹ An earlier pinned run (`bench4`); this run's three processes gave
1,748–2,573, the bimodal noise above, against 437–473 at N = 1, 2, 4.

- **`when` costs nothing measurable**: N variants with a `when` each, matching
  the first, stay within noise of a plain status up to N = 4 (one call per
  variant, RV12). With no variants the gate makes no call and no allocation:
  the plain path is V3a's.
- **A discriminant or `res.variant()` makes the cost independent of N**
  (about 0.45 µs here at every N): one variant checked.
- **Without one, each variant that fails before the match costs about
  0.56 µs** (N = 8: +3.9 µs for 7), **if the matcher does not build issues
  while matching**. Building and scrubbing them for every failing candidate,
  as the first version of the spike did, cost about 2.7 µs each (19 µs at
  N = 8). So V3c asks only the vendor's own result ("does it pass") while
  matching and builds issues on the **refusal path alone**, re-running the
  applicable variants in full there (the spike's `matching.flatten`, `FLATTEN=1`
  in `bench.sh`). The refusal path also runs the diagnosis over the excluded
  variants, which costs one check each and only when refusing.
- **`.variant()`'s adjust** (a later run, `bench6`, same method, at a
  higher load, 8.3–10.5, so every row ran slower than above): with one
  variant, `by` 708 ns against `named` 901 ns, the adjust walking its plan
  with nothing to change (about +0.2 µs); `adjust fill+strip` (one literal
  filled, three undeclared fields stripped, a copy made) 1,350 ns, about
  +0.45 µs over `named`; and `reserialize` (a `JSON.stringify` and a new
  `Response`, which V3c adds only when the body changed) 860 ns. So an adjust
  that changes the body costs about 1.3 µs, against V3a's json gate cost of
  +2.77 µs for 20 items (§4.4.5); one that changes nothing, a plan walk.
- So the check stays at the commit gate with one `when` call per variant and
  zero with no variants; the README advises a discriminant, or the most
  frequent variant first, past a handful of variants. A V3a status's own check
  is the gate's, not this prototype's `plain` row; V3c's bench (in
  `http-complete/bench.ts`'s shape, through the pipeline) re-measures the gate
  itself.

**What V3c gives later PRs** (each PR's row in §6 says it too):

- **V7b (Nest responses)**: `@Validate({ responses: { 200: variants({…}) } })`
  takes the same declaration; `when` gets the parts `@Validate` parsed (the
  same `req.valid` view) and the request; the interceptor's `map()` runs the
  three steps on the status, `@Header()` headers and returned body it already
  sees (§4.5.4). `reply(200, body, { variant: "admin" })` names and types a
  variant (Q-N2's helper gains the option). A plain `@Res()` handler calls
  `res.variant()` at runtime on bun-nest, checked by PR-6c's before-write
  hook; it is untyped there (Nest's `@Res()` carries no `TResponses`).
- **V8 (WebSocket channels)**: a `sends` message type may take `variants()`,
  with `when` on the connection (the upgrade request's `req.valid`), for
  `send(ws, …)`. Not for `publish(topic, …)`: Bun's fan-out is native and has
  no per-recipient hook, so a conditional variant published to a topic is
  refused at the call (a `TypeError` in V8's tests). A response discriminant
  adds nothing to a frame, whose only part is `data`: a discriminated union in
  the schema does it.
- **V11 (SSE)**: an `sse({ tick: variants({…}) })` event may take variants,
  `when` on the request that opened the stream (one request per stream, so it
  fits as HTTP's does), checked per event before encoding by the typed
  `SseWriter`.
- **Brokers and other transports (§4.2)**: no request, so no `when`; the
  discriminant generalises as `by: { part, name }` in the core (a message
  header such as `schema-version` selecting the payload schema), when a
  broker package is planned.
- **V12 / AD (OpenAPI)**: a variants status's media type becomes `{ oneOf:
  [Admin, User] }`; a header or cookie only some variants declare is
  `required: false` with a description naming them; and an **`x-variants`**
  extension on the response carries the exact table (names, `conditional`,
  descriptions, the discriminant, and per variant its headers, cookies and
  media types by reference), since OpenAPI's own `discriminator` reads a body
  property, never a header.
- **TC / V12 (the typed client)**: the result union is discriminated by
  `status` and, when the status has a discriminant, by its value: `{ status:
  200; variant: "full"; headers; body: Full } | { status: 200; variant:
  "summary"; … }`, the client reading the header. Without one, variants cannot
  be told apart on the wire, so the client gets V3a's per-part union, unless it
  parses with the schemas (TC §5.4).

### 4.5 NestJS: body, query, headers, cookies, and responses of every kind [D, A]

Agreed with the Nest agent (bun-node-15) on 2026-10-17. bun-nest supports
Nest 11 and 12 together (the nestjs-12-parity plan's Q1), so everything here
works on 11 with nothing of Nest 12's, and on 12 **composes** with what Nest 12
added (§2.9).

#### 4.5.1 `@Validate`

```ts
@Validate({
  params: IdParams, query: Page, headers: ApiHeaders, cookies: Session, body: CreateUser,
  responses: {
    201: { headers: z.object({ location: z.string() }), content: { "application/json": User } },
    409: Problem,
  },
})
@Post(":id")
create(@Validated("body") body: Infer<typeof CreateUser>) { … }
```

- **An interceptor** (it runs before the handler and wraps its result), method
  or class level with per-part merge, on the core: request parts go through a
  receiver guard and are replaced in place as the router middleware does;
  `responses` is the same `ResponseSchemas` as bun-common's (§4.4.1), so one
  declaration documents both adapters. Adopted from AD §3.8 with the changes
  below.
- **Composing with Nest 12** [A, M `nest-interceptor/`]: a parameter's
  `{ schema }` is checked **only if a `StandardSchemaValidationPipe` applies**
  to it (global, `@UsePipes` or param-level): `@Body({ schema })` with no such
  pipe validated nothing, and a bad body got 201. So at bootstrap `@Validate`
  reads the route's argument metadata (`'__routeArguments__'`, from
  `@nestjs/common/constants`, on both majors; entries `"<paramtype>:<index>":
  { index, data?, pipes, schema? }`, `schema` on 12 only; paramtypes BODY 3,
  QUERY 4, PARAM 5, RAW_BODY 12, and COOKIES 14 and SIGNED_COOKIES 15 on 12
  only, since 11.1.27's enum ends at ACK 13) and **skips a part only when that
  parameter's `data` is undefined (it covers the whole part, not one property:
  `@Query('page', { schema })` covers `page` alone) and the pipe applies**.
  Otherwise it checks the part itself, and the README documents the overlap.
  It still records every schema in the route's contract, so documents see it.
  `@Headers`, `@Cookies` and `@SignedCookies` take no `schema` on 12, so
  `@Validate` always owns those parts. **RAW_BODY counts as a raw-body part,
  never `body`**: Nest maps it to `'custom'`
  (`@nestjs/core/pipes/params-token-factory.js`), which the pipe checks only
  with `validateCustomDecorators: true`, and a `@RawBody({ schema })` checks
  the `Buffer`, so it never makes `@Validate({ body })` skip. Interceptors run **before** pipes, so an
  in-place replacement by `@Validate` hands Nest's pipe an already-parsed value;
  the skip rule is what keeps one parse per part. On Nest 11 none of this
  exists and `@Validate` does all of it. Q-N1 asks the user to confirm compose
  over replace.
- **The serializer's order is the interceptors' order** [M]: on 12, an outer
  `StandardSchemaSerializerInterceptor` sees `@Validate`'s pass-through value,
  an inner one hands `@Validate` its serialized output. A method-level
  `@Validate` inside a global serializer checks the handler's return; a global
  `ResponseValidationInterceptor` outside a method-level serializer checks the
  serialized output. The README states the rule, and V7b tests both placements.
- **`@RawBody({ schema })`** is validated by Nest only with
  `StandardSchemaValidationPipe({ validateCustomDecorators: true })`, receiving
  a `Buffer` [M]; otherwise `@Validate({ body })` covers a raw body, and the
  README says so.
- The middleware form (`adapter.use(validate(...))`) runs **below** Nest's
  pipeline: its errors reach the adapter's error handler, never a Nest filter
  (AD §3.8). `@Validate` is the Nest route.

#### 4.5.2 Typing parameters, headers and cookies

- **`SchemaDto(S)`** (first version, measured [M `nest-schema-dto.ts`]) gives a
  parameter its type from the schema with nothing restated: `class
  CreateUserDto extends SchemaDto(CreateUser) {}`, then `@Body() body:
  CreateUserDto`. A union output cannot be a class (TS2509) and uses
  `Infer<typeof S>` instead.
- **`@Validated(part)`**, one parameter decorator for any validated part
  (`"headers"`, `"cookies"`, `"signedCookies"`, `"params"`, `"query"`,
  `"body"`), reads the request's `req.valid` view (§4.3.3), so a coerced header
  arrives coerced. **No `@Cookies()` of ours**: Nest 12.1 has one, and a
  second would clash [A]. The name is §9's.
- **The return type** is held to the declared bodies (AD §3.8, the input/
  output rule). Per-status typing needs a typed result; the design offers a
  `reply(status, body, { headers? })` helper whose type is the route's
  declared responses, which the interceptor unwraps (Q-N2), alongside the
  plain return, which is checked against the status Nest will send.
- After nestjs-12-parity PR-5, `*name` params are `string[]`, so a wildcard
  route's `params` schema and `SchemaDto` take an array; the type tests carry
  one [A].

#### 4.5.3 One `StandardSchemaPipe`, and `StandardValidationPipe`

From the first version (§4.4.2–§4.4.3 there), on the core: one
`StandardSchemaPipe(schema)` at bun-nest's root for controllers, gateways and
job handlers (replacing NTR's and NJD's two), and a global
`StandardValidationPipe` that validates every `SchemaDto` parameter and passes
the rest through, the way `ValidationPipe` finds class-validator DTOs. On Nest
12, `StandardSchemaValidationPipe` and `@Body({ schema })` already serve
per-parameter schemas, so the README presents ours as the Nest 11 path and the
`SchemaDto` path, and shows Nest 12's beside them (Q-N1).

#### 4.5.4 Responses: status, headers and every body kind

What an interceptor's `map()` sees, measured by bun-node-15 on Nest 11.1.27
and 12.1.3, on `ExpressAdapter` and bun-nest's `BunHttpAdapter` (all four
identical) [M `nest-interceptor/`]:

| Case | Seen in `map()`: status / headers / sent | On the wire |
|---|---|---|
| GET | 200 / – / no | 200 |
| POST | 201 / – / no | 201 |
| `@HttpCode(202)` | 202 / – / no | 202 |
| `@Header('x-a', '1')` | 200 / `x-a` / no | `x-a` |
| `@Redirect('/x', 301)` | 200 / no `location` / no | 301 + `location` |
| `@Res({ passthrough: true })`, `status(203)` | 203 / `x-b` / no | 203 |
| plain `@Res()` | `map()` **still fires**, with a discarded value; 206 / headers / **sent** | 206 |
| `StreamableFile` | 200 / no `content-type` yet / no | — |
| `@Sse()` | events arrive after the headers are committed | — |

- **The status and `@Header()` headers are already set when `map()` runs**:
  `RouterExecutionContext.create` calls `setStatus` (the `@HttpCode` value, or
  201 for POST, 200 otherwise) and `setHeaders` **before**
  `interceptorsConsumer.intercept`, on both majors
  (`@nestjs/core/router/router-execution-context.js`: `setStatus` and
  `setHeaders` at `:43-46` and `intercept` after them on 11.1.27; `setStatus`
  at `:52` and `intercept` at `:67` on 12.1.3) [S, M]. So
  `@Validate` reads the status from `res.statusCode` and the headers from the
  response object directly. What `map()` cannot see yet is applied later by
  `reply`: a redirect (taken from `REDIRECT_METADATA`, overridden by a returned
  `{ url, statusCode }`, default 302) and `StreamableFile`'s headers (from
  `file.getHeaders()`). The first version's "map() runs before Nest applies
  them" was an inference that this measurement refutes.
- **Declared non-2xx responses never reach `map()`** (a `409: Problem` is
  thrown to the filters): `@Validate` checks the status in `catchError`, and
  such a body can be checked only in a filter or the before-write hook below.
- **A before-write hook is still needed, but only for what `map()` cannot
  see**: redirects, `StreamableFile`, plain `@Res()` and headers an adapter
  sets. It is **not** `setOnResponseHook`: in platform-express that runs on
  `res.on('finish')`, after the response is sent, and only logs errors (both
  majors; 12's docs say "after the response has been sent"), and PR-6c keeps
  that for parity [A, S]. It is **"PR-6c's before-write hook (name TBD)"**, a
  separately named hook on bun-nest's adapter, designed in PR-6c. On Express
  or Fastify adapters those cases are checked as far as `map()` and the filters
  reach, and the README says which.
- **Plain `@Res()`**: `map()` runs **after** the response is sent, with a
  discarded value [M], so `@Validate` detects a `RESPONSE` or `NEXT` parameter
  without `passthrough` at bootstrap and skips the response check there rather
  than throwing after the send; on bun-nest the before-write hook covers it.
- **Body kinds** follow §4.4.3: a returned object is the JSON body;
  `StreamableFile` is checked by its headers and type, its bytes only under a
  whole-body schema (`opaque()` otherwise); a redirect by its status and
  `location`; `@Sse()` per event (§4.7.2).
- **A standalone `ResponseValidationInterceptor`**, global, reads each
  route's contract and checks every declared route, so one line turns checks
  on in development.

#### 4.5.5 Filters

`ValidationExceptionFilter` catches BunValidate's `ValidationError`,
`ResponseValidationError` and the pipes' errors and answers `{ error, issues }`
with the error's status; opt-in and `@Catch`-scoped. NTR's
`ProblemDetailsFilter` stays the problem+json option. nestjs-12-parity PR-2
changes how body-parse errors reach filters on 12 (`mapException`), so the
filter is tested on both majors after PR-2 [A].

**As built in V6** (the user's decision, 2026-10-21): in a gateway
(`@UseFilters`) the filter already emits V9's frame shape, an `exception`
event with `{ status, code: "VALIDATION", issues }` (§4.6.2), through Nest's
own `WsException` emission; HTTP keeps `{ error, issues }`. The pipes'
error is `StandardValidationException`, a `BadRequestException` carrying the
issues, exported with the options type `StandardValidationPipeOptions`.

#### 4.5.6 Composing with other platforms and class-validator

Unchanged from the first version's table (§4.4.6 there): the pipes,
`SchemaDto` and the filters are platform-neutral; `@Validate`'s in-place
replacement uses `Object.defineProperty` for Express 5's getter `req.query`
[I]; class-validator DTOs keep `ValidationPipe`, and `StandardValidationPipe`
passes them through, so both can be global.

**A name clash to document** [A]: class-validator exports a `@Validate(constraint)`
decorator (its public API; not installed in this repo). An app using both
imports one under an alias (`import { Validate as ValidateRoute } from
"@kingsleyweb/bun-nest"`); the README shows it. `@Validated` clashes with
nothing in Nest 11 or 12.

### 4.6 WebSockets [D]

#### 4.6.1 bun-common: channels on the core (TC's `defineChannel`)

```ts
const chat = defineChannel({
  path: "/rooms/:room",
  receives: { say: Say, typing: null },        // client → server, keyed by `type`; null: no data
  sends: { said: Said, error: ChannelError },  // server → client
  messageValidation: { in: "error", out: "warn" },
});
router.ws(chat.path, chat.handler({
  say(ws, msg) { chat.publish(ws.data.params.room, "said", { by: ws.data.custom.user, text: msg.text }); },
}));
```

- A channel **is a WebSocket contract** (`inbound` and `outbound` keyed by
  `type`, part `data`) plus a path; its handler carries the contract
  (`attachContract`), and AD (e)'s `WsChannelDoc` reads it through
  `describeContract`.
- **Incoming**: parse JSON, receive through the guard; **an invalid frame gets
  an error frame and the socket stays open**: `{ type: "error", id?, code:
  "VALIDATION", status: 400, issues }`, the bun-jobs socket's shape plus
  `issues` (`bun-jobs/lib/api/ws/session.ts:1590-1603`). `closeOnInvalid:
  true` closes with 1007 instead. An unknown `type` is the same error with
  `code: "UNKNOWN_MESSAGE"` (the core's `target: "type"` issue).
- **Order is kept**: a socket's frames are received and handled through one
  promise chain, so an async vendor never reorders them (bun-jobs' `#work`
  chain, `session.ts:468`); a sync vendor never awaits.
- **Outgoing**: `chat.send(ws, "said", data)` and `chat.publish(topic, …)` are
  typed by `sends` (the sender rule) and checked by the sender guard under
  `out`; `"error"` throws to the caller instead of writing.
- **Binary frames** are not validated unless the channel declares `binary:
  true`, when the schema sees a `Uint8Array`.

#### 4.6.2 bun-nest gateways

`@ValidateMessage(schema, { ack })` and `@Emits({ event: schema })` (NTR §7,
PR-N5) on the core; `@MessageBody(new StandardSchemaPipe(S))` and, on Nest 12,
`@MessageBody({ schema })` work without them. Nest's `BaseWsExceptionFilter`
sends `status: "error"` (a string) and `cause: { pattern, data }`, the
client's own message, not issues [A, S]; a `WsException` built with an
**object** is emitted verbatim. So `WsValidationFilter` maps a
`ValidationError` or the pipe's error to `new WsException({ status: 400, code:
"VALIDATION", issues })`, the same fields as bun-common's error frame (§4.6.1),
rather than relying on `cause`. On 12 the frame shape holds only after
nestjs-12-parity PR-2 with its Q4(a), so V9 depends on PR-2.
Today's frame parse is a cast (`bun-nest/lib/BunWebSocketAdapter.ts:962-964`);
a gateway with a contract receives through the guard instead.

### 4.7 SSE on both HTTP adapters [D, M `http-complete` H21–H24, H39]

#### 4.7.1 bun-common

An SSE endpoint's contract is the HTTP request's inbound side plus an
**SSE outbound side keyed by event name**, parts `data` and `id`
(`transports.ts`'s `sse`). Two ways to declare it, one check underneath:

- **On the response contract**: `responses: { 200: { content: {
  "text/event-stream": sse({ tick: Tick, done: null }) } } }`. The chunk gate
  frames events across chunk boundaries, decodes `data` as declared
  (`sse({...}, { data: "json" | "text" })`, default `"json"`; Q-C13),
  picks the schema by `event:` (`message` by default), and treats an
  undeclared name as a mismatch. Measured with zod and yup: `"warn"` passes
  and logs; `"error"` cuts the stream at the bad event and logs at `error`
  (H23, H24, H39). This works for a hand-written `write()` stream today.
- **On the writer** (bun-native-routes PR-sse2, which this plan's lead owns):
  `res.sse({ contract })` returns an `SseWriter` whose `send({ event, data,
  id })` is **typed** by the contract (the sender rule) and checked by the
  sender guard **before** the event is encoded, so under `"error"` a bad event
  is refused to the caller and never cut mid-stream. Typed SSE writes are
  §8 Q-H10 ("later" in the spike; this plan proposes them with PR-sse2).
- Heartbeats and comments are not events and are never checked.

#### 4.7.2 bun-nest

`@Sse()` stays Nest's API (bun-native-routes PR-sse3 adds no decorator).
`@Validate({ responses: { 200: { content: { "text/event-stream": sse({...}) } } } })`
checks each emitted `MessageEvent` against its `type`'s schema in the
interceptor's `map`, before Nest writes it [A]. Under `"error"`:

- **A synchronous first event** (`of(...)`) fails before the headers are
  committed, so Nest answers 500 through the filters [M
  `nest-interceptor/out-sse.txt`: Nest 11.1.27 and 12.1.3, Express and
  bun-nest adapters alike].
- **After the commit**, Nest writes `event: error` with `data: err.message`
  **verbatim** and logs nothing [M the same file: a planted `secret-value`
  reached the client in the `error` event; S `router-response-controller.js`],
  so the message `@Validate` throws must already be scrubbed (§4.1.6: no
  values), and `@Validate` logs the mismatch itself.
- A side observation from the same run: Nest 11 omits the `data:` line for a
  falsy `data` (`0`), which 12 sends; the per-event check sees the value
  either way.

### 4.8 bun-jobs: data, results and flows [D, A]

Designed with the Jobs & Telemetry agent (bun-node-e9), from its survey of
the code at `68023d36` (§2.9) and its nine constraints. e9 builds V4, V5a,
V5c and V5b in bun-jobs; this plan's lead reviews.

#### 4.8.1 The declaration

```ts
jobs.define("sendEmail", async (job) => send(job.data.to), {
  attempts: 5,
  schema: { data: z.object({ to: z.email() }), result: z.object({ id: z.string() }) },
});
```

- **`define()` lifts `schema` out into `definition.schema`, so
  `definition.options` stays plain data** [A]: `GET /definitions`
  JSON-serialises `definition.options` (`api/routes/repeatables.ts:141-143`)
  and `#routeJob` passes options on as job defaults (`BunJobs.ts:1090`), so a
  vendor schema left inside them would leak into both. `BunQueue` and
  `BunQueueWorker` options lift it the same way.
- **Types**: a definition with a schema infers `job.data` and the handler's
  return from it; `JobMapFromSchemas<typeof schemas>` types a whole registry
  through today's `JobMap` (`queue/types.ts:266`). A bare `BunQueue` or
  `BunQueueWorker` takes `schema` in its own options.
- A definition is a **jobs contract** (`inbound: { data }`, `outbound: {
  result }`) and carries it, so `/definitions` and documents read it through
  `describeContract`.

#### 4.8.2 Where data is checked

**In `BunQueue`, not the definitions router** [A], because `add`, `addBulk`,
`addFlow` and the API's add route never consult the definitions today (§2.9);
the queue learns its context's schemas.

| Write of data | Check | On failure |
|---|---|---|
| `add`, `now`, `run().start()` | before the record is built | the add rejects with `JobDataValidationError` (issues, target `"data"`); nothing is written |
| `addBulk` | **one pass over every item before the first write** | the whole bulk rejects; nothing is written |
| `addFlow` | an async pass over **every node**, each against its own name's definition, after `#planFlow` and before the first `addJob` (`BunQueue.ts:1494-1635`) | nothing is written. A crash mid-write can still orphan children, as today (no driver adds a flow atomically); out of scope |
| `update`, `Job.updateData`/`update` | before the write | rejects with `JobDataValidationError` (target `"data"`), as an add does; the job is unchanged |
| a debounce into a pending job: the new add's data **replaces** the pending job's (`updateJob(…, { data })`, `BunQueue.ts:2647-2655`) | the new add's data, checked like any add, **before** `updateJob` | the add rejects; the pending job keeps its data |
| a repeat series | **once, at series creation**, including the "no occurrences left" branch, which writes the series first today (`BunQueue.ts:3076-3087`) | rejects with `JobDataValidationError` |
| the management API's add, update (`PATCH /queues/:queue/jobs/:id`) and flows (`POST /queues/:queue/flows`, `api/routes/flows.ts:238-317`) routes | **always**, whenever the definition has a schema, whatever the policy says: HTTP data never skips the check [A]; a flow's nodes each against their own name's definition | the existing `VALIDATION` problem, **400**, with the issues; a flow's at body paths (`children.0.data.to`), as its `ruleIssues` reports them today (`flows.ts:135-174`) |

- **Store the input, hand the handler the output** [A]: a schema may
  transform (coerce, default, `Date`), and a stored job crosses JSON. So the
  enqueue check validates and stores what the producer sent; the processing
  check re-runs the schema and hands the handler the output. A schema must
  therefore accept its own input every time it runs (documented).
  `storeOutput: true` for transform-free schemas is Q-J1.
- **No schema, no cost** [A]: a queue with no schema takes no extra await or
  allocation per job (§4.1.6); enqueue throughput is benchmark-guarded
  (`bench/queue.ts --compare`, including the overtaken check), and V5a must
  pass it.
- Async vendors are fine at enqueue and before the handler, both already
  async.
- **The policy per site** [A], `dataValidation: { enqueue, process }`:

  | Site | `"error"` (default) | `"warn"` | `"off"` |
  |---|---|---|---|
  | `enqueue` | reject; nothing written | written; one warn, no values | no check |
  | `process` | `UnrecoverableJobError` (§4.8.3) | the handler runs with the **stored input**; one warn | no check |
  | the management API's routes | always checked; `"warn"` and `"off"` are ignored there | | |

#### 4.8.3 Where processing is checked, and what the handler gets

- **Once, in `BunQueueWorker#process`, before `target.run` or the processor**
  (about `BunQueueWorker.ts:2887-2893`) [A]. That covers bare workers, the
  registry worker and every executor, and the schema never has to load inside
  a sandbox. The registry worker's dispatch (`BunJobs.ts:1286-1299`) covers
  only `define()`d jobs, so it is not the home.
- **In-process**, the handler gets the parsed output. **Isolated targets**
  (Worker, child process, container) receive the raw `JobRecord` over JSON or a
  structured clone (`workerTarget.ts:871-872`), so the output replaces
  `record.data` **only in the copy sent to the executor**, never in the stored
  record, and every attempt (retries included) re-validates from the stored
  input. That copy must survive the trip: a transform producing a `Date` or a
  `Map` arrives degraded. Q-J2 recommends sending the output after a
  `jsonClone`, so a coercion reaches every target; an output that cannot be
  cloned (a `BigInt`, a cycle) fails the attempt as unrecoverable, naming the
  definition and the target, and never silently sends the input instead. The
  in-process handler and an isolated one can then see different values for a
  non-JSON transform (`Date` against its string); the README says so.
- **Deploy skew is the real hazard** [A]: a job enqueued under schema v1 may be
  processed by v2. So the processing-side outcome is **its own policy**,
  `dataValidation: { enqueue, process }`, defaulting to unrecoverable at
  processing (`UnrecoverableJobError`, straight to `dead`; the worker matches
  it by class or by name, so isolated targets count). The error names the job,
  the definition and the issues, **never the data**.
- **Schemas live in code** [A]: a worker in another process, thread, remote
  host or summoned unit checks only if its own definition has the schema. A
  bare `BunQueueWorker` with no schema checks nothing; that is not an error,
  and the README says so. Remote executors keep their own handler registry; a
  check there waits for the gateway.

#### 4.8.4 Results, and flows

- **Results are checked in `#settle`, before `storedResult`/`completeJob`**
  (`BunQueueWorker.ts:3087-3157`) [A], under `resultValidation`, default
  `"off"`:
  - `"error"`: a refused result throws there, so the attempt fails through
    `#recordFailure`, **retryable** like any thrown error (the processor may be
    fixed by a retry), with a `failed` event. No `completed` event fires,
    locally or published, and no `returnValue` is stored or delivered to a
    parent: nothing downstream sees it.
  - `"warn"`: everything gets what it gets today (the raw value locally,
    `returnValue: result ?? null` published), plus one warn, no values.
  - **What is stored** is what the handler returned (validated), not a
    transformed output, for the same reason as data; a transforming result
    schema's output is used for the check alone. Storing the output joins Q-J1.
  - An async result schema delays completion; documented.
- **Flows** [A]:
  - Each node's data is checked against **its own name's** definition, in the
    pre-write pass above.
  - Children are keyed **`queue:id`** (`drivers/flow.ts:11-13`), not by name
    (two children may share one), so `getChildrenValues()` keeps its keys and
    gains a type mapping each key to its child's result: the flow's declared
    shape types the parent's view (`recordOf` in the core composes the
    children's result schemas, spiked in C21).
  - A child's result is the same stored value the parent receives, and it was
    checked at `#settle` under the **child's** result policy, so the parent
    needs **typing only**, no second check. With the child's policy `"off"`
    the parent's types are a claim, not a guarantee; the README says so.
  - A child that may fail (`ignoreFailure`) is typed `T | undefined`
    (Q-C9).

#### 4.8.5 Alignment (V4)

`s` gains `~standard.jsonSchema` (`{ input, output }` returning its `.json`),
so AD's converter reads it on the primary path; `validateResponses` accepts the
modes; the four issue-flattening copies may adopt `validateStandard`. The
OpenTelemetry plan's `validation.failed` span event uses the core's `onIssues`
hook (§4.1.6) [A].

### 4.9 Future transports

§4.2: no packages, no integrations; the extension point and its two spike
adapters are the deliverable, and V1 ships the "Writing a transport" guide.
When one of these packages is planned, its plan declares its transport on the
core and states its refusal mapping (§4.2's table).

### 4.10 bun cache [D]

Unchanged from the first version (§4.7 there): BC §3.13's `validate: {
"user:*": UserSchema }` runs through `validateStandard`; a failing value is a
miss plus an `error` event carrying issues with target `"cache"`;
`validateOnWrite` checks a `set` before storing; `cacheResponse()` sits before
`validate()` (BC §9.6), so a replayed hit is not re-checked (it was checked
when stored). A cache key pattern is the cache's key, so a cache is one more
contract (`outbound` keyed by pattern), readable for documents like the rest.

### 4.11 The typed client, OpenAPI and AsyncAPI: what they read [D]

Every consumer reads **one runtime structure**: the contract a carrier holds
(§4.1.5).

| Consumer | Reads | From | Becomes |
|---|---|---|---|
| OpenAPI generator (AD (a), (b)) | the router's layers, each layer's contract via `getContract`, and `describeContract` rows | validator middleware, `@Validate` routes | `parameters` (params, query, headers, cookies), `requestBody.content`, `responses[status].headers`, `.content[mediaType]` |
| AsyncAPI generator (AD (e)) | channel, SSE and broker contracts | `defineChannel` handlers, SSE endpoints, transports' handlers | `channels`, `messages` keyed by `type`/`event`/`topic`, `payload` |
| The route model (TC PR-M1) | the same rows as OpenAPI, plus the path and method from the layer | router layers | `ModelRoute.request.{params, query, body, headers}`, plus **`cookies`** (new), and `responses[status]` with **headers and media types** (new) |
| The typed client (TC) | types: `Jsonify<WireInput<…>>` per route and status, the wire side (§4.1.4, M2), and the schema's output only when the client parses with it (TC §5.4); inputs held to `WireInput` | the route model's types and rows' `encoding` | a result union discriminated by `status` (the spike's `HttpResult<C>` in `transports.ts` used the output and is corrected) |
| bun-jobs `/definitions` (V5b) | each definition's contract | `define()` | each definition's data and result JSON Schema (`{}` and a warning when a vendor has none) |

- **JSON Schema conversion stays AD's**: `~standard.jsonSchema` first (zod 4,
  arktype 2, and `s` after V4), a vendor table next; valibot, yup and
  `toStandardSchema` have none today [M `results-vendors.txt`]. The core never
  converts; `describeContract` hands over the schema and its vendor.
- **What this adds to AD and TC**: cookies as a request part, response headers
  and cookies, media types per status, and the same model for channels, SSE
  and jobs. AD's `RouteDoc.request` and TC's `ModelRoute.request` each gain
  `cookies`; their `responses` gain `headers` and `content` (a change to their
  plans, which this plan's lead also owns for AD; TC's owner, bun-node-99,
  agreed the route model is settled jointly before either builds).
- **Route keys sit above the contract** (method and path): a router layer
  carries its contract through `attachContract`; the route is not a key of the
  HTTP transport (Q-C10).


### 4.12 Folded in from the typed-client review [A]

bun-node-99 reviewed §4.1.4, §4.1.5, §4.11, Q-C5, V12 and V5b against the
typed-client plan on 2026-10-17 with probes of the spike (its report:
`~/.cache/bun-node-99/review-validate-contract/REPORT.md`). Verdict: TC can
build on this contract. Each finding below is now a requirement of the PR
named; none changes a decision of §1.2 except V-D8's per-field rule (M1).

| # | Finding | Lands in | What the PR does |
|---|---|---|---|
| B1 | **`describeContract` drops a key with no parts** (`202: {}` vanishes) and cannot tell "nothing declared" from "declared empty" (probes P3, P4; `contract-core/core.ts:781-792`) | V1 | it returns the declared keys per side with the entries (`{ sides: { inbound?: { declared, keys? }, outbound?: … }, entries }`), so a client can be strict where a contract declares and lenient where none does |
| M1 | **The sender rule per part, not per field** (P1) | V1, V3a | the deep `WireInput<S>` (§4.1.4) |
| M2 | **Client response types from the output disagree with the wire** (P2) | V12, TC, AD | `Jsonify<WireInput<S>>` by default; the JSON Schema direction for responses pinned to the wire (input), against AD §4.3's output. AD §4.3 is corrected by this plan's lead (who also leads AD) in AD phase (b)'s converter PR, the same window as V12 |
| M3 | **Layered contracts have no merge rule**; chained validators make the *first* the wire schema while the handler sees the last | V1 (`mergeContracts`), V12 (`effectiveContract(route)`) | Q-C11's rules; each row records its origin; `commonResponses` carried as a router-level contract, so TC's builder option is only an override |
| M4 | **Rows cannot tell body kinds apart**; `sse()` hides its event map and gives a different row shape on the writer | V1, V3b | `kind: "value" \| "chunks" \| "sse" \| "opaque"` on `ContractEntry`; `sse()` expanded into nested rows (`keyName: "event"`, parts `data`, `id`), identical to the writer's; `chunks(S, { framing: "ndjson" })` |
| M5 | **A wrapper drops the contract**: bun-jobs registers `deferred(validate(schemas))` (`bun-jobs/lib/api/routes/define.ts:484`, `:515`) and keeps responses in `respond(def)`, so a route listing finds a contract on none of its 84 routes | V1 (`forwardContract(wrapper, inner)`), V4 | `defineRoute` attaches a full HTTP contract (params, query, body, responses, alternate content as string bodies) to its terminal layer, so TC's bun-jobs pilot uses the generic route model |
| M6 | **JSON-Schema-only parts have no place** (AD Decision 4's docs-only responses, NTR's swagger routes) | V1, V12 | `documented(json)` (Q-C12); AD Decision 4's merge restated in V12 |
| M7 | **A WebSocket contract lacks what a channel model needs**: the upgrade request (where auth lives), the envelope and correlation id, reply and ack links, the implicit error frame, binary, subprotocol, topics, the SSE fallback; and `receives: { typing: null }` throws in the spike (P5) | V8 | a channel is the HTTP inbound side (the upgrade) plus the WebSocket sides, as SSE is (§4.7.1), plus channel meta `{ path, envelope (with its correlation `idField`), replies, binary, subprotocol, topics, fallback }`, the `fallback` naming an SSE endpoint for the same messages; a `null` message normalises to `{ data: null }`; the implicit `error` frame is a declared outbound key. TC's `ModelChannel` (proposed in the report) reads it |
| m1 | row order | V1 | rows documented as unordered, emitted in a canonical order: sides (inbound, outbound); then keys, numeric statuses ascending, then string keys lexically (JavaScript cannot give integer-like keys in declaration order); then parts as the transport lists them; then media types lexically |
| m2 | media keys with parameters never match | V3a | Q-C14 |
| m3 | the wire encoding must exist as **data** | V1 | each row carries its part's encoding (`path-string`, `querystring`, `header-string`, `cookie-string`, `signed-cookie`, `set-cookie`, or a media-typed body), and V12 agrees one `Jsonify` with TC (`Date` → string; `undefined` and functions dropped; `bigint` → never; `toJSON` honoured; `Map`/`Set` → `{}`) |
| m4 | cookies are not browser client inputs | V12, TC | cookies are documented (`in: cookie`) and left out of browser call options, and a response's `Set-Cookie` is left out of browser client result types; the signed-cookie encoding from m3 |
| m5 | implicit statuses | V2 | a validator with `onFailure: "respond"` attaches its own 400 shape to its contract, marked implicit; with `"next"` the 400 is a `commonResponses` matter |
| m6 | the request body's default media type and required-ness | V12 | `application/json` by default; required unless the schema's input accepts `undefined` |
| m7 | two homes for names (`ContractMeta.name` vs `.describe({ operationId })`) | V1 | for HTTP, `.describe()` wins |
| m8 | status ranges and `default` | — | out of scope here; later as string keys with most-specific-wins |
| m9 | SSE data decoding guessed | V3b, V11 | Q-C13 |
| m10 | `recordOf` and `toStandardSchema` carry no JSON Schema | V1 | `recordOf` composes its members'; `toStandardSchema` takes an optional `jsonSchema` |
| m11 | `s.object`'s input equals its output, so a defaulted key is required on input | V4 | defaulted keys optional on input, required in output, in both the types and `~standard.jsonSchema` |
| m12 | the browser subpath's real user | V1, V8 | a shared `defineChannel` contract module imported by both server and client: V8 splits a channel's pure contract (in `./contract`) from its server binding (handler, publish), and the bundle-safety test targets that |

The spike's HTTP declaration has no inbound `signedCookies` and no outbound
`cookies` (a nit from the same review); `transports.ts` in the real module
declares both (§4.1.1's table already lists them).

---

## 5. Tests

Every new check ships with a negative control: shown to fail on the base, or
by a mutation that removes the thing it checks (`docs/agentic-setup.md`,
"Negative controls"). Type tests use `@ts-expect-error` controls proven by a
mutant run, as both spikes do (`check-types.sh`, `run.sh` step c).

| PR | Runtime tests | Type tests | Examples (bun-node-74) |
|---|---|---|---|
| V0 | `bunValidate.test.ts`: explicit `undefined` keeps 400 (base: 200, R2h); an unknown target throws `ConfigError` (base: passes, R5) | `validate.type-test.ts` unchanged | `examples/bun-common/12-options/validate-options.ts` |
| V1 | new `__tests__/contract/*.test.ts` from `contract-core/run.ts`: sync vs Promise per vendor; receiver parses, sender returns the same object; policies; undeclared key/part/media; the no-value scrub against **each supported vendor** (C11); the no-schema path (C13–C15); `onIssues` (C16); `getContract`/`describeContract` (C20); declaration errors (C22); a UDP adapter test on port 0 (C1–C6); a bundle-safety test for the browser subpath; BunValidate's existing suite unchanged. **§4.12's, each with a negative control:** `describeContract`'s `sides` for `202: {}` and for an empty and an absent outbound (B1: the spike drops them); `mergeContracts` (outermost inbound wins, route over router outbound, `origin` on every row: M3); `forwardContract` through a wrapper (M5: `getContract` on the wrapper is `undefined` without it); `kind` rows and `sse()` expanded into event rows (M4); `documented(json)` documents and never checks (M6); each part's `encoding` (m3); the canonical row order (m1) | `contract.type-test.ts` from `types.probe.ts` (24 controls), plus a `WireInput` control: `{ page: "x" }` against `z.coerce.number()` must fail (M1; the spike's per-part `SendOf` lets it compile) | "Writing a transport" with the UDP adapter |
| V2 | `bunValidate.test.ts`: cookies, signedCookies (genuine, forged, tampered: H49–H51), typed coerced header on `req.valid` with raw `req.headers` untouched and `accepts`/busboy working (H46), H47, H48; bun-jobs `ProblemIssueDto` round trip | `validate.type-test.ts`: `req.cookies`, `req.signedCookies`, `req.valid` types; a `string[]` wildcard param case; the lifted inline limit (5 lines of `verbTyping.type-test.ts`) | `06-validation/cookies-and-headers.ts` (new) |
| V3a | new `bunValidate.responses.test.ts`: H1–H20, H25–H38, H41–H45 (buffered kinds × modes × zod/yup; status, headers, cookies, media type; exemptions); `commonResponses`; router- and adapter-level defaults | new `responses.type-test.ts` from `http-complete/types.probe.ts` (N1–N18, L1); `verbTyping`, `mountTyping` and `nestVerbTyping` response cases; `generate-verb-overloads.ts --check`; `consumer-check.ts` for all four packages (the `BunResponse` and `BunRequest` surfaces) | `06-validation/responses.ts` (new) |
| V3b | streams, `write()`/`end()`, SSE per event, H21–H24, H39, H40; a cut-off stream reaches the client as an error | `chunks()`/`sse()`/`opaque()` types | `06-validation/streaming-responses.ts` (new) |
| V3c | new `bunValidate.variants.test.ts` from `response-variants/run.ts` (RV1–RV28), through `router.fetch()` and the adapter, under `"warn"` and `"error"`, zod and yup: a whole match per variant; parts from two variants refused (RV2); **the leak** refused with the excluded variant named (RV3), **with its negative control**: the same handler on V3a's per-part union is answered 200; no applicable variant (RV5); header and cookie discriminants with `values` (`string`, `true`, `null`), an unknown value listed without itself (RV6, RV7); `res.variant()` agreeing and disagreeing with the discriminant (RV8); `refine` scrubbed against every part (RV9); no validator (`req.valid` `{}`) and `commonResponses` with `UntypedValid` (RV11); `when` call counts, and 0 with no variants (RV12); the loose-subset limit and its strict fix (RV17); an async `when` awaited, a sync one leaving the verdict sync, a non-boolean, throwing or rejecting one a failed check (RV10a–e); `.variant()`'s adjust (RV18–RV28): the discriminant, literal headers and cookies, the status and `Content-Type` filled, literal body fields filled at depth and in array elements, undeclared fields stripped (counted, never named), the handler's object unmutated, a wrong value the handler set kept and refused, a non-literal field left to the check, `when` decided before any adjust, the leak fixed on RV17's loose table (RV25), valibot not adjustable with its declaration `warn`, union and record limits, under `"off"` too (Q-H29), the re-serialised body on the wire, a `.variant()` after the commit warned once; declaration `TypeError`s (RV14); whole replacement under `commonResponses` and a mount; a streamed variant with survivors per chunk; `describeContract`'s `variant` rows and `sides.outbound.variants`; planted values in no issue or log line | `responses.type-test.ts` gains VT1–VT21 from `response-variants/types.probe.ts` (an async `when` allowed, a non-boolean refused; literal fields optional after `.variant()` for zod, required for valibot and on the union), plus B1 made a control (a discriminant's `null` refuses `set()`); `when`'s parameter asserted equal to the parsed parts; `nestVerbTyping.type-test.ts` gains a variants case; `generate-verb-overloads.ts --check`; `consumer-check.ts` for all four packages | `06-validation/response-variants.ts` (new): an admin header, a session cookie, a mode header |
| V6 | the pipe, the global pipe (with and without, `results-nest.txt`), the filter, through `adapter.fetch()`, on Nest 11 and 12 | `SchemaDto` instance type; TS2509 for unions | `examples/bun-nest/02-http-adapter/pipeline.ts` drops its hand-written pipe for `StandardSchemaPipe` (`packages/bun-nest/lib/validation.ts`; #503) |
| V7a | `@Validate` request side: every part, `@Validated(part)`; the skip rule both ways (a `@Body({ schema })` with the pipe in effect is not checked twice; without the pipe, or with `@Query('page', { schema })`, `@Validate` still checks); on 11 and 12 | parameter and return types; a `string[]` wildcard | `examples/bun-nest/08-validate/` (AD) |
| V7b | responses: the status and `@Header()` headers seen in `map()` (each row of §4.5.4's table), a thrown 409 checked in `catchError`, redirects and `StreamableFile` through the before-write hook, plain `@Res()` skipped without a throw, `@Sse` with a sync and an async first event, both serializer placements; `ResponseValidationInterceptor` | `reply()` per-status types | the same folder |
| V8 | frames: valid, invalid → error frame, unknown type, order with an async vendor, `closeOnInvalid`, outgoing modes; the upgrade request's parts checked before the upgrade (M7); `receives: { typing: null }` normalised to `{ data: null }` (P5 throws in the spike); the implicit `error` frame listed as a declared outbound key; the pure channel contract bundles browser-safe, its server binding does not (m12) | handler `msg` types; `send` rejects an undeclared type | a WebSocket channel example |
| V9 | as NTR §9.1, plus `WsValidationFilter` | as NTR | `examples/bun-nest/04-websockets/` |
| V11 | `SseWriter.send` refuses a bad event before encoding under `"error"`; Nest `@Sse` per event | `send({ event, data })` typed | an SSE example on each adapter |
| V4 | bun-jobs `__tests__/api/*`: `validateResponses: "error"`; `s` `~standard.jsonSchema` equals `.json` | — | `examples/bun-jobs/10-options/jobs-api-options.ts` |
| V5a | every write in §4.8.2's table rejects and writes nothing (the debounce: the pending job keeps its data); each site's policy (`"warn"` at processing runs the stored input); processing failure to `dead` with `attemptsMade=1`; the parsed value reaches the handler in-process and what reaches an isolated target; result modes and the absent `completed` event; on memory plus one SQL and Redis; `bench/queue.ts --compare` passes | `define` infers `job.data`; `JobMapFromSchemas` | `examples/bun-jobs/` `job-schemas.ts` (new); a playground addition (bun-node-99 reviews) |
| V5c | flows: a bad child writes nothing for the whole flow; each node against its own definition; typed `getChildrenValues` | the parent's typed children | a flow example |
| V5b | the API's add, update and flows routes answer 400 `VALIDATION` with issues even under `"off"` (a flow's at body paths); `/definitions` publishes JSON Schema | the `api/contract` DTOs; bun-jobs-ui's fixtures | — |
| V10 (in BC) | as BC §13, plus issues target `"cache"` | `CacheSchemaFrom` | BC's |
| V12 | `listRoutes`/`effectiveContract` over mounted routers and wrapped middleware, with bun-jobs' 84 management routes visible (M5); OpenAPI rows for cookies, response headers and media types; m6's body defaults (`application/json`, required unless the input accepts `undefined`); the agreed `Jsonify` vector (m3) | `Jsonify<WireInput<…>>` response types (M2), with a transform control (`{ n: z.string().transform(s => s.length) }` types `n` as `string`); the `wire` mapping | — |

---

## 6. PR slicing, effort and owners

Owners as of the 2026-10-16 roster (`docs/agentic-setup.md`): **bun-node-11**
(bun-common; leads this plan, AD and bun-native-routes' SSE helpers);
**bun-node-15** (bun-nest); **bun-node-e9** (bun-jobs); **bun-node-99**
(bun-jobs-ui, the playground, TC); **bun-node-74** (examples). A PR in another
agent's package is built there under that owner's review. Each PR passes the
full gate for what it touches, and every user-facing PR sends bun-node-74 a
CHANGE REPORT before merging.

**In the user's order** (the user's first priority, NestJS 12 support, is the
nestjs-12-parity plan, built by bun-node-15 before and beside group 1):

| # | PR | Scope | Depends on | Effort | Builds / reviews |
|---|---|---|---|---|---|
| **Group 1** | **Core and HTTP completeness, bun-common** | | | | |
| 1 | **V0** BunValidate fixes | G3, G2 (§4.3.1) | — | 0.5 d | 11 |
| 2 | **V1** the contract core | `lib/contract/`: `defineTransport`, contracts, `validateStandard`, `ValidationIssue<T>`, guards, policy, `onIssues`, `attachContract`/`getContract`/`describeContract`, the scrub; the browser-safe subpath; `validate()` rebuilt on it with no behaviour change; "Writing a transport" with the UDP adapter; and §4.12's B1, M1, M3–M6, m1, m3, m7, m10 (declared keys, `WireInput`, `mergeContracts`, `kind`, `forwardContract`, `documented()`, row encodings) | V0 | 4.5 d | 11 |
| 3 | **V2** request completeness | `cookies`, `signedCookies`, typed headers, `req.valid`, the `BunRequest` type parameters, the new target order; a validator with `onFailure: "respond"` attaching its own 400 to its contract, marked implicit (§4.12 m5); bun-jobs `ProblemIssueDto` widened | V1; nestjs-12-parity PR-5 for the `string[]` wildcard test (or a follow-up line) | 2 d | 11; e9 and 99 review the DTO |
| 4 | **V3a** responses, buffered | `ResponseSchemas`, the commit gate, every buffered kind, status/headers/cookies/media type, modes, router/adapter defaults, `ResponseValidationError`, `commonResponses`, response typing (`status`/`json`/`send`/`set`/`header`/`cookie`/`redirect`) held to `WireInput` (§4.12 M1), media keys matched with parameters stripped on both sides (m2, Q-C14), the `#self` getter; consumer check for all four packages | V2 | 5 d | 11; 15 reviews the bun-nest type surface |
| 5 | **V3b** responses, streamed | the chunk gate, `chunks(S, { framing })`, `sse()` with its events expanded into rows (§4.12 M4) and declared `data: "json" \| "text"` (m9, Q-C13), `opaque()`, `sendFile` reads, stream cut-off | V3a | 2.5 d | 11 |
| 5a | **V3c** response variants (added 2026-10-21) | §4.4.6: `variants()` with `when`, `by` (header or cookie, `values`) and `refine`; `refine` on a plain status too; the gate's three steps (selected, applicable, matched whole) and the failure-path diagnosis; survivors per chunk for streamed variants; whole replacement in `mergeOutboundDefs`; `res.variant()` and **its adjust** (fill single literals and the discriminant, the status and `Content-Type`; strip undeclared JSON body fields; planned from `~standard.jsonSchema`; also under `"off"`, Q-H29); an async `when` with the sync fast path; the typed `when` (the `RS` constraint), the tagged union in `InferResponses`, `VariantNames`/`NarrowVariant`/`LiteralOptional`, `HeaderArg`'s declared-absent marker; `ValidationIssue.variant`; `describeContract`'s `variant` rows and variants table; the overloads byte-identical | V3b | 5 d (3.5 d, +1.5 d for the adjust, 2026-10-21) | 11; 15 (bun-node-a9) reviews the bun-nest type surface |
| **Group 2** | **NestJS** | | | | |
| 6 | **V6** pipes | `StandardSchemaPipe`, `SchemaDto`, `StandardValidationPipe`, `ValidationExceptionFilter`; replaces NTR PR-N3's pipe half and NJD's pipe | V1; nestjs-12-parity PR-2 (filter tests on both majors) and **PR-3** (bun-nest's devDependencies on Nest 12, so its tests run on 12) | 2.5 d | 11 in bun-nest; 15 reviews |
| 7 | **V7a** `@Validate`, request side | every part, `@Validated(part)`, Nest 12 composition (the skip rule of §4.5.1), `SchemaDto` integration | V2, V6; nestjs-12-parity **PR-3** (tests on 12) and **PR-5** (the `string[]` wildcard test) | 3 d | 11 in bun-nest; 15 reviews |
| 8 | **V7b** `@Validate`, responses | per-status checks in `map()` and `catchError`, plus PR-6c's before-write hook (name TBD) for redirects, `StreamableFile` and plain `@Res()`; `reply()`, `@Sse`, `ResponseValidationInterceptor`, both serializer placements; **from V3c**: `variants()` in `@Validate` responses, `when` on `@Validate`'s parsed parts, `reply(status, body, { variant })`, and `res.variant()` on plain `@Res()` through the before-write hook (§4.4.6) | V3b, **V3c**, V7a; nestjs-12-parity **PR-6a and PR-6c** | 3.5 d **+0.5 d** | 11 in bun-nest; 15 reviews |
| **Follow-up** | **after group 2** (added 2026-10-21) | | | | |
| 8a | **V13** the `"parse"` response mode (Q5) | opt-in, per validator, router or adapter: a buffered JSON body that passes is **sent as the schema's output** (unknown keys stripped by the vendor, defaults applied), for every response, not only those `.variant()` names (V3c already strips those, by JSON Schema); its open points: transforms change the wire type (`Date`, coercions), so the response types and the typed client follow the output under it; vendors that keep unknown keys (yup by default, arktype) strip nothing; streams and non-JSON bodies are out | V3c | ~2 d [I] | 11 |
| **Group 3** | **Other transports** | | | | |
| 9 | **V8** WebSocket channels (= TC PR-M4) | `defineChannel` on the core, §4.6.1; §4.12's M7 (the upgrade side, channel meta, the implicit error frame) and m12 (a pure contract apart from its server binding); **from V3c**: `variants()` per `sends` type with `when` on the connection, for `send()` only, refused for `publish()` (§4.4.6) | V1 (V3c for variants) | ~5 d (TC) **+1 d** | 11; 99 reviews (TC) |
| 10 | **V9** Nest gateways (= NTR PR-N5) | `@ValidateMessage`, `@Emits`, `WsValidationFilter` (an object `WsException`, §4.6.2; V6's `ValidationExceptionFilter` already emits that frame shape, `{ status, code: "VALIDATION", issues }`, in a gateway) | V6, V8; nestjs-12-parity **PR-2** (Q4(a): the frame shape on 12) | ~4.5 d (NTR) **+0.5 d** | 11 in bun-nest; 15 reviews |
| 11 | **V11** SSE on both adapters | `res.sse({ contract })` typed and checked (inside bun-native-routes PR-sse2, also 11's), with declared `data` decoding (m9); Nest `@Sse` per event; **from V3c**: per-event `variants()`, `when` on the opening request (§4.4.6) | V3b, V3c, PR-sse2 | 1.5 d **inside PR-sse2** + 1 d bun-nest | 11; 15 reviews the Nest part |
| 12 | **V4** bun-jobs alignment | `s` `~standard.jsonSchema`, with defaulted keys optional on input and required in output (§4.12 m11); `validateResponses` modes; `defineRoute` attaching a full HTTP contract to its terminal layer through `forwardContract` (M5); the flattening copies may adopt `validateStandard` | V1 | 2.5 d | e9; 11 reviews |
| 13 | **V5a** job data and results | §4.8.1–§4.8.4 except flows; checks in `BunQueue`; `JobMapFromSchemas`; the bench guard | V1 | 3.5 d | e9; 11 reviews |
| 14 | **V5c** flows | the pre-write pass, per-node definitions, typed `getChildrenValues` | V5a | 1.5 d | e9; 11 reviews |
| 15 | **V5b** job schemas in the API | add, update and flows routes always check; `/definitions` JSON Schema as **optional** fields (the UI reads only `items[].name`, so no UI source change; `DefinitionListSchema`'s `additionalProperties: false` widened and `api-contract.type-test.ts:312` updated in the same PR); **contract change** | V5a, V12's converter | 1.5 d | e9; 99 reviews the contract |
| 16 | **V10** cache hook | inside BC's core PR | V1, BC core | 0.5 d inside BC | BC's owner |
| **Group 4** | **Client and docs hooks** | | | | |
| 17 | **AD (b0)** spec types 1.1.0 | as AD | — | 0.5–1 d (AD) | 11 |
| 18 | **V12** route listing and the route model's inputs | router layers carry contracts; `listRoutes(router)` → `{ key, method, path, params, contract (effective), doc }[]`, which TC PR-M1 serialises; `effectiveContract`; the `wire` mapping and one agreed `Jsonify`; AD's `RouteDoc` and TC's `ModelRoute` gain cookies, response headers and media types; §4.12's M2, M6, m4, m6; **from V3c**: `oneOf` per media type, variant-only headers and cookies `required: false` with a note, the `x-variants` extension, and the client's union discriminated by status and discriminant (§4.4.6) | V3a, V3c, (b0) | 3 d **+** AD (a)/(b) 10–14 d (AD) | 11; 99 reviews the route model |
| 19 | **AD (e)** AsyncAPI | channels, SSE and broker contracts through `describeContract` | V8, V11, V12 | AD's estimate | 11 |

**New in this plan**: V0 0.5 + V1 4.5 + V2 2 + V3a 5 + V3b 2.5 + V3c 5 + V6
2.5 + V7a 3 + V7b 4 + V8 delta 1 + V9 delta 0.5 + V11 2.5 + V4 2.5 + V5a 3.5 +
V5c 1.5 + V5b 1.5 + V10 0.5 + V12 3 = **~45.5 d** (V3c's 5 d and V7b's 0.5 d
added 2026-10-21), **plus V13's ~2 d** as a follow-up. **Adopted** (estimated in AD, TC
and NTR, not counted again): (b0), AD (a)/(b), AD (e), TC PR-M4, NTR PR-N5.

**Order**: group 1 starts once the whole nestjs-12-parity plan has merged
(the user's decision, 2026-10-17). Then V0 → V1 → V2 → V3a → V3b → **V3c**
(group 1 now includes V3c, before group 2: the user's decision, 2026-10-21;
V0–V3b merged that day), then group 2 (V6 → V7a → V7b, the last after
nestjs-12-parity PR-6a and PR-6c), then the follow-up V13 (the `"parse"`
mode, the user's answer to Q-H20, 2026-10-21). Group 3 may start once V1 merges where
it depends on nothing else (V4, V5a, V8), but lands after group 2 unless the
user reorders. Group 4's V12 can follow V3a.

**Change reports** (to bun-node-74 unless stated):

| PR | What |
|---|---|
| V0 | behaviour change: explicit `undefined` keeps the default; unknown targets throw |
| V1 | new exports (`lib/contract`, a subpath); issue messages may change where a vendor quoted a value (the scrub) |
| V2 | new targets; `req.valid`; the target order; bun-jobs' `ProblemIssueDto` (to e9 and 99: bun-jobs-ui's fixtures move) |
| V3a, V3b | `responses`, `responseValidation`, `ResponseValidationError`, `commonResponses`, `chunks`/`sse`/`opaque`; the `BunResponse` and `BunRequest` type parameters (bun-jobs' `define.ts` and bun-jobs-ui's server use `BunResponse` and must still check) |
| V3c | `variants()` (`when`, sync or async, `by`, `refine`, `description`), `refine` on a plain status, `res.variant()`, which **adjusts the response** (fills single literals, the discriminant, the status and `Content-Type`; strips undeclared JSON body fields), also under `"off"`; the optional `variant` field on issues and on `describeContract` rows, and `sides.outbound.variants` (to 99: TC reads them); a variants status replaces a `commonResponses` one whole; the `RS` constraint change on `validate()` (to 15/bun-node-a9: bun-nest's type surface) |
| V13 | the `"parse"` mode: a response may now differ from what the handler passed (the schema's output) |
| V6, V7a, V7b, V9 | new bun-nest exports; `examples/bun-nest/02-http-adapter/pipeline.ts` drops its `SchemaPipe` for V6's `StandardSchemaPipe` (`packages/bun-nest/lib/validation.ts`; #503) |
| V8, V11 | channel API; typed SSE writer |
| V4, V5a, V5c, V5b | from e9; V5b changes `api/contract` (to 99); `examples/bun-jobs/11-management-api/mounting-and-auth.ts:283-286` prints the whole `/definitions` body |

---

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **The `BunResponse` and `BunRequest` type parameters** ripple into consumers who name them | all defaulted and trailing; the spike checked bun-common's and bun-nest's tests clean; V3a re-runs `scripts/consumer-check.ts` for all four packages |
| R2 | **Holding a response** for an async vendor or a read (`Blob`, file, cloned `Response`) changes timing | only in `"error"` mode; documented; `opaque()` declares without reading |
| R3 | **`"error"` in production** turns a stale schema into outages | default `"off"`; the README recommends `"error"` for development and tests only |
| R4 | **The value scrub is a heuristic** (a vendor's new message format could leak) | the C11 test runs against every supported vendor in V1; `messages: "generic"` for a guarantee (Q-C3) |
| R5 | **Paths can carry user data** (unknown keys, user-keyed records) | stated as the rule's limit; `redactPaths` opt-in (Q-C2) |
| R6 | **A receiver in `"warn"`/`"off"` hands handlers values their types misdescribe** | receivers default to `"error"` (Q-C1) |
| R7 | **Nest 11/12 divergence**: double validation with `@Body({ schema })`, or a part left unchecked because no `StandardSchemaValidationPipe` applies; the serializer's placement | `@Validate` skips a part only when its `{ schema }` covers the whole part and the pipe applies (§4.5.1); the serializer order rule stated and both placements tested (V7b); tests on both majors |
| R8 | **The before-write hook does not exist yet**, and Nest's `setOnResponseHook` cannot serve (it runs after the send) | the interceptor covers status, `@Header()` headers, returned bodies and non-2xx statuses (measured); PR-6c designs a separate before-write hook for redirects, `StreamableFile` and plain `@Res()`; on Express/Fastify those are checked only as far as `map()` reaches, documented |
| R9 | **Job schema drift across deployments** fails waiting jobs at processing | that is the point of the second check; its policy is separate and its error names the job and issues; visible in `dead` |
| R10 | **Transforms degrade on isolated targets** (`Date`, `Map` over JSON) | Q-J2; documented either way |
| R11 | **The enqueue check slows the queue** | the no-schema path is free by construction and measured (C13–C15); `bench/queue.ts --compare` gates V5a |
| R12 | **Decorator metadata** depends on the cwd's tsconfig (oven-sh/bun#28605) | `SchemaDto` needs `design:paramtypes`; the bootstrap check NTR NR4 plans |
| R13 | **Duplicate work** with AD, TC, NTR and NJD | §3 and §6 are the single order; this plan's lead also leads AD |

---

## 8. Open questions for the user

The user's 2026-10-17 words settled three of the first version's questions,
now removed: **Q9** (headers are typed), **Q10** (cookies are a full target),
and **whether responses are in scope** (they are, with status, headers and
every body kind; an undeclared status fails). The 400-vs-422 question raised
during the revision is also gone: bun-jobs' API already answers 400
(`bun-jobs/lib/api/errors.ts:92`).

**The questions marked ★ blocked group 1. The user answered all eight on
2026-10-17, each as recommended** (marked ✅ below), and decided that group 1
**waits until the whole nestjs-12-parity plan has merged**, not only the Nest
PRs that touch bun-common. The rest stay open, each to be asked before the PR
it names.

### 8.1 Kept from the first version

1. ★ **Is this the right home**: a main plan owning the core and the order,
   adopting AD's and TC's designs, rather than a sub-plan of AD? **Recommended:
   yes** (§0). ✅ **Answered 2026-10-17: yes, as recommended.**
2. ★ **Default for runtime response checks?** **Recommended: `"off"`**, with
   the README recommending `"error"` in development and tests. ✅ **Answered 2026-10-17: yes, as recommended.**
3. ★ **Mode names `"off" | "warn" | "error"` (here) or AD's `"off" | "log" |
   "throw"`?** **Recommended: here's**, now used by every transport. ✅ **Answered 2026-10-17: yes, as recommended.**
4. ★ **The server is held to the schema's input, falling back to its output
   when the input is `unknown`, field by field (`WireInput`, §4.1.4).**
   **Recommended: yes** (measured twice per part; per field from bun-node-99's
   review, M1). A typed client's responses follow the same wire side. ✅ **Answered 2026-10-17: yes, as recommended.**
5. **A `"parse"` mode that sends the schema's output** (stripping unknown keys
   to stop leaking fields)? **Recommended: later, opt-in.** ✅ **Decided
   2026-10-21 (with Q-H20): a follow-up feature, V13 in §6**, opt-in. Until
   then the modes only check, apart from `.variant()`'s adjust (V3c, Q-H18),
   which already strips for a handler that names its variant.
6. ★ **One shared runner named `validateStandard`** (NJD's name) instead of
   NTR's `validateTarget`? **Recommended: yes.** ✅ **Answered 2026-10-17: yes, as recommended.**
7. **One `StandardSchemaPipe` at bun-nest's root**, replacing NTR's and NJD's
   two? **Recommended: yes.** ✅ **Answered 2026-10-21: yes, as recommended**
   (for controllers, gateways and job handlers).
8. **`SchemaDto` + `StandardValidationPipe` as the `ValidationPipe`
   equivalent?** **Recommended: yes**; union-output schemas use the pipe and
   `Infer<>`. ✅ **Answered 2026-10-21: yes, as recommended**; on Nest 12 the
   README presents ours as the Nest 11 path and the `SchemaDto` path, with
   Nest 12's `StandardSchemaValidationPipe` and `@Body({ schema })` beside
   them (composition is V7a's Q-N1).
9. **The default `onFailure: "next"`** answers an HTML 400 on the adapter (G4).
   Keep it, or default the adapters to a JSON `{ error, issues }`?
   **Recommended: keep**, and show the error handler in the README's first
   example.
10. **An invalid WebSocket frame: an error frame with the socket left open**,
    `closeOnInvalid` opt-in? **Recommended: yes.**

### 8.2 The core (§4.1)

- **Q-C1** ★ **Receivers accept only `"error"`?** `"warn"`/`"off"` on a
  receiver hand a handler raw values its types call parsed (C3, C4).
  **Recommended: receivers default to `"error"` and also accept `"warn"`/
  `"off"` only with the handler's input typed `unknown`**; senders take all
  three. ✅ **Answered 2026-10-17: yes, as recommended.**
- **Q-C2** **Paths can carry user data** (an unknown key's name, a
  user-keyed record). **Recommended: keep paths; state the rule as "no received
  value"; add an opt-in `redactPaths`.** ✅ **Answered 2026-10-20: yes, as recommended.** `redactPaths: true` empties paths (2026-10-21: the core cannot tell schema keys from sender-chosen ones).
- **Q-C3** **The value scrub is heuristic.** **Recommended: keep it, add
  `messages: "generic"` for deployments that need a guarantee, and test it
  against every supported vendor.** ✅ **Answered 2026-10-20: yes, as recommended.**
- **Q-C4** **Media-type keys**: exact bare types (OpenAPI's), parameters and
  case ignored at runtime, no wildcards? **Recommended: yes; wildcards later,
  with most-specific-wins.** ✅ **Answered 2026-10-21: bare, case-insensitive,
  and wildcards now** (against the recommendation): `type/*` and `*/*` are
  keys, the most specific winning (exact, then `type/*`, then `*/*`); two keys
  that tie once bare and lower-cased are a `TypeError`. Built in V3a, in the
  core (`lib/contract/media.ts`), so every transport's media map matches so.
- **Q-C5** **What the wire changes** (`Jsonify`, header strings): a
  per-transport `wire` mapping, recorded as **data** on each row (`encoding`,
  §4.12 m3) and applied by client types, not the core's `Received`?
  **Recommended: yes** (V1 records it, V12 applies it). ✅ **Answered 2026-10-20: yes, as recommended.**
- **Q-C6** **A cached `checksKey(key)`** so a router or topic table skips the
  ~15 ns lookup for keys with no schema? **Recommended: yes, in V1.** ✅ **Answered 2026-10-20: yes, as recommended.** Built as a guard method, `guard.checksKey(key)` (2026-10-21).
- **Q-C7** ★ **Where the core lives**: bun-common's root **and** a
  browser-safe subpath `@kingsleyweb/bun-common/contract`? **Recommended:
  yes.** ✅ **Answered 2026-10-17: yes, as recommended.**
- **Q-C8** **An in-process broker checks on publish and delivery.**
  **Recommended: keep both by default** (right across services); measure
  before optimising.
- **Q-C9** **A flow child that may fail** typed `T | undefined`, through a
  per-child `optional`? **Recommended: yes.** ✅ **Answered 2026-10-21: yes, as recommended**; `ignoreFailure` children count as optional by default (built in V5c).
- **Q-C10** **Route keys above the contract**: router layers carry contracts,
  rather than the route being a key of the HTTP transport? **Recommended:
  yes.** ✅ **Answered 2026-10-20: yes, as recommended.**
- **Q-C11** **How layered contracts merge** (a mount and a route, a Nest class
  and method, `commonResponses`; §4.12 M3): inbound, the **outermost** layer
  that declares a part is the wire schema and later ones refine it (with a
  warning); outbound, route over router over adapter; every row records its
  origin. **Recommended: yes.** ✅ **Answered 2026-10-20: yes, as recommended.** `mergeContracts` merges per side, key and part; whole-key replacement is revisited in V3a with `commonResponses` (2026-10-21).
- **Q-C12** **A `documented(json)` helper** for parts known only as JSON
  Schema (docs-only `.describe({ responses })`, swagger-only Nest routes): a
  pass-through Standard Schema that documents and never checks?
  **Recommended: yes**, with AD Decision 4's rule: the validator wins, and a
  disagreeing `.describe()` is a warning. ✅ **Answered 2026-10-20: yes, as recommended.**
- **Q-C13** **SSE `data` decoding declared, not guessed**: `sse({ … }, {
  data: "json" | "text" })` rather than "JSON-parsed when it parses" (which
  turns `"123"` into a number)? **Recommended: yes, default `"json"`.**
  ✅ **Answered 2026-10-21: yes, as recommended** (V3b): `data` is
  JSON-parsed only under `"json"`, and a data that does not parse is a
  mismatch.
- **Q-C14** **Media keys with parameters** (bun-jobs' Prometheus
  `text/plain; version=0.0.4`): strip parameters on **both** sides when
  matching, and keep the declared key's parameters for documents?
  **Recommended: yes.** ✅ **Answered 2026-10-21: yes, as recommended** (V3a).

### 8.3 HTTP (§4.3, §4.4)

- **Q-H1** **A freshness 304 for a conditional request is allowed without
  being declared?** **Recommended: yes** (H42). ✅ **Answered 2026-10-21: yes.**
- **Q-H2** **An error handler's response is checked and only reported, never
  replaced?** **Recommended: yes** (H44); declare such statuses with
  `commonResponses`. ✅ **Answered 2026-10-21: yes.**
- **Q-H3** **On a refusal, drop the refused response's own headers**
  (`Location`, `Set-Cookie`, `Content-*`, `ETag`, `Last-Modified`), keeping CORS
  and `Vary`? **Recommended: yes** (H45). ✅ **Answered 2026-10-21: yes.**
  V3a also drops the refused response's status and body, so an error handler
  that sets none answers with its own.
- **Q-H4** **A whole-body schema against a stream**: skip with one warning
  per route? **Recommended: yes**; streams use `chunks()` or `sse()`.
  ✅ **Answered 2026-10-21: yes, as recommended** (V3b): never buffered; the
  status, headers, cookies and media type are still checked.
- **Q-H5** **Blobs, files and a passed-through `Response` are read to be
  checked** (so `"error"` holds them)? **Recommended: yes, with `opaque()`
  to declare without reading;** a size bound later. ✅ **Answered 2026-10-21:
  yes** (`opaque()` with V3b). V3a reads a `Blob` (`arrayBuffer()`) and a
  passed-through `Response` (`clone()`); `sendFile()`'s bytes are V3b's.
- **Q-H6** **A handler returning a native `Response`** is not supported by
  bun-common. **Recommended: out of scope**; if it is ever added, it routes
  into `send(response)` and is checked there. ✅ **Answered 2026-10-21: out of
  scope.**
- **Q-H7** ★ **Widen bun-jobs' `ProblemIssueDto.target` in V2** (a management
  API contract change bun-jobs-ui reads)? **Recommended: yes, in the same
  PR**, reviewed by bun-node-e9 and bun-node-99. ✅ **Answered 2026-10-17: yes, as recommended.**
- **Q-H8** **Type `req.valid` under `replace: false`?** **Recommended:
  later** (it changes five existing type-test assertions). ✅ **Answered 2026-10-21: later, as recommended.** V2 fills `req.valid` at runtime either way and leaves it untyped (`{}`) there.
- **Q-H9** **Accept the lifted inline-validator limit** (five lines of an
  existing type test change)? **Recommended: yes.** ✅ **Answered 2026-10-21: yes, as recommended.**
- **Q-H10** **Typed SSE writes** (`SseWriter.send` typed by a contract)?
  **Recommended: yes, inside bun-native-routes PR-sse2** (V11).
- **Q-H11** **The response cookie view** holds values as written plus their
  attributes? **Recommended: yes.** ✅ **Answered 2026-10-21: yes.** Built as
  `{ value, httpOnly, secure, partitioned, sameSite?, path?, domain?, maxAge?,
  expires?, priority? }`, named after `res.cookie()`'s options (`maxAge` in
  seconds as the header carries it, `expires` a `Date`, `sameSite`/`priority`
  capitalised).
- **Q-H12** **`req.valid` as the name** of the parsed-parts view (Hono's
  `c.req.valid`)? **Recommended: yes.** (Alternatives: `req.validated`,
  `req.parsed`.) ✅ **Answered 2026-10-21: `req.valid`, as recommended.**
- **Q-H13** **The private `#self` getter** that keeps 35 internal call sites
  compiling under typed `set`/`header`/`cookie`? **Recommended: yes**
  (internal only). ✅ **Answered 2026-10-21: yes** (34 sites in V3a).
- **Q-H14** **The new target order** `headers → cookies → signedCookies →
  params → query → body`? **Recommended: yes**: a cheap header or session
  check fails before a body is parsed. ✅ **Answered 2026-10-21: yes, as recommended.**

**V3c, response variants (§4.4.6)**. The user answered every question,
Q-H15–Q-H31, and approved V3c's names (§9) on 2026-10-21, in bun-node-ea's
session; Q-H25–Q-H31 came from the answer to Q-H18.

- **Q-H15** **One mechanism**: a variant is accepted when it is selected
  (`res.variant()`, else the discriminant, else all), its `when` holds, and
  every part matches whole; `when` (request) and `by` (response) are filters
  on one candidate set, not two features? **Recommended: yes** (RV1–RV8).
  ✅ **Answered 2026-10-21: yes, as recommended.**
- **Q-H16** **No applicable variant is a mismatch**, with no fallback?
  **Recommended: yes** (RV5): a silent fallback would send the very response
  the `when` was written to withhold. ✅ **Answered 2026-10-21: yes, as
  recommended.** The user asked whether a default variant is necessary: **it
  is not**. A variant with no `when` is optional, and only how to declare a
  fallback for an author who wants one; a table whose every variant has a
  `when` is complete.
- **Q-H17** **`when(valid, req)`**, run at the commit, `valid` typed by the
  validator (`UntypedValid` under `commonResponses`), the raw request second;
  synchronous only? **Recommended: synchronous**, the raw request included.
  ✅ **Answered 2026-10-21, changed by the user: `when` may be asynchronous,
  with a fast path.** A boolean is decided in place (no Promise made, a sync
  request stays sync); a Promise is awaited, holding the commit as yup does;
  it must resolve to a boolean or throw, and a non-boolean, a throw or a
  rejection is a failed check (500 "could not be checked", the error logged,
  never in an issue). It still takes `(valid, req)`. Spiked: VT9, VT18,
  RV10a–e (§4.4.6).
- **Q-H18** **What `res.variant(name)` does at runtime**: record only, setting
  nothing? **Recommended: record only.** ✅ **Answered 2026-10-21, changed by
  the user: `.variant()` adjusts the response wherever it can**: it fills
  only what the variant's schemas allow exactly one value for, and only what
  the handler did not set (the discriminant from `by.values`, a single-literal
  header or cookie, the status, the one declared media type as
  `Content-Type`, literal body fields), and strips body fields the variant's
  schema does not declare. What it cannot adjust is left to the check;
  `.variant()` never throws. Designed and spiked in §4.4.6 ("What
  `.variant()` adjusts"): RV18–RV28, VT19–VT21; Q-H25–Q-H31 follow from it.
- **Q-H19** **What an issue names**: a status-level summary, each applicable
  variant's issues tagged with a new optional **`variant`** field on the
  core's `ValidationIssue`, and, on the failure path only, an excluded variant
  the response matches in full; never a received value? **Recommended: yes**
  (RV2, RV3, RV6f, RV16), the README saying the issues are for logs, not
  clients. ✅ **Answered 2026-10-21: yes, as recommended.**
- **Q-H20** **The leak limit**: the gate checks and never strips, so a user
  view that is a loose subset of the admin view lets the admin body through
  (RV17a). **Recommended: document it, with a strict-schema example**; Q5's
  `"parse"` mode later. ✅ **Answered 2026-10-21: document it with a
  strict-schema example, and add the `"parse"` mode to the plan as a
  follow-up feature** (V13 in §6; Q5 in §8.1). `.variant()`'s stripping
  (Q-H18) already covers a handler that names its variant (RV25).
- **Q-H21** **`describeContract`**: a flat optional `variant` field on rows
  plus `sides.outbound.variants`, rather than nested rows like `sse()`'s?
  **Recommended: flat.** ✅ **Answered 2026-10-21: yes, as recommended.**
- **Q-H22** **Merging**: a more specific layer's declaration of a variants
  status replaces it **whole**, never per part? **Recommended: yes.**
  ✅ **Answered 2026-10-21: yes, as recommended.**
- **Q-H23** **The discriminant's `values`**: a string (exact), `true`
  (present, any value), `null` (absent), defaulting to each variant's name,
  tried in that order? **Recommended: yes** (RV6, RV7); `null` is what makes
  "the user variant has no `x-admin`" declarable without a vendor-specific
  "absent" schema (zod 4's `z.undefined()` makes the key required). Since
  Q-H18, only an exact string is filled by `.variant()`. ✅ **Answered 2026-10-21: yes, as recommended.**
- **Q-H24** **Streamed variants**: when more than one applicable variant
  remains at the commit, check each chunk against the survivors and cut the
  stream off when none survives, rather than refusing the declaration?
  **Recommended: survivors**, with the README pointing at a discriminant or
  `res.variant()` to decide at the commit. [I]: not spiked. ✅ **Answered 2026-10-21: yes, as recommended.**
- **Q-H25** **A variant `.variant()` cannot adjust** (its JSON body schema
  carries no `~standard.jsonSchema`: valibot, yup, `toStandardSchema` without
  `jsonSchema`; or the vendor's converter throws): nothing is filled or
  stripped, so the leak fix silently does not apply. **Recommended: a `warn`
  once per variant at declaration** naming the variant and the reason, and
  the types keep its literals required (VT21), so the handler sees it; not a
  `TypeError`, which would forbid valibot and yup in variants. Alternative:
  a `TypeError` only for a variant some other variant of the status has more
  fields than (where the leak is possible). ✅ **Answered 2026-10-21: yes, as recommended.**
- **Q-H26** **The strip rule**: remove keys not in an object node's
  `properties`, unless it has `additionalProperties: true` or a schema, or
  `patternProperties`; leave unions, intersections, records and tuples
  untouched (RV27)? **Recommended: yes**, with union branches left for later
  (stripping one would need its branch chosen by the check first). ✅ **Answered 2026-10-21: yes, as recommended.**
- **Q-H27** **What is said about an adjust**: the changes as paths and
  counts (`headers.x-tier: filled`, `body.meta: stripped 1 undeclared
  field`), never key names or values; logged at `debug` only, and carried on
  nothing else? **Recommended: yes**: an adjust is the intended behaviour,
  not a mismatch, so it is not a `warn`. ✅ **Answered 2026-10-21: yes, as recommended.**
- **Q-H28** **The status and `Content-Type` fills**: the status only when
  `status()` was never called and exactly one status declares the name
  (RV20); `Content-Type` only replacing `json()`'s implicit type, and only by
  a JSON-classed type for a JSON body (RV18)? **Recommended: yes**: anything
  wider would change a response the handler shaped on purpose. ✅ **Answered 2026-10-21: yes, as recommended.**
- **Q-H29** **Adjusting under `responseValidation: "off"`** (the default):
  V3a installs no gate under `"off"`, so `.variant()` would silently do
  nothing there, stripping included. **Recommended: a validator that declares
  variants installs an adjust-only step under `"off"`** (no `when`, no
  check, one field read when `.variant()` was not named), since the handler
  asked for the adjust and its stripping protects data. Alternative: adjust
  only under `"warn"` and `"error"`, documented. ✅ **Answered 2026-10-21: yes, as recommended.**
- **Q-H30** **The types after `.variant()`**: required single-literal body
  fields optional (`LiteralOptional`), only when every JSON body schema of the
  variant carries `~standard.jsonSchema` in its type? **Recommended: yes**
  (VT19–VT21): the types promise a fill only where the runtime can make it. ✅ **Answered 2026-10-21: yes, as recommended.**
- **Q-H31** **A body that changed is re-serialised** into a new native
  `Response` (the `json()` fast path built one already), costing about the
  `reserialize` row of §4.4.6's table? **Recommended: yes**, only when an
  adjust changed the body; an unchanged body keeps the first `Response`. ✅ **Answered 2026-10-21: yes, as recommended.**

### 8.4 NestJS (§4.5)

- **Q-N1** **On Nest 12, `@Validate` composes with `@Body({ schema })` and
  `StandardSchemaSerializerInterceptor`** rather than replacing them: it skips
  a part only when that parameter's `{ schema }` covers the whole part **and**
  a `StandardSchemaValidationPipe` applies, and otherwise checks it itself;
  its order with the serializer is the interceptors' order (§4.5.1)?
  **Recommended: compose.** (It gates V7a, not group 1.) ✅ **Answered
  2026-10-21: compose, as recommended**: `@Validate` skips a part only when
  that parameter's `{ schema }` covers the whole part **and** a
  `StandardSchemaValidationPipe` applies (the review conditions are in the
  [Handoff](#handoff-2026-10-22-how-to-resume)).
- **Q-N2** **Per-status typing in a controller through a `reply(status, body,
  { headers })` helper** the interceptor unwraps, beside the plain return?
  **Recommended: yes.** ✅ **Answered 2026-10-21: yes**, built in V7b.
- **Q-N3** **One `@Validated(part)` parameter decorator**, and no
  `@Cookies()` of ours? **Recommended: yes.** ✅ **Answered 2026-10-21, beyond
  the recommendation**: `@Validated(part)` **plus** the per-part aliases
  `@ValidBody()`, `@ValidQuery()`, `@ValidParams()`, `@ValidHeaders()`,
  `@ValidCookies()` and `@ValidSignedCookies()`; no `@Cookies()` of ours.
- **Q-N4** **The name `@Validate`**, which class-validator also exports as
  `@Validate(constraint)` (apps using both alias one; §4.5.6)? **Recommended:
  keep it**, matching AD and NTR; the alternative is `@ValidateRoute`.
  ✅ **Answered 2026-10-21: keep `@Validate`.**

### 8.5 bun-jobs (§4.8)

- **Q-J1** **`storeOutput: true`** for transform-free schemas, storing the
  parsed data (and result) instead of what the producer sent? **Recommended:
  no for now**: store the input; offer it only if asked.
- **Q-J2** **Transforms on isolated targets** (Worker, child process,
  container): document "full in-process only", or send the output after a
  `jsonClone` and document what degrades? **Recommended: send the
  `jsonClone`d output and document it**, so a coercion (string → number)
  reaches every target; an output that cannot be cloned fails the attempt as
  unrecoverable rather than sending the input (§4.8.3). bun-node-e9 agrees.
- **Q-J3** **Job data checked at enqueue and at processing by default**, a
  processing failure unrecoverable by default under its own policy, the handler
  given the parsed value? **Recommended: yes to all three** (the first
  version's Q12, refined with e9).

**Q-J1–Q-J3 were answered on 2026-10-21, each as recommended** (the user's
decision): store the input, no `storeOutput`; isolated targets get the
`jsonClone`d output, a non-cloneable one unrecoverable; checked at enqueue and
at processing by default, `dataValidation: { enqueue: "error", process:
"error" }`, `resultValidation: "off"`.

---

## 9. Names needing approval

**bun-jobs (2026-10-21):** `schema: { data, result }`, `dataValidation`
(`{ enqueue, process }`, each `"error" | "warn" | "off"`), `resultValidation`,
`JobDataValidationError` and `JobMapFromSchemas` approved (the user's
decision), for V5a.
Approved the same day, also for V5a: the error code `"JOB_DATA_VALIDATION"`;
the fields `definition.schema`, `definition.dataValidation`,
`definition.resultValidation` and `JobHooks.checkData`; and the types
`JobSchema`, `JobDataValidation`, `JobValidationOptions`,
`QueueValidationOptions`, `WorkerValidationOptions`, `ProducerJobSchema`,
`ProcessorJobSchema`, `SchemaData`, `SchemaResult` and `TypedDefinitionSchema`,
exported from their modules, not from the package root.

**V5c (2026-10-21):** `optional`, the per-child marker on a flow node (Q-C9), approved. The same day: the types `FlowChildrenValues` and `JobChildrenOf`, the field `JobTypeEntry.children`, the type parameter `TChildren` on `Job` and `JobProcessor`, and the `JobDataValidationError` context field `flowPath`, approved.

**V7a (2026-10-21, with Q-N3 and Q-N4):** `@Validate`, `@Validated(part)` and the six per-part aliases `@ValidBody()`, `@ValidQuery()`, `@ValidParams()`, `@ValidHeaders()`, `@ValidCookies()` and `@ValidSignedCookies()` approved, all exported from bun-nest's root; no `@Cookies()` of ours. As built (2026-10-22): `ValidateInterceptor` and the part-union type `ValidatePart` stay internal; `StandardValidationException` gains a defaulted type parameter for its issues' target union (its declared shape unchanged), so `@Validate` throws it with the request's six parts.

**V7b (2026-10-22):** the eight bun-common types (`InferResponses`, `VariantNames`, `NarrowVariant`, `DeclaredAbsent`, `ResponseTypeMap`, `JsonBodyFor`, `SendBodyFor`, `AllowedStatus`) approved for root export, and a purpose-built response checker approved for bun-common's root over duplicating the gate in bun-nest. As built: `createResponseChecker` with the types `ResponseChecker`, `ResponseCheckerOptions`, `ResponseCheckView` and `ResponseCheckVerdict`, and the verdict types `ResponseStreamCheck` and `ResponseReplacement`, all from bun-common's root; `ResponseGateRequest` (the gate's structural host) stays internal, as do the gate and `toOutboundDef`. bun-nest: `reply()` and `ResponseValidationInterceptor` (in the table below since V6's planning), plus the type `ValidateSchemas` (`ValidationSchemas & { responses?, responseValidation? }`) and `reply()`'s `ReplyOptions`; `ReplyValue` stays module-internal.

**V13 (2026-10-23):** the spelling `responseOutput: "as-sent" | "parsed"` approved (a separate option beside `responseValidation`, not a fourth mode), and with it the type `ResponseOutputMode`, exported from bun-common's root. `ValidateSchemas` gains the `responseOutput` key (the same type now: `ValidationSchemas & { responses?, responseValidation?, responseOutput? }`).

**V6 (2026-10-21):** `StandardSchemaPipe`, `SchemaDto`,
`StandardValidationPipe`, `StandardValidationModule` and
`ValidationExceptionFilter` approved (with Q7 and Q8); and, approved the same
day, the pipes' error class `StandardValidationException` and the options
type `StandardValidationPipeOptions` (`messages`, `redactPaths`), both
exported from bun-nest's root. `SchemaDtoClass`, the type `SchemaDto()`
returns, stays internal. From #501's review, approved the same day:
`StandardValidationModule.gatewayPipes()`, and the option
`stripProtoKeys: "nest" | "minimal"` (default `"nest"`, Nest 12's rule) on
`validate()`, the contract guards, `validateStandard` and
`StandardValidationPipeOptions`, so on both pipes and `forRoot()`.

**V3a (2026-10-21):** `responses`, `responseValidation` (`"off" | "warn" |
"error"`, default `"off"`, also a `BunRouter` and adapter option, route over
router over adapter), `commonResponses` (router and adapter option), the spec
key `content` and `ResponseValidationError` approved. V3a exports only
`ResponseValidationError`; its other names (the spec and cookie-view types)
are internal.

**V3a (2026-10-21):** the types `ResponseSchemas`, `ResponseSpec`, `ResponseSpecObject`, `ResponseValidationMode` and `SetCookieView` are exported; a `write()`-opened stream's gate and a media-level `null` move to V3b; `commonResponses` merges per status and part, like `mergeContracts`.

**V4 (2026-10-21):** the types `ObjectIn`, `StandardJsonSchemaTarget`, `StandardJsonSchemaOptions` and `StandardJsonSchemaConverter`, exported from bun-jobs' `lib/api/schema/builder.ts` (not from `lib/api`'s index), approved.

**V3c (2026-10-21):** every V3c name below is approved: `variants()` with `by` (`header`, `cookie`, `values`) and `refine`; a variant's `when`, `refine` and `description`; `refine` on a plain status; `res.variant()`; the types `ResponseVariants`, `VariantSpec`, `VariantsOptions`, `Discriminant`, `DiscriminantValue`, `Refine`, `RefineResponse`, `RefineIssue`, `UntypedValid`; and the fields `ValidationIssue.variant`, `ContractEntry.variant` and `ContractDescription.sides.outbound.variants`. V13's spelling is asked with V13.

**V3b (2026-10-21):** `chunks()`, `sse()` and `opaque()` approved and
exported from the package root. **Approved and exported (the user's
decision, 2026-10-21):** the return and option types `StreamChunks`,
`SseEvents`, `OpaqueBody`, `ChunkFraming`, `ChunksOptions`,
`SseDataFormat`, `SseOptions` and `SseEventMap`, and the
`ContractEntry.nested` field, an `sse()` row's event rows (§4.12 M4).
**Added the same day, at the user's request:** the shorthand
`opaque(mediaType)`, so `200: opaque("image/png")` is a whole status's spec,
exactly `200: { content: { "image/png": opaque() } }` (the same check, the
same typed `send()`, the same `describeContract` rows). Its argument is
checked as a `content` key is (wildcards and parameters allowed; anything
else a `TypeError`, and a type error when it is not `type/subtype`), and
`opaque(mediaType)` inside a `content` map (or a core media map) is a
`TypeError` at declaration and a type error, since the key already names the
media type; `opaque()` with no argument at status level stays, like any bare
schema there, an `application/json` body. `chunks()`'s `framing` values
`"raw"` (the default) and `"ndjson"` were approved in the same decision. A
media type mapped to `null` (V3a's deferral) is built, in the core's
`MediaMap`.

**`validate()` (2026-10-21):** the user approved extending the guard
options `messages: "generic"` and `redactPaths` (Q-C2, Q-C3) to `validate()` /
`BunValidateOptions`, with the same names and semantics, and asked that they
word both sides: every issue the validator's request schemas report (the
`ValidationError`, so the `"respond"` body and the `"throw"` and `"next"`
errors) and its `responses` checks' (`ResponseValidationError` and the
`"warn"` log). Per validator only, no router or adapter option; a mount's
validator and a route's checked together take the stricter of the two.

**V2 (2026-10-21):** `ContractEntry.implicit` approved; a declared part beats an implicit one in `mergeContracts`, silently; `TypedRouteHandler` gains a trailing `TRes` now, for V3a.

**V1's names were approved on 2026-10-20**: the core's functions and types in
the first three rows below, plus `mergeContracts`, `documented`, `redactPaths`
and `messages: "generic"`. On 2026-10-21 the user also approved exporting the
types a transport author names: `Transport`, `TransportSpec`, `SideSpec`,
`Side`, `Policy`, `Contract`, `ContractDef`, `ContractMeta`, `AnyContract`,
`Carries`, `Guard`, `IssueContext`, `MediaMap`, `WireInput`,
`ContractDescription`, `ContractEncoding`, `ContractKind`, `ContractWire`,
`forwardContract` and the `CONTRACT` symbol. `checksKey` is a guard method.
The rest stay internal. **V2's names were approved on 2026-10-21**: the
`cookies` and `signedCookies` targets and `req.valid`.

| Name | Kind | Where |
|---|---|---|
| `defineTransport`, `attachContract`, `getContract`, `describeContract`, `createReceiver`, `createSender`, `validateStandard`, `recordOf` | functions | bun-common root and `./contract` |
| `ValidationIssue<T>` (generalised), `StandardOutcome`, `ContractError`, `ContractEntry`, `GuardOptions` (`policy`, `logger`, `onIssues`, `undeclaredKey`), `Received`, `Sent` | types, error class | bun-common |
| `CONTRACT` symbol's registry key (the spike: `"bun-validate.contract"`) | symbol | bun-common |
| `cookies`, `signedCookies` | `validate()` targets | bun-common |
| `req.valid` | request member | bun-common |
| `responses`, `responseValidation` (`"off" \| "warn" \| "error"`), `commonResponses` | `validate()` options; `responseValidation` and `commonResponses` also router and adapter options | bun-common |
| `content`, `chunks()`, `sse()`, `opaque()` | response spec key and helpers | bun-common |
| `variants()`; its options `by` (`header`, `cookie`, `values`) and `refine`; a variant's `when`, `refine` and `description`; `refine` on a plain status (V3c, §4.4.6; alternatives for `by`: `discriminant`, `select`) | helper, options, spec keys | bun-common |
| `res.variant(name)` (V3c; alternative: `res.as(name)`) | response method | bun-common |
| `ResponseVariants`, `VariantSpec`, `VariantsOptions`, `Discriminant`, `DiscriminantValue`, `Refine`, `RefineResponse`, `RefineIssue`, `UntypedValid` (V3c; `VariantNames`, `NarrowVariant` and `LiteralOptional` internal) | types | bun-common |
| the `"parse"` mode's spelling (V13: a fourth `responseValidation` value, or a separate `responseOutput: "as-sent" \| "parsed"`), asked with V13 | option value | bun-common |
| `ValidationIssue.variant`, `ContractEntry.variant`, `ContractDescription.sides.outbound.variants` (V3c; Q-H19, Q-H21) | fields | bun-common (core) |
| `ResponseValidationError` | error class | bun-common |
| `StandardSchemaPipe`, `SchemaDto`, `StandardValidationPipe`, `StandardValidationModule`, `ValidationExceptionFilter`, `ResponseValidationInterceptor`, `WsValidationFilter`, `@Validated(part)`, `reply()` | pipes, class factory, module, filters, interceptor, decorator, helper | bun-nest root |
| `schema: { data, result }`, `dataValidation` (`{ enqueue, process }`), `resultValidation`, `JobDataValidationError`, `JobMapFromSchemas` (**approved 2026-10-21**) | definition and queue options, error, type | bun-jobs |
| `messageValidation`, `closeOnInvalid` | `defineChannel` options (TC's function) | bun-common |
| `redactPaths`, `messages: "generic"` | guard options (if Q-C2, Q-C3); `validate()` options too (2026-10-21) | bun-common |
| `validateOnWrite`, `CacheSchemaFrom` | option, type | bun-cache |

---

## 10. Evidence

Everything is in [`evidence/`](evidence/README.md); its README says how to
re-run each file and what passing means.

| File | What it measures |
|---|---|
| `audit-runtime.ts` → `results-runtime.txt` | R1–R9: responses unchecked; failure modes; the `status: undefined` defect; coercion; headers; cookies ignored; params write-back; `s` through `validate()`; job data unchecked; schemas unreachable |
| `audit-types.ts` → `results-types.txt` | T1–T11 on develop, 7 negative controls shown to fire |
| `vendors-sync.ts` → `results-vendors.txt` | which vendors answer synchronously, which carry `~standard.jsonSchema`, the cost of one check |
| `response-check-proto.ts` → `results-proto.txt` | the first version's response-check prototype (superseded by `http-complete/` for the hook point) |
| `response-typing/` | AD §3.7 re-applied to `73bf4a00`; the input/output rule; overloads unchanged |
| `nest-schema-dto.ts` → `results-nest.txt` | `SchemaDto` + a global pipe on bun-nest through Nest's real pipeline; no-pipe control; type controls |
| **`contract-core/`** (2026-10-17) | the transport-agnostic core: eight transports declared; UDP and broker adapters; C1–C22 (sync/Promise per vendor, policies, the value scrub, the no-schema path, `onIssues`, `getContract`, flows, declaration errors); cost; 24 type controls, line-exact (`check-types.sh`) |
| **`http-complete/`** (2026-10-17) | a patch on a copy of bun-common at `68023d36`: cookies and signed cookies, typed headers and `req.valid`, the commit and chunk gates, every body kind × mode × zod/yup (H1–H52), 18 type controls and the pinned limit, the unpatched base failing, overloads unchanged, cost per body kind |
| **`response-variants/`** (2026-10-21, V3c) | §4.4.6: a prototype of `variants()` composed with the real V3a types, the real overloads on both adapters and `.variant()` by module augmentation (21 controls, line-exact, `check-types.sh`), literal fields optional after `.variant()`; a runtime matcher on the core's runner, RV1–RV28 (whole match, `when` refusal and async `when`, the leak diagnosed, discriminants, `res.variant()` and its adjust: fills and strips, `refine`, privacy, the loose-subset limit and its fix); the matcher's and the adjust's cost, each scenario in its own process |
| **`nest-interceptor/`** (2026-10-17, bun-node-15) | what a Nest interceptor's `map()` sees (status, headers, sent) against the wire, on Nest 11.1.27 and 12.1.3, Express and bun-nest adapters; `@Body({ schema })` with and without the pipe; `@RawBody`; `@Sse` sync and async first events; the serializer's placement ; `out-sse.txt`: the `@Sse` cases, re-run by bun-node-11 |
