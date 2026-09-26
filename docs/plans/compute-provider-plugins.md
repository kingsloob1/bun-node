# Compute-provider plugins: how a third party adds a platform

Implementation plan for a **plugin system for compute providers** in
`@kingsleyweb/bun-jobs`. A compute provider is anything that can start or run
bun-jobs work somewhere else: an ECS task, a Fly Machine, a Cloud Run job, a
Lambda behind a function URL, a Cloudflare Worker. A third party publishes a
plugin, a user installs it and passes it in, and bun-jobs uses it exactly as it
uses its own providers.

It covers two features with one model:

- **summoning** (Phase 1.5, [`summon-compute.md`](summon-compute.md)): start
  compute that runs an ordinary `BunQueueWorker` until the queue drains;
- **remote execution** (Phases 2–4, [`worker-runtimes.md`](worker-runtimes.md)
  §4–§7): push one attempt to a remote executor through `RemoteWorker` and
  `RemoteRunner`, the names Phase 0 frees.

Written 2026-09-25 against `develop` at `ca3ed21`. **No code was changed.**
The two plans above were written against `d54d1fe`. Every line number below
was read at `ca3ed21`.

Both plans now carry a short section that summarises their facet and links
here (`summon-compute.md` §14, `worker-runtimes.md` §4.6). This document is
the one place the design lives. Where the two plans and this one disagree, this
one is newer.

**Updated 2026-09-25 by the Phase 1.5 design check**, at `origin/develop`
`0a8e580` (Phases 0 and 1 merged). Only what Phase 1 or that reconciliation
changes about the summon facet is edited here: §2.5 (Phase 1 built the
target-level executor type), §7.1 (attempt ids and the marker's `epoch`),
§12.2 (the handoff check's sequencing), §14.1 (what `WorkerDto.target` is
now), §16 (effort) and Q-P10 (settled). **For 1.5a and 1.5b,
`summon-compute.md` §4.0, §6.4 and §13 are now newer than this document**:
they were reconciled against the code, and they slice the work into PRs.

### Contents

1. [Executive summary](#1-executive-summary)
2. [What the repo already does for pluggability](#2-what-the-repo-already-does-for-pluggability)
3. [Prior art](#3-prior-art)
4. [One plugin system or two](#4-one-plugin-system-or-two)
5. [The rule: first-party providers get no privileged internals](#5-the-rule-first-party-providers-get-no-privileged-internals)
6. [The core](#6-the-core)
7. [The `summon` facet](#7-the-summon-facet)
8. [The `execute` facet](#8-the-execute-facet)
9. [Registration and discovery](#9-registration-and-discovery)
10. [Versioning and compatibility](#10-versioning-and-compatibility)
11. [Packaging](#11-packaging)
12. [Conformance kits](#12-conformance-kits)
13. [Security model](#13-security-model)
14. [Observability and UI](#14-observability-and-ui)
15. [Documentation deliverables](#15-documentation-deliverables)
16. [Phases and effort](#16-phases-and-effort)
17. [Risks and open questions](#17-risks-and-open-questions)

### How to read the markings

The tags are `summon-compute.md`'s, with one addition.

| Tag | Meaning in this plan |
|---|---|
| **[S]** | I read it from this repository's source today (2026-09-25), from `origin/develop` at `ca3ed21`. The file and line are given. |
| **[W]** | I read it today from a primary source with WebFetch. The URL is given. Every such read went through the summarising fetch model, so treat it like `V~`: the model quoted text, and I did not see the page myself. |
| **[W-search]** | It came from a search-result summary, not from the page. Weaker than [W]. Nothing load-bearing rests on one. |
| **[V, file §n]** and the other evidence tags | Carried unchanged from `summon-compute.md` or its evidence files. |
| **[I]** | Inference. It is not a finding. |
| **[U]** | Unverified. Nothing may rest on it without a check. |
| **[D]** | A design proposal of this plan. |

Almost all of this document is [D]. Three claims in these plans' history were
withdrawn because an inference was presented as a finding
(`worker-runtimes.md` §3.8.2, §3.8.3). One claim in `worker-runtimes.md` §4.2
is corrected here by a source read (§2.5).

---

## 1. Executive summary

### The one-paragraph version

A plugin is a **compute provider**: a plain object made with
`defineComputeProvider()` and exported from an npm package. It has a **core**
(its name and version, the plugin API versions it was written against, a config
schema as a [Standard Schema](https://standardschema.dev), which config fields
are secret, a `describe()` for the UI and an optional `validate()` preflight).
It also has one or two **facets**. The **`summon` facet** starts compute: it
declares its capabilities (launch, scale or wake; how it dedupes and with what
key limits; its boot budget; its shutdown signal and grace; whether it can pass
the summon id) and implements `summon()`, with optional `release()`,
`status()` and `cancel()`. The **`execute` facet** carries remote attempts
over a transport: it declares the transport's capabilities (its shape and
direction, whether it streams, is ordered, reliable or confidential, its size
and duration limits) and has one of two shapes. An **exchange** facet
implements `send()`, which moves an **already-signed** request to the platform
and returns its response (unary or streamed) for bun-jobs to verify; a
**session** facet implements `open()` or `listen()`, which yield a duplex
session of already-authenticated frames over a WebSocket, a TCP or UDP socket
or a message broker (§8, [`remote-transports.md`](remote-transports.md)). The
code that runs *on* the remote platform is not part of the plugin object. It
is a **runtime adapter**, built with `defineRuntimeAdapter()` from the
browser-safe `./remote` entry, or a transport server from `./remote/serve`,
and its contract is the wire protocol. Every provider
reports failures as a `ProviderError` of one of six kinds, because the
controller's backoff and circuit breaker act on the kind. Plugins are passed in
by import. Nothing is discovered. bun-jobs' own six summoners and its runtime
adapters are written against exactly this API and may import nothing else, and
a test fails the build if one does. A published conformance kit runs a plugin
against a local fake of its platform with no cloud credentials. First-party
providers pass the same kit. Each facet has its own `apiVersion`, starts at
`0.x` (experimental), and becomes `1.0` only after several independent
providers pass the kit.

### The decisions it rests on

| # | Decision | Why |
|---|---|---|
| 1 | **One host-side plugin model with facets, plus a separate runtime-adapter kit for the remote side.** | A real provider (AWS, Google, Fly) offers both summoning and remote execution, from one account, with one credential. Two host-side systems would mean two configs, two credential paths and two version schemes per provider. The remote side is different in kind: it runs on the platform, often not in Bun, must be browser-safe, and its contract is already the wire protocol (`worker-runtimes.md` §5). §4 |
| 2 | **First-party providers use only the public API.** A test scans their imports and fails on anything but the public entries. | It is the only way to know the API is sufficient. The precedent is `api-contract.test.ts:99-127`, which already holds an import graph to a promise with `Bun.Transpiler().scanImports` and a negative control [S]. §5 |
| 3 | **Capabilities are declared, and the controller reads them.** Nothing is hard-coded per platform. | The three evidence files show the platforms differ on every axis the controller cares about: style, dedupe, boot time, shutdown signal and grace ([V, paas-ssh §3], [V, aws §3], [V, google-azure §3.1, §4.1]). A controller that knows platforms by name cannot serve a platform it has never heard of. §7.1 |
| 4 | **Config is a Standard Schema.** bun-jobs depends on no schema library. | bun-common already vendors the Standard Schema type (`types/standardSchema.ts`) and `toStandardSchema` wraps a bare function (`BunValidate.ts:345-365`) [S]. zod, valibot, arktype and yup work unchanged (`CLAUDE.md`). §6.3 |
| 5 | **Six error kinds, mapped by the plugin.** An unmapped throw is treated as `transient` and logged once as a plugin bug. | The controller's gates (`summon-compute.md` §4.4) and the gateway's breaker (`worker-runtimes.md` §5.5) behave differently for "try again", "slow down", "your quota is gone" and "your config is wrong". Only the plugin can tell them apart. §6.5 |
| 6 | **The execute facet never sees the signing secret.** bun-jobs signs the request (exchange) or each frame (session), seals frames where the transport is not confidential, and verifies everything that comes back. The plugin only moves bytes. | A plugin that could sign could mark jobs complete. With response and frame signing in the core, a buggy or careless transport cannot forge an outcome; it can only fail to deliver one. §8.2 |
| 7 | **Explicit import and pass-in. No name lookup, no discovery from `node_modules`.** | It is what the logger and driver options already do (§2). Discovery is a supply-chain surface for no gain. §9 |
| 8 | **One `apiVersion` per facet, `"major.minor"`, checked at registration.** Minors are additive. | The execute facet evolves on Phase 2's timeline and must not break summon plugins that shipped in Phase 1.5. Terraform states the same rule for its protocol: "Minor versions of the protocol are additive" [W: developer.hashicorp.com/terraform/plugin/terraform-plugin-protocol, 2026-09-25]. §10 |
| 9 | **Both facets start `experimental` (`0.x`).** `summon` becomes `1.0` after the six first-party summoners and one provider written outside the bun-jobs session pass the kit. `execute` becomes `1.0` after the Cloudflare, Lambda and generic HTTP adapters and one outside provider do, and one session-shape transport written outside the bun-jobs session (added 2026-09-25). | An API proven by its authors alone is proven against their assumptions. §10.4 |
| 10 | **The conformance kit ships in the package**, at `./provider/testing` and `./remote/testing`, framework-agnostic, credential-free. | The driver contract suite is the in-repo precedent, and it is *not* shipped: it lives in `__tests__/helpers/driverContract.ts` [S], and `files` is `["dts", "lib"]` (`package.json:78-81`) [S]. A third-party driver author today has no way to run it. §12 |
| 11 | **The documentation is a deliverable with a drift test.** An author guide with a worked example per facet, an API reference checked against the exports, a user guide, a security page, a starter template, and examples. | Hatchet shipped a serverless transport, left it undocumented, and is rebuilding it (`worker-runtimes.md` §11). §15 |
| 12 | **Build the plugin API before the first-party summoners** (new sub-phase 1.5p). Build the execute facet with Phase 2 and the runtime-adapter kit with Phase 3. | Then six real providers exercise the API before anybody promises it is stable. §16 |

### What it is not

- **Not a sandbox.** A plugin runs in the application's process with the
  application's privileges. bun-jobs can keep secrets out of its own logs and
  events, and keep the signing key out of the plugin's API. It cannot stop a
  malicious plugin from reading `process.env`. §13
- **Not a marketplace or a registry.** There is a naming convention and a
  `keywords` convention so that npm search finds plugins. Nothing is hosted.
- **Not a driver plugin system.** A third party can already pass a
  `JobsDriver` instance (§2.1). Making drivers versioned plugins is a separate
  question, recorded as Q-P9.
- **Not a replacement for the escape hatches.** `defineSummoner({ invoke })`
  and `WorkerTargetFactory` stay. `defineSummoner` becomes a thin wrapper that
  builds an anonymous provider (§7.4). `WorkerTargetFactory` stays the
  low-level hook (§8.5).

---

## 2. What the repo already does for pluggability

Four precedents, read at `ca3ed21`. Each teaches something, and one of them is
followed closely.

### 2.1 Drivers: structural, feature-detected, unversioned

- **The contract is an interface.** `JobsDriver` is `DriverLifecycle &
  RunnerDriver & QueueDriver` (`drivers/driver.ts:2720-2721`) [S].
- **Capabilities are declared where presence cannot tell.**
  `DriverCapabilities` (`driver.ts:54-84`) holds `blockingWait`, `events`,
  `multiProcess`, `multiHost` and `jobAttribution` [S]. Its JSDoc explains why
  `jobAttribution` is a declaration and not a method check: a driver "written
  before" the fields would silently ignore them and "return every job"
  (`driver.ts:67-83`) [S].
- **Optional members are detected by presence.** `syncSchema?` (`:114`),
  `countAddedJobs?` (`:2323`), `getQueueState?` (`:2609`), `setQueueState?`
  (`:2624`) [S]. Callers test with `typeof driver.x === "function"`, e.g.
  `queue/retry.ts:31`, `runner/clearHistory.ts:129` [S], or through
  `supports*` helpers such as `supportsWorkers` (`drivers/readApis.ts:564-571`)
  [S].
- **Old shapes are still accepted.** `promoteDelayed` may still answer a bare
  count "for a driver written against the older contract"
  (`driver.ts:2548-2551`) [S].
- **There is no version number.** Evolution is by additive optional members
  and widened return types. The cost is visible: the phrase "a driver written
  before …" recurs through `driver.ts` (`:81`, `:524`, `:1369`, `:2217`,
  `:2234`, `:2243`) [S], and each marks a place where the host carries a
  fallback forever.
- **Third parties can pass an instance, not a config.** `createDriver` is a
  closed `switch` whose `default` throws `ConfigError`
  (`drivers/create-driver.ts:22-73`) [S]. `resolveDriver` accepts any object
  and treats one with a string `type` as a config (`:96`) [S]. A config
  "has to survive `JSON.stringify`, because it is what a spawned child
  receives" (`driver.ts:2727-2730`) [S], so a third-party driver cannot be
  handed to a spawned child at all [I].
- **The contract suite is not published.** `driverContract(name, factory)`
  (`__tests__/helpers/driverContract.ts:111-128`) is "the contract every driver
  must satisfy, as an executable specification", and "a new driver is 'done'
  when this suite passes against it" [S]. It is under `__tests__/`, which is
  not in `files` (`package.json:78-81`) [S].

**What to take:** declared capabilities for what presence cannot express;
optional hooks detected by presence; a contract suite as the definition of
done. **What to change:** add a version number, so the host can refuse an
incompatible plugin instead of carrying fallbacks; and publish the suite.

### 2.2 Logger adapters: structural, import nothing, one implementation underneath

`logging.ts` accepts any `LoggerLike` (`:952-962`) [S]. Every adapter "wrap[s]
the library in a `LogSink` and reuse[s] this module's `Logger`
implementation, so `child()`, level filtering and `Error` handling behave
identically no matter what is underneath" (`:17-20`) [S]. Nothing imports a
logging library (`:11-16`) [S].

**What to take:** the plugin supplies the smallest primitive (a `send()`, a
`summon()`), and bun-jobs wraps it in the one implementation of everything
around it: the marker, the backoff, the breaker, signing, redaction. That is
the pattern this plan follows most closely.

**What to avoid:** detection by shape. `resolveLogger` detects eight libraries
in a fixed order (`:1004-1119`) [S], and its comments record the collisions:
pino would be accepted as a `Logger` "with the arguments reversed"
(`:964-971`), and a winston logger with custom levels looks like pino
(`:1062`) [S]. A plugin must say what it is. §6.1 gives it an explicit brand.

### 2.3 Standard Schema: validation with no library

bun-common vendors the Standard Schema v1 type "as types only", to keep the
dependency surface at zero (`bun-common/lib/types/standardSchema.ts`, header)
[S], and exports it (`bun-common/lib/index.ts:340`) [S]. `toStandardSchema`
turns a plain validate function into a real Standard Schema
(`BunValidate.ts:345-365`) [S]. bun-jobs' own schema builder `s` produces
values that implement Standard Schema *and* carry a JSON Schema
(`api/schema/builder.ts:31-46`) [S]. It is reachable from `./lib/api`
(`api/index.ts:173`) but not from the package root [S].

**What to take:** plugin config is a Standard Schema. A plugin author uses
zod, valibot, arktype, `s`, or `toStandardSchema` around a hand check.
bun-jobs validates it with no dependency.

**One addition worth having:** the UI would like to render a config form.
Standard Schema has a sibling spec, **Standard JSON Schema v1**: a
`~standard.jsonSchema` converter with `input(options)` and `output(options)`,
and targets `draft-2020-12`, `draft-07` and `openapi-3.0`
[W: raw.githubusercontent.com/standard-schema/standard-schema/main/packages/spec/src/index.ts,
2026-09-25]. Which libraries implement it is [U]. The plan uses it when
present and shows the facts from `describe()` otherwise (§14).

### 2.4 Versioned contracts the package already has

- `JOBS_API_PROTOCOL_VERSION = 1` (`api/contract/constants.ts:16`), reported by
  `/meta` (`api/routes/meta.ts:419`) [S].
- `/meta` reports the driver's capabilities (`meta.ts:426-429`) [S], which is
  the precedent for reporting a plugin's (§14).
- The planned wire protocol negotiates a protocol number and carries
  `features`, "each with its own version string", so that "a third-party
  implementation lags feature by feature, never all at once"
  (`worker-runtimes.md` §5.4) [D there]. Per-facet `apiVersion` (§10) is the
  host-side version of the same idea.

### 2.5 `Executor` is not yet open to a third party

`worker-runtimes.md` §4.2 says a custom target "is an `Executor` whose `mode`
is a string of its own". Against today's types that is not so:

- `Executor.mode` is `ExecutionMode` (`runner/executors/executor.ts:136`) [S],
  a closed union `"spawn" | "worker" | "in-process"` (`drivers/driver.ts:162`)
  [S], and `worker-runtimes.md` §4.5 rightly refuses to widen it, because it
  is persisted in `RunRecord.mode`.
- `ExecutorStartOptions.file` is required (`executor.ts:101`) [S]. A remote
  executor has no file.

So Phase 1's `WorkerTargetFactory` needs a target-level executor type with an
open `mode` and an optional `file`, or a wrapper. That is Phase 1's work, and
`worker-runtimes.md` §4.2 now says so. It is also why the execute facet (§8)
does **not** ask a plugin to implement `Executor`: the plugin supplies a
transport, and bun-jobs' own `RemoteTarget` is the executor.

**Resolved by Phase 1 (#164, merged at `0a8e580`)** [S]: the target-level type
is `WorkerTargetExecutor { readonly name; run(attempt); close?() }`
(`queue/workerTarget.ts:209-235`), made by a `WorkerTargetFactory(context)`
(`:159`, its context `:172`) and given one `WorkerTargetAttempt` per job
(`:238`). It has an open `name` (1–64 characters, validated when the factory
returns) instead of a `mode`, and no `file`; `Executor` and `ExecutionMode`
are untouched. A custom target is reported on the heartbeat record as
`target: { kind: "custom", processor, name }`, and its `close()` is called on
`worker.close()` bounded by 5 s (`BunQueueWorker.ts:1708-1733`). The execute
facet's `RemoteTarget` (§8) is therefore a `WorkerTargetExecutor`, and the
summon facet is unaffected: a summoned worker may use any target.

---

## 3. Prior art

Each row names one thing to copy and one to avoid. Everything was read on
2026-09-25.

| System | What it is | Copy | Avoid | Source |
|---|---|---|---|---|
| **KEDA external scalers** | A gRPC service KEDA calls: `IsActive`, `StreamIsActive`, `GetMetricSpec`, `GetMetrics`, `StreamMetricSpec` [W]. Referenced by `scalerAddress` in a ScaledObject, with optional TLS [W] | A tiny, fixed hook set; the caller passes the scaled object's name, namespace and metadata on every call, so the scaler holds no state [W] | No version field anywhere in the messages [W]; compatibility rests on protobuf field numbering alone. A plugin API without a version cannot refuse a mismatch | [W: raw.githubusercontent.com/kedacore/keda/main/pkg/scalers/externalscaler/externalscaler.proto; keda.sh/docs/2.21/concepts/external-scalers] |
| **Kubernetes Cluster Autoscaler** | In-tree cloud providers behind a `CloudProvider`/`NodeGroup` interface, plus an `externalgrpc` provider so a vendor can ship out of tree "without modifying the cluster autoscaler codebase" [W] | Optional methods return `ErrNotImplemented` and the host falls back: the Cluster API provider returns it from `AtomicIncreaseSize`, and the autoscaler falls back to `IncreaseSize` [W]. The same issue shows why a declared capability must be *true*: the fallback read-then-patch "weakens the all-or-nothing semantics" the caller expected [W]. `externalgrpc` recommends mTLS because unauthenticated calls "will result in the creation / deletion of nodes" [W] | In-tree providers: the FAQ lists about thirty `--cloud-provider` values [W], every one maintained in the host's repo. That is the arrangement this plan's no-privileged-internals rule avoids | [W: raw.githubusercontent.com/kubernetes/autoscaler/master/cluster-autoscaler/cloudprovider/externalgrpc/README.md; github.com/kubernetes/autoscaler/issues/10318; …/cluster-autoscaler/FAQ.md]. The `NodeGroup` method list itself could not be fetched (404 on two URLs), so no row rests on it [U] |
| **Terraform / OpenTofu providers** | Separate binaries over a versioned plugin protocol. Protocol 5 works with Terraform 0.12+, protocol 6 with 1.0+ [W] | "Minor versions of the protocol are additive"; "major versions … delineate … compatibility" [W]. The registry uses `protocol_versions` from a manifest as "compatibility metadata" when choosing a plugin version [W]. Names are `terraform-provider-{NAME}`, tags are semver [W]. Sources are `namespace/type`, and two providers with one local name need "a compound local name" [W] | GPG-signed releases and a hosted registry [W]: the right thing for a binary ecosystem, and too much for an npm package that npm already signs [I] | [W: developer.hashicorp.com/terraform/plugin/terraform-plugin-protocol; …/terraform/registry/providers/publishing; …/terraform/language/providers/requirements] |
| **Nomad plugins** | A base plugin (`PluginInfo`, `ConfigSchema`, `SetConfig`) plus a task-driver interface (`StartTask`, `WaitTask`, `StopTask`, `InspectTask`, `RecoverTask`, …) [W] | `PluginInfo` returns "the versions of the Nomad plugin API that the plugin supports", and `SetConfig` hands back "the negotiated plugin API version to use" [W]. A driver declares a `Capabilities` struct (`SendSignals`, `Exec`, `FSIsolation`, …) [W]. The plugin declares its own config schema [W] | Nomad's plugins are separate processes; go-plugin says "a panic in a plugin doesn't panic the plugin user" [W]. Ours run in-process and get none of that isolation. Say so (§13) rather than borrow the reassurance | [W: raw.githubusercontent.com/hashicorp/nomad/main/plugins/base/base.go; developer.hashicorp.com/nomad/docs/concepts/plugins/task-drivers; raw.githubusercontent.com/hashicorp/go-plugin/main/README.md] |
| **Vite / Rollup plugins** | An object with a `name` and hooks | `name` is "required, will show up in warnings and errors" [W]. Naming conventions: `vite-plugin-`, `rollup-plugin-`, and the matching `keywords` entry in `package.json` [W]. Rollup's conventions also say "plugins should be tested" and "document your plugin in English" [W] | Ordering (`enforce: "pre"/"post"`, per-hook `order`) [W]. One queue has one provider per facet, so there is nothing to order, and importing ordering machinery would invite hooks that chain [I] | [W: vite.dev/guide/api-plugin; raw.githubusercontent.com/rollup/rollup/master/docs/plugin-development/index.md] |
| **Temporal serverless workers** | A Worker Controller Instance invokes a configured compute provider when a task finds no poller (`worker-runtimes.md` §3.8.1) | The provider config is data: provider type, function ARN, role to assume [W-search] | **No third-party provider API is documented.** The self-hosted setup enables providers by listing types, `workercontroller.compute_providers.enabled: [aws-lambda]`, and says nothing about adding one [W]. A closed list is exactly what this plan exists to avoid | [W: docs.temporal.io/production-deployment/worker-deployments/serverless-workers/self-hosted-setup; W-search: docs.temporal.io/serverless-workers] |

**The pattern across them** [I]: every mature system (Terraform, Nomad) that
lets strangers write plugins carries an explicit API version and negotiates
it, declares capabilities as data, and gives the plugin a config schema of its
own. The two without a version (KEDA's gRPC contract; bun-jobs' own drivers)
evolve by addition only and carry the cost as fallbacks.

---

## 4. One plugin system or two

The question: should summoning (Phase 1.5) and remote execution (Phases 2–4)
share one plugin model, or have two?

### 4.1 What the two actually need from a provider

| Need | Summon | Execute, host side | Execute, platform side |
|---|---|---|---|
| Where it runs | the bun-jobs process with the controller | the bun-jobs process with the gateway | **on the platform**: an isolate, a Lambda, a container. Often not Bun |
| Credentials | the platform's control-plane API (start a task) | often the same account's data-plane API (invoke a function), or none (a public URL) | none of the platform's: it holds the HMAC secret only |
| Config | region, cluster, task definition, … | region, function name or URL, … | handlers, `maxBatch`, `maxDurationMs` |
| Error kinds | throttle, quota, auth, misconfigured, conflict | the same set, plus transport statuses (`worker-runtimes.md` §5.5) | not errors of ours: it answers the protocol |
| Declared limits | style, dedupe, boot budget, shutdown | `TransportCapabilities`: shape, direction, streaming, ordering, reliability, confidentiality, frame and message size, duration, concurrency (§8.2) | advertised in the handshake (`worker-runtimes.md` §5.4) |
| Bundle rules | Bun, server-side | Bun, server-side | **browser-safe**, `"browser": true` in `consumer-check.json` (`worker-runtimes.md` §6.3), for a FaaS runtime adapter; a long-running executor's transport server (`./remote/serve`) is Bun-only |
| Contract | TypeScript interface | TypeScript interface | the wire protocol, `PROTOCOL.md` |

### 4.2 The options

**A. One provider object with three facets** (summon, execute-host,
execute-platform). One `defineComputeProvider` would hold the remote handler
too.

- *For:* one thing to learn.
- *Against:* the platform half must load in an isolate, and the host half
  imports credential helpers, `Bun.spawn` (SSH) and the error machinery. One
  object means one module graph, so a runtime-adapter bundle would pull
  server code in. The bundle-safety test that guards `./remote`
  (`worker-runtimes.md` §6.3) would fail on the first provider [I].

**B. Two independent systems**, "summoners" and "remote transports".

- *For:* each can move at its own pace.
- *Against:* AWS would ship two packages, each with its own SigV4 credential
  chain config, two config schemas describing the same region and role, two
  version schemes, two kits, two author guides. The error taxonomy would be
  written twice and drift [I]. The user asked for "a plugin" per provider.

**C. One host-side provider model with facets, and a separate runtime-adapter
kit** [D]. **Recommended.**

- The **core** (identity, config schema, secrets, `describe`, `validate`,
  errors, redaction, contexts) is shared.
- The **`summon` facet** and the **`execute` facet** are optional members of
  one provider object. A provider implements one or both.
- The **platform side is not a facet.** It is a *runtime adapter*, made with
  `defineRuntimeAdapter()` from `./remote`. It is browser-safe and versioned
  by the wire protocol (`WORKER_PROTOCOL_VERSION`) plus a small
  `RUNTIME_ADAPTER_API` version for the helper types (§10.2). It is tested by
  `conformRemoteExecutor` (`worker-runtimes.md` §7.1), which is black-box over
  HTTP and so applies to a third party's adapter unchanged.
- **One npm package per provider, two entries**: the root (host side, the
  provider object) and `./runtime` (the platform side, browser-safe), exactly
  as bun-jobs itself pairs `.` with `./remote`. A provider with no execute
  facet has no `./runtime`.
- **Per-facet versions** (§10), so `execute` can change during Phase 2 while
  `summon` plugins shipped in Phase 1.5 keep working.

### 4.3 Why C, and what would change the answer

C keeps what the coordinator's hypothesis got right: one identity, one
credential path, one config, one error vocabulary, one kit harness, one
author guide. It rejects the part that would break: the remote handler is a
different program in a different runtime, and pretending it is a facet of the
host object would make every runtime bundle import server code.

**What would change the answer** [I]: if nobody ships a provider with both
facets by the `execute` 1.0 gate, the shared core bought little, and B's
simplicity would have been enough. The cost of having chosen C in that case is
small: a facet-less core is still a thin object. Recorded as Q-P1.

---

## 5. The rule: first-party providers get no privileged internals

**Statement.** Every first-party provider (`lib/providers/*.ts`) and every
first-party runtime adapter (`lib/remote/adapters/*.ts`) is written against the
public plugin API and imports nothing else from the package. If a first-party
provider needs something the API does not offer, the API grows, and third
parties get it too.

**What they may import** [D]:

| From | Allowed |
|---|---|
| `lib/providers/*.ts` | `../provider/index.ts` (the `./provider` entry), `../provider/auth/index.ts` (`./provider/auth`), `../summon/index.ts` (`./summon`, types only), sibling files under `lib/providers/<name>/` if a provider grows helpers, `@kingsleyweb/bun-common`, `node:*`/`bun:*` built-ins |
| `lib/remote/adapters/*.ts` | `../index.ts` (the `./remote` entry) only, plus sibling adapter helpers. No built-ins: they must stay browser-safe |

Imports go to the entry file by relative path, not to the package's own name.
Whether a Bun workspace package can import itself through its `exports` map is
[U], and relative imports to the entry file give the same guarantee without
depending on it [I].

**How it is enforced** [D]: `__tests__/provider/first-party-imports.test.ts`.
It scans every file under `lib/providers/` and `lib/remote/adapters/` with
`new Bun.Transpiler({ loader: "ts" }).scanImports(source)`, type imports
included, and fails on any specifier outside the table. A negative control
feeds it a source with a deep import (`../../summon/marker`) and expects a
failure. This is the technique `api-contract.test.ts:99-127` already uses to
hold `api/contract/` to its import graph [S].

**What it does not cover** [I]: a first-party provider could still depend on
*behaviour* only bun-jobs knows about, such as an undocumented field on a
request. The defence is the documentation drift test (§15.3): every member a
provider reads must be in the reference.

---

## 6. The core

Everything in this section is exported from `./provider`
(`lib/provider/index.ts`). Every property has a JSDoc description, as
`CLAUDE.md` requires.

### 6.1 Identity and the definition

```ts
/** The plugin API versions this build of bun-jobs speaks, per facet: `"major.minor"`. */
export const COMPUTE_PROVIDER_API: {
  /** The shared core: identity, config, errors, contexts. */
  readonly core: "0.1";
  /** The summon facet (§7). */
  readonly summon: "0.1";
  /** The execute facet, host side (§8). */
  readonly execute: "0.1";
};

/** The plugin API versions a provider was written against. A facet it does not implement is omitted. */
export interface ProviderApiVersions {
  /** The core version, `"major.minor"`. Required. */
  core: string;
  /** The summon facet version, when the provider has a `summon` facet. */
  summon?: string;
  /** The execute facet version, when the provider has an `execute` facet. */
  execute?: string;
}

/** Who a provider is. Shown in logs, events, the status route and the UI. */
export interface ProviderIdentity {
  /**
   * The provider's unique name: its npm package name, optionally with a
   * `:variant` when one package ships several providers, e.g.
   * `"@acme/bun-jobs-provider-acme"` or `"@kingsleyweb/bun-jobs:ecs"`. Used to
   * tell two providers apart (§9.3); never parsed.
   */
  readonly name: string;
  /** The provider's own version, semver. Usually its `package.json` version. */
  readonly version: string;
  /** A short label for badges and event payloads, e.g. `"ecs"`, `"fly"`. Lowercase, `[a-z0-9-]{1,24}`. */
  readonly kind: string;
  /** A human name for the UI, e.g. `"AWS ECS (RunTask)"`. Defaults to `kind`. */
  readonly displayName?: string;
  /** Where its documentation lives. Shown as a link in the UI. */
  readonly homepage?: string;
  /** The plugin API versions it was written against, checked at registration (§10). */
  readonly apiVersion: ProviderApiVersions;
}

/**
 * Everything a plugin author writes. `TConfig` is the validated config the
 * facets receive; `TInput` is what a user passes.
 */
export interface ComputeProviderDefinition<TConfig, TInput = TConfig> extends ProviderIdentity {
  /**
   * Validates and normalises the user's config: any Standard Schema (zod,
   * valibot, arktype, bun-jobs' `s`, or `toStandardSchema` around a function).
   * Omitted, the input is passed through unvalidated, which the conformance
   * kit reports as a warning.
   */
  readonly config?: StandardSchemaV1<TInput, TConfig>;
  /**
   * Dotted paths into the *validated* config whose values are secrets, e.g.
   * `["apiToken", "credentials.secretAccessKey"]`. Their values are redacted
   * wherever bun-jobs writes text: logs, errors, events, the status route
   * (§13.3). A path that does not exist is ignored.
   */
  readonly secrets?: readonly string[];
  /**
   * Secret-free facts for the status route and the UI: a region, a cluster, an
   * app name. Never a token, a key, or a URL with credentials in it. Values
   * that match a declared secret are redacted anyway.
   */
  readonly describe?: (config: TConfig) => Readonly<Record<string, string>>;
  /**
   * An optional preflight: can this config reach the platform? Resolve the
   * credentials, read the cluster, check the function exists. Run on demand
   * from the management API and, when the user asks, once at start. Must not
   * start compute or spend money.
   */
  readonly validate?: (config: TConfig, context: ProviderCallContext) => Promise<readonly ProviderCheck[]>;
  /** The summon facet: how to start compute. §7 */
  readonly summon?: (config: TConfig, context: ProviderSetupContext) => SummonFacet;
  /** The execute facet, host side: how to carry an attempt to the platform. §8 */
  readonly execute?: (config: TConfig, context: ProviderSetupContext) => ExecuteFacet;
}

/** One preflight finding from `validate()`. */
export interface ProviderCheck {
  /** A stable id for the check, e.g. `"credentials"`, `"cluster-exists"`. */
  id: string;
  /** Whether it passed. `"warn"` means it works but something is off. */
  status: "pass" | "warn" | "fail";
  /** A short, secret-free explanation. */
  detail?: string;
}

/**
 * A provider as a user receives it: call it with config to get a configured
 * instance. Also carries the definition, for tooling and the kit.
 */
export interface ComputeProvider<TInput, TConfig = TInput> {
  /** Configures the provider. Validates synchronously when the schema allows (§6.3). */
  (config: TInput): ConfiguredProvider<TConfig>;
  /** The definition it was made from. Read-only; for the conformance kit and tooling. */
  readonly definition: ComputeProviderDefinition<TConfig, TInput>;
  /** Brand, so bun-jobs never has to guess what an object is (§2.2). */
  readonly [COMPUTE_PROVIDER]: true;
}

/** A provider plus a validated config: what `SummonPolicy.summoner` and a remote target accept. */
export interface ConfiguredProvider<TConfig = unknown> {
  /** The provider's identity. */
  readonly provider: ProviderIdentity;
  /** The validated config. Secret paths are still present; never serialise this. */
  readonly config: TConfig;
  /**
   * Resolves once config validation has finished. Already resolved when the
   * schema validated synchronously; rejects with `ConfigError` when it failed.
   */
  readonly ready: Promise<void>;
  /** The summon facet, built from the config, when the provider has one. */
  readonly summon?: SummonFacet;
  /** The execute facet, built from the config, when the provider has one. */
  readonly execute?: ExecuteFacet;
  /** Secret-free facts, from `describe()` with secrets redacted. */
  describe: () => Readonly<Record<string, string>>;
  /** Runs `validate()`, or answers `[]` when the provider has none. */
  validate: (options?: { signal?: AbortSignal }) => Promise<readonly ProviderCheck[]>;
  /** Brand. */
  readonly [CONFIGURED_PROVIDER]: true;
}

/** Makes a provider. A typed identity function plus the brand; it does no I/O. */
export function defineComputeProvider<TConfig, TInput = TConfig>(
  definition: ComputeProviderDefinition<TConfig, TInput>,
): ComputeProvider<TInput, TConfig>;
```

**Why a factory and a configured instance, not one object.** The declared
capabilities often depend on config. Cloud Run's dedupe token must fit with
the job name inside 63 characters [V, google-azure §3.2], so its
`dedupe.maxLength` is a function of the job name. ECS's grace is its
`stopTimeout` option (`summon-compute.md` §7.2). So facets are built from the
validated config, once, at configuration time [D].

**Why a brand.** `resolveLogger`'s history (§2.2) is the argument: shape
detection works until two shapes overlap. The brand is a `Symbol.for(...)`
key, so two copies of bun-jobs in one tree still recognise each other's
providers [I].

### 6.2 Contexts

```ts
/** What a facet factory receives once, when a provider is configured. */
export interface ProviderSetupContext {
  /**
   * The versions the host negotiated for this provider, per facet, as
   * `"major.minor"` (§10). A provider written for a newer minor can degrade
   * here, as Nomad hands a plugin its negotiated API version.
   */
  readonly api: ProviderApiVersions;
  /** The host's bun-jobs version, for diagnostics only. Never branch on it; branch on `api`. */
  readonly hostVersion: string;
  /** A logger bound to the provider, with its secrets redacted (§13.3). */
  readonly logger: Logger;
}

/** What every facet call receives. */
export interface ProviderCallContext {
  /** Aborted when the call's timeout passes or its owner closes. Honour it. */
  readonly signal: AbortSignal;
  /** A logger bound to the provider, the queue and the attempt, secrets redacted. */
  readonly logger: Logger;
  /**
   * The `fetch` to use for every platform call. Defaults to the global one.
   * The conformance kit replaces it to record requests and route them to a
   * fake platform, so a provider that calls the global `fetch` directly fails
   * the kit's purity and routing checks.
   */
  readonly fetch: typeof fetch;
  /** The host's clock, epoch ms. Use it rather than `Date.now()`, as drivers do. */
  readonly now: () => number;
}
```

`ctx.now()` carries the driver rule "Never read the clock" (`driver.ts:48-50`)
[S] into plugins, which is what lets the kit run with a fake clock.

### 6.3 Config validation

- `provider(config)` runs the schema's `~standard.validate` at once. When it
  answers synchronously (zod, valibot, arktype and `s` do for synchronous
  schemas [I]), an invalid config throws `ConfigError` right there, carrying
  the Standard Schema issues as `{ path, message }`, which is the shape
  `BunValidate` already normalises to [S, `BunValidate.ts:368-381`].
- When it answers with a promise, `configure` returns at once and `ready`
  settles later. The controller and the gateway await `ready` before their
  first call, so an async schema's failure surfaces there as a `ConfigError`
  [D].
- The validated output, not the input, reaches the facets. Defaults and
  coercions a schema applies are therefore the provider's own [D].

### 6.4 Credential helpers, public

The helpers `summon-compute.md` §8 plans are public, from `./provider/auth`
(`lib/provider/auth/index.ts`) [D]:

| Export | What | Status in the evidence |
|---|---|---|
| `signAwsRequest(request, { credentials, region, service })` | SigV4 over a `Request`, WebCrypto only | matched 5 of the 7 vectors its harness runs; the 2 differences are the path-encoding question, Q2 [M, aws §5.2] |
| `resolveAwsCredentials(source?)` | the chain: env, ECS task role, EKS Pod Identity, IMDSv2, IRSA, `AssumeRole`, with a cache | compiled, never run against AWS [M/U, aws §5.3] |
| `getGoogleToken(source?)` / `getAzureToken(source?)` | service-account JWT or metadata server; secret, federated, ACA endpoint or IMDS | 65 lines together; never sent to either token endpoint [M/U, google-azure §2.3] |
| `signJwtRs256(claims, key)` | the shared JWT piece | RS256 verifies with `openssl` [M, google-azure §2.3] |

**Why public, and why one entry.** A third-party provider for another AWS
service (App Runner's successor, Batch) or another Google API needs exactly
these, and without them every author writes a signer, and some get the
path-encoding wrong [I]. One entry rather than one per cloud: together they are
a few hundred lines with no dependency, so loading all of them is cheap, and a
provider author learns one import [I]. The price: they become API. Their
signatures are frozen with the `core` facet at 1.0, and the two [U]s above
must close first (§10.4).

### 6.5 Errors

```ts
/** How a platform failure should be treated. The controller's and gateway's reactions are in the table below. */
export type ProviderErrorKind =
  | "transient"      // network error, 5xx, a timeout the platform reported: try again later
  | "throttled"      // 429 or a rate-limit code: slow down, honour `retryAfterMs`
  | "quota"          // an account or regional limit: Fargate vCPU, Lambda concurrency, a plan cap
  | "auth"           // credentials missing, expired or rejected: 401, 403, a failed token exchange
  | "misconfigured"  // the config names something that is not there or is invalid: 404 cluster, bad parameter
  | "conflict";      // the platform refused a request as inconsistent with an earlier one under the same token

/** What a provider throws. Anything else thrown is treated as `transient` and logged once as a plugin bug. */
export class ProviderError extends JobsError {
  constructor(
    /** A short, secret-free description. */
    message: string,
    /** How the failure should be treated. */
    kind: ProviderErrorKind,
    options?: {
      /** The platform's own error code, e.g. `"ThrottlingException"`, for logs and the UI. */
      platformCode?: string;
      /** The HTTP status the platform answered, when there was one. */
      status?: number;
      /** Try no sooner than this many ms from now. Honoured for `throttled` and `quota`. */
      retryAfterMs?: number;
      /** The original error, kept as `cause`. Redacted before it is logged. */
      cause?: unknown;
    },
  );
  /** How the failure should be treated. */
  readonly kind: ProviderErrorKind;
  /** The platform's own error code, when known. */
  readonly platformCode?: string;
  /** The platform's HTTP status, when known. */
  readonly status?: number;
  /** The platform's requested wait, in ms, when it gave one. */
  readonly retryAfterMs?: number;
}
```

It extends `JobsError`, whose `code` and `context` are the package's existing
error shape (`shared/errors.ts:30-50`) [S]. Its `code` is
`"PROVIDER_<KIND>"`.

**What each kind does** [D]:

| Kind | Summon controller (`summon-compute.md` §4.3–§4.4) | Execute gateway (`worker-runtimes.md` §5.5, §5.7) | UI |
|---|---|---|---|
| `transient` | outcome `failed`; counts toward the circuit; normal backoff | transport retry (same idempotency key); counts toward the breaker | "failed" |
| `throttled` | outcome `unavailable`; backoff = `max(backoff, retryAfterMs)`; **does not** count toward the circuit | transport retry after `retryAfterMs`; does not trip the breaker | "throttled" |
| `quota` | outcome `unavailable`; counts toward the circuit; backoff at least `retryAfterMs` | the attempt is `rejected` (not an attempt, `worker-runtimes.md` §5.5); breaker counts it | "quota" with the platform code |
| `auth` | outcome `failed`; **opens the circuit at once**; `error` log naming the provider | trips the breaker at once, burns no attempt (the §5.5 rule for 401/403) | "credentials rejected" |
| `misconfigured` | as `auth` | as `auth` (the §5.5 rule for 404/405) | "configuration" |
| `conflict` | outcome `failed`; `error` log: the request was not a pure function of its key (§4.6 there), which is a provider bug; counts toward the circuit | not expected; treated as `misconfigured` | "provider bug" |

**Two things that are not errors.** "Already running" and "this token already
ran" are *answers*, returned as `SummonResult` statuses `already-running` and
`deduped` (`summon-compute.md` §4.10). "The platform accepted but has no
capacity right now" with a 200 (ECS's `failures` array [V, aws §7 item 6]) is
the `unavailable` result. The rule for authors: **a result when the platform
answered normally, a `ProviderError` when it did not.** The kit checks both
directions (§12.2).

**An unmapped throw.** Treated as `transient`, with one `warn` per provider
per process naming it: "provider X threw a non-`ProviderError`; map it". The
kit fails such a throw (§12.2). Treating it as `transient` rather than
`misconfigured` errs toward retrying, bounded by the circuit [I].

---

## 7. The `summon` facet

### 7.1 Capabilities

```ts
/** What a summon facet declares. The controller reads these instead of knowing platforms by name. */
export interface SummonCapabilities {
  /**
   * How it starts compute:
   * - `"launch"`: start N new units (`RunTask`, `jobs:run`, `systemd-run`). A
   *   race can double up, so the marker is claimed first.
   * - `"scale"`: set a count (`manualInstanceCount`, `desiredCount`).
   *   Idempotent; needs `release()` to go back to zero.
   * - `"wake"`: start one of a fixed pool of pre-created units (Fly Machines,
   *   a stopped VM). Starting a started unit is harmless; the pool size is
   *   the ceiling.
   */
  style: "launch" | "scale" | "wake";
  /** How the platform deduplicates a retried call. §4.4 of `summon-compute.md` calls this the second line. */
  dedupe: SummonDedupe;
  /**
   * How per-attempt values reach the process: `"env"` per run, `"argv"` only
   * (Render's `startCommand`), or `"none"` (the unit's config is fixed, as for
   * a pre-created Fly Machine or an ACA job whose override would replace its
   * secrets). With `"none"`, attempts are released by start time, not by id.
   */
  passes: "env" | "argv" | "none";
  /**
   * The default in-flight TTL, in ms: cold start + Bun boot + driver connect +
   * one report. `SummonPolicy.bootBudget` overrides it. Every first-party
   * figure is an [I] until measured (`summon-compute.md` Q31).
   */
  bootBudgetMs: number;
  /** What the platform sends to stop a unit, and how long it waits before killing it. */
  shutdown: {
    /** The stop signal: `"SIGTERM"` on most platforms, `"SIGINT"` on Fly by default, `"none"` for Lambda's in-invocation model. */
    signal: "SIGTERM" | "SIGINT" | "none";
    /** The grace after the signal, in ms, as configured. Passed to the worker as `BUN_JOBS_SUMMON_GRACE_MS`. */
    graceMs: number;
    /** The most the platform allows the grace to be raised to, when known. The UI shows it beside a too-short grace. */
    graceMaxMs?: number;
  };
  /**
   * The platform's own cap on one unit's life, in ms, or `null` for none
   * known. The controller refuses a `maxLifetime` above it with a
   * `ConfigError` rather than let the platform kill the worker mid-job.
   */
  maxLifetimeMs: number | null;
  /** Whether the facet maps `request.maxLifetimeMs` onto the platform's cap (a task timeout, `RuntimeMaxSec`). */
  enforcesLifetime: boolean;
  /** The most units one `summon()` may start, when the platform limits it. `count` is clamped to it. */
  maxCountPerCall?: number;
  /** `"wake"` only: how many units the pool has. `maxWorkers` above it is clamped, with a `warn`. */
  poolSize?: number;
}

/** How a platform dedupes, and the key it accepts. */
export type SummonDedupe =
  | {
      /** A request token the platform remembers: ECS `clientToken`, EC2 `ClientToken`, Nomad `idempotency_token`. */
      kind: "token";
      /** The longest key it accepts. `request.dedupeKey` is clipped to fit. */
      maxLength: number;
      /** The characters it accepts, as a character-class body, e.g. `"A-Za-z0-9-"`. */
      charset: string;
      /** What the token is unique within, for the docs and the UI, e.g. `"cluster"`, `"region"`. */
      scope: string;
      /** How long the platform remembers it, in ms, when documented (ECS: up to 24 h). */
      ttlMs?: number;
      /**
       * Whether a same-token request with different parameters is an error
       * (ECS `ConflictException`, EC2 `IdempotentParameterMismatch`). When `true`,
       * requests must be pure functions of the key, and the kit checks it.
       */
      strict: boolean;
    }
  | {
      /** A name the platform will not create twice: a systemd unit, a Kubernetes Job. */
      kind: "name";
      /** The longest name it accepts. */
      maxLength: number;
      /** The characters it accepts, as a character-class body. */
      charset: string;
    }
  | {
      /** No platform dedupe. The marker's CAS is the whole guard. */
      kind: "none";
    };
```

**What the controller does with each** [D]. This replaces every place
`summon-compute.md` hard-coded a platform:

| Capability | Controller behaviour | Replaces in `summon-compute.md` |
|---|---|---|
| `style` | `"scale"` enables the scale-down path and requires `release`; `"wake"` clamps `maxWorkers` to `poolSize`; `"launch"` is the default path | §4.7 table; Fly's "launch over a pool, which behaves like set-N" (§7.1 row 2) is now `wake` |
| `dedupe` | `request.dedupeKey` = `request.id` clipped to `maxLength` of `charset`, computed by the controller, so the provider never builds a key. **`request.id` never repeats**: it hashes the marker's random `epoch` with the version the claim writes, because a queue-state entry's version restarts at `1` after a delete or a purge, and a platform that remembers tokens (ECS, 24 h) would answer a repeated id `deduped` and start nothing (`summon-compute.md` §4.0 R6). A provider may rely on this | §4.6's fixed 64-character rule, and "that adapter shortens further" for Cloud Run |
| `passes` | `"none"` → release by start time (§4.3 step 2) | §4.3, §7.3, §7.5 |
| `bootBudgetMs` | default `until` for a pending attempt | §7.1 column |
| `shutdown` | sets `BUN_JOBS_SUMMON_GRACE_MS`; `warn` when `graceMs` is below `runSummoned`'s `shutdownBuffer` | §5.2 ("the first-party adapters pass their platform's default") |
| `maxLifetimeMs`, `enforcesLifetime` | `ConfigError` for a `maxLifetime` above the cap; the status route says whether the cap is enforced | §4.5's list of platform caps |
| `maxCountPerCall` | clamps `count` | — |

### 7.2 Hooks

```ts
/** The summon facet: what the controller calls. Made by a provider's `summon(config, ctx)`. */
export interface SummonFacet {
  /** What it can do. Read once, when the controller is built. */
  readonly capabilities: SummonCapabilities;
  /**
   * Starts compute for one attempt. Required. A result when the platform
   * answered normally (`started`, `deduped`, `already-running`,
   * `unavailable`); a `ProviderError` when it did not. Must be a pure function
   * of `request` when `dedupe.strict` is true.
   */
  summon: (request: SummonRequest, context: ProviderCallContext) => Promise<SummonResult>;
  /** Scale style only, and then required: set the platform's count, usually to `0`. */
  release?: (request: SummonReleaseRequest, context: ProviderCallContext) => Promise<void>;
  /**
   * What the platform says about units it started, by the handles `summon`
   * returned. Optional. Used to explain a lost attempt ("exited 1", "image
   * pull failed") and to cancel one that is still pending (§7.3).
   */
  status?: (handles: readonly string[], context: ProviderCallContext) => Promise<readonly UnitStatus[]>;
  /** Stops units by handle, best effort. Optional. Used for a lost attempt still pending, and for a manual stop. */
  cancel?: (handles: readonly string[], context: ProviderCallContext) => Promise<void>;
}

/** One unit, as the platform reports it. */
export interface UnitStatus {
  /** The handle `summon` returned for it. */
  handle: string;
  /** Where it is. `"unknown"` when the platform no longer knows the handle. */
  state: "pending" | "running" | "exited" | "failed" | "unknown";
  /** The exit code, when it exited and the platform says. */
  exitCode?: number;
  /** A short, secret-free platform reason: `"CannotPullContainerError"`, `"OOMKilled"`. */
  detail?: string;
}
```

`SummonRequest`, `SummonReleaseRequest` and `SummonResult` are
`summon-compute.md` §4.10's, with one change: `signal` and `logger` move from
the request into `ProviderCallContext`, where the execute facet has them too.

### 7.3 What the optional hooks buy

- **`status` answers `summon-compute.md` §9.4's "why a lost attempt was
  lost".** When an attempt passes `until` unregistered, the controller calls
  `status(handles)` once. `failed`/`exited` with a detail goes into
  `marker.last.detail` and the `summon` event. That is what the UI shows
  instead of "check the platform's logs" [D].
- **`cancel` closes a late-duplicate window.** An attempt declared lost whose
  unit is still `pending` (a slow image pull) would otherwise start a worker
  *after* its replacement. With `cancel`, the controller stops it first [D].
  Without `status`/`cancel`, behaviour is exactly `summon-compute.md`'s.
- **`validate` backs a "Test connection" button** and an optional
  `validateOnStart` (§14).

### 7.4 `defineSummoner({ invoke })` becomes a wrapper

`summon-compute.md` §4.10 defines `defineSummoner` as the escape hatch.
Keeping it *and* adding providers would leave two concepts for the same thing.
So [D]:

- **`Summoner`** is renamed in meaning, not in name: it is **a configured
  provider that has a summon facet**, i.e. `ConfiguredProvider & { summon:
  SummonFacet }`. It is what `SummonPolicy.summoner` accepts.
- **`defineSummoner(options)`** builds an anonymous provider and configures it
  in one call: `name: "custom:" + kind`, `version: "0.0.0"`, `apiVersion`
  equal to the host's current versions (it cannot be out of date: it is built
  by the host), no schema, and a summon facet whose `summon` wraps `invoke`
  (a `void` return still means `{ status: "started", handles: [] }`).
  Capabilities come from its options with the same defaults as before
  (`style: "launch"`, `bootBudget: 180_000`, `passes: "env"`), plus
  `dedupe: { kind: "none" }` and `shutdown: { signal: "SIGTERM", graceMs:
  10_000 }` unless given.
- **A bare function** in `SummonPolicy.summoner` stays shorthand for
  `defineSummoner({ invoke })`.

So there is one concept, a provider, and two ways to make one: a published,
versioned, schema-validated plugin, or a local one-off with no ceremony. The
kit accepts both, so a user can conformance-test a local `invoke` too [D].

---

## 8. The `execute` facet

**Revised 2026-09-25: transport-agnostic.** At the user's request, remote
execution runs over HTTP, streamed HTTP, SSE, WebSocket in both directions,
TCP, UDP and HTTP/2, and a plugin can add others (gRPC, QUIC, NATS, MQTT,
AMQP, Kafka). The design of those transports is
[`remote-transports.md`](remote-transports.md). This section is where the
facet's interface lives: it gains a **session shape** beside the original
**exchange shape** (`send(Request) → Response`), and it declares
**transport capabilities** in place of the old `ExecuteCapabilities`. §1,
§4.1, §10.4, §11.1, §12.3, §14 and §17 were updated to match.

### 8.1 Where it fits

`worker-runtimes.md` gives a remote target three layers:

1. **The gateway** (`RemoteTarget`, an executor inside `BunQueueWorker`): it
   claims, holds the lease, builds the envelope, signs it, sends it, verifies
   the answer and settles (§4.3, §5.5–§5.9 there).
2. **The transport**: how the signed bytes reach the platform. In §4.2 there,
   this is always plain HTTPS to `url`.
3. **The remote executor**: `createRemoteExecutor()` behind a platform wrapper
   (§6 there).

The execute facet is **layer 2, made pluggable** [D]. Layer 1 stays bun-jobs'
and is the same for every provider. Layer 3 is the runtime adapter kit (§8.4).

**Why plain HTTPS is not enough** [I]:

- **Private endpoints need platform auth on top of HMAC.** A private Cloud Run
  service needs a Google ID token; a Lambda can be invoked by its API with
  SigV4 and no public URL at all; a Fly app can be reached on its private
  network only from inside it.
- **Some endpoints are named, not addressed.** "Function `reports` in
  `eu-west-1`" is a config; its URL is something to look up.
- **Limits differ per transport, not per remote.** A synchronous Lambda invoke
  caps request and response at 6 MB (`worker-runtimes.md` §6.4 snippet), and
  whether a response can stream depends on the invoke path. The remote's
  handshake cannot know which path the gateway used.
- **Not every transport is request/response** (added 2026-09-25). A
  WebSocket, a TCP connection, a UDP flow or a broker subscription is a
  long-lived duplex channel with no request boundary, and a reversed
  WebSocket is one the *executor* opens. `remote-transports.md` §3 splits
  layer 1 further: a **protocol core** (messages, per-frame MAC and AEAD
  sealing, the reliability layer, health) sits between the gateway and the
  transport, so the transport only moves opaque frames.

### 8.2 The host side

A facet has one of two **shapes**, declared in its capabilities and checked
at registration [D, revised 2026-09-25]:

- **exchange**: one signed HTTP-shaped request, one response, which may
  stream. This is the original facet, unchanged: `httpsExecute`,
  `lambdaExecute` and a private-invoke platform like the Acme Functions
  example implement `send()`.
- **session**: a long-lived duplex channel of opaque **frames**. Forward and
  brokered transports implement `open()`; a reversed transport, where the
  executor dials in, implements `listen()`.

In both, bun-jobs builds, signs, seals, sequences and verifies; the facet
moves bytes.

```ts
/** The execute facet, host side: carries remote attempts to the platform. Made by a provider's `execute(config, ctx)`. */
export interface ExecuteFacet {
  /** What the transport is and can do. Read by the core instead of knowing transports by name (§8.3). */
  readonly capabilities: TransportCapabilities;
  /**
   * Finds the endpoint, when the config names one rather than giving a URL:
   * look up a function URL, a service's address. Optional; called once and
   * again after a `misconfigured` error. Without it the config's `url` is used.
   */
  locate?: (context: ProviderCallContext) => Promise<ExecuteEndpoint>;
  /**
   * Exchange shape: sends one request and returns the platform's response.
   * Required when `capabilities.shape` is `"exchange"`, absent otherwise.
   *
   * `request` is complete and **already signed** by bun-jobs
   * (`worker-runtimes.md` §5.6): the body must reach the remote byte for
   * byte, and the listed `bun-jobs-*` headers unchanged. The facet may add
   * its own headers (a platform token) and may carry the bytes any way the
   * platform allows (an `Invoke` API call, a private network). The response
   * it returns, unary or a stream of frames, is verified by bun-jobs before
   * anything is settled, so the facet cannot change an outcome, only fail to
   * deliver one.
   *
   * Map platform failures to `ProviderError`; a non-2xx the *remote* answered
   * (401, 404, 429, 5xx) is returned as a `Response`, not thrown, so the
   * gateway applies `worker-runtimes.md` §5.5's rules to it.
   */
  send?: (request: Request, context: ExecuteCallContext) => Promise<Response>;
  /**
   * Session shape, `direction` `"forward"` or `"brokered"`: opens one duplex
   * session to the executor (or to the broker subject its executors serve).
   * The core calls it once per session it wants (`sessions` on the target)
   * and again to replace a lost one. Rejects with a `ProviderError`.
   */
  open?: (context: ExecuteOpenContext) => Promise<DuplexSession>;
  /**
   * Session shape, `direction` `"reverse"`: starts accepting connections that
   * executors dial in, and yields one session per connection until
   * `context.signal` aborts. The core authenticates each session's `hello`;
   * the facet only accepts the connection.
   */
  listen?: (context: ExecuteOpenContext) => AsyncIterable<DuplexSession>;
  /**
   * An optional platform-level check, such as a `GET /healthz` on the
   * executor or the platform's own status API, shown on the Workers page.
   * Never used to route work or to decide liveness, which the protocol's
   * heartbeat and canary do (`remote-transports.md` §5.5).
   */
  probe?: (context: ProviderCallContext) => Promise<PlatformProbe>;
  /**
   * The package entry of the matching runtime adapter or transport server,
   * e.g. `"@acme/bun-jobs-provider-acme/runtime"`, for the docs and the UI.
   * Informative only; the host never imports it.
   */
  readonly runtime?: string;
}

/**
 * What a transport declares. Replaces the earlier `ExecuteCapabilities`.
 * The core's reaction to each field is `remote-transports.md` §3.3.
 */
export interface TransportCapabilities {
  /** The binding it implements: `"http"`, `"http-stream"`, `"sse"`, `"ws"`, `"ws-reverse"`, `"tcp"`, `"udp"`, or a plugin's own id such as `"nats"`. Shown on the Workers page. */
  readonly binding: string;
  /** `"exchange"` (implements `send`) or `"session"` (implements `open` or `listen`). */
  readonly shape: "exchange" | "session";
  /** Who dials: the gateway (`"forward"`), the executor (`"reverse"`), or both reach a broker (`"brokered"`). */
  readonly direction: "forward" | "reverse" | "brokered";
  /** Whether the executor can send frames while an attempt runs. `false` for unary HTTP, which then has no in-attempt liveness. */
  readonly streaming: boolean;
  /** Whether the gateway can send frames mid-attempt on the same channel (cancel, ping) without a new exchange. */
  readonly duplex: boolean;
  /** Whether frames arrive in the order sent. `false`: the core reorders. */
  readonly ordered: boolean;
  /** Whether every frame arrives exactly once or the session fails. `false`: the core acknowledges, retransmits and windows. */
  readonly reliable: boolean;
  /** Whether the transport has flow control of its own. `false`: the core enforces its send window. */
  readonly flowControl: boolean;
  /** The largest frame it carries, in bytes. The core fragments above it (binary encoding only). */
  readonly maxFrameBytes: number;
  /** The largest message the core may send after reassembly, in bytes. Larger is refused before sending. */
  readonly maxMessageBytes: number;
  /** `"text"` (one UTF-8 line per frame: HTTP streams, SSE, WebSocket) or `"binary"` (TCP, UDP, most brokers). */
  readonly encoding: "text" | "binary";
  /**
   * Whether the transport gives the executor confidentiality and integrity
   * itself (TLS end to end, or a loopback or Unix socket). `false`: the core
   * seals every frame with AES-256-GCM. Declare `false` when in doubt.
   */
  readonly confidential: boolean;
  /** Whether `reconnect()` can reach the same executor, so a dropped session can resume rather than restart. */
  readonly resumable: boolean;
  /** The longest one attempt may take on this path, in ms. Reconciled with the handshake (§8.3). */
  readonly maxDurationMs: number;
  /** The most attempts in flight the platform allows, when known: a reserved-concurrency cap. */
  readonly maxConcurrency?: number;
  /** The shortest idle timeout the transport knows is on its path, in ms. The core keeps its keepalive below it. */
  readonly idleTimeoutMs?: number;
}

/** One live channel to one executor, for the session shape. Frames are opaque: the facet never parses, alters or re-encodes them. */
export interface DuplexSession {
  /** A secret-free label for logs and the UI: a peer address, a connection id, a broker subject. */
  readonly label: string;
  /**
   * Hands one frame to the transport. Resolves once the transport has taken
   * it into its bounded buffer. Rejects with `ProviderError` `"transient"`
   * when the session is gone and `"throttled"` when the buffer is full.
   * **Never drops a frame silently**: Bun's own sends do (a WebSocket server
   * `send()` returning `0`, a TCP `write()` returning a short count), and the
   * facet must turn that into a rejection or a queued remainder.
   */
  send: (frame: Uint8Array) => Promise<void>;
  /** Every frame the peer sends, each exactly as received, in arrival order. Ends when the session ends. */
  readonly frames: AsyncIterable<Uint8Array>;
  /** Settles once, when the session has ended, with why. */
  readonly closed: Promise<TransportClose>;
  /** Ends the session; with `graceful`, after flushing what is queued, bounded by the context's signal. */
  close: (options?: { graceful?: boolean; code?: number; reason?: string }) => Promise<void>;
  /** Bytes accepted by `send` and not yet handed to the network. The core stops sending above its high-water mark. */
  bufferedBytes: () => number;
  /** Opens a new connection to the same executor for a resume. Present when `capabilities.resumable`. */
  reconnect?: () => Promise<DuplexSession>;
}

/** Why a session ended. */
export interface TransportClose {
  /** Whether both sides closed deliberately, as opposed to a reset, a timeout or a lost peer. */
  clean: boolean;
  /** The transport's own code, when it has one: a WebSocket close code, an errno. */
  code?: number | string;
  /** A short, secret-free reason. */
  reason?: string;
}

/** Where to send, as `locate()` found it. */
export interface ExecuteEndpoint {
  /** The URL to reach, any scheme the transport understands (`https:`, `wss:`, `tcp+tls:`, `udp:`, a broker URL). `https:`/`wss:` unless the host is loopback. */
  url: string;
  /** A secret-free label for the UI, e.g. `"lambda:reports@eu-west-1"`. */
  label?: string;
}

/** What `send` receives beyond the common context. */
export interface ExecuteCallContext extends ProviderCallContext {
  /** Whether this is a job attempt (`RemoteWorker`) or a run (`RemoteRunner`). */
  readonly kind: "job" | "run";
  /** The endpoint from `locate()` or config. */
  readonly endpoint: ExecuteEndpoint;
  /** The operation: `"handshake"`, `"invoke"`, `"cancel"`, `"health"`, `"status"`, `"ping"`. For logs and routing only. */
  readonly op: string;
}

/** What `open` and `listen` receive beyond the common context. */
export interface ExecuteOpenContext extends ProviderCallContext {
  /** Whether sessions carry job attempts or runs. */
  readonly kind: "job" | "run";
  /** The endpoint to dial, or for `listen` the address to listen on. */
  readonly endpoint: ExecuteEndpoint;
  /** TLS from the target's options (`remote-transports.md` §8.2): what to trust when dialling, or the certificate to serve when listening. Never the signing secret. */
  readonly tls?: RemoteTlsOptions | NonNullable<RemoteListenOptions["tls"]>;
}

/** What `probe()` reports. */
export interface PlatformProbe {
  /** Whether the platform considers the executor healthy. */
  ok: boolean;
  /** The HTTP status or platform state it read, for display. */
  detail?: string;
  /** How long the probe took, in ms. */
  latencyMs?: number;
}
```

`RemoteTlsOptions` and `RemoteListenOptions` are the target's types
(`remote-transports.md` §8.2); `./provider` re-exports them, so a plugin's
declarations need nothing else (the rule of §11.1).

**Registration check** [D]: `shape: "exchange"` requires `send` and forbids
`open`/`listen`; `shape: "session"` requires `open` for `forward` and
`brokered`, and `listen` for `reverse`. Anything else is a `ConfigError`
naming the member. The conformance kit checks the capabilities themselves
against fault-injecting fakes (§12.3).

**A helper for exchange-shaped platforms** [D]: `./provider` also exports
`exchangeTransport({ send, capabilities })`, which fills the common fields,
so an author of a request/response platform writes `send()` and the limits,
exactly as before this revision.

**First-party transports are written on this API**, under §5's rule:
`httpsExecute` (exchange: `http`, `http-stream`, and SSE re-attachment),
`wsExecute` and `wsListen`, `tcpExecute` and `tcpListen`, `udpExecute`
(session). They import only `./provider` and Bun or Web APIs — `fetch`,
`WebSocket`, `Bun.connect`, `Bun.listen`, `Bun.serve`, `Bun.udpSocket`,
`Bun.dns.lookup` — so the first-party import test covers them and no npm
transport library enters the package.

**The secret stays in the core** [D]. `RemoteEndpointTarget.secret`
(`worker-runtimes.md` §4.2) moves to the remote target's options, beside the
provider, not into the provider's config. An exchange facet is handed a
signed `Request`, a session facet already-authenticated (and, where it
declared `confidential: false`, sealed) frames; neither is ever handed the
key. §13 says what this does and does not protect.

**How a user writes it** [D]:

```ts
import { lambdaExecute } from "@kingsleyweb/bun-jobs/providers/aws";

const worker = jobs.remoteWorker("reports", {
  provider: lambdaExecute({ region: "eu-west-1", functionName: "reports" }),
  secret: process.env.BUN_JOBS_SECRET!,
  maxInFlight: 10,
});
```

A plain `{ kind: "endpoint", url, secret }` target (`worker-runtimes.md`
§4.2) is shorthand for a built-in provider chosen by the URL's scheme:
`httpsExecute` for `https:`, `wsExecute` for `wss:`, `tcpExecute` for
`tcp+tls:`, `tcp:` and `unix:`, `udpExecute` for `udp:`, and `wsListen` or
`tcpListen` for a `listen:` address (`remote-transports.md` §8.1). Each is
itself written against this API [D]. A session transport from a plugin:

```ts
import { natsExecute } from "@acme/bun-jobs-provider-nats";

const worker = jobs.remoteWorker("etl", {
  provider: natsExecute({ servers: ["nats://nats.internal:4222"] }),
  secret: process.env.BUN_JOBS_SECRET!,
  heartbeat: { keepaliveMs: 10_000 },
});
```

### 8.3 Capability reconciliation

The gateway has two sources of limits: the transport's `capabilities` and the
remote's handshake (`maxDurationMs`, `maxBodyBytes`, `features`). It uses the
**smaller of each**, and logs one `warn` per endpoint when they disagree by
more than 10% [D]. For example, a Lambda runtime adapter advertises 14 minutes
while the transport declares Function URL limits. That is a runtime check of
capability truthfulness, cheap and continuous, beside the kit's one-off
check (§12).

`streaming: false` on the transport means the gateway does not ask for a
streamed response (`accept: text/event-stream` or `application/x-ndjson`),
whatever the remote advertises, and the endpoint has no in-attempt liveness:
the Workers page shows it `degraded` with that reason [D].

The session capabilities are reconciled the same way (revised 2026-09-25):
`maxMessageBytes` against the remote's `welcome.maxMessageBytes`, the smaller
wins; the keepalive is clamped below `idleTimeoutMs`; and a transport that
declared `reliable: true` but delivers a gap in the sequence numbers, or
`ordered: true` but reorders, has its session closed and the discrepancy
logged once per endpoint as a provider bug, the way an unmapped throw is
(§6.5) [D]. The canary's buffering probe (`remote-transports.md` §5.7) is the
continuous check of `streaming` on a path whose proxies may buffer.

### 8.4 The platform side: the runtime adapter kit

`worker-runtimes.md` §6.1 already has the shape: one framework-agnostic
`createRemoteExecutor()` returning `(Request) => Promise<Response>`, and thin
per-platform wrappers. The kit makes the wrappers something a third party can
write the same way [D], from `./remote` (browser-safe):

```ts
/** The runtime-adapter helper API version, `"major.minor"`. Independent of the wire protocol's. */
export const RUNTIME_ADAPTER_API: "0.1";

/**
 * Turns a platform's native invocation into the protocol's `Request → Response`
 * core, and back. `TArgs` is what the platform calls the handler with.
 */
export interface RuntimeAdapterDefinition<TArgs extends unknown[], TResult, TEnv = unknown> {
  /** The adapter's name, e.g. `"@acme/bun-jobs-provider-acme/runtime"`. Reported in the handshake's `runtime`. */
  readonly name: string;
  /** Its version, semver. Reported in the handshake's `sdk`. */
  readonly version: string;
  /** The `RUNTIME_ADAPTER_API` version it was written against. */
  readonly apiVersion: string;
  /**
   * Builds a standard `Request` from the platform's arguments. Must hand over
   * the **raw body bytes** unchanged: the signature is over them
   * (`worker-runtimes.md` §5.6). When the platform gives only a parsed body,
   * return `{ request, bodyWasParsed: true }` and the core falls back to JCS.
   */
  readonly toRequest: (...args: TArgs) => Request | { request: Request; bodyWasParsed: true };
  /** Turns the core's `Response` into what the platform expects back (a Lambda result object, say). */
  readonly fromResponse: (response: Response, ...args: TArgs) => TResult | Promise<TResult>;
  /** Reads per-invocation environment (a Cloudflare `env`), for options given as functions of it. */
  readonly env?: (...args: TArgs) => TEnv;
  /**
   * Hands a promise to the platform to keep the invocation alive after the
   * response, where it can (`ctx.waitUntil`). Optional.
   */
  readonly waitUntil?: (promise: Promise<unknown>, ...args: TArgs) => void;
  /** The platform's real ceiling on one invocation, in ms, when fixed. The handshake never advertises more. */
  readonly maxDurationMs?: number;
  /** The platform's real request-body ceiling, in bytes, when fixed. */
  readonly maxBodyBytes?: number;
}

/**
 * Makes an adapter factory: call it with `createRemoteExecutor`'s options
 * (each may be a function of `TEnv`) to get the platform's handler.
 */
export function defineRuntimeAdapter<TArgs extends unknown[], TResult, TEnv = unknown>(
  definition: RuntimeAdapterDefinition<TArgs, TResult, TEnv>,
): (options: RemoteExecutorOptions<TEnv>) => (...args: TArgs) => Promise<TResult>;
```

The first-party `createCloudflareHandler`, `createLambdaHandler` and
`createAzureHandler` (`worker-runtimes.md` §6.4) are built with it [D], under
§5's rule. A runtime adapter imports only `./remote`, so the bundle-safety
test of `worker-runtimes.md` §6.3 covers every adapter, first-party or not,
that a user builds with `Bun.build --target browser` [I].

**What a runtime adapter is not:** a facet of the provider object (§4.2), or
anything that sees the gateway's driver, lease or config. Its whole contract
is the wire protocol plus this helper type.

**Per-transport servers and the executor session** (added 2026-09-25,
`remote-transports.md` §9). `defineRuntimeAdapter` serves the exchange shape
on FaaS. For the session bindings the kit adds two things [D]:

- **`createRemoteExecutor()` returns a `RemoteExecutor`**, still callable as
  the fetch handler, which also runs the protocol over any session transport
  through `acceptSession(io)`. It stays in `./remote` and browser-safe. A
  third-party runtime transport (a broker client in a plugin's `./runtime`)
  provides the `io`:

  ```ts
  /** The executor side of a session transport: what a runtime transport hands `RemoteExecutor.acceptSession`. */
  export interface ExecutorSessionIO {
    /** The transport's declaration: the executor-side subset of `TransportCapabilities`. */
    readonly capabilities: Pick<TransportCapabilities,
      "binding" | "encoding" | "ordered" | "reliable" | "flowControl" | "maxFrameBytes" | "maxMessageBytes" | "confidential">;
    /** A secret-free label for the executor's logs: the peer, the subject. */
    readonly label: string;
    /** Sends one frame. Rejects rather than dropping when the channel is gone or its buffer is full. */
    send: (frame: Uint8Array) => Promise<void>;
    /** Frames from the gateway, exactly as received. Ends when the channel ends. */
    readonly frames: AsyncIterable<Uint8Array>;
    /** Ends the channel. */
    close: (options?: { code?: number; reason?: string }) => Promise<void>;
  }
  ```

- **A Bun-only entry, `./remote/serve`**, with one server per first-party
  binding: `serveHttp`, `serveWebSocket`, `serveTcp`, `serveUdp`, and the
  reversed `dialWebSocket` and `dialTcp`. Each handles the Bun behaviour its
  binding must (the header flush, `send()` returning `0`, unbuffered TCP
  writes, UDP's missing flow control and `undefined` ICMP errors;
  [`bun-transports.md`](evidence/remote-transports/bun-transports.md)) and
  serves `GET /healthz` and `/readyz` for the platform's probes. They are
  built on `acceptSession` exactly as a third party's would be, so the
  first-party import test (§5) extends to `lib/remote/serve/`, allowing
  `../index.ts` and Bun built-ins. Not browser-safe, so not `"browser":
  true` in `consumer-check.json`.

### 8.5 `RemoteWorker`, `RemoteRunner` and the escape hatch

- **`RemoteWorker`** (`worker-runtimes.md` §11, Phase 2): `jobs.remoteWorker(queue,
  { provider, secret, … })`. `provider` is a configured provider with an
  execute facet; a bare `url` or `listen` is shorthand for the first-party
  provider its scheme names (§8.2) [D].
- **`RemoteRunner`**: the same, with `kind = "run"` in the call or open
  context and the `run` envelope Phase 2 must specify first [D there].
- **`WorkerTargetFactory`** (§4.2 there) stays the low-level hook, now for
  a transport that should not use the protocol at all. **Revised 2026-09-25:**
  gRPC streams and message buses, which this bullet used to send here, are
  now session-shape execute facets (§8.2), and so get the core's signing,
  sealing, reliability layer, health and breaker instead of none of them
  (`remote-transports.md` §7.10, §7.12). It returns a `WorkerTargetExecutor`
  (`lib/queue/workerTarget.ts:209-235` at `e11cc8c`) [S].

---

## 9. Registration and discovery

### 9.1 The options

| Option | How | For | Against |
|---|---|---|---|
| **A. Explicit import and pass-in** | `import { acme } from "@acme/bun-jobs-provider-acme"`; `summoner: acme({ … })` | Nothing happens that the code does not say. Types flow from the import. It is how `driver`, `logger` and `validate()` schemas are passed today (§2) | A config file cannot name a provider as a string |
| B. Name lookup in a registry | `registerProvider(acme)` once; `summoner: { provider: "acme", config }` | Config can be data (JSON, env) | A global mutable registry; import-order bugs; types lost at the string |
| C. Auto-discovery from `node_modules` | scan for `keywords: ["bun-jobs-provider"]` | Zero wiring | Any installed package can become code that holds cloud credentials; slow start; breaks under bundling and isolated linkers [I] |

### 9.2 Recommendation: A, and nothing else [D]

**A** is the default and the only mechanism in 1.5p. **C is rejected**, for
the supply-chain reason alone. **B is deferred** until a caller needs a
provider *as data*. The one plausible caller is a spawned child that must
rebuild a provider, as `createDriver` rebuilds a driver from a config
(§2.1). Nothing in either plan spawns a child that summons or executes: the
controller and the gateway live in the process that owns them, and a
scheduled one-shot check imports its provider like any other module
(`summon-compute.md` §3.3). Recorded as Q-P3.

### 9.3 Two providers with the same name

Names are npm package names (plus an optional `:variant`), so a collision
means the same package twice [I]. bun-jobs keeps a per-process map from
`name` to the definitions it has seen [D]:

| Seen before | Action |
|---|---|
| never | record it |
| the same `name` and `version` (a duplicated install, two copies of one module) | treat as the same provider; nothing to report |
| the same `name`, a different `version` | one `warn` naming both versions. Both work. The status route and the UI show `name@version`, never the bare name |
| a different `name` with the same `kind` | fine. `kind` is a label, not an identity. The marker records `kind` for display (`summon-compute.md` §4.3) and the status route adds `name` |

Refusing a second version would break a monorepo in which two services
legitimately pin different versions [I]. Terraform's answer to its own
collision, a compound local name [W], is what `name@version` in the UI is.

---

## 10. Versioning and compatibility

### 10.1 What is versioned

| Thing | Version | Who moves it |
|---|---|---|
| the core (identity, config, errors, contexts, `./provider/auth`) | `COMPUTE_PROVIDER_API.core` | bun-jobs |
| the summon facet | `COMPUTE_PROVIDER_API.summon` | bun-jobs |
| the execute facet, host side | `COMPUTE_PROVIDER_API.execute` | bun-jobs |
| the runtime-adapter helper type | `RUNTIME_ADAPTER_API` | bun-jobs |
| the wire protocol | `WORKER_PROTOCOL_VERSION` + per-feature strings (`worker-runtimes.md` §5.4) | bun-jobs, negotiated per endpoint |
| a plugin | its own semver | the plugin author |
| bun-jobs | its semver (2.2.0 today, `package.json:4`) [S] | bun-jobs |

The plugin API versions are **independent of the package's semver** [D]. A
bun-jobs minor may add a facet minor; a facet major moves only with a
bun-jobs major.

### 10.2 The check at registration

When a provider is configured, for the core and for each facet it implements
[D]:

| Plugin's `major.minor` vs host's | Result |
|---|---|
| same major, same minor | fine |
| same major, **plugin minor lower** | fine. The host feature-detects optional hooks, as drivers are feature-detected today (§2.1) |
| same major, **plugin minor higher** (plugin newer than host) | fine, one `warn`: "written for summon 1.3; this bun-jobs speaks 1.2; members added in 1.3 are ignored". `ctx.api.summon` is `"1.2"`, so the plugin can degrade |
| **different major** | `ConfigError` naming the facet, both versions and the direction: "upgrade bun-jobs to ≥ x" or "upgrade the provider" |
| a facet function present but its version absent, or the reverse | `ConfigError`: a provider must say what it was written against |
| host supports majors N and N−1 for a facet (the deprecation window, §10.3) and the plugin is on N−1 | fine, one `warn` per process with the removal version |

This is Nomad's arrangement: the plugin lists what it supports, and the host
hands back what it negotiated [W]. Here the plugin lists one version per facet
rather than a set, because a TypeScript object can only have been written
against one shape [I].

### 10.3 Promises bun-jobs makes, and deprecation

From 1.0 of a facet [D]:

- **Minors are additive.** A new optional hook, a new optional capability
  field, a new union member a plugin *returns* never breaks an existing
  plugin. A new union member bun-jobs *passes in* (a new `SummonReason`, say)
  is a major, because a plugin's exhaustive `switch` would break [I].
- **A major is supported for one full bun-jobs major after its successor
  ships.** bun-jobs N+1 speaks facet majors k and k+1; N+2 drops k.
- **Deprecation is announced in three places**: the `warn` at registration,
  the kit's report ("uses deprecated member X; removed in facet 2.0"), and the
  changelog.
- **Before 1.0 (`0.x`) there is no promise.** Any `0.x` minor may break.
  Registration warns once that the facet is experimental.

### 10.4 The stability gate

| Facet | `0.x` until | Then |
|---|---|---|
| core | both facet gates below; plus Q2 (SigV4 path encoding) and Q15 (the token helper against real endpoints) from `summon-compute.md` §12 closed, because `./provider/auth` joins the core | `1.0` |
| summon | **all six first-party summoners** (ECS + Lambda, Fly, Cloud Run jobs and pools, ACA, Render, SSH) **and one provider written outside the bun-jobs session** pass the kit, covering all three styles (`launch`, `scale`: Cloud Run pools, `wake`: Fly) and all three `passes` values (`env`: ECS, `argv`: Render, `none`: Fly and ACA) | `1.0` |
| execute | the Cloudflare, Lambda and generic HTTP runtime adapters, `httpsExecute` and `lambdaExecute`, **and one outside provider** pass both kits; since 2026-09-25 also the first-party session transports that have shipped, and **one session-shape transport written outside the bun-jobs session** (§16.3) | `1.0` |

"Written outside the bun-jobs session" means the examples session's custom
provider (§15.5) at minimum, and preferably a real third party [D]. The point
of that condition: an API proven only by its designers is proven against their
assumptions [I].

### 10.5 Version skew between a plugin's two halves

A provider package's host entry and `./runtime` entry are deployed separately:
one with the app, one on the platform. They can drift [I]. They share no
in-process API, only the wire protocol, and the protocol already negotiates
(`worker-runtimes.md` §5.4: the gateway picks the highest version both
speak). So skew between them is the protocol's problem, already handled, and
not the plugin API's [I]. The provider's `describe()` should include the
runtime package it expects, so the UI can show both [D].

---

## 11. Packaging

### 11.1 What bun-jobs exports

| Entry | File | Holds | Browser |
|---|---|---|---|
| `./provider` | `lib/provider/index.ts` | `defineComputeProvider`, `ProviderError`, `COMPUTE_PROVIDER_API`, every type in §6–§8, plus re-exports (below) | no |
| `./provider/auth` | `lib/provider/auth/index.ts` | §6.4's helpers | no |
| `./provider/testing` | `lib/provider/testing/index.ts` | `runProviderConformance`, `runExecuteConformance`, fake-platform helpers (§12) | no |
| `./providers/aws`, `/google`, `/azure`, `/fly`, `/render`, `/ssh`, `/https`, `/ws`, `/tcp`, `/udp` | `lib/providers/<name>.ts` | first-party providers; `/https`, `/ws`, `/tcp` and `/udp` are the first-party transports (`httpsExecute`, `wsExecute`/`wsListen`, `tcpExecute`/`tcpListen`, `udpExecute`; `remote-transports.md` §8.1) | no |
| `./summon` | `lib/summon/index.ts` | `SummonController`, `runSummoned`, `defineSummoner`, … (`summon-compute.md` §8.4) | no |
| `./remote` | `lib/remote/index.ts` | protocol core (messages, frame codecs, signing and sealing, the reliability layer, health), `createRemoteExecutor`, `defineRuntimeAdapter`, `RUNTIME_ADAPTER_API` | **yes** |
| `./remote/serve` | `lib/remote/serve/index.ts` | per-transport executor servers: `serveHttp`, `serveWebSocket`, `serveTcp`, `serveUdp`, `dialWebSocket`, `dialTcp` (§8.4) | no (Bun only) |
| `./remote/testing` | `lib/remote/testing/index.ts` | `conformRemoteExecutor` (every binding), `runRuntimeAdapterConformance`, and the fakes `bufferingHttpProxy`, `idleCuttingProxy`, `tcpChunker`, `lossyUdpProxy`, `lossySession`, `spawnExecutor` | no |
| `./adapters/cloudflare`, `/lambda`, `/azure`, `/http` | `lib/remote/adapters/<name>.ts` | first-party runtime adapters | **yes** |

**A change to `summon-compute.md` §8.4.** Its `./summon/{aws,google,…}`
subpaths become `./providers/{aws,google,…}` [D]. A provider now may carry
both facets (AWS: `ecsRunTask` and `lambdaInvoke` to summon, `lambdaExecute`
to carry attempts), so the subpath names the provider, not the feature. The
packages are unpublished, so the rename is free.

**Directory keys.** `lib/provider/`, `lib/provider/auth/`,
`lib/provider/testing/`, `lib/remote/testing/` and `lib/remote/serve/` each have an `index.ts`, so
each needs its `./lib/…` key too; the packaging test demands one for every
directory with an index (`__tests__/packaging.test.ts:46-56`) [S]. Providers
and adapters are files, so their `./lib/*` spellings are covered by the
existing patterns (`summon-compute.md` §8.4).

**Re-exports that a plugin's declarations need** [D]. A plugin's `.d.ts`
names these types. `CLAUDE.md`'s rule is that a declaration must not import
an undeclared package, and the busboy precedent is to re-export third-party
types that appear in the public surface. So `./provider` re-exports:

- `StandardSchemaV1` (bun-common's vendored type, `bun-common/lib/index.ts:340`
  [S]);
- `Logger`, `LoggerLike`, `LogLevel` (bun-common);
- `JobsError`, `ConfigError` (bun-jobs' own).

A plugin then imports types from `@kingsleyweb/bun-jobs/provider` alone and
never needs `@kingsleyweb/bun-common` in its own `dependencies` [I].
`./provider/testing` is the exception that must be watched: if it re-used the
tests' `bun:test` it would import a runtime-only module into the
declarations, so the kit returns reports and never imports `bun:test` (§12.1).

**`consumer-check.json`** gains [D]:

```jsonc
{ "spelling": "@kingsleyweb/bun-jobs/provider",
  "values": ["defineComputeProvider", "ProviderError", "COMPUTE_PROVIDER_API"],
  "types": ["ComputeProvider", "ComputeProviderDefinition", "ConfiguredProvider", "SummonFacet",
            "SummonCapabilities", "ExecuteFacet", "TransportCapabilities", "DuplexSession", "ExecuteOpenContext", "ProviderCallContext", "StandardSchemaV1"],
  "snippet": "const p = m.defineComputeProvider({ name: \"x\", version: \"1.0.0\", kind: \"x\", apiVersion: { core: \"0.1\", summon: \"0.1\" }, summon: () => ({ capabilities: { style: \"launch\", dedupe: { kind: \"none\" }, passes: \"env\", bootBudgetMs: 1, shutdown: { signal: \"SIGTERM\", graceMs: 1 }, maxLifetimeMs: null, enforcesLifetime: false }, summon: async () => ({ status: \"started\", handles: [] }) }) });\nexport type _p = Expect<IsAny<typeof p>>;" },
{ "spelling": "@kingsleyweb/bun-jobs/provider/auth",    "values": ["signAwsRequest", "resolveAwsCredentials", "getGoogleToken", "getAzureToken"] },
{ "spelling": "@kingsleyweb/bun-jobs/provider/testing", "values": ["runProviderConformance", "runExecuteConformance", "fakePlatform"] },
{ "spelling": "@kingsleyweb/bun-jobs/remote/testing",   "values": ["conformRemoteExecutor", "runRuntimeAdapterConformance", "lossyUdpProxy", "lossySession"] },
{ "spelling": "@kingsleyweb/bun-jobs/remote/serve",     "values": ["serveHttp", "serveWebSocket", "serveTcp", "serveUdp", "dialWebSocket", "dialTcp"] },
{ "spelling": "@kingsleyweb/bun-jobs/providers/ws",     "values": ["wsExecute", "wsListen"] },
{ "spelling": "@kingsleyweb/bun-jobs/providers/tcp",    "values": ["tcpExecute", "tcpListen"] },
{ "spelling": "@kingsleyweb/bun-jobs/providers/udp",    "values": ["udpExecute"] }
```

The snippet is the existing `snippet` mechanism of `consumer-check.json` [S],
used to prove a plugin can be written against the packed tarball with no
`any` leaking. `./remote` and `./adapters/*` keep `worker-runtimes.md` §6.3's
`"browser": true` entries, with `defineRuntimeAdapter` and
`RUNTIME_ADAPTER_API` added to `./remote`'s values. **None lists `"peers"`**,
and **`checkPeerScopes` has nothing to check**, because no entry imports an
optional peer [I, per `summon-compute.md` §8.3].

### 11.2 What a third-party plugin package looks like

**Name** [D]: `bun-jobs-provider-<platform>`, or
`@<scope>/bun-jobs-provider-<platform>`. The Vite and Rollup precedent [W]:
a fixed prefix is what makes a plugin findable.

**Keywords** [D]: always `bun-jobs-provider`; plus `bun-jobs-provider-summon`
and/or `bun-jobs-provider-execute` per facet; plus
`bun-jobs-runtime-adapter` when it has a `./runtime`. Vite asks for the same
of its plugins [W].

**`package.json`** [D]:

```jsonc
{
  "name": "@acme/bun-jobs-provider-acme",
  "version": "1.0.0",
  "type": "module",
  "keywords": ["bun-jobs-provider", "bun-jobs-provider-summon", "bun-jobs-provider-execute", "bun-jobs-runtime-adapter"],
  "exports": {
    ".":        { "types": "./dist/index.d.ts",   "default": "./dist/index.js" },
    "./runtime": { "types": "./dist/runtime.d.ts", "default": "./dist/runtime.js" },
    "./package.json": "./package.json"
  },
  "peerDependencies": {
    // While the facets are 0.x: one bun-jobs minor. After 1.0: the major.
    "@kingsleyweb/bun-jobs": ">=2.3.0 <2.4.0"
  },
  "devDependencies": { "@kingsleyweb/bun-jobs": "2.3.x", "typescript": "^6.0.0" },
  "bun-jobs": { "facets": ["summon", "execute"], "apiVersion": { "core": "0.1", "summon": "0.1", "execute": "0.1" } }
}
```

- **The peer is not optional.** The plugin cannot work without bun-jobs.
- **The narrow range while experimental is deliberate.** A package manager
  warns on an unmet peer at install, before the registration check at run
  time. That is two signals where one would be easy to miss [I].
- **The `"bun-jobs"` field** repeats the declared versions as data, so a tool
  (or a search page) can read compatibility without executing code, as
  Terraform's registry reads `protocol_versions` from a manifest [W]. Nothing
  in bun-jobs reads it at run time; the object's `apiVersion` is the
  authority [D].
- **A third party ships built JavaScript**, not `.ts`. bun-jobs ships `.ts`
  because Bun runs it; a plugin's `./runtime` must run on Node, workerd or
  Deno [I]. The template builds with `Bun.build` and `tsc
  --emitDeclarationOnly`.
- **Its declarations import only `@kingsleyweb/bun-jobs/provider`** (and
  `/remote` for `./runtime`). The template's own check (§11.3) holds it to
  that.

### 11.3 The starter template

`templates/compute-provider/` at the repo root: an unpublished directory with
its own `package.json` and lockfile, outside `workspaces`, typechecked by
`scripts/typecheck.ts` and linted from its directory, exactly as
`packages/bun-jobs/bench/` is (`CLAUDE.md`) [D]. Layout:

```
templates/compute-provider/
├── package.json            # §11.2, name "bun-jobs-provider-example"
├── tsconfig.json           # strict, bundler resolution, no customConditions
├── README.md               # the author guide's quick start, as a checklist
├── src/
│   ├── index.ts            # defineComputeProvider: config schema, both facets
│   ├── config.ts           # the Standard Schema (bun-jobs' `toStandardSchema`, no library)
│   ├── errors.ts           # platform error → ProviderError, one table
│   └── runtime.ts          # defineRuntimeAdapter for the example platform
├── test/
│   ├── fake-platform.ts    # a Bun.serve fake of the example platform's API
│   ├── conformance.test.ts # runProviderConformance + runExecuteConformance, green
│   └── runtime.test.ts     # runRuntimeAdapterConformance + conformRemoteExecutor, green
└── scripts/
    ├── build.ts            # Bun.build to dist/, tsc declarations
    └── check-types.ts      # packs, installs outside, tsc under bundler and node16, skipLibCheck off
```

`scripts/check-types.ts` is a small consumer check for the plugin: it proves
the plugin's declarations resolve with only bun-jobs installed. It is
deliberately smaller than the repo's `consumer-check.ts` [D].

Whether `bun create` can start a project from a directory in a monorepo is
[U]. The author guide says "copy the directory" until that is checked.

The template is part of the repo's gate: its tests run in the bun-jobs
package's gate, so an API change that breaks the template fails the merge
[D].

---

## 12. Conformance kits

### 12.1 Shape

Three runners, all returning a `ConformanceReport` and importing no test
framework [D]:

```ts
/** One check's outcome. */
export interface ConformanceCheck {
  /** A stable id, e.g. `"summon.dedupe.same-key-one-unit"`, so reports can be diffed. */
  id: string;
  /** `"must"` checks fail the report; `"should"` checks warn. */
  level: "must" | "should";
  /** What happened. `"skip"` when a declared capability makes it inapplicable. */
  status: "pass" | "fail" | "warn" | "skip";
  /** What was expected and what was seen, secret-free. */
  detail?: string;
}

/** A kit run. Printable as a checklist, serialisable for a PR. */
export interface ConformanceReport {
  /** The provider or adapter, as `name@version`. */
  subject: string;
  /** The API versions it declared, and the host's. */
  apiVersion: { declared: ProviderApiVersions; host: ProviderApiVersions };
  /** Every check, in a fixed order. */
  checks: readonly ConformanceCheck[];
  /** `true` when no `must` check failed. */
  ok: boolean;
  /** Renders the report as a Markdown checklist. */
  toMarkdown: () => string;
}

/** Throws with the rendered report when `report.ok` is false. For any test runner. */
export function assertConformance(report: ConformanceReport): void;
```

Framework-agnostic, because a plugin's author may use `bun test`, vitest or
node:test. A one-liner in any of them: `test("conforms", async () =>
assertConformance(await runProviderConformance(…)))` [D].

### 12.2 The summon kit

```ts
/** Runs the summon facet (and the core) of a provider against a fake of its platform. */
export function runProviderConformance<TInput>(options: {
  /** The provider under test: a `ComputeProvider`, or a `Summoner` from `defineSummoner`. */
  provider: ComputeProvider<TInput> | Summoner;
  /** A config pointing at the fake: its URL, test credentials. Ignored for a `Summoner`. */
  config?: TInput;
  /** Configs the schema must reject, each with the path it should name. */
  invalidConfigs?: readonly { config: unknown; path: string }[];
  /** The fake platform (§12.4). */
  platform: FakePlatform;
  /** Checks to skip, each with a reason printed in the report. */
  skip?: readonly { id: string; reason: string }[];
}): Promise<ConformanceReport>;
```

The checks, grouped [D]:

| Group | What it drives | Must / should |
|---|---|---|
| identity | `name`, `version` (semver), `kind` shape; `apiVersion` present for every facet present and parseable; the brand | must |
| config | `config` accepts the given config and rejects each `invalidConfigs` entry with an issue at its `path`; a missing schema is a `warn` | must / should |
| secrets | the kit seeds every declared `secrets` path with a canary value, runs every other check, and scans everything bun-jobs would write — `describe()`, every log line through `ctx.logger`, every `ProviderError` message and `cause`, every `SummonResult.reason` — for the canary | must |
| capabilities | the declaration is well-formed; `scale` has `release`; `wake` has `poolSize`; `dedupe.charset` compiles | must |
| routing | every platform call goes through `ctx.fetch` (the fake counts calls that did; the provider is given a config whose host is unreachable except through `ctx.fetch`) | must |
| purity | `summon` twice with one request: byte-identical platform requests (method, URL, body, headers minus the date and signature headers the platform requires to vary) | must when `dedupe.strict`, should otherwise |
| dedupe | with `dedupe.kind: "token"`: the token sent equals `request.dedupeKey`, within `maxLength` and `charset`, for a request id generated at the maximum length with every allowed character. The fake must then answer the second call as the platform would (§12.4) and the provider must return `deduped` | must |
| concurrency | 16 concurrent `summon`s with distinct ids: 16 units, no crash, no shared mutable state corrupted; 8 concurrent with one id on a `token` platform: one unit, the rest `deduped` | must |
| errors | for each fault the fake can inject — `transient`, `throttled` (with a retry-after), `quota`, `auth`, `misconfigured`, `conflict`, `capacity-200` — the provider throws `ProviderError` of the right kind, or returns `unavailable` for `capacity-200`; `throttled` carries `retryAfterMs`; no raw `Error` escapes | must |
| timeouts | the fake delays past the call's timeout: the provider rejects within 1 s of `ctx.signal` aborting and leaves no timer behind | must |
| handoff | **end to end**: the kit runs a real `SummonController` on a shared SQLite or file driver; the fake "starts" a unit by calling the kit's `startUnit({ env, argv })`, which spawns the kit's fixture worker under `runSummoned`; the marker releases the attempt by id (`passes: "env"`/`"argv"`) or by start time (`"none"`) | must |
| the CAS | two controllers in two processes race on one backlog: one `summon` call reaches the fake | must |
| scale | `summon` with `target` twice leaves one count; `release({ target: 0 })` sets zero | must for `scale` |
| status / cancel | when present: handles from `summon` are known to `status`; `cancel` moves a pending unit to `exited`/`unknown` | must when present |
| lifetime | with `enforcesLifetime`, the platform request carries `request.maxLifetimeMs` mapped to the platform's field | must when declared |
| describe | answers, values are strings, no key matches `/token|secret|key|password/i` | should |
| validate | when present: passes against the healthy fake, fails with `auth` injected, starts no unit | must when present |

The handoff and CAS checks reuse `summon-compute.md` §11.1's tier-1 fake
platform and fixture worker, moved from `__tests__/helpers/summon.ts` into
`lib/provider/testing/` so they ship [D]. **Sequencing, from the 2026-09-25
reconciliation:** that harness is built by PR-3 and finished by PR-4
(`summon-compute.md` §13.4–§13.5), and PR-4 waits for issue #166 (a
`"child-process"` attempt orphaned by `close()`), so the kit's handoff check
cannot be written before both. Its fixture worker should not use a file
target until #166 is merged, or a failed handoff check can leave an orphaned
child on the author's machine.

### 12.3 The execute kits

**Host side**: `runExecuteConformance({ provider, config, platform })` [D].
The fake platform forwards to a real `createRemoteExecutor()` with an echo
handler.

| Group | Checks |
|---|---|
| bytes | the body and the `bun-jobs-*` headers reach the remote unchanged: the remote's signature check passes for bodies with non-ASCII, `\r\n` and a 1-byte-under-limit size |
| response | the response bytes reach the gateway unchanged: its verification passes; a tampered response (the fake flips a byte) fails verification and is not settled |
| statuses | the remote's 401, 404, 429 and 503 come back as `Response`s, not throws; platform failures (the fake's own 403, throttle, missing function) come back as `ProviderError`s of the right kind |
| limits | a message above `maxMessageBytes` is refused by the gateway before `send`; a call past `maxDurationMs` is aborted and the facet honours the signal |
| streaming | with `streaming: true`, streamed frames (SSE-framed by default, NDJSON accepted) arrive before the response ends (the fake writes a frame, waits, writes the terminal frame) |
| concurrency | `maxConcurrency` in-flight calls succeed; the gateway never exceeds it |
| locate | when present, the URL it returns is the one used, and a `misconfigured` error triggers one re-locate |
| truthfulness | the declared limits are at or below the fake's configured real limits (the fake is told the platform's limits; §12.5 says why that is weak) |
| shape | (added 2026-09-25) the member matching `shape` and `direction` is present and no other; `exchangeTransport` fills the rest |
| frames (session) | frames reach the peer byte for byte, including a frame at exactly `maxFrameBytes`; `frames` yields them exactly as sent |
| never drops (session) | with the peer paused, `send()` either resolves (queued within the bound) or rejects; the fake counts every frame, and none is missing once the peer resumes. This is the check that catches a WebSocket server `send()` returning `0` or a short TCP `write()` being ignored (`bun-transports.md` §3.6, §4.3) |
| declared reliability (session) | through the fault-injecting fakes of `remote-transports.md` §10.2: a transport declaring `reliable: true` surfaces a mid-frame reset as a closed session and never delivers a truncated frame; one declaring `ordered: true` does not reorder under the chunker; one declaring `reliable: false` is exercised under seeded loss and the core's reliability layer completes every job exactly once |
| confidentiality claim | a transport declaring `confidential: true` is TLS end to end or loopback/Unix; otherwise the kit reports a `must` failure, because the core would then skip sealing |
| backpressure | `bufferedBytes()` rises while the peer is paused and falls after `drain`; above the core's high-water mark the core stops sending |
| resume (session) | with `resumable: true`, `reconnect()` reaches the same executor and the core's resume replays with no gap and no duplicate |
| listen (reverse) | executors dialling in yield sessions; a `hello` under the wrong key is closed before any invoke; abort stops the listener |

**Platform side**: two runners.

- `conformRemoteExecutor({ url, secret, echoName })` is `worker-runtimes.md`
  §7.1 unchanged. It is black-box over HTTP, so a third party runs it against
  `wrangler dev`, a local container or a deployed function [D there].
- `runRuntimeAdapterConformance({ adapter, events })` is new [D]. The author
  supplies sample platform invocations (`events`: an API Gateway v2 event, a
  Cloudflare `Request` with an `env`), and the kit checks the mapping without
  a platform: raw body preserved byte for byte, including base64-encoded
  bodies; header names normalised; `fromResponse` round-trips status,
  headers and body; `bodyWasParsed` triggers the JCS path; the adapter's
  `maxDurationMs` is at or below any value the author declares for the
  platform. It then runs `conformRemoteExecutor` against the adapter served
  by the kit's `Bun.serve` on port 0, by wrapping the platform arguments the
  way the samples do.

**Per binding** (added 2026-09-25, `remote-transports.md` §10). Every
binding passes **the same protocol conformance**: handshake, frame security,
invoke, accept and reject, progress and logs during the attempt, heartbeat,
health (liveness, readiness, the canary), cancel, duplicate delivery, a lost
response, reconnection and resume, fencing, limits, and the platform probe.
`conformRemoteExecutor` runs it over any scheme, so a plugin's executor, a
first-party server and a polyglot executor are held to one suite. Each binding
then adds its own checks against a fake that ships in `./remote/testing`:

| Binding | Binding-specific checks | Fake |
|---|---|---|
| `http-stream`, `sse` | the first frame arrives at once; events split across writes parse; a buffering path is detected and downgraded; `Last-Event-ID` re-attaches | `bufferingHttpProxy` |
| `ws`, `ws-reverse` | a paused peer is detected by application liveness; server `send()` returning `0` is a dead session, not a silent loss; oversize messages are refused before sending; idle cuts are resumed | `idleCuttingProxy` |
| `tcp` | frames split to single bytes, coalesced, and split inside the length prefix; a paused reader loses nothing; half-close; ALPN bytes; sealed `tcp://` | `tcpChunker` |
| `udp` | seeded loss, reordering, duplication, a 1,200-byte MTU and port rebinding: every job completes exactly once; stateless reset; amplification bound | `lossyUdpProxy` |
| any | an executor frozen with SIGSTOP mid-attempt is detected within `attemptSilenceMs` | `spawnExecutor` |

All of it runs on loopback, in `bun test`, with no credentials. A plugin
transport (a broker) supplies its own fake broker and runs the same protocol
suite over it. For the loss tests it does not need a network-level proxy:
`lossySession(session, { loss, reorder, duplicate, seed })`, also in
`./remote/testing`, wraps any `DuplexSession` and injects the same faults at
the frame level, so a broker transport that declares `reliable: false` gets
the tests UDP gets from `lossyUdpProxy` [D].

### 12.4 Fake platforms

A kit cannot know every platform's API, so the author supplies a fake [D]:

```ts
/** A local stand-in for a platform's control API, served on port 0. The author writes one per platform. */
export interface FakePlatform {
  /** Where the fake listens. The kit also routes `ctx.fetch` here. */
  readonly url: string;
  /**
   * Makes the next call(s) fail the way the *real* platform fails for this
   * fault: its status, its error body, its headers. The fake's author is
   * responsible for fidelity (§12.5).
   */
  inject: (fault: FakeFault, options?: { times?: number; retryAfterMs?: number }) => void;
  /** Units the fake has started, with what they were given. */
  units: () => Promise<readonly FakeUnit[]>;
  /** Called by the fake when it starts a unit: the kit spawns its fixture worker. Set by the kit. */
  onStart: (start: (unit: { env: Record<string, string>; argv: readonly string[] }) => void) => void;
  /** The platform's real limits, for the truthfulness checks. */
  readonly limits?: { maxDurationMs?: number; maxRequestBytes?: number; tokenMaxLength?: number };
  /** Stops the server. */
  close: () => Promise<void>;
}

/** The faults a fake must be able to reproduce. */
export type FakeFault = "transient" | "throttled" | "quota" | "auth" | "misconfigured" | "conflict" | "capacity-200" | "slow";

/** One unit the fake started. */
export interface FakeUnit {
  /** The handle the fake returned for it. */
  handle: string;
  /** The env it was given (empty when the platform passes none). */
  env: Readonly<Record<string, string>>;
  /** The argv it was given. */
  argv: readonly string[];
  /** Where it is. */
  state: "pending" | "running" | "exited";
}

/** Builds a fake from route handlers plus the kit's unit bookkeeping and fault injection. */
export function fakePlatform(routes: Record<string, (request: Request, platform: FakePlatformState) => Response | Promise<Response>>): Promise<FakePlatform>;
```

`fakePlatform()` does the bookkeeping (units, a token memory with a TTL,
fault queues, `Bun.serve` on port 0 per `CLAUDE.md`), so a fake for a new
platform is its routes and error bodies only [D].

**First-party providers are tested with the same kit** [D].
`summon-compute.md` §11.1's per-API stubs ("Adapter tests against `Bun.serve`
stubs on port 0") become `FakePlatform`s built with `fakePlatform()`, and each
first-party provider's test file is `assertConformance(await
runProviderConformance(…))` plus the cases specific to it (ECS's
`failures`-only 200, Cloud Run's pre-check, the SSH exit codes). The first-party
fakes ship too, under `./provider/testing`, as worked examples for authors of
fakes, and so that a third-party ECS-compatible provider can reuse ECS's fake.

### 12.5 What the kit cannot prove

- **A fake is only as faithful as its author.** A provider and a fake written
  by the same person from the same misreading agree with each other and are
  both wrong. The kit proves the provider handles *the fake's* 429; it
  proves nothing about the platform's [I]. Mitigations: the fakes of
  first-party providers are built from the evidence files' recorded
  responses, with the [U] shapes marked [U] in the fake's source; the tier-3
  live run (`summon-compute.md` §11.1) replaces a [U] with a recorded answer;
  and the report prints "tested against a fake" in its header, always.
- **Capability truthfulness is partly self-reported.** `limits` in a fake is
  the author's belief about the platform. The execute facet's runtime
  reconciliation (§8.3) catches some lies continuously; nothing catches a
  `bootBudgetMs` that is too short except the `lost` outcomes it produces in
  production.
- **A pass is not an endorsement.** The docs say, in these words: "passing
  the conformance kit means the plugin behaves correctly against its own fake.
  It does not mean bun-jobs has reviewed it" (§13.4).

---

## 13. Security model

### 13.1 What a plugin is

A plugin is code the user imported into their process. It runs with
everything the process has: `process.env`, the filesystem, the network, and
the objects it is handed [I]. **bun-jobs provides no sandbox, and the docs say
so first.** Nomad's plugins get process isolation from go-plugin [W]; ours do
not, because they are ordinary modules.

### 13.2 What bun-jobs does protect [D]

| Protection | How |
|---|---|
| **The plugin never holds the signing key** of the execute path | the core signs and verifies (§8.2). A plugin that logs its `Request` leaks a signature valid for 300 s, not the key |
| **The plugin never sees the driver** | no context carries it. A summon plugin sees demand counts; an execute plugin sees job payloads in the bytes it carries, which is unavoidable, and nothing else |
| **Declared secrets are redacted** everywhere bun-jobs writes text | §13.3 |
| **Config errors never echo secret values** | a `ConfigError` from schema validation carries issue paths and messages; values at declared secret paths are replaced before the message is built |
| **`describe()` is filtered twice** | declared secret values are redacted, and keys matching `/token|secret|key|password/i` are dropped (the belt-and-braces rule of `summon-compute.md` §9.3) |
| **Money-spending and credential-touching routes are separate actions** | `queues.summon` exists (`summon-compute.md` §6.2); `providers.validate` is new (§14). Neither is in a read-only API |

### 13.3 Redaction

The provider's `ctx.logger` is a `child()` of the controller's logger, wrapped
so that every message and field passes through [D]:

1. **exact-value redaction** of the current config's declared secret values
   (strings of 8 or more characters; shorter ones are not redacted, and the
   kit warns about them);
2. **the runner's existing pattern redactor**, `createRedactor`
   (`runner/redact.ts:129`) with `DEFAULT_REDACT_KEYS` (`:50`) [S], which
   already catches `Bearer …`, `key=value` pairs, URL passwords and JWTs
   (`:13-22`) [S].

The same pass runs over `ProviderError.message`, `detail` strings on results
and unit statuses, and the `cause` chain before it is logged. The redactor is
text-level, and its own JSDoc lists what it misses: "a secret in prose", and
token shapes other than a JWT (`redact.ts:24-25`) [S]. Declared secrets are
how a plugin closes that gap for its own values.

### 13.4 Guidance for users choosing a third-party plugin

The user guide (§15.4) carries this list, plainly [D]:

- A provider plugin is code that holds a credential able to start compute and
  spend money. Treat installing one like granting that credential.
- **Scope the credential to the plugin's job**: one ECS cluster and task
  definition; one ACA job (an identity that can start an ACA job can read its
  secrets [V, google-azure §4.2]); one Lambda function.
- Pin the exact version. Read the changelog before upgrading. The
  registration `warn` for a newer minor is a prompt to read it.
- Prefer a plugin that publishes its conformance report and its fake. Run the
  kit yourself: it needs no credentials.
- Check the package's install scripts and dependencies. A provider needs
  `fetch` and WebCrypto; one that pulls a cloud SDK or has a `postinstall`
  deserves a question.
- Whether npm provenance attestations help here is [U]; the guide mentions
  them only once verified.
- Put the credential in the process that runs the controller, not in every
  producer (`summon-compute.md` §3.2, §12.3).

---

## 14. Observability and UI

### 14.1 What reaches the management API [D]

| Data | Where | From |
|---|---|---|
| provider identity (`name`, `version`, `kind`, `displayName`, `homepage`, `apiVersion`), capabilities, `describe()` facts, whether `validate` exists | `SummonStatusDto.summoner` gains `provider` and `capabilities` (`summon-compute.md` §9.3) | the configured provider |
| the same, for an execute provider, plus the reconciled limits (§8.3), the runtime entry it expects, the binding, and the endpoint's health (state and reason, last `pong` RTT, capacity, last canary) and session counts | `WorkerDto.target` (`worker-runtimes.md` §8.1's `target.remote`, the one definition) | the gateway |
| a platform-level probe of the executor, when the facet has `probe()` | `WorkerDto.target.remote.health.reason` when it disagrees with the protocol's view; never used to route | `ExecuteFacet.probe()` (§8.2) |
| a summoned worker's provenance (attempt id, provider `kind`, mode, deadline; the platform handle only with `exposeHosts`) | `WorkerDto.summon` (`summon-compute.md` §5.4, PR-2) | the worker's own record |
| the providers configured in *this* process, and the host's `COMPUTE_PROVIDER_API` | `GET /providers` (action `providers.read`, new) and `/meta`'s `features.providers` | the per-process registry of §9.3 |
| a preflight result | `POST /providers/:id/validate` (action **`providers.validate`**, new, opt-in like `queues.summon`) | `ConfiguredProvider.validate()` |
| a lost attempt's reason | `marker.last.detail`, the `summon` event | `status()` (§7.3) |
| config form | `GET /providers/:id/schema`, only when the schema implements Standard JSON Schema (§2.3) | `~standard.jsonSchema.input({ target: "draft-2020-12" })` |

`:id` is `name@version#<n>`, the nth configured instance in this process; it
is stable for a process's life and meaningless across processes [D].

Everything in this table is secret-free by §13.2 and §13.3. The
`providers.read` action is a read, but it discloses infrastructure (cluster
names, regions), so it is not granted by `readOnly: true`'s default set and
must be named, like the `exposeHosts` switch `summon-compute.md` §9.2 uses for
handles [D].

### 14.2 What the UI shows [D]

- **Queue screen, summon card**: the provider's display name and version, a
  link to its homepage, the capability summary ("launch · token dedupe · env ·
  boot budget 3 min · SIGTERM + 30 s"), the facts, and a "Test connection"
  button gated on `providers.validate`.
- **An experimental badge** when any facet the provider uses is `0.x`, and a
  warning badge when the registration check warned (newer minor, deprecated
  major).
- **Workers page**: a summoned worker's badge already names the `kind`
  (`summon-compute.md` §9.2); a remote worker's badge names the execute
  provider, its binding (`ws`, `tcp`, …) and the runtime entry, and its
  Target card shows the endpoint's health state with its reason, the last
  canary and the session counts (`remote-transports.md` §12).
- **A "Providers" section** in the settings or meta screen, from `GET
  /providers`.

### 14.3 Owners

| Work | Owner |
|---|---|
| DTO fields, `GET /providers`, `POST /providers/:id/validate`, `/schema`, the two actions in `JOBS_API_ACTIONS`, OpenAPI | the bun-jobs session |
| the provider card, badges, the Providers section, the config form (when a schema is available); the binding and health on the Target card (`remote-transports.md` §12, ~2 d) | the UI session |
| new rows in `packages/bun-jobs-ui/README.md`'s `### What each element needs` for "Test connection", the Providers section, and the Target card's health elements. The table is parsed by `examples/bun-jobs-ui/04-screens/permissions.ts` (`CLAUDE.md`) | the UI session writes the rows; **the examples session must be told before merge** |
| examples (§15.5) | the examples session |

---

## 15. Documentation deliverables

The user asked for "proper documentation", so the documentation is scoped,
located and tested like code [D].

### 15.1 Where it lives

`packages/bun-jobs/docs/providers/`, **shipped in the npm package** by adding
`"docs"` to `files` (today `["dts", "lib"]`, `package.json:78-81`) [S/D]. A
plugin author reading `node_modules/@kingsleyweb/bun-jobs/docs/providers/`
then reads the guide that matches the version installed. The package README
gets a short "Compute providers" section linking to it. `PROTOCOL.md`
(`worker-runtimes.md` §5) moves to `docs/remote/PROTOCOL.md` beside it, for
the same reason.

| File | Audience | Kept true by |
|---|---|---|
| `docs/providers/README.md` | everyone: what a provider is, the two facets, which doc to read | links checked by the drift test |
| `docs/providers/author-guide.md` | plugin authors | its code blocks are extracted and typechecked; its worked examples are the template's files (§15.2) |
| `docs/providers/reference.md` | plugin authors | the drift test (§15.3) |
| `docs/providers/user-guide.md` | application developers installing a plugin | its snippets typechecked; the security section reviewed at each facet gate |
| `docs/providers/security.md` | both | §13, verbatim; reviewed at each facet gate |
| `docs/providers/runtime-adapters.md` | authors of the platform side | code blocks typechecked; its example is the template's `runtime.ts` |
| `docs/remote/PROTOCOL.md` | anyone implementing the wire protocol, in any language | `worker-runtimes.md` §5, §7; since 2026-09-25 with **per-binding appendices** (HTTP, streamed HTTP and SSE, WebSocket, TCP, UDP, HTTP/2, an informative gRPC `.proto`, brokers) and **test vectors** generated and checked by a test (`remote-transports.md` §11.5) |
| `docs/remote/transports.md` | application developers | **The transport selection guide**: which binding for which host, with each platform's trap, from `evidence/remote-transports/platform-transports.md` (`remote-transports.md` §11.2) |
| `docs/remote/transports/<binding>.md` | application developers | **One user guide per binding**: configuring it, its health and progress behaviour, its failure modes, platform notes, security (`remote-transports.md` §11.4). Snippets typechecked |
| `docs/remote/executor-guide.md` | executor authors | **A complete worked executor per binding**, and a stdlib-only Python executor over `tcp+tls` run against the conformance suite when `python3` is present (`remote-transports.md` §11.3). The worked executors are the examples' executors |
| `docs/remote/health.md` | operators | The health model and the Workers page's health states (`remote-transports.md` §5, §12) |

All of it is Markdown and so linted by the package's `bunx eslint .`
(`CLAUDE.md`: "Lint the whole package"). Long table cells can hang Prettier
(the maintainer's recorded gotcha), so the reference uses headings and lists,
not wide tables.

### 15.2 The author guide

Step by step, each step a heading, each with the code of one worked example
[D]:

1. **What you are building**: a provider object; facets; the runtime adapter
   as a separate entry; when you need which.
2. **Start from the template**: copy `templates/compute-provider/`, rename,
   install.
3. **Identity and versions**: `name`, `version`, `kind`, `apiVersion`, and
   what the registration check will say.
4. **Config**: a Standard Schema with any library or with
   `toStandardSchema`; declaring `secrets`.
5. **Summon: declare capabilities truthfully**: style, dedupe with its key
   limits, `passes`, boot budget, shutdown. What the controller does with each
   (§7.1's table).
6. **Summon: implement `summon()`**: purity of the request under a strict
   token; answers versus errors.
7. **Map errors**: one table from platform codes to `ProviderError` kinds,
   with the six kinds explained by what the controller does.
8. **Hand over the summon id**: env, argv or nothing; how the worker's
   `summonedFromEnv()` reads it; what release-by-start-time costs
   (`summon-compute.md` Q34).
9. **Optional hooks**: `release`, `status`, `cancel`, `validate`.
10. **Execute: the transport**: the two shapes; for the exchange shape,
    `send()`, not touching the bytes, adding platform auth, `locate()`, and
    `exchangeTransport()`; declaring capabilities truthfully.
    - **Writing a session transport** (added 2026-09-25): `open()` or
      `listen()`, opaque frames, never dropping a frame silently, bounded
      buffers and `bufferedBytes()`, `reconnect()` for resumption, what the
      core does for you (security, sequencing, retransmission, health), the
      broker routing convention, and the runtime half with
      `RemoteExecutor.acceptSession()`. Worked example: the **Acme Queue**
      transport (below). An outline of a gRPC bidirectional-stream transport
      follows it, because gRPC is left to plugins (`remote-transports.md`
      §7.10).
11. **Execute: the runtime adapter**: `defineRuntimeAdapter`, raw bodies,
    `waitUntil`, the platform's real ceilings.
12. **Write the fake**: `fakePlatform()` routes and faithful error bodies.
13. **Run the kits**: summon, execute, runtime; reading a report; skipping a
    check honestly.
14. **Security obligations**: no secrets in `describe`, use `ctx.logger` and
    `ctx.fetch`, no install scripts, no SDKs.
15. **Publish**: naming, keywords, the peer range, the `"bun-jobs"` field,
    publishing the report.

**Two worked examples, complete** [D]:

- **Summon: "Acme Compute"**, a fictional launch-style platform with a
  64-character strict token, env passing, a 429 with `Retry-After`, a
  `QuotaExceeded` body and a 404 for an unknown pool. About 150 lines of
  provider and 80 of fake. It is the template's `src/index.ts` summon facet.
- **Execute: "Acme Functions"**, a fictional function platform with a
  private invoke API: a host-side `send()` that wraps the signed request in
  the platform's invoke call with a bearer token, `locate()` from a function
  name, a 6 MB body cap and no streaming; and its runtime adapter, which maps
  the platform's `{ body, isBase64, headers }` event to a `Request`. It is
  the template's execute facet and `src/runtime.ts`.

- **Transport: "Acme Queue"** (added 2026-09-25), a fictional at-most-once
  message broker: a session-shape facet with `direction: "brokered"`,
  `reliable: false`, `confidential: false`, the routing convention of
  `remote-transports.md` §7.12, and its runtime half over
  `acceptSession()`. It passes `runExecuteConformance` and the protocol
  suite through a fake broker and `lossySession()`. It is the template's
  third facet file, `src/transport.ts`.

A fictional platform, not a real one, so the example cannot go stale when a
real API changes, and so no reader mistakes it for a supported provider [I].

### 15.3 The API reference, and how it is kept from drifting

**Hand-written, with a drift test** [D]. Considered and rejected:

- **Generated with TypeDoc.** It adds a devDependency and a second rendering of
  JSDoc that editors already show on hover, and it cannot hold the
  explanations the guide needs [I]. The JSDoc-on-every-property rule
  (`CLAUDE.md`) keeps the hover text good regardless.
- **No reference, only the guide.** Authors need a place to look a member up.

The drift test, `__tests__/provider/reference.test.ts` [D]:

- **Values**: `Object.keys(await import(entry))` for `./provider`,
  `./provider/auth`, `./provider/testing`, `./summon`, `./remote`,
  `./remote/testing` and, since 2026-09-25, `./remote/serve` and the
  first-party transport providers (`./providers/https`, `/ws`, `/tcp`,
  `/udp`) must equal the set of `### \`name\`` headings under that entry's
  section of `reference.md`.
- **Types**: the TypeScript compiler API (`typescript` is already a
  devDependency and an optional peer [S, `package.json:96`]) lists each
  entry's exported types and each interface's members; every exported type
  must have a heading, and every member a bullet `` - `member` `` under it.
- **Both directions fail**: an export with no heading, a heading with no
  export, a member added without a bullet, a bullet for a removed member.
- **A negative control** runs the checker over a reference with one heading
  removed and expects the failure.

This is the pattern the repo already trusts for the UI's permission table,
which `examples/bun-jobs-ui/04-screens/permissions.ts` parses and holds to the
code (`CLAUDE.md`) [S via CLAUDE.md].

### 15.4 The user guide

Installing and configuring a third-party provider [D]:

1. finding one (the keyword, the naming convention);
2. checking compatibility (the `"bun-jobs"` field, the peer range, the
   registration message);
3. installing and passing it in (§9), with `SummonPolicy` and
   `jobs.remoteWorker` snippets;
4. configuring it, including where secrets come from (env, the platform's
   secret store) and never from committed config;
5. what the UI shows, and "Test connection";
6. **the security section, §13.4, in full**, placed before the first
   configuration example rather than after it;
7. troubleshooting by error kind: what `auth`, `quota` and `misconfigured`
   look like in the log and the UI, and what to check.

### 15.5 Examples, for the examples session

Two new examples in `examples/bun-jobs/` [D], each against a local fake,
each passing its kit, each run by `run-all.ts`:

- **`NN-providers/custom-summon-provider.ts`**: defines a tiny summon
  provider against a `fakePlatform()` fake, runs `runProviderConformance` and
  asserts `ok`, then uses it in a `SummonController` on the example backend
  and shows one summon, one registration and one release. It is also the
  "provider written outside the bun-jobs session" the summon gate needs
  (§10.4).
- **`NN-providers/custom-execute-provider.ts`**: defines an execute provider
  and a runtime adapter, serves the adapter on port 0, runs both execute kits,
  then sends three jobs through `jobs.remoteWorker` and shows them complete.
- **`NN-transports/`** (added 2026-09-25): **one example per binding**
  (`http.ts`, `http-stream.ts`, `sse.ts`, `websocket.ts`,
  `websocket-reverse.ts`, `tcp.ts`, `unix-socket.ts`, `udp.ts`), each against
  a local executor (`Bun.serve`, `Bun.listen`, `Bun.udpSocket`) and each
  demonstrating health checks and live progress; a `health-checks.ts`
  covering liveness, readiness, the canary and the breaker; and **a failure
  demo per binding**, in which the executor, a child process, is frozen with
  SIGSTOP mid-attempt and the heartbeat loss must be detected (killed with
  SIGKILL, too, for `ws`, `tcp` and `udp`). The table with what each
  asserts is `remote-transports.md` §11.6. The failure demos and `udp.ts`
  assert on durations, so they go in `RUN_ALONE`. Also
  `NN-providers/custom-session-transport.ts`: a session-shape execute
  provider over an in-memory fake broker, passing the kits through
  `lossySession()`, which is the outside transport the execute gate needs.
  ~6 d for the examples session, landing with each binding's sub-phase.

Per the examples protocol, the bun-jobs session sends a change report at
1.5p and at Phase 3, the examples session writes and runs these, and the
README is updated once they pass. The summon example depends on
`EXAMPLE_DRIVER` being multi-process (`summon-compute.md` §4.9), so on the
memory backend it must use the file driver or skip with a message; which is
for the examples session to decide [I].

### 15.6 How the docs stay true, in one list

- code blocks in every guide are extracted and typechecked by a
  `docs.type-test.ts` in the tests typecheck [D];
- the reference drift test (§15.3);
- the template is in the gate (§11.3), and the guide's examples *are* the
  template's files, so they cannot disagree;
- the examples run in `run-all.ts`;
- `PROTOCOL.md`'s test vectors are generated from the code and checked by a
  test, and the Python executor passes the protocol suite whenever `python3`
  is present (added 2026-09-25);
- the executor guide's worked executors are the transport examples'
  executors, so they cannot disagree;
- `security.md` and the user guide's security section are reviewed at each
  facet gate (§10.4), recorded in the gate's checklist.

---

## 16. Phases and effort

Focused days for someone who wrote the code, as in the other two plans.

### 16.1 The recommendation: the API before the first-party providers

Build the core, the summon facet and the kit **before** 1.5c, and build every
first-party summoner on it. Then six real implementations, across three
styles and three ways of passing the id, test the API before it is called
stable. The alternative, providers first and an API extracted afterwards,
would design the API around six known platforms and leave the seventh to find
out what was missed [I].

The minimum useful ship is unaffected: 1.5a + 1.5b still reach every platform,
through `defineSummoner({ invoke })` and the depth endpoint.

### 16.2 Phase 1.5 (summon-compute), revised

| Sub-phase | What | Effort | Change |
|---|---|---|---|
| 1.5a + 1.5b | Core: `countDemand`, controller, marker, `runSummoned`; `defineSummoner` built as an anonymous provider over the 1.5p types, or over an internal stand-in if 1.5p has not landed. Depth endpoint and summon routes. **Sliced into PR-1 to PR-7** (`summon-compute.md` §13.1) | ~19.75 d | was ~13 d + ~4.5 d; +2.25 d from the reconciliation (`summon-compute.md` §13.1) |
| **1.5p** | **Provider API, `experimental`**: see the table below | **~12.5 d** | new |
| 1.5c | SigV4 + credentials (now in `./provider/auth`); ECS, Lambda, Fly on the API, each with a `fakePlatform()` fake and a kit run | ~6.5 d | the fakes add ~0.5 d; 1.5p already did the packaging wiring (−0.5 d) |
| 1.5d | Token helper; Cloud Run jobs and pools; ACA, on the API, with fakes and kit runs | ~4.5 d | +0.5 d |
| 1.5e | Render; SSH, on the API, with fakes and kit runs | ~3.5 d | +0.5 d |
| 1.5g | Live verification | ~1.5 d | unchanged |
| **1.5s** | **Summon stability gate**: the external provider has passed; API review; the core's [U]s (Q2, Q15) closed by 1.5g; `summon` → `1.0` (and `core` → `1.0` if the execute gate also allows — otherwise core stays `0.x`, §10.4) | **~1 d** | new |
| | **Total (bun-jobs session)** | **~49.25 d** | was ~47 d, and ~32.5 d before the plugin API |

**1.5p in detail:**

| Work | Effort |
|---|---|
| `lib/provider/`: identity, brand, `defineComputeProvider`, configure and schema validation (sync and async), the version check and the per-process name map, `ProviderError` and its mapping into the controller's gates, contexts, redaction wiring | 2.5 d |
| The summon facet: capabilities read by the controller (dedupe key from the declaration, `wake`, shutdown → grace env, lifetime cap), `status`/`cancel` wiring, `Summoner` redefined, `defineSummoner` as a wrapper | 1.5 d |
| `./provider/testing`: report and `assertConformance`, `fakePlatform()`, the summon kit's checks, the fixture worker and handoff harness moved from `__tests__/helpers/summon.ts`, a negative control per check group | 3.5 d |
| The first-party import test (§5), `exports`/`dts`/`consumer-check.json`/packaging test for `./provider`, `./provider/auth`, `./provider/testing`, `./providers/*` | 1 d |
| Docs: README section, author guide (summon half) with the Acme Compute example, reference + drift test, user guide, security page | 3 d |
| `templates/compute-provider/` (summon half), its type check script, wired into the gate | 1 d |
| **Total** | **~12.5 d** |

**Other owners in 1.5**: the UI session +0.5 d (provider card, experimental
badge, Test connection; on top of ~3 d); the examples session +1 d (the
custom summon provider example; on top of ~2 d).

### 16.3 Phases 2–4 (remote execution), revised

| Phase | Addition | Effort added | Phase total |
|---|---|---|---|
| **2** | The execute facet, host side (exchange shape; the session shape is 2a in the transports table below): types, `send()` integration in `RemoteTarget` (core signs, facet sends, core verifies), `locate`, capability reconciliation with the handshake, `ProviderError` mapping into the breaker, `httpsExecute` as the built-in for `{ endpoint }`, `lambdaExecute` if the SigV4 path is closed (else Phase 3) — 2.5 d; author guide's execute-host chapter and reference entries — 1 d | +3.5 d | ~19 → **~22.5 d** |
| **3** | `defineRuntimeAdapter` + `RUNTIME_ADAPTER_API` — 1 d; `runRuntimeAdapterConformance` — 1.5 d; `runExecuteConformance` and the host-side fake — 1.5 d; the first-party Cloudflare, Lambda and HTTP adapters rebuilt on `defineRuntimeAdapter` under §5's rule (the import test extended to `lib/remote/adapters/`) — 0.5 d; runtime-adapter guide, the Acme Functions example, the template's execute half — 1.5 d | +6 d | ~11 → **~17 d** |
| **4** | **Execute stability gate**: the outside provider has passed, API review, `execute` → `1.0`, and `core` → `1.0` if the summon gate has passed | +1 d | ~9 → **~10 d** |

**Other owners in 2–4**: the examples session +1 d in Phase 3 (the custom
execute provider example); the UI session's execute-provider badge is inside
Phase 1's existing Target card work, so no addition [I].

**Revised again 2026-09-25: the transports** ([`remote-transports.md`](remote-transports.md)
§13). The execute facet becomes transport-agnostic (§8), and Phase 2 carries
the contract over every binding the user asked for, split into sub-phases
2a–2f, **all committed and built in that order** (the user's decision,
2026-09-25, `remote-transports.md` Q-T1).

| Phase | Addition | Effort added | Phase total |
|---|---|---|---|
| **2a** | The message protocol v1, text frames with per-frame MAC and test vectors; the attempt state machine; the health model (liveness, readiness, canary, breaker); **the facet's session shape, `TransportCapabilities`, the registration check and `exchangeTransport()`** (net +1 d over the 2.5 d above); `http-stream` with SSE framing and the buffering probe; `serveHttp` and `RemoteExecutor.acceptSession`; tests; `PROTOCOL.md` appendices A–B, the selection guide, user guides, worked executors | +15.5 d | **~38 d** |
| **2b** | WebSocket forward (`wsExecute`, `serveWebSocket`) and the reliability layer's outbox, resume and `status` | +9.5 d | |
| **2c** | TCP, TLS and Unix sockets (`tcpExecute`, `serveTcp`), the binary codec and AEAD sealing, the Python executor | +10 d | |
| **2d** | Reversed WebSocket and TCP (`wsListen`, `tcpListen`, `listen()`; `dialWebSocket`, `dialTcp`), SSE session mode | +8.5 d | |
| **2e** | UDP (`udpExecute`, `serveUdp`), retransmission, window and fragmentation, `lossyUdpProxy`; `experimental` | +10 d | |
| **2f** | HTTP/2 flag; the informative gRPC `.proto` | +1.5 d | **Phase 2: ~77.5 d** |
| **3** | Per-binding conformance and the shipped fakes (`bufferingHttpProxy`, `idleCuttingProxy`, `tcpChunker`, `lossyUdpProxy`, `lossySession`, `spawnExecutor`) — 3 d; `runExecuteConformance`'s session-shape checks (§12.3) — 1.5 d; the "Writing a transport" chapter and the Acme Queue transport in the template — 1 d | +5.5 d | **~22.5 d** |
| **4** | Streaming and cancellation move to 2a (−3 d); per-binding `push-loopback` benchmarks (+2 d); the real-network measurements the transports rest on (+2 d) | +1 d | **~11 d** |

The execute stability gate (§10.4) is unchanged in kind but covers more: a
transport-agnostic facet is proven only when at least one **session-shape**
transport written outside the bun-jobs session passes the kits too. The
template's Acme Queue does not count (the bun-jobs session writes it); the
examples session's `custom-session-transport.ts` qualifies at minimum [D].

**Other owners, transports**: the examples session +6 d (one example and one
failure demo per binding, §15.5); the UI session +2 d (binding, health state,
canary, session counts on the Target card).

### 16.4 Totals

| Phase | Before | After the plugin system | After the transports (2026-09-25) | After the 1.5a/1.5b reconciliation (2026-09-26) |
|---|---|---|---|---|
| 0 | ~1.5 d | ~1.5 d | ~1.5 d | ~1.5 d |
| 1 | ~7.5 d | ~7.5 d (its 1 d "Executor-based custom target" must now include §2.5's type change) | ~7.5 d | ~7.5 d |
| 1.5 | ~32.5 d | **~47 d** | ~47 d | **~49.25 d** (1.5a/1.5b re-sliced into seven PRs, `summon-compute.md` §13) |
| 2 | ~19 d | **~22.5 d** | **~77.5 d**, all of 2a–2f committed, in order (2a, the first milestone, ~38 d) | ~77.5 d |
| 3 | ~11 d | **~17 d** | **~22.5 d** | ~22.5 d |
| 4 | ~9 d | **~10 d** | **~11 d** | ~11 d |
| **Total, bun-jobs session** | **~80.5 d** | **~105.5 d** | **~167 d** | **~169.25 d** |
| Other owners | UI ~3 d, examples ~2 d | UI ~3.5 d, examples ~4 d | UI ~5.5 d, examples ~10 d | UI ~5.5 d, examples ~10 d |

This table omits Phase 1r (~3 d), which `worker-runtimes.md` §11 includes;
its total is therefore ~171.75 d (~169.25 d + ~3 d, less the ~0.5 d by which Phase 1 came in under estimate). (Of the
seven Phase 1.5 PRs, PR-1 is the bun-jobs session's and PR-2 to PR-7 the
features session's; the "bun-jobs session" row above counts the phase's work
wherever it is done.)

The ~25 d added is the plugin system: ~12.5 d of API, kit, docs and template
for summon (1.5p), ~3.5 d and ~6 d for execute (Phases 2 and 3), ~1 d of
first-party rework onto fakes and the kit (1.5d, 1.5e; 1.5c nets to zero), and
~2 d of gates (1.5s, Phase 4). About 5.5 d of it is documentation.

---

## 17. Risks and open questions

### 17.1 Risks

- **An API surface kept forever.** Everything in §6–§8 becomes a promise at
  1.0. Mitigations: the `0.x` period; the gate's seven implementations; and a
  small core. The largest single commitment is `./provider/auth`, because
  signers are where subtle bugs live. It is behind the Q2 and Q15 closures
  for that reason.
- **Capability declarations that lie.** A `bootBudgetMs` too short summons
  twice; a `dedupe.strict: false` that is really strict turns retries into
  `conflict`s; an `enforcesLifetime: true` that is not leaves workers running.
  The kit catches the checkable ones against the fake (§12.2), the execute
  gateway reconciles limits at run time (§8.3), and the rest show up as
  `lost` and `conflict` outcomes in the UI with the provider named.
- **Plugins holding credentials.** In-process code with a cloud credential.
  §13 is honest about it; the user guide leads with it.
- **Version skew.** Between host and plugin: the registration check (§10.2).
  Between a plugin's host and runtime halves: the wire protocol's negotiation
  (§10.5). Between two copies of one plugin: `name@version` (§9.3).
- **The conformance kit becoming a false guarantee.** §12.5. The report's
  header always says "against a fake"; the user guide says a pass is not a
  review.
- **The docs rotting.** §15.6's seven mechanisms. The weakest is prose that
  is not code: `security.md`, the transport selection guide's platform rows,
  and the user guides' failure-mode tables, reviewed only at gates; the
  selection guide's [U] rows are re-read at each facet gate
  (`remote-transports.md` §11.7).
- **The transports** (added 2026-09-25). A session-shape facet is a larger
  API to freeze at `execute` 1.0 than `send()` was, and the first-party UDP
  transport rests on a reliability layer and a sealing scheme that are
  `experimental` and loopback-measured. The full list is
  `remote-transports.md` §14; its open questions are §15 there.
- **Scope growth delaying summoning.** 1.5p sits before 1.5c. If it slips, the
  first-party summoners slip. Mitigation: 1.5a + 1.5b remain the minimum
  useful ship and do not depend on 1.5p.

### 17.2 Open questions

- **Q-P1** Keep the shared core (§4, option C) if, by the execute gate, no
  provider implements both facets? The fallback is two thin systems sharing
  only `ProviderError` and the kit harness.
- **Q-P2** Is `./provider/auth` public from day one, or only after Q2 and Q15
  close? This plan makes it public but `0.x`; the alternative is to keep it
  internal to first-party providers, which would break §5's rule.
- **Q-P3** Does anything need a provider as data (name lookup, §9.2)? If a
  spawned runner ever summons or executes, the answer changes.
- **Q-P4** Self-reference: can a Bun workspace package import itself by name
  through its `exports`? If yes, first-party providers could import
  `@kingsleyweb/bun-jobs/provider` literally, which reads better than a
  relative path to the entry (§5). [U]
- **Q-P5** Which schema libraries implement Standard JSON Schema v1 today?
  It decides whether the UI's config form (§14.1) is common or rare. [U]
- **Q-P6** Should `ProviderErrorKind` have a `capacity` kind separate from
  `quota`? ECS's "no capacity right now" (a 200 with `failures`) and "your
  account's vCPU limit" (quota 6 on a new account [V, aws §1 item 4]) want
  different backoffs. This plan folds the first into the `unavailable`
  result; a platform whose capacity failure is an error status would need
  the kind.
- **Q-P7** Does `bun create` start a project from a monorepo subdirectory
  (§11.3)? [U]
- **Q-P8** Do npm provenance attestations mean anything useful for a user
  choosing a plugin (§13.4)? [U]
- **Q-P9** Should third-party **drivers** get the same treatment: a version
  number, a published `driverContract` in `./drivers/testing`, config-based
  construction for spawned children (§2.1)? It is the same problem, and the
  driver contract suite already exists. Out of scope here; worth its own
  plan.
- **Q-P10** ~~The `WorkerTarget` name (`worker-runtimes.md` §4.2) is settled by
  the rename as `WorkerSelector` for the old type. Should the new target type
  be named for the provider era, e.g. `RemoteTargetOptions { provider, secret
  }`, now that `{ kind: "endpoint", url }` is shorthand for a provider? Decide
  with Phase 1.~~ **Closed by Phase 1**: the user approved `WorkerTarget`
  and its family on 2026-09-25 (`worker-runtimes.md` §4.2.7, N1–N9), and it
  shipped at `0a8e580`. `{ endpoint }` is Phase 2's, as a new member of the
  union with its own `kind`; how a provider plugs into it is Phase 2's
  decision, not a rename.
