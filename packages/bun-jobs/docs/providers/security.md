# Security

What a compute provider can do, what bun-jobs does to keep its secrets out
of logs and out of the management API, and what it cannot do for you. Read
it before installing a provider, and before publishing one.

Everything below describes this version's code; each section names the file
that implements it.

## A provider is not sandboxed

A provider is code you imported into your process. It runs with everything
the process has: `process.env`, the filesystem, the network, and every object
it is handed. **bun-jobs provides no sandbox.** And a provider holds a
credential that can start compute, which costs money.

What bun-jobs does control is what it hands a provider and what it does with
what the provider hands back.

## What a provider is given

- **At configuration**, its own validated config, and a setup context of
  three things: the negotiated API versions (`api`), the host's bun-jobs
  version (`hostVersion`), and a redacting `logger`.
- **On every call**, the request and a call context of four things: an abort
  `signal`, a redacting `logger`, the `fetch` to use, and the clock (`now`).

The request carries the queue's namespace and name, the attempt's `id` and
`dedupeKey`, how many workers to start, a demand reading (job counts, never
job data), the policy's static `env`, the worker's `argv` and its maximum
lifetime. **No context carries the driver**, so a provider never reads a job,
a payload or another queue's state.

Source: [`lib/provider/context.ts`](../../lib/provider/context.ts),
[`lib/summon/types.ts`](../../lib/summon/types.ts).

## Declared secrets

A provider lists the paths of its config that hold secrets:

```ts
import { defineComputeProvider } from "@kingsleyweb/bun-jobs/provider";

/** The validated config. */
interface Config {
  /** The platform's API token. */
  apiToken: string;
  /** Where credentials for a second service live. */
  credentials: {
    /** Its access key id. */
    accessKeyId: string;
    /** Its secret key. */
    secretAccessKey: string;
  };
}

export const provider = defineComputeProvider<Config>({
  name: "bun-jobs-provider-example-secrets",
  version: "1.0.0",
  kind: "example",
  apiVersion: { core: "0.1" },
  secrets: ["apiToken", "credentials.secretAccessKey"],
});
```

- A path is dotted, into the **validated** config (what the schema outputs,
  not what the user passed). A path that is not there is ignored.
- **A path must name a leaf string.** A path to an object
  (`"credentials"`) or to a number redacts nothing: name each string inside
  it (`"credentials.secretAccessKey"`).
- Only **string values of 8 characters or more** are redacted by value. A
  shorter one would take ordinary words with it, so it is not, and nothing
  warns about it at run time (only the conformance kit's
  `summon.secrets.no-leak` detail notes it): make sure a real secret is
  longer.
- Before an asynchronous config has validated, the values at the same paths
  of the **input** are what is redacted.
- The configured provider's `config` still holds the secrets. bun-jobs never
  serialises it; never serialise it yourself.

Source: [`lib/provider/configure.ts`](../../lib/provider/configure.ts)
(`secretValues`), [`lib/provider/redact.ts`](../../lib/provider/redact.ts)
(`MIN_SECRET_LENGTH`).

## What redaction does

Every logger a provider is handed (at setup, on every call, and in
`validate()`) passes every message, field and child binding through two
passes before your logger sees it:

1. **By value**: each declared secret of 8 characters or more is replaced
   wherever it appears, prose included, longest first: as it is, and
   URL-encoded both as `encodeURIComponent` writes it (`a%2Fb` for `a/b`)
   and as `URLSearchParams` writes it (`+` for a space). A declared secret
   under 8 characters is not replaced, raw or encoded.
2. **By shape**, the runner's redactor with its defaults: the value of a
   `key=value`, `key: value` or JSON `"key": …` pair under a sensitive key
   (`password`, `secret`, `token`, `apikey`, `authorization`, `auth`,
   `credential`, `cookie`, …), a bare `Bearer …`, the password in a URL and
   a JSON Web Token; then a bare `Basic <base64>`, **only** when the base64
   decodes to a `user:password` pair (it becomes `Basic [REDACTED]`, and
   prose such as "Basic authentication failed" is left alone); the value of
   an `X-Amz-Signature=` parameter (any case: an S3 pre-signed URL's
   signature); and the value of an Azure SAS `sig=` parameter (as a whole
   key only, so `xsig=` and `signal=` are left alone).

**A URL's userinfo is replaced whole**, in messages and in fields alike,
whatever it holds: a token alone before the `@` (`https://ghp_…@github.com`),
a DSN's key.

Then, for fields:

- **A field named like a credential** has its value replaced whole (an
  absent one stays absent). A name counts when one of its words (split at
  camelCase humps, `_`, `-`, `.` and spaces) is one of `token`, `secret`,
  `key`, `password`, `passwd`, `pwd`, `credential`, `auth`,
  `authorization`, `bearer`, `private`, `cookie` or `session`, singular or
  plural, or when the whole name, lower-cased with its separators removed,
  ends with one. `apiKey`,
  `authToken`, `api_key` and `sessiontoken` count; `author`, `keyspace` and
  `tokenizerModel` do not; `monkey` does, which errs the safe way.
- **Other shapes are read first**: a `URL` as its text, `Headers`,
  `URLSearchParams` and a `Map` as their entries, a `Set` as its items, any
  other class instance as its own fields. An error's message, stack, `cause`
  and own fields are walked too, and keep its class. A `RegExp` is logged as
  its text, redacted. A `Date` is passed as it is.
- **An object with a `toJSON` method**, other than a `Date`, a `URL` or an
  error, is logged as what `toJSON` returns, redacted: what `JSON.stringify`
  would write, so a sink cannot call it and bring a secret back. The call is
  guarded: a throwing read or call is logged as `[Unreadable]`. The result is
  walked like any value, so a `toJSON` returning its own object is cut at
  `[Circular]`, and an endless chain stops at the depth limit as
  `[REDACTED]`.
- **Binary data is never logged as bytes**: a `Buffer`, any typed array, an
  `ArrayBuffer`, a `SharedArrayBuffer` or a `DataView` is logged as
  `[Binary <n> bytes]`, since a sink could decode the bytes to text.
- **Anything deeper than 8 levels is replaced**, never passed through, and a
  value that cannot be read (a throwing getter, a revoked proxy) is logged as
  `[Unreadable]`. A log call never throws.

The controller's own log lines about a provider go through the same
redaction: a thrown error and its `cause`, an `unavailable` reason, a unit's
detail.

**What it misses**: a declared secret shorter than 8 characters, and
anything that is neither at a declared path nor in one of the shapes above
(a secret in prose, "the password is hunter2", or another token format).
Declaring secrets is how a provider closes that gap for its own values.

Source: [`lib/provider/redact.ts`](../../lib/provider/redact.ts),
[`lib/shared/credentialKeys.ts`](../../lib/shared/credentialKeys.ts),
[`lib/runner/redact.ts`](../../lib/runner/redact.ts).

## Config errors

A config the schema rejects is a `ConfigError` whose message and `issues`
carry each issue's **path and message**, with the input's declared secret
values and the credential shapes above redacted from the messages. The
values themselves are not included.

A schema that **throws** rather than answering issues, and a facet build
(the definition's `summon`) that throws, are the provider's own code, and
their error may quote the config. So bun-jobs never passes it on as it is:

- **Synchronously**, `provider(config)` throws a **redacted copy**: the same
  class and fields, with the declared secrets (raw and URL-encoded, 8
  characters or more) and the credential shapes above removed from its
  message, stack, `cause` and fields. The original error is untouched.
- **Asynchronously**, `ready` rejects with the same redacted copy, and a
  controller logs and records that. A `ProviderError` keeps its `kind`,
  `code`, `platformCode`, `status` and `retryAfterMs`, so the controller
  treats it as it would unredacted.

An invalid config's `ConfigError` is redacted as described above, either
way.

Source: [`lib/provider/configure.ts`](../../lib/provider/configure.ts)
(`invalid`).

## The facts filter

A provider's `describe(config)` returns facts for the status route and the
UI: a region, a pool, an app name. It must never return a secret, and two
filters drop what would leak if it did:

1. **When the configured provider answers `describe()`**: a fact whose value
   is a declared secret, or contains one of 8 characters or more, is dropped.
2. **When the status route serialises it**: a fact is dropped when its value
   is not a string, when its **key** names a credential (the word rule above:
   `apiKey`, `secretArn`, `sessiontoken` go, `keyspace` stays), when its
   **value** holds a URL with userinfo (`postgres://user:pass@…`), whatever
   its key, and, unless `serialize.exposeHosts` is on, when its key is `host`
   or `hostname`.

While a provider's config is still validating, and after its facet failed to
be adopted (its capabilities raised a `ConfigError`), the status route shows
no summoner at all rather than a provisional one.

Source: [`lib/provider/configure.ts`](../../lib/provider/configure.ts)
(`describe`), [`lib/api/serialize.ts`](../../lib/api/serialize.ts)
(`isServableFact`).

## The attempt's detail

Every attempt's outcome is stored on the queue's summon state with a short
**detail**, and served to API clients: on `status().last.detail`, on the
status route and on the `summon` event. It comes from, in order:

- a `ProviderError`'s `platformCode`, else its `PROVIDER_<KIND>` code;
- any other error's `code`, else its `name`, else `"error"`;
- `"timeout"` for a call that ran past `summonTimeout`, and
  `"ready timed out"` for a config that did not validate in time;
- an `unavailable` result's `reason`;
- for a lost attempt, the `detail` of the first unit that has one in the
  provider's `status()` answer, or the controller's own `died` or
  `exited-with-error`.

The rules, in the order they apply:

- **Code-shaped only.** A `platformCode`, `code` or `name` is used only if
  it matches `[A-Za-z0-9_.:-]{1,64}`: an identifier, not prose. A response
  body, a URL or a message passed as one is refused, and the next choice is
  taken. An error's **message** and `cause` never become the detail: they go
  to the log, redacted.
- **Redact, then cut.** Every detail is redacted (declared secrets by value,
  then the shapes above), and only then cut to **128 characters**, the last
  being `…`. The order matters: cutting first could split a secret, and a
  secret's remainder no longer matches its value.
- **A code-shaped credential is not caught.** `sk_live_abc123` passes the
  code rule and matches no redaction pattern, so it would be stored and served
  verbatim. Only a value the provider declares in `secrets`, of 8 characters
  or more, is redacted wherever it appears. **So a provider must never put a
  credential in a
  `platformCode`, an error's `code` or `name`, an `unavailable` reason or a
  unit's detail.**

An `unavailable` reason and a unit's detail are not held to the code rule,
only redacted and cut: keep them short and secret-free.

Source: [`lib/summon/controller.ts`](../../lib/summon/controller.ts)
(`CODE_SHAPED`, `errorDetail`, `DETAIL_MAX`, `#redactDetail`).

## Throttling cannot stop summoning for good

Two limits keep a platform's answers, or a provider's bugs, from holding a
queue's summoning back without anyone noticing:

- **The `retryAfterMs` clamp.** A `throttled` or `quota` `ProviderError`, or
  an `unavailable` result, may ask for a wait. A value that is not a finite
  number of 0 or more is ignored (the `ProviderError` constructor already
  drops one, and rounds up a fraction). One above the larger of the policy's
  `backoff.max` and `circuit.resetAfter` is clamped to it, and the first
  clamp logs one `warn` per controller. Without the clamp, a `throttled`
  answer, which never opens the circuit, could stop summoning until someone
  called `reset()`.
- **The throttle-run warn.** A `throttled` answer is not counted toward the
  circuit, and without a `retryAfterMs` the backoff after it does not grow
  (it is `backoff.initial` when nothing else has failed). So a platform that
  throttles every call is retried at that pace, bounded only by the cooldown and the budget, and the circuit
  never opens. When a controller's attempts are throttled `circuit.failures`
  times in a row it logs one `warn` saying so; any other outcome ends the
  run, and a new run can warn again. The count is per controller and in
  memory.

The budget (`perHour`, `perDay`) bounds the attempts either way.

Source: [`lib/summon/controller.ts`](../../lib/summon/controller.ts)
(`#retryAfter`, `#noteThrottled`),
[`lib/provider/errors.ts`](../../lib/provider/errors.ts).

## Handles

The handles `summon()` returns (a task ARN, a run id) are the platform's
names for what it started, and bun-jobs keeps them exactly as given: they
are **never redacted**. They are stored raw on the queue's summon state,
emitted on the `summon` event (which travels through the backend to every
subscriber), passed back to the provider's `status()` and `cancel()`, and
served by the management API when `serialize.exposeSummonHandles` is on.

**So a handle must never hold a credential**: not a pre-signed URL, not an
id with a token in it. Return the platform's plain identifier, and keep
anything secret in the config.

## What never reaches API clients

The management API serves a queue's summon status (`queues.read`) and the
`summon` event. From a provider it serves only:

- its identity: `name`, `version`, `kind`, `displayName`, `homepage`,
  `apiVersion`;
- its declared capabilities;
- its facts, after both filters;
- each attempt's id, times, count, kind and outcome, and the detail above.

It never serves:

- **the config**, or the value of a declared secret of **8 characters or
  more**: it is redacted from every detail and dropped from the facts. A
  shorter one is not redacted, deliberately: a short value would match
  ordinary words and ids. Declare secrets that long, which real ones are;
- **what the provider logs**: log lines go to your logger, redacted;
- **an error's message or `cause`**: only the detail;
- **platform handles** (a task ARN carries the AWS account id), unless
  `serialize.exposeSummonHandles` is on, on both the status route and a
  summoned worker's record. That switch guards the API's edge only: the
  `summon` event carries its handles through the backend, so a
  `JobsNotifier`, a subscribing `BunQueue` or a `serialize.event` hook sees
  them. **Handles are never redacted** (see [Handles](#handles));
- **a `host` or `hostname` fact**, unless `serialize.exposeHosts` is on.

`ConfiguredProvider.validate()` answers the code that calls it. bun-jobs
does not redact its checks' `detail`, so write them secret-free.

"Summon now" and reset (`queues.summon`) spend money, so that action is
opt-in and removed by `readOnly`.

Source: [`lib/api/serialize.ts`](../../lib/api/serialize.ts)
(`toSummonStatusDto`), [`lib/api/config.ts`](../../lib/api/config.ts).

## For provider authors

- **Declare every secret** in `secrets`, including one read from a file or
  exchanged for a token, once it is in the validated config. Name each
  leaf string: an object path redacts nothing.
- **Log through `ctx.logger`**, never `console`: only it redacts.
- **Call the platform through `ctx.fetch`**, with `ctx.signal`. The
  conformance kit fails a provider that calls the global `fetch`.
- **Take a `platformCode` only from a table of the platform's known codes**,
  never from a response body as it came. Look the code up as an **own
  property**, with `Object.hasOwn(table, code)` rather than `code in table`:
  `in` also finds `constructor`, `toString` and `__proto__` on the
  prototype, so a body naming one would match, and map to a function instead
  of a kind.
- **Say only the status and the code in an error's message.** An error body
  can echo the request, token and all.
- **Send credentials over HTTPS only.** A bearer token goes on every call,
  so refuse a config `url` that is not `https:`, with one exception: plain
  `http:` to `localhost`, `127.0.0.1` or `[::1]`, this machine, where a
  test's fake runs. The template's `urlProblem()` does exactly this.
- **Keep `describe()` to facts**: a region, a pool, a cluster name. Never a
  token, a key, or a URL with credentials in it.
- **Never put a credential in a handle**: not a pre-signed URL, not a
  token-bearing id. Handles are stored, emitted and served unredacted (see
  [Handles](#handles)).
- **Parse the platform's `Retry-After` strictly**: RFC 9110 delay-seconds
  (digits only: `0x10`, `1e3`, `1.5` and `-3` are not) or an HTTP-date,
  checked by its form before `Date.parse`, which reads `1.5` and `-3` as
  dates. Anything else is no wait at all, so the controller's own backoff
  applies. A wait read from a malformed header is a wait the platform never
  asked for.
- **No install scripts, and no cloud SDK.** A provider needs `fetch` and
  WebCrypto.
- **Run the conformance kit.** Its `summon.secrets.no-leak` check
  configures the provider with a canary wherever a declared path holds a
  string in the config you pass it, and then looks, in everything bun-jobs
  would log or store, both for those canaries and for every declared
  secret's real validated value: so a secret the schema derives (a token
  read from a file, one exchanged for another) that leaks fails it too.
  Each value is looked for as the controller redacts it, and a leak names
  its declared path. The look by real value has the redactor's floor: a
  declared secret of **8 characters or more**. A shorter one is not looked
  for by value, for the same reason it is not redacted, and the check's
  detail ends "; N declared secret(s) under 8 characters are not redacted,
  so not checked by value". A string at a declared path of the config you
  pass is still replaced by a canary, whatever its length, and the canary
  is looked for, since the kit chooses that value.
  `summon.describe.facts` warns about exactly the facts the status route
  drops whatever its settings: a key `isCredentialKey` matches (the same
  credential-word rule), or a value holding a URL with credentials in it. A
  `host` or `hostname` fact, dropped only while `serialize.exposeHosts` is
  off, is not warned about. And
  `summon.errors.platform-code` warns about a `platformCode` that is not
  code-shaped. With no declared secrets, `summon.secrets.no-leak` is
  skipped, and the report stays `ok`.

## For users choosing a provider

- A provider plugin is code that holds a credential able to start compute
  and spend money. Treat installing one like granting that credential.
- **Scope the credential to the provider's job**: one ECS cluster and task
  definition; one Container Apps job (an identity that can start one can read
  its secrets); one Lambda function.
- **Pin the exact version**, and read the changelog before upgrading. The
  `warn` a controller logs for a provider written against a newer minor of
  the API is a prompt to read it.
- **Prefer a provider that publishes its conformance report and its fake**,
  and run the kit yourself: it needs no credentials.
- **Check the package's install scripts and dependencies.** One that pulls a
  cloud SDK or has a `postinstall` deserves a question.
- **Put the credential in the process that runs the controller**, not in
  every producer. Only that process calls the provider.
