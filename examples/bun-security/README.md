# `@kingsleyweb/bun-security` examples

Runnable examples for
[`@kingsleyweb/bun-security`](../../packages/bun-security): the
request-defence engine on a plain `Bun.serve`, on bun-common's
`BunHttpAdapter` and in a NestJS application, from lists, bans and limits to
sign-in protection, challenges, verified crawlers, API keys, shared state,
secrets sealed at rest, policies kept in a file or a store, testing a policy
with simulated attacks, a fleet of agents behind a control plane, three
APIs on one host sharing a Redis, and the control plane itself: groups and
signed bundles, approvals and the audit chain, analytics and alerts.

Each file is a script. Its opening comment says what it shows and how to run
it; its output narrates what happened, and the `✓` lines are assertions (a
failed one exits non-zero, so `run-all.ts` reports it).

```bash
cd examples/bun-security
bun 01-serve/install-security.ts   # start here
bun run-all.ts                     # every example; prints ok / skip / FAIL
bun run-all.ts 09 10               # only folders 09-* and 10-*
```

No install step: the examples use the workspace packages through the repo's
root `node_modules`. Nothing reaches the network: requests go through an
adapter's socket-free `fetch()` or a server on `127.0.0.1`, crawlers are
verified by a fixed resolver, Turnstile and hCaptcha by an injected
`fetch`, and the alerts' webhook goes to a receiver on `127.0.0.1`. Where time matters the engine runs on a fake clock (`now`).

| Folder | What it shows |
|---|---|
| `01-serve` | `with-security.ts` — `withSecurity` and `hardenServe` on a real `Bun.serve` (port 0, localhost): a listed range and a listed user refused with problem+json (the code, never the rule's reason), a browser's HTML page, `trustProxy: "loopback"`, and a spoofed `X-Forwarded-For` from an untrusted peer ignored |
| `01-serve` | `install-security.ts` — `installSecurity` on `BunHttpAdapter`: the boot self-test, the security headers, the early stage (an address entry) and the route stage (a user entry, a user-keyed limit), `securityProfile` read back with `requestSecurity`, a bypassed install failing its self-test, and `remove()` |
| `02-nest` | `security-module.ts` — `SecurityModule.forRoot()` in a NestJS app (`modules/`, one role per file): the early stage before Nest, `SecurityGuard` refusing a listed user and a user's limit, `@SkipSecurity()`, `@SecurityProfile()`, `@InjectSecurity()` with `explain()`, and an app with no guard failing its boot self-test |
| `03-identity` | `behind-a-proxy.ts` — `requestFacts` and `explain().client`: a trusted proxy's `X-Forwarded-For`, a spoofed one from an untrusted peer, `::ffff:` addresses normalised, IPv6 keyed by its /64, and a sibling service verified by its token's SHA-256 forwarding its end user |
| `04-lists-and-bans` | `lists-and-bans.ts` — block, drop and override-allow entries, a route-scoped entry with an expiry (the canonical path catching `//Admin`), a dry-run entry, the built-in `internal` list, `ban`/`unban`/`bans`, a ban ending on a fake clock, and the offence ladder turning a custom event's weight into a challenge, then a ban |
| `05-limits` | `limits-and-counted-rules.ts` — a composite-key limit (`["ip", "user"]`) with `429` and `Retry-After`, the sliding window recovering, a dry-run limit, counted rules on `auth.failure`, on `route.notFound` reported by `complete()` and on `throttled`, and a window without a unit refused |
| `06-presets` | `presets.ts` — `PRESETS`, `not_found_per_minute` recording its would-be ban as shipped, `"enforce"` banning at the 120th not-found, `false`, the login presets counting only on a `login` route, a preset replaced by a rule of the same id, and an unknown value refused |
| `07-request-rules` | `request-rules.ts` — rules on a header, a query parameter's regex and (in the route stage) the user, a rule's own status and code, the managed probe set enforced (each probe answered as a missing page), rule hits feeding a counted rule on `rule.hit`, and `regexRefusal` refusing a pattern that could run away |
| `08-deception` | `honeypots-and-canaries.ts` — a honeypot answered as a missing page and banning on the next request, a canary API key refused with a `canary.used` warning naming it, and a trap form field (`trapField`, `isTrapFilled`, `trap.filled`) |
| `09-sign-in` | `sign-in.ts` — `uniformAuthResponse` (same status, body and minimum time for a missing account and a wrong password), a device cookie, progressive delays and a per-username challenge, the owner's known device signing in without a second factor while a new device is challenged, the `step-up` tag, and `unlock()` |
| `09-sign-in` | `failure-rate.ts` — the global failure-rate rule (`login.failure-rate`): a password spray from a fresh address per attempt passing every per-key rule; as it ships, every attempt answered, the route tripped and warned of; enforced, the attempts past the 20th failure refused (`429` without a challenge flow) while the owner's known device still signs in |
| `09-sign-in` | `identifiers.ts` — `security.check()` refusing a disposable email, a reserved and an own domain and a breached password with one generic message, and a match inside a request counting `pattern.hit` into a 7-day ban |
| `09-sign-in` | `login-under-attack.ts` — the login profile under `./testing`'s `credentialStuffing` (one address, 200 pairs: banned from the 11th) and `distributedGuessing` (200 addresses on one account: challenged from the 11th), each with its negative control (no engine, every attempt answered), while the owner's known device still signs in and a new one is challenged |
| `10-challenges` | `proof-of-work.ts` — `challenges()` with `powChallenge`: an API client's `challenge_required`, `solvePowChallenge`, the clearance in `x-security-clearance`, a single-use answer, a clearance bound to its network and User-Agent, and a block a clearance does not lift |
| `10-challenges` | `captcha-providers.ts` — `turnstile()` and `hcaptcha()` verified through an injected fake `fetch`: a good token, a failed one, one for another hostname and a network failure |
| `11-intel` | `static-ranges.ts` — `ipIntel` with a static `office` class and a Tor exit feed served from localhost, `class` conditions in request rules, a truncated download refused with the last good list kept, and policies the engine cannot answer refused at start |
| `12-crawlers` | `verified-crawlers.ts` — Googlebot verified by its ranges crawling dead links, `/wp-admin/` and a honeypot unharmed, Bingbot verified by reverse DNS (a fixed resolver), a spoofed Googlebot blocked, the same crawl banned for an ordinary client, and a crawler's `POST` evaluated without the allowance |
| `13-api-keys` | `api-keys.ts` — per-plan limits (`apiKeyPlan`), a list entry naming a key id, a leaked key used from many addresses suspended with `onKeyCompromised` called, a ban keyed by the key's HMAC, and `revokeApiKey()` |
| `14-shared-store` | `sqlite.ts` — `cacheStore` over one SQLite file (a temporary one): two engines sharing an exact limit, a counted rule's ban and a ban and its lift |
| `14-shared-store` | `redis.ts` — the same on the Redis server `EXAMPLE_REDIS_URL` names, bans announced on pub/sub (skips when unset, fails when unreachable; deletes exactly the keys it wrote) |
| `14-shared-store` | `sealing.ts` — `./sealing`'s `sealedFields` codec on a SQLite store: an alert channel's URL and secret absent from the file (the negative control, without the codec, holds them), a wrong key (`auth`) and an unknown key id (`unknown-key`) refused, a sealed value copied to another row refused, and rotation with `resealStore` |
| `15-policy` | `policy-file.ts` — `policyFile` followed as it is edited, a broken edit refused with the last good policy kept (`policy.refused`), and a restart while the file is broken enforcing the last-known-good copy |
| `15-policy` | `policy-store.ts` — `sqliteStore` versions: an engine following the head, two writers on one head (the second refused), and a store failing (`faultyStore`) with nothing changed and one `policy.unavailable` warning |
| `15-policy` | `postgres-store.ts` — `postgresStore` on the server `EXAMPLE_POSTGRES_URL` names: its pushed change feed (`LISTEN/NOTIFY`) bringing a new version to an engine that polls only hourly, and a second writer on the old head refused (skips when unset, fails when unreachable; drops exactly the tables it created) |
| `16-dry-run` | `dry-run-and-explain.ts` — the whole policy in dry run recording three would-be refusals through `onDecision`, `explain()` naming the entry that refused a request, and `explain()` never counting a limit |
| `17-testing` | `simulate-attacks.ts` — `./testing`'s `credentialStuffing`, `pathScan` and `spoofedCrawler` run with `runAttack` and `fetchTarget` on a fake clock against an app, each with its negative control (no engine, the attack succeeds) |
| `18-fleet` | `fleet.ts` — a control plane (`createSecurityApi` behind `secureAdmin`, on a SQLite file) and two agents in processes of their own (`connectAgent`): a group, a service and two agents registered, two publishes and a ban and its lift reaching both by the nudge (the agents poll hourly; without the nudge the second publish never arrives), and, with the control plane gone, an agent restarted on its last known good while a fresh one has nothing to enforce |
| `19-one-host` | `one-host.ts` — three APIs (`accounts`, `shop`, `partner`), each a `Bun.serve` behind `withSecurity` in its own process, sharing one Redis (`cacheStore`): a ban from accounts refused by all three and its lift; shop calling accounts with its service token, its end users counted by a limit marked `appliesToServices` (six users pass a 3-a-minute limit, one user is refused past its own 3), and without the token counted against shop's address (skips when unset, fails when unreachable; deletes exactly the keys it wrote) |
| `20-control` | `bundles-and-groups.ts` — `mergePolicies` over global ← a group ← a service: a locked limit keeping global's value while the group's override is dropped and named (`locked`, `locks`), each item's origin, lists unioned; `diffPolicies` matching keyed items by id; `dangerousChanges` naming a dry-run rule enforced and an allow entry widened on a production service; `signBundle` and `verifyBundle`, with a tampered policy, another service's bundle, a replay, an unknown key and a not-yet-valid bundle refused |
| `20-control` | `approvals-and-audit.ts` — `createSecurityApi` over a temporary SQLite store: publishing refused with `401 step_up_required` and the host's challenge URL until the second factor is fresh, a dangerous publish opening a two-person approval its author may not approve and a second owner does, the audit chain's intent and done entries (and `access.refused`), `verifyAudit()` passing with a checkpoint in a file sink, then naming `hash-mismatch` at an entry edited in the database and alerting `audit.verifyFailed` |
| `21-analytics` | `analytics.ts` — `analyticsHook` feeding `createAnalyticsRecorder`, `createEventRing` and `createRedactor` on a fake clock: one event per refusal with the bearer token and a query token `[redacted]`, the minute's requests by action once it closes, `top.refused` (top-K), the exact refusals per subject per day, and `analyticsMaintenance` rolling the minutes into an hour after its grace |
| `22-alerts` | `alerts.ts` — alerting on a fake clock with its queue worked by hand: a webhook channel to a local receiver (its secret shown once), the `ruleTripped` preset raising on reported counters, the receiver checking `x-bun-security-signature` with `signWebhook` (a wrong secret and a changed body refused), and a flood of one kind sent once with the other four held for a digest |

## Servers

Three examples need one. Each skips (prints `skipped:`) when its variable is
unset and fails when it is set but the server cannot be reached.

| Example | Variable |
|---|---|
| `14-shared-store/redis.ts`, `19-one-host/one-host.ts` | `EXAMPLE_REDIS_URL`: a database the example may write to |
| `15-policy/postgres-store.ts` | `EXAMPLE_POSTGRES_URL`: a database the example may create tables in |

`bun scripts/setup-databases.ts --print-env` prints a local test server's
URLs.

```bash
EXAMPLE_REDIS_URL=redis://127.0.0.1:6379/15 \
EXAMPLE_POSTGRES_URL=postgres://user:pass@127.0.0.1:5432/db bun run-all.ts
```
