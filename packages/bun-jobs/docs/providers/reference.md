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
summon: "0.1" }`. At definition, a different major is a `ConfigError`. At
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
`demand` and `reason` is a pure function of `id`, so a retried call is
identical.

- `namespace`: the queue's namespace.
- `queue`: the queue that needs a worker.
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
- `reason`: why the check ran, a [`SummonReason`](#summonreason). Like
  `demand`, not a function of `id`.
- `env`: the policy's static environment. Never identity: an environment
  leaks to every descendant.
- `argv`: the attempt's identity as `--bun-jobs-summon-*=` arguments: pass
  them to the process. The only channel for identity.
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

What a scale-style summoner's `release` is asked to do.

- `namespace`: the queue's namespace.
- `queue`: the queue.
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
- `detail`: optional. A short explanation. bun-jobs does not redact it:
  write it secret-free.

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
shorter one is not looked for by value (it is not redacted either), and the
check's detail appends "; N declared secret(s) under 8 characters are not
redacted, so not checked by value". A string at a declared path is replaced
by a canary whatever its length, and the canary is looked for.

The report lists the groups in a fixed order: identity, config,
capabilities, routing, purity, dedupe, concurrency, errors, timeouts, scale,
status, lifetime, describe, validate, secrets, the handoff to a real worker
process, and two controllers in two processes racing for one backlog. They
do not run in that order.

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

### `ConformanceOptions`

What `runProviderConformance` takes beside the provider.

- `config`: optional. A config pointing at the fake. Ignored for a
  `Summoner`.
- `invalidConfigs`: optional. Configs the schema must reject, each
  `{ config, path }` with the dotted path its issue should name. Without
  them, the `must` check `summon.config.rejects-invalid` is skipped.
- `platform`: the fake, from `fakePlatform()`. Give each run a fresh one: the
  kit reads every request it received.
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
  to `30` and `300`.
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
- `reset`: `() => Promise<void>`: clears failures, the loss streak, the
  backoff and an open circuit. Attempts in flight are kept.
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
- `local`: whether a controller runs in this process (always `true` from
  `status()`).
- `inert`: whether that controller is inert.
- `inertReason`: optional. `"summoned-process"` or `"newer-marker"`.
- `summoner`: optional. `{ provider, capabilities, facts }`: absent while a
  provider's config is still validating, and after its facet failed to be
  adopted (its capabilities raised a `ConfigError`).
- `pending`: the [`PendingSummon`](#pendingsummon)s in flight.
- `failures`: consecutive failed attempts, as backoff and the circuit read
  them.
- `backoffUntil`: optional. When the backoff ends.
- `circuitOpenUntil`: optional. When the circuit closes.
- `budget`: attempts used this hour and today, with the limits.
- `last`: optional. The [`SummonLastOutcome`](#summonlastoutcome).

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
- `budget`: attempts in the current hour and day.
- `last`: optional. The most recent outcome.

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
`namespace`, `queue`, `maxLifetimeMs`, `graceMs`. Arguments, never
environment variables: an environment leaks to every descendant process.

### `summonedFromArgs`

`summonedFromArgs()`: this process's summon provenance from its command line,
or `undefined` when it was not summoned (no `--bun-jobs-summon-id=`) or is a
runner child. Pass it to a worker as `{ summon }`.

### `SummonedArgs`

What `summonedFromArgs` answers: the worker's provenance (`id`, and `kind`,
`mode`, `deadlineAt` when given) plus:

- `namespace`: optional. The namespace to consume.
- `queue`: optional. The queue to consume.
- `maxLifetimeMs`: optional. The longest the worker may live.
- `graceMs`: optional. The platform's grace after its stop signal.

### `runSummoned`

`runSummoned(worker, options?)`: runs a summoned worker until it is no
longer needed, handles the platform's stop signals, and closes it within the
platform's grace. See
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
