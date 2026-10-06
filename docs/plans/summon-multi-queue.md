# Summon groups: one budget for several queues, and one unit for several queues

Implementation plan for two additions to `@kingsleyweb/bun-jobs` summoning.
Both build on a third, cheaper change that is being built separately: **the
expansion form**, in which `BunJobsOptions.summon` accepts one policy for a list
of queues and expands it into one ordinary `SummonController` per queue, so
per-queue state does not change. This plan covers only what the expansion form
does not give:

- **(A) A shared budget, and optionally a shared circuit, across a group of
  queues.** Today each queue's controller has its own budget, so a policy
  copied onto eight queues allows eight times the spend the user wrote down.
- **(B) One summoned unit that serves several queues at once.** Demand is
  combined across the queues, capacity is counted per queue, and the summoned
  process runs one worker per queue. This means changes to the arguments,
  `summonedFromArgs()`, `runSummoned()`, claims and release.

**(A) and (B) are separable.** (A) does not need (B). (B) reuses (A)'s storage
for its state, but not (A)'s sharing rules. The user can approve (A) alone.

Written 2026-10-06 against `develop` at `5bbce9e`. **No product code was
changed.** Every `file:line` is at `5bbce9e` and relative to
`packages/bun-jobs/` unless it says otherwise. The evidence is in
[`evidence/summon-multi-queue/`](evidence/summon-multi-queue/README.md), and
each measurement there can be re-run with one command.

**Two changes in flight that this plan relies on:**

- **The expansion form**: branch `feat/summon-queue-groups`, empty at the
  time of writing. This plan assumes only that it builds one controller per
  queue from one policy. §3.2 says what (A) needs from it: a name for the
  group.
- **Failure hooks and an optional budget**: the PR in flight on branch
  `feat/summon-failed-budget`. It adds `onSummonFailed`, `budget: false`,
  `reset({ budget: true })` and `status().budget.disabled`. (A) composes with
  all four (§3.8).

### Contents

1. [Executive summary](#1-executive-summary)
2. [What exists today](#2-what-exists-today)
3. [Part A: a shared budget and circuit across a group](#3-part-a-a-shared-budget-and-circuit-across-a-group)
4. [Part B: one unit for several queues](#4-part-b-one-unit-for-several-queues)
5. [API and UI](#5-api-and-ui)
6. [Back-compat and migration](#6-back-compat-and-migration)
7. [Tests and conformance](#7-tests-and-conformance)
8. [Measured evidence](#8-measured-evidence)
9. [Risks](#9-risks)
10. [Open questions for the user](#10-open-questions-for-the-user)
11. [PR slicing and effort](#11-pr-slicing-and-effort)
12. [Names needing approval](#12-names-needing-approval)

### How to read the markings

These are the same marks the other plans use:

| Mark | Meaning |
|---|---|
| **[S]** | Read in this repo's source at `5bbce9e`. The `file:line` is given |
| **[M]** | Measured here by a spike that can be re-run. The evidence file is named |
| **[V-prior]** | Carried from an earlier plan or evidence file, which is named, and not re-read |
| **[I]** | Inference. A claim to test, never a finding |
| **[U]** | Unverified. Nothing may rest on it |
| **[D]** | A design decision this plan proposes |

**SC** is [`summon-compute.md`](summon-compute.md) and **CP** is
[`compute-provider-plugins.md`](compute-provider-plugins.md).

---

## 1. Executive summary

### 1.1 The one-paragraph answer

**(A) A group budget is one new reserved queue-state entry,
`__win:summon-group:<name>`.** Every controller in the group charges it, by
compare-and-set, *before* it claims its own queue's marker, so a race can only
over-count, never overspend. Everything else stays per queue: attempts in
flight, cooldown, backoff, and the per-queue marker itself. A shared circuit
is optional, and is kept per provider `kind` inside the same entry. The entry
lives under a reserved pseudo-queue, `__bunjobs`, so its state is keyed by the
group's name alone and survives membership edits. Two drivers (file and
memory) list that pseudo-queue as a queue today, measured, so they gain a
filter. The rest of (A) is small: about 7 days, with nothing new for providers.

**(B) One unit for several queues turns the group entry into a full
`SummonMarker`.** A single controller then watches every queue in the group.
**Units wanted is the maximum over the queues, not the sum**, because each unit
adds one worker to every queue. Capacity is counted per queue, from that
queue's live records. Each summoned worker still claims the attempt under its
own queue, so claim-once and the worker's claim code do not change. The
arguments repeat `--bun-jobs-summon-queue=`, so a single-queue argv is
unchanged byte for byte. `runSummoned()` takes an array of workers and stops
the unit only once every queue is idle. Providers need no change. Requests
gain an additive `queues` field (summon API `0.1` → `0.2`). (B) is about 14
days.

**Is (B) worth it?** Measured on this host, **one process with eight workers
registers in about 0.2 to 0.45 s with about 70 MB RSS. Eight one-worker
processes take about 0.6 to 0.85 s and about 530 MB** [M, §8.2]. On a cloud
platform, each unit also pays its own cold start, its own minimum bill and its
own idle tail. A unit also holds its own database pool. Three things that (A)
alone cannot fix are what (B) gains:

- the number of attempts a correlated burst spends;
- the platform quotas it occupies;
- the database connections it holds.

It pays for many light queues whose bursts arrive together. It does not pay
for heavy, independent queues, or for queues that need different images or
secrets (§4.1).

### 1.2 The decisions

| # | Decision | Why |
|---|---|---|
| A1 | **A group is named, and its shared state is one entry, `__win:summon-group:<name>`, under the pseudo-queue `__bunjobs`.** | Keyed by name, it survives adding, removing and reordering queues, which are exactly the edits a group sees. On file and memory, a pseudo-queue is listed as a queue [M, §8.1], so `listQueues` filters it there. §3.3 |
| A2 | **Charge the group first, then claim the queue's marker. Refund on a lost claim, as a best effort.** | No multi-entry compare-and-set exists. This order fails closed: a lost refund over-counts by one and cannot overspend. §3.5 |
| A3 | **Share only what is about money or the provider:** the budget, and optionally the circuit. Attempts in flight, cooldown and backoff stay per queue. | These guards protect the platform and the bill. The rest are per-queue decisions that still need per-queue state. §3.1 |
| A4 | **The shared circuit is keyed by the provider's `kind`.** | Controllers grouped by hand may use different summoners. An outage of one provider must not stop another. §3.6 |
| A5 | **With a group budget, the per-queue budget defaults to off.** An explicit per-queue `budget` still applies. | "One budget for the group" should mean one limit, not one shared limit plus a hidden 30 an hour per queue. §3.2, Q2 |
| A6 | **The group entry persists its limits.** Status is then readable from the backend alone, without a controller in the API's process. | This answers SC §13.7's recorded follow-up for groups. The per-queue marker gains the same, so `local: false` becomes real. §5.1 |
| B1 | **(B) is opt-in per group, as `unit: "shared"`.** The default stays `"per-queue"`: the expansion form. | (B) changes what one summon means, and the image a unit needs. §4.2 |
| B2 | **Units wanted = max over queues of (wanted_q − serving_q), minus units on their way, capped by `maxWorkers`.** `jobsPerWorker` and `maxWorkers` can be set per queue. | A unit adds one worker to every queue, so the most-starved queue decides. A sum would over-summon. §4.4 |
| B3 | **Each worker claims the attempt under its own queue, as today.** The controller opens a claim on every member queue for `count > 1`. | `BunQueueWorker.#claimSummon` (`queue/BunQueueWorker.ts:4678`) and `claimSummonAttempt` (`summon/claim.ts:162`) stay as they are. A double start splits places per queue, and that is still correct per queue. §4.5 |
| B4 | **A unit that registers on only some of its queues by `until` is `registered`, with detail `partial`, and counts one failure.** | An image without a worker for one queue would otherwise "succeed" forever and be summoned again on every check, with only the budget to stop it. §4.5 |
| B5 | **Repeat `--bun-jobs-summon-queue=` once per queue, in a fixed order.** Add `--bun-jobs-summon-group=`. | This needs no delimiter, which queue names would make ambiguous. A single-queue argv is unchanged byte for byte. Identity stays in the arguments only (SC §5.5). §4.7 |
| B6 | **`runSummoned(workers[])`:** one unit, one idle clock over every queue, one close budget. It refuses an argv queue that has no worker. | A unit that half-exits is the partial coverage of B4, created on purpose. Refusing up front fails the attempt fast, which counts against the circuit. §4.7 |
| B7 | **The provider contract does not change.** `SummonRequest.queues` and `SummonReleaseRequest.queues` are additive (summon API `0.2`). The kit gains a repeated-argument check. | Providers pass `request.argv` through opaquely. No first-party or template provider reads `request.queue` [S, §4.8]. |

### 1.3 What it costs

| Part | Effort (bun-jobs session) | Other owners | Depends on |
|---|---|---|---|
| (A) the group budget, home and status | ~3.5 d | — | the expansion form; the hooks PR |
| (A) the shared circuit | ~1.5 d | — | PR-A1 |
| (A) API and persisted limits | ~2 d | UI ~1.5 d, examples ~1 d | PR-A1 |
| **(A) total** | **~7 d** | ~2.5 d | |
| (B) arguments and request | ~1.5 d | — | PR-A1 |
| (B) `runSummoned` for several workers | ~3 d | — | PR-B1 |
| (B) the shared-unit controller | ~5.5 d | — | PR-A1, PR-B1 |
| (B) API, conformance and docs | ~3.5 d | UI ~1.5 d, examples ~1.5 d | PR-B3 |
| **(B) total** | **~13.5 d** | ~3 d | |

§11 has the PRs.

---

## 2. What exists today

### 2.1 The controller is bound to one queue

| Fact | Where [S] |
|---|---|
| `SummonController` keeps `#ref = { ns, queue }` and uses it for every read and write | `summon/controller.ts:486`, `:626` |
| Each check reads demand, the live worker records and the marker for that ref, in parallel | `#read`, `:1100-1127` |
| The marker is one reserved entry, `__win:summon`, per queue. It holds `pending`, `watching`, `failures`, `lossStreak`, `backoffUntil`, `circuitOpenUntil`, `budget` (hour and day counts with window starts), `lastAttemptAt` and `last` | `summon/marker.ts:14`; `SummonMarker`, `summon/types.ts:446-507` |
| The budget's *limits* live in the controller's policy, not in the marker | `#gate`, `controller.ts:1683-1730`; `status()`, `:2605-2658` |
| Wanted workers = `min(maxWorkers, max(1, ⌈outstanding / jobsPerWorker⌉))`. Serving = live serving records (all, or summoned only). On the way = pending counts | `:1332-1369` |
| A claim is one compare-and-set on the marker: it appends to `pending` and increments `budget.hour` and `budget.day` | `:1406-1430` |
| The attempt id is SHA-256 of `(ns, queue, epoch, version)` | `marker.ts:77` |
| The claim-once entries `__win:summon-claim:<hash>` live under the queue's ref. For `count > 1` the controller opens them before the call | `claim.ts:136`; `controller.ts:1440` |
| The worker claims its attempt under its own ref, before its first record says it was summoned | `queue/BunQueueWorker.ts:4678-4705`; `claim.ts:162-232` |
| Triggers are one events subscription on the queue and a local-add hook on queues of that name | `controller.ts:990-1031`, `[ATTACH_QUEUE]` `:935-950` |
| Events are published on the queue's channel | `#publish`, `:1903-1925` |
| `wireRequest` puts one `--bun-jobs-summon-queue=` into `argv` | `:400-452` |
| `read()` in the argument parser takes the **last** occurrence of a flag | `summon/args.ts:42-53` |
| `runSummoned(worker, options)` drives one worker. Idle means `isSummonIdle` on that worker's queue | `summon/worker.ts:1285`, `:331`, `class SummonedRun` `:528` |
| `BunJobs` keeps one controller per queue name. `summon` is `Record<queue, SummonPolicy>` | `BunJobs.ts:170`, `:373`, `:596-623` |
| The API finds a queue's controller in its own process, or answers 409 `SUMMON_NOT_CONFIGURED` | `api/sources.ts:322-345`; routes `api/routes/queues.ts:854-927` |

### 2.2 What the expansion form gives, and what it leaves

The expansion form builds N independent controllers, one per queue, from one
policy. Each keeps its own marker. **Every guard therefore stays per queue**:

- **Budget.** `perHour: 30` over eight queues allows 240 attempts an hour.
- **Circuit.** A provider whose credentials expired fails five times *per
  queue* before every circuit is open: 40 failed calls for eight queues
  (`#failAtOnce` opens at once on `auth`, which helps, but only on the queue
  that saw it).
- **Units.** A burst landing on eight queues at once starts eight units. Each
  one pays its own cold start, minimum bill, idle tail and database pool.

(A) fixes the first two. (B) fixes the third.

### 2.3 Why users write this

A second summoning queue today means a second queue that copies an existing
controller's policy, as in a playground with two summoning queues: a second
compute platform, a second worker entry and a second `summonController(…)`
call whose policy repeats the first. Only the queue name and the handler
differ. The expansion form removes the copied
policy. (B) removes the second entry and platform when the queues can share
an image.

---

## 3. Part A: a shared budget and circuit across a group

### 3.1 What is shared, and what is not [D]

| Guard | Today | With (A) | Why |
|---|---|---|---|
| Budget counts (hour, day) | per queue | **per group**, plus per queue only if a queue sets its own | the user's money is one budget |
| Circuit (failures, open-until) | per queue | per queue, **plus per group and provider `kind`** when `group.circuit` is on | a provider outage is provider-wide |
| Backoff after a failure | per queue | per queue | short-lived; the circuit is the group-wide brake |
| Cooldown between attempts | per queue | per queue | about not double-summoning one queue's backlog |
| Attempts in flight, watch list | per queue | per queue | release is per queue's records |
| `maxPending`, `maxWorkers` | per queue | per queue | per-queue capacity decisions |

### 3.2 Option shape [D]

A new optional `group` field on `SummonPolicy`:

```ts
interface SummonPolicy {
  // …everything today…
  /**
   * Share guards with every controller naming the same group, in any
   * process. Absent: nothing is shared (today's behaviour).
   */
  group?: SummonGroupOptions;
}

interface SummonGroupOptions {
  /** The group's name: the key its shared state is stored under. A queue-name segment. */
  name: string;
  /**
   * The group's budget: attempts per UTC hour and day, across every queue in
   * it. Defaults to 30 and 300, as the per-queue budget does. `false` keeps
   * no group limit; attempts are still counted, so the UI shows group usage.
   */
  budget?: false | { perHour?: number; perDay?: number };
  /**
   * Share the circuit, per provider kind: `true`, or the thresholds. Defaults
   * to `false`. The thresholds default to the policy's `circuit`.
   */
  circuit?: boolean | { failures?: number; resetAfter?: number };
}
```

**The expansion form fills `group.name` for the user.** If it names its
groups (a key, or a `name`), that name is used. Otherwise (A) adds `name` to
it. Either way, one policy over eight queues becomes:

```ts
const jobs = new BunJobs({
  driver, namespace: "shop",
  summon: {
    media: {                                   // the group's name
      queues: ["renders", "thumbs", "previews"],
      summoner: ecs({ … }),
      group: { budget: { perHour: 60, perDay: 400 }, circuit: true },
    },
  },
});
```

The expansion form passes `group` through to each of the three controllers, so
there is nothing to duplicate. Controllers built by hand can join a group by
name. That includes controllers in different services, which is how a team
shares one cloud budget across deployments.

**The per-queue `budget` when a group budget is set** (A5, Q2). With
`group.budget` set and the queue's own `budget` *unset*, the per-queue budget
is off: `budget: false`, from the hooks PR. Counts are still kept on the
queue's marker, so the UI shows each queue's share. A `budget` set explicitly
still applies on top. Without this rule, a user who writes "60 an hour for the
group" gets 30 an hour per queue, silently.

Validation (`ConfigError` at construction): `group.name` passes
`assertSegment`. `group` on a driver without queue state is already refused,
because summoning is.

### 3.3 Where the group's state lives

The guards rest on compare-and-set, and the only compare-and-set primitive
the driver contract has is queue state: `getQueueState` and `setQueueState`
(`drivers/driver.ts:2768-2815`). The namespace-level `getState` and `setState`
(`:416-421`) have no version. So the entry lives under *some* queue ref.

| Option | Survives editing the group | Driver change | Verdict |
|---|---|---|---|
| **(H1) A reserved pseudo-queue, `{ ns, queue: "__bunjobs" }`** | yes: keyed by name | `listQueues` on file and memory filters it | **recommended** [D] |
| (H2) The group's first queue | no: reordering or removing the first queue starts a fresh budget mid-window; during a rolling deploy, old and new processes charge two different entries | none | rejected |
| (H3) A copy on every member queue | — | — | rejected: no multi-entry atomic write |

**Measured** [M, `state-home.ts`, §8.1], on all eight backends: an entry
written under a queue ref that was never ensured

- reads back and versions correctly, refuses a stale compare-and-set, and
  lists through `listQueueState`;
- goes with `purge`;
- **is invisible to `listQueues`** on SQLite, Postgres, MySQL, MariaDB, MongoDB
  and Redis.

**On file and memory it shows up as a queue.** The file driver lists the
`queues/` directories (`drivers/file-driver.ts:621-625`) and memory lists its
queue map (`drivers/memory-driver.ts:581-583`); a state write creates both. So
PR-A1:

- **reserves the queue name `__bunjobs`**: `assertSegment` refuses it as a
  queue name, and `BunQueue`/`BunQueueWorker` refuse to be built on it;
- **filters it** in those two drivers' `listQueues`;
- adds a **driver contract case** to the shared driver suite: "a reserved
  pseudo-queue's state never makes a queue", on all eight backends.

Memory cannot summon anyway, but its tests use the same code path. The packages
are unpublished, so reserving one name breaks no user (Q3).

### 3.4 The group entry [D]

```ts
/** `__win:summon-group:<name>` under `{ ns, queue: "__bunjobs" }`. Internal. */
interface SummonGroupEntry {
  v: 1;
  /** Random at creation, as the marker's, so (B)'s attempt ids never repeat after a purge. */
  epoch: string;
  /** Counts, windowed as the marker's (`rollBudget` reused). */
  budget: { hourStart: number; hour: number; dayStart: number; day: number };
  /**
   * The limits of the controller that last charged, so a reader without a
   * policy can show them (A6). Absent while the group budget is `false`.
   */
  limits?: { perHour: number; perDay: number };
  /** The shared circuit, per provider kind. Absent while `group.circuit` is off. */
  circuits?: Record<string, {
    failures: number;
    openUntil?: number;
    /** The attempt whose failure opened it, and its detail. */
    openedBy?: { queue: string; id: string; detail?: string };
  }>;
  /** Per queue, attempts charged this day: what the UI shows as each queue's share. */
  queues?: Record<string, { day: number; lastAt: number }>;
  /** Fields (B) adds when `unit: "shared"`: the whole `SummonMarker`'s (§4.3). */
}
```

It has the same shape discipline as the marker. A newer `v` is left alone (the
controller goes inert for the group's sharing only, with one `warn`), and
garbage is replaced with a `warn`, as `readMarker` does
(`summon/marker.ts:214-262`). New module: **`lib/summon/group.ts`**
(`readGroup`, `chargeGroup`, `refundGroup`, `noteGroupFailure`,
`noteGroupSuccess`, `resetGroup`), internal like `marker.ts`.

### 3.5 Charging: the order of writes [D]

A check's steps 1 to 5 are unchanged (`controller.ts:1129-1395`). The group
is read **only once a check has decided it wants a worker** (step 5), so a
check that summons nothing costs no extra read.

1. **Gate on the group:** read the entry. If its circuit for this `kind` is
   open, skip with `circuit-open`. If its budget is spent, skip with `budget`
   (the existing reasons). The `budget-exhausted` event and `onSummonFailed`
   carry `group: name`.
2. **Charge the group:** increment `hour` and `day`, compare-and-set, with up
   to 8 rounds. Losing every round gives `skipped: "contended"` and re-arms
   the debounce timer with jitter, so the check runs again in about 250 ms
   rather than waiting up to a poll.
3. **Claim the queue's marker,** exactly as today (`:1406-1435`).
4. **If the claim is lost** (`contended`), refund the group by one, with up to
   3 rounds and best effort.

**Why this order.** No backend offers a compare-and-set across two entries
here, so one of the two writes can land without the other:

| Fails between | Effect | Safe? |
|---|---|---|
| group charged, claim lost, refund lost | the group counts one attempt that never happened | **yes**: over-counts, under-spends |
| claim first, group charge lost (the other order) | an attempt is made that the group never counted | **no**: overspends. Rejected |

Over-counting is bounded by lost refunds, which need a crash or a backend
fault between two writes. The per-queue counts on the marker stay exact.

### 3.6 The shared circuit [D]

With `group.circuit` on, every place that counts a failure on the queue's
marker (`#fail` `:1738`, `#failAtOnce` `:1767`, `#failLate` `:1790`) also
calls `noteGroupFailure(kind)`. Every registration and proven success that
resets `failures` calls `noteGroupSuccess(kind)`. Each of these is one
compare-and-set with up to 3 rounds, written **after** the marker write lands.

- **Opens** at the group's threshold, or at once on `auth` and `misconfigured`
  (as `#failAtOnce`), for every controller in the group that uses that `kind`.
- **A lost group write under-counts one failure.** The per-queue circuit is
  still there as the backstop, so the worst case is today's behaviour.
- **Throttled** failures are not counted, as today.
- **Keyed by `kind`**: a group built by hand from controllers with different
  summoners keeps their outages apart. `kind` is stable across processes,
  whereas the configured provider id `name@version~<n>` is per process
  (`SummonStatusDto.summoner.providerId`).

### 3.7 Contention, measured

The group entry is written only on a charge, a refund, or (with the circuit)
a failure or success, not on every check. Its write rate is therefore bounded
by the attempts the group makes: by its budget, 60 an hour in the example.
Contention needs several controllers claiming **in the same instant**, as when
one upload fans out to eight queues.

[M, `state-home.ts`, §8.1]: K concurrent charges against one entry, against
K separate entries (today), median of three rounds, with the host at load 13
to 27 from peer sessions:

| Backend | K = 4, one entry | K = 16, one entry (max retries) | K = 64, one entry | K = 16, K entries |
|---|---|---|---|---|
| Postgres | 6.3 ms | 68 ms (15) | 309 ms | 4.2 ms |
| MySQL | 6.8 ms | 27 ms (15) | 181 ms | 6.4 ms |
| MariaDB | 2.3 ms | 7.7 ms (9) | 70 ms | 3.6 ms |
| MongoDB | 7.1 ms | 48 ms (11) | 448 ms | 13 ms |
| Redis | 0.9 ms | 6.4 ms (15) | 57 ms | 0.6 ms |
| SQLite | 0.8 ms | 7.2 ms (15) | 90 ms | 1.0 ms |
| file | 16 ms | 81 ms (2) | 210 ms | 0.9 ms |

The count was exact in every round on every backend. **Conclusion:** for a
group of up to about 16 queues claiming in one instant, the charge adds tens
of milliseconds once per summon, which is noise next to a cold start of tens
of seconds. The losers of a 16-way race need up to 15 rounds, so with the
8-round bound some skip as `contended` and run again a debounce later (§3.5),
never a poll later. At 64 simultaneous claims the last charge lands in about
0.3 to 0.45 s on Postgres and MongoDB. That is acceptable, and it is the
argument for (B) at that width, not against (A).

### 3.8 Status, reset, hooks and events [D]

- **`status()`** gains `group?: SummonGroupStatus`: the name, the budget
  (`hour`, `perHour`, `day`, `perDay`, or `disabled`), the circuit for this
  controller's `kind` (`failures`, `openUntil`), and per-queue `day` counts.
  The queue's own `budget` shows `disabled: true` when A5 turned it off (the
  hooks PR's field).
- **`reset({ group: true })`** clears the group's circuit for this `kind`.
  `reset({ group: true, budget: true })` also clears the group's counts. Both
  are the hooks PR's `reset` options, extended. 409 `SUMMON_MARKER_CONTENDED`
  as today.
- **`onSummonFailed`** (hooks PR): `budget-exhausted` and `circuit-open`
  decided at group level carry `group: name`. A group's `circuit-open` fires
  once per opening, from the controller whose write opened it (the hooks PR's
  rule, applied to the group entry).
- **Events:** the `summon` payload gains `group?: string` on
  `budget-exhausted` and on attempts.

### 3.9 Coexistence [D]

- **Per-queue markers do not change**, not even their shape, apart from
  persisted limits (§5.1), which a v1 reader keeps (it clones the whole
  value) and ignores.
- **Mixed versions during a rolling deploy:** an old process does not know the
  group. It charges only its queue's marker, and **the group budget can be
  exceeded by the old processes' attempts until the rollout completes.** This
  goes in the upgrade note.
- **A queue in two groups** (two controllers with different `group.name`
  values): each charges its own group. This is legitimate (a team budget and
  an org budget), and is documented.
- **Renaming a group** starts a fresh entry, budget included. This goes in the
  docs: "the name is the key".

---

## 4. Part B: one unit for several queues

### 4.1 When it is worth it

**What a unit costs, by term:**

| Term | Per-queue units (expansion form) | One shared unit | Source |
|---|---|---|---|
| Bun boot + connect + registration, this host | N processes: **0.58 to 0.85 s** for N = 8 | **0.21 to 0.44 s** for N = 8; 0.18 to 0.33 s for N = 1 | [M, `unit-boot.ts`, §8.2] |
| Memory, this host | ~67 MB per unit: **~530 MB** for N = 8 | **~70 MB**, flat in N | [M, §8.2] |
| Database pools | N | 1 (one `BunJobs`, one driver) | [S] `BunJobs` builds one driver per context |
| Platform cold start | N, in parallel; each attempt has its own `bootBudget` | 1 | SC §7.1's defaults, 60 to 180 s, are [I] |
| Minimum bill | N × (1 min on Fargate and Cloud Run jobs) | 1 × | [V-prior, SC §10.1] |
| Idle tail (`idleFor`, 30 s by default) | N × | 1 × | SC §10.1 |
| Attempts against the budget and quota | N per correlated burst | 1 | §3 |
| Isolation between queues' code, secrets and crashes | yes | **no**: one image, one process, one OOM | [I] |
| Per-queue scaling | each queue scales alone | units = the most-starved queue's need; the others get idle workers | §4.4 |

**Worked estimate** [I on V-prior prices]. Eight queues each get a burst of 20
one-second jobs in the same minute, on Fargate x86 at 1 vCPU / 2 GB
(≈ $0.00082 a minute, billed per second with a one-minute minimum):

- **Per-queue:** 8 units × max(1 min, ~20 s work + 30 s idle) = 8 billed
  minutes ≈ **$0.0066**, 8 attempts against the budget, 8 tasks against the
  account's concurrency quota, 8 pools on the database.
- **Shared:** 1 unit, with the eight queues' work in parallel inside it,
  ~20 s + 30 s idle = 1 billed minute ≈ **$0.0008**, 1 attempt, 1 task, 1 pool.

**The money is pennies either way. The counts are what matter:** a budget of
30 an hour lasts one 8-queue burst every 16 minutes per-queue, against one
every 2 minutes shared. Platform concurrency quotas and Postgres
`max_connections` are hit 8× sooner.

**Who gains:**

- many **light** queues whose bursts are **correlated** (one upload fans out
  to render, thumbnail, preview and index);
- platforms with a minimum bill or a slow cold start (Fargate, Cloud Run jobs,
  ACA);
- wake-style pools with a small `poolSize` (Fly): one Machine per queue
  exhausts the pool;
- database servers near their connection limit.

**Who does not:**

- heavy, independent queues, which want separate scaling;
- queues with different images, resources or secrets;
- untrusted job code, where a crash or OOM in one queue must not take the
  others down;
- teams that already run one always-on worker per queue.

**Recommendation:** build (A) first. Build (B) when the user has, or expects,
the fan-out shape. A pair of summoning queues, as in a playground with two, is
small enough that (A) alone would do.

### 4.2 Option shape [D]

```ts
interface SummonGroupOptions {
  // …(A)'s fields…
  /**
   * `"per-queue"` (default): one controller per queue, each summoning units
   * for its queue alone (the expansion form). `"shared"`: one controller for
   * the group, and every unit it summons runs a worker for each of the
   * group's queues (`runSummoned` with several workers).
   */
  unit?: "per-queue" | "shared";
}

/** One queue of a group, with what may differ per queue. */
type SummonQueueEntry =
  | string
  | {
      queue: string;
      /** Outstanding jobs one unit's worker for this queue should take. Defaults to the policy's. */
      jobsPerWorker?: number;
      /** The most units this queue's demand alone may ask for. Defaults to the policy's `maxWorkers`. */
      maxWorkers?: number;
    };
```

The expansion form's `queues` accepts `SummonQueueEntry[]`. **Why an array of
entries rather than a record keyed by queue:** it keeps one ordered shape for
both the plain and the overridden case. JavaScript also moves integer-like
keys first in a record, so a queue named `"2"` would reorder the argv.

**What else may differ per queue on the summoned side:** each worker's own
options (concurrency, limits, handlers) are the worker's, set in the unit's
entry script, as today. The controller needs only `jobsPerWorker` and
`maxWorkers` per queue. Everything else in the policy (summoner, budget,
`maxLifetime`, `env`, triggers, `bootBudget`) is per unit, so per group.

`new SummonController({ …, queues, group })` gains `queues?:
readonly SummonQueueEntry[]` beside `queue`. Exactly one of the two is given,
and `queues` requires `group.unit: "shared"` (otherwise the expansion form is
the right tool). `controller.queue` stays and is the first queue.
`controller.queues` is new.

### 4.3 State: the group entry becomes a full marker [D]

With `unit: "shared"`, the group entry (§3.4) also carries every
`SummonMarker` field: `pending`, `watching`, `failures`, `lossStreak`,
`backoffUntil`, `circuitOpenUntil` and `last`. The controller then runs its
whole check against **that** entry instead of a queue's `__win:summon`.

**Mechanically:** `#ref` splits into `#home` (where the marker is) and
`#queues` (where demand, records, claims and triggers are). Every
`getQueueState`/`setReservedState` of `SUMMON_MARKER` goes through one
`#markerAt()`. For a one-queue controller, `#home` is the queue's ref and the
name is `__win:summon`, so the single-queue path is the same code with the
same values.

- **Budget, circuit and backoff are then naturally shared:** there is one
  controller and one marker.
- **Attempt ids:** `attemptId(ns, "group:" + name, epoch, version)`. The
  inputs are NUL-separated, so a group id never equals a queue's.
- **Switching a group from `"per-queue"` to `"shared"`** keeps the budget
  counts and the circuit, because it is the same entry. The old per-queue
  markers' attempts in flight are left to their units, which exit on idle;
  nothing reads those markers again. This is noted in the docs.

### 4.4 The decision: combined demand, per-queue capacity [D]

Per check, for each queue q, using the same reads as today, once per queue:

```text
demand_q, records_q   = readDemand(q), listWorkerRecords(q)
serving_q             = serving records on q (servedBy filter, as today)
idle_q                = as today, per queue
wanted_q              = 0                                   if paused_q, or demand_q = 0 and not orphaned_q
                        min(maxWorkers_q, max(1, ⌈outstanding_q / jobsPerWorker_q⌉))   otherwise
deficit               = max over q of (wanted_q − serving_q)
summonedLive          = max over q of (records on q with a summon id)   ≈ units alive
want                  = min(deficit, maxWorkers − summonedLive) − onTheirWay
```

- **The maximum, not the sum:** every unit adds a worker to *every* queue.
  If renders needs 3 and thumbs needs 1, three units give renders 3 and thumbs
  3. A sum would start four.
- **Always-on workers count per queue** (`servedBy: "any-worker"`): a queue
  with its own fleet contributes no deficit.
- **The `maxWorkers` cap on units alive is approximate**, from the largest
  per-queue count of summoned records. A unit missing a queue's worker
  (partial, §4.5) is still counted on the queues it has, and the documentation
  says so.
- **The fast path** (`#servedUntil`, `:1342`) becomes per queue: a
  `Map<queue, until>`. An add to a covered queue still returns at once.
- **Scale style:** release only when **every** queue is idle for
  `scaleDown.after`. `SummonReleaseRequest` gains `queues`.
- **Demand cap** (`#demandCap`): per queue, from that queue's `maxWorkers ×
  jobsPerWorker`.
- **`request.demand`** stays one `QueueDemand`: the most-starved queue's.
  `request.demands` gives all of them, keyed by queue. Both are already
  outside the purity rule (`SummonRequest.demand`, `types.ts:105-109`).

### 4.5 Claims, release, partial coverage and the watch [D]

**Claims stay per queue.** Each summoned worker claims the attempt id under
its own queue (`BunQueueWorker.ts:4678`), unchanged. For `count > 1` the
controller opens a claim with capacity `count` on **every** member queue
before the call (N writes instead of 1, at `controller.ts:1440`). Each
queue's claim then admits at most `count` holders, so **no queue ever counts
more summoned places for one attempt than were asked for**, which is the
property claim-once exists for (`claim.ts:7-36`).

**A double start** (a platform starting two processes with one argv) can
split the places: P1 wins renders, and P2 wins thumbs. Each process then runs
one summoned worker and one ordinary worker. Per queue, the accounting is
correct, both processes drain, and both exit on idle. This is the same outcome
as today's double start (the loser runs unsummoned), applied per queue.

**Release, per attempt, from every member queue's claim:**

| What the claims say by `until` | Outcome | Counts as a failure? |
|---|---|---|
| a holder registered on **every** queue | `registered` | no |
| registered on **some** queues | `registered`, detail `partial:<missing queues>`, plus one `error` naming the missing queues | **yes, one failure** (B4) |
| registered on none; a mark or a death | `lost`, `exited-with-error` or `died`, as today | yes |
| nothing | `lost` | yes |

The partial rule is about cost safety. An image whose entry script forgot a
queue registers on the others, so without it every check would see that queue
starving, summon again, and "succeed" again: a loop that only the budget
would stop. Counted as a failure, it backs off and opens the circuit after
`circuit.failures` attempts.

**The watch** (`#watch`, `:2438`) tallies an attempt across every queue's
claim. A death on any queue is one late loss for the attempt, never one per
queue.

**Read cost per check:** N × (`countDemand` + `listWorkerRecords`), plus one
marker read, plus claims (`(pending + watching) × N` reads, bounded by
`maxPending × N` plus the watch limit × N). That is the same per queue as N
controllers today, but with one poll timer instead of N. The claim sweep
(`#sweepClaims`, `:2581`) runs over every member queue, hourly.

### 4.6 Triggers and events [D]

- **Triggers:** one events subscription per member queue, and `[ATTACH_QUEUE]`
  on each queue of a member's name. They all arm the controller's single
  debounce, so a burst across eight queues makes one check.
- **Events:** each `summon` event is published on **every** member queue's
  channel, with `group` and `queues` in the payload, so each queue's Events
  screen and socket show it. That is N publishes per event, and events are
  rare (one per attempt state change).

### 4.7 The summoned side [D]

**Arguments.** `wireRequest` (`:400`) writes, in policy order:

```text
--bun-jobs-summon-id=sm_…   --bun-jobs-summon-kind=ecs   --bun-jobs-summon-mode=exit-on-idle
--bun-jobs-summon-namespace=shop
--bun-jobs-summon-group=media
--bun-jobs-summon-queue=renders   --bun-jobs-summon-queue=thumbs   --bun-jobs-summon-queue=previews
--bun-jobs-summon-max-lifetime-ms=3600000   --bun-jobs-summon-grace-ms=10000
```

- **A repeated flag, not a list in one flag:** queue names may contain `.`,
  `-` and `_` (`shared/keys.ts:34-58`), so any delimiter would need escaping.
- **One queue writes no `--bun-jobs-summon-group=`:** a one-queue argv is
  byte-identical to today's, so dedupe tokens and the purity check are
  unaffected.
- **The order is the policy's order and is fixed per attempt**, so a retried
  call is byte-identical (CP §12.2 purity).
- **Identity in the arguments only** (SC §5.5) is unchanged: nothing new goes
  into `env`.

**`summonedFromArgs()`** (`args.ts`) collects every
`--bun-jobs-summon-queue=` into a new `queues: string[]`, in order, with
duplicates dropped. `queue` becomes `queues[0]`. `read()` takes the last
occurrence today, and that difference is invisible for one queue. A new
optional `group` is added; it is written on the worker record's `summon`, so
the Workers page can say "unit of media".

**Version skew:** an *older* entry script reads only one queue (the last,
with today's `read()`) and builds one worker. The controller sees `partial` and
counts a failure (B4), so the result is loud and bounded. It is also in the
upgrade note.

**`runSummoned` with several workers:**

```ts
const summon = summonedFromArgs();
const handlers = { renders: render, thumbs: thumb, previews: preview };
const workers = (summon?.queues ?? ["renders"]).map((queue) =>
  jobs.worker(queue, handlers[queue], { summon }));
await runSummoned(workers, { idleFor: 30_000 });
```

`runSummoned(worker | readonly BunQueueWorker[], options)`. `SummonedRun`
(`worker.ts:528`) generalises from one worker to a set:

- **Refusals first** (`ConfigError`, before anything runs): an empty array, two
  workers on one queue, workers whose `summon.id` differ, or **a queue named
  in the arguments with no worker** (Q7). The error ends the process with code
  1 before any claim, so the attempt is `lost` at `until` and counts against
  the circuit: fast and loud.
- **A worker on a queue the arguments do not name:** a `warn`. It runs, and
  it claims under its own queue, which is harmless.
- **Idle** = every worker's queue is `isSummonIdle` (`worker.ts:331`), where
  `otherLiveWorkers` excludes this unit's own worker on that queue. That is
  one `countDemand` per queue per `idleCheckInterval`.
- **Parked** = every worker parked. If only some are parked, the unit runs on.
- **Signals, the deadline and the backstop:** one set per unit, already per
  process.
- **The close rule:** all workers close concurrently under one budget `A`.
  The target's share is the **largest** of the workers' targets' close
  constants, because they close in parallel.
- **One worker's `run()` failing** closes them all, with reason `error` and
  code 1.
- **An owner closing one worker** leaves the others running. The unit ends,
  with reason `closed`, once every worker has.
- **Exit marks:** each worker marks its own claim with the unit's reason and
  code (`markSummonClaimExit`, `claim.ts:379`).
- **`SummonedExit`** keeps `completed` and `failed` as totals and gains
  `queues: Record<queue, { completed, failed }>`.

**The worker-thread caveat.** Bun gives a `Worker` thread an empty `argv`
(`args.ts:16-18`), so
`summonedFromArgs()` inside a thread answers `undefined`. `runSummoned` needs
every worker in the calling thread, because it owns the process's signals. A
user who runs each queue's *jobs* in threads uses the worker `target` option,
which is unaffected: the `BunQueueWorker` stays in the main thread. A user
who builds whole workers inside their own threads must pass `summon` in
`workerData` and cannot use `runSummoned`. The docs say so in one line.

### 4.8 Providers and the conformance kit [D]

- **No provider change is needed.** Providers hand `request.argv` to the
  platform as a whole: the template (`templates/compute-provider/src/index.ts:181`)
  and Local Compute (`feat/local-compute`, `providers/local.ts:280`). No
  first-party or template provider reads `request.queue` [S, grep].
- **Additive fields:** `SummonRequest.queues: readonly string[]` (always
  present; `[queue]` for one queue), `SummonRequest.group?: string`,
  `SummonRequest.demands?`, and `SummonReleaseRequest.queues`. The summon
  facet's API goes from `0.1` to **`0.2`**. A provider declaring `0.1` runs
  unchanged (`provider/version.ts`: only a *newer* minor than the build warns).
- **New kit check, "argv round trip" (must):** the fake's unit receives a
  request whose argv repeats a flag three times, and the fixture worker must
  see all three, in order. A platform layer that dedupes or reorders arguments
  (a shell-quoting bug, or a map keyed by flag) would otherwise break (B)
  silently.
- **The two-queue handoff (should):** the kit's existing handoff
  (`provider/testing/handoff.ts`) runs a second time with a shared-unit
  controller over two queues, and the fixture worker builds two workers. It is
  a "should", because a provider that passes the round trip cannot fail it,
  but it proves the whole path on the author's own platform fake.
- **Argument length.** N repeated flags add about 30 bytes plus the name per
  queue. Platform argument limits are [U] for this plan. The ECS command
  override and others are recorded in SC's evidence as JSON fields, without a
  measured cap. The docs recommend groups of tens of queues, not hundreds,
  and `wireRequest` refuses argv over 8 KiB with a `ConfigError` at
  construction.

### 4.9 Overlap: a queue in a shared unit and in another controller [D]

A shared-unit group and a per-queue controller (or a second group) over the
same queue cannot see each other's attempts in flight: they read different
markers. During a cold start, each sees "work and no worker" and both summon.
Once either unit registers, the other controller sees a serving worker and
stops (any-worker). So the cost is **one extra unit per boot window**, within
each controller's own budget.

- **In one process**, the overlap is refused: `BunJobs` throws a
  `ConfigError` when two of its controllers name one queue and either is
  `"shared"`.
- **Across processes**, it is documented ("one queue, one summoning
  controller"), and the status warns. A controller that sees live summoned
  records on its queue carrying a `group` other than its own logs one `warn`,
  and its status lists `overlaps: [group]`. This is cheap, because the record
  already says which group started it (§4.7). Q9 asks whether to go further
  and write an ownership entry.

---

## 5. API and UI

### 5.1 Readable without a local controller (both parts) [D]

Today, `GET /queues/:queue/summon` needs a controller in the API's process,
or it answers 409 `SUMMON_NOT_CONFIGURED` (`api/sources.ts:322-345`), and
`local` is always `true` (`api/contract/types.ts:1222-1235`). This is because
the limits live only in a policy. **Persist them:** every claim writes
`limits` into the marker it claims (`{ perHour, perDay }`, or absent when
`budget: false`), and into the group entry (§3.4). An API with no controller
for the queue then answers from the backend alone:

- `local: false`, no `summoner` (it is unknown here), the marker's `pending`,
  `failures`, `backoffUntil`, `circuitOpenUntil`, `last`, and `budget` with
  the persisted limits;
- `group`, when the marker names one;
- "Summon now" and reset still need a controller: 409 as today.

The marker gains `limits?` and `group?`. Both are optional, both survive a v1
read-modify-write, and neither bumps `v`.

### 5.2 Routes [D]

| Route | Action | Answers |
|---|---|---|
| `GET /queues/:queue/summon` | `queues.read` | as today, plus `group` (A), and for a shared unit (B) the group's state with `queues` |
| `GET /summon/groups` | `queues.read` | every group in the namespace: name, budget used and limits, circuit, unit mode. Listed from `listQueueState({ ns, queue: "__bunjobs" }, { prefix: "__win:summon-group:" })`, which works on all eight backends [M, §8.1] |
| `GET /summon/groups/:group` | `queues.read` | one group, `SummonGroupStatusDto`, with no local controller needed |
| `POST /summon/groups/:group/reset` | `queues.summon` | `{ circuit?: boolean, budget?: boolean }`, through any local controller in the group; 409 `SUMMON_NOT_CONFIGURED` without one |
| `POST /queues/:queue/summon` | `queues.summon` | as today; for a shared unit, runs the group's check |

The DTOs are `SummonGroupStatusDto` (new) and `SummonStatusDto` plus `group?`
and `queues?`. They mirror the status types field by field, as today.
OpenAPI is generated from the route definitions, as for every route.

### 5.3 The UI [D]

The UI session owns this.

- **Summon tab** (`app/screens/queues/panels/SummonPanel.tsx`): a **Group**
  card when the queue is in one. It shows the group budget ("41 of 60 this
  hour, 220 of 400 today, shared by 3 queues"), this queue's share, the group
  circuit for the provider, and a link to the group. The existing Budget row
  shows "off (group budget)" when A5 turned it off.
- **For a shared unit** the tab shows the group's attempts, with each one's
  coverage per queue (renders ✓, thumbs ✓, previews pending). A `partial`
  shows as an error row naming the missing queue.
- **Budget usage per controller**, as the user asked, on a new **Summon
  groups** list (under Queues, or on Overview, as the UI session prefers): one
  row per group with budget used and limits, circuit state, unit mode and
  member queues. It reads `GET /summon/groups`.
- **Without a local controller** (`local: false`), the tab is read-only:
  "Summon now" and reset are hidden, and a note says where the controller
  runs.
- **Workers page:** a summoned worker's card says "unit of media" from
  `summon.group`.

---

## 6. Back-compat and migration

**A single queue keeps working unchanged** [D], and this is a gate on every
PR:

| Thing | Single-queue, after (A) and (B) |
|---|---|
| Marker name, location and shape | unchanged (`__win:summon` on the queue; `limits` and `group` are optional extras) |
| Attempt ids | unchanged (`attemptId(ns, queue, epoch, version)`) |
| argv | byte-identical (no `--bun-jobs-summon-group=`; one `--bun-jobs-summon-queue=`) |
| `summonedFromArgs()` | same fields, plus `queues: [queue]` |
| `runSummoned(worker)` | same signature and behaviour |
| `SummonRequest` | same fields, plus `queues: [queue]` |
| `BunJobsOptions.summon` as `Record<queue, SummonPolicy>` | unchanged |
| API routes and DTO fields | unchanged, plus optional `group` |

**Persisted data.** The packages are unpublished, but markers exist in users'
drivers.

- **(A)** adds a new entry and changes no existing one. Nothing to migrate.
- **(B)** reuses (A)'s entry. Switching a group to `"shared"` leaves the old
  per-queue markers in place, unused, and harmless.
- **The pseudo-queue name `__bunjobs`** becomes reserved. A user queue with
  that exact name (none is known) would be refused at construction with a
  `ConfigError` that names the rule.

**The hooks PR.** (A) uses its `budget: false` (A5), extends its `reset`
options, and adds `group` to its `SummonFailure`. PR-A1 rebases on it.

---

## 7. Tests and conformance

Every cross-process test runs on the seven multi-process backends, through
`crossProcessBackends()` (`__tests__/helpers/backends.ts:170`), and skips
visibly when a URL is unset. As the repo's rule says, a URL that is set but
unreachable fails.

**(A):**

1. **No overspend under a race** (the headline). Eight controllers in **four
   processes**, one group with `perHour: 5`, eight queues all given work at
   once, a fake summoner counting calls: **exactly 5 calls**, group `hour = 5`
   (or 6 with a lost refund, never fewer than calls), and per-queue counts
   summing to the calls. Run 20 times per backend.
2. **Fails closed:** a driver wrapper that drops the refund write. The group
   over-counts by one and the calls never exceed the limit.
3. **The shared circuit:** a summoner failing `auth` on queue 1 opens the
   circuit for every controller of that `kind`, with **one** failed call in
   the group, against today's one per queue. A different `kind` in the same
   group is unaffected.
4. **Budget off per queue under a group (A5)**, and an explicit per-queue
   budget still binding.
5. **Pseudo-queue:** driver contract "a reserved-ref state write never makes a
   queue" on all eight backends; `assertSegment("__bunjobs")` refused as a
   queue.
6. **Status without a controller:** an API built with `driver` only reads a
   marker and a group written by another process (`local: false`, persisted
   limits).
7. **Back-compat:** the existing summon suites run unchanged
   (`summon-controller.test.ts`, `summon-race.test.ts`,
   `summon-register-claim.test.ts`, …). A snapshot of single-queue argv and
   attempt ids before and after.

**(B):**

1. **No double summon:** two shared-unit controllers in two processes over
   three queues, one backlog per queue. **One** summoner call, one pending
   attempt, and three registered workers, one per queue. Repeated across
   seeds.
2. **Attribution:** a unit's three workers release the one attempt. Records
   on each queue carry the id and `group`. Each queue's capacity counts the
   unit once.
3. **Maximum, not sum:** renders needs 3 (`jobsPerWorker: 10`, 30 jobs),
   thumbs needs 1, so 3 units are started, not 4. Per-queue `maxWorkers: 1`
   on renders gives 1.
4. **Partial coverage:** a fixture unit without a thumbs worker gives
   `registered` with `partial:thumbs` and one failure. Repeated, it opens the
   circuit at the threshold, and the summoner call count stops there.
5. **Double start:** the fake starts two processes per attempt. Per queue, at
   most `count` summoned records carry the id, both processes drain, and the
   attempt releases once.
6. **`runSummoned(workers[])`:** a missing queue gives a `ConfigError` before
   any claim; idle waits for every queue; a signal closes all within the
   budget; exit marks on every claim; a failure of one worker's `run()` gives
   code 1.
7. **A death in a unit** (SIGKILL after the first job) is one late `lost`,
   `died`, for the attempt, not three.
8. **Scale style:** no release while any queue has work; released once all
   are idle for `scaleDown.after`.
9. **Conformance kit:** the argv round trip (must) on Local Compute and the
   template's fake. The two-queue handoff (should) on the template, run by its
   gate (`templates/compute-provider`: `bun test && bun
   scripts/check-types.ts`).
10. **Examples** (the examples session): `examples/bun-jobs/…/summon-group-budget.ts`
    and `…/summon-shared-unit.ts`, on all eight backends, run alone if they
    assert a duration (`RUN_ALONE`).

**The bench guard:** none of this is on the claim path, so no new scenario.
The enqueue hook's fast path becomes a map lookup; `queue.ts --compare` must
stay green.

---

## 8. Measured evidence

On 2026-10-06, on one shared laptop: i9-11900H, 16 threads, Linux
7.0.0-31-generic, Bun 1.4.3 (`5f554969`), with the test servers from
`scripts/setup-databases.ts` (Postgres 5432, MariaDB 3306, MySQL 3307, Redis
6379 db 15, MongoDB 27017). Peer sessions were running throughout, at **load
average 13 to 27** at the start of each run, so treat absolute times as
upper-ish bounds. The comparisons within a run are the finding.

### 8.1 `state-home.ts`: the home, and contention

`bun docs/plans/evidence/summon-multi-queue/state-home.ts`, with the five
`BUN_JOBS_TEST_*_URL` variables exported. Raw output in
`results-state-home.txt`.

**Part 1**, an entry under `{ ns, queue: "__summon" }` (the name used by the
spike), never ensured:

| Backend | create / CAS / stale refused | `listQueueState` | listed by `listQueues` | gone after `purge` |
|---|---|---|---|---|
| memory | 1 / 2 / yes | yes | **yes** | yes |
| file | 1 / 2 / yes | yes | **yes** | yes |
| sqlite, postgres, mysql, mariadb, mongodb, redis | 1 / 2 / yes | yes | no | yes |

**Part 2:** the table in §3.7. The full grid (K = 1, 4, 16, 64; one entry
against K entries; wall time, p50, p99, retries, count check) is in the raw
output. Every count was correct.

### 8.2 `unit-boot.ts`: one unit with N workers against N units

`bun docs/plans/evidence/summon-multi-queue/unit-boot.ts` (it spawns
`unit.ts`). It measures the time from spawn until **every** queue has a
heartbeat record the controller would count (`listWorkerRecords`), and sums
the children's RSS at `ready`. It is the median of three rounds. Two runs:

| Backend | N | 1 unit × N workers: registered / RSS | N units × 1 worker: registered / RSS |
|---|---|---|---|
| sqlite | 1 | 175–327 ms / 69–71 MB | — |
| sqlite | 4 | 186–291 ms / 71–73 MB | 248–422 ms / 269–276 MB |
| sqlite | 8 | 207–310 ms / 70–71 MB | 583–600 ms / 526–551 MB |
| postgres | 4 | 378 ms / 67 MB (run 1: 1,221 ms) | 486–487 ms / 261–270 MB |
| postgres | 8 | 346–444 ms / 68 MB | 737–850 ms / 531–535 MB |
| redis | 4 | 265 ms / 69 MB | 333 ms / 258 MB |
| redis | 8 | 300 ms / 66 MB | 649 ms / 533 MB |

Run 1's first Postgres rows (3.9 s for N = 1 and 1.2 s for N = 4) did not
recur in run 2 (0.3 to 0.4 s). They are kept in `results-unit-boot.txt` and
read as start-of-run noise on a loaded host, not as a property of either shape
[I].

**What this does not measure:** a platform's cold start, image pull and
scheduling, which come on top per unit and dominate (§4.1). Those numbers are
SC's, and its `bootBudget` defaults are [I].

---

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **A rolling deploy mixes versions:** old processes ignore the group budget | certain during a rollout | upgrade note; the per-queue budget stays on until every process is new, if the user wants that (an explicit per-queue `budget`) |
| **A lost refund over-counts the group** | rare (a crash or backend fault between two writes) | fails closed by design; `reset({ group: true, budget: true })` |
| **A lost group-circuit write under-counts one failure** | rare | the per-queue circuit is the backstop |
| **A 64-way simultaneous claim** waits about 0.3 to 0.45 s on Postgres or MongoDB | low | measured (§3.7); bounded rounds, then `contended` and a debounced retry; (B) removes the race at that width |
| **Reserving `__bunjobs`** collides with a user queue | very low | unpublished packages; a `ConfigError` names the rule |
| **(B): one image holds every queue's code and secrets** | inherent | §4.1 says when not to use it; per-queue stays the default |
| **(B): an OOM or crash takes every queue's jobs down** | inherent | at-least-once recovery as today; documented |
| **(B): partial coverage from version skew** | certain on a mixed rollout | counted as a failure, so loud and bounded (B4) |
| **(B): argument length** on some platform | unknown | refuse argv over 8 KiB at construction; Q10 |
| **(B): N × reads per check** | certain | the same per queue as N controllers; one poll timer instead of N |
| **Overlap across processes** double-summons during boot | medium if misconfigured | in-process refusal; record-based warning; docs |

---

## 10. Open questions for the user

Each question has a recommended answer.

**Decided by the user on 2026-10-06:** every recommended answer below was
accepted. (A) is approved for building once the expansion form has landed; (B)
waits for a workload that needs it. The names in §12 are still approved PR by
PR.

1. **Approve (A) alone, and (B) later?** **Recommended: yes.** (A) is ~7 d and
   answers "one budget". (B) is ~13.5 d and pays only for correlated light
   queues (§4.1). Decide (B) on the workload.
2. **With a group budget, turn the per-queue budget off by default (A5)?**
   **Yes.** Otherwise "60 an hour for the group" silently means 30 an hour per
   queue as well. An explicit per-queue `budget` still applies.
3. **The home: a reserved pseudo-queue (`__bunjobs`, with a `listQueues`
   filter on file and memory), or the group's first queue?** **The
   pseudo-queue.** The first queue moves the budget whenever the group is
   edited or reordered (§3.3).
4. **Share the circuit by default?** **No, opt-in (`circuit: true`).** The
   budget is what the user asked to share. A shared circuit changes failure
   behaviour across queues, which should be a deliberate choice. It is keyed by
   `kind` either way.
5. **Share backoff and cooldown too?** **No.** They are per-queue decisions,
   and the shared circuit covers the provider-wide case.
6. **(B) combines demand by maximum, with per-queue `jobsPerWorker` and
   `maxWorkers`?** **Yes** (§4.4). A sum over-summons; a single global ratio
   cannot express one heavy queue.
7. **(B) `runSummoned` refuses a queue named in the arguments with no worker?**
   **Yes, always.** An escape hatch (`missingQueues: "allow"`) would recreate
   the partial-coverage loop on purpose. A unit that should serve fewer queues
   belongs to a different group.
8. **(B) a partial unit counts one failure?** **Yes** (B4). It is the only
   brake besides the budget on an image that forgot a queue.
9. **Overlap across processes: warn from records, or also write a per-queue
   ownership entry?** **Warn only**, plus the in-process refusal. An ownership
   entry needs a lease to go stale correctly (one write per queue per hour,
   plus a takeover rule), which is more machinery than a documented rule needs.
   Revisit if a user hits it.
10. **(B) the argv limit:** refuse over 8 KiB? **Yes**, at construction. It is
    a guess at the tightest common platform limit [U]. The first-party
    providers' slices should each record their platform's real cap.
11. **Status without a local controller (§5.1): do it in (A), for single
    queues as well?** **Yes.** It is the same change (persist the limits), it
    closes SC §13.7's recorded follow-up, and the UI needs it to show group
    budgets from any process.
12. **A convenience on `BunJobs` for the summoned side**, such as
    `jobs.runSummoned(handlersByQueue, options)`, which builds the workers
    from the arguments? **Not now.** The four-line snippet in §4.7 is clear,
    and the helper would need every worker option per queue. Revisit after the
    examples.

---

## 11. PR slicing and effort

Focused days for someone who knows the code, as in the other plans. Each PR
passes the full gate alone (typecheck, `CI=1 bunx eslint .`, `bun test` and
`--randomize` in bun-jobs; the UI and template gates where touched), and
leaves the package coherent. **Each PR that changes something the examples
read is reported to the examples session before merging.**

### 11.1 Part A (approvable alone)

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-A1** the group budget | `group: { name, budget }`; `lib/summon/group.ts`; the `__bunjobs` reservation, the `listQueues` filter on file and memory, and the driver contract case; gate, charge, refund and `contended` re-arm in the controller; A5; `status().group`; `reset({ group, budget })`; `group` on `onSummonFailed` and events; tests 1, 2, 4, 5, 7 | expansion form, hooks PR | ~3.5 d |
| **PR-A2** the shared circuit | `group.circuit`; `noteGroupFailure` and `noteGroupSuccess` from `#fail`, `#failAtOnce`, `#failLate` and registrations; keyed by `kind`; test 3 | PR-A1 | ~1.5 d |
| **PR-A3** status everywhere | `limits` and `group` on the marker; `local: false` reads in `api/sources.ts`; `GET /summon/groups`, `GET /summon/groups/:group`, `POST …/reset`; DTOs and schemas; test 6 | PR-A1 | ~2 d |
| *UI-A* | Group card on the Summon tab; Summon groups list; read-only `local: false` | PR-A3 | *~1.5 d (UI session)* |
| *EX-A* | group budget example; README section | PR-A1 | *~1 d (examples session)* |
| | **Total (bun-jobs)** | | **~7 d** |

### 11.2 Part B (after PR-A1)

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-B1** arguments and request | repeated `--bun-jobs-summon-queue=`, `--bun-jobs-summon-group=`; `SummonedArgs.queues` and `group`; `summon.group` on the record; `SummonRequest.queues`, `group` and `demands`; `SummonReleaseRequest.queues`; summon API `0.2`; the 8 KiB refusal; the kit's argv round trip (must) | PR-A1 | ~1.5 d |
| **PR-B2** `runSummoned(workers[])` | `SummonedRun` over a set; refusals; joint idle and parked; one close budget; per-worker exit marks; `SummonedExit.queues`; test 6 | PR-B1 | ~3 d |
| **PR-B3** the shared-unit controller | `unit: "shared"`; `queues` on `SummonControllerOptions`; `#home` and `#queues` split; group entry as a full marker; max-combination; per-queue fast path; claims on every member queue; partial coverage; the watch across queues; N triggers; events on every member queue; scale-down when all idle; the in-process overlap refusal and the record-based warning; `BunJobs` wiring through the expansion form; tests 1–5, 7, 8 | PR-A1, PR-B1 | ~5.5 d |
| **PR-B4** API, kit and docs | per-queue routes answer for a shared unit (`queues`, coverage); the kit's two-queue handoff (should); template README; bun-jobs README ("one unit for several queues", §4.1's table); test 9 | PR-B3, PR-B2 | ~3.5 d |
| *UI-B* | per-queue coverage of attempts; "unit of" on worker cards | PR-B4 | *~1.5 d (UI session)* |
| *EX-B* | shared-unit example on all backends; a playground group (the playground rule: every finished feature goes there) | PR-B4 | *~1.5 d (examples session)* |
| | **Total (bun-jobs)** | | **~13.5 d** |

**Order:** PR-A1 → (PR-A2 ∥ PR-A3) → PR-B1 → (PR-B2 ∥ PR-B3) → PR-B4. PR-B2
does not need PR-B3: it can be tested against hand-built argv.

---

## 12. Names needing approval

Every new public name. Nothing here is built.

| Name | Kind | Where | Why this name |
|---|---|---|---|
| `group` | policy field | `SummonPolicy` | what is shared, named once |
| `SummonGroupOptions` | type | root, `./summon` | the options of `group` |
| `group.name`, `group.budget`, `group.circuit` | fields | `SummonGroupOptions` | the same words as the policy's `budget` and `circuit` |
| `group.unit: "per-queue" \| "shared"` | field | `SummonGroupOptions` | says what one summon starts |
| `queues` | option | `SummonControllerOptions` (beside `queue`) | the plural of the existing field |
| `SummonQueueEntry` | type | root, `./summon` | one queue of a group, with overrides |
| `controller.queues` | getter | `SummonController` | beside `controller.queue` |
| `SummonGroupStatus`, `SummonStatus.group` | type, field | root | status of the group |
| `reset({ group, budget })` | option | `SummonController.reset` | extends the hooks PR's option |
| `SummonFailure.group`, `SummonEventPayload.group`, `.queues` | fields | root | where it was decided |
| `__bunjobs` | reserved queue name | `shared/keys.ts` | the package's own pseudo-queue |
| `__win:summon-group:<name>` | reserved state entry | internal | beside `__win:summon` and `__win:summon-claim:` |
| `--bun-jobs-summon-group` (`SUMMON_ARGS.group`) | summon argument | `summon/args.ts` | the existing prefix |
| `SummonedArgs.queues`, `SummonedArgs.group` | fields | `summonedFromArgs()` | the plural; the group |
| `WorkerSummonProvenance.group` | record field | `shared/workers.ts` | "unit of media" on the Workers page |
| `SummonRequest.queues`, `.group`, `.demands`; `SummonReleaseRequest.queues` | provider-facing fields | summon API `0.2` | additive |
| `SummonedExit.queues` | field | `runSummoned` result | per-queue totals |
| `SummonStatus.overlaps` | field | root | groups also summoning for this queue |
| `GET /summon/groups`, `GET /summon/groups/{group}`, `POST /summon/groups/{group}/reset` | routes | management API | operations `listSummonGroups`, `getSummonGroup`, `resetSummonGroup` |
| `SummonGroupStatusDto` | DTO | `./api/contract` | mirrors `SummonGroupStatus` |
| `limits` on the marker and group entry | persisted field | internal | what the limits were at the last claim |

---

## Appendix: evidence

[`evidence/summon-multi-queue/`](evidence/summon-multi-queue/README.md)
holds the three scripts and their raw output. Like the other evidence folders,
they are not part of any package, and the repo's tooling does not typecheck
or lint them.
