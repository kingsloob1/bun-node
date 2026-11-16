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
 * 5. **L4** keys tripped by a counted rule (layers.md §0.2; PR-S3 grows
 *    this into bans);
 * 6. the `request` occurrence for counted rules;
 * 7. **L9** rate limits, counted by the throttle foundation, and the
 *    `throttled` occurrence when one refuses;
 *
 * and, after the response, **L14** through `complete()`: the request's slot
 * given back, and `route.notFound` and `server.error` occurrences counted.
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
} from "@kingsleyweb/bun-common";
import type {
  Logger,
  LoggerLike,
  ThrottleHandler,
  ThrottleResult,
  ThrottleStore,
} from "@kingsleyweb/bun-common";
import { normalizeAddress } from "../ip/address";
import { compilePolicy, policyInternals } from "../policy/compile";
import type {
  CompiledCountedRule,
  CompiledEntry,
  CompiledKey,
  CompiledLimit,
  CompiledPolicy,
  CompiledService,
  PolicyInternals,
} from "../policy/compile";
import type { SecurityAction, SecurityPolicy } from "../policy/types";
import { ACTION_SEVERITY, refuses } from "./actions";
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
import { resolveClient } from "./identity";
import type { ResolvedClient } from "./identity";
import { appliesTo, keyOf, requestRoute } from "./keys";
import type { RequestRoute } from "./keys";
import { Limiter } from "./limits";
import type { LimitSet } from "./limits";
import { evaluateLists } from "./lists";
import type { ListOutcome } from "./lists";
import { all, then } from "./maybe";
import type { MaybePromise } from "./maybe";
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
  /** Keys tripped by a counted rule (ended ones may linger until read). */
  readonly trips: number;
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
  /** Stops the engine: later `evaluate()` and `explain()` calls throw. */
  close: () => void;
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
    this.#counted = new CountedState(
      counters,
      maxKeys,
      this.#evictions,
      this.#logger,
    );
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
      this.#decide(facts, this.#now(), true, undefined, options.track === true),
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
      this.#decide(facts, options.now ?? this.#now(), false, steps, true),
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
          facts.path,
          now,
          internals.mode === "dryRun",
        );
    return this.#occurAll(
      [event],
      facts,
      resolved.subject,
      flagsOf(lists, resolved.service),
      now,
    );
  }

  load(policy: SecurityPolicy | CompiledPolicy): CompiledPolicy {
    this.#assertOpen();
    const compiled = compilePolicy(policy);
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
    this.#counted.prune(
      new Set(
        internals.countedRules
          .filter((rule) => rule.mode === "enforce")
          .map((rule) => rule.id),
      ),
    );
    return compiled;
  }

  status(): SecurityStatus {
    const now = this.#now();
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
        trips: this.#counted.trips.size,
        evictions: this.#evictions.total,
        warning: this.#evictions.warning(now),
      }),
    });
  }

  close(): void {
    this.#closed = true;
    this.#inFlight.clear();
    this.#counted.trips.clear();
  }

  /**
   * Counts one occurrence of each of `events` for the counted rules, in
   * order, and answers the hits (trips) they caused.
   */
  #occurAll(
    events: readonly string[],
    facts: RequestFacts,
    subject: SubjectKeys,
    flags: Flags,
    now: number,
  ): MaybePromise<readonly RuleHit[]> {
    const run = new Run();
    const route = requestRoute(facts);
    const dryPolicy = this.#internals.mode === "dryRun";
    // One event after another, so the hits keep the events' order.
    const from = (index: number): MaybePromise<void> => {
      const event = events[index];
      if (event === undefined) return undefined;
      return then(
        this.#occur(
          event,
          subject,
          route,
          flags,
          now,
          true,
          dryPolicy,
          undefined,
          run,
        ),
        () => from(index + 1),
      );
    };
    return then(from(0), () => Object.freeze(run.hits));
  }

  /**
   * Counts one occurrence of `event` under each counted rule that counts
   * it, adding a hit to `run` for each that trips (refusing, or `log` with
   * its would-be action in dry run). With `writes` off it only reads.
   */
  #occur(
    event: string,
    subject: SubjectKeys,
    route: RequestRoute,
    flags: Flags,
    now: number,
    writes: boolean,
    dryPolicy: boolean,
    trace: ExplainStep[] | undefined,
    run: Run,
  ): MaybePromise<void> {
    const rules = this.#internals.countedByEvent.get(event);
    if (rules === undefined) return undefined;
    const prefix = this.#prefix;
    const counting: MaybePromise<
      readonly [CompiledCountedRule, RuleHit | undefined]
    >[] = [];
    for (const rule of rules) {
      const key = this.#countedKey(rule, subject, route, flags, trace, event);
      if (key === undefined) continue;
      counting.push(
        then(
          this.#counted.count(prefix, rule, key, writes, now),
          (outcome): readonly [CompiledCountedRule, RuleHit | undefined] => [
            rule,
            this.#tripped(
              rule,
              key,
              event,
              outcome,
              now,
              writes,
              dryPolicy,
              trace,
            ),
          ],
        ),
      );
    }
    return then(all(counting), (results) => {
      for (const [rule, hit] of results) {
        if (hit === undefined) continue;
        run.add(
          hit,
          refuses(hit.action)
            ? {
                status: 403,
                code: rule.code,
                ...(Number.isFinite(rule.duration)
                  ? { retryAfter: seconds(rule.duration) }
                  : {}),
              }
            : undefined,
        );
      }
    });
  }

  /**
   * The hit for one counted occurrence: none below the threshold; at it, the
   * rule's action (recorded as a trip when enforced and writing), or `log`
   * with the would-be action in dry run.
   */
  #tripped(
    rule: CompiledCountedRule,
    key: string,
    event: string,
    outcome: CountOutcome,
    now: number,
    writes: boolean,
    dryPolicy: boolean,
    trace: ExplainStep[] | undefined,
  ): RuleHit | undefined {
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
      return undefined;
    }
    const dry = dryPolicy || rule.mode === "dryRun";
    const action = tripAction(rule);
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
      this.#counted.trip(rule, key, now);
      this.#logger.info(
        `bun-security: counted rule "${rule.id}" tripped on "${event}"`,
        {
          rule: rule.id,
          event,
          durationMs: Number.isFinite(rule.duration) ? rule.duration : null,
        },
      );
    }
    trace?.push({
      layer: "L4",
      check: "counted-rule",
      rule: hit.rule,
      outcome: `"${event}" reached ${rule.threshold} in ${windowText(rule.window)}: ${dry ? `would have tripped (dry run) to ${action}` : `tripped: ${action}`}`,
    });
    return hit;
  }

  /** The key a counted rule counts the request under, or `undefined` when it does not apply. */
  #countedKey(
    rule: CompiledCountedRule,
    subject: SubjectKeys,
    route: RequestRoute,
    flags: Flags,
    trace: ExplainStep[] | undefined,
    event: string,
  ): string | undefined {
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
    if (!appliesTo(rule.routes, route)) return undefined;
    const key = keyOf(rule.key, subject, route);
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
   * The one decision function: `writes` updates state (evaluate), `trace`
   * collects steps (explain), `track` applies layer L1. Every stage reads
   * the same policy snapshot.
   */
  #decide(
    facts: RequestFacts,
    now: number,
    writes: boolean,
    trace: ExplainStep[] | undefined,
    track: boolean,
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
    if (resolved.hit) run.add(resolved.hit);
    const subject = resolved.subject;
    const concurrency = track ? internals.concurrency : undefined;
    let flags: Flags = {
      allowAll: false,
      internal: false,
      service: resolved.service,
    };
    const finish = (): { decision: Decision; resolved: ResolvedClient } =>
      this.#finish(run, subject, resolved, writes, track, flags, now);

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
        facts.path,
        now,
        dryPolicy,
        trace,
      );
      if (lists.decided) {
        run.add(entryHit(lists.decided), {
          status: 403,
          code: lists.decided.code,
        });
      }
      if (lists.wouldBe) {
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
    if (writes && internals.trustCheck && !resolved.service) {
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

    // Without limits or counted rules, nothing below applies (plan §4.3:
    // facts computed only when a rule needs them).
    if (internals.limits.length === 0 && internals.countedRules.length === 0) {
      return finish();
    }

    // ── L4: keys a counted rule tripped ───────────────────────────────────
    const route = requestRoute(facts);
    if (this.#counted.trips.size > 0) {
      const bansExempt = flags.service?.exempt.has("bans") === true;
      for (const rule of internals.countedRules) {
        if (shieldedBy(flags, rule.key)) continue;
        if (bansExempt && !rule.appliesToServices) continue;
        const key = keyOf(rule.key, subject, route);
        if (key === undefined) continue;
        const trip = this.#counted.tripOf(rule, key, now, writes);
        if (trip === undefined) continue;
        const dry = dryPolicy || rule.mode === "dryRun";
        const action = tripAction(rule);
        const left = trip.until - now;
        const reason = `tripped by counted rule "${rule.id}"${Number.isFinite(left) ? `, ${seconds(left)} s left` : ", until the rule is removed"}`;
        run.add(
          dry
            ? {
                layer: "L4",
                rule: `counted:${rule.id}`,
                action: "log",
                wouldHaveBeen: action,
                reason: `dry run: ${reason}`,
              }
            : { layer: "L4", rule: `counted:${rule.id}`, action, reason },
          dry
            ? undefined
            : {
                status: 403,
                code: rule.code,
                ...(Number.isFinite(left) ? { retryAfter: seconds(left) } : {}),
              },
        );
        trace?.push({
          layer: "L4",
          check: "trip",
          rule: `counted:${rule.id}`,
          outcome: `${reason}: ${dry ? "would have refused (dry run)" : `refused: ${action}`}`,
        });
        if (run.refused) return finish();
      }
    }

    // ── The `request` occurrence, then L9 rate limits ─────────────────────
    return then(
      this.#occur(
        "request",
        subject,
        route,
        flags,
        now,
        writes,
        dryPolicy,
        trace,
        run,
      ),
      () => {
        if (run.refused) return finish();
        return then(
          this.#limit(
            internals.limits,
            limitSet,
            subject,
            route,
            flags,
            writes,
            dryPolicy,
            trace,
            run,
          ),
          (throttled) =>
            throttled
              ? then(
                  this.#occur(
                    "throttled",
                    subject,
                    route,
                    flags,
                    now,
                    writes,
                    dryPolicy,
                    trace,
                    run,
                  ),
                  finish,
                )
              : finish(),
        );
      },
    );
  }

  /**
   * Layer L9: counts the request against every limit that applies, through
   * the throttle foundation; adds a hit for each that refuses it (or would,
   * in dry run). Answers whether an enforced limit refused it.
   */
  #limit(
    limits: readonly CompiledLimit[],
    limitSet: LimitSet,
    subject: SubjectKeys,
    route: RequestRoute,
    flags: Flags,
    writes: boolean,
    dryPolicy: boolean,
    trace: ExplainStep[] | undefined,
    run: Run,
  ): MaybePromise<boolean> {
    const counting: MaybePromise<
      [CompiledLimit, ThrottleResult | undefined]
    >[] = [];
    for (const limit of limits) {
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
  ): { decision: Decision; resolved: ResolvedClient } {
    const decision = this.#conclude(run, subject);
    if (writes) {
      const concurrency = this.#internals.concurrency;
      let slot: Slot | undefined;
      if (track && concurrency !== undefined && !refuses(decision.action)) {
        const perIp =
          concurrency.perIp !== undefined &&
          !flags.allowAll &&
          !flags.internal &&
          !flags.service?.exempt.has("globalLimits")
            ? subject.ip
            : undefined;
        slot = this.#inFlight.take(perIp, now, concurrency.releaseAfter);
      }
      this.#contexts.set(decision, { slot, flags });
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
