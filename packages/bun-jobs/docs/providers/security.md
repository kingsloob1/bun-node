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
   wherever it appears, prose included, longest first, in these forms:
   - as it is;
   - URL-encoded, as `encodeURIComponent` writes it (`a%2Fb` for `a/b`) and
     as form data writes it (`URLSearchParams`, `+` for a space), each also
     with lower-case percent-escapes (`a%2fb`);
   - escaped for a regular expression: the usual escape-the-specials form,
     as a `RegExp`'s `source` shows it, and `RegExp.escape`'s where the
     runtime has it.

   A declared secret under 8 characters is not redacted, in any form.
2. **By shape**, the runner's redactor with its defaults: the value of a
   `key=value`, `key: value` or JSON `"key": …` pair under a sensitive key
   (`password`, `secret`, `token`, `apikey`, `authorization`, `auth`,
   `credential`, `cookie`, …), a bare `Bearer …`, the password in a URL and
   a JSON Web Token. Then:
   - a bare `Basic` credential, in base64 or base64url, **only** when it
     decodes to a `user:password` pair and the base64 is 8 characters or
     more, not counting its `=` padding (it becomes `Basic [REDACTED]`;
     prose such as "Basic authentication failed" is left alone, and so is a
     very short credential, such as `Basic YWI6Y2Q=` for `ab:cd`, which
     fails open);
   - the values of `X-Amz-Signature=` and `X-Goog-Signature=` (any case: an
     S3 or Cloud Storage signed URL's signature);
   - an Azure SAS `sig=` value inside a query, after `?` or `&` (so `xsig=`,
     `signal=` and prose such as "the sig=verified flag" are left alone);
   - the value of an `x-amz-signature:` header.

**A URL's userinfo is replaced whole**, in messages and in fields alike,
whatever it holds: a token alone before the `@` (`https://ghp_…@github.com`),
a DSN's key.

Then, for fields (**object and `Map` keys are redacted like values**):

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
  other class instance as its own fields. A `RegExp` or a `String` object is
  logged as its text, and a `Symbol` as its description, redacted. A `Date`
  serialised the built-in way is passed as it is.
- **An object with a `toJSON` method**, other than a `URL` or an error, is
  logged as what `toJSON` returns, redacted: what `JSON.stringify` would
  write, so a sink cannot call it and bring a secret back. That includes a
  `Date` whose `toJSON` or `toISOString` is not the built-in one. The call is
  guarded, and the result is walked like any value.
- **An error keeps its class.** Its fields and its `name`, `message`,
  `stack`, `code` and `cause` become its own redacted properties, and its
  `toJSON` returns that redacted view, so a `DOMException` stays readable and
  no `toJSON` on its prototype runs. An error that still cannot be read
  becomes a plain `Error` with the same name and fields.
- **Placeholders**, for what cannot or must not be logged as it is:
  - `[Binary <n> bytes]` for a `Buffer`, any typed array, an `ArrayBuffer`,
    a `SharedArrayBuffer`, a `DataView`, a `Blob` or a `File`, since a sink
    could decode the bytes to text;
  - `[Function]` for a function;
  - `[Unreadable]` for a throwing getter or `toJSON` (or a revoked proxy);
  - `[Circular]` for a cycle, a `toJSON` returning its own object included;
  - `[REDACTED]` past the depth limit (8 levels), so an endless chain is
    replaced, never passed through.

  A log call never throws.

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
  class and fields, with the declared secrets (8 characters or more, in
  every form above) and the credential shapes above removed from its
  `name`, `message`, `stack`, `code`, `cause` and fields, as an error is
  redacted in a log line. The original error is untouched.
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
   is a declared secret is dropped, and so is one holding a declared secret
   of 8 characters or more in any of the forms above (raw, URL-encoded or
   escaped for a regular expression).
2. **When the management API serves it** (a queue's summon status, and
   `GET /providers`): a fact is dropped when its value is not a string, when
   its **key** names a credential (the word rule above: `apiKey`,
   `secretArn`, `sessiontoken` go, `keyspace` stays), when its **value**
   holds a URL with userinfo (`postgres://user:pass@…`), when its value holds
   any other credential shape the redactor knows (a value the pattern
   redactor would change: `Bearer …`, a JWT, or a `word:value` /
   `word=value` pair whose word contains a sensitive word), whatever its key,
   and, unless `serialize.exposeHosts` is on, when its key is `host` or
   `hostname`. The shape rule fails safe, so it drops some honest facts too:
   `session-workers:prod`, `max_tokens=4096`, an ARN whose resource holds
   `auth-api:prod`. Choose values that pass (the package README lists
   [which facts are served](../../README.md#which-facts-are-served)).

A `describe()` that throws is served as no facts, and its failure is logged
by name and code only, never its message.

The status route shows the summoner at every stage, with its `readiness`:
`"pending"` while the provider's config is still validating, `"failed"` when
that validation rejected or the controller refused the facet (its
capabilities raised a `ConfigError`), and `"ready"`. Its `capabilities` are
served only once it is ready, never provisional ones, and its facts are `{}`
until the config is known.

Source: [`lib/provider/configure.ts`](../../lib/provider/configure.ts)
(`describe`), [`lib/provider/redact.ts`](../../lib/provider/redact.ts)
(`factProblem`, the rule the kit's `summon.describe.facts` shares),
[`lib/api/serialize.ts`](../../lib/api/serialize.ts) (`isServableFact`).

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

The management API serves a queue's summon status (`queues.read`), the
`summon` event, and three [provider routes](../../README.md#compute-provider-routes),
each behind an action off by default because it discloses infrastructure:
`GET /providers` (`providers.read`), a preflight, `POST
/providers/:id/validate` (`providers.validate`, which `readOnly` removes),
and the config as a JSON Schema, `GET /providers/:id/schema`
(`providers.read`). `/meta`'s `features.providers` says whether they are
served. A provider's id there is `name@version~<n>`, its nth configured
instance in the API's process, and `authorize` is told it as `provider`.
From a provider the API serves only:

- its identity: `name`, `version`, `kind`, `displayName`, `homepage`,
  `apiVersion`;
- its declared capabilities;
- its facts, after both filters;
- its id and `readiness`, and whether it has a preflight and a JSON Schema
  for its config;
- a preflight's verdict: each check's id and status, and every detail
  redacted (declared secrets, credential shapes) and cut to 128 characters;
  a failure's kind and a code, never an error's message;
- its config schema, scrubbed (see [The config schema](#the-config-schema));
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

`ConfiguredProvider.validate()` answers the code that calls it, unredacted:
only the management API's preflight route redacts and caps its checks'
`detail`. Write them secret-free either way.

## The config schema

`GET /providers/:id/schema` serves a provider's config schema as a
draft-2020-12 JSON Schema, when the schema implements Standard JSON Schema.
A host bakes its own values into a schema wherever its library puts them,
none of them the configured value, so redaction by value cannot know them.
So the route:

- removes `default`, `example`, `examples`, `const` and every `x-*` key
  **everywhere**: root, nested, `$defs`/`definitions` and combinators. A
  config form built from it gets no pre-filled values;
- keeps `enum`, the allowed choices, only when every value is a scalar (an
  enum holding an object or an array is dropped wherever it is), and drops
  it under a property that is a declared secret or has a credential's name,
  in every definition such a property reaches through `$ref` (a pointer into
  a definition counts as all of it; a definition reached from both a secret
  and a non-secret property counts as secret), and everywhere in the
  document when such a property's `$ref` points at the root or elsewhere
  outside the definitions;
- redacts every other string as a detail is, replaces a string equal to a
  declared secret in any of its encoded forms whatever its length, and drops
  a number equal to one.

Source: [`lib/api/routes/providers.ts`](../../lib/api/routes/providers.ts)
(`sanitizeSchema`).

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
  declared secret of **8 characters or more**. A shorter one, or one that is
  not a string, is not looked for by value, for the same reason it is not
  redacted, and the check's detail says so: "; N declared secret(s) under 8
  characters are not redacted, so not checked by value", and "; N declared
  secret(s) are not strings, so not checked by value". A string at a declared path of the config you
  pass is still replaced by a canary, whatever its length, and the canary
  is looked for, since the kit chooses that value.
  `summon.describe.facts` warns about exactly the facts the status route
  drops whatever its settings, by the same rule (`factProblem`): a key
  `isCredentialKey` matches (the same credential-word rule), a value holding
  a URL with credentials in it, or a value holding another credential shape
  the pattern redactor would change. A `host` or `hostname` fact, dropped
  only while `serialize.exposeHosts` is off, is not warned about. And
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
