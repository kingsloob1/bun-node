/**
 * `createSecurity`: the engine (plan §4). It decides each request locally
 * from its facts, the compiled policy and its own memory state, in stages:
 *
 * - **pre-routing**: L2 client identity (the trusted-proxy foundation's
 *   address, normalised; service identity; the trust check's gauges), then
 *   L3 lists (the CIDR trie, the `internal` list, users and API keys);
 * - **route** and **response** stages hold the later layers (limits,
 *   profiles, headers, outcomes) as they land.
 *
 * A stage that refuses the request ends it; every hit is recorded. When
 * every rule in play is local — all of them, today — `evaluate()` answers
 * synchronously. `explain()` is the same function with state writes off and
 * a trace on.
 */
import { createLogger, resolveLogger } from "@kingsleyweb/bun-common";
import type { Logger, LoggerLike } from "@kingsleyweb/bun-common";
import { normalizeAddress } from "../ip/address";
import { compilePolicy, policyInternals } from "../policy/compile";
import type {
  CompiledEntry,
  CompiledPolicy,
  PolicyInternals,
} from "../policy/compile";
import type { SecurityAction, SecurityPolicy } from "../policy/types";
import { ACTION_SEVERITY } from "./actions";
import type {
  ClientResolution,
  Decision,
  Explanation,
  ExplainStep,
  RuleHit,
} from "./decision";
import type { RequestFacts, SecurityIdentity } from "./facts";
import { resolveClient } from "./identity";
import type { ResolvedClient } from "./identity";
import { evaluateLists } from "./lists";
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
  /** Called with each warning as it is raised (the trust check's, layers.md L2.5). */
  readonly onWarning?: (warning: SecurityWarning) => void;
  /**
   * Where warnings and errors are logged: any logger bun-common's
   * `resolveLogger` accepts. Default: a console logger named `bun-security`.
   */
  readonly logger?: LoggerLike;
  /** The clock, epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
}

/** Options for {@link Security.explain}. */
export interface ExplainOptions {
  /** The time to evaluate at, epoch milliseconds (list expiries). Default now. */
  readonly now?: number;
}

/** What {@link Security.status} reports. */
export interface SecurityStatus {
  /** The policy in force. */
  readonly policy: CompiledPolicy;
  /** The trust check's gauges and warnings. */
  readonly trust: TrustStatus;
}

/** The engine `createSecurity()` returns. */
export interface Security<TRequest = Request> {
  /** The policy in force. */
  readonly policy: CompiledPolicy;
  /** Whether {@link close} was called. */
  readonly closed: boolean;
  /**
   * Decides one request. Synchronous while every rule in play is local;
   * the type allows a promise for the store-backed rules to come.
   */
  evaluate: (facts: RequestFacts) => Decision | Promise<Decision>;
  /**
   * What {@link evaluate} would decide for these facts, and why, with no
   * state written. `explain(f).decision` equals `evaluate(f)` at the same
   * time.
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
   * Replaces the policy: compiled first, swapped in at once, so a request
   * is decided wholly by the old policy or wholly by the new. Throws a
   * `SecurityPolicyError` and keeps the old policy when the new one is
   * refused.
   */
  load: (policy: SecurityPolicy | CompiledPolicy) => CompiledPolicy;
  /** The policy in force and the trust check's gauges. */
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

/** The engine. */
class SecurityEngine<TRequest> implements Security<TRequest> {
  /** The policy in force. */
  #policy: CompiledPolicy;
  /** Its compiled internals. */
  #internals: PolicyInternals;
  /** The trust check. */
  readonly #trust: TrustMonitor;
  /** The logger. */
  readonly #logger: Logger;
  /** The clock. */
  readonly #now: () => number;
  /** The options. */
  readonly #options: CreateSecurityOptions<TRequest>;
  /** Whether closed. */
  #closed = false;
  /** When a hook error was last logged. */
  #lastHookError = Number.NEGATIVE_INFINITY;

  constructor(options: CreateSecurityOptions<TRequest>) {
    this.#options = options;
    this.#policy = compilePolicy(options.policy);
    this.#internals = policyInternals(this.#policy);
    this.#logger = resolveLogger(
      options.logger,
      createLogger({ name: "bun-security" }),
    );
    this.#now = options.now ?? Date.now;
    this.#trust = new TrustMonitor((warning) => this.#warn(warning));
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

  evaluate(facts: RequestFacts): Decision {
    this.#assertOpen();
    const { decision } = this.#decide(facts, this.#now(), true, undefined);
    if (this.#options.onDecision) {
      try {
        this.#options.onDecision(decision, facts);
      } catch (error) {
        this.#hookError("onDecision", error);
      }
    }
    return decision;
  }

  explain(facts: RequestFacts, options: ExplainOptions = {}): Explanation {
    this.#assertOpen();
    const steps: ExplainStep[] = [];
    const { decision, resolved } = this.#decide(
      facts,
      options.now ?? this.#now(),
      false,
      steps,
    );
    const client: ClientResolution = {
      ...(resolved.address
        ? { address: resolved.address.text, key: resolved.subject.ip }
        : {}),
      source: resolved.source,
      chain: facts.chain,
      ...(resolved.service ? { service: resolved.service.id } : {}),
    };
    return Object.freeze({ decision, client, steps: Object.freeze(steps) });
  }

  load(policy: SecurityPolicy | CompiledPolicy): CompiledPolicy {
    this.#assertOpen();
    const compiled = compilePolicy(policy);
    const internals = policyInternals(compiled);
    // One assignment each, no await between: a request sees one policy.
    this.#policy = compiled;
    this.#internals = internals;
    return compiled;
  }

  status(): SecurityStatus {
    return Object.freeze({
      policy: this.#policy,
      trust: this.#trust.status(
        this.#now(),
        this.#internals.trustCheck,
        this.#policy.public,
        this.#policy.service,
      ),
    });
  }

  close(): void {
    this.#closed = true;
  }

  /**
   * The one decision function: `writes` updates state (evaluate), `trace`
   * collects steps (explain). Every stage reads the same policy snapshot.
   */
  #decide(
    facts: RequestFacts,
    now: number,
    writes: boolean,
    trace: ExplainStep[] | undefined,
  ): { decision: Decision; resolved: ResolvedClient } {
    const policy = this.#policy;
    const internals = this.#internals;

    // ── Pre-routing stage ────────────────────────────────────────────────
    // L2: who the client is.
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
    const hits: RuleHit[] = [];
    if (resolved.hit) hits.push(resolved.hit);

    // L3: lists, unless a verified service is exempt from them.
    let internal = false;
    let code: string | undefined;
    if (resolved.service?.exempt.has("lists")) {
      trace?.push({
        layer: "L3",
        check: "list",
        outcome: `skipped: service "${resolved.service.id}" is exempt from lists`,
      });
    } else {
      const lists = evaluateLists(
        internals,
        resolved.address,
        resolved.subject.user,
        resolved.subject.apiKey,
        facts.path,
        now,
        dryPolicy,
        trace,
      );
      internal = lists.internal;
      if (lists.decided) {
        hits.push(entryHit(lists.decided));
        code = lists.decided.code;
      }
      if (lists.wouldBe) {
        hits.push({
          layer: "L3",
          rule: lists.wouldBe.id,
          action: "log",
          wouldHaveBeen: appliedAction(lists.wouldBe),
          reason: "dry run",
        });
      }
    }

    // L2.5: the trust check's gauges (state: evaluate only).
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
          internal,
          unreadForwarding: forwarded && facts.chain.length <= 1,
        },
        now,
        internals.trustCheck,
        policy.public,
        policy.service,
      );
    }

    // ── Route and response stages: the later layers, as they land. ──────

    return { decision: this.#conclude(hits, resolved.subject, code), resolved };
  }

  /** An allow with no hits. */
  #allow(subject: Decision["subject"]): Decision {
    return { action: "allow", hits: EMPTY, tags: EMPTY, risk: 0, subject };
  }

  /**
   * The decision from the hits: the most severe enforced action, or `log`
   * for dry-run hits alone; a refusal answers 403 with `code`.
   */
  #conclude(
    hits: RuleHit[],
    subject: Decision["subject"],
    code: string | undefined,
  ): Decision {
    if (hits.length === 0) {
      return this.#allow(subject);
    }
    let action: SecurityAction = "allow";
    let risk = 0;
    for (const hit of hits) {
      if (ACTION_SEVERITY[hit.action] > ACTION_SEVERITY[action]) {
        action = hit.action;
      }
      if (ACTION_SEVERITY[hit.action] >= ACTION_SEVERITY.challenge) risk++;
    }
    const decision: { -readonly [K in keyof Decision]: Decision[K] } = {
      action,
      hits: Object.freeze(hits),
      tags: EMPTY,
      risk,
      subject,
    };
    if (action === "block" || action === "challenge" || action === "ban") {
      decision.status = 403;
      decision.code = code ?? "blocked";
    }
    return decision;
  }
}

/**
 * Creates the engine from a policy. Throws a `SecurityPolicyError` when the
 * policy is refused.
 *
 * @example
 * ```ts
 * const security = createSecurity({
 *   policy: {
 *     service: "checkout",
 *     public: true,
 *     lists: [{ ip: "203.0.113.0/24", action: "block", reason: "scanner" }],
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
