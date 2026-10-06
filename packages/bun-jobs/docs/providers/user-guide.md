# Using a compute provider

How to install a provider someone else wrote, configure it, pass it to a
queue's summon policy, and read what it does. The examples use the starter
template's provider, **Acme Compute**, for a fictional platform; a real one
is used the same way.

For what summoning is, and every policy option, see
[Summoning a worker](../../README.md#summoning-a-worker) in the package
README.

## 1. Before you install one

A provider is code that runs in your process, with everything the process
has, and it holds a credential that can start compute and spend money.
bun-jobs does not sandbox it. So, before the first line of config:

- A provider plugin is code that holds a credential able to start compute
  and spend money. **Treat installing one like granting that credential.**
- **Scope the credential to the provider's job**: one ECS cluster and task
  definition; one Container Apps job (an identity that can start one can read
  its secrets); one Lambda function.
- **Pin the exact version.** Read the changelog before upgrading. The `warn`
  a controller logs for a provider written against a newer minor of the API
  is a prompt to read it.
- **Prefer a provider that publishes its conformance report and its fake.**
  Run the kit yourself: it needs no credentials.
- **Check the package's install scripts and dependencies.** A provider needs
  `fetch` and WebCrypto; one that pulls a cloud SDK or has a `postinstall`
  deserves a question.
- **Put the credential in the process that runs the controller**, not in
  every producer. Only that process calls the provider.

[The security page](./security.md) says what bun-jobs does protect: declared
secrets redacted from logs, facts filtered, credentials never served by the
management API.

## 2. Finding one

Providers are npm packages named `bun-jobs-provider-<platform>` (or
`@<scope>/bun-jobs-provider-<platform>`), with the keywords
`bun-jobs-provider` and `bun-jobs-provider-summon`. A provider is a plain
import: there is no registry and nothing to register.

## 3. Checking compatibility

A provider's `package.json` says what it was written against, in its
`"bun-jobs"` field, and its peer dependency on `@kingsleyweb/bun-jobs` says
which versions it supports:

```json
{
  "peerDependencies": {
    "@kingsleyweb/bun-jobs": ">=2.2.0 <2.3.0"
  },
  "bun-jobs": {
    "facets": ["summon"],
    "apiVersion": { "core": "0.1", "summon": "0.1" }
  }
}
```

The plugin API is **experimental** while its versions are `0.x`: any `0.x`
minor may change it, so a provider's peer range is one bun-jobs minor wide.
This bun-jobs speaks `core` `0.1` and `summon` `0.1`, and has no execute
facet.

What you see when they do not match:

- **A different major** is a `ConfigError` when the provider is defined
  (usually as its module is imported), saying which side to upgrade: `Provider … was written for summon
  1.0, and this bun-jobs speaks summon 0.1: upgrade bun-jobs`.
- **A newer minor** is one `warn` per process, when a controller is first
  handed the provider: members added since are ignored.
- **The experimental API** is one `warn` per process, per provider version:
  `the provider API is experimental (core 0.1, summon 0.1); any 0.x minor may
  change it`.
- **Two versions of one provider** in one process (two packages depending on
  different copies) is one `warn`. Both work, each shown as `name@version`.

## 4. Passing it in

Call the provider with its config and put the result in a queue's summon
policy:

```ts
import process from "node:process";
import { BunJobs } from "@kingsleyweb/bun-jobs";
import { acme } from "bun-jobs-provider-example";

export const jobs = new BunJobs({
  namespace: "shop",
  driver: { type: "redis", url: process.env.REDIS_URL! },
  summon: {
    emails: {
      summoner: acme({
        region: "eu-west",
        pool: "workers",
        apiTokenFile: "/run/secrets/acme",
      }),
      maxWorkers: 3,
      jobsPerWorker: 50,
    },
  },
});
```

Or build a controller directly, with the same policy:

```ts
import process from "node:process";
import { createDriver, SummonController } from "@kingsleyweb/bun-jobs";
import { acme } from "bun-jobs-provider-example";

const controller = new SummonController({
  driver: createDriver({ type: "redis", url: process.env.REDIS_URL! }),
  namespace: "shop",
  queue: "emails",
  summoner: acme({
    region: "eu-west",
    pool: "workers",
    apiToken: process.env.ACME_TOKEN!,
  }),
});
// One check now: "summoned", "skipped" or "none".
export const { action } = await controller.check();
await controller.close();
```

The worker the provider starts runs your worker file with `runSummoned`; see
[Summoned workers: `runSummoned`](../../README.md#summoned-workers-runsummoned).

## 5. Configuring it

**Secrets come from the environment or the platform's secret store, never
from committed config.** A provider declares which config fields are
secrets, and bun-jobs redacts their values from everything the provider logs.
Many providers also take a secret by file (Acme's `apiTokenFile`), which
suits a mounted secret.

**When the config is checked** depends on the provider's schema:

- **Synchronously**, for most configs: an invalid one throws a `ConfigError`
  from `acme({ … })` at once, naming each field that is wrong. Secret values
  are redacted from the messages.
- **Asynchronously**, when the config must read something (Acme reading
  `apiTokenFile`). Validation **starts when you call the provider**, not at
  the first summon, and the configured provider's `ready` promise settles
  once it has finished. A controller waits for it before calling the
  provider, at most its `summonTimeout` (30 s by default). A rejection or
  that timeout is a **failed attempt**, counted toward the backoff and the
  circuit like any other, with the detail `ready timed out` or the error's
  code; the next attempt validates again. A wait that timed out is
  **abandoned, not cancelled**: the validation keeps running, and if it then
  succeeds, the controller adopts it. Until a controller has a validated
  config its status shows the summoner with `readiness: "pending"` (or
  `"failed"` once a validation rejected) and no capabilities; when the
  validated facet could not be adopted (its capabilities raised a
  `ConfigError`), `"failed"` for good.

To see a bad config at startup rather than at the first summon, await
`ready`. Many providers also have a **preflight**, `validate()`, which asks
the platform whether this config can reach it, and starts nothing:

```ts
import process from "node:process";
import { acme } from "bun-jobs-provider-example";

const summoner = acme({
  region: "eu-west",
  pool: "workers",
  apiToken: process.env.ACME_TOKEN!,
});
await summoner.ready; // throws a ConfigError if the config is invalid
// [{ id: "credentials", status: "pass" }, { id: "pool", status: "pass" }]
export const checks = await summoner.validate();
```

A provider without a preflight answers `[]`.

## 6. What the management API and the UI show

The queue's summon status (`GET /queues/:queue/summon`, action
`queues.read`) serves, for the provider, and the UI's summon panel shows:

- **who it is**: its display name or kind, its package name and version (the
  status also carries the API versions it declared);
- **what it declares**: the UI shows its style, boot budget and the longest
  life the platform allows; the status carries every capability;
- **its facts**: what its `describe()` returns (a region, a pool), with
  anything that looks like a credential, a URL with a password in it,
  another credential shape (`Bearer …`, `max_tokens=4096`) and a host name
  (unless `serialize.exposeHosts` is on) dropped;
- **its id and readiness**: `summoner.providerId`, `name@version~<n>`, and
  `summoner.readiness`, `"ready"`, `"pending"` or `"failed"`; its
  capabilities only once ready;
- **each attempt**: in flight, the failures, the backoff and circuit, the
  budget, and the last outcome with its **detail**: the platform's error
  code, or `PROVIDER_<KIND>`, or the reason the platform gave.

Platform handles (a task ARN) are shown only with
`serialize.exposeSummonHandles`. The config, its secrets and the provider's
log lines are never served.

Three more routes serve the providers themselves, each behind an action off
by default, since they disclose infrastructure (see
[Compute provider routes](../../README.md#compute-provider-routes)):

- `GET /providers` (`providers.read`): every provider configured in the
  API's process, with its id, identity, readiness and facts;
- `POST /providers/:id/validate` (`providers.validate`): "Test connection",
  the provider's preflight, bounded by a timeout, its check details
  redacted and capped. A failure's `kind` tells a bad config
  (`misconfigured`) or credentials (`auth`) from a platform failing for now;
- `GET /providers/:id/schema` (`providers.read`): its config as a JSON
  Schema for a form, with no default values in it.

`/meta`'s `features.providers` says whether they are served, and `authorize`
is told a provider's id as `provider`, so a host can allow "Test connection"
on some providers only.

**The list holds providers weakly.** A provider used as a queue's summoner
is kept alive by that queue's controller, so it is always listed. One
configured only to be listed (never used to summon) is listed only while
your code keeps it reachable from something still in use: the jobs context,
a summon policy, a module export that is read later. A module-level constant
that nothing reads again can be collected, and the provider then disappears
from the list.

## 7. Troubleshooting by error kind

A provider reports a platform failure as a `ProviderError` of one of six
kinds, and the kind decides what the controller does. What each looks like:

### `auth`: the credentials were rejected

- **Log**: an `error`, `compute provider <name> reported its credentials
  rejected (PROVIDER_AUTH): the summon circuit is open at once, until it
  resets or is reset`.
- **Status**: the last outcome is `failed`, its detail the platform's code
  (`InvalidToken`) or `PROVIDER_AUTH`, and `circuitOpenUntil` is set: nothing
  is summoned until then.
- **Check**: the credential is present in this process, not expired, and
  allowed to start compute on this pool, cluster or function. Run the
  provider's `validate()`. Then `controller.reset()`, or reset from the UI
  (action `queues.summon`), rather than waiting out the circuit. To hear of
  an opened circuit as it happens, give the policy an `onSummonFailed`: it
  is told `circuit-open` once per opening.

### `misconfigured`: the config names something that is not there

- **Log**: an `error`, `compute provider <name> reported its config invalid
  for the platform (PROVIDER_MISCONFIGURED): the summon circuit is open at
  once, …`.
- **Status**: as `auth`, with the platform's code (`PoolNotFound`) or
  `PROVIDER_MISCONFIGURED`.
- **Check**: the names in the config (region, pool, cluster, task
  definition, function) exist, in that region and account. `validate()`
  usually says which.

### `quota`: an account or regional limit

- **Log**: a `warn`, `summoner call refused: the platform is throttling or
  over quota; recorded as unavailable`.
- **Status**: the last outcome is `unavailable`. It counts toward the
  circuit, and the next attempt waits at least as long as the platform asked
  (`backoffUntil`).
- **Check**: the platform's quota for the account or region, and whether
  `maxWorkers` asks for more than it allows.

### `throttled`: the platform is rate-limiting

- **Log**: the same `warn` as `quota`. When a controller's attempts are
  throttled `circuit.failures` times in a row, one more `warn` says so.
- **Status**: `unavailable`, **not** counted toward the circuit, and the
  next attempt waits at least as long as the platform asked, up to the larger
  of `backoff.max` and `circuit.resetAfter` (a longer request logs one `warn`
  and is clamped).
- **Check**: whether something else shares the credential's rate limit, and
  whether the `cooldown` is too short.

### `transient`: a 5xx or a network error

- **Log**: an `error`, `summoner call failed`, with the error (redacted).
- **Status**: `failed`, counted; after `circuit.failures` in a row the
  circuit opens (`summon circuit open: too many consecutive failures`).
- **Check**: the platform's status page, and the network path from this
  process to its API. A provider that throws something other than a
  `ProviderError` is treated this way too, and logs one `warn` per process
  that it should map it: report that to its author.

### `conflict`: a provider bug

- **Log**: an `error`, `compute provider <name> reported a conflict
  (PROVIDER_CONFLICT): its request was not a pure function of its key, which
  is a bug in the provider`.
- **Status**: `failed`, counted.
- **Check**: nothing on your side: report it to the provider's author.

### The provider is not ready

- **Log**: one `warn` per run, `the summoner's provider is not ready: its
  config validation failed or has not finished; each attempt fails without a
  call until it is (backoff and circuit apply)`.
- **Status**: `failed`, with the detail `ready timed out` or the
  validation error's code (`CONFIG`), and the summoner shown with
  `readiness: "pending"` or `"failed"` and no capabilities.
- **Check**: what the config reads asynchronously (a secret file, a secret
  store) is reachable from this process, and fast enough for
  `summonTimeout`. Await `ready` at startup to see the error itself.
