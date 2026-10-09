# API reference

Every export of the three entries a provider touches, and every member of
each type:

- [`@kingsleyweb/bun-jobs/provider`](#kingsleywebbun-jobsprovider): writing a
  provider;
- [`@kingsleyweb/bun-jobs/provider/testing`](#kingsleywebbun-jobsprovidertesting):
  the conformance kit;
- [`@kingsleyweb/bun-jobs/summon`](#kingsleywebbun-jobssummon): the summon
  controller, `defineSummoner` and the worker's side.

Your editor's hover text is the JSDoc these entries come from. This page is
for looking a name up, and for the guides to link to. A test holds it to the
code: an export or a member added or removed without this page changing
fails it.

The API is **experimental** while its versions are `0.x`
([`COMPUTE_PROVIDER_API`](#compute_provider_api)). Optional members are
marked so; every time is in milliseconds, and every instant is epoch ms.

## `@kingsleyweb/bun-jobs/provider`

What a provider package imports: everything it needs is re-exported here, so
its declarations need no other entry.

### `defineComputeProvider`

`defineComputeProvider(definition)` makes a provider: a typed factory plus
its brand. It does no I/O. Calling the result with a config validates the
config and builds the facets.

It throws a `ConfigError` on a malformed definition: a `kind` outside
`[a-z0-9-]{1,24}`, an empty `name` or `version`, an `apiVersion` whose major
differs from `COMPUTE_PROVIDER_API`'s (the message says which side to
upgrade), a facet without its version or a version without its facet, an
`execute` facet (this version has none), a `config` that is not a Standard
Schema, or `secrets` that are not an array of dotted paths.

With a `summon` facet it returns a `ComputeProvider<TInput, TConfig, true>`,
whose configured instances are usable as `SummonPolicy.summoner`.

### `ComputeProviderDefinition`

What a provider author writes, `ComputeProviderDefinition<TConfig, TInput>`:
a [`ProviderIdentity`](#provideridentity) plus these. `TConfig` is the
validated config the facets receive; `TInput` is what a user passes.

- `config`: optional. The config schema: any Standard Schema (zod, valibot,
  arktype, or `toStandardSchema` around a function). Answering synchronously,
  an invalid config throws a `ConfigError` from `provider(config)`;
  answering with a promise, the configured provider's `ready` settles later.
  Omitted, the input is passed through unvalidated.
- `secrets`: optional. Dotted paths into the **validated** config whose values
  are secrets, e.g. `["apiToken", "credentials.secretAccessKey"]`. Each must
  name a leaf string: an object path or a number redacts nothing. Their
  values (strings of 8 characters or more) are redacted from what the
  provider logs through its contexts, and a `describe()` fact holding one is
  dropped. A path that is not there is ignored. See
  [the security page](./security.md#declared-secrets).
- `describe`: optional. `(config) => facts`: secret-free facts for the status
  route and the UI (a region, a cluster). Never a token, a key or a URL with
  credentials in it.
- `validate`: optional. `(config, ctx) => Promise<ProviderCheck[]>`: a
  preflight that answers whether this config can reach the platform. It must
  not start compute or spend money. Called by `ConfiguredProvider.validate()`.
- `summon`: optional. `(config, setup) => SummonFacet`: builds the summon
  facet from the validated config, once, when the provider is configured.

### `ProviderIdentity`

Who a provider is, shown in logs, events, the status route and the UI.

- `name`: its unique name, the npm package name, optionally with a
  `:variant`. `defineSummoner` names its provider `"custom:" + kind`. Never
  parsed.
- `version`: its own version, semver. `"0.0.0"` for a `defineSummoner` one.
- `kind`: a short label for badges and events, 1 to 24 characters of
  `[a-z0-9-]`, e.g. `"ecs"`.
- `displayName`: optional. A human name for the UI; `kind` is shown without
  one.
- `homepage`: optional. Where its documentation lives.
- `apiVersion`: the plugin API versions it was written against, a
  [`ProviderApiVersions`](#providerapiversions).

### `ProviderApiVersions`

The plugin API versions a provider was written against, each
`"major.minor"`. Write them as literals: the value of `COMPUTE_PROVIDER_API`
is the host's, and copying it would make the check meaningless.

- `core`: the core version. Required.
- `summon`: optional. The summon facet's version, required exactly when the
  provider has a `summon` facet.

### `COMPUTE_PROVIDER_API`

The plugin API versions this build of bun-jobs speaks: `{ core: "0.1",
summon: "0.2" }`. Summon `0.2` added `SummonRequest.queues`, `.group` and
`.demands` and `SummonReleaseRequest.queues` and `.group`, all additive: a provider
written for `0.1` runs unchanged, negotiated at `0.1`. At definition, a different major is a `ConfigError`. At
registration (when a controller is handed a provider), a newer minor, the
API being `0.x`, and a second version of the same provider name in one
process each log one `warn` per process; none of them for a `defineSummoner`
summoner.

### `ComputeProvider`

A provider as a user receives it, `ComputeProvider<TInput, TConfig,
THasSummon>`: call it with a config to get a
[`ConfiguredProvider`](#configuredprovider). The config argument is optional
when `TInput` admits `undefined`. Calling it validates at once, and throws a
`ConfigError` for an invalid config when the schema answers synchronously.
What a synchronous schema or the facet build throws is rethrown as a
redacted copy (same class and fields, declared secrets and credential
shapes removed).

- `definition`: the definition it was made from, for the conformance kit and
  tooling.
- `[COMPUTE_PROVIDER]`: its brand, `true`.

### `ConfiguredProvider`

A provider with a validated config, `ConfiguredProvider<TConfig>`. With a
`summon` facet it is a [`Summoner`](#summoner): what `SummonPolicy.summoner`
accepts.

- `provider`: its [`ProviderIdentity`](#provideridentity).
- `config`: the validated config. Declared secrets are still in it: never
  serialise it. `undefined` until `ready` resolves when the schema validates
  asynchronously.
- `ready`: a promise that settles once validation has finished. Already
  resolved when the schema answered synchronously. With an asynchronous
  schema, validation **starts when the provider is called**, and `ready`
  rejects when it fails: with a `ConfigError` carrying the issues, or with a
  redacted copy of what the schema threw (see
  [config errors](./security.md#config-errors)). A controller then records a failed attempt and
  validates again at its next one, and `ready` becomes that validation's
  promise.
- `summon`: optional. The summon facet. With an asynchronous schema it is a
  stand-in until `ready` resolves: its calls wait for the config, and
  reading its `capabilities` before then throws a `ConfigError`.
- `describe`: `() => facts`: the definition's facts, less any holding a
  declared secret's value. `{}` until the config is validated.
- `validate`: `(options?) => Promise<ProviderCheck[]>`: runs the definition's
  preflight once the config is ready, or answers `[]` without one.
  `options.signal` aborts it.
- `[CONFIGURED_PROVIDER]`: its brand, `true`: an own enumerable key, so a
  spread of a configured provider keeps it.

### `COMPUTE_PROVIDER`

The brand symbol on a provider, `Symbol.for("@kingsleyweb/bun-jobs/compute-provider")`,
so two copies of bun-jobs in one tree recognise each other's providers.

### `CONFIGURED_PROVIDER`

The brand symbol on a configured provider,
`Symbol.for("@kingsleyweb/bun-jobs/configured-provider")`. A hand-built
object without it is refused as a summoner; a spread of a real one keeps it.

### `ProviderSetupContext`

What a facet factory receives once, when the provider is configured.

- `api`: the versions the host negotiated, per facet: the lower of the
  provider's minor and the host's. A provider written for a newer minor can
  degrade here.
- `hostVersion`: the host's bun-jobs version, for diagnostics only. Branch on
  `api`, never on this.
- `logger`: a logger bound to the provider, redacting its declared secrets.

### `ProviderCallContext`

What every facet call receives.

- `signal`: aborted when the call's timeout (`summonTimeout`) passes. Pass it
  to every platform call.
- `logger`: a logger bound to the queue and the attempt, redacting the
  declared secrets and the usual credential shapes.
- `fetch`: the `fetch` to use for every platform call. The global one, except
  under the conformance kit, which routes and records through it: a provider
  calling the global `fetch` fails the kit.
- `now`: the host's clock.

### `SummonFacet`

What the controller calls.

- `capabilities`: a [`SummonCapabilities`](#summoncapabilities), read once,
  when the controller is built.
- `summon`: `(request, ctx) => Promise<SummonResult>`: starts compute for one
  attempt. Answers a result when the platform answered normally, and throws a
  [`ProviderError`](#providererror) when it did not. Anything else thrown is
  treated as `transient`.
- `release`: optional. `(request, ctx) => Promise<void>`: sets a scale-style
  platform's count, usually to `0`. Required for style `"scale"`.
- `status`: optional. `(handles, ctx) => Promise<UnitStatus[]>`: what the
  platform says about units it started. Asked once when an attempt is
  declared lost; the `detail` of the first unit that has one becomes the
  attempt's detail.
- `cancel`: optional. `(handles, ctx) => Promise<void>`: stops units, best
  effort. Called for a lost attempt whose unit is still pending.

### `SummonCapabilities`

What a summon facet declares about its platform. The controller reads these
instead of knowing platforms by name; a malformed set is a `ConfigError` when
the provider is configured.

- `style`: `"launch"` starts new units (a race can double up, so the marker
  is claimed first); `"scale"` sets a count, idempotently, and needs
  `release`; `"wake"` starts one of a fixed pool, like launch with
  `maxWorkers` clamped to `poolSize`.
- `dedupe`: how the platform dedupes a retried call, a
  [`SummonDedupe`](#summondedupe).
- `passes`: how per-attempt values reach the process: `"argv"`, or `"none"`
  when the unit's command line is fixed. With `"none"` an attempt is released
  by a live worker that started at most 5 s before it, not by id.
- `bootBudgetMs`: how long an attempt counts as a worker on its way, by
  default. `SummonPolicy.bootBudget` overrides it.
- `shutdown`: `{ signal, graceMs, graceMaxMs? }`: the stop signal
  (`"SIGTERM"`, `"SIGINT"`, or `"none"` for in-invocation), the grace after
  it (passed to the worker as `--bun-jobs-summon-grace-ms`), and the most the
  platform allows the grace to be raised to. A grace below `runSummoned`'s
  7,000 ms `shutdownBuffer` logs one `warn` per controller.
- `maxLifetimeMs`: the platform's cap on one unit's life, or `null` for none
  known. A policy `maxLifetime` above it is a `ConfigError`.
- `enforcesLifetime`: whether the facet maps `request.maxLifetimeMs` onto the
  platform's cap.
- `maxCountPerCall`: optional. The most units one call may start; `count` is
  clamped to it.
- `poolSize`: optional. For `"wake"`: how many units the pool has.
  `maxWorkers` above it is clamped, with a `warn`.

### `SummonDedupe`

How a platform dedupes a retried call, by `kind`:

- `kind`: `"token"` (a request token the platform remembers), `"name"` (a
  name it will not create twice) or `"none"` (the marker's compare-and-set is
  the whole guard).
- `maxLength`: `"token"` and `"name"`: the longest key it accepts.
  `request.dedupeKey` is clipped to fit.
- `charset`: `"token"` and `"name"`: the characters it accepts, as a
  character-class body, e.g. `"A-Za-z0-9-"`.
- `scope`: `"token"`: what the token is unique within, e.g. `"cluster"`.
- `ttlMs`: `"token"`, optional: how long the platform remembers it.
- `strict`: `"token"`: whether a same-token request with different
  parameters is an error. When `true`, send nothing that is not a function of
  the request's `id`: never `demand` or `reason`.

### `SummonRequest`

Everything a summoner is told about one attempt. Everything in it but
`demand`, `demands` and `reason` is a pure function of `id`, so a retried
call is identical.

- `namespace`: the queue's namespace.
- `queue`: the queue that needs a worker; for a unit serving several queues,
  the first of `queues`.
- `queues`: optional in the type, always set by the controller (summon
  `0.2`). Every queue the unit is for, in the policy's order: `[queue]` for
  one queue. Read it as `request.queues ?? [request.queue]`. A provider needs
  none of it: the queues reach the unit in `argv`.
- `group`: optional (summon `0.2`). The summon group the unit is started
  for, set only when it serves more than one queue.
- `id`: the attempt's id. Never repeated, even after the queue's state is
  purged. Reaches the worker in `argv` and comes back on its record, which is
  how the attempt is released.
- `dedupeKey`: `id` clipped to the declared `dedupe.maxLength` and
  `dedupe.charset` (64 characters of `[A-Za-z0-9-]` when none is declared).
  Send it wherever the platform offers idempotency.
- `count`: how many workers a launch-style summoner should start, at least
  `1`.
- `target`: for a scale-style summoner, the count the platform should run
  after this call.
- `demand`: the [`QueueDemand`](#queuedemand) reading that prompted the
  attempt. It varies between readings: never send it to a strict platform.
  For a unit serving several queues, the most-starved queue's.
- `demands`: optional (summon `0.2`). For a unit serving several queues,
  every queue's reading, keyed by queue. Varies like `demand`.
- `reason`: why the check ran, a [`SummonReason`](#summonreason). Like
  `demand`, not a function of `id`.
- `env`: the policy's static environment. Never identity: an environment
  leaks to every descendant.
- `argv`: the attempt's identity as `--bun-jobs-summon-*=` arguments: pass
  them to the process **whole and in order**. The only channel for identity.
  A unit serving several queues gets one `--bun-jobs-summon-queue=` per
  queue, so never dedupe arguments or key them by flag; the conformance kit's
  `summon.argv.round-trip` checks it. At most 8 KiB, counting one separator
  per argument: a controller whose arguments would be longer is refused at
  construction.
- `maxLifetimeMs`: how long the worker may live: the policy's `maxLifetime`.

### `SummonResult`

What `summon()` answers when the platform answered normally, by `status`:

- `status`: `"started"` (the platform is starting compute), `"deduped"` (its
  token says this attempt already ran), `"already-running"` (the unit was
  up: counts as served), or `"unavailable"` (it declined without an error: no
  capacity, a quota, an inactive function).
- `handles`: the platform's identifiers for what it started: required for
  `"started"`, optional for `"deduped"` and `"already-running"`. Stored,
  emitted and served **unredacted**: never a credential (a pre-signed URL, a
  token-bearing id).
- `reason`: `"unavailable"` only: a short, secret-free reason, served to API
  clients.
- `retryAfterMs`: `"unavailable"` only, optional: try no sooner than this.
  Ignored unless a finite number of 0 or more, and clamped to the larger of
  `backoff.max` and `circuit.resetAfter`.

### `SummonReleaseRequest`

What a scale-style summoner's `release` is asked to do. **`queues` plus
`group` identify the unit:** a release names the queues, in order, and the
group of the `SummonRequest` that summoned the unit.

- `namespace`: the queue's namespace.
- `queue`: the queue; for a unit serving several queues, the first of
  `queues`.
- `queues`: optional in the type, always set by the controller (summon
  `0.2`). Every queue the unit serves: `[queue]` for one queue. Read it as
  `request.queues ?? [request.queue]`.
- `group`: optional (summon `0.2`). The unit's summon group, set only when
  it serves more than one queue.
- `target`: the count to set; `0` scales to zero.

### `SummonReason`

Why a check ran:

- `add`: a job was added through a queue the controller is attached to.
- `event`: another process published an event on the queue.
- `poll`: the poll timer.
- `schedule`: a scheduled check: nothing in bun-jobs uses it, for a caller's
  own `check({ reason: "schedule" })` from a cron or a scheduled function.
- `manual`: `check()`'s default, and "summon now" on the management API.
- `timer`: a delayed job added here came due.

### `QueueDemand`

A queue's demand at one instant, as the controller read it.

- `at`: the instant it describes.
- `paused`: whether claiming is paused; a paused queue demands nothing.
- `waiting`: jobs waiting.
- `dueNow`: delayed jobs, and retries, whose time has come.
- `stalled`: active jobs whose worker died holding them.
- `active`: active jobs, lapsed or not.
- `workers`: live workers on the queue, parked and paused ones included.
- `nextDueAt`: the earliest time a job comes due, or `null`.
- `demand`: `waiting + dueNow + stalled`, or `0` when paused: work a worker
  could claim now.
- `outstanding`: `demand` plus the active jobs that are not stalled, or `0`
  when paused.
- `capped`: whether a count reached the cap, so the figures are lower
  bounds.
- `exact`: `false` when the driver has no `countDemand` and the figures are
  approximate: right as a trigger, not as a count.

### `UnitStatus`

One unit, as the platform reports it to `status()`.

- `handle`: the handle `summon` returned for it.
- `state`: `"pending"`, `"running"`, `"exited"`, `"failed"`, or `"unknown"`
  when the platform no longer knows the handle.
- `exitCode`: optional. Its exit code, when the platform says.
- `detail`: optional. A short, secret-free platform reason
  (`"CannotPullContainerError"`, `"OOMKilled"`): the lost attempt's detail.
  Redacted and cut to 128 characters, and served to API clients.

### `ProviderCheck`

One finding of a `validate()` preflight.

- `id`: a stable id, e.g. `"credentials"`, `"cluster-exists"`.
- `status`: `"pass"`, `"warn"` (it works, but something is off) or `"fail"`.
- `detail`: optional. A short explanation. `validate()` returns it to the
  code that called it unredacted; only `POST /providers/:id/validate` redacts
  and caps it before serving it. Write it secret-free either way.

### `ProviderError`

`new ProviderError(message, kind, options?)`: what a provider throws when
the platform did not answer normally. A `JobsError` whose `code` is
`PROVIDER_<KIND>` (`PROVIDER_THROTTLED`, …). `options` takes
`platformCode`, `status`, `retryAfterMs` and `cause`. A `kind` that is not a
[`ProviderErrorKind`](#providererrorkind) is a `ConfigError`. Recognised by
shape too, so one from another copy of the package counts.

- `kind`: how the controller treats the failure.
- `platformCode`: optional. The platform's own error code
  (`"ThrottlingException"`): the attempt's detail when it is code-shaped,
  `[A-Za-z0-9_.:-]{1,64}`. **Served to API clients: never a credential.** See
  [the attempt's detail](./security.md#the-attempts-detail).
- `status`: optional. The platform's HTTP status. Dropped unless a finite
  number.
- `retryAfterMs`: optional. Try no sooner than this. Honoured for
  `throttled` and `quota`; dropped unless a finite number of 0 or more, and
  rounded up to a whole ms.

### `ProviderErrorKind`

How a platform failure is treated:

- `transient`: a network error, a 5xx. Outcome `failed`, counted toward the
  circuit, the usual backoff. Anything thrown that is not a `ProviderError`
  is treated this way, and a provider made with `defineComputeProvider` then
  logs one `warn` per process.
- `throttled`: a 429 or a rate limit. Outcome `unavailable`, **not** counted
  toward the circuit, backoff at least `retryAfterMs`.
- `quota`: an account or regional limit. Outcome `unavailable`, counted,
  backoff at least `retryAfterMs`.
- `auth`: credentials missing, expired or rejected. Outcome `failed`, and the
  circuit opens **at once**, with an `error` naming the provider.
- `misconfigured`: the config names something that is not there or is
  invalid. As `auth`.
- `conflict`: the platform refused a request as inconsistent with an earlier
  one under the same token: the request was not a pure function of its key, a
  bug in the provider. Outcome `failed`, counted, with an `error`.

### `JobsError`

The base class of everything bun-jobs throws, re-exported so a provider can
recognise one.

- `code`: a stable identifier for the failure, e.g. `"CONFIG"`,
  `"PROVIDER_AUTH"`.
- `context`: optional. Extra detail about the failure, safe to log.

### `ConfigError`

A `JobsError` with code `"CONFIG"`: an option is missing, malformed or
contradictory. Thrown for a malformed definition, an invalid config and a
malformed facet.

### `toStandardSchema`

bun-common's helper, re-exported: wraps a plain validate function, sync or
async, as a Standard Schema, so a provider needs no validation library. The
starter template's config uses it.

### `StandardSchemaV1`

The [Standard Schema](https://standardschema.dev) type, re-exported from
bun-common: what `ComputeProviderDefinition.config` accepts.

### `Logger`

bun-common's structured logger, re-exported: what the contexts' `logger` is.
Six levels, each `(message, fields?)`, plus `child()` and
`isLevelEnabled()`.

### `LoggerLike`

bun-common's type, re-exported: anything accepted where a logger is asked for
(a `Logger`, a sink function, pino, winston and others).

### `LogLevel`

bun-common's type, re-exported: one log level.

### `localCompute`

The first-party provider for **this host**: each unit is a child process,
`bun <entry> [...args] --bun-jobs-summon-*=…`, started with `Bun.spawn`.
Written on this entry alone, like any third-party provider. Name
`@kingsleyweb/bun-jobs:local`, kind `local`. The user guide's
[Summoning on this host](./user-guide.md#summoning-on-this-host-localcompute)
shows it in use.

`localCompute(options)` takes [`LocalComputeOptions`](#localcomputeoptions)
and validates them at once, with no I/O: a malformed option is a
`ConfigError` naming it. What it declares:

| Capability | Value |
|---|---|
| `style` | `"launch"` |
| `dedupe` | `{ kind: "token", maxLength: 64, charset: "A-Za-z0-9-", scope: "instance", ttlMs: 3_600_000, strict: false }`: remembered per configured instance, so two `localCompute(…)` calls never share a token |
| `passes` | `"argv"` |
| `bootBudgetMs` | `bootBudget`, default `30_000` |
| `shutdown` | `{ signal, graceMs }` from `shutdown`, default `SIGTERM` and `10_000` |
| `maxLifetimeMs` | `maxLifetime`, default `null` |
| `enforcesLifetime` | `true`: at the request's `maxLifetimeMs` the unit's process group gets the stop signal, and `SIGKILL` after the grace |
| `maxCountPerCall` | `maxUnits` |

- **`summon`** starts `min(count, free units)`, and answers `unavailable`
  (reason `max-units: N of N running`) when none is free: the host answered
  normally, so it is not a `ProviderError`, and the controller counts it as
  it would a `quota` error. Once a host signal has arrived, for the rest of
  the process (even when an app listener keeps the host alive), it starts
  nothing and answers `unavailable` (reason `host-shutdown: the host is
  stopping`). A missing or unreadable entry, a missing `cwd`, and a `bun` or
  `cgroup` that cannot be used are `misconfigured`, with the errno as
  `platformCode` (`ENOENT`, `EACCES`); a spawn short of a resource
  (`EAGAIN`, `EMFILE`, `ENOMEM`), a unit cgroup that already exists
  (`EEXIST`: a leftover, never removed, since this process did not make it)
  or a failure with no errno is `transient`. A call
  whose signal has aborted rejects and starts nothing, and a `count` under 1
  is a `ConfigError` (the controller never asks for one).
- **Every unit is spawned detached**, as the leader of a process group of
  its own, and with `cgroup` set, in a cgroup of its own inside it: a stop
  signal or a `SIGKILL` goes to the whole group (only while the unit is
  alive, since a reaped unit's group id may be reused), and a `SIGKILL` also
  to its cgroup (`cgroup.kill`, Linux 5.14+). What a unit starts in its own
  group is stopped with it: when a stopped unit exits inside its grace, its
  group is sent `SIGKILL` at once, so a child that ignores the stop signal
  does not outlive it. With a cgroup, so is what it starts in a new
  session, and what it leaves behind when it exits; without one, a process
  that left the group, or one a unit leaves behind when it exits on its own,
  is beyond reach: **use `cgroup` for jobs that run tools of their own**.
  A handle is `local-<pid>-<nonce>-<n>`, the nonce random per host process,
  so neither a handle nor a unit cgroup is ever a previous host's. Detached, a unit no
  longer receives the terminal's Ctrl-C or `SIGHUP` with the host: the
  host's signal guard forwards a stop instead.
- **`status`** answers `running` while the process lives; `exited` with code
  `0`, or with `143`/`137` and detail `cancelled` or `host-shutdown` when
  this host stopped it; otherwise `failed` with the code and, as detail,
  `max-lifetime` when its lifetime timer fired, else its last stderr line
  (200 characters at most), else the signal (`SIGKILL`) or `exit <code>`.
  `unknown` for a handle this instance did not start, or one of more than
  256 exited units ago.
- **`cancel`** sends the unit's group the stop signal, then `SIGKILL` (and
  its cgroup's `cgroup.kill`) after the grace, and resolves once every unit
  has exited; an abort ends the wait, not the escalation. After a unit has
  exited it sends nothing.
- **The signal guard**: while a unit runs, the host's `exit` kills every
  unit's group, and a host `SIGINT`, `SIGTERM` or `SIGHUP` sends each unit
  its stop signal and `SIGKILL` after its grace. When no other listener has
  the signal, the guard owns its default action: the host waits for its
  units (at most the longest grace: **Ctrl-C becomes a wait of up to
  `graceMs`**), then raises the signal again and ends as it would have.
  Otherwise the host's own listener decides when it ends. The listeners are
  installed only while a unit runs; an uncaught throw or an unhandled
  rejection ends the host through `exit`, so its units go too.
- **A host killed outright leaves its units running.** A `SIGKILL`ed or
  OOM-killed host runs no guard: its units go on consuming the queue until
  `runSummoned`'s idle exit or their deadline, a restarted host's `maxUnits`
  does not count them, and, detached, they also miss the terminal's `SIGHUP`
  when it closes. A check of the parent's death is a planned follow-up.
- **`describe()`** facts: `host`, `pid` (the host's), `maxUnits`, `entry`,
  `runtime`, `env` (the mode, never a value), `output` (its kind), and
  `cgroup` when set.
- **`validate()`** checks `cwd`, `entry` (a readable file), `bun` (runs
  `bun --version` the way a unit starts, in a cgroup of its own inside the
  configured one, when one is set), `cgroup` (fails when no unit's cgroup
  can be made or joined there),
  `output` (with `{ file }`: the file, or its directory, can be written; it
  creates nothing), `capacity` (a `warn` when every unit is busy), and
  `isolation` (always a `warn`: a unit is not a sandbox). It starts no unit.
  At run time, an output file that cannot be opened or written logs one
  `warn` per configured instance, and the unit runs on.

### `LocalComputeOptions`

What `localCompute` takes.

- `entry`: the worker script each unit runs, which builds its worker with
  `summonedFromArgs()` and runs it with `runSummoned`. An absolute path, a
  `file:` URL (`new URL("./worker.ts", import.meta.url)`) or its string form
  (`import.meta.resolve("./worker.ts")`), or a path relative to `cwd`.
- `cwd`: optional. The units' working directory. Defaults to the host's
  `process.cwd()` when configured.
- `args`: optional. Arguments for the script after `entry` and before the
  summon arguments, which come last so nothing here overrides them.
- `bun`: optional. The `bun` executable. Defaults to `process.execPath`.
- `env`: optional. The same name and shape as the child-process target's:
  an object (the default, `{}`) gives these literal values over the
  allowlist [`CHILD_BASE_ENV`](#child_base_env) and `passEnv`, copied from
  the live `process.env` (`Bun.spawn` with no `env` would pass the one the
  host started with); a value of `undefined` removes a variable the
  allowlist would copy. `"inherit"` gives the host's whole live
  environment. The summon policy's `env` is added on top; `BUN_JOBS_CHILD`
  is always removed. Under the allowlist a unit runs with `--no-env-file`,
  since Bun would otherwise load a `.env` from its `cwd`.
- `passEnv`: optional. Names of host variables to copy, at each spawn,
  beyond the allowlist; one the host lacks is skipped. A `ConfigError` beside
  `env: "inherit"`.
- `maxUnits`: optional. The most units this configured instance runs at
  once: its capacity, shared by every queue it summons for. Defaults to
  `os.availableParallelism()`.
- `bootBudget`: optional. The declared boot budget, in ms. Defaults to
  `30_000`.
- `maxLifetime`: optional. A cap on any unit's life, in ms, declared as the
  platform's: a policy `maxLifetime` above it is a `ConfigError`. Defaults
  to `null`, no cap of its own.
- `shutdown`: optional. `{ signal, graceMs }`: the stop signal, `"SIGTERM"`
  (default) or `"SIGINT"`, and the grace before `SIGKILL`, default `10_000`.
- `output`: optional. Where a unit's stdout and stderr go: `"inherit"`
  (default, the host's, line by line), `"ignore"`, `{ file }` (appended,
  relative to `cwd`), or `{ logger }` (each line, stdout at `info`, stderr at
  `warn`, bound with `unit`). Stderr is read in every case, for `status()`.
- `cgroup`: optional. An existing cgroup directory the units start under
  (Linux only: elsewhere a `ConfigError`, since Bun would ignore it, and so
  is a path that is not a cgroup v2 directory, one with no
  `cgroup.controllers`, checked when configured): each
  gets a cgroup of its own inside it, removed when it
  exits, so the limits on this one (`memory.max`, `pids.max`, `cpu.max`)
  bind all the units together, and every process a unit starts stays where
  stopping it kills it. Without root it must sit in a subtree delegated to the
  user (systemd's `user@<uid>.service`); a root-owned one fails with
  `EACCES`.

### `LocalComputeConfig`

The validated config the facets receive, every default filled in.

- `entry`: the worker script, absolute.
- `cwd`: the working directory, absolute.
- `args`: the script's extra arguments.
- `bun`: the `bun` executable.
- `env`: `"inherit"`, or the literal values (`undefined` removes one).
- `passEnv`: the host variables copied beyond the allowlist.
- `maxUnits`: the most units at once.
- `bootBudgetMs`: the boot budget.
- `maxLifetimeMs`: the cap on a unit's life, or `null`.
- `signal`: the stop signal.
- `graceMs`: the grace before `SIGKILL`.
- `output`: a [`LocalComputeOutput`](#localcomputeoutput).
- `cgroup`: optional. The cgroup directory, absolute.

### `LocalComputeOutput`

Where a unit's output goes, validated.

- `kind`: `"inherit"`, `"ignore"`, `"file"` or `"logger"`.
- `path`: `"file"` only. The file, absolute.
- `logger`: `"logger"` only. The resolved `Logger`.

### `removeCgroupTree`

`removeCgroupTree(path)`: removes a cgroup v2 directory and every cgroup
below it, **deepest first**, since a cgroup with a child cannot be removed
and a process inside one can make cgroups of its own there. For a provider
that gives each unit a cgroup of its own, as `localCompute` and the
`child-process` target do.

It **never kills, only removes**: a cgroup still holding a process is busy
(`EBUSY`) and stays, with everything above it. So write `"1"` to its
`cgroup.kill` first (Linux 5.14+; it reaches every cgroup below too), and
call this again while the killed processes are reaped. It answers `true`
once `path` is gone (removed now, or never there) and `false` when
something kept it (a busy cgroup, a permission, an unreadable directory),
for the caller to retry within a budget of its own.

Since it deletes directories, it **refuses what is not a cgroup**: a `path`
that is not absolute (`""`, `"."` included), or a directory with no
`cgroup.procs` file, throws a `ConfigError` before anything is removed.
That is its only throw.

### `CHILD_BASE_ENV`

The host variables a child process gets by default, re-exported from the
package root: the allowlist both `localCompute`'s units and the
`child-process` worker target start from. `PATH`, `HOME`, `TMPDIR`, `TMP`,
`TEMP`, `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TERM`, `NO_COLOR`,
`FORCE_COLOR`, `NODE_ENV`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
`SSL_CERT_DIR`, and Windows' `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `PATHEXT`,
`USERPROFILE`, `APPDATA` and `LOCALAPPDATA`. The proxy variables are left out
(their URLs can hold a password): ask for them with `passEnv`. See
[Hardening a child process](../../README.md#hardening-a-child-process).

## `@kingsleyweb/bun-jobs/provider/testing`

The conformance kit: tests a provider's summon facet with no credentials,
against a fake of its platform. It imports no test runner. Passing means the
provider behaves correctly against its own fake: not that the platform
behaves as the fake does.

### `runProviderConformance`

`runProviderConformance(provider, options)`: runs every check against the
fake and answers a [`ConformanceReport`](#conformancereport). It never
throws for a failing provider; pass the report to `assertConformance`.

`provider` is a `ComputeProvider` (configured here with `options.config`,
and again with a canary wherever a declared secret path holds a string in
that config), or a `Summoner` (from `defineSummoner`, or a provider already
configured, whose config checks are then skipped). The secrets check looks
for the canaries and for every declared secret's validated value of 8
characters or more, as the controller redacts it, so a secret the schema
derives that leaks fails it too; a leak is labelled by its declared path. A
shorter one, or one that is not a string, is not looked for by value (it is
not redacted either), and the check's detail appends "; N declared
secret(s) under 8 characters are not redacted, so not checked by value" or
"; N declared secret(s) are not strings, so not checked by value". A string at a declared path is replaced
by a canary whatever its length, and the canary is looked for.

The report lists the groups in a fixed order: identity, config,
capabilities, routing, purity, dedupe, concurrency, errors, timeouts, scale,
status, lifetime, describe, validate, secrets, the argument round trip, the
handoff to a real worker process, and two controllers in two processes
racing for one backlog. They do not run in that order.

**The argument round trip** (`summon.argv.round-trip`) sends a request for a
unit serving three queues, repeating `--bun-jobs-summon-queue=`, and needs
every argument of `request.argv` to reach the unit's process in order (the
platform may add arguments of its own around them, but not drop or reorder
one), and `summonedFromArgs()` there to read the three queues and the group.
It is a `must` for a provider declaring summon `0.2` or later, and a
`should` (a warning, `ok` stays true) for one declaring `0.1`, so a provider
that conformed before still does. On a scale platform the kit then releases
the unit it summoned, naming its queues and group, back to the count before;
a release that throws fails the check. It is skipped under `passes: "none"`,
and when a scale or wake platform answers `already-running` and starts no
unit; a launch platform answering that fails it, since a launch starts a
unit per attempt.

**Some `must` checks skip, and a skip leaves `ok` true.** A report can be
`ok` with these not run, so read its skips:

- with no `invalidConfigs` given, `summon.config.rejects-invalid`;
- when the provider declares no secrets, `summon.secrets.no-leak`;
- when the provider has no `validate()`, all three validate checks:
  `summon.validate.healthy`, `summon.validate.auth-fails` and
  `summon.validate.starts-nothing`;
- and, when the fake declares no `limits`, the `should` check
  `summon.capabilities.platform-limits`.

The timeouts group briefly replaces the global timer functions with counting
wrappers (about 2 s, always restored).

#### Self-hosted providers

With `platform: "none"`, the kit knows units only by the handles `summon`
answers and by what `status()` says of them:

- **skipped**, each with the detail `no platform: …`, since each reads a
  fake: `summon.capabilities.platform-limits`,
  `summon.purity.identical-requests`, `summon.dedupe.token-is-key`, every
  `summon.errors.*` check, `summon.validate.auth-fails` and
  `summon.validate.starts-nothing`;
- **routing** is skipped when the provider never calls `ctx.fetch`, and
  **fails** when it does: a provider with a platform API needs its fake;
- **dedupe and concurrency** count distinct handles;
- **timeouts**: a call whose signal has already aborted must reject within
  a second and start nothing, and a call that answers must leave no timer;
- **status**: `cancel` is proven by `status()` no longer reporting the unit
  `pending` or `running` (skipped without `status()`);
- **lifetime**, when the provider declares `enforcesLifetime`: a unit of the
  fixture worker that ignores its deadline and its stop signal, summoned
  with `maxLifetimeMs` 1500, must be ended within that plus the declared
  grace and 5 s, as `status()` reports (skipped when that wait would pass
  60 s);
- **the handoff** needs the provider configured to start
  [`CONFORMANCE_WORKER`](#conformance_worker), and `status()`, through which
  it follows the unit to a clean exit. The worker's test settings reach it
  as `request.env` (the policy's `env`), so the provider must pass
  `request.env` to its units, as it must `request.argv`;
- every unit a call started is cancelled when the run ends.

### `ConformanceOptions`

What `runProviderConformance` takes beside the provider.

- `config`: optional. A config pointing at the fake. Ignored for a
  `Summoner`.
- `invalidConfigs`: optional. Configs the schema must reject, each
  `{ config, path }` with the dotted path its issue should name. Without
  them, the `must` check `summon.config.rejects-invalid` is skipped.
- `platform`: the fake, from `fakePlatform()`; give each run a fresh one,
  since the kit reads every request it received. Or `"none"` for a
  **self-hosted** provider, one with no platform API that starts its units
  itself (`localCompute`): see [Self-hosted providers](#self-hosted-providers).
  Required either way, so a forgotten fake does not compile.
- `skip`: optional. Checks to skip, each `{ id, reason }`; the reason is
  printed in the report.
- `driver`: optional. The backend for the handoff and the race: one several
  processes share. Defaults to a SQLite file in a temporary directory,
  removed after; the memory driver is refused.

### `assertConformance`

`assertConformance(report)`: throws a `JobsError` (`CONFORMANCE_FAILED`)
naming the failed checks, with the rendered report as its message, when
`report.ok` is false. A `should` warning, a skip and a pass never throw.

### `ConformanceReport`

A kit run, printable as a checklist.

- `subject`: the provider, as `name@version`.
- `apiVersion`: the API versions it declared, and the host's.
- `checks`: every [`ConformanceCheck`](#conformancecheck), in a fixed order.
- `ok`: `true` when no `must` check failed.
- `toMarkdown`: `() => string`: the report as a Markdown checklist, headed
  "tested against a fake".

### `ConformanceCheck`

One check's outcome.

- `id`: a stable id, e.g. `"summon.dedupe.same-key-one-unit"`; its second
  segment is the group.
- `level`: `"must"` checks fail the report; `"should"` checks warn.
- `status`: `"pass"`, `"fail"`, `"warn"` (a failed `should`) or `"skip"`
  (inapplicable to the declared capabilities, skipped by the caller, or
  depending on a check that failed).
- `detail`: optional. What was expected and what was seen.

### `fakePlatform`

`fakePlatform(routes, options?)`: serves a fake of a platform's control API
with `Bun.serve` on port 0, and does the bookkeeping: units, a token memory,
fault injection and the request log the kit reads. So a fake for a new
platform is its routes and its error bodies. A route key is
`"METHOD /path"` or `"/path"` (any method), in `Bun.serve`'s route syntax:
`:name` segments arrive on `request.params`. Close it after the test.

### `FakePlatformOptions`

What `fakePlatform` takes beside its routes.

- `limits`: optional. The platform's real limits: `maxDurationMs`,
  `maxRequestBytes`, `tokenMaxLength`. The `should` check
  `summon.capabilities.platform-limits` compares `dedupe.maxLength` with
  `tokenMaxLength` and `maxLifetimeMs` with `maxDurationMs`, and warns on a
  mismatch; `maxRequestBytes` is not checked. Without `limits`, that check is
  skipped.
- `faults`: optional. How the platform answers each fault, by
  [`FakeFault`](#fakefault) (all but `"slow"`): a function of the request and
  `{ retryAfterMs }` answering the platform's own status, body and headers. A
  fault without one gets a generic rendering: `transient` 503, `throttled`
  429 and `quota` 403 (both with `Retry-After`), `auth` 401,
  `misconfigured` 404 and `conflict` 409, each with a body
  `{ "error": { "code", "message" } }`, and `capacity-200` a 200 with no
  units and a failure.

### `FakeRoute`

`(request, state) => Response | Promise<Response>`: one route of a fake, with
its [`FakePlatformState`](#fakeplatformstate).

### `FakePlatform`

A running fake.

- `url`: where it listens. The kit routes `ctx.fetch` here.
- `inject`: `(fault, options?) => void`: makes the next call(s) fail the way
  the platform fails for this fault. `options.times` defaults to `1`;
  `options.retryAfterMs` (default `1_000`) is the wait a `throttled` or
  `quota` answer asks for. `"slow"` holds the response until the caller
  aborts.
- `units`: `() => Promise<FakeUnit[]>`: the units started so far.
- `onStart`: sets what starts a unit's process (the kit's handoff check sets
  it); `undefined` clears it. Units started with none stay `"pending"`.
- `limits`: optional. The limits it was given.
- `close`: `() => Promise<void>`: stops the server, releases held responses
  and stops every unit.

### `FakePlatformState`

What a route receives beside the request: the fake's bookkeeping.

- `url`: where the fake listens.
- `start`: `(start: FakeUnitStart & { token? }) => FakeUnit`: starts one
  unit, as the platform would. With a `token`, remembers it for `recall`.
- `recall`: `(token) => FakeUnit[] | undefined`: the units an earlier request
  with this token started, or `undefined` for a new token. The kit's dedupe
  checks read the tokens passed here and to `start`.
- `unit`: `(handle) => FakeUnit | undefined`: one unit.
- `units`: every unit started so far, in order.
- `stop`: `(handle) => boolean`: stops a unit (it becomes `"exited"`);
  `false` for an unknown handle.
- `count`: how many units are pending or running: a scale platform's count.
- `scale`: `(target) => FakeUnit[]`: starts or stops units until `target` are
  live, and answers the live ones.

### `FakeUnit`

One unit the fake started.

- `handle`: its handle: `unit-1`, `unit-2`, …
- `env`: the environment it was given.
- `argv`: the arguments it was given.
- `state`: `"pending"`, `"running"` (the kit's worker is up for it) or
  `"exited"`.

### `FakeUnitStart`

What a unit is started with.

- `argv`: optional. Its arguments, as the platform received them.
- `env`: optional. Its environment.

### `FakeFault`

The faults a fake reproduces, for `inject` and `FakePlatformOptions.faults`:

- `transient`: a 5xx.
- `throttled`: a rate limit, with a wait.
- `quota`: an account limit, with a wait.
- `auth`: credentials rejected.
- `misconfigured`: something the config names is not there.
- `conflict`: a token reused with other parameters.
- `capacity-200`: "no capacity", answered with a 200.
- `slow`: no answer until the caller aborts.

### `CONFORMANCE_WORKER`

The kit's fixture worker, an absolute path: what a self-hosted provider must
be configured to start, e.g.
`runProviderConformance(localCompute, { config: { entry: CONFORMANCE_WORKER }, platform: "none" })`.
It reads its summon arguments from `argv` and its test settings from the
environment the kit passes as the policy's `env`; with none (the kit's
direct calls), it runs on the memory driver and exits once idle.

## `@kingsleyweb/bun-jobs/summon`

The summon controller and the worker's side of a summon. Everything here is
also exported from the package root. The provider types it re-exports are
documented under `./provider` above.

### `defineSummoner`

`defineSummoner(options)`: a summoner from a plain function, for a platform
with no provider plugin. It builds an anonymous provider (`name` `"custom:"
+ kind`, version `"0.0.0"`) whose summon facet wraps `invoke`. A bare
function in `SummonPolicy.summoner` is shorthand for `defineSummoner({ invoke
})`. It never logs the plugin warnings (experimental API, unmapped throw).

### `DefineSummonerOptions`

What `defineSummoner` takes.

- `kind`: optional. The kind for logs and the UI, `[a-z0-9-]{1,24}`.
  Defaults to `"custom"`.
- `style`: optional. `"launch"` (default), `"scale"` or `"wake"`.
- `bootBudget`: optional. The in-flight TTL. Defaults to `180_000`.
- `passes`: optional. `"argv"` (default) or `"none"`.
- `dedupe`: optional. A [`SummonDedupe`](#summondedupe). Defaults to
  `{ kind: "none" }`.
- `shutdown`: optional. The stop signal and grace. Defaults to
  `{ signal: "SIGTERM", graceMs: 10_000 }`.
- `invoke`: a [`SummonerFunction`](#summonerfunction): starts compute.
  Returning nothing counts as `{ status: "started", handles: [] }`.
- `release`: optional. Required for `"scale"`: sets the count.
- `describe`: optional. `() => facts` for the UI. `{ kind }` is always
  included.

### `Summoner`

What `SummonPolicy.summoner` accepts: a
[`ConfiguredProvider`](#configuredprovider) with a summon facet, made by
`defineSummoner` or by calling a provider with its config. It carries the
brand, so a hand-built object literal is refused; a spread of a real one (to
wrap its facet) is accepted.

- `summon`: the [`SummonFacet`](#summonfacet) the controller calls.

### `SummonerFunction`

`(request, ctx) => Promise<SummonResult | void>`: a summoner written as a
function.

### `SummonPolicy`

How a queue is summoned for: the value of `BunJobsOptions.summon[queue]`, and
the base of `SummonControllerOptions`. The package README's
[summon policy](../../README.md#summon-policy) table has the defaults.

- `summoner`: a `Summoner`, or a bare `SummonerFunction`.
- `triggers`: optional. `{ onAdd?, events?, poll?, debounce? }`: what makes
  the controller check.
- `bootBudget`: optional. How long an attempt counts as a worker on its way.
  Defaults to the summoner's `bootBudgetMs`.
- `maxWorkers`: optional. The most summoned workers at once. Defaults to `1`.
- `jobsPerWorker`: optional. Outstanding jobs per worker before another is
  wanted. Defaults to `Infinity`.
- `maxPending`: optional. The most unregistered attempts at once. Defaults to
  `maxWorkers`.
- `cooldown`: optional. The least time between two attempts. Defaults to
  `10_000`.
- `backoff`: optional. `{ initial?, max? }`: the wait after a failure,
  doubling. Defaults to `30_000` and `900_000`.
- `circuit`: optional. `{ failures?, resetAfter? }`: when to stop after
  repeated failures, and for how long. Defaults to `5` and `900_000`.
- `budget`: optional. `{ perHour?, perDay? }`: attempts per queue. Defaults
  to `30` and `300`. `false` turns it off: no limit and no
  `budget-exhausted`, though attempts are still counted. The counts live in
  the queue's shared state, so a smaller limit meets the counts a larger one
  left; `controller.reset({ budget: true })` clears them. An attempt whose
  provider was never called (its `ready` failed) is not counted, unless a
  reset cleared its count first. An attempt whose answer could not be
  recorded (other controllers won every write) is announced only when it is
  settled, once, as `lost`: one failure then, and its count kept. Off by
  default in a `group` with a budget: set it to apply a per-queue ceiling on
  top of the group's.
- `maxLifetime`: optional. The longest a summoned worker may live. Defaults
  to `3_600_000`.
- `servedBy`: optional. `"any-worker"` (default) or `"summoned-only"`.
- `scaleDown`: optional. `{ after? }`: for `"scale"`, how long the queue must
  be idle before the count goes to `0`. Defaults to `300_000`.
- `summonTimeout`: optional. How long one call may take (its `signal` aborts
  then), how long an attempt waits for an asynchronous config's `ready`, and
  how long `close()` waits for events still publishing. Defaults to
  `30_000`.
- `env`: optional. Static environment for every request. Never identity.
- `fromSummoned`: optional. Whether the controller may run in a summoned
  process or a runner child. Defaults to `false`: there it is inert.
- `onSummonFailed`: optional. `(failure: `[`SummonFailure`](#summonfailure)`) => void | Promise<void>`,
  called — never awaited — when an attempt `failed`, was `lost` or found the
  platform `unavailable`, when the budget is exhausted, and once when the
  circuit opens (`circuit-open`, with `until`). Only the controller that
  decided the outcome calls it. A throw or rejection is logged at `warn`.
- `group`: optional. A [`SummonGroupOptions`](#summongroupoptions): share one
  budget with every controller naming the same group, in any process.

### `SummonGroupOptions`

`SummonPolicy.group`: a summon group's name and what its controllers share.
Each attempt is charged to the group before its queue's claim, and given
back when that claim is lost or the provider was never called, so racing
controllers never summon past the group's limit. Backoff, cooldown, the
circuit, `maxPending` and `maxWorkers` stay per queue. The package README's
[one budget for several queues](../../README.md#one-budget-for-several-queues-group)
has the rules.

- `name`: the group's name, a queue-name segment: the key its shared state
  is stored under in the namespace (`__win:summon-group:<name>`, under the
  reserved pseudo-queue `__bunjobs`). Renaming a group starts it afresh.
- `budget`: optional. `{ perHour?, perDay? }`: attempts per UTC hour and day
  across the group. Defaults to `30` and `300`. `false` keeps no group limit
  (attempts are still counted). With a group budget, a queue's own `budget`
  defaults to off.
- `circuit`: optional. `true` or `{ failures?, resetAfter? }` (defaulting to
  the policy's `circuit`): a circuit shared by the group, per provider
  `kind`, fed by every failure and registration of its queues; while open,
  no queue of the group using that kind is summoned for. Defaults to
  `false`. Each queue's own circuit still applies.

### `SummonGroup`

A `SummonPolicy` written once for several queues: an entry of the array form
of `BunJobsOptions.summon`. Shorthand, not a shared controller: it expands
into one `SummonController` per queue, each with its own marker, budget,
backoff and circuit (a group's `budget` applies to each queue; its `group`
is passed to each, which is how its queues share one budget). The package
README's [one policy for several queues](../../README.md#one-policy-for-several-queues)
has an example.

- `queues`: the queues it summons for: at least one, each named once across
  the whole option, or a `ConfigError` naming the queue.
- `overrides`: optional. Per-queue `Partial<SummonPolicy>` changes, keyed by
  a queue in `queues`, merged one level deep over the group's policy: a
  field where both hold a plain object (`triggers`, `backoff`, `circuit`,
  `budget`, `scaleDown`, `env`) is merged field by field; anything else,
  `summoner` always, replaces the group's value.

### `SummonOption`

What `BunJobsOptions.summon` takes: `SummonPolicy` values keyed by queue
name, or an array of `SummonGroup`s and such records, mixed. Every form
expands to one `SummonController` per queue.

### `SummonController`

`new SummonController(options)`: watches one queue and summons compute when
it has work and no worker. Every guard (attempts in flight, failures,
backoff, circuit, budget) lives in one queue-state entry written by
compare-and-set, so any number of controllers summon once per backlog. Emits
`summon` for every attempt that changes state, and publishes it through the
driver. Built by `jobs.summonController(queue)`, from
`BunJobsOptions.summon`, or directly.

- `queue`: the queue it watches.
- `namespace`: the queue's namespace.
- `inert`: whether it is inert (built in a summoned process or runner child
  without `fromSummoned`, or it found a newer bun-jobs's marker). An inert
  controller summons nothing.
- `check`: `(options?) => Promise<SummonCheckResult>`: runs one check now.
  `options.reason` names it (default `"manual"`); `options.force` skips the
  cooldown, never the circuit, the budget or the compare-and-set.
- `status`: `() => Promise<SummonStatus>`: the shared state plus this
  controller's policy. Writes nothing.
- `reset`: `(options?: { budget?, group? }) => Promise<void>`: clears
  failures, the loss streak, the backoff and an open circuit. Attempts in
  flight are kept. `budget: true` also clears the budget's counts;
  `group: true` closes the summon group's shared circuit for its kind, and
  with `budget: true` clears the group's counts too.
- `close`: `() => Promise<void>`: stops the triggers and waits for a check in
  flight, lost attempts being explained, and events still publishing, each
  bounded by `summonTimeout`. Idempotent.

### `SummonControllerOptions`

A [`SummonPolicy`](#summonpolicy) plus where the queue lives.

- `driver`: the driver the queue lives on: multi-process, with queue state
  and worker records, or a `ConfigError`.
- `namespace`: the queue's namespace.
- `queue`: the queue to watch.
- `logger`: optional. Any `LoggerLike`. Defaults to the package's logger,
  named `"summon"`.

### `SummonControllerEvents`

The events a controller emits locally.

- `summon`: `(event: SummonEventPayload) => void`: an attempt changed state.

### `SummonEventPayload`

The payload of a `summon` event, locally and across processes.

- `id`: the attempt's id; `""` for `budget-exhausted` and `released`.
- `outcome`: a [`SummonOutcomeKind`](#summonoutcomekind).
- `kind`: the summoner's kind.
- `count`: optional. How many workers it asked for.
- `handles`: optional. The platform's identifiers, when it returned some,
  never redacted. They travel through the backend; the management API
  withholds them unless `serialize.exposeSummonHandles` is on.
- `reason`: optional. Why the check that started it ran.
- `detail`: optional. The attempt's detail. See
  [the security page](./security.md#the-attempts-detail).
- `group`: optional. The summon group it was decided in: on every event of
  an attempt a grouped controller made, and on a `budget-exhausted` of the
  group's budget.

### `SummonCheckResult`

What one check did, by `action`:

- `action`: `"none"` (nothing needs a worker), `"skipped"` (a guard held the
  attempt back), `"summoned"` (an attempt was claimed and the summoner
  called) or `"released"` (a scale summoner was set to zero).
- `demand`: the reading it decided on; absent when the controller was closed
  or inert and read nothing.
- `reason`: `"skipped"` only: a [`SummonSkipReason`](#summonskipreason).
- `id`: `"summoned"` only: the attempt's id.
- `outcome`: `"summoned"` only: what the summoner answered, or `failed`.

### `SummonFailure`

What `SummonPolicy.onSummonFailed` is told: one failure, secret-free.

- `outcome`: a [`SummonFailureOutcome`](#summonfailureoutcome).
- `kind`: the summoner's kind.
- `namespace`: the queue's namespace.
- `queue`: the queue.
- `id`: optional. The attempt; for `circuit-open`, the one whose failure
  opened it. Absent for `budget-exhausted`.
- `reason`: optional. Why the check that made the call ran, for `failed` and
  `unavailable`.
- `detail`: optional. The detail the `summon` event and `status().last`
  carry; for `circuit-open`, the opening failure's.
- `at`: when the controller decided it, epoch ms.
- `until`: optional. For `circuit-open`: when the circuit closes, epoch ms.
- `group`: optional. For a `budget-exhausted` of a summon group's budget, or
  a `circuit-open` of its shared circuit: the group's name (and `budget` is
  the group's).
- `budget`: optional. For `budget-exhausted`: `{ hour, perHour, day, perDay }`.

### `SummonFailureOutcome`

What `onSummonFailed` is told about: `failed`, `lost`, `unavailable` and
`budget-exhausted` (as on the `summon` event), plus `circuit-open`, once per
opening, which no event carries.

### `SummonSkipReason`

Why a check did not summon:

- `served`: enough live workers serve the queue.
- `pending`: attempts on their way cover it, or `maxPending` is reached.
- `cooldown`: too soon after the last attempt.
- `backoff`: waiting out the backoff after a failure.
- `circuit-open`: too many failures, or an `auth` or `misconfigured` error.
- `budget`: a cost ceiling was reached.
- `contended`: another controller changed the shared state first.
- `closed`: the controller is closed.
- `inert`: the controller is inert.

### `SummonOutcomeKind`

What an attempt ended as, on the shared state and in events:

- `started`: the platform accepted it.
- `deduped`: the platform's token says it already ran.
- `already-running`: the unit was up; counts as served.
- `registered`: the summoned worker's record appeared.
- `unavailable`: the platform declined, or throttled, or is over quota.
- `failed`: the call threw or timed out. A timeout (detail `timeout`) stays
  pending until it registers or is lost, since the unit may have started.
- `lost`: accepted, but no worker registered within the boot budget, or it
  died.
- `budget-exhausted`: a ceiling stopped it.
- `released`: a scale summoner was set back to zero.

### `SummonStatus`

What `status()` answers, and the status route serves.

- `queue`: the queue.
- `local`: whether a controller runs in this process: always `true` from
  `status()`; `false` for a status the management API read from storage
  alone (no `summoner`, the limits the last claim persisted).
- `inert`: whether that controller is inert.
- `inertReason`: optional. `"summoned-process"` or `"newer-marker"`.
- `summoner`: optional; always present from `status()`. `{ provider,
  providerId?, readiness, capabilities?, facts }`: `providerId` is the
  configured instance's id in this process, `name@version~<n>`, which the
  management API's [provider routes](../../README.md#compute-provider-routes)
  take; `readiness` is `"ready"`, `"pending"` while the provider's config is
  still validating, or `"failed"` when that validation rejected or the
  controller refused the facet (its capabilities raised a `ConfigError`);
  `capabilities` only when ready; `facts` `{}` until the config is known.
- `pending`: the [`PendingSummon`](#pendingsummon)s in flight.
- `failures`: consecutive failed attempts, as backoff and the circuit read
  them.
- `backoffUntil`: optional. When the backoff ends.
- `circuitOpenUntil`: optional. When the circuit closes.
- `budget`: `{ hour, perHour?, day, perDay?, off?, hourResetsAt,
  dayResetsAt }`: attempts used this UTC hour and day, the limits (absent,
  with `off: true`, when the policy says `budget: false`), and when each
  window resets, epoch ms. `off` is also `true` when the queue sets no
  `budget` in a group with a budget.
- `last`: optional. The [`SummonLastOutcome`](#summonlastoutcome).
- `group`: optional. A [`SummonGroupStatus`](#summongroupstatus), when the
  controller is in a summon group.

### `SummonGroupStatus`

A summon group's shared state, as `status().group` reads it.

- `name`: the group's name.
- `budget`: `{ hour, perHour?, day, perDay?, off?, hourResetsAt,
  dayResetsAt }`: attempts counted against the group this UTC hour and day
  across its queues, this controller's limits for the group (absent, with
  `off: true`, for `group.budget: false`), and when each window resets.
- `queues`: `{ [queue]: { day, lastAt } }`: each queue's share of today's
  attempts.
- `circuit`: optional, with `group.circuit` on. `{ failures, openUntil?,
  openedBy? }`: the shared circuit for this controller's summoner kind, and
  `{ queue, id, detail? }` of the failure that last opened it.
- `circuits`: optional. Every provider kind's shared circuit the group's
  state holds, by `kind`, each as `circuit` shows one; absent while none has
  counted a failure.

### `SummonMarker`

The shared summon state of one queue, in the reserved queue-state entry
`__win:summon`, written only by compare-and-set.

- `v`: the shape version, `1`.
- `epoch`: a random string fixed when the entry is created, hashed into every
  attempt id so ids never repeat.
- `pending`: attempts not yet matched to a worker, oldest first.
- `watching`: optional. Attempts whose worker registered, watched until it
  says how it left.
- `lastAttemptAt`: optional. When the last attempt started; the cooldown
  counts from here.
- `failures`: consecutive failed attempts, reset by any registration.
- `lossStreak`: optional. Counted failures since the last proven success.
- `backoffUntil`: optional. No attempt before this.
- `circuitOpenUntil`: optional. While in the future, nothing is summoned.
- `budget`: attempts in the current hour and day, and `counted`: the ids of
  attempts whose count can still be given back (provider not yet called),
  emptied by a budget reset.
- `last`: optional. The most recent outcome.
- `kind`: optional. The summoner kind of the controller that made the last
  claim, so a reader with no controller can name it.
- `limits`: optional. That controller's budget limits, `{ perHour, perDay }`,
  or `false` when its budget was off; absent until a claim persists them
  (unknown).
- `group`: optional. That controller's summon group, when it was in one.

### `PendingSummon`

One attempt in flight.

- `id`: the attempt's id.
- `at`: when it was claimed.
- `until`: when it stops counting as a worker on its way: `at + bootBudget`.
- `count`: how many workers it asked for.
- `kind`: the summoner's kind.
- `handles`: optional. The platform's identifiers, once known.

### `WatchedSummon`

An attempt whose worker registered and has not yet said how it left: off the
capacity count, and watched so a crash after its first report still counts.

- `id`: the attempt's id.
- `at`: when it was released; the oldest are evicted first.
- `until`: the attempt's own `until`.
- `count`: how many workers it asked for.
- `kind`: the summoner's kind.
- `extendedUntil`: optional. When the watch was extended to, once, while a
  worker was still listed with no exit mark.

### `SummonLastOutcome`

The most recent outcome on the shared state.

- `id`: the attempt it concerns.
- `outcome`: what happened.
- `at`: when.
- `detail`: optional. The attempt's detail, served to API clients.

### `SUMMON_ARGS`

The argument names a summon passes and `summonedFromArgs` reads, each
written `--bun-jobs-summon-<key>=<value>`: `id`, `kind`, `mode`,
`namespace`, `group`, `queue`, `maxLifetimeMs`, `graceMs`. `queue` is
repeated once per queue for a unit serving several, in the policy's order,
and `group` is written only then: a one-queue summon's arguments are what
they always were. Given more than once, `queue` collects every value (the
first is `queue`) and every other flag takes its last value: see
[`SummonedArgs`](#summonedargs). Arguments, never environment variables: an
environment leaks to every descendant process.

### `summonedFromArgs`

`summonedFromArgs()`: this process's summon provenance from its command line,
or `undefined` when it was not summoned (no `--bun-jobs-summon-id=`) or is a
runner child. Pass it to a worker as `{ summon }`. Call it in the main
thread: Bun gives a `Worker` thread an empty `argv`, so it answers
`undefined` there.

### `SummonedArgs`

What `summonedFromArgs` answers: the worker's provenance (`id`, and `kind`,
`mode`, `deadlineAt`, `group` when given) plus:

- `namespace`: optional. The namespace to consume.
- `queue`: optional. The queue to consume: the first of `queues`.
- `queues`: optional. Every `--bun-jobs-summon-queue=` in order, repeats
  dropped: one worker per queue. `[queue]` for one queue.
- `maxLifetimeMs`: optional. The longest the worker may live.
- `graceMs`: optional. The platform's grace after its stop signal.

**A flag given more than once.** `--bun-jobs-summon-queue=` collects every
value in order, repeats dropped, so `queue` is the **first**. Every other
flag, `--bun-jobs-summon-group=` included, takes its **last** value. A
summon repeats only the queue; the rule matters for a command line edited by
hand. `group` must be a key segment, as a queue name is (letters, digits,
`_`, `.`, `-`, at most 200 characters): any other value is a `ConfigError`
at startup, as an unknown mode is.

### `runSummoned`

`runSummoned(worker, options?)`: runs a summoned worker until it is no
longer needed, handles the platform's stop signals, and closes it within the
platform's grace. `runSummoned(workers, options?)` runs a unit summoned for
several queues, one worker per queue: one idle clock over every queue, one
close budget, and a `ConfigError` before anything runs for a queue the
summon arguments name with no worker. Call it, and `summonedFromArgs()`, in
the main thread. See
[Summoned workers: `runSummoned`](../../README.md#summoned-workers-runsummoned).

### `RunSummonedOptions`

How a summoned worker drains and stops.

- `mode`: optional. `"exit-on-idle"`, `"until-stopped"` or `"in-invocation"`.
  Defaults to the summoner's requested mode, else `"exit-on-idle"`.
- `idleFor`: optional. How long the queue must be idle before the worker
  stops. Defaults to `30_000`.
- `idleCheckInterval`: optional. How often idleness and the deadline are
  checked. Defaults to `5_000`.
- `deadline`: optional. The latest the worker may run to, or a function
  answering it. Defaults to the summoned maximum lifetime from now.
- `shutdownBuffer`: optional. Stop claiming this long before the deadline.
  Defaults to `7_000`.
- `grace`: optional. The platform's wait between its stop signal and
  `SIGKILL`. Defaults to the summoned grace, else `10_000`.
- `tailReserve`: optional. Budget kept for the close's work after the target
  closed. Defaults to `1_000`.
- `signals`: optional. Signals that start a graceful stop. Defaults to
  `["SIGTERM", "SIGINT"]`; `false` installs none.
- `pauseSignals`: optional. Treat `SIGTSTP`/`SIGCONT` as pause and resume.
  Defaults to `false`.
- `exit`: optional. Exit the process once closed. Defaults to `true`, except
  in `"in-invocation"` mode.
- `logger`: optional. Where it logs. Defaults to the worker's logger.

### `SummonedExit`

Why and how a summoned worker stopped.

- `reason`: `"idle"`, `"parked"`, `"signal"`, `"deadline"`, `"error"` or
  `"closed"`.
- `signal`: optional. The signal, for `"signal"`.
- `ranForMs`: how long it ran.
- `completed`: jobs it completed.
- `failed`: attempts it failed.
- `code`: the exit code it used, or would have in `"in-invocation"` mode.
- `queues`: optional. Each queue's `{ completed, failed }`, keyed by queue,
  when it ran a set of workers. Absent for `runSummoned(worker)`.

### `ProviderIdentity`

Re-exported from `./provider`: see [above](#provideridentity).

### `ProviderApiVersions`

Re-exported from `./provider`: see [above](#providerapiversions).

### `ProviderCallContext`

Re-exported from `./provider`: see [above](#providercallcontext).

### `SummonFacet`

Re-exported from `./provider`: see [above](#summonfacet).

### `SummonCapabilities`

Re-exported from `./provider`: see [above](#summoncapabilities).

### `SummonDedupe`

Re-exported from `./provider`: see [above](#summondedupe).

### `SummonRequest`

Re-exported from `./provider`: see [above](#summonrequest).

### `SummonResult`

Re-exported from `./provider`: see [above](#summonresult).

### `SummonReleaseRequest`

Re-exported from `./provider`: see [above](#summonreleaserequest).

### `SummonReason`

Re-exported from `./provider`: see [above](#summonreason).

### `UnitStatus`

Re-exported from `./provider`: see [above](#unitstatus).
