/**
 * The policy format (plan D5, control-plane.md §2): plain data, validated by
 * {@link securityPolicySchema} and compiled once by `compilePolicy`, never
 * user code: the service's identity settings (layers.md L2), its allow and
 * deny lists (L3), the trust check (L2.5), connection limits (L1), rate
 * limits (L9) and counted rules (§0.2); the later layers add their sections
 * beside these, within format version 1.
 *
 * Every duration has its unit written (`"5m"`, `{ minutes: 5 }`), every
 * timestamp its time zone (`"2026-12-01T00:00:00Z"`): a bare number is
 * refused wherever a unit could be guessed wrong.
 */
import type { Duration } from "@kingsleyweb/bun-common";

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
 * or CIDR range (`ip`), a user id (`user`) or an API key id (`apiKey`) — and
 * the action taken when it matches.
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
 * before routing). A request missing a part is not counted under that key.
 */
export type SubjectKeyPart =
  "ip" | "user" | "session" | "tenant" | "apiKey" | "route";

/**
 * How a limit counts (the throttle foundation's algorithms):
 * `sliding-window` (the default, smooth at window edges, any store),
 * `fixed-window` (exact, but `2 × limit` can pass across an edge) or `gcra`
 * (a token bucket; needs a store with an atomic `consumeGcra`, as the memory
 * store has).
 */
export type LimitAlgorithm = "sliding-window" | "fixed-window" | "gcra";

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
}

/** What a tripped counted rule does to its key (layers.md §0.2). */
export type CountedRuleAction = "ban" | "challenge";

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
   * What the tripped key gets until `duration` ends: `ban` (`403` for every
   * later request under the key) or `challenge` (a `block` until challenge
   * providers exist). Default `"ban"`.
   */
  readonly action?: CountedRuleAction;
  /**
   * How long the action lasts, its unit written (`"1h"`), or `null` until it
   * is removed: until the rule is removed from the policy or turned off.
   */
  readonly duration: Duration | null;
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
  /** The `code` of the refusal's problem+json body. Default `"blocked"`. */
  readonly code?: string;
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
}
