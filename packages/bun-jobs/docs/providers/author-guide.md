# Writing a compute provider

A step-by-step guide to writing a provider package for a platform: the summon
facet, which starts workers when a queue needs them. Every example is a file
of the starter template, **Acme Compute**, a fictional platform: the
template's own gate typechecks and tests those files, and a test holds each
excerpt here to them.

Look names up in [the API reference](./reference.md); read
[the security page](./security.md) before publishing.

## 1. What you are building

A provider is one object made by `defineComputeProvider`: an identity, a
config schema, and a **facet** for each thing it can do. This version has
one facet, **summon**: start compute running an ordinary bun-jobs worker,
because a queue has work and no worker.

The controller does the rest: it reads demand, decides when to summon,
claims each attempt in the backend so two controllers never summon twice for
one backlog, counts failures, backs off, opens a circuit, and notices when
the worker registers. The provider only talks to the platform: start units,
and optionally scale them to zero, explain a lost one, stop a pending one, and
check its config.

Write a provider when you publish support for a platform. For a platform
only your own code calls, `defineSummoner` (from
`@kingsleyweb/bun-jobs/summon`) is the same thing without the ceremony: a
function, no identity, no schema.

## 2. Start from the template

The template is
[`templates/compute-provider/`](https://github.com/kingsloob1/bun-node/tree/develop/templates/compute-provider)
in the bun-node repo:

```text
src/index.ts             the provider: identity, capabilities, summon, status, cancel, validate
src/config.ts            the config schema (toStandardSchema, no library)
src/errors.ts            the platform's errors → ProviderError, one table
test/fake-platform.ts    a fake of the platform's API, for the kit
test/conformance.test.ts runProviderConformance + assertConformance, green
test/errors.test.ts      the error table and Retry-After parsing
test/config.test.ts      the URL rule
scripts/build.ts         dist/: the bundle and the declarations
scripts/check-types.ts   packs, installs outside, type-checks as a user would
```

Copy the directory, rename the package `bun-jobs-provider-<platform>` (or
`@<scope>/bun-jobs-provider-<platform>`), and follow the checklist in its
README. It passes the conformance kit as it stands, so every change you make
from there is checked.

**Installing outside the bun-node repo.** The template's `package.json` has
`overrides` pointing `@kingsleyweb/bun-jobs` and `@kingsleyweb/bun-common` at
the repo's own package directories, which works only inside the repo. The
packages are not on npm yet, so a copy elsewhere packs both from a checkout
of bun-node (`bun pm pack`) and points `overrides` at the tarballs, as the
template's README describes in step 2. Not at the checkout's directories:
installed that way from outside the repo, bun-common arrives without its own
dependencies ([oven-sh/bun#44299](https://github.com/oven-sh/bun/issues/44299)).
Once the packages are published, remove `overrides`.

## 3. Identity and versions

<!-- excerpt: templates/compute-provider/src/index.ts -->

<!-- eslint-skip -->
```ts
export const acme = defineComputeProvider<ValidAcmeConfig, AcmeConfig>({
  // The npm package's name and version, kept equal to `package.json`.
  name: "bun-jobs-provider-example",
  version: "0.1.0",
  kind: "acme",
  displayName: "Acme Compute",
  // What this code was written against: literal, never the host's constant,
  // or the registration check could never catch a mismatch.
  apiVersion: { core: "0.1", summon: "0.1" },
  config: acmeConfigSchema,
  secrets: ["apiToken"],
  describe: (config) => ({ region: config.region, pool: config.pool }),
```

- **`name` and `version`** are the npm package's, kept equal to
  `package.json` (the template has a test that holds them equal). They are
  shown in logs, events, the status route and the UI, as `name@version`.
- **`kind`** is a short label: 1 to 24 characters of lowercase letters,
  digits and dashes.
- **`apiVersion`** says which plugin API versions this code was written
  against, per facet: `core` always, `summon` because it has a summon facet.
  Write them as **literals**. `COMPUTE_PROVIDER_API` is the host's version,
  so copying it would make every check pass whatever the host is.

What the checks say:

- **At definition** (when your module is imported), a different major, a
  facet without its version or a version without its facet is a
  `ConfigError`, naming which side to upgrade.
- **At registration** (when a controller is first handed your provider), a
  newer minor than the host speaks logs one `warn` (members added since are
  ignored), and so does the API being experimental (`0.x`); a second version
  of the same `name` in one process logs one too. Each is once per process
  per `name@version`.
- A provider's setup context carries `api`, the **negotiated** versions: the
  lower of yours and the host's minor. Branch on it to degrade, never on the
  host's `hostVersion`.

Repeat the versions in `package.json`, with the facets, so a user can check
compatibility before installing:

<!-- excerpt: templates/compute-provider/package.json -->

<!-- eslint-skip -->
```json
"bun-jobs": {
  "facets": [
    "summon"
  ],
  "apiVersion": {
    "core": "0.1",
    "summon": "0.1"
  }
}
```

## 4. Config

The config is any [Standard Schema](https://standardschema.dev): zod,
valibot, arktype, or `toStandardSchema` around a function, which the
template uses so it needs no validation library.

<!-- excerpt: templates/compute-provider/src/config.ts -->

<!-- eslint-skip -->
```ts
export const acmeConfigSchema: StandardSchemaV1<AcmeConfig, ValidAcmeConfig> =
  toStandardSchema<AcmeConfig, ValidAcmeConfig>((input) => {
    const issues = check(input);
    if (issues.length > 0) {
      return { issues };
    }
    const config = input as AcmeConfig;
    const valid = (apiToken: string): { value: ValidAcmeConfig } => ({
      value: {
        pool: config.pool,
        region: config.region,
        apiToken,
        url: (config.url ?? DEFAULT_URL).replace(/\/+$/, ""),
      },
    });
    if (config.apiToken !== undefined) {
      return valid(config.apiToken);
    }
    const path = config.apiTokenFile!;
    return Bun.file(path)
      .text()
      .then(
        (text) =>
          /^\S{8,}$/.test(text.trim())
            ? valid(text.trim())
            : {
                issues: [
                  {
                    message: `${path} does not hold a token`,
                    path: ["apiTokenFile"],
                  },
                ],
              },
        () => ({
          issues: [{ message: `cannot read ${path}`, path: ["apiTokenFile"] }],
        }),
      );
  });
```

- **Validate synchronously where you can.** Then an invalid config throws a
  `ConfigError` from `acme({ … })` at once, naming each issue's path.
- **An asynchronous schema is allowed**, for a config that must read a file
  or a secret store. Validation then **starts when the provider is called**,
  not at the first summon, and the configured provider's `ready` settles
  once it finishes. A controller waits for it, at most its `summonTimeout`;
  a rejection or that timeout is a failed attempt (detail
  `ready timed out`, or the error's code), and the next attempt validates
  again. A wait that timed out is **abandoned, not cancelled**: the
  validation keeps running, and a late success is adopted.
- **The facets receive the validated config**, the schema's output: here the
  token is resolved and the URL defaulted, so `summon` never reads a file.
- **Declare every secret** by its path in the validated config:
  `secrets: ["apiToken"]`. Its value is redacted from everything logged
  through the contexts, and a `describe()` fact holding it is dropped. Only
  strings of 8 characters or more are redacted by value, and a path must
  name a **leaf string**: a path to an object (`"credentials"`) or to a
  number redacts nothing.
- **`describe(config)`** returns facts for the UI: the region, the pool.
  Never a secret.
- **Issue messages never echo a value.** bun-jobs redacts the declared
  secrets from them anyway, but say what is wrong, not what was given. What
  the schema or the facet build throws is redacted too: `provider(config)`
  throws, and `ready` rejects with, a redacted copy of it.
- **Refuse a URL that would send the token in clear text.** The bearer token
  goes on every call, so Acme's `url` must be `https:`; plain `http:` is
  allowed only for `localhost`, `127.0.0.1` and `[::1]`, where a test's fake
  runs. `check()` calls this for `url`:

<!-- excerpt: templates/compute-provider/src/config.ts -->

<!-- eslint-skip -->
```ts
/** The hosts plain `http:` may reach: this machine only (a local fake, a tunnel). */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * What is wrong with a `url`, or `undefined`. The bearer token goes on every
 * call, so it crosses plain HTTP only to this machine.
 */
function urlProblem(url: unknown): string | undefined {
  const parsed = typeof url === "string" ? URL.parse(url) : null;
  if (parsed === null || parsed.hostname === "") {
    return "url must be an absolute https URL";
  }
  if (parsed.protocol === "https:") {
    return undefined;
  }
  if (parsed.protocol === "http:") {
    return LOOPBACK.has(parsed.hostname)
      ? undefined
      : `url must use https: the API token would cross the network in clear text (http is allowed only for ${[...LOOPBACK].join(", ")})`;
  }
  return `url must be an https URL, not ${parsed.protocol}`;
}
```

## 5. Declare capabilities truthfully

The controller never knows your platform by name. It reads what you declare,
and each declaration changes what it does:

<!-- excerpt: templates/compute-provider/src/index.ts -->

<!-- eslint-skip -->
```ts
/** What Acme can do, declared truthfully: the controller reads these instead of knowing Acme. */
const capabilities: SummonCapabilities = {
  // Every call starts new runs.
  style: "launch",
  // The controller clips `request.dedupeKey` to fit.
  dedupe: {
    kind: "token",
    maxLength: 64,
    charset: "A-Za-z0-9-",
    scope: "pool",
    ttlMs: 86_400_000,
    strict: true,
  },
  passes: "argv",
  // An image pull and a boot: the attempt counts as lost after this.
  bootBudgetMs: 90_000,
  shutdown: { signal: "SIGTERM", graceMs: 30_000 },
  // Acme stops any run after a day, and takes a shorter cap per run.
  maxLifetimeMs: 86_400_000,
  enforcesLifetime: true,
  maxCountPerCall: 10,
};
```

- **`style`**: `"launch"` starts new units on every call, so the attempt is
  claimed in the backend first and a race cannot double up. `"scale"` sets
  an absolute count (`request.target`), idempotently, and must have
  `release` to set it back to zero once the queue has been idle for
  `scaleDown.after`. `"wake"` starts one of a fixed pool: like launch, with
  `maxWorkers` clamped to `poolSize` (with a `warn`).
- **`dedupe`**: how the platform recognises a retried call. With
  `"token"` or `"name"`, the controller clips `request.dedupeKey` to
  `maxLength` characters of `charset`, so it always fits. With
  `strict: true` the platform refuses the same token with different
  parameters, so everything you send must be a function of the request's
  `id`. Declare the platform's real limits, and give the fake the same
  ones: the kit's `summon.capabilities.platform-limits` check compares
  `maxLength` with the fake's `tokenMaxLength` (and `maxLifetimeMs` with its
  `maxDurationMs`), as a `should`: a mismatch is a warning.
- **`passes`**: `"argv"` when the platform takes command-line arguments:
  the attempt's identity reaches the worker that way (step 8). `"none"` when
  the unit's command line is fixed.
- **`bootBudgetMs`**: how long an attempt counts as a worker on its way.
  Too short summons twice; too long delays the retry of a start that silently
  failed. The policy's `bootBudget` overrides it.
- **`shutdown`**: the platform's stop signal and its grace before
  `SIGKILL`. The grace reaches the worker as `--bun-jobs-summon-grace-ms`,
  and a grace below `runSummoned`'s 7,000 ms `shutdownBuffer` logs one
  `warn` per controller: a job in flight at the signal may be killed.
- **`maxLifetimeMs`**: the platform's own cap on one unit's life, or `null`.
  A policy `maxLifetime` above it is a `ConfigError`.
  **`enforcesLifetime`** says whether you pass `request.maxLifetimeMs` to the
  platform, as Acme does.
- **`maxCountPerCall`**: the most units one call may start; `count` is
  clamped to it.

A capability set the controller cannot read (a style it does not know, a
negative grace) is a `ConfigError` when the provider is configured, and a
scale style without `release` when the controller is built.

## 6. Implement `summon()`

Every platform call goes through one helper, which uses `ctx.fetch` and
`ctx.signal`:

<!-- excerpt: templates/compute-provider/src/index.ts -->

<!-- eslint-skip -->
```ts
/** One Acme API call, through `ctx.fetch` and `ctx.signal`, as every call must be. */
async function call(
  config: ValidAcmeConfig,
  ctx: ProviderCallContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  try {
    return await ctx.fetch(`${config.url}/v1/pools/${config.pool}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: ctx.signal,
    });
  } catch (error) {
    // An abort is the controller's own timeout: let it through as it is.
    throw ctx.signal.aborted ? error : unreachable(error);
  }
}
```

- **`ctx.fetch`, never the global `fetch`.** The conformance kit routes
  every call to the fake through it, and fails a provider that bypasses it.
- **`ctx.signal`** aborts when the call's `summonTimeout` passes. Honour it:
  let the abort through as it is, and leave no timer behind.
- **Log through `ctx.logger`**: it is bound to the queue and the attempt,
  and redacts.

The facet itself:

<!-- excerpt: templates/compute-provider/src/index.ts -->

<!-- eslint-skip -->
```ts
summon: (config) => ({
  capabilities,

  // Everything sent is a function of the request's id, never of `demand`
  // or `reason`: Acme refuses a token reused with different parameters.
  summon: async (request, ctx) => {
    const response = await ok(config, ctx, "POST", "/runs", {
      clientToken: request.dedupeKey,
      count: request.count,
      args: request.argv,
      env: request.env,
      maxRuntimeSeconds: Math.ceil(request.maxLifetimeMs / 1_000),
    });
    const answer = (await response.json()) as RunsAnswer;
    if (answer.failures !== undefined && answer.failures.length > 0) {
      return { status: "unavailable", reason: answer.failures[0]!.reason };
    }
    const handles = answer.runs.map((run) => run.id);
    // 201: new runs. 200: the token was seen, and these are the earlier runs.
    return response.status === 201
      ? { status: "started", handles }
      : { status: "deduped", handles };
  },
```

- **Answer a `SummonResult` when the platform answered normally**:
  `started` with the handles, `deduped` when its token says this attempt
  already ran, `already-running` when the unit was up, and `unavailable` for
  "no capacity" said with a 200. **Throw a `ProviderError` when it did not**
  (step 7).
- **Handles are the platform's plain identifiers**, and never hold a
  credential: not a pre-signed URL, not a token-bearing id. bun-jobs never
  redacts them: they are stored on the queue's summon state, emitted on the
  `summon` event, passed back to `status()` and `cancel()`, and served with
  `serialize.exposeSummonHandles`.
- **Under a strict token, send only what is a function of the request's
  `id`**: `dedupeKey`, `count`, `argv`, `env`, `maxLifetimeMs`. Never
  `demand` or `reason`, which differ between two readings of the same
  attempt. The kit's purity check is a `must` for a strict platform.
- **`request.count`** is how many units to start; `request.target`, for a
  scale style, the absolute count to run.
- **`request.env`** is the policy's static environment, never identity.

## 7. Map errors

One table from the platform's codes to the six `ProviderError` kinds, in
[`src/errors.ts`](https://github.com/kingsloob1/bun-node/blob/develop/templates/compute-provider/src/errors.ts):

<!-- excerpt: templates/compute-provider/src/errors.ts -->

<!-- eslint-skip -->
```ts
/** Acme's error codes, by the kind each means. The code decides first: Acme sends 429 for two kinds. */
const BY_CODE: Readonly<Record<string, ProviderErrorKind>> = {
  RateLimited: "throttled",
  QuotaExceeded: "quota",
  InvalidToken: "auth",
  Forbidden: "auth",
  PoolNotFound: "misconfigured",
  InvalidParameter: "misconfigured",
  TokenReused: "conflict",
};
```

The kind decides what the controller does:

- `transient` (a 5xx, a network error, anything unknown): `failed`, counted
  toward the circuit, the usual backoff.
- `throttled` (a 429, a rate limit): `unavailable`, **not** counted, and the
  next attempt waits at least `retryAfterMs`.
- `quota` (an account or regional limit): `unavailable`, counted, and waits
  at least `retryAfterMs`.
- `auth` (credentials missing or rejected): `failed`, and the circuit opens
  **at once**, with an `error` naming your provider.
- `misconfigured` (the config names something that is not there): as
  `auth`.
- `conflict` (a token reused with other parameters): `failed`, counted, with
  an `error` saying your request was not a pure function of its key: a bug to
  fix.

Anything else thrown is `transient`, and a provider made with
`defineComputeProvider` then logs one `warn` per process saying it should be
mapped.

The code in a body is looked up as an **own property** of the table, and the
platform's `Retry-After` is read **strictly**:

<!-- excerpt: templates/compute-provider/src/errors.ts -->

<!-- eslint-skip -->
```ts
/**
 * What the controller may show as the attempt's detail: a platform code is
 * shown to API clients, so only a code-shaped value from the table passes,
 * never free text from the body.
 */
function platformCodeOf(code: unknown): string | undefined {
  // `Object.hasOwn`, not `in`: `in` also finds `constructor`, `toString` and
  // `__proto__` on the prototype, and a body naming one would then map to a
  // function instead of a kind.
  return typeof code === "string" && Object.hasOwn(BY_CODE, code)
    ? code
    : undefined;
}

/** RFC 9110 delay-seconds: digits only, so `0x10`, `1e3`, `1.5` and `-3` are not. */
const DELAY_SECONDS = /^\d+$/;

/**
 * The start of an RFC 9110 HTTP-date, in each of its three forms
 * (`Sun, 06 Nov 1994 …`, `Sunday, 06-Nov-94 …`, `Sun Nov  6 …`). Checked
 * before `Date.parse`, which also reads `1.5` and `-3` as dates.
 */
const HTTP_DATE = /^[A-Z][a-z]{2,8},? /;

/**
 * `Retry-After` in ms: delay-seconds, or an HTTP-date (the time left, 0 once
 * it has passed). `undefined` when absent or in any other form, so the
 * controller's own backoff applies.
 */
function retryAfterMs(header: string | null, now: number): number | undefined {
  const value = header?.trim() ?? "";
  if (DELAY_SECONDS.test(value)) {
    return Number(value) * 1_000;
  }
  const date = HTTP_DATE.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
```

And the error itself:

<!-- excerpt: templates/compute-provider/src/errors.ts -->

<!-- eslint-skip -->
```ts
export async function acmeError(
  response: Response,
  now: number,
): Promise<ProviderError> {
  const body = (await response.json().catch(() => undefined)) as
    | { error?: { code?: unknown } }
    | undefined;
  const platformCode = platformCodeOf(body?.error?.code);
  const kind =
    (platformCode === undefined ? undefined : BY_CODE[platformCode]) ??
    byStatus(response.status);
  const wait = retryAfterMs(response.headers.get("retry-after"), now);
  return new ProviderError(
    `Acme answered ${response.status}${platformCode === undefined ? "" : ` ${platformCode}`}`,
    kind,
    {
      ...(platformCode === undefined ? {} : { platformCode }),
      status: response.status,
      ...(wait === undefined ? {} : { retryAfterMs: wait }),
    },
  );
}

/** A request that never got an answer (DNS, a refused connection): `transient`, keeping the cause. */
export function unreachable(cause: unknown): ProviderError {
  return new ProviderError("Acme did not answer", "transient", { cause });
}
```

- **`platformCode` is served to API clients** as the attempt's detail, and
  only when it is code-shaped (`[A-Za-z0-9_.:-]{1,64}`); otherwise the
  detail is `PROVIDER_<KIND>`. Take it only from the table of codes you
  know, never from a body as it came, and look it up with `Object.hasOwn`,
  not `in`: `in` also finds `constructor`, `toString` and `__proto__` on the
  prototype, so a body naming one would map to a function instead of a kind.
- **The message says the status and the code only.** An error body can echo
  the request, token and all. The message and the `cause` are logged,
  redacted, and never served.
- **`retryAfterMs`** comes from the platform's `Retry-After`, read as RFC
  9110 allows and nothing more: delay-seconds (digits only, so `0x10`, `1e3`,
  `1.5` and `-3` are refused), or an HTTP-date, recognised by its day-name
  start before `Date.parse` sees it (which would also read `1.5` and `-3` as
  dates), giving the time left and 0 once it has passed. Any other form is
  `undefined`, and the controller's own backoff applies. The controller also
  ignores a value that is not a finite number of 0 or more, and clamps one
  above the larger of `backoff.max` and `circuit.resetAfter`, with a
  `warn`.
- **A network failure is `transient`**, with the original error kept as
  `cause`. An abort is the controller's own timeout: let it through
  unwrapped, as `call()` does.

## 8. Hand over the summon id

The controller puts the attempt's identity in `request.argv`, as
`--bun-jobs-summon-*=` arguments: its id, the provider's kind, the mode
(`until-stopped` for a scale style, `exit-on-idle` otherwise), the namespace
and queue, the maximum lifetime and the grace. Pass them to the unit's command line, as Acme's `args` does. The
worker reads them with `summonedFromArgs()`, and its heartbeat record carries
the id back, which is how the controller knows **this** attempt registered:

```ts
// worker.ts: what the platform runs.
import { BunJobs, runSummoned, summonedFromArgs } from "@kingsleyweb/bun-jobs";

const summon = summonedFromArgs(); // undefined when not summoned
const jobs = new BunJobs({
  namespace: summon?.namespace ?? "shop",
  driver: { type: "redis", url: process.env.REDIS_URL! },
});
const worker = jobs.worker(
  summon?.queue ?? "emails",
  async (job) => ({ sent: job.id }),
  { summon },
);
await runSummoned(worker); // runs, drains, and exits inside the grace
```

- **Arguments, never environment variables.** An environment leaks to every
  process the worker spawns, and a child that read it would claim the
  worker's attempt. There is no `passes: "env"`.
- **`passes: "none"`** is for a platform whose command line is fixed. The
  worker then gets no id, and an attempt is released by **start time**: any
  live worker that started at most 5 s before the attempt counts. That is
  weaker: a worker already starting for another reason can release an
  attempt whose own unit then fails unnoticed.

## 9. Optional hooks

<!-- excerpt: templates/compute-provider/src/index.ts -->

<!-- eslint-skip -->
```ts
// Asked once when an attempt is declared lost, to explain it.
status: async (handles, ctx) => {
  const response = await ok(
    config,
    ctx,
    "GET",
    `/runs?ids=${handles.map(encodeURIComponent).join(",")}`,
  );
  const answer = (await response.json()) as StatusAnswer;
  return handles.map((handle) => {
    const run = answer.runs.find((one) => one.id === handle);
    return {
      handle,
      state:
        (run === undefined ? undefined : STATES[run.state]) ?? "unknown",
      ...(run?.exitCode === undefined ? {} : { exitCode: run.exitCode }),
    };
  });
},

// Stops runs still queued when an attempt is declared lost.
cancel: async (handles, ctx) => {
  await ok(config, ctx, "POST", "/runs/stop", { ids: handles });
},
```

- **`status(handles)`** is asked once, when an attempt is declared lost:
  the `detail` of the first unit that has one (`CannotPullContainerError`,
  `OOMKilled`) becomes the lost event's detail and the attempt's `last.detail`. The event
  waits for it, bounded by `summonTimeout`.
- **`cancel(handles)`** stops units still pending when their attempt is
  lost, so one cannot start late. Best effort.
- **`release(request)`** is required for a scale style: set the count to
  `request.target`, usually `0`.
- **`validate(config, ctx)`** is a preflight that starts nothing: can this
  config reach the platform? Answer one `ProviderCheck` per finding. Users
  call it as `configured.validate()`. bun-jobs does not redact the checks'
  `detail`: keep it secret-free.

<!-- excerpt: templates/compute-provider/src/index.ts -->

<!-- eslint-skip -->
```ts
// A preflight that starts nothing: can the token read the pool?
validate: async (config, ctx): Promise<ProviderCheck[]> => {
  const response = await call(config, ctx, "GET", "");
  if (response.ok) {
    return [
      { id: "credentials", status: "pass" },
      { id: "pool", status: "pass" },
    ];
  }
  const error = await acmeError(response, ctx.now());
  if (error.kind === "auth") {
    return [{ id: "credentials", status: "fail", detail: error.message }];
  }
  if (error.kind === "misconfigured") {
    return [
      { id: "credentials", status: "pass" },
      {
        id: "pool",
        status: "fail",
        detail: `${error.message}: is the pool in ${config.region}?`,
      },
    ];
  }
  throw error;
},
```

A scale-style platform looks like this; the controller calls `summon` with
the count it wants and `release` to go back to zero:

```ts
import type { SummonFacet } from "@kingsleyweb/bun-jobs/provider";
import { ProviderError } from "@kingsleyweb/bun-jobs/provider";

/** A worker pool whose instance count the platform keeps. */
export function poolFacet(url: string): SummonFacet {
  /** Sets the pool's instance count. */
  const setCount = async (
    count: number,
    signal: AbortSignal,
    fetchFn: typeof fetch,
  ): Promise<void> => {
    const response = await fetchFn(`${url}/pool`, {
      method: "PUT",
      body: JSON.stringify({ count }),
      signal,
    });
    if (!response.ok) {
      throw new ProviderError(`the pool answered ${response.status}`, "transient", {
        status: response.status,
      });
    }
  };
  return {
    capabilities: {
      style: "scale",
      dedupe: { kind: "none" },
      passes: "none",
      bootBudgetMs: 120_000,
      shutdown: { signal: "SIGTERM", graceMs: 30_000 },
      maxLifetimeMs: null,
      enforcesLifetime: false,
    },
    summon: async (request, ctx) => {
      await setCount(request.target, ctx.signal, ctx.fetch);
      return { status: "started", handles: [] };
    },
    release: async (request, ctx) => {
      await setCount(request.target, ctx.signal, ctx.fetch);
    },
  };
}
```

## 10. Write the fake

The conformance kit tests against a fake of your platform's API, not the
platform. `fakePlatform(routes, options)` from
`@kingsleyweb/bun-jobs/provider/testing` serves it on port 0 and keeps the
books (units, the token memory, injected faults, the request log), so a fake
is your platform's routes and error bodies:

<!-- excerpt: templates/compute-provider/test/fake-platform.ts -->

<!-- eslint-skip -->
```ts
const runs = async (
  request: Request,
  state: FakePlatformState,
): Promise<Response> => {
  const refused = refuse(request);
  if (refused !== undefined) {
    return refused;
  }
  const text = await request.text();
  const body = JSON.parse(text) as RunsBody;
  if (
    !/^[A-Z0-9-]{1,64}$/i.test(body.clientToken) ||
    !(body.count >= 1 && body.count <= 10) ||
    !(body.maxRuntimeSeconds >= 1 && body.maxRuntimeSeconds <= 86_400)
  ) {
    return acmeError(400, "InvalidParameter");
  }
  const earlier = state.recall(body.clientToken);
  if (earlier !== undefined) {
    return bodies.get(body.clientToken) === text
      ? Response.json({ runs: earlier.map((unit) => ({ id: unit.handle })) })
      : acmeError(409, "TokenReused");
  }
  bodies.set(body.clientToken, text);
  const started = Array.from(
    { length: body.count },
    () =>
      state.start({
        argv: body.args,
        env: body.env ?? {},
        token: body.clientToken,
      }).handle,
  );
  return Response.json(
    { runs: started.map((id) => ({ id })) },
    { status: 201 },
  );
};
```

- **Answer a remembered token the way the platform does**: `state.recall`
  finds it, and every token passed to `recall` or `start` is what the kit's
  dedupe checks read.
- **Render each fault as the platform does**, so your error table is tested
  against the real shapes:

<!-- excerpt: templates/compute-provider/test/fake-platform.ts -->

<!-- eslint-skip -->
```ts
{
  limits: { tokenMaxLength: 64, maxDurationMs: 86_400_000 },
  // Each failure the kit injects, as Acme sends it.
  faults: {
    transient: () => acmeError(503, "ServiceUnavailable"),
    throttled: (_request, { retryAfterMs }) =>
      acmeError(429, "RateLimited", {
        "retry-after": String(Math.ceil(retryAfterMs / 1_000)),
      }),
    quota: (_request, { retryAfterMs }) =>
      acmeError(429, "QuotaExceeded", {
        "retry-after": String(Math.ceil(retryAfterMs / 1_000)),
      }),
    auth: () => acmeError(401, "InvalidToken"),
    misconfigured: () => acmeError(404, "PoolNotFound"),
    conflict: () => acmeError(409, "TokenReused"),
    "capacity-200": () =>
      Response.json({
        runs: [],
        failures: [{ reason: "InsufficientCapacity" }],
      }),
  },
},
```

A fake proves the provider against the fake. Keep its status codes and bodies
faithful to the platform's documentation.

## 11. Run the kit

<!-- excerpt: templates/compute-provider/test/conformance.test.ts -->

<!-- eslint-skip -->
```ts
it("passes the conformance kit", async () => {
  const platform = await fake();
  const config = configFor(platform);
  const report = await runProviderConformance(acme, {
    config,
    // Each should be refused with a ConfigError naming its path.
    invalidConfigs: [
      { config: { ...config, region: "EU West" }, path: "region" },
      {
        config: { url: platform.url, region: "eu-west", pool: "workers" },
        path: "apiToken",
      },
      {
        config: {
          ...config,
          apiToken: undefined,
          apiTokenFile: "/nonexistent/acme-token",
        },
        path: "apiTokenFile",
      },
    ],
    platform,
  });
  // Throws with the report when a `must` check fails.
  assertConformance(report);
  // A `should` that failed reads `warn`, which assertConformance allows: this provider has none.
  expect(report.checks.filter((check) => check.status === "warn")).toEqual(
    [],
  );
  // What the kit skipped, and nothing else: a check that stops running is a
  // regression too. These are the scale and wake checks, and Acme launches.
  expect(
    report.checks
      .filter((check) => check.status === "skip")
      .map((check) => check.id),
  ).toEqual([
    "summon.capabilities.scale-has-release",
    "summon.capabilities.wake-has-pool-size",
    "summon.scale.target-idempotent",
    "summon.scale.release-to-zero",
    "summon.handoff.scale-down",
  ]);
  // `passes: "argv"`: the worker got its summon id, so the attempt was released by it.
  expect(
    report.checks.find((check) => check.id === "summon.handoff.released")
      ?.detail,
  ).toBe("by id");
});
```

- **`runProviderConformance`** runs every check and answers a report; it
  never throws for a failing provider. **`assertConformance`** throws on a
  failed `must` check, with the report as its message, and never on a
  `should` warning.
- It needs **no credentials**. It configures your provider with `config`,
  and again with a canary wherever a declared secret path holds a string in
  that config. Its `summon.secrets.no-leak` check then looks, in everything
  bun-jobs would log or store, for the canaries **and** for every declared
  secret's real validated value, so a secret your schema derives (Acme's
  token read from `apiTokenFile`) that leaks fails it too; a leak names its
  declared path. The look by value is as the controller redacts, and covers
  secrets of 8 characters or more, the redactor's floor: a shorter one, or
  one that is not a string, is not looked for by value (nor redacted), and
  the check's detail appends "; N declared secret(s) under 8 characters are
  not redacted, so not checked by value" or "; N declared secret(s) are not
  strings, so not checked by value". A string at a declared path of your `config` is still
  replaced by a canary whatever its length, and the canary is looked for.
- **`invalidConfigs`** are configs your schema must refuse, each with the
  path its issue should name.
- **The handoff** starts real worker processes and a real
  `SummonController` on a backend two processes share: a temporary SQLite
  file unless `driver` names one. The memory driver is refused.
- **Checks skip** when a declared capability makes them inapplicable (the
  scale checks for a launch style), when you skip them (`skip: [{ id,
  reason }]`), or when a check they depend on failed. Assert the skips you
  expect, as the template does: a check that stops running is a regression
  too.
- **Some `must` checks skip silently, and `ok` stays `true`**: give the kit
  what they need, or the report says less than it seems to.
  - `summon.config.rejects-invalid` skips without `invalidConfigs`;
  - `summon.secrets.no-leak` skips when the provider declares no secrets;
  - `summon.validate.healthy`, `summon.validate.auth-fails` and
    `summon.validate.starts-nothing` skip when it has no `validate()`;
  - the `should` check `summon.capabilities.platform-limits` skips when the
    fake declares no `limits`.
- **`summon.describe.facts`** warns about exactly the facts the status
  route drops whatever its settings, by the very rule the route uses: a key
  named like a credential (the same `isCredentialKey` rule), a value holding
  a URL with credentials in it, or a value holding another credential shape
  the pattern redactor would change (`Bearer …`, a JWT,
  `session-workers:prod`, `max_tokens=4096`). A `host` fact, dropped only
  while `serialize.exposeHosts` is off, is not warned about.
- **`report.toMarkdown()`** renders a checklist headed "tested against a
  fake": publish it with the package.

## 12. Security obligations

In short (the [security page](./security.md#for-provider-authors) has the
reasons):

- declare every secret; log through `ctx.logger`; call through `ctx.fetch`;
- never put a credential in `describe()`, a `platformCode`, an
  `unavailable` reason, a unit's detail, a check's detail, or a **handle**
  (a pre-signed URL, a token-bearing id): handles are never redacted;
- declare secrets by leaf-string paths, 8 characters or more;
- take platform codes from a table, as own properties (`Object.hasOwn`);
- parse `Retry-After` strictly: delay-seconds or an HTTP-date, nothing else;
- say only the status and the code in an error message;
- send credentials over HTTPS only: refuse an `http:` URL except for
  `localhost`, `127.0.0.1` and `[::1]`;
- no install scripts, and no cloud SDK: `fetch` and WebCrypto are enough.

## 13. Publish

- **Name**: `bun-jobs-provider-<platform>`, or
  `@<scope>/bun-jobs-provider-<platform>`.
- **Keywords**: `bun-jobs-provider` and `bun-jobs-provider-summon`, so it can
  be found.
- **The `"bun-jobs"` field** in `package.json`: the facets and their
  `apiVersion`, equal to the code's.
- **The peer range**: `@kingsleyweb/bun-jobs` as a peer dependency, one minor
  wide while the plugin API is `0.x`, since any `0.x` minor may change it.
- **Ship declarations** that import only bun-jobs' public entries: the
  template's `scripts/check-types.ts` packs the package, installs it outside,
  and typechecks it as a user would.
- **Publish the kit's report**, so users know what was tested, and that it
  was tested against a fake.
