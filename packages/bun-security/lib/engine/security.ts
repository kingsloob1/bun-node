/**
 * `createSecurity`: the engine (plan §4). It decides each request locally
 * from its facts, the compiled policy and its state, in this order:
 *
 * 1. **L2** client identity (the trusted-proxy foundation's address,
 *    normalised; service identity; the trust check's gauges);
 * 2. **L1** the in-flight cap (load shedding, `503`), for tracked requests;
 * 3. **L3** lists (the CIDR trie, the `internal` list, users and API keys);
 * 4. **L1** in-flight requests per client address (`429`), for tracked
 *    requests;
 * 5. **L4** bans: written by counted rules, by the offence score's ladder
 *    (layers.md §0.2) and by hand (`ban()`);
 * 6. **L6** request shape, on the canonical path (`400` to `431`);
 * 7. **L8** canary credentials (refused at once) and honeypot routes
 *    (answered as a real route, banned from the next request);
 * 8. the `request` occurrence for counted rules;
 * 9. **L9** rate limits, counted by the throttle foundation, and the
 *    `throttled` occurrence when one refuses;
 *
 * and, after the response, **L14** through `complete()`: the request's slot
 * given back, and `route.notFound` and `server.error` occurrences counted.
 * Every occurrence (the engine's, L6's and L8's, an app's `signal()`) feeds
 * the counted rules that count it and adds its weight to the client
 * address's score.
 *
 * A stage that refuses the request ends it; every hit is recorded. An
 * explicit allow entry ends every later refusing layer, except limits marked
 * `evenWhenAllowed`; the `internal` list protects addresses only, so rules
 * keyed on an address alone never count or refuse an internal client, while
 * rules keyed on a user, session, tenant or API key still do. When every
 * store in play answers synchronously (the default memory store),
 * `evaluate()` does too. `explain()` is the same function with state writes
 * off and a trace on.
 *
 * With a shared store (`store`, topologies.md §3), limits and counted rules
 * count there as their `state` says, bans reach every process through the
 * ban log and its reconcile (`banSync.ts`), offence scores and the ladder's
 * history sync in batches (`scoreSync.ts`), and a failing store degrades
 * each rule as its `onStoreError` says. Bans are always looked up in memory.
 */
import {
  ConfigError,
  createLogger,
  memoryThrottleStore,
  resolveLogger,
  toDurationMs,
} from "@kingsleyweb/bun-common";
import type {
  Duration,
  Logger,
  LoggerLike,
  ThrottleStore,
} from "@kingsleyweb/bun-common";
import {
  addressKey,
  normalizeAddress,
  parseAddress,
  parseCidr,
} from "../ip/address";
import type { ParsedAddress } from "../ip/address";
import { compilePolicy, policyInternals } from "../policy/compile";
import { matchRequestRules, requestRulesOf } from "../rules/compile";
import type { CompiledRequestRule } from "../rules/compile";
import type {
  CompiledCountedRule,
  CompiledEntry,
  CompiledKey,
  CompiledLimit,
  CompiledPolicy,
  CompiledService,
  PolicyInternals,
} from "../policy/compile";
import type {
  SecurityAction,
  SecurityPolicy,
  SubjectKeyPart,
} from "../policy/types";
import { ACTION_SEVERITY, refuses } from "./actions";
import { BanTable, banId } from "./bans";
import type { Ban, BanSubject, BanWrite } from "./bans";
import { BanSync, scopeKey } from "./banSync";
import type { BanSink } from "./banSync";
import { InFlight } from "./concurrency";
import type { Slot } from "./concurrency";
import { CountedState } from "./counted";
import type { CountOutcome } from "./counted";
import type {
  ClientResolution,
  Decision,
  Explanation,
  DecisionCrawler,
  ExplainStep,
  RuleHit,
  SubjectKeys,
} from "./decision";
import type { RequestFacts, SecurityIdentity } from "./facts";
import { boundKey, resolveClient } from "./identity";
import type { ResolvedClient } from "./identity";
import { appliesTo, inProfile, keyOf, requestRoute } from "./keys";
import type { RequestRoute } from "./keys";
import { Limiter } from "./limits";
import type { LimitCount, LimitSet } from "./limits";
import { evaluateLists } from "./lists";
import type { ListOutcome } from "./lists";
import { all, then } from "./maybe";
import type { MaybePromise } from "./maybe";
import { Scores } from "./scores";
import { ScoreSync } from "./scoreSync";
import type { SharedStateStore } from "./shared";
import { checkShape } from "./shape";
import { inStage, keyStage } from "./stages";
import type { EvaluationStage } from "./stages";
import { DEFAULT_MAX_KEYS, EvictionMonitor } from "./state";
import { botSignalsOf, readSignals } from "./signals";
import type { ChallengeFlow } from "../challenge/flow";
import type { IntelLookup } from "../intel/types";
import { checkIntel } from "./intelNeeds";
import { crawlerConflicts } from "../crawlers/conflicts";
import type { CrawlerConflict } from "../crawlers/conflicts";
import { crawlersOf, covered } from "../crawlers/policy";
import type { CrawlerExemption } from "../crawlers/policy";
import { claimOf, exempts } from "../crawlers/request";
import type { CrawlerRequest } from "../crawlers/request";
import { CrawlerVerifier } from "../crawlers/verify";
import type { CrawlerResolver } from "../crawlers/verify";
import { TrustMonitor } from "./trust";
import { DistinctCounts } from "./distinct";
import { sensitiveOf } from "../sensitive/compile";
import {
  IDENTIFIER_MESSAGE,
  matchIdentifier,
  PASSWORD_MESSAGE,
} from "../sensitive/identifiers";
import type { CheckKind } from "../sensitive/identifiers";
import { cookieValue, Keyring } from "../sensitive/keys";
import { LoginDefences } from "../sensitive/login";
import { SecurityRefusal } from "../sensitive/refusal";
import type { SecurityWarning, TrustStatus } from "./trust";

/** Options for {@link createSecurity}. */
export interface CreateSecurityOptions<TRequest = Request> {
  /** The policy: a {@link SecurityPolicy}, compiled here, or a compiled one. */
  readonly policy: SecurityPolicy | CompiledPolicy;
  /**
   * Who the app says is calling (plan §4.2): user, session, tenant, API key
   * id. The integration calls it with its own request and puts the answer
   * in the facts. None by default: requests are keyed by address only.
   */
  readonly identify?: (
    request: TRequest,
  ) => SecurityIdentity | undefined | Promise<SecurityIdentity | undefined>;
  /**
   * Called with every decision `evaluate()` makes (not `explain()`'s), for
   * the app's own logging or metrics. Its errors are logged and ignored.
   */
  readonly onDecision?: (decision: Decision, facts: RequestFacts) => void;
  /**
   * Called with each warning as it is raised: the trust check's (layers.md
   * L2.5) and `state.evictions` (layers.md L9.6).
   */
  readonly onWarning?: (warning: SecurityWarning) => void;
  /**
   * Where warnings and errors are logged: any logger bun-common's
   * `resolveLogger` accepts. Default: a console logger named `bun-security`.
   */
  readonly logger?: LoggerLike;
  /** The clock, epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /**
   * Where rate limits (L9) and counted-rule counters count: any of the
   * throttle foundation's stores. Default a `memoryThrottleStore` of the
   * engine's own, bounded by {@link maxKeys} (per process). Several
   * processes share limits through a shared store, such as
   * `cacheThrottleStore(cache)` from `@kingsleyweb/bun-cache/throttle`.
   */
  readonly throttleStore?: ThrottleStore;
  /**
   * The bound on each table of local state: the default store's counters,
   * counted-rule trips, in-flight requests (layers.md L9.6). Past it the
   * oldest entry is dropped, counted, and a `state.evictions` warning
   * raised. A positive whole number. Default `100_000`.
   */
  readonly maxKeys?: number;
  /**
   * The shared store (topologies.md §3): state shared with every process
   * that uses the same store, such as `cacheStore(cache)` from
   * `@kingsleyweb/bun-security/stores`. Limits count there by default
   * (`shared`, or `hybrid` per limit), counted rules too, bans propagate
   * through it, offence scores sync through it. Without one every rule is
   * `local`, and a policy naming `shared` or `hybrid` is refused.
   */
  readonly store?: SharedStateStore;
  /** The most ban writes queued while the shared store is failing; past it the oldest are dropped. Default `10_000`. */
  readonly maxPendingBans?: number;
  /**
   * The challenge flow (layers.md L10.2), from `challenges()` in
   * `@kingsleyweb/bun-security/challenge`: with one, a `challenge` action
   * (a list entry's, a counted rule's, the ladder's step, a request rule's,
   * the bot signals') challenges the client, and a client holding a valid
   * clearance passes. Without one, every `challenge` falls back to a
   * `block`.
   */
  readonly challenge?: ChallengeFlow;
  /**
   * The secret the sensitive endpoints key with (layers.md L2.3, L11.4): an
   * attempted username's and a destination's HMAC, the device cookie's
   * signature. At least 32 bytes. Required with a shared store (`store`),
   * the same in every process sharing it: `createSecurity` throws a
   * `ConfigError` without one. Without a store, a random one of this
   * process's own (device cookies then last as long as the process).
   */
  readonly secret?: string | Uint8Array;
  /**
   * Whether a password is known breached (layers.md L11, OWASP's advice):
   * `check(facts, "password", password)` refuses one it answers `true`
   * for. Called with the password, which it must not log or keep; its
   * errors are logged and the password accepted. Default: none.
   */
  readonly breachedPassword?: (password: string) => boolean | Promise<boolean>;
  /**
   * IP intelligence (layers.md L5), from `ipIntel()` in
   * `@kingsleyweb/bun-security/intel`: the countries, ASNs and classes the
   * policy's `country`/`asn` list entries, its `country`, `asn` and `class`
   * conditions and `botSignals.classes` read. A policy using them without
   * one (or naming what it cannot tell) is refused.
   */
  readonly intel?: IntelLookup;
  /**
   * Reverse and forward DNS for verifying crawlers (layers.md L3.2):
   * `{ reverse(address), lookup(name) }`. Default the host's (`node:dns`).
   * Trusted, like the host's own resolver.
   */
  readonly resolver?: CrawlerResolver;
  /** The most crawler verifications (DNS lookups) in flight at once. Default `64`. */
  readonly maxPendingVerifications?: number;
  /**
   * How long a claimant waits for its verification, in ms; past it, it is
   * an ordinary client for that request (and nothing is cached). Default `500`.
   */
  readonly verifyTimeoutMs?: number;
}

/** What `signal()` can be told beside the event (layers.md L11.1). */
export interface SignalData {
  /** The attempted login identifier, when the facts' identity lacks it. */
  readonly username?: string;
  /** Where a code or link was sent, when the facts' identity lacks it. */
  readonly destination?: string;
}

/** Options for {@link Security.evaluate}. */
export interface EvaluateOptions {
  /**
   * The caller will call {@link Security.complete} for this decision once
   * the request is answered, so the request may take an in-flight slot and
   * layer L1's concurrency limits apply to it. Default `false`: L1's counts
   * are not applied, so a caller that never completes cannot lock a client
   * out. `withSecurity` tracks every request.
   */
  readonly track?: boolean;
  /**
   * Evaluates one stage of a two-stage integration (plan §3.3): `"early"`,
   * before the request is read or routed, or `"route"`, once the route and
   * the caller are known. Each limit and counted rule is counted in exactly
   * one stage (see {@link EvaluationStage}), so a request evaluated in both
   * is counted once; `complete()` then counts the outcome events of each
   * decision's own stage. The in-flight limits, the trust check, the lists'
   * address entries, address and range bans, L6's shape checks and L8's
   * honeypots run in the early stage; the lists' user and API-key entries,
   * bans naming the caller or the route, and L8's canary credentials in the
   * route stage. Default: both stages at once, as `withSecurity` does.
   */
  readonly stage?: EvaluationStage;
}

/** Options for {@link Security.explain}. */
export interface ExplainOptions {
  /** The time to evaluate at, epoch milliseconds (list expiries, windows). Default now. */
  readonly now?: number;
}

/** What happened to a request after the engine admitted it (layer L14). */
export interface RequestOutcome {
  /** The answer's status; `0` when none was sent (the connection closed first). */
  readonly status: number;
  /**
   * Whether no route matched: the router's not-found answer, never an app's
   * own `404` for a missing record. Counted as the `route.notFound` event.
   */
  readonly routeNotFound?: boolean;
}

/** The shared store's state, for {@link Security.status}. */
export interface SharedStoreStatus {
  /** The store's name. */
  readonly name: string;
  /** Whether it is answering. */
  readonly healthy: boolean;
  /** When the current run of failures began, epoch ms. */
  readonly failingSince: number | undefined;
  /** Ban writes waiting for it. */
  readonly pendingBans: number;
  /** Ban writes dropped from a full queue. */
  readonly droppedBans: number;
  /** The last ban log record read. */
  readonly banCursor: number;
  /** When the bans were last reloaded whole from it, epoch ms. */
  readonly reconciledAt: number | undefined;
  /** Offence scores and ban histories waiting to sync. */
  readonly pendingScores: number;
}

/** The engine's local state, for {@link Security.status}. */
export interface StateStatus {
  /** Tracked requests in flight. */
  readonly inFlight: number;
  /** Client addresses with a tracked request in flight. */
  readonly inFlightClients: number;
  /** Bans in force that a counted rule wrote. */
  readonly trips: number;
  /** Bans in force, every source. */
  readonly bans: number;
  /** Automatic bans dropped because even their widened range did not fit `bans.maxActive`. */
  readonly bansDropped: number;
  /** Client addresses with an offence score. */
  readonly scores: number;
  /** Entries dropped from a full table since the engine started. */
  readonly evictions: number;
  /** The `state.evictions` warning in force, if any. */
  readonly warning: SecurityWarning | undefined;
  /** The shared store's state; absent without one. */
  readonly store?: SharedStoreStatus;
}

/** What {@link Security.status} reports. */
export interface SecurityStatus {
  /** The policy in force. */
  readonly policy: CompiledPolicy;
  /** The trust check's gauges and warnings. */
  readonly trust: TrustStatus;
  /** The local state's sizes and evictions. */
  readonly state: StateStatus;
}

/** The engine `createSecurity()` returns. */
export interface Security<TRequest = Request> {
  /** The policy in force. */
  readonly policy: CompiledPolicy;
  /**
   * The crawler conflicts (layers.md L3.2): refusing list entries and
   * manual bans that cover an allowed crawler's published ranges. Each is
   * also raised as a `crawler.conflict` warning when found at start or on
   * `load()`; call this again once the range feeds have loaded.
   */
  readonly crawlerConflicts: () => readonly CrawlerConflict[];
  /** The challenge flow, when the engine was given one (`createSecurity`'s `challenge`). */
  readonly challenge: ChallengeFlow | undefined;
  /** Whether {@link close} was called. */
  readonly closed: boolean;
  /**
   * Decides one request. Synchronous while every store in play is (the
   * default memory store is); a promise otherwise. With `{ track: true }`
   * the caller promises to call {@link complete} once the request is
   * answered.
   */
  evaluate: (
    facts: RequestFacts,
    options?: EvaluateOptions,
  ) => Decision | Promise<Decision>;
  /**
   * What {@link evaluate} would decide for these facts, and why, with no
   * state written (limits are read with the throttle's `peek()`). Layer L1
   * is explained as for a tracked request. `explain(f).decision` equals
   * `evaluate(f, { track: true })` at the same time and state.
   */
  explain: (
    facts: RequestFacts,
    options?: ExplainOptions,
  ) => Explanation | Promise<Explanation>;
  /** Runs the `identify` hook (`undefined` without one). */
  identify: (
    request: TRequest,
  ) => SecurityIdentity | undefined | Promise<SecurityIdentity | undefined>;
  /**
   * Reports how an admitted request ended (layer L14): gives back its
   * in-flight slot, and counts `route.notFound` (no route matched) and
   * `server.error` (a `5xx`) for counted rules. Answers the hits it caused
   * (a counted rule tripping). Only the first call for a decision counts;
   * a refused decision, or one this engine's `evaluate()` did not make,
   * counts nothing.
   */
  complete: (
    facts: RequestFacts,
    decision: Decision,
    outcome: RequestOutcome,
  ) => readonly RuleHit[] | Promise<readonly RuleHit[]>;
  /**
   * Counts one occurrence of an app's event (`auth.failure`, `signup`,
   * `password.reset`, any name of its own) for counted rules, under the
   * subject of `facts` (layers.md §0.2, L11.1). Answers the hits it caused
   * (a counted rule tripping, which refuses the key's later requests).
   * Throws a `TypeError` for a name outside the event grammar.
   */
  signal: (
    facts: RequestFacts,
    event: string,
    data?: SignalData,
  ) => readonly RuleHit[] | Promise<readonly RuleHit[]>;
  /**
   * Refuses an identifier or a password where data is created (layers.md
   * L11.7, D24): an email, phone number, username or domain matching an
   * operator's pattern or the built-in policy for self-chosen addresses, or
   * a password the `breachedPassword` hook says is breached. Throws (or
   * rejects with) a {@link SecurityRefusal} with one generic message
   * whatever matched; a pattern's match also counts `pattern.hit` under
   * `facts`' client (none for a job's call without facts). Call it in the
   * code that creates the record, whatever route or job reached it.
   */
  check: (
    facts: RequestFacts | undefined,
    kind: CheckKind,
    value: string,
  ) => void | Promise<void>;
  /**
   * The `Set-Cookie` value of a device cookie issued for these facts'
   * successful login (layers.md L11.4), or `undefined` (no success
   * signalled, devices off). `./http` and `./serve` set it themselves.
   */
  deviceCookie: (facts: RequestFacts) => string | undefined;
  /** Lifts a username's soft lock and clears its failures (an operator's unlock). */
  unlock: (username: string) => Promise<void>;
  /**
   * Replaces the policy: compiled first, swapped in at once, so a request
   * is decided wholly by the old policy or wholly by the new. Throws a
   * `SecurityPolicyError` (or the throttle's `ConfigError`) and keeps the
   * old policy when the new one is refused. Limits whose id, window and
   * algorithm are unchanged keep their counts; trips of a counted rule the
   * new policy removes or turns off end.
   */
  load: (policy: SecurityPolicy | CompiledPolicy) => CompiledPolicy;
  /** The policy in force, the trust check's gauges and the local state. */
  status: () => SecurityStatus;
  /**
   * Bans a subject by hand (layers.md L4): an address (an IPv6 one by its
   * key prefix), a CIDR range, a user id or an API key id, for `duration`
   * (default `"24h"`; `null` until lifted, deliberately). Merged with a ban
   * in force for the subject, whose reason it replaces. Manual bans are
   * never dropped at `bans.maxActive`. Throws a `TypeError` for a bad input.
   */
  ban: (input: BanInput) => Ban;
  /**
   * Lifts a ban by its id (`ip:203.0.113.5`, `cidr:203.0.113.0/24`,
   * `user:u_1`): the lifted record, or `undefined` when none is in force.
   * Lifting an automatic address ban also clears the address's score.
   */
  unban: (id: string, options?: UnbanOptions) => Ban | undefined;
  /** The bans in force. */
  bans: () => readonly Ban[];
  /**
   * Resolves once the bans have been loaded from the shared store at start
   * (or the load failed, which is logged): a service that waits for it
   * enforces the fleet's bans from its first request. At once without a
   * shared store. Never rejects.
   */
  ready: () => Promise<void>;
  /**
   * Writes what is waiting for the shared store now (ban writes, offence
   * scores, hybrid counts) and reads the ban log. Never rejects: failures
   * are logged and kept for later. At once without a shared store.
   */
  flush: () => Promise<void>;
  /**
   * The message limits of one WebSocket connection (layers.md L9.5), from
   * its upgrade request's facts: call `message()` for each inbound message.
   * Throws when the engine is closed.
   */
  socket: (facts: RequestFacts) => SocketLimiter;
  /**
   * Stops the engine: later `evaluate()` and `explain()` calls throw. With a
   * shared store, its timers stop and a last write starts; `flush()` waits
   * for it.
   */
  close: () => void;
}

/** What to do with one inbound WebSocket message (layers.md L9.5). */
export interface MessageDecision {
  /** `allow` it; `drop` it unanswered; `close` the connection. */
  readonly action: "allow" | "drop" | "close";
  /** The close code, with `close`. */
  readonly code?: number;
  /** The close reason (the limit's code), with `close`. */
  readonly reason?: string;
  /** Every rule that matched, dry-run ones as `log`. */
  readonly hits: readonly RuleHit[];
}

/** One WebSocket connection's message limits, from {@link Security.socket}. */
export interface SocketLimiter {
  /** Counts one inbound message and answers what to do with it: synchronous while every limit in play is local. */
  message: () => MessageDecision | Promise<MessageDecision>;
}

/** What {@link Security.ban} takes: exactly one subject. */
export interface BanInput {
  /** An address (banned by its key: IPv4 as itself, IPv6 by `keys.ipv6Prefix`) or a CIDR range. */
  readonly ip?: string;
  /** A user id, as `identify()` returns it. */
  readonly user?: string;
  /** An API key id, as `identify()` returns it. */
  readonly apiKey?: string;
  /** `ban` (the default) or `challenge` (a `block` without a challenge flow). */
  readonly action?: "ban" | "challenge";
  /** How long, its unit written. Default `"24h"`; `null` until lifted. */
  readonly duration?: Duration | null;
  /** Why, for operators; never sent to the client. */
  readonly reason?: string;
  /** Who banned it. */
  readonly by?: string;
  /** The problem code it answers with. Default the policy's `bans.code`. */
  readonly code?: string;
}

/** Options for {@link Security.unban}. */
export interface UnbanOptions {
  /** Who lifted it. */
  readonly by?: string;
}

/** No hits, no tags: shared by every decision without them. */
const EMPTY: readonly never[] = Object.freeze([]);

/** Headers that mean a proxy forwarded the request. */
const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "forwarded",
  "x-real-ip",
] as const;

/** The `Retry-After` of a `503` for a failing shared store (`onStoreError: "closed"`), in seconds. */
const STORE_RETRY_AFTER = 5;

/** How often one kind of hook error is logged at most. */
const ERROR_LOG_INTERVAL = 10_000;

/** An event name `signal()` accepts. */
const EVENT_RE = /^[a-z][\w.-]{0,63}$/i;

/** How a refusing hit answers. */
interface Answer {
  /** The status. */
  readonly status: number;
  /** The problem code. */
  readonly code: string;
  /** Seconds until it ends, when known. */
  readonly retryAfter?: number;
}

/** What later layers need to know of the earlier ones. */
interface Flags {
  /** An explicit allow entry decided: later refusing layers are skipped (`evenWhenAllowed` limits excepted). */
  readonly allowAll: boolean;
  /** The client is in the `internal` list: address-only keys are skipped. */
  readonly internal: boolean;
  /** The verified calling service. */
  readonly service: CompiledService | undefined;
}

/** What `complete()` needs from `evaluate()`. */
interface Context {
  /** The in-flight slot taken, if any. */
  readonly slot: Slot | undefined;
  /** The flags. */
  readonly flags: Flags;
  /** The stage it was evaluated in; both when undefined. */
  readonly stage: EvaluationStage | undefined;
}

/** One evaluation pass: what every stage after the lists reads, and the hits so far. */
interface Pass {
  /** The request's keys. */
  readonly subject: SubjectKeys;
  /** Where the request sits. */
  readonly route: RequestRoute;
  /** The client's address, parsed; `null` when it counts against nobody. */
  readonly address: ParsedAddress | null;
  /** What the lists decided. */
  readonly flags: Flags;
  /** The time. */
  readonly now: number;
  /** Whether state is written (`evaluate`) or only read (`explain`). */
  readonly writes: boolean;
  /** Whether the whole policy runs in dry run. */
  readonly dryPolicy: boolean;
  /** The explanation's steps, when explaining. */
  readonly trace: ExplainStep[] | undefined;
  /** The hits. */
  readonly run: Run;
  /** The stage being evaluated; both when undefined. */
  readonly stage: EvaluationStage | undefined;
  /** With writes off, the address's score as this request's offences leave it. */
  score?: number;
  /** The request's crawler claim (layers.md L3.2), if its `User-Agent` names an allowed crawler. */
  readonly crawler?: CrawlerRequest | undefined;
}

/**
 * Events both stages of a two-stage integration see: each adds its offence
 * weight once, in the early stage (or when no stage is given).
 */
const SHARED_EVENTS: ReadonlySet<string> = new Set([
  "request",
  "route.notFound",
  "server.error",
]);

/** A ban type (`ip`, `ip|user`) as a key to look the request up with. */
const TYPE_KEYS = new Map<string, CompiledKey>();

/** The key of a ban type, cached. */
function keyOfType(type: string): CompiledKey {
  let key = TYPE_KEYS.get(type);
  if (key === undefined) {
    const parts = (type === "cidr" ? [] : type.split("|")) as SubjectKeyPart[];
    key = {
      parts,
      addressOnly: parts.every((part) => part === "ip" || part === "route"),
    };
    if (TYPE_KEYS.size < 256) TYPE_KEYS.set(type, key);
  }
  return key;
}

/** One WebSocket connection's state for its message limits. */
interface Connection {
  /** The upgrade request's keys. */
  readonly subject: SubjectKeys;
  /** Where the upgrade request sat. */
  readonly route: RequestRoute;
  /** What the lists decided for it. */
  readonly flags: Flags;
  /** Tokens left in its bucket. */
  tokens: number;
  /** When the bucket was last refilled. */
  refilledAt: number;
  /** When it last breached a limit. */
  lastBreach: number;
}

/** A message let through with no hits. */
const ALLOW_MESSAGE: MessageDecision = Object.freeze({
  action: "allow",
  hits: EMPTY,
});

/**
 * What a `challenge` hit does for one request: `challenge` the client,
 * let it pass as `cleared` (a valid clearance) or as a verified `crawler`
 * (never challenged), or `block` it (no challenge flow).
 */
type ChallengeOutcome = "challenge" | "cleared" | "crawler" | "block";

/** The text a challenge that fell back to a block carries. */
const CHALLENGE_FALLBACK =
  "challenge: no challenge provider configured, fell back to block";

/** The hits of one decision, as they accumulate. */
class Run {
  /** Every hit, in order. */
  readonly hits: RuleHit[] = [];
  /** How each refusing hit answers. */
  readonly answers = new Map<RuleHit, Answer>();
  /** Whether an enforced hit refused the request. */
  refused = false;
  /** Risk the bot signals added (layers.md L10.1), beside the refusing hits'. */
  risk = 0;
  /** Tags for the app (`step-up`, `risky-success`). */
  readonly tags = new Set<string>();
  /** The longest `delay` asked for, ms. */
  delayMs = 0;
  /** The request's crawler claim (layers.md L3.2), for the decision. */
  crawler: CrawlerRequest | undefined;

  constructor(
    /**
     * What a challenge does for this request (layers.md L10.2), worked out
     * on the first challenge; `undefined` without a challenge flow, where a
     * challenge falls back to a block.
     */
    readonly challenge: (() => ChallengeOutcome) | undefined,
  ) {}

  /** The challenge outcome, worked out once. */
  #outcome: ChallengeOutcome | undefined;

  /**
   * Records a hit, and how it answers when it refuses. A `challenge` hit is
   * resolved here, in one place for every layer: a challenge when the
   * engine has a flow and the client holds no clearance, `log` when it does
   * (or is a verified crawler, never challenged), and a `block` with the
   * hit's own answer when there is no flow.
   */
  add(hit: RuleHit, answer?: Answer): void {
    let recorded = hit;
    let answered = answer;
    if (hit.action === "challenge") {
      this.#outcome ??= this.challenge?.() ?? "block";
      const outcome = this.#outcome;
      const suffix =
        outcome === "block"
          ? CHALLENGE_FALLBACK
          : outcome === "cleared"
            ? "challenge passed: the client holds a valid clearance"
            : outcome === "crawler"
              ? "a verified crawler is never challenged"
              : undefined;
      const reason =
        suffix === undefined
          ? hit.reason
          : hit.reason
            ? `${hit.reason}; ${suffix}`
            : suffix;
      recorded = {
        ...hit,
        action:
          outcome === "challenge"
            ? "challenge"
            : outcome === "block"
              ? "block"
              : "log",
        ...(reason === undefined ? {} : { reason }),
      };
      answered =
        outcome === "challenge"
          ? { status: 403, code: "challenge_required" }
          : outcome === "block"
            ? answer
            : undefined;
    } else if (
      hit.wouldHaveBeen === "challenge" &&
      this.challenge === undefined
    ) {
      recorded = { ...hit, wouldHaveBeen: "block" };
    }
    this.hits.push(recorded);
    if (answered !== undefined) this.answers.set(recorded, answered);
    if (refuses(recorded.action)) this.refused = true;
  }
}

/** The L3 hit for a decided entry. */
function entryHit(entry: CompiledEntry): RuleHit {
  if (entry.action === "challenge") {
    // Resolved by `Run.add`: a challenge, a pass, or a fallback block.
    return { layer: "L3", rule: entry.id, action: "challenge" };
  }
  return {
    layer: "L3",
    rule: entry.id,
    action: entry.action,
    reason:
      entry.kind === "internal" ? "internal list" : `${entry.action} list`,
  };
}

/**
 * Whether a list entry's hit is recorded in `stage`: entries naming the
 * caller (a user, an API key) in the route stage, address entries in the
 * early stage, every entry when no stage is given.
 */
function ownEntry(
  entry: CompiledEntry,
  stage: EvaluationStage | undefined,
): boolean {
  if (stage === undefined) return true;
  const caller = entry.kind === "user" || entry.kind === "apiKey";
  return caller === (stage === "route");
}

/** The action an entry takes once applied (a `challenge` is resolved by `Run.add`). */
function appliedAction(entry: CompiledEntry): SecurityAction {
  return entry.action;
}

/** The action a tripped counted rule takes (a `challenge` is resolved by `Run.add`). */
function tripAction(rule: CompiledCountedRule): SecurityAction {
  return rule.action === "challenge" ? "challenge" : "ban";
}

/** Whole seconds, rounded up, at least 1. */
function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/** A window for a reason: `"1m"`-like text. */
function windowText(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/** Whether a rule keyed on `key` skips a request with these flags (lists' allow, the internal list). */
function shieldedBy(flags: Flags, key: CompiledKey): boolean {
  return flags.allowAll || (flags.internal && key.addressOnly);
}

/** The engine. */
class SecurityEngine<TRequest> implements Security<TRequest> {
  /** The policy in force. */
  #policy: CompiledPolicy;
  /** Its compiled internals. */
  #internals: PolicyInternals;
  /** Its limits' throttles. */
  #limits: LimitSet;
  /** Its message limits' throttles. */
  #messageLimits: LimitSet;
  /** The store key prefix of the policy in force. */
  #prefix: string;
  /** The trust check. */
  readonly #trust: TrustMonitor;
  /** The logger. */
  readonly #logger: Logger;
  /** The clock. */
  readonly #now: () => number;
  /** The options. */
  readonly #options: CreateSecurityOptions<TRequest>;
  /** The limits' throttles, kept across policies. */
  readonly #limiter: Limiter;
  /** The message limits' throttles, kept across policies. */
  readonly #messageLimiter: Limiter;
  /** Counted-rule counters and trips. */
  readonly #counted: CountedState;
  /** In-flight slots. */
  readonly #inFlight: InFlight;
  /** Bans in force. */
  readonly #bans: BanTable;
  /** Offence scores and ban history. */
  readonly #scores: Scores;
  /** The shared store, if any. */
  readonly #store: SharedStateStore | undefined;
  /** The ban log over the shared store. */
  readonly #banSync: BanSync | undefined;
  /** The scores' sync over the shared store. */
  readonly #scoreSync: ScoreSync | undefined;
  /** The background timers. */
  readonly #timers: ReturnType<typeof setInterval>[] = [];
  /** The first load of the bans. */
  #ready: Promise<void> = Promise.resolve();
  /** The last write after `close()`. */
  #final: Promise<void> | undefined;
  /** Whether the `store.unavailable` warning was raised for the current failure. */
  #storeWarned = false;
  /** When the `bans.aggregated` warning was last raised. */
  #lastAggregated = Number.NEGATIVE_INFINITY;
  /** Evictions of local state. */
  readonly #evictions: EvictionMonitor;
  /** What each tracked decision needs at `complete()`. */
  readonly #contexts = new WeakMap<Decision, Context>();
  /** Whether closed. */
  #closed = false;
  /** When a hook error was last logged. */
  #lastHookError = Number.NEGATIVE_INFINITY;
  /** The sensitive endpoints' keys. */
  readonly #keyring: Keyring;
  /** The login defences. */
  readonly #login: LoginDefences;
  /** Facts an app signalled `auth.*` for (outcome inference stands aside). */
  readonly #signalled = new WeakSet<RequestFacts>();
  /** Device cookies issued for facts, until the integration sets them. */
  readonly #devices = new WeakMap<RequestFacts, string>();
  /** Crawler verification (layers.md L3.2). */
  readonly #verifier: CrawlerVerifier;
  /** Each claimant request's crawler state, by its facts. */
  readonly #claims = new WeakMap<RequestFacts, CrawlerRequest>();
  /** When the `login.risky-success` warning was last raised. */
  #lastRisky = Number.NEGATIVE_INFINITY;

  constructor(options: CreateSecurityOptions<TRequest>) {
    this.#options = options;
    const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) {
      throw new ConfigError(
        `createSecurity(): maxKeys must be a positive whole number; got ${String(maxKeys)}`,
        { maxKeys },
      );
    }
    const store = options.throttleStore;
    if (
      store !== undefined &&
      (typeof store !== "object" ||
        store === null ||
        typeof store.increment !== "function" ||
        typeof store.get !== "function")
    ) {
      throw new ConfigError(
        "createSecurity(): throttleStore must be a ThrottleStore, with increment(key, cost, ttl) and get(key)",
      );
    }
    const shared = options.store;
    if (
      shared !== undefined &&
      (typeof shared !== "object" ||
        shared === null ||
        typeof shared.throttle !== "object" ||
        typeof shared.increment !== "function" ||
        typeof shared.getMany !== "function" ||
        typeof shared.health !== "function")
    ) {
      throw new ConfigError(
        "createSecurity(): store must be a SharedStateStore, such as cacheStore(cache) from @kingsleyweb/bun-security/stores",
      );
    }
    const maxPendingBans = options.maxPendingBans ?? 10_000;
    if (!Number.isSafeInteger(maxPendingBans) || maxPendingBans < 1) {
      throw new ConfigError(
        `createSecurity(): maxPendingBans must be a positive whole number; got ${String(maxPendingBans)}`,
        { maxPendingBans },
      );
    }
    this.#policy = compilePolicy(options.policy);
    checkIntel(this.#policy, options.intel, "createSecurity()");
    // Compiled now, so the first request pays nothing for them.
    requestRulesOf(this.#policy);
    this.#internals = policyInternals(this.#policy);
    this.#logger = resolveLogger(
      options.logger,
      createLogger({ name: "bun-security" }),
    );
    this.#now = options.now ?? Date.now;
    this.#trust = new TrustMonitor((warning) => this.#warn(warning));
    this.#evictions = new EvictionMonitor(
      (warning) => this.#warn(warning),
      () => this.#policy.service,
    );
    for (const [name, value] of [
      ["maxPendingVerifications", options.maxPendingVerifications],
      ["verifyTimeoutMs", options.verifyTimeoutMs],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new ConfigError(
          `createSecurity(): ${name} must be a positive whole number; got ${String(value)}`,
        );
      }
    }
    this.#verifier = new CrawlerVerifier({
      ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
      ...(options.maxPendingVerifications === undefined
        ? {}
        : { maxPendingVerifications: options.maxPendingVerifications }),
      ...(options.verifyTimeoutMs === undefined
        ? {}
        : { verifyTimeoutMs: options.verifyTimeoutMs }),
      ...(options.store === undefined ? {} : { store: options.store }),
      now: this.#now,
    });
    const counters = store ?? memoryThrottleStore({ maxKeys, now: this.#now });
    const stores = {
      local: counters,
      shared: shared?.throttle,
      hybrid: shared?.hybrid,
    };
    this.#limiter = new Limiter(stores, this.#now, this.#logger, "limit");
    this.#messageLimiter = new Limiter(
      stores,
      this.#now,
      this.#logger,
      "message limit",
    );
    this.#counted = new CountedState(counters, shared?.throttle, this.#logger);
    this.#bans = new BanTable(() => this.#internals.bans.maxActive);
    this.#scores = new Scores(maxKeys, this.#evictions);
    this.#inFlight = new InFlight(maxKeys, this.#evictions);
    // Every process sharing a store must key usernames and sign device
    // cookies alike, or the login defences hold in none of them.
    if (shared !== undefined && options.secret === undefined) {
      throw new ConfigError(
        "createSecurity(): a shared store needs a secret: every process sharing it keys usernames and destinations and signs device cookies with it, so give each the same one (at least 32 bytes)",
      );
    }
    this.#keyring = new Keyring(options.secret);
    this.#login = new LoginDefences({
      local: counters,
      shared: shared?.throttle,
      distinct: new DistinctCounts(
        shared,
        maxKeys,
        this.#evictions,
        this.#logger,
      ),
      ban: (write, now) => {
        this.#writeBan(write, now);
      },
      risky: (now) => {
        this.#risky(now);
      },
      logger: this.#logger,
    });
    this.#prefix = prefixOf(this.#policy);
    this.#checkCounted(this.#internals);
    const prepared = this.#limiter.prepare(
      this.#internals.limits,
      this.#prefix,
      this.#internals.nodes,
    );
    const preparedMessages = this.#messageLimiter.prepare(
      this.#internals.messages?.limits ?? [],
      `${this.#prefix}:messages`,
      this.#internals.nodes,
    );
    prepared.commit();
    preparedMessages.commit();
    this.#limits = prepared.set;
    this.#messageLimits = preparedMessages.set;
    this.#store = shared;
    if (shared !== undefined) {
      const sink: BanSink = {
        merge: (ban) => {
          this.#bans.merge(ban, this.#now());
        },
        remove: (id) => {
          this.#bans.remove(id);
        },
        reconcile: (set, complete) => {
          this.#bans.reconcile(
            set,
            complete,
            (id) => this.#banSync?.pending(id) === true,
            this.#now(),
          );
        },
        keep: (ban) => this.#keepBan(ban),
        scope: () => this.#scopeKey(),
        list: () => this.#bans.list(this.#now()),
      };
      this.#banSync = new BanSync(
        shared,
        sink,
        this.#now,
        this.#logger,
        maxPendingBans,
      );
      this.#scoreSync = new ScoreSync(
        shared,
        this.#scores,
        this.#now,
        this.#logger,
        10 * shared.intervals.sync,
        () => this.#scorePrefix(),
      );
      this.#start(shared);
    }
    this.#reportConflicts();
  }

  /** Starts the shared store's background work: the first load, the timers, the bus. */
  #start(shared: SharedStateStore): void {
    const banSync = this.#banSync;
    const scoreSync = this.#scoreSync;
    if (banSync === undefined || scoreSync === undefined) return;
    const every = (ms: number, run: () => Promise<unknown>): void => {
      const timer = setInterval(() => {
        if (this.#closed) return;
        run().catch((error: unknown) => {
          this.#logger.error("bun-security: a shared-store task threw", {
            error,
          });
        });
      }, ms);
      timer.unref?.();
      this.#timers.push(timer);
    };
    this.#ready = banSync.reload().catch((error: unknown) => {
      this.#logger.warn(
        `bun-security: the bans could not be loaded from the shared store "${shared.name}" at start; they will be at the next reconcile`,
        { error },
      );
    });
    every(shared.intervals.poll, async () => {
      this.#checkStore();
      await banSync.write();
      await banSync.read();
    });
    every(shared.intervals.reconcile, async () => {
      try {
        await banSync.reload();
        await banSync.compact();
      } catch (error) {
        this.#logger.warn(
          `bun-security: the bans could not be reconciled with the shared store "${shared.name}"`,
          { error },
        );
      }
    });
    every(shared.intervals.sync, () => scoreSync.sync(this.#internals.ladder));
    if (shared.listen !== undefined) {
      shared
        .listen(
          () => {
            if (!this.#closed) void banSync.read();
          },
          () => {
            if (!this.#closed) {
              banSync.reload().catch(() => undefined);
            }
          },
        )
        .then(
          (stop) => {
            if (this.#closed) void stop();
            else this.#unlisten = stop;
          },
          (error: unknown) => {
            this.#logger.warn(
              `bun-security: could not listen to the shared store "${shared.name}"'s bus; bans propagate by polling`,
              { error },
            );
          },
        );
    }
  }

  /** Stops listening to the bus. */
  #unlisten: (() => Promise<void>) | undefined;

  /** Raises `store.unavailable` once the shared store has failed for 30 s; clears it on recovery. */
  #checkStore(): void {
    const store = this.#store;
    if (store === undefined) return;
    const health = store.health();
    if (health.healthy) {
      this.#storeWarned = false;
      return;
    }
    const now = this.#now();
    const since = health.failingSince;
    if (this.#storeWarned || since === undefined || now - since < 30_000) {
      return;
    }
    this.#storeWarned = true;
    this.#warn(
      Object.freeze({
        kind: "store.unavailable",
        message: `bun-security: the shared store "${store.name}" has been failing for ${Math.round((now - since) / 1000)} s; limits run as their onStoreError says and bans apply from memory`,
        service: this.#policy.service,
        minutes: Math.max(1, Math.round((now - since) / 60_000)),
        share: 1,
        since,
      }),
    );
  }

  /**
   * Refuses a policy whose counted rules need a shared store the engine
   * lacks (`state: "shared"`).
   */
  #checkCounted(internals: PolicyInternals): void {
    if (this.#options.store !== undefined) return;
    const rule = internals.countedRules.find((r) => r.state === "shared");
    if (rule !== undefined) {
      throw new ConfigError(
        `bun-security: counted rule "${rule.id}" counts in the shared store (state "shared"), but the engine has none: give createSecurity a store, such as cacheStore(cache) from @kingsleyweb/bun-security/stores`,
        { rule: rule.id },
      );
    }
  }

  /**
   * Whether a ban applies here: not one this service's counted rule wrote
   * when the policy in force has removed that rule or turned it off.
   */
  #keepBan(ban: Ban): boolean {
    // Another scope's ban (state.scope) never applies here.
    if (scopeKey(ban) !== this.#scopeKey()) return false;
    if (
      ban.source !== "auto" ||
      ban.rule === undefined ||
      !ban.rule.startsWith("counted:") ||
      ban.service !== this.#policy.service
    ) {
      return true;
    }
    const id = ban.rule.slice("counted:".length);
    return this.#internals.countedRules.some(
      (rule) => rule.id === id && rule.mode === "enforce",
    );
  }

  /** This engine's ban scope ({@link scopeKey}): `shared`, or its service's own. */
  #scopeKey(): string {
    return this.#internals.scope === "service"
      ? `service:${this.#policy.service ?? ""}`
      : "shared";
  }

  /** What the engine's ban writes carry: its service, and `scope: "service"` when its scope is its own. */
  #stamp(): { service?: string; scope?: "service" } {
    return {
      ...(this.#policy.service === undefined
        ? {}
        : { service: this.#policy.service }),
      ...(this.#internals.scope === "service"
        ? { scope: "service" as const }
        : {}),
    };
  }

  /** The shared store's key prefix of this engine's scores: none when shared, its service's when its own. */
  #scorePrefix(): string {
    return this.#internals.scope === "service"
      ? `svc:${this.#policy.service ?? ""}:`
      : "";
  }

  crawlerConflicts(): readonly CrawlerConflict[] {
    return crawlerConflicts(this.#policy, this.#options.intel, [
      ...this.#bans.list(this.#now()),
    ]);
  }

  /** Raises a `crawler.conflict` warning for each conflict found now. */
  #reportConflicts(): void {
    let conflicts: readonly CrawlerConflict[];
    try {
      conflicts = this.crawlerConflicts();
    } catch (error) {
      this.#logger.error("bun-security: the crawler conflict check failed", {
        error,
      });
      return;
    }
    for (const conflict of conflicts) {
      this.#warn({
        kind: "crawler.conflict",
        message: `bun-security: crawler conflict: ${conflict.message}`,
        service: this.#policy.service,
        minutes: 0,
        share: 0,
        since: this.#now(),
      });
    }
  }

  get challenge(): ChallengeFlow | undefined {
    return this.#options.challenge;
  }

  get policy(): CompiledPolicy {
    return this.#policy;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Logs and forwards a warning. */
  #warn(warning: SecurityWarning): void {
    this.#logger.warn(warning.message, {
      kind: warning.kind,
      service: warning.service,
      minutes: warning.minutes,
      share: warning.share,
    });
    try {
      this.#options.onWarning?.(warning);
    } catch (error) {
      this.#hookError("onWarning", error);
    }
  }

  /** Logs a hook's error, at most once per {@link ERROR_LOG_INTERVAL}. */
  #hookError(hook: string, error: unknown): void {
    const now = this.#now();
    if (now - this.#lastHookError < ERROR_LOG_INTERVAL) return;
    this.#lastHookError = now;
    this.#logger.error(`bun-security: the ${hook} hook threw`, { error });
  }

  /** Throws when closed. */
  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("bun-security: the engine is closed");
    }
  }

  identify(
    request: TRequest,
  ): SecurityIdentity | undefined | Promise<SecurityIdentity | undefined> {
    return this.#options.identify?.(request);
  }

  evaluate(
    facts: RequestFacts,
    options: EvaluateOptions = {},
  ): Decision | Promise<Decision> {
    this.#assertOpen();
    return then(
      this.#decide(
        facts,
        this.#now(),
        true,
        undefined,
        options.track === true,
        options.stage,
      ),
      ({ decision }) => {
        if (this.#options.onDecision) {
          try {
            this.#options.onDecision(decision, facts);
          } catch (error) {
            this.#hookError("onDecision", error);
          }
        }
        return decision;
      },
    );
  }

  explain(
    facts: RequestFacts,
    options: ExplainOptions = {},
  ): Explanation | Promise<Explanation> {
    this.#assertOpen();
    const steps: ExplainStep[] = [];
    return then(
      this.#decide(
        facts,
        options.now ?? this.#now(),
        false,
        steps,
        true,
        undefined,
      ),
      ({ decision, resolved }) => {
        const client: ClientResolution = {
          ...(resolved.address
            ? { address: resolved.address.text, key: resolved.subject.ip }
            : {}),
          source: resolved.source,
          chain: facts.chain,
          ...(resolved.service ? { service: resolved.service.id } : {}),
        };
        return Object.freeze({
          decision,
          client,
          steps: Object.freeze(steps),
        });
      },
    );
  }

  complete(
    facts: RequestFacts,
    decision: Decision,
    outcome: RequestOutcome,
  ): readonly RuleHit[] | Promise<readonly RuleHit[]> {
    const context = this.#contexts.get(decision);
    if (context === undefined) return EMPTY;
    this.#contexts.delete(decision);
    if (context.slot !== undefined) this.#inFlight.release(context.slot);
    if (
      this.#closed ||
      refuses(decision.action) ||
      this.#internals.mode === "off"
    ) {
      return EMPTY;
    }
    const events: string[] = [];
    if (
      outcome.routeNotFound === true &&
      // Not counted against a verified crawler on its allowance (L3.2).
      !this.#crawlerExempt(facts, "notFound")
    ) {
      events.push("route.notFound");
    }
    if (outcome.status >= 500) events.push("server.error");
    const inferred = this.#inferred(facts, context.stage, outcome.status);
    if (events.length === 0 && inferred === undefined) return EMPTY;
    const counted =
      events.length === 0
        ? EMPTY
        : this.#occurAll(
            events,
            facts,
            decision.subject,
            context.flags,
            this.#now(),
            context.stage,
          );
    if (inferred === undefined) return counted;
    return then(counted, (hits) =>
      then(this.signal(facts, inferred), (more) =>
        more.length === 0 ? hits : Object.freeze([...hits, ...more]),
      ),
    );
  }

  /**
   * The login outcome a route marked `login` answered, when the app
   * signalled none (layers.md L11.1): a `401` or `403` is `auth.failure`, a
   * `2xx` `auth.success`; for the route stage's decision only.
   */
  #inferred(
    facts: RequestFacts,
    stage: EvaluationStage | undefined,
    status: number,
  ): "auth.failure" | "auth.success" | undefined {
    if (stage === "early" || facts.profile !== "login") return undefined;
    if (this.#signalled.has(facts)) return undefined;
    const login = sensitiveOf(this.#policy).login;
    if (login === undefined || !login.inferOutcome) return undefined;
    if (facts.identity?.username === undefined) return undefined;
    if (status === 401 || status === 403) return "auth.failure";
    if (status >= 200 && status < 300) return "auth.success";
    return undefined;
  }

  signal(
    facts: RequestFacts,
    event: string,
    data?: SignalData,
  ): readonly RuleHit[] | Promise<readonly RuleHit[]> {
    this.#assertOpen();
    if (typeof event !== "string" || !EVENT_RE.test(event)) {
      throw new TypeError(
        `bun-security: signal(): ${JSON.stringify(event)} is not an event name (a letter, then letters, digits, "_", "." and "-", at most 64)`,
      );
    }
    if (this.#internals.mode === "off") return EMPTY;
    const now = this.#now();
    const internals = this.#internals;
    const resolved = this.#withAccount(
      resolveClient(facts, internals),
      facts,
      data,
    );
    if (event === "auth.failure" || event === "auth.success") {
      this.#signalled.add(facts);
    }
    const lists = resolved.service?.exempt.has("lists")
      ? undefined
      : evaluateLists(
          internals,
          resolved.address,
          resolved.subject.user,
          resolved.subject.apiKey,
          listPath(facts.path, internals),
          now,
          internals.mode === "dryRun",
          undefined,
          this.#options.intel,
        );
    const flags = flagsOf(lists, resolved.service);
    // The device cookie is issued at once, so an integration finds it as
    // soon as the call returns, whatever the store still has to do.
    if (event === "auth.success")
      this.#issueDevice(facts, resolved.subject, flags, now);
    // A crawler claim is known (verified) first: the ladder spares a
    // verified crawler (layers.md L3.2, `autoBans`).
    const counted = then(this.#claim(facts, undefined, undefined), () =>
      this.#occurAll([event], facts, resolved.subject, flags, now, undefined),
    );
    return then(counted, (hits) =>
      then(
        this.#loginSignal(facts, event, resolved.subject, flags, now),
        (more) =>
          more.length === 0 ? hits : Object.freeze([...hits, ...more]),
      ),
    );
  }

  /**
   * The login defences' part of a signal (layers.md L11.2): `auth.failure`
   * and `auth.success` on a request of a route marked `login`, with the
   * attempted username known.
   */
  #loginSignal(
    facts: RequestFacts,
    event: string,
    subject: SubjectKeys,
    flags: Flags,
    now: number,
  ): MaybePromise<readonly RuleHit[]> {
    if (event !== "auth.failure" && event !== "auth.success") return EMPTY;
    const login = sensitiveOf(this.#policy).login;
    const username = subject.username;
    if (
      login === undefined ||
      facts.profile !== "login" ||
      username === undefined ||
      flags.allowAll
    ) {
      return EMPTY;
    }
    const keys = { username, device: subject.device, ip: subject.ip };
    const prefix = this.#prefix;
    if (event === "auth.failure") {
      const dry = this.#internals.mode === "dryRun" || login.mode === "dryRun";
      return this.#login.failure(login, keys, prefix, dry, now);
    }
    return this.#login.success(login, keys, prefix, now);
  }

  /** Issues the device cookie of a successful login on a route marked `login` (layers.md L11.4). */
  #issueDevice(
    facts: RequestFacts,
    subject: SubjectKeys,
    flags: Flags,
    now: number,
  ): void {
    const login = sensitiveOf(this.#policy).login;
    const username = subject.username;
    if (
      login?.device === undefined ||
      facts.profile !== "login" ||
      username === undefined ||
      flags.allowAll
    ) {
      return;
    }
    const value = this.#keyring.issueDevice(username, now);
    this.#devices.set(
      facts,
      `${login.device.cookie}=${value}; Max-Age=${Math.floor(login.device.maxAge / 1000)}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
  }

  /**
   * `resolved` with the sensitive endpoints' keys (layers.md L2.3): the
   * attempted username's and the destination's HMAC (from `data`, else the
   * facts' identity), and the valid device cookie's id for that username.
   */
  #withAccount(
    resolved: ResolvedClient,
    facts: RequestFacts,
    data: SignalData | undefined,
  ): ResolvedClient {
    const username = data?.username ?? facts.identity?.username;
    const destination = data?.destination ?? facts.identity?.destination;
    if (username === undefined && destination === undefined) return resolved;
    const subject: { -readonly [K in keyof SubjectKeys]: SubjectKeys[K] } = {
      ...resolved.subject,
    };
    if (typeof username === "string" && username.trim() !== "") {
      subject.username = this.#keyring.username(username.slice(0, 1024));
      const device = sensitiveOf(this.#policy).login?.device;
      const value =
        device === undefined
          ? undefined
          : cookieValue(facts.headers.cookie, device.cookie);
      if (device !== undefined && value !== undefined) {
        const verified = this.#keyring.verifyDevice(
          value,
          subject.username,
          this.#now(),
          device.maxAge,
        );
        if (verified !== undefined) subject.device = verified.id;
      }
    }
    if (typeof destination === "string" && destination.trim() !== "") {
      const bounded = destination.slice(0, 1024);
      subject.destination = this.#keyring.destination(bounded);
      const prefix = this.#keyring.destinationPrefix(bounded);
      if (prefix !== undefined) subject.destinationPrefix = prefix;
    }
    return { ...resolved, subject };
  }

  /** Raises `login.risky-success`, at most once a minute. */
  #risky(now: number): void {
    if (now - this.#lastRisky < 60_000) return;
    this.#lastRisky = now;
    this.#warn(
      Object.freeze({
        kind: "login.risky-success",
        message:
          "bun-security: a login succeeded from an address with many failed logins: a hit in a credential-stuffing run, or a shared address; the request was tagged risky-success",
        service: this.#policy.service,
        minutes: 1,
        share: 1,
        since: now,
      }),
    );
  }

  check(
    facts: RequestFacts | undefined,
    kind: CheckKind,
    value: string,
  ): void | Promise<void> {
    this.#assertOpen();
    if (typeof value !== "string") {
      throw new TypeError("bun-security: check(): the value must be a string");
    }
    if (kind === "password") {
      const hook = this.#options.breachedPassword;
      if (hook === undefined) return undefined;
      const refuse = (breached: boolean): void => {
        if (breached) {
          throw new SecurityRefusal(
            PASSWORD_MESSAGE,
            400,
            "breached_password",
            "breached-password",
          );
        }
      };
      let answer: boolean | Promise<boolean>;
      try {
        answer = hook(value);
      } catch (error) {
        this.#hookError("breachedPassword", error);
        return undefined;
      }
      return answer instanceof Promise
        ? answer.then(refuse, (error: unknown) => {
            this.#hookError("breachedPassword", error);
          })
        : refuse(answer === true);
    }
    if (
      kind !== "email" &&
      kind !== "phone" &&
      kind !== "username" &&
      kind !== "domain"
    ) {
      throw new TypeError(
        `bun-security: check(): ${JSON.stringify(kind)} is not a kind (email, phone, username, domain, password)`,
      );
    }
    const identifiers = sensitiveOf(this.#policy).identifiers;
    const match = matchIdentifier(identifiers, kind, value);
    if (match === undefined) return undefined;
    const dry = match.dryRun || this.#internals.mode === "dryRun";
    this.#logger.info(`bun-security: check() matched ${match.rule}`, {
      rule: match.rule,
      kind,
      dryRun: dry,
    });
    const refusal = new SecurityRefusal(
      IDENTIFIER_MESSAGE,
      400,
      identifiers.code,
      match.rule,
    );
    const counted =
      facts === undefined || this.#internals.mode === "off"
        ? undefined
        : this.signal(facts, "pattern.hit");
    const finish = (): void => {
      if (!dry) throw refusal;
    };
    return counted instanceof Promise ? counted.then(finish) : finish();
  }

  deviceCookie(facts: RequestFacts): string | undefined {
    return this.#devices.get(facts);
  }

  async unlock(username: string): Promise<void> {
    this.#assertOpen();
    if (typeof username !== "string" || username.trim() === "") {
      throw new TypeError(
        "bun-security: unlock(): the username must be a non-empty string",
      );
    }
    await this.#login.unlock(
      this.#prefix,
      this.#keyring.username(username),
      this.#now(),
    );
  }

  load(policy: SecurityPolicy | CompiledPolicy): CompiledPolicy {
    this.#assertOpen();
    const compiled = compilePolicy(policy);
    checkIntel(compiled, this.#options.intel, "load()");
    requestRulesOf(compiled);
    const internals = policyInternals(compiled);
    const prefix = prefixOf(compiled);
    this.#checkCounted(internals);
    const previous = this.#internals;
    const before = this.#policy.service;
    // Built first: a refused throttle leaves the old policy in force.
    const prepared = this.#limiter.prepare(
      internals.limits,
      prefix,
      internals.nodes,
    );
    const preparedMessages = this.#messageLimiter.prepare(
      internals.messages?.limits ?? [],
      `${prefix}:messages`,
      internals.nodes,
    );
    prepared.commit();
    preparedMessages.commit();
    // One assignment each, no await between: a request sees one policy.
    this.#policy = compiled;
    this.#internals = internals;
    this.#limits = prepared.set;
    this.#verifier.clear();
    this.#reportConflicts();
    this.#messageLimits = preparedMessages.set;
    this.#prefix = prefix;
    // A counted rule removed or turned off lifts the bans it wrote here.
    const scopeChanged =
      previous.scope !== internals.scope || before !== compiled.service;
    this.#bans.prune((ban) => this.#keepBan(ban));
    if (scopeChanged) {
      // Another scope: its scores start afresh, its bans come from the store.
      this.#scores.clear();
      this.#banSync?.reapply();
    }
    return compiled;
  }

  ban(input: BanInput): Ban {
    this.#assertOpen();
    if (typeof input !== "object" || input === null) {
      throw new TypeError("bun-security: ban() takes an object");
    }
    const given = (["ip", "user", "apiKey"] as const).filter(
      (key) => input[key] !== undefined,
    );
    const only = given[0];
    if (given.length !== 1 || only === undefined) {
      throw new TypeError(
        "bun-security: ban() takes exactly one of ip, user, apiKey",
      );
    }
    const value = input[only];
    if (typeof value !== "string" || value === "" || value.length > 1024) {
      throw new TypeError(`bun-security: ban(): ${only} must be a string`);
    }
    let subject: BanSubject;
    if (only === "ip") {
      const address = parseAddress(value);
      const cidr = address === null ? parseCidr(value) : null;
      if (address === null && cidr === null) {
        throw new TypeError(
          `bun-security: ban(): ${JSON.stringify(value)} is not an address or CIDR range`,
        );
      }
      subject =
        address === null
          ? { type: "cidr", value: cidr?.text ?? value }
          : {
              type: "ip",
              value: addressKey(address, this.#internals.ipv6Prefix),
            };
    } else {
      subject = {
        type: only,
        value:
          keyOf(
            keyOfType(only),
            { [only]: boundKey(value) },
            {
              method: "",
              path: "",
              routePath: undefined,
              key: "",
              profile: undefined,
            },
          ) ?? value,
      };
    }
    const action = input.action ?? "ban";
    if (action !== "ban" && action !== "challenge") {
      throw new TypeError(
        'bun-security: ban(): action must be "ban" or "challenge"',
      );
    }
    const now = this.#now();
    let length: number;
    try {
      length =
        input.duration === null
          ? Number.POSITIVE_INFINITY
          : toDurationMs(input.duration ?? "24h", "ban(): duration");
    } catch (error) {
      throw new TypeError(
        `bun-security: ban(): duration must be a duration such as "1h", or null; ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (typeof input.duration === "number" || length <= 0) {
      throw new TypeError(
        'bun-security: ban(): duration must be a duration with its unit, such as "1h", or null',
      );
    }
    const outcome = this.#bans.add(
      {
        subject,
        action,
        reason: input.reason ?? "manual ban",
        source: "manual",
        expiresAt: Number.isFinite(length) ? now + length : null,
        ...(input.by === undefined ? {} : { createdBy: input.by }),
        ...(input.code === undefined ? {} : { code: input.code }),
        ...this.#stamp(),
      },
      now,
    );
    if (outcome.ban === undefined) {
      throw new Error("bun-security: ban(): the ban was not written");
    }
    this.#banSync?.record({ op: "ban", ban: outcome.ban });
    return outcome.ban;
  }

  unban(id: string, options: UnbanOptions = {}): Ban | undefined {
    this.#assertOpen();
    const now = this.#now();
    const lifted = this.#bans.lift(id, options.by, now);
    if (lifted?.source === "auto" && lifted.subject.type === "ip") {
      this.#scores.reset(lifted.subject.value);
      this.#scoreSync?.reset(lifted.subject.value);
    }
    // Lifted everywhere, whether or not this process held it.
    if (typeof id === "string" && id.length <= 2304) {
      const scope = this.#scopeKey();
      this.#banSync?.record({
        op: "lift",
        id,
        at: now,
        ...(scope === "shared" ? {} : { scope }),
      });
    }
    return lifted;
  }

  bans(): readonly Ban[] {
    return Object.freeze(this.#bans.list(this.#now()));
  }

  socket(facts: RequestFacts): SocketLimiter {
    this.#assertOpen();
    const internals = this.#internals;
    const now = this.#now();
    const resolved = resolveClient(facts, internals);
    const lists = resolved.service?.exempt.has("lists")
      ? undefined
      : evaluateLists(
          internals,
          resolved.address,
          resolved.subject.user,
          resolved.subject.apiKey,
          listPath(facts.path, internals),
          now,
          internals.mode === "dryRun",
          undefined,
          this.#options.intel,
        );
    const connection: Connection = {
      subject: resolved.subject,
      route: requestRoute(facts),
      flags: flagsOf(lists, resolved.service),
      tokens: internals.messages?.perConnection?.capacity ?? 0,
      refilledAt: now,
      lastBreach: Number.NEGATIVE_INFINITY,
    };
    return Object.freeze({
      message: () => this.#message(connection),
    });
  }

  /** One inbound message on `connection` (layers.md L9.5). */
  #message(connection: Connection): MaybePromise<MessageDecision> {
    if (this.#closed) return ALLOW_MESSAGE;
    const internals = this.#internals;
    const messages = internals.messages;
    if (
      messages === undefined ||
      internals.mode === "off" ||
      connection.flags.allowAll
    ) {
      return ALLOW_MESSAGE;
    }
    const now = this.#now();
    const dry = internals.mode === "dryRun" || messages.mode === "dryRun";
    const hits: RuleHit[] = [];
    const breach = (
      rule: string,
      reason: string,
      code: string,
    ): MessageDecision => {
      if (dry) {
        hits.push({
          layer: "L9",
          rule,
          action: "log",
          wouldHaveBeen: "block",
          reason: `dry run: ${reason}`,
        });
        return { action: "allow", hits: Object.freeze(hits) };
      }
      const again = now - connection.lastBreach < messages.breach;
      connection.lastBreach = now;
      hits.push({
        layer: "L9",
        rule,
        action: "block",
        reason: again
          ? `${reason}; a second breach within ${windowText(messages.breach)}: closed`
          : reason,
      });
      return again
        ? {
            action: "close",
            code: messages.closeCode,
            reason: code,
            hits: Object.freeze(hits),
          }
        : { action: "drop", hits: Object.freeze(hits) };
    };
    // The connection's own bucket.
    const bucket = messages.perConnection;
    if (bucket !== undefined) {
      connection.tokens = Math.min(
        bucket.capacity,
        connection.tokens +
          ((now - connection.refilledAt) * bucket.limit) / bucket.window,
      );
      connection.refilledAt = now;
      if (connection.tokens < 1) {
        return breach(
          "message:per-connection",
          `message rate: ${bucket.limit} per ${windowText(bucket.window)} on the connection`,
          "rate_limited",
        );
      }
      connection.tokens -= 1;
    }
    // Limits per subject across connections.
    const counting: MaybePromise<[CompiledLimit, LimitCount]>[] = [];
    const { flags, subject, route } = connection;
    for (const limit of messages.limits) {
      const built = this.#messageLimits.get(limit.id);
      if (built === undefined) continue;
      if (flags.internal && limit.key.addressOnly) continue;
      if (
        flags.service?.exempt.has("globalLimits") &&
        !limit.appliesToServices
      ) {
        continue;
      }
      if (!appliesTo(limit.routes, route) || !inProfile(limit.profile, route)) {
        continue;
      }
      const key = keyOf(limit.key, subject, route);
      if (key === undefined) continue;
      counting.push(
        then(
          this.#messageLimiter.count(built, limit, key, false),
          (value): [CompiledLimit, LimitCount] => [limit, value],
        ),
      );
    }
    if (counting.length === 0) {
      return hits.length === 0
        ? ALLOW_MESSAGE
        : { action: "allow", hits: Object.freeze(hits) };
    }
    return then(all(counting), (results): MessageDecision => {
      for (const [limit, counted] of results) {
        const rule = `message:${limit.id}`;
        const limitDry = limit.mode === "dryRun";
        if (counted.kind === "failed" && counted.mode === "closed") {
          if (dry || limitDry) {
            hits.push({
              layer: "L9",
              rule,
              action: "log",
              wouldHaveBeen: "block",
              reason: "dry run: the shared store failed: onStoreError closed",
            });
            continue;
          }
          hits.push({
            layer: "L9",
            rule,
            action: "block",
            reason: "the shared store failed: onStoreError closed",
          });
          return {
            action: "close",
            code: 1013,
            reason: "unavailable",
            hits: Object.freeze(hits),
          };
        }
        if (counted.kind !== "counted" || !counted.result.limited) continue;
        const reason = `message limit: ${counted.result.limit} per ${windowText(limit.window)}${counted.via === "local share" ? " (local share)" : ""}`;
        if (limitDry) {
          hits.push({
            layer: "L9",
            rule,
            action: "log",
            wouldHaveBeen: "block",
            reason: `dry run: ${reason}`,
          });
          continue;
        }
        return breach(rule, reason, limit.code);
      }
      return hits.length === 0
        ? ALLOW_MESSAGE
        : { action: "allow", hits: Object.freeze(hits) };
    });
  }

  status(): SecurityStatus {
    const now = this.#now();
    const active = this.#bans.list(now);
    return Object.freeze({
      policy: this.#policy,
      trust: this.#trust.status(
        now,
        this.#internals.trustCheck,
        this.#policy.public,
        this.#policy.service,
      ),
      state: Object.freeze({
        inFlight: this.#inFlight.total,
        inFlightClients: this.#inFlight.clients,
        trips: active.filter((ban) => ban.rule?.startsWith("counted:")).length,
        bans: active.length,
        bansDropped: this.#bans.dropped,
        scores: this.#scores.size,
        evictions: this.#evictions.total,
        warning: this.#evictions.warning(now),
        ...(this.#store === undefined ? {} : { store: this.#storeStatus() }),
      }),
    });
  }

  /** The shared store's state. */
  #storeStatus(): SharedStoreStatus | undefined {
    const store = this.#store;
    const banSync = this.#banSync;
    if (store === undefined || banSync === undefined) return undefined;
    const health = store.health();
    const bans = banSync.status();
    return Object.freeze({
      name: store.name,
      healthy: health.healthy,
      failingSince: health.failingSince,
      pendingBans: bans.pending,
      droppedBans: bans.dropped,
      banCursor: bans.cursor,
      reconciledAt: bans.reconciledAt,
      pendingScores: this.#scoreSync?.pending ?? 0,
    });
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  flush(): Promise<void> {
    if (this.#final !== undefined) return this.#final;
    return this.#flush();
  }

  /** Writes and reads what waits on the shared store; never rejects. */
  async #flush(): Promise<void> {
    const banSync = this.#banSync;
    if (banSync === undefined) return;
    try {
      await banSync.write();
      await this.#scoreSync?.sync(this.#internals.ladder);
      await this.#store?.flush?.();
      if (!this.#closed) await banSync.read();
    } catch (error) {
      this.#logger.warn("bun-security: flushing to the shared store failed", {
        error,
      });
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const timer of this.#timers.splice(0)) clearInterval(timer);
    const unlisten = this.#unlisten;
    this.#unlisten = undefined;
    if (this.#store !== undefined) {
      this.#final = this.#flush().then(async () => {
        await unlisten?.().catch(() => undefined);
      });
    }
    this.#inFlight.clear();
    this.#bans.clear();
    this.#scores.clear();
  }

  /**
   * Counts one occurrence of each of `events` for the counted rules and the
   * ladder, in order, and answers the hits (trips, bans) they caused.
   */
  #occurAll(
    events: readonly string[],
    facts: RequestFacts,
    subject: SubjectKeys,
    flags: Flags,
    now: number,
    stage: EvaluationStage | undefined,
  ): MaybePromise<readonly RuleHit[]> {
    const pass: Pass = {
      subject,
      route: requestRoute(facts),
      address: null,
      flags,
      now,
      writes: true,
      dryPolicy: this.#internals.mode === "dryRun",
      trace: undefined,
      run: new Run(this.#challengeOutcome(facts)),
      stage,
      crawler: this.#claims.get(facts),
    };
    // One event after another, so the hits keep the events' order.
    const from = (index: number): MaybePromise<void> => {
      const event = events[index];
      if (event === undefined) return undefined;
      return then(this.#occur(event, pass, false), () => from(index + 1));
    };
    return then(from(0), () => Object.freeze(pass.run.hits));
  }

  /**
   * One occurrence of `event`: counted under each counted rule that counts
   * it (a trip bans its key), then its offence weight added to the client
   * address's score (the ladder may challenge or ban it). With `deferred`
   * (a honeypot, which must answer as a real route would) the bans apply
   * from the next request, and their hits are recorded as `log`.
   */
  #occur(event: string, pass: Pass, deferred: boolean): MaybePromise<void> {
    const rules = this.#internals.countedByEvent.get(event);
    // An event both stages see weighs once, in the early stage.
    const weight =
      pass.stage === "route" && SHARED_EVENTS.has(event)
        ? 0
        : (this.#internals.ladder?.weights.get(event) ?? 0);
    if (rules === undefined) {
      if (weight > 0) this.#offend(event, weight, pass, deferred);
      return undefined;
    }
    const prefix = this.#prefix;
    const counting: MaybePromise<
      readonly [CompiledCountedRule, string, CountOutcome]
    >[] = [];
    for (const rule of rules) {
      const key = this.#countedKey(rule, event, pass);
      if (key === undefined) continue;
      counting.push(
        then(
          this.#counted.count(
            prefix,
            rule,
            key,
            pass.writes,
            pass.now,
            this.#internals.nodes,
          ),
          (outcome): readonly [CompiledCountedRule, string, CountOutcome] => [
            rule,
            key,
            outcome,
          ],
        ),
      );
    }
    return then(all(counting), (results) => {
      for (const [rule, key, outcome] of results) {
        this.#tripped(rule, key, event, outcome, pass, deferred);
      }
      if (weight > 0) this.#offend(event, weight, pass, deferred);
    });
  }

  /** Adds `hit` to the pass, as `log` when deferred (it applies from the next request). */
  #record(
    pass: Pass,
    hit: RuleHit,
    answer: Answer | undefined,
    deferred: boolean,
  ): void {
    if (deferred && refuses(hit.action)) {
      pass.run.add({
        ...hit,
        action: "log",
        reason: `${hit.reason ?? ""}; applies from the next request`,
      });
      return;
    }
    pass.run.add(hit, refuses(hit.action) ? answer : undefined);
  }

  /** How a ban answers: `403` with its code, and `Retry-After` when the policy says so. */
  #banAnswer(
    code: string | undefined,
    until: number | null,
    now: number,
  ): Answer {
    const bans = this.#internals.bans;
    return {
      status: 403,
      code: code ?? bans.code,
      ...(bans.retryAfter && until !== null
        ? { retryAfter: seconds(until - now) }
        : {}),
    };
  }

  /** Writes a ban, warning when the table is full and widens it. */
  #writeBan(write: BanWrite, now: number): void {
    const outcome = this.#bans.add({ ...write, ...this.#stamp() }, now);
    if (outcome.ban !== undefined) {
      this.#banSync?.record({ op: "ban", ban: outcome.ban });
    }
    if (
      (outcome.aggregated || outcome.ban === undefined) &&
      now - this.#lastAggregated >= 60_000
    ) {
      this.#lastAggregated = now;
      this.#warn(
        Object.freeze({
          kind: "bans.aggregated",
          message: `bun-security: the ban table is full (maxActive ${this.#internals.bans.maxActive}); new address bans are widened to their /24 or /48${outcome.ban === undefined ? ", and some were dropped" : ""}`,
          service: this.#policy.service,
          minutes: 1,
          share: 1,
          since: now,
        }),
      );
    }
  }

  /**
   * One counted occurrence's outcome: nothing below the threshold; at it,
   * a ban of the rule's key (written when enforced and writing) and the
   * rule's offence weight, or `log` with the would-be action in dry run.
   */
  #tripped(
    rule: CompiledCountedRule,
    key: string,
    event: string,
    outcome: CountOutcome,
    pass: Pass,
    deferred: boolean,
  ): void {
    const { now, writes, trace } = pass;
    if (!outcome.tripped) {
      trace?.push({
        layer: "L4",
        check: "counted-rule",
        rule: `counted:${rule.id}`,
        outcome:
          outcome.count === undefined
            ? `"${event}" not counted: the store failed`
            : `"${event}" counted: ${outcome.count} of ${outcome.threshold ?? rule.threshold} in ${windowText(rule.window)}${outcome.threshold !== undefined && outcome.threshold !== rule.threshold ? " (the local share: the shared store failed)" : ""}`,
      });
      return;
    }
    const dry =
      pass.dryPolicy ||
      rule.mode === "dryRun" ||
      this.#internals.bans.mode === "dryRun";
    const action = tripAction(rule);
    const subject: BanSubject = { type: rule.key.parts.join("|"), value: key };
    const ladder = this.#internals.ladder;
    const length =
      rule.action === "ladder" && ladder
        ? this.#escalate(banId(subject), now, ladder, writes && !dry)
        : rule.duration;
    const until = Number.isFinite(length) ? now + length : null;
    const reason = `counted rule: ${rule.threshold} "${event}" in ${windowText(rule.window)}`;
    const hit: RuleHit = dry
      ? {
          layer: "L4",
          rule: `counted:${rule.id}`,
          action: "log",
          wouldHaveBeen: action,
          reason: `dry run: ${reason}`,
        }
      : { layer: "L4", rule: `counted:${rule.id}`, action, reason };
    if (!dry && writes) {
      this.#writeBan(
        {
          subject,
          action: rule.action === "challenge" ? "challenge" : "ban",
          reason,
          rule: `counted:${rule.id}`,
          source: "auto",
          expiresAt: until,
          ...(rule.code === undefined ? {} : { code: rule.code }),
        },
        now,
      );
      this.#logger.info(
        `bun-security: counted rule "${rule.id}" tripped on "${event}"`,
        { rule: rule.id, event, durationMs: until === null ? null : length },
      );
    }
    trace?.push({
      layer: "L4",
      check: "counted-rule",
      rule: hit.rule,
      outcome: `"${event}" reached ${rule.threshold} in ${windowText(rule.window)}: ${dry ? `would have tripped (dry run) to ${action}` : `tripped: ${action}${until === null ? " until lifted" : ` for ${windowText(length)}`}`}`,
    });
    this.#record(pass, hit, this.#banAnswer(rule.code, until, now), deferred);
    if (!dry && rule.weight > 0) {
      this.#offend(`counted:${rule.id}`, rule.weight, pass, deferred);
    }
  }

  /**
   * Adds an offence's weight to the client address's score and applies the
   * ladder's highest step reached: a challenge, or a ban of escalating
   * length, after which the score starts again from zero. Only an address
   * the bans may refuse is scored (not an allow-listed or internal one, nor
   * a service exempt from bans). With writes off (`explain()`) the score is
   * kept on the pass, so one request's offences add up there too.
   */
  #offend(source: string, weight: number, pass: Pass, deferred: boolean): void {
    const ladder = this.#internals.ladder;
    const ip = pass.subject.ip;
    const { flags, now, writes, trace } = pass;
    if (ladder === undefined || weight <= 0 || ip === undefined) return;
    if (
      flags.allowAll ||
      flags.internal ||
      flags.service?.exempt.has("bans") === true ||
      // The ladder never bans a verified crawler on its allowance (L3.2).
      exempts(pass.crawler, "autoBans")
    ) {
      return;
    }
    let score: number;
    if (writes) {
      score = this.#scores.add(ip, weight, now, ladder);
      this.#scoreSync?.added(ip, weight);
    } else {
      pass.score = (pass.score ?? this.#scores.get(ip, now, ladder)) + weight;
      score = pass.score;
    }
    const step = ladder.steps.find((candidate) => score >= candidate.score);
    trace?.push({
      layer: "L4",
      check: "score",
      rule: "ladder",
      outcome: `${source} added ${weight}: the score is ${score.toFixed(2)}${step ? `, reaching ${step.score} (${step.action})` : ""}`,
    });
    if (step === undefined) return;
    const dry =
      pass.dryPolicy ||
      ladder.mode === "dryRun" ||
      this.#internals.bans.mode === "dryRun";
    const subject: BanSubject = { type: "ip", value: ip };
    const length =
      step.duration ??
      this.#escalate(banId(subject), now, ladder, writes && !dry);
    const action: SecurityAction = step.action === "ban" ? "ban" : "challenge";
    const reason = `ladder: score ${score.toFixed(2)} reached ${step.score} (${source})`;
    if (!dry && writes) {
      this.#writeBan(
        {
          subject,
          action: step.action,
          reason,
          rule: "ladder",
          source: "auto",
          expiresAt: now + length,
        },
        now,
      );
    }
    if (step.action === "ban") {
      if (writes && !dry) {
        this.#scores.reset(ip);
        this.#scoreSync?.reset(ip);
      } else {
        pass.score = 0;
      }
    }
    this.#record(
      pass,
      dry
        ? {
            layer: "L4",
            rule: "ladder",
            action: "log",
            wouldHaveBeen: action,
            reason: `dry run: ${reason}`,
          }
        : { layer: "L4", rule: "ladder", action, reason },
      this.#banAnswer(undefined, now + length, now),
      deferred,
    );
  }

  /** {@link Scores.escalate}, with a recorded ban's history synced. */
  #escalate(
    id: string,
    now: number,
    ladder: NonNullable<PolicyInternals["ladder"]>,
    record: boolean,
  ): number {
    const length = this.#scores.escalate(id, now, ladder, record);
    if (record) this.#scoreSync?.banned(id);
    return length;
  }

  /** The key a counted rule counts the request under, or `undefined` when it does not apply. */
  #countedKey(
    rule: CompiledCountedRule,
    event: string,
    pass: Pass,
  ): string | undefined {
    const { flags, trace } = pass;
    if (!inStage(rule, pass.stage)) return undefined;
    if (flags.service?.exempt.has("countedRules") && !rule.appliesToServices) {
      trace?.push({
        layer: "L4",
        check: "counted-rule",
        rule: `counted:${rule.id}`,
        outcome: `"${event}" not counted: service "${flags.service.id}" is exempt from counted rules`,
      });
      return undefined;
    }
    if (shieldedBy(flags, rule.key)) {
      trace?.push({
        layer: "L4",
        check: "counted-rule",
        rule: `counted:${rule.id}`,
        outcome: `"${event}" not counted: ${flags.allowAll ? "an allow entry let the request through" : "the client is internal and the key names only its address"}`,
      });
      return undefined;
    }
    if (
      !appliesTo(rule.routes, pass.route) ||
      !inProfile(rule.profile, pass.route)
    ) {
      return undefined;
    }
    const key = keyOf(rule.key, pass.subject, pass.route);
    if (key === undefined) {
      trace?.push({
        layer: "L4",
        check: "counted-rule",
        rule: `counted:${rule.id}`,
        outcome: `"${event}" not counted: the request has no ${rule.key.parts.join("|")} key`,
      });
    }
    return key;
  }

  /**
   * Layer L4: the bans in force for the request's subjects, the exact ones
   * by each banned key type and the ranges through the trie. A ban on an
   * address alone never refuses an internal client; a service exempt from
   * bans is refused only by the bans of counted rules that apply to
   * services. Answers whether an enforced ban refused the request.
   */
  #banned(pass: Pass): boolean {
    const { flags, subject, now, writes, trace, run } = pass;
    if (this.#bans.size === 0 || flags.allowAll) return false;
    const internals = this.#internals;
    const exempt = flags.service?.exempt.has("bans") === true;
    const found: Ban[] = [];
    for (const type of this.#bans.types()) {
      const key = keyOfType(type);
      // A ban is enforced in the stage its key can be read in.
      if (pass.stage !== undefined && keyStage(key) !== pass.stage) continue;
      if (flags.internal && key.addressOnly) continue;
      const value = keyOf(key, subject, pass.route);
      if (value === undefined) continue;
      const ban = this.#bans.find(`${type}:${value}`, now, writes);
      if (ban) found.push(ban);
    }
    if (pass.address && !flags.internal && pass.stage !== "route") {
      found.push(...this.#bans.ranges(pass.address, now));
    }
    // A verified crawler on its allowance: automatic bans are skipped
    // (`autoBans`); manual ones still apply (layers.md L3.2).
    if (exempts(pass.crawler, "autoBans")) {
      const manual = found.filter((ban) => ban.source === "manual");
      if (manual.length !== found.length) {
        trace?.push({
          layer: "L4",
          check: "ban",
          outcome: `${found.length - manual.length} automatic ban(s) skipped: a verified ${pass.crawler?.id ?? ""} crawler`,
        });
      }
      found.length = 0;
      found.push(...manual);
    }
    const applying = exempt
      ? found.filter((ban) => {
          const id = ban.rule?.startsWith("counted:")
            ? ban.rule.slice("counted:".length)
            : undefined;
          return (
            id !== undefined &&
            internals.countedRules.some(
              (rule) => rule.id === id && rule.appliesToServices,
            )
          );
        })
      : found;
    if (applying.length === 0) return false;
    // `ban` before `challenge`, then the first found.
    const ban =
      applying.find((candidate) => candidate.action === "ban") ?? applying[0];
    if (ban === undefined) return false;
    const dry = pass.dryPolicy || internals.bans.mode === "dryRun";
    const action: SecurityAction = ban.action === "ban" ? "ban" : "challenge";
    const reason = `banned: ${ban.reason}${ban.expiresAt === null ? " (until lifted)" : `, ${seconds(ban.expiresAt - now)} s left`}`;
    run.add(
      dry
        ? {
            layer: "L4",
            rule: `ban:${ban.id}`,
            action: "log",
            wouldHaveBeen: action,
            reason: `dry run: ${reason}`,
          }
        : { layer: "L4", rule: `ban:${ban.id}`, action, reason },
      dry ? undefined : this.#banAnswer(ban.code, ban.expiresAt, now),
    );
    trace?.push({
      layer: "L4",
      check: "ban",
      rule: `ban:${ban.id}`,
      outcome: `${reason}: ${dry ? "would have refused (dry run)" : `refused: ${action}`}`,
    });
    return run.refused;
  }

  /**
   * Layer L6: the request's shape. Answers whether an enforced check refused
   * it, after counting the `shape.refused` event.
   */
  #shaped(facts: RequestFacts, pass: Pass): MaybePromise<boolean> {
    const shape = this.#internals.shape;
    // The request's shape is known before it is read: the early stage's.
    if (shape === undefined || pass.flags.allowAll || pass.stage === "route") {
      return false;
    }
    const refusal = checkShape(shape, facts, pass.route);
    if (refusal === undefined) return false;
    const dry = pass.dryPolicy || shape.mode === "dryRun";
    pass.run.add(
      dry
        ? {
            layer: "L6",
            rule: refusal.rule,
            action: "log",
            wouldHaveBeen: "block",
            reason: `dry run: ${refusal.reason}`,
          }
        : {
            layer: "L6",
            rule: refusal.rule,
            action: "block",
            reason: refusal.reason,
          },
      dry ? undefined : { status: refusal.status, code: "rejected" },
    );
    pass.trace?.push({
      layer: "L6",
      check: "shape",
      rule: refusal.rule,
      outcome: `${refusal.reason}: ${dry ? "would have refused (dry run)" : `refused, ${refusal.status}`}`,
    });
    if (dry) return false;
    return then(this.#occur("shape.refused", pass, false), () => true);
  }

  /**
   * Whether the request comes from a verified crawler on the paths its
   * allowance covers (layers.md L3.2): such a client is exempt from the
   * rules that skip crawlers (the managed probe set, and a policy's rules
   * marked `crawlers: "skip"`), whose hits are logged as `crawler.probe`
   * instead. PR-S12 answers it; until then no crawler is verified.
   */
  #verifiedCrawler(facts: RequestFacts, _pass?: Pass): boolean {
    return this.#crawlerExempt(facts, "probeRules");
  }

  /**
   * What a `challenge` does for this request (layers.md L10.2), asked only
   * when one is hit: `undefined` without a challenge flow (a `block`), a
   * pass for a verified crawler or a client with a valid clearance, else a
   * challenge.
   */
  #challengeOutcome(facts: RequestFacts): (() => ChallengeOutcome) | undefined {
    const flow = this.#options.challenge;
    // A verified crawler is never challenged, with or without a flow (L3.2).
    const crawler = this.#crawlerExempt(facts, "challenges");
    if (flow === undefined && !crawler) return undefined;
    return () => {
      if (crawler || flow === undefined) return "crawler";
      try {
        return flow.cleared(facts) ? "cleared" : "challenge";
      } catch (error) {
        this.#logger.error(
          "bun-security: the challenge flow's cleared() threw",
          { error },
        );
        return "challenge";
      }
    };
  }

  /**
   * Layer L7: the request rules that hold for the request in this stage
   * (layers.md L7), in policy order, then the managed probe set's. Each
   * enforced hit applies its action (a refusal, a ban of the client
   * address, a drop, or a log), counts its event (`pattern.hit`, or
   * `probe.hit` for the managed set) for the counted rules and the ladder's
   * weights, and adds the rule's own weight to the address's score. A hit
   * in dry run is recorded as what it would have done, and counts nothing.
   * Answers whether the request was refused.
   */
  #ruled(
    facts: RequestFacts,
    pass: Pass,
    policy: CompiledPolicy,
  ): MaybePromise<boolean> {
    const compiled = requestRulesOf(policy);
    if (compiled.rules.length === 0 || pass.flags.allowAll) return false;
    const matched = matchRequestRules(
      compiled,
      facts,
      pass.stage,
      this.#intelFor(pass),
    );
    if (matched.length === 0) return false;
    const { run, trace, now, writes, flags } = pass;
    const crawler = this.#verifiedCrawler(facts, pass);
    const counted: CompiledRequestRule[] = [];
    for (const rule of matched) {
      const what = `${rule.managed ? "managed probe" : "request rule"} "${rule.id}"`;
      if (crawler && rule.crawlers === "skip") {
        run.add({
          layer: "L7",
          rule: rule.hitRule,
          action: "log",
          reason: `crawler.probe: ${what} matched a verified crawler, which it does not hold`,
        });
        trace?.push({
          layer: "L7",
          check: "rule",
          rule: rule.hitRule,
          outcome: `${what} matched a verified crawler: logged as crawler.probe`,
        });
        continue;
      }
      const dry = pass.dryPolicy || rule.mode === "dryRun";
      const action: SecurityAction = rule.action;
      const reason = `${what} matched`;
      if (dry) {
        run.add({
          layer: "L7",
          rule: rule.hitRule,
          action: "log",
          ...(action === "log" ? {} : { wouldHaveBeen: action }),
          reason: `dry run: ${reason}`,
        });
        trace?.push({
          layer: "L7",
          check: "rule",
          rule: rule.hitRule,
          outcome: `${reason}: ${action === "log" ? "logged" : `would have refused (dry run): ${action}`}`,
        });
        continue;
      }
      let answer:
        { status: number; code: string; retryAfter?: number } | undefined;
      if (action === "ban") {
        const ip = pass.subject.ip;
        const ladder = this.#internals.ladder;
        const subject: BanSubject | undefined =
          ip === undefined || flags.internal
            ? undefined
            : { type: "ip", value: ip };
        const bansDry = this.#internals.bans.mode === "dryRun";
        const length =
          rule.duration !== undefined
            ? rule.duration
            : ladder && subject
              ? this.#scores.escalate(
                  banId(subject),
                  now,
                  ladder,
                  writes && !bansDry,
                )
              : 3_600_000;
        const until = length === null ? null : now + length;
        if (subject && writes && !bansDry) {
          this.#writeBan(
            {
              subject,
              action: "ban",
              reason,
              rule: rule.hitRule,
              source: "auto",
              expiresAt: until,
              code: rule.code,
            },
            now,
          );
        }
        answer = this.#banAnswer(rule.code, until, now);
      } else if (refuses(action)) {
        answer = { status: rule.status, code: rule.code };
      }
      run.add({ layer: "L7", rule: rule.hitRule, action, reason }, answer);
      trace?.push({
        layer: "L7",
        check: "rule",
        rule: rule.hitRule,
        outcome: `${reason}: ${action === "log" ? "logged" : `refused: ${action}`}`,
      });
      counted.push(rule);
    }
    // Each enforced hit's event, then its weight, one after another.
    const from = (index: number): MaybePromise<void> => {
      const rule = counted[index];
      if (rule === undefined) return undefined;
      return then(this.#occur(rule.event, pass, false), () => {
        if (rule.weight > 0)
          this.#offend(rule.hitRule, rule.weight, pass, false);
        return from(index + 1);
      });
    };
    return then(from(0), () => run.refused);
  }

  /**
   * Layer L8: canary credentials (any use refuses the request and scores the
   * address 100 through `canary.used`) and honeypot routes (`honeypot.hit`,
   * scored 10, applied from the next request, the request itself answered
   * as a real route would). Answers whether the request was refused.
   */
  #deceived(facts: RequestFacts, pass: Pass): MaybePromise<boolean> {
    const deception = this.#internals.deception;
    if (pass.flags.allowAll) return false;
    // Canaries need the caller (the route stage); honeypots only the path
    // (the early stage, before the body is read).
    const identity = pass.stage === "early" ? undefined : facts.identity;
    const canary =
      (identity?.user === undefined
        ? undefined
        : deception.canaryUsers.get(identity.user)) ??
      (identity?.apiKey === undefined
        ? undefined
        : deception.canaryKeys.get(identity.apiKey));
    if (canary !== undefined) {
      const reason = `canary credential "${canary}" used`;
      pass.run.add(
        pass.dryPolicy
          ? {
              layer: "L8",
              rule: `canary:${canary}`,
              action: "log",
              wouldHaveBeen: "ban",
              reason: `dry run: ${reason}`,
            }
          : { layer: "L8", rule: `canary:${canary}`, action: "ban", reason },
        pass.dryPolicy ? undefined : this.#banAnswer(undefined, null, pass.now),
      );
      pass.trace?.push({
        layer: "L8",
        check: "canary",
        rule: `canary:${canary}`,
        outcome: `${reason}: refused`,
      });
      if (pass.writes) {
        this.#logger.error(`bun-security: ${reason}`, {
          canary,
          service: this.#policy.service,
        });
        this.#warn(
          Object.freeze({
            kind: "canary.used",
            message: `bun-security: canary credential "${canary}" was used: where it was planted has leaked`,
            service: this.#policy.service,
            minutes: 1,
            share: 1,
            since: pass.now,
          }),
        );
      }
      return pass.dryPolicy
        ? false
        : then(this.#occur("canary.used", pass, false), () => true);
    }
    const honeypots = deception.honeypots;
    if (
      honeypots === undefined ||
      pass.stage === "route" ||
      !appliesTo(honeypots.patterns, pass.route)
    ) {
      return false;
    }
    const dry = pass.dryPolicy || honeypots.mode === "dryRun";
    const notFound = honeypots.answer === "not-found";
    if (exempts(pass.crawler, "honeypots")) {
      // Answered as usual, no score and no ban (layers.md L3.2): a verified
      // crawler on a honeypot followed an outside link, or an old robots.txt.
      const reason = `crawler.honeypot: a verified ${pass.crawler?.id ?? ""} crawler on a honeypot route; no score`;
      pass.run.add(
        {
          layer: "L8",
          rule: "honeypot",
          action: notFound && !dry ? "block" : "log",
          reason,
        },
        notFound && !dry ? { status: 404, code: "not_found" } : undefined,
      );
      pass.trace?.push({
        layer: "L8",
        check: "honeypot",
        rule: "honeypot",
        outcome: reason,
      });
      return notFound && !dry;
    }
    const reason = "honeypot route";
    pass.run.add(
      dry
        ? {
            layer: "L8",
            rule: "honeypot",
            action: "log",
            ...(notFound ? { wouldHaveBeen: "block" as const } : {}),
            reason: `dry run: ${reason}`,
          }
        : {
            layer: "L8",
            rule: "honeypot",
            action: notFound ? "block" : "log",
            reason,
          },
      !dry && notFound ? { status: 404, code: "not_found" } : undefined,
    );
    pass.trace?.push({
      layer: "L8",
      check: "honeypot",
      rule: "honeypot",
      outcome: `${reason}: ${dry ? "dry run" : notFound ? "answered 404" : "passed on, as a real route"}`,
    });
    if (dry) return false;
    return then(this.#occur("honeypot.hit", pass, true), () => notFound);
  }

  /**
   * The one decision function: `writes` updates state (evaluate), `trace`
   * collects steps (explain), `track` applies layer L1, `stage` limits it to
   * one stage of a two-stage integration (both when undefined). Every stage
   * reads the same policy snapshot.
   */
  #decide(
    facts: RequestFacts,
    now: number,
    writes: boolean,
    trace: ExplainStep[] | undefined,
    track: boolean,
    stage: EvaluationStage | undefined,
  ): MaybePromise<{ decision: Decision; resolved: ResolvedClient }> {
    return then(this.#claim(facts, stage, trace), () =>
      this.#decideNow(facts, now, writes, trace, track, stage),
    );
  }

  /**
   * Layer L3.2: the allowed crawler a request's `User-Agent` claims,
   * verified by its ranges or forward-confirmed reverse DNS, kept by its
   * facts for every layer to read. Synchronous unless a DNS lookup has to
   * be awaited (at most `verifyTimeoutMs`).
   */
  #claim(
    facts: RequestFacts,
    stage: EvaluationStage | undefined,
    trace: ExplainStep[] | undefined,
  ): MaybePromise<void> {
    if (this.#internals.mode === "off") return undefined;
    const compiled = crawlersOf(this.#policy);
    if (compiled.mode === "off") return undefined;
    const crawler = claimOf(compiled, facts.headers["user-agent"]);
    if (crawler === undefined) return undefined;
    const known = this.#claims.get(facts);
    if (known?.id === crawler.id) return undefined;
    const address = parseAddress(facts.client);
    if (address === null) return undefined;
    const mode = compiled.mode;
    return then(
      this.#verifier.verify(
        crawler,
        address,
        compiled.verify,
        this.#options.intel,
      ),
      (verdict) => {
        const request: CrawlerRequest = {
          id: crawler.id,
          verdict,
          covered: covered(compiled, facts.method, facts.path),
          mode,
          exempt: compiled.exempt,
        };
        this.#claims.set(facts, request);
        trace?.push({
          layer: "L3",
          check: "crawler",
          rule: `crawler:${crawler.id}`,
          outcome: `claims ${crawler.id}: ${verdict.status}${verdict.by ? ` by ${verdict.by}` : ""} (${verdict.reason})${request.covered ? "" : "; outside the allowance's methods or paths"}${stage === "route" ? "" : ""}`,
        });
        return undefined;
      },
    );
  }

  /** Whether the allowance lifts `exemption` for this request's verified crawler. */
  #crawlerExempt(facts: RequestFacts, exemption: CrawlerExemption): boolean {
    return exempts(this.#claims.get(facts), exemption);
  }

  /** {@link #decide}, once the crawler claim is known. */
  #decideNow(
    facts: RequestFacts,
    now: number,
    writes: boolean,
    trace: ExplainStep[] | undefined,
    track: boolean,
    stage: EvaluationStage | undefined,
  ): MaybePromise<{ decision: Decision; resolved: ResolvedClient }> {
    const policy = this.#policy;
    const internals = this.#internals;
    const limitSet = this.#limits;

    // ── L2: who the client is ─────────────────────────────────────────────
    const resolved = this.#withAccount(
      resolveClient(facts, internals, trace),
      facts,
      undefined,
    );
    if (internals.mode === "off") {
      trace?.push({
        layer: "L2",
        check: "policy",
        outcome: "the policy is off: allowed",
      });
      return { decision: this.#allow(resolved.subject), resolved };
    }
    const dryPolicy = internals.mode === "dryRun";
    const run = new Run(this.#challengeOutcome(facts));
    const crawler = this.#claims.get(facts);
    run.crawler = crawler;
    // The route stage repeats L2 and the lists for their flags and the
    // caller's own entries; the early stage recorded the address's hits.
    const routeStage = stage === "route";
    if (resolved.hit && !routeStage) run.add(resolved.hit);
    // A verified crawler on its allowance counts under its own limit.
    const subject: SubjectKeys = exempts(crawler, "perIpLimits")
      ? { ...resolved.subject, crawler: crawler?.id }
      : resolved.subject;
    const concurrency =
      track && !routeStage ? internals.concurrency : undefined;
    let flags: Flags = {
      allowAll: false,
      internal: false,
      service: resolved.service,
    };
    const finish = (): { decision: Decision; resolved: ResolvedClient } =>
      this.#finish(run, subject, resolved, writes, track, flags, now, stage);

    // ── L1: the in-flight cap (load shedding) ─────────────────────────────
    if (concurrency?.total !== undefined) {
      this.#inFlight.expire(now, concurrency.releaseAfter);
      const inFlight = this.#inFlight.total;
      if (inFlight >= concurrency.total) {
        const dry = dryPolicy || concurrency.mode === "dryRun";
        const reason = `in-flight cap: ${inFlight} of ${concurrency.total} requests in flight`;
        run.add(
          dry
            ? {
                layer: "L1",
                rule: "concurrency:total",
                action: "log",
                wouldHaveBeen: "block",
                reason: `dry run: ${reason}`,
              }
            : {
                layer: "L1",
                rule: "concurrency:total",
                action: "block",
                reason,
              },
          dry ? undefined : { status: 503, code: "unavailable", retryAfter: 1 },
        );
        trace?.push({
          layer: "L1",
          check: "concurrency",
          rule: "concurrency:total",
          outcome: `${reason}: ${dry ? "would have refused (dry run)" : "refused, 503"}`,
        });
        if (run.refused) return finish();
      }
    }

    // ── L3: lists, unless a verified service is exempt from them ─────────
    let lists: ListOutcome | undefined;
    // A `challenge` entry lets L4 decide first: a banned client is refused
    // by its ban at once, not challenged (the user's ruling, 2026-11-16).
    // Its hit is recorded after the bans; `allow` and `block` keep L3's
    // precedence.
    let challengeEntry: CompiledEntry | undefined;
    if (resolved.service?.exempt.has("lists")) {
      trace?.push({
        layer: "L3",
        check: "list",
        outcome: `skipped: service "${resolved.service.id}" is exempt from lists`,
      });
    } else {
      lists = evaluateLists(
        internals,
        resolved.address,
        subject.user,
        subject.apiKey,
        listPath(facts.path, internals),
        now,
        dryPolicy,
        trace,
        this.#options.intel,
        exempts(crawler, "geo"),
      );
      if (lists.decided && ownEntry(lists.decided, stage)) {
        if (lists.decided.action === "challenge") {
          challengeEntry = lists.decided;
        } else {
          run.add(entryHit(lists.decided), {
            status: 403,
            code: lists.decided.code,
          });
        }
      }
      if (lists.wouldBe && ownEntry(lists.wouldBe, stage)) {
        run.add({
          layer: "L3",
          rule: lists.wouldBe.id,
          action: "log",
          wouldHaveBeen: appliedAction(lists.wouldBe),
          reason: "dry run",
        });
      }
    }
    flags = flagsOf(lists, resolved.service);

    // ── L2.5: the trust check's gauges (state: evaluate only) ────────────
    if (writes && !routeStage && internals.trustCheck && !resolved.service) {
      let forwarded = false;
      for (const name of FORWARDING_HEADERS) {
        if (facts.headers[name] !== undefined) {
          forwarded = true;
          break;
        }
      }
      this.#trust.record(
        {
          client: resolved.address?.text ?? "",
          peer: normalizeAddress(facts.peer) ?? facts.peer,
          internal: flags.internal,
          unreadForwarding: forwarded && facts.chain.length <= 1,
        },
        now,
        internals.trustCheck,
        policy.public,
        policy.service,
      );
    }
    if (run.refused) return finish();

    // ── L1: in-flight requests per client address ─────────────────────────
    if (concurrency?.perIp !== undefined && subject.ip !== undefined) {
      if (
        flags.allowAll ||
        flags.internal ||
        flags.service?.exempt.has("globalLimits")
      ) {
        trace?.push({
          layer: "L1",
          check: "concurrency",
          rule: "concurrency:per-ip",
          outcome: `not limited: ${flags.allowAll ? "an allow entry let the request through" : flags.internal ? "the client is internal" : `service "${flags.service?.id ?? ""}" is exempt from global limits`}`,
        });
      } else {
        this.#inFlight.expire(now, concurrency.releaseAfter);
        const held = this.#inFlight.of(subject.ip);
        if (held >= concurrency.perIp) {
          const dry = dryPolicy || concurrency.mode === "dryRun";
          const reason = `in-flight per address: ${held} of ${concurrency.perIp}`;
          run.add(
            dry
              ? {
                  layer: "L1",
                  rule: "concurrency:per-ip",
                  action: "log",
                  wouldHaveBeen: "block",
                  reason: `dry run: ${reason}`,
                }
              : {
                  layer: "L1",
                  rule: "concurrency:per-ip",
                  action: "block",
                  reason,
                },
            dry
              ? undefined
              : { status: 429, code: "rate_limited", retryAfter: 1 },
          );
          trace?.push({
            layer: "L1",
            check: "concurrency",
            rule: "concurrency:per-ip",
            outcome: `${reason}: ${dry ? "would have refused (dry run)" : "refused, 429"}`,
          });
          if (run.refused) return finish();
        } else {
          trace?.push({
            layer: "L1",
            check: "concurrency",
            rule: "concurrency:per-ip",
            outcome: `${held} of ${concurrency.perIp} in flight for this address`,
          });
        }
      }
    }

    // ── L4 bans, L6 shape, L8 deception ───────────────────────────────────
    const pass: Pass = {
      subject,
      route: requestRoute(facts),
      address: resolved.address,
      flags,
      now,
      writes,
      dryPolicy,
      trace,
      run,
      stage,
      crawler,
    };
    if (this.#banned(pass)) return finish();
    if (challengeEntry !== undefined) {
      run.add(entryHit(challengeEntry), {
        status: 403,
        code: challengeEntry.code,
      });
      if (run.refused) return finish();
    }
    return then(this.#shaped(facts, pass), (shapeRefused) => {
      if (shapeRefused) return finish();
      return then(this.#ruled(facts, pass, policy), (ruled) => {
        if (ruled) return finish();
        return then(this.#spoofed(pass), (spoofed) => {
          if (spoofed || this.#signaled(facts, pass, policy)) return finish();
          return this.#afterRules(facts, pass, finish, internals, limitSet);
        });
      });
    });
  }

  /**
   * Layer L10 (layers.md L3.2): a claimant whose verification failed,
   * `crawler.spoofed` — refused by default (`crawlers.spoofed.action`), its
   * offence weight (5) added to the address's score, its event counted.
   * Early stage only. Answers whether the request was refused.
   */
  #spoofed(pass: Pass): MaybePromise<boolean> {
    const claim = pass.crawler;
    if (
      claim === undefined ||
      claim.verdict.status !== "spoofed" ||
      pass.stage === "route" ||
      pass.flags.allowAll ||
      pass.flags.internal
    ) {
      return false;
    }
    const compiled = crawlersOf(this.#policy);
    const dry = pass.dryPolicy || claim.mode === "dryRun";
    const action = compiled.spoofedAction;
    const reason = `crawler.spoofed: claims ${claim.id}, but ${claim.verdict.reason}`;
    const logged = dry || action === "log";
    pass.run.add(
      logged
        ? {
            layer: "L10",
            rule: "crawler.spoofed",
            action: "log",
            ...(dry && action !== "log" ? { wouldHaveBeen: action } : {}),
            reason: dry ? `dry run: ${reason}` : reason,
          }
        : { layer: "L10", rule: "crawler.spoofed", action, reason },
      logged ? undefined : { status: 403, code: "blocked" },
    );
    pass.trace?.push({
      layer: "L10",
      check: "crawler",
      rule: "crawler.spoofed",
      outcome: `${reason}: ${dry ? "would have refused (dry run)" : logged ? "logged" : `refused: ${action}`}`,
    });
    if (dry) return false;
    this.#offend("crawler.spoofed", compiled.spoofedWeight, pass, false);
    return then(
      this.#occur("crawler.spoofed", pass, false),
      () => pass.run.refused,
    );
  }

  /** The intel the request's rules and signals read: without the `hosting` class for a verified crawler (`hostingClass`). */
  #intelFor(pass: Pass): IntelLookup | undefined {
    const intel = this.#options.intel;
    if (intel === undefined || !exempts(pass.crawler, "hostingClass")) {
      return intel;
    }
    return {
      provides: () => intel.provides(),
      lookup: (address) => {
        const record = intel.lookup(address);
        return record.classes.includes("hosting")
          ? {
              ...record,
              classes: record.classes.filter((name) => name !== "hosting"),
            }
          : record;
      },
    };
  }

  /**
   * Layer L10.1: the bot signals the request shows add to its risk, logged
   * as one hit; at the policy's `challengeAt` the hit is a challenge
   * (resolved by `Run.add`). Early stage only: headers are all they read.
   * Answers whether the request was refused.
   */
  #signaled(facts: RequestFacts, pass: Pass, policy: CompiledPolicy): boolean {
    if (pass.stage === "route" || pass.flags.allowAll || pass.flags.internal) {
      return false;
    }
    const compiled = botSignalsOf(policy);
    if (!compiled.enabled) return false;
    // A verified crawler on its allowance adds no signals (layers.md L3.2).
    if (exempts(pass.crawler, "botSignals")) {
      pass.trace?.push({
        layer: "L10",
        check: "signals",
        rule: "botSignals",
        outcome: `not read: a verified ${pass.crawler?.id ?? ""} crawler is exempt`,
      });
      return false;
    }
    const found = readSignals(compiled, facts, this.#intelFor(pass));
    if (found.length === 0) return false;
    const { run, trace } = pass;
    const points = found.reduce((sum, signal) => sum + signal.points, 0);
    run.risk += points;
    const reason = `bot signals: ${found.map((signal) => signal.name).join(", ")} (risk ${points})`;
    const challenge = points >= compiled.challengeAt;
    const dry = challenge && (pass.dryPolicy || compiled.dryRun);
    run.add(
      challenge && !dry
        ? { layer: "L10", rule: "botSignals", action: "challenge", reason }
        : {
            layer: "L10",
            rule: "botSignals",
            action: "log",
            ...(dry ? { wouldHaveBeen: "challenge" as const } : {}),
            reason: dry ? `dry run: ${reason}` : reason,
          },
    );
    trace?.push({
      layer: "L10",
      check: "signals",
      rule: "botSignals",
      outcome: challenge
        ? `${reason}: ${dry ? "would have challenged (dry run)" : "challenged"}`
        : `${reason}: added to the risk`,
    });
    return run.refused;
  }

  /**
   * The layers after L7, split out of {@link #decide} (L8 deception, the
   * `request` occurrence, L9 rate limits): run once the request rules let
   * the request through, on the policy snapshot `#decide` took.
   */
  #afterRules(
    facts: RequestFacts,
    pass: Pass,
    finish: () => { decision: Decision; resolved: ResolvedClient },
    internals: PolicyInternals,
    limitSet: LimitSet,
  ): MaybePromise<{ decision: Decision; resolved: ResolvedClient }> {
    const run = pass.run;
    return then(this.#deceived(facts, pass), (deceived) => {
      if (deceived || run.refused) return finish();
      return then(this.#sensitive(pass), () =>
        run.refused
          ? finish()
          : this.#limitsStage(pass, finish, internals, limitSet),
      );
    });
  }

  /**
   * Layer L11 before the password is checked (layers.md L11.2 to L11.4):
   * on a request of a route marked `login` whose attempted username is
   * known, the soft lock, the challenge, the progressive delay and the
   * `step-up` tag.
   */
  #sensitive(pass: Pass): MaybePromise<void> {
    if (pass.stage === "early" || pass.route.profile !== "login")
      return undefined;
    const login = sensitiveOf(this.#policy).login;
    const username = pass.subject.username;
    if (login === undefined || username === undefined || pass.flags.allowAll) {
      return undefined;
    }
    const dry = pass.dryPolicy || login.mode === "dryRun";
    return then(
      this.#login.check(
        login,
        { username, device: pass.subject.device, ip: pass.subject.ip },
        this.#prefix,
        dry,
        pass.now,
      ),
      (verdict) => {
        for (const { hit, answer } of verdict.hits) pass.run.add(hit, answer);
        for (const tag of verdict.tags) pass.run.tags.add(tag);
        if (verdict.delayMs > pass.run.delayMs)
          pass.run.delayMs = verdict.delayMs;
        pass.trace?.push({
          layer: "L11",
          check: "login",
          outcome:
            verdict.hits.length === 0
              ? `the username's failures are under ${login.delayAfter}${pass.subject.device === undefined ? "" : " (on its device)"}${verdict.tags.length > 0 ? `; tagged ${verdict.tags.join(", ")}` : ""}`
              : verdict.hits
                  .map(({ hit }) => hit.reason ?? hit.rule)
                  .join("; "),
        });
      },
    );
  }

  /** The `request` occurrence and layer L9, once the earlier layers let the request through. */
  #limitsStage(
    pass: Pass,
    finish: () => { decision: Decision; resolved: ResolvedClient },
    internals: PolicyInternals,
    limitSet: LimitSet,
  ): MaybePromise<{ decision: Decision; resolved: ResolvedClient }> {
    const run = pass.run;
    // Without limits, counted rules or a weight on `request`, nothing
    // below applies (plan §4.3).
    if (
      internals.limits.length === 0 &&
      internals.countedRules.length === 0 &&
      (internals.ladder?.weights.get("request") ?? 0) === 0
    ) {
      return finish();
    }
    // ── The `request` occurrence, then L9 rate limits ─────────────────
    return then(this.#occur("request", pass, false), () => {
      if (run.refused) return finish();
      return then(this.#limit(internals.limits, limitSet, pass), (throttled) =>
        throttled
          ? then(this.#occur("throttled", pass, false), finish)
          : finish(),
      );
    });
  }

  /**
   * Layer L9: counts the request against every limit that applies, through
   * the throttle foundation; adds a hit for each that refuses it (or would,
   * in dry run), and for a shared store's failure. Answers whether an
   * enforced limit refused it with a `429` (a `503` of `onStoreError:
   * "closed"` refuses it too, but is not a `throttled` occurrence).
   */
  #limit(
    limits: readonly CompiledLimit[],
    limitSet: LimitSet,
    pass: Pass,
  ): MaybePromise<boolean> {
    const { subject, route, flags, writes, dryPolicy, trace, run } = pass;
    const counting: MaybePromise<[CompiledLimit, LimitCount]>[] = [];
    for (const limit of limits) {
      if (!inStage(limit, pass.stage)) continue;
      const built = limitSet.get(limit.id);
      if (built === undefined) continue;
      const skipped =
        limit.key.addressOnly && exempts(pass.crawler, "perIpLimits")
          ? `a verified ${pass.crawler?.id ?? ""} crawler counts under its own limit`
          : flags.allowAll && !limit.evenWhenAllowed
            ? "an allow entry let the request through"
            : flags.internal && limit.key.addressOnly
              ? "the client is internal and the key names only its address"
              : flags.service?.exempt.has("globalLimits") &&
                  !limit.appliesToServices
                ? `service "${flags.service.id}" is exempt from global limits`
                : undefined;
      if (skipped !== undefined) {
        trace?.push({
          layer: "L9",
          check: "limit",
          rule: `limit:${limit.id}`,
          outcome: `not counted: ${skipped}`,
        });
        continue;
      }
      if (!appliesTo(limit.routes, route) || !inProfile(limit.profile, route)) {
        continue;
      }
      const key = keyOf(limit.key, subject, route);
      // The crawlers' own limit counts verified crawlers only: silent for the rest.
      if (key === undefined && limit.key.parts.includes("crawler")) continue;
      if (key === undefined) {
        trace?.push({
          layer: "L9",
          check: "limit",
          rule: `limit:${limit.id}`,
          outcome: `not counted: the request has no ${limit.key.parts.join("|")} key`,
        });
        continue;
      }
      counting.push(
        then(
          this.#limiter.count(built, limit, key, !writes),
          (value): [CompiledLimit, LimitCount] => [limit, value],
        ),
      );
    }
    return then(all(counting), (results) => {
      let throttled = false;
      for (const [limit, counted] of results) {
        const rule = `limit:${limit.id}`;
        const dry = dryPolicy || limit.mode === "dryRun";
        if (counted.kind === "uncounted") {
          trace?.push({
            layer: "L9",
            check: "limit",
            rule,
            outcome: "not counted: the store failed (fail open)",
          });
          continue;
        }
        if (counted.kind === "failed") {
          const closed = counted.mode === "closed";
          const reason = `the shared store failed: onStoreError ${counted.mode}`;
          run.add(
            dry || !closed
              ? {
                  layer: "L9",
                  rule,
                  action: "log",
                  ...(closed ? { wouldHaveBeen: "block" as const } : {}),
                  reason: dry && closed ? `dry run: ${reason}` : reason,
                }
              : { layer: "L9", rule, action: "block", reason },
            !dry && closed
              ? {
                  status: 503,
                  code: "unavailable",
                  retryAfter: STORE_RETRY_AFTER,
                }
              : undefined,
          );
          trace?.push({
            layer: "L9",
            check: "limit",
            rule,
            outcome: `${reason}: ${closed ? (dry ? "would have refused (dry run)" : "refused, 503") : "let through, not counted"}`,
          });
          continue;
        }
        const { result, via } = counted;
        const quota = via === "local share" ? result.limit : limit.limit;
        const usage = `${result.used} of ${quota} in ${windowText(limit.window)}${via === "local share" ? " (the local share: the shared store failed)" : ""}`;
        if (!result.limited) {
          trace?.push({ layer: "L9", check: "limit", rule, outcome: usage });
          continue;
        }
        const reason = `rate limit: ${quota} per ${windowText(limit.window)}${via === "local share" ? " (local share)" : ""}`;
        run.add(
          dry
            ? {
                layer: "L9",
                rule,
                action: "log",
                wouldHaveBeen: "block",
                reason: `dry run: ${reason}`,
              }
            : { layer: "L9", rule, action: "block", reason },
          dry
            ? undefined
            : {
                status: 429,
                code: limit.code,
                retryAfter: seconds(result.retryAfter),
              },
        );
        if (!dry) throttled = true;
        trace?.push({
          layer: "L9",
          check: "limit",
          rule,
          outcome: `${usage}: ${dry ? "would have refused (dry run)" : "refused, 429"}`,
        });
      }
      return throttled;
    });
  }

  /**
   * The decision from the hits, and, for a tracked request it admits, its
   * in-flight slot.
   */
  #finish(
    run: Run,
    subject: SubjectKeys,
    resolved: ResolvedClient,
    writes: boolean,
    track: boolean,
    flags: Flags,
    now: number,
    stage: EvaluationStage | undefined,
  ): { decision: Decision; resolved: ResolvedClient } {
    const decision = this.#conclude(run, subject);
    if (writes) {
      const concurrency = this.#internals.concurrency;
      let slot: Slot | undefined;
      if (
        track &&
        stage !== "route" &&
        concurrency !== undefined &&
        !refuses(decision.action)
      ) {
        const perIp =
          concurrency.perIp !== undefined &&
          !flags.allowAll &&
          !flags.internal &&
          !flags.service?.exempt.has("globalLimits")
            ? subject.ip
            : undefined;
        slot = this.#inFlight.take(perIp, now, concurrency.releaseAfter);
      }
      this.#contexts.set(decision, { slot, flags, stage });
    }
    return { decision, resolved };
  }

  /** An allow with no hits (a fresh object: `complete()` tells decisions apart). */
  #allow(subject: Decision["subject"]): Decision {
    return { action: "allow", hits: EMPTY, tags: EMPTY, risk: 0, subject };
  }

  /**
   * The decision from the hits: the most severe action, `log` for dry-run
   * hits alone; a refusal answers with its first most severe hit's status,
   * code and `Retry-After`.
   */
  #conclude(run: Run, subject: Decision["subject"]): Decision {
    const claim = run.crawler;
    if (
      claim !== undefined &&
      claim.mode === "dryRun" &&
      claim.covered &&
      claim.verdict.status === "verified" &&
      run.refused
    ) {
      // The allowance in dry run: lifted nothing, but would have let it in.
      run.add({
        layer: "L3",
        rule: `crawler:${claim.id}`,
        action: "log",
        wouldHaveBeen: "allow",
        reason: `dry run: a verified ${claim.id} crawler; its allowance would have let it through`,
      });
    }
    const crawler: DecisionCrawler | undefined =
      claim === undefined
        ? undefined
        : Object.freeze({
            id: claim.id,
            verified: claim.verdict.status === "verified",
            ...(claim.verdict.by === undefined
              ? {}
              : { verifiedBy: claim.verdict.by }),
            spoofed: claim.verdict.status === "spoofed",
          });
    const hits = run.hits;
    if (hits.length === 0 && run.tags.size === 0) {
      return crawler === undefined
        ? this.#allow(subject)
        : { ...this.#allow(subject), crawler };
    }
    let action: SecurityAction = "allow";
    let decider: RuleHit | undefined;
    let risk = 0;
    for (const hit of hits) {
      if (ACTION_SEVERITY[hit.action] > ACTION_SEVERITY[action]) {
        action = hit.action;
        decider = hit;
      }
      if (refuses(hit.action)) risk++;
    }
    risk += run.risk;
    const decision: { -readonly [K in keyof Decision]: Decision[K] } = {
      action,
      hits: Object.freeze(hits),
      tags: run.tags.size === 0 ? EMPTY : Object.freeze([...run.tags]),
      risk,
      subject,
      ...(crawler === undefined ? {} : { crawler }),
    };
    if (action === "delay" && run.delayMs > 0) decision.delayMs = run.delayMs;
    if (action === "block" || action === "challenge" || action === "ban") {
      const answer = decider ? run.answers.get(decider) : undefined;
      decision.status = answer?.status ?? 403;
      decision.code = answer?.code ?? "blocked";
      if (answer?.retryAfter !== undefined) {
        decision.retryAfter = answer.retryAfter;
      }
    }
    return decision;
  }
}

/** The flags later layers read, from the lists' outcome. */
function flagsOf(
  lists: ListOutcome | undefined,
  service: CompiledService | undefined,
): Flags {
  const decided = lists?.decided;
  return {
    allowAll:
      decided !== undefined &&
      decided.action === "allow" &&
      decided.kind !== "internal",
    internal: lists?.internal === true,
    service,
  };
}

/**
 * The path list entries match: the canonical path, folded to lower case
 * unless the policy's shape says the app's routes are case-sensitive (the
 * entries' own `paths` are folded the same way when compiled).
 */
function listPath(path: string, internals: PolicyInternals): string {
  return internals.caseSensitive ? path : path.toLowerCase();
}

/** The store key prefix of a policy: per service, so services sharing a store never count together. */
function prefixOf(policy: CompiledPolicy): string {
  return `bun-security:${policy.service ?? "-"}`;
}

/**
 * Creates the engine from a policy. Throws a `SecurityPolicyError` when the
 * policy is refused, and bun-common's `ConfigError` for a bad option (or a
 * `gcra` limit on a store without `consumeGcra`).
 *
 * @example
 * ```ts
 * const security = createSecurity({
 *   policy: {
 *     service: "checkout",
 *     public: true,
 *     lists: [{ ip: "203.0.113.0/24", action: "block", reason: "scanner" }],
 *     limits: [
 *       { id: "login-account", limit: 10, window: "1m", key: ["ip", "user"], routes: ["POST /login"] },
 *       { id: "login-ip", limit: 30, window: "1m", routes: ["POST /login"] },
 *     ],
 *     countedRules: [
 *       { id: "failed-password", event: "auth.failure", threshold: 10, window: "15m", duration: "1h" },
 *     ],
 *   },
 * });
 * Bun.serve(hardenServe({ fetch: withSecurity(security, app) }));
 * ```
 */
export function createSecurity<TRequest = Request>(
  options: CreateSecurityOptions<TRequest>,
): Security<TRequest> {
  return new SecurityEngine(options);
}
