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
  ThrottleHandler,
  ThrottleResult,
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
import { InFlight } from "./concurrency";
import type { Slot } from "./concurrency";
import { CountedState } from "./counted";
import type { CountOutcome } from "./counted";
import type {
  ClientResolution,
  Decision,
  Explanation,
  ExplainStep,
  RuleHit,
  SubjectKeys,
} from "./decision";
import type { RequestFacts, SecurityIdentity } from "./facts";
import { boundKey, resolveClient } from "./identity";
import type { ResolvedClient } from "./identity";
import { appliesTo, keyOf, requestRoute } from "./keys";
import type { RequestRoute } from "./keys";
import { Limiter } from "./limits";
import type { LimitSet } from "./limits";
import { evaluateLists } from "./lists";
import type { ListOutcome } from "./lists";
import { all, then } from "./maybe";
import type { MaybePromise } from "./maybe";
import { Scores } from "./scores";
import { checkShape } from "./shape";
import { inStage, keyStage } from "./stages";
import type { EvaluationStage } from "./stages";
import { DEFAULT_MAX_KEYS, EvictionMonitor } from "./state";
import { TrustMonitor } from "./trust";
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
  ) => readonly RuleHit[] | Promise<readonly RuleHit[]>;
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
  /** Stops the engine: later `evaluate()` and `explain()` calls throw. */
  close: () => void;
}

/** What {@link Security.ban} takes: exactly one subject. */
export interface BanInput {
  /** An address (banned by its key: IPv4 as itself, IPv6 by `keys.ipv6Prefix`) or a CIDR range. */
  readonly ip?: string;
  /** A user id, as `identify()` returns it. */
  readonly user?: string;
  /** An API key id, as `identify()` returns it. */
  readonly apiKey?: string;
  /** `ban` (the default) or `challenge` (a `block` until challenge providers exist). */
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

/** The hits of one decision, as they accumulate. */
class Run {
  /** Every hit, in order. */
  readonly hits: RuleHit[] = [];
  /** How each refusing hit answers. */
  readonly answers = new Map<RuleHit, Answer>();
  /** Whether an enforced hit refused the request. */
  refused = false;

  /** Records a hit, and how it answers when it refuses. */
  add(hit: RuleHit, answer?: Answer): void {
    this.hits.push(hit);
    if (answer !== undefined) this.answers.set(hit, answer);
    if (refuses(hit.action)) this.refused = true;
  }
}

/** The L3 hit for a decided entry. */
function entryHit(entry: CompiledEntry): RuleHit {
  if (entry.action === "challenge") {
    return {
      layer: "L3",
      rule: entry.id,
      action: "block",
      reason: "challenge: no challenge provider configured, fell back to block",
    };
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

/** The action an entry takes once applied: `challenge` falls back to `block` until providers exist. */
function appliedAction(entry: CompiledEntry): SecurityAction {
  return entry.action === "challenge" ? "block" : entry.action;
}

/** The action a tripped counted rule takes: `challenge` falls back to `block` until providers exist. */
function tripAction(rule: CompiledCountedRule): SecurityAction {
  return rule.action === "challenge" ? "block" : "ban";
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
  /** Counted-rule counters and trips. */
  readonly #counted: CountedState;
  /** In-flight slots. */
  readonly #inFlight: InFlight;
  /** Bans in force. */
  readonly #bans: BanTable;
  /** Offence scores and ban history. */
  readonly #scores: Scores;
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
    this.#policy = compilePolicy(options.policy);
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
    const counters = store ?? memoryThrottleStore({ maxKeys, now: this.#now });
    this.#limiter = new Limiter(counters, this.#now, this.#logger);
    this.#counted = new CountedState(counters, this.#logger);
    this.#bans = new BanTable(() => this.#internals.bans.maxActive);
    this.#scores = new Scores(maxKeys, this.#evictions);
    this.#inFlight = new InFlight(maxKeys, this.#evictions);
    this.#prefix = prefixOf(this.#policy);
    const prepared = this.#limiter.prepare(
      this.#internals.limits,
      this.#prefix,
    );
    prepared.commit();
    this.#limits = prepared.set;
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
    if (outcome.routeNotFound === true) events.push("route.notFound");
    if (outcome.status >= 500) events.push("server.error");
    if (events.length === 0) return EMPTY;
    return this.#occurAll(
      events,
      facts,
      decision.subject,
      context.flags,
      this.#now(),
      context.stage,
    );
  }

  signal(
    facts: RequestFacts,
    event: string,
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
        );
    return this.#occurAll(
      [event],
      facts,
      resolved.subject,
      flagsOf(lists, resolved.service),
      now,
      undefined,
    );
  }

  load(policy: SecurityPolicy | CompiledPolicy): CompiledPolicy {
    this.#assertOpen();
    const compiled = compilePolicy(policy);
    requestRulesOf(compiled);
    const internals = policyInternals(compiled);
    const prefix = prefixOf(compiled);
    // Built first: a refused throttle leaves the old policy in force.
    const prepared = this.#limiter.prepare(internals.limits, prefix);
    prepared.commit();
    // One assignment each, no await between: a request sees one policy.
    this.#policy = compiled;
    this.#internals = internals;
    this.#limits = prepared.set;
    this.#prefix = prefix;
    // A counted rule removed or turned off lifts the bans it wrote.
    const kept = new Set(
      internals.countedRules
        .filter((rule) => rule.mode === "enforce")
        .map((rule) => `counted:${rule.id}`),
    );
    this.#bans.prune((rule) => !rule.startsWith("counted:") || kept.has(rule));
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
            { method: "", path: "", routePath: undefined, key: "" },
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
      },
      now,
    );
    if (outcome.ban === undefined) {
      throw new Error("bun-security: ban(): the ban was not written");
    }
    return outcome.ban;
  }

  unban(id: string, options: UnbanOptions = {}): Ban | undefined {
    this.#assertOpen();
    const lifted = this.#bans.lift(id, options.by, this.#now());
    if (lifted?.source === "auto" && lifted.subject.type === "ip") {
      this.#scores.reset(lifted.subject.value);
    }
    return lifted;
  }

  bans(): readonly Ban[] {
    return Object.freeze(this.#bans.list(this.#now()));
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
      }),
    });
  }

  close(): void {
    this.#closed = true;
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
      run: new Run(),
      stage,
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
          this.#counted.count(prefix, rule, key, pass.writes, pass.now),
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
    const outcome = this.#bans.add(write, now);
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
            : `"${event}" counted: ${outcome.count} of ${rule.threshold} in ${windowText(rule.window)}`,
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
        ? this.#scores.escalate(banId(subject), now, ladder, writes && !dry)
        : rule.duration;
    const until = Number.isFinite(length) ? now + length : null;
    const reason = `counted rule: ${rule.threshold} "${event}" in ${windowText(rule.window)}${rule.action === "challenge" ? "; challenge: no challenge provider configured, fell back to block" : ""}`;
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
      flags.service?.exempt.has("bans") === true
    ) {
      return;
    }
    let score: number;
    if (writes) {
      score = this.#scores.add(ip, weight, now, ladder);
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
      this.#scores.escalate(banId(subject), now, ladder, writes && !dry);
    const action: SecurityAction = step.action === "ban" ? "ban" : "block";
    const reason = `ladder: score ${score.toFixed(2)} reached ${step.score} (${source})${step.action === "challenge" ? "; challenge: no challenge provider configured, fell back to block" : ""}`;
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
      if (writes && !dry) this.#scores.reset(ip);
      else pass.score = 0;
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
    if (!appliesTo(rule.routes, pass.route)) return undefined;
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
    const action: SecurityAction = ban.action === "ban" ? "ban" : "block";
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
  #verifiedCrawler(_facts: RequestFacts, _pass: Pass): boolean {
    return false;
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
    const matched = matchRequestRules(compiled, facts, pass.stage);
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
      const action: SecurityAction =
        rule.action === "challenge" ? "block" : rule.action;
      const reason = `${what} matched${rule.action === "challenge" ? "; challenge: no challenge provider configured, fell back to block" : ""}`;
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
    const policy = this.#policy;
    const internals = this.#internals;
    const limitSet = this.#limits;

    // ── L2: who the client is ─────────────────────────────────────────────
    const resolved = resolveClient(facts, internals, trace);
    if (internals.mode === "off") {
      trace?.push({
        layer: "L2",
        check: "policy",
        outcome: "the policy is off: allowed",
      });
      return { decision: this.#allow(resolved.subject), resolved };
    }
    const dryPolicy = internals.mode === "dryRun";
    const run = new Run();
    // The route stage repeats L2 and the lists for their flags and the
    // caller's own entries; the early stage recorded the address's hits.
    const routeStage = stage === "route";
    if (resolved.hit && !routeStage) run.add(resolved.hit);
    const subject = resolved.subject;
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
      );
      if (lists.decided && ownEntry(lists.decided, stage)) {
        run.add(entryHit(lists.decided), {
          status: 403,
          code: lists.decided.code,
        });
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
    };
    if (this.#banned(pass)) return finish();
    return then(this.#shaped(facts, pass), (shapeRefused) => {
      if (shapeRefused) return finish();
      return then(this.#ruled(facts, pass, policy), (ruled) => {
        if (ruled) return finish();
        return this.#afterRules(facts, pass, finish, internals, limitSet);
      });
    });
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
        return then(
          this.#limit(internals.limits, limitSet, pass),
          (throttled) =>
            throttled
              ? then(this.#occur("throttled", pass, false), finish)
              : finish(),
        );
      });
    });
  }

  /**
   * Layer L9: counts the request against every limit that applies, through
   * the throttle foundation; adds a hit for each that refuses it (or would,
   * in dry run). Answers whether an enforced limit refused it.
   */
  #limit(
    limits: readonly CompiledLimit[],
    limitSet: LimitSet,
    pass: Pass,
  ): MaybePromise<boolean> {
    const { subject, route, flags, writes, dryPolicy, trace, run } = pass;
    const counting: MaybePromise<
      [CompiledLimit, ThrottleResult | undefined]
    >[] = [];
    for (const limit of limits) {
      if (!inStage(limit, pass.stage)) continue;
      const handler: ThrottleHandler | undefined = limitSet.get(limit.id);
      if (handler === undefined) continue;
      const skipped =
        flags.allowAll && !limit.evenWhenAllowed
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
      if (!appliesTo(limit.routes, route)) continue;
      const key = keyOf(limit.key, subject, route);
      if (key === undefined) {
        trace?.push({
          layer: "L9",
          check: "limit",
          rule: `limit:${limit.id}`,
          outcome: `not counted: the request has no ${limit.key.parts.join("|")} key`,
        });
        continue;
      }
      let result: MaybePromise<ThrottleResult | undefined>;
      try {
        result = this.#limiter.count(handler, key, !writes);
      } catch {
        result = undefined;
      }
      counting.push(
        then(result, (value): [CompiledLimit, ThrottleResult | undefined] => [
          limit,
          value,
        ]),
      );
    }
    const settled = all(counting);
    const read = (
      results: [CompiledLimit, ThrottleResult | undefined][],
    ): boolean => {
      let throttled = false;
      for (const [limit, result] of results) {
        const rule = `limit:${limit.id}`;
        if (result === undefined) {
          trace?.push({
            layer: "L9",
            check: "limit",
            rule,
            outcome: "not counted: the store failed (fail open)",
          });
          continue;
        }
        const usage = `${result.used} of ${limit.limit} in ${windowText(limit.window)}`;
        if (!result.limited) {
          trace?.push({ layer: "L9", check: "limit", rule, outcome: usage });
          continue;
        }
        const dry = dryPolicy || limit.mode === "dryRun";
        const reason = `rate limit: ${limit.limit} per ${windowText(limit.window)}`;
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
    };
    return settled instanceof Promise
      ? settled.then(read, () => {
          // A failing peek (explain): the limits are not known.
          trace?.push({
            layer: "L9",
            check: "limit",
            outcome: "the store failed: the limits could not be read",
          });
          return false;
        })
      : read(settled);
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
    const hits = run.hits;
    if (hits.length === 0) {
      return this.#allow(subject);
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
    const decision: { -readonly [K in keyof Decision]: Decision[K] } = {
      action,
      hits: Object.freeze(hits),
      tags: EMPTY,
      risk,
      subject,
    };
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
