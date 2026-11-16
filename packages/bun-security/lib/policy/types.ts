/**
 * The policy format (plan D5, control-plane.md §2): plain data, validated by
 * {@link securityPolicySchema} and compiled once by `compilePolicy`, never
 * user code: the service's identity settings (layers.md L2), its allow and
 * deny lists (L3), the trust check (L2.5), connection limits (L1), rate
 * limits (L9), counted rules and the ladder (§0.2), bans (L4), request
 * shape (L6), request rules (L7) and deception (L8); the later layers add their sections beside
 * these, within format version 1.
 *
 * Every duration has its unit written (`"5m"`, `{ minutes: 5 }`), every
 * timestamp its time zone (`"2026-12-01T00:00:00Z"`): a bare number is
 * refused wherever a unit could be guessed wrong.
 */
import type { Duration } from "@kingsleyweb/bun-common";
import type { RequestRulesPolicy } from "../rules/types";
import type { BotSignalsPolicy } from "../engine/signals";

/**
 * How a rule, a list entry or a whole policy runs (layers.md §0.4):
 * `enforce` applies its action; `dryRun` evaluates it and records the would-be
 * action as `log` with `wouldHaveBeen`; `off` skips it.
 */
export type SecurityMode = "enforce" | "dryRun" | "off";

/**
 * What a decision does to a request (layers.md §0.1), most severe last in
 * {@link ACTION_SEVERITY}'s order: `allow`, `log`, `tag`, `delay`,
 * `challenge`, `block`, `ban`, `drop`.
 */
export type SecurityAction =
  "allow" | "log" | "tag" | "delay" | "challenge" | "block" | "ban" | "drop";

/** The actions a list entry can take (layers.md L3). */
export type ListAction = "allow" | "block" | "challenge" | "drop";

/**
 * Where a list entry was written, least specific first: the control plane
 * merges global, group and service policies into one and keeps each entry's
 * scope, so a more specific entry wins (layers.md L3, control-plane.md §2.2).
 * An entry with `paths` is route-scoped, more specific than all three.
 */
export type PolicyScope = "global" | "group" | "service";

/**
 * One allow or deny entry (layers.md L3): exactly one subject — an address
 * or CIDR range (`ip`), a user id (`user`), an API key id (`apiKey`), a
 * country (`country`) or an autonomous system (`asn`) — and the action
 * taken when it matches. `country` and `asn` need `createSecurity`'s
 * `intel` (`./intel`).
 */
export interface ListEntry {
  /**
   * A stable id, unique in the policy, for merges, dry-run reports and
   * `explain()`. Defaults to the subject (`ip:203.0.113.0/24`, `user:u_1`).
   */
  readonly id?: string;
  /** An IPv4 or IPv6 address or CIDR range; IPv4-mapped forms are read as IPv4. */
  readonly ip?: string;
  /** A user id, as the app's `identify()` returns it. */
  readonly user?: string;
  /** An API key **id**, as `identify()` returns it; never the key itself. */
  readonly apiKey?: string;
  /**
   * The client address's country, ISO 3166-1 alpha-2, upper case (`"KP"`),
   * as the intel's databases give it. Any action but `allow`: a whole
   * country is never allowed past every defence.
   */
  readonly country?: string;
  /** The client address's autonomous system number (`13335`), as the intel's databases give it. */
  readonly asn?: number;
  /**
   * What a match does. `challenge` needs a challenge provider; until one is
   * configured it falls back to `block`. `drop` closes the connection with
   * no answer.
   */
  readonly action: ListAction;
  /**
   * For an `allow` entry: win over a `block` in the same scope. Without it,
   * the most severe matching entry of a scope wins. Default `false`.
   */
  readonly override?: boolean;
  /**
   * Lower scopes cannot override it: a locked entry is weighed before every
   * unlocked one, whatever its scope. Default `false`.
   */
  readonly locked?: boolean;
  /** Where the entry was written. Default `"service"`. */
  readonly scope?: PolicyScope;
  /**
   * Route prefixes the entry applies to (`["/healthz"]`), matched on whole
   * path segments; every path when absent. A route-scoped entry is more
   * specific than any scope.
   */
  readonly paths?: readonly string[];
  /**
   * When the entry stops applying: an ISO 8601 timestamp with its time zone
   * (`"2026-12-01T00:00:00Z"`). Never when absent.
   */
  readonly expiresAt?: string;
  /** The entry's mode. Default `"enforce"`. */
  readonly mode?: SecurityMode;
  /** Why the entry exists, for operators; never sent to the client. */
  readonly reason?: string;
  /** Who added it, for operators; never sent to the client. */
  readonly createdBy?: string;
  /**
   * The `code` of the refusal's problem+json body (`"blocked"` by default):
   * the body never names the entry or the rule.
   */
  readonly code?: string;
}

/** What a verified service call is exempt from (layers.md L2.4). */
export type ServiceExemption =
  "lists" | "bans" | "countedRules" | "globalLimits";

/**
 * A sibling service allowed to call this one under its own identity
 * (layers.md L2.4, control-plane.md §2.1): it presents a token in the
 * service-identity header, and the policy holds only the token's SHA-256.
 */
export interface ServiceIdentity {
  /** The calling service's name (`"pay-api"`), unique in the policy. */
  readonly id: string;
  /**
   * The SHA-256 of the service's token, as `"sha256:<64 hex digits>"`, or
   * several during a rotation. The token itself never appears in a policy.
   */
  readonly verifier: string | readonly string[];
  /**
   * Whether the end-user address the service forwards (in
   * `clientIpHeader`) is believed and becomes the request's client. Default
   * `false`: a call with no believed address counts against nobody.
   */
  readonly forwardsClientIp?: boolean;
  /**
   * What a verified call skips. Default all four: lists, bans, counted
   * rules and global limits. Limits marked `appliesToServices` still apply.
   */
  readonly exempt?: readonly ServiceExemption[];
}

/** Service identities and the headers they use (layers.md L2.4). */
export interface ServiceIdentityPolicy {
  /** The header carrying a calling service's token. Default `"x-service-token"`. */
  readonly header?: string;
  /**
   * The header carrying the end-user address a verified service forwards.
   * Default `"x-service-client-ip"`. Read only with a valid token from a
   * service with `forwardsClientIp`, and only when it parses as an address.
   */
  readonly clientIpHeader?: string;
  /** The services allowed to call. */
  readonly services: readonly ServiceIdentity[];
}

/**
 * The trust-misconfiguration check (layers.md L2.5): on a public service,
 * warn when most requests resolve to an internal address, or carry
 * forwarding headers that the trust configuration never reads.
 */
export interface TrustCheckPolicy {
  /** The share of a minute's requests that marks it suspicious. Default `0.5`. */
  readonly threshold?: number;
  /** How long it must last before the warning: whole minutes. Default `"5m"`. */
  readonly window?: Duration;
  /** A minute with fewer requests never counts as suspicious. Default `20`. */
  readonly minRequests?: number;
}

/** The internal never-block list narrowed to some of its ranges (layers.md L3.1). */
export interface InternalListPolicy {
  /**
   * The ranges kept: each one of `INTERNAL_RANGES` or inside one. The list
   * can only be narrowed; a range outside it is refused.
   */
  readonly ranges: readonly string[];
}

/**
 * One part of a limit's or counted rule's key (layers.md L2.3): the client's
 * address key (`ip`: IPv4 as itself, IPv6 by `keys.ipv6Prefix`), an id from
 * `identify()` (`user`, `session`, `tenant`, `apiKey`), or the route
 * (`route`: the matched route, `"POST /login"`, or the method and path
 * before routing), or a sensitive endpoint's parts (layers.md L11): the
 * attempted login identifier (`username`), where a code or link is sent
 * (`destination`) and its prefix (`destinationPrefix`: a phone number's
 * country and area code, an email's domain), all three keyed by their HMAC,
 * never stored in clear; and the signed device cookie's id (`device`). A
 * request missing a part is not counted under that key.
 */
export type SubjectKeyPart =
  | "ip"
  | "user"
  | "session"
  | "tenant"
  | "apiKey"
  | "route"
  | "username"
  | "destination"
  | "destinationPrefix"
  | "device";

/**
 * How a limit counts (the throttle foundation's algorithms):
 * `sliding-window` (the default, smooth at window edges, any store),
 * `fixed-window` (exact, but `2 × limit` can pass across an edge) or `gcra`
 * (a token bucket; needs a store with an atomic `consumeGcra`, as the memory
 * store has).
 */
export type LimitAlgorithm = "sliding-window" | "fixed-window" | "gcra";

/**
 * Where a limit counts (topologies.md §3.2): `local`, in this process alone
 * (exact per process; across N processes up to N× the limit); `shared`, in
 * the engine's shared store, one round trip per request (exact across every
 * process sharing it); `hybrid`, in this process and synced to the shared
 * store in batches (no round trip on the request; approximate, overshooting
 * by about `rate × sync interval × processes`).
 */
export type StateMode = "local" | "shared" | "hybrid";

/**
 * What a limit or counted rule does when the shared store fails
 * (topologies.md §6.1): `local` counts in this process at its local share
 * (the limit ÷ `state.nodes`, at least 1); `open` lets the request through
 * uncounted and records the failure; `closed` answers `503` with
 * `Retry-After` (limits only).
 */
export type StoreErrorMode = "local" | "open" | "closed";

/**
 * A rate limit (layers.md L9): at most `limit` requests per `window` for one
 * key, counted by bun-common's throttle foundation. Past it, the request is
 * answered `429` with `Retry-After`; a refused request counts too, and
 * emits the `throttled` event counted rules can count.
 */
export interface LimitRule {
  /**
   * A stable id, unique among the limits: letters, digits, `_`, `.` and `-`,
   * starting with a letter or digit, at most 64 characters. Counts carry over
   * a policy reload while the id, window and algorithm stay the same.
   */
  readonly id: string;
  /** Requests allowed per window: a positive whole number. */
  readonly limit: number;
  /**
   * The window, its unit written (`"1m"`, `{ seconds: 30 }`). A bare number
   * is refused, and so is a window under a second unless {@link subSecond}.
   */
  readonly window: Duration;
  /** Accept a window under one second. Default `false`: such a window is usually a unit mistake (T-L9-3). */
  readonly subSecond?: boolean;
  /**
   * Who a request counts against: one part, or several for a composite key
   * (`["ip", "user"]`, ConcaveHR's `ip|account`). Default `"ip"`. A request
   * missing a part is not counted by this limit.
   */
  readonly key?: SubjectKeyPart | readonly SubjectKeyPart[];
  /**
   * The routes it applies to: `"POST /login"`, `"/login"` (any method), or a
   * prefix on whole segments, `"/auth/*"`. A route matches the request's
   * path, or the matched route's pattern once routing has run. `GET` also
   * covers `HEAD`. Every request when absent.
   */
  readonly routes?: readonly string[];
  /** How it counts. Default `"sliding-window"`, the foundation's default. */
  readonly algorithm?: LimitAlgorithm;
  /** What one request costs: a non-negative number. Default `1`. */
  readonly cost?: number;
  /** The limit's mode: in `dryRun` it counts but never answers `429`. Default `"enforce"`. */
  readonly mode?: SecurityMode;
  /**
   * Whether it applies to a verified sibling service exempt from global
   * limits (layers.md L2.4), keyed on the end user it forwards (a call that
   * forwards none counts against nobody). Default `false`.
   */
  readonly appliesToServices?: boolean;
  /**
   * Whether it still counts a request an allow entry let through (layers.md
   * §0.1). Default `false`. An address-only key never counts an internal
   * client either way.
   */
  readonly evenWhenAllowed?: boolean;
  /** The `code` of the `429`'s problem+json body. Default `"rate_limited"`. */
  readonly code?: string;
  /**
   * Where it counts. Default the policy's `state.mode`, else `"shared"` when
   * the engine has a shared store and `"local"` when it has none. `shared`
   * and `hybrid` need a shared store (`createSecurity`'s `store`); `hybrid`
   * refuses `algorithm: "gcra"`.
   */
  readonly state?: StateMode;
  /**
   * What it does when the shared store fails. Default the policy's
   * `state.onStoreError`, else `"local"`. Ignored for a `local` limit.
   */
  readonly onStoreError?: StoreErrorMode;
  /**
   * Only requests of routes with this profile count (`securityProfile("login")`
   * in `./http`, `@SecurityProfile("login")` in bun-nest): the sensitive
   * endpoints' limits (layers.md L11). Every route when absent.
   */
  readonly profile?: string;
}

/** What a tripped counted rule does to its key (layers.md §0.2). */
export type CountedRuleAction = "ban" | "challenge" | "ladder";

/**
 * A counted rule (layers.md §0.2, plan D23): `threshold` occurrences of
 * `event` within `window` for one key → `action` for `duration`. The count
 * is cleared when it trips, so one burst gives one ban.
 */
export interface CountedRule {
  /** A stable id, unique among the counted rules, in a limit id's grammar. */
  readonly id: string;
  /**
   * The event counted: `request` (every request that passed the lists),
   * `throttled` (a limit refused it), `route.notFound` (no route matched),
   * `server.error` (a `5xx` answer), the app's signals (`auth.failure`,
   * `mfa.failure`, `signup`, `password.reset`, `pattern.hit`, or any name of
   * its own through `signal()`).
   */
  readonly event: string;
  /** How many occurrences trip it: a positive whole number. */
  readonly threshold: number;
  /** The window the occurrences are counted in, its unit written. */
  readonly window: Duration;
  /** Accept a window under one second. Default `false`. */
  readonly subSecond?: boolean;
  /** Who occurrences count against, as a limit's key. Default `"ip"`. */
  readonly key?: SubjectKeyPart | readonly SubjectKeyPart[];
  /** Only occurrences on these routes count (a limit's route grammar). Every route when absent. */
  readonly routes?: readonly string[];
  /**
   * What the tripped key gets: a ban (layers.md L4) with this action until
   * `duration` ends. `ban` refuses every later request under the key;
   * `challenge` challenges (a `block` without a challenge flow); `ladder` bans
   * for the escalating duration of the policy's `ladder` (`base ×
   * factor^(n-1)`, n the key's bans within the ladder's `memory`), and takes
   * no `duration`. Default `"ban"`.
   */
  readonly action?: CountedRuleAction;
  /**
   * How long the ban lasts, its unit written (`"1h"`), or `null` until it is
   * lifted (`security.unban()`, or the rule removed from the policy or turned
   * off). Required, except with `action: "ladder"`, which refuses it.
   */
  readonly duration?: Duration | null;
  /**
   * The offence weight a trip adds to the client address's score (layers.md
   * §0.2), which the ladder turns into challenges and bans. Default `1`.
   */
  readonly weight?: number;
  /** The rule's mode: in `dryRun` it counts and records the would-be action. Default `"enforce"`. */
  readonly mode?: SecurityMode;
  /**
   * Whether it counts, and its trips refuse, the end user a verified sibling
   * service forwards even when the service is exempt from counted rules and
   * bans (layers.md L2.4, T-L2-4): a sign-in proxy's end users are counted
   * and banned, the service itself never (a call forwarding no address
   * counts against nobody). Default `false`.
   */
  readonly appliesToServices?: boolean;
  /** The `code` of its bans' problem+json body. Default the policy's `bans.code` (`"banned"`). */
  readonly code?: string;
  /**
   * Where its counters live: `"local"` or `"shared"` (`"hybrid"` is for
   * limits only). Default `"shared"` when the engine has a shared store,
   * else `"local"`; the policy's `state.mode` applies when it is one of the
   * two.
   */
  readonly state?: "local" | "shared";
  /**
   * What it does when the shared store fails: `"local"` (count in this
   * process at the threshold's local share) or `"open"` (do not count).
   * Default the policy's `state.onStoreError` when that is one of the two,
   * else `"local"`.
   */
  readonly onStoreError?: "local" | "open";
  /** Only occurrences on routes with this profile count. Every route when absent. */
  readonly profile?: string;
}

/**
 * The login profile's account defences (layers.md L11.2 to L11.4, L11.8),
 * on routes marked `login`. Its request limits and counted rules are the
 * `login.*` presets.
 */
export interface LoginProfilePolicy {
  /**
   * Failures per attempted username (per username and device for a request
   * with a valid device cookie), in a window from the first: after
   * `delayAfter` each attempt waits 1 s, then 2 s, 4 s… up to `maxDelay`;
   * at `challengeAfter` a challenge (through `createSecurity`'s challenge
   * flow; a `429` without one); at `lockAfter` a soft lock for `lockFor`,
   * refusing (`429`) that username from any device without a valid device
   * cookie for it, challenge or not.
   */
  readonly failures?: {
    /** The window, its unit written. Default `"15m"`. */
    readonly window?: Duration;
    /** Failures before the delay starts. Default `5`. */
    readonly delayAfter?: number;
    /** Failures before the challenge. Default `10`. */
    readonly challengeAfter?: number;
    /** Failures before the soft lock. Default `20`. */
    readonly lockAfter?: number;
    /** How long a soft lock lasts. Default `"15m"`. */
    readonly lockFor?: Duration;
    /** The longest delay. Default `"2s"` (layers.md §0.1's bound). */
    readonly maxDelay?: Duration;
  };
  /**
   * Distinct usernames failing from one address in a window (credential
   * stuffing: one source, many accounts): a challenge at `challengeAt`, a
   * ban for `banFor` at `banAt`. `false` for none.
   */
  readonly distinctUsernames?:
    | {
        /** The window. Default `"1h"`. */
        readonly window?: Duration;
        /** Default `10`. */
        readonly challengeAt?: number;
        /** Default `30`. */
        readonly banAt?: number;
        /** Default `"1h"`. */
        readonly banFor?: Duration;
      }
    | false;
  /**
   * Distinct addresses failing for one username in a window (a spray at
   * one account): at `stepUpAt` the account's requests are tagged
   * `step-up`, for the app to require a second factor. `false` for none.
   */
  readonly distinctAddresses?:
    | {
        /** The window. Default `"1h"`. */
        readonly window?: Duration;
        /** Default `10`. */
        readonly stepUpAt?: number;
      }
    | false;
  /**
   * A success from an address with at least this many failures in the
   * failures window is tagged `risky-success` and warned of (a hit in a
   * stuffing run). `false` for none. Default `10`.
   */
  readonly riskySuccessAfter?: number | false;
  /**
   * The device cookie (layers.md L11.4): signed, issued on a success, its
   * holder's failures kept apart from everyone else's. `false` for none.
   */
  readonly device?:
    | {
        /** The cookie's name. Default `"__Host-bun-security-device"`. */
        readonly cookie?: string;
        /** How long it is good for. Default `"365d"`. */
        readonly maxAge?: Duration;
      }
    | false;
  /**
   * Infer `auth.failure` (a `401` or `403`) and `auth.success` (a `2xx`)
   * from the answer when the app signalled neither for the request. Default `true`.
   */
  readonly inferOutcome?: boolean;
  /** The profile's mode: in `dryRun` delays, challenges and locks are recorded only. Default `"enforce"`. */
  readonly mode?: SecurityMode;
}

/** The sensitive endpoints' settings (layers.md L11). */
export interface ProfilesPolicy {
  /** The login profile's account defences, or `false` for none. On by default. */
  readonly login?: LoginProfilePolicy | false;
}

/** What an identifier pattern matches (layers.md L11.7). */
export type IdentifierKind = "email" | "phone" | "username" | "domain";

/**
 * An identifier pattern (layers.md L11.7, ConcaveHR's email patterns): `*`
 * any run, `?` one character, matched whole and without case, with at
 * least 4 literal characters (`*@*` is refused).
 */
export interface IdentifierPattern {
  /** A stable id, for counts and `explain()`. Default `<kind>:<pattern>`. */
  readonly id?: string;
  /** What it matches. */
  readonly kind: IdentifierKind;
  /** The pattern (`*@disposable.example`). */
  readonly pattern: string;
  /** Why, for operators. */
  readonly reason?: string;
  /** In `dryRun` a match is recorded and not refused. Default `"enforce"`. */
  readonly mode?: SecurityMode;
}

/** Identifier checks where data is created (layers.md L11.7, `security.check()`). */
export interface IdentifierPolicy {
  /** The operator's patterns. */
  readonly patterns?: readonly IdentifierPattern[];
  /**
   * Refuse email addresses and domains under reserved names (`example.*`,
   * `.test`, `.invalid`, `.localhost`, `.example`, `localhost`). Default `true`.
   */
  readonly reserved?: boolean;
  /** The operator's own domains, refused as a self-chosen address (`["example.com"]`). */
  readonly ownDomains?: readonly string[];
  /** The refusal's problem code. Default `"invalid_identifier"`. */
  readonly code?: string;
}

/**
 * How limits and counted rules share state across processes (topologies.md
 * §3.2, §6.1): defaults for every rule, each of which may name its own.
 */
export interface StatePolicy {
  /** Where limits count by default; see {@link StateMode}. Default `"shared"` with a shared store, `"local"` without. */
  readonly mode?: StateMode;
  /** What rules do when the shared store fails, by default; see {@link StoreErrorMode}. Default `"local"`. */
  readonly onStoreError?: StoreErrorMode;
  /**
   * How many processes (enforcement points) share the store: a rule's local
   * share, which it counts at when the store fails, is its limit or
   * threshold divided by this, rounded down, at least 1. A positive whole
   * number. Default `1`.
   */
  readonly nodes?: number;
  /**
   * Who shares this service's bans, offence scores and the ladder's ban
   * history on the shared store's namespace: `"shared"`, every service on
   * the namespace that is `"shared"` too (an address banned by one is
   * refused by all); `"service"`, this service's processes alone (its bans
   * and scores are never read by another service, nor another's by it, so a
   * false positive in one product locks no one out of another). `"service"`
   * needs the policy's `service`. Default `"shared"`. Limits and counted
   * rules are per service either way.
   */
  readonly scope?: "shared" | "service";
}

/**
 * WebSocket message limits (layers.md L9.5): a token bucket per connection,
 * and limits per subject across connections. A message over a limit is
 * dropped; a second breach on the connection within {@link breach} closes
 * it with {@link closeCode}. Off unless configured.
 */
export interface MessagePolicy {
  /**
   * Messages per connection: the bucket refills at `limit` per `window` and
   * holds {@link burst} times `limit`. `false` or absent: none.
   */
  readonly perConnection?:
    | {
        /** Messages per window: a positive whole number. */
        readonly limit: number;
        /** The window, its unit written (`"1s"`). */
        readonly window: Duration;
        /** Accept a window under one second. Default `false`. */
        readonly subSecond?: boolean;
      }
    | false;
  /** The bucket's size as a multiple of `perConnection.limit`: a number of at least 1. Default `2` (bun-jobs' socket). */
  readonly burst?: number;
  /** A second breach within this long closes the connection. Default `"10s"`. */
  readonly breach?: Duration;
  /** The close code: 1008 (policy violation, the default), 1013 (try again later), or 4000 to 4999. */
  readonly closeCode?: number;
  /**
   * Limits per subject across every connection (a limit's grammar: `key`,
   * `routes` matched against the upgrade request, `state`). Its `code` is
   * the close reason.
   */
  readonly limits?: readonly LimitRule[];
  /** The section's mode: in `dryRun` a breach is recorded and nothing is dropped or closed. Default `"enforce"`. */
  readonly mode?: SecurityMode;
}

/**
 * Connection limits (layers.md L1): requests in flight per client address,
 * and in all. Counted only for requests an integration tracks (it calls
 * `complete()` when each one is answered), as `withSecurity` does.
 */
export interface ConcurrencyPolicy {
  /**
   * The most requests one client address (IPv6 by its prefix) may have in
   * flight; past it, `429`. A positive whole number, or `false` for no
   * limit. Default `64`. Internal and allow-listed clients are not limited.
   */
  readonly perIp?: number | false;
  /**
   * The most requests in flight in all (load shedding); past it, `503` with
   * `Retry-After`, for every client. A positive whole number, or `false`.
   * Default `false`.
   */
  readonly total?: number | false;
  /**
   * A request in flight longer than this is no longer counted: the guard
   * against an integration that never calls `complete()`. At least a
   * second. Default `"5m"`.
   */
  readonly releaseAfter?: Duration;
  /** The limits' mode. Default `"enforce"`. */
  readonly mode?: SecurityMode;
}

/** How bans answer, and how many are held (layers.md L4). */
export interface BanPolicy {
  /** The `code` of a ban's problem+json body. Default `"banned"`. */
  readonly code?: string;
  /** Whether a ban's answer says when it ends (`Retry-After`). Default `false`: an attacker learns nothing. */
  readonly retryAfter?: boolean;
  /**
   * The most bans held in this process. Past it, a new automatic ban of an
   * address is widened to its `/24` (IPv4) or `/48` (IPv6) and a
   * `bans.aggregated` warning raised; manual bans are never dropped. A
   * positive whole number. Default `100_000`.
   */
  readonly maxActive?: number;
  /** The bans' mode: in `dryRun` a banned request is only logged. Default `"enforce"`. */
  readonly mode?: SecurityMode;
}

/** One step of the ladder (layers.md §0.2): at this score, this action. */
export interface LadderStep {
  /** The score that reaches it: a positive number. */
  readonly score: number;
  /** What the client address gets: `challenge` (a `block` without a challenge flow) or `ban`. */
  readonly action: "challenge" | "ban";
  /**
   * How long, its unit written. Default: for `ban`, the escalating duration
   * (`base × factor^(n-1)`); for `challenge`, `"15m"`.
   */
  readonly duration?: Duration;
}

/**
 * The offence score and the escalation ladder (layers.md §0.2, plan D10): a
 * score per client address, raised by offences, decaying exponentially, and
 * steps that turn it into challenges and bans of growing length.
 */
export interface LadderPolicy {
  /** The score's half-life, its unit written. Default `"1h"`. */
  readonly halfLife?: Duration;
  /**
   * The steps, by score. Default `[{ score: 3, action: "challenge" }, {
   * score: 10, action: "ban" }]`. The highest step reached applies; a ban
   * resets the score.
   */
  readonly steps?: readonly LadderStep[];
  /** The first escalating ban's length. Default `"1h"`. */
  readonly base?: Duration;
  /** Each later ban within `memory` lasts this many times longer: at least 1. Default `6`. */
  readonly factor?: number;
  /** The longest escalating ban. Default `"30d"`. */
  readonly maxBan?: Duration;
  /** How long a ban counts toward the next one's length. Default `"7d"`. */
  readonly memory?: Duration;
  /**
   * Each event's offence weight, by event name (an engine event, an L8
   * event or an app's `signal()`). Merged over the defaults:
   * `honeypot.hit` 10, `canary.used` 100, `trap.filled` 10,
   * `shape.refused` 1; any other event 0 (a `429` alone never bans,
   * layers.md L9.1).
   */
  readonly weights?: Readonly<Record<string, number>>;
  /** The ladder's mode: in `dryRun` it scores and logs, banning nobody. Default `"enforce"`. */
  readonly mode?: SecurityMode;
}

/** Per-route request shape (layers.md L6): body limits, media types, opt-outs. */
export interface ShapeRoute {
  /** The routes it applies to, a limit's route grammar. */
  readonly routes: readonly string[];
  /** The largest `Content-Length` accepted, in bytes; `413` past it. */
  readonly maxBodySize?: number;
  /** The media types accepted for a body (`"application/json"`, `"multipart/*"`); `415` for another. */
  readonly contentTypes?: readonly string[];
  /** Accept an encoded slash or backslash (`%2F`, `%5C`) in the path. Default `false`. */
  readonly allowEncodedSlash?: boolean;
}

/**
 * Request shape (layers.md L6): what a request must look like before it is
 * routed. Sizes are bytes.
 */
export interface ShapePolicy {
  /**
   * Whether the app's routes are case-sensitive. Default `false`, as
   * bun-common's router: list `paths` and honeypots then match `/Admin` as
   * `/admin`, so a case change cannot step around them.
   */
  readonly caseSensitive?: boolean;
  /** The longest path, in bytes; `414` past it. Default `2048`. */
  readonly maxPathBytes?: number;
  /** The longest query string, in bytes; `414` past it. Default `8192`. */
  readonly maxQueryBytes?: number;
  /** The most query parameters. Default `256`. */
  readonly maxQueryParams?: number;
  /** The deepest query nesting (`a[b][c]`, `a.b.c`). Default `5`. */
  readonly maxQueryDepth?: number;
  /**
   * The methods accepted (upper case); `405` for another. Default: any but
   * `TRACE` and `CONNECT`, which are always refused.
   */
  readonly methods?: readonly string[];
  /**
   * The `Host` values the service answers to (`"api.example.com"`, with a
   * port when not the default); `400` for another. Any when absent. A
   * duplicate `Host` is always refused.
   */
  readonly hosts?: readonly string[];
  /** The most header lines. Default `100`. */
  readonly maxHeaders?: number;
  /** The longest single header value, in bytes; `431` past it. Default `8192`. */
  readonly maxHeaderBytes?: number;
  /** Per-header exceptions to `maxHeaderBytes`, by lower-case name. Default `{ cookie: 16384 }`. */
  readonly headerLimits?: Readonly<Record<string, number>>;
  /** The largest `Content-Length` on any route, in bytes, or `false`. Default `false` (`hardenServe` caps the listener). */
  readonly maxBodySize?: number | false;
  /** Per-route body limits, media types and opt-outs; the first matching entry applies. */
  readonly routes?: readonly ShapeRoute[];
  /** The checks' mode. Default `"enforce"`. */
  readonly mode?: SecurityMode;
}

/** Honeypot routes (layers.md L8): paths the service never serves. */
export interface HoneypotPolicy {
  /**
   * The paths, a limit's route grammar. Default `["/wp-login.php", "/.env",
   * "/admin.php"]`. Matched on the canonical path, folded unless the shape
   * is case-sensitive.
   */
  readonly paths?: readonly string[];
  /**
   * What a hit gets: `"pass"` (the request goes on to the app, which answers
   * as it would any unknown path) or `"not-found"` (`404` problem+json).
   * Either way, never a block page, and the client address is banned from
   * the next request by its score. Default `"pass"`.
   */
  readonly answer?: "pass" | "not-found";
  /** The honeypots' mode. Default `"enforce"`. */
  readonly mode?: SecurityMode;
}

/** A canary credential (layers.md L8): an id no one uses legitimately. */
export interface CanaryPolicy {
  /** The canary's name, reported when it is used (where it was planted: `"backup-2026-q3"`). */
  readonly id: string;
  /** A user id, as `identify()` returns it. */
  readonly user?: string;
  /** An API key id, as `identify()` returns it. */
  readonly apiKey?: string;
}

/** Deception (layers.md L8): honeypot routes and canary credentials. */
export interface DeceptionPolicy {
  /** Honeypot routes: `true` for the default set, or settings. Off by default. */
  readonly honeypots?: boolean | HoneypotPolicy;
  /**
   * Canary credentials: any use refuses the request, bans the client
   * address (weight 100 through the ladder), logs an error and raises a
   * `canary.used` warning naming the canary.
   */
  readonly canaries?: readonly CanaryPolicy[];
}

/** How request subjects are keyed (layers.md L2.3). */
export interface KeyPolicy {
  /**
   * The prefix an IPv6 client is keyed by for limits and bans: 48 to 128.
   * Default `64`, one subscriber's usual assignment.
   */
  readonly ipv6Prefix?: number;
}

/**
 * A service's security policy (plan §5, control-plane.md §2). Keys starting
 * with `$` (`$schema`, `$comment`) are ignored; any other unknown key is
 * refused, so a typo cannot silently switch a defence off.
 */
export interface SecurityPolicy {
  /** Notes for people and editors (`$schema`, `$comment`): ignored. */
  readonly [note: `$${string}`]: unknown;
  /**
   * The policy format's version: `1`, the default when absent. A higher
   * version is refused with a message saying the policy is newer than this
   * package (so an older service tells a newer policy from a malformed one);
   * within version 1 an unknown key is still refused.
   */
  readonly version?: 1;
  /** The service's id, carried into decisions. */
  readonly service?: string;
  /** The environment (`"production"`, `"staging"`). */
  readonly environment?: string;
  /**
   * Whether the service takes traffic from the internet. The trust check
   * warns only on a public service. Default `false`.
   */
  readonly public?: boolean;
  /** The whole policy's mode; every entry's mode is capped by it. Default `"enforce"`. */
  readonly mode?: SecurityMode;
  /** How subjects are keyed. */
  readonly keys?: KeyPolicy;
  /**
   * The built-in never-block list `internal` (loopback, RFC 1918, CGNAT,
   * link-local, unique local): `true` (the default) for all of it, a
   * narrower set of its ranges, or `false` for none. It is locked: no
   * address entry refuses an internal client, though a user or API-key
   * entry still does.
   */
  readonly internal?: boolean | InternalListPolicy;
  /** Allow and deny entries. */
  readonly lists?: readonly ListEntry[];
  /** Sibling services that call this one under their own identity. */
  readonly serviceIdentity?: ServiceIdentityPolicy;
  /** The trust check's settings, or `false` to turn it off. */
  readonly trustCheck?: TrustCheckPolicy | false;
  /** Connection limits (layers.md L1), or `false` for none. Default `{ perIp: 64 }`. */
  readonly concurrency?: ConcurrencyPolicy | false;
  /** Rate limits (layers.md L9), several per route allowed. */
  readonly limits?: readonly LimitRule[];
  /** Counted rules (layers.md §0.2). */
  readonly countedRules?: readonly CountedRule[];
  /** How bans answer and how many are held (layers.md L4). */
  readonly bans?: BanPolicy;
  /** The offence score and its ladder (layers.md §0.2), or `false` for none. On by default. */
  readonly ladder?: LadderPolicy | false;
  /** Request shape (layers.md L6), or `false` for no checks. On by default. */
  readonly shape?: ShapePolicy | false;
  /** Honeypots and canaries (layers.md L8). */
  readonly deception?: DeceptionPolicy;
  /** Request rules and the managed probe set (layers.md L7). */
  readonly requestRules?: RequestRulesPolicy;
  /** Shared state's defaults (topologies.md §3.2, §6.1). */
  readonly state?: StatePolicy;
  /** WebSocket message limits (layers.md L9.5). */
  readonly messages?: MessagePolicy;
  /** Bot and automation signals (layers.md L10.1): off unless set. */
  readonly botSignals?: BotSignalsPolicy;
  /**
   * The built-in rules by id (`per-ip`, `login.account`, …): `true` turns
   * one on, `false` off. A limit or counted rule of the policy with a
   * preset's id replaces it. See `PRESETS`.
   */
  readonly presets?: Readonly<Record<string, boolean>>;
  /** The sensitive endpoints' account defences (layers.md L11). */
  readonly profiles?: ProfilesPolicy;
  /** Identifier patterns, checked by `security.check()` (layers.md L11.7). */
  readonly identifiers?: IdentifierPolicy;
}
